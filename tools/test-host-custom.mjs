/**
 * 0.9.0 Host 端到端测试：真实 apply() 路由 + 真实 Config + 自定义渠道编排。
 *
 * 覆盖（全部离线，用本地 HTTP 服务 + 注入 transport）：
 *   - 退场渠道即使旧配置全启用：不取数、不返回、不占响应；
 *   - 自定义条目参与编排，与内置渠道并行返回；
 *   - 内置渠道全部停用、只剩自定义条目时仍返回数据（不是 disabled）；
 *   - 停用自定义条目不请求、启用的才请求；
 *   - /api/plan-usage 的响应里**没有 Key**（秘密哨兵不泄漏）；
 *   - /api/plan-usage/custom-status 只回布尔摘要；
 *   - 单条自定义失败不影响内置渠道与其他自定义条目；
 *   - 旧配置字段（glmEnabled 等）保留但不产生渠道。
 *
 * 用法：node tools/test-host-custom.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, Config } from '../index.js'
import { PLANS, RETIRED_PLAN_IDS, isRetiredPlanId } from '../plans/index.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

/** 捕获两条路由（按 path 区分）。 */
function routesFor(config, get) {
  const routes = {}
  apply({
    get: get || (() => undefined),
    webServer: {
      port: 12345,
      register(spec) { routes[spec.path] = spec.handler; return () => {} },
    },
    effect: (fn) => fn(),
  }, config)
  return routes
}

async function request(handler, method = 'GET') {
  let status, body
  await handler({ method }, { writeHead(s) { status = s }, end(text) { body = JSON.parse(text) } })
  return { status, body }
}

/** 起一个本地余额服务，记录收到的请求。 */
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

