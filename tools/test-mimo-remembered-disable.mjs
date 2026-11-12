/**
 * test-mimo-remembered-disable.mjs — 「配置关闭必须主动中止在途」反例（真实 Host/协议/vault）
 *
 * 真实：createAuthHost 注册链与路由、createRememberedSession、console-protocol（真实 A1/transport）、
 *       remember-store.createRememberedVault。
 * 合成：node:https/DNS、宿主 credentials provider、DPAPI crypto、fake 布尔开关、fake clock/timer。
 *
 * 场景：verified 后下一次余额请求返回 401 且**响应被 gate 挂住**（SSO 尚未出站）→ 把 isEnabled 翻 false
 * → 触发 Host 配置事件/≤1s 本地兜底探测 → 放 gate：后续 SSO/callback/retry 必须 0 跳，
 * Host state=disabled、余额清空、无持久化写、密文记住态保留。
 *
 * 运行：node tools/test-mimo-remembered-disable.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { createRememberedVault } from '../plans/mimo-auth/remember-store.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}

const PUBLIC_IP = '93.184.216.34'
const BOOT = 'd'.repeat(32)
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ACCOUNT_ID = '777'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'

function bufOf(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body === null || body === undefined ? '' : String(body))
}
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
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

function makeGate() {
  let release = null
  const promise = new Promise((r) => { release = r })
  const waiters = []
  return {
    wait() { waiters.push(1); return promise },
    release() { release() },
    get count() { return waiters.length }
  }
}

/** fakeHTTP：balance 可按余额序列返回，并在 hold 打开时挂住响应（=SSO 尚未出站）。 */
function scenario(over = {}) {
  const seen = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: 'PT', userId: ACCOUNT_ID, cUserId: '888' }),
    callbackCookies: [
      'api-platform_serviceToken=PT; Path=/; Secure',
      `userId=${ACCOUNT_ID}; Path=/; Secure`,
      'api-platform_slh=SLH; Path=/; Secure'
    ],
    balanceSeq: [],
    hold: null,
    ...over
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter()
    ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    ee.end = () => {
      queueMicrotask(async () => {
        let res
        if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: SIGNED })
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, state.body)
        else if (url.includes('/pass/serviceLogin')) res = makeResp(200, JSON.stringify({ code: 0, location: CB }))
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
        else if (url.includes('/api/v1/balance')) {
          if (state.hold !== null) await state.hold.wait()
          const next = state.balanceSeq.length > 0 ? state.balanceSeq.shift() : 200
          res = next === 200
            ? makeResp(200, JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }))
            : makeResp(next, '{}')
        } else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl, count: (p) => seen.filter((u) => u.includes(p)).length }
}

function fakeProvider() {
  const records = new Map()
  let queue = Promise.resolve()
  const stats = { writes: 0 }
  return {
    stats,
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return current
        records.set(key, next)
        stats.writes += 1
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    only() { return records.size === 1 ? [...records.values()][0] : null }
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
function fakeTimers(clock) {
  let seq = 0
  const tasks = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      tasks.set(id, { at: clock.t + Math.max(0, Number(ms) || 0), fn })
      return { id, unref() {} }
    },
    clearTimeout(token) {
      if (token !== null && typeof token === 'object') tasks.delete(token.id)
      else tasks.delete(token)
    },
    async runDue() {
      for (let guard = 0; guard < 20; guard++) {
        const due = [...tasks.entries()].filter(([, t]) => t.at <= clock.t)
        if (due.length === 0) return
        for (const [id, t] of due) { tasks.delete(id); try { t.fn() } catch { /* ok */ } }
        await new Promise((r) => setTimeout(r, 3))
      }
    },
    get pending() { return tasks.size }
  }
}

function makeHost({ sc, vault, enabled, clock, timers, events }) {
  const routes = []
  const ctx = {
    connection: { fetch: { register: (def) => { routes.push(def); return () => { def.disposed = true } } } },
    webServer: {},
    on: (name, fn) => { events.set(name, fn); return () => { events.delete(name) } },
  }
  const host = createAuthHost(ctx, BOOT, () => {}, {
    enableRememberedAccount: true,
    rememberedVault: vault,
    isEnabled: async () => enabled.global === true && enabled.channel === true,
    now: () => clock.t,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    consoleTransportDeps: {
      clock: () => Date.now(),
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
      request: sc.impl,
    },
  })
  const route = () => routes.find((r) => r.path === '/api/plan-usage-mimo-auth')
  const call = async (body) => {
    const res = await route().fetch({
      method: 'POST',
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(body),
    })
    const out = { status: res.status, headers: res.headers }
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('json')) out.json = await res.json()
    else out.bytes = new Uint8Array(await res.arrayBuffer())
    return out
  }
  return { host, call, clock, timers, ctx }
}

const ACT = (action, extra = {}) => ({ action, bootEpoch: BOOT, ...extra })
const CONSENT = { consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true, autoRefresh: true }

