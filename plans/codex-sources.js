/**
 * Codex **双来源**（Connect / Subscription）的纯观察层：来源归一、启用/兼容探测、
 * 运行期身份摘要、第三方服务失败码映射。
 *
 * 为什么单独成模块：
 *   1. `plans/codex.js` 需要按 `codexSource` 分派两条完全不同的读取路径（旧 Connect
 *      公开 SDK / 新的第三方只读 service），分派与其他渠道无关；
 *   2. `index.js` 的观察身份（`identityOfChannel`）、`/api/plan-usage/codex-sources`
 *      状态路由、以及 `plans/custom-balance.js` 的配置摘要都要用**同一套**归一规则，
 *      各写一份必然漂移；
 *   3. 本模块**零 I/O**：不 import 任何第三方包、不读文件、不发请求、不解析凭据，
 *      只读 `ctx.get(...)` 的公开服务对象、`entry.options/.disabled/.fiber.state`
 *      这类公开元信息。因此可以在 fake ctx 上完整单测。
 *
 * 硬边界（用户 2026-11-11 明确）：
 *   - **未安装**与**未开启**对外都只有一种说法：`enabled:false`（界面统一显示「未启用」）；
 *   - **已安装且已激活、但没装只读接口补丁**（接口不兼容/需要适配）必须显示
 *     `enabled:true / compatible:false`，**不能**冒充「未启用」；
 *   - `subscription` 显式不可用时**绝不回退** `connect`；
 *   - 不构造 ownerPeer、不读 token/credential record、不读取任何来源的额度；
 *   - 不输出账号 ID、记录路径、令牌或上游原文。
 *
 * 第三方只读 service 合同（High82 候选实现，本模块只按合同消费）：
 *   `ctx.get('codexSubscriptionUsage')` 当且仅当
 *     - `apiVersion === 1`
 *     - `readUsage({ signal })` 是函数（调用 payload **只有** `signal`，不传 force/URL）
 *     - `getRevision()` 是函数且同步返回**非负安全整数**
 *   时才算可用。返回值 `{ok:true,value:usageDTO}` 或失败
 *   `{ok:false,code}`（闭集：`E_CODEX_USAGE_BAD_REQUEST` / `E_CODEX_USAGE_ABORTED` /
 *   `E_CODEX_SOURCE_CHANGED` / `E_CODEX_USAGE_FAILED` / `E_CODEX_USAGE_NOT_READY`），
 *   或原 handler 形状 `{ok:false,error:{code,message,details}}`。
 *   失败 message **只做精确等值映射**（见 `subscriptionFailureOf`），绝不回显原文。
 */

/** 来源枚举：只有这两个值（没有 auto，不做后台自动选择）。 */
export const CODEX_SOURCE_CONNECT = 'connect'
export const CODEX_SOURCE_SUBSCRIPTION = 'subscription'
export const CODEX_SOURCES = Object.freeze([CODEX_SOURCE_CONNECT, CODEX_SOURCE_SUBSCRIPTION])
/** [主已决定] 缺省 `connect`：既有用户行为不变，不做暗迁移。 */
export const DEFAULT_CODEX_SOURCE = CODEX_SOURCE_CONNECT

/** 两个第三方插件的**精确**标识（只做等值匹配，不做 substring 冒名匹配）。 */
export const CONNECT_PACKAGE_NAME = 'dsh-codex-connect'
export const CONNECT_PLUGIN_NAME = 'llm-openai-codex'
export const SUBSCRIPTION_PACKAGE_NAME = 'dsh-codex-subscription'
export const SUBSCRIPTION_PLUGIN_NAME = 'codex-subscription'

/** 公开 cordis 服务名。 */
export const CONNECT_TRANSPORT_SERVICE = 'openaiCodexTransport'
export const SUBSCRIPTION_USAGE_SERVICE = 'codexSubscriptionUsage'
/** 只读 service 的合同版本：不匹配即 incompatible（不是「未启用」）。 */
export const SUBSCRIPTION_API_VERSION = 1

/** cordis Fiber 的 ACTIVE 状态值（其它状态都不算「已启用」）。 */
const FIBER_STATE_ACTIVE = 2

/** wire 上出现的安全错误码（均为闭集，不含原文）。 */
export const CODEX_ERROR_NOT_ENABLED = 'not-enabled'
export const CODEX_ERROR_INCOMPATIBLE = 'incompatible'
export const CODEX_ERROR_SOURCE_CHANGED = 'source-changed'

