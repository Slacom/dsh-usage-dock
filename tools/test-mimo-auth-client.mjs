/**
 * [G1 / 2026-10-30 — 4 阻断修复回归] MiMo「实验性临时扫码」前端（离线，零网络）。
 * 合同：.diagnostics/mimo-g1-local-20261030/CONTRACT.md（23 行）
 * 阻断：.diagnostics/review-20261030/G1-UI-VERDICT.md（cancel 快照/QR MIME/非 2xx/balance）
 *
 * 跑法：node tools/test-mimo-auth-client.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
const plainLog = console.log.bind(console)
function check(name, cond, detail) {
  if (cond) { passCount += 1; plainLog('[PASS] ' + name) }
  else { failCount += 1; plainLog('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 14) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try {
        const rendered = node.type(node.props)
        if (rendered !== undefined) elementsOf(rendered, out, depth + 1)
      } catch (err) { /* 带 hooks 的组件不在此展开 */ }
    }
  }
  return out
}
function byAttr(tree, attr, value) {
  return elementsOf(tree).filter((el) => el.props && (value === undefined ? el.props[attr] !== undefined : el.props[attr] === value))
}
function textAll(tree) {
  return elementsOf(tree).map((el) => textOf(el)).join('')
}

const TICKET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
/** bootEpoch 是 hex32 opaque string（Host 侧就是字符串）；测试不得再写成 number。 */
const BOOT = '0123456789abcdef0123456789abcdef'
const STALE_BOOT = 'fedcba9876543210fedcba9876543210'
const LEAK = 'SENTINEL-BALANCE-VALUE'

function installFetch() {
  const calls = []
  const state = { responder: null }
  globalThis.fetch = async (url, init) => {
    const entry = {
      url: String(url),
      method: init && init.method !== undefined ? init.method : 'GET',
      body: init && typeof init.body === 'string' ? init.body : null,
      signal: init ? init.signal : undefined,
    }
    calls.push(entry)
    if (state.responder === null) throw new Error('unexpected fetch: ' + entry.url)
    return state.responder(entry, calls)
  }
  return {
    calls,
    setResponder(fn) { state.responder = fn },
    authCalls() { return calls.filter((c) => c.url.includes('/api/plan-usage-mimo')) },
    posts() { return calls.filter((c) => c.method === 'POST' && c.url.includes('/api/plan-usage-mimo-auth')) },
    qrCalls() { return calls.filter((c) => c.url.includes('/api/plan-usage-mimo-qr')) },
    actionCalls(action) { return this.posts().filter((c) => JSON.parse(c.body).action === action) },
    reset() { calls.length = 0 },
  }
}
function jsonRes(body, status = 200) {
  return { status, json: async () => body }
}
/** 合规 QR 响应：content-type 与 blob.type 一致。 */
function qrImageRes(type, blobType) {
  const blobEffective = blobType === undefined ? type : blobType
  return {
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? type : null) },
    blob: async () => ({ type: blobEffective, size: 8 }),
  }
}
function installTimers(pollMs) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled = []
  globalThis.setTimeout = function (fn, ms) {
    if (ms === pollMs) {
      const record = { fn, ms, fired: false }
      scheduled.push(record)
      return 'flow-' + String(scheduled.length)
    }
    return realSetTimeout(fn, ms)
  }
  globalThis.clearTimeout = function (id) {
    if (typeof id === 'string' && id.indexOf('flow-') === 0) return
    return realClearTimeout(id)
  }
  return {
    scheduled,
    reset() { scheduled.length = 0 },
    last() { return scheduled[scheduled.length - 1] },
    fire(record) { record.fired = true; return record.fn() },
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout },
  }
}

const runtime = createRuntime()
const form = {
  value: { enabled: true, mimoEnabled: true, planOrder: '[]', customBalances: [] },
  writes: [],
  mutations: [],
  getSnapshot() { return { value: this.value, writable: true } },
  subscribe() { return () => {} },
  set(field, value) { this.writes.push({ field, value }); return Promise.resolve(true) },
  mutate(ops) { this.mutations.push(ops); return Promise.resolve(true) },
}
const client = loadClient(runtime, { form })
const fetcher = installFetch()
const api = client.module.mimoAuth
const timers = installTimers(api.pollMs)
const Panel = api.Panel
const LegacyPanel = api.LegacyPanel
const AUTH_ROUTE = api.route
const QR_ROUTE = api.qrRoute

const consoleCalls = []
for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[name]
  console[name] = function (...args) { consoleCalls.push({ name }); return original.apply(console, args) }
}
const storageWrites = []
globalThis.localStorage = { setItem(k) { storageWrites.push(k) }, getItem() { return null }, removeItem() {} }
globalThis.sessionStorage = { setItem(k) { storageWrites.push(k) }, getItem() { return null }, removeItem() {} }

