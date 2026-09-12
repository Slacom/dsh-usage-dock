/**
 * 套餐注册表：接入一个新套餐 = 在 plans/ 下新增一个模块（默认导出统一的
 * plan 对象：{ id, name, fields, schema, source, fetch }，见 plans/opencode-go.js
 * 头注释），然后在这里登记。index.js 的路由与配置读写全部经由此表驱动，
 * 不需要改动任何路由代码。
 */
import opencodeGo from './opencode-go.js'
import glmZai from './glm-zai.js'
import glmZhipu from './glm-zhipu.js'
import kimiCode from './kimi-code.js'
import deepseek from './deepseek.js'
import codex from './codex.js'

/** 已接入的套餐（渠道）：id 同时用作配置键名与 wire 标识。 */
export const PLANS = [opencodeGo, glmZai, glmZhipu, kimiCode, deepseek, codex]

/** id → plan 的索引（配置读写路由校验未知套餐用）。 */
export const PLAN_BY_ID = Object.fromEntries(PLANS.map((plan) => [plan.id, plan]))

/** 所有套餐 schema 字段的并集：index.js 据此组装插件的 Config 对象。 */
export function planSchemaFields() {
  const fields = {}
  for (const plan of PLANS) Object.assign(fields, plan.schema)
  return fields
}
