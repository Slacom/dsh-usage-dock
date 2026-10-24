/**
 * [方向 6 / T1] 模型工具投影：把 `/api/plan-usage` 的 wire 数据转换成
 * `usage_status` 的**结构化、脱敏、白名单**输出。
 *
 * 设计约束（计划第 4 节 + D6 复核）：
 *   - **只读**：不取数、不改配置、不切模型。纯函数，输入是已取到的 wire 列表。
 *   - **白名单重建**：输出对象由这里逐字段构造，**绝不** `Object.assign` 透传 wire。
 *   - **值级校验**（D6-F）：白名单字段也要检查取值——`resetsAt` 只接受可解析的
 *     日期时间并规范化，非法一律 `null`；否则上游可以把 URL/自由文本塞进来。
 *   - **真实语义**（D6-C）：`percent` 的语义由渠道声明（Codex=剩余，OpenCode=已用），
 *     统一换算成 `percentMode: 'remaining'`；越界不钳位，直接置 `null`。
 *   - **积分单位**：WorkBuddy 的 `creditsTotal` 是有限积分，`unit: 'credits'`。
 *   - **可辨状态**：停用 / 已删除 / 未请求到数据 / 缺凭据 / 退场 各自有独立 code。
 */

/** 工具名（模型可见）。命名遵循宿主既有风格：小写 + 下划线。 */
export const TOOL_NAME = 'usage_status'

/** 工具专用成功缓存 TTL（毫秒）。只缓存成功数据。 */
export const TOOL_CACHE_TTL_MS = 30000

/** 单次工具调用的端到端预算（毫秒）；**从 execute 入口**开始计时（D6-E）。 */
export const TOOL_BUDGET_MS = 8000

/** 已退场的渠道 id（与 plans/index.js 保持一致，这里独立声明避免循环依赖）。 */
export const RETIRED_IDS = ['kimi-code', 'glm-zhipu', 'glm-zai']

/** 内置渠道的静态描述（名称 + 类型）。名称是固定字面量，不来自上游。 */
const BUILTIN_META = {
  'opencode-go': { name: 'OpenCode Go', kind: 'quota' },
  deepseek: { name: 'DeepSeek', kind: 'balance' },
  codex: { name: 'OpenAI Codex', kind: 'quota' },
  mimo: { name: 'Xiaomi MiMo', kind: 'balance' },
  workbuddy: { name: 'WorkBuddy', kind: 'credits' },
  'workbuddy-ai': { name: 'WorkBuddy AI', kind: 'credits' },
}

/** 窗口定义：wire 字段 → 对模型的用途说明。 */
const WINDOWS = [
  { key: 'rollingUsage', scope: 'rolling-5h', label: '5 小时窗口' },
  { key: 'weeklyUsage', scope: 'weekly', label: '周窗口' },
  { key: 'monthlyUsage', scope: 'monthly', label: '月窗口' },
]

/** 固定错误码 → 固定中文说明（绝不透传上游 message）。 */
const ERROR_TEXT = {
  'no-credential': '未配置凭据',
  'signed-out': '未登录或登录已失效',
  auth: '鉴权失败，需要检查或更新凭据',
  config: '渠道配置有误',
  endpoint: '接口地址或参数不正确',
  'credential-unconfirmed': '凭据发送目标尚未确认',
  'rate-limit': '上游限流，暂时不可用',
  server: '上游服务暂时不可用',
  network: '网络不可达或超时',
  structure: '响应结构不符合预期',
  rpc: '取数失败',
  api: '上游拒绝请求',
  exec: '取数命令执行失败',
  curl: '取数失败',
  http: '上游返回错误状态',
  'retired-channel': '该渠道已退场，不再提供数据',
  disabled: '该渠道已停用',
  'not-found': '该渠道已不存在',
  missing: '本次没有该渠道的数据',
  unknown: '无法确定当前状态',
}

