/**
 * DeepSeek 余额模块（双数据源，账号优先）：
 *
 * 1. **DSH 账号余额**（优先）：桌面端登录 DSH 账号后，Host 的 deepseekAccount
 *    服务即可读取 Platform 余额。它不需要 API Key，也不向插件暴露 token
 *    （账号控制器只提供安全的余额投影）。返回结构为
 *    { normal_wallets: [{currency, balance}], bonus_wallets: [...] }，
 *    赠金与普通余额一并计入显示。
 * 2. **DeepSeek 开放平台 API Key**（回退）：GET https://api.deepseek.com/user/balance
 *    （Bearer 鉴权），取 CNY 的 total_balance，并同时映射 topped_up_balance（充值）与
 *    granted_balance（赠金）——两条数据源都要能给出详情面板的明细行。
 *
 * 账号服务只在 Desktop 组合里存在；缺失、未登录或读取失败时静默回退到 API Key，
 * 因此普通 Web 部署的行为与之前一致。
 *
 * 与其他渠道相同的统一 plan 对象：{ id, name, fields, schema, source, fetch }。
 *
 * wire 对象携带 balance（number，剩余余额元）与 via（account | api，说明数据来源）；
 * 余额低于 30 元时浏览器状态灯显示红灯（阈值见 client.js）。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, toNum, resolveApiKey, planBase, noKey, execError } from './util.js'

/** 该渠道的配置字段：apiKey 为可选的开放平台密钥（账号可用时不必填）。 */
const fields = { enabled: 'deepseekEnabled', apiKey: 'deepseekApiKey' }

const source = {
  endpoint: 'https://api.deepseek.com/user/balance',
  bearer: true,
  refs: ['DEEPSEEK_API_KEY'],
}

/** 余额警告阈值的默认值（元）：配置留空或为 0 时使用。 */
const DEFAULT_WARN_THRESHOLD = 10

/** 从配置解析警告阈值：非有限数或负数时回退默认值。 */
function warnThresholdOf(cfg) {
  const raw = cfg != null ? cfg.deepseekWarnThreshold : undefined
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WARN_THRESHOLD
}

/** 上报给 Platform 的客户端身份（影响服务端文案语言，不影响余额数值）。 */
const CLIENT_METADATA = {
  version: '0.4.0',
  locale: 'zh_CN',
  timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
}

const plan = {
  id: 'deepseek',
  name: 'DeepSeek',
  fields,
  schema: {
    deepseekEnabled: z.boolean().default(true),
    deepseekApiKey: z.string().role('secret'),
    // 余额低于该值时状态灯转为警告色；默认 10 元。0 表示不警告。
    deepseekWarnThreshold: z.number().min(0).default(10),
  },
  source,
}

/** 从钱包数组里挑出 CNY（找不到则取第一个）并解析为数字。 */
function pickBalance(wallets) {
  const list = Array.isArray(wallets) ? wallets.filter((w) => w != null && typeof w === "object") : []
  const cny = list.find((w) => w.currency === "CNY")
  const picked = cny !== undefined ? cny : list[0]
  if (picked === undefined) return null
  return toNum(picked.balance)
}

/**
 * [local patch 0.8.0] 给 Promise 包一个超时。deepseekAccount.getBalance 内部没有
 * 超时控制（roadmap 方向 3 排查结论）：Platform 慢响应会拖住整个 /api/plan-usage
 * 的 Promise.all，其他渠道明明取到了数据也被一起挂着。超时按「账号侧失败」处理，
 * 正常回退 API Key 路径。
 */
function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: label + "（" + Math.round(ms / 1000) + " 秒超时）" }), ms)
    }),
  ]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

/** 账号余额读取的超时上限（毫秒）：[0.8.3] 20s → 30s，与 plans/util.js 的
 * 单请求超时（REQUEST_TIMEOUT_MS=30000）对齐——账号侧慢响应不再过早判失败。 */
const ACCOUNT_TIMEOUT_MS = 30000

/**
 * 读取 DSH 账号余额（正常余额 + 赠金）。
 * @returns { balance, isAvailable }；账号服务不可用/未登录/失败时返回 null 表示应回退。
 */
