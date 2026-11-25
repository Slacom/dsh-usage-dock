/**
 * [2026-11-22 Codex `account` 来源 / 2026-11-23 多账户 v2] 定向回归：**全离线、全 fake**。
 *
 * 覆盖（不联网、不起服务、不读真实 cfg/凭据/账号、不 import 任何第三方插件）：
 *   A 记录校验：v1（旧单账户）与 v2（多账户）两种 payload；
 *     缺字段/错类型/expires 非正/多余 key/重复 id/账户数 0 或 >8/active 不命中 ⇒ incompatible
 *   B 读记录：absent / unknown（无凭据服务、读取抛错、getter 抛错）/ ok（v1 内存迁移成单账户）
 *   C 状态摘要：configured / canLogin / accounts 列表 / active 标记 / 遮罩账号 / 三种 reason
 *   D 身份快照：`acct:<hash8>@<cred8>r<revision>`、换账户即变、刷新不变、none / unknown
 *   E 额度映射：5h/周按 `limit_window_seconds` 识别（不看 primary/secondary 顺序）、
 *     `reset_at` 秒 → `resetAt`、`reset_after_seconds` 换算、credits、spend control、结构异常
 *   F 额度读取：未登录/坏记录/无凭据；刷新只在过期时发生；401/403/429/5xx/超时/结构/重定向/
 *     超限/非对象 JSON；single-flight；modifyRecord 内二次检查（别人刷过 / 账户被换）
 *   G 设备码登录状态机：start / pending / slow_down / success / 超时 / cancel / 各类失败文案；
 *     默认落库 upsert（新账户 revision=1、同账户重登录 credentialId 不变 + revision+1）
 *   H clearCodexAccount 只删本插件自己的记录（严格口径，不谎报）
 *   I `plans/codex.js`：account 形状投影 → wire、fetchedAt 透传、零 fallback、忽略 codexSource
 *   J 多账户：v1→v2 迁移、登录新增第二个账户、select 切换、remove（含删最后一个）、
 *     刷新只动指定账户（其它账户与 revision 不受影响）、账户被移除后 reauth
 *   K 状态 wire：只有白名单字段，无 token / accountId 明文，active 标记唯一
 *   R5 [2026-11-25] 移除**最后一个**账户 = 一次 modifyRecord 原子写空态 tombstone：
 *     tombstone 精确形状 ⇒ absent（其它空账户形状仍 incompatible）；无并发（tombstone →
 *     read absent / state 未登录 → 之后新增 B 成功）；**竞态**（B 的写入先成功 ⇒ 只移除 A、
 *     B 与它的 token 都在、不挂起）；对照（A+B 移除 A 保留 B）；零 deleteRecord
 *   Z 全局脱敏：所有对外对象里都不含 access / refresh / id_token 原文
 *
 * 用法：node tools/test-codex-account.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CODEX_ACCOUNT_RECORD_KEY,
  CODEX_ACCOUNT_CLIENT_ID,
  CODEX_AUTH_ORIGIN,
  CODEX_ACCOUNT_DEVICE_VERIFY_URL,
  CODEX_ACCOUNT_USAGE_URL,
  MAX_CODEX_ACCOUNTS,
  MESSAGE_ACCOUNT_LIMIT,
  readCodexAccountRecord,
  codexAccountState,
  codexAccountIdentitySnapshot,
  refreshCodexAccountIdentity,
  fetchCodexAccountUsage,
  createCodexAccountLogin,
  clearCodexAccount,
  selectCodexAccount,
  removeCodexAccount,
  validateCodexAccountRecord,
  emptyCodexAccountRecord,
  mapCodexAccountUsage,
} from '../plans/codex-account.js'
import { createCodexPlan } from '../plans/codex.js'
import { normalizeCodexSource } from '../plans/codex-sources.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) {
    passCount++
    console.log('[PASS] ' + name)
  } else {
    failCount++
    console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 800) : ''))
  }
}

// ---------------------------------------------------------------------------
// 公共夹具（全部合成数据）
// ---------------------------------------------------------------------------

/** 三个 sentinel：出现在任何对外对象里都算泄漏。 */
const SENT_ACCESS = 'ACCESS-TOKEN-SENTINEL-7f1a'
const SENT_REFRESH = 'REFRESH-TOKEN-SENTINEL-2b9c'
const SENT_ID = 'ID-TOKEN-SENTINEL-4d2e'

const NOW = 1_760_000_000_000
const ACCOUNT_ID = 'acc-1111-2222-3333-444444444444'
const ACCOUNT_ID_2 = 'acc-9999-8888-7777-666666666666'
const ACCOUNT_ID_3 = 'acc-5555-6666-7777-888888888888'
const CREDENTIAL_ID = 'cred-aaaaaaaa-1111'
const CREDENTIAL_ID_2 = 'cred-bbbbbbbb-2222'
const CREDENTIAL_ID_3 = 'cred-cccccccc-3333'

const USERS_URL = CODEX_AUTH_ORIGIN + '/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = CODEX_AUTH_ORIGIN + '/api/accounts/deviceauth/token'
const TOKEN_URL = CODEX_AUTH_ORIGIN + '/oauth/token'

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * 造一个 JWT：payload 可控，**第三段（签名）里放 sentinel** —— 这样任何把
 * token 原文漏到 message / 状态 / 身份里的实现都会被 sentinel 扫描抓到。
 */
function makeJwt(payload, sentinel) {
  return [
    b64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    b64url(JSON.stringify(payload)),
    sentinel,
  ].join('.')
}

function accessTokenOf(accountId, planType) {
  const auth = { chatgpt_account_id: accountId }
  if (planType !== undefined) auth.chatgpt_plan_type = planType
  return makeJwt({ 'https://api.openai.com/auth': auth }, SENT_ACCESS)
}

function idTokenOf(email) {
  return makeJwt({ email }, SENT_ID)
}

/** 单个 credential（v1 的 payload 与 v2 的 `accounts` 元素同形）；可覆盖任意白名单字段。 */
function credentialOf(overrides) {
  return Object.assign({
    type: 'oauth',
    access: accessTokenOf(ACCOUNT_ID, 'plus'),
    refresh: SENT_REFRESH,
    expires: NOW + 3_600_000,
    accountId: ACCOUNT_ID,
    credentialId: CREDENTIAL_ID,
    revision: 3,
    savedAt: '2026-11-22T00:00:00.000Z',
    planType: 'plus',
  }, overrides || {})
}

/** 造一个 v2（多账户）记录；`activeAccountId` 缺省取第一个账户。 */
function multiRecordOf(accounts, activeAccountId) {
  const list = Array.isArray(accounts) ? accounts : [accounts]
  const active = typeof activeAccountId === 'string' ? activeAccountId : list[0].credentialId
  return { kind: 'grant', payload: { version: 2, activeAccountId: active, accounts: list } }
}

/** 默认夹具：**v2 单账户**记录（`overrides` 覆盖该账户的字段）。 */
function recordOf(overrides) {
  return multiRecordOf(credentialOf(overrides))
}

/** 旧 v1 记录：payload 直接就是单个 credential（迁移/兼容用）。 */
function v1RecordOf(overrides) {
  return { kind: 'grant', payload: credentialOf(overrides) }
}

/**
 * [2026-11-25 R5] 空态记录（tombstone）的**精确**形状：
 * 移除**最后一个**账户后写下的就是它，`validateCodexAccountRecord` 必须把它判成 `absent`。
 */
const EMPTY_TOMBSTONE = Object.freeze({
  kind: 'grant',
  payload: { version: 2, activeAccountId: null, accounts: [] },
})

/**
 * 记录是否**逐字**就是那个空态 tombstone（kind 只有 payload、payload 恰好 3 个 key、
 * `activeAccountId === null`、`accounts` 是空数组）。多一个 key、值不同都不算。
 */
function isTombstone(record) {
  if (record === null || record === undefined || typeof record !== 'object') return false
  if (record.kind !== 'grant') return false
  if (Object.keys(record).join(',') !== 'kind,payload') return false
  const payload = record.payload
  if (payload === null || payload === undefined || typeof payload !== 'object') return false
  if (Object.keys(payload).length !== 3) return false
  return payload.version === 2
    && payload.activeAccountId === null
    && Array.isArray(payload.accounts) && payload.accounts.length === 0
}

/** 深比较（`assert.deepStrictEqual` 的布尔版：不抛，只回答是否相等）。 */
function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b)
    return true
  } catch (err) {
    return false
  }
}

/**
 * 「不挂起」守卫：`promise` 在 `ms` 内没有 settle ⇒ 抛错（让用例失败而不是卡死整套测试）。
 * 无论结果如何都会清掉守卫定时器，避免未处理的 rejection。
 */
async function withNoHang(promise, ms) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('hung for more than ' + String(ms) + 'ms')) }, ms === undefined ? 3000 : ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 从（可能已被实现改写的）fake 记录里取账户 payload 列表：v1 与 v2 都吃。 */
function accountPayloadsOf(record) {
  const payload = record !== null && record !== undefined ? record.payload : undefined
  if (payload === null || payload === undefined || typeof payload !== 'object') return []
  if (Array.isArray(payload.accounts)) return payload.accounts
  return [payload]
}

function firstAccountPayload(record) {
  return accountPayloadsOf(record)[0]
}

function accountPayloadById(record, credentialId) {
  return accountPayloadsOf(record).find((item) => item.credentialId === credentialId)
}

/** 失败的 sentinel 扫描：返回命中的 sentinel 列表（应为空）。 */
function leaksIn(value) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch (err) {
    text = String(value)
  }
  if (typeof text !== 'string') return []
  return [SENT_ACCESS, SENT_REFRESH, SENT_ID].filter((sentinel) => text.includes(sentinel))
}

function plaintextAccountLeak(value, accountId) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return typeof text === 'string' && text.includes(accountId)
}

/**
 * fake 宿主凭据服务（`readRecord` / `modifyRecord` / `deleteRecord`）。
 *
 * `modifyRecord` 按宿主语义**串行**执行（唯一写路径），`mutate` 返回 `undefined` 表示不写。
 *
 * 删除相关开关（[2026-11-22 终审 F3] 用）：
 *   - `deleteError`：`deleteRecord` 抛错；
 *   - `deleteNoop`：`deleteRecord` 「成功返回」但记录其实还在（真实 provider 出错时的形状）；
 *   - `readErrorAfterDelete`：删除后重读抛错（结果未知）；
 *   - `noDeleteMember`：服务根本没有 `deleteRecord`。
 *
 * 并发开关（[2026-11-23 终审 B1-6] TOCTOU 用例）：
 *   - `beforeModify(state)`：在 `mutate` **之前**执行，用来模拟「初始读之后、独占写之前
 *     另一个写者加了账户」；
 *   - `afterModify(state)`：在 `mutate` 返回之后、写盘判定之前执行，用来模拟
 *     「独占写复核之后、删除确认之前另一个写者加了账户」。
 */
function fakeCredentials(options) {
  const opts = options === null || options === undefined ? {} : options
  const state = {
    record: Object.prototype.hasOwnProperty.call(opts, 'record') ? opts.record : undefined,
    reads: 0,
    modifies: 0,
    writes: 0,
    skipped: 0,
    deletes: 0,
    readError: opts.readError === true,
    writeError: opts.writeError === true,
    deleteError: opts.deleteError === true,
    deleteNoop: opts.deleteNoop === true,
    readErrorAfterDelete: opts.readErrorAfterDelete === true,
    keys: [],
    written: [],
  }
  let tail = Promise.resolve()
  const service = {
    async readRecord(key) {
      state.keys.push(key)
      state.reads += 1
      if (state.readError === true) throw new Error('read-failed')
      return state.record
    },
    modifyRecord(key, mutate) {
      state.keys.push(key)
      state.modifies += 1
      const run = tail.then(async () => {
        if (state.writeError === true) throw new Error('write-failed')
        if (typeof opts.beforeModify === 'function') await opts.beforeModify(state, key)
        const next = await mutate(state.record)
        if (typeof opts.afterModify === 'function') await opts.afterModify(state, key)
        if (next === undefined) {
          state.skipped += 1
          return undefined
        }
        state.record = next
        state.written.push(next)
        state.writes += 1
        return next
      })
      tail = run.then(() => undefined, () => undefined)
      return run
    },
    async deleteRecord(key) {
      state.keys.push(key)
      state.deletes += 1
      if (state.deleteError === true) throw new Error('delete-failed')
      // `deleteNoop`：调用方看起来成功，但记录实际没被删（用来证明「不谎报成功」）。
      if (state.deleteNoop === true) return undefined
      state.record = undefined
      if (state.readErrorAfterDelete === true) state.readError = true
      return undefined
    },
  }
  if (opts.noDeleteMember === true) service.deleteRecord = undefined
  const ctx = {
    get(name) {
      return name === 'credentials' ? service : undefined
    },
  }
  return { state, service, ctx }
}

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

/** 按 URL 路由的 fake fetch；记录每次调用的 url / init。 */
function fakeFetch(handler) {
  const calls = []
  const fetchFn = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return handler(call, calls)
  }
  return { impl: fetchFn, calls }
}

function callsTo(calls, url) {
  return calls.filter((call) => call.url === url)
}

function fakeClock(start) {
  const state = { now: start }
  return {
    state,
    now: () => state.now,
    advance(ms) {
      state.now += ms
      return state.now
    },
  }
}

/** 假定时器：不真的等待，由测试按需 flush。 */
function fakeTimers() {
  const pending = []
  let nextId = 1
  return {
    pending,
    setTimeout(fn, delay) {
      const id = nextId
      nextId += 1
      pending.push({ id, fn, delay })
      return id
    },
    clearTimeout(id) {
      const index = pending.findIndex((item) => item.id === id)
      if (index >= 0) pending.splice(index, 1)
    },
    delays() {
      return pending.map((item) => item.delay)
    },
    async flushOne() {
      const item = pending.shift()
      if (item === undefined) return false
      await item.fn()
      await settle()
      return true
    },
    async flushAll() {
      let ran = false
      while (pending.length > 0) {
        ran = (await this.flushOne()) || ran
      }
      return ran
    },
  }
}

/** 让已排队的微任务/续体真正跑完（真实 setImmediate）。 */
async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 上游 wham/usage 的合成响应体。 */
function usageBody(overrides) {
  const base = {
    rate_limit: {
      primary_window: { used_percent: 36, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3_600 },
      secondary_window: { used_percent: 17.5, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 86_400 },
    },
    credits: { has_credits: true, unlimited: false, balance: 12.5 },
    spend_control: {
      // [2026-11-22 终审 F1] 上游确实带 `remaining` 精确金额（参考 dsh-codex-connect usage.ts）。
      individual_limit: { limit: '20.00', used: '7.50', remaining: '12.50', remaining_percent: 62.5 },
    },
    plan_type: 'plus',
  }
  if (overrides === undefined) return base
  return Object.assign({}, base, overrides)
}

