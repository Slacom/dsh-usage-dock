/**
 * MiMo 本机显示会话（sessionDisplay）· 独立内存 manager（2026-11-05）
 *
 * 目的：把「本人已核对身份 → 只读一次余额 → 本人余额比对」的结果，在**新的显式授权
 * （refreshGrant）**下做有界、可停止的持续刷新，供侧栏胶囊/详情显示。
 *
 * 与旧单次链的边界（不可混）：
 *   - **不调用**旧 `session.js` manager 的 start/begin/readBalance/claimReadBalance/
 *     authResultMemory，**不复用也不复制旧票**；凭证只来自本模块的 DI producer（合成边界）。
 *   - 旧路径「claim 后清 authResultMemory/accountRef」的销毁承诺**原样保留**，本模块不参与、
 *     不改写、也不从旧路径取任何材料。
 *   - 本模块的 `credential` 是**唯一 owner 持有**的私有引用（不经路由、不进 DTO、不落盘），
 *     只在本模块内部按 grant 交给 DI adapter；任何 stop/expire/dispose 立即清空。
 *
 * 纯内存、无 IO：producer / identityVerifier / balanceAdapter 是本模块唯一的出站边界，
 * 生产恒为 null（`enabled === false`，全部动作 fail-closed）。不写 cfg/secret/文件/日志。
 *
 * 限额（**临时本地界**，随产品批准调整；不是厂商策略，见 DISPLAY_LIMITS）：
 *   - 60 s 最小刷新间隔；从**收到凭证**起 15 min 本地持有上限（**不主张等于厂商有效期**）；
 *   - 无 grant 阶段（holding/verified）统一的 120 s 期限，从收到凭证起算，**不因 read/confirm 重置**；
 *   - 自动刷新最多 14 次**尝试**（含失败；首次读取不计）；连续 3 次暂时失败停止；
 *     单次 DI 操作 10 s 上限，**超时按 fail-stop 处理**（清值、取消 grant、不重试）。
 *
 * 生命周期自主性：`lifecycleTimer` 会自行到点清理，**不需要任何人先来读 status**；
 * timer 与 status 同时触发时判定幂等。
 */

import { randomBytes } from 'node:crypto'

export const DISPLAY_STATES = Object.freeze(['absent', 'holding', 'verified', 'stopped', 'expired'])

/**
 * 冻结限额。`credentialHoldMs / minIntervalMs = 15 ≥ maxAutoRefresh = 14`：
 * 14 次自动刷新一定落在本地持有上限之内，不会出现「第 15 次才撞上限」的边界。
 */
export const DISPLAY_LIMITS = Object.freeze({
  minIntervalMs: 60000,
  credentialHoldMs: 900000,
  pendingMs: 120000,
  maxAutoRefresh: 14,
  transientLimit: 3,
  operationTimeoutMs: 10000,
})

export const DISPLAY_CODES = Object.freeze({
  OK: 'E_NONE',
  DISABLED: 'E_MIMO_AUTH_DISPLAY_DISABLED',
  BAD_REQUEST: 'E_MIMO_AUTH_BAD_REQUEST',
  STALE_ID: 'E_MIMO_AUTH_DISPLAY_STALE_ID',
  ACTIVE: 'E_MIMO_AUTH_DISPLAY_ACTIVE',
  BUSY: 'E_MIMO_AUTH_DISPLAY_BUSY',
  READ_USED: 'E_MIMO_AUTH_DISPLAY_READ_USED',
  NOT_VERIFIED: 'E_MIMO_AUTH_DISPLAY_NOT_VERIFIED',
  CONFIRM_REQUIRED: 'E_MIMO_AUTH_DISPLAY_CONFIRM_REQUIRED',
  NO_PENDING: 'E_MIMO_AUTH_DISPLAY_NO_PENDING',
  GRANT_USED: 'E_MIMO_AUTH_DISPLAY_GRANT_USED',
  STOPPED: 'E_MIMO_AUTH_DISPLAY_STOPPED',
  TRANSIENT_LIMIT: 'E_MIMO_AUTH_DISPLAY_TRANSIENT_LIMIT',
  REFRESH_EXHAUSTED: 'E_MIMO_AUTH_DISPLAY_REFRESH_EXHAUSTED',
  PENDING_EXPIRED: 'E_MIMO_AUTH_DISPLAY_PENDING_EXPIRED',
  AUTH_REJECTED: 'E_MIMO_AUTH_DISPLAY_AUTH_REJECTED',
  IDENTITY_UNKNOWN: 'E_MIMO_AUTH_DISPLAY_IDENTITY_UNKNOWN',
  IDENTITY_MISMATCH: 'E_MIMO_AUTH_IDENTITY_MISMATCH',
  CREDENTIAL_INVALID: 'E_CREDENTIAL_FIELD_INVALID',
  CREDENTIAL_EXPIRED: 'E_MIMO_AUTH_SESSION_EXPIRED',
  TIMEOUT: 'E_REQUEST_TIMEOUT',
  NETWORK: 'E_NETWORK',
  BALANCE_HTTP: 'E_BALANCE_HTTP',
  BALANCE_CODE: 'E_BALANCE_CODE',
  BALANCE_PARSE: 'E_BALANCE_PARSE',
})

