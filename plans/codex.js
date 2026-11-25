/**
 * OpenAI Codex 订阅额度模块：**唯一来源 = 本插件自持的 ChatGPT 账号**（`account`）。
 *
 * 历史：0.10.0 起曾按配置 `codexSource` 在 `connect`（复用 `dsh-codex-connect` 已登录的
 * ChatGPT OAuth）/ `subscription`（第三方只读 service）/ `account` 三来源间**手选**。
 * [2026-11-23 用户确认] `connect` 与 `subscription` **退场**，只保留本插件自己的
 * ChatGPT 账号登录；`codexSource` 配置字段与 wire 上的 `codexSource:'account'` 仍然保留，
 * 只为兼容旧配置 / 旧摘要 / 旧 wire，**不再参与分派**（`fetchPlan` 恒走 account）。
 *
 * 边界：
 *   - 凭据读写、设备码登录、token 刷新、额度请求全在 `plans/codex-account.js`；
 *     本模块只把它的 Connect 形状投影交给同一套归一化，**不**回退任何其它来源；
 *   - 多账户由 `codex-account.js` 管理（1..8 个，active 唯一），本模块只消费 **active** 账户的
 *     额度结果，不认识也不接触其它账户的 token；
 *   - 本模块不 import 任何第三方插件模块。
 *
 * 归一化（`normalizeCodexUsage`）与 wire 形状保持不变：
 * 5 小时 / 周窗口（按 `windowSeconds` 挑，缺失就缺席，不伪造；月额度恒 `null`）、credits、
 * individualLimit。窗口的重置时间在 `codex-account.js` 里统一成 Unix **秒**（`resetAt`），
 * 转 ISO 时才 ×1000。
 *
 * 安全失败面：
 *   - 未登录 / 坏记录 / 读不到 / 需要重新登录：固定错误码与固定中文文案（来自
 *     `plans/codex-account.js`），不含上游正文；
 *   - 未知错误只给 generic 文案，**绝不**输出 `error.message` 原文。
 */
import z from '@deepseek-ai/schemastery'
import { planBase } from './util.js'
import { CODEX_SOURCE_ACCOUNT } from './codex-sources.js'
import { fetchCodexAccountUsage } from './codex-account.js'

const FIVE_HOURS_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60
const MONTH_SECONDS = 30 * 24 * 60 * 60

/** 本插件 account 通道的窗口重置字段名（Unix 秒，**不**是毫秒）。 */
const ACCOUNT_RESET_KEY = 'resetAt'

/**
 * Codex 的配置字段名。
 *
 * `source` 仍然指到 `codexSource`：字段本身保留（旧 YAML / 旧摘要 / 旧 wire 都还带着它），
 * 但取数**不再读它**。默认值也保持 `'connect'` 字面量，理由同上 —— 只是为了让旧配置
 * 继续按原样校验通过；实际行为由「只剩 account 一条来源」决定，与本字段无关。
 */
const fields = { enabled: 'codexEnabled', source: 'codexSource' }

const plan = {
  id: 'codex',
  name: 'OpenAI Codex',
  fields,
  schema: {
    codexEnabled: z.boolean().default(true),
    /**
     * [2026-11-23 退场后] `'connect' | 'subscription'` 已不可选，`'account'` 是唯一实际生效的
     * 来源；这个字段现在只承担「旧配置/旧摘要仍然能读」的兼容作用。
     *
     * 保留 `z.string()` 与本默认值的原因：
     *   1. 手改 YAML 里还写着 connect/subscription 的老配置不会因校验失败而整体被拒；
     *   2. 归一化词表仍在 `plans/codex-sources.js`（`normalizeCodexSource`），本模块不再用；
     *   3. DSH 的设置表单按类型渲染控件，字符串字段是最保守的形态。
     */
    codexSource: z.string().default('connect'),
  },
  source: {
    /**
     * 不再有第三方 provider：Codex 凭据与取数都只在本插件内（`plans/codex-account.js`）。
     * 保留 `oauth:true` 表明它是账号型渠道（index.js 的身份体系走 ACCOUNT_BOUND_PLAN_IDS）。
     */
    providers: [],
    oauth: true,
  },
}

/**
 * 归一化单个窗口。
 *
 * @param {object} window 上游窗口
 * @param {string} resetKey 重置时间字段名（account 通道是 Unix 秒）
 */
function normalizeWindow(window, resetKey) {
  if (window === null || window === undefined || typeof window !== 'object') return null
  const remaining = window.remainingPercent
  const duration = window.windowSeconds
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)
    || remaining < 0 || remaining > 100
    || typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) return null
  // 公开语义是「剩余额度百分比」：保持原义，不反转成已用量。
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
 * usage 投影 → plan-usage 的统一 wire 主体（不含 id/name/source）。
 *
 * 只读 `rateLimits` 里 `id === 'codex'` 的**主桶**与 `credits` / `individualLimit`；
 * `chatPass` / `resetCredits` 不参与主余额，也不相加。
 *
 * @param {object} usage `plans/codex-account.js` 的 Connect 形状投影
 * @param {{resetKey:string}} spec 窗口重置字段名
 * @returns {object|null} 全空时返回 null（由调用方报 quota-unavailable）
 */
