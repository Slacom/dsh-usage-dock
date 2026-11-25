/**
 * MiMo API Key 余额通道（0.11.2）单元测试。
 *
 * 覆盖：
 *   - 请求形态：GET https://api.xiaomimimo.com/v1/platform/balance + `api-key` 头，不带 Cookie
 *   - 解析口径：balance = 现金 + 赠金（**不含**授信额度）；cash/gift/credit 明细
 *   - 币种、isAvailable、via='api-key'
 *   - 401/403（invalid_api_key）→ 鉴权失效文案；结构异常 → parse
 *   - fetchPlan 优先 API Key；无 Key 且无 Cookie → no-key（零请求）
 *   - [R1] provider 自动匹配 = 「名称含 mimo/xiaomi」+「可信 origin」双条件：
 *     第三方 relay / 缺失 / 坏 URL / 非 https / 显式端口 / userinfo / 相近域名一律跳过，
 *     **不解析其 apiKeyEnv、不发余额请求**；可信 `https://api.xiaomimimo.com` 才复用 Key；
 *     插件显式 `mimoApiKey` 与固定候选名优先级不变。（全部离线、只用合成 Key）
 *
 * 用法：node tools/test-mimo-api-key.mjs
 */
import assert from 'node:assert/strict'
import { fetchApiKeyBalance, fetchPlan, hasMimoApiKey, API_KEY_ENDPOINT } from '../plans/mimo.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

const calls = []
function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const hit = handler(calls.length)
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: { get: () => 'application/json', forEach: () => {} },
      text: async () => JSON.stringify(hit.body === undefined ? {} : hit.body),
      json: async () => hit.body,
    }
  }
}

const origin = globalThis.fetch
const BODY_OK = {
  object: 'balance',
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    cash_balance: '100.50',
    gift_balance: '20.00',
    frozen_balance: '0.00',
    credit_limit: '500.00',
    credit_available: '380.00',
    total_available: '500.50',
  }],
}

// 1) 成功：金额 = 现金 + 赠金（不含授信）
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-test-key', {}, {})
  check('成功：balance = 现金 100.5 + 赠金 20 = 120.5（不含授信 380）', wire.balance === 120.5, wire)
  check('成功：cashBalance / giftBalance / creditAvailable 明细', wire.cashBalance === 100.5 && wire.giftBalance === 20 && wire.creditAvailable === 380, wire)
  check('成功：币种 CNY、isAvailable=true、via=api-key',
    wire.currency === 'CNY' && wire.isAvailable === true && wire.via === 'api-key', wire)
  check('请求：GET 固定端点', calls.length === 1 && calls[0].url === API_KEY_ENDPOINT, calls)
  const headers = calls[0].init.headers || {}
  check('请求：带 api-key 头，且不带 Cookie',
    headers['api-key'] === 'sk-test-key' && headers.Cookie === undefined, headers)
}

// 2) 只有 total_available：回退到总额
stubFetch(() => ({ status: 200, body: { object: 'balance', is_available: true, balance_infos: [{ currency: 'CNY', total_available: '42.00' }] } }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-test-key', {}, {})
  check('只有 total_available 时回退用总额 42', wire.balance === 42, wire)
  check('缺 cash/gift 时明细为 null（不伪造成 0）', wire.cashBalance === null && wire.giftBalance === null, wire)
}

// 3) 401 → 鉴权失效（永久）
stubFetch(() => ({ status: 401, body: { error: { message: 'Invalid API key.', code: 'invalid_api_key' } } }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-bad', {}, {})
  check('401：标记错误且文案提示重新填写 Key',
    typeof wire.error === 'string' && wire.message.includes('重新填写'), wire)
}

// 4) 结构异常 → parse
stubFetch(() => ({ status: 200, body: { object: 'balance', is_available: true, balance_infos: [] } }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-test-key', {}, {})
  check('空 balance_infos → parse 错误', wire.error === 'parse', wire)
}

// 5) fetchPlan 优先 API Key
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const ctx = { get: () => undefined }
  const wire = await fetchPlan(ctx, null, { mimoApiKey: 'sk-cfg' }, {})
  check('fetchPlan：配了 API Key 就走 API Key 通道（via=api-key）', wire.via === 'api-key' && wire.balance === 120.5, wire)
  const headers = calls[0].init.headers || {}
  check('fetchPlan：请求头用配置里的 key', headers['api-key'] === 'sk-cfg', headers)
}

// 6) 无 Key → no-key，且零请求
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const ctx = { get: () => undefined }
  const wire = await fetchPlan(ctx, null, {}, {})
  check('fetchPlan：无任何 Key → no-key', wire.error === 'no-key', wire)
  check('fetchPlan：no-key 时零请求', calls.length === 0, calls)
}

// 7) 凭据库固定候选名：XIAOMI_API_KEY（桌面端「设置 → 模型」实际使用的名字）
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const ctx = {
    get: (name) => (name === 'credentials'
      ? { resolve: async (ref) => (ref === 'XIAOMI_API_KEY' ? { value: 'sk-from-credentials' } : undefined) }
      : undefined),
  }
  const wire = await fetchPlan(ctx, null, {}, {})
  check('fetchPlan：无插件 Key 时从凭据库 XIAOMI_API_KEY 取到 Key', wire.via === 'api-key' && wire.balance === 120.5, wire)
  const headers = calls[0].init.headers || {}
  check('fetchPlan：请求头使用凭据库里的 Key', headers['api-key'] === 'sk-from-credentials', headers)
}

