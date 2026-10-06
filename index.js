/**
 * dsh-usage-dock 的 Host 半：注册 `GET /api/plan-usage`（并行拉取各渠道用量/余额）。
 *
 * 架构：每个渠道的取数/归一化逻辑独立封装在 plans/ 目录的模块里
 * （opencode-go、glm、kimi-code、deepseek、codex），plans/index.js 是注册表。
 * 本文件只负责 Config 声明、路由与通用编排。
 *
 * 配置：导出 `Config`（schemastery schema）交由 DSH 托管——DSH 会据此在
 * 「设置 → 插件」里**自动生成本插件的设置页**，并把改动持久化到 profile 的
 * Cordis patch，随后以 config-reload 通知插件。历史版本（0.3.x）曾自建
 * /config 路由与 JSON 文件存储，0.4.0 起统一交给 DSH，避免双配置源。
 *
 * 每个渠道的 API Key 解析优先级（见 plans/util.js 的 resolveApiKey）：
 *   1. 插件配置里的 `apiKey`；2. 「设置 → 模型」凭据库中该渠道的候选名。
 * 两者都为空时该渠道返回 no-key，由浏览器胶囊提示用户设置。
 */

import z from '@deepseek-ai/schemastery'
import { PLANS, planSchemaFields } from './plans/index.js'

export const name = 'plan-usage'

/** 只需要 Web 服务器；账号余额通过可选的 deepseekAccount 服务读取。 */
export const inject = ['webServer']

/** 插件配置 schema：DSH 据此渲染设置页并持久化到 profile 的 Cordis patch。 */
export const Config = z.object(Object.assign(
  { enabled: z.boolean().default(true) },
  planSchemaFields(),
))

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  // DSH 托管的配置；config-reload 时会以新对象重新进入 apply 之前的读取路径。
  const cfg = config != null && typeof config === 'object' ? config : {}

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
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
      // 各渠道独立取数：一个渠道缺 Key/失败不影响其他渠道。
      const plans = await Promise.all(enabledPlans.map((plan) => plan.fetch(ctx, shell, cfg)))
      json(res, 200, { ok: true, data: { plans } })
    },
  }), 'plan-usage: usage route')
}
