/**
 * codex-account.js — 本插件**自持**的 Codex（ChatGPT 账号）OAuth 私有凭据 + 额度读取。
 *
 * 为什么需要这个模块（已核实的背景）：
 *   官方 SIWC devkit 不提供额度读取接口（OpenAI issue #3 明确不支持），`dsh-codex-connect`
 *   的公开 SDK 也只暴露「已登录账号」的投影。用户的既有选择因此是：本插件自己走
 *   **Codex CLI 同款设备码 OAuth**，把 token 只放进本插件自己的凭据记录
 *   （`dsh-usage-dock/codex`），再直接读 ChatGPT 的额度接口。
 *
 * 硬边界（写代码时不得放宽）：
 *   1. **固定端点**：所有 URL 都是本文件的常量，不接受调用方 / 配置 / 客户端传入的 URL。
 *      `createCodexAccountLogin` 也不接受任何 URL 选项。
 *   2. **不跟随重定向**（`redirect:'manual'`）、**15 秒超时**、**响应体 ≤ 512 KiB**、
 *      只接受 JSON **对象**；任何上游正文都**不**回显（错误 message 全是固定文案）。
 *   3. **token 只出现在一个地方**：本模块自持的凭据记录，以及 `readCodexAccountRecord` /
 *      `fetchCodexAccountUsage` 内部返回的 `credential` 对象。身份摘要、状态、登录快照、
 *      错误 message / reason **一律不含** access / refresh / id_token。
 *   4. 记录严格校验：缺字段 / 类型错 / `expires` 非正 / 重复 id / 账户数超限 ⇒ `incompatible`，
 *      **绝不**把坏记录当可用，也绝不「尽力清洗」后继续用。唯一的例外是下面定义的
 *      **空态 tombstone**（「没有账户」的合法表示，判 `absent`，不是「坏记录」）。
 *   5. 刷新只在 `credentials.modifyRecord()` 的**独占写**里落地：mutate 内重新读当前记录，
 *      同一 `credentialId` 且确实已过期才写；别人已经刷新过就返回 `undefined`（不覆盖）。
 *      并发刷新 single-flight，只打一次 token 端点。
 *
 * 多账户（[2026-11-23] v2 记录）：
 *   一条记录 `dsh-usage-dock/codex`（`kind:'grant'`）里保存 **1..8 个** ChatGPT 账号，
 *   payload 形如 `{version:2, activeAccountId, accounts:[credential, ...]}`；`credential` 仍是
 *   `{type:'oauth', access, refresh, expires, accountId, credentialId, revision, savedAt,
 *   planType?, email?}`，`credentialId` / `accountId` 各自唯一，`activeAccountId` 必须命中某个
 *   `credentialId`。**旧 v1 记录**（payload 就是单个 credential）在内存中等价于
 *   `{version:1, accounts:[credential], activeAccountId: credential.credentialId}`，
 *   **读路径不改盘**，任何写操作（登录 / 选择 / 移除 / 刷新）落成 v2。
 *   所有「取哪份 token」的判断都以 `active` 账户为准，其余账户原样保留（互不影响）。
 *
 * 空态记录（[2026-11-25 R5] tombstone）：
 *   移除**最后一个**账户时**不删记录**，而是在同一个 `modifyRecord` 独占写里把它改写成精确的
 *   空态形状 `{kind:'grant', payload:{version:2, activeAccountId:null, accounts:[]}}`
 *   （见 `emptyCodexAccountRecord()`）。`validateCodexAccountRecord()` 把这一**精确形状**判为
 *   `absent`，于是所有读路径 / `state` / UI 自然得到「未登录」，不再需要 `deleteRecord`。
 *   这样既不会在「事务外确认 → 无条件删除」之间误删别人刚新增的账户，也不需要
 *   「在 mutate 里调 deleteRecord」（对同一把锁重入，可能死锁）。
 *
 * 协议（Codex CLI 设备码公开流程）：
 *   ① `POST /api/accounts/deviceauth/usercode`（JSON `{client_id}`）→ `{device_auth_id,user_code,interval}`
 *   ② 轮询 `POST /api/accounts/deviceauth/token`（JSON `{device_auth_id,user_code}`）
 *      403/404 或 `deviceauth_authorization_pending` → pending；`slow_down` → slow_down；
 *      成功 → `{authorization_code, code_verifier}`
 *   ③ `POST /oauth/token`（form，`grant_type=authorization_code&client_id&code&code_verifier&redirect_uri`）
 *   ④ accountId / planType 取 access_token JWT 的 `"https://api.openai.com/auth"` 声明；
 *      email 可选地取 id_token（仅展示，失败不影响登录）。
 *   刷新：`POST /oauth/token`（form，`grant_type=refresh_token&refresh_token&client_id`）。
 *   额度：`GET https://chatgpt.com/backend-api/wham/usage`（Bearer + `chatgpt-account-id`）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { describeCodexCredentialsService, readCodexCredentialsService } from './codex-sources.js'

// ---------------------------------------------------------------------------
// 固定常量（端点 / 客户端 ID 均写死，不接受任何外部输入）
// ---------------------------------------------------------------------------

/** 本插件私有凭据记录的 key（`<scope>/<id>`，两段都满足凭据服务的命名规则）。 */
export const CODEX_ACCOUNT_RECORD_KEY = 'dsh-usage-dock/codex'
/** Codex CLI 的公开 OAuth client id（设备码流程固定用它）。 */
export const CODEX_ACCOUNT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** OAuth 颁发方（也是设备码验证页所在 origin）。 */
export const CODEX_AUTH_ORIGIN = 'https://auth.openai.com'
/** 设备码验证页（固定；不随响应变化）。 */
export const CODEX_ACCOUNT_DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device'
/** 额度接口（固定）。 */
export const CODEX_ACCOUNT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/** 设备码兑换时使用的 redirect_uri（设备码流程专属，固定）。 */
const CODEX_ACCOUNT_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'

const DEVICE_CODE_URL = CODEX_AUTH_ORIGIN + '/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = CODEX_AUTH_ORIGIN + '/api/accounts/deviceauth/token'
const TOKEN_URL = CODEX_AUTH_ORIGIN + '/oauth/token'

/** JWT 里承载 ChatGPT 账号信息的声明名（固定）。 */
const AUTH_CLAIM = 'https://api.openai.com/auth'

const FIVE_HOURS_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60

const REQUEST_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 512 * 1024
/** access / refresh 单值上限（超出即视为坏记录 / 坏响应，不做截断）。 */
const MAX_TOKEN_LEN = 8192
const MAX_ACCOUNT_ID_LEN = 200
const MAX_CREDENTIAL_ID_LEN = 100
const MAX_PLAN_TYPE_LEN = 64
const MAX_EMAIL_LEN = 320
const MAX_SAVED_AT_LEN = 64
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60

/** 设备码登录的总体时限（超时 ⇒ `expired`）。 */
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000
const DEVICE_POLL_DEFAULT_MS = 5_000
const DEVICE_POLL_MIN_MS = 1_000
const DEVICE_POLL_MAX_MS = 60_000
const DEVICE_SLOW_DOWN_STEP_MS = 5_000

/** 记录 payload 的白名单字段（多余的 key 一律 `incompatible`，不透传）。 */
const REQUIRED_PAYLOAD_KEYS = Object.freeze([
  'type', 'access', 'refresh', 'expires', 'accountId', 'credentialId', 'revision', 'savedAt',
])
const OPTIONAL_PAYLOAD_KEYS = Object.freeze(['planType', 'email'])
const ALLOWED_PAYLOAD_KEYS = new Set([...REQUIRED_PAYLOAD_KEYS, ...OPTIONAL_PAYLOAD_KEYS])

/**
 * 多账户记录（v2）payload 的白名单字段。
 *
 * v2 = `{version:2, activeAccountId, accounts:[credential…]}`；v1 = payload 直接就是单个
 * credential（没有任何 version 字段）。两者的判别只靠 `version` 是否存在，不猜。
 */
const V2_ALLOWED_PAYLOAD_KEYS = new Set(['version', 'activeAccountId', 'accounts'])
const RECORD_VERSION_V1 = 1
const RECORD_VERSION_V2 = 2

/** 一条记录最多保存多少个 ChatGPT 账户（超过即 `incompatible` / 登录直接拒绝）。 */
export const MAX_CODEX_ACCOUNTS = 8

/**
 * 空态记录（tombstone）的**唯一**形状（[2026-11-25 R5]）。
 *
 * `{kind:'grant', payload:{version:2, activeAccountId:null, accounts:[]}}` —— 只有这三个
 * payload key，`activeAccountId` 必须**恰好是 `null`**，`accounts` 必须**恰好是空数组**。
 * `validateCodexAccountRecord()` 把这一精确形状判为 `{state:'absent'}`（= 未登录）。
 *
 * 工厂函数而不是共享常量：写入时需要一份新对象（避免把冻结常量交给凭据服务）。
 */
export function emptyCodexAccountRecord() {
  return { kind: 'grant', payload: { version: RECORD_VERSION_V2, activeAccountId: null, accounts: [] } }
}

/**
 * 是否是**精确**的空态 payload（只认 `{version:2, activeAccountId:null, accounts:[]}`）。
 *
 * 任何偏差（少 key / 多 key / `version` 不是 2 / `activeAccountId` 不是 `null` /
 * `accounts` 非空或不是数组）都返回 `false`，由调用方继续走常规严格校验
 * ⇒ 仍是 `incompatible`。绝不把「看起来像空」的其它形状当未登录。
 */
function isEmptyCodexAccountPayload(payload) {
  if (!isPlainObject(payload)) return false
  if (payload.version !== RECORD_VERSION_V2) return false
  const keys = Object.keys(payload)
  if (keys.length !== V2_ALLOWED_PAYLOAD_KEYS.size) return false
  for (const key of keys) {
    if (V2_ALLOWED_PAYLOAD_KEYS.has(key) !== true) return false
  }
  if (hasOwn(payload, 'activeAccountId') !== true || payload.activeAccountId !== null) return false
  if (hasOwn(payload, 'accounts') !== true) return false
  return Array.isArray(payload.accounts) && payload.accounts.length === 0
}

/** 刷新失败里「必须重新登录」的 OAuth 错误码（其余 4xx 也按 reauth 处理）。 */
const REAUTH_OAUTH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'expired_token',
  'refresh_token_expired',
])