async function fetchAccountBalance(ctx) {
  const account = ctx.get("deepseekAccount")
  if (account == null) return { ok: false, reason: "账号服务未加载（deepseekAccount 不可用）" }
  if (typeof account.getBalance !== "function") return { ok: false, reason: "账号服务没有 getBalance 方法" }
  try {
    // Remote 契约：null（未登录）| { status: "ready", value: [...], bonusWallets: [...] } | { status: "failed" }
    // [local patch 0.8.0] 包 20s 超时，防止慢响应拖死整个 Promise.all。
    const summary = await withTimeout(
      Promise.resolve(account.getBalance(CLIENT_METADATA)),
      ACCOUNT_TIMEOUT_MS,
      "账号余额读取失败",
    )
    if (summary === null || summary === undefined) return { ok: false, reason: "账号未登录" }
    if (typeof summary !== "object") return { ok: false, reason: "账号返回了非对象结果" }
    if (summary.status === "failed") return { ok: false, reason: "账号余额读取失败（Platform 返回 failed）" }
    if (summary.status !== "ready") return { ok: false, reason: "账号返回未知状态: " + String(summary.status) }
    // value = 普通余额钱包；bonusWallets = 赠金钱包。
    const normal = pickBalance(summary.value)
    const bonus = pickBalance(summary.bonusWallets)
    if (normal === null && bonus === null) return { ok: false, reason: "账号余额为空" }
    // [0.8.3] 赠金单独回传（不再只是「看不见的合并」）：详情面板按 MiMo 的方式
    // 分「充值余额 / 赠金余额」两行显示（用户 2026-10-17 要求）。
    // balance 仍是两者之和（胶囊按钮显示总计）；cashBalance/bonusBalance 供明细行。
    return {
      ok: true,
      balance: (normal || 0) + (bonus || 0),
      cashBalance: normal === null ? null : normal,
      bonusBalance: bonus === null ? null : bonus,
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    return { ok: false, reason: "账号余额读取失败: " + msg }
  }
}

/** 拉取 DeepSeek 余额：优先 DSH 账号，回退开放平台 API Key。 */
export async function fetchPlan(ctx, shell, cfg) {
  // 1) 账号余额（桌面端登录即可用，无需任何 Key）
  const account = await fetchAccountBalance(ctx)
  if (account.ok) {
    return Object.assign(planBase(plan), {
      balance: account.balance,
      // [0.8.3] 赠金明细（账号模式）：供详情面板拆行显示；无赠金时为 null。
      cashBalance: account.cashBalance,
      bonusBalance: account.bonusBalance,
      isAvailable: true,
      via: "account",
      warnThreshold: warnThresholdOf(cfg),
    })
  }

  // 2) 回退：开放平台 API Key
  // [0.8.3] 哨兵/占位 Key（如用户为「屏蔽 API 版模型」而设的 `1`）已在 resolveApiKey
  // 里被剔除，这里拿到的 undefined 表示「确实没有可用 Key」。此时不再向上游发注定
  // 401 的请求，直接以账号侧原因为主因回报（用户实测该文案最能说明问题）。
  const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
  if (apiKey === undefined) {
    return Object.assign(noKey(plan), {
      message: "账号余额不可用（" + account.reason + "），且未配置 DeepSeek API Key",
    })
  }
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      auth: apiKey,
      bearer: source.bearer,
    })
    if (err !== undefined) {
      // API Key 回退也失败时，把账号侧原因一并带上，便于定位。
      return Object.assign(planBase(plan), err, {
        message: (err.message || "DeepSeek 余额获取失败") + "（API Key 方式；账号侧：" + account.reason + "）",
      })
    }
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const cny = infos.find((b) => b && b.currency === "CNY")
    const info = cny !== undefined ? cny : infos[0]
    const balance = info !== undefined ? toNum(info.total_balance) : null
    // [0.8.3] 开放平台 /user/balance 也带明细：topped_up_balance（充值）/ granted_balance（赠金）。
    // 此前只映射了 total_balance，于是 **API Key 模式**（没有 deepseekAccount 的设备，如
    // DSHA / 平板，或账号未登录时）详情面板只有总额、没有「充值余额 / 赠金余额」两行——
    // 用户 2026-10-17 发现的两条路径不一致。缺失字段交给 toNum 返回 null（面板只显示总额），
    // 不能伪造成 0，否则会把「接口没给」画成「赠金是 0 元」。
    const cashBalance = info !== undefined ? toNum(info.topped_up_balance) : null
    const bonusBalance = info !== undefined ? toNum(info.granted_balance) : null
    return Object.assign(planBase(plan), {
      balance: balance,
      cashBalance: cashBalance,
      bonusBalance: bonusBalance,
      isAvailable: data.is_available === true,
      via: "api",
      warnThreshold: warnThresholdOf(cfg),
    })
  } catch (err) {
    return Object.assign(execError(plan), { message: "上游请求异常；账号侧：" + account.reason })
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
