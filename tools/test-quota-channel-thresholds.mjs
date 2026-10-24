/**
 * [2026-10-23] 按渠道/按窗口的两档阈值：**纯函数**语义（真实生产代码）。
 *
 * 覆盖父 Agent 裁决的每一条硬要求：
 *   - legacy（旧全局阈值）保持「最短窗口」行为，per-channel 才按各窗口独立；
 *   - 阈值 JSON 的 four-state 语义：缺字段/null/坏 JSON/空对象/渠道条目/显式 0；
 *   - 编辑 A 不得关掉 B 的 legacy；
 *   - 窗口身份稳定（词表 key，不看数组顺序、不看展示文案）；
 *   - 多窗口取最严重、不平均不求和；
 *   - 金额必须同币种、积分不与金额混比；
 *   - 原型污染与容量上限；
 *   - `describeWindowCapability`：失败 ≠ 没有窗口，身份变了不回窗口。
 *
 * 用法：node tools/test-quota-channel-thresholds.mjs
 */
import assert from 'node:assert/strict'
import {
  WINDOW_KEYS,
  MAX_THRESHOLD_CHANNELS,
  MAX_THRESHOLD_JSON_LENGTH,
  parseChannelThresholds,
  resolveChannelThresholds,
  resolvedActive,
  evaluateChannelMetrics,
  describeWindowCapability,
  windowKeyOf,
} from '../plans/quota-thresholds.js'
import { thresholdsOf, buildQuotaView, stageForChannel } from '../plans/quota-view.js'
import { pickSmallestWindow, renderQuotaPrompt } from '../plans/quota-prompt.js'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) }
  else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600))) }
}

const LEGACY = thresholdsOf({
  quotaWarningPercentThreshold: 40,
  quotaClosingPercentThreshold: 20,
  quotaWarningBalanceThreshold: 10,
  quotaClosingBalanceThreshold: 5,
  quotaBalanceCurrency: 'CNY',
  quotaWarningCreditsThreshold: 1000,
  quotaClosingCreditsThreshold: 500,
})
const LEGACY_OFF = thresholdsOf({})

const ch = (windows, extra) => Object.assign({ availability: 'ok', windows }, extra || {})
const fiveHour = { scope: 'rolling-5h', percent: 30 }
const weeklyLow = { scope: 'weekly', percent: 3 }
const weeklyMid = { scope: 'weekly', percent: 15 }

// ===========================================================================
// T1 — 解析四态（缺字段 / null / 坏 JSON / 空对象）
// ===========================================================================
{
  check('T1a 词表只有三个稳定 key', WINDOW_KEYS.join(',') === 'rolling-5h,weekly,monthly', WINDOW_KEYS)
  check('T1b 条目上限与 focus(8) 分开，至少容纳 17 个渠道', MAX_THRESHOLD_CHANNELS >= 17, MAX_THRESHOLD_CHANNELS)
  check('T1c 字符预算仍是 8192', MAX_THRESHOLD_JSON_LENGTH === 8192, MAX_THRESHOLD_JSON_LENGTH)

  check('T1d 缺字段 → absent', parseChannelThresholds(undefined).state === 'absent')
  check('T1e 空串 → absent', parseChannelThresholds('').state === 'absent')
  check('T1f 仅空白 → absent', parseChannelThresholds('   ').state === 'absent')
  // ⚠️ 父裁决：null **不是** absent，而是坏类型 → 整体 fail closed
  check('T1g null → invalid（不能当 absent）', parseChannelThresholds(null).state === 'invalid')
  check('T1h 数字 → invalid', parseChannelThresholds(42).state === 'invalid')
  check('T1i 坏 JSON → invalid', parseChannelThresholds('{').state === 'invalid')
  check('T1j 数组 → invalid', parseChannelThresholds('[]').state === 'invalid')
  check('T1k JSON null → invalid', parseChannelThresholds('null').state === 'invalid')
  check('T1l 合法空对象 → ok 且无渠道', (() => {
    const p = parseChannelThresholds('{}')
    return p.state === 'ok' && Object.keys(p.channels).length === 0
  })())
  check('T1m 超长输入 → invalid（不截断后继续用）',
    parseChannelThresholds(JSON.stringify({ a: 'x'.repeat(MAX_THRESHOLD_JSON_LENGTH) })).state === 'invalid')
  check('T1n 渠道条目过多 → invalid', (() => {
    const many = {}
    for (let i = 0; i < MAX_THRESHOLD_CHANNELS + 1; i++) many['c' + i] = {}
    return parseChannelThresholds(JSON.stringify(many)).state === 'invalid'
  })())
  // [审查 P07] 危险键任意层级都 → 整份 invalid（不能"跳过"后降级成 legacy）
  check('T1o 根级 constructor → invalid', parseChannelThresholds('{"constructor":{}}').state === 'invalid')
  check('T1p 根级 __proto__ → invalid', parseChannelThresholds('{"__proto__":{"polluted":true}}').state === 'invalid')
  check('T1q 嵌套危险键 → invalid',
    parseChannelThresholds('{"codex":{"windows":{"__proto__":{"warning":5}}}}').state === 'invalid')
  check('T1r 非渠道形态的键 → invalid（不接受任意键）',
    parseChannelThresholds('{"bad key":{}}').state === 'invalid')
}

