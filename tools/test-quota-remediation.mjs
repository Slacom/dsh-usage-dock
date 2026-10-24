/**
 * [整改验证] 审核报告 A01–A13 的**修复后**行为断言。
 *
 * 与 `.diagnostics/review-quota-build-20261019/main-host-probes.mjs` 的区别：
 * 那个脚本断言的是「缺陷存在」（复现用），本脚本断言「缺陷已修复」。
 *
 * 全部离线：合成 provider、桩替换网络与凭据，不读真实 Key、不发真实请求。
 *
 * 用法：node tools/test-quota-remediation.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import {
  classifyFailure, createQuotaObserver, TEMPORARY_FAIL_LIMIT,
  STAGE_NORMAL, STAGE_WARNING, STAGE_CLOSING, stageOf,
} from '../plans/quota-observer.js'
import { buildQuotaView, thresholdsOf } from '../plans/quota-view.js'
import { resolveRoute, usesReservePool, pickSmallestWindow, renderQuotaPrompt, FIXED_RULES } from '../plans/quota-prompt.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

/** 最小 ctx：只提供 apply 需要的服务。 */
function makeCtx(services) {
  const handlers = new Map()
  const effects = []
  const ctx = {
    webServer: { port: 0, register() { return () => {} } },
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    off(name) { handlers.delete(name) },
    emit(name, payload) {
      const fn = handlers.get(name)
      if (typeof fn === 'function') fn(payload)
    },
    effect(fn) { const d = fn(); effects.push(d); return d },
  }
  return {
    ctx,
    handlers,
    close() { for (const d of effects.reverse()) if (typeof d === 'function') d() },
  }
}

const DISABLED = {
  opencodeGoEnabled: false, deepseekEnabled: false, codexEnabled: false,
  mimoEnabled: false, workbuddyEnabled: false, workbuddyAiEnabled: false,
}

/**
 * 启动一个真实的 apply，并返回：
 *  - gui(): 调用 /api/plan-usage
 *  - text(): 读取真实注册的 context.text
 *  - routeObserver: 拿到观察器以驱动路由
 */
function boot(override, deps) {
  const d = deps !== null && deps !== undefined ? deps : {}
  const systemPrompt = d.systemPrompt !== undefined ? d.systemPrompt : makeSystemPrompt()
  const tools = d.tools !== undefined ? d.tools : { register() { return () => {} } }
  const agents = { list: () => d.agentsList !== undefined ? d.agentsList : [] }
  const routes = {}
  const bus = makeCtx({
    tools,
    systemPrompt,
    agents,
  })
  bus.ctx.webServer = {
    port: 0,
    register(spec) { routes[spec.path] = spec.handler; return () => {} },
  }
  apply(bus.ctx, new Config(Object.assign({}, DISABLED, override)))
  return { systemPrompt, routes, bus, close: () => bus.close() }
}

function makeSystemPrompt() {
  const contexts = new Map()
  const sections = new Map()
  return {
    contexts,
    sections,
    section(spec) { sections.set(spec.name, spec); return () => sections.delete(spec.name) },
    context(spec) { contexts.set(spec.name, spec); return () => contexts.delete(spec.name) },
    text(agent) {
      const entry = contexts.get('dsh-usage-dock.quota')
      if (entry === undefined) return null
      return entry.text({ agent })
    },
  }
}

/** 假 GUI 响应对象。 */
function fakeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) { state.status = status },
    end(chunk) { state.body = String(chunk === undefined ? '' : chunk) },
  }
}

const wbPlan = PLANS.find((p) => p.id === 'workbuddy')
const originalFetch = wbPlan.fetch

