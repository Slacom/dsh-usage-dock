/**
 * test-mimo-remember-store.mjs — remember-store 单测（离线、无网络、无 profile、无真实凭据）
 *
 * 只测本模块的契约：schema 白名单、加密信封、revision 并发、tombstone、epoch/dispose、fail closed。
 * 全部使用 **fake credentials provider + fake crypto**；绝不接触真实凭据服务/账号/配置。
 * 运行：node tools/test-mimo-remember-store.mjs
 */
import assert from 'node:assert/strict'
import {
  createRememberedVault,
  validateRememberedRecord,
  credentialKeyForScope,
  STORE_CODES as C
} from '../plans/mimo-auth/remember-store.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}
async function expectCode(fn, code, label) {
  try { await fn() } catch (e) {
    const got = e && e.code ? e.code : e && e.message
    if (got !== code) throw new Error((label || '') + ' 期望 ' + code + ' 实际 ' + got)
    return e
  }
  throw new Error((label || '') + ' 期望抛 ' + code + '，但没有抛')
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * fake provider：与 credentials-local 的 `enqueue` + 文档锁同形——**modifyRecord 全串行**。
 * 非串行的假并发不能当作真实宿主语义的证据。
 */
function makeProvider() {
  const map = new Map()
  const state = { writes: 0, reads: 0, mutateActive: 0, maxMutateActive: 0 }
  let queue = Promise.resolve()
  const exclusive = (fn) => {
    const next = queue.then(fn)
    queue = next.then(() => undefined, () => undefined)
    return next
  }
  return {
    map,
    state,
    async readRecord(key) { state.reads++; return map.get(key) },
    modifyRecord(key, mutate) {
      return exclusive(async () => {
        state.mutateActive++
        state.maxMutateActive = Math.max(state.maxMutateActive, state.mutateActive)
        try {
          const current = map.get(key)
          const next = await mutate(current)
          if (next === undefined) return current
          map.set(key, next)
          state.writes++
          return next
        } finally {
          state.mutateActive--
        }
      })
    }
  }
}

/** fake crypto：可逆变换 + 可选 gate/失败/哨兵码；不模拟真实加密，只验证“明文不落 provider”。 */
function makeCrypto(over = {}) {
  const calls = { protect: 0, unprotect: 0, capability: 0, dispose: 0 }
  const gates = { protect: null, capability: null }
  const entered = { protect: null, capability: null }
  const notify = {
    protect: () => { if (entered.protect !== null) { const r = entered.protect; entered.protect = null; r() } },
    capability: () => { if (entered.capability !== null) { const r = entered.capability; entered.capability = null; r() } }
  }
  const crypto = {
    calls,
    notify,
    waitProtectEntered: () => new Promise((r) => { entered.protect = r }),
    waitCapabilityEntered: () => new Promise((r) => { entered.capability = r }),
    async capability() {
      calls.capability++
      if (over.capGate) { notify.capability(); await new Promise((r) => { gates.capability = r }) }
      if (over.capCode !== undefined) return { supported: false, code: over.capCode }
      return over.cap || { supported: true, code: 'OK' }
    },
    async protect(bytes) {
      calls.protect++
      if (over.gate) { notify.protect(); await new Promise((r) => { gates.protect = r }) }
      if (over.protectCode !== undefined) { const e = new Error(over.protectCode); e.code = over.protectCode; throw e }
      if (over.protectThrows) { const e = new Error('boom'); e.code = 'E_FAKE_PROTECT'; throw e }
      return new Uint8Array(Buffer.from(bytes).reverse())
    },
    async unprotect(bytes) {
      calls.unprotect++
      if (over.unprotectCode !== undefined) { const e = new Error(over.unprotectCode); e.code = over.unprotectCode; throw e }
      if (over.unprotectThrows) { const e = new Error('boom'); e.code = 'E_MIMO_STORE_INVALID'; throw e }
      return new Uint8Array(Buffer.from(bytes).reverse())
    },
    dispose() { calls.dispose++ },
    release() { if (gates.protect !== null) { const r = gates.protect; gates.protect = null; r() } },
    releaseCapability() { if (gates.capability !== null) { const r = gates.capability; gates.capability = null; r() } }
  }
  return crypto
}

const SCOPE = 'C:\\Users\\Synthetic\\.dsh\\profiles\\desktop'
const OTHER_SCOPE = 'C:\\Users\\Synthetic\\.dsh\\profiles\\web'
const KEY = credentialKeyForScope(SCOPE)

function mkRecord(over = {}) {
  return {
    version: 1,
    consent: { version: 1, autoRestore: true, autoReadBalance: true, autoRefresh: true, confirmedAt: 1_760_000_000_000 },
    account: {
      version: 1,
      namespace: 'xiaomi-account-user-id',
      accountId: '1234567890',
      cookies: [
        { name: 'passToken', value: 'VALUE-PT', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: 1_800_000_000 },
        { name: 'userId', value: '1234567890', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
        { name: 'cUserId', value: 'CUSER', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null },
        { name: 'deviceId', value: 'DEV', domain: 'account.xiaomi.com', path: '/', hostOnly: true, secure: true, httpOnly: true, expiresAt: null }
      ]
    },
    preferences: { paused: false },
    ...over
  }
}

function mkVault(provider, crypto, scope = SCOPE) {
  return createRememberedVault({ credentials: provider, crypto, scope })
}

const plainOf = (payload) => Buffer.from(payload.ciphertext, 'base64').reverse().toString('utf8')

// ---------- key / scope ----------
await check('key: owner plan-usage + 24 hex，不含 scope 原文', () => {
  const key = credentialKeyForScope(SCOPE)
  assert.match(key, /^plan-usage\/mimo-remembered-[a-f0-9]{24}$/)
  assert.equal(key.includes('Synthetic'), false)
  assert.equal(credentialKeyForScope(SCOPE), key)
  assert.notEqual(credentialKeyForScope(OTHER_SCOPE), key)
})

await check('scope 缺失/为空/控制字符 → SCOPE_INVALID', async () => {
  await expectCode(async () => createRememberedVault({ credentials: makeProvider(), crypto: makeCrypto() }), C.SCOPE_INVALID)
  await expectCode(async () => createRememberedVault({ credentials: makeProvider(), crypto: makeCrypto(), scope: '' }), C.SCOPE_INVALID)
  await expectCode(async () => createRememberedVault({ credentials: makeProvider(), crypto: makeCrypto(), scope: 'a\u0000b' }), C.SCOPE_INVALID)
})

// ---------- record schema ----------
await check('schema: preferences.paused 必须是 boolean 且必填', () => {
  validateRememberedRecord(mkRecord())
  assert.throws(() => validateRememberedRecord(mkRecord({ preferences: { paused: 'false' } })), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), preferences: undefined }), /E_MIMO_STORE_INVALID/)
})

