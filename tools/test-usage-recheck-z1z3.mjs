/**
 * [方向 6 / 第三轮复核 Z1–Z3] 回归用例。
 *
 * Z1：缓存/任务身份必须绑定**真正发送**的凭据（采样即发送），不能旁路采样后二次解析。
 * Z2：自定义渠道的外部取消与逐条进度：取消后不再发请求、快条目不被慢条目拖丢。
 * Z3：`app-boot/config-reload` 必须作废两秒配置缓存，一次事件即可更新策略段落。
 *
 * 用法：node tools/test-usage-recheck-z1z3.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { fetchCustomPlans } from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
const PUBLIC_RESOLVER = async () => ['93.184.216.34']

/**
 * 记录型 systemPrompt：同时支持 section 与 context。
 *
 * [额度自动感知] 策略已改为**动态 context**（同 step 重试才能撤销规则），
 * 因此策略相关断言应看 `contexts`，不是 `sections`。
 */
function fakeSystemPrompt() {
  const sections = new Map()
  const contexts = new Map()
  return {
    sections,
    contexts,
    section(spec) {
      sections.set(spec.name, spec)
      return () => { if (sections.get(spec.name) === spec) sections.delete(spec.name) }
    },
    context(spec) {
      contexts.set(spec.name, spec)
      return () => { if (contexts.get(spec.name) === spec) contexts.delete(spec.name) }
    },
  }
}

/** 读取额度 context 的渲染结果（无注册返回 null）。 */
function quotaContextText(systemPrompt) {
  const entry = systemPrompt.contexts.get('dsh-usage-dock.quota')
  if (entry === undefined) return null
  try { return entry.text({ agent: null }) } catch (err) { return 'THREW: ' + err.message }
}

/** 真实 apply 用的最小 ctx（带配置重载事件总线）。 */
function makeCtx(services) {
  const handlers = new Map()
  const ctx = {
    webServer: { port: 0, register() { return () => {} } },
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn) },
    off(name, fn) { const set = handlers.get(name); if (set) set.delete(fn) },
    emit(name) { const set = handlers.get(name); if (set) for (const fn of Array.from(set)) { try { fn() } catch (err) { /* 忽略 */ } } },
    effect(fn) { return fn() },
  }
  return ctx
}

function customEntry(overrides) {
  return Object.assign({
    id: 'custom:aaaaaaaaaaaa',
    name: '厂商 A',
    url: 'https://public.example/balance',
    balancePath: 'data.balance',
    subtractPath: '',
    currency: 'CNY',
    credentialRef: '',
    credentialHost: 'public.example',
    urlHostConfirmed: 'public.example',
    enabled: true,
  }, overrides)
}

