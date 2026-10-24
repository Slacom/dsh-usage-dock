/**
 * Custom operation lifecycle: real apply + public GUI/tool/context APIs, synthetic credentials/HTTP.
 * Promise gates choose interleavings; no sleeps, real suppliers, profiles, private-ticket layout checks,
 * or imports from diagnostic evidence. Cache-hit context may be unavailable, but may never show old A.
 * Run: node tools/test-custom-operation-lifecycle.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setImmediate as flush } from 'node:timers/promises'
import { boot, A, B, cid, entry } from './fixtures/custom-operation.mjs'

const report = (id, result, detail = {}) => console.log(JSON.stringify({ id, result, ...detail }))
let passed = 0, failed = 0
async function test(id, body) {
  try { await body(); passed++; report(id, 'PASS') }
  catch (error) { failed++; report(id, 'FAIL', { assertion: error.message }) }
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function transport() {
  const gates = [], requests = []
  const state = { key: A, status: 200, valueFor: key => key === A ? 1 : 9000, requests }
  const wait = async (kind, value) => {
    const gate = gates.find(item => item.kind === kind && !item.claimed && item.predicate(value))
    if (gate) { gate.claimed = true; gate._entered.resolve(value); await gate.released }
  }
  // Keep the gate bookkeeping private to this test transport, never inspect product pending-ticket maps.
  state.hold = (kind, predicate) => {
    const entered = deferred(), released = deferred()
    const gate = { kind, predicate: predicate || (() => true), claimed: false, _entered: entered, entered: entered.promise, release: () => released.resolve(), released: released.promise }
    gates.push(gate)
    return gate
  }
  state.resolve = async ref => {
    const captured = { ref, key: state.key }
    await wait('credential', captured)
    return { value: captured.key }
  }
  state.fetch = async (target, init) => {
    const url = new URL(String(target)), authorization = new Headers(init?.headers).get('authorization')
    assert.ok(['alpha.audit.invalid', 'beta.audit.invalid'].includes(url.hostname), 'synthetic transport rejects unexpected targets')
    const key = authorization === 'Bearer ' + A ? A : authorization === 'Bearer ' + B ? B : ''
    assert.ok(key, 'only synthetic A/B credentials may reach this fixture')
    const request = { hostname: url.hostname, key, signal: init?.signal, balance: state.valueFor(key, url), status: state.status }
    requests.push(request)
    await wait('http', request)
    return new Response(JSON.stringify(request.status === 200 ? { balance: request.balance } : {}), { status: request.status })
  }
  state.releaseAll = () => { for (const gate of gates) gate.release() }
  return state
}
async function fixture(body, extra = {}, options = {}) {
  const previousFetch = globalThis.fetch, io = transport(), pending = []
  globalThis.fetch = io.fetch
  let app
  const launch = promise => { pending.push(promise); promise.catch(() => {}); return promise }
  try { app = await boot(extra, { ...options, resolve: options.resolve || io.resolve }); await body(app, io, launch) }
  finally {
    io.releaseAll()
    await Promise.allSettled(pending)
    if (app) app.close()
    await flush()
    globalThis.fetch = previousFetch
  }
}
const current = app => app.text()
const wireOf = (result, id = cid) => result.data.plans.find(plan => plan.id === id)
const channelOf = (result, id = cid) => result.channels.find(channel => channel.id === id)
function noOldLow(text) {
  assert.doesNotMatch(text, /额度：1 CNY|阶段：closing|当前额度处于\*\*收尾\*\*阶段/, 'old A must not drive the current low-credit policy')
}
function currentB(app) { assert.match(current(app), /额度：9000 CNY/); noOldLow(current(app)) }
function noOldGuiSuccess(result) { assert.notEqual(wireOf(result)?.balance, 1, 'rejected old GUI operation must not expose an old successful balance') }
const observations = (id, app, result, count) => report(id, 'OBSERVED', { model: current(app), oldGuiBalance: wireOf(result)?.balance ?? null, oldGuiError: wireOf(result)?.error ?? null, oldGuiEffectiveStatus: wireOf(result)?.effectiveStatus ?? null, lateHttp: count })

const sourceHashes = Object.fromEntries(['index.js', 'plans/custom-balance.js', 'plans/usage-tool-register.js'].map(path => [path, createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')]))
report('CUSTOM_OPERATION_SOURCE_HASHES', 'INFO', { sourceHashes, realCredentialAccess: false, realSupplierRequests: false })

await test('O01_SERIAL_GUI_KEY_CHANGE_PUBLISHES_NEW_VALUE', () => fixture(async (app, io) => {
  assert.equal(wireOf(await app.gui()).balance, 1)
  io.key = B
  assert.equal(wireOf(await app.gui()).balance, 9000)
  currentB(app)
}))

for (const cached of [true, false]) await test(cached ? 'O02_OLD_HTTP_AFTER_B_CACHE' : 'O03_OLD_HTTP_AFTER_B_FRESH_COMMIT', () => fixture(async (app, io, launch) => {
  io.key = B
  if (cached) assert.equal(channelOf(await app.execute([cid])).balance, 9000)
  else assert.equal(wireOf(await app.gui()).balance, 9000)
  const gate = io.hold('http', request => request.key === A)
  io.key = A
  const older = launch(app.gui())
  await gate.entered
  const before = io.requests.length
  io.key = B
  assert.equal(channelOf(await app.execute([cid])).balance, 9000)
  assert.equal(io.requests.length - before, cached ? 0 : 1, 'control must really exercise cached/fresh B respectively')
  if (cached) noOldLow(current(app)) // NoData is explicitly acceptable after cached identity revalidation.
  else currentB(app)
  const countAtRelease = io.requests.length
  gate.release()
  const old = await older
  observations('OLD_HTTP_RELEASE', app, old, io.requests.length - countAtRelease)
  noOldGuiSuccess(old)
  assert.equal(io.requests.length, countAtRelease, 'finishing old HTTP must not dispatch another request')
  if (cached) noOldLow(current(app))
  else currentB(app)
}))

for (const newerKind of ['tool', 'gui']) await test('O0' + (newerKind === 'tool' ? '4' : '5') + '_OLD_GUI_CREDENTIAL_AFTER_NEW_' + newerKind.toUpperCase(), () => fixture(async (app, io, launch) => {
  await app.gui()
  const gate = io.hold('credential', value => value.key === A)
  const older = launch(app.gui())
  await gate.entered
  io.key = B
  const newer = newerKind === 'tool' ? await app.execute([cid]) : await app.gui()
  assert.equal(newerKind === 'tool' ? channelOf(newer).balance : wireOf(newer).balance, 9000)
  currentB(app)
  const before = current(app), countAtRelease = io.requests.length
  gate.release()
  const old = await older
  observations('OLD_GUI_CREDENTIAL_RELEASE', app, old, io.requests.length - countAtRelease)
  assert.equal(io.requests.length, countAtRelease, 'stale GUI credential completion must dispatch zero late HTTP')
  noOldGuiSuccess(old)
  assert.equal(current(app), before, 'late credential must not change the current public context')
  currentB(app)
}))

await test('O06_OLD_TOOL_IDENTIFY_AFTER_NEW_GUI_COMMIT', () => fixture(async (app, io, launch) => {
  await app.gui()
  const gate = io.hold('credential', value => value.key === A)
  const older = launch(app.execute([cid]))
  await gate.entered
  io.key = B
  assert.equal(wireOf(await app.gui()).balance, 9000)
  currentB(app)
  const before = current(app), countAtRelease = io.requests.length
  gate.release()
  const old = await older
  report('OLD_IDENTIFY_RELEASE', 'OBSERVED', { model: current(app), oldToolBalance: channelOf(old)?.balance ?? null, lateHttp: io.requests.length - countAtRelease })
  assert.equal(io.requests.length, countAtRelease, 'stale identify must not enter collection or issue late HTTP')
  assert.notEqual(channelOf(old)?.balance, 1, 'stale tool may not return an old A success')
  assert.equal(current(app), before, 'stale identify must not re-admit/publish into current observation')
  currentB(app)
}))

await test('O07_SAME_KEY_OLDER_GUI_CANNOT_OVERWRITE_NEWER', () => fixture(async (app, io, launch) => {
  const gate = io.hold('http')
  const older = launch(app.gui())
  await gate.entered
  io.valueFor = () => 9000
  assert.equal(wireOf(await app.gui()).balance, 9000)
  currentB(app)
  gate.release()
  const old = await older
  observations('SAME_KEY_OLD_GUI_RELEASE', app, old, 0)
  noOldGuiSuccess(old)
  currentB(app)
}))

await test('O08_SAME_KEY_PERMANENT_FAILURE_VETOES_TOOL_SUCCESS_CACHE', () => fixture(async (app, io) => {
  io.key = B
  assert.equal(channelOf(await app.execute([cid])).balance, 9000)
  io.status = 401
  await app.gui()
  assert.match(current(app), /获取额度失败/)
  noOldLow(current(app))
  const before = io.requests.length
  const failed = channelOf(await app.execute([cid]))
  assert.equal(io.requests.length - before, 1, 'known source failure must bypass the old success cache')
  assert.notEqual(failed?.balance, 9000)
  assert.notEqual(failed?.availability, 'ok')
  io.status = 200
  assert.equal(channelOf(await app.execute([cid])).balance, 9000)
  currentB(app)
}))

await test('O09_SHARED_TASK_CANCEL_ONE_CONSUMER_PRESERVES_OTHER', () => fixture(async (app, io, launch) => {
  io.valueFor = () => 9
  const gate = io.hold('http'), firstController = new AbortController(), secondController = new AbortController()
  const first = launch(app.execute([cid], firstController.signal))
  await gate.entered
  const second = launch(app.execute([cid], secondController.signal))
  await flush() // Drain in-memory promise continuations so the second consumer has joined; no elapsed-time assumption.
  assert.equal(io.requests.length, 1)
  firstController.abort()
  await first
  assert.equal(io.requests[0].signal.aborted, false, 'a still-authorized consumer must keep shared transport alive')
  gate.release()
  assert.equal(channelOf(await second).balance, 9)
  assert.equal(io.requests.length, 1)
}))

const beta = { ...entry, id: 'custom:provider2', provider: 'beta', name: 'Other quota' }
await test('O10_ONLY_IDS_ISOLATES_CREDENTIALS_HTTP_AND_OTHER_CHANNEL', () => fixture(async (app, io) => {
  io.valueFor = (_key, url) => url.hostname === 'beta.audit.invalid' ? 1 : 9000
  const alpha = channelOf(await app.execute([cid]))
  assert.equal(alpha.balance, 9000)
  assert.ok(app.credentialRefs.every(ref => ref === 'A_REF'), 'query A may not parse B credentials')
  assert.deepEqual(io.requests.map(request => request.hostname), ['alpha.audit.invalid'])
  currentB(app)
  const before = current(app), refsBefore = app.credentialRefs.length
  assert.equal(channelOf(await app.execute([beta.id]), beta.id).balance, 1)
  assert.ok(app.credentialRefs.slice(refsBefore).every(ref => ref === 'B_REF'), 'query B may not reparse A credentials')
  assert.deepEqual(io.requests.map(request => request.hostname), ['alpha.audit.invalid', 'beta.audit.invalid'])
  assert.equal(current(app), before, 'unrelated B sample must not invalidate A or let B low balance drive A policy')
}, { customBalances: [entry, beta] }, { resolve: async ref => ({ value: ref === 'B_REF' ? B : A }) }))

await test('O11_SIMULTANEOUS_SAME_KEY_TOOLS_BOTH_SHARE_SUCCESS', () => fixture(async (app, io, launch) => {
  io.valueFor = () => 9
  const gate = io.hold('http')
  // Both execute calls are started synchronously, before awaiting either HTTP or credential progress.
  const first = launch(app.execute([cid]))
  const second = launch(app.execute([cid]))
  // A regression may finish both calls without dispatching anything: report that failure instead of hanging on an unentered gate.
  const admission = await Promise.race([
    gate.entered.then(() => ({ entered: true })),
    Promise.all([first, second]).then(results => ({ entered: false, results })),
  ])
  if (admission.entered) await flush()
  const countBeforeRelease = io.requests.length
  gate.release()
  const results = admission.results || await Promise.all([first, second])
  const balances = results.map(result => channelOf(result)?.balance ?? null)
  report('SIMULTANEOUS_SHARED_RESULTS', 'OBSERVED', { httpBeforeRelease: countBeforeRelease, httpTotal: io.requests.length, balances })
  assert.equal(countBeforeRelease, 1, 'simultaneous same-source consumers must coalesce into one HTTP')
  assert.equal(io.requests.length, 1)
  assert.deepEqual(balances, [9, 9], 'neither valid same-key consumer may lose the shared success')
}))

await test('O12_OLD_IDENTIFY_CANNOT_REUSE_SOURCE_AFTER_A_B_A_EPOCH_CHANGE', () => fixture(async (app, io, launch) => {
  await app.gui() // Establish the original A source before holding an A identify operation.
  const gate = io.hold('credential', value => value.key === A)
  const older = launch(app.execute([cid]))
  await gate.entered
  io.key = B
  assert.equal(wireOf(await app.gui()).balance, 9000)
  io.valueFor = () => 9000
  io.key = A
  assert.equal(wireOf(await app.gui()).balance, 9000)
  assert.equal(io.requests.at(-1).key, A, 'positive control must really return to A, not remain on B')
  currentB(app)
  const before = current(app), countAtRelease = io.requests.length
  gate.release()
  const old = await older
  report('OLD_IDENTIFY_AFTER_A_B_A_RELEASE', 'OBSERVED', { model: current(app), oldToolBalance: channelOf(old)?.balance ?? null, lateHttp: io.requests.length - countAtRelease })
  assert.equal(io.requests.length, countAtRelease, 'equal fingerprint after A/B/A must not authorize the old source epoch')
  assert.ok(channelOf(old)?.balance == null, 'old identify must not become a successful sample in the new A epoch')
  assert.equal(current(app), before)
  currentB(app)
}))

report('CUSTOM_OPERATION_LIFECYCLE_SUMMARY', failed === 0 ? 'PASS' : 'FAIL', { cases: passed + failed, passed, failed })
if (failed > 0) process.exitCode = 1
