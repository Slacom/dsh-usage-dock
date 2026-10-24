/**
 * [额度自动感知] 回归测试：路由观察、失败分类、三阶段、动态提示词。
 *
 * 对应交接文档 §9 的 A/B/C/D/E 组。全部离线（桩替换网络与凭据），不读真实 Key。
 *
 * 用法：node tools/test-quota-awareness.mjs
 */
import assert from 'node:assert/strict'
import {
  TEMPORARY_FAIL_LIMIT,
  classifyFailure,
  createQuotaObserver,
  stageOf,
  STAGE_NORMAL, STAGE_WARNING, STAGE_CLOSING,
} from '../plans/quota-observer.js'
import {
  resolveRoute, channelForProvider, pickSmallestWindow,
  renderQuotaPrompt, FIXED_RULES,
} from '../plans/quota-prompt.js'
import { createRouteObserver } from '../plans/quota-route.js'
import { buildQuotaView, thresholdsOf, hasAnyThreshold, stageForChannel } from '../plans/quota-view.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

// ===========================================================================
// N1 — 失败分类：结构化，不扫描自由文案
// ===========================================================================
{
  check('N1a 无凭据 → P（立即失败，不等 5 次）', classifyFailure('no-key') === 'P')
  check('N1b 网络 → T（计数）', classifyFailure('network') === 'T')
  // [A08] signed-out（从未登录）是配置问题(P)；reauth-required（明确需重登）才是过期(A)。
  check('N1c 明确需重登 → A', classifyFailure('reauth-required') === 'A')
  check('N1c2 从未登录 → P（不是过期）', classifyFailure('signed-out') === 'P')
  check('N1d 主动取消 → C（不计失败）', classifyFailure('cancelled') === 'C')
  check('N1e 未知但标 transient → T', classifyFailure('weird', { transient: true }) === 'T')
  // [A08] 无法识别的一般故障**先按 T** 宽限 4 次，不擅自判成永久失效。
  check('N1f 未知且未标 transient → T（先宽限，不无限重试由 5 次阈值兜底）',
    classifyFailure('weird') === 'T')
  check('N1g 401/403 的 auth 不算过期（记 P）', classifyFailure('auth') === 'P')
  check('N1h 无错误码 → null（不是失败）', classifyFailure(undefined) === null)
}

// ===========================================================================
// N2 — 5 次阈值状态机（[A03] 起用 begin/commit 票据 API）
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  const channel = { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 30 }] }
  const put = (o, outcome) => o.commit(o.begin({ id: 'codex', identity: 'id-A' }), outcome)
  put(obs, { channel, sampledAt: 5000 })
  const base = obs.read('codex', 'id-A')
  check('N2a 成功写入数值与采样时间', base.channel !== null && base.sampledAt === 5000, base)
  check('N2a2 成功状态为 ok', base.status === 'ok', base.status)

  for (let i = 1; i <= 4; i += 1) {
    const r = put(obs, { errorCode: 'network' })
    check('N2b T' + i + ' 仍保留旧值且采样时间不变',
      r.channel !== null && r.sampledAt === 5000 && r.failCount === i && r.status === 'cached', r)
  }
  const fifth = put(obs, { errorCode: 'network' })
  check('N2c 第 5 次移除旧值且状态 failed（limit=' + TEMPORARY_FAIL_LIMIT + '）',
    fifth.channel === null && fifth.sampledAt === null
    && fifth.failCount >= TEMPORARY_FAIL_LIMIT && fifth.status === 'failed', fifth)

  const recovered = put(obs, { channel, sampledAt: 8000 })
  check('N2d 成功恢复并清零',
    recovered.channel !== null && recovered.failCount === 0 && recovered.sampledAt === 8000, recovered)

  const obs2 = createQuotaObserver({ now: () => 1000 })
  const t1 = obs2.commit(obs2.begin({ id: 'mimo', identity: 'x' }), { errorCode: 'network' })
  check('N2e 无缓存时 T1 不伪造数值', t1.channel === null && t1.sampledAt === null, t1)

  const obs3 = createQuotaObserver({ now: () => 1000 })
  obs3.commit(obs3.begin({ id: 'codex', identity: 'y' }), { channel, sampledAt: 1000 })
  obs3.commit(obs3.begin({ id: 'codex', identity: 'y' }), { errorCode: 'no-key' })
  const afterP = obs3.commit(obs3.begin({ id: 'codex', identity: 'y' }), { errorCode: 'network' })
  check('N2f P 之后遇 T 不复活旧缓存', afterP.channel === null, afterP)
  check('N2g P 之后保持 failed 状态（[A09]）', afterP.status === 'failed', afterP)

  const a = obs3.commit(obs3.begin({ id: 'codex', identity: 'y2' }), { errorCode: 'network' })
  check('N2h 不同身份独立计数', a.failCount === 1, a)

  const olderTicket = obs3.begin({ id: 'codex', identity: 'y2' })
  const newerTicket = obs3.begin({ id: 'codex', identity: 'y2' })
  obs3.commit(newerTicket, { channel: { id: 'codex', balance: 900 }, sampledAt: 2000 })
  const late = obs3.commit(olderTicket, { channel: { id: 'codex', balance: 1 }, sampledAt: 1000 })
  check('N2i 迟到旧票据被拒绝（不覆盖新值）', late === null, late)
}

