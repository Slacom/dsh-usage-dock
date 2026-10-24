/**
 * [2026-10-23 UI 微调] 额度策略块的**布局层级**：必须是所在卡片内部的缩进从属块，
 * 不是与渠道名称行平级的另一张卡（原来通栏 borderTop + 左对齐）。
 *
 * 真实 client.js + mock React；只断言结构与样式，不新增功能。
 * 用法：node tools/test-policy-block-layout.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 500))) }
}

/** 收集元素（展开一层函数组件；与 mock 的单根渲染配合）。 */
function elementsOf (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
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
const byAria = (tree, label) => elementsOf(tree).find((el) => el.props && el.props['aria-label'] === label)

const BASE = {
  enabled: true,
  planOrder: '[]',
  quotaPolicyEnabled: true,
  quotaTrustRouteOrder: true,
  quotaFocusChannels: '[]',
  quotaChannelThresholds: '',
}
const CAPS = {
  codex: { status: 'ok', windows: [{ key: 'rolling-5h', percent: 90 }, { key: 'weekly', percent: 60 }], unit: null, currency: null, sampledAt: 1 },
  workbuddy: { status: 'ok', windows: [], unit: 'credits', currency: null },
  deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 },
}

function open (value) {
  const runtime = createRuntime()
  const writes = []
  const mutations = []
  const form = {
    value: Object.assign({}, BASE, value),
    getSnapshot () { return { value: this.value, writable: true } },
    subscribe () { return () => {} },
    set (f, v) { writes.push({ f, v }); this.value = Object.assign({}, this.value, { [f]: v }); return Promise.resolve(true) },
    mutate (ops) { mutations.push(ops); for (const op of ops) if (op.path.length === 1 && op.op === 'set') this.value = Object.assign({}, this.value, { [op.path[0]]: op.value }); return Promise.resolve(true) },
  }
  const client = loadClient(runtime, { form, quotaWindows: CAPS })
  runtime.mount(client.SettingsPage, { form })
  return { runtime, form, client, writes, mutations }
}

/** 沿 parentElement 上溯（mock 在渲染后为子元素补了这条链）。 */
function ancestors (node) {
  const out = []
  let cur = node ? node.parentElement : null
  while (cur) { out.push(cur); cur = cur.parentElement }
  return out
}
function contains (node, target) {
  if (!node || !target) return false
  return elementsOf(node).indexOf(target) !== -1
}

// ===========================================================================
// D1 — 内置渠道：策略块确实在**自己的卡片**内部，且位于名称行之后
// ===========================================================================
{
  const c = open({ quotaFocusChannels: '["codex"]' })
  const tree = await c.runtime.settle({ form: c.form })
  const block = byAttr(tree, 'data-policy-block', 'codex')
  const upArrow = byAria(tree, 'OpenAI Codex 上移')
  check('D1a 找到 Codex 的策略块与卡片标记', block !== undefined && upArrow !== undefined)
  /**
   * [2026-10-24 布局重做：有意适配选择器] 卡片不再是"上分隔线"样式，
   * 改成统一的轻边框卡片容器（新增稳定标记 `data-plan-card`）。语义断言不变：
   * 策略块必须是**同一张卡片的后代**、排在名称行之后。
   */
  const card = ancestors(upArrow).find((el) => el.props && el.props['data-plan-card'] === 'codex')
  check('D1b 策略块是卡片**后代**（同一张卡内）',
    card !== undefined && block !== undefined && contains(card, block), { hasCard: card !== undefined })
  check('D1c 策略块不是与卡片平级的兄弟节点', block !== undefined && ancestors(block).indexOf(card) !== -1)
  // 名称行（渠道名 + ▲▼）必须在块之前出现
  const cardKids = card !== undefined && Array.isArray(card.props.children) ? card.props.children : []
  const blockIndex = cardKids.indexOf(block)
  const nameRowIndex = cardKids.findIndex((k) => k && k.props && k.props.style && k.props.style.alignItems === 'center')
  check('D1d 策略块排在名称行之后（从属而非平级）',
    blockIndex > 0 && nameRowIndex !== -1 && blockIndex > nameRowIndex, { blockIndex, nameRowIndex })
  c.client.restore()
}

