/**
 * [0.11.0 终审边界] DSH Go 原生半的四组边界（离线、mock ctx，不联网 / 不读真实凭据）：
 *
 *   B. strip 启用闸门：总开关或渠道开关关闭时**零 provider 调用**、不显示旧值。
 *   C. strip 缓存/在途按**账号身份**隔离：切换 ChatGPT active 账户后，
 *      新账号永久失败时不得继续显示旧账号的百分比，且必须重新取数。
 *   D. 策略刷新定时器：有桥 + 有 systemPrompt 但**没有 tools** 时，dispose 后 interval 必须清零。
 *   E. 原生 collect：采样期间切换 ChatGPT active 账户（身份漂移）时该条 wire 不带 identity，
 *      下一轮同身份暂时失败也不得 carry 旧百分比。
 *
 * 0.12.0 已删除 MiMo 的扫码登录 / 记住登录 / legacy 记录通道，原先的 A 段（legacy 闸门）
 * 与 F 段（legacy 选择顺序 / legacyRecordDisplay）随之整体移除；本文件不再断言这些功能。
 *
 * 用法：node tools/test-dsh-go-boundaries.mjs
 */
import { apply } from '../index.js'
import { PLANS } from '../plans/index.js'
import { CODEX_ACCOUNT_RECORD_KEY, codexAccountIdentitySnapshot, selectCodexAccount } from '../plans/codex-account.js'

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
// 全局替身：离线 fetch（任何真实出网都直接失败）+ 假 interval（只记录，不真正定时）
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new TypeError('offline') }

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

/**
 * [2026-11-23 多账户] Codex 私有凭据替身：一条 v2 记录（`activeAccountId` + `accounts`），
 * 可被**真实** `selectCodexAccount()` 通过 `modifyRecord()` 改写。只伪造本插件自己的记录。
 */
function fakeAccountCredentials(initialRecord) {
  const records = new Map([[CODEX_ACCOUNT_RECORD_KEY, initialRecord]])
  const calls = { read: 0, modify: 0, delete: 0 }
  return {
    records,
    calls,
    async readRecord(key) {
      calls.read += 1
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      calls.modify += 1
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      calls.delete += 1
      records.delete(key)
    },
  }
}

/**
 * 两账户 v2 记录：账号 id 与 credential id **各自不同** ⇒
 * `codexAccountIdentitySnapshot()` 在切换前后必然不同（`acct:<hash>@<id8>r<rev>`）。
 */
function codexAccountRecord(activeId, ids) {
  const accounts = ids.map((credentialId, index) => ({
    type: 'oauth',
    access: 'SYNTHETIC-ACCESS-' + index,
    refresh: 'SYNTHETIC-REFRESH-' + index,
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'acct-synthetic-' + String(index + 1).padStart(16, '0'),
    credentialId,
    revision: 1,
    savedAt: new Date().toISOString(),
    planType: 'plus',
    email: 'user' + (index + 1) + '@example.test',
  }))
  return { kind: 'grant', payload: { version: 2, activeAccountId: activeId, accounts } }
}

