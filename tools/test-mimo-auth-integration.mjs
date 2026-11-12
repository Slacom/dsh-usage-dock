/**
 * MiMo G1 · 唯一一次「UI → Host」离线联接检查（零监听、零网络、零真实凭据）
 *
 * 目的：证明真实 client.js 面板发出的请求，能穿过**真实公开 SDK 的 owner fetch 分派**
 * 到达**真实 `plans/mimo-auth` 的 routes/host**，并在一个正常事务里完成
 * capability → start(idle) → begin(running) → status → cancel，
 * 且 `generation` 在线上是 **number**（Host 合同改为 positive safe integer）。
 *
 * 边界：
 *   - 不监听端口、不起 HTTP 服务、不实例化真实官方二维码流程；
 *   - flow 传输使用**完全内存合成 fixture**（只通过 Host 暴露的 display/approval 回调），
 *     任何外部网络调用一律没有发生（fixture 不调用 fetchImpl，计数器断言为 0）；
 *   - 输出只有 bool / 固定 code / 计数，**不打印** ticket、owner、cookie、余额、QR URL。
 *
 * 跑法：node tools/test-mimo-auth-integration.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { ROUTE_PATHS, ROUTE_CODES } from '../plans/mimo-auth/routes.js'
import { createRuntime, loadClient } from './mock-react.mjs'

const SDK = fileURLToPath(new URL('../.diagnostics/mimo-qr-20261025/sdk-current-parent/dsh-client-connection-lib-index.js', import.meta.url))

let pass = 0
let fail = 0
// 直接用真实 console.log：本文件后面会给 console 装哨兵，断言里不能自伤。
const plainLog = console.log.bind(console)
function check(name, condition, detail) {
  if (condition) { pass += 1; plainLog('[PASS] ' + name) }
  else { fail += 1; plainLog('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300))) }
}

// --- 与 Host 组共用的真实 SDK 加载 shim（不是“总是 200”的路由 mock） -----------
// 与 tools/test-mimo-auth-host.mjs 同一套 Service/zod/context 声明 shim，只是加载方式
// 改为 data: URL 重写（免 --experimental-vm-modules；仍加载**同一份真实 SDK 源码**）。
function dataUrl(source) {
  return 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
}
const CHAIN_FN = 'const chain=()=>{const p=new Proxy(function(){},{get:()=>p,apply:()=>p,construct:()=>p});return p};'
const SHIM_SOURCES = {
  'node:crypto': 'import * as m from "node:crypto"; export const createHash=m.createHash, createHmac=m.createHmac, randomBytes=m.randomBytes, randomUUID=m.randomUUID, timingSafeEqual=m.timingSafeEqual;',
  'node:stream': 'export { Readable } from "node:stream";',
  '@deepseek-ai/schemastery': CHAIN_FN + ' export default chain();',
  'zod': CHAIN_FN + ' export const z = chain(); export default chain();',
  '@deepseek-ai/cordis': 'export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }',
  '@deepseek-ai/dsh-credentials': 'export const credentialKey = (scope, id) => scope + "/" + id;',
  '@deepseek-ai/dsh-scope': 'export const createScope = (owner) => ({ ctx: owner && owner.extend ? owner.extend() : owner, dispose: async () => {} });',
}
async function loadActualRouter() {
  const SHIM_URLS = {}
  for (const [specifier, source] of Object.entries(SHIM_SOURCES)) SHIM_URLS[specifier] = dataUrl(source)
  let source = readFileSync(SDK, 'utf8')
  for (const [specifier, url] of Object.entries(SHIM_URLS)) {
    source = source.split('"' + specifier + '"').join('"' + url + '"')
    source = source.split("'" + specifier + "'").join('"' + url + '"')
  }
  const mod = await import(dataUrl(source))
  return mod
}

// --- 完全内存的 flow fixture：只走 Host 给的 display 回调，不触网 ---------------
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const flowStats = { loads: 0, runs: 0, networkAttempts: 0 }
function makeInMemoryFlow() {
  return {
    createMemoryFlow(deps) {
      return {
        async run({ signal }) {
          flowStats.runs += 1
          // 只做一次内存内的二维码“展示”，MIME 由真实 host 的 manager.setQr 校验
          await deps.display.showQr({ bytes: PNG, mime: 'image/png' })
          // 事务保持 running，直到被取消（cancel 会 abort）
          await new Promise((resolve) => {
            if (signal.aborted) { resolve(); return }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return { ok: false, gates: { qr: { ok: false }, balance: { ok: false } } }
        },
      }
    },
    CookieJar: class {
      absorber() {}
      clear() {}
      cookieHeaderFor() { return { header: null, names: [] } }
    },
  }
}

// --- Host 侧装配 --------------------------------------------------------------
const sdk = await loadActualRouter()
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get(name) { return name === 'webServer' ? { protocol: 'http:' } : undefined },
  extend() { return this },
  connection: null,
  webServer: { protocol: 'http:' },
}
const service = new sdk.HostConnectionService(ctx, [], {
  isAuthenticated: () => false,
  authenticateApi: () => undefined,
})
ctx.connection = service
const owner = { principal: { kind: 'owner' } }
const BOOT = 'a'.repeat(32)
let clock = 1_000_000
const host = createAuthHost(ctx, BOOT, () => {}, {
  now: () => clock,
  loadFlow: async () => { flowStats.loads += 1; return makeInMemoryFlow() },
})
const shared = service.createSharedFetchHandler('/api')

// --- 客户端 → Host 的桥（无监听、无网络） --------------------------------------
const wire = { requests: [], responses: [], forbiddenHits: [], bootEpochType: undefined }
// 只禁真正的敏感/越权字段：合同允许 owner DTO 里出现 balance（白名单结构另行校验）。
const FORBIDDEN_KEYS = ['cookie', 'cookies', 'userId', 'passToken', 'serviceToken', 'location', 'rawUrl', 'qrUrl']
const BALANCE_KEYS = ['balance', 'cashBalance', 'giftBalance', 'currency']
function scanForbidden(label, value) {
  const text = JSON.stringify(value)
  for (const key of FORBIDDEN_KEYS) {
    if (text.indexOf('"' + key + '"') >= 0) { wire.forbiddenHits.push(label + ':' + key); return }
  }
  if (value !== null && typeof value === 'object' && value.balance !== null && typeof value.balance === 'object') {
    for (const key of Object.keys(value.balance)) {
      if (BALANCE_KEYS.indexOf(key) === -1) wire.forbiddenHits.push(label + ':balance.' + key)
    }
  }
}
const realFetch = globalThis.fetch
function installBridge() {
  globalThis.fetch = async (url, init) => {
  const target = new URL(String(url), 'http://dsh.internal')
  const method = init !== undefined && init.method !== undefined ? init.method : 'GET'
  const record = { path: target.pathname, method, body: init !== undefined && typeof init.body === 'string' ? init.body : null }
  wire.requests.push(record)
  const request = new Request(target.href, {
    method,
    headers: init !== undefined && init.headers !== undefined ? init.headers : undefined,
    body: init !== undefined && typeof init.body === 'string' ? init.body : undefined,
    signal: init !== undefined ? init.signal : undefined,
  })
  const response = await shared.fetch(request, owner)
  const wrapped = {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    async json() {
      const data = await response.json()
      wire.responses.push({ path: target.pathname, status: response.status, code: data && data.code })
      if (data !== null && typeof data === 'object' && data.bootEpoch !== undefined) wire.bootEpochType = typeof data.bootEpoch
      scanForbidden(target.pathname, data)
      return data
    },
    blob: typeof response.blob === 'function' ? () => response.blob() : undefined,
  }
  return wrapped
  }
}

// --- 真实 client（mock 运行时，真实 loadClient） -------------------------------
const runtime = createRuntime()
const form = {
  value: { enabled: true, mimoEnabled: true, planOrder: '[]', customBalances: [] },
  getSnapshot() { return { value: this.value, writable: true } },
  subscribe() { return () => {} },
  set() { return Promise.resolve(true) },
  mutate() { return Promise.resolve(true) },
}
const client = loadClient(runtime, { form })
const api = client.module.mimoAuth
const Panel = api.LegacyPanel
// loadClient 自己设置了 globalThis.fetch，必须在它之后装桥。
installBridge()

// 客户端轮询 timer 用桩捕获（避免真实等待），并按需手动推进
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const pollTimers = []
globalThis.setTimeout = function (fn, ms) {
  if (ms === api.pollMs) { const rec = { fn }; pollTimers.push(rec); return 'flow-' + String(pollTimers.length) }
  return realSetTimeout(fn, ms)
}
globalThis.clearTimeout = function (id) { if (typeof id === 'string' && id.indexOf('flow-') === 0) return; return realClearTimeout(id) }
const createdUrls = []
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
URL.createObjectURL = () => { const url = 'blob:qr-' + String(createdUrls.length + 1); createdUrls.push(url); return url }
URL.revokeObjectURL = () => {}

const consoleCalls = []
for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[name]
  console[name] = function (...args) { consoleCalls.push({ name }); return original.apply(console, args) }
}
async function drain(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 0))
}
function byAttr(tree, attr, value) {
  const out = []
  const walk = (node, depth) => {
    if (node === null || node === undefined || typeof node === 'boolean' || depth > 14) return
    if (Array.isArray(node)) { node.forEach((child) => walk(child, depth)); return }
    if (typeof node !== 'object' || node.type === undefined) return
    if (node.props && (value === undefined ? node.props[attr] !== undefined : node.props[attr] === value)) out.push(node)
    walk(node.props ? node.props.children : undefined, depth + 1)
  }
  walk(tree, 0)
  return out
}

// =========================== 唯一一个正常事务 =================================
const panelProps = { disabled: false }
runtime.mount(Panel, panelProps)
const closed = await runtime.settle(panelProps)
check('I0 面板默认收起且未发任何请求', byAttr(closed, 'data-mimo-auth-panel', 'closed').length === 1 && wire.requests.length === 0)

// 1) 用户展开：GET capability（真实 owner 分派 → 真实 routes）
await byAttr(closed, 'data-mimo-auth', 'entry')[0].props.onClick()
await drain()
const ready = await runtime.settle(panelProps)
check('I1 capability 走真实 owner 路由并进入 ready', byAttr(ready, 'data-mimo-auth', 'start').length === 1
  && wire.requests.length === 1 && wire.requests[0].method === 'GET', wire.requests.map((r) => r.method + ' ' + r.path))

// 联接层的类型一致性前置检查：capability.bootEpoch 必须是 UI 投影能接受的类型。
// 若不匹配 → 精确报卡点并停止（绝不用假 expected 对象冒通过）。
if (wire.bootEpochType !== 'string') {
  console.log('[BLOCKED] capability.bootEpoch 的线上类型 = ' + String(wire.bootEpochType)
    + '；UI 投影只接受 number ⇒ bootEpoch 被丢弃，后续 POST 会缺字段。')
  restoreAll()
  console.log('')
  console.log('mimo-auth-integration: BLOCKED E_BOOTEPOCH_TYPE — ' + String(pass) + ' passed, ' + String(fail) + ' failed')
  process.exit(2)
}

// 2) start：只发 action+bootEpoch，Host 建 idle 会话
await byAttr(ready, 'data-mimo-auth', 'start')[0].props.onClick()
await drain()
const started = await runtime.settle(panelProps)
const startReq = wire.requests.filter((r) => r.body !== null).map((r) => JSON.parse(r.body)).find((b) => b.action === 'start')
// [A2 断言更新] start 体先后多了 allowDynamicLongPoll（长轮询开关）与 postQrConsent（扫码后同意开关），
// 与 test-mimo-auth-client 的 C6a 保持同一闭集口径；仍明确**不带** generation / ticket（由 Host 下发）。
check('I2 start 请求体只有 action+bootEpoch+allowDynamicLongPoll+postQrConsent（不带 generation）',
  startReq !== undefined
    && Object.keys(startReq).sort().join(',') === 'action,allowDynamicLongPoll,bootEpoch,postQrConsent',
  startReq && Object.keys(startReq))
check('I3 start 后 Host 会话为 idle 且 UI 进入 created', byAttr(started, 'data-mimo-auth', 'begin').length === 1)

// 3) begin：真实 routes → host.beginFlow → 内存 fixture → running
await byAttr(started, 'data-mimo-auth', 'begin')[0].props.onClick()
await drain()
// fixture 的 showQr 是异步的；若首个 status 还没看到 hasQr，推进一次轮询 timer
if (!wire.requests.some((r) => r.path === ROUTE_PATHS.QR) && pollTimers.length > 0) {
  pollTimers[pollTimers.length - 1].fn()
  await drain()
}
const running = await runtime.settle(panelProps)
check('I4 begin 走真实路由并进入 running（内存 fixture，无网络）',
  byAttr(running, 'data-mimo-auth-phase', 'running').length === 1 && flowStats.loads === 1 && flowStats.runs === 1,
  { loads: flowStats.loads, runs: flowStats.runs })
check('I5 二维码经真实 QR 路由一次性取得且 MIME 合规', wire.requests.filter((r) => r.path === ROUTE_PATHS.QR).length === 1
  && createdUrls.length === 1, { qr: wire.requests.filter((r) => r.path === ROUTE_PATHS.QR).length, urls: createdUrls.length })

// 4) 线上 generation 必须是 number（这正是双方错配点）
const postBodies = wire.requests.filter((r) => r.body !== null).map((r) => JSON.parse(r.body))
const withGen = postBodies.filter((b) => b.generation !== undefined)
check('I6 所有带 generation 的请求都是 number（positive safe integer）',
  withGen.length >= 3 && withGen.every((b) => typeof b.generation === 'number' && Number.isSafeInteger(b.generation) && b.generation > 0),
  withGen.map((b) => typeof b.generation))

// 5) 没有任何 BAD_REQUEST / 方法 / 类型错误
const badStatuses = wire.responses.filter((r) => r.status !== 200)
const badCodes = wire.responses.filter((r) => r.code === ROUTE_CODES.BAD_REQUEST)
check('I7 无 400/BAD_REQUEST（Host 接受了 UI 的真实 JSON）',
  badStatuses.length === 0 && badCodes.length === 0,
  { statuses: badStatuses.map((r) => r.status), bad: badCodes.length })

// 6) cancel：UI 快照 → 真实路由 → Host 终止会话
await byAttr(running, 'data-mimo-auth', 'cancel')[0].props.onClick()
await drain()
const afterCancel = await runtime.settle(panelProps)
const cancelReq = wire.requests.filter((r) => r.body !== null).map((r) => JSON.parse(r.body)).find((b) => b.action === 'cancel')
check('I8 cancel 请求带 ticket 与 Host generation', cancelReq !== undefined
  && typeof cancelReq.ticketId === 'string' && typeof cancelReq.generation === 'number'
  && typeof cancelReq.bootEpoch === 'string' && /^[a-f0-9]{32}$/.test(cancelReq.bootEpoch),
  cancelReq && Object.keys(cancelReq))
check('I9 UI 进入 cancelled 终态', byAttr(afterCancel, 'data-mimo-auth-panel', 'cancelled').length === 1)
const statuses = wire.requests.length
check('I10 事务请求计数固定（capability/start/begin/status/qr/cancel 各一次）',
  statuses === 6 && wire.requests.filter((r) => r.method === 'GET').length === 1, statuses)

// 7) 固定 DTO 不泄：响应体里没有 cookie/userId/passToken/balance/qr URL 等字段
check('I11 响应 DTO 不含敏感/未授权字段', wire.forbiddenHits.length === 0, wire.forbiddenHits)
check('I12 请求体不含任何 cookie/token 字段',
  wire.requests.every((r) => r.body === null || !/cookie|token|userId|balance/i.test(r.body)))
check('I13 外部网络零尝试（fixture 不触网）', flowStats.networkAttempts === 0)
check('I14 全程无 console 输出', consoleCalls.length === 0, consoleCalls)

function restoreAll() {
  try { host.dispose() } catch { /* 已清理 */ }
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  globalThis.fetch = realFetch
  try { client.restore() } catch { /* 已清理 */ }
}

restoreAll()

console.log('')
console.log('mimo-auth-integration: ' + String(pass) + ' passed, ' + String(fail) + ' failed')
process.exitCode = fail === 0 ? 0 : 1
