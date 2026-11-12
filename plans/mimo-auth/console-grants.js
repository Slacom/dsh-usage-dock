/**
 * console-grants.js — 正式 console 协议的**授权对象（grant）authority**（A1，纯内存）
 *
 * 目的：让 `secure-transport` 的“新用途”只能凭**本进程内部签发的不可伪造 grant** 发起请求，
 * 而不是凭一个 JSON 里的 URL 或字符串就放行。本文件**不发请求、不读 CookieJar、不序列化账号字段**。
 *
 * 关键不变式
 *  - grant 是 `Object.freeze(Object.create(null))` 的**空对象**（无自有属性、无 URL 字段）；
 *    全部信息存在模块私有 WeakMap 里 ⇒ `JSON.stringify` / `inspect` / 日志都拿不到任何内容。
 *  - `issue()` 不接受“调用者自造的来源”：除 `consoleContext`/`consoleBalance` 两个**硬编码** URL 外，
 *    其余用途必须带本 authority 当前有效的 `sourceBinding`（由 `markSource()` 产出），
 *    且 URL 必须等于该来源里的具体字段、或由该来源字段**确定性派生**。
 *  - `markSource()` 是 **Host 代码专用入口**（不挂在任何 route / 不下发到浏览器）：
 *    它只代表“这条 source 证据来自**已通过授权校验的 transport 响应**”，**不代表**认证真实性成立。
 *  - 目的域与用途强绑定：来源 kind 可信**不等于**可以把该 URL 发到该 URL 所在域；
 *    例如 `sso`/`authResult` 的 location 可能落在 account 域，但 `consolePlatformCallback`
 *    **只允许**精确 `platform.xiaomimimo.com/sts`，否则 issue 直接拒。
 *  - 有效期为 `min(owner.deadlineAt, grant.deadlineAt)`，**不自行延长**；`isLive(purpose)` 由外部按
 *    当前阶段判定（例如余额许可不能替代 display 阶段的 G3 授权）。
 */

export const CONSOLE_PURPOSES = Object.freeze({
  CONTEXT: 'consoleContext',
  QR_INIT: 'consoleQrInit',
  QR_IMAGE: 'consoleQrImage',
  AUTH_RESULT: 'consoleAuthResult',
  ACCOUNT_SSO: 'consoleAccountSso',
  PLATFORM_CALLBACK: 'consolePlatformCallback',
  BALANCE: 'consoleBalance'
})

export const CONSOLE_CODES = Object.freeze({
  URL_PURPOSE_MISMATCH: 'E_URL_PURPOSE_MISMATCH',
  TARGET_INVALID: 'E_MIMO_AUTH_TARGET_INVALID',
  EXPIRED: 'E_MIMO_AUTH_TARGET_EXPIRED'
})

const P = CONSOLE_PURPOSES
const C = CONSOLE_CODES
const KNOWN_PURPOSES = new Set(Object.values(P))

const ACCOUNT_HOST = 'account.xiaomi.com'
const PLATFORM_HOST = 'platform.xiaomimimo.com'
const PARENT_DOMAIN = 'xiaomi.com'
const MAX_URL_LEN = 2048
const MAX_HOST_LEN = 253

const CLASS_OF = Object.freeze({
  [P.CONTEXT]: 'none',
  [P.QR_INIT]: 'none',
  [P.QR_IMAGE]: 'none',
  [P.AUTH_RESULT]: 'none',
  [P.ACCOUNT_SSO]: 'account',
  [P.PLATFORM_CALLBACK]: 'platform',
  [P.BALANCE]: 'platform'
})

/** Cookie 策略：forbid = 必须无 Cookie；optional = 可有可无（首次换票）；required = 必须有 */
const COOKIE_POLICY = Object.freeze({
  [P.CONTEXT]: 'forbid',
  [P.QR_INIT]: 'forbid',
  [P.QR_IMAGE]: 'forbid',
  [P.AUTH_RESULT]: 'forbid',
  [P.ACCOUNT_SSO]: 'required',
  [P.PLATFORM_CALLBACK]: 'optional',
  [P.BALANCE]: 'required'
})

const SOURCE_KIND_OF = Object.freeze({
  [P.QR_INIT]: ['context'],
  [P.QR_IMAGE]: ['qrInit'],
  [P.AUTH_RESULT]: ['qrInit'],
  [P.ACCOUNT_SSO]: ['context'],
  [P.PLATFORM_CALLBACK]: ['sso', 'authResult']
})

