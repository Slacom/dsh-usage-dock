/**
 * console-protocol.js — 正式 console 协议内核（A3，Host-only、纯内存）
 * 所有外网请求经**真实** `createSecureTransport` + A1 `console-grants`；票只在私有 CookieJar/闭包。
 * constructor 零 IO；describe/verifyIdentity 零网络；每 operation 自建 authority 并在结束时销毁。
 */

import { createHash } from 'node:crypto'
import { createSecureTransport } from './secure-transport.js'
import { createConsoleGrantAuthority, deriveConsoleSsoUrl, deriveConsoleQrInitUrl } from './console-grants.js'
import { CookieJar, JAR_CODES } from './vendor/cookie-jar.js'
import { projectDisplayBalance } from './session-display.js'

const ACCOUNT = 'account.xiaomi.com'
const PLATFORM = 'platform.xiaomimimo.com'
const BALANCE_URL = 'https://' + PLATFORM + '/api/v1/balance'
const CONTEXT_URL = 'https://' + PLATFORM + '/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage'
/** 整个 operation（含 ctx/init/image/多轮 poll/callback）的**硬**调用上限。 */
const MAX_CALLS = 20
/**
 * 单次 long-poll 请求的等待上限：**不是**「重新生成二维码」的判据。
 * 到点只说明「还没扫码/还没确认」，在整体 deadline 内可以继续等同一个已批准 LP。
 */
const LP_REQUEST_MS = 35000
/** 账号侧身份命名空间（唯一固定值；不再从 expected 借用，pending/verify/export 共用）。 */
const NAMESPACE = 'xiaomi-account-user-id'
/** 允许被持久化的账号 Cookie 名：恰好原四件，不含平台短票/余额/URL/QR/grant/boot。 */
const ACCOUNT_REMEMBERED_NAMES = Object.freeze(['passToken', 'userId', 'cUserId', 'deviceId'])
const ACCOUNT_REMEMBERED_SET = new Set(ACCOUNT_REMEMBERED_NAMES)
const ACCOUNT_BASE = 'https://' + ACCOUNT + '/'
/** Cookie 值字节集（与 vendor jar 完全一致），引号只作外层包裹，不解除转义。 */
const COOKIE_OCTET_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/
function quoteSafeCookieValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (COOKIE_OCTET_RE.test(value)) return true
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    && COOKIE_OCTET_RE.test(value.slice(1, -1))
}
/** 主机内绝对过期时刻上限，与 vendor jar 的 MAX_DATE_MS 一致。 */
const MAX_DATE_MS = 8.64e15

export const CONSOLE_PROTOCOL_CODES = Object.freeze({
  FLOW: 'E_MIMO_CONSOLE_FLOW',
  CANCELLED: 'E_MIMO_AUTH_CANCELLED',
  EXPIRED: 'E_MIMO_AUTH_TARGET_EXPIRED',
  INVALID: 'E_MIMO_AUTH_TARGET_INVALID',
  BUSY: 'E_MIMO_CONSOLE_BUSY',
  NOT_VERIFIED: 'E_MIMO_CONSOLE_NOT_VERIFIED',
  UNSUPPORTED: 'E_MIMO_CONSOLE_UNSUPPORTED',
  JSON_UNSUPPORTED: 'E_MIMO_CONSOLE_JSON_UNSUPPORTED',
  COOKIE_HEADER_LIMIT: 'E_MIMO_CONSOLE_COOKIE_HEADER_LIMIT',
  LP_COOKIE_DOMAIN: 'E_MIMO_CONSOLE_LP_COOKIE_DOMAIN',
  LP_COOKIE_POLICY: 'E_MIMO_CONSOLE_LP_COOKIE_POLICY',
  LP_COOKIE_EMPTY: 'E_MIMO_CONSOLE_LP_COOKIE_EMPTY',
  LP_COOKIE_CRLF: 'E_MIMO_CONSOLE_LP_COOKIE_CRLF',
  LP_COOKIE_TOO_LARGE: 'E_MIMO_CONSOLE_LP_COOKIE_TOO_LARGE',
  LP_COOKIE_BAD_NAME: 'E_MIMO_CONSOLE_LP_COOKIE_BAD_NAME',
  LP_COOKIE_BAD_VALUE: 'E_MIMO_CONSOLE_LP_COOKIE_BAD_VALUE',
  LP_COOKIE_VALUE_FORMAT: 'E_MIMO_CONSOLE_LP_COOKIE_VALUE_FORMAT',
  LP_COOKIE_EXPIRY_FORMAT: 'E_MIMO_CONSOLE_LP_COOKIE_EXPIRY_FORMAT',
  LP_COOKIE_STORE_FULL: 'E_MIMO_CONSOLE_LP_COOKIE_STORE_FULL',
  LP_COOKIE_BAD_SOURCE: 'E_MIMO_CONSOLE_LP_COOKIE_BAD_SOURCE',
  LP_COOKIE_DUP_DOMAIN: 'E_MIMO_CONSOLE_LP_COOKIE_DUP_DOMAIN',
  LP_COOKIE_DUP_VALUE: 'E_MIMO_CONSOLE_LP_COOKIE_DUP_VALUE',
  LP_COOKIE_COUNT_LIMIT: 'E_MIMO_CONSOLE_LP_COOKIE_COUNT_LIMIT',
  LP_COOKIE_PARSE_ERROR: 'E_MIMO_CONSOLE_LP_COOKIE_PARSE_ERROR',
  ACCOUNT_COOKIE_EMPTY: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_EMPTY',
  ACCOUNT_COOKIE_CRLF: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_CRLF',
  ACCOUNT_COOKIE_TOO_LARGE: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_TOO_LARGE',
  ACCOUNT_COOKIE_BAD_NAME: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_BAD_NAME',
  ACCOUNT_COOKIE_BAD_VALUE: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_BAD_VALUE',
  ACCOUNT_COOKIE_VALUE_FORMAT: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_VALUE_FORMAT',
  ACCOUNT_COOKIE_EXPIRY_FORMAT: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_EXPIRY_FORMAT',
  ACCOUNT_COOKIE_STORE_FULL: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_STORE_FULL',
  ACCOUNT_COOKIE_BAD_SOURCE: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_BAD_SOURCE',
  ACCOUNT_COOKIE_DUP_DOMAIN: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_DUP_DOMAIN',
  ACCOUNT_COOKIE_DUP_VALUE: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_DUP_VALUE',
  ACCOUNT_COOKIE_COUNT_LIMIT: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_COUNT_LIMIT',
  ACCOUNT_COOKIE_PARSE_ERROR: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_PARSE_ERROR',
  ACCOUNT_COOKIE_DOMAIN: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_DOMAIN',
  ACCOUNT_COOKIE_POLICY: 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_POLICY',
  PLATFORM_COOKIE_DOMAIN: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_DOMAIN',
  PLATFORM_COOKIE_POLICY: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_POLICY',
  PLATFORM_COOKIE_EMPTY: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_EMPTY',
  PLATFORM_COOKIE_CRLF: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_CRLF',
  PLATFORM_COOKIE_TOO_LARGE: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_TOO_LARGE',
  PLATFORM_COOKIE_BAD_NAME: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_BAD_NAME',
  PLATFORM_COOKIE_BAD_VALUE: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_BAD_VALUE',
  PLATFORM_COOKIE_VALUE_FORMAT: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_VALUE_FORMAT',
  PLATFORM_COOKIE_EXPIRY_FORMAT: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_EXPIRY_FORMAT',
  PLATFORM_COOKIE_STORE_FULL: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_STORE_FULL',
  PLATFORM_COOKIE_BAD_SOURCE: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_BAD_SOURCE',
  PLATFORM_COOKIE_DUP_DOMAIN: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_DUP_DOMAIN',
  PLATFORM_COOKIE_DUP_VALUE: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_DUP_VALUE',
  PLATFORM_COOKIE_COUNT_LIMIT: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_COUNT_LIMIT',
  PLATFORM_COOKIE_PARSE_ERROR: 'E_MIMO_CONSOLE_PLATFORM_COOKIE_PARSE_ERROR',
  LP_SEED_CONFLICT: 'E_MIMO_CONSOLE_LP_SEED_CONFLICT',
  LP_CHALLENGE: 'E_MIMO_CONSOLE_LP_CHALLENGE',
  SSO_CHALLENGE: 'E_MIMO_CONSOLE_SSO_CHALLENGE',
  SSO_RESPONSE_UNSUPPORTED: 'E_MIMO_CONSOLE_SSO_RESPONSE_UNSUPPORTED',
  SSO_TARGET_UNSUPPORTED: 'E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED',
  SSO_TARGET_HTTP_PLATFORM_STS: 'E_MIMO_CONSOLE_SSO_TARGET_HTTP_PLATFORM_STS',
  SSO_TARGET_HTTP_PLATFORM_OTHER: 'E_MIMO_CONSOLE_SSO_TARGET_HTTP_PLATFORM_OTHER',
  SSO_TARGET_HTTPS_PLATFORM_API_STS: 'E_MIMO_CONSOLE_SSO_TARGET_HTTPS_PLATFORM_API_STS',
  SSO_TARGET_HTTPS_PLATFORM_STS_SLASH: 'E_MIMO_CONSOLE_SSO_TARGET_HTTPS_PLATFORM_STS_SLASH',
  SSO_TARGET_HTTPS_PLATFORM_OTHER: 'E_MIMO_CONSOLE_SSO_TARGET_HTTPS_PLATFORM_OTHER',
  SSO_TARGET_ACCOUNT_OTHER: 'E_MIMO_CONSOLE_SSO_TARGET_ACCOUNT_OTHER',
  SSO_TARGET_OTHER_HOST: 'E_MIMO_CONSOLE_SSO_TARGET_OTHER_HOST',
  SSO_TARGET_UNSAFE_AUTHORITY: 'E_MIMO_CONSOLE_SSO_TARGET_UNSAFE_AUTHORITY',
  SSO_TARGET_OTHER_SCHEME: 'E_MIMO_CONSOLE_SSO_TARGET_OTHER_SCHEME',
  LP_TARGET_UNSUPPORTED: 'E_MIMO_CONSOLE_LP_TARGET_UNSUPPORTED',
  LP_SID_UNSUPPORTED: 'E_MIMO_CONSOLE_LP_SID_UNSUPPORTED',
  LP_CALLBACK_UNSUPPORTED: 'E_MIMO_CONSOLE_LP_CALLBACK_UNSUPPORTED',
  LP_SCHEMA_UNSUPPORTED: 'E_MIMO_CONSOLE_LP_SCHEMA_UNSUPPORTED',
  LP_HOST_UNSUPPORTED: 'E_MIMO_CONSOLE_LP_HOST_UNSUPPORTED',
  RESPONSE_SIZE: 'E_MIMO_CONSOLE_RESPONSE_SIZE',
  RESPONSE_REDIRECT: 'E_MIMO_CONSOLE_RESPONSE_REDIRECT',
  AUTH_REJECTED: 'E_MIMO_AUTH_REJECTED',
  AUTH_REQUIRED: 'E_MIMO_CONSOLE_AUTH_REQUIRED',
  AUTH_RESULT_SEED_MISSING: 'E_MIMO_CONSOLE_AUTH_RESULT_SEED_MISSING',
  AUTH_RESULT_ID_INVALID: 'E_MIMO_CONSOLE_AUTH_RESULT_ID_INVALID',
  ACCOUNT_CREDENTIAL_MISSING: 'E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING',
  PLATFORM_CREDENTIAL_MISSING: 'E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING',
  IDENTITY_MISMATCH: 'E_MIMO_CONSOLE_IDENTITY_MISMATCH',
  BALANCE_PARSE: 'E_MIMO_CONSOLE_BALANCE_PARSE',
  TRANSIENT: 'E_MIMO_CONSOLE_TRANSIENT',
  /** 首扫已完成认证但本人尚未确认候选账号：读写余额/身份/导出在确认前一律拒且 0 新请求。 */
  CONFIRM_REQUIRED: 'E_MIMO_CONSOLE_CONFIRM_REQUIRED'
})
const C = CONSOLE_PROTOCOL_CODES
/**
 * 内部（**不导出**）的 long-poll 等待信号：只被本文件的 LP 有界多轮消费。
 * 它绝不作为对外错误码逃逸（`settleCode()` 会把它映射成 EXPIRED）。
 */
