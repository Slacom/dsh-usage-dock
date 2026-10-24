/**
 * [方向 6 / T1] `usage_status` 投影层测试。
 *
 * D6-C：按**真实 provider 契约**适配——OpenCode 的 `usagePercent` 是「已用」，
 *   Codex 是「剩余」，WorkBuddy 用 `creditsTotal`，DeepSeek 带真实币种；越界不钳位。
 * D6-F：白名单字段也要做**值级**校验（`resetsAt` 只接受可解析时间）。
 *
 * 用法：node tools/test-usage-tool.mjs
 */
import assert from 'node:assert/strict'
import {
  TOOL_NAME, TOOL_CACHE_TTL_MS, TOOL_BUDGET_MS, MAX_TOOL_IDS,
  isKnownIdShape, isRetiredId, finiteOrNull, projectWindow, projectPlan,
  parseToolArgs, projectUsage, renderUsage, formatChannel,
  normalizeTime, normalizeSeconds, errorTextOf,
} from '../plans/usage-tool.js'
import { percentSemanticsOf } from '../plans/index.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

const CONTEXT = {
  enabled: ['deepseek', 'codex', 'mimo', 'opencode-go', 'workbuddy', 'workbuddy-ai'],
  known: ['deepseek', 'codex', 'mimo', 'opencode-go', 'workbuddy', 'workbuddy-ai'],
  semanticsOf: percentSemanticsOf,
}

// ===========================================================================
// P1 — 常量与 id 形态
// ===========================================================================
{
  check('P1a 工具名', TOOL_NAME === 'usage_status')
  check('P1b 缓存 TTL 30 秒', TOOL_CACHE_TTL_MS === 30000)
  check('P1c 预算为正', TOOL_BUDGET_MS > 0 && TOOL_BUDGET_MS <= 30000)
  check('P1d 内置 id 合法', isKnownIdShape('deepseek') && isKnownIdShape('workbuddy-ai'))
  check('P1e 自定义 id 合法', isKnownIdShape('custom:abcdef123456'))
  check('P1f 非法 id 被拒', !isKnownIdShape('nope') && !isKnownIdShape('') && !isKnownIdShape(42))
  check('P1g 退场 id 可识别', isRetiredId('kimi-code') && isRetiredId('glm-zhipu') && isRetiredId('glm-zai'))
  check('P1h 活动 id 不算退场', !isRetiredId('deepseek'))
}

// ===========================================================================
// P2 — 数值语义
// ===========================================================================
{
  check('P2a 0 有效', finiteOrNull(0) === 0)
  check('P2b 负数保留', finiteOrNull(-3.2) === -3.2)
  check('P2c null → null', finiteOrNull(null) === null)
  check('P2d string → null', finiteOrNull('12.5') === null)
  check('P2e NaN → null', finiteOrNull(NaN) === null)
  check('P2f Infinity → null', finiteOrNull(Infinity) === null)
}

// ===========================================================================
// P3 — D6-C：百分比口径（Codex=剩余，OpenCode=已用）
// ===========================================================================
{
  check('P3a 口径表：codex 是剩余', percentSemanticsOf('codex') === 'remaining')
  check('P3b 口径表：opencode 是已用', percentSemanticsOf('opencode-go') === 'used')
  check('P3c 未声明渠道保守按已用', percentSemanticsOf('something-new') === 'used')

  const remaining = projectWindow({ percent: 33 }, 'remaining')
  check('P3d Codex 33% 剩余原样保留', remaining.percent === 33, remaining)

  const used = projectWindow({ percent: 90 }, 'used')
  check('P3e OpenCode 已用 90% → 剩余 10%', used.percent === 10, used)
  check('P3f 换算后仍标 remaining', used.percentMode === 'remaining', used)

  check('P3g 已用 0% → 剩余 100%', projectWindow({ percent: 0 }, 'used').percent === 100)
  check('P3h 已用 100% → 剩余 0%', projectWindow({ percent: 100 }, 'used').percent === 0)

  // 越界不钳位（D6-C）
  const over = projectWindow({ percent: 120, resetInSec: 60 }, 'used')
  check('P3i 越界 120 不钳位，剩余为 null', over.percent === null, over)
  const negative = projectWindow({ percent: -5, resetInSec: 60 }, 'used')
  check('P3j 负数不钳位，剩余为 null', negative.percent === null, negative)
  check('P3k 越界但有权重时间时窗口仍保留', over !== null && over.resetInSec === 60, over)
}

