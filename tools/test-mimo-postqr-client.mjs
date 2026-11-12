/**
 * [post-QR local · 定向离线回归] G1 同意 / G2 身份意图 / G3 一次性 readBalance / G4 比对
 *
 * 只本地合成：所有 fetch 由本文件接管（未知端点直接抛错），无 SDK/browser/服务/端口/DNS/HTTPS/
 * 真实 profile/cfg/凭据/日志/手机扫码/余额。raw userId/cUserId 只喂 dummy 值。
 *
 * 跑法：node tools/test-mimo-postqr-client.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
const plainLog = console.log.bind(console)
function check(name, cond, detail) {
  if (cond) { passCount += 1; plainLog('[PASS] ' + name) }
  else { failCount += 1; plainLog('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 320) : '')) }
}
function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 14) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined && typeof node.type === 'string') {
    out.push(node)
    elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
  }
  return out
}
function byAttr(tree, attr, value) {
  return elementsOf(tree).filter((el) => el.props && (value === undefined ? el.props[attr] !== undefined : el.props[attr] === value))
}
function textAll(tree) { return elementsOf(tree).map((el) => textOf(el)).join('') }

const TICKET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const BOOT = '0123456789abcdef0123456789abcdef'
const DUMMY_UID = 'dummy-user-0001'
const DUMMY_CID = 'dummy-cuser-0002'

function installFetch() {
  const calls = []
  const state = { responder: null }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const entry = {
      url: String(url).split('?')[0],
      method: init && init.method !== undefined ? init.method : 'GET',
      body: init && typeof init.body === 'string' ? init.body : null,
      signal: init ? init.signal : undefined,
    }
    calls.push(entry)
    if (state.responder === null) throw new Error('unexpected fetch: ' + entry.url)
    return state.responder(entry, calls)
  }
  return {
    calls, realFetch,
    setResponder(fn) { state.responder = fn },
    reset() { calls.length = 0 },
    actions(name) {
      return calls.filter((c) => c.method === 'POST' && c.body !== null)
        .map((c) => JSON.parse(c.body)).filter((b) => b.action === name)
    },
  }
}
function jsonRes(body, status = 200) { return { status, json: async () => body } }
function qrRes() {
  return { status: 200, headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'image/png' : null) }, blob: async () => ({ type: 'image/png', size: 8 }) }
}
function installTimers(pollMs) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled = []
  globalThis.setTimeout = function (fn, ms) {
    if (ms === pollMs) { const rec = { fn, fired: false }; scheduled.push(rec); return 'pq-' + scheduled.length }
    return realSetTimeout(fn, ms)
  }
  globalThis.clearTimeout = function (id) {
    if (typeof id === 'string' && id.indexOf('pq-') === 0) return
    return realClearTimeout(id)
  }
  return {
    scheduled,
    reset() { scheduled.length = 0 },
    lastUnfired() { for (let i = scheduled.length - 1; i >= 0; i -= 1) if (scheduled[i].fired !== true) return scheduled[i]; return null },
    fireNext() { const rec = this.lastUnfired(); if (rec === null) return false; rec.fired = true; return rec.fn() },
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout },
  }
}

const runtime = createRuntime()
const form = {
  value: { enabled: true, mimoEnabled: true, planOrder: '[]', customBalances: [] },
  writes: [], mutations: [],
  getSnapshot() { return { value: this.value, writable: true } },
  subscribe() { return () => {} },
  set(field) { this.writes.push({ field }); return Promise.resolve(true) },
  mutate(ops) { this.mutations.push(ops); return Promise.resolve(true) },
}
const client = loadClient(runtime, { form })
const fetcher = installFetch()            // 必须在 loadClient 之后
const api = client.module.mimoAuth
const timers = installTimers(api.pollMs)
const Panel = api.LegacyPanel
const props = { disabled: false }
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
async function drain(rounds = 4) { for (let i = 0; i < rounds; i += 1) await new Promise((r) => realSetTimeout(r, 0)) }

const capability = { ok: true, supported: true, bootEpoch: BOOT, flow: 'qr-memory' }
const startReply = { ok: true, code: 'E_NONE', bootEpoch: BOOT, flow: 'qr-memory', ticketId: TICKET, generation: 1 }
const ackOk = { ok: true, code: 'E_NONE', bootEpoch: BOOT }
function runningReply(extra) {
  return Object.assign({
    ok: true, code: 'E_NONE', bootEpoch: BOOT, state: 'running', remainingMs: 60000, hasQr: true,
    approval: null, identity: null, balance: null, failure: null,
  }, extra || {})
}
function withIdentity(masked) {
  return Object.assign(runningReply(), { identity: { maskedLabel: masked } })
}

async function openReady(responder) {
  fetcher.setResponder(responder)
  runtime.mount(Panel, props)
  let tree = await runtime.settle(props)
  byAttr(tree, 'data-mimo-auth', 'entry')[0].props.onClick()
  await drain(3)
  return runtime.settle(props)
}
async function typePair(tree, uid, cid) {
  const uidInput = byAttr(tree, 'data-mimo-auth-postqr-input', 'userId')[0]
  const cidInput = byAttr(tree, 'data-mimo-auth-postqr-input', 'cUserId')[0]
  if (uidInput !== undefined) uidInput.props.onChange({ target: { value: uid } })
  let next = await runtime.settle(props)
  const cidNext = byAttr(next, 'data-mimo-auth-postqr-input', 'cUserId')[0]
  if (cidNext !== undefined) cidNext.props.onChange({ target: { value: cid } })
  return runtime.settle(props)
}
async function tickConsent(tree) {
  byAttr(tree, 'data-mimo-auth-postqr-consent')[0].props.onChange({ target: { checked: true } })
  return runtime.settle(props)
}
async function clickStart(tree) {
  await byAttr(tree, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain(3)
  return runtime.settle(props)
}

// ---------------------------------------------------------------------------
// P1 默认关闭：未勾选时 start body 的 postQrConsent=false，且不出现输入框
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'status') return jsonRes(runningReply())
    return jsonRes(ackOk)
  })
  const box = byAttr(ready, 'data-mimo-auth-postqr-consent')[0]
  check('P1 默认关闭：G1 勾选框存在且未勾选、无 typed 输入框',
    box !== undefined && box.props.checked === false
    && byAttr(ready, 'data-mimo-auth-postqr-input').length === 0)
  const created = await clickStart(ready)
  const startBody = fetcher.actions('start')[0]
  check('P2 未勾选时 start 显式 postQrConsent=false（且不带 digest）',
    startBody.postQrConsent === false && startBody.expectedIdentityDigest === undefined,
    Object.keys(startBody))
  check('P3 旧 QR-only 路径不受影响（created 相位有 begin）', byAttr(created, 'data-mimo-auth', 'begin').length === 1)
}

// ---------------------------------------------------------------------------
// P4/P5 勾选后：本机 dummy typed → 只发 64hex digest；算完立即清 input.value/state；同 tick 锁定
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'status') return jsonRes(withIdentity('ab***'))
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  // 关键：不 settle，直接用「typed 之前那次渲染」的树点 start（同 tick）
  await byAttr(typed, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain(4)
  const created = await runtime.settle(props)
  const startBody = fetcher.actions('start')[0]
  check('P4 同 tick 勾选+typed 后 start：postQrConsent=true、accountType 固定、digest 为 64hex',
    startBody.postQrConsent === true && startBody.expectedAccountType === 'mimo-platform'
    && typeof startBody.expectedIdentityDigest === 'string'
    && /^[0-9a-f]{64}$/.test(startBody.expectedIdentityDigest),
    { keys: Object.keys(startBody), onCount: byAttr(typed, 'data-mimo-auth-postqr-input').length,
      consentOn: byAttr(typed, 'data-mimo-auth-postqr')[0] === undefined ? null : byAttr(typed, 'data-mimo-auth-postqr')[0].props['data-mimo-auth-postqr'],
      uidProps: byAttr(typed, 'data-mimo-auth-postqr-input', 'userId')[0].props.value,
      cidProps: byAttr(typed, 'data-mimo-auth-postqr-input', 'cUserId')[0].props.value,
      notice: byAttr(created, 'data-mimo-auth-postqr-code').map((el) => el.props['data-mimo-auth-postqr-code']),
      consentValue: startBody.postQrConsent })
  const uidNow = byAttr(created, 'data-mimo-auth-postqr-input', 'userId')[0]
  const cidNow = byAttr(created, 'data-mimo-auth-postqr-input', 'cUserId')[0]
  const domText = JSON.stringify(elementsOf(created).map((el) => el.props && typeof el.props.value === 'string' ? el.props.value : ''))
  check('P5 算完即清：input.value 空、raw dummy 值不出现在任何 value 属性里',
    (uidNow === undefined || uidNow.props.value === '') && (cidNow === undefined || cidNow.props.value === '')
    && !domText.includes(DUMMY_UID) && !domText.includes(DUMMY_CID))
  check('P6 start body 不含 raw userId/cUserId', JSON.stringify(startBody).indexOf(DUMMY_UID) === -1
    && JSON.stringify(startBody).indexOf(DUMMY_CID) === -1)
}

// ---------------------------------------------------------------------------
// P7 缺 crypto.subtle → 不降级：postQrConsent=false + 固定码提示
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const savedCrypto = globalThis.crypto
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  try {
    Object.defineProperty(globalThis, 'crypto', { value: { subtle: undefined }, configurable: true })
  } catch (err) { /* 环境不允许时忽略 */ }
  await byAttr(typed, 'data-mimo-auth', 'start')[0].props.onClick()
  await drain(4)
  const after = await runtime.settle(props)
  const startBody = fetcher.actions('start')[0]
  check('P7 无 crypto.subtle ⇒ postQrConsent=false + 显示固定码（不降级、不泄露原始值）',
    startBody !== undefined && startBody.postQrConsent === false
    && startBody.expectedIdentityDigest === undefined
    && byAttr(after, 'data-mimo-auth-postqr-code', 'E_MIMO_AUTH_POSTQR_DISABLED').length === 1,
    startBody === undefined ? null : Object.keys(startBody))
  Object.defineProperty(globalThis, 'crypto', { value: savedCrypto, configurable: true })
}

