/**
 * test-mimo-remembered-reenroll.mjs — 同进程「忘记 → 重新扫码确认」的 CAS 交接（真实 store + session）
 *
 * 真实：remember-store.createRememberedVault、remembered-session 状态机、protocol（fake DNS/https）。
 * 合成：串行 in-memory credentials provider、fake crypto、fake clock/transport。
 * 不读任何真实 cfg/record/账号/网络。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRememberedSession } from '../plans/mimo-auth/remembered-session.js'
import { createRememberedVault, STORE_CODES } from '../plans/mimo-auth/remember-store.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}
async function expectCode(fn, code, label) {
  try { await fn() } catch (e) {
    if (e.code !== code) throw new Error((label || '') + ' 期望 ' + code + ' 实际 ' + (e.code || e.message))
    return
  }
  throw new Error((label || '') + ' 期望抛 ' + code + '，但没有抛')
}

const PUBLIC_IP = '93.184.216.34'
const BOOT = 'a'.repeat(32)
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ACCOUNT_ID = '777'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'
const PLATFORM_COOKIES = [
  'api-platform_serviceToken=PT; Path=/; Secure',
  `userId=${ACCOUNT_ID}; Path=/; Secure`,
  'api-platform_slh=SLH; Path=/; Secure',
]

function bufOf(body) { return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body === null || body === undefined ? '' : String(body)) }
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const buf = bufOf(body)
  return {
    statusCode: status, status, complete: true, redirected: false,
    socket: { remoteAddress: PUBLIC_IP }, headers: lower,
    body: {
      getReader() {
        const chunk = new Uint8Array(buf)
        let done = false
        return {
          read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: chunk }) },
          releaseLock() {}, cancel() { return Promise.resolve() },
        }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}

function scenario(over = {}) {
  const seen = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: 'PASS_A', userId: ACCOUNT_ID, cUserId: 'CUSER' }),
    balance: JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }),
    balanceStatus: 200,
    ssoBody: JSON.stringify({ code: 0, location: CB }),
    ...over,
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
        else if (url.includes('/pass/serviceLogin')) res = makeResp(200, state.ssoBody)
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': PLATFORM_COOKIES })
        else if (url.includes('/api/v1/balance')) res = makeResp(state.balanceStatus, state.balanceStatus === 200 ? state.balance : '{}')
        else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl }
}

function fakeProvider({ tombGate = null } = {}) {
  const records = new Map()
  let queue = Promise.resolve()
  const stats = { writes: 0, forgets: 0 }
  return {
    stats,
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return current
        if (next.payload && next.payload.revoked === true && tombGate !== null) await tombGate.wait()
        records.set(key, next)
        stats.writes += 1
        if (next.payload && next.payload.revoked === true) stats.forgets += 1
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    only() { return records.size === 1 ? [...records.values()][0] : null },
  }
}
function fakeCrypto(over = {}) {
  const calls = { unprotect: 0, protect: 0 }
  return {
    calls,
    async capability() { return { supported: true, code: 'E_NONE' } },
    async protect(bytes) { calls.protect += 1; return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    async unprotect(bytes) { calls.unprotect += 1; return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    dispose() {},
  }
}
function makeGate() {
  let release = null
  const p = new Promise((r) => { release = r })
  const waiters = []
  return { wait() { waiters.push(1); return p }, release() { release() }, get count() { return waiters.length } }
}

function makeSession(sc, vault) {
  const clock = { t: Date.now() }
  const session = createRememberedSession({
    bootEpoch: BOOT,
    vault,
    isEnabled: () => true,
    now: () => clock.t,
    transportDeps: { clock: () => Date.now(), resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
  })
  return { session, clock }
}
const dl = () => Date.now() + 60000
async function waitFor(fn, label, tries = 1500) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 2)) }
  throw new Error('超时未达成：' + label)
}
async function enroll(session) {
  const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
  assert.equal(started.ok, true, 'start: ' + JSON.stringify(started))
  const began = session.beginAuth(started.authId, started.generation)
  assert.equal(began.ok, true, 'begin: ' + JSON.stringify(began))
  await waitFor(() => session.status().state === 'awaiting_confirmation', '待确认')
  const confirmed = await session.confirmAccount(started.authId, started.generation)
  return confirmed
}

async function main() {
  await check('A 同 Host 忘记后重新扫码：新 confirm 必须保存成功并首读 1 次（基线缺陷复现点）', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const { session } = makeSession(sc, vault)
    await session.boot()
    assert.equal(session.status().state, 'empty')
    const first = await enroll(session)
    assert.equal(first.ok, true, '首次确认：' + JSON.stringify(first))
    assert.equal(session.status().balance !== null, true, '首次应有余额')
    const forgot = await session.forget()
    assert.equal(forgot.ok, true)
    assert.equal(provider.only().payload.revoked, true, '忘记应写 tombstone')
    const balancesBefore = sc.seen.filter((u) => u.includes('/api/v1/balance')).length

    const second = await enroll(session)
    assert.equal(second.ok, true, '同 Host 重新确认必须成功，实际：' + JSON.stringify(second))
    assert.equal(session.status().state, 'verified')
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/balance')).length, balancesBefore + 1, '成功后首读 1 次')
    assert.equal(provider.only().payload.revoked, undefined, '新 record 必须是活密文')
    assert.equal(typeof provider.only().payload.ciphertext, 'string')
    session.dispose()
  })

  await check('B vault.forget 返回 tomb revision == 随后 load().revision；load 不 unprotect；null 仍不可覆 tomb', async () => {
    const provider = fakeProvider()
    const crypto = fakeCrypto()
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    const { createRememberedSession: _ } = { createRememberedSession }
    // 先写一条合法 record
    const rec = {
      version: 1,
      consent: { version: 1, autoRestore: true, autoReadBalance: true, autoRefresh: true, confirmedAt: Date.now() },
      preferences: { paused: false },
      account: {
        version: 1, namespace: 'xiaomi-account-user-id', accountId: ACCOUNT_ID,
        cookies: [
          { name: 'passToken', value: 'P', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
          { name: 'userId', value: ACCOUNT_ID, domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
        ],
      },
    }
    await vault.save(rec, { expectedRevision: null })
    const out = await vault.forget({})
    assert.ok(out !== null && typeof out === 'object' && typeof out.revision === 'string', 'forget 必须返回 {revision}：' + JSON.stringify(out))
    const beforeUnprotect = crypto.calls.unprotect
    const loaded = await vault.load({})
    assert.equal(loaded.record, null)
    assert.equal(loaded.revision, out.revision, 'load 的 revision 必须等于 forget 返回')
    assert.equal(crypto.calls.unprotect, beforeUnprotect, 'tombstone load 不得 unprotect')
    await expectCode(() => vault.save(rec, { expectedRevision: null }), STORE_CODES.REVISION_CONFLICT, 'null 不可覆 tomb')
    await vault.save(rec, { expectedRevision: out.revision })
    assert.equal((await vault.load()).record.account.accountId, ACCOUNT_ID)
    vault.dispose()
  })

  await check('C tombstone commit 在途：新 startAuth 不抢跑（0 QR），commit 后可正常重新确认', async () => {
    const tombGate = makeGate()
    const provider = fakeProvider({ tombGate })
    const sc = scenario()
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const { session } = makeSession(sc, vault)
    await session.boot()
    assert.equal((await enroll(session)).ok, true)
    const hops = sc.seen.length

    const forgetP = session.forget()
    await waitFor(() => tombGate.count > 0, 'tombstone 写入闸门')
    const early = await session.startAuth({ authConsent: true, consentVersion: 1 })
    assert.equal(early.ok, false, '删除在途不得开始新扫码')
    assert.equal(early.code, 'E_MIMO_REMEMBERED_BUSY')
    assert.equal(sc.seen.length, hops, '删除在途 0 网络/0 QR')
    tombGate.release()
    assert.equal((await forgetP).ok, true)
    const again = await enroll(session)
    assert.equal(again.ok, true, 'commit 后可重新确认：' + JSON.stringify(again))
    session.dispose()
  })

  await check('D 读鉴权/身份终止：cleanup 真写 tomb、转场期间新首扫 BUSY、释放后可按新 rev 重登', async () => {
    const tombGate = makeGate()
    const provider = fakeProvider({ tombGate })
    const sc = scenario({ balanceStatus: 401, ssoBody: JSON.stringify({ code: 70016 }) })
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const { session } = makeSession(sc, vault)
    await session.boot()
    const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
    session.beginAuth(started.authId, started.generation)
    await waitFor(() => session.status().state === 'awaiting_confirmation', '待确认')
    const hops = sc.seen.length
    const confirmP = session.confirmAccount(started.authId, started.generation)
    await waitFor(() => tombGate.count > 0, 'cleanup 的 tombstone 写入闸门')
    assert.equal(session.status().state, 'failed', '终止后 state=failed')
    const hopsAtGate = sc.seen.length
    const early = await session.startAuth({ authConsent: true, consentVersion: 1 })
    assert.equal(early.ok, false, '删除转场期间不得开始新扫码')
    assert.equal(early.code, 'E_MIMO_REMEMBERED_BUSY')
    assert.equal(sc.seen.length, hopsAtGate, '删除转场期间 0 网络')
    const retryEarly = await session.retry()
    assert.equal(retryEarly.ok, false, 'failed 态删除在途不得 retry')
    assert.equal(retryEarly.code, 'E_MIMO_REMEMBERED_BUSY')
    assert.equal(sc.seen.length, hopsAtGate, 'retry 在删除转场期间 0 网络')
    tombGate.release()
    await confirmP
    assert.equal(provider.only() !== null && provider.only().payload.revoked, true, 'cleanup 必须真的写 tombstone')
    assert.equal((await vault.load({})).record, null, 'tombstone 后 load record=null')
    // 恢复成功路径：后续扫码/首读应成功
    sc.state.balanceStatus = 200
    sc.state.ssoBody = JSON.stringify({ code: 0, location: CB })
    const again = await enroll(session)
    assert.equal(again.ok, true, '新 rev 下可重新确认：' + JSON.stringify(again))
    assert.equal(session.status().state, 'verified')
    assert.equal(provider.only().payload.revoked, undefined, '新 owner 活密文，旧 cleanup 不覆盖')
    session.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) { for (const f of fails) console.error('FAIL ' + f); console.error(summary); process.exitCode = 1 }
  else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
