/**
 * console-session.js — 正式 console 扫码登录的 **pre-auth owner**（Host-only、纯内存）
 *
 * 职责边界（与旧 `session.js` 完全不共享状态、不复用旧票）：
 *   - `start()` 只做**本地**事：随机 authId(32 hex) + 正 generation + 120 s 独立期限；
 *     不联网、不加载 vendor flow、不 ensureAuth。
 *   - `begin()` 才异步启动**真实** `console-protocol`（真实 authority/transport）。
 *   - `status()` 是纯观察：零 vendor 调用、零网络；`takeQr()` 一次性交付内存里的二维码字节。
 *   - regional 目标只在这里挂**私有** pending resolver；status 只暴露
 *     `{approvalId, origin, purpose, method}`，**不含** rawURL / query / token。
 *   - `stop()` / 到期 / `dispose()`：先失效（状态+revision）→ 清 QR/expected/审批 →
 *     resolve 待审批为 false → `protocol.dispose()`。到期由**自己的 timer** 完成，
 *     即使没有任何人轮询 status 也会自动清。
 *
 * 凭据交接（仅 Host 代码可调，不经路由）：
 *   `getExpectedForAttach()` → `claim()`（同步一次，把 protocol 从 pre-auth 记录移进
 *   私有 WeakMap 的 opaque 空 handle，不留第二个强引用或 timer）→ display 持有唯一 handle →
 *   `verifyCredential()` / `readCredential()` / `disposeCredential()`。
 *   claim 之后 lease 从 preauth 切到 display：清 pre-auth 状态**不会**让 isLive 变 false；
 *   反之 `stop()` 一个已 claim 的记录也**不会**偷偷停掉 display（displayStop 独立负责）。
 */

import { randomBytes } from 'node:crypto'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES } from './console-protocol.js'
import { normalizeExpected } from './session-display.js'

/** 正式登录只支持这一个命名空间（固定，不从 route/UI 收）。 */
export const CONSOLE_SESSION_NAMESPACE = 'xiaomi-account-user-id'

export const CONSOLE_SESSION_LIMITS = Object.freeze({
  /** pre-auth（含 ready 等待 attach）的独立期限；不因 read/confirm/attach 重置。 */
  pendingMs: 120000,
  /** 二维码图片字节上限（内存交付，不进 JSON）。 */
  qrMaxBytes: 256 * 1024,
})

export const CONSOLE_SESSION_CODES = Object.freeze({
  OK: 'E_NONE',
  DISABLED: 'E_MIMO_CONSOLE_SESSION_DISABLED',
  BAD_REQUEST: 'E_MIMO_AUTH_BAD_REQUEST',
  STALE_ID: 'E_MIMO_CONSOLE_STALE_ID',
  BUSY: 'E_MIMO_CONSOLE_SESSION_BUSY',
  BEGIN_USED: 'E_MIMO_CONSOLE_BEGIN_USED',
  NOT_READY: 'E_MIMO_CONSOLE_NOT_READY',
  QR_UNAVAILABLE: 'E_MIMO_CONSOLE_QR_UNAVAILABLE',
  APPROVAL_MISSING: 'E_MIMO_AUTH_APPROVAL_MISSING',
  APPROVAL_UNKNOWN: 'E_MIMO_AUTH_APPROVAL_UNKNOWN',
  APPROVAL_EXPIRED: 'E_MIMO_AUTH_APPROVAL_EXPIRED',
  EXPIRED: 'E_MIMO_AUTH_TARGET_EXPIRED',
  CREDENTIAL_INVALID: 'E_MIMO_CONSOLE_CREDENTIAL_INVALID',
  SUPPORTED: 'E_MIMO_AUTH_UNSUPPORTED',
})

const S = CONSOLE_SESSION_CODES
const KNOWN = new Set(Object.values(S))
const coded = (code) => Object.assign(new Error(KNOWN.has(code) ? code : S.SUPPORTED), { code: KNOWN.has(code) ? code : S.SUPPORTED })

const HEX32 = /^[a-f0-9]{32}$/
const LIVE = new Set(['idle', 'authorizing', 'ready'])
/** 协议错误码白名单（DTO 只用固定枚举，不透上游自由文本）。 */
const PROTOCOL_CODES = new Set(Object.values(CONSOLE_PROTOCOL_CODES))
const FLOW = 'E_MIMO_CONSOLE_FLOW'

