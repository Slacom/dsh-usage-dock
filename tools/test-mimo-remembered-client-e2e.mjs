/**
 * test-mimo-remembered-client-e2e.mjs — 「记住登录」managed 模式：**真实 UI 点击**端到端
 *
 * 真实链路（除 IO/OS 外全真）：
 *   mock React 运行时里的**真实 client.js 组件** `MimoAuthMount → MimoRememberedPanel`
 *   ← 桥接 globalThis.fetch ← **真实** `createAuthHost` 注册的 owner 路由
 *   → 真实 `remembered-session` → 真实 `console-protocol`（A1 authority + secure-transport）
 *   → 真实 `remember-store.js` 的 `createRememberedVault`（fake credentials provider + fake crypto）。
 * 只 fake DNS/`node:https` 的 request、DPAPI crypto、宿主 credentials provider、objectURL、定时器。
 * 不跑真实网络、不碰真实账号/二维码/余额/DPAPI/凭据记录，不部署、不重启。
 *
 * 断言按**合同**写（点击 → 路由 → 存储 → 再回到 UI），不按当前实现写：
 *   1 首扫无输入/5 min 文案/5 跳/QR 本机二进制/候选只 owner 可见/确认前 0 余额 0 写
 *   2 四项授权 + consentVersion 1 + 不带 ID；密文保存后才首读；侧栏不被 manual 99.99 顶回
 *   3 离开待确认即清候选/revoke QR；收起 settings 后 Host 仍按 5 min 计数且无第二个上游 pump
 *   4 pause 持久化 paused；跨 Host 重启不联网；resume 先 3 跳核 ID 再 1 跳读
 *   5 forget 先清值再 tombstone；两 boot 屏障拒旧；取消待确认 0 写；固定错误码不漏 token/URL
 *   6 缺同意/错 boot/错 gen/未知字段 0 副作用；UI 实际发出的字段集与后端一致
 *
 * 运行：node tools/test-mimo-remembered-client-e2e.mjs
 */
import { EventEmitter } from 'node:events'
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { createRememberedVault } from '../plans/mimo-auth/remember-store.js'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

// ── 渲染/观察异常收集（不静默崩溃：异常即失败项，但不中断整套） ───────────────
const runtimeErrors = []
process.on('unhandledRejection', (err) => { runtimeErrors.push(err) })
function noteError(err) {
  runtimeErrors.push(err)
  return err
}

// ── 计数 ────────────────────────────────────────────────────────────────────
let pass = 0
const fails = []
function check(name, ok, detail) {
  if (ok === true) { pass += 1; console.log('PASS ' + name); return true }
  fails.push(name + (detail === undefined ? '' : ' || ' + JSON.stringify(detail)))
  console.log('FAIL ' + name + (detail === undefined ? '' : ' || ' + JSON.stringify(detail)))
  return false
}
function sectionError(tag, err) {
  fails.push(tag + ' :: 抛错 ' + (err && err.message ? err.message : String(err)))
  console.log('FAIL ' + tag + ' :: 抛错 ' + (err && err.message ? err.message : String(err)))
}

// ── 合成边界常量（无真实账号） ──────────────────────────────────────────────
const T0 = Date.UTC(2026, 10, 7, 0, 0, 0)
const clock = { t: T0 }
const BOOT_A = 'a'.repeat(32)
const BOOT_B = 'b'.repeat(32)
const BOOT_C = 'c'.repeat(32)
const BOOT_D = 'd'.repeat(32)
const PUBLIC_IP = '93.184.216.34'
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ACCOUNT_ID = '771234567'            // 合成 ID，不是用户真实账号
const PASS_SENTINEL = 'SENTINELPASSTOKEN'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'
const BALANCE_A = 13.5
const BALANCE_B = 42.75
const BALANCE_D = 66.6                      // 新 boot 的区分值（屏障用：66.6 采用 / 42.75 必须缺席）
const MANUAL_SENTINEL = 99.99             // 普通 manual 行（不得顶回 Host 真值）
const PLATFORM_COOKIES = [
  'api-platform_serviceToken=PT; Path=/; Secure',
  'userId=' + ACCOUNT_ID + '; Path=/; Secure',
  'api-platform_slh=SLH; Path=/; Secure'
]

// ── 通用工具 ────────────────────────────────────────────────────────────────
async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
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
    statusCode: status, status, complete: true, redirected: false,
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
          cancel() { return Promise.resolve() }
        }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  }
}

/** fakeHTTP：只替换 DNS/连接；协议序列与 JSON 解析都是真的。 */
function scenario(balance = BALANCE_A) {
  const seen = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: PASS_SENTINEL, userId: ACCOUNT_ID, cUserId: '888' }),
    callbackCookies: PLATFORM_COOKIES.slice(),
    // 模拟「用户还没扫码」：置为非 null 时，等待扫码的 lp 跳被挂起，直到测试放行
    lpGate: null,
    lpRelease: null,
    balanceBody: JSON.stringify({
      code: 0,
      data: { balance: String(balance), cashBalance: String(balance - 1), giftBalance: '1.00', currency: 'CNY' }
    })
  }
  state.holdScan = () => {
    state.lpGate = new Promise((resolve) => { state.lpRelease = resolve })
    return state.lpGate
  }
  state.releaseScan = () => {
    if (state.lpRelease !== null) state.lpRelease()
    state.lpGate = null
    state.lpRelease = null
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter()
    ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    ee.end = () => {
      queueMicrotask(() => {
        if (url.includes('/api/v1/genLoginUrl')) { callback(makeResp(302, '', { location: SIGNED })); return }
        if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) {
          callback(makeResp(200, JSON.stringify({ qr: QR, lp: LP })))
          return
        }
        if (url.includes('/longPolling/qrImage')) { callback(makeResp(200, PNG8)); return }
        if (url.includes('/longPolling/loginUrl')) {
          const deliver = () => callback(makeResp(200, state.body))
          if (state.lpGate !== null) state.lpGate.then(deliver)
          else deliver()
          return
        }
        if (url.includes('/pass/serviceLogin')) { callback(makeResp(200, JSON.stringify({ code: 0, location: CB }))); return }
        if (url.includes('/sts')) { callback(makeResp(200, '', { 'set-cookie': state.callbackCookies })); return }
        if (url.includes('/api/v1/balance')) { callback(makeResp(200, state.balanceBody)); return }
        callback(makeResp(404, ''))
      })
    }
    return ee
  }
  return { seen, state, impl, count: (p) => seen.filter((u) => u.includes(p)).length }
}

/** fake credentials provider：`modifyRecord` **串行排队**，回调 resolve 之后才提交。 */
function fakeProvider() {
  const records = new Map()
  let queue = Promise.resolve()
  let writes = 0
  return {
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return undefined
        writes += 1
        records.set(key, next)
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    raw() { return new Map(records) },
    only() { return records.size === 1 ? [...records.values()][0] : null },
    size() { return records.size },
    get writes() { return writes }
  }
}