// ---------------------------------------------------------------------------
// P8/P9 G2：只显示 Host mask + 本人意图；ACK 无 state 也不 E_UNKNOWN；status 不触发余额
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'status') return jsonRes(withIdentity('ab***'))
    if (body.action === 'confirmIdentity') return jsonRes(ackOk)   // 真实 ACK：三键无 state
    return jsonRes(ackOk)
  })
  void 0
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(4)
  const running = await runtime.settle(props)
  const idNode = byAttr(running, 'data-mimo-auth-identity')[0]
  check('P8 G2 只显示 Host 提供的 mask（无原始账号）',
    idNode !== undefined && String(idNode.props['data-mimo-auth-identity']) === 'ab***'
    && !textAll(running).includes(DUMMY_UID),
    { has: idNode === undefined ? null : String(idNode.props['data-mimo-auth-identity']),
      text: textAll(running).slice(0, 200) })
  const matchBtn = byAttr(running, 'data-mimo-auth', 'identity-match')[0]
  const statusBefore = fetcher.actions('status').length
  await matchBtn.props.onClick()
  await drain(4)
  const afterMatch = await runtime.settle(props)
  const ciBody = fetcher.actions('confirmIdentity')[0]
  check('P9 confirmIdentity body 精确（含 verdict=match，无 URL/ID）',
    ciBody !== undefined && ciBody.verdict === 'match'
    && Object.keys(ciBody).sort().join(',') === 'action,bootEpoch,generation,ticketId,verdict',
    ciBody === undefined ? null : Object.keys(ciBody))
  check('P10 ACK 无 state 不被当快照：不 failed/E_UNKNOWN，且补一次真实 status',
    !textAll(afterMatch).includes('E_UNKNOWN')
    && byAttr(afterMatch, 'data-mimo-auth-panel', 'failed').length === 0
    && fetcher.actions('status').length === statusBefore + 1,
    { status: fetcher.actions('status').length, before: statusBefore })
  check('P11 G2 match 不代 G3：readBalance 仍为 0', fetcher.actions('readBalance').length === 0)
  check('P12 G2 之后才出现「读取一次余额」按钮', byAttr(afterMatch, 'data-mimo-auth', 'read-balance').length === 1)
}