const panelProps = { disabled: false }
/** 全局 objectURL 桩：Node 里 fake blob 不能交给真实 createObjectURL；同时记录 revoke。 */
const createdUrls = []
const revokedUrls = []
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
URL.createObjectURL = () => { const url = 'blob:qr-' + String(createdUrls.length + 1); createdUrls.push(url); return url }
URL.revokeObjectURL = (url) => { revokedUrls.push(url) }
async function drain(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
const capability = { ok: true, supported: true, bootEpoch: BOOT, flow: 'qr-memory' }
const startReply = { ok: true, code: 'E_NONE', bootEpoch: BOOT, flow: 'qr-memory', ticketId: TICKET, generation: 1 }
const runningReply = {
  ok: true,
  code: 'E_NONE',
  bootEpoch: BOOT,
  state: 'running',
  remainingMs: 120000,
  hasQr: true,
  awaitingBalanceMatch: true,
  confirmedByUser: false,
  approval: { approvalId: 'ap-1', originText: 'https://qr.account.xiaomi.com', method: 'GET', purpose: 'longPoll', expiresAt: 4102444800000 },
  balance: null,
}
const cancelOk = { ok: true, code: 'E_NONE', bootEpoch: BOOT }

async function openPanel(responder) {
  fetcher.setResponder(responder)
  runtime.mount(LegacyPanel, panelProps)
  await byAttr(await runtime.settle(panelProps), 'data-mimo-auth', 'entry')[0].props.onClick()
  return runtime.settle(panelProps)
}
async function startSession(tree) {
  await byAttr(tree, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain(2)
  return runtime.settle(panelProps)
}
async function beginFlow(tree) {
  await byAttr(tree, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(2)
  return runtime.settle(panelProps)
}
/** 标准 responder：capability/start/begin/status(running)/其它 ok。 */
function baseResponder(overrides) {
  return (call) => {
    if (call.url === QR_ROUTE) return qrImageRes('image/png')
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes(runningReply)
    if (overrides !== undefined && overrides[body.action] !== undefined) return overrides[body.action](call)
    return jsonRes(cancelOk)
  }
}

// ---------------------------------------------------------------------------
// C1 — 普通设置页 / boot 零认证请求；既有区块保留
// ---------------------------------------------------------------------------
{
  fetcher.setResponder((call) => {
    if (call.url.includes('custom-status')) return jsonRes({ ok: true, data: { keys: {}, refs: {}, providers: [] } })
    if (call.url.includes('quota-windows')) return jsonRes({ ok: true, data: { channels: {} } })
    return jsonRes({ ok: true, data: { plans: [] } })
  })
  runtime.mount(client.SettingsPage, { form })
  const tree = await runtime.settle({ form })
  const text = textAll(tree)
  check('C1a 普通设置页不发任何 /api/plan-usage-mimo* 请求', fetcher.authCalls().length === 0, fetcher.authCalls())
  // [0.10.0 断言更新] 旧断言假设 MiMo 卡片里有**手工 mimoCookie 输入框**。
  // 现在 MiMo 的唯一入口是登录/状态面板（h(MimoAuthMount, …)），不再渲染手工 Cookie 输入；
  // 依据：client.js 里的「MiMo 唯一入口」分支（meta.id === 'mimo' ⇒ 直接挂登录面板），
  // 以及 MiMo 的 fields 只有 cookie、没有 piKey，走不到凭据输入分支。
  // 本 mock 运行时不会展开嵌套函数组件，所以这里断言「不再有手工 Cookie 输入」+
  // 「其它渠道的凭据输入仍在」（防止把「整体丢输入」误判成对）。
  check('C1b MiMo 不再渲染手工 Cookie 输入（改由登录/状态面板承担）',
    byAttr(tree, 'data-plan-credential', 'mimo').length === 0)
  check('C1b2 其它渠道的凭据输入仍在（不是整体丢了输入框）',
    byAttr(tree, 'data-plan-credential', 'deepseek').length === 1)
  check('C1c WorkBuddy 区块仍在', text.includes('WorkBuddy'))
  check('C1d 未写 ConfigForm', form.writes.length === 0 && form.mutations.length === 0)
}

// ---------------------------------------------------------------------------
// C2/C3 — 面板零副作用；点击后才 GET capability
// ---------------------------------------------------------------------------
{
  /**
   * [0.10.0 断言更新] 三处老化断言：
   *   ① 旧「首次渲染不发请求」：现在挂载会先做一次**只读**能力探测
   *      （mimoAuthRequest({})，GET、无 body），用来区分「记住登录」managed 面板与旧扫码面板
   *      —— 见 client.js MimoAuthMount 的 useEffect。
   *   ② 旧「面板默认收起」：探测返回**前**只显示「正在读取登录能力…」占位（C2a0）。
   *   ③ 旧 C3a「点击后恰好一次 GET」：现在总请求 = 探测 1 + 点击 1。
   * 真正要守的安全语义：**除只读探测外没有任何登录动作**（无 POST / 无 QR）。
   */
  fetcher.reset()
  fetcher.setResponder(() => new Promise(() => {})) // 探测永不返回
  runtime.mount(Panel, panelProps)
  const probing = await runtime.settle(panelProps)
  check('C2a0 探测返回前只显示占位文案（不渲染面板、不产生动作）',
    textAll(probing).includes('正在读取登录能力'), textAll(probing).slice(0, 80))
  check('C2b 挂载只发一次只读能力探测（GET、无 body，且无 POST/QR）',
    fetcher.authCalls().length === 1 && fetcher.authCalls()[0].method === 'GET'
    && fetcher.authCalls()[0].body === null
    && fetcher.posts().length === 0 && fetcher.qrCalls().length === 0, fetcher.authCalls())

  // 重新挂载：探测立即返回，点击入口后的那次 GET 才延迟（保持原有「opening → start」时序）
  fetcher.reset()
  let releaseClick = null
  // LegacyPanel 挂载不做探测：这次 GET 就是「点击入口」触发的那一次，故意延迟以观察 opening 文案。
  fetcher.setResponder((call) => {
    if (call.method !== 'GET') return jsonRes(cancelOk)
    return new Promise((resolve) => { releaseClick = () => resolve(jsonRes(capability)) })
  })
  runtime.mount(LegacyPanel, panelProps)
  const closed = await runtime.settle(panelProps)
  check('C2a 探测完成后面板默认收起', byAttr(closed, 'data-mimo-auth-panel', 'closed').length === 1,
    textAll(closed).slice(0, 160))
  const entry = byAttr(closed, 'data-mimo-auth', 'entry')[0]
  // [0.10.3] 本套件刻意直挂 LegacyPanel（生产已不挂载它），因此这里断言**旧面板自身**的入口文案。
  check('C2c 旧实验面板入口文案（LegacyPanel 直挂，生产不渲染）',
    byAttr(closed, 'data-mimo-auth', 'entry').length === 1
    && textAll(closed).includes('登录 MiMo（扫码）'), textAll(closed).slice(0, 160))
  const pending = entry.props.onClick()
  const mid = await runtime.settle(panelProps)
  check('C3a 点击后恰好一次 GET 且无 body（LegacyPanel 不经探测）', fetcher.authCalls().length === 1
    && fetcher.authCalls()[0].method === 'GET'
    && fetcher.authCalls()[0].url === AUTH_ROUTE
    && fetcher.authCalls()[0].body === null, fetcher.authCalls().length)
  check('C3b 请求期间显示固定 opening 文案', textAll(mid).includes('正在请求本机认证能力'))
  releaseClick()
  await pending
  check('C3c 能力就绪后显示 start', byAttr(await runtime.settle(panelProps), 'data-mimo-auth', 'start').length === 1)
}

// ---------------------------------------------------------------------------
// C4/C5 — unsupported / 403 局部退化
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  const tree = await openPanel(() => jsonRes({ ok: false, supported: false, code: 'E_MIMO_AUTH_UNAVAILABLE' }))
  const phase = byAttr(tree, 'data-mimo-auth-phase', 'unsupported')[0]
  check('C4a unsupported → 固定说明 + 固定 code', phase !== undefined
    && textOf(phase).includes('暂不支持')
    && phase.props['data-mimo-auth-code'] === 'E_MIMO_AUTH_UNAVAILABLE')
  check('C4b unsupported 后不再发请求', fetcher.authCalls().length === 1, fetcher.authCalls().length)
  check('C4c 不渲染「已登录」', !textAll(tree).includes('已登录'))
}
{
  fetcher.reset()
  const tree = await openPanel(() => jsonRes({ ok: false }, 403))
  const phase = byAttr(tree, 'data-mimo-auth-phase', 'forbidden')[0]
  check('C5a 403 → forbidden（含 owner 说明）', phase !== undefined && textOf(phase).includes('owner'))
  check('C5b 403 不白屏', byAttr(tree, 'data-mimo-auth-panel').length === 1 && textAll(tree).length > 0)
}

// ---------------------------------------------------------------------------
// C6/C7 — start：只发 action+bootEpoch；非法 ticket fail-closed；不轮询
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel(baseResponder())
  const session = await startSession(ready)
  const startBody = JSON.parse(fetcher.actionCalls('start')[0].body)
  // [0.10.0 断言更新] start body 现在多一个 \postQrConsent\（扫码后「同意/拒绝」那一步的开关，
  // 由 post-QR 改造引入，见 client.js 的 postQrNoticeHook / MIMO_AUTH_TEXT）。仍是**闭集**：
  // 只允许这四个键，且明确**不带** generation / ticket（那两个由 Host 下发）。
  check('C6a start body 只含 action+bootEpoch+allowDynamicLongPoll+postQrConsent，不带 generation/ticket',
    Object.keys(startBody).sort().join(',') === 'action,allowDynamicLongPoll,bootEpoch,postQrConsent'
    && startBody.allowDynamicLongPoll === false, Object.keys(startBody))
  check('C6b start 后进入 created（只有 begin 可推进）', byAttr(session, 'data-mimo-auth', 'begin').length === 1)
  check('C6c start 后不轮询', fetcher.actionCalls('status').length === 0 && timers.scheduled.length === 0)
  check('C6d ticket 不进 URL', fetcher.authCalls().every((c) => c.url.indexOf(TICKET) === -1))
  check('C6e 不显示「已登录」', !textAll(session).includes('已登录'))
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes({ ok: true, code: 'E_NONE', bootEpoch: BOOT, ticketId: 'NOT-HEX', generation: 1 })
    return jsonRes(cancelOk)
  })
  const bad = await startSession(ready)
  const badPhase = byAttr(bad, 'data-mimo-auth-phase', 'failed')[0]
  check('C7a 非 32hex ticket → fail-closed（E_MIMO_AUTH_FLOW）',
    badPhase !== undefined && badPhase.props['data-mimo-auth-code'] === 'E_MIMO_AUTH_FLOW')
  check('C7b 非法 ticket 后不排 timer', timers.scheduled.length === 0, timers.scheduled.length)
}

