/**
 * test-mimo-console-remember-protocol.mjs — 首扫确认（confirmAfterScan）/ 最小导出 / 受信恢复 /
 * 自然到期续期 的离线契约测试。
 *
 * 只 fake DNS 与 https；真实 A1 authority + 真实 createSecureTransport + 真实 vendor CookieJar。
 * **不访问真实 MiMo/小米接口**：所有 Cookie/ID/expiry 都是本文件里的合成值。
 * 运行：node tools/test-mimo-console-remember-protocol.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES } from '../plans/mimo-auth/console-protocol.js'

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
const KNOWN_CODES = new Set(Object.values(CONSOLE_PROTOCOL_CODES))

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
const ACCOUNT_NS = 'xiaomi-account-user-id'
// 哨兵：只用于断言「没有泄漏」，不写入任何真实系统
const SENT_PASS = 'SENTINELPASSTOKENVALUE'
const SENT_CUID = 'SENTINELCUSERIDVALUE'

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
    lpBody: JSON.stringify({ location: CB, passToken: SENT_PASS, userId: '777', cUserId: SENT_CUID }),
    qrBody: JSON.stringify({ qr: QR, lp: LP }),
    balanceSeq: null,
    balanceBody: JSON.stringify({ code: 0, data: { balance: '13.50', cashBalance: '12.50', giftBalance: '1.00', currency: 'CNY' } }),
    callbackCookies: PLATFORM_COOKIES,
    lpHeaderCookies: null,
    ssoAccountCookies: null,
    ssoCallbackCookies: PLATFORM_COOKIES,
    balanceHeaderCookies: null,
    ...over
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
        else if (url.includes('/longPolling/loginUrl')) {
          res = makeResp(200, state.lpBody, state.lpHeaderCookies === null ? {} : { 'set-cookie': state.lpHeaderCookies })
        } else if (url.includes('/pass/serviceLogin')) {
          res = makeResp(200, JSON.stringify({ code: 0, location: CB }), state.ssoAccountCookies === null ? {} : { 'set-cookie': state.ssoAccountCookies })
        } else if (url.includes('/sts')) {
          res = makeResp(200, '', { 'set-cookie': state.ssoCallbackCookies === null ? [] : state.ssoCallbackCookies })
        } else if (url.includes('/api/v1/balance')) {
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

/** clock.t 驱动协议内所有「现在」（jar 过期/op deadline），便于制造自然到期。 */
function mkHarness(sc, over = {}) {
  const clock = { t: Date.now() }
  const live = { owner: true, authResult: true, balance: true }
  const opts = {
    owner: {},
    bootEpoch: 'b1',
    generation: 1,
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
  }
  if (opts.now === undefined) opts.now = () => clock.t
  const p = createConsoleProtocol(opts)
  const dl = () => clock.t + 60000
  return { p, live, clock, dl }
}
const mkStrict = (sc, over = {}) => mkHarness(sc, { expected: { namespace: ACCOUNT_NS, identifier: '777' }, ...over })
const mkFirstScan = (sc, over = {}) => mkHarness(sc, { confirmAfterScan: true, ...over })

const urlHas = (u, part) => u.includes(part)
const countOf = (seen, part) => seen.filter(u => urlHas(u, part)).length
const cookieHeaderOf = (sc, part) => {
  const hit = sc.cookies.filter(c => urlHas(c.url, part))
  return hit.length === 0 ? '' : String(hit[hit.length - 1].headers.cookie || '')
}