/** 给 `selectCodexAccount()` 的最小 ctx（只暴露凭据服务，与生产读法一致）。 */
const credentialsCtxOf = (credentials) => ({
  get(name) { return name === 'credentials' ? credentials : undefined },
})

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
// C. strip 账号身份隔离 + 永久失败
// [2026-11-23] 来源（connect/subscription）已退场：身份漂移改由**切换 ChatGPT active 账户**
// 驱动（记录中的 active credential 变化 ⇒ `acct=` 快照变化），不再改 `codexSource`。
// ---------------------------------------------------------------------------
async function codexAccountSwitchTests() {
  const codexField = enabledFieldOf('codex')
  let fetchCalls = 0
  let mode = 'a'
  stubPlanFetch('codex', async () => {
    fetchCalls += 1
    if (mode === 'a') return { id: 'codex', name: 'Codex', rollingUsage: { percent: 72 } }
    // 新 active 账号：永久失败（transient !== true），不得沿用旧账号的 72%。
    return { id: 'codex', name: 'Codex', error: 'api', transient: false }
  })
  try {
    const credentials = fakeAccountCredentials(codexAccountRecord('cred-a', ['cred-a', 'cred-b']))
    const state = { config: { enabled: true, [codexField]: true } }
    const sessions = fakeSessions({ s2: [providerEvent('openai-codex')] })
    const boom = boot({ state, sessions, dshGo: fakeDshGo(), credentials })
    fetchCalls = 0
    const sub = await subscribeStripFor(boom, 's2')
    await flush(10)
    const first = sub.emitted[sub.emitted.length - 1]
    check('C1 ChatGPT 账号 A 显示 Codex 72%', first !== null && first !== undefined
      && String(first.text).includes('Codex') && String(first.text).includes('72%'), first)

    // 切账号 → 新账号永久失败
    const beforeSwitch = sub.emitted.length
    const identityBeforeSwitch = codexAccountIdentitySnapshot()
    // **真实**切换 active 账户：写记录 + 同步刷新身份快照（等价于 select 路由的内部写操作）。
    const switched = await selectCodexAccount(credentialsCtxOf(credentials), 'cred-b')
    check('C1b selectCodexAccount 切换 active 账号成功（记录指向 B）',
      switched.ok === true
      && credentials.records.get(CODEX_ACCOUNT_RECORD_KEY).payload.activeAccountId === 'cred-b',
      switched)
    check('C1c 身份快照确实随 active 账号变化（acct:… 不同）',
      typeof identityBeforeSwitch === 'string' && identityBeforeSwitch.startsWith('acct:')
      && codexAccountIdentitySnapshot() !== identityBeforeSwitch
      && codexAccountIdentitySnapshot().startsWith('acct:'),
      { before: identityBeforeSwitch, after: codexAccountIdentitySnapshot() })
    mode = 'b'
    // 配置重载让 Host 用记录里的新 active 重算身份并重算 strip（真实客户端也靠刷新/定时重算）。
    boom.fire('app-boot/config-reload')
    await flush(20)
    const afterSwitch = sub.emitted[sub.emitted.length - 1]
    const afterSwitchText = JSON.stringify(sub.emitted.slice(beforeSwitch))
    check('C2 新账号永久失败时 strip 隐藏（null）', afterSwitch === null, afterSwitch)
    check('C3 不得继续显示旧账号的 Codex 72%', !afterSwitchText.includes('72%'), afterSwitchText.slice(0, 400))
    check('C4 新账号确实重新取数（身份隔离后未复用旧缓存）', fetchCalls >= 2, { fetch: fetchCalls })
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
// E. 原生 collect：采样期间切换 ChatGPT active 账号时该条 wire **不带 identity**
// [2026-11-23] 来源退场后不再用第三方 service revision 制造漂移；改为在慢采样期间
// 真实调用 `selectCodexAccount()`（写记录 + 更新同步快照）。
// ---------------------------------------------------------------------------
async function identityDriftTest() {
  const codexField = enabledFieldOf('codex')
  let calls = 0
  stubPlanFetch('codex', async (ctx) => {
    calls += 1
    if (calls === 1) {
      // 模拟慢采样期间用户切换账号：采样**完成前** active 与身份快照都变了。
      const switched = await selectCodexAccount(ctx, 'cred-b')
      if (switched.ok !== true) throw new Error('synthetic account switch failed')
      return { id: 'codex', name: 'Codex', rollingUsage: { percent: 72 } }
    }
    // 第二轮：同一（已推进的）身份下暂时失败。
    return { id: 'codex', name: 'Codex', error: 'api', transient: true }
  })
  try {
    const credentials = fakeAccountCredentials(codexAccountRecord('cred-a', ['cred-a', 'cred-b']))
    const state = {
      config: Object.assign({ enabled: true }, allPlansDisabled(), {
        [codexField]: true,
      }),
    }
    const boom = boot({ state, dshGo: fakeDshGo(), credentials })
    await flush(10)
    const surface = boom.panels.get('quota')
    check('E0 原生额度面板已注册 data feed', surface !== undefined && typeof surface.data === 'function')
    if (surface === undefined || typeof surface.data !== 'function') { boom.disposeAll(); return }
    const identityAtStart = codexAccountIdentitySnapshot()
    const emitted = []
    const stop = surface.data({ sessionId: 's1' }, (payload) => emitted.push(payload))
    await flush(18)
    check('E1 第一次采样显示 Codex 72%（数据本身有效）', JSON.stringify(emitted).includes('72'), JSON.stringify(emitted.slice(-2)).slice(0, 400))
    check('E1b 采样期间确实发生了账号切换（身份快照已变）',
      typeof identityAtStart === 'string' && identityAtStart.startsWith('acct:')
      && codexAccountIdentitySnapshot() !== identityAtStart,
      { before: identityAtStart, after: codexAccountIdentitySnapshot() })
    const beforeRefresh = emitted.length
    try { surface.actions.refresh({ sessionId: 's1' }, { locale: 'zh-CN' }) } catch (err) { /* 动作缺失时靠下一轮 */ }
    await flush(22)
    const afterText = JSON.stringify(emitted.slice(beforeRefresh))
    check('E2 采样期间切换账号的旧结果不带 identity：下一轮暂时失败不 carry 旧 72%',
      !afterText.includes('72'), afterText.slice(0, 400))
    check('E3 第二轮确实重新采样（provider 调用 2 次）', calls === 2, { calls })
    stop()
    boom.disposeAll()
    await flush(2)
  } finally {
    restorePlanFetches()
  }
}

async function main() {
  await stripGateTests()
  await codexAccountSwitchTests()
  await policyTimerDisposeTests()
  await identityDriftTest()
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
