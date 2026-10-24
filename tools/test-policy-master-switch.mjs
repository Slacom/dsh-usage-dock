/**
 * [2026-10-23 单总开关] 额度策略总开关：旧组合兼容 + 成对写入 + 不静默迁移。
 *
 * 契约（PLAN.md）：顶部只有一个总开关，代表**完整授权**（policy 与 trust 都严格 true）。
 * 旧 `true/false`（含缺字段/坏类型）只提示"未完整启用"，渲染/effect/无关保存都不得补写';
 * 只有用户显式点开才成对置 true（同一 mutate、只提交变化字段、不夹带其它字段）。
 *
 * 真实 client.js + mock React。用法：node tools/test-policy-master-switch.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 500))) }
}
function elementsOf (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
  if (Array.isArray(node)) { for (const n of node) elementsOf(n, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'string') { out.push(node); elementsOf(node.props ? node.props.children : undefined, out, depth + 1) } else if (typeof node.type === 'function') {
    let rendered
    try { rendered = node.type(node.props) } catch (err) { return out }
    if (rendered !== undefined) elementsOf(rendered, out, depth + 1)
  }
  return out
}
const byAttr = (tree, attr, value) => elementsOf(tree).find((el) => el.props && el.props[attr] === value)
const textAll = (tree) => elementsOf(tree).map((el) => textOf(el)).join('')
const byButton = (tree, text) => elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === text)
const byAria = (tree, label) => elementsOf(tree).find((el) => el.props && el.props['aria-label'] === label)

const BASE = { enabled: true, planOrder: '[]', quotaFocusChannels: '[]', quotaChannelThresholds: '' }
const CAPS = { codex: { status: 'ok', windows: [{ key: 'weekly', percent: 60 }], unit: null, currency: null, sampledAt: 1 } }

function open (value, options) {
  const opts = options || {}
  const runtime = createRuntime()
  const mutations = []
  const writes = []
  const form = {
    value: Object.assign({}, BASE, value || {}),
    writable: opts.writable !== false,
    getSnapshot () { return { value: this.value, writable: this.writable } },
    subscribe () { return () => {} },
    set (f, v) { writes.push({ f, v }); this.value = Object.assign({}, this.value, { [f]: v }); return Promise.resolve(true) },
    mutate (ops) {
      mutations.push(ops)
      if (!opts.gate) for (const op of ops) if (op.path.length === 1 && op.op === 'set') this.value = Object.assign({}, this.value, { [op.path[0]]: op.value })
      return opts.gate ? opts.gate.then(() => true) : Promise.resolve(true)
    },
  }
  const client = loadClient(runtime, { form, quotaWindows: CAPS })
  runtime.mount(client.SettingsPage, { form })
  return { runtime, form, client, mutations, writes }
}
const settle = (ctx) => ctx.runtime.settle({ form: ctx.form })

// ===========================================================================
// M1 — 四种旧组合 + 缺字段/坏类型：显示正确、渲染零写
// ===========================================================================
{
  /**
   * [2026-10-24 布局重做：有意适配] 状态文字从"总览行"移到紧凑头部的中性状态标签
   * （`data-policy-state` = on/incomplete/off，标签文本仍含"已启用/未完整启用/未启用"）。
   * 语义断言不变：勾选值 + 状态 + 是否显示"未完整启用"提示。
   */
  const cases = [
    { name: 'M1a 旧 false/false = 未启用', value: { quotaPolicyEnabled: false, quotaTrustRouteOrder: false }, checked: false, state: 'off', chip: '未启用', notice: false },
    { name: 'M1b 旧 true/true = 已启用', value: { quotaPolicyEnabled: true, quotaTrustRouteOrder: true }, checked: true, state: 'on', chip: '已启用', notice: false },
    { name: 'M1c 旧 true/false = 未完整启用（提示但不写回）', value: { quotaPolicyEnabled: true, quotaTrustRouteOrder: false }, checked: false, state: 'incomplete', chip: '未完整启用', notice: true },
    { name: 'M1d 旧 false/true = 仍关闭', value: { quotaPolicyEnabled: false, quotaTrustRouteOrder: true }, checked: false, state: 'off', chip: '未启用', notice: false },
    { name: 'M1e 缺 trust 字段（policy=true）= 未完整启用', value: { quotaPolicyEnabled: true }, checked: false, state: 'incomplete', chip: '未完整启用', notice: true },
    { name: 'M1f 坏类型 trust（policy=true）= 未完整启用', value: { quotaPolicyEnabled: true, quotaTrustRouteOrder: 'true' }, checked: false, state: 'incomplete', chip: '未完整启用', notice: true },
    { name: 'M1g 坏类型 policy（字符串）= 未启用', value: { quotaPolicyEnabled: 'true', quotaTrustRouteOrder: true }, checked: false, state: 'off', chip: '未启用', notice: false },
  ]
  for (const c of cases) {
    const ctx = open(c.value)
    const tree = await settle(ctx)
    const master = byAttr(tree, 'data-policy-master', '1')
    const stateEl = byAttr(tree, 'data-policy-state', c.state)
    const chipText = stateEl === undefined ? '' : textAll(stateEl)
    check(c.name,
      master !== undefined && master.props.checked === c.checked
      && stateEl !== undefined && chipText.indexOf(c.chip) !== -1
      && (byAttr(tree, 'data-policy-legacy-incomplete', '1') !== undefined) === c.notice,
      { checked: master && master.props.checked, chipText, notice: byAttr(tree, 'data-policy-legacy-incomplete', '1') !== undefined })
    check(c.name + '：渲染不写任何字段', ctx.mutations.length === 0 && ctx.writes.length === 0
      && ctx.form.value.quotaTrustRouteOrder === (Object.prototype.hasOwnProperty.call(c.value, 'quotaTrustRouteOrder') ? c.value.quotaTrustRouteOrder : undefined))
    ctx.client.restore()
  }
}