/** 固定文案（**不含**任何上游正文）。 */
const MESSAGE_SIGNED_OUT = '请先登录 ChatGPT 账号'
const MESSAGE_INCOMPATIBLE = '本插件的 ChatGPT 登录记录不可用，请重新登录'
const MESSAGE_UNREADABLE = '无法读取本插件的 ChatGPT 登录记录'
const MESSAGE_REAUTH = 'ChatGPT 登录已过期，请重新登录'
const MESSAGE_FETCH_FAILED = 'Codex 额度获取失败'
const MESSAGE_STRUCTURE = 'Codex 额度获取失败（响应结构异常）'
const MESSAGE_REFRESH_FAILED = 'ChatGPT 登录刷新失败'
const MESSAGE_REFRESH_WRITE_FAILED = '无法写入本插件的 ChatGPT 登录记录'
const MESSAGE_DEVICE_UNSUPPORTED = '当前网络或账号不支持设备码登录'
const MESSAGE_DEVICE_START_FAILED = 'Codex 登录启动失败，请稍后重试'
const MESSAGE_DEVICE_EXPIRED = '设备码登录已超时，请重新开始'
const MESSAGE_DEVICE_DENIED = '登录请求被拒绝，请重新开始'
const MESSAGE_DEVICE_CANCELLED = '登录已取消'
const MESSAGE_EXCHANGE_FAILED = '登录兑换失败，请稍后重试'
const MESSAGE_LOGIN_INCOMPLETE = '登录回调缺少账号信息，请重新登录'
const MESSAGE_LOGIN_SAVE_FAILED = '登录信息保存失败，请重试'
/**
 * [2026-11-23 终审 B1] 账户数已满的**固定安全文案**。
 *
 * 登录状态机在 `saveCredential()` 返回 `reason:'limit'` 时显示它（而不是笼统的
 * `MESSAGE_LOGIN_SAVE_FAILED`）：`limit` 是**可操作**的事实，笼统文案会让用户以为
 * 登录失败、反复重试。文案只陈述「先移除一个」，不含内部 reason / 记录结构 / 账户内容；
 * 上限数字直接取自 `MAX_CODEX_ACCOUNTS`，与记录校验、落库共用同一个上限。
 */
export const MESSAGE_ACCOUNT_LIMIT = '最多保存 ' + MAX_CODEX_ACCOUNTS + ' 个账户，请先移除一个账户'

/** 结构错误的内部哨兵（不上抛、不外泄，只在映射函数内部流转）。 */
const STRUCTURE = Symbol('codex-account-structure')

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function depsOf(deps) {
  return isPlainObject(deps) ? deps : {}
}

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isPositiveSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** `now()` 注入（测试用）；非法返回时回落到 `Date.now()`。 */
function nowOf(deps) {
  const options = depsOf(deps)
  if (typeof options.now === 'function') {
    try {
      const value = options.now()
      if (typeof value === 'number' && Number.isFinite(value)) return value
    } catch (err) { /* 回落到系统时间 */ }
  }
  return Date.now()
}

/**
 * 读宿主凭据服务（`ctx.get('credentials')`）。
 *
 * 单一规则来源是 `codex-sources.js#readCodexCredentialsService`；`deps.credentials`
 * 只给测试注入替身，生产路径永远读 `ctx`。
 */
function credentialsOf(ctx, deps) {
  const options = depsOf(deps)
  if (options.credentials !== undefined && options.credentials !== null) {
    return describeCodexCredentialsService(options.credentials)
  }
  return readCodexCredentialsService(ctx)
}

/** 十进制金额字符串（整数/小数均可；拒绝科学计数法、拒绝非数字串）。 */
function decimalString(value) {
  if (typeof value === 'string') {
    return /^-?\d+(?:\.\d+)?$/u.test(value) ? value : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value)
    return /^-?\d+(?:\.\d+)?$/u.test(text) ? text : null
  }
  return null
}

/** 账号 ID 的**不可逆展示遮罩**（不输出明文账号）。 */
function maskAccountId(value) {
  const text = typeof value === 'string' ? value : ''
  const compact = text.replace(/[^0-9A-Za-z]/gu, '')
  if (compact.length <= 8) return '…'
  return compact.slice(0, 4) + '…' + compact.slice(-4)
}

/** 账号 ID → 8 位不可逆摘要（用于身份快照，不进日志、不进 wire）。 */
function accountHashOf(accountId) {
  return createHash('sha256').update(String(accountId), 'utf8').digest('hex').slice(0, 8)
}

// ---------------------------------------------------------------------------
// JWT（只读 payload；不校验签名 —— 这是 OAuth 自己签发的 token，仅用于取账号元数据）
// ---------------------------------------------------------------------------

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  const segment = parts[1]
  if (segment.length === 0 || segment.length > 65536) return null
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    return isPlainObject(parsed) ? parsed : null
  } catch (err) {
    return null
  }
}

/**
 * 从 access_token 取 `{accountId, planType}`；取不到返回 `null`（调用方按登录不完整处理）。
 */
function accountClaimsOf(accessToken) {
  const payload = decodeJwtPayload(accessToken)
  if (payload === null) return null
  const auth = payload[AUTH_CLAIM]
  if (!isPlainObject(auth)) return null
  const rawId = auth.chatgpt_account_id
  if (!isNonEmptyString(rawId, MAX_ACCOUNT_ID_LEN)) return null
  const accountId = rawId.trim()
  if (accountId.length === 0) return null
  const rawPlan = auth.chatgpt_plan_type
  const planType = isNonEmptyString(rawPlan, MAX_PLAN_TYPE_LEN) && rawPlan.trim().length > 0
    ? rawPlan.trim().slice(0, MAX_PLAN_TYPE_LEN)
    : undefined
  return { accountId, planType }
}

/** 从 id_token 取 email（**仅展示**；任何失败都返回 undefined，不影响登录）。 */
function emailOf(idToken) {
  const payload = decodeJwtPayload(idToken)
  if (payload === null) return undefined
  const raw = payload.email
  if (!isNonEmptyString(raw, MAX_EMAIL_LEN)) return undefined
  const email = raw.trim()
  if (!email.includes('@')) return undefined
  return email
}

// ---------------------------------------------------------------------------
// 私有凭据记录：严格校验 + 读取
// ---------------------------------------------------------------------------

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * 单个 credential 的严格校验（v1 payload 与 v2 的每个 `accounts` 元素**共用同一套规则**）。
 *
 * @returns {{ok:true, credential:object}|{ok:false, reason:string}}
 *   reason ∈ `shape` / `field` / `type` / `access` / `refresh` / `expires` / `account-id` /
 *   `credential-id` / `revision` / `saved-at` / `plan-type` / `email`。
 */
function credentialShapeOf(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'shape' }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) return { ok: false, reason: 'field' }
  }
  if (raw.type !== 'oauth') return { ok: false, reason: 'type' }
  if (!isNonEmptyString(raw.access, MAX_TOKEN_LEN)) return { ok: false, reason: 'access' }
  if (!isNonEmptyString(raw.refresh, MAX_TOKEN_LEN)) return { ok: false, reason: 'refresh' }
  if (!isPositiveSafeInt(raw.expires)) return { ok: false, reason: 'expires' }
  if (!isNonEmptyString(raw.accountId, MAX_ACCOUNT_ID_LEN)) return { ok: false, reason: 'account-id' }
  if (!isNonEmptyString(raw.credentialId, MAX_CREDENTIAL_ID_LEN)) {
    return { ok: false, reason: 'credential-id' }
  }
  if (!isPositiveSafeInt(raw.revision)) return { ok: false, reason: 'revision' }
  if (!isNonEmptyString(raw.savedAt, MAX_SAVED_AT_LEN)) return { ok: false, reason: 'saved-at' }
  const credential = {
    type: 'oauth',
    access: raw.access,
    refresh: raw.refresh,
    expires: raw.expires,
    accountId: raw.accountId,
    credentialId: raw.credentialId,
    revision: raw.revision,
    savedAt: raw.savedAt,
  }
  if (hasOwn(raw, 'planType')) {
    if (!isNonEmptyString(raw.planType, MAX_PLAN_TYPE_LEN)) return { ok: false, reason: 'plan-type' }
    credential.planType = raw.planType
  }
  if (hasOwn(raw, 'email')) {
    if (!isNonEmptyString(raw.email, MAX_EMAIL_LEN)) return { ok: false, reason: 'email' }
    credential.email = raw.email
  }
  return { ok: true, credential }
}

/** v1 payload 的错误 reason 与历史取值逐字一致（外部/测试按字符串判断，不要改名）。 */
const V1_REASON_BY_FIELD = Object.freeze({
  shape: 'payload-shape',
  field: 'payload-field',
  type: 'payload-type',
})

/**
 * 严格校验一条 Codex 凭据记录（v1 单账户 / v2 多账户共用）。
 *
 * 规则（全部是「不合格即 incompatible」，不做任何修补）：
 *   - `record` 缺失（`undefined`/`null`）⇒ `absent`；
 *   - **空态记录**（[2026-11-25 R5] `{kind:'grant', payload:{version:2, activeAccountId:null,
 *     accounts:[]}}` 的**精确**形状）⇒ `absent`（= 未登录）。多一个 key、`activeAccountId`
 *     不是 `null`、`accounts` 非空等任何偏差都不算空态，落回下面的严格校验；
 *   - 非对象 / `kind !== 'grant'` / `payload` 非对象 ⇒ `incompatible`；
 *   - payload 有 `version` ⇒ **v2**：`version === 2`、payload 只能有
 *     `version` / `activeAccountId` / `accounts` 三个 key、`accounts` 是 1..8 个 credential、
 *     每个 credential 严格校验、`credentialId` 与 `accountId` 各自唯一、
 *     `activeAccountId` 必须命中某个 `credentialId`（否则一律 `incompatible`）；
 *   - payload 没有 `version` ⇒ **v1**（旧记录）：payload 就是单个 credential，
 *     白名单与字段规则同 v1 历史口径（多余 key ⇒ `incompatible`）。
 *
 * @returns {{state:'ok', version:number, accounts:object[], activeAccountId:string, credential:object}
 *   |{state:'absent'}
 *   |{state:'incompatible', reason:string}}
 *   `credential` 恒为 **active** 账户（v1 时就是那唯一一项）。
 */
export function validateCodexAccountRecord(record) {
  if (record === undefined || record === null) return { state: 'absent' }
  if (!isPlainObject(record)) return { state: 'incompatible', reason: 'record-shape' }
  if (record.kind !== 'grant') return { state: 'incompatible', reason: 'record-kind' }
  const payload = record.payload
  if (!isPlainObject(payload)) return { state: 'incompatible', reason: 'payload-shape' }
  if (hasOwn(payload, 'version')) {
    if (payload.version !== RECORD_VERSION_V2) return { state: 'incompatible', reason: 'payload-version' }
    /**
     * [2026-11-25 R5] 空态记录（tombstone）= `{version:2, activeAccountId:null, accounts:[]}`：
     * **精确**匹配才算 `absent`（未登录），因此移除最后一个账户不需要删记录。
     * 其它任何「空账户」形状都不在这里放行，继续走下面的严格校验。
     */
    if (isEmptyCodexAccountPayload(payload) === true) return { state: 'absent' }
    for (const key of Object.keys(payload)) {
      if (!V2_ALLOWED_PAYLOAD_KEYS.has(key)) return { state: 'incompatible', reason: 'payload-field' }
    }
    const rawAccounts = payload.accounts
    if (!Array.isArray(rawAccounts)) return { state: 'incompatible', reason: 'accounts-shape' }
    if (rawAccounts.length < 1 || rawAccounts.length > MAX_CODEX_ACCOUNTS) {
      return { state: 'incompatible', reason: 'accounts-count' }
    }
    const accounts = []
    const credentialIds = new Set()
    const accountIds = new Set()
    for (const raw of rawAccounts) {
      const checked = credentialShapeOf(raw)
      if (checked.ok !== true) return { state: 'incompatible', reason: 'account-' + checked.reason }
      const credential = checked.credential
      if (credentialIds.has(credential.credentialId)) {
        return { state: 'incompatible', reason: 'duplicate-credential-id' }
      }
      if (accountIds.has(credential.accountId)) {
        return { state: 'incompatible', reason: 'duplicate-account-id' }
      }
      credentialIds.add(credential.credentialId)
      accountIds.add(credential.accountId)
      accounts.push(credential)
    }
    if (!isNonEmptyString(payload.activeAccountId, MAX_CREDENTIAL_ID_LEN)) {
      return { state: 'incompatible', reason: 'active-account-id' }
    }
    const active = accounts.find((item) => item.credentialId === payload.activeAccountId)
    if (active === undefined) return { state: 'incompatible', reason: 'active-account-missing' }
    return {
      state: 'ok',
      version: RECORD_VERSION_V2,
      accounts,
      activeAccountId: active.credentialId,
      credential: active,
    }
  }
  // ── v1（旧记录）：payload 就是单个 credential ─────────────────────────────
  const checked = credentialShapeOf(payload)
  if (checked.ok !== true) {
    return { state: 'incompatible', reason: V1_REASON_BY_FIELD[checked.reason] || checked.reason }
  }
  const credential = checked.credential
  return {
    state: 'ok',
    version: RECORD_VERSION_V1,
    accounts: [credential],
    activeAccountId: credential.credentialId,
    credential,
  }
}

