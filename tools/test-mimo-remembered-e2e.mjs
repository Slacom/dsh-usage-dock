/**
 * test-mimo-remembered-e2e.mjs — 「记住登录」managed 模式端到端（全合成，无真实网络/凭据）
 *
 * 真实：`createAuthHost` 注册与路由、`createRememberedSession`、`console-protocol`（真实 A1
 * authority + 真实 `createSecureTransport`）、**真实** `remember-store.js` 的
 * `createRememberedVault`。
 * 合成：node:https/DNS（fakeHTTP）、宿主 credentials provider、DPAPI crypto（fake）。
 * 绝不访问真实 MiMo/小米接口，绝不写真实凭据记录，绝不真跑 DPAPI。
 *
 * 运行：node tools/test-mimo-remembered-e2e.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { createRememberedVault } from '../plans/mimo-auth/remember-store.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}

const PUBLIC_IP = '93.184.216.34'
const BOOT_A = 'a'.repeat(32)
const BOOT_B = 'b'.repeat(32)
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
const ACCOUNT_ID = '777'
const PASS_SENTINEL = 'SENTINELPASSTOKEN'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'

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

/** fakeHTTP：只替换 DNS/连接；协议序列与 JSON 解析都是真的。 */
function scenario(over = {}) {
  const seen = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: PASS_SENTINEL, userId: ACCOUNT_ID, cUserId: '888' }),
    callbackCookies: PLATFORM_COOKIES,
    balanceSeq: null,
    balanceBody: JSON.stringify({ code: 0, data: { balance: '13.50', cashBalance: '12.50', giftBalance: '1.00', currency: 'CNY' } }),
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
        else if (url.includes('/pass/serviceLogin')) res = makeResp(200, JSON.stringify({ code: 0, location: CB }))
        else if (url.includes('/sts')) res = makeResp(200, '', { 'set-cookie': state.callbackCookies })
        else if (url.includes('/api/v1/balance')) {
          if (Array.isArray(state.balanceSeq) && state.balanceSeq.length > 0) {
            const next = state.balanceSeq.shift()
            res = makeResp(next, next === 200 ? state.balanceBody : '')
          } else res = makeResp(200, state.balanceBody)
        } else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl, count: (p) => seen.filter((u) => u.includes(p)).length }
}

/**
 * fake credentials provider：`modifyRecord` **串行排队**，回调 resolve 之后才提交，
 * 与真实 credentials-local.enqueue 语义一致（不是无锁 map）。
 */
function fakeProvider() {
  const records = new Map()
  let queue = Promise.resolve()
  return {
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return undefined
        records.set(key, next)
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    raw() { return new Map(records) },
    only() { return records.size === 1 ? [...records.values()][0] : null }
  }
}

function fakeCrypto(gate = null) {
  return {
    async capability() { return { supported: true, code: 'E_NONE' } },
    async protect(bytes) {
      if (gate !== null) await gate.wait()
      return Uint8Array.from(bytes).map((b) => b ^ 0x5a)
    },
    async unprotect(bytes) {
      if (gate !== null) await gate.wait()
      return Uint8Array.from(bytes).map((b) => b ^ 0x5a)
    },
    dispose() {}
  }
}

function makeGate() {
  let release = null
  const waiters = []
  const promise = new Promise((resolve) => { release = resolve })
  return {
    wait() { waiters.push(1); return promise },
    release() { release() },
    get count() { return waiters.length }
  }
}

function makeVault(provider, opts = {}) {
  return createRememberedVault({
    credentials: provider,
    scope: SCOPE,
    crypto: opts.crypto ?? fakeCrypto()
  })
}

/** 5 min 节拍必须可确定地推进：fake clock + fake timer 队列（不真等 5 分钟）。 */
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
        await new Promise((r) => setTimeout(r, 3))
      }
    },
    get pending() { return tasks.size }
  }
}

/** 真实 createAuthHost + 捕获 owner 路由 handler。 */
function makeHost({ sc, vault, bootEpoch = BOOT_A, clock = { t: Date.now() }, isEnabled = () => true, deps = {} }) {
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
    consoleTransportDeps: {
      clock: () => Date.now(),
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
      request: sc.impl
    },
    ...deps
  })
  const route = () => routes.find((r) => r.path === '/api/plan-usage-mimo-auth')
  const call = async (body) => {
    const res = await route().fetch({
      method: 'POST',
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(body)
    })
    const out = { status: res.status, headers: res.headers }
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('json')) out.json = await res.json()
    else out.bytes = new Uint8Array(await res.arrayBuffer())
    return out
  }
  const caps = async () => {
    const res = await route().fetch({ method: 'GET', headers: { get: () => null } })
    return { status: res.status, headers: res.headers, json: await res.json() }
  }
  return { host, routes, call, caps, clock, timers }
}

