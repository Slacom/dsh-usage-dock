/**
 * MiMo dynamic longPoll · secure transport (local, lazy, fail-closed).
 *
 * This module deliberately has no top-level `node:https` / `node:dns` import.
 * `capability()` only probes local built-ins; `fetch(req)` is the only network
 * path and is never used for any non-longPoll purpose.
 *
 * Public contract (E2):
 *   createSecureTransport(deps) -> { capability(): {ok,code}, fetch(req) }
 *   req = { url, method:'GET', purpose:'longPoll', headers, signal, deadlineAt,
 *           assertAuthorized(), cookieScoped? }
 *
 * `assertAuthorized` is synchronous. It is invoked before DNS, after DNS,
 * before connect, after response headers, before and after body read. It must
 * be the Host's live/owner/boot/generation/canonical approval check.
 */

const ACCOUNT_HOST = 'account.xiaomi.com'
const ACCOUNT_SUFFIX = '.account.xiaomi.com'
const MAX_URL = 2048
const MAX_HOST = 253
const MAX_LABEL = 63
const DEFAULT_MAX_BODY = 256 * 1024
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SAFE_CODES = new Set([
  'E_MIMO_AUTH_FLOW',
  'E_MIMO_AUTH_CANCELLED',
  'E_MIMO_AUTH_STALE_GENERATION',
  'E_MIMO_AUTH_SESSION_EXPIRED',
  'E_MIMO_AUTH_TARGET_INVALID',
  'E_MIMO_AUTH_TARGET_EXPIRED',
  'E_MIMO_AUTH_APPROVAL_MISSING',
  'E_MIMO_AUTH_APPROVAL_UNKNOWN',
  'E_MIMO_AUTH_APPROVAL_EXPIRED',
  'E_MIMO_AUTH_BOOT_STALE',
  'E_MIMO_AUTH_STALE_TICKET',
  'E_DYNAMIC_URL_REJECTED',
  'E_URL_PURPOSE_MISMATCH',
  'E_REQUEST_TIMEOUT',
  'E_RESPONSE_TOO_LARGE',
  'E_NETWORK',
])

const fail = (code) => {
  const error = new Error(code)
  error.name = 'SecureTransportError'
  error.code = code
  return error
}

function ownCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : ''
}

function safeAuthError(error) {
  const code = ownCode(error)
  return fail(SAFE_CODES.has(code) ? code : 'E_MIMO_AUTH_TARGET_INVALID')
}

function clockOf(deps) {
  return typeof deps.clock === 'function' ? deps.clock : () => Date.now()
}

function hasBuiltin(name) {
  try {
    return typeof process === 'object' && typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule(name) !== null && process.getBuiltinModule(name) !== undefined
      : false
  } catch {
    return false
  }
}

let httpsPromise = null
let dnsPromise = null

function loadHttps(deps) {
  if (deps.https !== undefined) {
    return Promise.resolve(deps.https !== null && typeof deps.https?.request === 'function' ? deps.https : null)
  }
  if (httpsPromise === null) {
    httpsPromise = Promise.resolve()
      .then(() => (typeof process === 'object' && typeof process.getBuiltinModule === 'function'
        ? process.getBuiltinModule('node:https')
        : import('node:https')))
      .then((mod) => (mod !== null && typeof mod?.request === 'function' ? mod : null))
      .catch(() => null)
  }
  return httpsPromise
}

function loadDns(deps) {
  if (deps.dns !== undefined) {
    return Promise.resolve(deps.dns !== null && typeof deps.dns?.lookup === 'function' ? deps.dns : null)
  }
  if (dnsPromise === null) {
    dnsPromise = Promise.resolve()
      .then(() => (typeof process === 'object' && typeof process.getBuiltinModule === 'function'
        ? process.getBuiltinModule('node:dns/promises')
        : import('node:dns/promises')))
      .then((mod) => (mod !== null && typeof mod?.lookup === 'function' ? mod : null))
      .catch(() => null)
  }
  return dnsPromise
}