// ===========================================================================
// T2 — 每个渠道的 legacy 回退语义（编辑 A 不伤 B）
// ===========================================================================
{
  const raw = JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } })
  const parsed = parseChannelThresholds(raw)
  const a = resolveChannelThresholds(parsed, 'codex', LEGACY)
  const b = resolveChannelThresholds(parsed, 'opencode-go', LEGACY)
  check('T2a 有自己条目 → channel 权威', a.source === 'channel' && a.legacy === false, a.source)
  check('T2b 没有条目的渠道仍走 legacy（编辑 A 不关 B）', b.source === 'legacy' && b.legacy === true, b.source)
  check('T2c 缺字段时全部走 legacy',
    resolveChannelThresholds(parseChannelThresholds(''), 'codex', LEGACY).legacy === true)
  check('T2d 合法 {} 时全部走 legacy',
    resolveChannelThresholds(parseChannelThresholds('{}'), 'codex', LEGACY).legacy === true)
  check('T2e 整体坏 JSON → 全部 fail closed',
    resolveChannelThresholds(parseChannelThresholds('{oops'), 'codex', LEGACY).source === 'blocked')
  check('T2f null → 全部 fail closed',
    resolveChannelThresholds(parseChannelThresholds(null), 'codex', LEGACY).source === 'blocked')

  // 显式全 0 / 空条目：覆盖为零，**不**回头借 global
  const zeroed = parseChannelThresholds(JSON.stringify({ codex: { windows: { weekly: { warning: 0, closing: 0 } } } }))
  const zeroResolved = resolveChannelThresholds(zeroed, 'codex', LEGACY)
  check('T2g 显式 0 不激活阈值', resolvedActive(zeroResolved) === false, zeroResolved)
  check('T2h 显式 0 不退回 legacy 触发',
    evaluateChannelMetrics(ch('weekly 3% 也不触发'), {}) .stage !== undefined
    && evaluateChannelMetrics(ch([weeklyLow]), zeroResolved).stage === 'normal')

  const emptyEntry = parseChannelThresholds(JSON.stringify({ codex: {} }))
  check('T2i 空条目 = 覆盖为零（不借 global）',
    resolvedActive(resolveChannelThresholds(emptyEntry, 'codex', LEGACY)) === false)

  // 渠道键存在但类型坏 → 该渠道 fail closed，其它渠道照常 legacy
  const badEntry = parseChannelThresholds(JSON.stringify({ codex: 'nope', deepseek: { balance: { warning: 10, closing: 3, currency: 'CNY' } } }))
  check('T2j 渠道值坏类型 → 该渠道 blocked',
    resolveChannelThresholds(badEntry, 'codex', LEGACY).source === 'blocked')
  check('T2k 同一份配置里别的渠道不受影响',
    resolveChannelThresholds(badEntry, 'deepseek', LEGACY).source === 'channel')
  check('T2l 未列出的渠道仍 legacy',
    resolveChannelThresholds(badEntry, 'mimo', LEGACY).source === 'legacy')

  // 渠道存在但缺某窗口 → 该窗口为 0，不逐窗口退 legacy
  const onlyWeekly = parseChannelThresholds(JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }))
  const onlyResolved = resolveChannelThresholds(onlyWeekly, 'codex', LEGACY)
  check('T2m 缺窗口不退 legacy（5h 不判）',
    evaluateChannelMetrics(ch([{ scope: 'rolling-5h', percent: 1 }]), onlyResolved).stage === 'normal')
}