// ---------------------------------------------------------------------------
// C8/C9 — begin → running：QR 合规可渲染、approve/confirm 白名单、轮询
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel(baseResponder())
  // 动态批准必须会话级 opt-in：先勾选，再 start（值随 start 锁定）。
  byAttr(ready, 'data-mimo-auth-dynamic-optin')[0].props.onChange({ target: { checked: true } })
  await runtime.settle(panelProps)
  const session = await startSession(await runtime.settle(panelProps))
  const flow = await beginFlow(session)
  check('C8a begin 走白名单 action', fetcher.actionCalls('begin').length === 1)
  check('C8b running 才排轮询', timers.scheduled.length === 1, timers.scheduled.length)
  const statusBody = JSON.parse(fetcher.actionCalls('status').pop().body)
  check('C8c status body 用 Host generation 与 ticket', statusBody.ticketId === TICKET && statusBody.generation === 1, statusBody)
  check('C8d 合规 png blob → objectURL 渲染', byAttr(flow, 'data-mimo-auth-qr', 'shown').length === 1)
  check('C8e 显示完整 origin + GET + 固定 longPoll 用途（需先勾选本会话开关）',
    byAttr(flow, 'data-mimo-auth-origin').length === 1
    && String(byAttr(flow, 'data-mimo-auth-origin')[0].props.children) === 'https://qr.account.xiaomi.com'
    && byAttr(flow, 'data-mimo-auth-method')[0] !== undefined
    && String(byAttr(flow, 'data-mimo-auth-method')[0].props['data-mimo-auth-method']) === 'GET'
    && byAttr(flow, 'data-mimo-auth-purpose-fixed').length === 1,
    { dynamic: byAttr(flow, 'data-mimo-auth-dynamic').map((el) => el.props['data-mimo-auth-dynamic']),
      origin: byAttr(flow, 'data-mimo-auth-origin').length,
      method: byAttr(flow, 'data-mimo-auth-method').length,
      approve: byAttr(flow, 'data-mimo-auth', 'approve').length })
  await byAttr(flow, 'data-mimo-auth', 'approve')[0].props.onClick()
  const approveBody = JSON.parse(fetcher.actionCalls('approve').pop().body)
  check('C8f approve 只带 approvalId',
    approveBody.approvalId === 'ap-1'
    && Object.keys(approveBody).sort().join(',') === 'action,approvalId,bootEpoch,generation,ticketId', Object.keys(approveBody))
  await byAttr(flow, 'data-mimo-auth', 'confirm-match')[0].props.onClick()
  const confirmBody = JSON.parse(fetcher.actionCalls('confirm').pop().body)
  check('C8g confirm 只带 verdict', confirmBody.verdict === 'match'
    && Object.keys(confirmBody).sort().join(',') === 'action,bootEpoch,generation,ticketId,verdict', Object.keys(confirmBody))
  check('C9a QR 只 take 一次', fetcher.qrCalls().length === 1, fetcher.qrCalls().length)
  timers.fire(timers.last())
  await drain()
  await runtime.settle(panelProps)
  check('C9b 第二轮轮询不重复取 QR', fetcher.qrCalls().length === 1, fetcher.qrCalls().length)
  check('C9c running 持续轮询（≥2 个 timer 已排；ACK→status 也会续排）',
    timers.scheduled.length >= 2, timers.scheduled.length)
}

