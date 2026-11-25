/**
 * [2026-11-22 Codex 第三来源 `account`] Host 侧接入回归：**全离线、全 fake**。
 *
 * 被测对象是**真实 `apply()`**（不是复制一份逻辑），只把外部世界换成替身：
 *   - fake `webServer.register` 捕获路由表 → 用假的 `req`/`res` 直接调用 handler；
 *   - fake `credentials`（readRecord / modifyRecord / deleteRecord / describeRecord）
 *     用**合成**的一条合法 account 记录（token 是固定哨兵串，不是真凭据）；
 *   - 需要设备码流程时把 `globalThis.fetch` 换成 fake（绝不会出网）。
 *
 * 覆盖：
 *   P1 路由表：六条 `/codex-account/**` 全部注册（含 select；+ `/codex-sources` 仍在）
 *   P2 `state`：已登录 ⇒ `configured:true` + 账号字段；**响应字符串不含 token sentinel**
 *   P3 `state`：未登录 ⇒ `configured:false` / `reason:'signed-out'`；无凭据服务 ⇒
 *      `canLogin:false` / `reason:'no-credentials'`（且**不是** 500）
 *   P4 `status`：没有进行中的尝试 ⇒ `phase:'idle'`（不是错误、不是 500）
 *   P5 `cancel`：没有尝试也返回 `{cancelled:true}`（幂等，连调两次）
 *   P6 `logout`：**最后一个**账户的退出 = 在同一次 `modifyRecord` 里原子写空态 tombstone
 *      （`{kind:'grant', payload:{version:2, activeAccountId:null, accounts:[]}}`），
 *      **不调用 `deleteRecord`**；返回 `{configured:false}`，之后 `state` 变未登录。
 *      写入失败时（fake `modifyRecord` 抛错）返回 `{ok:false,error:'logout'}`，
 *      记录与观察身份都保持原样（不谎报成功、不作废观察）。
 *      [2026-11-25 R5] 旧实现是「事务外确认读 + `deleteRecord`」，已随竞态修复删除。
 *   P7 无凭据服务：`login` / `logout` ⇒ `{ok:false,error:'unavailable'}`；`state` 仍 200
 *   P8 方法错误：六个路由各自只接受唯一方法，其余 405 + `error:'method'`
 *   P9 `/codex-sources`：三行（含 account 行）且 account 行跟随凭据服务可用性
 *   P10 设备码登录（fake fetch）：`login` 返回 userCode / 验证页 / 毫秒到期时间 / 剩余秒数；
 *       再次 `login` **复用**当前等待（不重复申请设备码）；`status` 跟随；
 *       `cancel` 后 `status` 变 `cancelled`
 *   P11 登录请求不采信客户端参数：带 `body: {url,token}` 的请求，fake fetch 仍只收到固定端点
 *   P12 身份快照：apply 启动时刷新为 `acct:…`，退出后变 `none`（`identityOfChannel` 是同步
 *       纯函数，只能靠这条快照看到登录态变化）
 *   P14 `select`：`?id=<第二个账户>` 成功切换 active 并返回整份 accounts；非法 id / 只塞 body
 *       `{id}` / 不存在 id ⇒ 固定 `{ok:false,error:'select'}`，记录一字不动
 *
 * 用法：node tools/test-codex-account-host.mjs
 *      DSH_INDEX_UNDER_TEST=<stage/index.js> node tools/test-codex-account-host.mjs
 *
 * ⚠️ 本套件**不**联网、不读真实凭据 / 配置、不起服务、不写任何文件、不碰 DSH 账户。
 *    fake 记录里的 token 是哨兵串，任何出现在响应里的痕迹都算失败。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const HOST_UNDER_TEST = process.env.DSH_INDEX_UNDER_TEST
const hostModule = await import(HOST_UNDER_TEST
  ? pathToFileURL(resolve(HOST_UNDER_TEST)).href
  : '../index.js')
const { apply, Config } = hostModule
if (typeof apply !== 'function' || typeof Config !== 'function') {
  throw new Error('Host 模块形状不对（apply/Config 不是函数）：' + (HOST_UNDER_TEST || '../index.js'))
}
console.log('[host-under-test] ' + (HOST_UNDER_TEST ? resolve(HOST_UNDER_TEST) : 'workspace index.js'))

import { PLANS } from '../plans/index.js'
import { CODEX_ACCOUNT_DEVICE_VERIFY_URL, CODEX_ACCOUNT_RECORD_KEY, codexAccountIdentitySnapshot } from '../plans/codex-account.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else {
    failCount++
    console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''))
  }
}

/** token 哨兵：只要在响应里出现任何一处就说明**上游 token 泄漏到了浏览器**。 */
const ACCESS_SENTINEL = 'SECRET-ACCESS-SENTINEL-7f1c'
const REFRESH_SENTINEL = 'SECRET-REFRESH-SENTINEL-2b8d'
const ID_TOKEN_SENTINEL = 'SECRET-ID-TOKEN-SENTINEL-4a90'

