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
import { peakPhaseAt, peakSegments } from './plans/peak-phase.js'
import { setWebBase } from './plans/workbuddy.js'
import { execError } from './plans/util.js'

export const name = 'plan-usage'

/** 只需要 Web 服务器；账号余额通过可选的 deepseekAccount 服务读取。 */
export const inject = ['webServer']

/** 插件配置 schema：DSH 据此渲染设置页并持久化到 profile 的 Cordis patch。 */
export const Config = z.object(Object.assign(
  // .volatile() 是 DSH 设置表单显示该字段的前提。
  { enabled: z.boolean().default(true).volatile() },
  // [local patch 0.8.1] 渠道显示顺序（胶囊与详情面板共用）：渠道 id 的 JSON 数组，
  // 设置页用「上移/下移」按钮维护；未列出的渠道按注册表默认顺序排在后面。
  { planOrder: z.string().default('[]').volatile() },
  planSchemaFields(),
))

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * [local patch 0.8.1] 每次请求时重读最新配置（读不到就用 apply 时的快照兜底）。
 *
 * 背景（已知限制的修复）：Host 半的 `config` 参数是**插件加载时**的快照，设置页
 * 保存（尤其 role('secret') 的 Cookie/Key）后运行时不热重载——用户填了小米 MiMo
 * Cookie 仍报 no-key 就是这个原因。configEditor 服务能同步读出该条目「inherited +
 * profile override」的合成配置（与设置页同源），这里在每次 /api/plan-usage 请求时
 * 合并进工作副本；失败静默回退快照。
 *
 * 合并策略：以重读值为准，缺失的键回落快照（重读值只包含 profile patch 里显式
 * 写下的字段）。enabled/渠道开关同样以重读为准——顺带把「停用渠道后 Host 仍
 * 取数」的无谓请求也一并修掉。
 */
function createLiveConfig(ctx, snapshot) {
  let cached = { at: 0, value: snapshot }
  return async function liveConfig() {
    const now = Date.now()
    if (now - cached.at < 2000) return cached.value // 2 秒内复用，多窗口齐射不重复读盘
    cached.at = now
    try {
      const editor = ctx.get('configEditor')
      if (editor === undefined || typeof editor.configuration !== 'function') return cached.value
      const row = editor.configuration().find((row) => row.entry && row.entry.options
        && row.entry.options.id === 'plan-usage')
      if (row === undefined) return cached.value
      // override = profile patch 显式配置；inherited = 组合层配置。override 优先。
      const merged = Object.assign({}, snapshot,
        row.inherited != null && typeof row.inherited === 'object' ? row.inherited : {},
        row.override != null && typeof row.override === 'object' ? row.override : {})
      cached.value = merged
      return merged
    } catch (err) {
      return cached.value
    }
  }
}

export function apply(ctx, config) {
  // DSH 托管的配置；config-reload 时会以新对象重新进入 apply 之前的读取路径。
  // [local patch 0.8.1] 路由内改用 liveConfig()（每次请求重读），快照只作兜底。
  const cfg = config != null && typeof config === 'object' ? config : {}
  const liveConfig = createLiveConfig(ctx, cfg)

  // [local patch 0.8.1] WorkBuddy 渠道借用 dsh-workbuddy-connect 的同源 status
  // 端点（仅回环请求可信），把本插件 web 服务的回环地址注入给它。
  // webServer.port 是官方公开属性（端口 0 时为 OS 分配后的实际监听端口）。
  try {
    const port = ctx.webServer != null ? ctx.webServer.port : undefined
    if (typeof port === 'number' && port > 0) {
      setWebBase('http://127.0.0.1:' + String(port))
    }
  } catch (err) {
    // 注入失败时 WorkBuddy 渠道会在取数时给出可读错误，不影响其他渠道。
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      const cfgNow = await liveConfig()
      if (cfgNow.enabled === false) {
        json(res, 200, { ok: false, error: 'disabled', message: '套餐用量已停用' })
        return
      }
      const enabledPlans = PLANS.filter((plan) => cfgNow[plan.fields.enabled] !== false)
      if (enabledPlans.length === 0) {
        json(res, 200, { ok: false, error: 'disabled', message: '套餐用量已停用' })
        return
      }
      // shell 服务只用于 Python/curl 兜底后端；原生 fetch 后端（0.6.2 起首选）
      // 不需要它。移动端曾因为缺 python/curl 而整体取数失败，所以这里不再把
      // shell 缺失当成致命错误——交给 util.js 按可用后端降级。
      let shell
      try { shell = ctx.get('shell') } catch { /* 可选服务在移植端缺失，不阻断原生 fetch */ }
      // 包括服务/凭据解析的同步 throw 与异步 reject：异常仅影响本渠道。
      const plans = await Promise.all(enabledPlans.map((plan) => Promise.resolve()
        .then(() => plan.fetch(ctx, shell, cfgNow))
        .catch(() => execError(plan))))
      // [local patch 0.8.0/0.8.1] DeepSeek 峰谷计价相位与段序列（时间条渲染用）。
      // 纯本地计算（plans/peak-phase.js），不请求网络、不抛错——算不出来就不附，
      // 客户端按「无时间条」处理。
      // [0.8.3] 不再限定 via==='account'：峰谷计价是 **DeepSeek 平台侧的计费规则**
      //（北京时间 09:00–12:00 / 14:00–18:00 峰价，周末与假日谷价），与「用账号余额
      // 还是 API Key 查询」无关——API Key 计费的模型同样按该规则计价。因此只要
      // DeepSeek 条目取数成功（无 error）就附相位/段序列，所有设备与两种鉴权方式
      // 统一显示峰谷条（用户 2026-10-16 明确要求）。
      // 客户端可视窗 = 24h（游标居中，左右各 12h），因此段窗口
      // 取 now-12h-2min .. now+24h：左侧必须给满 12h（0.8.1 只给 6h 导致条左
      // 半出现空白），右侧留 12h 余量，30s 轮询与短暂取数失败都不会露边。
      for (const plan of plans) {
        if (plan != null && plan.id === 'deepseek' && plan.error === undefined) {
          const now = Date.now()
          const phase = peakPhaseAt(now)
          const segs = peakSegments(now - 12 * 3600e3 - 120e3, now + 24 * 3600e3)
          if (phase !== null) plan.peakPhase = phase
          if (segs !== null && segs.length > 0) plan.peakSegs = segs
        }
      }
      json(res, 200, { ok: true, data: { plans } })
    },
  }), 'plan-usage: usage route')
}