function ipv4Parts(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text))
  if (!m) return null
  // Reject leading-zero decimal/octal-like octets; only a single "0" is
  // unambiguous in this transport grammar.
  if (m.slice(1).some((v) => v.length > 1 && v[0] === '0')) return null
  const parts = m.slice(1).map((v) => Number(v))
  return parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? parts : null
}

function ipv4Int(parts) {
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function isPublicIpv4(parts) {
  if (parts === null) return false
  const n = ipv4Int(parts)
  const a = parts[0]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && parts[1] >= 64 && parts[1] <= 127) return false
  if (a === 169 && parts[1] === 254) return false
  if (a === 172 && parts[1] >= 16 && parts[1] <= 31) return false
  if (a === 192 && parts[1] === 168) return false
  if (a === 192 && parts[1] === 0 && parts[2] === 0) return false
  if (a === 192 && parts[1] === 0 && parts[2] === 2) return false
  if (a === 192 && parts[1] === 88 && parts[2] === 99) return false
  if (a === 198 && parts[1] === 18) return false
  if (a === 198 && parts[1] === 19) return false
  if (a === 198 && parts[1] === 51 && parts[2] === 100) return false
  if (a === 203 && parts[1] === 0 && parts[2] === 113) return false
  if (a === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return false
  return n !== 0
}

function parseIpv6(text) {
  let s = String(text).toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (s.length === 0 || s.includes('%')) return null
  // IPv4-mapped/compatible literals: convert the trailing dotted quad into
  // two hex groups before the normal group parser (e.g. ::ffff:192.0.2.1).
  const lastColon = s.lastIndexOf(':')
  const lastPart = lastColon >= 0 ? s.slice(lastColon + 1) : ''
  if (lastPart.includes('.')) {
    const v4 = ipv4Parts(lastPart)
    if (v4 === null) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16).padStart(4, '0')
    const lo = ((v4[2] << 8) | v4[3]).toString(16).padStart(4, '0')
    s = s.slice(0, lastColon + 1) + hi + ':' + lo
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const left = halves[0] === '' ? [] : halves[0].split(':')
  const right = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  const groups = []
  for (const raw of left) {
    if (raw === '') return null
    if (!/^[0-9a-f]{1,4}$/.test(raw)) return null
    groups.push(parseInt(raw, 16))
  }
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length
    if (missing < 1) return null
    for (let i = 0; i < missing; i += 1) groups.push(0)
  }
  for (const raw of right) {
    if (raw === '') return null
    if (!/^[0-9a-f]{1,4}$/.test(raw)) return null
    groups.push(parseInt(raw, 16))
  }
  if (groups.length !== 8) return null
  const mapped = groups.slice(0, 5).every((v) => v === 0) && groups[5] === 0xffff
  if (mapped) {
    const a = (groups[6] >> 8) & 0xff
    const b = groups[6] & 0xff
    const c = (groups[7] >> 8) & 0xff
    const d = groups[7] & 0xff
    return { family: 6, mapped: [a, b, c, d], groups }
  }
  return { family: 6, mapped: null, groups }
}

function isPublicIpv6(parsed) {
  if (parsed === null) return false
  if (parsed.mapped !== null) return isPublicIpv4(parsed.mapped)
  const g = parsed.groups
  if (g.every((v) => v === 0)) return false
  if (g.slice(0, 7).every((v) => v === 0) && g[7] === 1) return false
  if ((g[0] & 0xfe00) === 0xfc00) return false
  if ((g[0] & 0xffc0) === 0xfe80) return false
  if ((g[0] & 0xff00) === 0xff00) return false
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false
  if (g[0] === 0x2001 && g[1] === 0x0000) return false
  if (g[0] === 0x2001 && g[1] === 0x0002) return false
  if (g[0] === 0x2001 && g[1] === 0x0010) return false
  if (g[0] === 0x2001 && g[1] === 0x0020) return false
  if (g[0] === 0x2002) return false
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false
  // Only global unicast 2000::/3 remains; excludes ULA, link-local,
  // loopback, multicast, NAT64, documentation and ORCHID ranges above.
  return (g[0] & 0xe000) === 0x2000
}