const ROUTE_STATE = '/api/plan-usage/codex-account/state'
const ROUTE_LOGIN = '/api/plan-usage/codex-account/login'
const ROUTE_STATUS = '/api/plan-usage/codex-account/login/status'
const ROUTE_CANCEL = '/api/plan-usage/codex-account/login/cancel'
const ROUTE_SELECT = '/api/plan-usage/codex-account/select'
const ROUTE_LOGOUT = '/api/plan-usage/codex-account/logout'
const ROUTE_SOURCES = '/api/plan-usage/codex-sources'

// ---------------------------------------------------------------------------
// 夹具：fake 凭据服务 / 合成记录 / fake webServer + 真实 apply
// ---------------------------------------------------------------------------

/**
 * fake 凭据服务：合同与 `describeCodexCredentialsService` 一致（readRecord + modifyRecord），
 * 另外提供 `deleteRecord`（logout 只允许走它）与 `describeRecord`（本插件不调用，用于哨兵）。
 *
 * `options.deleteThrows` 让 `deleteRecord` 抛错：用来验证「坏记录恢复」这条**仍然**走
 * `clearCodexAccount()` 的路径（`{ok:false, reason:'delete-failed'}`）；最后一个账户的
 * 移除自 [2026-11-25 R5] 起不再调用 `deleteRecord`。
 * `options.modifyThrows` 让 `modifyRecord` 抛错：验证「写空态 tombstone 失败」时不谎报成功。
 */
function fakeCredentials(initialRecord, options) {
  const opts = options !== null && options !== undefined ? options : {}
  const records = new Map()
  if (initialRecord !== undefined && initialRecord !== null) records.set(CODEX_ACCOUNT_RECORD_KEY, initialRecord)
  const calls = { read: [], modify: [], delete: [], describe: [] }
  const service = {
    async readRecord(key) {
      calls.read.push(key)
      return records.has(key) ? records.get(key) : undefined
    },
    async modifyRecord(key, mutate) {
      calls.modify.push(key)
      if (opts.modifyThrows === true) throw new Error('synthetic-modify-failure')
      const next = await mutate(records.has(key) ? records.get(key) : undefined)
      if (next === undefined) return records.has(key) ? records.get(key) : undefined
      records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      calls.delete.push(key)
      if (opts.deleteThrows === true) throw new Error('synthetic-delete-failure')
      records.delete(key)
    },
    async describeRecord(key) {
      calls.describe.push(key)
      return undefined
    },
  }
  return { service, records, calls }
}

/** 合成一条**合法** account 记录（token 全是哨兵串，不是任何真实凭据）。 */
function syntheticRecord(overrides) {
  const payload = Object.assign({
    type: 'oauth',
    access: ACCESS_SENTINEL,
    refresh: REFRESH_SENTINEL,
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'acct-0123456789abcdef',
    credentialId: 'cred-11112222-3333-4444-5555-666677778888',
    revision: 3,
    savedAt: new Date().toISOString(),
    planType: 'plus',
    email: 'user@example.test',
    idToken: ID_TOKEN_SENTINEL,
  }, overrides)
  // `idToken` 不在记录白名单里（会判 incompatible），这里只保留 payload 白名单字段。
  delete payload.idToken
  return { kind: 'grant', payload }
}

/** 合成一条**合法**的 v2 双账户记录（第二个账户用于 select；第一个是 active）。 */
function syntheticTwoAccountRecord() {
  const first = syntheticRecord().payload
  const second = Object.assign({}, first, {
    accountId: 'acct-fedcba9876543210',
    credentialId: 'cred-99990000-1111-2222-3333-444455556666',
    revision: 1,
    planType: 'pro',
    email: 'second@example.test',
  })
  return { kind: 'grant', payload: { version: 2, activeAccountId: first.credentialId, accounts: [first, second] } }
}

/**
 * 启动一次**真实** apply：fake webServer 捕获路由，fake 服务可注入/缺省。
 *
 * @param {{credentials?: object, throwOnCredentials?: boolean}} spec
 */
function bootHost(spec) {
  const opts = spec !== null && spec !== undefined ? spec : {}
  const routes = {}
  const responses = []
  const hooks = { applyError: null, reload: null }
  const services = {
    webServer: {
      port: 12345,
      register(specification) {
        routes[specification.path] = specification.handler
        return () => { delete routes[specification.path] }
      },
    },
  }
  if (opts.credentials !== undefined && opts.credentials !== null) services.credentials = opts.credentials

  const ctx = {
    get(name) {
      if (opts.throwOnCredentials === true && name === 'credentials') throw new Error('credentials-getter-boom')
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
    webServer: services.webServer,
    // 与 DSH 的 effect 语义一致：body 立即执行，返回的 disposer 这里不需要保留。
    effect(fn) { fn(); return () => {} },
    on(name, fn) { if (name === 'app-boot/config-reload') hooks.reload = fn },
    off() {},
  }
  const disabledAll = Object.fromEntries(PLANS.map((plan) => [plan.fields.enabled, false]))
  const snapshot = new Config(Object.assign({}, disabledAll, { codexEnabled: true, codexSource: 'account' }))
  try { apply(ctx, snapshot) } catch (err) { hooks.applyError = err }

  /**
   * 调一次路由。`extra` 用来模拟「客户端塞了 body / 查询参数」这类越权输入。
   * 返回 `{status, body, text}`：`text` 是**原始响应字符串**（哨兵检查用）。
   */
  const call = async (path, method, extra) => {
    const handler = routes[path]
    if (typeof handler !== 'function') return { status: null, body: null, text: null, registered: false }
    const seen = { status: null, text: null }
    const req = Object.assign({ method: method !== undefined && method !== null ? method : 'GET' }, extra || {})
    await handler(req, {
      writeHead(status) { seen.status = status },
      end(payload) { seen.text = payload },
    })
    responses.push(String(seen.text))
    let body = null
    try { body = JSON.parse(seen.text) } catch (err) { body = null }
    return { status: seen.status, body, text: seen.text, registered: true }
  }

  return { routes, call, responses, hooks }
}

/** 让 apply 里的 fire-and-forget 异步（刷新身份快照）跑完。 */
const settle = () => new Promise((done) => setTimeout(done, 30))

/** fake fetch：由 `respond(url, init)` 决定返回，**绝不**真的出网。 */
function installFakeFetch(respond) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init !== null && init !== undefined ? init.method : undefined })
    const out = await respond(String(url), init)
    return { status: out.status, text: async () => out.text }
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