/** 实际大小写的 Cookie 名白名单（不返回、不保存 value） */
const COOKIE_NAMES = Object.freeze({
  account: new Set(['passToken', 'userId', 'deviceId', 'cUserId']),
  platform: new Set(['api-platform_serviceToken', 'api-platform_slh', 'api-platform_ph', 'userId'])
})

function fail(code, why) {
  const err = new Error(code)
  err.code = code
  if (why) err.detail = why
  throw err
}

function validLabel(l) {
  if (typeof l !== 'string' || l.length < 1 || l.length > 63) return false
  if (!/^[a-z0-9-]+$/i.test(l)) return false
  if (l.startsWith('-') || l.endsWith('-')) return false
  if (l.toLowerCase().startsWith('xn--')) return false
  return true
}

function canonicalUrl(input) {
  if (typeof input !== 'string' || input.length === 0) fail(C.TARGET_INVALID, 'url-missing')
  if (input.length > MAX_URL_LEN) fail(C.TARGET_INVALID, 'url-too-long')
  let u
  try { u = new URL(input) } catch { fail(C.TARGET_INVALID, 'url-unparsable') }
  if (u.protocol !== 'https:') fail(C.TARGET_INVALID, 'url-not-https')
  if (u.port && u.port !== '443') fail(C.TARGET_INVALID, 'url-port')
  if (u.username || u.password) fail(C.TARGET_INVALID, 'url-userinfo')
  if (u.hash) fail(C.TARGET_INVALID, 'url-fragment')
  const host = u.hostname
  if (host.length > MAX_HOST_LEN) fail(C.TARGET_INVALID, 'host-too-long')
  if (host.endsWith('.')) fail(C.TARGET_INVALID, 'host-trailing-dot')
  if (host.startsWith('[')) fail(C.TARGET_INVALID, 'host-ipv6')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) fail(C.TARGET_INVALID, 'host-ipv4')
  const labels = host.split('.')
  if (labels.length < 2) fail(C.TARGET_INVALID, 'host-single-label')
  for (const l of labels) if (!validLabel(l)) fail(C.TARGET_INVALID, 'host-label')
  return u
}

function exactAccountHost(host) { return host === ACCOUNT_HOST }

/** lp 允许：精确 account 域，或 1–3 层严格合法子域（仍须以 .account.xiaomi.com 结尾） */
function accountOrSubdomain(host) {
  if (host === ACCOUNT_HOST) return true
  const suffix = '.' + ACCOUNT_HOST
  if (!host.endsWith(suffix)) return false
  const labels = host.slice(0, -suffix.length).split('.')
  if (labels.length < 1 || labels.length > 3) return false
  const all = labels.concat(ACCOUNT_HOST.split('.'))
  return all.every(validLabel) && (labels.join('.') + '.' + PARENT_DOMAIN) !== PARENT_DOMAIN
}

function one(params, name) {
  const all = params.getAll(name)
  if (all.length !== 1) fail(C.TARGET_INVALID, 'param-count:' + name)
  const v = all[0]
  if (typeof v !== 'string' || v === '') fail(C.TARGET_INVALID, 'param-empty:' + name)
  return v
}

/** Host-only 纯派生：**完整保留**已验证服务端 serviceLogin URL（仅标准 URL 规范化，不增删任何 query） */
export function deriveConsoleSsoUrl(serviceLoginUrl) {
  // 服务器签名参数（_json/_locale/_sign/callback/未知字段）必须逐字保留；
  // 缺省也不补，避免把 raw 3xx 交互改成强制 JSON 200。
  return canonicalUrl(serviceLoginUrl).toString()
}

/** Host-only 纯派生：QR init URL（按第三方已见参数：qs/_qrsize/_hasLogo/sid/_locale；不含 _dc，不含 serviceParam） */
export function deriveConsoleQrInitUrl(serviceLoginUrl) {
  const u = canonicalUrl(serviceLoginUrl)
  const sid = one(u.searchParams, 'sid')
  const callback = one(u.searchParams, 'callback')
  const qs = encodeURIComponent('?callback=' + encodeURIComponent(callback) +
    '&sid=' + sid + '&_group=DEFAULT&_json=true&_locale=zh_CN')
  const params = new URLSearchParams()
  params.set('qs', qs)
  params.set('callback', callback)   // 顶层 callback 是独立字段（不只是 qs 内嵌）
  params.set('_qrsize', '240')
  params.set('_hasLogo', 'false')
  params.set('sid', sid)
  params.set('_locale', 'zh_CN')
  return 'https://' + ACCOUNT_HOST + '/longPolling/loginUrl?' + params.toString()
}

