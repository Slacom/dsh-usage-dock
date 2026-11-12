/**
 * MiMo P1 · 隔离内存扫码 → 真实余额（协议控制器，**全部依赖显式注入**）
 *
 * 本文件只做流程编排：不 import 生产模块、不碰磁盘/records/profile/配置。
 * fetch / CookieJar / 显示 UI / parseBalance 全部由调用方注入，便于完全离线测试。
 *
 * 授权边界（用户 2026-10-25 21:33）：本机 Windows 临时窗口显示**官方二维码**、本人扫码；
 * 无 HTTP 网页服务器、无浏览器/CDP、**不存票**、不改旧 Cookie/插件/配置。
 * 本阶段只覆盖两关：**扫码** 与 **真实余额**；跨重启恢复与续期**未测**。
 *
 * v2（父审后重写）要点：
 *   - **单一会话根 signal + 入口绝对 deadline**；fetch、每跳、drain、body 读取、sleep、显示层调用
 *     **全部**与预算硬 race；取消/过期后**迟到结果不得**吸 Cookie、发下一请求或更新状态；
 *   - 清理只"发起"不 await（不阻断队列）；
 *   - 错误码收敛为 **FLOW_CODES 白名单**，未知一律静态 `E_NETWORK`（绝不透传上游 code/message）；
 *   - 动态 URL 按**用途**绑定域：serviceLogin/longPoll 必须 account、callback 必须 platform、
 *     扫码回执/SSO 跳转允许官方两域；URL 长度有界、sid/callback 单值；
 *   - 扫码回执先**按官方给的 location 走跳转链**（有界、逐跳校验/登记）；已有平台票则直接余额，
 *     **仅当确实缺票**才做**一次** SSO JSON 兜底；跳转次数耗尽 = 固定失败，不判成功；
 *   - 二维码 gate 必须真的确认"账号最小字段 + 平台票"，无票不算成功；
 *   - 账号 JSON 字段**不篡改**：类型 / cookie-octet 校验失败即停，不删字符；
 *   - `askBalanceMatch` 只接收**严格白名单**的数值/币种，报告里只有一致性枚举；
 *   - `destroy()` 清 Jar / policy / 图像与票据引用；`run()` 单活（并发第二次直接拒绝），
 *     每次独立 report 与代次，旧 run 不能改新 run 的状态。
 */

export const FLOW_CODES = Object.freeze({
  OK: 'E_NONE',
  ARGS_INVALID: 'E_FLOW_ARGS_INVALID',
  RUN_ALREADY_ACTIVE: 'E_RUN_ALREADY_ACTIVE',
  CALL_BUDGET: 'E_CALL_BUDGET',
  BUDGET_EXHAUSTED: 'E_BUDGET_EXHAUSTED',
  ABORTED: 'E_ABORTED',
  CANCELLED: 'E_DISPLAY_CANCELLED',
  DISPLAY_ERROR: 'E_DISPLAY_ERROR',
  NETWORK: 'E_NETWORK',
  STATUS_UNEXPECTED: 'E_STATUS_UNEXPECTED',
  DYNAMIC_URL_REJECTED: 'E_DYNAMIC_URL_REJECTED',
  URL_PURPOSE_MISMATCH: 'E_URL_PURPOSE_MISMATCH',
  NOT_REGISTERED: 'E_URL_NOT_REGISTERED',
  RESPONSE_NOT_JSON: 'E_RESPONSE_NOT_JSON',
  RESPONSE_TOO_LARGE: 'E_RESPONSE_TOO_LARGE',
  NEEDS_HUMAN_VERIFICATION: 'E_NEEDS_HUMAN_VERIFICATION',
  QR_IMAGE_INVALID: 'E_QR_IMAGE_INVALID',
  QR_IMAGE_TOO_LARGE: 'E_QR_IMAGE_TOO_LARGE',
  SID_MISMATCH: 'E_SID_MISMATCH',
  CREDENTIAL_FIELD_INVALID: 'E_CREDENTIAL_FIELD_INVALID',
  PASS_TOKEN_REJECTED: 'E_PASS_TOKEN_REJECTED',
  SSO_INCOMPLETE: 'E_SSO_INCOMPLETE',
  REDIRECT_LIMIT: 'E_REDIRECT_LIMIT',
  QR_GATE_INCOMPLETE: 'E_QR_GATE_INCOMPLETE',
  SET_COOKIE_REJECTED: 'E_SET_COOKIE_REJECTED',
  COOKIE_HEADER_INCOMPLETE: 'E_COOKIE_HEADER_INCOMPLETE',
  BALANCE_HTTP: 'E_BALANCE_HTTP',
  BALANCE_CODE: 'E_BALANCE_CODE',
  BALANCE_PARSE: 'E_BALANCE_PARSE',
  BALANCE_INPUT_INVALID: 'E_BALANCE_INPUT_INVALID',
  STAGE_INCOMPLETE: 'E_STAGE_INCOMPLETE',
  TARGET_NOT_APPROVED: 'E_TARGET_NOT_APPROVED',
  REQUEST_TIMEOUT: 'E_REQUEST_TIMEOUT',
})

/** 预置固定入口（唯一硬编码的官方地址）。 */
export const FIXED_ENTRY = Object.freeze({
  GEN_LOGIN: 'https://platform.xiaomimimo.com/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage',
  LONG_POLL_BASE: 'https://account.xiaomi.com/longPolling/loginUrl',
  BALANCE: 'https://platform.xiaomimimo.com/api/v1/balance',
})

