/**
 * [MiMo legacy 登录持久化] 把「扫码登录拿到的平台 cookie」加密交给 DSH 凭据记录保管，
 * 重启引擎后重放余额接口，免去重新扫码。
 *
 * 边界：
 *   - 只保存平台侧 cookie（实测余额接口只需要 api-platform_serviceToken 等 4 个）；
 *   - 不保存账号密码、不保存账号 cookie、不保存原始响应；
 *   - 任何日志/错误消息都不包含 cookie 值；
 *   - 重放失败（401/403/结构异常）由调用方删除记录，回落到「需要重新扫码」。
 *
 * 本模块是纯逻辑 + 可注入 fetch，便于离线单测。
 */

/** DSH 凭据记录 key：`<owner>/<id>`。 */
export const MIMO_LEGACY_RECORD_KEY = 'dsh-usage-dock/mimo-legacy'

/** 余额接口（与 legacy 流程 gateBalance 同一个端点）。 */
export const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance'

/** 只允许平台侧必需 cookie 名（避免误存账号 cookie / 无关追踪 cookie）。 */
const ALLOWED_COOKIE_NAMES = Object.freeze([
  'api-platform_serviceToken',
  'userId',
  'api-platform_slh',
  'api-platform_ph',
])

// 值允许引号（CookieJar 的 allowQuotedValues 会原样保留 "..."），但不能含空白/控制字符。
const COOKIE_PAIR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21\x22\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_COOKIE_CHARS = 2048
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 从 CookieJar 的 header 字符串里挑出允许的名字并重建（保序、去重）。
 * 非法/超长/含控制字符时返回 null。
 */
export function pickPlatformCookie(header) {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_COOKIE_CHARS) return null
  if (header.includes('\r') || header.includes('\n') || header.includes('\u0000')) return null
  const out = []
  const seen = new Set()
  for (const part of header.split(';')) {
    const pair = part.trim()
    if (pair.length === 0) continue
    const at = pair.indexOf('=')
    if (at <= 0) return null
    const name = pair.slice(0, at)
    if (!COOKIE_NAME_RE.test(name)) return null
    // 非白名单 cookie（含带空格/引号的无关 cookie）直接跳过，不参与合法性判定。
    if (!ALLOWED_COOKIE_NAMES.includes(name)) continue
    if (!COOKIE_PAIR_RE.test(pair)) return null
    if (seen.has(name)) continue
    seen.add(name)
    out.push(pair)
  }
  if (!out.some((pair) => pair.startsWith('api-platform_serviceToken='))) return null
  return out.join('; ')
}

/** 构造凭据记录（kind: 'grant'）。 */
export function buildLegacyRecord(input) {
  const src = input !== null && input !== undefined && typeof input === 'object' ? input : {}
  const cookie = pickPlatformCookie(src.platformCookie)
  if (cookie === null) return null
  const balance = typeof src.balance === 'number' && Number.isFinite(src.balance) && src.balance >= 0 ? src.balance : null
  if (balance === null) return null
  const currency = typeof src.currency === 'string' && /^[A-Z]{3}$/.test(src.currency) ? src.currency : 'CNY'
  const fetchedAt = typeof src.fetchedAt === 'number' && Number.isFinite(src.fetchedAt) && src.fetchedAt > 0 ? Math.floor(src.fetchedAt) : Date.now()
  return {
    v: 1,
    cookie,
    balance,
    currency,
    fetchedAt,
  }
}

/**
 * 读取凭据记录 → 可重放的数据；形状不对/太旧返回 null。
 * @param {object|undefined} record DSH credentials 的 record（`{kind, payload}`）
 */
export function parseLegacyRecord(record, options) {
  const opts = options !== null && options !== undefined ? options : {}
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const raw = record !== null && record !== undefined && typeof record === 'object' ? record : null
  if (raw === null) return null
  if (typeof raw.kind === 'string' && raw.kind !== 'grant') return null
  const payload = raw.payload !== null && typeof raw.payload === 'object' ? raw.payload : null
  if (payload === null || payload.v !== 1) return null
  const cookie = pickPlatformCookie(payload.cookie)
  if (cookie === null) return null
  const balance = typeof payload.balance === 'number' && Number.isFinite(payload.balance) && payload.balance >= 0 ? payload.balance : null
  if (balance === null) return null
  const currency = typeof payload.currency === 'string' && /^[A-Z]{3}$/.test(payload.currency) ? payload.currency : 'CNY'
  const fetchedAt = typeof payload.fetchedAt === 'number' && Number.isFinite(payload.fetchedAt) ? Math.floor(payload.fetchedAt) : null
  if (fetchedAt === null || now - fetchedAt > MAX_RECORD_AGE_MS) return null
  return { cookie, balance, currency, fetchedAt }
}

/**
 * 用保存的 cookie 重放余额接口。
 *
 * @param {string} cookie 已通过 pickPlatformCookie 校验的 header
 * @param {{ fetchImpl?: Function, timeoutMs?: number, parseBalance?: Function }} [options]
 * @returns {Promise<{ok: true, balance: number, currency: string, fetchedAt: number}
 *   | {ok: false, reason: 'unauthorized'|'http'|'parse'|'network'}>}
 *   每次返回都带**固定枚举原因**，不含上游原文。
 */
export async function replayLegacyBalance(cookie, options) {
  const opts = options !== null && options !== undefined ? options : {}
  const picked = pickPlatformCookie(cookie)
  if (picked === null) return { ok: false, reason: 'parse' }
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (fetchImpl === null) return { ok: false, reason: 'network' }
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 10_000
  const parseBalance = typeof opts.parseBalance === 'function' ? opts.parseBalance : null
  let response
  try {
    response = await fetchImpl(MIMO_BALANCE_URL, {
      method: 'GET',
      headers: { accept: 'application/json', cookie: picked },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, reason: 'network' }
  }
  try {
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' }
    if (response.status !== 200) return { ok: false, reason: 'http' }
    let payload
    try { payload = await response.json() } catch (err) { return { ok: false, reason: 'parse' } }
    if (payload === null || typeof payload !== 'object' || payload.code !== 0) {
      return { ok: false, reason: response.status === 200 && payload !== null && (payload.code === 401 || payload.code === 403) ? 'unauthorized' : 'parse' }
    }
    const parsed = parseBalance !== null ? parseBalance(payload) : null
    if (parsed === null || parsed === undefined || typeof parsed.balance !== 'number' || !Number.isFinite(parsed.balance)) {
      return { ok: false, reason: 'parse' }
    }
    const currency = typeof parsed.currency === 'string' && /^[A-Z]{3}$/.test(parsed.currency) ? parsed.currency : 'CNY'
    return { ok: true, balance: parsed.balance, currency, fetchedAt: Date.now() }
  } catch (err) {
    return { ok: false, reason: 'network' }
  }
}
