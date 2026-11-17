#!/usr/bin/env node
/** MiMo legacy 登录持久化：纯逻辑 + 可注入 fetch 的契约测试。 */
import assert from 'node:assert/strict'
import {
  MIMO_LEGACY_RECORD_KEY,
  MIMO_BALANCE_URL,
  pickPlatformCookie,
  buildLegacyRecord,
  parseLegacyRecord,
  replayLegacyBalance,
} from '../plans/mimo-legacy-store.js'
import { createAuthHost } from '../plans/mimo-auth/host.js'

let passed = 0
function check(name, fn) {
  try { fn(); passed += 1; console.log('[PASS] ' + name) } catch (error) {
    console.error('[FAIL] ' + name); console.error(error && error.stack ? error.stack : error); process.exitCode = 1
  }
}
async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log('[PASS] ' + name) } catch (error) {
    console.error('[FAIL] ' + name); console.error(error && error.stack ? error.stack : error); process.exitCode = 1
  }
}

const GOOD = 'api-platform_serviceToken=abc123; userId=123456; api-platform_slh=x; api-platform_ph=y; uiPreference=WITH SPACE; other=1'
const parseBalance = (payload) => {
  const d = payload.data ?? payload
  return { balance: Number(d.balance), currency: String(d.currency ?? 'CNY') }
}

check('记录 key 形如 <owner>/<id>', () => {
  assert.equal(MIMO_LEGACY_RECORD_KEY, 'dsh-usage-dock/mimo-legacy')
})
check('cookie 白名单：只保留平台必需名，去掉其它 cookie', () => {
  const picked = pickPlatformCookie(GOOD)
  assert.equal(picked, 'api-platform_serviceToken=abc123; userId=123456; api-platform_slh=x; api-platform_ph=y')
})
check('cookie 白名单：保留带引号的值（CookieJar 允许引号）', () => {
  const quoted = 'api-platform_serviceToken="abc123"; userId="42"'
  assert.equal(pickPlatformCookie(quoted), quoted)
})
check('cookie 白名单：缺 serviceToken / CRLF / 超长 / 非法字符返回 null', () => {
  assert.equal(pickPlatformCookie('userId=1'), null)
  assert.equal(pickPlatformCookie('api-platform_serviceToken=a\r\nSet-Cookie: x'), null)
  assert.equal(pickPlatformCookie('api-platform_serviceToken=' + 'a'.repeat(2100)), null)
  assert.equal(pickPlatformCookie('api-platform_serviceToken=a; bad name=1'), null)
})
check('build：形状固定（v/cookie/balance/currency/fetchedAt）', () => {
  const record = buildLegacyRecord({ platformCookie: GOOD, balance: 14.58, currency: 'CNY', fetchedAt: 1000 })
  assert.deepEqual(record, { v: 1, cookie: 'api-platform_serviceToken=abc123; userId=123456; api-platform_slh=x; api-platform_ph=y', balance: 14.58, currency: 'CNY', fetchedAt: 1000 })
})
check('build：缺 cookie 或余额非法返回 null', () => {
  assert.equal(buildLegacyRecord({ platformCookie: 'userId=1', balance: 1 }), null)
  assert.equal(buildLegacyRecord({ platformCookie: GOOD, balance: -1 }), null)
  assert.equal(buildLegacyRecord(null), null)
})
check('parse：合法记录还原；非 grant / v 不对 / 超 TTL / 坏 cookie 均 null', () => {
  const record = { kind: 'grant', payload: buildLegacyRecord({ platformCookie: GOOD, balance: 14.58, currency: 'USD', fetchedAt: 1000 }) }
  const hit = parseLegacyRecord(record, { now: 2000 })
  assert.equal(hit.balance, 14.58)
  assert.equal(hit.currency, 'USD')
  assert.equal(parseLegacyRecord({ kind: 'api-key', payload: record.payload }, { now: 2000 }), null)
  assert.equal(parseLegacyRecord({ kind: 'grant', payload: { ...record.payload, v: 2 } }, { now: 2000 }), null)
  assert.equal(parseLegacyRecord(record, { now: 31 * 24 * 60 * 60 * 1000 + 1000 }), null)
  assert.equal(parseLegacyRecord({ kind: 'grant', payload: { ...record.payload, cookie: 'x' } }, { now: 2000 }), null)
})

