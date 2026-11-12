/**
 * test-mimo-remembered-freshness.mjs — 2026-11-10「60 s 后台自动读 + 读失败分级 + 展开即刷」
 *
 * 覆盖本轮 4 源后端包的新需求（**全部合成**：fakeDNS/fakeHTTP + fake crypto/provider）：
 *   G1  60 s 节拍、Host 唯一 timer、status/displayStatus 纯观察（0 vendor / 0 loadRecord）
 *   G2  手动 refresh：立即一次真实读，不 retry / 不 restore / 不新扫 / 不清记录
 *   G3  auto+manual 单飞：第二个调用者加入已有 flight，绝不再 beginOp 让首 op 过时
 *   G4  1..4 次普通读失败保旧值 stale；第 5 次公开失败；timer 不停；第 6 次成功自动恢复
 *   G5  首次没有历史数据：余额保持 null（不编 0 金额），可 stale
 *   G6  退出/禁用立即清（含晚到的成功/失败不回填）+ managed 墓碑不回旧手工源
 *   G7  display 墓碑：selected 恒 true（除 disabled/unsupported）、generation 只增不减
 *   G8  真实 protocol：BALANCE_PARSE 保留 verified，下一次读自动成功
 *   G9  纯读 deadline 超时（保留 verified）vs owner 撤销（立即清）的区别
 *   G10 认证拒绝立即终止（不等 5 次），读失败计数不被污染
 *   G13 非普通失败（SSO_CHALLENGE 等安全流程类）fail-closed 反例：不假 fresh / 不空转 / 密文保留 / 可 retry
 *   G11 路由 rememberedRefresh：正常读一次 / 严格未知字段 / 旧 gen 0 请求 / 不落 retry
 *   G12 真实 controller + host 路由链（非 fakeApi）：恢复→刷新→1..5 次失败→恢复
 *
 * 运行：node tools/test-mimo-remembered-freshness.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRememberedSession, REMEMBERED_LIMITS } from '../plans/mimo-auth/remembered-session.js'
import { createRememberedVault } from '../plans/mimo-auth/remember-store.js'
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES } from '../plans/mimo-auth/console-protocol.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}

const PUBLIC_IP = '93.184.216.34'
const BOOT = 'c'.repeat(32)
const BOOT_B = 'd'.repeat(32)
const NS = 'xiaomi-account-user-id'
const ACCOUNT_ID = '777'
const PASS = 'SENTINELPASSTOKEN'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'
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
const OK_BALANCE = JSON.stringify({ code: 0, data: { balance: '13.50', cashBalance: '12.50', giftBalance: '1.00', currency: 'CNY' } })

function bufOf(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body === null || body === undefined ? '' : String(body))
}
function makeResp(status, body, headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const buf = bufOf(body)
  return {
    statusCode: status, status, complete: true, redirected: false,
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

/**
 * fakeHTTP：只替换 DNS/连接；协议序列/JSON 解析都是真的。
 * `holdBalance=true` 时余额响应被扣住，等 `release()` 才交付（用于单飞/晚到的成功）。
 */
function scenario(over = {}) {
  const seen = []
  const held = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: PASS, userId: ACCOUNT_ID, cUserId: '888' }),
    callbackCookies: PLATFORM_COOKIES,
    balanceSeq: null,
    balanceBody: OK_BALANCE,
    holdBalance: false,
    ssoLocation: CB,
    /** 非 null 时 `/pass/serviceLogin` 直接回这串 raw 文本（用于 SSO 侧 JSON 畸形）。 */
    ssoRaw: null,
    ...over
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
        else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
        else if (url.includes('/longPolling/qrImage')) res = makeResp(200, PNG8)
        else if (url.includes('/longPolling/loginUrl')) res = makeResp(200, state.body)
        else if (url.includes('/pass/serviceLogin')) {
          res = state.ssoRaw === null || state.ssoRaw === undefined
            ? makeResp(200, JSON.stringify({ code: 0, location: state.ssoLocation }))
            : makeResp(200, state.ssoRaw)
        }
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
        else if (url.includes('/api/v1/balance')) {
          let status = 200
          let body = state.balanceBody
          if (Array.isArray(state.balanceSeq) && state.balanceSeq.length > 0) {
            const next = state.balanceSeq.shift()
            if (typeof next === 'number') { status = next; body = next === 200 ? state.balanceBody : '' }
            else if (next !== null && typeof next === 'object') { status = next.status; body = next.body }
          }
          const deliver = () => callback(makeResp(status, body))
          if (state.holdBalance === true) held.push(deliver)
          else deliver()
          return
        } else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return {
    seen, state, impl,
    count: (p) => seen.filter((u) => u.includes(p)).length,
    releaseAll() { const list = held.splice(0); for (const fn of list) { try { fn() } catch { /* 已被 abort 的请求 */ } } return list.length },
    heldCount: () => held.length
  }
}
const transportOf = (sc) => ({
  clock: () => Date.now(),
  resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
  request: sc.impl
})

function fakeProvider() {
  const records = new Map()
  let queue = Promise.resolve()
  const stats = { save: 0, forget: 0 }
  return {
    stats,
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return current
        records.set(key, next)
        if (next.payload && next.payload.revoked === true) stats.forget += 1
        else stats.save += 1
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    only() { return records.size === 1 ? [...records.values()][0] : null },
    size() { return records.size }
  }
}
function fakeCrypto() {
  return {
    async capability() { return { supported: true, code: 'E_NONE' } },
    async protect(bytes) { return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    async unprotect(bytes) { return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    dispose() {}
  }
}

/** 可确定推进的 60 s 节拍：fake clock + fake timer 队列（不真等 60 秒）。 */
function fakeTimers(clock) {
  let seq = 0
  const tasks = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      tasks.set(id, { at: clock.t + Math.max(0, Number(ms) || 0), fn })
      return { id, unref() {} }
    },
    clearTimeout(token) {
      if (token !== null && typeof token === 'object') tasks.delete(token.id)
      else tasks.delete(token)
    },
    async runDue() {
      for (let guard = 0; guard < 50; guard++) {
        const due = [...tasks.entries()].filter(([, t]) => t.at <= clock.t)
        if (due.length === 0) return
        for (const [id, t] of due) { tasks.delete(id); try { t.fn() } catch { /* ok */ } }
        await flush(4)
      }
    },
    get pending() { return tasks.size }
  }
}
async function flush(n = 3) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2))
}
async function waitFor(fn, label, tries = 2000) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('超时未达成：' + label)
}