/**
 * 读本插件私有凭据记录（v1 在内存中等价于单账户 v2，**不写盘**）。
 *
 * @returns {Promise<
 *   {state:'ok', version:number, accounts:object[], activeAccountId:string, credential:object}
 *   |{state:'absent'}
 *   |{state:'unknown', reason:string}
 *   |{state:'incompatible', reason:string}>}
 *   - `absent`：宿主凭据可用、但没有本插件的记录（= 未登录）；
 *   - `unknown`：**无法证明**（没有凭据服务 / 读取抛错）—— 调用方不得当成「未登录」；
 *   - `incompatible`：记录在，但不符合本合同（必须重新登录）。
 */
export async function readCodexAccountRecord(ctx, deps) {
  const credentials = credentialsOf(ctx, deps)
  if (credentials.state === 'unknown') return { state: 'unknown', reason: 'credentials-unclear' }
  if (credentials.state === 'absent' || credentials.state === 'incompatible') {
    return { state: 'unknown', reason: 'credentials-unavailable' }
  }
  let raw
  try {
    raw = await credentials.service.readRecord(CODEX_ACCOUNT_RECORD_KEY)
  } catch (err) {
    return { state: 'unknown', reason: 'read-failed' }
  }
  return validateCodexAccountRecord(raw)
}

// ---------------------------------------------------------------------------
// 身份快照（同步读，供 index.js 拼进观察身份；不含明文账号 / token）
// ---------------------------------------------------------------------------

/** 模块级同步快照：`acct:<8位hash>@<credentialId前8位>r<revision>` / `none` / `unknown`。 */
let identitySnapshot = 'unknown'

/**
 * 快照编码：`acct:<accountId 的 8 位 sha256>@<credentialId 前 8 位>r<revision>`。
 *
 * revision 进快照是刻意的：同一 credentialId 上「重新登录」（revision 前进）或「换账户」
 * 都会让快照变化 → 旧观察作废；而 **token 刷新不改 revision**，所以刷新不会误动作废。
 */
function identityOf(credential) {
  const hash = accountHashOf(credential.accountId)
  const idPart = String(credential.credentialId).slice(0, 8)
  return 'acct:' + hash + '@' + idPart + 'r' + String(credential.revision)
}

function setIdentityFrom(credential) {
  identitySnapshot = identityOf(credential)
  return identitySnapshot
}

/** 当前身份快照（**同步、无 I/O**）：`acct:…` / `none` / `unknown`。 */
export function codexAccountIdentitySnapshot() {
  return identitySnapshot
}

/**
 * 读一次记录并刷新同步快照。
 *
 * 映射：`ok` → `acct:…`；`absent` → `none`；`unknown` / `incompatible` → `unknown`
 * （「坏记录」与「读不到」都不算登录态，但也不能说成「未登录」）。
 */
export async function refreshCodexAccountIdentity(ctx, deps) {
  let seen
  try {
    seen = await readCodexAccountRecord(ctx, deps)
  } catch (err) {
    identitySnapshot = 'unknown'
    return identitySnapshot
  }
  if (seen.state === 'ok') return setIdentityFrom(seen.credential)
  identitySnapshot = seen.state === 'absent' ? 'none' : 'unknown'
  return identitySnapshot
}

// ---------------------------------------------------------------------------
// HTTP 基础（固定方法 + 不跟随重定向 + 超时 + 响应体上限）
// ---------------------------------------------------------------------------

/**
 * 发一次请求。**不跟随重定向**（3xx 原样交给调用方），**15 秒**超时，
 * 响应体 ≤ 512 KiB，返回文本交给调用方解析。
 *
 * @returns {Promise<
 *   {kind:'response', status:number, text:string}
 *   |{kind:'network'}|{kind:'timeout'}|{kind:'aborted'}
 *   |{kind:'too-large'}|{kind:'read-error'}>}
 */
async function httpRequest(request, deps) {
  const options = depsOf(deps)
  const fetchFn = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  if (typeof fetchFn !== 'function') return { kind: 'network' }
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : globalThis.setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : globalThis.clearTimeout
  const AbortCtor = globalThis.AbortController
  const controller = typeof AbortCtor === 'function' ? new AbortCtor() : null
  const external = request.signal
  if (controller !== null && external !== undefined && external !== null && external.aborted === true) {
    return { kind: 'aborted' }
  }
  let timedOut = false
  let onAbort = null
  if (controller !== null && external !== undefined && external !== null
    && typeof external.addEventListener === 'function') {
    // 外部取消只负责转成 abort；**不**改动 timedOut（否则同时超时+外部取消会被误判成网络错误）。
    onAbort = () => { try { controller.abort() } catch (err) { /* ignore */ } }
    try { external.addEventListener('abort', onAbort) } catch (err) { onAbort = null }
  }
  let timer
  if (controller !== null && typeof setTimer === 'function') {
    timer = setTimer(() => {
      timedOut = true
      try { controller.abort() } catch (err) { /* ignore */ }
    }, REQUEST_TIMEOUT_MS)
  }
  try {
    const init = {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
    }
    if (request.body !== undefined) init.body = request.body
    if (controller !== null) init.signal = controller.signal
    let response
    try {
      response = await fetchFn(request.url, init)
    } catch (err) {
      if (timedOut === true) return { kind: 'timeout' }
      if (external !== undefined && external !== null && external.aborted === true) return { kind: 'aborted' }
      return { kind: 'network' }
    }
    if (response === null || typeof response !== 'object') return { kind: 'network' }
    if (typeof response.status !== 'number' || !Number.isFinite(response.status)) return { kind: 'network' }
    const body = await readBody(response)
    if (body.kind !== 'text') return body
    return { kind: 'response', status: response.status, text: body.text }
  } finally {
    if (timer !== undefined && typeof clearTimer === 'function') {
      try { clearTimer(timer) } catch (err) { /* ignore */ }
    }
    if (onAbort !== null && external !== undefined && external !== null
      && typeof external.removeEventListener === 'function') {
      try { external.removeEventListener('abort', onAbort) } catch (err) { /* ignore */ }
    }
  }
}

/** 读响应体：优先流式（逐块计数，超限立即取消），退化到 `text()` 后按字节数校验。 */
async function readBody(response) {
  const body = response.body
  if (body !== null && body !== undefined && typeof body.getReader === 'function'
    && typeof TextDecoder === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')
    let bytes = 0
    let text = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk === null || chunk === undefined || chunk.done === true) break
        const value = chunk.value
        if (value === undefined || value === null) continue
        const size = typeof value.byteLength === 'number' ? value.byteLength : value.length
        bytes += typeof size === 'number' ? size : 0
        if (bytes > MAX_BODY_BYTES) {
          try { await reader.cancel() } catch (err) { /* ignore */ }
          return { kind: 'too-large' }
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      return { kind: 'text', text }
    } catch (err) {
      return { kind: 'read-error' }
    }
  }
  if (typeof response.text === 'function') {
    let text
    try {
      text = await response.text()
    } catch (err) {
      return { kind: 'read-error' }
    }
    if (typeof text !== 'string') return { kind: 'read-error' }
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { kind: 'too-large' }
    return { kind: 'text', text }
  }
  return { kind: 'read-error' }
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return null
  }
  return isPlainObject(parsed) ? parsed : null
}

/** 状态码分类（唯一判定处，避免各分支各写一套）。 */
function statusClassOf(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status >= 300 && status < 400) return 'redirect'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 408 || status === 429) return 'transient'
  if (status >= 500) return 'transient'
  return 'fatal'
}

const TRANSIENT_FAILURE = Object.freeze({
  ok: false,
  error: 'exec',
  message: MESSAGE_FETCH_FAILED,
  transient: true,
  reason: 'network',
})

function transientFailureOf(reason) {
  return Object.assign({}, TRANSIENT_FAILURE, { reason })
}

const REAUTH_FAILURE = Object.freeze({
  ok: false,
  error: 'reauth-required',
  message: MESSAGE_REAUTH,
  reason: 'reauth',
})

function reauthFailure() {
  return Object.assign({}, REAUTH_FAILURE)
}

/** OAuth 错误响应里的 `error` 码（只用于映射，不输出正文）。 */
function oauthErrorCodeOf(text) {
  const body = parseJsonObject(text)
  if (body === null) return ''
  const raw = body.error
  if (typeof raw === 'string') return raw
  if (isPlainObject(raw) && typeof raw.code === 'string') return raw.code
  return ''
}

function formBody(fields) {
  const params = new URLSearchParams()
  for (const [key, value] of fields) params.set(key, value)
  return { text: params.toString(), contentType: 'application/x-www-form-urlencoded' }
}

// ---------------------------------------------------------------------------
// 设备码登录（协议 ①–④）
// ---------------------------------------------------------------------------

/** 设备码开始的失败分类：`unsupported`（404/405/410/501 或 4xx）/ `transient`（网络、429、5xx）。 */
function deviceStartFailureOf(result) {
  if (result.kind === 'response') {
    const status = result.status
    if (status >= 200 && status < 300) return null
    if (status === 408 || status === 429 || status >= 500) return 'transient'
    if (status >= 400) return 'unsupported'
    return 'transient'
  }
  return 'transient'
}

/**
 * ① 申请设备码。
 *
 * @returns {Promise<
 *   {kind:'ok', deviceAuthId:string, userCode:string, intervalMs:number}
 *   |{kind:'unsupported'}|{kind:'transient'}|{kind:'aborted'}>}
 */