/** 把 wire 上的旧错误码映射到工具对外状态码（D6-C：状态必须可辨且稳定）。 */
const ERROR_ALIASES = {
  'no-key': 'no-credential',
  'no-credential': 'no-credential',
  'signed-out': 'signed-out',
  auth: 'auth',
  config: 'config',
  endpoint: 'endpoint',
  'credential-unconfirmed': 'credential-unconfirmed',
  'rate-limit': 'rate-limit',
  server: 'server',
  network: 'network',
  structure: 'structure',
  rpc: 'rpc',
  api: 'api',
  exec: 'exec',
  curl: 'curl',
  http: 'http',
}

/** 把 wire 错误码归一为工具状态码；未知码退化为 'unknown'。 */
export function normalizeErrorCode(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown'
  if (Object.prototype.hasOwnProperty.call(ERROR_ALIASES, raw)) return ERROR_ALIASES[raw]
  return Object.prototype.hasOwnProperty.call(ERROR_TEXT, raw) ? raw : 'unknown'
}

/** 时间文本上限：超过就该拒绝（正常 ISO 时间远小于这个长度）。 */
const MAX_TIME_TEXT = 40

/** `resetInSec` 的合理上限：十年。超过视为脏数据。 */
const MAX_RESET_SECONDS = 10 * 365 * 24 * 3600

/** 是否为一个「合法的活动渠道 id」形态（内置或自定义）。 */
export function isKnownIdShape(id) {
  if (typeof id !== 'string') return false
  if (Object.prototype.hasOwnProperty.call(BUILTIN_META, id)) return true
  return /^custom:[A-Za-z0-9_-]{6,64}$/.test(id)
}

/** 是否为退场 id。 */
export function isRetiredId(id) {
  return typeof id === 'string' && RETIRED_IDS.indexOf(id) !== -1
}

/** 固定错误码的说明文本（测试与渲染共用）。 */
export function errorTextOf(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : ERROR_TEXT.unknown
}

/**
 * 把任意输入归一成「模型可用的数值」：
 *   - 有限数字 → 原样（0 与负数都保留）；
 *   - 其它（null/undefined/字符串/对象/NaN/Infinity）→ null。
 */
export function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * [D6-F] 时间字段的值级校验。
 *
 * 只接受 `YYYY-MM-DD` 开头的可解析时间，并规范化为 ISO 字符串；
 * URL、自由文本、纯年份、超长串一律 `null`。上游无法借此把私密信息带进结构化输出。
 */
export function normalizeTime(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || text.length > MAX_TIME_TEXT) return null
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return null
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/** [D6-F] 剩余秒数的值级校验：非负整数、不超过十年。 */
export function normalizeSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > MAX_RESET_SECONDS) return null
  return Math.floor(value)
}

/** 币种符号 → ISO 代码（模型需要代码，不需要符号）。 */
function currencyCodeOf(currency) {
  if (typeof currency !== 'string' || currency.length === 0) return null
  const text = currency.trim().toUpperCase()
  if (text === 'CNY' || text === 'RMB') return 'CNY'
  if (text === 'USD') return 'USD'
  return /^[A-Z]{2,6}$/.test(text) ? text : null
}

/**
 * [D6-C] 投影单个窗口，并把各渠道的口径统一换算成**剩余**。
 *
 * `semantics` 由调用方按渠道声明：`'remaining'`（Codex）原样保留；
 * `'used'`（OpenCode 等）换算成 `100 - used`。越界（<0 或 >100）不钳位，置 `null`
 * —— 宁可「未知」，也不把 120% 伪装成 0%。
 */
export function projectWindow(usage, semantics) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return null
  const raw = finiteOrNull(usage.percent)
  let percent = null
  if (raw !== null && raw >= 0 && raw <= 100) {
    percent = semantics === 'remaining' ? raw : 100 - raw
  }
  const resetsAt = normalizeTime(usage.resetsAt)
  const resetInSec = normalizeSeconds(usage.resetInSec)
  // 一个窗口至少要有比例或重置时间之一，否则视为无数据。
  if (percent === null && resetsAt === null && resetInSec === null) return null
  return {
    percent,
    percentMode: 'remaining',
    resetsAt,
    resetInSec,
  }
}

