/**
 * MiMo G1 · 内存会话核心（适配自冻结的 tools/poc/mimo-settings-plugin/lib/session.mjs）
 *
 * 纯内存、无 IO：单活会话、generation、TTL、目标批准、QR 一次性取走、余额确认。
 * ticket 是随机 32hex 的 UI 内存 cap，不是账号票；不写 cfg/secret/文件/日志。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { normalizeFailure } from './failure.js'
import { normalizeCandidate, normalizeSourceProof } from './dynamic-policy.js'

const POSTQR_RECEIPT_KEYS = Object.freeze(['cUserId', 'serviceToken', 'userId'])
const POSTQR_DIGEST_RE = /^[a-f0-9]{64}$/
const POSTQR_ID_RE = /^[A-Za-z0-9._~+/=%-]{1,512}$/
const POSTQR_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance'

export const SESSION_CODES = Object.freeze({
  OK: 'E_NONE',
  ARGS_INVALID: 'E_MIMO_AUTH_BAD_REQUEST',
  POSTQR_DISABLED: 'E_MIMO_AUTH_POSTQR_DISABLED',
  IDENTITY_MISMATCH: 'E_MIMO_AUTH_IDENTITY_MISMATCH',
  APPROVAL_DENIED: 'E_MIMO_AUTH_APPROVAL_DENIED',
  SESSION_ACTIVE: 'E_MIMO_AUTH_SESSION_ACTIVE',
  SESSION_MISSING: 'E_MIMO_AUTH_SESSION_MISSING',
  SESSION_EXPIRED: 'E_MIMO_AUTH_SESSION_EXPIRED',
  STALE_GENERATION: 'E_MIMO_AUTH_STALE_GENERATION',
  STALE_TICKET: 'E_MIMO_AUTH_STALE_TICKET',
  CALL_BUDGET: 'E_MIMO_AUTH_CALL_BUDGET',
  APPROVAL_MISSING: 'E_MIMO_AUTH_APPROVAL_MISSING',
  APPROVAL_UNKNOWN: 'E_MIMO_AUTH_APPROVAL_UNKNOWN',
  APPROVAL_EXPIRED: 'E_MIMO_AUTH_APPROVAL_EXPIRED',
  APPROVAL_TARGET_INVALID: 'E_MIMO_AUTH_TARGET_INVALID',
  APPROVAL_ALREADY_USED: 'E_MIMO_AUTH_APPROVAL_UNKNOWN',
  CANCELLED: 'E_MIMO_AUTH_CANCELLED',
})

const ACCOUNT_HOST = 'account.xiaomi.com'
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'expired', 'disposed'])

export function describeApprovalTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return { ok: false, reason: 'syntax', originText: null }
  let parsed
  try { parsed = new URL(rawUrl) } catch { return { ok: false, reason: 'syntax', originText: null } }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme', originText: null }
  if (parsed.port !== '' && parsed.port !== '443') return { ok: false, reason: 'port', originText: null }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo', originText: null }
  if (parsed.hash !== '') return { ok: false, reason: 'fragment', originText: null }
  const host = parsed.hostname.toLowerCase()
  if (IPV4_RE.test(host) || host.includes(':')) return { ok: false, reason: 'ip', originText: null }
  if (!host.endsWith(`.${ACCOUNT_HOST}`)) return { ok: false, reason: host === ACCOUNT_HOST ? 'account-exact' : 'host', originText: null }
  const label = host.slice(0, -1 * (`.${ACCOUNT_HOST}`).length)
  if (!DNS_LABEL_RE.test(label)) return { ok: false, reason: 'label', originText: null }
  return { ok: true, reason: 'ok', originText: `https://${host}` }
}

export function createSessionManager(options = {}) {
  const {
    now = Date.now,
    randomId = () => {
      const bytes = new Uint8Array(16)
      globalThis.crypto.getRandomValues(bytes)
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    },
    ttlMs = 5 * 60 * 1000,
    approvalTimeoutMs = 120 * 1000,
    maxCalls = 20,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = options
  for (const value of [ttlMs, approvalTimeoutMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) throw new RangeError('Invalid TTL')
  }
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new RangeError('Invalid maxCalls')
  let disposed = false
  let session = null
  let generation = 0

  function live(gen) {
    check()
    return !disposed && session !== null && session.gen === gen && !TERMINAL.has(session.state)
  }

  function abort(s) {
    try { s?.controller?.abort() } catch { /* 已中止 */ }
  }

  function clearApproval(s, result) {
    const a = s.approval
    if (a === null) return
    s.approval = null
    unschedule(a.timer)
    a.settle(result)
    a.rawUrl = null
  }

  function clearPostQr(s, preserveIdentityDisplay = false) {
    if (s.postQr === null || s.postQr === undefined) return
    s.postQr.authResult = null
    s.postQr.accountRef = null
    s.postQr.readBalanceRequest = null
    s.postQr.balancePending = false
    if (preserveIdentityDisplay !== true) s.postQr.identity = null
    s.postQr.identityVerified = false
    s.postQr.identityAck = null
    s.postQr.readBalanceUsed = false
    s.postQr.approvedSource = null
    s.postQr.approvedSourceProof = null
    s.postQr.approvalId = null
    s.postQr.expectedIdentityDigest = null
    s.postQr.expectedAccountType = null
    s.postQr.purpose = null
  }

  function end(s, state, code = SESSION_CODES.CANCELLED, failure = null) {
    s.state = state
    s.failure = state === 'failed' ? normalizeFailure(failure) : null
    s.approvedLongPoll = null
    clearPostQr(s, state === 'done')
    unschedule(s.timer)
    s.timer = null
    s.qr = null
    if (state !== 'done') {
      s.balance = null
      s.confirmedByUser = null
    }
    clearApproval(s, { approved: false, code })
    if (s.balanceMatch !== null) {
      const pending = s.balanceMatch
      s.balanceMatch = null
      pending.settle('later')
    }
    abort(s)
  }

  function check() {
    const s = session
    if (s === null) return
    if (!TERMINAL.has(s.state) && now() >= s.deadline) end(s, 'expired', SESSION_CODES.SESSION_EXPIRED)
    else if (s.approval !== null && now() >= s.approval.expiresAt) clearApproval(s, { approved: false, code: SESSION_CODES.APPROVAL_EXPIRED })
  }

  function arm(s) {
    s.timer = schedule(() => {
      if (session !== s || TERMINAL.has(s.state)) return
      check()
      if (!TERMINAL.has(s.state)) arm(s)
    }, Math.max(1, s.deadline - now()))
    s.timer?.unref?.()
  }

  function projectBalance(value) {
    if (value === null || typeof value !== 'object') return null
    if (typeof value.balance !== 'number' || !Number.isFinite(value.balance) || value.balance < 0) return null
    const amount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
    const currency = typeof value.currency === 'string' && value.currency.trim().length > 0
      ? value.currency.trim().toUpperCase()
      : 'CNY'
    return { balance: value.balance, cashBalance: amount(value.cashBalance), giftBalance: amount(value.giftBalance), currency }
  }

  function postQrDigest(userId, cUserId) {
    return createHash('sha256').update('mimo-platform\0').update(userId).update('\0').update(cUserId).digest('hex')
  }

  function postQrMask(userId) {
    const tail = userId.slice(-4).replace(/[^A-Za-z0-9._~-]/g, '')
    return tail.length > 0 ? `u***${tail}` : 'u***'
  }

  function validatePostQrReceipt(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const keys = Object.keys(value).sort()
    if (keys.length !== POSTQR_RECEIPT_KEYS.length || !keys.every((key, index) => key === POSTQR_RECEIPT_KEYS[index])) return null
    for (const key of POSTQR_RECEIPT_KEYS) {
      const text = value[key]
      if (typeof text !== 'string' || text.length === 0 || text.length > 512 || !POSTQR_ID_RE.test(text)) return null
    }
    return { userId: value.userId, cUserId: value.cUserId, serviceToken: value.serviceToken }
  }

  function samePostQrDigest(actual, expected) {
    if (typeof actual !== 'string' || typeof expected !== 'string' || !POSTQR_DIGEST_RE.test(actual) || !POSTQR_DIGEST_RE.test(expected)) return false
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  }

  function sameSourceProof(actual, expected) {
    return actual !== null && expected !== null
      && actual.origin === expected.origin && actual.redirected === expected.redirected
      && actual.initPath === expected.initPath && actual.sid === expected.sid
      && actual.callback === expected.callback
  }

  function failPostQr(s, code, stage = 'flow') {
    clearPostQr(s)
    end(s, 'failed', code, { code, stage })
    return { ok: false, code }
  }

  function snapshot(s) {
    if (s === null) return null
    return {
      state: s.state,
      generation: s.gen,
      failure: s.failure === null ? null : {
        code: s.failure.code,
        stage: s.failure.stage,
        diagnostic: s.failure.diagnostic === null ? null : {
          rejectedPurpose: s.failure.diagnostic.rejectedPurpose,
          rejectedReason: s.failure.diagnostic.rejectedReason,
          hostClass: s.failure.diagnostic.hostClass,
        },
      },
      remainingMs: Math.max(0, s.deadline - now()),
      calls: s.calls,
      maxCalls,
      hasQr: s.qr !== null,
      approval: s.approval === null ? null : {
        approvalId: s.approval.id,
        originText: s.approval.originText,
        method: s.approval.method,
        purpose: s.approval.purpose,
        expiresAt: s.approval.expiresAt,
      },
      balance: projectBalance(s.balance),
      identity: s.postQr === null || s.postQr === undefined || s.postQr.identity === null ? null : { maskedLabel: s.postQr.identity.maskedLabel },
      awaitingBalanceMatch: s.balanceMatch !== null,
      confirmedByUser: s.confirmedByUser,
    }
  }

  function start(options = {}) {
    check()
    if (disposed) return { ok: false, code: SESSION_CODES.CANCELLED, ticketId: null }
    if (session !== null && !TERMINAL.has(session.state)) return { ok: false, code: SESSION_CODES.SESSION_ACTIVE, ticketId: null }
    if (session !== null) end(session, session.state)
    generation += 1
    const id = randomId()
    session = {
      id,
      gen: generation,
      startedAt: now(),
      deadline: now() + ttlMs,
      controller: new AbortController(),
      state: 'idle',
      failure: null,
      allowDynamicLongPoll: options?.allowDynamicLongPoll === true,
      approvedLongPoll: null,
      qr: null,
      approval: null,
      calls: 0,
      balance: null,
      balanceMatch: null,
      confirmedByUser: null,
      postQr: options?.postQrConsent === true ? {
        purpose: 'postQrAuthResult',
        expectedAccountType: options.expectedAccountType,
        expectedIdentityDigest: options.expectedIdentityDigest,
        approvedSource: null,
        approvedSourceProof: null,
        approvalId: null,
        authResult: null,
        accountRef: null,
        identity: null,
        identityVerified: false,
        identityAck: null,
        readBalanceUsed: false,
        readBalanceRequest: null,
        balancePending: false,
      } : null,
      timer: null,
    }
    arm(session)
    return { ok: true, code: SESSION_CODES.OK, ticketId: id, generation, expiresAt: session.deadline }
  }

  function begin(id, gen) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!live(gen)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.STALE_GENERATION }
    if (s.state === 'running') return { ok: false, code: 'E_MIMO_AUTH_BEGIN_DUPLICATE' }
    if (s.state !== 'idle') return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    s.state = 'running'
    return { ok: true, code: SESSION_CODES.OK }
  }

  function get(id) {
    check()
    if (session === null || session.id !== id) return null
    return session
  }

  function status(id, gen) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING, http: 404 }
    if (typeof gen === 'number' && s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION, http: 409 }
    return { ok: true, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.OK, ...snapshot(s) }
  }

  function setQr(gen, bytes, mime) {
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!(bytes instanceof Uint8Array) || (mime !== 'image/png' && mime !== 'image/jpeg')) return { ok: false, code: SESSION_CODES.ARGS_INVALID }
    session.qr = { bytes, mime, at: now() }
    return { ok: true, code: SESSION_CODES.OK }
  }

  function takeQr(id, gen) {
    if (!live(gen) || session.id !== id || session.qr === null) return { ok: false, code: 'E_MIMO_AUTH_QR_UNAVAILABLE' }
    const taken = { bytes: session.qr.bytes, mime: session.qr.mime }
    session.qr = null
    return { ok: true, code: SESSION_CODES.OK, ...taken }
  }

  function requestApproval(gen, { purpose, rawUrl, source } = {}) {
    if (!live(gen)) return Promise.resolve({ approved: false, code: SESSION_CODES.STALE_GENERATION })
    if (purpose !== 'longPoll' || session.allowDynamicLongPoll !== true) {
      return Promise.resolve({ approved: false, code: SESSION_CODES.APPROVAL_TARGET_INVALID, reason: 'disabled' })
    }
    const target = normalizeCandidate(rawUrl)
    if (target.ok !== true) return Promise.resolve({ approved: false, code: SESSION_CODES.APPROVAL_TARGET_INVALID, reason: target.reason })
    const proof = normalizeSourceProof(source)
    if (proof === null) return Promise.resolve({ approved: false, code: SESSION_CODES.APPROVAL_TARGET_INVALID, reason: 'source' })
    if (session.approval !== null) return Promise.resolve({ approved: false, code: SESSION_CODES.SESSION_ACTIVE })
    const owner = session
    const approvalId = randomId()
    let settle = () => {}
    const promise = new Promise((resolve) => { settle = resolve })
    const a = {
      id: approvalId,
      generation: gen,
      purpose: 'longPoll',
      method: 'GET',
      rawUrl: target.canonical,
      originText: target.originText,
      sourceProof: proof,
      expiresAt: Math.min(session.deadline, now() + approvalTimeoutMs),
      timer: null,
      settle,
      used: false,
    }
    session.approval = a
    const armApproval = () => {
      a.timer = schedule(() => {
        if (session !== owner || owner.approval !== a) return
        check()
        if (owner.approval === a) armApproval()
      }, Math.max(1, a.expiresAt - now()))
      a.timer?.unref?.()
    }
    armApproval()
    return promise
  }

  function pendingApproval(id) {
    const s = get(id)
    if (s === null || s.approval === null) return { ok: false, code: SESSION_CODES.APPROVAL_MISSING }
    const a = s.approval
    if (now() >= a.expiresAt) return { ok: false, code: SESSION_CODES.APPROVAL_EXPIRED }
    return { ok: true, code: SESSION_CODES.OK, approvalId: a.id, originText: a.originText, method: a.method, purpose: a.purpose, expiresAt: a.expiresAt }
  }

  function approve(id, gen, approvalId) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!live(gen)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.STALE_GENERATION }
    const a = s.approval
    if (a === null) return { ok: false, code: SESSION_CODES.APPROVAL_MISSING }
    if (typeof approvalId !== 'string' || approvalId.length !== a.id.length || approvalId !== a.id) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    if (a.generation !== s.gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (a.used === true) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    if (now() >= a.expiresAt) { clearApproval(s, { approved: false, code: SESSION_CODES.APPROVAL_EXPIRED }); return { ok: false, code: SESSION_CODES.APPROVAL_EXPIRED } }
    a.used = true
    s.approvedLongPoll = a.rawUrl
    if (s.postQr !== null) {
      s.postQr.approvedSource = a.rawUrl
      s.postQr.approvedSourceProof = a.sourceProof
      s.postQr.approvalId = a.id
    }
    clearApproval(s, { approved: true, url: a.rawUrl, purpose: a.purpose, generation: a.generation })
    return { ok: true, code: SESSION_CODES.OK }
  }

  function setPostQrAuthResult(gen, receiptValue, source) {
    const s = session
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (s.postQr === null) return { ok: false, code: SESSION_CODES.POSTQR_DISABLED }
    if (s.postQr.authResult !== null || s.postQr.identityVerified === true) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    if (source === null || typeof source !== 'object'
      || s.postQr.approvedSource === null || source.url !== s.postQr.approvedSource
      || source.approvalId !== s.postQr.approvalId
      || !sameSourceProof(source.sourceProof, s.postQr.approvedSourceProof)) {
      return failPostQr(s, SESSION_CODES.APPROVAL_TARGET_INVALID)
    }
    if (s.postQr.expectedAccountType !== 'mimo-platform' || !POSTQR_DIGEST_RE.test(s.postQr.expectedIdentityDigest)) {
      return { ok: false, code: SESSION_CODES.POSTQR_DISABLED }
    }
    const receipt = validatePostQrReceipt(receiptValue)
    if (receipt === null) return failPostQr(s, 'E_CREDENTIAL_FIELD_INVALID')
    const digest = postQrDigest(receipt.userId, receipt.cUserId)
    if (!samePostQrDigest(digest, s.postQr.expectedIdentityDigest)) return failPostQr(s, SESSION_CODES.IDENTITY_MISMATCH)
    s.postQr.authResult = receipt
    s.postQr.accountRef = digest
    s.postQr.identity = { maskedLabel: postQrMask(receipt.userId) }
    s.postQr.identityVerified = true
    s.postQr.identityAck = null
    return { ok: true, code: SESSION_CODES.OK, identity: { maskedLabel: s.postQr.identity.maskedLabel } }
  }

  function confirmIdentity(id, gen, verdict) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!live(gen)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.STALE_GENERATION }
    if (s.postQr === null) return { ok: false, code: SESSION_CODES.POSTQR_DISABLED }
    if (!['match', 'mismatch'].includes(verdict)) return { ok: false, code: SESSION_CODES.ARGS_INVALID }
    if (s.postQr.identityAck !== null) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    if (s.postQr.identityVerified !== true) return { ok: false, code: SESSION_CODES.IDENTITY_MISMATCH }
    if (verdict === 'mismatch') return failPostQr(s, SESSION_CODES.IDENTITY_MISMATCH)
    s.postQr.identityAck = 'match'
    return { ok: true, code: SESSION_CODES.OK }
  }

  function claimReadBalance(id, gen) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!live(gen)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.STALE_GENERATION }
    if (s.postQr === null) return { ok: false, code: SESSION_CODES.POSTQR_DISABLED }
    if (s.postQr.identityVerified !== true || s.postQr.identityAck !== 'match') return { ok: false, code: SESSION_CODES.IDENTITY_MISMATCH }
    if (s.postQr.readBalanceUsed === true) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    const receipt = s.postQr.authResult
    if (receipt === null) return { ok: false, code: SESSION_CODES.POSTQR_DISABLED }
    const request = {
      url: POSTQR_BALANCE_URL,
      method: 'GET',
      headers: { cookie: `userId=${receipt.userId}; serviceToken=${receipt.serviceToken}` },
      signal: s.controller.signal,
      deadlineAt: s.deadline,
    }
    s.postQr.readBalanceUsed = true
    s.postQr.balancePending = true
    s.postQr.authResult = null
    s.postQr.accountRef = null
    return { ok: true, code: SESSION_CODES.OK, request }
  }

  function completeReadBalance(gen, view) {
    const s = session
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (s.postQr === null || s.postQr.balancePending !== true) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    const balance = projectBalance(view)
    if (balance === null) return failReadBalance(gen, 'E_BALANCE_PARSE')
    s.balance = balance
    s.confirmedByUser = null
    s.postQr.balancePending = false
    return { ok: true, code: SESSION_CODES.OK }
  }

  function failReadBalance(gen, code) {
    const s = session
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (s.postQr === null || s.postQr.balancePending !== true) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    s.postQr.balancePending = false
    return failPostQr(s, code, 'balance')
  }

  function deny(id, gen, approvalId) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!live(gen)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.STALE_GENERATION }
    const a = s.approval
    if (a === null) return { ok: false, code: SESSION_CODES.APPROVAL_MISSING }
    if (typeof approvalId !== 'string' || approvalId.length !== a.id.length || approvalId !== a.id) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    if (a.used === true) return { ok: false, code: SESSION_CODES.APPROVAL_UNKNOWN }
    a.used = true
    s.approvedLongPoll = null
    clearApproval(s, { approved: false, code: SESSION_CODES.APPROVAL_DENIED, purpose: a.purpose, generation: a.generation })
    return { ok: true, code: SESSION_CODES.OK }
  }

  function cancel(id, gen) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (typeof gen === 'number' && s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (TERMINAL.has(s.state)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : 'E_MIMO_AUTH_CANCELLED' }
    end(s, 'cancelled')
    s.balance = null
    s.confirmedByUser = null
    return { ok: true, code: SESSION_CODES.OK }
  }

  function chargeCall(gen) {
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (session.calls >= maxCalls) {
      end(session, 'failed', SESSION_CODES.CALL_BUDGET, { code: 'E_CALL_BUDGET', stage: 'flow' })
      return { ok: false, code: SESSION_CODES.CALL_BUDGET }
    }
    session.calls += 1
    return { ok: true, code: SESSION_CODES.OK }
  }

  function setBalance(gen, view) {
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    const balance = projectBalance(view)
    if (balance === null) return { ok: false, code: SESSION_CODES.ARGS_INVALID }
    session.balance = balance
    session.confirmedByUser = null
    return { ok: true, code: SESSION_CODES.OK }
  }

  function requestBalanceMatch(gen, view) {
    if (!live(gen) || session.balanceMatch !== null) return Promise.resolve('later')
    if (!setBalance(gen, view).ok) return Promise.resolve('later')
    session.qr = null
    return new Promise((settle) => { session.balanceMatch = { generation: gen, settle } })
  }

  function confirmBalance(id, gen, verdict) {
    const s = get(id)
    if (s === null) return { ok: false, code: SESSION_CODES.SESSION_MISSING }
    if (s.gen !== gen) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (!live(gen)) return { ok: false, code: s.state === 'expired' ? SESSION_CODES.SESSION_EXPIRED : SESSION_CODES.STALE_GENERATION }
    if (!['match', 'mismatch', 'later'].includes(verdict)) return { ok: false, code: SESSION_CODES.ARGS_INVALID }
    const pending = s.balanceMatch
    if (pending === null || pending.generation !== s.gen) return { ok: false, code: SESSION_CODES.APPROVAL_MISSING }
    s.balanceMatch = null
    s.confirmedByUser = verdict
    pending.settle(verdict)
    return { ok: true, code: SESSION_CODES.OK }
  }

  function finish(gen, patch) {
    if (!live(gen)) return { ok: false, code: SESSION_CODES.STALE_GENERATION }
    if (patch !== null && typeof patch === 'object') {
      const requestedFailure = Object.prototype.hasOwnProperty.call(patch, 'failure')
        ? normalizeFailure(patch.failure)
        : null
      if ('balance' in patch) session.balance = projectBalance(patch.balance)
      if ('failure' in patch) session.failure = patch.state === 'failed' ? requestedFailure : null
      if (typeof patch.state === 'string') session.state = patch.state
      if (TERMINAL.has(session.state)) end(session, session.state, SESSION_CODES.CANCELLED, requestedFailure)
    }
    return { ok: true, code: SESSION_CODES.OK }
  }

  function dispose() {
    check()
    disposed = true
    if (session !== null) { end(session, 'disposed'); session = null }
    return { ok: true }
  }

  return { start, begin, get, status, setQr, takeQr, requestApproval, pendingApproval, approve, deny, cancel, chargeCall, setBalance, requestBalanceMatch, confirmBalance, setPostQrAuthResult, confirmIdentity, claimReadBalance, completeReadBalance, failReadBalance, finish, dispose, describeApprovalTarget }
}

export default createSessionManager