// ---------------------------------------------------------------------------
// H1 — 退场渠道：旧配置全启用也不取数、不返回
// ---------------------------------------------------------------------------
{
  check('H1a 注册表不再包含三个退场 id',
    !PLANS.some((p) => p.id === 'kimi-code' || p.id === 'glm-zhipu' || p.id === 'glm-zai'),
    PLANS.map((p) => p.id))
  // [2026-10-21] workbuddy-ai 已退场（全部改走国内网关），退场清单为 4 个。
  check('H1b 退场 id 清单与注册表一致', RETIRED_PLAN_IDS.length === 4
    && RETIRED_PLAN_IDS.every((id) => isRetiredPlanId(id) && !PLANS.some((p) => p.id === id)))
  check('H1c 保留渠道仍在注册表', ['opencode-go', 'deepseek', 'codex', 'mimo', 'workbuddy']
    .every((id) => PLANS.some((p) => p.id === id)))

  // 旧配置：三个退场渠道全启用 + DeepSeek 启用。
  const cfg = Object.assign({}, disabledAll, {
    deepseekEnabled: true,
    deepseekApiKey: 'sk-deepseek-sentinel',
    // 旧字段既不会被删除，也不会复活渠道：
    glmEnabled: true,
    glmApiKey: 'sk-glm-sentinel',
    glmZhipuEnabled: true,
    glmZhipuApiKey: 'sk-zhipu-sentinel',
    kimiCodeEnabled: true,
    kimiCodeApiKey: 'sk-kimi-sentinel',
    kimiCodeCookie: 'kimi-cookie-sentinel',
  })
  const realFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url, init) => {
    urls.push(String(url))
    if (String(url).indexOf('api.deepseek.com') !== -1) {
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9.99' }] }), { status: 200 })
    }
    throw new Error('测试不接受其它上游请求: ' + String(url))
  }
  try {
    const routes = routesFor(cfg)
    const res = await request(routes['/api/plan-usage'])
    check('H1d 退场渠道不出现在响应里',
      res.body.ok === true && res.body.data.plans.every((p) => !isRetiredPlanId(p.id)),
      res.body.data && res.body.data.plans.map((p) => p.id))
    check('H1e 退场渠道没有发起任何请求',
      urls.every((u) => u.indexOf('kimi') === -1 && u.indexOf('z.ai') === -1 && u.indexOf('bigmodel') === -1), urls)
    check('H1f 其余内置渠道照常取数', res.body.data.plans.length === 1
      && res.body.data.plans[0].id === 'deepseek' && res.body.data.plans[0].balance === 9.99)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
// H2 — 自定义条目的安全策略在真实路由下生效
// ---------------------------------------------------------------------------
{
  await withBalanceServer({
    '/a': { body: JSON.stringify({ data: { balance: '3.30' } }) },
    '/b': { body: JSON.stringify({ data: { total_credits: 50, total_usage: 20 } }) },
  }, async (base, log) => {
    // 注意：本地测试服务是 http://127.0.0.1，会被**协议检查**先拒；要验证私网
    // 分支必须用 https + 回环地址（真实请求同样在发出前被拦下）。
    // 第二条用公网 https，这里把全局 fetch 换成「只允许 DeepSeek」的桩，
    // 避免测试真的出网（也因此它必然拿到结构化网络失败，而不是余额）。
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).indexOf('api.deepseek.com') !== -1) {
        return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.11' }] }), { status: 200 })
      }
      throw new TypeError('fetch failed (test: network disabled)')
    }
    try {
      const cfg = Object.assign({}, disabledAll, {
        deepseekEnabled: true,
        deepseekApiKey: 'sk-deepseek',
        customBalances: [
          { id: 'custom:aaaaaaaaaaaa', name: '甲', url: 'https://127.0.0.1/a', balancePath: 'data.balance', currency: 'CNY', enabled: true },
          { id: 'custom:bbbbbbbbbbbb', name: '乙', url: 'https://api.example.com/b', balancePath: 'data.total_credits', subtractPath: 'data.total_usage', currency: 'USD', enabled: true },
          { id: 'custom:cccccccccccc', name: '停用', url: 'https://127.0.0.1/a', balancePath: 'data.balance', enabled: false },
        ],
        customKeys: { 'custom:aaaaaaaaaaaa': 'sk-a-sentinel', 'custom:bbbbbbbbbbbb': 'sk-b-sentinel', 'custom:cccccccccccc': 'sk-c-sentinel' },
      })
      const routes = routesFor(cfg)
      const res = await request(routes['/api/plan-usage'])
      const customs = res.body.data.plans.filter((p) => p.custom === true)
      check('H2a 回环地址在发出请求前被拦下（本地服务零请求）', log.length === 0, log.length)
      const loopback = customs.find((p) => p.id === 'custom:aaaaaaaaaaaa')
      check('H2b 回环地址报 config 错误并说明原因',
        loopback !== undefined && loopback.error === 'config' && /环回|私网/.test(loopback.message), loopback)
      check('H2c 停用条目标记 enabled:false 且无错误', customs.some((p) => p.enabled === false && p.error === undefined), customs)
      // 第二条是公网 https（DNS 由真实解析器处理，但 fetch 被桩掉）：必须是
      // 结构化的暂时失败，而不是抛异常或伪造余额。
      const remote = customs.find((p) => p.id === 'custom:bbbbbbbbbbbb')
      check('H2d 公网条目得到结构化暂时失败（不抛异常、不伪造余额）',
        remote !== undefined && remote.error !== undefined && remote.balance === undefined, remote)
      check('H2e 内置渠道照常取数（自定义条目失败不拖累）',
        res.body.data.plans.some((p) => p.id === 'deepseek' && p.balance === 1.11),
        res.body.data.plans.map((p) => p.id))
    } finally {
      globalThis.fetch = realFetch
    }
  })
}

// ---------------------------------------------------------------------------
// H3 — 只启用自定义条目（内置全停用）仍返回数据
// ---------------------------------------------------------------------------
{
  // 关闭出网：这条只关心「编排是否还把自定义条目算进来」，不关心取数结果。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed (test: network disabled)') }
  try {
    const cfg = Object.assign({}, disabledAll, {
      customBalances: [{
        id: 'custom:dddddddddddd', name: '唯一', url: 'https://api.example.com/balance',
        balancePath: 'data.balance', enabled: true,
      }],
      customKeys: { 'custom:dddddddddddd': 'sk-d' },
    })
    const routes = routesFor(cfg)
    const res = await request(routes['/api/plan-usage'])
    check('H3a 内置全停用 + 有自定义条目时不是 disabled', res.body.ok === true, res.body)
    check('H3b 返回该自定义条目（含结构化失败原因）',
      Array.isArray(res.body.data.plans) && res.body.data.plans.length === 1
      && res.body.data.plans[0].id === 'custom:dddddddddddd'
      && typeof res.body.data.plans[0].error === 'string', res.body.data)
  } finally {
    globalThis.fetch = realFetch
  }
}