async function requestDeviceCode(deps) {
  const result = await httpRequest({
    url: DEVICE_CODE_URL,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: CODEX_ACCOUNT_CLIENT_ID }),
    signal: depsOf(deps).signal,
  }, deps)
  if (result.kind === 'aborted') return { kind: 'aborted' }
  const failure = deviceStartFailureOf(result)
  if (failure === 'unsupported') return { kind: 'unsupported' }
  if (failure === 'transient') return { kind: 'transient' }
  const body = parseJsonObject(result.text)
  if (body === null) return { kind: 'unsupported' }
  const deviceAuthId = body.device_auth_id
  const userCode = body.user_code
  if (!isNonEmptyString(deviceAuthId, 512) || !isNonEmptyString(userCode, 64)) {
    return { kind: 'unsupported' }
  }
  // interval 可能是字符串（上游实际如此），非法值回落到默认轮询间隔。
  const rawInterval = body.interval
  const numeric = typeof rawInterval === 'number'
    ? rawInterval
    : (typeof rawInterval === 'string' && /^\d+$/u.test(rawInterval.trim()) ? Number(rawInterval.trim()) : NaN)
  const seconds = Number.isFinite(numeric) && numeric > 0 ? numeric : DEVICE_POLL_DEFAULT_MS / 1000
  const intervalMs = Math.min(Math.max(seconds * 1000, DEVICE_POLL_MIN_MS), DEVICE_POLL_MAX_MS)
  return { kind: 'ok', deviceAuthId, userCode, intervalMs }
}

/**
 * ② 轮询设备码。
 *
 * @returns {Promise<
 *   {kind:'success', code:string, verifier:string}
 *   |{kind:'pending'}|{kind:'slow_down'}|{kind:'retry'}
 *   |{kind:'expired'}|{kind:'denied'}|{kind:'aborted'}>}
 */
async function pollDeviceToken(deviceAuthId, userCode, deps) {
  const result = await httpRequest({
    url: DEVICE_TOKEN_URL,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: depsOf(deps).signal,
  }, deps)
  if (result.kind === 'aborted') return { kind: 'aborted' }
  if (result.kind !== 'response') return { kind: 'retry' }
  const status = result.status
  const body = parseJsonObject(result.text)
  const code = body !== null ? oauthErrorCodeOf(result.text) : ''
  if (status >= 200 && status < 300) {
    if (body === null) return { kind: 'retry' }
    const authorizationCode = body.authorization_code
    const verifier = body.code_verifier
    if (!isNonEmptyString(authorizationCode, MAX_TOKEN_LEN) || !isNonEmptyString(verifier, MAX_TOKEN_LEN)) {
      return { kind: 'denied' }
    }
    return { kind: 'success', code: authorizationCode, verifier }
  }
  // 403/404 是文档化的「还没授权」；错误码也要认。
  if (status === 403 || status === 404) {
    if (code === 'slow_down') return { kind: 'slow_down' }
    if (code === 'deviceauth_expired' || code === 'expired_token') return { kind: 'expired' }
    return { kind: 'pending' }
  }
  if (code === 'deviceauth_authorization_pending') return { kind: 'pending' }
  if (code === 'slow_down') return { kind: 'slow_down' }
  if (code === 'deviceauth_expired' || code === 'expired_token' || code === 'deviceauth_not_found') {
    return { kind: 'expired' }
  }
  if (status === 408 || status === 429 || status >= 500) return { kind: 'retry' }
  return { kind: 'denied' }
}

/**
 * ③ 兑换 authorization_code。
 *
 * @returns {Promise<
 *   {kind:'ok', access:string, refresh:string, expires:number, idToken:(string|null)}
 *   |{kind:'reauth'}|{kind:'transient'}|{kind:'structure'}|{kind:'aborted'}>}
 */
async function exchangeAuthorizationCode(authorizationCode, verifier, deps) {
  const form = formBody([
    ['grant_type', 'authorization_code'],
    ['client_id', CODEX_ACCOUNT_CLIENT_ID],
    ['code', authorizationCode],
    ['code_verifier', verifier],
    ['redirect_uri', CODEX_ACCOUNT_REDIRECT_URI],
  ])
  const result = await httpRequest({
    url: TOKEN_URL,
    method: 'POST',
    headers: { 'content-type': form.contentType, accept: 'application/json' },
    body: form.text,
    signal: depsOf(deps).signal,
  }, deps)
  if (result.kind === 'aborted') return { kind: 'aborted' }
  if (result.kind !== 'response') return { kind: 'transient' }
  const cls = statusClassOf(result.status)
  if (cls === 'unauthorized' || cls === 'fatal') return { kind: 'reauth' }
  if (cls !== 'ok') return { kind: 'transient' }
  const tokens = tokenFieldsOf(parseJsonObject(result.text), nowOf(deps))
  if (tokens === null) return { kind: 'structure' }
  return { kind: 'ok', access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, idToken: tokens.idToken }
}

/** ④ access_token / refresh_token / expires_in → 规整后的 token 字段（不做任何猜测）。 */
function tokenFieldsOf(body, nowMs) {
  if (!isPlainObject(body)) return null
  const access = body.access_token
  const refresh = body.refresh_token
  if (!isNonEmptyString(access, MAX_TOKEN_LEN) || !isNonEmptyString(refresh, MAX_TOKEN_LEN)) return null
  const rawExpires = body.expires_in
  const expiresIn = typeof rawExpires === 'number'
    ? rawExpires
    : (typeof rawExpires === 'string' && /^\d+$/u.test(rawExpires.trim()) ? Number(rawExpires.trim()) : NaN)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN_SECONDS) return null
  const expires = nowMs + Math.floor(expiresIn * 1000)
  if (!Number.isSafeInteger(expires) || expires <= nowMs) return null
  const idToken = typeof body.id_token === 'string' && body.id_token.length <= MAX_TOKEN_LEN
    ? body.id_token
    : null
  return { access, refresh, expires, idToken }
}

// ---------------------------------------------------------------------------
// 刷新（single-flight + modifyRecord 独占写内二次检查）
// ---------------------------------------------------------------------------

/** 在途刷新的 single-flight 表（key = 记录 key + credentialId）。 */
const refreshFlights = new Map()

function refreshKeyOf(credential) {
  return CODEX_ACCOUNT_RECORD_KEY + '|' + String(credential.credentialId)
}

/** 是否**确实**已过期（毫秒时间戳；这是「该不该刷新」和「mutate 里该不该写」的唯一判据）。 */
function credentialExpired(credential, nowMs) {
  return !(credential.expires > nowMs)
}

/**
 * 单个账户 → v2 payload 里的 credential 对象（**白名单重建**，不透传任意字段）。
 *
 * `overrides` 只允许覆盖 token 三件套与 `savedAt`（刷新/重登录时唯一的可变字段）；
 * `accountId` / `credentialId` / `revision` / `planType` / `email` 一律取自原账户。
 */
function payloadAccountOf(credential, overrides) {
  const patch = isPlainObject(overrides) ? overrides : {}
  const payload = {
    type: 'oauth',
    access: patch.access !== undefined ? patch.access : credential.access,
    refresh: patch.refresh !== undefined ? patch.refresh : credential.refresh,
    expires: patch.expires !== undefined ? patch.expires : credential.expires,
    accountId: credential.accountId,
    credentialId: credential.credentialId,
    revision: credential.revision,
    savedAt: patch.savedAt !== undefined ? patch.savedAt : credential.savedAt,
  }
  if (credential.planType !== undefined) payload.planType = credential.planType
  if (credential.email !== undefined) payload.email = credential.email
  return payload
}

/**
 * `accounts` + `activeAccountId` → **写盘用**的 v2 记录（还没落盘，先自己校验一遍）。
 *
 * @returns {{record:object, parsed:object}|null} `parsed` 是 `validateCodexAccountRecord` 的
 *   `ok` 结果（含规范化后的 accounts / active credential）；校验不过返回 `null`（调用方不写）。
 */
function v2RecordOf(accounts, activeAccountId) {
  const payload = {
    version: RECORD_VERSION_V2,
    activeAccountId,
    accounts: accounts.map((credential) => payloadAccountOf(credential)),
  }
  const checked = validateCodexAccountRecord({ kind: 'grant', payload })
  if (checked.state !== 'ok') return null
  return { record: { kind: 'grant', payload }, parsed: checked }
}

/**
 * 刷新**一个账户**的 token（普通路径调用方已确认「已过期」，或 401 分支显式 `force`）。
 *
 * 账户定位只按 `credential.credentialId` 在 v2 的 `accounts` 数组里找（不是「记录里唯一那个」）：
 * 找不到 ⇒ 不写、也不新建账户，由调用方重读后给出 `reauth-required`。
 *
 * 成功的定义：**要么**自己在 `modifyRecord` 的独占时刻写入了新 token，
 * **要么**发现这个账户已经被别人刷新（同一 credentialId、token 已换），于是采用当前记录。
 *
 * `force:true` = 「额度接口刚用这个 access 收到 401/403」的强制刷新：
 * 即使本地 `expires` 还没到也真的去换一次（否则「未过期但被上游吊销」的 token 永远刷不动）。
 * 仍然在独占写内复核：只有该账户仍是同一个 `credentialId`、且**我们用过的那个 access
 * 没被别人换掉**才写；`credentialId` / `accountId` / `revision` / 其它账户 / active 一律不变。
 */
