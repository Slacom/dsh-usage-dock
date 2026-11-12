/**
 * [2026-10-30 incident] WorkBuddy「获取失败 / 设置页无可用账号」——按账号 uid 筛选的旧逻辑回归。
 *
 * 权威记录：docs/incident-20261030-workbuddy-account-filter.md §6（修复范围）与 §7（验收标准）。
 *
 * 这个文件只做**该事故要求的最小证明**，全部沿真实函数走：
 *   R1 真实形状 fixture（`accounts[]` **没有 uid**）+ 非空旧 `workbuddyAccounts`
 *      → 真实 `apply()` 注册的 `/api/plan-usage` 仍能解析出 cn 合计（不再 no-account）；
 *   R2 旧字段原值保留：取数后 `cfg.workbuddyAccounts` 不变（不迁移、不清空）；
 *   R3 真实 `/api/plan-usage/workbuddy-accounts`：`supported:false` + 解释文案、GET-only、
 *      零网关请求、零凭据解析；不把空列表报成「未配置」；
 *   R4 三类失败文案可区分：网关 502 / 200 无 cn 账号 / 200 有 cn 但 credits 非法；
 *   R5 超时与 HTTP 502 也要可区分（不能共用一句话）；
 *   R6 真实 client.js 设置页：无账号选择控件、有「不支持筛选」说明、
 *      不再出现「没有可用账号（或网关未配置/未启动）」，也不再请求账号列表；
 *   R7 旧选择非空时设置页只给「已保留但不再生效」说明，仍无选择器。
 *
 * 全部离线：夹具是**完全合成**的假账号/假积分（SYNTH-/DUMMY-），不含真实 uid、昵称、
 * 积分或任何凭据；不请求真实网关，不读 profile / 环境凭据。
 *
 * 用法：node tools/test-workbuddy-legacy-selection.mjs
 */
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { fetchFromGateway } from '../plans/workbuddy.js'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ===========================================================================
// 合成夹具：字段名与真实合约一致（2026-10-30 实测的结构），值全部是假值。
// 关键点：**没有 uid / id**，根上有跨区 `total_credits`，每账号有累计 `credits_total`。
// ===========================================================================
const LEGACY_SELECTION = '["SYNTH-LEGACY-UID-1","SYNTH-LEGACY-UID-2"]'
const CN_CREDITS = 123
const GLOBAL_CREDITS = 4567
const CROSS_REALM_TOTAL = 987654
const CREDITS_TOTAL_DECOY = 55555
const PROVIDER_KEY_REF = 'WB_SYNTH_KEY'
const PROVIDER_KEY_VALUE = 'synthetic-gateway-key'

function gwAccount(over) {
  return Object.assign({
    nickname: 'SYNTH-ACCOUNT',
    realm: 'cn',
    credits: CN_CREDITS,
    credits_total: CREDITS_TOTAL_DECOY,
    credits_expiring: 8,
    credits_earliest_expiry: '2031-05-06T07:08:09+08:00',
    credits_earliest_remaining: 11,
    cooling: false,
    disabled: false,
    token_usage: { window: 0 },
    tokens: { input: 1, output: 2 },
  }, over || {})
}
/** 真实形状：两条账号（cn 可用 / global 停用），都**没有 uid**。 */
function gwBody(accounts) {
  return {
    ok: true,
    time: 'SYNTH-TIME',
    request_id: 'DUMMY-REQUEST-ID',
    total_credits: CROSS_REALM_TOTAL,
    total: CROSS_REALM_TOTAL,
    healthy: true,
    cooling: false,
    disabled: false,
    accounts: accounts === undefined
      ? [gwAccount({ realm: 'cn', credits: CN_CREDITS }), gwAccount({ realm: 'global', credits: GLOBAL_CREDITS, disabled: true })]
      : accounts,
  }
}

const CATALOG = [{
  provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'workbuddy'], defaultBaseURL: '',
}]
const PROVIDER_OVERRIDE = {
  workbuddy: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: PROVIDER_KEY_REF },
}

const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))

/**
 * 真实 `apply()` + 最小宿主 ctx（只桩 credentials / configEditor / llm / fetch）。
 * `respond` 决定网关返回什么（合成）。
 */