async function settle(fn, label, tries = 500) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('超时未达成：' + label)
}

const ACT = (action, bootEpoch, extra = {}) => ({ action, bootEpoch, ...extra })
const CONSENT = { consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true, autoRefresh: true }
/** 控制类动作必须带当前 generation（陈旧视图 0 副作用）。 */
async function ctl(h, action) {
  const st = await h.call(ACT('rememberedStatus', h.host.bootEpoch))
  return h.call({ action: action, bootEpoch: h.host.bootEpoch, generation: st.json.remembered.generation })
}
async function pairedStatus(h, authId, generation) {
  return h.call(ACT('rememberedStatus', h.host.bootEpoch, { authId, generation }))
}


async function firstScan(h, { withQr = true } = {}) {
  const started = await h.call(ACT('rememberedStart', h.host.bootEpoch, { authConsent: true, consentVersion: 1 }))
  assert.equal(started.status, 200, 'start 应成功：' + JSON.stringify(started.json))
  const { authId, generation } = started.json.remembered
  const begun = await h.call(ACT('rememberedBegin', h.host.bootEpoch, { authId, generation }))
  assert.equal(begun.status, 200, 'begin 应成功：' + JSON.stringify(begun.json))
  if (withQr) {
    // 和真实 UI 一样：先观察 hasQr，再一次性取字节（takeQr 是消费式的）
    await settle(async () => {
      const s = await h.call(ACT('rememberedStatus', h.host.bootEpoch))
      return s.json.remembered.hasQr === true
    }, '二维码就绪')
    const qr = await h.call(ACT('rememberedQr', h.host.bootEpoch, { authId, generation }))
    assert.equal(qr.status, 200, 'qr 应可交付')
    assert.ok(qr.bytes && qr.bytes.length >= 8)
  }
  await settle(async () => {
    const s = await h.call(ACT('rememberedStatus', h.host.bootEpoch))
    return s.json.remembered.state === 'awaiting_confirmation'
  }, '进入待确认')
  return { authId, generation }
}

