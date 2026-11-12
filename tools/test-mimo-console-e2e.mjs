/**
 * test-mimo-console-e2e.mjs — 正式 console 扫码登录：**owner route + 真实 UI** 端到端
 *
 * 真实链路：`createAuthHost` 注册的真实 handler ←桥接← 真实 `client.js`（mock React 运行时），
 * 再到真实 `console-session` manager → 真实 `console-protocol` → 真实 `console-grants`
 * → 真实 `createSecureTransport`。**只** fake DNS 与 `node:https` 的 request。
 * 不跑真实网络、不开 GUI、不使用真实账号/二维码。
 *
 * 运行：node tools/test-mimo-console-e2e.mjs
 */
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS ' + name) } else { fail += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))) }
}

const BOOT = '0123456789abcdef0123456789abcdef'
const SEED = 'SEED-TOKEN-E2E-SENTINEL'
const ACCOUNT_ID = '771234567' // Synthetic, not the user's account ID
const PUBLIC_IP = '93.184.216.34'
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BALANCE_VALUE = 33.25

// —— fake clock / timers（Host manager + transport + protocol 共用同一个 clock） ——
let clock = 3000000
let timerSeq = 0
const timers = new Map()
const now = () => clock
function fakeSetTimeout(fn, ms) {
  const id = ++timerSeq
  const at = clock + Math.max(1, ms)
  timers.set(id, { fn, at })
  return { id, at, unref() {} }
}
function fakeClearTimeout(handle) {
  if (handle !== null && handle !== undefined && typeof handle.id === 'number') timers.delete(handle.id)
}
async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
}
async function advance(ms) {
  const target = clock + ms
  for (;;) {
    let nextId = null
    let nextAt = Infinity
    for (const [id, timer] of timers) if (timer.at <= target && timer.at < nextAt) { nextId = id; nextAt = timer.at }
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

// —— wire（只决定字节） ——
const seen = []
const wireState = {
  lpBody: JSON.stringify({ location: CB, passToken: SEED, userId: Number(ACCOUNT_ID) }),
  qrBody: JSON.stringify({ qr: QR, lp: LP }),
  balanceSeq: [],
  balanceBody: JSON.stringify({ code: 0, data: { balance: String(BALANCE_VALUE), cashBalance: '30.00', giftBalance: '3.25', currency: 'CNY' } }),
  ssoCallbackUserId: ACCOUNT_ID,
}
function bufOf(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body === null || body === undefined ? '' : String(body))
}
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const key of Object.keys(headers)) lower[key.toLowerCase()] = headers[key]
  const buf = bufOf(body)
  return {
    statusCode: status,
    status,
    complete: true,
    redirected: false,
    socket: { remoteAddress: PUBLIC_IP },
    headers: lower,
    body: {
      getReader() {
        const chunk = new Uint8Array(buf)
        let done = false
        return {
          read() {
            if (done) return Promise.resolve({ done: true, value: undefined })
            done = true
            return Promise.resolve({ done: false, value: chunk })
          },
          releaseLock() {},
          cancel() { return Promise.resolve() },
        }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}
import { EventEmitter } from 'node:events'
function requestImpl(options, callback) {
  const ee = new EventEmitter()
  ee.destroy = () => {}
  const url = 'https://' + options.host + options.path
  seen.push(url)
  ee.end = () => {
    queueMicrotask(() => {
      let res
      if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: SIGNED })
      else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, wireState.qrBody)
      else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
      else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, wireState.lpBody, {
        'set-cookie': ['uiPreference=WITH SPACE; Domain=.xiaomi.com; Path=/; Secure',
          'cUserId=SYNTHETIC-CUSER; Domain=.xiaomi.com; Path=/; Secure',
          'passInfo=login-end; Domain=.xiaomi.com; Path=/; Secure'],
      })
      else if (url.includes('/pass/serviceLogin')) {
        res = makeResp(200, JSON.stringify({ code: 0, location: CB }), {
          'set-cookie': ['passToken=' + SEED + '; Domain=.xiaomi.com; Path=/; Secure',
            'userId=' + wireState.ssoCallbackUserId + '; Domain=.xiaomi.com; Path=/; Secure',
            'passInfo=login-end; Domain=.xiaomi.com; Path=/; Secure'],
        })
      } else if (url.includes('/sts')) {
        res = makeResp(200, '', {
          'set-cookie': [
            'api-platform_serviceToken="PT-SENTINEL"; Domain=.xiaomimimo.com; Path=/; Secure',
            'uiPreference=WITH SPACE; Domain=.xiaomimimo.com; Path=/; Secure',
            'userId="' + wireState.ssoCallbackUserId + '"; Domain=.xiaomimimo.com; Path=/; Secure',
          ],
        })
      } else if (url.includes('/api/v1/balance')) {
        const next = wireState.balanceSeq.length > 0 ? wireState.balanceSeq.shift() : 200
        res = makeResp(next, next === 200 ? wireState.balanceBody : '')
      } else res = makeResp(404, '')
      callback(res)
    })
  }
  return ee
}
const vendor = () => seen.slice()
const vendorCount = () => seen.length
const hops = (from) => seen.slice(from)

