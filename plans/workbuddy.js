/**
 * WorkBuddy 剩余积分模块（0.8.1 新增渠道）：
 *
 * 复用 dsh-workbuddy-connect 已登录的凭据读取积分——**本模块不做任何登录/认证**，
 * 与 Codex 渠道同款模式：只要在 workbuddy-connect 里登录过（桌面 App 或其设置页），
 * 这里就能显示；未安装或未登录时显示对应提示。
 *
 * 数据源：dsh-workbuddy-connect 的**同源 status 端点**（仅允许回环请求，其自身
 * 浏览器半与 CLI `exec status` 消费的是同一条数据；路径与响应结构已在其源码
 * index.js / host-heartbeat-DVlbwIIo.js 中逐一核对）：
 *   GET /plugins/dsh-workbuddy-connect/status      （国内版 WorkBuddy）
 *   GET /plugins/dsh-workbuddy-connect/ai/status   （国际版 WorkBuddy AI）
 * 响应：
 *   { status:'signed-in', credits:{ total, accounts:[{packageName,remain,size?,endTimeMs?}],
 *     unlimited?, expiry? } }
 *   { status:'signed-out', reason?, reasonCode? }
 *   { ..., creditsError:'...' }
 *
 * 为什么走 HTTP 而不是 import 其内部类：WorkBuddyCredentialStore 的构造需要
 * refresh 回调、at-rest 解密 keyProvider 等插件内部装配，跨插件 import 意味着
 * 它每次内部重构我们都要跟着改；status 端点是它对外承诺的公共面。端点在其
 * **未安装时 404**，本渠道据此显示「未安装」提示。
 *
 * 展示口径：total 为各套餐剩余积分之和（其源码逐包累加）；unlimited 显示 ∞；
 * creditsError / signed-out 是语义错误，**不参与失败降级**（立即透传）。
 * 注意其 README 明示：每次读取都是真实计费查询——本渠道不做额外重试，失败保
 * 旧值由客户端降级层统一处理。
 */
import z from '@deepseek-ai/schemastery'
import { planBase, execError } from './util.js'

const fields = { enabled: 'workbuddyEnabled' }

const plan = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  fields,
  schema: {
    workbuddyEnabled: z.boolean().default(true),
  },
  source: {
    provider: 'dsh-workbuddy-connect',
    endpoints: {
      cn: '/plugins/dsh-workbuddy-connect/status',
      ai: '/plugins/dsh-workbuddy-connect/ai/status',
    },
  },
}

/** 单次 status 读取的超时（毫秒）：status 内部会做真实计费查询，给足时间。 */
const STATUS_TIMEOUT_MS = 15000

/** 读取一个 variant 的 status 端点；404 → { notFound }，网络失败 → { err }。 */
async function fetchStatus(base, path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
  try {
    const res = await fetch(base + path, {
      // [0.8.2] 显式声明 accept-encoding: identity。
      //
      // 背景（宿主 bug 绕过，非本插件问题）：DSHA 的内置插件 dsh-web-mobile
      // @3.0.5 用 compress.js 改写 ServerResponse.prototype 做响应压缩，会把
      // 「可延迟」的响应头攒起来晚一拍提交；而 dsh-host-webserver 的 gzip
      // 中间件（threshold=1024）在 res.end 代理里看到 headersSent 仍为 false，
      // 会自己再调一次 res.writeHead(statusCode)。该重入落到 compress.js 的
      // patchedWriteHead 时，它先 flush 把攒着的头提交掉（headersSent 变 true），
      // 紧接着下面的 guard 又因这个 true 去调原生 writeHead()，抛
      // ERR_HTTP_HEADERS_SENT；webServer 兜底 catch 视 headersSent 为真而
      // res.destroy()，客户端只看到 fetch failed。
      //
      // 触发条件是「响应体 < 1 KiB 且带显式 Content-Length」：ai/status 的 52 B
      // signed-out、update 的 72 B 都中招，而 cn/status（3.5 KB）正常。声明
      // identity 后无编码可协商，gzip 中间件不进入该重入分支，问题消失。
      //
      // 注：/root/dsha-web-mobile 是受完整性保护的内置插件目录，直接改它的
      // compress.js 会在 App 重启时被还原（实测 07:59:55 被重写回官方版本），
      // 因此只能在消费侧绕过。
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
      signal: controller.signal,
    })
    // 404 = workbuddy-connect 未安装（或旧版本无该端点）。
    if (res.status === 404) return { notFound: true }
    // 403 = 端点只信任回环请求；Host 进程内 fetch 天然是回环，异常部署才会出现。
    if (res.status === 403) {
      return { err: new Error('status route rejected this request (not loopback?)') }
    }
    const body = await res.json()
    return { body }
  } catch (err) {
    return { err }
  } finally {
    clearTimeout(timer)
  }
}