// ===========================================================================
// P1–P12：主宿主（合成记录 + fake 凭据服务）
// ===========================================================================
const cred = fakeCredentials(syntheticRecord())
const host = bootHost({ credentials: cred.service })
await settle()

check('P1a 真实 apply 不抛错（有凭据服务）', host.hooks.applyError === null,
  host.hooks.applyError && host.hooks.applyError.message)
const CODEX_ACCOUNT_ROUTES = [ROUTE_STATE, ROUTE_LOGIN, ROUTE_STATUS, ROUTE_CANCEL, ROUTE_SELECT, ROUTE_LOGOUT]
const registeredCodexAccountRoutes = Object.keys(host.routes)
  .filter((path) => path.startsWith('/api/plan-usage/codex-account/'))
check('P1b 六条 codex-account 路由全部注册（含 select；+ codex-sources 仍在）',
  registeredCodexAccountRoutes.length === 6
  && CODEX_ACCOUNT_ROUTES.every((path) => typeof host.routes[path] === 'function')
  && typeof host.routes[ROUTE_SOURCES] === 'function',
  { registered: registeredCodexAccountRoutes, all: Object.keys(host.routes) })

// --- P2 state：已登录 ---------------------------------------------------------
const stateSignedIn = await host.call(ROUTE_STATE)
const stateData = stateSignedIn.body !== null && stateSignedIn.body.data !== null ? stateSignedIn.body.data : {}
check('P2a state 已登录 ⇒ configured:true / canLogin:true',
  stateSignedIn.status === 200 && stateSignedIn.body.ok === true
  && stateData.configured === true && stateData.canLogin === true, stateSignedIn.body)
check('P2b state 账号字段只含白名单（label/planType/maskedId）',
  stateData.account !== undefined
  && Object.keys(stateData.account).sort().join(',') === 'label,maskedId,planType'
  && stateData.account.label === 'user@example.test'
  && stateData.account.planType === 'plus'
  && typeof stateData.account.maskedId === 'string' && stateData.account.maskedId.length > 0,
  stateData.account)
// [2026-11-23 多账户] 闭集扩到多账户字段：`activeAccountId` + `accounts` 也在白名单里
// （`reason` 只在失败态出现，这里登录成功所以不出现）。仍然只允许闭集内的字段。
const STATE_WIRE_KEYS = ['account', 'accounts', 'activeAccountId', 'canLogin', 'configured', 'expiresAt', 'revision']
const ACCOUNT_ENTRY_KEYS = ['active', 'id', 'label', 'maskedId', 'planType']
check('P2c state 顶层只含闭集字段（configured/canLogin/activeAccountId/account/accounts/expiresAt/revision）',
  Object.keys(stateData).every((key) => STATE_WIRE_KEYS.includes(key))
  && STATE_WIRE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(stateData, key))
  && Array.isArray(stateData.accounts)
  && stateData.accounts.every((row) => row !== null && typeof row === 'object'
    && Object.keys(row).every((key) => ACCOUNT_ENTRY_KEYS.includes(key))),
  Object.keys(stateData))
check('P2d state 给出毫秒到期时间与修订号',
  typeof stateData.expiresAt === 'number' && stateData.expiresAt > Date.now()
  && stateData.revision === 3, stateData)
check('P2e state 响应字符串不含任何 token sentinel',
  !String(stateSignedIn.text).includes(ACCESS_SENTINEL)
  && !String(stateSignedIn.text).includes(REFRESH_SENTINEL)
  && !String(stateSignedIn.text).includes(ID_TOKEN_SENTINEL),
  stateSignedIn.text)

// --- P12 身份快照（apply 启动时刷新） ----------------------------------------
const snapshotSignedIn = codexAccountIdentitySnapshot()
check('P12a apply 启动后身份快照刷新为 acct:<hash>@<credentialId前8位>（不可逆、无 token）',
  typeof snapshotSignedIn === 'string' && snapshotSignedIn.startsWith('acct:')
  // credentialId 只取前 8 位（'cred-111'），完整 id 不得出现。
  && snapshotSignedIn.includes('@cred-111') === true
  && snapshotSignedIn.includes('11112222') === false
  && !snapshotSignedIn.includes('0123456789abcdef')
  && !snapshotSignedIn.includes(ACCESS_SENTINEL),
  snapshotSignedIn)