await check('schema: 任意层级额外 key 都拒', () => {
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), extra: 1 }), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord(mkRecord({ consent: { ...mkRecord().consent, extra: 1 } })), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), account: { ...mkRecord().account, extra: 1 } }), /E_MIMO_STORE_INVALID/)
  const cookie = { ...mkRecord().account.cookies[0], extra: 1 }
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), account: { ...mkRecord().account, cookies: [cookie] } }), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), preferences: { paused: false, extra: 1 } }), /E_MIMO_STORE_INVALID/)
})

await check('schema: primitive / array / 错类型 / 非白名单 cookie / 重复 cookie 全拒', () => {
  for (const bad of [null, true, 'x', [], 0]) assert.throws(() => validateRememberedRecord(bad), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord(mkRecord({ consent: { ...mkRecord().consent, autoRestore: 'yes' } })), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord(mkRecord({ consent: { ...mkRecord().consent, confirmedAt: 1.5 } })), /E_MIMO_STORE_INVALID/)
  const cookies = [
    { ...mkRecord().account.cookies[0], name: 'api-platform_serviceToken' }
  ]
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), account: { ...mkRecord().account, cookies } }), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({
    ...mkRecord(),
    account: { ...mkRecord().account, cookies: [mkRecord().account.cookies[0], mkRecord().account.cookies[0]] }
  }), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({
    ...mkRecord(),
    account: { ...mkRecord().account, cookies: [{ ...mkRecord().account.cookies[0], domain: 'Account.xiaomi.com' }] }
  }), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({
    ...mkRecord(),
    account: { ...mkRecord().account, cookies: [{ ...mkRecord().account.cookies[0], path: 'relative' }] }
  }), /E_MIMO_STORE_INVALID/)
  assert.throws(() => validateRememberedRecord({ ...mkRecord(), account: { ...mkRecord().account, accountId: '00123' } }), /E_MIMO_STORE_INVALID/)
})