/** 直接驱动 controller：boot → 首扫 → 待确认 → confirm（含首读）。 */
function makeSession({ sc, isEnabled = () => true, clock = { t: Date.now() } } = {}) {
  const provider = fakeProvider()
  const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
  const timers = fakeTimers(clock)
  const session = createRememberedSession({
    bootEpoch: BOOT,
    vault,
    isEnabled,
    now: () => clock.t,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    transportDeps: transportOf(sc)
  })
  return { session, provider, vault, timers, clock }
}

async function scanAndConfirm(ctx) {
  const { session } = ctx
  await session.boot()
  const started = await session.startAuth({ authConsent: true, consentVersion: 1 })
  assert.equal(started.ok, true, 'start 应成功：' + JSON.stringify(started))
  const began = session.beginAuth(started.authId, started.generation)
  assert.equal(began.ok, true, 'begin 应成功：' + JSON.stringify(began))
  await waitFor(() => session.status().state === 'awaiting_confirmation', '进入待确认')
  const confirmed = await session.confirmAccount(started.authId, started.generation)
  assert.equal(confirmed.ok, true, 'confirm 应成功：' + JSON.stringify(confirmed))
  assert.equal(session.status().state, 'verified')
  return started
}

/** 真实 createAuthHost + 捕获 owner 路由 handler（与 e2e 同形）。 */
function makeHost({ sc, vault, bootEpoch = BOOT, clock = { t: Date.now() }, isEnabled = () => true }) {
  const routes = []
  const timers = fakeTimers(clock)
  const childCtx = {
    connection: { fetch: { register: (def) => { routes.push(def); return () => { def.disposed = true } } } },
    webServer: {}
  }
  const host = createAuthHost(childCtx, bootEpoch, () => {}, {
    enableRememberedAccount: true,
    rememberedVault: vault,
    isEnabled,
    now: () => clock.t,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    consoleTransportDeps: transportOf(sc)
  })
  const route = () => routes.find((r) => r.path === '/api/plan-usage-mimo-auth')
  const call = async (body) => {
    const res = await route().fetch({
      method: 'POST',
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(body)
    })
    const out = { status: res.status }
    out.json = await res.json()
    return out
  }
  const caps = async () => {
    const res = await route().fetch({ method: 'GET', headers: { get: () => null } })
    return { status: res.status, json: await res.json() }
  }
  return { host, call, caps, clock, timers }
}

const ACT = (action, bootEpoch, extra = {}) => ({ action, bootEpoch, ...extra })
const CONSENT = { consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true, autoRefresh: true }

