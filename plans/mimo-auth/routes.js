/** MiMo G1 owner-only route contract. SDK `connection.fetch.register` supplies owner admission. */
import { absentDisplayDto } from './session-display.js'
// [handoff-summary 2026-11-09] 复用 protocol 的纯白名单重建器（不新造 module）；routes 只透 sanitized 副本。
import { projectConsoleHandoffSummary } from './console-protocol.js'

export const ROUTE_PATHS = Object.freeze({
  AUTH: '/api/plan-usage-mimo-auth',
  QR: '/api/plan-usage-mimo-qr',
})

export const ROUTE_CODES = Object.freeze({
  OK: 'E_NONE',
  UNAVAILABLE: 'E_MIMO_AUTH_UNAVAILABLE',
  BOOT_STALE: 'E_MIMO_AUTH_BOOT_STALE',
  BAD_REQUEST: 'E_MIMO_AUTH_BAD_REQUEST',
  METHOD: 'E_MIMO_AUTH_METHOD',
  CONTENT_TYPE: 'E_MIMO_AUTH_CONTENT_TYPE',
  BODY_TOO_LARGE: 'E_MIMO_AUTH_BODY_TOO_LARGE',
  SESSION_ACTIVE: 'E_MIMO_AUTH_SESSION_ACTIVE',
  SESSION_MISSING: 'E_MIMO_AUTH_SESSION_MISSING',
  SESSION_EXPIRED: 'E_MIMO_AUTH_SESSION_EXPIRED',
  STALE_TICKET: 'E_MIMO_AUTH_STALE_TICKET',
  STALE_GENERATION: 'E_MIMO_AUTH_STALE_GENERATION',
  BEGIN_DUPLICATE: 'E_MIMO_AUTH_BEGIN_DUPLICATE',
  APPROVAL_MISSING: 'E_MIMO_AUTH_APPROVAL_MISSING',
  APPROVAL_UNKNOWN: 'E_MIMO_AUTH_APPROVAL_UNKNOWN',
  APPROVAL_EXPIRED: 'E_MIMO_AUTH_APPROVAL_EXPIRED',
  APPROVAL_DENIED: 'E_MIMO_AUTH_APPROVAL_DENIED',
  TARGET_INVALID: 'E_MIMO_AUTH_TARGET_INVALID',
  CANCELLED: 'E_MIMO_AUTH_CANCELLED',
  FLOW: 'E_MIMO_AUTH_FLOW',
  QR_UNAVAILABLE: 'E_MIMO_AUTH_QR_UNAVAILABLE',
  POSTQR_DISABLED: 'E_MIMO_AUTH_POSTQR_DISABLED',
  IDENTITY_MISMATCH: 'E_MIMO_AUTH_IDENTITY_MISMATCH',
  // [display 2026-11-05] 本机显示会话（合成 DI 未注入时的固定拒绝码）
  DISPLAY_DISABLED: 'E_MIMO_AUTH_DISPLAY_DISABLED',
  DISPLAY_STALE_ID: 'E_MIMO_AUTH_DISPLAY_STALE_ID',
  // [console 2026-11-06] 正式 console 扫码登录（代码级开关未打开时的固定拒绝码）
  CONSOLE_DISABLED: 'E_MIMO_CONSOLE_SESSION_DISABLED',
  CONSOLE_BAD_REQUEST: 'E_MIMO_AUTH_BAD_REQUEST',
  CONSOLE_NOT_READY: 'E_MIMO_CONSOLE_NOT_READY',
  CONSOLE_STALE_ID: 'E_MIMO_CONSOLE_STALE_ID',
  CONSOLE_QR_UNAVAILABLE: 'E_MIMO_CONSOLE_QR_UNAVAILABLE',
  CONSOLE_BUSY: 'E_MIMO_CONSOLE_SESSION_BUSY',
  // [remembered 2026-11-07] 记住登录 managed 模式（代码级开关未打开时的固定拒绝码）
  REMEMBERED_DISABLED: 'E_MIMO_REMEMBERED_DISABLED',
  REMEMBERED_MANAGED_ONLY: 'E_MIMO_REMEMBERED_MANAGED_ONLY',
})

export const NO_STORE = Object.freeze({
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
})

export const MAX_JSON_BYTES = 8192
const ACTIONS = new Set(['start', 'begin', 'status', 'approve', 'deny', 'confirm', 'confirmIdentity', 'readBalance', 'cancel', 'logout'])
/**
 * [display 2026-11-05] 本机显示会话动作：与旧单次动作**并列**、互不继承。
 * 走同一个 owner-only 路由与同一套 readJson/boot 校验，不另造路由/transport。
 */
const DISPLAY_ACTIONS = new Set(['displayStart', 'displayStatus', 'displayRead', 'displayConfirm', 'displayGrant', 'displayStop'])
const HEX32 = /^[a-f0-9]{32}$/

/** JSON generation is a positive safe integer; never coerce strings. */
function parseGeneration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE, 'content-type': 'application/json; charset=utf-8', ...extra },
  })
}

export function capability(bootEpoch, supported = true, code = ROUTE_CODES.OK,
  displaySupported = false, displayNamespaces = [], consoleView = null, rememberedView = null) {
  return json(200, {
    ok: supported === true,
    supported: supported === true,
    code,
    bootEpoch,
    flow: 'qr-memory',
    // [display] 只报告 DI 是否齐备与**已支持的 namespace 安全白名单**；
    // 不加载 flow、不发任何网络请求、不含任何凭据。
    displaySupported: displaySupported === true,
    displayNamespaces: Array.isArray(displayNamespaces)
      ? displayNamespaces.filter((ns) => typeof ns === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(ns))
      : [],
    // [console] 只报告**代码级**开关是否打开（route/UI 无法打开它）＋安全白名单＋白名单快照
    consoleSupported: consoleView !== null && consoleView.supported === true,
    consoleNamespaces: consoleView !== null && consoleView.supported === true && typeof consoleView.namespace === 'string'
      ? [consoleView.namespace]
      : [],
    console: consoleView,
    // [remembered 2026-11-07] managed 模式：快照本身也是白名单重建，不含票/URL/原始 ID
    rememberedSupported: rememberedView !== null && rememberedView.supported === true,
    remembered: rememberedView,
  })
}

