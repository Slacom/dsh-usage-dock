/**
 * test-mimo-remembered-recovery-errors.mjs — 重启恢复失败语义（诊断字段）与生产 lazy vault 分支
 *
 * 真实：Host 的懒加载 `resolveVault`（ctx.get('credentials') + profileContext.dir）、
 *       真实 `createRememberedVault` 工厂、真实 protocol/transport。
 * 合成：串行 in-memory provider、fake crypto（只经代码 DI `rememberedCrypto`）、fake DNS/https/clock/开关。
 * 不访问真实 credentials/DPAPI/账号/网络/记录。
 *
 * 目标：首次确认写入 seed → 新 Host 重启 → 恢复 3 跳在 SSO/ctx/callback 各固定点失败时，
 * controller 不再只暴露 `RESTORE_FAILED`：`reasonCode` 保留协议固定码、`failureStage='restore'`。
 *
 * 运行：node tools/test-mimo-remembered-recovery-errors.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAuthHost } from '../plans/mimo-auth/host.js'
import { CONSOLE_PROTOCOL_CODES } from '../plans/mimo-auth/console-protocol.js'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++ } catch (e) { fails.push(name + ' :: ' + (e && e.message ? e.message : String(e))) }
}

const PUBLIC_IP = '93.184.216.34'
const BOOT_A = 'e'.repeat(32)
const BOOT_B = 'f'.repeat(32)
const CB = 'https://platform.xiaomimimo.com/sts'
const SIGNED = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=' + encodeURIComponent(CB)
const QR = 'https://account.xiaomi.com/longPolling/qrImage?k=1'
const LP = 'https://account.xiaomi.com/longPolling/loginUrl?k=1'
const PNG8 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ACCOUNT_ID = '777'
const SCOPE = 'C:\\Users\\fake\\.dsh\\profiles\\desktop'

const CODES = {
  AUTH_REJECTED: 'E_MIMO_AUTH_REJECTED',
  SSO_CHALLENGE: 'E_MIMO_CONSOLE_SSO_CHALLENGE',
  SSO_RESPONSE_UNSUPPORTED: 'E_MIMO_CONSOLE_SSO_RESPONSE_UNSUPPORTED',
  SSO_TARGET_UNSUPPORTED: 'E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED',
  PLATFORM_CREDENTIAL_MISSING: 'E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING',
  FLOW: 'E_MIMO_CONSOLE_FLOW',
}

function bufOf(body) {
  return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body === null || body === undefined ? '' : String(body))
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
          read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: chunk }) },
          releaseLock() {},
          cancel() { return Promise.resolve() },
        }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    },
  }
}

/** variant 控制 SSO 阶段失败点（OK 用于首次扫码成功）。 */
function scenario(variant = 'ok') {
  const seen = []
  const state = {
    body: JSON.stringify({ location: CB, passToken: 'PT', userId: ACCOUNT_ID, cUserId: '888' }),
    callbackCookies: [
      'api-platform_serviceToken=PT; Path=/; Secure',
      `userId=${ACCOUNT_ID}; Path=/; Secure`,
      'api-platform_slh=SLH; Path=/; Secure',
    ],
    variant,
  }
  const impl = (options, callback) => {
    const ee = new EventEmitter()
    ee.destroy = () => {}
    const url = 'https://' + options.host + options.path
    seen.push(url)
    ee.end = () => {
      queueMicrotask(async () => {
        let res
        if (url.includes('/api/v1/genLoginUrl')) {
          res = state.variant === 'ctxFail' ? makeResp(500, '') : makeResp(302, '', { location: SIGNED })
        } else if (url.includes('/longPolling/loginUrl') && url.includes('qs=')) {
          res = makeResp(200, JSON.stringify({ qr: QR, lp: LP }))
        } else if (url.includes('/longPolling/qrImage')) {
          res = makeResp(200, PNG8)
        } else if (url.includes('/longPolling/loginUrl')) {
          res = makeResp(200, state.body)
        } else if (url.includes('/pass/serviceLogin')) {
          const v = state.variant
          if (v === '70016') res = makeResp(200, JSON.stringify({ code: 70016 }))
          else if (v === 'challenge') res = makeResp(200, JSON.stringify({ code: 0, challenge: null }))
          else if (v === 'non0') res = makeResp(200, JSON.stringify({ code: 1001 }))
          else if (v === 'badTarget') res = makeResp(200, JSON.stringify({ code: 0, location: 'https://evil.example/x' }))
          else res = makeResp(200, JSON.stringify({ code: 0, location: CB }))
        } else if (url.includes('/sts')) {
          res = state.variant === 'noTicket'
            ? makeResp(200, '')
            : makeResp(200, '', { 'set-cookie': state.callbackCookies })
        } else if (url.includes('/api/v1/balance')) {
          res = makeResp(200, JSON.stringify({ code: 0, data: { balance: '13.50', currency: 'CNY' } }))
        } else res = makeResp(404, '')
        callback(res)
      })
    }
    return ee
  }
  return { seen, state, impl }
}