// ===========================================================================
// T3 — 归一化（非法值一律「未配置」，不猜）
// ===========================================================================
{
  const bad = parseChannelThresholds(JSON.stringify({
    codex: { windows: { weekly: { warning: 20, closing: 30 } } },
    'opencode-go': { windows: { weekly: { warning: 120, closing: -1 } } },
    deepseek: { balance: { warning: '10', closing: 3, currency: 'rmb¥' } },
    workbuddy: { credits: { warning: 100, closing: 200 } },
  }))
  const codex = resolveChannelThresholds(bad, 'codex', LEGACY)
  check('T3a 收尾 >= 预警 → 该指标作废', codex.windows.weekly.warning === null && codex.windows.weekly.closing === null,
    codex.windows.weekly)
  check('T3b 作废指标不参与判定（即使数值很低）',
    evaluateChannelMetrics(ch([{ scope: 'weekly', percent: 1 }]), codex).stage === 'normal')
  const oc = resolveChannelThresholds(bad, 'opencode-go', LEGACY)
  check('T3c >100 / 负数 → 未配置', oc.windows.weekly.warning === null && oc.windows.weekly.closing === null)
  const ds = resolveChannelThresholds(bad, 'deepseek', LEGACY)
  check('T3d 字符串数字不被接受（不猜）', ds.balance.warning === null, ds.balance)
  check('T3e 非法币种归一为 null', ds.balance.currency === null, ds.balance)
  check('T3f 币种非法 → 金额指标不参与',
    evaluateChannelMetrics(ch([], { unit: 'currency', currency: 'CNY', balance: 1 }), ds).stage === 'normal')
  const wb = resolveChannelThresholds(bad, 'workbuddy', LEGACY)
  check('T3g 积分同理：收尾 >= 预警整体作废', wb.credits === null, wb.credits)
  // 3 字母代码一律接受（不擅自映射 RMB→CNY）；但与实测币种不一致时不参与。
  const rmb = resolveChannelThresholds(parseChannelThresholds(JSON.stringify({
    deepseek: { balance: { warning: 10, closing: 3, currency: 'rmb' } },
  })), 'deepseek', LEGACY_OFF)
  check('T3h RMB 被原样接受', rmb.balance.currency === 'RMB', rmb.balance)
  check('T3i RMB 阈值不会被当成 CNY 使用',
    evaluateChannelMetrics({ availability: 'ok', unit: 'currency', currency: 'CNY', balance: 1 }, rmb).stage === 'normal')
}

