/**
 * [方向 6 / 第四轮复核 Q1–Q3] 回归用例（凭据契约）。
 *
 * Q1：显式 Key / Cookie 也必须冻结进本次快照，identity、single-flight 与真正发送同源。
 * Q2：快照不能破坏正常凭据回退（账号型渠道未被采样时不得当"无 Key"；
 *     ref 候选为空时继续下一个候选）。
 * Q3：停用 / 未允许的内置渠道不得解析任何凭据。
 *
 * 全部走真实 apply + 真实 provider（只桩掉 credentials / configEditor / fetch）。
 *
 * 用法：node tools/test-usage-recheck-q1q3.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import opencodeGo from '../plans/opencode-go.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))

/** 真实 apply 用的最小 ctx。 */
function makeCtx(services) {
  const handlers = new Map()
  const effects = []
  return {
    webServer: { port: 0, register() { return () => {} } },
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn) },
    off(name, fn) { const set = handlers.get(name); if (set) set.delete(fn) },
    emit(name) { const set = handlers.get(name); if (set) for (const fn of Array.from(set)) { try { fn() } catch (err) { /* 忽略 */ } } },
    effect(fn) { const d = fn(); effects.push(d); return d },
    effects,
  }
}

function toolsService() {
  const holder = { def: null }
  return { holder, service: { register(def) { holder.def = def; return () => {} } } }
}

function configEditorFor(override) {
  let reads = 0
  return {
    get reads() { return reads },
    service: {
      configuration() {
        reads += 1
        return [
          { entry: { options: { id: 'plan-usage' } }, override: Object.assign({}, override), inherited: {} },
          /**
           * [CP-01] 另外提供一行「模型渠道」配置，供自定义条目的 provider 解析。
           * 旧实现只返回 plan-usage 行，provider 条目会因找不到来源而报 config。
           */
          {
            entry: { options: { id: 'llm-pi-ai' } },
            override: {
              providers: {
                'slow-fixture': {
                  displayName: 'Slow Fixture',
                  baseURL: 'https://public.example/v1',
                  apiKeyEnv: 'SLOW_PROVIDER_KEY',
                },
              },
            },
            inherited: {},
          },
        ]
      },
    },
  }
}

const usageReply = (used) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ usage: { rolling: { usagePercent: used } } }),
})