/** 来源 → 面向用户的名称（设置页两行、详情文案共用）。 */
const SOURCE_LABELS = Object.freeze({
  connect: 'Codex Connect',
  subscription: 'Codex Subscription',
})

/** 来源 → 它实际依赖的第三方 provider（`plan.source` 描述/文档用）。 */
const SOURCE_PROVIDERS = Object.freeze({
  connect: CONNECT_PACKAGE_NAME,
  subscription: SUBSCRIPTION_PACKAGE_NAME,
})

/**
 * 取配置里的字面值，兼容 volatile 包装 `{ get() }`。
 *
 * 这里**不** import `custom-balance.js`（那会让本模块被 136KB 的余额模块绑住，
 * 而 custom-balance 反过来又要用本模块的归一函数，形成环）。包装解包只有这一个规则。
 */
function literalOf(raw) {
  if (raw === null || raw === undefined) return raw
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try { return raw.get() } catch (err) { return undefined }
  }
  return raw
}

/**
 * 把任意值归一成来源枚举。
 *
 * - `'subscription'` → subscription；
 * - 其余（`'connect'` / 缺失 / 未知字符串 / 非字符串）→ **connect**。
 *
 * 未知值回落到既有默认（而不是动态猜来源/自动探测服务）：这是主已定的口径 ——
 * 旧配置不迁移，手改 YAML 写错也不会把用户静默切到另一条来源。
 */
export function normalizeCodexSource(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === CODEX_SOURCE_SUBSCRIPTION ? CODEX_SOURCE_SUBSCRIPTION : CODEX_SOURCE_CONNECT
}

/** 读整份配置里的选中来源（缺失/未知 → connect）。 */
export function codexSourceOf(cfg) {
  const raw = cfg !== null && typeof cfg === 'object' ? cfg.codexSource : undefined
  return normalizeCodexSource(literalOf(raw))
}

/** 来源的显示名。 */
export function codexSourceLabel(source) {
  const normalized = normalizeCodexSource(source)
  return SOURCE_LABELS[normalized]
}

/** 来源对应的第三方 provider 名（纯描述，不参与取数）。 */
export function codexSourceProvider(source) {
  return SOURCE_PROVIDERS[normalizeCodexSource(source)]
}

// ---------------------------------------------------------------------------
// 服务探测（纯观察；不读记录、不发请求）
// ---------------------------------------------------------------------------

/**
 * 读 Connect 的公开传输服务。
 *
 * 它**没有**额度方法（只有 generateImages/editImages），因此这里只当「插件已启用」
 * 的纯观察闸门：guard 通过后才允许 import 公开模块并调用其额度函数。
 *
 * @returns {{state:'present'|'absent'|'unknown', service?:object}}
 */
export function readCodexConnectTransport(ctx) {
  let service
  try {
    service = ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
      ? ctx.get(CONNECT_TRANSPORT_SERVICE)
      : undefined
  } catch (err) {
    // getter 抛错 = 无法证明状态，**不能**当成「未启用」。
    return { state: 'unknown' }
  }
  if (service === undefined || service === null) return { state: 'absent' }
  return { state: 'present', service }
}

/**
 * 校验并读取 subscription 只读 service。
 *
 * @returns {{
 *   state:'ok'|'absent'|'incompatible'|'unknown',
 *   service?:object,
 *   revision?:number,
 *   reason?:string,
 * }}
 *   - `ok`：合同齐全（apiVersion 1 + readUsage + getRevision 返回非负安全整数）；
 *   - `absent`：上下文里没有该服务（未安装 / 未开启 / 未装补丁）；
 *   - `incompatible`：服务在，但合同不匹配（版本/成员/修订号不可读）→ 界面应显示
 *     「接口不兼容/需要适配」，**不是**「未启用」；
 *   - `unknown`：`ctx.get` 本身抛错，状态不可证明（调用方 fail-closed）。
 */
export function readCodexSubscriptionService(ctx) {
  let service
  try {
    service = ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
      ? ctx.get(SUBSCRIPTION_USAGE_SERVICE)
      : undefined
  } catch (err) {
    return { state: 'unknown' }
  }
  if (service === undefined || service === null) return { state: 'absent' }
  if (typeof service !== 'object' && typeof service !== 'function') {
    return { state: 'incompatible', service, reason: 'shape' }
  }
  if (service.apiVersion !== SUBSCRIPTION_API_VERSION) {
    return { state: 'incompatible', service, reason: 'api-version' }
  }
  if (typeof service.readUsage !== 'function') {
    return { state: 'incompatible', service, reason: 'read-usage' }
  }
  if (typeof service.getRevision !== 'function') {
    return { state: 'incompatible', service, reason: 'revision' }
  }
  let revision
  try { revision = service.getRevision() } catch (err) {
    // 合同里 getRevision 在 disposed 后可以抛：服务在、但当前不可用。
    return { state: 'incompatible', service, reason: 'revision-unreadable' }
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return { state: 'incompatible', service, reason: 'revision-invalid' }
  }
  return { state: 'ok', service, revision }
}

