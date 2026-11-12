/**
 * MiMo P1 支撑底座 · 分域 Cookie Jar（纯逻辑，无 IO、无网络、无宿主依赖）
 *
 * 源自冻结的 tools/poc/mimo-settings-plugin/lib/vendor/cookie-jar.mjs。
 * 只做一件事：把逐条 `Set-Cookie` 按"来源 authority"吸收进内存，并按"目标 URL"挑出该发的 Cookie。
 */

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_OCTET_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const MAX_DATE_MS = 8.64e15

export const JAR_CODES = Object.freeze({
  EMPTY: 'E_COOKIE_EMPTY',
  CRLF: 'E_COOKIE_CRLF',
  TOO_LARGE: 'E_COOKIE_TOO_LARGE',
  BAD_NAME: 'E_COOKIE_BAD_NAME',
  BAD_VALUE: 'E_COOKIE_BAD_VALUE',
  BAD_DOMAIN: 'E_COOKIE_BAD_DOMAIN',
  FOREIGN_DOMAIN: 'E_COOKIE_FOREIGN_DOMAIN',
  STORE_FULL: 'E_COOKIE_STORE_FULL',
  BAD_SOURCE: 'E_COOKIE_BAD_SOURCE',
})

const DEFAULT_LIMITS = Object.freeze({ maxCookies: 64, maxCookieBytes: 4096, maxHeaderBytes: 8192 })
const rawValues = new WeakMap()

function keyOf(cookie) { return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}` }
function defaultPathOf(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0 || pathname[0] !== '/') return '/'
  const at = pathname.lastIndexOf('/')
  return at <= 0 ? '/' : pathname.slice(0, at)
}
function domainMatches(host, cookie) { return cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`) }
function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/'
}
function normalizeRootDomains(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const candidate = entry.replace(/^\./, '').trim().toLowerCase()
    if (candidate.length === 0 || !DOMAIN_RE.test(candidate) || IPV4_RE.test(candidate) || candidate.includes('..') || !candidate.includes('.')) continue
    out.push(candidate)
  }
  return out
}

export class CookieJar {
  #cookies = new Map()
  #limits
  #now
  #rootDomains
  #allowQuotedValues