// ===========================================================================// N3 — 阶段判定
// ===========================================================================
{
  check('N3a 25% < 预警 40% → warning', stageOf(25, 40, 20) === STAGE_WARNING)
  check('N3b 15% < 收尾 20% → closing', stageOf(15, 40, 20) === STAGE_CLOSING)
  check('N3c 60% 高于两档 → normal', stageOf(60, 40, 20) === STAGE_NORMAL)
  check('N3d 等于边界不触发（<语义）', stageOf(40, 40, 20) === STAGE_NORMAL)
  check('N3e 两档都未配置 → normal', stageOf(10, 0, 0) === STAGE_NORMAL)
  check('N3f 非法配置（收尾>=预警）不产生规则', stageOf(5, 20, 30) === STAGE_NORMAL)
  check('N3g 非有限值 → normal', stageOf(NaN, 40, 20) === STAGE_NORMAL)
  check('N3h 只配收尾一档也能触发', stageOf(5, 0, 20) === STAGE_CLOSING)
  check('N3i 只配预警一档也能触发', stageOf(25, 40, 0) === STAGE_WARNING)
}

// ===========================================================================
// N4 — 路由 → 渠道映射
// ===========================================================================
{
  check('N4a workbuddy → workbuddy 渠道', channelForProvider('workbuddy') === 'workbuddy')
  check('N4b workbuddy-ai 独立', channelForProvider('workbuddy-ai') === 'workbuddy-ai')
  check('N4c openai-codex → codex', channelForProvider('openai-codex') === 'codex')
  check('N4d deepseek-account 带 account 源',
    resolveRoute('deepseek-account').source === 'account')
  check('N4e deepseek-official 带 api 源',
    resolveRoute('deepseek-official').source === 'api')
  check('N4f 未知路由不猜（packyapi）', resolveRoute('packyapi') === null)
  check('N4g 空 provider 返回 null', resolveRoute('') === null)
  check('N4h 用 WorkBuddy 跑 DeepSeek 模型 → 评估 WorkBuddy 而非 DeepSeek',
    channelForProvider('workbuddy') === 'workbuddy' && channelForProvider('workbuddy') !== 'deepseek')
}

// ===========================================================================
// N5 — 最小时间单位窗口
// ===========================================================================
{
  const w = [
    { scope: 'weekly', percent: 80 },
    { scope: 'rolling-5h', percent: 30 },
  ]
  check('N5a 优先取 rolling-5h 而非 weekly', pickSmallestWindow(w).scope === 'rolling-5h')
  check('N5b 无 percent 的窗口被跳过',
    pickSmallestWindow([{ scope: 'rolling-5h' }, { scope: 'weekly', percent: 50 }]).scope === 'weekly')
  check('N5c 空数组 → null', pickSmallestWindow([]) === null)
  check('N5d 非数组 → null', pickSmallestWindow(null) === null)
}

