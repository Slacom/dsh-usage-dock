/**
 * 通用「自定义余额渠道」模块（0.9.0 新增，C3）。
 *
 * 范围（用户 2026-10-18 明确）：只做**普通 GET + Authorization: Bearer + JSON 余额**。
 * 不做任何厂商专用适配：没有 Cookie、OAuth、签名、多阶段请求、网页抓取、订阅套餐窗口，
 * 也不按厂商名称套公式。厂商名称只用于显示，不参与身份、不参与凭据解析。
 *
 * 为什么单独成模块（而不是复用 plans/util.js 的 curlJson）：
 *   1. curlJson 有**内置厂商的业务信封规则**（`{code:0}` 成功、`{error:{...}}` 错误），
 *      对任意 URL 套用这些规则会把第三方响应误判成成功/失败；
 *   2. curlJson 会在 fetch 失败后**回落到 Python/curl 后端**——那两条路径绕过了本模块
 *      的 URL/重定向/响应体限制，等于让 SSRF 防护在后端之间不一致；
 *   3. 自定义条目需要按「原始 JSON + HTTP 状态 + 用户选定键」解析，并保留原始状态码
 *      用于错误分类。
 * 因此这里只使用**原生 fetch**（Host 进程内），并自己实现超时、响应体上限与安全校验。
 * 若宿主没有 fetch（理论上 Node 18+ 都有），返回结构化暂时失败而不是换后端。
 *
 * 配置模型（与 index.js 的 Config 对应）：
 *   customBalances: [{ id, name, url, balancePath, subtractPath, currency,
 *                      credentialRef, credentialHost, urlHostConfirmed, enabled }]
 *     —— 只有**公开元数据**，绝不含密钥；
 *   customKeys: { <id>: <apiKey> }  —— 全部是 `role('secret')`：
 *     DSH 的 settings 投影会在任何 remote 读取时剥掉它（dsh-settings 的 redactSecrets），
 *     客户端拿到的是 `secrets: [{path,set}]` 这种存在性标记，而不是值。
 *     Key 走**路径寻址写入**（`customKeys.<id>`），因此只改一条不会抹掉别条的密钥。
 *
 * JSON 键路径语法（C0 冻结，只有这一种）：
 *   字段与数组下标交替，段间用 `.`，下标写 `[n]`，可选的 `$` / `$.` 前缀仅作书写习惯。
 *   `data.balance`、`balance_infos[0].total_balance`、`$.data.items[2].amount`
 *   合法字符：[A-Za-z0-9_$-]；下标：非负十进制整数，≤ PATH_MAX_INDEX；深度 ≤ PATH_MAX_DEPTH。
 *   **不执行任何表达式**：没有通配、过滤器、函数、模板、eval，也不实现完整 JSONPath。
 *   拒绝 `__proto__` / `prototype` / `constructor`（防原型链读取）。
 *
 * 数值语义（C0 冻结）：
 *   接受：有限 JSON number；严格的十进制字符串（可带负号与小数）。
 *   拒绝：null / undefined / 布尔 / 对象 / 数组 / 空串 / NaN / Infinity / 带货币符号的串
 *        / 千分位串 / 科学计数法串 —— 一律按「响应结构错误」处理，**不折算成 0**。
 *   0 有效；负数有效（欠费），不钳成 0。
 *   可选固定扣减：`余额键 − 扣减键`（例如累计额度 − 累计用量）。这是**唯一**的运算，
 *   不按厂商名称自动套用；扣减键缺失/非法同样按结构错误处理，绝不把累计充值当余额。
 */

import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'

// ===========================================================================
// 冻结的上限（C0）。改这些值要同步改文档与测试。
// ===========================================================================

/** 自定义条目数量上限：整批取数有总预算，条目越多单条等待越久。 */
export const MAX_CUSTOM_RECORDS = 12
/** 厂商名称最长字符数（仅显示用）。 */
export const NAME_MAX_LEN = 64
/** 余额 URL 最长字符数。 */
export const URL_MAX_LEN = 512
/** JSON 键路径最长字符数。 */
export const PATH_MAX_LEN = 200
/** 路径最大段数（字段 + 下标都算一段）。 */
export const PATH_MAX_DEPTH = 16
/** 单个数组下标上限。 */
export const PATH_MAX_INDEX = 1000
/** 响应体上限：余额响应都是几百字节，256 KiB 足够且能挡住大响应打满内存。 */
export const MAX_BODY_BYTES = 256 * 1024
/** 单条请求超时。 */
export const REQUEST_TIMEOUT_MS = 10000
/** 整批总预算：必须让 /api/plan-usage 整体留在客户端 40 s 之内。 */
export const BATCH_BUDGET_MS = 20000
/** 同时在飞的条数。 */
export const CONCURRENCY = 3

/** stable id 形态：`custom:<随机串>`。不可由名称推导，改名不改变身份。 */
export const CUSTOM_ID_PATTERN = /^custom:[A-Za-z0-9_-]{6,64}$/

/** 生成一个稳定 id（不依赖名称、时间与顺序）。 */
export function newCustomId() {
  return 'custom:' + randomUUID().replace(/-/g, '').slice(0, 16)
}

// ===========================================================================
// Config schema
// ===========================================================================

/**
 * 自定义余额的配置字段。由 index.js 并入插件 Config。
 *
 * ⚠️ 两个字段都必须 `.volatile()`：DSH 的设置表单**只展示 volatile 字段**。
 * `customKeys` 用 dict（id → secret 字符串）而不是数组项里的 secret 字段，理由：
 *   - 客户端只拿得到「没有 secret 的值」，整数组回写会把别条的 Key 抹掉；
 *   - dict 的路径寻址写入（unset/set 单个 id）能精确增删，不影响其他条目。
 */
export function customSchemaFields() {
  return {
    customBalances: z.array(z.object({
      // id 由客户端生成并持久化；Host 只接受合法形态（见 CUSTOM_ID_PATTERN）。
      id: z.string().default(''),
      /**
       * [0.9.1] 余额来源：宿主里**已配置的模型渠道** id（例如 `packyapi`）。
       *
       * 地址与凭据都从该 provider 的配置派生：
       *   - 地址 ← `providers.<id>.baseURL`；
       *   - 凭据 ← `providers.<id>.apiKeyEnv` 引用的值。
       *
       * 因此这里不再有 `url` / `credentialRef` / `credentialHost` 的用户输入，
       * 也不再需要 `customKeys`。地址来自配置而非外部输入，所以跳过 DNS 私网检查。
       */
      provider: z.string().default(''),
      /** [CP-03] 余额接口**路径**（如 /api/v1/credits）；主机来自 provider。 */
      balanceEndpoint: z.string().default(''),
      name: z.string().default(''),
      /**
       * 以下三项是 **0.9.0 的旧字段**，保留仅为兼容既有配置与既有安全回归：
       * UI 不再提供输入入口，新条目也不会写入。它们不会让用户绕过 provider 模型 ——
       * 当前 UI 只产生带 `provider` 的条目，`url` 由 provider 解析结果覆盖。
       */
      url: z.string().default(''),
      credentialRef: z.string().default(''),
      credentialHost: z.string().default(''),
      urlHostConfirmed: z.string().default(''),
      balancePath: z.string().default(''),
      subtractPath: z.string().default(''),
      currency: z.string().default(''),
      enabled: z.boolean().default(true),
    })).default([]).volatile(),
    customKeys: z.dict(z.string().role('secret')).default({}).volatile(),
    // [W1/W2] 每个自定义条目的**公开**密钥修订号（整数，单调递增，非密）。
    // 与 `customKeys` 写在同一次 mutate 里，用来让客户端确认「Host 已读到这次保存」。
    // 它不含 Key 的任何信息（不是哈希、不可逆推），只表示「这条 secret 被写过几次」。
    customKeyRev: z.dict(z.number()).default({}).volatile(),
  }
}

// ===========================================================================
// JSON 键路径
// ===========================================================================

const PATH_NAME_PATTERN = /^[A-Za-z0-9_$-]+$/
const FORBIDDEN_NAMES = ['__proto__', 'prototype', 'constructor']

/**
 * 解析 JSON 键路径。返回 `{ ok:true, segments }` 或 `{ ok:false, error }`。
 * segments 的元素要么 `{ key }` 要么 `{ index }`，顺序即读取顺序。
 */
export function parseJsonPath(text) {
  if (typeof text !== 'string') return { ok: false, error: 'empty' }
  const raw = text.trim()
  if (raw.length === 0) return { ok: false, error: 'empty' }
  if (raw.length > PATH_MAX_LEN) return { ok: false, error: 'too-long' }

  let body = raw
  if (body.charAt(0) === '$') {
    body = body.slice(1)
    if (body.length > 0) {
      if (body.charAt(0) !== '.') return { ok: false, error: 'syntax' }
      body = body.slice(1)
    }
  }
  if (body.length === 0) return { ok: false, error: 'empty' }

  const segments = []
  let i = 0
  while (i < body.length) {
    // ---- 字段名：读到一个 . 或 [ 为止 ----
    const start = i
    while (i < body.length && body.charAt(i) !== '.' && body.charAt(i) !== '[') i += 1
    const name = body.slice(start, i)
    if (name.length === 0) return { ok: false, error: 'syntax' }
    if (!PATH_NAME_PATTERN.test(name)) return { ok: false, error: 'syntax' }
    if (FORBIDDEN_NAMES.indexOf(name) !== -1) return { ok: false, error: 'forbidden' }
    segments.push({ key: name })
    if (segments.length > PATH_MAX_DEPTH) return { ok: false, error: 'too-deep' }

    // ---- 紧跟的下标：[0][2]… ----
    while (i < body.length && body.charAt(i) === '[') {
      const close = body.indexOf(']', i)
      if (close === -1) return { ok: false, error: 'syntax' }
      const digits = body.slice(i + 1, close)
      // 只认规范十进制：拒绝 01、+1、1e2、空、负号。
      if (!/^(0|[1-9][0-9]*)$/.test(digits)) return { ok: false, error: 'syntax' }
      const index = Number(digits)
      if (!Number.isSafeInteger(index) || index > PATH_MAX_INDEX) return { ok: false, error: 'index-range' }
      segments.push({ index })
      if (segments.length > PATH_MAX_DEPTH) return { ok: false, error: 'too-deep' }
      i = close + 1
    }

    if (i >= body.length) break
    // 段间只允许一个点，且不能以点结尾。
    if (body.charAt(i) !== '.') return { ok: false, error: 'syntax' }
    i += 1
    if (i >= body.length) return { ok: false, error: 'syntax' }
  }
  return { ok: true, segments }
}

/** 路径错误 → 固定中文说明（不拼入用户原始输入以外的任何内容）。 */
const PATH_ERROR_TEXT = {
  empty: 'JSON 键路径不能为空',
  'too-long': 'JSON 键路径过长（上限 ' + PATH_MAX_LEN + ' 字符）',
  'too-deep': 'JSON 键路径层级过深（上限 ' + PATH_MAX_DEPTH + ' 段）',
  syntax: 'JSON 键路径语法无效：只支持字段与 [下标]，例如 data.balance 或 balance_infos[0].total_balance',
  forbidden: 'JSON 键路径包含禁止的字段名（__proto__ / prototype / constructor）',
  'index-range': '数组下标超出允许范围（0–' + PATH_MAX_INDEX + '）',
}

/**
 * 按 segments 读取。只读**对象自身属性**（hasOwnProperty），因此不会命中原型链；
 * 路径本身也会拒绝 `__proto__` 等名字。返回 `{ ok:true, value }` 或 `{ ok:false, reason }`。
 */
export function readJsonPath(data, segments) {
  let node = data
  for (const segment of segments) {
    if (segment.index !== undefined) {
      if (!Array.isArray(node)) return { ok: false, reason: 'type' }
      if (segment.index >= node.length) return { ok: false, reason: 'missing' }
      node = node[segment.index]
    } else {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return { ok: false, reason: 'type' }
      if (!Object.prototype.hasOwnProperty.call(node, segment.key)) return { ok: false, reason: 'missing' }
      node = node[segment.key]
    }
  }
  return { ok: true, value: node }
}

/**
 * 把 JSON 里的值转成余额数字。**不猜测、不兜底**：
 * 只接受有限 number 与严格十进制字符串；其余一律 `{ ok:false }`。
 */
export function numberFromJson(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'type' }
  }
  if (typeof value === 'string') {
    const text = value.trim()
    // 严格十进制：可选负号、无前导零（"0.x" 除外）、可选小数。拒绝 $ / 千分位 / 科学计数法。
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) return { ok: false, reason: 'type' }
    const parsed = Number(text)
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'type' }
  }
  return { ok: false, reason: 'type' }
}

/**
 * 从响应里取余额。可选扣减键是唯一的运算：`余额键 − 扣减键`。
 * 返回 `{ ok:true, value }` 或 `{ ok:false, reason }`：
 *   reason ∈ path | missing | type | subtract-missing | subtract-type
 */
export function extractCustomBalance(data, balancePath, subtractPath) {
  const main = parseJsonPath(balancePath)
  if (!main.ok) return { ok: false, reason: 'path', pathError: main.error }
  let minus = null
  if (typeof subtractPath === 'string' && subtractPath.trim().length > 0) {
    const parsed = parseJsonPath(subtractPath)
    if (!parsed.ok) return { ok: false, reason: 'path', pathError: parsed.error }
    minus = parsed.segments
  }
  const read = readJsonPath(data, main.segments)
  if (!read.ok) return { ok: false, reason: read.reason }
  const mainNumber = numberFromJson(read.value)
  if (!mainNumber.ok) return { ok: false, reason: 'type' }
  let value = mainNumber.value
  if (minus !== null) {
    const readMinus = readJsonPath(data, minus)
    if (!readMinus.ok) return { ok: false, reason: 'subtract-missing' }
    const minusNumber = numberFromJson(readMinus.value)
    if (!minusNumber.ok) return { ok: false, reason: 'subtract-type' }
    value = value - minusNumber.value
    if (!Number.isFinite(value)) return { ok: false, reason: 'type' }
  }
  return { ok: true, value }
}

// ===========================================================================
// 币种
// ===========================================================================

/** 币种只允许 ISO 形态的大写字母代码（2–6 位）或空串（= 未指定）。 */
export function normalizeCurrency(text) {
  if (typeof text !== 'string') return ''
  const code = text.trim().toUpperCase()
  if (code.length === 0) return ''
  if (!/^[A-Z]{2,6}$/.test(code)) return null
  return code
}

// ===========================================================================
// URL 安全
// ===========================================================================

const PRIVATE_HOST_SUFFIXES = [
  '.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp',
]

/** 单个 IPv4 是否属于私网/保留/环回/链路本地/组播（含云元数据 169.254.169.254）。 */
export function isPrivateIpv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (match === null) return false
  const parts = [0, 1, 2, 3].map((i) => Number(match[i + 1]))
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0) return true                        // 0.0.0.0/8
  if (a === 10) return true                       // 私网
  if (a === 127) return true                      // 环回
  if (a === 169 && b === 254) return true         // 链路本地（含 169.254.169.254 云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true           // 192.0.0.0/24 保留
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51) return true          // 文档用
  if (a === 203 && b === 0) return true           // 文档用
  if (a === 100 && b >= 64 && b <= 127) return true // 运营商 NAT
  if (a >= 224) return true                       // 组播 + 保留
  return false
}

/** IPv6 是否属于环回/未指定/唯一本地/链路本地/组播（含 IPv4 映射）。 */
export function isPrivateIpv6(address) {
  let text = String(address).trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (text.length === 0) return true
  if (text === '::' || text === '::1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (mapped !== null) return isPrivateIpv4(mapped[1])
  if (text.startsWith('64:ff9b:')) return true      // NAT64
  if (/^f[cd]/.test(text)) return true              // fc00::/7
  if (/^fe[89ab]/.test(text)) return true           // fe80::/10
  if (/^ff/.test(text)) return true                 // 组播
  const first = text.split(':')[0]
  if (first.length === 0) return true
  const hextet = parseInt(first, 16)
  if (!Number.isInteger(hextet)) return true        // 解析不了就当不安全
  // 只有 2000::/3 是当前分配的全球单播。
  return !(hextet >= 0x2000 && hextet <= 0x3fff)
}

/** 主机名层面的私网判断（字符串检查，DNS 解析在请求前另做一次）。 */
export function isPrivateHostname(host) {
  const name = String(host).trim().toLowerCase().replace(/\.$/, '')
  if (name.length === 0) return true
  if (name === 'localhost') return true
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (name.endsWith(suffix)) return true
  }
  // 单标签主机名（intranet、metadata…）不可能是公网可解析名。
  if (name.indexOf('.') === -1) return true
  return false
}