// ---------------------------------------------------------------------------
// C10 — QR MIME 反例
// ---------------------------------------------------------------------------
for (const [label, qrResponder] of [
  ['SVG', () => qrImageRes('image/svg+xml')],
  ['无 type blob', () => ({ status: 200, headers: { get: () => 'image/png' }, blob: async () => ({ size: 8 }) })],
  ['JSON dataURL', () => jsonRes({ dataUrl: 'data:image/png;base64,QUJD' })],
  ['header/blob 不一致', () => qrImageRes('image/png', 'image/jpeg')],
  ['text/html 头', () => qrImageRes('text/html')],
]) {
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.url === QR_ROUTE) return qrResponder(call)
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes(runningReply)
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const flow = await beginFlow(session)
  check('C10 ' + label + ' QR 被拒绝（不渲染图片）',
    byAttr(flow, 'data-mimo-auth-qr', 'shown').length === 0
    && !elementsOf(flow).some((el) => el.type === 'img'))
}

// ---------------------------------------------------------------------------
// C11 — 非 2xx 一律 ok:false
// ---------------------------------------------------------------------------
for (const [label, statusResponder] of [
  ['404+ok:true+state:running', () => jsonRes({ ok: true, code: 'E_NONE', bootEpoch: BOOT, state: 'running', hasQr: false }, 404)],
  ['500+ok:true+state:done', () => jsonRes({ ok: true, code: 'E_NONE', bootEpoch: BOOT, state: 'done' }, 500)],
  ['200+ok:false', () => jsonRes({ ok: false, code: 'E_NONE', bootEpoch: BOOT, state: 'running' }, 200)],
]) {
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return statusResponder(call)
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const after = await beginFlow(session)
  check('C11 ' + label + ' → 局部失败（不进入 running/done）',
    byAttr(after, 'data-mimo-auth-phase', 'failed').length === 1
    && byAttr(after, 'data-mimo-auth-phase', 'running').length === 0
    && byAttr(after, 'data-mimo-auth-phase', 'done').length === 0)
}

// ---------------------------------------------------------------------------
// C12 — cancel：完整 body + 独立未 abort 的 signal
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel(baseResponder({
    status: () => jsonRes({ ...runningReply, hasQr: false, approval: null, awaitingBalanceMatch: false }),
  }))
  const session = await startSession(ready)
  const flow = await beginFlow(session)
  const previousSignal = fetcher.actionCalls('status').pop().signal
  await byAttr(flow, 'data-mimo-auth', 'cancel')[0].props.onClick()
  await drain()
  const cancelCall = fetcher.actionCalls('cancel').pop()
  const cancelBody = JSON.parse(cancelCall.body)
  check('C12a cancel body 完整（action+bootEpoch+ticketId+Host generation）',
    cancelBody.action === 'cancel' && cancelBody.bootEpoch === BOOT
    && cancelBody.ticketId === TICKET && cancelBody.generation === 1, cancelBody)
  check('C12b cancel 的 signal 未被 abort（独立于轮询）',
    cancelCall.signal !== previousSignal && cancelCall.signal.aborted === false)
  const after = await runtime.settle(panelProps)
  check('C12c cancel 后终态 cancelled 且不再轮询',
    byAttr(after, 'data-mimo-auth-panel', 'cancelled').length === 1 && timers.scheduled.length === 1)
}

// ---------------------------------------------------------------------------
// C13 — close / 卸载 也按票通知 Host
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel(baseResponder({
    status: () => jsonRes({ ...runningReply, hasQr: false, approval: null, awaitingBalanceMatch: false }),
  }))
  const session = await startSession(ready)
  const flow = await beginFlow(session)
  byAttr(flow, 'data-mimo-auth', 'close')[0].props.onClick()
  await drain()
  const onClose = fetcher.actionCalls('cancel').pop()
  check('C13a close 按快照发 cancel（含 ticket）',
    onClose !== undefined && JSON.parse(onClose.body).ticketId === TICKET, onClose && onClose.body)
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel(baseResponder({
    status: () => jsonRes({ ...runningReply, hasQr: false, approval: null, awaitingBalanceMatch: false }),
  }))
  const session = await startSession(ready)
  await beginFlow(session)
  runtime.mount(Panel, panelProps)
  await drain()
  const onUnmount = fetcher.actionCalls('cancel').pop()
  check('C13b 卸载也按快照发 cancel（ticket+Host generation）',
    onUnmount !== undefined && JSON.parse(onUnmount.body).ticketId === TICKET
    && JSON.parse(onUnmount.body).generation === 1, onUnmount && onUnmount.body)
}

// ---------------------------------------------------------------------------
// C14 — 迟到响应不回填（关闭后）
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  let lateStatus = null
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return new Promise((resolve) => { lateStatus = () => resolve(jsonRes({ ...runningReply, state: 'done', confirmedByUser: true })) })
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  // status 被挂起（迟到我方控制）：这次 begin 点击不能 await，否则测试自己挂住。
  byAttr(session, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain()
  const pendingTree = await runtime.settle(panelProps)
  byAttr(pendingTree, 'data-mimo-auth', 'close')[0].props.onClick()
  await drain()
  if (typeof lateStatus === 'function') lateStatus()
  await drain()
  const after = await runtime.settle(panelProps)
  check('C14a 关闭后回到 closed', byAttr(after, 'data-mimo-auth-panel', 'closed').length === 1)
  check('C14b 迟到 done 不回填', !textAll(after).includes('已完成'))
}

// ---------------------------------------------------------------------------
// C15 — 卸载 abort 在途；C16 — objectURL revoke
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  let releaseCap = null
  fetcher.setResponder(() => new Promise((resolve) => { releaseCap = () => resolve(jsonRes(capability)) }))
  runtime.mount(LegacyPanel, panelProps)
  const tree = await runtime.settle(panelProps)
  byAttr(tree, 'data-mimo-auth', 'entry')[0].props.onClick()
  await drain(1)
  const pendingSignal = fetcher.calls.length > 0 ? fetcher.calls[0].signal : null
  runtime.mount(LegacyPanel, panelProps)
  check('C15a 卸载 abort 了在途 capability 请求', pendingSignal !== null && pendingSignal.aborted === true, pendingSignal && pendingSignal.aborted)
  if (typeof releaseCap === 'function') releaseCap()
}
{
  fetcher.reset()
  timers.reset()
  createdUrls.length = 0
  revokedUrls.length = 0
  const ready = await openPanel((call) => {
    if (call.url === QR_ROUTE) return qrImageRes('image/jpeg')
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, approval: null, awaitingBalanceMatch: false })
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const flow = await beginFlow(session)
  const firstUrl = createdUrls[0]
  check('C16a objectURL 生效并渲染', createdUrls.length >= 1
    && elementsOf(flow).some((el) => el.type === 'img' && String(el.props.src) === firstUrl))
  byAttr(flow, 'data-mimo-auth', 'close')[0].props.onClick()
  await drain()
  check('C16b 关闭时 revoke 了 objectURL', revokedUrls.indexOf(firstUrl) >= 0, revokedUrls)
}