/** DTO 里允许出现的 code 上限（固定枚举；其余一律折叠，不透 DI 自由文本）。 */
export const DISPLAY_DTO_CODES = Object.freeze(Object.values(DISPLAY_CODES))

/**
 * 终止类判定集合：结果（`{ok:false,code,status}`）与抛错**共用同一判定**。
 * 超时（TIMEOUT）也在此列：本期采取 **fail-stop**，绝不在下一轮重试。
 */
export const DISPLAY_TERMINAL_CODES = Object.freeze([
  DISPLAY_CODES.AUTH_REJECTED,
  DISPLAY_CODES.IDENTITY_UNKNOWN,
  DISPLAY_CODES.IDENTITY_MISMATCH,
  DISPLAY_CODES.BALANCE_PARSE,
  DISPLAY_CODES.BALANCE_CODE,
  DISPLAY_CODES.TIMEOUT,
])
const TERMINAL_SET = new Set(DISPLAY_TERMINAL_CODES)
/** 暂时类：只认**明确**的网络错误码；429/5xx 由 HTTP 状态位判定。其余不明确一律终止。 */
const TEMP_ONLY = new Set([DISPLAY_CODES.NETWORK])

const HEX32 = /^[a-f0-9]{32}$/
const NS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ID_RE = /^[A-Za-z0-9._~+/=%-]{1,128}$/
const CURRENCY_RE = /^[A-Z]{2,8}$/
const MASK_MAX = 32
const LIVE_STATES = new Set(['holding', 'verified'])

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function codeOf(error) {
  const raw = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  return DISPLAY_DTO_CODES.includes(raw) ? raw : ''
}

/** 用户预期身份：{namespace, identifier}，只是**期望**，不是真实性证明。 */
export function normalizeExpected(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'identifier' || keys[1] !== 'namespace') return null
  const namespace = typeof value.namespace === 'string' ? value.namespace.trim() : ''
  const identifier = typeof value.identifier === 'string' ? value.identifier.trim() : ''
  if (!NS_RE.test(namespace) || !ID_RE.test(identifier)) return null
  return { namespace, identifier }
}

function normalizeIdentity(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return normalizeExpected({ namespace: value.namespace, identifier: value.identifier })
}

/** 遮蔽标签：只留尾部 4 位安全字符，长度上限 32；**仅展示**，不是身份依据。 */
export function maskOf(identifier) {
  const tail = String(identifier).slice(-4).replace(/[^A-Za-z0-9._~-]/g, '')
  return (tail.length > 0 ? 'u***' + tail : 'u***').slice(0, MASK_MAX)
}

/**
 * 余额投影：`balance` 必填，币种**必须可证**——缺失不默认 CNY（旧 session.js 的
 * projectBalance 会补 CNY，这里刻意不复用）；现金/赠金缺项**不造 0**。
 */
export function projectDisplayBalance(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const main = amount(raw.balance)
  if (main === null) return null
  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : ''
  if (!CURRENCY_RE.test(currency)) return null
  const out = { balance: main, currency }
  const cash = amount(raw.cashBalance)
  if (cash !== null) out.cashBalance = cash
  const gift = amount(raw.giftBalance)
  if (gift !== null) out.giftBalance = gift
  return out
}

/** DTO 基线（字段白名单；新增字段必须同时改这里与 client 的 picker）。 */
export function displayDtoBase() {
  return {
    displaySupported: false,
    selected: false,
    state: 'absent',
    displayId: null,
    generation: 0,
    // 非密单调修订号（当前 boot 内每次状态变化 +1；读 status **不**递增）
    revision: 0,
    identity: null,
    balance: null,
    fetchedAt: null,
    freshness: null,
    code: '',
    awaitingBalanceMatch: false,
    canRead: false,
    canGrant: false,
    canStop: false,
    refreshCount: 0,
    maxAutoRefresh: DISPLAY_LIMITS.maxAutoRefresh,
    nextRefreshAt: null,
    credentialExpiresAt: null,
    pendingExpiresAt: null,
    localLimits: {
      minIntervalMs: DISPLAY_LIMITS.minIntervalMs,
      credentialHoldMs: DISPLAY_LIMITS.credentialHoldMs,
      pendingMs: DISPLAY_LIMITS.pendingMs,
      maxAutoRefresh: DISPLAY_LIMITS.maxAutoRefresh,
      transientLimit: DISPLAY_LIMITS.transientLimit,
    },
  }
}

/**
 * 生产 disabled（DI 未注入）时的安全 DTO：纯观察、`displaySupported:false`、
 * `selected:false`、`state:'absent'`。**不得**表达成通信故障，否则正常胶囊会误把
 * "未支持"当成失败并永久遮蔽手工来源。
 */
export function absentDisplayDto() {
  return displayDtoBase()
}