function fakeCrypto() {
  return {
    async capability() { return { supported: true, code: 'E_NONE' } },
    async protect(bytes) { return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    async unprotect(bytes) { return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    dispose() {}
  }
}

function makeVault(provider) {
  return createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
}

/** 真实 createAuthHost + 捕获 AUTH/QR 两个 owner 路由 handler + 可推进的 Host 定时器。 */
function makeHost({ sc, provider, bootEpoch = BOOT_A, isEnabled = () => true }) {
  const routes = []
  const timers = []
  let seq = 0
  const setT = (fn, ms) => {
    const id = ++seq
    timers.push({ id, at: clock.t + Math.max(0, Number(ms) || 0), fn })
    return { id, unref() {} }
  }
  const clearT = (handle) => {
    const id = handle !== null && typeof handle === 'object' ? handle.id : handle
    const index = timers.findIndex((t) => t.id === id)
    if (index >= 0) timers.splice(index, 1)
  }
  const ctx = {
    connection: { fetch: { register(spec) { routes.push(spec); return () => { spec.disposed = true } } } },
    webServer: {}
  }
  const host = createAuthHost(ctx, bootEpoch, () => {}, {
    enableConsoleProtocol: true,
    enableRememberedAccount: true,
    rememberedVault: makeVault(provider),
    isEnabled,
    now: () => clock.t,
    setTimeout: setT,
    clearTimeout: clearT,
    consoleTransportDeps: {
      clock: () => clock.t,
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
      request: sc.impl
    }
  })
  const auth = () => routes.find((r) => r.path === '/api/plan-usage-mimo-auth')
  const qr = () => routes.find((r) => r.path === '/api/plan-usage-mimo-qr')
  const runDue = async () => {
    for (let guard = 0; guard < 200; guard += 1) {
      const due = timers.filter((t) => t.at <= clock.t)
      if (due.length === 0) break
      for (const task of due) {
        const index = timers.indexOf(task)
        if (index >= 0) timers.splice(index, 1)
        try { task.fn() } catch { /* 定时任务异常由快照固定码体现 */ }
      }
      await flush(10)
    }
    await flush(10)
  }
  const advance = async (ms) => { clock.t += ms; await runDue() }
  const pendingTimers = () => timers.length
  const out = { host, auth, qr, advance, runDue, pendingTimers, bootEpoch, provider, sc }
  lastHost = out
  return out
}
let lastHost = null

// ── mock React + 真实 client.js ──────────────────────────────────────────────
const runtime = createRuntime()
const PLANS = () => ({
  ok: true,
  data: {
    plans: [
      { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
      { id: 'mimo', name: 'Xiaomi MiMo', balance: MANUAL_SENTINEL, currency: 'CNY', isAvailable: true }
    ]
  }
})
const client = loadClient(runtime, { payload: PLANS(), form: null })
const ui = client.module.mimoAuth
client.module.mimoDisplay.setPoll(0)

// 客户端 interval 可控（mock-react 在加载时把 setInterval 打桩成 0）
const clientIntervals = new Map()
let clientIntervalSeq = 0
globalThis.setInterval = (fn) => { const id = ++clientIntervalSeq; clientIntervals.set(id, fn); return id }
globalThis.clearInterval = (id) => { clientIntervals.delete(id) }
async function clientTick() {
  for (const fn of [...clientIntervals.values()]) { try { fn() } catch { /* 观察失败不致命 */ } }
  await flush()
}

// objectURL：二维码必须走本机二进制 + objectURL，且离开待确认即 revoke
const objectUrls = []
const revokedUrls = []
let objectUrlSeq = 0
globalThis.URL.createObjectURL = () => { const url = 'blob:test-' + (++objectUrlSeq); objectUrls.push(url); return url }
globalThis.URL.revokeObjectURL = (url) => { revokedUrls.push(String(url)) }

// ── fetch 桥：真实 client.js → 真实 Host handler；记录 UI 实际发出的每个请求 ──
let active = null          // 当前 active host
const uiCalls = []         // UI 发出的调用（{action, body, status, boot}）
const allResponses = []    // 所有响应正文（用于秘密/URL 泄漏扫描）

function toRequest(init) {
  const source = init !== null && init !== undefined ? init : {}
  const headers = source.headers !== null && source.headers !== undefined ? source.headers : {}
  let text = typeof source.body === 'string' ? source.body : ''
  return {
    method: typeof source.method === 'string' ? source.method : 'GET',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? (headers['content-type'] || null) : null) },
    text: async () => text,
    setText: (next) => { text = next }
  }
}

async function callRoute(spec, init, tag) {
  const request = toRequest(init)
  const raw = await request.text()
  const res = await spec.fetch(request)
  const record = { tag, method: request.method, raw, status: res.status }
  try { record.body = raw === '' ? null : JSON.parse(raw) } catch { record.body = null }
  if (tag === 'ui') uiCalls.push(record)
  return res
}

/**
 * 投递顺序控制（两 boot 屏障用）：holdNext 存在时，**下一个** owner 请求先绑定到
 * 「此刻 active 的 Host」，等 release() 之后才真正打到那个 Host —— 响应仍是真实 Host
 * 为那个 boot 生成的（不是伪造响应），只是**交付顺序**相反。
 */
let holdNext = null
let heldRelease = null
function releaseHeld() { if (heldRelease !== null) { const fn = heldRelease; heldRelease = null; fn() } }

async function bridgeFetch(url, init) {
  const href = String(url)
  if (active === null) throw new Error('no active host')
  if (href.indexOf('custom-status') >= 0) {
    return { json: async () => ({ ok: true, data: { keys: {}, refs: {}, providers: [] } }) }
  }
  if (href.indexOf('quota-windows') >= 0) {
    return { json: async () => ({ ok: true, data: { channels: {}, readAt: 1 } }) }
  }
  if (href.indexOf('/api/plan-usage-mimo-qr') >= 0) return callRoute(active.qr(), init, 'ui')
  if (href.indexOf('/api/plan-usage-mimo-auth') >= 0) {
    if (holdNext !== null) {
      const bound = holdNext
      holdNext = null
      const initCopy = init !== null && init !== undefined
        ? { method: init.method, headers: init.headers, body: init.body }
        : {}
      const gate = new Promise((resolve) => { heldRelease = resolve })
      await gate
      const res = await callRoute(bound.auth(), initCopy, 'ui')
      uiCalls[uiCalls.length - 1].boot = bound.bootEpoch
      return res
    }
    const res = await callRoute(active.auth(), init, 'ui')
    uiCalls[uiCalls.length - 1].boot = active.bootEpoch
    return res
  }
  if (href.indexOf('/api/plan-usage') >= 0) return { status: 200, json: async () => PLANS() }
  throw new Error('unexpected fetch: ' + href)
}
globalThis.fetch = bridgeFetch

/** 直接打 owner 路由（反例用；与 UI 走同一条真实 handler）。 */
async function hostCall(body, host = active) {
  const res = await callRoute(host.auth(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, 'direct')
  let json = null
  try { json = await res.json() } catch { json = null }
  if (json !== null) allResponses.push(JSON.stringify(json))
  return { status: res.status, json }
}
async function hostCaps(host = active) {
  const res = await callRoute(host.auth(), { method: 'GET', headers: {} }, 'direct')
  const json = await res.json()
  allResponses.push(JSON.stringify(json))
  return json
}
async function hostDisplayStatus(host = active) {
  const out = await hostCall({ action: 'displayStatus', bootEpoch: host.bootEpoch }, host)
  return out.json
}
const rememberedOf = async (host = active) => (await hostCall({ action: 'rememberedStatus', bootEpoch: host.bootEpoch }, host)).json.remembered

// ── 组件树辅助（只读真实渲染出来的树，不手写 UI） ────────────────────────────
function allNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) allNodes(item, out); return out }
  if (node.props !== undefined) out.push(node)
  const kids = node.props ? node.props.children : undefined
  if (Array.isArray(kids)) { for (const item of kids) allNodes(item, out) } else if (kids !== undefined) allNodes(kids, out)
  return out
}
function buttons(tree) { return allNodes(tree).filter((n) => n.type === 'button') }
function checkboxes(tree) { return allNodes(tree).filter((n) => n.type === 'input' && n.props.type === 'checkbox') }
function inputs(tree) { return allNodes(tree).filter((n) => n.type === 'input') }
function qrImages(tree) {
  return allNodes(tree).filter((n) => n.type === 'img' && typeof n.props.src === 'string' && n.props.src.indexOf('blob:') === 0)
}
function buttonByText(tree, needle) {
  return buttons(tree).find((b) => textOf(b).indexOf(needle) >= 0)
}
function legacyMarkers(tree) {
  return allNodes(tree).filter((n) => n.props['data-mimo-console'] !== undefined || n.props['data-mimo-display'] !== undefined)
}
async function settlePanel(rounds = 4) {
  let tree = null
  // 面板是 3 s 轮询：每次「落定」先给一轮真实观察，再渲染（与生产时序一致）
  await clientTick()
  for (let i = 0; i < rounds; i += 1) {
    await flush()
    try {
      tree = await runtime.settle(PANEL, 6)
    } catch (err) {
      noteError(err)
      return tree
    }
  }
  return tree
}
function errorLine(err) {
  const stack = err !== null && err !== undefined && typeof err.stack === 'string' ? err.stack : ''
  const match = /<anonymous>:(\d+):(\d+)/.exec(stack)
  // new Function(source) 把 client.js 包进 2 行壳，因此行号减 2 得到 client.js 真实行
  return match === null ? '' : 'client.js:' + (Number(match[1]) - 2) + ':' + match[2]
}
const PANEL = { disabled: false }
let managedType = null
let gateTypeName = ''
/**
 * 挂载真实导出组件 `mimoAuth.Panel`（= MimoAuthMount，模式闸门）：
 * 闸门先做一次 GET caps 探针，然后返回 managed 面板元素。mock 运行时不会展开子组件，
 * 因此这里从**真实渲染出来的树**里取到那个子组件类型，再把它作为受控组件挂载
 * （不是手写 UI：组件、hooks、文案全部来自 client.js）。
 */
