/**
 * WorkBuddy 剩余积分模块（0.8.1 新增；0.8.3 拆分为两个独立渠道）：
 *
 * [0.8.3] 国内版 WorkBuddy 与国际版 WorkBuddy AI 的积分**不通用**
 *（用户 2026-10-17 在第二台设备实测发现）。因此本模块导出**两个独立渠道**：
 *   - `workbuddy`     → 国内版 WorkBuddy（配置键 workbuddyEnabled）
 *   - `workbuddy-ai`  → 国际版 WorkBuddy AI（配置键 workbuddyAiEnabled）
 * 两者在胶囊/详情卡片里各占一行/一区，并可在设置页分别开关与排序
 *（与 DeepSeek / MiMo 等其他渠道完全同权）。
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

/** 单次 status 读取的超时（毫秒）：status 内部会做真实计费查询，给足时间。
 * [0.8.3] 15s → 30s：该端点每轮都打上游计费，慢响应曾导致偶发超时被记成失败
 * （用户 2026-10-16 反馈胶囊偶现「获取失败」）；与 Host 单请求超时对齐。 */
const STATUS_TIMEOUT_MS = 30000

const CN_PATH = '/plugins/dsh-workbuddy-connect/status'
const AI_PATH = '/plugins/dsh-workbuddy-connect/ai/status'

/** 国内版 WorkBuddy 渠道定义。 */
const cnPlan = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  fields: { enabled: 'workbuddyEnabled' },
  schema: {
    workbuddyEnabled: z.boolean().default(true),
  },
  source: {
    provider: 'dsh-workbuddy-connect',
    endpoint: CN_PATH,
  },
}

/** 国际版 WorkBuddy AI 渠道定义（0.8.3 拆出，独立开关/排序）。 */
const aiPlan = {
  id: 'workbuddy-ai',
  name: 'WorkBuddy AI',
  fields: { enabled: 'workbuddyAiEnabled' },
  schema: {
    workbuddyAiEnabled: z.boolean().default(true),
  },
  source: {
    provider: 'dsh-workbuddy-connect',
    endpoint: AI_PATH,
  },
}

/** 读取一个 status 端点；404 → { notFound }，网络失败 → { err }。 */
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

/**
 * 真实取数：读**单个**版本（渠道）的 status 端点，合成一条 wire 结果。
 * [0.8.3] 从「并行读两版 + 合并」改为「每个渠道只读自己的端点」——两个版本
 * 现在是独立的渠道，互不拖累（一版失败不再影响另一版的显示）。
 *
 * @param base    - 回环 web 服务基地址（http://127.0.0.1:<port>，由 index.js 注入）。
 * @param plan    - 渠道定义（cnPlan / aiPlan）。
 * @param path    - 该渠道的 status 端点路径。
 */
async function fetchPlanWithBase(base, plan, path) {
  const r = await fetchStatus(base, path)
  // 未安装：端点 404（workbuddy-connect 没装或版本过旧）。
  if (r.notFound === true) {
    return Object.assign(planBase(plan), {
      error: 'not-installed',
      message: '未安装 dsh-workbuddy-connect（WorkBuddy 积分来自该插件）',
    })
  }
  // 传输层失败：fetch 本身抛异常（连接被 reset / 超时 / 拒绝）。
  if (r.err !== undefined) {
    const msg = r.err && r.err.message ? r.err.message : String(r.err)
    return Object.assign(planBase(plan), {
      error: 'exec',
      message: plan.name + ' 状态读取失败（' + msg + '）',
    })
  }
  const body = r.body
  if (body === null || typeof body !== 'object') {
    return Object.assign(planBase(plan), {
      error: 'exec',
      message: plan.name + ' 状态读取失败（响应结构无效）',
    })
  }
  // 未登录：该版本不显示（不是错误）。
  if (body.status === 'signed-out') {
    return Object.assign(planBase(plan), {
      error: 'signed-out',
      message: '未登录 ' + plan.name + '：请在 dsh-workbuddy-connect 中登录该版本',
    })
  }
  // 语义错误（令牌过期/上游拒答）：透传，不拿旧值顶。
  if (body.creditsError !== undefined) {
    const detail = typeof body.creditsError === 'string' ? body.creditsError : '积分读取失败'
    return Object.assign(planBase(plan), {
      error: 'api',
      message: plan.name + '：' + detail,
    })
  }
  const credits = creditsOf(body)
  if (credits === null) {
    return Object.assign(planBase(plan), {
      error: 'api',
      message: plan.name + '：积分响应结构无法解析',
    })
  }
  // 单版本渠道：主行 = 该版本合计；明细只含该版本套餐。
  const accounts = []
  for (const account of credits.accounts) {
    accounts.push(Object.assign({ variant: plan.name }, account))
  }
  return Object.assign(planBase(plan), {
    creditsTotal: credits.unlimited ? null : credits.total,
    creditsUnlimited: credits.unlimited === true,
    creditsAccounts: accounts,
    // variants 保留单条，客户端据此显示「版本名 + 数值」大号行。
    variants: [{
      label: plan.name,
      total: credits.unlimited ? null : credits.total,
      unlimited: credits.unlimited === true,
    }],
    isAvailable: true,
  })
}

/** 统一 plan 接口：签名与其他渠道一致（ctx/shell/cfg），base 由 apply 闭包注入。 */
let injectedBase = null

/** [由 index.js 调用] 注入回环 web 服务基地址（http://127.0.0.1:<port>）。 */
export function setWebBase(base) {
  injectedBase = typeof base === 'string' && base.length > 0 ? base : null
}

/** 生成某个渠道的 fetchPlan（共享注入的 base 与错误兜底逻辑）。 */
function makeFetchPlan(plan, path) {
  return async function fetchPlan() {
    if (injectedBase === null) {
      return Object.assign(planBase(plan), {
        error: 'unavailable',
        message: plan.name + ' 状态不可用（本插件的 web 服务未就绪，无法读取 workbuddy-connect 状态）',
      })
    }
    try {
      return await fetchPlanWithBase(injectedBase, plan, path)
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      return Object.assign(execError(plan), { message: plan.name + ' 积分请求异常：' + msg })
    }
  }
}

/** 国内版渠道（默认导出，保持既有 import 兼容）。 */
export const workbuddy = Object.assign(cnPlan, { fetch: makeFetchPlan(cnPlan, CN_PATH) })
/** 国际版渠道（0.8.3 新增，独立开关/排序）。 */
export const workbuddyAi = Object.assign(aiPlan, { fetch: makeFetchPlan(aiPlan, AI_PATH) })

/**
 * 兼容导出：[0.8.3] 拆分渠道后，旧代码/测试仍从本模块 import
 * `fetchPlan`（国内版取数）。保留同义导出，语义等同 `workbuddy.fetch`。
 */
export const fetchPlan = workbuddy.fetch

export default workbuddy