// --- P9 /codex-sources 三行 --------------------------------------------------
const sourcesRes = await host.call(ROUTE_SOURCES)
const sourcesData = sourcesRes.body !== null && sourcesRes.body.data !== null ? sourcesRes.body.data : {}
check('P9a /codex-sources 返回三行（connect / subscription / account）',
  sourcesRes.body.ok === true && Array.isArray(sourcesData.sources) && sourcesData.sources.length === 3
  && sourcesData.sources.map((row) => row.id).join(',') === 'connect,subscription,account',
  sourcesData.sources)
check('P9b account 行跟随凭据服务可用性（enabled:true / compatible:true），selected=account',
  sourcesData.sources[2].enabled === true && sourcesData.sources[2].compatible === true
  && sourcesData.selected === 'account', sourcesData)

// --- P8 方法矩阵 -------------------------------------------------------------
const methodCases = [
  [ROUTE_STATE, 'POST'],
  [ROUTE_LOGIN, 'GET'],
  [ROUTE_STATUS, 'POST'],
  [ROUTE_CANCEL, 'GET'],
  // select 是 POST-only：GET 与其它方法都必须 405（不能被当成「无 id 的 select」）。
  [ROUTE_SELECT, 'GET'],
  [ROUTE_SELECT, 'PUT'],
  [ROUTE_LOGOUT, 'GET'],
]
let methodOk = true
const methodDetail = []
for (const [path, method] of methodCases) {
  const res = await host.call(path, method)
  const ok = res.status === 405 && res.body !== null && res.body.ok === false && res.body.error === 'method'
  if (!ok) { methodOk = false; methodDetail.push({ path, method, res }) }
}
check('P8 六条路由都只接受唯一方法（select 的 GET/PUT 也 405）+ error:method', methodOk, methodDetail)

// --- P4 status：没有进行中的登录 ---------------------------------------------
const statusIdle = await host.call(ROUTE_STATUS)
check('P4 未开始登录 ⇒ status 返回 phase/state = idle（不是错误、不是 500）',
  statusIdle.status === 200 && statusIdle.body.ok === true
  && statusIdle.body.data.phase === 'idle' && statusIdle.body.data.state === 'idle',
  statusIdle.body)

// --- P5 cancel 幂等 ----------------------------------------------------------
const cancelOnce = await host.call(ROUTE_CANCEL, 'POST')
const cancelTwice = await host.call(ROUTE_CANCEL, 'POST')
check('P5 没有尝试时 cancel 也成功且幂等（连调两次都是 {cancelled:true}）',
  cancelOnce.body.ok === true && cancelOnce.body.data.cancelled === true
  && cancelTwice.body.ok === true && cancelTwice.body.data.cancelled === true,
  { cancelOnce: cancelOnce.body, cancelTwice: cancelTwice.body })

// --- P6 logout ---------------------------------------------------------------
// [2026-11-25 R5] 最后一个账户的退出**不再删除记录**：`removeCodexAccount()` 在 `modifyRecord`
// 的独占写里把它改写成空态 tombstone，读取判 `absent` ⇒ Host 仍回 `{configured:false}`。
// 旧的「事务外确认读 + `deleteRecord`」有竞态（确认之后、删除之前别人新增的账户会被一起删），
// 所以这里同时断言 **零 `deleteRecord`**。
const deleteCallsBefore = cred.calls.delete.length
const modifyCallsBefore = cred.calls.modify.length
const logoutRes = await host.call(ROUTE_LOGOUT, 'POST')
await settle()
check('P6a logout 返回 {configured:false}',
  logoutRes.status === 200 && logoutRes.body.ok === true && logoutRes.body.data.configured === false,
  logoutRes.body)
check('P6b logout 只动本插件私有记录 dsh-usage-dock/codex，且**不**调用 deleteRecord',
  cred.calls.delete.length - deleteCallsBefore === 0
  && cred.calls.delete.every((key) => key === CODEX_ACCOUNT_RECORD_KEY)
  && cred.calls.modify.length - modifyCallsBefore === 1
  && cred.calls.modify.every((key) => key === CODEX_ACCOUNT_RECORD_KEY)
  && CODEX_ACCOUNT_RECORD_KEY === 'dsh-usage-dock/codex',
  { delete: cred.calls.delete, modify: cred.calls.modify })

const recordAfterLogout = cred.records.get(CODEX_ACCOUNT_RECORD_KEY)
check('P6c logout 后记录被改写成空态 tombstone（不是被删掉）：version:2 / activeAccountId:null / accounts:[]',
  cred.records.size === 1
  && recordAfterLogout !== undefined && recordAfterLogout.kind === 'grant'
  && recordAfterLogout.payload !== null && recordAfterLogout.payload !== undefined
  && Object.keys(recordAfterLogout.payload).sort().join(',') === 'accounts,activeAccountId,version'
  && recordAfterLogout.payload.version === 2
  && recordAfterLogout.payload.activeAccountId === null
  && Array.isArray(recordAfterLogout.payload.accounts) && recordAfterLogout.payload.accounts.length === 0,
  { size: cred.records.size, record: recordAfterLogout })

