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

function normalizeDiagnostic(value, code) {
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