/**
 * 读插件加载器的条目列表（**只读公开元信息**，used only for `enabled` 判定）。
 *
 * 只接受三种形态：数组 / Map / 可迭代；读不到就是「没有证据」，不是错误。
 * 返回 `{ known, list }`：`known:false` 时调用方必须按「无法证明」处理。
 */
export function readLoaderEntries(ctx) {
  let loader
  try {
    loader = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('loader') : undefined
  } catch (err) {
    return { known: false, list: [] }
  }
  if (loader === null || typeof loader !== 'object') return { known: false, list: [] }
  let raw
  try { raw = loader.entries } catch (err) { return { known: false, list: [] } }
  if (typeof raw === 'function') {
    try { raw = raw.call(loader) } catch (err) { return { known: false, list: [] } }
  }
  let list = null
  if (Array.isArray(raw)) list = raw
  else if (raw instanceof Map) list = Array.from(raw.values())
  else if (raw !== null && typeof raw === 'object' && typeof raw[Symbol.iterator] === 'function') {
    list = Array.from(raw)
  }
  if (list === null) return { known: false, list: [] }
  return { known: true, list }
}

/**
 * 某个 loader 条目是否是**目标插件且已激活**。
 *
 * 只读这些公开字段（不触 `options.config` / `_initTask` / inertia / 私有反射）：
 *   - `entry.options.name`（打包安装时通常是包名）
 *   - `entry.options.moduleNamespace`（模块命名空间）
 *   - `entry.fiber.runtime.name`（插件自身导出的 `name`）
 *   - `entry.disabled`（必须是**显式** `false`）
 *   - `entry.fiber.state`（必须是 ACTIVE = 2）
 *
 * 名称只做**等值**匹配（`packageName` 或 `pluginName`），不做 substring：
 * 否则任何名字里带 `codex-subscription` 的未知插件都能冒名。
 */
export function entryIsActivePlugin(entry, packageName, pluginName) {
  if (entry === null || typeof entry !== 'object') return false
  const options = entry.options !== null && typeof entry.options === 'object' ? entry.options : null
  const optionName = options !== null && typeof options.name === 'string' ? options.name.trim() : ''
  const namespace = options !== null && typeof options.moduleNamespace === 'string'
    ? options.moduleNamespace.trim()
    : ''
  const fiber = entry.fiber !== null && typeof entry.fiber === 'object' ? entry.fiber : null
  const runtimeName = fiber !== null && fiber.runtime !== null && typeof fiber.runtime === 'object'
    && typeof fiber.runtime.name === 'string'
    ? fiber.runtime.name.trim()
    : ''
  const names = [optionName, namespace, runtimeName]
  let matched = false
  for (const name of names) {
    if (name.length === 0) continue
    if (name === packageName || name === pluginName) { matched = true; break }
  }
  if (!matched) return false
  if (entry.disabled !== false) return false
  const state = fiber !== null && typeof fiber.state === 'number' ? fiber.state : null
  return state === FIBER_STATE_ACTIVE
}

// ---------------------------------------------------------------------------
// 运行期身份（纯摘要：不进 wire、不进日志、不含账号）
// ---------------------------------------------------------------------------

/**
 * service 实例序号表（本地 WeakMap，只用于**区分实例**）。
 *
 * 为什么不用账号 ID：账号信息属于第三方私有状态，本插件不读也不需要；
 * 而「同一个 service 对象被换成另一个」是能在公开层观察到的等价事实 ——
 * 换服务、卸载重装、插件热重载都会给出不同序号，旧在途结果因此可被拒绝。
 */
const serviceInstanceIds = new WeakMap()
let nextServiceInstanceId = 0

function instanceIdOf(service) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return 0
  let id = serviceInstanceIds.get(service)
  if (id === undefined) {
    nextServiceInstanceId += 1
    id = nextServiceInstanceId
    serviceInstanceIds.set(service, id)
  }
  return id
}

