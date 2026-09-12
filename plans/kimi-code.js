/**
 * Kimi Code 套餐模块：
 * - 官方用量接口 `https://api.kimi.com/coding/v1/usages`（Bearer 鉴权，
 *   API Key 为 Kimi Code 控制台创建的 sk-kimi-xxx），返回 7 天周限（usage）
 *   + 5 小时频限窗口（limits）+ 会员等级（user.membership.level）；
 * - 月度会员额度走可选的 `kimi-auth` Cookie（网页接口，逆向、非官方）：
 *   插件配置里的 `kimiCodeCookie` 或凭据 `KIMI_AUTH_TOKEN`；未配置或获取
 *   失败时只返回周限与 5 小时窗口（渲染层自动跳过缺失窗口），不影响主流程。
 */
import z from '@deepseek-ai/schemastery'
import {
  curlJson, toNum, resolveApiKey, resolveCredentialApiKey, planBase, noKey, execError,
} from './util.js'

/** 该套餐的配置字段：`cookie` 为可选的 kimi-auth 网页会话 Cookie。 */
const fields = { enabled: 'kimiCodeEnabled', apiKey: 'kimiCodeApiKey', cookie: 'kimiCodeCookie' }

const source = {
  endpoint: 'https://api.kimi.com/coding/v1/usages',
  bearer: true,
  refs: ['KIMI_CODE_API_KEY', 'KIMI_API_KEY'],
  ua: 'KimiCLI/1.6',
}

const plan = {
  id: 'kimi-code',
  name: 'Kimi Code',
  fields,
  schema: {
    kimiCodeEnabled: z.boolean().default(true),
    kimiCodeApiKey: z.string().role('secret'),
    kimiCodeCookie: z.string().role('secret'),
  },
  source,
}

// Kimi 会员月度额度的网页接口（逆向、非官方，需要 kimi-auth Cookie）：
// 返回 subscriptionBalance（amountUsedRatio / kimiCodeUsedRatio / expireTime）。
const KIMI_SUBSCRIPTION_STATS_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'

// Kimi 网页接口要求的浏览器类请求头（与 kimi.com 控制台保持一致）。
const KIMI_WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  Origin: 'https://www.kimi.com',
  Referer: 'https://www.kimi.com/code/console',
  'x-msh-platform': 'web',
  'connect-protocol-version': '1',
}

/**
 * 归一化 Kimi Code /usages 响应：
 * - `usage` → 周限（订阅日每 7 天刷新，limit/used/remaining/resetTime）；
 * - `limits[]` 中 300 分钟窗口（找不到则取第一个）→ 5 小时频限；
 * - 响应不含月度会员额度（那是 Kimi 会员订阅的独立维度，需 Cookie 接口）。
 * 返回 { rollingUsage, weeklyUsage, monthlyUsage: null }。
 */
function normKimi(payload) {
  const obj = payload != null && typeof payload === 'object' ? payload : {}
  const detailWindow = (d) => {
    if (d == null || typeof d !== 'object') return null
    const limit = toNum(d.limit)
    let used = toNum(d.used)
    if (used === null && limit !== null) {
      const remaining = toNum(d.remaining)
      if (remaining !== null) used = limit - remaining
    }
    if (limit === null || limit <= 0 || used === null) return null
    // 百分比四舍五入取整（周限 / 5小时 / 月限一致，均无小数）。
    const percent = Math.round((Math.max(0, Math.min(limit, used)) / limit) * 100)
    return {
      status: null,
      percent,
      resetsAt: typeof d.resetTime === 'string' && d.resetTime.length > 0 ? d.resetTime : null,
      resetInSec: null,
    }
  }
  const windows = { rollingUsage: null, weeklyUsage: null, monthlyUsage: null }
  const usage = obj.usage != null && typeof obj.usage === 'object' ? obj.usage : null
  if (usage !== null) windows.weeklyUsage = detailWindow(usage)
  const limits = Array.isArray(obj.limits) ? obj.limits : []
  let fiveHour = null
  for (const item of limits) {
    if (item == null || typeof item !== 'object') continue
    const w = item.window != null && typeof item.window === 'object' ? item.window : {}
    if (w.duration === 300 && String(w.timeUnit || '').indexOf('MINUTE') !== -1) {
      fiveHour = item
      break
    }
  }
  if (fiveHour === null && limits.length > 0) fiveHour = limits[0]
  if (fiveHour !== null) {
    const detail = fiveHour.detail != null && typeof fiveHour.detail === 'object'
      ? fiveHour.detail
      : null
    windows.rollingUsage = detailWindow(detail)
  }
  return windows
}