const stateAfterLogout = await host.call(ROUTE_STATE)
check('P6d logout 后 state 变未登录（configured:false / reason 为 signed-out）',
  stateAfterLogout.body.ok === true && stateAfterLogout.body.data.configured === false
  && stateAfterLogout.body.data.canLogin === true
  && stateAfterLogout.body.data.reason === 'signed-out', stateAfterLogout.body)
check('P12b logout 后身份快照变 none（旧账号额度不再参与身份）',
  codexAccountIdentitySnapshot() === 'none', codexAccountIdentitySnapshot())
check('P6e logout 响应不含 token sentinel',
  !String(logoutRes.text).includes(ACCESS_SENTINEL) && !String(logoutRes.text).includes(REFRESH_SENTINEL),
  logoutRes.text)

// ===========================================================================
// P6f–P6i：写空态 tombstone 失败时**不谎报成功、不作废观察**
// （[2026-11-25 R5] 失败点从 `deleteRecord` 移到了 `modifyRecord`；`removeCodexAccount()`
//   返回 `{ok:false, reason:'write-failed'}` ⇒ Host 回 `{ok:false,error:'logout'}`）
// ===========================================================================
const failCred = fakeCredentials(syntheticRecord(), { modifyThrows: true })
const failLogoutHost = bootHost({ credentials: failCred.service })
await settle()
const snapshotBeforeFailLogout = codexAccountIdentitySnapshot()
const failLogout = await failLogoutHost.call(ROUTE_LOGOUT, 'POST')
await settle()
const failStateAfter = await failLogoutHost.call(ROUTE_STATE)
check('P6f 写 tombstone 失败 ⇒ logout 返回 {ok:false,error:logout}（固定中文文案，不谎报成功）',
  failLogout.status === 200 && failLogout.body.ok === false && failLogout.body.error === 'logout'
  && typeof failLogout.body.message === 'string' && /[\u4e00-\u9fa5]/u.test(failLogout.body.message),
  failLogout.body)
check('P6g 写入失败后 deleteRecord 一次都没调用、modify 恰一次且参数是本插件私有记录',
  failCred.calls.delete.length === 0
  && failCred.calls.modify.length === 1 && failCred.calls.modify[0] === CODEX_ACCOUNT_RECORD_KEY
  && failCred.calls.modify.every((key) => key === 'dsh-usage-dock/codex'),
  { delete: failCred.calls.delete, modify: failCred.calls.modify })
check('P6h 写入失败后记录仍在，state 仍 configured:true（观察与身份都没有被作废）',
  failCred.records.size === 1 && failStateAfter.body.data.configured === true,
  { records: failCred.records.size, state: failStateAfter.body.data })
check('P6i 写入失败后 state 细节仍完整（账号/修订号未丢），身份快照未被清成 none',
  failStateAfter.body.ok === true && failStateAfter.body.data.revision === 3
  && failStateAfter.body.data.account !== undefined
  && codexAccountIdentitySnapshot() === snapshotBeforeFailLogout
  && codexAccountIdentitySnapshot().startsWith('acct:'),
  { state: failStateAfter.body.data, snapshot: codexAccountIdentitySnapshot() })

// ===========================================================================
// P3b / P7：没有凭据服务的部署
// ===========================================================================
const bareHost = bootHost({})
await settle()
check('P7a 无凭据服务时 apply 仍不抛错', bareHost.hooks.applyError === null,
  bareHost.hooks.applyError && bareHost.hooks.applyError.message)
const bareState = await bareHost.call(ROUTE_STATE)
check('P3b 无凭据服务 ⇒ state 200 + canLogin:false + reason:no-credentials（不是 500）',
  bareState.status === 200 && bareState.body.ok === true
  && bareState.body.data.configured === false && bareState.body.data.canLogin === false
  && bareState.body.data.reason === 'no-credentials', bareState.body)
const bareLogin = await bareHost.call(ROUTE_LOGIN, 'POST')
check('P7b 无凭据服务 ⇒ login 返回 {ok:false,error:unavailable}（固定中文 message）',
  bareLogin.status === 200 && bareLogin.body.ok === false && bareLogin.body.error === 'unavailable'
  && typeof bareLogin.body.message === 'string' && bareLogin.body.message.length > 0,
  bareLogin.body)
const bareLogout = await bareHost.call(ROUTE_LOGOUT, 'POST')
// [2026-11-23 多账户] 无凭据服务时 logout 走到 `removeCodexAccount()` 失败分支：路由固定回
// `error:'logout'` + 固定中文文案（不是 `unavailable`）。重点只有一条：**绝不谎报成功**。
check('P7c 无凭据服务 ⇒ logout 返回固定 {ok:false,error:logout} + 固定中文（不谎报成功）',
  bareLogout.status === 200 && bareLogout.body.ok === false
  && bareLogout.body.error === 'logout'
  && bareLogout.body.message === '无法退出 ChatGPT 账号登录'
  && bareLogout.body.data === undefined, bareLogout.body)
