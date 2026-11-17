/** Fixed, non-secret failure projection for the MiMo Host status DTO. */

export const FAILURE_CODES = Object.freeze([
  'E_MIMO_AUTH_FLOW',
  // Vendor FLOW_CODES that can describe a failed flow.
  'E_FLOW_ARGS_INVALID', 'E_RUN_ALREADY_ACTIVE', 'E_CALL_BUDGET', 'E_BUDGET_EXHAUSTED',
  'E_ABORTED', 'E_DISPLAY_CANCELLED', 'E_DISPLAY_ERROR', 'E_NETWORK', 'E_STATUS_UNEXPECTED',
  'E_DYNAMIC_URL_REJECTED', 'E_URL_PURPOSE_MISMATCH', 'E_URL_NOT_REGISTERED',
  'E_RESPONSE_NOT_JSON', 'E_RESPONSE_TOO_LARGE', 'E_NEEDS_HUMAN_VERIFICATION',
  'E_QR_IMAGE_INVALID', 'E_QR_IMAGE_TOO_LARGE', 'E_SID_MISMATCH',
  'E_CREDENTIAL_FIELD_INVALID', 'E_PASS_TOKEN_REJECTED', 'E_SSO_INCOMPLETE',
  'E_REDIRECT_LIMIT', 'E_QR_GATE_INCOMPLETE', 'E_SET_COOKIE_REJECTED',
  'E_COOKIE_HEADER_INCOMPLETE', 'E_BALANCE_HTTP', 'E_BALANCE_CODE', 'E_BALANCE_PARSE',
  'E_BALANCE_INPUT_INVALID', 'E_STAGE_INCOMPLETE', 'E_TARGET_NOT_APPROVED',
  'E_REQUEST_TIMEOUT', 'E_MIMO_AUTH_POSTQR_DISABLED', 'E_MIMO_AUTH_IDENTITY_MISMATCH',
])

export const FAILURE_STAGES = Object.freeze(['flow', 'qr', 'balance', 'unknown'])
export const DIAGNOSTIC_PURPOSES = Object.freeze(['serviceLogin', 'callback', 'qrImage', 'longPoll', 'scanReceipt', 'ssoLocation'])
export const DIAGNOSTIC_REASONS = Object.freeze(['host', 'purpose'])
export const DIAGNOSTIC_HOST_CLASSES = Object.freeze(['account-exact', 'platform-exact', 'account-subdomain', 'other'])

function diagnosticEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unknown'
}

const DIAGNOSTIC_COOKIE_CODES = Object.freeze([
  'E_COOKIE_EMPTY', 'E_COOKIE_CRLF', 'E_COOKIE_TOO_LARGE', 'E_COOKIE_BAD_NAME',
  'E_COOKIE_BAD_VALUE', 'E_COOKIE_BAD_DOMAIN', 'E_COOKIE_FOREIGN_DOMAIN',
  'E_COOKIE_STORE_FULL', 'E_COOKIE_BAD_SOURCE',
])

const DIAGNOSTIC_CREDENTIAL_FIELDS = Object.freeze(['passToken', 'userId', 'cUserId', 'deviceId'])
const DIAGNOSTIC_CREDENTIAL_REASONS = Object.freeze(['not-string', 'empty', 'too-long', 'value-format'])

const DIAGNOSTIC_NETWORK_STEPS = Object.freeze(['genLogin', 'longPoll', 'qrImage', 'redirect', 'sso', 'balance', 'unknown'])
const DIAGNOSTIC_NETWORK_CODES = Object.freeze([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ABORT_ERR', 'other',
])

function normalizeDiagnostic(value, code) {
  if (code === 'E_NETWORK') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const step = typeof value.step === 'string' && DIAGNOSTIC_NETWORK_STEPS.includes(value.step) ? value.step : 'unknown'
    const networkCode = typeof value.networkCode === 'string' && DIAGNOSTIC_NETWORK_CODES.includes(value.networkCode)
      ? value.networkCode : 'other'
    return { step, networkCode }
  }
  if (code === 'E_CREDENTIAL_FIELD_INVALID') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const field = typeof value.field === 'string' && DIAGNOSTIC_CREDENTIAL_FIELDS.includes(value.field) ? value.field : 'unknown'
    const reason = typeof value.reason === 'string' && DIAGNOSTIC_CREDENTIAL_REASONS.includes(value.reason) ? value.reason : 'unknown'
    return { field, reason }
  }
  if (code === 'E_SET_COOKIE_REJECTED') {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.cookieCodes)) return null
    const cookieCodes = value.cookieCodes
      .filter((item) => typeof item === 'string' && DIAGNOSTIC_COOKIE_CODES.includes(item))
      .slice(0, 6)
    return cookieCodes.length > 0 ? { cookieCodes } : null
  }
  if (code !== 'E_URL_PURPOSE_MISMATCH' || value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    rejectedPurpose: diagnosticEnum(value.rejectedPurpose, DIAGNOSTIC_PURPOSES),
    rejectedReason: diagnosticEnum(value.rejectedReason, DIAGNOSTIC_REASONS),
    hostClass: diagnosticEnum(value.hostClass, DIAGNOSTIC_HOST_CLASSES),
  }
}

export function normalizeFailure(value) {
  const source = value !== null && typeof value === 'object' ? value : null
  const code = source !== null && typeof source.code === 'string'
    && source.code !== 'E_NONE' && FAILURE_CODES.includes(source.code)
    ? source.code
    : 'E_MIMO_AUTH_FLOW'
  const stage = source !== null && typeof source.stage === 'string' && FAILURE_STAGES.includes(source.stage)
    ? source.stage
    : 'unknown'
  return { code, stage, diagnostic: normalizeDiagnostic(source?.diagnostic, code) }
}

export function failureFromReport(report) {
  if (report === null || typeof report !== 'object' || report.ok === true) return null
  const reportStage = typeof report.stage === 'string' ? report.stage : ''
  const stage = reportStage === 'qr' ? 'qr' : reportStage === 'balance' ? 'balance' : reportStage === 'init' ? 'flow' : 'unknown'
  return normalizeFailure({ code: report.code, stage, diagnostic: report.diagnostic })
}