/** 各协议的默认端口。 */
const DEFAULT_PORTS = { https: '443', http: '80', ws: '80', wss: '443' }

/**
 * 把一组「协议 + 主机名 + 端口」拼成可比较的 origin。
 *
 * [V1] 这里刻意**只接受 hostname（不含端口）**。0.9.0 的 bug 正是把 `URL.host`
 * （已含端口）当成主机名，又追加了一次 `URL.port`，于是 `https://a.example:8443`
 * 被算成 `https://[a.example:8443]:8443`，而普通域名里的冒号又被误判成 IPv6。
 *
 * 规范化规则（前端 `originOfUrl()` 必须与此逐字一致）：
 *   - scheme 小写、去冒号；
 *   - hostname 小写、去末尾点、去掉 IPv6 的方括号后按需补回；
 *   - 端口去前导零；空端口回落协议默认端口；
 *   - **默认端口不写进结果**（`https://a.example:443` → `https://a.example`）；
 *   - 非默认端口显式写出。
 */
export function composeOrigin(scheme, hostname, port) {
  const proto = String(scheme || 'https').toLowerCase().replace(/:$/, '')
  const rawHost = String(hostname || '').trim().toLowerCase()
  if (rawHost.length === 0) return ''
  const bare = rawHost.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (bare.length === 0) return ''
  const isV6 = bare.indexOf(':') !== -1
  const digits = String(port === undefined || port === null ? '' : port).trim()
  let effective = ''
  if (digits.length > 0) {
    if (!/^[0-9]+$/.test(digits)) return ''
    const numeric = Number(digits)
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return ''
    effective = String(numeric) // 去掉前导零
  }
  if (effective.length === 0) effective = DEFAULT_PORTS[proto] || ''
  const showPort = effective.length > 0 && effective !== (DEFAULT_PORTS[proto] || '')
  return proto + '://' + (isV6 ? '[' + bare + ']' : bare) + (showPort ? ':' + effective : '')
}

/**
 * 把 URL 或「已解析目标」规范化为 origin（R5）。
 *
 * 兼容三种输入，且三者结果必须一致：
 *   1. `URL` 实例或 URL 字符串；
 *   2. `{ protocol, hostname, port }`（`validateBalanceUrl()` 的返回值形状）；
 *   3. `{ url }`（自定义条目 / wire 目标的形状）。
 * 返回 `''` 表示无法规范化（调用方按「未确认」处理）。
 */
export function originOf(target) {
  if (target === null || target === undefined) return ''
  if (typeof target === 'string') return originOfUrlString(target)
  if (typeof target === 'object' && target instanceof URL) {
    return composeOrigin(target.protocol, target.hostname, target.port)
  }
  if (typeof target !== 'object') return ''
  // 直接给了 URL 字符串（条目形状）。
  if (typeof target.url === 'string' && target.url.length > 0) {
    const fromUrl = originOfUrlString(target.url)
    if (fromUrl.length > 0) return fromUrl
  }
  // 已解析形状：优先用 hostname（绝不用 host，它可能含端口）。
  const hostname = typeof target.hostname === 'string' && target.hostname.length > 0
    ? target.hostname
    : (typeof target.host === 'string' ? splitHostPort(target.host).hostname : '')
  if (hostname.length === 0) return ''
  const port = typeof target.port === 'string' && target.port.length > 0
    ? target.port
    : (typeof target.host === 'string' && typeof target.hostname !== 'string'
      ? splitHostPort(target.host).port
      : '')
  return composeOrigin(target.protocol || 'https:', hostname, port)
}

/** 拆 `host[:port]`（host 可能是 IPv6 字面量，此时端口在 `]` 之后）。 */
function splitHostPort(authority) {
  const text = String(authority || '').trim()
  if (text.length === 0) return { hostname: '', port: '' }
  if (text.charAt(0) === '[') {
    const close = text.indexOf(']')
    if (close === -1) return { hostname: text, port: '' }
    const hostname = text.slice(0, close + 1)
    const rest = text.slice(close + 1)
    return { hostname, port: rest.charAt(0) === ':' ? rest.slice(1) : '' }
  }
  const colon = text.lastIndexOf(':')
  if (colon === -1) return { hostname: text, port: '' }
  return { hostname: text.slice(0, colon), port: text.slice(colon + 1) }
}

/** URL 字符串 → origin；非法时返回 ''。 */
function originOfUrlString(text) {
  const raw = String(text || '').trim()
  if (raw.length === 0) return ''
  try {
    const parsed = new URL(raw)
    return composeOrigin(parsed.protocol, parsed.hostname, parsed.port)
  } catch (err) {
    // 允许 `https://host:port/path` 之类在旧引擎上解析失败的历史值：只取 authority 部分。
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(raw)
    if (match === null) return ''
    const split = splitHostPort(match[2])
    return composeOrigin(match[1], split.hostname, split.port)
  }
}

/**
 * 把配置里记录的「已确认目标」规范化；兼容旧版本只存裸主机名的写法。
 *
 * [V1] 与 `originOf()` 共用同一套 `composeOrigin`，因此
 * `normalizeOriginField(normalizeOriginField(x)) === normalizeOriginField(x)`（幂等）。
 */
export function normalizeOriginField(field) {
  if (typeof field !== 'string') return ''
  const text = field.trim()
  if (text.length === 0) return ''
  // 旧数据只存 host[:port]：补 https 后按同一套规则规范化。
  if (text.indexOf('://') === -1) {
    const split = splitHostPort(text)
    return composeOrigin('https:', split.hostname, split.port)
  }
  return originOfUrlString(text)
}

const SECRET_QUERY_PATTERN = /(?:^|[_-])(?:api[_-]?key|apikey|key|token|secret|password|passwd|auth|signature|sig)$/i

/**
 * [0.9.1][CP-02][CP-07] 列出**已添加**的模型渠道（用于设置页下拉）。
 *
 * 与旧实现的区别（两条都是审核指出的缺陷）：
 *
 * 1. **CP-02 不再 first-wins**：按行判定归属，同一个 provider id 在多行
 *    声明（或 owner 不同）时标为 `ambiguous`，让用户先去消除重复，
 *    而不是悄悄取第一个可能来自禁用行/别人的配置。
 * 2. **CP-07 不再要求显式 `baseURL`**：预设来源（如 OpenRouter）依赖宿主
 *    目录的默认地址，配置里通常只有 `apiKeyEnv`。这类来源**照样列出**，
 *    并标注其状态（可查/缺地址/需配置 Key），不再静默消失。
 *
 * 另外按用户要求：DeepSeek 与 MiMo 有内置专用通道，**不在**本列表中重复出现；
 * 但它们是按**提供商身份**排除，不是按模型名 —— OpenRouter/PackyAPI 即使
 * 运行 DeepSeek 模型仍然出现。
 *
 * @param {object} configurationList `configEditor.configuration()` 的返回值
 * @returns {Array<{provider, displayName, baseURL, apiKeyEnv, status, reason}>}
 *   `status`: `'ready'`（可查询余额） | `'no-endpoint'` | `'oauth'` | `'not-https'`
 *   `reason`: 面向用户的中文说明（`ready` 时为 `''`）
 */
/**
 * [CP-02 残留][CP-07 残留] 列出**已添加**的模型渠道（设置页下拉的数据源）。
 *
 * 与上一版的区别：**以公开目录为准**。
 *   - 只有目录里存在、且用户在该目录声明的 namespace 里**保存过配置**的来源才列出
 *     （目录里未添加的模板不算"已添加"）；
 *   - 默认地址从目录的 `defaultBaseURL` 取（预设来源的关键路径）；
 *   - 来源可见性与可查询性分开：缺地址/需 OAuth/非 https 各带状态与原因。
 *
 * @param {object} ctx Host ctx
 * @returns {Array<{provider, displayName, baseURL, apiKeyEnv, status, reason, baseURLSource}>}
 */
export function listProviderTargets(ctx) {
  const out = []
  let llm
  try {
    llm = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  } catch (err) {
    llm = undefined
  }
  if (llm === undefined || llm === null || typeof llm.listConfigurableProviders !== 'function') return out
  let catalog
  try { catalog = llm.listConfigurableProviders() } catch (err) { return out }
  if (!Array.isArray(catalog)) return out

  let list = []
  try {
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
    if (editor !== undefined && editor !== null && typeof editor.configuration === 'function') {
      list = editor.configuration()
    }
  } catch (err) { list = [] }

  for (const entry of catalog) {
    if (entry === null || typeof entry !== 'object') continue
    const providerId = typeof entry.provider === 'string' ? entry.provider : ''
    if (providerId.length === 0) continue
    if (isBuiltinBalanceProvider(providerId)) continue
    // 只认目录声明 owner namespace 里**已保存**的配置（未添加的模板不算）。
    const ownerNs = entry.settingsNs
    const ownerRows = Array.isArray(list)
      ? list.filter((row) => {
        const e = row !== null && typeof row === 'object' ? row.entry : null
        if (e === null || e.disabled === true) return false
        const id = e.options !== null && e.options !== undefined ? e.options.id : undefined
        return typeof id === 'string' && id === ownerNs
      })
      : []
    if (ownerRows.length === 0) continue
    if (ownerRows.length > 1) {
      out.push({
        provider: providerId,
        displayName: typeof entry.displayName === 'string' ? entry.displayName : providerId,
        baseURL: '',
        apiKeyEnv: '',
        status: 'no-endpoint',
        reason: '该渠道的配置在多处重复，请先在「设置 → 模型」里消除重复',
        baseURLSource: 'none',
      })
      continue
    }
    /**
     * [P1-1] 列表同样以**已组合有效配置**为准：宿主移除了来源就不该再列出，
     * 否则用户会看到一个"存在但查询必然失败"的渠道。
     */
    const composedRow = composedConfigOf(ownerRows[0])
    const effective = composedRow !== null
      ? readPathFrom(composedRow, entry.settingsPath)
      : readPathConfig(ownerRows[0], entry.settingsPath)
    if (effective === null) continue

    const explicitBase = typeof effective.baseURL === 'string' ? effective.baseURL.trim() : ''
    const catalogBase = typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL.trim() : ''
    const baseURL = explicitBase.length > 0 ? explicitBase : catalogBase
    const baseURLSource = explicitBase.length > 0 ? 'override' : (catalogBase.length > 0 ? 'catalog' : 'none')
    const nativeAuth = entry.nativeAuth !== null && entry.nativeAuth !== undefined && typeof entry.nativeAuth === 'object'
      ? entry.nativeAuth
      : null
    const apiKeyEnv = typeof effective.apiKeyEnv === 'string' && effective.apiKeyEnv.trim().length > 0
      ? effective.apiKeyEnv.trim()
      : (nativeAuth !== null && Array.isArray(nativeAuth.env) && typeof nativeAuth.env[0] === 'string'
        ? nativeAuth.env[0]
        : '')

    let status = 'ready'
    let reason = ''
    if (baseURL.length === 0) {
      status = 'no-endpoint'
      reason = '该渠道没有可用的接口地址，暂时无法查询余额'
    } else {
      let parsed = null
      try { parsed = new URL(baseURL) } catch (err) { parsed = null }
      if (parsed === null) {
        status = 'no-endpoint'
        reason = '该渠道的接口地址不是合法 URL'
      } else if (parsed.protocol !== 'https:') {
        status = 'not-https'
        reason = '该渠道的接口地址不是 https，出于安全考虑不支持查询余额'
      } else if (apiKeyEnv.length === 0) {
        status = nativeAuth !== null ? 'oauth' : 'no-key'
        reason = nativeAuth !== null
          ? '该渠道使用宿主托管认证（OAuth/原生登录），本插件不会把它当作 Bearer Key；如需查询余额请为其配置 API Key'
          : '该渠道还没有配置 API Key'
      }
    }
    out.push({
      provider: providerId,
      displayName: typeof entry.displayName === 'string' && entry.displayName.length > 0
        ? entry.displayName
        : providerId,
      baseURL,
      apiKeyEnv,
      status,
      reason,
      // [CP-08] 前端要能区分「用户覆盖」与「预设默认」。
      baseURLSource,
    })
  }
  return out
}
function isBuiltinBalanceProvider(providerId) {
  const id = String(providerId).toLowerCase()
  // DeepSeek 的内置通道由 deepseek 计划负责（账号余额/API Key 回退）。
  if (id === 'deepseek' || id === 'deepseek-account' || id === 'deepseek-official') return true
  // MiMo 有内置 Cookie 通道。
  if (id === 'mimo' || id === 'xiaomimimo') return true
  return false
}

/**
 * [CP-02] 从配置里定位某 provider 的**唯一 owner**。
 *
 * 之前的实现用 `listProviderTargets()` 的扁平结果再 `find(provider)`：
 * 多条配置行声明同一个 provider id 时，"第一个"胜出 —— 而这可能来自
 * 禁用行、或根本不拥有该 provider 的插件。
 *
 * 现在按「行」检查：同一个 provider id 若在**多个行**里出现（含 owner 不同），
 * 一律判为歧义并拒绝，不做 first-wins。同时跳过已禁用的 Loader 条目。
 *
 * @param {Array} configurationList `configEditor.configuration()` 的返回值
 * @param {string} provider 目标 provider id
 * @returns {{ok:true, row:object, entry:object}|{ok:false, reason:'missing'|'ambiguous'|'disabled'}}
 */
export function findProviderOwner(configurationList, provider) {
  const rows = Array.isArray(configurationList) ? configurationList : []
  const hits = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const entry = row.entry !== null && typeof row.entry === 'object' ? row.entry : null
    if (entry === null) continue
    // 已禁用的 Loader 条目不算"已添加来源"。
    if (entry.disabled === true) continue
    const merged = Object.assign({},
      row.inherited !== null && typeof row.inherited === 'object' ? row.inherited : {},
      row.override !== null && typeof row.override === 'object' ? row.override : {})
    const providers = merged.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue
    if (!Object.prototype.hasOwnProperty.call(providers, provider)) continue
    const raw = providers[provider]
    if (raw === null || typeof raw !== 'object') continue
    hits.push({
      row,
      // owner namespace：哪一行的配置声明了这个 provider（用于歧义判定）。
      owner: entry.options !== null && entry.options !== undefined && typeof entry.options.id === 'string'
        ? entry.options.id
        : '',
      entryId: typeof entry.id === 'string' ? entry.id : '',
      raw,
    })
  }
  if (hits.length === 0) return { ok: false, reason: 'missing' }
  // 同一个 provider 只能有一个 owner 行；多行声明即歧义，拒绝而不是挑第一个。
  const owners = new Set(hits.map((h) => h.owner + '\u0000' + h.entryId))
  if (owners.size > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, row: hits[0].row, raw: hits[0].raw, owner: hits[0].owner }
}

/**
 * [CP-01] 只解析 provider 的凭据值（供工具侧 `identify` 冻结身份用）。
 *
 * 与 `resolveProviderTarget` 的区别：不解析地址、不做 URL 校验，
 * 只回答「这个 provider 现在的凭据是什么」。失败时返回可辨原因。
 *
 * @param {object} ctx Host ctx
 * @param {string} provider provider id
 * @returns {Promise<{ok:boolean, value?:string, ref?:string, error?:string, message?:string}>}
 */