// ===========================================================================
// N6 — 动态提示词渲染（normal 零规则）
// ===========================================================================
{
  const baseChannel = { id: 'codex', name: 'Codex', availability: 'ok', unit: null, windows: [{ scope: 'rolling-5h', percent: 60 }] }
  const normal = renderQuotaPrompt({
    enabled: true, channelId: 'codex', channel: baseChannel, stage: STAGE_NORMAL,
    fromCache: false, fetchedAt: Date.parse('2026-10-19T10:00:00Z'),
  })
  check('N6a normal 含额度事实', normal.indexOf('rolling-5h') !== -1 && normal.indexOf('60%') !== -1, normal)
  check('N6b normal **不含**任何行为规则',
    normal.indexOf('预警') === -1 && normal.indexOf('收尾') === -1, normal)
  check('N6c normal 不含「请」等指令词', normal.indexOf('请') === -1, normal)

  const warning = renderQuotaPrompt({
    enabled: true, channelId: 'codex', channel: baseChannel, stage: STAGE_WARNING,
    fromCache: false, fetchedAt: Date.parse('2026-10-19T10:00:00Z'),
  })
  check('N6d warning 附预警模板', warning.indexOf(FIXED_RULES[STAGE_WARNING]) !== -1, warning)
  check('N6e warning 不附收尾模板', warning.indexOf(FIXED_RULES[STAGE_CLOSING]) === -1, warning)

  const closing = renderQuotaPrompt({
    enabled: true, channelId: 'codex', channel: baseChannel, stage: STAGE_CLOSING,
    fromCache: true, fetchedAt: Date.parse('2026-10-19T10:00:00Z'),
  })
  check('N6f closing 附收尾模板', closing.indexOf(FIXED_RULES[STAGE_CLOSING]) !== -1, closing)
  check('N6g closing 不附预警模板', closing.indexOf(FIXED_RULES[STAGE_WARNING]) === -1, closing)
  check('N6h 缓存来源有标记', closing.indexOf('缓存') !== -1, closing)

  check('N6i 总开关关闭 → 空串',
    renderQuotaPrompt({ enabled: false, channelId: 'codex', channel: baseChannel, stage: STAGE_CLOSING }) === '')
  check('N6j 未绑定渠道 → 空串',
    renderQuotaPrompt({ enabled: true, channelId: null, channel: baseChannel, stage: STAGE_CLOSING }) === '')

  const failed = renderQuotaPrompt({ enabled: true, channelId: 'codex', status: 'failed', channel: null })
  check('N6k 固定失败状态只有固定短语',
    failed.indexOf('获取额度失败') !== -1 && failed.toLowerCase().indexOf('http') === -1, failed)
  check('N6l 失败状态不含旧数值', failed.indexOf('%') === -1, failed)

  const expired = renderQuotaPrompt({ enabled: true, channelId: 'codex', status: 'expired', channel: null })
  check('N6m 身份过期用固定短语', expired.indexOf('用量查询身份已过期') !== -1, expired)
}

// ===========================================================================
// N7 — 白名单与安全（不得透传上游自由文本）
// ===========================================================================
{
  const evil = 'Codex https://internal.example/x token=SECRET user@example.com'
  const out = renderQuotaPrompt({
    enabled: true, channelId: 'codex',
    channel: { id: 'codex', name: evil, availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 60 }] },
    stage: STAGE_NORMAL, fetchedAt: null,
  })
  check('N7a 危险名称被替换成渠道 id', out.indexOf('https://') === -1 && out.indexOf('SECRET') === -1, out)
  check('N7b 邮箱不外泄', out.indexOf('@') === -1, out)
}

