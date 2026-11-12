/**
 * [2026-11-11 Codex 双来源] 来源选择 UI + 单来源数据隔离 + 预设凭据展平。
 *
 * 全部跑**真实的 client.js**（tools/mock-react.mjs 的极简 React 运行时），
 * 路由全部是 fake（没有 localhost 服务、没有真实 Host、没有真实配置文件/凭据）。
 *
 * 组：
 *   S  设置页来源区：两行始终列出、未启用/不兼容/未知三态、不泄 secret
 *   R  选择语义：点击只改草稿、保存只写 codexSource、放弃回原值、停用行不可交互
 *   B  胶囊数据隔离：切来源后旧来源值（含迟到响应/旧证明）不显示、不整批清空
 *   L  预设凭据展平：DeepSeek 的 Key 输入不再有 details 祖先；自定义卡仍折叠
 *   D  跨端摘要契约：connect 保旧摘要，subscription 追加固定片段
 *   V  跨端摘要**向量**（真 import Host `configDigestOf`）+ N1 归一同构 + N2 作废行保留来源
 *
 * 边界：本文件只证明「客户端逻辑 + 合成 wire」；**不等于**实机验证，也不代表
 * 任何真实 Host 已实现该端点或该字段（后端由另一路负责）。
 *
 * 用法：node tools/test-codex-source-ui.mjs
 *      DSH_CLIENT_UNDER_TEST=<stage/client.js> node tools/test-codex-source-ui.mjs
 */
import { createRuntime, loadClient, textOf, DEFAULT_CODEX_SOURCES } from './mock-react.mjs'

let pass = 0
let fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else {
    fail++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600)))
  }
}

function elementsOf (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 14) return out
  if (Array.isArray(node)) { for (const n of node) elementsOf(n, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'string') {
    out.push(node)
    elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
  } else if (typeof node.type === 'function') {
    let rendered
    try { rendered = node.type(node.props) } catch (err) { return out }
    if (rendered !== undefined) elementsOf(rendered, out, depth + 1)
  }
  return out
}
const byAttr = (tree, attr, value) => elementsOf(tree).find((el) => el.props && el.props[attr] === value)
const allByAttr = (tree, attr) => elementsOf(tree).filter((el) => el.props && el.props[attr] !== undefined)
/**
 * 只拼接**文本节点**（不重复统计父元素子树文本）：
 * `elementsOf(tree).map(textOf)` 会把同一段文字按「祖先 + 自己」各算一次，
 * 用它判断「某句话出现几次」会得到翻倍的假计数。
 */
function flatText (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 24) return out.join('')
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out.join('') }
  if (Array.isArray(node)) { for (const n of node) flatText(n, out, depth); return out.join('') }
  if (typeof node !== 'object' || node.type === undefined) return out.join('')
  flatText(node.props ? node.props.children : undefined, out, depth + 1)
  return out.join('')
}
const textAll = (tree) => flatText(tree)
const byButton = (tree, text) => elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === text)
const contains = (node, target) => elementsOf(node).indexOf(target) !== -1
function ancestors (node) {
  const out = []
  let n = node === null || node === undefined ? null : node.parentElement
  let hops = 0
  while (n && hops < 32) { out.push(n); n = n.parentElement; hops++ }
  return out
}
const attrText = (tree, attr, value) => {
  const el = byAttr(tree, attr, value)
  return el === undefined ? '' : textAll(el)
}

// ===========================================================================
// 夹具
// ===========================================================================
const BASE_CFG = {
  enabled: true,
  planOrder: '[]',
  codexEnabled: true,
  codexSource: 'connect',
}

