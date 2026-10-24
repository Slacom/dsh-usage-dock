/**
 * [2026-10-24 用户需求] 总开关关闭时，渠道级「关注额度策略」整块隐藏。
 *
 * 真实 client.js + mock React。断言：默认关闭/旧半启用 → 全部渠道（含自定义）都无策略块；
 * 开启 → 恢复全部卡片；草稿开关不写表单、不清 focus/阈值；关闭后保存只改授权 pair；
 * 放弃恢复；开启后同批改动不丢；只读/保存中锁；隐藏态的坏草稿错误提升到全局可见。
 *
 * 用法：node tools/test-policy-hidden-when-off.mjs
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
const allBlocks = (tree) => elementsOf(tree).filter((el) => el.props && el.props['data-policy-block'] !== undefined)
const textAll = (tree) => elementsOf(tree).map((el) => textOf(el)).join('')
const byButton = (tree, text) => elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === text)

const CAPS = {
  codex: { status: 'ok', windows: [{ key: 'weekly', percent: 60 }], unit: null, currency: null, sampledAt: 1 },
  workbuddy: { status: 'ok', windows: [], unit: 'credits', currency: null },
  deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 },
  'custom:hidden0001': { status: 'ok', windows: [], unit: 'currency', currency: 'USD', sampledAt: 1 },
}
const CUSTOM = { id: 'custom:hidden0001', name: '隐藏甲', provider: 'review-fixture', balanceEndpoint: '/v1/credits', balancePath: 'data.balance', enabled: true }

function open (value, options) {
  const opts = options || {}
  const runtime = createRuntime()
  const mutations = []
  const writes = []
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]' }, value || {}),
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

const FULL = {
  quotaPolicyEnabled: true,
  quotaTrustRouteOrder: true,
  quotaFocusChannels: '["codex","custom:hidden0001"]',
  quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
  customBalances: [CUSTOM],
}

// ===========================================================================
// H1 — 默认关闭：所有渠道（内置 + 自定义）都没有策略块
// ===========================================================================
{
  const ctx = open(Object.assign({}, FULL, { quotaPolicyEnabled: false, quotaTrustRouteOrder: false }))
  const tree = await settle(ctx)
  check('H1a 关闭态没有任何渠道策略块', allBlocks(tree).length === 0)
  check('H1b 关闭态没有关注复选框', elementsOf(tree).filter((el) => el.props && el.props['data-policy-focus'] !== undefined).length === 0)
  check('H1c 关闭态没有阈值输入', elementsOf(tree).filter((el) => el.props && (el.props['data-policy-warning'] !== undefined || el.props['data-policy-closing'] !== undefined)).length === 0)
  check('H1d 关闭态没有状态行', elementsOf(tree).filter((el) => el.props && el.props['data-policy-status'] !== undefined).length === 0)
  check('H1e 总开关与总览仍在', byAttr(tree, 'data-policy-master', '1') !== undefined && byAttr(tree, 'data-policy-summary', '1') !== undefined)
  check('H1f 渠道监控/凭据字段/自定义卡片本身仍在',
    elementsOf(tree).some((el) => el.props && el.props['data-custom-id'] === 'custom:hidden0001')
    && textAll(tree).indexOf('Xiaomi MiMo') !== -1)
  check('H1g 渲染不写任何字段', ctx.mutations.length === 0 && ctx.writes.length === 0)
  ctx.client.restore()
}

// ===========================================================================
// H2 — 旧半启用（policy=true, trust=false）：同样全部隐藏 + 全局提示
// ===========================================================================
{
  const ctx = open(Object.assign({}, FULL, { quotaTrustRouteOrder: false }))
  const tree = await settle(ctx)
  check('H2a 旧 true/false 也隐藏全部策略块', allBlocks(tree).length === 0)
  check('H2b 仍有"未完整启用"提示', byAttr(tree, 'data-policy-legacy-incomplete', '1') !== undefined)
  check('H2c 渲染不写任何字段（不自动补 trust）', ctx.mutations.length === 0 && ctx.writes.length === 0
    && ctx.form.value.quotaTrustRouteOrder === false)
  ctx.client.restore()
}

// ===========================================================================
// H3 — 开启：全部卡片恢复（内置 + 自定义）
// ===========================================================================
{
  const ctx = open(FULL)
  const tree = await settle(ctx)
  const blocks = allBlocks(tree).map((el) => el.props['data-policy-block'])
  check('H3a 开启态恢复全部策略块（5 内置 + 1 自定义）', blocks.length === 6, blocks)
  check('H3b 含自定义渠道块', blocks.indexOf('custom:hidden0001') !== -1)
  check('H3c 原有 focus 与阈值显示保留',
    byAttr(tree, 'data-policy-focus', 'codex').props.checked === true
    && byAttr(tree, 'data-policy-warning', 'codex|weekly').props.value === '20')
  ctx.client.restore()
}

// ===========================================================================
// H4 — 草稿开关：不写表单、不清 focus/阈值，关→开立即恢复
// ===========================================================================
{
  const ctx = open(FULL)
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: false } })
  tree = await settle(ctx)
  check('H4a 草稿关闭：块立即隐藏', allBlocks(tree).length === 0)
  check('H4b 草稿关闭不写表单', ctx.mutations.length === 0 && ctx.writes.length === 0
    && ctx.form.value.quotaPolicyEnabled === true)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  check('H4c 再打开：块恢复且原 focus/阈值还在',
    allBlocks(tree).length === 6
    && byAttr(tree, 'data-policy-focus', 'codex').props.checked === true
    && byAttr(tree, 'data-policy-warning', 'codex|weekly').props.value === '20')
  ctx.client.restore()
}

// ===========================================================================
// H5 — 关闭后保存：只改授权 pair，不动 focus/阈值
//
// 注：这里刻意用**不含 customBalances** 的 fixture —— 通用 save 对 customBalances 数组
// 会规范化并产生同值 op（既有行为，父已明确不扩修）；自定义卡片的渲染由 H3 覆盖。
// ===========================================================================
{
  const policyOnly = {
    quotaPolicyEnabled: true,
    quotaTrustRouteOrder: true,
    quotaFocusChannels: '["codex"]',
    quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
  }
  const ctx = open(policyOnly)
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: false } })
  tree = await settle(ctx)
  byButton(tree, '保存更改').props.onClick()
  await settle(ctx)
  const ops = ctx.mutations[0] || []
  const fields = ops.map((o) => o.path[0]).sort()
  check('H5a 一次 mutate 只写两个授权字段', ctx.mutations.length === 1 && fields.join(',') === 'quotaPolicyEnabled,quotaTrustRouteOrder', fields)
  check('H5b 两个值都是 false', ops.every((o) => o.value === false))
  check('H5c focus/阈值原样保留',
    ctx.form.value.quotaFocusChannels === policyOnly.quotaFocusChannels
    && ctx.form.value.quotaChannelThresholds === policyOnly.quotaChannelThresholds)
  ctx.client.restore()
}

// ===========================================================================
// H6 — 放弃：恢复完整启用并重新显示
// ===========================================================================
{
  const ctx = open(FULL)
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: false } })
  tree = await settle(ctx)
  byButton(tree, '放弃更改').props.onClick()
  tree = await settle(ctx)
  check('H6a 放弃后块恢复显示', allBlocks(tree).length === 6)
  check('H6b 放弃不写任何字段', ctx.mutations.length === 0 && ctx.writes.length === 0)
  ctx.client.restore()
}

// ===========================================================================
// H7 — 开启后同批 focus + 阈值草稿不丢
// ===========================================================================
{
  const base = {
    quotaPolicyEnabled: false,
    quotaTrustRouteOrder: false,
    quotaFocusChannels: '[]',
    quotaChannelThresholds: '',
  }
  const ctx = open(base)
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  byAttr(tree, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree = await settle(ctx)
  byAttr(tree, 'data-policy-closing', 'codex|weekly').props.onChange({ target: { value: '7' } })
  tree = await settle(ctx)
  byButton(tree, '保存更改').props.onClick()
  await settle(ctx)
  const ops = ctx.mutations[0] || []
  const fields = ops.map((o) => o.path[0]).sort()
  check('H7a 同批写入授权 pair + focus + 阈值',
    fields.join(',') === 'quotaChannelThresholds,quotaFocusChannels,quotaPolicyEnabled,quotaTrustRouteOrder', fields)
  const th = JSON.parse(ctx.form.value.quotaChannelThresholds)
  check('H7b 只填收尾时预警为 0、收尾为 7', th.codex.windows.weekly.warning === 0 && th.codex.windows.weekly.closing === 7, th)
  ctx.client.restore()
}

// ===========================================================================
// H8 — 只读 / 保存中锁
// ===========================================================================
{
  const ro = open(FULL, { writable: false })
  const roTree = await settle(ro)
  check('H8a 只读部署：总开关禁用', byAttr(roTree, 'data-policy-master', '1').props.disabled === true)
  ro.client.restore()

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = open(FULL, { gate })
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '25' } })
  tree = await settle(ctx)
  byButton(tree, '保存更改').props.onClick()
  tree = ctx.runtime.renderOnce({ form: ctx.form })
  const inputs = elementsOf(tree).filter((el) => el.type === 'input')
  check('H8b 保存中总开关与块内输入全部锁定',
    byAttr(tree, 'data-policy-master', '1').props.disabled === true
    && inputs.every((el) => el.props.disabled === true))
  release()
  await new Promise((resolve) => setTimeout(resolve, 5))
  ctx.client.restore()
}

// ===========================================================================
// H9 — 隐藏态仍有坏草稿错误时不吞数据：全局可见 + 可放弃
// ===========================================================================
{
  const ctx = open(FULL)
  let tree = await settle(ctx)
  // 制造一条渠道级错误：非法数字（badInput）被拒绝后写入错误
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: 'abc', validity: { badInput: false } } })
  tree = await settle(ctx)
  const hadError = byAttr(tree, 'data-policy-channel-error', 'codex') !== undefined
  // 关闭总开关（草稿）→ 块隐藏，但错误必须提升到全局可见
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: false } })
  tree = await settle(ctx)
  const globalError = byAttr(tree, 'data-policy-hidden-errors', '1')
  check('H9a 先制造出渠道级错误', hadError)
  check('H9b 隐藏后错误在全局可见（不吞数据）', globalError !== undefined && textAll(globalError).indexOf('codex') !== -1,
    globalError === undefined ? null : textAll(globalError))
  check('H9c 仍可用「放弃更改」退出', byButton(tree, '放弃更改') !== undefined)
  ctx.client.restore()
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
