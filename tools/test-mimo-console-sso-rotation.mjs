/**
 * test-mimo-console-sso-rotation.mjs — SSO 握手补齐（账号 seed 轮换/签名/拒绝顺序）小包
 *
 * 全是合成：fake HTTP/DNS，不访问真实账号/网络/记录；断言只涉及固定码/无泄漏。
 * 重点：SSO 200 先解析 JSON（code/70016/challenge），code0 允许消费**服务端新签发**的
 * userId/passToken，再校验 jar；签名 clientSign 仅在缺签名且 nonce+ssecurity 同时存在时补。
 *
 * 运行：node tools/test-mimo-console-sso-rotation.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
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
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
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
const NEW_PASS = 'NEW_PASS_TOKEN'
const SECURITY = 'SECURITY_VALUE_XYZ'

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
    lpBody: JSON.stringify({ location: CB, passToken: OLD_PASS, userId: '777', cUserId: 'CUSER' }),
    qrBody: JSON.stringify({ qr: QR, lp: LP }),
    ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: NEW_PASS, challenge: null }),
    ssoCookies: [],
    callbackCookies: PLATFORM_COOKIES,
    ssoStatus: 200,
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
        if (url.includes('/api/v1/genLoginUrl')) res = makeResp(302, '', { location: SIGNED })
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, state.qrBody)
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, state.lpBody)
        else if (url.includes('/pass/serviceLogin')) res = makeResp(state.ssoStatus, state.ssoBody, { 'set-cookie': state.ssoCookies })
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
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
    owner: {},
    bootEpoch: 'b1',
    generation: 1,
    expected: { namespace: NS, identifier: '777' },
    now: () => clock.t,
    isLive: () => true,
    transportDeps: { clock: () => Date.now(), resolver: async () => [{ address: PUBLIC_IP, family: 4 }], request: sc.impl },
    ...over,
  })
  return { p, clock, dl: () => clock.t + 60000 }
}

/** 首次扫码确认 → 导出 saved（passToken=OLD_PASS）。 */
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

const callbackHas = (sc, re) => {
  const hit = sc.cookies.filter((c) => c.url.includes('/sts'))
  return hit.some((c) => re.test(String(c.headers.cookie || '')))
}