// 8) hasMimoApiKey：有/无凭据分别返回 true / false
{
  const withKey = {
    get: (name) => (name === 'credentials'
      ? { resolve: async (ref) => (ref === 'XIAOMI_API_KEY' ? { value: 'sk-x' } : undefined) }
      : undefined),
  }
  const withoutKey = { get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined) }
  check('hasMimoApiKey：凭据库有 XIAOMI_API_KEY → true', (await hasMimoApiKey(withKey, {})) === true)
  check('hasMimoApiKey：什么都没有 → false', (await hasMimoApiKey(withoutKey, {})) === false)
}

// ===========================================================================
// [R1] provider 自动匹配 = 「名称含 mimo/xiaomi」+「可信 origin」双条件
//
// 全部离线：只替换 globalThis.fetch，credentials.resolve 由假实现记录调用；
// 用的都是**合成 Key**，不读取、不打印任何真实凭据。
// ===========================================================================

const PROVIDER_ENV = 'SYNTH_MIMO_MODELS_KEY'
/** 预置的固定候选名（`API_KEY_REFS`，插件未导出，这里按文档复述以断言「只探测固定名」）。 */
const FIXED_REFS = ['XIAOMI_API_KEY', 'MIMO_API_KEY', 'MIMO_APIKEY', 'XIAOMI_MIMO_API_KEY']
const SYNTH_PROVIDER_KEY = 'sk-synthetic-provider-key-0001'
const SYNTH_PLUGIN_KEY = 'sk-synthetic-plugin-key-0002'
const SYNTH_FIXED_KEY = 'sk-synthetic-fixed-ref-key-0003'

/**
 * 造一个只读 Host ctx：模型目录（`llm.listConfigurableProviders`）+ 配置行
 * （`configEditor.configuration`，形状与 `custom-balance.js#listProviderTargets` 实际读取一致）
 * + 记录每次 `resolve(ref)` 的凭据库。
 *
 * 注意 `fixed` 里**故意**可以让 provider 的 `apiKeyEnv` 解析成功：
 * 只有这样，「没被 resolve」才是代码主动跳过的证据，而不是凭据库恰好没配。
 */
function makeProviderCtx(providers, options) {
  const opts = options !== undefined && options !== null ? options : {}
  const fixed = opts.fixed !== undefined && opts.fixed !== null ? opts.fixed : {}
  const catalog = []
  const rows = []
  for (const item of providers) {
    const ns = 'llm-' + item.provider
    catalog.push({
      provider: item.provider,
      displayName: item.displayName !== undefined ? item.displayName : item.provider,
      settingsNs: ns,
      settingsPath: ['providers', item.provider],
      defaultBaseURL: '',
    })
    rows.push({
      entry: {
        options: {
          id: ns,
          config: { providers: { [item.provider]: { baseURL: item.baseURL, apiKeyEnv: item.apiKeyEnv } } },
        },
      },
    })
  }
  const resolved = []
  const credentials = {
    resolve: async (ref) => {
      resolved.push(ref)
      return Object.prototype.hasOwnProperty.call(fixed, ref) ? { value: fixed[ref] } : undefined
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return credentials
      return undefined
    },
  }
  return { ctx, resolved }
}