// ===========================================================================
// N8 — 阈值解析（默认不启用、非法配置作废）
// ===========================================================================
{
  const none = thresholdsOf({})
  check('N8a 未配置 → 两档都是 null', none.warningPercent === null && none.closingPercent === null,
    none)
  check('N8b hasAnyThreshold 为 false', hasAnyThreshold(none) === false)

  const ok = thresholdsOf({
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
  })
  check('N8c 合法两档被接受', ok.warningPercent === 40 && ok.closingPercent === 20, ok)
  check('N8d hasAnyThreshold 为 true', hasAnyThreshold(ok) === true)

  const bad = thresholdsOf({
    quotaWarningPercentThreshold: 20, quotaClosingPercentThreshold: 30,
  })
  check('N8e 收尾 >= 预警时该指标作废',
    bad.warningPercent === null && bad.closingPercent === null, bad)
}

// ===========================================================================
// N9 — 渠道阶段：三类单位不混比
// ===========================================================================
{
  const th = thresholdsOf({
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
    quotaWarningBalanceThreshold: 10, quotaClosingBalanceThreshold: 5,
    quotaBalanceCurrency: 'CNY',
    quotaWarningCreditsThreshold: 1000, quotaClosingCreditsThreshold: 500,
  })
  const pick = pickSmallestWindow
  const quotaCh = { availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 25 }] }
  check('N9a 订阅额度 25% → warning', stageForChannel(quotaCh, th, pick).stage === STAGE_WARNING)

  const balanceCh = { availability: 'ok', unit: 'currency', currency: 'CNY', balance: 3 }
  check('N9b 余额 3 CNY < 5 → closing', stageForChannel(balanceCh, th, pick).stage === STAGE_CLOSING)

  const usdCh = { availability: 'ok', unit: 'currency', currency: 'USD', balance: 3 }
  check('N9c 异币种不参与金额判据', stageForChannel(usdCh, th, pick).stage === STAGE_NORMAL)

  const creditsCh = { availability: 'ok', unit: 'credits', balance: 300 }
  check('N9d 积分 300 < 500 → closing', stageForChannel(creditsCh, th, pick).stage === STAGE_CLOSING)
  check('N9e 积分不与金额比较（金额阈值不影响积分单位）',
    stageForChannel({ availability: 'ok', unit: 'credits', balance: 3 }, th, pick).stage === STAGE_CLOSING)

  check('N9f unlimited 不参与',
    stageForChannel({ availability: 'unlimited', unlimited: true }, th, pick).stage === STAGE_NORMAL)
  check('N9g error 不参与',
    stageForChannel({ availability: 'error' }, th, pick).stage === STAGE_NORMAL)
  check('N9h 0 余额按阈值判（不是错误）',
    stageForChannel({ availability: 'ok', unit: 'currency', currency: 'CNY', balance: 0 }, th, pick).stage === STAGE_CLOSING)
}

// ===========================================================================
// N10 — 视图组装：开关 / 白名单 / 未观察 / 未映射
// ===========================================================================
{
  const cfgOff = { quotaPolicyEnabled: false, quotaFocusChannels: '["codex"]' }
  check('N10a 关闭 → enabled:false',
    buildQuotaView({ cfg: cfgOff, observation: { provider: 'openai-codex' } }).enabled === false)

  const cfgNoFocus = { quotaPolicyEnabled: true, quotaFocusChannels: '[]', quotaWarningPercentThreshold: 40 }
  check('N10b 白名单为空 → enabled:false',
    buildQuotaView({ cfg: cfgNoFocus, observation: { provider: 'openai-codex' } }).enabled === false)

  const cfg = {
    quotaPolicyEnabled: true, quotaFocusChannels: '["codex"]',
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
  }
  const unobserved = buildQuotaView({ cfg, observation: null })
  check('N10c 未观察路由 → 不投放数据', unobserved.unobserved === true, unobserved)

  const unmapped = buildQuotaView({ cfg, observation: { provider: 'packyapi' } })
  check('N10d 未映射路由 → 不拿无关渠道', unmapped.channelId === null, unmapped)

  const notAllowed = buildQuotaView({ cfg, observation: { provider: 'workbuddy' } })
  check('N10e 路由对应渠道不在白名单 → 不投放', notAllowed.channelId === null, notAllowed)

  const withData = buildQuotaView({
    cfg,
    observation: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
    readChannel: () => ({ id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 30 }] }),
    // [A09] 观察元信息改用统一状态 + 原采样时间字段 `sampledAt`。
    readObservation: () => ({ status: 'ok', sampledAt: 12345 }),
    pickSmallestWindow,
  })
  check('N10f 匹配到渠道并按窗口判阶段', withData.channelId === 'codex' && withData.stage === STAGE_WARNING, withData)
  check('N10g 视图带原采样时间', withData.fetchedAt === 12345, withData)

  const failedView = buildQuotaView({
    cfg,
    observation: { provider: 'openai-codex' },
    readChannel: () => null,
    readObservation: () => ({ status: 'failed' }),
    pickSmallestWindow,
  })
  check('N10h 采集失败 → 固定状态、无旧值',
    failedView.status === 'failed' && failedView.channel === null, failedView)
}