// ---------------------------------------------------------------------------
// C17 — 余额白名单：主 balance 非法 → 整体 null
// ---------------------------------------------------------------------------
{
  const negativePrimary = api.pick({ balance: { balance: -1, cashBalance: 5, giftBalance: 3, currency: 'CNY' } })
  const missingPrimary = api.pick({ balance: { cashBalance: 5, currency: 'CNY' } })
  const stringPrimary = api.pick({ balance: { balance: '12.5', cashBalance: 5, currency: 'CNY' } })
  check('C17a 主 balance 负数 → 整体 null（即便 cash 有效）', negativePrimary.balance === null, negativePrimary.balance)
  check('C17b 主 balance 缺失 → 整体 null', missingPrimary.balance === null, missingPrimary.balance)
  check('C17c 主 balance 字符串 → 整体 null（不 Number(string)）', stringPrimary.balance === null, stringPrimary.balance)
  const good = api.pick({ balance: { balance: 12.5, cashBalance: -3, giftBalance: 2, currency: 'CNY', extra: LEAK } })
  check('C17d 合法主 balance + 负 cash → cash null、gift 保留',
    good.balance !== null && good.balance.balance === 12.5
    && good.balance.cashBalance === null && good.balance.giftBalance === 2
    && good.balance.currency === 'CNY', good.balance)
  check('C17e balance 白名单不外泄额外键', JSON.stringify(good).indexOf(LEAK) === -1)
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({ ok: true, code: 'E_NONE', bootEpoch: BOOT, state: 'done', confirmedByUser: true, balance: { balance: -1, cashBalance: 9, currency: 'CNY' } })
    }
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const done = await beginFlow(session)
  check('C17f 终态 done 但主 balance 非法 → 不显示余额行',
    byAttr(done, 'data-mimo-auth-phase', 'done').length === 1
    && byAttr(done, 'data-mimo-auth-balance').length === 0
    && !textAll(done).includes('现金'), textAll(done).slice(0, 120))
}

// ---------------------------------------------------------------------------
// C19 — bootEpoch 是 hex32 opaque string：只接受、原样透传；number/畸形一律不接受
// ---------------------------------------------------------------------------
check('C19a 合法 hex32 bootEpoch 原样透传（不 Number、不解析、不归一化）',
  api.pick({ bootEpoch: BOOT }).bootEpoch === BOOT, api.pick({ bootEpoch: BOOT }).bootEpoch)
check('C19b number 形态 bootEpoch 不接受', api.pick({ bootEpoch: 7 }).bootEpoch === null)
check('C19c 畸形 bootEpoch 不接受', api.pick({ bootEpoch: 'zz' }).bootEpoch === null
  && api.pick({ bootEpoch: BOOT.slice(0, 31) }).bootEpoch === null)
check('C19d 大写 hex 不做归一化（直接拒绝）', api.pick({ bootEpoch: BOOT.toUpperCase() }).bootEpoch === null)
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, bootEpoch: STALE_BOOT })
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const stale = await beginFlow(session)
  const stalePhase = byAttr(stale, 'data-mimo-auth-phase', 'failed')[0]
  check('C19e 旧 bootEpoch（另一个假 hex32）→ E_MIMO_AUTH_BOOT_STALE',
    stalePhase !== undefined && stalePhase.props['data-mimo-auth-code'] === 'E_MIMO_AUTH_BOOT_STALE')
}

// ---------------------------------------------------------------------------
// C20 — failure 可见性（Host `failure:{code,stage}`）＋ QR 失败 / begin 失败 / hasQr=false
// ---------------------------------------------------------------------------
{
  const okPick = api.pick({ failure: { code: 'E_NETWORK', stage: 'qr' } })
  check('C20a failure.code/stage 按合同白名单接受',
    okPick.failureCode === 'E_NETWORK' && okPick.failureStage === 'qr')
  check('C20b E_NONE 不是失败码 → E_MIMO_AUTH_FLOW',
    api.pick({ failure: { code: 'E_NONE', stage: 'flow' } }).failureCode === 'E_MIMO_AUTH_FLOW')
  const bogus = api.pick({ failure: { code: 'WHAT_EVER', stage: 'qr-image' } })
  check('C20c 未知 code/stage 折叠（不发明 qr-image 等 Host 未提供值）',
    bogus.failureCode === 'E_MIMO_AUTH_FLOW' && bogus.failureStage === 'unknown')
  check('C20d failure:null 时投影为空', api.pick({ failure: null }).failureCode === ''
    && api.pick({ failure: null }).failureStage === '')
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({ ...runningReply, state: 'failed', hasQr: false, failure: { code: 'E_NETWORK', stage: 'qr' } })
    }
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const failed = await beginFlow(session)
  const text = textAll(failed)
  check('C20e failed 的**可见文本**含固定 code 与 Host 阶段（不再只有属性）',
    text.includes('E_NETWORK') && text.includes('Host 流程阶段') && text.includes('qr'))
  check('C20f 同时标注本机动作，不冒充 Host 阶段',
    text.includes('本机动作') && byAttr(failed, 'data-mimo-auth-ui-action').length === 1)
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: false, failure: null })
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const running = await beginFlow(session)
  check('C20g hasQr=false 仍保持 pending（不制造失败）',
    byAttr(running, 'data-mimo-auth-phase', 'running').length === 1
    && byAttr(running, 'data-mimo-auth-qr', 'pending').length === 1
    && byAttr(running, 'data-mimo-auth-phase', 'failed').length === 0)
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.url === QR_ROUTE) return { status: 500, headers: { get: () => 'image/png' }, blob: async () => ({ type: 'image/png', size: 8 }) }
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: true, failure: null, approval: null, awaitingBalanceMatch: false })
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const flow = await beginFlow(session)
  check('C20h QR 取图失败在二维码区域显示固定码（会话不整页失败）',
    byAttr(flow, 'data-mimo-auth-qr', 'failed').length === 1
    && textAll(flow).includes('E_MIMO_AUTH_QR_UNAVAILABLE')
    && byAttr(flow, 'data-mimo-auth-phase', 'failed').length === 0)
  const qrNode = byAttr(flow, 'data-mimo-auth-qr-code')[0]
  check('C20h2 QR failed 区域标注本机动作 qr（含属性，不冒充 Host 阶段）',
    qrNode !== undefined && String(qrNode.props['data-mimo-auth-ui-action']) === 'qr'
    && textAll(flow).includes('本机动作')
    && !textAll(flow).includes('Host 流程阶段'))
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes({ ok: false, code: 'E_MIMO_AUTH_BEGIN_DUPLICATE' }, 409)
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const after = await beginFlow(session)
  check('C20i begin 失败 → 不进入 running、不补发 status、failure 不被覆盖',
    byAttr(after, 'data-mimo-auth-phase', 'failed').length === 1
    && fetcher.actionCalls('status').length === 0
    && textAll(after).includes('E_MIMO_AUTH_BEGIN_DUPLICATE'))
}
{
  fetcher.reset()
  timers.reset()
  const SECRET = 'COOKIE-SENTINEL-XYZ'
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({
        ...runningReply, state: 'failed', hasQr: false,
        failure: { code: 'E_NETWORK', stage: 'flow', message: SECRET, url: 'https://evil.invalid/' + SECRET, cookie: SECRET },
      })
    }
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const failed = await beginFlow(session)
  const flatProps = elementsOf(failed)
    .map((el) => Object.keys(el.props || {}).map((key) => (typeof el.props[key] === 'string' ? el.props[key] : '')).join('|'))
    .join('|')
  check('C20j failure 里的自由文本/URL/cookie 不进 view（文本与属性都不含）',
    !textAll(failed).includes(SECRET) && !flatProps.includes(SECRET))
}