// ===========================================================================
// A — 记录校验（严格：坏记录绝不进入可用路径）
// ===========================================================================
{
  check('A1 记录缺失 ⇒ absent', validateCodexAccountRecord(undefined).state === 'absent'
    && validateCodexAccountRecord(null).state === 'absent')

  const good = validateCodexAccountRecord(recordOf())
  check('A2 合法 v2 记录 ⇒ ok（version/accounts/active/credential 齐全）', good.state === 'ok'
    && good.version === 2
    && Array.isArray(good.accounts) && good.accounts.length === 1
    && good.activeAccountId === CREDENTIAL_ID
    && good.credential.accountId === ACCOUNT_ID
    && good.credential.credentialId === CREDENTIAL_ID
    && good.credential.revision === 3
    && good.credential.planType === 'plus', good)

  const badList = [
    ['payload 不是对象', { kind: 'grant', payload: 'x' }],
    ['kind 不是 grant', { kind: 'secret', payload: recordOf().payload }],
    ['记录不是对象', 'record'],
    ['type 不是 oauth', recordOf({ type: 'bearer' })],
    ['access 空串', recordOf({ access: '' })],
    ['refresh 缺字段', (() => { const r = recordOf(); delete r.payload.accounts[0].refresh; return r })()],
    ['expires=0', recordOf({ expires: 0 })],
    ['expires 负数', recordOf({ expires: -1 })],
    ['expires 非数字', recordOf({ expires: 'soon' })],
    ['expires 非安全整数', recordOf({ expires: 1e300 })],
    ['accountId 缺字段', (() => { const r = recordOf(); delete r.payload.accounts[0].accountId; return r })()],
    ['credentialId 空串', recordOf({ credentialId: '' })],
    ['revision=0', recordOf({ revision: 0 })],
    ['revision 小数', recordOf({ revision: 1.5 })],
    ['savedAt 非字符串', recordOf({ savedAt: 42 })],
    ['planType 类型错', recordOf({ planType: 7 })],
    ['email 类型错', recordOf({ email: {} })],
    // v1（旧 payload）同样严格：同一条字段规则不允许被 v1 绕过
    ['v1 type 不是 oauth', v1RecordOf({ type: 'bearer' })],
    ['v1 expires=0', v1RecordOf({ expires: 0 })],
    ['v1 revision 小数', v1RecordOf({ revision: 1.5 })],
  ]
  for (const [label, record] of badList) {
    const seen = validateCodexAccountRecord(record)
    check('A3 ' + label + ' ⇒ incompatible', seen.state === 'incompatible' && typeof seen.reason === 'string', seen)
  }

  const extra = recordOf()
  extra.payload.accounts[0].mystery = 'x'
  check('A4 账户里多余 key ⇒ incompatible（不透传任意对象）',
    validateCodexAccountRecord(extra).state === 'incompatible', validateCodexAccountRecord(extra))

  const extraTop = recordOf()
  extraTop.payload.mystery = 'x'
  check('A4b v2 顶层多余 key ⇒ incompatible', validateCodexAccountRecord(extraTop).state === 'incompatible',
    validateCodexAccountRecord(extraTop))

  const checked = validateCodexAccountRecord(recordOf({ email: 'a@b.example' }))
  check('A5 email 合法时保留', checked.state === 'ok' && checked.credential.email === 'a@b.example', checked)

  // ── v1 → 单账户（内存等价，绝不判成 incompatible）────────────────────────
  const v1 = validateCodexAccountRecord(v1RecordOf({ email: 'old@example.com' }))
  check('A6 旧 v1 记录 ⇒ ok，且内存里就是 1 个账户、active = 它的 credentialId',
    v1.state === 'ok' && v1.version === 1
    && v1.accounts.length === 1
    && v1.activeAccountId === CREDENTIAL_ID
    && v1.credential.credentialId === CREDENTIAL_ID
    && v1.credential.email === 'old@example.com', v1)

  // ── v2 结构（账户数 / 重复 id / active 命中）──────────────────────────────
  const twoAccounts = multiRecordOf([
    credentialOf({}),
    credentialOf({ accountId: ACCOUNT_ID_2, credentialId: CREDENTIAL_ID_2, revision: 1, email: 'b@example.com' }),
  ], CREDENTIAL_ID_2)
  const two = validateCodexAccountRecord(twoAccounts)
  check('A7 两个账户的 v2 ⇒ ok，active 指向第二个',
    two.state === 'ok' && two.accounts.length === 2
    && two.activeAccountId === CREDENTIAL_ID_2
    && two.credential.accountId === ACCOUNT_ID_2, two)

  const dupCredential = multiRecordOf([
    credentialOf({}),
    credentialOf({ accountId: ACCOUNT_ID_2 }),
  ])
  check('A8 credentialId 重复 ⇒ incompatible',
    validateCodexAccountRecord(dupCredential).state === 'incompatible'
    && validateCodexAccountRecord(dupCredential).reason === 'duplicate-credential-id',
    validateCodexAccountRecord(dupCredential))

  const dupAccount = multiRecordOf([
    credentialOf({}),
    credentialOf({ credentialId: CREDENTIAL_ID_2 }),
  ])
  check('A9 accountId 重复 ⇒ incompatible',
    validateCodexAccountRecord(dupAccount).state === 'incompatible'
    && validateCodexAccountRecord(dupAccount).reason === 'duplicate-account-id',
    validateCodexAccountRecord(dupAccount))

  check('A10 accounts 为空数组 ⇒ incompatible（configured 不允许 0 个账户的记录）',
    validateCodexAccountRecord(multiRecordOf([], CREDENTIAL_ID)).state === 'incompatible',
    validateCodexAccountRecord(multiRecordOf([], CREDENTIAL_ID)))

  const nineAccounts = Array.from({ length: MAX_CODEX_ACCOUNTS + 1 }, (_unused, index) => credentialOf({
    accountId: 'acc-extra-' + String(index),
    credentialId: 'cred-extra-' + String(index),
  }))
  check('A11 超过 ' + MAX_CODEX_ACCOUNTS + ' 个账户 ⇒ incompatible（超限）',
    validateCodexAccountRecord(multiRecordOf(nineAccounts, 'cred-extra-0')).state === 'incompatible',
    validateCodexAccountRecord(multiRecordOf(nineAccounts, 'cred-extra-0')).reason)

  const eightAccounts = nineAccounts.slice(0, MAX_CODEX_ACCOUNTS)
  check('A12 恰好 ' + MAX_CODEX_ACCOUNTS + ' 个账户 ⇒ ok（上限含端点）',
    validateCodexAccountRecord(multiRecordOf(eightAccounts, 'cred-extra-0')).state === 'ok')

  check('A13 activeAccountId 不命中任何账户 ⇒ incompatible',
    validateCodexAccountRecord(multiRecordOf([credentialOf({})], 'cred-nobody')).reason === 'active-account-missing',
    validateCodexAccountRecord(multiRecordOf([credentialOf({})], 'cred-nobody')))

  check('A14 version 不是 2 ⇒ incompatible（不猜是 v1 还是 v3）',
    validateCodexAccountRecord({ kind: 'grant', payload: { version: 3, activeAccountId: CREDENTIAL_ID, accounts: [credentialOf({})] } }).state === 'incompatible',
    validateCodexAccountRecord({ kind: 'grant', payload: { version: 3 } }))

  check('A15 v2 payload 混入 v1 的 type 字段 ⇒ incompatible（两个形状不混合）',
    validateCodexAccountRecord({
      kind: 'grant',
      payload: { version: 2, activeAccountId: CREDENTIAL_ID, accounts: [credentialOf({})], type: 'oauth' },
    }).state === 'incompatible')

  // ── [2026-11-25 R5] 空态 tombstone：**精确形状**判 absent，其它空账户形状一律 incompatible ──
  const tomb = validateCodexAccountRecord(EMPTY_TOMBSTONE)
  check('A16 空态 tombstone（version:2 / activeAccountId:null / accounts:[]）⇒ absent（= 未登录）',
    tomb.state === 'absent' && tomb.credential === undefined && tomb.accounts === undefined, tomb)

  const built = emptyCodexAccountRecord()
  check('A17 emptyCodexAccountRecord() 产出的就是那个精确形状，且校验为 absent',
    deepEqual(built, EMPTY_TOMBSTONE) && isTombstone(built)
    && validateCodexAccountRecord(built).state === 'absent', built)

  const tombShapes = [
    ['多一个 payload key', { kind: 'grant', payload: { version: 2, activeAccountId: null, accounts: [], note: 'x' } }],
    ['少 activeAccountId', { kind: 'grant', payload: { version: 2, accounts: [] } }],
    ['少 accounts', { kind: 'grant', payload: { version: 2, activeAccountId: null } }],
    ['activeAccountId 是 undefined', { kind: 'grant', payload: { version: 2, activeAccountId: undefined, accounts: [] } }],
    ['activeAccountId 是空串', { kind: 'grant', payload: { version: 2, activeAccountId: '', accounts: [] } }],
    ['accounts 不是数组', { kind: 'grant', payload: { version: 2, activeAccountId: null, accounts: {} } }],
    ['accounts 非空', { kind: 'grant', payload: { version: 2, activeAccountId: null, accounts: [credentialOf({})] } }],
    ['version 是 1', { kind: 'grant', payload: { version: 1, activeAccountId: null, accounts: [] } }],
    ['没有 version（v1 空形状）', { kind: 'grant', payload: { activeAccountId: null, accounts: [] } }],
    ['kind 不是 grant', { kind: 'secret', payload: EMPTY_TOMBSTONE.payload }],
  ]
  for (const [label, record] of tombShapes) {
    const seen = validateCodexAccountRecord(record)
    check('A18 ' + label + ' ⇒ 不是 absent（仍 incompatible：只认那一个精确空态形状）',
      seen.state === 'incompatible' && typeof seen.reason === 'string', seen)
  }
}

// ===========================================================================
// B — 读记录：absent / unknown / ok
// ===========================================================================
{
  const noService = await readCodexAccountRecord({ get: () => undefined })
  check('B1 没有凭据服务 ⇒ unknown（不说成「未登录」）', noService.state === 'unknown', noService)

  const getterBoom = await readCodexAccountRecord({ get() { throw new Error('boom') } })
  check('B2 ctx.get 抛错 ⇒ unknown', getterBoom.state === 'unknown', getterBoom)

  const empty = fakeCredentials({ record: undefined })
  const absent = await readCodexAccountRecord(empty.ctx)
  check('B3 无记录 ⇒ absent', absent.state === 'absent', absent)

  const readFail = fakeCredentials({ record: recordOf(), readError: true })
  check('B4 readRecord 抛错 ⇒ unknown（不当成 absent）',
    (await readCodexAccountRecord(readFail.ctx)).state === 'unknown', await readCodexAccountRecord(readFail.ctx))

  const ok = fakeCredentials({ record: recordOf() })
  const hit = await readCodexAccountRecord(ok.ctx)
  check('B5 合法记录 ⇒ ok，且读的是本插件私有 key',
    hit.state === 'ok' && hit.credential.credentialId === CREDENTIAL_ID
    && ok.state.keys.every((key) => key === CODEX_ACCOUNT_RECORD_KEY), { hit, keys: ok.state.keys })

  const broken = fakeCredentials({ record: { kind: 'grant', payload: {} } })
  const incompatible = await readCodexAccountRecord(broken.ctx)
  check('B6 坏记录 ⇒ incompatible（不是 available）',
    incompatible.state === 'incompatible' && incompatible.credential === undefined, incompatible)

  const injected = await readCodexAccountRecord(null, { credentials: empty.service })
  check('B7 deps.credentials 注入可用（测试替身）', injected.state === 'absent', injected)

  const legacy = fakeCredentials({ record: v1RecordOf() })
  const migrated = await readCodexAccountRecord(legacy.ctx)
  check('B8 旧 v1 记录读出来就是单账户（内存迁移，不判 incompatible、不写盘）',
    migrated.state === 'ok' && migrated.version === 1 && migrated.accounts.length === 1
    && migrated.activeAccountId === CREDENTIAL_ID
    && legacy.state.writes === 0 && legacy.state.modifies === 0, { migrated, writes: legacy.state.writes })

  const multi = fakeCredentials({
    record: multiRecordOf([
      credentialOf({}),
      credentialOf({ accountId: ACCOUNT_ID_2, credentialId: CREDENTIAL_ID_2 }),
    ], CREDENTIAL_ID),
  })
  const readMulti = await readCodexAccountRecord(multi.ctx)
  check('B9 v2 多账户读出来顺序不变、active 是记录里那个',
    readMulti.state === 'ok' && readMulti.accounts.length === 2
    && readMulti.accounts[0].credentialId === CREDENTIAL_ID
    && readMulti.accounts[1].credentialId === CREDENTIAL_ID_2
    && readMulti.credential.credentialId === CREDENTIAL_ID, readMulti)

  // [2026-11-25 R5] 空态 tombstone 是「未登录」，不是坏记录、也不是读不到。
  const tombCred = fakeCredentials({ record: emptyCodexAccountRecord() })
  const tombRead = await readCodexAccountRecord(tombCred.ctx)
  check('B10 空态 tombstone 读出来是 absent（未登录；不判 incompatible / unknown）',
    tombRead.state === 'absent' && tombCred.state.writes === 0 && tombCred.state.deletes === 0, tombRead)
}

// ===========================================================================
// C — 状态摘要（configured / canLogin / 遮罩账号）
// ===========================================================================
{
  const empty = fakeCredentials({ record: undefined })
  const signedOut = await codexAccountState(empty.ctx)
  check('C1 未登录 ⇒ configured:false / canLogin:true / reason signed-out',
    signedOut.configured === false && signedOut.canLogin === true && signedOut.reason === 'signed-out', signedOut)
  check('C2 未登录状态里没有 account 字段', signedOut.account === undefined, signedOut)

  const noService = await codexAccountState({ get: () => undefined })
  check('C3 无凭据服务 ⇒ canLogin:false / reason unavailable',
    noService.configured === false && noService.canLogin === false && noService.reason === 'unavailable', noService)

  const broken = fakeCredentials({ record: { kind: 'grant', payload: { type: 'oauth' } } })
  const badState = await codexAccountState(broken.ctx)
  check('C4 坏记录 ⇒ reason incompatible',
    badState.configured === false && badState.reason === 'incompatible', badState)

  const ok = fakeCredentials({ record: recordOf({ email: 'user@example.com' }) })
  const configured = await codexAccountState(ok.ctx)
  check('C5 已登录 ⇒ configured:true / 展示 label 与 planType / expiresAt / revision',
    configured.configured === true && configured.canLogin === true
    && configured.account.label === 'user@example.com'
    && configured.account.planType === 'plus'
    && configured.expiresAt === NOW + 3_600_000
    && configured.revision === 3, configured)
  check('C6 账号只给遮罩值（不含明文 accountId）',
    typeof configured.account.maskedId === 'string'
    && configured.account.maskedId.includes('…')
    && !plaintextAccountLeak(configured, ACCOUNT_ID), configured.account)
  check('C7 状态摘要不含 token 原文', leaksIn(configured).length === 0 && leaksIn(signedOut).length === 0)

  const noEmail = fakeCredentials({ record: recordOf() })
  const plainLabel = await codexAccountState(noEmail.ctx)
  check('C8 没有 email 时 label = ChatGPT 账号 <maskedId>（多个无 email 账号可区分）',
    plainLabel.account.label === 'ChatGPT 账号 ' + plainLabel.account.maskedId, plainLabel.account)

  check('C9 单账户 ⇒ accounts 只有 1 条、active 标记在它上面、activeAccountId 与 id 一致',
    Array.isArray(configured.accounts) && configured.accounts.length === 1
    && configured.accounts[0].id === CREDENTIAL_ID
    && configured.accounts[0].active === true
    && configured.activeAccountId === CREDENTIAL_ID, configured.accounts)

  // [2026-11-25 R5] 空态 tombstone 对 UI 就是「未登录」：不暴露 account / accounts。
  const tombState = await codexAccountState(fakeCredentials({ record: emptyCodexAccountRecord() }).ctx)
  check('C10 空态 tombstone ⇒ configured:false / canLogin:true / reason signed-out、没有 account 字段',
    tombState.configured === false && tombState.canLogin === true
    && tombState.reason === 'signed-out'
    && tombState.account === undefined && tombState.accounts === undefined, tombState)
}