export const KNOWN_ANTI_XSSI_PREFIXES = Object.freeze(['&&&START&&&'])

const ACCOUNT_HOST = 'account.xiaomi.com'
const PLATFORM_HOST = 'platform.xiaomimimo.com'
/** 用途 → 允许的 exact host 集合。 */
const PURPOSE_HOSTS = Object.freeze({
  serviceLogin: [ACCOUNT_HOST],
  longPoll: [ACCOUNT_HOST],
  qrImage: [ACCOUNT_HOST, PLATFORM_HOST],
  callback: [PLATFORM_HOST],
  scanReceipt: [ACCOUNT_HOST, PLATFORM_HOST],
  ssoLocation: [ACCOUNT_HOST, PLATFORM_HOST],
})
const QR_MAGIC_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const QR_MAGIC_JPEG = [0xff, 0xd8, 0xff]
const COOKIE_OCTET_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/
/** 动态 URL 诊断的固定枚举（报告只允许这些值）。 */
const DYNAMIC_PURPOSES = Object.freeze(['serviceLogin', 'callback', 'qrImage', 'longPoll', 'scanReceipt', 'ssoLocation'])
const DYNAMIC_REASONS = Object.freeze(['syntax', 'scheme', 'port', 'userinfo', 'fragment', 'host', 'purpose'])
const MAX_DYNAMIC_URL = 2048
const ALLOWED_CODES = new Set(Object.values(FLOW_CODES))
const HUMAN_KEYS = Object.freeze(['captcha', 'captchaUrl', 'mfa', 'twoFactor', 'needVerify', 'verifyCode'])
/** 账号票候选字段（只映射这些；值必须通过类型 + cookie-octet 校验）。 */
const ACCOUNT_FIELDS = Object.freeze(['passToken', 'userId', 'cUserId', 'deviceId'])

const DEFAULT_LIMITS = Object.freeze({
  hardMs: 5 * 60 * 1000,
  pollPerCallMs: 35 * 1000,
  maxCalls: 20,
  maxRedirects: 3,
  maxQrBytes: 256 * 1024,
  maxJsonBytes: 256 * 1024,
  backoffMs: 400,
  displayMs: 120 * 1000,
})

const INTERNAL_FAILURE = Symbol('flowFailure')
const fail = (code) => Object.assign(new Error(code), { code, [INTERNAL_FAILURE]: true })

function staticCode(error) {
  const code = error !== null && typeof error === 'object' ? error.code : null
  return error?.[INTERNAL_FAILURE] === true && typeof code === 'string' && ALLOWED_CODES.has(code) ? code : FLOW_CODES.NETWORK
}

export function detectImageMagic(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 3) return null
  if (QR_MAGIC_PNG.every((byte, index) => bytes[index] === byte)) return 'png'
  if (QR_MAGIC_JPEG.every((byte, index) => bytes[index] === byte)) return 'jpeg'
  return null
}

