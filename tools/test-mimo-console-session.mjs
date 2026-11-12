/**
 * test-mimo-console-session.mjs — 正式 console 登录 **pre-auth owner**（管理 / 转移 / 释放）
 *
 * 真实链路：真实 `createConsoleSessionManager` + 真实 `console-protocol`
 * + 真实 `console-grants` authority + 真实 `createSecureTransport`。
 * **只** fake DNS 与 `node:https` 的 request（wire），不 fake 协议序列、JSON 解析与状态机。
 *
 * 运行：node tools/test-mimo-console-session.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConsoleSessionManager, CONSOLE_SESSION_NAMESPACE } from '../plans/mimo-auth/console-session.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}

const PUBLIC_IP = '93.184.216.34'
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const REG_LP = 'https://reg.account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SEED = 'SEED-TOKEN-SESSION-SENTINEL'
const EXPECTED_ID = 'session-user-777'
const PLATFORM_COOKIES = [
  'api-platform_serviceToken=PT-SENTINEL; Path=/; Secure',
  'userId=' + EXPECTED_ID + '; Path=/; Secure',
]
const BALANCE_BODY = JSON.stringify({ code: 0, data: { balance: 21.5, cashBalance: 20, giftBalance: 1.5, currency: 'CNY' } })
const SSO_LOCATION = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)

// —— 可控 fake clock + fake timer（manager 与 transport 用**同一个** clock） ——
let clock = 5000000
let timerSeq = 0
const timers = new Map()
const now = () => clock
function fakeSetTimeout(fn, ms) {
  const id = ++timerSeq
  const at = clock + Math.max(1, ms)
  timers.set(id, { fn, at })
  return { id, at, unref() {} }
}
function fakeClearTimeout(handle) {
  if (handle !== null && handle !== undefined && typeof handle.id === 'number') timers.delete(handle.id)
}
async function flush() {
  for (let i = 0; i < 24; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 24; i += 1) await Promise.resolve()
}
async function advance(ms) {
  const target = clock + ms
  for (;;) {
    let nextId = null
    let nextAt = Infinity
    for (const [id, timer] of timers) if (timer.at <= target && timer.at < nextAt) { nextId = id; nextAt = timer.at }
    if (nextId === null) break
    const entry = timers.get(nextId)
    timers.delete(nextId)
    clock = entry.at
    entry.fn()
    await flush()
  }
  clock = target
  await flush()
}

function bufOf(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body === null || body === undefined ? '' : String(body))
}
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const key of Object.keys(headers)) lower[key.toLowerCase()] = headers[key]
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
          cancel() { return Promise.resolve() },
        }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}

/** wire：只决定「哪个 URL 回什么字节」，其余（协议/状态机/授权）全是真的。 */
function wire(over = {}) {
  const seen = []
  const state = {
    lpBody: JSON.stringify({ location: CB, passToken: SEED, userId: EXPECTED_ID }),
    qrBody: JSON.stringify({ qr: QR, lp: LP }),
    balanceBody: BALANCE_BODY,
    balanceStatus: 200,
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
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, state.qrBody)
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, state.lpBody)
        else if (url.includes('/pass/serviceLogin')) res = makeResp(200, JSON.stringify({ code: 0, location: CB }), { 'set-cookie': ['passToken=' + SEED + '; Path=/; Secure', 'userId=' + EXPECTED_ID + '; Path=/; Secure'] })
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': PLATFORM_COOKIES })
        else if (url.includes('/api/v1/balance')) res = makeResp(state.balanceStatus, state.balanceStatus === 200 ? state.balanceBody : '')
        else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl }
}

let bootSeq = 0
function mkManager(sc, over = {}) {
  bootSeq += 1
  const bootEpoch = String(bootSeq).padStart(32, '0')
  const manager = createConsoleSessionManager({
    bootEpoch,
    now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    transportDeps: {
      clock: now,                                   // 与 manager 的 now 是同一个 fake clock
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
      request: sc.impl,
    },
    ...over,
  })
  return { manager, bootEpoch }
}
const EXPECTED = Object.freeze({ namespace: CONSOLE_SESSION_NAMESPACE, identifier: EXPECTED_ID })