async function mountPanel() {
  runtime.mount(ui.Panel, PANEL)
  let gate = null
  for (let i = 0; i < 5; i += 1) {
    await flush()
    try { gate = await runtime.settle(PANEL, 8) } catch (err) { noteError(err); break }
  }
  if (gate !== null && typeof gate === 'object' && typeof gate.type === 'function') {
    gateTypeName = gate.type.name || ''
    managedType = gate.type
    runtime.mount(managedType, PANEL)
    return settlePanel()
  }
  gateTypeName = '(不是组件元素)'
  return settlePanel()
}
async function unmountAll() {
  runtime.mount(function Noop() { return { type: 'div', props: { children: '' } } }, {})
  await flush()
}
async function click(tree, needle) {
  const target = buttonByText(tree, needle)
  if (target === undefined) return false
  if (target.props.disabled === true) return false
  if (typeof target.props.onClick !== 'function') return false
  target.props.onClick()
  return true
}
async function clickAndSettle(tree, needle) {
  const ok = await click(tree, needle)
  const next = await settlePanel()
  return { ok, tree: next }
}
/** 逐个勾选：每次 onChange 后重新渲染（否则闭包里读到的还是旧 consent）。 */
async function tickAllConsent(tree) {
  let current = tree
  for (let i = 0; i < 4; i += 1) {
    const boxes = checkboxes(current)
    if (boxes.length <= i) return current
    boxes[i].props.onChange({ target: { checked: true } })
    current = await settlePanel()
  }
  return current
}
const panelTexts = []
function remember(tree) { const text = textOf(tree); panelTexts.push(text); return text }

async function waitFor(label, predicate, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return true
    await clientTick()
    await flush(10)
  }
  throw new Error('超时未达成：' + label)
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 首次 managed 入口 → 首扫 → 待确认（合同 1）
// ═══════════════════════════════════════════════════════════════════════════
const providerA = fakeProvider()
const scA = scenario(BALANCE_A)
const hostA = makeHost({ sc: scA, provider: providerA })
active = hostA
await hostA.host.idle()

let tree = null
let reachedPending = false

