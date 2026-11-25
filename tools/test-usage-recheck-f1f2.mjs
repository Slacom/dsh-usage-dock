/**
 * [方向 6 / 第五轮复核 F1] 回归用例：冻结协议的逐层传递与状态服从。
 *
 * F1：custom 的冻结快照必须经「identify → 注册层 → collector → provider」全程送达，
 *     且 provider 在选择已保存凭据**之前**就服从冻结状态。
 *
 * MiMo 的扫码 / 记住登录 / Cookie 通道已在 0.12.0 删除，原 F2 段（MiMo 冻结 Cookie 语义）
 * 随之整体移除；MiMo 现在只有 API Key 一条通道，见 test-mimo-api-key.mjs。
 *
 * 全部走真实 fetchCustomPlans，只桩掉凭据解析与传输。
 *
 * 用法：node tools/test-usage-recheck-f1f2.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import { fetchCustomPlans } from '../plans/custom-balance.js'
import { createUsageTool } from '../plans/usage-tool-register.js'
import { percentSemanticsOf } from '../plans/index.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PUBLIC_RESOLVER = async () => ['93.184.216.34']

function makeCtx(services) {
  const handlers = new Map()
  return {
    webServer: { port: 0, register() { return () => {} } },
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn) },
    off(name, fn) { const set = handlers.get(name); if (set) set.delete(fn) },
    emit(name) { const set = handlers.get(name); if (set) for (const fn of Array.from(set)) { try { fn() } catch (err) { /* 忽略 */ } } },
    effect(fn) { return fn() },
  }
}

function toolsService() {
  const holder = { def: null }
  return { holder, service: { register(def) { holder.def = def; return () => {} } } }
}

function fakeSystemPrompt() {
  const sections = new Map()
  return { sections, section(spec) { sections.set(spec.name, spec); return () => { sections.delete(spec.name) } } }
}

/** 一个「余额 = X」的虚拟 HTTPS 传输，记录实际发送的 Bearer。 */
function balanceTransport(records, byKey) {
  return async (url, init) => {
    const auth = String(init !== undefined && init.headers !== undefined ? init.headers.authorization || '' : '')
    records.push({ url: String(url), auth })
    const value = typeof byKey === 'function' ? byKey(auth) : byKey
    return { status: 200, text: async () => JSON.stringify({ data: { balance: value } }) }
  }
}

function customEntry(overrides) {
  return Object.assign({
    id: 'custom:aaaa11112222',
    name: '厂商 A',
    url: 'https://public.example/balance',
    balancePath: 'data.balance',
    subtractPath: '',
    currency: 'CNY',
    credentialRef: '',
    credentialHost: 'public.example',
    urlHostConfirmed: 'public.example',
    enabled: true,
  }, overrides)
}

// ===========================================================================
// F1.1 — 真实 apply：custom 引用 A → 取数时变 B → 恢复 A
// ===========================================================================
{
  const records = []
  let currentRef = 'ref-A'
  let identifyResolved = 0
  const credentials = {
    resolve: async () => {
      identifyResolved += 1
      return { value: currentRef }
    },
  }
  const ctx = makeCtx({
    tools: toolsService().service,
    systemPrompt: fakeSystemPrompt(),
    credentials,
    // 自定义渠道直接注入传输层与解析器（不触网）
    __customTransport: balanceTransport(records, (auth) => (auth.indexOf('ref-A') !== -1 ? 10 : 50)),
  })
  void ctx

  // 走真实 fetchCustomPlans（collector → provider 的同一入口）
  const cfg = {
    customBalances: [customEntry({ credentialRef: 'CUSTOM_REF' })],
    customKeys: {},
  }
  // 1) 先模拟 identify 冻结 ref-A（等价于 index 的 customSnapshot 输出）
  const frozenA = { 'custom:aaaa11112222': { kind: 'ref', value: 'ref-A' } }
  // 2) 取数时「当前引用」已换成 B
  currentRef = 'ref-B'
  const out = await fetchCustomPlans({}, undefined, cfg, { allowLegacy: true,
    onlyIds: new Set(['custom:aaaa11112222']),
    budgetMs: 1000,
    credentialSnapshot: frozenA,
    resolveHost: PUBLIC_RESOLVER,
    allowLegacy: true,
    transport: balanceTransport(records, (auth) => (auth.indexOf('ref-A') !== -1 ? 10 : 50)),
  })
  check('F1.1 冻结 ref 时发送的是冻结值 A（不是当前 B）',
    records.length === 1 && records[0].auth.indexOf('ref-A') !== -1, records.map((r) => r.auth))
  check('F1.1 返回 A 的余额 10', out[0].balance === 10, out[0])
  // 冻结表已给出实际来源 → provider 不应再解析任何引用。
  check('F1.1 冻结后不再解析引用', identifyResolved === 0, identifyResolved)
}