/**
 * Codex 渠道的运行期身份摘要（**同步纯观察**，供 `identityOfChannel` 逐次求值）。
 *
 * 编码：`c<0|1|?>/s<0|序号@修订|x|?>`
 *   - `c` = Connect 传输服务存在（1）/ 不在（0）/ 无法判断（?）；
 *   - `s` = subscription 服务：0 不存在，`N@R` 可用（实例序号@revision），
 *     `N@x` 在但不兼容，`?` 无法判断。
 *
 * 只有这些**非账号**事实，绝不含 id/路径/令牌。换来源、停用、换服务、
 * 账号变化（revision 前进）都会让这个摘要变化 → epoch 推进 → 旧结果作废。
 */
export function codexRuntimeIdentityOf(ctx) {
  const connect = readCodexConnectTransport(ctx)
  const subscription = readCodexSubscriptionService(ctx)
  const connectPart = connect.state === 'present' ? '1' : (connect.state === 'absent' ? '0' : '?')
  let subscriptionPart
  if (subscription.state === 'ok') subscriptionPart = instanceIdOf(subscription.service) + '@' + subscription.revision
  else if (subscription.state === 'incompatible') subscriptionPart = instanceIdOf(subscription.service) + '@x'
  else if (subscription.state === 'unknown') subscriptionPart = '?'
  else subscriptionPart = '0'
  return 'c' + connectPart + '/s' + subscriptionPart
}

// ---------------------------------------------------------------------------
// 只读状态（`GET /api/plan-usage/codex-sources`）
// ---------------------------------------------------------------------------

/**
 * 计算两个来源的启用/兼容状态。**纯 metadata**：不读 quota、不读 record、不 import。
 *
 * 判定规则：
 *   - Connect：`ctx.get('openaiCodexTransport')` 非空 ⇒ `enabled:true, compatible:true`。
 *     （该服务由插件 fiber 在装载时构造，不联网、不读凭据；它没有额度方法，
 *     所以额度读取仍需走公开模块 —— 合同不匹配时取数层会报 incompatible。）
 *   - Subscription：先看只读 service；
 *     - 合同齐全 ⇒ `true/true`；
 *     - 服务在但合同不匹配（含未打补丁的旧版本）⇒ `true/false`（「接口不兼容/需要适配」）；
 *     - 服务不在 ⇒ 再看 loader 条目：目标插件**已激活**（`disabled===false` 且
 *       fiber ACTIVE）⇒ `true/false`（已激活但没装只读接口补丁）；
 *       否则（未安装 / 已停用 / 无法证明安装）⇒ `false/false`（统一「未启用」）。
 *
 * @param {object} ctx
 * @param {object} [options] 测试注入：`{ cfg, entries, connect, subscription }`
 * @returns {{sources:Array<{id:string,label:string,enabled:boolean,compatible:boolean}>, selected:string, unknown:boolean}}
 *   `unknown:true` 表示状态**不可证明**（`ctx.get` 抛错）；调用方必须 fail-closed，
 *   不能把这份结果当「未启用」发布。
 */
export function getCodexSourceState(ctx, options) {
  const opts = options !== null && options !== undefined && typeof options === 'object' ? options : {}
  const selected = opts.source !== undefined ? normalizeCodexSource(literalOf(opts.source)) : codexSourceOf(opts.cfg)

  const connect = opts.connect !== null && opts.connect !== undefined && typeof opts.connect === 'object'
    ? opts.connect
    : readCodexConnectTransport(ctx)
  const subscription = opts.subscription !== null && opts.subscription !== undefined
    && typeof opts.subscription === 'object'
    ? opts.subscription
    : readCodexSubscriptionService(ctx)

  const entries = Array.isArray(opts.entries)
    // 测试注入允许直接给数组（等价于 `{ known:true, list }`）。
    ? { known: true, list: opts.entries }
    : (opts.entries !== null && opts.entries !== undefined && typeof opts.entries === 'object'
      ? opts.entries
      : readLoaderEntries(ctx))

  const connectEnabled = connect.state === 'present'
  const connectCompatible = connectEnabled
  const connectUnknown = connect.state === 'unknown'

  let subscriptionEnabled = false
  let subscriptionCompatible = false
  let subscriptionUnknown = false
  if (subscription.state === 'ok') {
    subscriptionEnabled = true
    subscriptionCompatible = true
  } else if (subscription.state === 'incompatible') {
    subscriptionEnabled = true
    subscriptionCompatible = false
  } else if (subscription.state === 'unknown') {
    subscriptionUnknown = true
  } else if (Array.isArray(entries.list)
    && entries.list.some((entry) => entryIsActivePlugin(entry, SUBSCRIPTION_PACKAGE_NAME, SUBSCRIPTION_PLUGIN_NAME))) {
    // 已激活但上下文里没有只读服务 ⇒ 接口未适配，不能冒充「未启用」。
    subscriptionEnabled = true
    subscriptionCompatible = false
  }

  return {
    sources: [
      {
        id: CODEX_SOURCE_CONNECT,
        label: SOURCE_LABELS[CODEX_SOURCE_CONNECT],
        enabled: connectEnabled,
        compatible: connectCompatible,
      },
      {
        id: CODEX_SOURCE_SUBSCRIPTION,
        label: SOURCE_LABELS[CODEX_SOURCE_SUBSCRIPTION],
        enabled: subscriptionEnabled,
        compatible: subscriptionCompatible,
      },
    ],
    selected,
    unknown: connectUnknown || subscriptionUnknown,
  }
}