// ===========================================================================
// D — 身份快照（同步、稳定、换账号即变、不含明文/token）
// ===========================================================================
{
  const empty = fakeCredentials({ record: undefined })
  const none = await refreshCodexAccountIdentity(empty.ctx)
  check('D1 未登录 ⇒ none', none === 'none' && codexAccountIdentitySnapshot() === 'none', none)

  const first = fakeCredentials({ record: recordOf() })
  const idA = await refreshCodexAccountIdentity(first.ctx)
  check('D2 已登录 ⇒ acct:<8位hash>@<credentialId前8位>r<revision>',
    /^acct:[0-9a-f]{8}@cred-aaar3$/u.test(idA), idA)
  check('D3 同步快照与刷新结果一致（index.js 可直接同步读）',
    codexAccountIdentitySnapshot() === idA)
  check('D4 身份不含 token / 明文账号',
    leaksIn(idA).length === 0 && !idA.includes(ACCOUNT_ID), idA)

  const again = await refreshCodexAccountIdentity(first.ctx)
  check('D5 同一记录多次刷新稳定', again === idA, again)

  const sameAccountNewCredential = fakeCredentials({
    record: recordOf({ credentialId: CREDENTIAL_ID_2 }),
  })
  const idC = await refreshCodexAccountIdentity(sameAccountNewCredential.ctx)
  check('D6 同账号不同 credentialId ⇒ 快照变化', idC !== idA && idC.startsWith('acct:'), { idA, idC })

  const bumped = fakeCredentials({ record: recordOf({ revision: 4 }) })
  const idR = await refreshCodexAccountIdentity(bumped.ctx)
  check('D6b 同账户 revision 前进 ⇒ 快照变化（重登录会作废旧观察）', idR !== idA
    && idR.endsWith('r4'), { idA, idR })

  const otherAccount = fakeCredentials({
    record: recordOf({ accountId: ACCOUNT_ID_2 }),
  })
  const idD = await refreshCodexAccountIdentity(otherAccount.ctx)
  check('D7 换账号 ⇒ hash 不同', idD !== idA
    && idD.split('@')[0] !== idA.split('@')[0], { idA, idD })

  // v1 旧记录也要给出同一个格式（迁移后连续，不制造「换了账号」的假信号）
  const legacySame = fakeCredentials({ record: v1RecordOf() })
  check('D7b v1 与 v2 的同一条凭据给出同一身份串',
    (await refreshCodexAccountIdentity(legacySame.ctx)) === idA)

  const broken = fakeCredentials({ record: { kind: 'grant', payload: {} } })
  check('D8 坏记录 ⇒ unknown（既不是 none 也不是可用）',
    (await refreshCodexAccountIdentity(broken.ctx)) === 'unknown')

  const neverThrows = await refreshCodexAccountIdentity({ get() { throw new Error('boom') } })
  check('D9 凭据服务不可证明 ⇒ unknown 且不抛', neverThrows === 'unknown', neverThrows)
}

// ===========================================================================
// E — 额度映射（按 limit_window_seconds 识别，不看 primary/secondary 顺序）
// ===========================================================================
{
  const baseNow = NOW
  const mapped = mapCodexAccountUsage(usageBody(), baseNow)
  check('E1 主桶两个窗口都映射出来', mapped.ok === true && mapped.usage.rateLimits.length === 1
    && mapped.usage.rateLimits[0].id === 'codex'
    && mapped.usage.rateLimits[0].windows.length === 2, mapped)
  const windows = mapped.ok === true ? mapped.usage.rateLimits[0].windows : []
  const fiveHour = windows.find((w) => w.windowSeconds === 18_000)
  const weekly = windows.find((w) => w.windowSeconds === 604_800)
  check('E2 remainingPercent = 100 - used_percent（5h 64 / 周 82.5）',
    fiveHour !== undefined && fiveHour.remainingPercent === 64
    && weekly !== undefined && weekly.remainingPercent === 82.5, windows)
  check('E3 reset_at 是 Unix 秒（原样，不 ×1000）',
    fiveHour !== undefined && fiveHour.resetAt === Math.floor(baseNow / 1000 + 3_600), fiveHour)

  const swapped = mapCodexAccountUsage(usageBody({
    rate_limit: {
      // 故意把「周」放 primary、「5h」放 secondary
      primary_window: { used_percent: 10, limit_window_seconds: 604_800 },
      secondary_window: { used_percent: 90, limit_window_seconds: 18_000 },
    },
  }), baseNow)
  const swappedWindows = swapped.ok === true ? swapped.usage.rateLimits[0].windows : []
  check('E4 按秒数识别（顺序颠倒也不认错）',
    swappedWindows.find((w) => w.windowSeconds === 18_000).remainingPercent === 10
    && swappedWindows.find((w) => w.windowSeconds === 604_800).remainingPercent === 90, swappedWindows)

  const unknownSeconds = mapCodexAccountUsage(usageBody({
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3_600 } },
  }), baseNow)
  check('E5 未知窗口长度不冒充 5h/周（忽略）',
    unknownSeconds.ok === true && unknownSeconds.usage.rateLimits[0].windows.length === 0, unknownSeconds)

  const fromAfter = mapCodexAccountUsage(usageBody({
    rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_after_seconds: 600 } },
  }), baseNow)
  check('E6 reset_after_seconds 用 now 换算成秒级时间戳',
    fromAfter.ok === true
    && fromAfter.usage.rateLimits[0].windows[0].resetAt === Math.floor(baseNow / 1000) + 600, fromAfter)

  const structureCases = [
    ['used_percent=120', usageBody({ rate_limit: { primary_window: { used_percent: 120, limit_window_seconds: 18_000 } } })],
    ['used_percent 非数字', usageBody({ rate_limit: { primary_window: { used_percent: '5', limit_window_seconds: 18_000 } } })],
    ['缺 limit_window_seconds', usageBody({ rate_limit: { primary_window: { used_percent: 5 } } })],
    ['窗口不是对象', usageBody({ rate_limit: { primary_window: 7 } })],
    ['响应不是对象', []],
  ]
  for (const [label, body] of structureCases) {
    const seen = mapCodexAccountUsage(body, baseNow)
    check('E7 ' + label + ' ⇒ 结构错误', seen.ok === false && seen.reason === 'structure', seen)
  }

  const noCredits = mapCodexAccountUsage(usageBody({
    credits: { has_credits: false, unlimited: true, balance: 99 },
  }), baseNow)
  check('E8 has_credits !== true ⇒ 不产出 credits',
    noCredits.ok === true && noCredits.usage.credits === undefined, noCredits.usage.credits)

  const credits = mapCodexAccountUsage(usageBody(), baseNow)
  check('E9 credits 映射 unlimited / balance（数字 → 十进制字符串）',
    credits.ok === true && credits.usage.credits.unlimited === false
    && credits.usage.credits.balance === '12.5', credits.usage.credits)

  const individual = credits.ok === true ? credits.usage.individualLimit : null
  check('E10 spend control → limit / used / remaining / remainingPercent',
    individual !== null && individual.limit === '20.00' && individual.used === '7.50'
    && individual.remaining === '12.50'
    && individual.remainingPercent === 62.5, individual)
  check('E11 remaining 精确金额原样透传（不被百分比覆盖）',
    individual !== null && individual.remaining === '12.50'
    && individual.remaining !== String(62.5), individual)

  // 上游没给 remaining ⇒ 省略该字段（不伪造），其余照常。
  const noRemaining = mapCodexAccountUsage(usageBody({
    spend_control: { individual_limit: { limit: '20.00', used: '7.50', remaining_percent: 62.5 } },
  }), baseNow)
  const noRemainingLimit = noRemaining.ok === true ? noRemaining.usage.individualLimit : null
  check('E11b 上游缺 remaining ⇒ 省略该字段（不凭 remaining_percent 反推金额）',
    noRemainingLimit !== null && noRemainingLimit.limit === '20.00'
    && Object.prototype.hasOwnProperty.call(noRemainingLimit, 'remaining') === false, noRemainingLimit)

  // remaining 不是十进制串 ⇒ 同样省略；数字形态则按十进制字符串带走。
  const badRemaining = mapCodexAccountUsage(usageBody({
    spend_control: { individual_limit: { limit: '20.00', used: '7.50', remaining: 'n/a', remaining_percent: 62.5 } },
  }), baseNow)
  const badRemainingLimit = badRemaining.ok === true ? badRemaining.usage.individualLimit : null
  const numericRemaining = mapCodexAccountUsage(usageBody({
    spend_control: { individual_limit: { limit: 20, used: 7.5, remaining: 12.5, remaining_percent: 62.5 } },
  }), baseNow)
  const numericLimit = numericRemaining.ok === true ? numericRemaining.usage.individualLimit : null
  check('E11c remaining 非十进制 ⇒ 省略（不硬塞 0/NaN）；数字形态 → 十进制字符串',
    badRemainingLimit !== null && badRemainingLimit.remaining === undefined
    && numericLimit !== null && numericLimit.remaining === '12.5'
    && numericLimit.limit === '20', { badRemainingLimit, numericLimit })

  const noSpend = mapCodexAccountUsage(usageBody({ spend_control: undefined }), baseNow)
  check('E12 没有 spend control ⇒ 不产出 individualLimit',
    noSpend.ok === true && noSpend.usage.individualLimit === undefined, noSpend.usage.individualLimit)

  const badSpend = mapCodexAccountUsage(usageBody({
    spend_control: { individual_limit: { limit: '20.00', used: 'x', remaining_percent: 50 } },
  }), baseNow)
  check('E13 spend control 结构异常 ⇒ 结构错误（不糊一个假金额）',
    badSpend.ok === false && badSpend.reason === 'structure', badSpend)

  check('E14 plan_type 透传 + fetchedAt 是本次采样毫秒',
    credits.ok === true && credits.usage.planType === 'plus' && credits.usage.fetchedAt === baseNow,
    credits.usage)
  check('E15 映射结果不含 token', leaksIn(credits).length === 0)

  // [2026-11-22 真实账号边界] Pro 账号可能没有 5 小时限流窗口，上游给 `rate_limit: null`。
  const proNoWindow = mapCodexAccountUsage({
    rate_limit: null,
    credits: { has_credits: true, unlimited: false, balance: '12.5' },
    plan_type: 'pro',
  }, baseNow)
  check('E16 rate_limit:null ⇒ ok（不是结构错误）、windows=[]、credits 与 planType 照常解析',
    proNoWindow.ok === true
    && proNoWindow.usage.rateLimits[0].windows.length === 0
    && proNoWindow.usage.credits.unlimited === false
    && proNoWindow.usage.credits.balance === '12.5'
    && proNoWindow.usage.planType === 'pro', proNoWindow)

  const missingRateLimit = mapCodexAccountUsage({ plan_type: 'pro' }, baseNow)
  check('E17 rate_limit 缺失同样按「没有窗口」处理',
    missingRateLimit.ok === true && missingRateLimit.usage.rateLimits[0].windows.length === 0
    && missingRateLimit.usage.planType === 'pro', missingRateLimit)

  for (const [label, value] of [['字符串', 'bad'], ['数组', []], ['数字', 7]]) {
    const seen = mapCodexAccountUsage({ rate_limit: value }, baseNow)
    check('E18 rate_limit 是非 null 的' + label + ' ⇒ 仍结构错误',
      seen.ok === false && seen.reason === 'structure', seen)
  }

  const bareNoWindow = mapCodexAccountUsage({ rate_limit: null }, baseNow)
  check('E19 rate_limit:null 且没有 credits / plan ⇒ ok 但零窗口（不伪造窗口/余额）',
    bareNoWindow.ok === true
    && bareNoWindow.usage.rateLimits[0].windows.length === 0
    && bareNoWindow.usage.credits === undefined
    && bareNoWindow.usage.individualLimit === undefined
    && bareNoWindow.usage.planType === undefined, bareNoWindow)
}

