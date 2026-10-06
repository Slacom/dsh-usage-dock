/**
 * dsh-plan-usage 各套餐模块共享的通用工具：curl 拉取、用量窗口归一化、
 * 凭据解析与 wire 结果拼装。这里不包含任何具体套餐的业务逻辑——
 * 每个套餐的取数/归一化逻辑独立封装在 plans/ 下的对应模块里。
 */

/**
 * 通过 shell / 原生 fetch 拉取 JSON。opts：
 * - `auth`：Authorization 凭据（API Key 或 kimi-auth JWT），缺省不带该头；
 * - `bearer`：false 时 Authorization 直接携带裸值（GLM monitor），默认 true；
 * - `cookie`：附加 `Cookie: kimi-auth=<value>` 头（Kimi 网页接口）；
 * - `method`/`body`：method 为 'POST' 时以 JSON body 发 POST；
 * - `headers`：附加请求头 {name: value}。
 * 各后端都在响应体尾部追加同一种 `__DSH_HTTP__<status>` 标记（原生 fetch 是
 * `-w` 的等价物），因此解析逻辑完全共用；非 200 且响应体无业务错误结构时按
 * HTTP 错误返回。
 *
 * [local patch] 取数后端自适应（原生 fetch ⇄ Python shim ⇄ curl）：
 * - **原生 fetch**（Host 进程内的 Node fetch）：首选。不需要 shell 服务，也不需要
 *   任何外部可执行文件；走 Node 自带的 OpenSSL，因此不受 Windows 沙箱 schannel
 *   限制（SEC_E_NO_CREDENTIALS）。移动端（Android APK）没有 python/curl，
 *   这是唯一可用的后端——0.6.2 之前它在移动端必然报「upstream request failed」。
 * - **Python shim**（随附 http-fetch.py）：桌面端兜底。urllib 会顺带读取系统/环境
 *   代理设置（如 Clash 系统代理），因此在必须走代理出网的环境里比 fetch 更可靠；
 *   请求规格经环境变量传递，密钥不进命令行。
 * - **curl**：Linux / macOS 或未受 schannel 限制的环境兜底。
 * 只有**传输层**失败（可执行文件缺失、DNS/TLS/连接失败）才继续尝试下一个后端；
 * 上游已给出 HTTP/业务错误的立即返回，不再空耗一轮超时。首次成功的后端会被记住，
 * 后续请求直接复用。
 */
import { fileURLToPath } from 'node:url'

/** [local patch] Python shim 的绝对路径（与 util.js 同目录）。 */
const SHIM_PATH = fileURLToPath(new URL('./http-fetch.py', import.meta.url))

/** [local patch] 取数后端顺序：原生 fetch 优先，Python shim / curl 依次兜底。 */
const BACKENDS = ['fetch', 'python', 'curl']

/** 单次请求超时（毫秒）：curl/python 走各自的超时参数，fetch 用 AbortController。 */
const REQUEST_TIMEOUT_MS = 10000

/** 首个成功的后端；后续请求直接复用它。 */
let preferredBackend = null

/**
 * [local patch] 原生 fetch 后端：直接在 Host 进程内请求，不经过 shell。
 *
 * 结果对象刻意做成与 shell 后端同形（exitCode/stdout.text/stderr.text），
 * 并同样追加 `__DSH_HTTP__<status>` 尾标记，好让 parseResult 一套逻辑通吃。
 * 传输层失败时返回非 0 exitCode，交给调用方决定是否换后端。
 */
async function fetchBackend(url, opts, reqHeaders) {
  const method = opts.method === 'POST' ? 'POST' : 'GET'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const init = { method, headers: reqHeaders, signal: controller.signal }
    if (method === 'POST' && typeof opts.body === 'string' && opts.body.length > 0) {
      init.body = opts.body
    }
    const res = await fetch(url, init)
    const text = await res.text()
    return { exitCode: 0, stdout: { text: text + '\n__DSH_HTTP__' + res.status } }
  } catch (err) {
    // undici 的报错只有一句 "fetch failed"，真正的原因（ENOTFOUND/ECONNREFUSED/
    // 证书错误）藏在 cause 里；把它带出来，远程排查（如平板）才有依据。
    const parts = [err != null && err.message ? err.message : String(err)]
    if (err != null && err.name === 'AbortError') parts.push('(timeout after ' + REQUEST_TIMEOUT_MS + 'ms)')
    const cause = err != null && err.cause != null ? err.cause : null
    if (cause != null) {
      const code = typeof cause.code === 'string' ? cause.code : ''
      const detail = cause.message ? String(cause.message) : ''
      const extra = [code, detail].filter((part) => part.length > 0).join(' ')
      if (extra.length > 0) parts.push('(' + extra + ')')
    }
    return { exitCode: 1, stdout: { text: '' }, stderr: { text: parts.join(' ') } }
  } finally {
    clearTimeout(timer)
  }
}

