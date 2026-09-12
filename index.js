/**
 * dsh-plan-usage 的 Host 半：注册 `GET /api/plan-usage`（并行拉取各套餐用量）
 * 与 `GET/POST /api/plan-usage/config`（读写插件配置）。
 *
 * 架构：每个套餐（渠道）的取数/归一化逻辑独立封装在 plans/ 目录的模块里
 * （plans/opencode-go.js、plans/glm-zai.js、plans/glm-zhipu.js、plans/kimi-code.js，
 * GLM 两渠道共享 plans/glm.js 的实现），plans/index.js 是注册表。本文件只负责
 * 路由、配置读写与通用编排，全部经注册表驱动——新增套餐不需要改动这里。
 *
 * 配置持久化使用 `plan-usage` 设置命名空间（in-process 读写，不依赖 harness 的
 * 配置客户端白名单），浏览器端通过插件自己的 /config 路由读写，因此本插件
 * 无需修改 harness 源码即可在「设置 → 插件 → 插件配置」里提供配置卡片。
 *
 * 每个套餐的 API Key 解析优先级相同（见 plans/util.js 的 resolveApiKey）：
 * 1. 插件配置里该套餐的 `apiKey`（若留空则跳过）；
 * 2. 「设置 → 模型」写入的对应凭据（各套餐的候选凭据名见其模块的 `source.refs`）；
 * 两者都为空时该套餐返回 `no-key`，由浏览器胶囊提示用户设置。
 *
 * 纯 JS、零运行时依赖：能力通过 `ctx` 获取，schema 通过 @deepseek-ai/schemastery
 * 与 @deepseek-ai/dsh-settings 声明（二者由 profile 的 node_modules 提升解析）。
 */

import z from '@deepseek-ai/schemastery'
import { PLANS, PLAN_BY_ID, planSchemaFields } from './plans/index.js'

/** 插件配置的设置命名空间（仅作为本插件的持久化存储，不经 wire 暴露）。 */
const NS = 'plan-usage'

export const name = 'plan-usage'
export const inject = ['webServer', 'settings']

/**
 * 插件配置 schema（apiKey/cookie 均为 write-only 密钥，绝不通过 wire 返回）：
 * - `enabled` 全局开关，关闭后角标整体隐藏；
 * - 其余字段由各套餐模块的 `schema` 声明（plans/index.js 合并）：
 *   `apiKey` 为 v0.1 遗留键名，即 OpenCode Go 的插件级 Key；各套餐的
 *   开关（`*Enabled`）与密钥（`*ApiKey`）；`kimiCodeCookie` 为 Kimi
 *   会员月度额度的可选 kimi-auth 会话 Cookie。
 */
const Config = z.object(Object.assign(
  { enabled: z.boolean().default(true) },
  planSchemaFields(),
))

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 配置的浏览器视图：只含非敏感字段（密钥的值永不返回）。 */
function configView(ctx, cfg) {
  const settings = ctx.get('settings')
  const plans = {}
  for (const plan of PLANS) {
    const fields = plan.fields
    const key = fields.apiKey !== undefined ? cfg[fields.apiKey] : undefined
    plans[plan.id] = {
      enabled: cfg[fields.enabled] !== false,
      apiKeyConfigured: fields.apiKey !== undefined && typeof key === 'string' && key.length > 0,
      cookieConfigured: fields.cookie !== undefined
        && typeof cfg[fields.cookie] === 'string' && cfg[fields.cookie].length > 0,
    }
  }
  return {
    enabled: cfg.enabled !== false,
    plans,
    writable: settings !== undefined && settings.writable === true,
  }
}