function protocolCodeOf(error) {
  const c = error !== null && typeof error === 'object' ? error.code : ''
  return PROTOCOL_CODES.has(c) ? c : FLOW
}

/**
 * @param {object} options
 * @param {string} options.bootEpoch 32 hex（每个 boot 一个）
 * @param {() => number} [options.now]
 * @param {Function} [options.setTimeout]
 * @param {Function} [options.clearTimeout]
 * @param {object} [options.transportDeps] 只给**代码级**测试注入 fakeDNS/request；
 *        生产不传 ⇒ 真实 node:https + node:dns。
 */
export function createConsoleSessionManager(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const bootEpoch = typeof source.bootEpoch === 'string' && source.bootEpoch !== '' ? source.bootEpoch : ''
  const now = typeof source.now === 'function' ? source.now : Date.now
  const schedule = typeof source.setTimeout === 'function' ? source.setTimeout : globalThis.setTimeout
  const unschedule = typeof source.clearTimeout === 'function' ? source.clearTimeout : globalThis.clearTimeout
  const transportDeps = source.transportDeps !== null && typeof source.transportDeps === 'object'
    ? { ...source.transportDeps }
    : {}

  let record = null
  let generation = 0
  let revisionSeq = 0
  let disposed = false
  /** handle(opaque 空对象) → { protocol, lease, authId, generation } */
  const credentials = new WeakMap()

  function bump(r) {
    revisionSeq += 1
    r.revision = revisionSeq
    return r.revision
  }

  function dto() {
    const base = {
      supported: disposed !== true,
      state: 'absent',
      authId: null,
      generation: 0,
      revision: revisionSeq,
      code: '',
      expiresAt: null,
      hasQr: false,
      identity: null,
      approval: null,
      canBegin: false,
      canAttach: false,
      canStop: false,
    }
    const r = record
    if (r === null) return base
    return {
      supported: disposed !== true,
      state: r.state,
      authId: r.authId,
      generation: r.gen,
      revision: r.revision,
      code: r.code,
      expiresAt: r.expiresAt,
      hasQr: r.qr !== null,
      identity: r.identity === null ? null : { maskedLabel: r.identity.maskedLabel },
      // 只给固定四字段：没有 rawURL / query / source proof
      approval: r.approval === null ? null : {
        approvalId: r.approval.id,
        origin: r.approval.origin,
        purpose: r.approval.purpose,
        method: r.approval.method,
      },
      canBegin: disposed !== true && r.state === 'idle' && r.beginUsed !== true,
      canAttach: disposed !== true && r.state === 'ready' && r.protocol !== null,
      canStop: disposed !== true && r.state !== 'stopped' && r.state !== 'expired' && r.state !== 'claimed',
    }
  }

  function matches(r, authId, gen) {
    if (r === null) return false
    if (typeof authId !== 'string' || !HEX32.test(authId)) return false
    if (!Number.isSafeInteger(gen) || gen < 1) return false
    return r.authId === authId && r.gen === gen
  }

  function ownerLive(r) {
    return disposed !== true && record === r && LIVE.has(r.state) && now() < r.expiresAt
  }

  function disarm(r) {
    if (r.timer !== null) {
      try { unschedule(r.timer) } catch { /* 已清理 */ }
      r.timer = null
    }
  }

  function armExpiry(r) {
    disarm(r)
    r.timer = schedule(() => {
      r.timer = null
      if (disposed || record !== r) return
      expireIfDue()
    }, Math.max(1, r.expiresAt - now()))
    if (r.timer !== null && typeof r.timer.unref === 'function') r.timer.unref()
  }

  /** 先失效（状态/revision）→ 清 QR/expected/审批 → resolve(false) → dispose protocol。 */
  function invalidate(r, state, code) {
    r.state = state
    r.code = typeof code === 'string' ? code : ''
    const pending = r.approval
    r.approval = null
    r.qr = null
    r.expected = null
    const protocol = r.protocol
    r.protocol = null
    bump(r)
    disarm(r)
    if (pending !== null && typeof pending.resolve === 'function') {
      try { pending.resolve(false) } catch { /* 已结算 */ }
    }
    if (protocol !== null) {
      try { protocol.dispose() } catch { /* 已清理 */ }
    }
  }

  function expireIfDue() {
    const r = record
    if (r === null) return
    if (!LIVE.has(r.state)) return
    if (now() < r.expiresAt) return
    invalidate(r, 'expired', S.EXPIRED)
  }

  function requestApproval(r, info) {
    return new Promise((resolve) => {
      // 同一时刻只允许一个待审批；第二个直接拒（不排队、不覆盖）
      if (r.approval !== null || !LIVE.has(r.state)) { resolve(false); return }
      const origin = typeof info?.origin === 'string' ? info.origin : ''
      r.approval = {
        id: randomBytes(16).toString('hex'),
        origin,
        purpose: 'consoleAuthResult',
        method: 'GET',
        resolve,
      }
      bump(r)
    })
  }

  /** 仅本地：随机 authId + 正 generation + 120 s 独立期限。零 IO、零网络。 */
  function start(args = {}) {
    if (disposed) return { ok: false, code: S.DISABLED, status: dto() }
    if (args === null || typeof args !== 'object' || args.authConsent !== true) {
      return { ok: false, code: S.BAD_REQUEST, status: dto() }
    }
    const expected = normalizeExpected(args.expected)
    if (expected === null || expected.namespace !== CONSOLE_SESSION_NAMESPACE) {
      return { ok: false, code: S.BAD_REQUEST, status: dto() }
    }
    const current = record
    if (current !== null && (LIVE.has(current.state) || current.state === 'claimed')) {
      return { ok: false, code: S.BUSY, status: dto() }
    }
    generation += 1
    const r = {
      authId: randomBytes(16).toString('hex'),
      gen: generation,
      revision: 0,
      state: 'idle',
      code: '',
      // 事前预期只是**期望**：复制并冻结，外部改对象不能改变它
      expected: Object.freeze({ namespace: CONSOLE_SESSION_NAMESPACE, identifier: expected.identifier }),
      expiresAt: now() + CONSOLE_SESSION_LIMITS.pendingMs,
      qr: null,
      identity: null,
      approval: null,
      protocol: null,
      lease: null,
      beginUsed: false,
      timer: null,
    }
    record = r
    bump(r)
    armExpiry(r)
    return { ok: true, code: S.OK, status: dto() }
  }

  /** 异步启动**真实** protocol.login：立刻 ACK，后台跑；`done` 仅 Host/测试内部可见。 */
  function begin(authId, gen) {
    if (disposed) return { ok: false, code: S.DISABLED, status: dto() }
    const r = record
    if (!matches(r, authId, gen)) return { ok: false, code: S.STALE_ID, status: dto() }
    expireIfDue()
    if (r.state === 'authorizing' || r.state === 'ready' || r.beginUsed === true) {
      return { ok: false, code: S.BEGIN_USED, status: dto() }
    }
    if (r.state !== 'idle') return { ok: false, code: S.NOT_READY, status: dto() }
    if (r.expected === null) return { ok: false, code: S.EXPIRED, status: dto() }
    // lease：claim 之后从 preauth 切到 display，清 pre-auth 状态不会让 isLive 变 false
    const lease = { mode: 'preauth', revoked: false }
    let protocol
    try {
      protocol = createConsoleProtocol({
        owner: lease,
        bootEpoch,
        generation: r.gen,
        expected: { namespace: r.expected.namespace, identifier: r.expected.identifier },
        now,
        isLive: (purpose) => {
          if (lease.revoked === true) return false
          if (lease.mode === 'display') return true   // display 侧由 disposer 负责失效
          if (disposed === true) return false
          if (record !== r) return false
          if (!LIVE.has(r.state)) return false
          if (!(now() < r.expiresAt)) return false
          if (purpose === 'consoleBalance') return false   // pre-auth 阶段不许读余额
          return true
        },
        transportDeps,
      })
    } catch {
      invalidate(r, 'failed', S.SUPPORTED)
      return { ok: false, code: S.SUPPORTED, status: dto() }
    }
    r.protocol = protocol
    r.lease = lease
    r.beginUsed = true
    r.state = 'authorizing'
    bump(r)
    const done = protocol.login({
      deadlineAt: r.expiresAt,
      onQr: (qr) => {
        if (record !== r || r.state !== 'authorizing') return
        if (qr === null || typeof qr !== 'object') return
        const bytes = qr.bytes instanceof Uint8Array ? qr.bytes : null
        if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > CONSOLE_SESSION_LIMITS.qrMaxBytes) return
        const mime = qr.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
        r.qr = { bytes: Uint8Array.from(bytes), mime }
        bump(r)
      },
      approveTarget: (info) => requestApproval(r, info),
    }).then(() => {
      if (record !== r) return { ok: false, code: S.STALE_ID }
      if (r.state === 'authorizing') {
        try { r.identity = protocol.describe().identity } catch { r.identity = null }
        r.state = 'ready'
        r.code = S.OK
        bump(r)
      }
      return { ok: true, code: S.OK, status: dto() }
    }, (error) => {
      const code = protocolCodeOf(error)
      if (record === r && r.state === 'authorizing') invalidate(r, 'failed', code)
      return { ok: false, code, status: dto() }
    }).then(
      // done 永不 reject：后台登录的失败只体现在状态里（避免未处理拒绝）
      (value) => value,
      () => ({ ok: false, code: FLOW })
    )
    return { ok: true, code: S.OK, status: dto(), done }
  }

  /** 纯观察：零 vendor 调用、零网络（惰性到期判定与自跑 timer 幂等）。 */
  function status() {
    if (disposed) return { ok: true, code: S.DISABLED, status: dto() }
    expireIfDue()
    return { ok: true, code: S.OK, status: dto() }
  }

  /** 一次性交付内存二维码字节；交付后即从记录里清掉（不进 JSON、不 base64）。 */
  function takeQr(authId, gen) {
    if (disposed) return { ok: false, code: S.DISABLED }
    const r = record
    if (!matches(r, authId, gen)) return { ok: false, code: S.STALE_ID }
    expireIfDue()
    if (r.qr === null) return { ok: false, code: S.QR_UNAVAILABLE }
    const out = { ok: true, bytes: r.qr.bytes, mime: r.qr.mime }
    r.qr = null
    bump(r)
    return out
  }

  function approve(authId, gen, approvalId) {
    return decide(authId, gen, approvalId, true)
  }
  function deny(authId, gen, approvalId) {
    return decide(authId, gen, approvalId, false)
  }
  function decide(authId, gen, approvalId, allow) {
    if (disposed) return { ok: false, code: S.DISABLED, status: dto() }
    const r = record
    if (!matches(r, authId, gen)) return { ok: false, code: S.STALE_ID, status: dto() }
    expireIfDue()
    if (r.approval === null) return { ok: false, code: S.APPROVAL_MISSING, status: dto() }
    if (typeof approvalId !== 'string' || approvalId !== r.approval.id) {
      return { ok: false, code: S.APPROVAL_UNKNOWN, status: dto() }
    }
    if (!ownerLive(r)) return { ok: false, code: S.EXPIRED, status: dto() }
    const pending = r.approval
    r.approval = null
    bump(r)
    try { pending.resolve(allow === true) } catch { /* 已结算 */ }
    // 「本人拒绝」本身是成功的本地动作；登录会因此以 CANCELLED 结束
    return { ok: true, code: S.OK, status: dto() }
  }

  /** 明确停止：已 claim 的记录**不**停 display（displayStop 独立负责）。 */
  function stop(authId, gen) {
    if (disposed) return { ok: false, code: S.DISABLED, status: dto() }
    const r = record
    if (r === null) return { ok: true, code: S.OK, status: dto() }
    if (!matches(r, authId, gen)) return { ok: false, code: S.STALE_ID, status: dto() }
    if (r.state === 'claimed') return { ok: true, code: S.OK, status: dto() }
    if (!LIVE.has(r.state)) return { ok: true, code: S.OK, status: dto() }
    invalidate(r, 'stopped', S.OK)
    return { ok: true, code: S.OK, status: dto() }
  }

  /** Host 内部取事前预期（**不经路由返回**）；只有 ready 才有。 */
  function getExpectedForAttach(authId, gen) {
    if (disposed) return null
    const r = record
    if (!matches(r, authId, gen)) return null
    expireIfDue()
    if (r.state !== 'ready' || r.expected === null) return null
    return Object.freeze({ namespace: r.expected.namespace, identifier: r.expected.identifier })
  }

  /**
   * 同步一次移交：ready 的 protocol 从 pre-auth 记录搬进私有 WeakMap 的 opaque 空 handle。
   * 之后本管理器**不再持有**该 protocol 的强引用，也不留 timer。
   */
  function claim(authId, gen) {
    if (disposed) return { ok: false, code: S.DISABLED, credential: null }
    const r = record
    if (!matches(r, authId, gen)) return { ok: false, code: S.STALE_ID, credential: null }
    expireIfDue()
    if (r.state !== 'ready' || r.protocol === null) return { ok: false, code: S.NOT_READY, credential: null }
    const protocol = r.protocol
    const lease = r.lease
    const handle = Object.freeze(Object.create(null))
    credentials.set(handle, { protocol, lease, authId: r.authId, generation: r.gen, disposed: false })
    // 移交完成：先切 lease，再清 pre-auth 状态（顺序不能反，否则 isLive 会瞬间变 false）
    lease.mode = 'display'
    r.protocol = null
    r.lease = null
    r.qr = null
    r.expected = null
    r.state = 'claimed'
    r.code = S.OK
    bump(r)
    disarm(r)
    return { ok: true, code: S.OK, credential: handle, status: dto() }
  }

  /** 内部身份核对：纯离线、零网络（display 的 identityVerifier 会 await 它）。 */
  function verifyCredential(handle) {
    const cred = typeof handle === 'object' && handle !== null ? credentials.get(handle) : undefined
    if (cred === undefined || cred.disposed === true) throw coded(S.CREDENTIAL_INVALID)
    return { identity: cred.protocol.verifyIdentity() }
  }

  /** 读一次余额（唯一的出站调用）；终止码原样上抛，由 Host 映射成 DISPLAY_CODES。 */
  async function readCredential(handle, args = {}) {
    const cred = typeof handle === 'object' && handle !== null ? credentials.get(handle) : undefined
    if (cred === undefined || cred.disposed === true) throw coded(S.CREDENTIAL_INVALID)
    const deadlineAt = typeof args.deadlineAt === 'number' && Number.isFinite(args.deadlineAt)
      ? args.deadlineAt : now() + 10000
    const out = await cred.protocol.readBalance({ deadlineAt, signal: args.signal })
    if (cred.disposed === true) throw coded(S.CREDENTIAL_INVALID)   // 迟到结果不得交回 display
    return { ok: true, balance: out.balance, identity: out.identity }
  }

  /** 立刻失效：handle 删除 + lease 撤销 + protocol.dispose（display 的 disposer）。 */
  function disposeCredential(handle) {
    const cred = typeof handle === 'object' && handle !== null ? credentials.get(handle) : undefined
    if (cred === undefined) return false
    credentials.delete(handle)
    cred.disposed = true
    // display 已释放唯一 handle：结束对应的非密 tombstone，允许下一次本人登录。
    // 只认同一 authId/generation，迟到释放旧 handle 不得覆盖后来建立的新记录。
    const r = record
    if (r !== null && r.state === 'claimed' && r.authId === cred.authId && r.gen === cred.generation) {
      r.state = 'stopped'
      r.code = S.OK
      r.identity = null
      bump(r)
    }
    try { cred.lease.revoked = true } catch { /* 已撤销 */ }
    try { cred.protocol.dispose() } catch { /* 已清理 */ }
    return true
  }

  function dispose() {
    if (disposed) return { ok: true }
    disposed = true
    const r = record
    if (r !== null) {
      if (r.state === 'claimed') {
        // protocol 已归 display：这里**不**碰它，只清本记录残留
        r.qr = null
        r.expected = null
        r.approval = null
        disarm(r)
        bump(r)
      } else {
        invalidate(r, 'stopped', S.OK)
        r.state = 'stopped'
      }
    }
    return { ok: true }
  }

  return Object.freeze({
    enabled: true,
    namespace: CONSOLE_SESSION_NAMESPACE,
    bootEpoch,
    limits: CONSOLE_SESSION_LIMITS,
    start,
    begin,
    status,
    takeQr,
    approve,
    deny,
    stop,
    getExpectedForAttach,
    claim,
    verifyCredential,
    readCredential,
    disposeCredential,
    dispose,
    /** 只给 Host/测试观察（不含任何凭据）。 */
    peek: () => dto(),
  })
}