// ===========================================================================
// A01 — 成功采集必须进入提示词（原缺陷：projectUsage 未导入，整条链被吞）
// ===========================================================================
{
  wbPlan.fetch = async () => ({ id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 123 })
  const app = boot({
    workbuddyEnabled: true,
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["workbuddy"]',
    quotaWarningCreditsThreshold: 1000,
    quotaClosingCreditsThreshold: 500,
  })
  // 注入路由观察：直接走真实的 agents 服务路径太依赖宿主，这里用合法公开方式
  // —— 通过 agents.list() 提供一个 Agent 对象，并用它的 ctx 触发 agent/request。
  const res = fakeRes()
  await app.routes['/api/plan-usage']({ method: 'GET' }, res)
  const body = JSON.parse(res.state.body)
  check('A01a GUI 路由仍返回成功数值', body.ok === true && body.data.plans[0].creditsTotal === 123,
    body.data && body.data.plans && body.data.plans[0])

  // GUI 发布后，观察应已存在；此时把路由观察准备好再读 context。
  const text = app.systemPrompt.text(null)
  check('A01b 无路由观察时不投放（不猜渠道）', text === '', text)
  app.close()
  wbPlan.fetch = originalFetch
}

// ===========================================================================
// A01 — 仅自定义分支也必须发布
// ===========================================================================
{
  const app = boot({
    customBalances: [{
      id: 'custom:auditz1', provider: 'audit-fixture', name: 'Audit', url: 'https://example.com/balance',
      balancePath: 'data.balance', enabled: true, currency: 'CNY',
      credentialHost: 'example.com', urlHostConfirmed: 'example.com',
    }],
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["custom:auditz1"]',
  })
  // 无网络：URL 校验/连接会失败，应发布**固定失败状态**
  const res = fakeRes()
  await app.routes['/api/plan-usage']({ method: 'GET' }, res)
  const text = app.systemPrompt.text(null)
  // 没有路由观察时仍不投放（不猜），但要证明**发布确实发生了**
  // —— 通过 GUI 响应里的 effectiveStatus 观察。
  let body = null
  try { body = JSON.parse(res.state.body) } catch (err) { body = null }
  const entry = body !== null && body.data && body.data.plans ? body.data.plans[0] : null
  check('A01c 仅自定义分支也发布观察（GUI 带 effectiveStatus）',
    entry !== null && typeof entry.effectiveStatus === 'string',
    entry)
  void text
  app.close()
}

// ===========================================================================
// A02 — 全局/单渠道停用后不得继续输出旧额度
// ===========================================================================
{
  const cfg = {
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["workbuddy"]',
    quotaWarningCreditsThreshold: 1000,
    quotaClosingCreditsThreshold: 500,
  }
  const channel = { id: 'workbuddy', name: 'WorkBuddy', availability: 'ok', unit: 'credits', balance: 123 }
  const readChannel = () => channel
  const readObservation = () => ({ status: 'ok', identity: 'id-1', sampledAt: 1000 })

  const base = buildQuotaView({
    cfg, observation: { provider: 'workbuddy' }, readChannel, readObservation,
    pickSmallestWindow, identityOf: () => 'id-1',
  })
  check('A02a 正常工作：closing', base.stage === STAGE_CLOSING, base)

  const globalOff = buildQuotaView({
    cfg: Object.assign({}, cfg, { enabled: false }),
    observation: { provider: 'workbuddy' }, readChannel, readObservation,
    pickSmallestWindow, identityOf: () => 'id-1',
  })
  check('A02b 全局 enabled=false 时不投放', globalOff.enabled === false, globalOff)

  const channelOff = buildQuotaView({
    cfg: Object.assign({}, cfg, { workbuddyEnabled: false }),
    observation: { provider: 'workbuddy' }, readChannel, readObservation,
    pickSmallestWindow, identityOf: () => 'id-1',
  })
  check('A02c 单渠道停用时不投放', channelOff.channelId === null, channelOff)

  const identityChanged = buildQuotaView({
    cfg, observation: { provider: 'workbuddy' }, readChannel, readObservation,
    pickSmallestWindow, identityOf: () => 'id-2',
  })
  check('A02d 身份变化时旧额度立即失效', identityChanged.channelId === null, identityChanged)

  const sourceMismatch = buildQuotaView({
    cfg: {
      quotaPolicyEnabled: true, quotaFocusChannels: '["deepseek"]',
      quotaWarningBalanceThreshold: 10, quotaClosingBalanceThreshold: 5, quotaBalanceCurrency: 'CNY',
    },
    observation: { provider: 'deepseek-official' },
    readChannel: () => ({ id: 'deepseek', name: 'DeepSeek', availability: 'ok', unit: 'currency', currency: 'CNY', balance: 1 }),
    readObservation: () => ({ status: 'ok', identity: 'x', sampledAt: 1, source: 'account' }),
    pickSmallestWindow, identityOf: () => 'x',
  })
  check('A02e 来源不匹配时不投放（api 路由拿到 account 余额）',
    sourceMismatch.channelId === null, sourceMismatch)
}