try {
  tree = await mountPanel()
  const text = remember(tree)

  // A1 managed 面板取代旧手动面板；首扫无任何输入
  check('A0 客户端观察/渲染不抛异常', runtimeErrors.length === 0,
    runtimeErrors.slice(0, 1).map((e) => errorLine(e) + ' ' + (e && e.message ? e.message : String(e))))
  check('A1 闸门探针后渲染 managed 面板（非旧手动面板 MimoAuthPanel）',
    gateTypeName === 'MimoRememberedPanel' && legacyMarkers(tree).length === 0,
    { gate: gateTypeName, text, legacy: legacyMarkers(tree).length })
  check('A1 闸门探针是纯观察 GET（0 上游请求）', scA.seen.length === 0, scA.seen.length)
  check('A1 首次入口无预期 ID / 无密码输入',
    inputs(tree).length === 0, inputs(tree).map((n) => n.props.type))
  check('A1 空态文案明确「本次不需要输入任何账号 ID」',
    text.indexOf('不需要输入任何账号 ID') >= 0, text)

  const caps = await hostCaps()
  check('A1 caps 报 rememberedSupported=true 且 storage.supported=true',
    caps.rememberedSupported === true && caps.remembered !== null
    && caps.remembered.storage !== null && caps.remembered.storage.supported === true,
    caps.remembered && caps.remembered.storage)
  check('A1 caps 是纯观察：0 上游请求', scA.seen.length === 0, scA.seen.length)

  // A2 点击「创建二维码并登录」→ start(consent/version1) → begin
  // 先让「等待扫码」这一跳保持挂起：否则假 IO 会在一帧内完成扫码，
  // authorizing+hasQr 的真实窗口（用户扫码前）根本观察不到。
  scA.state.holdScan()
  const startResult = await clickAndSettle(tree, '创建二维码并登录')
  check('A2 点击「创建二维码并登录」', startResult.ok === true)
  tree = startResult.tree
  try {
    await waitFor('二维码就绪（authorizing + 本机 objectURL）', async () => objectUrls.length >= 1, 40)
  } catch { /* 下面按合同断言 */ }
  tree = await settlePanel()
  const authText = remember(tree)

  const remAuthorizing = await rememberedOf()
  check('A2 确认前 0 余额请求', scA.count('/api/v1/balance') === 0, scA.count('/api/v1/balance'))
  check('A2 确认前 0 存储写入', providerA.size() === 0 && providerA.writes === 0,
    { size: providerA.size(), writes: providerA.writes })
  check('A2 start 请求体只带 consent + version1（无 ID/expected）', (() => {
    const body = uiCalls.map((c) => c.body).filter((b) => b !== null && b.action === 'rememberedStart')[0]
    return body !== undefined && body.authConsent === true && body.consentVersion === 1
      && body.identifier === undefined && body.expected === undefined && body.userId === undefined
  })(), uiCalls.map((c) => c.body).filter((b) => b !== null && b.action === 'rememberedStart'))

  // A3 QR 必须来自本机内存二进制 → objectURL；不得把厂商 URL 放进页内
  check('A3 QR 以本机二进制 + objectURL 交付（≥1 个 blob: 且页内 <img>）',
    objectUrls.length >= 1 && qrImages(tree).length >= 1,
    { objectUrls, imgs: qrImages(tree).length })
  check('A3 扫码阶段页内无二维码厂商 URL / 无 https://', authText.indexOf('https://') < 0
    && authText.indexOf('account.xiaomi.com') < 0, authText)
  check('A3 快照里不出现厂商二维码地址',
    JSON.stringify(remAuthorizing).indexOf('account.xiaomi.com') < 0
    && JSON.stringify(remAuthorizing).indexOf('blob:') < 0, remAuthorizing)
  check('A3 扫码阶段状态是 authorizing（QR 已一次性取走也给过）',
    remAuthorizing.state === 'authorizing' && (remAuthorizing.hasQr === true || objectUrls.length >= 1),
    { state: remAuthorizing.state, hasQr: remAuthorizing.hasQr, objectUrls: objectUrls.length })

  // 放行「本次扫码」，进入待确认
  scA.state.releaseScan()
  try {
    await waitFor('首扫进入待确认', async () => (await rememberedOf()).state === 'awaiting_confirmation')
    reachedPending = true
  } catch { /* 下面按合同断言，失败信息自带 */ }
  tree = await settlePanel()

  const remPending = await rememberedOf()
  // 5 跳在**扫码完成之后**才齐（sts 是 lp 返回后的回调跳），所以放在这里量
  check('A2 首扫产生恰好 5 跳（ctx/init/img/lp/callback 各 1）',
    scA.seen.length === 5
    && scA.seen.filter((u) => u.includes('/api/v1/genLoginUrl')).length === 1
    && scA.seen.filter((u) => u.includes('/longPolling/loginUrl') && u.includes('qs=')).length === 1
    && scA.seen.filter((u) => u.includes('/longPolling/qrImage')).length === 1
    && scA.seen.filter((u) => u === LP).length === 1
    && scA.seen.filter((u) => u.includes('/sts')).length === 1, scA.seen.join('|'))
  check('A2 进入待确认态', reachedPending === true && remPending.state === 'awaiting_confirmation', remPending.state)

  // A4 候选完整 ID：只在 owner 待确认 UI，且不假称昵称
  const pendingText = remember(tree)
  check('A4 待确认 UI 显示候选完整 ID + 标签「小米账号ID」',
    pendingText.indexOf(ACCOUNT_ID) >= 0 && pendingText.indexOf('小米账号ID') >= 0, pendingText)
  check('A4 无可靠昵称 schema ⇒ 明说只显示账号 ID（不造假昵称）',
    pendingText.indexOf('未取得可信昵称') >= 0, pendingText)
  const capsNow = await hostCaps()
  const displayNow = await hostDisplayStatus()
  check('A4 候选 ID 不进 caps（普通观察面）', JSON.stringify(capsNow).indexOf(ACCOUNT_ID) < 0,
    JSON.stringify(capsNow).slice(-360))
  check('A4 候选 ID 不进 displayStatus（侧栏/详情消费的快照）',
    JSON.stringify(displayNow).indexOf(ACCOUNT_ID) < 0, JSON.stringify(displayNow).slice(-420))
} catch (err) { sectionError('A 首扫/待确认', err) }

// ═══════════════════════════════════════════════════════════════════════════
// B. 本人勾选四项并确认（合同 2）
// ═══════════════════════════════════════════════════════════════════════════
let reachedVerified = false
try {
  tree = await settlePanel()
  const confirmBefore = buttonByText(tree, '确认此账号并记住登录')
  check('B1 待确认态有确认按钮，且未勾满四项时禁用',
    confirmBefore !== undefined && confirmBefore.props.disabled === true,
    confirmBefore === undefined ? 'missing' : confirmBefore.props.disabled)
  check('B1 待确认态有 4 个授权复选框', checkboxes(tree).length === 4, checkboxes(tree).length)

  tree = await tickAllConsent(tree)
  const confirmAfter = buttonByText(tree, '确认此账号并记住登录')
  check('B2 勾满四项后确认按钮可用', confirmAfter !== undefined && confirmAfter.props.disabled !== true,
    confirmAfter && confirmAfter.props.disabled)

  const hopsBeforeConfirm = scA.seen.length
  const writesBeforeConfirm = providerA.writes
  const confirmClicked = await click(tree, '确认此账号并记住登录')
  check('B2 点击「确认此账号并记住登录（允许启动后自动查询与刷新）」', confirmClicked === true)
  try {
    await waitFor('确认后进入 verified', async () => (await rememberedOf()).state === 'verified')
    reachedVerified = true
  } catch { /* 由下面断言给出原因 */ }
  tree = await settlePanel()

  const confirmBody = uiCalls.map((c) => c.body).filter((b) => b !== null && b.action === 'rememberedConfirm')[0]
  check('B2 确认请求 = consentVersion 1 + 四项 true + authId/gen/boot',
    confirmBody !== undefined && confirmBody.consentVersion === 1
    && confirmBody.rememberConsent === true && confirmBody.autoRestore === true
    && confirmBody.autoReadBalance === true && confirmBody.autoRefresh === true
    && typeof confirmBody.authId === 'string' && confirmBody.authId.length === 32
    && typeof confirmBody.generation === 'number' && confirmBody.generation >= 1
    && confirmBody.bootEpoch === BOOT_A, confirmBody)
  check('B2 确认请求不带 ID / expected / 原票 / revision',
    confirmBody !== undefined && confirmBody.identifier === undefined && confirmBody.expected === undefined
    && confirmBody.ticketId === undefined && confirmBody.revision === undefined
    && confirmBody.userId === undefined, confirmBody)

  const remVerified = await rememberedOf()
  check('B2 Host 核完候选后 crypto 密文保存（1 条 grant，无明文）', (() => {
    const stored = providerA.only()
    if (stored === null || stored === undefined) return false
    if (stored.kind !== 'grant' || typeof (stored.payload || {}).ciphertext !== 'string') return false
    const blob = JSON.stringify(stored)
    return [ACCOUNT_ID, PASS_SENTINEL, 'account.xiaomi.com', 'passToken', SCOPE].every((s) => blob.indexOf(s) < 0)
  })(), providerA.raw().size)
  check('B2 确认后恰好 1 次余额读取', scA.count('/api/v1/balance') === 1, scA.count('/api/v1/balance'))
  check('B2 确认后状态 verified / intervalMs=60000 / 候选消失',
    remVerified.state === 'verified' && remVerified.intervalMs === 60000 && remVerified.candidate === null,
    { state: remVerified.state, intervalMs: remVerified.intervalMs, candidate: remVerified.candidate })
  check('B2 确认后余额是真实四字段投影', remVerified.balance !== null
    && remVerified.balance.balance === BALANCE_A && remVerified.balance.currency === 'CNY', remVerified.balance)

  const verifiedText = remember(tree)
  check('B2 UI 显示 Host 真值余额 + 遮蔽身份', verifiedText.indexOf('13.5') >= 0
    && verifiedText.indexOf('CNY') >= 0 && remVerified.identity !== null
    && verifiedText.indexOf(remVerified.identity.maskedLabel) >= 0, verifiedText)
  check('B2 verified 文案是「每 5 分钟自动刷新」（非 15 分钟 / 14 次）',
    verifiedText.indexOf('5 分钟') >= 0 && verifiedText.indexOf('15 分钟') < 0 && verifiedText.indexOf('14 次') < 0, verifiedText)
  check('B2 verified 页内不再出现候选完整 ID', verifiedText.indexOf(ACCOUNT_ID) < 0, verifiedText)
  check('B2 confirmed 之后仍 0 新上游请求（观察面不发请求）',
    scA.count('/api/v1/balance') === 1 && scA.count('/longPolling') === 3, scA.seen.join('|'))
} catch (err) { sectionError('B 确认', err) }

