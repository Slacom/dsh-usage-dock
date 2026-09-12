/**
 * OpenAI Codex 订阅额度模块：复用 dsh-codex-connect 已登录的 ChatGPT OAuth。
 *
 * 本模块只调用 dsh-codex-connect 的公开 API：
 *   readOpenAICodexRateLimits(new OpenAICodexCredentialStore())
 * OAuth access/refresh token 与 account id 均由 Codex Connect 管理，plan-usage
 * 只接收其脱敏后的 rateLimits / credits / individualLimit 投影。
 */
import z from '@deepseek-ai/schemastery'
import { planBase } from './util.js'

const FIVE_HOURS_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60
const MONTH_SECONDS = 30 * 24 * 60 * 60

const fields = { enabled: 'codexEnabled' }

const plan = {
  id: 'codex',
  name: 'OpenAI Codex',
  fields,
  schema: {
    codexEnabled: z.boolean().default(true),
  },
  source: {
    provider: 'dsh-codex-connect',
    endpoint: 'https://chatgpt.com/backend-api/wham/usage',
    oauth: true,
  },
}

function normalizeWindow(window) {
  if (window == null || typeof window !== 'object') return null
  const remaining = window.remainingPercent
  const duration = window.windowSeconds
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)
    || remaining < 0 || remaining > 100
    || typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) return null
  // Codex Connect 的公开语义就是“剩余额度百分比”；保持原义，不反转成已用量。
  const remainingRounded = Math.round(remaining * 10) / 10
  let resetsAt = null
  if (typeof window.resetAt === 'number' && Number.isSafeInteger(window.resetAt) && window.resetAt > 0) {
    const date = new Date(window.resetAt * 1000)
    if (Number.isFinite(date.getTime())) resetsAt = date.toISOString()
  }
  return { status: null, percent: remainingRounded, resetsAt, resetInSec: null }
}

function findWindow(windows, seconds) {
  if (!Array.isArray(windows)) return null
  const hit = windows.find((window) => window && window.windowSeconds === seconds)
  return normalizeWindow(hit)
}

function safeAmount(value) {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value) ? value : null
}

/** 拉取 Codex 主额度桶，并归一化为 plan-usage 的 5小时/周限/月限 wire。 */
export async function fetchPlan() {
  try {
    const mod = await import('dsh-codex-connect')
    if (typeof mod.readOpenAICodexRateLimits !== 'function'
      || typeof mod.OpenAICodexCredentialStore !== 'function') {
      return Object.assign(planBase(plan), {
        error: 'incompatible',
        message: '当前 dsh-codex-connect 版本不提供额度读取接口',
      })
    }
    const usage = await mod.readOpenAICodexRateLimits(new mod.OpenAICodexCredentialStore())
    const limits = usage && Array.isArray(usage.rateLimits) ? usage.rateLimits : []
    const primary = limits.find((limit) => limit && limit.id === 'codex')
    const windows = primary && Array.isArray(primary.windows) ? primary.windows : []
    const rollingUsage = findWindow(windows, FIVE_HOURS_SECONDS)
    const weeklyUsage = findWindow(windows, WEEK_SECONDS)
    const monthlyUsage = findWindow(windows, MONTH_SECONDS)
    const credits = usage && usage.credits && typeof usage.credits === 'object' ? usage.credits : null
    const individual = usage && usage.individualLimit && typeof usage.individualLimit === 'object'
      ? usage.individualLimit
      : null
    if (rollingUsage === null && weeklyUsage === null && monthlyUsage === null
      && credits === null && individual === null) {
      return Object.assign(planBase(plan), {
        error: 'quota-unavailable',
        message: 'Codex Connect 已登录，但当前账户未返回可显示的额度',
      })
    }
    return Object.assign(planBase(plan), {
      rollingUsage,
      weeklyUsage,
      monthlyUsage,
      creditsUnlimited: credits !== null && credits.unlimited === true,
      creditsBalance: credits !== null ? safeAmount(credits.balance) : null,
      individualLimit: individual !== null ? {
        limit: safeAmount(individual.limit),
        used: safeAmount(individual.used),
        remaining: safeAmount(individual.remaining),
        remainingPercent: typeof individual.remainingPercent === 'number'
          ? individual.remainingPercent
          : null,
      } : null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('signed out')) {
      return Object.assign(planBase(plan), {
        error: 'signed-out',
        message: '请先在「设置 → 插件 → Codex Connect」中登录 ChatGPT',
      })
    }
    if (message.includes('authorization must be renewed')) {
      return Object.assign(planBase(plan), {
        error: 'reauth-required',
        message: 'Codex Connect 登录已过期，请重新登录 ChatGPT',
      })
    }
    if (message.includes('Cannot find package') || message.includes('Cannot find module')) {
      return Object.assign(planBase(plan), {
        error: 'not-installed',
        message: '未安装 dsh-codex-connect',
      })
    }
    return Object.assign(planBase(plan), {
      error: 'exec',
      message: 'Codex 额度获取失败',
    })
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