export function normalizeCodexUsage(usage, spec) {
  const resetKey = spec !== null && spec !== undefined && typeof spec.resetKey === 'string'
    ? spec.resetKey
    : ACCOUNT_RESET_KEY
  const limits = usage !== null && usage !== undefined && Array.isArray(usage.rateLimits) ? usage.rateLimits : []
  const primary = limits.find((limit) => limit !== null && limit !== undefined && limit.id === 'codex')
  const windows = primary !== null && primary !== undefined && Array.isArray(primary.windows) ? primary.windows : []
  const rollingUsage = findWindow(windows, FIVE_HOURS_SECONDS, resetKey)
  const weeklyUsage = findWindow(windows, WEEK_SECONDS, resetKey)
  /**
   * [0.11.4 用户要求] Codex **不再展示「月额度」**：Codex 订阅实际只有 5 小时 + 周两个窗口，
   * 上游投影里偶尔带回来的 43200 分钟窗口在界面上只是一行「—」。
   *
   * 这里仍然解析一次用于「是否全空」的判断（只剩月窗口也算有数据，不该冒充 quota-unavailable），
   * 但**不放进 wire**：`monthlyUsage` 恒为 `null`，胶囊 / 详情面板 / 原生面板 / usage_status 工具
   * 都按字段是否为 null 自动跳过，不会出现空的月额度行。
   */
  const monthlyOnly = findWindow(windows, MONTH_SECONDS, resetKey)
  const credits = usage !== null && usage !== undefined
    && usage.credits !== null && typeof usage.credits === 'object' ? usage.credits : null
  const individual = usage !== null && usage !== undefined
    && usage.individualLimit !== null && typeof usage.individualLimit === 'object'
    ? usage.individualLimit
    : null
  if (rollingUsage === null && weeklyUsage === null && monthlyOnly === null
    && credits === null && individual === null) return null
  return {
    rollingUsage,
    weeklyUsage,
    // 恒 null：见上面的说明（界面按 null 跳过）。
    monthlyUsage: null,
    creditsUnlimited: credits !== null && credits.unlimited === true,
    creditsBalance: credits !== null ? safeAmount(credits.balance) : null,
    individualLimit: individual !== null ? {
      limit: safeAmount(individual.limit),
      used: safeAmount(individual.used),
      /**
       * 上游带精确的 `remaining` 字符串就原样保留；没有就 `null`，
       * 绝不凭浮点百分比反推精确金额。
       */
      remaining: safeAmount(individual.remaining),
      remainingPercent: safePercent(individual.remainingPercent),
    } : null,
  }
}

/**
 * 构造一份 Codex plan（默认依赖用于生产；测试可注入 `fetchCodexAccountUsage`）。
 *
 * 注入点只用于**测试替身**：生产路径永远是 `plans/codex-account.js` 的真实实现，
 * 不接受任何外部 URL / handler / 参数输入。业务上没有别的来源可回退。
 */
export function createCodexPlan(deps) {
  const options = deps !== null && deps !== undefined && typeof deps === 'object' ? deps : {}
  const readAccountUsage = typeof options.fetchCodexAccountUsage === 'function'
    ? options.fetchCodexAccountUsage
    : fetchCodexAccountUsage

  /** wire 的固定头：`id` / `name` / 旧兼容用的 `codexSource`。 */
  const wireBase = () => Object.assign(planBase(plan), { codexSource: CODEX_SOURCE_ACCOUNT })

  const failureWire = (error, message, extra) => Object.assign(
    wireBase(),
    { error, message },
    extra !== null && extra !== undefined ? extra : {},
  )

  const usageWire = (usage) => {
    const normalized = normalizeCodexUsage(usage, { resetKey: ACCOUNT_RESET_KEY })
    if (normalized === null) {
      return failureWire('quota-unavailable', '已登录，但当前账户未返回可显示的额度')
    }
    return Object.assign(wireBase(), normalized)
  }

  /**
   * 唯一取数路径：本插件自持 ChatGPT 账号（active 账户）的额度。
   *
   * 边界：
   *   - 失败**不**回退任何其它来源（来源已退场）；
   *   - 错误码 / 文案全部来自 `plans/codex-account.js` 的固定值（不含上游正文）；
   *   - `fetchedAt`（毫秒）如实透传 —— 它是本次真正读到上游的时间。
   */
  async function readFromAccount(ctx, fetchOptions) {
    const signal = fetchOptions !== null && fetchOptions !== undefined ? fetchOptions.signal : undefined
    let result
    try {
      result = await readAccountUsage(ctx, { signal })
    } catch (err) {
      // `fetchCodexAccountUsage` 合同里不抛；万一抛了也按暂时失败处理，不外泄原因。
      return failureWire('exec', 'Codex 额度获取失败', { transient: true })
    }
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      const failure = result !== null && typeof result === 'object' ? result : {}
      const error = typeof failure.error === 'string' && failure.error.length > 0 ? failure.error : 'exec'
      const message = typeof failure.message === 'string' && failure.message.length > 0
        ? failure.message
        : 'Codex 额度获取失败'
      return failureWire(error, message,
        failure.transient === true ? { transient: true } : undefined)
    }
    const usage = result.usage
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
      // `{ok:true}` 不等于「有值」：坏形状按硬失败处理，绝不伪造窗口/百分比。
      return failureWire('exec', 'Codex 额度获取失败')
    }
    const wire = usageWire(usage)
    if (typeof usage.fetchedAt === 'number' && Number.isFinite(usage.fetchedAt) && usage.fetchedAt > 0) {
      wire.fetchedAt = usage.fetchedAt
    }
    return wire
  }

  /**
   * 拉取 Codex 额度（**只有 account 一条来源**）。
   *
   * `cfg` 仍接收但**不读**：`codexSource` 字段已退化为兼容字段。签名保持
   * `(ctx, shell, cfg, fetchOptions)` 以免打乱调用方。
   */
  async function fetchPlan(ctx, shell, cfg, fetchOptions) {
    void shell
    void cfg
    return readFromAccount(ctx, fetchOptions)
  }

  return { plan, fetch: fetchPlan }
}

const instance = createCodexPlan()

/** 注册表使用的取数入口。 */
export const fetchPlan = instance.fetch

export default Object.assign(instance.plan, { fetch: instance.fetch })