/** 可订阅 form（ConfigFormController 的最小替身）：mutate 会把 path 长度 1 的 set 落到 value。 */
function makeForm (initial, options) {
  const opts = options || {}
  const listeners = new Set()
  const writes = []
  const mutations = []
  const form = {
    // 刻意不放 default customBalances：空数组每次都会是新引用，会让 save() 误报一条 field op。
    value: Object.assign({ enabled: true, planOrder: '[]' }, initial || {}),
    writable: opts.writable !== false,
    getSnapshot () { return { value: this.value, writable: this.writable } },
    subscribe (listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set (field, value) {
      writes.push({ field, value })
      form.value = Object.assign({}, form.value, { [field]: value })
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
    mutate (ops) {
      mutations.push(ops)
      for (const op of ops) {
        if (op.op === 'set' && Array.isArray(op.path) && op.path.length === 1) {
          form.value = Object.assign({}, form.value, { [op.path[0]]: op.value })
        }
      }
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
    publish (next) {
      form.value = next
      listeners.forEach((fn) => fn())
    },
  }
  return { form, writes, mutations }
}

function openSettings (initial, clientOpts, options) {
  const opts = options || {}
  const runtime = createRuntime()
  const { form, writes, mutations } = makeForm(initial, opts)
  // form 必须交给 loadClient：设置页 tab 由 configForms.whileServed 决定是否注册。
  const client = loadClient(runtime, Object.assign({ form, payload: { ok: true, data: { plans: [] } } }, clientOpts || {}))
  runtime.mount(client.SettingsPage, { form })
  return { runtime, form, writes, mutations, client, settle: () => runtime.settle({ form }) }
}

const READY_BOTH = {
  ok: true,
  data: {
    sources: [
      { id: 'connect', label: 'Codex Connect', enabled: true, compatible: true },
      { id: 'subscription', label: 'Codex Subscription', enabled: true, compatible: true },
    ],
    selected: 'connect',
  },
}

// ===========================================================================
// S — 设置页来源区：两行始终列出 + 三种状态 + 不泄 secret
// ===========================================================================
{
  // S1/S2：默认夹具（connect 可用 / subscription 未启用）——两行都在
  const ctx = openSettings(BASE_CFG)
  const tree = await ctx.settle()
  const block = byAttr(tree, 'data-codex-source-block', '1')
  check('S1a Codex 卡片里有来源区', block !== undefined)
  check('S1b 两行来源始终列出（connect + subscription 都在）',
    byAttr(block, 'data-codex-source-row', 'connect') !== undefined
    && byAttr(block, 'data-codex-source-row', 'subscription') !== undefined)
  check('S1c connect 行状态=ready（可用）',
    byAttr(block, 'data-codex-source-row', 'connect').props['data-codex-source-state'] === 'ready',
    byAttr(block, 'data-codex-source-row', 'connect').props['data-codex-source-state'])
  check('S1d subscription 行状态=not-enabled 且文案是「未启用」',
    byAttr(block, 'data-codex-source-row', 'subscription').props['data-codex-source-state'] === 'not-enabled'
    && attrText(block, 'data-codex-source-state-text', 'not-enabled').indexOf('未启用') !== -1,
    attrText(block, 'data-codex-source-state-text', 'not-enabled'))
  check('S1e 未启用行不可交互（radio disabled）',
    byAttr(block, 'data-codex-source', 'subscription').props.disabled === true)
  check('S1f 可用的 connect 行可交互',
    byAttr(block, 'data-codex-source', 'connect').props.disabled === false)
  // 关键：来源区**没有**凭据/Token 输入（来源选择不要求填 token）
  const codexCard = byAttr(tree, 'data-plan-card', 'codex')
  const codexInputs = elementsOf(codexCard).filter((el) => el.type === 'input')
  check('S1g 来源区不出现任何 token/password 输入（只有开关 + 两个 radio）',
    codexInputs.length === 3
    && codexInputs.every((el) => el.props.type === 'checkbox' || el.props.type === 'radio'),
    codexInputs.map((el) => el.props.type))
  check('S1h 每张卡片只有**一段**登录说明（不会同时出现 Connect 与 Subscription 两段）',
    elementsOf(codexCard).filter((el) => el.props && el.props['data-codex-source-note'] !== undefined).length === 1
    && (attrText(codexCard, 'data-codex-source-note', '1').match(/请先在/g) || []).length === 1,
    attrText(codexCard, 'data-codex-source-note', '1'))
  ctx.client.restore()

  // S3「未安装 / 未开启」统一为未启用：两行都 enabled:false
  const noneInstalled = {
    ok: true,
    data: {
      sources: [
        { id: 'connect', label: 'Codex Connect', enabled: false, compatible: true },
        { id: 'subscription', label: 'Codex Subscription', enabled: false, compatible: true },
      ],
      selected: 'connect',
    },
  }
  const ctx2 = openSettings(BASE_CFG, { codexSources: noneInstalled })
  const tree2 = await ctx2.settle()
  check('S2a 未安装/未开启都显示为「未启用」（不区分、不显示 not-installed）',
    byAttr(tree2, 'data-codex-source-state', 'not-enabled') !== undefined
    && (textAll(tree2).match(/未启用/g) || []).length >= 2
    && textAll(tree2).indexOf('not-installed') === -1
    && textAll(tree2).indexOf('not installed') === -1)
  check('S2b 两行都不可选中', allByAttr(tree2, 'data-codex-source')
    .every((el) => el.props.disabled === true))
  ctx2.client.restore()

  // S4：enabled:true 但 compatible:false → 「接口暂不可用/需适配」，不是「未启用」
  const incompatible = {
    ok: true,
    data: {
      sources: [
        { id: 'connect', label: 'Codex Connect', enabled: true, compatible: true },
        { id: 'subscription', label: 'Codex Subscription', enabled: true, compatible: false },
      ],
      selected: 'connect',
    },
  }
  const ctx3 = openSettings(BASE_CFG, { codexSources: incompatible })
  const tree3 = await ctx3.settle()
  const inRow = byAttr(tree3, 'data-codex-source-row', 'subscription')
  check('S3a 已启用但接口不兼容 → incompatible 状态',
    inRow.props['data-codex-source-state'] === 'incompatible', inRow.props['data-codex-source-state'])
  check('S3b 文案是「接口暂不可用（需适配）」而不是「未启用」',
    attrText(tree3, 'data-codex-source-state-text', 'incompatible').indexOf('接口暂不可用') === 0
    && attrText(inRow, 'data-codex-source-state-text', 'incompatible').indexOf('未启用') === -1,
    attrText(tree3, 'data-codex-source-state-text', 'incompatible'))
  check('S3c 不兼容行不可选中（不是「可用」）',
    byAttr(tree3, 'data-codex-source', 'subscription').props.disabled === true)
  ctx3.client.restore()

  // S5：metadata 取不到 → 「状态暂不可用」，绝不假称未启用
  const ctx4 = openSettings(BASE_CFG, { codexSourcesError: true })
  const tree4 = await ctx4.settle()
  const states = allByAttr(tree4, 'data-codex-source-state').map((el) => el.props['data-codex-source-state'])
  check('S4a 取数失败 → 两行都是 unknown（状态暂不可用）',
    states.length === 2 && states.every((s) => s === 'unknown'), states)
  check('S4b unknown 的文案是「状态暂不可用」，不是「未启用」',
    attrText(tree4, 'data-codex-source-state-text', 'unknown').indexOf('状态暂不可用') === 0,
    attrText(tree4, 'data-codex-source-state-text', 'unknown'))
  check('S4c unknown 不冒充未启用（块内没有「未启用」字样）',
    textAll(byAttr(tree4, 'data-codex-source-block', '1')).indexOf('未启用') === -1)
  ctx4.client.restore()
}

// ===========================================================================
// R — 选择语义：只改草稿 → 统一保存 → 只写 codexSource；放弃回原值
// ===========================================================================
{
  const ctx = openSettings(BASE_CFG, { codexSources: READY_BOTH })
  let tree = await ctx.settle()
  const before = Object.assign({}, ctx.form.value)
  check('R1a 初始勾选的是已保存来源（connect）',
    byAttr(tree, 'data-codex-source', 'connect').props.checked === true
    && byAttr(tree, 'data-codex-source', 'subscription').props.checked === false)
  check('R1b 初始摘要说明当前来源', attrText(tree, 'data-codex-source-summary', '1').indexOf('当前来源') === 0,
    attrText(tree, 'data-codex-source-summary', '1'))

  // 点击 subscription 行 = 只改草稿
  byAttr(tree, 'data-codex-source', 'subscription').props.onChange({ target: { checked: true } })
  tree = await ctx.settle()
  check('R2a 点击后 radio 立即显示新选择',
    byAttr(tree, 'data-codex-source', 'subscription').props.checked === true)
  check('R2b 点击**只改草稿**：已保存配置未变（codexSource 仍是 connect）',
    ctx.form.value.codexSource === 'connect', ctx.form.value.codexSource)
  check('R2c 点击**不写后台**：没有 mutate / set 调用',
    ctx.mutations.length === 0 && ctx.writes.length === 0,
    { mutations: ctx.mutations.length, writes: ctx.writes.length })
  check('R2d 摘要提示「将切换到…；保存后才生效」',
    attrText(tree, 'data-codex-source-summary', '1').indexOf('将切换到') === 0
    && attrText(tree, 'data-codex-source-summary', '1').indexOf('生效') !== -1,
    attrText(tree, 'data-codex-source-summary', '1'))
  check('R2e 登录说明跟随草稿来源（变成 Subscription 插件）',
    attrText(tree, 'data-codex-source-note', '1').indexOf('Codex Subscription') !== -1,
    attrText(tree, 'data-codex-source-note', '1'))

  // 统一保存
  byButton(tree, '保存更改').props.onClick()
  tree = await ctx.settle()
  const ops = ctx.mutations.length > 0 ? ctx.mutations[0] : []
  check('R3a 保存走一次 mutate，且只写 codexSource',
    ctx.mutations.length === 1 && ops.length === 1
    && ops[0].op === 'set' && ops[0].path.length === 1 && ops[0].path[0] === 'codexSource'
    && ops[0].value === 'subscription', ops)
  check('R3b 已保存来源变成 subscription', ctx.form.value.codexSource === 'subscription')
  const changedKeys = Object.keys(ctx.form.value).filter((k) => ctx.form.value[k] !== before[k])
  check('R3c 其它配置一个字节都没改（只有 codexSource 变化）',
    changedKeys.length === 1 && changedKeys[0] === 'codexSource', changedKeys)
  check('R3d 保存后摘要回到「当前来源」', attrText(tree, 'data-codex-source-summary', '1').indexOf('当前来源') === 0,
    attrText(tree, 'data-codex-source-summary', '1'))

  // 放弃更改：回到已保存值
  byAttr(tree, 'data-codex-source', 'connect').props.onChange({ target: { checked: true } })
  tree = await ctx.settle()
  byButton(tree, '放弃更改').props.onClick()
  tree = await ctx.settle()
  check('R4a 放弃后勾选回到已保存来源（subscription）',
    byAttr(tree, 'data-codex-source', 'subscription').props.checked === true
    && byAttr(tree, 'data-codex-source', 'connect').props.checked === false)
  ctx.client.restore()

  // R5：已保存来源本身停用 → 该行仍勾选但不可交互，不静默迁移到另一行
  const subDisabled = {
    ok: true,
    data: {
      sources: [
        { id: 'connect', label: 'Codex Connect', enabled: true, compatible: true },
        { id: 'subscription', label: 'Codex Subscription', enabled: false, compatible: true },
      ],
      selected: 'subscription',
    },
  }
  const savedSub = Object.assign({}, BASE_CFG, { codexSource: 'subscription' })
  const ctx5 = openSettings(savedSub, { codexSources: subDisabled })
  const tree5 = await ctx5.settle()
  check('R5a 已保存的停用来源仍保持勾选（原 checked 不偷偷迁移）',
    byAttr(tree5, 'data-codex-source', 'subscription').props.checked === true
    && byAttr(tree5, 'data-codex-source', 'connect').props.checked === false)
  check('R5b 停用行的 radio 不可交互', byAttr(tree5, 'data-codex-source', 'subscription').props.disabled === true)
  check('R5c 另一行没有被自动选中（connect 仍 disabled=false 但未勾选）',
    byAttr(tree5, 'data-codex-source', 'connect').props.disabled === false
    && byAttr(tree5, 'data-codex-source', 'connect').props.checked === false)
  check('R5d 摘要如实说明当前来源是未启用的那一个',
    attrText(tree5, 'data-codex-source-summary', '1').indexOf('Codex Subscription') !== -1,
    attrText(tree5, 'data-codex-source-summary', '1'))
  ctx5.client.restore()
}

// ===========================================================================
// B — 胶囊：只显示所选来源，切来源后旧来源值（含迟到/旧证明）不得回填
// ===========================================================================
{
  const runtime = createRuntime()
  const codexWire = (source, percent) => ({
    id: 'codex',
    name: 'OpenAI Codex',
    codexSource: source,
    rollingUsage: { status: null, percent, resetsAt: null, resetInSec: null },
    weeklyUsage: { status: null, percent: 72, resetsAt: null, resetInSec: null },
  })
  const deepseekWire = { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 }

  const { form } = makeForm(BASE_CFG)
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  const digestOf = client.module.codexSource.digest

  // 每一次 `/api/plan-usage` 调用返回什么，由**调用序号**决定；摘要一律在
  // **调用时**用当时的已保存配置算（证明必须对得上当前配置，否则客户端按设计丢弃）。
  //   0  connect 33%（首屏）
  //   1  迟到的 connect 33%（切来源后 Host 仍读到旧配置时的响应）
  //   2  subscription 55%（新来源的真实响应，证明匹配）
  //   3+ 所选来源未启用（订阅侧 enabled:false）
  const proofFor = (source) => digestOf(Object.assign({}, form.value, { codexSource: source }))
  const body = (plans, digest, readAt) => ({ ok: true, data: { plans, cfg: { digest, readAt, reloadable: true } } })
  const disabledCodex = {
    id: 'codex', name: 'OpenAI Codex', codexSource: 'subscription',
    error: 'disabled', effectiveStatus: 'failed', message: '未启用',
  }
  let call = 0
  globalThis.fetch = async (url) => {
    // 只拦取数路由：Badge 还会访问别的插件路由（MiMo 登录状态等），
    // 混在一起会打乱序号（这正是「次数对不上」的坑）。
    if (String(url) !== '/api/plan-usage') return { json: async () => ({ ok: false }) }
    const index = call
    call += 1
    if (index === 0) return { json: async () => body([deepseekWire, codexWire('connect', 33)], proofFor('connect'), 1) }
    if (index === 1) return { json: async () => body([deepseekWire, codexWire('connect', 33)], proofFor('connect'), 2) }
    if (index === 2) return { json: async () => body([deepseekWire, codexWire('subscription', 55)], proofFor('subscription'), 3) }
    return { json: async () => body([deepseekWire, disabledCodex], proofFor('subscription'), 4) }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('B1a 初始显示所选来源（connect）的额度 33%',
    /33%/.test(textAll(tree)), textAll(tree))
  check('B1b 其它渠道同时显示（DeepSeek ¥7.38）', /7\.38/.test(textAll(tree)), textAll(tree))

  // 切到 subscription：旧 connect 值必须**立刻**消失（不等新响应）
  form.publish(Object.assign({}, form.value, { codexSource: 'subscription' }))
  tree = await runtime.settle({ configForm: form, wide: true })
  check('B2a 切来源后旧来源（connect）的 33% 立刻不再显示', !/33%/.test(textAll(tree)), textAll(tree))
  check('B2b 切来源后其它渠道仍保留（不整批清空）', /7\.38/.test(textAll(tree)), textAll(tree))

  // 说明：上面 form.publish 已经让 effect 重跑过一次（call#1 = 旧配置的响应）。
  // 它的证明对不上新配置，整批按「配置生效中」处理，因此旧来源的 33% 不会回填。

  // 新来源的真实响应（证明与新配置一致）才显示
  if (typeof client.windowEvents.dispatch === 'function') client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ configForm: form, wide: true })
  check('B3a 新来源的响应显示 55%（只有证明匹配才显示）', /55%/.test(textAll(tree)), textAll(tree))
  check('B3b 旧来源的 33% 仍不出现', !/33%/.test(textAll(tree)), textAll(tree))
  check('B3c 其它渠道仍保留', /7\.38/.test(textAll(tree)), textAll(tree))

  // 所选来源本身未启用（Host 回该来源的失败条目）：不 fallback 到另一个来源
  if (typeof client.windowEvents.dispatch === 'function') client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = await runtime.settle({ configForm: form, wide: true })
  check('B4a 所选来源未启用时不回退到另一来源的数字',
    !/33%/.test(textAll(tree)) && !/55%/.test(textAll(tree)), textAll(tree))
  check('B4b Codex 行仍在（显示失败态，而不是整行消失）',
    textAll(tree).indexOf('OpenAI Codex') !== -1 && textAll(tree).indexOf('获取失败') !== -1, textAll(tree))
  check('B4c 其它渠道不受牵连', /7\.38/.test(textAll(tree)), textAll(tree))

  // 跨窗口保存（另一窗口把来源改回 connect）：本页没有 epoch 事件，只靠摘要变化
  form.publish(Object.assign({}, form.value, { codexSource: 'connect' }))
  tree = await runtime.settle({ configForm: form, wide: true })
  // [2026-11-12 批次 G] 启动占位特性后，「整行不出现」不再是正确判据：占位行（灰点 + …）
  // 允许出现（它只表示「codex 已启用、正在读取」）。真正要守的是：**不残留订阅来源的数值/错误**。
  check('B5a 跨窗口切回 connect 后，订阅来源的数值/错误行不残留（占位允许出现）',
    !/3[35]%/.test(textAll(tree)) && textAll(tree).indexOf('获取失败') === -1, textAll(tree))
  check('B5b 跨窗口切换也不整批清空（DeepSeek 仍在）', /7\.38/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// B7 — 正常来源 0% 是有效值（不是「无数据」）
// ===========================================================================
{
  const runtime = createRuntime()
  const { form } = makeForm(BASE_CFG)
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  const digest = client.module.codexSource.digest(form.value)
  globalThis.fetch = async (url) => {
    if (String(url) !== '/api/plan-usage') return { json: async () => ({ ok: false }) }
    return {
      json: async () => ({
        ok: true,
        data: {
          plans: [{
            id: 'codex', name: 'OpenAI Codex', codexSource: 'connect',
            rollingUsage: { percent: 0, resetsAt: null }, weeklyUsage: { percent: 0, resetsAt: null },
          }],
          cfg: { digest, readAt: 1, reloadable: true },
        },
      }),
    }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('B7a 0% 正常显示为 0%（不当成缺失/获取失败）',
    /0%/.test(textAll(tree)) && textAll(tree).indexOf('获取失败') === -1, textAll(tree))
  client.restore()
}

// ===========================================================================
// L — 预设凭据展平：DeepSeek Key 直接可见（没有 details 祖先）；自定义卡仍折叠
// ===========================================================================
{
  const cfg = Object.assign({}, BASE_CFG, { deepseekApiKey: 'sk-flat-fixture' })
  const ctx = openSettings(cfg)
  const tree = await ctx.settle()
  const dsKey = byAttr(tree, 'data-plan-credential', 'deepseek')
  check('L1a DeepSeek 的 Key 输入仍挂载且带原值',
    dsKey !== undefined && dsKey.type === 'input' && dsKey.props.value === 'sk-flat-fixture')
  check('L1b Key 输入**没有** details 祖先（预设渠道不再折叠）',
    !ancestors(dsKey).some((el) => el.type === 'details'),
    ancestors(dsKey).map((el) => el.type).slice(0, 6))
  check('L1c 凭据区仍是受控输入：password + autoComplete=off',
    dsKey.props.type === 'password' && dsKey.props.autoComplete === 'off')
  const holder = byAttr(tree, 'data-plan-credentials', 'deepseek')
  check('L1d 凭据容器是展平的 div（data-plan-credentials-flat=1）',
    holder !== undefined && holder.type === 'div' && holder.props['data-plan-credentials-flat'] === '1'
    && contains(holder, dsKey))
  check('L1e 旧的「连接与凭据（点开填写）」summary 已不存在',
    textAll(tree).indexOf('连接与凭据（点开填写）') === -1)
  ctx.client.restore()

  // 只读部署：Key 输入仍然 disabled（只改布局，不改权限语义）
  const ro = openSettings(cfg, {}, { writable: false })
  const roTree = await ro.settle()
  check('L2a 只读部署下 Key 输入 disabled', byAttr(roTree, 'data-plan-credential', 'deepseek').props.disabled === true)
  ro.client.restore()

  // 保存中：所有输入锁定（含来源 radio 与展平后的 Key）
  const busyCtx = openSettings(cfg, { codexSources: READY_BOTH })
  let busyTree = await busyCtx.settle()
  byAttr(busyTree, 'data-codex-source', 'subscription').props.onChange({ target: { checked: true } })
  busyTree = await busyCtx.settle()
  byButton(busyTree, '保存更改').props.onClick()
  busyTree = busyCtx.runtime.renderOnce({ form: busyCtx.form })
  const inputs = elementsOf(busyTree).filter((el) => el.type === 'input')
  check('L2b 保存中所有输入锁定（含来源 radio）',
    inputs.length > 0 && inputs.every((el) => el.props.disabled === true),
    inputs.filter((el) => el.props.disabled !== true).length)
  await new Promise((resolve) => setTimeout(resolve, 10))
  busyCtx.client.restore()

  // 自定义渠道仍保留自己的折叠结构（未动）
  const customEntry = {
    id: 'custom:codexsrc0001', name: '折叠乙', provider: 'review-fixture',
    balanceEndpoint: '/v1/credits', balancePath: 'data.balance', enabled: true,
  }
  const customCtx = openSettings(Object.assign({}, BASE_CFG, { customBalances: [customEntry] }))
  const customTree = await customCtx.settle()
  const card = byAttr(customTree, 'data-custom-id', 'custom:codexsrc0001')
  const toggle = elementsOf(card).find((el) => el.type === 'button'
    && String(el.props['aria-label'] || '').indexOf('展开') !== -1)
  check('L3a 自定义卡仍在（自己的折叠结构未动）', card !== undefined && toggle !== undefined)
  check('L3b 自定义卡折叠时编辑字段不渲染（原行为）',
    byAttr(customTree, 'id', 'custom-name-custom:codexsrc0001') === undefined)
  customCtx.client.restore()
}

// ===========================================================================
// D — 跨端摘要契约：connect 保旧摘要（不追加片段），subscription 追加固定字串
// ===========================================================================
{
  const runtime = createRuntime()
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  const src = client.module.codexSource
  check('D1a connect（含字段缺失/非法）不追加任何片段', src.digestPart({}) === ''
    && src.digestPart({ codexSource: 'connect' }) === ''
    && src.digestPart({ codexSource: 'bogus' }) === '')
  check('D1b subscription 追加逐字固定字串 builtin:codex-source + U+0002 + subscription',
    src.digestPart({ codexSource: 'subscription' }) === 'builtin:codex-source\u0002subscription')
  const base = { enabled: true, customBalances: [] }
  const dConnect = src.digest(base)
  const dMissing = src.digest(Object.assign({}, base, { codexSource: undefined }))
  const dInvalid = src.digest(Object.assign({}, base, { codexSource: 'nope' }))
  const dSub = src.digest(Object.assign({}, base, { codexSource: 'subscription' }))
  check('D2a 老配置（无字段）与显式 connect 摘要一致（保旧证明）',
    dConnect === dMissing && dConnect === dInvalid, { dConnect, dMissing, dInvalid })
  check('D2b subscription 的摘要与 connect 不同（跨窗口保存能生效）', dSub !== dConnect, { dSub, dConnect })
  check('D3a 规范化：缺失/非法 → connect，subscription 原样', src.normalize(undefined) === 'connect'
    && src.normalize('subscription') === 'subscription' && src.normalize('Connect') === 'connect')
  check('D3b 身份带内置 codex 前缀（用于 UI prune）',
    src.identity({ codexSource: 'subscription' }) === 'builtin:codex\u0002subscription'
    && src.identityMap({ codexSource: 'connect' }).codex === 'builtin:codex\u0002connect')
  check('D4a 老 wire 缺 codexSource 视为 connect', src.fromWire({ id: 'codex' }) === 'connect')
  check('D4b parsePayload：信封不合法一律 error（不猜未启用）',
    src.parsePayload(null).state === 'error'
    && src.parsePayload({ ok: false }).state === 'error'
    && src.parsePayload({ ok: true, data: { sources: 'x' } }).state === 'error')
  client.restore()
}

// ===========================================================================
// V — 跨端摘要向量：客户端 configDigestOfClient **必须**逐字等于 Host configDigestOf
// ===========================================================================
//
// [终审 B1 整改] 两边 `parts` 的**顺序**必须相同：codex 来源组件在**自定义条目之前**。
// 只验「Host 自己的期望值」（G8d）或只验空 `customBalances`（D2）都抓不到位置错位，
// 所以这里直接 `import` Host 的 `configDigestOf()`，对同一批配置两端各算一次再比较。
//
// ⚠️ 这段 import 依赖 `@deepseek-ai/schemastery`（AGENTS §4：仓库 node_modules 已有）。
// 缺包时 V0 **显式失败**（不是 SKIP）——跳过就等于没测 B1。
{
  let hostDigestOf = null
  let hostNormalize = null
  let importError = null
  try {
    const customBalance = await import('../plans/custom-balance.js')
    hostDigestOf = customBalance.configDigestOf
    const sources = await import('../plans/codex-sources.js')
    hostNormalize = sources.normalizeCodexSource
  } catch (err) {
    importError = err
  }
  check('V0 Host configDigestOf / normalizeCodexSource 可 import（缺依赖会在这里失败，不跳过）',
    typeof hostDigestOf === 'function' && typeof hostNormalize === 'function',
    importError === null ? 'imported but not functions' : String(importError && importError.message))

  const runtime = createRuntime()
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  const src = client.module.codexSource

  // 一条合法自定义条目：url 带首尾空格、credentialHost 大写 —— 顺带守住 X1 的规范化同构。
  const row = {
    id: 'custom:codexvect0001',
    name: '向量甲',
    provider: 'vector',
    balanceEndpoint: '/v1/credits',
    url: ' https://v.example/b ',
    balancePath: 'data.balance',
    subtractPath: 'data.used',
    currency: 'usd',
    credentialRef: 'ref-vector',
    credentialHost: 'V.Example.COM',
    enabled: true,
  }
  const rev = { 'custom:codexvect0001': 2 }
  const vectors = [
    ['V1 无自定义条目 + 缺省来源', { customBalances: [], customKeyRev: {} }],
    ['V2 无自定义条目 + subscription', { customBalances: [], customKeyRev: {}, codexSource: 'subscription' }],
    ['V3 有自定义条目 + subscription（B1 位置错位的主用例）',
      { customBalances: [row], customKeyRev: rev, codexSource: 'subscription' }],
    ['V4 有自定义条目 + orphan 修订 + subscription',
      { customBalances: [row], customKeyRev: { 'custom:codexvect0001': 2, 'custom:codexvect0002': 5 }, codexSource: 'subscription' }],
    ['V5 有自定义条目 + connect（保旧摘要）',
      { customBalances: [row], customKeyRev: rev, codexSource: 'connect' }],
    ['V6 有自定义条目 + 非规范写法 " Subscription "（N1 与 B1 的组合）',
      { customBalances: [row], customKeyRev: rev, codexSource: ' Subscription ' }],
  ]
  for (const [name, cfg] of vectors) {
    const hostValue = typeof hostDigestOf === 'function' ? hostDigestOf(cfg) : null
    const clientValue = src.digest(cfg)
    check(name + '：双端摘要逐字相等', hostValue !== null && clientValue === hostValue,
      { clientValue, hostValue })
  }
  // 顺序错的另一半证据：订阅态的摘要必须与同配置的 connect 摘要不同（组件确实参与）。
  check('V7 同一配置 subscription 与 connect 摘要不同（组件确实参与摘要）',
    src.digest(vectors[2][1]) !== src.digest(vectors[4][1]),
    { sub: src.digest(vectors[2][1]), connect: src.digest(vectors[4][1]) })

  // --- N1：客户端归一必须与 Host 逐值同结果（trim + 小写；非字符串一律 connect） ---
  const normCases = ['subscription', ' Subscription ', 'SUBSCRIPTION', 'connect', 'CONNECT', '', '   ', null, undefined, 42, { x: 1 }, ['subscription']]
  const normMismatch = normCases.filter((raw) => {
    const mine = src.normalize(raw)
    const host = typeof hostNormalize === 'function' ? hostNormalize(raw) : null
    return host === null || mine !== host
  })
  check('N1a 客户端 normalize 与 Host 逐值同结果（含 trim/大小写/非字符串）',
    normMismatch.length === 0, normMismatch.map((raw) => ({ raw, mine: src.normalize(raw) })))
  check("N1b 'subscription' / ' Subscription ' / 'SUBSCRIPTION' ⇒ subscription",
    src.normalize('subscription') === 'subscription' && src.normalize(' Subscription ') === 'subscription'
    && src.normalize('SUBSCRIPTION') === 'subscription')
  check("N1c 'connect' / '' / null / {x:1} ⇒ connect",
    src.normalize('connect') === 'connect' && src.normalize('') === 'connect'
    && src.normalize(null) === 'connect' && src.normalize({ x: 1 }) === 'connect')
  // 归一口径不同会从**摘要**漏出来：非规范写法必须与规范写法同值（两端都是）。
  check('N1d " Subscription " 的摘要与 "subscription" 相同（两端归一一致）',
    src.digest(vectors[5][1]) === src.digest(vectors[2][1]),
    { padded: src.digest(vectors[5][1]), plain: src.digest(vectors[2][1]) })
  client.restore()
}

// ===========================================================================
// RV — 作废（revoked / cancelled）行必须保留来源身份，否则订阅态整行消失
// ===========================================================================
//
// [终审 N2 整改] Host 的 `guiObservationWire()` 作废行原先不带 `codexSource`：
// 渲染层会滤掉「wire 来源 ≠ 已保存来源」的行 ⇒ 订阅态下这行**整行消失**，
// 而不是显示「本次采集已作废」。这里成对验证：
//   RV1 带来源 ⇒ 行在；RV2 缺来源 ⇒ 行被滤掉（证明该字段确实是这行的生杀开关）。
{
  const runtime = createRuntime()
  const { form } = makeForm(Object.assign({}, BASE_CFG, { codexSource: 'subscription' }))
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  const digest = client.module.codexSource.digest(form.value)
  const deepseekWire = { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 }
  const revokedWire = (source) => Object.assign({
    id: 'codex',
    name: 'OpenAI Codex',
    error: 'cancelled',
    cancelled: true,
    transient: false,
    stale: true,
    message: '本次采集已作废，等待最新额度',
    effectiveStatus: 'pending',
    failCount: 0,
  }, source === null ? {} : { codexSource: source })
  const plans = { ref: [deepseekWire, revokedWire('subscription')] }
  globalThis.fetch = async (url) => {
    if (String(url) !== '/api/plan-usage') return { json: async () => ({ ok: false }) }
    return { json: async () => ({ ok: true, data: { plans: plans.ref, cfg: { digest, readAt: Date.now(), reloadable: true } } }) }
  }
  const refresh = async () => {
    if (typeof client.windowEvents.dispatch === 'function') client.windowEvents.dispatch('focus')
    await new Promise((resolve) => setTimeout(resolve, 30))
    return runtime.settle({ configForm: form, wide: true })
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('RV1a 作废行带 codexSource 时仍然渲染（订阅态下不整行消失）',
    textAll(tree).indexOf('OpenAI Codex') !== -1, textAll(tree))
  check('RV1b 作废行显示失败态而不是数字（不伪造 0%）',
    /获取失败/.test(textAll(tree)) && !/%/.test(textAll(tree)), textAll(tree))
  check('RV1c 其它渠道不受牵连', /7\.38/.test(textAll(tree)), textAll(tree))

  plans.ref = [deepseekWire, revokedWire(null)]
  tree = await refresh()
  // [2026-11-12 批次 G] 同上：占位行允许出现，但作废行**不得**以「数据/失败」形态上屏。
  check('RV2a 作废行缺 codexSource 时不会被当成另一来源的数据行（占位允许出现）',
    textAll(tree).indexOf('本次采集已作废') === -1 && !/%/.test(textAll(tree))
    && textAll(tree).indexOf('获取失败') === -1, textAll(tree))
  check('RV2b 隐藏该行不牵连其它渠道', /7\.38/.test(textAll(tree)), textAll(tree))
  client.restore()
}

console.log('')
console.log((pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
// 与仓库其它浏览器半测试一致：显式退出，避免残留的 40s 请求超时计时器把进程挂住。
process.exit(fail === 0 ? 0 : 1)







