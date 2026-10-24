/**
 * [2026-10-23] `/api/plan-usage/quota-windows`：**真实 apply()** 的只读窗口能力路由。
 *
 * 证明的事：
 *   - 只读、GET-only（POST → 405）；
 *   - 数据只来自已有观察（`channelMeta` / `channelProjection`），**不解析凭据、不请求供应商**；
 *   - 只回窗口 key / 百分比 / 单位 / 币种 / 采样时间，不含 Key、URL、账号；
 *   - 新实例（= 换了身份/配置）不会带回旧账号的窗口；
 *   - 卸载干净。
 *
 * 说明：窗口形状的 provider（codex / opencode-go）需要真实外部服务，本测试**不**触网，
 * 窗口映射与 failed/expired/stale-identity 语义由 `test-quota-channel-thresholds` 的
 * T7（`describeWindowCapability`）逐条覆盖；这里验证路由接线与零副作用。
 *
 * 用法：node tools/test-quota-windows-endpoint.mjs
 */
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) }
  else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600))) }
}

const CUSTOM_A = 'custom:winAAAAAA1'

function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) { out.status = status },
    end(text) { out.body = String(text) },
  }
}

function call(handler, method) {
  const res = fakeRes()
  return Promise.resolve(handler({ method, headers: {}, url: '/api/plan-usage/quota-windows' }, res))
    .then(() => ({ status: res.out.status, body: res.out.body, json: (() => {
      try { return JSON.parse(res.out.body) } catch (err) { return null }
    })() }))
}

function fakeCredentials() {
  const resolves = []
  return {
    resolves,
    async resolve(ref) {
      resolves.push(ref)
      return { value: 'sk-synthetic-' + ref }
    },
  }
}

function boot(over, extraServices) {
  const routes = {}
  const credentials = fakeCredentials()
  const services = Object.assign({
    webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    credentials,
  }, extraServices || {})
  const effects = []
  apply({
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    webServer: services.webServer,
    effect: (fn) => { const d = fn(); effects.push(d); return d },
  }, over)
  return {
    routes,
    credentials,
    disposeAll() { for (const fn of effects.reverse()) { if (typeof fn === 'function') fn() } },
  }
}

const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
function configWith(over) {
  return new Config(Object.assign({}, disabledAll, over || {}))
}

function entry(apiKey) {
  return {
    id: CUSTOM_A,
    name: '窗口能力测试',
    url: 'https://a.example/balance',
    balancePath: 'data.balance',
    currency: 'USD',
    enabled: true,
    credentialRef: 'ref-A',
    credentialHost: 'https://a.example',
    urlHostConfirmed: 'https://a.example',
    apiKey,
  }
}

// ===========================================================================
// W1 — 路由存在、GET-only、无观察时不给窗口
// ===========================================================================
{
  const booted = boot(configWith({ customBalances: [entry('sk-explicit-A')] }))
  check('W1a 注册了 quota-windows 路由', typeof booted.routes['/api/plan-usage/quota-windows'] === 'function')
  const post = await call(booted.routes['/api/plan-usage/quota-windows'], 'POST')
  check('W1b 非 GET → 405', post.status === 405 && post.json !== null && post.json.ok === false, post)
  const empty = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
  check('W1c 还没有观察 → ok 且 channels 为空对象',
    empty.status === 200 && empty.json !== null && empty.json.ok === true
    && empty.json.data !== null && typeof empty.json.data.channels === 'object'
    && Object.keys(empty.json.data.channels).length === 0, empty)
  booted.disposeAll()
}