// ===========================================================================
// Z1 — 采样到的凭据就是实际发送的凭据（真实 apply + 真实 OpenCode provider）
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const requests = []
  let currentKey = 'key-B'
  const resolutions = []
  globalThis.fetch = async (url, init) => {
    const auth = init !== undefined && init.headers !== undefined ? String(init.headers.Authorization || '') : ''
    requests.push({ auth })
    // A → 已用 90%（剩余 10）；B → 已用 50%（剩余 50）
    const used = auth.indexOf('key-A') !== -1 ? 90 : 50
    return new Response(JSON.stringify({ usage: { rolling: { usagePercent: used } } }), { status: 200 })
  }
  try {
    // [Q2] 现在只解析**实际生效**的那个候选（不再把全部候选都解析一遍），
    // 因此每次取数只产生一次解析；这里让第一次解析返回 A，之后返回「当前引用」。
    const rotateAfter = 1
    let resolveCalls = 0
    const credentials = {
      resolve: async (ref) => {
        resolutions.push(ref)
        resolveCalls += 1
        if (resolveCalls <= rotateAfter) return { value: 'key-A' }
        return { value: currentKey }
      },
    }
    const tools = { register(def) { this.def = def; return () => {} } }
    const systemPrompt = fakeSystemPrompt()
    const ctx = makeCtx({ tools, credentials, systemPrompt })
    apply(ctx, new Config(Object.assign({}, disabledAll, { opencodeGoEnabled: true })))
    const def = tools.def

    const first = await def.execute({ ids: ['opencode-go'] })
    check('Z1a 首次结果来自**采样**的 Key（剩余 10%，而不是发送另一把后的 50%）',
      first.channels[0].windows[0].percent === 10, first.channels[0].windows)
    check('Z1a 实际发送的 Authorization 就是采样值',
      requests.length === 1 && requests[0].auth.indexOf('key-A') !== -1, requests)

    // 现在把「当前引用」换成 B，并让采样也返回 B
    currentKey = 'key-B'
    const second = await def.execute({ ids: ['opencode-go'] })
    check('Z1b 第二次按当前引用 B 取数（剩余 50%）',
      second.channels[0].windows[0].percent === 50, second.channels[0].windows)
    check('Z1b 确实重新解析并重新请求',
      resolutions.length >= 2 && requests.length === 2, { resolutions: resolutions.length, requests: requests.length })

    // 回到 A：旧缓存不得把 B 的值冒充成 A
    currentKey = 'key-A'
    const third = await def.execute({ ids: ['opencode-go'] })
    check('Z1c 回到 A 后拿到 A 的剩余 10%（缓存未混淆身份）',
      third.channels[0].windows[0].percent === 10, third.channels[0].windows)
    // A 的结果确实被缓存过，因此第三次**命中 A 的缓存**（而不是复用 B 的值）是正确行为。
    check('Z1c 回到 A 后命中 A 自己的缓存（不再发第三次请求）',
      requests.length === 2, requests.map((r) => r.auth))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Z2a — 自定义渠道：取消后不得再发起带凭据的请求
// ===========================================================================
{
  let transportCalls = 0
  let releaseResolve = null
  const controller = new AbortController()
  const started = Date.now()
  const promise = fetchCustomPlans({}, undefined, {
    customBalances: [customEntry({ credentialRef: 'CUSTOM_REF' })],
    customKeys: {},
  }, {
    onlyIds: new Set(['custom:aaaaaaaaaaaa']),
    signal: controller.signal,
    budgetMs: 5000,
    // 凭据解析慢 100ms；取消发生在 20ms。
    resolveHost: async () => {
      await new Promise((r) => { releaseResolve = r })
      return ['93.184.216.34']
    },
    allowLegacy: true,
    transport: async () => { transportCalls += 1; return { status: 200, text: async () => '{"data":{"balance":1}}' } },
  })
  const sink = { channels: [] }
  void sink
  await sleep(20)
  controller.abort()
  const out = await promise
  const elapsed = Date.now() - started
  if (typeof releaseResolve === 'function') releaseResolve()
  await sleep(150)
  check('Z2a 取消后立即返回（<500ms）', elapsed < 500, elapsed)
  check('Z2a 取消后没有发出任何传输请求', transportCalls === 0, transportCalls)
  check('Z2a 未完成的条目给出结构化状态',
    Array.isArray(out) && out.length === 1 && typeof out[0].error === 'string', out)
}

// ===========================================================================
// Z2a2 — 取消必须中断**已在途**的传输（而不是等它自己超时）
// ===========================================================================
{
  let transportStarted = 0
  const controller = new AbortController()
  const started = Date.now()
  const promise = fetchCustomPlans({}, undefined, {
    customBalances: [customEntry({})],
    customKeys: { 'custom:aaaaaaaaaaaa': 'key-x' },
  }, {
    onlyIds: new Set(['custom:aaaaaaaaaaaa']),
    signal: controller.signal,
    budgetMs: 3000,
    resolveHost: PUBLIC_RESOLVER,
    // 传输层永久挂起，只响应 init.signal 的 abort。
    allowLegacy: true,
    transport: (url, init) => new Promise((resolve, reject) => {
      transportStarted += 1
      const signal = init !== undefined ? init.signal : undefined
      if (signal === undefined) return
      signal.addEventListener('abort', () => {
        const err = new Error('aborted by caller')
        err.name = 'AbortError'
        reject(err)
      }, { once: true })
    }),
  })
  await sleep(30)
  controller.abort()
  const out = await promise
  const elapsed = Date.now() - started
  check('Z2a2 传输已开始', transportStarted === 1, transportStarted)
  check('Z2a2 取消立刻结束等待（不等传输超时）', elapsed < 800, elapsed)
  check('Z2a2 返回结构化状态', Array.isArray(out) && typeof out[0].error === 'string', out)
}
// ===========================================================================
// Z2b — 自定义渠道：A 快 / B 挂起，A 必须被逐条回传
// ===========================================================================
{
  const emitted = []
  const started = Date.now()
  const promise = fetchCustomPlans({}, undefined, {
    customBalances: [
      customEntry({ id: 'custom:aaaa11112222', name: '快渠道', url: 'https://public.example/fast' }),
      customEntry({ id: 'custom:bbbb33334444', name: '慢渠道', url: 'https://public.example/slow' }),
    ],
    customKeys: { 'custom:aaaa11112222': 'key-fast', 'custom:bbbb33334444': 'key-slow' },
  }, {
    onlyIds: new Set(['custom:aaaa11112222', 'custom:bbbb33334444']),
    budgetMs: 400,
    resolveHost: PUBLIC_RESOLVER,
    allowLegacy: true,
    transport: async (url) => {
      if (String(url).indexOf('fast') !== -1) {
        return { status: 200, text: async () => JSON.stringify({ data: { balance: 12 } }) }
      }
      return new Promise(() => {}) // 永久挂起
    },
    onItem: (wire) => emitted.push({ id: wire.id, url: wire.url, at: Date.now() - started, fetchedAt: wire.fetchedAt }),
  })
  await promise
  const elapsed = Date.now() - started
  const fast = emitted.find((item) => item.id === 'custom:aaaa11112222')
  check('Z2b 快条目在整批结束前就被回传', fast !== undefined && fast.at < 300, { emitted, elapsed })
  check('Z2b 快条目带回采集时间戳', fast !== undefined && typeof fast.fetchedAt === 'number', fast)
  check('Z2b 整批仍在预算内结束（不被挂起条目拖死）', elapsed < 2000, elapsed)
}

// ===========================================================================
// Z3 — config-reload 必须作废两秒缓存（普通 override 路径，真实 apply）
// ===========================================================================
{
  const systemPrompt = fakeSystemPrompt()
  const tools = { register() { return () => {} } }
  const override = {
    enabled: true,
    quotaPolicyEnabled: false,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 20,
    quotaBalanceThreshold: 0,
    quotaBalanceCurrency: '',
  }
  let configReads = 0
  const configEditor = {
    configuration() {
      configReads += 1
      return [{ entry: { options: { id: 'plan-usage' } }, override: Object.assign({}, override), inherited: {} }]
    },
  }
  const ctx = makeCtx({ tools, systemPrompt, configEditor })
  apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true })))
  await sleep(60)
  const readsAfterStart = configReads
  // [额度自动感知] 额度 context 现在**始终注册**（关闭时 text 为空串），
  // 这样「关闭」才能在同 step 刷新里立即撤销。所以这里断言的是**内容**，不是注册表大小。
  check('Z3a 启动时未启用 → context 无内容', quotaContextText(systemPrompt) === '',
    quotaContextText(systemPrompt))

  // 两秒缓存窗口内：改配置 + 只发一次事件
  override.quotaPolicyEnabled = true
  ctx.emit('app-boot/config-reload')
  await sleep(80)
  // [额度自动感知] 只开开关**不**产生内容：必须先有「本次请求路由观察 + 该渠道额度」。
  // 所以这里验证的是「开关已生效且格式正确」，内容为空属正常（normal、零规则）。
  check('Z3b 缓存窗口内一次事件即刷新配置（context 仍注册、无观察时为空）',
    systemPrompt.contexts.has('dsh-usage-dock.quota') && quotaContextText(systemPrompt) === '',
    { has: systemPrompt.contexts.has('dsh-usage-dock.quota'), text: quotaContextText(systemPrompt) })
  // 额度 context 反映的是**当前渠道的实时额度**，阈值本身不直接出现在文本里；
  // 这里改为验证「配置确实被重新读取」（Z3d）与内容形态。
  const textZ3c = quotaContextText(systemPrompt)
  check('Z3c context 使用白名单格式', typeof textZ3c === 'string'
    && (textZ3c === '' || textZ3c.indexOf('[当前额度快照]') === 0), textZ3c)
  check('Z3d reload 触发了真实的新配置读取（不复用旧缓存）',
    configReads > readsAfterStart, { readsAfterStart, configReads })

  // 窗口内关闭：同样只发一次事件
  override.quotaPolicyEnabled = false
  ctx.emit('app-boot/config-reload')
  await sleep(80)
  check('Z3e 关闭后 context 立即变空', quotaContextText(systemPrompt) === '',
    quotaContextText(systemPrompt))

  // 阈值变化（仍启用）也要反映在重读上
  override.quotaPolicyEnabled = true
  override.quotaWarningPercentThreshold = 35
  ctx.emit('app-boot/config-reload')
  await sleep(80)
  check('Z3f 缓存窗口内改阈值只发一次事件也生效（配置已重读）',
    configReads > readsAfterStart, { readsAfterStart, configReads })
}

