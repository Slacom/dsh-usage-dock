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
import { createHash } from 'node:crypto'
import { planBase, execError } from './util.js'

/**
 * 单次 status 读取的超时（毫秒）。
 *
 * [0.8.3] 15s → 30s；[0.8.5] 30s → 35s，**必须严格大于** workbuddy-connect 内部的
 * 计费查询超时（其 `host-heartbeat-*.js` 的 `JSON_TIMEOUT_MS = 30000`）：
 *   - 若我们先超时（旧值 30s 与它相等，属于竞态）：拿到的是自己造的 AbortError，
 *     丢失「上游到底怎么错的」这条信息（是 401 掉登录还是 429 限流）；
 *   - 现在等它把 `creditsError` 结构化返回，本模块才能按 kind 分流成
 *     语义错误（透传）/ 暂时失败（保留旧值、灰化）。
 * 同时要小于客户端 `/api/plan-usage` 的 40s 超时（见 client.js），否则整体请求会被
 * 浏览器侧中断，连带所有渠道一起失败。
 */
const STATUS_TIMEOUT_MS = 35000

const CN_PATH = '/plugins/dsh-workbuddy-connect/status'
const AI_PATH = '/plugins/dsh-workbuddy-connect/ai/status'

/** 国内版 WorkBuddy 渠道定义。 */
const cnPlan = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  fields: { enabled: 'workbuddyEnabled' },
  schema: {
    workbuddyEnabled: z.boolean().default(true),
    /**
     * [2026-10-21 用户需求] 账号选择：JSON 数组，存**选中的账号 uid**。
     * 空数组 = 全部账号（默认，保持既有行为）；选了 N 个就只合计这 N 个。
     * 用字符串而不是数组字段，避免与 DSH 设置表单的数组投影纠缠。
     */
    workbuddyAccounts: z.string().default('[]'),
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

/**
 * [0.8.5] 把 workbuddy-connect 的 `creditsError` 文本分类，决定**能不能保留旧值**。
 *
 * 背景（用户 2026-10-18 反馈）：胶囊里 WorkBuddy / WorkBuddy AI 经常直接显示
 * 「获取失败」而不先灰化。原因不是降级逻辑没写，而是**分类太粗**——
 * 之前只要看到 `creditsError` 就归为 `error:'api'`，而客户端的语义错误是
 * **立即透传、不保留旧值**的（缺凭据/登录失效必须马上告诉用户）。
 *
 * connect 侧抛出的错误大部分是**暂时的**：它的 `fetchCredits` 里
 * `!response.ok || envelope.code !== 0` 一律向上抛，再被 status 路由包成
 * `creditsError`，文案由 `envelopeError()` 固定生成：
 *   `workbuddy upstream <kind> (http <status>): <上游原始 msg>`
 * kind 来自其 `classifyUpstreamError`：
 *   hard_credit / session_dead / soft_rate / not_found / server / client
 *
 * [0.8.5 修正 P2] **只认前缀，不扫全文**：上游原始 msg 是第三方文案，可能包含
 * 「http 401」「timeout」等字样（例如 429 响应体里写着 "your token ... 401"），
 * 若对整段做子串匹配就会被它带偏——曾出现「soft_rate 429 被判成 api、直接放弃灰化」
 * 的误判。因此：
 *   1. 先按固定前缀解析 `kind` 与 `status`，命中即以此为准（这两项来自 connect 自己的
 *      分类，不受上游文案影响）；
 *   2. 前缀不匹配（旧版 connect / 文案被改写）才退回全文启发式，且顺序改为
 *      **先判暂时、再判语义**——因为「误判成语义错误」会让胶囊直接显示失败，
 *      代价比多灰化几轮大得多。
 *
 * 分流规则：
 *   - `session_dead`（401 登录态失效）、`hard_credit`（402 积分/付费被拒）
 *     → `api` 语义错误，立即显示，不拿旧值顶（旧值会误导成「还有积分」）；
 *   - `soft_rate`（429 限流）、`server`（5xx）、`client` 其它、`not_found`
 *     → `exec` 暂时失败，客户端保留旧值并灰化，连续 FAIL_THRESHOLD 轮才显示失败；
 *   - 无法识别 → 暂时失败（保守：宁可多试几轮，也不要一有风吹草动就报错）。
 *
 * @param {string} text - `creditsError` 原文（connect 侧已脱敏、截断 500 字）。
 * @returns {{ error: 'api'|'exec', transient: boolean, authKind?: 'session-dead'|'hard-credit' }}
 */
function classifyCreditsError(text) {
  const msg = typeof text === 'string' ? text : String(text)
  const lower = msg.toLowerCase()

  // 1) 固定前缀优先：`workbuddy upstream <kind> (http <status>): <上游文案>`
  const head = /^workbuddy upstream ([a-z_]+) \(http (\d{3})\)/.exec(lower)
  if (head !== null) {
    const kind = head[1]
    const status = parseInt(head[2], 10)
    // connect 自己的分类：只有这两类是「确定没救了」。
    if (kind === 'session_dead') {
      return { error: 'api', transient: false, authKind: 'session-dead' }
    }
    if (kind === 'hard_credit') {
      return { error: 'api', transient: false, authKind: 'hard-credit' }
    }
    // 其余（soft_rate / server / client / not_found / 未来新增的 kind）一律暂时失败。
    // 唯一的例外是 HTTP 状态码本身就确定了语义：401/402 直接判语义。
    if (status === 401) return { error: 'api', transient: false, authKind: 'session-dead' }
    if (status === 402) return { error: 'api', transient: false, authKind: 'hard-credit' }
    return { error: 'exec', transient: true }
  }

  // 2) 前缀不匹配时的兜底启发式。顺序很重要：**先判暂时**。
  //    暂时性信号（限流/5xx/网络/超时）优先，避免被上游文案里的「401/token」带偏。
  if (/\bhttp (429|5\d\d)\b/.test(lower)
    || /soft_rate|server|timeout|timed out|abort|network|fetch failed|econn|socket|tls|certificate/.test(lower)) {
    return { error: 'exec', transient: true }
  }
  // 明确的语义信号（登录态/凭据/积分被拒）：只有出现这些关键词才立即报错。
  if (/session_dead|signed[ _-]?out|unauthor|invalid[ _-]?token|token (?:expired|invalid)|not signed in|登录(?:已)?失效|未登录/.test(lower)
    || /\bhttp 401\b/.test(lower)) {
    return { error: 'api', transient: false, authKind: 'session-dead' }
  }
  if (/hard_credit|insufficient|quota[ _-]?exceeded|积分不足/.test(lower) || /\bhttp 402\b/.test(lower)) {
    return { error: 'api', transient: false, authKind: 'hard-credit' }
  }
  // 3) 无法识别 → 暂时失败（保守）。
  return { error: 'exec', transient: true }
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
  // [0.8.5] creditsError 按类别分流：只有登录失效/硬拒绝才立即报错，
  // 限流、5xx、超时、结构变化一律记为暂时失败（exec），客户端会保留旧值并灰化，
  // 连续 FAIL_THRESHOLD 轮才显示「获取失败」——用户要求尽量少看到失败。
  if (body.creditsError !== undefined) {
    const detail = typeof body.creditsError === 'string' ? body.creditsError : '积分读取失败'
    const verdict = classifyCreditsError(detail)
    return Object.assign(planBase(plan), {
      error: verdict.error,
      message: plan.name + '：' + detail,
      // 给客户端与调试用：明确标记这是一次「可重试」的失败。
      transient: verdict.transient || undefined,
      // [A08] 把**结构化语义**带出去（不进入模型文本）：
      // 观察器据此区分「确定失效」与「暂时失败」，不必再从 error 名猜。
      authKind: verdict.authKind,
    })
  }
  const credits = creditsOf(body)
  if (credits === null) {
    // 结构解析失败往往是上游改版/半截响应，同样按暂时失败处理（不立即报错）。
    return Object.assign(planBase(plan), {
      error: 'exec',
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


// ===========================================================================
// [2026-10-21] 国内 WorkBuddy 改读 WorkBuddy2API 网关（内置渠道，非自定义）
// ===========================================================================
//
// 用户已撤销「新增自定义卡片/积分格式选项」方案，改为**替换内置国内 WorkBuddy 的数据源**：
// 从宿主当前有效模型配置解析 provider `workbuddy` 的来源，复用其网关 Bearer Key，
// 访问 GET <model origin>/status（**根路径**，不是 /v1/status）。
//
// 实测（wb2api-panel v1.13.0，2026-10-21）确认的 /status 结构：
//   { total, healthy, cooling, disabled, in_flight_full, credit_floor,
//     sticky_sessions, redis_mode, realm_totals: { cn: {...}, global: {...} },
//     cost_explore: { events_total, per_model },
//     model_locks: null | {...},          // 无锁定时为 null
//     accounts: [{ uid, nickname, credits, credits_total, credits_earliest_expiry,
//                  credits_earliest_remaining, cooling, until, realm, disabled,
//                  success_count, last_success, last_err, checkin_done,
//                  token_usage, model_costs, consecutive_fails, degrade_until,
//                  in_flight, breaker_fails, breaker_until }] }
//
// **口径（实测核对）**：`accounts[].credits` 是**剩余**积分，`credits_total` 是累计额度；
// 顶层**没有**积分汇总字段，合计必须由各账号 `credits` 求和 —— 不能拿 credits_total 当余额。
// `realm` 区分国内/国际（`cn` / `global`），本渠道只取 `cn`，避免把国际池混进国内积分。

const GATEWAY_PROVIDER = 'workbuddy'

/** 仅允许本机回环主机（本次明确选择的网关）。 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * 从网关 /status 响应算出积分（纯函数，便于用真实样本回归）。
 *
 * @param {object} body /status JSON
 * @param {string} realm 只统计该域（'cn'），空则全部
 * @returns {{ok:true, total:number, accounts:Array}|{ok:false, reason:string}}
 */
export function parseAccountSelection(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  let list
  try { list = JSON.parse(raw) } catch (err) { return [] }
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (typeof item === 'string' && item.length > 0 && out.indexOf(item) === -1) out.push(item)
  }
  return out
}

export function creditsFromGatewayStatus(body, realm, selectedUids) {
  if (body === null || typeof body !== 'object') return { ok: false, reason: 'shape' }
  if (!Array.isArray(body.accounts)) return { ok: false, reason: 'shape' }
  const want = typeof realm === 'string' && realm.length > 0 ? realm : ''
  // [2026-10-21] 账号筛选：空 = 全部；非空 = 只统计选中项。
  const only = Array.isArray(selectedUids) ? selectedUids : []
  const picked = []
  for (const account of body.accounts) {
    if (account === null || typeof account !== 'object') continue
    if (want.length > 0 && typeof account.realm === 'string' && account.realm !== want) continue
      // [2026-10-21] 账号筛选：空 = 全部；非空 = 只统计选中项。
      if (only.length > 0 && (typeof account.uid !== 'string' || only.indexOf(account.uid) === -1)) continue
    const remain = typeof account.credits === 'number' && Number.isFinite(account.credits)
      ? account.credits
      : null
    if (remain === null) continue
    picked.push({
      // 只保留公开可展示字段；uid/nickname 等身份信息不进 wire。
      remain,
      size: typeof account.credits_total === 'number' && Number.isFinite(account.credits_total)
        ? account.credits_total
        : null,
      cooling: account.cooling === true,
      disabled: account.disabled === true,
      inFlight: typeof account.in_flight === 'number' ? account.in_flight : 0,
      earliestExpiry: typeof account.credits_earliest_expiry === 'string'
        ? account.credits_earliest_expiry
        : null,
      earliestRemaining: typeof account.credits_earliest_remaining === 'number'
        ? account.credits_earliest_remaining
        : null,
    })
  }
  if (picked.length === 0) return { ok: false, reason: 'no-account' }
  /**
   * 合计口径：只累加**可用**账号（未停用）。
   * 冷却中的账号仍计入剩余（积分还在，只是暂时不可调度），
   * 这样胶囊不会因为一次冷却就跳变到 0。
   */
  let total = 0
  for (const row of picked) {
    if (row.disabled) continue
    total += row.remain
  }
  return { ok: true, total, accounts: picked }
}

/** 把网关响应映射成原有积分 wire（保持 ✦ 积分显示与白名单不变）。 */
/**
 * `/panel/api/packages` → 详情用的积分包列表（纯函数）。
 *
 * 结构（2026-10-21 实测）：
 *   accounts[]: { uid, nickname, realm, remain, size, packages[] }
 *   packages[]: { name, size, remain, used, expires_at(epoch ms), package_code, ... }
 *
 * 只输出展示所需的公开字段；不带 uid/nickname/package_code。
 * 已用完（remain<=0）的包按面板口径**不列**，避免详情被历史包淹没。
 */
export function creditPackagesOf(body, realm, selectedUids) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.accounts)) return []
  const want = typeof realm === 'string' && realm.length > 0 ? realm : ''
  // [2026-10-21] 账号筛选：空 = 全部；非空 = 只统计选中项。
  const only = Array.isArray(selectedUids) ? selectedUids : []
  const rows = []
  for (const account of body.accounts) {
    if (account === null || typeof account !== 'object') continue
    if (want.length > 0 && typeof account.realm === 'string' && account.realm !== want) continue
      // [2026-10-21] 账号筛选：空 = 全部；非空 = 只统计选中项。
      if (only.length > 0 && (typeof account.uid !== 'string' || only.indexOf(account.uid) === -1)) continue
    const packages = Array.isArray(account.packages) ? account.packages : []
    for (const pkg of packages) {
      if (pkg === null || typeof pkg !== 'object') continue
      const remain = typeof pkg.remain === 'number' && Number.isFinite(pkg.remain) ? pkg.remain : null
      if (remain === null || remain <= 0) continue
      const size = typeof pkg.size === 'number' && Number.isFinite(pkg.size) ? pkg.size : null
      const expiry = typeof pkg.expires_at === 'number' && Number.isFinite(pkg.expires_at)
        ? pkg.expires_at
        : null
      rows.push({
        variant: 'WorkBuddy',
        packageName: typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : null,
        remain,
        size,
        endTimeMs: expiry,
      })
    }
  }
  // 先到期的排前面（与面板「按到期升序、近的在前」一致）。
  rows.sort((a, b) => {
    if (a.endTimeMs === null && b.endTimeMs === null) return 0
    if (a.endTimeMs === null) return 1
    if (b.endTimeMs === null) return -1
    return a.endTimeMs - b.endTimeMs
  })
  return rows
}
function gatewayWire(plan, body, realm, packagesBody, selectedUids) {
  const parsed = creditsFromGatewayStatus(body, realm, selectedUids)
  if (parsed.ok !== true) {
    return Object.assign(planBase(plan), {
      error: 'exec',
      message: plan.name + '：网关状态响应里没有可用的积分字段（已确认的字段为 accounts[].credits）',
    })
  }
  /**
   * 明细优先用 `/panel/api/packages`（含每个积分包的面额/剩余/到期）；
   * 拿不到时退回「按账号汇总」一行，保证详情不空。
   */
  const detail = creditPackagesOf(packagesBody, realm, selectedUids)
  const accounts = []
  if (detail.length > 0) {
    for (const pkg of detail) accounts.push(pkg)
  } else {
    for (const row of parsed.accounts) {
      if (row.size === null && row.remain === null) continue
      accounts.push({
        variant: plan.name,
        packageName: null,
        remain: row.remain,
        size: row.size,
        endTimeMs: row.earliestExpiry !== null ? Date.parse(row.earliestExpiry) || null : null,
      })
    }
  }
  return Object.assign(planBase(plan), {
    creditsTotal: parsed.total,
    creditsUnlimited: false,
    creditsAccounts: accounts,
    variants: [{ label: plan.name, total: parsed.total, unlimited: false }],
    isAvailable: true,
  })
}

/**
 * 从宿主有效模型配置解析网关来源（origin + 凭据引用）。
 *
 * 只走宿主公开目录 + 已组合配置，不扫任意 providers、不做深合并。
 */
async function resolveGatewaySource(ctx, budgetMs) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') {
    return { ok: false, error: 'unavailable', message: '缺少宿主上下文，无法读取模型网关配置' }
  }
  const { providerSourceOf } = await import('./custom-balance.js')
  // 显式允许本机回环 HTTP（仅此网关）；通用自定义渠道不受影响。
  const source = await providerSourceOf(ctx, GATEWAY_PROVIDER, { allowLoopbackHttp: true })
  if (source.ok !== true) {
    // 区分「没配置」与「配置不合法」：后者是用户可修的配置错误。
    /**
     * 透传来源解析的**真实**错误码，不要二分：
     *   unavailable    宿主缺模型目录（能力问题，升级宿主）
     *   not-configured 模型里没配这个 provider（用户补配置）
     *   config         配了但地址不合法（用户改配置）
     *   no-key/oauth   有来源但拿不到 Bearer Key（用户补 Key）
     */
    const passThrough = ['unavailable', 'not-configured', 'config', 'no-key', 'oauth']
    const code = passThrough.indexOf(source.error) !== -1 ? source.error : 'not-configured'
    return {
      ok: false,
      error: code,
      message: '读取 ' + GATEWAY_PROVIDER + ' 网关配置失败：' + source.message,
    }
  }
  let base
  try { base = new URL(source.baseURL) } catch (err) {
    return { ok: false, error: 'config', message: '网关地址不是合法 URL' }
  }
  /**
   * 本机回环 HTTP 例外：**仅限**本次明确选择的网关。
   * 这里不接受任意私网地址，也不因此放宽通用自定义渠道的 HTTPS 规则。
   */
  if (base.protocol === 'http:') {
    if (!isLoopbackHost(base.hostname)) {
      return { ok: false, error: 'config', message: '网关地址必须是本机回环（localhost/127.0.0.1）或 https' }
    }
  } else if (base.protocol !== 'https:') {
    return { ok: false, error: 'config', message: '网关地址协议不受支持' }
  }
  if (base.username.length > 0 || base.password.length > 0) {
    return { ok: false, error: 'config', message: '网关地址包含用户名/密码，不支持' }
  }
  let key = ''
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      /**
       * [R6-03] 凭据解析也必须落在同一份剩余预算内：
       * 它可能访问外部凭据库，挂住时同样会把整条渠道拖成 missing。
       */
      const want = typeof budgetMs === 'number' && Number.isFinite(budgetMs) ? budgetMs : GATEWAY_TIMEOUT_MS
      const got = await raceWithTimeout(credentials.resolve(source.apiKeyEnv), want, '读取网关凭据超时')
      if (got !== undefined && got !== null && typeof got.value === 'string') key = got.value
    }
  } catch (err) {
    return { ok: false, error: 'no-key', message: '无法从凭据库读取网关 Key，请到「设置 → 模型」确认' }
  }
  if (key.length === 0) {
    return {
      ok: false,
      error: 'no-key',
      message: '网关没有可用的 API Key（' + source.apiKeyEnv + '），请到「设置 → 模型」补全',
    }
  }
  // 状态路径固定取 origin 根下的 /status（不是 /v1/status）。
  const statusUrl = new URL('/status', base.origin).href
  return { ok: true, statusUrl, origin: base.origin, key, ref: source.apiKeyEnv }
}


