/**
 * [0.9.1 自定义渠道改造] 余额来源改为「从已配置的模型渠道选择」。
 *
 * 本轮用户确认的五个问题：
 *   1. 排序失效（`orderedIds` 不认自定义 id）；
 *   2. 凭据引用手填 → 改为**自动复用所选渠道的凭据**；
 *   3. JSON 键与扣减键并排（布局，见 client 的 customFieldPairStyle）；
 *   4. 卡片可折叠（布局 + 状态，见 CustomBalancesSection）；
 *   5. OpenRouter 因 fake-ip 被拒 → 地址来自配置，**跳过 DNS 私网检查**。
 *
 * 全部离线：合成配置与凭据，不读真实 Key、不发真实请求。
 *
 * 用法：node tools/test-custom-provider-source.mjs
 */
import { apply, Config } from '../index.js'
import {
  listProviderTargets,
  collectCustomEntries,
  validateBalanceUrl,
  buildBalanceUrl,
} from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

// ===========================================================================
// P1 — [CP-02/CP-07] 以**公开目录**为准的来源枚举
// ===========================================================================
{
  // 真实接口形状：目录（权威）+ 配置行（用户保存的覆盖）。
  const makeCtx = (catalog, rows) => ({
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => rows }
      return undefined
    },
  })
  const catalog = [
    // 预设来源：配置省略 baseURL，默认地址在目录里
    { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'], defaultBaseURL: 'https://openrouter.ai/api/v1', nativeAuth: { env: ['OPENROUTER_API_KEY'] } },
    // 自定义来源：配置里显式给了地址
    { provider: 'packyapi', displayName: 'PackyAPI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'packyapi'], defaultBaseURL: '' },
    // 目录里存在但用户没添加（未保存配置）→ 不应出现
    { provider: 'notadded', displayName: 'NotAdded', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'notadded'], defaultBaseURL: 'https://na.example/v1' },
    // 目录里没有的 provider（别的插件有同名字段）→ 不应被当成模型来源
    { provider: 'mimo', displayName: 'MiMo', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mimo'], defaultBaseURL: 'https://mimo.example/v1' },
  ]
  const rows = [{
    entry: { options: { id: 'llm-pi-ai' } },
    override: {
      providers: {
        openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' },
        packyapi: { baseURL: 'https://cf.api.fan/v1', apiKeyEnv: 'PACKYAPI_API_KEY' },
      },
    },
    inherited: {},
  }]
  const targets = listProviderTargets(makeCtx(catalog, rows))
  const ids = targets.map((t) => t.provider)
  const byId = Object.fromEntries(targets.map((t) => [t.provider, t]))

  check('P1a 预设来源（OpenRouter）从目录读到默认地址',
    byId.openrouter !== undefined && byId.openrouter.baseURL === 'https://openrouter.ai/api/v1',
    byId.openrouter)
  check('P1b 预设来源标为 catalog', byId.openrouter.baseURLSource === 'catalog', byId.openrouter)
  check('P1c 自定义来源用显式覆盖地址',
    byId.packyapi !== undefined && byId.packyapi.baseURL === 'https://cf.api.fan/v1', byId.packyapi)
  check('P1d 自定义来源标为 override', byId.packyapi.baseURLSource === 'override', byId.packyapi)
  check('P1e 目录里未添加的来源不出现', !ids.includes('notadded'), ids)
  check('P1f 内置渠道（DeepSeek/MiMo）不在自定义列表',
    !ids.includes('mimo') && !ids.includes('deepseek'), ids)
  check('P1g 可查询的来源标为 ready',
    byId.openrouter.status === 'ready' && byId.packyapi.status === 'ready',
    { or: byId.openrouter.status, pk: byId.packyapi.status })
  check('P1h 返回字段齐备（含状态/原因/来源）', targets.every((t) => typeof t.provider === 'string'
    && typeof t.displayName === 'string' && typeof t.baseURL === 'string'
    && typeof t.apiKeyEnv === 'string' && typeof t.status === 'string'
    && typeof t.reason === 'string' && typeof t.baseURLSource === 'string'), targets)
}

// ===========================================================================
// P1i — [CP-02 残留] 非模型 namespace 不得被认作模型来源
// ===========================================================================
{
  // 目录里完全没有 ghost；某无关插件恰好有 providers.ghost 字段。
  const ctx = {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => [] }
      if (name === 'configEditor') return {
        configuration: () => [{
          entry: { options: { id: 'some-other-plugin' } },
          override: { providers: { ghost: { displayName: 'Ghost', baseURL: 'https://wrong.example/v1', apiKeyEnv: 'GHOST' } } },
          inherited: {},
        }],
      }
      return undefined
    },
  }
  check('P1i 目录里没有的 provider 一律不列出（不扫配置行猜）',
    listProviderTargets(ctx).length === 0, listProviderTargets(ctx))
}
// P2 — 旧条目兼容：有 provider 才进新模型；无 provider 的旧条目仍被读取
// ===========================================================================
{
  const cfg = {
    customBalances: [
      { id: 'custom:withprov0001', provider: 'packyapi', name: 'A', balancePath: 'v', enabled: true },
      { id: 'custom:legacy000001', url: 'https://legacy.example/b', name: 'B', balancePath: 'v', enabled: true },
      { id: 'custom:nothing00001', name: 'C', balancePath: 'v', enabled: true },
    ],
  }
  const entries = collectCustomEntries(cfg)
  check('P2a 带 provider 的条目被采纳', entries.some((e) => e.id === 'custom:withprov0001'), entries.map((e) => e.id))
  /**
   * [CP-06] 旧条目（只有 url、没有 provider）**默认不再被采纳**：
   * 这与"升级后需要重新选择来源"的迁移说明一致，避免后台继续查旧地址。
   * 底层安全回归需要时可显式传 `allowLegacy`。
   */
  check('P2b 旧条目默认不被采纳（生产不查旧地址）',
    !entries.some((e) => e.id === 'custom:legacy000001'), entries.map((e) => e.id))
  check('P2b2 显式 allowLegacy 时仍可读取（供底层安全回归）',
    collectCustomEntries(cfg, { allowLegacy: true }).some((e) => e.id === 'custom:legacy000001'))
  check('P2c provider 与 url 同时保留', entries.find((e) => e.id === 'custom:withprov0001').provider === 'packyapi')
}

