/**
 * MiMo G1 · 可选 Host 适配（仅 connection.fetch.register owner 路由）
 *
 * 启动只做轻量注册：不加载扫码 flow、不登录、不轮询、不联网。
 * 所有 ticket/QR/cookie 只在 Host 内存；不写 cfg、secret、record、文件或日志。
 */
import { randomBytes } from 'node:crypto'
import { createSessionManager, SESSION_CODES } from './session.js'
import { ROUTE_PATHS, ROUTE_CODES, capability, handleAuth, handleQr, json, consoleSnapshot, rememberedSnapshot } from './routes.js'
import { parseMimoBalance } from '../mimo.js'
import { failureFromReport } from './failure.js'
import { createDisplayManager, absentDisplayDto, DISPLAY_CODES } from './session-display.js'
import { createConsoleSessionManager, CONSOLE_SESSION_NAMESPACE } from './console-session.js'
import { createRememberedSession } from './remembered-session.js'

const FLOW_UNAVAILABLE = 'E_MIMO_AUTH_UNAVAILABLE'

/**
 * [console 2026-11-06] 协议固定错误 → DISPLAY_CODES。
 * 401/403 拒、身份不一致、过期/取消/读超时、解析失败、网络/暂时失败。
 * 不认识的错误一律按**终止**处理（绝不当成暂时失败反复重试）。
 */
function mapConsoleBalanceError(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (code === 'E_MIMO_AUTH_REJECTED' || code === 'E_MIMO_CONSOLE_AUTH_REQUIRED'
    || code === 'E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING'
    || code === 'E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING') {
    return { ok: false, status: 401, code: DISPLAY_CODES.AUTH_REJECTED }
  }
  if (code === 'E_MIMO_CONSOLE_IDENTITY_MISMATCH') return { ok: false, code: DISPLAY_CODES.IDENTITY_MISMATCH }
  if (code === 'E_MIMO_AUTH_TARGET_EXPIRED' || code === 'E_MIMO_AUTH_CANCELLED'
    || code === 'E_REQUEST_TIMEOUT' || code === 'E_MIMO_CONSOLE_CREDENTIAL_INVALID') {
    return { ok: false, code: DISPLAY_CODES.TIMEOUT }
  }
  if (code === 'E_MIMO_CONSOLE_BALANCE_PARSE') return { ok: false, code: DISPLAY_CODES.BALANCE_PARSE }
  if (code === 'E_MIMO_CONSOLE_TRANSIENT' || code === 'E_NETWORK') {
    return { ok: false, status: 503, code: DISPLAY_CODES.NETWORK }
  }
  return { ok: false, code: DISPLAY_CODES.BALANCE_PARSE }
}

function safeStatus(onStatus, value) {
  try { onStatus(value) } catch { /* 状态回调不能影响主插件 */ }
}

/**
 * @param ctx                       DSH context
 * @param onStatus                  状态回调（不能影响主插件）
 * @param options
 *   options.enableRememberedAccount  「记住登录」managed 模式代码开关（默认 **false**，
 *                                    由安装 overlay 显式打开；route/UI 无法打开它）
 *   options.isEnabled                当前 global enabled && mimoEnabled 的异步回调
 *                                    （每个 tick 前重读；禁用即中止在途、0 请求）
 */
