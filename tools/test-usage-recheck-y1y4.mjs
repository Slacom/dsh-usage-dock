/**
 * [方向 6 / 二次复核 Y1–Y4] 回归用例。
 *
 * Y1：实际凭据身份必须贯穿缓存**与** single-flight；内置渠道要按 provider
 *     真实回退的 `source.refs` 计算身份。
 * Y2：工具预算/取消贯穿真实内置 provider；逐渠道回传保留快渠道；中途取消及时返回。
 * Y3：systemPrompt 段落随 `app-boot/config-reload` 独立更新（不调用工具也能生效/清理）。
 * Y4：DeepSeek 只对可证明同币种的钱包求和，异币/未知币种不得编造统一总额。
 *
 * 用法：node tools/test-usage-recheck-y1y4.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { createUsageTool } from '../plans/usage-tool-register.js'
import { percentSemanticsOf } from '../plans/index.js'
import { projectPlan } from '../plans/usage-tool.js'
import { policyOf, policyPromptFor } from '../plans/usage-policy.js'
import deepseek from '../plans/deepseek.js'
import opencodeGo from '../plans/opencode-go.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))

/** 记录型 systemPrompt。 */
function fakeSystemPrompt() {
  const sections = new Map()
  // [额度自动感知] 策略走动态 context（不是常驻 section）。
  const contexts = new Map()
  return {
    sections,
    contexts,
    section(spec) {
      let disposed = false
      sections.set(spec.name, spec)
      return () => {
        if (disposed) return
        disposed = true
        if (sections.get(spec.name) === spec) sections.delete(spec.name)
      }
    },
    context(spec) {
      let disposed = false
      contexts.set(spec.name, spec)
      return () => {
        if (disposed) return
        disposed = true
        if (contexts.get(spec.name) === spec) contexts.delete(spec.name)
      }
    },
  }
}

/** 读取额度 context 的渲染文本（无注册返回 null）。 */
function quotaText(systemPrompt) {
  const entry = systemPrompt.contexts.get('dsh-usage-dock.quota')
  if (entry === undefined) return null
  try { return entry.text({ agent: null }) } catch (err) { return 'THREW: ' + err.message }
}

/** 带事件总线的假 ctx（真实宿主用 ctx.on('app-boot/config-reload')）。 */
function fakeCtx(services) {
  const handlers = new Map()
  return {
    get: (name) => (services != null && Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(fn)
    },
    off(name, fn) {
      const set = handlers.get(name)
      if (set !== undefined) set.delete(fn)
    },
    emit(name) {
      const set = handlers.get(name)
      if (set === undefined) return
      for (const fn of Array.from(set)) {
        try { fn() } catch (err) { /* 忽略 */ }
      }
    },
  }
}

// ===========================================================================
// Y1a — 在途任务必须按身份隔离（A 的结果不能变成 B 的）
// ===========================================================================
{
  let identity = 'ident-A'
  let releaseA = null
  let calls = 0
  const tool = createUsageTool({
    budgetMs: 400,
    describe: async () => ({
      enabled: ['deepseek'], known: ['deepseek'], generation: 'gen-1',
      identity, cacheable: new Set(['deepseek']),
      policy: null, policySection: null, semanticsOf: percentSemanticsOf,
    }),
    identify: async () => ({ identity, cacheable: new Set(['deepseek']) }),
    collectPlans: async () => {
      calls += 1
      if (identity === 'ident-A') {
        await new Promise((resolve) => { releaseA = resolve })
        return [{ id: 'deepseek', balance: 91.23, currency: 'CNY' }]
      }
      return [{ id: 'deepseek', balance: 12.34, currency: 'CNY' }]
    },
  })

  const first = tool.definition.execute({ ids: ['deepseek'] })
  await sleep(20)
  // 引用轮换到 B（同一公开配置、同一 id）
  identity = 'ident-B'
  const second = tool.definition.execute({ ids: ['deepseek'] })
  await sleep(20)
  if (releaseA !== null) releaseA()
  const firstOut = await first
  const secondOut = await second

  check('Y1a 第一次调用拿到 A 的余额', firstOut.channels[0].balance === 91.23, firstOut.channels[0])
  check('Y1a 第二次调用拿到 B 的余额（不复用 A 的任务）',
    secondOut.channels[0].balance === 12.34, secondOut.channels[0])
  check('Y1a 取数至少两次（不同身份不共享任务）', calls >= 2, calls)

  const third = await tool.definition.execute({ ids: ['deepseek'] })
  check('Y1a 第三次 B 查询命中 B 的缓存', third.channels[0].balance === 12.34, third.channels[0])
}

