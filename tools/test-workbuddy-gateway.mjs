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
  creditsFromGatewayStatus,
  creditPackagesOf,
  parseAccountSelection,
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

// ===========================================================================
// G1 — 实测结构上的积分口径
// ===========================================================================
{
  const r = creditsFromGatewayStatus(REAL_STATUS, 'cn')
  check('G1a 单账号：取 accounts[].credits 作为剩余', r.ok === true && r.total === 5799, r)
  check('G1b 不把 credits_total（累计额度）当余额', r.ok === true && r.total !== 6600, r && r.total)
  check('G1c 只产出一条账号明细', r.ok === true && r.accounts.length === 1)
  check('G1d 记录最早到期时间与其余额',
    r.accounts[0].earliestExpiry === '2026-11-17T18:55:03+08:00'
    && r.accounts[0].earliestRemaining === 299, r.accounts[0])
  check('G1e 不在结果里保留 uid/nickname 等身份字段',
    r.accounts[0].uid === undefined && r.accounts[0].nickname === undefined, Object.keys(r.accounts[0]))
}

// ===========================================================================
// G2 — 多账号池 + 域过滤 + 停用账号
// ===========================================================================
{
  const multi = {
    accounts: [
      { credits: 100, credits_total: 200, realm: 'cn', disabled: false },
      { credits: 50.5, credits_total: 100, realm: 'cn', cooling: true, disabled: false },
      { credits: 999, credits_total: 1000, realm: 'cn', disabled: true },
      { credits: 777, credits_total: 800, realm: 'global', disabled: false },
    ],
  }
  const r = creditsFromGatewayStatus(multi, 'cn')
  check('G2a 多国内账号求和（排除停用、计入冷却）', r.ok === true && r.total === 150.5, r && r.total)
  check('G2b 国际池不混进国内积分', r.ok === true && r.accounts.length === 3, r && r.accounts.length)
  check('G2c 冷却账号仍计入剩余（积分还在）',
    r.accounts.some((a) => a.cooling === true))

  const onlyGlobal = { accounts: [{ credits: 5, realm: 'global', disabled: false }] }
  const g = creditsFromGatewayStatus(onlyGlobal, 'cn')
  check('G2d 只有国际账号时视为无可用国内账号', g.ok === false && g.reason === 'no-account', g)
}