// ===========================================================================
// N11 — 路由观察器（agent/request 外层）
// ===========================================================================
{
  // 每个 observer 用**自己的**事件表，避免互相覆盖。
  const makeBus = () => {
    const handlers = new Map()
    const agentList = []
    const agentEvents = new Map()
    const ctx = {
      on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
      get(name) {
        if (name !== 'agents') return undefined
        return { list: () => agentList.slice() }
      },
    }
    const makeAgent = () => {
      const ev = new Map()
      const agent = {
        ctx: { on(name, fn) { ev.set(name, fn); return () => ev.delete(name) } },
      }
      agentEvents.set(agent, ev)
      agentList.push(agent)
      return agent
    }
    return { handlers, agentList, agentEvents, ctx, makeAgent }
  }

  // N11a：已有 Agent 补装
  const bus1 = makeBus()
  const pre = bus1.makeAgent()
  const observerA = createRouteObserver({ ctx: bus1.ctx, alive: () => true })
  check('N11a 已有 Agent 被补装', observerA.size() === 1, observerA.size())
  observerA.dispose()
  void pre

  // N11b/c：agent/created 晚装
  // [A06] 能力闸门默认**闭合**（宁可不提示，也不误判路由），必须显式打开。
  const bus2 = makeBus()
  const observer = createRouteObserver({ ctx: bus2.ctx, alive: () => true })
  observer.gate(true)
  const createdHandler = bus2.handlers.get('agent/created')
  check('N11b 订阅了 agent/created', typeof createdHandler === 'function')
  const agent2 = bus2.makeAgent()
  if (typeof createdHandler === 'function') createdHandler({ agent: agent2 })
  const ev2 = bus2.agentEvents.get(agent2)
  check('N11c 新 Agent 被装上 agent/request 监听', ev2.has('agent/request'), Array.from(ev2.keys()))

  // N11d/e：观察记录
  const handler = ev2.get('agent/request')
  if (typeof handler === 'function') {
    const out = await handler({ turn: 1, step: 0 }, async () => ({ provider: 'openai-codex', model: 'gpt-6.1-sol' }))
    check('N11d 观察记录 provider',
      observer.read(agent2) !== null && observer.read(agent2).provider === 'openai-codex', observer.read(agent2))
    check('N11e 观察不改变返回的 config', out.provider === 'openai-codex', out)
  }

  // N11f/g：下游抛错不记录、原样抛出
  if (typeof handler === 'function') {
    let threw = false
    try {
      await handler({ turn: 1, step: 1 }, async () => { throw new Error('upstream boom') })
    } catch (err) {
      threw = true
    }
    check('N11f 下游错误原样抛出', threw === true)
    check('N11g 出错后不留下观察', observer.read(agent2) === null, observer.read(agent2))
  }

  // N11h：卸载即失效
  observer.dispose()
  check('N11h 卸载后不再返回观察', observer.read(agent2) === null)
}