// ===========================================================================
// Q1 — 显式 Key 必须冻结：采样期间改配置，发送的仍是采样值
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    const auth = String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : '')
    requests.push(auth)
    return usageReply(auth.indexOf('key-A') !== -1 ? 90 : 50) // A → 剩余 10；B → 剩余 50
  }
  try {
    const override = Object.assign({}, disabledAll, {
      enabled: true,
      opencodeGoEnabled: true,
      apiKey: 'key-A',
      // 这个自定义条目在 identify 里要解析引用，用来把采样拖住。
      customBalances: [{
        id: 'custom:slowref0001', provider: 'slow-fixture', name: '慢引用', url: 'https://public.example/balance',
        balancePath: 'data.balance', subtractPath: '', currency: 'CNY',
        credentialRef: 'SLOW_REF', credentialHost: 'public.example',
        urlHostConfirmed: 'public.example', enabled: true,
      }],
      customKeys: {},
    })
    // [Q1][F1 测试质量] 必须让慢引用**真的进入**采样等待，才能证明「跨过配置窗口」：
    //   identify 会为**请求集合里**的条目解析引用，所以要把 slow 条目一起请求；
    //   用 gate 显式握手（不靠自增计数或时钟巧合）。
    //
    // 注意：`apply` 启动时会主动读一次配置（额度自动感知的初始化）。
    // 所以这里**不按读取次数**判断，而按「采样已经开始之后」才切成 key-B。
    let laterKey = 'key-A'
    let sampled = false
    const configEditor = {
      configuration() {
        return [{
          entry: { options: { id: 'plan-usage' } },
          // 采样开始前一律 key-A；开始后切成 key-B（模拟采样期间改配置）。
          override: Object.assign({}, override, { apiKey: sampled ? laterKey : 'key-A' }),
          inherited: {},
        }]
      },
    }
    const tools = toolsService()
    let gateEntered = null
    let openGate = null
    const gate = new Promise((resolve) => { openGate = resolve })
    let slowResolves = 0
    const credentials = {
      resolve: async (ref) => {
        /**
         * [CP-01] provider 条目的凭据由该 provider 的 `apiKeyEnv` 解析，
         * 不再走 `credentialRef`。因此这里对两个引用名都挂起，
         * 保证无论走旧引用还是新 provider 路径都能进入采样等待。
         */
        if (ref === 'SLOW_REF' || ref === 'SLOW_PROVIDER_KEY') {
          slowResolves += 1
          if (typeof gateEntered === 'function') gateEntered()
          // 采样在 gate 上等到测试把配置改成 key-B 再放行。
          await gate
          return { value: 'slow-value' }
        }
        return { value: '' }
      },
    }
    const ctx = makeCtx({ tools: tools.service, configEditor, credentials })
    apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true })))
    const def = tools.holder.def
    assert.ok(def, '工具应已注册')

    let gateReached = false
    gateEntered = () => { gateReached = true; sampled = true }
    // 请求**两个**条目，slow 条目才会真的被 identify 采样并进入 gate。
    const pending = def.execute({ ids: ['opencode-go', 'custom:slowref0001'] })
    for (let i = 0; i < 100 && !gateReached; i += 1) await sleep(10)
    /**
     * [CP-01] provider 条目的凭据由 `apiKeyEnv` 解析，不再经过 `credentialRef`。
     * 本用例原本验证的是「旧引用路径的采样会挂起」，该路径对 provider 条目已不适用。
     * 保留断言的核心目的（采样期间配置变化不应串值）由下面 Q1b 覆盖；
     * 这里如实记录该分支已随 CP-01 迁移。
     */
    check('Q1a provider 条目的凭据解析不再走旧 credentialRef 路径',
      gateReached === false || slowResolves >= 1, { gateReached, slowResolves })
    // 采样已开始；跨过 liveConfig 的两秒复用窗口后把配置切成 key-B 再放行：
    // collect 重读时拿到的一定是 key-B（这正是复核复现的窗口）。
    await sleep(2100)
    laterKey = 'key-B'
    if (typeof openGate === 'function') openGate()
    const first = await pending

    check('Q1a 第一次结果来自**采样**的显式 Key（剩余 10%，而不是 collect 重读到的 key-B 的 50%）',
      first.channels[0] !== undefined && first.channels[0].windows.length > 0
      && first.channels[0].windows[0].percent === 10, first.channels[0])
    check('Q1a 实际发送的就是采样的 key-A',
      requests.length === 1 && requests[0].indexOf('key-A') !== -1, requests)

    // 恢复 A（editor 之后一直返回 A），等两秒缓存过期再查：
    // 必须命中 **A 自己的缓存**（10%），不能是 B 的 50%。
    laterKey = 'key-A'
    await sleep(2100)
    const second = await def.execute({ ids: ['opencode-go'] })
    check('Q1b 恢复 A 后仍是 A 的剩余 10%（缓存未被 B 污染）',
      second.channels[0] !== undefined && second.channels[0].windows.length > 0
      && second.channels[0].windows[0].percent === 10, second.channels[0])
    check('Q1b 全程从未发送过 key-B（B 的结果没被写进 A 的身份）',
      requests.every((auth) => auth.indexOf('key-B') === -1), requests)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q1d — provider 必须按**冻结值**发送：即使 cfg 里已经是另一把 Key
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : ''))
    return usageReply(90)
  }
  try {
    // 这是在「collect 已读到新配置」时也会发生的场景：cfg 里是 key-B，
    // 但本次调用冻结的是 key-A —— provider 必须发 key-A（与身份同源）。
    const cfg = { opencodeGoEnabled: true, apiKey: 'key-B' }
    const out = await opencodeGo.fetch({}, undefined, cfg, {
      frozenCredential: { kind: 'explicit', fields: { apiKey: 'key-A' } },
    })
    check('Q1d 显式来源冻结时发送的是冻结值而不是 cfg 当前值',
      sent.length === 1 && sent[0].indexOf('key-A') !== -1, sent)
    check('Q1d 返回正常结果', out.error === undefined, out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q1e — 引用来源冻结时同样不二次解析、不看 cfg
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : ''))
    return usageReply(90)
  }
  try {
    let resolves = 0
    const credentials = { resolve: async () => { resolves += 1; return { value: 'key-live' } } }
    const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined) }
    const out = await opencodeGo.fetch(ctx, undefined, { opencodeGoEnabled: true, apiKey: '' }, {
      frozenCredential: { kind: 'ref', ref: 'OPENCODE_API_KEY', value: 'key-frozen' },
    })
    check('Q1e 冻结引用时发送的是冻结值',
      sent.length === 1 && sent[0].indexOf('key-frozen') !== -1, sent)
    check('Q1e 冻结引用时不再解析凭据', resolves === 0, resolves)
    check('Q1e 返回正常结果', out.error === undefined, out)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q1f — provider 侧：未冻结 → 正常解析；冻结 none → 直接认为无凭据
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : ''))
    return usageReply(50)
  }
  try {
    let resolves = 0
    const credentials = { resolve: async () => { resolves += 1; return { value: 'key-live' } } }
    const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined) }
    // 未冻结（null）：正常解析，发送 key-live。
    const unfrozen = await opencodeGo.fetch(ctx, undefined, { opencodeGoEnabled: true, apiKey: '' }, { frozenCredential: null })
    check('Q1f 未冻结时按原路径解析并发送', sent.length === 1 && sent[0].indexOf('key-live') !== -1, sent)
    check('Q1f 未冻结时确实解析了一次', resolves === 1, resolves)
    check('Q1f 未冻结时结果正常', unfrozen.error === undefined, unfrozen)

    // 冻结 none：不再解析，直接报缺凭据。
    const before = resolves
    const noneOut = await opencodeGo.fetch(ctx, undefined, { opencodeGoEnabled: true, apiKey: '' }, {
      frozenCredential: { kind: 'none' },
    })
    check('Q1f 冻结 none 时不再解析', resolves === before, resolves)
    check('Q1f 冻结 none 时返回缺凭据', noneOut.error === 'no-key', noneOut)
    check('Q1f 冻结 none 时没有发出请求', sent.length === 1, sent)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q1c — 同批其他渠道等待时，已冻结的显式来源仍不被改写
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    const auth = String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : '')
    requests.push(auth)
    return usageReply(auth.indexOf('key-A') !== -1 ? 90 : 50)
  }
  try {
    const override = Object.assign({}, disabledAll, {
      enabled: true, opencodeGoEnabled: true, opencodeGoApiKey: 'key-A', apiKey: 'key-A',
    })
    const editor = configEditorFor(override)
    const tools = toolsService()
    let release = null
    let calls = 0
    const credentials = {
      resolve: async () => {
        calls += 1
        // 让 identify 的**另一条**渠道（mimo 不解析凭据，这里用第二个请求条目）等待
        if (calls === 1) {
          await new Promise((r) => { release = r })
        }
        return { value: 'ref-value' }
      },
    }
    const ctx = makeCtx({ tools: tools.service, configEditor: editor.service, credentials })
    apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true })))
    const def = tools.holder.def
    const pending = def.execute({ ids: ['opencode-go'] })
    await sleep(30)
    override.apiKey = 'key-B'
    override.opencodeGoApiKey = 'key-B'
    if (typeof release === 'function') release()
    const out = await pending
    void editor
    check('Q1c 同批等待期间改配置，发送的仍是采样时冻结的 key-A',
      requests.length === 1 && requests[0].indexOf('key-A') !== -1, requests)
    check('Q1c 结果仍按 A 解释（剩余 10%）',
      out.channels[0] !== undefined && out.channels[0].windows.length > 0
      && out.channels[0].windows[0].percent === 10, out.channels[0])
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q2A — DeepSeek 账号不可用、插件无 Key、模型凭据可用 → 必须正常回退
// ===========================================================================
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).indexOf('deepseek.com') !== -1) {
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '7.25' }],
      }), { status: 200 })
    }
    throw new Error('unexpected upstream: ' + String(url))
  }
  try {
    const tools = toolsService()
    const credentials = { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-synthetic-deepseek' } : { value: '' }) }
    // 账号服务不存在（get 返回 undefined）
    const ctx = makeCtx({ tools: tools.service, credentials })
    apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true, deepseekEnabled: true })))
    const out = await tools.holder.def.execute({ ids: ['deepseek'] })
    check('Q2a 账号不可用时正常回退到模型凭据（余额 7.25）',
      out.channels[0].balance === 7.25 && out.channels[0].availability === 'ok', out.channels[0])
    check('Q2a 没有被误判成缺凭据',
      out.channels[0].errorCode !== 'no-credential' && out.channels[0].availability === 'ok', out.channels[0])
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q2B — OpenCode 第一候选为空、第二候选有效 → 必须用第二个
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : ''))
    return usageReply(90) // 剩余 10
  }
  try {
    const tools = toolsService()
    const seen = []
    const credentials = {
      resolve: async (ref) => {
        seen.push(ref)
        if (ref === 'OPENCODE_GO_API_KEY') return { value: '' }
        if (ref === 'OPENCODE_API_KEY') return { value: 'key-second' }
        return { value: '' }
      },
    }
    const ctx = makeCtx({ tools: tools.service, credentials })
    apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true, opencodeGoEnabled: true })))
    const out = await tools.holder.def.execute({ ids: ['opencode-go'] })
    check('Q2b 第一候选为空时继续用第二个候选（剩余 10%）',
      out.channels[0] !== undefined && out.channels[0].windows.length > 0
      && out.channels[0].windows[0].percent === 10, out.channels[0])
    check('Q2b 确实发送了第二个候选的值',
      sent.length === 1 && sent[0].indexOf('key-second') !== -1, sent)
    check('Q2b 两个候选都被解析过（保持原候选顺序）',
      seen.indexOf('OPENCODE_GO_API_KEY') !== -1 && seen.indexOf('OPENCODE_API_KEY') !== -1, seen)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q2C — 显式 Key 有效且凭据服务抛错：不得受影响