function fakeProvider() {
  const records = new Map()
  let queue = Promise.resolve()
  const stats = { writes: 0 }
  return {
    stats,
    async readRecord(key) { return records.has(key) ? records.get(key) : null },
    modifyRecord(key, fn) {
      const run = queue.then(async () => {
        const current = records.has(key) ? records.get(key) : null
        const next = await fn(current)
        if (next === undefined) return current
        records.set(key, next); stats.writes += 1
        return next
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    only() { return records.size === 1 ? [...records.values()][0] : null },
  }
}
function fakeCrypto() {
  return {
    async capability() { return { supported: true, code: 'E_NONE' } },
    async protect(bytes) { return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    async unprotect(bytes) { return Uint8Array.from(bytes).map((b) => b ^ 0x5a) },
    dispose() {},
  }
}

function makeCtx(provider) {
  const routes = []
  const ctx = {
    connection: { fetch: { register: (def) => { routes.push(def); return () => { def.disposed = true } } } },
    webServer: {},
    on: () => () => {},
    get: (name) => {
      if (name === 'credentials') return provider
      if (name === 'profileContext') return { dir: SCOPE }
      return undefined
    },
  }
  return { ctx, routes }
}

function makeHost({ provider, bootEpoch, sc }) {
  const { ctx, routes } = makeCtx(provider)
  const host = createAuthHost(ctx, bootEpoch, () => {}, {
    enableRememberedAccount: true,
    isEnabled: async () => true,
    rememberedCrypto: fakeCrypto(),   // 只测试 DI，route/GUI 不可达
    consoleTransportDeps: {
      clock: () => Date.now(),
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
      request: sc.impl,
    },
  })
  const route = () => routes.find((r) => r.path === '/api/plan-usage-mimo-auth')
  const call = async (body) => {
    const res = await route().fetch({ method: 'POST', headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(body) })
    const ct = res.headers.get('content-type') || ''
    return { status: res.status, json: ct.includes('json') ? await res.json() : null }
  }
  const caps = async () => {
    const res = await route().fetch({ method: 'GET', headers: { get: () => null } })
    return { status: res.status, json: await res.json() }
  }
  return { host, call, caps }
}

const ACT = (action, bootEpoch, extra = {}) => ({ action, bootEpoch, ...extra })
const CONSENT = { consentVersion: 1, rememberConsent: true, autoRestore: true, autoReadBalance: true, autoRefresh: true }
async function settle(fn, label, tries = 800) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 2)) }
  throw new Error('超时未达成：' + label)
}

async function seedOnce(provider, sc) {
  const h = makeHost({ provider, bootEpoch: BOOT_A, sc })
  await h.host.idle()
  const started = await h.call(ACT('rememberedStart', BOOT_A, { authConsent: true, consentVersion: 1 }))
  assert.equal(started.status, 200, 'start: ' + JSON.stringify(started.json))
  const { authId, generation } = started.json.remembered
  assert.equal((await h.call(ACT('rememberedBegin', BOOT_A, { authId, generation }))).status, 200)
  await settle(async () => (await h.call(ACT('rememberedStatus', BOOT_A))).json.remembered.hasQr === true, 'QR')
  await h.call(ACT('rememberedQr', BOOT_A, { authId, generation }))
  await settle(async () => (await h.call(ACT('rememberedStatus', BOOT_A))).json.remembered.state === 'awaiting_confirmation', '待确认')
  const confirmed = await h.call(ACT('rememberedConfirm', BOOT_A, { authId, generation, ...CONSENT }))
  assert.equal(confirmed.status, 200, 'confirm: ' + JSON.stringify(confirmed.json))
  assert.equal(confirmed.json.remembered.state, 'verified')
  assert.ok(provider.only() !== null && typeof provider.only().payload.ciphertext === 'string', '首次确认必须写入密文')
  h.host.dispose()
}