/**
 * [2026-10-21 真机问题] 网关请求必须有**硬超时**与 `accept-encoding: identity`。
 *
 * 两个都是踩过的真实坑：
 *  1. **没有超时** —— 网关一旦不响应，Host 的整批取数会被这一条拖住，路由迟迟不返回，
 *     胶囊就"什么都不显示"；重启后前几轮正常、跑一阵才复发，正是这种挂起型故障的特征。
 *  2. **不声明 identity** —— DSH 的 compress.js × gzip 中间件在「小响应体 + Content-Length」
 *     上会互相踩踏导致连接被 reset（0.8.2 在 Connect status 上已经踩过一次）。
 *     本网关 /status 只有 ~1.3 KB，正落在这个区间。
 */
/**
 * [R6-03] 明细是「锦上添花」，必须比合计**短得多**。
 *
 * 工具整体只有 8 秒预算；明细若也用 12 秒主超时，一旦它挂住就会把
 * 已经拿到的合计一起拖没（审核实测 8010ms 返回空列表）。
 * 所以明细单独限时，超时就只交付合计。
 */
const GATEWAY_TIMEOUT_MS = 12000
const GATEWAY_PACKAGES_TIMEOUT_MS = 2500

/**
 * [2026-10-21 真机问题 v2] 网关请求：**在超时窗口内读完正文**，成功路径绝不 abort。
 *
 * 第一版在这里踩了一个自己造的坑：`Promise.race([request, timeout])` 在**响应头**到达时
 * 就 resolve，而 `finally` 里无条件 `controller.abort()` —— 紧接着的 `response.json()`
 * 读正文时连接已被自己掐断，真机表现是「读取网关账号失败：This operation was aborted」，
 * 胶囊同时「获取失败」。所以：
 *   - 只有**真的超时**才 abort；
 *   - 正文读取必须在计时器仍然armed时完成（把它放进这里，而不是返回 response 让调用方读）；
 *   - 成功路径只 clearTimeout，不动 signal。
 *
 * 同时保留 `accept-encoding: identity`（DSH compress.js × gzip 在小响应体上会踩踏）。
 */
