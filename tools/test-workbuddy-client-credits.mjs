/**
 * [2026-10-25] WorkBuddy 客户端积分端点（`GET /v1/credits`）离线回归。
 *
 * 覆盖：纯解析口径（cn / 负数 / 0 / 停用 / 冷却 / 未知 realm / 根 ok / 跨区合计）、
 * 最早到期摘要（只用 earliest_remaining + earliest_expiry，不用 credits_expiring）、
 * HTTP 分类、URL 与鉴权形态、取消与预算、账号元数据零 I/O、Host 身份、UI 文案。
 *
 * 全部样本为**合成假值**（DUMMY/SYNTHETIC），不含真实账号、日期或凭据。
 * 不联网：所有请求都由本文件的假 fetch 承接。
 *
 * 用法：node tools/test-workbuddy-client-credits.mjs
 */
import { readFileSync } from 'node:fs'
import {
  creditsFromClientCredits,
  creditsUrlOf,
  fetchFromGateway,
  listWorkbuddyAccounts,
} from '../plans/workbuddy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

/** 合成账号（字段名与真实合约一致，值全为假）。 */
function acc(over) {
  return Object.assign({
    nickname: 'SYNTHETIC',
    realm: 'cn',
    credits: 100,
    credits_total: 500,
    credits_expiring: 4,
    credits_earliest_expiry: '2030-01-02T03:04:05+08:00',
    credits_earliest_remaining: 1,
    cooling: false,
    disabled: false,
    tokens: {},
  }, over || {})
}
function body(accounts, over) {
  return Object.assign({
    ok: true,
    time: 'SYNTHETIC-TIME',
    request_id: 'DUMMY-REQUEST-ID',
    // 跨区合计：故意远大于 cn，守住"绝不拿它当国内余额"
    total_credits: 999999,
    accounts,
  }, over || {})
}

// ===========================================================================
// P1 — 纯解析：只算 cn、忽略跨区合计与累计额度
// ===========================================================================
{
  const r = creditsFromClientCredits(body([
    acc({ realm: 'cn', credits: 100 }),
    acc({ realm: 'global', credits: 70000 }),
  ]), 'cn')
  check('P1a 只合计 cn（不含 global，也不含根 total_credits）',
    r.ok === true && r.total === 100 && r.accounts.length === 1, r)
}
{
  const r = creditsFromClientCredits(body([acc({ credits: 0 })]), 'cn')
  check('P1b 0 是有效余额（不因 falsy 被丢）', r.ok === true && r.total === 0 && r.accounts.length === 1, r)
}
{
  const r = creditsFromClientCredits(body([acc({ credits: -5 })]), 'cn')
  check('P1c 有限负数原样保留（不钳零、不丢弃）', r.ok === true && r.total === -5, r)
}
{
  const r = creditsFromClientCredits(body([acc({ disabled: true, credits: 50 }), acc({ credits: 20 })]), 'cn')
  check('P1d 停用账号不计入合计（但仍在明细里）',
    r.ok === true && r.total === 20 && r.accounts.length === 2, r)
}
{
  const r = creditsFromClientCredits(body([acc({ cooling: true, credits: 30 })]), 'cn')
  check('P1e 冷却中仍计入合计（与旧口径一致）', r.ok === true && r.total === 30, r)
}
{
  const r = creditsFromClientCredits(body([
    acc({ realm: undefined }),
    acc({ realm: 'GLOBAL' }),
    acc({ realm: '' }),
    acc({ realm: 'cn', credits: 8 }),
  ]), 'cn')
  check('P1f realm 缺失/未知/大小写不符一律不纳入',
    r.ok === true && r.accounts.length === 1 && r.total === 8, r)
}