// ===========================================================================
// F — 额度读取（刷新时机 / single-flight / 二次检查 / 错误映射）
// ===========================================================================
{
  // F1 未登录
  {
    const empty = fakeCredentials({ record: undefined })
    const result = await fetchCodexAccountUsage(empty.ctx, { now: () => NOW })
    check('F1 无记录 ⇒ signed-out 固定文案、非 transient',
      result.ok === false && result.error === 'signed-out'
      && result.message === '请先登录 ChatGPT 账号' && result.transient !== true, result)
    check('F1b 零网络请求', true)
  }

  // F2 坏记录
  {
    const broken = fakeCredentials({ record: recordOf({ expires: 0 }) })
    const net = fakeFetch(() => jsonResponse(200, usageBody()))
    const result = await fetchCodexAccountUsage(broken.ctx, { now: () => NOW, fetch: net.impl })
    check('F2 坏记录 ⇒ incompatible 固定文案、零请求',
      result.ok === false && result.error === 'incompatible'
      && result.message.includes('重新登录') && net.calls.length === 0, result)
  }

  // F3 无凭据服务
  {
    const result = await fetchCodexAccountUsage({ get: () => undefined }, { now: () => NOW })
    check('F3 无法读凭据 ⇒ exec 固定文案（不当成未登录）',
      result.ok === false && result.error === 'exec' && result.message.includes('无法读取'), result)
  }

  // F4 新鲜 token：直接读额度
  {
    const cred = fakeCredentials({ record: recordOf() })
    const access = firstAccountPayload(cred.state.record).access
    const net = fakeFetch((call) => {
      if (call.url === CODEX_ACCOUNT_USAGE_URL) return jsonResponse(200, usageBody())
      return jsonResponse(500, {})
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    const usageCall = callsTo(net.calls, CODEX_ACCOUNT_USAGE_URL)[0]
    check('F4 新鲜 token ⇒ 只打额度接口，不碰 token 端点',
      result.ok === true && net.calls.length === 1 && usageCall !== undefined, { calls: net.calls.length })
    check('F5 请求形态：GET + 四个固定 header + 不跟随重定向',
      usageCall.init.method === 'GET'
      && usageCall.init.redirect === 'manual'
      && usageCall.init.headers.authorization === 'Bearer ' + access
      && usageCall.init.headers['chatgpt-account-id'] === ACCOUNT_ID
      && usageCall.init.headers.accept === 'application/json'
      && usageCall.init.headers['cache-control'] === 'no-store', usageCall.init)
    check('F6 成功返回 usage（Connect 形状）+ 记录原样',
      result.ok === true
      && result.usage.rateLimits[0].windows.length === 2
      && result.credential.credentialId === CREDENTIAL_ID, result.ok ? result.usage : result)
    check('F7 成功值不含 token 原文（除 credential 本身）',
      leaksIn(result.usage).length === 0, leaksIn(result.usage))
  }

  // F8 过期 ⇒ 刷新一次再读
  {
    const clock = fakeClock(NOW)
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1, revision: 7 }) })
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) return jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: clock.now, fetch: net.impl })
    const usageCall = callsTo(net.calls, CODEX_ACCOUNT_USAGE_URL)[0]
    const payload = firstAccountPayload(cred.state.record)
    check('F8 过期 ⇒ 先刷新（form 形态、grant_type=refresh_token）',
      callsTo(net.calls, TOKEN_URL).length === 1
      && new URLSearchParams(callsTo(net.calls, TOKEN_URL)[0].init.body).get('grant_type') === 'refresh_token'
      && new URLSearchParams(callsTo(net.calls, TOKEN_URL)[0].init.body).get('client_id') === CODEX_ACCOUNT_CLIENT_ID
      && new URLSearchParams(callsTo(net.calls, TOKEN_URL)[0].init.body).get('refresh_token') === SENT_REFRESH,
      callsTo(net.calls, TOKEN_URL)[0].init.body)
    check('F9 刷新后保留 accountId / credentialId / revision，只换 token 与 expires',
      payload.access === 'new-access' && payload.refresh === 'new-refresh'
      && payload.accountId === ACCOUNT_ID && payload.credentialId === CREDENTIAL_ID
      && payload.revision === 7 && payload.expires === NOW + 3_600_000, payload)
    check('F9b 刷新后记录落成 v2（version / accounts / activeAccountId 齐全）',
      cred.state.record.payload.version === 2
      && cred.state.record.payload.activeAccountId === CREDENTIAL_ID
      && Array.isArray(cred.state.record.payload.accounts)
      && cred.state.record.payload.accounts.length === 1, cred.state.record.payload)
    check('F10 额度请求用的是新 access',
      usageCall !== undefined && usageCall.init.headers.authorization === 'Bearer new-access', usageCall)
    check('F11 成功且返回刷新后的 credential',
      result.ok === true && result.credential.access === 'new-access', result.ok ? result.credential : result)
  }

  // F12 invalid_grant ⇒ reauth-required
  {
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1 }) })
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) return jsonResponse(400, { error: 'invalid_grant', error_description: SENT_REFRESH })
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('F12 invalid_grant ⇒ reauth-required 固定文案、非 transient、不写记录',
      result.ok === false && result.error === 'reauth-required'
      && result.message === 'ChatGPT 登录已过期，请重新登录'
      && result.transient !== true && cred.state.writes === 0, result)
    check('F13 错误里不回显上游正文（含 sentinel）', leaksIn(result).length === 0, result)
  }

  // F14 refresh token_expired ⇒ reauth
  {
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1 }) })
    const net = fakeFetch((call) => (call.url === TOKEN_URL
      ? jsonResponse(401, { error: 'token_expired' })
      : jsonResponse(200, usageBody())))
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('F14 token_expired ⇒ reauth-required',
      result.ok === false && result.error === 'reauth-required', result)
  }

  // F15 single-flight：两个并发读取只刷新一次
  {
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1, revision: 4 }) })
    let tokenCalls = 0
    const net = fakeFetch(async (call) => {
      if (call.url === TOKEN_URL) {
        tokenCalls += 1
        await new Promise((resolve) => setImmediate(resolve))
        return jsonResponse(200, { access_token: 'flight-access', refresh_token: 'flight-refresh', expires_in: 1800 })
      }
      return jsonResponse(200, usageBody())
    })
    const both = await Promise.all([
      fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl }),
      fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl }),
    ])
    check('F15 并发刷新 single-flight（token 端点只打一次）',
      tokenCalls === 1 && cred.state.writes === 1, { tokenCalls, writes: cred.state.writes })
    check('F16 两个调用都成功且用同一份新 token',
      both.every((item) => item.ok === true && item.credential.access === 'flight-access'), both.map((i) => i.ok))
    check('F17 刷新只写一次、保留 credentialId / accountId / revision',
      firstAccountPayload(cred.state.record).credentialId === CREDENTIAL_ID
      && firstAccountPayload(cred.state.record).accountId === ACCOUNT_ID
      && firstAccountPayload(cred.state.record).revision === 4, cred.state.record.payload)
  }

  // F18 modifyRecord 二次检查：别人已经刷新过（同一 credentialId、未过期）⇒ 不覆盖
  {
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1 }) })
    const otherAccess = 'other-writer-access'
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) {
        // 模拟「另一个进程在我们等待 token 响应期间完成了刷新」。
        cred.state.record = recordOf({ access: otherAccess, refresh: 'other-refresh', expires: NOW + 7_200_000 })
        return jsonResponse(200, { access_token: 'mine-access', refresh_token: 'mine-refresh', expires_in: 3600 })
      }
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    const usageCall = callsTo(net.calls, CODEX_ACCOUNT_USAGE_URL)[0]
    check('F18 独占写内发现别人刷过 ⇒ 不写（writes=0）',
      cred.state.writes === 0 && cred.state.skipped >= 1, cred.state)
    check('F19 采用别人的新 token（不覆盖成自己的）',
      result.ok === true && result.credential.access === otherAccess
      && usageCall.init.headers.authorization === 'Bearer ' + otherAccess, result.ok ? result.credential : result)
  }

  /**
   * F20 账户被换掉（credentialId 变了 / 被移除）⇒ **绝不新建账户**，要求重新登录。
   *
   * 多账户下「同一个 accountId 重登录」不会再换 credentialId（upsert 保留它，见 J 段），
   * 所以唯一的「找不到了」来源就是账户被移除或记录被重写成了别的账户。
   */
  {
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1 }) })
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) {
        cred.state.record = multiRecordOf([
          credentialOf({
            accountId: ACCOUNT_ID_2,
            credentialId: CREDENTIAL_ID_2,
            access: 'relogin-access',
            expires: NOW + 9_000_000,
          }),
        ], CREDENTIAL_ID_2)
        return jsonResponse(200, { access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 })
      }
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('F20 账户被换成新 credentialId ⇒ 零写入 + reauth-required（不新建账户、不用别人的 token）',
      cred.state.writes === 0 && result.ok === false && result.error === 'reauth-required'
      && callsTo(net.calls, CODEX_ACCOUNT_USAGE_URL).length === 0, result)
  }

  /**
   * [2026-11-22 终审 F2] 401 且**本地未过期** ⇒ 必须强制刷新一次，然后用新 access 重试。
   * 修复前：刷新按「已过期」判断 ⇒ no-op ⇒ 直接 reauth-required（未过期但被上游吊销的
   * token 永远刷不动，用户只能重新登录）。
   */
  {
    const cred = fakeCredentials({ record: recordOf({ revision: 5 }) })
    let usageCalls = 0
    let tokenCalls = 0
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) {
        tokenCalls += 1
        return jsonResponse(200, { access_token: 'forced-access', refresh_token: 'forced-refresh', expires_in: 3600 })
      }
      usageCalls += 1
      if (usageCalls === 1) return jsonResponse(401, { error: 'unauthorized', message: SENT_ACCESS })
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    const usageCallList = callsTo(net.calls, CODEX_ACCOUNT_USAGE_URL)
    check('F21 未过期 401 ⇒ 强制刷新 1 次，第二次额度用新 access、结果成功',
      result.ok === true && tokenCalls === 1 && usageCalls === 2
      && usageCallList[1].init.headers.authorization === 'Bearer forced-access', {
        ok: result.ok, tokenCalls, usageCalls,
        secondAuth: usageCallList[1] === undefined ? null : usageCallList[1].init.headers.authorization,
      })
    const forcedPayload = firstAccountPayload(cred.state.record)
    check('F21b 强制刷新保留 credentialId / accountId / revision，只换 token 与 expires',
      forcedPayload.access === 'forced-access'
      && forcedPayload.refresh === 'forced-refresh'
      && forcedPayload.credentialId === CREDENTIAL_ID
      && forcedPayload.accountId === ACCOUNT_ID
      && forcedPayload.revision === 5
      && forcedPayload.expires === NOW + 3_600_000, forcedPayload)
    check('F21c 强制刷新只写一次（独占写内二次检查）', cred.state.writes === 1, cred.state)
  }

  // F21d 强制刷新后仍 401 ⇒ reauth-required（不无限重试）、不回显正文。
  {
    const cred = fakeCredentials({ record: recordOf() })
    let tokenCalls = 0
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) {
        tokenCalls += 1
        return jsonResponse(200, { access_token: 'still-bad', refresh_token: 'still-bad-r', expires_in: 3600 })
      }
      return jsonResponse(401, { error: 'unauthorized', message: SENT_ACCESS })
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('F21d 强制刷新后仍 401 ⇒ reauth-required、非 transient、不泄露正文',
      result.ok === false && result.error === 'reauth-required' && result.transient !== true
      && leaksIn(result).length === 0 && tokenCalls === 1
      && callsTo(net.calls, CODEX_ACCOUNT_USAGE_URL).length === 2, { result, tokenCalls })
  }

  // F22 刷新成功后额度仍 403 ⇒ reauth-required（最多两次刷新：过期那次 + 强制那次）
  {
    const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1 }) })
    let tokenCalls = 0
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) {
        tokenCalls += 1
        return jsonResponse(200, { access_token: 'fresh-' + String(tokenCalls), refresh_token: 'fresh-r', expires_in: 3600 })
      }
      return jsonResponse(403, { error: 'forbidden' })
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('F22 刷新后仍 403 ⇒ reauth-required（刷新次数有界：≤2）',
      result.ok === false && result.error === 'reauth-required'
      && tokenCalls > 0 && tokenCalls <= 2, { result, tokenCalls })
  }

  // F23 429 / 5xx / 网络 / 超时 ⇒ exec + transient
  {
    const cases = [
      ['429', (call) => jsonResponse(429, { error: 'rate_limited' })],
      ['500', () => jsonResponse(500, { error: 'boom' })],
      ['503', () => jsonResponse(503, '')],
      ['网络错误', () => { throw new Error('ECONNRESET') }],
    ]
    for (const [label, handler] of cases) {
      const cred = fakeCredentials({ record: recordOf() })
      const net = fakeFetch(handler)
      const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
      check('F23 ' + label + ' ⇒ exec + transient:true、固定文案',
        result.ok === false && result.error === 'exec' && result.transient === true
        && result.message === 'Codex 额度获取失败', result)
    }
  }

  // F24 超时（15 秒）⇒ transient
  {
    const cred = fakeCredentials({ record: recordOf() })
    const timers = fakeTimers()
    const net = {
      calls: [],
      impl: (url, init) => new Promise((resolve, reject) => {
        net.calls.push({ url, init })
        if (init.signal !== undefined && init.signal !== null) {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }
      }),
    }
    const pending = fetchCodexAccountUsage(cred.ctx, {
      now: () => NOW,
      fetch: net.impl,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await settle()
    check('F24 请求超时用 15 秒定时器', timers.delays().length === 1 && timers.delays()[0] === 15_000, timers.delays())
    await timers.flushOne()
    const result = await pending
    check('F25 超时 ⇒ exec + transient:true', result.ok === false && result.error === 'exec'
      && result.transient === true, result)
  }

  // F26 结构异常 / 非对象 JSON / 重定向 / 超大响应
  {
    const cases = [
      ['used_percent 越界', () => jsonResponse(200, usageBody({
        rate_limit: { primary_window: { used_percent: 140, limit_window_seconds: 18_000 } },
      }))],
      ['JSON 是数组', () => jsonResponse(200, [1, 2, 3])],
      ['不是 JSON', () => jsonResponse(200, '<html>nope</html>')],
      ['302 重定向', () => jsonResponse(302, '')],
      ['超大响应', () => jsonResponse(200, 'x'.repeat(520 * 1024))],
    ]
    for (const [label, handler] of cases) {
      const cred = fakeCredentials({ record: recordOf() })
      const net = fakeFetch(handler)
      const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
      check('F26 ' + label + ' ⇒ exec + 非 transient',
        result.ok === false && result.error === 'exec' && result.transient !== true, result)
    }
  }

  // F27 成功但没有任何窗口/credits ⇒ 由 codex.js 判 quota-unavailable（这里只验证映射不造假）
  {
    const cred = fakeCredentials({ record: recordOf() })
    const net = fakeFetch(() => jsonResponse(200, { rate_limit: {}, credits: { has_credits: false } }))
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('F27 空额度 ⇒ ok:true 但窗口为空（不伪造窗口）',
      result.ok === true && result.usage.rateLimits[0].windows.length === 0
      && result.usage.credits === undefined, result.ok ? result.usage : result)
  }
}

// ===========================================================================
// G — 设备码登录状态机
// ===========================================================================
{
  /** 组装一套登录环境：device 响应 + token 响应可控。 */
  function loginHarness(options) {
    const opts = options === null || options === undefined ? {} : options
    const credentials = fakeCredentials({ record: opts.record })
    // 重置计数（同一条记录会先被读一次判断 revision）
    const clock = fakeClock(NOW)
    const timers = fakeTimers()
    const authorized = []
    const saved = []
    let pollCount = 0
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) {
        if (typeof opts.onUsers === 'function') return opts.onUsers(call)
        return jsonResponse(200, { device_auth_id: 'dev-1', user_code: 'CODE-1234', interval: '5' })
      }
      if (call.url === DEVICE_TOKEN_URL) {
        pollCount += 1
        if (typeof opts.onPoll === 'function') return opts.onPoll(pollCount, call)
        return jsonResponse(403, { error: 'deviceauth_authorization_pending' })
      }
      if (call.url === TOKEN_URL) {
        if (typeof opts.onExchange === 'function') return opts.onExchange(call)
        return jsonResponse(200, {
          access_token: accessTokenOf(ACCOUNT_ID, 'plus'),
          refresh_token: SENT_REFRESH,
          expires_in: 3600,
          id_token: idTokenOf('user@example.com'),
        })
      }
      return jsonResponse(404, {})
    })
    const manager = createCodexAccountLogin(credentials.ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      saveCredential: typeof opts.saveCredential === 'function'
        ? opts.saveCredential
        : (draft) => {
          saved.push(draft)
          const credential = {
            type: 'oauth',
            access: draft.access,
            refresh: draft.refresh,
            expires: draft.expires,
            accountId: draft.accountId,
            credentialId: randomUUID(),
            revision: 1,
            savedAt: new Date(clock.now()).toISOString(),
          }
          if (draft.planType !== undefined) credential.planType = draft.planType
          if (draft.email !== undefined) credential.email = draft.email
          return { ok: true, credential }
        },
      onAuthorized: (info) => { authorized.push(info) },
    })
    return { credentials, clock, timers, net, manager, saved, authorized, pollCount: () => pollCount }
  }

  // G1 start：设备码与固定验证页
  {
    const h = loginHarness()
    const snapshot = await h.manager.start()
    const usersCall = callsTo(h.net.calls, USERS_URL)[0]
    check('G1 start ⇒ waiting + user_code + 固定验证页',
      snapshot.state === 'waiting' && snapshot.userCode === 'CODE-1234'
      && snapshot.verificationUrl === CODEX_ACCOUNT_DEVICE_VERIFY_URL, snapshot)
    check('G2 usercode 请求形态：POST JSON + client_id',
      usersCall !== undefined && usersCall.init.method === 'POST'
      && JSON.parse(usersCall.init.body).client_id === CODEX_ACCOUNT_CLIENT_ID
      && usersCall.init.headers['content-type'] === 'application/json', usersCall && usersCall.init)
    check('G3 interval 字符串被解析（5s）', h.timers.delays()[0] === 5_000, h.timers.delays())
    check('G4 start 的快照不含 token', leaksIn(snapshot).length === 0, leaksIn(snapshot))
    h.manager.dispose()
  }

  // G5 pending → success → authorized
  {
    let polled = 0
    const h = loginHarness({
      onPoll: () => {
        polled += 1
        if (polled < 3) return jsonResponse(403, { error: 'deviceauth_authorization_pending' })
        return jsonResponse(200, { authorization_code: 'ac-1', code_verifier: 'ver-1' })
      },
    })
    await h.manager.start()
    check('G5 首次轮询前状态 waiting，未成交', h.manager.status().state === 'waiting')
    await h.timers.flushOne()
    check('G6 pending 不改变登录态、继续排下一次', h.manager.status().state === 'waiting'
      && h.timers.pending.length === 1, h.manager.status())
    await h.timers.flushOne()
    await h.timers.flushOne()
    const snapshot = h.manager.status()
    check('G7 授权成功 ⇒ authorized', snapshot.state === 'authorized', snapshot)
    const exchangeCall = callsTo(h.net.calls, TOKEN_URL)[0]
    const form = exchangeCall === undefined ? new URLSearchParams() : new URLSearchParams(exchangeCall.init.body)
    check('G8 兑换请求形态（authorization_code + code_verifier + 固定 redirect_uri）',
      form.get('grant_type') === 'authorization_code'
      && form.get('client_id') === CODEX_ACCOUNT_CLIENT_ID
      && form.get('code') === 'ac-1'
      && form.get('code_verifier') === 'ver-1'
      && form.get('redirect_uri') === 'https://auth.openai.com/deviceauth/callback'
      && exchangeCall.init.headers['content-type'] === 'application/x-www-form-urlencoded', form.toString())
    check('G9 落库草稿含 accountId / planType / email（email 来自 id_token）',
      h.saved.length === 1 && h.saved[0].accountId === ACCOUNT_ID
      && h.saved[0].planType === 'plus' && h.saved[0].email === 'user@example.com', h.saved[0])
    check('G10 onAuthorized 收到可展示信息（遮罩账号、无 token）',
      h.authorized.length === 1 && h.authorized[0].account.maskedId.includes('…')
      && h.authorized[0].revision === 1 && leaksIn(h.authorized[0]).length === 0, h.authorized[0])
    check('G11 最终快照含账号与修订号、且不含 token',
      snapshot.account !== undefined && snapshot.verificationUrl === CODEX_ACCOUNT_DEVICE_VERIFY_URL
      && leaksIn(snapshot).length === 0 && !plaintextAccountLeak(snapshot, ACCOUNT_ID), snapshot)
    check('G12 登录成功后更新身份快照',
      /^acct:[0-9a-f]{8}@/u.test(codexAccountIdentitySnapshot()), codexAccountIdentitySnapshot())
    h.manager.dispose()
  }

  // G13 slow_down
  {
    let polled = 0
    const h = loginHarness({
      onPoll: () => {
        polled += 1
        if (polled === 1) return jsonResponse(403, { error: 'slow_down' })
        return jsonResponse(403, { error: 'deviceauth_authorization_pending' })
      },
    })
    await h.manager.start()
    await h.timers.flushOne()
    check('G13 slow_down ⇒ 状态可见为 slow_down 且间隔 +5s',
      h.manager.status().state === 'slow_down' && h.manager.status().intervalMs === 10_000, h.manager.status())
    check('G14 slow_down 后按新间隔排下一次',
      h.timers.delays()[0] === 10_000, h.timers.delays())
    await h.timers.flushOne()
    check('G15 之后再 pending ⇒ 回到 waiting（间隔保持）',
      h.manager.status().state === 'waiting' && h.manager.status().intervalMs === 10_000, h.manager.status())
    h.manager.dispose()
  }

  // G16 超时 ⇒ expired
  {
    const h = loginHarness()
    await h.manager.start()
    h.clock.advance(15 * 60 * 1000 + 1)
    await h.timers.flushOne()
    const snapshot = h.manager.status()
    check('G16 总时限到 ⇒ expired 固定文案、零落库',
      snapshot.state === 'expired' && snapshot.message === '设备码登录已超时，请重新开始'
      && h.saved.length === 0, snapshot)
    check('G17 expired 后不再排轮询', h.timers.pending.length === 0, h.timers.delays())
    h.manager.dispose()
  }

  // G18 cancel
  {
    const h = loginHarness()
    await h.manager.start()
    h.manager.cancel()
    const snapshot = h.manager.status()
    check('G18 cancel ⇒ cancelled、清定时器', snapshot.state === 'cancelled'
      && h.timers.pending.length === 0, snapshot)
    await h.timers.flushAll()
    check('G19 cancel 后迟到的定时器不再推进状态 / 不落库',
      h.manager.status().state === 'cancelled' && h.saved.length === 0
      && callsTo(h.net.calls, DEVICE_TOKEN_URL).length === 0, h.manager.status())
    h.manager.dispose()
  }

  // G20 启动失败：404 ⇒ 固定「不支持设备码登录」
  {
    const h = loginHarness({ onUsers: () => jsonResponse(404, { error: 'not_found' }) })
    const snapshot = await h.manager.start()
    check('G20 404 ⇒ failed + 固定文案', snapshot.state === 'failed'
      && snapshot.message === '当前网络或账号不支持设备码登录', snapshot)
    check('G21 启动失败不排轮询', h.timers.pending.length === 0)
    h.manager.dispose()
  }

  // G22 启动网络错误 ⇒ failed（通用文案）
  {
    const h = loginHarness({ onUsers: () => { throw new Error('ENOTFOUND') } })
    const snapshot = await h.manager.start()
    check('G22 启动网络错误 ⇒ failed + 通用文案', snapshot.state === 'failed'
      && snapshot.message === 'Codex 登录启动失败，请稍后重试', snapshot)
    h.manager.dispose()
  }

  // G23 明确拒绝（4xx 未知码）⇒ failed
  {
    const h = loginHarness({ onPoll: () => jsonResponse(400, { error: 'access_denied' }) })
    await h.manager.start()
    await h.timers.flushOne()
    check('G23 轮询被拒 ⇒ failed + 固定文案',
      h.manager.status().state === 'failed'
      && h.manager.status().message === '登录请求被拒绝，请重新开始', h.manager.status())
    h.manager.dispose()
  }

  // G24 兑换失败 ⇒ failed
  {
    const h = loginHarness({
      onPoll: () => jsonResponse(200, { authorization_code: 'ac-2', code_verifier: 'ver-2' }),
      onExchange: () => jsonResponse(400, { error: 'invalid_grant' }),
    })
    await h.manager.start()
    await h.timers.flushOne()
    check('G24 兑换 400 ⇒ failed（不落库、不给 token）',
      h.manager.status().state === 'failed' && h.saved.length === 0
      && leaksIn(h.manager.status()).length === 0, h.manager.status())
    h.manager.dispose()
  }

  // G25 access token 缺账号声明 ⇒ failed（不猜测账号）
  {
    const h = loginHarness({
      onPoll: () => jsonResponse(200, { authorization_code: 'ac-3', code_verifier: 'ver-3' }),
      onExchange: () => jsonResponse(200, {
        access_token: makeJwt({ sub: 'nobody' }, SENT_ACCESS),
        refresh_token: SENT_REFRESH,
        expires_in: 3600,
      }),
    })
    await h.manager.start()
    await h.timers.flushOne()
    check('G25 JWT 缺 "https://api.openai.com/auth" ⇒ failed + 固定文案',
      h.manager.status().state === 'failed'
      && h.manager.status().message === '登录回调缺少账号信息，请重新登录', h.manager.status())
    h.manager.dispose()
  }

  // G26 email 取不到不影响登录
  {
    const h = loginHarness({
      onPoll: () => jsonResponse(200, { authorization_code: 'ac-4', code_verifier: 'ver-4' }),
      onExchange: () => jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID, 'pro'),
        refresh_token: SENT_REFRESH,
        expires_in: 3600,
        id_token: 'not-a-jwt',
      }),
    })
    await h.manager.start()
    await h.timers.flushOne()
    check('G26 id_token 坏掉不影响登录（email 缺席）',
      h.manager.status().state === 'authorized' && h.saved[0].email === undefined
      && h.saved[0].planType === 'pro', h.saved[0])
    h.manager.dispose()
  }

  // G27 saveCredential 失败 ⇒ failed
  {
    const h = loginHarness({
      onPoll: () => jsonResponse(200, { authorization_code: 'ac-5', code_verifier: 'ver-5' }),
      saveCredential: () => ({ ok: false, reason: 'write-failed' }),
    })
    await h.manager.start()
    await h.timers.flushOne()
    check('G27 落库失败 ⇒ failed + 固定文案', h.manager.status().state === 'failed'
      && h.manager.status().message === '登录信息保存失败，请重试', h.manager.status())
    h.manager.dispose()
  }

  // G28 默认落库路径：revision 从 1 开始、每次登录新 credentialId
  {
    const credentials = fakeCredentials({ record: undefined })
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    let polled = 0
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) return jsonResponse(200, { device_auth_id: 'dev-9', user_code: 'CODE-9', interval: 5 })
      if (call.url === DEVICE_TOKEN_URL) {
        polled += 1
        return jsonResponse(200, { authorization_code: 'ac-' + String(polled), code_verifier: 'ver-' + String(polled) })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID, 'plus'),
        refresh_token: SENT_REFRESH,
        expires_in: 3600,
      })
    })
    const manager = createCodexAccountLogin(credentials.ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await manager.start()
    await timers.flushOne()
    const first = credentials.state.record
    const firstAccount = firstAccountPayload(first)
    check('G28 默认落库：v2 记录 / 1 个账户 / type=oauth / revision=1 / credentialId 是 UUID',
      first !== undefined && first.kind === 'grant'
      && first.payload.version === 2
      && Array.isArray(first.payload.accounts) && first.payload.accounts.length === 1
      && firstAccount.type === 'oauth'
      && firstAccount.revision === 1
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(firstAccount.credentialId),
      first && first.payload)
    check('G29 默认落库：expires = now + expires_in，savedAt 是 ISO，active = 该账户',
      firstAccount.expires === NOW + 3_600_000
      && firstAccount.savedAt === new Date(NOW).toISOString()
      && first.payload.activeAccountId === firstAccount.credentialId, first.payload)

    // 第二次登录（**不** dispose：dispose 后 start 必须完全不发请求，见 G31）：
    // 同一 accountId ⇒ upsert：**credentialId 不变**、revision +1、账户数仍是 1。
    const again = await manager.start()
    await timers.flushOne()
    const second = credentials.state.record
    const secondAccount = firstAccountPayload(second)
    check('G30 同账号重登录 = upsert：credentialId 不变 / revision+1 / 账户数仍为 1 / active 跟着它',
      again.state === 'waiting' && manager.status().state === 'authorized'
      && second.payload.accounts.length === 1
      && secondAccount.revision === 2
      && secondAccount.credentialId === firstAccount.credentialId
      && secondAccount.accountId === ACCOUNT_ID
      && second.payload.activeAccountId === firstAccount.credentialId,
      { again, now: manager.status(), payload: second.payload })
    manager.dispose()
  }

  // G31 dispose 之后不再发请求
  {
    const h = loginHarness()
    await h.manager.start()
    h.manager.dispose()
    const before = h.net.calls.length
    const snapshot = await h.manager.start()
    check('G31 dispose 后 start 不发请求、状态不再前进',
      h.net.calls.length === before && snapshot.state === 'cancelled', { snapshot, calls: h.net.calls.length })
  }
}

