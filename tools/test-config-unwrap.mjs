/**
 * [R7] 真实 Config → apply → provider 的端到端测试。
 *
 * 审查发现：0.9.0 只在读开关时解包 volatile，传给 plan.fetch 的仍是解析后的 Config。
 * 无 `configEditor` 的部署（DSHA / 移动端）里 `deepseekApiKey` 是 `{get()}` 包装对象，
 * `resolveApiKey` 的 `typeof === 'string'` 判断失败 → 用户明明填了 Key 却报 no-key。
 *
 * 这个文件用**真实的** schemastery `Config` 解析，再走真实 `apply()` 路由，
 * 断言 provider 真的拿到了字符串 Key 并发起了请求——不是"断言包装存在"那种弱证明。
 *
 * 用法：node tools/test-config-unwrap.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { unpackConfig, unwrapVolatile } from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

/** 与真实宿主一致：只注册 webServer，没有任何可选服务。 */
function routesFor(config) {
  const routes = {}
  apply({
    get: () => undefined, // 无 configEditor / credentials / deepseekAccount / shell
    webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    effect: (fn) => fn(),
  }, config)
  return routes
}

async function request(handler, method = 'GET') {
  let status, body
  await handler({ method }, { writeHead(s) { status = s }, end(text) { body = JSON.parse(text) } })
  return { status, body }
}

const allDisabled = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))

// ---------------------------------------------------------------------------
// U1 — unpackConfig 自身行为
// ---------------------------------------------------------------------------
{
  const parsed = Config({
    enabled: true,
    deepseekEnabled: true,
    deepseekApiKey: 'sk-synthetic-deepseek',
    deepseekWarnThreshold: 25,
    mimoCookie: 'userId=1; serviceToken=abc',
    customBalances: [{ id: 'custom:aaaaaaaaaaaa', name: 'A', url: 'https://a.example/b', balancePath: 'data.balance', enabled: true }],
    customKeys: { 'custom:aaaaaaaaaaaa': 'sk-custom' },
    // 旧配置字段（退场渠道）必须保留
    glmEnabled: false,
    kimiCodeEnabled: false,
    glmApiKey: 'legacy-glm-key',
  })

  // 先证明「原始解析结果确实是包装对象」——这是缺口存在的前提。
  check('U1a 原始 Config 的 Key 是 volatile 包装（缺陷前提成立）',
    typeof parsed.deepseekApiKey === 'object' && typeof parsed.deepseekApiKey.get === 'function',
    typeof parsed.deepseekApiKey)

  const plain = unpackConfig(parsed)
  check('U1b 解包后 Key 是字符串', typeof plain.deepseekApiKey === 'string' && plain.deepseekApiKey === 'sk-synthetic-deepseek', plain.deepseekApiKey)
  check('U1c 解包后 Cookie 是字符串', typeof plain.mimoCookie === 'string' && plain.mimoCookie.includes('serviceToken'), plain.mimoCookie)
  check('U1d 解包后阈值是数字', typeof plain.deepseekWarnThreshold === 'number' && plain.deepseekWarnThreshold === 25, plain.deepseekWarnThreshold)
  check('U1e 解包后自定义数组是普通数组', Array.isArray(plain.customBalances) && plain.customBalances[0].id === 'custom:aaaaaaaaaaaa', plain.customBalances)
  check('U1f 解包后 customKeys 是普通对象且值是字符串',
    plain.customKeys['custom:aaaaaaaaaaaa'] === 'sk-custom', plain.customKeys)
  check('U1g 旧配置字段保留（不删除退场渠道的凭据）',
    plain.glmEnabled === false && plain.glmApiKey === 'legacy-glm-key', { glmEnabled: plain.glmEnabled, glmApiKey: plain.glmApiKey })
  check('U1h 解包是幂等的（再解一次不变）',
    JSON.stringify(unpackConfig(plain)) === JSON.stringify(plain))
  check('U1i unwrapVolatile 对普通值原样返回', unwrapVolatile('x') === 'x' && unwrapVolatile(3) === 3)
  check('U1j unwrapVolatile 对包装对象取值', unwrapVolatile({ get: () => 'v' }) === 'v')
  check('U1k unwrapVolatile 不把普通单键对象误当包装',
    JSON.stringify(unwrapVolatile({ get: 1 })) === JSON.stringify({ get: 1 }))
}