/**
 * @param {object} options
 *   producer({signal, deadlineAt, expectedNamespace}) -> {credential} | 抛出 code
 *   identityVerifier({credential, signal, deadlineAt}) -> {identity:{namespace,identifier}}
 *   balanceAdapter({credential, purpose, signal, deadlineAt}) -> {identity, balance} | {code, status?} | 抛出 code
 *   namespace: 合成 DI 支持的 namespace（生产未证 ⇒ 不注入 ⇒ disabled）
 *   now / setTimeout / clearTimeout / randomId: 注入点（测试用 fakeClock，不真等 60 s）
 */
export function createDisplayManager(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const now = typeof source.now === 'function' ? source.now : Date.now
  const schedule = typeof source.setTimeout === 'function' ? source.setTimeout : globalThis.setTimeout
  const unschedule = typeof source.clearTimeout === 'function' ? source.clearTimeout : globalThis.clearTimeout
  const randomId = typeof source.randomId === 'function'
    ? source.randomId
    : () => randomBytes(16).toString('hex')
  const producer = typeof source.producer === 'function' ? source.producer : null
  const identityVerifier = typeof source.identityVerifier === 'function' ? source.identityVerifier : null
  const balanceAdapter = typeof source.balanceAdapter === 'function' ? source.balanceAdapter : null
  /**
   * [console 2026-11-06] **可选**凭据释放器（生产正式链 = console `disposeCredential`）。
   * 不传时（旧合成 DI）行为完全不变：没有任何资源需要释放。
   */
  const credentialDisposer = typeof source.credentialDisposer === 'function' ? source.credentialDisposer : null
  const namespace = typeof source.namespace === 'string' && NS_RE.test(source.namespace) ? source.namespace : null

  /** 释放一个**已不再属于本会话**的凭据引用（绝不依赖 GC）。 */
  function releaseCredential(value) {
    if (value === null || value === undefined) return
    if (credentialDisposer === null) return
    try { credentialDisposer(value) } catch { /* 释放失败不得影响状态机 */ }
  }
  /** producer 迟到产物 / 被放弃的产物：立即释放（不交给 GC 猜）。 */
  function disposeProduced(value) {
    if (value === null || typeof value !== 'object') return
    releaseCredential(value.credential === undefined ? null : value.credential)
  }
  /** 放弃一个 producer 产物槽：已到的立刻释放；还没到的，到达时自行释放。 */
  function discardProduce(slot) {
    if (slot === null || slot === undefined) return
    slot.discarded = true
    const value = slot.value
    slot.value = null
    if (value !== null) disposeProduced(value)
  }

  /** 三件 DI + namespace 齐备才启用；生产恒为 null（fail-closed，UI/JSON 布尔无法启用）。 */
  const enabled = producer !== null && identityVerifier !== null && balanceAdapter !== null && namespace !== null

  let display = null
  let generation = 0
  let disposed = false
  /** selected 墓碑：进程内跨 stopped/expired 保留，阻止手工旧值回填；重启即 absent。 */
  let tombstone = false

  const ok = (code = DISPLAY_CODES.OK) => ({ ok: true, code, display: dto() })
  const fail = (code) => ({ ok: false, code, display: dto() })
  const refused = () => fail(DISPLAY_CODES.DISABLED)

  function liveTarget(d) {
    return !disposed && d !== null && display === d && LIVE_STATES.has(d.state)
  }

  function matching(displayId, gen) {
    if (disposed || display === null) return null
    if (typeof displayId !== 'string' || !HEX32.test(displayId) || displayId !== display.id) return null
    if (!Number.isSafeInteger(gen) || gen !== display.gen) return null
    if (!LIVE_STATES.has(display.state)) return null
    return display
  }

  /**
   * 开启一次 operation：统一设置 `opDeadline = min(now+10s, 阶段界)`。
   * 同一 operation 内（producer→verifier）**沿用**这个 deadline，不重给 10 s。
   * `cleanup()` 供 stop/dispose 立刻取消该 operation 的 timeout（不留旧 timer）。
   */
  function beginOp(d, phaseDeadline) {
    const token = d.opToken + 1
    d.opToken = token
    const controller = new AbortController()
    const cap = typeof phaseDeadline === 'number' && Number.isFinite(phaseDeadline)
      ? phaseDeadline : Number.MAX_SAFE_INTEGER
    d.opDeadline = Math.min(now() + DISPLAY_LIMITS.operationTimeoutMs, cap)
    d.opController = controller
    d.opCleanup = null
    return { token, controller, cleanup: null }
  }

  /** 代次/控制器都必须对得上；旧会话的 task 永远不能被视为 live。 */
  function opLive(d, op) {
    if (disposed || display !== d || d.opToken !== op.token || !LIVE_STATES.has(d.state)) return false
    if (d.opController !== op.controller) return false
    return true
  }

  function endOp(d, op) {
    if (typeof op.cleanup === 'function') { try { op.cleanup() } catch { /* 忽略 */ } op.cleanup = null }
    if (d.opController === op.controller) { d.opController = null; d.opCleanup = null }
  }

  /** 先 invalidate（推进 opToken）→ 取消 timeout → 再 abort（abort 监听可能同步 reentry）。 */
  function invalidateOp(d) {
    const controller = d.opController
    const cleanup = d.opCleanup
    d.opToken += 1
    d.opController = null
    d.opCleanup = null
    if (typeof cleanup === 'function') { try { cleanup() } catch { /* 忽略 */ } }
    try { controller?.abort() } catch { /* 已中止 */ }
  }

  /**
   * 有界执行：**接收工厂**（不是已求值的 Promise），先核对 live + deadline **再真正调用**
   * （deadline 已过 ⇒ 零调用）；同步 throw 也被捕获。
   * 超时/迟到 = **fail-stop**：只影响**本次 operation 所属的会话**（`haltFor(d, …)`），
   * 绝不在旧 timer 里全局 halt 掉后来新建的会话。
   */
  function bounded(d, op, factory) {
    return new Promise((resolve, reject) => {
      if (!opLive(d, op)) { reject(coded(DISPLAY_CODES.STALE_ID)); return }
      if (now() >= d.opDeadline) { reject(coded(DISPLAY_CODES.TIMEOUT)); return }
      let settled = false
      let timer = null
      const signal = op.controller.signal
      let onAbort = null
      const detach = () => {
        if (onAbort !== null && signal !== null && signal !== undefined
          && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        onAbort = null
      }
      const clear = () => { if (timer !== null) { unschedule(timer); timer = null } }
      // 统一出口：清 timer + 摘 abort 监听 + settle（stop/dispose 后不会留下永不 settle 的 promise）
      const bail = (code) => {
        if (settled) return
        settled = true
        clear()
        detach()
        reject(coded(code))
      }
      // 外部 abort（stop/dispose/invalidate）立刻 settle，不依赖 factory 是否理会 signal
      onAbort = () => { bail(DISPLAY_CODES.STALE_ID) }
      if (signal !== null && signal !== undefined && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      op.cleanup = () => { bail(DISPLAY_CODES.STALE_ID) }
      if (d.opController === op.controller) d.opCleanup = op.cleanup
      const left = Math.max(1, d.opDeadline - now())
      timer = schedule(() => {
        if (settled) return
        // 归属校验：旧会话已 stop / 新会话已 start / 控制器已换 ⇒ 只丢弃，不动任何全局状态。
        if (disposed || display !== d || d.opToken !== op.token || d.opController !== op.controller) {
          bail(DISPLAY_CODES.STALE_ID)
          return
        }
        settled = true
        clear()
        detach()
        haltFor(d, DISPLAY_CODES.TIMEOUT) // 只停**这一个**会话
        reject(coded(DISPLAY_CODES.TIMEOUT))
      }, left)
      timer?.unref?.()
      let running
      try {
        running = factory()
      } catch (error) {
        settled = true
        clear()
        detach()
        reject(error)
        return
      }
      Promise.resolve(running).then((value) => {
        if (settled) return
        // 迟到结果（事件循环阻塞导致 timer 没来得及跑）同样按超时 fail-stop，不接受。
        if (now() >= d.opDeadline) {
          settled = true
          clear()
          detach()
          haltFor(d, DISPLAY_CODES.TIMEOUT)
          reject(coded(DISPLAY_CODES.TIMEOUT))
          return
        }
        settled = true
        clear()
        detach()
        resolve(value)
      }, (error) => {
        if (settled) return
        settled = true
        clear()
        detach()
        reject(error)
      })
    })
  }

  /**
   * 非密**全局**修订号：manager 级单调递增、**跨 display 代次不重置**。
   * （若每个新会话从 1 重新计数，客户端会把「新 generation 的低 revision」误判成旧状态而丢弃。）
   */
  let revisionSeq = 0
  function bump(d) {
    revisionSeq += 1
    d.revision = revisionSeq
    return d.revision
  }

  /**
   * 停止**指定会话**：先清 owned 字段并标记状态，再失效/取消 timeout/abort。
   * 只对 `display === d` 生效，防止 reentry 或旧 timer 误停新会话。
   */
  function haltFor(d, code) {
    if (d === null || d === undefined || display !== d) return
    // 先摘引用（owned state 清干净）→ 再释放旧 handle / 放弃在途产物
    const ownedCredential = d.credential
    const ownedProduce = d.pendingProduce === undefined ? null : d.pendingProduce
    d.pendingProduce = null
    d.state = 'stopped'
    d.code = code
    d.credential = null
    d.actual = null
    d.expected = null
    d.grant = null
    d.value = null
    d.fetchedAt = null
    d.freshness = null
    d.identityMasked = null
    d.confirmedByUser = null
    d.awaitingBalanceMatch = false
    d.pendingDeadline = null
    d.readUsed = true
    bump(d)
    if (d.lifeTimer !== null) { unschedule(d.lifeTimer); d.lifeTimer = null }
    if (d.timer !== null) { unschedule(d.timer); d.timer = null }
    invalidateOp(d)
    tombstone = true
    if (ownedProduce !== null) discardProduce(ownedProduce)
    releaseCredential(ownedCredential)
  }

  /** 兼容旧调用点：等于 haltFor(当前会话)。 */
  function halt(code) {
    haltFor(display, code)
  }

  function expireAt(code) {
    const d = display
    if (d === null) return
    halt(code)
    d.state = 'expired'
    d.code = code
    bump(d)
  }

  /** 惰性到期判定（status 与自主 timer 都会走这里，幂等）。 */
  function expireIfDue() {
    const d = display
    if (d === null || !LIVE_STATES.has(d.state)) return
    if (now() >= d.credentialExpiresAt) { expireAt(DISPLAY_CODES.CREDENTIAL_EXPIRED); return }
    if (d.grant === null && d.pendingDeadline !== null && now() >= d.pendingDeadline) {
      // 无 grant 阶段到期：清 credential / value / expected / actual / mask。
      halt(DISPLAY_CODES.PENDING_EXPIRED)
    }
  }

  /** 自主生命周期 timer：无 grant 阶段取 pending/hold 中较早者；到点自行清理。 */
  function armLifecycle(d) {
    if (d.lifeTimer !== null) { unschedule(d.lifeTimer); d.lifeTimer = null }
    if (!LIVE_STATES.has(d.state)) return
    const targets = [d.credentialExpiresAt]
    if (d.grant === null && d.pendingDeadline !== null) targets.push(d.pendingDeadline)
    const at = Math.min(targets[0], targets[1] === undefined ? targets[0] : targets[1])
    d.lifeTimer = schedule(() => {
      d.lifeTimer = null
      if (disposed || display !== d) return
      expireIfDue()
      if (display === d && LIVE_STATES.has(d.state)) armLifecycle(d)
    }, Math.max(1, at - now()))
    d.lifeTimer?.unref?.()
  }

  /** 结果分类：401/403 与终止类一律终止；只有明确的 network/429/5xx 才算暂时。 */
  function classifyFailure(result) {
    const status = typeof result.status === 'number' ? result.status : 0
    const code = typeof result.code === 'string' && DISPLAY_DTO_CODES.includes(result.code) ? result.code : ''
    if (status === 401 || status === 403) return { kind: 'terminal', code: DISPLAY_CODES.AUTH_REJECTED }
    if (TERMINAL_SET.has(code)) return { kind: 'terminal', code }
    if (status === 429 || (status >= 500 && status <= 599)) {
      return { kind: 'temp', code: code || DISPLAY_CODES.BALANCE_HTTP }
    }
    if (TEMP_ONLY.has(code)) return { kind: 'temp', code }
    return { kind: 'terminal', code: code || DISPLAY_CODES.BALANCE_PARSE }
  }

  function classifyThrow(error) {
    const code = codeOf(error)
    // throw 出来的对象也可能只带 status（如 throw {status:403}）：与 result 走同一分类。
    const status = error !== null && typeof error === 'object' && typeof error.status === 'number'
      ? error.status : 0
    if (status === 401 || status === 403) return { kind: 'terminal', code: DISPLAY_CODES.AUTH_REJECTED }
    if (status === 429 || (status >= 500 && status <= 599)) {
      return { kind: 'temp', code: code !== '' && TEMP_ONLY.has(code) ? code : DISPLAY_CODES.NETWORK }
    }
    if (TERMINAL_SET.has(code)) return { kind: 'terminal', code }
    if (TEMP_ONLY.has(code)) return { kind: 'temp', code }
    // 未知错误一律终止（不把"不认识"当暂时失败重试）。
    return { kind: 'terminal', code: DISPLAY_CODES.BALANCE_PARSE }
  }

  function transientFailure(d, code) {
    d.failures += 1
    d.code = code
    if (d.value !== null) d.freshness = 'stale'
    bump(d)
    if (d.failures >= DISPLAY_LIMITS.transientLimit) {
      halt(DISPLAY_CODES.TRANSIENT_LIMIT)
      return fail(DISPLAY_CODES.TRANSIENT_LIMIT)
    }
    return fail(code)
  }

  function applyBalance(d, result) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      halt(DISPLAY_CODES.BALANCE_PARSE)
      return fail(DISPLAY_CODES.BALANCE_PARSE)
    }
    if (result.ok !== true) {
      const verdict = classifyFailure(result)
      if (verdict.kind === 'terminal') {
        halt(verdict.code) // 401/403 → AUTH_REJECTED；不表述为"厂商侧过期"（TTL 未证）
        return fail(verdict.code)
      }
      return transientFailure(d, verdict.code)
    }
    // 每次结果都必须绑定同一内部账号；变号/不明一律停并清（不拿旧值顶着）。
    const identity = normalizeIdentity(result.identity)
    if (identity === null || d.actual === null
      || identity.namespace !== d.actual.namespace || identity.identifier !== d.actual.identifier) {
      halt(DISPLAY_CODES.IDENTITY_MISMATCH)
      return fail(DISPLAY_CODES.IDENTITY_MISMATCH)
    }
    const value = projectDisplayBalance(result.balance)
    if (value === null) {
      halt(DISPLAY_CODES.BALANCE_PARSE)
      return fail(DISPLAY_CODES.BALANCE_PARSE)
    }
    d.value = value
    d.fetchedAt = now()
    d.freshness = 'fresh'
    d.failures = 0
    d.code = DISPLAY_CODES.OK
    bump(d)
    return null
  }

  function dto() {
    const base = displayDtoBase()
    base.displaySupported = enabled && !disposed
    base.selected = tombstone
    const d = display
    if (d === null) return base
    const active = LIVE_STATES.has(d.state)
    return Object.assign(base, {
      selected: true,
      state: d.state,
      displayId: d.id,
      generation: d.gen,
      revision: d.revision,
      identity: d.identityMasked === null ? null : { maskedLabel: d.identityMasked },
      balance: d.value === null ? null : Object.assign({}, d.value),
      fetchedAt: d.fetchedAt,
      freshness: d.freshness,
      code: typeof d.code === 'string' ? d.code : '',
      awaitingBalanceMatch: d.awaitingBalanceMatch === true,
      canRead: active && d.state === 'verified' && d.readUsed !== true && d.opController === null,
      canGrant: active && d.state === 'verified' && d.value !== null
        && d.confirmedByUser === 'match' && d.grant === null,
      canStop: active,
      refreshCount: d.grant === null ? 0 : d.grant.used,
      nextRefreshAt: d.grant === null ? null : d.grant.nextAt,
      credentialExpiresAt: d.credentialExpiresAt,
      pendingExpiresAt: d.pendingDeadline,
    })
  }

  /** 定时刷新：单飞（opController 非空即跳过）+ 到期/次数用尽即停。 */
  function arm(d) {
    if (d.timer !== null) { unschedule(d.timer); d.timer = null }
    if (d.grant === null || !LIVE_STATES.has(d.state)) return
    const dueAt = Math.min(d.grant.nextAt, d.credentialExpiresAt)
    const delay = Math.max(1, dueAt - now())
    d.timer = schedule(() => {
      d.timer = null
      if (disposed || display !== d) return
      tick(d)
    }, delay)
    d.timer?.unref?.()
  }

  async function tick(d) {
    expireIfDue()
    if (d.state !== 'verified' || d.grant === null) return
    const grant = d.grant
    // B4：**attempt** 预算——调用前同步计数（含失败）；超限/过期立即停止发送。
    if (grant.used >= grant.maxAutoRefresh) { halt(DISPLAY_CODES.REFRESH_EXHAUSTED); return }
    if (now() >= grant.deadlineAt || now() >= d.credentialExpiresAt) {
      halt(DISPLAY_CODES.REFRESH_EXHAUSTED)
      return
    }
    if (d.opController !== null) return // 在途：不排队、不并发
    grant.used += 1
    bump(d)
    const op = beginOp(d, Math.min(grant.deadlineAt, d.credentialExpiresAt))
    try {
      const result = await bounded(d, op, () => balanceAdapter({
        credential: d.credential,
        purpose: 'balance',
        signal: op.controller.signal,
        deadlineAt: d.opDeadline,
      }))
      if (!opLive(d, op)) return
      applyBalance(d, result)
      if (display === d && d.state === 'verified' && d.grant === grant) {
        if (grant.used >= grant.maxAutoRefresh) { halt(DISPLAY_CODES.REFRESH_EXHAUSTED); return }
        grant.nextAt = now() + grant.intervalMs
        arm(d)
      }
    } catch (error) {
      // 超时已在 bounded 内 fail-stop（halt），这里只按已记录状态返回，绝不重试。
      if (!opLive(d, op)) return
      const verdict = classifyThrow(error)
      if (verdict.kind === 'terminal') { halt(verdict.code); return }
      transientFailure(d, verdict.code)
      if (display === d && d.state === 'verified' && d.grant === grant) {
        if (grant.used >= grant.maxAutoRefresh) { halt(DISPLAY_CODES.REFRESH_EXHAUSTED); return }
        grant.nextAt = now() + grant.intervalMs
        arm(d)
      }
    } finally {
      endOp(d, op)
    }
  }

  async function start(input = {}) {
    if (disposed || !enabled) return refused()
    const expected = normalizeExpected(input !== null && typeof input === 'object' ? input.expected : null)
    if (expected === null) return fail(DISPLAY_CODES.BAD_REQUEST)
    if (expected.namespace !== namespace) return fail(DISPLAY_CODES.BAD_REQUEST)
    if (display !== null && LIVE_STATES.has(display.state)) return fail(DISPLAY_CODES.ACTIVE)
    generation += 1
    const receivedAt = now()
    const d = {
      id: randomId(),
      gen: generation,
      revision: 0,
      state: 'holding',
      code: DISPLAY_CODES.OK,
      expected,
      actual: null,
      identityMasked: null,
      receivedAt,
      credentialExpiresAt: receivedAt + DISPLAY_LIMITS.credentialHoldMs,
      // 无 grant 阶段的统一期限：从**收到凭证**起算，不因 read/confirm 重置。
      pendingDeadline: receivedAt + DISPLAY_LIMITS.pendingMs,
      credential: null,
      pendingProduce: null,
      value: null,
      fetchedAt: null,
      freshness: null,
      confirmedByUser: null,
      awaitingBalanceMatch: false,
      readUsed: false,
      grant: null,
      failures: 0,
      timer: null,
      lifeTimer: null,
      opToken: 0,
      opController: null,
      opCleanup: null,
      opDeadline: 0,
    }
    display = d
    tombstone = true
    bump(d) // 首个 revision 也取自**全局**序列（跨 display 代次单调，不重置）
    const op = beginOp(d) // opDeadline = now+10s（producer 阶段自身的界）
    // producer 产物槽：任何**没被本会话接手**的结果都必须显式释放
    // （超时/取消/stop/换会话之后迟到，或 start 的 await 回来时 op 已不 live）
    const slot = { discarded: false, value: null, settled: false }
    d.pendingProduce = slot
    try {
      // 同一 operation 共享总预算：verifier 沿用 d.opDeadline，不重给 10 s。
      const produced = await bounded(d, op, () => {
        const running = producer({
          namespace,
          signal: op.controller.signal,
          deadlineAt: d.opDeadline,
        })
        Promise.resolve(running).then((value) => {
          slot.settled = true
          if (slot.discarded === true) { disposeProduced(value); return }
          slot.value = value
        }, () => { slot.settled = true })
        return running
      })
      if (!opLive(d, op)) {
        if (d.pendingProduce === slot) d.pendingProduce = null
        discardProduce(slot)
        return fail(DISPLAY_CODES.STALE_ID)
      }
      const credential = produced !== null && typeof produced === 'object' ? produced.credential : null
      if (credential === null || typeof credential !== 'object') {
        if (d.pendingProduce === slot) d.pendingProduce = null
        discardProduce(slot)
        halt(DISPLAY_CODES.CREDENTIAL_INVALID)
        return fail(DISPLAY_CODES.CREDENTIAL_INVALID)
      }
      // 接手：槽位作废（不再二次释放），唯一 owner 直接入库，不产生第二份副本
      slot.discarded = true
      slot.value = null
      if (d.pendingProduce === slot) d.pendingProduce = null
      d.credential = credential
      // **拿到凭证才算 receivedAt**：hold/pending 都从这里起算（producer 耗时不吃这两条预算）。
      const receivedAt = now()
      d.receivedAt = receivedAt
      d.credentialExpiresAt = receivedAt + DISPLAY_LIMITS.credentialHoldMs
      d.pendingDeadline = receivedAt + DISPLAY_LIMITS.pendingMs
      armLifecycle(d)
      const verified = await bounded(d, op, () => identityVerifier({
        credential: d.credential,
        signal: op.controller.signal,
        deadlineAt: d.opDeadline,
      }))
      if (!opLive(d, op)) return fail(DISPLAY_CODES.STALE_ID)
      const actual = normalizeIdentity(verified !== null && typeof verified === 'object' ? verified.identity : null)
      if (actual === null) {
        halt(DISPLAY_CODES.IDENTITY_UNKNOWN)
        return fail(DISPLAY_CODES.IDENTITY_UNKNOWN)
      }
      if (actual.namespace !== expected.namespace || actual.identifier !== expected.identifier) {
        // actual 绝不反算 expected；此处只做"可信 verifier 输出 vs 用户预期"的比较。
        halt(DISPLAY_CODES.IDENTITY_MISMATCH)
        return fail(DISPLAY_CODES.IDENTITY_MISMATCH)
      }
      d.actual = actual
      d.identityMasked = maskOf(actual.identifier)
      d.state = 'verified'
      d.code = DISPLAY_CODES.OK
      bump(d)
      armLifecycle(d)
      endOp(d, op) // 先结束 operation，DTO 里的 canRead 才是真实的
      return ok()
    } catch (error) {
      const code = codeOf(error)
      if (d.pendingProduce === slot) d.pendingProduce = null
      discardProduce(slot)
      if (!opLive(d, op)) {
        // 超时已在 bounded 内 fail-stop；按已记录码回报，不漏状态。
        if (display === d && d.state === 'stopped' && d.code === code && code !== '') return fail(code)
        return fail(DISPLAY_CODES.STALE_ID)
      }
      halt(code || DISPLAY_CODES.CREDENTIAL_INVALID)
      return fail(code || DISPLAY_CODES.CREDENTIAL_INVALID)
    } finally {
      endOp(d, op)
    }
  }

  function status() {
    if (disposed) return { ok: true, code: DISPLAY_CODES.DISABLED, display: dto() }
    expireIfDue()
    return { ok: true, code: DISPLAY_CODES.OK, display: dto() }
  }

  async function read(displayId, gen) {
    const d = matching(displayId, gen)
    if (d === null) return fail(DISPLAY_CODES.STALE_ID)
    expireIfDue()
    if (!liveTarget(d)) return fail(DISPLAY_CODES.NOT_VERIFIED)
    if (d.readUsed === true) return fail(DISPLAY_CODES.READ_USED)
    if (d.opController !== null) return fail(DISPLAY_CODES.BUSY)
    d.readUsed = true // 同步原子 claim：第二次 read 一律拒绝
    bump(d)
    const op = beginOp(d, d.pendingDeadline === null ? d.credentialExpiresAt : d.pendingDeadline)
    try {
      const result = await bounded(d, op, () => balanceAdapter({
        credential: d.credential,
        purpose: 'balance',
        signal: op.controller.signal,
        deadlineAt: d.opDeadline,
      }))
      if (!opLive(d, op)) return fail(DISPLAY_CODES.STALE_ID)
      const applied = applyBalance(d, result)
      if (applied !== null) return applied
      d.awaitingBalanceMatch = true
      bump(d)
      endOp(d, op) // 先结束 operation，DTO 的 canGrant/awaiting 才是真实的
      return ok()
    } catch (error) {
      const code = codeOf(error)
      if (!opLive(d, op)) {
        if (display === d && d.state === 'stopped' && d.code === code && code !== '') return fail(code)
        return fail(DISPLAY_CODES.STALE_ID)
      }
      const verdict = classifyThrow(error)
      if (verdict.kind === 'terminal') { halt(verdict.code); return fail(verdict.code) }
      return transientFailure(d, verdict.code)
    } finally {
      endOp(d, op)
    }
  }

  function confirm(displayId, gen, verdict) {
    const d = matching(displayId, gen)
    if (d === null) return fail(DISPLAY_CODES.STALE_ID)
    if (verdict !== 'match' && verdict !== 'mismatch' && verdict !== 'later') return fail(DISPLAY_CODES.BAD_REQUEST)
    if (d.awaitingBalanceMatch !== true) return fail(DISPLAY_CODES.NO_PENDING)
    if (verdict === 'mismatch') {
      halt(DISPLAY_CODES.IDENTITY_MISMATCH)
      return { ok: false, code: DISPLAY_CODES.IDENTITY_MISMATCH, display: dto() }
    }
    d.confirmedByUser = verdict
    d.awaitingBalanceMatch = false
    // 注意：**不**重置 pendingDeadline。无 grant 阶段的 120 s 期限从收到凭证起算，
    // 覆盖 verify→未 read→待 confirm→match 待 grant 的整个过程。
    d.code = DISPLAY_CODES.OK
    bump(d)
    return ok()
  }

  /** G5：只有「本人余额比对 match」之后才能建立**新的**持续刷新授权。 */
  function grant(displayId, gen) {
    const d = matching(displayId, gen)
    if (d === null) return fail(DISPLAY_CODES.STALE_ID)
    expireIfDue()
    if (!liveTarget(d)) return fail(DISPLAY_CODES.NOT_VERIFIED)
    if (d.value === null || d.confirmedByUser !== 'match') return fail(DISPLAY_CODES.CONFIRM_REQUIRED)
    if (d.grant !== null) return fail(DISPLAY_CODES.GRANT_USED)
    const from = now()
    d.pendingDeadline = null // grant 接管：取消无-grant 阶段期限，仅保留 hold 界
    d.grant = {
      grantedAt: from,
      intervalMs: DISPLAY_LIMITS.minIntervalMs,
      maxAutoRefresh: DISPLAY_LIMITS.maxAutoRefresh,
      used: 0,
      // 本地界；若将来可从受信适配证明厂商 exp，才取 min(exp, 本地界)。
      // 次数由 `used >= maxAutoRefresh` 管；这里的 deadline 是**兜底**，取 (max+1) 个间隔，
      // 以免把"第 max 次刷新"本身也挡在门外（off-by-one）。
      deadlineAt: Math.min(d.credentialExpiresAt, from + DISPLAY_LIMITS.minIntervalMs * (DISPLAY_LIMITS.maxAutoRefresh + 1)),
      nextAt: from + DISPLAY_LIMITS.minIntervalMs,
    }
    arm(d)
    armLifecycle(d)
    bump(d)
    return ok()
  }

  /** 独立停止：幂等（absent/已停止/已过期也返回 ok），**绝不复用旧 cancelFlow**。 */
  function stop(displayId, gen) {
    if (disposed) return refused()
    if (display === null) return ok()
    if (display.state === 'stopped' || display.state === 'expired') return ok()
    const d = matching(displayId, gen)
    if (d === null) return fail(DISPLAY_CODES.STALE_ID)
    halt(DISPLAY_CODES.STOPPED)
    return ok()
  }

  function dispose() {
    if (disposed) return { ok: true }
    disposed = true // 先标记，再 abort（防 reentry 看到可继续状态）
    const d = display
    let ownedCredential = null
    let ownedProduce = null
    if (d !== null) {
      // 先清 owned state，再释放旧 handle / 放弃在途产物
      ownedCredential = d.credential
      ownedProduce = d.pendingProduce === undefined ? null : d.pendingProduce
      d.pendingProduce = null
      if (d.lifeTimer !== null) { unschedule(d.lifeTimer); d.lifeTimer = null }
      if (d.timer !== null) { unschedule(d.timer); d.timer = null }
      invalidateOp(d)
      d.credential = null
      d.actual = null
      d.expected = null
      d.grant = null
      d.value = null
      d.identityMasked = null
      d.pendingDeadline = null
    }
    display = null
    tombstone = false
    if (ownedProduce !== null) discardProduce(ownedProduce)
    releaseCredential(ownedCredential)
    return { ok: true }
  }

  return {
    enabled,
    namespace,
    limits: DISPLAY_LIMITS,
    start,
    status,
    read,
    confirm,
    grant,
    stop,
    dispose,
    // 仅测试/离线诊断使用：不参与路由、不改变安全边界。
    peek: () => dto(),
  }
}