export async function resolveProviderCredential(ctx, provider, balanceEndpoint, budget) {
  const target = await providerSourceOf(ctx, provider)
  if (target.ok !== true) return { ok: false, error: target.error, message: target.message }
  /**
   * [CP-01 残留] 冻结必须包含**完整来源**，不能只有 provider 名。
   *
   * 审核复现：identity 采样解析到 Key A 并把 A 的指纹计入缓存身份，
   * 但快照只留 provider 名；派发时又解析到 Key B 并发出 B 的请求，
   * 于是出现「身份 A、数据 B」，下一次还把 B 的结果当成 A 的缓存命中。
   *
   * 这里把**本次**解析出的余额 URL、origin 一并返回，由调用方整份冻结。
   */
  const built = buildBalanceUrl(target.baseURL, balanceEndpoint)
  if (built.ok !== true) {
    return { ok: false, error: 'config', message: built.message }
  }
  let key = ''
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      /**
       * [CP-05 残留] 凭据解析必须受**同一条绝对预算**约束。
       *
       * 之前这里直接 `await credentials.resolve()`：宿主的凭据服务一旦挂起
       * （外部 secret provider、首次解密等），采样阶段会一直等到自己的超时（约 10 s），
       * 把整批 worker 拖住 —— 传了 `budget` 也没有用。
       */
      const pending = Promise.resolve(credentials.resolve(target.apiKeyEnv))
      let got
      if (budget !== null && budget !== undefined && typeof budget.race === 'function') {
        const raced = await budget.race(pending)
        if (raced === null || typeof raced !== 'object' || raced.ok !== true) {
          return {
            ok: false,
            error: 'network',
            message: '本次刷新未能在预算内完成该条请求，稍后自动重试',
            transient: true,
          }
        }
        got = raced.value
      } else {
        got = await pending
      }
      if (budget !== null && budget !== undefined && budget.expired) {
        return {
          ok: false,
          error: 'network',
          message: '本次刷新未能在预算内完成该条请求，稍后自动重试',
          transient: true,
        }
      }
      if (got !== undefined && got !== null && typeof got.value === 'string') key = got.value
    }
  } catch (err) {
    return {
      ok: false,
      error: 'no-key',
      message: '无法从凭据库读取该渠道的 API Key，请到「设置 → 模型」确认凭据可用',
    }
  }
  if (key.length === 0) {
    return {
      ok: false,
      error: 'no-key',
      message: '该渠道没有可用的 API Key（' + target.apiKeyEnv + '），请到「设置 → 模型」补全',
    }
  }
  return { ok: true, value: key, ref: target.apiKeyEnv, url: built.url, origin: target.origin }
}

/**
 * [CP-02][CP-07] 读取并校验某 provider 的**唯一来源**（地址 + 凭据引用）。
 *
 * 规则：
 *   - 用 `findProviderOwner` 定位唯一 owner 行，歧义/缺失/禁用各自给可辨原因；
 *   - `baseURL` 允许省略：此时用宿主配置目录里的默认地址（CP-07 的预设来源）；
 *   - 只接受 https；
 *   - 不做 DNS 私网检查（地址来自配置）。
 *
 * @param {object} ctx Host ctx
 * @param {string} provider provider id
 * @returns {Promise<object>} `{ok:true, url, apiKeyEnv, origin}` 或 `{ok:false, error, message}`
 */
/**
 * [CP-02 残留] 从宿主**公开目录**读一个 provider 的权威声明。
 *
 * 目录是唯一可信的「这是不是模型来源」的依据：
 *   - 不在目录里 → 不是模型来源（别的插件有同名 `providers` 字段也不认）；
 *   - 目录里有 `settingsNs`/`settingsPath` → 用它定位该来源的配置位置；
 *   - 目录里有 `defaultBaseURL` → 预设来源的默认地址在这里，而不是配置行里。
 *
 * 读不到目录（旧宿主/服务缺失）时**保守拒绝**，不退回"扫配置行猜"。
 */
/**
 * [P1-2] 同步取某 provider **当前生效来源**的指纹（origin + 引用名 + 端点）。
 *
 * 用途：Host 的观察身份要能察觉「同 provider 但模型主机/引用变了」。
 * 这里只读宿主目录与已组合配置（都是同步、本地、无网络），
 * 不解析凭据值、不发请求 —— 身份计算不能有副作用。
 *
 * @param {object} ctx Host ctx
 * @param {string} provider provider id
 * @param {string} balanceEndpoint 该条目填写的余额端点
 * @returns {string} 不可逆短指纹；解析失败时返回可辨标记
 */
export function providerSourceFingerprint(ctx, provider, balanceEndpoint) {
  const catalog = readProviderCatalog(ctx, provider)
  if (catalog.ok !== true) return 'no-catalog'
  let list = []
  try {
    const editor = ctx.get('configEditor')
    if (editor !== undefined && editor !== null && typeof editor.configuration === 'function') {
      list = editor.configuration()
    }
  } catch (err) { return 'no-config' }
  const ownerNs = catalog.entry.settingsNs
  const ownerRows = Array.isArray(list)
    ? list.filter((row) => {
      const e = row !== null && typeof row === 'object' ? row.entry : null
      if (e === null || e.disabled === true) return false
      const id = e.options !== null && e.options !== undefined ? e.options.id : undefined
      return typeof id === 'string' && id === ownerNs
    })
    : []
  if (ownerRows.length === 0) return 'gone'
  if (ownerRows.length > 1) return 'ambiguous'
  const composed = composedConfigOf(ownerRows[0])
  const effective = composed !== null
    ? readPathFrom(composed, catalog.entry.settingsPath)
    : readPathConfig(ownerRows[0], catalog.entry.settingsPath)
  if (effective === null) return 'gone'
  const explicitBase = typeof effective.baseURL === 'string' ? effective.baseURL.trim() : ''
  const baseURL = explicitBase.length > 0
    ? explicitBase
    : (typeof catalog.entry.defaultBaseURL === 'string' ? catalog.entry.defaultBaseURL.trim() : '')
  let origin = ''
  if (baseURL.length > 0) {
    try { origin = new URL(baseURL).origin } catch (err) { origin = 'bad-url' }
  }
  const ref = typeof effective.apiKeyEnv === 'string' && effective.apiKeyEnv.trim().length > 0
    ? effective.apiKeyEnv.trim()
    : ''
  // 用短哈希，避免把主机名/引用名原文留在身份里。
  return digest16([provider, baseURL, origin, ref, String(balanceEndpoint || '')].join('\u0001'))
}
function readProviderCatalog(ctx, provider) {
  let llm
  try {
    llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  } catch (err) {
    llm = undefined
  }
  if (llm === undefined || llm === null || typeof llm.listConfigurableProviders !== 'function') {
    return {
      // [2026-10-21] 宿主缺该服务 = 能力不可用（不是用户配置错），与 not-configured 区分。
      error: 'unavailable',
      message: '当前宿主不提供模型提供商目录，无法确认该渠道的来源；请升级宿主后重试',
    }
  }
  let entries
  try {
    entries = llm.listConfigurableProviders()
  } catch (err) {
    return { ok: false, error: 'config', message: '读取模型提供商目录失败，请稍后重试' }
  }
  if (!Array.isArray(entries)) {
    return { ok: false, error: 'config', message: '模型提供商目录不可用，请稍后重试' }
  }
  const hit = entries.find((entry) => entry !== null && typeof entry === 'object'
    && entry.provider === provider)
  if (hit === undefined) {
    return {
      ok: false,
      error: 'config',
      message: '所选渠道「' + provider + '」不是已登记的模型提供商，请重新选择',
    }
  }
  return { ok: true, entry: hit }
}

/**
 * 按 `settingsPath`（如 `['providers', provider]`）从配置行读该来源的有效配置。
 *
 * 逐层优先 `override`（用户显式保存），再退回 `inherited`（组合层默认）。
 * 返回 `null` 表示该路径下没有任何配置。
 */
/**
 * [P1-1] 取宿主**已组合**的有效配置（Loader 条目上的 `options.config`）。
 *
 * 宿主的组合语义是**整份替换**（`applyEntryPatches`: `target[key] = value`），
 * 所以 `config: {}` 就真的什么都不剩。这份结果才是"用户现在到底有没有这个来源"的
 * 唯一权威答案 —— 不能靠 override 是否非空来猜有没有覆盖。
 *
 * 拿不到时返回 `null`（旧宿主/未配置），由调用方退回逐层读取。
 *
 * @param {object} row `configEditor.configuration()` 的一行
 * @returns {object|null}
 */
function composedConfigOf(row) {
  if (row === null || row === undefined || typeof row !== 'object') return null
  const entry = row.entry !== null && typeof row.entry === 'object' ? row.entry : null
  if (entry === null) return null
  const options = entry.options !== null && entry.options !== undefined && typeof entry.options === 'object'
    ? entry.options
    : null
  if (options === null) return null
  const config = options.config
  if (config === null || config === undefined || typeof config !== 'object') return null
  return config
}

/**
 * 按 `settingsPath` 从一个**已组合**的配置对象里取值。
 *
 * 与 `readPathConfig` 的区别：这里**没有**层间回退 —— 组合结果里没有就是没有。
 *
 * @param {object} composed 已组合的有效配置
 * @param {Array<string>} settingsPath 例如 `['providers', 'openrouter']`
 * @returns {object|null}
 */
function readPathFrom(composed, settingsPath) {
  if (composed === null || composed === undefined || typeof composed !== 'object') return null
  if (!Array.isArray(settingsPath) || settingsPath.length === 0) return null
  let node = composed
  for (const seg of settingsPath) {
    if (node === null || node === undefined || typeof node !== 'object') return null
    node = node[seg]
  }
  if (node === null || node === undefined || typeof node !== 'object') return null
  return node
}
function readPathConfig(row, settingsPath) {
  if (row === null || row === undefined || typeof row !== 'object') return null
  if (!Array.isArray(settingsPath) || settingsPath.length === 0) return null
  const layers = [row.override, row.inherited]
  for (const layer of layers) {
    let node = layer
    let ok = true
    for (const seg of settingsPath) {
      if (node === null || node === undefined || typeof node !== 'object') { ok = false; break }
      node = node[seg]
    }
    if (ok && node !== null && node !== undefined && typeof node === 'object') return node
  }
  return null
}
/** 仅回环主机名（与 plans/workbuddy.js 的 isLoopbackHost 同规则）。 */
function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export async function providerSourceOf(ctx, provider, opts) {
  /**
   * [CP-02 残留][CP-07 残留] **先读公开目录，再读配置**。
   *
   * 之前的实现只从 `configEditor.configuration()` 的行里找 `providers` 形状：
   *   - 任何插件的配置行只要凑巧有 `providers` 字段就被当成模型来源（owner 无法核验）；
   *   - 预设来源的**默认地址**在宿主目录里（`defaultBaseURL`），配置行里没有，
   *     于是 OpenRouter 这类省略 `baseURL` 的来源被误判成"没有可用接口地址"。
   *
   * 现在：
   *   1. `llm.listConfigurableProviders()` 给出**权威目录**（含 settingsNs/settingsPath/defaultBaseURL）；
   *   2. 目录里没有的 provider 一律拒绝（不是模型来源）；
   *   3. 用目录的 `settingsNs` 定位唯一 owner 配置行，再从该行读有效配置；
   *   4. 显式 `baseURL` 优先；省略时才用目录的 `defaultBaseURL`。
   */
  const catalog = readProviderCatalog(ctx, provider)
  if (catalog.ok !== true) return catalog

  let list = []
  try {
    const editor = ctx.get('configEditor')
    if (editor !== undefined && editor !== null && typeof editor.configuration === 'function') {
      list = editor.configuration()
    }
  } catch (err) {
    return { ok: false, error: 'config', message: '无法读取模型渠道配置，请稍后重试' }
  }

  /**
   * 按目录声明的 owner namespace 定位配置行。
   *
   * 目录的 `settingsNs` 就是配置行的 `entry.options.id`（宿主源码可证：
   * `const settingsNs = ctx.fiber.entry?.options.id ?? NS`）。因此只有该 ns 的行
   * 才可能持有这个 provider 的配置 —— 别的插件即使有同名字段也不认。
   */
  const ownerNs = catalog.entry.settingsNs
  const ownerRows = Array.isArray(list)
    ? list.filter((row) => {
      const entry = row !== null && typeof row === 'object' ? row.entry : null
      if (entry === null || entry.disabled === true) return false
      const id = entry.options !== null && entry.options !== undefined ? entry.options.id : undefined
      return typeof id === 'string' && id === ownerNs
    })
    : []
  if (ownerRows.length === 0) {
    return {
      ok: false,
      error: 'config',
      message: '所选模型渠道「' + provider + '」尚未在「设置 → 模型」中保存配置，请先完成配置',
    }
  }
  if (ownerRows.length > 1) {
    return {
      ok: false,
      error: 'config',
      message: '模型渠道「' + provider + '」的配置在多处重复，无法确定唯一来源；请先在「设置 → 模型」里消除重复',
    }
  }

  const row = ownerRows[0]
  /**
   * [CP-02 / P1-1 第三次] 用**宿主已组合的有效配置**读来源，不回退继承层。
   *
   * 审核用宿主原组合器（`applyEntryPatches`：`target[key] = value`，config **整份替换**）
   * 证明：当上层提交 `config: {}` 或 `config: { providers: {} }` 时，**有效配置里没有
   * 该 provider**。旧实现 `readPathConfig` 在 override 路径未命中时退回 `inherited`，
   * 于是宿主已删除的来源被「复活」，插件继续读旧凭据、向旧主机发请求、用旧额度收尾
   * （FAIL_REAL_HOST_CONFIG_REPLACEMENT_REVIVES_REMOVED_SOURCE）。
   *
   * 现在改成：优先读 Loader 条目上**已经组合好**的 `options.config`
   * （那是宿主的权威结果）；只有拿不到时才退回 override/inherited 逐层读取
   * （旧宿主兼容），并且**不再把空 override 当"没有覆盖"**。
   */
  const composed = composedConfigOf(row)
  const effective = composed !== null
    ? readPathFrom(composed, catalog.entry.settingsPath)
    : readPathConfig(row, catalog.entry.settingsPath)
  if (effective === null) {
    return {
      ok: false,
      // [2026-10-21] 与「配置不合法」区分开：这是**尚未配置**，用户补配置即可。
      error: 'not-configured',
      message: '所选模型渠道「' + provider + '」当前没有有效配置（可能已在「设置 → 模型」中被移除），请重新选择或重新配置',
    }
  }

  // 显式覆盖优先；真正省略时才用目录默认地址（预设来源）。
  let baseURL = typeof effective.baseURL === 'string' ? effective.baseURL.trim() : ''
  if (baseURL.length === 0) {
    baseURL = typeof catalog.entry.defaultBaseURL === 'string' ? catalog.entry.defaultBaseURL.trim() : ''
  }
  if (baseURL.length === 0) {
    return {
      ok: false,
      error: 'config',
      message: '该渠道没有可用的接口地址（既未显式配置，宿主目录也没有默认值），暂时无法查询余额',
    }
  }

  /**
   * [CP-07 残留] 认证按宿主公开能力分类，不把「不能复用」误说成「没配置 Key」。
   *
   * `nativeAuth` 是目录声明的原生认证（OAuth/env）；这类来源不能用 Bearer Key 发，
   * 但也不能说用户"没配置"。
   */
  const nativeAuth = catalog.entry.nativeAuth
  const hasNative = nativeAuth !== null && nativeAuth !== undefined && typeof nativeAuth === 'object'
  const apiKeyEnv = typeof effective.apiKeyEnv === 'string' && effective.apiKeyEnv.trim().length > 0
    ? effective.apiKeyEnv.trim()
    // 目录的 env 声明了该来源的标准 Key 环境变量名（预设来源常见）。
    : (Array.isArray(nativeAuth?.env) && typeof nativeAuth.env[0] === 'string' ? nativeAuth.env[0] : '')
  if (apiKeyEnv.length === 0) {
    return {
      ok: false,
      error: hasNative ? 'oauth' : 'no-key',
      message: hasNative
        ? '该渠道使用宿主托管认证（OAuth/原生登录），本插件不会把它当作 Bearer Key 发送；如需查询余额请为其配置 API Key'
        : '该渠道没有可用的 API Key 配置，请在「设置 → 模型」中补全',
    }
  }
  let parsed
  try { parsed = new URL(baseURL) } catch (err) {
    return { ok: false, error: 'config', message: '该渠道的接口地址不是合法 URL' }
  }
  /**
   * [2026-10-21] **显式**的本机回环 HTTP 例外。
   *
   * 只有调用方明确传 `allowLoopbackHttp: true`（目前仅内置 WorkBuddy 网关）时，
   * 才允许 http 且主机必须是回环。通用自定义渠道**不传**这个参数，
   * 因此「只接受 https」的规则对它们完全不变。
   */
  const allowLoopback = opts !== null && opts !== undefined && opts.allowLoopbackHttp === true
  const loopbackOk = allowLoopback && parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)
  if (parsed.protocol !== 'https:' && !loopbackOk) {
    return { ok: false, error: 'config', message: '该渠道的接口地址不是 https，出于安全考虑不支持' }
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: 'config', message: '该渠道的接口地址包含用户名/密码，出于安全考虑不支持' }
  }
  /**
   * [CP-03 定稿] 返回**完整 baseURL**（含路径）与 origin。
   *
   * 用户实测反馈（2026-10-20）：接口地址已经是 `https://openrouter.ai/api/v1`，
   * 却必须把余额路径填成 `/api/v1/credits` 才能用 —— 因为旧实现只用 `origin`
   * 作拼接基准，把 baseURL 里的 `/api/v1` 丢掉了，用户等于要重新写一遍。
   *
   * 现在两段都返回：
   *   - `baseURL` 含路径 → 余额端点**相对它**解析（填 `/credits` 即可）；
   *   - `origin` → 用于「端点已含完整路径」时的回退，以及凭据允许发送的范围。
   */
  return { ok: true, origin: parsed.origin, baseURL, basePath: parsed.pathname, apiKeyEnv }
}

