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
  const account = ctx.get('deepseekAccount')
  if (account === undefined || typeof account.getBalance !== "function") return null
  try {
    const summary = await account.getBalance(CLIENT_METADATA)
    if (summary === null || typeof summary !== "object") return null
    const normal = pickBalance(summary.normal_wallets)
    const bonus = pickBalance(summary.bonus_wallets)
    // 赠金与普通余额相加；两者都缺失才算读取失败。
    if (normal === null && bonus === null) return null
    return { balance: (normal || 0) + (bonus || 0), isAvailable: true }
  } catch (err) {
    // 未登录、凭证过期或 Platform 不可达：交给 API Key 回退处理。
    return null
  }
}

/** 拉取 DeepSeek 余额：优先 DSH 账号，回退开放平台 API Key。 */
export async function fetchPlan(ctx, shell, cfg) {
  // 1) 账号余额（桌面端登录即可用，无需任何 Key）
  const viaAccount = await fetchAccountBalance(ctx)
  if (viaAccount !== null) {
    return Object.assign(planBase(plan), viaAccount, { via: 'account' })
  }

  // 2) 回退：开放平台 API Key
  const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
  if (apiKey === undefined) {
    return Object.assign(noKey(plan), {
      message: 'DSH 账号未登录，且未配置 DeepSeek API Key：请在桌面端登录账号，或在插件设置里填入 Key',
    })
  }
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      auth: apiKey,
      bearer: source.bearer,
    })
    if (err !== undefined) return Object.assign(planBase(plan), err)
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const cny = infos.find((b) => b && b.currency === "CNY")
    const info = cny !== undefined ? cny : infos[0]
    const balance = info !== undefined ? toNum(info.total_balance) : null
    return Object.assign(planBase(plan), {
      balance: balance,
      isAvailable: data.is_available === true,
      via: 'api',
    })
  } catch (err) {
    return execError(plan)
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
