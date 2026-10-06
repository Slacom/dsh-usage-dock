/**
 * DeepSeek 余额模块（双数据源，账号优先）：
 *
 * 1. **DSH 账号余额**（优先）：桌面端登录 DSH 账号后，Host 的 deepseekAccount
 *    服务即可读取 Platform 余额。它不需要 API Key，也不向插件暴露 token
 *    （账号控制器只提供安全的余额投影）。返回结构为
 *    { normal_wallets: [{currency, balance}], bonus_wallets: [...] }，
 *    赠金与普通余额一并计入显示。
 * 2. **DeepSeek 开放平台 API Key**（回退）：GET https://api.deepseek.com/user/balance
 *    （Bearer 鉴权），取 CNY 的 total_balance。
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
 * 读取 DSH 账号余额（正常余额 + 赠金）。
 * @returns { balance, isAvailable }；账号服务不可用/未登录/失败时返回 null 表示应回退。
 */
async function fetchAccountBalance(ctx) {
  const account = ctx.get("deepseekAccount")
  if (account === undefined) return { ok: false, reason: "账号服务未加载（deepseekAccount 不可用）" }
  if (typeof account.getBalance !== "function") return { ok: false, reason: "账号服务没有 getBalance 方法" }
  try {
    // Remote 契约：null（未登录）| { status: "ready", value: [...], bonusWallets: [...] } | { status: "failed" }
    const summary = await account.getBalance(CLIENT_METADATA)
    if (summary === null || summary === undefined) return { ok: false, reason: "账号未登录" }
    if (typeof summary !== "object") return { ok: false, reason: "账号返回了非对象结果" }
    if (summary.status === "failed") return { ok: false, reason: "账号余额读取失败（Platform 返回 failed）" }
    if (summary.status !== "ready") return { ok: false, reason: "账号返回未知状态: " + String(summary.status) }
    // value = 普通余额钱包；bonusWallets = 赠金钱包。
    const normal = pickBalance(summary.value)
    const bonus = pickBalance(summary.bonusWallets)
    if (normal === null && bonus === null) return { ok: false, reason: "账号余额为空" }
    return { ok: true, balance: (normal || 0) + (bonus || 0) }
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
      isAvailable: true,
      via: "account",
      warnThreshold: warnThresholdOf(cfg),
    })
  }

  // 2) 回退：开放平台 API Key
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
    return Object.assign(planBase(plan), {
      balance: balance,
      isAvailable: data.is_available === true,
      via: "api",
      warnThreshold: warnThresholdOf(cfg),
    })
  } catch (err) {
    return Object.assign(execError(plan), { message: "上游请求异常；账号侧：" + account.reason })
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