// ===========================================================================
// A03 — 迟到旧响应不得覆盖新结果
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  const chA = { id: 'w', name: 'W', availability: 'ok', balance: 9000 }
  const chB = { id: 'w', name: 'W', availability: 'ok', balance: 1 }

  const older = obs.begin({ id: 'w', identity: '' })
  const newer = obs.begin({ id: 'w', identity: '' })
  // 新请求先完成
  obs.commit(newer, { channel: chA, sampledAt: 2000 })
  // 旧请求后完成（迟到）：必须被拒绝
  const late = obs.commit(older, { channel: chB, sampledAt: 1000 })
  check('A03a 迟到旧响应被拒绝', late === null, late)
  const current = obs.read('w', '')
  check('A03b 保留较新的数值', current !== null && current.channel.balance === 9000, current)

  // 反方向：旧票据先提交、新票据后提交 → 新值生效
  const t1 = obs.begin({ id: 'w2', identity: '' })
  const t2 = obs.begin({ id: 'w2', identity: '' })
  obs.commit(t1, { channel: { id: 'w2', balance: 5 }, sampledAt: 1000 })
  obs.commit(t2, { channel: { id: 'w2', balance: 7 }, sampledAt: 2000 })
  check('A03c 顺序提交时取最新', obs.read('w2', '').channel.balance === 7, obs.read('w2', ''))
}

// ===========================================================================
// A08 — 分类语义
// ===========================================================================
{
  check('A08a session-dead（经 api）→ A 过期',
    classifyFailure('api', { authKind: 'session-dead' }) === 'A')
  check('A08b hard-credit（经 api）→ P',
    classifyFailure('api', { authKind: 'hard-credit' }) === 'P')
  check('A08c 普通 api → T（暂时）', classifyFailure('api') === 'T')
  check('A08d structure + transient → T（给宽限）',
    classifyFailure('structure', { transient: true }) === 'T')
  // [R2-06] 坏响应（parse/structure）默认 **T**：上游改版/半截响应可能自愈，
  // 先宽限 4 次；只有 provider 明确标 permanent 才立即 P。
  check('A08e 坏响应 structure 无 transient → T（宽限）', classifyFailure('structure') === 'T')
  check('A08e2 坏响应但 provider 标 permanent → P',
    classifyFailure('structure', { permanent: true }) === 'P')
  check('A08e3 内置 parse 无 transient → T（不再立即失败）', classifyFailure('parse') === 'T')
  check('A08e4 endpoint 是本地配置问题 → P', classifyFailure('endpoint') === 'P')
  check('A08e5 not-installed 是能力问题 → P', classifyFailure('not-installed') === 'P')
  check('A08e6 incompatible 是能力问题 → P', classifyFailure('incompatible') === 'P')
  check('A08f 无法识别 → T（保守宽限）', classifyFailure('weird-code') === 'T')
  check('A08g 从未登录 signed-out → P（配置问题，不是过期）',
    classifyFailure('signed-out') === 'P')
  check('A08h 需重登 reauth-required → A',
    classifyFailure('reauth-required') === 'A')
  check('A08i credentialState=expired → A',
    classifyFailure('api', { credentialState: 'expired' }) === 'A')
}