// ===========================================================================
// [console 2026-11-06] 正式 console 扫码登录：与 display/legacy 动作**并列**的独立分支。
// 只复用同一条 owner-only 路由、同一个 bootEpoch 校验与 8 KiB JSON 上限，不新造入口。
// ===========================================================================
const CONSOLE_ACTIONS = new Set([
  'consoleStart', 'consoleBegin', 'consoleStatus', 'consoleStop',
  'consoleAttach', 'consoleQr', 'consoleApprove', 'consoleDeny',
])
const CONSOLE_STATES = new Set(['absent', 'idle', 'authorizing', 'ready', 'failed', 'stopped', 'expired', 'claimed'])
const HEX32_RE = /^[a-f0-9]{32}$/
const CONSOLE_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** 严格字段集（出现任何额外键即 400，不静默忽略）。 */
function consoleFieldSets(action) {
  if (action === 'consoleStart') return [['action', 'bootEpoch', 'expected', 'authConsent']]
  if (action === 'consoleStatus') return [['action', 'bootEpoch']]
  if (action === 'consoleApprove' || action === 'consoleDeny') {
    return [['action', 'bootEpoch', 'authId', 'generation', 'approvalId']]
  }
  // consoleStop 在「未启用」时允许只带 boot（幂等 200）；其余动作必须带 authId/generation
  if (action === 'consoleStop') {
    return [['action', 'bootEpoch', 'authId', 'generation'], ['action', 'bootEpoch']]
  }
  return [['action', 'bootEpoch', 'authId', 'generation']]
}
function keysMatchAny(value, sets) {
  return sets.some((keys) => exactKeys(value, keys))
}

/**
 * console 状态快照的**白名单重建**（逐字段）：不透 rawURL/query/expected/actual/token。
 * 未启用时给**可信 absent**（不是通信故障），命令 `supported:false`。
 */
export function consoleSnapshot(api) {
  const base = {
    supported: false,
    state: 'absent',
    authId: null,
    generation: 0,
    revision: 0,
    code: '',
    expiresAt: null,
    hasQr: false,
    identity: null,
    approval: null,
    canBegin: false,
    canAttach: false,
    canStop: false,
    namespace: null,
  }
  if (api === null || api === undefined || api.enabled !== true) return base
  let raw = null
  try { raw = api.status() } catch { raw = null }
  const s = raw !== null && typeof raw === 'object' && raw.status !== null && typeof raw.status === 'object' ? raw.status : null
  if (s === null) return base
  const out = Object.assign({}, base)
  out.supported = s.supported === true
  out.namespace = typeof api.namespace === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(api.namespace) ? api.namespace : null
  if (typeof s.state === 'string' && CONSOLE_STATES.has(s.state)) out.state = s.state
  if (typeof s.authId === 'string' && HEX32_RE.test(s.authId)) out.authId = s.authId
  if (Number.isSafeInteger(s.generation) && s.generation > 0) out.generation = s.generation
  if (Number.isSafeInteger(s.revision) && s.revision >= 0) out.revision = s.revision
  out.code = typeof s.code === 'string' && CONSOLE_CODE_RE.test(s.code) ? s.code : ''
  out.expiresAt = typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt) ? s.expiresAt : null
  out.hasQr = s.hasQr === true
  out.canBegin = s.canBegin === true
  out.canAttach = s.canAttach === true
  out.canStop = s.canStop === true
  if (s.identity !== null && typeof s.identity === 'object'
    && typeof s.identity.maskedLabel === 'string' && s.identity.maskedLabel.length > 0) {
    out.identity = { maskedLabel: String(s.identity.maskedLabel).slice(0, 32) }
  }
  if (s.approval !== null && typeof s.approval === 'object') {
    const a = s.approval
    if (typeof a.approvalId === 'string' && HEX32_RE.test(a.approvalId)
      && typeof a.origin === 'string' && /^[a-z0-9][a-z0-9.-]{0,253}$/i.test(a.origin)
      && a.purpose === 'consoleAuthResult' && a.method === 'GET') {
      out.approval = { approvalId: a.approvalId, origin: a.origin, purpose: 'consoleAuthResult', method: 'GET' }
    }
  }
  return out
}

function consoleHttpOf(result) {
  if (result !== null && result.ok === true) return 200
  if (result === null) return 503
  if (result.code === ROUTE_CODES.CONSOLE_BAD_REQUEST) return 400
  if (result.code === ROUTE_CODES.CONSOLE_DISABLED) return 503
  if (result.code === ROUTE_CODES.CONSOLE_STALE_ID) return 409
  if (result.code === ROUTE_CODES.CONSOLE_QR_UNAVAILABLE) return 404
  if (result.code === 'E_MIMO_AUTH_BOOT_STALE') return 409
  return 409
}

