/**
 * MiMo 本机显示会话（sessionDisplay）· 端到端（B8）：真实 createAuthHost + 真实 client.js
 *
 * 全合成、无网络：`createAuthHost` 的 `connection.fetch.register` handler 被桥接成
 * `globalThis.fetch`，因此 **Host DTO 形状漂移会被本测试抓到**（纯假 DTO 抓不到）。
 * UI 侧**经组件按钮**点击 start/read/confirm/grant（不注入 store 快照），
 * 并在**真实 PlanUsageBadge** 上验证胶囊与详情。
 *
 * 运行：node tools/test-mimo-display-e2e.mjs
 */
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS ' + name) } else { fail += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))) }
}
const BOOT = '0123456789abcdef0123456789abcdef'
const NS = 'mimo-platform-synthetic'
const ID_A = 'synthetic-user-1001'
const ID_B = 'synthetic-user-2002'
const SECRET = 'secret-token-e2e-must-not-leak'
const MANUAL = 99.99
const VALUE = 12.34

// —— fakeClock ——
let clock = 2000000
let timerSeq = 0
const timers = new Map()
const now = () => clock
function fakeSetTimeout(fn, ms) {
  const id = ++timerSeq
  const handle = { id, at: clock + Math.max(1, ms), unref() {} }
  timers.set(id, { fn, at: handle.at })
  return handle
}
function fakeClearTimeout(handle) {
  if (handle !== null && handle !== undefined && typeof handle.id === 'number') timers.delete(handle.id)
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}
async function advance(ms) {
  const target = clock + ms
  for (;;) {
    let nextId = null
    let nextAt = Infinity
    for (const [id, t] of timers) if (t.at <= target && t.at < nextAt) { nextId = id; nextAt = t.at }
    if (nextId === null) break
    const entry = timers.get(nextId)
    timers.delete(nextId)
    clock = entry.at
    entry.fn()
    await flush()
  }
  clock = target
  await flush()
}

// —— 合成 DI（唯一出站边界） ——
let producerCalls = 0
let verifierCalls = 0
let adapterCalls = 0
let adapterMode = 'ok'
let adapterIdentity = ID_A
let adapterGate = null
const credential = { token: SECRET }
async function displayProducer() { producerCalls += 1; return { credential } }
async function displayIdentityVerifier() { verifierCalls += 1; return { identity: { namespace: NS, identifier: adapterIdentity } } }
function okBalance() {
  return {
    ok: true,
    identity: { namespace: NS, identifier: adapterIdentity },
    balance: { balance: VALUE, cashBalance: 10, giftBalance: 2.34, currency: 'cny' },
  }
}
async function displayBalanceAdapter() {
  adapterCalls += 1
  if (adapterGate !== null) await adapterGate
  if (adapterMode === 'throw-auth') throw Object.assign(new Error('denied'), { code: 'E_MIMO_AUTH_DISPLAY_AUTH_REJECTED' })
  if (adapterMode === 'flaky') return adapterCalls % 2 === 0
    ? { ok: false, status: 503, code: 'E_BALANCE_HTTP' } : okBalance()
  if (adapterMode === 'only-gift') {
    return { ok: true, identity: { namespace: NS, identifier: adapterIdentity }, balance: { balance: 3.5, giftBalance: 3.5, currency: 'CNY' } }
  }
  return okBalance()
}

// —— fake ctx 捕获真实路由 handler ——
const registrations = []
const fakeCtx = {
  connection: { fetch: { register(spec) { registrations.push(spec); return () => {} } } },
  webServer: {},
}
const host = createAuthHost(fakeCtx, BOOT, () => {}, {
  displayProducer,
  displayIdentityVerifier,
  displayBalanceAdapter,
  displayNamespace: NS,
  now,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
})
const authSpec = registrations.filter((r) => r.path === '/api/plan-usage-mimo-auth')[0]
check('B8: 真实 createAuthHost 注册 owner-only 路由', authSpec !== undefined && registrations.length === 2)