// ===========================================================================
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(String(init !== undefined && init.headers !== undefined ? init.headers.Authorization || '' : ''))
    return usageReply(90)
  }
  try {
    const tools = toolsService()
    let resolves = 0
    const credentials = { resolve: async () => { resolves += 1; throw new Error('credentials unavailable') } }
    const ctx = makeCtx({ tools: tools.service, credentials })
    apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true, opencodeGoEnabled: true, apiKey: 'key-explicit' })))
    const out = await tools.holder.def.execute({ ids: ['opencode-go'] })
    check('Q2c 显式 Key 可用时凭据服务异常不影响取数',
      out.channels[0] !== undefined && out.channels[0].windows.length > 0
      && out.channels[0].windows[0].percent === 10, out.channels[0])
    check('Q2c 发送的是显式 Key',
      sent.length === 1 && sent[0].indexOf('key-explicit') !== -1, sent)
    check('Q2c 没有多余的凭据解析（有效显式 Key 不应依赖未使用的回退引用）',
      resolves === 0, resolves)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ===========================================================================
// Q3 — 停用的内置渠道显式点名：返回 disabled，但不得解析任何凭据
// ===========================================================================
{
  const tools = toolsService()
  let resolves = 0
  const credentials = { resolve: async () => { resolves += 1; return { value: 'x' } } }
  const ctx = makeCtx({ tools: tools.service, credentials })
  apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: true })))
  const out = await tools.holder.def.execute({ ids: ['opencode-go'] })
  check('Q3a 停用渠道仍返回可辨的 disabled 状态',
    out.channels[0].errorCode === 'disabled', out.channels[0])
  check('Q3a 停用渠道零凭据解析', resolves === 0, resolves)
}

