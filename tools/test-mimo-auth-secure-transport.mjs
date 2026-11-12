// Offline transport tests. No real DNS, TLS server, socket, network, or fetch.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSecureTransport, parseAddress, makeLookup, validateTarget } from '../plans/mimo-auth/secure-transport.js'

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('[PASS] ' + name)
  } catch (error) {
    failed += 1
    console.log('[FAIL] ' + name + ' — ' + (error?.message || String(error)))
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('[PASS] ' + name)
  } catch (error) {
    failed += 1
    console.log('[FAIL] ' + name + ' — ' + (error?.message || String(error)))
  }
}

const LEFT = 'qr.account.xiaomi.com/'
function req(overrides = {}) {
  return {
    url: 'https://qr.account.xiaomi.com/lp?x=1',
    method: 'GET',
    purpose: 'longPoll',
    headers: { accept: 'application/json' },
    signal: undefined,
    deadlineAt: Date.now() + 5000,
    assertAuthorized: () => true,
    ...overrides,
  }
}
function fakeRequestFactory(options, response = {}) {
  const calls = []
  const request = (opts, callback) => {
    calls.push(opts)
    const emitter = new EventEmitter()
    emitter.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter()
        res.statusCode = response.statusCode ?? 200
        res.headers = response.headers ?? { 'content-type': 'application/json' }
        res.complete = response.complete ?? true
        res.socket = { remoteAddress: response.remoteAddress ?? '93.184.216.34' }
        res[Symbol.asyncIterator] = async function* () {
          for (const chunk of response.chunks ?? [Buffer.from('{"ok":true}')]) yield chunk
        }
        callback(res)
      })
    }
    emitter.destroy = () => { emitter.destroyed = true }
    return emitter
  }
  return { request, calls }
}

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]

await checkAsync('capability is synchronous and local-only', async () => {
  const good = createSecureTransport({ request: () => {}, resolver: publicResolver, clock: Date.now })
  assert.deepEqual(good.capability(), { ok: true, code: 'E_NONE' })
  const bad = createSecureTransport({ https: null, dns: null })
  assert.deepEqual(bad.capability(), { ok: false, code: 'E_MIMO_AUTH_FLOW' })
  const result = await bad.fetch(req()).then(() => null, (error) => error)
  assert.equal(result?.code, 'E_MIMO_AUTH_FLOW')
})

await checkAsync('pure policy accepts 1/2/3 ASCII labels and exact host only', async () => {
  for (const url of [
    'https://qr.account.xiaomi.com/lp',
    'https://a.b.account.xiaomi.com/lp',
    'https://a.b.c.account.xiaomi.com/lp',
    'https://account.xiaomi.com/lp',
  ]) {
    assert.doesNotThrow(() => validateTarget(url))
  }
  for (const url of [
    'http://qr.account.xiaomi.com/lp',
    'https://a.b.c.d.account.xiaomi.com/lp',
    'https://xn--bcher-kva.account.xiaomi.com/lp',
    'https://qr.account.xiaomi.com./lp',
    'https://qr.account.xiaomi.com:8443/lp',
    'https://user@qr.account.xiaomi.com/lp',
    'https://qr.account.xiaomi.com/lp#frag',
    'https://127.0.0.1/lp',
    'https://account.xiaomi.com.evil/lp',
    'https://a..account.xiaomi.com/lp',
  ]) {
    assert.throws(() => validateTarget(url), /E_DYNAMIC_URL_REJECTED/)
  }
})

await checkAsync('approval runs before DNS and candidate DNS is only after approval', async () => {
  let dns = 0
  let request = 0
  const transport = createSecureTransport({
    resolver: async () => { dns += 1; return [{ address: '93.184.216.34', family: 4 }] },
    request: () => { request += 1; throw new Error('must not connect') },
  })
  const authError = Object.assign(new Error('denied'), { code: 'E_MIMO_AUTH_APPROVAL_EXPIRED' })
  const result = await transport.fetch(req({ assertAuthorized: () => { throw authError } }))
    .then(() => null, (error) => error)
  assert.equal(result?.code, 'E_MIMO_AUTH_APPROVAL_EXPIRED')
  assert.equal(dns, 0)
  assert.equal(request, 0)
})

