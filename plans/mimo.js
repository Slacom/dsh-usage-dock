/**
 * 小米 MiMo 开放平台余额模块（0.8.0 新增渠道）：
 *
 * 只做**API 余额**显示（不做套餐积分/补偿积分额度）——数据来自小米开放平台
 * 控制台的余额端点，与控制台「账户余额」页同一数据源：
 *   GET https://platform.xiaomimimo.com/api/v1/balance
 *   → { code: 0, data: { balance: '16.48', currency: 'CNY',
 *       cashBalance: '16.48', giftBalance: '0.00' } }
 * （数值为**字符串**；currency 决定显示符号：CNY→¥、USD→$。）
 *
 * 鉴权：**不是 API Key**，是小米开放平台控制台的整段 Cookie 请求头（登录
 * platform.xiaomimimo.com 后 F12 → 网络 → 任一请求 → 复制请求头里完整的
 * cookie 值）。必需字段：userId 与 serviceToken（api-platform_serviceToken
 * 亦接受）。tp-·/ttp-· 形态的专用 Key 没有余额端点，不支持查询（前缀后的
 * 星号会提前闭合块注释，此处用「·」代指）。取数与解析口径照抄
 * dsh-cost-meter 的 lib/coding-plans.js（本机安装副本逐一核对）。
 *
 * 与其他渠道相同的统一 plan 对象：{ id, name, fields, schema, source, fetch }。
 * wire 对象携带 balance（number）、currency（string）、cashBalance / giftBalance
 * （number | null，详情面板明细）、via: 'console'。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, toNum, planBase, execError, resolveApiKey } from './util.js'

const fields = { enabled: 'mimoEnabled', cookie: 'mimoCookie', apiKey: 'mimoApiKey' }

const source = { endpoint: 'https://platform.xiaomimimo.com/api/v1/balance' }

/**
 * [0.11.2] **API Key 余额接口**（与 DeepSeek 同构，逐步取代控制台 Cookie）：
 *   `GET https://api.xiaomimimo.com/v1/platform/balance`
 *   鉴权：`api-key: sk-…`（或 `Authorization: Bearer sk-…`），必须用**普通 API Key**。
 *   文档：<https://mimo.mi.com/docs/zh-CN/api/asset/balance-get>
 *
 * 响应：`{ object:'balance', is_available, balance_infos:[{ currency, cash_balance,
 * gift_balance, frozen_balance, credit_limit, credit_available, total_available }] }`
 */
export const API_KEY_ENDPOINT = 'https://api.xiaomimimo.com/v1/platform/balance'
/** 「设置 → 模型」凭据库里可能出现的 MiMo Key 名（插件配置优先）。 */
const API_KEY_REFS = ['MIMO_API_KEY', 'MIMO_APIKEY', 'XIAOMI_MIMO_API_KEY']

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
    /**
     * [0.11.2] 普通 API Key（`sk-…`）：填了就**优先**走 API Key 余额接口，
     * 不再依赖控制台 Cookie。留空则回退到旧的 Cookie 通道（兼容存量配置）。
     */
    mimoApiKey: z.string().role('secret'),
    mimoCookie: z.string().role('secret'),
    // 余额低于该值时状态灯转为警告色；默认 10 元。0 表示不警告。
    mimoWarnThreshold: z.number().min(0).default(10),
  },
  source,
}

/**
 * 归一化控制台 Cookie（整段 Cookie 头粘贴）。容忍「Cookie:」前缀、整体引号与
 * 换行；必需 userId 与 serviceToken（api-platform_serviceToken 或 serviceToken）
 * 两族字段，缺一即视为无效。返回归一化 Cookie 串；无效 → null。
 */