// ===========================================================================
// T4 — 判定：legacy 最短窗口 vs per-channel 各窗口独立
// ===========================================================================
{
  // 5h=30（<40 → warning）、weekly=15（<20 → closing）。legacy 只判最短窗口 → warning。
  const legacyEval = stageForChannel(ch([fiveHour, weeklyMid]), LEGACY, pickSmallestWindow)
  check('T4a legacy 仍按最短窗口判定（5h warning，不算 weekly closing）',
    legacyEval.stage === 'warning' && legacyEval.metric.scope === 'rolling-5h', legacyEval)

  const perWindow = resolveChannelThresholds(parseChannelThresholds(JSON.stringify({
    codex: { windows: { 'rolling-5h': { warning: 20, closing: 5 }, weekly: { warning: 20, closing: 5 } } },
  })), 'codex', LEGACY_OFF)
  const ev = evaluateChannelMetrics(ch([fiveHour, weeklyMid]), perWindow)
  check('T4b per-channel：5h normal、weekly warning → 整体 warning',
    ev.stage === 'warning' && ev.metrics.length === 1 && ev.metrics[0].scope === 'weekly', ev.metrics)

  const ev2 = evaluateChannelMetrics(ch([fiveHour, weeklyLow]), perWindow)
  check('T4c 任一窗口 closing → 整体 closing', ev2.stage === 'closing', ev2.metrics)
  check('T4d 触发明细按严重度排序（closing 在前）', ev2.metrics[0].stage === 'closing', ev2.metrics)

  // 数组顺序不影响取值（身份是 key，不是下标）
  const reversed = evaluateChannelMetrics(ch([weeklyMid, fiveHour]), perWindow)
  check('T4e 窗口数组顺序变动不串值',
    JSON.stringify(reversed.metrics) === JSON.stringify(ev.metrics), reversed.metrics)

  // 只有周额度：不把周当 5h 的替代，也不看 5h 阈值
  const weeklyOnly = evaluateChannelMetrics(ch([weeklyMid]), perWindow)
  check('T4f 只有 weekly 时只按 weekly 判', weeklyOnly.stage === 'warning' && weeklyOnly.metrics[0].scope === 'weekly')
  const weeklyNormal = evaluateChannelMetrics(ch([{ scope: 'weekly', percent: 90 }]), perWindow)
  check('T4g 只有 weekly 且充足 → normal（不因缺 5h 而报警）', weeklyNormal.stage === 'normal', weeklyNormal)

  // 未知 scope 不参与、不冒充
  const unknown = evaluateChannelMetrics(ch([{ scope: 'rolling-1d', percent: 1 }]), perWindow)
  check('T4h 词表外窗口不参与判定', unknown.stage === 'normal' && unknown.metrics.length === 0, unknown)
  check('T4i windowKeyOf 精确匹配（不猜）', windowKeyOf('rolling') === null && windowKeyOf('weekly') === 'weekly')

  // 不平均 / 不求和：两个窗口各算各的，触发明细里是两个各自的值
  const both = evaluateChannelMetrics(ch([
    { scope: 'rolling-5h', percent: 40 },
    { scope: 'weekly', percent: 10 },
  ]), perWindow)
  check('T4j 多窗口各自判定，不平均不求和',
    both.metrics.length === 1 && both.metrics[0].value === 10 && both.metrics[0].scope === 'weekly', both.metrics)

  // 渠道整体取最严重，且提示能说明哪个窗口
  const view = buildQuotaView({
    cfg: {
      quotaPolicyEnabled: true,
      quotaFocusChannels: '["codex"]',
      quotaThresholds: '',
      quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
    },
    observation: { provider: 'openai-codex' },
    readChannel: () => ch([fiveHour, weeklyLow]),
    readObservation: () => ({ status: 'ok', sampledAt: 1 }),
    pickSmallestWindow,
  })
  const text = renderQuotaPrompt(view)
  check('T4k 视图整体取最严重', view.stage === 'closing', view)
  check('T4l 提示里点名触发窗口与当前值',
    text.indexOf('周窗口') !== -1 && text.indexOf('3%') !== -1, text)
  check('T4m 提示里同时列出所有实际窗口的数值',
    text.indexOf('rolling-5h 剩余 30%') !== -1 && text.indexOf('weekly 剩余 3%') !== -1, text)

  // unavailable / unlimited / stale 不参与
  check('T4n availability 非 ok 不参与',
    evaluateChannelMetrics(Object.assign({}, ch([weeklyLow]), { availability: 'error' }), perWindow).stage === 'normal')
  check('T4o unlimited 不参与',
    evaluateChannelMetrics(Object.assign({}, ch([weeklyLow]), { unlimited: true }), perWindow).stage === 'normal')
  check('T4p stale 不参与',
    evaluateChannelMetrics(Object.assign({}, ch([weeklyLow]), { stale: true }), perWindow).stage === 'normal')
}