await checkAsync('non-public/empty/ambiguous resolver results fail closed before request', async () => {
  for (const rows of [
    [{ address: '10.0.0.1', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '100.64.0.1', family: 4 }],
    [{ address: '198.18.0.1', family: 4 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: 'fc00::1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [],
    [{ address: 'not-an-ip', family: 4 }],
  ]) {
    let request = 0
    const transport = createSecureTransport({ resolver: async () => rows, request: () => { request += 1 } })
    const error = await transport.fetch(req()).then(() => null, (e) => e)
    assert.ok(error?.code === 'E_DYNAMIC_URL_REJECTED' || error?.code === 'E_NETWORK')
    assert.equal(request, 0)
  }
})

await checkAsync('public IPv4-mapped IPv6 and pin/SNI/manual redirect/full body', async () => {
  assert.equal(parseAddress('::ffff:93.184.216.34').public, true)
  assert.equal(parseAddress('::ffff:127.0.0.1').public, false)
  const { request, calls } = fakeRequestFactory({}, {
    statusCode: 302,
    headers: { location: 'https://evil.example/', 'content-type': 'text/plain' },
    chunks: [Buffer.from('redirect-body')],
  })
  const transport = createSecureTransport({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }],
    request,
  })
  const response = await transport.fetch(req())
  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.equal(options.host, 'qr.account.xiaomi.com')
  assert.equal(options.port, 443)
  assert.equal(options.servername, 'qr.account.xiaomi.com')
  assert.equal(options.method, 'GET')
  assert.equal(options.agent, false)
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(typeof options.lookup, 'function')
  const pinned = await new Promise((resolve, reject) => {
    options.lookup('ignored', { all: true, family: 0 }, (error, rows) => error ? reject(error) : resolve(rows))
  })
  assert.deepEqual(pinned, [
    { address: '93.184.216.34', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ])
  assert.equal(response.status, 302)
  assert.equal(response.redirected, false)
  assert.equal(response.url, 'https://qr.account.xiaomi.com/lp?x=1')
  assert.equal(response.tls.servername, 'qr.account.xiaomi.com')
  assert.equal(response.tls.authorized, true)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.equal(Buffer.from(bytes).toString(), 'redirect-body')
  assert.equal(response.body.getReader() instanceof Object, true)
})

await checkAsync('body limit and incomplete EOF fail closed', async () => {
  const { request } = fakeRequestFactory({}, { chunks: [Buffer.from('123456')] })
  const transport = createSecureTransport({ resolver: publicResolver, request, maxBodyBytes: 5 })
  const error = await transport.fetch(req()).then(() => null, (e) => e)
  assert.equal(error?.code, 'E_RESPONSE_TOO_LARGE')

  const incomplete = fakeRequestFactory({}, { chunks: [Buffer.from('{}')], complete: false })
  const t2 = createSecureTransport({ resolver: publicResolver, request: incomplete.request })
  const e2 = await t2.fetch(req()).then(() => null, (e) => e)
  assert.equal(e2?.code, 'E_NETWORK')
})

await checkAsync('abort before DNS and late resolver do not request', async () => {
  let dns = 0
  let request = 0
  const transport = createSecureTransport({
    resolver: async () => { dns += 1; return new Promise(() => {}) },
    request: () => { request += 1 },
    clock: () => Date.now(),
  })
  const controller = new AbortController()
  controller.abort()
  const aborted = await transport.fetch(req({ signal: controller.signal })).then(() => null, (e) => e)
  assert.equal(aborted?.code, 'E_MIMO_AUTH_CANCELLED')
  assert.equal(dns, 0)
  assert.equal(request, 0)

  const late = createSecureTransport({
    resolver: () => new Promise((resolve) => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 50)),
    request: () => { request += 1 },
  })
  const timeout = await late.fetch(req({ deadlineAt: Date.now() + 5 })).then(() => null, (e) => e)
  assert.equal(timeout?.code, 'E_REQUEST_TIMEOUT')
  assert.equal(request, 0)
})

await checkAsync('authorization is checked before/after DNS, before connect and around body', async () => {
  let calls = 0
  const { request } = fakeRequestFactory({})
  const transport = createSecureTransport({ resolver: publicResolver, request })
  const response = await transport.fetch(req({ assertAuthorized: () => { calls += 1; return true } }))
  assert.ok(calls >= 6)
  assert.equal(response.status, 200)
})

await checkAsync('Authorization/cookie header boundaries are fail-closed', async () => {
  const { request } = fakeRequestFactory({})
  const transport = createSecureTransport({ resolver: publicResolver, request })
  const auth = await transport.fetch(req({ headers: { authorization: 'Bearer x' } })).then(() => null, (e) => e)
  assert.equal(auth?.code, 'E_MIMO_AUTH_TARGET_INVALID')
  const cookie = await transport.fetch(req({ headers: { cookie: 'a=b' } })).then(() => null, (e) => e)
  assert.equal(cookie?.code, 'E_MIMO_AUTH_TARGET_INVALID')
  const good = await transport.fetch(req({ headers: { accept: 'application/json', cookie: 'a=b' }, cookieScoped: true }))
  assert.equal(good.status, 200)
})

await checkAsync('lookup pin rejects requested family absent and never re-resolves', async () => {
  const lookup = makeLookup([{ address: '93.184.216.34', family: 4 }])
  const error = await new Promise((resolve) => {
    lookup('other.example', { family: 6 }, (e) => resolve(e))
  })
  assert.equal(error?.code, 'ENOTFOUND')
  const v4 = await new Promise((resolve, reject) => {
    lookup('other.example', { family: 4 }, (e, address, family) => e ? reject(e) : resolve({ address, family }))
  })
  assert.deepEqual(v4, { address: '93.184.216.34', family: 4 })
})

console.log(`\n${passed} PASS ${failed} FAIL`)
if (failed > 0) process.exitCode = 1