// 完全没有渠道时仍是 disabled。
{
  const routes = routesFor(Object.assign({}, disabledAll))
  const res = await request(routes['/api/plan-usage'])
  check('H3c 所有渠道都停用时仍是 disabled', res.body.ok === false && res.body.error === 'disabled', res.body)
}

// ---------------------------------------------------------------------------
// H4 — 秘密不泄漏
// ---------------------------------------------------------------------------
{
  const SENTINEL = 'sk-SENTINEL-must-never-leak-9f3a'
  const cfg = Object.assign({}, disabledAll, {
    customBalances: [{
      id: 'custom:eeeeeeeeeeee', name: '哨兵', url: 'https://api.example.com/balance',
      balancePath: 'data.balance', enabled: true,
      credentialRef: 'SENTINEL_REF', credentialHost: 'api.example.com',
    }],
    customKeys: { 'custom:eeeeeeeeeeee': SENTINEL },
  })
  const routes = routesFor(cfg, (name) => (name === 'credentials'
    ? { resolve: async () => ({ value: SENTINEL }), describe: async () => ({ configured: true, writable: true }) }
    : undefined))
  // 关闭出网：本用例只关心「响应里有没有秘密」。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed (test: network disabled)') }
  let usage
  let status
  try {
    usage = await request(routes['/api/plan-usage'])
    status = await request(routes['/api/plan-usage/custom-status'])
  } finally {
    globalThis.fetch = realFetch
  }
  const usageText = JSON.stringify(usage.body)
  const statusText = JSON.stringify(status.body)
  check('H4a /api/plan-usage 响应不含 Key', !usageText.includes(SENTINEL), usageText.slice(0, 200))
  check('H4b /api/plan-usage/custom-status 响应不含 Key', !statusText.includes(SENTINEL), statusText.slice(0, 200))
  /**
   * [CP-07] custom-status 现在**额外**返回 `providers`（可选模型渠道列表），
   * 供设置页渲染「余额来源」下拉。摘要仍然只有布尔与公开元数据，不含任何秘密。
   */
  check('H4c custom-status 只回布尔摘要（外加可选渠道列表）', status.body.ok === true
    && status.body.data.keys['custom:eeeeeeeeeeee'] === true
    && typeof status.body.data.refs['custom:eeeeeeeeeeee'] === 'boolean'
    && Array.isArray(status.body.data.providers), status.body)
  check('H4d 响应里不出现 customKeys 字段', !usageText.includes('customKeys') && !statusText.includes('customKeys'))
}