// ---------------------------------------------------------------------------
// C21 — Host failure 只认 Host 白名单（本机码必须 fallback）；cancel 局部错误同口径
// ---------------------------------------------------------------------------
check('C21a Host failure 携带本机码 E_MIMO_AUTH_QR_UNAVAILABLE → fallback E_MIMO_AUTH_FLOW',
  api.pick({ failure: { code: 'E_MIMO_AUTH_QR_UNAVAILABLE', stage: 'qr' } }).failureCode === 'E_MIMO_AUTH_FLOW')
check('C21b Host failure 携带本机码 E_MIMO_AUTH_BOOT_STALE → fallback E_MIMO_AUTH_FLOW',
  api.pick({ failure: { code: 'E_MIMO_AUTH_BOOT_STALE', stage: 'flow' } }).failureCode === 'E_MIMO_AUTH_FLOW')
check('C21c Host 合法码原样通过（E_BALANCE_HTTP/balance）',
  api.pick({ failure: { code: 'E_BALANCE_HTTP', stage: 'balance' } }).failureCode === 'E_BALANCE_HTTP'
  && api.pick({ failure: { code: 'E_BALANCE_HTTP', stage: 'balance' } }).failureStage === 'balance')
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: false, failure: null, approval: null, awaitingBalanceMatch: false })
    if (body.action === 'cancel') return jsonRes({ ok: false, code: 'E_MIMO_AUTH_UNAVAILABLE' }, 500)
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const flow = await beginFlow(session)
  await byAttr(flow, 'data-mimo-auth', 'cancel')[0].props.onClick()
  await drain()
  const after = await runtime.settle(panelProps)
  const cancelNode = byAttr(after, 'data-mimo-auth-cancel')[0]
  check('C21d cancel 传输失败：固定码 + 本机动作 cancel，且不冒充 Host 阶段',
    cancelNode !== undefined
    && String(cancelNode.props['data-mimo-auth-code']) === 'E_MIMO_AUTH_UNAVAILABLE'
    && String(cancelNode.props['data-mimo-auth-ui-action']) === 'cancel'
    && !textAll(after).includes('Host 流程阶段'))
}

// ---------------------------------------------------------------------------
// C22 — logout 失败：ready 里给受控局部错误行（固定码 + 本机动作 logout）
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({ ...runningReply, state: 'done', hasQr: false, failure: null, approval: null, awaitingBalanceMatch: false, confirmedByUser: true, balance: null })
    }
    if (body.action === 'logout') return jsonRes({ ok: false, code: 'E_MIMO_AUTH_UNAVAILABLE' }, 500)
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const done = await beginFlow(session)
  await byAttr(done, 'data-mimo-auth', 'logout')[0].props.onClick()
  await drain()
  const after = await runtime.settle(panelProps)
  const node = byAttr(after, 'data-mimo-auth-local', 'unconfirmed')[0]
  const text = textAll(after)
  check('C22a logout 失败 → ready 显示固定码 + 本机动作 logout',
    byAttr(after, 'data-mimo-auth-phase', 'ready').length === 1 && node !== undefined
    && String(node.props['data-mimo-auth-code']) === 'E_MIMO_AUTH_UNAVAILABLE'
    && String(node.props['data-mimo-auth-ui-action']) === 'logout')
  check('C22b 不谎称 Host 已确认、不冒充 Host 阶段',
    text.includes('未确认') && !text.includes('已确认') && !text.includes('Host 流程阶段'))
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    return jsonRes(cancelOk)
  })
  check('C22c 正常 ready（无错误）不显示该局部错误行',
    byAttr(ready, 'data-mimo-auth-phase', 'ready').length === 1
    && byAttr(ready, 'data-mimo-auth-local').length === 0)
}