async function handleConsole(value, { bootEpoch, console: api, consoleBusy }) {
  const action = value.action
  if (!CONSOLE_ACTIONS.has(action)) return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
  if (value.bootEpoch !== bootEpoch) return json(409, { ok: false, code: ROUTE_CODES.BOOT_STALE })
  if (!keysMatchAny(value, consoleFieldSets(action))) {
    return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
  }
  const ready = api !== null && api !== undefined && api.enabled === true
  const view = consoleSnapshot(api)
  // 纯观察：未启用也必须给可信 absent（0 网络、0 vendor）
  if (action === 'consoleStatus') {
    return json(200, { ok: true, code: ROUTE_CODES.OK, bootEpoch, console: view })
  }
  if (action === 'consoleStop' && !ready) {
    return json(200, { ok: true, code: ROUTE_CODES.OK, bootEpoch, console: view })
  }
  if (!ready) return json(503, { ok: false, code: ROUTE_CODES.CONSOLE_DISABLED, bootEpoch, console: view })

  if (action === 'consoleStart') {
    if (value.authConsent !== true) return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
    const expected = value.expected
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
      || !exactKeys(expected, ['identifier', 'namespace'])
      || typeof expected.namespace !== 'string' || typeof expected.identifier !== 'string') {
      return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
    }
    // 双登录防护：已有 display 会话或旧 legacy 会话时**0 请求**拒绝
    if (consoleBusy() === true) {
      return json(409, { ok: false, code: ROUTE_CODES.CONSOLE_BUSY, bootEpoch, console: view })
    }
    const result = api.start({ expected: { namespace: expected.namespace, identifier: expected.identifier }, authConsent: true })
    return json(consoleHttpOf(result), { ok: result.ok === true, code: result.code, bootEpoch, console: consoleSnapshot(api) })
  }

  if (typeof value.authId !== 'string' || !HEX32_RE.test(value.authId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
  }
  const authId = value.authId
  const generation = value.generation

  if (action === 'consoleQr') {
    const taken = api.takeQr(authId, generation)
    if (taken === null || taken.ok !== true) {
      return json(taken !== null && taken.code === ROUTE_CODES.CONSOLE_QR_UNAVAILABLE ? 404 : 409,
        { ok: false, code: taken !== null && typeof taken.code === 'string' ? taken.code : ROUTE_CODES.CONSOLE_QR_UNAVAILABLE })
    }
    // 二进制 + no-store：不 JSON、不 base64
    return new Response(taken.bytes, {
      status: 200,
      headers: { ...NO_STORE, 'content-type': taken.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png' },
    })
  }

  let result
  if (action === 'consoleBegin') {
    result = api.begin(authId, generation)
  } else if (action === 'consoleApprove' || action === 'consoleDeny') {
    if (typeof value.approvalId !== 'string' || !HEX32_RE.test(value.approvalId)) {
      return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
    }
    result = action === 'consoleApprove'
      ? api.approve(authId, generation, value.approvalId)
      : api.deny(authId, generation, value.approvalId)
  } else if (action === 'consoleAttach') {
    // Host 内部取事前预期并 start display（producer=claim）；**只 attach，不读余额**
    result = await api.attach(authId, generation)
  } else {
    result = api.stop(authId, generation)
  }
  const body = { ok: result !== null && result.ok === true, code: result !== null && typeof result.code === 'string' ? result.code : '', bootEpoch, console: consoleSnapshot(api) }
  if (result !== null && result.display !== null && result.display !== undefined) body.display = result.display
  return json(consoleHttpOf(result), body)
}

// ===========================================================================
// [remembered 2026-11-07] 「记住登录」managed 模式：与 console/display **并列**的独立分支。
// 复用同一条 owner-only 路由 / bootEpoch 校验 / 8 KiB 上限 / no-store，不新造入口。
// 严格字段集：**不接受** ID / ticket / 原票 / revision / expected —— 出现即 400。
// ===========================================================================
const REMEMBERED_ACTIONS = new Set([
  'rememberedStart', 'rememberedBegin', 'rememberedStatus', 'rememberedQr',
  'rememberedApprove', 'rememberedDeny', 'rememberedConfirm', 'rememberedCancel',
  'rememberedPause', 'rememberedResume', 'rememberedForget', 'rememberedRetry',
  // [freshness 2026-11-10] 展开详情时主动读一次（只读一次余额，不 retry/不 restore）
  'rememberedRefresh',
])
const REMEMBERED_STATES = new Set([
  'booting', 'disabled', 'unsupported', 'unreadable', 'empty', 'authorizing',
  'awaiting_confirmation', 'restoring', 'verified', 'paused', 'failed', 'stopped',
])
/** freshness 固定闭集（display 侧 + controller 侧同一套）。 */
const REMEMBERED_FRESHNESS = new Set(['fresh', 'stale', 'failed', 'paused'])
/** controller 侧的连续读失败阈值（用于把 readFailures 夹在 0..limit）。 */
const REMEMBERED_READ_FAILURE_LIMIT = 5

function rememberedFieldSets(action) {
  if (action === 'rememberedStart') return [['action', 'bootEpoch', 'authConsent', 'consentVersion']]
  if (action === 'rememberedStatus') {
    // 观察可两种形态：纯观察（无 pair）或**当前 pair** 观察（唯一可能看到候选的路径）
    return [['action', 'bootEpoch'], ['action', 'bootEpoch', 'authId', 'generation']]
  }
  // [contract] 控制类动作必须绑定**当前** generation（无 authId 的恢复/暂停/空态用 gen），陈旧 view 0 副作用
  if (action === 'rememberedPause' || action === 'rememberedResume'
    || action === 'rememberedForget' || action === 'rememberedRetry'
    || action === 'rememberedRefresh') {
    return [['action', 'bootEpoch', 'generation']]
  }
  if (action === 'rememberedApprove' || action === 'rememberedDeny') {
    return [['action', 'bootEpoch', 'authId', 'generation', 'approvalId']]
  }
  if (action === 'rememberedConfirm') {
    // 服务端强制：四项授权全 true + consentVersion 1（"四复选框只在前端"不成立）
    return [['action', 'bootEpoch', 'authId', 'generation', 'consentVersion',
      'rememberConsent', 'autoRestore', 'autoReadBalance', 'autoRefresh']]
  }
  return [['action', 'bootEpoch', 'authId', 'generation']]
}
const REMEMBERED_CONSENT_KEYS = ['rememberConsent', 'autoRestore', 'autoReadBalance', 'autoRefresh']
function consentComplete(value) {
  if (value.consentVersion !== 1) return false
  for (const key of REMEMBERED_CONSENT_KEYS) if (value[key] !== true) return false
  return true
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
const safeLabel = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max
  && !/[\u0000-\u001f]/.test(v) ? v : null)

function rememberedWallet(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isFiniteNum(raw.balance)) return null
  const out = { balance: raw.balance }
  if (isFiniteNum(raw.cashBalance)) out.cashBalance = raw.cashBalance
  if (isFiniteNum(raw.giftBalance)) out.giftBalance = raw.giftBalance
  if (typeof raw.currency === 'string' && /^[A-Z]{2,8}$/.test(raw.currency)) out.currency = raw.currency
  return out
}

