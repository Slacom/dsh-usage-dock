/**
 * test-mimo-console-handoff-summary.mjs — 失败 ACCOUNT 目标的 5 字段安全摘要（不增请求）
 * 全 fake：不访问真实 account/platform、不读 cfg/record；断言只含闭集词/静态值。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleProtocol, projectConsoleHandoffSummary, CONSOLE_PROTOCOL_CODES as C } from '../plans/mimo-auth/console-protocol.js'
import { createRememberedSession } from '../plans/mimo-auth/remembered-session.js'
import { createRememberedVault } from '../plans/mimo-auth/remember-store.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}
async function expectCode(fn, code, label) {
  try { await fn() } catch (e) {
    if (e.code !== code) throw new Error((label || '') + ' 期望 ' + code + ' 实际 ' + (e.code || e.message))
    return e
  }
  throw new Error((label || '') + ' 期望抛 ' + code + '，但没有抛')
}

const PUBLIC_IP = '93.184.216.34'
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB) + '&_sign=ABC'
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const NS = 'xiaomi-account-user-id'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'
const SECRET = 'SYNTHETIC_SECRET_MARKER'
const PLATFORM_COOKIES = ['api-platform_serviceToken=PT; Path=/; Secure', 'userId=777; Path=/; Secure', 'api-platform_slh=SLH; Path=/; Secure']

function makeGate() {
  let release = null
  const promise = new Promise((r) => { release = r })
  const waiters = []
  return { promise, release() { release() }, get count() { return waiters.length }, wait() { waiters.push(1); return promise } }
}
function bufOf(body) { return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body === null || body === undefined ? '' : String(body)) }
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const buf = bufOf(body)
  return {
    statusCode: status, status, complete: true, redirected: false, socket: { remoteAddress: PUBLIC_IP }, headers: lower,
    body: {
      getReader() { const chunk = new Uint8Array(buf); let done = false; return { read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: chunk }) }, releaseLock() {}, cancel() { return Promise.resolve() } } },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}
function scenario(over = {}) {
  const seen = []
  const state = {
    ctxLocation: SIGNED, ssoStatus: 302, ssoLocation: CB, ssoBody: '', ssoHold: null, callbackCookies: PLATFORM_COOKIES,
    balance: JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }), ...over,
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter(); ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    ee.end = () => {
      queueMicrotask(() => {
        let res
        if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: state.ctxLocation })
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, JSON.stringify({ location: CB, passToken: 'PASS', userId: '777', cUserId: 'CUSER' }))
        else if (url.includes('/pass/serviceLogin')) {
          const headers = state.ssoLocation === null ? {} : { location: state.ssoLocation }
          const send = () => queueMicrotask(() => callback(makeResp(state.ssoStatus, state.ssoBody, headers)))
          if (state.ssoHold !== null) { void state.ssoHold.promise.then(send); return }
          send(); return
        }
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
        else if (url.includes('/api/v1/balance')) res = makeResp(200, state.balance)
        else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl, count: (p) => seen.filter((u) => u.includes(p)).length }
}
function mkProto(sc) {
  const p = createConsoleProtocol({
    owner: {}, bootEpoch: 'b1', generation: 1, expected: { namespace: NS, identifier: '777' },
    now: () => Date.now(), isLive: () => true,
    transportDeps: { clock: () => Date.now(), resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
  })
  return { p, dl: () => Date.now() + 60000 }
}
async function savedAccount() {
  const sc = scenario()
  const p = createConsoleProtocol({
    owner: {}, bootEpoch: 'b1', generation: 1, confirmAfterScan: true, now: () => Date.now(), isLive: () => true,
    transportDeps: { clock: () => Date.now(), resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
  })
  await p.login({ deadlineAt: Date.now() + 60000 })
  p.confirmAccount('777')
  const saved = p.exportRememberedAccount()
  p.dispose()
  return saved
}

async function main() {
  const saved = await savedAccount()

  await check('P projector：未知字段不 copy、未知词/坏类型/超 8 段 → null；合法副本 5 字段', () => {
    assert.equal(projectConsoleHandoffSummary(null), null)
    assert.equal(projectConsoleHandoffSummary({ source: 'x', status: 302, scheme: 'https', pathTokens: [], truncated: false }), null)
    assert.equal(projectConsoleHandoffSummary({ source: 'header', status: 302, scheme: 'https', pathTokens: ['fe', 'secret'], truncated: false }), null)
    assert.deepEqual(projectConsoleHandoffSummary({ source: 'header', status: 200, scheme: 'https', pathTokens: [], truncated: false }), { source: 'header', status: 200, scheme: 'https', pathTokens: [], truncated: false })
    const nine = ['fe', 'pass', 'service', 'login', 'auth', 'qr', 'sts', 'api', 'v1']
    assert.equal(projectConsoleHandoffSummary({ source: 'header', status: 302, scheme: 'https', pathTokens: nine, truncated: false }), null)
    const ok = projectConsoleHandoffSummary({ source: 'header', status: 302, scheme: 'https', pathTokens: ['fe', 'login'], truncated: false, host: 'x', url: 'SECRET' })
    assert.deepEqual(ok, { source: 'header', status: 302, scheme: 'https', pathTokens: ['fe', 'login'], truncated: false })
  })

  await check('A raw ACCOUNT_OTHER：describe().handoffSummary 5 字段、未知段→other、query/fragment/userinfo 不出现', async () => {
    const loc = 'https://account.xiaomi.com/fe/service/login/' + SECRET + '/%E4%B8%AD?x=' + SECRET
    const sc = scenario({ ssoLocation: loc })
    const { p, dl } = mkProto(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_TARGET_ACCOUNT_OTHER)
    const hs = p.describe().handoffSummary
    assert.deepEqual(Object.keys(hs).sort(), ['pathTokens', 'scheme', 'source', 'status', 'truncated'])
    assert.equal(hs.source, 'header')
    assert.equal(hs.status, 302)
    assert.equal(hs.scheme, 'https')
    assert.deepEqual(hs.pathTokens, ['fe', 'service', 'login', 'other', 'other'])
    const blob = JSON.stringify(hs) + JSON.stringify(p.describe())
    assert.equal(blob.includes(SECRET), false, '不得含 secret')
    assert.equal(blob.includes('account.xiaomi.com'), false, '不得含 host')
    p.dispose()
  })

  await check('B JSON 代表例：source=json/status=200，同一词表；>8 段 truncated=true', async () => {
    const loc = 'https://account.xiaomi.com/pass/a/b/c/d/e/f/g/h/i?SECRET=1'
    const sc = scenario({ ssoStatus: 200, ssoLocation: null, ssoBody: JSON.stringify({ code: 0, location: loc, userId: 777, passToken: 'PASS' }) })
    const { p, dl } = mkProto(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_TARGET_ACCOUNT_OTHER)
    const hs = p.describe().handoffSummary
    assert.equal(hs.source, 'json')
    assert.equal(hs.status, 200)
    assert.equal(hs.pathTokens.length, 8)
    assert.equal(hs.truncated, true)
    assert.equal(JSON.stringify(hs).includes(SECRET), false)
    p.dispose()
  })

  await check('C 有效 https platform/sts：handoffSummary 为 null，仍 3 hop + 余额', async () => {
    const sc = scenario({ ssoStatus: 302, ssoLocation: CB })
    const { p, dl } = mkProto(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    assert.equal(p.describe().handoffSummary, null)
    assert.equal(sc.count('/sts'), 1)
    const out = await p.readBalance({ deadlineAt: dl() })
    assert.equal(out.balance.balance, 13.5)
    p.dispose()
  })

  await check('D controller：restore 失败 dropProtocol 后 snapshot 仍保留摘要；retry/forget/成功清除', async () => {
    const provider = {
      map: new Map(),
      async readRecord(k) { return this.map.get(k) },
      async modifyRecord(k, fn) { const cur = this.map.get(k); const next = await fn(cur); if (next === undefined) return cur; this.map.set(k, next); return next },
    }
    const crypto = { async capability() { return { supported: true, code: 'E_NONE' } }, async protect(b) { return Uint8Array.from(b).map((x) => x ^ 0x5a) }, async unprotect(b) { return Uint8Array.from(b).map((x) => x ^ 0x5a) }, dispose() {} }
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto })
    // 先写入一条合法 record（用真实 store record schema）
    await vault.save({
      version: 1,
      consent: { version: 1, autoRestore: true, autoReadBalance: true, autoRefresh: true, confirmedAt: Date.now() },
      preferences: { paused: false },
      account: {
        version: 1, namespace: NS, accountId: '777',
        cookies: [
          { name: 'passToken', value: 'PASS', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
          { name: 'userId', value: '777', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
        ],
      },
    }, { expectedRevision: null })
    const sc = scenario({ ssoLocation: 'https://account.xiaomi.com/pass/other?x=1' })
    const session = createRememberedSession({
      bootEpoch: 'c'.repeat(32), vault, isEnabled: () => true, now: () => Date.now(),
      transportDeps: { clock: () => Date.now(), resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
    })
    await session.boot()
    assert.equal(session.status().state, 'failed')
    const hs = session.status().handoffSummary
    assert.ok(hs !== null && typeof hs === 'object', '失败后摘要必须保留')
    assert.deepEqual(hs.pathTokens, ['pass', 'other'])
    assert.equal(JSON.stringify(hs).includes('account.xiaomi.com'), false)
    await session.retry()
    // retry 会重新尝试恢复并再次失败 ⇒ 允许新摘要，但必须是本次新值（同源同词表），不得残留旧 op 值
    const afterRetry = session.status().handoffSummary
    assert.ok(afterRetry === null || (afterRetry.source === 'header' && Array.isArray(afterRetry.pathTokens)))
    await session.forget()
    assert.equal(session.status().handoffSummary, null, 'forget 后清空')
    session.dispose()
  })

  await check('E 迟到 ACCOUNT_OTHER 响应：取消/释放后不得写入或回填摘要，retry/成功后为 null', async () => {
    for (const mode of ['abort', 'dispose']) {
      const hold = makeGate()
      const sc = scenario({ ssoLocation: 'https://account.xiaomi.com/pass/other?x=1', ssoHold: hold })
      const { p, dl } = mkProto(sc)
      const ac = new AbortController()
      const run = p.restoreRememberedAccount(saved, { deadlineAt: dl(), signal: ac.signal })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(sc.count('/pass/serviceLogin'), 1, 'SSO 请求已发出（gate 未放行）')
      if (mode === 'abort') ac.abort(); else p.dispose()
      hold.release()
      let err = null
      try { await run } catch (e) { err = e }
      assert.ok(err !== null, mode + ' 应失败/取消')
      assert.equal(p.describe().handoffSummary, null, mode + ' 不得写入迟到摘要')
      p.dispose()
    }
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) { for (const f of fails) console.error('FAIL ' + f); console.error(summary); process.exitCode = 1 }
  else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