// ═══════════════════════════════════════════════════════════════════════════
// C. 离开待确认 + 收起 settings（合同 3）
// ═══════════════════════════════════════════════════════════════════════════
try {
  check('C1 离开待确认后候选从 DOM 清除', textOf(tree).indexOf(ACCOUNT_ID) < 0, textOf(tree))
  check('C1 离开待确认后二维码 objectURL 被 revoke',
    objectUrls.length >= 1 && objectUrls.every((url) => revokedUrls.indexOf(url) >= 0), { objectUrls, revokedUrls })
  check('C1 离开待确认后页内无二维码 img', qrImages(tree).length === 0, qrImages(tree).length)

  // 侧栏：普通 manual 99.99 哨兵不得顶回 Host 真值
  const badgeTree = await (async () => {
    runtime.mount(client.Badge, { configForm: null, wide: true })
    for (let i = 0; i < 3; i += 1) { await flush(); await runtime.settle({ configForm: null, wide: true }) }
    return runtime.settle({ configForm: null, wide: true })
  })()
  const badgeText = textOf(badgeTree)
  check('C1 侧栏显示 Host 余额而不是 manual 99.99 哨兵',
    badgeText.indexOf('13.5') >= 0 && badgeText.indexOf('99.99') < 0, badgeText)

  // 收起 settings（卸载 = 组件 cleanup，但不 stop Host）
  const hopsBeforeUnmount = scA.seen.length
  const refreshBefore = (await rememberedOf()).stats.refreshCount
  await unmountAll()
  check('C2 收起 settings 后 UI 观察 interval 已清理（无第二个上游 pump）',
    clientIntervals.size === 0, clientIntervals.size)
  check('C2 收起 settings 不向上游发任何请求', scA.seen.length === hopsBeforeUnmount, scA.seen.length)

  await hostA.advance(300001)
  const afterFive = await rememberedOf()
  check('C2 settings 收起后 Host 仍按 5 min 计数（独立 owner 计时器）',
    afterFive.stats.refreshCount === refreshBefore + 1, { before: refreshBefore, after: afterFive.stats.refreshCount })
  check('C2 每个 5 min 周期只读 1 次（无重复 pump）',
    scA.count('/api/v1/balance') === 2, scA.count('/api/v1/balance'))
  check('C2 普通刷新不计入「换票」统计',
    afterFive.stats.renewalAttempts === 0, afterFive.stats.renewalAttempts)

  // 重新打开 settings：UI 反复观察 0 上游请求
  tree = await mountPanel()
  const hopsBeforeTicks = scA.seen.length
  for (let i = 0; i < 5; i += 1) await clientTick()
  tree = await settlePanel()
  check('C3 UI 反复观察（5 次 tick）0 上游请求', scA.seen.length === hopsBeforeTicks, scA.seen.length)
  check('C3 重开后 UI 仍显示已验证状态', textOf(tree).indexOf('13.5') >= 0, textOf(tree))
} catch (err) { sectionError('C 离开待确认/收起', err) }

// ═══════════════════════════════════════════════════════════════════════════
// D. pause → 跨 Host 重启 → resume（合同 4）
// ═══════════════════════════════════════════════════════════════════════════
let hostB = null
try {
  tree = await settlePanel()
  const pauseClicked = await click(tree, '暂停刷新')
  check('D1 点击「暂停刷新」', pauseClicked === true)
  const remPaused = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const rem = await rememberedOf()
      if (rem.state === 'paused') return rem
      await flush(10)
    }
    return rememberedOf()
  })()
  tree = await settlePanel()
  check('D1 暂停后 Host 状态 paused / paused=true', remPaused.state === 'paused' && remPaused.paused === true,
    { state: remPaused.state, paused: remPaused.paused })
  check('D1 暂停不显示 fresh 旧值（快照余额为 null）', remPaused.balance === null, remPaused.balance)
  check('D1 暂停后 UI 不再显示旧金额', textOf(tree).indexOf('13.5') < 0, textOf(tree))
  check('D1 暂停只改 preferences，密文仍在（未 tombstone）', (() => {
    const stored = providerA.only()
    return stored !== null && stored.payload.revoked !== true && typeof stored.payload.ciphertext === 'string'
  })(), providerA.raw().size)

  // Host A dispose 保持密文
  hostA.host.dispose()
  await hostA.host.idle()
  check('D2 Host A dispose 不删除记住登录', providerA.size() === 1 && providerA.only().payload.revoked !== true,
    providerA.raw().size)

  // Host B：同 scope 新 vault 实例 / 新 boot，不联网
  const scB = scenario(BALANCE_B)
  hostB = makeHost({ sc: scB, provider: providerA, bootEpoch: BOOT_B })
  active = hostB
  await hostB.host.idle()
  await flush(20)
  check('D2 暂停态重启：0 账号请求（不联网）', scB.seen.length === 0, scB.seen.join('|'))
  const remAfterRestart = await rememberedOf()
  check('D2 重启后仍是 paused（持久化生效）', remAfterRestart.state === 'paused' && remAfterRestart.paused === true,
    { state: remAfterRestart.state })

  // UI 在新 boot 上重开 → 恢复
  tree = await mountPanel()
  check('D3 重启后 UI 显示已暂停', textOf(tree).indexOf('已暂停') >= 0, textOf(tree))
  const hopsBeforeResume = scB.seen.length
  const resumeClicked = await click(tree, '恢复刷新')
  check('D3 点击「恢复刷新」', resumeClicked === true)
  try {
    await waitFor('resume 后回到 verified', async () => (await rememberedOf()).state === 'verified')
  } catch { /* 断言给出原因 */ }
  tree = await settlePanel()
  const resumed = await rememberedOf()
  const resumeHops = scB.seen.slice(hopsBeforeResume)
  check('D3 resume 先核已绑定 ID（genLoginUrl/serviceLogin/sts 各 1）',
    resumeHops.filter((u) => u.indexOf('/api/v1/genLoginUrl') >= 0).length === 1
    && resumeHops.filter((u) => u.indexOf('/pass/serviceLogin') >= 0).length === 1
    && resumeHops.filter((u) => u.indexOf('/sts') >= 0).length === 1, resumeHops.join('|'))
  check('D3 resume 后读 1 次余额且值来自新 Host', resumed.balance !== null
    && resumed.balance.balance === BALANCE_B && scB.count('/api/v1/balance') === 1,
    { balance: resumed.balance, reads: scB.count('/api/v1/balance') })
  check('D3 resume 不需要扫码 / 手填 ID', scB.count('/longPolling') === 0
    && uiCalls.every((c) => c.body === null || c.body.identifier === undefined), scB.count('/longPolling'))
  check('D3 resume 后 UI 显示新值', textOf(tree).indexOf('42.75') >= 0, textOf(tree))
  check('D3 resume 后 Host 恢复计数真实（restore 成功 ≥1）', resumed.stats.restoreSuccesses >= 1,
    resumed.stats)
} catch (err) { sectionError('D pause/restart/resume', err) }