const bareSources = await bareHost.call(ROUTE_SOURCES)
check('P9c 无凭据服务 ⇒ codex-sources 里 account 行为 enabled:false（不冒充可用）',
  bareSources.body.ok === true && bareSources.body.data.sources[2].enabled === false
  && bareSources.body.data.sources[2].compatible === false, bareSources.body.data)

// 凭据 getter 抛错 ⇒ 状态不可证明（不能当成「未登录」，也不能 500）
const boomHost = bootHost({ throwOnCredentials: true })
await settle()
const boomState = await boomHost.call(ROUTE_STATE)
check('P3c 凭据服务 getter 抛错 ⇒ state 200 + canLogin:false + reason:unavailable（fail-closed）',
  boomState.status === 200 && boomState.body.ok === true
  && boomState.body.data.canLogin === false && boomState.body.data.reason === 'unavailable',
  boomState.body)

// ===========================================================================
// P10 / P11：设备码登录（fake fetch，绝不出网）
// ===========================================================================
const loginCred = fakeCredentials(undefined)
const loginHost = bootHost({ credentials: loginCred.service })
await settle()
const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const fakeFetch = installFakeFetch((url) => (url === DEVICE_CODE_URL
  ? { status: 200, text: JSON.stringify({ device_auth_id: 'dev-auth-1', user_code: 'ABCD-EFGH', interval: 5 }) }
  : { status: 500, text: '' }))
let loginStart
let loginAgain
let loginStatus
let cancelledStatus
try {
  loginStart = await loginHost.call(ROUTE_LOGIN, 'POST')
  loginAgain = await loginHost.call(ROUTE_LOGIN, 'POST', {
    // 越权输入：客户端**不该**能带 URL / token / 账号参数，Host 必须完全忽略。
    body: { url: 'https://evil.example/steal', token: 'EVIL-TOKEN', account: 'someone-else' },
    headers: { 'x-codex-url': 'https://evil.example/steal' },
  })
  const loginData = loginStart.body !== null && loginStart.body.data !== null ? loginStart.body.data : {}
  check('P10a login 返回设备码（userCode + 固定验证页，phase/state 同为 waiting）',
    loginStart.status === 200 && loginStart.body.ok === true
    && loginData.userCode === 'ABCD-EFGH'
    && loginData.phase === 'waiting' && loginData.state === 'waiting', loginData)
  check('P10b verificationUri 与 verificationUrl 双写，且是**固定**验证页',
    loginData.verificationUri === CODEX_ACCOUNT_DEVICE_VERIFY_URL
    && loginData.verificationUrl === CODEX_ACCOUNT_DEVICE_VERIFY_URL,
    { uri: loginData.verificationUri, url: loginData.verificationUrl })
  check('P10c 到期时间给毫秒 expiresAt，并换算 expiresInSeconds（≈15 分钟）与 intervalSeconds',
    typeof loginData.expiresAt === 'number' && loginData.expiresAt - Date.now() > 14 * 60 * 1000
    && typeof loginData.expiresInSeconds === 'number'
    && loginData.expiresInSeconds > 14 * 60 && loginData.expiresInSeconds <= 15 * 60
    && loginData.intervalSeconds === 5 && loginData.intervalMs === 5000, loginData)
  check('P10d login 响应不含 token sentinel 与 upstream 正文',
    !String(loginStart.text).includes(ACCESS_SENTINEL)
    && !String(loginStart.text).includes('dev-auth-1'),
    loginStart.text)

  const againData = loginAgain.body !== null && loginAgain.body.data !== null ? loginAgain.body.data : {}
  const deviceCodeCalls = fakeFetch.calls.filter((entry) => entry.url.endsWith('/usercode'))
  check('P10e 已在等待时再次 login ⇒ 复用当前设备码（不重复申请、userCode 不变）',
    againData.userCode === 'ABCD-EFGH' && againData.phase === 'waiting'
    && deviceCodeCalls.length === 1, { againData, deviceCodeCalls })

  check('P11 客户端塞进 body/header 的 URL 与 token 全部被忽略（fake fetch 只看到固定端点）',
    fakeFetch.calls.every((entry) => entry.url === DEVICE_CODE_URL)
    && !String(loginAgain.text).includes('evil.example')
    && !String(loginAgain.text).includes('EVIL-TOKEN'),
    fakeFetch.calls)

  loginStatus = await loginHost.call(ROUTE_STATUS)
  check('P10f status 跟随当前尝试（pending 词汇 + 同一 userCode + 双写验证页）',
    loginStatus.body.ok === true && loginStatus.body.data.phase === 'waiting'
    && loginStatus.body.data.userCode === 'ABCD-EFGH'
    && loginStatus.body.data.verificationUri === CODEX_ACCOUNT_DEVICE_VERIFY_URL,
    loginStatus.body)

  const cancelRes = await loginHost.call(ROUTE_CANCEL, 'POST')
  cancelledStatus = await loginHost.call(ROUTE_STATUS)
  check('P10g cancel 后 status 变 cancelled（客户端据此停止轮询）',
    cancelRes.body.ok === true && cancelRes.body.data.cancelled === true
    && cancelledStatus.body.data.phase === 'cancelled' && cancelledStatus.body.data.state === 'cancelled',
    { cancelRes: cancelRes.body, cancelledStatus: cancelledStatus.body })
} finally {
  // 无论断言结果如何都要还原 fetch 并取消定时轮询（否则进程会挂着 5 秒轮询）。
  fakeFetch.restore()
  try { await loginHost.call(ROUTE_CANCEL, 'POST') } catch (err) { /* 已取消 */ }
}

