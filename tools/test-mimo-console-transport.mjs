/**
 * test-mimo-console-transport.mjs — A2：secure-transport 的 console 用途 + grant 校验（离线）
 * 假 resolver + 假 reqImpl（EventEmitter + 微任务 flush），**不真实 TLS、不出网、不读 profile**。
 * authority 按**实例闭包**传入（每例各自 mkAuthority → fakeTransport({ authority })），不使用任何全局。
 * 运行：node tools/test-mimo-console-transport.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSecureTransport } from '../plans/mimo-auth/secure-transport.js'
import {
  createConsoleGrantAuthority,
  deriveConsoleSsoUrl,
  deriveConsoleQrInitUrl,
  CONSOLE_PURPOSES as P,
  CONSOLE_CODES as C
} from '../plans/mimo-auth/console-grants.js'

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
const CONTEXT_LOCATION = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' +
  encodeURIComponent(CB) + '&_sign=DUMMYSIGN'
const CONTEXT_URL = (() => {
  const u = new URL('https://platform.xiaomimimo.com/api/v1/genLoginUrl')
  u.searchParams.set('currentPath', '/console/plan-manage')
  return u.toString()
})()
const BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance'
const SSO_URL = deriveConsoleSsoUrl(CONTEXT_LOCATION)
const QRINIT_URL = deriveConsoleQrInitUrl(CONTEXT_LOCATION)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const CALLBACK_URL = 'https://platform.xiaomimimo.com/sts?code=0'
const DUMMY_LOCATION = 'https://platform.xiaomimimo.com/sts?code=0&from=redirect'
const PUBLIC_IP = '93.184.216.34'

/** 假 reqImpl：EventEmitter；end() 后微任务 flush 假 response（body 用 getReader） */
function fakeTransport(opts = {}) {
  const authority = opts.authority || null
  const counts = { dns: 0, request: 0, bodyRead: 0, destroy: 0 }
  const captured = []
  const state = {
    invalidateOnFlush: false,
    authority,
    hang: false,
    status: 200,
    headers: {}
  }
  const reqImpl = (options, callback) => {
    counts.request += 1
    captured.push({ options, headersSnapshot: { ...(options.headers || {}) } })
    const ee = new EventEmitter()
    ee.destroy = () => { counts.destroy += 1 }
    ee.end = () => {
      if (state.hang) return
      queueMicrotask(() => {
        if (state.invalidateOnFlush && state.authority) state.authority.invalidate()
        callback({
          statusCode: state.status,
          status: state.status,
          headers: state.headers,
          complete: true,
          socket: { remoteAddress: PUBLIC_IP },
          body: {
            getReader() {
              let done = false
              return {
                read() {
                  counts.bodyRead += 1
                  if (done) return Promise.resolve({ done: true, value: undefined })
                  done = true
                  return Promise.resolve({ done: false, value: Uint8Array.from([123, 125]) })
                },
                releaseLock() {},
                cancel() { return Promise.resolve() }
              }
            }
          }
        })
      })
    }
    return ee
  }
  const deps = {
    clock: opts.clock || (() => Date.now()),
    resolver: async () => { counts.dns += 1; return [{ address: PUBLIC_IP, family: 4 }] },
    request: reqImpl,
    validateConsoleGrant: (grant, req) => {
      if (authority === null) {
        const err = new Error('E_MIMO_AUTH_TARGET_INVALID')
        err.code = 'E_MIMO_AUTH_TARGET_INVALID'
        throw err
      }
      return authority.validate(grant, req)
    },
    ...(opts.deps || {})
  }
  const transport = createSecureTransport(deps)
  return { transport, counts, captured, state, authority }
}

function mkAuthority(opts = {}) {
  const clock = opts.clock || (() => Date.now())
  const deadlineAt = opts.deadlineAt || (Date.now() + 60_000)
  const state = { live: true, balancePhase: true }
  const authority = createConsoleGrantAuthority({
    owner: {},
    bootEpoch: 'b1',
    generation: 1,
    deadlineAt,
    now: clock,
    isLive: (p) => state.live === true && (p === P.BALANCE ? state.balancePhase : true)
  })
  return { authority, state, deadlineAt }
}
const eff = (over) => ({ method: 'GET', deadlineAt: Date.now() + 5000, assertAuthorized: () => true, ...over })

