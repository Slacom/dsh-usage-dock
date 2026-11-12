/**
 * remember-store.js — MiMo「记住并自动恢复」的 Host-only 加密存储层（不含协议/网络）
 *
 * 设计约束（用户 2026-11-07 授权 + 主代理接口锁定）
 *  - 只有**加密**这一条路：没有明文 JSON 退路，也不把 AES key 与密文同放。
 *  - 密文整条放进宿主凭据服务的 grant record；信封本身**不含**账号 ID、时间、grant 布尔等明文元数据。
 *  - record 完整 schema 在本文件白名单校验（不透传任意对象）；账号 cookie 的细语法由 protocol 二次校验。
 *  - `save` 必须带 `expectedRevision`（初始 `null` 只匹配“无记录”），在 modifyRecord 的独占时刻比对，
 *    防止旧刷新覆盖新账号、或退出后旧 save 复活。
 *  - `forget` 写**无 ciphertext 的 revoked tombstone**（固定 version/algorithm + revoked:true + 随机 revision），
 *    而不是先删后写，避免迟到的 save 把旧账号写回来；这是**逻辑删除**，不承诺抹除磁盘旧备份。
 *  - 每实例 epoch：迟到 save/load 作废；dispose 后不再写。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createWindowsDpapi, DPAPI_ALGORITHM, DPAPI_CODES } from './windows-dpapi.js'

export const STORE_VERSION = 1
export const STORE_ALGORITHM = DPAPI_ALGORITHM
export const STORE_NAMESPACE = 'xiaomi-account-user-id'
export const STORE_SCOPE_OWNER = 'plan-usage'
export const STORE_RECORD_PREFIX = 'mimo-remembered-'
export const ACCOUNT_COOKIE_NAMES = Object.freeze(['passToken', 'userId', 'cUserId', 'deviceId'])

export const STORE_CODES = Object.freeze({
  UNSUPPORTED: DPAPI_CODES.UNSUPPORTED,
  INVALID: 'E_MIMO_STORE_INVALID',
  REVISION_REQUIRED: 'E_MIMO_STORE_REVISION_REQUIRED',
  REVISION_CONFLICT: 'E_MIMO_STORE_REVISION_CONFLICT',
  FAILED: 'E_MIMO_STORE_FAILED',
  DISPOSED: DPAPI_CODES.DISPOSED,
  CANCELLED: DPAPI_CODES.CANCELLED,
  SCOPE_INVALID: DPAPI_CODES.SCOPE_INVALID,
  TOO_LARGE: DPAPI_CODES.TOO_LARGE
})

const C = STORE_CODES
/** 只允许固定枚举码向上抛；任何第三方/未来错误码必须折成 Host 固定码，不透明转发。 */
const KNOWN_CODES = new Set([...Object.values(STORE_CODES), ...Object.values(DPAPI_CODES)])
function normalizeCode(code, fallback) {
  return typeof code === 'string' && KNOWN_CODES.has(code) ? code : fallback
}
const MAX_RECORD_BYTES = 256 * 1024
// DPAPI 会给密文加固定头；Base64 后允许 4KiB 余量，避免“写得进、读不回”。
const MAX_CIPHER_B64 = Math.ceil((MAX_RECORD_BYTES + 4096) / 3) * 4 + 8
const MAX_COOKIES = 8
const MAX_VALUE_LEN = 8192
const MAX_ID_LEN = 32
const MAX_REVISION_CHARS = 64
const ENVELOPE_KEYS = Object.freeze(['version', 'algorithm', 'ciphertext'])
const TOMBSTONE_KEYS = Object.freeze(['version', 'algorithm', 'revoked', 'revision'])

function fail(code, detail) {
  const err = new Error(code)
  err.code = code
  if (detail !== undefined) err.detail = String(detail).slice(0, 64)
  throw err
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  const own = Object.keys(value)
  if (own.length !== keys.length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(value, k))
}

function isPositiveSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CIPHER_B64) return false
  if (value.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

function cookieDomainValid(domain) {
  if (typeof domain !== 'string' || domain.length < 3 || domain.length > 253) return false
  if (domain !== domain.toLowerCase()) return false
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)
}

/**
 * 严格校验「要落盘的 record」；通过后返回一份**只含白名单字段的全新对象**。
 * 任何多余 key、错类型、超限、非白名单 cookie 名一律拒绝（不是“尽力清洗”）。
 */