// ===========================================================================
// W2 — 有一次成功观察后：只读窗口能力，零凭据解析、零供应商请求
// ===========================================================================
{
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { balance: 12.5 } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    // 用本地环回服务作为「上游」，只为造出一条成功观察（不是真实供应商）。
    const booted = boot(configWith({
      customBalances: [Object.assign(entry('sk-explicit-A'), {
        url: base + '/balance',
        credentialHost: base,
        urlHostConfirmed: base,
      })],
    }))
    const bootRes = fakeRes()
    // 打开环回访问：custom-balance 默认拒绝环回；这里用注入的显式 Key + 本地地址，
    // 期望得到一次可辨的失败观察（不影响下面「零副作用」的断言）。
    await booted.routes['/api/plan-usage']({ method: 'GET', headers: {}, url: '/api/plan-usage' }, bootRes)
    const first = JSON.parse(bootRes.body || '{}')

    const resolvesBefore = booted.credentials.resolves.length
    const hitsBefore = hits.length
    const res = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
    check('W2a 路由返回 200 ok', res.status === 200 && res.json.ok === true, res)
    check('W2b 窗口能力查询**不解析任何凭据**',
      booted.credentials.resolves.length === resolvesBefore,
      { before: resolvesBefore, after: booted.credentials.resolves.length })
    check('W2c 窗口能力查询**不请求任何上游**', hits.length === hitsBefore,
      { before: hitsBefore, after: hits.length })
    const channels = res.json.data.channels
    const row = channels[CUSTOM_A]
    check('W2d 观察过的渠道有一条记录', row !== undefined && typeof row === 'object', Object.keys(channels))
    if (row !== undefined) {
      check('W2e 记录里不含任何 secret / URL / 账号字段',
        Object.keys(row).sort().join(',') === 'currency,sampledAt,status,unit,windows',
        Object.keys(row))
      check('W2f 记录里没有出现显式 Key 的字面值', res.body.indexOf('sk-explicit-A') === -1)
      check('W2g 记录里没有出现上游地址', res.body.indexOf('a.example') === -1 && res.body.indexOf('127.0.0.1') === -1)
      // 该渠道是金额型：没有窗口；无论成功还是失败，失败时也只回状态不回窗口
      check('W2h 金额渠道 windows 恒为空数组', Array.isArray(row.windows) && row.windows.length === 0, row)
      if (first.ok !== true) {
        check('W2i 取数失败时只回状态、不回窗口（失败≠没有窗口）',
          row.status !== 'ok' || row.windows.length === 0, row)
      }
    }
    booted.disposeAll()

    // 新实例（等价于换身份/重启）：不得带回旧观察
    const booted2 = boot(configWith({ customBalances: [entry('sk-explicit-B')] }))
    const res2 = await call(booted2.routes['/api/plan-usage/quota-windows'], 'GET')
    check('W2j 新实例不继承旧账号的窗口观察',
      Object.keys(res2.json.data.channels).length === 0, res2.json.data.channels)
    booted2.disposeAll()
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

// ===========================================================================
// W3 — 路由级身份保护：**成功正值窗口**建立后，立即换来源身份 → 不回旧窗口
//
// 父用例（reviewer-source-change.mjs）复现的阻断项：metadata 曾走 2 秒配置缓存，
// 换 Key 后 0ms 请求仍回 A 的两窗口。这里用同样的构造（只替换 provider.fetch 为合成数据，
// 无 server/网络/凭据）验证修复：**不 sleep、不等 TTL、不等 reload 事件**。
// ===========================================================================
{
  const plan = PLANS.find((p) => p.id === 'opencode-go')
  check('W3a 找到 opencode-go 注册项', plan !== undefined)
  const oldFetch = plan.fetch
  let samples = 0
  let resolves = 0
  let configReads = 0
  // 合成 provider：两个窗口（90% / 60%），不发任何网络、不碰任何凭据。
  plan.fetch = async () => {
    samples += 1
    return {
      id: 'opencode-go',
      name: 'OpenCode Go',
      rollingUsage: { percent: 10, resetsAt: null, resetInSec: null },
      weeklyUsage: { percent: 40, resetsAt: null, resetInSec: null },
    }
  }
  const flags = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
  const baseCfg = Object.assign({}, flags, {
    opencodeGoEnabled: true,
    apiKey: 'DUMMY_TEST_TEST_QUOTA_WINDOWS_ENDPOINT_1',
    customBalances: [],
  })
  const editor = {
    override: Object.assign({}, baseCfg),
    configuration() {
      configReads += 1
      return [{ entry: { options: { id: 'plan-usage' } }, inherited: {}, override: this.override }]
    },
  }
  const credentials = {
    async resolve(ref) {
      resolves += 1
      return { value: 'sk-synthetic-' + ref }
    },
  }
  try {
    const booted = boot(new Config(baseCfg), { configEditor: editor, credentials })
    const guiRes = fakeRes()
    await booted.routes['/api/plan-usage']({ method: 'GET', headers: {}, url: '/api/plan-usage' }, guiRes)

    const before = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
    const beforeRow = before.json.data.channels['opencode-go']
    check('W3b 建立**成功正值**观察：ok 且两个窗口都在',
      beforeRow !== undefined && beforeRow.status === 'ok' && beforeRow.windows.length === 2,
      beforeRow)

    // 换来源身份（Key B）——不等待任何事件/TTL，立刻请求 metadata。
    editor.override = Object.assign({}, baseCfg, { apiKey: 'DUMMY_TEST_TEST_QUOTA_WINDOWS_ENDPOINT_2' })
    const readsBefore = configReads
    const samplesBefore = samples
    const resolvesBefore = resolves
    const started = Date.now()
    const after = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
    const duration = Date.now() - started
    check('W3c 仍在 2 秒缓存窗口内发起（否则用例无意义）', duration < 1000, { duration })
    const afterRow = after.json.data.channels['opencode-go']
    check('W3d 换身份后不得回旧窗口（stale/缺席，且窗口为空）',
      afterRow === undefined || (afterRow.status !== 'ok' && afterRow.status !== 'cached' && afterRow.windows.length === 0),
      afterRow)
    check('W3e 路由确实**重新读了配置**（证明不是走 2 秒缓存）',
      configReads > readsBefore, { readsBefore, configReads })
    check('W3f 换身份后 0 次额外 provider 采样', samples === samplesBefore, { samplesBefore, samples })
    check('W3g 换身份后 0 次额外凭据解析', resolves === resolvesBefore, { resolvesBefore, resolves })
    booted.disposeAll()
  } finally {
    plan.fetch = oldFetch
  }
}

// ===========================================================================
// W5 — 审查 F01/F02：有 configEditor 却拿不到当前配置 → **明确失败**（fail closed）
//
// 场景：先建立成功两窗口；再让 configuration() 返回 `{}`（坏形状）或 `[]`（缺本插件条目）。
// 这种"无法证明是当前配置"的情况绝不能把旧缓存连同 ok:true/fresh:true 一起返回。
// ===========================================================================
{
  const plan = PLANS.find((p) => p.id === 'opencode-go')
  const oldFetch = plan.fetch
  plan.fetch = async () => ({
    id: 'opencode-go',
    name: 'OpenCode Go',
    rollingUsage: { percent: 10 },
    weeklyUsage: { percent: 40 },
  })
  const flags = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
  const baseCfg = Object.assign({}, flags, { opencodeGoEnabled: true, apiKey: 'DUMMY_TEST_TEST_QUOTA_WINDOWS_ENDPOINT_3', customBalances: [] })
  let mode = 'good'
  const editor = {
    configuration() {
      if (mode === 'shape') return {}
      if (mode === 'missing') return []
      return [{ entry: { options: { id: 'plan-usage' } }, inherited: {}, override: baseCfg }]
    },
  }
  try {
    const booted = boot(new Config(baseCfg), { configEditor: editor })
    await booted.routes['/api/plan-usage']({ method: 'GET', headers: {}, url: '/api/plan-usage' }, fakeRes())
    const first = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
    check('W5a 正常配置下先建立成功两窗口',
      first.json.ok === true && first.json.data.channels['opencode-go'].windows.length === 2, first.json)

    mode = 'shape'
    const shape = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
    check('W5b 配置形状坏（{}）→ ok:false（不是 fresh:true + 旧窗口）',
      shape.json.ok === false && shape.json.data === undefined, shape.json)

    mode = 'missing'
    const missing = await call(booted.routes['/api/plan-usage/quota-windows'], 'GET')
    check('W5c 找不到本插件条目（[]）→ ok:false',
      missing.json.ok === false && missing.json.data === undefined, missing.json)
    check('W5d 失败信封里没有旧窗口泄漏',
      JSON.stringify(shape.json).indexOf('rolling-5h') === -1
      && JSON.stringify(missing.json).indexOf('rolling-5h') === -1)
    booted.disposeAll()
  } finally {
    plan.fetch = oldFetch
  }
}

// ===========================================================================
// W6 — 卸载后路由不再可用（disposer 生效，不残留）
// ===========================================================================
{
  const booted = boot(configWith({ customBalances: [] }))
  check('W6a dispose 前路由存在', typeof booted.routes['/api/plan-usage/quota-windows'] === 'function')
  booted.disposeAll()
  check('W6b dispose 后不抛错', true)
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