function parseAddress(text) {
  const s = String(text || '')
  if (s.length === 0) return null
  const v4 = ipv4Parts(s)
  if (v4 !== null) return { family: 4, address: s, mapped: null, public: isPublicIpv4(v4) }
  const v6 = parseIpv6(s)
  if (v6 !== null) {
    return { family: 6, address: s, mapped: v6.mapped, public: isPublicIpv6(v6) }
  }
  return null
}

// ---------------------------------------------------------------------------
// [A2 / 2026-11-06] 正式 console 用途：只认本进程 authority 签发的 opaque grant。
// legacy `longPoll` 分支**完全不变**（下述新用途与它互不影响，新用途不继承旧授权）。
// ---------------------------------------------------------------------------
const CONSOLE_PURPOSES = new Set([
  'consoleContext',
  'consoleQrInit',
  'consoleQrImage',
  'consoleAuthResult',
  'consoleAccountSso',
  'consolePlatformCallback',
  'consoleBalance',
])
/**
 * 固定跨平台浏览器模板（token-monitor PR824 a18191e5 的 browserHeaders/UA literal）。
 * 不是读取/冒充本机真实 browser info；只在 consoleAccountSso 内部注入，不进入对外 allow-set。
 */
const SSO_BROWSER_HEADERS = Object.freeze({
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
})
const PLATFORM_HOST = 'platform.xiaomimimo.com'