export function validateRememberedRecord(record) {
  if (!isPlainObject(record) || !hasExactKeys(record, ['version', 'consent', 'account', 'preferences'])) fail(C.INVALID, 'record')
  if (record.version !== STORE_VERSION) fail(C.INVALID, 'version')

  const consent = record.consent
  if (!isPlainObject(consent) || !hasExactKeys(consent, ['version', 'autoRestore', 'autoReadBalance', 'autoRefresh', 'confirmedAt'])) fail(C.INVALID, 'consent')
  if (consent.version !== 1) fail(C.INVALID, 'consent.version')
  if (consent.autoRestore !== true || consent.autoReadBalance !== true || consent.autoRefresh !== true) fail(C.INVALID, 'consent.flags')
  if (!isPositiveSafeInt(consent.confirmedAt)) fail(C.INVALID, 'consent.confirmedAt')

  const account = record.account
  if (!isPlainObject(account) || !hasExactKeys(account, ['version', 'namespace', 'accountId', 'cookies'])) fail(C.INVALID, 'account')
  if (account.version !== 1) fail(C.INVALID, 'account.version')
  if (account.namespace !== STORE_NAMESPACE) fail(C.INVALID, 'account.namespace')
  if (typeof account.accountId !== 'string' || account.accountId.length > MAX_ID_LEN) fail(C.INVALID, 'account.accountId')
  // 稳定账号 ID：纯十进制、无前导零、无符号/空白（协议侧仍会做一次语义比较）。
  if (!/^[1-9][0-9]{0,19}$/.test(account.accountId)) fail(C.INVALID, 'account.accountId')

  const cookies = account.cookies
  if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > MAX_COOKIES) fail(C.INVALID, 'account.cookies')
  const names = new Set()
  const outCookies = cookies.map((cookie) => {
    if (!isPlainObject(cookie) || !hasExactKeys(cookie, ['name', 'value', 'domain', 'path', 'hostOnly', 'secure', 'httpOnly', 'expiresAt'])) {
      fail(C.INVALID, 'cookie.shape')
    }
    if (ACCOUNT_COOKIE_NAMES.indexOf(cookie.name) < 0) fail(C.INVALID, 'cookie.name')
    if (names.has(cookie.name)) fail(C.INVALID, 'cookie.duplicate')
    names.add(cookie.name)
    // 值保留原始字节（含可能的引号），不 decode/trim/反转义。
    if (typeof cookie.value !== 'string' || cookie.value.length < 1 || cookie.value.length > MAX_VALUE_LEN) fail(C.INVALID, 'cookie.value')
    if (!cookieDomainValid(cookie.domain)) fail(C.INVALID, 'cookie.domain')
    if (typeof cookie.path !== 'string' || cookie.path.length < 1 || cookie.path.length > 512 || cookie.path.charAt(0) !== '/') fail(C.INVALID, 'cookie.path')
    if (typeof cookie.hostOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || typeof cookie.httpOnly !== 'boolean') fail(C.INVALID, 'cookie.flags')
    if (cookie.expiresAt !== null && !isPositiveSafeInt(cookie.expiresAt)) fail(C.INVALID, 'cookie.expiresAt')
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      hostOnly: cookie.hostOnly,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expiresAt: cookie.expiresAt
    }
  })

  const preferences = record.preferences
  if (!isPlainObject(preferences) || !hasExactKeys(preferences, ['paused'])) fail(C.INVALID, 'preferences')
  if (typeof preferences.paused !== 'boolean') fail(C.INVALID, 'preferences.paused')

  return {
    version: STORE_VERSION,
    consent: {
      version: 1,
      autoRestore: true,
      autoReadBalance: true,
      autoRefresh: true,
      confirmedAt: consent.confirmedAt
    },
    account: {
      version: 1,
      namespace: STORE_NAMESPACE,
      accountId: account.accountId,
      cookies: outCookies
    },
    // 暂停刷新是**独立**持久化开关：consent 三项 true 仍表示本人允许，paused 只表示当前停用。
    preferences: { paused: preferences.paused }
  }
}

/** 凭据 key：`plan-usage/mimo-remembered-<sha256(scope) 前 24 hex>`（scope 不落盘）。 */
export function credentialKeyForScope(scope) {
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > 512 || /[\u0000-\u001f\u007f]/.test(scope)) fail(C.SCOPE_INVALID)
  const digest = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 24)
  return STORE_SCOPE_OWNER + '/' + STORE_RECORD_PREFIX + digest
}

function revisionOfCiphertext(ciphertext) {
  // 只绑定算法与密文本体：provider（YAML）可能改变 key 顺序，revision 不能因此漂移。
  return createHash('sha256').update(STORE_ALGORITHM + '\u0000' + '1' + '\u0000' + ciphertext, 'utf8').digest('hex').slice(0, 24)
}