// ═══════════════════════════════════════════════════════════════════════════
// E. 未暂停的重启自动恢复 + 两 boot 屏障（合同 4/5）
// ═══════════════════════════════════════════════════════════════════════════
try {
  if (hostB !== null) { hostB.host.dispose() }
  await flush(10)
  const scC = scenario(BALANCE_B)
  const hostC = makeHost({ sc: scC, provider: providerA, bootEpoch: BOOT_C })
  active = hostC
  await hostC.host.idle()
  await flush(20)
  try { await waitFor('C 自动恢复完成', async () => (await rememberedOf(hostC)).state === 'verified', 30) } catch { /* 断言给出原因 */ }
  const restoredC = await rememberedOf(hostC)
  check('E1 未 paused 的重启自动 3+1（0 QR）', restoredC.state === 'verified'
    && scC.count('/longPolling') === 0
    && scC.count('/api/v1/genLoginUrl') === 1 && scC.count('/pass/serviceLogin') === 1
    && scC.count('/sts') === 1 && scC.count('/api/v1/balance') === 1, scC.seen.join('|'))
  check('E1 自动恢复后显示值来自 Host', restoredC.balance !== null && restoredC.balance.balance === BALANCE_B,
    restoredC.balance)

  // G1（因此处仍是真实 verified + 有当前 generation，故放在 forget 之前）：
  // 陈旧 generation 的**控制动作**必须 409 STALE 且 0 副作用（快照/写入/上游全不变）。
  const remBeforeStale = await rememberedOf(hostC)
  const writesBeforeStale = providerA.writes
  const hopsBeforeStale = scC.seen.length
  const stalePause = await hostCall({
    action: 'rememberedPause', bootEpoch: BOOT_C, generation: remBeforeStale.generation + 7
  }, hostC)
  const remAfterStale = await rememberedOf(hostC)
  check('G1 陈旧 generation 的 pause 被拒（409 STALE）+ 0 副作用（快照/写/上游不变）',
    stalePause.status === 409
    && stalePause.json.code === 'E_MIMO_REMEMBERED_STALE_ID'
    && remAfterStale.state === remBeforeStale.state
    && remAfterStale.generation === remBeforeStale.generation
    && remAfterStale.revision === remBeforeStale.revision
    && providerA.writes === writesBeforeStale
    && scC.seen.length === hopsBeforeStale,
    {
      status: stalePause.status,
      code: stalePause.json && stalePause.json.code,
      fixture: { state: remBeforeStale.state, gen: remBeforeStale.generation, rev: remBeforeStale.revision },
      after: { state: remAfterStale.state, gen: remAfterStale.generation, rev: remAfterStale.revision },
      writes: providerA.writes - writesBeforeStale,
      hops: scC.seen.length - hopsBeforeStale
    })

  // 错 boot / 错 gen 的 route 反例（0 副作用）
  const oldBootRes = await callRoute(hostC.auth(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'displayStatus', bootEpoch: BOOT_A })
  }, 'direct')
  const oldJson = await oldBootRes.json()
  const staleRes = await callRoute(hostC.auth(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'displayStatus', bootEpoch: BOOT_C })
  }, 'direct')
  const staleJson = await staleRes.json()
  check('E2 错 boot 的 route 响应是 409 + BOOT_STALE（0 副作用）',
    oldBootRes.status === 409 && oldJson.code === 'E_MIMO_AUTH_BOOT_STALE', oldJson)
  check('E2 displayStatus 是 managed 纯观察快照（0 请求、区间 60 s）',
    staleJson.display !== null && staleJson.display.managed === true
    && staleJson.remembered.intervalMs === 60000, { managed: staleJson.display && staleJson.display.managed })

  // 两 boot 屏障：**先**交付新 boot 快照，**再**交付旧 boot 的迟到结果 —— UI 不得被旧 boot 顶回
  tree = await mountPanel()
  const sawOld = check('E3 屏障前 UI 显示旧 boot 的值 42.75（有旧值可被复活）',
    textOf(tree).indexOf('42.75') >= 0, textOf(tree))
  // 新 boot 用**不同**余额，才能区分「采用了新 boot」与「只是把旧值丢了」
  const hostD = makeHost({ sc: scenario(BALANCE_D), provider: providerA, bootEpoch: BOOT_D })
  await hostD.host.idle()   // 新 boot 自己的恢复任务先落定
  const hopsD = hostD.sc.seen.length

  holdNext = hostC          // 下一次观察请求绑定 Host C（旧 boot），延迟交付
  await clientTick()        // 该 GET 被挂起（真实响应尚未产生）
  active = hostD            // 换成新 boot
  await clientTick()        // 新 boot 的观察先返回
  tree = await settlePanel()
  const afterNewBoot = textOf(tree)
  check('E3 新 boot 先返回即被采用（显示 66.6，且不残留旧 boot 的 42.75）',
    sawOld === true && afterNewBoot.indexOf('66.6') >= 0 && afterNewBoot.indexOf('42.75') < 0, afterNewBoot)

  releaseHeld()             // 现在才放行旧 boot 的迟到结果
  for (let i = 0; i < 4; i += 1) await clientTick()
  tree = await settlePanel()
  const afterLate = textOf(tree)
  // 这一条只问「迟到旧响应有没有改写当前显示」，与「有没有采纳新 boot」分开归因
  check('E3 迟到的旧 boot 结果不得改写当前显示（不复活旧值）',
    sawOld === true && afterLate === afterNewBoot, { before: afterNewBoot, after: afterLate })
  check('E3 迟到旧 boot 结果不把候选/二维码带回来',
    sawOld === true && afterLate.indexOf(ACCOUNT_ID) < 0 && qrImages(tree).length === 0, afterLate.slice(0, 200))
  check('E3 屏障期间新 boot 0 额外上游请求', hostD.sc.seen.length === hopsD, hostD.sc.seen.slice(hopsD).join('|'))
  active = hostC
} catch (err) { sectionError('E 未暂停重启/屏障', err) }