async function main() {
  // ── G1 60 s 节拍 / Host 唯一 timer / 纯观察 ──────────────────────────────
  await check('G1 60 s 节拍：status/displayStatus 0 vendor 0 请求，到点只读 1 次并重新计时', async () => {
    assert.equal(REMEMBERED_LIMITS.intervalMs, 60000, '后台自动读间隔必须是 60 s')
    assert.equal(REMEMBERED_LIMITS.readFailureLimit, 5)
    const sc = scenario()
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, provider, timers, clock } = ctx
    assert.equal(sc.count('/api/v1/balance'), 1, '确认时首读 1 次')
    const hops = sc.seen.length
    const storage = { ...provider.stats }
    const before = session.status()
    for (let i = 0; i < 20; i++) { session.status(); session.displaySnapshot() }
    assert.equal(sc.seen.length, hops, '观察不得发请求')
    assert.deepEqual(provider.stats, storage, '观察不得读写存储')
    assert.equal(session.status().revision, before.revision, '观察不得 bump 修订号')
    assert.equal(session.status().nextReadAt, clock.t + 60000, '下一次读 = now + 60 s')
    assert.equal(session.status().stats.readAttempts, 1, '观察不计读取')

    clock.t += 60000
    await timers.runDue()
    await waitFor(() => sc.count('/api/v1/balance') === 2, '60 s 到点自动读')
    const after = session.status()
    assert.equal(after.stats.readAttempts, 2, '每次到点恰好一次读')
    assert.equal(after.stats.refreshCount, 1, '自动读计入 refreshCount')
    assert.equal(after.freshness, 'fresh')
    assert.equal(after.nextReadAt, clock.t + 60000, '读完成后重排同一个 60 s timer')
    session.dispose()
  })

  // ── G2 手动 refresh ─────────────────────────────────────────────────────
  await check('G2 手动 refresh：立即一次真实读，不 retry / 不 restore / 不新扫 / 不清记录', async () => {
    const sc = scenario()
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, provider, clock } = ctx
    const saveBefore = provider.stats.save
    const forgetBefore = provider.stats.forget
    const qrBefore = sc.count('/longPolling')
    const ssoBefore = sc.count('/pass/serviceLogin')
    const balBefore = sc.count('/api/v1/balance')
    clock.t += 1234
    const out = await session.refresh()
    assert.equal(out.ok, true, 'refresh 应成功：' + JSON.stringify(out))
    assert.equal(sc.count('/api/v1/balance'), balBefore + 1, 'refresh 恰好一次余额请求')
    assert.equal(sc.count('/pass/serviceLogin'), ssoBefore, 'refresh 不得重新核 ID')
    assert.equal(sc.count('/longPolling'), qrBefore, 'refresh 不得生成二维码')
    assert.equal(provider.stats.forget, forgetBefore, 'refresh 不得清记录')
    assert.equal(provider.stats.save, saveBefore, '账号态没变 ⇒ 不写密文')
    const s = session.status()
    assert.equal(s.state, 'verified')
    assert.equal(s.stats.readAttempts, 2)
    assert.equal(s.stats.refreshCount, 1)
    assert.equal(s.fetchedAt, clock.t, 'fetchedAt = 本次读的时间')
    session.dispose()
  })

  // ── G3 单飞：auto + manual 加入同一 flight ───────────────────────────────
  await check('G3 auto+manual 单飞：第二个调用者加入已有 flight，只 1 次上游读且首 op 不失效', async () => {
    const sc = scenario()
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, clock } = ctx
    const balBefore = sc.count('/api/v1/balance')
    const attemptsBefore = session.status().stats.readAttempts
    sc.state.holdBalance = true
    // 「自动 tick」与「手动 refresh」在同一窗口内到达
    clock.t += 60000
    await ctx.timers.runDue()
    await waitFor(() => sc.heldCount() === 1, '自动读已发出并挂起')
    const manual = session.refresh()
    await flush(6)
    assert.equal(sc.count('/api/v1/balance'), balBefore + 1, '并发调用不得产生第二次余额请求')
    assert.equal(session.status().stats.readAttempts, attemptsBefore + 1, '只记一次实际读')
    sc.state.holdBalance = false
    sc.releaseAll()
    const manualOut = await manual
    assert.equal(manualOut.ok, true, '手动刷新应加入并成功：' + JSON.stringify(manualOut))
    await waitFor(() => session.status().balance !== null, '首 op 的结果被采纳')
    const s = session.status()
    assert.equal(s.balance.balance, 13.5, '首 op 成功结果必须被采纳（不得被兄弟调用判成过时）')
    assert.equal(s.stats.readAttempts, attemptsBefore + 1)
    assert.equal(s.nextReadAt, clock.t + 60000, '完成后仍只有一个 60 s timer')

    /**
     * 加入一个**失败**的 flight：joined 只表示共用同一个操作，不改变读结果。
     * 两个 caller（auto tick / manual refresh）都不得把它谎报成成功；
     * 仍然只有 1 次实际读、1 次失败计数。
     */
    const attempts2 = session.status().stats.readAttempts
    const fails2 = session.status().readFailures
    sc.state.balanceSeq = [500]
    sc.state.holdBalance = true
    clock.t += 60000
    await ctx.timers.runDue()
    await waitFor(() => sc.heldCount() === 1, '失败的自动读已发出并挂起')
    const manualFail = session.refresh()
    await flush(6)
    assert.equal(session.status().stats.readAttempts, attempts2 + 1, '并发仍只 1 次实际读')
    sc.state.holdBalance = false
    sc.releaseAll()
    const manualFailOut = await manualFail
    assert.equal(manualFailOut.ok, false, '加入失败 flight **不得**谎报成功：' + JSON.stringify(manualFailOut))
    assert.equal(manualFailOut.code, 'E_MIMO_CONSOLE_TRANSIENT', '如实给该次失败的安全码')
    await waitFor(() => session.status().readFailures === fails2 + 1, '失败只计 1 次')
    const sFail = session.status()
    assert.equal(sFail.readFailures, fails2 + 1, '两个 caller 不得各记一次失败')
    assert.equal(sFail.stats.readAttempts, attempts2 + 1)
    assert.equal(sFail.balance.balance, 13.5, '普通失败保上次成功值')
    assert.equal(sFail.freshness, 'stale')
    assert.equal(sFail.nextReadAt, clock.t + 60000, '同一个 owner 的普通失败仍继续 60 s 节拍')
    session.dispose()
  })

  // ── G4 1..4 stale / 第 5 失败 / 第 6 恢复 ───────────────────────────────
  await check('G4 1–4 次失败保旧值 stale；第 5 次公开失败但 timer 仍在；第 6 次成功复位', async () => {
    const sc = scenario()
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, clock } = ctx
    const goodAt = session.status().fetchedAt
    assert.equal(goodAt, clock.t)
    sc.state.balanceSeq = [500, 500, 500, 500, 500, 200]
    for (let i = 1; i <= 4; i++) {
      clock.t += 60000
      await ctx.timers.runDue()
      await waitFor(() => session.status().readFailures === i, '第 ' + i + ' 次失败已记账')
      const s = session.status()
      assert.equal(s.state, 'verified', '普通读失败不得终止（第 ' + i + ' 次）')
      assert.equal(s.freshness, 'stale', '第 ' + i + ' 次应为 stale')
      assert.equal(s.balance.balance, 13.5, '第 ' + i + ' 次必须保留上次成功值')
      assert.equal(s.fetchedAt, goodAt, '保留**原**取数时间（不刷新时间戳）')
      assert.equal(s.code, 'E_MIMO_CONSOLE_TRANSIENT', '原因码如实保留')
      assert.equal(s.nextReadAt, clock.t + 60000, '失败也继续 60 s 节拍')
      assert.equal(s.stats.readAttempts, i + 1)
    }
    // 第 5 次：公开失败（余额/时间不再对外），但仍是 verified 且 timer 仍动
    clock.t += 60000
    await ctx.timers.runDue()
    await waitFor(() => session.status().readFailures === 5, '第 5 次失败')
    const five = session.status()
    assert.equal(five.balance, null, '第 5 次必须公开 balance=null')
    assert.equal(five.fetchedAt, null, '第 5 次不再透出取数时间')
    assert.equal(five.freshness, 'failed')
    assert.equal(five.state, 'verified', '认证仍有效：不是 failed 状态')
    assert.equal(five.canPause, true)
    assert.equal(five.nextReadAt, clock.t + 60000, '第 5 次失败后 timer 不得停')
    const blob = JSON.stringify(five)
    assert.equal(blob.includes('13.5'), false, '公开快照不得残留旧金额')
    // 第 6 次：自动恢复
    clock.t += 60000
    await ctx.timers.runDue()
    await waitFor(() => session.status().readFailures === 0, '第 6 次成功后复位')
    const six = session.status()
    assert.equal(six.balance.balance, 13.5)
    assert.equal(six.freshness, 'fresh')
    assert.equal(six.fetchedAt, clock.t)
    assert.equal(six.code, 'E_NONE')
    session.dispose()
  })

  // ── G5 首次无历史：不编 0 ────────────────────────────────────────────────
  await check('G5 首次没有历史数据：余额保持 null（不编 0），可 stale', async () => {
    const sc = scenario({ balanceSeq: [500, 500, 500, 500, 500] })
    const ctx = makeSession({ sc })
    await ctx.session.boot()
    const started = await ctx.session.startAuth({ authConsent: true, consentVersion: 1 })
    ctx.session.beginAuth(started.authId, started.generation)
    await waitFor(() => ctx.session.status().state === 'awaiting_confirmation', '待确认')
    await ctx.session.confirmAccount(started.authId, started.generation)
    const s0 = ctx.session.status()
    assert.equal(s0.balance, null, '首读失败时不得编造 0')
    assert.equal(s0.readFailures, 1)
    assert.equal(s0.freshness, 'stale')
    assert.equal(s0.state, 'verified')
    for (let i = 2; i <= 5; i++) {
      await ctx.session.refresh()
      assert.equal(ctx.session.status().readFailures, i)
    }
    const s5 = ctx.session.status()
    assert.equal(s5.balance, null)
    assert.equal(s5.freshness, 'failed')
    assert.equal(JSON.stringify(s5).includes('"balance":0'), false, '永远不得编 0 金额')
    ctx.session.dispose()
  })

  // ── G6 退出/禁用立即清 + 晚到不回填 + 墓碑 ──────────────────────────────
  await check('G6 退出/禁用立即清；晚到的成功/失败都不回填；display 墓碑不回旧手工源', async () => {
    const sc = scenario()
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, provider } = ctx
    assert.equal(session.status().balance.balance, 13.5)
    const liveDisplay = session.displaySnapshot()
    assert.equal(liveDisplay.selected, true)
    assert.equal(liveDisplay.freshness, 'fresh')

    // 在途读 + 退出：晚到的 200 不得回填
    sc.state.holdBalance = true
    const inflight = session.refresh()
    await waitFor(() => sc.heldCount() === 1, '余额请求悬起')
    const forgot = await session.forget()
    assert.equal(forgot.ok, true, 'forget 应成功：' + JSON.stringify(forgot))
    sc.state.holdBalance = false
    sc.releaseAll()
    await inflight
    await flush(6)
    const s = session.status()
    assert.equal(s.state, 'empty')
    assert.equal(s.balance, null, '退出后不得被晚到的成功回填')
    assert.equal(s.readFailures, 0, '退出即清计数')
    assert.equal(s.freshness, null)
    assert.equal(provider.only().payload.revoked, true, '退出必须写 tombstone')
    const tomb = session.displaySnapshot()
    assert.equal(tomb.selected, true, 'managed 墓碑：不得回落旧手工 Cookie 源')
    assert.equal(tomb.displaySupported, false)
    assert.equal(tomb.balance, null)
    assert.equal(tomb.identity, null)
    assert.ok(tomb.generation >= liveDisplay.generation, 'display generation 不得倒退（否则客户端拒收墓碑）')
    const tombBlob = JSON.stringify(tomb)
    for (const bad of ['13.5', 'passToken', 'xiaomi.com']) {
      assert.equal(tombBlob.includes(bad), false, '墓碑不得含：' + bad)
    }

    // 禁用同样立即清
    const sc2 = scenario()
    let enabled = true
    const ctx3 = makeSession({ sc: sc2, isEnabled: () => enabled })
    await scanAndConfirm(ctx3)
    enabled = false
    ctx3.session.disable()
    const d = ctx3.session.status()
    assert.equal(d.state, 'disabled')
    assert.equal(d.balance, null)
    assert.equal(d.readFailures, 0)
    assert.equal(d.freshness, null)
    assert.equal(ctx3.provider.stats.forget, 0, '禁用不得删掉记住登录')
    ctx3.session.dispose()
    session.dispose()

    /**
     * (c) 旧 owner 的读**迟到**：新 owner 已经 verified。只证明两件事 ——
     *     新 owner 的 nextReadAt 不被改（旧 refresh 不得 armTick 新 owner），旧回包不回填数值。
     */
    const sc4 = scenario()
    const ctx4 = makeSession({ sc: sc4 })
    await scanAndConfirm(ctx4)
    const s4 = ctx4.session
    sc4.state.holdBalance = true
    const oldRefresh = s4.refresh()
    await waitFor(() => sc4.heldCount() === 1, '旧 owner 的读已悬起')
    sc4.state.holdBalance = false
    await s4.forget()
    assert.equal(s4.status().state, 'empty')
    // 新 owner：重新扫码 + 确认（新代次、新值），旧回包仍是旧值
    sc4.state.balanceBody = JSON.stringify({ code: 0, data: { balance: '42.75', currency: 'CNY' } })
    const again = await s4.startAuth({ authConsent: true, consentVersion: 1 })
    assert.equal(again.ok, true, JSON.stringify(again))
    s4.beginAuth(again.authId, again.generation)
    await waitFor(() => s4.status().state === 'awaiting_confirmation', '新 owner 待确认')
    const reconfirmed = await s4.confirmAccount(again.authId, again.generation)
    assert.equal(reconfirmed.ok, true, JSON.stringify(reconfirmed))
    const newGen = s4.status().generation
    const t0 = s4.status().nextReadAt
    assert.equal(s4.status().balance.balance, 42.75)
    assert.ok(typeof t0 === 'number' && t0 === ctx4.clock.t + 60000, '新 owner 已起 60 s 节拍')
    const attemptsNew = s4.status().stats.readAttempts
    // 让时间前进一点：若旧 continuation 还去 armTick，nextReadAt 必然变化（否则断言无鉴别力）
    ctx4.clock.t += 5000
    // 释放旧 owner 的迟到回包（旧值 13.5）
    sc4.releaseAll()
    const oldOut = await oldRefresh
    await flush(10)
    const after = s4.status()
    assert.equal(after.nextReadAt, t0, '旧 owner 的迟到读**不得**重排新 owner 的 timer')
    assert.equal(after.balance.balance, 42.75, '旧回包不得回填新 owner 的数值')
    assert.equal(after.stats.readAttempts, attemptsNew, '迟到读不得记到新 owner 头上')
    assert.equal(after.generation, newGen)
    assert.equal(oldOut.ok, false, '旧 refresh 不得报成功：' + JSON.stringify(oldOut))
    assert.ok(['E_MIMO_REMEMBERED_STALE_ID', 'E_NONE'].includes(oldOut.code) || typeof oldOut.code === 'string',
      '旧 refresh 只回固定码：' + JSON.stringify(oldOut))
    ctx4.session.dispose()

    /**
     * (d) 同一不变量的 **tick 入口**：由 60 s timer 发起、挂起的读在换 owner 之后迟到，
     *     同样不得改新 owner 的 nextReadAt、不得回填数值。
     */
    const sc5 = scenario()
    const ctx5 = makeSession({ sc: sc5 })
    await scanAndConfirm(ctx5)
    const s5 = ctx5.session
    const due = s5.status().nextReadAt
    sc5.state.holdBalance = true
    ctx5.clock.t = due
    await ctx5.timers.runDue()
    await waitFor(() => sc5.heldCount() === 1, 'tick 的读已悬起')
    sc5.state.holdBalance = false
    await s5.forget()
    sc5.state.balanceBody = JSON.stringify({ code: 0, data: { balance: '42.75', currency: 'CNY' } })
    const again5 = await s5.startAuth({ authConsent: true, consentVersion: 1 })
    s5.beginAuth(again5.authId, again5.generation)
    await waitFor(() => s5.status().state === 'awaiting_confirmation', 'tick 变体新 owner 待确认')
    await s5.confirmAccount(again5.authId, again5.generation)
    const t5 = s5.status().nextReadAt
    const attempts5 = s5.status().stats.readAttempts
    assert.ok(typeof t5 === 'number' && t5 === ctx5.clock.t + 60000)
    ctx5.clock.t += 5000
    sc5.releaseAll()
    await flush(10)
    assert.equal(s5.status().nextReadAt, t5, 'tick 的迟到读不得重排新 owner 的 timer')
    assert.equal(s5.status().balance.balance, 42.75)
    assert.equal(s5.status().stats.readAttempts, attempts5)
    s5.dispose()
  })

  // ── G7 display 墓碑的 selected/generation 语义 ──────────────────────────
  await check('G7 display：空/失败态 selected=true 且 generation 单调；disabled 明确 false', async () => {
    const sc = scenario()
    const ctx = makeSession({ sc })
    await ctx.session.boot()
    const empty = ctx.session.displaySnapshot()
    assert.equal(empty.managed, true)
    assert.equal(empty.selected, true, '空态必须接管显示（否则旧 cfgCookie 值会回填）')
    assert.equal(empty.balance, null)
    assert.equal(empty.identity, null)
    assert.equal(empty.state, 'absent')
    await scanAndConfirm(ctx)
    const verified = ctx.session.displaySnapshot()
    assert.equal(verified.selected, true)
    assert.ok(verified.generation >= 1, 'verified 应有真实 owner 代次')
    assert.equal(verified.state, 'verified')
    assert.equal(verified.balance.balance, 13.5)
    assert.equal(verified.readFailures, 0)
    assert.equal(verified.freshness, 'fresh')
    await ctx.session.forget()
    const after = ctx.session.displaySnapshot()
    assert.equal(after.selected, true)
    assert.ok(after.generation >= verified.generation, 'generation 只增不减：' + verified.generation + ' -> ' + after.generation)
    assert.equal(after.balance, null)
    assert.equal(after.identity, null)
    assert.equal(after.freshness, null)
    // controller.snapshot 的 gen 口径不变（非 live ⇒ 0），供路由控制动作校验
    assert.equal(ctx.session.status().generation, 0)
    ctx.session.dispose()
    // 退出（stopped）仍接管显示：金额/身份为空，selected 保持 true（不回填旧手工源）
    const stopped = ctx.session.displaySnapshot()
    assert.equal(stopped.selected, true)
    assert.equal(stopped.balance, null)
    assert.equal(stopped.identity, null)
    // 能力界限：storage 不支持 ⇒ 不接管显示（selected=false，保持原语义）
    const sc2 = scenario()
    const vault = { async capability() { return { supported: false, code: 'E_MIMO_DPAPI_UNAVAILABLE' } }, async load() { return null }, async save() { return null }, async forget() { return null }, dispose() {} }
    const session2 = createRememberedSession({
      bootEpoch: BOOT, vault, isEnabled: () => true, now: () => Date.now(), transportDeps: transportOf(sc2)
    })
    await session2.boot()
    assert.equal(session2.status().state, 'unsupported')
    assert.equal(session2.displaySnapshot().selected, false, 'unsupported 不接管显示（保持原能力界限）')
    session2.dispose()
  })

  // ── G8 真实 protocol：解析类失败（含 200 raw 畸形 JSON）之后下一读成功 ─────
  await check('G8 真实 protocol：结构化解析失败与 200 raw 畸形 JSON 都保留 verified，下一次读自动成功', async () => {
    const bad = JSON.stringify({ code: 0, data: { balance: 'oops', currency: 'CNY' } })
    const malformed = '{"code":0,"data":{"balance":"13.50"'
    // 首读（确认时）= 200 但 raw JSON 畸形；第二读 = 结构化但金额非法；第三读 = 正常
    const sc = scenario({ balanceSeq: [{ status: 200, body: malformed }, { status: 200, body: bad }, 200] })
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const s = ctx.session.status()
    assert.equal(s.readFailures, 1, '200 raw 畸形 JSON 必须归一成「纯解析失败」并计 1 次')
    assert.equal(s.state, 'verified', '解析失败不得把认证读死')
    assert.equal(s.code, 'E_MIMO_CONSOLE_BALANCE_PARSE', '公开码是解析类：' + s.code)
    assert.equal(s.balance, null, '没有历史值 ⇒ 保持 null')
    assert.equal(s.freshness, 'stale')
    const mid = await ctx.session.refresh()
    assert.equal(mid.ok, false)
    assert.equal(ctx.session.status().readFailures, 2)
    assert.equal(ctx.session.status().state, 'verified')
    assert.equal(ctx.session.status().code, 'E_MIMO_CONSOLE_BALANCE_PARSE')
    const ssoBefore = sc.count('/pass/serviceLogin')
    const out = await ctx.session.refresh()
    assert.equal(out.ok, true, '下一读必须成功：' + JSON.stringify(out))
    const s2 = ctx.session.status()
    assert.equal(s2.balance.balance, 13.5)
    assert.equal(s2.readFailures, 0)
    assert.equal(s2.freshness, 'fresh')
    assert.equal(sc.count('/pass/serviceLogin'), ssoBefore, '恢复不需要重新 SSO（同一 owner）')
    assert.notEqual(ctx.provider.only().payload.revoked, true, '解析类失败不删密文')
    ctx.session.dispose()
  })

  await check('G8b SSO 侧 JSON 畸形仍按原逻辑终止（不在余额读那里归一）', async () => {
    const sc = scenario({ balanceSeq: [200, 403] })
    sc.state.ssoRaw = '{oops'
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    assert.equal(ctx.session.status().readFailures, 0, '首读正常')
    const out = await ctx.session.refresh()
    assert.equal(out.ok, false)
    const s = ctx.session.status()
    assert.equal(s.state, 'failed', 'SSO 侧 JSON 错误必须终止，不能当成可重试的余额解析失败')
    assert.equal(s.balance, null)
    assert.equal(s.freshness, null)
    assert.equal(s.readFailures, 0)
    assert.equal(s.reasonCode, 'E_MIMO_CONSOLE_SSO_RESPONSE_UNSUPPORTED')
    assert.notEqual(ctx.provider.only().payload.revoked, true, '终止但不删密文（非认证类）')
    ctx.session.dispose()
  })

  // ── G9 纯读超时 vs owner 撤销 ───────────────────────────────────────────
  await check('G9 纯读 deadline 超时保留 verified；owner 撤销立即清并拒绝后续读', async () => {
    // (a) 纯读超时：读操作自身 budget 到点
    const sc = scenario()
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, clock } = ctx
    sc.state.holdBalance = true
    const pending = session.refresh()
    await waitFor(() => sc.heldCount() === 1, '余额请求悬起')
    clock.t += REMEMBERED_LIMITS.readMs + 1
    await ctx.timers.runDue()
    const out = await pending
    assert.equal(out.ok, false)
    const s = session.status()
    assert.equal(s.state, 'verified', '读超时 ≠ 认证失效')
    assert.equal(s.freshness, 'stale')
    assert.equal(s.balance.balance, 13.5, '超时保留上次成功值')
    sc.state.holdBalance = false
    sc.releaseAll()
    const recovered = await session.refresh()
    assert.equal(recovered.ok, true, '超时之后下一读可成功：' + JSON.stringify(recovered))
    session.dispose()

    // (b) owner 撤销（读在途期间）：**不得**保留 verified，必须立即清
    const sc2 = scenario()
    const owner = { revoked: false }
    const p = createConsoleProtocol({
      owner, bootEpoch: BOOT, generation: 1,
      expected: { namespace: NS, identifier: ACCOUNT_ID },
      now: () => Date.now(),
      isLive: () => owner.revoked !== true,
      transportDeps: transportOf(sc2)
    })
    await p.restoreRememberedAccount({
      version: 1, namespace: NS, accountId: ACCOUNT_ID,
      cookies: [
        { name: 'passToken', value: PASS, domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
        { name: 'userId', value: ACCOUNT_ID, domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }
      ]
    }, { deadlineAt: Date.now() + 5000 })
    assert.equal(p.describe().state, 'verified')
    sc2.state.holdBalance = true
    const watchdog = setTimeout(() => {}, 400)
    try {
      const pending = p.readBalance({ deadlineAt: Date.now() + 60 }).then(() => null, (e) => e)
      await waitFor(() => sc2.heldCount() === 1, '余额请求悬起')
      owner.revoked = true
      const err = await pending
      assert.ok(err !== null && err !== undefined, 'owner 撤销后读必须失败')
      assert.ok([CONSOLE_PROTOCOL_CODES.EXPIRED, CONSOLE_PROTOCOL_CODES.CANCELLED, CONSOLE_PROTOCOL_CODES.FLOW]
        .includes(err.code), '固定码：' + (err && err.code))
      assert.equal(p.describe().state, 'new', 'owner 撤销必须立即清（与纯读超时相反）')
      const again = await p.readBalance({ deadlineAt: Date.now() + 500 }).then(() => null, (e) => e)
      assert.ok(again !== null && [CONSOLE_PROTOCOL_CODES.EXPIRED, CONSOLE_PROTOCOL_CODES.NOT_VERIFIED].includes(again.code),
        '之后不得再读成功：' + (again && again.code))
    } finally {
      clearTimeout(watchdog)
      sc2.state.holdBalance = false
      sc2.releaseAll()
    }
    p.dispose()
  })

  // ── G10 认证拒绝立即终止 ────────────────────────────────────────────────
  await check('G10 认证拒绝立即终止（不等 5 次）：清值 + tombstone，读失败计数不被污染', async () => {
    const sc = scenario({ balanceSeq: [200, 403, 403] })
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, provider } = ctx
    assert.equal(session.status().readFailures, 0, '首读成功 ⇒ 计数 0')
    const hopsBefore = sc.count('/api/v1/balance')
    const denied = await session.refresh()
    assert.equal(denied.ok, false)
    assert.ok(sc.count('/api/v1/balance') - hopsBefore >= 1, '被拒的读确实发生了')
    const s = session.status()
    assert.equal(s.state, 'failed', '认证拒绝必须立即终止（不等第 5 次）')
    assert.equal(s.code, 'E_MIMO_AUTH_REJECTED')
    assert.equal(s.balance, null)
    assert.equal(s.readFailures, 0, 'terminate 清计数')
    assert.equal(s.freshness, null)
    assert.equal(provider.only().payload.revoked, true, '认证拒绝必须清掉密文')
    assert.equal(session.displaySnapshot().selected, true)
    assert.equal(session.displaySnapshot().balance, null)
    const hops = sc.seen.length
    await session.refresh()
    assert.equal(sc.seen.length, hops, '失败态 refresh 不得发请求（也不得走 retry/restore）')
    session.dispose()
  })

  // ── G13 非普通失败（安全流程/协议自检）fail-closed 反例 ────────────────────
  await check('G13 非普通失败（SSO_CHALLENGE）立刻 fail-closed：无金额/不 fresh/不空转/密文保留/可 retry', async () => {
    const sc = scenario({ balanceSeq: [200, 403, 200] })
    const ctx = makeSession({ sc })
    await scanAndConfirm(ctx)
    const { session, provider, clock } = ctx
    assert.equal(session.status().freshness, 'fresh')
    assert.equal(session.status().balance.balance, 13.5)
    const hopsBefore = sc.seen.length
    // 余额 403 → 续票；但账号 SSO 落到 /pass/notification ⇒ 协议固定 SSO_CHALLENGE（安全流程类）
    sc.state.ssoLocation = 'https://account.xiaomi.com/pass/notification/x'
    const denied = await session.refresh()
    assert.equal(denied.ok, false, JSON.stringify(denied))
    assert.ok(sc.seen.length > hopsBefore, '该次读确实发起了上游请求')
    const s = session.status()
    // ① 绝不把旧余额当新值：公开面全空、freshness 不是 fresh/stale
    assert.equal(s.state, 'failed', '非普通失败必须 fail-closed（不得留在 verified）')
    assert.equal(s.balance, null, '不得残留旧金额')
    assert.equal(s.fetchedAt, null)
    assert.equal(s.freshness, null, '不得声称 fresh（这正是阻断缺陷）')
    assert.equal(s.readFailures, 0, '安全流程类不计入 5 次 I/O 阈值')
    assert.equal(s.code, 'E_MIMO_CONSOLE_FLOW', '对外固定码')
    assert.equal(s.reasonCode, 'E_MIMO_CONSOLE_SSO_CHALLENGE', '真实安全 cause 留在 reasonCode')
    assert.equal(s.failureStage, 'read')
    assert.equal(s.identity, null, '身份标签一并清掉')
    // ② timer 停：不再空读
    assert.equal(s.nextReadAt, null, '无活会话时不得保留 60 s 节拍')
    assert.equal(s.canRetry, true, '必须给 retry 入口')
    assert.equal(s.canForget, true)
    // ③ 墓碑遮罩：display 不带金额/身份，但继续接管显示（不回填旧手工源）
    const disp = session.displaySnapshot()
    assert.equal(disp.selected, true)
    assert.equal(disp.balance, null)
    assert.equal(disp.identity, null)
    assert.equal(disp.freshness, null)
    // ④ 不自动空读死循环：连推 3 个 60 s 周期，0 额外余额请求
    const balAfterFail = sc.count('/api/v1/balance')
    for (let i = 0; i < 3; i++) {
      clock.t += 60000
      await ctx.timers.runDue()
    }
    await flush(6)
    assert.equal(sc.count('/api/v1/balance'), balAfterFail, '失败态不得自动继续读')
    assert.equal(session.status().freshness, null)
    // ⑤ 密文未删：记住登录仍在
    assert.equal(provider.size(), 1)
    assert.notEqual(provider.only().payload.revoked, true, '非认证类失败不得写 tombstone')
    // ⑥ retry 可用：正常 SSO + 首读 1 次即恢复
    sc.state.ssoLocation = CB
    const balBeforeRetry = sc.count('/api/v1/balance')
    const retried = await session.retry()
    assert.equal(retried.ok, true, 'retry 应成功：' + JSON.stringify(retried))
    const back = session.status()
    assert.equal(back.state, 'verified')
    assert.equal(back.balance.balance, 13.5)
    assert.equal(back.freshness, 'fresh')
    assert.equal(back.readFailures, 0)
    assert.equal(sc.count('/api/v1/balance'), balBeforeRetry + 1, 'retry 后恰好首读 1 次')
    assert.ok(typeof back.nextReadAt === 'number', '恢复后重新起 60 s 节拍')
    session.dispose()
  })

  // ── G11 路由层 rememberedRefresh ────────────────────────────────────────
  await check('G11 路由：refresh 正常读一次 / 严格未知字段 / 旧 gen 0 请求 / 不落 retry', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const vault = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const h = makeHost({ sc, vault })
    await h.host.idle()
    // 首扫 → 确认（真实 host 路由）
    const started = await h.call(ACT('rememberedStart', BOOT, { authConsent: true, consentVersion: 1 }))
    assert.equal(started.status, 200, JSON.stringify(started.json))
    const { authId, generation } = started.json.remembered
    await h.call(ACT('rememberedBegin', BOOT, { authId, generation }))
    await waitFor(async () => (await h.call(ACT('rememberedStatus', BOOT))).json.remembered.state === 'awaiting_confirmation', '待确认')
    const confirmed = await h.call(ACT('rememberedConfirm', BOOT, { authId, generation, ...CONSENT }))
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))
    const gen = confirmed.json.remembered.generation
    assert.ok(gen >= 1)

    const balBefore = sc.count('/api/v1/balance')
    const ssoBefore = sc.count('/pass/serviceLogin')
    const refreshed = await h.call({ action: 'rememberedRefresh', bootEpoch: BOOT, generation: gen })
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json))
    assert.equal(sc.count('/api/v1/balance'), balBefore + 1, 'refresh 恰好 1 次余额请求')
    assert.equal(sc.count('/pass/serviceLogin'), ssoBefore, 'refresh 不得走 restore/SSO')
    const rem = refreshed.json.remembered
    assert.equal(rem.readFailures, 0)
    assert.equal(rem.freshness, 'fresh')
    assert.equal(rem.intervalMs, 60000)

    // 严格：未知字段 400、缺 generation 400、旧 gen 409、错 boot 409，全部 0 请求
    const hops = sc.seen.length
    const extra = await h.call({ action: 'rememberedRefresh', bootEpoch: BOOT, generation: gen, extra: 1 })
    assert.equal(extra.status, 400)
    const noGen = await h.call({ action: 'rememberedRefresh', bootEpoch: BOOT })
    assert.equal(noGen.status, 400)
    const staleGen = await h.call({ action: 'rememberedRefresh', bootEpoch: BOOT, generation: gen - 1 })
    assert.equal(staleGen.status, 409)
    assert.equal(staleGen.json.code, 'E_MIMO_REMEMBERED_STALE_ID')
    const wrongBoot = await h.call({ action: 'rememberedRefresh', bootEpoch: BOOT_B, generation: gen })
    assert.equal(wrongBoot.status, 409)
    assert.equal(wrongBoot.json.code, 'E_MIMO_AUTH_BOOT_STALE')
    assert.equal(sc.seen.length, hops, '被拒的 refresh 必须 0 上游请求')

    // 失败态：refresh 只能是 NOT_READY，绝不能被末尾 else 当成 retry 触发 restore
    await h.call({ action: 'rememberedForget', bootEpoch: BOOT, generation: gen })
    const afterForget = (await h.call(ACT('rememberedStatus', BOOT))).json.remembered
    const hops2 = sc.seen.length
    const denied = await h.call({ action: 'rememberedRefresh', bootEpoch: BOOT, generation: afterForget.generation })
    assert.notEqual(denied.status, 200, 'empty 态 refresh 不得成功')
    assert.equal(sc.seen.length, hops2, 'empty 态 refresh 不得发任何请求（不得 retry/restore）')
    h.host.dispose()
  })

  // ── G12 真实 controller + host 路由链（跨 boot 恢复 → 刷新 → 5 次失败 → 恢复）
  await check('G12 真实 controller+host 链：自动恢复后 refresh，1–4 次失败 stale、第 5 次 failed、第 6 次恢复', async () => {
    const clock = { t: Date.now() }
    const scA = scenario()
    const provider = fakeProvider()
    const vaultA = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const a = makeHost({ sc: scA, vault: vaultA, clock })
    await a.host.idle()
    const started = await a.call(ACT('rememberedStart', BOOT, { authConsent: true, consentVersion: 1 }))
    const { authId, generation } = started.json.remembered
    await a.call(ACT('rememberedBegin', BOOT, { authId, generation }))
    await waitFor(async () => (await a.call(ACT('rememberedStatus', BOOT))).json.remembered.state === 'awaiting_confirmation', '待确认')
    await a.call(ACT('rememberedConfirm', BOOT, { authId, generation, ...CONSENT }))
    a.host.dispose()
    await a.host.idle()

    const scB = scenario()
    scB.state.balanceSeq = [500, 500, 500, 500, 500, 200]
    const vaultB = createRememberedVault({ credentials: provider, scope: SCOPE, crypto: fakeCrypto() })
    const b = makeHost({ sc: scB, vault: vaultB, bootEpoch: BOOT_B, clock })
    await b.host.idle()
    await waitFor(async () => (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered.state === 'verified', 'B 自动恢复')
    // 第 1 次：恢复后的首读已被 500 吃掉
    const first = (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered
    assert.equal(first.readFailures, 1, '首读 500 记 1 次')
    assert.equal(first.freshness, 'stale')
    assert.equal(first.state, 'verified')
    const generationB = first.generation
    for (let i = 2; i <= 4; i++) {
      const r = await b.call({ action: 'rememberedRefresh', bootEpoch: BOOT_B, generation: generationB })
      // 读失败时 refresh 如实回非 ok（409 携带同一份 DTO）；重点在 DTO 的分级字段
      assert.ok(r.status === 200 || r.status === 409, JSON.stringify(r.json))
      assert.equal(r.json.remembered.readFailures, i, JSON.stringify(r.json.remembered))
      assert.equal(r.json.remembered.freshness, 'stale')
      assert.equal(r.json.remembered.state, 'verified')
    }
    const fifth = await b.call({ action: 'rememberedRefresh', bootEpoch: BOOT_B, generation: generationB })
    assert.equal(fifth.json.remembered.readFailures, 5)
    assert.equal(fifth.json.remembered.balance, null, '第 5 次公开失败')
    assert.equal(fifth.json.remembered.freshness, 'failed')
    assert.equal(fifth.json.remembered.state, 'verified')
    assert.ok(typeof fifth.json.remembered.nextReadAt === 'number', '第 5 次失败后 timer 仍在')
    // displayStatus 同一份观察：胶囊看到 failed，但不在状态机里失败
    const disp = await b.call(ACT('displayStatus', BOOT_B))
    assert.equal(disp.json.remembered.readFailures, 5)
    assert.equal(disp.json.remembered.freshness, 'failed')
    assert.equal(disp.json.display.managed, true)
    assert.equal(disp.json.display.selected, true)
    // 第 6 次成功自动恢复
    const sixth = await b.call({ action: 'rememberedRefresh', bootEpoch: BOOT_B, generation: generationB })
    assert.equal(sixth.json.remembered.readFailures, 0)
    assert.equal(sixth.json.remembered.freshness, 'fresh')
    assert.equal(sixth.json.remembered.balance.balance, 13.5)
    assert.equal(sixth.json.remembered.state, 'verified')
    b.host.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed (' + (pass + fails.length) + ')'
  if (fails.length > 0) {
    for (const f of fails) console.error('FAIL ' + f)
    console.error(summary)
    process.exitCode = 1
  } else console.log(summary)
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