// ===========================================================================
// T5 — 金额（同币种）与积分（不与金额混比）
// ===========================================================================
{
  const cfg = JSON.stringify({
    deepseek: { balance: { warning: 10, closing: 3, currency: 'CNY' } },
    workbuddy: { credits: { warning: 1000, closing: 500 } },
  })
  const parsed = parseChannelThresholds(cfg)
  const ds = resolveChannelThresholds(parsed, 'deepseek', LEGACY_OFF)
  check('T5a 同币种金额参与判定',
    evaluateChannelMetrics({ availability: 'ok', unit: 'currency', currency: 'CNY', balance: 2 }, ds).stage === 'closing')
  check('T5b 异币种不参与（不把 USD 当 CNY）',
    evaluateChannelMetrics({ availability: 'ok', unit: 'currency', currency: 'USD', balance: 2 }, ds).stage === 'normal')
  check('T5c 币种大小写归一（cny → CNY）',
    evaluateChannelMetrics({ availability: 'ok', unit: 'currency', currency: 'cny', balance: 2 }, ds).stage === 'closing')
  const wb = resolveChannelThresholds(parsed, 'workbuddy', LEGACY_OFF)
  check('T5d 积分用积分阈值',
    evaluateChannelMetrics({ availability: 'ok', unit: 'credits', balance: 400 }, wb).stage === 'closing')
  check('T5e 积分不与金额阈值混比（余额阈值不动积分）',
    evaluateChannelMetrics({ availability: 'ok', unit: 'credits', balance: 400 }, ds).stage === 'normal')
  check('T5f 金额渠道不套用积分阈值',
    evaluateChannelMetrics({ availability: 'ok', unit: 'currency', currency: 'CNY', balance: 400 }, wb).stage === 'normal')
}

// ===========================================================================
// T6 — 安全：原型污染 / own property
// ===========================================================================
{
  const polluted = parseChannelThresholds('{"__proto__":{"polluted":true},"codex":{"windows":{"weekly":{"warning":20,"closing":5}}}}')
  check('T6a __proto__ 不进入渠道表', !Object.prototype.hasOwnProperty.call(polluted.channels, '__proto__'))
  check('T6b Object.prototype 未被污染', ({}).polluted === undefined)
  const ctor = parseChannelThresholds('{"constructor":{"windows":{}},"prototype":{"windows":{}}}')
  check('T6c constructor / prototype 被忽略',
    !Object.prototype.hasOwnProperty.call(ctor.channels, 'constructor')
    && !Object.prototype.hasOwnProperty.call(ctor.channels, 'prototype'))
  const own = resolveChannelThresholds(parseChannelThresholds(JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } })), 'codex', LEGACY)
  check('T6d toString 之类的继承键不会被当成渠道条目',
    resolveChannelThresholds(parseChannelThresholds('{}'), 'toString', LEGACY).source === 'legacy')
  check('T6e 合法条目仍正常解析', own.source === 'channel')
}