/**
 * remembered 快照的**逐字段白名单重建**：
 * 只有 owner 的待确认态能出现候选 ID；不透 passToken/rawURL/query/seed/stderr/自由文本。
 */
export function rememberedSnapshot(api, pair = null) {
  if (api === null || api === undefined) return null
  let raw = null
  try { raw = api.status() } catch { raw = null }
  if (raw === null || typeof raw !== 'object') return null
  const out = {
    supported: raw.supported === true,
    managed: true,
    state: REMEMBERED_STATES.has(raw.state) ? raw.state : 'absent',
    code: typeof raw.code === 'string' && CONSOLE_CODE_RE.test(raw.code) ? raw.code : '',
    // 非 secret 诊断：只透传固定协议码/阶段 enum，不输出原文/URL/ID/票
    reasonCode: typeof raw.reasonCode === 'string' && CONSOLE_CODE_RE.test(raw.reasonCode) ? raw.reasonCode : '',
    failureStage: raw.failureStage === 'restore' || raw.failureStage === 'read'
      || raw.failureStage === 'login' || raw.failureStage === 'store' ? raw.failureStage : null,
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    authId: typeof raw.authId === 'string' && HEX32_RE.test(raw.authId) ? raw.authId : null,
    generation: Number.isSafeInteger(raw.generation) && raw.generation >= 0 ? raw.generation : 0,
    expiresAt: isFiniteNum(raw.expiresAt) ? raw.expiresAt : null,
    hasQr: raw.hasQr === true,
    candidate: null,
    identity: raw.identity !== null && typeof raw.identity === 'object'
      && typeof raw.identity.maskedLabel === 'string' && raw.identity.maskedLabel.length > 0
      ? { maskedLabel: String(raw.identity.maskedLabel).slice(0, 32) }
      : null,
    balance: rememberedWallet(raw.balance),
    // [freshness 2026-11-10] 连续普通读失败次数（0..5 封顶）与公开 freshness 固定闭集：
    // 只有安全标量，不含原文/URL/ID/票；未知值一律归 0 / null。
    readFailures: Number.isSafeInteger(raw.readFailures) && raw.readFailures >= 0
      ? Math.min(raw.readFailures, REMEMBERED_READ_FAILURE_LIMIT) : 0,
    freshness: typeof raw.freshness === 'string' && REMEMBERED_FRESHNESS.has(raw.freshness) ? raw.freshness : null,
    // [handoff-summary] 默认 null：只有失败态且合法才被下面覆盖（契约：只透 sanitized copy 或 null）
    handoffSummary: null,
    fetchedAt: isFiniteNum(raw.fetchedAt) ? raw.fetchedAt : null,
    paused: raw.paused === true,
    intervalMs: Number.isSafeInteger(raw.intervalMs) && raw.intervalMs > 0 ? raw.intervalMs : null,
    nextReadAt: isFiniteNum(raw.nextReadAt) ? raw.nextReadAt : null,
    approval: null,
    storage: {
      supported: raw.storage !== null && typeof raw.storage === 'object' && raw.storage.supported === true,
      code: raw.storage !== null && typeof raw.storage === 'object'
        && typeof raw.storage.code === 'string' && CONSOLE_CODE_RE.test(raw.storage.code) ? raw.storage.code : '',
    },
    stats: {
      readAttempts: 0, readSuccesses: 0, refreshCount: 0,
      restoreAttempts: 0, restoreSuccesses: 0, transientStreak: 0,
      renewalAttempts: 0, renewalSuccesses: 0,
    },
    canBegin: raw.canBegin === true,
    canConfirm: raw.canConfirm === true,
    canPause: raw.canPause === true,
    canResume: raw.canResume === true,
    canForget: raw.canForget === true,
    canRetry: raw.canRetry === true,
  }
  /**
   * 候选原始 ID **只**在「调用方明确给出当前 authId+generation」时出现：
   * caps / displayStatus / sidebar / 普通 status 一律 null（不靠 state 猜）。
   */
  const pairOk = pair !== null && typeof pair === 'object'
    && typeof pair.authId === 'string' && HEX32_RE.test(pair.authId)
    && Number.isSafeInteger(pair.generation) && pair.generation >= 1
    && typeof raw.authId === 'string' && raw.authId === pair.authId
    && raw.generation === pair.generation
  if (pairOk && raw.state === 'awaiting_confirmation' && raw.candidate !== null && typeof raw.candidate === 'object') {
    const id = safeLabel(raw.candidate.identifier, 64)
    if (id !== null) out.candidate = { label: '小米账号ID', identifier: id }
  }
  const stats = raw.stats
  if (stats !== null && typeof stats === 'object') {
    for (const key of Object.keys(out.stats)) {
      if (Number.isSafeInteger(stats[key]) && stats[key] >= 0) out.stats[key] = stats[key]
    }
  }
  if (raw.approval !== null && typeof raw.approval === 'object') {
    const a = raw.approval
    if (typeof a.approvalId === 'string' && HEX32_RE.test(a.approvalId)
      && typeof a.origin === 'string' && /^[a-z0-9][a-z0-9.-]{0,253}$/i.test(a.origin)
      && a.purpose === 'consoleAuthResult' && a.method === 'GET') {
      out.approval = { approvalId: a.approvalId, origin: a.origin, purpose: 'consoleAuthResult', method: 'GET' }
    }
  }
  // [handoff-summary] 仅**失败态**透出 5 字段 sanitized 副本；raw 原对象绝不外传，非法即 null。
  if (out.state === 'failed' && raw.handoffSummary !== undefined && raw.handoffSummary !== null) {
    out.handoffSummary = projectConsoleHandoffSummary(raw.handoffSummary)
  }
  return out
}