// ===========================================================================
// P4 — D6-F：时间字段值级校验
// ===========================================================================
{
  check('P4a 合法 ISO 时间被规范化', normalizeTime('2026-10-18T10:00:00Z') === '2026-10-18T10:00:00.000Z')
  check('P4b 带偏移的时间被接受', normalizeTime('2026-10-18T18:00:00+08:00') === '2026-10-18T10:00:00.000Z')
  check('P4c 带空格的日期时间被接受', normalizeTime('2026-10-18 10:00') !== null)
  check('P4d URL 被拒绝', normalizeTime('https://private.example/account/123') === null)
  check('P4e 自由文本被拒绝', normalizeTime('SENTINEL_SECRET') === null)
  check('P4f 纯年份被拒绝', normalizeTime('2026') === null)
  check('P4g 超长串被拒绝', normalizeTime('2026-10-18T10:00:00Z' + 'x'.repeat(60)) === null)
  check('P4h 非字符串被拒绝', normalizeTime(1750000000000) === null)
  check('P4i 空串被拒绝', normalizeTime('') === null)
  check('P4j 非法日期被拒绝', normalizeTime('2026-13-45T99:99:99Z') === null)

  check('P4k 秒数合法', normalizeSeconds(120) === 120)
  check('P4l 秒数取整', normalizeSeconds(120.9) === 120)
  check('P4m 负数秒被拒绝', normalizeSeconds(-1) === null)
  check('P4n 超大秒被拒绝', normalizeSeconds(1e12) === null)
  check('P4o 非数字秒被拒绝', normalizeSeconds('120') === null)
}

// ===========================================================================
// P5 — 内置渠道投影（真实 wire 字段）
// ===========================================================================
{
  const ds = projectPlan({ id: 'deepseek', balance: 7.25, currency: 'USD', isAvailable: true }, { semantics: 'used' })
  check('P5a DeepSeek 是 balance', ds.kind === 'balance' && ds.balance === 7.25, ds)
  check('P5b DeepSeek 币种来自 wire（USD 不被改写成 CNY）', ds.currency === 'USD', ds.currency)
  check('P5c 币种单位标记', ds.unit === 'currency', ds.unit)

  const dsNoCurrency = projectPlan({ id: 'deepseek', balance: 7.25 }, { semantics: 'used' })
  check('P5d 缺币种时为 null（不猜）', dsNoCurrency.currency === null && dsNoCurrency.unit === null, dsNoCurrency)

  const codex = projectPlan({
    id: 'codex',
    rollingUsage: { percent: 33 },
    weeklyUsage: { percent: 72 },
  }, { semantics: 'remaining' })
  check('P5e Codex 是 quota', codex.kind === 'quota', codex)
  check('P5f Codex 两个窗口都在', codex.windows.length === 2)
  check('P5g Codex 百分比是剩余', codex.windows[0].percent === 33 && codex.windows[1].percent === 72, codex.windows)
  check('P5h Codex 不虚构金额', codex.balance === null)

  const opencode = projectPlan({
    id: 'opencode-go',
    rollingUsage: { percent: 90 },
    weeklyUsage: { percent: 20 },
  }, { semantics: percentSemanticsOf('opencode-go') })
  check('P5i OpenCode 已用 90% → 剩余 10%', opencode.windows[0].percent === 10, opencode.windows)
  check('P5j OpenCode 已用 20% → 剩余 80%', opencode.windows[1].percent === 80, opencode.windows)

  // [D6-C] WorkBuddy 真实 wire 用 creditsTotal
  const wb = projectPlan({ id: 'workbuddy', creditsTotal: 1906 }, { semantics: 'used' })
  check('P5k WorkBuddy 读取 creditsTotal', wb.balance === 1906, wb)
  check('P5l WorkBuddy 是 credits 类型', wb.kind === 'credits', wb.kind)
  check('P5m 积分单位明确', wb.unit === 'credits', wb.unit)
  check('P5n 积分不带币种', wb.currency === null, wb.currency)
  check('P5o 积分可用性 ok', wb.availability === 'ok', wb.availability)

  const wbZero = projectPlan({ id: 'workbuddy', creditsTotal: 0 }, { semantics: 'used' })
  check('P5p 0 积分有效（不是缺失）', wbZero.balance === 0, wbZero)

  const wbNegative = projectPlan({ id: 'workbuddy', creditsTotal: -5 }, { semantics: 'used' })
  check('P5q 负积分保留', wbNegative.balance === -5, wbNegative)

  const wbUnlimited = projectPlan({ id: 'workbuddy', creditsUnlimited: true }, { semantics: 'used' })
  check('P5r unlimited 单独标记', wbUnlimited.unlimited === true && wbUnlimited.availability === 'unlimited', wbUnlimited)
  check('P5s unlimited 不伪造积分', wbUnlimited.balance === null)

  const wbMissing = projectPlan({ id: 'workbuddy' }, { semantics: 'used' })
  check('P5t 无积分字段时 unknown', wbMissing.availability === 'unknown' && wbMissing.balance === null, wbMissing)
}

