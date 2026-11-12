/**
 * OpenAI Codex 订阅额度模块：**双来源**，按配置 `codexSource` 分派，只取选中的那一个。
 *
 *   - `connect`（缺省，保旧）：复用 `dsh-codex-connect` 已登录的 ChatGPT OAuth，
 *     调用其公开 API `readOpenAICodexRateLimits(new OpenAICodexCredentialStore())`。
 *     OAuth access/refresh token 与 account id 均由 Codex Connect 自己管理，
 *     本模块只接收脱敏后的 rateLimits / credits / individualLimit 投影 ——
 *     **不**调用 `store.read`、**不**解析任何凭据文件。
 *   - `subscription`：只经第三方只读 service `ctx.get('codexSubscriptionUsage')`
 *     （合同见 `plans/codex-sources.js` 头注释）。本模块**不**自己 fetch URL、
 *     **不**自建 credential store、**不**读 token：授权、TTL、缓存、账号绑定
 *     全部由该 service 内部的原 usage handler 负责。只取**主 Codex 桶**
 *     （`rateLimits[].id === 'codex'`）；`additional_*` / `code_review` 等附加桶
 *     不合并、不冒充主额度。
 *
 * 两条路径共用**同一份**归一化与 wire 形状（`normalizeCodexUsage`）：
 * 5 小时 / 周 / 月窗口（按 `windowSeconds` 挑，缺失就缺席，不伪造）、credits、
 * individualLimit。单位：两家窗口的重置时间都是 **Unix 秒**（Connect 字段名
 * `resetAt`，Subscription 字段名 `resetsAt`）；转换为 ISO 时才 ×1000。
 *
 * 安全失败面：
 *   - 未安装 / 未开启 ⇒ `not-enabled`（界面统一「未启用」，**不**回退另一来源）；
 *   - 接口合同不匹配 ⇒ `incompatible`（「接口不兼容/需要适配」，不是「未启用」）；
 *   - 读取期间来源/账号变化 ⇒ `source-changed`（无 value，作废）；
 *   - 未知错误只给 generic 文案，**绝不**输出 `error.message` 原文。
 */
import z from '@deepseek-ai/schemastery'
import { planBase } from './util.js'
import {
  CODEX_SOURCE_CONNECT,
  CODEX_SOURCE_SUBSCRIPTION,
  CODEX_SOURCES,
  CODEX_ERROR_NOT_ENABLED,
  CODEX_ERROR_INCOMPATIBLE,
  CODEX_ERROR_SOURCE_CHANGED,
  codexSourceOf,
  codexSourceProvider,
  normalizeCodexSource,
  readCodexConnectTransport,
  readCodexSubscriptionService,
  subscriptionFailureOf,
} from './codex-sources.js'

const FIVE_HOURS_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60
const MONTH_SECONDS = 30 * 24 * 60 * 60

/** Connect 的窗口重置字段名（Unix 秒）。 */
const CONNECT_RESET_KEY = 'resetAt'
/** Subscription 的窗口重置字段名（同样 Unix 秒，**不**是毫秒）。 */
const SUBSCRIPTION_RESET_KEY = 'resetsAt'

const fields = { enabled: 'codexEnabled', source: 'codexSource' }

const plan = {
  id: 'codex',
  name: 'OpenAI Codex',
  fields,
  schema: {
    codexEnabled: z.boolean().default(true),
    /**
     * [2026-11-11 双来源] `'connect' | 'subscription'`，缺省 `'connect'`（保旧）。
     *
     * 用 `z.string()` 而不是 `z.union([z.const(..)])`：
     *   1. 手改 YAML 写错值时不会因 schema 校验失败而拒绝整个插件配置；
     *   2. 归一（未知 → connect）由 `normalizeCodexSource` 唯一负责，
     *      与读配置、算摘要、探状态三处共用同一规则；
     *   3. DSH 的设置表单按类型渲染控件，字符串字段是最保守的形态。
     */
    codexSource: z.string().default(CODEX_SOURCE_CONNECT),
  },
  source: {
    /**
     * 运行期 provider 由 `codexSource` 决定（`codexSourceProvider()` / wire 的
     * `codexSource` 字段）；这里只声明**可能的**第三方依赖，不再固定绑定 Connect。
     * index.js 的身份体系对 codex 走账号型分支（ACCOUNT_BOUND_PLAN_IDS），不读它。
     */
    providers: CODEX_SOURCES.map((source) => codexSourceProvider(source)),
    oauth: true,
  },
}