/** 执行某个后端的请求；python/curl 需要 shell 服务，fetch 不需要。 */
function runBackend(backend, shell, url, opts, reqHeaders) {
  if (backend === 'fetch') return fetchBackend(url, opts, reqHeaders)
  return shell.run(backend === 'python'
    ? pythonSpec(shell, url, opts, reqHeaders)
    : curlSpec(shell, url, opts, reqHeaders))
}

/** Python shim 的请求规格：整体走环境变量（密钥绝不进命令行）。 */
function pythonSpec(shell, url, opts, reqHeaders) {
  return shell.resolve({
    command: 'python "' + SHIM_PATH + '"',
    env: {
      PLAN_USAGE_SPEC: JSON.stringify({
        url,
        method: opts.method === 'POST' ? 'POST' : 'GET',
        headers: reqHeaders,
        body: opts.body,
        timeout: 10,
      }),
    },
    timeoutMs: 15000,
    stdoutMaxBytes: 16384,
  })
}

/** 双引号包裹一个 shell 参数，并转义内部双引号。 */
function quoteArg(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"'
}

/** curl 的请求规格：Linux / macOS 或未受 schannel 限制的 Windows。 */
function curlSpec(shell, url, opts, reqHeaders) {
  const argv = ['-sS', '-m', '10', '-w', '"__DSH_HTTP__%{http_code}"']
  for (const name of Object.keys(reqHeaders)) {
    argv.push('-H', quoteArg(name + ': ' + reqHeaders[name]))
  }
  if (opts.method === 'POST') {
    argv.push('-X', 'POST')
    if (typeof opts.body === 'string' && opts.body.length > 0) {
      argv.push('--data-binary', quoteArg(opts.body))
    }
  }
  argv.push(quoteArg(url))
  return shell.resolve({
    command: 'curl ' + argv.join(' '),
    timeoutMs: 15000,
    stdoutMaxBytes: 16384,
  })
}

/**
 * [local patch] 把一次失败压缩成一行简短原因，用于把「到底为什么失败」显示到胶囊里。
 * 0.6.1 之前这里恒为「upstream request failed」，移动端未装 python/curl 时用户
 * 完全看不出原因。
 */
function reasonOf(result) {
  const text = (stream) => (stream != null && typeof stream.text === 'string' ? stream.text : '')
  const exitCode = result != null && typeof result.exitCode === 'number' ? result.exitCode : null
  const detail = (text(result && result.stderr) || text(result && result.stdout)).trim()
  const lines = detail.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const tail = lines.length > 0 ? lines[lines.length - 1].slice(0, 120) : ''
  if (exitCode !== null && exitCode !== 0) return 'exit ' + exitCode + (tail ? ': ' + tail : '')
  return tail || 'empty response'
}

/** 解析 shell 输出：剥离状态码尾标记、解析 JSON、映射上游错误结构。 */
function parseResult(result, backend) {
  const raw = result && result.stdout && typeof result.stdout.text === 'string'
    ? result.stdout.text
    : ''
  // 剥离 -w 追加的状态码标记（标记不可能出现在合法 JSON 里）。
  const m = raw.match(/__DSH_HTTP__(\d{3})\s*$/)
  const status = m !== null ? parseInt(m[1], 10) : null
  const body = m !== null ? raw.slice(0, m.index).trim() : raw.trim()
  if (result.exitCode !== 0 || body.length === 0) {
    // 传输层失败：retryable 表示可以换个后端再试（可执行文件缺失 / DNS / TLS / 连接失败）。
    return {
      err: {
        error: 'curl',
        message: 'upstream request failed（' + backend + ': ' + reasonOf(result) + '）',
      },
      retryable: true,
    }
  }
  let data
  try {
    data = JSON.parse(body)
  } catch (err) {
    return { err: { error: 'parse', message: 'invalid upstream response' } }
  }
  // 上游错误体：OpenCode Go 用 `{type:'error', error:{...}}`，GLM monitor 用
  // `{error:{code,message}}` 或 `{code:<非200>, msg}`，统一映射。
  if (data != null && typeof data === 'object') {
    const e = data.type === 'error' || (data.error != null && typeof data.error === 'object')
      ? data.error
      : null
    if (e != null) {
      return {
        err: {
          error: e && e.type ? e.type : 'api',
          message: e && e.message ? e.message : 'API error',
        },
      }
    }
    if (typeof data.code === 'number' && data.code !== 200) {
      return {
        err: {
          error: 'api',
          message: typeof data.msg === 'string' && data.msg ? data.msg : 'API error (code ' + data.code + ')',
        },
      }
    }
  }
  // 响应体没有业务错误结构但 HTTP 状态非 200（如 Kimi 接口的 401/403）。
  if (status !== null && status !== 200) {
    return { err: { error: 'http', message: 'upstream HTTP ' + status } }
  }
  if (data == null || typeof data !== 'object') {
    return { err: { error: 'empty', message: 'empty response' } }
  }
  return { data }
}