/**
 * [CP-03 定稿] 用「模型接口地址（含路径） + 用户填写的端点」拼出余额 URL。
 *
 * 用户实测反馈（2026-10-20）：接口地址已经是 `https://openrouter.ai/api/v1`，
 * 却**必须**把余额路径填成 `/api/v1/credits` 才能用 —— 旧实现拿 `origin` 当基准，
 * 把 baseURL 里的 `/api/v1` 丢掉了，用户等于要重写一遍路径。这反直觉。
 *
 * 现在的规则（按优先级）：
 *   1. 端点**相对 baseURL 的目录**解析：baseURL=`…/api/v1` + `/credits`
 *      → `…/api/v1/credits`（用户只需填 `/credits`）；
 *   2. 若端点**已经包含** baseURL 的路径段（例如用户按旧习惯填了
 *      `/api/v1/credits`），**不重复拼接**，直接用 → `…/api/v1/credits`
 *      （不会变成 `/api/v1/api/v1/credits`）；
 *   3. 端点带 `..` 越权时，规范化后仍必须留在同一主机内。
 *
 * 安全约束不变：
 *   - 只接受**路径**，不接受完整 URL —— 主机永远来自所选渠道；
 *   - 拒绝协议相对前缀 `//`（会被解析成新主机）。
 *
 * @param {string} baseURL 模型接口地址，如 `https://openrouter.ai/api/v1`
 * @param {string} endpoint 用户填写的端点，如 `/credits` 或 `/api/v1/credits`
 * @returns {{ok:true, url:string}|{ok:false, message:string}}
 */
export function buildBalanceUrl(baseURL, endpoint) {
  const path = typeof endpoint === 'string' ? endpoint.trim() : ''
  if (path.length === 0) {
    return { ok: false, message: '请填写余额接口路径（例如 /credits）' }
  }
  if (path.length > 300) {
    return { ok: false, message: '余额接口路径过长（上限 300 字符）' }
  }
  // 只接受以 / 开头的相对路径；完整 URL 会让主机脱离所选渠道。
  if (!path.startsWith('/')) {
    return { ok: false, message: '余额接口路径必须以 / 开头（例如 /credits），不能填完整网址' }
  }
  if (path.startsWith('//')) {
    return { ok: false, message: '余额接口路径不能以 // 开头（会被解析成另一个主机）' }
  }
  let base
  try { base = new URL(baseURL) } catch (err) {
    return { ok: false, message: '来源地址无效' }
  }
  // baseURL 的路径前缀（去掉末尾斜杠），例如 `/api/v1`。
  const basePath = base.pathname.replace(/\/+$/, '')

  let joined
  try {
    // 规则 2：端点已经以 baseURL 的路径段开头 → 不重复拼接。
    if (basePath.length > 0 && (path === basePath || path.startsWith(basePath + '/'))) {
      joined = new URL(base.origin + path)
    } else {
      /**
       * 规则 1：把端点**接在 baseURL 路径之后**。
       *
       * 不能用 `new URL(path, baseDir)`：那样 `/credits` 会替换掉最后一段
       * （`…/api/v1` + `/credits` → `…/api/credits`），把用户看得见的 `v1` 丢掉。
       * 这里是字符串拼接后再交给 `URL` 规范化，`..` 仍会被正确处理。
       */
      joined = new URL(base.origin + basePath + path)
    }
  } catch (err) {
    return { ok: false, message: '余额接口路径无法解析，请检查格式' }
  }
  // 拼接后主机必须仍是所选渠道（防 `..`/编码绕过）。
  if (joined.origin !== base.origin) {
    return { ok: false, message: '余额接口路径跳出了所选渠道的主机，出于安全考虑拒绝' }
  }
  return { ok: true, url: joined.href }
}

/**
 * 从配置目录条目里取该 provider 的**默认**接口地址。
 *
 * [CP-07] 预设来源（如 OpenRouter）通常不把 baseURL 写进用户配置，
 * 而是依赖宿主目录的默认值。这里读目录条目自带的 `defaultBaseURL`/`baseURL`
 * 字段；读不到就返回空串（由调用方给出可操作提示，不猜）。
 */
function defaultBaseUrlOf(row, provider) {
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) candidates.push(value.trim())
  }
  // 目录条目可能把 provider 信息直接摊在 entry 上，也可能在 row 的其它字段里。
  const sources = [row, row !== null && typeof row === 'object' ? row.entry : null]
  for (const src of sources) {
    if (src === null || typeof src !== 'object') continue
    const providers = src.providers
    if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
      const item = providers[provider]
      if (item !== null && typeof item === 'object') push(item.defaultBaseURL)
    }
    push(src.defaultBaseURL)
    push(src.baseURL)
  }
  return candidates.length > 0 ? candidates[0] : ''
}

/**
 * [0.9.1] 由 provider id 解析出余额请求所需的 URL 与凭据。
 *
 * **地址来自宿主配置，不是用户输入**，所以这里：
 *   - 不再做 DNS 私网检查（fake-ip 代理会命中 198.18/15，而地址本身可信）；
 *   - 也不钉死 IP，交给系统解析 —— 这样代理环境天然可用。
 *
 * 仍然保留的底线：必须 https、不带 userinfo。
 *
 * @param {object} ctx Host ctx
 * @param {string} provider provider id
 * @param {object} budget 绝对预算（凭据解析也要计入）
 * @returns {Promise<object>} 成功 `{ok:true,url,key,ref,origin}`，失败 `{ok:false,error,message}`
 */
async function resolveProviderTarget(ctx, provider, balanceEndpoint, budget) {
  if (budget !== null && budget !== undefined && budget.expired) {
    return { ok: false, error: 'network', message: '本次刷新未能在预算内完成该条请求，稍后自动重试', transient: true }
  }
  const source = await providerSourceOf(ctx, provider)
  if (source.ok !== true) return source
  if (budget !== null && budget !== undefined && budget.expired) {
    return { ok: false, error: 'network', message: '本次刷新未能在预算内完成该条请求，稍后自动重试', transient: true }
  }

  // 用该 provider 的 apiKeyEnv 解析凭据（引用名，不是明文）
  //
  // [CP-05] 凭据解析也必须受**同一条绝对预算**约束：宿主的凭据服务可能挂起
  // （例如外部 secret provider），若无预算收束，单条请求会拖住整批 worker。
  let key = ''
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const pending = Promise.resolve(credentials.resolve(source.apiKeyEnv))
      let got
      if (budget !== null && budget !== undefined && typeof budget.race === 'function') {
        const raced = await budget.race(pending)
        // 超时/取消：不用结果，也不再发请求。
        if (raced === null || typeof raced !== 'object' || raced.ok !== true) {
          return { ok: false, error: 'network', message: '本次刷新未能在预算内完成该条请求，稍后自动重试', transient: true }
        }
        got = raced.value
      } else {
        got = await pending
      }
      if (budget !== null && budget !== undefined && budget.expired) {
        return { ok: false, error: 'network', message: '本次刷新未能在预算内完成该条请求，稍后自动重试', transient: true }
      }
      if (got !== undefined && got !== null && typeof got.value === 'string') key = got.value
    }
  } catch (err) {
    return {
      ok: false,
      error: 'no-key',
      message: '无法从凭据库读取该渠道的 API Key，请到「设置 → 模型」确认凭据可用',
    }
  }
  if (key.length === 0) {
    return {
      ok: false,
      error: 'no-key',
      message: '该渠道没有可用的 API Key（' + source.apiKeyEnv + '），请到「设置 → 模型」补全',
    }
  }
  /**
   * [CP-03] 余额 URL = 来源根 + 用户填写的端点路径。
   *
   * 之前直接返回模型 baseURL，导致「模型根恰好不是余额端点」时必然失败
   * （审核 FAIL_MODEL_BASE_URL_IS_BALANCE_URL）。
   */
  const built = buildBalanceUrl(source.baseURL, balanceEndpoint)
  if (built.ok !== true) {
    return { ok: false, error: 'config', message: built.message }
  }
  return { ok: true, url: built.url, key, ref: source.apiKeyEnv, origin: source.origin }
}

/**
 * 校验余额 URL。返回 `{ ok:true, url, host }` 或 `{ ok:false, error, message }`。
 *
 * 边界（C0）：
 *   - 只允许 https；拒绝 http / file / data / ftp 等；
 *   - 拒绝 URL userinfo（`user:pass@host`）与 fragment；
 *   - 拒绝把凭据放进查询串（key/token/secret/signature…），要求走 Authorization 头；
 *   - 拒绝环回/私网/链路本地/云元数据主机与单标签主机名；
 *   - **默认不跟随重定向**（请求层 redirect:'error'），因此 Authorization 不会被带到新 origin。
 * 残余风险：字符串与 DNS 检查之间仍存在 DNS 重绑定窗口（见 docs 的「已知风险」）。
 */
export function validateBalanceUrl(text, options) {
  const opts = options !== null && options !== undefined ? options : {}
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'empty', message: '余额 API URL 不能为空' }
  }
  const raw = text.trim()
  if (raw.length > URL_MAX_LEN) {
    return { ok: false, error: 'too-long', message: '余额 API URL 过长（上限 ' + URL_MAX_LEN + ' 字符）' }
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch (err) {
    return { ok: false, error: 'syntax', message: '余额 API URL 不是合法 URL（需完整地址，含 https://）' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'protocol', message: '只支持 https:// 余额地址（不接受 http 或其它协议）' }
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: 'userinfo', message: '余额 API URL 不能包含用户名/密码（请把 Key 填到 API Key 字段）' }
  }
  if (parsed.hash.length > 0) {
    return { ok: false, error: 'fragment', message: '余额 API URL 不能包含 #fragment' }
  }
  if (parsed.search.length > 1) {
    const params = parsed.searchParams
    for (const name of params.keys()) {
      if (SECRET_QUERY_PATTERN.test(name)) {
        return { ok: false, error: 'query-secret', message: '不允许把 Key/令牌放在 URL 查询参数里（只支持 Authorization 头）' }
      }
    }
  }
  const host = parsed.hostname.toLowerCase()
  if (host.length === 0) {
    return { ok: false, error: 'host', message: '余额 API URL 缺少主机名' }
  }
  // 端口只允许显式合法值（URL 解析已拒绝越界端口）。
  if (parsed.port.length > 0) {
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { ok: false, error: 'port', message: '余额 API URL 的端口无效' }
    }
  }
  /**
   * [0.9.1] `skipPrivateHostCheck`：地址来自**宿主配置**（用户自己配置、
   * 正在使用的模型服务商）时跳过私网主机名检查。
   *
   * 保留这层检查的原始目的，是挡住"用户被诱导填入内网地址"。
   * 地址不再由用户输入后，该风险消失；而 fake-ip 代理（198.18/15）会被误判，
   * 因此对配置来源的地址放行。
   */
  if (opts.skipPrivateHostCheck !== true) {
    if (host.startsWith('[') || /^[0-9.]+$/.test(host)) {
      const literal = host.replace(/^\[|\]$/g, '')
      if (literal.indexOf(':') !== -1 ? isPrivateIpv6(literal) : isPrivateIpv4(literal)) {
        return { ok: false, error: 'private-host', message: '不允许访问环回/私网/链路本地地址（含云元数据地址）' }
      }
    } else if (isPrivateHostname(host)) {
      return { ok: false, error: 'private-host', message: '不允许访问本机或内网主机名（只允许公网域名）' }
    }
  }
  // [V1] 把「用于比较的 origin」随结果一起返回：调用方不应再从 host/hostname 重新拼，
  // 那正是端口丢失与重复追加的来源。
  const origin = composeOrigin(parsed.protocol, parsed.hostname, parsed.port)
  if (origin.length === 0) {
    return { ok: false, error: 'host', message: '余额 API URL 的主机名无法规范化' }
  }
  return { ok: true, url: parsed.href, host, hostname: parsed.hostname, port: parsed.port, protocol: parsed.protocol, origin }
}

// ===========================================================================
// 目标地址核验（DNS）
// ===========================================================================

const DNS_CACHE_TTL_MS = 60000
const dnsCache = new Map()

/**
 * 默认解析器：用 node:dns 查全部地址。测试可注入（见 fetchCustomBalance 的 options）。
 * 结果缓存 60 s，避免每次轮询都多一次 DNS 往返。
 */
async function defaultResolveHost(host) {
  const now = Date.now()
  const hit = dnsCache.get(host)
  if (hit !== undefined && now - hit.at < DNS_CACHE_TTL_MS) return hit.addresses
  const dns = await import('node:dns/promises')
  const rows = await dns.lookup(host, { all: true, verbatim: true })
  const addresses = rows.map((row) => String(row.address))
  dnsCache.set(host, { at: now, addresses })
  return addresses
}

/** 测试用：清空 DNS 缓存。 */
export function clearDnsCache() {
  dnsCache.clear()
}

/**
 * 核验连接目标：主机名必须解析到**全部**公网地址。
 * 返回 `{ ok:true }` / `{ ok:false, reason:'private'|'dns' }`。
 *
 * ⚠️ 单独调用它只是**预检**，不能作为安全边界：DNS 与真正的 connect 之间仍有一次
 * 重新解析（重绑定窗口）。安全路径必须用 `resolveValidatedAddresses()` 拿到地址列表，
 * 再把它们交给 `makeLookup()` 绑定到本次连接——见 requestJson 的 `target` 参数。
 */
export async function verifyPublicTarget(host, resolveHost) {
  const resolved = await resolveValidatedAddresses(host, resolveHost)
  return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason }
}

/**
 * 解析并核验目标地址（安全修复的核心）。
 *
 * 返回 `{ ok:true, addresses:[{address, family}] }`，其中 addresses 是**已核验为公网**
 * 的全部地址；调用方必须把它们交给 `makeLookup()`，让连接期只使用这份列表，
 * 不再让传输层自己解析一次。这样「检查的 IP」与「连接的 IP」是同一批，
 * DNS 重绑定窗口被消除（除非传输层无视 lookup 约束，见 requestJson 的说明）。
 *
 * 私网/环回/链路本地/云元数据只要有**一个**就整体拒绝（不做「挑公网那个连」的猜测）。
 */
export async function resolveValidatedAddresses(host, resolveHost) {
  const name = String(host || '').replace(/^\[|\]$/g, '')
  if (name.length === 0) return { ok: false, reason: 'private' }
  if (name.indexOf(':') !== -1) {
    return isPrivateIpv6(name)
      ? { ok: false, reason: 'private' }
      : { ok: true, addresses: [{ address: name, family: 6 }] }
  }
  if (/^[0-9.]+$/.test(name)) {
    return isPrivateIpv4(name)
      ? { ok: false, reason: 'private' }
      : { ok: true, addresses: [{ address: name, family: 4 }] }
  }
  let rows
  try {
    rows = await resolveHost(host)
  } catch (err) {
    return { ok: false, reason: 'dns' }
  }
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: 'dns' }
  const addresses = []
  for (const row of rows) {
    const text = String(row)
    const v6 = text.indexOf(':') !== -1
    if (v6 ? isPrivateIpv6(text) : isPrivateIpv4(text)) return { ok: false, reason: 'private' }
    addresses.push({ address: text, family: v6 ? 6 : 4 })
  }
  return { ok: true, addresses }
}

