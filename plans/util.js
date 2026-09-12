/**
 * dsh-plan-usage 各套餐模块共享的通用工具：curl 拉取、用量窗口归一化、
 * 凭据解析与 wire 结果拼装。这里不包含任何具体套餐的业务逻辑——
 * 每个套餐的取数/归一化逻辑独立封装在 plans/ 下的对应模块里。
 */

/**
 * 通过 shell 执行 curl 拉取 JSON。opts：
 * - `auth`：Authorization 凭据（API Key 或 kimi-auth JWT），缺省不带该头；
 * - `bearer`：false 时 Authorization 直接携带裸值（GLM monitor），默认 true；
 * - `cookie`：附加 `Cookie: kimi-auth=<value>` 头（Kimi 网页接口）；
 * - `method`/`body`：method 为 'POST' 时以 JSON body 发 POST；
 * - `headers`：附加请求头 {name: value}。
 * 额外用 `-w` 捕获 HTTP 状态码：非 200 且响应体无业务错误结构时按 HTTP 错误返回。
 *
 * [local patch] 取数后端自适应（Python shim ⇄ curl）：
 * - **Python shim**（随附 http-fetch.py）：Windows ACL 沙箱的受限令牌下 schannel
 *   无法获取 TLS 凭据（SEC_E_NO_CREDENTIALS），本机 curl.exe 全部走 schannel，故
 *   Windows 沙箱内必须使用 Python/OpenSSL；请求规格经环境变量传递，密钥不进命令行。
 * - **curl**：Linux / macOS 或未受该限制的 Windows 环境可直接使用，作为兜底后端。
 * 首次成功的后端会被记住，后续请求直接复用，避免每次都试错。两个后端输出同一种
 * `__DSH_HTTP__<code>` 尾标记，因此解析逻辑完全共用。
 */
import { fileURLToPath } from 'node:url'

/** [local patch] Python shim 的绝对路径（与 util.js 同目录）。 */
const SHIM_PATH = fileURLToPath(new URL('./http-fetch.py', import.meta.url))

/** [local patch] 取数后端顺序：Python shim 优先（Windows 沙箱必需），curl 兜底。 */
const BACKENDS = ['python', 'curl']

/** 首个成功的后端；后续请求直接复用它。 */
let preferredBackend = null

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

/** 解析 shell 输出：剥离状态码尾标记、解析 JSON、映射上游错误结构。 */
function parseResult(result) {
  const raw = result && result.stdout && typeof result.stdout.text === 'string'
    ? result.stdout.text
    : ''
  // 剥离 -w 追加的状态码标记（标记不可能出现在合法 JSON 里）。
  const m = raw.match(/__DSH_HTTP__(\d{3})\s*$/)
  const status = m !== null ? parseInt(m[1], 10) : null
  const body = m !== null ? raw.slice(0, m.index).trim() : raw.trim()
  if (result.exitCode !== 0 || body.length === 0) {
    return { err: { error: 'curl', message: 'upstream request failed' } }
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

  // 已确定的后端优先；否则按默认顺序（Python → curl）依次尝试。
  const order = preferredBackend === null
    ? BACKENDS.slice()
    : [preferredBackend].concat(BACKENDS.filter((b) => b !== preferredBackend))
  let last = { err: { error: 'curl', message: 'upstream request failed' } }
  for (const backend of order) {
    let result
    try {
      result = await shell.run(backend === 'python'
        ? pythonSpec(shell, url, opts, reqHeaders)
        : curlSpec(shell, url, opts, reqHeaders))
    } catch (err) {
      continue
    }
    const parsed = parseResult(result)
    if (parsed.data !== undefined) {
      preferredBackend = backend
      return parsed
    }
    last = parsed
  }
  return last
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