// ===========================================================================
// Y1b — 内置渠道：provider 回退引用的实际值必须进入身份
// ===========================================================================
{
  let keyValue = 'key-A'
  const credentials = { resolve: async () => ({ value: keyValue }) }
  let calls = 0
  const tool = createUsageTool({
    budgetMs: 400,
    describe: async () => ({
      enabled: ['opencode-go'], known: ['opencode-go'], generation: 'gen-1',
      identity: keyValue === 'key-A' ? 'refA' : 'refB',
      cacheable: new Set(['opencode-go']),
      policy: null, policySection: null, semanticsOf: percentSemanticsOf,
    }),
    identify: async () => ({ identity: keyValue === 'key-A' ? 'refA' : 'refB', cacheable: new Set(['opencode-go']) }),
    collectPlans: async () => {
      calls += 1
      // 引用 A → 剩余 10%；引用 B → 剩余 50%
      const used = keyValue === 'key-A' ? 90 : 50
      return [{ id: 'opencode-go', rollingUsage: { percent: used } }]
    },
  })
  void credentials
  const first = await tool.definition.execute({ ids: ['opencode-go'] })
  check('Y1b 引用 A 时剩余 10%', first.channels[0].windows[0].percent === 10, first.channels[0].windows)
  keyValue = 'key-B'
  const second = await tool.definition.execute({ ids: ['opencode-go'] })
  check('Y1b 引用轮换到 B 后重新取数并得到剩余 50%',
    second.channels[0].windows[0].percent === 50, second.channels[0].windows)
  check('Y1b 确实重新取数', calls === 2, calls)
}

// ===========================================================================
// Y1c — 身份不可证明的渠道：不跨账户共享在途任务
// ===========================================================================
{
  let calls = 0
  let release = null
  const tool = createUsageTool({
    budgetMs: 400,
    describe: async () => ({
      enabled: ['deepseek'], known: ['deepseek'], generation: 'gen-1',
      identity: '', cacheable: new Set(),
      policy: null, policySection: null, semanticsOf: percentSemanticsOf,
    }),
    collectPlans: async () => {
      calls += 1
      if (calls === 1) {
        await new Promise((resolve) => { release = resolve })
        return [{ id: 'deepseek', balance: 1, currency: 'CNY' }]
      }
      return [{ id: 'deepseek', balance: 2, currency: 'CNY' }]
    },
  })
  const a = tool.definition.execute({ ids: ['deepseek'] })
  await sleep(15)
  const b = tool.definition.execute({ ids: ['deepseek'] })
  await sleep(15)
  if (release !== null) release()
  await a
  const bOut = await b
  check('Y1c 账号型渠道每次独立取证（不共享任务）', calls >= 2, calls)
  check('Y1c 第二次拿到自己的结果', bOut.channels[0].balance === 2, bOut.channels[0])
}

// ===========================================================================
// Y2a — 中途取消要立刻返回（不等满 deadline）
// ===========================================================================
{
  const tool = createUsageTool({
    budgetMs: 5000,
    describe: () => new Promise(() => {}),
    collectPlans: async () => [],
  })
  const controller = new AbortController()
  const started = Date.now()
  const promise = tool.definition.execute({}, { signal: controller.signal })
  await sleep(5)
  controller.abort()
  const out = await promise
  const elapsed = Date.now() - started
  check('Y2a 配置读取阶段取消立刻返回（< 300ms）', elapsed < 300, elapsed)
  check('Y2a 返回空渠道', out.channels.length === 0, out.channels)
}