// ===========================================================================
// G3 — 缺值与真实 0 的区别
// ===========================================================================
{
  const zero = { accounts: [{ credits: 0, credits_total: 100, realm: 'cn', disabled: false }] }
  const z = creditsFromGatewayStatus(zero, 'cn')
  check('G3a 真实 0 是有效值（不是"缺值"）', z.ok === true && z.total === 0, z)

  const missing = { accounts: [{ credits_total: 100, realm: 'cn', disabled: false }] }
  const m = creditsFromGatewayStatus(missing, 'cn')
  check('G3b 缺 credits 字段的账号被跳过（不猜成 0）', m.ok === false && m.reason === 'no-account', m)

  const badShape = { foo: 1 }
  check('G3c 无 accounts 数组 → 结构不可解析', creditsFromGatewayStatus(badShape, 'cn').ok === false)
  check('G3d null 响应 → 结构不可解析', creditsFromGatewayStatus(null, 'cn').ok === false)
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
    const payload = opts.body === undefined ? REAL_STATUS : opts.body
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
   * [2026-10-21] 现在会多打一条 `/panel/api/packages`（积分包明细）。
   * 首个请求仍必须是 origin 根下的 `/status`，且**不是** `/v1/status`。
   */
  check('G5a 首个请求打到 origin 根下的 /status（不是 /v1/status）',
    calls.length >= 1 && calls[0].url === 'http://localhost:7863/status'
    && !/\/v1\/status/.test(calls[0].url), calls.map((c) => c.url))
  check('G5f 明细请求打到 /panel/api/packages 且同样带 Bearer',
    calls.length === 2 && calls[1].url === 'http://localhost:7863/panel/api/packages'
    && calls[1].auth === 'Bearer sk-gateway', calls.map((c) => c.url))
  check('G5b 复用网关 Bearer Key', calls[0].auth === 'Bearer sk-gateway', calls[0].auth)
  check('G5c 不跟随重定向', calls[0].redirect === 'error', calls[0].redirect)
  check('G5d 积分取剩余值并落到 creditsTotal',
    out.creditsTotal === 5799 && out.creditsUnlimited === false, { total: out.creditsTotal })
  check('G5e wire 结构保持（variants/明细仍在）',
    Array.isArray(out.variants) && out.variants.length === 1 && Array.isArray(out.creditsAccounts),
    { variants: out.variants, n: out.creditsAccounts && out.creditsAccounts.length })
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
    c404.out.error === 'api' && /\/status/.test(c404.out.message || '')
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
// G9 — [用户需求] 账号选择：只合计选中的账号
// ===========================================================================
{
  const pool = {
    accounts: [
      { uid: 'U-A', credits: 100, credits_total: 200, realm: 'cn', disabled: false },
      { uid: 'U-B', credits: 50, credits_total: 100, realm: 'cn', disabled: false },
      { uid: 'U-C', credits: 7, credits_total: 10, realm: 'cn', disabled: false },
    ],
  }
  check('G9a 不选账号 = 全部合计', creditsFromGatewayStatus(pool, 'cn', []).total === 157,
    creditsFromGatewayStatus(pool, 'cn', []).total)
  check('G9b 只选 A = 只算 A', creditsFromGatewayStatus(pool, 'cn', ['U-A']).total === 100,
    creditsFromGatewayStatus(pool, 'cn', ['U-A']).total)
  check('G9c 选 A+B = 合两者', creditsFromGatewayStatus(pool, 'cn', ['U-A', 'U-B']).total === 150,
    creditsFromGatewayStatus(pool, 'cn', ['U-A', 'U-B']).total)
  check('G9d 选中项与账号明细条数一致', creditsFromGatewayStatus(pool, 'cn', ['U-A', 'U-C']).accounts.length === 2)
  check('G9e 选了不存在的账号 → 没有可用账号（不静默回退成全量）',
    creditsFromGatewayStatus(pool, 'cn', ['U-Z']).ok === false,
    creditsFromGatewayStatus(pool, 'cn', ['U-Z']))

  check('G9f 空字符串解析为「全部」', parseAccountSelection('').length === 0)
  check('G9g 非法 JSON 解析为「全部」（不崩）', parseAccountSelection('{oops').length === 0)
  check('G9h 去重并忽略非字符串', parseAccountSelection('["A","A",1,null,"B"]').join(',') === 'A,B',
    parseAccountSelection('["A","A",1,null,"B"]'))
}

// ===========================================================================
// G10 — [用户需求] 详情显示具体积分包与到期
// ===========================================================================
{
  const packages = {
    accounts: [{
      uid: 'U-A', nickname: 'x', realm: 'cn', remain: 300, size: 500,
      packages: [
        { name: '包甲', size: 100, remain: 0, expires_at: 1795000000000 },   // 已用完 → 不列
        { name: '包乙', size: 100, remain: 40, expires_at: 1797000000000 },
        { name: '包丙', size: 200, remain: 260, expires_at: 1796000000000 },
        { name: '无到期包', size: 50, remain: 10, expires_at: null },
      ],
    }],
  }
  const rows = creditPackagesOf(packages, 'cn', [])
  check('G10a 已用完的包不列出', rows.length === 3 && rows.every((r) => r.remain > 0), rows)
  check('G10b 先到期的排前面', rows[0].packageName === '包丙' && rows[1].packageName === '包乙',
    rows.map((r) => r.packageName))
  check('G10c 带上到期时间（epoch ms）', rows[0].endTimeMs === 1796000000000, rows[0])
  check('G10d 缺到期时间的排最后且为 null',
    rows[2].packageName === '无到期包' && rows[2].endTimeMs === null, rows[2])
  check('G10e 不输出 uid/nickname/package_code 等身份字段',
    rows[0].uid === undefined && rows[0].nickname === undefined && rows[0].packageCode === undefined,
    Object.keys(rows[0]))
  check('G10f 无 packages 结构时返回空（退回账号汇总）',
    creditPackagesOf({ accounts: [{ uid: 'U', realm: 'cn', remain: 1 }] }, 'cn', []).length === 0)
  check('G10g 选择账号后明细同步过滤',
    creditPackagesOf({
      accounts: [
        { uid: 'A', realm: 'cn', packages: [{ name: 'a', remain: 1, size: 1, expires_at: 1 }] },
        { uid: 'B', realm: 'cn', packages: [{ name: 'b', remain: 1, size: 1, expires_at: 1 }] },
      ],
    }, 'cn', ['B']).map((r) => r.packageName).join(',') === 'b')
}
// ===========================================================================
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
        return JSON.stringify(REAL_STATUS)
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
      return JSON.stringify(REAL_STATUS)
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