async function settle(fn, label, tries = 800) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('超时未达成：' + label)
}

async function firstScan(h) {
  const started = await h.call(ACT('rememberedStart', { authConsent: true, consentVersion: 1 }))
  assert.equal(started.status, 200, 'start: ' + JSON.stringify(started.json))
  const { authId, generation } = started.json.remembered
  const begun = await h.call(ACT('rememberedBegin', { authId, generation }))
  assert.equal(begun.status, 200, 'begin: ' + JSON.stringify(begun.json))
  await settle(async () => (await h.call(ACT('rememberedStatus'))).json.remembered.hasQr === true, '二维码就绪')
  await h.call(ACT('rememberedQr', { authId, generation }))
  await settle(async () => (await h.call(ACT('rememberedStatus'))).json.remembered.state === 'awaiting_confirmation', '待确认')
  return { authId, generation }
}

async function runDisableCase(channelOff) {
  const clock = { t: Date.now() }
  const timers = fakeTimers(clock)
  const events = new Map()
  const sc = scenario()
  const provider = fakeProvider()
  const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
  const enabled = { global: true, channel: true }
  const h = makeHost({ sc, vault, enabled, clock, timers, events })
  await h.host.idle()

  const { authId, generation } = await firstScan(h)
  const confirmed = await h.call(ACT('rememberedConfirm', { authId, generation, ...CONSENT }))
  assert.equal(confirmed.status, 200, 'confirm: ' + JSON.stringify(confirmed.json))
  assert.equal(confirmed.json.remembered.state, 'verified')
  const writesAfterConfirm = provider.stats.writes
  assert.ok(writesAfterConfirm >= 1, '确认应写入密文')

  // 下一次余额：401 且响应被 gate 挂住（SSO 还没出站）
  const hold = makeGate()
  sc.state.hold = hold
  sc.state.balanceSeq = [401]
  clock.t += 300000
  await timers.runDue()
  await settle(async () => sc.count('/api/v1/balance') >= 2, '余额请求已发出并被挂住')
  const hopsWhileHeld = sc.seen.length

  // 关闭一个开关，走真实 Host 配置事件（无事件时用 ≤1s 兜底 timer）
  if (channelOff) enabled.channel = false
  else enabled.global = false
  const onEvent = events.get('app-boot/config-reload')
  if (typeof onEvent === 'function') onEvent()
  else { clock.t += 1000; await timers.runDue() }

  await settle(async () => (await h.call(ACT('rememberedStatus'))).json.remembered.state === 'disabled', '主动 disable')
  const disabledStatus = await h.call(ACT('rememberedStatus'))
  assert.equal(disabledStatus.json.remembered.state, 'disabled')
  assert.equal(disabledStatus.json.remembered.balance, null, '关闭即清余额')

  // 放行 401：SSO/callback/retry 必须 0 跳
  const ssoBefore = sc.count('/pass/serviceLogin')
  const stsBefore = sc.count('/sts')
  hold.release()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(sc.count('/pass/serviceLogin'), ssoBefore, '放行后不得新增 SSO')
  assert.equal(sc.count('/sts'), stsBefore, '放行后不得新增 callback')
  assert.ok(sc.seen.length <= hopsWhileHeld, '关闭后不得出现新上游请求：' + (sc.seen.length - hopsWhileHeld))

  // 无持久化写、密文记住态保留
  assert.equal(provider.stats.writes, writesAfterConfirm, '关闭不得 persist 或写 tombstone')
  assert.ok(provider.only() !== null && provider.only().payload && typeof provider.only().payload.ciphertext === 'string',
    '密文记住态必须保留')

  // route/action 兜底：关闭后动作固定拒绝且 0 请求
  const hopsBeforeAction = sc.seen.length
  const stNow = await h.call(ACT('rememberedStatus'))
  const retry = await h.call(ACT('rememberedRetry', { generation: stNow.json.remembered.generation }))
  assert.ok(retry.status === 200 || retry.status === 409, 'retry 响应：' + retry.status + ' ' + JSON.stringify(retry.json))
  assert.match(String(retry.json.code), /DISABLED|NOT_READY|REMEMBERED/)
  assert.equal(sc.seen.length, hopsBeforeAction, '关闭后 action 不得出站')

  // dispose 清理 watcher：不再有后台 timer
  h.host.dispose()
  assert.equal(timers.pending, 0, 'dispose 后不得残留 watcher timer')
}

async function main() {
  await check('W1 global=false：401 在途时关闭 → 后续 SSO/callback/retry 0、disabled、密文保留', async () => {
    await runDisableCase(false)
  })
  await check('W2 channel=false：同上（表驱动第二行）', async () => {
    await runDisableCase(true)
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) {
    for (const f of fails) console.error('FAIL ' + f)
    console.error(summary)
    process.exitCode = 1
  } else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