/** 只做 URL 基本语法（不放宽 legacy）：host 语法 + 长度 + https + 无端口/userinfo/fragment */
function commonUrlSyntax(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL) {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  if (url.protocol !== 'https:') throw fail('E_DYNAMIC_URL_REJECTED')
  if (url.port !== '') throw fail('E_DYNAMIC_URL_REJECTED')
  if (url.username !== '' || url.password !== '') throw fail('E_DYNAMIC_URL_REJECTED')
  if (url.hash !== '') throw fail('E_DYNAMIC_URL_REJECTED')
  const host = url.hostname.toLowerCase()
  if (host.length === 0 || host.length > MAX_HOST || host.endsWith('.') || host.includes('..')) {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  if (host.startsWith('[') || host.includes(':') || ipv4Parts(host) !== null) throw fail('E_DYNAMIC_URL_REJECTED')
  if (!/^[a-z0-9.-]+$/.test(host)) throw fail('E_DYNAMIC_URL_REJECTED')
  for (const label of host.split('.')) {
    if (label.length === 0 || label.length > MAX_LABEL || !DNS_LABEL_RE.test(label)) throw fail('E_DYNAMIC_URL_REJECTED')
    if (/^xn--/i.test(label)) throw fail('E_DYNAMIC_URL_REJECTED')
  }
  return { url: url.toString(), parsed: url, host, extra: 0 }
}

/** 新用途的**目的域/路径**白名单（来源 kind 可信不构成越权；query 由 authority 钉死） */
function consoleTarget(eff) {
  const base = commonUrlSyntax(eff.url)
  const host = base.host
  const path = base.parsed.pathname
  const exactAccount = host === ACCOUNT_HOST
  const exactPlatform = host === PLATFORM_HOST
  let accountSub = false
  if (host.endsWith(ACCOUNT_SUFFIX)) accountSub = host.split('.').length - 3 <= 3
  const bad = () => { throw fail('E_URL_PURPOSE_MISMATCH') }
  switch (eff.purpose) {
    case 'consoleContext':
      if (!exactPlatform || path !== '/api/v1/genLoginUrl') bad()
      break
    case 'consoleQrInit':
      if (!exactAccount || path !== '/longPolling/loginUrl') bad()
      break
    case 'consoleQrImage':
      if (!(exactAccount || exactPlatform)) bad()          // 精确根域，不允许 regional 子域
      break
    case 'consoleAuthResult':
      if (!(exactAccount || accountSub)) bad()
      break
    case 'consoleAccountSso':
      if (!exactAccount || path !== '/pass/serviceLogin') bad()
      break
    case 'consolePlatformCallback':
      if (!exactPlatform || path !== '/sts') bad()          // 不许把 account 路径当 callback
      break
    case 'consoleBalance':
      if (!exactPlatform || path !== '/api/v1/balance' || base.parsed.search !== '') bad()
      break
    default:
      bad()
  }
  return base
}

/**
 * 冻结 effective request：headers 复制并冻结，assertAuthorized = (原 Host assert) && (grant scope 复检)。
 * 所有 check() 都基于这份快照 ⇒ 不会出现“验的是旧 headers、发的是新 Cookie”。
 */
function freezeEffectiveReq(req, validateGrant) {
  const rawHeaders = req.headers !== undefined && req.headers !== null && typeof req.headers === 'object'
    ? req.headers
    : {}
  const eff = {
    url: req.url,
    method: 'GET',
    purpose: req.purpose,
    credentialClass: req.credentialClass,
    deadlineAt: req.deadlineAt,
    signal: req.signal,
    grant: req.grant,
    headers: Object.freeze({ ...rawHeaders }),
    cookieScoped: true,   // 仅复用旧 header 语法；业务权限由 authority 判定
    assertAuthorized: null,
  }
  const hostAssert = typeof req.assertAuthorized === 'function' ? req.assertAuthorized : null
  eff.assertAuthorized = () => {
    if (hostAssert !== null) {
      let ok
      try { ok = hostAssert() } catch (error) { throw safeAuthError(error) }
      if (ok !== true) return false
    }
    try { return validateGrant(eff.grant, eff) === true } catch (error) { throw safeAuthError(error) }
  }
  return Object.freeze(eff)
}

function validateTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL) {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  if (url.protocol !== 'https:') throw fail('E_DYNAMIC_URL_REJECTED')
  if (url.port !== '') throw fail('E_DYNAMIC_URL_REJECTED')
  if (url.username !== '' || url.password !== '') throw fail('E_DYNAMIC_URL_REJECTED')
  if (url.hash !== '') throw fail('E_DYNAMIC_URL_REJECTED')
  const host = url.hostname.toLowerCase()
  if (host.length === 0 || host.length > MAX_HOST || host.endsWith('.') || host.includes('..')) {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  if (host.startsWith('[') || host.includes(':') || ipv4Parts(host) !== null) throw fail('E_DYNAMIC_URL_REJECTED')
  if (!/^[a-z0-9.-]+$/.test(host)) throw fail('E_DYNAMIC_URL_REJECTED')
  const labels = host.split('.')
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL || !DNS_LABEL_RE.test(label)) throw fail('E_DYNAMIC_URL_REJECTED')
    if (/^xn--/i.test(label)) throw fail('E_DYNAMIC_URL_REJECTED')
  }
  let extra = 0
  if (host === ACCOUNT_HOST) {
    extra = 0
  } else if (host.endsWith(ACCOUNT_SUFFIX)) {
    extra = labels.length - 3
  } else {
    throw fail('E_DYNAMIC_URL_REJECTED')
  }
  if (extra > 3) throw fail('E_DYNAMIC_URL_REJECTED')
  return { url: url.toString(), parsed: url, host, extra }
}

