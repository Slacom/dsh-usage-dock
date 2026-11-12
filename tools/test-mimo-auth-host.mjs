/**
 * MiMo G1 Host · 必要离线回归（零网络、零监听、零真实凭据）
 *
 * 使用真实公开 SDK `HostConnectionService.createSharedFetchHandler` 的 owner 分派
 * （从 P0 导出的公开 `dsh-client-connection-lib-index.js` 加载；仅 shim 依赖），
 * 不手写“总是允许 owner”的路由 mock。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
// [A3 修复] `vm.SourceTextModule` 需要 `--experimental-vm-modules`；默认 `node <file>` 下它是
// undefined，本套件会以 TypeError 崩掉（不是断言失败）。自检后**带 flag 重新执行自身**并透传退出码，
// 这样 `node tools/test-mimo-auth-host.mjs` 就能直接跑，CI/全量循环也不必特殊对待。
if (typeof vm.SourceTextModule !== 'function' && process.env.DSH_MIMO_HOST_REEXEC !== '1') {
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(process.execPath,
    ['--experimental-vm-modules', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: Object.assign({}, process.env, { DSH_MIMO_HOST_REEXEC: '1' }) })
  process.exit(res.status === null ? 1 : res.status)
}
import { registerMimoAuth, createAuthHost } from '../plans/mimo-auth/host.js'
import { ROUTE_PATHS, ROUTE_CODES } from '../plans/mimo-auth/routes.js'

const SDK = fileURLToPath(new URL('../.diagnostics/mimo-qr-20261025/sdk-current-parent/dsh-client-connection-lib-index.js', import.meta.url))
let pass = 0
let fail = 0
function check(name, condition, detail) {
  if (condition) { pass += 1; console.log('[PASS] ' + name) }
  else { fail += 1; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail))) }
}

function chain() {
  const proxy = new Proxy(function () {}, {
    get: () => proxy,
    apply: () => proxy,
    construct: () => proxy,
  })
  return proxy
}
const schema = chain()
const z = new Proxy({}, { get: () => schema })
class Service {
  constructor(ctx, name) { this.ctx = ctx; this.name = name }
}
function synthetic(context, exports, identifier) {
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  }, { context, identifier })
}

async function loadActualRouter() {
  const context = vm.createContext({
    console, URL, Request, Response, Headers, AbortController, AbortSignal,
    TextEncoder, TextDecoder, Buffer, process, setTimeout, clearTimeout,
    queueMicrotask, crypto: crypto.webcrypto ?? crypto,
  })
  const source = readFileSync(SDK, 'utf8')
  const mod = new vm.SourceTextModule(source, { context, identifier: SDK })
  await mod.link(async (specifier) => {
    if (specifier === 'node:crypto') return synthetic(context, {
      createHash: crypto.createHash, createHmac: crypto.createHmac,
      randomBytes: crypto.randomBytes, randomUUID: crypto.randomUUID, timingSafeEqual: crypto.timingSafeEqual,
    }, specifier)
    if (specifier === 'node:stream') return synthetic(context, { Readable }, specifier)
    if (specifier === '@deepseek-ai/schemastery') return synthetic(context, { default: z }, specifier)
    if (specifier === '@deepseek-ai/dsh-credentials') return synthetic(context, { credentialKey: (scope, id) => `${scope}/${id}` }, specifier)
    if (specifier === '@deepseek-ai/cordis') return synthetic(context, { Service }, specifier)
    if (specifier === 'zod') return synthetic(context, { z }, specifier)
    if (specifier === '@deepseek-ai/dsh-scope') return synthetic(context, {
      createScope: (owner) => ({ ctx: owner.extend ? owner.extend() : owner, dispose: async () => {} }),
    }, specifier)
    throw new Error(`unexpected SDK import: ${specifier}`)
  })
  await mod.evaluate()
  return mod.namespace
}

function makeCtx(service) {
  return {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get(name) { return name === 'webServer' ? { protocol: 'http:' } : undefined },
    extend() { return this },
    connection: service,
    webServer: { protocol: 'http:' },
  }
}

function request(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return new Request('http://dsh.internal' + path, init)
}

async function bodyOf(response) { return response.json() }

function makeFlow(onRun) {
  return {
    createMemoryFlow(deps) { return { run: (options) => onRun(deps, options) } },
    CookieJar: class { absorber() {} clear() {} cookieHeaderFor() { return { header: null, names: [] } } },
  }
}

const sdk = await loadActualRouter()
check('R1 真实 SDK 导出 HostConnectionService', typeof sdk.HostConnectionService === 'function')
const service = new sdk.HostConnectionService(makeCtx(null), [], {
  isAuthenticated: () => false,
  authenticateApi: () => undefined,
})
const serviceCtx = makeCtx(service)
const owner = { principal: { kind: 'owner' } }
const operator = { principal: { kind: 'operator' } }
const bootEpoch = 'a'.repeat(32)
let releaseLate
let flowLoads = 0
let clock = 1_000_000
const lateFlow = new Promise((resolve) => { releaseLate = resolve })
const host = createAuthHost(serviceCtx, bootEpoch, () => {}, {
  now: () => clock,
  loadFlow: async () => {
    flowLoads += 1
    return makeFlow(async () => {
      await lateFlow
      return { ok: true, code: 'E_NONE', gates: { qr: { ok: true }, balance: { ok: true } } }
    })
  },
})
const shared = service.createSharedFetchHandler('/api')

const noStore = (response) => String(response.headers.get('cache-control') ?? '').includes('no-store')
const getCap = await shared.fetch(request('GET', ROUTE_PATHS.AUTH), owner)
const cap = await bodyOf(getCap)
check('R2 capability GET owner/no-store/DTO', getCap.status === 200 && noStore(getCap)
  && cap.ok === true && cap.supported === true && cap.bootEpoch === bootEpoch && cap.flow === 'qr-memory', cap)

const rejected = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'start', bootEpoch }), operator)
check('R3 非 owner 在状态访问前 403', rejected.status === 403)
const missing = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'status', bootEpoch, ticketId: 'f'.repeat(32), generation: 1,
}), owner)
const missingBody = await bodyOf(missing)
check('R4 无会话固定 404/missing code', missing.status === 404 && missingBody.ok === false
  && missingBody.code === ROUTE_CODES.SESSION_MISSING, missingBody)

const started = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'start', bootEpoch }), owner))
check('R5 start 只建 idle 会话，不调用 vendor', started.ok === true && /^[a-f0-9]{32}$/.test(started.ticketId)
  && started.generation === 1 && host.manager.status(started.ticketId, 1).state === 'idle' && flowLoads === 0)
const idle = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'status', bootEpoch, ticketId: started.ticketId, generation: 1,
}), owner))
check('R6 begin 前 status=idle（有效 ticket）且 no-store', idle.state === 'idle' && noStore(await shared.fetch(request('GET', ROUTE_PATHS.AUTH), owner)))

const staleBoot = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'status', bootEpoch: 'b'.repeat(32), ticketId: started.ticketId, generation: 1 }), owner)
check('R7 旧 bootEpoch 固定 409', staleBoot.status === 409 && (await bodyOf(staleBoot)).code === ROUTE_CODES.BOOT_STALE)

const invalidTarget = await host.manager.requestApproval(started.generation, { purpose: 'longPoll', rawUrl: 'https://evil.example.invalid/x' })
check('R11 未知目标 fail-closed', invalidTarget.approved === false && invalidTarget.code === 'E_MIMO_AUTH_TARGET_INVALID')

const begin = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'begin', bootEpoch, ticketId: started.ticketId, generation: 1,
}), owner))
check('R8 begin 返回 ok 并进入 running', begin.ok === true && flowLoads === 1 && host.manager.status(started.ticketId, 1).state === 'running')
const duplicateBegin = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'begin', bootEpoch, ticketId: started.ticketId, generation: 1 }), owner)
check('R8b 重复 begin 固定 409', duplicateBegin.status === 409 && (await bodyOf(duplicateBegin)).code === 'E_MIMO_AUTH_BEGIN_DUPLICATE')

const cancel = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'cancel', bootEpoch, ticketId: started.ticketId, generation: 1,
}), owner))
check('R9 cancel 返回 ok', cancel.ok === true)
releaseLate()
await host.idle()
const cancelled = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'status', bootEpoch, ticketId: started.ticketId, generation: 1,
}), owner))
check('R10 取消后保持 cancelled 终态（终态 status 可读）', cancelled.state === 'cancelled')

const start3 = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'start', bootEpoch }), owner))
const staleGen = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'status', bootEpoch, ticketId: start3.ticketId, generation: 99 }), owner)
check('R13 旧 generation 固定 409', staleGen.status === 409 && (await bodyOf(staleGen)).code === 'E_MIMO_AUTH_STALE_GENERATION')
clock += 5 * 60 * 1000 + 1
const expired = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'status', bootEpoch, ticketId: start3.ticketId, generation: start3.generation }), owner))
check('R14 TTL 到期后固定 expired 终态', expired.state === 'expired' && expired.code === 'E_MIMO_AUTH_SESSION_EXPIRED')

const start4 = await bodyOf(await shared.fetch(request('POST', ROUTE_PATHS.AUTH, { action: 'start', bootEpoch }), owner))
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const badMime = host.manager.setQr(start4.generation, png, 'image/svg+xml')
const goodMime = host.manager.setQr(start4.generation, png, 'image/png')
const qrResponse = await shared.fetch(request('POST', ROUTE_PATHS.QR, {
  bootEpoch, ticketId: start4.ticketId, generation: start4.generation,
}), owner)
check('R16 QR 仅 png/jpeg 二进制、无 MIME 回落', badMime.ok === false && goodMime.ok === true
  && qrResponse.status === 200 && qrResponse.headers.get('content-type') === 'image/png'
  && new Uint8Array(await qrResponse.arrayBuffer()).length === png.length)

const approveNumeric = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'approve', bootEpoch, ticketId: start4.ticketId, generation: start4.generation, approvalId: 'a'.repeat(32),
}), owner)
const confirmNumeric = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'confirm', bootEpoch, ticketId: start4.ticketId, generation: start4.generation, verdict: 'match',
}), owner)
check('R16b approve/confirm 接受 number generation（进入业务校验而非 400）', approveNumeric.status === 409 && confirmNumeric.status === 409
  && (await bodyOf(approveNumeric)).code === ROUTE_CODES.APPROVAL_MISSING
  && (await bodyOf(confirmNumeric)).code === ROUTE_CODES.APPROVAL_MISSING)

let badGenerations = 0
for (const generation of ['1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  const result = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
    action: 'status', bootEpoch, ticketId: start4.ticketId, generation,
  }), owner)
  if (result.status === 400 && (await bodyOf(result)).code === ROUTE_CODES.BAD_REQUEST) badGenerations += 1
}
check('R16c generation 仅 number positive safe integer，拒绝 string/0/负/小数/非安全整数', badGenerations === 5)

const logout = await shared.fetch(request('POST', ROUTE_PATHS.AUTH, {
  action: 'logout', bootEpoch, ticketId: start4.ticketId, generation: start4.generation,
}), owner)
check('R17 logout 合法原 gen 先验证后取消', logout.status === 200
  && host.manager.status(start4.ticketId, start4.generation).state === 'cancelled')

const missingService = (() => {
  let injected = false
  const ctx = { inject() { injected = true }, get() { return undefined } }
  const result = registerMimoAuth(ctx, () => {})
  return { injected, bootEpoch: result.bootEpoch }
})()
check('R12 缺 connection 时主插件不抛，注册未执行', missingService.injected === true && /^[a-f0-9]{32}$/.test(missingService.bootEpoch))

host.dispose()
const afterDispose = await shared.fetch(request('GET', ROUTE_PATHS.AUTH), owner)
check('R15 dispose 后 owner 路由移除（404）', afterDispose.status === 404)
console.log(`\n${pass} PASS ${fail} FAIL`)
if (fail > 0) process.exitCode = 1
