/**
 * test-mimo-console-grants.mjs — A1：console grant authority 单测（离线、无网络、无 profile）
 * 只测 authority：issue / validate / markSource / invalidate / derive helper。
 * 运行：node tools/test-mimo-console-grants.mjs
 */
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  createConsoleGrantAuthority,
  deriveConsoleSsoUrl,
  deriveConsoleQrInitUrl,
  CONSOLE_PURPOSES as P,
  CONSOLE_CODES as C
} from '../plans/mimo-auth/console-grants.js'

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}
function expectCode(fn, code, label) {
  try { fn() } catch (e) {
    if (e.code !== code) throw new Error((label || '') + ' 期望 ' + code + ' 实际 ' + (e.code || e.message))
    return
  }
  throw new Error((label || '') + ' 期望抛 ' + code + '，但没有抛')
}

const CB = 'https://platform.xiaomimimo.com/sts'
// context：genLogin 返回的完整 serviceLogin URL（含服务器签名 dummy 参数，必须原样保留）
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
const LP = 'https://a.b.account.xiaomi.com/longPolling/loginUrl?k=1'

function mkAuth(over = {}) {
  const state = { live: true, t: 1000, balancePhase: true }
  const authority = createConsoleGrantAuthority({
    owner: {},
    bootEpoch: 'boot-1',
    generation: 1,
    deadlineAt: 10_000,
    now: () => state.t,
    isLive: (purpose) => state.live === true && (purpose === P.BALANCE ? state.balancePhase : true),
    ...over
  })
  return { authority, state }
}
const mkCtx = (a) => a.markSource('context', 'resp-ctx-1', { location: CONTEXT_LOCATION })
const mkQr = (a) => a.markSource('qrInit', 'resp-qr-1', { qr: QR, lp: LP })

// ---------- derive helper ----------
check('SSO 派生完整保留服务端签名 URL（不补 _json/_locale）', () => {
  const u = new URL(SSO_URL)
  assert.equal(u.searchParams.get('_sign'), 'DUMMYSIGN')
  assert.equal(u.searchParams.get('_json'), null, '不得由本地补 _json')
  assert.equal(u.searchParams.get('_locale'), null, '不得由本地补 _locale')
  assert.equal(u.searchParams.getAll('sid').length, 1)
})
check('QRinit 派生按已见参数且不含 _dc / serviceParam', () => {
  const u = new URL(QRINIT_URL)
  assert.equal(u.searchParams.get('_qrsize'), '240')
  assert.equal(u.searchParams.get('_hasLogo'), 'false')
  assert.equal(u.searchParams.get('_locale'), 'zh_CN')
  assert.equal(u.searchParams.has('_dc'), false)
  assert.equal(u.searchParams.has('serviceParam'), false)
  // 顶层 callback 字段 + qs 内嵌 callback 必须都存在且与 signed context 一致
  assert.equal(u.searchParams.get('callback'), CB)
  assert.equal(u.searchParams.getAll('sid').length, 1)
  const qs = u.searchParams.get('qs')
  // 构造按合同为 encodeURIComponent(...) 后由 URLSearchParams 再编码 ⇒ 检查内嵌字段需先解码一层
  const inner = new URLSearchParams(decodeURIComponent(qs))
  assert.equal(inner.get('callback'), CB)
  assert.equal(inner.get('sid'), 'api-platform')
  assert.equal(inner.getAll('sid').length, 1)
  assert.equal(inner.get('_json'), 'true')
  assert.equal(inner.get('_group'), 'DEFAULT')
})
check('双 sid / 双 callback 一律拒绝', () => {
  const { authority } = mkAuth()
  expectCode(() => authority.markSource('context', 'r', {
    location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&sid=api-platform&callback=' + encodeURIComponent(CB)
  }), C.TARGET_INVALID, '双sid')
  expectCode(() => authority.markSource('context', 'r', {
    location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB) +
      '&callback=' + encodeURIComponent(CB)
  }), C.TARGET_INVALID, '双callback')
})