// ---------- capability / fail closed ----------
await check('缺凭据服务 → UNSUPPORTED，且不写 provider/不 fallback 明文', async () => {
  const crypto = makeCrypto()
  const vault = createRememberedVault({ credentials: {}, crypto, scope: SCOPE })
  const cap = await vault.capability()
  assert.equal(cap.supported, false)
  assert.equal(cap.code, C.UNSUPPORTED)
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.UNSUPPORTED)
  await expectCode(async () => vault.load(), C.UNSUPPORTED)
  assert.equal(crypto.calls.protect, 0)
})

await check('crypto capability=false → 保存拒绝且 0 次 protect', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ cap: { supported: false, code: C.UNSUPPORTED } })
  const vault = mkVault(provider, crypto)
  assert.deepEqual(await vault.capability(), { supported: false, code: C.UNSUPPORTED })
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.UNSUPPORTED)
  assert.equal(provider.state.writes, 0)
  assert.equal(crypto.calls.protect, 0)
})

// ---------- save / load ----------
await check('save 必须带 expectedRevision（缺省即拒）', async () => {
  const vault = mkVault(makeProvider(), makeCrypto())
  await expectCode(async () => vault.save(mkRecord(), {}), C.REVISION_REQUIRED)
})

await check('save(null) → 信封只含 version/algorithm/ciphertext；provider 无明文账号', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto()
  const vault = mkVault(provider, crypto)
  const { revision } = await vault.save(mkRecord(), { expectedRevision: null })
  assert.match(revision, /^[a-f0-9]{24}$/)
  const stored = provider.map.get(KEY)
  assert.equal(stored.kind, 'grant')
  assert.deepEqual(Object.keys(stored.payload).sort(), ['algorithm', 'ciphertext', 'version'].sort())
  const raw = JSON.stringify(stored)
  for (const needle of ['xiaomi-account-user-id', '1234567890', 'passToken', 'VALUE-PT', 'confirmedAt']) {
    assert.equal(raw.includes(needle), false, 'provider 明文泄露: ' + needle)
  }
  assert.equal(raw.includes('paused'), false)
})

await check('跨实例 load 同 scope 成功，revision 稳定；错 scope 读不到', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto()
  const a = mkVault(provider, crypto)
  const { revision } = await a.save(mkRecord(), { expectedRevision: null })
  const b = mkVault(provider, makeCrypto(), SCOPE)
  const got = await b.load()
  assert.deepEqual(got.record, validateRememberedRecord(mkRecord()))
  assert.equal(got.revision, revision)
  assert.deepEqual(await b.load(), got)
  const c = mkVault(provider, makeCrypto(), OTHER_SCOPE)
  assert.deepEqual(await c.load(), { record: null, revision: null })
})

await check('密文被篡改 → load 拒绝（INVALID），不返回半份账号', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto()
  const vault = mkVault(provider, crypto)
  await vault.save(mkRecord(), { expectedRevision: null })
  const stored = provider.map.get(KEY)
  const bytes = Buffer.from(stored.payload.ciphertext, 'base64')
  bytes[0] = bytes[0] ^ 0xff
  provider.map.set(KEY, { kind: 'grant', payload: { ...stored.payload, ciphertext: bytes.toString('base64') } })
  await expectCode(async () => vault.load(), C.INVALID)
})

await check('信封信封形状异常 → INVALID（fail closed，不静默删除）', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  provider.map.set(KEY, { kind: 'grant', payload: { version: 1, algorithm: 'windows-dpapi-current-user', ciphertext: 'AAAA', extra: 1 } })
  await expectCode(async () => vault.load(), C.INVALID)
  provider.map.set(KEY, { kind: 'api-key', payload: {} })
  await expectCode(async () => vault.load(), C.INVALID)
})

await check('preferences.paused=true 可往返（暂停是独立持久化开关）', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  const rec = mkRecord({ preferences: { paused: true } })
  const { revision } = await vault.save(rec, { expectedRevision: null })
  const got = await mkVault(provider, makeCrypto()).load()
  assert.equal(got.record.preferences.paused, true)
  assert.equal(got.revision, revision)
})