const POLL_WAIT = 'E_MIMO_CONSOLE_POLL_WAIT'
const KNOWN = new Set([...Object.values(C), POLL_WAIT])
const fail = (code) => { const e = new Error(KNOWN.has(code) ? code : C.FLOW); e.code = KNOWN.has(code) ? code : C.FLOW; return e }
/** operation 终态的唯一映射：内部码不得外泄。 */
const settleCode = (code) => (code === POLL_WAIT ? C.EXPIRED : (KNOWN.has(code) ? code : C.FLOW))

/**
 * 私有无副作用分类：只针对**已经收到**的目标 URL 给出固定闭集码；null 表示原本可放行的
 * clean https 精确 platform/sts。不改 allow-set、不做网络、不输出 URL 原文。
 */
function targetKindOf(u) {
  if (u.username !== '' || u.password !== '' || u.hash !== '' || u.port !== '') return C.SSO_TARGET_UNSAFE_AUTHORITY
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return C.SSO_TARGET_OTHER_SCHEME
  if (u.hostname === ACCOUNT) {
    if (u.protocol === 'https:' && u.pathname === '/pass/serviceLogin') return C.AUTH_REJECTED
    if (u.protocol === 'https:' && (u.pathname === '/pass/notification' || u.pathname.startsWith('/pass/notification/'))) return C.SSO_CHALLENGE
    return C.SSO_TARGET_ACCOUNT_OTHER
  }
  if (u.hostname === PLATFORM) {
    if (u.protocol === 'http:') return u.pathname === '/sts' ? C.SSO_TARGET_HTTP_PLATFORM_STS : C.SSO_TARGET_HTTP_PLATFORM_OTHER
    if (u.pathname === '/sts') return null
    if (u.pathname === '/api/sts') return C.SSO_TARGET_HTTPS_PLATFORM_API_STS
    if (u.pathname === '/sts/') return C.SSO_TARGET_HTTPS_PLATFORM_STS_SLASH
    return C.SSO_TARGET_HTTPS_PLATFORM_OTHER
  }
  return C.SSO_TARGET_OTHER_HOST
}

/** 路径词表（小写精确闭集）；未知段一律 'other'，不保留长度/原文。 */
const HANDOFF_PATH_WORDS = Object.freeze(new Set([
  'fe', 'pass', 'service', 'login', 'servicelogin', 'auth', 'notification', 'security',
  'password', 'phone', 'qr', 'qrlogin', 'qrcode', 'verify', 'verification', 'identity',
  'account', 'passport', 'callback', 'sts', 'api', 'v1', 'v2', 'login2', 'loginurl',
  'home', 'index', 'confirmation', 'authorize', 'oauth', 'web', 'ui', 'other',
]))

function handoffPathTokens(pathname) {
  if (typeof pathname !== 'string' || pathname === '' || pathname === '/') return { tokens: [], truncated: false }
  const tokens = []
  let truncated = false
  for (const raw of pathname.split('/')) {
    if (raw === '') continue
    if (tokens.length >= 8) { truncated = true; break }
    const lower = raw.toLowerCase()
    tokens.push(HANDOFF_PATH_WORDS.has(lower) ? lower : 'other')
  }
  return { tokens, truncated }
}

/**
 * 公开纯投影：只重建 5 个非 secret 字段；任何未知/坏值 → null。不 copy 额外字段。
 * raw 可以是 protocol.describe().handoffSummary，也可以是 routes 收到的同形 JSON。
 */
export function projectConsoleHandoffSummary(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { source, status, scheme, pathTokens, truncated } = raw
  if (source !== 'header' && source !== 'json') return null
  if (![200, 301, 302, 303, 307, 308].includes(status)) return null
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'other') return null
  if (!Array.isArray(pathTokens) || pathTokens.length > 8) return null
  const tokens = []
  for (const token of pathTokens) {
    if (typeof token !== 'string' || !HANDOFF_PATH_WORDS.has(token)) return null
    tokens.push(token)
  }
  if (typeof truncated !== 'boolean') return null
  return { source, status, scheme, pathTokens: tokens, truncated }
}

function buildHandoffSummary(u, source, status) {
  if (u === null || typeof u !== 'object') return null
  const scheme = u.protocol === 'https:' ? 'https' : u.protocol === 'http:' ? 'http' : 'other'
  const { tokens, truncated } = handoffPathTokens(u.pathname)
  return projectConsoleHandoffSummary({ source, status, scheme, pathTokens: tokens, truncated })
}

/** 严格 JSON：拒重复 key / 危险 key / 非法转义；用 JSON.parse 解每个 string token */
function decodeJson(rawText, capture = null) {
  let s = rawText
  const marker = '&&&START&&&'
  if (s.startsWith(marker)) s = s.slice(marker.length)
  if (s.length === 0 || s.length > 256 * 1024) throw fail(C.JSON_UNSUPPORTED)
  const BAD = new Set(['__proto__', 'constructor', 'prototype'])
  let i = 0
  const ws = () => { while (i < s.length && /[\s]/.test(s[i])) i++ }
  const strToken = () => {
    if (s[i] !== '"') throw fail(C.JSON_UNSUPPORTED)
    const start = i
    i += 1
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue }
      if (s[i] === '"') { i += 1; break }
      if (s.charCodeAt(i) < 0x20) throw fail(C.JSON_UNSUPPORTED)
      i += 1
    }
    const raw = s.slice(start, i)
    let v
    try { v = JSON.parse(raw) } catch { throw fail(C.JSON_UNSUPPORTED) }
    return v
  }
  const value = (depth) => {
    if (depth > 32) throw fail(C.JSON_UNSUPPORTED)
    ws()
    const ch = s[i]
    if (ch === '{') {
      i += 1
      const obj = Object.create(null)
      const seen = new Set()
      ws()
      if (s[i] === '}') { i += 1; return obj }
      for (;;) {
        ws()
        const key = strToken()
        if (seen.has(key)) throw fail(C.JSON_UNSUPPORTED)
        if (BAD.has(key)) throw fail(C.JSON_UNSUPPORTED)
        seen.add(key)
        ws()
        if (s[i] !== ':') throw fail(C.JSON_UNSUPPORTED)
        i += 1
        ws()
        const valueStart = i
        const parsed = value(depth + 1)
        if (depth === 0 && key === 'userId' && typeof parsed === 'number') {
          // Keep authenticated numeric IDs exact: JSON.parse-style rounding must
          // not turn a fractional/unsafe wire value into somebody else's ID.
          const lexeme = s.slice(valueStart, i)
          if (!/^[1-9][0-9]*$/.test(lexeme) || !Number.isSafeInteger(parsed)) throw fail(C.AUTH_RESULT_ID_INVALID)
        }
        // SSO 签名材料：只保留**顶层** nonce 的原始十进制 lexeme（数字）或已解析字符串；
        // 嵌套 nonce 不得覆盖顶层，其他字段语义不变。
        if (capture !== null && depth === 0 && key === 'nonce' && capture.nonce === undefined) {
          if (typeof parsed === 'number') capture.nonce = s.slice(valueStart, i)
          else if (typeof parsed === 'string') capture.nonce = parsed
        }
        obj[key] = parsed
        ws()
        if (s[i] === ',') { i += 1; continue }
        if (s[i] === '}') { i += 1; return obj }
        throw fail(C.JSON_UNSUPPORTED)
      }
    }
    if (ch === '[') {
      i += 1
      const arr = []
      ws()
      if (s[i] === ']') { i += 1; return arr }
      for (;;) {
        arr.push(value(depth + 1))
        ws()
        if (s[i] === ',') { i += 1; continue }
        if (s[i] === ']') { i += 1; return arr }
        throw fail(C.JSON_UNSUPPORTED)
      }
    }
    if (ch === '"') return strToken()
    for (const [lit, out] of [['true', true], ['false', false], ['null', null]]) {
      if (s.startsWith(lit, i)) { i += lit.length; return out }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i))
    if (m === null) throw fail(C.JSON_UNSUPPORTED)
    const n = Number(m[0])
    if (!Number.isFinite(n)) throw fail(C.JSON_UNSUPPORTED)
    i += m[0].length
    return n
  }
  const out = value(0)
  ws()
  if (i !== s.length) throw fail(C.JSON_UNSUPPORTED)
  return out
}

const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f;]/.test(v)
function normalizeAuthenticatedAccountId(value) {
  if (typeof value === 'string') return isStr(value) ? value : null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return null
}
const mask = (v) => {
  if (typeof v !== 'string' || v === '') return '未识别'
  const keep = v.length >= 12 ? 2 : 0
  const tail = keep
  if (keep === 0) return '*'.repeat(Math.min(32, Math.max(2, v.length)))
  return v.slice(0, keep) + '*'.repeat(Math.min(28, Math.max(2, v.length - keep - tail))) + v.slice(v.length - tail)
}
// Semantic comparison only. CookieJar retains and emits the original wire
// bytes; removing outer quotes here must never rewrite the outgoing header.
function cookieValueContent(raw) {
  const content = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(content)) throw fail(C.FLOW)
  return content
}
function parseCookieHeader(str) {
  const out = new Map()
  if (typeof str !== 'string' || str === '') return out
  for (const part of str.split(';')) {
    const raw = part.trim()
    if (raw === '') continue
    const eq = raw.indexOf('=')
    if (eq <= 0) throw fail(C.FLOW)
    const name = raw.slice(0, eq).trim()
    const value = cookieValueContent(raw.slice(eq + 1).trim())
    if (value === '') throw fail(C.FLOW)
    if (out.has(name)) throw fail(C.FLOW)   // 同名歧义/重复 ⇒ 拒
    out.set(name, value)
  }
  return out
}
/** Vendor wire amounts may be decimal strings (the existing MiMo balance
 * contract). Normalize only those four documented wallet fields at ingress;
 * the shared display projection remains number-only, with no currency/zero
 * fallback, cash-as-total fallback, coercion of booleans/null, or alias search.
 */