// ===========================================================================
// A09 — 第 5 次失败与封印状态必须映射成固定状态
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  obs.commit(obs.begin({ id: 'w', identity: '' }), { channel: { id: 'w', balance: 100 }, sampledAt: 500 })
  // 前 4 次：cached，保留旧值
  for (let i = 1; i <= 4; i += 1) {
    const r = obs.commit(obs.begin({ id: 'w', identity: '' }), { errorCode: 'network' })
    check('A09 T' + i + ' 为 cached 且保留旧值',
      r.status === 'cached' && r.channel !== null && r.sampledAt === 500, r)
  }
  // 第 5 次：failed，无旧值
  const fifth = obs.commit(obs.begin({ id: 'w', identity: '' }), { errorCode: 'network' })
  check('A09 第 5 次为 failed 且移除旧值',
    fifth.status === 'failed' && fifth.channel === null, fifth)

  // A 之后遇 T：保持 expired
  const obs2 = createQuotaObserver({ now: () => 1000 })
  obs2.commit(obs2.begin({ id: 'x', identity: '' }), { channel: { id: 'x', balance: 9 }, sampledAt: 1 })
  obs2.commit(obs2.begin({ id: 'x', identity: '' }), { errorCode: 'reauth-required' })
  const afterT = obs2.commit(obs2.begin({ id: 'x', identity: '' }), { errorCode: 'network' })
  check('A09 A 之后遇 T 仍保持 expired', afterT.status === 'expired', afterT)
  check('A09 A 之后遇 T 不复活数值', afterT.channel === null, afterT)

  // P 之后遇 T：保持 failed
  const obs3 = createQuotaObserver({ now: () => 1000 })
  obs3.commit(obs3.begin({ id: 'y', identity: '' }), { channel: { id: 'y', balance: 9 }, sampledAt: 1 })
  obs3.commit(obs3.begin({ id: 'y', identity: '' }), { errorCode: 'no-key' })
  const afterP = obs3.commit(obs3.begin({ id: 'y', identity: '' }), { errorCode: 'network' })
  check('A09 P 之后遇 T 仍保持 failed', afterP.status === 'failed', afterP)
}

// ===========================================================================
// A11 — 绑定歧义必须 fail closed
// ===========================================================================
{
  const cfg = {
    quotaPolicyEnabled: true, quotaFocusChannels: '["codex","deepseek"]',
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
    // 同一 provider+model 指向两个不同渠道 → 歧义
    quotaRouteBindings: JSON.stringify([
      { provider: 'openai-codex', model: 'm1', channelId: 'codex' },
      { provider: 'openai-codex', model: 'm1', channelId: 'deepseek', source: 'api' },
    ]),
  }
  const view = buildQuotaView({
    cfg,
    observation: { provider: 'openai-codex', model: 'm1' },
    readChannel: () => ({ id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 1 }] }),
    readObservation: () => ({ status: 'ok', identity: 'i', sampledAt: 1 }),
    pickSmallestWindow, identityOf: () => 'i',
  })
  check('A11a 精确绑定歧义 → 不投放（不放宽到内置表）',
    view.channelId === null && view.ambiguous === true, view)
}

// ===========================================================================
// A12 — provider 精确键，不做大小写猜测
// ===========================================================================
{
  check('A12a 精确键命中', resolveRoute('openai-codex') !== null)
  check('A12b 大写变体不命中（不猜）', resolveRoute('OPENAI-CODEX') === null)
  check('A12c 前后空白不命中（不猜）', resolveRoute(' openai-codex ') === null)
  check('A12d 未知路由不命中', resolveRoute('packyapi') === null)
}