export function normalizeMimoCookie(value) {
  let s = typeof value === 'string' ? value.trim() : ''
  if (s.length === 0) return null
  s = s.replace(/^(?:cookie|set-cookie)\s*:\s*/i, '').replace(/[\r\n]+/g, ' ').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim()
  if (s.length === 0) return null
  const parts = s.split(';').map((part) => part.trim()).filter(Boolean)
  if (parts.some((part) => !/^[^=\s]+=[^;]*$/.test(part))) return null
  const populated = parts.filter((part) => part.slice(part.indexOf('=') + 1).replace(/^["']|["']$/g, '').trim())
  const hasToken = populated.some((part) => /^(?:api-platform_)?serviceToken=/.test(part))
  const hasUser = populated.some((part) => /^userId=/.test(part))
  return hasToken && hasUser ? s : null
}

/** Cookie 是否已配置（供设置页显示「已配置/未配置」徽标）。 */
export function cookieConfigured(cfg) {
  return normalizeMimoCookie(cfg != null ? cfg.mimoCookie : undefined) !== null
}

/**
 * 解析余额响应。只挑总额/现金/赠送三个数字；非法 → null（不编造 0）。
 */
export function parseMimoBalance(data) {
  if (data === null || typeof data !== 'object') return null
  const d = data.data !== null && typeof data.data === 'object' ? data.data : data
  const total = toNum(d.balance ?? d.cashBalance)
  if (total === null || total < 0) return null
  const cash = toNum(d.cashBalance)
  const gift = toNum(d.giftBalance)
  const currency = String(d.currency ?? '').trim().toUpperCase()
  return {
    balance: total,
    cashBalance: cash !== null && cash >= 0 ? cash : null,
    giftBalance: gift !== null && gift >= 0 ? gift : null,
    currency: currency.length > 0 ? currency : 'CNY',
  }
}

/** 币种 → 显示符号（未知币种显示「XXX 」前缀）。 */
export function currencySymbol(currency) {
  const cur = String(currency ?? '').trim().toUpperCase()
  if (cur === 'CNY' || cur === 'RMB') return '¥'
  if (cur === 'USD') return '$'
  return cur.length > 0 ? cur + ' ' : '¥'
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

/** 拉取小米 MiMo 余额：API Key 优先；没有 Key 时回退控制台 Cookie（存量配置）。 */
export async function fetchPlan(ctx, shell, cfg, options) {
  // [0.11.2] API Key 通道优先（与 DeepSeek 同构）：配了 key 就不再依赖控制台 Cookie。
  // 身份/缓存隔离由调用方按 `key=` 指纹处理（fields.apiKey 已登记）。
  const apiKey = await resolveApiKey(ctx, cfg != null ? cfg : {}, fields.apiKey, API_KEY_REFS, options)
  if (apiKey !== undefined) return fetchApiKeyBalance(shell, apiKey, cfg, options)
  // [F2] 有冻结描述时必须**严格遵守**其状态（与身份同源）：
  //   explicit → 只读它自己的冻结字段（缺失/无效也不回退实时 cfg）
  //   none     → 直接缺凭据（零请求）
  //   其它（MiMo 没有引用来源）→ 安全拒绝，不冒充未采样
  // 只有 null/undefined（未采样）才读 cfg。
  const frozen = options !== null && options !== undefined
    && options.frozenCredential !== null && options.frozenCredential !== undefined
    && typeof options.frozenCredential === 'object'
    ? options.frozenCredential
    : null
  let cookieSource = cfg != null ? cfg.mimoCookie : undefined
  if (frozen !== null) {
    if (frozen.kind !== 'explicit'
      || frozen.fields === null || frozen.fields === undefined
      || frozen.fields.mimoCookie === undefined) {
      // none / ref / 未知状态 / 显式但缺少该字段：一律安全拒绝，绝不回退到当前配置。
      return Object.assign(planBase(plan), {
        error: 'no-key',
        message: '未配置小米开放平台控制台 Cookie：登录 platform.xiaomimimo.com 后，F12 → 网络 → 任一请求的请求头 cookie 整段复制（需含 userId 与 serviceToken）',
      })
    }
    cookieSource = frozen.fields.mimoCookie
  }
  const cookie = normalizeMimoCookie(cookieSource)
  if (cookie === null) {
    return Object.assign(planBase(plan), {
      error: 'no-key',
      message: '未配置小米开放平台控制台 Cookie：登录 platform.xiaomimimo.com 后，F12 → 网络 → 任一请求的请求头 cookie 整段复制（需含 userId 与 serviceToken）',
    })
  }
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      signal: options === undefined ? undefined : options.signal,
      timeoutMs: options === undefined || typeof options.remaining !== 'function' ? undefined : options.remaining(),
      headers: {
        cookie,
        // 部分网关对无 UA 的请求有风控；带上与控制台一致的浏览器标识。
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-usage-dock/0.8',
        referer: 'https://platform.xiaomimimo.com/',
      },
    })
    if (err !== undefined) {
      // 登录态过期时上游通常回 401/403 或业务 code=401，给出「重新复制」文案。
      const raw = err.message || ''
      const expired = /HTTP (401|403)/.test(raw) || /code (401|403)/.test(raw)
      return Object.assign(planBase(plan), err, {
        message: expired
          ? '控制台登录态已过期，请重新登录 platform.xiaomimimo.com 并复制新的 Cookie（' + raw + '）'
          : raw || '小米 MiMo 余额获取失败',
      })
    }
    const parsed = parseMimoBalance(data)
    if (parsed === null) {
      return Object.assign(planBase(plan), {
        error: 'parse',
        message: '余额响应结构无法解析（可能 Cookie 已失效或接口变更）',
      })
    }
    return Object.assign(planBase(plan), {
      balance: parsed.balance,
      cashBalance: parsed.cashBalance,
      giftBalance: parsed.giftBalance,
      currency: parsed.currency,
      isAvailable: true,
      via: 'console',
      warnThreshold: warnThresholdOf(cfg),
    })
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    return Object.assign(execError(plan), { message: '小米 MiMo 余额请求异常：' + msg })
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