// ===========================================================================
// M2 — 未完整状态：保存**无关改动**也不迁移 trust
//
// [2026-10-24 契约变更] 半启用（policy=true/trust=false）时渠道策略块整块隐藏，
// 所以"无关改动"改用**始终可见**的排序箭头（planOrder），仍能验证"保存其它字段
// 不会顺手把 trust 升级"。
// ===========================================================================
{
  const ctx = open({ quotaPolicyEnabled: true, quotaTrustRouteOrder: false, quotaFocusChannels: '["codex"]' })
  let tree = await settle(ctx)
  const up = byAria(tree, 'OpenAI Codex 上移')
  check('M2a0 半启用态渠道块已隐藏、排序箭头可见',
    byAttr(tree, 'data-policy-block', 'codex') === undefined && up !== undefined)
  up.props.onClick()
  tree = await settle(ctx)
  byButton(tree, '保存更改').props.onClick()
  tree = await settle(ctx)
  const ops = ctx.mutations[0] || []
  check('M2a 无关保存只写 planOrder，不改 trust/policy',
    ops.length === 1 && ops[0].path[0] === 'planOrder', ops.map((o) => o.path))
  check('M2b trust 仍是旧的 false（没被静默升级）', ctx.form.value.quotaTrustRouteOrder === false)
  check('M2c policy 仍是 true（没被顺手关掉）', ctx.form.value.quotaPolicyEnabled === true)
  check('M2d 保存后仍显示未完整启用提示',
    byAttr(tree, 'data-policy-legacy-incomplete', '1') !== undefined, textAll(tree).slice(0, 400))
  ctx.client.restore()
}

// ===========================================================================
// M3 — 用户显式打开：同一 mutate 成对写 true，只提交变化字段，不夹带其它
// ===========================================================================
{
  const ctx = open({ quotaPolicyEnabled: false, quotaTrustRouteOrder: false, quotaFocusChannels: '["codex"]', quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }) })
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  check('M3a 草稿阶段仍不改表单', ctx.form.value.quotaPolicyEnabled === false && ctx.form.value.quotaTrustRouteOrder === false)
  // [2026-10-24 布局适配] "已启用"文字移到了头部状态标签（data-policy-state=on），语义不变。
  check('M3b 草稿勾选后 UI 立即显示已启用', byAttr(tree, 'data-policy-master', '1').props.checked === true
    && byAttr(tree, 'data-policy-state', 'on') !== undefined
    && textAll(byAttr(tree, 'data-policy-state', 'on')).indexOf('已启用') !== -1)
  byButton(tree, '保存更改').props.onClick()
  await settle(ctx)
  const ops = ctx.mutations[0] || []
  const fields = ops.map((o) => o.path[0]).sort()
  check('M3c 一次 mutate 成对写两个字段', ctx.mutations.length === 1 && fields.join(',') === 'quotaPolicyEnabled,quotaTrustRouteOrder', fields)
  check('M3d 两个值都是 true', ops.every((o) => o.value === true))
  check('M3e 不夹带 focus/阈值/凭据',
    fields.every((f) => f === 'quotaPolicyEnabled' || f === 'quotaTrustRouteOrder'))
  check('M3f 没有 secret 写入', fields.every((f) => f !== 'customKeys' && f !== 'customKeyRev'))
  ctx.client.restore()
}

// ===========================================================================
// M4 — 显式关闭：成对 false
// ===========================================================================
{
  const ctx = open({ quotaPolicyEnabled: true, quotaTrustRouteOrder: true })
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: false } })
  tree = await settle(ctx)
  byButton(tree, '保存更改').props.onClick()
  await settle(ctx)
  const ops = ctx.mutations[0] || []
  check('M4a 一次 mutate 成对写 false',
    ops.length === 2 && ops.every((o) => o.value === false)
    && ops.map((o) => o.path[0]).sort().join(',') === 'quotaPolicyEnabled,quotaTrustRouteOrder', ops)
  ctx.client.restore()
}

// ===========================================================================
// M5 — 同批：开关 + focus 改动都不丢（一次 mutate）
// ===========================================================================
{
  const ctx = open({ quotaFocusChannels: '[]' })
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  byAttr(tree, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  byButton(tree, '保存更改').props.onClick()
  await settle(ctx)
  const ops = ctx.mutations[0] || []
  const fields = ops.map((o) => o.path[0]).sort()
  check('M5a 开关与 focus 同批都写入', fields.join(',') === 'quotaFocusChannels,quotaPolicyEnabled,quotaTrustRouteOrder', fields)
  check('M5b 只有一次 mutate', ctx.mutations.length === 1)
  check('M5c 表单最终状态成对 true 且含 codex',
    ctx.form.value.quotaPolicyEnabled === true && ctx.form.value.quotaTrustRouteOrder === true
    && JSON.parse(ctx.form.value.quotaFocusChannels).indexOf('codex') !== -1)
  ctx.client.restore()
}

// ===========================================================================
// M6 — 放弃：回到原状态，不落盘
// ===========================================================================
{
  const ctx = open({ quotaPolicyEnabled: false, quotaTrustRouteOrder: false })
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  byButton(tree, '放弃更改').props.onClick()
  tree = await settle(ctx)
  check('M6a 放弃后复选框回到未勾选', byAttr(tree, 'data-policy-master', '1').props.checked === false)
  check('M6b 放弃不写任何字段', ctx.mutations.length === 0 && ctx.writes.length === 0
    && ctx.form.value.quotaPolicyEnabled === false)
  ctx.client.restore()
}

// ===========================================================================
// M7 — 只读 / 保存中锁
// ===========================================================================
{
  const ro = open({ quotaPolicyEnabled: false, quotaTrustRouteOrder: false }, { writable: false })
  const roTree = await settle(ro)
  check('M7a 只读部署：总开关禁用', byAttr(roTree, 'data-policy-master', '1').props.disabled === true)
  ro.client.restore()

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = open({ quotaPolicyEnabled: false, quotaTrustRouteOrder: false, quotaFocusChannels: '["codex"]' }, { gate })
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = runtimeSettleSync(ctx)
  byButton(tree, '保存更改').props.onClick()
  tree = ctx.runtime.renderOnce({ form: ctx.form })
  check('M7b 保存中总开关禁用', byAttr(tree, 'data-policy-master', '1').props.disabled === true)
  release()
  await new Promise((resolve) => setTimeout(resolve, 5))
  ctx.client.restore()
}
function runtimeSettleSync (ctx) { return ctx.runtime.renderOnce({ form: ctx.form }) }

// ===========================================================================
// M8 — 卡片状态与总开关用同一"完整授权"定义
// ===========================================================================
{
  /**
   * [2026-10-24 契约变更] 未完整启用时渠道策略块**整块隐藏**（用户新要求），
   * 因此"状态如实说明"从卡片内移到**全局**：不再有卡片内状态行，只有全局"未完整启用"提示。
   * 断言仍保证：不显示任何卡片状态、不宣称已参与、且全局提示存在。
   */
  const partial = open({ quotaPolicyEnabled: true, quotaTrustRouteOrder: false, quotaFocusChannels: '["codex"]', quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }) })
  const partialTree = await settle(partial)
  check('M8a 未完整启用：卡片状态不渲染、全局给"未完整启用"提示、不宣称已参与',
    byAttr(partialTree, 'data-policy-status', 'codex') === undefined
    && byAttr(partialTree, 'data-policy-block', 'codex') === undefined
    && byAttr(partialTree, 'data-policy-legacy-incomplete', '1') !== undefined
    && textAll(partialTree).indexOf('未完整启用') !== -1
    && textAll(partialTree).indexOf('已参与') === -1, textAll(partialTree).slice(0, 400))
  partial.client.restore()

  const on = open({ quotaPolicyEnabled: true, quotaTrustRouteOrder: true, quotaFocusChannels: '["codex"]', quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }) })
  const onTree = await settle(on)
  check('M8b 完整启用后卡片状态正常参与',
    textAll(byAttr(onTree, 'data-policy-status', 'codex')).indexOf('已参与') === 0,
    textAll(byAttr(onTree, 'data-policy-status', 'codex')))
  on.client.restore()
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