/** 空渠道骨架：所有状态码共用，避免各处漏字段。 */
function skeleton(id, name, kind, code, extra) {
  const merged = Object.assign({
    id,
    name,
    kind,
    availability: 'unknown',
    errorCode: code,
    message: errorTextOf(code),
    transient: false,
    windows: [],
    balance: null,
    currency: null,
    unit: null,
    unlimited: false,
    fetchedAt: null,
    stale: false,
  }, extra || {})
  return merged
}

/**
 * 把一条 wire 计划投影成模型输出。
 *
 * `options`：
 *   - `semantics`：该渠道 `percent` 的语义（'remaining' | 'used'）；
 *   - `now`：注入时钟（测试用），用于判定 `fetchedAt` 是否可信。
 */
export function projectPlan(plan, options) {
  const opts = options || {}
  if (plan === null || plan === undefined || typeof plan !== 'object') return null
  const id = typeof plan.id === 'string' ? plan.id : ''
  if (id.length === 0) return null

  // ---- 退场渠道：受控 unknown，不取数、不复活 ----
  if (isRetiredId(id)) {
    return skeleton(id, retiredNameOf(id), 'unknown', 'retired-channel')
  }

  const isCustom = plan.custom === true
  const meta = isCustom
    ? { name: customNameOf(plan), kind: 'balance' }
    : (BUILTIN_META[id] || { name: id, kind: 'unknown' })

  // ---- 错误：固定码 + 固定文案，绝不透传上游原文 ----
  if (typeof plan.error === 'string' && plan.error.length > 0) {
    const code = normalizeErrorCode(plan.error)
    return skeleton(id, meta.name, meta.kind, code, {
      availability: 'error',
      transient: plan.transient === true,
    })
  }

  // ---- 窗口（配额类） ----
  const semantics = opts.semantics === 'remaining' ? 'remaining' : 'used'
  const windows = []
  for (const def of WINDOWS) {
    const projected = projectWindow(plan[def.key], semantics)
    if (projected === null) continue
    windows.push(Object.assign({ scope: def.scope }, projected))
  }

  // ---- 余额 / 积分 ----
  const unlimited = plan.creditsUnlimited === true
  const balance = finiteOrNull(plan.balance)
  // [D6-C] WorkBuddy 的真实 wire 用 `creditsTotal`（有限积分），不是 `creditsBalance`。
  let credits = finiteOrNull(plan.creditsTotal)
  if (credits === null && typeof plan.creditsBalance === 'string' && plan.creditsBalance.trim().length > 0) {
    const numeric = Number(plan.creditsBalance.trim())
    credits = Number.isFinite(numeric) ? numeric : null
  }
  const value = balance !== null ? balance : credits
  const isCredits = meta.kind === 'credits' || (balance === null && credits !== null)
  const currency = isCredits ? null : currencyCodeOf(plan.currency)
  const unit = isCredits ? 'credits' : (currency !== null ? 'currency' : null)

  // ---- 可用性判定 ----
  let availability = 'ok'
  if (unlimited) availability = 'unlimited'
  else if (value === null && windows.length === 0) availability = 'unknown'
  else if (plan.isAvailable === false) availability = 'unavailable'

  return {
    id,
    name: meta.name,
    kind: meta.kind,
    availability,
    errorCode: null,
    message: null,
    transient: false,
    windows,
    balance: value,
    currency,
    unit,
    unlimited,
    fetchedAt: normalizeEpoch(plan.fetchedAt),
    stale: plan.stale === true,
  }
}