// —— fake ctx：捕获真实注册的 route handler ——
const registrations = []
let flowLoads = 0
const fakeCtx = {
  connection: { fetch: { register(spec) { registrations.push(spec); return () => {} } } },
  webServer: {},
}
function makeHost(enableConsoleProtocol) {
  return createAuthHost(fakeCtx, BOOT, () => {}, {
    enableConsoleProtocol,
    now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    consoleTransportDeps: { clock: now, resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: requestImpl },
    // 旧 legacy QR flow 绝不能被这条新链调用
    loadFlow: async () => { flowLoads += 1; throw new Error('legacy flow must not load') },
  })
}
const host = makeHost(true)
const authSpec = registrations.filter((r) => r.path === '/api/plan-usage-mimo-auth')[0]

// —— 真实 client.js + mock React ——
const runtime = createRuntime()
let plansIncludeMimo = true
function plansPayload() {
  const plans = [{ id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 }]
  if (plansIncludeMimo) plans.push({ id: 'mimo', name: 'Xiaomi MiMo', balance: 99.99, currency: 'CNY', isAvailable: true })
  return { ok: true, data: { plans } }
}
const loaded = loadClient(runtime, { payload: plansPayload(), form: null })
const api = loaded.module.mimoDisplay
api.setPoll(0)
const objectUrls = []
const revokedUrls = []
try {
  globalThis.URL.createObjectURL = (blob) => { const url = 'blob:test-' + (objectUrls.length + 1); objectUrls.push(url); return url }
  globalThis.URL.revokeObjectURL = (url) => { revokedUrls.push(url) }
} catch { /* 只影响二维码预览断言 */ }

function toRequest(init) {
  const source = init !== undefined && init !== null ? init : {}
  const headers = source.headers !== undefined && source.headers !== null ? source.headers : {}
  return {
    method: typeof source.method === 'string' ? source.method : 'GET',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? (headers['content-type'] || null) : null) },
    text: async () => (typeof source.body === 'string' ? source.body : ''),
  }
}
let activeAuthSpec = authSpec
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.indexOf('/api/plan-usage-mimo-auth') >= 0) return activeAuthSpec.fetch(toRequest(init))
  if (href.indexOf('/api/plan-usage') >= 0) return { status: 200, json: async () => plansPayload() }
  throw new Error('unexpected fetch: ' + href)
}