async function fetchJsonWithTimeout(url, key, timeoutMs, parentSignal) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  let timedOut = false
  const abortNow = () => {
    if (controller === null) return
    try { controller.abort() } catch (err) { /* 已结束 */ }
  }
  /**
   * [R8-02] 父 signal（调用者取消）必须贯穿到在途连接与正文读取。
   *
   * 上一版只认自己的超时计时器：调用方已经 abort，只要 `remaining` 还是正数，
   * 仍然会带着 Bearer 外发请求。这里在**发请求之前**先判一次，并把父取消
   * 转发给子 controller，让在途 fetch 与 body 一起停下。
   */
  const cancelledError = () => {
    const err = new Error('本次调用已取消')
    err.code = 'ECANCELLED'
    return err
  }
  if (parentSignal !== null && parentSignal !== undefined && parentSignal.aborted === true) {
    throw cancelledError()
  }
  let detachParent = () => {}
  if (parentSignal !== null && parentSignal !== undefined && typeof parentSignal.addEventListener === 'function') {
    const onAbort = () => abortNow()
    try {
      parentSignal.addEventListener('abort', onAbort)
      detachParent = () => {
        try { parentSignal.removeEventListener('abort', onAbort) } catch (err) { /* 已移除 */ }
      }
    } catch (err) { /* 不支持事件：退回仅入口检查 */ }
  }
  const onTimeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      abortNow()
      const err = new Error('网关请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）')
      err.code = 'ETIMEDOUT'
      reject(err)
    }, timeoutMs)
  })
  const work = (async () => {
    const response = await fetch(url, {
      method: 'GET',
      // 不跟随重定向：凭据不随跳转离开所选 origin。
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + key,
        accept: 'application/json',
        'accept-encoding': 'identity',
      },
      ...(controller !== null ? { signal: controller.signal } : {}),
    })
    /**
     * 关键：正文也在超时窗口内读完，超时才算真的失败。
     *
     * [2026-10-21 真机 v3] 不再依赖 `response.ok` 与 `response.json()`：
     *   - 宿主/移植端的 fetch 可能是包装对象，`ok` 未必存在 → 用 `status` 判成功；
     *   - `json()` 在某些实现上对 `identity` 响应也会抛，改用 `text()` + `JSON.parse`，
     *     这样解析失败时能把**前 120 字**带进错误消息，便于在界面上直接看出
     *     回来的到底是什么（HTML 错误页 / 空串 / gzip 残片）。
     */
    const status = typeof response.status === 'number' ? response.status : 0
    const okFlag = typeof response.ok === 'boolean'
      ? response.ok
      : (status >= 200 && status < 300)
    let body = null
    let parseError = null
    let preview = ''
    if (okFlag) {
      let text = null
      try {
        text = await response.text()
      } catch (err) {
        /**
         * [R9-02 / 根因 B] 正文读取期间的取消必须保留 C 语义。
         * 之前这里把 AbortError 当成「解析失败」，于是最终被归成 invalid-json / T。
         */
        if (parentSignal !== null && parentSignal !== undefined && parentSignal.aborted === true) {
          const cancelErr = new Error('本次调用已取消')
          cancelErr.code = 'ECANCELLED'
          throw cancelErr
        }
        parseError = err
      }
      if (text !== null && typeof text === 'string') {
        if (text.trim().length === 0) {
          parseError = new Error('响应体为空')
        } else {
          try {
            body = JSON.parse(text)
          } catch (err) {
            parseError = err
            preview = text.slice(0, 120)
          }
        }
      }
    }
    return { response, body, parseError, preview }
  })()
  try {
    return await Promise.race([work, onTimeout])
  } finally {
    clearTimeout(timer)
    detachParent()
    // 只有超时才需要收尾；成功路径**不能** abort。
    if (timedOut) abortNow()
  }
}
/**
 *
 * 返回 `{ accounts: [{ id, label, realm, remain, size, disabled, cooling }], error? }`。
 * `id` 是账号 uid（仅作选择键，不含凭据）；`label` 优先昵称。
 */
