/**
 * [方向 6 / D6-C] 真实 provider → 投影 → render/策略 的集成测试。
 *
 * 复核明确要求「用真实 provider→project→render/策略 的集成测试，不再在测试里
 * 发明 provider 没有的字段」。这里直接调用 `plans/opencode-go.js` 与
 * `plans/deepseek.js` 的**真实 fetch**，只替换最底层的 `globalThis.fetch`
 * 与可选的账号服务，因此经过的是真实的 wire 映射逻辑。
 *
 * 用法：node tools/test-usage-integration.mjs
 */
import assert from 'node:assert/strict'
import opencodeGo from '../plans/opencode-go.js'
import deepseek from '../plans/deepseek.js'
import { percentSemanticsOf } from '../plans/index.js'
import { projectPlan, renderUsage, projectUsage } from '../plans/usage-tool.js'
import { policyOf, policyPromptFor } from '../plans/usage-policy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

/** 用一份 JSON 响应替换全局 fetch（`curlJson` 走这条路径）。 */
async function withStubbedFetch(body, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  })
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

const ctx = { get: () => undefined }

function cfgOf(extra) {
  return Object.assign({ enabled: true }, extra || {})
}

// ===========================================================================
// I1 — OpenCode：真实 usagePercent=90 是「已用」→ 剩余 10%
// ===========================================================================
{
  const wire = await withStubbedFetch({
    usage: {
      rolling: { usagePercent: 90, resetsAt: '2026-10-18T10:00:00Z' },
      weekly: { usagePercent: 20 },
      monthly: { usagePercent: 0 },
    },
  }, () => opencodeGo.fetch(ctx, undefined, cfgOf({ apiKey: 'DUMMY_TEST_TEST_USAGE_INTEGRATION_1' })))

  check('I1a 真实 provider 返回 rollingUsage', wire.rollingUsage !== null && typeof wire.rollingUsage === 'object', wire)
  check('I1b wire.percent 是**已用** 90（provider 原样保留）', wire.rollingUsage.percent === 90, wire.rollingUsage)
  check('I1c 口径表声明 OpenCode 为 used', percentSemanticsOf('opencode-go') === 'used')

  const projected = projectPlan(wire, { semantics: percentSemanticsOf('opencode-go') })
  check('I1d 投影后剩余 10%', projected.windows[0].percent === 10, projected.windows[0])
  check('I1e 口径标 remaining', projected.windows[0].percentMode === 'remaining')
  check('I1f 第二个窗口 已用20%→剩余80%', projected.windows[1].percent === 80, projected.windows)

  const text = renderUsage({ channels: [projected] })
  check('I1g 渲染为「剩余 10%」', text.includes('剩余 10%'), text)
  check('I1h 渲染**不再**说「剩余 90%」', !text.includes('剩余 90%'), text)

  // 策略：剩余 10% < 阈值 20% → 触发（若仍按已用 90 会误判为不触发）
  const policy = policyOf({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["opencode-go"]',
    quotaPercentThreshold: 20,
    quotaBalanceThreshold: 0,
    quotaBalanceCurrency: '',
  })
  const prompt = policyPromptFor({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["opencode-go"]',
    quotaPercentThreshold: 20,
  }, { channels: [projected] })
  check('I1i 策略按剩余判定（10% < 20% 触发）', prompt !== null, prompt)
  check('I1j 策略文本含 10%', prompt !== null && prompt.includes('10'), prompt)
  void policy
}

// ===========================================================================
// I2 — OpenCode 边界：已用 0 / 100 / 越界
// ===========================================================================
{
  const zero = await withStubbedFetch({ usage: { rolling: { usagePercent: 0 } } }, () =>
    opencodeGo.fetch(ctx, undefined, cfgOf({ apiKey: 'sk-synthetic' })))
  const zeroProjected = projectPlan(zero, { semantics: 'used' })
  check('I2a 已用 0% → 剩余 100%', zeroProjected.windows[0].percent === 100, zeroProjected.windows[0])

  const full = await withStubbedFetch({ usage: { rolling: { usagePercent: 100 } } }, () =>
    opencodeGo.fetch(ctx, undefined, cfgOf({ apiKey: 'sk-synthetic' })))
  const fullProjected = projectPlan(full, { semantics: 'used' })
  check('I2b 已用 100% → 剩余 0%', fullProjected.windows[0].percent === 0, fullProjected.windows[0])

  const beyond = await withStubbedFetch({ usage: { rolling: { usagePercent: 140 } } }, () =>
    opencodeGo.fetch(ctx, undefined, cfgOf({ apiKey: 'sk-synthetic' })))
  const beyondProjected = projectPlan(beyond, { semantics: 'used' })
  check('I2c 越界 140 不钳位（剩余 null）', beyondProjected.windows === undefined || beyondProjected.windows.length === 0,
    beyondProjected.windows)
}