// ===========================================================================
// P3 — 安全边界变化：provider 来源跳过私网检查（fake-ip 场景）
// ===========================================================================
{
  // fake-ip 段（198.18/15）：用户手填时应拒绝；provider 来源应放行。
  const fakeIp = 'https://198.18.0.237/api/v1/credits'
  const manual = validateBalanceUrl(fakeIp)
  check('P3a 手填 fake-ip 地址被拒绝（原防护仍对用户输入生效）',
    manual.ok === false && manual.error === 'private-host', manual)

  const fromProvider = validateBalanceUrl(fakeIp, { skipPrivateHostCheck: true })
  check('P3b provider 来源的 fake-ip 地址被放行（不误判为内网）', fromProvider.ok === true, fromProvider)

  // 但真正的本地/元数据地址即使来自 provider 也仍受字符串层约束（https + 无 userinfo）。
  const withUserinfo = validateBalanceUrl('https://user:pass@good.example/v1', { skipPrivateHostCheck: true })
  check('P3c 带 userinfo 的地址仍被拒绝', withUserinfo.ok === false, withUserinfo)
  const notHttps = validateBalanceUrl('http://good.example/v1', { skipPrivateHostCheck: true })
  check('P3d 非 https 仍被拒绝', notHttps.ok === false, notHttps)
}

// ===========================================================================
// P4 — 真实 apply：custom-status 返回可选渠道（设置页下拉的数据源）
// ===========================================================================
{
  const routes = {}
  const ctx = {
    webServer: { port: 0, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    get(name) {
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: { options: { id: 'llm-pi-ai' } },
            override: {
              providers: {
                packyapi: { displayName: 'PackyAPI', baseURL: 'https://cf.api.fan/v1', apiKeyEnv: 'PACKYAPI_API_KEY' },
              },
            },
            inherited: {},
          }],
        }
      }
      // [CP-02 残留] 来源枚举以公开目录为准：路由测试必须提供 llm 服务。
      if (name === 'llm') {
        return {
          listConfigurableProviders: () => [{
            provider: 'packyapi',
            displayName: 'PackyAPI',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'packyapi'],
            defaultBaseURL: '',
          }],
        }
      }
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    on() { return () => {} }, off() {}, emit() {}, effect: (fn) => fn(),
  }
  apply(ctx, new Config({
    opencodeGoEnabled: false, deepseekEnabled: false, codexEnabled: false,
    mimoEnabled: false, workbuddyEnabled: false, workbuddyAiEnabled: false,
  }))
  await new Promise((r) => setTimeout(r, 100))

  const res = { s: {}, writeHead(x) { this.s.status = x }, end(c) { this.s.body = String(c || '') } }
  await routes['/api/plan-usage/custom-status']({ method: 'GET' }, res)
  const body = JSON.parse(res.s.body)
  check('P4a custom-status 返回可选渠道列表', body.ok === true
    && Array.isArray(body.data.providers) && body.data.providers.length === 1, body.data && body.data.providers)
  const row = body.data.providers[0]
  check('P4b 只暴露 id / 显示名 / origin（不含凭据）',
    row.provider === 'packyapi' && row.displayName === 'PackyAPI'
    && row.origin === 'https://cf.api.fan'
    && JSON.stringify(row).indexOf('PACKYAPI_API_KEY') === -1, row)
}