/**
 * 生成一个**只返回已核验 IP** 的 DNS lookup（供 undici / net 的连接期使用）。
 *
 * 这是安全要求的落点：`fetch(..., { dispatcher })` 的 Agent 可以带自定义 `lookup`，
 * 连接时会用我们给的地址而不是重新解析域名，因此「核验过的 IP」= 「实际连接的 IP」。
 *
 * 行为约定（有测试守卫）：
 *   - 忽略调用方传入的 hostname，始终返回构造时的地址列表；
 *   - 支持 `{ all: true }`（返回数组）与 `{ family }`（只返回该族）；
 *   - 若请求的地址族不在列表里，返回 `ENOTFOUND` 而不是回退解析。
 */
export function makeLookup(addresses) {
  const list = (Array.isArray(addresses) ? addresses : [])
    .map((row) => (typeof row === 'string' ? { address: row, family: row.indexOf(':') !== -1 ? 6 : 4 } : row))
    .filter((row) => row !== null && row !== undefined && typeof row.address === 'string')
    .map((row) => ({ address: row.address, family: row.family === 6 ? 6 : 4 }))
  return function boundLookup(_hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : (options || {})
    const cb = typeof options === 'function' ? options : callback
    const wanted = opts.family === 4 || opts.family === 6 ? opts.family : 0
    const usable = wanted === 0 ? list : list.filter((row) => row.family === wanted)
    if (usable.length === 0) {
      const err = new Error('no validated address for requested family')
      err.code = 'ENOTFOUND'
      if (typeof cb === 'function') { cb(err); return }
      throw err
    }
    if (opts.all === true) {
      if (typeof cb !== 'function') throw new Error('lookup requires callback')
      cb(null, usable.map((row) => ({ address: row.address, family: row.family })))
      return
    }
    const first = usable[0]
    if (typeof cb !== 'function') throw new Error('lookup requires callback')
    cb(null, first.address, first.family)
  }
}

// ===========================================================================
// 配置解析（Host 侧）
// ===========================================================================

/**
 * 解包 schemastery 的 volatile 包装（`Object.freeze({ get })`）。
 * Host 半在不带 configEditor 的部署里拿到的是解析后的 Config，volatile 字段是包装对象；
 * 带 configEditor 时拿到的是原始 JSON。两条路径都要能用。
 */
export function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'get' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch (err) {
      return undefined
    }
  }
  return value
}

/**
 * [R7] 把一份配置整体解包成「provider 可直接用」的普通对象。
 *
 * 审查发现：0.9.0 只在读全局/渠道**开关**时解包，传给各 plan 的仍是原始 Config。
 * 于是没有 `configEditor` 的部署里（DSHA / 移动端），`deepseekApiKey` 是一个
 * `{get()}` 包装对象，`resolveApiKey` 的 `typeof raw === 'string'` 判断失败 →
 * 用户明明填了 Key 却被判成 no-key。MiMo 的 Cookie、警告阈值同理。
 *
 * 这里一次性解包**所有**顶层字段（含嵌套数组里的元素），并且：
 *   - 只解包一层 volatile 包装，不深挖包装内部（schemastery 的包装是浅的）；
 *   - `customKeys` 这类 dict 解包后仍是普通对象，值本身是字符串，不做二次处理；
 *   - 未知字段原样保留（旧配置的 glm/kimi 键因此不会丢）。
 */
export function unpackConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return {}
  const out = {}
  for (const key of Object.keys(config)) {
    const raw = config[key]
    const value = unwrapVolatile(raw)
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
        const row = {}
        for (const field of Object.keys(item)) row[field] = unwrapVolatile(item[field])
        return row
      })
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 每一条任务共用的「预算」对象（R1）。
 *
 * 审查发现：0.9.0 只在 `requestJson` 里 race 定时器，而 `credentials.resolve`、
 * DNS 解析、连接、body 读取都在它之前或之外直接 await —— 任一前置阶段挂起，
 * 整批 `Promise.all` 就不会返回，最终把客户端 40 s 预算打穿，连带**所有**渠道一起灰化。
 *
 * 因此这里把预算做成**贯穿全流程的绝对 deadline**：
 *   - `remaining()` 返回剩余毫秒（≤0 表示已过期）；
 *   - `race(promise)` 把任意阶段与「到点」赛跑，过期即返回 `{ expired:true }`；
 *   - `expired` 一旦置位，后续阶段一律**直接返回**，不再发请求（迟到任务不回填）。
 *
 * [V3] 同时给了 `totalMs` 与 `deadlineAt` 时取**两者较小值**：整批把自己的 deadline
 * 传进单条做上限，但单条**不得**因此被放大到整批的 20 秒——否则单条 10 秒（乃至子预算
 * 15 ms）形同虚设。0.9.0 的 bug 正是「只要拿到 deadlineAt 就忽略 totalMs」。
 */
export function createBudget(totalMs, deadlineAt) {
  const now = Date.now()
  const total = typeof totalMs === 'number' && Number.isFinite(totalMs) && totalMs > 0 ? totalMs : REQUEST_TIMEOUT_MS
  let end = now + total
  if (typeof deadlineAt === 'number' && Number.isFinite(deadlineAt)) {
    end = Math.min(end, deadlineAt)
  }
  let expired = false
  const budget = {
    get deadlineAt() { return end },
    get expired() { return expired || Date.now() >= end },
    remaining() { return Math.max(0, end - Date.now()) },
    /** 标记作废：迟到的前置依赖看到这个标记后不得继续。 */
    expire() { expired = true },
    /**
     * 与「到点」赛跑。返回 `{ ok:true, value }` 或 `{ ok:false, reason:'timeout' }`。
     * 注意：超时后底层 promise 仍可能稍后 settle，调用方**必须**检查返回值，
     * 不能继续用它的结果。
     */
    async race(promise) {
      if (budget.expired) return { ok: false, reason: 'timeout' }
      const left = budget.remaining()
      if (left <= 0) { expired = true; return { ok: false, reason: 'timeout' } }
      let timer = null
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => { expired = true; resolve({ ok: false, reason: 'timeout' }) }, left)
      })
      try {
        const raced = await Promise.race([
          Promise.resolve(promise).then((value) => ({ ok: true, value }), (err) => ({ ok: false, reason: 'error', error: err })),
          guard,
        ])
        return raced
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    },
  }
  return budget
}

/** 构造一个「已过期」预算，供测试与不可用路径复用。 */
export function budgetAt(deadlineAt) {
  return createBudget(REQUEST_TIMEOUT_MS, deadlineAt)
}

// ===========================================================================
// 凭据身份指纹（R2）
// ===========================================================================

/**
 * 凭据指纹：把「实际用于请求的那把 Key」折叠成不可逆短哈希。
 *
 * 审查发现：0.9.0 的 `gen` 只纳入 `customKeys` 里**显式保存**的 Key；当用户改用
 * 模型凭据引用时，引用名不变而引用背后的 Key 从 A 换成 B，两次 wire 的 gen 完全相同
 * ——于是 B 返回 500 时，客户端会把 A 的余额当成 B 的「上次成功值」灰化保留。
 *
 * 这里把**实际使用**的 Key（显式或引用解析结果）都折进指纹：
 *   - 只做 SHA-256 截断，不可逆、不可用于爆破（截断后碰撞也不足以还原）；
 *   - 空 Key 用固定标记，与任何真实 Key 的指纹都不同；
 *   - 指纹只进 gen，不进 wire 的其他字段、不进 message、不进日志。
 */
export function credentialFingerprint(key) {
  if (typeof key !== 'string' || key.length === 0) return 'none'
  return createHash('sha256').update('dsh-usage-dock:credential\u0000' + key).digest('hex').slice(0, 12)
}

/**
 * 生成条目代次（R2/R3 的统一身份）。
 *
 * 与旧 `configGeneration` 的差别：**Key 指纹由调用方传入实际使用的值**，
 * 因此「引用解析出的 Key 轮换」「引用被清空」「解析失败」都会改变代次。
 * 失败/无凭据时传入 `''`，代次与任何成功态都不同 —— 客户端据此放弃旧余额。
 */
export function generationOf(fields, keyFingerprint) {
  const parts = [
    String(fields.id || ''),
    /**
     * [CP-04] `provider` 必须进入身份：换来源（Alpha→Beta）就是换账户，
     * 旧余额绝不能被当成新来源的缓存继续驱动收尾。
     */
    String(fields.provider || ''),
    /** [CP-03] 端点路径影响实际请求目标，必须进入身份。 */
    String(fields.balanceEndpoint || ''),
    // provider 模式下 url 由来源解析得出；把它也放进身份，
    // 覆盖「同一 provider 在模型页改了 baseURL」这种来源变化。
    String(fields.url || ''),
    String(fields.balancePath || ''),
    String(fields.subtractPath || ''),
    String(fields.currency || ''),
    String(fields.credentialRef || ''),
    String(fields.credentialHost || ''),
    fields.enabled === true ? '1' : '0',
    String(keyFingerprint || 'none'),
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10)
}

/** 截断 + 去空白；非字符串返回空串。 */
function textOf(value, maxLength) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

// ===========================================================================
// 配置身份协议（W1/W2）
// ===========================================================================
//
// 第三轮复核的核心问题：客户端无法证明「这份 wire 是 Host 用**当前**配置取出来的」。
// 0.9.0 的做法是让客户端记住见过的 gen，于是
//   ① 从没见过 gen 时（首个请求被取消）旧配置 wire 被直接接受（W1）；
//   ② 重复保存同一把 Key 时 gen 不变，脏标记永远拒绝（W2）。
//
// 现在改成**由 Host 自己出证**：
//   - `configDigestOf(cfg)`：把「会影响取数结果的公开配置」折叠成短摘要。
//     Host 用**它实际读到的那份 cfg** 计算并随响应返回；客户端用自己当前保存的配置
//     算同一个摘要，两者一致才认这份数据。
//   - `customKeyRev`：一个**非密**的公开修订计数器（每个自定义条目一个整数），
//     每次写该条目的 secret（**包括写入相同的值**）都 +1，并和 secret 写在同一批 mutate 里。
//     Key 本身不进摘要，但「保存动作发生过」进摘要 —— 所以：
//       * Host 还在用旧缓存 → 修订号旧 → 摘要不匹配 → 拒绝（W1）；
//       * Host 已读到新配置 → 修订号匹配 → 即使 gen 与上一轮相同也接受（W2，幂等写入可恢复）。
// 两者都不泄露 Key、URL 敏感部分或原始响应；修订号只是单调计数器。

/** 单条自定义条目的公开身份（**不含** Key、不含名称）。 */
/**
 * 单条自定义条目的公开身份（**规范化后**，X1）。
 *
 * ⚠️ 这是 Host 与客户端**共用的规范化契约**：客户端 `digestEntryIdentity()` 与此逐字一致。
 * 规则（两边都不能单独改）：
 *   - id / url / balancePath / subtractPath / credentialRef / credentialHost 一律 **trim**，
 *     并按各自上限**截断**（超长输入不会因为截断位置不同而算出不同摘要）；
 *   - credentialHost 再 **toLowerCase**（主机名大小写不敏感）；
 *   - currency 用 `normalizeCurrency`：trim + 大写，非法值归一为空串；
 *   - enabled 归一为 '1'/'0'（缺字段 = 启用）。
 *
 * 为什么必须在这里规范化、而不是「保存时 trim」：既有配置、CLI/YAML 手写值、
 * 真实 Config 解析路径都可能带空格，只在保存路径 trim 无法覆盖它们。
 */
export function entryPublicIdentity(row) {
  if (row === null || row === undefined || typeof row !== 'object') return ''
  const currency = (() => {
    const code = normalizeCurrency(row.currency)
    return code === null ? '' : code
  })()
  return [
    textOf(row.id, 80),
    /**
     * [CP-04] `provider` 参与配置摘要：换来源就是换账户，
     * 否则 Host 的证明与客户端摘要都无法察觉 Alpha→Beta。
     */
    textOf(row.provider, 80),
    // [CP-03] 端点路径改变实际请求目标，必须与客户端摘要同构。
    textOf(row.balanceEndpoint, 300),
    textOf(row.url, URL_MAX_LEN),
    textOf(row.balancePath, PATH_MAX_LEN),
    textOf(row.subtractPath, PATH_MAX_LEN),
    currency,
    textOf(row.credentialRef, 80),
    textOf(row.credentialHost, 200).toLowerCase(),
    row.enabled === false ? '0' : '1',
  ].join('\u0001')
}

/** 读取 `customKeyRev` 里的修订号（容错：非数字按 0）。 */
export function keyRevOf(rawRevs, id) {
  if (rawRevs === null || typeof rawRevs !== 'object' || Array.isArray(rawRevs)) return 0
  const value = rawRevs[id]
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

/**
 * 16 位十六进制配置摘要。
 *
 * ⚠️ 这是**一致性指纹**，不是安全摘要：它只回答「Host 读到的配置」与
 * 「客户端当前保存的配置」是不是同一份。伪造它没有意义——对手要改的是 Host
 * 实际读到的配置本身；而真正的秘密（Key）从不进入这个输入。
 *
 * 之所以不用 SHA-256：浏览器侧渲染期没有同步的 SHA-256（`crypto.subtle` 是异步的），
 * 两端必须能算**同一个值**。因此统一用 FNV-1a 64 位双通道，客户端
 * `dshDigest16()` 与此逐字一致（有测试守卫）。
 */
function digest16(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    h1 = (h1 ^ c) >>> 0
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0
    h2 = (h2 ^ (c + i)) >>> 0
    h2 = (h2 + ((h2 << 1) + (h2 << 4) + (h2 << 7) + (h2 << 8) + (h2 << 24))) >>> 0
  }
  const a = ('00000000' + h1.toString(16)).slice(-8)
  const b = ('00000000' + h2.toString(16)).slice(-8)
  return a + b
}

/**
 * 配置摘要：Host 与客户端用**同一套规则**计算，因此可以直接比较。
 *
 * 输入可以是整份配置（含 `customBalances` / `customKeyRev`）或 `{ customBalances, customKeyRev }`
 * 形状的普通对象。顺序敏感（条目顺序影响显示顺序，改顺序确实是一次配置变化）。
 */
export function configDigestOf(cfg) {
  const list = unwrapVolatile(cfg != null ? cfg.customBalances : undefined)
  const revs = unwrapVolatile(cfg != null ? cfg.customKeyRev : undefined)
  const rows = Array.isArray(list) ? list : []
  const parts = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = textOf(row.id, 80)
    if (!CUSTOM_ID_PATTERN.test(id) || seen.has(id)) continue
    seen.add(id)
    parts.push(entryPublicIdentity(row) + '\u0002' + String(keyRevOf(revs, id)))
  }
  // 修订号存在但条目已删：仍要参与摘要，否则「删除后 Host 还回旧条目」会被当成一致。
  if (revs !== null && typeof revs === 'object' && !Array.isArray(revs)) {
    const orphan = Object.keys(revs).filter((id) => !seen.has(id)).sort()
    for (const id of orphan) parts.push('orphan:' + id + '\u0002' + String(keyRevOf(revs, id)))
  }
  return digest16(parts.join('\u0003'))
}

/**
 * 生成「这次响应的配置证明」。
 *
 * `reloadable` 表示本部署是否有 `configEditor`（能热重读配置）。为 false 时客户端知道
 * 只能等重启，不会误以为是「再等 2 秒就好」。
 */
export function configProofOf(cfg, extra) {
  const opts = extra || {}
  return {
    digest: configDigestOf(cfg),
    readAt: typeof opts.readAt === 'number' ? opts.readAt : Date.now(),
    reloadable: opts.reloadable === true,
  }
}

/**
 * 配置代次（兼容旧调用点）：只按**显式保存**的 Key 计算。
 *
 * ⚠️ 它**不**足以表达「模型凭据引用背后的 Key 轮换」——那种情况必须走
 * `generationOf(fields, credentialFingerprint(实际Key))`。这里保留旧名是为了
 * 不破坏既有测试与外部调用；请求路径已经改用 `generationOf`。
 */
