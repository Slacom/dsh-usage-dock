/**
 * test-mimo-console-redirect-sso.mjs — SSO 受控 raw 3xx 交接 / 完整 URL 保留 / JSON200 兼容
 *
 * 全合成：fake DNS/HTTPS，不访问真实 account/platform、不读 cfg/record。
 * 重点：serviceLogin URL 逐字保留（不补 _json/_locale）；SSO 302→精确 /sts 单跳；
 * 非 /sts/http/缺 Location 0 回调；200 JSON/challenge/70016 原语义不退。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES as C } from '../plans/mimo-auth/console-protocol.js'
import { deriveConsoleSsoUrl } from '../plans/mimo-auth/console-grants.js'

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
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB) + '&_sign=ABC&qs=%2F%20~%2f&x=1'
const SIGNED_WITH_JSON = SIGNED + '&_json=true&_locale=zh_CN'
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PLATFORM_COOKIES = [
  'api-platform_serviceToken=PT; Path=/; Secure',
  'userId=777; Path=/; Secure',
  'api-platform_slh=SLH; Path=/; Secure',
]
const NS = 'xiaomi-account-user-id'
const OLD_PASS = 'OLD_PASS_TOKEN'

function makeGate() {
  let release = null
  const promise = new Promise((r) => { release = r })
  const waiters = []
  return { promise, wait() { waiters.push(1); return promise }, release() { release() }, get count() { return waiters.length } }
}
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
  const cookies = []
  const state = {
    ctxLocation: SIGNED,
    ssoStatus: 302,
    ssoLocation: CB,
    ssoCookies: [],
    ssoHold: null,
    ssoBody: '',
    callbackCookies: PLATFORM_COOKIES,
    balance: JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }),
    ...over,
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter()
    ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    cookies.push({ url, headers: { ...(options.headers || {}) } })
    ee.end = () => {
      queueMicrotask(() => {
        let res
        if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: state.ctxLocation })
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, JSON.stringify({ location: CB, passToken: OLD_PASS, userId: '777', cUserId: 'CUSER' }))
        else if (url.includes('/pass/serviceLogin')) {
          const headers = state.ssoLocation === null ? {} : { location: state.ssoLocation }
          if (state.ssoCookies.length > 0) headers['set-cookie'] = state.ssoCookies
          const send = () => queueMicrotask(() => callback(makeResp(state.ssoStatus, state.ssoBody, headers)))
          if (state.ssoHold !== null) { void state.ssoHold.promise.then(send); return }
          queueMicrotask(() => callback(makeResp(state.ssoStatus, state.ssoBody, headers)))
          return
        }
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
        else if (url.includes('/api/v1/balance')) res = makeResp(200, state.balance)
        else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, cookies, state, impl, count: (p) => seen.filter((u) => u.includes(p)).length }
}

function mk(sc, over = {}) {
  const clock = { t: Date.now() }
  const p = createConsoleProtocol({
    owner: {}, bootEpoch: 'b1', generation: 1,
    expected: { namespace: NS, identifier: '777' },
    now: () => clock.t, isLive: () => true,
    transportDeps: { clock: () => Date.now(), resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
    ...over,
  })
  return { p, dl: () => clock.t + 60000 }
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

  await check('A derive：完整保留 serviceLogin URL（不补 _json/_locale，opaque 查询不改）', () => {
    const out = deriveConsoleSsoUrl(SIGNED)
    assert.equal(out.includes('_json'), false)
    assert.equal(out.includes('_locale'), false)
    assert.ok(out.includes('%2F%20~%2f'), 'opaque 片段必须保留：' + out)
    assert.ok(out.includes('_sign=ABC'))
    assert.ok(out.includes('callback='))
  })

  await check('B raw 302：URL 逐字保留；SSO 新发 quoted passToken+精确 expiry；callback 不带任何旧票', async () => {
    const EXP = 'Wed, 01 Jan 2031 00:00:00 GMT'
    const sc = scenario({ ssoCookies: ['passToken="NEW_RAW"; Domain=account.xiaomi.com; Path=/; Secure; HttpOnly; Expires=' + EXP] })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const ssoReq = sc.seen.find((u) => u.includes('/pass/serviceLogin'))
    assert.equal(ssoReq, deriveConsoleSsoUrl(SIGNED), 'SSO 请求必须逐字保留服务端 URL')
    assert.equal(ssoReq.includes('_json'), false)
    assert.equal(sc.count('/sts'), 1)
    assert.equal(sc.seen.length, 3, 'hops=' + sc.seen.length)
    const cb = sc.cookies.find((c) => c.url.includes('/sts'))
    assert.equal(String(cb.headers.cookie || '').includes('passToken'), false, 'callback 不得带 account seed')
    assert.equal(String(cb.headers.cookie || '').includes('api-platform_serviceToken'), false, 'callback 不得复用旧平台票')
    const out = await p.readBalance({ deadlineAt: dl() })
    assert.equal(out.balance.balance, 13.5)
    const exp = p.exportRememberedAccount()
    assert.equal(exp.accountId, '777')
    const pt = exp.cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, '"NEW_RAW"', 'raw quote 必须原样')
    assert.equal(pt.expiresAt, Date.parse(EXP), 'header 精确 expiry 必须保留')
    assert.equal(exp.cookies.some((c) => c.value === OLD_PASS), false, '旧 value 不得出现在导出')
    p.dispose()
  })

  await check('C 允许 301/303/307/308；304/200空体/未知 3xx 固定拒绝且 0 回调', async () => {
    for (const status of [301, 303, 307, 308]) {
      const sc = scenario({ ssoStatus: status })
      const { p, dl } = mk(sc)
      await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
      assert.equal(sc.count('/sts'), 1, 'status=' + status)
      p.dispose()
    }
    for (const status of [304, 300, 201]) {
      const sc = scenario({ ssoStatus: status })
      const { p, dl } = mk(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.FLOW, 'status=' + status)
      assert.equal(sc.count('/sts'), 0)
      p.dispose()
    }
  })

  await check('D 已知 account 登录页→AUTH_REJECTED；通知页→CHALLENGE；userinfo/port/hash/其它 target→unsupported；均 0 回调', async () => {
    const sc1 = scenario({ ssoLocation: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' })
    const h1 = mk(sc1)
    await expectCode(() => h1.p.restoreRememberedAccount(saved, { deadlineAt: h1.dl() }), C.AUTH_REJECTED, 'account login')
    assert.equal(sc1.count('/sts'), 0)
    h1.p.dispose()

    for (const loc of ['https://account.xiaomi.com/pass/notification', 'https://account.xiaomi.com/pass/notification/verify?x=1']) {
      const sc = scenario({ ssoLocation: loc })
      const h = mk(sc)
      await expectCode(() => h.p.restoreRememberedAccount(saved, { deadlineAt: h.dl() }), C.SSO_CHALLENGE, loc)
      assert.equal(sc.count('/sts'), 0)
      h.p.dispose()
    }

    const bads = [
      ['https://evil.example/sts', C.SSO_TARGET_OTHER_HOST],
      ['http://platform.xiaomimimo.com/sts', C.SSO_TARGET_HTTP_PLATFORM_STS],
      ['https://platform.xiaomimimo.com/other', C.SSO_TARGET_HTTPS_PLATFORM_OTHER],
      ['https://user:pw@platform.xiaomimimo.com/sts', C.SSO_TARGET_UNSAFE_AUTHORITY],
      ['https://platform.xiaomimimo.com:8443/sts', C.SSO_TARGET_UNSAFE_AUTHORITY],
      ['https://platform.xiaomimimo.com/sts#frag', C.SSO_TARGET_UNSAFE_AUTHORITY],
      ['https://account.xiaomi.com/pass/other', C.SSO_TARGET_ACCOUNT_OTHER],
    ]
    for (const [loc, code] of bads) {
      const sc = scenario({ ssoLocation: loc })
      const { p, dl } = mk(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), code, loc)
      assert.equal(sc.count('/sts'), 0)
      p.dispose()
    }
    const sc = scenario({ ssoLocation: null })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.FLOW, 'missing location')
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('E JSON200 兼容：code0 成功；70016 仍 AUTH_REJECTED；bSecondValidation true⇒CHALLENGE、非 boolean⇒unsupported', async () => {
    const okSc = scenario({ ssoStatus: 200, ssoLocation: null, ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: OLD_PASS, bSecondValidation: false }) })
    const ok = mk(okSc)
    await ok.p.restoreRememberedAccount(saved, { deadlineAt: ok.dl() })
    assert.equal(okSc.count('/sts'), 1)
    ok.p.dispose()

    const badSc = scenario({ ssoStatus: 200, ssoLocation: null, ssoBody: JSON.stringify({ code: 70016 }) })
    const bad = mk(badSc)
    await expectCode(() => bad.p.restoreRememberedAccount(saved, { deadlineAt: bad.dl() }), C.AUTH_REJECTED)
    assert.equal(badSc.count('/sts'), 0)
    bad.p.dispose()

    for (const [val, code] of [[true, C.SSO_CHALLENGE], ['yes', C.SSO_RESPONSE_UNSUPPORTED]]) {
      const sc = scenario({ ssoStatus: 200, ssoLocation: null, ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: OLD_PASS, bSecondValidation: val }) })
      const h = mk(sc)
      await expectCode(() => h.p.restoreRememberedAccount(saved, { deadlineAt: h.dl() }), code, 'bSecond=' + String(val))
      assert.equal(sc.count('/sts'), 0)
      h.p.dispose()
    }
  })

  await check('F 迟到 raw 响应：gate 期间 abort/dispose ⇒ 固定取消码、0 回调/0 余额/0 导出回填', async () => {
    for (const mode of ['abort', 'dispose']) {
      const hold = makeGate()
      const sc = scenario({ ssoHold: hold })
      const { p, dl } = mk(sc)
      const ac = new AbortController()
      const run = p.restoreRememberedAccount(saved, { deadlineAt: dl(), signal: ac.signal })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(sc.count('/pass/serviceLogin'), 1, 'SSO 请求已发出（gate 未放行）')
      if (mode === 'abort') ac.abort(); else p.dispose()
      hold.release()
      let err = null
      try { await run } catch (e) { err = e }
      assert.ok(err !== null && [C.CANCELLED, C.EXPIRED].includes(err.code), mode + ' -> ' + (err && err.code))
      assert.equal(sc.count('/sts'), 0, mode + ' 不得回调')
      assert.equal(sc.count('/api/v1/balance'), 0, mode + ' 不得读余额')
      if (mode === 'abort') await expectCode(() => p.exportRememberedAccount(), C.NOT_VERIFIED, 'abort 后不得导出')
      p.dispose()
    }
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) { for (const f of fails) console.error('FAIL ' + f); console.error(summary); process.exitCode = 1 }
  else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