function rememberedHttpOf(result) {
  if (result !== null && typeof result === 'object' && result.ok === true) return 200
  if (result === null || result === undefined) return 503
  if (result.code === ROUTE_CODES.CONSOLE_BAD_REQUEST) return 400
  if (result.code === ROUTE_CODES.REMEMBERED_DISABLED) return 503
  if (result.code === 'E_MIMO_REMEMBERED_QR_UNAVAILABLE') return 404
  if (result.code === 'E_MIMO_AUTH_BOOT_STALE') return 409
  return 409
}

async function handleRemembered(value, { bootEpoch, remembered: api }) {
  const action = value.action
  const ready = api !== null && api !== undefined
  const view = (pair) => rememberedSnapshot(api, pair === undefined ? null : pair)
  if (!REMEMBERED_ACTIONS.has(action)) return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
  if (value.bootEpoch !== bootEpoch) return json(409, { ok: false, code: ROUTE_CODES.BOOT_STALE })
  if (!keysMatchAny(value, rememberedFieldSets(action))) {
    return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
  }
  // 纯观察：未启用也必须给可信 absent（0 网络、0 解密）
  if (action === 'rememberedStatus') {
    // 只有带当前 authId+generation 的观察才可能带候选；否则一律 null
    let pair = null
    if ('authId' in value || 'generation' in value) {
      if (!keysMatchAny(value, [['action', 'bootEpoch', 'authId', 'generation']])) {
        return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
      }
      pair = { authId: value.authId, generation: value.generation }
    }
    return json(200, { ok: true, code: ROUTE_CODES.OK, bootEpoch, remembered: view(pair) })
  }
  if (!ready) return json(503, { ok: false, code: ROUTE_CODES.REMEMBERED_DISABLED, bootEpoch, remembered: view() })

  if (action === 'rememberedStart') {
    // 首扫**无 expected**：本人只同意「可以扫一次码」，不带任何 ID
    if (value.authConsent !== true || value.consentVersion !== 1) {
      return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
    }
    const result = await api.startAuth({ authConsent: true, consentVersion: 1 })
    return json(rememberedHttpOf(result), {
      ok: result.ok === true, code: result.code, bootEpoch, remembered: view(),
    })
  }

  const needsPair = action === 'rememberedBegin' || action === 'rememberedQr'
    || action === 'rememberedConfirm' || action === 'rememberedCancel'
    || action === 'rememberedApprove' || action === 'rememberedDeny'
  if (needsPair) {
    if (typeof value.authId !== 'string' || !HEX32_RE.test(value.authId)
      || !Number.isSafeInteger(value.generation) || value.generation < 1) {
      return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
    }
  }

  // [contract] 确认必须由服务端复核四项授权（客户端复选框只是 UI，不是凭据）
  if (action === 'rememberedConfirm' && !consentComplete(value)) {
    return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST, bootEpoch, remembered: view(null) })
  }
  // [contract] 控制类动作绑定当前 generation：陈旧视图 0 副作用
  if (action === 'rememberedPause' || action === 'rememberedResume'
    || action === 'rememberedForget' || action === 'rememberedRetry'
    || action === 'rememberedRefresh') {
    const current = rememberedSnapshot(api, null)
    const gen = current === null ? null : current.generation
    if (!Number.isSafeInteger(value.generation) || value.generation !== gen) {
      return json(409, { ok: false, code: 'E_MIMO_REMEMBERED_STALE_ID', bootEpoch, remembered: view(null) })
    }
  }

  let result
  if (action === 'rememberedBegin') {
    result = api.beginAuth(value.authId, value.generation)
    if (result !== null && result.done !== undefined && typeof api.track === 'function') api.track(result.done)
  } else if (action === 'rememberedQr') {
    const taken = api.takeQr(value.authId, value.generation)
    if (taken === null || taken.ok !== true) {
      return json(taken !== null && taken.code === 'E_MIMO_REMEMBERED_QR_UNAVAILABLE' ? 404 : 409,
        { ok: false, code: taken !== null && typeof taken.code === 'string' ? taken.code : 'E_MIMO_REMEMBERED_QR_UNAVAILABLE' })
    }
    return new Response(taken.bytes, {
      status: 200,
      headers: { ...NO_STORE, 'content-type': taken.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png' },
    })
  } else if (action === 'rememberedApprove' || action === 'rememberedDeny') {
    if (typeof value.approvalId !== 'string' || !HEX32_RE.test(value.approvalId)) {
      return json(400, { ok: false, code: ROUTE_CODES.CONSOLE_BAD_REQUEST })
    }
    result = action === 'rememberedApprove'
      ? api.approve(value.authId, value.generation, value.approvalId)
      : api.deny(value.authId, value.generation, value.approvalId)
  } else if (action === 'rememberedConfirm') {
    // **不带 ID**：Host 自己取候选 → confirmAccount → export → CAS 保存 → 首读
    result = await api.confirmAccount(value.authId, value.generation)
  } else if (action === 'rememberedCancel') {
    // 本人取消：**纯本地**清候选/QR/协议，0 存储写（不写 tombstone 冒充）
    result = api.cancelAuth(value.authId, value.generation)
  } else if (action === 'rememberedPause') {
    result = await api.pause()
  } else if (action === 'rememberedResume') {
    result = await api.resume()
  } else if (action === 'rememberedForget') {
    result = await api.forget()
  } else if (action === 'rememberedRefresh') {
    // [freshness 2026-11-10] 展开详情时主动读一次：只做一次真实余额读，
    // 不 retry / 不 restore / 不新扫 / 不清记录；单飞与计数由 controller 保证。
    // **显式分支**：绝不能掉进末尾的 retry 分支。
    if (typeof api.refresh !== 'function') {
      return json(503, { ok: false, code: ROUTE_CODES.REMEMBERED_DISABLED, bootEpoch, remembered: view() })
    }
    result = await api.refresh()
  } else {
    result = await api.retry()
  }
  return json(rememberedHttpOf(result), {
    ok: result !== null && typeof result === 'object' && result.ok === true,
    code: result !== null && typeof result === 'object' && typeof result.code === 'string' ? result.code : '',
    bootEpoch,
    remembered: view(),
  })
}