// ---------------------------------------------------------------------------
// C23 — failure.diagnostic（仅 E_URL_PURPOSE_MISMATCH + 对象）：三个固定枚举
// ---------------------------------------------------------------------------
{
  const full = api.pick({
    failure: {
      code: 'E_URL_PURPOSE_MISMATCH', stage: 'qr',
      diagnostic: { rejectedPurpose: 'qrImage', rejectedReason: 'host', hostClass: 'account-subdomain' },
    },
  })
  check('C23a 已知三枚举原样接受',
    full.diagnostic !== null && full.diagnostic.rejectedPurpose === 'qrImage'
    && full.diagnostic.rejectedReason === 'host' && full.diagnostic.hostClass === 'account-subdomain')
  const SECRET = 'SENTINEL-PURPOSE-URL'
  const dirty = api.pick({
    failure: {
      code: 'E_URL_PURPOSE_MISMATCH', stage: 'qr',
      diagnostic: {
        rejectedPurpose: 'https://' + SECRET + '/qr?x=1', rejectedReason: SECRET, hostClass: SECRET,
        url: 'https://' + SECRET, hostname: SECRET, path: '/x', query: '?x=1', sid: SECRET, raw: SECRET,
      },
    },
  })
  check('C23b 未知/非枚举 → unknown，且只保留三键、不含 URL/secret',
    dirty.diagnostic.rejectedPurpose === 'unknown' && dirty.diagnostic.rejectedReason === 'unknown'
    && dirty.diagnostic.hostClass === 'unknown'
    && Object.keys(dirty.diagnostic).sort().join(',') === 'hostClass,rejectedPurpose,rejectedReason'
    && JSON.stringify(dirty).indexOf(SECRET) === -1)
  check('C23c 非 E_URL_PURPOSE_MISMATCH 的 failure 不带诊断',
    api.pick({ failure: { code: 'E_NETWORK', stage: 'qr', diagnostic: { rejectedPurpose: 'qrImage', rejectedReason: 'host', hostClass: 'other' } } }).diagnostic === null)
  check('C23d 缺 diagnostic → null（旧 Host 兼容）',
    api.pick({ failure: { code: 'E_URL_PURPOSE_MISMATCH', stage: 'qr' } }).diagnostic === null)
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({
        ...runningReply, state: 'failed', hasQr: false,
        failure: {
          code: 'E_URL_PURPOSE_MISMATCH', stage: 'qr',
          diagnostic: { rejectedPurpose: 'qrImage', rejectedReason: 'host', hostClass: 'account-subdomain' },
        },
      })
    }
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const failed = await beginFlow(session)
  const diagNode = byAttr(failed, 'data-mimo-auth-diag', 'shown')[0]
  const text = textAll(failed)
  check('C23e 失败面板可见三枚举（含「域名类别（不是完整域名）」）',
    diagNode !== undefined
    && String(diagNode.props['data-mimo-auth-purpose']) === 'qrImage'
    && String(diagNode.props['data-mimo-auth-reason']) === 'host'
    && String(diagNode.props['data-mimo-auth-host-class']) === 'account-subdomain'
    && text.includes('被拒用途') && text.includes('拒绝原因') && text.includes('域名类别（不是完整域名）'))
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: false, failure: null })
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const running = await beginFlow(session)
  check('C23f 正常 running（failure:null）不显示诊断行',
    byAttr(running, 'data-mimo-auth-diag').length === 0)
}
{
  // 与 Host `normalizeDiagnostic` 对齐：数组不是对象形态 → null，且不渲染诊断行。
  check('C23g diagnostic 为数组 → null（不把它当对象）',
    api.pick({ failure: { code: 'E_URL_PURPOSE_MISMATCH', stage: 'qr', diagnostic: [] } }).diagnostic === null)
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({
        ...runningReply, state: 'failed', hasQr: false,
        failure: { code: 'E_URL_PURPOSE_MISMATCH', stage: 'qr', diagnostic: [] },
      })
    }
    return jsonRes(cancelOk)
  })
  const session = await startSession(ready)
  const failed = await beginFlow(session)
  check('C23h diagnostic=[] 时失败面板不显示诊断行（其余 code/stage 照常）',
    byAttr(failed, 'data-mimo-auth-diag').length === 0
    && byAttr(failed, 'data-mimo-auth-phase', 'failed').length === 1)
}

// ---------------------------------------------------------------------------
// C24 — 动态 longPoll 批准（会话级 opt-in / 完整 origin / deny / 去重）
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    return jsonRes(cancelOk)
  })
  const box = byAttr(ready, 'data-mimo-auth-dynamic-optin')[0]
  check('C24a 默认关闭：ready 时开关未勾选（data-mimo-auth-dynamic=off）',
    box !== undefined && box.props.checked === false
    && String(byAttr(ready, 'data-mimo-auth-dynamic')[0].props['data-mimo-auth-dynamic']) === 'off')
  await byAttr(ready, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain()
  const startBody = JSON.parse(fetcher.actionCalls('start').pop().body)
  check('C24b 默认 false 时 start 显式发送 allowDynamicLongPoll=false',
    startBody.allowDynamicLongPoll === false, Object.keys(startBody))
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    return jsonRes(cancelOk)
  })
  byAttr(ready, 'data-mimo-auth-dynamic-optin')[0].props.onChange({ target: { checked: true } })
  const ticked = await runtime.settle(panelProps)
  await byAttr(ticked, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain()
  const startBody = JSON.parse(fetcher.actionCalls('start').pop().body)
  check('C24c 勾选后 start 发送 allowDynamicLongPoll=true（会话锁定）',
    startBody.allowDynamicLongPoll === true, Object.keys(startBody))
  check('C24d 开关未写入 ConfigForm', form.writes.length === 0 && form.mutations.length === 0)
}
{
  // 完整长 origin（不截断）＋ GET/longPoll 才渲染批准控件
  fetcher.reset()
  timers.reset()
  const longHost = 'https://' + 'a'.repeat(40) + '.account.xiaomi.com'
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') {
      return jsonRes({ ...runningReply, hasQr: false, approval: { approvalId: 'ap-long', originText: longHost, method: 'GET', purpose: 'longPoll', expiresAt: 4102444800000 } })
    }
    return jsonRes(cancelOk)
  })
  byAttr(ready, 'data-mimo-auth-dynamic-optin')[0].props.onChange({ target: { checked: true } })
  const ticked = await runtime.settle(panelProps)
  const session = await startSession(ticked)
  const flow = await beginFlow(session)
  const originNode = byAttr(flow, 'data-mimo-auth-origin')[0]
  check('C24e 完整 origin 原样显示（不截断、无省略号）',
    originNode !== undefined && String(originNode.props.children) === longHost
    && String(originNode.props.children).indexOf('…') === -1)
  check('C24f GET + longPoll 时出现允许/拒绝两个按钮',
    byAttr(flow, 'data-mimo-auth', 'approve').length === 1 && byAttr(flow, 'data-mimo-auth', 'deny').length === 1)
  await byAttr(flow, 'data-mimo-auth', 'deny')[0].props.onClick()
  await drain()
  const denyBody = JSON.parse(fetcher.actionCalls('deny').pop().body)
  check('C24g deny 只带 approvalId（无 URL/method/purpose）',
    denyBody.approvalId === 'ap-long'
    && Object.keys(denyBody).sort().join(',') === 'action,approvalId,bootEpoch,generation,ticketId', Object.keys(denyBody))
  await byAttr(flow, 'data-mimo-auth', 'deny')[0].props.onClick()
  await drain()
  check('C24h 双击 deny 只发一次（一次性审批去重）', fetcher.actionCalls('deny').length === 1, fetcher.actionCalls('deny').length)
}
{
  // 非 longPoll / 非 GET / 非合规 origin：只给固定码，不渲染批准控件
  for (const [label, approval] of [
    ['purpose=balance', { approvalId: 'ap-x', originText: 'https://qr.account.xiaomi.com', method: 'GET', purpose: 'balance' }],
    ['method=POST', { approvalId: 'ap-x', originText: 'https://qr.account.xiaomi.com', method: 'POST', purpose: 'longPoll' }],
    ['IDN/punycode 子域', { approvalId: 'ap-x', originText: 'https://xn--fiq228c.account.xiaomi.com', method: 'GET', purpose: 'longPoll' }],
    ['带 path/query', { approvalId: 'ap-x', originText: 'https://qr.account.xiaomi.com/x?y=1', method: 'GET', purpose: 'longPoll' }],
    ['非 443', { approvalId: 'ap-x', originText: 'https://qr.account.xiaomi.com:8443', method: 'GET', purpose: 'longPoll' }],
  ]) {
    fetcher.reset()
    timers.reset()
    const ready = await openPanel((call) => {
      if (call.method === 'GET') return jsonRes(capability)
      const body = JSON.parse(call.body)
      if (body.action === 'start') return jsonRes(startReply)
      if (body.action === 'begin') return jsonRes(cancelOk)
      if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: false, approval })
      return jsonRes(cancelOk)
    })
    byAttr(ready, 'data-mimo-auth-dynamic-optin')[0].props.onChange({ target: { checked: true } })
    const session = await startSession(await runtime.settle(panelProps))
    const flow = await beginFlow(session)
    check('C24i ' + label + ' → 不渲染批准控件，只给固定码',
      byAttr(flow, 'data-mimo-auth', 'approve').length === 0
      && byAttr(flow, 'data-mimo-auth', 'deny').length === 0
      && byAttr(flow, 'data-mimo-auth-dynamic', 'invalid').length + byAttr(flow, 'data-mimo-auth-dynamic', 'out-of-scope').length === 1)
  }
}