async function main() {
  // ---------- A. 7 个用途：真实 createSecureTransport.fetch，dns===1 / request===1 ----------
  const seven = [
    {
      name: 'context（无 Cookie）',
      build: (a) => ({
        url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none',
        grant: a.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
      }),
      host: 'platform.xiaomimimo.com', path: '/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fplan-manage', cookie: undefined
    },
    {
      name: 'qrInit（无 Cookie，由 context 派生）',
      build: (a) => {
        const ctx = a.markSource('context', 'ctx-1', { location: CONTEXT_LOCATION })
        return { url: QRINIT_URL, purpose: P.QR_INIT, credentialClass: 'none', grant: a.issue({ url: QRINIT_URL, purpose: P.QR_INIT, credentialClass: 'none', sourceBinding: ctx }) }
      },
      host: 'account.xiaomi.com', path: new URL(QRINIT_URL).pathname + new URL(QRINIT_URL).search, cookie: undefined
    },
    {
      name: 'qrImage（无 Cookie）',
      build: (a) => {
        const q = a.markSource('qrInit', 'qr-1', { qr: QR, lp: LP })
        return { url: QR, purpose: P.QR_IMAGE, credentialClass: 'none', grant: a.issue({ url: QR, purpose: P.QR_IMAGE, credentialClass: 'none', sourceBinding: q }) }
      },
      host: 'account.xiaomi.com', path: '/longPolling/qrImage?k=1', cookie: undefined
    },
    {
      name: 'authResult（无 Cookie，独立 grant）',
      build: (a) => {
        const q = a.markSource('qrInit', 'qr-1', { qr: QR, lp: LP })
        return { url: LP, purpose: P.AUTH_RESULT, credentialClass: 'none', grant: a.issue({ url: LP, purpose: P.AUTH_RESULT, credentialClass: 'none', sourceBinding: q }) }
      },
      host: 'account.xiaomi.com', path: '/longPolling/loginUrl?k=1', cookie: undefined
    },
    {
      name: 'accountSso（account Cookie）',
      build: (a) => {
        const ctx = a.markSource('context', 'ctx-1', { location: CONTEXT_LOCATION })
        return { url: SSO_URL, purpose: P.ACCOUNT_SSO, credentialClass: 'account', grant: a.issue({ url: SSO_URL, purpose: P.ACCOUNT_SSO, credentialClass: 'account', sourceBinding: ctx }), headers: { cookie: 'passToken=abc; userId=42' } }
      },
      host: 'account.xiaomi.com', path: new URL(SSO_URL).pathname + new URL(SSO_URL).search, cookie: 'passToken=abc; userId=42'
    },
    {
      name: 'platformCallback（首次无 Cookie）',
      build: (a) => {
        const s = a.markSource('sso', 'sso-1', { location: CALLBACK_URL })
        return { url: CALLBACK_URL, purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', grant: a.issue({ url: CALLBACK_URL, purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', sourceBinding: s }) }
      },
      host: 'platform.xiaomimimo.com', path: '/sts?code=0', cookie: undefined
    },
    {
      name: 'balance（platform Cookie）',
      build: (a) => ({
        url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform',
        grant: a.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' }),
        headers: { cookie: 'api-platform_serviceToken=t; userId=42' }
      }),
      host: 'platform.xiaomimimo.com', path: '/api/v1/balance', cookie: 'api-platform_serviceToken=t; userId=42'
    }
  ]

  for (const c of seven) {
    await check('正向 request===1：' + c.name, async () => {
      const { authority } = mkAuthority()
      const { transport, counts, captured } = fakeTransport({ authority })
      const res = await transport.fetch(eff(c.build(authority)))
      assert.equal(counts.dns, 1, 'dns')
      assert.equal(counts.request, 1, 'request')
      assert.equal(res.status, 200)
      const opt = captured[0].options
      assert.equal(opt.host, c.host)
      assert.equal(opt.path, c.path)
      assert.equal(opt.rejectUnauthorized, true)
      if (c.cookie === undefined) assert.deepEqual(opt.headers, {})
      else assert.equal(opt.headers.cookie, c.cookie)
      // 域隔离：account 域不得出现 platform 票名；platform 域不得出现 passToken
      if (opt.host === 'account.xiaomi.com') assert.equal(String(opt.headers.cookie || '').includes('api-platform_'), false)
      if (opt.host === 'platform.xiaomimimo.com') assert.equal(String(opt.headers.cookie || '').includes('passToken'), false)
    })
  }

  // ---------- B. 302：只发 1 次，不自动 follow ----------
  await check('302 只发 1 次请求、不自动 follow', async () => {
    const { authority } = mkAuthority()
    const { transport, counts, state, captured } = fakeTransport({ authority })
    state.status = 302
    state.headers = { location: DUMMY_LOCATION }
    const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
    const res = await transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: g }))
    assert.equal(counts.request, 1)
    assert.equal(captured.length, 1)
    assert.equal(res.status, 302)
    assert.equal(res.redirected, false)
    assert.equal(res.headers.get('location'), DUMMY_LOCATION)
  })

  // ---------- C. headers 到达后 authority 失效：request===1、bodyRead===0、固定错误 ----------
  await check('headers 到达后失效：request===1 / bodyRead===0 / 固定错误', async () => {
    const { authority } = mkAuthority()
    const { transport, counts, state } = fakeTransport({ authority })
    state.invalidateOnFlush = true
    const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
    await expectCode(() => transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: g })), C.EXPIRED, '失效')
    assert.equal(counts.request, 1, 'request')
    assert.equal(counts.bodyRead, 0, 'bodyRead')
  })

  // ---------- D. 发起后改原 headers 对象：发出去的仍是冻结快照 ----------
  await check('发起后修改 req.headers：发送值不变（冻结快照）', async () => {
    const { authority } = mkAuthority()
    const { transport, captured } = fakeTransport({ authority })
    const g = authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' })
    const headers = { cookie: 'api-platform_serviceToken=good' }
    const p = transport.fetch(eff({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform', grant: g, headers }))
    headers.cookie = 'passToken=evil'
    headers.extra = 'x'
    await p
    assert.equal(captured[0].headersSnapshot.cookie, 'api-platform_serviceToken=good')
    assert.equal(Object.keys(captured[0].headersSnapshot).join(','), 'cookie')
  })

  // ---------- E. 挂死请求：deadline 到点 settle TIMEOUT，只发 1 次 ----------
  await check('挂死请求：TIMEOUT + settle + 只发 1 次', async () => {
    const clock = () => Date.now()
    const { authority } = mkAuthority({ clock, deadlineAt: Date.now() + 60_000 })
    const { transport, counts, state } = fakeTransport({ clock, authority })
    state.hang = true
    const watchdog = setTimeout(() => {}, 400)
    try {
      const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
      const deadlineAt = Date.now() + 20
      await expectCode(
        () => transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: g, deadlineAt })),
        'E_REQUEST_TIMEOUT', '超时'
      )
      assert.equal(counts.request, 1)
      assert.ok(counts.destroy >= 1)   // 旧底座允许幂等 destroy；不当作安全性质
    } finally { clearTimeout(watchdog) }
  })

  // ---------- F. 负例：Host 未提供 / false / throw assertAuthorized ⇒ DNS 0 ----------
  await check('缺 assertAuthorized：DNS 0 固定拒', async () => {
    const { authority } = mkAuthority()
    const { transport, counts } = fakeTransport({ authority })
    const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
    await expectCode(() => transport.fetch({
      url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none', grant: g, deadlineAt: Date.now() + 5000
    }), 'E_MIMO_AUTH_TARGET_INVALID', '缺assert')
    assert.equal(counts.dns, 0)
  })
  await check('assertAuthorized 返回 false / 抛错：DNS 0（错误静态化）', async () => {
    const { authority } = mkAuthority()
    const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
    const a = fakeTransport({ authority })
    await expectCode(() => a.transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: g, assertAuthorized: () => false })), 'E_MIMO_AUTH_TARGET_INVALID', 'assert false')
    assert.equal(a.counts.dns, 0)
    const b = fakeTransport({ authority })
    const thrown = new Error('host-boom-secret-token')
    const caught = await expectCode(() => b.transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: g, assertAuthorized: () => { throw thrown } })), 'E_MIMO_AUTH_TARGET_INVALID', 'assert throw')
    assert.equal(b.counts.dns, 0)
    assert.equal(String(caught.message).includes('secret'), false)
  })

  // ---------- G. 负例：无 validator / 无 authority / 伪 grant / 串域票 ----------
  await check('未注入 validator：console 用途拒', async () => {
    const t = createSecureTransport({
      clock: () => Date.now(),
      resolver: async () => { throw new Error('dns must not run') },
      request: () => { throw new Error('req must not run') }
    })
    await expectCode(() => t.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })), 'E_URL_PURPOSE_MISMATCH', '无validator')
  })
  await check('传入但 authority 缺失 / 伪 grant：DNS 0', async () => {
    const noAuth = fakeTransport({})
    await expectCode(() => noAuth.transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: Object.freeze(Object.create(null)) })), C.TARGET_INVALID, '无authority')
    assert.equal(noAuth.counts.dns, 0)
    const { authority } = mkAuthority()
    const forged = fakeTransport({ authority })
    await expectCode(() => forged.transport.fetch(eff({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none', grant: Object.freeze(Object.create(null)) })), C.TARGET_INVALID, '伪grant')
    assert.equal(forged.counts.dns, 0)
  })
  await check('真 grant 改 purpose（qrImage 票充 authResult）：DNS 0', async () => {
    const { authority } = mkAuthority()
    const { transport, counts } = fakeTransport({ authority })
    const q = authority.markSource('qrInit', 'qr-1', { qr: QR, lp: LP })
    const g = authority.issue({ url: QR, purpose: P.QR_IMAGE, credentialClass: 'none', sourceBinding: q })
    await expectCode(() => transport.fetch(eff({ url: QR, purpose: P.AUTH_RESULT, credentialClass: 'none', grant: g })), C.URL_PURPOSE_MISMATCH, 'purpose串用')
    assert.equal(counts.dns, 0)
  })
  await check('account 票串 platform 用途：DNS 0', async () => {
    const { authority } = mkAuthority()
    const { transport, counts } = fakeTransport({ authority })
    const g = authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' })
    await expectCode(() => transport.fetch(eff({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform', grant: g, headers: { cookie: 'passToken=abc' } })), C.TARGET_INVALID, '串域票')
    assert.equal(counts.dns, 0)
  })

  // ---------- H. legacy 窄对照 ----------
  await check('legacy longPoll 正向：request===1（无 grant）', async () => {
    const { transport, counts, captured } = fakeTransport({})
    const res = await transport.fetch(eff({ url: LP, purpose: 'longPoll', cookieScoped: true, deadlineAt: Date.now() + 5000 }))
    assert.equal(counts.dns, 1)
    assert.equal(counts.request, 1)
    assert.equal(res.status, 200)
    assert.equal(captured[0].options.host, 'account.xiaomi.com')
  })
  await check('legacy longPoll：platform 域 URL 仍旧拒', async () => {
    const { transport, counts } = fakeTransport({})
    await expectCode(() => transport.fetch(eff({ url: CALLBACK_URL, purpose: 'longPoll', cookieScoped: true })), 'E_DYNAMIC_URL_REJECTED', 'legacy窄对照')
    assert.equal(counts.dns, 0)
  })
  await check('未知 purpose 仍拒', async () => {
    const { transport, counts } = fakeTransport({})
    await expectCode(() => transport.fetch(eff({ url: CONTEXT_URL, purpose: 'consoleAuth', credentialClass: 'none' })), 'E_URL_PURPOSE_MISMATCH', '未知')
    assert.equal(counts.dns, 0)
  })

  console.log(pass + ' passed, ' + fails.length + ' failed')
  if (fails.length > 0) { for (const f of fails) console.log('FAIL ' + f); process.exitCode = 1 }
}

main()
