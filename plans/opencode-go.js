/**
 * OpenCode Go 套餐模块：`https://opencode.ai/zen/go/v1/usage`（Bearer 鉴权）。
 * 返回 usage 结构（+useBalance：超出限额后将使用 Zen 余额）。
 *
 * 每个套餐模块的默认导出都是一个统一的 plan 对象：
 *   { id, name, fields, schema, source, fetch }
 * - `fields`：配置扁平键里的字段名（enabled 开关 / apiKey 密钥）；
 * - `schema`：该套餐的配置 schema 字段（加入插件的 Config 对象）；
 * - `source`：用量端点、鉴权方式与凭据候选；
 * - `fetch(ctx, shell, cfg)`：取数 + 归一化，返回 wire 套餐对象。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, norm, resolveApiKey, planBase, noKey, execError } from './util.js'

/** 该套餐的配置字段：`apiKey` 为 v0.1 遗留的扁平键名（插件级 OpenCode Go Key）。 */
const fields = { enabled: 'opencodeGoEnabled', apiKey: 'apiKey' }

const source = {
  endpoint: 'https://opencode.ai/zen/go/v1/usage',
  bearer: true,
  refs: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
}

const plan = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  fields,
  schema: {
    opencodeGoEnabled: z.boolean().default(true),
    apiKey: z.string().role('secret'),
  },
  source,
}

/** 拉取 OpenCode Go 用量：usage 结构（+useBalance）。 */
export async function fetchPlan(ctx, shell, cfg) {
  const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
  if (apiKey === undefined) return noKey(plan)
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      auth: apiKey,
      bearer: source.bearer,
    })
    if (err !== undefined) return Object.assign(planBase(plan), err)
    const u = data.usage != null && typeof data.usage === 'object' ? data.usage : data
    return Object.assign(planBase(plan), {
      useBalance: data.useBalance === true,
      rollingUsage: norm(u.rolling != null ? u.rolling : data.rollingUsage),
      weeklyUsage: norm(u.weekly != null ? u.weekly : data.weeklyUsage),
      monthlyUsage: norm(u.monthly != null ? u.monthly : data.monthlyUsage),
    })
  } catch (err) {
    return execError(plan)
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