await checkAsync('replay：200 + code 0 → 余额与币种', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, cookie: init.headers.cookie, method: init.method }
    return { status: 200, json: async () => ({ code: 0, data: { balance: 14.58, currency: 'CNY' } }) }
  }
  const result = await replayLegacyBalance(GOOD, { fetchImpl, parseBalance })
  assert.equal(seen.url, MIMO_BALANCE_URL)
  assert.equal(seen.method, 'GET')
  assert.equal(seen.cookie.includes('api-platform_serviceToken=abc123'), true)
  assert.equal(result.ok, true)
  assert.equal(result.balance, 14.58)
  assert.equal(result.currency, 'CNY')
})
await checkAsync('replay：401 / 403 → unauthorized（供调用方删除记录）', async () => {
  for (const status of [401, 403]) {
    const result = await replayLegacyBalance(GOOD, { fetchImpl: async () => ({ status, json: async () => ({}) }), parseBalance })
    assert.deepEqual(result, { ok: false, reason: 'unauthorized' })
  }
})
await checkAsync('replay：HTTP 错误 / code=401 / 结构异常 / 网络异常 → 固定枚举', async () => {
  assert.deepEqual(await replayLegacyBalance(GOOD, { fetchImpl: async () => ({ status: 500, json: async () => ({}) }), parseBalance }), { ok: false, reason: 'http' })
  assert.deepEqual(await replayLegacyBalance(GOOD, { fetchImpl: async () => ({ status: 200, json: async () => ({ code: 401 }) }), parseBalance }), { ok: false, reason: 'unauthorized' })
  assert.deepEqual(await replayLegacyBalance(GOOD, { fetchImpl: async () => ({ status: 200, json: async () => ({ code: 0, data: {} }) }), parseBalance }), { ok: false, reason: 'parse' })
  assert.deepEqual(await replayLegacyBalance(GOOD, { fetchImpl: async () => { throw new Error('boom') }, parseBalance }), { ok: false, reason: 'network' })
})
check('replay：cookie 非法时零请求直接 parse 失败', async () => {
  let calls = 0
  const result = await replayLegacyBalance('bad', { fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({ code: 0 }) } } })
  assert.equal(calls, 0)
  assert.deepEqual(result, { ok: false, reason: 'parse' })
})

// ── [0.11.0 整改] legacy 一次性登录余额：稳定采样时间（多次 peek 不变、不伪刷新） ──

await checkAsync('legacyDoneBalance：连续 peek 两次 fetchedAt 相同，推进时钟后仍不变', async () => {
  const clock = { value: 1_700_000_000_000 }
  const BOOT = 'a'.repeat(32)
  const routes = new Map()
  const ctx = {
    connection: { fetch: { register(spec) { routes.set(spec.path, spec.fetch); return () => {} } } },
    get() { return undefined },
    effect(fn) { return fn() },
    on() { return () => {} },
  }
  const deps = {
    now: () => clock.value,
    loadFlow: async () => ({
      CookieJar: class { absorber() {} clear() {} cookieHeaderFor() { return { header: null, names: [] } } },
      createMemoryFlow(flowDeps) {
        return {
          async run() {
            // 模拟扫码流程读到余额：`requestBalanceMatch` 会同步把余额写进会话；
            // 它返回的确认 Promise 流程不等待（真实流程在此处做用户确认）。
            void flowDeps.display.askBalanceMatch({ balance: 14.58, currency: 'CNY' })
            return { ok: true, code: 'E_NONE', gates: { qr: { ok: true }, balance: { ok: true } } }
          },
        }
      },
    }),
  }
  const host = createAuthHost(ctx, BOOT, () => {}, deps)
  try {
    const call = async (body) => (await host.native.auth(new Request('http://dsh.internal/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))).json()
    const started = await call({ action: 'start', bootEpoch: BOOT })
    assert.equal(started.ok, true)
    const begin = await call({ action: 'begin', bootEpoch: BOOT, ticketId: started.ticketId, generation: started.generation })
    assert.equal(begin.ok, true)
    await host.idle()

    const first = host.legacyDoneBalance()
    assert.deepEqual(first, { balance: 14.58, currency: 'CNY', fetchedAt: clock.value })
    const again = host.legacyDoneBalance()
    assert.deepEqual(again, first)
    // 推进注入时钟 10 分钟：fetchedAt 仍是拿到余额那一刻，不是 peek 时的 Date.now()。
    clock.value += 10 * 60 * 1000
    const later = host.legacyDoneBalance()
    assert.deepEqual(later, first)
  } finally {
    host.dispose()
  }
})

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log('\nMiMo legacy 持久化：' + passed + ' 项全部通过')
}
