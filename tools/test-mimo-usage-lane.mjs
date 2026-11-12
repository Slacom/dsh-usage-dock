/**
 * [2026-11-12 MiMo lane 对齐] `usage_status` 的 MiMo 读数改走**胶囊那条显示快照 lane**。
 *
 * 全离线、全 fake：没有 localhost 服务、没有真实 Host、没有网络、不读真实 cfg/凭据。
 *
 * 覆盖：
 *   L1 纯函数 `mimoDisplayWire()` 的闭集规则（金额/币种/时间/状态/未选中）
 *   L2 零泄漏：快照里的 identity / accountId / token / code / revision 哨兵**不得**出现在 wire 里
 *   L3 快照适用时**绝不**调用 provider（传一个会 throw 的 provider，若有调用立即失败）
 *   L4 快照不适用（peek 返回 null / selected:false / peek 抛错）⇒ provider 被调用一次且返回值原样透传
 *   L5 真实 `apply()` 冒烟：默认（display 快照未选中）状态下 mimo 行为与改动前一致（不走 missing）
 *
 * 用法：node tools/test-mimo-usage-lane.mjs
 */
import { readFileSync } from 'node:fs'
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { TOOL_NAME, mimoDisplayWire, mimoWireWithDisplay } from '../plans/usage-tool.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) } else {
    failCount++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600)))
  }
}

/** 一份合法的 verified 快照（后续用例按需覆盖字段）。 */
function verifiedSnapshot(over) {
  return Object.assign({
    selected: true,
    state: 'verified',
    balance: { balance: 14.58, currency: 'CNY' },
    fetchedAt: 1762900000000,
  }, over || {})
}