// ---------- revision 并发 ----------
await check('旧 revision / 已有记录却传 null → REVISION_CONFLICT，密文不变', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  await vault.save(mkRecord(), { expectedRevision: null })
  const before = JSON.stringify(provider.map.get(KEY))
  await expectCode(async () => vault.save(mkRecord({ account: { ...mkRecord().account, accountId: '999' } }), { expectedRevision: 'ffffffffffffffffffffffff' }), C.REVISION_CONFLICT)
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.REVISION_CONFLICT)
  assert.equal(JSON.stringify(provider.map.get(KEY)), before)
})

await check('正确 revision 可更新（换账号）', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  const first = await vault.save(mkRecord(), { expectedRevision: null })
  const next = mkRecord({ account: { ...mkRecord().account, accountId: '5555' } })
  const second = await vault.save(next, { expectedRevision: first.revision })
  assert.notEqual(second.revision, first.revision)
  const got = await mkVault(provider, makeCrypto()).load()
  assert.equal(got.record.account.accountId, '5555')
})

// ---------- forget / tombstone ----------
await check('forget 写 tombstone（无 ciphertext/账号信息），load 返回 null + 该 revision', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  await vault.save(mkRecord(), { expectedRevision: null })
  await vault.forget()
  const stored = provider.map.get(KEY)
  assert.deepEqual(Object.keys(stored.payload).sort(), ['algorithm', 'revoked', 'revision', 'version'].sort())
  assert.equal(stored.payload.revoked, true)
  const raw = JSON.stringify(stored)
  assert.equal(raw.includes('1234567890'), false)
  assert.equal(raw.includes('ciphertext'), false)
  const got = await mkVault(provider, makeCrypto()).load()
  assert.equal(got.record, null)
  assert.equal(got.revision, stored.payload.revision)
})

await check('tombstone 后：null revision 不能保存；携带 tombstone revision 可重新保存', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  await vault.save(mkRecord(), { expectedRevision: null })
  await vault.forget()
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.REVISION_CONFLICT)
  const tomb = await vault.load()
  await vault.save(mkRecord(), { expectedRevision: tomb.revision })
  assert.equal((await vault.load()).record.account.accountId, '1234567890')
})

await check('save 与 forget 竞态（真实串行 provider）：迟到 save 不复活旧账号', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ gate: true })
  const vault = mkVault(provider, crypto)
  const entered = crypto.waitProtectEntered()
  const saveP = vault.save(mkRecord(), { expectedRevision: null })
  await entered            // save 已进入独占 mutate，卡在 protect
  const forgetP = vault.forget()   // 排在 save 的 mutate 之后
  await delay(5)
  crypto.release()
  await expectCode(async () => saveP, C.CANCELLED)
  await forgetP
  const stored = provider.map.get(KEY)
  assert.equal(stored.payload.revoked, true)
  assert.equal(JSON.stringify(stored).includes('1234567890'), false)
  assert.equal(provider.state.maxMutateActive, 1, 'provider 必须真正串行')
})

await check('capability 被 gate 时 forget：旧 save 在 epoch 变后不成新一代写', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ capGate: true })
  const vault = mkVault(provider, crypto)
  const capEntered = crypto.waitCapabilityEntered()
  const saveP = vault.save(mkRecord(), { expectedRevision: null })
  await capEntered
  await vault.forget()
  crypto.releaseCapability()
  await expectCode(async () => saveP, C.CANCELLED)
  const stored = provider.map.get(KEY)
  assert.equal(stored.payload.revoked, true)
  assert.equal(provider.state.writes, 1, '只允许 tombstone 一次写')
  assert.equal(crypto.calls.protect, 0)
})

await check('capability 被 gate 时 dispose：save 拒绝且 0 写', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ capGate: true })
  const vault = mkVault(provider, crypto)
  const capEntered = crypto.waitCapabilityEntered()
  const saveP = vault.save(mkRecord(), { expectedRevision: null })
  await capEntered
  vault.dispose()
  crypto.releaseCapability()
  await expectCode(async () => saveP, C.DISPOSED)
  assert.equal(provider.state.writes, 0)
})

await check('capability 被 gate 时 abort：save 拒绝且 0 写', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ capGate: true })
  const vault = mkVault(provider, crypto)
  const ac = new AbortController()
  const capEntered = crypto.waitCapabilityEntered()
  const saveP = vault.save(mkRecord(), { expectedRevision: null, signal: ac.signal })
  await capEntered
  ac.abort()
  crypto.releaseCapability()
  await expectCode(async () => saveP, C.CANCELLED)
  assert.equal(provider.state.writes, 0)
})