function sanitizeHeaders(headers, req) {
  if (headers === undefined || headers === null) return {}
  if (typeof headers !== 'object' || Array.isArray(headers)) throw fail('E_MIMO_AUTH_TARGET_INVALID')
  const out = {}
  for (const key of Object.keys(headers)) {
    const name = String(key).toLowerCase()
    if (!/^[a-z0-9-]+$/.test(name)) throw fail('E_MIMO_AUTH_TARGET_INVALID')
    if (name === 'authorization' || name === 'proxy-authorization' || name === 'host'
      || name === 'connection' || name === 'content-length' || name === 'transfer-encoding'
      || name === 'upgrade' || name === 'expect' || name === 'te' || name === 'trailer'
      || name === 'proxy-connection') throw fail('E_MIMO_AUTH_TARGET_INVALID')
    if (name !== 'accept' && name !== 'cookie') throw fail('E_MIMO_AUTH_TARGET_INVALID')
    if (name === 'cookie' && req.cookieScoped !== true) throw fail('E_MIMO_AUTH_TARGET_INVALID')
    const value = headers[key]
    if (typeof value !== 'string' || value.length === 0 || /[\r\n\u0000]/.test(value)) {
      throw fail('E_MIMO_AUTH_TARGET_INVALID')
    }
    out[name] = value
  }
  return out
}

function check(req, now) {
  if (req !== null && typeof req === 'object' && req.signal !== undefined
    && req.signal !== null && req.signal.aborted === true) throw fail('E_MIMO_AUTH_CANCELLED')
  if (now() >= req.deadlineAt) throw fail('E_REQUEST_TIMEOUT')
  if (typeof req.assertAuthorized !== 'function') throw fail('E_MIMO_AUTH_TARGET_INVALID')
  let ok
  try {
    ok = req.assertAuthorized()
  } catch (error) {
    throw safeAuthError(error)
  }
  if (ok !== true) throw fail('E_MIMO_AUTH_TARGET_INVALID')
}

function deadlinePromise(promise, req, now) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const cleanup = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const left = Math.max(1, req.deadlineAt - now())
    timer = setTimeout(() => finish(reject, fail('E_REQUEST_TIMEOUT')), left)
    if (typeof timer?.unref === 'function') timer.unref()
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

function normalizeAddressRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw fail('E_NETWORK')
  const out = []
  for (const row of rows) {
    const text = typeof row === 'string' ? row : (row !== null && typeof row === 'object' ? row.address : null)
    const parsed = typeof text === 'string' ? parseAddress(text) : null
    if (parsed === null || parsed.public !== true) throw fail('E_DYNAMIC_URL_REJECTED')
    out.push({ address: parsed.address, family: parsed.family, mapped: parsed.mapped })
  }
  return out
}

async function resolveAddresses(deps, host, req, now) {
  let resolver = deps.resolver
  if (typeof resolver !== 'function') {
    const dns = await loadDns(deps)
    if (dns === null || typeof dns.lookup !== 'function') throw fail('E_MIMO_AUTH_FLOW')
    resolver = (name) => dns.lookup(name, { all: true, verbatim: true })
  }
  let rows
  try {
    rows = await deadlinePromise(Promise.resolve().then(() => resolver(host)), req, now)
  } catch (error) {
    if (SAFE_CODES.has(ownCode(error))) throw error
    throw fail('E_NETWORK')
  }
  return normalizeAddressRows(rows)
}

function makeLookup(addresses) {
  const list = (Array.isArray(addresses) ? addresses : [])
    .map((row) => (typeof row === 'string'
      ? { address: row, family: row.includes(':') ? 6 : 4 }
      : { address: row?.address, family: row?.family === 6 ? 6 : 4 }))
    .filter((row) => typeof row.address === 'string' && row.address.length > 0)
  return function boundLookup(_hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : (options || {})
    const cb = typeof options === 'function' ? options : callback
    const wanted = opts.family === 4 || opts.family === 6 ? opts.family : 0
    const usable = wanted === 0 ? list : list.filter((row) => row.family === wanted)
    if (usable.length === 0) {
      const error = new Error('no validated address for requested family')
      error.code = 'ENOTFOUND'
      if (typeof cb === 'function') { cb(error); return }
      throw error
    }
    if (opts.all === true) {
      if (typeof cb !== 'function') throw new Error('lookup requires callback')
      cb(null, usable.map((row) => ({ address: row.address, family: row.family })))
      return
    }
    if (typeof cb !== 'function') throw new Error('lookup requires callback')
    cb(null, usable[0].address, usable[0].family)
  }
}

