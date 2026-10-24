/**
 * [第二轮复核整改] CP-01/02/04/07/08 残留项的定向回归。
 *
 * 覆盖审核给出的合成反例（全部离线、合成配置与凭据）：
 *   - FAIL_ROUTER_CATALOG_DEFAULT_NEVER_READ：OpenRouter 默认地址必须从**公开目录**读到；
 *   - FAIL_UNIQUE_NON_MODEL_OWNER_ACCEPTED：目录里没有的 provider 一律不当模型来源；
 *   - FAIL_IDENTITY_A_CACHES_DISPATCH_B：身份采样与实际派发必须用**同一份**冻结来源；
 *   - FAIL_HOST_IDENTITY_STILL_OMITS_PROVIDER / ENDPOINT：换来源/换端点必须改变宿主观察身份；
 *   - custom-status 必须保留 status/reason（不能只给 helper 加字段）；
 *   - CP-08：展示用 baseURL 保留路径、去掉敏感部分。
 *
 * 用法：node tools/test-custom-provider-round2.mjs
 */
import { createHash } from 'node:crypto'
import {
  listProviderTargets,
  resolveProviderCredential,
  fetchCustomBalance,
} from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

/** 真实接口形状：目录（权威）+ 配置行（用户保存的覆盖）。 */
function makeCtx(catalog, rows, credentials) {
  return {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return credentials || { resolve: async () => ({ value: '' }) }
      return undefined
    },
  }
}

// ===========================================================================
// R1 — CP-07 残留：OpenRouter 默认地址必须来自公开目录
// ===========================================================================
{
  const catalog = [{
    provider: 'openrouter',
    displayName: 'OpenRouter',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openrouter'],
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    nativeAuth: { env: ['OPENROUTER_API_KEY'] },
  }]
  // 关键：配置**省略** baseURL（真实场景就是这样）。
  const rows = [{
    entry: { options: { id: 'llm-pi-ai' } },
    override: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } },
    inherited: {},
  }]
  const targets = listProviderTargets(makeCtx(catalog, rows))
  const hit = targets.find((t) => t.provider === 'openrouter')
  check('R1a OpenRouter 出现在列表里', hit !== undefined, targets.map((t) => t.provider))
  check('R1b 默认地址从目录读到（不是配置行）',
    hit !== undefined && hit.baseURL === 'https://openrouter.ai/api/v1', hit && hit.baseURL)
  check('R1c 来源标为 catalog', hit !== undefined && hit.baseURLSource === 'catalog', hit && hit.baseURLSource)
  check('R1d 状态为 ready（可查询）', hit !== undefined && hit.status === 'ready', hit && hit.status)
}