async function main() {
  // ── 1. 模式旗标：严格默认不变 ──────────────────────────────────────────────
  await check('缺 expected 且无 confirmAfterScan：仍按严格模式拒绝构造', () => {
    const sc = scenario()
    assert.throws(() => createConsoleProtocol({
      owner: {}, bootEpoch: 'b1', generation: 1, isLive: () => true,
      transportDeps: { clock: () => Date.now(), resolver: async () => [], request: sc.impl }
    }), /expected required/)
  })

  await check('confirmAfterScan 非布尔真值不放宽（必须 === true）', () => {
    const sc = scenario()
    for (const flag of ['yes', 1, {}, true]) {
      const shouldThrow = flag !== true
      let threw = false
      try {
        createConsoleProtocol({
          owner: {}, bootEpoch: 'b1', generation: 1, confirmAfterScan: flag, isLive: () => true,
          transportDeps: { clock: () => Date.now(), resolver: async () => [], request: sc.impl }
        })
      } catch { threw = true }
      assert.equal(threw, shouldThrow, 'flag=' + String(flag))
    }
  })

  // ── 2. 首扫：pending → 确认前全部拒 → 确认 → 导出 ──────────────────────────
  await check('首扫无 expected：5 跳登录 → awaiting_confirmation，0 余额请求', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    assert.equal(sc.seen.length, 5, 'hops=' + sc.seen.length)
    assert.equal(countOf(sc.seen, '/api/v1/balance'), 0)
    assert.equal(p.describe().state, 'awaiting_confirmation')
    const pend = p.pendingAccount()
    assert.equal(pend.namespace, ACCOUNT_NS)
    assert.equal(pend.identifier, '777')
    assert.equal(pend.nickname, null, '昵称无 schema 依据，必须 null')
    assert.equal(Object.keys(pend).length, 3)
  })

  await check('确认前：readBalance / verifyIdentity / export 全拒且 0 新请求', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    const before = sc.seen.length
    await expectCode(() => p.readBalance({ deadlineAt: dl() }), CONSOLE_PROTOCOL_CODES.CONFIRM_REQUIRED, '确认前读余额')
    await expectCode(() => p.verifyIdentity(), CONSOLE_PROTOCOL_CODES.CONFIRM_REQUIRED, '确认前取身份')
    await expectCode(() => p.exportRememberedAccount(), CONSOLE_PROTOCOL_CODES.CONFIRM_REQUIRED, '确认前导出')
    assert.equal(sc.seen.length, before, '确认前不得有任何新请求')
    assert.equal(p.describe().state, 'awaiting_confirmation')
    assert.equal(p.pendingAccount().identifier, '777', '拒绝不得清掉候选')
  })

  await check('篡改候选 ID 确认：拒且状态/候选不变', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    await expectCode(() => p.confirmAccount('778'), CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH, '错 ID')
    await expectCode(() => p.confirmAccount(null), CONSOLE_PROTOCOL_CODES.INVALID, '空 ID')
    assert.equal(p.describe().state, 'awaiting_confirmation')
    assert.equal(p.pendingAccount().identifier, '777')
  })

  await check('候选一致确认：转 verified、导出四账号名且无平台票/无 raw 泄漏', async () => {
    const sc = scenario({ lpHeaderCookies: ['deviceId=DEV1; Path=/; Secure'] })
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    const ok = p.confirmAccount('777')
    assert.equal(ok.ok, true)
    assert.equal(ok.identifier, '777')
    assert.equal(p.describe().state, 'verified')
    assert.equal(p.pendingAccount(), null, '确认后不再有候选')
    assert.deepEqual(p.verifyIdentity(), { namespace: ACCOUNT_NS, identifier: '777' })
    const saved = p.exportRememberedAccount()
    assert.equal(saved.version, 1)
    assert.equal(saved.namespace, ACCOUNT_NS)
    assert.equal(saved.accountId, '777')
    const names = saved.cookies.map(c => c.name)
    assert.deepEqual(names, ['passToken', 'userId', 'cUserId', 'deviceId'], 'names=' + names.join(','))
    for (const c of saved.cookies) {
      assert.equal(c.domain, 'account.xiaomi.com')
      assert.equal(c.path, '/')
      assert.equal(typeof c.hostOnly, 'boolean')
      assert.equal(typeof c.secure, 'boolean')
      assert.equal(typeof c.httpOnly, 'boolean')
      assert.equal(typeof c.value, 'string')
      assert.ok(c.value.length > 0)
      assert.ok(c.expiresAt === null || Number.isSafeInteger(c.expiresAt))
    }
    assert.equal(JSON.stringify(saved).includes('api-platform'), false, '不得导出平台票')
    assert.equal(JSON.stringify(saved).includes('longPolling'), false, '不得导出 QR/LP URL')
    assert.equal(JSON.stringify(saved).includes('xiaomimimo.com'), false, '不得导出平台 URL')
    assert.equal(JSON.stringify(saved).includes('passToken'.toUpperCase() + '=PT'), false)
    // describe 永不出现原始 ID 或 raw 值
    const d = JSON.stringify(p.describe())
    assert.equal(d.includes('777'), false, 'describe 不得含原始 ID')
    assert.equal(d.includes(SENT_PASS), false, 'describe 不得含 raw 值')
    assert.equal(d.includes(SENT_CUID), false, 'describe 不得含 raw 值')
    // 确认后余额可读，且只多 1 跳
    const hops = sc.seen.length
    const out = await p.readBalance({ deadlineAt: dl() })
    assert.equal(sc.seen.length, hops + 1)
    assert.equal(out.balance.balance, 13.5)
  })

  await check('确认后重复确认同 ID 幂等；换 ID 仍拒', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    assert.equal(p.confirmAccount('777').identifier, '777')
    await expectCode(() => p.confirmAccount('778'), CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH, '冻结后换 ID')
    assert.equal(p.describe().state, 'verified')
  })

  // ── 3. 严格模式：读余额兼容，但导出仍须本人确认 ────────────────────────────
  await check('严格 expected 模式：登录即 verified、读余额照旧；导出在确认前拒', async () => {
    const sc = scenario()
    const { p, dl } = mkStrict(sc)
    await p.login({ deadlineAt: dl() })
    assert.equal(p.describe().state, 'verified')
    assert.equal(p.pendingAccount(), null, '严格模式没有候选确认阶段')
    const out = await p.readBalance({ deadlineAt: dl() })
    assert.equal(out.balance.balance, 13.5)
    await expectCode(() => p.exportRememberedAccount(), CONSOLE_PROTOCOL_CODES.CONFIRM_REQUIRED, '预期 ID 不等于保存同意')
    p.confirmAccount('777')
    const saved = p.exportRememberedAccount()
    assert.equal(saved.accountId, '777')
  })

  await check('严格模式身份不一致：登录即拒，不会进入确认态', async () => {
    const sc = scenario({ ssoCallbackCookies: ['api-platform_serviceToken=PT; Path=/; Secure', 'userId=999; Path=/; Secure'] })
    const { p, dl } = mkStrict(sc)
    await expectCode(() => p.login({ deadlineAt: dl() }), CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH, '平台变号')
    assert.equal(p.describe().state, 'new')
    assert.equal(p.pendingAccount(), null)
    assert.equal(countOf(sc.seen, '/api/v1/balance'), 0)
  })

  // ── 4. 导出保真：引号 / 绝对 expiry / 缺 expiry=null ───────────────────────
  await check('导出保留外层引号与服务器绝对 expiry；缺 expiry 维持 null', async () => {
    const absMs = Math.floor(Date.now() / 1000) * 1000 + 3_600_000   // 秒精度，可与 toUTCString 往返
    const expStr = new Date(absMs).toUTCString()
    const sc = scenario({
      lpBody: JSON.stringify({ location: CB, passToken: 'QUOTEDTOKEN', userId: '777' }),
      lpHeaderCookies: [
        'passToken="QUOTEDTOKEN"; Path=/; Secure; HttpOnly; Expires=' + expStr,
        'deviceId=DEV1; Path=/; Secure'
      ]
    })
    const { p, dl } = mkStrict(sc)
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    const saved = p.exportRememberedAccount()
    const by = Object.fromEntries(saved.cookies.map(c => [c.name, c]))
    assert.equal(by.passToken.value, '"QUOTEDTOKEN"', '外层引号必须原样保留')
    assert.equal(by.passToken.expiresAt, absMs, '必须是服务器绝对时刻，不是相对 Max-Age')
    assert.equal(by.passToken.httpOnly, true)
    assert.equal(by.userId.expiresAt, null, '缺 expiry 必须是 null（不编 7/30 天）')
    assert.equal(by.deviceId.value, 'DEV1')
    assert.equal(JSON.stringify(saved).includes('3600000'), false, '不得出现相对秒数')
  })

  await check('服务器删除 passToken：记录随之删除，导出不得复活旧值', async () => {
    const sc = scenario({
      lpHeaderCookies: ['passToken=' + SENT_PASS + '; Path=/; Secure; HttpOnly'],
      balanceSeq: null
    })
    const { p, dl } = mkStrict(sc)
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    assert.equal(p.exportRememberedAccount().cookies.some(c => c.name === 'passToken'), true)
    // 平台余额响应里带 passToken 删除行：属于平台域策略，不得影响账号记录
    const sc2 = scenario({
      lpHeaderCookies: ['passToken=' + SENT_PASS + '; Path=/; Secure; HttpOnly'],
      balanceHeaderCookies: ['api-platform_serviceToken=PT2; Path=/; Secure', 'userId=777; Path=/; Secure']
    })
    const h2 = mkStrict(sc2)
    await h2.p.login({ deadlineAt: h2.dl() })
    h2.p.confirmAccount('777')
    await h2.p.readBalance({ deadlineAt: h2.dl() })
    const again = h2.p.exportRememberedAccount()
    assert.equal(again.cookies.some(c => c.name === 'passToken'), true, '平台响应不得删掉账号记录')
    assert.equal(again.cookies.some(c => c.name === 'api-platform_serviceToken'), false)
  })

  // ── 5. 恢复：跨实例、精确 3 跳 ─────────────────────────────────────────────
  await check('合成导出 → 新实例 restore：精确 3 跳、无 QR/无余额、转 verified', async () => {
    const scA = scenario()
    const a = mkFirstScan(scA)
    await a.p.login({ deadlineAt: a.dl() })
    a.p.confirmAccount('777')
    const saved = a.p.exportRememberedAccount()

    const scB = scenario()
    const b = mkStrict(scB)
    await b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() })
    assert.equal(scB.seen.length, 3, 'hops=' + scB.seen.map(u => u.split('?')[0]).join('|'))
    assert.equal(countOf(scB.seen, 'genLoginUrl'), 1)
    assert.equal(countOf(scB.seen, '/pass/serviceLogin'), 1)
    assert.equal(countOf(scB.seen, '/sts'), 1)
    assert.equal(countOf(scB.seen, 'longPolling'), 0, '恢复不得生成二维码')
    assert.equal(countOf(scB.seen, '/api/v1/balance'), 0, '恢复不得读余额')
    assert.equal(b.p.describe().state, 'verified')
    assert.deepEqual(b.p.verifyIdentity(), { namespace: ACCOUNT_NS, identifier: '777' })
    const acc = cookieHeaderOf(scB, '/pass/serviceLogin')
    assert.ok(acc.includes('passToken='), 'SSO 必须携带已保存 passToken')
    assert.equal(acc.includes('api-platform_serviceToken'), false, '不得把平台票带进账号域')
    // 计数固定
    const d = b.p.describe()
    assert.equal(d.restoreAttempts, 1)
    assert.equal(d.restoreSuccesses, 1)
    assert.equal(d.renewalAttempts, 0)
    assert.equal(d.renewalSuccesses, 0)
    // 首读余额只 1 跳
    const hops = scB.seen.length
    const out = await b.p.readBalance({ deadlineAt: b.dl() })
    assert.equal(scB.seen.length, hops + 1, '恢复后首读余额 = 1 跳')
    assert.equal(out.balance.balance, 13.5)
  })

  await check('受信恢复后 export 可直接用（无需再确认），ID 取自已验绑定', async () => {
    const scA = scenario()
    const a = mkStrict(scA)
    await a.p.login({ deadlineAt: a.dl() })
    a.p.confirmAccount('777')
    const saved = a.p.exportRememberedAccount()
    const scB = scenario()
    const b = mkStrict(scB)
    await b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() })
    const again = b.p.exportRememberedAccount()
    assert.equal(again.accountId, '777')
    assert.equal(again.namespace, ACCOUNT_NS)
    assert.deepEqual(again.cookies.map(c => c.name), saved.cookies.map(c => c.name))
  })

  await check('恢复不重置 Path/引号/expiry：再导出逐字段一致', async () => {
    const absMs = Math.floor(Date.now() / 1000) * 1000 + 7_200_000
    const scA = scenario({
      lpBody: JSON.stringify({ location: CB, passToken: 'QUOTED2', userId: '777' }),
      lpHeaderCookies: ['passToken="QUOTED2"; Path=/; Secure; Expires=' + new Date(absMs).toUTCString()]
    })
    const a = mkStrict(scA)
    await a.p.login({ deadlineAt: a.dl() })
    a.p.confirmAccount('777')
    const saved = a.p.exportRememberedAccount()
    const passesBefore = saved.cookies.find(c => c.name === 'passToken')
    assert.equal(passesBefore.expiresAt, absMs)

    const scB = scenario()
    const b = mkStrict(scB)
    await b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() })
    const again = b.p.exportRememberedAccount()
    const passesAfter = again.cookies.find(c => c.name === 'passToken')
    assert.equal(passesAfter.value, '"QUOTED2"', '引号不得被剥离')
    assert.equal(passesAfter.expiresAt, absMs, '绝对 expiry 不得被重置/重算')
    assert.equal(passesAfter.path, '/')
    assert.equal(passesAfter.hostOnly, true)
    assert.equal(passesAfter.secure, true)
  })

  await check('UI 后续：恢复后 describe/verify 不含 raw 哨兵', async () => {
    const scA = scenario()
    const a = mkStrict(scA)
    await a.p.login({ deadlineAt: a.dl() })
    a.p.confirmAccount('777')
    const saved = a.p.exportRememberedAccount()
    const scB = scenario()
    const b = mkStrict(scB)
    await b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() })
    const blob = JSON.stringify(b.p.describe())
    assert.equal(blob.includes(SENT_PASS), false)
    assert.equal(blob.includes(SENT_CUID), false)
    assert.equal(blob.includes('777'), false)
  })

  await check('SSO 删除可选票（Max-Age=0）：私有记录同步删除，导出与恢复都不复活', async () => {
    const SSO_LOC = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
    const sc = scenario({
      lpBody: JSON.stringify({ location: SSO_LOC, passToken: SENT_PASS, userId: '777', cUserId: SENT_CUID }),
      lpHeaderCookies: ['deviceId=DEV1; Path=/; Secure'],
      ssoAccountCookies: ['cUserId=; Max-Age=0; Path=/', 'deviceId=; Max-Age=0; Path=/']
    })
    const { p, dl } = mkStrict(sc)
    await p.login({ deadlineAt: dl() })
    assert.equal(countOf(sc.seen, '/pass/serviceLogin'), 1, '本次确实走了 SSO 删除分支')
    p.confirmAccount('777')
    const saved = p.exportRememberedAccount()
    const names = saved.cookies.map(c => c.name)
    assert.deepEqual(names, ['passToken', 'userId'], '被删除的可选票不得留在导出里：' + names.join(','))
    // 恢复导入同一份导出：不得把已删除的可选票重现
    const scB = scenario()
    const b = mkStrict(scB)
    await b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() })
    const again = b.p.exportRememberedAccount()
    assert.deepEqual(again.cookies.map(c => c.name), ['passToken', 'userId'], '恢复不得复活已删除可选票')
    assert.equal(JSON.stringify(again).includes('DEV1'), false, 'deviceId 值不得复活')
  })

  // ── 6. 恢复校验：全部终止 ─────────────────────────────────────────────────
  const baseSaved = () => ({
    version: 1,
    namespace: ACCOUNT_NS,
    accountId: '777',
    cookies: [
      { name: 'passToken', value: 'PT', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
      { name: 'userId', value: '777', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }
    ]
  })

  await check('restore 非法输入：版本/命名空间/形状/空列表/非法名/平台票混入 全拒', async () => {
    const cases = [
      [{ ...baseSaved(), version: 2 }, CONSOLE_PROTOCOL_CODES.INVALID, 'version'],
      [{ ...baseSaved(), namespace: 'other' }, CONSOLE_PROTOCOL_CODES.INVALID, 'namespace'],
      [{ ...baseSaved(), accountId: '' }, CONSOLE_PROTOCOL_CODES.INVALID, 'accountId 空'],
      [{ ...baseSaved(), cookies: [] }, CONSOLE_PROTOCOL_CODES.INVALID, '空 cookies'],
      [{ ...baseSaved(), cookies: [{ name: 'api-platform_serviceToken', value: 'X', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }] }, CONSOLE_PROTOCOL_CODES.INVALID, '平台票不得入账号记录'],
      [{ ...baseSaved(), cookies: [{ name: 'passToken', value: 'a b', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }] }, CONSOLE_PROTOCOL_CODES.INVALID, '非法字节'],
      [{ ...baseSaved(), cookies: [{ name: 'passToken', value: '"unterminated', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }] }, CONSOLE_PROTOCOL_CODES.INVALID, '引号不闭合']
    ]
    for (const [saved, code, label] of cases) {
      const sc = scenario()
      const { p, dl } = mkStrict(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), code, label)
      assert.equal(sc.seen.length, 0, label + ' 不得发请求')
      assert.equal(p.describe().state, 'new')
    }
  })

  await check('restore 域/Path/同名/过期/缺 ID 终止', async () => {
    const cases = [
      [{ ...baseSaved(), cookies: [{ name: 'passToken', value: 'PT', domain: 'xiaomimimo.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }, baseSaved().cookies[1]] }, CONSOLE_PROTOCOL_CODES.ACCOUNT_COOKIE_DOMAIN, '外域'],
      [{ ...baseSaved(), cookies: [{ name: 'passToken', value: 'PT', domain: 'account.xiaomi.com', path: '/pass', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }, baseSaved().cookies[1]] }, CONSOLE_PROTOCOL_CODES.ACCOUNT_COOKIE_POLICY, 'Path 不是 /'],
      [{ ...baseSaved(), cookies: [baseSaved().cookies[0], baseSaved().cookies[0]] }, CONSOLE_PROTOCOL_CODES.ACCOUNT_COOKIE_DUP_VALUE, '同名冲突'],
      [{ ...baseSaved(), cookies: [baseSaved().cookies[0], { ...baseSaved().cookies[1], expiresAt: 1 }] }, CONSOLE_PROTOCOL_CODES.EXPIRED, '已过期'],
      [{ ...baseSaved(), cookies: [baseSaved().cookies[0]] }, CONSOLE_PROTOCOL_CODES.ACCOUNT_CREDENTIAL_MISSING, '缺 userId'],
      [{ ...baseSaved(), cookies: [{ ...baseSaved().cookies[0] }, { ...baseSaved().cookies[1], value: '999' }] }, CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH, 'userId 与绑定不符'],
      [{ ...baseSaved(), accountId: '999' }, CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH, '绑定不一致']
    ]
    for (const [saved, code, label] of cases) {
      const sc = scenario()
      const { p, dl } = mkStrict(sc)
      await expectCode(() => p.restoreRememberedAccount(saved, { deadlineAt: dl() }), code, label)
      assert.equal(sc.seen.length, 0, label + ' 不得发请求')
    }
  })

  await check('首扫实例（无 expected）不允许 restore；恢复后不允许再 login/restore', async () => {
    const scFs = scenario()
    const fs = mkFirstScan(scFs)
    await expectCode(() => fs.p.restoreRememberedAccount(baseSaved(), { deadlineAt: fs.dl() }), CONSOLE_PROTOCOL_CODES.INVALID, '首扫实例')
    assert.equal(scFs.seen.length, 0)

    const scA = scenario()
    const a = mkStrict(scA)
    await a.p.login({ deadlineAt: a.dl() })
    a.p.confirmAccount('777')
    const saved = a.p.exportRememberedAccount()
    const scB = scenario()
    const b = mkStrict(scB)
    await b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() })
    await expectCode(() => b.p.restoreRememberedAccount(saved, { deadlineAt: b.dl() }), CONSOLE_PROTOCOL_CODES.INVALID, '二次恢复')
    await expectCode(() => b.p.login({ deadlineAt: b.dl() }), CONSOLE_PROTOCOL_CODES.BUSY, '恢复后扫码')
  })

  // ── 7. 自然到期续期 ───────────────────────────────────────────────────────
  await check('平台票自然到期：同一余额操作内 4 跳（SSO3+余额1），计数 1/1', async () => {
    const clock = { t: Date.now() }
    const exp = new Date(Math.floor(clock.t / 1000) * 1000 + 2000).toUTCString()
    const sc = scenario({
      ssoCallbackCookies: [
        'api-platform_serviceToken=PT; Path=/; Secure; Expires=' + exp,
        'userId=777; Path=/; Secure; Expires=' + exp,
        'api-platform_slh=SLH; Path=/; Secure'
      ]
    })
    const { p, dl } = mkStrict(sc, { now: () => clock.t })
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    clock.t += 5000     // 平台票在 jar 中到期
    // 续期换到的是**新**票（真实链路里服务端会新签），这里让回调恢复成无过期票
    sc.state.ssoCallbackCookies = PLATFORM_COOKIES
    const before = sc.seen.length
    const out = await p.readBalance({ deadlineAt: dl() })
    const hops = sc.seen.slice(before)
    assert.equal(hops.length, 4, 'hops=' + hops.map(u => u.split('?')[0]).join('|'))
    assert.equal(hops.filter(u => u.includes('genLoginUrl')).length, 1)
    assert.equal(hops.filter(u => u.includes('/sts')).length, 1)
    assert.equal(hops.filter(u => u.includes('/api/v1/balance')).length, 1)
    assert.equal(out.balance.balance, 13.5)
    const d = p.describe()
    assert.equal(d.renewalAttempts, 1)
    assert.equal(d.renewalSuccesses, 1)
  })

  await check('平台票缺失且账号态也缺失：固定凭据缺失终止，0 余额请求', async () => {
    const clock = { t: Date.now() }
    const exp = new Date(Math.floor(clock.t / 1000) * 1000 + 2000).toUTCString()
    const sc = scenario({
      lpHeaderCookies: [
        'passToken=' + SENT_PASS + '; Path=/; Secure; Expires=' + exp,
        'userId=777; Path=/; Secure; Expires=' + exp
      ],
      ssoCallbackCookies: [
        'api-platform_serviceToken=PT; Path=/; Secure; Expires=' + exp,
        'userId=777; Path=/; Secure; Expires=' + exp
      ]
    })
    const { p, dl } = mkStrict(sc, { now: () => clock.t })
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    clock.t += 5000
    const before = countOf(sc.seen, '/api/v1/balance')
    await expectCode(() => p.readBalance({ deadlineAt: dl() }), CONSOLE_PROTOCOL_CODES.ACCOUNT_CREDENTIAL_MISSING, '双缺失')
    assert.equal(countOf(sc.seen, '/api/v1/balance'), before, '不得把空 Cookie 发出去')
    assert.equal(p.describe().state, 'new')
  })

  await check('401 路径仍是 5 跳且只有一次 SSO（不叠加第二轮）', async () => {
    const sc = scenario({
      balanceSeq: [401, 200],
      balanceHeaderCookies: ['api-platform_serviceToken=PT2; Path=/; Secure', 'userId=777; Path=/; Secure']
    })
    const { p, dl } = mkStrict(sc)
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    const before = sc.seen.length
    const out = await p.readBalance({ deadlineAt: dl() })
    const hops = sc.seen.slice(before)
    assert.equal(hops.length, 5, 'hops=' + hops.length)
    assert.equal(hops.filter(u => u.includes('/sts')).length, 1, '只允许一次 SSO')
    assert.equal(hops.filter(u => u.includes('/api/v1/balance')).length, 2)
    assert.equal(out.balance.balance, 13.5)
    assert.equal(p.describe().renewalAttempts, 1)
    assert.equal(p.describe().renewalSuccesses, 1)
  })

  await check('403→403：终止且无第三次余额读', async () => {
    const sc = scenario({
      balanceSeq: [403, 403],
      balanceHeaderCookies: ['api-platform_serviceToken=PT2; Path=/; Secure', 'userId=777; Path=/; Secure']
    })
    const { p, dl } = mkStrict(sc)
    await p.login({ deadlineAt: dl() })
    p.confirmAccount('777')
    const before = countOf(sc.seen, '/api/v1/balance')
    await expectCode(() => p.readBalance({ deadlineAt: dl() }), CONSOLE_PROTOCOL_CODES.AUTH_REJECTED, '双 403')
    assert.equal(countOf(sc.seen, '/api/v1/balance') - before, 2)
    assert.equal(countOf(sc.seen, '/sts'), 2, '登录 1 次 + 续期 1 次')
  })

  // ── 8. 取消/迟到/dispose 不提交 ───────────────────────────────────────────
  await check('外部取消后迟到 LP 不提交：仍在 new、无候选、无导出', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    const ac = new AbortController()
    let release = null
    const gated = new Promise(resolve => { release = resolve })
    const pLogin = p.login({ deadlineAt: dl(), signal: ac.signal, onQr: async () => { await gated } })
    await new Promise(r => setTimeout(r, 10))
    ac.abort()
    release()
    let caught = null
    try { await pLogin } catch (e) { caught = e }
    assert.ok(caught && KNOWN_CODES.has(caught.code), '必须有固定码')
    assert.equal(p.describe().state, 'new')
    assert.equal(p.pendingAccount(), null)
    assert.equal(countOf(sc.seen, '/api/v1/balance'), 0)
    assert.equal(countOf(sc.seen, '/sts'), 0, '取消后不得再换票')
  })

  await check('dispose 后：pending/confirm/export/restore 全拒（无残留候选）', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    assert.equal(p.pendingAccount().identifier, '777')
    p.dispose()
    assert.equal(p.describe().state, 'stopped')
    await expectCode(() => p.pendingAccount(), CONSOLE_PROTOCOL_CODES.EXPIRED, 'dispose 后 pending')
    await expectCode(() => p.confirmAccount('777'), CONSOLE_PROTOCOL_CODES.EXPIRED, 'dispose 后 confirm')
    await expectCode(() => p.exportRememberedAccount(), CONSOLE_PROTOCOL_CODES.EXPIRED, 'dispose 后 export')
    await expectCode(() => p.restoreRememberedAccount(baseSaved(), { deadlineAt: dl() }), CONSOLE_PROTOCOL_CODES.EXPIRED, 'dispose 后 restore')
  })

  await check('owner 失活后 confirm/export 拒，且不泄露候选', async () => {
    const sc = scenario()
    const { p, live, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    live.owner = false
    await expectCode(() => p.pendingAccount(), CONSOLE_PROTOCOL_CODES.EXPIRED, '失活 pending')
    await expectCode(() => p.confirmAccount('777'), CONSOLE_PROTOCOL_CODES.EXPIRED, '失活 confirm')
    await expectCode(() => p.exportRememberedAccount(), CONSOLE_PROTOCOL_CODES.EXPIRED, '失活 export')
  })

  // ── 9. 计数与固定码卫生 ───────────────────────────────────────────────────
  await check('新建实例计数全 0 且 describe 只有固定字段', () => {
    const sc = scenario()
    const { p } = mkStrict(sc)
    const d = p.describe()
    assert.equal(d.restoreAttempts, 0)
    assert.equal(d.restoreSuccesses, 0)
    assert.equal(d.renewalAttempts, 0)
    assert.equal(d.renewalSuccesses, 0)
    // [2026-11-09 handoff-summary] describe() 增加只读 5 字段安全摘要；本行随之更新（非本轮新增字段）。
    assert.deepEqual(Object.keys(d).sort(), ['code', 'handoffSummary', 'identity', 'renewalAttempts', 'renewalSuccesses', 'restoreAttempts', 'restoreSuccesses', 'state'])
    assert.equal(d.identity, null)
    assert.equal(Object.isFrozen(d), true)
  })

  await check('本套出现的每个错误码都是对外固定枚举', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    const seenCodes = []
    for (const fn of [
      () => p.readBalance({ deadlineAt: dl() }),
      () => p.verifyIdentity(),
      () => p.exportRememberedAccount(),
      () => p.confirmAccount('1')
    ]) {
      try { await fn() } catch (e) { seenCodes.push(e.code) }
    }
    assert.ok(seenCodes.length >= 4)
    for (const c of seenCodes) assert.equal(KNOWN_CODES.has(c), true, '未知码=' + String(c))
  })

  await check('确认动作本身 0 网络请求（describe/pending/confirm/export 全离线）', async () => {
    const sc = scenario()
    const { p, dl } = mkFirstScan(sc)
    await p.login({ deadlineAt: dl() })
    const before = sc.seen.length
    p.pendingAccount(); p.describe(); p.confirmAccount('777'); p.exportRememberedAccount()
    assert.equal(sc.seen.length, before)
  })

  const total = pass + fails.length
  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) {
    for (const f of fails) console.error('FAIL ' + f)
    console.error(summary)
    process.exitCode = 1
  } else {
    console.log(summary + ' (' + total + ')')
  }
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
