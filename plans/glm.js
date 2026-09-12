/**
 * GLM Coding Plan monitor 接口的共享实现：两个渠道（国际版 Z.AI / 智谱）
 * 的响应结构完全相同（`TOKENS_LIMIT(3,5)` → 5小时、`(6,1)` → 周限、
 * `TIME_LIMIT` → 月限，另有套餐等级 `level`），仅 endpoint 与凭据候选不同，
 * 因此抽成 `createGlmPlan` 工厂，`glm-zai.js` / `glm-zhipu.js` 各调用一次。
 *
 * 配额端点不需要查询参数，`Authorization` 头直接携带 Key、不带 Bearer 前缀。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, resolveApiKey, planBase, noKey, execError } from './util.js'

/** 归一化 GLM quota/limit 响应：TOKENS_LIMIT(3,5) → 5小时，(6,1) → 周限；TIME_LIMIT → 月限。 */
export function normGlm(payload) {
  const obj = payload != null && typeof payload === 'object' ? payload : {}
  const inner = obj.data != null && typeof obj.data === 'object' ? obj.data : obj
  const limits = Array.isArray(inner.limits) ? inner.limits : []
  const windows = { rollingUsage: null, weeklyUsage: null, monthlyUsage: null }
  for (const item of limits) {
    if (item == null || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : null
    const percent = typeof item.percentage === 'number' ? item.percentage : null
    const resetInSec = typeof item.nextResetTime === 'number' && item.nextResetTime > 0
      ? Math.max(0, (item.nextResetTime - Date.now()) / 1000)
      : null
    const window = { status: null, percent, resetsAt: null, resetInSec }
    if (type === 'TOKENS_LIMIT') {
      const slot = item.unit === 3 && item.number === 5
        ? 'rollingUsage'
        : item.unit === 6 && item.number === 1 ? 'weeklyUsage' : null
      if (slot !== null) windows[slot] = window
    } else if (type === 'TIME_LIMIT') {
      // TIME_LIMIT 即 MCP 工具用量（1 个月窗口）。
      windows.monthlyUsage = window
    }
  }
  return {
    windows,
    level: typeof inner.level === 'string' ? inner.level : null,
  }
}

/**
 * 构建一个 GLM 渠道的套餐模块（统一 plan 对象接口，见 plans/opencode-go.js）。
 * @param {object} opts - { id, name, enabledField, apiKeyField, endpoint, refs }
 */
export function createGlmPlan({ id, name, enabledField, apiKeyField, endpoint, refs }) {
  const fields = { enabled: enabledField, apiKey: apiKeyField }
  const source = { endpoint, bearer: false, refs }
  const plan = {
    id,
    name,
    fields,
    schema: {
      [enabledField]: z.boolean().default(true),
      [apiKeyField]: z.string().role('secret'),
    },
    source,
  }
  plan.fetch = async (ctx, shell, cfg) => {
    const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
    if (apiKey === undefined) return noKey(plan)
    try {
      const { data, err } = await curlJson(shell, source.endpoint, {
        auth: apiKey,
        bearer: false,
      })
      if (err !== undefined) return Object.assign(planBase(plan), err)
      const { windows, level } = normGlm(data)
      return Object.assign(planBase(plan), { level }, windows)
    } catch (err) {
      return execError(plan)
    }
  }
  return plan
}
