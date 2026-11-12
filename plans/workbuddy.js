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
/** 国内版 WorkBuddy 渠道定义。 */
const cnPlan = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  fields: { enabled: 'workbuddyEnabled' },
  schema: {
    workbuddyEnabled: z.boolean().default(true),
    /**
     * **[legacy 字段，已不生效]** 旧版"按账号勾选"的选择值（JSON 数组，存当时的账号 uid）。
     *
     * [2026-10-25] 客户端端点 `GET /v1/credits` **没有稳定账号 ID**，用户已同意取消按账号筛选：
     * 取数侧不再读取该字段、也不再据此改变口径；**字段与已保存的值原样保留**（不迁移、不清除），
     * 只为兼容旧配置与回滚。保留字符串类型以避免与 DSH 设置表单的数组投影纠缠。
     */
    workbuddyAccounts: z.string().default('[]'),
  },
  source: {
    provider: 'dsh-workbuddy-connect',
    endpoint: CN_PATH,
  },
}

/** 国际版 WorkBuddy AI 渠道定义（0.8.3 拆出，独立开关/排序）。 */
/** 读取一个 status 端点；404 → { notFound }，网络失败 → { err }。 */
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
/** 统一 plan 接口：签名与其他渠道一致（ctx/shell/cfg），base 由 apply 闭包注入。 */
let injectedBase = null

/** [由 index.js 调用] 注入回环 web 服务基地址（http://127.0.0.1:<port>）。 */
export function setWebBase(base) {
  injectedBase = typeof base === 'string' && base.length > 0 ? base : null
}

/** 生成某个渠道的 fetchPlan（共享注入的 base 与错误兜底逻辑）。 */

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

/**
 * [2026-10-25 客户端 Key 接口] 反代新增的**客户端**积分端点。
 *
 * 与管理员面 `/status` / `/panel/api/packages` 的区别（合约只读结构见
 * `.diagnostics/wb-client-credits-20261025/schema-probe.json`，无真实值）：
 *   - 根：`{ ok, time, request_id, total_credits, accounts: [] }`；
 *   - 每 account：`nickname, realm, credits, credits_total, credits_expiring,
 *     credits_earliest_expiry, credits_earliest_remaining, cooling, disabled, tokens`；
 *   - **没有 uid/id，也没有 packages**；
 *   - 根 `total_credits` 是**跨区合计**（cn + global），不能当国内余额。
 *
 * 因此运行期只打这一个端点：不探 `/status`、不探 `/panel/api/packages`，
 * 也不为旧管理员接口做任何自动回退。
 */
export const GATEWAY_CREDITS_PATH = '/v1/credits'

/** 业务口径：只统计国内域（用户 2026-10-25 确认：继续只算 cn）。 */
const GATEWAY_REALM = 'cn'

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
/**
 * [2026-10-25 客户端 Key 接口] 解析 `GET /v1/credits` 的**纯**函数（无 IO）。
 *
 * 硬规则（父审三点，逐条对应实现）：
 *   1. **有限负数保留**：只要 `credits` 是有限数就纳入（与旧口径一致），
 *      只有缺失 / 非数字 / NaN / Infinity 才算"该账号不可用"，**绝不造 0**。
 *   2. **realm 严格 `=== 'cn'`**：缺失或未知 realm 一律不纳入（旧 `/status`
 *      路径那种"realm 缺失默认算国内"的宽松口径**不适用于**新端点）。
 *   3. 合计**只累加**未停用账号的 `credits`；冷却中的仍计入（与旧口径一致）。
 *      **不看**根 `total_credits`（跨区合计），也不看 `credits_total`（累计额度）。
 *
 * @returns {{ok:true,total:number,accounts:Array}|{ok:false,reason:string}}
 */