/** 读取请求体（node IncomingMessage 异步迭代）。 */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx, config) {
  // 组合层配置（cordis.yml 中的 plan-usage 行）作为 base 层；用户层由设置文档覆盖。
  const entry = config != null && typeof config === 'object' ? config : {}
  // 直接注册设置命名空间：`settings` 作为硬依赖，注册发生在 apply 内同步完成。
  const scope = ctx.settings.register(NS, Config, { base: entry })
  const current = () => scope.get()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      const cfg = current() || {}
      if (cfg.enabled === false) {
        json(res, 200, { ok: false, error: 'disabled', message: '套餐用量已停用' })
        return
      }
      const enabledPlans = PLANS.filter((plan) => cfg[plan.fields.enabled] !== false)
      if (enabledPlans.length === 0) {
        json(res, 200, { ok: false, error: 'disabled', message: '套餐用量已停用' })
        return
      }
      const shell = ctx.get('shell')
      if (shell === undefined) {
        json(res, 503, { ok: false, error: 'no-shell', message: 'shell service unavailable' })
        return
      }
      // 各套餐（渠道）独立取数：一个套餐缺 Key/失败不影响其他套餐。
      const plans = await Promise.all(enabledPlans.map((plan) => plan.fetch(ctx, shell, cfg)))
      json(res, 200, { ok: true, data: { plans } })
    },
  }), 'plan-usage: route')

  // 配置读写路由：浏览器端配置卡片通过它读写，绕开 harness 的配置客户端白名单。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/config',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, data: configView(ctx, current() || {}) })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      let input
      try {
        input = JSON.parse(await readBody(req))
      } catch (err) {
        json(res, 400, { ok: false, error: 'bad-json', message: 'invalid JSON body' })
        return
      }
      if (input == null || typeof input !== 'object') {
        json(res, 400, { ok: false, error: 'bad-json', message: 'expected a JSON object' })
        return
      }
      // 每套餐更新：{ [planId]: { enabled?, apiKey?, clearKey? } }，未知套餐拒绝。
      const planUpdates = {}
      if (input.plans !== undefined) {
        if (typeof input.plans !== 'object' || Array.isArray(input.plans)) {
          json(res, 400, { ok: false, error: 'bad-plans', message: 'plans must be an object keyed by plan id' })
          return
        }
        for (const key of Object.keys(input.plans)) {
          if (!PLAN_BY_ID[key]) {
            json(res, 400, { ok: false, error: 'unknown-plan', message: 'unknown plan id: ' + key })
            return
          }
          const up = input.plans[key]
          if (up == null || typeof up !== 'object') {
            json(res, 400, { ok: false, error: 'bad-plan', message: 'plan update must be an object' })
            return
          }
          planUpdates[key] = up
        }
      }
      try {
        if (input.enabled !== undefined) await scope.update({ enabled: input.enabled === true })
        for (const plan of PLANS) {
          const up = planUpdates[plan.id]
          if (up === undefined) continue
          const fields = plan.fields
          if (up.enabled !== undefined) await scope.update({ [fields.enabled]: up.enabled === true })
          if (fields.apiKey !== undefined) {
            if (up.clearKey === true) {
              await ctx.settings.mutate(NS, [{ op: 'unset', path: [fields.apiKey] }])
            } else if (typeof up.apiKey === 'string' && up.apiKey.trim() !== '') {
              await scope.update({ [fields.apiKey]: up.apiKey.trim() })
            }
          }
          // 可选会话 Cookie（目前仅 kimi-code：月度会员额度）。
          if (fields.cookie !== undefined) {
            if (up.clearCookie === true) {
              await ctx.settings.mutate(NS, [{ op: 'unset', path: [fields.cookie] }])
            } else if (typeof up.cookie === 'string' && up.cookie.trim() !== '') {
              await scope.update({ [fields.cookie]: up.cookie.trim() })
            }
          }
        }
        // 兼容旧客户端（v0.1）：顶层 apiKey / clearKey 视作 opencode-go 套餐的更新。
        if (input.clearKey === true) {
          await ctx.settings.mutate(NS, [{ op: 'unset', path: ['apiKey'] }])
        } else if (typeof input.apiKey === 'string' && input.apiKey.trim() !== '') {
          await scope.update({ apiKey: input.apiKey.trim() })
        }
        json(res, 200, { ok: true, data: configView(ctx, current() || {}) })
      } catch (err) {
        json(res, 400, {
          ok: false,
          error: 'rejected',
          message: err && err.message ? err.message : String(err),
        })
      }
    },
  }), 'plan-usage: config route')
}