export async function listWorkbuddyAccounts(ctx, fetchImpl) {
  const source = await resolveGatewaySource(ctx)
  if (source.ok !== true) return { accounts: [], message: source.message }
  let body = null
  try {
    const got = await fetchJsonWithTimeout(source.statusUrl, source.key, GATEWAY_TIMEOUT_MS)
    // 宿主/移植端的 fetch 包装未必有 `ok`，以 status 为准。
    const status = typeof got.response.status === 'number' ? got.response.status : 0
    const okFlag = typeof got.response.ok === 'boolean'
      ? got.response.ok
      : (status >= 200 && status < 300)
    if (!okFlag) return { accounts: [], message: '网关返回 HTTP ' + status }
    body = got.body
    if (body === null) {
      /**
       * [R7-02] 与主 wire 同一规范：**只给固定分类 + HTTP 状态**。
       *
       * `JSON.parse` 的原始 message 会带正文片段（`Unexpected token 'S', "SYNTHETIC_"...`），
       * 拼进这里等于把上游内容回显到 GUI。账号列表是另一个公开出口，必须同样收紧。
       */
      return {
        accounts: [],
        message: '账号响应无法解析（HTTP ' + status + '，shape=invalid-json）',
      }
    }
  } catch (err) {
    // [R9-03] 固定分类，不透传异常原文。
    return { accounts: [], message: '读取网关账号失败（' + transportCodeOf(err) + '）' }
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.accounts)) {
    return { accounts: [], message: '网关状态响应里没有账号列表' }
  }
  const accounts = []
  for (const account of body.accounts) {
    if (account === null || typeof account !== 'object') continue
    if (typeof account.uid !== 'string' || account.uid.length === 0) continue
    if (typeof account.realm === 'string' && account.realm !== 'cn') continue
    const nickname = typeof account.nickname === 'string' && account.nickname.length > 0
      ? account.nickname
      : account.uid.slice(0, 8)
    accounts.push({
      id: account.uid,
      label: nickname,
      realm: typeof account.realm === 'string' ? account.realm : '',
      remain: typeof account.credits === 'number' ? account.credits : null,
      size: typeof account.credits_total === 'number' ? account.credits_total : null,
      disabled: account.disabled === true,
      cooling: account.cooling === true,
    })
  }
  return { accounts }
}