// ---------------------------------------------------------------------------
// P13/P14 G3：readBalance 严格 body + 双击只 1 次 + 余额 4 键投影
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  let phase2 = false
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'confirmIdentity') { phase2 = true; return jsonRes(ackOk) }
    if (body.action === 'readBalance') return jsonRes(ackOk)
    if (body.action === 'status') {
      if (phase2 !== true) return jsonRes(withIdentity('cd***'))
      return jsonRes(Object.assign(withIdentity('cd***'), {
        awaitingBalanceMatch: true, balance: { balance: 0, cashBalance: 0, giftBalance: 0, currency: 'CNY' },
      }))
    }
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(3)
  let tree = await runtime.settle(props)
  await byAttr(tree, 'data-mimo-auth', 'identity-match')[0].props.onClick()
  await drain(4)
  tree = await runtime.settle(props)
  const rbBtn = byAttr(tree, 'data-mimo-auth', 'read-balance')[0]
  await rbBtn.props.onClick()
  await drain(2)
  await rbBtn.props.onClick()          // 双击
  await drain(4)
  const after = await runtime.settle(props)
  const rb = fetcher.actions('readBalance')
  check('P13 readBalance body 精确 = action/bootEpoch/generation/ticketId（无 approvalId/URL）',
    rb.length >= 1 && Object.keys(rb[0]).sort().join(',') === 'action,bootEpoch,generation,ticketId',
    rb[0] === undefined ? null : Object.keys(rb[0]))
  check('P14 双击/重复点击只发 1 次 readBalance（Host 仍单次权威）', rb.length === 1, rb.length)
  const text = textAll(after)
  check('P15 余额四键显示且 0 有效', text.includes('余额 0') && text.includes('CNY'),
    { balanceText: text.slice(-220) })
}