/** 用同一个 provider 目录跑一遍 hasMimoApiKey + fetchPlan，返回观察结果（请求、解析记录）。 */
async function probeProvider(providers, fixed) {
  stubFetch(() => ({ status: 200, body: BODY_OK }))
  const made = makeProviderCtx(providers, { fixed })
  const has = await hasMimoApiKey(made.ctx, {}, {})
  const wire = await fetchPlan(made.ctx, null, {}, {})
  return { has, wire, calls: calls.slice(), resolved: made.resolved.slice() }
}

// R1-1) 第三方 relay：id 名称命中，但 baseURL 指向别家 → 跳过（不解析 Key、零请求）
{
  const relay = {
    provider: 'mimo-relay',
    displayName: 'MiMo Relay (third party)',
    baseURL: 'https://mimo-relay.example.com/v1',
    apiKeyEnv: PROVIDER_ENV,
  }
  const r = await probeProvider([relay], { [PROVIDER_ENV]: SYNTH_PROVIDER_KEY })
  check('R1：第三方 relay（provider id 命中 mimo）hasMimoApiKey=false', r.has === false, r.has)
  check('R1：第三方 relay 的 apiKeyEnv 从未被 resolve', r.resolved.includes(PROVIDER_ENV) === false, r.resolved)
  check('R1：解析尝试仅限固定候选名（provider 来源 0 次）',
    r.resolved.every((ref) => FIXED_REFS.includes(ref)), r.resolved)
  check('R1：第三方 relay fetchPlan 返回 no-key', r.wire.error === 'no-key', r.wire)
  check('R1：第三方 relay 零余额请求', r.calls.length === 0, r.calls.length)
}

// R1-2) 只有 displayName 命中（id 中性）的第三方代理，同样跳过
{
  const proxy = {
    provider: 'relay-proxy',
    displayName: 'Mimo Proxy',
    baseURL: 'https://relay-proxy.example.com/v1',
    apiKeyEnv: PROVIDER_ENV,
  }
  const r = await probeProvider([proxy], { [PROVIDER_ENV]: SYNTH_PROVIDER_KEY })
  check('R1：仅 displayName 命中 mimo 的第三方代理 → hasMimoApiKey=false / 零请求 / 不解析 Key',
    r.has === false && r.calls.length === 0 && r.resolved.includes(PROVIDER_ENV) === false,
    { has: r.has, calls: r.calls.length, resolved: r.resolved })
}

// R1-3) 可信 https://api.xiaomimimo.com/v1 + 合成 Key → 有 Key，且只打固定余额端点
{
  const trust = {
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo',
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: PROVIDER_ENV,
  }
  const r = await probeProvider([trust], { [PROVIDER_ENV]: SYNTH_PROVIDER_KEY })
  check('R1：可信 baseURL api.xiaomimimo.com/v1 → hasMimoApiKey=true', r.has === true, r.has)
  check('R1：可信来源 fetchPlan 成功（via=api-key, balance=120.5）',
    r.wire.via === 'api-key' && r.wire.balance === 120.5, r.wire)
  check('R1：可信来源只请求固定余额端点', r.calls.length === 1 && r.calls[0].url === API_KEY_ENDPOINT, r.calls.map((c) => c.url))
  const headers = r.calls.length > 0 ? (r.calls[0].init.headers || {}) : {}
  check('R1：请求头 api-key = provider 合成 Key，且不带 Cookie',
    headers['api-key'] === SYNTH_PROVIDER_KEY && headers.Cookie === undefined, headers)
}

// R1-4) 规范化 origin：无路径、大写主机、结尾斜杠都仍算可信（路径不参与判断）
{
  for (const baseURL of ['https://api.xiaomimimo.com', 'https://API.XIAOMIMIMO.COM/v1/']) {
    const r = await probeProvider([
      { provider: 'xiaomi', displayName: 'Xiaomi MiMo', baseURL, apiKeyEnv: PROVIDER_ENV },
    ], { [PROVIDER_ENV]: SYNTH_PROVIDER_KEY })
    check('R1：规范化 origin 可信（' + baseURL + '）→ hasMimoApiKey=true',
      r.has === true && r.calls.length === 1 && r.calls[0].url === API_KEY_ENDPOINT,
      { has: r.has, calls: r.calls.length })
  }
}

