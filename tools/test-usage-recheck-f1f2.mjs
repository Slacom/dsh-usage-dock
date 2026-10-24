/**
 * [方向 6 / 第五轮复核 F1–F2] 回归用例：冻结协议的逐层传递与状态服从。
 *
 * F1：custom 的冻结快照必须经「identify → 注册层 → collector → provider」全程送达，
 *     且 provider 在选择已保存凭据**之前**就服从冻结状态。
 * F2：MiMo 必须服从冻结的 none（零请求），explicit 只读冻结字段，未采样才读 cfg。
 *
 * 全部走真实 apply + 真实 provider，只桩掉 credentials / configEditor / 传输。
 *
 * 用法：node tools/test-usage-recheck-f1f2.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { PLANS, percentSemanticsOf } from '../plans/index.js'
import { fetchCustomPlans } from '../plans/custom-balance.js'
import { createUsageTool } from '../plans/usage-tool-register.js'
import mimo from '../plans/mimo.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
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

// ===========================================================================
// F2.1 — MiMo 冻结 none：零请求、缺凭据（即使 cfg 里有 Cookie B）
// ===========================================================================
{
  const realFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(JSON.stringify({ code: 0, data: { balance: 17.55 } }), { status: 200 })
  }
  try {
    const out = await mimo.fetch({}, undefined, { mimoCookie: 'uid=1; serviceToken=B; userId=1B' }, {
      frozenCredential: { kind: 'none' },
    })
    check('F2.1 冻结 none 时零请求', requests === 0, requests)
    check('F2.1 冻结 none 时返回缺凭据', out.error === 'no-key', out)
    check('F2.1 冻结 none 时不返回余额', out.balance === undefined, out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// F2.2 — MiMo 冻结 explicit：只用冻结字段
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.cookie || '' : ''))
    return new Response(JSON.stringify({ code: 0, data: { balance: 5 } }), { status: 200 })
  }
  try {
    const out = await mimo.fetch({}, undefined, { mimoCookie: 'uid=1; serviceToken=B; userId=1B' }, {
      frozenCredential: { kind: 'explicit', fields: { mimoCookie: 'uid=1; serviceToken=A; userId=1A' } },
    })
    check('F2.2 冻结 explicit 时发送冻结 Cookie A', sent.length === 1 && sent[0].indexOf('serviceToken=A; userId=1A') !== -1, sent)
    check('F2.2 结果正常', out.error === undefined, out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// F2.3 — MiMo explicit 但缺该字段：安全拒绝，不回退 cfg
// ===========================================================================
{
  const realFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(JSON.stringify({ code: 0, data: { balance: 17.55 } }), { status: 200 })
  }
  try {
    const out = await mimo.fetch({}, undefined, { mimoCookie: 'uid=1; serviceToken=B; userId=1B' }, {
      frozenCredential: { kind: 'explicit', fields: {} },
    })
    check('F2.3 显式冻结缺字段时零请求', requests === 0, requests)
    check('F2.3 显式冻结缺字段时返回缺凭据', out.error === 'no-key', out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// F2.4 — MiMo 未采样（null）：仍读 cfg（正常路径不变）
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.cookie || '' : ''))
    return new Response(JSON.stringify({ code: 0, data: { balance: 5 } }), { status: 200 })
  }
  try {
    const out = await mimo.fetch({}, undefined, { mimoCookie: 'uid=1; serviceToken=B; userId=1B' }, { frozenCredential: null })
    check('F2.4 未采样时读 cfg 并发送', sent.length === 1 && sent[0].indexOf('serviceToken=B; userId=1B') !== -1, sent)
    check('F2.4 未采样时结果正常', out.error === undefined, out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// F2.5 — MiMo 收到不支持的冻结状态（ref）：安全拒绝
// ===========================================================================
{
  const realFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(JSON.stringify({ code: 0, data: { balance: 17.55 } }), { status: 200 })
  }
  try {
    const out = await mimo.fetch({}, undefined, { mimoCookie: 'uid=1; serviceToken=B; userId=1B' }, {
      frozenCredential: { kind: 'ref', value: 'cookie-A' },
    })
    check('F2.5 不支持的冻结状态零请求', requests === 0, requests)
    check('F2.5 不支持的冻结状态返回缺凭据', out.error === 'no-key', out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// F2.6 — 真实 apply：MiMo 冻结 none 后配置变成 Cookie B，不得把 B 的成功
//        写进「无凭据」身份（复核复现的缓存污染）
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.cookie || '' : ''))
    return new Response(JSON.stringify({ code: 0, data: { balance: 17.55 } }), { status: 200 })
  }
  try {
    const override = {}
    const configEditor = {
      configuration() {
        return [{ entry: { options: { id: 'plan-usage' } }, override: Object.assign({}, override), inherited: {} }]
      },
    }
    // 自定义条目负责把 identify 拖住：慢引用 2100ms，期间把 MiMo 的 Cookie 换成 B。
    const credentials = {
      resolve: async (ref) => {
        if (ref === 'SLOW_REF') {
          await sleep(2100)
          return { value: 'ref-value' }
        }
        return { value: '' }
      },
    }
    const tools = toolsService()
    const ctx = makeCtx({ tools: tools.service, systemPrompt: fakeSystemPrompt(), configEditor, credentials })
    apply(ctx, new Config(Object.assign({}, disabledAll, {
      enabled: true,
      mimoEnabled: true,
      customBalances: [customEntry({ id: 'custom:slowref0002', url: 'https://public.example/slow', credentialRef: 'SLOW_REF' })],
      customKeys: {},
    })))
    const def = tools.holder.def

    // 第一次：MiMo 没有 Cookie → identify 冻结 none；期间配置出现 Cookie B。
    const pending = def.execute({ ids: ['mimo', 'custom:slowref0002'] })
    await sleep(200)
    override.mimoCookie = 'uid=1; serviceToken=B; userId=1B'
    const first = await pending
    const mimoFirst = first.channels.find((c) => c.id === 'mimo')
    // 自定义条目会走真实 DNS 校验（public.example 解析桩不可用），这里不关心它的结果。
    check('F2.6 冻结 none 时 MiMo 返回缺凭据', mimoFirst !== undefined && mimoFirst.errorCode === 'no-credential', mimoFirst)
    check('F2.6 冻结 none 时 MiMo 零请求（不会用后来变成的 B）',
      sent.every((cookie) => cookie.indexOf('serviceToken=B') === -1), sent)

    // 清空 Cookie + 单次 reload 使配置缓存失效，再查同一 ids：
    // 「无凭据」身份里不得出现 B 的成功余额。
    delete override.mimoCookie
    ctx.emit('app-boot/config-reload')
    await sleep(60)
    const second = await def.execute({ ids: ['mimo'] })
    const mimoSecond = second.channels.find((c) => c.id === 'mimo')
    check('F2.6 清空 Cookie 后仍是无凭据（没有缓存的成功余额）',
      mimoSecond !== undefined && mimoSecond.errorCode === 'no-credential', mimoSecond)
    check('F2.6 全程没有任何 MiMo 请求',
      sent.every((cookie) => cookie.indexOf('serviceToken') === -1), sent)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