/** 归一化 signed-in 响应里的 credits 段；结构不认识 → null。 */
function creditsOf(body) {
  const credits = body !== null && typeof body === 'object' && body.credits !== null
    && typeof body.credits === 'object' ? body.credits : null
  if (credits === null) return null
  const total = typeof credits.total === 'number' && Number.isFinite(credits.total) ? credits.total : null
  if (total === null && credits.unlimited !== true) return null
  const accounts = Array.isArray(credits.accounts)
    ? credits.accounts
      .filter((a) => a !== null && typeof a === 'object')
      .map((a) => ({
        packageName: typeof a.packageName === 'string' ? a.packageName : null,
        remain: typeof a.remain === 'number' ? a.remain : null,
        size: typeof a.size === 'number' ? a.size : null,
        endTimeMs: typeof a.endTimeMs === 'number' ? a.endTimeMs : null,
      }))
      .filter((a) => a.remain !== null)
    : []
  return {
    total: total ?? 0,
    unlimited: credits.unlimited === true,
    accounts,
    expiry: credits.expiry !== null && typeof credits.expiry === 'object' ? credits.expiry : null,
  }
}

const VARIANT_LABELS = { cn: 'WorkBuddy', ai: 'WorkBuddy AI' }

/**
 * 真实取数：并行读两个 variant 的 status，合成一条 wire 结果。
 * @param base - 回环 web 服务基地址（http://127.0.0.1:<port>，由 index.js 注入）。
 */
