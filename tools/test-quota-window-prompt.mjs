/**
 * [2026-10-23] 提示词层：零注入分支 + 多窗口事实/触发解释 + 失败状态不得被改成零注入。
 *
 * 用真实 `buildQuotaView` / `renderQuotaPrompt`（不打桩）。
 *
 * 用法：node tools/test-quota-window-prompt.mjs
 */
import {
  STAGE_NORMAL, STAGE_WARNING, STAGE_CLOSING,
} from '../plans/quota-observer.js'
import { buildQuotaView } from '../plans/quota-view.js'
import { pickSmallestWindow, renderQuotaPrompt, FIXED_RULES } from '../plans/quota-prompt.js'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) }
  else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600))) }
}

const BASE = {
  enabled: true,
  quotaPolicyEnabled: true,
  quotaFocusChannels: '["codex"]',
  quotaChannelThresholds: JSON.stringify({
    codex: { windows: { 'rolling-5h': { warning: 20, closing: 5 }, weekly: { warning: 20, closing: 5 } } },
  }),
}
const CH = {
  id: 'codex',
  name: 'Codex',
  availability: 'ok',
  windows: [{ scope: 'weekly', percent: 3 }, { scope: 'rolling-5h', percent: 40 }],
}
const OK_META = { status: 'ok', identity: 'i', sampledAt: Date.parse('2026-10-23T02:00:00Z') }

function view(over, meta, channel) {
  return buildQuotaView(Object.assign({
    cfg: BASE,
    observation: { provider: 'openai-codex', model: 'gpt-6.1' },
    readChannel: () => (channel === undefined ? CH : channel),
    readObservation: () => (meta === undefined ? OK_META : meta),
    pickSmallestWindow,
    identityOf: () => 'i',
  }, over || {}))
}

// ===========================================================================
// P1 — 原本零投放的分支必须继续零投放
// ===========================================================================
{
  const off = view({ cfg: Object.assign({}, BASE, { quotaPolicyEnabled: false }) })
  check('P1a 总开关关闭 → enabled:false 且零文本',
    off.enabled === false && renderQuotaPrompt(off) === '', off)

  const noFocus = view({ cfg: Object.assign({}, BASE, { quotaFocusChannels: '[]' }) })
  check('P1b focus 为空 → 零投放', noFocus.enabled === false && renderQuotaPrompt(noFocus) === '')

  const unobserved = view({ observation: null })
  check('P1c 未观察路由 → 零投放', renderQuotaPrompt(unobserved) === '', unobserved)

  const unmapped = view({ observation: { provider: 'packyapi', model: 'x' } })
  check('P1d 未映射 provider → 零投放', unmapped.channelId === null && renderQuotaPrompt(unmapped) === '')

  const notFocused = view({ cfg: Object.assign({}, BASE, { quotaFocusChannels: '["workbuddy"]' }) })
  check('P1e 渠道未被关注 → 零投放', notFocused.channelId === null && renderQuotaPrompt(notFocused) === '')

  const disabledChannel = view({ cfg: Object.assign({}, BASE, { codexEnabled: false }) })
  check('P1f 渠道停用 → 零投放', disabledChannel.channelId === null && renderQuotaPrompt(disabledChannel) === '')

  const globalOff = view({ cfg: Object.assign({}, BASE, { enabled: false }) })
  check('P1g 监控总开关关闭 → 零投放', globalOff.enabled === false && renderQuotaPrompt(globalOff) === '')

  const sourceMismatch = view(
    { observation: { provider: 'deepseek-official' }, cfg: Object.assign({}, BASE, { quotaFocusChannels: '["deepseek"]' }) },
    { status: 'ok', identity: 'i', sampledAt: 1, source: 'account' },
    { id: 'deepseek', name: 'DeepSeek', availability: 'ok', unit: 'currency', currency: 'CNY', balance: 1 },
  )
  check('P1h 来源不匹配 → 零投放', sourceMismatch.channelId === null && renderQuotaPrompt(sourceMismatch) === '')

  const staleIdentity = view({}, { status: 'ok', identity: 'other', sampledAt: 1 })
  check('P1i 身份不一致 → 零投放', staleIdentity.channelId === null && renderQuotaPrompt(staleIdentity) === '')

  const ambiguous = view({ cfg: Object.assign({}, BASE, { quotaRouteBindings: JSON.stringify([
    { provider: 'openai-codex', model: 'gpt-6.1', channelId: 'codex' },
    { provider: 'openai-codex', model: 'gpt-6.1', channelId: 'workbuddy' },
  ]) }) })
  check('P1j 绑定歧义 → 零投放', ambiguous.ambiguous === true && renderQuotaPrompt(ambiguous) === '')

  const reserve = view({
    observation: { provider: 'openai-codex', model: 'gpt-reserve-1' },
    // 生产里 index.js 恒传 reservePoolReady: () => false（本版本没有该池的来源证明）。
    reservePoolReady: () => false,
    usesReservePool: (model) => typeof model === 'string' && model.indexOf('gpt-reserve') === 0,
  })
  check('P1k Reserve 池未证明 → 零投放', reserve.poolUnproven !== undefined && renderQuotaPrompt(reserve) === '')
}