function boot(planOverride, respond) {
  const routes = {}
  const credentialRefs = []
  const requests = []
  const credentials = {
    refs: credentialRefs,
    async resolve(ref) {
      credentialRefs.push(ref)
      return { value: ref === PROVIDER_KEY_REF ? PROVIDER_KEY_VALUE : '' }
    },
  }
  const configEditor = {
    configuration() {
      return [
        { entry: { options: { id: 'plan-usage' } }, override: Object.assign({}, planOverride), inherited: {} },
        { entry: { options: { id: 'llm-pi-ai' } }, override: { providers: PROVIDER_OVERRIDE }, inherited: {} },
      ]
    },
  }
  const services = {
    webServer: { port: 0, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    credentials,
    configEditor,
    llm: { listConfigurableProviders: () => CATALOG },
  }
  const effects = []
  const ctx = {
    webServer: services.webServer,
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on() {}, off() {}, emit() {},
    effect(fn) { const d = fn(); effects.push(d); return d },
    effects,
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      auth: init && init.headers ? init.headers.Authorization || null : null,
    })
    return respond(String(url))
  }
  const config = new Config(Object.assign({}, disabledAll, planOverride))
  try {
    apply(ctx, config)
  } finally {
    globalThis.fetch = realFetch
  }
  return {
    routes, config, requests, credentialRefs,
    dispose() { for (const fn of effects.reverse()) { if (typeof fn === 'function') fn() } },
  }
}

function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) { out.status = status },
    end(text) { out.body = String(text) },
  }
}
async function callRoute(handler, method) {
  const res = fakeRes()
  await handler({ method, headers: {}, url: '/api/plan-usage' }, res)
  let json = null
  try { json = JSON.parse(res.out.body) } catch (err) { json = null }
  return { status: res.out.status, json }
}

/** 在一次请求里把网关 fetch 换成指定实现（路由内部的取数才会触发它）。 */
async function withFetch(impl, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = realFetch }
}

const okRespond = () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(gwBody()),
})

/**
 * 真实 Config 的 volatile 字段在无 configEditor 部署里是 `{get()}` 包装（见 AGENTS §5 第 4/7 条），
 * 断言「旧字段原值保留」必须按 Host 同样的解包方式读，不能直接读包装对象。
 */
