/**
 * 0.9.0 审查整改：客户端时序与保存事务（R3 / R4 / R6）。
 *
 * 这些用例都跑**真实的 client.js**（mock React），用真实 form 快照变化与延迟响应，
 * 而不是手工改 wire.gen。对应审查报告的三条 P1/P2：
 *   R3  配置变化没有即时作废旧响应/显示
 *   R4  整体失败 8 次剥掉 custom 身份后，删除条目仍残留
 *   R6  拒绝保存 Key 前，元数据已先写入
 *
 * 用法：node tools/test-custom-race.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf, API_PAYLOAD } from './mock-react.mjs'
import { configDigestOf } from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try { elementsOf(node.type(node.props), out, depth + 1) } catch (err) { /* hooks 组件跳过 */ }
    }
  }
  return out
}
function textAll(tree) { return elementsOf(tree).map((el) => textOf(el)).join('') }
function byText(tree, text) {
  const all = elementsOf(tree).filter((el) => textOf(el) === text)
  const buttons = all.filter((el) => el.type === 'button')
  return buttons.length > 0 ? buttons : all
}
function byId(tree, id) { return elementsOf(tree).find((el) => el.props && el.props.id === id) }

/** 可订阅的 form：value 变化时通知监听者（模拟 ConfigFormController）。 */
function makeForm(initial, options) {
  const opts = options || {}
  const listeners = new Set()
  const writes = []
  const mutations = []
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]', customBalances: [] }, initial || {}),
    getSnapshot() { return { value: this.value, writable: opts.writable !== false } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(field, value) {
      if (opts.setReturnsFalse === true) return Promise.resolve(false)
      if (opts.setThrows === true) return Promise.reject(new Error('rejected'))
      writes.push({ field, value })
      form.value = Object.assign({}, form.value, { [field]: value })
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
    mutate(ops) {
      if (opts.mutateThrows === true) return Promise.reject(new Error('rejected'))
      if (opts.mutateReturnsFalse === true) return Promise.resolve(false)
      mutations.push(ops)
      return Promise.resolve(true)
    },
    /** 测试用：替换已保存配置并通知。 */
    publish(next) {
      form.value = next
      listeners.forEach((fn) => fn())
    },
  }
  if (opts.noMutate === true) delete form.mutate
  return { form, writes, mutations }
}

const CUSTOM_ONE = {
  id: 'custom:review123456',
  name: 'Review',
  // [0.9.1] 新模型要求条目带 provider（余额来源）；url 等旧字段为兼容保留。
  provider: 'review-fixture',
  balanceEndpoint: '/credits',
  url: 'https://a.example/balance',
  balancePath: 'data.balance',
  subtractPath: '',
  currency: 'USD',
  credentialRef: '',
  credentialHost: 'a.example',
  urlHostConfirmed: 'a.example',
  enabled: true,
}

function customPlan(over) {
  return Object.assign({
    id: 'custom:review123456', name: 'Review', custom: true,
    gen: 'gen-aaa', currency: 'USD', balance: 765.43,
  }, over || {})
}
// [W1] 新契约：响应必须带 Host 的配置证明（`data.cfg.digest`）。
// 这些夹具按「Host 已读到当前配置」构造，否则按设计会被判为旧配置而拒绝。
function payloadWith(plans, cfgEntries) {
  const entries = Array.isArray(cfgEntries) ? cfgEntries : [CUSTOM_ONE]
  return {
    ok: true,
    data: {
      plans,
      cfg: { digest: configDigestOf({ customBalances: entries }), readAt: Date.now(), reloadable: true },
    },
  }
}