// ===========================================================================
// P3d：记录存在但不符合合同（必须如实说 incompatible，不能当「未登录」）
// ===========================================================================
const corruptCred = fakeCredentials({ kind: 'grant', payload: { type: 'oauth' } })
const corruptHost = bootHost({ credentials: corruptCred.service })
await settle()
const corruptState = await corruptHost.call(ROUTE_STATE)
check('P3d 坏记录 ⇒ state 200 + configured:false + reason:incompatible（不冒充未登录、不 500）',
  corruptState.status === 200 && corruptState.body.ok === true
  && corruptState.body.data.configured === false && corruptState.body.data.canLogin === true
  && corruptState.body.data.reason === 'incompatible', corruptState.body)

// [2026-11-23 终审 B1] 坏记录的**恢复入口**：客户端在未知态只能无 id 调 logout，
// Host 必须真的能把坏记录删掉（否则界面上的「退出登录 / 重新登录」是空承诺）。
const corruptLogout = await corruptHost.call(ROUTE_LOGOUT, 'POST')
await settle()
const corruptStateAfterLogout = await corruptHost.call(ROUTE_STATE)
check('P3e 坏记录 + 无 id logout ⇒ 成功删除记录（deleteRecord 恰一次）、state 回到 signed-out',
  corruptLogout.status === 200 && corruptLogout.body.ok === true
  && corruptLogout.body.data.configured === false
  && corruptCred.calls.delete.length === 1
  && corruptCred.calls.delete[0] === CODEX_ACCOUNT_RECORD_KEY
  && corruptCred.records.size === 0
  && corruptStateAfterLogout.body.ok === true
  && corruptStateAfterLogout.body.data.configured === false
  && corruptStateAfterLogout.body.data.reason === 'signed-out',
  {
    logout: corruptLogout.body,
    deletes: corruptCred.calls.delete,
    records: corruptCred.records.size,
    state: corruptStateAfterLogout.body,
  })

// 坏记录 + **指定 id**：没有可信 id，固定失败且记录一字不动（不猜目标、不整条删）。
const corruptIdCred = fakeCredentials({ kind: 'grant', payload: { type: 'oauth' } })
const corruptIdHost = bootHost({ credentials: corruptIdCred.service })
await settle()
const corruptIdLogout = await corruptIdHost.call(ROUTE_LOGOUT, 'POST', {
  url: ROUTE_LOGOUT + '?id=cred-11112222-3333-4444-5555-666677778888',
})
check('P3f 坏记录 + 指定 id logout ⇒ 固定 {ok:false,error:logout}，零删除、记录原样',
  corruptIdLogout.status === 200 && corruptIdLogout.body.ok === false
  && corruptIdLogout.body.error === 'logout'
  && corruptIdCred.calls.delete.length === 0
  && corruptIdCred.records.size === 1,
  { logout: corruptIdLogout.body, deletes: corruptIdCred.calls.delete, records: corruptIdCred.records.size })

// [2026-11-25 R5] 坏记录恢复**仍然**走 `clearCodexAccount()` 的 delete 语义：删除失败 ⇒
// 固定失败、不谎报成功、记录原样（这条路径没有被 tombstone 改造影响）。
const corruptDelFailCred = fakeCredentials({ kind: 'grant', payload: { type: 'oauth' } }, { deleteThrows: true })
const corruptDelFailHost = bootHost({ credentials: corruptDelFailCred.service })
await settle()
const corruptDelFailLogout = await corruptDelFailHost.call(ROUTE_LOGOUT, 'POST')
check('P3g 坏记录 + deleteRecord 抛错 ⇒ 固定 {ok:false,error:logout}、delete 恰一次、记录仍在',
  corruptDelFailLogout.status === 200 && corruptDelFailLogout.body.ok === false
  && corruptDelFailLogout.body.error === 'logout'
  && corruptDelFailCred.calls.delete.length === 1
  && corruptDelFailCred.calls.delete[0] === CODEX_ACCOUNT_RECORD_KEY
  && corruptDelFailCred.records.size === 1,
  { logout: corruptDelFailLogout.body, deletes: corruptDelFailCred.calls.delete, records: corruptDelFailCred.records.size })

// ===========================================================================
// P14 select：`?id=` 切换 active；非法 id / 只塞 body / 不存在 id ⇒ 固定失败且记录不动
// ===========================================================================
const selectRecord = syntheticTwoAccountRecord()
const SELECT_FIRST = selectRecord.payload.accounts[0].credentialId
const SELECT_SECOND = selectRecord.payload.accounts[1].credentialId
const selectCred = fakeCredentials(selectRecord)
const selectHost = bootHost({ credentials: selectCred.service })
await settle()
const selectInitial = await selectHost.call(ROUTE_STATE)
check('P14a 双账户 state ⇒ accounts 两条、active 在第一个账户',
  selectInitial.body.ok === true
  && selectInitial.body.data.accounts.length === 2
  && selectInitial.body.data.activeAccountId === SELECT_FIRST
  && selectInitial.body.data.accounts[0].active === true
  && selectInitial.body.data.accounts[1].active === false,
  selectInitial.body)