// ===========================================================================
// P2 — 根状态与结构守卫
// ===========================================================================
{
  check('P2a 根 ok=false → not-ok',
    creditsFromClientCredits(body([acc()], { ok: false }), 'cn').reason === 'not-ok')
  check('P2b 根 ok 是字符串 "true" 不算成功（严格布尔）',
    creditsFromClientCredits(body([acc()], { ok: 'true' }), 'cn').reason === 'not-ok')
  check('P2c 缺根 ok → not-ok',
    creditsFromClientCredits((function () { const b = body([acc()]); delete b.ok; return b })(), 'cn').reason === 'not-ok')
  check('P2d accounts 不是数组 → shape',
    creditsFromClientCredits(body({}), 'cn').reason === 'shape')
  check('P2e 非对象 → shape', creditsFromClientCredits(null, 'cn').reason === 'shape')
  check('P2f 没有 cn 账号 → no-cn-account',
    creditsFromClientCredits(body([acc({ realm: 'global' })]), 'cn').reason === 'no-cn-account')
}

// ===========================================================================
// P3 — 缺失/非法 credits：保守失败，绝不把部分值当完整合计
// ===========================================================================
{
  const r = creditsFromClientCredits(body([
    acc({ credits: 40 }),
    acc({ credits: undefined }),
  ]), 'cn')
  check('P3a 未停用 cn 缺 credits → 整体判失败（不给部分合计）',
    r.ok === false && r.reason === 'bad-cn-credits', r)
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits: 40 }),
    acc({ credits: 'abc' }),
  ]), 'cn')
  check('P3b 未停用 cn 的 credits 非数字 → 整体判失败', r.ok === false && r.reason === 'bad-cn-credits', r)
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits: Number.NaN }),
  ]), 'cn')
  check('P3c NaN → 判失败（不造 0）', r.ok === false && r.reason === 'bad-cn-credits', r)
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits: 40 }),
    acc({ disabled: true, credits: undefined }),
  ]), 'cn')
  check('P3d 已停用 cn 的坏 credits 不影响其它 cn 账号',
    r.ok === true && r.total === 40 && r.accounts.length === 1, r)
}
{
  const r = creditsFromClientCredits(body([
    acc({ realm: 'global', credits: 'bad' }),
    acc({ credits: 9 }),
  ]), 'cn')
  check('P3e global 坏值不影响 cn 独立采样', r.ok === true && r.total === 9, r)
}
{
  const r = creditsFromClientCredits(body([acc({ credits: Infinity })]), 'cn')
  check('P3f Infinity 不算可用数值', r.ok === false && r.reason === 'bad-cn-credits', r)
}

// ===========================================================================
// P4 — 到期摘要：只用 earliest_remaining + earliest_expiry
// ===========================================================================
{
  // 父的反例：expiring=4 但 earliest_remaining=1 → 摘要金额必须是 1
  const r = creditsFromClientCredits(body([
    acc({ credits: 100, credits_expiring: 4, credits_earliest_remaining: 1 }),
  ]), 'cn')
  check('P4a 摘要金额取 earliest_remaining（不是 credits_expiring）',
    r.ok === true && r.accounts[0].earliestRemaining === 1, r.accounts[0])
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits_earliest_remaining: 0 }),
  ]), 'cn')
  check('P4b earliest_remaining=0 → 不出到期摘要',
    r.ok === true && r.accounts[0].earliestRemaining === null && r.accounts[0].earliestExpiry === null, r.accounts[0])
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits_earliest_expiry: 'NOT-A-DATE' }),
  ]), 'cn')
  check('P4c 非法日期 → 不出到期摘要（不造条）',
    r.ok === true && r.accounts[0].earliestRemaining === null, r.accounts[0])
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits_earliest_expiry: '' }),
  ]), 'cn')
  check('P4d 空日期 → 不出到期摘要', r.ok === true && r.accounts[0].earliestExpiry === null, r.accounts[0])
}
{
  const r = creditsFromClientCredits(body([acc({ credits_expiring: 999 })]), 'cn')
  check('P4e credits_expiring 完全不参与（窗口未知）',
    r.ok === true && r.accounts[0].earliestRemaining === 1, r.accounts[0])
}