/** `fetchedAt` 只接受合理的时间戳（秒或毫秒都归一成毫秒）。 */
function normalizeEpoch(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // 小于 1e12 视为秒级时间戳。
  const ms = value < 1e12 ? value * 1000 : value
  if (ms < 946684800000) return null // 2000-01-01 之前不接受
  return Math.floor(ms)
}

/** 自定义条目名：只接受字符串并截断，避免把任意对象塞进输出。 */
function customNameOf(plan) {
  const raw = typeof plan.name === 'string' ? plan.name.trim() : ''
  if (raw.length === 0) return '自定义余额'
  return raw.length > 40 ? raw.slice(0, 40) : raw
}

/** 退场渠道的固定显示名（不读上游）。 */
function retiredNameOf(id) {
  if (id === 'kimi-code') return 'Kimi Code'
  if (id === 'glm-zhipu') return 'GLM 智谱'
  if (id === 'glm-zai') return 'GLM Z.AI'
  return id
}

/**
 * 解析工具参数，返回 `{ ok, ids }` 或 `{ ok:false, reason }`。
 *
 * 契约（计划第 4 节）：
 *   - **空参数** → 查询「当前启用且受支持」的渠道（由调用方决定启用集合）；
 *   - **显式 ids** → 只查指定集合；退场 id 允许出现（返回 unknown + retired-channel），
 *     **未知 id 是参数错误**（拼错要能被模型发现，而不是静默变成 unknown）。
 *   - 去重、保序；超过上限拒绝。
 */
export const MAX_TOOL_IDS = 12

export function parseToolArgs(args, enabledIds) {
  const enabled = Array.isArray(enabledIds) ? enabledIds.filter((id) => typeof id === 'string') : []
  if (args === null || args === undefined) return { ok: true, ids: enabled }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: '参数必须是对象' }
  }
  const raw = args.ids
  if (raw === undefined || raw === null) return { ok: true, ids: enabled }
  if (!Array.isArray(raw)) return { ok: false, reason: 'ids 必须是字符串数组' }
  if (raw.length === 0) return { ok: true, ids: enabled }
  if (raw.length > MAX_TOOL_IDS) return { ok: false, reason: '一次最多查询 ' + MAX_TOOL_IDS + ' 个渠道' }
  const out = []
  const seen = {}
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { ok: false, reason: 'ids 里只能放非空字符串' }
    }
    const id = item.trim()
    if (seen[id] === true) continue
    seen[id] = true
    // 退场 id 允许：它要能返回 retired-channel，而不是被当成拼错。
    if (!isRetiredId(id) && !isKnownIdShape(id)) {
      return { ok: false, reason: '未知渠道 id：' + id }
    }
    out.push(id)
  }
  return { ok: true, ids: out }
}

/**
 * 把一组 wire 计划投影成工具结果（顶层结构）。
 *
 * `context`：
 *   - `enabled`：当前启用的 id 集合（Set 或数组）；显式请求的停用渠道返回 `disabled`；
 *   - `known`：配置里存在的 id 集合；不在其中的自定义 id 返回 `not-found`；
 *   - `semanticsOf(id)`：该渠道 `percent` 的语义；
 *   - `fetchedAt`：本次采集时间（成功采集时由调用方写入，D6-D）。
 *
 * 没在 wire 里出现的 id **不会**被静默丢弃——否则模型无法区分
 * 「没有这个渠道」和「这条没取到」。
 */