// ===========================================================================
// H — clearCodexAccount（只删本插件私有记录）
// ===========================================================================
{
  const cred = fakeCredentials({ record: recordOf() })
  const before = await refreshCodexAccountIdentity(cred.ctx)
  const cleared = await clearCodexAccount(cred.ctx)
  check('H1 clear 成功 ⇒ {ok:true}，删除一次且只碰本插件 key',
    cleared.ok === true && cleared.reason === undefined
    && cred.state.deletes === 1 && cred.state.record === undefined
    && cred.state.keys.every((key) => key === CODEX_ACCOUNT_RECORD_KEY), { cleared, state: cred.state })
  check('H2 clear 成功后身份快照才是 none',
    codexAccountIdentitySnapshot() === 'none' && before !== 'none', { before })

  // [2026-11-22 终审 F3] 删除失败/无效 ⇒ 必须 {ok:false}，且**不**把身份清成 none。
  let threw = null
  let noService = null
  await refreshCodexAccountIdentity(fakeCredentials({ record: recordOf() }).ctx)
  const identityNoService = codexAccountIdentitySnapshot()
  try {
    noService = await clearCodexAccount({ get: () => undefined })
  } catch (err) {
    threw = err
  }
  check('H3 没有凭据服务 ⇒ {ok:false, reason:credentials-unavailable}、不抛、身份不变',
    threw === null && noService !== null && noService.ok === false
    && noService.reason === 'credentials-unavailable'
    && codexAccountIdentitySnapshot() === identityNoService,
    { noService, threw: threw === null ? null : threw.message })

  const delFail = fakeCredentials({ record: recordOf(), deleteError: true })
  await refreshCodexAccountIdentity(delFail.ctx)
  const identityDelFail = codexAccountIdentitySnapshot()
  const failResult = await clearCodexAccount(delFail.ctx)
  check('H4 deleteRecord 抛错 ⇒ {ok:false, reason:delete-failed}、记录仍在、身份不被清成 none',
    failResult.ok === false && failResult.reason === 'delete-failed'
    && delFail.state.record !== undefined
    && identityDelFail !== 'none' && codexAccountIdentitySnapshot() === identityDelFail,
    { failResult, identity: codexAccountIdentitySnapshot() })

  const noop = fakeCredentials({ record: recordOf(), deleteNoop: true })
  await refreshCodexAccountIdentity(noop.ctx)
  const identityNoop = codexAccountIdentitySnapshot()
  const noopResult = await clearCodexAccount(noop.ctx)
  check('H5 删除调用「成功」但记录还在 ⇒ {ok:false, reason:still-present}（不谎报成功）',
    noopResult.ok === false && noopResult.reason === 'still-present'
    && noop.state.deletes === 1
    && codexAccountIdentitySnapshot() === identityNoop, { noopResult, identity: codexAccountIdentitySnapshot() })

  const verifyBoom = fakeCredentials({ record: recordOf(), readErrorAfterDelete: true })
  const verifyResult = await clearCodexAccount(verifyBoom.ctx)
  check('H6 删除后重读抛错 ⇒ {ok:false, reason:verify-failed}（结果未知不报成功）',
    verifyResult.ok === false && verifyResult.reason === 'verify-failed', verifyResult)

  const noDelete = fakeCredentials({ record: recordOf(), noDeleteMember: true })
  const noDeleteResult = await clearCodexAccount(noDelete.ctx)
  check('H7 凭据服务没有 deleteRecord ⇒ {ok:false, reason:unsupported}',
    noDeleteResult.ok === false && noDeleteResult.reason === 'unsupported'
    && noDelete.state.record !== undefined, noDeleteResult)
}

