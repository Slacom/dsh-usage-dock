/**
 * windows-dpapi.js — Windows DPAPI(CurrentUser) 最小封装（Host 半，纯本地、无网络）
 *
 * 只做三件事：**能力自检**、**Protect(明文→DPAPI 密文)**、**Unprotect(密文→明文)**。
 * 它不读配置、不读凭据服务、不认识 MiMo 账号/票据字段 —— 加密什么由调用方决定。
 *
 * 关键边界
 *  - 仅 `win32`；首选绝对路径 `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe`，
 *    **不搜索 PATH、不加 ExecutionPolicyBypass、不要管理员权限**。
 *  - 秘密只经 **stdin 写入、stdout 读回**；绝不进 argv / 环境变量 / 临时明文文件 / 日志。
 *  - 脚本失败只返回**固定码**，不把 PowerShell 异常或 stderr 原文向上抛（避免秘密随消息外泄）。
 *  - entropy 由固定用途串 + 完整 `scope` 派生，使密文绑定用途与 profile：跨 profile 搬密文解不开。
 *  - DPAPI(CurrentUser) 只防“文件被拷走 / 其他 Windows 用户 / 备份泄露”，
 *    **不防同用户进程**（Host 与 agent 同 UID）。本文件不作更强声明。
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const DPAPI_ALGORITHM = 'windows-dpapi-current-user'
export const DPAPI_PURPOSE = 'dsh-usage-dock/mimo-remembered/v1'

export const DPAPI_CODES = Object.freeze({
  UNSUPPORTED: 'E_MIMO_STORE_UNSUPPORTED',
  UNAVAILABLE: 'E_MIMO_STORE_DPAPI_UNAVAILABLE',
  FAILED: 'E_MIMO_STORE_DPAPI_FAILED',
  INVALID: 'E_MIMO_STORE_DPAPI_INVALID',
  CANCELLED: 'E_MIMO_STORE_CANCELLED',
  TIMEOUT: 'E_MIMO_STORE_TIMEOUT',
  TOO_LARGE: 'E_MIMO_STORE_TOO_LARGE',
  DISPOSED: 'E_MIMO_STORE_DISPOSED',
  SCOPE_INVALID: 'E_MIMO_STORE_SCOPE_INVALID'
})

const C = DPAPI_CODES
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_BYTES = 256 * 1024
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4 + 4

function fail(code, detail) {
  const err = new Error(code)
  err.code = code
  if (detail !== undefined) err.detail = String(detail).slice(0, 64)
  throw err
}

/** 稳定 scope：非空、限长、无控制字符。 */
export function isValidScope(scope) {
  if (typeof scope !== 'string') return false
  if (scope.length < 1 || scope.length > 512) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(scope)
}

/** 由 scope 派生固定 entropy（不是密钥；只做用途/归属绑定）。 */
export function entropyForScope(scope) {
  if (!isValidScope(scope)) fail(C.SCOPE_INVALID)
  return createHash('sha256').update(DPAPI_PURPOSE + '\u0000' + scope, 'utf8').digest()
}

/** 解析绝对 PowerShell 路径；找不到就返回 null（调用方转 UNSUPPORTED）。 */
export function resolvePowershell() {
  if (process.platform !== 'win32') return null
  const root = process.env.SystemRoot
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) return null
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(exe) ? exe : null
}

function base64Of(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function bytesOfBase64(text) {
  const b = Buffer.from(text, 'base64')
  // 只接受规范 Base64（重编码必须一致），拒绝夹带内容的字符串。
  if (b.length === 0 || b.toString('base64') !== text) fail(C.INVALID)
  return b
}

function buildScript(body) {
  // 统一外壳：不输出异常、不读环境、只从 stdin 取一串 Base64，只向 stdout 写 Base64/标记。
  return [
    "$ErrorActionPreference = 'Stop'",
    '$ProgressPreference = \'SilentlyContinue\'',
    ...body,
    'exit 0'
  ].join('\n')
}

function protectScript(entropyB64) {
  return buildScript([
    'try {',
    '  Add-Type -AssemblyName System.Security',
    "  $raw = [Console]::In.ReadToEnd()",
    '  $data = [Convert]::FromBase64String($raw)',
    "  $ent = [Convert]::FromBase64String('" + entropyB64 + "')",
    '  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '  $cipher = [System.Security.Cryptography.ProtectedData]::Protect($data, $ent, $scope)',
    '  [Console]::Out.Write([Convert]::ToBase64String($cipher))',
    '} catch {',
    '  exit 3',
    '}'
  ])
}

function unprotectScript(entropyB64) {
  return buildScript([
    'try {',
    '  Add-Type -AssemblyName System.Security',
    "  $raw = [Console]::In.ReadToEnd()",
    '  $cipher = [Convert]::FromBase64String($raw)',
    "  $ent = [Convert]::FromBase64String('" + entropyB64 + "')",
    '  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '  $data = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $ent, $scope)',
    '  [Console]::Out.Write([Convert]::ToBase64String($data))',
    '} catch {',
    '  exit 4',
    '}'
  ])
}