async function runRefresh(ctx, credential, deps, options) {
  const opts = isPlainObject(options) ? options : {}
  const force = opts.force === true
  const now = nowOf(deps)
  if (force !== true && !credentialExpired(credential, now)) {
    return { ok: true, credential, refreshed: false }
  }
  const form = formBody([
    ['grant_type', 'refresh_token'],
    ['refresh_token', credential.refresh],
    ['client_id', CODEX_ACCOUNT_CLIENT_ID],
  ])
  const result = await httpRequest({
    url: TOKEN_URL,
    method: 'POST',
    headers: { 'content-type': form.contentType, accept: 'application/json' },
    body: form.text,
    signal: depsOf(deps).signal,
  }, deps)
  if (result.kind === 'aborted') return transientFailureOf('aborted')
  if (result.kind !== 'response') return transientFailureOf(result.kind)
  const cls = statusClassOf(result.status)
  if (cls === 'transient') return transientFailureOf('refresh-transient')
  if (cls !== 'ok') {
    /**
     * 5xx / 429 / 408 上面已按**暂时失败**处理；其余（4xx 与 3xx）都意味着当前
     * `refresh_token` 不再被接受 ⇒ 必须重新登录。
     *
     * 上游给的 `error` 码（`invalid_grant` / `invalid_refresh_token` / `token_expired` …）
     * **只参与判定**（决定 reason 标签），绝不外泄正文。
     */
    const code = oauthErrorCodeOf(result.text)
    const known = REAUTH_OAUTH_CODES.has(code) || cls === 'unauthorized'
    return Object.assign(reauthFailure(), { reason: known ? 'reauth' : 'refresh-rejected' })
  }
  const tokens = tokenFieldsOf(parseJsonObject(result.text), now)
  if (tokens === null) {
    return { ok: false, error: 'exec', message: MESSAGE_REFRESH_FAILED, reason: 'structure' }
  }
  const credentials = credentialsOf(ctx, deps)
  if (credentials.state !== 'ok') {
    return { ok: false, error: 'exec', message: MESSAGE_REFRESH_WRITE_FAILED, reason: 'credentials-unavailable' }
  }
  const savedAt = new Date(now).toISOString()
  let committed = null
  let activeAfterRefresh = null
  try {
    await credentials.service.modifyRecord(CODEX_ACCOUNT_RECORD_KEY, async (current) => {
      const seen = validateCodexAccountRecord(current)
      // 记录已被删 / 变坏：不写（调用方会重新读记录并给出明确结论）。
      if (seen.state !== 'ok') return undefined
      // 按 credentialId 在 accounts 里找「我们刚用过的那个账户」。
      const index = seen.accounts.findIndex((item) => item.credentialId === credential.credentialId)
      // 账户被移除 / 换了 id：绝不新建账户（调用方按 reauth-required 处理）。
      if (index < 0) return undefined
      const existing = seen.accounts[index]
      if (force === true) {
        /**
         * 强制刷新（401 分支）：不看过期时间，只看「别人有没有把我们刚用过的那个 access 换掉」。
         * 换过 ⇒ 别人已经处理过这次失效，采用别人的（返回 undefined，由下面重读拿到）。
         */
        if (existing.access !== credential.access) return undefined
      } else if (!credentialExpired(existing, now)) {
        // 普通路径：别人已经刷新过（当前记录还没过期）：保持别人的结果。
        return undefined
      }
      /**
       * 只换**这个账户**的 token 三件套与 `savedAt`；`accountId` / `credentialId` /
       * `revision` / `planType` / `email` 原样保留，`activeAccountId` 不动，
       * 其它账户完全不受影响。
       */
      const updated = Object.assign({}, existing, {
        access: tokens.access,
        refresh: tokens.refresh,
        expires: tokens.expires,
        savedAt,
      })
      const accounts = seen.accounts.slice()
      accounts[index] = updated
      const built = v2RecordOf(accounts, seen.activeAccountId)
      if (built === null) return undefined
      committed = built.parsed.accounts.find((item) => item.credentialId === updated.credentialId)
        || updated
      // 身份快照永远按 **active** 账户算（刷新不改 revision，所以一般与刷新前一致）。
      activeAfterRefresh = built.parsed.credential
      return built.record
    })
  } catch (err) {
    return { ok: false, error: 'exec', message: MESSAGE_REFRESH_FAILED, transient: true, reason: 'write-failed' }
  }
  if (committed !== null) {
    if (activeAfterRefresh !== null) setIdentityFrom(activeAfterRefresh)
    return { ok: true, credential: committed, refreshed: true }
  }
  // 没写进去：重新读，把「别人刷新的」或「记录/账户消失」如实反映出去。
  const after = await readCodexAccountRecord(ctx, deps)
  if (after.state === 'ok') {
    setIdentityFrom(after.credential)
    const target = after.accounts.find((item) => item.credentialId === credential.credentialId)
    /**
     * 同一 credentialId 仍在 ⇒ 用它的**当前** token（别人可能刚刷新过）。
     * 不在 ⇒ 账户已被移除/换成新 id：不再新建账户，要求重新登录。
     */
    if (target === undefined) return reauthFailure()
    return { ok: true, credential: target, refreshed: false }
  }
  if (after.state === 'absent') {
    identitySnapshot = 'none'
    return { ok: false, error: 'signed-out', message: MESSAGE_SIGNED_OUT, reason: 'signed-out' }
  }
  if (after.state === 'incompatible') {
    identitySnapshot = 'unknown'
    return { ok: false, error: 'incompatible', message: MESSAGE_INCOMPATIBLE, reason: 'incompatible' }
  }
  return { ok: false, error: 'exec', message: MESSAGE_UNREADABLE, reason: 'unavailable' }
}

/**
 * single-flight 包装：同一 `credentialId` 的并发刷新只打一次 token 端点。
 *
 * `options.force` 语义见 `runRefresh`。强制与普通刷新共用同一条在途请求：
 * 两者都是「要一份新 token」，谁先到谁的结果对另一方都成立。
 */
function refreshCredentialRecord(ctx, credential, deps, options) {
  const key = refreshKeyOf(credential)
  const existing = refreshFlights.get(key)
  if (existing !== undefined) return existing
  const flight = (async () => {
    try {
      return await runRefresh(ctx, credential, deps, options)
    } catch (err) {
      return transientFailureOf('refresh-crashed')
    } finally {
      refreshFlights.delete(key)
    }
  })()
  refreshFlights.set(key, flight)
  return flight
}

// ---------------------------------------------------------------------------
// 额度映射（上游 wham/usage → Connect 形状）
// ---------------------------------------------------------------------------

/**
 * 单个窗口：**只按 `limit_window_seconds` 识别**，不按 primary/secondary 的位置猜。
 *
 * 状态：`null` = 桶缺失（没有这个窗口）；`STRUCTURE` = 结构错误（字段缺失/越界）。
 */
function windowFrom(raw, nowSeconds) {
  if (raw === null || raw === undefined) return null
  if (!isPlainObject(raw)) return STRUCTURE
  const seconds = raw.limit_window_seconds
  if (!isPositiveSafeInt(seconds)) return STRUCTURE
  const used = raw.used_percent
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return STRUCTURE
  const remainingPercent = Math.round((100 - used) * 10) / 10
  let resetAt = null
  const rawResetAt = raw.reset_at
  if (typeof rawResetAt === 'number' && Number.isFinite(rawResetAt) && rawResetAt > 0) {
    const secondsValue = Math.floor(rawResetAt)
    if (Number.isSafeInteger(secondsValue) && secondsValue > 0) resetAt = secondsValue
  }
  if (resetAt === null) {
    const rawAfter = raw.reset_after_seconds
    if (typeof rawAfter === 'number' && Number.isFinite(rawAfter) && rawAfter >= 0) {
      const secondsValue = Math.floor(nowSeconds + rawAfter)
      if (Number.isSafeInteger(secondsValue) && secondsValue > 0) resetAt = secondsValue
    }
  }
  return { windowSeconds: seconds, remainingPercent, resetAt }
}

function percentOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null
  return Math.round(value * 10) / 10
}

/**
 * `wham/usage` 响应 → Connect 形状的 usage 投影（`plans/codex.js` 的 `normalizeCodexUsage` 消费）。
 *
 * 规则：
 *   - **只取主桶**（`rate_limit`），窗口按 `limit_window_seconds` 认 5h(18000) / 周(604800)；
 *     其它秒数忽略（不猜、不塞进 5h/周），出现同秒数的重复窗口时保留第一个；
 *   - `rate_limit` 为 `null`/缺失 ⇒ **没有窗口**（Pro 账号可能没有 5 小时限流窗口，
 *     上游会直接给 `null`）。这不是结构错误：credits / spend control / plan_type 照常解析，
 *     是否「整份无额度」由 `plans/codex.js#normalizeCodexUsage` 判 `quota-unavailable`；
 *     只有「非 null 且不是对象」（字符串/数组/数字）才算结构错误；
 *   - `remainingPercent = 100 - used_percent`（`used_percent` 越界/非有限数 ⇒ 结构错误）；
 *   - `reset_at` 是 Unix **秒**；缺失时用 `reset_after_seconds + now` 换算；
 *   - `credits.has_credits !== true` ⇒ **不产出** credits；
 *   - `spend_control.individual_limit` 的 limit/used/remaining_percent 必须齐全；
 *     `remaining` 精确金额**上游有就带走**（十进制字符串），没有就省略 ——
 *     绝不根据 `remaining_percent` 反推金额。
 *
 * @returns {{ok:true, usage:object}|{ok:false, reason:'structure'}}
 */
export function mapCodexAccountUsage(payload, nowMs) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'structure' }
  const rateLimit = payload.rate_limit
  if (rateLimit !== null && rateLimit !== undefined && !isPlainObject(rateLimit)) {
    return { ok: false, reason: 'structure' }
  }
  const nowSeconds = Math.floor(nowMs / 1000)
  const windows = []
  const seen = new Set()
  const buckets = isPlainObject(rateLimit) ? [rateLimit.primary_window, rateLimit.secondary_window] : []
  for (const raw of buckets) {
    const mapped = windowFrom(raw, nowSeconds)
    if (mapped === STRUCTURE) return { ok: false, reason: 'structure' }
    if (mapped === null) continue
    if (mapped.windowSeconds !== FIVE_HOURS_SECONDS && mapped.windowSeconds !== WEEK_SECONDS) continue
    if (seen.has(mapped.windowSeconds)) continue
    seen.add(mapped.windowSeconds)
    windows.push(mapped)
  }
  let credits = null
  const rawCredits = payload.credits
  if (isPlainObject(rawCredits) && rawCredits.has_credits === true) {
    credits = { unlimited: rawCredits.unlimited === true }
    const balance = decimalString(rawCredits.balance)
    if (balance !== null) credits.balance = balance
  }
  let individualLimit = null
  const spend = payload.spend_control
  if (isPlainObject(spend) && spend.individual_limit !== null && spend.individual_limit !== undefined) {
    const raw = spend.individual_limit
    if (!isPlainObject(raw)) return { ok: false, reason: 'structure' }
    const limit = decimalString(raw.limit)
    const used = decimalString(raw.used)
    const remainingPercent = percentOf(raw.remaining_percent)
    if (limit === null || used === null || remainingPercent === null) return { ok: false, reason: 'structure' }
    /**
     * [2026-11-22 终审 F1] 上游**确实**带 `remaining` 精确金额
     * （本地参考 `reference/dsh-codex-connect/src/usage.ts` 的 `spend_control.individual_limit`）。
     * 有就原样带走（十进制字符串，不折算浮点）；缺失或不是十进制串时**省略该字段** ——
     * 绝不凭 `remaining_percent` 反推金额（那是两回事，round 一下就会对不上账单）。
     */
    const remaining = decimalString(raw.remaining)
    individualLimit = remaining === null
      ? { limit, used, remainingPercent }
      : { limit, used, remaining, remainingPercent }
  }
  const usage = { rateLimits: [{ id: 'codex', windows }], fetchedAt: nowMs }
  if (credits !== null) usage.credits = credits
  if (individualLimit !== null) usage.individualLimit = individualLimit
  if (typeof payload.plan_type === 'string' && payload.plan_type.trim().length > 0) {
    usage.planType = payload.plan_type.trim().slice(0, MAX_PLAN_TYPE_LEN)
  }
  return { ok: true, usage }
}

// ---------------------------------------------------------------------------
// 额度读取（含「过期先刷新、401 再试一次」）
// ---------------------------------------------------------------------------

function requestUsage(credential, deps) {
  return httpRequest({
    url: CODEX_ACCOUNT_USAGE_URL,
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + credential.access,
      'chatgpt-account-id': credential.accountId,
      accept: 'application/json',
      'cache-control': 'no-store',
    },
    signal: depsOf(deps).signal,
  }, deps)
}