// ===========================================================================
// P6 — 错误分类
// ===========================================================================
{
  const auth = projectPlan({ id: 'deepseek', error: 'auth', message: 'HTTP 401: sk-LEAK-abc invalid' }, {})
  check('P6a 鉴权错误固定码', auth.errorCode === 'auth' && auth.availability === 'error', auth)
  check('P6b 不泄露上游原文', !JSON.stringify(auth).includes('sk-LEAK'), auth)
  check('P6c 错误不带数值', auth.balance === null && auth.windows.length === 0)

  const noKey = projectPlan({ id: 'deepseek', error: 'no-key' }, {})
  check('P6d 缺凭据是可辨状态码', noKey.errorCode === 'no-credential', noKey.errorCode)
  check('P6e 缺凭据文案明确', errorTextOf('no-credential').includes('凭据'))

  const unknownCode = projectPlan({ id: 'deepseek', error: 'something-new' }, {})
  check('P6f 未知错误码归一', unknownCode.errorCode === 'unknown')

  const transient = projectPlan({ id: 'deepseek', error: 'server', transient: true }, {})
  check('P6g transient 保留', transient.transient === true)
  check('P6h 语义错误无 transient', auth.transient === false)
}

// ===========================================================================
// P7 — 退场 / 停用 / 不存在 / 缺失 四种状态可辨（D6-C）
// ===========================================================================
{
  for (const id of ['kimi-code', 'glm-zhipu', 'glm-zai']) {
    const out = projectPlan({ id, balance: 99 }, {})
    check('P7 ' + id + ' → retired-channel', out.errorCode === 'retired-channel' && out.kind === 'unknown', out)
    check('P7 ' + id + ' 无数值', out.balance === null && out.windows.length === 0)
  }

  const disabled = projectUsage([], ['deepseek'], {
    enabled: [], known: ['deepseek'], semanticsOf: percentSemanticsOf,
  })
  check('P7d 停用返回 disabled', disabled.channels[0].errorCode === 'disabled', disabled.channels[0])
  check('P7e disabled 有固定文案', disabled.channels[0].message === '该渠道已停用')

  const gone = projectUsage([], ['custom:abcdef123456'], {
    enabled: ['deepseek'], known: ['deepseek'], semanticsOf: percentSemanticsOf,
  })
  check('P7f 已删除自定义返回 not-found', gone.channels[0].errorCode === 'not-found', gone.channels[0])

  const missing = projectUsage([], ['deepseek'], {
    enabled: ['deepseek'], known: ['deepseek'], semanticsOf: percentSemanticsOf,
  })
  check('P7g 启用但没数据返回 missing', missing.channels[0].errorCode === 'missing', missing.channels[0])

  const codes = ['disabled', 'not-found', 'missing', 'retired-channel', 'no-credential']
  check('P7h 五种状态码互不相同', new Set(codes.map(errorTextOf)).size === codes.length,
    codes.map((c) => errorTextOf(c)))
}

// ===========================================================================
// P8 — 参数解析
// ===========================================================================
{
  const enabled = ['deepseek', 'codex']
  check('P8a 空参数 → 启用集合', parseToolArgs(undefined, enabled).ids.length === 2)
  check('P8b 显式 ids', parseToolArgs({ ids: ['codex'] }, enabled).ids[0] === 'codex')
  check('P8c 退场 id 允许', parseToolArgs({ ids: ['kimi-code'] }, enabled).ok === true)
  check('P8d 未知 id 是参数错误', parseToolArgs({ ids: ['typo'] }, enabled).ok === false)
  check('P8e 去重保序', parseToolArgs({ ids: ['codex', 'codex', 'deepseek'] }, enabled).ids.length === 2)
  check('P8f ids 非数组被拒', parseToolArgs({ ids: 'codex' }, enabled).ok === false)
  check('P8g 超上限被拒', parseToolArgs({ ids: new Array(MAX_TOOL_IDS + 1).fill('deepseek') }, enabled).ok === false)
  check('P8h 参数非对象被拒', parseToolArgs('nope', enabled).ok === false)
  check('P8i 空数组等同空参数', parseToolArgs({ ids: [] }, enabled).ids.length === 2)
}