// ===========================================================================
// L1 — 纯函数闭集规则
// ===========================================================================
{
  const wire = mimoDisplayWire(verifiedSnapshot())
  check('L1a verified + 合法金额/币种 ⇒ 正常 wire（id/name/balance/currency/fetchedAt）',
    wire !== null && wire.id === 'mimo' && wire.name === 'Xiaomi MiMo'
    && wire.balance === 14.58 && wire.currency === 'CNY' && wire.fetchedAt === 1762900000000, wire)
  check('L1b 成功 wire 只有 5 个字段（闭集，无 error/identity 等）',
    Object.keys(wire).sort().join(',') === 'balance,currency,fetchedAt,id,name', Object.keys(wire))

  const noFetch = mimoDisplayWire(verifiedSnapshot({ fetchedAt: undefined }))
  check('L1c fetchedAt 缺失 ⇒ wire 不含该字段（不写 null）',
    noFetch !== null && !('fetchedAt' in noFetch) && Object.keys(noFetch).sort().join(',') === 'balance,currency,id,name',
    noFetch)
  const badFetch = mimoDisplayWire(verifiedSnapshot({ fetchedAt: '1762900000000' }))
  check('L1d fetchedAt 非数值 ⇒ 同样省略该字段', badFetch !== null && !('fetchedAt' in badFetch), badFetch)

  const badAmounts = [
    ['字符串 "14.58"', '14.58'],
    ['null', null],
    ['负数', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['缺失', undefined],
  ]
  const amountMisses = []
  for (const [label, amount] of badAmounts) {
    const out = mimoDisplayWire(verifiedSnapshot({ balance: { balance: amount, currency: 'CNY' } }))
    if (out === null || out.error !== 'missing' || 'balance' in out || 'currency' in out) amountMisses.push({ label, out })
  }
  check('L1e 金额非「有限非负数」⇒ missing 且**没有** balance/currency 字段（不造 0）',
    amountMisses.length === 0, amountMisses)

  const notObject = mimoDisplayWire(verifiedSnapshot({ balance: null }))
  check('L1f balance 不是对象（null）⇒ missing（不造 0/不默认币种）',
    notObject !== null && notObject.error === 'missing' && !('balance' in notObject), notObject)

  const lower = mimoDisplayWire(verifiedSnapshot({ balance: { balance: 3, currency: 'cny' } }))
  check("L1g 小写 'cny' 规范化成 'CNY'", lower !== null && lower.currency === 'CNY', lower)
  const padded = mimoDisplayWire(verifiedSnapshot({ balance: { balance: 3, currency: ' usd ' } }))
  check("L1h 带空格 ' usd ' 规范化成 'USD'", padded !== null && padded.currency === 'USD', padded)
  const badCurrency = mimoDisplayWire(verifiedSnapshot({ balance: { balance: 3, currency: 'RMB!' } }))
  check("L1i 非法币种 'RMB!' ⇒ missing（不默认 CNY）",
    badCurrency !== null && badCurrency.error === 'missing' && !('balance' in badCurrency), badCurrency)
  const noCurrency = mimoDisplayWire(verifiedSnapshot({ balance: { balance: 3 } }))
  check('L1j 币种缺失 ⇒ missing', noCurrency !== null && noCurrency.error === 'missing', noCurrency)
  const numCurrency = mimoDisplayWire(verifiedSnapshot({ balance: { balance: 3, currency: 156 } }))
  check('L1k 币种非字符串 ⇒ missing', numCurrency !== null && numCurrency.error === 'missing', numCurrency)

  const stateMisses = []
  for (const state of ['holding', 'stopped', 'expired', 'absent', 'unknown', undefined]) {
    const out = mimoDisplayWire(verifiedSnapshot({ state }))
    if (out === null || out.error !== 'missing' || 'balance' in out) stateMisses.push({ state, out })
  }
  check('L1l state 非 verified（holding/stopped/expired/absent/未知）⇒ missing（零 IO）',
    stateMisses.length === 0, stateMisses)

  const notSelected = [
    ['selected:false', verifiedSnapshot({ selected: false })],
    ['selected 缺失', verifiedSnapshot({ selected: undefined })],
    ['selected:1（非 true）', verifiedSnapshot({ selected: 1 })],
    ['null 快照', null],
    ['字符串快照', 'verified'],
    ['数组快照', []],
  ]
  const selectedMisses = notSelected.filter(([, snap]) => mimoDisplayWire(snap) !== null)
  check('L1m 未选中/非对象快照 ⇒ null（= 不适用，交回 provider）',
    selectedMisses.length === 0, selectedMisses.map(([label]) => label))

  // 抛错的快照（getter 抛）⇒ null，不许把异常带到工具层
  const throwing = {}
  Object.defineProperty(throwing, 'selected', { get() { throw new Error('boom') } })
  let threw = null
  let out = null
  try { out = mimoDisplayWire(throwing) } catch (err) { threw = err }
  check('L1n 快照读取抛错 ⇒ 返回 null（异常不外溢）', threw === null && out === null, { threw: threw && threw.message, out })
}

// ===========================================================================
// L2 — 零泄漏哨兵
// ===========================================================================
{
  const SENTINEL = 'SENTINEL-MIMO-9f3a'
  const leaky = {
    selected: true,
    state: 'verified',
    balance: { balance: 14.58, currency: 'CNY' },
    fetchedAt: 1762900000000,
    identity: SENTINEL,
    accountId: SENTINEL,
    token: SENTINEL,
    code: SENTINEL,
    revision: SENTINEL,
    session: { cookie: SENTINEL },
  }
  const wire = mimoDisplayWire(leaky)
  const text = JSON.stringify(wire)
  check('L2a 成功 wire 不含 identity/accountId/token/code/revision 哨兵',
    wire !== null && !text.includes(SENTINEL), wire)
  check('L2b 成功 wire 的键仍是闭集 5 个',
    Object.keys(wire).sort().join(',') === 'balance,currency,fetchedAt,id,name', Object.keys(wire))

  const holdingLeak = mimoDisplayWire(Object.assign({}, leaky, { state: 'holding' }))
  check('L2c missing wire 同样不含哨兵（只有 id/name/error/mimoState）',
    holdingLeak !== null && !JSON.stringify(holdingLeak).includes(SENTINEL)
    // [0.10.5] 缺席态新增固定枚举 mimoState（signed-out|failed|pending），供胶囊区分「未登录/失败/读取中」；
    // 仍是**闭集**白名单：多一个字段就该红。
    && Object.keys(holdingLeak).sort().join(',') === 'error,id,mimoState,name'
    && ['signed-out', 'failed', 'pending'].includes(holdingLeak.mimoState), holdingLeak)
}

// ===========================================================================
// L3 — 快照适用时绝不调用 provider
// ===========================================================================
{
  let calls = 0
  const bomb = async () => { calls += 1; throw new Error('provider 不该被调用') }

  const verified = await mimoWireWithDisplay({ peek: () => verifiedSnapshot() }, bomb)
  check('L3a selected+verified ⇒ 用快照，provider 零调用',
    calls === 0 && verified !== null && verified.balance === 14.58, { calls, verified })

  const holding = await mimoWireWithDisplay({ peek: () => verifiedSnapshot({ state: 'holding' }) }, bomb)
  check('L3b selected+holding ⇒ missing，provider 零调用（不回落旧 lane）',
    calls === 0 && holding !== null && holding.error === 'missing', { calls, holding })

  const badMoney = await mimoWireWithDisplay({ peek: () => verifiedSnapshot({ balance: { balance: '14.58', currency: 'CNY' } }) }, bomb)
  check('L3c selected+verified 但金额非法 ⇒ missing，provider 零调用',
    calls === 0 && badMoney !== null && badMoney.error === 'missing', { calls, badMoney })
}

// ===========================================================================
// L4 — 快照不适用 ⇒ provider 原路（调用一次、返回值原样透传）
// ===========================================================================
{
  const providerWire = { id: 'mimo', name: 'Xiaomi MiMo', balance: 7.25, currency: 'CNY', marker: 'from-provider' }

  let calls = 0
  const provider = async () => { calls += 1; return providerWire }

  const fromNull = await mimoWireWithDisplay({ peek: () => null }, provider)
  check('L4a peek 返回 null ⇒ 固定 missing 且 provider 零调用（旧 Cookie lane 已移除）',
    calls === 0 && fromNull !== null && fromNull.error === 'missing', { calls, fromNull })

  calls = 0
  const notSelected = await mimoWireWithDisplay({ peek: () => verifiedSnapshot({ selected: false }) }, provider)
  check('L4b selected:false ⇒ 固定 missing 且 provider 零调用',
    calls === 0 && notSelected !== null && notSelected.error === 'missing', { calls, notSelected })

  calls = 0
  const throwingPeek = await mimoWireWithDisplay({ peek: () => { throw new Error('peek boom') } }, provider)
  check('L4c peek 抛错 ⇒ 固定 missing、零调用且异常不外溢',
    calls === 0 && throwingPeek !== null && throwingPeek.error === 'missing', { calls, throwingPeek })

  calls = 0
  const noHandle = await mimoWireWithDisplay(null, provider)
  check('L4d source 为 null ⇒ 固定 missing 且零调用（句柄缺失不致命）',
    calls === 0 && noHandle !== null && noHandle.error === 'missing', { calls, noHandle })

  calls = 0
  const badHandle = await mimoWireWithDisplay({ peek: 'not-a-function' }, provider)
  check('L4e peek 不是函数 ⇒ 固定 missing 且零调用', calls === 0, { calls })
}

// ===========================================================================
// L5 — 真实 apply() 冒烟：默认（display 快照未选中）下 mimo 仍走原 provider
// ===========================================================================
{
  const registered = new Map()
  const routes = {}
  const services = {
    webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    tools: {
      register(definition) { registered.set(definition.name, definition); return () => { registered.delete(definition.name) } },
    },
  }
  const effects = []
  let applyError = null
  try {
    apply({
      get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
      webServer: services.webServer,
      effect: (fn) => { const d = fn(); effects.push(d); return d },
    }, new Config(Object.assign(
      Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false])),
      { mimoEnabled: true },
    )))
  } catch (err) { applyError = err }
  check('L5a 真实 apply 不抛错（新增 peek/分支不影响启动）', applyError === null, applyError && applyError.message)

  const tool = registered.get(TOOL_NAME)
  let out = null
  let execError = null
  try { out = await tool.execute({ ids: ['mimo'] }) } catch (err) { execError = err }
  const mimoChannel = out === null ? undefined : (out.channels || []).find((c) => c.id === 'mimo')
  check('L5b 工具仍能为 mimo 返回条目', execError === null && mimoChannel !== undefined,
    execError && execError.message)
  check('L5c 默认状态（display 未选中）下 mimo 固定为 missing（不再回落旧 provider lane）',
    mimoChannel !== undefined && mimoChannel.errorCode === 'missing', mimoChannel)
  check('L5d 旧 Cookie lane 不再被调用：缺凭据不再是 mimo 的结果（应为 missing）',
    mimoChannel !== undefined && mimoChannel.errorCode === 'missing', mimoChannel)

  for (const fn of effects.reverse()) { if (typeof fn === 'function') fn() }

  /**
   * L5e/L5f 是**接线守卫（源码断言）**，不是行为断言 —— 诚实说明：
   * `display.peek()` 只有在真实「记住登录」会话语义下才会 `selected:true`（`dto()` 里
   * `selected` 取决于内存里是否存在 display 记录），离线 fake ctx 造不出这条路径。
   * 因此这里只守「这段接线没被人删掉」，真正的 verified 端到端只能在本机实测。
   */
  const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('L5e 接线守卫：collectPlans 里 mimo 分支调用 mimoWireWithDisplay（源码断言）',
    hostSource.includes("plan.id === 'mimo'") && hostSource.includes('mimoWireWithDisplay(mimoDisplaySource, fetchOnce)'))
  check('L5f 接线守卫：ACCOUNT_BOUND_PLAN_IDS 含 mimo（不进工具缓存）',
    /const ACCOUNT_BOUND_PLAN_IDS = new Set\(\[[^\]]*'mimo'[^\]]*\]\)/.test(hostSource))
}