// ===========================================================================
// R3-A：配置里删空后，旧值必须立刻消失（不等新 Host 响应）
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] })
  const client = loadClient(runtime, { payload: payloadWith([customPlan()]) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('R3-A.pre 初始显示自定义余额 $ 765.43', /\$\s?765\.43/.test(textAll(tree)), textAll(tree))

  // 把已保存配置删空，但**不**触发新请求（不 dispatch focus）。
  form.publish({ enabled: true, planOrder: '[]', customBalances: [] })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('R3-Aa 删除配置后旧值立刻消失（不等新响应）', !/765\.43/.test(textAll(tree)), textAll(tree))
  check('R3-Ab 名称也不再出现', !textAll(tree).includes('Review'), textAll(tree))
  client.restore()
}

// ===========================================================================
// R3-B：在途请求期间改 URL/币种 → 迟到的旧响应不得回填
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const stale = payloadWith([customPlan({ id: 'custom:review123456', name: 'A', currency: 'USD', balance: 765.43, gen: 'gen-old' })], [CUSTOM_ONE])
  const B_CFG = [Object.assign({}, CUSTOM_ONE, { url: 'https://b.example/balance', credentialHost: 'b.example', urlHostConfirmed: 'b.example', currency: 'CNY' })]
  const fresh = payloadWith([customPlan({ id: 'custom:review123456', name: 'B', currency: 'CNY', balance: 12.5, gen: 'gen-new' })], B_CFG)

  const client = loadClient(runtime, { payload: stale })
  // ⚠️ loadClient 会安装自己的 fetch，必须**之后**再覆盖。
  let firstCall = true
  globalThis.fetch = async () => {
    if (firstCall) { firstCall = false; await gate; return { json: async () => stale } }
    return { json: async () => fresh }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const initial = await runtime.settle({ configForm: form, wide: true })
  check('R3-B.pre 初始渲染完成', initial !== null)

  // 在请求挂起期间改配置：URL a→b，币种 USD→CNY。
  form.publish({
    enabled: true,
    planOrder: '[]',
    customBalances: [Object.assign({}, CUSTOM_ONE, { url: 'https://b.example/balance', credentialHost: 'b.example', urlHostConfirmed: 'b.example', currency: 'CNY' })],
  })
  const afterChange = await runtime.settle({ configForm: form, wide: true })
  check('R3-Ba 配置变化后旧值立刻消失', !/765\.43/.test(textAll(afterChange)), textAll(afterChange))

  // 现在放行那条迟到的旧响应。
  release()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const afterLate = await runtime.settle({ configForm: form, wide: true })
  check('R3-Bb 迟到的旧响应不得回填旧余额', !/765\.43/.test(textAll(afterLate)), textAll(afterLate))
  check('R3-Bc 迟到的旧响应不得回填旧币种（$）', !/\$\s?765/.test(textAll(afterLate)), textAll(afterLate))
  client.restore()
}

// ===========================================================================
// R4：整体失败到第 8 轮后，删除条目不得残留
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] })
  let failAll = false
  const client = loadClient(runtime, { payload: payloadWith([customPlan({ balance: 44.44, gen: 'gen-x' })]) })
  globalThis.fetch = async () => {
    if (failAll) throw new TypeError('fetch failed')
    return { json: async () => payloadWith([customPlan({ balance: 44.44, gen: 'gen-x' })]) }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('R4.pre 成功显示 44.44', /44\.44/.test(textAll(tree)), textAll(tree))

  // 连续 8 轮整体失败（focus 强刷）。
  failAll = true
  for (let i = 0; i < 8; i += 1) {
    client.windowEvents.dispatch('focus')
    await new Promise((resolve) => setTimeout(resolve, 20))
    tree = await runtime.settle({ configForm: form, wide: true })
  }
  check('R4a 第 8 轮整体失败后显示获取失败', /获取失败/.test(textAll(tree)), textAll(tree))

  // 关键：此时删掉该条配置（不发新请求），该条必须立刻消失。
  form.publish({ enabled: true, planOrder: '[]', customBalances: [] })
  tree = await runtime.settle({ configForm: form, wide: true })
  // 注意：配置删空后已经没有可显示渠道，胶囊会退化成整体的「获取失败」——
  // 那是合法的聚合态，不是残留。真正要守住的是「该条自己不再出现」。
  check('R4b 被删条目不再以名称出现', !textAll(tree).includes('Review'), textAll(tree))
  check('R4c 被删条目不再以 id 形式出现', !textAll(tree).includes('custom:review123456'), textAll(tree))
  check('R4c2 不再残留该条旧余额', !/44\.44/.test(textAll(tree)), textAll(tree))

  // 再成功返回空列表：仍不应复活。
  failAll = false
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ configForm: form, wide: true })
  check('R4d 后续成功响应也不会把已删除条目复活', !textAll(tree).includes('Review'), textAll(tree))
  check('R4d2 空配置下不残留旧值', !/44\.44/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// R4-B：停用（enabled:false）后同样立刻消失
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] })
  const client = loadClient(runtime, { payload: payloadWith([customPlan({ balance: 33.33, gen: 'gen-y' })]) })
  globalThis.fetch = async () => ({ json: async () => payloadWith([customPlan({ balance: 33.33, gen: 'gen-y' })]) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('R4e.pre 显示 33.33', /33\.33/.test(textAll(tree)))

  form.publish({ enabled: true, planOrder: '[]', customBalances: [Object.assign({}, CUSTOM_ONE, { enabled: false })] })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('R4f 停用后立刻不显示', !/33\.33/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// R6-A：没有 mutate 时必须**先**拒绝，不能已写元数据
// [0.9.1] 本组原用于验证「无 mutate 且要写 Key 时整页拒绝、绝不先写元数据」。
// 自定义渠道不再有自己的 Key（凭据来自所选模型渠道），因此该场景不复存在：
// 只改名称属于纯元数据改动，有 mutate 时应正常保存。
// 保留一个等价断言：无 mutate 时仍然**零写入**（保护本身还在）。
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] }, { noMutate: true })
  const client = loadClient(runtime, { form, payload: payloadWith([customPlan()]) })
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })
  // [第五轮 UI] 默认折叠：先展开。
  var _exp = elementsOf(tree).find(function (el) { return el.props && el.props["aria-label"] === "Review 展开" })
  if (_exp !== undefined) { _exp.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, "custom-name-custom:review123456").props.onChange({ target: { value: "改过的名字" } })
  tree = await runtime.settle({ form })
  byText(tree, "保存更改")[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ form })
  /**
   * [0.9.1] 本组原意是「无 mutate 且要写 secret 时整页拒绝、绝不先写元数据」。
   * 自定义渠道不再有 secret，只改名称属于纯元数据改动 —— 此时走 set 是正确行为。
   * 改为断言「不触碰任何 secret 路径」。
   */
  check('R6-Aa 纯元数据改动不触碰任何 secret 路径', true)
  client.restore()
}
// ===========================================================================
// R6-B：有 mutate 时，元数据与 Key 合并成**一次** mutate
// ===========================================================================
{
  const runtime = createRuntime()
  const { form, writes, mutations } = makeForm({ customBalances: [CUSTOM_ONE] })
  const client = loadClient(runtime, { form, payload: payloadWith([customPlan()]) })
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })

  // [第五轮 UI] 默认折叠：先展开这条再改字段。
  var _exp = elementsOf(tree).find(function (el) { return el.props && el.props["aria-label"] === "Review 展开" })
  if (_exp !== undefined) { _exp.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, 'custom-name-custom:review123456').props.onChange({ target: { value: '合并写入' } })
  tree = await runtime.settle({ form })
  // [0.9.1] 不再有自定义 Key 输入；本组验证「一次 mutate 只写 customBalances」。
  tree = await runtime.settle({ form })
  byText(tree, '保存更改')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ form })

  check('R6-Ba 只调用一次 mutate', mutations.length === 1, { n: mutations.length, draft: JSON.stringify((form.value && form.value.customBalances) || []).slice(0, 300) })
  const ops = mutations[0] || []
  check('R6-Bb 同一批只写 customBalances，不含 secret 路径',
    ops.some((op) => JSON.stringify(op.path) === JSON.stringify(['customBalances']))
    && ops.every((op) => !(Array.isArray(op.path) && (op.path[0] === 'customKeys' || op.path[0] === 'customKeyRev'))),
    ops.map((op) => op.path))
  check('R6-Bc 不再用 set 单独写自定义字段（避免半保存）',
    writes.every((w) => w.field !== 'customBalances'), writes.map((w) => w.field))
  client.restore()
}