function headersOf(raw) {
  const map = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    get(name) {
      const value = map[String(name).toLowerCase()]
      if (value === undefined) return null
      return Array.isArray(value) ? value.join(', ') : String(value)
    },
    getSetCookie() {
      const value = map['set-cookie']
      if (value === undefined) return []
      return Array.isArray(value) ? value.slice() : [String(value)]
    },
  }
}

function bodyOf(bytes) {
  let used = false
  return {
    getReader() {
      if (used) {
        return {
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => undefined,
        }
      }
      used = true
      let offset = 0
      return {
        async read() {
          if (offset >= bytes.length) return { done: true, value: undefined }
          const end = Math.min(bytes.length, offset + 64 * 1024)
          const value = bytes.slice(offset, end)
          offset = end
          return { done: false, value }
        },
        async cancel() { offset = bytes.length },
      }
    },
    async arrayBuffer() {
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      return copy.buffer
    },
  }
}

async function readBody(res, req, now, maxBytes) {
  const chunks = []
  let total = 0
  const add = (value) => {
    if (typeof value === 'string') value = new TextEncoder().encode(value)
    if (!(value instanceof Uint8Array)) throw fail('E_NETWORK')
    total += value.byteLength
    if (total > maxBytes) throw fail('E_RESPONSE_TOO_LARGE')
    chunks.push(value)
  }
  const reader = res !== null && typeof res === 'object' && res.body !== undefined
    && res.body !== null && typeof res.body.getReader === 'function'
    ? res.body.getReader()
    : null
  if (reader !== null) {
    for (;;) {
      if (now() >= req.deadlineAt) throw fail('E_REQUEST_TIMEOUT')
      const step = await deadlinePromise(reader.read(), req, now)
      if (step?.done === true) break
      add(step?.value)
    }
  } else if (res !== null && typeof res === 'object' && typeof res[Symbol.asyncIterator] === 'function') {
    for await (const value of res) {
      if (now() >= req.deadlineAt) throw fail('E_REQUEST_TIMEOUT')
      add(value)
    }
  } else {
    throw fail('E_NETWORK')
  }
  if (res !== null && typeof res === 'object' && res.complete === false) throw fail('E_NETWORK')
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return merged
}