async function readyManager(sc) {
  const { manager } = mkManager(sc)
  const started = manager.start({ expected: EXPECTED, authConsent: true })
  assert.equal(started.ok, true)
  const begun = manager.begin(started.status.authId, started.status.generation)
  assert.equal(begun.ok, true)
  await begun.done
  await flush()
  assert.equal(manager.status().status.state, 'ready')
  return { manager, id: started.status.authId, gen: started.status.generation }
}

async function main() {
  // ===== 1 纯本地 start =====
  await check('start 纯本地：0 请求、32hex authId、正 generation、120 s 期限', async () => {
    const sc = wire()
    const { manager } = mkManager(sc)
    const before = sc.seen.length
    const out = manager.start({ expected: EXPECTED, authConsent: true })
    assert.equal(out.ok, true)
    assert.match(out.status.authId, /^[a-f0-9]{32}$/)
    assert.equal(out.status.generation, 1)
    assert.equal(out.status.state, 'idle')
    assert.equal(out.status.expiresAt, now() + 120000)
    assert.equal(out.status.canBegin, true)
    assert.equal(sc.seen.length, before, 'start 必须 0 请求')
    manager.dispose()
  })

  await check('start 拒：无 authConsent / 错 namespace / 坏 identifier（均 0 请求）', async () => {
    const sc = wire()
    const { manager } = mkManager(sc)
    assert.equal(manager.start({ expected: EXPECTED }).code, 'E_MIMO_AUTH_BAD_REQUEST')
    assert.equal(manager.start({ expected: EXPECTED, authConsent: 'yes' }).code, 'E_MIMO_AUTH_BAD_REQUEST')
    assert.equal(manager.start({ expected: { namespace: 'other-ns', identifier: EXPECTED_ID }, authConsent: true }).code, 'E_MIMO_AUTH_BAD_REQUEST')
    assert.equal(manager.start({ expected: { namespace: CONSOLE_SESSION_NAMESPACE, identifier: 'has space' }, authConsent: true }).code, 'E_MIMO_AUTH_BAD_REQUEST')
    assert.equal(sc.seen.length, 0)
    manager.dispose()
  })

  await check('status 纯观察：连续观察 0 请求（构造/status 绝不自动 login）', async () => {
    const sc = wire()
    const { manager } = mkManager(sc)
    const started = manager.start({ expected: EXPECTED, authConsent: true })
    for (let i = 0; i < 6; i += 1) manager.status()
    assert.equal(sc.seen.length, 0)
    assert.equal(manager.status().status.authId, started.status.authId)
    manager.dispose()
  })

  // ===== 2 begin：真实 5 跳，balance 0 =====
  await check('begin ACK 后 5 跳（ctx/init/img/lp/callback）、balance 0、state=ready', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    const urls = sc.seen
    assert.equal(urls.filter((u) => u.includes('/api/v1/genLoginUrl')).length, 1)
    assert.equal(urls.filter((u) => u.includes('/longPolling/loginUrl') && u.includes('qs=')).length, 1)
    assert.equal(urls.filter((u) => u.includes('/longPolling/qrImage')).length, 1)
    assert.equal(urls.filter((u) => u === LP).length, 1)
    assert.equal(urls.filter((u) => u.includes('/sts')).length, 1)
    assert.equal(urls.filter((u) => u.includes('/api/v1/balance')).length, 0, '登录阶段不得读余额')
    assert.equal(urls.length, 5, 'seen=' + urls.join('|'))
    const snap = manager.status().status
    assert.equal(snap.state, 'ready')
    assert.equal(snap.canAttach, true)
    assert.ok(snap.identity !== null && snap.identity.maskedLabel.indexOf(EXPECTED_ID) < 0, 'mask 不得含原始 ID')
    assert.equal(manager.begin(id, gen).code, 'E_MIMO_CONSOLE_BEGIN_USED', 'begin 只能一次')
    manager.dispose()
  })

  await check('takeQr 一次性交付内存字节，且 DTO/JSON 内无二维码/无种子', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    const snap = manager.status().status
    assert.equal(snap.hasQr, true)
    const taken = manager.takeQr(id, gen)
    assert.equal(taken.ok, true)
    assert.equal(taken.mime, 'image/png')
    assert.ok(taken.bytes instanceof Uint8Array && taken.bytes.length >= 8 && taken.bytes.length <= 256 * 1024)
    assert.equal(manager.takeQr(id, gen).code, 'E_MIMO_CONSOLE_QR_UNAVAILABLE', '只能取一次')
    const json = JSON.stringify(manager.status())
    assert.equal(json.includes(SEED), false, 'JSON 不得含 passToken 种子')
    assert.equal(json.includes(EXPECTED_ID), false, 'JSON 不得含原始 account id')
    assert.equal(json.includes('xiaomi.com'), false, 'JSON 不得含来源 URL')
    assert.equal(json.includes('longPolling'), false)
    manager.dispose()
  })

  // ===== 3 claim / lease / 凭据 =====
  await check('claim：opaque handle、只一次、状态 claimed，且事后 stop 不停 display', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    const expected = manager.getExpectedForAttach(id, gen)
    assert.deepEqual(expected, { namespace: CONSOLE_SESSION_NAMESPACE, identifier: EXPECTED_ID })
    const claim = manager.claim(id, gen)
    assert.equal(claim.ok, true)
    assert.equal(JSON.stringify(claim.credential), '{}', 'handle 必须是 opaque 空对象')
    assert.deepEqual(Object.keys(claim.credential), [])
    assert.equal(manager.status().status.state, 'claimed')
    assert.equal(manager.claim(id, gen).code, 'E_MIMO_CONSOLE_NOT_READY', '只能 claim 一次')
    // 已 claim：记录级 stop **不**得偷偷停 display 的凭据
    assert.equal(manager.stop(id, gen).ok, true)
    const identity = manager.verifyCredential(claim.credential)
    assert.deepEqual(identity, { identity: { namespace: CONSOLE_SESSION_NAMESPACE, identifier: EXPECTED_ID } })
    const before = sc.seen.length
    const read = await manager.readCredential(claim.credential, { deadlineAt: now() + 10000 })
    assert.equal(read.ok, true)
    assert.equal(read.balance.balance, 21.5)
    assert.equal(read.balance.cashBalance, 20)
    assert.equal(read.balance.giftBalance, 1.5)
    assert.equal(read.balance.currency, 'CNY')
    assert.equal(sc.seen.length, before + 1, '一次读 = 一次 balance 请求')
    assert.equal(manager.disposeCredential(claim.credential), true)
    assert.throws(() => manager.verifyCredential(claim.credential), (e) => e.code === 'E_MIMO_CONSOLE_CREDENTIAL_INVALID')
    await assert.rejects(() => manager.readCredential(claim.credential, { deadlineAt: now() + 10000 }),
      (e) => e.code === 'E_MIMO_CONSOLE_CREDENTIAL_INVALID')
    assert.equal(sc.seen.length, before + 1, 'dispose 之后必须 0 新请求')
    manager.dispose()
  })

  await check('display 释放 claim 后可重新登录；旧 handle 不能影响新代次', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    const first = manager.claim(id, gen)
    const before = sc.seen.length
    assert.equal(manager.start({ expected: EXPECTED, authConsent: true }).code, 'E_MIMO_CONSOLE_SESSION_BUSY')
    assert.equal(manager.disposeCredential(first.credential), true)
    assert.equal(manager.status().status.state, 'stopped')
    assert.equal(manager.status().status.identity, null)
    const next = manager.start({ expected: EXPECTED, authConsent: true })
    assert.equal(next.ok, true)
    assert.equal(next.status.generation, gen + 1)
    assert.equal(manager.disposeCredential(first.credential), false)
    assert.equal(manager.status().status.authId, next.status.authId)
    assert.equal(manager.status().status.state, 'idle')
    assert.equal(sc.seen.length, before, '释放、重建本地会话与迟到旧释放均不得联网')
    manager.dispose()
  })

  await check('余额缺 currency ⇒ BALANCE_PARSE（不造币种、不改口径）', async () => {
    const sc = wire({ balanceBody: JSON.stringify({ code: 0, data: { balance: 9 } }) })
    const { manager, id, gen } = await readyManager(sc)
    const claim = manager.claim(id, gen)
    await assert.rejects(() => manager.readCredential(claim.credential, { deadlineAt: now() + 10000 }),
      (e) => e.code === 'E_MIMO_CONSOLE_BALANCE_PARSE')
    manager.dispose()
  })

  // ===== 4 到期自清（无轮询） =====
  await check('120 s 到期：无人观察也自动清（协议 dispose、审批 resolve false）', async () => {
    const sc = wire({ qrBody: JSON.stringify({ qr: QR, lp: REG_LP }) })
    const { manager, id, gen } = { manager: null, id: null, gen: null }
    const made = mkManager(sc)
    const started = made.manager.start({ expected: EXPECTED, authConsent: true })
    const authId = started.status.authId
    const generation = started.status.generation
    const begun = made.manager.begin(authId, generation)
    await flush()
    const pendingApproval = made.manager.status().status.approval
    assert.ok(pendingApproval !== null, 'regional 目标必须挂待审批')
    // 关键：**完全不调用 status**，只推进 fake clock
    await advance(120001)
    const snap = made.manager.status().status
    assert.equal(snap.state, 'expired')
    assert.equal(snap.approval, null, '到期必须清掉审批')
    assert.equal(snap.hasQr, false)
    // 登录因审批被 resolve(false) 而终止；此后不得再有任何 LP 请求
    await begun.done
    const lpCalls = sc.seen.filter((u) => u === REG_LP).length
    assert.equal(lpCalls, 0, '拒绝后不得发 LP，实际 ' + lpCalls)
    made.manager.dispose()
    void manager; void id; void gen
  })

  // ===== 5 区域审批 approve / deny =====
  await check('regional 审批可见但无 rawURL；deny 立即取消', async () => {
    const sc = wire({ qrBody: JSON.stringify({ qr: QR, lp: REG_LP }) })
    const made = mkManager(sc)
    const started = made.manager.start({ expected: EXPECTED, authConsent: true })
    const begun = made.manager.begin(started.status.authId, started.status.generation)
    await flush()
    const approval = made.manager.status().status.approval
    assert.ok(approval !== null)
    assert.match(approval.approvalId, /^[a-f0-9]{32}$/)
    assert.equal(approval.origin, 'reg.account.xiaomi.com')
    assert.equal(approval.purpose, 'consoleAuthResult')
    assert.equal(approval.method, 'GET')
    const json = JSON.stringify(approval)
    assert.equal(json.includes('/longPolling'), false, '审批 DTO 不得含 rawURL/query')
    assert.equal(json.includes('k=1'), false, '审批 DTO 不得含 query')
    // 错 id 拒绝、不生效
    assert.equal(made.manager.approve(started.status.authId, started.status.generation, 'f'.repeat(32)).code,
      'E_MIMO_AUTH_APPROVAL_UNKNOWN')
    assert.equal(made.manager.deny(started.status.authId, started.status.generation, approval.approvalId).ok, true)
    const done = await begun.done
    assert.equal(done.ok, false)
    assert.equal(made.manager.status().status.state, 'failed')
    assert.equal(sc.seen.filter((u) => u === REG_LP).length, 0, 'deny 后不得发 LP')
    made.manager.dispose()
  })

  await check('regional 审批 approve 后继续同一 LP（1 次），并完成登录', async () => {
    const sc = wire({ qrBody: JSON.stringify({ qr: QR, lp: REG_LP }) })
    const made = mkManager(sc)
    const started = made.manager.start({ expected: EXPECTED, authConsent: true })
    const begun = made.manager.begin(started.status.authId, started.status.generation)
    await flush()
    const approval = made.manager.status().status.approval
    assert.equal(made.manager.approve(started.status.authId, started.status.generation, approval.approvalId).ok, true)
    const done = await begun.done
    assert.equal(done.ok, true, JSON.stringify(done.code))
    assert.equal(made.manager.status().status.state, 'ready')
    assert.equal(sc.seen.filter((u) => u === REG_LP).length, 1, '批准后只发一次已批准 LP')
    assert.equal(sc.seen.filter((u) => u.includes('/api/v1/balance')).length, 0)
    made.manager.dispose()
  })

  // ===== 6 stop / dispose =====
  await check('stop（未 claim）：状态 stopped 且旧 handle 不能复活', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    assert.equal(manager.stop(id, gen).ok, true)
    assert.equal(manager.status().status.state, 'stopped')
    assert.equal(manager.claim(id, gen).ok, false, 'stop 之后不得再 claim')
    const before = sc.seen.length
    manager.status()
    assert.equal(sc.seen.length, before)
    manager.dispose()
  })

  await check('dispose：supported=false、0 新请求；已 claim 的 handle 由 display 侧释放（顺序约定）', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    const claim = manager.claim(id, gen)
    manager.dispose()
    const snap = manager.status().status
    assert.equal(snap.supported, false)
    assert.equal(snap.state, 'claimed', '已移交 display 的记录不被 console.dispose 改写成 stopped')
    const before = sc.seen.length
    manager.status()
    manager.status()
    await flush()
    assert.equal(sc.seen.length, before, 'dispose 之后 status 不得发请求')
    // 约定：Host 先 disposeCredential（display 的 disposer），再清 console manager。
    // 因此这里**不**主张 manager.dispose 会杀掉 display 的凭据；显式释放后才失效，且 0 新请求。
    assert.equal(manager.disposeCredential(claim.credential), true)
    assert.throws(() => manager.verifyCredential(claim.credential), (e) => e.code === 'E_MIMO_CONSOLE_CREDENTIAL_INVALID')
    assert.equal(sc.seen.length, before, '释放后不得再发请求')
  })

  await check('新 start 换代次：revision 单调（不因新 gen 重置）', async () => {
    const sc = wire()
    const { manager } = mkManager(sc)
    const a = manager.start({ expected: EXPECTED, authConsent: true })
    const rev1 = a.status.revision
    manager.stop(a.status.authId, a.status.generation)
    const rev2 = manager.status().status.revision
    const b = manager.start({ expected: EXPECTED, authConsent: true })
    assert.ok(b.status.revision > rev2 && rev2 > rev1, 'revision 必须单调：' + [rev1, rev2, b.status.revision].join(','))
    assert.equal(b.status.generation, 2)
    manager.dispose()
  })

  await check('run 中已有 active 记录时再 start ⇒ BUSY，且不覆盖旧记录', async () => {
    const sc = wire({ qrBody: JSON.stringify({ qr: QR, lp: REG_LP }) })
    const made = mkManager(sc)
    const started = made.manager.start({ expected: EXPECTED, authConsent: true })
    const begun = made.manager.begin(started.status.authId, started.status.generation)
    await flush()
    const again = made.manager.start({ expected: EXPECTED, authConsent: true })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'E_MIMO_CONSOLE_SESSION_BUSY')
    assert.equal(made.manager.status().status.authId, started.status.authId, '旧记录不得被覆盖')
    made.manager.stop(started.status.authId, started.status.generation)
    await begun.done
    made.manager.dispose()
  })

  await check('错 authId/generation ⇒ STALE_ID（不误操作当前记录）', async () => {
    const sc = wire()
    const { manager, id, gen } = await readyManager(sc)
    const wrongGen = gen + 7
    assert.equal(manager.stop(id, wrongGen).code, 'E_MIMO_CONSOLE_STALE_ID')
    assert.equal(manager.takeQr(id, wrongGen).code, 'E_MIMO_CONSOLE_STALE_ID')
    assert.equal(manager.claim('a'.repeat(32), gen).code, 'E_MIMO_CONSOLE_STALE_ID')
    assert.equal(manager.getExpectedForAttach('a'.repeat(32), gen), null)
    assert.equal(manager.status().status.state, 'ready', '错 id 不得改动当前记录')
    manager.dispose()
  })

  await check('SSO 分支（lp.location 指向账号域）也完成：5 跳 + callback，balance 0', async () => {
    const sc = wire({ lpBody: JSON.stringify({ location: SSO_LOCATION, passToken: SEED, userId: EXPECTED_ID }) })
    const { manager } = await readyManager(sc)
    const urls = sc.seen
    assert.equal(urls.filter((u) => u.includes('/pass/serviceLogin')).length, 1)
    assert.equal(urls.filter((u) => u.includes('/sts')).length, 1)
    assert.equal(urls.filter((u) => u.includes('/api/v1/balance')).length, 0)
    assert.equal(manager.status().status.state, 'ready')
    manager.dispose()
  })

  console.log(pass + ' passed, ' + fails.length + ' failed')
  if (fails.length > 0) { for (const f of fails) console.log('FAIL ' + f); process.exitCode = 1 }
}

main()