async function main() {
  const saved = await savedAccount()
  const DEL = [
    'passToken=; Domain=account.xiaomi.com; Path=/; Max-Age=0',
    'userId=; Domain=account.xiaomi.com; Path=/; Max-Age=0',
  ]

  await check('A 旧cookie被删 + JSON code0 新 passToken/userId：seed 轮换成功、callback 用新票、3 跳', async () => {
    const sc = scenario({ ssoCookies: DEL })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    assert.equal(sc.count('/pass/serviceLogin'), 1)
    assert.equal(sc.count('/sts'), 1)
    assert.equal(sc.seen.length, 3, 'hops=' + sc.seen.length)
    const ssoReq = sc.cookies.find((c) => c.url.includes('/pass/serviceLogin'))
    assert.ok(ssoReq !== undefined && String(ssoReq.headers.cookie || '').includes(OLD_PASS), 'SSO 应带保存的旧 seed')
    const exp = p.exportRememberedAccount()
    const pt = exp.cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, NEW_PASS)
    assert.equal(pt.expiresAt, null, 'JSON 新签发票无 expiry ⇒ null（不自造）')
    assert.equal(p.describe().state, 'verified')
    p.dispose()
  })

  await check('B 70016 + 删除：先报 AUTH_REJECTED，0 callback', async () => {
    const sc = scenario({ ssoCookies: DEL, ssoBody: JSON.stringify({ code: 70016, location: CB }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.AUTH_REJECTED)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('C 删除且无新 seed：ACCOUNT_CREDENTIAL_MISSING、0 callback、不复活旧 token', async () => {
    const sc = scenario({ ssoCookies: DEL, ssoBody: JSON.stringify({ code: 0, location: CB, challenge: null }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.ACCOUNT_CREDENTIAL_MISSING)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('D 删除 + code0 完整同 UID pair（同 token）：原 raw/flags/expiry 全保留', async () => {
    const exp = Date.now() + 30 * 24 * 3600 * 1000
    const savedD = JSON.parse(JSON.stringify(saved))
    savedD.cookies = savedD.cookies.map((c) => (c.name === 'passToken' ? { ...c, hostOnly: true, expiresAt: exp } : c))
    const sc = scenario({ ssoCookies: DEL, ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: OLD_PASS }) })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(savedD, { deadlineAt: dl() })
    assert.equal(sc.count('/sts'), 1, '完整明确 pair 应允许继续 callback')
    const pt = p.exportRememberedAccount().cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, OLD_PASS, '原 raw 不变')
    assert.equal(pt.expiresAt, exp, '原绝对 expiry 不得延长/抹空')
    assert.equal(pt.hostOnly, true, 'hostOnly 不得被扩成 Domain')
    assert.equal(pt.domain, 'account.xiaomi.com')
    assert.equal(pt.path, '/')
    p.dispose()
  })

  await check('D2 删除 + 只有 passToken（缺 userId 完整 pair）：拒、0 callback、不从旧 record 补', async () => {
    const sc = scenario({ ssoCookies: DEL, ssoBody: JSON.stringify({ code: 0, location: CB, passToken: OLD_PASS }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_RESPONSE_UNSUPPORTED)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('D3 70016 携带旧 pair：AUTH_REJECTED、0 callback', async () => {
    const sc = scenario({ ssoCookies: DEL, ssoBody: JSON.stringify({ code: 70016, userId: 777, passToken: OLD_PASS, location: CB }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.AUTH_REJECTED)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('E JSON userId 与绑定不符：IDENTITY_MISMATCH、0 callback', async () => {
    const sc = scenario({ ssoCookies: DEL, ssoBody: JSON.stringify({ code: 0, location: CB, userId: 999, passToken: NEW_PASS }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.IDENTITY_MISMATCH)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('F 同响应 header 值与 JSON 值冲突：拒、0 callback', async () => {
    const sc = scenario({ ssoCookies: ['passToken=HEADER_OTHER; Domain=account.xiaomi.com; Path=/; Secure'], ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: NEW_PASS }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_RESPONSE_UNSUPPORTED)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('G 交互 challenge（非 null）拒绝；null 可通过（A 已覆盖）', async () => {
    const sc = scenario({ ssoBody: JSON.stringify({ code: 0, location: CB, challenge: { type: 'mfa' } }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_CHALLENGE)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('H 已有 clientSign：逐字保留，不重签', async () => {
    const loc = CB + '?clientSign=KEEP_SIGN_AS_IS'
    const sc = scenario({ ssoBody: JSON.stringify({ code: 0, location: loc, userId: 777, passToken: NEW_PASS, nonce: 111, ssecurity: SECURITY }) })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const sts = sc.seen.find((u) => u.includes('/sts'))
    assert.ok(sts.indexOf('clientSign=KEEP_SIGN_AS_IS') >= 0)
    assert.equal(sts.includes('clientSign=KEEP_SIGN_AS_IS&'), false, '不得追加第二个签名')
    p.dispose()
  })

  await check('I nonce+ssecurity 缺签名：按 SHA1 精确补 clientSign；大整数 nonce 不舍入', async () => {
    const bigNonce = '12345678901234567890'
    const sc = scenario({ ssoBody: '{ "code": 0, "location": ' + JSON.stringify(CB) + ', "userId": 777, "passToken": ' + JSON.stringify(NEW_PASS) + ', "nonce": ' + bigNonce + ', "ssecurity": ' + JSON.stringify(SECURITY) + ' }' })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const sts = sc.seen.find((u) => u.includes('/sts'))
    const expect = createHash('sha1').update('nonce=' + bigNonce + '&' + SECURITY, 'utf8').digest('base64')
    assert.ok(sts.includes('clientSign=' + encodeURIComponent(expect)), 'sts=' + sts)
    const blob = JSON.stringify(p.describe()) + JSON.stringify(p.exportRememberedAccount())
    assert.equal(blob.includes(bigNonce), false, 'nonce 不得外泄')
    assert.equal(blob.includes(SECURITY), false, 'ssecurity 不得外泄')
    p.dispose()
  })

  await check('J 只有一种签名材料：fail closed、0 callback', async () => {
    for (const body of [
      { code: 0, location: CB, userId: 777, passToken: NEW_PASS, nonce: 12345 },
      { code: 0, location: CB, userId: 777, passToken: NEW_PASS, ssecurity: SECURITY },
    ]) {
      const sc = scenario({ ssoBody: JSON.stringify(body) })
      const { p, dl } = mk(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_RESPONSE_UNSUPPORTED)
      assert.equal(sc.count('/sts'), 0)
      p.dispose()
    }
  })

  await check('K 同值 header 带 expiry：保留 expiry 不被 JSON/重装清成 null；可选票删除不复活', async () => {
    const exp = 'Wed, 01 Jan 2031 00:00:00 GMT'
    const sc = scenario({
      ssoCookies: ['passToken=' + OLD_PASS + '; Domain=account.xiaomi.com; Path=/; Secure; Expires=' + exp, 'cUserId=; Domain=account.xiaomi.com; Path=/; Max-Age=0'],
      ssoBody: JSON.stringify({ code: 0, location: CB, challenge: null }),
    })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const out = p.exportRememberedAccount()
    const pt = out.cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, OLD_PASS)
    assert.ok(Number.isSafeInteger(pt.expiresAt) && pt.expiresAt > 0, 'expiry 必须保留：' + String(pt.expiresAt))
    assert.equal(out.cookies.some((c) => c.name === 'cUserId'), false, '被删除的可选票不得导出复活')
    p.dispose()
  })

  await check('L &&&START&&& 前缀 + 字符串 nonce：可解析并按字符串值签名', async () => {
    const body = '&&&START&&&' + JSON.stringify({ code: 0, location: CB, userId: 777, passToken: NEW_PASS, nonce: '9876543210', ssecurity: SECURITY })
    const sc = scenario({ ssoCookies: DEL, ssoBody: body })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const sts = sc.seen.find((u) => u.includes('/sts'))
    const expect = createHash('sha1').update('nonce=9876543210&' + SECURITY, 'utf8').digest('base64')
    assert.ok(sts.includes('clientSign=' + encodeURIComponent(expect)))
    p.dispose()
  })

  await check('M 嵌套 nonce 不覆盖顶层：只用顶层签名', async () => {
    const top = '123'
    const body = '&&&START&&&' + JSON.stringify({ code: 0, location: CB, userId: 777, passToken: NEW_PASS, nonce: Number(top), ssecurity: SECURITY, nested: { nonce: 999 } })
    const sc = scenario({ ssoCookies: DEL, ssoBody: body })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const sts = sc.seen.find((u) => u.includes('/sts'))
    const expect = createHash('sha1').update('nonce=' + top + '&' + SECURITY, 'utf8').digest('base64')
    assert.ok(sts.includes('clientSign=' + encodeURIComponent(expect)))
    p.dispose()
  })

  await check('N 重复 key / 危险 key：严格 JSON 拒绝、0 callback', async () => {
    for (const body of [
      '&&&START&&&{"code":0,"location":"' + CB + '","userId":777,"passToken":"' + NEW_PASS + '","passToken":"' + NEW_PASS + '"}',
      '&&&START&&&{"code":0,"location":"' + CB + '","userId":777,"passToken":"' + NEW_PASS + '","__proto__":{"x":1}}',
    ]) {
      const sc = scenario({ ssoCookies: DEL, ssoBody: body })
      const { p, dl } = mk(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_RESPONSE_UNSUPPORTED)
      assert.equal(sc.count('/sts'), 0)
      p.dispose()
    }
  })

  await check('O header 有限 expiry + JSON 同值：保留精确 expiry，不被重装成 null', async () => {
    const exp = 'Wed, 01 Jan 2031 00:00:00 GMT'
    const sc = scenario({
      ssoCookies: ['passToken=' + OLD_PASS + '; Domain=account.xiaomi.com; Path=/; Secure; Expires=' + exp],
      ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: OLD_PASS }),
    })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    const pt = p.exportRememberedAccount().cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, OLD_PASS)
    assert.equal(pt.expiresAt, Date.parse(exp), 'expiry 必须精确保持')
    p.dispose()
  })

  await check('P 删除标记（value=deleted, Max-Age=0）+ 真正新 B：允许', async () => {
    const sc = scenario({
      ssoCookies: ['passToken=deleted; Domain=account.xiaomi.com; Path=/; Max-Age=0'],
      ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: NEW_PASS }),
    })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    assert.equal(p.exportRememberedAccount().cookies.find((c) => c.name === 'passToken').value, NEW_PASS)
    p.dispose()
  })

  await check('Q quoted 旧 token + JSON 无引号同值：语义相等、不重装、raw quote 保留', async () => {
    const quoted = JSON.parse(JSON.stringify(saved))
    quoted.cookies = quoted.cookies.map((c) => (c.name === 'passToken' ? { ...c, value: '"' + OLD_PASS + '"' } : c))
    const sc = scenario({ ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777, passToken: OLD_PASS }) })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(quoted, { deadlineAt: dl() })
    const pt = p.exportRememberedAccount().cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, '"' + OLD_PASS + '"', 'raw quote 原样保留')
    p.dispose()
  })

  await check('R 空 clientSign 参数：不猜签名、固定拒绝、0 callback', async () => {
    const sc = scenario({ ssoBody: JSON.stringify({ code: 0, location: CB + '?clientSign=', userId: 777, passToken: NEW_PASS, nonce: 111, ssecurity: SECURITY }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_RESPONSE_UNSUPPORTED)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  await check('S 只删 userId、passToken 未动、JSON 仅同值 userId：允许补稳定 UID，token/expiry 不变', async () => {
    const sc = scenario({ ssoCookies: ['userId=; Domain=account.xiaomi.com; Path=/; Max-Age=0'], ssoBody: JSON.stringify({ code: 0, location: CB, userId: 777 }) })
    const { p, dl } = mk(sc)
    await p.restoreRememberedAccount(saved, { deadlineAt: dl() })
    assert.equal(sc.seen.length, 3, 'hops=' + sc.seen.length)
    const pt = p.exportRememberedAccount().cookies.find((c) => c.name === 'passToken')
    assert.equal(pt.value, OLD_PASS, '原 token 不变')
    assert.equal(pt.expiresAt, null, '原 expiry 不延长')
    p.dispose()
  })

  await check('T 只删 passToken、JSON 仅不同 NEW_PASS 缺 userId：拒、0 callback（不同值不等于完整 pair）', async () => {
    const sc = scenario({ ssoCookies: ['passToken=; Domain=account.xiaomi.com; Path=/; Max-Age=0'], ssoBody: JSON.stringify({ code: 0, location: CB, passToken: NEW_PASS }) })
    const { p, dl } = mk(sc)
    await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), C.SSO_RESPONSE_UNSUPPORTED)
    assert.equal(sc.count('/sts'), 0)
    p.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) { for (const f of fails) console.error('FAIL ' + f); console.error(summary); process.exitCode = 1 }
  else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