export async function curlJson(shell, url, opts) {
  opts = opts || {}
  const auth = typeof opts.auth === 'string' && opts.auth.length > 0 ? opts.auth : undefined
  const cookie = typeof opts.cookie === 'string' && opts.cookie.length > 0 ? opts.cookie : undefined
  const reqHeaders = { Accept: 'application/json' }
  const extraHeaders = opts.headers != null && typeof opts.headers === 'object' ? opts.headers : null
  if (extraHeaders !== null) {
    for (const name of Object.keys(extraHeaders)) reqHeaders[name] = extraHeaders[name]
  }
  if (auth !== undefined) {
    reqHeaders.Authorization = (opts.bearer === false ? '' : 'Bearer ') + auth
  }
  if (cookie !== undefined) reqHeaders.Cookie = 'kimi-auth=' + cookie
  if (opts.method === 'POST') reqHeaders['Content-Type'] = 'application/json'

  // 该环境可用的后端：原生 fetch 不需要 shell 服务；python/curl 需要。
  const usable = BACKENDS.filter((backend) => (backend === 'fetch'
    ? typeof fetch === 'function'
    : shell != null && typeof shell.run === 'function'))
  if (usable.length === 0) {
    return { err: { error: 'curl', message: 'upstream request failed（没有可用的取数后端：无 fetch 且 shell 服务不可用）' } }
  }

  // 已确定的后端优先；否则按默认顺序（fetch → python → curl）依次尝试。
  const order = preferredBackend === null || usable.indexOf(preferredBackend) === -1
    ? usable.slice()
    : [preferredBackend].concat(usable.filter((backend) => backend !== preferredBackend))
  const failures = []
  for (const backend of order) {
    let result
    try {
      result = await runBackend(backend, shell, url, opts, reqHeaders)
    } catch (err) {
      // shell.run 自身抛错（服务拒绝执行、后端进程起不来等）同样按传输层失败处理。
      failures.push(backend + ': ' + (err != null && err.message ? err.message : String(err)))
      if (preferredBackend === backend) preferredBackend = null
      continue
    }
    const parsed = parseResult(result, backend)
    if (parsed.data !== undefined) {
      preferredBackend = backend
      return parsed
    }
    // 上游已经答复（HTTP 状态 / 业务错误体 / 无法解析的响应）：换后端没有意义。
    if (parsed.retryable !== true) return parsed
    failures.push(backend + ': ' + reasonOf(result))
    if (preferredBackend === backend) preferredBackend = null
  }
  const detail = failures.join('；')
  return {
    err: {
      error: 'curl',
      message: 'upstream request failed（' + (detail.length > 180 ? detail.slice(0, 177) + '…' : detail) + '）',
    },
  }
}

/** 归一化一个用量窗口，兼容线上结构（percent/resetsAt）与旧结构（usagePercent/resetInSec）。 */
export function norm(raw) {
  if (raw == null || typeof raw !== 'object') return null
  const percent = typeof raw.percent === 'number'
    ? raw.percent
    : (typeof raw.usagePercent === 'number' ? raw.usagePercent : null)
  return {
    status: typeof raw.status === 'string' ? raw.status : null,
    percent,
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
    resetInSec: typeof raw.resetInSec === 'number' ? raw.resetInSec : null,
  }
}

/** 把字符串/数字统一转成数字；无法解析返回 null。 */
export function toNum(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 依次尝试一组凭据名，命中第一个非空值（含环境变量与 .env 回退）。 */
export async function resolveCredentialApiKey(ctx, refs) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  for (const ref of refs) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value && hit.value.length > 0) return hit.value
    } catch (err) {
      // 未命中就试下一个。
    }
  }
  return undefined
}

/** 按「插件配置 > 模型配置（凭据库）」解析某套餐的 API Key。 */
export async function resolveApiKey(ctx, cfg, apiKeyField, refs) {
  const pluginKey = typeof cfg[apiKeyField] === 'string' && cfg[apiKeyField].length > 0
    ? cfg[apiKeyField]
    : undefined
  if (pluginKey !== undefined) return pluginKey
  return resolveCredentialApiKey(ctx, refs)
}

/** wire 对象的固定头：{ id, name }，所有套餐结果都以它开头。 */
export function planBase(plan) {
  return { id: plan.id, name: plan.name }
}

/** 未配置 Key 的 wire 结果（浏览器胶囊据此提示用户设置）。 */
export function noKey(plan) {
  return Object.assign(planBase(plan), {
    error: 'no-key',
    message: '未配置 ' + plan.name + ' API Key，请到「设置 → 插件」或「设置 → 模型」中配置',
  })
}

/** 取数执行异常（shell 抛错）的兜底结果。 */
export function execError(plan) {
  return Object.assign(planBase(plan), { error: 'exec', message: 'upstream request failed' })
}