async function fetchPlanWithBase(base) {
  const variants = [
    { key: 'cn', path: plan.source.endpoints.cn },
    { key: 'ai', path: plan.source.endpoints.ai },
  ]
  const results = await Promise.all(variants.map((v) => fetchStatus(base, v.path)))
  const signedIn = []
  const degraded = [] // [0.8.2] 记录各版本为何没数据（partial 脚注用）
  let notFound = 0
  let transportError = null
  let semanticError = null
  let semanticLabel = null
  for (let i = 0; i < variants.length; i++) {
    const r = results[i]
    const label = VARIANT_LABELS[variants[i].key]
    if (r.notFound === true) { notFound += 1; continue }
    if (r.err !== undefined) {
      // [0.8.2] 记录而非直接判死：只要另一个版本取到了数据，
      // 就把失败降级为「部分数据」提示（见下方 signedIn 非空的处理）。
      if (transportError === null) transportError = r.err
      degraded.push(label + '：' + (r.err && r.err.message ? r.err.message : String(r.err)))
      continue
    }
    const body = r.body
    if (body === null || typeof body !== 'object') {
      if (transportError === null) transportError = new Error('invalid status response')
      degraded.push(label + '：响应结构无效')
      continue
    }
    if (body.status === 'signed-out') continue // 未登录的版本直接不显示
    if (body.creditsError !== undefined) {
      // 语义错误（如令牌过期/上游拒答）：透传第一条，不拿旧值顶。
      const detail = typeof body.creditsError === 'string' ? body.creditsError : '积分读取失败'
      if (semanticError === null) {
        semanticError = detail
        semanticLabel = label
      }
      degraded.push(label + '：' + detail)
      continue
    }
    const credits = creditsOf(body)
    if (credits === null) {
      if (semanticError === null) {
        semanticError = '积分响应结构无法解析'
        semanticLabel = label
      }
      degraded.push(label + '：积分响应结构无法解析')
      continue
    }
    signedIn.push({ label, credits })
  }

  if (notFound === variants.length) {
    return Object.assign(planBase(plan), {
      error: 'not-installed',
      message: '未安装 dsh-workbuddy-connect（WorkBuddy 积分来自该插件）',
    })
  }
  // [0.8.2] 失败降级策略。
  //
  // 原策略：任一已配置版本失败就直接报错，理由是「不能把另一版本的部分积分
  // 伪装成完整合计」。该顾虑合理，但代价过大——只要另一个版本取不到数（哪怕
  // 它压根没登录或本就没有部署），已登录版本的真实积分也会被一并丢弃。
  //
  // 新策略：先看有没有任何一个版本真的拿到了 credits。
  //   - 有 → 照常展示该版本的合计，并标记 partial/partialNote，由客户端在面板
  //          里以灰色脚注说明「另一版本未取到」，不把部分值伪装成完整合计；
  //   - 没有 → 保持原有语义错误 / 传输错误 / 未登录的分类与文案，行为不变。
  // signed-out / 404 依旧不算失败（它们不是「另一方坏了」，只是没登录/没装）。
  if (signedIn.length === 0) {
    if (semanticError !== null) {
      return Object.assign(planBase(plan), {
        error: 'api',
        message: semanticLabel + '：' + semanticError,
      })
    }
    if (transportError !== null) {
      const msg = transportError && transportError.message ? transportError.message : String(transportError)
      return Object.assign(planBase(plan), {
        error: 'exec',
        message: 'WorkBuddy 状态读取失败（' + msg + '）',
      })
    }
    return Object.assign(planBase(plan), {
      error: 'signed-out',
      message: '未登录 WorkBuddy：请安装并登录 WorkBuddy / WorkBuddy AI 桌面应用（dsh-workbuddy-connect）',
    })
  }

  // 主行 = 各已登录版本的合计；unlimited 仅当所有已登录版本都不限额。
  const accounts = []
  const variantsOut = []
  let total = 0
  const unlimited = signedIn.length > 0 && signedIn.every((row) => row.credits.unlimited === true)
  for (const row of signedIn) {
    variantsOut.push({
      label: row.label,
      total: row.credits.unlimited ? null : row.credits.total,
      unlimited: row.credits.unlimited === true,
    })
    if (row.credits.unlimited === true) continue
    total += row.credits.total
    for (const account of row.credits.accounts) {
      accounts.push(Object.assign({ variant: row.label }, account))
    }
  }
  const partial = degraded.length > 0
  return Object.assign(planBase(plan), {
    creditsTotal: unlimited ? null : total,
    creditsUnlimited: unlimited,
    creditsAccounts: accounts,
    variants: variantsOut,
    isAvailable: true,
    // 部分取数：客户端据此加一条灰色脚注，避免把部分合计误读为完整合计。
    ...partial ? { partial: true, partialNote: '以下版本未取到数据：' + degraded.join('；') } : {},
  })
}

/** 统一 plan 接口：签名与其他渠道一致（ctx/shell/cfg），base 由 apply 闭包注入。 */
let injectedBase = null

/** [由 index.js 调用] 注入回环 web 服务基地址（http://127.0.0.1:<port>）。 */
export function setWebBase(base) {
  injectedBase = typeof base === 'string' && base.length > 0 ? base : null
}

export async function fetchPlan(ctx) {
  if (injectedBase === null) {
    return Object.assign(planBase(plan), {
      error: 'unavailable',
      message: 'WorkBuddy 状态不可用（本插件的 web 服务未就绪，无法读取 workbuddy-connect 状态）',
    })
  }
  try {
    return await fetchPlanWithBase(injectedBase)
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    return Object.assign(execError(plan), { message: 'WorkBuddy 积分请求异常：' + msg })
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