/**
 * [R6-03] 给**非 HTTP 的异步步骤**（凭据解析）套一个硬超时。
 *
 * 与 `fetchJsonWithTimeout` 同一条原则：只做竞速，成功路径不产生副作用；
 * 超时后原 Promise 仍会自己结束，这里只是不再等它。
 */
function raceWithTimeout(promise, timeoutMs, label) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label + '（' + Math.round(timeoutMs / 1000) + ' 秒）')
      err.code = 'ETIMEDOUT'
      reject(err)
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * [R6-02] 账号选择的**规范化指纹**（纯函数，供 Host 观察身份使用）。
 *
 * 排序后拼接再取不可逆短摘要：勾选顺序不同不算变化，「换成另一组账号」一定变。
 * 只回摘要，**不**输出 uid 列表。
 */
export function selectedAccountsFingerprint(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'all'
  let parsed
  try { parsed = JSON.parse(raw) } catch (err) { return 'all' }
  if (!Array.isArray(parsed) || parsed.length === 0) return 'all'
  const list = []
  for (const item of parsed) {
    if (typeof item === 'string' && item.length > 0 && list.indexOf(item) === -1) list.push(item)
  }
  if (list.length === 0) return 'all'
  list.sort()
  return createHash('sha256').update('dsh-usage-dock:accounts\u0000' + list.join('\u0001'))
    .digest('hex').slice(0, 16)
}