  constructor(options = {}) {
    this.#limits = {
      maxCookies: Number.isInteger(options.maxCookies) ? options.maxCookies : DEFAULT_LIMITS.maxCookies,
      maxCookieBytes: Number.isInteger(options.maxCookieBytes) ? options.maxCookieBytes : DEFAULT_LIMITS.maxCookieBytes,
      maxHeaderBytes: Number.isInteger(options.maxHeaderBytes) ? options.maxHeaderBytes : DEFAULT_LIMITS.maxHeaderBytes,
    }
    this.#now = typeof options.now === 'function' ? options.now : Date.now
    this.#rootDomains = normalizeRootDomains(options.rootDomains)
    // Compatibility is opt-in; legacy callers retain the exact old predicate.
    this.#allowQuotedValues = options.allowQuotedValues === true
    rawValues.set(this, new Map())
  }

  get size() { return this.#cookies.size }
  get rootDomains() { return [...this.#rootDomains] }
  describe() {
    return {
      count: this.#cookies.size,
      cookies: [...this.#cookies.values()].map((cookie) => ({
        domain: cookie.domain, path: cookie.path, name: cookie.name, hostOnly: cookie.hostOnly,
        secure: cookie.secure, httpOnly: cookie.httpOnly, expiresAt: cookie.expiresAt,
      })),
    }
  }
  toJSON() { return this.describe() }
  toString() { return `CookieJar(${this.#cookies.size})` }
  clear() { this.#cookies.clear(); rawValues.get(this)?.clear() }

  absorb(lines, sourceUrl) {
    const list = Array.isArray(lines) ? lines : (typeof lines === 'string' ? [lines] : [])
    const rejected = []
    let accepted = 0
    let deleted = 0
    let source
    try { source = new URL(sourceUrl) } catch { return { accepted: 0, deleted: 0, rejected: [{ code: JAR_CODES.BAD_SOURCE }] } }
    if (source.protocol !== 'https:' && source.protocol !== 'http:') return { accepted: 0, deleted: 0, rejected: [{ code: JAR_CODES.BAD_SOURCE }] }
    const host = source.hostname.toLowerCase()
    const now = this.#now()
    const values = rawValues.get(this)
    for (const line of list) {
      const parsed = this.#parseOne(line, host, source.pathname, now)
      if (!parsed.ok) { rejected.push({ code: parsed.code }); continue }
      const { cookie, removed } = parsed
      if (removed) {
        const key = keyOf(cookie)
        if (this.#cookies.delete(key)) deleted += 1
        values.delete(key)
        continue
      }
      const key = keyOf(cookie)
      if (!this.#cookies.has(key) && this.#cookies.size >= this.#limits.maxCookies) { rejected.push({ code: JAR_CODES.STORE_FULL }); continue }
      const { __rawValue, ...meta } = cookie
      this.#cookies.set(key, meta)
      values.set(key, __rawValue)
      accepted += 1
    }
    return { accepted, deleted, rejected }
  }

  cookieHeaderFor(targetUrl) {
    let target
    try { target = new URL(targetUrl) } catch { return { header: null, names: [], dropped: 0 } }
    const host = target.hostname.toLowerCase()
    const path = target.pathname.length > 0 ? target.pathname : '/'
    const secureOk = target.protocol === 'https:'
    const now = this.#now()
    const values = rawValues.get(this)
    const picked = []
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) { this.#cookies.delete(key); values.delete(key); continue }
      if (cookie.secure && !secureOk) continue
      if (!domainMatches(host, cookie)) continue
      if (!pathMatches(path, cookie.path)) continue
      picked.push({ cookie, value: values.get(key) ?? '' })
    }
    picked.sort((a, b) => (b.cookie.path.length - a.cookie.path.length) || (a.cookie.createdAt - b.cookie.createdAt))
    const names = []
    let header = ''
    let dropped = 0
    for (const item of picked) {
      const pair = `${item.cookie.name}=${item.value}`
      const next = header.length === 0 ? pair : `${header}; ${pair}`
      if (next.length > this.#limits.maxHeaderBytes) { dropped += 1; continue }
      header = next
      names.push(item.cookie.name)
    }
    return { header: header.length > 0 ? header : null, names, dropped }
  }

  #parseOne(line, sourceHost, sourcePath, now) {
    if (typeof line !== 'string' || line.length === 0) return { ok: false, code: JAR_CODES.EMPTY }
    if (line.length > this.#limits.maxCookieBytes) return { ok: false, code: JAR_CODES.TOO_LARGE }
    if (line.includes('\r') || line.includes('\n')) return { ok: false, code: JAR_CODES.CRLF }
    const parts = line.split(';')
    const first = parts[0].trim()
    const eq = first.indexOf('=')
    if (eq <= 0) return { ok: false, code: JAR_CODES.BAD_NAME }
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!TOKEN_RE.test(name)) return { ok: false, code: JAR_CODES.BAD_NAME }
    if (!COOKIE_OCTET_RE.test(value)) {
      const quoted = this.#allowQuotedValues && value.length >= 2
        && value.startsWith('"') && value.endsWith('"')
        && COOKIE_OCTET_RE.test(value.slice(1, -1))
      if (!quoted) return { ok: false, code: JAR_CODES.BAD_VALUE }
    }
    // Store __rawValue unchanged, including its original quotes. No unescaping,
    // percent/JSON decoding, or coercion is performed.
    let domain = sourceHost
    let explicitDomain = false
    let path = null
    let secure = false
    let httpOnly = false
    let expiresAt = null
    let sawMaxAge = false
    let sawExpires = false
    let maxAgeNonPositive = false
    for (const rawAttr of parts.slice(1)) {
      const attr = rawAttr.trim()
      if (attr.length === 0) continue
      const at = attr.indexOf('=')
      const attrName = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase()
      const attrValue = at === -1 ? '' : attr.slice(at + 1).trim()
      if (attrName === 'domain') {
        const candidate = attrValue.replace(/^\./, '').toLowerCase()
        if (candidate.length === 0 || !DOMAIN_RE.test(candidate) || IPV4_RE.test(candidate) || candidate.includes('..')) return { ok: false, code: JAR_CODES.BAD_DOMAIN }
        explicitDomain = true
        if (candidate === sourceHost) domain = candidate
        else if (sourceHost.endsWith(`.${candidate}`) && this.#rootDomains.includes(candidate)) domain = candidate
        else return { ok: false, code: JAR_CODES.FOREIGN_DOMAIN }
      } else if (attrName === 'path') {
        path = attrValue.startsWith('/') ? attrValue : null
      } else if (attrName === 'secure') secure = true
      else if (attrName === 'httponly') httpOnly = true
      else if (attrName === 'max-age') {
        sawMaxAge = true
        if (!/^-?\d+$/.test(attrValue)) return { ok: false, code: JAR_CODES.BAD_VALUE }
        const seconds = Number(attrValue)
        if (!Number.isSafeInteger(seconds)) return { ok: false, code: JAR_CODES.BAD_VALUE }
        if (seconds <= 0) maxAgeNonPositive = true
        else {
          const candidateMs = now + seconds * 1000
          if (!Number.isSafeInteger(candidateMs) || candidateMs > MAX_DATE_MS) return { ok: false, code: JAR_CODES.BAD_VALUE }
          expiresAt = candidateMs
        }
      } else if (attrName === 'expires') {
        sawExpires = true
        const parsed = Date.parse(attrValue)
        if (!Number.isFinite(parsed)) continue
        if (!Number.isSafeInteger(parsed) || parsed > MAX_DATE_MS) return { ok: false, code: JAR_CODES.BAD_VALUE }
        if (!sawMaxAge) expiresAt = parsed
      }
    }
    const resolvedPath = path !== null ? path : defaultPathOf(sourcePath)
    const identity = { domain, path: resolvedPath, name }
    const expiredByExpires = !sawMaxAge && sawExpires && expiresAt !== null && expiresAt <= now
    if (maxAgeNonPositive || expiredByExpires) return { ok: true, removed: true, cookie: identity }
    return {
      ok: true,
      removed: false,
      cookie: {
        ...identity,
        hostOnly: explicitDomain === false,
        secure, httpOnly,
        expiresAt: expiresAt === null ? null : Math.floor(expiresAt),
        createdAt: now,
        __rawValue: value,
      },
    }
  }
}

export default CookieJar