/**
 * 归一化单个窗口。
 *
 * @param {object} window 上游窗口
 * @param {string} resetKey 重置时间字段名（两家都是 Unix 秒）
 */
function normalizeWindow(window, resetKey) {
  if (window === null || window === undefined || typeof window !== 'object') return null
  const remaining = window.remainingPercent
  const duration = window.windowSeconds
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)
    || remaining < 0 || remaining > 100
    || typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) return null
  // 两家的公开语义都是「剩余额度百分比」：保持原义，不反转成已用量。
  // `remaining === 0` 是**有效**值（额度用尽），绝不当缺数据。
  const remainingRounded = Math.round(remaining * 10) / 10
  let resetsAt = null
  const rawReset = window[resetKey]
  if (typeof rawReset === 'number' && Number.isSafeInteger(rawReset) && rawReset > 0) {
    // Unix **秒** → 毫秒只在转 ISO 时做一次；溢出/非法时间给 null，不硬造日期。
    const date = new Date(rawReset * 1000)
    if (Number.isFinite(date.getTime())) resetsAt = date.toISOString()
  }
  return { status: null, percent: remainingRounded, resetsAt, resetInSec: null }
}

function findWindow(windows, seconds, resetKey) {
  if (!Array.isArray(windows)) return null
  const hit = windows.find((window) => window && window.windowSeconds === seconds)
  return normalizeWindow(hit, resetKey)
}

/** 只接受严格十进制字符串（不折算成 0、不做浮点近似）。 */
function safeAmount(value) {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value) ? value : null
}

function safePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

/**
 * 两家 usage 投影 → plan-usage 的统一 wire 主体（不含 id/name/source）。
 *
 * 只读 `rateLimits` 里 `id === 'codex'` 的**主桶**与 `credits` / `individualLimit`；
 * `chatPass` / `resetCredits` 不参与主余额，也不相加。
 *
 * @param {object} usage 第三方脱敏 usage 投影
 * @param {{resetKey:string}} spec 窗口重置字段名
 * @returns {object|null} 全空时返回 null（由调用方报 quota-unavailable）
 */
export function normalizeCodexUsage(usage, spec) {
  const resetKey = spec !== null && spec !== undefined && typeof spec.resetKey === 'string'
    ? spec.resetKey
    : CONNECT_RESET_KEY
  const limits = usage !== null && usage !== undefined && Array.isArray(usage.rateLimits) ? usage.rateLimits : []
  const primary = limits.find((limit) => limit !== null && limit !== undefined && limit.id === 'codex')
  const windows = primary !== null && primary !== undefined && Array.isArray(primary.windows) ? primary.windows : []
  const rollingUsage = findWindow(windows, FIVE_HOURS_SECONDS, resetKey)
  const weeklyUsage = findWindow(windows, WEEK_SECONDS, resetKey)
  const monthlyUsage = findWindow(windows, MONTH_SECONDS, resetKey)
  const credits = usage !== null && usage !== undefined
    && usage.credits !== null && typeof usage.credits === 'object' ? usage.credits : null
  const individual = usage !== null && usage !== undefined
    && usage.individualLimit !== null && typeof usage.individualLimit === 'object'
    ? usage.individualLimit
    : null
  if (rollingUsage === null && weeklyUsage === null && monthlyUsage === null
    && credits === null && individual === null) return null
  return {
    rollingUsage,
    weeklyUsage,
    monthlyUsage,
    creditsUnlimited: credits !== null && credits.unlimited === true,
    creditsBalance: credits !== null ? safeAmount(credits.balance) : null,
    individualLimit: individual !== null ? {
      limit: safeAmount(individual.limit),
      used: safeAmount(individual.used),
      /**
       * Connect 有精确的 `remaining` 字符串，原样保留；
       * Subscription 的 individualLimit **没有** `remaining`（只有 limit/used/
       * remainingPercent）⇒ 这里保持 `null`，绝不凭浮点百分比反推精确金额。
       */
      remaining: safeAmount(individual.remaining),
      remainingPercent: safePercent(individual.remainingPercent),
    } : null,
  }
}