export function configGeneration(fields) {
  return generationOf(fields, credentialFingerprint(fields.key))
}

/**
 * 把配置里的 customBalances / customKeys 归一化成条目列表（**含密钥**，仅 Host 内部使用）。
 * 非法 id 的条目被跳过（客户端保存前已校验，这里只兜手改 YAML 的情况）；
 * 重复 id 保留第一条。数量超过 MAX_CUSTOM_RECORDS 的尾部条目被忽略。
 *
 * [CP-06] 是否采纳「没有 `provider` 的旧条目」由 `opts.allowLegacy` 决定：
 *   - 生产取数入口（`fetchCustomPlans` / GUI 路由 / 工具编排）**不传**该选项，
 *     旧条目因此不会在后台继续查旧地址，与「升级后需重新选择来源」一致；
 *   - 底层安全回归（DNS/重定向/预算/连接绑定/摘要协议）需要能直接构造条目，
 *     它们显式传 `allowLegacy: true`，走的是**同一条**代码路径。
 *
 * 这样「生产不采纳」与「函数仍可被测试使用」不矛盾，也不需要在生产里留隐形通道。
 *
 * @param {object} cfg 已解包的配置
 * @param {object} [opts] `{ allowLegacy: boolean }`
 */
export function collectCustomEntries(cfg, opts) {
  const allowLegacy = opts !== null && opts !== undefined && opts.allowLegacy === true
  const rawList = unwrapVolatile(cfg != null ? cfg.customBalances : undefined)
  const rawKeys = unwrapVolatile(cfg != null ? cfg.customKeys : undefined)
  const keyMap = rawKeys !== null && typeof rawKeys === 'object' && !Array.isArray(rawKeys) ? rawKeys : {}
  const list = Array.isArray(rawList) ? rawList : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (out.length >= MAX_CUSTOM_RECORDS) break
    const id = textOf(item.id, 80)
    if (!CUSTOM_ID_PATTERN.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    /**
     * [0.9.1] 自定义渠道不再由用户填写 URL / Key / 引用。
     *
     * `provider` 指向**宿主里已配置的模型渠道**（例如 `packyapi`）。
     * 地址与凭据都从该 provider 的配置派生，用户不能手输 —— 这是安全边界：
     * 地址不再是外部输入，因此无需再做 DNS 私网检查与 IP 钉死。
     *
     * [CP-06] 没有 `provider` 的旧条目**默认跳过**，与「升级后需重新选择来源」的
     * 迁移说明保持一致；`allowLegacy` 只给测试/兼容路径用。
     */
    const provider = textOf(item.provider, 80)
    if (provider.length === 0 && !allowLegacy) continue
    const entry = {
      id,
      provider,
      // [CP-03] 余额接口路径（主机来自 provider，用户只填路径）。
      balanceEndpoint: textOf(item.balanceEndpoint, 300),
      name: textOf(item.name, NAME_MAX_LEN) || '未命名渠道',
      // 旧条目保留 url；provider 模式下由 resolveProviderTarget 覆盖。
      url: textOf(item.url, URL_MAX_LEN),
      balancePath: textOf(item.balancePath, PATH_MAX_LEN),
      subtractPath: textOf(item.subtractPath, PATH_MAX_LEN),
      currency: (() => {
        const code = normalizeCurrency(item.currency)
        return code === null ? '' : code
      })(),
      // 凭据：provider 模式由 apiKeyEnv 解析；旧条目保留原有引用字段。
      credentialRef: textOf(item.credentialRef, 80),
      credentialHost: textOf(item.credentialHost, 200).toLowerCase(),
      urlHostConfirmed: textOf(item.urlHostConfirmed, 200).toLowerCase(),
      enabled: item.enabled !== false,
      key: typeof keyMap[id] === 'string' && keyMap[id].length > 0 ? keyMap[id] : '',
    }
    entry.gen = configGeneration(entry)
    out.push(entry)
  }
  return out
}

// ===========================================================================
// 请求
// ===========================================================================

/** 读取响应体，硬上限 MAX_BODY_BYTES（先看 content-length，再限流读取）。 */
export async function readLimitedBody(response) {
  if (response === null || typeof response !== 'object') return { ok: false, reason: 'empty' }
  const headers = response.headers
  if (headers !== null && typeof headers === 'object' && typeof headers.get === 'function') {
    const declared = headers.get('content-length')
    if (declared !== null && declared !== undefined) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' }
    }
  }
  const body = response.body
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done === true) break
        const chunk = step.value
        total += chunk != null && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0
        if (total > MAX_BODY_BYTES) {
          try { await reader.cancel() } catch (err) { /* 已断开就算 */ }
          return { ok: false, reason: 'too-large' }
        }
        chunks.push(chunk)
      }
    } catch (err) {
      return { ok: false, reason: 'unreadable' }
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, text: new TextDecoder('utf-8').decode(merged) }
  }
  if (typeof response.text !== 'function') return { ok: false, reason: 'unreadable' }
  let text
  try {
    text = await response.text()
  } catch (err) {
    return { ok: false, reason: 'unreadable' }
  }
  if (typeof text !== 'string') return { ok: false, reason: 'unreadable' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' }
  return { ok: true, text }
}

/**
 * 发一次 GET。返回 `{ kind:'response', status, body }` 或 `{ kind:'network', detail }`。
 * **不跟随重定向**：redirect:'error'，Authorization 不会流到新 origin。
 *
 * 超时是**请求层**保证的：除了给 fetch 传 AbortSignal（合作良好的传输层会立刻断开），
 * 还额外 race 一个定时器——若底层 transport 不理会 signal（某些裁剪运行时、被替换的
 * 全局 fetch、测试桩），整批也不会被一条挂起的请求拖死。慢的那次请求随后自行结束，
 * 其结果被丢弃（race 已 settle）。若 `options.budget` 存在，超时取它的剩余时间。
 *
 * **连接绑定（安全问题）**：当 `options.target` 带 `addresses` 时，这里会
 *   ① 生成 `lookup = makeLookup(addresses)`，让连接期只连**已核验**的 IP；
 *   ② 在 init 上带 `servername`（真实主机名）以保证 TLS SNI/证书校验仍按域名进行；
 *   ③ 尝试给原生 fetch 装一个带 `lookup` 的 undici Agent（`connect.lookup`）。
 * 三条一起构成「检查的 IP = 连接的 IP」，消除 DNS 重绑定窗口。
 * 若运行环境拿不到 undici（裁剪 WebView），`init.lookup` 仍然带着约束——
 * 传输层支持就用，不支持则由调用方按「无法保证连接目标」保守降级（见 fetchCustomBalance）。
 */
export async function requestJson(url, key, options) {
  const opts = options || {}
  const budget = opts.budget instanceof Object && typeof opts.budget.remaining === 'function' ? opts.budget : null
  let timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : REQUEST_TIMEOUT_MS
  if (budget !== null) timeoutMs = Math.min(timeoutMs, budget.remaining())
  if (!(timeoutMs > 0)) return { kind: 'network', detail: 'timeout' }

  // ---- 连接期绑定（安全问题） ----
  // target.addresses 是**已核验为公网**的地址列表。有它时：
  //   ① 默认传输换成 node:https，并把 `lookup` 钉死在这份列表上——
  //      连接期不再解析域名，「检查的 IP」就是「连接的 IP」，重绑定窗口消失；
  //   ② `servername` 仍是真实域名，TLS SNI 与证书校验不回退成 IP；
  //   ③ 不跟随重定向（node:https 本来就不跟随，3xx 作为状态码返回）。
  // 拿不到 node:https（非 Node 运行时）时**不静默降级**：返回 unbound，
  // 由调用方按「无法保证连接目标」保守拒绝（绝不把 Key 发到未核验的目标）。
  const target = opts.target !== null && typeof opts.target === 'object' ? opts.target : null
  const addresses = target !== null && Array.isArray(target.addresses) ? target.addresses : null
  const wantsBinding = addresses !== null && addresses.length > 0

  let transport = typeof opts.transport === 'function' ? opts.transport : null
  let transportIsBinding = false
  if (transport === null) {
    if (wantsBinding) {
      const pinned = await pinnedHttpsTransport()
      if (pinned === null) return { kind: 'network', detail: 'unbound' }
      transport = pinned
      transportIsBinding = true
    } else {
      transport = typeof fetch === 'function' ? fetch : null
    }
  }
  if (transport === null) return { kind: 'network', detail: 'no-fetch' }

  let controller = null
  let signal
  if (typeof AbortController === 'function') {
    controller = new AbortController()
    signal = controller.signal
  }
  // [Z2] 外部取消（模型工具被 abort / 超出预算）要立刻中断本次传输。
  let detachAbort = null
  const external = opts.signal !== null && opts.signal !== undefined
    && typeof opts.signal.addEventListener === 'function'
    ? opts.signal
    : null
  if (external !== null) {
    if (external.aborted === true) return { kind: 'network', detail: 'aborted' }
    if (controller !== null) {
      const onAbort = () => { try { controller.abort() } catch (err) { /* 已中止 */ } }
      external.addEventListener('abort', onAbort, { once: true })
      detachAbort = () => {
        if (typeof external.removeEventListener === 'function') external.removeEventListener('abort', onAbort)
      }
    }
  }
  let timer = null
  const headers = { accept: 'application/json' }
  if (typeof key === 'string' && key.length > 0) headers.authorization = 'Bearer ' + key
  // 连接约束对**所有**传输层都可见（注入的测试传输层也能断言并自行遵守）。
  const withBinding = wantsBinding ? {
    lookup: makeLookup(addresses),
    servername: target !== null && typeof target.host === 'string' ? target.host : undefined,
    // 仅供测试/受控宿主指定**额外信任的 CA**；绝不设置 rejectUnauthorized:false，
    // 也不接受从用户配置里传入的 CA（schema 不暴露该字段）。
    ca: opts.tlsCa,
  } : null
  const init = { method: 'GET', headers, redirect: 'error' }
  if (signal !== undefined) init.signal = signal
  if (withBinding !== null) {
    init.lookup = withBinding.lookup
    init.servername = withBinding.servername
    if (withBinding.ca !== undefined) init.ca = withBinding.ca
  }

  const work = (async () => {
    const response = await transport(url, init)
    const status = response !== null && typeof response === 'object' && typeof response.status === 'number'
      ? response.status
      : 0
    const body = await readLimitedBody(response)
    return { kind: 'response', status, body }
  })()

  // 兜底超时：即使 transport 不响应 abort，也在 timeoutMs 后 settle。
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller !== null) {
        try { controller.abort() } catch (err) { /* 已断开就算 */ }
      }
      resolve({ kind: 'network', detail: 'timeout' })
    }, timeoutMs)
  })

  try {
    return await Promise.race([work, guard])
  } catch (err) {
    const name = err !== null && typeof err === 'object' && typeof err.name === 'string' ? err.name : ''
    if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'network', detail: 'timeout' }
    // redirect:'error' 的真实原因藏在 cause 里（undici：TypeError('fetch failed')
    // + cause Error('unexpected redirect')），顶层消息完全没有 "redirect" 字样。
    // 因此这里检查整条 cause 链——否则会被误报成「网络不可达」，把用户引向排查网络。
    const seen = []
    let node = err
    let code = ''
    for (let depth = 0; node !== null && node !== undefined && depth < 4; depth += 1) {
      seen.push(String(node.name || ''), String(node.message || ''), String(node.code || ''))
      if (code.length === 0 && typeof node.code === 'string' && node.code.length > 0) code = node.code
      node = typeof node === 'object' ? node.cause : null
    }
    const joined = seen.join(' ')
    if (/redirect/i.test(joined)) return { kind: 'network', detail: 'redirect' }
    if (/abort|timeout|timed ?out/i.test(joined)) return { kind: 'network', detail: 'timeout' }
    // 证书类错误单独归类：这不是「网络不通」，用户该检查的是证书/中间设备。
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(joined + ' ' + code)) {
      return { kind: 'network', detail: 'tls', code }
    }
    return { kind: 'network', detail: 'transport', code }
  } finally {
    if (timer !== null) clearTimeout(timer)
    // [Z2] 解绑外部取消监听，避免请求结束后仍持有调用方 signal。
    if (typeof detachAbort === 'function') detachAbort()
  }
}

/**
 * 缓存的 `node:https` 模块加载器（V4）。
 *
 * 0.9.0 的 bug：先把 `httpsProbed = true` 再 `await import()`，于是**同一轮冷启动**里的
 * 第二个并发调用直接拿到尚未赋值的 `httpsModule`（undefined），随后读 `https.request`
 * 抛 `TypeError: Cannot read properties of undefined`。默认并发是 3，多个自定义渠道
 * 首次轮询就会偶发「获取失败」。
 *
 * 修法：缓存**同一个 Promise**，所有调用都 await 它；不可用时统一解析为 null
 * （调用方据此返回受控的 `unbound`），绝不在初始化中途暴露 undefined。
 */
let httpsPromise = null

function loadHttps() {
  if (httpsPromise === null) {
    httpsPromise = Promise.resolve()
      .then(() => import('node:https'))
      .then((mod) => (mod !== null && mod !== undefined && typeof mod.request === 'function' ? mod : null))
      .catch(() => null)
  }
  return httpsPromise
}

/**
 * 构造「连接期只连已核验 IP」的 HTTPS 传输层。
 *
 * 为什么不用 fetch：undici 的 `connect.lookup` 只有拿到 undici 模块才用得上，
 * 而多数部署里它不可 import——那等于**静默失去绑定**。`node:https` 的 `lookup`
 * 选项是稳定的公开 API，因此这里用它作为默认传输层，保证绑定真的生效：
 *   - `lookup` 只返回已核验地址（不重新解析域名）；
 *   - `servername` 保持真实域名（TLS SNI + 证书校验按域名进行，绝不用 IP）；
 *   - `agent:false` 不复用连接（避免 keep-alive 句柄滞留）；
 *   - 不跟随重定向（3xx 原样作为状态返回）。
 * 拿不到 node:https 时返回 null，调用方据此保守拒绝而不是继续发送凭据。
 */
async function pinnedHttpsTransport() {
  const https = await loadHttps()
  if (https === null || typeof https.request !== 'function') return null
  return function httpsBound(url, init) {
    return new Promise((resolve, reject) => {
      let parsed
      try {
        parsed = new URL(url)
      } catch (err) {
        reject(err)
        return
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error('pinned transport requires https'))
        return
      }
      const options = {
        host: parsed.hostname,
        port: parsed.port.length > 0 ? Number(parsed.port) : 443,
        path: parsed.pathname + parsed.search,
        method: init !== null && typeof init === 'object' && typeof init.method === 'string' ? init.method : 'GET',
        headers: init !== null && typeof init === 'object' ? init.headers : undefined,
        lookup: init !== null && typeof init === 'object' ? init.lookup : undefined,
        // TLS：按真实域名握手与校验证书；绝不关闭 rejectUnauthorized。
        servername: init !== null && typeof init === 'object' && typeof init.servername === 'string'
          ? init.servername
          : parsed.hostname,
        agent: false,
      }
      // 额外信任的 CA（仅测试/受控宿主传入）；**不**关闭证书校验。
      if (init !== null && typeof init === 'object' && init.ca !== undefined) options.ca = init.ca
      if (init !== null && typeof init === 'object' && init.signal !== undefined) options.signal = init.signal
      const req = https.request(options, (res) => { resolve(makeStreamResponse(res)) })
      req.on('error', reject)
      req.end()
    })
  }
}

/**
 * 把 node:https 的 IncomingMessage 包成 readLimitedBody 认得的形状。
 *
 * [V5] 两个关键点（0.9.0 都错了）：
 *   1. **流错误必须透传**。旧实现把 `iterator.next()` 的异常 catch 成 `{done:true}`，
 *      于是 `ECONNRESET` / `aborted` / `premature close` 都变成「正常 EOF」，
 *      上层无法区分「读完」和「断了」。
 *   2. **必须校验响应完整性**。即便前缀恰好是合法 JSON，只要 `res.complete === false`
 *      （服务端声明的 Content-Length 没发够、chunked 未终止、连接中途断开），
 *      就是**不完整的 HTTP 响应**，不能当成功数据。
 */