async function readJson(request) {
  const declared = request.headers?.get?.('content-length')
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) return { error: ROUTE_CODES.BODY_TOO_LARGE }
  let text
  try { text = await request.text() } catch { return { error: ROUTE_CODES.BAD_REQUEST } }
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) return { error: ROUTE_CODES.BODY_TOO_LARGE }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: ROUTE_CODES.BAD_REQUEST }
    return { value }
  } catch { return { error: ROUTE_CODES.BAD_REQUEST } }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort()
  const wanted = [...keys].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function parseCommon(value) {
  if (typeof value.action !== 'string' || !ACTIONS.has(value.action)) return { error: ROUTE_CODES.BAD_REQUEST }
  if (typeof value.bootEpoch !== 'string' || !HEX32.test(value.bootEpoch)) return { error: ROUTE_CODES.BAD_REQUEST }
  if (value.action === 'start') {
    if ('allowDynamicLongPoll' in value && typeof value.allowDynamicLongPoll !== 'boolean') return { error: ROUTE_CODES.BAD_REQUEST }
    if ('postQrConsent' in value && typeof value.postQrConsent !== 'boolean') return { error: ROUTE_CODES.BAD_REQUEST }
    const postQrConsent = value.postQrConsent === true
    if (postQrConsent) {
      if (!exactKeys(value, ['action', 'bootEpoch', 'allowDynamicLongPoll', 'postQrConsent', 'expectedAccountType', 'expectedIdentityDigest'])) {
        return { error: ROUTE_CODES.BAD_REQUEST }
      }
      if (value.allowDynamicLongPoll !== true || value.expectedAccountType !== 'mimo-platform'
        || typeof value.expectedIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedIdentityDigest)) {
        return { error: ROUTE_CODES.BAD_REQUEST }
      }
      return {
        action: 'start', allowDynamicLongPoll: true, postQrConsent: true,
        expectedAccountType: value.expectedAccountType, expectedIdentityDigest: value.expectedIdentityDigest,
      }
    }
    if (!exactKeys(value, ['action', 'bootEpoch'])
      && !exactKeys(value, ['action', 'bootEpoch', 'allowDynamicLongPoll'])
      && !exactKeys(value, ['action', 'bootEpoch', 'postQrConsent'])
      && !exactKeys(value, ['action', 'bootEpoch', 'allowDynamicLongPoll', 'postQrConsent'])) {
      return { error: ROUTE_CODES.BAD_REQUEST }
    }
    return { action: 'start', allowDynamicLongPoll: value.allowDynamicLongPoll === true, postQrConsent: false }
  }
  const allowed = ['action', 'bootEpoch', 'ticketId', 'generation']
  if (value.action === 'approve' || value.action === 'deny') allowed.push('approvalId')
  if (value.action === 'confirm' || value.action === 'confirmIdentity') allowed.push('verdict')
  if (!exactKeys(value, allowed)) return { error: ROUTE_CODES.BAD_REQUEST }
  if (typeof value.ticketId !== 'string' || !HEX32.test(value.ticketId)) return { error: ROUTE_CODES.BAD_REQUEST }
  const generation = parseGeneration(value.generation)
  if (generation === null) return { error: ROUTE_CODES.BAD_REQUEST }
  if ((value.action === 'approve' || value.action === 'deny')
    && (typeof value.approvalId !== 'string' || !HEX32.test(value.approvalId))) return { error: ROUTE_CODES.BAD_REQUEST }
  if (value.action === 'confirm' && !['match', 'mismatch', 'later'].includes(value.verdict)) return { error: ROUTE_CODES.BAD_REQUEST }
  if (value.action === 'confirmIdentity' && !['match', 'mismatch'].includes(value.verdict)) return { error: ROUTE_CODES.BAD_REQUEST }
  return { action: value.action, ticketId: value.ticketId, generation, approvalId: value.approvalId, verdict: value.verdict }
}

function statusOf(result) {
  if (result.ok === true) return 200
  if (result.code === ROUTE_CODES.SESSION_MISSING || result.code === 'E_MIMO_AUTH_SESSION_MISSING') return 404
  if (result.code === ROUTE_CODES.BOOT_STALE || result.code === 'E_MIMO_AUTH_BOOT_STALE') return 409
  return 409
}

/**
 * [display 2026-11-05] 本机显示会话各动作的**严格字段集**。
 * 明确不接受 URL / host / path / token / credential / actual / verified / source proof /
 * maxLifetime 之类越权字段：出现即 400（不静默忽略）。
 */
function displayFieldSet(action) {
  if (action === 'displayStart') return ['action', 'bootEpoch', 'expected']
  if (action === 'displayStatus') return ['action', 'bootEpoch']
  if (action === 'displayConfirm') return ['action', 'bootEpoch', 'displayId', 'generation', 'verdict']
  return ['action', 'bootEpoch', 'displayId', 'generation']
}