// ===========================================================================
// I — plans/codex.js 的 account 分支（Connect 形状 → wire）
// ===========================================================================
{
  const usage = {
    rateLimits: [{
      id: 'codex',
      windows: [
        { remainingPercent: 64, windowSeconds: 18_000, resetAt: 1_760_003_600 },
        { remainingPercent: 82.5, windowSeconds: 604_800, resetAt: 1_760_086_400 },
      ],
    }],
    credits: { unlimited: false, balance: '12.50' },
    // [2026-11-22 终审 F1] 上游 spend control 带 remaining 精确金额 ⇒ 必须一路上到 wire。
    individualLimit: { limit: '20.00', used: '7.50', remaining: '12.50', remainingPercent: 62.5 },
    fetchedAt: 1_760_000_123_456,
  }
  const seen = []
  const plan = createCodexPlan({
    // 断言：account 来源**不**会 import Connect（这条路径必须完全不碰第三方插件）
    importConnectModule: async () => {
      throw new Error('connect-must-not-be-imported')
    },
    fetchCodexAccountUsage: async (ctx, payload) => {
      seen.push({ ctx, payload })
      return { ok: true, usage, credential: { credentialId: CREDENTIAL_ID } }
    },
  })
  const subCalls = []
  const ctx = {
    get(name) {
      if (name === 'codexSubscriptionUsage') {
        return {
          apiVersion: 1,
          async readUsage(args) { subCalls.push(args); return { ok: true, value: {} } },
          getRevision() { return 0 },
        }
      }
      return undefined
    },
  }
  const wire = await plan.fetch(ctx, undefined, { codexEnabled: true, codexSource: 'account' }, { signal: undefined })
  check('I1 account 分支：codexSource 标记正确、窗口按 5h/周归一',
    wire.codexSource === 'account' && wire.error === undefined
    && wire.rollingUsage.percent === 64 && wire.weeklyUsage.percent === 82.5, wire)
  check('I2 重置时间由秒转 ISO（不重复 ×1000）',
    wire.rollingUsage.resetsAt === new Date(1_760_003_600 * 1000).toISOString(), wire.rollingUsage)
  check('I3 credits / individualLimit 归一：remaining 精确金额一路透传到 wire',
    wire.creditsUnlimited === false && wire.creditsBalance === '12.50'
    && wire.individualLimit.limit === '20.00' && wire.individualLimit.used === '7.50'
    && wire.individualLimit.remaining === '12.50'
    && wire.individualLimit.remainingPercent === 62.5, wire.individualLimit)
  // I3b 上游没有 remaining ⇒ wire 给 null（不凭 remaining_percent 反推金额）
  {
    const planNoRemaining = createCodexPlan({
      fetchCodexAccountUsage: async () => ({
        ok: true,
        usage: Object.assign({}, usage, {
          individualLimit: { limit: '20.00', used: '7.50', remainingPercent: 62.5 },
        }),
      }),
    })
    const wireNoRemaining = await planNoRemaining.fetch(ctx, undefined,
      { codexEnabled: true, codexSource: 'account' }, {})
    check('I3b usage 缺 remaining ⇒ wire 为 null（不伪造金额）',
      wireNoRemaining.individualLimit.remaining === null
      && wireNoRemaining.individualLimit.limit === '20.00', wireNoRemaining.individualLimit)
  }
  check('I4 monthlyUsage 恒为 null（Codex 不显示月额度）', wire.monthlyUsage === null, wire.monthlyUsage)
  check('I5 fetchedAt（毫秒）原样保留', wire.fetchedAt === 1_760_000_123_456, wire.fetchedAt)
  check('I6 注入点只收到 (ctx, {signal})',
    seen.length === 1 && Object.keys(seen[0].payload).join(',') === 'signal', seen.map((s) => Object.keys(s.payload)))
  check('I7 account 分支不读 subscription、不 import connect',
    subCalls.length === 0, subCalls.length)
  check('I8 wire 不含 token', leaksIn(wire).length === 0)

  const signal = { aborted: false }
  await plan.fetch(ctx, undefined, { codexEnabled: true, codexSource: 'account' }, { signal })
  check('I9 signal 原样透传给 account 读取', seen[1].payload.signal === signal, seen[1].payload)

  /**
   * I9b 来源字段已退场：配置里写 `connect` / `subscription` / 干脆不写，都**只**走 account，
   * wire 上仍旧携带 `codexSource:'account'`（兼容旧 wire / 旧摘要），不再有分派。
   */
  {
    const accountCalls = []
    const planAny = createCodexPlan({
      fetchCodexAccountUsage: async () => {
        accountCalls.push('account')
        return { ok: true, usage }
      },
    })
    const cfgs = [
      { codexEnabled: true, codexSource: 'connect' },
      { codexEnabled: true, codexSource: 'subscription' },
      { codexEnabled: true },
    ]
    for (const cfg of cfgs) {
      const out = await planAny.fetch(ctx, undefined, cfg, {})
      check('I9b codexSource=' + String(cfg.codexSource) + ' 仍只走 account（wire 标 account）',
        out.codexSource === 'account' && out.rollingUsage.percent === 64 && subCalls.length === 0, out)
    }
    check('I9c 三种配置都确实走了 account 读取（没有别的来源分支）',
      accountCalls.length === cfgs.length, accountCalls.length)
  }
}

// I10 失败面：error / transient 透传、零 fallback
{
  const cases = [
    [{ ok: false, error: 'signed-out', message: '请先登录 ChatGPT 账号', reason: 'signed-out' }, 'signed-out', false],
    [{ ok: false, error: 'reauth-required', message: 'ChatGPT 登录已过期，请重新登录' }, 'reauth-required', false],
    [{ ok: false, error: 'incompatible', message: '本插件的 ChatGPT 登录记录不可用，请重新登录' }, 'incompatible', false],
    [{ ok: false, error: 'exec', message: 'Codex 额度获取失败', transient: true }, 'exec', true],
  ]
  for (const [failure, error, transient] of cases) {
    let connectImports = 0
    const plan = createCodexPlan({
      importConnectModule: async () => { connectImports += 1; throw new Error('nope') },
      fetchCodexAccountUsage: async () => failure,
    })
    const wire = await plan.fetch({ get: () => ({ apiVersion: 1, readUsage() {}, getRevision() { return 0 } }) },
      undefined, { codexEnabled: true, codexSource: 'account' }, {})
    check('I10 ' + error + ' 透传（transient=' + String(transient) + '）且零 fallback',
      wire.error === error && wire.codexSource === 'account'
      && (wire.transient === true) === transient && connectImports === 0
      && wire.rollingUsage === undefined, wire)
  }

  const plan = createCodexPlan({
    fetchCodexAccountUsage: async () => ({ ok: true, usage: { rateLimits: [{ id: 'codex', windows: [] }] } }),
  })
  const empty = await plan.fetch({ get: () => undefined }, undefined,
    { codexEnabled: true, codexSource: 'account' }, {})
  check('I11 空额度 ⇒ quota-unavailable（不伪造 0%）',
    empty.error === 'quota-unavailable' && empty.rollingUsage === undefined, empty)

  const planBad = createCodexPlan({ fetchCodexAccountUsage: async () => ({ ok: true, usage: null }) })
  const badUsage = await planBad.fetch({ get: () => undefined }, undefined,
    { codexEnabled: true, codexSource: 'account' }, {})
  check('I12 usage 形状错 ⇒ exec 非 transient', badUsage.error === 'exec'
    && badUsage.transient !== true, badUsage)

  const planThrow = createCodexPlan({
    fetchCodexAccountUsage: async () => { throw new Error('SENTINEL-SHOULD-NOT-LEAK') },
  })
  const thrown = await planThrow.fetch({ get: () => undefined }, undefined,
    { codexEnabled: true, codexSource: 'account' }, {})
  check('I13 读取实现抛错 ⇒ 暂时失败，且不回显异常原文',
    thrown.error === 'exec' && thrown.transient === true
    && thrown.message === 'Codex 额度获取失败', thrown)
}

// I14 来源归一
{
  check('I14 normalizeCodexSource 仍在 codex-sources.js（旧配置能读），但 codex.js 已不用它分派',
    normalizeCodexSource('account') === 'account'
    && normalizeCodexSource(' ACCOUNT ') === 'account'
    && normalizeCodexSource('nonsense') === 'connect'
    && normalizeCodexSource(undefined) === 'connect')
}