function toRequest(init) {
  const headers = init !== undefined && init !== null && init.headers !== undefined ? init.headers : {}
  return {
    method: init !== undefined && init !== null && typeof init.method === 'string' ? init.method : 'GET',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? (headers['content-type'] || null) : null) },
    text: async () => (init !== undefined && init !== null && typeof init.body === 'string' ? init.body : ''),
  }
}
let includeManualMimo = true
function plansPayload() {
  const plans = [{ id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 }]
  if (includeManualMimo) plans.push({ id: 'mimo', name: 'Xiaomi MiMo', balance: MANUAL, currency: 'CNY', isAvailable: true })
  return { ok: true, data: { plans } }
}
const runtime = createRuntime()
const loaded = loadClient(runtime, { payload: plansPayload(), form: null })
const api = loaded.module.mimoDisplay
api.setPoll(0)
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.indexOf('/api/plan-usage-mimo-auth') >= 0) return authSpec.fetch(toRequest(init))
  if (href.indexOf('/api/plan-usage') >= 0) return { status: 200, json: async () => plansPayload() }
  throw new Error('unexpected fetch: ' + href) // 未知端点/真实网络一律抛
}

// —— 组件树辅助（用 mount/settle 保持同一 hooks 实例，按钮状态才生效） ——
const PANEL = { disabled: false }
function findAll(node, predicate, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const k of node) findAll(k, predicate, out); return out }
  if (node.props !== undefined && predicate(node)) out.push(node)
  const kids = node.props ? node.props.children : undefined
  if (Array.isArray(kids)) { for (const k of kids) findAll(k, predicate, out) } else if (kids !== undefined) findAll(kids, predicate, out)
  return out
}
function byData(node, value) { return findAll(node, (el) => el.props['data-mimo-display'] === value, []) }
function clickAction(tree, action) {
  const list = byData(tree, action)
  if (list.length === 0 || typeof list[0].props.onClick !== 'function') return false
  list[0].props.onClick()
  return true
}
async function mountPanel() {
  runtime.mount(api.Panel, PANEL)
  await runtime.settle(PANEL)
  await flush() // bootstrap 是异步的：先落定再取可交互的树
  return runtime.settle(PANEL)
}
/** 每个 case 都必须让 **DI 身份**与 start 的 expected 对齐；否则 Host 会正确拒绝
 *  （那属于真实身份校验，而不是装配问题）。这里同时断言前置条件。 */
async function startAs(identity) {
  adapterIdentity = identity
  const res = await panelFlow(identity, 'start')
  check('E2E(pre): start 成功且 verified [' + identity.slice(-4) + ']',
    res.ok === true && api.store.snapshot !== null && api.store.snapshot.state === 'verified',
    { ok: res.ok, state: api.store.snapshot && api.store.snapshot.state })
  return res
}
async function mountBadge() {
  runtime.mount(loaded.Badge, { wide: true })
  return runtime.settle({ wide: true })
}
async function openDetail(tree) {
  const pill = tree.props.children[0]
  if (pill !== null && pill !== undefined && typeof pill.props.onClick === 'function') pill.props.onClick()
  return runtime.settle({ wide: true })
}
/** 在**同一实例**里填 identifier 再点某个按钮，然后让状态落定。 */
async function panelFlow(identifier, action) {
  runtime.mount(api.Panel, PANEL)
  await runtime.settle(PANEL)
  await flush() // 等 bootstrap/capability 落定，否则首帧还没有 start 表单
  let tree = await runtime.settle(PANEL)
  if (identifier !== null) {
    const input = byData(tree, 'identifier')[0]
    if (input === undefined) return { ok: false, tree: tree, reason: 'no-input' }
    input.props.onChange({ target: { value: identifier } })
    tree = await runtime.settle(PANEL)
  }
  const ok = clickAction(tree, action)
  await flush()
  tree = await runtime.settle(PANEL)
  return { ok: ok, tree: tree, reason: '' }
}
async function panelClick(action) {
  let tree = await runtime.settle(PANEL)
  const ok = clickAction(tree, action)
  await flush()
  tree = await runtime.settle(PANEL)
  return { ok: ok, tree: tree }
}
const capsuleOf = (tree) => textOf(tree.props.children[0])
/** 直接经**已注册 handler** 取 Host 原始 displayStatus（不经过 client store）；
 *  用于把「Host 真实状态」与「client store 投影」分层断言。 */