function usageFailureOf(result) {
  if (result.kind === 'timeout') return transientFailureOf('timeout')
  if (result.kind === 'aborted') return transientFailureOf('aborted')
  if (result.kind === 'network') return transientFailureOf('network')
  if (result.kind === 'too-large') {
    return { ok: false, error: 'exec', message: MESSAGE_STRUCTURE, reason: 'too-large' }
  }
  if (result.kind === 'read-error') return transientFailureOf('read-error')
  const cls = statusClassOf(result.status)
  if (cls === 'unauthorized') return reauthFailure()
  if (cls === 'transient') return transientFailureOf('status-' + String(result.status))
  if (cls === 'redirect') {
    return { ok: false, error: 'exec', message: MESSAGE_FETCH_FAILED, reason: 'redirect' }
  }
  return { ok: false, error: 'exec', message: MESSAGE_FETCH_FAILED, reason: 'status-' + String(result.status) }
}

/**
 * 读一次额度（不做刷新；调用方保证 credential 新鲜）。
 *
 * @returns {Promise<{ok:true, usage:object}|{ok:false, error:string, message:string, transient?:boolean, reason?:string, unauthorized?:boolean}>}
 */
async function readUsageOnce(credential, deps) {
  const result = await requestUsage(credential, deps)
  if (result.kind !== 'response') return usageFailureOf(result)
  const cls = statusClassOf(result.status)
  if (cls === 'unauthorized') return Object.assign(usageFailureOf(result), { unauthorized: true })
  if (cls !== 'ok') return usageFailureOf(result)
  const body = parseJsonObject(result.text)
  if (body === null) return { ok: false, error: 'exec', message: MESSAGE_STRUCTURE, reason: 'structure' }
  const mapped = mapCodexAccountUsage(body, nowOf(deps))
  if (mapped.ok !== true) {
    return { ok: false, error: 'exec', message: MESSAGE_STRUCTURE, reason: 'structure' }
  }
  return { ok: true, usage: mapped.usage }
}

/**
 * 读本插件自持账号的 Codex 额度（**不** fallback 到 connect / subscription）。
 *
 * 流程：读记录（未登录/坏记录/读不到各自固定结论）→ 过期则刷新（single-flight）→
 * GET 额度；401/403 时**强制**刷新一次（未过期也刷，见 `runRefresh` 的 `force`）并重试
 * 一次，仍不通过 ⇒ `reauth-required`。
 *
 * @returns {Promise<
 *   {ok:true, usage:object, credential:object}
 *   |{ok:false, error:'signed-out'|'incompatible'|'reauth-required'|'exec', message:string, transient?:boolean, reason?:string}>}
 */
export async function fetchCodexAccountUsage(ctx, deps) {
  const seen = await readCodexAccountRecord(ctx, deps)
  if (seen.state === 'absent') {
    identitySnapshot = 'none'
    return { ok: false, error: 'signed-out', message: MESSAGE_SIGNED_OUT, reason: 'signed-out' }
  }
  if (seen.state === 'incompatible') {
    identitySnapshot = 'unknown'
    return { ok: false, error: 'incompatible', message: MESSAGE_INCOMPATIBLE, reason: 'incompatible' }
  }
  if (seen.state !== 'ok') {
    identitySnapshot = 'unknown'
    return { ok: false, error: 'exec', message: MESSAGE_UNREADABLE, reason: 'unavailable' }
  }
  let credential = seen.credential
  setIdentityFrom(credential)
  if (credentialExpired(credential, nowOf(deps))) {
    const refreshed = await refreshCredentialRecord(ctx, credential, deps)
    if (refreshed.ok !== true) return refreshed
    credential = refreshed.credential
  }
  let first = await readUsageOnce(credential, deps)
  if (first.ok === true) return { ok: true, usage: first.usage, credential }
  if (first.unauthorized !== true) return first
  // 401/403：只重试一次；这次刷新**强制**（未过期也刷），否则被吊销的 token 永远刷不动。
  const retried = await refreshCredentialRecord(ctx, credential, deps, { force: true })
  if (retried.ok !== true) return retried
  credential = retried.credential
  first = await readUsageOnce(credential, deps)
  if (first.ok === true) return { ok: true, usage: first.usage, credential }
  if (first.unauthorized === true) return reauthFailure()
  return first
}

// ---------------------------------------------------------------------------
// 状态（供 index.js 的路由 / UI 使用；不含 token）
// ---------------------------------------------------------------------------

/**
 * 单个账户的**可展示**视图（不含 token / 明文 accountId）。
 *
 * `label`：有 email 就用 email；没有就 `ChatGPT 账号 <maskedId>` —— 后半段是必须的，
 * 否则多个没有 email 的账户在列表里会全部显示成同一行、无法区分。
 */
function accountViewOf(credential) {
  const maskedId = maskAccountId(credential.accountId)
  const view = { label: credential.email !== undefined ? credential.email : 'ChatGPT 账号 ' + maskedId }
  if (credential.planType !== undefined) view.planType = credential.planType
  view.maskedId = maskedId
  return view
}

/**
 * 暴露给客户端的账户 id：**就是 `credentialId`**（登录时是 `randomUUID()`）。
 *
 * [2026-11-23 终审 B1-4] 字符集/长度与 Host（`index.js#CODEX_ACCOUNT_ID_PATTERN`）和客户端
 * **完全一致**：`^[A-Za-z0-9-]{1,100}$`（UUID / 测试夹具的 `cred-xxxx` 都满足）。
 * 上一版允许 `_.:`，于是模块给出的 id 在 Host 侧会被判非法、`select` 永远失败 ——
 * 三处必须同一套规则。异常形状时**不给 id**（条目仍可展示，但不可被选择）。
 */
function publicIdOf(credentialId) {
  const text = typeof credentialId === 'string' ? credentialId : ''
  return /^[A-Za-z0-9-]{1,100}$/u.test(text) ? text : ''
}

/** 状态 wire 里的单条账户投影（白名单逐字段重建）。 */
function accountEntryOf(credential, activeAccountId) {
  const view = accountViewOf(credential)
  const item = {}
  const id = publicIdOf(credential.credentialId)
  if (id.length > 0) item.id = id
  item.label = view.label
  if (view.planType !== undefined) item.planType = view.planType
  item.maskedId = view.maskedId
  item.active = credential.credentialId === activeAccountId
  return item
}

/**
 * 登录态摘要（**同步快照以外**的唯一宿主入口；不含 token / 明文账号）。
 *
 * @returns {Promise<{
 *   configured:boolean,
 *   canLogin:boolean,
 *   activeAccountId?:string,
 *   account?:object,
 *   accounts?:Array<object>,
 *   expiresAt?:number,
 *   revision?:number,
 *   reason?:string,
 * }>}
 *   - `account` / `expiresAt` / `revision` 都是 **active** 账户的；
 *   - `accounts` 顺序 = 记录里 `accounts` 的顺序，`active:true` 恒有且仅有一条；
 *   - `account` / `accounts` 里**没有** access / refresh / accountId / credentialId 之外的
 *     任何凭据信息（`id` 是 credentialId，随机 UUID，可安全外发）。
 */
export async function codexAccountState(ctx, deps) {
  const credentials = credentialsOf(ctx, deps)
  const canLogin = credentials.state === 'ok'
  const seen = await readCodexAccountRecord(ctx, deps)
  if (seen.state === 'ok') {
    const state = { configured: seen.accounts.length > 0, canLogin }
    const activeId = publicIdOf(seen.activeAccountId)
    if (activeId.length > 0) state.activeAccountId = activeId
    state.account = accountViewOf(seen.credential)
    state.accounts = seen.accounts.map((credential) => accountEntryOf(credential, seen.activeAccountId))
    state.expiresAt = seen.credential.expires
    state.revision = seen.credential.revision
    return state
  }
  if (seen.state === 'incompatible') return { configured: false, canLogin, reason: 'incompatible' }
  if (seen.state === 'unknown') return { configured: false, canLogin, reason: 'unavailable' }
  return { configured: false, canLogin, reason: 'signed-out' }
}

/**
 * 切换 active 账户（**只改 `activeAccountId`**，任何 token 都不动）。
 *
 * 在 `modifyRecord` 的独占写里重新读记录再定位（不以调用方传来的旧快照为准）：
 *   - 记录不存在 ⇒ `signed-out`；坏记录 ⇒ `incompatible`；
 *   - `credentialId` 找不到 ⇒ `not-found`；
 *   - 命中的账户已经是 active ⇒ **不写盘**（`{ok:true}` 即可，v1 记录因此保持原样）；
 *   - 否则写 v2（其它账户逐字保留），并把身份快照切到新 active。
 *
 * @returns {Promise<{ok:true, credential:object}|{ok:false, reason:string}>}
 *   reason 闭集：`credentials-unavailable` / `signed-out` / `incompatible` / `not-found` /
 *   `write-failed`。`credential` **含 token**，只供 Host 内部使用，绝不进 wire。
 */
export async function selectCodexAccount(ctx, credentialId, deps) {
  const credentials = credentialsOf(ctx, deps)
  if (credentials.state !== 'ok') return { ok: false, reason: 'credentials-unavailable' }
  const target = typeof credentialId === 'string' ? credentialId : ''
  let chosen = null
  let failure = null
  try {
    await credentials.service.modifyRecord(CODEX_ACCOUNT_RECORD_KEY, async (current) => {
      const seen = validateCodexAccountRecord(current)
      if (seen.state !== 'ok') {
        failure = seen.state === 'absent' ? 'signed-out' : 'incompatible'
        return undefined
      }
      const hit = seen.accounts.find((item) => item.credentialId === target)
      if (hit === undefined) {
        failure = 'not-found'
        return undefined
      }
      chosen = hit
      if (seen.activeAccountId === hit.credentialId) return undefined
      const built = v2RecordOf(seen.accounts, hit.credentialId)
      if (built === null) {
        chosen = null
        failure = 'write-failed'
        return undefined
      }
      return built.record
    })
  } catch (err) {
    return { ok: false, reason: 'write-failed' }
  }
  if (chosen === null) return { ok: false, reason: failure !== null ? failure : 'write-failed' }
  setIdentityFrom(chosen)
  return { ok: true, credential: chosen }
}