const CONTEXT_URL = (() => {
  const u = new URL('https://' + PLATFORM_HOST + '/api/v1/genLoginUrl')
  u.searchParams.set('currentPath', '/console/plan-manage')
  return u.toString()
})()
const BALANCE_URL = 'https://' + PLATFORM_HOST + '/api/v1/balance'

function cookieHeaderOf(headers) {
  if (!headers || typeof headers !== 'object') return undefined
  let found
  let count = 0
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'cookie') { count += 1; if (found === undefined) found = headers[k] }
  }
  if (count > 1) fail(C.TARGET_INVALID, 'cookie-header-duplicate-key')
  return found
}

function checkCookieValue(v) {
  // RFC 6265 quoted form is syntactically allowed, but a credential must still
  // have nonempty cookie-octet content. Validate content without changing wire v.
  const content = v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(content)) fail(C.TARGET_INVALID, 'cookie-value')
}

function validateCookieHeader(purpose, headers) {
  const policy = COOKIE_POLICY[purpose]
  const header = cookieHeaderOf(headers)
  if (header === undefined) {
    if (policy === 'required') fail(C.TARGET_INVALID, 'cookie-required')
    return true
  }
  if (policy === 'forbid') fail(C.TARGET_INVALID, 'cookie-forbidden')
  if (typeof header !== 'string') fail(C.TARGET_INVALID, 'cookie-not-string')
  const cls = CLASS_OF[purpose]
  const allowed = COOKIE_NAMES[cls]
  if (!allowed) fail(C.TARGET_INVALID, 'cookie-class')
  const seen = new Set()
  for (const part of header.split(';')) {
    const raw = part.trim()
    if (raw === '') continue
    const eq = raw.indexOf('=')
    if (eq <= 0) fail(C.TARGET_INVALID, 'cookie-malformed')
    const name = raw.slice(0, eq).trim()
    const value = raw.slice(eq + 1).trim()
    if (!allowed.has(name)) fail(C.TARGET_INVALID, 'cookie-name-not-allowed')
    if (seen.has(name)) fail(C.TARGET_INVALID, 'cookie-duplicate')
    seen.add(name)
    checkCookieValue(value)
  }
  if (seen.size === 0) fail(C.TARGET_INVALID, 'cookie-empty')
  return true
}

/**
 * @param {object} opts
 * @param {() => number} [opts.now]
 * @param {object} opts.owner
 * @param {string} opts.bootEpoch
 * @param {number} opts.generation
 * @param {number} opts.deadlineAt
 * @param {(purpose?: string) => boolean} opts.isLive
 */