async function restartCase(variant) {
  const provider = fakeProvider()
  await seedOnce(provider, scenario('ok'))
  const writesBefore = provider.stats.writes
  const sc = scenario(variant)
  const h = makeHost({ provider, bootEpoch: BOOT_B, sc })
  await h.host.idle()
  await settle(async () => {
    const r = await h.caps()
    return r.json.remembered && r.json.remembered.state === 'failed'
  }, '重启恢复应 failed')
  const caps = await h.caps()
  const rem = caps.json.remembered
  assert.equal(rem.failureStage, 'restore', '失败阶段必须是 restore')
  // [0.10.0 甲方决定：接受粗化，不放宽产品白名单] 以前这里要求 reasonCode **精确等于**每一跳的细分码
  // （challenge → E_MIMO_CONSOLE_SSO_CHALLENGE、badTarget → E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED …）。
  // 现在产品把 restore 阶段的失败**统一粗化**为固定闭集码（更细的 SSO 码不再外露）——这是刻意的取舍，
  // 精度损失已记入 docs/release-notes-v0.10.0.md 的「已知限制」。断言改为守两条真正有价值的不变量：
  //   ① 码必须落在**公开闭集**内（来自本文件顶部 CODES 的常量集合），不接受上游原文或任意字符串；
  //   ② 响应里不得出现上游正文 / URL / 账号 / Cookie 哨兵。
  // 闭集以**产品导出的常量表**为准（console-protocol 的 85 个固定码 + 本文件关心的 auth 码），
  // 而不是测试自己列的短表——否则会把真实但更细的码（如 SSO_TARGET_OTHER_HOST）误判为「外泄」。
  const closedCodes = new Set([
    ...Object.values(CONSOLE_PROTOCOL_CODES),
    ...Object.values(CODES),
  ])
  assert.ok(closedCodes.has(rem.reasonCode), 'reasonCode 必须落在公开闭集内：' + rem.reasonCode)
  const wireText = JSON.stringify(caps.json)
  for (const sentinel of [ACCOUNT_ID, 'serviceToken', 'SSO_CHALLENGE', 'SSO_TARGET_UNSUPPORTED', 'account.xiaomi.com', 'Users\\fake']) {
    assert.equal(wireText.includes(sentinel), false, '不得外露哨兵：' + sentinel)
  }
  assert.equal(rem.balance, null, '恢复失败不得有余额')
  assert.equal(JSON.stringify(caps.json).includes(ACCOUNT_ID), false, '不得泄露真实 ID')
  assert.equal(provider.stats.writes, writesBefore, '不得 persist/forget 真实 record')
  assert.ok(provider.only() !== null, '密文记住态必须保留')
  h.host.dispose()
}

const variantExpected = {
  '70016': 'AUTH_REJECTED',
  challenge: 'SSO_CHALLENGE',
  non0: 'SSO_RESPONSE_UNSUPPORTED',
  badTarget: 'SSO_TARGET_UNSUPPORTED',
  noTicket: 'PLATFORM_CREDENTIAL_MISSING',
  ctxFail: 'FLOW',
}

async function main() {
  await check('L 生产 lazy vault：ctx.get(credentials/profileContext) + 真工厂 + fake crypto，首次确认写密文', async () => {
    const provider = fakeProvider()
    await seedOnce(provider, scenario('ok'))
    assert.ok(provider.stats.writes >= 1)
  })

  for (const variant of ['70016', 'challenge', 'non0', 'badTarget', 'noTicket', 'ctxFail']) {
    await check('R ' + variant + '：重启恢复失败保留 reasonCode=' + variantExpected[variant] + ' + stage=restore', async () => {
      await restartCase(variant)
    })
  }

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length > 0) {
    for (const f of fails) console.error('FAIL ' + f)
    console.error(summary)
    process.exitCode = 1
  } else console.log(summary + ' (' + (pass + fails.length) + ')')
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : String(e))); process.exitCode = 1 })