// ===========================================================================
// P5 — 缺 provider 的条目在取数时给出可操作提示（不是静默失败）
// ===========================================================================
{
  const routes = {}
  const ctx = {
    webServer: { port: 0, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    get(name) {
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: { options: { id: 'llm-pi-ai' } },
            override: { providers: {} },
            inherited: {},
          }],
        }
      }
      // [CP-02 残留] 来源枚举以公开目录为准：路由测试必须提供 llm 服务。
      if (name === 'llm') {
        return {
          listConfigurableProviders: () => [{
            provider: 'packyapi',
            displayName: 'PackyAPI',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'packyapi'],
            defaultBaseURL: '',
          }],
        }
      }
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    on() { return () => {} }, off() {}, emit() {}, effect: (fn) => fn(),
  }
  apply(ctx, new Config({
    opencodeGoEnabled: false, deepseekEnabled: false, codexEnabled: false,
    mimoEnabled: false, workbuddyEnabled: false, workbuddyAiEnabled: false,
    customBalances: [{
      id: 'custom:missing00001', provider: 'gone', name: 'G', balancePath: 'v', enabled: true,
    }],
  }))
  await new Promise((r) => setTimeout(r, 100))
  const res = { s: {}, writeHead(x) { this.s.status = x }, end(c) { this.s.body = String(c || '') } }
  await routes['/api/plan-usage']({ method: 'GET' }, res)
  const body = JSON.parse(res.s.body)
  const row = (body.data && body.data.plans ? body.data.plans : []).find((p) => p.id === 'custom:missing00001')
  check('P5a 所选渠道不存在时给出结构化错误', row !== undefined && row.error === 'config', row)
  check('P5b 提示文案可操作（要求重新选择）',
    row !== undefined && /重新选择/.test(row.message || ''), row && row.message)
}

// ===========================================================================
// P6 — [CP-03] 余额端点 = 来源根 + 用户填写的路径
// ===========================================================================
{
  // 模型根是 /api/v1，余额端点在 /api/v1/credits：不能拿模型根当余额地址。
  const okCase = buildBalanceUrl('https://openrouter.ai', '/api/v1/credits')
  check('P6a 端点路径拼接正确', okCase.ok === true && okCase.url === 'https://openrouter.ai/api/v1/credits', okCase)

  check('P6b 空路径被拒绝（必须显式填）',
    buildBalanceUrl('https://x.example', '').ok === false)
  check('P6c 缺少前导斜杠被拒绝（防止相对解析歧义）',
    buildBalanceUrl('https://x.example', 'api/v1/credits').ok === false)
  check('P6d 协议相对前缀被拒绝（会被解析成新主机）',
    buildBalanceUrl('https://x.example', '//evil.example/x').ok === false)
  check('P6e 完整网址被拒绝（主机必须来自所选渠道）',
    buildBalanceUrl('https://x.example', 'https://evil.example/x').ok === false)

  // `..` 会被规范化，但仍必须留在同一主机内。
  const dots = buildBalanceUrl('https://x.example', '/a/../../etc')
  check('P6f .. 规范化后仍限制在同一主机', dots.ok === true && dots.url.indexOf('x.example') !== -1, dots)
}
// ===========================================================================
// P7 — [用户实测 2026-10-20] 端点相对 baseURL 解析，不丢 baseURL 的路径
// ===========================================================================
{
  // 用户实测：接口地址已含 /api/v1，只填 /credits 就应该能拿到余额。
  check('P7a baseURL 含 /api/v1 + 端点 /credits → 保留 /api/v1',
    buildBalanceUrl('https://openrouter.ai/api/v1', '/credits').ok === true
    && buildBalanceUrl('https://openrouter.ai/api/v1', '/credits').url === 'https://openrouter.ai/api/v1/credits',
    buildBalanceUrl('https://openrouter.ai/api/v1', '/credits'))
  // 老习惯填全路径：不能重复拼成 /api/v1/api/v1/credits
  check('P7b 端点已含 baseURL 路径 → 不重复拼接',
    buildBalanceUrl('https://openrouter.ai/api/v1', '/api/v1/credits').url === 'https://openrouter.ai/api/v1/credits')
  check('P7c 尾部斜杠的 baseURL 也正确',
    buildBalanceUrl('https://x.example/api/v1/', '/credits').url === 'https://x.example/api/v1/credits')
  check('P7d 无路径的 baseURL 退化为 origin 拼接',
    buildBalanceUrl('https://x.example', '/credits').url === 'https://x.example/credits')
  check('P7e 带查询串的端点保留查询',
    buildBalanceUrl('https://x.example/api/v1', '/credits?limit=1').url === 'https://x.example/api/v1/credits?limit=1')
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