// ===========================================================================
// D2 — 样式：左缩进 + 左侧细边 + 浅背景 + 内距；**没有**通栏顶边；不写固定总宽
// ===========================================================================
{
  const c = open({ quotaFocusChannels: '["codex"]' })
  const tree = await c.runtime.settle({ form: c.form })
  const style = byAttr(tree, 'data-policy-block', 'codex').props.style || {}
  check('D2a 左缩进 ≥ 20px（相对名称行右移）', typeof style.marginLeft === 'number' && style.marginLeft >= 20, style.marginLeft)
  check('D2b 轻量左侧边存在', typeof style.borderLeft === 'string' && style.borderLeft.length > 0, style.borderLeft)
  check('D2c 没有通栏顶边/底边（不再像另一张卡）', !style.borderTop && !style.borderBottom, { top: style.borderTop, bottom: style.borderBottom })
  check('D2d 浅背景 + 内距', typeof style.background === 'string' && style.background.indexOf('--dsw-alias-bg-layer-2') !== -1
    && typeof style.padding === 'string' && style.padding.length > 0, { bg: style.background, padding: style.padding })
  check('D2e 窄宽度安全：boxSizing/minWidth，且**不写**固定总宽',
    style.boxSizing === 'border-box' && style.minWidth === 0 && style.width === undefined && style.maxWidth === undefined,
    { boxSizing: style.boxSizing, minWidth: style.minWidth, width: style.width, maxWidth: style.maxWidth })
  c.client.restore()
}

// ===========================================================================
// D3 — 行内仍保留 flexWrap（窄宽度换行，不产生水平溢出）
// ===========================================================================
{
  const c = open({ quotaFocusChannels: '["codex","workbuddy","deepseek"]' })
  const tree = await c.runtime.settle({ form: c.form })
  const winRow = byAttr(tree, 'data-policy-window', 'rolling-5h')
  const focusRow = byAttr(tree, 'data-policy-focus', 'codex').parentElement
  const statusRow = byAttr(tree, 'data-policy-status', 'codex')
  check('D3a 窗口行可换行', winRow !== undefined && winRow.props.style.flexWrap === 'wrap')
  check('D3b 关注行不写固定宽度、不强制 nowrap（窄宽度不会溢出）',
    focusRow !== undefined && focusRow.props.style.width === undefined
    && focusRow.props.style.minWidth === undefined && focusRow.props.style.whiteSpace !== 'nowrap',
    focusRow && focusRow.props.style)
  check('D3d 关注行在策略块内部（不是卡片顶层）',
    focusRow !== undefined && ancestors(focusRow).some((el) => el.props && el.props['data-policy-block'] === 'codex'))
  check('D3c 状态行不带固定宽度', statusRow !== undefined && statusRow.props.style.width === undefined)
  c.client.restore()
}