// ===========================================================================
// I3 — Codex 口径不能被一起反转（用同一套投影，语义不同）
// ===========================================================================
{
  const codexLike = {
    id: 'codex',
    rollingUsage: { percent: 33 },
  }
  const remainingProjected = projectPlan(codexLike, { semantics: 'remaining' })
  check('I3a Codex 33 仍是剩余 33', remainingProjected.windows[0].percent === 33, remainingProjected.windows[0])

  const wronglyUsed = projectPlan(codexLike, { semantics: 'used' })
  check('I3b 若错当已用会变 67（证明口径必须按渠道声明）', wronglyUsed.windows[0].percent === 67,
    wronglyUsed.windows[0])
}

// ===========================================================================
// I4 — DeepSeek：真实 API 路径带回实际币种
// ===========================================================================
{
  const usdWire = await withStubbedFetch({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '7.25', topped_up_balance: '5.00', granted_balance: '2.25' }],
  }, () => deepseek.fetch(ctx, undefined, cfgOf({ deepseekApiKey: 'sk-synthetic-deepseek' })))

  check('I4a 真实 provider 返回余额', usdWire.balance === 7.25, usdWire)
  check('I4b wire 带实际币种 USD', usdWire.currency === 'USD', usdWire.currency)

  const projected = projectPlan(usdWire, { semantics: 'used' })
  check('I4c 投影保留 USD（不硬编码 CNY）', projected.currency === 'USD', projected)
  check('I4d 单位是 currency', projected.unit === 'currency')
  check('I4e 渲染含 USD', renderUsage({ channels: [projected] }).includes('USD'), renderUsage({ channels: [projected] }))

  const cnyWire = await withStubbedFetch({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '1.00' },
      { currency: 'CNY', total_balance: '9.90' },
    ],
  }, () => deepseek.fetch(ctx, undefined, cfgOf({ deepseekApiKey: 'sk-synthetic' })))
  check('I4f CNY 优先且带回 CNY', cnyWire.currency === 'CNY' && cnyWire.balance === 9.9, cnyWire)

  const unknownWire = await withStubbedFetch({
    is_available: true,
    balance_infos: [{ total_balance: '3.00' }],
  }, () => deepseek.fetch(ctx, undefined, cfgOf({ deepseekApiKey: 'sk-synthetic' })))
  const unknownProjected = projectPlan(unknownWire, { semantics: 'used' })
  check('I4g 币种缺失时为 null（不猜 CNY）', unknownProjected.currency === null, unknownProjected.currency)
  check('I4h 币种未知时不声明单位', unknownProjected.unit === null, unknownProjected.unit)
}

// ===========================================================================
// I5 — WorkBuddy 真实 wire 字段（creditsTotal）
// ===========================================================================
{
  // provider 的 wire 由 credits.total 映射为 creditsTotal；这里直接给真实字段名。
  const wb = projectPlan({ id: 'workbuddy', creditsTotal: 1906 }, { semantics: 'used' })
  check('I5a creditsTotal 被读取', wb.balance === 1906, wb)
  check('I5b 不再落成 unknown', wb.availability === 'ok', wb.availability)
  check('I5c 积分单位显式', wb.unit === 'credits')

  const out = projectUsage([{ id: 'workbuddy', creditsTotal: 1906 }], ['workbuddy'], {
    enabled: ['workbuddy'], known: ['workbuddy'], semanticsOf: percentSemanticsOf,
  })
  check('I5d 整体投影可用', out.channels[0].availability === 'ok', out.channels[0])
  check('I5e 渲染含积分与数值',
    renderUsage(out).includes('积分') && renderUsage(out).includes('1906'), renderUsage(out))
}

// ===========================================================================
// I6 — 策略端到端：真实 provider → 投影 → 策略文本
// ===========================================================================
{
  const wire = await withStubbedFetch({
    usage: { rolling: { usagePercent: 85 } },
  }, () => opencodeGo.fetch(ctx, undefined, cfgOf({ apiKey: 'sk-synthetic' })))
  const projected = projectPlan(wire, { semantics: percentSemanticsOf('opencode-go') })
  const channels = [projected]

  // 剩余 15% < 20% → 触发
  const hit = policyPromptFor({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["opencode-go"]',
    quotaPercentThreshold: 20,
  }, { channels })
  check('I6a 真实链路触发策略', hit !== null, hit)
  check('I6b 文本含剩余 15%', hit !== null && hit.includes('15'), hit)

  // 阈值 10% 时不触发（15 >= 10）
  const miss = policyPromptFor({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["opencode-go"]',
    quotaPercentThreshold: 10,
  }, { channels })
  check('I6c 阈值更严时不触发', miss === null, miss)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