function makeStreamResponse(res) {
  const headers = {
    get(name) {
      const value = res.headers[String(name).toLowerCase()]
      if (value === undefined) return null
      return Array.isArray(value) ? value.join(', ') : String(value)
    },
  }
  return {
    status: typeof res.statusCode === 'number' ? res.statusCode : 0,
    headers,
    body: {
      getReader() {
        // 复用**同一个** async iterator：每次 read 新建一个会在某些 Node 版本上
        // 把后续 chunk 丢掉（Readable 的 asyncIterator 行为随版本有差异）。
        const iterator = res[Symbol.asyncIterator]()
        let finished = false
        return {
          async read() {
            if (finished) return { done: true, value: undefined }
            // 不 catch：让 ECONNRESET / aborted / premature close 冒泡到 readLimitedBody，
            // 由它归类为 unreadable，而不是伪装成「读完了」。
            const step = await iterator.next()
            if (step.done === true) {
              finished = true
              // 读到 EOF 之后还要看这次响应是否**完整**。
              if (res.complete === false) {
                throw new Error('incomplete response body (premature close)')
              }
              return { done: true, value: undefined }
            }
            return { done: false, value: step.value }
          },
          async cancel() {
            finished = true
            try { res.destroy() } catch (err) { /* 已断开 */ }
          },
        }
      },
    },
  }
}

// ===========================================================================
// 错误分类
// ===========================================================================

/**
 * HTTP 状态 → 固定错误码。语义错误（需用户动手）不带 transient，客户端立即提示、
 * 不拿旧值顶着；暂时错误带 transient:true，客户端保留旧值并灰化，连续 8 次才转纯错误。
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 403) {
    return { error: 'auth', transient: false, message: '鉴权失败（上游返回 HTTP ' + status + '）：请检查 API Key 或凭据引用' }
  }
  if (status === 408 || status === 425 || status === 429) {
    return { error: 'rate-limit', transient: true, message: '上游限流或请求超时（HTTP ' + status + '），稍后自动重试' }
  }
  if (status >= 500) {
    return { error: 'server', transient: true, message: '上游服务暂时不可用（HTTP ' + status + '）' }
  }
  if (status >= 300 && status < 400) {
    return { error: 'endpoint', transient: false, message: '余额接口返回重定向（HTTP ' + status + '）：本插件不跟随重定向，请改用最终地址' }
  }
  if (status === 400 || status === 404 || status === 405 || status === 406 || status === 415 || status === 422) {
    return { error: 'endpoint', transient: false, message: '余额接口地址或参数不正确（HTTP ' + status + '）：请检查 URL 路径' }
  }
  return { error: 'endpoint', transient: false, message: '余额接口返回 HTTP ' + status + '：请检查 URL' }
}

/** 结构错误（2xx 但读不到有效余额）的固定文案。 */
function structureMessage(reason) {
  if (reason === 'missing') return '响应中未找到该 JSON 键路径：请检查键路径是否与上游响应一致'
  if (reason === 'type') return '响应中该键的类型不是有效数值：请确认取的是余额字段'
  if (reason === 'subtract-missing') return '扣减键在响应中不存在：请检查「扣减键」配置'
  if (reason === 'subtract-type') return '扣减键的值不是有效数值：请检查「扣减键」配置'
  if (reason === 'path') return 'JSON 键路径配置无效：请在设置页修正'
  return '响应中未找到有效余额：请检查 JSON 键路径'
}

// ===========================================================================
// 取数
// ===========================================================================

/** 组装 wire 结果：只放白名单字段，绝不带 Key/URL/原始响应。 */
function wireOf(entry, extra) {
  const base = {
    id: entry.id,
    name: entry.name,
    custom: true,
    gen: entry.gen,
    currency: entry.currency,
  }
  return Object.assign(base, extra)
}

/**
 * 取一条自定义余额。签名与其他渠道一致，额外接受 options（测试注入 transport/resolveHost）。
 *
 * 安全顺序：先校验配置（路径/URL/币种）→ 再解析凭据 → 再核验 DNS 目标 → 才发请求。
 * 因此「配错 URL」不会把任何 Key 发出去。
 *
 * [R1/R2/R5] 三个与 0.9.0 不同的关键点：
 *   1. **预算贯穿全流程**：凭据解析、DNS、连接、body 都走 `budget.race`；
 *      过期后立即返回结构化失败，且**不再发请求**（迟到的依赖不会回填）；
 *   2. **代次用实际 Key**：`gen` 在拿到真正要发送的 Key 之后才计算，
 *      因此引用轮换/清空/解析失败都会换 gen（旧账户余额不会被当成本账户的旧值）；
 *   3. **显式 Key 同样受目标绑定约束**：不只引用分支——任何「已保存的 Key」在目标
 *      origin 未经用户确认时都零请求返回 `credential-unconfirmed`。
 */
export async function fetchCustomBalance(ctx, shell, cfg, entryInput, options) {
  const opts = options || {}
  const budget = opts.budget instanceof Object && typeof opts.budget.race === 'function'
    ? opts.budget
    : createBudget(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : REQUEST_TIMEOUT_MS)

  /**
   * [0.9.1] 解析 provider 派生信息。
   *
   * 自定义渠道不再由用户填写 URL / Key：`entry.provider` 指向宿主里已配置的
   * 模型渠道，地址取它的 `baseURL`，Key 取它的 `apiKeyEnv` 引用。
   *
   * 因此这里先把 entry 补成"带 url 与 key"的形态，后续逻辑（路径解析、
   * 请求、错误分类）完全复用，不做第二套实现。
   */
  /** [CP-01 残留] 冻结快照要在 provider 解析之前读取（解析分支会用到它）。 */
  const frozenMap = opts.credentialSnapshot !== null && opts.credentialSnapshot !== undefined
    && typeof opts.credentialSnapshot === 'object' && !Array.isArray(opts.credentialSnapshot)
    ? opts.credentialSnapshot
    : null

  let entry = entryInput
  // Host 可同步撤销本条操作；库的独立调用未传守卫时保持原合同。
  const operationCurrent = () => {
    if (opts.isCurrentOperation === undefined) return true
    try { return typeof opts.isCurrentOperation === 'function' && opts.isCurrentOperation(entry.id) === true } catch (err) { return false }
  }
  const operationCancelled = () => wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
    error: 'cancelled', cancelled: true, transient: false, stale: true,
    message: '本次采集已被更新的操作取代',
  })
  if (!operationCurrent()) return operationCancelled()
  if (entry !== null && entry !== undefined && typeof entry.provider === 'string' && entry.provider.length > 0) {
    /**
     * [CP-01 残留] **优先使用已冻结的完整来源**，不再二次解析。
     *
     * 工具调用时 `identify` 已经把「provider + 余额 URL + 引用 + 本次凭据值」整份冻结，
     * 缓存身份也是按那份算的。若这里重新解析，两次读到的 Key 不同就会出现
     * 「身份 A、数据 B」。因此冻结存在时直接采用，只有未冻结（GUI 路径）才解析。
     */
    const frozenSource = frozenMap !== null && Object.prototype.hasOwnProperty.call(frozenMap, entry.id)
      ? frozenMap[entry.id]
      : null
    const useFrozen = frozenSource !== null && typeof frozenSource === 'object'
      && frozenSource.kind === 'provider'
      && typeof frozenSource.url === 'string' && frozenSource.url.length > 0
      && typeof frozenSource.value === 'string' && frozenSource.value.length > 0
    /**
     * [CP-02 残留] 来源解析必须**自己兜住异常**，不能冒到整批。
     *
     * 之前这里直接 await：一旦解析过程抛出（例如宿主目录服务异常、凭据服务实现抛错），
     * 异常会越过本条的失败分类，整批变成「未预期异常」，用户看到的是不明所以的提示，
     * 也拿不到可操作原因。现在统一转成结构化的 `config`/`no-key` 结果。
     */
    let resolved
    if (useFrozen) {
      resolved = {
        ok: true,
        url: frozenSource.url,
        key: frozenSource.value,
        ref: typeof frozenSource.ref === 'string' ? frozenSource.ref : '',
        origin: typeof frozenSource.origin === 'string' ? frozenSource.origin : '',
      }
    } else {
      try {
        resolved = await resolveProviderTarget(ctx, entry.provider, entry.balanceEndpoint, budget)
      } catch (err) {
        resolved = {
          ok: false,
          error: 'config',
          message: '解析所选模型渠道时出错，请检查该渠道在「设置 → 模型」中的配置',
        }
      }
    }
    if (!operationCurrent()) return operationCancelled()
    if (resolved.ok !== true) {
      return wireOf(Object.assign({}, entry, {
        gen: generationOf(entry, 'none'),
        url: '',
      }), {
        error: resolved.error,
        message: resolved.message,
        transient: resolved.transient === true || undefined,
      })
    }
    entry = Object.assign({}, entry, {
      url: resolved.url,
      // provider 的 apiKeyEnv 解析出的值：**只用于本次请求**，不入配置、不进日志。
      key: resolved.key,
      credentialRef: resolved.ref,
      // 地址来自配置，天然可信：视为已确认目标，无需再走"用户确认 origin"那一步。
      credentialHost: resolved.origin,
    })
  }

  /** 配置/URL 类错误不需要看 Key，可先用显式 Key 指纹占位（随后会被真实代次覆盖）。 */
  const preGen = generationOf(entry, credentialFingerprint(entry.key))
  const fail = (extra) => wireOf(Object.assign({}, entry, { gen: preGen }), extra)

  if (budget.expired) {
    return fail({ error: 'network', transient: true, message: '本次刷新未能在预算内完成该条请求，稍后自动重试' })
  }

  const balancePath = parseJsonPath(entry.balancePath)
  if (!balancePath.ok) {
    return fail({
      error: 'config',
      message: PATH_ERROR_TEXT[balancePath.error] || 'JSON 键路径配置无效',
    })
  }
  if (typeof entry.subtractPath === 'string' && entry.subtractPath.length > 0) {
    const check = parseJsonPath(entry.subtractPath)
    if (!check.ok) {
      return fail({
        error: 'config',
        message: '扣减键配置无效：' + (PATH_ERROR_TEXT[check.error] || '请检查语法'),
      })
    }
  }
  /**
   * [0.9.1] provider 模式下的地址**来自宿主配置**，不是用户输入。
   *
   * 因此只做字符串层校验（https / 无 userinfo / 无查询串密钥），
   * **跳过**「环回/私网/单标签主机」这类针对**用户输入**的防护：
   * 那层防护的目的是挡住"用户被诱导填内网地址"，而配置里的地址是用户
   * 自己在「设置 → 模型」里主动配置、并且**正在实际使用**的服务商。
   *
   * 副作用（有意为之）：fake-ip 代理（198.18/15）不会再被误判为内网。
   */
  const fromProvider = typeof entry.provider === 'string' && entry.provider.length > 0
  const target = validateBalanceUrl(entry.url, { skipPrivateHostCheck: fromProvider })
  if (!target.ok) {
    return fail({ error: 'config', message: target.message })
  }

  // ---- 凭据：插件显式 Key 优先；否则只认用户**明确选定**的模型凭据引用 ----
  //
  // [R5] 目标绑定对**两者**都生效：只要「这次要用一把已保存的凭据」（显式 Key 或引用），
  // 就必须先在设置页确认过把它发到当前 origin。否则改 URL 后旧 Key 会被静默转发到新域名。
  // 新录入但尚未保存的 Key 走的是「刚由用户输入」的路径（key 由请求方直接给出），
  // 不经过这里的已保存绑定检查——见下方 `options.pendingKey`。
  let key = ''
  let viaRef = ''
  let identity = null // { source:'explicit'|'ref'|'pending', fingerprint }
  const savedKey = typeof entry.key === 'string' ? entry.key : ''
  const pendingKey = typeof opts.pendingKey === 'string' && opts.pendingKey.length > 0 ? opts.pendingKey : ''
  const origin = target.origin !== undefined && target.origin.length > 0 ? target.origin : originOf(target)

  // [F1] 冻结协议**先于**任何已保存凭据的选择：工具调用已为该条目定下本次实际生效来源，
  // provider 必须服从它，否则「采样 A、发送 B」的窗口会重新出现。
  //   explicit / ref → 只用冻结值（不看当前 cfg，也不再解析引用）
  //   none           → 直接缺凭据（零请求）
  //   null/undefined → 未采样，走原来的「已保存凭据 + 目标确认」路径
  // 注意：冻结的 explicit 仍然是**已保存的 Key**，目标确认照旧执行，绝不因为「冻结」而绕过。
  const frozen = frozenMap !== null && Object.prototype.hasOwnProperty.call(frozenMap, entry.id)
    ? frozenMap[entry.id]
    : null
  const frozenKind = frozen !== null && typeof frozen === 'object' && typeof frozen.kind === 'string'
    ? frozen.kind
    : null

  /**
   * [CP-01] **provider 来源完全绕开旧凭据协议。**
   *
   * 上一段的 `resolveProviderTarget()` 已经把 `entry.url` / `entry.key` /
   * `entry.credentialHost` 全部改成所选 provider 派生的值，所以这里直接
   * 采用它们即可，绝不能再去读 `frozen`（那是**上一个模型**的冻结结果）：
   *   - 若沿用 `frozen.kind='none'`，工具会把合法 provider 判成缺凭据；
   *   - 若沿用 `frozen.kind='explicit'`（遗留 customKeys 的旧 Key），
   *     由于目标已被改成新 provider 的 origin，旧 Key 会**通过校验并被发给新地址**。
   *
   * 因此 provider 条目只认 `entry.key`（本次解析出的值），且要求它来自同一次解析。
   */
  if (fromProvider) {
    const producedKey = typeof entry.key === 'string' ? entry.key : ''
    if (producedKey.length === 0) {
      return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
        error: 'no-key',
        message: '该渠道没有可用的 API Key，请到「设置 → 模型」补全',
      })
    }
    key = producedKey
    viaRef = typeof entry.credentialRef === 'string' ? entry.credentialRef : ''
    identity = { source: 'provider', fingerprint: credentialFingerprint(key) }
    /**
     * [R5-02] **GUI 路径也要登记采样指纹**。
     *
     * 之前只有工具的 `identify` 登记，于是「工具拿到 A、GUI 实际用 B」时
     * Host 观察仍停在旧值（FAIL_GUI_KEY_SAMPLE_NOT_REGISTERED_WITH_HOST）。
     * 采样事实属于来源本身，与哪条入口采样无关，因此这里统一上报。
     */
    if (typeof opts.onSampledCredential === 'function') {
      let accepted
      try { accepted = opts.onSampledCredential(entry.id, credentialFingerprint(key)) } catch (err) { /* 独立诊断回调兼容旧行为 */ }
      if (accepted === false) return operationCancelled()
    }
  } else if (pendingKey.length > 0) {
    // 用户在本轮设置页里新填写、尚未保存：目标就是表单里的 URL，按定义已由用户输入。
    key = pendingKey
    identity = { source: 'pending', fingerprint: credentialFingerprint(key) }
  } else if (frozenKind === 'none' || frozenKind === 'unsupported') {
    // 冻结判定「本次没有可用凭据」：即使当前 cfg 里刚好有 Key 也不能用。
    return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
      error: 'no-key',
      message: '未配置 API Key：请在设置页填写，或选择已有的模型凭据引用',
    })
  } else if (frozenKind === 'explicit' || frozenKind === 'ref') {
    const frozenValue = frozen.value
    if (typeof frozenValue !== 'string' || frozenValue.length === 0) {
      // 冻结描述本身不可用 → 安全拒绝，不回退到实时 cfg。
      return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
        error: 'no-key',
        message: '所选模型凭据引用当前没有值：请先在「设置 → 模型」中配置，或直接填写 API Key',
      })
    }
    // 目标绑定对冻结值同样生效（它也是「已保存的凭据」）。
    const confirmed = normalizeOriginField(entry.credentialHost)
    if (confirmed.length === 0 || confirmed !== origin) {
      const gen = generationOf(entry, credentialFingerprint(frozenValue))
      return wireOf(Object.assign({}, entry, { gen }), {
        error: 'credential-unconfirmed',
        message: '该条已保存凭据，但发送目标（' + origin + '）尚未确认：请在设置页重新确认后再保存',
      })
    }
    key = frozenValue
    viaRef = frozenKind === 'ref' ? entry.credentialRef : ''
    identity = { source: frozenKind, fingerprint: credentialFingerprint(key) }
  } else if (savedKey.length > 0 || entry.credentialRef.length > 0) {
    // 未采样：已保存的凭据（无论显式 Key 还是引用）→ 必须确认目标 origin。
    const confirmed = normalizeOriginField(entry.credentialHost)
    if (confirmed.length === 0 || confirmed !== origin) {
      const gen = generationOf(entry, credentialFingerprint(savedKey))
      return wireOf(Object.assign({}, entry, { gen }), {
        error: 'credential-unconfirmed',
        message: '该条已保存凭据，但发送目标（' + origin + '）尚未确认：请在设置页重新确认后再保存',
      })
    }
    if (savedKey.length > 0) {
      key = savedKey
      identity = { source: 'explicit', fingerprint: credentialFingerprint(key) }
    }
  }

  if (key.length === 0 && entry.credentialRef.length > 0 && frozenKind === null) {
    // 未采样且没有显式 Key：按原路径解析引用，保持既有回退契约。
    const credentials = (() => {
      try { return ctx != null && typeof ctx.get === 'function' ? ctx.get('credentials') : undefined } catch (err) { return undefined }
    })()
    if (credentials === undefined || credentials === null || typeof credentials.resolve !== 'function') {
      return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
        error: 'no-key',
        message: '本部署没有可用的凭据服务，无法使用模型凭据引用；请直接填写 API Key',
      })
    }
    // [R1] 凭据解析同样受预算约束：挂起的凭据服务不能拖住整批。
    const raced = await budget.race(Promise.resolve().then(() => credentials.resolve(entry.credentialRef)))
    if (!raced.ok) {
      const expired = raced.reason === 'timeout'
      return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
        error: expired ? 'network' : 'no-key',
        transient: expired || undefined,
        message: expired
          ? '解析模型凭据引用超时，本次刷新未完成该条请求'
          : '解析模型凭据引用失败：请检查引用名是否存在',
      })
    }
    if (!operationCurrent()) return operationCancelled()
    const hit = raced.value
    if (hit === undefined || hit === null || typeof hit.value !== 'string' || hit.value.length === 0) {
      return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
        error: 'no-key',
        message: '所选模型凭据引用当前没有值：请先在「设置 → 模型」中配置，或直接填写 API Key',
      })
    }
    key = hit.value
    viaRef = entry.credentialRef
    identity = { source: 'ref', fingerprint: credentialFingerprint(key) }
  }

  if (key.length === 0) {
    return wireOf(Object.assign({}, entry, { gen: generationOf(entry, 'none') }), {
      error: 'no-key',
      message: '未配置 API Key：请在设置页填写，或选择已有的模型凭据引用',
    })
  }

  if (!operationCurrent()) return operationCancelled()
  // [R2] 代次在**拿到实际 Key 之后**才定稿：引用轮换会换 gen，失败/清空也会换 gen。
  const gen = generationOf(entry, identity.fingerprint)
  const wire = (extra) => wireOf(Object.assign({}, entry, { gen }), extra)

  // ---- 目标核验 + 连接绑定（安全问题） ----
  const resolver = typeof opts.resolveHost === 'function' ? opts.resolveHost : defaultResolveHost
  /**
   * [0.9.1] provider 模式**不做 DNS 私网检查、也不钉死 IP**。
   *
   * 地址来自宿主配置（用户自己配置、正在使用的服务商），不是外部输入：
   *   - 原来的私网检查是为了挡住"用户被诱导填内网地址"，该风险已消失；
   *   - fake-ip 代理会把域名解析成 198.18/15，检查会误判为内网而拒绝请求。
   *
   * 代价：失去"检查的 IP 就是连接的 IP"这层保证。TLS 证书校验与
   * `redirect:'error'` 仍然生效，因此连错服务器会握手失败。
   */
  let bind
  if (fromProvider) {
    bind = { ok: true, value: { ok: true, addresses: null } }
  } else {
    bind = await budget.race(resolveValidatedAddresses(target.host, resolver))
    if (!bind.ok) {
      const expired = bind.reason === 'timeout'
      return wire({
        error: 'network',
        transient: true,
        message: expired
          ? '核验余额接口地址超时，本次刷新未完成该条请求'
          : '无法解析余额接口域名（DNS 失败）',
      })
    }
    if (bind.value.ok !== true) {
      if (bind.value.reason === 'private') {
        return wire({
          error: 'config',
          message: '该域名解析到环回/私网/链路本地地址，出于安全考虑拒绝请求。'
            + '如果这是本机代理（fake-ip），请改为在「模型」里配置该服务商后从列表中选择',
        })
      }
      return wire({ error: 'network', transient: true, message: '无法解析余额接口域名（DNS 失败）' })
    }
  }

  // [R1] 连接前再确认一次：DNS/凭据迟到时不得发请求。
  if (!operationCurrent()) return operationCancelled()
  if (budget.expired) {
    return wire({ error: 'network', transient: true, message: '本次刷新未能在预算内完成该条请求，稍后自动重试' })
  }

  // ---- 请求：把已验证地址作为连接约束交给传输层（防 DNS 重绑定） ----
  const result = await requestJson(target.url, key, {
    transport: opts.transport,
    // [Z2] 调用方取消要能中断在途传输，并在取消后拒绝处理迟到响应。
    signal: opts.signal,
    timeoutMs: Math.min(
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : REQUEST_TIMEOUT_MS,
      budget.remaining(),
    ),
    budget,
    target: {
      host: target.host,
      protocol: target.protocol,
      port: target.port,
      addresses: bind.value.addresses,
    },
  })
  if (!operationCurrent()) return operationCancelled()
  if (result.kind === 'network') {
    // [0.9.0] 重定向是端点问题：redirect:'error' 会抛错而不是给 3xx，因此必须在
    // 这里与「真正的网络不可达」分开，否则用户会被引导去排查网络/代理。
    if (result.detail === 'redirect') {
      return wire({
        error: 'endpoint',
        message: '余额接口返回重定向：本插件不跟随重定向（Authorization 不会转发到新地址），请改用最终地址',
      })
    }
    return wire({
      error: 'network',
      transient: true,
      message: result.detail === 'no-fetch'
        ? '当前部署没有可用的原生 fetch，无法请求余额接口'
        : (result.detail === 'unbound'
          ? '当前运行时无法把请求绑定到已核验的 IP，出于安全考虑拒绝发送凭据（不会绕过证书校验）'
          : (result.detail === 'timeout'
            ? '余额接口请求超时'
            : (result.detail === 'tls'
              ? '余额接口的 TLS 证书校验失败：请检查证书、系统时间或网络中间设备（插件不会关闭证书校验）'
              : '余额接口网络不可达'))),
    })
  }
  const statusError = classifyStatus(result.status)
  if (statusError !== null) {
    return wire({
      error: statusError.error,
      message: statusError.message,
      transient: statusError.transient || undefined,
    })
  }
  if (result.body.ok !== true) {
    if (result.body.reason === 'too-large') {
      return wire({ error: 'structure', transient: true, message: '余额接口响应过大（超过 ' + Math.round(MAX_BODY_BYTES / 1024) + ' KiB），已拒绝解析' })
    }
    return wire({ error: 'structure', transient: true, message: '余额接口返回了无法读取的响应体' })
  }
  let data
  try {
    data = JSON.parse(result.body.text)
  } catch (err) {
    return wire({ error: 'structure', transient: true, message: '余额接口返回的不是有效 JSON' })
  }
  const extracted = extractCustomBalance(data, entry.balancePath, entry.subtractPath)
  if (!extracted.ok) {
    return wire({ error: 'structure', transient: true, message: structureMessage(extracted.reason) })
  }
  return wire({
    balance: extracted.value,
    isAvailable: true,
    via: viaRef.length > 0 ? 'credential-ref' : (identity.source === 'pending' ? 'pending-key' : 'api-key'),
  })
}