function selfTestScript() {
  return buildScript([
    'try {',
    '  Add-Type -AssemblyName System.Security',
    '  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()',
    '  $data = New-Object byte[] 16',
    '  $ent = New-Object byte[] 16',
    '  $ent2 = New-Object byte[] 16',
    '  $rng.GetBytes($data); $rng.GetBytes($ent); $rng.GetBytes($ent2); $rng.Dispose()',
    '  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '  $cipher = [System.Security.Cryptography.ProtectedData]::Protect($data, $ent, $scope)',
    '  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $ent, $scope)',
    '  $same = $true',
    '  for ($i = 0; $i -lt $data.Length; $i++) { if ($plain[$i] -ne $data[$i]) { $same = $false } }',
    '  $rejected = $false',
    '  try { $null = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $ent2, $scope) }',
    '  catch [System.Security.Cryptography.CryptographicException] { $rejected = $true }',
    '  catch { }',
    "  if ($same -and $rejected) { [Console]::Out.Write('OK') } else { [Console]::Out.Write('FAIL') }",
    '} catch {',
    "  [Console]::Out.Write('FAIL')",
    '}'
  ])
}

/**
 * 造一个 DPAPI 封装。
 * @param {object} options
 * @param {string} options.scope  稳定 profile 上下文（构建者传入；缺失即 fail closed）
 * @param {Function} [options.spawnImpl]  代码级 DI（测试用；签名同 child_process.spawn）
 * @param {number} [options.timeoutMs]  单次子进程预算（默认 5s）
 * @param {number} [options.maxBytes]  明文/密文上限（默认 256KiB）
 */