function projectConsoleWallet(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const amount = value => {
    if (typeof value === 'number') return value
    if (typeof value !== 'string' || value.length > 64
      || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
    return Number(value)
  }
  return projectDisplayBalance({
    balance: amount(raw.balance),
    currency: raw.currency,
    cashBalance: amount(raw.cashBalance),
    giftBalance: amount(raw.giftBalance),
  })
}
export function createConsoleProtocol(opts = {}) {
  const { owner, bootEpoch, generation, isLive } = opts
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  if (!owner || typeof owner !== 'object') throw new TypeError('console-protocol: owner required')
  if (typeof bootEpoch !== 'string' || bootEpoch === '') throw new TypeError('console-protocol: bootEpoch required')
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError('console-protocol: generation required')
  if (typeof isLive !== 'function') throw new TypeError('console-protocol: isLive required')
  /**
   * 两种模式：
   *  - 严格模式（默认）：必须给 opts.expected（已解密且本人授权的绑定）。
   *  - confirmAfterScan 模式：允许**缺** expected，首扫后进入 awaiting_confirmation，
   *    由 Host 用 pendingAccount() 取候选、本人确认后 confirmAccount() 冻结绑定。
   * 只有显式 `confirmAfterScan === true` 才放宽；缺 expected 且无该旗仍按严格模式拒绝。
   */
  const confirmAfterScan = opts.confirmAfterScan === true
  const expectedIn = opts.expected
  let expected = null
  if (expectedIn !== undefined && expectedIn !== null) {
    if (expectedIn.namespace !== NAMESPACE || !isStr(expectedIn.identifier)) {
      throw new TypeError('console-protocol: expected required')
    }
    // 事前预期复制并冻结，外部改对象不能改变预期
    expected = Object.freeze({ namespace: NAMESPACE, identifier: String(expectedIn.identifier) })
  } else if (!confirmAfterScan) {
    throw new TypeError('console-protocol: expected required')
  }

  let state = 'new'
  let code = 'E_NONE'
  let genLive = generation
  let loggedIn = false
  let loginUsed = false
  let accountId = null
  let platformId = null
  let balanceFlight = null
  /** 一次冻结的绑定：只有 confirmAccount（或成功 restore）能定稿，之后只读。 */
  let bound = null
  /** 导出授权来源：本人 confirmAccount，或上层已验记录的受信 restore。 */
  let exportTrusted = false
  let restoreUsed = false
  // 固定统计（不含账号/票/URL），供未来 UI 区分「真的发生过」与「没发生」
  let restoreAttempts = 0
  let restoreSuccesses = 0
  let renewalAttempts = 0
  let renewalSuccesses = 0
  /**
   * 私有账号 Cookie 记录（Host-only、永不进 describe/DTO/logs）：
   * key = name\0domain\0path。值里保留**原始**（含引号）串与服务器绝对 expiry，
   * 只为 exportRememberedAccount 服务；不反射 vendor jar 的 WeakMap、不改其导出。
   */
  let accountRecords = new Map()
  let accountJar = new CookieJar({ allowQuotedValues: true, rootDomains: [ACCOUNT], now })
  let platformJar = new CookieJar({ allowQuotedValues: true, rootDomains: [PLATFORM], now })
  let currentOp = null
  let activeAuthority = null
  /** 失败时的已知 ACCOUNT 目标安全摘要（5 字段、无 URL/secret；新 op/成功/dispose 清） */
  let handoffSummary = null

  const tDeps = { ...(opts.transportDeps || {}) }
  delete tDeps.validateConsoleGrant
  const transport = createSecureTransport({
    ...tDeps,
    validateConsoleGrant: (grant, req) => {
      const a = activeAuthority
      if (a === null) throw fail(C.EXPIRED)
      return a.validate(grant, req)
    }
  })

  function ownerLive() { return genLive === generation && state !== 'stopped' && isLive() === true }

  function openOp(deadlineAt, purpose, externalSignal) {
    handoffSummary = null
    const authority = createConsoleGrantAuthority({
      owner, bootEpoch, generation: genLive, deadlineAt, now,
      isLive: (p) => {
        if (ownerLive() !== true) return false
        if (p === 'consoleBalance') return purpose === 'balance' && isLive('consoleBalance') === true
        return true
      }
    })
    const controller = new AbortController()
    let signal = controller.signal
    let detachExternal = null
    if (externalSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([controller.signal, externalSignal])
    } else if (externalSignal) {
      if (externalSignal.aborted === true) {
        try { controller.abort() } catch { /* ignore */ }
      } else if (typeof externalSignal.addEventListener === 'function') {
        // 只有**一条** fallback 监听；detach 幂等（closeOp 与 runOperation cleanup 都可调）。
        let attached = true
        const bridge = () => { try { controller.abort() } catch { /* ignore */ } }
        externalSignal.addEventListener('abort', bridge, { once: true })
        detachExternal = () => {
          if (!attached) return
          attached = false
          try { externalSignal.removeEventListener('abort', bridge) } catch { /* 已移除 */ }
        }
      }
    }
    const op = { authority, deadlineAt, purpose, controller, signal, closed: false, calls: 0, detachExternal }
    currentOp = op
    activeAuthority = authority
    return op
  }
  /** 关闭 op：先标记 closed（后续 assertOp 一律拒）→ 摘外部监听 → 失效 authority → abort。 */
  function closeOp(op) {
    if (!op) return
    op.closed = true
    if (typeof op.detachExternal === 'function') {
      try { op.detachExternal() } catch { /* 已移除 */ }
      op.detachExternal = null
    }
    if (activeAuthority === op.authority) activeAuthority = null
    if (currentOp === op) currentOp = null
    try { op.authority.invalidate() } catch { /* 已失效 */ }
    try { op.controller.abort() } catch { /* 已中止 */ }
  }
  /** 统一 op 门禁：原 op 必须仍是当前 op、未关闭、未取消、未过期、owner 有效 */
  function assertOp(op) {
    if (!op) throw fail(C.EXPIRED)
    if (currentOp !== op) throw fail(C.EXPIRED)
    if (op.closed) throw fail(C.EXPIRED)
    if (op.signal && op.signal.aborted === true) throw fail(C.CANCELLED)
    if (!ownerLive()) throw fail(C.EXPIRED)
    if (now() >= op.deadlineAt) throw fail(C.EXPIRED)
  }

  /**
   * 纯余额读取失败是否**保留**已认证 owner（不 clearSecrets、不把 state 打回 'new'）。
   *
   * 只覆盖三类「普通读失败」：
   *   - `TRANSIENT`：网络/429/5xx；
   *   - `BALANCE_PARSE`：**纯**响应解析失败（旧实现会清掉 Jar ⇒ 之后每次读永久 NOT_VERIFIED）；
   *   - `EXPIRED`：**读操作自身 deadline 到点**，且必须有「已到点」证据（now >= deadlineAt）。
   *
   * 以下一律**不**保留（原样终止/清凭据）：认证拒绝、凭据缺失、身份不符、SSO/挑战类、
   * CANCELLED、owner 已失效（退出/禁用/换号/代次变更）、以及没有到点证据的 EXPIRED。
   * 非 balance 操作（login/restore/export…）恒不保留。
   */
  function keepsVerifiedOnReadFailure(kind, fixed, op) {
    if (kind !== 'balance' || state !== 'verified') return false
    if (ownerLive() !== true) return false
    if (fixed === C.TRANSIENT || fixed === C.BALANCE_PARSE) return true
    if (fixed === C.EXPIRED) {
      const deadlineAt = op !== null && typeof op === 'object' ? op.deadlineAt : undefined
      return typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) && now() >= deadlineAt
    }
    return false
  }

  /** 用一个 op 覆盖整个 operation（含 onQr/approval/DNS/body await）的绝对 deadline 与取消 */
  function runOperation(deadlineAt, kind, externalSignal, factory) {
    if (!ownerLive()) return Promise.reject(fail(C.EXPIRED))
    if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) return Promise.reject(fail(C.INVALID))
    if (!(deadlineAt > now())) return Promise.reject(fail(C.EXPIRED))
    if (externalSignal && externalSignal.aborted === true) return Promise.reject(fail(C.CANCELLED))
    const op = openOp(deadlineAt, kind, externalSignal)
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        if (op.signal && typeof op.signal.removeEventListener === 'function') op.signal.removeEventListener('abort', onAbort)
        if (typeof op.detachExternal === 'function') op.detachExternal()
      }
      const finish = (ok, value, failCode) => {
        if (settled) return
        settled = true
        cleanup()          // 先摘监听（含外部 signal 桥）再 abort：正常 close 不得改写成失败
        if (ok !== true) {
          const fixed = settleCode(failCode)
          /**
           * 普通读失败（仅 balance：网络 / 纯解析 / 读操作自身 deadline 超时）不清凭据、
           * 不改 verified，交由上层（readFailures/freshness）决定展示与计数；
           * 认证/绑定/owner 失效/取消/非 balance 操作一律照旧清理。
           */
          const readFailureKeep = keepsVerifiedOnReadFailure(kind, fixed, op)
          try { op.authority.invalidate() } catch { /* ignore */ }
          try { op.controller.abort() } catch { /* ignore */ }
          if (!readFailureKeep) {
            clearSecrets()
            if (state !== 'stopped') { state = 'new'; code = fixed }
          }
          closeOp(op)
          reject(fail(fixed))
          return
        }
        closeOp(op)
        resolve(value)
      }
      const onAbort = () => finish(false, null, C.CANCELLED)
      const timer = setTimeout(() => finish(false, null, C.EXPIRED), Math.max(0, op.deadlineAt - now()))
      if (op.signal && typeof op.signal.addEventListener === 'function') {
        op.signal.addEventListener('abort', onAbort, { once: true })
      }
      Promise.resolve()
        .then(() => { assertOp(op); return factory(op) })
        .then((value) => {
          try { assertOp(op); finish(true, value) } catch (error) { finish(false, null, error && error.code) }
        }, (error) => finish(false, null, error && error.code))
    })
  }

  // Finite reasons only: do not retain/return rejected cookie names, values,
  // response fields, URLs, upstream text, or raw exception messages.
  function cookieIntakeCode(stage, reason) {
    // Both parts come exclusively from fixed Host-side branches, never wire text.
    const key = (stage === 'lp' ? 'LP' : stage === 'account' ? 'ACCOUNT' : 'PLATFORM') + '_COOKIE_' + reason
    return Object.prototype.hasOwnProperty.call(C, key) ? C[key]
      : (stage === 'lp' ? C.LP_COOKIE_POLICY : stage === 'account' ? C.ACCOUNT_COOKIE_POLICY : C.PLATFORM_COOKIE_POLICY)
  }
  function cookiePolicyCode(stage, result, line = null) {
    const rejected = result !== null && typeof result === 'object' && Array.isArray(result.rejected)
      ? result.rejected : []
    const has = code => rejected.some(r => r !== null && typeof r === 'object' && r.code === code)
    const domain = has(JAR_CODES.FOREIGN_DOMAIN) || has(JAR_CODES.BAD_DOMAIN)
    if (domain) return stage === 'lp' ? C.LP_COOKIE_DOMAIN
      : stage === 'account' ? C.ACCOUNT_COOKIE_DOMAIN : C.PLATFORM_COOKIE_DOMAIN
    for (const reason of ['EMPTY', 'CRLF', 'TOO_LARGE', 'BAD_NAME', 'STORE_FULL', 'BAD_SOURCE']) {
      if (has(JAR_CODES[reason])) return cookieIntakeCode(stage, reason)
    }
    if (has(JAR_CODES.BAD_VALUE)) {
      if (typeof line !== 'string') return cookieIntakeCode(stage, 'BAD_VALUE')
      const first = line.split(';', 1)[0]
      const at = first.indexOf('=')
      if (at <= 0) return cookieIntakeCode(stage, 'BAD_NAME')
      const value = first.slice(at + 1).trim()
      // The same cookie-octet predicate used by the unchanged underlying jar.
      // Only the reason label changes: no quoting/escaping/decoding fallback.
      return cookieIntakeCode(stage, /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)
        ? 'EXPIRY_FORMAT' : 'VALUE_FORMAT')
    }
    return stage === 'lp' ? C.LP_COOKIE_POLICY
      : stage === 'account' ? C.ACCOUNT_COOKIE_POLICY : C.PLATFORM_COOKIE_POLICY
  }

  function cookieOf(jar, url) {
    let r
    try { r = jar.cookieHeaderFor(url) } catch { throw fail(C.FLOW) }
    if (r === null || r === undefined) return ''
    if (typeof r !== 'object') throw fail(C.FLOW)
    if (r.dropped !== undefined && r.dropped !== 0) throw fail(C.COOKIE_HEADER_LIMIT)
    const header = r.header
    if (header === null || header === undefined || header === '') return ''
    if (typeof header !== 'string') throw fail(C.FLOW)
    return header
  }

  /**
   * Validate response cookies with their real, already-authorized source first.
   * Account and platform classes have separate fixed host/parent/name policies.
   * A valid parent-domain credential is narrowed to its exact service host;
   * this grants neither new network targets nor cross-class Cookie transport.
   * All other attributes (including server deletion/expiry) remain unchanged.
   */
  function scopeCredentialResponseCookies(rawLines, sourceUrl, op, stage) {
    assertOp(op)
    const source = new URL(sourceUrl)
    const platform = stage === 'platform'
    const host = platform ? PLATFORM : ACCOUNT
    const parent = platform ? 'xiaomimimo.com' : 'xiaomi.com'
    const sourceAllowed = platform ? source.hostname === PLATFORM
      : (source.hostname === ACCOUNT || source.hostname.endsWith('.' + ACCOUNT))
    if (source.protocol !== 'https:' || !sourceAllowed) {
      throw fail(cookiePolicyCode(stage, { rejected: [{ code: JAR_CODES.BAD_SOURCE }] }))
    }
    if (rawLines.length > 64) throw fail(cookieIntakeCode(stage, 'COUNT_LIMIT'))
    const allowed = new Set(platform
      ? ['api-platform_serviceToken', 'api-platform_slh', 'api-platform_ph', 'userId']
      : ['passToken', 'userId', 'deviceId', 'cUserId'])
    const lines = []
    const revoked = new Set()
    const provided = new Set()
    const bindings = new Map()
    for (const line of rawLines) {
      // An excluded name cannot become a credential. Do not make irrelevant UI,
      // tracking, or preference cookie formats part of authentication validity.
      const first = line.split(';', 1)[0]
      const eq = first.indexOf('=')
      const name = (eq < 0 ? first : first.slice(0, eq)).trim()
      if (!allowed.has(name)) continue
      const probe = new CookieJar({ allowQuotedValues: true, rootDomains: [host, parent], now })
      try {
        let result
        try { result = probe.absorb([line], sourceUrl) } catch { throw fail(cookieIntakeCode(stage, 'PARSE_ERROR')) }
        if (result.rejected.length > 0) throw fail(cookiePolicyCode(stage, result, line))
        const parts = line.split(';')
        const domainAttrs = parts.slice(1).filter(part => part.slice(0, part.indexOf('=')).trim().toLowerCase() === 'domain')
        if (domainAttrs.length > 1) throw fail(cookieIntakeCode(stage, 'DUP_DOMAIN'))
        provided.add(name)
        const value = cookieValueContent(parts[0].slice(parts[0].indexOf('=') + 1).trim())
        if (result.accepted > 0) {
          if (bindings.has(name) && bindings.get(name) !== value) throw fail(cookieIntakeCode(stage, 'DUP_VALUE'))
          bindings.set(name, value)
        }
        if (result.accepted === 0) revoked.add(name)
        const scoped = parts.map((part, index) => {
          if (index === 0) return part
          const eq = part.indexOf('=')
          if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== 'domain') return part
          const domain = part.slice(eq + 1).trim().replace(/^\./, '').toLowerCase()
          return domain === parent ? ' Domain=' + host : part
        }).join(';')
        lines.push(scoped)
      } finally { probe.clear() }
    }
    assertOp(op)
    return { lines, revoked, provided, bindings }
  }

  /**
   * 私有账号 Cookie 记录层（只服务导出，不参与任何认证判定）。
   * 每条已规范化的账号 Set-Cookie 先用**独立窄 jar**（同 allowQuote）校验，
   * 元数据取自 `describe()`，原始值取自该已验行本身 —— 不反射 vendor WeakMap。
   * sourceUrl 只用于当次校验，绝不写进 record。
   */
  function dropAccountRecords(name) {
    for (const key of [...accountRecords.keys()]) {
      if (accountRecords.get(key).name === name) accountRecords.delete(key)
    }
  }
  function recordAccountLine(line, sourceUrl) {
    try {
      if (typeof line !== 'string' || line === '') return
      const first = line.split(';', 1)[0]
      const eq = first.indexOf('=')
      if (eq <= 0) return
      const name = first.slice(0, eq).trim()
      if (!ACCOUNT_REMEMBERED_SET.has(name)) return
      const rawValue = first.slice(eq + 1).trim()
      const probe = new CookieJar({ allowQuotedValues: true, rootDomains: [ACCOUNT, 'xiaomi.com'], now })
      try {
        const out = probe.absorb([line], sourceUrl)
        if (out === null || typeof out !== 'object' || !Array.isArray(out.rejected)) return
        if (out.rejected.length > 0) return
        /**
         * 服务器删除/到期（`Max-Age<=0` 或过去的 `Expires`）：探测 jar 是**空**的，
         * 它没有旧条目可删，所以 `deleted` 恒为 0、`accepted` 也为 0。
         * 「未被拒绝且 0 接受」正是**有效删除/到期**的真判据——必须同步删掉私有记录，
         * 否则可选票（cUserId / deviceId）在真实 jar 里已删除、私有副本还留着，
         * 导出后重启就会把已撤销的票复活。删除行本身没有值，所以这一步必须排在
         * 取值合法性检查**之前**（否则空值会走成「跳过」而不是「删除」）。
         */
        if (out.accepted <= 0) { dropAccountRecords(name); return }
        if (!quoteSafeCookieValue(rawValue)) return
        const described = probe.describe()
        const meta = described.cookies[0]
        if (!meta || meta.name !== name) return
        accountRecords.set(name + '\u0000' + meta.domain + '\u0000' + meta.path, {
          name,
          value: rawValue,          // 原始串，保留外层引号
          domain: meta.domain,
          path: meta.path,
          hostOnly: meta.hostOnly === true,
          secure: meta.secure === true,
          httpOnly: meta.httpOnly === true,
          expiresAt: meta.expiresAt === null || meta.expiresAt === undefined ? null : meta.expiresAt
        })
      } finally { probe.clear() }
    } catch {
      // 记录层是旁路数据：失败只影响导出可用性，绝不改变认证流程/错误码
    }
  }
  function recordAccountLines(lines, sourceUrl) {
    if (!Array.isArray(lines)) return
    for (const line of lines) recordAccountLine(line, sourceUrl)
  }

  function absorb(jar, res, url, op, preparedLines = null) {
    if (op) assertOp(op)   // 写 CookieJar 之前必须仍是同一个 op（迟到票不得入库）
    const rawLines = preparedLines === null ? setCookieLines(res) : preparedLines
    const stage = jar === accountJar ? 'account' : 'platform'
    const scoped = preparedLines === null ? scopeCredentialResponseCookies(rawLines, url, op, stage) : null
    if (scoped !== null && stage === 'platform'
      && (scoped.revoked.has('api-platform_serviceToken') || scoped.revoked.has('userId'))) {
      throw fail(C.PLATFORM_CREDENTIAL_MISSING)
    }
    const lines = scoped === null ? rawLines : scoped.lines
    const revoked = scoped === null ? new Set() : scoped.revoked
    // 只有**真正被接受的非删除** Set-Cookie 才进入 set（scope 已做语义归一化，排除删除标记/引号差异）
    const set = scoped === null ? new Map() : new Map(scoped.bindings)
    if (lines.length === 0) return { revoked, set }
    let out
    try { out = jar.absorb(lines, url) } catch { throw fail(cookiePolicyCode(jar === accountJar ? 'account' : 'platform', null)) }
    if (out !== null && typeof out === 'object' && Array.isArray(out.rejected) && out.rejected.length > 0) {
      throw fail(cookiePolicyCode(jar === accountJar ? 'account' : 'platform', out))
    }
    // 私有记录只在**真实入库成功后**跟随，且仍是同一个 op（迟到票不补记录）
    if (stage === 'account') { if (op) assertOp(op); recordAccountLines(lines, url) }
    return { revoked, set }
  }

  /**
   * 单次请求。`spec.requestDeadline`（默认 = op 的绝对 deadline）同时用于
   * authority 校验、transport 的 deadlineAt 与本地 assertAuthorized 门禁——
   * 三者必须是**同一个**时刻，否则会出现「签发按 A、发送按 B」的缝。
   */
  async function call(op, spec) {
    assertOp(op)
    if (op.calls >= MAX_CALLS) throw fail(C.FLOW)
    const requestDeadline = typeof spec.requestDeadline === 'number' ? spec.requestDeadline : op.deadlineAt
    if (!(now() < requestDeadline)) throw fail(C.EXPIRED)
    op.calls += 1
    const url = spec.url
    const headers = {}
    if (spec.jar) {
      const cookie = cookieOf(spec.jar, url)
      if (cookie !== '') headers.cookie = cookie
    }
    const grant = op.authority.issue({
      url, purpose: spec.purpose, credentialClass: spec.credentialClass, sourceBinding: spec.source
    })
    let res
    try {
      res = await transport.fetch({
        url, method: 'GET', purpose: spec.purpose, credentialClass: spec.credentialClass, headers,
        grant, deadlineAt: requestDeadline, signal: op.signal,
        assertAuthorized: () => {
          try {
            if (!ownerLive() || op.closed || now() >= requestDeadline) return false
            return op.authority.validate(grant, {
              url, method: 'GET', purpose: spec.purpose, credentialClass: spec.credentialClass,
              headers, deadlineAt: requestDeadline, grant
            }) === true
          } catch { return false }
        }
      })
    } catch (error) {
      const c = error && error.code
      if (c === 'E_REQUEST_TIMEOUT') {
        // 只有「这一跳自己等超了、但整个 operation 还在期限里」才是 POLL_WAIT；
        // 取消/整体到期一律不循环（调用方拿到的是终止码）。
        if (spec.pollWait === true && now() < op.deadlineAt) throw fail(POLL_WAIT)
        throw fail(C.EXPIRED)
      }
      if (c === 'E_MIMO_AUTH_CANCELLED') throw fail(C.CANCELLED)
      if (c === 'E_MIMO_AUTH_TARGET_EXPIRED') throw fail(C.EXPIRED)
      if (c === 'E_NETWORK') throw fail(C.TRANSIENT)
      if (c === 'E_RESPONSE_TOO_LARGE') throw fail(C.RESPONSE_SIZE)
      throw fail(C.FLOW)
    }
    if (res.redirected !== false) throw fail(C.RESPONSE_REDIRECT)
    if (typeof res.url !== 'string' || res.url !== url) throw fail(C.FLOW)
    if (!res.tls || res.tls.authorized !== true) throw fail(C.FLOW)
    if (res.tls.servername !== new URL(url).hostname) throw fail(C.FLOW)
    if (!ownerLive() || op.closed) throw fail(C.EXPIRED)
    assertOp(op)
    return res
  }

  /** 读体 + 解析：**原 op** 在 await 前后、parse 之后都要复核（迟到体不得进入后续状态）。 */
  async function bodyJson(res, op) {
    if (op) assertOp(op)
    if (!ownerLive()) throw fail(C.EXPIRED)
    let ab
    try { ab = await res.body.arrayBuffer() } catch { throw fail(C.FLOW) }
    if (op) assertOp(op)
    const bytes = new Uint8Array(ab)
    if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) throw fail(C.RESPONSE_SIZE)
    if (!ownerLive()) throw fail(C.EXPIRED)
    const parsed = decodeJson(Buffer.from(bytes).toString('utf8'))
    if (op) assertOp(op)
    return parsed
  }

  function absorbAccountSeed(seed, sourceUrl, op) {
    if (op) assertOp(op)   // 种子写前复核：旧 op 的迟到 LP 结果不得覆盖/补种
    const lines = []
    for (const [name, value] of Object.entries(seed)) {
      lines.push(name + '=' + value + '; Domain=' + ACCOUNT + '; Path=/; Secure; HttpOnly')
    }
    let out
    try { out = accountJar.absorb(lines, sourceUrl) } catch { throw fail(C.ACCOUNT_COOKIE_POLICY) }
    if (out !== null && typeof out === 'object' && Array.isArray(out.rejected) && out.rejected.length > 0) {
      throw fail(cookiePolicyCode('account', out))
    }
    if (op) assertOp(op)
    recordAccountLines(lines, sourceUrl)
  }

  /** 读 SSO body，同时保留 `nonce` 的原始十进制 lexeme（大整数不被 Number 舍入）。 */
  async function bodyJsonWithNonce(res, op) {
    if (op) assertOp(op)
    if (!ownerLive()) throw fail(C.EXPIRED)
    let ab
    try { ab = await res.body.arrayBuffer() } catch { throw fail(C.SSO_RESPONSE_UNSUPPORTED) }
    if (op) assertOp(op)
    const bytes = new Uint8Array(ab)
    if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) throw fail(C.RESPONSE_SIZE)
    if (!ownerLive()) throw fail(C.EXPIRED)
    const text = Buffer.from(bytes).toString('utf8')
    const capture = { nonce: undefined }
    let json
    try {
      json = decodeJson(text, capture)
    } catch (error) {
      if (error && error.code === C.JSON_UNSUPPORTED) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      throw error
    }
    if (op) assertOp(op)
    return { json, nonceRaw: capture.nonce === undefined ? null : capture.nonce }
  }

  /** SSO 响应里的新账号 seed：只接受字符串/安全整数，缺省 = 未提供。 */
  function ssoSeedValueOf(json, name) {
    const v = json !== null && typeof json === 'object' ? json[name] : undefined
    if (v === undefined || v === null) return null
    if (typeof v === 'string') return v === '' ? null : v
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
    throw fail(C.SSO_RESPONSE_UNSUPPORTED)
  }

  /**
   * code 0 的 SSO 可携带**新签发的** userId/passToken（SDK `_update_account_seed` 同义）。
   * 只接受服务端本次明确给出、且与同响应非删除 Set-Cookie 不冲突的值；
   * 绝不从入参旧 record 回灌，也不把「被删除的同一旧值」复活。
   */
  function applySsoAccountSeed(json, absorbed, priorSeed, sourceUrl, op) {
    if (op) assertOp(op)
    const prior = priorSeed instanceof Map ? priorSeed : new Map()
    const read = (name) => {
      const rec = prior.get(name)
      if (rec === undefined || rec === null) return null
      if (typeof rec === 'string') return { value: rec, domain: ACCOUNT, path: '/', hostOnly: false, secure: true, httpOnly: true, expiresAt: null }
      return {
        value: typeof rec.value === 'string' ? rec.value : null,
        domain: rec.domain,
        path: rec.path,
        hostOnly: rec.hostOnly === true,
        secure: rec.secure === true,
        httpOnly: rec.httpOnly === true,
        expiresAt: rec.expiresAt === undefined ? null : rec.expiresAt,
      }
    }
    const expectedUid = expected !== null ? expected.identifier : accountId
    const uidRaw = ssoSeedValueOf(json, 'userId')
    const passRaw = ssoSeedValueOf(json, 'passToken')
    // 显式 userId 入口即核对身份（不要先装进 jar 再比较）
    if (uidRaw !== null && expectedUid !== null && cookieValueContent(String(uidRaw)) !== expectedUid) {
      throw fail(C.IDENTITY_MISMATCH)
    }
    // 完整 pair = 本次响应明确同时给出 userId+passToken 且 UID 就是绑定
    const fullPair = uidRaw !== null && passRaw !== null && expectedUid !== null
      && cookieValueContent(String(uidRaw)) === expectedUid
    const currentAccount = (name) => {
      try {
        const header = cookieOf(accountJar, ACCOUNT_BASE)
        if (header === '') return null
        const v = parseCookieHeader(header).get(name)
        return v === undefined ? null : v
      } catch { return null }
    }
    const seed = {}
    const reinstall = []
    for (const name of ['userId', 'passToken']) {
      const value = name === 'userId' ? uidRaw : passRaw
      if (value === null) continue
      const headerValue = absorbed !== null && absorbed.set instanceof Map ? absorbed.set.get(name) : undefined
      const semantic = cookieValueContent(String(value))
      if (headerValue !== undefined && headerValue !== semantic) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      const revoked = absorbed !== null && absorbed.revoked instanceof Set ? absorbed.revoked.has(name) : false
      // header 权威：同响应已用同值设置（可带 expiry）⇒ 不用 JSON 重装成 null
      if (headerValue !== undefined && headerValue === semantic) continue
      const old = read(name)
      const oldSemantic = old !== null && typeof old.value === 'string' ? cookieValueContent(old.value) : undefined
      if (name === 'passToken' && revoked && !fullPair) {
        // 被撤销的 secret：必须由本次完整明确 pair 提供新来源，同值/异值都一样
        throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      }
      if (name === 'userId' && revoked) {
        // 稳定身份被删：只允许补回**同值** UID，且当前 passToken 仍有效未被本响应撤销
        if (oldSemantic === undefined || oldSemantic !== semantic) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
        const passNow = currentAccount('passToken')
        const passRevoked = absorbed !== null && absorbed.revoked instanceof Set ? absorbed.revoked.has('passToken') : false
        if (!((passNow !== null && !passRevoked) || fullPair)) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
        reinstall.push(name)
        continue
      }
      if (oldSemantic === semantic) {
        // 同值且未删除：jar 仍有效就沿用（保留 raw/expiry）
        if (!revoked) continue
        // passToken 同值重签只可能走到这里且已过 fullPair 校验
        reinstall.push(name)
        continue
      }
      // 明确不同的新值（服务端本次签发）：header 无 expiry 时 expiresAt:null
      seed[name] = value
    }
    if (Object.keys(seed).length > 0) absorbAccountSeed(seed, sourceUrl, op)
    for (const name of reinstall) {
      const old = read(name)
      if (old === null || typeof old.value !== 'string' || old.value === '') throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      // 按 prior 原 metadata 重建：不得把 hostOnly=true 扩成 Domain、不得翻转 secure/httpOnly、不得延长 expiry
      if (old.domain !== ACCOUNT || old.path !== '/') throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      let line = name + '=' + old.value + '; Path=' + old.path
      if (old.hostOnly !== true) line += '; Domain=' + old.domain
      if (old.secure === true) line += '; Secure'
      if (old.httpOnly === true) line += '; HttpOnly'
      if (old.expiresAt !== null && old.expiresAt !== undefined) line += '; Expires=' + new Date(old.expiresAt).toISOString()
      if (op) assertOp(op)
      let out
      try { out = accountJar.absorb([line], sourceUrl) } catch { throw fail(C.ACCOUNT_COOKIE_POLICY) }
      if (out !== null && typeof out === 'object' && Array.isArray(out.rejected) && out.rejected.length > 0) {
        throw fail(cookiePolicyCode('account', out))
      }
      if (op) assertOp(op)
      recordAccountLines([line], sourceUrl)
    }
  }



  /**
   * SSO 的 STS URL：已有 clientSign/_ssign 逐字保留；否则仅当响应同时给出
   * nonce + ssecurity 时按 SDK 算法补 clientSign；只有一种材料 ⇒ fail closed；
   * 两者都没有 ⇒ 保留原 opaque URL（旧流程不凭空要求参数）。
   */
  function signedSsoTarget(json, nonceRaw) {
    const location = json !== null && typeof json === 'object' ? json.location : undefined
    if (typeof location !== 'string' || location === '' || location.length > 2048) throw fail(C.FLOW)
    let url
    try { url = new URL(location) } catch { throw fail(C.SSO_RESPONSE_UNSUPPORTED) }
    const signs = [...url.searchParams.getAll('clientSign'), ...url.searchParams.getAll('_ssign')]
    if (signs.length > 0) {
      if (signs.length !== 1 || signs[0] === '') throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      return url
    }
    const rawNonce = nonceRaw !== null && nonceRaw !== undefined
      ? String(nonceRaw)
      : (json.nonce === undefined || json.nonce === null ? null : String(json.nonce))
    const ssecurity = json.ssecurity
    const hasNonce = rawNonce !== null
    const hasSec = typeof ssecurity === 'string' && ssecurity !== ''
    if (!hasNonce && !hasSec) return url
    if (!hasNonce || !hasSec) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
    // 大整数 nonce 只接受原始十进制 lexeme；一经舍入/非法即拒绝，绝不拿近似值签名
    if (!/^[0-9]{1,64}$/.test(rawNonce)) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
    const digest = createHash('sha1').update('nonce=' + rawNonce + '&' + ssecurity, 'utf8').digest()
    url.searchParams.set('clientSign', digest.toString('base64'))
    return url
  }

  async function runSso(op) {
    const ctxRes = await call(op, { url: CONTEXT_URL, purpose: 'consoleContext', credentialClass: 'none' })
    if (ctxRes.status !== 301 && ctxRes.status !== 302) throw fail(C.FLOW)
    const loc = readHeader(ctxRes, 'location')
    assertOp(op)
    const ctxSource = op.authority.markSource('context', 'ctx', { location: loc })
    const ssoUrl = deriveConsoleSsoUrl(loc)
    const ssoRes = await call(op, { url: ssoUrl, purpose: 'consoleAccountSso', credentialClass: 'account', source: ctxSource, jar: accountJar })
    // 受控交接识别（放在任何 mandatory jar 之前）：200=JSON 兼容；固定 3xx=raw 过渡条
    const isJson200 = ssoRes.status === 200
    let target = null
    if (!isJson200) {
      if (![301, 302, 303, 307, 308].includes(ssoRes.status)) throw fail(C.FLOW)
      const handoffLoc = readHeader(ssoRes, 'location')
      let u
      try { u = new URL(handoffLoc) } catch { throw fail(C.SSO_RESPONSE_UNSUPPORTED) }
      // 固定闭集分类（不打印/不存储 URL 原文）；null 才是允许的 clean https platform/sts
      const rejectKind = targetKindOf(u)
      if (rejectKind !== null) {
        if (u.hostname === ACCOUNT) { assertOp(op); handoffSummary = buildHandoffSummary(u, 'header', ssoRes.status) }
        throw fail(rejectKind)
      }
      target = u
    }
    // 先快照「本次响应处理前」的 seed（含 raw 值与绝对 expiry）：absorb 会按 Set-Cookie 删除记录
    const seedPrior = new Map()
    for (const rec of accountRecords.values()) {
      if (!ACCOUNT_REMEMBERED_SET.has(rec.name)) continue
      // 只接受窄 root 记录，避免按 name 误拿非 root/其它域的同名 cookie
      if (rec.domain !== ACCOUNT || rec.path !== '/') continue
      seedPrior.set(rec.name, {
        value: rec.value,
        domain: rec.domain,
        path: rec.path,
        hostOnly: rec.hostOnly === true,
        secure: rec.secure === true,
        httpOnly: rec.httpOnly === true,
        expiresAt: rec.expiresAt === undefined ? null : rec.expiresAt,
      })
    }
    const absorbed = absorb(accountJar, ssoRes, ssoUrl, op)
    if (isJson200) {
      const { json, nonceRaw } = await bodyJsonWithNonce(ssoRes, op)
      if (json === null || typeof json !== 'object' || Array.isArray(json)) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      // challenge：只有 null/undefined 表示「无 challenge」；任何交互 challenge 都不绕过 MFA
      if (json.challenge !== undefined && json.challenge !== null) throw fail(C.SSO_CHALLENGE)
      // 公开交互标志：true ⇒ 固定 SSO_CHALLENGE；非 boolean ⇒ fail closed
      if (Object.prototype.hasOwnProperty.call(json, 'bSecondValidation')) {
        if (json.bSecondValidation === true) throw fail(C.SSO_CHALLENGE)
        if (typeof json.bSecondValidation !== 'boolean') throw fail(C.SSO_RESPONSE_UNSUPPORTED)
      }
      // 真实拒绝优先：70016 等必须在「账号票是否还在 jar」之前报出，不能被删除掩成缺失
      if (json.code !== 0 && json.code !== '0') throw fail(json.code === 70016 ? C.AUTH_REJECTED : C.SSO_RESPONSE_UNSUPPORTED)
      // code 0：可携带服务端新签发的 userId/passToken（SDK `_update_account_seed`）
      applySsoAccountSeed(json, absorbed, seedPrior, ssoUrl, op)
      target = signedSsoTarget(json, nonceRaw)
    }
    const accHeader = cookieOf(accountJar, 'https://' + ACCOUNT + '/')
    if (accHeader === '') throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
    const accMap = parseCookieHeader(accHeader)
    if (!accMap.has('passToken') || !accMap.has('userId')) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
    const accUid = accMap.get('userId')
    if (accountId !== null && accUid !== accountId) throw fail(C.IDENTITY_MISMATCH)
    if (expected !== null && accUid !== expected.identifier) throw fail(C.IDENTITY_MISMATCH)
    if (target === null) throw fail(C.SSO_RESPONSE_UNSUPPORTED)
    const jsonRejectKind = targetKindOf(target)
    if (jsonRejectKind !== null) {
      if (target.hostname === ACCOUNT) { assertOp(op); handoffSummary = buildHandoffSummary(target, 'json', 200) }
      throw fail(jsonRejectKind)
    }
    assertOp(op)
    const src = op.authority.markSource('sso', 'sso', { location: target.toString() })
    const cbRes = await call(op, { url: target.toString(), purpose: 'consolePlatformCallback', credentialClass: 'platform', source: src })
    if (cbRes.status !== 200 && cbRes.status !== 302 && cbRes.status !== 307) throw fail(C.FLOW)
    // 只接受**本次**服务器签发的平台票：新私有 jar 校验通过才替换旧 jar
    const fresh = new CookieJar({ allowQuotedValues: true, rootDomains: [PLATFORM], now })
    let transferred = false
    try {
      absorb(fresh, cbRes, target.toString(), op)
      const freshHeader = cookieOf(fresh, BALANCE_URL)
      if (freshHeader === '') throw fail(C.PLATFORM_CREDENTIAL_MISSING)
      const fm = parseCookieHeader(freshHeader)
      const freshToken = fm.get('api-platform_serviceToken')
      const freshUid = fm.get('userId')
      if (freshToken === undefined || freshUid === undefined) throw fail(C.PLATFORM_CREDENTIAL_MISSING)
      if (freshUid !== accountId) throw fail(C.IDENTITY_MISMATCH)
      if (expected !== null && freshUid !== expected.identifier) throw fail(C.IDENTITY_MISMATCH)
      assertOp(op)
      const old = platformJar
      platformJar = fresh
      platformId = freshUid
      transferred = true
      old.clear()
    } finally {
      // A rejected fresh ticket never survives in a temporary jar or falls back
      // to the old platform ticket. Operation failure clears the active jars.
      if (!transferred) fresh.clear()
    }
  }

  /** 兼容两种 headers 形态：Headers 风格（get）或普通小写对象（transport 可能统一） */
  function readHeader(res, name) {
    const h = res.headers
    if (h && typeof h.get === 'function') {
      const v = h.get(name)
      if (v === null || v === undefined || v === '') throw fail(C.FLOW)
      return String(v)
    }
    if (h && typeof h === 'object') {
      for (const k of Object.keys(h)) if (String(k).toLowerCase() === name) return String(h[k])
    }
    throw fail(C.FLOW)
  }
  function setCookieLines(res) {
    const h = res.headers
    const out = []
    if (h && typeof h.getSetCookie === 'function') {
      for (const line of h.getSetCookie()) out.push(String(line))
      return out
    }
    if (h && typeof h === 'object') {
      for (const k of Object.keys(h)) {
        if (String(k).toLowerCase() !== 'set-cookie') continue
        const v = h[k]
        if (Array.isArray(v)) for (const one of v) out.push(String(one))
        else out.push(String(v))
      }
    }
    return out
  }

  function readPlatformIdentity() {
    const header = cookieOf(platformJar, BALANCE_URL)
    if (header === '') throw fail(C.PLATFORM_CREDENTIAL_MISSING)
    const map = parseCookieHeader(header)
    const token = map.get('api-platform_serviceToken')
    const uid = map.get('userId')
    if (token === undefined || uid === undefined) throw fail(C.PLATFORM_CREDENTIAL_MISSING)
    return { header, token, userId: uid }
  }

  async function runLogin(args = {}, outerOp = null) {
    if (state === 'authorizing') throw fail(C.BUSY)
    if (loginUsed || loggedIn) throw fail(C.BUSY)
    if (!ownerLive()) throw fail(C.EXPIRED)
    if (isLive('consoleAuthResult') !== true) throw fail(C.AUTH_REQUIRED)
    if (typeof args.deadlineAt !== 'number' || !Number.isFinite(args.deadlineAt)) throw fail(C.INVALID)
    loginUsed = true
    state = 'authorizing'
    const op = outerOp || openOp(args.deadlineAt, 'login', args.signal)
    try {
      const ctxRes = await call(op, { url: CONTEXT_URL, purpose: 'consoleContext', credentialClass: 'none' })
      if (ctxRes.status !== 301 && ctxRes.status !== 302) throw fail(C.FLOW)
      const signedLoc = readHeader(ctxRes, 'location')
      const ctxSource = op.authority.markSource('context', 'ctx', { location: signedLoc })
      const qrUrl = deriveConsoleQrInitUrl(signedLoc)
      const qrRes = await call(op, { url: qrUrl, purpose: 'consoleQrInit', credentialClass: 'none', source: ctxSource })
      const qrJson = await bodyJson(qrRes, op)
      if (!isStr(qrJson.qr) || !isStr(qrJson.lp)) throw fail(C.FLOW)
      const qrSource = op.authority.markSource('qrInit', 'qr', { qr: qrJson.qr, lp: qrJson.lp })
      const imgRes = await call(op, { url: qrJson.qr, purpose: 'consoleQrImage', credentialClass: 'none', source: qrSource })
      let ab
      try { ab = await imgRes.body.arrayBuffer() } catch { throw fail(C.FLOW) }
      const img = new Uint8Array(ab)
      if (img.byteLength < 8 || img.byteLength > 256 * 1024) throw fail(C.FLOW)
      const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      const JPEG = [0xff, 0xd8, 0xff]
      const isPng = PNG.every((b, idx) => img[idx] === b)
      const isJpeg = JPEG.every((b, idx) => img[idx] === b)
      if (!isPng && !isJpeg) throw fail(C.FLOW)
      if (typeof args.onQr === 'function') await args.onQr({ bytes: img, mime: isPng ? 'image/png' : 'image/jpeg' })
      assertOp(op)   // onQr await 之后仍是**原** op（迟到二维码不得继续换票）
      // lp：regional 需同代显式批准
      const lpHost = new URL(qrJson.lp).hostname
      if (lpHost !== ACCOUNT) {
        if (!lpHost.endsWith('.' + ACCOUNT)) throw fail(C.LP_HOST_UNSUPPORTED)
        if (typeof args.approveTarget !== 'function') throw fail(C.AUTH_REQUIRED)
        const approved = await args.approveTarget({ url: qrJson.lp, purpose: 'consoleAuthResult', origin: lpHost })
        assertOp(op)   // 批准 await 之后复核：整体到期/取消/被取代 ⇒ 不继续
        if (approved !== true) throw fail(C.CANCELLED)
      }
      assertOp(op)
      /**
       * 有界多轮 long-poll：单次请求最多 35 s（且不超过整体 deadline）。
       * 那一跳超时只代表「还没扫码/还没确认」——继续等**同一个已批准 LP**，
       * 不重开 ctx/QR/approval，也不重置整体 deadline；取消/整体到期/未知
       * payload/MFA/challenge 一律终止，不进入下一轮。
       */
      let lp = null
      let lpRes = null
      for (;;) {
        assertOp(op)
        const requestDeadline = Math.min(now() + LP_REQUEST_MS, op.deadlineAt)
        try {
          lpRes = await call(op, {
            url: qrJson.lp, purpose: 'consoleAuthResult', credentialClass: 'none', source: qrSource,
            requestDeadline, pollWait: true
          })
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === POLL_WAIT) continue
          throw error
        }
        if (lpRes.status !== 200) throw fail(C.FLOW)
        lp = await bodyJson(lpRes, op)
        assertOp(op)
        if (lp === null || typeof lp !== 'object' || Array.isArray(lp)) throw fail(C.LP_SCHEMA_UNSUPPORTED)
        break
      }
      const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
      // MFA / challenge 需要交互：固定 unsupported，**不**进入下一轮轮询
      if (own(lp, 'challenge')) throw fail(C.LP_CHALLENGE)
      if (!own(lp, 'passToken') || typeof lp.passToken !== 'string' || !isStr(lp.passToken)) throw fail(C.AUTH_RESULT_SEED_MISSING)
      const actualAccountId = own(lp, 'userId') ? normalizeAuthenticatedAccountId(lp.userId) : null
      if (actualAccountId === null) throw fail(C.AUTH_RESULT_ID_INVALID)
      if (own(lp, 'cUserId') && (typeof lp.cUserId !== 'string' || !isStr(lp.cUserId))) throw fail(C.FLOW)
      if (!own(lp, 'location') || typeof lp.location !== 'string' || lp.location.length > 2048) throw fail(C.FLOW)
      const seed = { passToken: lp.passToken, userId: actualAccountId }
      if (own(lp, 'cUserId')) seed.cUserId = lp.cUserId
      // 本响应 SetCookie 先按**真实 LP URL** 在临时 jar 解析；与 JSON 种子冲突即拒（不得先后覆盖）
      const scoped = scopeCredentialResponseCookies(setCookieLines(lpRes), qrJson.lp, op, 'lp')
      // An explicit server revocation must not be resurrected by the JSON seed.
      if (scoped.revoked.has('passToken') || scoped.revoked.has('userId')) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
      if (scoped.revoked.has('cUserId')) delete seed.cUserId
      // Compare all declared credential paths, not just cookies eligible for
      // the LP path; a /pass-scoped conflicting identity must fail before SSO.
      for (const name of ['passToken', 'userId', 'cUserId']) {
        if (scoped.bindings.has(name) && own(seed, name) && scoped.bindings.get(name) !== seed[name]) throw fail(C.LP_SEED_CONFLICT)
      }
      const lpLines = scoped.lines
      const lpTemp = new CookieJar({ allowQuotedValues: true, rootDomains: [ACCOUNT], now })
      try {
        if (lpLines.length > 0) {
          let tmpOut
          try { tmpOut = lpTemp.absorb(lpLines, qrJson.lp) } catch { throw fail(C.LP_COOKIE_POLICY) }
          if (tmpOut.rejected.length > 0) throw fail(cookiePolicyCode('lp', tmpOut))
        }
        const lpHeader = cookieOf(lpTemp, qrJson.lp)
        if (lpHeader !== '') {
          const hm = parseCookieHeader(lpHeader)
          for (const name of ['passToken', 'userId', 'cUserId']) {
            if (hm.has(name) && own(seed, name) && hm.get(name) !== seed[name]) throw fail(C.LP_SEED_CONFLICT)
          }
        }
      } finally { lpTemp.clear() }
      assertOp(op)
      absorb(accountJar, lpRes, qrJson.lp, op, lpLines)
      // JSON fills only names not explicitly scoped by Set-Cookie. Do not
      // replace the server's Path/expiry/deletion with a synthetic session cookie.
      const bodyOnlySeed = Object.fromEntries(Object.entries(seed).filter(([name]) => !scoped.provided.has(name)))
      absorbAccountSeed(bodyOnlySeed, qrJson.lp, op)
      accountId = actualAccountId
      const loc2 = new URL(lp.location)
      if (loc2.hostname === PLATFORM && loc2.pathname === '/sts') {
        assertOp(op)
        const src = op.authority.markSource('authResult', 'auth', { location: loc2.toString() })
        const cbRes = await call(op, { url: loc2.toString(), purpose: 'consolePlatformCallback', credentialClass: 'platform', source: src })
        absorb(platformJar, cbRes, loc2.toString(), op)
        if (cbRes.status !== 200 && cbRes.status !== 302 && cbRes.status !== 307) throw fail(C.FLOW)
      } else if (loc2.hostname === ACCOUNT && loc2.pathname === '/pass/serviceLogin') {
        const sid = loc2.searchParams.getAll('sid')
        const cb = loc2.searchParams.getAll('callback')
        const signed = new URL(signedLoc)
        if (sid.length !== 1 || sid[0] !== 'api-platform') throw fail(C.LP_SID_UNSUPPORTED)
        if (cb.length !== 1 || cb[0] !== signed.searchParams.get('callback')) throw fail(C.LP_CALLBACK_UNSUPPORTED)
        await runSso(op)
      } else {
        throw fail(C.LP_TARGET_UNSUPPORTED)
      }
      assertOp(op)   // verified 提交前：原 op 必须仍唯一、未关闭、未取消、owner live、未过期
      const id = readPlatformIdentity()
      if (accountId === null || id.userId !== accountId) throw fail(C.IDENTITY_MISMATCH)
      if (expected !== null && id.userId !== expected.identifier) throw fail(C.IDENTITY_MISMATCH)
      platformId = id.userId
      loggedIn = true
      // confirmAfterScan：认证已完但绑定未定稿 —— 只保留私有候选，0 余额、不可导出。
      state = confirmAfterScan ? 'awaiting_confirmation' : 'verified'
      code = 'E_NONE'
      return { ok: true }
    } catch (error) {
      const c = error && error.code
      // 只有「仍是这个 op 的 owner」才允许清凭据/改状态：被取代或被 dispose 时不越权改写
      if (currentOp === op) {
        clearSecrets()
        if (state !== 'stopped') { state = 'new'; code = settleCode(c) }
      }
      throw fail(settleCode(c))
    } finally {
      if (outerOp === null) closeOp(op)
    }
  }

  function clearSecrets() {
    try { accountJar.clear() } catch { /* ignore */ }
    try { platformJar.clear() } catch { /* ignore */ }
    try { accountRecords.clear() } catch { /* ignore */ }
    accountId = null
    platformId = null
    loggedIn = false
    bound = null
    exportTrusted = false
  }

  async function readBalanceOnce(op) {
    assertOp(op)
    const res = await call(op, { url: BALANCE_URL, purpose: 'consoleBalance', credentialClass: 'platform', jar: platformJar })
    if (res.status === 401 || res.status === 403) {
      absorb(platformJar, res, BALANCE_URL, op)   // 先处理删除/变号
      const after = cookieOf(platformJar, BALANCE_URL)
      if (after === '') throw fail(C.AUTH_REJECTED)
      const map = parseCookieHeader(after)
      if (!map.has('api-platform_serviceToken') || !map.has('userId')) throw fail(C.AUTH_REJECTED)
      if (map.get('userId') !== authenticatedOrThrow()) throw fail(C.IDENTITY_MISMATCH)
      return { auth: true }
    }
    if (res.status === 429 || res.status >= 500) throw fail(C.TRANSIENT)
    if (res.status !== 200) throw fail(C.FLOW)
    /**
     * HTTP 200 但**响应体 raw JSON 畸形**：`decodeJson` 抛 `JSON_UNSUPPORTED`。
     * 对「余额这一次读」来说它是**纯响应体解析失败**（与 BALANCE_PARSE 同类），
     * 局部归一成 BALANCE_PARSE ⇒ 走既有「保留 verified / 下一次读恢复」路径；
     * 只归一这一个固定码：owner 失效 / EXPIRED / RESPONSE_SIZE / 传输与 SSO 错误原样上抛
     * （不放松 decodeJson 的重复 key/危险 key/size 规则，也不接受坏 body）。
     * 与 `bodyJsonWithNonce` 的同类局部归一保持同一写法。
     */
    let json
    try {
      json = await bodyJson(res, op)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === C.JSON_UNSUPPORTED) throw fail(C.BALANCE_PARSE)
      throw error
    }
    if (json.code !== 0 || !json.data || typeof json.data !== 'object') throw fail(C.BALANCE_PARSE)
    const projected = projectConsoleWallet(json.data)
    if (projected === null) throw fail(C.BALANCE_PARSE)
    assertOp(op)   // 迟到的 200 体不得写 Cookie/身份/数值
    absorb(platformJar, res, BALANCE_URL, op)
    const id = readPlatformIdentity()
    if (id.userId !== authenticatedOrThrow()) {
      clearSecrets(); if (state !== 'stopped') { state = 'new'; code = C.IDENTITY_MISMATCH }
      throw fail(C.IDENTITY_MISMATCH)
    }
    return {
      ok: true,
      identity: { namespace: NAMESPACE, identifier: platformId },
      balance: projected
    }
  }

  /** 平台票是否已在 jar 中缺失/到期（不抛错：仅用于决定是否在一次余额操作内续期）。 */
  function platformTicketMissing() {
    try {
      const r = platformJar.cookieHeaderFor(BALANCE_URL)
      if (r === null || r === undefined || r.header === null || r.header === undefined || r.header === '') return true
      const map = parseCookieHeader(r.header)
      return !(map.has('api-platform_serviceToken') && map.has('userId'))
    } catch { return true }
  }
  /** 已绑定的账号态是否仍可换票（passToken+userId 且语义 ID 仍是绑定 ID）。 */
  function accountStateUsable() {
    if (accountId === null) return false
    try {
      const header = cookieOf(accountJar, ACCOUNT_BASE)
      if (header === '') return false
      const map = parseCookieHeader(header)
      if (!map.has('passToken') || !map.has('userId')) return false
      return map.get('userId') === accountId
    } catch { return false }
  }

  function authenticatedOrThrow() {
    if (platformId === null || authenticatedIdOrNull() === null) throw fail(C.NOT_VERIFIED)
    return platformId
  }
  function authenticatedIdOrNull() { return loggedIn ? platformId : null }

  async function readBalance(args = {}) {
    if (!ownerLive()) throw fail(C.EXPIRED)
    // 首扫已完成但本人未确认：确认前一律拒，且 0 新请求
    if (state === 'awaiting_confirmation') throw fail(C.CONFIRM_REQUIRED)
    if (!loggedIn || state !== 'verified') throw fail(C.NOT_VERIFIED)
    if (typeof args.deadlineAt !== 'number' || !Number.isFinite(args.deadlineAt)) throw fail(C.INVALID)
    // single-flight 判定必须在开新 op **之前**：否则第二个调用会覆盖 currentOp，
    // 让第一个 balance op 的 assertOp 立即失效（并把旧 op 的迟到结果写回来）。
    if (balanceFlight !== null) return balanceFlight
    balanceFlight = (async () => {
      try {
        return await runOperation(args.deadlineAt, 'balance', args.signal, async (op) => {
          /**
           * 自然过期修正：平台票已缺失/到期、但已绑定账号态仍可用时，在**同一余额操作内**
           * 至多续期一次（runSso 三跳）+ 一次余额 = 4 跳；已有 401/403 路径保持
           * 「1 读 + 3 跳 + 1 读」= 5 跳，且**不叠加第二轮**。
           * 账号态也缺失 ⇒ 固定凭据缺失终止（不再让空 Cookie 走成 FLOW）。
           */
          let renewed = false
          if (platformTicketMissing()) {
            if (!accountStateUsable()) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
            renewalAttempts += 1
            await runSso(op)
            assertOp(op)
            renewed = true
          }
          const first = await readBalanceOnce(op)
          if (first.ok === true) {
            if (renewed) renewalSuccesses += 1
            return first
          }
          assertOp(op)
          // 本轮已换过票：不在同一操作内换第二次（临时错误不得演变成无限换票）
          if (renewed) throw fail(C.AUTH_REJECTED)
          renewalAttempts += 1
          await runSso(op)
          assertOp(op)
          const id = readPlatformIdentity()
          if (id.userId !== platformId) throw fail(C.IDENTITY_MISMATCH)
          const second = await readBalanceOnce(op)
          if (second.ok === true) { renewalSuccesses += 1; return second }
          throw fail(C.AUTH_REJECTED)
        })
      } catch (error) {
        const c = settleCode(error && error.code)
        // 普通读失败（网络/解析/读操作自身超时）保留 verified/凭据，下一读自动恢复；
        // 终止错误（认证/绑定/取消/owner 失效/非 balance）仍清 Jar/身份（runOperation 亦已处理大部分）
        const keep = state === 'stopped' || c === C.NOT_VERIFIED
          || keepsVerifiedOnReadFailure('balance', c, { deadlineAt: args.deadlineAt })
        if (!keep) {
          clearSecrets()
          if (state !== 'stopped') { state = 'new'; code = c }
        }
        throw fail(c)
      } finally { balanceFlight = null }
    })()
    return balanceFlight
  }

  function verifyIdentity() {
    if (!ownerLive()) throw fail(C.EXPIRED)
    if (state === 'awaiting_confirmation') throw fail(C.CONFIRM_REQUIRED)
    if (!loggedIn || state !== 'verified' || platformId === null) throw fail(C.NOT_VERIFIED)
    return { namespace: NAMESPACE, identifier: platformId }
  }

  /** 供未来 UI 区分「真的发生过」与「没发生」：只有固定计数，无账号/票/URL。 */
  function describe() {
    return Object.freeze({
      handoffSummary: handoffSummary === null ? null : projectConsoleHandoffSummary(handoffSummary),
      state,
      code,
      identity: platformId === null ? null : Object.freeze({ maskedLabel: mask(platformId) }),
      restoreAttempts,
      restoreSuccesses,
      renewalAttempts,
      renewalSuccesses
    })
  }

  /**
   * Host-only：本人以 authId/generation/boot 明确确认当前候选之后才调用。
   * 必须 identifier === 候选 actual === 平台签发 ID（严格模式还须等于已解密绑定）。
   * 一次冻结绑定并转 verified；同 ID 重复确认为幂等，换 ID 一律拒。
   */
  function confirmAccount(identifier) {
    if (!ownerLive()) throw fail(C.EXPIRED)
    const candidate = normalizeAuthenticatedAccountId(identifier)
    if (candidate === null) throw fail(C.INVALID)
    if (bound !== null) {
      if (candidate !== bound) throw fail(C.IDENTITY_MISMATCH)
      return Object.freeze({ ok: true, namespace: NAMESPACE, identifier: bound })
    }
    if (state !== 'awaiting_confirmation' && state !== 'verified') throw fail(C.NOT_VERIFIED)
    if (accountId === null || platformId === null) throw fail(C.NOT_VERIFIED)
    if (candidate !== accountId) throw fail(C.IDENTITY_MISMATCH)
    if (candidate !== platformId) throw fail(C.IDENTITY_MISMATCH)
    if (expected !== null && candidate !== expected.identifier) throw fail(C.IDENTITY_MISMATCH)
    bound = candidate
    exportTrusted = true
    if (state === 'awaiting_confirmation') { state = 'verified'; code = 'E_NONE' }
    return Object.freeze({ ok: true, namespace: NAMESPACE, identifier: bound })
  }

  /**
   * Host-only：首扫后的候选账号。仅证明「认证已完 + owner live」。
   * 不含 seed/票/URL/余额；nickname 固定 null（公开资料无 schema 依据，绝不以昵称作身份）。
   */
  function pendingAccount() {
    if (!ownerLive()) throw fail(C.EXPIRED)
    if (state !== 'awaiting_confirmation' || loggedIn !== true || accountId === null) return null
    if (platformId !== null && platformId !== accountId) return null
    return Object.freeze({ namespace: NAMESPACE, identifier: accountId, nickname: null })
  }

  /**
   * 只导出真正会发往账号基址（Path '/'）的记录，绝不重写 Path，
   * 也绝不把平台短票/余额/URL/QR/grant/boot ID 带出去。
   */
  function selectExportRecords() {
    const t = now()
    const byName = new Map()
    for (const rec of accountRecords.values()) {
      if (!ACCOUNT_REMEMBERED_SET.has(rec.name)) continue
      if (rec.domain !== ACCOUNT || rec.path !== '/') continue
      if (rec.expiresAt !== null && !(rec.expiresAt > t)) continue
      if (!quoteSafeCookieValue(rec.value)) continue
      if (byName.has(rec.name)) throw fail(C.ACCOUNT_COOKIE_DUP_VALUE)
      byName.set(rec.name, rec)
    }
    const out = []
    for (const name of ACCOUNT_REMEMBERED_NAMES) {
      const rec = byName.get(name)
      if (!rec) continue
      out.push(Object.freeze({
        name: rec.name,
        value: rec.value,          // 原始串（含引号），不解除转义/不解码
        domain: rec.domain,
        path: rec.path,
        hostOnly: rec.hostOnly,
        secure: rec.secure,
        httpOnly: rec.httpOnly,
        expiresAt: rec.expiresAt   // 服务器绝对值；缺省 null（不编 7/30 天）
      }))
    }
    return out
  }

  /**
   * Host 私有导出：只在「本人 confirmAccount」或「受信 restore 成功」之后可用。
   * 首扫未确认不放行；返回值里的 raw 值只在本调用内出现，不进 describe/DTO/logs。
   */
  function exportRememberedAccount() {
    if (!ownerLive()) throw fail(C.EXPIRED)
    if (state === 'awaiting_confirmation') throw fail(C.CONFIRM_REQUIRED)
    if (state !== 'verified' || loggedIn !== true || platformId === null || accountId === null) throw fail(C.NOT_VERIFIED)
    if (exportTrusted !== true || bound === null) throw fail(C.CONFIRM_REQUIRED)
    const header = cookieOf(accountJar, ACCOUNT_BASE)
    if (header === '') throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
    const map = parseCookieHeader(header)
    if (!map.has('passToken') || !map.has('userId')) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
    // 语义 ID（去外层引号后比较）必须仍是绑定 ID 与平台身份，不改任何原值
    if (map.get('userId') !== accountId || accountId !== platformId || accountId !== bound) throw fail(C.IDENTITY_MISMATCH)
    const cookies = selectExportRecords()
    const names = new Set(cookies.map(c => c.name))
    if (!names.has('passToken') || !names.has('userId')) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
    return Object.freeze({
      version: 1,
      namespace: NAMESPACE,
      accountId: bound,
      cookies: Object.freeze(cookies)
    })
  }

  /** 严格校验上层已解密的最小 record；任何形状/名/域/类型/expiry/引号异常都终止。 */
  function validateSavedAccount(saved) {
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) throw fail(C.INVALID)
    if (saved.version !== 1 || saved.namespace !== NAMESPACE) throw fail(C.INVALID)
    const id = normalizeAuthenticatedAccountId(saved.accountId)
    if (id === null) throw fail(C.INVALID)
    const list = saved.cookies
    if (!Array.isArray(list) || list.length === 0 || list.length > 32) throw fail(C.INVALID)
    const t = now()
    const seen = new Set()
    const records = []
    const lines = []
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw fail(C.INVALID)
      const name = entry.name
      if (typeof name !== 'string' || !ACCOUNT_REMEMBERED_SET.has(name)) throw fail(C.INVALID)
      if (seen.has(name)) throw fail(C.ACCOUNT_COOKIE_DUP_VALUE)   // 同名冲突一律拒
      seen.add(name)
      if (!quoteSafeCookieValue(entry.value)) throw fail(C.INVALID)
      if (entry.domain !== ACCOUNT) throw fail(C.ACCOUNT_COOKIE_DOMAIN)
      if (entry.path !== '/') throw fail(C.ACCOUNT_COOKIE_POLICY)
      if (typeof entry.hostOnly !== 'boolean' || typeof entry.secure !== 'boolean'
        || typeof entry.httpOnly !== 'boolean') throw fail(C.INVALID)
      const expiresAt = entry.expiresAt
      if (!(expiresAt === null
        || (typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > 0 && expiresAt <= MAX_DATE_MS))) {
        throw fail(C.INVALID)
      }
      // 已过期种子：终止（不续命、不重算 Max-Age）
      if (expiresAt !== null && !(expiresAt > t)) throw fail(C.EXPIRED)
      const rec = Object.freeze({
        name, value: entry.value, domain: entry.domain, path: entry.path,
        hostOnly: entry.hostOnly, secure: entry.secure, httpOnly: entry.httpOnly, expiresAt
      })
      records.push(rec)
      // 绝对 expiry 用 ISO 精确到毫秒回灌；**不**发 Max-Age（那会重新开始计时）
      let line = name + '=' + entry.value + '; Path=' + entry.path
      if (entry.hostOnly !== true) line += '; Domain=' + ACCOUNT
      if (entry.secure === true) line += '; Secure'
      if (entry.httpOnly === true) line += '; HttpOnly'
      if (expiresAt !== null) line += '; Expires=' + new Date(expiresAt).toISOString()
      lines.push(line)
    }
    if (!seen.has('passToken') || !seen.has('userId')) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
    const uidRec = records.find(r => r.name === 'userId')
    if (cookieValueContent(uidRec.value) !== id) throw fail(C.IDENTITY_MISMATCH)   // 语义 ID == 绑定
    return { accountId: id, records, lines }
  }

  /**
   * 受信恢复：只用于新建 + 明确非首扫模式（opts.expected 来自已解密且授权的绑定）。
   * 只装载账号窄 jar（保留原绝对 expiry）→ ctx → account SSO → platform callback **精确 3 跳**；
   * 不生成 QR、不读余额、不导入平台票。新平台 ID 必须同时等于保存绑定与账号态 ID。
   */
  async function restoreRememberedAccount(saved, args = {}) {
    if (!ownerLive()) throw fail(C.EXPIRED)
    if (expected === null) throw fail(C.INVALID)          // 首扫实例没有可核的绑定 ⇒ 不许恢复
    if (restoreUsed || loggedIn || loginUsed || state !== 'new') throw fail(C.INVALID)
    if (typeof args.deadlineAt !== 'number' || !Number.isFinite(args.deadlineAt)) throw fail(C.INVALID)
    const parsed = validateSavedAccount(saved)
    if (parsed.accountId !== expected.identifier) throw fail(C.IDENTITY_MISMATCH)
    restoreUsed = true
    restoreAttempts += 1
    return runOperation(args.deadlineAt, 'restore', args.signal, async (op) => {
      const fresh = new CookieJar({ allowQuotedValues: true, rootDomains: [ACCOUNT], now })
      let transferred = false
      try {
        const out = fresh.absorb(parsed.lines, ACCOUNT_BASE)
        if (out === null || typeof out !== 'object' || !Array.isArray(out.rejected)) throw fail(C.ACCOUNT_COOKIE_POLICY)
        if (out.rejected.length > 0) throw fail(C.ACCOUNT_COOKIE_POLICY)
        if (out.accepted !== parsed.records.length) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
        const header = cookieOf(fresh, ACCOUNT_BASE)
        if (header === '') throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
        const map = parseCookieHeader(header)
        if (!map.has('passToken') || !map.has('userId')) throw fail(C.ACCOUNT_CREDENTIAL_MISSING)
        if (map.get('userId') !== parsed.accountId) throw fail(C.IDENTITY_MISMATCH)
        assertOp(op)
        const old = accountJar
        accountJar = fresh
        accountRecords = new Map(parsed.records.map(r => [r.name + '\u0000' + ACCOUNT + '\u0000/', r]))
        transferred = true
        old.clear()
        accountId = parsed.accountId
        await runSso(op)   // 精确 3 跳
        assertOp(op)
        const id = readPlatformIdentity()
        if (id.userId !== accountId || id.userId !== expected.identifier) throw fail(C.IDENTITY_MISMATCH)
        platformId = id.userId
        loggedIn = true
        // 绑定取自已验记录 + 新平台 ID 一致；不由新响应「反造」昵称或新 ID
        bound = id.userId
        exportTrusted = true
        state = 'verified'
        code = 'E_NONE'
        restoreSuccesses += 1
        return { ok: true }
      } finally {
        if (!transferred) fresh.clear()
      }
    }).catch((error) => {
      // 内存已由 runOperation 清空；是否保留加密 store 由上层决定，这里只放行顺序重试
      restoreUsed = false
      throw error
    })
  }

  function dispose() {
    handoffSummary = null
    genLive = generation + 1
    closeOp(currentOp)
    clearSecrets()
    accountJar = new CookieJar({ allowQuotedValues: true, rootDomains: [ACCOUNT], now })
    platformJar = new CookieJar({ allowQuotedValues: true, rootDomains: [PLATFORM], now })
    state = 'stopped'
    code = 'E_NONE'
    balanceFlight = null
  }

  return Object.freeze({
    /**
     * 公开 login 入口：**先**做重复/在途判定，再开 op。
     * （先开 op 会让新 op 覆盖 currentOp，旧 op 的 assertOp 立刻失效 → 正常会话被误清。）
     */
    login: (args = {}) => {
      if (state === 'authorizing' || loginUsed || loggedIn) return Promise.reject(fail(C.BUSY))
      if (ownerLive() !== true) return Promise.reject(fail(C.EXPIRED))
      if (isLive('consoleAuthResult') !== true) return Promise.reject(fail(C.AUTH_REQUIRED))
      return runOperation(args.deadlineAt, 'login', args.signal, (op) => runLogin(args, op))
    },
    readBalance,
    verifyIdentity,
    describe,
    /** Host-only（不投给浏览器）：首扫候选账号，只有 {namespace, identifier, nickname:null} */
    pendingAccount,
    /** Host-only：本人确认候选后冻结绑定。未确认前 readBalance/verifyIdentity/export 一律 CONFIRM_REQUIRED */
    confirmAccount,
    /** Host-only：本人确认（或受信恢复）后导出最小可持久化账号记录 */
    exportRememberedAccount,
    /** Host-only：用上层已解密记录恢复（精确 3 跳，不扫码/不读余额） */
    restoreRememberedAccount,
    dispose
  })
}