function encodeEnvelope(cipherBytes) {
  const envelope = { version: 1, algorithm: STORE_ALGORITHM, ciphertext: Buffer.from(cipherBytes).toString('base64') }
  if (envelope.ciphertext.length > MAX_CIPHER_B64) fail(C.TOO_LARGE, 'ciphertext')
  return { envelope, revision: revisionOfCiphertext(envelope.ciphertext) }
}

function encodeTombstone() {
  const envelope = { version: 1, algorithm: STORE_ALGORITHM, revoked: true, revision: randomBytes(12).toString('hex') }
  return { envelope, revision: envelope.revision }
}

/**
 * 读一个 record 的信封；返回 none / live / tombstone。
 * 任何不认识的形状都拒绝（fail closed），不删除、不猜测。
 */
function readEnvelope(record) {
  if (record === undefined || record === null) return { kind: 'none' }
  if (!isPlainObject(record)) fail(C.INVALID, 'record.shape')
  if (record.kind !== 'grant' || !isPlainObject(record.payload)) fail(C.INVALID, 'record.kind')
  const payload = record.payload
  if (payload.version !== 1 || payload.algorithm !== STORE_ALGORITHM) fail(C.INVALID, 'envelope.header')
  if (payload.revoked === true) {
    if (!hasExactKeys(payload, TOMBSTONE_KEYS)) fail(C.INVALID, 'tombstone.shape')
    if (typeof payload.revision !== 'string' || !/^[a-f0-9]{16,64}$/.test(payload.revision)) fail(C.INVALID, 'tombstone.revision')
    return { kind: 'tombstone', revision: payload.revision }
  }
  if (!hasExactKeys(payload, ENVELOPE_KEYS)) fail(C.INVALID, 'envelope.shape')
  if (!isBase64(payload.ciphertext)) fail(C.INVALID, 'envelope.ciphertext')
  return { kind: 'live', envelope: payload, revision: revisionOfCiphertext(payload.ciphertext) }
}

/**
 * @param {object} options
 * @param {object} options.credentials  宿主凭据服务（需 readRecord + modifyRecord）
 * @param {string} options.scope  稳定 profile 上下文（不能是 cwd / bootEpoch；缺失 fail closed）
 * @param {object} [options.crypto]  默认 createWindowsDpapi({scope})；测试可注入 fake
 * @param {() => number} [options.now]
 */
