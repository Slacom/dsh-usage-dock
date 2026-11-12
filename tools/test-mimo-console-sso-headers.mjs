/**
 * test-mimo-console-sso-headers.mjs — consoleAccountSso 固定浏览器请求头模板（离线）
 * 全 fake：假 resolver + 假 reqImpl；不真实 TLS/出网/读 profile；不读真实 browser info。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSecureTransport } from '../plans/mimo-auth/secure-transport.js'
import {
  createConsoleGrantAuthority, deriveConsoleSsoUrl, CONSOLE_PURPOSES as P, CONSOLE_CODES as C,
} from '../plans/mimo-auth/console-grants.js'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES as PC } from '../plans/mimo-auth/console-protocol.js'

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

const CB = 'https://platform.xiaomimimo.com/sts'
const CONTEXT_LOCATION = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB) + '&_sign=DUMMYSIGN'
const CONTEXT_URL = 'https://platform.xiaomimimo.com/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage'
const BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance'
const SSO_URL = deriveConsoleSsoUrl(CONTEXT_LOCATION)
const PUBLIC_IP = '93.184.216.34'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

function fakeTransport(opts = {}) {
  const authority = opts.authority || null
  const counts = { dns: 0, request: 0 }
  const captured = []
  const state = { status: 200, headers: {} }
  const deps = {
    clock: opts.clock || (() => Date.now()),
    resolver: opts.resolver || (async () => { counts.dns += 1; return [{ address: PUBLIC_IP, family: 4 }] }),
    request: (options, callback) => {
      counts.request += 1
      captured.push({ options, headers: { ...(options.headers || {}) } })
      const ee = new EventEmitter()
      ee.destroy = () => {}
      ee.end = () => queueMicrotask(() => callback({
        statusCode: state.status, status: state.status, headers: state.headers, complete: true,
        socket: { remoteAddress: PUBLIC_IP },
        body: { getReader() { let done = false; return { read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: Uint8Array.from([123, 125]) }) }, releaseLock() {}, cancel() { return Promise.resolve() } } } },
      }))
      return ee
    },
    validateConsoleGrant: (grant, req) => {
      if (authority === null) { const e = new Error('E_MIMO_AUTH_TARGET_INVALID'); e.code = 'E_MIMO_AUTH_TARGET_INVALID'; throw e }
      return authority.validate(grant, req)
    },
    ...(opts.deps || {}),
  }
  return { transport: createSecureTransport(deps), counts, captured, state, authority }
}
function mkAuthority(clock = () => Date.now()) {
  const authority = createConsoleGrantAuthority({
    owner: {}, bootEpoch: 'b1', generation: 1, deadlineAt: Date.now() + 60_000, now: clock, isLive: () => true,
  })
  return { authority }
}
function ssoReq(a, over = {}) {
  const ctx = a.markSource('context', 'ctx-1', { location: CONTEXT_LOCATION })
  return {
    method: 'GET', url: SSO_URL, purpose: P.ACCOUNT_SSO, credentialClass: 'account',
    deadlineAt: Date.now() + 5000, assertAuthorized: () => true,
    grant: a.issue({ url: SSO_URL, purpose: P.ACCOUNT_SSO, credentialClass: 'account', sourceBinding: ctx }),
    headers: { cookie: 'passToken=abc; userId=42' },
    ...over,
  }
}

function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const buf = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body === null || body === undefined ? '' : String(body))
  return {
    statusCode: status, status, complete: true, redirected: false, socket: { remoteAddress: PUBLIC_IP }, headers: lower,
    body: {
      getReader() { const chunk = new Uint8Array(buf); let done = false; return { read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: chunk }) }, releaseLock() {}, cancel() { return Promise.resolve() } } },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PLATFORM_COOKIES = ['api-platform_serviceToken=PT; Path=/; Secure', 'userId=777; Path=/; Secure', 'api-platform_slh=SLH; Path=/; Secure']
function scenario(over = {}) {
  const seen = []
  const state = {
    ctxLocation: CONTEXT_LOCATION, ssoStatus: 302, ssoLocation: CB, ssoBody: '',
    balance: JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }), ...over,
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter(); ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    ee.end = () => queueMicrotask(() => {
      let res
      if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: state.ctxLocation })
      else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
      else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
      else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, JSON.stringify({ location: CB, passToken: 'PASS', userId: '777', cUserId: 'CUSER' }))
      else if (url.includes('/pass/serviceLogin')) res = makeResp(state.ssoStatus, state.ssoBody, state.ssoLocation === null ? {} : { location: state.ssoLocation })
      else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': PLATFORM_COOKIES })
      else if (url.includes('/api/v1/balance')) res = makeResp(200, state.balance)
      else res = makeResp(404, '')
      callback(res)
    })
    return ee
  }
  return { seen, state, impl, count: (p) => seen.filter((u) => u.includes(p)).length }
}
function mkProto(sc) {
  const p = createConsoleProtocol({
    owner: {}, bootEpoch: 'b1', generation: 1, expected: { namespace: 'xiaomi-account-user-id', identifier: '777' },
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
  await check('A SSO 实际发送：三项固定 profile + Cookie 逐字；无 Origin/Referer/sec-ch-ua', async () => {
    const { authority } = mkAuthority()
    const t = fakeTransport({ authority })
    await t.transport.fetch(ssoReq(authority))
    assert.equal(t.counts.request, 1)
    const h = t.captured[0].headers
    assert.equal(h['user-agent'], UA)
    assert.equal(h['accept-language'], 'en-US,en;q=0.9')
    assert.equal(h.accept, 'application/json, text/plain, */*')
    assert.equal(h.cookie, 'passToken=abc; userId=42')
    for (const name of ['origin', 'referer', 'sec-ch-ua', 'x-timezone', 'snsnone']) assert.equal(name in h, false, name)
  })

  await check('B 其它 console 用途不注入 profile；大写 Accept 仍规范化为小写 accept（与旧版一致）', async () => {
    const { authority } = mkAuthority()
    const t = fakeTransport({ authority })
    await t.transport.fetch({
      method: 'GET', url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none',
      deadlineAt: Date.now() + 5000, assertAuthorized: () => true,
      grant: authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' }),
      headers: { Accept: 'application/json' },
    })
    assert.equal(t.captured[0].headers['user-agent'], undefined)
    assert.equal(t.captured[0].headers['accept-language'], undefined)
    assert.equal(t.captured[0].headers.accept, 'application/json')
    assert.equal('Accept' in t.captured[0].headers, false, 'native header 名必须小写')
  })

  await check('C caller 注入 UA/accept-language/host/auth/重复 cookie：0 DNS 0 请求、固定码', async () => {
    const bads = [
      { 'user-agent': UA },
      { 'accept-language': 'en-US' },
      { host: 'account.xiaomi.com' },
      { authorization: 'Bearer x' },
      { 'sec-ch-ua': '"Chromium";v="143"' },
    ]
    for (const extra of bads) {
      const { authority } = mkAuthority()
      const t = fakeTransport({ authority })
      await expectCode(() => t.transport.fetch(ssoReq(authority, { headers: { cookie: 'passToken=abc; userId=42', ...extra } })), C.TARGET_INVALID, JSON.stringify(Object.keys(extra)))
      assert.equal(t.counts.dns, 0, 'dns 0')
      assert.equal(t.counts.request, 0, 'request 0')
    }
  })

  await check('D 无 grant / 错 purpose / 过期 / 预取消：0 请求', async () => {
    const { authority } = mkAuthority()
    const t = fakeTransport({ authority })
    await expectCode(() => t.transport.fetch(ssoReq(authority, { grant: Object.freeze(Object.create(null)) })), C.TARGET_INVALID, 'fake grant')
    const u = ssoReq(authority)
    await expectCode(() => t.transport.fetch({ ...u, purpose: P.BALANCE, grant: authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' }) }), 'E_URL_PURPOSE_MISMATCH', 'purpose mismatch')
    const ac = new AbortController(); ac.abort()
    await expectCode(() => t.transport.fetch(ssoReq(authority, { signal: ac.signal })), 'E_MIMO_AUTH_CANCELLED', 'cancelled')
    const clock = mkAuthority(() => Date.now() + 120_000)
    const t2 = fakeTransport({ authority: clock.authority, clock: () => Date.now() + 120_000 })
    let dlErr = null
    try { await t2.transport.fetch(ssoReq(clock.authority)) } catch (e) { dlErr = e }
    assert.ok(dlErr !== null && ['E_REQUEST_TIMEOUT', 'E_MIMO_AUTH_TARGET_EXPIRED'].includes(dlErr.code), 'deadline -> ' + (dlErr && dlErr.code))
    assert.equal(t.counts.request, 0)
    assert.equal(t2.counts.request, 0)
  })

  await check('E DNS await 期间改 req.headers：实际 cookie/profile 不变（冻结一致性）', async () => {
    const { authority } = mkAuthority()
    let release = null
    const gate = new Promise((r) => { release = r })
    const t = fakeTransport({
      authority,
      resolver: async () => { await gate; return [{ address: PUBLIC_IP, family: 4 }] },
    })
    const req = ssoReq(authority)
    const run = t.transport.fetch(req)
    await new Promise((r) => setTimeout(r, 10))
    req.headers.cookie = 'passToken=HACKED'
    req.headers['user-agent'] = 'evil'
    release()
    await run
    const h = t.captured[0].headers
    assert.equal(h.cookie, 'passToken=abc; userId=42')
    assert.equal(h['user-agent'], UA)
  })

  await check('F 真实 kernel：3 hop+余额成功；302 到 https account/fe/service/login 仍 ACCOUNT_OTHER+安全摘要、0 callback', async () => {
    const saved = await savedAccount()
    const okSc = scenario()
    const s1 = mkProto(okSc)
    await s1.p.restoreRememberedAccount(saved, { deadlineAt: s1.dl() })
    assert.equal(okSc.count('/sts'), 1)
    assert.equal(okSc.seen.length, 3, 'hops=' + okSc.seen.length)
    const bal = await s1.p.readBalance({ deadlineAt: s1.dl() })
    assert.equal(bal.balance.balance, 13.5)
    s1.p.dispose()

    // 与 header 是否存在无关的固定服务端形状；不伪造「有 UA 就成功」的因果
    const badSc = scenario({ ssoLocation: 'https://account.xiaomi.com/fe/service/login' })
    const s2 = mkProto(badSc)
    await expectCode(() => s2.p.restoreRememberedAccount(saved, { deadlineAt: s2.dl() }), PC.SSO_TARGET_ACCOUNT_OTHER)
    assert.equal(badSc.count('/sts'), 0, '0 callback')
    assert.equal(badSc.count('/api/v1/balance'), 0, '0 balance')
    const hs = s2.p.describe().handoffSummary
    assert.deepEqual(hs.pathTokens, ['fe', 'service', 'login'])
    assert.equal(hs.scheme, 'https')
    assert.equal(hs.status, 302)
    s2.p.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) { for (const f of fails) console.error('FAIL ' + f); console.error(summary); process.exitCode = 1 }
  else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