// ---------------------------------------------------------------------------
// P16 G4 later 不追加请求
// ---------------------------------------------------------------------------
{
  const before = fetcher.calls.length
  const tree = await runtime.settle(props)
  const laterBtn = byAttr(tree, 'data-mimo-auth', 'confirm-later')[0]
  if (laterBtn !== undefined) { await laterBtn.props.onClick(); await drain(4) }
  const afterCalls = fetcher.calls.slice(before).map((c) => (c.body === null ? 'GET' : JSON.parse(c.body).action))
  check('P16 G4 later 只发 confirm（不追加 readBalance/status 爆炸）',
    afterCalls.filter((a) => a === 'readBalance').length === 0, afterCalls)
}

// ---------------------------------------------------------------------------
// P17 Host 固定码 + stage 透显示，且不透上游正文
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'status') {
      return jsonRes({
        ok: true, code: 'E_NONE', bootEpoch: BOOT, state: 'failed', remainingMs: 0, hasQr: false,
        approval: null, identity: null, balance: null,
        failure: { code: 'E_MIMO_AUTH_IDENTITY_MISMATCH', stage: 'flow', message: 'UPSTREAM-SECRET-TEXT' },
      })
    }
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(4)
  const after = await runtime.settle(props)
  const text = textAll(after)
  check('P17 固定码 E_MIMO_AUTH_IDENTITY_MISMATCH + stage=flow 可见，上游正文不透传',
    text.includes('E_MIMO_AUTH_IDENTITY_MISMATCH') && text.includes('flow') && !text.includes('UPSTREAM-SECRET-TEXT'))
}