async function hostStatus() {
  const res = await authSpec.fetch({
    method: 'POST',
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ action: 'displayStatus', bootEpoch: BOOT }),
  })
  const body = await res.json()
  const d = body !== null && body !== undefined && body.display !== undefined && body.display !== null ? body.display : {}
  return {
    httpStatus: res.status,
    state: d.state,
    displayId: d.displayId,
    generation: d.generation,
    revision: d.revision,
    balance: d.balance,
    refreshCount: d.refreshCount,
    awaitingBalanceMatch: d.awaitingBalanceMatch,
    nextRefreshAt: d.nextRefreshAt,
    code: d.code,
  }
}
/** 结束 Host 侧遗留会话并清空客户端 store：保证每段从 "无会话" 起跑。 */
async function resetHost() {
  await api.stopNow()
  await flush()
  api.reset()
  await flush()
}

try {
  // 1) 经 UI 按钮：start → read → confirm → grant
  check('E2E: 首帧前 resolving 且无快照', api.store.resolving === true && api.store.snapshot === null)
  let flow = await panelFlow(ID_A, 'start')
  check('E2E: 点击 start 有效', flow.ok === true, flow.reason)
  check('E2E: start 后 verified（producer/verifier 各 1、adapter 0）',
    api.store.snapshot !== null && api.store.snapshot.state === 'verified'
    && producerCalls === 1 && verifierCalls === 1 && adapterCalls === 0,
    { producerCalls, verifierCalls, adapterCalls, state: api.store.snapshot && api.store.snapshot.state })
  const startInputsLeft = byData(flow.tree, 'identifier')
  check('E2E: start 后输入框已清空/不再渲染', startInputsLeft.length === 0
    || startInputsLeft[0].props.value === '', startInputsLeft.length)

  let click = await panelClick('read')
  check('E2E: 点击 read 有效且 adapter 恰 1 次', click.ok === true && adapterCalls === 1, { adapterCalls })
  check('E2E: read 后有值且币种归一 CNY', api.store.snapshot.balance !== null
    && api.store.snapshot.balance.balance === VALUE && api.store.snapshot.balance.currency === 'CNY', api.store.snapshot.balance)
  click = await panelClick('confirm-match')
  check('E2E: 点击 confirm match 有效', click.ok === true)
  click = await panelClick('grant')
  check('E2E: 点击 grant 有效且 0 立即刷新', click.ok === true && adapterCalls === 1, { adapterCalls })
  check('E2E: grant 后 pending 界取消', api.store.snapshot.pendingExpiresAt === null)

  // 2) 真实 Badge：胶囊金额/币种、手工旧值被覆盖、无秘密
  let badge = await mountBadge()
  let capsule = capsuleOf(badge)
  check('E2E: 胶囊显示 Host 值 ¥12.34', capsule.indexOf('12.34') >= 0, capsule)
  check('E2E: 胶囊不再显示手工 99.99', capsule.indexOf(String(MANUAL)) < 0, capsule)
  check('E2E: 胶囊不含秘密哨兵', capsule.indexOf(SECRET) < 0)

  // 3) 打开真实详情：可见停止按钮 + 本地界说明
  badge = await openDetail(badge)
  const stopBtn = byData(badge, 'stop')
  check('E2E: 详情有可见「停止本机显示会话」', stopBtn.length === 1
    && textOf(stopBtn[0]).indexOf('停止本机显示会话') >= 0)
  check('E2E: 详情声明本地界不代表厂商有效期', textOf(badge).indexOf('不代表厂商有效期') >= 0)

  // 4) Host timer 推进一轮 → 客户端 status → 胶囊/详情更新
  const beforeTick = adapterCalls
  await advance(60000)
  check('E2E: Host 到 60 s 真刷新一次', adapterCalls === beforeTick + 1, { adapterCalls, beforeTick })
  await api.pump()
  await flush()
  badge = await mountBadge()
  check('E2E: 刷新后胶囊仍显示数值', capsuleOf(badge).indexOf('12.34') >= 0)
  check('E2E: 刷新计数到 1', api.store.snapshot.refreshCount === 1, api.store.snapshot.refreshCount)

  // 5) 重挂/收起：只 status，不产生第二个 producer/adapter/调度器，也不取消会话
  const p0 = producerCalls
  const a0 = adapterCalls
  api.release()
  await mountBadge()
  await flush()
  check('E2E: 重挂不产生新 producer/adapter', producerCalls === p0 && adapterCalls === a0)
  check('E2E: 重挂后会话仍 verified（收起 ≠ 取消）', api.store.snapshot.state === 'verified')

  // 6) pending 阶段「明确关闭」= 取消（与被动卸载区分）
  //    先确保 Host 侧没有遗留活跃会话（否则 start 会被 ACTIVE 拒绝）。
  await resetHost()
  flow = await startAs(ID_A)
  check('E2E: 新会话 verified 且未 read', api.store.snapshot.state === 'verified' && api.store.snapshot.readUsed !== true)
  const pendingClose = clickAction(flow.tree, 'close-pending')
  await flush()
  await runtime.settle(PANEL)
  check('E2E: 核对阶段显示「关闭并取消」并可点击', pendingClose === true)
  check('E2E: 关闭后 Host 会话停止清值', api.store.snapshot.state === 'stopped' && api.store.snapshot.balance === null,
    api.store.snapshot.state)
  // 反向：verified + 已 grant 的会话，被动卸载**不**取消
  await resetHost()
  await startAs(ID_A)
  await panelClick('read')
  await panelClick('confirm-match')
  await panelClick('grant')
  api.release()
  await flush()
  check('E2E: 已 grant 的被动卸载不取消（无 close-pending 触发）', api.store.snapshot.state === 'verified', api.store.snapshot.state)

  // 7) 停止在途 + 迟到响应不复活数值
  let release = null
  adapterGate = new Promise((resolve) => { release = resolve })
  await advance(60000) // 触发一次刷新（挂住）
  const stopFromDetail = await openDetail(await mountBadge())
  clickAction(stopFromDetail, 'stop')
  await flush()
  await flush()
  const stoppedView = api.view()
  check('E2E: 停止后本地立即遮蔽数值', stoppedView.state === 'stopped' && stoppedView.balance === null, stoppedView)
  adapterGate = null
  release()
  await flush()
  await api.pump()
  await flush()
  const afterLate = api.view()
  check('E2E: 迟到响应不复活数值', afterLate.state === 'stopped' && afterLate.balance === null, afterLate)
  const capsuleStopped = capsuleOf(await mountBadge())
  check('E2E: 停止后胶囊显示已停止且无金额', capsuleStopped.indexOf('已停止') >= 0
    && capsuleStopped.indexOf('12.34') < 0 && capsuleStopped.indexOf(String(MANUAL)) < 0, capsuleStopped)

  // 8) 换号：A 停止 → B（同 namespace、不同 identity）不混用 A 的数值
  adapterIdentity = ID_B
  producerCalls = 0
  verifierCalls = 0
  adapterCalls = 0
  await panelFlow(ID_B, 'start')
  check('E2E: 换号后新会话 verified 且无旧值', api.store.snapshot.state === 'verified'
    && api.store.snapshot.balance === null, api.store.snapshot.state)
  check('E2E: 换号后遮蔽标签是 B', api.store.snapshot.identity !== null
    && api.store.snapshot.identity.maskedLabel.slice(-4) === ID_B.slice(-4), api.store.snapshot.identity)

  // 9) attempt 预算：失败/成功交替也不会超过 14 次请求
  const clickRead = await panelClick('read')
  check('E2E(9pre): read 按钮存在且点击成功', clickRead.ok === true)
  const afterRead9 = await hostStatus()
  check('E2E(9pre): Host 已有值且 refreshCount=0', afterRead9.balance !== null && afterRead9.refreshCount === 0,
    { balance: afterRead9.balance, refreshCount: afterRead9.refreshCount })
  const clickConfirm = await panelClick('confirm-match')
  check('E2E(9pre): confirm 成功且 Host awaiting=false', clickConfirm.ok === true
    && (await hostStatus()).awaitingBalanceMatch === false)
  const clickGrant = await panelClick('grant')
  check('E2E(9pre): grant 成功且 Host 已排调度', clickGrant.ok === true
    && typeof (await hostStatus()).nextRefreshAt === 'number')
  const attemptsBefore = adapterCalls
  adapterMode = 'flaky'
  await advance(60000 * 14 + 1000)
  const attempts = adapterCalls - attemptsBefore
  // 先断 **Host 真实终态**（client poll=0 不自动 refresh，store 不能代表 Host），再断 client 投影。
  const hostEnd = await hostStatus()
  check('E2E: 真正走到 14 次尝试（含失败）', attempts === 14, { attempts })
  check('E2E: Host 终态 stopped+REFRESH_EXHAUSTED 且清值',
    hostEnd.state === 'stopped' && hostEnd.balance === null
    && hostEnd.code === 'E_MIMO_AUTH_DISPLAY_REFRESH_EXHAUSTED',
    { state: hostEnd.state, code: hostEnd.code })
  await api.pump()
  await flush()
  const view9 = api.view()
  check('E2E: client 投影同步 stopped 且无值', view9.state === 'stopped' && view9.balance === null, view9.state)
  adapterMode = 'ok'

  // 10) 无 status 的自主到期（120 s 无-grant 阶段界）
  await resetHost()
  await startAs(ID_A)
  check('E2E: 新会话 verified（未 read）', api.store.snapshot.state === 'verified')
  await advance(120000)
  await api.pump()
  await flush()
  const expiredView = api.view()
  check('E2E: 120 s 无操作后 Host 自主清凭据', expiredView !== null && expiredView.state === 'stopped', expiredView && expiredView.state)
  check('E2E: 过期后无值', expiredView.balance === null)

  // 11) 挂死操作 → 10 s 超时 fail-stop
  await resetHost()
  await startAs(ID_A)
  let release2 = null
  adapterGate = new Promise((resolve) => { release2 = resolve })
  await panelClick('read')
  const callsDuringHang = adapterCalls
  await advance(10000)
  await api.pump()
  await flush()
  const hung = api.view()
  check('E2E: 挂死 read 超时后 fail-stop 清值', hung !== null && hung.state === 'stopped' && hung.balance === null, hung && hung.state)
  check('E2E: 超时后不再发新请求', adapterCalls === callsDuringHang, { adapterCalls, callsDuringHang })
  adapterGate = null
  release2()
  await flush()

  // 12) throw AUTH_REJECTED ⇒ 立即停止（不是暂时失败）
  await resetHost()
  await startAs(ID_A)
  adapterMode = 'throw-auth'
  await panelClick('read')
  check('E2E: throw AUTH_REJECTED ⇒ stopped 清值', api.view().state === 'stopped' && api.view().balance === null, api.view().state)
  adapterMode = 'ok'

  // 13) 缺分项不补 0
  await resetHost()
  adapterMode = 'only-gift'
  await startAs(ID_A)
  await panelClick('read')
  const detailGift = await openDetail(await mountBadge())
  check('E2E: display 来源不补「现金余额 ¥0.00」', textOf(detailGift).indexOf('现金余额：¥0.00') < 0)
  adapterMode = 'ok'

  // 14) 渠道被配置停用时不得把 MiMo 加回来（B5）
  await resetHost()
  const disabledForm = {
    getSnapshot: () => ({ value: { mimoEnabled: false } }),
    subscribe: () => () => {},
    set: async () => undefined,
  }
  runtime.mount(loaded.Badge, { wide: true, configForm: disabledForm })
  const noMimoBadge = await runtime.settle({ wide: true, configForm: disabledForm })
  check('E2E: mimoEnabled=false 时不显示 MiMo 行', capsuleOf(noMimoBadge).indexOf('MiMo') < 0, capsuleOf(noMimoBadge))
} finally {
  try { host.dispose() } catch (err) { /* 忽略 */ }
  api.setPoll(0)
  api.reset()
  loaded.restore()
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