// ---------- happy path ----------
check('七个用途 happy path', () => {
  const { authority } = mkAuth()
  const ctx = mkCtx(authority)
  const qrInit = mkQr(authority)
  const sso = authority.markSource('sso', 'resp-sso-1', { location: 'https://platform.xiaomimimo.com/sts?code=0' })
  const cbUrl = 'https://platform.xiaomimimo.com/sts?code=0'

  const gCtx = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
  const gQrInit = authority.issue({ url: QRINIT_URL, purpose: P.QR_INIT, credentialClass: 'none', sourceBinding: ctx })
  const gImg = authority.issue({ url: QR, purpose: P.QR_IMAGE, credentialClass: 'none', sourceBinding: qrInit })
  const gAuth = authority.issue({ url: LP, purpose: P.AUTH_RESULT, credentialClass: 'none', sourceBinding: qrInit })
  const gSso = authority.issue({ url: SSO_URL, purpose: P.ACCOUNT_SSO, credentialClass: 'account', sourceBinding: ctx })
  const gCb = authority.issue({ url: cbUrl, purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', sourceBinding: sso })
  const gBal = authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' })

  authority.validate(gCtx, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' })
  authority.validate(gQrInit, { url: QRINIT_URL, method: 'GET', purpose: P.QR_INIT, credentialClass: 'none' })
  authority.validate(gImg, { url: QR, method: 'GET', purpose: P.QR_IMAGE, credentialClass: 'none' })
  authority.validate(gAuth, { url: LP, method: 'GET', purpose: P.AUTH_RESULT, credentialClass: 'none' })
  authority.validate(gSso, { url: SSO_URL, method: 'GET', purpose: P.ACCOUNT_SSO, credentialClass: 'account', headers: { cookie: 'passToken=abc; userId=42' } })
  // 首次 callback tokenless：允许
  authority.validate(gCb, { url: cbUrl, method: 'GET', purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform' })
  authority.validate(gBal, { url: BALANCE_URL, method: 'GET', purpose: P.BALANCE, credentialClass: 'platform', headers: { cookie: 'api-platform_serviceToken=t; userId=42' } })
})

// ---------- 目的域强约束 ----------
check('callback 只能是 platform/sts：account 的 sso.location 被拒', () => {
  const { authority } = mkAuth()
  const ssoAccount = authority.markSource('sso', 'r1', { location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' })
  expectCode(() => authority.issue({
    url: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform',
    purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', sourceBinding: ssoAccount
  }), C.URL_PURPOSE_MISMATCH, 'account-as-callback')
  expectCode(() => authority.issue({
    url: 'https://platform.xiaomimimo.com/unknown', purpose: P.PLATFORM_CALLBACK,
    credentialClass: 'platform', sourceBinding: ssoAccount
  }), C.URL_PURPOSE_MISMATCH, 'platform-unknown-path')
})
check('qrImage 只允许精确 account 或 platform 域（子域被拒）', () => {
  const { authority } = mkAuth()
  expectCode(() => authority.markSource('qrInit', 'r', {
    qr: 'https://a.account.xiaomi.com/longPolling/qrImage?k=1', lp: LP
  }), C.TARGET_INVALID, 'qr子域')
  const ok = authority.markSource('qrInit', 'r2', { qr: 'https://platform.xiaomimimo.com/qr?k=1', lp: LP })
  assert.ok(authority.issue({ url: 'https://platform.xiaomimimo.com/qr?k=1', purpose: P.QR_IMAGE, credentialClass: 'none', sourceBinding: ok }))
})
check('lp 允许 1–3 层合法子域，拒绝 xn-- / 尾点 / ipv4 / 超长', () => {
  const { authority } = mkAuth()
  assert.ok(mkQr(authority))
  expectCode(() => authority.markSource('qrInit', 'r', { qr: QR, lp: 'https://xn--a.account.xiaomi.com/x' }), C.TARGET_INVALID, 'puny')
  expectCode(() => authority.markSource('qrInit', 'r', { qr: QR, lp: 'https://account.xiaomi.com./x' }), C.TARGET_INVALID, '尾点')
  expectCode(() => authority.markSource('qrInit', 'r', { qr: QR, lp: 'https://1.2.3.4/x' }), C.TARGET_INVALID, 'ipv4')
  expectCode(() => authority.markSource('qrInit', 'r', { qr: QR, lp: 'https://' + 'a'.repeat(70) + '.account.xiaomi.com/x' }), C.TARGET_INVALID, 'label超长')
  expectCode(() => authority.markSource('qrInit', 'r', { qr: QR, lp: 'https://account.xiaomi.com/' + 'x'.repeat(2100) }), C.TARGET_INVALID, 'url超长')
})

// ---------- 伪造 / 序列化 ----------
check('伪 grant、跨 authority、无自有属性、JSON/inspect 不泄露', () => {
  const { authority: a1 } = mkAuth()
  const { authority: a2 } = mkAuth()
  const g = a1.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
  expectCode(() => a2.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' }), C.TARGET_INVALID, '跨authority')
  expectCode(() => a1.validate(Object.freeze(Object.create(null)), { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' }), C.TARGET_INVALID, '伪grant')
  assert.equal(JSON.stringify(g), '{}')
  assert.deepEqual(Object.getOwnPropertyNames(g), [])
  const s = inspect(g, { depth: 5, showHidden: true })
  assert.equal(s.includes('xiaomimimo'), false)
  assert.equal(s.includes('plan-manage'), false)
})
check('失配：url / method / purpose / class', () => {
  const { authority } = mkAuth()
  const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
  expectCode(() => authority.validate(g, { url: CONTEXT_URL + '&x=1', method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' }), C.URL_PURPOSE_MISMATCH, 'url')
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'POST', purpose: P.CONTEXT, credentialClass: 'none' }), C.URL_PURPOSE_MISMATCH, 'method')
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.BALANCE, credentialClass: 'none' }), C.URL_PURPOSE_MISMATCH, 'purpose')
  expectCode(() => authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'platform' }), C.URL_PURPOSE_MISMATCH, 'class')
})
check('外域 / http / 端口 / userinfo / fragment 被拒', () => {
  const { authority } = mkAuth()
  expectCode(() => authority.issue({ url: 'https://evil.example/api/v1/balance', purpose: P.BALANCE, credentialClass: 'platform' }), C.URL_PURPOSE_MISMATCH, '外域')
  expectCode(() => authority.issue({ url: 'http://platform.xiaomimimo.com/api/v1/balance', purpose: P.BALANCE, credentialClass: 'platform' }), C.TARGET_INVALID, 'http')
  expectCode(() => authority.issue({ url: 'https://platform.xiaomimimo.com:8443/api/v1/balance', purpose: P.BALANCE, credentialClass: 'platform' }), C.TARGET_INVALID, '端口')
  expectCode(() => authority.markSource('sso', 'r', { location: 'https://user:pw@platform.xiaomimimo.com/sts' }), C.TARGET_INVALID, 'userinfo')
  expectCode(() => authority.markSource('sso', 'r', { location: 'https://platform.xiaomimimo.com/sts#x' }), C.TARGET_INVALID, 'fragment')
})

// ---------- 来源链 ----------
check('外来 / 伪造 sourceBinding、kind 链错、authResult 拿 qr', () => {
  const { authority: a1 } = mkAuth()
  const { authority: a2 } = mkAuth()
  expectCode(() => a1.issue({ url: QRINIT_URL, purpose: P.QR_INIT, credentialClass: 'none', sourceBinding: mkCtx(a2) }), C.TARGET_INVALID, '外来source')
  expectCode(() => a1.issue({ url: QRINIT_URL, purpose: P.QR_INIT, credentialClass: 'none', sourceBinding: Object.freeze(Object.create(null)) }), C.TARGET_INVALID, '伪source')
  const ctx = mkCtx(a1)
  expectCode(() => a1.issue({ url: QR, purpose: P.QR_IMAGE, credentialClass: 'none', sourceBinding: ctx }), C.TARGET_INVALID, 'kind链')
  const qrInit = mkQr(a1)
  expectCode(() => a1.issue({ url: QR, purpose: P.AUTH_RESULT, credentialClass: 'none', sourceBinding: qrInit }), C.URL_PURPOSE_MISMATCH, 'authResult拿qr')
})
check('context 非法：路径 / sid / callback 域 / 未知 kind', () => {
  const { authority } = mkAuth()
  expectCode(() => authority.markSource('context', 'r', { location: 'https://account.xiaomi.com/other?sid=api-platform&callback=' + encodeURIComponent(CB) }), C.TARGET_INVALID, 'path')
  expectCode(() => authority.markSource('context', 'r', { location: 'https://account.xiaomi.com/pass/serviceLogin?sid=other&callback=' + encodeURIComponent(CB) }), C.TARGET_INVALID, 'sid')
  expectCode(() => authority.markSource('context', 'r', { location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent('https://evil.example/sts') }), C.TARGET_INVALID, 'callback域')
  expectCode(() => authority.markSource('nope', 'r', { location: CONTEXT_LOCATION }), C.TARGET_INVALID, 'kind')
})

// ---------- Cookie ----------
check('none 禁 Cookie；account/platform 名字与串域', () => {
  const { authority } = mkAuth()
  expectCode(() => authority.validate(
    authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' }),
    { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none', headers: { cookie: 'passToken=t' } }
  ), C.TARGET_INVALID, 'none带cookie')
  const ctx = mkCtx(authority)
  const gSso = authority.issue({ url: SSO_URL, purpose: P.ACCOUNT_SSO, credentialClass: 'account', sourceBinding: ctx })
  expectCode(() => authority.validate(gSso, { url: SSO_URL, method: 'GET', purpose: P.ACCOUNT_SSO, credentialClass: 'account', headers: { cookie: 'api-platform_serviceToken=t' } }), C.TARGET_INVALID, 'account收platform票')
  expectCode(() => authority.validate(gSso, { url: SSO_URL, method: 'GET', purpose: P.ACCOUNT_SSO, credentialClass: 'account' }), C.TARGET_INVALID, 'account缺cookie')
  const gBal = authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' })
  expectCode(() => authority.validate(gBal, { url: BALANCE_URL, method: 'GET', purpose: P.BALANCE, credentialClass: 'platform', headers: { cookie: 'passToken=t' } }), C.TARGET_INVALID, 'platform收passToken')
})
check('callback 收 passToken 被拒（tokenless 正常、有票只能平台名）', () => {
  const { authority } = mkAuth()
  const sso = authority.markSource('sso', 'r', { location: 'https://platform.xiaomimimo.com/sts?code=0' })
  const u = 'https://platform.xiaomimimo.com/sts?code=0'
  const g = authority.issue({ url: u, purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', sourceBinding: sso })
  expectCode(() => authority.validate(g, { url: u, method: 'GET', purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', headers: { cookie: 'passToken=t' } }), C.TARGET_INVALID, 'callback收account票')
  assert.equal(authority.validate(g, { url: u, method: 'GET', purpose: P.PLATFORM_CALLBACK, credentialClass: 'platform', headers: { cookie: 'api-platform_slh=x' } }), true)
})
check('重复 Cookie 大小写键被拒；CRLF / TAB / 重名 / 空值 / 无依据名', () => {
  const { authority } = mkAuth()
  const g = authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' })
  const base = { url: BALANCE_URL, method: 'GET', purpose: P.BALANCE, credentialClass: 'platform' }
  expectCode(() => authority.validate(g, { ...base, headers: { cookie: 'userId=1', Cookie: 'api-platform_slh=2' } }), C.TARGET_INVALID, '重复键')
  expectCode(() => authority.validate(g, { ...base, headers: { cookie: 'userId=1\r\nX: y' } }), C.TARGET_INVALID, 'CRLF')
  expectCode(() => authority.validate(g, { ...base, headers: { cookie: 'userId=1\t2' } }), C.TARGET_INVALID, 'TAB')
  expectCode(() => authority.validate(g, { ...base, headers: { cookie: 'userId=1; userId=2' } }), C.TARGET_INVALID, '重名')
  expectCode(() => authority.validate(g, { ...base, headers: { cookie: 'userId=' } }), C.TARGET_INVALID, '空值')
  expectCode(() => authority.validate(g, { ...base, headers: { cookie: 'api-platform_userId=1' } }), C.TARGET_INVALID, '无依据名')
})

// ---------- 生命周期 ----------
check('req.deadlineAt 越界 / 过期 / isLive=false / markSource 关闭后拒', () => {
  const { authority, state } = mkAuth()
  const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none', deadlineAt: 20_000 }), C.TARGET_INVALID, 'deadline过长')
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none', deadlineAt: 500 }), C.TARGET_INVALID, 'deadline已过')
  assert.equal(authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none', deadlineAt: 5000 }), true)
  state.live = false
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' }), C.TARGET_INVALID, 'not-live')
  expectCode(() => authority.markSource('sso', 'r', { location: 'https://platform.xiaomimimo.com/sts' }), C.TARGET_INVALID, 'not-live-mark')
  state.live = true; state.t = 10_000
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' }), C.EXPIRED, '过期')
  expectCode(() => authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' }), C.EXPIRED, '过期issue')
  expectCode(() => authority.markSource('sso', 'r', { location: 'https://platform.xiaomimimo.com/sts' }), C.EXPIRED, '过期mark')
})
check('invalidate 后：旧 grant、旧 source、再 issue / markSource 全失效', () => {
  const { authority } = mkAuth()
  const ctx = mkCtx(authority)
  const g = authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' })
  authority.invalidate()
  expectCode(() => authority.validate(g, { url: CONTEXT_URL, method: 'GET', purpose: P.CONTEXT, credentialClass: 'none' }), C.EXPIRED, 'grant')
  expectCode(() => authority.issue({ url: QRINIT_URL, purpose: P.QR_INIT, credentialClass: 'none', sourceBinding: ctx }), C.EXPIRED, 'source')
  expectCode(() => authority.issue({ url: CONTEXT_URL, purpose: P.CONTEXT, credentialClass: 'none' }), C.EXPIRED, 'issue')
  expectCode(() => authority.markSource('sso', 'r', { location: 'https://platform.xiaomimimo.com/sts' }), C.EXPIRED, 'mark')
})
check('balance 阶段许可 / class 自选 / 非 GET', () => {
  const { authority, state } = mkAuth()
  state.balancePhase = false
  expectCode(() => authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' }), C.TARGET_INVALID, '无阶段')
  state.balancePhase = true
  assert.ok(authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'platform' }))
  expectCode(() => authority.issue({ url: BALANCE_URL, purpose: P.BALANCE, credentialClass: 'none' }), C.URL_PURPOSE_MISMATCH, 'class')
  expectCode(() => authority.issue({ url: CONTEXT_URL, method: 'POST', purpose: P.CONTEXT, credentialClass: 'none' }), C.TARGET_INVALID, 'method')
})

console.log(pass + ' passed, ' + fails.length + ' failed')
if (fails.length > 0) { for (const f of fails) console.log('FAIL ' + f); process.exitCode = 1 }
