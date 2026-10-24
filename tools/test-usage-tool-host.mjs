/**
 * [方向 6 / T2] Host 端到端测试：**真实 apply()** + 假 tools / systemPrompt / credentials 服务。
 *
 * 覆盖 D6 复核要求：
 *   - D6-A：只请求 A 时不解析 B 的凭据、不向 B 发请求（真实 `fetchCustomPlans`）。
 *   - D6-B：停用/不存在的自定义条目给出可辨状态且零取数。
 *   - D6-D：自定义条目失败（环回被拒）不进缓存，下一次仍会重新编排。
 *   - D6-G：策略生效时注册 systemPrompt 段落、随工具结果返回、卸载时清理。
 *   - 秘密哨兵不进入工具输出；缺服务/宿主拒绝注册不影响路由。
 *
 * 用法：node tools/test-usage-tool-host.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { TOOL_NAME } from '../plans/usage-tool.js'
import { fetchCustomPlans } from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}

function fakeTools() {
  const registered = new Map()
  const disposals = { count: 0 }
  const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'examples'])
  function assertSchema(node, path) {
    assert.ok(node !== null && typeof node === 'object', path + ' 必须是 schema 对象')
    for (const key of Object.keys(node)) assert.ok(ALLOWED.has(key), path + '.' + key + ' 不在宿主子集内')
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) assertSchema(v, path + '.' + k)
    if (node.items) assertSchema(node.items, path + '.items')
  }
  return {
    registered,
    disposals,
    register(definition) {
      assert.equal(typeof definition.name, 'string')
      assert.equal(typeof definition.output.render, 'function')
      assertSchema(definition.output.schema, 'output.schema')
      assertSchema(definition.parameters, 'parameters')
      assert.equal(definition.name, TOOL_NAME)
      let disposed = false
      registered.set(definition.name, definition)
      return () => {
        if (disposed) return
        disposed = true
        disposals.count += 1
        registered.delete(definition.name)
      }
    },
  }
}

/** 假 systemPrompt：记录注册的段落与 disposer。 */
function fakeSystemPrompt() {
  const sections = new Map()
  // [额度自动感知] 动态 context 与 section 是两套注册表。
  const contexts = new Map()
  const disposals = { count: 0 }
  return {
    sections,
    contexts,
    disposals,
    section(spec) {
      assert.ok(Number.isFinite(spec.order), 'order 必须是有限数')
      assert.equal(typeof spec.name, 'string')
      let disposed = false
      sections.set(spec.name, spec)
      return () => {
        if (disposed) return
        disposed = true
        disposals.count += 1
        if (sections.get(spec.name) === spec) sections.delete(spec.name)
      }
    },
    context(spec) {
      assert.ok(Number.isFinite(spec.order), 'context.order 必须是有限数')
      assert.equal(typeof spec.name, 'string')
      assert.equal(typeof spec.text, 'function', 'context.text 必须是函数')
      let disposed = false
      contexts.set(spec.name, spec)
      return () => {
        if (disposed) return
        disposed = true
        disposals.count += 1
        if (contexts.get(spec.name) === spec) contexts.delete(spec.name)
      }
    },
  }
}

/** 假凭据服务：记录被解析的引用名。 */
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

function boot(configOverride, options) {
  const opts = options || {}
  const routes = {}
  const tools = opts.tools === undefined ? fakeTools() : opts.tools
  const services = {
    webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
  }
  if (tools !== null) services.tools = tools
  if (opts.systemPrompt !== undefined && opts.systemPrompt !== null) services.systemPrompt = opts.systemPrompt
  if (opts.credentials !== undefined && opts.credentials !== null) services.credentials = opts.credentials
  const effects = []
  apply({
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    webServer: services.webServer,
    effect: (fn) => { const d = fn(); effects.push(d); return d },
  }, configOverride)
  return {
    routes,
    tools,
    systemPrompt: opts.systemPrompt,
    credentials: opts.credentials,
    disposeAll() {
      for (const fn of effects.reverse()) { if (typeof fn === 'function') fn() }
    },
  }
}