function unwrapped(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

// ===========================================================================
// R1 — 真实形状无 uid + 非空旧 workbuddyAccounts：真实路由仍解析出 cn 合计
//      （0.9.0 的故障就是这个组合：旧 uid 把全部账号过滤掉 → no-account）
// ===========================================================================
{
  const booted = boot({ enabled: true, workbuddyEnabled: true, workbuddyAccounts: LEGACY_SELECTION }, okRespond)
  check('R1a 真实 apply 注册了 /api/plan-usage', typeof booted.routes['/api/plan-usage'] === 'function')
  const result = await withFetch(async (url, init) => {
    booted.requests.push({ url: String(url), auth: init && init.headers ? init.headers.Authorization || null : null })
    return okRespond()
  }, () => callRoute(booted.routes['/api/plan-usage'], 'GET'))
  const plans = result.json && result.json.data ? result.json.data.plans : null
  const wb = Array.isArray(plans) ? plans.filter((p) => p && p.id === 'workbuddy')[0] : undefined
  check('R1b 路由返回 WorkBuddy 条目', wb !== undefined, result.json)
  check('R1c 不再因 uid 缺失报错（无 error/no-account）',
    wb !== undefined && wb.error === undefined && !/no-account/.test(String(wb.message || '')), wb)
  check('R1d 合计 = cn 账号剩余（不含 global、不用跨区 total_credits、不用 credits_total）',
    wb !== undefined && wb.creditsTotal === CN_CREDITS, { got: wb && wb.creditsTotal, want: CN_CREDITS })
  check('R1e 只请求 /v1/credits（不探 /status、/panel、不按 uid 过滤）',
    booted.requests.length === 1
    && /\/v1\/credits$/.test(booted.requests[0].url)
    && booted.requests.every((r) => !/\/status|\/panel\//.test(r.url)), booted.requests.map((r) => r.url))
  check('R1f 复用来源 Bearer Key',
    booted.requests.length === 1 && booted.requests[0].auth === 'Bearer ' + PROVIDER_KEY_VALUE,
    booted.requests[0] && booted.requests[0].auth)
  // ---------------------------------------------------------------------
  // R2 — 旧字段原值保留：不清空、不迁移（本次取数后仍是旧 uid 串）
  // ---------------------------------------------------------------------
  check('R2a 旧 workbuddyAccounts 原值保留（不迁移、不清空）',
    unwrapped(booted.config.workbuddyAccounts) === LEGACY_SELECTION,
    unwrapped(booted.config.workbuddyAccounts))
  const retry = await withFetch(async () => okRespond(), () => callRoute(booted.routes['/api/plan-usage'], 'GET'))
  const wbRetry = retry.json.data.plans.filter((p) => p && p.id === 'workbuddy')[0]
  check('R2b 旧值未清空时第二次取数仍正常（无需手工清字段）',
    wbRetry !== undefined && wbRetry.error === undefined && wbRetry.creditsTotal === CN_CREDITS, wbRetry)
  booted.dispose()
}

// ===========================================================================
// R3 — 兼容路由：明确 supported:false + 解释，零 I/O，不把空列表报成「未配置」
// ===========================================================================
{
  const booted = boot({ enabled: true, workbuddyEnabled: true, workbuddyAccounts: LEGACY_SELECTION }, okRespond)
  const path = '/api/plan-usage/workbuddy-accounts'
  check('R3a 兼容路由仍注册（旧前端不 404）', typeof booted.routes[path] === 'function')
  const before = booted.requests.length
  const refsBefore = booted.credentialRefs.length
  const got = await withFetch(async () => { throw new Error('账号路由不得请求网关') },
    () => callRoute(booted.routes[path], 'GET'))
  check('R3b GET → ok:true 且 data.supported === false',
    got.status === 200 && got.json.ok === true && got.json.data.supported === false, got.json)
  check('R3c accounts 为空数组且有解释文案（不冒充「已取到但为空」）',
    Array.isArray(got.json.data.accounts) && got.json.data.accounts.length === 0
    && /不提供稳定账号 ID|暂不支持按账号筛选/.test(String(got.json.data.message || '')), got.json.data)
  check('R3d 文案不把空列表说成「未配置/未启动/不可用」',
    !/未配置|未启动|不可用|失败/.test(String(got.json.data.message || '')), got.json.data.message)
  check('R3e 账号路由零网关请求、零凭据解析',
    booted.requests.length === before && booted.credentialRefs.length === refsBefore,
    { requests: booted.requests.length - before, refs: booted.credentialRefs.length - refsBefore })
  const post = await callRoute(booted.routes[path], 'POST')
  check('R3f 非 GET → 405', post.status === 405 && post.json.ok === false, post)
  booted.dispose()
}

// ===========================================================================
// R4 / R5 — 三类失败 + 超时：文案必须互相可区分
// ===========================================================================
const PLAN_STUB = { id: 'workbuddy', name: 'WorkBuddy' }
const gwCtx = {
  get(name) {
    if (name === 'llm') return { listConfigurableProviders: () => CATALOG }
    if (name === 'configEditor') {
      return {
        configuration: () => [{
          entry: { options: { id: 'llm-pi-ai' } },
          override: { providers: PROVIDER_OVERRIDE }, inherited: {},
        }],
      }
    }
    if (name === 'credentials') return { resolve: async () => ({ value: PROVIDER_KEY_VALUE }) }
    return undefined
  },
}
async function fetchWire(impl) {
  return withFetch(impl, () => fetchFromGateway(gwCtx, PLAN_STUB, {}, {}))
}
const respond502 = async () => ({ ok: false, status: 502, text: async () => '' })
const respondNoCn = async () => ({
  ok: true, status: 200, text: async () => JSON.stringify(gwBody([gwAccount({ realm: 'global', credits: GLOBAL_CREDITS })])),
})
const respondBadCredits = async () => ({
  ok: true, status: 200, text: async () => JSON.stringify(gwBody([gwAccount({ realm: 'cn', credits: 'not-a-number' })])),
})
{
  const out502 = await fetchWire(respond502)
  const outNoCn = await fetchWire(respondNoCn)
  const outBad = await fetchWire(respondBadCredits)
  check('R4a 502 → exec + transient（暂时失败，不当语义错误）',
    out502.error === 'exec' && out502.transient === true, out502)
  check('R4b 502 文案点明 HTTP 502 且不再说「没有可用账号/状态字段」',
    /502/.test(String(out502.message || '')) && /请求失败/.test(String(out502.message || ''))
    && !/没有可用账号|没有可用的积分字段/.test(String(out502.message || '')), out502.message)
  check('R4c 200 无 cn 账号 → 单独分类（点明 cn）',
    outNoCn.error === 'exec' && /国内（cn）账号/.test(String(outNoCn.message || '')), outNoCn.message)
  check('R4d 200 有 cn 但 credits 非法 → 单独分类（数值不可用）',
    outBad.error === 'exec' && /数值缺失或非法/.test(String(outBad.message || '')), outBad.message)
  const messages = [out502.message, outNoCn.message, outBad.message]
  check('R4e 三者文案两两不同（不再共用一句兜底）',
    new Set(messages).size === 3, messages)
  check('R4f 三者都不回显上游正文/原值',
    messages.every((m) => !/not-a-number|SYNTH-|synthetic/.test(String(m || ''))), messages)
}
{
  // 超时：用 remaining() 把单请求超时压到 250ms，fetch 永不返回（不引入真实等待）。
  const never = () => new Promise(() => {})
  const withBudget = await withFetch(never, () => fetchFromGateway(gwCtx, PLAN_STUB, {}, { remaining: () => 300 }))
  check('R5a 超时 → 固定分类（不透传异常原文）',
    withBudget.error === 'exec' && !/ECONNREFUSED|aborted/.test(String(withBudget.message || '')), withBudget)
  const out502 = await fetchWire(respond502)
  check('R5b 超时 → 文案含 timeout',
    /timeout/.test(String(withBudget.message || '')), withBudget.message)
  check('R5c 超时与 HTTP 502 文案不同（可区分）',
    String(withBudget.message || '') !== String(out502.message || '')
    && /请求失败/.test(String(withBudget.message || '')), { timeout: withBudget.message, http: out502.message })
}

// ===========================================================================
// R6 / R7 — 真实 client.js 设置页：无账号选择器、有解释、不误导
// ===========================================================================
function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 16) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try { elementsOf(node.type(node.props), out, depth + 1) } catch (err) { /* hooks 组件跳过 */ }
    }
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) elementsOf(node.props.children, out, depth + 1)
  return out
}