export function createRememberedVault(options = {}) {
  const scope = options.scope
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > 512 || /[\u0000-\u001f\u007f]/.test(scope)) fail(C.SCOPE_INVALID)
  const credentials = options.credentials
  const key = credentialKeyForScope(scope)
  const cryptoImpl = options.crypto === undefined || options.crypto === null
    ? createWindowsDpapi({ scope })
    : options.crypto
  const providerReady = credentials !== undefined && credentials !== null &&
    typeof credentials.readRecord === 'function' && typeof credentials.modifyRecord === 'function'

  let disposed = false
  let epoch = 0

  function assertLive() {
    if (disposed) fail(C.DISPOSED)
  }

  function bump() {
    epoch += 1
    return epoch
  }

  async function capability() {
    if (disposed) return { supported: false, code: C.DISPOSED }
    if (!providerReady) return { supported: false, code: C.UNSUPPORTED }
    if (typeof cryptoImpl.capability !== 'function') return { supported: false, code: C.UNSUPPORTED }
    const cap = await cryptoImpl.capability()
    if (cap === undefined || cap === null || cap.supported !== true) {
      return { supported: false, code: normalizeCode(cap && cap.code, C.UNSUPPORTED) }
    }
    return { supported: true, code: 'OK' }
  }

  async function load(runtime = {}) {
    assertLive()
    if (!providerReady) fail(C.UNSUPPORTED)
    const at = epoch
    if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
    let record
    try {
      record = await credentials.readRecord(key)
    } catch {
      fail(C.FAILED)
    }
    if (disposed || at !== epoch) fail(disposed ? C.DISPOSED : C.CANCELLED)
    if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
    const seen = readEnvelope(record)
    if (seen.kind === 'none') return { record: null, revision: null }
    if (seen.kind === 'tombstone') return { record: null, revision: seen.revision }

    // 只有确实存在活信封才需要解密能力：空记录/墓碑不启动 DPAPI 子进程。
    const cap = await capability()
    if (disposed || at !== epoch) fail(disposed ? C.DISPOSED : C.CANCELLED)
    if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
    if (cap.supported !== true) fail(cap.code === 'OK' ? C.UNSUPPORTED : cap.code)
    let plain
    try {
      plain = await cryptoImpl.unprotect(new Uint8Array(Buffer.from(seen.envelope.ciphertext, 'base64')), { signal: runtime.signal })
    } catch (err) {
      fail(normalizeCode(err && err.code, C.FAILED))
    }
    if (disposed || at !== epoch) fail(disposed ? C.DISPOSED : C.CANCELLED)
    let parsed
    try {
      const text = Buffer.from(plain).toString('utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) fail(C.TOO_LARGE)
      parsed = JSON.parse(text)
    } catch (err) {
      fail(err && err.code === C.TOO_LARGE ? C.TOO_LARGE : C.INVALID)
    }
    const recordOut = validateRememberedRecord(parsed)
    return { record: recordOut, revision: seen.revision }
  }

  async function save(record, runtime = {}) {
    assertLive()
    if (!providerReady) fail(C.UNSUPPORTED)
    if (!Object.prototype.hasOwnProperty.call(runtime, 'expectedRevision')) fail(C.REVISION_REQUIRED)
    const expectedRevision = runtime.expectedRevision
    if (expectedRevision !== null && (typeof expectedRevision !== 'string' || expectedRevision.length > MAX_REVISION_CHARS)) {
      fail(C.INVALID, 'expectedRevision')
    }
    // epoch 在**调用入口**捕获：capability 的 await 期间若 forget/dispose 发生，旧 save 不能变成新一代写。
    const at = epoch
    if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
    const valid = validateRememberedRecord(record)
    const plainBytes = Buffer.from(JSON.stringify(valid), 'utf8')
    if (plainBytes.length > MAX_RECORD_BYTES) fail(C.TOO_LARGE)
    const cap = await capability()
    if (disposed || at !== epoch) fail(disposed ? C.DISPOSED : C.CANCELLED)
    if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
    if (cap.supported !== true) fail(cap.code === 'OK' ? C.UNSUPPORTED : cap.code)

    let committed = null
    try {
      await credentials.modifyRecord(key, async (current) => {
        // 独占时刻：先把“现有信封”与 expectedRevision 对齐，再加密，绝不先加密后比较。
        if (disposed || at !== epoch) return undefined
        if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
        const seen = readEnvelope(current)
        if (expectedRevision === null) {
          if (seen.kind !== 'none') fail(C.REVISION_CONFLICT)
        } else if (seen.kind === 'none' || seen.revision !== expectedRevision) {
          fail(C.REVISION_CONFLICT)
        }
        let cipher
        try {
          cipher = await cryptoImpl.protect(plainBytes, { signal: runtime.signal })
        } catch (err) {
          fail(normalizeCode(err && err.code, C.FAILED))
        }
        if (disposed || at !== epoch) return undefined
        if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
        const encoded = encodeEnvelope(cipher)
        committed = encoded
        return { kind: 'grant', payload: encoded.envelope }
      })
    } catch (err) {
      fail(normalizeCode(err && err.code, C.FAILED))
    }
    if (disposed || at !== epoch) {
      // modifyRecord 可能已写入；这里只保证“迟到者不再返回成功、不再触发后续写”。
      fail(disposed ? C.DISPOSED : C.CANCELLED)
    }
    if (committed === null) fail(C.FAILED)
    return { revision: committed.revision }
  }

  async function forget(runtime = {}) {
    assertLive()
    if (!providerReady) fail(C.UNSUPPORTED)
    if (runtime.signal !== undefined && runtime.signal !== null && runtime.signal.aborted === true) fail(C.CANCELLED)
    // 先作废在途操作：迟到 save 在独占时刻会看到 epoch 变化而不再写。
    // 注：vault 不直接持有 DPAPI 子进程句柄，已启动的加解密子进程最多跑到自己的超时即结束；
    // 它之后的写入一定被 epoch 检查拦住，因此 tombstone 不会被旧 save 覆盖。
    bump()
    const tomb = encodeTombstone()
    let committed = false
    try {
      await credentials.modifyRecord(key, async () => {
        if (disposed) return undefined
        committed = true
        return { kind: 'grant', payload: tomb.envelope }
      })
    } catch (err) {
      fail(normalizeCode(err && err.code, C.FAILED))
    }
    if (!committed) fail(C.CANCELLED)
    // Host-only 非 secret 元数据：只用于同进程 CAS 交接，不通过 route/status/GUI 外泄
    return { revision: tomb.revision }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    bump()
    if (cryptoImpl !== undefined && cryptoImpl !== null && typeof cryptoImpl.dispose === 'function') {
      try { cryptoImpl.dispose() } catch { /* ignore */ }
    }
  }

  return { capability, load, save, forget, dispose }
}

export { readEnvelope as _readEnvelopeForTests }
