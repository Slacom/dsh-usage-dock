/**
 * 小米 MiMo 开放平台余额模块（0.8.0 新增渠道；0.11.4 起**只保留 API Key 通道**）。
 *
 * 只做**API 余额**显示（不做套餐积分/补偿积分额度）——数据来自 MiMo 开放平台的
 * 余额端点（与 DeepSeek 同构）：
 *   `GET https://api.xiaomimimo.com/v1/platform/balance`
 *   鉴权：`api-key: sk-…`（或 `Authorization: Bearer sk-…`），必须用**普通 API Key**。
 *   文档：<https://mimo.mi.com/docs/zh-CN/api/asset/balance-get>
 *
 * 响应：`{ object:'balance', is_available, balance_infos:[{ currency, cash_balance,
 * gift_balance, frozen_balance, credit_limit, credit_available, total_available }] }`
 *
 * **历史变更**：0.8.0–0.11.3 曾同时支持「控制台 Cookie」与「扫码登录/记住登录」两条
 * 通道（`platform.xiaomimimo.com/api/v1/balance` + userId/serviceToken，以及一套
 * 本机登录/凭据持久化模块）。这些通道已**彻底删除**：
 * 本模块只认 `mimoApiKey`（插件配置）或「设置 → 模型」里的 MiMo Key，
 * 没有 Key 时固定返回 `no-key`，不再回退任何 Cookie / 扫码路径。
 *
 * **[R1] 「设置 → 模型」自动复用 Key 采用「名称 + 可信 origin」双条件**：
 * 光看 provider id / displayName 里含 `mimo|xiaomi` 是不够的 —— 第三方 relay（例如
 * `mimo-relay`）也会命中名称，但它的 Key 属于别家网关，拿去请求
 * `https://api.xiaomimimo.com` 等于把别人的凭据发给小米。因此名称命中后还必须校验该
 * provider 的 `baseURL` 规范化 origin **精确等于**受信来源（当前只认
 * `https://api.xiaomimimo.com`）；缺失 / 非字符串 / 解析失败 / 非 https / 带 userinfo /
 * 带显式端口 / 第三方地址一律 **fail closed 跳过**，既**不解析**该 provider 的
 * `apiKeyEnv`，也**不发起**余额请求。`hasMimoApiKey()` 与 `fetchPlan()` 共用同一个
 * `providerKeyOf()`，规则天然一致；插件显式 `mimoApiKey` 与固定候选名
 * （`API_KEY_REFS`）的优先级保持不变。
 *
 * 与其他渠道相同的统一 plan 对象：{ id, name, fields, schema, fetch }。
 * wire 对象携带 balance（number）、currency（string）、cashBalance / giftBalance
 * （number | null，详情面板明细）、creditAvailable（number | null）、via: 'api-key'。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, toNum, planBase, execError, resolveApiKey } from './util.js'

/** 插件配置字段名：渠道开关 + API Key。 */
const fields = { enabled: 'mimoEnabled', apiKey: 'mimoApiKey' }

/** [0.11.2] **API Key 余额接口**：`GET https://api.xiaomimimo.com/v1/platform/balance`。 */
export const API_KEY_ENDPOINT = 'https://api.xiaomimimo.com/v1/platform/balance'
/** 「设置 → 模型」凭据库里可能出现的 MiMo Key 名（插件配置优先）。
 *  [0.11.3] 补上桌面端实际使用的 `XIAOMI_API_KEY`（此前只列了 MIMO_* 三个名字，
 *  导致「设置 → 模型」里明明配了 Key，插件却仍显示未登录）。 */
const API_KEY_REFS = ['XIAOMI_API_KEY', 'MIMO_API_KEY', 'MIMO_APIKEY', 'XIAOMI_MIMO_API_KEY']

/**
 * [R1] 允许自动复用「设置 → 模型」Key 的**可信 API 来源**集合（规范化 origin）。
 *
 * 只认小米 MiMo 开放平台自己的 API 域名。不要因为某个第三方网关「也能调 MiMo」
 * 就往里加：本模块的请求地址固定是 `API_KEY_ENDPOINT`，加进来就等于允许把该网关的
 * Key 发给小米。
 */
const TRUSTED_MIMO_ORIGINS = new Set(['https://api.xiaomimimo.com'])

/**
 * [R1] 校验某个 provider 的 `baseURL` 是否指向可信的小米 MiMo API 来源。
 *
 * **fail closed**：任何一条不满足都返回 `null`（调用方据此跳过该 provider）。
 *   - 必须是字符串、trim 后非空、能被 `new URL()` 解析；
 *   - 必须 `https:`（不认 http / ws / 其它协议）；
 *   - 不能带 userinfo（`user:pass@`），否则 origin 的可信性会被伪造；
 *   - 不能带显式端口 —— 含被 `URL` 规范化掉的 `:443`，因此额外按原文 authority 判断；
 *   - 规范化 origin 必须**精确命中** `TRUSTED_MIMO_ORIGINS`（大小写由 `URL` 归一）；
 *   - 路径不限（常见 `/v1`）：请求地址始终是固定的 `API_KEY_ENDPOINT`，与 `baseURL` 路径无关。
 *
 * @param {unknown} baseURL provider 的模型接口地址
 * @returns {string|null} 可信的规范化 origin；不可信返回 `null`
 */