// ===========================================================================
// P5 — URL 形态：单一明确路径 origin + /v1/credits
// ===========================================================================
{
  check('P5a baseURL 带 /v1 不重复拼接',
    creditsUrlOf(new URL('http://localhost:9999/v1')) === 'http://localhost:9999/v1/credits',
    creditsUrlOf(new URL('http://localhost:9999/v1')))
  check('P5b baseURL 无路径同样得到 /v1/credits',
    creditsUrlOf(new URL('https://gw.example.invalid')) === 'https://gw.example.invalid/v1/credits',
    creditsUrlOf(new URL('https://gw.example.invalid')))
  check('P5c 非 /v1 前缀也不做自行扩展（仍是 origin 根 /v1/credits）',
    creditsUrlOf(new URL('https://gw.example.invalid/api')) === 'https://gw.example.invalid/v1/credits',
    creditsUrlOf(new URL('https://gw.example.invalid/api')))
}

// ===========================================================================
// P6 — 端到端（合成 transport）：URL/Bearer/不跟随重定向/分类
// ===========================================================================
const CATALOG = [{
  provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'workbuddy'], defaultBaseURL: '',
}]
function makeCtx() {
  const rows = [{
    entry: {
      options: {
        id: 'llm-pi-ai',
        config: { providers: { workbuddy: { baseURL: 'http://localhost:9999/v1', apiKeyEnv: 'WB_KEY' } } },
      },
    },
    override: {}, inherited: {},
  }]
  return {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => CATALOG }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return { resolve: async (ref) => ({ value: ref === 'WB_KEY' ? 'Bearerless-DUMMY' : '' }) }
      return undefined
    },
  }
}
async function run(opts) {
  const o = opts || {}
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const h = init && init.headers ? init.headers : {}
    calls.push({ url: String(url), auth: h.Authorization || h.authorization || null, redirect: init && init.redirect })
    if (o.throwOnFetch === true) throw new Error('ECONNREFUSED')
    const payload = o.body === undefined ? body([acc()]) : o.body
    const status = o.status === undefined ? 200 : o.status
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(payload),
    }
  }
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, o.options)
  } finally {
    globalThis.fetch = originalFetch
  }
  return { out, calls }
}