// R1-5) fail closed：缺失 / 坏 URL / 非 https / 显式端口（含 :443）/ userinfo / 相近域名
{
  const untrusted = [
    ['baseURL 缺失', ''],
    ['baseURL 不是合法 URL', 'not a url'],
    ['http 协议', 'http://api.xiaomimimo.com/v1'],
    ['显式端口 8443', 'https://api.xiaomimimo.com:8443/v1'],
    ['显式默认端口 443', 'https://api.xiaomimimo.com:443/v1'],
    ['带 userinfo', 'https://user:pass@api.xiaomimimo.com/v1'],
    ['相近域名', 'https://api.xiaomimimo.com.evil.test/v1'],
  ]
  let clean = 0
  for (const [label, baseURL] of untrusted) {
    const r = await probeProvider([
      { provider: 'xiaomi', displayName: 'Xiaomi MiMo', baseURL, apiKeyEnv: PROVIDER_ENV },
    ], { [PROVIDER_ENV]: SYNTH_PROVIDER_KEY })
    const ok = r.has === false
      && r.calls.length === 0
      && r.wire.error === 'no-key'
      && r.resolved.includes(PROVIDER_ENV) === false
    if (ok) clean++
    check('R1 fail-closed：' + label + ' → 无 Key / 零请求 / 不解析 Key', ok,
      { baseURL, has: r.has, calls: r.calls.length, error: r.wire.error, resolved: r.resolved })
  }
  check('R1 fail-closed：' + untrusted.length + ' 类不可信地址全部跳过', clean === untrusted.length, clean)
}

// R1-6) 插件显式 mimoApiKey 仍优先于 provider 自动匹配（优先级不变）
{
  stubFetch(() => ({ status: 200, body: BODY_OK }))
  const made = makeProviderCtx([
    { provider: 'xiaomi', displayName: 'Xiaomi MiMo', baseURL: 'https://api.xiaomimimo.com/v1', apiKeyEnv: PROVIDER_ENV },
  ], { fixed: { [PROVIDER_ENV]: SYNTH_PROVIDER_KEY } })
  const wire = await fetchPlan(made.ctx, null, { mimoApiKey: SYNTH_PLUGIN_KEY }, {})
  const headers = calls[0] !== undefined ? (calls[0].init.headers || {}) : {}
  check('R1：插件显式 mimoApiKey 优先于 provider 自动匹配',
    wire.via === 'api-key' && headers['api-key'] === SYNTH_PLUGIN_KEY, { wire, headers })
  check('R1：插件显式 Key 命中时不再解析 provider 引用',
    made.resolved.includes(PROVIDER_ENV) === false, made.resolved)
}

// R1-7) 固定候选名（API_KEY_REFS）优先级不变：第三方 provider 存在也不影响
{
  stubFetch(() => ({ status: 200, body: BODY_OK }))
  const made = makeProviderCtx([
    { provider: 'mimo-relay', displayName: 'MiMo Relay', baseURL: 'https://mimo-relay.example.com/v1', apiKeyEnv: PROVIDER_ENV },
  ], { fixed: { XIAOMI_API_KEY: SYNTH_FIXED_KEY } })
  const wire = await fetchPlan(made.ctx, null, {}, {})
  const headers = calls[0] !== undefined ? (calls[0].init.headers || {}) : {}
  check('R1：固定候选名 XIAOMI_API_KEY 仍生效（不受第三方 provider 影响）',
    wire.via === 'api-key' && headers['api-key'] === SYNTH_FIXED_KEY, { wire, headers })
}

// R1-8) 跳过必须是 `continue`：第三方 relay 排在可信 provider 之前时，不能挡住后者
{
  const RELAY_ENV = 'SYNTH_RELAY_ENV_KEY'
  const r = await probeProvider([
    { provider: 'mimo-relay', displayName: 'MiMo Relay', baseURL: 'https://mimo-relay.example.com/v1', apiKeyEnv: RELAY_ENV },
    { provider: 'xiaomi', displayName: 'Xiaomi MiMo', baseURL: 'https://api.xiaomimimo.com/v1', apiKeyEnv: PROVIDER_ENV },
  ], { [RELAY_ENV]: 'sk-synthetic-relay-key-0004', [PROVIDER_ENV]: SYNTH_PROVIDER_KEY })
  const headers = r.calls.length > 0 ? (r.calls[0].init.headers || {}) : {}
  check('R1：不可信 relay 不挡住后面的可信 provider（continue 而非 return）',
    r.has === true && headers['api-key'] === SYNTH_PROVIDER_KEY, { has: r.has, headers })
  check('R1：被跳过 relay 的 apiKeyEnv 仍未被 resolve', r.resolved.includes(RELAY_ENV) === false, r.resolved)
}

globalThis.fetch = origin
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)