async function renderSettings(legacySelection) {
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
  })
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    if (String(url).includes('custom-status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { keys: {}, refs: [], providers: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { plans: [], cfg: {} } }) }
  }
  const form = {
    value: {
      enabled: true,
      workbuddyEnabled: true,
      planOrder: '[]',
      workbuddyAccounts: legacySelection,
      customBalances: [],
    },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(field, value) {
      this.value = Object.assign({}, this.value, { [field]: value })
      return Promise.resolve(true)
    },
    mutate() { return Promise.resolve(true) },
  }
  runtime.mount(client.SettingsPage, { form })
  await sleep(60)
  const tree = await runtime.settle({ form })
  return { tree, fetched }
}

{
  const { tree, fetched } = await renderSettings('[]')
  const text = textOf(tree)
  const els = elementsOf(tree)
  const card = els.filter((el) => el.props && el.props['data-plan-card'] === 'workbuddy')[0]
  check('R6a 设置页渲染出 WorkBuddy 卡片', card !== undefined)
  check('R6b 页面出现「不支持按账号筛选」的说明',
    /暂不支持按账号筛选/.test(text), text.slice(0, 200))
  check('R6c 不再出现误导性的「没有可用账号（或网关未配置/未启动）」',
    !/没有可用账号/.test(text) && !/网关未配置/.test(text) && !/网关未启动/.test(text), text.slice(0, 400))
  check('R6d 没有账号选择控件（data-workbuddy-account 标记不存在）',
    els.every((el) => el.props === undefined || el.props['data-workbuddy-account'] === undefined))
  const cardCheckboxes = card === undefined ? [] : elementsOf(card).filter((el) => el.type === 'input' && el.props && el.props.type === 'checkbox')
  check('R6e 卡片里只剩「启用」一个勾选框（没有账号勾选）',
    card !== undefined && cardCheckboxes.length === 1, cardCheckboxes.length)
  check('R6f 卡片里没有 select 下拉（旧账号下拉已移除）',
    card === undefined ? false : elementsOf(card).every((el) => el.type !== 'select'))
  check('R6g 设置页不再请求 /api/plan-usage/workbuddy-accounts',
    fetched.every((u) => !u.includes('workbuddy-accounts')), fetched)
}
{
  const { tree } = await renderSettings(LEGACY_SELECTION)
  const text = textOf(tree)
  const els = elementsOf(tree)
  check('R7a 旧选择仍在时明确说明「已原样保留但不再生效」',
    /已原样保留但不再生效/.test(text) && /2 个账号选择/.test(text), text.slice(0, 400))
  check('R7b 旧选择仍在时也没有账号选择器',
    els.every((el) => el.props === undefined || el.props['data-workbuddy-account'] === undefined))
  check('R7c 旧选择仍在时仍不出现「没有可用账号」',
    !/没有可用账号/.test(text), text.slice(0, 400))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
