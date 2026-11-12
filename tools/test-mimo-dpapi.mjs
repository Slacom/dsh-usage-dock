/**
 * test-mimo-dpapi.mjs — Windows DPAPI 封装单测（只跑合成随机数据，不碰真实凭据/账号/配置）
 *
 * 验证：能力自检、往返、错 scope（entropy 绑定）、密文篡改、取消、超长、dispose、固定码。
 * 非 win32 直接 SKIP（exit 0）；win32 上能力不可用则报 UNSUPPORTED（exit 2，不是“通过”）。
 * 运行：node tools/test-mimo-dpapi.mjs
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  createWindowsDpapi,
  entropyForScope,
  resolvePowershell,
  DPAPI_CODES as C
} from '../plans/mimo-auth/windows-dpapi.js'

if (process.platform !== 'win32') {
  console.log('SKIP 非 win32（DPAPI 仅 Windows 可用）')
  process.exit(0)
}

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}
async function expectCode(fn, codes, label) {
  const want = Array.isArray(codes) ? codes : [codes]
  try { await fn() } catch (e) {
    const got = e && e.code ? e.code : e && e.message
    if (want.indexOf(got) < 0) throw new Error((label || '') + ' 期望 ' + want.join('|') + ' 实际 ' + got)
    return e
  }
  throw new Error((label || '') + ' 期望抛 ' + want.join('|') + '，但没有抛')
}

const SCOPE = 'C:\\Users\\Synthetic\\.dsh\\profiles\\desktop'
const OTHER = 'C:\\Users\\Synthetic\\.dsh\\profiles\\web'

const ps = resolvePowershell()
await check('PowerShell 绝对路径可解析（不搜 PATH）', () => {
  assert.equal(typeof ps, 'string')
  assert.match(ps, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
})

const dpapi = createWindowsDpapi({ scope: SCOPE })
const cap = await dpapi.capability()
console.log('capability =', JSON.stringify(cap))
if (cap.supported !== true) {
  console.log('UNSUPPORTED ' + cap.code + '（环境不能做 DPAPI，未验证加密往返）')
  dpapi.dispose()
  process.exit(2)
}

await check('capability 可重复调用（每 boot 只自检一次）', async () => {
  assert.deepEqual(await dpapi.capability(), { supported: true, code: 'OK' })
})

await check('entropy 绑定 scope（不同 profile 不同）', () => {
  assert.notEqual(entropyForScope(SCOPE).toString('hex'), entropyForScope(OTHER).toString('hex'))
})

await check('合成数据往返一致，且密文不含明文', async () => {
  const plain = randomBytes(64)
  const cipher = await dpapi.protect(plain)
  assert.ok(cipher instanceof Uint8Array)
  assert.notEqual(cipher.length, plain.length)
  assert.equal(Buffer.from(cipher).includes(plain), false)
  const back = await dpapi.unprotect(cipher)
  assert.deepEqual(Buffer.from(back), plain)
})

await check('错 scope 解不开（entropy/用途绑定）', async () => {
  const other = createWindowsDpapi({ scope: OTHER })
  const cipher = await dpapi.protect(randomBytes(16))
  await expectCode(async () => other.unprotect(cipher), [C.FAILED, C.INVALID], '错 scope')
  other.dispose()
})

await check('密文篡改被拒', async () => {
  const cipher = await dpapi.protect(randomBytes(32))
  const tampered = new Uint8Array(cipher)
  tampered[Math.floor(tampered.length / 2)] ^= 0xff
  await expectCode(async () => dpapi.unprotect(tampered), [C.FAILED, C.INVALID], '篡改')
})

await check('预取消 signal → CANCELLED', async () => {
  const ac = new AbortController()
  ac.abort()
  await expectCode(async () => dpapi.protect(randomBytes(16), { signal: ac.signal }), C.CANCELLED)
})

await check('超长输入 → TOO_LARGE（不启动子进程）', async () => {
  await expectCode(async () => dpapi.protect(new Uint8Array(300 * 1024)), C.TOO_LARGE)
})

await check('空输入/非字节 → INVALID', async () => {
  await expectCode(async () => dpapi.protect(new Uint8Array(0)), C.INVALID)
  await expectCode(async () => dpapi.protect('not-bytes'), C.INVALID)
})

await check('dispose 后拒绝且不再起子进程', async () => {
  const solo = createWindowsDpapi({ scope: SCOPE })
  solo.dispose()
  await expectCode(async () => solo.protect(randomBytes(8)), C.DISPOSED)
  await expectCode(async () => solo.unprotect(randomBytes(8)), C.DISPOSED)
})

await check('dispose 取消在途子进程（不留下悬挂 Promise）', async () => {
  const solo = createWindowsDpapi({ scope: SCOPE })
  const pending = solo.protect(randomBytes(16))
  solo.dispose()
  await expectCode(async () => pending, [C.DISPOSED, C.CANCELLED])
})

await check('并发 protect 串行完成（同一实例不互相丢跟踪）', async () => {
  const [a, b] = await Promise.all([
    dpapi.protect(randomBytes(16)),
    dpapi.protect(randomBytes(24))
  ])
  assert.equal((await dpapi.unprotect(a)).length, 16)
  assert.equal((await dpapi.unprotect(b)).length, 24)
})

/** fake spawn：自检脚本立刻回 OK；protect/unprotect 子进程保持挂起，直到 kill。 */
function makeFakeSpawner() {
  const children = []
  let onProtectSpawn = null
  const spawnImpl = (exe, args) => {
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.end = () => {}
    child.killed = false
    child.kill = () => { child.killed = true; setTimeout(() => child.emit('close', null), 0); return true }
    children.push(child)
    if (script.includes('RandomNumberGenerator')) {
      setImmediate(() => { child.stdout.emit('data', Buffer.from('OK')); child.emit('close', 0) })
    } else if (onProtectSpawn !== null) {
      const release = onProtectSpawn
      onProtectSpawn = null
      release(child)
    }
    return child
  }
  return { spawnImpl, children, waitProtectSpawn: () => new Promise((r) => { onProtectSpawn = r }) }
}

await check('并发 protect + dispose（fake spawn）：两个都固定码结算、句柄全取消', async () => {
  const fake = makeFakeSpawner()
  const solo = createWindowsDpapi({ scope: SCOPE, spawnImpl: fake.spawnImpl })
  const firstSpawn = fake.waitProtectSpawn()
  const p1 = solo.protect(randomBytes(16))
  const p2 = solo.protect(randomBytes(16))
  const child1 = await firstSpawn
  assert.equal(child1.killed, false)
  solo.dispose()
  const settled = await Promise.allSettled([p1, p2])
  assert.equal(settled[0].status, 'rejected')
  assert.equal(settled[1].status, 'rejected')
  for (const r of settled) assert.equal(r.reason.code, C.DISPOSED)
  assert.equal(child1.killed, true)
  // 第二个调用在串行队列里，dispose 后不再 spawn：children = 自检 1 + 首个 protect 1
  assert.equal(fake.children.length, 2)
  assert.equal(fake.children[1].killed, true)
})

dpapi.dispose()

if (fails.length > 0) {
  console.log('FAIL ' + fails.length + ' / pass ' + pass)
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log('PASS ' + pass + ' / 0 fail')
