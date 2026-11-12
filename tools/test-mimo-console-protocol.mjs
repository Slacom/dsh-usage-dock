/**
 * test-mimo-console-protocol.mjs — A3 协议内核（离线；真实 A1 authority + 真实 createSecureTransport）
 * 只 fake DNS/https；不 fake 协议序列与 JSON 解析。运行：node tools/test-mimo-console-protocol.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleProtocol } from '../plans/mimo-auth/console-protocol.js'

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
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PLATFORM_COOKIES = [
  'api-platform_serviceToken=PT; Path=/; Secure',
  'userId=777; Path=/; Secure',
  'api-platform_slh=SLH; Path=/; Secure'
]

function bufOf(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body === null || body === undefined ? '' : String(body))
}
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const buf = bufOf(body)
  return {
    statusCode: status,
    status,
    complete: true,
    redirected: false,
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

function scenario(over = {}) {
  const seen = []
  const cookies = []
  const state = {
    lpBody: JSON.stringify({ location: CB, passToken: 'SEED-TOKEN', userId: '777', cUserId: '888' }),
    qrBody: JSON.stringify({ qr: QR, lp: LP }),
    balanceSeq: null,        // 例如 [403, 200]
    balanceBody: JSON.stringify({ code: 0, data: { balance: '13.50', cashBalance: '12.50', giftBalance: '1.00', currency: 'CNY' } }),
    callbackCookies: PLATFORM_COOKIES,
    lpHeaderCookies: null,        // 例如 ['passToken=OTHER; Path=/; Secure']
    ssoAccountCookies: null,      // 账号 SSO 响应 SetCookie
    ssoCallbackCookies: PLATFORM_COOKIES,
    balanceHeaderCookies: null,
    hangLp: false,
    hangBalance: false,
    hang: false,
    // 在排队响应**之前**调用（测试用它推进 fake clock，制造「单跳超时但整体未到期」）
    hook: null,
    ...over
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter()
    ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    cookies.push({ url, headers: { ...(options.headers || {}) } })
    ee.end = () => {
      if (state.hang) return
      if (state.hangLp && url.includes('/longPolling/loginUrl') && !url.includes('qs=')) return
      if (state.hangBalance && url.includes('/api/v1/balance')) return
      if (typeof state.hook === 'function') state.hook(url)
      queueMicrotask(() => {
        let res
        if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: SIGNED })
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, state.qrBody)
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) {
          const h = state.lpHeaderCookies === null ? {} : { 'set-cookie': state.lpHeaderCookies }
          res = makeResp(200, state.lpBody, h)
        } else if (url.includes('/pass/serviceLogin')) {
          const h = state.ssoAccountCookies === null ? {} : { 'set-cookie': state.ssoAccountCookies }
          res = makeResp(200, JSON.stringify({ code: 0, location: CB }), h)
        } else if (url.includes('/sts')) {
          const cookies = state.ssoCallbackCookies === null ? [] : state.ssoCallbackCookies
          res = makeResp(200, '', { 'set-cookie': cookies })
        }
        else if (url.includes('/api/v1/balance')) {
          if (Array.isArray(state.balanceSeq) && state.balanceSeq.length > 0) {
            const next = state.balanceSeq.shift()
            res = makeResp(next, next === 200 ? state.balanceBody : '', state.balanceHeaderCookies === null ? {} : { 'set-cookie': state.balanceHeaderCookies })
          } else {
            res = makeResp(200, state.balanceBody, state.balanceHeaderCookies === null ? {} : { 'set-cookie': state.balanceHeaderCookies })
          }
        } else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl, cookies }
}

function mkProtocol(sc, over = {}) {
  const live = { owner: true, authResult: true, balance: true }
  const p = createConsoleProtocol({
    owner: {},
    bootEpoch: 'b1',
    generation: 1,
    expected: { namespace: 'xiaomi-account-user-id', identifier: '777' },
    isLive: (purpose) => {
      if (live.owner !== true) return false
      if (purpose === 'consoleAuthResult') return live.authResult
      if (purpose === 'consoleBalance') return live.balance
      return true
    },
    transportDeps: {
      clock: () => Date.now(),
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
      request: sc.impl
    },
    ...over
  })
  return { p, live }
}
const DL = () => Date.now() + 30_000

async function main() {
  await check('login 5 请求 / balance 0 / verified', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    let qr = null
    await p.login({ deadlineAt: DL(), onQr: (x) => { qr = x } })
    assert.equal(sc.seen.length, 5, 'seen=' + sc.seen.join('|'))
    assert.ok(qr && qr.mime === 'image/png' && qr.bytes.length >= 8)
    assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
    assert.equal(p.describe().state, 'verified')
    assert.equal(p.describe().identity.maskedLabel.includes('777'), false, 'mask 不得含原始 ID')
  })

  await check('显式 readBalance = 第 6 请求（total/cash/gift）', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const n = sc.seen.length
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length, n + 1)
    assert.equal(out.balance.balance, 13.5)
    assert.equal(out.balance.cashBalance, 12.5)
    assert.equal(out.balance.giftBalance, 1)
    assert.equal(out.balance.currency, 'CNY')
    assert.deepEqual(out.identity, { namespace: 'xiaomi-account-user-id', identifier: '777' })
  })

  await check('只有 balance+currency：成功且不含 cash/gift 字段', async () => {
    const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data: { balance: 3, currency: 'CNY' } }) })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.equal(out.balance.balance, 3)
    assert.equal('cashBalance' in out.balance, false)
    assert.equal('giftBalance' in out.balance, false)
    assert.equal(out.balance.currency, 'CNY')
  })

  await check('describe/verify 0 额外请求', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const n = sc.seen.length
    p.describe(); p.describe(); p.verifyIdentity()
    assert.equal(sc.seen.length, n)
  })

  await check('platform userId ≠ expected：不 verified、无 balance', async () => {
    const sc = scenario({ ssoCallbackCookies: ['api-platform_serviceToken=PT; Path=/; Secure', 'userId=999; Path=/; Secure'] })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_IDENTITY_MISMATCH', '身份冲突')
    assert.equal(p.describe().state, 'new')
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/balance')).length, 0)
  })

  await check('缺 passToken：AUTH_REQUIRED 且不发 callback', async () => {
    const sc = scenario({ lpBody: JSON.stringify({ location: CB, userId: '777' }) })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_AUTH_RESULT_SEED_MISSING', '缺seed')
    assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 0)
  })

  await check('可信账号响应的父域 Cookie 可窄化接收，未增加登录跳数或余额请求', async () => {
    const sc = scenario({ lpHeaderCookies: [
      'cUserId=888; Domain=.xiaomi.com; Path=/; Secure; HttpOnly',
      'passInfo=login-end; Domain=.xiaomi.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.equal(p.verifyIdentity().identifier, '777')
    assert.equal(sc.seen.length, 5)
    assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 1)
    assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 0)
    assert.equal(JSON.stringify(p.describe()).includes('login-end'), false)
    p.dispose()
  })

  await check('父域账号态经 SSO 仅发送四个必要名称，不串到平台', async () => {
    const sc = scenario({ balanceSeq: [403, 200], lpHeaderCookies: [
      'passToken=SEED-TOKEN; Domain=.xiaomi.com; Path=/; Secure; HttpOnly',
      'userId=777; Domain=.xiaomi.com; Path=/; Secure',
      'cUserId=888; Domain=.xiaomi.com; Path=/; Secure',
      'deviceId=DEVICE; Domain=.xiaomi.com; Path=/; Secure',
      'passInfo=login-end; Domain=.xiaomi.com; Path=/; Secure',
      'irrelevant=IGNORED; Domain=.xiaomi.com; Path=/; Secure',
    ], ssoAccountCookies: [
      'cUserId=888; Domain=.xiaomi.com; Path=/; Secure',
      'passInfo=login-end; Domain=.xiaomi.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const n = sc.seen.length
    await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length - n, 5)
    const account = sc.cookies.filter(x => x.url.includes('/pass/serviceLogin'))
    assert.equal(account.length, 1)
    const names = account[0].headers.cookie.split(';').map(x => x.trim().split('=')[0]).sort()
    assert.deepEqual(names, ['cUserId', 'deviceId', 'passToken', 'userId'])
    for (const x of sc.cookies.filter(x => x.url.startsWith('https://platform.'))) {
      assert.equal((x.headers.cookie || '').includes('passToken'), false)
      assert.equal((x.headers.cookie || '').includes('cUserId'), false)
      assert.equal((x.headers.cookie || '').includes('passInfo'), false)
    }
    for (const x of sc.cookies.filter(x => x.url === LP || x.url === QR)) assert.equal(x.headers.cookie, undefined)
    p.dispose()
  })

  await check('外部/公共后缀/兄弟域 Cookie 仍拒，无 callback', async () => {
    for (const domain of ['.com', '.evil.example', '.xiaomi.com.evil.example', '.other.xiaomi.com', '.platform.xiaomimimo.com']) {
      const sc = scenario({ lpHeaderCookies: ['cUserId=888; Domain=' + domain + '; Path=/; Secure'] })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_LP_COOKIE_DOMAIN')
      assert.equal(sc.seen.length, 4)
      assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 0)
      p.dispose()
    }
  })

  await check('父域凭据与 JSON 冲突仍拒，不接受重复 Domain', async () => {
    for (const [cookie, code] of [
      ['userId=999; Domain=.xiaomi.com; Path=/; Secure', 'E_MIMO_CONSOLE_LP_SEED_CONFLICT'],
      ['userId=999; Domain=.xiaomi.com; Path=/pass; Secure', 'E_MIMO_CONSOLE_LP_SEED_CONFLICT'],
      ['passToken=OTHER; Domain=.xiaomi.com; Path=/pass; Secure', 'E_MIMO_CONSOLE_LP_SEED_CONFLICT'],
      ['cUserId=OTHER; Domain=.xiaomi.com; Path=/; Secure', 'E_MIMO_CONSOLE_LP_SEED_CONFLICT'],
      ['cUserId=888; Domain=.xiaomi.com; Domain=account.xiaomi.com; Path=/; Secure', 'E_MIMO_CONSOLE_LP_COOKIE_DUP_DOMAIN'],
    ]) {
      const sc = scenario({ lpHeaderCookies: [cookie] })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), code)
      assert.equal(sc.seen.length, 4)
      p.dispose()
    }
  })

  await check('父域明确撤销不得被 JSON seed 复活', async () => {
    for (const cookie of [
      'passToken=SEED-TOKEN; Domain=.xiaomi.com; Path=/; Max-Age=0; Secure',
      'userId=777; Domain=.xiaomi.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure',
    ]) {
      const sc = scenario({ lpHeaderCookies: [cookie] })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING')
      assert.equal(sc.seen.length, 4)
      p.dispose()
    }
  })

  await check('账号响应保留 Path 和过期：到期 passToken 不被 JSON 重置', async () => {
    let clock = Date.now()
    const sc = scenario({ balanceSeq: [403], lpHeaderCookies: [
      'passToken=SEED-TOKEN; Domain=.xiaomi.com; Path=/; Max-Age=1; Secure',
      'deviceId=ONLY-OTHER-PATH; Domain=.xiaomi.com; Path=/not-sso; Secure',
    ] })
    const { p } = mkProtocol(sc, { now: () => clock, transportDeps: {
      clock: () => clock, resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl,
    } })
    await p.login({ deadlineAt: clock + 30000 })
    clock += 2000
    const n = sc.seen.length
    await expectCode(() => p.readBalance({ deadlineAt: clock + 10000 }), 'E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING')
    assert.equal(sc.seen.length - n, 3)
    const sso = sc.cookies.filter(x => x.url.includes('/pass/serviceLogin'))
    assert.equal(sso.length, 1)
    assert.equal((sso[0].headers.cookie || '').includes('passToken='), false)
    assert.equal((sso[0].headers.cookie || '').includes('deviceId='), false)
    assert.throws(() => p.verifyIdentity())
    p.dispose()
  })

  await check('无关 Cookie 不参与认证解析、不存储、不发送、也不阻断正确登录', async () => {
    const sc = scenario({ lpHeaderCookies: [
      'unrelated=WITH SPACE; Path=/; Secure',
      'passInfo="UI VALUE"; Domain=.xiaomi.com; Path=/; Secure',
    ], balanceSeq: [403, 200] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 5)
    await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 10)
    assert.equal(sc.cookies.some(x => (x.headers.cookie || '').includes('unrelated')), false)
    assert.equal(sc.cookies.some(x => (x.headers.cookie || '').includes('passInfo')), false)
    assert.equal(JSON.stringify(p.describe()).includes('UI VALUE'), false)
    p.dispose()
  })

  await check('必要凭据仍严格拒绝，并以固定枚举区分每类策略', async () => {
    const cases = [
      [['passToken=WITH SPACE; Path=/; Secure'], 'VALUE_FORMAT'],
      [['cUserId="8 88"; Domain=.xiaomi.com; Path=/; Secure'], 'VALUE_FORMAT'],
      [['passToken=BAD\r\nVALUE; Path=/; Secure'], 'CRLF'],
      [['passToken=' + 'A'.repeat(4100) + '; Path=/; Secure'], 'TOO_LARGE'],
      [['passToken=SEED-TOKEN; Domain=.xiaomi.com; Max-Age=invalid; Path=/; Secure'], 'EXPIRY_FORMAT'],
      [['passToken; Path=/; Secure'], 'BAD_NAME'],
      [['cUserId=888; Domain=.xiaomi.com; Path=/; Secure', 'cUserId=OTHER; Domain=.xiaomi.com; Path=/pass; Secure'], 'DUP_VALUE'],
      [Array(65).fill('unrelated=ignored; Path=/; Secure'), 'COUNT_LIMIT'],
    ]
    for (const [lpHeaderCookies, reason] of cases) {
      const sc = scenario({ lpHeaderCookies })
      const { p } = mkProtocol(sc)
      const err = await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_LP_COOKIE_' + reason)
      assert.equal(err.message, err.code)
      assert.deepEqual(Object.keys(err), ['code'])
      assert.equal(sc.seen.length, 4)
      assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 0)
      assert.throws(() => p.verifyIdentity())
      p.dispose()
    }
  })

  await check('账号 SSO 入口同样忽略无关 Cookie，但拒绝必要凭据非法值', async () => {
    const sc = scenario({ balanceSeq: [403, 200], ssoAccountCookies: [
      'passInfo="UNRELATED PREFERENCE"; Domain=.xiaomi.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 10)
    assert.equal(sc.cookies.some(x => (x.headers.cookie || '').includes('passInfo')), false)
    sc.state.balanceSeq = [403]
    sc.state.ssoAccountCookies = ['passToken=BAD VALUE; Domain=.xiaomi.com; Path=/; Secure']
    const n = sc.seen.length
    await expectCode(() => p.readBalance({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_ACCOUNT_COOKIE_VALUE_FORMAT')
    assert.equal(sc.seen.length - n, 3)
    assert.throws(() => p.verifyIdentity())
    p.dispose()
  })

  await check('LP challenge 与未知跳转分支可区分、不跟随新目标', async () => {
    for (const [body, code] of [
      [{ challenge: 'CHALLENGE-SENTINEL' }, 'E_MIMO_CONSOLE_LP_CHALLENGE'],
      [{ location: 'https://account.xiaomi.com/pass/not-supported?ticket=SENTINEL', passToken: 'SEED-TOKEN', userId: '777' }, 'E_MIMO_CONSOLE_LP_TARGET_UNSUPPORTED'],
    ]) {
      const sc = scenario({ lpBody: JSON.stringify(body) })
      const { p } = mkProtocol(sc)
      const err = await expectCode(() => p.login({ deadlineAt: DL() }), code)
      assert.equal(err.message, code)
      assert.equal(sc.seen.length, 4)
      assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 0)
      p.dispose()
    }
  })

  await check('平台父域凭据合法窄化：登录及 fresh SSO 换票均不增加跳数', async () => {
    const sc = scenario({ balanceSeq: [403, 200], ssoCallbackCookies: [
      'api-platform_serviceToken=PT; Domain=.xiaomimimo.com; Path=/; Secure; HttpOnly',
      'userId=777; Domain=.xiaomimimo.com; Path=/; Secure',
      'api-platform_slh=SLH; Domain=.xiaomimimo.com; Path=/; Secure',
      'api-platform_ph=PH; Domain=.xiaomimimo.com; Path=/; Secure',
      'other=IGNORED VALUE; Domain=.xiaomimimo.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 5)
    assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 0)
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.equal(out.balance.balance, 13.5)
    assert.equal(sc.seen.length, 10)
    assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 2)
    for (const x of sc.cookies.filter(x => x.url.includes('/api/v1/balance'))) {
      assert.deepEqual(x.headers.cookie.split(';').map(x => x.trim().split('=')[0]).sort(),
        ['api-platform_ph', 'api-platform_serviceToken', 'api-platform_slh', 'userId'])
    }
    assert.equal(sc.cookies.some(x => (x.headers.cookie || '').includes('other=')), false)
    p.dispose()
  })

  await check('平台必要名外域/账号域/公共后缀仍拒，callback 后不读余额', async () => {
    for (const domain of ['.com', '.evil.example', '.xiaomi.com', '.other.xiaomimimo.com', '.xiaomimimo.com.evil.example']) {
      const sc = scenario({ ssoCallbackCookies: [
        'api-platform_serviceToken=PT; Domain=' + domain + '; Path=/; Secure', 'userId=777; Path=/; Secure',
      ] })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_PLATFORM_COOKIE_DOMAIN')
      assert.equal(sc.seen.length, 5)
      assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 0)
      assert.throws(() => p.verifyIdentity())
      p.dispose()
    }
  })

  await check('标准引号平台凭据：按内容核对身份，发出的原值仍保留引号', async () => {
    const sc = scenario({ balanceSeq: [403, 200], ssoCallbackCookies: [
      'api-platform_serviceToken="PT+/="; Domain=.xiaomimimo.com; Path=/; Secure; HttpOnly',
      'userId="777"; Domain=.xiaomimimo.com; Path=/; Secure',
      'api-platform_slh="SLH+/="; Domain=.xiaomimimo.com; Path=/; Secure',
      'api-platform_ph="PH+/="; Domain=.xiaomimimo.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
    assert.equal(sc.seen.length, 5)
    await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 10)
    for (const request of sc.cookies.filter(x => x.url.includes('/api/v1/balance'))) {
      assert.ok(request.headers.cookie.includes('api-platform_serviceToken="PT+/="'))
      assert.ok(request.headers.cookie.includes('userId="777"'))
      assert.ok(request.headers.cookie.includes('api-platform_ph="PH+/="'))
      assert.equal(request.headers.cookie.includes('passToken='), false)
    }
    p.dispose()
  })

  await check('账号引号凭据与 JSON 按内容核对，账号请求保留原引号', async () => {
    const sc = scenario({ balanceSeq: [403, 200], lpHeaderCookies: [
      'passToken="SEED-TOKEN"; Domain=.xiaomi.com; Path=/; Secure',
      'userId="777"; Domain=.xiaomi.com; Path=/; Secure',
      'cUserId="888"; Domain=.xiaomi.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 10)
    const sso = sc.cookies.filter(x => x.url.includes('/pass/serviceLogin'))
    assert.equal(sso.length, 1)
    assert.ok(sso[0].headers.cookie.includes('passToken="SEED-TOKEN"'))
    assert.ok(sso[0].headers.cookie.includes('userId="777"'))
    assert.ok(sso[0].headers.cookie.includes('cUserId="888"'))
    p.dispose()
  })

  await check('引号不包容非法内容或损坏格式，也不能绕过身份比较', async () => {
    for (const value of ['"BAD VALUE"', '"BAD,VALUE"', '"BAD\\VALUE"', '"BAD', 'BAD"', '"BAD"VALUE"', '"BAD\tVALUE"', '"BAD\r\nVALUE"']) {
      const sc = scenario({ ssoCallbackCookies: [
        'api-platform_serviceToken=' + value + '; Domain=.xiaomimimo.com; Path=/; Secure',
        'userId="777"; Domain=.xiaomimimo.com; Path=/; Secure',
      ] })
      const { p } = mkProtocol(sc)
      const expected = value.includes('\r') || value.includes('\n') ? 'E_MIMO_CONSOLE_PLATFORM_COOKIE_CRLF' : 'E_MIMO_CONSOLE_PLATFORM_COOKIE_VALUE_FORMAT'
      await expectCode(() => p.login({ deadlineAt: DL() }), expected)
      assert.equal(sc.seen.length, 5)
      assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 0)
      assert.throws(() => p.verifyIdentity())
      p.dispose()
    }
    const sc = scenario({ ssoCallbackCookies: [
      'api-platform_serviceToken="PT"; Domain=.xiaomimimo.com; Path=/; Secure',
      'userId="999"; Domain=.xiaomimimo.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_IDENTITY_MISMATCH')
    assert.equal(sc.seen.length, 5)
    p.dispose()
  })

  await check('平台必要凭据非法字节/重复/过期属性均固定码终止', async () => {
    for (const [cookies, reason] of [
      [['api-platform_serviceToken=BAD VALUE; Domain=.xiaomimimo.com; Path=/; Secure'], 'VALUE_FORMAT'],
      [['api-platform_serviceToken=PT; Domain=.xiaomimimo.com; Max-Age=bad; Path=/; Secure'], 'EXPIRY_FORMAT'],
      [['api-platform_serviceToken=PT; Domain=.xiaomimimo.com; Domain=platform.xiaomimimo.com; Path=/; Secure'], 'DUP_DOMAIN'],
      [['api-platform_serviceToken=PT; Domain=.xiaomimimo.com; Path=/; Secure', 'api-platform_serviceToken=OTHER; Path=/; Secure'], 'DUP_VALUE'],
    ]) {
      const sc = scenario({ ssoCallbackCookies: [...cookies, 'userId=777; Path=/; Secure'] })
      const { p } = mkProtocol(sc)
      const err = await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_PLATFORM_COOKIE_' + reason)
      assert.equal(err.message, err.code)
      assert.equal(sc.seen.length, 5)
      assert.throws(() => p.verifyIdentity())
      p.dispose()
    }
  })

  await check('平台父域凭据删除不复活，父域变号不通过身份核对', async () => {
    for (const [cookies, code] of [
      [['api-platform_serviceToken=PT; Domain=.xiaomimimo.com; Path=/; Max-Age=0; Secure', 'userId=777; Path=/; Secure'], 'E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING'],
      [['api-platform_serviceToken=PT; Domain=.xiaomimimo.com; Path=/; Secure', 'userId=999; Domain=.xiaomimimo.com; Path=/; Secure'], 'E_MIMO_CONSOLE_IDENTITY_MISMATCH'],
    ]) {
      const sc = scenario({ ssoCallbackCookies: cookies })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), code)
      assert.equal(sc.seen.length, 5)
      assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 0)
      p.dispose()
    }
  })

  await check('余额响应续发父域平台票只在平台生效，并保留 Path 限制', async () => {
    const sc = scenario({ balanceHeaderCookies: [
      'api-platform_serviceToken=ROTATED; Domain=.xiaomimimo.com; Path=/; Secure',
      'api-platform_ph=PATH-ONLY; Domain=.xiaomimimo.com; Path=/not-balance; Secure',
      'preference=UNRELATED VALUE; Domain=.xiaomimimo.com; Path=/; Secure',
    ] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    await p.readBalance({ deadlineAt: DL() })
    sc.state.balanceHeaderCookies = null
    await p.readBalance({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 7)
    const balance = sc.cookies.filter(x => x.url.includes('/api/v1/balance'))
    assert.equal(balance.length, 2)
    assert.ok(balance[1].headers.cookie.includes('api-platform_serviceToken=ROTATED'))
    assert.equal(balance[1].headers.cookie.includes('api-platform_ph='), false)
    assert.equal(balance[1].headers.cookie.includes('preference='), false)
    assert.equal(balance[1].headers.cookie.includes('passToken='), false)
    p.dispose()
  })

  await check('既有 MiMo 字符串金额响应应解析成数字，不补币种或缺项', async () => {
    const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data: {
      balance: '16.48', cashBalance: '16.48', giftBalance: '0.00', currency: 'CNY',
    } }) })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.equal(sc.seen.length, 5)
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.deepEqual(out.balance, { balance: 16.48, cashBalance: 16.48, giftBalance: 0, currency: 'CNY' })
    assert.equal(sc.seen.length, 6)
    assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 1)
    p.dispose()
  })

  await check('字符串 0 也是有效余额，明细缺失保持缺失，币种按真实字段归一化', async () => {
    const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data: { balance: '0.00', currency: ' usd ' } }) })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.deepEqual(out.balance, { balance: 0, currency: 'USD' })
    assert.equal(Object.hasOwn(out.balance, 'cashBalance'), false)
    assert.equal(Object.hasOwn(out.balance, 'giftBalance'), false)
    assert.equal(sc.seen.length, 6)
    p.dispose()
  })

  await check('字符串金额不接受隐式类型/空白/指数/非十进制或缺少总余额', async () => {
    for (const balance of [null, true, false, [], {}, '', ' ', ' 1.00', '1.00 ', '1e2', '0x10', 'Infinity', 'NaN', '-1', '+1', '.5', '01.00', '1,000.00', '9'.repeat(65)]) {
      const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data: { balance, cashBalance: '8.00', currency: 'CNY' } }) })
      const { p } = mkProtocol(sc)
      await p.login({ deadlineAt: DL() })
      await expectCode(() => p.readBalance({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_BALANCE_PARSE')
      assert.equal(sc.seen.length, 6)
      assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 1)
      /**
       * [freshness 2026-11-10] 纯解析失败**不再**清凭据：认证仍有效（verified），
       * 下一次读可自动恢复。旧断言「verifyIdentity 必抛」编码的正是本轮要修的缺陷
       * （BALANCE_PARSE 清 Jar ⇒ 之后每次读永久 NOT_VERIFIED），此处改为新需求预期。
       */
      assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
      assert.equal(p.describe().state, 'verified')
      p.dispose()
    }
    for (const data of [{ cashBalance: '8.00', currency: 'CNY' }, { totalBalance: '8.00', currency: 'CNY' }]) {
      const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data }) })
      const { p } = mkProtocol(sc)
      await p.login({ deadlineAt: DL() })
      await expectCode(() => p.readBalance({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_BALANCE_PARSE')
      assert.equal(sc.seen.length, 6)
      p.dispose()
    }
  })

  await check('有效总余额不将非法明细转换成零，也不从额外字段取数', async () => {
    const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data: {
      balance: '2.50', currency: 'CNY', cashBalance: true, giftBalance: '',
      totalBalance: '999.00', tokenPlan: { balance: '999.00' },
    } }) })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.deepEqual(out.balance, { balance: 2.5, currency: 'CNY' })
    p.dispose()
  })

  await check('缺 currency：BALANCE_PARSE（不默认）', async () => {
    const sc = scenario({ balanceBody: JSON.stringify({ code: 0, data: { balance: '3.00' } }) })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    await expectCode(() => p.readBalance({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_BALANCE_PARSE', '缺币种')
  })

  await check('403→200：login 后恰好 +5 请求，且两域 Cookie 不混', async () => {
    const sc = scenario({ balanceSeq: [403, 200] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const before = sc.seen.length
    let captured = []
    const impl2 = sc.impl
    const out = await p.readBalance({ deadlineAt: DL() })
    const after = sc.seen.length
    assert.equal(after - before, 5, '应 +5（balance403 + ctx + sso + callback + balance200），实际 ' + (after - before) + ' :: ' + sc.seen.slice(before).join('|'))
    assert.equal(out.balance.balance, 13.5)
    void captured; void impl2
  })

  await check('403→403：终止且无第 3 个 balance', async () => {
    const sc = scenario({ balanceSeq: [403, 403] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const before = sc.seen.length
    const err = await p.readBalance({ deadlineAt: DL() }).then(() => null, (e) => e)
    assert.equal(err && err.code, 'E_MIMO_AUTH_REJECTED')
    const tail = sc.seen.slice(before)
    assert.equal(tail.filter((u) => u.includes('/api/v1/balance')).length, 2, '只允许两次 balance')
    assert.equal(tail.filter((u) => u.includes('/pass/serviceLogin')).length, 1, '只允许一轮 SSO')
  })

  await check('regional lp 无 approveTarget：AUTH_REQUIRED 且不发 lp', async () => {
    const sc = scenario({ qrBody: JSON.stringify({ qr: QR, lp: 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1' }) })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_AUTH_REQUIRED', '缺approve')
    assert.equal(sc.seen.filter((u) => u.includes('reg.account') && !u.includes('qs=')).length, 0)
  })

  await check('重复 passToken key：拒（UNSUPPORTED）', async () => {
    const sc = scenario({ lpBody: '{"location":"' + CB + '","passToken":"A","passToken":"B","userId":"777"}' })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_JSON_UNSUPPORTED', '重复key')
  })

  await check('未同意 authResult 用途：0 请求', async () => {
    const sc = scenario()
    const { p, live } = mkProtocol(sc)
    live.authResult = false
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_AUTH_REQUIRED', '未同意')
    assert.equal(sc.seen.length, 0)
  })

  await check('dispose 后 verify/read 拒、状态 stopped', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    p.dispose()
    assert.throws(() => p.verifyIdentity(), (e) => e.code === 'E_MIMO_AUTH_TARGET_EXPIRED' || e.code === 'E_MIMO_CONSOLE_NOT_VERIFIED')
    await expectCode(() => p.readBalance({ deadlineAt: DL() }), 'E_MIMO_AUTH_TARGET_EXPIRED', 'dispose后读')
    assert.equal(p.describe().state, 'stopped')
  })

  // ===== A3-C 凭据组新增用例 =====
  await check('numeric userId：安全正整数归一化，仍核对平台与预期身份', async () => {
    const sc = scenario({ lpBody: JSON.stringify({ location: CB, passToken: 'SEED-TOKEN', userId: 777 }) })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
    assert.equal(sc.seen.length, 5)
    assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 1)
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/balance')).length, 0)
    p.dispose()
  })

  await check('非法账号 ID 类型/非安全整数：拒且 callback 0', async () => {
    for (const value of [null, true, false, 0, -1, 1.5, 9007199254740992, [], {}]) {
      const sc = scenario({ lpBody: JSON.stringify({ location: CB, passToken: 'SEED-TOKEN', userId: value }) })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_AUTH_RESULT_ID_INVALID')
      assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 0)
      p.dispose()
    }
  })

  await check('数值账号 ID 不接受被浮点舍入的分数或指数写法', async () => {
    for (const raw of ['777.000000000000000001', '7.77e2', '9007199254740993']) {
      const sc = scenario({ lpBody: '{"location":"' + CB + '","passToken":"SEED-TOKEN","userId":' + raw + '}' })
      const { p } = mkProtocol(sc)
      await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_AUTH_RESULT_ID_INVALID')
      assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 0)
      p.dispose()
    }
  })

  await check('数值 ID 与同值 header 兼容，seed 仍只用真实响应', async () => {
    const sc = scenario({
      lpBody: JSON.stringify({ location: CB, passToken: 'SEED-TOKEN', userId: 777 }),
      lpHeaderCookies: ['userId=777; Path=/; Secure', 'passToken=SEED-TOKEN; Path=/; Secure'],
    })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    assert.equal(p.verifyIdentity().identifier, '777')
    assert.equal(sc.seen.length, 5)
    p.dispose()
  })

  await check('数值账号不绕过平台身份核对：变号仍拒、余额 0', async () => {
    const sc = scenario({
      lpBody: JSON.stringify({ location: CB, passToken: 'SEED-TOKEN', userId: 777 }),
      ssoCallbackCookies: ['api-platform_serviceToken=PT; Path=/; Secure', 'userId=999; Path=/; Secure'],
    })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_IDENTITY_MISMATCH')
    assert.equal(sc.seen.length, 5)
    assert.equal(sc.seen.filter(u => u.includes('/api/v1/balance')).length, 0)
    assert.throws(() => p.verifyIdentity())
    p.dispose()
  })

  await check('区域 LP host-only cookie 与数值 JSON 冲突仍拒', async () => {
    const regional = 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1'
    const sc = scenario({
      qrBody: JSON.stringify({ qr: QR, lp: regional }),
      lpBody: JSON.stringify({ location: CB, passToken: 'SEED-TOKEN', userId: 777 }),
      lpHeaderCookies: ['userId=888; Path=/; Secure'],
    })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL(), approveTarget: async () => true }), 'E_MIMO_CONSOLE_LP_SEED_CONFLICT')
    assert.equal(sc.seen.filter(u => u === regional).length, 1)
    assert.equal(sc.seen.filter(u => u.includes('/sts')).length, 0)
    p.dispose()
  })

  await check('LP header 与 JSON userId 冲突：拒且 callback 0', async () => {
    const sc = scenario({ lpHeaderCookies: ['userId=888; Path=/; Secure', 'passToken=SEED-TOKEN; Path=/; Secure'] })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_LP_SEED_CONFLICT', 'seed 冲突')
    assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 0, 'callback 必须 0')
  })

  await check('regional 批准 1 次 → login → 403/200 换票（+5 hop，Cookie 不串域）', async () => {
    const regLp = 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1'
    const sc = scenario({
      qrBody: JSON.stringify({ qr: QR, lp: regLp }),
      lpBody: JSON.stringify({
        location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB),
        passToken: 'SEED-TOKEN', userId: '777'
      }),
      balanceSeq: [403, 200]
    })
    const { p } = mkProtocol(sc)
    let approveCalls = 0
    await p.login({
      deadlineAt: DL(),
      approveTarget: (info) => { approveCalls += 1; assert.equal(info.origin, 'reg.account.xiaomi.com'); return true }
    })
    assert.equal(approveCalls, 1)
    const before = sc.seen.length
    const out = await p.readBalance({ deadlineAt: DL() })
    const hops = sc.seen.slice(before)
    assert.equal(hops.length, 5, 'hop=' + hops.join('|'))
    assert.equal(out.balance.balance, 13.5)
    const accountReq = sc.cookies.filter((c) => c.url.includes('/pass/serviceLogin')).pop()
    assert.ok(accountReq.headers.cookie && accountReq.headers.cookie.includes('passToken='), '账号请求应带 passToken')
    assert.equal(accountReq.headers.cookie.includes('api-platform_'), false, '账号请求不得带平台票')
    const platformReq = sc.cookies.filter((c) => c.url.includes('/api/v1/balance')).pop()
    assert.equal(String(platformReq.headers.cookie || '').includes('passToken'), false, '平台请求不得带 account seed')
  })

  await check('SSO 账号 userId 变号：第二次平台 callback 前拒、余额重试 0', async () => {
    const sc = scenario({
      lpBody: JSON.stringify({
        location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB),
        passToken: 'SEED-TOKEN', userId: '777'
      }),
      ssoAccountCookies: ['passToken=SEED-TOKEN; Path=/; Secure', 'userId=999; Path=/; Secure'],
      balanceSeq: [403, 200]
    })
    const { p } = mkProtocol(sc)
    const err = await p.login({ deadlineAt: DL() }).then(() => null, (e) => e)
    assert.equal(err && err.code, 'E_MIMO_CONSOLE_IDENTITY_MISMATCH')
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/balance')).length, 0, 'balance 必须 0')
  })

  await check('SSO callback 缺新平台票：拒且旧票不顶替、verify 拒', async () => {
    const sc = scenario({
      lpBody: JSON.stringify({
        location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB),
        passToken: 'SEED-TOKEN', userId: '777'
      }),
      ssoCallbackCookies: ['userId=777; Path=/; Secure']
    })
    const { p } = mkProtocol(sc)
    await expectCode(() => p.login({ deadlineAt: DL() }), 'E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING', '缺新票')
    assert.throws(() => p.verifyIdentity())
    assert.equal(p.describe().state, 'new')
  })

  // ===== A3-D 预算/取消用例 =====
  await check('onQr 永挂：绝对 deadline 到点 EXPIRED，LP/callback 0', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    const watchdog = setTimeout(() => {}, 300)
    try {
      const err = await p.login({ deadlineAt: Date.now() + 40, onQr: () => new Promise(() => {}) })
        .then(() => null, (e) => e)
      assert.equal(err && err.code, 'E_MIMO_AUTH_TARGET_EXPIRED')
      assert.equal(sc.seen.filter((u) => u.includes('/longPolling/loginUrl') && !u.includes('qs=')).length, 0, 'LP 必须 0')
      assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 0, 'callback 必须 0')
    } finally { clearTimeout(watchdog) }
  })

  await check('already-aborted：0 DNS / 0 请求', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    const ctrl = new AbortController()
    ctrl.abort()
    const err = await p.login({ deadlineAt: Date.now() + 5000, signal: ctrl.signal }).then(() => null, (e) => e)
    assert.equal(err && err.code, 'E_MIMO_AUTH_CANCELLED')
    assert.equal(sc.seen.length, 0)
  })

  await check('LP 挂起后 external abort：CANCELLED 且迟到 LP 不 callback', async () => {
    const sc = scenario({ hangLp: true })
    const { p } = mkProtocol(sc)
    const ctrl = new AbortController()
    const watchdog = setTimeout(() => {}, 300)
    try {
      const pr = p.login({ deadlineAt: Date.now() + 400, signal: ctrl.signal })
      await new Promise((r) => setTimeout(r, 60))
      ctrl.abort()
      const err = await pr.then(() => null, (e) => e)
      assert.equal(err && err.code, 'E_MIMO_AUTH_CANCELLED')
      sc.state.hangLp = false   // 放行迟到响应
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 0, '迟到后不得 callback')
      assert.throws(() => p.verifyIdentity())
    } finally { clearTimeout(watchdog) }
  })

  await check('regional approval 挂死：deadline 结束且 LP 0', async () => {
    const sc = scenario({ qrBody: JSON.stringify({ qr: QR, lp: 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1' }) })
    const { p } = mkProtocol(sc)
    const watchdog = setTimeout(() => {}, 300)
    try {
      const err = await p.login({ deadlineAt: Date.now() + 40, approveTarget: () => new Promise(() => {}) })
        .then(() => null, (e) => e)
      assert.equal(err && err.code, 'E_MIMO_AUTH_TARGET_EXPIRED')
      assert.equal(sc.seen.filter((u) => u.includes('reg.account')).length, 0, 'LP 必须 0')
    } finally { clearTimeout(watchdog) }
  })

  await check('balance 挂死：读操作自身 deadline 到点 EXPIRED，但凭据保留、下一读恢复', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    sc.state.hangBalance = true
    const watchdog = setTimeout(() => {}, 300)
    try {
      const err = await p.readBalance({ deadlineAt: Date.now() + 40 }).then(() => null, (e) => e)
      assert.equal(err && err.code, 'E_MIMO_AUTH_TARGET_EXPIRED')
      /**
       * [freshness 2026-11-10] 读操作**自身** budget 到点 ≠ 认证/绑定失效：
       * 旧断言要求 verify 拒 + state 'new'（清 Jar），导致一次慢读把整个记住登录读死。
       * 新需求：owner 仍 live ⇒ 保留 verified，后续读自动恢复（不新增 HTTP 重试）。
       */
      assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
      assert.equal(p.describe().state, 'verified')
      sc.state.hangBalance = false
      const out = await p.readBalance({ deadlineAt: DL() })
      assert.equal(out.balance.balance, 13.5, '凭据未丢：下一读自动恢复')
    } finally { clearTimeout(watchdog) }
  })

  await check('balance 500：TRANSIENT 保留 verified，下次读成功且无额外 SSO', async () => {
    const sc = scenario({ balanceSeq: [500, 200] })
    const { p } = mkProtocol(sc)
    await p.login({ deadlineAt: DL() })
    const err = await p.readBalance({ deadlineAt: DL() }).then(() => null, (e) => e)
    assert.equal(err && err.code, 'E_MIMO_CONSOLE_TRANSIENT')
    assert.equal(p.describe().state, 'verified')
    assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
    const before = sc.seen.length
    const out = await p.readBalance({ deadlineAt: DL() })
    assert.equal(out.balance.balance, 13.5)
    const tail = sc.seen.slice(before)
    assert.equal(tail.filter((u) => u.includes('/pass/serviceLogin')).length, 0, '不应再走 SSO')
    assert.equal(tail.filter((u) => u.includes('/api/v1/balance')).length, 1, '恰好一次余额请求')
  })

  // ===== D 剩余：op 归属 / 有界多轮 LP / 桥接清理 =====
  await check('deadline 后才 resolve onQr：不再 LP、不 verified', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    let release = null
    const gate = new Promise((r) => { release = r })
    const pr = p.login({ deadlineAt: Date.now() + 40, onQr: () => gate }).then(() => null, (e) => e)
    await new Promise((r) => setTimeout(r, 90))
    release()   // 整体已到期之后才「扫码完成」
    const err = await pr
    assert.equal(err && err.code, 'E_MIMO_AUTH_TARGET_EXPIRED')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sc.seen.filter((u) => u.includes('/longPolling/loginUrl') && !u.includes('qs=')).length, 0, 'LP 必须 0')
    assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 0, 'callback 必须 0')
    assert.throws(() => p.verifyIdentity())
    assert.equal(p.describe().state, 'new')
  })

  await check('deadline 后才 resolve regional approval：不再 LP、不 verified', async () => {
    const sc = scenario({ qrBody: JSON.stringify({ qr: QR, lp: 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1' }) })
    const { p } = mkProtocol(sc)
    let release = null
    const gate = new Promise((r) => { release = r })
    let approveCalls = 0
    const pr = p.login({
      deadlineAt: Date.now() + 40,
      approveTarget: () => { approveCalls += 1; return gate }
    }).then(() => null, (e) => e)
    await new Promise((r) => setTimeout(r, 90))
    release()
    const err = await pr
    assert.equal(err && err.code, 'E_MIMO_AUTH_TARGET_EXPIRED')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(approveCalls, 1, '批准只被请求一次（不重开 approval）')
    assert.equal(sc.seen.filter((u) => u.includes('reg.account')).length, 0, 'regional LP 必须 0')
    assert.throws(() => p.verifyIdentity())
  })

  await check('AbortSignal.any 缺失：外部 signal 桥 add/remove 成对且只一条', async () => {
    const sc = scenario()
    const { p } = mkProtocol(sc)
    let adds = 0
    let removes = 0
    const ext = {
      aborted: false,
      addEventListener() { adds += 1 },
      removeEventListener() { removes += 1 },
    }
    const saved = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true })
    try {
      await p.login({ deadlineAt: DL(), signal: ext })
      assert.equal(p.describe().state, 'verified')
    } finally {
      if (saved) Object.defineProperty(AbortSignal, 'any', saved)
      else delete AbortSignal.any
    }
    assert.equal(adds, 1, '只挂一条 fallback 监听，实际 ' + adds)
    assert.equal(removes, adds, 'success 路径也必须 detach（adds=' + adds + ' removes=' + removes + '）')
  })

  await check('LP 单跳超时→同一已批准 LP 有界多轮（LP=2、其余各 1、无新 approval）', async () => {
    let fake = 1000000
    const clock = () => fake
    const regLp = 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1'
    const sc = scenario({ qrBody: JSON.stringify({ qr: QR, lp: regLp }) })
    let fired = false
    // 第一次 LP 在「回 headers 之前」把 fake clock 推进 35001 ms ⇒ 该跳超时，整体仍在期限内
    sc.state.hook = (url) => {
      if (fired || url !== regLp) return
      fired = true
      fake += 35001
    }
    const { p } = mkProtocol(sc, {
      now: clock,
      transportDeps: {
        clock,                                        // 与 protocol 是**同一个** fake clock
        resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
        request: sc.impl,
      },
    })
    let approveCalls = 0
    await p.login({
      deadlineAt: fake + 120000,
      approveTarget: (info) => { approveCalls += 1; assert.equal(info.origin, 'reg.account.xiaomi.com'); return true },
    })
    const lpCalls = sc.seen.filter((u) => u === regLp).length
    assert.equal(lpCalls, 2, 'LP 必须恰好 2 次，实际 ' + lpCalls + ' :: ' + sc.seen.join('|'))
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/genLoginUrl')).length, 1, 'ctx 只 1 次（不重开）')
    assert.equal(sc.seen.filter((u) => u.includes('/longPolling/loginUrl') && u.includes('qs=')).length, 1, 'QR init 只 1 次')
    assert.equal(sc.seen.filter((u) => u.includes('/longPolling/qrImage')).length, 1, 'QR 图只 1 次')
    assert.equal(approveCalls, 1, '不重开 approval')
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/balance')).length, 0, '登录不读余额')
    assert.deepEqual(p.verifyIdentity(), { namespace: 'xiaomi-account-user-id', identifier: '777' })
  })

  await check('多轮 LP 中整体 deadline 到点：不进入下一跳（0 第二次 LP）', async () => {
    let fake = 2000000
    const clock = () => fake
    const lp = LP
    const sc = scenario()
    let fired = false
    // 第一跳超时的同时，把 fake clock 推到**整体 deadline 之后**
    sc.state.hook = (url) => {
      if (fired || url !== lp) return
      fired = true
      fake += 40001
    }
    const { p } = mkProtocol(sc, {
      now: clock,
      transportDeps: { clock, resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
    })
    const err = await p.login({ deadlineAt: fake + 40000 }).then(() => null, (e) => e)
    assert.equal(err && err.code, 'E_MIMO_AUTH_TARGET_EXPIRED')
    assert.equal(sc.seen.filter((u) => u === lp).length, 1, '只允许第一跳，实际 ' + sc.seen.filter((u) => u === lp).length)
    assert.equal(sc.seen.filter((u) => u.includes('/sts')).length, 0, 'callback 必须 0')
    assert.throws(() => p.verifyIdentity())
  })

  console.log(pass + ' passed, ' + fails.length + ' failed')
  if (fails.length > 0) { for (const f of fails) console.log('FAIL ' + f); process.exitCode = 1 }
}

main()