// ===========================================================================
// F1.2 — 纯显式条目：当前 customKeys=B，冻结 explicit A → 必须发 A
// ===========================================================================
{
  const records = []
  const out = await fetchCustomPlans({}, undefined, {
    customBalances: [customEntry({})],
    customKeys: { 'custom:aaaa11112222': 'key-B' },
  }, {
    onlyIds: new Set(['custom:aaaa11112222']),
    budgetMs: 1000,
    credentialSnapshot: { 'custom:aaaa11112222': { kind: 'explicit', value: 'key-A' } },
    resolveHost: PUBLIC_RESOLVER,
    allowLegacy: true,
    transport: balanceTransport(records, (auth) => (auth.indexOf('key-A') !== -1 ? 10 : 50)),
  })
  check('F1.2 纯显式条目服从冻结值（发送 A）',
    records.length === 1 && records[0].auth.indexOf('key-A') !== -1, records.map((r) => r.auth))
  check('F1.2 返回 A 的余额 10', out[0].balance === 10, out[0])
}

// ===========================================================================
// F1.3 — 冻结 none 而当前有 Key：零请求、缺凭据
// ===========================================================================
{
  const records = []
  const out = await fetchCustomPlans({}, undefined, {
    customBalances: [customEntry({})],
    customKeys: { 'custom:aaaa11112222': 'key-B' },
  }, {
    onlyIds: new Set(['custom:aaaa11112222']),
    budgetMs: 1000,
    credentialSnapshot: { 'custom:aaaa11112222': { kind: 'none' } },
    resolveHost: PUBLIC_RESOLVER,
    allowLegacy: true,
    transport: balanceTransport(records, 50),
  })
  check('F1.3 冻结 none 时零请求', records.length === 0, records)
  check('F1.3 冻结 none 时返回缺凭据', out[0].error === 'no-key', out[0])
}

// ===========================================================================
// F1.4 — 未采样（无快照）：仍走原路径，正常发送当前 Key
// ===========================================================================
{
  const records = []
  const out = await fetchCustomPlans({}, undefined, {
    customBalances: [customEntry({})],
    customKeys: { 'custom:aaaa11112222': 'key-B' },
  }, {
    onlyIds: new Set(['custom:aaaa11112222']),
    budgetMs: 1000,
    credentialSnapshot: null,
    resolveHost: PUBLIC_RESOLVER,
    allowLegacy: true,
    transport: balanceTransport(records, (auth) => (auth.indexOf('key-B') !== -1 ? 50 : 10)),
  })
  check('F1.4 未采样时按当前 Key 发送', records.length === 1 && records[0].auth.indexOf('key-B') !== -1,
    records.map((r) => r.auth))
  check('F1.4 未采样时结果正常', out[0].balance === 50, out[0])
}

// ===========================================================================
// F1.5 — 冻结值也必须过目标确认（不得用 pendingKey 或冻结绕过）
// ===========================================================================
{
  const records = []
  const out = await fetchCustomPlans({}, undefined, {
    customBalances: [customEntry({ credentialHost: 'other.example' })],
    customKeys: {},
  }, {
    onlyIds: new Set(['custom:aaaa11112222']),
    budgetMs: 1000,
    credentialSnapshot: { 'custom:aaaa11112222': { kind: 'explicit', value: 'key-A' } },
    resolveHost: PUBLIC_RESOLVER,
    allowLegacy: true,
    transport: balanceTransport(records, 10),
  })
  check('F1.5 目标未确认时零请求（冻结也不绕过）', records.length === 0, records)
  check('F1.5 返回 credential-unconfirmed', out[0].error === 'credential-unconfirmed', out[0])
}