/**
 * 移除一个账户（缺省 = 移除 **active**）。
 *
 * 口径：
 *   - **[2026-11-23 终审 B1] 坏记录 + 未指定 id ⇒ 走 `clearCodexAccount()`**：客户端在
 *     未知态只可能无 id 调用（它拿不到任何可信 id），而严格校验又不允许把坏记录当可用；
 *     不给这条恢复入口，客户端的「重新登录 / 退出登录」承诺就是假的。删除 + 重读确认由
 *     `clearCodexAccount()` 保证（失败不谎报、不把身份清成 none）。
 *     成功返回 `{ok:true, removed:null, activeAccountId:undefined}`；失败返回其 reason。
 *     指定 id 时仍然固定 `incompatible`（坏记录里没有可信 id，不能猜目标）。
 *   - 还有别的账户 ⇒ 在 `modifyRecord` 里**重读后**只删这一项，`activeAccountId` 取
 *     「原 active 若仍在，否则剩余第一个」；返回 `{ok:true, removed, activeAccountId}`。
 *   - **[2026-11-25 R5] 记录里只剩这一个**（或在事务里刚好被别的写者删到只剩它）⇒ 在**同一个**
 *     `modifyRecord` 独占写里把记录改写成**空态 tombstone**（`emptyCodexAccountRecord()`），
 *     成功后身份快照 `none`，返回 `{ok:true, removed}`（**没有** `activeAccountId`）。
 *     不再有「事务外确认读 + `clearCodexAccount()` 无条件删除」：那个窗口里别人新增的账户会被
 *     一起删掉；而在 mutate 内直接 `deleteRecord` 又是对同一把锁重入（可能死锁），所以两者都不用。
 *     即使**初始读**只有 1 个账户也先经独占写复核 —— 期间别人加进来的账户必须被看见并保留。
 *   - 独占写里发现记录已经**不存在**（含别人刚写下的空态 tombstone）⇒ 幂等成功
 *     `{ok:true, removed:requested}`、不写盘、身份 `none`（目标账户必然已不在）。
 *   - 写失败一律 `{ok:false, reason}` 且**不**谎报成功、**不**把身份清成 none。
 *
 * @returns {Promise<
 *   {ok:true, removed:string|null, activeAccountId?:string}
 *   |{ok:false, reason:string}>}
 *   reason 闭集：`credentials-unavailable` / `signed-out` / `incompatible` / `not-found` /
 *   `write-failed`，以及坏记录恢复分支透传的 `clearCodexAccount()` reason
 *   （`unsupported` / `delete-failed` / `verify-failed` / `still-present`）。
 */
export async function removeCodexAccount(ctx, credentialId, deps) {
  const credentials = credentialsOf(ctx, deps)
  if (credentials.state !== 'ok') return { ok: false, reason: 'credentials-unavailable' }
  const explicitId = typeof credentialId === 'string' && credentialId.length > 0 ? credentialId : null
  const first = await readCodexAccountRecord(ctx, deps)
  if (first.state === 'absent') return { ok: false, reason: 'signed-out' }
  if (first.state === 'incompatible') {
    // [终审 B1] 坏记录的唯一恢复入口：无 id ⇒ 删整条记录（严格删除 + 重读确认）。
    if (explicitId !== null) return { ok: false, reason: 'incompatible' }
    const cleared = await clearCodexAccount(ctx, deps)
    if (cleared.ok !== true) return { ok: false, reason: cleared.reason }
    return { ok: true, removed: null, activeAccountId: undefined }
  }
  if (first.state !== 'ok') return { ok: false, reason: 'credentials-unavailable' }
  const requested = explicitId !== null ? explicitId : first.activeAccountId
  if (!first.accounts.some((item) => item.credentialId === requested)) {
    return { ok: false, reason: 'not-found' }
  }
  /**
   * 所有移除都先经过 `modifyRecord` 的**独占重读**（包括初始读只有 1 个账户的情形）：
   * 初始快照只是「要不要做这件事」的依据，真正的写入目标以独占时刻的记录为准。
   *
   * 这里**只有** `modifyRecord` 一条写路径：既不调用 `deleteRecord`（避免重入锁），
   * 也不在事务外做「确认读 + 删除」（那个窗口会误删并发新增的账户）。
   */
  let result = null
  let failure = null
  let activeAfter = null
  let signedOutAfter = false
  try {
    await credentials.service.modifyRecord(CODEX_ACCOUNT_RECORD_KEY, async (current) => {
      const seen = validateCodexAccountRecord(current)
      if (seen.state === 'absent') {
        /**
         * 记录已经不在了（别人删掉了它 / 已经是空态 tombstone）：目标账户必然也不在，
         * 这次移除按**幂等成功**处理，不写盘、不挂起。
         */
        signedOutAfter = true
        result = { ok: true, removed: requested }
        return undefined
      }
      if (seen.state !== 'ok') {
        failure = 'incompatible'
        return undefined
      }
      const index = seen.accounts.findIndex((item) => item.credentialId === requested)
      if (index < 0) {
        failure = 'not-found'
        return undefined
      }
      const remaining = seen.accounts.filter((item) => item.credentialId !== requested)
      if (remaining.length === 0) {
        /**
         * 只剩目标账户：**原子**改写成空态 tombstone（同一次独占写内完成）。
         * 别人在我们之后新增账户时，他们的写会从「未登录」出发重新建记录 ⇒ 不会被误删；
         * 别人在我们之前新增账户时，上面的 `seen` 已经看见它（`remaining.length > 0`），
         * 走下面的正常移除分支 ⇒ 也绝不会整条删掉。
         */
        const empty = emptyCodexAccountRecord()
        // 自检：写出去的东西必须被校验为 absent，否则宁可不写（不留下无法解释的记录）。
        if (validateCodexAccountRecord(empty).state !== 'absent') {
          failure = 'write-failed'
          return undefined
        }
        signedOutAfter = true
        result = { ok: true, removed: requested }
        return empty
      }
      const activeNext = remaining.some((item) => item.credentialId === seen.activeAccountId)
        ? seen.activeAccountId
        : remaining[0].credentialId
      const built = v2RecordOf(remaining, activeNext)
      if (built === null) {
        failure = 'write-failed'
        return undefined
      }
      activeAfter = built.parsed.credential
      result = { ok: true, removed: requested, activeAccountId: activeNext }
      return built.record
    })
  } catch (err) {
    return { ok: false, reason: 'write-failed' }
  }
  if (result === null) return { ok: false, reason: failure !== null ? failure : 'write-failed' }
  if (signedOutAfter === true) identitySnapshot = 'none'
  else if (activeAfter !== null) setIdentityFrom(activeAfter)
  return result
}

/**
 * 只删**本插件私有**的那一条记录（永不触碰其它 key、不动 profile 文件）。
 *
 * [2026-11-25 R5] **移除最后一个账户不再走这里**：那条路径改为在 `removeCodexAccount()` 的
 * `modifyRecord` 独占写里原子地写成空态 tombstone（避免「确认读 → 无条件删除」的竞态，
 * 也避免在 mutate 内 `deleteRecord` 重入锁）。本函数的 delete 语义**保持不变**，保留给
 * 「坏记录恢复」（`removeCodexAccount` 的 `incompatible` + 无 id 分支）与显式整条清理。
 *
 * [2026-11-22 终审 F3] **不谎报成功**：返回 `{ok:true}` 只在「删除调用成功 **且** 重读确认
 * 记录真的不在了」时给出；其它情况给 `{ok:false, reason}`，并且**不**把同步身份快照清成
 * `none` —— 那会让 GUI/观察身份以为已登出，而磁盘上的记录还在（下次取数又「自己回来了」）。
 *
 * reason 闭集：
 *   - `credentials-unavailable`：没有可用凭据服务（无法证明已删除）；
 *   - `unsupported`：该凭据服务没有 `deleteRecord`；
 *   - `delete-failed`：`deleteRecord` 抛错；
 *   - `verify-failed`：删除后重读本身抛错（结果未知，保守按未删处理）；
 *   - `still-present`：删除后重读仍能读到记录（删除没生效）。
 *
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function clearCodexAccount(ctx, deps) {
  const credentials = credentialsOf(ctx, deps)
  if (credentials.state !== 'ok') return { ok: false, reason: 'credentials-unavailable' }
  if (typeof credentials.service.deleteRecord !== 'function') return { ok: false, reason: 'unsupported' }
  try {
    await credentials.service.deleteRecord(CODEX_ACCOUNT_RECORD_KEY)
  } catch (err) {
    return { ok: false, reason: 'delete-failed' }
  }
  let raw
  let verifyFailed = false
  try {
    raw = await credentials.service.readRecord(CODEX_ACCOUNT_RECORD_KEY)
  } catch (err) {
    verifyFailed = true
  }
  if (verifyFailed === true) return { ok: false, reason: 'verify-failed' }
  if (raw !== undefined && raw !== null) return { ok: false, reason: 'still-present' }
  // 只有「确实删掉了」才把身份清成 none。
  identitySnapshot = 'none'
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 登录：设备码 manager
// ---------------------------------------------------------------------------

/**
 * 默认的落库实现（`saveCredential` 注入点只用于测试）—— **upsert 语义**。
 *
 * - 记录可以是 v1（旧单账户）或 v2；一律先归一成 `accounts + active` 再改。
 * - **[2026-11-23 终审 B1] 坏记录（`incompatible`）按「空账户集」继续登录**：否则客户端
 *   「重新登录」永远被拒，坏记录成了无法恢复的死锁。严格校验只约束**读**路径 —— 这里允许
 *   一次全新的登录把它替换成合法的 v2 单账户；`unknown`（凭据服务不可用 / 读不到）**仍然失败**，
 *   绝不拿「读不到」当「没有账户」去覆盖。
 * - `draft.accountId` **已存在**：更新该账户的 access / refresh / expires / savedAt /
 *   planType / email，**保留原 `credentialId`**，`revision + 1`，并把 active 切到它
 *   （同一账号重登录不该变成第二个账户）。
 * - 不存在：新增账户（`credentialId = randomUUID()`、`revision = 1`、追加到末尾），
 *   并设为 active；已有 `MAX_CODEX_ACCOUNTS` 个时**不写**、返回
 *   `{ok:false, reason:'limit', message:MESSAGE_ACCOUNT_LIMIT}`（登录状态机只显示这条固定文案，
 *   不外泄 reason）。
 * - 落盘一律 v2，成功后把身份快照切到 active。
 *
 * @returns {Promise<{ok:true, credential:object}
 *   |{ok:false, reason:string, message?:string}>}
 *   `credential` 是 **active** 账户（含 token，只供 Host 内部使用）。
 */