// ---------------------------------------------------------------------------
// U2 — 真实 Config → apply → DeepSeek provider 真的用上了用户填的 Key
// ---------------------------------------------------------------------------
{
  const parsed = Config(Object.assign({}, allDisabled, {
    deepseekEnabled: true,
    deepseekApiKey: 'sk-synthetic-deepseek',
  }))

  const realFetch = globalThis.fetch
  const urls = []
  const auths = []
  globalThis.fetch = async (url, init) => {
    urls.push(String(url))
    // util.js 用的头名是 `Authorization`（大写 A），这里按不区分大小写取值。
    let auth
    if (init && init.headers) {
      for (const key of Object.keys(init.headers)) {
        if (key.toLowerCase() === 'authorization') auth = init.headers[key]
      }
    }
    auths.push(auth)
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '11.38' }],
    }), { status: 200 })
  }
  try {
    const routes = routesFor(parsed)
    const res = await request(routes['/api/plan-usage'])
    check('U2a 真实 Config 下 DeepSeek 取数真的发生了（不再 no-key）',
      urls.length === 1 && res.body.ok === true, { urls, body: res.body })
    check('U2b Authorization 用的是用户填的那把 Key',
      auths[0] === 'Bearer sk-synthetic-deepseek', auths)
    check('U2c 返回的是真实余额而不是 no-key',
      res.body.data.plans[0].balance === 11.38 && res.body.data.plans[0].error === undefined,
      res.body.data && res.body.data.plans[0])
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
// U3 — 阈值同样要解包（否则会被当成非数字回退默认值）
// ---------------------------------------------------------------------------
{
  const parsed = Config(Object.assign({}, allDisabled, {
    deepseekEnabled: true,
    deepseekApiKey: 'sk-synthetic-deepseek',
    deepseekWarnThreshold: 42,
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100' }],
  }), { status: 200 })
  try {
    const res = await request(routesFor(parsed)['/api/plan-usage'])
    check('U3a 真实 Config 的自定义阈值被正确读出（42 而不是默认 10）',
      res.body.data.plans[0].warnThreshold === 42, res.body.data.plans[0].warnThreshold)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
// U4 — 渠道开关也要解包（0.9.0 之前无 configEditor 时恒为「开」）
// ---------------------------------------------------------------------------
{
  const parsed = Config(Object.assign({}, allDisabled, {
    deepseekEnabled: false,
    codexEnabled: false,
  }))
  const res = await request(routesFor(parsed)['/api/plan-usage'])
  check('U4a 真实 Config 下全部停用 → disabled（开关真的生效）',
    res.body.ok === false && res.body.error === 'disabled', res.body)
}

// ---------------------------------------------------------------------------
// U5 — 全局开关同样解包
// ---------------------------------------------------------------------------
{
  const parsed = Config({ enabled: false, deepseekEnabled: true, deepseekApiKey: 'sk-x' })
  const res = await request(routesFor(parsed)['/api/plan-usage'])
  check('U5a 真实 Config 下 enabled:false 生效', res.body.ok === false && res.body.error === 'disabled', res.body)
}

// ---------------------------------------------------------------------------
// U6 — 自定义条目在真实 Config 下也走得通（含 secret dict）
// ---------------------------------------------------------------------------
{
  const parsed = Config(Object.assign({}, allDisabled, {
    customBalances: [{
      id: 'custom:aaaaaaaaaaaa',
      name: '真实配置条目',
      url: 'https://api.example.invalid/balance',
      balancePath: 'data.balance',
      credentialHost: 'https://api.example.invalid',
      enabled: true,
    }],
    customKeys: { 'custom:aaaaaaaaaaaa': 'sk-real-config' },
  }))
  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called += 1; throw new TypeError('fetch failed (test)') }
  try {
    const res = await request(routesFor(parsed)['/api/plan-usage'])
    const plans = res.body.data ? res.body.data.plans : []
    check('U6a 真实 Config 下自定义条目被识别并返回', plans.length === 1 && plans[0].custom === true, plans)
    check('U6b 自定义条目带 Host 计算的 gen', typeof plans[0].gen === 'string' && /^[0-9a-f]{10}$/.test(plans[0].gen), plans[0].gen)
    check('U6c 自定义条目失败时返回结构化错误（路由不抛异常、不伪造余额）',
      res.body.ok === true
      && plans[0].error !== undefined
      && plans[0].balance === undefined
      && ['config', 'network', 'structure', 'endpoint', 'auth', 'server', 'rate-limit', 'no-key'].includes(plans[0].error),
      { ok: res.body.ok, plan: plans[0] })
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
// U7 — 秘密不外泄（真实 Config 全链路）
// ---------------------------------------------------------------------------
{
  const SENTINEL = 'sk-LEAK-CHECK-4f21'
  const parsed = Config(Object.assign({}, allDisabled, {
    deepseekEnabled: true,
    deepseekApiKey: SENTINEL,
    customKeys: { 'custom:aaaaaaaaaaaa': SENTINEL },
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }],
  }), { status: 200 })
  try {
    const routes = routesFor(parsed)
    const usage = await request(routes['/api/plan-usage'])
    const status = await request(routes['/api/plan-usage/custom-status'])
    check('U7a 用量响应不含真实 Config 里的 Key', !JSON.stringify(usage.body).includes(SENTINEL))
    check('U7b 状态响应不含真实 Config 里的 Key', !JSON.stringify(status.body).includes(SENTINEL))
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