{
  // 单标签边界：64 字符必须拒（Host 也会拒），63 字符仍可批准。
  const mk = (label) => ({
    approvalId: 'ap-' + String(label.length),
    originText: 'https://' + label + '.account.xiaomi.com',
    method: 'GET', purpose: 'longPoll', expiresAt: 4102444800000,
  })
  for (const [label, expectApprove] of [['a'.repeat(64), false], ['a'.repeat(63), true]]) {
    fetcher.reset()
    timers.reset()
    const ready = await openPanel((call) => {
      if (call.method === 'GET') return jsonRes(capability)
      const body = JSON.parse(call.body)
      if (body.action === 'start') return jsonRes(startReply)
      if (body.action === 'begin') return jsonRes(cancelOk)
      if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: false, approval: mk(label) })
      return jsonRes(cancelOk)
    })
    byAttr(ready, 'data-mimo-auth-dynamic-optin')[0].props.onChange({ target: { checked: true } })
    const session = await startSession(await runtime.settle(panelProps))
    const flow = await beginFlow(session)
    check('C24j 单标签 ' + String(label.length) + ' 字符 → ' + (expectApprove ? '可批准' : '只给固定码'),
      expectApprove
        ? byAttr(flow, 'data-mimo-auth', 'approve').length === 1
        : (byAttr(flow, 'data-mimo-auth', 'approve').length === 0
          && byAttr(flow, 'data-mimo-auth-dynamic', 'invalid').length === 1))
  }
}

// ---------------------------------------------------------------------------
// C25 — 同 tick 勾选（不重新渲染）也锁定当前值；锁值不受旧回调影响
// ---------------------------------------------------------------------------
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(cancelOk)
    if (body.action === 'status') return jsonRes({ ...runningReply, hasQr: false, failure: null })
    return jsonRes(cancelOk)
  })
  const box = byAttr(ready, 'data-mimo-auth-dynamic-optin')[0]
  box.props.onChange({ target: { checked: true } })
  // 关键：不 settle，直接用「勾选之前那次渲染」的树点 start（同一 tick）
  await byAttr(ready, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain(2)
  const startBody = JSON.parse(fetcher.actionCalls('start').pop().body)
  check('C25a 同 tick 勾 true 后立刻 start → body allowDynamicLongPoll=true',
    startBody.allowDynamicLongPoll === true, Object.keys(startBody))
  // 旧树里的 checkbox 再来一次 false：已创建会话的锁定值必须不受影响
  box.props.onChange({ target: { checked: false } })
  const created = await runtime.settle(panelProps)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(2)
  timers.fire(timers.last())
  await drain(3)
  const running = await runtime.settle(panelProps)
  check('C25b 已创建会话锁值不被旧 checkbox 回调改动（approve 仍渲染）',
    byAttr(running, 'data-mimo-auth', 'approve').length === 1
    && byAttr(running, 'data-mimo-auth-dynamic', 'opted-out').length === 0)
}
{
  fetcher.reset()
  timers.reset()
  const ready = await openPanel((call) => {
    if (call.method === 'GET') return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    return jsonRes(cancelOk)
  })
  const box = byAttr(ready, 'data-mimo-auth-dynamic-optin')[0]
  box.props.onChange({ target: { checked: true } })
  box.props.onChange({ target: { checked: false } })
  await byAttr(ready, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain(2)
  const startBody = JSON.parse(fetcher.actionCalls('start').pop().body)
  check('C25c 同 tick 勾后又撤选 → body allowDynamicLongPoll=false（不放权）',
    startBody.allowDynamicLongPoll === false, Object.keys(startBody))
}

// ---------------------------------------------------------------------------
// C18 — 全局副作用
// ---------------------------------------------------------------------------
check('C18a 全流程没有 console 调用', consoleCalls.length === 0, consoleCalls)
check('C18b 全流程没有 Storage 写入', storageWrites.length === 0, storageWrites)
check('C18c 没有把票写进 ConfigForm', form.writes.length === 0 && form.mutations.length === 0,
  { writes: form.writes.length, mutations: form.mutations.length })
check('C18d 未知 code 折成 E_UNKNOWN', api.pick({ ok: false, code: 'X-UPSTREAM-TEXT' }).code === 'E_UNKNOWN')
check('C18e 未知 state 不进入枚举', api.pick({ state: 'loading-ish' }).state === '')
check('C18f 非 32hex ticket 被拒', api.pick({ ticketId: 'zz' }).ticketId === null)

URL.createObjectURL = realCreateObjectURL
URL.revokeObjectURL = realRevokeObjectURL
timers.restore()
client.restore()
plainLog('')
plainLog('mimo-auth-client: ' + String(passCount) + ' passed, ' + String(failCount) + ' failed')
process.exitCode = failCount === 0 ? 0 : 1