function displayHttpOf(result) {
  if (result.ok === true) return 200
  if (result.code === ROUTE_CODES.BAD_REQUEST) return 400
  if (result.code === ROUTE_CODES.DISPLAY_DISABLED) return 503
  if (result.code === ROUTE_CODES.DISPLAY_STALE_ID) return 409
  return 200
}

async function handleDisplay(value, { bootEpoch, display, console: consoleApi = null, remembered: rememberedApi = null }) {
  const action = value.action
  const view = () => consoleSnapshot(consoleApi)
  const remView = () => rememberedSnapshot(rememberedApi)
  if (!DISPLAY_ACTIONS.has(action)) return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST, console: view() })
  if (value.bootEpoch !== bootEpoch) return json(409, { ok: false, code: ROUTE_CODES.BOOT_STALE })
  if (!exactKeys(value, displayFieldSet(action))) return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST, console: view() })
  const ready = display !== null && display !== undefined && display.enabled === true
  // displayStatus 是纯观察（0 DI 调用）：disabled 也必须给出**可信 absent**，
  // 不能报成通信故障，否则正常胶囊会误判并把手工来源永久遮蔽。
  // [console] 同一条响应里附带 console 白名单快照 ⇒ 前端只需要**一个**观察定时器。
  // [remembered] managed 模式下 displayStatus 就是新 controller 的快照（仍是纯观察）。
  if (action === 'displayStatus') {
    const result = ready ? display.status() : { display: absentDisplayDto() }
    const body = { ok: true, code: ROUTE_CODES.OK, bootEpoch, display: result.display, console: view() }
    if (rememberedApi !== null && rememberedApi !== undefined) body.remembered = remView()
    return json(200, body)
  }
  // displayStop 幂等且安全：disabled 时没有东西可停，直接成功。
  if (action === 'displayStop' && !ready) {
    return json(200, { ok: true, code: ROUTE_CODES.OK, bootEpoch, display: absentDisplayDto(), console: view() })
  }
  if (!ready) return json(503, { ok: false, code: ROUTE_CODES.DISPLAY_DISABLED, bootEpoch, console: view() })
  if (action === 'displayStart') {
    const expected = value.expected
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
      || !exactKeys(expected, ['identifier', 'namespace'])) {
      return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST, console: view() })
    }
    const result = await display.start({ expected })
    return json(displayHttpOf(result), { ok: result.ok === true, code: result.code, bootEpoch, display: result.display, console: view() })
  }
  if (typeof value.displayId !== 'string' || !HEX32.test(value.displayId)) {
    return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST, console: view() })
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST, console: view() })
  }
  let result
  if (action === 'displayRead') {
    result = await display.read(value.displayId, value.generation)
  } else if (action === 'displayGrant') {
    result = display.grant(value.displayId, value.generation)
  } else if (action === 'displayConfirm') {
    if (value.verdict !== 'match' && value.verdict !== 'mismatch' && value.verdict !== 'later') {
      return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST, console: view() })
    }
    result = display.confirm(value.displayId, value.generation, value.verdict)
  } else {
    result = display.stop(value.displayId, value.generation)
  }
  return json(displayHttpOf(result), { ok: result.ok === true, code: result.code, bootEpoch, display: result.display, console: view() })
}

const LEGACY_TERMINAL = new Set(['done', 'failed', 'cancelled', 'expired', 'disposed'])