// ===========================================================================
// F1.6 — 注册层必须把 custom 冻结表一起转发（复核指出的「中间层丢失」断点）
//
// 这里用**真实注册层**（createUsageTool）+ 真实 identify 产出结构 + 真实
// fetchCustomPlans 组合：deps.collectPlans 就是 index 里那段接线，唯一不同的是
// 它能注入离线解析器（index 走真实 DNS，离线环境无法解析公网域名）。
// 断言覆盖「注册层 → collector → provider」三层是否都拿到同一份冻结值。
// ===========================================================================
{
  const records = []
  let currentRef = 'ref-A'
  let resolves = 0
  let gate = null
  let receivedSnapshot = null
  const credentials = {
    resolve: async () => {
      resolves += 1
      const value = currentRef
      if (gate !== null) await gate
      return { value }
    },
  }
  const tool = createUsageTool({
    budgetMs: 3000,
    describe: async () => ({
      enabled: ['custom:aaaa11112222'], known: ['custom:aaaa11112222'],
      generation: 'gen-1', identity: '', cacheable: new Set(),
      policy: null, policySection: null, semanticsOf: percentSemanticsOf,
    }),
    // 与 index 的 identifyChannels 同构：分别产出内置与自定义两部分。
    identify: async () => {
      const resolved = await credentials.resolve('CUSTOM_REF')
      return {
        identity: 'custom:aaaa11112222|' + resolved.value,
        cacheable: new Set(['custom:aaaa11112222']),
        snapshot: {
          frozen: {},
          custom: { 'custom:aaaa11112222': { kind: 'ref', value: resolved.value } },
        },
      }
    },
    collectPlans: async (ids, info) => {
      receivedSnapshot = info.snapshot.credentials
      return fetchCustomPlans({}, undefined, {
        customBalances: [customEntry({ credentialRef: 'CUSTOM_REF' })],
        customKeys: {},
      }, {
        onlyIds: new Set(ids),
        budgetMs: 2000,
        credentialSnapshot: info.snapshot.credentials,
        resolveHost: PUBLIC_RESOLVER,
        allowLegacy: true,
        transport: balanceTransport(records, (auth) => (auth.indexOf('ref-A') !== -1 ? 10 : 50)),
      })
    },
  })

  let openGate = null
  gate = new Promise((resolve) => { openGate = resolve })
  const pending = tool.definition.execute({ ids: ['custom:aaaa11112222'] })
  await sleep(60)
  const resolvesAtGate = resolves
  currentRef = 'ref-B'
  if (typeof openGate === 'function') openGate()
  const out = await pending

  check('F1.6 identify 确实在采样时进入等待（gate 真的被进入）', resolvesAtGate === 1, resolvesAtGate)
  check('F1.6 注册层把 custom 冻结表转发给了 collector',
    receivedSnapshot !== null && receivedSnapshot !== undefined
    && receivedSnapshot['custom:aaaa11112222'] !== undefined
    && receivedSnapshot['custom:aaaa11112222'].kind === 'ref',
    receivedSnapshot)
  check('F1.6 冻结值是采样时的 ref-A（不是后来变成的 ref-B）',
    receivedSnapshot !== null && receivedSnapshot['custom:aaaa11112222'].value === 'ref-A',
    receivedSnapshot && receivedSnapshot['custom:aaaa11112222'])
  check('F1.6 provider 实际发送的也是 ref-A',
    records.length === 1 && records[0].auth.indexOf('ref-A') !== -1, records.map((r) => r.auth))
  check('F1.6 结果是 A 的余额 10', out.channels[0].balance === 10, out.channels[0])
  check('F1.6 provider 没有再解析一次引用', resolves === 1, resolves)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