export function creditsFromClientCredits(body, realm) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'shape' }
  if (body.ok !== true) return { ok: false, reason: 'not-ok' }
  if (!Array.isArray(body.accounts)) return { ok: false, reason: 'shape' }
  const want = typeof realm === 'string' && realm.length > 0 ? realm : GATEWAY_REALM
  const picked = []
  let matched = 0
  for (const account of body.accounts) {
    if (account === null || typeof account !== 'object') continue
    // ② realm 严格等于 'cn'：缺失/未知一律不纳入（global 坏值也不影响国内采样）。
    if (account.realm !== want) continue
    matched += 1
    const disabled = account.disabled === true
    const remain = typeof account.credits === 'number' && Number.isFinite(account.credits) ? account.credits : null
    /**
     * [2026-10-25 父审修正] 未停用的国内账号若 `credits` 缺失/非法（非数字、NaN、Infinity），
     * **保守判失败**，不猜 0、也不把"剩下的那部分"当成完整合计交给模型。
     * 已停用账号的这个字段不参与合计，坏值不应妨碍其它国内账号独立采样。
     */
    if (remain === null) {
      if (!disabled) return { ok: false, reason: 'bad-cn-credits' }
      continue
    }
    /**
     * ③ 到期摘要：真实合约只证明 `credits_earliest_remaining` 与
     * `credits_earliest_expiry` 是"最早到期的**那一部分**"；
     * `credits_expiring` 的统计窗口未知，**不使用**（不称"马上到期/7 天/全部在最早日到期"）。
     */
    const earliestRemaining = typeof account.credits_earliest_remaining === 'number'
      && Number.isFinite(account.credits_earliest_remaining)
      && account.credits_earliest_remaining > 0
      ? account.credits_earliest_remaining
      : null
    const earliestExpiry = typeof account.credits_earliest_expiry === 'string'
      && account.credits_earliest_expiry.length > 0
      && Number.isFinite(Date.parse(account.credits_earliest_expiry))
      ? account.credits_earliest_expiry
      : null
    picked.push({
      remain,
      // 两个都给且有效才出"最早到期部分"行；缺一个就不造到期条。
      earliestRemaining: earliestRemaining !== null && earliestExpiry !== null ? earliestRemaining : null,
      earliestExpiry: earliestRemaining !== null && earliestExpiry !== null ? earliestExpiry : null,
      cooling: account.cooling === true,
      disabled,
    })
  }
  if (matched === 0) return { ok: false, reason: 'no-cn-account' }
  if (picked.length === 0) return { ok: false, reason: 'no-credits' }
  let total = 0
  for (const row of picked) {
    if (row.disabled) continue
    total += row.remain
  }
  /**
   * [2026-10-25 父审边界②] 两个都接近 `Number.MAX_VALUE` 的有限值相加会溢出成 `Infinity`：
   * 一旦合计不再是有限数，就**固定失败**，绝不把 `Infinity` 当余额交给模型/界面。
   */
  if (!Number.isFinite(total)) return { ok: false, reason: 'bad-total' }
  return { ok: true, total, accounts: picked }
}

/** 解析失败 → 固定分类文案（**不透传**上游正文/原始 id）。 */
const CLIENT_CREDITS_REASON_TEXT = {
  shape: '客户端积分响应结构不合法（缺 accounts 数组）',
  'not-ok': '客户端积分端点返回未成功状态（ok != true）',
  'no-cn-account': '客户端积分响应里没有国内（cn）账号',
  'no-credits': '国内账号都没有可用的积分数值',
  'bad-cn-credits': '国内账号的积分数值缺失或非法（无法确认真实余额）',
  'bad-total': '国内积分合计超出可表示范围（数值异常，已停止给出余额）',
}