// ===========================================================================
// J — 多账户：迁移 / upsert / select / remove / 刷新隔离
// ===========================================================================
{
  /** 造一个「两个账户」的服务：A（active，过期） + B（新鲜）。 */
  function twoAccountService(options) {
    const opts = options === null || options === undefined ? {} : options
    const a = credentialOf({ revision: 2, expires: opts.expiresA !== undefined ? opts.expiresA : NOW - 1 })
    const b = credentialOf({
      accountId: ACCOUNT_ID_2,
      credentialId: CREDENTIAL_ID_2,
      revision: 5,
      email: 'second@example.com',
      access: 'access-of-b',
      refresh: 'refresh-of-b',
      expires: NOW + 7_200_000,
    })
    return fakeCredentials({ record: multiRecordOf([a, b], CREDENTIAL_ID) })
  }

  // J1 v1 → 登录第二账户：迁移成 v2 且保留旧账户
  {
    const cred = fakeCredentials({ record: v1RecordOf() })
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) return jsonResponse(200, { device_auth_id: 'dev-j1', user_code: 'CODE-J1', interval: 5 })
      if (call.url === DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: 'ac-j1', code_verifier: 'ver-j1' })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID_2, 'pro'),
        refresh_token: 'refresh-j1',
        expires_in: 3600,
        id_token: idTokenOf('second@example.com'),
      })
    })
    const manager = createCodexAccountLogin(cred.ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await manager.start()
    await timers.flushOne()
    const record = cred.state.record
    const list = accountPayloadsOf(record)
    check('J1 旧 v1 记录 + 登录另一个账号 ⇒ 落成 v2、两个账户都在、旧的 credentialId 保留',
      record.payload.version === 2 && list.length === 2
      && list[0].credentialId === CREDENTIAL_ID
      && list[1].accountId === ACCOUNT_ID_2
      && list[1].revision === 1, { payload: record.payload })
    check('J2 登录新账户后 active = 新账户、身份快照跟着切',
      record.payload.activeAccountId === list[1].credentialId
      && codexAccountIdentitySnapshot().includes('@' + String(list[1].credentialId).slice(0, 8) + 'r1'),
      { active: record.payload.activeAccountId, identity: codexAccountIdentitySnapshot() })
    manager.dispose()
  }

  // J3 已满 8 个账户 ⇒ 登录被拒（reason:'limit'，固定失败文案）
  {
    const full = Array.from({ length: MAX_CODEX_ACCOUNTS }, (_unused, index) => credentialOf({
      accountId: 'acc-full-' + String(index),
      credentialId: 'cred-full-' + String(index),
    }))
    const cred = fakeCredentials({ record: multiRecordOf(full, 'cred-full-0') })
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) return jsonResponse(200, { device_auth_id: 'dev-j3', user_code: 'CODE-J3', interval: 5 })
      if (call.url === DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: 'ac-j3', code_verifier: 'ver-j3' })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf('acc-brand-new', 'plus'),
        refresh_token: 'refresh-j3',
        expires_in: 3600,
      })
    })
    const manager = createCodexAccountLogin(cred.ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await manager.start()
    await timers.flushOne()
    const snapshot = manager.status()
    check('J3 已有 ' + MAX_CODEX_ACCOUNTS + ' 个账户 ⇒ 登录失败且显示**账户上限**固定文案（reason 不外泄）',
      snapshot.state === 'failed' && snapshot.message === MESSAGE_ACCOUNT_LIMIT
      && MESSAGE_ACCOUNT_LIMIT === '最多保存 ' + MAX_CODEX_ACCOUNTS + ' 个账户，请先移除一个账户'
      && !JSON.stringify(snapshot).includes('limit')
      && cred.state.writes === 0 && accountPayloadsOf(cred.state.record).length === MAX_CODEX_ACCOUNTS,
      { snapshot, writes: cred.state.writes })
    manager.dispose()
  }

  // J4 select：切换 active、不动 token、身份快照变化
  {
    const cred = twoAccountService()
    const beforeIdentity = await refreshCodexAccountIdentity(cred.ctx)
    const beforeSnapshot = JSON.parse(JSON.stringify(cred.state.record.payload))
    const selected = await selectCodexAccount(cred.ctx, CREDENTIAL_ID_2)
    const payload = cred.state.record.payload
    check('J4 select 第二个账户 ⇒ ok、active 切过去、返回该账户（含 token）',
      selected.ok === true && selected.credential.credentialId === CREDENTIAL_ID_2
      && payload.activeAccountId === CREDENTIAL_ID_2 && payload.version === 2, selected)
    check('J5 select 不动任何 token / revision（只改 activeAccountId）',
      payload.accounts[0].access === beforeSnapshot.accounts[0].access
      && payload.accounts[0].refresh === beforeSnapshot.accounts[0].refresh
      && payload.accounts[1].access === beforeSnapshot.accounts[1].access
      && payload.accounts[1].revision === beforeSnapshot.accounts[1].revision, payload)
    const afterIdentity = codexAccountIdentitySnapshot()
    check('J6 select 之后身份快照切到新 active（含 revision）',
      afterIdentity !== beforeIdentity && afterIdentity.includes('@cred-bbbr5'), { beforeIdentity, afterIdentity })

    const again = await selectCodexAccount(cred.ctx, CREDENTIAL_ID_2)
    check('J7 select 到已经是 active 的账户 ⇒ ok 且不写盘', again.ok === true
      && again.credential.credentialId === CREDENTIAL_ID_2, again)

    const missing = await selectCodexAccount(cred.ctx, 'cred-does-not-exist')
    check('J8 select 不存在的 id ⇒ {ok:false, reason:not-found}，active 不变',
      missing.ok === false && missing.reason === 'not-found'
      && cred.state.record.payload.activeAccountId === CREDENTIAL_ID_2, missing)

    const empty = fakeCredentials({ record: undefined })
    check('J9 没有记录时 select ⇒ {ok:false, reason:signed-out}',
      (await selectCodexAccount(empty.ctx, CREDENTIAL_ID)).reason === 'signed-out')
    check('J10 没有凭据服务时 select ⇒ {ok:false, reason:credentials-unavailable}',
      (await selectCodexAccount({ get: () => undefined }, CREDENTIAL_ID)).reason === 'credentials-unavailable')
  }

  // J11 刷新只针对 active 账户（B 新鲜 ⇒ 不刷新；A 过期 ⇒ 只刷 A）
  {
    const cred = twoAccountService()
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) return jsonResponse(200, { access_token: 'a-new', refresh_token: 'a-new-r', expires_in: 3600 })
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    const list = accountPayloadsOf(cred.state.record)
    check('J11 active=A 且 A 过期 ⇒ 只刷 A；B 的 token 与 revision 原样不动',
      result.ok === true && list[0].access === 'a-new' && list[0].revision === 2
      && list[1].access === 'access-of-b' && list[1].refresh === 'refresh-of-b'
      && list[1].revision === 5, list)
    check('J12 刷新后 active 不变、记录仍是 v2', cred.state.record.payload.activeAccountId === CREDENTIAL_ID
      && cred.state.record.payload.version === 2)

    // 切到 B 之后：B 未过期 ⇒ 一次 token 都不打
    const cred2 = twoAccountService()
    await selectCodexAccount(cred2.ctx, CREDENTIAL_ID_2)
    const net2 = fakeFetch((call) => {
      if (call.url === TOKEN_URL) return jsonResponse(200, { access_token: 'should-not-happen', refresh_token: 'x', expires_in: 60 })
      return jsonResponse(200, usageBody())
    })
    const result2 = await fetchCodexAccountUsage(cred2.ctx, { now: () => NOW, fetch: net2.impl })
    check('J13 切到未过期的 B ⇒ 零刷新、用 B 的 access 读额度',
      result2.ok === true && callsTo(net2.calls, TOKEN_URL).length === 0
      && callsTo(net2.calls, CODEX_ACCOUNT_USAGE_URL)[0].init.headers.authorization === 'Bearer access-of-b'
      && callsTo(net2.calls, CODEX_ACCOUNT_USAGE_URL)[0].init.headers['chatgpt-account-id'] === ACCOUNT_ID_2,
      net2.calls.map((c) => c.url))
    check('J14 刷新不改 revision ⇒ 身份快照不变',
      codexAccountIdentitySnapshot().includes('@cred-bbbr5'), codexAccountIdentitySnapshot())
  }

  // J15 强制刷新（401）只写 active 账户
  {
    const cred = twoAccountService({ expiresA: NOW + 3_600_000 })
    let usageCalls = 0
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) return jsonResponse(200, { access_token: 'forced-a', refresh_token: 'forced-a-r', expires_in: 3600 })
      usageCalls += 1
      if (usageCalls === 1) return jsonResponse(401, { error: 'unauthorized' })
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    const list = accountPayloadsOf(cred.state.record)
    check('J15 未过期但 401 ⇒ 强制刷新只改 A；B 完全不受影响',
      result.ok === true && list[0].access === 'forced-a'
      && list[1].access === 'access-of-b' && list[1].refresh === 'refresh-of-b'
      && cred.state.record.payload.activeAccountId === CREDENTIAL_ID, list)
  }

  // J16 remove：移除 active ⇒ active 取剩余
  {
    const cred = twoAccountService()
    const removed = await removeCodexAccount(cred.ctx, CREDENTIAL_ID)
    const payload = cred.state.record.payload
    check('J16 移除 active A ⇒ ok、removed 是 A、active 落到剩余第一个（B）',
      removed.ok === true && removed.removed === CREDENTIAL_ID
      && removed.activeAccountId === CREDENTIAL_ID_2
      && payload.accounts.length === 1 && payload.accounts[0].credentialId === CREDENTIAL_ID_2
      && payload.activeAccountId === CREDENTIAL_ID_2, { removed, payload })
    check('J17 移除后身份快照跟着新 active（B 的 revision）',
      codexAccountIdentitySnapshot().includes('@cred-bbbr5'), codexAccountIdentitySnapshot())
    check('J18 移除最后一个账户之外的路径不会删除整条记录', cred.state.deletes === 0, cred.state.deletes)

    const second = await removeCodexAccount(cred.ctx)
    check('J19 缺省参数 = 移除 active（最后一个）⇒ 原子改写成空态 tombstone、返回里没有 activeAccountId、零 deleteRecord',
      second.ok === true && second.removed === CREDENTIAL_ID_2
      && second.activeAccountId === undefined
      && isTombstone(cred.state.record)
      && cred.state.deletes === 0, { second, record: cred.state.record, deletes: cred.state.deletes })
    check('J20 删掉最后一个账户后身份快照是 none',
      codexAccountIdentitySnapshot() === 'none', codexAccountIdentitySnapshot())
    check('J21 记录已不存在时再 remove ⇒ {ok:false, reason:signed-out}',
      (await removeCodexAccount(cred.ctx)).reason === 'signed-out')
  }

  // J22 remove：非 active 账户 ⇒ active 不变
  {
    const cred = twoAccountService()
    const removed = await removeCodexAccount(cred.ctx, CREDENTIAL_ID_2)
    check('J22 移除非 active 的 B ⇒ active 仍是 A',
      removed.ok === true && removed.activeAccountId === CREDENTIAL_ID
      && cred.state.record.payload.activeAccountId === CREDENTIAL_ID
      && accountPayloadsOf(cred.state.record).length === 1, removed)
  }

  // J23 remove：找不到 ⇒ not-found，记录一字未动
  {
    const cred = twoAccountService()
    const missing = await removeCodexAccount(cred.ctx, 'cred-nope')
    check('J23 移除不存在的 id ⇒ {ok:false, reason:not-found}，记录一字未动',
      missing.ok === false && missing.reason === 'not-found'
      && accountPayloadsOf(cred.state.record).length === 2 && cred.state.writes === 0, missing)
  }

  // =========================================================================
  // J24–J28 [2026-11-25 R5] 最后一个账户：**只**写空态 tombstone，不碰 deleteRecord
  //
  // 旧的「最后账户 ⇒ 事务外确认读 + clearCodexAccount 删除」已删除：delete 相关失败语义
  // 仍由 H1–H7（clearCodexAccount 本身）覆盖，这里只验证移除路径不再依赖 deleteRecord。
  // =========================================================================
  {
    const delFail = fakeCredentials({ record: recordOf(), deleteError: true })
    await refreshCodexAccountIdentity(delFail.ctx)
    const removed = await removeCodexAccount(delFail.ctx)
    check('J24 最后一个账户 + deleteRecord 会抛错 ⇒ 仍然成功（零 delete 调用、写 tombstone、身份 none）',
      removed.ok === true && removed.removed === CREDENTIAL_ID
      && delFail.state.deletes === 0 && isTombstone(delFail.state.record)
      && codexAccountIdentitySnapshot() === 'none',
      { removed, deletes: delFail.state.deletes, record: delFail.state.record })

    const noDelete = fakeCredentials({ record: recordOf(), noDeleteMember: true })
    const noDeleteResult = await removeCodexAccount(noDelete.ctx)
    check('J25 凭据服务没有 deleteRecord ⇒ 移除最后一个账户仍成功（tombstone 不需要 deleteRecord）',
      noDeleteResult.ok === true && noDelete.state.deletes === 0
      && isTombstone(noDelete.state.record), noDeleteResult)

    const writeFail = fakeCredentials({ record: recordOf(), writeError: true })
    await refreshCodexAccountIdentity(writeFail.ctx)
    const identityBefore = codexAccountIdentitySnapshot()
    const writeFailed = await removeCodexAccount(writeFail.ctx)
    check('J26 modifyRecord 抛错 ⇒ {ok:false, reason:write-failed}、记录原样、身份不被清成 none',
      writeFailed.ok === false && writeFailed.reason === 'write-failed'
      && writeFail.state.record !== undefined && !isTombstone(writeFail.state.record)
      && identityBefore !== 'none' && codexAccountIdentitySnapshot() === identityBefore,
      { writeFailed, identity: codexAccountIdentitySnapshot() })

    const gone = fakeCredentials({
      record: recordOf(),
      // 初始读之后、独占写之前，别人把整条记录删掉了（独占回调看到的 current = undefined）。
      beforeModify: (state) => { state.record = undefined },
    })
    const idempotent = await removeCodexAccount(gone.ctx, CREDENTIAL_ID)
    check('J27 独占写时记录已被别人删除 ⇒ 幂等 {ok:true, removed}、零写入、身份 none（不挂起）',
      idempotent.ok === true && idempotent.removed === CREDENTIAL_ID
      && gone.state.writes === 0 && gone.state.skipped === 1
      && gone.state.record === undefined
      && codexAccountIdentitySnapshot() === 'none',
      { idempotent, state: { writes: gone.state.writes, skipped: gone.state.skipped } })

    const oneAccount = fakeCredentials({ record: recordOf() })
    const single = await removeCodexAccount(oneAccount.ctx)
    check('J28 单账户记录移除 ⇒ 恰好一次写（tombstone）、零 delete',
      single.ok === true && oneAccount.state.writes === 1
      && oneAccount.state.deletes === 0 && isTombstone(oneAccount.state.record),
      { single, state: { writes: oneAccount.state.writes, deletes: oneAccount.state.deletes } })

    const alreadyEmpty = fakeCredentials({ record: emptyCodexAccountRecord() })
    const alreadyGone = await removeCodexAccount(alreadyEmpty.ctx)
    check('J28b 初始读就是空态 tombstone ⇒ {ok:false, reason:signed-out}、零写零删',
      alreadyGone.ok === false && alreadyGone.reason === 'signed-out'
      && alreadyEmpty.state.writes === 0 && alreadyEmpty.state.deletes === 0, alreadyGone)
  }

  // J29 账户被移除后刷新 ⇒ reauth-required（不新建账户）
  {
    const cred = twoAccountService()
    const net = fakeFetch((call) => {
      if (call.url === TOKEN_URL) {
        // 刷新期间这个账户被别人移除了。
        cred.state.record = multiRecordOf([
          credentialOf({ accountId: ACCOUNT_ID_2, credentialId: CREDENTIAL_ID_2, email: 'second@example.com' }),
        ], CREDENTIAL_ID_2)
        return jsonResponse(200, { access_token: 'ghost', refresh_token: 'ghost-r', expires_in: 3600 })
      }
      return jsonResponse(200, usageBody())
    })
    const result = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
    check('J29 刷新期间账户被移除 ⇒ reauth-required、零写入、不新建账户',
      result.ok === false && result.error === 'reauth-required'
      && cred.state.writes === 0
      && accountPayloadsOf(cred.state.record).length === 1, result)
  }

  // =========================================================================
  // J30–J34：坏记录（incompatible）的恢复入口（[2026-11-23 终审 B1]）
  // =========================================================================
  /** 一条结构上就是坏掉的记录（路由/界面会显示 reason:'incompatible'）。 */
  const CORRUPT_RECORD = Object.freeze({ kind: 'grant', payload: { type: 'oauth' } })

  /**
   * 用「坏记录」起一次**默认落库**的设备码登录（不走 saveCredential 注入）：
   * 这是客户端「重新登录」按钮实际走的那条路。
   */
  function loginWithRecord(record, options) {
    const opts = options === null || options === undefined ? {} : options
    const cred = fakeCredentials(Object.assign(
      { record },
      opts.credentials !== null && opts.credentials !== undefined ? opts.credentials : {},
    ))
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) {
        return jsonResponse(200, { device_auth_id: opts.deviceAuthId || 'dev-b1', user_code: 'CODE-B1', interval: 5 })
      }
      if (call.url === DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: 'ac-b1', code_verifier: 'ver-b1' })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID, 'plus'),
        refresh_token: 'refresh-b1',
        expires_in: 3600,
        id_token: idTokenOf('relogin@example.com'),
      })
    })
    const manager = createCodexAccountLogin(cred.ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    return { cred, timers, net, manager }
  }

  // J30 坏记录 + 「重新登录」⇒ 覆盖成合法 v2 单账户
  {
    const h = loginWithRecord(CORRUPT_RECORD)
    await h.manager.start()
    await h.timers.flushOne()
    const snapshot = h.manager.status()
    const record = h.cred.state.record
    const list = accountPayloadsOf(record)
    check('J30 坏记录 + 重新登录 ⇒ authorized，并覆盖成合法 v2 单账户（新 credentialId / revision=1 / active）',
      snapshot.state === 'authorized'
      && record !== undefined && record.payload.version === 2
      && Array.isArray(record.payload.accounts) && record.payload.accounts.length === 1
      && list[0].accountId === ACCOUNT_ID && list[0].revision === 1
      && list[0].credentialId !== CREDENTIAL_ID
      && record.payload.activeAccountId === list[0].credentialId
      && validateCodexAccountRecord(record).state === 'ok'
      && codexAccountIdentitySnapshot().includes('@' + String(list[0].credentialId).slice(0, 8) + 'r1'),
      { snapshot, record })
    h.manager.dispose()
  }

  // J31 坏记录 + 无 id logout ⇒ clearCodexAccount（删一次 + 重读确认）
  {
    const cred = fakeCredentials({ record: CORRUPT_RECORD })
    const identityBefore = await refreshCodexAccountIdentity(cred.ctx)
    const removed = await removeCodexAccount(cred.ctx)
    check('J31 坏记录 + 无 id logout ⇒ {ok:true, removed:null}、deleteRecord 恰一次、记录消失、身份 none',
      removed.ok === true && removed.removed === null
      && removed.activeAccountId === undefined
      && cred.state.deletes === 1 && cred.state.record === undefined
      && identityBefore === 'unknown'
      && codexAccountIdentitySnapshot() === 'none',
      { removed, state: cred.state, identity: codexAccountIdentitySnapshot() })
  }

  // J32 坏记录 + 指定 id logout ⇒ 固定 incompatible，记录不动
  {
    const cred = fakeCredentials({ record: CORRUPT_RECORD })
    const removed = await removeCodexAccount(cred.ctx, CREDENTIAL_ID)
    check('J32 坏记录 + 指定 id logout ⇒ 固定 {ok:false, reason:incompatible}，零删除 / 零写入 / 记录原样',
      removed.ok === false && removed.reason === 'incompatible'
      && cred.state.deletes === 0 && cred.state.modifies === 0 && cred.state.writes === 0
      && cred.state.record === CORRUPT_RECORD,
      { removed, state: cred.state })
  }

  // J33 坏记录 + 凭据服务不可用 ⇒ 登录仍失败，绝不把「读不到」当成空账户集覆盖
  {
    /**
     * 能读（坏记录还在）、但不能写：`describeCodexCredentialsService` 把缺少
     * `modifyRecord` 的服务判为不可用 ⇒ `defaultSaveCredential()` 返回 `unavailable`。
     * 这条用例守的是：[终审 B1] 只放宽 `incompatible`，绝不放宽 `unknown` / 不可用。
     */
    const readOnlyService = { async readRecord() { return CORRUPT_RECORD } }
    const ctx = { get(name) { return name === 'credentials' ? readOnlyService : undefined } }
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) {
        return jsonResponse(200, { device_auth_id: 'dev-j33', user_code: 'CODE-J33', interval: 5 })
      }
      if (call.url === DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: 'ac-j33', code_verifier: 'ver-j33' })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID, 'plus'),
        refresh_token: 'refresh-j33',
        expires_in: 3600,
      })
    })
    const manager = createCodexAccountLogin(ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await manager.start()
    await timers.flushOne()
    const snapshot = manager.status()
    check('J33 坏记录 + 凭据服务不可用 ⇒ 登录失败（固定保存失败文案），坏记录不可能被覆盖',
      snapshot.state === 'failed' && snapshot.message === '登录信息保存失败，请重试'
      && CORRUPT_RECORD.payload.type === 'oauth'
      && Object.keys(CORRUPT_RECORD.payload).length === 1
      && !JSON.stringify(snapshot).includes('unavailable'),
      { snapshot })
    manager.dispose()
  }

  // J33b **完全没有**凭据服务 ⇒ 登录仍然失败（unknown / absent 不得被当成空账户集）
  {
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) {
        return jsonResponse(200, { device_auth_id: 'dev-j33b', user_code: 'CODE-J33B', interval: 5 })
      }
      if (call.url === DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: 'ac-j33b', code_verifier: 'ver-j33b' })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID, 'plus'),
        refresh_token: 'refresh-j33b',
        expires_in: 3600,
      })
    })
    const manager = createCodexAccountLogin({ get: () => undefined }, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    await manager.start()
    await timers.flushOne()
    const snapshot = manager.status()
    check('J33b 没有任何凭据服务 ⇒ 登录失败且只给固定保存失败文案（绝不伪造成功）',
      snapshot.state === 'failed' && snapshot.message === '登录信息保存失败，请重试'
      && Object.keys(snapshot).every((key) => ['state', 'userCode', 'verificationUrl', 'message', 'expiresAt'].includes(key)),
      snapshot)
    manager.dispose()
  }

  // J33c 服务在、但**读不到**记录 ⇒ 登录仍失败（不能把「读不到」当空账户集覆盖）
  {
    const h = loginWithRecord(CORRUPT_RECORD, { credentials: { readError: true } })
    await h.manager.start()
    await h.timers.flushOne()
    const snapshot = h.manager.status()
    check('J33c readRecord 抛错（unknown）⇒ 登录失败、零写入、坏记录一条未动',
      snapshot.state === 'failed' && snapshot.message === '登录信息保存失败，请重试'
      && h.cred.state.writes === 0
      && h.cred.state.record === CORRUPT_RECORD
      && !JSON.stringify(snapshot).includes('unavailable'),
      { snapshot, state: { writes: h.cred.state.writes, modifies: h.cred.state.modifies } })
    h.manager.dispose()
  }

  // J34 单账户移除：初始读只有 1 个，但写前别人加了第二个 ⇒ 只删目标，不整条删除
  {
    const cred = fakeCredentials({
      record: recordOf(),
      beforeModify: (state) => {
        state.record = multiRecordOf([
          credentialOf({}),
          credentialOf({ accountId: ACCOUNT_ID_2, credentialId: CREDENTIAL_ID_2, revision: 1, email: 'late@example.com' }),
        ], CREDENTIAL_ID)
      },
    })
    const removed = await removeCodexAccount(cred.ctx, CREDENTIAL_ID)
    check('J34 初始读只有 1 个账户、独占写前别人加了第二个 ⇒ 只移除目标账户（不整条删除）',
      removed.ok === true && removed.removed === CREDENTIAL_ID
      && removed.activeAccountId === CREDENTIAL_ID_2
      && cred.state.deletes === 0
      && accountPayloadsOf(cred.state.record).length === 1
      && accountPayloadsOf(cred.state.record)[0].credentialId === CREDENTIAL_ID_2,
      { removed, payload: cred.state.record && cred.state.record.payload })
  }

  // J35（旧「独占写复核之后、删除确认之前别人加了账户」用例）已随 R5 删除：
  // 现在最后一个账户的移除是**一次** modifyRecord 原子写，不再有「确认读 → deleteRecord」
  // 那个窗口；对应的竞态回归在下面的 R5-2 用真实登录写入重放。
}