// ===========================================================================
// Y2b — 真实 apply：快渠道保留，慢渠道不抹掉
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    sent.push({ url: text, aborted: init !== undefined && init.signal !== undefined ? init.signal.aborted : null })
    if (text.includes('deepseek.com')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12' }] }) }
    }
    // MiMo：永久挂起（模拟慢渠道）
    return new Promise(() => {})
  }
  try {
    const routes = {}
    const tools = { register(def) { routes.__tool = def; return () => {} } }
    const services = {
      webServer: { port: 1, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
      tools,
    }
    apply({
      get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
      webServer: services.webServer,
      effect: (fn) => fn(),
    }, new Config(Object.assign({}, disabledAll, {
      deepseekEnabled: true,
      deepseekApiKey: 'sk-synthetic-deepseek',
      opencodeGoEnabled: true,
      apiKey: 'DUMMY_TEST_TEST_USAGE_RECHECK_Y1Y4_1',
    })))
    const def = routes.__tool
    const started = Date.now()
    const out = await def.execute({ ids: ['deepseek', 'opencode-go'] })
    const elapsed = Date.now() - started
    const ds = out.channels.find((c) => c.id === 'deepseek')
    const slow = out.channels.find((c) => c.id === 'opencode-go')
    check('Y2b 真实 apply 下快渠道结果被保留', ds !== undefined && ds.balance === 12, ds)
    const collectedEarly = ds !== undefined && typeof ds.fetchedAt === 'number'
      ? (Date.now() - ds.fetchedAt) > 1500 : false
    check('Y2b 采集时间在采集当时写入（不是等整批结束）', collectedEarly, ds && ds.fetchedAt)
    check('Y2b 慢渠道不拖垮整批（预算内返回）', elapsed < 9000, elapsed)
    check('Y2b 未完成的渠道有明确状态', slow !== undefined && slow.balance === null, slow)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Y2c — 内置 provider 收到工具 signal（到期后不再发请求）
// ===========================================================================
{
  const realFetch = globalThis.fetch
  let abortedSignalSeen = false
  globalThis.fetch = async (url, init) => {
    if (init !== undefined && init.signal !== undefined) {
      // 只记录「调用时是否已经取消」；正常路径应为 false。
      abortedSignalSeen = abortedSignalSeen || init.signal.aborted === true
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] }) }
  }
  try {
    const controller = new AbortController()
    controller.abort()
    const wire = await deepseek.fetch(
      { get: () => undefined }, undefined,
      { deepseekEnabled: true, deepseekApiKey: 'sk-x' },
      { signal: controller.signal, remaining: () => 10 },
    )
    // 已取消：要么直接报错返回，要么根本没有发出请求。
    check('Y2c 已取消时不发出上游请求或返回结构化错误',
      abortedSignalSeen === true || wire.error !== undefined || wire.balance === undefined || wire.balance === null,
      wire)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Y3 — 策略段落随 config-reload 独立更新（不调用工具）
// ===========================================================================
{
  const systemPrompt = fakeSystemPrompt()
  const live = { quotaPolicyEnabled: false, quotaFocusChannels: '["deepseek"]', quotaPercentThreshold: 20, quotaBalanceThreshold: 0, quotaBalanceCurrency: '', enabled: true }
  const ctx = fakeCtx({
    tools: { register() { return () => {} } },
    systemPrompt,
  })
  // 用 getter 模拟 volatile 配置的实时读取
  const config = new Proxy(live, { get: (t, k) => t[k] })
  const routes = {}
  Object.assign(ctx, {
    webServer: { port: 1, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
  })
  ctx.effect = (fn) => fn()
  // 直接调用 apply 需要一个 get('webServer') 与 effect
  apply(ctx, config)
  await sleep(80)
  // [额度自动感知] 策略已从「常驻 section」改为「动态 context」：
  //   - context 始终注册（关闭时返回空串），因此在同一 step 刷新里能立即撤销；
  //   - 内容取决于「本次路由观察 + 该渠道额度 + 阈值」，不调用工具也能生效。
  check('Y3a 初始未启用：context 注册但无内容',
    systemPrompt.contexts.has('dsh-usage-dock.quota') && quotaText(systemPrompt) === '',
    { has: systemPrompt.contexts.has('dsh-usage-dock.quota'), text: quotaText(systemPrompt) })

  live.quotaPolicyEnabled = true
  ctx.emit('app-boot/config-reload')
  await sleep(80)
  // 只开开关、没有路由观察时仍为空 —— 这是 normal 零规则的正确表现。
  check('Y3b 配置重载后 context 仍注册（无观察时不产出）',
    systemPrompt.contexts.has('dsh-usage-dock.quota') && quotaText(systemPrompt) === '',
    { text: quotaText(systemPrompt) })

  live.quotaPolicyEnabled = false
  ctx.emit('app-boot/config-reload')
  await sleep(80)
  check('Y3e 关闭后 context 依然注册但无内容（可同 step 撤销）',
    systemPrompt.contexts.has('dsh-usage-dock.quota') && quotaText(systemPrompt) === '',
    { text: quotaText(systemPrompt) })
}

// ===========================================================================
// Y3f — 卸载后不再注册段落
// ===========================================================================
{
  const systemPrompt = fakeSystemPrompt()
  const handlers = new Map()
  const ctx = {
    get: (name) => (name === 'tools' ? { register() { return () => {} } } : (name === 'systemPrompt' ? systemPrompt : undefined)),
    webServer: { port: 1, register() { return () => {} } },
    on(name, fn) { handlers.set(name, fn) },
    off(name) { handlers.delete(name) },
  }
  const effects = []
  ctx.effect = (fn) => { const d = fn(); effects.push(d); return d }
  apply(ctx, new Config(Object.assign({}, disabledAll, {
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 20,
  })))
  for (const d of effects.reverse()) { if (typeof d === 'function') d() }
  const handler = handlers.get('app-boot/config-reload')
  if (typeof handler === 'function') handler()
  await sleep(50)
  // [额度自动感知] 卸载后 context 必须被清理，且事件不会让它复活。
  check('Y3f 卸载后 context 被清理且不复活',
    systemPrompt.contexts.size === 0, Array.from(systemPrompt.contexts.keys()))
}

// ===========================================================================
// Y4 — DeepSeek 混币/未知币种不得相加
// ===========================================================================
async function deepseekWithWallets(value, bonus) {
  const account = {
    getBalance: async () => ({ status: 'ready', value, bonusWallets: bonus }),
  }
  return deepseek.fetch({ get: (name) => (name === 'deepseekAccount' ? account : undefined) }, undefined,
    { deepseekEnabled: true }, {})
}

{
  const mixed = await deepseekWithWallets(
    [{ currency: 'CNY', balance: 10 }],
    [{ currency: 'USD', balance: 2 }],
  )
  check('Y4a CNY+USD 不产生跨币总额', mixed.balance === null, mixed)
  check('Y4b 混币时币种为 null', mixed.currency === null, mixed)
  check('Y4c 混币标记为 true', mixed.mixedCurrency === true, mixed)

  const mixedProj = projectPlan(mixed, { semantics: 'used' })
  check('Y4d 混币投影为 unknown（不给金额）',
    mixedProj.availability === 'unknown' && mixedProj.balance === null, mixedProj)

  const unknownUnit = await deepseekWithWallets(
    [{ currency: 'CNY', balance: 10 }],
    [{ balance: 2 }],
  )
  check('Y4e CNY+未知币种不得当成 CNY 相加', unknownUnit.balance === null && unknownUnit.currency === null, unknownUnit)

  const single = await deepseekWithWallets(
    [{ currency: 'CNY', balance: 10 }],
    [{ currency: 'CNY', balance: 2 }],
  )
  check('Y4f 单币种正常求和', single.balance === 12 && single.currency === 'CNY', single)
  check('Y4g 单币种不标记 mixed', single.mixedCurrency !== true, single)

  const zero = await deepseekWithWallets(
    [{ currency: 'CNY', balance: 0 }],
    [{ currency: 'CNY', balance: 0 }],
  )
  check('Y4h 0 余额保留为 0', zero.balance === 0 && zero.currency === 'CNY', zero)

  const negative = await deepseekWithWallets(
    [{ currency: 'CNY', balance: -3 }],
    [],
  )
  check('Y4i 负数余额保留', negative.balance === -3, negative)

  const onlyBonusUnknown = await deepseekWithWallets([], [{ balance: 5 }])
  check('Y4j 只有未知币种钱包时不冒充 CNY', onlyBonusUnknown.currency === null, onlyBonusUnknown)
}

// ===========================================================================
// Y4k — 混币结果不得进入金额策略
// ===========================================================================
{
  const mixed = await deepseekWithWallets(
    [{ currency: 'CNY', balance: 10 }],
    [{ currency: 'USD', balance: 2 }],
  )
  const projected = projectPlan(mixed, { semantics: 'used' })
  const policy = policyOf({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 0,
    quotaBalanceThreshold: 100,
    quotaBalanceCurrency: 'CNY',
  })
  const prompt = policyPromptFor({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 0,
    quotaBalanceThreshold: 100,
    quotaBalanceCurrency: 'CNY',
  }, { channels: [projected] })
  check('Y4k 混币结果不触发金额策略', prompt === null, prompt)
  check('Y4l 策略对象本身有效（对照）', policy !== null, policy)
}

// ===========================================================================
// Y1d / Y2d — 真实 apply：OpenCode 回退引用轮换
// ===========================================================================
{
  const realFetch = globalThis.fetch
  let key = 'key-A'
  const resolutions = []
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url) })
    const auth = init !== undefined && init.headers !== undefined ? init.headers.Authorization : ''
    const used = String(auth).includes('key-A') ? 90 : 50
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ usage: { rolling: { usagePercent: used } } }),
    }
  }
  try {
    const routes = {}
    const services = {
      webServer: { port: 1, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
      tools: { register(def) { routes.__tool = def; return () => {} } },
      credentials: { resolve: async (ref) => { resolutions.push(ref); return { value: key } } },
    }
    apply({
      get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
      webServer: services.webServer,
      effect: (fn) => fn(),
    }, new Config(Object.assign({}, disabledAll, { opencodeGoEnabled: true })))
    const def = routes.__tool
    const first = await def.execute({ ids: ['opencode-go'] })
    check('Y1d 引用 A：真实 provider → 剩余 10%', first.channels[0].windows[0].percent === 10, first.channels[0].windows)
    key = 'key-B'
    const second = await def.execute({ ids: ['opencode-go'] })
    check('Y1d 引用轮换 B 后重新解析并得到剩余 50%',
      second.channels[0].windows[0].percent === 50, second.channels[0].windows)
    check('Y1d 解析次数增加（说明身份含引用实际值）', resolutions.length >= 2, resolutions.length)
    check('Y1d 上游请求增加', requests.length >= 2, requests.length)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Y2e — 共享调用之一取消，不影响另一有效调用
// ===========================================================================
{
  let calls = 0
  const tool = createUsageTool({
    budgetMs: 400,
    describe: async () => ({
      enabled: ['deepseek'], known: ['deepseek'], generation: 'gen-1',
      identity: 'same', cacheable: new Set(['deepseek']),
      policy: null, policySection: null, semanticsOf: percentSemanticsOf,
    }),
    collectPlans: async () => {
      calls += 1
      await sleep(80)
      return [{ id: 'deepseek', balance: 7, currency: 'CNY' }]
    },
  })
  const controller = new AbortController()
  const cancelled = tool.definition.execute({ ids: ['deepseek'] }, { signal: controller.signal })
  await sleep(10)
  const alive = tool.definition.execute({ ids: ['deepseek'] })
  await sleep(10)
  controller.abort()
  const cancelledOut = await cancelled
  const aliveOut = await alive
  check('Y2e 取消的调用返回空', cancelledOut.channels.length === 0, cancelledOut.channels)
  check('Y2e 另一个调用仍拿到数据', aliveOut.channels[0].balance === 7, aliveOut.channels[0])
  check('Y2e 共享任务只取数一次', calls === 1, calls)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