// ===========================================================================
// P9 — 整体投影
// ===========================================================================
{
  const plans = [
    { id: 'deepseek', balance: 7.38, currency: 'CNY' },
    { id: 'codex', rollingUsage: { percent: 33 } },
  ]
  const out = projectUsage(plans, ['deepseek', 'codex'], CONTEXT)
  check('P9a 两条都在', out.channels.length === 2)
  check('P9b 顺序与请求一致', out.channels[0].id === 'deepseek' && out.channels[1].id === 'codex')

  const dupes = projectUsage(
    [{ id: 'deepseek', balance: 1 }, { id: 'deepseek', balance: 2 }],
    ['deepseek'], CONTEXT,
  )
  check('P9c 重复 wire 取第一条', dupes.channels[0].balance === 1)
}

// ===========================================================================
// P10 — 脱敏白名单（含 D6-F 值级校验）
// ===========================================================================
{
  const sentinel = 'sk-SENTINEL-LEAK-9f21'
  const dirty = {
    id: 'deepseek',
    balance: 7.38,
    currency: 'CNY',
    apiKey: sentinel,
    cookie: 'kimi-auth=' + sentinel,
    url: 'https://internal.example/secret-path',
    jsonPath: 'data.balance',
    accountId: 'user-12345',
    rawMessage: 'upstream says: ' + sentinel,
    upstreamBody: { nested: sentinel },
    planText: 'Pro Plan ¥99/月',
  }
  const out = projectPlan(dirty, { semantics: 'used' })
  const text = JSON.stringify(out)
  check('P10a 不泄露 Key/Cookie', !text.includes(sentinel), text)
  check('P10b 不泄露 URL/路径', !text.includes('internal.example') && !text.includes('data.balance'), text)
  check('P10c 不泄露账号', !text.includes('user-12345'), text)
  check('P10d 不泄露套餐文本', !text.includes('Pro Plan'), text)
  check('P10e 输出键是白名单',
    Object.keys(out).sort().join(',')
    === 'availability,balance,currency,errorCode,fetchedAt,id,kind,message,name,stale,transient,unit,unlimited,windows',
    Object.keys(out).sort())

  // [D6-F] 上游把敏感信息塞进**允许的**字段
  const sneaky = projectPlan({
    id: 'opencode-go',
    rollingUsage: {
      percent: 10,
      resetsAt: 'SENTINEL_SECRET https://private.example/account/123',
      resetInSec: 999999999999,
    },
  }, { semantics: 'used' })
  const sneakyText = JSON.stringify(sneaky)
  check('P10f 时间字段不接受 URL/自由文本', sneaky.windows[0].resetsAt === null, sneaky.windows[0])
  check('P10g 哨兵未进入输出', !sneakyText.includes('SENTINEL_SECRET') && !sneakyText.includes('private.example'), sneakyText)
  check('P10h 越界 resetInSec 被拒绝', sneaky.windows[0].resetInSec === null, sneaky.windows[0])
  check('P10i 该渠道仍标 ok（比例可用）', sneaky.availability === 'ok', sneaky.availability)

  // 合法时间仍可用
  const okTime = projectPlan({
    id: 'codex', rollingUsage: { percent: 50, resetsAt: '2026-10-18T10:00:00Z' },
  }, { semantics: 'remaining' })
  check('P10j 合法时间被保留并规范化', okTime.windows[0].resetsAt === '2026-10-18T10:00:00.000Z', okTime.windows[0])
}

// ===========================================================================
// P11 — 可读渲染
// ===========================================================================
{
  const out = projectUsage([
    { id: 'deepseek', balance: 7.38, currency: 'CNY' },
    { id: 'codex', rollingUsage: { percent: 33 } },
    { id: 'workbuddy', creditsTotal: 1906 },
    { id: 'mimo', error: 'auth' },
  ], ['deepseek', 'codex', 'workbuddy', 'mimo'], CONTEXT)
  const text = renderUsage(out)
  check('P11a 含余额与币种', text.includes('7.38') && text.includes('CNY'), text)
  check('P11b 含剩余百分比', text.includes('剩余') && text.includes('33%'), text)
  check('P11c 积分带单位', text.includes('积分') && text.includes('1906'), text)
  check('P11d 含错误说明', text.includes('鉴权失败'), text)
  check('P11e 空结果固定文案', renderUsage({ channels: [] }).includes('没有可查询'))

  check('P11f 负余额带符号',
    formatChannel({ name: 'A', availability: 'ok', balance: -3.2, currency: 'CNY', unit: 'currency', windows: [] }).includes('-3.2'))
  check('P11g disabled 渲染说明',
    formatChannel({ name: 'A', availability: 'unknown', errorCode: 'disabled', message: '该渠道已停用', windows: [] }).includes('已停用'))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