function trustedMimoOriginOf(baseURL) {
  if (typeof baseURL !== 'string') return null
  const raw = baseURL.trim()
  if (raw.length === 0) return null
  let parsed = null
  try { parsed = new URL(raw) } catch (err) { return null }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.port !== '') return null
  // `URL` 会把 `https://host:443` 的端口规范化掉，所以显式端口必须看原文 authority。
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(raw)
  if (authority === null) return null
  if (authority[1].includes(':')) return null
  const origin = parsed.origin
  return TRUSTED_MIMO_ORIGINS.has(origin) ? origin : null
}

/**
 * [R1] 从「设置 → 模型」的 provider 目录里按 id / displayName **包含 mimo 或 xiaomi** 的条目
 * 自动找到 Key（只读：不解析地址、不联网，只按该 provider 的 `apiKeyEnv` 去凭据库取值）。
 *
 * **双条件**：名称命中只是必要条件；还必须通过 `trustedMimoOriginOf(target.baseURL)`
 * 校验来源。不可信的 provider 直接 `continue`，**绝不调用 `creds.resolve`**。
 *
 * 为什么需要：不同设备给 MiMo 起的 provider id 不一样（桌面 `xiaomi`、手机可能是别的名字），
 * 光靠固定候选名（XIAOMI_API_KEY …）覆盖不全；这一层让「设置 → 模型里配过 MiMo Key」的设备
 * **零配置**就能走 API Key 通道。
 */