/** 调度结果。 */
function skippedWire(entry, message) {
  return wireOf(entry, { error: 'network', transient: true, message })
}

/**
 * 取整批自定义余额：受控并发 + **贯穿全流程**的总预算（R1）。
 *
 * - 停用条目**不请求**，只回 `{enabled:false, custom:true, gen}`，供客户端把行去掉；
 * - 单条超时/异常只影响该条；
 * - 整批共享同一个绝对 deadline：排队、凭据、DNS、连接、body **全部**计入；
 * - 超出预算仍排队的条目转结构化暂时失败，且**不会再发请求**（迟到的依赖不回填）。
 *
 * 0.9.0 的问题：只把 `timeoutMs` 传给 requestJson，前置阶段（凭据/DNS）可以无限挂起，
 * 于是 `Promise.all` 不返回、把客户端 40 s 打穿，连带内置渠道一起灰化。
 */
/**
 * [CP-06] 测试专用的旧条目开关。
 *
 * 生产默认返回 false（旧条目一律不采纳）。只有测试进程显式设置
 * `DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM=1` 时才为 true —— 这样既有底层安全回归
 * （DNS/重定向/预算/连接绑定/摘要协议）仍能在**同一份**实现上验证，
 * 而生产不会出现与迁移说明矛盾的隐形通道。
 *
 * @returns {boolean}
 */
export function legacyCustomAllowed() {
  try {
    return typeof process !== 'undefined' && process !== null && process.env !== undefined
      && process.env !== null && process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM === '1'
  } catch (err) {
    return false
  }
}
export async function fetchCustomPlans(ctx, shell, cfg, options) {
  const opts = options || {}
  /**
   * [CP-06] 生产取数入口**不采纳**没有 `provider` 的旧条目。
   *
   * 0.9.1 起余额来源只能从「已配置的模型渠道」选择；旧条目（手填 URL + Key）
   * 在新模型下没有可用的来源身份，因此不再在后台继续查询它们 ——
   * 这与升级说明「需要重新选择来源」一致，也避免"文档说清空、实际还在查"。
   *
   * 只有在测试/兼容路径显式传 `allowLegacy` 时才读取（见 collectCustomEntries）。
   */
  /**
   * [CP-06] 生产取数入口**不采纳**没有 `provider` 的旧条目。
   *
   * 0.9.1 起余额来源只能从「已配置的模型渠道」选择；旧条目（手填 URL + Key）
   * 在新模型下没有可用的来源身份，因此不再在后台继续查询它们 ——
   * 这与升级说明「需要重新选择来源」一致，也避免"文档说清空、实际还在查"。
   *
   * **测试钩子**：`DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM=1` 只在测试进程里设置，
   * 用同一个函数读取既有底层安全回归所需的旧条目。生产不会设置它，
   * 因此不存在"隐形兼容通道"——要在生产启用必须显式改环境。
   */
  const allowLegacy = opts.allowLegacy === true || legacyCustomAllowed()
  const allEntries = collectCustomEntries(cfg, { allowLegacy })
  // [D6-A] 取数**之前**先按允许集合缩小条目。
  //
  // 复核发现：旧实现先取完所有自定义条目、再按 ids 过滤结果——即使模型只问 A，
  // 也会解析 B 的凭据并向 B 发请求。过滤结果无法补救已经发生的副作用。
  // 因此这里在**任何**凭据解析 / DNS / 网络之前就把范围缩到 onlyIds。
  const only = opts.onlyIds instanceof Set
    ? opts.onlyIds
    : (Array.isArray(opts.onlyIds) ? new Set(opts.onlyIds) : null)
  const entries = only === null ? allEntries : allEntries.filter((entry) => only.has(entry.id))
  if (entries.length === 0) return []
  const results = new Array(entries.length)
  const pending = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry.enabled) {
      results[i] = wireOf(entry, { enabled: false })
    } else {
      pending.push(i)
    }
  }
  if (pending.length === 0) return results

  const perItem = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : REQUEST_TIMEOUT_MS
  const total = typeof opts.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : BATCH_BUDGET_MS
  // 整批 deadline：所有条目共用，单条再取 min(自身超时, 整批剩余)。
  const batch = createBudget(total)
  // [Z2] 把调用方（模型工具）的取消联到整批预算：取消后 worker 不再启动新条目，
  // 已在途的请求由 requestJson 的 abort 联动立即中断。
  const externalSignal = opts.signal !== null && opts.signal !== undefined
    && typeof opts.signal.addEventListener === 'function'
    ? opts.signal
    : null
  const onItem = typeof opts.onItem === 'function' ? opts.onItem : null
  const cancelled = () => (externalSignal !== null && externalSignal.aborted === true) || batch.expired
  const detachAbort = externalSignal === null ? null : (() => {
    const onAbort = () => { batch.expire() }
    if (externalSignal.aborted === true) onAbort()
    else externalSignal.addEventListener('abort', onAbort, { once: true })
    return () => {
      if (typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', onAbort)
      }
    }
  })()
  /** 单条完成（或跳过）：立即打时间戳并回传，快条目不必等整批。 */
  const settle = (index, wire) => {
    // [Z2] 采集时间在**真正完成时**写入，而不是等整批结束后统一补。
    if (wire !== null && typeof wire === 'object' && wire.fetchedAt === undefined && wire.error === undefined) {
      wire.fetchedAt = Date.now()
    }
    results[index] = wire
    if (onItem !== null) {
      try { onItem(wire) } catch (err) { /* 回传失败不影响整批 */ }
    }
  }
  let cursor = 0
  async function worker() {
    for (;;) {
      const slot = cursor
      cursor += 1
      if (slot >= pending.length) return
      const index = pending[slot]
      const entry = entries[index]
      if (cancelled()) {
        settle(index, skippedWire(entry, '本次刷新已取消，稍后自动重试'))
        continue
      }
      try {
        const wire = await fetchCustomBalance(ctx, shell, cfg, entry, Object.assign({}, opts, {
          // 单条子预算：继承整批 deadline，且不超过该条自己的超时。
          budget: createBudget(Math.min(perItem, batch.remaining()), batch.deadlineAt),
          timeoutMs: Math.min(perItem, batch.remaining()),
        }))
        // 取消/到期后迟到 settle 的结果：不回传，也不当作成功（避免回填）。
        if (cancelled() && wire.error === undefined) {
          settle(index, skippedWire(entry, '本次刷新已取消，稍后自动重试'))
          continue
        }
        settle(index, wire)
      } catch (err) {
        settle(index, wireOf(entry, {
          error: 'network',
          transient: true,
          message: '余额请求发生未预期的异常',
        }))
      }
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(CONCURRENCY, pending.length); i += 1) workers.push(worker())
  // 再兜一层：即使某个 worker 内部出现无法取消的 await，也不让整批超过 deadline。
  try {
    await Promise.race([
      Promise.all(workers),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, batch.remaining()) + 5)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (typeof detachAbort === 'function') detachAbort()
  }
  // 兜底填充：任何仍未填的位置都转结构化暂时失败，绝不返回 undefined。
  for (let i = 0; i < entries.length; i += 1) {
    if (results[i] === undefined) {
      settle(i, skippedWire(entries[i], '本次刷新未能在预算内完成该条请求，稍后自动重试'))
    }
  }
  return results
}

/**
 * 设置页用的「密钥/凭据存在性」摘要：**只回布尔值**，绝不回 Key 或解析结果。
 * 客户端拿不到 `secrets`（ConfigFormController 的 snapshot 不含它），因此需要这条路由
 * 才知道每条记录的 Key 是否已保存。
 */
export async function customStatusOf(ctx, cfg) {
  /**
   * [CP-06] 这里**仍要读取旧条目**：它回答的是「用户配置里有哪些 Key/引用」，
   * 属于配置摘要，不是取数范围。旧条目不再后台取数（见 fetchCustomPlans），
   * 但设置页仍需要如实显示它们的状态，否则用户看不到自己的旧配置。
   */
  const entries = collectCustomEntries(cfg, { allowLegacy: true })
  const keys = {}
  const refs = {}
  for (const entry of entries) {
    keys[entry.id] = entry.key.length > 0
    if (entry.credentialRef.length === 0) continue
    let configured = false
    try {
      const credentials = ctx != null && typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(entry.credentialRef)
        configured = hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0
      }
    } catch (err) {
      configured = false
    }
    refs[entry.id] = configured
  }
  return { keys, refs, generation: entries.map((entry) => ({ id: entry.id, gen: entry.gen })) }
}