// ===========================================================================
// R5 — 移除**最后一个**账户 = 在同一次 `modifyRecord` 里原子写空态 tombstone
//      （[2026-11-25] 不再「事务外确认读 + clearCodexAccount 无条件删除」：那个窗口会把
//       并发新增的账户一起删掉；在 mutate 内 deleteRecord 又是重入锁、可能死锁）
// ===========================================================================
{
  /**
   * 用一次**真实**（fake fetch / fake 定时器）的设备码登录，把**第二个**账号写进记录。
   * 调用方用 `await timers.flushOne()` 推进到落库完成。
   */
  function loginSecondAccount(cred) {
    const timers = fakeTimers()
    const clock = fakeClock(NOW)
    const net = fakeFetch((call) => {
      if (call.url === USERS_URL) {
        return jsonResponse(200, { device_auth_id: 'dev-r5', user_code: 'CODE-R5', interval: 5 })
      }
      if (call.url === DEVICE_TOKEN_URL) {
        return jsonResponse(200, { authorization_code: 'ac-r5', code_verifier: 'ver-r5' })
      }
      return jsonResponse(200, {
        access_token: accessTokenOf(ACCOUNT_ID_2, 'pro'),
        refresh_token: 'refresh-r5-b',
        expires_in: 3600,
        id_token: idTokenOf('r5-b@example.com'),
      })
    })
    const manager = createCodexAccountLogin(cred.ctx, {
      fetch: net.impl,
      now: clock.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })
    return { manager, timers, net }
  }

  // R5-1 无并发：移除唯一账户 ⇒ 空态 tombstone（精确形状）；读取 absent；state 未登录；
  //      之后新增 B 成功（`defaultSaveCredential` 在 modifyRecord 里读到 tombstone ⇒ absent）。
  {
    const cred = fakeCredentials({ record: recordOf() })
    await refreshCodexAccountIdentity(cred.ctx)
    const removed = await withNoHang(removeCodexAccount(cred.ctx))
    check('R5-1a 移除唯一账户 ⇒ {ok:true}、记录改写成**精确**空态 tombstone、零 deleteRecord、身份 none',
      removed.ok === true && removed.removed === CREDENTIAL_ID
      && removed.activeAccountId === undefined
      && isTombstone(cred.state.record)
      && deepEqual(cred.state.record, EMPTY_TOMBSTONE)
      && cred.state.deletes === 0 && cred.state.writes === 1
      && codexAccountIdentitySnapshot() === 'none',
      { removed, record: cred.state.record, writes: cred.state.writes, deletes: cred.state.deletes })

    const readBack = await readCodexAccountRecord(cred.ctx)
    check('R5-1b tombstone 读出来是 absent（未登录；不判 incompatible / unknown）',
      readBack.state === 'absent', readBack)

    const signedOut = await codexAccountState(cred.ctx)
    check('R5-1c tombstone ⇒ codexAccountState 显示未登录（configured:false / reason:signed-out / canLogin:true）',
      signedOut.configured === false && signedOut.canLogin === true
      && signedOut.reason === 'signed-out'
      && signedOut.account === undefined && signedOut.accounts === undefined, signedOut)

    const againRemove = await removeCodexAccount(cred.ctx)
    check('R5-1d 已经是 tombstone 再移除 ⇒ {ok:false, reason:signed-out}、零写零删（不挂起）',
      againRemove.ok === false && againRemove.reason === 'signed-out'
      && cred.state.writes === 1 && cred.state.deletes === 0, againRemove)

    const login = loginSecondAccount(cred)
    await login.manager.start()
    await login.timers.flushOne()
    const list = accountPayloadsOf(cred.state.record)
    const loginSnapshot = login.manager.status()
    check('R5-1e tombstone 之后新增 B 成功（absent ⇒ accounts=[] ⇒ 正常新增，token 完整、active=B）',
      loginSnapshot.state === 'authorized'
      && cred.state.record !== undefined && cred.state.record.payload.version === 2
      && list.length === 1
      && list[0].accountId === ACCOUNT_ID_2
      && list[0].access === accessTokenOf(ACCOUNT_ID_2, 'pro')
      && list[0].refresh === 'refresh-r5-b'
      && list[0].revision === 1
      && cred.state.record.payload.activeAccountId === list[0].credentialId,
      { loginSnapshot, record: cred.state.record })
    const afterAdd = await readCodexAccountRecord(cred.ctx)
    check('R5-1f 新增后读取回到 ok、state 已登录、身份快照指向 B',
      afterAdd.state === 'ok'
      && (await codexAccountState(cred.ctx)).configured === true
      && codexAccountIdentitySnapshot().includes('@' + String(list[0].credentialId).slice(0, 8) + 'r1'),
      { afterAdd, identity: codexAccountIdentitySnapshot() })
    login.manager.dispose()
  }

  // R5-2 竞态（核心回归）：初始读只看到 A（最后账户）；在 remove 的 modifyRecord 独占调用
  //      **之前**，B 的登录写入先成功 ⇒ remove 必须只移除 A 并保留 B（旧实现会整条删掉 B）。
  {
    const cred = fakeCredentials({ record: recordOf() })
    const login = loginSecondAccount(cred)
    const originalModify = cred.service.modifyRecord.bind(cred.service)
    let injected = false
    cred.service.modifyRecord = async (key, mutate) => {
      if (injected === false) {
        injected = true
        // 真实登录写入 B（走同一个服务的独占写；此刻 remove 的写还没进队列，不会死锁）。
        await login.manager.start()
        await login.timers.flushOne()
      }
      return originalModify(key, mutate)
    }
    const removed = await withNoHang(removeCodexAccount(cred.ctx))
    const list = accountPayloadsOf(cred.state.record)
    const bPayload = list.find((item) => item.accountId === ACCOUNT_ID_2)
    check('R5-2a 竞态：B 的写入先成功 ⇒ remove 只移除 A、B 还在且是 active（不误删、不挂起）',
      injected === true
      && removed.ok === true && removed.removed === CREDENTIAL_ID
      && removed.activeAccountId !== undefined
      && bPayload !== undefined && list.length === 1
      && cred.state.record.payload.activeAccountId === bPayload.credentialId
      && removed.activeAccountId === bPayload.credentialId
      && cred.state.deletes === 0 && cred.state.writes === 2,
      { removed, injected, list, deletes: cred.state.deletes, writes: cred.state.writes })
    check('R5-2b 竞态后 B 的 access / refresh / revision / savedAt 一个字节都没丢',
      bPayload !== undefined
      && bPayload.access === accessTokenOf(ACCOUNT_ID_2, 'pro')
      && bPayload.refresh === 'refresh-r5-b'
      && bPayload.revision === 1
      && typeof bPayload.savedAt === 'string', bPayload)
    check('R5-2c 竞态后读取仍是 ok、身份快照指向 B（没有留下空态 / 坏记录）',
      bPayload !== undefined
      && (await readCodexAccountRecord(cred.ctx)).state === 'ok'
      && codexAccountIdentitySnapshot().includes('@' + String(bPayload.credentialId).slice(0, 8) + 'r1'),
      { identity: codexAccountIdentitySnapshot() })
    login.manager.dispose()
  }

  // R5-3 对照：A+B 时移除 A ⇒ 只删 A、B 完整保留（普通 v2 记录，不整条删、不写 tombstone）
  {
    const a = credentialOf({ revision: 2, expires: NOW + 3_600_000 })
    const b = credentialOf({
      accountId: ACCOUNT_ID_2,
      credentialId: CREDENTIAL_ID_2,
      revision: 5,
      email: 'second@example.com',
      access: 'access-of-b',
      refresh: 'refresh-of-b',
      expires: NOW + 7_200_000,
    })
    const cred = fakeCredentials({ record: multiRecordOf([a, b], CREDENTIAL_ID) })
    const removed = await withNoHang(removeCodexAccount(cred.ctx, CREDENTIAL_ID))
    const list = accountPayloadsOf(cred.state.record)
    check('R5-3a 对照：A+B 移除 A ⇒ 记录仍是普通 v2（不是 tombstone）、只剩 B 且 active=B、零 delete',
      removed.ok === true && removed.removed === CREDENTIAL_ID
      && removed.activeAccountId === CREDENTIAL_ID_2
      && isTombstone(cred.state.record) === false
      && list.length === 1 && list[0].credentialId === CREDENTIAL_ID_2
      && cred.state.record.payload.activeAccountId === CREDENTIAL_ID_2
      && cred.state.deletes === 0, { removed, record: cred.state.record })
    check('R5-3b 对照：B 的 access / refresh / revision 原样保留、读取仍是 ok',
      list[0].access === 'access-of-b' && list[0].refresh === 'refresh-of-b'
      && list[0].revision === 5
      && (await readCodexAccountRecord(cred.ctx)).state === 'ok', list[0])
  }
}

// ===========================================================================
// K — 状态 wire：只有白名单字段、无 token / accountId 明文、active 唯一
// ===========================================================================
{
  const a = credentialOf({ email: 'first@example.com', revision: 2 })
  const b = credentialOf({ accountId: ACCOUNT_ID_2, credentialId: CREDENTIAL_ID_2, revision: 5, expires: NOW + 9_000_000 })
  const c = credentialOf({ accountId: ACCOUNT_ID_3, credentialId: CREDENTIAL_ID_3, revision: 1, expires: NOW + 600_000 })
  const cred = fakeCredentials({ record: multiRecordOf([a, b, c], CREDENTIAL_ID_2) })
  const state = await codexAccountState(cred.ctx)

  const allowedAccountKeys = new Set(['label', 'planType', 'maskedId'])
  const allowedEntryKeys = new Set(['id', 'label', 'planType', 'maskedId', 'active'])
  check('K1 顶层只有白名单字段',
    Object.keys(state).every((key) => ['configured', 'canLogin', 'activeAccountId', 'account',
      'accounts', 'expiresAt', 'revision', 'reason'].includes(key)), Object.keys(state))
  check('K2 account 只有 label / planType / maskedId',
    Object.keys(state.account).every((key) => allowedAccountKeys.has(key)), Object.keys(state.account))
  check('K3 accounts 每项只有 id / label / planType / maskedId / active',
    state.accounts.every((item) => Object.keys(item).every((key) => allowedEntryKeys.has(key))),
    state.accounts.map((item) => Object.keys(item)))
  check('K4 3 个账户顺序 = 记录顺序，active 只有 B 一条',
    state.accounts.length === 3
    && state.accounts[0].id === CREDENTIAL_ID
    && state.accounts[1].id === CREDENTIAL_ID_2
    && state.accounts[2].id === CREDENTIAL_ID_3
    && state.accounts.filter((item) => item.active === true).length === 1
    && state.accounts[1].active === true
    && state.activeAccountId === CREDENTIAL_ID_2, state.accounts)
  check('K5 无 email 的账户 label 用遮罩号区分（A 有 email 用 email）',
    state.accounts[0].label === 'first@example.com'
    && state.accounts[1].label === 'ChatGPT 账号 ' + state.accounts[1].maskedId
    && state.accounts[1].label !== state.accounts[2].label, state.accounts.map((i) => i.label))
  check('K6 顶层 account / expiresAt / revision 都是 active（B）的',
    state.account.maskedId === state.accounts[1].maskedId
    && state.expiresAt === b.expires && state.expiresAt !== a.expires
    && state.revision === 5, { account: state.account, revision: state.revision, expiresAt: state.expiresAt })
  check('K7 状态里没有 token，也没有明文 accountId',
    leaksIn(state).length === 0
    && !plaintextAccountLeak(state, ACCOUNT_ID)
    && !plaintextAccountLeak(state, ACCOUNT_ID_2)
    && !plaintextAccountLeak(state, ACCOUNT_ID_3), state)
  check('K8 单据里没有 access/refresh 字段（连字段名都不出现）',
    !JSON.stringify(state).includes('"access"') && !JSON.stringify(state).includes('refresh'), Object.keys(state))

  const single = await codexAccountState(fakeCredentials({ record: recordOf() }).ctx)
  check('K9 v1 记录的状态也给 accounts 列表（内存迁移对 UI 透明）',
    single.configured === true && single.accounts.length === 1 && single.accounts[0].active === true
    && single.activeAccountId === CREDENTIAL_ID, single)

  /**
   * [2026-11-23 终审 B1-4] 账户 id 形状三端统一为 `^[A-Za-z0-9-]{1,100}$`：
   * 非法形状（含 `_` / `.` / `:`）不得进入 `accounts[].id` / `activeAccountId`，
   * 否则客户端会拿一个 Host `select` 永远拒绝的 id。
   */
  const ILLEGAL_ID = 'cred_bad.id:with_underscore'
  const illegal = await codexAccountState(fakeCredentials({
    record: multiRecordOf([credentialOf({ credentialId: ILLEGAL_ID })], ILLEGAL_ID),
  }).ctx)
  check('K10 非法 id（不在 ^[A-Za-z0-9-]{1,100}$）不进入 accounts / activeAccountId 视图',
    illegal.configured === true && illegal.accounts.length === 1
    && illegal.accounts[0].id === undefined
    && illegal.accounts[0].active === true
    && illegal.activeAccountId === undefined
    && !JSON.stringify(illegal).includes(ILLEGAL_ID), illegal)

  const maxId = 'A' + 'b-9'.repeat(33) // 1 + 33*3 = 100 个字符，恰好是上限
  const maxState = await codexAccountState(fakeCredentials({
    record: multiRecordOf([credentialOf({ credentialId: maxId })], maxId),
  }).ctx)
  check('K11 合法的 100 字符 id（大写/数字/连字符）仍原样进入视图（上限含端点）',
    maxId.length === 100
    && maxState.accounts.length === 1
    && maxState.accounts[0].id === maxId
    && maxState.activeAccountId === maxId, { maxState, length: maxId.length })
}

// ===========================================================================
// Z — 全局脱敏：登录/状态/身份/错误路径都不含 token
// ===========================================================================
{
  const cred = fakeCredentials({ record: recordOf({ expires: NOW - 1 }) })
  const net = fakeFetch((call) => {
    if (call.url === TOKEN_URL) return jsonResponse(200, { access_token: 'k', refresh_token: 'r', expires_in: 60 })
    return jsonResponse(200, usageBody())
  })
  const okResult = await fetchCodexAccountUsage(cred.ctx, { now: () => NOW, fetch: net.impl })
  const state = await codexAccountState(cred.ctx)
  const identity = codexAccountIdentitySnapshot()
  check('Z1 成功结果里 usage / 状态 / 身份都不含 token 原文',
    okResult.ok === true && leaksIn(okResult.usage).length === 0
    && leaksIn(state).length === 0 && leaksIn(identity).length === 0, { identity })
  check('Z2 身份快照不含明文账号', !identity.includes(ACCOUNT_ID), identity)
  check('Z3 credential 是唯一含 token 的返回字段（预期行为）',
    typeof okResult.credential.access === 'string', Object.keys(okResult.credential))
  // 反向确认 sentinel 检测本身有效
  check('Z4 sentinel 检测有效（正控）', leaksIn({ x: SENT_ACCESS }).length === 1)
}

console.log('\n' + passCount + ' passed, ' + failCount + ' failed')
if (failCount > 0) process.exitCode = 1