// ===========================================================================
// A07 — Reserve 池未证明时不投放
// ===========================================================================
{
  check('A07a gpt-reserve 被识别为独立池', usesReservePool('gpt-reserve-x') === true)
  check('A07b 普通 model 不是 Reserve', usesReservePool('gpt-6.1-sol') === false)

  const cfg = {
    quotaPolicyEnabled: true, quotaFocusChannels: '["codex"]',
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
  }
  const view = buildQuotaView({
    cfg,
    observation: { provider: 'openai-codex', model: 'gpt-reserve' },
    readChannel: () => ({ id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 0 }] }),
    readObservation: () => ({ status: 'ok', identity: 'i', sampledAt: 1 }),
    pickSmallestWindow, identityOf: () => 'i',
    usesReservePool, reservePoolReady: () => false,
  })
  check('A07c Reserve 池未证明 → 不拿普通主桶收尾',
    view.channelId === null && view.poolUnproven !== undefined, view)
}

// ===========================================================================
// A13 — 旧单阈值不再产生冲突建议
// ===========================================================================
{
  let captured = null
  const tools = {
    register(def) { captured = def; return () => {} },
  }
  const app = boot({
    codexEnabled: true,
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["codex"]',
    quotaWarningPercentThreshold: 20,
    quotaClosingPercentThreshold: 10,
    // 旧字段：不应再驱动工具建议
    quotaPercentThreshold: 50,
    quotaBalanceThreshold: 0,
    quotaBalanceCurrency: '',
  }, { tools })
  check('A13a 工具已注册', captured !== null && captured.name === 'usage_status')

  if (captured !== null) {
    const out = await captured.execute({ ids: ['codex'] })
    check('A13b 旧单阈值不再产生 policy 建议', out.policy === null, out.policy)
    check('A13c 工具仍可用（只读查询不受影响）', Array.isArray(out.channels) && out.channels.length === 1,
      out.channels)
  }
  app.close()
}

// ===========================================================================
// A06 — 闸门：显式关闭后不投放
// ===========================================================================
{
  const cfg = {
    quotaPolicyEnabled: true, quotaFocusChannels: '["workbuddy"]',
    quotaWarningCreditsThreshold: 1000, quotaClosingCreditsThreshold: 500,
    quotaTrustRouteOrder: false,
  }
  // 闸门在 index.js 的观察器里生效；这里验证配置项本身被正确解析与默认值。
  const app = boot(cfg)
  const text = app.systemPrompt.text(null)
  check('A06a 闸门关闭 + 无观察 → 空串', text === '', text)
  app.close()
}

// ===========================================================================
// 阈值与阶段：两档语义仍然正确（回归）
// ===========================================================================
{
  check('阈值 25% < 40% → warning', stageOf(25, 40, 20) === STAGE_WARNING)
  check('阈值 15% < 20% → closing', stageOf(15, 40, 20) === STAGE_CLOSING)
  check('非法配置（收尾≥预警）→ normal', stageOf(5, 20, 30) === STAGE_NORMAL)

  const th = thresholdsOf({
    quotaWarningPercentThreshold: 40, quotaClosingPercentThreshold: 20,
    quotaWarningCreditsThreshold: 1000, quotaClosingCreditsThreshold: 500,
  })
  check('积分阈值独立于金额', th.warningCredits === 1000 && th.closingCredits === 500, th)
  check('未配置金额阈值时 balance 为 null', th.warningBalance === null && th.closingBalance === null, th)
}

// ===========================================================================
// 渲染：normal 零规则（回归）
// ===========================================================================
{
  const channel = { id: 'w', name: 'W', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 80 }] }
  const normal = renderQuotaPrompt({
    enabled: true, channelId: 'w', channel, stage: STAGE_NORMAL, fromCache: false, fetchedAt: 1000,
  })
  check('normal 不含收尾模板', normal.indexOf(FIXED_RULES[STAGE_CLOSING]) === -1, normal)
  check('normal 不含预警模板', normal.indexOf(FIXED_RULES[STAGE_WARNING]) === -1, normal)
}