/**
 * [2026-10-25] 新端点 → 既有积分 wire（保持 ✦ 积分显示与白名单不变）。
 *
 * 明细只做**诚实的摘要**：
 *   - 只列**可用（未停用）**的国内账号一行"剩余"，`size` 留空 —— `credits_total` 是
 *     **累计额度**，不能伪装成一个真实积分包；停用账号既不进合计、也不作为可用余额展示；
 *   - 只有 `credits_earliest_remaining > 0` 且 `credits_earliest_expiry` 可解析时，
 *     才额外给一行「其中最早到期部分」，金额是该**部分**（不是整个账号剩余）；
 *     `credits_expiring` 统计窗口未证实，**不参与**任何金额或标签。
 */
function clientCreditsWire(plan, body) {
  const parsed = creditsFromClientCredits(body, GATEWAY_REALM)
  if (parsed.ok !== true) {
    return Object.assign(planBase(plan), {
      error: 'exec',
      message: plan.name + '：' + (CLIENT_CREDITS_REASON_TEXT[parsed.reason] || '客户端积分响应不可用'),
    })
  }
  const accounts = []
  for (const row of parsed.accounts) {
    // [2026-10-25 父审边界①] 停用账号不出现在可用明细里（否则会被读成"可用余额"）。
    if (row.disabled) continue
    accounts.push({
      variant: plan.name,
      packageName: null,
      remain: row.remain,
      size: null,
      endTimeMs: null,
    })
    /**
     * [2026-10-25 父审修正] 只按 `credits_earliest_remaining` + `credits_earliest_expiry`
     * 表达"其中最早到期部分"；`credits_expiring` 统计窗口未知，**不参与**。
     * 金额是该**部分**（不是整个账号剩余），日期非法/缺失时不出这一行。
     */
    if (row.earliestRemaining !== null && row.earliestExpiry !== null) {
      accounts.push({
        variant: plan.name,
        packageName: '其中最早到期部分',
        remain: row.earliestRemaining,
        size: null,
        endTimeMs: Date.parse(row.earliestExpiry) || null,
        subsetOfAccount: true,
      })
    }
  }
  return Object.assign(planBase(plan), {
    creditsTotal: parsed.total,
    creditsUnlimited: false,
    creditsAccounts: accounts,
    variants: [{ label: plan.name, total: parsed.total, unlimited: false }],
    // 作用域说明（客户端可用于文案；不参与合计）
    creditsScope: GATEWAY_REALM,
    isAvailable: true,
  })
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
  /**
   * [2026-10-25 客户端 Key] 只取**客户端**端点 `GET /v1/credits`。
   *
   * 拼接规则：provider 的 `baseURL` 可能已经带 `/v1`（反代常见形态），
   * 那时不能重复拼成 `/v1/v1/credits`。
   */
  const creditsUrl = creditsUrlOf(base)
  return { ok: true, creditsUrl, origin: base.origin, key, ref: source.apiKeyEnv }
}