export function createWindowsDpapi(options = {}) {
  const scope = options.scope
  if (!isValidScope(scope)) fail(C.SCOPE_INVALID)
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : nodeSpawn
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? Math.min(options.maxBytes, MAX_BYTES) : MAX_BYTES
  const maxBase64 = Math.ceil(maxBytes / 3) * 4 + 4
  const entropyB64 = base64Of(entropyForScope(scope))

  let disposed = false
  let capabilityPromise = null
  // 每个在途子进程各自登记一个取消器；dispose 取消**全部**，不是只记最后一个。
  const activeOps = new Set()

  function assertLive() {
    if (disposed) fail(C.DISPOSED)
  }

  function encodeScript(script) {
    // -EncodedCommand 只接受 UTF-16LE 的 Base64
    return Buffer.from(script, 'utf16le').toString('base64')
  }

  /**
   * 跑一次 PowerShell：秘密只走 stdin，stdout 只读回 Base64/标记；stderr 丢弃。
   * 返回 stdout 文本；失败按固定码抛出。
   */
  function runOnce(script, inputBase64, signal) {
    assertLive()
    const exe = resolvePowershell()
    if (exe === null) fail(C.UNSUPPORTED)
    if (signal !== undefined && signal !== null && signal.aborted === true) fail(C.CANCELLED)

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let child
      let timer = null
      let cancelOp = null
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        if (cancelOp !== null) activeOps.delete(cancelOp)
        fn(value)
      }
      const kill = () => {
        try { if (child !== undefined) child.kill('SIGKILL') } catch { /* ignore */ }
      }
      const rejectWith = (code) => finish(rejectPromise, Object.assign(new Error(code), { code }))
      cancelOp = () => { kill(); rejectWith(C.DISPOSED) }
      activeOps.add(cancelOp)
      const onAbort = () => {
        kill()
        finish(rejectPromise, Object.assign(new Error(C.CANCELLED), { code: C.CANCELLED }))
      }
      timer = setTimeout(() => {
        kill()
        finish(rejectPromise, Object.assign(new Error(C.TIMEOUT), { code: C.TIMEOUT }))
      }, timeoutMs)

      try {
        child = spawnImpl(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            SystemRoot: process.env.SystemRoot,
            ...process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR },
            ...process.env.PATH === undefined ? {} : { PATH: process.env.PATH }
          }
        })
      } catch {
        finish(rejectPromise, Object.assign(new Error(C.UNAVAILABLE), { code: C.UNAVAILABLE }))
        return
      }
      if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      const chunks = []
      let total = 0
      child.stdout.on('data', (chunk) => {
        total += chunk.length
        if (total > maxBase64) {
          kill()
          finish(rejectPromise, Object.assign(new Error(C.TOO_LARGE), { code: C.TOO_LARGE }))
          return
        }
        chunks.push(chunk)
      })
      child.on('error', () => {
        finish(rejectPromise, Object.assign(new Error(C.UNAVAILABLE), { code: C.UNAVAILABLE }))
      })
      child.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          finish(rejectPromise, Object.assign(new Error(C.FAILED), { code: C.FAILED }))
          return
        }
        finish(resolvePromise, Buffer.concat(chunks).toString('utf8').trim())
      })
      child.stdin.on('error', () => {
        // 子进程提前退出（策略/AV/参数）时 stdin 会 EPIPE；只按固定码失败，不写日志。
        finish(rejectPromise, Object.assign(new Error(C.FAILED), { code: C.FAILED }))
      })
      try {
        child.stdin.end(inputBase64)
      } catch {
        kill()
        finish(rejectPromise, Object.assign(new Error(C.FAILED), { code: C.FAILED }))
      }
    })
  }

  // 同一实例的 DPAPI 子进程串行执行（避免多个 PowerShell 抢资源）；
  // 每个在途调用仍各自登记取消器，dispose 会取消**全部** active，而不是只记最后一个。
  let chain = Promise.resolve()
  function run(script, inputBase64, signal) {
    const next = chain.then(() => runOnce(script, inputBase64, signal))
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  async function capability() {
    if (disposed) return { supported: false, code: C.DISPOSED }
    if (capabilityPromise !== null) return capabilityPromise
    capabilityPromise = (async () => {
      if (process.platform !== 'win32') return { supported: false, code: C.UNSUPPORTED }
      if (resolvePowershell() === null) return { supported: false, code: C.UNSUPPORTED }
      try {
        const out = await run(selfTestScript(), '', undefined)
        if (out === 'OK') return { supported: true, code: 'OK' }
        return { supported: false, code: C.UNAVAILABLE }
      } catch (err) {
        const raw = err && err.code
        const known = typeof raw === 'string' && Object.values(C).indexOf(raw) >= 0
        return { supported: false, code: known ? raw : C.UNAVAILABLE }
      }
    })()
    return capabilityPromise
  }

  async function ensureSupported() {
    const cap = await capability()
    if (cap.supported !== true) fail(cap.code === 'OK' ? C.UNAVAILABLE : cap.code)
  }

  async function protect(bytes, runtime = {}) {
    assertLive()
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail(C.INVALID)
    if (bytes.length > maxBytes) fail(C.TOO_LARGE)
    await ensureSupported()
    const out = await run(protectScript(entropyB64), Buffer.from(bytes).toString('base64'), runtime.signal)
    if (out.length === 0) fail(C.FAILED)
    const cipher = bytesOfBase64(out)
    return new Uint8Array(cipher)
  }

  async function unprotect(cipherBytes, runtime = {}) {
    assertLive()
    if (!(cipherBytes instanceof Uint8Array) || cipherBytes.length === 0) fail(C.INVALID)
    if (cipherBytes.length > maxBytes) fail(C.TOO_LARGE)
    await ensureSupported()
    const out = await run(unprotectScript(entropyB64), Buffer.from(cipherBytes).toString('base64'), runtime.signal)
    if (out.length === 0) fail(C.INVALID)
    const plain = bytesOfBase64(out)
    if (plain.length > maxBytes) fail(C.TOO_LARGE)
    return new Uint8Array(plain)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    // 取消全部在途调用（含尚未 spawn 的排队项：其 runOnce 起步会因 disposed 立即失败）。
    for (const cancel of [...activeOps]) {
      try { cancel() } catch { /* ignore */ }
    }
    activeOps.clear()
  }

  return { scope, capability, protect, unprotect, dispose }
}

/** 随机 revision（tombstone 用；不含任何账号字段）。 */
export function randomRevision(bytes = 12) {
  return randomBytes(bytes).toString('hex')
}