export function registerMimoAuth(ctx, onStatus = () => {}, options = {}) {
  const bootEpoch = randomBytes(16).toString('hex')
  const source = options !== null && typeof options === 'object' ? options : {}
  const dependencies = {
    enableRememberedAccount: source.enableRememberedAccount === true,
    enableConsoleProtocol: source.enableConsoleProtocol === true,
    isEnabled: typeof source.isEnabled === 'function' ? source.isEnabled : undefined,
  }
  let child = null
  safeStatus(onStatus, { supported: false, code: FLOW_UNAVAILABLE, bootEpoch })
  try {
    // Soft child fiber: missing connection/webServer never blocks the main plugin.
    ctx.inject(['connection', 'webServer'], (c) => {
      try {
        child = createAuthHost(c, bootEpoch, onStatus, dependencies)
        safeStatus(onStatus, { supported: true, code: ROUTE_CODES.OK, bootEpoch })
        return () => {
          try { child?.dispose() } catch { /* 已清理 */ }
          child = null
          safeStatus(onStatus, { supported: false, code: FLOW_UNAVAILABLE, bootEpoch })
        }
      } catch {
        child = null
        safeStatus(onStatus, { supported: false, code: FLOW_UNAVAILABLE, bootEpoch })
        return () => {}
      }
    })
  } catch {
    safeStatus(onStatus, { supported: false, code: FLOW_UNAVAILABLE, bootEpoch })
  }
  return {
    bootEpoch,
    /**
     * `getHost()` 返回**当前**的 auth host —— 即 `ctx.inject()` 回调里异步创建的 `child`；
     * 尚未就绪或已 dispose 时为 `null`。
     *
     * ⚠️ 必须**每次调用时读闭包里的当前值**，不要缓存：inject 是异步的，主插件注册后的
     * 首次调用通常还是 `null`（这正是「`mimoAuthHost.display` / `.routeDisplay` 全是 undefined」
     * 那个真 bug：`registerMimoAuth()` 的返回值里从来没有这些字段）。
     *
     * 只供**同进程只读**消费（例如 `usage_status` 的 MiMo 读数要与胶囊取同一份显示快照）；
     * 拿到 host 也**不得**调用任何变更动作（managed 模式下 start/read/grant/confirm/stop 固定拒绝）；
     * 不落盘、不外泄、不进日志、不进任何缓存。
     */
    getHost: () => child,
    dispose: () => { try { child?.dispose() } catch { /* 已清理 */ } },
  }
}