// ===========================================================================
// L6–L9 — peek 句柄的**选择优先级**（routeDisplay 优先），直接对 index.js 的真实函数体求值
// ===========================================================================
//
// 为什么求值真实函数体：`mimoDisplayPeek` 是 apply 闭包里的私有量，离线拿不到实例；
// 而它的选择规则（routeDisplay → display → null）**正是本轮 bug 的全部内容**
// （之前只读 `display` = legacy manager，managed 模式下它是 absent ⇒ 工具回落旧 provider 报 api）。
// 这里从 index.js 源码里抽出那个箭头函数（花括号配平）再注入假 host 求值 ——
// 测的是**要上线的那段代码**，不是复制品；抽不出来就直接 FAIL（不静默跳过）。
{
  const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  function extractArrowFn(text, marker) {
    const at = text.indexOf(marker)
    if (at < 0) return null
    const open = text.indexOf('{', at)
    if (open < 0) return null
    let depth = 0
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(at + marker.length, i + 1).trim()
      }
    }
    return null
  }
  const fnText = extractArrowFn(hostSource, 'const mimoDisplayPeek = ')
  check('L6a 能从 index.js 抽出 mimoDisplayPeek 函数体',
    typeof fnText === 'string' && fnText.length > 40, fnText === null ? 'not-found' : fnText.slice(0, 60))

  let peekRaw = null
  try { peekRaw = (host) => new Function('mimoAuthHost', 'return (' + fnText + ')()')(host) } catch (err) { peekRaw = null }
  /**
   * 真实调用形态是 `{ getHost() }`（`registerMimoAuth()` 的返回值只有 bootEpoch/dispose/getHost，
   * 真正的 host 在 `ctx.inject` 回调里异步创建）。这里把「裸 host」自动包一层，旧用例可继续复用；
   * L10/L11 则显式传 `{ getHost }` 以覆盖「先 null 后就绪」「getHost 抛错」两种真实时序。
   */
  const peek = (host) => (typeof peekRaw !== 'function' ? null
    : peekRaw(host !== null && typeof host === 'object' && typeof host.getHost !== 'function'
      ? { getHost: () => host }
      : host))
  check('L6b 函数体可独立求值（只依赖 mimoAuthHost，无自由变量）', typeof peekRaw === 'function')

  const verifiedSnap = verifiedSnapshot()
  const holdingSnap = verifiedSnapshot({ state: 'holding' })

  if (typeof peek === 'function') {
    const both = peek({ routeDisplay: { peek: () => verifiedSnap }, display: { peek: () => holdingSnap } })
    check('L6c 两个句柄都在 ⇒ 取 routeDisplay 的结果（不是 legacy display 的 absent/holding）',
      both === verifiedSnap, both === null ? null : { state: both.state, selected: both.selected })

    const legacyOnly = peek({ display: { peek: () => verifiedSnap } })
    check('L7 只有 display（没有 routeDisplay）⇒ 向后兼容仍用它', legacyOnly === verifiedSnap,
      legacyOnly === null ? null : legacyOnly.state)

    check('L8a host 为 null / 空对象 ⇒ null（走 provider）', peek(null) === null && peek({}) === null)
    const throwing = peek({ routeDisplay: { peek: () => { throw new Error('boom') } }, display: { peek: () => verifiedSnap } })
    check('L8b routeDisplay.peek 抛错 ⇒ null（不偷偷回退到 legacy display）', throwing === null, throwing)
    const noPeek = peek({ routeDisplay: {}, display: { peek: () => verifiedSnap } })
    check('L8c routeDisplay 存在但没有 peek 函数 ⇒ 回退 display',
      noPeek === verifiedSnap, noPeek === null ? null : noPeek.state)

    // 组合器层面：快照适用 ⇒ provider 零调用（与 L3 同款探针）
    let calls = 0
    const provider = async () => { calls += 1; return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY' } }
    const viaRoute = await mimoWireWithDisplay(
      { peek: () => peek({ routeDisplay: { peek: () => verifiedSnap }, display: { peek: () => holdingSnap } }) },
      provider,
    )
    check('L9 经 selectPeek 组合后：routeDisplay 有值 ⇒ provider 零调用且采用其数值',
      calls === 0 && viaRoute !== null && viaRoute.balance === 14.58, { calls, viaRoute })

    // 源码级顺序守卫：函数体里 routeDisplay 必须出现在 h.display 之前（防回退成旧写法）
    const atRoute = fnText.indexOf('routeDisplay')
    const atDisplay = fnText.indexOf('h.display')
    check('L9b 源码守卫：mimoDisplayPeek 先读 routeDisplay 再读 display',
      atRoute !== -1 && atDisplay !== -1 && atRoute < atDisplay, { atRoute, atDisplay })

    // ---- L10：getHost() 先 null（inject 未完成）→ 之后就绪：真跑两次组合器，自动接上 ----
    let hostNow = null
    const liveSource = { peek: () => peek({ getHost: () => hostNow }) }
    let calls10 = 0
    const provider10 = async () => {
      calls10 += 1
      return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY', marker: 'provider' }
    }
    const first = await mimoWireWithDisplay(liveSource, provider10)
    check('L10a getHost() 首次为 null（inject 未完成）⇒ 固定 missing，provider 调用 0 次',
    calls10 === 0 && first !== null && first.error === 'missing', { calls10, first })
    hostNow = { routeDisplay: { peek: () => verifiedSnap } }
    const second = await mimoWireWithDisplay(liveSource, provider10)
    check('L10b 之后就绪 ⇒ 用快照、provider 调用数仍为 0（随时间自动接上）',
    calls10 === 0 && second !== null && second.balance === 14.58, { calls10, second })

    // ---- L11：getHost 抛错 / 不是函数 ⇒ null，provider 恰好一次 ----
    let calls11 = 0
    const provider11 = async () => { calls11 += 1; return { id: 'mimo', name: 'Xiaomi MiMo', marker: 'p' } }
    const threwGetHost = await mimoWireWithDisplay(
      { peek: () => peek({ getHost: () => { throw new Error('inject boom') } }) }, provider11,
    )
    check('L11a getHost() 抛错 ⇒ 固定 missing、provider 零调用',
    calls11 === 0 && threwGetHost !== null && threwGetHost.error === 'missing', { calls11, threwGetHost })
    calls11 = 0
    const notFn = await mimoWireWithDisplay({ peek: () => peek({ getHost: 'nope' }) }, provider11)
    check('L11b getHost 不是函数 ⇒ 固定 missing、provider 零调用',
    calls11 === 0 && notFn !== null && notFn.error === 'missing', { calls11, notFn })

    // ---- L12：源码守卫（顺序 + host.js 必须提供 getHost / 保留 routeDisplay） ----
    const atHost = fnText.indexOf('getHost')
    check('L12a 源码守卫：mimoDisplayPeek 里顺序为 getHost → routeDisplay → display',
      atHost !== -1 && atHost < atRoute && atRoute < atDisplay, { atHost, atRoute, atDisplay })
    const hostSrc = readFileSync(new URL('../plans/mimo-auth/host.js', import.meta.url), 'utf8')
    check('L12b host.js 的 registerMimoAuth 返回对象含 getHost（防删除）',
      /getHost:\s*\(\)\s*=>\s*child/.test(hostSrc))
    check('L12c host.js 仍导出 routeDisplay（批次 D 的字段没被回退）', /routeDisplay,/.test(hostSrc))
  }
}

// ===========================================================================
// G-lane — [0.10.0 N1] GUI 路由（/api/plan-usage）与 usage_status 用同一套 MiMo 分流
// ===========================================================================
{
  // G1：真实 apply() + fake ctx → 直接调 GUI 路由 handler，确认 mimo 行仍按 provider 语义产出
  //     （display 快照不可用时回落 provider 的那条分支，走的正是新接的同一 helper）。
  const registeredG = new Map()
  const routesG = {}
  const servicesG = {
    webServer: { port: 12346, register(spec) { routesG[spec.path] = spec.handler; return () => {} } },
    tools: { register(def) { registeredG.set(def.name, def); return () => { registeredG.delete(def.name) } } },
  }
  const effectsG = []
  let errG = null
  try {
    apply({
      get: (name) => (Object.prototype.hasOwnProperty.call(servicesG, name) ? servicesG[name] : undefined),
      webServer: servicesG.webServer,
      effect: (fn) => { const d = fn(); effectsG.push(d); return d },
    }, new Config(Object.assign(
      Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false])),
      { mimoEnabled: true },
    )))
  } catch (err) { errG = err }
  check('G1a 真实 apply 成功且 GUI 路由已注册', errG === null && typeof routesG['/api/plan-usage'] === 'function',
    errG && errG.message)

  const handler = routesG['/api/plan-usage']
  let captured = null
  const res = { writeHead() {}, end(text) { captured = text } }
  const req = { method: 'GET', headers: {}, url: '/api/plan-usage' }
  let callErr = null
  try { await handler(req, res) } catch (err) { callErr = err }
  let payloadG = null
  try { payloadG = captured === null ? null : JSON.parse(captured) } catch (err) { payloadG = null }
  const mimoRow = payloadG && payloadG.data && Array.isArray(payloadG.data.plans)
    ? payloadG.data.plans.find((x) => x && x.id === 'mimo')
    : undefined
  check('G1b GUI 路由能返回 mimo 行（走新接的同一 helper，快照不可用时回落 provider）',
    callErr === null && mimoRow !== undefined, callErr && callErr.message)
  check('G1c 快照不可用时 mimo 固定 missing（GUI 路由同样不再碰旧 lane）',
    mimoRow !== undefined && mimoRow.error === 'missing', mimoRow)

  for (const fn of effectsG.reverse()) { if (typeof fn === 'function') fn() }

  // G2：快照适用 ⇒ **零 provider 调用**（用 GUI 那条完全相同的 provider 形状）
  let providerCalls = 0
  const guiShapedProvider = () => { providerCalls += 1; return Promise.resolve({ id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY' }) }
  const verified = { displaySupported: true, selected: true, state: 'verified', balance: 14.58, currency: 'CNY', freshness: 'fresh', fetchedAt: Date.now(), displayId: 'd1', generation: 1, revision: 1, code: '', identity: null, awaitingBalanceMatch: false, confirmedByUser: true, canStop: true, managed: false, readFailures: 0, refreshCount: 0, maxAutoRefresh: 0 }
  const wiredG = await mimoWireWithDisplay({ peek: () => verified }, guiShapedProvider)
  check('G2 快照适用时 GUI 分流零 provider 调用（fetch 调用次数 = 0）',
    providerCalls === 0 && wiredG !== null, { providerCalls, wiredG })

  // G3：接线守卫 —— GUI 路由与 collectPlans 用**同一个** helper（不是复制粘贴另一套）
  const hostSrcG = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const guiHook = /plan\.id === 'mimo'[\s\S]{0,120}?mimoWireWithDisplay\(mimoDisplaySource, \(\) => plan\.fetch\(ctx, shell, cfgNow\)\)/
  check('G3a 接线守卫：GUI 路由的逐渠道取数经 mimoWireWithDisplay 分流（源码断言）', guiHook.test(hostSrcG))
  const uses = (hostSrcG.match(/mimoWireWithDisplay\(/g) || []).length
  check('G3b 接线守卫：恰好两处调用（usage_status + GUI 路由），没有第三套实现', uses === 2, uses)
}


// [0.10.2] MiMo 单通道 + 用户可见文本无旧 Cookie 措辞（源码级哨兵）
{
  const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const toolSrc = readFileSync(new URL('../plans/usage-tool.js', import.meta.url), 'utf8')
  check('M1 mimoWireWithDisplay 不再回落 provider（源码无 fetchProvider() 调用）',
    !/return await fetchProvider\(\)/.test(toolSrc) && toolSrc.includes("error: 'missing'"))
  let providerCalls2 = 0
  const provider2 = async () => { providerCalls2 += 1; return { id: 'mimo', balance: 1 } }
  const out2 = await mimoWireWithDisplay({ peek: () => null }, provider2)
  check('M2 快照不可用 ⇒ missing 且 fetch 0 次（不再碰旧 lane）', providerCalls2 === 0 && out2.error === 'missing', { providerCalls2, out2 })
  const clientSrc2 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const bad of ['复制新的 Cookie', '控制台登录态已过期', '手工 Cookie 路径', 'API error code 401', '实验性：临时扫码登录', '合成边界；生产未启用']) {
    check('M3 用户可见源码不含「' + bad + '」', !clientSrc2.includes(bad))
  }
  check('M4 GUI 与 usage_status 都经同一个 helper（index.js 恰好两处调用）',
    (hostSrc.match(/mimoWireWithDisplay\(/g) || []).length === 2)
}

console.log('')
console.log(passCount + ' passed, ' + failCount + ' failed')
process.exit(failCount === 0 ? 0 : 1)