/**
 * [2026-10-21 用户新网关] 明细端点的**能力记忆**。
 *
 * 用户把 WorkBuddy 反代地址换成另一台主机后，`/status` 正常但
 * `/panel/api/packages` 返回 404（该反代没有暴露面板接口）。
 * 这种情况下每 30 秒白打一次 404 没有意义，因此按 origin 记住
 * 「该网关不提供明细」，10 分钟后再试一次（万一对方后续加上了）。
 */
const packagesUnsupportedUntil = new Map()
const PACKAGES_RETRY_MS = 10 * 60 * 1000

/**
 * [R9-03 / 根因 C] 公开错误 DTO 只允许**固定分类**。
 *
 * `err.message` 可能带上游正文、原生 Headers 错误里的非法字符乃至 Key 片段
 * （审核用合成 Key 的换行触发过真实的 Headers 报错回显）。因此公开出口一律
 * 只给安全诊断码，不透传异常原文。
 */
function transportCodeOf(err) {
  if (err === null || err === undefined) return 'transport'
  if (err.code === 'ECANCELLED') return 'cancelled'
  if (err.code === 'ETIMEDOUT') return 'timeout'
  if (err.name === 'AbortError') return 'cancelled'
  return 'transport'
}
/** 国内 WorkBuddy：从 WorkBuddy2API 网关读积分。 */
export async function fetchFromGateway(ctx, plan, cfg, options) {
  // [2026-10-21] 账号选择：cfg 里的 JSON 数组；空 = 全部账号。
  const selected = parseAccountSelection(cfg !== null && cfg !== undefined ? cfg.workbuddyAccounts : '')
  /**
   * [R6-03] 从入口开始就用**同一份剩余预算**，而不是每个请求各拿 12 秒。
   *
   * 工具整体只有 8 秒；如果这里不看剩余时间，凭据解析 + /status + 明细
   * 很容易累计超过它，结果**已经拿到的合计**也被判成 missing。
   */
  const remainingOf = options !== null && options !== undefined && typeof options.remaining === 'function'
    ? () => {
      const left = options.remaining()
      return typeof left === 'number' && Number.isFinite(left) ? left : null
    }
    : () => null
  /**
   * [R7-03] 预算函数语义收紧：
   *
   *  - 剩余 <= 0 时返回 **0**（不是 300）—— 调用方据此**跳过请求**，
   *    而不是硬给 300ms 继续外发；
   *  - 剩余很小时按比例收缩，只留 50ms 收尾，不再无条件放大到 300ms。
   */
  const capTimeout = (want) => {
    const left = remainingOf()
    if (left === null) return want
    if (left <= 0) return 0
    return Math.max(1, Math.min(want, left - 50))
  }
  /**
   * [R8-02] 调用者取消：**归 C，不计 T**（不是暂时失败），且零请求。
   * `remaining` 还是正数也不代表这次调用仍然获授权。
   */
  const parentSignal = options !== null && options !== undefined ? options.signal : undefined
  const cancelled = () => parentSignal !== null && parentSignal !== undefined
    && parentSignal.aborted === true
  const cancelledResult = () => Object.assign(planBase(plan), {
    error: 'cancelled',
    cancelled: true,
    transient: false,
    // 客户端据 stale 跳过「获取失败」红字，保留上一份数据（取消不是错误）。
    stale: true,
    message: plan.name + ' 本次调用已取消',
  })
  if (cancelled()) return cancelledResult()
  /** 预算已耗尽 → 直接给出可辨的「本次未取」结果，**零请求**。 */
  const exhaustedResult = () => Object.assign(planBase(plan), {
    error: 'exec',
    transient: true,
    message: plan.name + ' 本次调用预算已用尽，未发起网关请求',
  })
  if (capTimeout(GATEWAY_TIMEOUT_MS) <= 0) return exhaustedResult()
  const source = await resolveGatewaySource(ctx, capTimeout(GATEWAY_TIMEOUT_MS))
  if (source.ok !== true) {
    return Object.assign(planBase(plan), { error: source.error, message: source.message })
  }
  // 凭据解析也可能耗掉大半预算/已被取消，回来后再检查一次。
  if (cancelled()) return cancelledResult()
  if (capTimeout(GATEWAY_TIMEOUT_MS) <= 0) return exhaustedResult()
  let response
  let parsedBody = null
  let parseFailed = false
  try {
    const got = await fetchJsonWithTimeout(source.statusUrl, source.key, capTimeout(GATEWAY_TIMEOUT_MS), parentSignal)
    response = got.response
    parsedBody = got.body
    parseFailed = got.body === null
    // [R9-02] 正文阶段被取消：保留 C 语义，不进入 invalid-json 分类。
    if (cancelled()) return cancelledResult()
  } catch (err) {
    // [R8-02] 取消归 C：不当作暂时失败，也不参与失败计数。
    if (err !== null && err !== undefined && err.code === 'ECANCELLED') return cancelledResult()
    if (cancelled()) return cancelledResult()
    // [R9-03] 固定分类，不透传异常原文（可能含 Key / 上游片段）。
    return Object.assign(planBase(plan), {
      error: 'exec',
      transient: true,
      message: plan.name + ' 网关状态读取失败（' + transportCodeOf(err) + '）',
    })
  }
  /**
   * [R6-05] 一律用**归一化**的 status/ok 判定，不再直接读 `response.ok`。
   *
   * 包装 fetch 可能只有 `status` 而没有 `ok`，那时旧代码会把 200 当成失败
   * （「网关返回 HTTP 200」）。
   */
  const status = typeof response.status === 'number' ? response.status : 0
  const okFlag = typeof response.ok === 'boolean'
    ? response.ok
    : (status >= 200 && status < 300)
  if (status === 401 || status === 403) {
    return Object.assign(planBase(plan), {
      error: 'auth',
      authKind: 'gateway-key',
      message: plan.name + ' 网关鉴权失败（HTTP ' + status + '）：请检查「设置 → 模型」中该网关的 API Key',
    })
  }
  if (status === 404) {
    return Object.assign(planBase(plan), {
      error: 'api',
      message: plan.name + ' 网关没有 /status 端点（HTTP 404）：请确认网关版本支持状态查询',
    })
  }
  if (!okFlag) {
    return Object.assign(planBase(plan), {
      error: 'exec',
      transient: status === 429 || status >= 500,
      message: plan.name + ' 网关返回 HTTP ' + status,
    })
  }
  /**
   * [2026-10-21 真机 v4] 正文已经由 `fetchJsonWithTimeout` 读完并解析，**不能再读一次**。
   *
   * 这里原来又调了一次 `response.json()`：流的 body 已被消费，
   * 第二次读必然抛错 → 真机一直显示「网关状态响应不是合法 JSON」，
   * 而实际数据是好的。现在直接用 `parsedBody`。
   *
   * [R6-04] 失败时**只给固定分类**：不返回上游正文片段，也不返回解析器原文
   * ——`JSON.parse` 的 message 本身可能回显正文，等于绕过 secret 不回显边界。
   */
  const body = parsedBody
  if (body === null || parseFailed) {
    return Object.assign(planBase(plan), {
      error: 'exec',
      transient: false,
      // 固定分类 + HTTP 状态，不含任何上游内容。
      message: plan.name + ' 网关状态响应无法解析（HTTP ' + status + '，shape=invalid-json）',
    })
  }
  /**
   * [2026-10-21 用户需求] 详情要能看到**具体积分包与到期日**。
   *
   * 网关把明细放在另一个端点 `/panel/api/packages`（面板「积分构成」页用的就是它），
   * 结构：accounts[].packages[] = { name, size, remain, used, expires_at(epoch ms), ... }。
   *
   * [R6-03] 明细属于**锦上添花**，必须显著短于合计的超时：
   * 它挂住时只交付合计，绝不把已经成功的结果一起抹掉。
   */
  let packages = null
  /**
   * [R7-03] 预算耗尽时**直接跳过可选明细**，不再外发请求。
   * 合计已经拿到，这里跳过不影响主结果。
   */
  if (cancelled()) return gatewayWire(plan, body, 'cn', null, selected)
  const pkgBudget = capTimeout(GATEWAY_PACKAGES_TIMEOUT_MS)
  const pkgMemoUntil = packagesUnsupportedUntil.get(source.origin) || 0
  if (pkgBudget > 0 && Date.now() >= pkgMemoUntil) try {
    const pkgUrl = new URL('/panel/api/packages', source.origin).href
    const pkgGot = await fetchJsonWithTimeout(
      pkgUrl,
      source.key,
      pkgBudget,
      parentSignal,
    )
    const pkgStatus = typeof pkgGot.response.status === 'number' ? pkgGot.response.status : 0
    const pkgOk = typeof pkgGot.response.ok === 'boolean'
      ? pkgGot.response.ok
      : (pkgStatus >= 200 && pkgStatus < 300)
    if (pkgOk && pkgGot.body !== null) {
      packages = pkgGot.body
      packagesUnsupportedUntil.delete(source.origin)
    } else if (pkgStatus === 404) {
      // 该网关没有面板接口：记住，别每轮都打。
      packagesUnsupportedUntil.set(source.origin, Date.now() + PACKAGES_RETRY_MS)
    }
  } catch (err) {
    packages = null
  }
  return gatewayWire(plan, body, 'cn', packages, selected)
}
/**
 * 国内版渠道（默认导出，保持既有 import 兼容）。
 *
 * [2026-10-21] 数据源改为 WorkBuddy2API 网关：保留 channel id `workbuddy`、
 * 开关、排序位置、✦ 积分显示与详情，只替换取数来源。
 * 国际版（workbuddyAi）**不受影响**，仍走旧的 Connect 端点。
 */
export const workbuddy = Object.assign(cnPlan, {
  fetch: async function fetchFromGatewayPlan(ctx, shell, cfg, options) {
    try {
      return await fetchFromGateway(ctx, cnPlan, cfg, options)
    } catch (err) {
      // [R9-03] 外层兜底同样是公开出口：固定分类，不透传原文。
      return Object.assign(execError(cnPlan), {
        message: cnPlan.name + ' 网关取数异常（' + transportCodeOf(err) + '）',
      })
    }
  },
})
/** 国际版渠道（0.8.3 新增，独立开关/排序）。 */
export const workbuddyAi = Object.assign(aiPlan, { fetch: makeFetchPlan(aiPlan, AI_PATH) })

/**
 * 兼容导出：[0.8.3] 拆分渠道后，旧代码/测试仍从本模块 import
 * `fetchPlan`（国内版取数）。保留同义导出，语义等同 `workbuddy.fetch`。
 */
export const fetchPlan = workbuddy.fetch
/** 国际版取数（等价 workbuddyAi.fetch）。 */
export const fetchPlanAi = workbuddyAi.fetch

export default workbuddy