function requestOnce(deps, target, headers, addresses, req, now, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false
    let requestObj = null
    let timer = null
    let onAbort = null
    let onError = null
    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (requestObj !== null && onError !== null && typeof requestObj.removeListener === 'function') {
        requestObj.removeListener('error', onError)
      }
      onError = null
      if (req.signal !== undefined && req.signal !== null && typeof req.signal.removeEventListener === 'function' && onAbort !== null) {
        req.signal.removeEventListener('abort', onAbort)
      }
      onAbort = null
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (fn === reject && requestObj !== null && typeof requestObj.destroy === 'function') {
        try { requestObj.destroy() } catch { /* 已断开 */ }
      }
      cleanup()
      fn(value)
    }
    if (req.signal !== undefined && req.signal !== null) {
      if (req.signal.aborted === true) { reject(fail('E_MIMO_AUTH_CANCELLED')); return }
      if (typeof req.signal.addEventListener === 'function') {
        onAbort = () => {
          if (requestObj !== null && typeof requestObj.destroy === 'function') {
            try { requestObj.destroy() } catch { /* 已断开 */ }
          }
          finish(reject, fail('E_MIMO_AUTH_CANCELLED'))
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    const left = Math.max(1, req.deadlineAt - now())
    timer = setTimeout(() => {
      if (requestObj !== null && typeof requestObj.destroy === 'function') {
        try { requestObj.destroy() } catch { /* 已断开 */ }
      }
      finish(reject, fail('E_REQUEST_TIMEOUT'))
    }, left)
    if (typeof timer?.unref === 'function') timer.unref()

    const requestImpl = deps.request
    if (typeof requestImpl !== 'function') {
      finish(reject, fail('E_MIMO_AUTH_FLOW'))
      return
    }
    try {
      check(req, now)
    } catch (error) {
      finish(reject, error)
      return
    }
    const options = {
      host: target.host,
      port: 443,
      path: target.parsed.pathname + target.parsed.search,
      method: 'GET',
      headers,
      lookup: makeLookup(addresses),
      servername: target.host,
      agent: false,
      rejectUnauthorized: true,
    }
    if (req.signal !== undefined && req.signal !== null) options.signal = req.signal
    try {
      requestObj = requestImpl(options, (res) => {
        if (settled) return
        try {
          check(req, now)
        } catch (error) {
          finish(reject, error)
          return
        }
        readBody(res, req, now, maxBytes).then((bytes) => {
          try {
            check(req, now)
          } catch (error) {
            finish(reject, error)
            return
          }
          const socket = res?.socket ?? res?.connection ?? null
          const peerAddress = socket !== null && typeof socket.remoteAddress === 'string' ? socket.remoteAddress : ''
          const body = bodyOf(bytes)
          finish(resolve, {
            status: typeof res?.statusCode === 'number' ? res.statusCode : (typeof res?.status === 'number' ? res.status : 0),
            headers: headersOf(res?.headers),
            body,
            arrayBuffer: body.arrayBuffer,
            url: target.url,
            redirected: false,
            tls: { servername: target.host, peerAddress, authorized: true },
          })
        }, (error) => {
          const code = ownCode(error)
          finish(reject, fail(SAFE_CODES.has(code) ? code : 'E_NETWORK'))
        })
      })
      if (requestObj !== null && typeof requestObj.on === 'function') {
        onError = () => finish(reject, fail('E_NETWORK'))
        requestObj.on('error', onError)
      }
      if (requestObj === null || typeof requestObj !== 'object' || typeof requestObj.end !== 'function') {
        finish(reject, fail('E_MIMO_AUTH_FLOW'))
        return
      }
      requestObj.end()
    } catch {
      finish(reject, fail('E_NETWORK'))
    }
  })
}

