/**
 * test-mimo-remembered-session.mjs — 「记住登录」controller 的状态机 / 存储边界（纯 DI，无网络）
 *
 * 这里只测**不需要上游**的部分：能力闸门、record 校验、暂停/墓碑语义、首扫窗口、
 * 开关门禁、纯观察、dispose 不删记住登录。真实 protocol/transport/HTTP 的端到端在
 * `test-mimo-remembered-e2e.mjs`。
 *
 * 运行：node tools/test-mimo-remembered-session.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRememberedSession, REMEMBERED_CODES, REMEMBERED_LIMITS } from '../plans/mimo-auth/remembered-session.js'
import { createRememberedVault } from '../plans/mimo-auth/remember-store.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}
const BOOT = 'c'.repeat(32)
const NS = 'xiaomi-account-user-id'

function accountFixture(over = {}) {
  const base = {
    version: 1,
    namespace: NS,
    accountId: '777',
    cookies: [
      { name: 'passToken', value: 'PT', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
      { name: 'userId', value: '777', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }
    ]
  }
  return { ...base, ...over }
}
function recordFixture(over = {}, consentOver = {}, prefsOver = {}) {
  return {
    version: 1,
    consent: { version: 1, autoRestore: true, autoReadBalance: true, autoRefresh: true, confirmedAt: 1700000000000, ...consentOver },
    preferences: { paused: false, ...prefsOver },
    account: accountFixture(),
    ...over
  }
}

function stubVault(opts = {}) {
  const stats = { capability: 0, load: 0, save: 0, forget: 0, dispose: 0 }
  const caps = opts.caps ?? { supported: true, code: 'E_NONE' }
  return {
    stats,
    async capability() { stats.capability += 1; return caps },
    async load() {
      stats.load += 1
      if (opts.failLoad === true) throw Object.assign(new Error('E_STORE_FAIL'), { code: 'E_STORE_FAIL' })
      return { record: opts.record === undefined ? null : opts.record, revision: opts.revision ?? null }
    },
    async save() { stats.save += 1; return { revision: 'r-' + stats.save } },
    async forget() { stats.forget += 1; return { revision: 'tomb-' + stats.forget } },
    dispose() { stats.dispose += 1 }
  }
}

function makeSession({ vault, isEnabled = () => true, clock = { t: Date.now() } }) {
  const session = createRememberedSession({
    bootEpoch: BOOT,
    vault,
    isEnabled,
    now: () => clock.t
  })
  return { session, clock }
}

const PUBLIC_IP = '93.184.216.34'
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'
const clock = { t: Date.now() }

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

/** fakeHTTP：只替换 DNS/连接；协议序列/JSON 都是真的（与 e2e 同形的公开 fixture）。 */
function scenario(over = {}) {
  const seen = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: 'PT', userId: '777', cUserId: '888' }),
    callbackCookies: [
      'api-platform_serviceToken=PT; Path=/; Secure',
      'userId=777; Path=/; Secure',
      'api-platform_slh=SLH; Path=/; Secure'
    ],
    balanceBody: JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }),
    ...over
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter()
    ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    ee.end = () => {
      queueMicrotask(() => {
        let res
        if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: SIGNED })
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, state.body)
        else if (url.includes('/pass/serviceLogin')) res = makeResp(200, JSON.stringify({ code: 0, location: CB }))
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
        else if (url.includes('/api/v1/balance')) res = makeResp(200, state.balanceBody)
        else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl }
}
const TRANSPORT = (sc) => ({
  clock: () => Date.now(),
  resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
  request: sc.impl
})

/** fake provider：modifyRecord 全串行（与 credentials-local enqueue 同形）。 */
function fakeProvider() {
  const records = new Map()
  let queue = Promise.resolve()
  const stats = { saveCalls: 0, forgetCalls: 0 }
  const api = {
    stats,
    get saveCalls() { return stats.saveCalls },
    get forgetCalls() { return stats.forgetCalls },
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return current
        records.set(key, next)
        if (next.payload && next.payload.revoked === true) stats.forgetCalls += 1
        else stats.saveCalls += 1
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    only() { return records.size === 1 ? [...records.values()][0] : null },
    size() { return records.size }
  }
  return api
}

function makeGate() {
  let release = null
  const promise = new Promise((resolve) => { release = resolve })
  const waiters = []
  return {
    open: false,
    wait() { waiters.push(1); return this.open === true ? Promise.resolve() : promise },
    release() { release() },
    get count() { return waiters.length }
  }
}
function makeDeferred() {
  let resolve = null
  const promise = new Promise((r) => { resolve = r })
  return { promise, release: () => resolve() }
}