export function createConsoleGrantAuthority(opts) {
  const { owner, bootEpoch, generation, deadlineAt, isLive } = opts || {}
  const now = typeof opts?.now === 'function' ? opts.now : Date.now

  if (!owner || typeof owner !== 'object') throw new TypeError('console-grants: owner required')
  if (typeof bootEpoch !== 'string' || bootEpoch === '') throw new TypeError('console-grants: bootEpoch required')
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError('console-grants: generation must be positive integer')
  if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) throw new TypeError('console-grants: deadlineAt required')
  if (typeof isLive !== 'function') throw new TypeError('console-grants: isLive required')

  let grants = new WeakMap()
  let sources = new WeakMap()
  let epoch = 0
  let closed = false

  const liveOf = (purpose) => {
    try { return isLive(purpose) === true } catch { return false }
  }
  function assertOpen(phase) {
    if (closed) fail(C.EXPIRED, 'authority-closed')
    if (!(now() < deadlineAt)) fail(C.EXPIRED, 'owner-expired')
    if (!liveOf(phase)) fail(C.TARGET_INVALID, 'not-live')
  }

  function markSource(kind, responseId, fields) {
    assertOpen(undefined)
    if (typeof kind !== 'string' || typeof responseId !== 'string' || responseId === '') {
      fail(C.TARGET_INVALID, 'source-arg')
    }
    if (!fields || typeof fields !== 'object') fail(C.TARGET_INVALID, 'source-fields')
    let record
    if (kind === 'context') {
      const loc = canonicalUrl(fields.location)
      if (loc.hostname !== ACCOUNT_HOST || loc.pathname !== '/pass/serviceLogin') {
        fail(C.TARGET_INVALID, 'source-context-location')
      }
      const sid = one(loc.searchParams, 'sid')
      if (sid !== 'api-platform') fail(C.TARGET_INVALID, 'source-context-sid')
      const callback = one(loc.searchParams, 'callback')
      const cb = canonicalUrl(callback)
      if (cb.hostname !== PLATFORM_HOST || cb.pathname !== '/sts') {
        fail(C.TARGET_INVALID, 'source-context-callback')
      }
      // 保留完整的 genLogin serviceLogin URL（含服务器签名/dummy 参数），派生时不重建
      record = { kind, responseId, serviceLoginUrl: loc.toString() }
    } else if (kind === 'qrInit') {
      const qr = canonicalUrl(fields.qr)
      const lp = canonicalUrl(fields.lp)
      if (!(exactAccountHost(qr.hostname) || qr.hostname === PLATFORM_HOST)) fail(C.TARGET_INVALID, 'source-qr-host')
      if (!accountOrSubdomain(lp.hostname)) fail(C.TARGET_INVALID, 'source-lp-host')
      record = { kind, responseId, qr: qr.toString(), lp: lp.toString() }
    } else if (kind === 'authResult' || kind === 'sso') {
      const loc = canonicalUrl(fields.location)
      const okAccount = accountOrSubdomain(loc.hostname)
      const okPlatform = loc.hostname === PLATFORM_HOST
      if (!okAccount && !okPlatform) fail(C.TARGET_INVALID, 'source-location-host')
      record = { kind, responseId, location: loc.toString() }
    } else {
      fail(C.TARGET_INVALID, 'source-kind')
    }
    const binding = Object.freeze(Object.create(null))
    sources.set(binding, Object.freeze({ ...record, epoch, bootEpoch, generation }))
    return binding
  }

  function sourceOf(binding) {
    const rec = sources.get(binding)
    if (!rec || rec.epoch !== epoch || rec.bootEpoch !== bootEpoch || rec.generation !== generation) {
      fail(C.TARGET_INVALID, 'source-unknown')
    }
    return rec
  }

  function expectedUrl(purpose, rec) {
    if (purpose === P.CONTEXT) return CONTEXT_URL
    if (purpose === P.BALANCE) return BALANCE_URL
    if (purpose === P.QR_INIT) return deriveConsoleQrInitUrl(rec.serviceLoginUrl)
    if (purpose === P.ACCOUNT_SSO) return deriveConsoleSsoUrl(rec.serviceLoginUrl)
    if (purpose === P.QR_IMAGE) return rec.qr
    if (purpose === P.AUTH_RESULT) return rec.lp
    if (purpose === P.PLATFORM_CALLBACK) return rec.location
    return null
  }

  /** 目的域强约束：这些用途只能在指定域/路径上，来源 kind 可信不能越权 */
  function assertPurposeTarget(purpose, got) {
    const u = canonicalUrl(got)
    if (purpose === P.PLATFORM_CALLBACK) {
      if (u.hostname !== PLATFORM_HOST || u.pathname !== '/sts') {
        fail(C.URL_PURPOSE_MISMATCH, 'callback-not-platform-sts')
      }
    }
    if (purpose === P.BALANCE) {
      if (u.hostname !== PLATFORM_HOST || u.pathname !== '/api/v1/balance' || u.search !== '') {
        fail(C.URL_PURPOSE_MISMATCH, 'balance-target')
      }
    }
    if (purpose === P.CONTEXT) {
      if (u.hostname !== PLATFORM_HOST || u.pathname !== '/api/v1/genLoginUrl') {
        fail(C.URL_PURPOSE_MISMATCH, 'context-target')
      }
      const cp = u.searchParams.getAll('currentPath')
      if (cp.length !== 1 || cp[0] !== '/console/plan-manage') fail(C.URL_PURPOSE_MISMATCH, 'context-query')
      if (u.searchParams.get('_json') !== null || u.searchParams.get('_locale') !== null) {
        fail(C.URL_PURPOSE_MISMATCH, 'context-query-extra')
      }
    }
    if (purpose === P.QR_IMAGE) {
      if (!(u.hostname === ACCOUNT_HOST || u.hostname === PLATFORM_HOST)) fail(C.URL_PURPOSE_MISMATCH, 'qrimage-host')
    }
    if (purpose === P.AUTH_RESULT) {
      if (!accountOrSubdomain(u.hostname)) fail(C.URL_PURPOSE_MISMATCH, 'authresult-host')
    }
  }

  function issue(args) {
    const { url, method = 'GET', purpose, credentialClass, sourceBinding } = args || {}
    if (!KNOWN_PURPOSES.has(purpose)) fail(C.TARGET_INVALID, 'purpose-unknown')
    assertOpen(purpose)
    if (method !== 'GET') fail(C.TARGET_INVALID, 'method')
    if (credentialClass !== CLASS_OF[purpose]) fail(C.URL_PURPOSE_MISMATCH, 'class-not-allowed')

    let rec = null
    const kinds = SOURCE_KIND_OF[purpose]
    if (kinds) {
      if (!sourceBinding) fail(C.TARGET_INVALID, 'source-required')
      rec = sourceOf(sourceBinding)
      if (!kinds.includes(rec.kind)) fail(C.TARGET_INVALID, 'source-kind-chain')
    }

    const want = expectedUrl(purpose, rec)
    if (want === null) fail(C.TARGET_INVALID, 'purpose-url-undefined')
    const got = canonicalUrl(url).toString()
    if (got !== want) fail(C.URL_PURPOSE_MISMATCH, 'url')
    assertPurposeTarget(purpose, got)

    const grant = Object.freeze(Object.create(null))
    grants.set(grant, Object.freeze({
      url: got, method: 'GET', purpose, credentialClass,
      deadlineAt, epoch, bootEpoch, generation, sourceId: rec ? rec.responseId : null
    }))
    return grant
  }

  function validate(grant, req) {
    assertOpen(undefined)
    if (!grant || typeof grant !== 'object' || Object.keys(grant).length !== 0) {
      fail(C.TARGET_INVALID, 'grant-shape')
    }
    const rec = grants.get(grant)
    if (!rec) fail(C.TARGET_INVALID, 'grant-unknown')
    if (rec.epoch !== epoch || rec.bootEpoch !== bootEpoch || rec.generation !== generation) {
      fail(C.TARGET_INVALID, 'grant-stale')
    }
    if (!req || typeof req !== 'object') fail(C.TARGET_INVALID, 'req-missing')
    const purpose = req.purpose
    if (!KNOWN_PURPOSES.has(purpose)) fail(C.TARGET_INVALID, 'req-purpose')
    if (purpose !== rec.purpose) fail(C.URL_PURPOSE_MISMATCH, 'purpose')
    if (req.method !== 'GET' || req.method !== rec.method) fail(C.URL_PURPOSE_MISMATCH, 'method')
    if (req.credentialClass !== rec.credentialClass) fail(C.URL_PURPOSE_MISMATCH, 'class')
    if (!liveOf(purpose)) fail(C.TARGET_INVALID, 'not-live')

    const t = now()
    if (!(t < rec.deadlineAt) || !(t < deadlineAt)) fail(C.EXPIRED, 'expired')
    if (req.deadlineAt !== undefined) {
      const d = req.deadlineAt
      if (typeof d !== 'number' || !Number.isFinite(d)) fail(C.TARGET_INVALID, 'req-deadline')
      if (!(d > t)) fail(C.TARGET_INVALID, 'req-deadline-past')
      if (d > deadlineAt || d > rec.deadlineAt) fail(C.TARGET_INVALID, 'req-deadline-too-long')
    }
    if (canonicalUrl(req.url).toString() !== rec.url) fail(C.URL_PURPOSE_MISMATCH, 'url')
    assertPurposeTarget(purpose, rec.url)
    validateCookieHeader(purpose, req.headers)
    return true
  }

  function invalidate() {
    closed = true
    epoch += 1
    grants = new WeakMap()
    sources = new WeakMap()
    return true
  }

  return Object.freeze({ issue, validate, invalidate, markSource })
}