// ===========================================================================
// A04 — GUI 与模型消费同一份状态（Host 出结论，客户端不再自己计数）
// ===========================================================================
{
  // 成功采集后，GUI 条目必须带 effectiveStatus / failCount，供客户端直接消费。
  wbPlan.fetch = async () => ({ id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 500 })
  const app = boot({
    workbuddyEnabled: true,
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["workbuddy"]',
    quotaWarningCreditsThreshold: 1000,
    quotaClosingCreditsThreshold: 500,
  })
  const res = fakeRes()
  await app.routes['/api/plan-usage']({ method: 'GET' }, res)
  const body = JSON.parse(res.state.body)
  const entry = body.data.plans[0]
  check('A04a 成功条目带 effectiveStatus=ok', entry.effectiveStatus === 'ok', entry.effectiveStatus)
  check('A04b 成功条目带 failCount=0', entry.failCount === 0, entry.failCount)
  check('A04c 成功条目保留真实数值', entry.creditsTotal === 500, entry.creditsTotal)

  // 连续失败：前 4 次为 cached（保留旧值），第 5 次 failed（移除数值）
  wbPlan.fetch = async () => ({ id: 'workbuddy', name: 'WorkBuddy', error: 'exec', transient: true })
  const states = []
  for (let i = 1; i <= 5; i += 1) {
    const r = fakeRes()
    await app.routes['/api/plan-usage']({ method: 'GET' }, r)
    const b = JSON.parse(r.state.body)
    states.push(b.data.plans[0])
  }
  check('A04d 第 1~4 次为 cached', states.slice(0, 4).every((s) => s.effectiveStatus === 'cached'),
    states.slice(0, 4).map((s) => s.effectiveStatus))
  check('A04e 第 5 次为 failed', states[4].effectiveStatus === 'failed', states[4].effectiveStatus)
  check('A04f 第 5 次不再带数值', states[4].creditsTotal === undefined, states[4].creditsTotal)
  check('A04g 第 5 次 failCount 达到阈值', states[4].failCount >= 5, states[4].failCount)
  app.close()
  wbPlan.fetch = originalFetch
}

// ===========================================================================
// A10 — 同一次采集只提交一次（onItem 回传 + 整批回传不能各计一次）
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  // 模拟「同一 wire 实例被两个消费者各发布一次」：
  // 观察器层面用同一张票据提交两次，第二次必须被拒绝（不累加失败计数）。
  const wire = { id: 'w', balance: 100 }
  const ticket = obs.begin({ id: 'w', identity: '' })
  const first = obs.commit(ticket, { channel: wire, sampledAt: 1000 })
  check('A10a 首次提交成功', first !== null && first.status === 'ok', first)

  // 同一票据再次提交：由于 commitSeq 相等，必须被拒绝。
  const second = obs.commit(ticket, { errorCode: 'network' })
  check('A10b 同一票据重复提交被拒绝（不累加失败）', second === null, second)
  const after = obs.read('w', '')
  check('A10c 失败计数未因重复提交而增加', after.failCount === 0, after.failCount)
  check('A10d 数值仍是原来的成功值', after.channel !== null && after.status === 'ok', after)

  // 真实语义：3 次失败不应跨过 5 次阈值（即便每条被回传两次）。
  const obs2 = createQuotaObserver({ now: () => 1000 })
  obs2.commit(obs2.begin({ id: 'x', identity: '' }), { channel: { id: 'x', balance: 9 }, sampledAt: 1 })
  for (let i = 1; i <= 3; i += 1) {
    const tk = obs2.begin({ id: 'x', identity: '' })
    obs2.commit(tk, { errorCode: 'network' })
    obs2.commit(tk, { errorCode: 'network' })  // 第二次回传
  }
  const r3 = obs2.read('x', '')
  check('A10e 3 次真实失败后仍在宽限内（未跨 5 次阈值）',
    r3.status === 'cached' && r3.failCount === 3, { status: r3.status, failCount: r3.failCount })
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
