/**
 * [2026-10-21 内置 WorkBuddy 迁移] WorkBuddy2API 网关取数回归。
 *
 * 用户已撤销「新增自定义卡片/积分格式选项」方案，改为替换内置国内 WorkBuddy 的数据源：
 * 从宿主有效模型配置解析 provider `workbuddy`，复用其网关 Bearer Key，
 * 访问 `<origin>/status`（根路径）。
 *
 * 本文件的 `REAL_STATUS` 是 2026-10-21 从真实网关读到的**结构**（数值为当时实测值，
 * uid/nickname 等身份字段已删除），用于钉住解析口径：
 *   - `accounts[].credits` 是**剩余**，`credits_total` 是累计额度（不能当余额）；
 *   - 顶层**没有**积分汇总字段，合计必须自行求和；
 *   - `realm` 区分 cn / global，本渠道只取 cn。
 *
 * 全部离线：夹具 + 合成凭据，不发真实请求。
 *
 * 用法：node tools/test-workbuddy-gateway.mjs
 */
import {
  isLoopbackHost,
  fetchFromGateway,
} from '../plans/workbuddy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

/** 实测结构（2026-10-21，身份字段已移除）。 */
const REAL_STATUS = {
  accounts: [{
    credits: 5799,
    credits_total: 6600,
    credits_earliest_expiry: '2026-11-17T18:55:03+08:00',
    credits_earliest_remaining: 299,
    cooling: false,
    until: null,
    realm: 'cn',
    disabled: false,
    success_count: 177,
    last_success: null,
    last_err: null,
    checkin_done: true,
    token_usage: null,
    model_costs: [],
    consecutive_fails: 0,
    degrade_until: null,
    in_flight: 0,
    breaker_fails: 0,
    breaker_until: null,
  }],
  cooling: 0,
  disabled: 0,
  healthy: 1,
  in_flight_full: 0,
  total: 1,
  credit_floor: 0,
  sticky_sessions: 0,
  redis_mode: '',
  realm_totals: {
    cn: { cooling: 0, disabled: 0, healthy: 1, in_flight_full: 0, total: 1 },
    global: { cooling: 0, disabled: 0, healthy: 0, in_flight_full: 0, total: 0 },
  },
  cost_explore: { events_total: 0, per_model: {} },
  model_locks: null,
}

/**
 * [2026-10-25 合约变更] 运行期改用**客户端端点** `GET /v1/credits`。
 *
 * 该端点：根带 `ok`/`total_credits`（跨区合计！），账号没有 uid/id、没有 packages。
 * 这里刻意把 global 账号与跨区合计做得比 cn 大，用来守住"绝不把根合计当国内余额"。
 * 数字与昵称都是合成假值。
 */
const CLIENT_CREDITS = {
  ok: true,
  time: 'SYNTHETIC-TIME',
  request_id: 'DUMMY-REQUEST-ID',
  total_credits: 13799,
  accounts: [
    {
      nickname: 'DUMMY-CN',
      realm: 'cn',
      credits: 5799,
      credits_total: 6600,
      credits_expiring: 4,
      credits_earliest_expiry: '2026-11-17T18:55:03+08:00',
      credits_earliest_remaining: 299,
      cooling: false,
      disabled: false,
      tokens: {},
    },
    {
      nickname: 'DUMMY-GLOBAL',
      realm: 'global',
      credits: 8000,
      credits_total: 9000,
      credits_expiring: 5000,
      credits_earliest_expiry: '2026-12-01T00:00:00+08:00',
      credits_earliest_remaining: 4000,
      cooling: false,
      disabled: false,
      tokens: {},
    },
  ],
}

// ===========================================================================
// G4 — 回环主机白名单
// ===========================================================================
{
  check('G4a localhost 允许', isLoopbackHost('localhost') === true)
  check('G4b 127.0.0.1 允许', isLoopbackHost('127.0.0.1') === true)
  check('G4c 127.x 段允许', isLoopbackHost('127.1.2.3') === true)
  check('G4d ::1 允许', isLoopbackHost('::1') === true)
  check('G4e 任意私网不允许（不因本次接入放开）', isLoopbackHost('10.0.0.5') === false)
  check('G4f 192.168 不允许', isLoopbackHost('192.168.1.10') === false)
  check('G4g 公网域名不允许', isLoopbackHost('evil.example') === false)
}

// ===========================================================================
// G5 — 端到端：从宿主配置解析来源并取数（合成 transport）
// ===========================================================================
function makeCtx(catalog, rows, credentials, key) {
  return {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return credentials
      return undefined
    },
    __key: key,
  }
}
const CATALOG = [{
  provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'workbuddy'], defaultBaseURL: '',
}]