// ---------------------------------------------------------------------------
// P18 取消/关闭：清 typed 状态与敏感 UI，迟到 ACK 不复活
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'status') return jsonRes(withIdentity('ef***'))
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const back = await tickConsent(typed)      // 再勾一次让输入框重新出现（模拟用户重新输入）
  const typed2 = await typePair(back, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed2)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(3)
  let tree = await runtime.settle(props)
  byAttr(tree, 'data-mimo-auth', 'close')[0].props.onClick()
  await drain(3)
  const closed = await runtime.settle(props)
  const statusBefore = fetcher.actions('status').length
  await drain(3)
  check('P18 关闭后：回到 closed、无身份卡、不再拉 status',
    byAttr(closed, 'data-mimo-auth-panel', 'closed').length === 1
    && byAttr(closed, 'data-mimo-auth-identity').length === 0
    && fetcher.actions('status').length === statusBefore)
  // 重开后 G1 必须回到未勾选（本机同意不继承）
  const reopened = await runtime.settle(props)
  byAttr(reopened, 'data-mimo-auth', 'entry')[0].props.onClick()
  await drain(3)
  const ready2 = await runtime.settle(props)
  check('P19 重开后 G1 默认关闭（不继承上次同意）',
    byAttr(ready2, 'data-mimo-auth-postqr-consent')[0].props.checked === false)
}

// ---------------------------------------------------------------------------
// R1/R2 D-review B1：G2 只能「ACK 成功后」确认，不能乐观提前放出 G3
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  let releaseAck = null
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'confirmIdentity') return new Promise((resolve) => { releaseAck = () => resolve(jsonRes(ackOk)) })
    if (body.action === 'status') return jsonRes(withIdentity('ab***'))
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(3)
  let tree = await runtime.settle(props)
  void byAttr(tree, 'data-mimo-auth', 'identity-match')[0].props.onClick()   // ACK 故意悬挂（不 await）
  await drain(2)
  timers.fireNext()                                                          // 既有轮询先到
  await drain(3)
  tree = await runtime.settle(props)
  check('R1 延迟 confirmIdentity ACK（status 先到）⇒ 无 G3 按钮、readBalance 0',
    byAttr(tree, 'data-mimo-auth', 'read-balance').length === 0
    && fetcher.actions('readBalance').length === 0,
    { buttons: byAttr(tree, 'data-mimo-auth', 'read-balance').length, rb: fetcher.actions('readBalance').length })
  if (typeof releaseAck === 'function') releaseAck()
  await drain(4)
  tree = await runtime.settle(props)
  check('R2 ACK 成功后才出现 G3 按钮（1 个）',
    byAttr(tree, 'data-mimo-auth', 'read-balance').length === 1,
    { buttons: byAttr(tree, 'data-mimo-auth', 'read-balance').length })
  const rbBtn = byAttr(tree, 'data-mimo-auth', 'read-balance')[0]
  if (rbBtn !== undefined) { await rbBtn.props.onClick(); await drain(4) }
  check('R2b ACK 成功后 readBalance 恰好 1 次', fetcher.actions('readBalance').length === 1,
    fetcher.actions('readBalance').length)
}

// ---------------------------------------------------------------------------
// R3 confirmIdentity ACK 失败 ⇒ 0 按钮 / 0 余额，固定码保留
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'confirmIdentity') return jsonRes({ ok: false, code: 'E_MIMO_AUTH_IDENTITY_MISMATCH', bootEpoch: BOOT }, 409)
    if (body.action === 'status') return jsonRes(withIdentity('gh***'))
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(3)
  let tree = await runtime.settle(props)
  await byAttr(tree, 'data-mimo-auth', 'identity-match')[0].props.onClick()
  await drain(4)
  tree = await runtime.settle(props)
  check('R3 ACK 失败 ⇒ 无 G3 按钮、readBalance 0、显示固定码',
    byAttr(tree, 'data-mimo-auth', 'read-balance').length === 0
    && fetcher.actions('readBalance').length === 0
    && textAll(tree).includes('E_MIMO_AUTH_IDENTITY_MISMATCH'))
}