export function createSecureTransport(deps = {}) {
  const options = deps !== null && typeof deps === 'object' ? deps : {}
  const now = clockOf(options)
  const maxBytes = Number.isInteger(options.maxBodyBytes) && options.maxBodyBytes > 0
    ? options.maxBodyBytes
    : DEFAULT_MAX_BODY
  // 代码级注入（构造函数内捕获）：不从 req/JSON 读取；缺失时任何 console 用途直接拒
  const validateConsoleGrant = typeof options.validateConsoleGrant === 'function'
    ? options.validateConsoleGrant
    : null

  function capability() {
    const httpsOk = typeof options.request === 'function'
      || (options.https !== undefined ? options.https !== null && typeof options.https?.request === 'function' : hasBuiltin('node:https'))
    const dnsOk = typeof options.resolver === 'function'
      || (options.dns !== undefined ? options.dns !== null && typeof options.dns?.lookup === 'function' : hasBuiltin('node:dns/promises'))
    return httpsOk && dnsOk
      ? { ok: true, code: 'E_NONE' }
      : { ok: false, code: 'E_MIMO_AUTH_FLOW' }
  }

  async function fetchConsole(req) {
    if (typeof validateConsoleGrant !== 'function') throw fail('E_URL_PURPOSE_MISMATCH')
    // 与 legacy 同一条硬要求：Host 必须提供同步 assertAuthorized 函数（不可用 wrapper 冒充）
    if (typeof req.assertAuthorized !== 'function') throw fail('E_MIMO_AUTH_TARGET_INVALID')
    const eff = freezeEffectiveReq(req, validateConsoleGrant)
    // DNS 之前：不可伪造 grant 先验（无 network、无解析）
    let scopeOk = false
    try { scopeOk = validateConsoleGrant(eff.grant, eff) === true } catch (error) { throw safeAuthError(error) }
    if (scopeOk !== true) throw fail('E_MIMO_AUTH_TARGET_INVALID')
    const target = consoleTarget(eff)
    const callerHeaders = sanitizeHeaders(eff.headers, { cookieScoped: true })
    // SSO 仅在内部合并固定浏览器模板；caller 仍然只允许 accept/cookie（任意 UA/其它头一律先拒）
    let active = eff
    if (eff.purpose === 'consoleAccountSso') {
      const merged = { ...callerHeaders, ...SSO_BROWSER_HEADERS }
      // 以**原冻结 eff** 重建（不再读可变 req）；hostAssert 捕获原 eff.assertAuthorized
      active = freezeEffectiveReq({ ...eff, headers: merged, assertAuthorized: () => eff.assertAuthorized() }, validateConsoleGrant)
    }
    check(active, now)
    const addresses = await resolveAddresses(options, target.host, active, now)
    check(active, now)
    if (addresses.length === 0) throw fail('E_DYNAMIC_URL_REJECTED')
    check(active, now)
    let requestImpl = options.request
    if (typeof requestImpl !== 'function') {
      const https = await loadHttps(options)
      if (https === null || typeof https.request !== 'function') throw fail('E_MIMO_AUTH_FLOW')
      requestImpl = https.request.bind(https)
    }
    check(active, now)
    return requestOnce({ ...options, request: requestImpl }, target, eff.purpose === 'consoleAccountSso' ? active.headers : callerHeaders, addresses, active, now, maxBytes)
  }

  async function fetch(req) {
    const cap = capability()
    if (cap.ok !== true) throw fail(cap.code)
    if (req === null || typeof req !== 'object') throw fail('E_MIMO_AUTH_TARGET_INVALID')
    if (req.method !== 'GET') throw fail('E_DYNAMIC_URL_REJECTED')
    const isConsole = typeof req.purpose === 'string' && CONSOLE_PURPOSES.has(req.purpose)
    if (!isConsole && req.purpose !== 'longPoll') throw fail('E_URL_PURPOSE_MISMATCH')
    if (typeof req.deadlineAt !== 'number' || !Number.isFinite(req.deadlineAt)) throw fail('E_MIMO_AUTH_TARGET_INVALID')
    if (req.deadlineAt <= now()) throw fail('E_REQUEST_TIMEOUT')
    if (isConsole) return fetchConsole(req)
    const target = validateTarget(req.url)
    const headers = sanitizeHeaders(req.headers, req)
    check(req, now)
    const addresses = await resolveAddresses(options, target.host, req, now)
    check(req, now)
    if (addresses.length === 0) throw fail('E_DYNAMIC_URL_REJECTED')
    check(req, now)
    let requestImpl = options.request
    if (typeof requestImpl !== 'function') {
      const https = await loadHttps(options)
      if (https === null || typeof https.request !== 'function') throw fail('E_MIMO_AUTH_FLOW')
      requestImpl = https.request.bind(https)
    }
    check(req, now)
    return requestOnce({ ...options, request: requestImpl }, target, headers, addresses, req, now, maxBytes)
  }

  return { capability, fetch }
}

export {
  ACCOUNT_HOST,
  ACCOUNT_SUFFIX,
  DNS_LABEL_RE,
  parseAddress,
  isPublicIpv4,
  isPublicIpv6,
  makeLookup,
  validateTarget,
  sanitizeHeaders,
}