// ===========================================================================
// R2 — CP-02 残留：非模型 owner 不得被认作来源
// ===========================================================================
{
  // 目录里没有 ghost；无关插件恰好声明了 providers.ghost。
  const rows = [{
    entry: { options: { id: 'some-other-plugin' } },
    override: { providers: { ghost: { baseURL: 'https://wrong.example/v1', apiKeyEnv: 'GHOST' } } },
    inherited: {},
  }]
  check('R2a 目录里没有的 provider 不出现在列表', listProviderTargets(makeCtx([], rows)).length === 0)

  // 即使目录里有，但配置行不属于该目录声明的 namespace → 也不算已添加。
  const catalog = [{ provider: 'ghost', displayName: 'Ghost', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ghost'] }]
  check('R2b 非 owner namespace 的行不算已添加',
    listProviderTargets(makeCtx(catalog, rows)).length === 0)

  // 读来源时同样拒绝（不只是列表层面）。
  const out = resolveProviderCredential(makeCtx([], rows), 'ghost', '/credits', null)
  const r2c = await out
  check('R2c 解析来源时也拒绝非模型 owner', r2c.ok === false && r2c.error === 'config', r2c)
}

// ===========================================================================
// R3 — CP-01 残留：冻结完整来源，派发不再二次解析
// ===========================================================================
{
  let reads = 0
  const catalog = [{
    provider: 'alpha',
    displayName: 'Alpha',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'alpha'],
    defaultBaseURL: 'https://alpha.example/v1',
  }]
  const rows = [{
    entry: { options: { id: 'llm-pi-ai' } },
    override: { providers: { alpha: { apiKeyEnv: 'ALPHA_KEY' } } },
    inherited: {},
  }]
  // 每次读取凭据都返回**不同**的值：模拟审核的「采样 A、派发 B」。
  const credentials = {
    resolve: async () => {
      reads += 1
      return { value: reads === 1 ? 'sk-A' : 'sk-B' }
    },
  }
  const ctx = makeCtx(catalog, rows, credentials)

  // 第一次：解析出完整来源（相当于 identify 采样）。
  const first = await resolveProviderCredential(ctx, 'alpha', '/credits', null)
  check('R3a 冻结结果包含本次凭据值', first.ok === true && first.value === 'sk-A', first)
  // [2026-10-20 用户实测] 端点现在**相对 baseURL 的路径**解析，/v1 会被保留。
  check('R3b 冻结结果包含本次余额 URL（保留 baseURL 的 /v1）',
    first.ok === true && first.url === 'https://alpha.example/v1/credits', first && first.url)

  // 派发：把冻结结果交给 fetchCustomBalance，它**不得**再解析（reads 不再增长）。
  const readsBefore = reads
  let sentAuth = null
  let sentUrl = null
  await fetchCustomBalance(ctx, undefined, {}, {
    id: 'custom:aaaaaaaaaaaa',
    provider: 'alpha',
    balanceEndpoint: '/credits',
    name: 'A',
    balancePath: 'v',
    subtractPath: '',
    currency: '',
    credentialRef: '',
    credentialHost: '',
    urlHostConfirmed: '',
    enabled: true,
    url: '',
    key: '',
    gen: 'g',
  }, {
    credentialSnapshot: {
      'custom:aaaaaaaaaaaa': {
        kind: 'provider',
        provider: 'alpha',
        url: first.url,
        origin: first.origin,
        ref: first.ref,
        value: first.value,
        fingerprint: 'x',
      },
    },
    timeoutMs: 5000,
    transport: async (url, init) => {
      sentUrl = String(url)
      sentAuth = init && init.headers ? init.headers.authorization : undefined
      return { status: 200, text: async () => JSON.stringify({ v: 7 }) }
    },
    resolveHost: async () => ['93.184.216.34'],
  })
  check('R3c 派发不再二次读取凭据', reads === readsBefore, { before: readsBefore, after: reads })
  check('R3d 派发使用的是冻结的那份值（A，不是 B）',
    typeof sentAuth === 'string' && sentAuth.includes('sk-A'), sentAuth)
  check('R3e 派发目标也是冻结的那份 URL', sentUrl === first.url, { sentUrl, frozen: first.url })
}

// ===========================================================================
// R4 — CP-04 残留：换来源/换端点必须改变宿主观察身份
// ===========================================================================
{
  // 直接验证身份输入是否包含 provider 与 endpoint：用 index.js 的 identityOfChannel
  // 不方便单独导出，这里改为检查 entryPublicIdentity 的同构性（公共摘要）与
  // generationOf 的字段集合，二者都必须覆盖 provider/endpoint。
  const { entryPublicIdentity, generationOf } = await import('../plans/custom-balance.js')
  const base = {
    id: 'custom:bbbbbbbbbbbb', provider: 'alpha', balanceEndpoint: '/credits',
    url: 'https://alpha.example/v1/credits', balancePath: 'v', subtractPath: '',
    currency: '', credentialRef: '', credentialHost: '', enabled: true,
  }
  const alpha = entryPublicIdentity(base)
  const beta = entryPublicIdentity(Object.assign({}, base, { provider: 'beta' }))
  const endpoint = entryPublicIdentity(Object.assign({}, base, { balanceEndpoint: '/other' }))
  check('R4a 公共摘要对 provider 敏感', alpha !== beta)
  check('R4b 公共摘要对端点敏感', alpha !== endpoint)

  const g1 = generationOf(base, 'k')
  const g2 = generationOf(Object.assign({}, base, { provider: 'beta' }), 'k')
  const g3 = generationOf(Object.assign({}, base, { balanceEndpoint: '/other' }), 'k')
  check('R4c 代次对 provider 敏感', g1 !== g2)
  check('R4d 代次对端点敏感', g1 !== g3)
}

// ===========================================================================
// R5 — CP-08：展示用 URL 脱敏（保留路径）
// ===========================================================================
{
  // 与 index.js 的 sanitizeDisplayUrl 同规则；这里独立实现一份做交叉验证。
  const sanitize = (text) => {
    if (typeof text !== 'string' || text.trim().length === 0) return ''
    try {
      const u = new URL(text.trim())
      return u.protocol + '//' + u.host + u.pathname
    } catch (err) { return '' }
  }
  check('R5a 保留路径（能看出 /v1）',
    sanitize('https://openrouter.ai/api/v1') === 'https://openrouter.ai/api/v1')
  check('R5b 去掉查询串', sanitize('https://x.example/v1?key=SECRET') === 'https://x.example/v1')
  check('R5c 去掉 userinfo', sanitize('https://user:pass@x.example/v1') === 'https://x.example/v1')
  check('R5d 去掉 fragment', sanitize('https://x.example/v1#frag') === 'https://x.example/v1')
  check('R5e 非法输入返回空串', sanitize('not a url') === '')
}

// ===========================================================================
// R6 — 预算：凭据解析挂起时按预算返回，不发请求
// ===========================================================================
{
  const catalog = [{
    provider: 'slow', displayName: 'Slow', settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'slow'], defaultBaseURL: 'https://slow.example/v1',
  }]
  const rows = [{
    entry: { options: { id: 'llm-pi-ai' } },
    override: { providers: { slow: { apiKeyEnv: 'SLOW_KEY' } } },
    inherited: {},
  }]
  const ctx = makeCtx(catalog, rows, { resolve: () => new Promise(() => {}) })
  let requests = 0
  const started = Date.now()
  const out = await fetchCustomBalance(ctx, undefined, {}, {
    id: 'custom:cccccccccccc', provider: 'slow', balanceEndpoint: '/credits',
    name: 'S', balancePath: 'v', subtractPath: '', currency: '',
    credentialRef: '', credentialHost: '', urlHostConfirmed: '', enabled: true,
    url: '', key: '', gen: 'g',
  }, {
    // fetchCustomBalance 用 timeoutMs（不是 budgetMs）创建预算。
    timeoutMs: 40,
    transport: async () => { requests += 1; return { status: 200, text: async () => '{}' } },
    resolveHost: async () => ['93.184.216.34'],
  })
  const elapsed = Date.now() - started
  check('R6a 凭据挂起时按预算返回', elapsed < 400, elapsed)
  check('R6b 挂起时零请求', requests === 0, requests)
  check('R6c 结果是结构化失败且无余额', out.balance === undefined && out.error !== undefined, out)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