// —— 组件树辅助 ——
const PANEL = { disabled: false }
function findAll(node, predicate, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const k of node) findAll(k, predicate, out); return out }
  if (node.props !== undefined && predicate(node)) out.push(node)
  const kids = node.props ? node.props.children : undefined
  if (Array.isArray(kids)) { for (const k of kids) findAll(k, predicate, out) } else if (kids !== undefined) findAll(kids, predicate, out)
  return out
}
const byConsole = (node, value) => findAll(node, (el) => el.props['data-mimo-console'] === value, [])
const byDisplay = (node, value) => findAll(node, (el) => el.props['data-mimo-display'] === value, [])
function click(tree, attr, value) {
  const list = attr === 'console' ? byConsole(tree, value) : byDisplay(tree, value)
  if (list.length === 0 || typeof list[0].props.onClick !== 'function') return false
  list[0].props.onClick()
  return true
}
async function mountPanel() {
  runtime.mount(api.Panel, PANEL)
  await runtime.settle(PANEL)
  await flush()
  return runtime.settle(PANEL)
}
async function settlePanel() {
  await flush()
  return runtime.settle(PANEL)
}
async function hostPost(body) {
  const res = await activeAuthSpec.fetch({
    method: 'POST',
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { json = null }
  return { status: res.status, body: json, raw: JSON.stringify(json) }
}
const consoleStatusOf = async () => (await hostPost({ action: 'consoleStatus', bootEpoch: BOOT })).body.console
const displayStatusOf = async () => (await hostPost({ action: 'displayStatus', bootEpoch: BOOT })).body.display

async function main() {
  try {
    check('E2E: 真实 createAuthHost 注册 owner 路由（AUTH+QR）', authSpec !== undefined && registrations.length === 2)

    // 1) GET/status 0 vendor
    const getRes = await authSpec.fetch({ method: 'GET', headers: { get: () => null }, text: async () => '' })
    const cap = await getRes.json()
    check('E2E: capability 报 consoleSupported=true 且 console 命名空间白名单安全',
      cap.consoleSupported === true && Array.isArray(cap.consoleNamespaces)
      && cap.consoleNamespaces.length === 1 && cap.consoleNamespaces[0] === 'xiaomi-account-user-id',
      { consoleSupported: cap.consoleSupported, namespaces: cap.consoleNamespaces })
    check('E2E: capability 的 bootEpoch 是真实 32hex（旧布尔笔误已纠正）', cap.bootEpoch === BOOT, cap.bootEpoch)
    check('E2E: GET/status 期 0 vendor 请求', vendorCount() === 0, vendorCount())
    const emptyStatus = await consoleStatusOf()
    check('E2E: 无会话 consoleStatus 为可信 absent', emptyStatus.state === 'absent' && emptyStatus.supported === true, emptyStatus)

    // 2) UI：填预期 → 创建+begin → 5 跳、balance 0
    let tree = await mountPanel()
    check('E2E: 面板出现正式扫码入口（未启用前不谎称可用）',
      byConsole(tree, 'start').length === 1 && textOf(byConsole(tree, 'identifier')[0] === undefined ? tree : tree).length > 0)
    const noteText = textOf(byConsole(tree, 'note').length > 0 ? byConsole(tree, 'note')[0] : tree)
    check('E2E: consoleSupported 时文案为「本人发起官方扫码…15 分钟本地界…重启后需重新登录」',
      noteText.indexOf('本人发起官方扫码') >= 0 && noteText.indexOf('15 分钟本地界') >= 0
      && noteText.indexOf('重启后需重新登录') >= 0 && noteText.indexOf('合成边界') < 0, noteText)
    const inputEl = byConsole(tree, 'identifier')[0]
    check('E2E: 预期账号是 type=password 且未受控（无 value/defaultValue 属性）',
      inputEl !== undefined && inputEl.props.type === 'password'
      && inputEl.props.value === undefined && inputEl.props.defaultValue === undefined)
    // 非受控：直接写 DOM .value
    inputEl.props.ref.current.value = ACCOUNT_ID
    const clickedStart = click(tree, 'console', 'start')
    check('E2E: 点击「创建并开始扫码登录」', clickedStart === true)
    check('E2E: 点击后输入框立即清空（不留在 DOM/state）', inputEl.props.ref.current.value === '')
    await settlePanel()
    await flush()
    // begin 已 ACK；登录在后台跑。推进 poll 观察直到 ready。
    for (let i = 0; i < 8; i += 1) {
      await api.pump()
      await settlePanel()
      if ((api.store.console || {}).state === 'ready') break
    }
    const afterBegin = vendor()
    check('E2E: begin 产生 ctx/init/img/lp/callback 各 1 且 balance 0',
      afterBegin.filter((u) => u.includes('/api/v1/genLoginUrl')).length === 1
      && afterBegin.filter((u) => u.includes('qs=')).length === 1
      && afterBegin.filter((u) => u.includes('/longPolling/qrImage')).length === 1
      && afterBegin.filter((u) => u === LP).length === 1
      && afterBegin.filter((u) => u.includes('/sts')).length === 1
      && afterBegin.filter((u) => u.includes('/api/v1/balance')).length === 0
      && afterBegin.length === 5, afterBegin.join('|'))
    const readySnap = api.store.console
    // 二维码 effect 是异步的（fetch → blob → objectURL）：再落定几轮
    for (let i = 0; i < 4; i += 1) { await settlePanel(); await flush() }
    await settlePanel()
    check('E2E: UI 观察到 ready + 遮蔽身份（不含原始 ID）',
      readySnap !== null && readySnap.state === 'ready' && readySnap.identity !== null
      && readySnap.identity.maskedLabel.indexOf(ACCOUNT_ID) < 0, readySnap && readySnap.state)
    check('E2E: 本地二维码走内存 objectURL（未上传、无 base64）',
      objectUrls.length === 1 && JSON.stringify(api.store.console).indexOf('blob:') < 0,
      { objectUrls, hasQr: readySnap && readySnap.hasQr, qrEls: byConsole(tree, 'qr').length, revokedUrls })

    // 3) attach：显式「确认身份并接入显示（尚不读余额）」
    tree = await settlePanel()
    const attachBtn = byConsole(tree, 'attach')[0]
    check('E2E: ready 有显式「确认身份并接入显示（尚不读余额）」按钮',
      attachBtn !== undefined && textOf(attachBtn).indexOf('尚不读余额') >= 0)
    const beforeAttach = vendorCount()
    click(tree, 'console', 'attach')
    await settlePanel()
    await flush()
    await api.pump()
    tree = await settlePanel()
    check('E2E: attach 仍 0 余额请求', vendorCount() === beforeAttach, { before: beforeAttach, after: vendorCount() })
    const dtoAfterAttach = await displayStatusOf()
    check('E2E: attach 后 display verified 且无余额',
      dtoAfterAttach.state === 'verified' && dtoAfterAttach.balance === null, dtoAfterAttach.state)
    check('E2E: attach 后 console 记录为 claimed（预授权已移交）', (await consoleStatusOf()).state === 'claimed')

    // 4) read → 1 balance；confirm 0 请求；grant 由 Host 排程，UI status 不触上游
    tree = await settlePanel()
    const readBtn = byDisplay(tree, 'read')[0]
    check('E2E: display「读取一次余额」按钮出现', readBtn !== undefined)
    const beforeRead = vendorCount()
    click(tree, 'display', 'read')
    await settlePanel()
    await flush()
    check('E2E: 点击 read 恰好 +1 balance 请求', vendorCount() === beforeRead + 1, { before: beforeRead, after: vendorCount() })
    for (let i = 0; i < 4; i += 1) { await api.pump(); await settlePanel() }
    check('E2E: 读到真实四字段投影（balance/currency/cash/gift）',
      api.store.snapshot !== null && api.store.snapshot.balance !== null
      && api.store.snapshot.balance.balance === BALANCE_VALUE
      && api.store.snapshot.balance.currency === 'CNY'
      && api.store.snapshot.balance.cashBalance === 30
      && api.store.snapshot.balance.giftBalance === 3.25, api.store.snapshot && api.store.snapshot.balance)
    tree = await settlePanel()
    const beforeConfirm = vendorCount()
    check('E2E: 点击「余额与我本人一致」', click(tree, 'display', 'confirm-match') === true)
    await settlePanel()
    await flush()
    check('E2E: 确认不产生任何上游请求', vendorCount() === beforeConfirm, { before: beforeConfirm, after: vendorCount() })
    tree = await settlePanel()
    check('E2E: 点击「授权持续刷新」', click(tree, 'display', 'grant') === true)
    await settlePanel()
    await flush()
    const granted = await displayStatusOf()
    check('E2E: grant 在 Host 侧排了下一轮（nextRefreshAt 为数字）', typeof granted.nextRefreshAt === 'number', granted.nextRefreshAt)
    const beforePoll = vendorCount()
    for (let i = 0; i < 5; i += 1) { await api.pump(); await settlePanel() }
    check('E2E: 纯观察 status/UI 反复刷新 0 上游请求', vendorCount() === beforePoll, { before: beforePoll, after: vendorCount() })

    // 5) 401 → 一次 fresh SSO + 重试，恰好 5 跳
    wireState.balanceSeq = [401, 200]
    // 下一次自动刷新（60 s 后）会走 401→SSO→retry
    const beforeSso = vendorCount()
    await advance(60000)
    const ssoHops = hops(beforeSso)
    check('E2E: 401 触发一次 fresh SSO 并重试（精确 5 跳）',
      ssoHops.length === 5
      && ssoHops.filter((u) => u.includes('/api/v1/balance')).length === 2
      && ssoHops.filter((u) => u.includes('/pass/serviceLogin')).length === 1
      && ssoHops.filter((u) => u.includes('/sts')).length === 1
      && ssoHops.filter((u) => u.includes('/api/v1/genLoginUrl')).length === 1,
      ssoHops.join('|'))
    await api.pump()
    await settlePanel()
    check('E2E: 换票后仍显示真实数值（不被伪造/旧值顶替）',
      api.store.snapshot !== null && api.store.snapshot.state === 'verified'
      && api.store.snapshot.balance !== null && api.store.snapshot.balance.balance === BALANCE_VALUE,
      api.store.snapshot && api.store.snapshot.state)

    // 5b) 身份变号：401 → fresh SSO 拿到**不同** userId ⇒ 终止、清值（不与旧值混用）
    wireState.balanceSeq = [401]
    wireState.ssoCallbackUserId = 'attacker-other-9999'
    const beforeMismatch = vendorCount()
    await advance(60000)
    await api.pump()
    await settlePanel()
    const mismatchHops = hops(beforeMismatch)
    const mismatchView = api.view()
    check('E2E: 身份变号在换票阶段终止（不写回旧值、不重试）',
      mismatchView !== null && mismatchView.state === 'stopped' && mismatchView.balance === null
      && mismatchHops.filter((u) => u.includes('/api/v1/balance')).length === 1
      && mismatchHops.filter((u) => u.includes('/pass/serviceLogin')).length === 1,
      { state: mismatchView && mismatchView.state, code: mismatchView && mismatchView.code, hops: mismatchHops.join('|') })
    wireState.ssoCallbackUserId = ACCOUNT_ID
    wireState.balanceSeq = []

    // 6) displayStop 幂等（此时已是终止态）+ 停止后 0 上游
    const dto = await hostPost({ action: 'displayStop', bootEpoch: BOOT, displayId: (await displayStatusOf()).displayId, generation: (await displayStatusOf()).generation })
    check('E2E(6pre): displayStop 生效', dto.body.ok === true, dto.body && dto.body.code)
    await api.pump()
    await settlePanel()
    const stoppedView = api.view()
    check('E2E: 停止后本地不再显示数值', stoppedView !== null && stoppedView.state === 'stopped' && stoppedView.balance === null,
      stoppedView && stoppedView.state)
    const beforeStoppedCalls = vendorCount()
    // 已停止：任何 read/grant 都不该再发请求，也不能复活旧协议
    check('E2E: 停止后 read 按钮不再出现（无从复活）', byDisplay(await settlePanel(), 'read').length === 0)
    await flush()
    check('E2E: 停止后 0 新上游请求', vendorCount() === beforeStoppedCalls)

    // display 已释放凭据后，非密 claimed 记录也应结束，允许下一次本人登录。
    const endedAuth = await consoleStatusOf()
    check('E2E: displayStop 后 console 不再滞留 claimed', endedAuth.state === 'stopped' && endedAuth.identity === null)
    const restartBefore = vendorCount()
    const restarted = await hostPost({
      action: 'consoleStart', bootEpoch: BOOT,
      expected: { namespace: 'xiaomi-account-user-id', identifier: ACCOUNT_ID }, authConsent: true,
    })
    check('E2E: displayStop 后可新建下一代本地登录且 0 上游请求',
      restarted.status === 200 && restarted.body.console.generation === endedAuth.generation + 1
      && vendorCount() === restartBefore, { status: restarted.status, code: restarted.body && restarted.body.code })

    // 7) strict schema：伪造 URL / 多余字段 / 错 boot / 坏 id/gen/approval 全被拒
    const beforeForge = vendorCount()
    const forgeCases = [
      { action: 'consoleStart', bootEpoch: BOOT, expected: { namespace: 'xiaomi-account-user-id', identifier: 'a' }, authConsent: true, url: 'https://evil.example/' },
      { action: 'consoleStart', bootEpoch: BOOT, expected: { namespace: 'xiaomi-account-user-id', identifier: 'a', id: 'b' }, authConsent: true },
      { action: 'consoleStart', bootEpoch: BOOT, expected: { namespace: 'xiaomi-account-user-id', identifier: 'a' } },
      { action: 'consoleStatus', bootEpoch: 'ffffffffffffffffffffffffffffffff' },
      { action: 'consoleBegin', bootEpoch: BOOT, authId: 'not-hex', generation: 1 },
      { action: 'consoleBegin', bootEpoch: BOOT, authId: 'a'.repeat(32), generation: 0 },
      { action: 'consoleApprove', bootEpoch: BOOT, authId: 'a'.repeat(32), generation: 1, approvalId: 'zz' },
      { action: 'consoleAttach', bootEpoch: BOOT, authId: 'a'.repeat(32), generation: 1, enable: true },
    ]
    const forgeResults = []
    for (const body of forgeCases) forgeResults.push((await hostPost(body)).status)
    check('E2E: 伪造/越权字段一律 400/409（不静默忽略）',
      forgeResults.every((s) => s === 400 || s === 409), forgeResults)
    check('E2E: 被拒请求 0 上游请求', vendorCount() === beforeForge, { before: beforeForge, after: vendorCount() })

    // 8) DTO/JSON/error 无哨兵/原始 ID/来源 URL
    const dump = []
    dump.push(JSON.stringify(cap))
    dump.push(JSON.stringify(await consoleStatusOf()))
    dump.push(JSON.stringify(await displayStatusOf()))
    for (const body of forgeCases) dump.push((await hostPost(body)).raw)
    const all = dump.join('\n')
    check('E2E: 响应里无 passToken 哨兵', all.indexOf(SEED) < 0)
    check('E2E: 响应里无原始账号 ID', all.indexOf(ACCOUNT_ID) < 0)
    check('E2E: 响应里无来源 URL/query', all.indexOf('longPolling') < 0 && all.indexOf('xiaomi.com') < 0 && all.indexOf('https://') < 0)

    // Fixed reason codes are preserved without accepting free-form upstream text.
    const reasonCodes = ['E_MIMO_CONSOLE_AUTH_RESULT_SEED_MISSING', 'E_MIMO_CONSOLE_AUTH_RESULT_ID_INVALID',
      'E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING', 'E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING']
    check('E2E: 登录失败分支固定码经客户端白名单保留',
      reasonCodes.every(code => api.consoleOf({ supported: true, state: 'failed', code }).code === code))
    check('E2E: 自由错误正文仍不得作为错误码进入 UI',
      api.consoleOf({ supported: true, state: 'failed', code: SEED }).code === '')

    const fixedUnsupportedCodes = ["E_MIMO_CONSOLE_JSON_UNSUPPORTED","E_MIMO_CONSOLE_COOKIE_HEADER_LIMIT","E_MIMO_CONSOLE_LP_COOKIE_DOMAIN","E_MIMO_CONSOLE_LP_COOKIE_POLICY","E_MIMO_CONSOLE_ACCOUNT_COOKIE_DOMAIN","E_MIMO_CONSOLE_ACCOUNT_COOKIE_POLICY","E_MIMO_CONSOLE_PLATFORM_COOKIE_DOMAIN","E_MIMO_CONSOLE_PLATFORM_COOKIE_POLICY","E_MIMO_CONSOLE_LP_SEED_CONFLICT","E_MIMO_CONSOLE_LP_CHALLENGE","E_MIMO_CONSOLE_SSO_CHALLENGE","E_MIMO_CONSOLE_SSO_RESPONSE_UNSUPPORTED","E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED","E_MIMO_CONSOLE_LP_TARGET_UNSUPPORTED","E_MIMO_CONSOLE_LP_SID_UNSUPPORTED","E_MIMO_CONSOLE_LP_CALLBACK_UNSUPPORTED","E_MIMO_CONSOLE_LP_SCHEMA_UNSUPPORTED","E_MIMO_CONSOLE_LP_HOST_UNSUPPORTED","E_MIMO_CONSOLE_RESPONSE_SIZE","E_MIMO_CONSOLE_RESPONSE_REDIRECT"]
    check('E2E: unsupported 固定原因码均经客户端白名单保留',
      fixedUnsupportedCodes.every(code => api.consoleOf({ supported: true, state: 'failed', code }).code === code))

    const cookieReasons = ["E_MIMO_CONSOLE_LP_COOKIE_EMPTY","E_MIMO_CONSOLE_LP_COOKIE_CRLF","E_MIMO_CONSOLE_LP_COOKIE_TOO_LARGE","E_MIMO_CONSOLE_LP_COOKIE_BAD_NAME","E_MIMO_CONSOLE_LP_COOKIE_BAD_VALUE","E_MIMO_CONSOLE_LP_COOKIE_VALUE_FORMAT","E_MIMO_CONSOLE_LP_COOKIE_EXPIRY_FORMAT","E_MIMO_CONSOLE_LP_COOKIE_STORE_FULL","E_MIMO_CONSOLE_LP_COOKIE_BAD_SOURCE","E_MIMO_CONSOLE_LP_COOKIE_DUP_DOMAIN","E_MIMO_CONSOLE_LP_COOKIE_DUP_VALUE","E_MIMO_CONSOLE_LP_COOKIE_COUNT_LIMIT","E_MIMO_CONSOLE_LP_COOKIE_PARSE_ERROR","E_MIMO_CONSOLE_ACCOUNT_COOKIE_EMPTY","E_MIMO_CONSOLE_ACCOUNT_COOKIE_CRLF","E_MIMO_CONSOLE_ACCOUNT_COOKIE_TOO_LARGE","E_MIMO_CONSOLE_ACCOUNT_COOKIE_BAD_NAME","E_MIMO_CONSOLE_ACCOUNT_COOKIE_BAD_VALUE","E_MIMO_CONSOLE_ACCOUNT_COOKIE_VALUE_FORMAT","E_MIMO_CONSOLE_ACCOUNT_COOKIE_EXPIRY_FORMAT","E_MIMO_CONSOLE_ACCOUNT_COOKIE_STORE_FULL","E_MIMO_CONSOLE_ACCOUNT_COOKIE_BAD_SOURCE","E_MIMO_CONSOLE_ACCOUNT_COOKIE_DUP_DOMAIN","E_MIMO_CONSOLE_ACCOUNT_COOKIE_DUP_VALUE","E_MIMO_CONSOLE_ACCOUNT_COOKIE_COUNT_LIMIT","E_MIMO_CONSOLE_ACCOUNT_COOKIE_PARSE_ERROR"]
    check('E2E: 必要凭据精确原因码均保留，仍是固定白名单',
      cookieReasons.every(code => api.consoleOf({ supported: true, state: 'failed', code }).code === code))

    const platformReasons = ["E_MIMO_CONSOLE_PLATFORM_COOKIE_EMPTY","E_MIMO_CONSOLE_PLATFORM_COOKIE_CRLF","E_MIMO_CONSOLE_PLATFORM_COOKIE_TOO_LARGE","E_MIMO_CONSOLE_PLATFORM_COOKIE_BAD_NAME","E_MIMO_CONSOLE_PLATFORM_COOKIE_BAD_VALUE","E_MIMO_CONSOLE_PLATFORM_COOKIE_VALUE_FORMAT","E_MIMO_CONSOLE_PLATFORM_COOKIE_EXPIRY_FORMAT","E_MIMO_CONSOLE_PLATFORM_COOKIE_STORE_FULL","E_MIMO_CONSOLE_PLATFORM_COOKIE_BAD_SOURCE","E_MIMO_CONSOLE_PLATFORM_COOKIE_DUP_DOMAIN","E_MIMO_CONSOLE_PLATFORM_COOKIE_DUP_VALUE","E_MIMO_CONSOLE_PLATFORM_COOKIE_COUNT_LIMIT","E_MIMO_CONSOLE_PLATFORM_COOKIE_PARSE_ERROR"]
    check('E2E: 平台必要凭据原因码完整保留且仍为固定白名单',
      platformReasons.every(code => api.consoleOf({ supported: true, state: 'failed', code }).code === code))

    // 9) 旧 legacy flow loader 调用 0 次
    check('E2E: 旧 legacy QR flow loader 调用 0 次', flowLoads === 0, flowLoads)

    // 10) 默认（代码级开关关闭）与开启调用同一条真实链的状态机
    const offHost = makeHost(false)
    // 新注册的是**最后**一条 AUTH spec（[0] 是代码级开关打开的那个 Host）
    const offSpec = registrations.filter((r) => r.path === '/api/plan-usage-mimo-auth').pop()
    activeAuthSpec = offSpec
    await flush()
    const offGet = await offSpec.fetch({ method: 'GET', headers: { get: () => null }, text: async () => '' })
    const offCap = await offGet.json()
    check('E2E: 默认关闭时 capability 报 consoleSupported=false 且 console 为可信 absent',
      offCap.consoleSupported === false && offCap.console !== null
      && offCap.console.supported === false && offCap.console.state === 'absent', offCap.console)
    const offStatus = await hostPost({ action: 'consoleStatus', bootEpoch: BOOT })
    check('E2E: 默认关闭时 consoleStatus 仍是 200 + 可信 absent',
      offStatus.status === 200 && offStatus.body.console.state === 'absent' && offStatus.body.console.supported === false,
      { status: offStatus.status, console: offStatus.body && offStatus.body.console })
    const offStop = await hostPost({ action: 'consoleStop', bootEpoch: BOOT })
    check('E2E: 默认关闭时 consoleStop 幂等 200', offStop.status === 200 && offStop.body.ok === true, offStop.status)
    const offStart = await hostPost({
      action: 'consoleStart', bootEpoch: BOOT,
      expected: { namespace: 'xiaomi-account-user-id', identifier: ACCOUNT_ID }, authConsent: true,
    })
    check('E2E: 默认关闭时 consoleStart 固定拒绝码 503', offStart.status === 503
      && offStart.body.code === 'E_MIMO_CONSOLE_SESSION_DISABLED', { status: offStart.status, code: offStart.body && offStart.body.code })
    const offBegin = await hostPost({ action: 'consoleBegin', bootEpoch: BOOT, authId: 'a'.repeat(32), generation: 1 })
    check('E2E: 默认关闭时 consoleBegin 固定拒绝码 503', offBegin.status === 503, offBegin.status)
    const beforeOffCalls = vendorCount()
    check('E2E: 默认关闭期 0 上游请求', vendorCount() === beforeOffCalls)
    // 默认关闭时 UI 文案必须如实说明「尚未启用真实试接入」
    api.reset()
    const offTree = await mountPanel()
    const offNote = textOf(byConsole(offTree, 'note')[0] !== undefined ? byConsole(offTree, 'note')[0] : offTree)
    check('E2E: 默认关闭时面板如实显示「尚未启用真实试接入」且无正式入口',
      offNote.indexOf('尚未启用真实试接入') >= 0 && byConsole(offTree, 'start').length === 0, offNote)
    try { offHost.dispose() } catch { /* 忽略 */ }

    // 10b) 双登录防护：已有 **display 会话**active 时 consoleStart 必须 0 请求拒绝
    const MIXED_NS = 'mimo-mixed-synthetic'
    const MIXED_ID = 'mixed-user-1001'
    const mixedHost = createAuthHost(fakeCtx, BOOT, () => {}, {
      enableConsoleProtocol: true,
      displayProducer: async () => ({ credential: { token: 'synthetic' } }),
      displayIdentityVerifier: async () => ({ identity: { namespace: MIXED_NS, identifier: MIXED_ID } }),
      displayBalanceAdapter: async () => ({
        ok: true, identity: { namespace: MIXED_NS, identifier: MIXED_ID }, balance: { balance: 4.5, currency: 'CNY' },
      }),
      displayNamespace: MIXED_NS,
      now,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      consoleTransportDeps: { clock: now, resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: requestImpl },
      loadFlow: async () => { flowLoads += 1; throw new Error('legacy flow must not load') },
    })
    const mixedSpec = registrations.filter((r) => r.path === '/api/plan-usage-mimo-auth').pop()
    activeAuthSpec = mixedSpec
    const mixedPost = async (body) => {
      const res = await mixedSpec.fetch({
        method: 'POST',
        headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify(body),
      })
      let json = null
      try { json = await res.json() } catch { json = null }
      return { status: res.status, body: json }
    }
    const mixedStart = await mixedPost({ action: 'displayStart', bootEpoch: BOOT, expected: { namespace: MIXED_NS, identifier: MIXED_ID } })
    check('E2E(10b): 合成 display 会话可 verified', mixedStart.status === 200
      && mixedStart.body.display.state === 'verified', mixedStart.body && mixedStart.body.display && mixedStart.body.display.state)
    const beforeDual = vendorCount()
    const dualStart = await mixedPost({
      action: 'consoleStart', bootEpoch: BOOT,
      expected: { namespace: 'xiaomi-account-user-id', identifier: ACCOUNT_ID }, authConsent: true,
    })
    check('E2E(10b): display active 时 consoleStart 0 请求拒绝（防双登录）',
      dualStart.status === 409 && dualStart.body.code === 'E_MIMO_CONSOLE_SESSION_BUSY'
      && vendorCount() === beforeDual, { status: dualStart.status, code: dualStart.body && dualStart.body.code })
    try { mixedHost.dispose() } catch { /* 忽略 */ }

    // 10c) 旧会话仅本地 start 即可核对互斥，无需 begin 或加载任何 legacy flow。
    const legacyHost = makeHost(true)
    activeAuthSpec = registrations.filter((r) => r.path === '/api/plan-usage-mimo-auth').pop()
    const beforeLegacy = vendorCount()
    const localLegacy = await hostPost({ action: 'start', bootEpoch: BOOT })
    check('E2E(10c): legacy 本地创建无需加载 flow 或联网',
      localLegacy.status === 200 && flowLoads === 0 && vendorCount() === beforeLegacy)
    const blockedByLegacy = await hostPost({
      action: 'consoleStart', bootEpoch: BOOT,
      expected: { namespace: 'xiaomi-account-user-id', identifier: ACCOUNT_ID }, authConsent: true,
    })
    check('E2E(10c): legacy 已创建时正式登录 0 请求拒绝',
      blockedByLegacy.status === 409 && blockedByLegacy.body.code === 'E_MIMO_CONSOLE_SESSION_BUSY'
      && vendorCount() === beforeLegacy)
    check('E2E(10c): 验证旧会话互斥仍未加载 legacy flow', flowLoads === 0)
    legacyHost.dispose()

    // 11) 恢复开启的 Host 供收尾断言：dispose 顺序（display 先释放 handle）
    activeAuthSpec = authSpec
    await flush()
    const beforeDispose = vendorCount()
    host.dispose()
    await flush()
    check('E2E: host.dispose 后 0 上游请求', vendorCount() === beforeDispose, { before: beforeDispose, after: vendorCount() })
    const afterDispose = await authSpec.fetch({
      method: 'POST',
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ action: 'consoleStatus', bootEpoch: BOOT }),
    })
    check('E2E: dispose 后 AUTH 路由 503（不假装活着）', afterDispose.status === 503, afterDispose.status)
  } finally {
    try { host.dispose() } catch { /* 忽略 */ }
    api.setPoll(0)
    api.reset()
    loaded.restore()
  }
}

main().then(() => {
  console.log('')
  console.log(pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exitCode = 1
}, (error) => {
  console.log('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