async function providerKeyOf(ctx) {
  let targets = []
  try {
    const mod = await import('./custom-balance.js')
    if (mod !== null && mod !== undefined && typeof mod.listProviderTargets === 'function') {
      targets = mod.listProviderTargets(ctx)
    }
  } catch (err) {
    return undefined
  }
  if (!Array.isArray(targets)) return undefined
  let creds = undefined
  try { creds = ctx.get('credentials') } catch (err) { creds = undefined }
  if (creds === undefined || creds === null || typeof creds.resolve !== 'function') return undefined
  for (const target of targets) {
    if (target === null || typeof target !== 'object') continue
    const label = String(target.provider || '') + ' ' + String(target.displayName || '')
    if (!/mimo|xiaomi/i.test(label)) continue
    /**
     * [R1] 名称命中之后**先校验来源**，再碰凭据引用。
     * 第三方 relay（id/displayName 带 mimo 但 baseURL 指向别家）在这里被跳过：
     * 不解析它的 Key、也不发余额请求。
     */
    if (trustedMimoOriginOf(target.baseURL) === null) continue
    const env = typeof target.apiKeyEnv === 'string' ? target.apiKeyEnv.trim() : ''
    if (env.length === 0) continue
    try {
      const hit = await creds.resolve(env)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch (err) { /* 试下一个 */ }
  }
  return undefined
}

/**
 * 是否有可用的 MiMo API Key：**插件配置字段 > 固定候选名 > provider 自动匹配**。
 * `frozenCredential` 存在时（模型工具的身份冻结）只认冻结状态，不做 provider 猜名。
 *
 * 这里的第三档与 `fetchPlan()` 共用 `providerKeyOf()`，因此「名称 + 可信 origin」双条件
 * 在两处**完全一致**：不可信来源不会被算作「有 Key」。
 */
export async function hasMimoApiKey(ctx, cfg, options) {
  const frozen = options !== null && options !== undefined ? options.frozenCredential : null
  const key = await resolveApiKey(ctx, cfg != null ? cfg : {}, fields.apiKey, API_KEY_REFS, options)
  if (key !== undefined) return true
  if (frozen !== null && frozen !== undefined) return false
  return (await providerKeyOf(ctx)) !== undefined
}

/** 余额警告阈值的默认值（元）：配置留空或为 0 时使用。 */
const DEFAULT_WARN_THRESHOLD = 10

/** 从配置解析警告阈值：非有限数或负数时回退默认值。 */
function warnThresholdOf(cfg) {
  const raw = cfg != null ? cfg.mimoWarnThreshold : undefined
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WARN_THRESHOLD
}

const plan = {
  id: 'mimo',
  name: 'Xiaomi MiMo',
  fields,
  schema: {
    mimoEnabled: z.boolean().default(true),
    /** 普通 API Key（`sk-…`）：MiMo 余额的**唯一**凭据来源。 */
    mimoApiKey: z.string().role('secret'),
    // 余额低于该值时状态灯转为警告色；默认 10 元。0 表示不警告。
    mimoWarnThreshold: z.number().min(0).default(10),
  },
}

/**
 * 没配 Key 时的固定 wire（**零请求**）。
 *
 * 0.11.4 起 MiMo 只有 API Key 一条通道，因此这里不再有「Cookie / F12 / 扫码」提示，
 * 也不再按 `frozenCredential` 分支去读任何 Cookie 字段。
 */
function noKeyWire() {
  return Object.assign(planBase(plan), {
    error: 'no-key',
    message: '未配置小米 MiMo API Key：请在「设置 → Usage Dock」填写，或在「设置 → 模型」里配置 XIAOMI_API_KEY',
  })
}

/**
 * [0.11.2] API Key 通道：一次 GET，解析 `balance_infos[0]`。
 *
 * 字段口径：
 *   - `balance` = **现金 + 赠金**（不含授信额度，避免把「可借」当成「自己的钱」）；
 *   - `cashBalance` / `giftBalance` / `creditAvailable` 供详情面板分行；
 *   - `isAvailable` 直接取上游 `is_available`（`total_available - frozen_balance > 0`）。
 * 401/403（含 `invalid_api_key`）→ 鉴权失效（永久，立即提示）；5xx/网络 → 原样透传（暂时失败）。
 */
export async function fetchApiKeyBalance(shell, apiKey, cfg, options) {
  try {
    const { data, err } = await curlJson(shell, API_KEY_ENDPOINT, {
      headers: { 'api-key': apiKey, 'user-agent': 'dsh-usage-dock/0.11' },
      signal: options === undefined ? undefined : options.signal,
      timeoutMs: options === undefined || typeof options.remaining !== 'function' ? undefined : options.remaining(),
    })
    if (err !== undefined) {
      const raw = typeof err.message === 'string' ? err.message : ''
      /**
       * 上游对无效 Key 回 `401 {"code":"invalid_api_key"}`，`curlJson` 把它归成语义错误
       * （`error:'api'`），因此这里必须把 `error === 'api'` 也当成「鉴权被拒」，
       * 否则会退化成不带指引的通用失败文案。
       */
      const rejected = err.error === 'api'
        || /HTTP (401|403)/.test(raw)
        || /invalid[ _-]?api[ _-]?key|unauthor|forbidden/i.test(raw)
      return Object.assign(planBase(plan), err, {
        message: rejected
          ? 'MiMo 拒绝了这个 API Key（可能无效或已失效），请到「设置 → Usage Dock」重新填写（' + raw + '）'
          : (raw || '小米 MiMo 余额获取失败（API Key 方式）'),
      })
    }
    const infoList = Array.isArray(data !== null && data !== undefined ? data.balance_infos : null) ? data.balance_infos : []
    const info = infoList.find((item) => item !== null && typeof item === 'object') || null
    if (info === null || (data !== null && data !== undefined && data.object !== undefined && data.object !== 'balance')) {
      return Object.assign(planBase(plan), { error: 'parse', message: '余额响应结构无法解析（接口可能已变更）' })
    }
    const cash = toNum(info.cash_balance)
    const gift = toNum(info.gift_balance)
    const total = toNum(info.total_available)
    const hasCash = cash !== null && cash >= 0
    const hasGift = gift !== null && gift >= 0
    const sum = hasCash || hasGift ? (hasCash ? cash : 0) + (hasGift ? gift : 0) : null
    const balance = sum !== null ? sum : (total !== null && total >= 0 ? total : null)
    if (balance === null) {
      return Object.assign(planBase(plan), { error: 'parse', message: '余额响应缺少可用金额' })
    }
    const currency = typeof info.currency === 'string' && info.currency.trim().length > 0
      ? info.currency.trim().toUpperCase()
      : 'CNY'
    const credit = toNum(info.credit_available)
    return Object.assign(planBase(plan), {
      balance,
      cashBalance: hasCash ? cash : null,
      giftBalance: hasGift ? gift : null,
      creditAvailable: credit !== null && credit > 0 ? credit : null,
      currency,
      isAvailable: data.is_available === true,
      via: 'api-key',
      warnThreshold: warnThresholdOf(cfg),
      fetchedAt: Date.now(),
    })
  } catch (err) {
    return Object.assign(execError(plan), { message: '上游请求异常（API Key 方式）' })
  }
}

/**
 * 拉取小米 MiMo 余额：**只走 API Key**；没有任何 Key 时返回固定 `no-key`（零请求）。
 *
 * 身份/缓存隔离由调用方按 `key=` 指纹处理（`fields.apiKey` 已登记）。
 * `frozenCredential`（模型工具的身份冻结）存在时不再做 provider 猜名，与 `hasMimoApiKey` 同源。
 * provider 自动匹配同样受 `providerKeyOf()` 的「名称 + 可信 origin」双条件约束：
 * 不可信来源视为没有 Key，直接返回 `no-key`（零请求）。
 */
export async function fetchPlan(ctx, shell, cfg, options) {
  let apiKey = await resolveApiKey(ctx, cfg != null ? cfg : {}, fields.apiKey, API_KEY_REFS, options)
  if (apiKey === undefined) {
    const frozen = options !== null && options !== undefined ? options.frozenCredential : null
    if (frozen === null || frozen === undefined) apiKey = await providerKeyOf(ctx)
  }
  if (apiKey === undefined) return noKeyWire()
  return fetchApiKeyBalance(shell, apiKey, cfg, options)
}

export default Object.assign(plan, { fetch: fetchPlan })
