/**
 * test-mimo-console-target-shapes.mjs — SSO 目标形状固定闭集分类（只细分错误，不放行）
 *
 * 全 fake：不访问真实 account/platform、不读 cfg/record；断言只含静态码、不泄露 URL/secret。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES as C } from '../plans/mimo-auth/console-protocol.js'

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
const PLATFORM_COOKIES = [
  'api-platform_serviceToken=PT; Path=/; Secure',
  'userId=777; Path=/; Secure',
  'api-platform_slh=SLH; Path=/; Secure',
]
const NS = 'xiaomi-account-user-id'
const OLD_PASS = 'OLD_PASS_TOKEN'
const SECRET = 'SYNTHETIC_SECRET_MARKER'

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
        const chunk = new Uint8Array(buf); let done = false
        return { read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: chunk }) }, releaseLock() {}, cancel() { return Promise.resolve() } }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}

function scenario(over = {}) {
  const seen = []
  const state = {
    ctxLocation: SIGNED, ssoStatus: 302, ssoLocation: CB, ssoBody: '', callbackCookies: PLATFORM_COOKIES,
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
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, JSON.stringify({ location: CB, passToken: OLD_PASS, userId: '777', cUserId: 'CUSER' }))
        else if (url.includes('/pass/serviceLogin')) res = makeResp(state.ssoStatus, state.ssoBody, state.ssoLocation === null ? {} : { location: state.ssoLocation })
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

function mk(sc) {
  const p = createConsoleProtocol({
    owner: {}, bootEpoch: 'b1', generation: 1,
    expected: { namespace: NS, identifier: '777' },
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

const SHAPES = [
  ['http://platform.xiaomimimo.com/sts', C.SSO_TARGET_HTTP_PLATFORM_STS],
  ['http://platform.xiaomimimo.com/sts?x=1', C.SSO_TARGET_HTTP_PLATFORM_STS],
  ['http://platform.xiaomimimo.com/other', C.SSO_TARGET_HTTP_PLATFORM_OTHER],
  ['https://platform.xiaomimimo.com/api/sts', C.SSO_TARGET_HTTPS_PLATFORM_API_STS],
  ['https://platform.xiaomimimo.com/sts/', C.SSO_TARGET_HTTPS_PLATFORM_STS_SLASH],
  ['https://platform.xiaomimimo.com/other', C.SSO_TARGET_HTTPS_PLATFORM_OTHER],
  ['https://account.xiaomi.com/pass/other', C.SSO_TARGET_ACCOUNT_OTHER],
  ['http://account.xiaomi.com/pass/other', C.SSO_TARGET_ACCOUNT_OTHER],
  ['https://evil.example/sts', C.SSO_TARGET_OTHER_HOST],
  ['https://user:pw@platform.xiaomimimo.com/sts', C.SSO_TARGET_UNSAFE_AUTHORITY],
  ['https://platform.xiaomimimo.com:8443/sts', C.SSO_TARGET_UNSAFE_AUTHORITY],
  ['https://platform.xiaomimimo.com/sts#frag', C.SSO_TARGET_UNSAFE_AUTHORITY],
  ['ftp://platform.xiaomimimo.com/sts', C.SSO_TARGET_OTHER_SCHEME],
]

async function main() {
  const saved = await savedAccount()

  await check('raw 3xx：13 种目标形状逐项固定码、0 回调/0 余额', async () => {
    for (const [loc, code] of SHAPES) {
      const sc = scenario({ ssoLocation: loc })
      const { p, dl } = mk(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), code, loc)
      assert.equal(sc.count('/sts'), 0, '0 callback: ' + loc)
      assert.equal(sc.count('/api/v1/balance'), 0, '0 balance: ' + loc)
      p.dispose()
    }
  })

  await check('200 JSON：同一分类在 JSON location 上也成立（代表例）、0 回调', async () => {
    for (const [loc, code] of [
      ['http://platform.xiaomimimo.com/sts', C.SSO_TARGET_HTTP_PLATFORM_STS],
      ['https://platform.xiaomimimo.com/api/sts', C.SSO_TARGET_HTTPS_PLATFORM_API_STS],
      ['https://platform.xiaomimimo.com/other', C.SSO_TARGET_HTTPS_PLATFORM_OTHER],
      ['https://evil.example/sts', C.SSO_TARGET_OTHER_HOST],
      ['https://user:pw@platform.xiaomimimo.com/sts', C.SSO_TARGET_UNSAFE_AUTHORITY],
    ]) {
      const sc = scenario({ ssoStatus: 200, ssoLocation: null, ssoBody: JSON.stringify({ code: 0, location: loc, userId: 777, passToken: OLD_PASS }) })
      const { p, dl } = mk(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), code, loc)
      assert.equal(sc.count('/sts'), 0)
      p.dispose()
    }
  })

  await check('优先级：account 登录页→AUTH_REJECTED、通知页→CHALLENGE，不被形状分类覆盖', async () => {
    const login = scenario({ ssoLocation: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' })
    const h1 = mk(login)
    await expectCode(() => h1.p.restoreRememberedAccount(saved, { deadlineAt: h1.dl() }), C.AUTH_REJECTED)
    assert.equal(login.count('/sts'), 0)
    h1.p.dispose()
    const notice = scenario({ ssoLocation: 'https://account.xiaomi.com/pass/notification' })
    const h2 = mk(notice)
    await expectCode(() => h2.p.restoreRememberedAccount(saved, { deadlineAt: h2.dl() }), C.SSO_CHALLENGE)
    assert.equal(notice.count('/sts'), 0)
    h2.p.dispose()
  })

  await check('有效 clean https platform/sts 仍正常 3 hop + 余额（分类不改允许集）', async () => {
    const sc = scenario({ ssoStatus: 302, ssoLocation: CB })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    assert.equal(sc.count('/sts'), 1)
    const out = await p.readBalance({ deadlineAt: dl() })
    assert.equal(out.balance.balance, 13.5)
    p.dispose()
  })

  await check('不泄露：错误/describe 只含静态码，不含 URL/secret 标记', async () => {
    const loc = 'https://platform.xiaomimimo.com/other?' + SECRET + '=1'
    const sc = scenario({ ssoLocation: loc })
    const { p, dl } = mk(sc)
    const err = await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_TARGET_HTTPS_PLATFORM_OTHER)
    const blob = String(err.message) + JSON.stringify(p.describe()) + JSON.stringify(p.exportRememberedAccount === undefined ? {} : p.describe())
    assert.equal(blob.includes(SECRET), false, '不得含 secret')
    assert.equal(blob.includes('platform.xiaomimimo.com'), false, '不得含 host 原文')
    p.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) { for (const f of fails) console.error('FAIL ' + f); console.error(summary); process.exitCode = 1 }
  else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