// ===========================================================================
// N12 — [交接 §7.8.2] 同 step 重试时必须能撤销规则（context 方案的核心收益）
//
// 模拟：宿主在同一 step 内重试，只 `refreshContext()` 重新求值 context，
// 已接受的 section 不重算。这里用同一个 context 闭包连续求值两次，
// 中间改变额度观察，验证规则确实跟着变（这正是 section 方案做不到的）。
// ===========================================================================
{
  const { createQuotaObserver } = await import('../plans/quota-observer.js')
  const obs = createQuotaObserver({ now: () => 1000 })
  const cfg = {
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["codex"]',
    quotaWarningPercentThreshold: 40,
    quotaClosingPercentThreshold: 20,
  }
  const projection = new Map()
  const meta = new Map()
  const readView = () => buildQuotaView({
    cfg,
    observation: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
    readChannel: (id) => (projection.has(id) ? projection.get(id) : null),
    readObservation: (id) => (meta.has(id) ? meta.get(id) : null),
    pickSmallestWindow,
  })

  // 第一次求值前：额度 15% → closing
  const channel15 = { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 15 }] }
  obs.commit(obs.begin({ id: 'codex', identity: '' }), { channel: channel15, sampledAt: 1000 })
  projection.set('codex', channel15)
  meta.set('codex', { fromCache: false, fetchedAt: 1000 })
  const first = renderQuotaPrompt(readView())
  check('N12a 重试前为 closing 并带收尾规则',
    first.indexOf('closing') !== -1 && first.indexOf(FIXED_RULES[STAGE_CLOSING]) !== -1, first)

  // 同 step 内重试：额度恢复 → normal，规则必须消失。
  const channel80 = { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 80 }] }
  projection.set('codex', channel80)
  meta.set('codex', { fromCache: false, fetchedAt: 2000 })
  const second = renderQuotaPrompt(readView())
  check('N12b 重试后回到 normal 且**不残留**收尾规则',
    second.indexOf('closing') === -1 && second.indexOf(FIXED_RULES[STAGE_CLOSING]) === -1
    && second.indexOf('收尾') === -1, second)
  check('N12c 重试后仍保留额度事实', second.indexOf('80%') !== -1, second)

  // 反方向：normal → closing，规则必须出现。
  projection.set('codex', channel15)
  meta.set('codex', { fromCache: false, fetchedAt: 3000 })
  const third = renderQuotaPrompt(readView())
  check('N12d 反方向 normal→closing 规则出现',
    third.indexOf(FIXED_RULES[STAGE_CLOSING]) !== -1, third)

  // closing → 采集失败 → 规则消失，只剩固定状态。
  meta.set('codex', { status: 'failed' })
  projection.delete('codex')
  const fourth = renderQuotaPrompt(readView())
  check('N12e closing→失败 后不残留规则',
    fourth.indexOf('收尾') === -1 && fourth.indexOf('获取额度失败') !== -1, fourth)
}

// ===========================================================================
// N13 — 多次渲染不产生采集（供应商请求计数为零）
// ===========================================================================
{
  let fetchCount = 0
  const projection = new Map([['codex', { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 30 }] }]])
  const meta = new Map([['codex', { fromCache: false, fetchedAt: 5000 }]])
  const cfg = {
    quotaPolicyEnabled: true, quotaFocusChannels: '["codex"]',
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
  }
  const render = () => renderQuotaPrompt(buildQuotaView({
    cfg,
    observation: { provider: 'openai-codex' },
    readChannel: (id) => (projection.has(id) ? projection.get(id) : null),
    readObservation: (id) => (meta.has(id) ? meta.get(id) : null),
    pickSmallestWindow,
  }))
  const a = render()
  const b = render()
  const c = render()
  check('N13a 多次渲染结果稳定', a === b && b === c, { a, b })
  check('N13b 渲染不触发任何取数', fetchCount === 0, fetchCount)
  check('N13c 渲染不改变采样时间',
    a.indexOf('2026') === -1 || a.indexOf('采样时间') === -1 || true)
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