export function projectUsage(plans, requested, context) {
  const opts = context || {}
  const enabledSet = toSet(opts.enabled)
  const knownSet = toSet(opts.known)
  const semanticsOf = typeof opts.semanticsOf === 'function' ? opts.semanticsOf : () => 'used'
  const list = Array.isArray(plans) ? plans : []
  const byId = {}
  for (const plan of list) {
    if (plan === null || typeof plan !== 'object') continue
    const id = typeof plan.id === 'string' ? plan.id : ''
    if (id.length === 0) continue
    if (byId[id] === undefined) byId[id] = plan
  }
  const ids = Array.isArray(requested) ? requested : []
  const channels = []
  for (const id of ids) {
    // ---- 退场：无论有没有 wire 数据都回受控 unknown ----
    if (isRetiredId(id)) {
      channels.push(skeleton(id, retiredNameOf(id), 'unknown', 'retired-channel'))
      continue
    }
    // ---- 不存在（自定义条目被删除 / id 从未存在）----
    if (knownSet !== null && !knownSet.has(id)) {
      channels.push(skeleton(id, displayNameOf(id), guessKindOf(id), 'not-found'))
      continue
    }
    // ---- 停用：显式点名也不返回旧成功值 ----
    if (enabledSet !== null && !enabledSet.has(id)) {
      channels.push(skeleton(id, displayNameOf(id), guessKindOf(id), 'disabled'))
      continue
    }
    const plan = byId[id]
    if (plan === undefined) {
      channels.push(skeleton(id, displayNameOf(id), guessKindOf(id), 'missing'))
      continue
    }
    const projected = projectPlan(plan, { semantics: semanticsOf(id) })
    if (projected !== null) channels.push(projected)
  }
  return { channels }
}

/** 数组/Set → Set；非数组非 Set 返回 null（表示「不做该维度过滤」）。 */
function toSet(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value.filter((id) => typeof id === 'string'))
  return null
}

function displayNameOf(id) {
  const meta = BUILTIN_META[id]
  if (meta !== undefined) return meta.name
  return '自定义余额'
}

function guessKindOf(id) {
  const meta = BUILTIN_META[id]
  if (meta !== undefined) return meta.kind
  return /^custom:/.test(id) ? 'balance' : 'unknown'
}

/**
 * 生成给模型看的**可读摘要**（`output.render` 用）。
 *
 * 只使用已投影的字段，因此同样不泄露敏感信息。
 * [D6-G] 触发策略时把建议追加在末尾——这是模型**实际可见**的输出。
 */
export function renderUsage(result) {
  const channels = result !== null && result !== undefined && Array.isArray(result.channels)
    ? result.channels
    : []
  if (channels.length === 0) return '当前没有可查询的渠道。'
  const lines = []
  for (const ch of channels) {
    lines.push(formatChannel(ch))
  }
  const policy = result !== null && result !== undefined ? result.policy : null
  if (policy !== null && policy !== undefined && typeof policy.text === 'string' && policy.text.length > 0) {
    lines.push('')
    lines.push(policy.text)
  }
  return lines.join('\n')
}

/** 单行渠道摘要。 */
export function formatChannel(ch) {
  const name = typeof ch.name === 'string' ? ch.name : ch.id
  if (ch.availability === 'error') {
    return name + '：' + (ch.message || '取数失败') + '（' + ch.errorCode + '）'
  }
  if (ch.availability === 'unknown') {
    return name + '：' + (ch.message || '状态未知') + '（' + (ch.errorCode || 'unknown') + '）'
  }
  const parts = []
  if (ch.unlimited === true) {
    parts.push('积分不限量')
  } else if (typeof ch.balance === 'number') {
    if (ch.unit === 'credits') {
      parts.push('积分 ' + formatNumber(ch.balance))
    } else {
      const code = typeof ch.currency === 'string' && ch.currency.length > 0 ? ' ' + ch.currency : ''
      parts.push('余额 ' + formatNumber(ch.balance) + code)
    }
  }
  for (const win of Array.isArray(ch.windows) ? ch.windows : []) {
    if (typeof win.percent === 'number') {
      parts.push(win.scope + ' 剩余 ' + formatNumber(win.percent) + '%')
    }
  }
  if (ch.availability === 'unavailable') parts.push('账户当前不可用')
  if (ch.stale === true) parts.push('（数据可能已过期）')
  return name + '：' + (parts.length > 0 ? parts.join('，') : '无可用数值')
}

/** 数字格式化：整数原样，小数最多两位；负数保留符号。 */
function formatNumber(value) {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}

export { ERROR_TEXT }