async function defaultSaveCredential(ctx, draft, deps) {
  const credentials = credentialsOf(ctx, deps)
  if (credentials.state !== 'ok') return { ok: false, reason: 'unavailable' }
  const draftAccountId = typeof draft.accountId === 'string' ? draft.accountId : ''
  if (draftAccountId.length === 0) return { ok: false, reason: 'incompatible' }
  /**
   * [2026-11-23 终审 B1] 落库前的**可证明性**检查：`readRecord` 抛错 ⇒ `unknown` ⇒ 必须失败。
   *
   * 只靠 `modifyRecord` 的 `current` 不够：真实服务若在读失败时把 `undefined` 当「没有记录」
   * 交给 mutate，坏记录 / 读不到的记录会被悄悄当成空账户集覆盖。这里先用唯一读路径确认
   * 「能证明当前状态」，证明不了就不写。`absent` / `incompatible` 仍可继续（前者是首次登录，
   * 后者是用户显式「重新登录」要覆盖的坏记录）。
   */
  const preexisting = await readCodexAccountRecord(ctx, deps)
  if (preexisting.state === 'unknown') return { ok: false, reason: 'unavailable' }
  const now = nowOf(deps)
  const savedAt = new Date(now).toISOString()
  let committed = null
  let failure = null
  try {
    await credentials.service.modifyRecord(CODEX_ACCOUNT_RECORD_KEY, async (current) => {
      const seen = validateCodexAccountRecord(current)
      /**
       * `unknown` 在本模块的校验里不会出现（`validateCodexAccountRecord` 只有
       * ok / absent / incompatible），但保留这条 fail-closed 判断：任何时候「无法证明当前
       * 记录是什么」都不能被当成空账户集覆盖掉。
       */
      if (seen.state === 'unknown') {
        failure = 'unavailable'
        return undefined
      }
      /**
       * [2026-11-23 终审 B1] `incompatible` = 坏记录，按**空账户集**处理：
       * 这次登录是用户显式发起的「重新登录」，落库结果是一个全新的合法 v2 单账户
       * （新 credentialId、revision=1、active=它），从而真正覆盖坏记录。
       * 绝不能悄悄把旧账户当可用（读路径仍然严格拒绝它）。
       */
      const accounts = seen.state === 'ok' ? seen.accounts.slice() : []
      const index = accounts.findIndex((item) => item.accountId === draftAccountId)
      let target
      if (index >= 0) {
        /**
         * 同一账号重登录：**保留 credentialId**（在途刷新/旧观察因此仍指向同一个账户），
         * revision 单调 +1 表示「这一账户被重新授权过」。
         */
        const previous = accounts[index]
        target = Object.assign({}, previous, {
          access: draft.access,
          refresh: draft.refresh,
          expires: draft.expires,
          savedAt,
          revision: previous.revision + 1,
        })
        // planType / email 跟随这次登录；本次登录没拿到（如 id_token 解析失败）时保留旧值 ——
        // 账号的 email 不会因为一次解析失败而变，删掉只会把列表标签改成遮罩号。
        if (typeof draft.planType === 'string' && draft.planType.length > 0) target.planType = draft.planType
        if (typeof draft.email === 'string' && draft.email.length > 0) target.email = draft.email
        accounts[index] = target
      } else {
        if (accounts.length >= MAX_CODEX_ACCOUNTS) {
          failure = 'limit'
          return undefined
        }
        target = {
          type: 'oauth',
          access: draft.access,
          refresh: draft.refresh,
          expires: draft.expires,
          accountId: draftAccountId,
          credentialId: randomUUID(),
          revision: 1,
          savedAt,
        }
        if (typeof draft.planType === 'string' && draft.planType.length > 0) target.planType = draft.planType
        if (typeof draft.email === 'string' && draft.email.length > 0) target.email = draft.email
        accounts.push(target)
      }
      const built = v2RecordOf(accounts, target.credentialId)
      if (built === null) {
        failure = 'write-failed'
        return undefined
      }
      committed = built.parsed.credential
      return built.record
    })
  } catch (err) {
    return { ok: false, reason: 'write-failed' }
  }
  if (committed === null) {
    const reason = failure !== null ? failure : 'write-failed'
    // 只有「满了」是可操作的事实：把固定文案带给调用方（登录状态机原样显示它）。
    return reason === 'limit'
      ? { ok: false, reason, message: MESSAGE_ACCOUNT_LIMIT }
      : { ok: false, reason }
  }
  setIdentityFrom(committed)
  return { ok: true, credential: committed }
}

/**
 * 创建一次设备码登录会话（**固定端点**，不接受任何 URL 参数）。
 *
 * 状态机：`idle → starting → waiting →(slow_down)→ waiting → exchanging → authorized`
 *   失败/终止态：`failed` / `expired` / `cancelled`。
 *
 * @param {object} ctx
 * @param {object} [options] 测试注入：`{fetch, now, setTimeout, clearTimeout, saveCredential, onAuthorized, timeoutMs}`
 * @returns {{start:()=>Promise<object>, status:()=>object, cancel:()=>void, dispose:()=>void}}
 */
export function createCodexAccountLogin(ctx, options) {
  const opts = isPlainObject(options) ? options : {}
  const deps = {
    fetch: typeof opts.fetch === 'function' ? opts.fetch : undefined,
    now: typeof opts.now === 'function' ? opts.now : undefined,
    setTimeout: typeof opts.setTimeout === 'function' ? opts.setTimeout : undefined,
    clearTimeout: typeof opts.clearTimeout === 'function' ? opts.clearTimeout : undefined,
  }
  const loginTimeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEVICE_CODE_TTL_MS
  const onAuthorized = typeof opts.onAuthorized === 'function' ? opts.onAuthorized : null
  const saveCredential = typeof opts.saveCredential === 'function'
    ? (draft) => opts.saveCredential(draft)
    : (draft) => defaultSaveCredential(ctx, draft, deps)

  const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : globalThis.setTimeout
  const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : globalThis.clearTimeout

  let state = 'idle'
  let message = null
  let userCode = null
  let deviceAuthId = null
  let intervalMs = DEVICE_POLL_DEFAULT_MS
  let deadlineAt = null
  let timer = null
  let generation = 0
  let disposed = false
  let busy = false
  let account = null
  let revision = null

  function clearPollTimer() {
    if (timer === null) return
    const handle = timer
    timer = null
    try {
      if (typeof clearTimer === 'function') clearTimer(handle)
    } catch (err) { /* ignore */ }
  }

  /** 对外快照：只含**可展示**信息（user_code / 验证页 / 状态 / 遮罩账号）。 */
  function snapshot() {
    const out = { state }
    if (userCode !== null) {
      out.userCode = userCode
      out.verificationUrl = CODEX_ACCOUNT_DEVICE_VERIFY_URL
    }
    if (state === 'waiting' || state === 'slow_down') out.intervalMs = intervalMs
    if (deadlineAt !== null) out.expiresAt = deadlineAt
    if (account !== null) out.account = account
    if (revision !== null) out.revision = revision
    if (message !== null) out.message = message
    return out
  }

  function settle(nextState, nextMessage) {
    clearPollTimer()
    state = nextState
    message = nextMessage === undefined ? null : nextMessage
  }

  function schedule(gen) {
    clearPollTimer()
    const delay = Math.min(Math.max(intervalMs, DEVICE_POLL_MIN_MS), DEVICE_POLL_MAX_MS)
    timer = setTimer(() => {
      timer = null
      // 定时器回调不能把异常变成未处理的 rejection（`tick` 内部已尽量兜住，这里再兜一层）。
      void tick(gen).catch(() => {})
    }, delay)
  }

  async function finish(gen, outcome) {
    state = 'exchanging'
    const exchanged = await exchangeAuthorizationCode(outcome.code, outcome.verifier, deps)
    if (disposed || gen !== generation) return
    if (exchanged.kind === 'aborted' || exchanged.kind === 'transient') {
      settle('failed', MESSAGE_EXCHANGE_FAILED)
      return
    }
    if (exchanged.kind === 'reauth') {
      settle('failed', MESSAGE_DEVICE_DENIED)
      return
    }
    if (exchanged.kind !== 'ok') {
      settle('failed', MESSAGE_LOGIN_INCOMPLETE)
      return
    }
    const claims = accountClaimsOf(exchanged.access)
    if (claims === null) {
      settle('failed', MESSAGE_LOGIN_INCOMPLETE)
      return
    }
    const email = emailOf(exchanged.idToken)
    let saved
    try {
      saved = await saveCredential({
        access: exchanged.access,
        refresh: exchanged.refresh,
        expires: exchanged.expires,
        accountId: claims.accountId,
        planType: claims.planType,
        email,
      })
    } catch (err) {
      // 落库实现抛错 = 保存失败（不外泄原因，也不把 token 带进文案）。
      saved = null
    }
    if (disposed || gen !== generation) return
    if (saved === null || typeof saved !== 'object' || saved.ok !== true) {
      /**
       * [2026-11-23 终审 B1] `reason:'limit'` 有**可操作的固定文案**（"先移除一个账户"）；
       * 其它失败（写盘失败 / 坏记录之外的服务不可用 / 抛错）仍是笼统的保存失败。
       * 只根据 reason 选择预置常量，绝不把 reason 或任何内部字段拼进文案。
       */
      const saveReason = saved !== null && typeof saved === 'object' ? saved.reason : undefined
      settle('failed', saveReason === 'limit' ? MESSAGE_ACCOUNT_LIMIT : MESSAGE_LOGIN_SAVE_FAILED)
      return
    }
    const credential = saved.credential
    account = accountViewOf(credential)
    revision = credential.revision
    settle('authorized', null)
    if (onAuthorized !== null) {
      try {
        // 回调里**只有**可展示信息，绝不含 token。
        onAuthorized({ account, expiresAt: credential.expires, revision: credential.revision })
      } catch (err) { /* 回调异常不影响登录结果 */ }
    }
  }

  async function tick(gen) {
    if (disposed || gen !== generation || (state !== 'waiting' && state !== 'slow_down')) return
    if (deadlineAt !== null && nowOf(deps) >= deadlineAt) {
      settle('expired', MESSAGE_DEVICE_EXPIRED)
      return
    }
    if (busy === true) {
      schedule(gen)
      return
    }
    busy = true
    let outcome
    try {
      outcome = await pollDeviceToken(deviceAuthId, userCode, deps)
    } catch (err) {
      outcome = { kind: 'retry' }
    } finally {
      busy = false
    }
    if (disposed || gen !== generation) return
    if (outcome.kind === 'aborted') return
    if (outcome.kind === 'success') {
      await finish(gen, outcome)
      return
    }
    if (outcome.kind === 'pending' || outcome.kind === 'retry') {
      state = 'waiting'
      schedule(gen)
      return
    }
    if (outcome.kind === 'slow_down') {
      // 上游要求降速：间隔单调增加（有上限），状态可见地变成 `slow_down`。
      intervalMs = Math.min(intervalMs + DEVICE_SLOW_DOWN_STEP_MS, DEVICE_POLL_MAX_MS)
      state = 'slow_down'
      schedule(gen)
      return
    }
    if (outcome.kind === 'expired') {
      settle('expired', MESSAGE_DEVICE_EXPIRED)
      return
    }
    settle('failed', MESSAGE_DEVICE_DENIED)
  }

  async function start() {
    if (disposed) return snapshot()
    if (state === 'starting' || state === 'waiting' || state === 'exchanging') return snapshot()
    clearPollTimer()
    generation += 1
    const gen = generation
    state = 'starting'
    message = null
    userCode = null
    deviceAuthId = null
    intervalMs = DEVICE_POLL_DEFAULT_MS
    deadlineAt = null
    account = null
    revision = null
    const outcome = await requestDeviceCode(deps)
    if (disposed || gen !== generation) return snapshot()
    if (outcome.kind === 'unsupported') {
      settle('failed', MESSAGE_DEVICE_UNSUPPORTED)
      return snapshot()
    }
    if (outcome.kind !== 'ok') {
      settle('failed', MESSAGE_DEVICE_START_FAILED)
      return snapshot()
    }
    deviceAuthId = outcome.deviceAuthId
    userCode = outcome.userCode
    intervalMs = outcome.intervalMs
    deadlineAt = nowOf(deps) + loginTimeoutMs
    state = 'waiting'
    message = null
    schedule(gen)
    return snapshot()
  }

  function cancel() {
    if (disposed) return
    generation += 1
    clearPollTimer()
    if (state === 'idle' || state === 'failed' || state === 'expired'
      || state === 'cancelled' || state === 'authorized') return
    settle('cancelled', MESSAGE_DEVICE_CANCELLED)
  }

  function dispose() {
    if (disposed) return
    cancel()
    disposed = true
    clearPollTimer()
  }

  return { start, status: snapshot, cancel, dispose }
}