function fakeCrypto(gates = {}) {
  const protectOptions = []
  return {
    protectOptions,
    async capability() { return { supported: true, code: 'E_NONE' } },
    async protect(bytes, runtime = {}) {
      protectOptions.push(runtime)
      if (gates.protectGate !== undefined && gates.protectGate.open !== true) await gates.protectGate.wait()
      return Uint8Array.from(bytes).map((b) => b ^ 0x5a)
    },
    async unprotect(bytes) {
      if (gates.unprotectGate !== undefined && gates.unprotectGate.open !== true) await gates.unprotectGate.wait()
      return Uint8Array.from(bytes).map((b) => b ^ 0x5a)
    },
    dispose() {}
  }
}
function pausedRecord() {
  return recordFixture({}, {}, { paused: true })
}

async function waitFor(fn, label) {
  for (let i = 0; i < 5000; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('超时未达成：' + label)
}

async function main() {
  if (process.env.DBG_SESSION === '1') console.error('DBG main start')
  await check('能力不足：固定 unsupported、0 record 读、0 网络', async () => {
    const vault = stubVault({ caps: { supported: false, code: 'E_MIMO_DPAPI_UNAVAILABLE' } })
    const { session } = makeSession({ vault })
    await session.boot()
    const s = session.status()
    assert.equal(s.state, 'unsupported')
    assert.equal(s.code, 'E_MIMO_DPAPI_UNAVAILABLE')
    assert.equal(s.storage.supported, false)
    assert.equal(vault.stats.load, 0, 'capability 判定前不得读 record')
    const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
    assert.equal(started.ok, false)
    assert.equal(started.code, REMEMBERED_CODES.UNSUPPORTED)
    session.dispose()
  })

  await check('capability 只合成：不读 record、不写、不删', async () => {
    const vault = stubVault({ record: null })
    const { session } = makeSession({ vault })
    await session.boot()
    assert.equal(session.status().state, 'empty')
    assert.equal(vault.stats.load, 1)
    assert.equal(vault.stats.save, 0)
    assert.equal(vault.stats.forget, 0)
    session.dispose()
  })

  await check('record 形状损坏：unreadable，不反造预期、不写不删', async () => {
    const vault = stubVault({ record: { version: 9, junk: true } })
    const { session } = makeSession({ vault })
    await session.boot()
    const s = session.status()
    assert.equal(s.state, 'unreadable')
    assert.equal(s.code, REMEMBERED_CODES.RECORD_UNREADABLE)
    assert.equal(vault.stats.save, 0)
    assert.equal(vault.stats.forget, 0)
    session.dispose()
  })

  await check('consent 三项必须全 true：缺一项即 unreadable（不恢复）', async () => {
    for (const key of ['autoRestore', 'autoReadBalance', 'autoRefresh']) {
      const vault = stubVault({ record: recordFixture({}, { [key]: false }) })
      const { session } = makeSession({ vault })
      await session.boot()
      assert.equal(session.status().state, 'unreadable', key + ' 缺失必须拒')
      assert.equal(vault.stats.save, 0)
      session.dispose()
    }
  })

  await check('load 抛错：unreadable（fail closed，不猜）', async () => {
    const vault = stubVault({ failLoad: true })
    const { session } = makeSession({ vault })
    await session.boot()
    assert.equal(session.status().state, 'unreadable')
    session.dispose()
  })

  await check('tombstone（record=null + 新 revision）：empty，等本人发起', async () => {
    const vault = stubVault({ record: null, revision: 'rev-1' })
    const { session } = makeSession({ vault })
    await session.boot()
    const s = session.status()
    assert.equal(s.state, 'empty')
    assert.equal(s.canBegin, true)
    session.dispose()
  })

  await check('已暂停 record：重启显示 paused、0 账号请求、无余额', async () => {
    const vault = stubVault({ record: recordFixture({}, {}, { paused: true }), revision: 'rev-p' })
    const { session } = makeSession({ vault })
    await session.boot()
    const s = session.status()
    assert.equal(s.state, 'paused')
    assert.equal(s.paused, true)
    assert.equal(s.balance, null)
    assert.equal(s.stats.restoreAttempts, 0, '暂停态不得尝试恢复')
    session.dispose()
  })

  await check('首扫窗口 120 s：到点清候选/QR、0 存储写、0 余额', async () => {
    const vault = stubVault({ record: null })
    const { session, clock } = makeSession({ vault })
    await session.boot()
    const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
    assert.equal(started.ok, true)
    assert.equal(session.status().state, 'authorizing')
    assert.equal(session.status().canBegin, false, '扫描进行中不再重复开始')
    clock.t += REMEMBERED_LIMITS.pendingMs + 1
    const s = session.status()
    assert.equal(s.state, 'empty')
    assert.equal(s.code, REMEMBERED_CODES.EXPIRED)
    assert.equal(s.candidate, null)
    assert.equal(s.authId, null)
    assert.equal(vault.stats.save, 0)
    session.dispose()
  })

  await check('startAuth 门禁：需 authConsent、进行中 BUSY、过期 authId STALE', async () => {
    const vault = stubVault({ record: null })
    const { session } = makeSession({ vault })
    await session.boot()
    assert.equal((await session.startAuth({})).code, REMEMBERED_CODES.BAD_REQUEST)
    const first = await session.startAuth({ authConsent: true, consentVersion: 1 })
    assert.equal(first.ok, true)
    assert.equal((await session.startAuth({ authConsent: true, consentVersion: 1 })).code, REMEMBERED_CODES.BUSY)
    assert.equal(session.beginAuth('f'.repeat(32), first.generation).code, REMEMBERED_CODES.STALE_ID)
    session.dispose()
  })

  await check('渠道关闭：boot 报 disabled、start 拒绝、记录不动', async () => {
    const vault = stubVault({ record: recordFixture({}, {}, { paused: true }) })
    const { session } = makeSession({ vault, isEnabled: () => false })
    await session.boot()
    assert.equal(session.status().state, 'disabled')
    assert.equal((await session.startAuth({ authConsent: true, consentVersion: 1 })).code, REMEMBERED_CODES.DISABLED)
    assert.equal(vault.stats.forget, 0, '关闭不得删掉记住登录')
    assert.equal(vault.stats.save, 0)
    session.dispose()
  })

  await check('status 是纯观察：重复调用不改修订号、不碰存储', async () => {
    const vault = stubVault({ record: recordFixture({}, {}, { paused: true }) })
    const { session } = makeSession({ vault })
    await session.boot()
    const before = session.status().revision
    const calls = { ...vault.stats }
    for (let i = 0; i < 20; i++) session.status()
    assert.equal(session.status().revision, before, 'status 不得 bump')
    assert.deepEqual(vault.stats, calls, 'status 不得调用存储')
    session.dispose()
  })

  await check('dispose：清内存 + dispose vault，但绝不 forget', async () => {
    const vault = stubVault({ record: recordFixture({}, {}, { paused: true }) })
    const { session } = makeSession({ vault })
    await session.boot()
    session.dispose()
    assert.equal(session.status().state, 'stopped')
    assert.equal(vault.stats.forget, 0, 'dispose 不得删除记住登录')
    assert.equal(vault.stats.dispose, 1)
  })

  await check('disable()：清候选/旧值，不写不删', async () => {
    const vault = stubVault({ record: null })
    const { session } = makeSession({ vault })
    await session.boot()
    await session.startAuth({ authConsent: true, consentVersion: 1 })
    session.disable()
    const s = session.status()
    assert.equal(s.state, 'disabled')
    assert.equal(s.authId, null)
    assert.equal(vault.stats.save, 0)
    assert.equal(vault.stats.forget, 0)
    session.dispose()
  })

  await check('快照白名单：无票/无 URL/无原始 scope，候选只在待确认态', async () => {
    const vault = stubVault({ record: null })
    const { session } = makeSession({ vault })
    await session.boot()
    const s = session.status()
    const blob = JSON.stringify(s)
    for (const bad of ['passToken', 'account.xiaomi.com', 'xiaomimimo.com', 'PT', 'C:\\']) {
      assert.equal(blob.includes(bad), false, '快照不得含：' + bad)
    }
    assert.equal(s.candidate, null)
    assert.equal(s.intervalMs, 60000, '固定 60 s 后台自动读（不是旧 5 min）')
    session.dispose()
  })

  await check('限额常量：60 s / 10 s / 读失败 5 次公开失败 / 120 s 窗口（不是旧 15min/14 次）', () => {
    assert.equal(REMEMBERED_LIMITS.intervalMs, 60000)
    assert.equal(REMEMBERED_LIMITS.readMs, 10000)
    assert.equal(REMEMBERED_LIMITS.readFailureLimit, 5)
    assert.equal(REMEMBERED_LIMITS.pendingMs, 120000)
    assert.equal('credentialHoldMs' in REMEMBERED_LIMITS, false)
    assert.equal('maxAutoRefresh' in REMEMBERED_LIMITS, false)
  })

  // ── A–D：操作栅栏（controller epoch + captured owner） ─────────────────────
  await check('A 旧 confirm 在 enabledNow 期间被 cancel/新候选取代 → 固定 STALE，不确认新候选', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const crypto = fakeCrypto()
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    let gate = null
    let gateEnabled = false
    const session = createRememberedSession({
      bootEpoch: BOOT, vault,
      isEnabled: () => (gateEnabled && gate !== null ? gate.promise : true),
      now: () => clock.t,
      transportDeps: TRANSPORT(sc)
    })
    await session.boot()
    const first = await session.startAuth({ authConsent: true, consentVersion: 1 })
    session.beginAuth(first.authId, first.generation)
    await waitFor(() => session.status().state === 'awaiting_confirmation', '首个候选就绪')
    assert.equal(session.status().candidate.identifier, '777')

    gate = makeDeferred()
    gateEnabled = true
    const oldConfirm = session.confirmAccount(first.authId, first.generation)
    // 旧确认卡在 enabledNow：本人取消并重新扫码，产生**另一个**候选
    session.cancelAuth(first.authId, first.generation)
    gateEnabled = false
    sc.state.body = JSON.stringify({ location: CB, passToken: 'PT2', userId: '999', cUserId: '888' })
    sc.state.callbackCookies = [
      'api-platform_serviceToken=PT2; Path=/; Secure',
      'userId=999; Path=/; Secure',
      'api-platform_slh=SLH2; Path=/; Secure'
    ]
    const second = await session.startAuth({ authConsent: true, consentVersion: 1 })
    const began = session.beginAuth(second.authId, second.generation)
    assert.equal(began.ok, true, '第二次 begin 应成功')
    await waitFor(() => session.status().state === 'awaiting_confirmation', '第二个候选就绪')
    assert.equal(session.status().candidate.identifier, '999')

    gate.release()
    gate = null
    const out = await oldConfirm
    assert.equal(out.ok, false)
    assert.equal(out.code, REMEMBERED_CODES.STALE_ID)
    const s = session.status()
    assert.equal(s.state, 'awaiting_confirmation', '旧确认不得改变新候选状态')
    assert.equal(s.candidate.identifier, '999', '候选不得被旧确认换掉')
    assert.equal(s.code, 'E_NONE', '旧错误不得覆盖快照')
    assert.equal(provider.saveCalls, 0, '旧确认不得写存储')
    assert.equal(s.balance, null)
    session.dispose()
  })

  await check('B save 在途时 forget：旧 save 不置 verified/failed、余额 0、最终 tombstone', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const gate = makeGate()
    const crypto = fakeCrypto({ protectGate: gate })
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    const session = createRememberedSession({
      bootEpoch: BOOT, vault, isEnabled: () => true, now: () => clock.t, transportDeps: TRANSPORT(sc)
    })
    await session.boot()
    const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
    session.beginAuth(started.authId, started.generation)
    await waitFor(() => session.status().state === 'awaiting_confirmation', '候选就绪')
    const confirmP = session.confirmAccount(started.authId, started.generation)
    await waitFor(() => gate.count > 0, 'save 已进入 protect 闸门')
    const forgetP = session.forget()   // 立即失效，不等 boot/网络
    gate.release()
    const [cr, fr] = await Promise.all([confirmP, forgetP])
    assert.equal(fr.ok, true)
    assert.equal(cr.ok, false)
    assert.ok([REMEMBERED_CODES.STALE_ID, 'E_MIMO_AUTH_CANCELLED'].includes(cr.code), '旧 confirm 只能固定码：' + cr.code)
    const s = session.status()
    assert.equal(s.state, 'empty')
    assert.equal(s.code, 'E_NONE')
    assert.equal(s.balance, null)
    assert.equal(provider.only().payload.revoked, true, '最终必须是 tombstone')
    assert.equal(crypto.protectOptions.length > 0, true)
    const sig = crypto.protectOptions[0].signal
    assert.equal(sig !== undefined && sig !== null && typeof sig.addEventListener === 'function', true, 'vault.save 必须收到该 scope 的 signal')
    session.dispose()
  })

  await check('C resume 的 load 在途时 forget：不写 paused=false、不恢复、不首读', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const gate = makeGate()
    const crypto = fakeCrypto({ unprotectGate: gate })
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    await vault.save(pausedRecord(), { expectedRevision: null })
    gate.open = true            // boot 期间放行
    const session = createRememberedSession({
      bootEpoch: BOOT, vault, isEnabled: () => true, now: () => clock.t, transportDeps: TRANSPORT(sc)
    })
    await session.boot()
    assert.equal(session.status().state, 'paused')
    const before = { save: provider.saveCalls, forget: provider.forgetCalls, net: sc.seen.length }
    gate.open = false           // 让 resume 的 load 卡住
    const resumeP = session.resume()
    await waitFor(() => gate.count > 0, 'resume load 已进入 unprotect 闸门')
    await session.forget()
    gate.release()
    const rr = await resumeP
    assert.equal(rr.ok, false)
    assert.ok([REMEMBERED_CODES.STALE_ID, 'E_MIMO_AUTH_CANCELLED'].includes(rr.code), rr.code)
    const s = session.status()
    assert.equal(s.state, 'empty')
    assert.equal(s.paused, false)
    assert.equal(s.balance, null)
    assert.equal(provider.forgetCalls, before.forget + 1, 'forget 只写一次 tombstone')
    assert.equal(sc.seen.length, before.net, '不得发余额请求')
    session.dispose()
  })

  await check('C2 boot.load 被 gate 时 forget：不恢复、不首读、最终 0 账号请求', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const gate = makeGate()
    const crypto = fakeCrypto({ unprotectGate: gate })
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    await vault.save(recordFixture(), { expectedRevision: null })
    const session = createRememberedSession({
      bootEpoch: BOOT, vault, isEnabled: () => true, now: () => clock.t, transportDeps: TRANSPORT(sc)
    })
    const bootP = session.boot()
    await waitFor(() => gate.count > 0, 'boot load 已进入 unprotect 闸门')
    await session.forget()
    gate.release()
    const br = await bootP
    assert.equal(br.ok, false)
    assert.ok([REMEMBERED_CODES.STALE_ID, 'E_MIMO_AUTH_CANCELLED'].includes(br.code), br.code)
    const s = session.status()
    assert.equal(s.state, 'empty')
    assert.equal(s.stats.restoreAttempts, 0, '不得启动恢复')
    assert.equal(s.balance, null)
    assert.equal(sc.seen.length, 0, '不得发任何账号请求')
    assert.equal(provider.only().payload.revoked, true, 'forget 后必须是 tombstone')
    session.dispose()
  })

  await check('D dispose 取消在途 save：不写、不误删新 record、不再发账号请求', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const gate = makeGate()
    const crypto = fakeCrypto({ protectGate: gate })
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    const session = createRememberedSession({
      bootEpoch: BOOT, vault, isEnabled: () => true, now: () => clock.t, transportDeps: TRANSPORT(sc)
    })
    await session.boot()
    const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
    session.beginAuth(started.authId, started.generation)
    await waitFor(() => session.status().state === 'awaiting_confirmation', '候选就绪')
    const netBefore = sc.seen.length
    const confirmP = session.confirmAccount(started.authId, started.generation)
    await waitFor(() => gate.count > 0, 'save 进入闸门')
    session.dispose()
    gate.release()
    const cr = await confirmP
    assert.equal(cr.ok, false)
    assert.ok([REMEMBERED_CODES.STALE_ID, 'E_MIMO_AUTH_CANCELLED', REMEMBERED_CODES.DISABLED].includes(cr.code), cr.code)
    assert.equal(provider.saveCalls, 0, 'dispose 后不得写')
    assert.equal(provider.forgetCalls, 0, 'dispose 不得 forget/删 record')
    assert.equal(sc.seen.length, netBefore, 'dispose 后不得再发账号请求')
    assert.equal(session.status().state, 'stopped')
  })

  await check('E displaySnapshot 不带候选原始 ID（status 仍保留，供 pair 路由投影）', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const session = createRememberedSession({
      bootEpoch: BOOT, vault, isEnabled: () => true, now: () => clock.t, transportDeps: TRANSPORT(sc)
    })
    await session.boot()
    const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
    session.beginAuth(started.authId, started.generation)
    await waitFor(() => session.status().state === 'awaiting_confirmation', '候选就绪')
    const internal = session.status()
    assert.equal(internal.candidate.identifier, '777', '内部 status 必须保留候选（pair 路由用）')
    const disp = session.displaySnapshot()
    assert.equal(disp.remembered.candidate, null, 'display 必须显式 candidate:null')
    const blob = JSON.stringify(disp)
    assert.equal(blob.includes('777'), false, 'displayStatus 正文不得出现候选原始 ID')
    assert.equal(blob.includes(internal.candidate.identifier), false)
    // 其他 display 入口同样裁剪（侧栏/详情共用 displaySnapshot）
    assert.equal(JSON.stringify(session.displaySnapshot()).includes('777'), false)
    session.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) {
    for (const f of fails) console.error('FAIL ' + f)
    console.error(summary)
    process.exitCode = 1
  } else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