export function createMemoryFlow(deps) {
  const {
    fetchImpl, jar, display, parseBalance,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    approval = null,
    allowDynamicLongPoll = false,
    limits: limitOverrides = {},
  } = deps ?? {}

  const valid = typeof fetchImpl === 'function'
    && jar !== null && typeof jar === 'object'
    && typeof jar.absorb === 'function' && typeof jar.cookieHeaderFor === 'function'
    && typeof jar.clear === 'function'
    && display !== null && typeof display === 'object'
    && typeof display.showQr === 'function' && typeof display.close === 'function'
    && typeof parseBalance === 'function'
  if (!valid) {
    return {
      run: async () => ({ ok: false, code: FLOW_CODES.ARGS_INVALID }),
      cancel: () => {},
    }
  }

  const limits = { ...DEFAULT_LIMITS, ...limitOverrides }

  let active = false
  let generation = 0
  let runState = null // { gen, controller, deadline, report, policy, jar }

  function current(gen) {
    return runState !== null && runState.gen === gen ? runState : null
  }

  /** 会话预算：单根 signal + 入口绝对 deadline；所有可等待点都走这里。 */
  function createBudget(state) {
    const controller = state.controller
    const expired = () => now() >= state.deadline
    const aborted = () => controller.signal.aborted === true || (current(state.gen) === null)
    async function race(operation, capMs = Number.POSITIVE_INFINITY, onCap = () => {}) {
      if (aborted()) return { kind: 'aborted' }
      const left = Math.min(state.deadline - now(), capMs)
      if (left <= 0) return { kind: 'timeout' }
      let resolveAbort = () => {}
      const abortGuard = new Promise((resolve) => { resolveAbort = () => resolve({ kind: 'aborted' }) })
      const onAbort = () => resolveAbort()
      let timer = null
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => {
          // 只有**会话** deadline 到了才 abort 根；单次调用上限到点只算 capTimeout（可重试）。
          if (now() >= state.deadline) {
            resolve({ kind: 'timeout' })
            try { controller.abort() } catch { /* 已中止 */ }
          } else {
            onCap()
            resolve({ kind: 'capTimeout' })
          }
        }, left)
      })
      if (typeof controller.signal.addEventListener === 'function') controller.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await Promise.race([
          Promise.resolve().then(operation).then((value) => ({ kind: 'ok', value }), (error) => ({ kind: 'error', error })),
          guard,
          abortGuard,
        ])
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (typeof controller.signal.removeEventListener === 'function') controller.signal.removeEventListener('abort', onAbort)
      }
    }
    return { race, expired, aborted, controller }
  }

  function absorbOnce(state, lines, url) {
    if (lines === null) return
    const absorbed = jar.absorb(lines, url)
    if (Array.isArray(absorbed?.rejected) && absorbed.rejected.length > 0) throw fail(FLOW_CODES.SET_COOKIE_REJECTED)
    void state
  }

  function register(state, url, method = 'GET') {
    state.policy.set(`${method} ${String(url)}`, true)
  }

  function assertRegistered(state, url, method = 'GET') {
    if (state.policy.has(`${method} ${String(url)}`) !== true) throw fail(FLOW_CODES.NOT_REGISTERED)
  }

  /** 诊断用的固定枚举（只回枚举，绝不回 host/URL/path/query/票/原文）。 */
  function hostClassOf(hostname) {
    const host = String(hostname).toLowerCase()
    if (host === ACCOUNT_HOST) return 'account-exact'
    if (host === PLATFORM_HOST) return 'platform-exact'
    if (host.endsWith(`.${ACCOUNT_HOST}`)) return 'account-subdomain'
    return 'other'
  }

  function rejectDynamic(purpose, reason, hostname) {
    const safePurpose = DYNAMIC_PURPOSES.includes(purpose) ? purpose : 'serviceLogin'
    const safeReason = DYNAMIC_REASONS.includes(reason) ? reason : 'syntax'
    // 码保持原语义：语法/传输类 → DYNAMIC_URL_REJECTED；域/用途类 → URL_PURPOSE_MISMATCH。
    const code = (reason === 'host' || reason === 'purpose') ? FLOW_CODES.URL_PURPOSE_MISMATCH : FLOW_CODES.DYNAMIC_URL_REJECTED
    const error = fail(code)
    error.diagnostic = {
      rejectedPurpose: safePurpose,
      rejectedReason: safeReason,
      hostClass: typeof hostname === 'string' && hostname.length > 0 ? hostClassOf(hostname) : 'other',
    }
    return error
  }

  /** 动态 URL：长度有界 + 用途绑定域 + 无 userinfo/fragment + 443。行为不变，只补诊断枚举。 */
  function validateDynamic(raw, purpose) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DYNAMIC_URL) throw rejectDynamic(purpose, 'syntax', null)
    let parsed
    try { parsed = new URL(raw) } catch { throw rejectDynamic(purpose, 'syntax', null) }
    if (parsed.protocol !== 'https:') throw rejectDynamic(purpose, 'scheme', parsed.hostname)
    if (parsed.port !== '' && parsed.port !== '443') throw rejectDynamic(purpose, 'port', parsed.hostname)
    if (parsed.username !== '' || parsed.password !== '') throw rejectDynamic(purpose, 'userinfo', parsed.hostname)
    if (parsed.hash !== '') throw rejectDynamic(purpose, 'fragment', parsed.hostname)
    const host = parsed.hostname.toLowerCase()
    const allowed = PURPOSE_HOSTS[purpose]
    if (!Array.isArray(allowed)) throw rejectDynamic(purpose, 'purpose', host)
    // 先区分"根本不是官方域"（host）与"官方域但用途不对"（purpose）。
    const official = host === ACCOUNT_HOST || host === PLATFORM_HOST
    if (official !== true) throw rejectDynamic(purpose, 'host', host)
    if (!allowed.includes(host)) throw rejectDynamic(purpose, 'purpose', host)
    return parsed
  }

  /** Only the current initBody.lp can reach this resolver. No hook grants domain authority. */
  function dynamicCandidateHost(hostname) {
    const host = String(hostname).toLowerCase()
    const suffix = `.${ACCOUNT_HOST}`
    if (!host.endsWith(suffix) || host.endsWith('.') || host.length > 253) return false
    const extra = host.slice(0, -suffix.length)
    const labels = extra.split('.')
    if (labels.length < 1 || labels.length > 3) return false
    for (const label of labels) {
      if (label.length === 0 || label.length > 63 || label.startsWith('xn--')
        || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false
    }
    return true
  }

  async function resolveLongPollTarget(state, budget, raw, sourceContext) {
    let url
    try {
      url = validateDynamic(raw, 'longPoll')
    } catch (error) {
      // Dynamic candidates are disabled unless the owner explicitly opted in for this session.
      if (state.allowDynamicLongPoll !== true) throw error
      if (sourceContext === null || typeof sourceContext !== 'object'
        || sourceContext.origin !== `https://${ACCOUNT_HOST}` || sourceContext.redirected !== false
        || sourceContext.initPath !== '/longPolling/loginUrl'
        || sourceContext.sid !== 'api-platform' || typeof sourceContext.callback !== 'string') throw error
      // Recheck all transport constraints independently before consulting an untrusted hook.
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DYNAMIC_URL) throw error
      try { url = new URL(raw) } catch { throw error }
      if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.hash
        || !dynamicCandidateHost(url.hostname)) throw error
      if (typeof approval !== 'function') throw fail(FLOW_CODES.TARGET_NOT_APPROVED)
      const canonical = url.toString()
      const outcome = await budget.race(() => approval({
        purpose: 'longPoll', rawUrl: canonical, source: sourceContext,
        signal: state.controller.signal, deadline: state.deadline,
      }))
      if (budget.expired() || outcome.kind === 'timeout') throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted() || outcome.kind === 'aborted') throw fail(FLOW_CODES.ABORTED)
      if (outcome.kind !== 'ok' || outcome.value?.approved !== true || outcome.value?.url !== canonical) {
        throw fail(FLOW_CODES.TARGET_NOT_APPROVED)
      }
      state.approvedLongPoll = canonical
    }
    if (budget.expired()) throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
    if (budget.aborted()) throw fail(FLOW_CODES.ABORTED)
    register(state, url.toString(), 'GET')
    return url
  }

  // Read the complete response under ONE absolute request deadline. Never await cleanup.
  async function requestBytes(response, maxBytes, image, wait) {
    const reader = response?.body?.getReader?.()
    const chunks = []
    let total = 0
    try {
      if (reader) {
        for (;;) {
          const item = await wait(() => reader.read())
          if (item?.done === true) break
          if (!(item?.value instanceof Uint8Array)) throw fail(FLOW_CODES.NETWORK)
          total += item.value.byteLength
          if (total > maxBytes) throw fail(image ? FLOW_CODES.QR_IMAGE_TOO_LARGE : FLOW_CODES.RESPONSE_TOO_LARGE)
          chunks.push(item.value)
        }
      } else {
        const bytes = typeof response?.arrayBuffer === 'function'
          ? new Uint8Array(await wait(() => response.arrayBuffer()))
          : new TextEncoder().encode(await wait(() => response.text()))
        total = bytes.byteLength
        if (total > maxBytes) throw fail(image ? FLOW_CODES.QR_IMAGE_TOO_LARGE : FLOW_CODES.RESPONSE_TOO_LARGE)
        chunks.push(bytes)
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
      return merged
    } finally {
      if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}) } catch {} }
    }
  }

  /** Each request owns a linked controller through fetch AND bounded body completion. */
  async function callOnce(state, budget, url, { method = 'GET', step, perCallMs = limits.pollPerCallMs, accept = 'application/json' } = {}) {
    assertRegistered(state, url, method)
    if (budget.expired()) throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
    if (state.report.calls.total >= limits.maxCalls) throw fail(FLOW_CODES.CALL_BUDGET)
    state.report.calls.total += 1
    if (typeof state.report.calls[step] === 'number') state.report.calls[step] += 1

    const picked = jar.cookieHeaderFor(url)
    if (picked !== null && typeof picked === 'object' && picked.dropped > 0) throw fail(FLOW_CODES.COOKIE_HEADER_INCOMPLETE)
    const headers = { accept }
    if (typeof picked?.header === 'string' && picked.header.length > 0) headers.cookie = picked.header

    const child = new AbortController()
    const capDeadline = Math.min(state.deadline, now() + perCallMs)
    const abortChild = () => child.abort()
    budget.controller.signal.addEventListener('abort', abortChild, { once: true })
    async function wait(operation) {
      if (budget.expired()) throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted()) throw fail(FLOW_CODES.ABORTED)
      if (now() >= capDeadline) { child.abort(); throw fail(FLOW_CODES.REQUEST_TIMEOUT) }
      const outcome = await budget.race(operation, capDeadline - now(), abortChild)
      if (budget.expired() || outcome.kind === 'timeout') throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted() || outcome.kind === 'aborted') throw fail(FLOW_CODES.ABORTED)
      if (outcome.kind === 'capTimeout' || now() >= capDeadline) { child.abort(); throw fail(FLOW_CODES.REQUEST_TIMEOUT) }
      // Never trust an IO exception's .code.
      if (outcome.kind !== 'ok') throw fail(FLOW_CODES.NETWORK)
      return outcome.value
    }
    try {
      const response = await wait(() => {
        if (child.signal.aborted) throw fail(FLOW_CODES.ABORTED)
        return fetchImpl(url, { method, headers, redirect: 'manual', credentials: 'omit', signal: child.signal })
      })
      const image = accept.startsWith('image/')
      const bytes = await requestBytes(response, image ? limits.maxQrBytes : limits.maxJsonBytes, image, wait)
      if (budget.expired()) throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted()) throw fail(FLOW_CODES.ABORTED)
      const status = typeof response?.status === 'number' ? response.status : null
      const lines = typeof response?.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : null
      const location = typeof response?.headers?.get === 'function' ? response.headers.get('location') : null
      const requestUrl = String(url)
      const responseUrl = typeof response?.url === 'string' && response.url.length > 0 ? response.url : requestUrl
      const redirected = response?.redirected
      if (budget.expired()) throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted()) throw fail(FLOW_CODES.ABORTED)
      if (now() >= capDeadline) { child.abort(); throw fail(FLOW_CODES.REQUEST_TIMEOUT) }
      absorbOnce(state, Array.isArray(lines) ? lines : null, url)
      // Downstream parsers consume only bounded in-memory bytes, never live IO.
      const buffered = { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer }
      return { response: buffered, status, lines: Array.isArray(lines) ? lines : null, location, requestUrl, url: responseUrl, redirected }
    } catch (error) {
      child.abort()
      if (error?.[INTERNAL_FAILURE] === true && error.code === FLOW_CODES.REQUEST_TIMEOUT && step === 'longPoll') return { timedOut: true }
      throw error
    } finally {
      budget.controller.signal.removeEventListener('abort', abortChild)
    }
  }

  async function readTextBudget(state, budget, response, maxBytes) {
    const body = response?.body
    if (body !== null && typeof body?.getReader === 'function') {
      const reader = body.getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const outcome = await budget.race(() => reader.read(), limits.pollPerCallMs)
        if (outcome.kind !== 'ok') {
          try { Promise.resolve().then(() => reader.cancel()).catch(() => {}) } catch { /* 忽略 */ }
          throw fail(outcome.kind === 'aborted' ? FLOW_CODES.ABORTED : (outcome.kind === 'error' ? FLOW_CODES.NETWORK : FLOW_CODES.BUDGET_EXHAUSTED))
        }
        const step = outcome.value
        if (step?.done === true) break
        const chunk = step?.value
        if (!(chunk instanceof Uint8Array)) throw fail(FLOW_CODES.NETWORK)
        total += chunk.byteLength
        if (total > maxBytes) {
          try { Promise.resolve().then(() => reader.cancel()).catch(() => {}) } catch { /* 忽略 */ }
          throw fail(FLOW_CODES.RESPONSE_TOO_LARGE)
        }
        chunks.push(chunk)
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
      return new TextDecoder().decode(merged)
    }
    if (typeof response?.text === 'function') {
      const outcome = await budget.race(() => response.text(), limits.pollPerCallMs)
      if (outcome.kind === 'aborted') throw fail(FLOW_CODES.ABORTED)
      if (outcome.kind !== 'ok') throw fail(outcome.kind === 'error' ? FLOW_CODES.NETWORK : FLOW_CODES.BUDGET_EXHAUSTED)
      if (outcome.value.length > maxBytes) throw fail(FLOW_CODES.RESPONSE_TOO_LARGE)
      return outcome.value
    }
    throw fail(FLOW_CODES.NETWORK)
  }

  function parseJsonStrict(text, state) {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed) } catch { throw fail(FLOW_CODES.RESPONSE_NOT_JSON) }
    }
    for (const prefix of KNOWN_ANTI_XSSI_PREFIXES) {
      if (!trimmed.startsWith(prefix)) continue
      state.report.booleans.sawKnownAntiXssiPrefix = true
      const rest = trimmed.slice(prefix.length).trimStart()
      if (!rest.startsWith('{')) throw fail(FLOW_CODES.RESPONSE_NOT_JSON)
      try { return JSON.parse(rest) } catch { throw fail(FLOW_CODES.RESPONSE_NOT_JSON) }
    }
    throw fail(FLOW_CODES.RESPONSE_NOT_JSON)
  }

  async function readJson(state, budget, response) {
    const text = await readTextBudget(state, budget, response, limits.maxJsonBytes)
    return parseJsonStrict(text, state)
  }

  async function readImage(state, budget, response) {
    const text = null
    void text
    const body = response?.body
    if (body !== null && typeof body?.getReader === 'function') {
      const reader = body.getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const outcome = await budget.race(() => reader.read(), limits.pollPerCallMs)
        if (outcome.kind !== 'ok') {
          try { Promise.resolve().then(() => reader.cancel()).catch(() => {}) } catch { /* 忽略 */ }
          throw fail(outcome.kind === 'aborted' ? FLOW_CODES.ABORTED : (outcome.kind === 'error' ? FLOW_CODES.NETWORK : FLOW_CODES.BUDGET_EXHAUSTED))
        }
        const step = outcome.value
        if (step?.done === true) break
        if (!(step?.value instanceof Uint8Array)) throw fail(FLOW_CODES.QR_IMAGE_INVALID)
        total += step.value.byteLength
        if (total > limits.maxQrBytes) {
          try { Promise.resolve().then(() => reader.cancel()).catch(() => {}) } catch { /* 忽略 */ }
          throw fail(FLOW_CODES.QR_IMAGE_TOO_LARGE)
        }
        chunks.push(step.value)
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
      return merged
    }
    if (typeof response?.arrayBuffer === 'function') {
      const outcome = await budget.race(() => response.arrayBuffer(), limits.pollPerCallMs)
      if (outcome.kind === 'aborted') throw fail(FLOW_CODES.ABORTED)
      if (outcome.kind !== 'ok') throw fail(outcome.kind === 'error' ? FLOW_CODES.NETWORK : FLOW_CODES.BUDGET_EXHAUSTED)
      const bytes = new Uint8Array(outcome.value)
      if (bytes.byteLength > limits.maxQrBytes) throw fail(FLOW_CODES.QR_IMAGE_TOO_LARGE)
      return bytes
    }
    throw fail(FLOW_CODES.QR_IMAGE_INVALID)
  }

  function detectHumanChallenge(payload) {
    if (payload === null || typeof payload !== 'object') return false
    for (const key of HUMAN_KEYS) {
      const value = payload[key]
      if (value !== undefined && value !== null && value !== false) return true
    }
    return false
  }

  /** 严格校验服务端账号字段，**绝不改写**；非法即停。 */
  function accountCookieLines(pollPayload) {
    const lines = []
    for (const field of ACCOUNT_FIELDS) {
      const value = pollPayload?.[field]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw fail(FLOW_CODES.CREDENTIAL_FIELD_INVALID)
      if (!COOKIE_OCTET_RE.test(value)) throw fail(FLOW_CODES.CREDENTIAL_FIELD_INVALID)
      lines.push(`${field}=${value}; Path=/; Secure`)
    }
    return lines
  }

  function tokenBooleans() {
    const account = jar.cookieHeaderFor(`https://${ACCOUNT_HOST}/`).names ?? []
    const platform = jar.cookieHeaderFor(`https://${PLATFORM_HOST}/`).names ?? []
    return {
      hasPassToken: account.includes('passToken'),
      hasUserId: account.includes('userId'),
      hasCUserId: account.includes('cUserId'),
      deviceIdFromServer: account.includes('deviceId'),
      hasServiceToken: platform.includes('api-platform_serviceToken'),
      platformSessionComplete: account.includes('userId') && platform.includes('api-platform_serviceToken'),
    }
  }

  /** 按官方给的 location 走跳转链（有界、逐跳校验/登记）。 */
  async function followReceipt(state, budget, startLocation, purpose) {
    let hop = startLocation
    for (let index = 0; ; index += 1) {
      if (index >= limits.maxRedirects) throw fail(FLOW_CODES.REDIRECT_LIMIT)
      const hopUrl = validateDynamic(hop, purpose)
      register(state, hopUrl.toString())
      const step = await callOnce(state, budget, hopUrl.toString(), { step: 'redirect', perCallMs: 15_000 })
      if (step.status >= 300 && step.status < 400 && typeof step.location === 'string' && step.location.length > 0) {
        hop = step.location
        continue
      }
      return
    }
  }

  async function gateQr(state, budget) {
    state.report.stage = 'qr'
    state.report.gates.qr.attempted = true

    register(state, FIXED_ENTRY.GEN_LOGIN)
    const gen = await callOnce(state, budget, FIXED_ENTRY.GEN_LOGIN, { step: 'genLogin', perCallMs: 12_000 })
    if (gen.status !== 301 && gen.status !== 302) throw fail(FLOW_CODES.STATUS_UNEXPECTED)
    const serviceLogin = validateDynamic(gen.location, 'serviceLogin')
    const sidValues = serviceLogin.searchParams.getAll('sid')
    const callbackValues = serviceLogin.searchParams.getAll('callback')
    if (sidValues.length !== 1 || sidValues[0] !== 'api-platform') throw fail(FLOW_CODES.SID_MISMATCH)
    if (callbackValues.length !== 1 || callbackValues[0].length === 0) throw fail(FLOW_CODES.DYNAMIC_URL_REJECTED)
    const callback = validateDynamic(callbackValues[0], 'callback')
    register(state, serviceLogin.toString())

    // 参考合约里的最小正常参数（不含任何安全削弱项 serviceParam）。
    const pollUrl = new URL(FIXED_ENTRY.LONG_POLL_BASE)
    pollUrl.searchParams.set('_qrsize', '240')
    pollUrl.searchParams.set('qs', encodeURIComponent(`?callback=${encodeURIComponent(callback.toString())}&sid=api-platform&_group=DEFAULT&_json=true&_locale=zh_CN`))
    pollUrl.searchParams.set('callback', callback.toString())
    pollUrl.searchParams.set('_hasLogo', 'false')
    pollUrl.searchParams.set('sid', 'api-platform')
    pollUrl.searchParams.set('_locale', 'zh_CN')
    pollUrl.searchParams.set('_dc', String(now()))
    register(state, pollUrl.toString())
    const init = await callOnce(state, budget, pollUrl.toString(), { step: 'genLogin', perCallMs: 15_000 })
    if (init.status !== 200) throw fail(FLOW_CODES.STATUS_UNEXPECTED)
    const initBody = await readJson(state, budget, init.response)
    if (detectHumanChallenge(initBody)) throw fail(FLOW_CODES.NEEDS_HUMAN_VERIFICATION)
    if (typeof initBody?.qr !== 'string' || typeof initBody?.lp !== 'string') throw fail(FLOW_CODES.RESPONSE_NOT_JSON)
    let initOrigin
    try { initOrigin = new URL(init.url).origin } catch { throw fail(FLOW_CODES.URL_PURPOSE_MISMATCH) }
    if (init.redirected !== false || initOrigin !== new URL(FIXED_ENTRY.LONG_POLL_BASE).origin) {
      throw fail(FLOW_CODES.URL_PURPOSE_MISMATCH)
    }
    const sourceContext = Object.freeze({
      origin: initOrigin,
      initPath: new URL(init.url).pathname,
      redirected: init.redirected,
      sid: 'api-platform',
      callback: callback.toString(),
    })
    const qrUrl = validateDynamic(initBody.qr, 'qrImage')
    register(state, qrUrl.toString())
    const serverTimeout = Number(initBody?.timeout)
    if (Number.isFinite(serverTimeout) && serverTimeout > 0) {
      state.report.limits.serverTimeoutSec = serverTimeout
      const serverDeadline = now() + serverTimeout * 1000
      if (serverDeadline < state.deadline) state.deadline = serverDeadline
      state.report.limits.effectiveBudgetMs = state.deadline - state.startedAt
    }

    const lpUrl = await resolveLongPollTarget(state, budget, initBody.lp, sourceContext)
    const image = await callOnce(state, budget, qrUrl.toString(), { step: 'qrImage', perCallMs: 10_000, accept: 'image/png,image/jpeg;q=0.9' })
    if (image.status !== 200) throw fail(FLOW_CODES.STATUS_UNEXPECTED)
    const bytes = await readImage(state, budget, image.response)
    const magic = detectImageMagic(bytes)
    if (magic === null) throw fail(FLOW_CODES.QR_IMAGE_INVALID)
    state.report.booleans.qrIsPng = magic === 'png'
    state.report.booleans.qrIsJpeg = magic === 'jpeg'
    const shown = await budget.race(() => display.showQr({ bytes, mime: magic === 'png' ? 'image/png' : 'image/jpeg' }), limits.displayMs)
    if (shown.kind === 'aborted') throw fail(FLOW_CODES.ABORTED)
    if (shown.kind !== 'ok') throw fail(FLOW_CODES.DISPLAY_ERROR)
    if (shown.value?.kind === 'cancelled' || shown.value?.kind === 'closed') throw fail(FLOW_CODES.CANCELLED)
    if (shown.value?.kind !== 'shown') throw fail(FLOW_CODES.DISPLAY_ERROR)

    // 长轮询：保留**成功那次**的响应归属，供 Cookie 域使用。
    let receipt = null
    for (;;) {
      const poll = await callOnce(state, budget, lpUrl.toString(), { step: 'longPoll' })
      if (poll.timedOut === true) continue
      if (poll.status !== 200) throw fail(FLOW_CODES.STATUS_UNEXPECTED)
      const payload = await readJson(state, budget, poll.response)
      if (detectHumanChallenge(payload)) throw fail(FLOW_CODES.NEEDS_HUMAN_VERIFICATION)
      if (typeof payload?.location === 'string' && payload.location.length > 0) {
        receipt = { payload, sourceUrl: lpUrl.toString(), lines: poll.lines }
        break
      }
      if (payload?.code !== undefined && payload?.code !== 0) throw fail(FLOW_CODES.NEEDS_HUMAN_VERIFICATION)
      const wait = Math.min(limits.backoffMs, Math.max(1, state.deadline - now()))
      const paused = await budget.race(() => sleep(wait), wait + 50)
      if (paused.kind !== 'ok') throw fail(paused.kind === 'aborted' ? FLOW_CODES.ABORTED : FLOW_CODES.BUDGET_EXHAUSTED)
    }

    const dynamicReceipt = state.approvedLongPoll !== null && receipt.sourceUrl === state.approvedLongPoll
    if (dynamicReceipt) {
      // Dynamic approved LP may not mint account cookies or feed any later purpose.
      // Presence of any account credential field is fail-closed, including null/empty values.
      if (ACCOUNT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(receipt.payload, field))) {
        throw fail(FLOW_CODES.CREDENTIAL_FIELD_INVALID)
      }
    } else {
      // Account tickets: only map real server fields to their account response origin (values unchanged).
      const lines = accountCookieLines(receipt.payload)
      if (lines.length > 0) {
        const accountUrl = new URL(receipt.sourceUrl)
        if (accountUrl.hostname.toLowerCase() !== ACCOUNT_HOST) throw fail(FLOW_CODES.URL_PURPOSE_MISMATCH)
        absorbOnce(state, lines, `https://${ACCOUNT_HOST}/`)
      }
    }

    // 先按官方回执跳转（有界）；已有平台票就直接余额，否则做**一次** SSO JSON 兜底。
    await followReceipt(state, budget, receipt.payload.location, 'scanReceipt')
    if (tokenBooleans().hasServiceToken !== true) {
      const ssoUrl = new URL(serviceLogin.toString())
      ssoUrl.searchParams.set('_json', 'true')
      ssoUrl.searchParams.set('_locale', 'zh_CN')
      register(state, ssoUrl.toString())
      const sso = await callOnce(state, budget, ssoUrl.toString(), { step: 'sso', perCallMs: 15_000 })
      if (sso.status !== 200) throw fail(FLOW_CODES.STATUS_UNEXPECTED)
      const payload = await readJson(state, budget, sso.response)
      if (detectHumanChallenge(payload)) throw fail(FLOW_CODES.NEEDS_HUMAN_VERIFICATION)
      if (payload?.code === 70016) throw fail(FLOW_CODES.PASS_TOKEN_REJECTED)
      if (payload?.code !== 0 || typeof payload?.location !== 'string') throw fail(FLOW_CODES.SSO_INCOMPLETE)
      await followReceipt(state, budget, payload.location, 'ssoLocation')
    }

    const booleans = tokenBooleans()
    state.report.booleans = { ...state.report.booleans, ...booleans }
    if (booleans.platformSessionComplete !== true) throw fail(FLOW_CODES.QR_GATE_INCOMPLETE)
    state.report.gates.qr.ok = true
  }

  async function gateBalance(state, budget) {
    state.report.stage = 'balance'
    state.report.gates.balance.attempted = true
    register(state, FIXED_ENTRY.BALANCE)
    const res = await callOnce(state, budget, FIXED_ENTRY.BALANCE, { step: 'balance', perCallMs: 10_000 })
    if (res.status !== 200) throw fail(FLOW_CODES.BALANCE_HTTP)
    const payload = await readJson(state, budget, res.response)
    if (payload?.code !== 0) throw fail(FLOW_CODES.BALANCE_CODE)
    const parsed = parseBalance(payload)
    if (parsed === null || parsed === undefined) throw fail(FLOW_CODES.BALANCE_PARSE)

    // 只把**严格白名单**的数值/币种交给本机窗口；报告里仍只有枚举。
    const view = {
      balance: Number(parsed.balance),
      cashBalance: parsed.cashBalance === null ? null : Number(parsed.cashBalance),
      giftBalance: parsed.giftBalance === null ? null : Number(parsed.giftBalance),
      currency: typeof parsed.currency === 'string' ? parsed.currency.slice(0, 8) : '',
    }
    if (!Number.isFinite(view.balance)) throw fail(FLOW_CODES.BALANCE_INPUT_INVALID)
    state.report.gates.balance.hasCashBalance = view.cashBalance !== null
    state.report.gates.balance.hasGiftBalance = view.giftBalance !== null
    if (typeof display.askBalanceMatch === 'function') {
      const asked = await budget.race(() => display.askBalanceMatch(view), limits.displayMs)
      if (budget.expired() || asked.kind === 'timeout') throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted() || asked.kind === 'aborted') throw fail(FLOW_CODES.ABORTED)
      const verdict = asked.kind === 'ok' ? asked.value : null
      state.report.gates.balance.confirmedByUser = (verdict === 'match' || verdict === 'mismatch' || verdict === 'later')
        ? verdict
        : 'later'
    }
    state.report.gates.balance.ok = true
  }

  function destroy(state) {
    try {
      if (typeof state.controller?.abort === 'function') state.controller.abort()
    } catch { /* 已中止 */ }
    try { jar.clear() } catch { /* 忽略 */ }
    if (state.policy !== null) state.policy.clear()
    state.qrBytes = null
    state.receipt = null
    try { display.close() } catch { /* 忽略 */ }
    if (current(state.gen) !== null) runState = null
  }

  async function run(options = {}) {
    if (active === true) return { ok: false, code: FLOW_CODES.RUN_ALREADY_ACTIVE, gates: null }
    active = true
    generation += 1
    const gen = generation
    const startedAt = now()
    const controller = new AbortController()
    const state = {
      gen,
      controller,
      startedAt,
      deadline: startedAt + limits.hardMs,
      policy: new Map(),
      allowDynamicLongPoll: allowDynamicLongPoll === true,
      approvedLongPoll: null,
      qrBytes: null,
      receipt: null,
      report: {
        probe: 'mimo-memory-flow',
        version: 2,
        gen,
        ok: false,
        code: FLOW_CODES.OK,
        stage: 'init',
        gates: {
          qr: { attempted: false, ok: false, code: FLOW_CODES.OK },
          balance: { attempted: false, ok: false, code: FLOW_CODES.OK, confirmedByUser: 'skipped', hasCashBalance: false, hasGiftBalance: false },
        },
        calls: { total: 0, genLogin: 0, longPoll: 0, qrImage: 0, sso: 0, redirect: 0, balance: 0 },
        booleans: {
          sawKnownAntiXssiPrefix: false,
          hasPassToken: false, hasUserId: false, hasCUserId: false,
          hasServiceToken: false, deviceIdFromServer: false,
          qrIsPng: false, qrIsJpeg: false, platformSessionComplete: false,
        },
        limits: {
          hardMs: limits.hardMs, pollPerCallMs: limits.pollPerCallMs, maxCalls: limits.maxCalls,
          serverTimeoutSec: null, effectiveBudgetMs: limits.hardMs,
        },
        /** 动态 URL 拒绝时的固定枚举诊断；其它失败为 null。 */
        diagnostic: null,
        notes: [
          'memory-only PoC: no persistence, no records, no profile/config access',
          'gates covered: QR + real balance only; restart-recovery and renewal NOT tested',
          'not an account authorization; passToken presence alone is not success',
        ],
      },
    }
    runState = state
    const budget = createBudget(state)

    const external = options?.signal
    let detach = null
    if (external !== null && external !== undefined && typeof external.addEventListener === 'function') {
      const onAbort = () => { try { controller.abort() } catch { /* 已中止 */ } }
      if (external.aborted === true) onAbort()
      else { external.addEventListener('abort', onAbort, { once: true }); detach = () => external.removeEventListener('abort', onAbort) }
    }

    try {
      await gateQr(state, budget)
      await gateBalance(state, budget)
      if (budget.expired()) throw fail(FLOW_CODES.BUDGET_EXHAUSTED)
      if (budget.aborted()) throw fail(FLOW_CODES.ABORTED)
      state.report.ok = state.report.gates.qr.ok === true && state.report.gates.balance.ok === true
      state.report.code = state.report.ok ? FLOW_CODES.OK : FLOW_CODES.STAGE_INCOMPLETE
      state.report.stage = 'done'
      return state.report
    } catch (error) {
      const code = staticCode(error)
      state.report.ok = false
      state.report.code = code
      if (error?.[INTERNAL_FAILURE] === true && error.diagnostic !== undefined) {
        state.report.diagnostic = error.diagnostic
      }
      if (state.report.stage === 'qr' && state.report.gates.qr.ok !== true) state.report.gates.qr.code = code
      if (state.report.stage === 'balance') state.report.gates.balance.code = code
      return state.report
    } finally {
      if (typeof detach === 'function') { try { detach() } catch { /* 忽略 */ } }
      destroy(state)
      active = false
    }
  }

  function cancel() {
    if (runState === null) return false
    try { runState.controller.abort() } catch { return false }
    return true
  }

  return { run, cancel }
}

export default createMemoryFlow