async function runCase(opts) {
  const rows = [{
    entry: {
      options: {
        id: 'llm-pi-ai',
        config: opts.config || { providers: { workbuddy: { baseURL: 'http://localhost:7863/v1', apiKeyEnv: 'WB_KEY' } } },
      },
    },
    override: {}, inherited: {},
  }]
  const credentials = opts.noKey === true
    ? { resolve: async () => ({ value: '' }) }
    : { resolve: async (ref) => ({ value: ref === 'WB_KEY' ? 'sk-gateway' : '' }) }
  const ctx = makeCtx(CATALOG, rows, credentials)
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const h = init && init.headers ? init.headers : {}
    calls.push({ url: String(url), auth: h.Authorization || h.authorization || null, redirect: init && init.redirect })
    if (opts.throwOnFetch === true) throw new Error('ECONNREFUSED')
    const payload = opts.body === undefined ? CLIENT_CREDITS : opts.body
    return {
      ok: opts.status === undefined || opts.status < 400,
      status: opts.status === undefined ? 200 : opts.status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
  let out
  try {
    out = await fetchFromGateway(ctx, { id: 'workbuddy', name: 'WorkBuddy' }, {})
  } finally {
    globalThis.fetch = originalFetch
  }
  return { out, calls }
}

{
  const { out, calls } = await runCase({})
  /**
   * [2026-10-25 有意契约变更] 运行期只请求**客户端端点**：
   *  - 只有一个请求，URL 是 origin 根下的 `/v1/credits`（`baseURL` 已带 `/v1` 不重复拼）；
   *  - **不再**请求 `/status`，也**不再**请求 `/panel/api/packages`（新接口没有 packages，
   *    也不该用客户端 Key 去探测管理员面板）。
   * 其余守卫（Bearer 复用、不跟随重定向、wire 结构）保持原样。
   */
  check('G5a 唯一请求打到 origin 根下的 /v1/credits（不探 /status）',
    calls.length === 1 && calls[0].url === 'http://localhost:7863/v1/credits'
    && calls.every((c) => !/\/status|\/panel\//.test(c.url)), calls.map((c) => c.url))
  check('G5f 不再请求 /panel/api/packages（无管理员面探测）',
    calls.every((c) => c.url.indexOf('/panel/') === -1), calls.map((c) => c.url))
  check('G5b 复用网关 Bearer Key', calls[0].auth === 'Bearer sk-gateway', calls[0].auth)
  check('G5c 不跟随重定向', calls[0].redirect === 'error', calls[0].redirect)
  check('G5d 只合计 cn 的 credits（绝不取根跨区合计）',
    out.creditsTotal === 5799 && out.creditsUnlimited === false, { total: out.creditsTotal })
  check('G5e wire 结构保持 + 明细为"剩余 + 其中最早到期部分"',
    Array.isArray(out.variants) && out.variants.length === 1
    && Array.isArray(out.creditsAccounts)
    && out.creditsAccounts.some((r) => r.remain === 5799 && r.endTimeMs === null)
    && out.creditsAccounts.some((r) => r.packageName === '其中最早到期部分' && r.remain === 299),
    { variants: out.variants, rows: out.creditsAccounts })
}

// ===========================================================================
// G6 — 失败分类
// ===========================================================================
{
  const c401 = await runCase({ status: 401 })
  check('G6a 401 → 网关鉴权失败（不误译成需重新登录 WorkBuddy 平台）',
    c401.out.error === 'auth' && /网关鉴权失败/.test(c401.out.message || '')
    && !/重新登录 WorkBuddy/.test(c401.out.message || ''), c401.out.message)

  const c404 = await runCase({ status: 404 })
  check('G6b 404 → 端点/版本不匹配（不再提示未安装 Connect）',
    c404.out.error === 'api' && /\/v1\/credits/.test(c404.out.message || '')
    && !/未安装 dsh-workbuddy-connect/.test(c404.out.message || ''), c404.out.message)

  const c429 = await runCase({ status: 429 })
  check('G6c 429 → 暂时失败（保留有界降级）',
    c429.out.error === 'exec' && c429.out.transient === true, c429.out)

  const cThrow = await runCase({ throwOnFetch: true })
  check('G6d 连接失败 → 暂时失败且零伪造余额',
    cThrow.out.error === 'exec' && cThrow.out.creditsTotal === undefined, cThrow.out)

  const cNoKey = await runCase({ noKey: true })
  check('G6e 无网关 Key → 可操作提示，且不发请求',
    cNoKey.out.error === 'no-key' && /设置 → 模型/.test(cNoKey.out.message || '') && cNoKey.calls.length === 0,
    { err: cNoKey.out.error, msg: cNoKey.out.message, calls: cNoKey.calls.length })
}

// ===========================================================================
// G7 — 来源边界：非回环 HTTP 被拒
// ===========================================================================
{
  const { out, calls } = await runCase({
    config: { providers: { workbuddy: { baseURL: 'http://10.0.0.9/v1', apiKeyEnv: 'WB_KEY' } } },
  })
  check('G7a 非回环的 http 来源被拒绝（不放宽通用出网限制）',
    out.error === 'config' && calls.length === 0, { err: out.error, msg: out.message })
}

// ===========================================================================
// G8 — 来源缺失
// ===========================================================================
{
  const { out, calls } = await runCase({ config: { providers: {} } })
  /**
   * 「完全没配」与「配了但地址不合法」是两个可修状态，错误码可不同，
   * 但都必须：① 给出指向「设置 → 模型」的可操作提示；② 零请求、零凭据外发。
   */
  check('G8a 模型里没配置该网关 → 可操作提示，不发请求',
    (out.error === 'not-configured' || out.error === 'config')
    && /设置 → 模型/.test(out.message || '') && calls.length === 0,
    { err: out.error, msg: out.message, calls: calls.length })
}

// ===========================================================================
// G10 — [用户需求] 详情显示具体积分包与到期
// ===========================================================================
{
// G11 — [真机回归] 成功路径不得被自己的超时逻辑打断
// ===========================================================================
{
  /**
   * 真机故障：`Promise.race([request, timeout])` 在**响应头**到达时 resolve，
   * `finally` 里无条件 `abort()`，紧接着读正文就抛 "This operation was aborted"，
   * 表现为「读取网关账号失败」「WorkBuddy 获取失败」。
   *
   * 这里用**真实 abort 语义**模拟：json() 期间若 signal 已 abort 就 reject。
   * 旧实现必失败，新实现必须通过。
   */
  const makeCtx = () => ({
    get(name) {
      if (name === 'llm') {
        return { listConfigurableProviders: () => CATALOG }
      }
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: { options: { id: 'llm-pi-ai', config: { providers: { workbuddy: { baseURL: 'http://localhost:7863/v1', apiKeyEnv: 'WB_KEY' } } } } },
            override: {}, inherited: {},
          }],
        }
      }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-gateway' }) }
      return undefined
    },
  })
  const originalFetch = globalThis.fetch
  let abortedDuringBody = false
  globalThis.fetch = async (url, init) => {
    const signal = init && init.signal
    return {
      ok: true,
      status: 200,
      text: async () => {
        // 让出事件循环，模拟「响应头已到、正文尚未读完」的窗口
        await new Promise((r) => setTimeout(r, 5))
        if (signal && signal.aborted) {
          abortedDuringBody = true
          throw new Error('This operation was aborted')
        }
        return JSON.stringify(CLIENT_CREDITS)
      },
    }
  }
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {})
  } finally {
    globalThis.fetch = originalFetch
  }
  check('G11a 成功读取正文时 signal 未被 abort', abortedDuringBody === false)
  check('G11b 成功路径拿到正确合计（不是"获取失败"）',
    out.creditsTotal === 5799 && out.error === undefined, { total: out.creditsTotal, err: out.error })
}
// ===========================================================================
// G12 — [真机回归] 正文只能消费一次（不能读两遍）
// ===========================================================================
{
  /**
   * 真机故障：辅助函数已把正文读完，调用方又调 `response.json()`，
   * 流已被消费 → 必抛 → 界面永远显示「网关状态响应不是合法 JSON」，而数据其实是好的。
   *
   * 这里模拟「只能读一次」的真实语义：第二次读直接拒绝。
   */
  const catalog = CATALOG
  const rows = [{
    entry: { options: { id: 'llm-pi-ai', config: { providers: { workbuddy: { baseURL: 'http://localhost:7863/v1', apiKeyEnv: 'WB_KEY' } } } } },
    override: {}, inherited: {},
  }]
  const ctx = {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-gateway' }) }
      return undefined
    },
  }
  const originalFetch = globalThis.fetch
  let consumed = 0
  globalThis.fetch = async () => {
    const mkOnce = () => {
      if (consumed > 0) throw new Error('body stream already consumed')
      consumed++
      return JSON.stringify(CLIENT_CREDITS)
    }
    return {
      ok: true,
      status: 200,
      text: async () => mkOnce(),
      json: async () => JSON.parse(mkOnce()),
    }
  }
  let out
  try {
    out = await fetchFromGateway(ctx, { id: 'workbuddy', name: 'WorkBuddy' }, {})
  } finally {
    globalThis.fetch = originalFetch
  }
  check('G12a 正文只被消费一次（不再二次读取）',
    out.error === undefined && out.creditsTotal === 5799, { err: out.error, msg: out.message })
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
}