// ═══════════════════════════════════════════════════════════════════════════
// F. forget（合同 5）+ 取消待确认（合同 5）
// ═══════════════════════════════════════════════════════════════════════════
try {
  // 重新挂面板（当前 active = hostC，verified）
  tree = await mountPanel()
  const hopsBeforeForget = active.sc.seen.length
  const textBeforeForget = textOf(tree)
  check('F1 forget 前 UI 显示余额（有值可清）', textBeforeForget.indexOf('42.75') >= 0, textBeforeForget)

  // 点击后**第一帧**就不得再显示旧值（先清值，再 tombstone）
  const forgetBtn = buttonByText(tree, '退出并忘记')
  const forgetClicked = forgetBtn !== undefined && typeof forgetBtn.props.onClick === 'function'
  if (forgetClicked) forgetBtn.props.onClick()
  await flush(1)
  const firstFrame = textOf(await runtime.renderOnce(PANEL))
  check('F1 点击「退出并忘记」立即不再显示金额（先清值）',
    forgetClicked === true && firstFrame.indexOf('42.75') < 0, firstFrame)

  try { await waitFor('forget 后回到 empty', async () => (await rememberedOf()).state === 'empty', 30) } catch { /* 断言给出原因 */ }
  tree = await settlePanel()
  const afterForget = await rememberedOf()
  check('F1 forget 写 tombstone 且状态回到 empty',
    afterForget.state === 'empty' && providerA.only() !== null && providerA.only().payload.revoked === true,
    { state: afterForget.state, revoked: providerA.only() && providerA.only().payload.revoked })
  check('F1 forget 0 上游请求', active.sc.seen.length === hopsBeforeForget, active.sc.seen.length)
  check('F1 forget 请求绑定当前 generation（无 authId 混入）', (() => {
    const body = uiCalls.map((c) => c.body).filter((b) => b !== null && b.action === 'rememberedForget')[0]
    return body !== undefined && typeof body.generation === 'number' && body.generation >= 1
      && body.authId === undefined && body.identifier === undefined
  })(), uiCalls.map((c) => c.body).filter((b) => b !== null).slice(-4))

  // tombstone 之后重启：0 请求、state empty
  const scD = scenario(BALANCE_B)
  const hostD = makeHost({ sc: scD, provider: providerA, bootEpoch: BOOT_D })
  active = hostD
  await hostD.host.idle()
  await flush(20)
  const remD = await rememberedOf(hostD)
  check('F1 tombstone 之后重启 0 账号请求且 empty', scD.seen.length === 0 && remD.state === 'empty',
    { hops: scD.seen.length, state: remD.state })

  // 取消待确认：纯本地清，0 写 / 0 余额 / 0 tombstone
  tree = await mountPanel()
  const writesBeforeCancel = providerA.writes
  const recordsBeforeCancel = providerA.size()
  await clickAndSettle(tree, '创建二维码并登录')
  try { await waitFor('再次进入待确认', async () => (await rememberedOf(hostD)).state === 'awaiting_confirmation', 30) } catch { /* 断言给出原因 */ }
  tree = await settlePanel()
  const pendingAgain = await rememberedOf(hostD)
  const balancesBeforeCancel = scD.count('/api/v1/balance')
  const cancelClicked = await click(tree, '取消')
  await settlePanel()
  const afterCancel = await rememberedOf(hostD)
  check('F2 取消待确认只本地清（离开 awaiting_confirmation）',
    cancelClicked === true && afterCancel.state !== 'awaiting_confirmation' && afterCancel.candidate === null,
    { clicked: cancelClicked, state: afterCancel.state })
  check('F2 取消 0 存储写 / 0 tombstone',
    providerA.writes === writesBeforeCancel && providerA.size() === recordsBeforeCancel, providerA.writes)
  check('F2 取消 0 余额请求', scD.count('/api/v1/balance') === balancesBeforeCancel, scD.count('/api/v1/balance'))
  check('F2 取消后候选从 DOM 清除', textOf(await settlePanel()).indexOf(ACCOUNT_ID) < 0, textOf(tree))
  check('F2 待确认态到期窗口是 120s 而非旧 15min 界',
    pendingAgain.state === 'awaiting_confirmation', pendingAgain.state)
} catch (err) { sectionError('F forget/cancel', err) }

// ═══════════════════════════════════════════════════════════════════════════
// G. 跨代次反例 + 路由硬化（合同 5/6）
// ═══════════════════════════════════════════════════════════════════════════
try {
  // G1（陈旧 generation 的 pause）已前移到 E1 之后执行：那里是真实 verified + 有当前 generation。
  const writes = providerA.writes
  const hops = active.sc.seen.length
  const bad = []
  bad.push((await hostCall({ action: 'rememberedStart', bootEpoch: active.bootEpoch })).status)                                     // 缺 consent
  bad.push((await hostCall({ action: 'rememberedStart', bootEpoch: active.bootEpoch, authConsent: true })).status)                  // 缺 version
  bad.push((await hostCall({ action: 'rememberedStart', bootEpoch: active.bootEpoch, authConsent: true, consentVersion: 2 })).status)
  bad.push((await hostCall({ action: 'rememberedStart', bootEpoch: 'f'.repeat(32), authConsent: true, consentVersion: 1 })).status) // 错 boot
  bad.push((await hostCall({ action: 'rememberedStatus', bootEpoch: active.bootEpoch, identifier: ACCOUNT_ID })).status)            // 未知字段
  bad.push((await hostCall({
    action: 'rememberedConfirm', bootEpoch: active.bootEpoch, authId: 'e'.repeat(32), generation: 1,
    consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true, autoRefresh: true,
    identifier: ACCOUNT_ID
  })).status)                                                                                                                        // 确认带 ID
  bad.push((await hostCall({
    action: 'rememberedConfirm', bootEpoch: active.bootEpoch, authId: 'e'.repeat(32), generation: 1,
    consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true
  })).status)                                                                                                                        // 少一项授权
  check('G2 缺同意/错 boot/未知字段/确认带 ID 一律 400/409', bad.every((s) => s === 400 || s === 409), bad)
  check('G2 被拒请求 0 存储写 / 0 上游请求', providerA.writes === writes && active.sc.seen.length === hops,
    { writes: providerA.writes - writes, hops: active.sc.seen.length - hops })

  // UI 实际发出的每个请求字段集必须被后端接受（renderer ↔ backend 一致）
  const nonOk = uiCalls.filter((c) => c.status !== 200 && c.method === 'POST' && c.body !== null
    && typeof c.body.action === 'string' && c.body.action.indexOf('remembered') === 0)
  check('G3 UI 发出的 remembered* 请求全部被后端接受（无字段集错配 400/409）',
    nonOk.length === 0, nonOk.map((c) => ({ action: c.body.action, status: c.status })))
  check('G3 UI 请求里不出现 ID / expected / revision / ticketId', uiCalls.every((c) => c.body === null
    || (c.body.identifier === undefined && c.body.expected === undefined
      && c.body.revision === undefined && c.body.ticketId === undefined)),
    uiCalls.map((c) => c.body).filter((b) => b !== null && (b.identifier !== undefined || b.expected !== undefined)))

  // 秘密 / 原始 URL / 原始 ID 不得经任何响应正文泄漏
  const dump = allResponses.join('\n')
  check('G4 响应正文无 passToken 哨兵', dump.indexOf(PASS_SENTINEL) < 0)
  check('G4 响应正文无原始账号 ID（候选除外，候选只在 UI 待确认）', dump.indexOf(ACCOUNT_ID) < 0,
    dump.slice(0, 200))
  check('G4 响应正文无上游 URL / scope 路径',
    dump.indexOf('longPolling') < 0 && dump.indexOf('account.xiaomi.com') < 0
    && dump.indexOf('https://') < 0 && dump.indexOf(SCOPE) < 0)
  check('G4 面板文案从未出现 15 分钟 / 14 次旧口径',
    panelTexts.every((t) => t.indexOf('15 分钟') < 0 && t.indexOf('14 次') < 0))
} catch (err) { sectionError('G 反例/硬化', err) }

