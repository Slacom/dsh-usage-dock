/** Dynamic longPoll approval candidate policy. No network, no automatic host allowlist. */

export const ACCOUNT_HOST = 'account.xiaomi.com'
export const PLATFORM_HOST = 'platform.xiaomimimo.com'
export const MAX_EXTRA_LABELS = 3
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

function labelsOf(host) {
  return host.split('.')
}

function isAsciiLabel(label) {
  return LABEL_RE.test(label) && !label.startsWith('xn--')
}

export function normalizeCandidate(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    return { ok: false, reason: 'syntax' }
  }
  let parsed
  try { parsed = new URL(rawUrl) } catch { return { ok: false, reason: 'syntax' } }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (parsed.port !== '' && parsed.port !== '443') return { ok: false, reason: 'port' }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo' }
  if (parsed.hash !== '') return { ok: false, reason: 'fragment' }
  const host = parsed.hostname.toLowerCase()
  if (host !== parsed.hostname || host.length > 253 || host.endsWith('.')) return { ok: false, reason: 'host' }
  if (IPV4_RE.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'host' }
  }
  const suffix = `.${ACCOUNT_HOST}`
  if (!host.endsWith(suffix)) return { ok: false, reason: 'host' }
  const extra = host.slice(0, -suffix.length)
  if (extra.length === 0) return { ok: false, reason: 'host' }
  const labels = labelsOf(extra)
  if (labels.length < 1 || labels.length > MAX_EXTRA_LABELS || labels.some((label) => label.length === 0 || !isAsciiLabel(label))) {
    return { ok: false, reason: 'host' }
  }
  return { ok: true, canonical: parsed.toString(), originText: `https://${host}`, host }
}

export function normalizeSourceProof(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
  if (source.origin !== `https://${ACCOUNT_HOST}` || source.redirected !== false
    || source.initPath !== '/longPolling/loginUrl') return null
  if (source.sid !== 'api-platform' || typeof source.callback !== 'string') return null
  let callback
  try { callback = new URL(source.callback) } catch { return null }
  if (callback.protocol !== 'https:' || callback.hostname.toLowerCase() !== PLATFORM_HOST
    || (callback.port !== '' && callback.port !== '443') || callback.username || callback.password || callback.hash) return null
  return { origin: source.origin, sid: 'api-platform', callback: callback.toString(), redirected: false }
}