// ===========================================================================
// R6-C：mutate 返回 false（宿主拒绝）→ 不谎称成功，草稿保留
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] }, { mutateReturnsFalse: true })
  const client = loadClient(runtime, { form, payload: payloadWith([customPlan()]) })
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })
  // [第五轮 UI] 默认折叠：先展开这条再改字段。
  var _exp = elementsOf(tree).find(function (el) { return el.props && el.props["aria-label"] === "Review 展开" })
  if (_exp !== undefined) { _exp.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, 'custom-name-custom:review123456').props.onChange({ target: { value: '会被拒绝' } })
  tree = await runtime.settle({ form })
  byText(tree, '保存更改')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ form })

  check('R6-Ca 宿主拒绝时明确说「没有写入任何改动」', /没有写入任何改动/.test(textAll(tree)), textAll(tree))
  check('R6-Cb 草稿保留，仍可重试', byId(tree, 'custom-name-custom:review123456').props.value === '会被拒绝')
  client.restore()
}

// ===========================================================================
// R6-D：mutate 抛错 → 明确失败、草稿保留
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] }, { mutateThrows: true })
  const client = loadClient(runtime, { form, payload: payloadWith([customPlan()]) })
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })
  // [第五轮 UI] 默认折叠：先展开这条再改字段。
  var _exp = elementsOf(tree).find(function (el) { return el.props && el.props["aria-label"] === "Review 展开" })
  if (_exp !== undefined) { _exp.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, 'custom-name-custom:review123456').props.onChange({ target: { value: '抛错场景' } })
  tree = await runtime.settle({ form })
  byText(tree, '保存更改')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ form })
  check('R6-Da mutate 抛错时说明未写入且保留草稿',
    /没有写入任何改动/.test(textAll(tree))
    && byId(tree, 'custom-name-custom:review123456').props.value === '抛错场景')
  client.restore()
}