await check('load 的 capability 等待期间 forget：不 unprotect、不返回旧账号', async () => {
  const provider = makeProvider()
  const vault1 = mkVault(provider, makeCrypto())
  await vault1.save(mkRecord(), { expectedRevision: null })
  const crypto2 = makeCrypto({ capGate: true })
  const vault2 = mkVault(provider, crypto2)
  const capEntered = crypto2.waitCapabilityEntered()
  const loadP = vault2.load()
  await capEntered
  await vault2.forget()
  crypto2.releaseCapability()
  await expectCode(async () => loadP, C.CANCELLED)
  assert.equal(crypto2.calls.unprotect, 0)
})

await check('预取消 load：0 次 provider 读、0 次 unprotect', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto()
  const vault = mkVault(provider, crypto)
  const ac = new AbortController()
  ac.abort()
  await expectCode(async () => vault.load({ signal: ac.signal }), C.CANCELLED)
  assert.equal(provider.state.reads, 0)
  assert.equal(crypto.calls.unprotect, 0)
})

await check('未知错误码不外泄：protect 抛带 URL/token 的码 → 固定 FAILED', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ protectCode: 'E_MIMO_LEAK https://evil.example/x?token=ABC123' })
  const vault = mkVault(provider, crypto)
  const err = await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.FAILED)
  assert.equal(/evil\.example|ABC123/.test(String(err.message) + String(err.detail || '')), false)
  assert.equal(provider.state.writes, 0)
})

await check('未知 capability 码不外泄：折成 UNSUPPORTED', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ capCode: 'E_LEAK token=ABC123' })
  const vault = mkVault(provider, crypto)
  assert.deepEqual(await vault.capability(), { supported: false, code: C.UNSUPPORTED })
})

await check('未知 unprotect 码不外泄：load 折成 FAILED', async () => {
  const provider = makeProvider()
  await mkVault(provider, makeCrypto()).save(mkRecord(), { expectedRevision: null })
  const bad = makeCrypto({ unprotectCode: 'E_LEAK https://evil.example/?token=ABC123' })
  const err = await expectCode(async () => mkVault(provider, bad).load(), C.FAILED)
  assert.equal(/evil\.example|ABC123/.test(String(err.message) + String(err.detail || '')), false)
})

await check('迟到 save 的 protect 抛错也不写', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto({ protectThrows: true })
  const vault = mkVault(provider, crypto)
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.FAILED)
  assert.equal(provider.state.writes, 0)
})

// ---------- epoch / dispose ----------
await check('取消 signal → CANCELLED 且不写 provider', async () => {
  const provider = makeProvider()
  const vault = mkVault(provider, makeCrypto())
  const ac = new AbortController()
  ac.abort()
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null, signal: ac.signal }), C.CANCELLED)
  assert.equal(provider.state.writes, 0)
})

await check('dispose 后 load/save 拒绝（DISPOSED）且 0 写', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto()
  const vault = mkVault(provider, crypto)
  await vault.save(mkRecord(), { expectedRevision: null })
  const before = provider.state.writes
  vault.dispose()
  await expectCode(async () => vault.load(), C.DISPOSED)
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.DISPOSED)
  await expectCode(async () => vault.forget(), C.DISPOSED)
  assert.equal(provider.state.writes, before)
  assert.equal(crypto.calls.dispose, 1)
})

await check('凭据服务缺 modifyRecord → UNSUPPORTED（不静默明文）', async () => {
  const crypto = makeCrypto()
  const reads = []
  const vault = createRememberedVault({ credentials: { async readRecord(k) { reads.push(k) } }, crypto, scope: SCOPE })
  assert.deepEqual(await vault.capability(), { supported: false, code: C.UNSUPPORTED })
  await expectCode(async () => vault.save(mkRecord(), { expectedRevision: null }), C.UNSUPPORTED)
  assert.equal(crypto.calls.protect, 0)
  assert.equal(reads.length, 0)
})

await check('save 前校验：非法 record 不调用 protect、不写 provider', async () => {
  const provider = makeProvider()
  const crypto = makeCrypto()
  const vault = mkVault(provider, crypto)
  await expectCode(async () => vault.save({ version: 1 }, { expectedRevision: null }), C.INVALID)
  assert.equal(crypto.calls.protect, 0)
  assert.equal(provider.state.writes, 0)
})

if (fails.length > 0) {
  console.log('FAIL ' + fails.length + ' / pass ' + pass)
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log('PASS ' + pass + ' / 0 fail')