async function withBalanceServer(routes, fn) {
  const log = []
  const server = createServer((req, res) => {
    log.push({ url: req.url, auth: req.headers.authorization })
    const hit = routes[req.url]
    if (hit === undefined) { res.writeHead(404); res.end('{}'); return }
    res.writeHead(hit.status || 200, { 'content-type': 'application/json' })
    res.end(hit.body || '')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    return await fn(base, log)
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
const CUSTOM_A = 'custom:reviewAAAAAA'
const CUSTOM_B = 'custom:reviewBBBBBB'

function entries() {
  return [
    { id: CUSTOM_A, name: 'A', url: 'https://a.example/balance', balancePath: 'data.balance', currency: 'USD', enabled: true, credentialRef: 'ref-A', credentialHost: 'https://a.example', urlHostConfirmed: 'https://a.example' },
    { id: CUSTOM_B, name: 'B', url: 'https://b.example/balance', balancePath: 'data.balance', currency: 'USD', enabled: true, credentialRef: 'ref-B', credentialHost: 'https://b.example', urlHostConfirmed: 'https://b.example' },
  ]
}

function configWith(over) {
  return new Config(Object.assign({}, disabledAll, over || {}))
}

// ===========================================================================
// E1 — 真实 apply 注册 + disposer
// ===========================================================================
{
  const booted = boot(configWith({ deepseekEnabled: true }))
  check('E1a 真实 apply 后注册工具', booted.tools.registered.has(TOOL_NAME))
  check('E1b 参数只有 ids', Object.keys(booted.tools.registered.get(TOOL_NAME).parameters.properties).join(',') === 'ids')
  booted.disposeAll()
  check('E1c 卸载调用 disposer', booted.tools.disposals.count === 1, booted.tools.disposals)
}

// ===========================================================================
// E2 — 缺 tools 服务不影响路由
// ===========================================================================
{
  const routes = {}
  let threw = null
  try {
    apply({
      get: () => undefined,
      webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
      effect: (fn) => fn(),
    }, configWith({ deepseekEnabled: true }))
  } catch (err) { threw = err }
  check('E2a apply 不抛错', threw === null, threw && threw.message)
  check('E2b 用量路由在', typeof routes['/api/plan-usage'] === 'function')
  check('E2c custom-status 路由在', typeof routes['/api/plan-usage/custom-status'] === 'function')
}

// ===========================================================================
// E3 — D6-A：只请求 A 时不解析 B 的凭据（真实 fetchCustomPlans）
// ===========================================================================
{
  const credentials = fakeCredentials()
  const ctx = { get: () => credentials }
  const cfg = configWith({
    customBalances: entries(),
  })
  // 用 onlyIds 限制成 A：B 的凭据**不得**被解析。
  const list = await fetchCustomPlans(ctx, undefined, cfg, { allowLegacy: true, onlyIds: new Set([CUSTOM_A]), budgetMs: 50 })
  check('E3a 只返回请求的条目', Array.isArray(list) && list.length === 1 && list[0].id === CUSTOM_A, list && list.map((x) => x.id))
  check('E3b 只解析了 A 的凭据', credentials.resolves.length === 1 && credentials.resolves[0] === 'ref-A', credentials.resolves)
  check('E3c 从未解析 B 的凭据', !credentials.resolves.includes('ref-B'), credentials.resolves)

  // 空集合：零解析、零取数
  credentials.resolves.length = 0
  const none = await fetchCustomPlans(ctx, undefined, cfg, { allowLegacy: true, onlyIds: new Set(), budgetMs: 50 })
  check('E3d 空集合返回空', Array.isArray(none) && none.length === 0, none)
  check('E3e 空集合零凭据解析', credentials.resolves.length === 0, credentials.resolves)

  // 不传 onlyIds 时保持旧行为（全量）
  credentials.resolves.length = 0
  await fetchCustomPlans(ctx, undefined, cfg, { allowLegacy: true, budgetMs: 50 })
  check('E3f 未限制时才解析全部', credentials.resolves.length === 2, credentials.resolves)
}

// ===========================================================================
// E4 — 工具层：只请求 A 时结果里只有 A
// ===========================================================================
{
  const credentials = fakeCredentials()
  const booted = boot(configWith({ customBalances: entries() }), { credentials })
  const def = booted.tools.registered.get(TOOL_NAME)
  const out = await def.execute({ ids: [CUSTOM_A] })
  check('E4a 结果只有 A', out.channels.length === 1 && out.channels[0].id === CUSTOM_A, out.channels.map((c) => c.id))
  check('E4b B 的凭据未被解析', !credentials.resolves.includes('ref-B'), credentials.resolves)
  booted.disposeAll()
}

// ===========================================================================
// E5 — D6-C：停用 / 不存在 / 退场 状态可辨
// ===========================================================================
{
  const booted = boot(configWith({
    customBalances: [
      Object.assign(entries()[0], { enabled: false }),
    ],
  }))
  const def = booted.tools.registered.get(TOOL_NAME)
  const disabled = await def.execute({ ids: [CUSTOM_A] })
  check('E5a 停用条目返回 disabled', disabled.channels[0].errorCode === 'disabled', disabled.channels[0])

  const gone = await def.execute({ ids: ['custom:deleted00000'] })
  check('E5b 已删除条目返回 not-found', gone.channels[0].errorCode === 'not-found', gone.channels[0])

  const retired = await def.execute({ ids: ['kimi-code', 'glm-zhipu', 'glm-zai'] })
  check('E5c 退场全部 retired-channel', retired.channels.every((c) => c.errorCode === 'retired-channel'))
  check('E5d 退场无数值', retired.channels.every((c) => c.balance === null))
  booted.disposeAll()
}

// ===========================================================================
// E6 — 秘密不外泄（端到端）
// ===========================================================================
{
  const SENTINEL = 'sk-HOST-TOOL-LEAK-77bd'
  await withBalanceServer({ '/balance': { body: JSON.stringify({ data: { balance: 9.99 } }) } }, async (base) => {
    const booted = boot(configWith({
      customBalances: [{ id: CUSTOM_A, name: 'A', url: base + '/balance', balancePath: 'data.balance', currency: 'USD', enabled: true }],
      customKeys: { [CUSTOM_A]: SENTINEL },
    }))
    const def = booted.tools.registered.get(TOOL_NAME)
    const out = await def.execute({})
    const text = JSON.stringify(out) + JSON.stringify(def.output.render({}, out))
    check('E6a 条目在结果里', out.channels.length === 1 && out.channels[0].id === CUSTOM_A)
    check('E6b 不含 Key 哨兵', !text.includes(SENTINEL), text.slice(0, 300))
    check('E6c 不含 URL/端口', !text.includes('127.0.0.1'), text.slice(0, 300))
    check('E6d 环回目标被拒绝', out.channels[0].errorCode === 'config', out.channels[0])
    booted.disposeAll()
  })
}

// ===========================================================================
// E7 — D6-D：失败不缓存（下一次仍重新编排）
// ===========================================================================
{
  const credentials = fakeCredentials()
  const booted = boot(configWith({ customBalances: [entries()[0]] }), { credentials })
  const def = booted.tools.registered.get(TOOL_NAME)
  const first = await def.execute({})
  const afterFirst = credentials.resolves.length
  const second = await def.execute({})
  check('E7a 首次返回错误', first.channels[0].availability === 'error', first.channels[0])
  check('E7b 失败未被缓存（再次解析凭据）', credentials.resolves.length > afterFirst, { afterFirst, now: credentials.resolves.length })
  check('E7c 第二次仍是同一错误', second.channels[0].errorCode === first.channels[0].errorCode, second.channels[0])
  booted.disposeAll()
}

// ===========================================================================
// E8 — [额度自动感知] 策略改用**动态 context**（不再是常驻 section）
//
// 变更原因（交接文档 §7.6/§7.7）：同 step 重试时宿主只 refreshContext，
// 已接受的 section 不会重算 → 常驻规则无法在 normal 时可靠撤销。
// 现在注册的是 `systemPrompt.context('dsh-usage-dock.quota')`，
// 且**开关关闭时也保持注册**（text 返回空串），这样关闭能立即生效。
// ===========================================================================
{
  const systemPrompt = fakeSystemPrompt()
  const booted = boot(configWith({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaWarningPercentThreshold: 40,
    quotaClosingPercentThreshold: 20,
  }), { systemPrompt })
  await new Promise((r) => setTimeout(r, 50))
  check('E8a 注册了额度 context（不是 section）',
    systemPrompt.contexts.has('dsh-usage-dock.quota') && systemPrompt.sections.size === 0,
    { contexts: Array.from(systemPrompt.contexts.keys()), sections: Array.from(systemPrompt.sections.keys()) })

  const ctxEntry = systemPrompt.contexts.get('dsh-usage-dock.quota')
  check('E8b context 用 interpolate:false', ctxEntry !== undefined && ctxEntry.interpolate === false, ctxEntry)

  // 没有任何采集、也没有路由观察时：不应产出内容（normal、零规则）。
  let text = ''
  try { text = ctxEntry.text({ agent: null }) } catch (err) { text = 'THREW: ' + err.message }
  check('E8c 无观察时 text 为空串', text === '', text)

  booted.disposeAll()
  check('E8d 卸载清理 context',
    systemPrompt.disposals.count >= 1 && systemPrompt.contexts.size === 0,
    { disposals: systemPrompt.disposals, size: systemPrompt.contexts.size })
}

{
  // 未启用策略时：context 仍注册，但 text 为空（正常阶段零规则）。
  const systemPrompt = fakeSystemPrompt()
  const booted = boot(configWith({ deepseekEnabled: true }), { systemPrompt })
  await new Promise((r) => setTimeout(r, 50))
  const ctxEntry = systemPrompt.contexts.get('dsh-usage-dock.quota')
  const text = ctxEntry !== undefined ? ctxEntry.text({ agent: null }) : 'NO-CONTEXT'
  check('E8e 未启用策略时不投放任何内容', text === '', { text, has: ctxEntry !== undefined })
  booted.disposeAll()
}

{
  // 缺 systemPrompt 服务：不崩、路由仍在
  const routes = {}
  let threw = null
  try {
    apply({
      get: (name) => (name === 'tools' ? fakeTools() : undefined),
      webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
      effect: (fn) => fn(),
    }, configWith({
      quotaPolicyEnabled: true,
      quotaFocusChannels: '["deepseek"]',
      quotaWarningBalanceThreshold: 10,
      quotaBalanceCurrency: 'CNY',
    }))
  } catch (err) { threw = err }
  check('E8f 缺 systemPrompt 服务时 apply 不抛错', threw === null, threw && threw.message)
  check('E8g 路由仍注册', typeof routes['/api/plan-usage'] === 'function')
}

// ===========================================================================
// E9 — 策略字段进入真实 Config，且默认关闭
// ===========================================================================
{
  const keys = Object.keys(Config.dict || {}).filter((k) => k.startsWith('quota'))
  // [2026-10-23 有意变更] 13 → 14：新增 `quotaChannelThresholds`（按渠道/按窗口两档阈值，
  // 单一 JSON 字段；旧全局三组字段全部保留并继续作为 legacy 回退）。
  check('E9a 策略字段已进入真实 Config（两档 + 按渠道阈值 + 绑定 + 闸门）', keys.length === 14, keys)
  check('E9b 含两档预警/收尾与积分字段',
    ['quotaWarningPercentThreshold', 'quotaClosingPercentThreshold',
      'quotaWarningBalanceThreshold', 'quotaClosingBalanceThreshold',
      'quotaWarningCreditsThreshold', 'quotaClosingCreditsThreshold',
      'quotaChannelThresholds',
      'quotaRouteBindings', 'quotaTrustRouteOrder'].every((k) => keys.indexOf(k) !== -1),
    keys.sort())
}

// ===========================================================================
// E10 — Web 路由不受工具影响
// ===========================================================================
{
  const booted = boot(configWith({ deepseekEnabled: true }))
  let status = null
  let body = null
  await booted.routes['/api/plan-usage']({ method: 'GET', url: '/api/plan-usage' }, {
    writeHead(s) { status = s },
    end(text) { body = JSON.parse(text) },
  })
  check('E10a 返回 200', status === 200, status)
  check('E10b 仍是 ok + plans', body.ok === true && Array.isArray(body.data.plans))
  check('E10c 仍带配置证明', typeof body.data.cfg.digest === 'string')
  check('E10d 响应不含工具字段', body.data.channels === undefined)
  booted.disposeAll()
}

// ===========================================================================
// E11 — 宿主拒绝注册时不影响其余功能
// ===========================================================================
{
  const routes = {}
  let threw = null
  try {
    apply({
      get: (name) => (name === 'tools'
        ? { register() { throw new TypeError('tool "usage_status" must declare output') } }
        : undefined),
      webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
      effect: (fn) => fn(),
    }, configWith({ deepseekEnabled: true }))
  } catch (err) { threw = err }
  check('E11a apply 不抛错', threw === null, threw && threw.message)
  check('E11b 路由完整', typeof routes['/api/plan-usage'] === 'function'
    && typeof routes['/api/plan-usage/custom-status'] === 'function')
}

// ===========================================================================
// E12 — 未知 id 仍是参数错误
// ===========================================================================
{
  const booted = boot(configWith({ deepseekEnabled: true }))
  const def = booted.tools.registered.get(TOOL_NAME)
  let threw = null
  try { await def.execute({ ids: ['deepsek'] }) } catch (err) { threw = err }
  check('E12a 拼错 id 抛错', threw !== null && threw.message.includes('未知渠道'), threw && threw.message)
  booted.disposeAll()
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