async function main() {
  // ── A. 首扫无输入 → 待确认 → 确认 → 密文 → 首读 ────────────────────────
  await check('A1 首扫：5 跳、有 QR、待确认候选只 owner 可见、0 余额、0 存储写', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider) })
    await h.host.idle()   // 启动自动恢复任务是**独立**任务：先等它落定再观察
    const caps = await h.caps()
    assert.equal(caps.json.rememberedSupported, true)
    assert.equal(caps.json.remembered.storage.supported, true, '真实 vault + fake crypto 应报 supported')
    assert.equal(caps.json.remembered.state, 'empty')
    const { authId, generation } = await firstScan(h)
    assert.equal(sc.seen.length, 5, 'hops=' + sc.seen.length)
    assert.equal(sc.count('/api/v1/balance'), 0, '确认前不得读余额')
    const ps = await pairedStatus(h, authId, generation)
    const rem = ps.json !== undefined && ps.json !== null ? ps.json.remembered : null
    assert.ok(rem !== null && rem !== undefined, 'paired status 必须返回 remembered：status=' + ps.status + ' body=' + JSON.stringify(ps.json))
    assert.equal(rem.state, 'awaiting_confirmation')
    assert.equal(rem.candidate.identifier, ACCOUNT_ID, '候选必须是平台签发的真实 ID')
    assert.equal(rem.candidate.label, '小米账号ID')
    assert.equal(rem.identity, null, '确认前不得有已验证身份标签')
    assert.equal(rem.balance, null)
    assert.equal(provider.raw().size, 0, '确认前不得有任何存储写')
    assert.equal(JSON.stringify(caps.json).includes(ACCOUNT_ID), false, 'caps 不得含完整账号 ID')
    h.host.dispose()
  })

  await check('A2 确认前：错 boot/gen/字段一律拒；旧 display/console 变更动作 0 请求拒绝', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(h)
    const hops = sc.seen.length
    assert.equal((await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId: 'f'.repeat(32), generation, ...CONSENT }))).status, 409)
    assert.equal((await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation: generation + 9, ...CONSENT }))).status, 409)
    assert.equal((await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, identifier: ACCOUNT_ID, ...CONSENT }))).status, 400)
    assert.equal((await h.call(ACT('rememberedStart', h.host.bootEpoch, { authConsent: true, consentVersion: 1, expected: { identifier: ACCOUNT_ID } }))).status, 400)
    const dStart = await h.call(ACT('displayStart', h.host.bootEpoch, { expected: { namespace: 'xiaomi-account-user-id', identifier: ACCOUNT_ID } }))
    assert.equal(dStart.json.code, 'E_MIMO_REMEMBERED_MANAGED_ONLY')
    const cStart = await h.call(ACT('consoleStart', h.host.bootEpoch, { expected: { namespace: 'xiaomi-account-user-id', identifier: ACCOUNT_ID }, authConsent: true }))
    assert.equal(cStart.json.code, 'E_MIMO_CONSOLE_SESSION_DISABLED')
    assert.equal(sc.seen.length, hops, '被拒动作不得产生任何上游请求')
    assert.equal(provider.raw().size, 0)
    h.host.dispose()
  })

  await check('A3 本人确认：只有密文入 provider、首读 1 跳、候选消失、只剩 masked 标签', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(h)
    const hopsBefore = sc.seen.length
    const confirmed = await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, ...CONSENT }))
    assert.equal(confirmed.status, 200, 'confirm 应成功：' + JSON.stringify(confirmed.json))
    assert.equal(sc.seen.length - hopsBefore, 1, '确认后首读=1 跳')
    const rem = confirmed.json.remembered
    assert.equal(rem.state, 'verified')
    assert.equal(rem.candidate, null, '确认后候选必须消失')
    assert.ok(rem.identity && typeof rem.identity.maskedLabel === 'string')
    // 原始 ID 的唯一合法出口是 candidate：确认后必须为 null；identity 只能是 masked
    assert.equal(JSON.stringify(confirmed.json.remembered.candidate), 'null', '确认后响应不得再含候选')
    assert.notEqual(confirmed.json.remembered.identity.maskedLabel, ACCOUNT_ID, 'identity 必须是 masked，不是原始 ID')
    assert.equal(rem.balance.balance, 13.5)
    assert.equal(rem.intervalMs, 60000, '固定 60 s 后台自动读')
    const stored = provider.only()
    assert.ok(stored && stored.kind === 'grant' && typeof stored.payload.ciphertext === 'string')
    const blob = JSON.stringify(stored)
    for (const secret of [ACCOUNT_ID, PASS_SENTINEL, 'account.xiaomi.com', 'passToken']) {
      assert.equal(blob.includes(secret), false, 'provider 里不得出现明文：' + secret)
    }
    h.host.dispose()
  })

  // ── B. 重启自动恢复（跨 boot / 新 host / 同一 scope） ──────────────────
  await check('B1 Host A dispose 存储保留；Host B 自动 restore 3 跳 + 余额 1 跳、0 QR', async () => {
    const scA = scenario()
    const provider = fakeProvider()
    const a = makeHost({ sc: scA, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(a)
    await a.call(ACT('rememberedConfirm', a.host.bootEpoch, { authId, generation, ...CONSENT }))
    assert.equal(provider.raw().size, 1)
    a.host.dispose()
    await a.host.idle()
    assert.equal(provider.raw().size, 1, 'dispose 不得删掉记住登录')

    const scB = scenario()
    const b = makeHost({ sc: scB, vault: makeVault(provider), bootEpoch: BOOT_B })
    await b.host.idle()
    await settle(async () => (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered.state === 'verified', 'B 自动恢复完成')
    assert.equal(scB.count('/longPolling'), 0, '恢复不得生成二维码')
    assert.equal(scB.count('/api/v1/genLoginUrl'), 1)
    assert.equal(scB.count('/pass/serviceLogin'), 1)
    assert.equal(scB.count('/sts'), 1)
    assert.equal(scB.count('/api/v1/balance'), 1, '恢复后首读=1 跳')
    const rem = (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered
    assert.equal(rem.state, 'verified')
    assert.equal(rem.paused, false)
    assert.equal(rem.stats.restoreAttempts, 1)
    assert.equal(rem.stats.restoreSuccesses, 1)
    b.host.dispose()
  })

  await check('B2 恢复后日常刷新：5 min 到点再读一次（同 owner）', async () => {
    const scA = scenario()
    const provider = fakeProvider()
    const a = makeHost({ sc: scA, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(a)
    await a.call(ACT('rememberedConfirm', a.host.bootEpoch, { authId, generation, ...CONSENT }))
    a.host.dispose()
    await a.host.idle()

    const clock = { t: Date.now() }
    const scB = scenario()
    const b = makeHost({ sc: scB, vault: makeVault(provider), bootEpoch: BOOT_B, clock })
    await b.host.idle()
    await settle(async () => (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered.state === 'verified', '恢复完成')
    const before = scB.count('/api/v1/balance')
    clock.t += 300001
    await b.timers.runDue()
    await settle(async () => scB.count('/api/v1/balance') > before, '5 min 后自动刷新')
    assert.equal(scB.count('/api/v1/balance'), before + 1, '每次到点只读 1 次')
    const rem = (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered
    assert.equal(rem.stats.refreshCount, 1, '自动刷新计数=1（首读不计）')
    b.host.dispose()
  })

  // ── C. 绑定不符 / 暂停 / 恢复 / 忘记 ───────────────────────────────────
  await check('C1 恢复时平台签发 ID 与绑定不符：终止、不显示旧值、并清掉密文', async () => {
    const scA = scenario()
    const provider = fakeProvider()
    const a = makeHost({ sc: scA, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(a)
    await a.call(ACT('rememberedConfirm', a.host.bootEpoch, { authId, generation, ...CONSENT }))
    a.host.dispose()
    await a.host.idle()

    const scB = scenario({ callbackCookies: ['api-platform_serviceToken=PT; Path=/; Secure', 'userId=999; Path=/; Secure'] })
    const b = makeHost({ sc: scB, vault: makeVault(provider), bootEpoch: BOOT_B })
    await b.host.idle()
    await settle(async () => (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered.state === 'failed', '应失败')
    const rem = (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered
    assert.equal(rem.code, 'E_MIMO_REMEMBERED_BINDING_MISMATCH')
    assert.equal(rem.balance, null, '不得显示任何旧值')
    assert.equal(provider.only().payload.revoked, true, '绑定不符必须清掉密文（tombstone）')
    b.host.dispose()
  })

  await check('C2 pause：清值 + 密文写 paused；重启 0 账号请求且显示已暂停', async () => {
    const scA = scenario()
    const provider = fakeProvider()
    const a = makeHost({ sc: scA, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(a)
    await a.call(ACT('rememberedConfirm', a.host.bootEpoch, { authId, generation, ...CONSENT }))
    const paused = await ctl(a, 'rememberedPause')
    assert.equal(paused.status, 200, 'pause 应成功：' + JSON.stringify(paused.json))
    assert.equal(paused.json.remembered.state, 'paused')
    assert.equal(paused.json.remembered.balance, null, 'paused 不得冒充 fresh')
    a.host.dispose()
    await a.host.idle()

    const scB = scenario()
    const b = makeHost({ sc: scB, vault: makeVault(provider), bootEpoch: BOOT_B })
    await b.host.idle()
    const rem = (await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered
    assert.equal(rem.state, 'paused')
    assert.equal(rem.paused, true)
    assert.equal(scB.seen.length, 0, '暂停态重启必须 0 账号请求')
    b.host.dispose()
  })

  await check('C3 resume：先核 ID 再读（3+1 跳）', async () => {
    const scA = scenario()
    const provider = fakeProvider()
    const a = makeHost({ sc: scA, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(a)
    await a.call(ACT('rememberedConfirm', a.host.bootEpoch, { authId, generation, ...CONSENT }))
    await ctl(a, 'rememberedPause')
    a.host.dispose()
    await a.host.idle()

    const scB = scenario()
    const b = makeHost({ sc: scB, vault: makeVault(provider), bootEpoch: BOOT_B })
    await b.host.idle()
    assert.equal((await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered.state, 'paused')
    const resumed = await ctl(b, 'rememberedResume')
    assert.equal(resumed.status, 200, 'resume 应成功：' + JSON.stringify(resumed.json))
    assert.equal(scB.count('/pass/serviceLogin'), 1, 'resume 必须重新核 ID')
    assert.equal(scB.count('/api/v1/balance'), 1)
    assert.equal(resumed.json.remembered.state, 'verified')
    b.host.dispose()
  })

  await check('C4 forget：先失效再 tombstone；之后不再恢复，可重新扫码', async () => {
    const scA = scenario()
    const provider = fakeProvider()
    const a = makeHost({ sc: scA, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(a)
    await a.call(ACT('rememberedConfirm', a.host.bootEpoch, { authId, generation, ...CONSENT }))
    const forgotten = await ctl(a, 'rememberedForget')
    assert.equal(forgotten.status, 200, 'forget 应成功：' + JSON.stringify(forgotten.json))
    assert.equal(forgotten.json.remembered.state, 'empty')
    assert.equal(provider.only().payload.revoked, true, 'forget 必须写 tombstone')
    a.host.dispose()
    await a.host.idle()

    const scB = scenario()
    const b = makeHost({ sc: scB, vault: makeVault(provider), bootEpoch: BOOT_B })
    await b.host.idle()
    assert.equal((await b.call(ACT('rememberedStatus', BOOT_B))).json.remembered.state, 'empty')
    assert.equal(scB.seen.length, 0, 'tombstone 之后不得有任何账号请求')
    b.host.dispose()
  })

  // ── D. 开关 / 竞态 ────────────────────────────────────────────────────
  await check('D1 渠道关闭：0 restore / 0 read / 0 QR，且不明文兜底', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider), isEnabled: () => false })
    await h.host.idle()
    const rem = (await h.call(ACT('rememberedStatus', h.host.bootEpoch))).json.remembered
    assert.equal(rem.state, 'disabled')
    assert.equal(sc.seen.length, 0)
    const started = await h.call(ACT('rememberedStart', h.host.bootEpoch, { authConsent: true, consentVersion: 1 }))
    assert.notEqual(started.status, 200)
    assert.equal(sc.seen.length, 0, '禁用时连 start 都不得出站')
    h.host.dispose()
  })

  await check('D2 能力不足：固定 unsupported、无明文 fallback、无上游请求', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const vault = createRememberedVault({
      credentials: provider,
      scope: SCOPE,
      crypto: { async capability() { return { supported: false, code: 'E_MIMO_DPAPI_UNAVAILABLE' } } }
    })
    const h = makeHost({ sc, vault })
    await h.host.idle()
    const rem = (await h.call(ACT('rememberedStatus', h.host.bootEpoch))).json.remembered
    assert.equal(rem.state, 'unsupported')
    assert.equal(rem.storage.supported, false)
    assert.equal(sc.seen.length, 0)
    assert.equal(provider.raw().size, 0, '不得写任何明文记录')
    h.host.dispose()
  })

  await check('D3 forget 与迟到 save 竞态：旧 save 不得复活（串行 provider + crypto gate）', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const gate = makeGate()
    const vault = makeVault(provider, { crypto: fakeCrypto(gate) })
    const h = makeHost({ sc, vault })
    const { authId, generation } = await firstScan(h)
    const confirmPromise = h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, ...CONSENT }))
    await settle(async () => gate.count > 0, 'protect 已进入')
    // 先启动 forget（不 await），再放行 crypto gate —— 真 provider 会串行排队
    const forgetPromise = h.host.rememberedSession.forget()
    gate.release()
    await confirmPromise
    await forgetPromise
    const stored = provider.only()
    assert.ok(stored !== null, '必须仍有记录（tombstone 或新密文）')
    if (stored.payload.revoked !== true) {
      assert.equal(JSON.stringify(stored).includes(PASS_SENTINEL), false)
    }
    h.host.dispose()
  })

  await check('D4 401：只一轮 SSO（1 读 + 3 跳 + 1 读），不叠加第二轮', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(h)
    await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, ...CONSENT }))
    sc.state.balanceSeq = [401, 200]
    const before = sc.count('/api/v1/balance')
    h.clock.t += 300001
    await h.timers.runDue()
    await settle(async () => sc.count('/api/v1/balance') > before, '刷新发生')
    assert.equal(sc.count('/api/v1/balance') - before, 2, '401 后只重试一次')
    assert.equal(sc.count('/sts'), 2, '登录 1 次 + 续期 1 次（不叠加第二轮）')
    h.host.dispose()
  })

  await check('D5 pause 保存失败：fail-closed 停掉并清密文，如实报错不假 ok', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const inner = makeVault(provider)
    let failSave = false
    const v = {
      capability: () => inner.capability(),
      load: (a) => inner.load(a),
      save: async (r, a) => {
        if (failSave) throw Object.assign(new Error('E_STORE_FAIL'), { code: 'E_STORE_FAIL' })
        return inner.save(r, a)
      },
      forget: (a) => inner.forget(a),
      dispose: () => inner.dispose()
    }
    const h = makeHost({ sc, vault: v })
    const { authId, generation } = await firstScan(h)
    await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, ...CONSENT }))
    failSave = true
    const paused = await ctl(h, 'rememberedPause')
    assert.notEqual(paused.status, 200, '保存失败不得报成功')
    assert.equal(paused.json.ok, false)
    assert.equal(paused.json.remembered.state, 'stopped', '必须 fail-closed 停止')
    assert.equal(paused.json.remembered.code, 'E_MIMO_REMEMBERED_PAUSE_SAVE_FAILED')
    assert.equal(paused.json.remembered.balance, null)
    assert.equal(provider.only().payload.revoked, true, '原密文必须被清掉（不是假报成功）')
    h.host.dispose()
  })

  await check('D6 forget 删除失败：如实报“会话已停但本地清除失败”，不 ok 掩盖', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const inner = makeVault(provider)
    let failForget = false
    const v = {
      capability: () => inner.capability(),
      load: (a) => inner.load(a),
      save: (r, a) => inner.save(r, a),
      forget: async (a) => {
        if (failForget) throw Object.assign(new Error('E_STORE_FAIL'), { code: 'E_STORE_FAIL' })
        return inner.forget(a)
      },
      dispose: () => inner.dispose()
    }
    const h = makeHost({ sc, vault: v })
    const { authId, generation } = await firstScan(h)
    await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, ...CONSENT }))
    failForget = true
    const forgotten = await ctl(h, 'rememberedForget')
    assert.notEqual(forgotten.status, 200, '删除失败不得报成功')
    assert.equal(forgotten.json.ok, false)
    assert.equal(forgotten.json.remembered.code, 'E_MIMO_REMEMBERED_FORGET_FAILED')
    assert.equal(forgotten.json.remembered.state, 'stopped', '会话已停')
    assert.equal(forgotten.json.remembered.balance, null, '不得留着旧余额冒充')
    h.host.dispose()
  })

  // ── E. 观察面卫生 ────────────────────────────────────────────────────
  await check('E1 displayStatus 就是新 controller 的纯观察快照（0 请求、无票）', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider) })
    const { authId, generation } = await firstScan(h)
    await h.call(ACT('rememberedConfirm', h.host.bootEpoch, { authId, generation, ...CONSENT }))
    const hops = sc.seen.length
    const st = await h.call(ACT('displayStatus', h.host.bootEpoch))
    assert.equal(st.status, 200)
    assert.equal(st.json.display.managed, true, 'managed 标记必须可见')
    assert.equal(st.json.display.state, 'verified')
    assert.equal(st.json.display.balance.balance, 13.5)
    assert.equal(st.json.remembered.intervalMs, 60000)
    assert.equal(sc.seen.length, hops, '观察不得发请求')
    const blob = JSON.stringify(st.json)
    for (const secret of [PASS_SENTINEL, 'api-platform_serviceToken=PT', ACCOUNT_ID]) {
      assert.equal(blob.includes(secret), false, '观察面不得出现：' + secret)
    }
    h.host.dispose()
  })

  await check('E2 神秘息不含原始值：caps 无 passToken / 无平台票 / 无 scope，且 no-store', async () => {
    const sc = scenario()
    const provider = fakeProvider()
    const h = makeHost({ sc, vault: makeVault(provider) })
    const caps = await h.caps()
    const blob = JSON.stringify(caps.json)
    for (const secret of [PASS_SENTINEL, 'api-platform', 'longPolling', SCOPE]) {
      assert.equal(blob.includes(secret), false, 'caps 不得出现：' + secret)
    }
    assert.equal(String(caps.headers.get('cache-control') || '').includes('no-store'), true)
    h.host.dispose()
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) {
    for (const f of fails) console.error('FAIL ' + f)
    console.error(summary)
    process.exitCode = 1
  } else {
    console.log(summary + ' (' + (pass + fails.length) + ')')
  }
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })

