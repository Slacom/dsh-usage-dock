/**
 * [R2 代次] Codex 额度采集代次（`codexGeneration` / `codexGenerationOrder`）的客户端语义。
 *
 * 背景（R2 / P1）：Host 给 Codex 额度条目附「与本批采集票据匹配」的脱敏代次；客户端只要发现
 * 代次**变了**，就必须立刻作废上一个账户的显示、缓存回退与**迟到响应**。用户可见的症状是：
 * 切到账户 B 后，B 的第一次取数失败，界面却先闪一下 A 的余额；或切走 A 之后，一个迟到的 A
 * 响应把 B 的行整行覆盖。
 *
 * 本套件跑**真实的 client.js**（tools/mock-react.mjs 的极简 React 运行时 + 真胶囊组件），
 * 假 Host 响应全部是合成 wire：**不联网、不读配置、不碰凭据、不起服务**。
 *
 * 组：
 *   G1–G9 一个客户端实例的完整序列：A 成功(order 0) → B 失败(order 1) → 迟到 A(order 0)
 *         → B 成功(order 1) → B 短期失败(order 1) → 更新代次(order 2) → 迟到 A → 老 Host 兼容
 *   G10    代次字段**不参与渲染**（不进 DOM 文本、不进属性）
 *   G11    模块级水位跨 effect 重建保留：重挂后迟到 A 仍然被忽略
 *   H      Host 半（真实 `apply()` + 假凭据 / 假 fetch，全离线）：`/api/plan-usage` 在 Codex
 *          条目上附代次，且 `codexGenerationOrder` = **采集票据的 epoch**（不是每次轮询都变的 seq）；
 *          切换账户推进 epoch 后 order 增大、generation 改变
 *
 * 用法：node tools/test-codex-account-generation.mjs
 *      DSH_CLIENT_UNDER_TEST=<stage/client.js> node tools/test-codex-account-generation.mjs
 *      DSH_INDEX_UNDER_TEST=<stage/index.js> node tools/test-codex-account-generation.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const hostModule = await import(process.env.DSH_INDEX_UNDER_TEST
  ? pathToFileURL(resolve(process.env.DSH_INDEX_UNDER_TEST)).href
  : '../index.js')
import { PLANS } from '../plans/index.js'
import { CODEX_ACCOUNT_RECORD_KEY } from '../plans/codex-account.js'

let pass = 0
let fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else {
    fail++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 700)))
  }
}

const WIDE = { configForm: null, wide: true }

/** 收集子树里的**字符串元素**（含无 hooks 的函数组件，如峰谷条）。 */
function elementsOf (runtime, node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 8) return out
  if (Array.isArray(node)) { for (const n of node) elementsOf(runtime, n, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'string') {
    out.push(node)
    elementsOf(runtime, node.props ? node.props.children : undefined, out, depth + 1)
  } else if (typeof node.type === 'function') {
    try { elementsOf(runtime, runtime.renderIsolated(node.type, node.props), out, depth + 1) } catch (err) { /* hooks 组件跳过 */ }
  }
  return out
}

function textAll (runtime, tree) {
  return elementsOf(runtime, tree).map((el) => textOf(el)).join('')
}

/** 收集元素上的字符串/数字属性值（跳过 children/ref 的父子环）。 */
function attrTexts (runtime, tree) {
  const out = []
  for (const el of elementsOf(runtime, tree)) {
    const props = el.props || {}
    for (const key of Object.keys(props)) {
      if (key === 'children' || key === 'ref' || key === 'parentElement') continue
      const v = props[key]
      if (typeof v === 'string' || typeof v === 'number') out.push(String(v))
    }
  }
  return out
}

/** 胶囊数值的弱化（stale）标记：`var(--dsw-alias-label-tertiary)`。 */
const TERTIARY = 'var(--dsw-alias-label-tertiary)'
function hasTertiary (runtime, tree) {
  return elementsOf(runtime, tree).some((el) => el.props && el.props.style
    && el.props.style.color === TERTIARY)
}

// ---------------------------------------------------------------------------
// 合成 wire
// ---------------------------------------------------------------------------
const DEEPSEEK = {
  id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10,
}
/** 代次字符串刻意用两段不可能是百分比/账号的十六进制，方便断言「不渲染」。 */
const GEN_A = 'a1b2c3d4e5f60718'
const GEN_B = 'b8c9d0e1f2a30415'
const GEN_C = 'c3d4e5f607182930'

function codexOk (order, generation, rolling, weekly) {
  return {
    id: 'codex',
    name: 'OpenAI Codex',
    codexSource: 'account',
    codexGeneration: generation,
    codexGenerationOrder: order,
    rollingUsage: { status: null, percent: rolling, resetsAt: null, resetInSec: null },
    weeklyUsage: { status: null, percent: weekly, resetsAt: null, resetInSec: null },
  }
}
/** 暂时失败 + `pending`（新代次的第一次失败：没有可用基线，直接显示失败/等待）。 */
function codexPending (order, generation) {
  return {
    id: 'codex',
    name: 'OpenAI Codex',
    codexSource: 'account',
    codexGeneration: generation,
    codexGenerationOrder: order,
    error: 'curl',
    message: '网络暂时不可用',
    transient: true,
    effectiveStatus: 'pending',
  }
}
/** 暂时失败 + `cached` 但**不带数值**：客户端应回退到本代次自己的成功值。 */
function codexCachedNoValue (order, generation) {
  return {
    id: 'codex',
    name: 'OpenAI Codex',
    codexSource: 'account',
    codexGeneration: generation,
    codexGenerationOrder: order,
    error: 'curl',
    message: '网络暂时不可用',
    transient: true,
    effectiveStatus: 'cached',
  }
}
const payloadOf = (...plans) => ({ ok: true, data: { plans } })
const responseOf = (body) => ({ status: 200, json: async () => body })

/**
 * 一个「客户端 + 胶囊」夹具：`respond(index)` 返回本轮 `/api/plan-usage` 的合成响应。
 * `refresh()` = 模拟窗口 focus 强刷（作废在途请求后立即重拉）。
 */
function openCapsule (respond) {
  const runtime = createRuntime()
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  let index = 0
  let current = respond
  const calls = []
  globalThis.fetch = async (url) => {
    if (String(url).includes('custom-status')) {
      return responseOf({ ok: true, data: { keys: {}, refs: {}, providers: [] } })
    }
    calls.push({ url: String(url) })
    const body = await current(index + 1)
    index += 1
    return responseOf(body)
  }
  runtime.mount(client.Badge, WIDE)
  return {
    runtime,
    client,
    calls,
    setRespond: (next) => { current = next },
    order: () => client.module.codexGeneration.order(),
    refresh: async () => {
      client.windowEvents.dispatch('focus')
      await new Promise((resolve) => setTimeout(resolve, 30))
      return runtime.settle(WIDE)
    },
    settle: () => runtime.settle(WIDE),
    text: (tree) => textAll(runtime, tree),
    attrs: (tree) => attrTexts(runtime, tree),
    tertiary: (tree) => hasTertiary(runtime, tree),
    restore: () => {
      try { runtime.mount(function EmptyAfterRestore () { return null }, {}) } catch (err) { /* 夹具噪声 */ }
      client.restore()
    },
  }
}

// ===========================================================================
// G1–G9：一个客户端实例的完整序列
// ===========================================================================
{
  const ctx = openCapsule((index) => {
    // 由 setRespond 覆盖；默认先给 A 的成功值。
    return index === 1 ? payloadOf(DEEPSEEK, codexOk(0, GEN_A, 33, 72)) : payloadOf(DEEPSEEK)
  })
  let tree = await ctx.settle()
  const text1 = ctx.text(tree)
  check('G1a 代次 order 0 成功：显示 A 的 33% / 72%',
    text1.indexOf('33%') !== -1 && text1.indexOf('72%') !== -1, text1)
  check('G1b 首轮接受后水位 = 0', ctx.order() === 0, ctx.order())

  // B（order 1）第一次取数就失败：这是换账户后最常见的时序。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexPending(1, GEN_B)))
  tree = await ctx.refresh()
  const text2 = ctx.text(tree)
  check('G2a 换代(order 1)后 B 首次失败：A 的余额**不再显示**（不回退旧代次缓存）',
    text2.indexOf('33%') === -1 && text2.indexOf('72%') === -1, text2)
  check('G2b B 显示失败/等待，而不是 A 的旧值', text2.indexOf('获取失败') !== -1, text2)
  check('G2c 水位推进到 1', ctx.order() === 1, ctx.order())

  // 迟到的 A 成功响应（order 0）绝不能把 B 的行覆盖回 A。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(0, GEN_A, 33, 72)))
  tree = await ctx.refresh()
  const text3 = ctx.text(tree)
  check('G3a 迟到 A(order 0) 被忽略：不把 A 的 33% / 72% 画回来',
    text3.indexOf('33%') === -1 && text3.indexOf('72%') === -1, text3)
  check('G3b 迟到 A 被忽略后仍保留当前 B 的失败行（整行不消失、也不换成 A）',
    text3.indexOf('获取失败') !== -1, text3)
  check('G3c 迟到 A 不推进/回退水位（仍是 1）', ctx.order() === 1, ctx.order())

  // B 自己成功（order 1）。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(1, GEN_B, 5, 10)))
  tree = await ctx.refresh()
  const text4 = ctx.text(tree)
  check('G4a 同一代次(order 1) B 成功：显示 B 的 5% / 10%，失败行消失',
    text4.indexOf('5%') !== -1 && text4.indexOf('10%') !== -1 && text4.indexOf('获取失败') === -1, text4)

  // 同一代次内的短期失败：必须能灰显 **B 自己** 的缓存值，而不是被当成换代清空。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexCachedNoValue(1, GEN_B)))
  tree = await ctx.refresh()
  const text5 = ctx.text(tree)
  check('G5a 同一代次(order 1) 短期失败：灰显 B 自己的 5% / 10%（同代次不清基线）',
    text5.indexOf('5%') !== -1 && text5.indexOf('10%') !== -1 && ctx.tertiary(tree) === true,
    { text: text5, tertiary: ctx.tertiary(tree) })

  // 普通暂时失败（transient，无 Host 缓存值）：同样保留 B 自己的值。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexPending(1, GEN_B)))
  tree = await ctx.refresh()
  const text6 = ctx.text(tree)
  check('G6a 同一代次(order 1) transient 失败：仍显示 B 的 5% / 10%（未到阈值不换行）',
    text6.indexOf('5%') !== -1 && text6.indexOf('10%') !== -1, text6)

  // 更新代次（order 2）：正常推进并替换显示。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(2, GEN_C, 1, 2)))
  tree = await ctx.refresh()
  const text7 = ctx.text(tree)
  check('G7a 更新代次(order 2) 成功：正常替换为新值 1% / 2%，水位到 2',
    text7.indexOf('1%') !== -1 && text7.indexOf('2%') !== -1 && ctx.order() === 2,
    { text: text7, order: ctx.order() })

  // 再迟到一次旧的 A（order 0）。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(0, GEN_A, 33, 72)))
  tree = await ctx.refresh()
  const text8 = ctx.text(tree)
  check('G8a 再次迟到 A(order 0)：仍被忽略，保留 order 2 的 1% / 2%',
    text8.indexOf('33%') === -1 && text8.indexOf('72%') === -1
    && text8.indexOf('1%') !== -1 && text8.indexOf('2%') !== -1, text8)

  // 老 Host（不带代次字段）：行为与改造前一致（该行照常接受）。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, {
    id: 'codex',
    name: 'OpenAI Codex',
    codexSource: 'account',
    rollingUsage: { status: null, percent: 40, resetsAt: null, resetInSec: null },
    weeklyUsage: { status: null, percent: 50, resetsAt: null, resetInSec: null },
  }))
  tree = await ctx.refresh()
  const text9 = ctx.text(tree)
  check('G9 老 Host 无代次字段：按原行为接受（40% / 50%），水位不变',
    text9.indexOf('40%') !== -1 && text9.indexOf('50%') !== -1 && ctx.order() === 2,
    { text: text9, order: ctx.order() })

  // 代次字段只做内部判定：不进 DOM 文本、不进任何属性。
  const allText = ctx.text(tree)
  const allAttrs = ctx.attrs(tree)
  check('G10 代次字段不渲染（文本与属性里都没有 ' + GEN_A + ' / ' + GEN_B + ' / ' + GEN_C + '）',
    [GEN_A, GEN_B, GEN_C].every((gen) => allText.indexOf(gen) === -1
      && allAttrs.every((value) => value.indexOf(gen) === -1)),
    allAttrs.filter((value) => value.indexOf(':') === -1).slice(0, 12))

  ctx.restore()
}

// ===========================================================================
// G11：模块级水位跨 effect 重建保留（重挂后迟到 A 仍被忽略）
// ===========================================================================
{
  const ctx = openCapsule(async () => payloadOf(DEEPSEEK, codexOk(0, GEN_A, 33, 72)))
  let tree = await ctx.settle()
  check('G11a 首次挂载：A(order 0) 成功显示 33%', ctx.text(tree).indexOf('33%') !== -1, ctx.text(tree))

  // 切到 B（order 1）成功：水位推进到 1。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(1, GEN_B, 5, 10)))
  tree = await ctx.refresh()
  check('G11b 换代(order 1) 后显示 B 的 5% / 10%',
    ctx.text(tree).indexOf('5%') !== -1 && ctx.text(tree).indexOf('10%') !== -1, ctx.text(tree))

  // 重挂 = 轮询 effect 重建（配置变化 / 组件重挂的真实形态）。水位在**模块级**，
  // 因此重建后仍然记得「已经接受了代次 1」——重挂后收到的迟到 A(order 0) 必须被忽略。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(0, GEN_A, 33, 72)))
  ctx.runtime.mount(ctx.client.Badge, WIDE)
  tree = await ctx.settle()
  const textAfter = ctx.text(tree)
  check('G11c 重挂后只收到迟到的 A(order 0)：被忽略，不把 33% 画回来',
    textAfter.indexOf('33%') === -1 && textAfter.indexOf('72%') === -1, textAfter)
  check('G11d 重挂不清零水位（仍为 1）', ctx.order() === 1, ctx.order())

  // 对照：更新的代次照样能显示（不是「重挂后 Codex 永远不显示」）。
  ctx.setRespond(async () => payloadOf(DEEPSEEK, codexOk(2, GEN_C, 1, 2)))
  tree = await ctx.refresh()
  check('G11e 重挂后新代次(order 2) 仍正常显示 1% / 2%',
    ctx.text(tree).indexOf('1%') !== -1 && ctx.text(tree).indexOf('2%') !== -1, ctx.text(tree))

  ctx.restore()
}