/** Connect 侧的固定文案（未知错误只给 generic，不回显原文）。 */
function connectFailureOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('signed out')) {
    return { error: 'signed-out', message: '请先在「设置 → 插件 → Codex Connect」中登录 ChatGPT' }
  }
  if (message.includes('authorization must be renewed')) {
    return { error: 'reauth-required', message: 'Codex Connect 登录已过期，请重新登录 ChatGPT' }
  }
  if (message.includes('Cannot find package') || message.includes('Cannot find module')) {
    return { error: 'not-installed', message: '未安装 dsh-codex-connect' }
  }
  return { error: 'exec', message: 'Codex 额度获取失败' }
}

/**
 * 构造一份 Codex plan（默认导出用默认依赖；测试可注入 `importConnectModule`）。
 *
 * 注入点只用于**测试替身**：生产路径永远是真实 `import('dsh-codex-connect')`，
 * 不接受任何外部 URL / handler / 参数输入。
 */
export function createCodexPlan(deps) {
  const options = deps !== null && deps !== undefined && typeof deps === 'object' ? deps : {}
  const importConnectModule = typeof options.importConnectModule === 'function'
    ? options.importConnectModule
    : () => import('dsh-codex-connect')

  const wireBase = (source) => Object.assign(planBase(plan), { codexSource: source })

  const failureWire = (source, error, message, extra) => Object.assign(
    wireBase(source),
    { error, message },
    extra !== null && extra !== undefined ? extra : {},
  )

  const usageWire = (source, usage, resetKey) => {
    const normalized = normalizeCodexUsage(usage, { resetKey })
    if (normalized === null) {
      return failureWire(source, 'quota-unavailable', '已登录，但当前账户未返回可显示的额度')
    }
    return Object.assign(wireBase(source), normalized)
  }

  /** 旧 Connect 路径：guard 通过才 import 公开模块 / 构造 store / 调额度函数。 */
  async function readFromConnect(ctx) {
    const guard = readCodexConnectTransport(ctx)
    if (guard.state === 'unknown') {
      return failureWire(CODEX_SOURCE_CONNECT, CODEX_ERROR_NOT_ENABLED, '无法确认 Codex Connect 的状态，已停止取数')
    }
    if (guard.state === 'absent') {
      // 未安装 / 未开启统一「未启用」：**不**回退、**不**读任何凭据文件。
      return failureWire(CODEX_SOURCE_CONNECT, CODEX_ERROR_NOT_ENABLED, '未启用：未安装或未开启 Codex Connect')
    }
    let mod
    try {
      mod = await importConnectModule()
    } catch (error) {
      const failure = connectFailureOf(error)
      return failureWire(CODEX_SOURCE_CONNECT, failure.error, failure.message)
    }
    if (typeof mod.readOpenAICodexRateLimits !== 'function'
      || typeof mod.OpenAICodexCredentialStore !== 'function') {
      return failureWire(CODEX_SOURCE_CONNECT, CODEX_ERROR_INCOMPATIBLE,
        '当前 dsh-codex-connect 版本不提供额度读取接口')
    }
    let usage
    try {
      // 由 Connect 的公开 SDK 自行处理 OAuth；本模块不碰 token、不读凭据文件。
      usage = await mod.readOpenAICodexRateLimits(new mod.OpenAICodexCredentialStore())
    } catch (error) {
      const failure = connectFailureOf(error)
      return failureWire(CODEX_SOURCE_CONNECT, failure.error, failure.message)
    }
    return usageWire(CODEX_SOURCE_CONNECT, usage, CONNECT_RESET_KEY)
  }

  /**
   * Subscription 路径：只经只读 service，绝不 fallback 到 Connect。
   *
   * 读前捕获 service 对象 + revision，读后再取一次并比较：
   *   - `ctx.get` 返回的是**同一个对象**（防卸载/换服务）；
   *   - revision 未变（防账号切换 / ABA）。
   * 任一不满足 ⇒ `source-changed`，**不**返回任何数值。
   */
  async function readFromSubscription(ctx, fetchOptions) {
    const before = readCodexSubscriptionService(ctx)
    if (before.state === 'unknown') {
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, CODEX_ERROR_NOT_ENABLED, '无法确认 Codex Subscription 的状态，已停止取数')
    }
    if (before.state === 'absent') {
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, CODEX_ERROR_NOT_ENABLED,
        '未启用：未安装或未开启 Codex Subscription')
    }
    if (before.state === 'incompatible') {
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, CODEX_ERROR_INCOMPATIBLE,
        '当前 Codex Subscription 未提供可用的只读额度接口（需要适配）')
    }
    const signal = fetchOptions !== null && fetchOptions !== undefined ? fetchOptions.signal : undefined
    let result
    try {
      // 调用 payload **只有** signal：不传 force、不传 URL、不传账号。
      result = await before.service.readUsage({ signal })
    } catch (error) {
      // service 合同要求不抛；万一抛了也不外泄原因，按暂时失败处理。
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, 'exec', 'Codex 额度获取失败', { transient: true })
    }
    const after = readCodexSubscriptionService(ctx)
    if (after.state !== 'ok' || after.service !== before.service || after.revision !== before.revision) {
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, CODEX_ERROR_SOURCE_CHANGED,
        'Codex 来源或账号已变化，本次结果作废', { transient: true })
    }
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      const failure = subscriptionFailureOf(result)
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, failure.error, failure.message,
        failure.transient === true ? { transient: true } : undefined)
    }
    const usage = result.value
    /**
     * [终审 N3 整改] `{ok:true}` 不等于「有值」：service 违反合同时 `value` 可能是
     * `null` / 字符串 / 数组。直接进归一化会读出「空额度」（`quota-unavailable`），
     * 读 `usage.fetchedAt` 还会抛 `TypeError` 落进通用兜底 —— 两者都会把
     * 「对方给了错东西」说成「这个账号没有额度」。这里按**硬失败**处理，
     * 且**不**伪造任何窗口/百分比/credits。
     */
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
      return failureWire(CODEX_SOURCE_SUBSCRIPTION, 'exec', 'Codex 额度获取失败')
    }
    const wire = usageWire(CODEX_SOURCE_SUBSCRIPTION, usage, SUBSCRIPTION_RESET_KEY)
    /**
     * 原采样时间（`usage.fetchedAt`，毫秒）如实透传：它表示 service 内部那次
     * 读取的时间，不是本轮「假新鲜」。缺失就不写（由 Host 按本轮时间处理）。
     */
    if (typeof usage.fetchedAt === 'number' && Number.isFinite(usage.fetchedAt) && usage.fetchedAt > 0) {
      wire.fetchedAt = usage.fetchedAt
    }
    return wire
  }

  /** 拉取 Codex 额度（按配置选中的来源，只取这一个）。 */
  async function fetchPlan(ctx, shell, cfg, fetchOptions) {
    void shell
    const source = codexSourceOf(cfg)
    if (source === CODEX_SOURCE_SUBSCRIPTION) return readFromSubscription(ctx, fetchOptions)
    return readFromConnect(ctx)
  }

  return { plan, fetch: fetchPlan }
}

const instance = createCodexPlan()

/** 默认来源为 connect 的实例（注册表使用）。 */
export const fetchPlan = instance.fetch

/** 供测试/工具复用：归一化的来源枚举。 */
export { normalizeCodexSource, CODEX_SOURCE_CONNECT, CODEX_SOURCE_SUBSCRIPTION }

export default Object.assign(instance.plan, { fetch: instance.fetch })