/** `baseURL` → `origin + /v1/credits`（**单一明确路径**，不做多路径试探）。 */
export function creditsUrlOf(base) {
  /**
   * [2026-10-25 父审修正] 只用「origin 根下 /v1/credits」这**一条**已验证路径。
   *
   * `baseURL` 带不带 `/v1` 都得到同一个 URL（`origin + /v1/credits`），
   * 因此既不重复拼接、也不对任意挂载前缀做自行扩展。
   * 与来源指纹（`providerSourceFingerprint(..., GATEWAY_CREDITS_PATH)`）用的是同一路径。
   */
  return new URL(GATEWAY_CREDITS_PATH, base.origin).href
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
 * [R6-03] 主取数预算（明细端点已不再请求，故只保留一个超时）。
 */
const GATEWAY_TIMEOUT_MS = 12000

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
 * [2026-10-25 客户端 Key 端点] 账号列表：**已不再提供**。
 *
 * 新端点没有稳定账号 ID（也没有 packages），用户已同意不再支持"按账号勾选"。
 * 因此这里返回**固定元数据**：零凭据解析、零网关请求、零缓存；
 * 设置页也不再 GET 它，Host 路由保留只为兼容旧前端并明确说明不支持。
 */
export async function listWorkbuddyAccounts() {
  return {
    accounts: [],
    supported: false,
    message: '当前通过客户端接口 GET /v1/credits 读取积分（仅统计国内 cn），'
      + '该接口不提供稳定账号 ID，暂不支持按账号筛选；已保存的旧选择保留但不再生效。',
  }
}

/**
 * **历史实现**（仅供历史回归测试）：从管理员 `/status` 读账号维度。
 *
 * 运行期不再调用（不探 `/status`），也不代表新端点行为；保留它是为了让
 * 旧口径的解析/脱敏回归仍有覆盖。
 */
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
/**
 * [2026-10-25] `/panel/api/packages` 的**能力记忆已删除**。
 *
 * 改用客户端端点后不再请求面板接口，因此不需要"记住 404/401 别再打"。
 * `creditPackagesOf` 作为**纯函数**保留，仅供历史测试回归旧口径。
 */

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
  /**
   * [2026-10-25] **不再读取 `cfg.workbuddyAccounts` 做筛选**：
   * 客户端端点没有稳定账号 ID，用户已同意不再支持按账号勾选。
   * 字段仍保留在 schema 里（不清除旧值），但这里不解析、也不据此改口径。
   */
  /**
   * [R6-03] 从入口开始就用**同一份剩余预算**，而不是每个请求各拿 12 秒。
   *
   * 工具整体只有 8 秒；如果这里不看剩余时间，凭据解析 + 取数
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
    const got = await fetchJsonWithTimeout(source.creditsUrl, source.key, capTimeout(GATEWAY_TIMEOUT_MS), parentSignal)
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
    /**
     * [2026-10-30 incident §6.3] 文案按**失败种类**分开，且不再说“状态”（现取数端点是
     * `GET /v1/credits`，不是 `/status`）：超时/传输失败 → `网关请求失败（timeout）`，
     * 与 5xx 的 `网关请求失败（HTTP 502）` 明确可区分，不再与“没有可用账号”共用一句兜底。
     */
    return Object.assign(planBase(plan), {
      error: 'exec',
      transient: true,
      message: plan.name + ' 网关请求失败（' + transportCodeOf(err) + '）',
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
      message: plan.name + ' 网关没有 ' + GATEWAY_CREDITS_PATH + ' 端点（HTTP 404）：'
        + '该反代版本不支持客户端积分接口，请升级网关',
    })
  }
  if (!okFlag) {
    /**
     * [2026-10-30 incident §6.3] 网关侧 HTTP 错误（含 502）单独一类，点明状态码；
     * 不与「200 但没有 cn 账号」「cn 积分非法」共用同一句兜底文案。
     */
    return Object.assign(planBase(plan), {
      error: 'exec',
      transient: status === 429 || status >= 500,
      message: plan.name + ' 网关请求失败（HTTP ' + status + '）',
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
      message: plan.name + ' 客户端积分响应无法解析（HTTP ' + status + '，shape=invalid-json）',
    })
  }
  /**
   * [2026-10-25] **不再请求** `/panel/api/packages`。
   *
   * 新端点没有 packages 概念（合约：每账号只有 credits/credits_expiring/最早到期摘要），
   * 用客户端 Key 去探测管理员面板接口既无用也不礼貌；明细改由
   * `clientCreditsWire` 给出"剩余 + 即将到期部分"的诚实摘要。
   * 根 `ok !== true` / 结构不合法 / 无国内账号，都在纯解析里判失败。
   */
  return clientCreditsWire(plan, body)
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

/**
 * 兼容导出：[0.8.3] 拆分渠道后，旧代码/测试仍从本模块 import
 * `fetchPlan`（国内版取数）。保留同义导出，语义等同 `workbuddy.fetch`。
 */
export const fetchPlan = workbuddy.fetch
/** 国际版取数（等价 workbuddyAi.fetch）。 */

export default workbuddy