export async function handleAuth(request, {
  bootEpoch, manager, beginFlow, cancelFlow, postQrRuntime = null, display = null,
  console: consoleApi = null, consoleBusy = () => false, legacy = null, remembered: rememberedApi = null,
}) {
  if (request.method === 'GET') {
    const ready = display !== null && display !== undefined && display.enabled === true
    // 必须传**真实** bootEpoch：旧实现把布尔值当 bootEpoch 传给 capability（笔误）
    return capability(bootEpoch, true, ROUTE_CODES.OK, ready,
      ready && typeof display.namespace === 'string' ? [display.namespace] : [],
      consoleSnapshot(consoleApi),
      rememberedSnapshot(rememberedApi))
  }
  if (request.method !== 'POST') return json(405, { ok: false, code: ROUTE_CODES.METHOD })
  const type = request.headers?.get?.('content-type')
  if (typeof type !== 'string' || type.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json(415, { ok: false, code: ROUTE_CODES.CONTENT_TYPE })
  }
  const parsed = await readJson(request)
  if (parsed.error !== undefined) return json(parsed.error === ROUTE_CODES.BODY_TOO_LARGE ? 413 : 400, { ok: false, code: parsed.error })
  // [remembered] managed 模式分支（与 console/display 并列，互不影响）
  if (typeof parsed.value.action === 'string' && parsed.value.action.slice(0, 10) === 'remembered') {
    return handleRemembered(parsed.value, { bootEpoch, remembered: rememberedApi })
  }
  // [console] 与 display/旧动作**并列**的独立分支：旧动作白名单与旧字段集不受影响。
  if (typeof parsed.value.action === 'string' && parsed.value.action.slice(0, 7) === 'console') {
    return handleConsole(parsed.value, { bootEpoch, console: consoleApi, consoleBusy })
  }
  // [display] 与旧动作**并列**的独立分支：旧动作白名单与旧字段集不受影响。
  if (typeof parsed.value.action === 'string' && parsed.value.action.slice(0, 7) === 'display') {
    return handleDisplay(parsed.value, { bootEpoch, display, console: consoleApi, remembered: rememberedApi })
  }
  const common = parseCommon(parsed.value)
  if (common.error !== undefined) return json(400, { ok: false, code: common.error })
  if (parsed.value.bootEpoch !== bootEpoch) return json(409, { ok: false, code: ROUTE_CODES.BOOT_STALE })
  try {
    if (common.action === 'start') {
      if (common.postQrConsent === true && postQrRuntime?.enabled !== true) {
        return json(503, { ok: false, code: ROUTE_CODES.POSTQR_DISABLED })
      }
      const result = manager.start({
        allowDynamicLongPoll: common.allowDynamicLongPoll === true,
        postQrConsent: common.postQrConsent === true,
        expectedAccountType: common.expectedAccountType,
        expectedIdentityDigest: common.expectedIdentityDigest,
      })
      if (!result.ok) return json(statusOf(result), { ok: false, code: result.code })
      // [console] 双登录防护用的**非密**记号：只记 ticket/generation，不碰任何凭据
      if (legacy !== null && legacy !== undefined) {
        legacy.ticketId = result.ticketId
        legacy.generation = result.generation
      }
      return json(200, { ok: true, code: ROUTE_CODES.OK, bootEpoch, flow: 'qr-memory', allowDynamicLongPoll: common.allowDynamicLongPoll === true, ticketId: result.ticketId, generation: result.generation, expiresAt: result.expiresAt })
    }
    if (common.action === 'begin') {
      const result = manager.begin(common.ticketId, common.generation)
      if (!result.ok) return json(statusOf(result), { ok: false, code: result.code })
      const launched = await beginFlow(common.ticketId, common.generation)
      if (!launched.ok) return json(503, { ok: false, code: launched.code ?? ROUTE_CODES.FLOW })
      return json(200, { ok: true, code: ROUTE_CODES.OK, bootEpoch, flow: 'qr-memory', ticketId: common.ticketId, generation: common.generation })
    }
    if (common.action === 'status') {
      const result = manager.status(common.ticketId, common.generation)
      if (!result.ok) return json(statusOf(result), { ok: false, code: result.code })
      if (legacy !== null && legacy !== undefined && LEGACY_TERMINAL.has(result.state)) legacy.ticketId = null
      return json(200, { ok: true, code: result.code, bootEpoch, state: result.state, failure: result.failure, remainingMs: result.remainingMs, hasQr: result.hasQr, approval: result.approval, identity: result.identity, awaitingBalanceMatch: result.awaitingBalanceMatch, confirmedByUser: result.confirmedByUser, balance: result.balance })
    }
    if (common.action === 'approve') {
      const result = manager.approve(common.ticketId, common.generation, common.approvalId)
      if (result.ok && postQrRuntime?.enabled === true) {
        const produced = await postQrRuntime.onApproved(common.ticketId, common.generation)
        if (produced.ok !== true) return json(409, { ok: false, code: produced.code })
      }
      return json(result.ok ? 200 : statusOf(result), { ok: result.ok === true, code: result.code, bootEpoch })
    }
    if (common.action === 'deny') {
      const result = manager.deny(common.ticketId, common.generation, common.approvalId)
      return json(result.ok ? 200 : statusOf(result), { ok: result.ok === true, code: result.code, bootEpoch })
    }
    if (common.action === 'confirm') {
      const result = manager.confirmBalance(common.ticketId, common.generation, common.verdict)
      return json(result.ok ? 200 : statusOf(result), { ok: result.ok === true, code: result.code, bootEpoch })
    }
    if (common.action === 'confirmIdentity') {
      const result = manager.confirmIdentity(common.ticketId, common.generation, common.verdict)
      return json(result.ok ? 200 : statusOf(result), { ok: result.ok === true, code: result.code, bootEpoch })
    }
    if (common.action === 'readBalance') {
      if (postQrRuntime?.enabled !== true || typeof postQrRuntime.readBalance !== 'function') {
        return json(503, { ok: false, code: ROUTE_CODES.POSTQR_DISABLED })
      }
      const result = await postQrRuntime.readBalance(common.ticketId, common.generation)
      return json(result.ok ? 200 : statusOf(result), { ok: result.ok === true, code: result.code, bootEpoch })
    }
    const result = manager.cancel(common.ticketId, common.generation)
    if (result.ok) cancelFlow(common.ticketId)
    if (result.ok && legacy !== null && legacy !== undefined) legacy.ticketId = null
    return json(result.ok ? 200 : statusOf(result), { ok: result.ok === true, code: result.code, bootEpoch })
  } catch {
    return json(500, { ok: false, code: ROUTE_CODES.FLOW })
  }
}

export async function handleQr(request, { bootEpoch, manager }) {
  if (request.method !== 'POST') return json(405, { ok: false, code: ROUTE_CODES.METHOD })
  const type = request.headers?.get?.('content-type')
  if (typeof type !== 'string' || type.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json(415, { ok: false, code: ROUTE_CODES.CONTENT_TYPE })
  }
  const parsed = await readJson(request)
  if (parsed.error !== undefined) return json(parsed.error === ROUTE_CODES.BODY_TOO_LARGE ? 413 : 400, { ok: false, code: parsed.error })
  if (!exactKeys(parsed.value, ['bootEpoch', 'ticketId', 'generation'])) return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST })
  if (parsed.value.bootEpoch !== bootEpoch) return json(409, { ok: false, code: ROUTE_CODES.BOOT_STALE })
  if (typeof parsed.value.ticketId !== 'string' || !HEX32.test(parsed.value.ticketId)) return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST })
  const generation = parseGeneration(parsed.value.generation)
  if (generation === null) return json(400, { ok: false, code: ROUTE_CODES.BAD_REQUEST })
  const taken = manager.takeQr(parsed.value.ticketId, generation)
  if (!taken.ok) return json(taken.code === 'E_MIMO_AUTH_QR_UNAVAILABLE' ? 404 : 409, { ok: false, code: taken.code })
  return new Response(taken.bytes, {
    status: 200,
    headers: { ...NO_STORE, 'content-type': taken.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png' },
  })
}