// ---------------------------------------------------------------------------
// R4 D-review B3：撤勾立即清 typed（input.value + state/ref），重勾不恢复 raw
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  byAttr(typed, 'data-mimo-auth-postqr-consent')[0].props.onChange({ target: { checked: false } })
  const off = await runtime.settle(props)
  const on2 = await tickConsent(off)
  const reTyped = await runtime.settle(props)
  void on2
  const uidNow = byAttr(reTyped, 'data-mimo-auth-postqr-input', 'userId')[0]
  const cidNow = byAttr(reTyped, 'data-mimo-auth-postqr-input', 'cUserId')[0]
  check('R4 撤勾→重勾后输入框为空（raw 未被恢复）',
    (uidNow === undefined || uidNow.props.value === '') && (cidNow === undefined || cidNow.props.value === ''),
    { uid: uidNow === undefined ? null : uidNow.props.value, cid: cidNow === undefined ? null : cidNow.props.value })
  const created = await clickStart(reTyped)
  const startBody = fetcher.actions('start')[0]
  check('R4b 重勾后直接 start 不复用旧 typed pair（consent=false、无 digest、显示固定码）',
    startBody !== undefined && startBody.postQrConsent === false
    && startBody.expectedIdentityDigest === undefined
    && byAttr(created, 'data-mimo-auth-postqr-code', 'E_MIMO_AUTH_POSTQR_DISABLED').length === 1,
    startBody === undefined ? null : Object.keys(startBody))
}

// ---------------------------------------------------------------------------
// R5 关闭后迟到 confirmIdentity ACK 不恢复同意/敏感 UI、不再拉 status
// ---------------------------------------------------------------------------
{
  fetcher.reset(); timers.reset()
  let releaseAck = null
  const ready = await openReady((call) => {
    if (call.method === 'GET' && call.body === null) return jsonRes(capability)
    if (call.url.indexOf('mimo-qr') >= 0) return qrRes()
    const body = JSON.parse(call.body)
    if (body.action === 'start') return jsonRes(startReply)
    if (body.action === 'begin') return jsonRes(ackOk)
    if (body.action === 'confirmIdentity') return new Promise((resolve) => { releaseAck = () => resolve(jsonRes(ackOk)) })
    if (body.action === 'status') return jsonRes(withIdentity('ij***'))
    return jsonRes(ackOk)
  })
  const on = await tickConsent(ready)
  const typed = await typePair(on, DUMMY_UID, DUMMY_CID)
  const created = await clickStart(typed)
  await byAttr(created, 'data-mimo-auth', 'begin')[0].props.onClick()
  await drain(3)
  let tree = await runtime.settle(props)
  void byAttr(tree, 'data-mimo-auth', 'identity-match')[0].props.onClick()
  await drain(2)
  tree = await runtime.settle(props)
  byAttr(tree, 'data-mimo-auth', 'close')[0].props.onClick()
  await drain(2)
  const closed = await runtime.settle(props)
  const statusBefore = fetcher.actions('status').length
  if (typeof releaseAck === 'function') releaseAck()
  await drain(4)
  const after = await runtime.settle(props)
  check('R5 关闭后迟到 ACK 不复活：仍 closed、无身份卡/G3、无新 status',
    byAttr(after, 'data-mimo-auth-panel', 'closed').length === 1
    && byAttr(after, 'data-mimo-auth-identity').length === 0
    && byAttr(after, 'data-mimo-auth', 'read-balance').length === 0
    && fetcher.actions('status').length === statusBefore,
    { closed: byAttr(closed, 'data-mimo-auth-panel', 'closed').length, status: fetcher.actions('status').length })
}

timers.restore()
globalThis.fetch = fetcher.realFetch
plainLog('')
plainLog('mimo-postqr: ' + String(passCount) + ' passed, ' + String(failCount) + ' failed')
process.exitCode = failCount === 0 ? 0 : 1