// ===========================================================================
// P2 — 失败/过期/暂无数据：**保留**既有固定状态（不得被改成零注入）
// ===========================================================================
{
  const failed = view({}, { status: 'failed', identity: 'i', sampledAt: null }, null)
  const failedText = renderQuotaPrompt(failed)
  check('P2a failed 仍给固定状态（不是空串）', failedText.indexOf('获取额度失败') !== -1, failedText)
  check('P2b failed 不带旧数值', failedText.indexOf('%') === -1, failedText)

  const expired = view({}, { status: 'expired', identity: 'i', sampledAt: null }, null)
  check('P2c expired 仍给固定状态', renderQuotaPrompt(expired).indexOf('用量查询身份已过期') !== -1, renderQuotaPrompt(expired))

  const noData = view({}, undefined, null)
  check('P2d 暂无数据仍给固定状态', renderQuotaPrompt(noData).indexOf('暂无额度数据') !== -1, renderQuotaPrompt(noData))
}

// ===========================================================================
// P3 — 单窗口文本与旧版逐字一致（保护既有断言）
// ===========================================================================
{
  const single = { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 60 }] }
  const text = renderQuotaPrompt({
    enabled: true, channelId: 'codex', channel: single, stage: STAGE_NORMAL,
    fromCache: false, fetchedAt: Date.parse('2026-10-23T02:00:00Z'),
  })
  check('P3a 单窗口事实行格式不变',
    text.indexOf('额度：rolling-5h 剩余 60%') !== -1, text)
  check('P3b normal 不含行为规则', text.indexOf('预警') === -1 && text.indexOf('收尾') === -1, text)
  check('P3c normal 不含指令词「请」', text.indexOf('请') === -1, text)

  const bal = renderQuotaPrompt({
    enabled: true, channelId: 'deepseek',
    channel: { id: 'deepseek', name: 'DeepSeek', availability: 'ok', unit: 'currency', currency: 'CNY', balance: 9000 },
    stage: STAGE_NORMAL, fetchedAt: null,
  })
  check('P3d 金额事实行格式不变', bal.indexOf('额度：9000 CNY') !== -1, bal)
}

// ===========================================================================
// P4 — 多窗口：事实逐行 + 触发行点名窗口与当前值 + 不平均
// ===========================================================================
{
  const v = view()
  const text = renderQuotaPrompt(v)
  check('P4a 整体阶段取最严重（weekly 3% → closing）', v.stage === STAGE_CLOSING, v)
  check('P4b 两个窗口各一行事实',
    text.indexOf('额度：rolling-5h 剩余 40%') !== -1 && text.indexOf('额度：weekly 剩余 3%') !== -1, text)
  check('P4c 触发行点名窗口、当前值与该档',
    text.indexOf('触发：周窗口（weekly） 剩余 3% < 收尾 5%（closing）') !== -1, text)
  check('P4d closing 附收尾模板', text.indexOf(FIXED_RULES[STAGE_CLOSING]) !== -1, text)
  check('P4e 不附预警模板', text.indexOf(FIXED_RULES[STAGE_WARNING]) === -1, text)
  // 40 + 3 = 43；不平均也不求和 → 文本里不应出现这两个合成数
  check('P4f 不出现百分比之和/平均', text.indexOf('43%') === -1 && text.indexOf('21.5%') === -1, text)

  const warnOnly = view({}, undefined, { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'weekly', percent: 12 }] })
  const warnText = renderQuotaPrompt(warnOnly)
  check('P4g 仅周额度 → 只按周判 warning', warnOnly.stage === STAGE_WARNING, warnOnly)
  check('P4h 仅周额度时事实行只出现 weekly',
    warnText.indexOf('额度：weekly 剩余 12%') !== -1 && warnText.indexOf('rolling-5h') === -1, warnText)
}

// ===========================================================================
// P5 — legacy 分支与坏配置的说明文字
// ===========================================================================
{
  const legacyCfg = {
    enabled: true,
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["codex"]',
    quotaWarningPercentThreshold: 40,
    quotaClosingPercentThreshold: 20,
    quotaChannelThresholds: '',
  }
  const legacyView = view({
    cfg: legacyCfg,
    // 5h 30%（<40 → warning）；weekly 3%（<20 → closing，但 legacy **不**看它）
    readChannel: () => ({
      id: 'codex',
      name: 'Codex',
      availability: 'ok',
      windows: [{ scope: 'weekly', percent: 3 }, { scope: 'rolling-5h', percent: 30 }],
    }),
  })
  const legacyText = renderQuotaPrompt(legacyView)
  check('P5a 旧全局阈值仍按最短窗口（5h 30% → warning，不因 weekly 3% 变 closing）',
    legacyView.stage === STAGE_WARNING && legacyView.metrics[0].scope === 'rolling-5h', legacyView)
  check('P5b legacy 视图标记 legacyPolicy', legacyView.legacyPolicy === true)
  check('P5c 文本说明"旧版全局阈值（按最短窗口）"',
    legacyText.indexOf('旧版全局阈值') !== -1 && legacyText.indexOf('最短窗口') !== -1, legacyText)

  const brokenView = view({ cfg: Object.assign({}, BASE, { quotaChannelThresholds: '{oops' }) })
  const brokenText = renderQuotaPrompt(brokenView)
  check('P5d 坏配置 fail closed（normal、无触发行）',
    brokenView.stage === STAGE_NORMAL && brokenView.metrics.length === 0, brokenView)
  check('P5e 坏配置给出可读说明（不是静默）',
    brokenText.indexOf('阈值配置无法解析') !== -1 && brokenView.policyBlocked !== null, brokenText)
  check('P5f 坏配置不带任何行为规则',
    brokenText.indexOf(FIXED_RULES[STAGE_CLOSING]) === -1 && brokenText.indexOf(FIXED_RULES[STAGE_WARNING]) === -1)
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
