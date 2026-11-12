/**
 * 本机显示会话（sessionDisplay）· Host/route 合成回归（2026-11-05）
 *
 * 只用**真实** `handleAuth` 路由 + **真实** `createDisplayManager`，DI 三件套是合成假件：
 *   - 不走网络/DNS/HTTPS、不碰真实账号、不读 profile/cfg/日志；
 *   - 时间用 fakeClock 推进，**不真等 60 s**；
 *   - 只验证：0 自动刷新、单飞、间隔、次数、pending、上限、停止与迟到、换号不混、
 *     身份 blocked/mismatch、临时失败→3 次停、401/403 停、秘密不出 DTO。
 *
 * 运行：node tools/test-mimo-display-session.mjs
 */
import { handleAuth } from '../plans/mimo-auth/routes.js'
import { createSessionManager } from '../plans/mimo-auth/session.js'
import { createDisplayManager, DISPLAY_LIMITS, DISPLAY_CODES } from '../plans/mimo-auth/session-display.js'

const BOOT = '0123456789abcdef0123456789abcdef'
const BOOT2 = 'fedcba9876543210fedcba9876543210'
const NS = 'mimo-platform-synthetic'
const ID = 'synthetic-user-1001'
const SECRET = 'secret-token-do-not-leak'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS ' + name) } else { fail += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))) }
}

// —— fakeClock：所有定时器都由测试推进 ——
let clock = 1000000
let timerSeq = 0
const timers = new Map()
const now = () => clock
function fakeSetTimeout(fn, ms) {
  const id = ++timerSeq
  const handle = { id, at: clock + Math.max(1, ms), unref() {} }
  timers.set(id, { fn, at: handle.at })
  return handle
}
function fakeClearTimeout(handle) {
  if (handle !== null && handle !== undefined && typeof handle.id === 'number') timers.delete(handle.id)
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}
async function advance(ms) {
  const target = clock + ms
  for (;;) {
    let nextId = null
    let nextAt = Infinity
    for (const [id, t] of timers) {
      if (t.at <= target && t.at < nextAt) { nextId = id; nextAt = t.at }
    }
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

// —— 合成 DI（唯一出站边界；生产恒 null） ——
let producerCalls = 0
let verifierCalls = 0
let adapterCalls = 0
let adapterMode = 'ok'
let adapterGate = null
const produced = { token: SECRET, issuedAt: 1 }
const ADAPTER_OK = { ok: true, identity: { namespace: NS, identifier: ID }, balance: { balance: 12.34, cashBalance: 10, giftBalance: 2.34, currency: 'cny' } }
async function producer() {
  producerCalls += 1
  return { credential: produced }
}
async function identityVerifier() {
  verifierCalls += 1
  return { identity: { namespace: NS, identifier: ID } }
}
async function balanceAdapter() {
  adapterCalls += 1
  if (adapterGate !== null) await adapterGate
  if (adapterMode === 'net') return { ok: false, code: 'E_NETWORK' }
  if (adapterMode === 'throw-auth') throw Object.assign(new Error('denied'), { code: 'E_MIMO_AUTH_DISPLAY_AUTH_REJECTED' })
  // 只带 status、不带 code 的抛错：必须与 result 走同一分类（401/403 ⇒ 授权被拒）
  if (adapterMode === 'throw403') throw Object.assign(new Error('forbidden'), { status: 403 })
  if (adapterMode === 'flaky') {
    // 失败/成功交替：不会有 3 次连续暂时失败，因此只能被 attempt 预算挡住。
    if (adapterCalls % 2 === 0) return { ok: false, status: 503, code: 'E_BALANCE_HTTP' }
    return ADAPTER_OK
  }
  if (adapterMode === 'denied') return { ok: false, status: 401, code: 'E_BALANCE_HTTP' }
  if (adapterMode === 'forbidden') return { ok: false, status: 403, code: 'E_BALANCE_HTTP' }
  if (adapterMode === 'other') return { ok: true, identity: { namespace: NS, identifier: 'someone-else' }, balance: ADAPTER_OK.balance }
  if (adapterMode === 'no-identity') return { ok: true, balance: ADAPTER_OK.balance }
  if (adapterMode === 'no-currency') return { ok: true, identity: ADAPTER_OK.identity, balance: { balance: 5 } }
  if (adapterMode === 'garbage') return { ok: false, code: 'E_BALANCE_PARSE' }
  return ADAPTER_OK
}
function makeDisplay() {
  return createDisplayManager({
    producer,
    identityVerifier,
    balanceAdapter,
    namespace: NS,
    now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  })
}
function body(fields) { return fields }
function req(payload) {
  return {
    method: 'POST',
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(payload),
  }
}
function makeManager() { return createSessionManager({ now }) }
async function call(display, payload) {
  const res = await handleAuth(req(payload), {
    bootEpoch: BOOT,
    manager: makeManager(),
    beginFlow: async () => ({ ok: true }),
    cancelFlow: () => {},
    postQrRuntime: null,
    display,
  })
  return { status: res.status, body: await res.json() }
}
async function capabilityOf(display) {
  const res = await handleAuth(
    { method: 'GET', headers: { get: () => null } },
    { bootEpoch: BOOT, manager: makeManager(), beginFlow: async () => ({ ok: true }), cancelFlow: () => {}, display },
  )
  return { status: res.status, body: await res.json() }
}
function expectedOf(identifier) { return { namespace: NS, identifier: identifier === undefined ? ID : identifier } }
async function happyToVerified(display) {
  const started = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: expectedOf() })
  return { started, displayId: started.body.display.displayId, generation: started.body.display.generation }
}

const nativeFetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('native fetch must not be used') }
try {
  // 1) 生产默认：无 DI ⇒ status 是可信 absent（不是通信故障），start/read/grant 503，stop 幂等 200
  {
    const display = createDisplayManager({ now })
    check('disabled: displaySupported false', display.enabled === false)
    const cap = await capabilityOf(display)
    check('disabled: capability 200 + displaySupported false', cap.status === 200 && cap.body.displaySupported === false, cap.body)
    check('disabled: capability namespaces empty', Array.isArray(cap.body.displayNamespaces) && cap.body.displayNamespaces.length === 0)
    const status = await call(display, { action: 'displayStatus', bootEpoch: BOOT })
    check('disabled: status 200 trusted absent', status.status === 200 && status.body.display.displaySupported === false
      && status.body.display.state === 'absent' && status.body.display.selected === false, status.body)
    const start = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: expectedOf() })
    check('disabled: start 503', start.status === 503 && start.body.code === DISPLAY_CODES.DISABLED, start.body)
    const stop = await call(display, { action: 'displayStop', bootEpoch: BOOT, displayId: 'a'.repeat(32), generation: 1 })
    check('disabled: stop 200 idempotent', stop.status === 200 && stop.body.ok === true, stop.body)
  }

  // 2) 严格字段与 boot 校验
  {
    const display = makeDisplay()
    const extra = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: expectedOf(), url: 'https://evil.example/x' })
    check('strict: 越权字段 url ⇒ 400', extra.status === 400 && extra.body.code === 'E_MIMO_AUTH_BAD_REQUEST', extra.body)
    const tokenField = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: expectedOf(), credential: 'x' })
    check('strict: 越权字段 credential ⇒ 400', tokenField.status === 400, tokenField.body)
    const noExpected = await call(display, { action: 'displayStart', bootEpoch: BOOT })
    check('strict: 缺 expected ⇒ 400', noExpected.status === 400, noExpected.body)
    const wrongBoot = await call(display, { action: 'displayStatus', bootEpoch: BOOT2 })
    check('boot: 旧 boot ⇒ 409', wrongBoot.status === 409 && wrongBoot.body.code === 'E_MIMO_AUTH_BOOT_STALE', wrongBoot.body)
    const badNs = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: { namespace: 'other-ns', identifier: ID } })
    check('start: 未知 namespace 拒绝（400）', badNs.status === 400, badNs.body)
    check('start: 被拒后仍是 absent/holding 无票', producerCalls === 0, { producerCalls })
  }

  // 3) happy path：start → status（纯观察）→ read（恰 1 次）→ confirm → grant
  producerCalls = 0
  verifierCalls = 0
  adapterCalls = 0
  adapterMode = 'ok'
  {
    const display = makeDisplay()
    const { started, displayId, generation } = await happyToVerified(display)
    const view = started.body.display
    check('start: 200 verified + mask + 无余额', started.status === 200 && view.state === 'verified'
      && view.identity !== null && typeof view.identity.maskedLabel === 'string' && view.balance === null, view)
    check('start: producer/verifier 各 1、adapter 0', producerCalls === 1 && verifierCalls === 1 && adapterCalls === 0)
    const s1 = await call(display, { action: 'displayStatus', bootEpoch: BOOT })
    const s2 = await call(display, { action: 'displayStatus', bootEpoch: BOOT })
    check('status: 纯观察 0 adapter 调用', s1.status === 200 && s2.status === 200 && adapterCalls === 0)
    check('status: 未比对 ⇒ canGrant false', s1.body.display.canGrant === false)
    const grantEarly = await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    check('grant: 未比对 ⇒ CONFIRM_REQUIRED 且 0 adapter', grantEarly.body.ok === false
      && grantEarly.body.code === DISPLAY_CODES.CONFIRM_REQUIRED && adapterCalls === 0, grantEarly.body)
    const read1 = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    const bal = read1.body.display.balance
    check('read: 200 + 币种归一 CNY + 现金/赠金', read1.status === 200 && bal !== null
      && bal.balance === 12.34 && bal.currency === 'CNY' && bal.cashBalance === 10 && bal.giftBalance === 2.34, bal)
    check('read: adapter 恰 1 次', adapterCalls === 1)
    check('read: awaitingBalanceMatch true', read1.body.display.awaitingBalanceMatch === true)
    const read2 = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    check('read: 第二次被拒且 0 新增 adapter', read2.body.ok === false
      && read2.body.code === DISPLAY_CODES.READ_USED && adapterCalls === 1, read2.body)
    const later = await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'later' })
    check('confirm later: 不给 grant 权限', later.body.ok === true && later.body.display.canGrant === false)
    const grantLater = await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    check('grant after later: CONFIRM_REQUIRED', grantLater.body.code === DISPLAY_CODES.CONFIRM_REQUIRED)
    // 重新读取不可能（单次）；换会话走 match 才能拿 grant —— 这里直接停掉重开
    const stopped = await call(display, { action: 'displayStop', bootEpoch: BOOT, displayId, generation })
    check('stop: 清值 + tombstone selected 保留', stopped.body.ok === true
      && stopped.body.display.state === 'stopped' && stopped.body.display.balance === null
      && stopped.body.display.selected === true, stopped.body.display)
    check('stop: 生产 disabled 之外的 code 是 DISPLAY_STOPPED', stopped.body.display.code === DISPLAY_CODES.STOPPED)
  }

  // 4) grant 之后才有自动刷新：60 s 间隔 + 次数 + 秘密不出 DTO
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    const before = adapterCalls
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    const granted = await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    check('grant: 200 + 0 立即刷新', granted.body.ok === true && adapterCalls === before, { adapterCalls, before })
    await advance(DISPLAY_LIMITS.minIntervalMs - 1000)
    check('grant: 未到 60 s 不刷新', adapterCalls === before, { adapterCalls })
    await advance(1000)
    check('grant: 到 60 s 刷新 1 次', adapterCalls === before + 1, { adapterCalls })
    const afterOne = await call(display, { action: 'displayStatus', bootEpoch: BOOT })
    check('grant: refreshCount 1 / freshness fresh', afterOne.body.display.refreshCount === 1
      && afterOne.body.display.freshness === 'fresh', afterOne.body.display)
    await advance(DISPLAY_LIMITS.minIntervalMs)
    check('grant: 第二次间隔刷新', adapterCalls === before + 2)
    const dump = JSON.stringify(afterOne.body)
    check('秘密哨兵：token/凭据字段不出现在 DTO', !dump.includes(SECRET)
      && !dump.includes('"credential"') && !dump.includes('"expected"') && !dump.includes('"accountRef"'), dump.slice(0, 240))
    const stop = await call(display, { action: 'displayStop', bootEpoch: BOOT, displayId, generation })
    const callsAtStop = adapterCalls
    await advance(DISPLAY_LIMITS.minIntervalMs * 3)
    check('stop 后不再刷新（迟到 timer 不复活）', adapterCalls === callsAtStop, { adapterCalls, callsAtStop })
    check('stop 后状态 stopped', stop.body.display.state === 'stopped')
  }

  // 5) 14 次用尽 ⇒ 停止清值（840 s 仍 < 900 s 本地持有上限）
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    const baseline = adapterCalls
    await advance(DISPLAY_LIMITS.minIntervalMs * (DISPLAY_LIMITS.maxAutoRefresh - 1))
    check('exhaust: 14 次之前仍在 verified', adapterCalls === baseline + (DISPLAY_LIMITS.maxAutoRefresh - 1))
    await advance(DISPLAY_LIMITS.minIntervalMs)
    const view = (await call(display, { action: 'displayStatus', bootEpoch: BOOT })).body.display
    check('exhaust: 用尽即停止清值', view.state === 'stopped' && view.balance === null
      && view.code === DISPLAY_CODES.REFRESH_EXHAUSTED, view)
    check('exhaust: 14 次上限（不超过）', adapterCalls === baseline + DISPLAY_LIMITS.maxAutoRefresh,
      { baseline, adapterCalls, max: DISPLAY_LIMITS.maxAutoRefresh })
    check('exhaust: 本地界 840 s < 900 s 持有上限', DISPLAY_LIMITS.minIntervalMs * DISPLAY_LIMITS.maxAutoRefresh < DISPLAY_LIMITS.credentialHoldMs)
  }

  // 6) 临时失败：1–2 次 stale 保留值，第 3 次停止清值
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    adapterMode = 'net'
    await advance(DISPLAY_LIMITS.minIntervalMs)
    const stale1 = (await call(display, { action: 'displayStatus', bootEpoch: BOOT })).body.display
    check('transient 1: 保留值 + stale + 仍 verified', stale1.state === 'verified'
      && stale1.balance !== null && stale1.freshness === 'stale', stale1)
    await advance(DISPLAY_LIMITS.minIntervalMs)
    const stale2 = (await call(display, { action: 'displayStatus', bootEpoch: BOOT })).body.display
    check('transient 2: 仍 stale 保留值', stale2.state === 'verified' && stale2.balance !== null)
    await advance(DISPLAY_LIMITS.minIntervalMs)
    const stopped = (await call(display, { action: 'displayStatus', bootEpoch: BOOT })).body.display
    check('transient 3: 停止清值', stopped.state === 'stopped' && stopped.balance === null
      && stopped.code === DISPLAY_CODES.TRANSIENT_LIMIT, stopped)
  }

  // 7) 401/403：授权被拒/失效 ⇒ 立刻停清值，**不称过期**
  for (const mode of ['denied', 'forbidden']) {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    adapterMode = mode
    const read = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    const view = read.body.display
    check('auth ' + mode + ': 停止 + 清值 + 不称过期', view.state === 'stopped' && view.balance === null
      && view.code === DISPLAY_CODES.AUTH_REJECTED && view.code !== DISPLAY_CODES.CREDENTIAL_EXPIRED, view)
  }

  // 8) 身份：变号/不明/缺币种 一律停清值
  for (const mode of ['other', 'no-identity', 'no-currency']) {
    adapterMode = mode
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    const read = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    const view = read.body.display
    const expectedCode = mode === 'no-currency' || mode === 'garbage' ? DISPLAY_CODES.BALANCE_PARSE : DISPLAY_CODES.IDENTITY_MISMATCH
    check('identity ' + mode + ': 停止 + 清值', view.state === 'stopped' && view.balance === null
      && view.code === expectedCode, view)
  }
  adapterMode = 'ok'

  // 9) start 时 expected 与可信 verifier 输出不一致 ⇒ 停，0 余额
  {
    const display = makeDisplay()
    const started = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: expectedOf('synthetic-user-9999') })
    check('start mismatch: stopped + 清值 + 0 余额', started.body.display.state === 'stopped'
      && started.body.display.balance === null
      && started.body.display.code === DISPLAY_CODES.IDENTITY_MISMATCH, started.body.display)
    check('start mismatch: tombstone selected 仍 true', started.body.display.selected === true)
  }

  // 10) 单飞：在途刷新不会被同 tick 并发第二个请求
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    let release = null
    adapterGate = new Promise((resolve) => { release = resolve })
    const before = adapterCalls
    await advance(DISPLAY_LIMITS.minIntervalMs)
    check('single-flight: 在途 1 个', adapterCalls === before + 1, { adapterCalls })
    // 只推进 4 s（仍在单次操作 10 s 界内）：应**不**再发第二个请求，也不该被超时终止。
    await advance(4000)
    check('single-flight: 在途期间不叠加第二个', adapterCalls === before + 1, { adapterCalls })
    adapterGate = null
    release()
    await flush()
    check('single-flight: 释放后状态仍 verified', (await call(display, { action: 'displayStatus', bootEpoch: BOOT })).body.display.state === 'verified')
  }

  // 11) 错 id / 错 generation ⇒ 409
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    const wrongId = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId: 'b'.repeat(32), generation })
    check('wrong displayId ⇒ 409 STALE_ID', wrongId.status === 409 && wrongId.body.code === DISPLAY_CODES.STALE_ID, wrongId.body)
    const wrongGen = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation: generation + 5 })
    check('wrong generation ⇒ 409 STALE_ID', wrongGen.status === 409, wrongGen.body)
  }

  // 12) B1 自主到期：**完全不发 status**，只推进时钟 → 凭据/值被 timer 清掉
  {
    const display = makeDisplay()
    await happyToVerified(display)
    const before = adapterCalls
    await advance(DISPLAY_LIMITS.pendingMs)
    const peeked = display.peek() // peek 不触发惰性判定，证明是 timer 干的
    check('B1 自主到期：无 status 也清凭据（PENDING_EXPIRED）', peeked.state === 'stopped'
      && peeked.balance === null && peeked.code === DISPLAY_CODES.PENDING_EXPIRED, peeked)
    check('B1 自主到期：无调度、无值（refreshCount=0）', peeked.refreshCount === 0 && peeked.nextRefreshAt === null)
    check('B1 自主到期：pending 界已清', peeked.pendingExpiresAt === null)
    check('B1 自主到期：selected 墓碑保留', peeked.selected === true)
  }

  // 13) grant 之后 pending 界取消，仅 hold 界生效；到点清值且不再调用
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    const granted = await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    check('grant 后 pending 界取消', granted.body.display.pendingExpiresAt === null, granted.body.display)
    check('grant 后 hold 界仍在', typeof granted.body.display.credentialExpiresAt === 'number')
    await advance(DISPLAY_LIMITS.credentialHoldMs + DISPLAY_LIMITS.minIntervalMs)
    const after = display.peek()
    check('grant 阶段到点后不再 verified 且已清值', after.state !== 'verified' && after.balance === null, after)
    const callsAtEnd = adapterCalls
    await advance(DISPLAY_LIMITS.minIntervalMs * 3)
    check('到期后无新调用（迟到 timer 不复活）', adapterCalls === callsAtEnd)
  }

  // 14) B3 抛错分类：AUTH_REJECTED 视为终止（不是"暂时失败"反复重试）
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    const before = adapterCalls
    adapterMode = 'throw-auth'
    await advance(DISPLAY_LIMITS.minIntervalMs)
    const view = display.peek()
    check('B3 throw AUTH_REJECTED ⇒ 立即停止清值', view.state === 'stopped'
      && view.balance === null && view.code === DISPLAY_CODES.AUTH_REJECTED, view)
    await advance(DISPLAY_LIMITS.minIntervalMs * 3)
    check('B3 终止后不再重试', adapterCalls === before + 1, { adapterCalls, before })
    adapterMode = 'ok'
  }

  // 15) B4 attempt 预算含失败：fail-fail-success 交替也不会超过 14 次请求
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    const before = adapterCalls
    adapterMode = 'flaky'
    await advance(DISPLAY_LIMITS.minIntervalMs * (DISPLAY_LIMITS.maxAutoRefresh + 4))
    const attempts = adapterCalls - before
    check('B4 attempt 上限含失败（≤14 次请求）', attempts <= DISPLAY_LIMITS.maxAutoRefresh, { attempts })
    const view = display.peek()
    check('B4 用尽后停止清值', view.state !== 'verified' && view.balance === null, view)
    adapterMode = 'ok'
  }

  // 16) B2 挂死操作：10 s 超时 = fail-stop（清值、取消 grant、之后的轮次不再发请求）
  {
    const display = makeDisplay()
    const { displayId, generation } = await happyToVerified(display)
    await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId, generation })
    await call(display, { action: 'displayConfirm', bootEpoch: BOOT, displayId, generation, verdict: 'match' })
    await call(display, { action: 'displayGrant', bootEpoch: BOOT, displayId, generation })
    let release = null
    adapterGate = new Promise((resolve) => { release = resolve })
    const before = adapterCalls
    await advance(DISPLAY_LIMITS.minIntervalMs)   // 触发第 1 次尝试（挂住）
    check('B2 挂死：已发出 1 次', adapterCalls === before + 1)
    await advance(DISPLAY_LIMITS.operationTimeoutMs) // 10 s 后超时
    const view = display.peek()
    check('B2 超时 fail-stop：停止 + 清值', view.state === 'stopped' && view.balance === null
      && view.code === DISPLAY_CODES.TIMEOUT, view)
    await advance(DISPLAY_LIMITS.minIntervalMs * 3)
    check('B2 超时后不再重试（无并发请求）', adapterCalls === before + 1, { adapterCalls, before })
    adapterGate = null
    release() // 晚到的外部结果不得复活
    await flush()
    const after = display.peek()
    check('B2 晚到结果不复活', after.state === 'stopped' && after.balance === null, after)
  }
  // 17) B2：旧会话挂死操作 → stop → 新会话；旧 deadline/迟到结果都不许杀新会话
  {
    const display = makeDisplay()
    const a = await happyToVerified(display)
    let releaseOld = null
    adapterGate = new Promise((resolve) => { releaseOld = resolve })
    const hungRead = call(display, { action: 'displayRead', bootEpoch: BOOT, displayId: a.displayId, generation: a.generation })
    await flush()
    const stopA = await call(display, { action: 'displayStop', bootEpoch: BOOT, displayId: a.displayId, generation: a.generation })
    const settledOld = await hungRead
    check('17 旧 op: stop 立即 settle 旧请求（不永挂）', settledOld.body.ok === false
      && settledOld.body.code === DISPLAY_CODES.STALE_ID, settledOld.body.code)
    check('17 旧 op: stop 成功', stopA.body.ok === true)
    const b = await happyToVerified(display)
    check('17 旧 op: 新会话 verified', b.started.body.display.state === 'verified', b.started.body.display.state)
    await advance(DISPLAY_LIMITS.operationTimeoutMs * 3)
    check('17 旧 op: 旧 deadline 已过也不杀新会话', display.peek().state === 'verified', display.peek().state)
    adapterGate = null
    releaseOld()
    await flush()
    check('17 旧 op: 迟到结果不杀新会话', display.peek().state === 'verified'
      && display.peek().displayId === b.displayId, display.peek().displayId)
  }
  // 18) B2：producer 6 s + verifier 5 s 共享**同一个** 10 s 预算 ⇒ 停在 10 s 且 signal 被 abort
  {
    let verifierSawAbort = false
    let verifierSignal = null
    const display = createDisplayManager({
      producer: async () => { await advance(6000); return { credential: { token: 'shared-budget' } } },
      identityVerifier: async ({ signal }) => {
        verifierSignal = signal !== null && signal !== undefined ? signal : null
        await advance(5000)
        if (verifierSignal !== null && verifierSignal.aborted === true) verifierSawAbort = true
        return { identity: { namespace: NS, identifier: ID } }
      },
      balanceAdapter: async () => ADAPTER_OK,
      namespace: NS,
      now,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    })
    const started = await call(display, { action: 'displayStart', bootEpoch: BOOT, expected: expectedOf() })
    const view = started.body.display
    check('18 共享预算: 总 10 s 未完成 ⇒ stopped', view.state === 'stopped', view.state)
    check('18 共享预算: 码是 TIMEOUT（未给 verifier 再开 10 s）', view.code === DISPLAY_CODES.TIMEOUT, view.code)
    check('18 共享预算: verifier 观察到 signal 已 abort', verifierSawAbort === true
      || (verifierSignal !== null && verifierSignal.aborted === true), { saw: verifierSawAbort })
  }
  // 19) B3：throw {status:403}（只有 status、没有 code）⇒ 授权被拒，首读与刷新都必须终止
  {
    adapterMode = 'throw403'
    const display = makeDisplay()
    const a = await happyToVerified(display)
    const read = await call(display, { action: 'displayRead', bootEpoch: BOOT, displayId: a.displayId, generation: a.generation })
    check('19 throw403 首读: stopped + AUTH_REJECTED + 清值', read.body.display.state === 'stopped'
      && read.body.display.code === DISPLAY_CODES.AUTH_REJECTED && read.body.display.balance === null,
      read.body.display.code)
    adapterMode = 'ok'

    const display2 = makeDisplay()
    const b = await happyToVerified(display2)
    await call(display2, { action: 'displayRead', bootEpoch: BOOT, displayId: b.displayId, generation: b.generation })
    await call(display2, { action: 'displayConfirm', bootEpoch: BOOT, displayId: b.displayId, generation: b.generation, verdict: 'match' })
    await call(display2, { action: 'displayGrant', bootEpoch: BOOT, displayId: b.displayId, generation: b.generation })
    adapterMode = 'throw403'
    await advance(DISPLAY_LIMITS.minIntervalMs)
    const view = display2.peek()
    check('19 throw403 刷新: stopped + AUTH_REJECTED + 清值', view.state === 'stopped'
      && view.code === DISPLAY_CODES.AUTH_REJECTED && view.balance === null, view.code)
    adapterMode = 'ok'
  }
} finally {
  globalThis.fetch = nativeFetch
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