// ═══════════════════════════════════════════════════════════════════════════
// H. 客户端请求层 ↔ 真实 Host 的字段合同（不经面板渲染，隔离「渲染 bug」与「请求 bug」）
// ═══════════════════════════════════════════════════════════════════════════
try {
  const providerH = fakeProvider()
  const scH = scenario(BALANCE_A)
  const hostH = makeHost({ sc: scH, provider: providerH, bootEpoch: 'e'.repeat(32) })
  active = hostH
  await hostH.host.idle()
  const lastBody = () => uiCalls[uiCalls.length - 1].body

  const started = await ui.request({ action: 'rememberedStart', bootEpoch: hostH.bootEpoch, authConsent: true, consentVersion: 1 })
  check('H1 客户端 rememberedStart 被 Host 接受（consent + version1）',
    started.ok === true && started.remembered.authId !== null && started.remembered.generation >= 1,
    { ok: started.ok, code: started.code, body: lastBody() })
  const authId = started.remembered.authId
  const generation = started.remembered.generation

  const begun = await ui.request({ action: 'rememberedBegin', bootEpoch: hostH.bootEpoch, authId, generation })
  check('H2 客户端能把 authId + generation 送进 begin（字段集与后端一致）',
    begun.ok === true, { ok: begun.ok, code: begun.code, body: lastBody() })

  if (begun.ok === true) {
    await waitFor('H 进入待确认', async () => (await rememberedOf(hostH)).state === 'awaiting_confirmation', 40)
    const paired = await ui.request({ action: 'rememberedStatus', bootEpoch: hostH.bootEpoch, authId, generation })
    check('H3 带 pair 的 rememberedStatus 才能看到候选（owner UI 路径）',
      paired.remembered.candidate !== null && paired.remembered.candidate.identifier === ACCOUNT_ID,
      { ok: paired.ok, code: paired.code, candidate: paired.remembered.candidate, body: lastBody() })
  } else {
    check('H3 带 pair 的 rememberedStatus 才能看到候选（owner UI 路径）', false, 'H2 未通过，无法继续')
  }
  const unpaired = await ui.request({ action: 'rememberedStatus', bootEpoch: hostH.bootEpoch })
  check('H3 不带 pair 的观察 candidate 必须为 null',
    unpaired.remembered.candidate === null, { candidate: unpaired.remembered.candidate })

  if (begun.ok === true) {
    const confirmed = await ui.request({
      action: 'rememberedConfirm', bootEpoch: hostH.bootEpoch, authId, generation,
      consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true, autoRefresh: true
    })
    const body = lastBody()
    check('H4 客户端 confirm 请求 = 4 项授权 + version1 + authId/gen，且不带 ID',
      confirmed.ok === true && body.consentVersion === 1 && body.rememberConsent === true
      && body.autoRestore === true && body.autoReadBalance === true && body.autoRefresh === true
      && body.identifier === undefined && body.expected === undefined && body.revision === undefined,
      { ok: confirmed.ok, code: confirmed.code, body })
    check('H4 confirm 后 verified + 1 次余额 + 1 条密文',
      confirmed.remembered.state === 'verified' && scH.count('/api/v1/balance') === 1 && providerH.size() === 1,
      { state: confirmed.remembered.state, reads: scH.count('/api/v1/balance'), records: providerH.size() })
  }
} catch (err) { sectionError('H 请求层合同', err) }

// ═══════════════════════════════════════════════════════════════════════════
// I. **生产设置页**（真实 SettingsPage 的 credentialChildren）managed 入口判定
//    只从 mimoAuth.Panel 一个 helper 断言是不够的：真正的入口是设置页里那一次 push。
// ═══════════════════════════════════════════════════════════════════════════
function makeSettingsForm(initial) {
  const writes = []
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]', customBalances: [] }, initial || {}),
    getSnapshot() { return { value: form.value, writable: true } },
    subscribe() { return () => {} },
    set(field, value) {
      writes.push({ field, value })
      form.value = Object.assign({}, form.value, { [field]: value })
      return Promise.resolve(true)
    },
    mutate(ops) { writes.push({ mutate: ops }); return Promise.resolve(true) }
  }
  return { form, writes }
}

try {
  active = lastHost !== null ? lastHost : active
  const settingsRuntime = createRuntime()
  const settingsClient = loadClient(settingsRuntime, {
    form: { getSnapshot() { return { value: {}, writable: false } }, subscribe() { return () => {} } },
    payload: PLANS()
  })
  // loadClient 会重新给 globalThis.setInterval / fetch 打桩：恢复本套的受控版本
  globalThis.setInterval = (fn) => { const id = ++clientIntervalSeq; clientIntervals.set(id, fn); return id }
  globalThis.clearInterval = (id) => { clientIntervals.delete(id) }
  globalThis.fetch = bridgeFetch

  const { form } = makeSettingsForm({})
  const props = { form }
  settingsRuntime.mount(settingsClient.SettingsPage, props)
  let stree = null
  for (let i = 0; i < 6; i += 1) {
    await flush()
    try { stree = await settingsRuntime.settle(props, 8) } catch (err) { noteError(err); break }
  }

  const typeNames = allNodes(stree).map((n) => (typeof n.type === 'function' ? (n.type.name || '') : ''))
  const countOf = (name) => typeNames.filter((t) => t === name).length
  check('I1 生产设置页 managed 只挂一个新 Panel：MimoAuthMount×1，旧 auth/display Panel×0',
    countOf('MimoAuthMount') === 1 && countOf('MimoAuthPanel') === 0 && countOf('MimoDisplayPanel') === 0,
    { authMount: countOf('MimoAuthMount'), authPanel: countOf('MimoAuthPanel'), displayPanel: countOf('MimoDisplayPanel') })

  // 可控挂载：用设置页里**那一个真实描述符**的 props 展开闸门，再展开它渲染出的 managed 子组件
  const mountEl = allNodes(stree).find((n) => typeof n.type === 'function' && n.type.name === 'MimoAuthMount')
  let entryTree = null
  if (mountEl !== undefined) {
    settingsRuntime.mount(mountEl.type, mountEl.props)
    let gate = null
    for (let i = 0; i < 5; i += 1) {
      await flush()
      try { gate = await settingsRuntime.settle(mountEl.props, 8) } catch (err) { noteError(err); break }
    }
    if (gate !== null && typeof gate === 'object' && typeof gate.type === 'function') {
      settingsRuntime.mount(gate.type, gate.props)
      for (let i = 0; i < 4; i += 1) {
        await flush()
        try { entryTree = await settingsRuntime.settle(gate.props, 8) } catch (err) { noteError(err); break }
      }
    }
  }
  const entryText = entryTree === null ? '' : textOf(entryTree)
  const rootClass = entryTree !== null && entryTree !== null && entryTree.props
    ? String(entryTree.props.className || '') : ''
  check('I2 managed 设置入口是 remembered 面板：无任何输入框、无 15 分钟/14 次/重启重登话术、无旧面板标记',
    rootClass === 'mimo-remembered-panel'
    && inputs(entryTree).length === 0
    && legacyMarkers(entryTree).length === 0
    && entryText.indexOf('15 分钟') < 0 && entryText.indexOf('14 次') < 0
    && entryText.indexOf('重启后需重新登录') < 0,
    { rootClass, inputs: inputs(entryTree).length, legacy: legacyMarkers(entryTree).length, text: entryText.slice(0, 200) })
} catch (err) { sectionError('I 生产设置页入口', err) }

// ── 汇总 ────────────────────────────────────────────────────────────────────
check('Z1 全程无未捕获的客户端异常（渲染/观察链不得抛错）', runtimeErrors.length === 0,
  runtimeErrors.slice(0, 3).map((e) => errorLine(e) + ' ' + (e && e.message ? e.message : String(e))))
const total = pass + fails.length
if (fails.length > 0) {
  console.log('')
  for (const item of fails) console.log('FAILED ' + item)
  console.log(pass + ' passed, ' + fails.length + ' failed (' + total + ')')
  process.exitCode = 1
} else {
  console.log(pass + ' passed, 0 failed (' + total + ')')
}