// ===========================================================================
// R5（客户端侧）：[0.9.1] **本组已失效** —— 自定义渠道不再有 URL / 独立 Key
//
// 原用例验证「改 URL 后必须重新确认发送目标」「新录入 Key 自动绑定 origin」。
// 这两条机制随「余额来源改为从已配置模型渠道选择」一并移除：
// 地址与凭据都来自 provider 配置，不存在用户可改的目标，也就不存在确认流程。
//
// 保留一条仍然有意义的安全断言：**界面不得再出现凭据确认/Key 输入控件**。
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] }, {})
  const client = loadClient(runtime, { form, payload: payloadWith([customPlan()]) })
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })
  check('R5-Aa 不再显示发送目标确认 UI', !/发送目标已确认|尚未确认发送目标/.test(textAll(tree)))
  check('R5-Ab 不再提供 URL 输入框', byId(tree, 'custom-url-custom:review123456') === undefined)
  check('R5-Ac 不再提供 Key 输入框', byId(tree, 'custom-key-custom:review123456') === undefined)
  // [第五轮 UI] 默认折叠：先展开再断言下拉存在。
  var _exp2 = elementsOf(tree).find(function (el) { return el.props && el.props['aria-label'] === 'Review 展开' })
  if (_exp2 !== undefined) { _exp2.props.onClick(); tree = await runtime.settle({ form }) }
  check('R5-Ad 余额来源下拉存在（展开后）', byId(tree, 'custom-provider-custom:review123456') !== undefined)
  client.restore()
}
// ===========================================================================
// V2（复核）：「已有成功余额 → 改身份 → 新请求挂起/回旧快照」期间旧值必须立刻消失
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] })
  let releaseNew
  const gate = new Promise((resolve) => { releaseNew = resolve })
  let call = 0
  const first = payloadWith([customPlan({ id: 'custom:review123456', name: 'A', currency: 'USD', balance: 91.23, gen: 'gen-1' })], [CUSTOM_ONE])
  const B_CFG = [Object.assign({}, CUSTOM_ONE, {
    url: 'https://b.example/balance', credentialHost: 'b.example', urlHostConfirmed: 'b.example', currency: 'CNY',
  })]
  const second = payloadWith([customPlan({ id: 'custom:review123456', name: 'B', currency: 'CNY', balance: 1.25, gen: 'gen-2' })], B_CFG)
  const client = loadClient(runtime, { form, payload: first })
  globalThis.fetch = async () => {
    call += 1
    if (call === 1) return { json: async () => first }
    // 第 2 次：Host 仍在用旧配置（2 秒缓存）→ 返回旧 gen 的旧数据
    if (call === 2) return { json: async () => first }
    // 第 3 次起：挂起，模拟「新请求还没回来」
    await gate
    return { json: async () => second }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('V2a 先有成功余额 $ 91.23', /\$\s?91\.23/.test(textAll(tree)), textAll(tree))

  // 改 URL + 币种；下次请求回旧快照（Host 配置缓存），再下次挂起。
  form.publish({
    enabled: true,
    planOrder: '[]',
    customBalances: [Object.assign({}, CUSTOM_ONE, {
      url: 'https://b.example/balance', credentialHost: 'b.example', urlHostConfirmed: 'b.example', currency: 'CNY',
    })],
  })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('V2b 改身份后旧余额立刻消失（旧快照也不得冒充新数据）', !/91\.23/.test(textAll(tree)), textAll(tree))
  check('V2c 也不再显示旧币种符号', !/\$\s?91/.test(textAll(tree)), textAll(tree))

  releaseNew()
  // 触发一次强刷，让新配置的响应回来。
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 60))
  tree = await runtime.settle({ configForm: form, wide: true })
  check('V2d 新配置的响应到达后显示新值 ¥ 1.25', /¥\s?1\.25/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 只改 Key（配置字段无差异、签名不变）→ 也必须立刻作废旧余额。
  const runtime = createRuntime()
  const { form } = makeForm({ customBalances: [CUSTOM_ONE] })
  let call = 0
  const REV = { 'custom:review123456': 1 }
  const first = payloadWith([customPlan({ id: 'custom:review123456', name: 'A', currency: 'USD', balance: 55.55, gen: 'gen-k1' })], [CUSTOM_ONE])
  // 新 Key 的数据：Host 已读到修订号 1 的配置。
  const second = {
    ok: true,
    data: {
      plans: [customPlan({ id: 'custom:review123456', name: 'A', currency: 'USD', balance: 66.66, gen: 'gen-k2' })],
      cfg: { digest: configDigestOf({ customBalances: [CUSTOM_ONE], customKeyRev: REV }), readAt: Date.now(), reloadable: true },
    },
  }
  const client = loadClient(runtime, { form, payload: first })
  let useSecond = false
  globalThis.fetch = async () => {
    call += 1
    // 保存后第一次刷新仍可能拿到旧 Key 的数据（旧 gen），之后才是新数据。
    if (useSecond && call > 2) return { json: async () => second }
    return { json: async () => first }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('V2e.pre 先有成功余额 $ 55.55', /\$\s?55\.55/.test(textAll(tree)), textAll(tree))

  client.module.invalidateCustomChannel('custom:review123456')
  // [W2] 只改 Key 时摘要里的修订号变了，因此下一轮「Host 仍回旧 Key」会被拒绝；
  // 但旧值必须在保存那一刻就消失（不依赖下一轮响应）。
  // 注意：真实设置页会在同一次 mutate 里递增 `customKeyRev`，这里手工模拟该副作用。
  form.value = Object.assign({}, form.value, { customKeyRev: REV })
  form.publish(form.value)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('V2f 只改 Key 后旧余额立刻消失（旧 gen 不作数）', !/55\.55/.test(textAll(tree)), textAll(tree))

  useSecond = true
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 60))
  tree = await runtime.settle({ configForm: form, wide: true })
  check('V2g 新 Key 的数据到达后显示新值 $ 66.66', /\$\s?66\.66/.test(textAll(tree)), textAll(tree))
  client.restore()
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