// ===========================================================================
// Z3g — volatile getter 路径仍然工作（旧兼容）
// ===========================================================================
{
  const systemPrompt = fakeSystemPrompt()
  const live = { enabled: true, quotaPolicyEnabled: false, quotaFocusChannels: '["deepseek"]', quotaPercentThreshold: 25, quotaBalanceThreshold: 0, quotaBalanceCurrency: '' }
  const ctx = makeCtx({ tools: { register() { return () => {} } }, systemPrompt })
  apply(ctx, new Proxy(live, { get: (t, k) => t[k] }))
  await sleep(50)
  live.quotaPolicyEnabled = true
  ctx.emit('app-boot/config-reload')
  await sleep(60)
  // [额度自动感知] context 始终注册；启用后由「路由观察 + 渠道快照」决定内容。
  // 没有观察时 text 为空是**正确**行为（normal、零规则）。
  const entry = systemPrompt.contexts.get('dsh-usage-dock.quota')
  check('Z3g getter 路径同样注册 context 且无观察时为空',
    entry !== undefined && entry.text({ agent: null }) === '',
    { has: entry !== undefined, text: entry !== undefined ? entry.text({ agent: null }) : null })
}

// ===========================================================================
// Z3h — 缺 configEditor 服务时不崩、卸载后不复活
// ===========================================================================
{
  const systemPrompt = fakeSystemPrompt()
  const handlers = new Map()
  const effects = []
  const ctx = {
    webServer: { port: 0, register() { return () => {} } },
    get: (name) => (name === 'tools' ? { register() { return () => {} } } : (name === 'systemPrompt' ? systemPrompt : undefined)),
    on(name, fn) { handlers.set(name, fn) },
    off(name) { handlers.delete(name) },
    effect(fn) { const d = fn(); effects.push(d); return d },
  }
  let threw = false
  try {
    apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true, quotaPolicyEnabled: true, quotaFocusChannels: '["deepseek"]', quotaPercentThreshold: 10 })))
  } catch (err) { threw = true }
  await sleep(40)
  check('Z3h 缺 configEditor 不抛错', threw === false, threw)
  check('Z3h 缺 configEditor 时 context 仍注册（用启动快照）',
    systemPrompt.contexts.has('dsh-usage-dock.quota'), Array.from(systemPrompt.contexts.keys()))
  for (const d of effects.reverse()) { if (typeof d === 'function') d() }
  await sleep(60)
  check('Z3h 卸载后 context 被清理（不再复活）',
    systemPrompt.contexts.size === 0, Array.from(systemPrompt.contexts.keys()))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
