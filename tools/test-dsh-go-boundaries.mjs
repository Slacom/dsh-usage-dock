/**
 * [0.11.0 终审边界] DSH Go 原生半的四组边界（离线、mock ctx，不联网 / 不读真实凭据）：
 *
 *   A. legacy（MiMo 记住登录）闸门：无桥 / 停用 / 关 remember 时**零凭据读取、零余额请求**；
 *      配置变化立即失效旧值；超过 5 分钟不再把历史余额当新鲜（会触发重放，不伪造时间戳）。
 *   B. strip 启用闸门：总开关或渠道开关关闭时**零 provider 调用**、不显示旧值。
 *   C. strip 缓存/在途按来源身份隔离：Codex Connect → Subscription 切换后，
 *      新来源永久失败时不得继续显示旧来源的百分比。
 *   D. 策略刷新定时器：有桥 + 有 systemPrompt 但**没有 tools** 时，dispose 后 interval 必须清零。
 *
 * 用法：node tools/test-dsh-go-boundaries.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, pickLegacyBalanceView } from '../index.js'
import { PLANS } from '../plans/index.js'
import { buildLegacyRecord, MIMO_LEGACY_RECORD_KEY } from '../plans/mimo-legacy-store.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) {
    passCount += 1
    console.log('[PASS] ' + name)
  } else {
    failCount += 1
    console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : ''))
  }
}

// ---------------------------------------------------------------------------
// 全局替身：离线 fetch 计数 + 假 interval（只记录，不真正定时）
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch
let balanceFetchCalls = 0
let balanceFetchImpl = async () => { throw new TypeError('offline') }
globalThis.fetch = (url, init) => {
  balanceFetchCalls += 1
  return balanceFetchImpl(url, init)
}

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const activeIntervals = new Set()
globalThis.setInterval = (fn, ms) => {
  const handle = { fn, ms, cleared: false }
  activeIntervals.add(handle)
  return handle
}
globalThis.clearInterval = (handle) => {
  if (handle !== null && handle !== undefined) {
    handle.cleared = true
    activeIntervals.delete(handle)
  }
}

function restoreGlobals() {
  globalThis.fetch = realFetch
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}

const flush = async (rounds) => {
  const n = typeof rounds === 'number' && rounds > 0 ? rounds : 8
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// mock ctx
// ---------------------------------------------------------------------------
function fakeDshGo() {
  const panels = new Map()
  let stripRegister = null
  return {
    panels,
    getStrip: () => stripRegister,
    panel(id, surface) {
      panels.set(id, surface)
      return () => { panels.delete(id) }
    },
    strip(id, register) {
      stripRegister = register
      return () => { stripRegister = null }
    },
  }
}

function fakeSystemPrompt() {
  const contexts = new Map()
  return {
    contexts,
    section() { return () => {} },
    context(spec) {
      contexts.set(spec.name, spec)
      return () => { contexts.delete(spec.name) }
    },
  }
}

function fakeCredentials(record) {
  const calls = { read: 0, delete: 0, modify: 0 }
  return {
    calls,
    async readRecord(key) {
      if (key !== MIMO_LEGACY_RECORD_KEY) return undefined
      calls.read += 1
      return record
    },
    async deleteRecord() { calls.delete += 1 },
    async modifyRecord(key, fn) { calls.modify += 1; return fn() },
  }
}

function fakeSessions(eventsBySession) {
  return {
    get(sessionId) {
      const events = eventsBySession[sessionId]
      if (!Array.isArray(events)) return undefined
      for (let i = 0; i < events.length; i += 1) {
        if (events[i] === null) return undefined
      }
      return { id: sessionId, snapshotEvents: () => events }
    },
  }
}

/** 启动一次真实 apply()，返回 mock 句柄。 */
function boot(options) {
  const opts = options || {}
  const state = opts.state !== undefined ? opts.state : { config: {} }
  const effects = []
  const handlers = new Map()
  const errors = []
  const dshGo = opts.dshGo !== undefined ? opts.dshGo : null
  const services = {
    webServer: { port: 0, register() { return () => {} } },
    configEditor: {
      configuration() {
        return [{ entry: { options: { id: 'plan-usage' } }, inherited: {}, override: state.config }]
      },
    },
  }
  if (opts.credentials !== undefined && opts.credentials !== null) services.credentials = opts.credentials
  if (opts.sessions !== undefined && opts.sessions !== null) services.sessions = opts.sessions
  if (opts.systemPrompt !== undefined && opts.systemPrompt !== null) services.systemPrompt = opts.systemPrompt
  if (opts.services !== undefined && opts.services !== null && typeof opts.services === 'object') {
    Object.assign(services, opts.services)
  }
  if (dshGo !== null) services.dshGo = dshGo

  const effectRegister = (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') effects.push(disposer)
    return disposer
  }
  const ctx = {
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
    webServer: services.webServer,
    effect: effectRegister,
    on(event, fn) {
      let set = handlers.get(event)
      if (set === undefined) { set = new Set(); handlers.set(event, set) }
      set.add(fn)
      return () => set.delete(fn)
    },
    off(event, fn) {
      const set = handlers.get(event)
      if (set !== undefined) set.delete(fn)
    },
    inject(deps, cb) {
      const list = Array.isArray(deps) ? deps : [deps]
      const available = list.every((name) => Object.prototype.hasOwnProperty.call(services, name))
      if (!available) return
      const hostCtx = { get: ctx.get, effect: effectRegister }
      for (const name of list) hostCtx[name] = services[name]
      // Cordis 的 inject 回调是异步调度的（apply 返回之后才执行）。
      Promise.resolve().then(() => {
        try {
          const returned = cb(hostCtx)
          if (typeof returned === 'function') effects.push(returned)
        } catch (err) { errors.push(err) }
      })
    },
  }
  apply(ctx, state.config)
  return {
    state,
    services,
    effects,
    errors,
    panels: dshGo !== null ? dshGo.panels : new Map(),
    fire(event) {
      const set = handlers.get(event)
      if (set === undefined) return
      for (const fn of [...set]) {
        try { fn() } catch (err) { errors.push(err) }
      }
    },
    disposeAll() {
      while (effects.length > 0) {
        const fn = effects.pop()
        try { fn() } catch (err) { errors.push(err) }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 渠道 stub（仅替换 fetch 实现，其余装配保持真实）
// ---------------------------------------------------------------------------
const originalFetches = new Map()
function stubPlanFetch(id, impl) {
  const plan = PLANS.find((item) => item.id === id)
  if (plan === undefined) throw new Error('unknown plan ' + id)
  if (!originalFetches.has(id)) originalFetches.set(id, plan.fetch)
  plan.fetch = impl
}
function restorePlanFetches() {
  for (const [id, impl] of originalFetches) {
    const plan = PLANS.find((item) => item.id === id)
    if (plan !== undefined) plan.fetch = impl
  }
  originalFetches.clear()
}

const enabledFieldOf = (id) => PLANS.find((item) => item.id === id).fields.enabled
const allPlansDisabled = () => Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))

const providerEvent = (provider) => ({
  type: 'request/header',
  data: { header: { config: { provider, model: 'synthetic-model' } } },
})

// ---------------------------------------------------------------------------
// A. legacy 闸门
// ---------------------------------------------------------------------------
const LEGACY_COOKIE = 'api-platform_serviceToken=tok-123; userId=42; api-platform_slh=syn; api-platform_ph=ph1'

function validLegacyRecord(fetchedAt) {
  const payload = buildLegacyRecord({
    platformCookie: LEGACY_COOKIE,
    balance: 12.5,
    currency: 'CNY',
    fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : Date.now(),
  })
  assert.ok(payload !== null, '测试用的 legacy 记录必须合法')
  return { kind: 'grant', payload }
}

async function legacyCase(label, opts) {
  const credentials = fakeCredentials(validLegacyRecord())
  const dshGo = fakeDshGo()
  const boom = boot({
    state: { config: Object.assign({ enabled: true, mimoEnabled: true, mimoRememberLogin: true }, opts.config || {}) },
    credentials,
    dshGo: opts.bridge === true ? dshGo : null,
  })
  await flush(6)
  balanceFetchCalls = 0
  // 配置重载是「桥接出现后」会触发 legacy 检查的事件（apply 里唯一的自动入口）。
  boom.fire('app-boot/config-reload')
  await flush(8)
  check(
    label,
    credentials.calls.read === opts.expectReads && balanceFetchCalls === opts.expectFetches,
    { read: credentials.calls.read, fetch: balanceFetchCalls, errors: boom.errors.map((e) => String(e && e.message)) },
  )
  boom.disposeAll()
  await flush(2)
}

async function legacyGateTests() {
  await legacyCase('A1 无 dshGo 桥：零凭据读取、零余额请求', {
    bridge: false, expectReads: 0, expectFetches: 0,
  })
  await legacyCase('A2 有桥但插件总开关关闭：零凭据读取、零余额请求', {
    bridge: true, config: { enabled: false }, expectReads: 0, expectFetches: 0,
  })
  await legacyCase('A3 有桥但 MiMo 渠道关闭：零凭据读取、零余额请求', {
    bridge: true, config: { mimoEnabled: false }, expectReads: 0, expectFetches: 0,
  })
  await legacyCase('A4 有桥但关闭 remember login：零凭据读取、零余额请求', {
    bridge: true, config: { mimoRememberLogin: false }, expectReads: 0, expectFetches: 0,
  })
  await legacyCase('A5 有桥且三项全开：读取凭据并重放余额（各 1 次）', {
    bridge: true, expectReads: 1, expectFetches: 1,
  })
}

/**
 * A6：只有桥 + 全开时才重放；没有可达的 MiMo host 时不得伪造 legacy 余额；
 * 同时用源码结构守住「新鲜度只认 fetchedAt，不用 checkedAt 冒充」这条契约
 * （这两点在 mock 宿主里不可达，因为真实 legacy 显示依赖 mimo-auth host 的 routeDisplay）。
 */
async function legacyFreshnessTest() {
  const disabled = allPlansDisabled()
  const state = {
    config: Object.assign({ enabled: true, mimoRememberLogin: true }, disabled, {
      [enabledFieldOf('mimo')]: true,
    }),
  }
  balanceFetchImpl = async () => ({
    status: 200,
    async json() { return { code: 0, data: { balance: 12.5, currency: 'CNY' } } },
  })
  balanceFetchCalls = 0
  const credentials = fakeCredentials(validLegacyRecord(Date.now() - 60_000))
  const dshGo = fakeDshGo()
  const boom = boot({ state, credentials, dshGo })
  await flush(8)
  boom.fire('app-boot/config-reload')
  await flush(10)
  check('A6a 有桥全开时只重放一次（余额请求 1 次）', balanceFetchCalls === 1, { fetch: balanceFetchCalls })

  const surface = boom.panels.get('quota')
  check('A6b 原生额度面板已注册 data feed', surface !== undefined && typeof surface.data === 'function')
  if (surface === undefined || typeof surface.data !== 'function') { boom.disposeAll(); return }
  const emitted = []
  const stop = surface.data({ sessionId: 's1' }, (payload) => emitted.push(payload))
  await flush(15)
  const panelText = JSON.stringify(emitted)
  check('A6c 没有可达 MiMo host 时不伪造 legacy 余额（面板显示缺失）',
    !panelText.includes('12.50') && !panelText.includes('12.5'), panelText.slice(0, 300))
  check('A6d 只读展示不重复请求上游', balanceFetchCalls === 1, { fetch: balanceFetchCalls })
  stop()
  boom.disposeAll()
  await flush(2)

  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('A6e 新鲜度用真实 fetchedAt（5 分钟常量存在）', source.includes('LEGACY_BALANCE_FRESH_MS'))
  check('A6f 展示路径统一按真实 fetchedAt 判新鲜（不拿 checkedAt 冒充采集时间）',
    source.includes('pickLegacyBalanceView') && !source.includes('Date.now() - legacyRecordState.checkedAt < 5 * 60_000'))
  check('A6g 触发时桥接未就绪就不排队重放',
    source.includes('if (dshGoBridgeSeen !== true) return Promise.resolve(null)'))
  balanceFetchImpl = async () => { throw new TypeError('offline') }
}

// ---------------------------------------------------------------------------
// B. strip 启用闸门
// ---------------------------------------------------------------------------
async function subscribeStripFor(boom, sessionId) {
  // strip 注册发生在 dsh-go 的 inject 回调里（apply 返回之后），先等一轮。
  await flush(8)
  const register = boom.services.dshGo.getStrip()
  check('B0 strip 已在原生桥接注册', typeof register === 'function')
  if (typeof register !== 'function') return { emitted: [], stop: () => {} }
  const emitted = []
  const stop = register({ sessionId }, (payload) => emitted.push(payload), { locale: 'zh-CN' })
  await flush(14)
  return { emitted, stop }
}

async function stripGateTests() {
  const opencodeField = enabledFieldOf('opencode-go')
  let fetchCalls = 0
  stubPlanFetch('opencode-go', async () => {
    fetchCalls += 1
    return { id: 'opencode-go', name: 'OpenCode Go', rollingUsage: { percent: 20 }, weeklyUsage: { percent: 10 } }
  })
  try {
    // B1：插件总开关关闭 —— 订阅时零 provider 调用、emit(null)
    const state = { config: { enabled: false, [opencodeField]: true } }
    const sessions = fakeSessions({ s1: [providerEvent('opencode-go')] })
    const dshGo = fakeDshGo()
    const boom = boot({ state, sessions, dshGo })
    fetchCalls = 0
    const sub1 = await subscribeStripFor(boom, 's1')
    check('B1a 总开关关闭：零 provider 调用', fetchCalls === 0, { fetch: fetchCalls })
    check('B1b 总开关关闭：strip 隐藏（null）', sub1.emitted.length > 0 && sub1.emitted[sub1.emitted.length - 1] === null, sub1.emitted)
    sub1.stop()
    boom.disposeAll()
    await flush(2)

    // B2：渠道开关关闭 —— 同上
    const state2 = { config: { enabled: true, [opencodeField]: false } }
    const boom2 = boot({ state: state2, sessions: fakeSessions({ s1: [providerEvent('opencode-go')] }), dshGo: fakeDshGo() })
    fetchCalls = 0
    const sub2 = await subscribeStripFor(boom2, 's1')
    check('B2a 渠道开关关闭：零 provider 调用', fetchCalls === 0, { fetch: fetchCalls })
    check('B2b 渠道开关关闭：strip 隐藏（null）', sub2.emitted[sub2.emitted.length - 1] === null, sub2.emitted)
    sub2.stop()
    boom2.disposeAll()
    await flush(2)

    // B3：先启用取到值，再停用 —— 停用后立即隐藏且不再调用 provider
    const state3 = { config: { enabled: true, [opencodeField]: true } }
    const boom3 = boot({ state: state3, sessions: fakeSessions({ s1: [providerEvent('opencode-go')] }), dshGo: fakeDshGo() })
    fetchCalls = 0
    const sub3 = await subscribeStripFor(boom3, 's1')
    await flush(10)
    const lastEnabled = sub3.emitted[sub3.emitted.length - 1]
    check('B3a 启用时显示 OpenCode Go 百分比', lastEnabled !== null && lastEnabled !== undefined
      && String(lastEnabled.text).includes('OpenCode Go') && String(lastEnabled.text).includes('80%'), lastEnabled)
    const callsAfterEnabled = fetchCalls
    state3.config[opencodeField] = false
    boom3.fire('app-boot/config-reload')
    await flush(14)
    check('B3b 停用渠道后立即隐藏（null）', sub3.emitted[sub3.emitted.length - 1] === null, sub3.emitted[sub3.emitted.length - 1])
    check('B3c 停用渠道后不再调用 provider', fetchCalls === callsAfterEnabled, { before: callsAfterEnabled, after: fetchCalls })
    state3.config.enabled = false
    boom3.fire('app-boot/config-reload')
    await flush(14)
    check('B3d 总开关关闭后同样隐藏', sub3.emitted[sub3.emitted.length - 1] === null)
    sub3.stop()
    boom3.disposeAll()
    await flush(2)
  } finally {
    restorePlanFetches()
  }
}

// ---------------------------------------------------------------------------
// C. strip 来源身份隔离 + 永久失败
// ---------------------------------------------------------------------------
async function codexSourceSwitchTests() {
  const codexField = enabledFieldOf('codex')
  let fetchCalls = 0
  let mode = 'connect'
  stubPlanFetch('codex', async () => {
    fetchCalls += 1
    if (mode === 'connect') return { id: 'codex', name: 'Codex', rollingUsage: { percent: 72 } }
    // Subscription 新来源：永久失败（transient !== true），不得沿用 Connect 的 72%。
    return { id: 'codex', name: 'Codex', error: 'api', transient: false }
  })
  try {
    const state = { config: { enabled: true, [codexField]: true, codexSource: 'connect' } }
    const sessions = fakeSessions({ s2: [providerEvent('openai-codex')] })
    const boom = boot({ state, sessions, dshGo: fakeDshGo() })
    fetchCalls = 0
    const sub = await subscribeStripFor(boom, 's2')
    await flush(10)
    const first = sub.emitted[sub.emitted.length - 1]
    check('C1 Connect 来源显示 Codex 72%', first !== null && first !== undefined
      && String(first.text).includes('Codex') && String(first.text).includes('72%'), first)

    // 切来源 → 新来源永久失败
    const beforeSwitch = sub.emitted.length
    mode = 'subscription'
    state.config.codexSource = 'subscription'
    boom.fire('app-boot/config-reload')
    await flush(16)
    const afterSwitch = sub.emitted[sub.emitted.length - 1]
    const afterSwitchText = JSON.stringify(sub.emitted.slice(beforeSwitch))
    check('C2 新来源永久失败时 strip 隐藏（null）', afterSwitch === null, afterSwitch)
    check('C3 不得继续显示旧来源的 Codex 72%', !afterSwitchText.includes('72%'), afterSwitchText.slice(0, 400))
    check('C4 新来源确实重新取数（身份隔离后未复用旧缓存）', fetchCalls >= 2, { fetch: fetchCalls })
    sub.stop()
    boom.disposeAll()
    await flush(2)
  } finally {
    restorePlanFetches()
  }
}

// ---------------------------------------------------------------------------
// D. 策略刷新定时器：无 tools 服务时 dispose 也必须清零
// ---------------------------------------------------------------------------
async function policyTimerDisposeTests() {
  let providerCalls = 0
  for (const plan of PLANS) {
    stubPlanFetch(plan.id, async () => {
      providerCalls += 1
      return { id: plan.id, name: plan.name, error: 'no-credential', transient: true }
    })
  }
  try {
    const state = {
      config: Object.assign({ enabled: true, quotaPolicyEnabled: false }, allPlansDisabled(), {
        [enabledFieldOf('opencode-go')]: true,
      }),
    }
    const systemPrompt = fakeSystemPrompt()
    const dshGo = fakeDshGo()
    // 没有 tools 服务：tools 注册分支会提前返回（终审 D 的复现条件）。
    const boom = boot({ state, dshGo, systemPrompt })
    await flush(10)
    check('D0 本机没有 tools 服务（tools 注册分支不生效）', boom.services.tools === undefined)
    check('D1 有桥 + systemPrompt：后台刷新 interval 已创建', activeIntervals.size >= 1, { intervals: activeIntervals.size })
    check('D1b systemPrompt 动态 context 已注册', systemPrompt.contexts.size === 1, { contexts: systemPrompt.contexts.size })
    boom.disposeAll()
    await flush(4)
    check('D2 dispose 后 interval 清零（不依赖 usage_status 注册分支）', activeIntervals.size === 0, { intervals: activeIntervals.size })
    check('D3 后台 tick 没有调用任何 provider', providerCalls === 0, { calls: providerCalls })
    check('D4 注入错误为空', boom.errors.length === 0, boom.errors.map((e) => String(e && e.stack).slice(0, 300)))
  } finally {
    restorePlanFetches()
  }
}

// ---------------------------------------------------------------------------
// E. 原生 collect：采样期间身份漂移时该条 wire **不带 identity**
// ---------------------------------------------------------------------------
async function identityDriftTest() {
  const codexField = enabledFieldOf('codex')
  let revision = 1
  let calls = 0
  const usageService = {
    apiVersion: 1,
    getRevision() { return revision },
    async readUsage() { return null },
  }
  stubPlanFetch('codex', async () => {
    calls += 1
    if (calls === 1) {
      // 模拟慢采样期间账号变化：采样**完成前** revision 前进。
      revision = 2
      return { id: 'codex', name: 'Codex', rollingUsage: { percent: 72 } }
    }
    // 第二轮：同一（已推进的）身份下暂时失败。
    return { id: 'codex', name: 'Codex', error: 'api', transient: true }
  })
  try {
    const state = {
      config: Object.assign({ enabled: true, codexSource: 'subscription' }, allPlansDisabled(), {
        [codexField]: true,
      }),
    }
    const boom = boot({ state, dshGo: fakeDshGo(), services: { codexSubscriptionUsage: usageService } })
    await flush(10)
    const surface = boom.panels.get('quota')
    check('E0 原生额度面板已注册 data feed', surface !== undefined && typeof surface.data === 'function')
    if (surface === undefined || typeof surface.data !== 'function') { boom.disposeAll(); return }
    const emitted = []
    const stop = surface.data({ sessionId: 's1' }, (payload) => emitted.push(payload))
    await flush(18)
    check('E1 第一次采样显示 Codex 72%（数据本身有效）', JSON.stringify(emitted).includes('72'), JSON.stringify(emitted.slice(-2)).slice(0, 400))
    const beforeRefresh = emitted.length
    try { surface.actions.refresh({ sessionId: 's1' }, { locale: 'zh-CN' }) } catch (err) { /* 动作缺失时靠下一轮 */ }
    await flush(22)
    const afterText = JSON.stringify(emitted.slice(beforeRefresh))
    check('E2 身份漂移的旧结果不带 identity：下一轮暂时失败不 carry 旧 72%',
      !afterText.includes('72'), afterText.slice(0, 400))
    check('E3 第二轮确实重新采样（provider 调用 2 次）', calls === 2, { calls })
    stop()
    boom.disposeAll()
    await flush(2)
  } finally {
    restorePlanFetches()
  }
}

// ---------------------------------------------------------------------------
// F. legacy 选择顺序：过期 done 只失去优先权，不得短路记录缓存
// ---------------------------------------------------------------------------
function legacySelectionTests() {
  const now = Date.now()
  const staleDone = { balance: 5, currency: 'CNY', fetchedAt: now - 6 * 60_000 }
  const freshRecord = { balance: 19, currency: 'CNY', fetchedAt: now - 60_000 }
  const staleRecord = { balance: 19, currency: 'CNY', fetchedAt: now - 6 * 60_000 }
  const first = pickLegacyBalanceView({ done: staleDone, record: freshRecord, now })
  check('F1 过期 done 不短路：回落到记录缓存的新余额 19 CNY',
    first.value !== null && first.value.balance.balance === 19 && first.needsReplay === false, first)
  const second = pickLegacyBalanceView({ done: { balance: 7, currency: 'CNY', fetchedAt: now - 60_000 }, record: freshRecord, now })
  check('F2 对照：done 新鲜时优先 done（7 CNY）',
    second.value !== null && second.value.balance.balance === 7, second)
  const third = pickLegacyBalanceView({ done: staleDone, record: staleRecord, now })
  check('F3 done / record 都不新鲜：返回 null 并请求一次重放',
    third.value === null && third.needsReplay === true, third)
  const fourth = pickLegacyBalanceView({ done: { balance: 5, currency: 'CNY' }, record: freshRecord, now })
  check('F4 done 缺 fetchedAt：同样不短路，回落到记录缓存',
    fourth.value !== null && fourth.value.balance.balance === 19, fourth)
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('F5 运行时统一走选择顺序（done + record）',
    source.includes('pickLegacyBalanceView({ done, record: legacyRecordState.data'))
  check('F6 过期 done 分支不再直接 return null（已移除旧短路）',
    !source.includes('if (sampledAt !== null && freshEnough(sampledAt))'))
}

/** F 端到端：没有 done 快照时，重放成功的新余额必须真正显示出来（而不是缺失）。 */
async function legacyRecordDisplayTest() {
  const disabled = allPlansDisabled()
  const state = {
    config: Object.assign({ enabled: true, mimoRememberLogin: true }, disabled, {
      [enabledFieldOf('mimo')]: true,
    }),
  }
  balanceFetchCalls = 0
  balanceFetchImpl = async () => ({
    status: 200,
    async json() { return { code: 0, data: { balance: 19, currency: 'CNY' } } },
  })
  const credentials = fakeCredentials(validLegacyRecord(Date.now() - 60_000))
  // 提供可达的 mimo-auth host（它同时有 display / legacyDoneBalance 两条只读 lane）。
  const connection = { fetch: { register() { return () => {} } } }
  const boom = boot({ state, credentials, dshGo: fakeDshGo(), services: { connection } })
  await flush(10)
  boom.fire('app-boot/config-reload')
  await flush(12)
  check('F7 重放成功（余额请求 1 次）', balanceFetchCalls === 1, { fetch: balanceFetchCalls })
  const surface = boom.panels.get('quota')
  check('F8 原生额度面板已注册 data feed', surface !== undefined && typeof surface.data === 'function')
  if (surface !== undefined && typeof surface.data === 'function') {
    const emitted = []
    const stop = surface.data({ sessionId: 's1' }, (payload) => emitted.push(payload))
    await flush(18)
    const text = JSON.stringify(emitted)
    check('F9 [0.11.4] 扫码通道下线：不再重放记录余额（mimo 显示未配置凭据）',
      !text.includes('19.00') && text.includes('未配置凭据'), text.slice(0, 400))
    stop()
  }
  boom.disposeAll()
  await flush(2)
  balanceFetchImpl = async () => { throw new TypeError('offline') }
}

async function main() {
  await legacyGateTests()
  await legacyFreshnessTest()
  await stripGateTests()
  await codexSourceSwitchTests()
  await policyTimerDisposeTests()
  await identityDriftTest()
  legacySelectionTests()
  await legacyRecordDisplayTest()
}

main()
  .then(() => {
    restoreGlobals()
    console.log('')
    console.log('dsh-go 边界：' + (passCount + failCount) + ' 项，' + passCount + ' 通过，' + failCount + ' 失败')
    process.exitCode = failCount === 0 ? 0 : 1
  })
  .catch((err) => {
    restoreGlobals()
    console.log('[FAIL] 未捕获异常：' + (err && err.stack ? err.stack : String(err)))
    process.exitCode = 1
  })