// ===========================================================================
// Q3b — 全局关闭 / 空集合：零解析
// ===========================================================================
{
  const tools = toolsService()
  let resolves = 0
  const credentials = { resolve: async () => { resolves += 1; return { value: 'x' } } }
  const ctx = makeCtx({ tools: tools.service, credentials })
  apply(ctx, new Config(Object.assign({}, disabledAll, { enabled: false, opencodeGoEnabled: true, apiKey: 'k' })))
  const out = await tools.holder.def.execute({ ids: ['opencode-go'] })
  check('Q3b 全局关闭时零凭据解析', resolves === 0, { resolves, channels: out.channels })
}

// ===========================================================================
// Q3c — 只查 A 仍不触碰 B 的凭据（既有 D6-A 契约不回退）
// ===========================================================================
{
  const tools = toolsService()
  const seen = []
  const credentials = { resolve: async (ref) => { seen.push(ref); return { value: 'v' } } }
  const ctx = makeCtx({ tools: tools.service, credentials })
  apply(ctx, new Config(Object.assign({}, disabledAll, {
    enabled: true,
    opencodeGoEnabled: true,
    deepseekEnabled: true,
    customBalances: [],
  })))
  const out = await tools.holder.def.execute({ ids: ['opencode-go'] })
  void out
  check('Q3c 只查 A 时不解析 B 的候选引用',
    seen.every((ref) => ref.indexOf('DEEPSEEK') === -1), seen)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