// ---------------------------------------------------------------------------
// 第三方失败码 → 固定安全错误（只做精确等值映射，绝不回显 message）
// ---------------------------------------------------------------------------

/**
 * 服务固定顶层码（`{ok:false, code}`）。
 *
 * [终审 B2 整改] 键必须是 service **真实返回的字符串**（闭集 5 个，见只读 service 的
 * `fail(...)` 调用），不是去掉前缀的短名：查表只做 `hasOwnProperty` 精确等值，
 * 写成 `BAD_REQUEST` 这类短名时 5 个真实码**一个都命中不了**，全部落到 generic。
 * 因此这里**只**有这一套键名，也不做前缀剥离的模糊匹配（那会引入第二套语汇）。
 */
const SERVICE_CODE_ERRORS = {
  E_CODEX_USAGE_BAD_REQUEST: {
    error: CODEX_ERROR_INCOMPATIBLE,
    transient: false,
    message: 'Codex Subscription 的只读接口拒绝了本次请求（接口版本不匹配）',
  },
  E_CODEX_USAGE_ABORTED: {
    error: 'exec',
    transient: true,
    message: 'Codex 额度读取已取消',
  },
  E_CODEX_SOURCE_CHANGED: {
    error: CODEX_ERROR_SOURCE_CHANGED,
    transient: true,
    message: 'Codex 来源或账号已变化，本次结果作废',
  },
  E_CODEX_USAGE_FAILED: {
    error: 'exec',
    transient: false,
    message: 'Codex 额度获取失败',
  },
  E_CODEX_USAGE_NOT_READY: {
    error: 'exec',
    transient: true,
    message: 'Codex 来源服务尚未就绪',
  },
}

/**
 * 原 usage handler 的**固定**失败文案（`{ok:false, error:{code:'internal', message}}`）。
 *
 * 只按**精确等值**匹配这几个已知文案；其它任何文案（含可能带上游正文的）
 * 一律落到 generic —— 服务给什么都不回显。
 */
const HANDLER_MESSAGE_ERRORS = {
  'ChatGPT subscription is not signed in': {
    error: 'signed-out',
    transient: false,
    message: '请先在 Codex Subscription 中登录 ChatGPT',
  },
  'ChatGPT sign-in needs to be renewed': {
    error: 'reauth-required',
    transient: false,
    message: 'Codex Subscription 登录已过期，请重新登录 ChatGPT',
  },
}

const GENERIC_SUBSCRIPTION_ERROR = Object.freeze({
  error: 'exec',
  transient: false,
  message: 'Codex 额度获取失败',
})

function ownLookup(table, key) {
  if (typeof key !== 'string' || key.length === 0) return null
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null
}

/**
 * 把只读 service 的失败结果映射成固定 `{ error, transient, message }`。
 *
 * 两种失败形状都接受，且**从不**把 message / details 透给调用方。
 */
export function subscriptionFailureOf(result) {
  if (result === null || typeof result !== 'object') return { ...GENERIC_SUBSCRIPTION_ERROR }
  const code = typeof result.code === 'string' ? result.code : ''
  const byCode = ownLookup(SERVICE_CODE_ERRORS, code)
  if (byCode !== null) return { ...byCode }
  const nested = result.error !== null && typeof result.error === 'object' ? result.error : null
  const message = nested !== null && typeof nested.message === 'string' ? nested.message : ''
  const byMessage = ownLookup(HANDLER_MESSAGE_ERRORS, message)
  if (byMessage !== null) return { ...byMessage }
  return { ...GENERIC_SUBSCRIPTION_ERROR }
}