export function createAuthHost(ctx, bootEpoch, onStatus = () => {}, dependencies = {}) {
  const now = dependencies.now ?? Date.now
  const fetchImpl = dependencies.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const loadFlow = dependencies.loadFlow ?? (async () => {
    const [flow, jar] = await Promise.all([
      import('./vendor/memory-flow.js'),
      import('./vendor/cookie-jar.js'),
    ])
    return { ...flow, ...jar }
  })
  // Exact test/DI key: the actual D transport object, never a module or factory.
  const injectedSecureTransport = dependencies.secureTransport ?? null
  const postQrProducer = dependencies.postQrProducer ?? null
  const postQrBalanceAdapter = dependencies.postQrBalanceAdapter ?? null
  const postQrEnabled = typeof postQrProducer === 'function' && typeof postQrBalanceAdapter === 'function'
  /**
   * [display 2026-11-05] 本机显示会话：**独立** manager，与旧单次链互不继承。
   * 三件 DI（producer / identityVerifier / balanceAdapter）+ namespace 全部注入才 enabled；
   * [console 2026-11-06] 代码级开关打开时，缺省绑定**真实** console DI；
   * 任何显式注入的合成 DI 优先，**不被**默认正式绑定覆盖。
   */
  const consoleEnabled = dependencies.enableConsoleProtocol === true
  const consoleSessions = consoleEnabled
    ? createConsoleSessionManager({
      bootEpoch,
      now,
      setTimeout: dependencies.setTimeout,
      clearTimeout: dependencies.clearTimeout,
      // 只给代码级测试注入 fakeDNS/request；生产不传 ⇒ 真实 node:https + node:dns
      transportDeps: dependencies.consoleTransportDeps,
    })
    : null
  /** consoleAttach 的 Host 内部上下文（不进 DTO、不进路由响应）。 */
  const attachSlot = { authId: null, generation: 0 }
  const syntheticDisplay = typeof dependencies.displayProducer === 'function'
    || typeof dependencies.displayIdentityVerifier === 'function'
    || typeof dependencies.displayBalanceAdapter === 'function'
  const displayOptions = syntheticDisplay
    ? {
      producer: dependencies.displayProducer ?? null,
      identityVerifier: dependencies.displayIdentityVerifier ?? null,
      balanceAdapter: dependencies.displayBalanceAdapter ?? null,
      namespace: dependencies.displayNamespace ?? null,
    }
    : (consoleSessions !== null
      ? {
        // 唯一出站边界：claim / verifyCredential / readCredential（全部 Host 内存，无第二份副本）
        producer: () => {
          const claimed = consoleSessions.claim(attachSlot.authId, attachSlot.generation)
          if (claimed === null || claimed.ok !== true || claimed.credential === null) return { credential: null }
          return { credential: claimed.credential }
        },
        identityVerifier: ({ credential }) => consoleSessions.verifyCredential(credential),
        balanceAdapter: async ({ credential, signal, deadlineAt }) => {
          try {
            const out = await consoleSessions.readCredential(credential, { signal, deadlineAt })
            return { ok: true, balance: out.balance, identity: out.identity }
          } catch (error) {
            return mapConsoleBalanceError(error)
          }
        },
        // stop/expire/dispose 时立刻释放 handle（不等 GC）
        credentialDisposer: (credential) => { consoleSessions.disposeCredential(credential) },
        namespace: CONSOLE_SESSION_NAMESPACE,
      }
      : {
        producer: null,
        identityVerifier: null,
        balanceAdapter: null,
        namespace: null,
      })
  const display = createDisplayManager({
    ...displayOptions,
    now,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
    randomId: dependencies.randomId,
  })
  const manager = createSessionManager({ now })

  // =========================================================================
  // [remembered 2026-11-07] 「记住登录」managed 模式
  //   - 代码开关 `dependencies.enableRememberedAccount === true` 才创建；
  //   - 打开后新 controller 是**唯一** managed owner（唯一上游轮询者）：
  //     console 分支被摘掉、display 只留**纯观察**快照，旧变更动作一律固定拒绝（0 请求）；
  //   - vault 由 `dependencies.rememberedVault` 注入（测试 fake）或懒加载真实
  //     `remember-store.js`（DPAPI CurrentUser + 宿主 credentials record 密文）；
  //     缺模块/缺服务/缺 profile scope ⇒ 固定 unsupported，**无明文 fallback**。
  // =========================================================================
  const rememberedEnabled = dependencies.enableRememberedAccount === true
  let vaultRef = dependencies.rememberedVault ?? null
  async function resolveVault() {
    if (vaultRef !== null && vaultRef !== undefined) return vaultRef
    try {
      const mod = await import('./remember-store.js')
      if (mod === null || typeof mod !== 'object' || typeof mod.createRememberedVault !== 'function') return null
      const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials === undefined || credentials === null || typeof credentials !== 'object') return null
      const profileContext = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
      const dir = profileContext !== null && typeof profileContext === 'object' ? profileContext.dir : undefined
      // profile scope 必须是**稳定**的非空绝对路径；不是 cwd / bootEpoch，也不公布给 UI
      if (typeof dir !== 'string' || dir === '' || dir.length > 512) return null
      const absolute = /^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('/')
      if (absolute !== true) return null
      // 仅代码级 DI（测试/合成用）：route/GUI/配置都拿不到；默认仍走真实 DPAPI
      const crypto = dependencies.rememberedCrypto !== null && typeof dependencies.rememberedCrypto === 'object'
        ? dependencies.rememberedCrypto
        : undefined
      vaultRef = mod.createRememberedVault({ credentials, scope: dir, ...(crypto === undefined ? {} : { crypto }) })
      return vaultRef
    } catch { return null }
  }
  /** 薄门面：真实 vault 懒加载；缺失时统一抛/报固定 unsupported（绝不降级明文）。 */
  const vaultFacade = Object.freeze({
    async capability() {
      const v = await resolveVault()
      if (v === null) return { supported: false, code: 'E_MIMO_REMEMBERED_UNSUPPORTED' }
      try { return await v.capability() } catch { return { supported: false, code: 'E_MIMO_REMEMBERED_UNSUPPORTED' } }
    },
    async load(args) {
      const v = await resolveVault()
      if (v === null) throw Object.assign(new Error('E_MIMO_REMEMBERED_UNSUPPORTED'), { code: 'E_MIMO_REMEMBERED_UNSUPPORTED' })
      return v.load(args)
    },
    async save(record, args) {
      const v = await resolveVault()
      if (v === null) throw Object.assign(new Error('E_MIMO_REMEMBERED_UNSUPPORTED'), { code: 'E_MIMO_REMEMBERED_UNSUPPORTED' })
      return v.save(record, args)
    },
    async forget(args) {
      const v = await resolveVault()
      if (v === null) throw Object.assign(new Error('E_MIMO_REMEMBERED_UNSUPPORTED'), { code: 'E_MIMO_REMEMBERED_UNSUPPORTED' })
      return v.forget(args)
    },
    dispose() {
      const v = vaultRef
      vaultRef = null
      try { v?.dispose?.() } catch { /* 已清理 */ }
    }
  })
  // ── enabled watcher 状态（fail closed；配置事件立即探测 + ≤1s 本地兜底） ──────
  let syncEnabled = false
  let watchStopped = false
  let watchTimer = null
  let probePromise = null
  let probeSeq = 0
  const watchSet = typeof dependencies.setTimeout === 'function' ? dependencies.setTimeout : globalThis.setTimeout
  const watchClear = typeof dependencies.clearTimeout === 'function' ? dependencies.clearTimeout : globalThis.clearTimeout
  const enabledProbe = typeof dependencies.isEnabled === 'function' ? dependencies.isEnabled : null
  const remembered = rememberedEnabled
    ? createRememberedSession({
      bootEpoch,
      vault: vaultFacade,
      isEnabled: typeof dependencies.isEnabled === 'function' ? dependencies.isEnabled : null,
      isEnabledSync: () => syncEnabled === true,
      now,
      setTimeout: dependencies.setTimeout,
      clearTimeout: dependencies.clearTimeout,
      transportDeps: dependencies.consoleTransportDeps,
    })
    : null
  const rememberedApi = remembered === null ? null : Object.freeze({
    status: () => remembered.status(),
    startAuth: (args) => remembered.startAuth(args),
    beginAuth: (id, gen) => remembered.beginAuth(id, gen),
    takeQr: (id, gen) => remembered.takeQr(id, gen),
    approve: (id, gen, aid) => remembered.approve(id, gen, aid),
    deny: (id, gen, aid) => remembered.deny(id, gen, aid),
    confirmAccount: (id, gen) => remembered.confirmAccount(id, gen),
    cancelAuth: (id, gen) => remembered.cancelAuth(id, gen),
    pause: () => remembered.pause(),
    resume: () => remembered.resume(),
    forget: () => remembered.forget(),
    retry: () => remembered.retry(),
    // [freshness 2026-11-10] 本人展开详情时主动读一次（单飞：会加入 Host 自己的 tick flight）
    refresh: () => remembered.refresh(),
    track: (p) => trackTask(p),
  })
  /** managed 模式下 display 只剩**纯观察**：所有变更动作 0 请求固定拒绝。 */
  function managedDisplayRefusal() {
    return {
      ok: false,
      code: ROUTE_CODES.REMEMBERED_MANAGED_ONLY,
      display: remembered === null ? absentDisplayDto() : remembered.displaySnapshot(),
    }
  }
  const managedDisplay = remembered === null ? null : Object.freeze({
    enabled: true,
    namespace: CONSOLE_SESSION_NAMESPACE,
    status: () => ({ ok: true, code: ROUTE_CODES.OK, display: remembered.displaySnapshot() }),
    peek: () => remembered.displaySnapshot(),
    start: () => managedDisplayRefusal(),
    read: () => managedDisplayRefusal(),
    grant: () => managedDisplayRefusal(),
    confirm: () => managedDisplayRefusal(),
    stop: () => managedDisplayRefusal(),
    dispose: () => {},
  })
  /** 路由实际使用的 display：managed 模式用纯观察门面，否则完全沿用旧 display。 */
  const routeDisplay = managedDisplay === null ? display : managedDisplay
  const stop = new AbortController()
  const disposers = []
  const tasks = new Set()
  let disposed = false
  let flowAvailable = true
  /** [console] 旧 legacy 会话的**非密**记号（ticket/generation only），仅用于双登录防护。 */
  const legacy = { ticketId: null, generation: 0 }
  const LEGACY_TERMINAL = new Set(['done', 'failed', 'cancelled', 'expired', 'disposed'])

  function trackTask(promise) {
    const task = Promise.resolve(promise).then(() => undefined, () => undefined)
      .finally(() => { tasks.delete(task) })
    tasks.add(task)
    return task
  }

  /** 旧 legacy 会话是否仍在跑：纯只读观察，不创建会话、不发请求。 */
  function legacyBusy() {
    if (legacy.ticketId === null) return false
    let session = null
    try { session = manager.get(legacy.ticketId) } catch { session = null }
    if (session === null || session === undefined) { legacy.ticketId = null; return false }
    if (LEGACY_TERMINAL.has(session.state)) { legacy.ticketId = null; return false }
    return true
  }

  /**
   * [console] 路由层只看到这一层门面：begin 的 `done` 进 host.idle 的 tasks，
   * attach 在这里完成「取事前预期 → display.start」，余额读取仍由 display 动作驱动。
   */
  const consoleApi = consoleSessions === null ? null : {
    enabled: true,
    namespace: CONSOLE_SESSION_NAMESPACE,
    start: (args) => consoleSessions.start(args),
    begin(authId, generation) {
      const result = consoleSessions.begin(authId, generation)
      if (result !== null && result !== undefined && result.done !== undefined) trackTask(result.done)
      return result
    },
    status: () => consoleSessions.status(),
    takeQr: (authId, generation) => consoleSessions.takeQr(authId, generation),
    approve: (authId, generation, approvalId) => consoleSessions.approve(authId, generation, approvalId),
    deny: (authId, generation, approvalId) => consoleSessions.deny(authId, generation, approvalId),
    stop: (authId, generation) => consoleSessions.stop(authId, generation),
    /** 只 attach、不读余额；事前预期由 Host 内部取，不经路由返回。 */
    async attach(authId, generation) {
      const expected = consoleSessions.getExpectedForAttach(authId, generation)
      if (expected === null) {
        return { ok: false, code: 'E_MIMO_CONSOLE_NOT_READY', display: display.peek() }
      }
      attachSlot.authId = authId
      attachSlot.generation = generation
      return display.start({ expected })
    },
  }

  /** 已有 display 会话或旧 legacy 会话在跑 ⇒ 新 consoleStart 必须 0 请求拒绝（防双登录）。 */
  function consoleBusy() {
    if (legacyBusy() === true) return true
    try {
      const view = display.status()
      const d = view !== null && view !== undefined ? view.display : null
      if (d !== null && d !== undefined && (d.state === 'holding' || d.state === 'verified')) return true
    } catch { /* 观察失败不视为忙 */ }
    return false
  }

  /**
   * enabled 探测（Host 主动）：读失败/false ⇒ 同步缓存 false 并**主动 disable**；
   * 旧 true 结果不能覆盖更新一代的 false（probeSeq）。不发网络、不解密、不 poll 余额。
   */
  async function probeEnabled() {
    if (watchStopped || remembered === null) return false
    if (probePromise !== null) return probePromise
    const seq = ++probeSeq
    probePromise = (async () => {
      let ok = false
      try { ok = enabledProbe === null ? false : (await enabledProbe()) === true } catch { ok = false }
      if (watchStopped) return false
      if (ok !== true) {
        syncEnabled = false
        try { remembered.disable() } catch { /* 已清理 */ }
        return false
      }
      if (seq !== probeSeq) return syncEnabled
      syncEnabled = true
      return true
    })().finally(() => { probePromise = null })
    return probePromise
  }

  /** ≤1s 的廉价本地兜底探测（只读开关；不叠加第二个上游 owner）。 */
  function armEnabledWatch() {
    if (watchStopped || remembered === null) return
    watchTimer = watchSet(() => {
      watchTimer = null
      void probeEnabled().finally(() => armEnabledWatch())
    }, 1000)
    if (watchTimer !== null && typeof watchTimer.unref === 'function') watchTimer.unref()
  }

  function stopEnabledWatch() {
    watchStopped = true
    if (watchTimer !== null) {
      try { watchClear(watchTimer) } catch { /* 已清理 */ }
      watchTimer = null
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    // 先停 watcher（含 fake timer），再撤协议/清值
    stopEnabledWatch()
    try { stop.abort() } catch { /* 已中止 */ }
    try { manager.dispose() } catch { /* 已清理 */ }
    // display 先释放 handle（credentialDisposer → disposeCredential），再清 console manager
    try { display.dispose() } catch { /* 已清理 */ }
    try { consoleSessions?.dispose() } catch { /* 已清理 */ }
    // managed：只清内存/取消 pending，**不** forget —— 记住登录留给下次启动
    try { remembered?.dispose() } catch { /* 已清理 */ }
    try { vaultFacade.dispose() } catch { /* 已清理 */ }
    for (const fn of disposers.splice(0)) { try { fn() } catch { /* 已清理 */ } }
    safeStatus(onStatus, { supported: false, code: FLOW_UNAVAILABLE, bootEpoch })
  }

  function liveSession(ticketId, generation) {
    if (disposed) return null
    const session = manager.get(ticketId)
    if (session === null || session.gen !== generation || session.state !== 'running' || session.controller.signal.aborted) return null
    return session
  }

  function isolateDynamicResponse(response) {
    const headers = response?.headers
    return {
      status: response?.status,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'set-cookie' ? null : (typeof headers?.get === 'function' ? headers.get(name) : null)
        },
        getSetCookie() { return [] },
      },
      body: response?.body,
      arrayBuffer: typeof response?.arrayBuffer === 'function' ? () => response.arrayBuffer() : undefined,
      url: response?.url,
      redirected: response?.redirected,
      tls: response?.tls,
    }
  }

  function fetchFor(session, generation, secureTransport = null) {
    return (url, init) => {
      if (disposed || session.controller.signal.aborted) throw new Error('E_MIMO_AUTH_CANCELLED')
      if (now() >= session.deadline) throw new Error('E_MIMO_AUTH_SESSION_EXPIRED')
      const charged = manager.chargeCall(generation)
      if (!charged.ok) throw new Error(charged.code)
      if (disposed || session.controller.signal.aborted || now() >= session.deadline) throw new Error('E_MIMO_AUTH_CANCELLED')
      const requested = String(url)
      if (session.approvedLongPoll !== null && requested === session.approvedLongPoll) {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (secureTransport === null || method !== 'GET') throw new Error('E_MIMO_AUTH_FLOW')
        const headers = { ...(init?.headers ?? {}) }
        delete headers.cookie
        return Promise.resolve(secureTransport.fetch({
          url: requested,
          method: 'GET',
          purpose: 'longPoll',
          headers,
          signal: init?.signal,
          deadlineAt: session.deadline,
          cookieScoped: false,
          assertAuthorized: () => {
            if (disposed || session.controller.signal.aborted || now() >= session.deadline
              || liveSession(session.id, generation) !== session || session.approvedLongPoll !== requested) {
              throw new Error('E_MIMO_AUTH_FLOW')
            }
            return true
          },
        })).then(isolateDynamicResponse)
      }
      return fetchImpl(url, init)
    }
  }

  async function beginFlow(ticketId, generation) {
    const session = liveSession(ticketId, generation)
    if (session === null) return { ok: false, code: 'E_MIMO_AUTH_STALE_GENERATION' }
    let runtime
    try {
      runtime = await loadFlow()
    } catch {
      flowAvailable = false
      safeStatus(onStatus, { supported: false, code: ROUTE_CODES.FLOW, bootEpoch })
      try { manager.finish(generation, { state: 'failed', failure: { code: ROUTE_CODES.FLOW, stage: 'flow' } }) } catch { /* 已失效 */ }
      return { ok: false, code: ROUTE_CODES.FLOW }
    }
    if (disposed || manager.get(ticketId) !== session || session.state !== 'running') return { ok: false, code: 'E_MIMO_AUTH_STALE_GENERATION' }
    let secureTransport = null
    if (session.allowDynamicLongPoll === true) {
      try {
        let candidate = injectedSecureTransport
        if (candidate === null) {
          const secureRuntime = await import('./secure-transport.js')
          candidate = secureRuntime.createSecureTransport({ clock: now })
        }
        const capability = candidate.capability()
        if (capability === null || typeof capability !== 'object' || capability.ok !== true) throw new Error('E_MIMO_AUTH_FLOW')
        secureTransport = candidate
      } catch {
        try { manager.finish(generation, { state: 'failed', failure: { code: ROUTE_CODES.FLOW, stage: 'flow' } }) } catch { /* 已失效 */ }
        return { ok: false, code: ROUTE_CODES.FLOW }
      }
    }
    let flow
    try {
      flow = runtime.createMemoryFlow({
        now,
        limits: { hardMs: Math.max(1, session.deadline - now()) },
        fetchImpl: fetchFor(session, generation, secureTransport),
        jar: new runtime.CookieJar({ rootDomains: ['xiaomi.com', 'xiaomimimo.com'] }),
        parseBalance: parseMimoBalance,
        allowDynamicLongPoll: session.allowDynamicLongPoll === true,
        display: {
          async showQr({ bytes, mime }) {
            const result = manager.setQr(generation, bytes, mime)
            return result.ok ? { kind: 'shown' } : { kind: 'error', code: result.code }
          },
          askBalanceMatch: (view) => disposed ? Promise.resolve('later') : manager.requestBalanceMatch(generation, view),
          close() {},
        },
        approval: (payload) => manager.requestApproval(generation, {
          purpose: payload?.purpose,
          rawUrl: payload?.rawUrl,
          source: payload?.source,
        }),
      })
    } catch {
      try { manager.finish(generation, { state: 'failed', failure: { code: ROUTE_CODES.FLOW, stage: 'flow' } }) } catch { /* 已失效 */ }
      return { ok: false, code: ROUTE_CODES.FLOW }
    }
    const task = Promise.resolve()
      .then(() => flow.run({ signal: session.controller.signal }))
      .then((report) => {
        const done = report?.ok === true && report?.gates?.qr?.ok === true && report?.gates?.balance?.ok === true
        try {
          manager.finish(generation, {
            state: done ? 'done' : 'failed',
            failure: done ? null : failureFromReport({
              code: report?.code,
              stage: report?.stage,
              diagnostic: report?.diagnostic,
            }),
          })
        } catch { /* 已失效 */ }
      }, () => {
        try { manager.finish(generation, { state: 'failed', failure: { code: ROUTE_CODES.FLOW, stage: 'flow' } }) } catch { /* 已失效 */ }
      })
      .finally(() => { tasks.delete(task) })
    tasks.add(task)
    return { ok: true, code: ROUTE_CODES.OK }
  }

  function cancelFlow(ticketId) {
    const session = manager.get(ticketId)
    try { session?.controller?.abort() } catch { /* 已中止 */ }
  }

  async function withDeadline(promise, deadlineAt) {
    const remaining = Math.max(1, deadlineAt - now())
    let timer = null
    try {
      return await Promise.race([
        Promise.resolve().then(() => promise()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('E_REQUEST_TIMEOUT'), { code: 'E_REQUEST_TIMEOUT' })), remaining)
          timer?.unref?.()
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  const postQrRuntime = {
    enabled: postQrEnabled,
    async onApproved(ticketId, generation) {
      if (!postQrEnabled) return { ok: false, code: ROUTE_CODES.POSTQR_DISABLED }
      const session = manager.get(ticketId)
      if (session === null || session.postQr === null || session.postQr === undefined) {
        return { ok: true, code: ROUTE_CODES.OK, skipped: true }
      }
      if (session.postQr.approvedSource === null || session.postQr.approvalId === null) {
        return { ok: false, code: SESSION_CODES.APPROVAL_TARGET_INVALID }
      }
      const source = {
        url: session.postQr.approvedSource,
        approvalId: session.postQr.approvalId,
        sourceProof: session.postQr.approvedSourceProof,
      }
      try {
        const receipt = await postQrProducer({
          ticketId,
          generation,
          approvalId: source.approvalId,
          sourceUrl: source.url,
          sourceProof: source.sourceProof,
        })
        return manager.setPostQrAuthResult(generation, receipt, source)
      } catch {
        try { manager.finish(generation, { state: 'failed', failure: { code: 'E_CREDENTIAL_FIELD_INVALID', stage: 'flow' } }) } catch { /* 已失效 */ }
        return { ok: false, code: 'E_CREDENTIAL_FIELD_INVALID' }
      }
    },
    async readBalance(ticketId, generation) {
      if (!postQrEnabled) return { ok: false, code: ROUTE_CODES.POSTQR_DISABLED }
      const claimed = manager.claimReadBalance(ticketId, generation)
      if (claimed.ok !== true) return claimed
      const request = claimed.request
      try {
        const response = await withDeadline(
          () => postQrBalanceAdapter(request),
          request.deadlineAt,
        )
        if (response === null || typeof response !== 'object' || response.status !== 200) {
          return manager.failReadBalance(generation, 'E_BALANCE_HTTP')
        }
        let payload
        try { payload = await response.json() } catch { return manager.failReadBalance(generation, 'E_BALANCE_PARSE') }
        if (payload === null || typeof payload !== 'object' || payload.code !== 0) {
          return manager.failReadBalance(generation, 'E_BALANCE_CODE')
        }
        const parsed = parseMimoBalance(payload)
        if (parsed === null) return manager.failReadBalance(generation, 'E_BALANCE_PARSE')
        const completed = manager.completeReadBalance(generation, parsed)
        if (completed.ok === true) manager.requestBalanceMatch(generation, parsed)
        return completed
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'E_NETWORK'
        return manager.failReadBalance(generation, code === 'E_REQUEST_TIMEOUT' ? 'E_REQUEST_TIMEOUT' : 'E_NETWORK')
      }
    },
  }

  async function authHandler(request) {
    if (disposed) return json(503, { ok: false, code: ROUTE_CODES.UNAVAILABLE })
    const viewDisplay = routeDisplay
    if (request.method === 'GET') {
      return capability(bootEpoch, flowAvailable, flowAvailable ? ROUTE_CODES.OK : ROUTE_CODES.FLOW,
        viewDisplay.enabled, viewDisplay.namespace === null ? [] : [viewDisplay.namespace],
        consoleSnapshot(remembered === null ? consoleApi : null),
        rememberedSnapshot(rememberedApi))
    }
    if (!flowAvailable) return json(503, { ok: false, code: ROUTE_CODES.FLOW })
    return handleAuth(request, {
      bootEpoch, manager, beginFlow, cancelFlow, postQrRuntime,
      // managed 模式：display 只剩纯观察门面、console 分支关闭（旧变更动作 0 请求拒绝）
      display: viewDisplay,
      console: remembered === null ? consoleApi : null,
      consoleBusy, legacy,
      remembered: rememberedApi,
    })
  }

  async function qrHandler(request) {
    if (disposed) return json(503, { ok: false, code: ROUTE_CODES.UNAVAILABLE })
    return handleQr(request, { bootEpoch, manager })
  }

  try {
    disposers.push(ctx.connection.fetch.register({
      path: ROUTE_PATHS.AUTH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: authHandler,
    }))
    disposers.push(ctx.connection.fetch.register({
      path: ROUTE_PATHS.QR,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: qrHandler,
    }))
  } catch (error) {
    dispose()
    throw error
  }

  // managed 模式：启动**独立任务**做自动恢复（不在 read/status/caps 里 ensureAuth）。
  // 失败只体现在快照的固定码里，不会阻塞路由注册或其他渠道。
  if (remembered !== null) {
    // 公开配置事件：有就立即探测（Cordis 语义：返回 disposer，dispose 时解绑）
    if (typeof ctx.on === 'function') {
      try {
        const offConfig = ctx.on('app-boot/config-reload', () => { void probeEnabled() })
        if (typeof offConfig === 'function') disposers.push(offConfig)
      } catch { /* 无事件能力时靠 ≤1s 兜底 timer */ }
    }
    // 初始 fail closed：先探测一次；只有 enabled 才启动恢复任务（关闭时不开网络、不解密）
    trackTask(Promise.resolve(probeEnabled()).then((ok) => (ok === true ? remembered.boot() : null)))
    armEnabledWatch()
  }

  return {
    bootEpoch, manager, dispose, console: consoleSessions, display,
    /**
     * `routeDisplay` = **路由实际使用**的 display：
     * managed（记住登录）模式 = `remembered.displaySnapshot()` 的纯观察门面，
     * 否则 = 旧 legacy `display`。
     *
     * 供**同进程只读消费者**使用（例如 `usage_status` 的 MiMo 读数要与胶囊取同一份快照）——
     * 只允许 `peek()`；**不得**用于任何变更动作（managed 模式下 start/read/grant/confirm/stop
     * 一律固定拒绝）。`display` 保留原语义（旧 legacy manager），两者同时对外。
     */
    routeDisplay,
    remembered: rememberedApi,
    rememberedSession: remembered,
    idle: () => Promise.allSettled([...tasks]),
  }
}