// ===========================================================================
// D4 — 行为不变：未关注→勾选只改 focus；保存中锁定；放弃还原
// ===========================================================================
{
  const c = open({})
  let tree = await c.runtime.settle({ form: c.form })
  const box0 = byAttr(tree, 'data-policy-focus', 'codex')
  check('D4a 未关注时块内没有阈值输入',
    box0.props.checked === false && byAttr(tree, 'data-policy-warning', 'codex|weekly') === undefined)
  box0.props.onChange({ target: { checked: true } })
  tree = await c.runtime.settle({ form: c.form })
  check('D4b 勾选只进草稿（保存前不改表单）', c.form.value.quotaFocusChannels === '[]')
  check('D4c 勾选后出现该渠道阈值输入', byAttr(tree, 'data-policy-warning', 'codex|weekly') !== undefined)
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '30' } })
  tree = await c.runtime.settle({ form: c.form })
  const saveBtn = elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === '保存更改')
  saveBtn.props.onClick()
  tree = await c.runtime.settle({ form: c.form })
  check('D4d 保存后两个字段都写入（focus + 阈值）',
    JSON.parse(c.form.value.quotaFocusChannels).indexOf('codex') !== -1
    && JSON.parse(c.form.value.quotaChannelThresholds).codex.windows.weekly.warning === 30,
    { focus: c.form.value.quotaFocusChannels, th: c.form.value.quotaChannelThresholds })
  c.client.restore()

  const c2 = open({})
  let tree2 = await c2.runtime.settle({ form: c2.form })
  byAttr(tree2, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree2 = await c2.runtime.settle({ form: c2.form })
  elementsOf(tree2).find((el) => el.type === 'button' && textOf(el) === '放弃更改').props.onClick()
  tree2 = await c2.runtime.settle({ form: c2.form })
  check('D4e 放弃后回到未关注（块内输入消失）',
    byAttr(tree2, 'data-policy-focus', 'codex').props.checked === false
    && byAttr(tree2, 'data-policy-warning', 'codex|weekly') === undefined)
  c2.client.restore()
}

// ===========================================================================
// D5 — 保存中锁定：块内输入/复选框全部 disabled
// ===========================================================================
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const runtime = createRuntime()
  const form = {
    value: Object.assign({}, BASE, { quotaFocusChannels: '["codex"]' }),
    getSnapshot () { return { value: this.value, writable: true } },
    subscribe () { return () => {} },
    set () { return gate.then(() => true) },
    mutate () { return gate.then(() => true) },
  }
  const client = loadClient(runtime, { form, quotaWindows: CAPS })
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '25' } })
  tree = await runtime.settle({ form })
  elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === '保存更改').props.onClick()
  tree = runtime.renderOnce({ form })
  const block = byAttr(tree, 'data-policy-block', 'codex')
  const inputs = elementsOf(block).filter((el) => el.type === 'input')
  check('D5a 保存中块内输入全部锁定', inputs.length > 0 && inputs.every((el) => el.props.disabled === true),
    inputs.filter((el) => el.props.disabled !== true).length)
  release()
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.restore()
}

// ===========================================================================
// D6 — 自定义余额卡：策略块同样在**同一张自定义卡**容器内、样式一致
// ===========================================================================
{
  const entry = { id: 'custom:layout00001', name: '布局甲', provider: 'review-fixture', balanceEndpoint: '/v1/credits', balancePath: 'data.balance', enabled: true }
  const c = open({ quotaFocusChannels: '["custom:layout00001"]', customBalances: [entry] })
  const tree = await c.runtime.settle({ form: c.form })
  // 单条模式：一张卡 = 一个 data-custom-balances 容器（内部含 data-custom-id 与策略块）
  const container = elementsOf(tree).find((el) => el.props && el.props['data-custom-balances'] !== undefined
    && elementsOf(el).some((x) => x.props && x.props['data-custom-id'] === 'custom:layout00001'))
  const block = container !== undefined ? elementsOf(container).find((el) => el.props && el.props['data-policy-block'] === 'custom:layout00001') : undefined
  check('D6a 自定义卡策略块在同一卡片容器内', container !== undefined && block !== undefined)
  const cardStyle = block === undefined ? null : block.props.style || {}
  check('D6b 自定义卡策略块用同一套从属样式（缩进/左边界/无顶边）',
    cardStyle !== null && cardStyle.marginLeft >= 20 && !!cardStyle.borderLeft && !cardStyle.borderTop
    && cardStyle.boxSizing === 'border-box' && cardStyle.width === undefined, cardStyle)
  check('D6c 自定义卡原有字段仍在', byAttr(tree, 'data-policy-focus', 'custom:layout00001') !== undefined
    || elementsOf(tree).some((el) => el.props && el.props['data-custom-id'] === 'custom:layout00001'))
  c.client.restore()
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
