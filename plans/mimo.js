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
import { curlJson, toNum, planBase, execError } from './util.js'

const fields = { enabled: 'mimoEnabled', cookie: 'mimoCookie' }

const source = { endpoint: 'https://platform.xiaomimimo.com/api/v1/balance' }

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

/** 拉取小米 MiMo 余额：控制台 Cookie 鉴权，单端点。 */
export async function fetchPlan(ctx, shell, cfg, options) {
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