// ===========================================================================
// H：Host 半 —— `/api/plan-usage` 在 Codex 条目上附「本批采集票据」的代次
//    真实 apply()，只把凭据服务与网络换成替身（合成记录 / 哨兵 token / 假 fetch）。
// ===========================================================================
{
  /** 合成一条**合法** ChatGPT 账号（token 是哨兵串，不是任何真实凭据）。 */
  function syntheticAccount (overrides) {
    return Object.assign({
      type: 'oauth',
      access: 'SYNTHETIC-ACCESS-NOT-REAL',
      refresh: 'SYNTHETIC-REFRESH-NOT-REAL',
      expires: Date.now() + 60 * 60 * 1000,
      accountId: 'acct-generation-0001',
      credentialId: 'cred-generation-0001',
      revision: 1,
      savedAt: new Date().toISOString(),
      planType: 'plus',
      email: 'gen-a@example.test',
    }, overrides)
  }
  /** 上游 `wham/usage` 的合成响应（形状与 tools/test-codex-account.mjs 的夹具一致）。 */
  const USAGE_BODY = {
    rate_limit: {
      primary_window: { used_percent: 33, limit_window_seconds: 18_000, reset_at: Date.now() / 1000 + 3600 },
      secondary_window: { used_percent: 72, limit_window_seconds: 604_800, reset_at: Date.now() / 1000 + 86_400 },
    },
    plan_type: 'plus',
  }

  const accountA = syntheticAccount({})
  const accountB = syntheticAccount({
    accountId: 'acct-generation-0002',
    credentialId: 'cred-generation-0002',
    revision: 1,
    email: 'gen-b@example.test',
  })
  const records = new Map([[
    CODEX_ACCOUNT_RECORD_KEY,
    { kind: 'grant', payload: { version: 2, activeAccountId: accountA.credentialId, accounts: [accountA, accountB] } },
  ]])
  const credentials = {
    async readRecord (key) { return records.has(key) ? records.get(key) : undefined },
    async modifyRecord (key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord (key) { records.delete(key) },
    async describeRecord () { return undefined },
  }

  const routes = {}
  const services = {
    webServer: {
      port: 12345,
      register (spec) { routes[spec.path] = spec.handler; return () => { delete routes[spec.path] } },
    },
    credentials,
  }
  const ctx = {
    get (name) { return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined },
    webServer: services.webServer,
    effect (fn) { fn(); return () => {} },
    on () {},
    off () {},
  }
  const disabledAll = Object.fromEntries(PLANS.map((plan) => [plan.fields.enabled, false]))
  const snapshot = new hostModule.Config(Object.assign({}, disabledAll, { codexEnabled: true, codexSource: 'account' }))
  let applyError = null
  try { hostModule.apply(ctx, snapshot) } catch (err) { applyError = err }
  check('H0 真实 apply() 不抛错（有凭据服务 / 有 webServer）', applyError === null,
    applyError === null ? undefined : String(applyError && applyError.message))

  const realFetch = globalThis.fetch
  const fetchCalls = []
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    return { status: 200, text: async () => JSON.stringify(USAGE_BODY) }
  }

  /** 调一次路由（只给 handler 需要的 req/res 形状；`query` 走 `req.url`，与真实请求一致）。 */
  const call = async (path, method, query) => {
    const handler = routes[path]
    const seen = { status: null, text: null }
    const url = query === undefined ? path : path + '?' + query
    await handler({ method: method || 'GET', url }, { writeHead (status) { seen.status = status }, end (text) { seen.text = text } })
    let body = null
    try { body = JSON.parse(seen.text) } catch (err) { body = null }
    return { status: seen.status, body, text: seen.text }
  }
  const codexPlanOf = (result) => {
    const plans = result && result.body && result.body.data ? result.body.data.plans : null
    return Array.isArray(plans) ? plans.find((plan) => plan && plan.id === 'codex') : undefined
  }
  const HEX16 = /^[0-9a-f]{16}$/

  // 让 apply 的 fire-and-forget 身份快照刷新落定（否则首轮与次轮之间会「身份刚到」而推进 epoch）。
  await new Promise((done) => setTimeout(done, 30))

  const first = await call('/api/plan-usage')
  const plan1 = codexPlanOf(first)
  check('H1 Codex 条目带上本批票据的代次（generation = 16 位小写十六进制 / order = 非负整数）',
    plan1 !== undefined && typeof plan1.codexGeneration === 'string' && HEX16.test(plan1.codexGeneration)
    && Number.isSafeInteger(plan1.codexGenerationOrder) && plan1.codexGenerationOrder >= 0,
    plan1 === undefined ? first.text && first.text.slice(0, 300) : {
      generation: plan1.codexGeneration, order: plan1.codexGenerationOrder,
    })
  check('H2 代次不是账号 id / 不是明文身份（不含 acct-* / cred-* / 邮箱）',
    plan1 !== undefined && String(plan1.codexGeneration).indexOf('acct-generation') === -1
    && String(plan1.codexGeneration).indexOf('cred-generation') === -1
    && String(plan1.codexGeneration).indexOf('example.test') === -1)

  const second = await call('/api/plan-usage')
  const plan2 = codexPlanOf(second)
  check('H3 同一账户连续两轮轮询：order 与 generation 都**不变**（用 epoch，不是每轮都变的 seq）',
    plan2 !== undefined && plan2.codexGenerationOrder === plan1.codexGenerationOrder
    && plan2.codexGeneration === plan1.codexGeneration,
    { first: { g: plan1 && plan1.codexGeneration, o: plan1 && plan1.codexGenerationOrder },
      second: { g: plan2 && plan2.codexGeneration, o: plan2 && plan2.codexGenerationOrder } })

  // 切到账户 B（真实 select 路由：推进 epoch + 作废 codex 观察）。
  const selectB = await call('/api/plan-usage/codex-account/select', 'POST',
    'id=' + encodeURIComponent(accountB.credentialId))
  check('H4 切换账户成功（真实 select 路由：{ok:true} + active 变 B）',
    selectB.body !== null && selectB.body.ok === true
    && selectB.body.data && selectB.body.data.activeAccountId === accountB.credentialId, selectB.body)

  const third = await call('/api/plan-usage')
  const plan3 = codexPlanOf(third)
  check('H5 换代后 order 增大、generation 改变（客户端据此作废旧账户显示）',
    plan3 !== undefined && plan3.codexGenerationOrder > plan1.codexGenerationOrder
    && plan3.codexGeneration !== plan1.codexGeneration,
    { before: { g: plan1 && plan1.codexGeneration, o: plan1 && plan1.codexGenerationOrder },
      after: { g: plan3 && plan3.codexGeneration, o: plan3 && plan3.codexGenerationOrder } })

  const fourth = await call('/api/plan-usage')
  const plan4 = codexPlanOf(fourth)
  check('H6 新代次同样稳定（连续两轮 order/generation 不变，B 的短期失败可灰显缓存）',
    plan4 !== undefined && plan4.codexGenerationOrder === plan3.codexGenerationOrder
    && plan4.codexGeneration === plan3.codexGeneration,
    { third: { g: plan3 && plan3.codexGeneration, o: plan3 && plan3.codexGenerationOrder },
      fourth: { g: plan4 && plan4.codexGeneration, o: plan4 && plan4.codexGenerationOrder } })
  check('H7 假 fetch 只打了上游额度端点（离线、无其它网络）',
    fetchCalls.length > 0 && fetchCalls.every((url) => url.indexOf('https://') === 0),
    fetchCalls.slice(0, 4))

  globalThis.fetch = realFetch
}

console.log('')
console.log((pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