// ---------------------------------------------------------------------------
// H5 — Config schema：自定义字段可被 DSH 表单渲染，且 secret 是 role('secret')
// ---------------------------------------------------------------------------
{
  const json = Config.toJSON()
  const dictNode = json.refs ? Object.values(json.refs).find((n) => n.type === 'dict') : undefined
  const arrayNode = json.refs ? Object.values(json.refs).find((n) => n.type === 'array') : undefined
  check('H5a Config 含 customBalances 数组字段（volatile）', arrayNode !== undefined
    && arrayNode.meta && arrayNode.meta.volatile === true)
  check('H5b Config 含 customKeys dict（volatile）', dictNode !== undefined
    && dictNode.meta && dictNode.meta.volatile === true)
  // customKeys 的 inner 必须是 role('secret') —— 这是密钥托管的前提。
  const nodes = json.refs ? Object.values(json.refs) : []
  const secretNodes = nodes.filter((n) => n.meta && n.meta.role === 'secret')
  check('H5c 至少一个 secret 字段（customKeys 的内层）', secretNodes.length >= 1, secretNodes.length)
  // 数组元素里不应再有 secret 字段（Key 全在 dict 里，避免数组整体回写抹掉别条）。
  const itemNode = arrayNode !== undefined ? json.refs[String(arrayNode.inner)] : undefined
  const itemFields = itemNode && itemNode.dict ? Object.values(itemNode.dict) : []
  const itemHasSecret = itemFields.some((ref) => {
    const node = json.refs[String(ref)]
    return node !== undefined && node.meta && node.meta.role === 'secret'
  })
  check('H5d 条目数组内不含 secret 字段（Key 只走 dict 路径写入）', !itemHasSecret)

  // 解析真实配置：volatile 字段会被包装，Host 必须能读到值。
  const parsed = Config({
    enabled: true,
    customBalances: [{ id: 'custom:ffffffffffff', name: 'F', url: 'https://f.example.com/b', balancePath: 'b', enabled: true }],
    customKeys: { 'custom:ffffffffffff': 'sk-f' },
    glmEnabled: true,
    kimiCodeEnabled: true,
  })
  check('H5e volatile 字段是包装对象（Host 用 unwrapVolatile 读）',
    typeof parsed.customBalances === 'object' && typeof parsed.customBalances.get === 'function')
  check('H5f 旧配置字段被原样保留（不删除、不复活）',
    parsed.glmEnabled === true && parsed.kimiCodeEnabled === true)
}

// ---------------------------------------------------------------------------
// H6 — 单条自定义失败不影响内置与其他条目
// ---------------------------------------------------------------------------
{
  const cfg = Object.assign({}, disabledAll, {
    deepseekEnabled: true,
    deepseekApiKey: 'sk-deepseek',
    customBalances: [
      { id: 'custom:111111111111', name: '坏配置', url: 'http://insecure.example.com/b', balancePath: 'data.balance', enabled: true },
      { id: 'custom:222222222222', name: '好配置', url: 'https://api.example.com/b', balancePath: 'data.balance', enabled: true },
    ],
    customKeys: { 'custom:111111111111': 'sk-1', 'custom:222222222222': 'sk-2' },
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).indexOf('api.deepseek.com') !== -1) {
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.11' }] }), { status: 200 })
    }
    // 自定义渠道（公网 https）：DNS 由真实解析器处理，但请求本身被拒绝 ——
    // 保证测试不出网，同时验证「单条失败被结构化隔离」。
    throw new TypeError('fetch failed (test: network disabled)')
  }
  try {
    const routes = routesFor(cfg)
    const res = await request(routes['/api/plan-usage'])
    const plans = res.body.data.plans
    const deepseek = plans.find((p) => p.id === 'deepseek')
    const bad = plans.find((p) => p.id === 'custom:111111111111')
    const good = plans.find((p) => p.id === 'custom:222222222222')
    check('H6a 内置渠道不受自定义条目影响', deepseek !== undefined && deepseek.balance === 1.11, deepseek)
    check('H6b 坏 URL 条目报 config 错误', bad !== undefined && bad.error === 'config' && /https/.test(bad.message), bad)
    check('H6c 其他自定义条目仍被处理（成功或结构化暂时失败，不抛异常）',
      good !== undefined && (typeof good.balance === 'number' || good.error !== undefined), good)
    check('H6d 每条都带稳定 id 与 gen', plans.every((p) => typeof p.id === 'string'
      && (p.custom !== true || typeof p.gen === 'string')), plans.map((p) => ({ id: p.id, gen: p.gen })))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
// H7 — 方法限制与 unknown 路径
// ---------------------------------------------------------------------------
{
  const routes = routesFor(Object.assign({}, disabledAll, { deepseekEnabled: true, deepseekApiKey: 'sk-x' }))
  const post = await request(routes['/api/plan-usage'], 'POST')
  check('H7a 用量路由仍只接受 GET（405）', post.status === 405)
  const postStatus = await request(routes['/api/plan-usage/custom-status'], 'POST')
  check('H7b 状态路由仍只接受 GET（405）', postStatus.status === 405)
  check('H7c 两条路由都注册了', routes['/api/plan-usage'] !== undefined
    && routes['/api/plan-usage/custom-status'] !== undefined)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