/**
 * 归一化 Kimi GetSubscriptionStats 响应中的月度会员额度：
 * subscriptionBalance.amountUsedRatio（0..1 或已是百分数），expireTime 为重置时间。
 * 取不到返回 null。
 */
function normKimiMonthly(payload) {
  const obj = payload != null && typeof payload === 'object' ? payload : {}
  const bal = obj.subscriptionBalance != null && typeof obj.subscriptionBalance === 'object'
    ? obj.subscriptionBalance
    : null
  if (bal === null) return null
  let ratio = typeof bal.amountUsedRatio === 'number'
    ? bal.amountUsedRatio
    : (typeof bal.kimiCodeUsedRatio === 'number' ? bal.kimiCodeUsedRatio : null)
  if (ratio === null || !Number.isFinite(ratio)) return null
  const percent = ratio >= 0 && ratio <= 1 ? ratio * 100 : ratio
  return {
    status: null,
    // 月限只保留整数百分比（周限/5小时保留 1 位小数）。
    percent: Math.round(Math.max(0, Math.min(100, percent))),
    resetsAt: typeof bal.expireTime === 'string' && bal.expireTime.length > 0 ? bal.expireTime : null,
    resetInSec: null,
  }
}

/** 解析 Kimi 网页会话 Cookie（kimi-auth JWT）：插件配置 > 凭据库 KIMI_AUTH_TOKEN。 */
async function resolveCookie(ctx, cfg) {
  const pluginValue = typeof cfg[fields.cookie] === 'string' && cfg[fields.cookie].length > 0
    ? cfg[fields.cookie]
    : undefined
  if (pluginValue !== undefined) return pluginValue
  return resolveCredentialApiKey(ctx, ['KIMI_AUTH_TOKEN'])
}

/** 拉取 Kimi Code 用量：官方 /usages + 可选的月度会员额度（Cookie 增强）。 */
export async function fetchPlan(ctx, shell, cfg) {
  const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
  if (apiKey === undefined) return noKey(plan)
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      auth: apiKey,
      bearer: source.bearer,
      headers: { 'User-Agent': source.ua },
    })
    if (err !== undefined) return Object.assign(planBase(plan), err)
    const windows = normKimi(data)
    const membership = data.user != null && data.user.membership != null
      ? data.user.membership
      : null
    const out = Object.assign(planBase(plan), {
      level: membership != null && typeof membership.level === 'string' ? membership.level : null,
    }, windows)
    // 月度会员额度（可选增强）：需要 kimi-auth Cookie；失败只丢月度窗口，
    // 不阻断周限与 5 小时数据。
    const cookie = await resolveCookie(ctx, cfg)
    if (cookie !== undefined) {
      try {
        const stats = await curlJson(shell, KIMI_SUBSCRIPTION_STATS_URL, {
          auth: cookie,
          cookie,
          method: 'POST',
          body: '{}',
          headers: KIMI_WEB_HEADERS,
        })
        if (stats.err === undefined) {
          const monthly = normKimiMonthly(stats.data)
          if (monthly !== null) out.monthlyUsage = monthly
        }
      } catch (statsErr) {
        // 忽略：月度额度只是增强信息。
      }
    }
    return out
  } catch (err) {
    return execError(plan)
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
