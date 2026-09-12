/**
 * DeepSeek 官网 API 余额模块：`GET https://api.deepseek.com/user/balance`
 * （Bearer 鉴权）。返回账号剩余余额（人民币元），不涉及用量窗口。
 *
 * 与其他套餐模块相同的统一 plan 对象：
 *   { id, name, fields, schema, source, fetch }
 * - `fields`：配置扁平键里的字段名（enabled 开关 / apiKey 密钥）；
 * - `schema`：该套餐的配置 schema 字段（加入插件的 Config 对象）；
 * - `source`：余额端点、鉴权方式与凭据候选；
 * - `fetch(ctx, shell, cfg)`：取数 + 归一化，返回 wire 套餐对象。
 *
 * wire 对象携带 `balance`（number，剩余余额元）；余额低于 30 元时浏览器
 * 状态灯显示红灯（阈值在客户端 PLANS 表声明，见 client.js）。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, toNum, resolveApiKey, planBase, noKey, execError } from './util.js'

/** 该套餐的配置字段：`apiKey` 为插件级密钥（DeepSeek 开放平台 Key）。 */
const fields = { enabled: 'deepseekEnabled', apiKey: 'deepseekApiKey' }

const source = {
  endpoint: 'https://api.deepseek.com/user/balance',
  bearer: true,
  refs: ['DEEPSEEK_API_KEY'],
}

const plan = {
  id: 'deepseek',
  name: 'DeepSeek 官网',
  fields,
  schema: {
    deepseekEnabled: z.boolean().default(false),
    deepseekApiKey: z.string().role('secret'),
  },
  source,
}

/** 拉取 DeepSeek 官网 API 余额：取 CNY 的 total_balance（无则取第一个）。 */
export async function fetchPlan(ctx, shell, cfg) {
  const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
  if (apiKey === undefined) return noKey(plan)
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      auth: apiKey,
      bearer: source.bearer,
    })
    if (err !== undefined) return Object.assign(planBase(plan), err)
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const cny = infos.find((b) => b && b.currency === 'CNY')
    const info = cny !== undefined ? cny : infos[0]
    const balance = info !== undefined ? toNum(info.total_balance) : null
    return Object.assign(planBase(plan), {
      balance: balance,
      isAvailable: data.is_available === true,
    })
  } catch (err) {
    return execError(plan)
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