{
  const { out, calls } = await run({})
  check('P6a 只请求 origin 根 /v1/credits（不探 /status、/panel）',
    calls.length === 1 && calls[0].url === 'http://localhost:9999/v1/credits'
    && calls.every((c) => !/\/status|\/panel\//.test(c.url)), calls.map((c) => c.url))
  check('P6b 复用来源 Bearer Key', calls[0].auth === 'Bearer Bearerless-DUMMY', calls[0].auth)
  check('P6c 不跟随重定向', calls[0].redirect === 'error', calls[0].redirect)
  check('P6d 成功 → creditsTotal = cn 合计、isAvailable',
    out.error === undefined && out.creditsTotal === 100 && out.isAvailable === true, out)
}
{
  const { out } = await run({ status: 401 })
  check('P6e 401 → auth/gateway-key（提示去「设置 → 模型」）',
    out.error === 'auth' && out.authKind === 'gateway-key' && /设置 → 模型/.test(out.message || ''), out.message)
}
{
  const { out } = await run({ status: 404 })
  check('P6f 404 → api 且点明 /v1/credits（不提示装 Connect）',
    out.error === 'api' && /\/v1\/credits/.test(out.message || '')
    && !/dsh-workbuddy-connect/.test(out.message || ''), out.message)
}
{
  const { out } = await run({ status: 429 })
  check('P6g 429 → transient exec', out.error === 'exec' && out.transient === true, out)
}
{
  const { out } = await run({ status: 503 })
  check('P6h 5xx → transient exec', out.error === 'exec' && out.transient === true, out)
}
{
  const { out } = await run({ body: body([acc()], { ok: false }) })
  check('P6i 根 ok=false → 固定失败文案（不透传上游）',
    out.error === 'exec' && /未成功状态/.test(out.message || ''), out.message)
}
{
  const { out } = await run({ throwOnFetch: true })
  check('P6j 传输异常 → transient exec + 固定分类',
    out.error === 'exec' && out.transient === true && !/ECONNREFUSED/.test(out.message || ''), out.message)
}
{
  const controller = new AbortController()
  controller.abort()
  const { out, calls } = await run({ options: { signal: controller.signal } })
  check('P6k 已取消 → error=cancelled 且零请求',
    out.error === 'cancelled' && calls.length === 0, { err: out.error, calls })
}
{
  const { out, calls } = await run({ options: { remaining: () => 0 } })
  check('P6l 预算耗尽 → 零请求的可辨结果',
    out.error === 'exec' && out.transient === true && calls.length === 0, { err: out.error, calls })
}

// ===========================================================================
// P7 — 账号元数据：零凭据 / 零网络
// ===========================================================================
{
  let fetchCalls = 0
  let credentialCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { fetchCalls++; throw new Error('must not fetch') }
  const ctx = {
    get(name) {
      if (name === 'credentials') { credentialCalls++; return { resolve: async () => ({ value: 'x' }) } }
      if (name === 'configEditor') { credentialCalls++; return { configuration: () => [] } }
      return undefined
    },
  }
  let out
  try {
    out = await listWorkbuddyAccounts(ctx)
  } finally {
    globalThis.fetch = originalFetch
  }
  check('P7a 账号元数据零网络请求', fetchCalls === 0, fetchCalls)
  check('P7b 账号元数据零凭据/配置访问', credentialCalls === 0, credentialCalls)
  check('P7c 明确标注不支持并给出原因',
    out.supported === false && out.accounts.length === 0 && /\/v1\/credits/.test(String(out.message || '')), out)
}

// ===========================================================================
// P8 — Host 身份与 UI 文案（源码契约）
// ===========================================================================
{
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const plans = readFileSync(new URL('../plans/workbuddy.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  check('P8a Host 身份用 /v1/credits 且表达 cn 范围',
    /providerSourceFingerprint\(ctx, 'workbuddy', GATEWAY_CREDITS_PATH\)/.test(host)
    && /parts\.push\('scope=' \+ 'cn'\)/.test(host))
  check('P8b Host 身份不再拼账号筛选', !/parts\.push\('acct='/.test(host))
  check('P8c 旧账号字段仍保留在 schema（不清除、不迁移）',
    /workbuddyAccounts: z\.string\(\)\.default\('\[\]'\)/.test(plans))
  check('P8d 设置页不再拉账号列表', client.indexOf("fetch('/api/plan-usage/workbuddy-accounts'") === -1)
  check('P8e 设置页说明客户端接口与仅 cn、且不支持按账号筛选',
    client.indexOf('客户端接口') !== -1
    && client.indexOf('只统计国内（cn）') !== -1
    && client.indexOf('暂不支持按账号筛选') !== -1)
  check('P8f 客户端不再渲染账号勾选框',
    client.indexOf("'data-workbuddy-account'") === -1)
}

// ===========================================================================
// P9 — 父审新增边界（r1）
// ① 停用账号不得作为"可用余额"出现在明细；② 合计溢出必须固定失败
// ===========================================================================
{
  const { out } = await run({
    body: body([
      acc({ credits: 100, credits_earliest_remaining: 0 }),
      acc({ credits: 50, disabled: true }),
    ]),
  })
  check('P9a 停用账号不出现在可用明细里（且仍不计入合计）',
    out.error === undefined && out.creditsTotal === 100
    && Array.isArray(out.creditsAccounts) && out.creditsAccounts.length === 1
    && out.creditsAccounts.every((r) => r.remain !== 50), out.creditsAccounts)
}
{
  const r = creditsFromClientCredits(body([
    acc({ credits: Number.MAX_VALUE }),
    acc({ credits: Number.MAX_VALUE }),
  ]), 'cn')
  check('P9b 两个有限 MAX_VALUE 相加溢出 → bad-total（不返回 Infinity）',
    r.ok === false && r.reason === 'bad-total', r)
}
{
  const { out } = await run({
    body: body([acc({ credits: Number.MAX_VALUE }), acc({ credits: Number.MAX_VALUE })]),
  })
  check('P9c 溢出时端到端固定失败、不产出 creditsTotal',
    out.error === 'exec' && out.creditsTotal === undefined
    && !/Infinity/.test(String(out.message || '')), { err: out.error, total: out.creditsTotal, msg: out.message })
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