// ===========================================================================
// T7 — describeWindowCapability（失败 ≠ 没有窗口；身份变了不回窗口）
// ===========================================================================
{
  const metaOk = { status: 'ok', identity: 'id-1', sampledAt: 111 }
  const projection = { unit: null, currency: null, windows: [weeklyMid, fiveHour] }
  const ok = describeWindowCapability({ meta: metaOk, channel: projection, expectedIdentity: 'id-1' })
  check('T7a ok：返回窗口且按词表序', ok.status === 'ok' && ok.windows.map((w) => w.key).join(',') === 'rolling-5h,weekly', ok)
  check('T7b ok：带采样时间', ok.sampledAt === 111)
  const cached = describeWindowCapability({ meta: { status: 'cached', identity: 'id-1', sampledAt: 222 }, channel: projection, expectedIdentity: 'id-1' })
  check('T7c cached：仍给窗口（同一身份的上次成功值）', cached.status === 'cached' && cached.windows.length === 2)
  const failed = describeWindowCapability({ meta: { status: 'failed', identity: 'id-1', sampledAt: null }, channel: null, expectedIdentity: 'id-1' })
  check('T7d failed：只回状态、不回窗口（失败≠没有窗口）',
    failed.status === 'failed' && failed.windows.length === 0, failed)
  const expired = describeWindowCapability({ meta: { status: 'expired', identity: 'id-1' }, channel: null, expectedIdentity: 'id-1' })
  check('T7e expired：不回窗口', expired.status === 'expired' && expired.windows.length === 0)
  const stale = describeWindowCapability({ meta: { status: 'ok', identity: 'old-account' }, channel: projection, expectedIdentity: 'new-account' })
  check('T7f 身份不一致 → stale-identity 且不回旧账号窗口',
    stale.status === 'stale-identity' && stale.windows.length === 0, stale)
  const noIdentity = describeWindowCapability({ meta: { status: 'ok', identity: 'x' }, channel: projection, expectedIdentity: null })
  check('T7g 身份不可证明 → 不回窗口', noIdentity.status === 'stale-identity' && noIdentity.windows.length === 0)
  const unknownScope = describeWindowCapability({ meta: metaOk, channel: { windows: [{ scope: 'weird', percent: 5 }] }, expectedIdentity: 'id-1' })
  check('T7h 词表外 scope 不出现', unknownScope.windows.length === 0)
  const weeklyOnly = describeWindowCapability({ meta: metaOk, channel: { windows: [weeklyMid] }, expectedIdentity: 'id-1' })
  check('T7i 只有 weekly 时只回 weekly', weeklyOnly.windows.length === 1 && weeklyOnly.windows[0].key === 'weekly')
  const money = describeWindowCapability({
    meta: metaOk,
    channel: { unit: 'currency', currency: 'usd', windows: [] },
    expectedIdentity: 'id-1',
  })
  check('T7j 金额渠道带 unit/currency（大写）', money.unit === 'currency' && money.currency === 'USD', money)
  check('T7k 无观察 → status none', describeWindowCapability({ meta: null, channel: null, expectedIdentity: 'x' }).status === 'none')
}

// ===========================================================================
// T8 — 独立审查 P08：大额金额不因新上限被改变（legacy 与新结构都不加上限）
// ===========================================================================
{
  const legacyBig = thresholdsOf({ quotaWarningCreditsThreshold: 1e14, quotaClosingCreditsThreshold: 1e13 })
  const creditsCh = { availability: 'ok', unit: 'credits', balance: 1e12 }
  // 旧行为：1e12 < 收尾 1e13 → closing（新实现必须一致）
  check('T8a legacy 大额积分仍是 closing',
    stageForChannel(creditsCh, legacyBig, pickSmallestWindow).stage === 'closing',
    stageForChannel(creditsCh, legacyBig, pickSmallestWindow))

  const bigEntry = parseChannelThresholds(JSON.stringify({
    workbuddy: { credits: { warning: 1e14, closing: 1e13 } },
  }))
  const resolved = resolveChannelThresholds(bigEntry, 'workbuddy', LEGACY_OFF)
  check('T8b 新结构接受大额阈值（无 1e12 上限）',
    resolved.credits !== null && resolved.credits.closing === 1e13, resolved.credits)
  check('T8c 新结构大额判定与 legacy 一致',
    evaluateChannelMetrics(creditsCh, resolved).stage === 'closing',
    evaluateChannelMetrics(creditsCh, resolved))

  // 金额渠道同理
  const bigBalance = parseChannelThresholds(JSON.stringify({
    deepseek: { balance: { warning: 5e12, closing: 2e12, currency: 'CNY' } },
  }))
  const balResolved = resolveChannelThresholds(bigBalance, 'deepseek', LEGACY_OFF)
  check('T8d 大额余额阈值可生效',
    evaluateChannelMetrics({ availability: 'ok', unit: 'currency', currency: 'CNY', balance: 1e12 }, balResolved).stage === 'closing')
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