const selectOk = await selectHost.call(ROUTE_SELECT, 'POST', {
  url: ROUTE_SELECT + '?id=' + encodeURIComponent(SELECT_SECOND),
})
const selectOkData = selectOk.body !== null && selectOk.body.data !== null ? selectOk.body.data : {}
check('P14b POST select?id=<第二个账户> ⇒ 成功切 active、返回整份 accounts（不需要再发 state）',
  selectOk.status === 200 && selectOk.body.ok === true
  && selectOkData.activeAccountId === SELECT_SECOND
  && Array.isArray(selectOkData.accounts) && selectOkData.accounts.length === 2
  && selectOkData.accounts[0].active === false
  && selectOkData.accounts[1].active === true,
  selectOk.body)
check('P14c select 只改 activeAccountId：两个账户都还在、token 哨兵没有出现在响应里',
  selectCred.records.size === 1
  && selectCred.records.get(CODEX_ACCOUNT_RECORD_KEY).payload.activeAccountId === SELECT_SECOND
  && selectCred.records.get(CODEX_ACCOUNT_RECORD_KEY).payload.accounts.length === 2
  && !String(selectOk.text).includes(ACCESS_SENTINEL)
  && !String(selectOk.text).includes(REFRESH_SENTINEL),
  selectCred.records.get(CODEX_ACCOUNT_RECORD_KEY))

/** select 的三种「不可信输入」都必须固定失败、且让记录保持第二个账户 active。 */
const selectAttacks = [
  ['非法 id', { url: ROUTE_SELECT + '?id=' + encodeURIComponent('cred_bad.id space') }],
  ['只塞 body {id}（没有 query）', { body: { id: SELECT_FIRST } }],
  ['不存在的 id', { url: ROUTE_SELECT + '?id=cred-does-not-exist' }],
]
let selectGuardOk = true
const selectGuardDetail = []
for (const [label, extra] of selectAttacks) {
  const res = await selectHost.call(ROUTE_SELECT, 'POST', extra)
  const ok = res.status === 200 && res.body !== null && res.body.ok === false
    && res.body.error === 'select'
    && typeof res.body.message === 'string' && res.body.message.length > 0
    && res.body.data === undefined
  const record = selectCred.records.get(CODEX_ACCOUNT_RECORD_KEY)
  const unchanged = record !== undefined && record.payload.activeAccountId === SELECT_SECOND
  if (!ok || !unchanged) {
    selectGuardOk = false
    selectGuardDetail.push({ label, res: res.body, active: record && record.payload.activeAccountId })
  }
}
check('P14d 非法 id / 只塞 body / 不存在 id ⇒ 固定 {ok:false,error:select}，active 仍是第二个账户',
  selectGuardOk, selectGuardDetail)

// ===========================================================================
// P13：上游拒绝启动设备码 ⇒ 固定中文文案，绝不回显上游正文
// ===========================================================================
const rejectCred = fakeCredentials(undefined)
const rejectHost = bootHost({ credentials: rejectCred.service })
await settle()
const REJECT_SENTINEL = 'UPSTREAM-BODY-LEAK-3c9e'
const rejectFetch = installFakeFetch(() => ({
  status: 400,
  text: JSON.stringify({ error: 'invalid_client', detail: REJECT_SENTINEL }),
}))
let rejectRes = null
try {
  rejectRes = await rejectHost.call(ROUTE_LOGIN, 'POST')
} finally {
  rejectFetch.restore()
  try { await rejectHost.call(ROUTE_CANCEL, 'POST') } catch (err) { /* 已取消 */ }
}
check('P13 上游拒绝 ⇒ phase:failed + 固定中文安全文案（不回显 error/detail 正文）',
  rejectRes !== null && rejectRes.body.ok === true && rejectRes.body.data.phase === 'failed'
  && typeof rejectRes.body.data.message === 'string'
  && /[\u4e00-\u9fa5]/u.test(rejectRes.body.data.message)
  && !String(rejectRes.text).includes(REJECT_SENTINEL)
  && !String(rejectRes.text).includes('invalid_client'),
  rejectRes === null ? null : rejectRes.body)

// ===========================================================================
// 汇总：所有响应字符串统一做一次 token 哨兵扫描
// ===========================================================================
const allResponses = [].concat(host.responses, bareHost.responses, boomHost.responses, loginHost.responses,
  corruptHost.responses, corruptIdHost.responses, rejectHost.responses, failLogoutHost.responses,
  selectHost.responses)
const leaked = allResponses.filter((text) => text.includes(ACCESS_SENTINEL)
  || text.includes(REFRESH_SENTINEL) || text.includes(ID_TOKEN_SENTINEL) || text.includes('Bearer'))
check('S1 全部路由响应中没有 token sentinel / Bearer / id_token 痕迹（共 ' + allResponses.length + ' 条）',
  leaked.length === 0, leaked.slice(0, 3))

console.log('\n' + passCount + ' passed, ' + failCount + ' failed')
if (failCount > 0) process.exitCode = 1
