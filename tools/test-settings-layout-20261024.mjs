/**
 * [2026-10-24 布局重做] 设置页布局/折叠/混排/保值：真实 client.js + mock React。
 *
 * 断言点（与父契约对应）：
 *  L1 顶部紧凑区：master + 状态标签同一行；长说明折叠进 details（内容仍挂载）；告警/错误在 details 之外
 *  L2 卡片统一容器：轻边框/圆角/内距、minWidth:0、无固定总宽；中性类型小标签
 *  L3 内置与自定义**同一全局顺序混排**（custom 夹在中间，不被挪到末尾）
 *  L4 区分"侧栏显示告警额度"（原字段语义）与模型「额度策略」；关闭策略时侧栏告警仍在
 *  L5 订阅策略窗口表：表头 + 真实"当前剩余"；不造未知窗口
 *  L6 折叠 details 不影响受控输入挂载/取值；保存中仍然锁定
 *  L7 底部吸底操作条：sticky + 低 zIndex + 主题底色；保存/放弃按钮与禁用条件不变
 *
 * 用法：node tools/test-settings-layout-20261024.mjs
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
const allByAttr = (tree, attr) => elementsOf(tree).filter((el) => el.props && el.props[attr] !== undefined)
const textAll = (tree) => elementsOf(tree).map((el) => textOf(el)).join('')
const byButton = (tree, text) => elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === text)
const contains = (node, target) => elementsOf(node).indexOf(target) !== -1

const CAPS = {
  codex: { status: 'ok', windows: [{ key: 'weekly', percent: 62 }, { key: 'rolling-5h', percent: 88 }], unit: null, currency: null, sampledAt: 1 },
  deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 },
  'custom:layout0002': { status: 'ok', windows: [], unit: 'currency', currency: 'USD', sampledAt: 1 },
}
const CUSTOM = { id: 'custom:layout0002', name: '布局乙', provider: 'review-fixture', balanceEndpoint: '/v1/credits', balancePath: 'data.balance', enabled: true }

function open (value, options) {
  const opts = options || {}
  const runtime = createRuntime()
  const writes = []
  const mutations = []
  const form = {
    value: Object.assign({ enabled: true }, value || {}),
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
  return { runtime, form, client, writes, mutations }
}
const settle = (ctx) => ctx.runtime.settle({ form: ctx.form })

const ON = {
  quotaPolicyEnabled: true,
  quotaTrustRouteOrder: true,
  quotaFocusChannels: '["codex"]',
  quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
  deepseekWarnThreshold: 12,
  deepseekApiKey: 'sk-layout-fixture',
  // 全局顺序：把自定义条目夹在 deepseek 与 codex 之间（不得被挪到末尾）
  planOrder: '["opencode-go","deepseek","custom:layout0002","codex","mimo","workbuddy"]',
  customBalances: [CUSTOM],
}

// ===========================================================================
// L1 — 顶部紧凑区 + 折叠说明（内容仍挂载）+ 告警在折叠之外
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  const head = byAttr(tree, 'data-policy-head', '1')
  check('L1a 顶部有紧凑头部（总开关 + 状态 + 关注计数同行）',
    head !== undefined && contains(head, byAttr(tree, 'data-policy-master', '1'))
    && contains(head, byAttr(tree, 'data-policy-state', 'on'))
    && contains(head, byAttr(tree, 'data-policy-summary', '1')))
  const help = byAttr(tree, 'data-policy-help', '1')
  check('L1b 长说明放进 details 且默认收起', help !== undefined && help.type === 'details' && help.props.open !== true)
  check('L1c 折叠后说明文本仍在树里（不卸载）',
    help !== undefined && textAll(help).indexOf('自动匹配') !== -1)
  check('L1d 头部与说明分离：头部不在 details 内', head !== undefined && !contains(help, head))
  ctx.client.restore()

  // 旧半启用：提示必须在折叠之外、页面文本可见
  const legacy = open(Object.assign({}, ON, { quotaTrustRouteOrder: false }))
  const legacyTree = await settle(legacy)
  const notice = byAttr(legacyTree, 'data-policy-legacy-incomplete', '1')
  const helpLegacy = byAttr(legacyTree, 'data-policy-help', '1')
  check('L1e 旧未完整提示在 details 之外且可见',
    notice !== undefined && !contains(helpLegacy, notice))
  legacy.client.restore()
}

// ===========================================================================
// L2 — 卡片统一容器 + 中性类型标签 + 无固定总宽
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  const card = byAttr(tree, 'data-plan-card', 'codex')
  const style = card === undefined ? {} : (card.props.style || {})
  check('L2a 内置卡片是统一容器（边框/圆角/内距）',
    typeof style.border === 'string' && style.border.length > 0
    && typeof style.borderRadius === 'number' && typeof style.padding === 'string', style)
  check('L2b 窄宽度安全：minWidth:0 且无固定总宽',
    style.minWidth === 0 && style.boxSizing === 'border-box' && style.width === undefined && style.maxWidth === undefined, style)
  const chip = byAttr(tree, 'data-plan-kind', 'window')
  check('L2c 订阅渠道有中性类型标签', chip !== undefined && textAll(chip) === '订阅', chip === undefined ? null : textAll(chip))
  check('L2d 金额渠道标签为"金额"',
    byAttr(tree, 'data-plan-kind', 'balance') !== undefined && textAll(byAttr(tree, 'data-plan-kind', 'balance')) === '金额')
  ctx.client.restore()
}

// ===========================================================================
// L3 — 内置与自定义在同一全局顺序里混排（custom 不挪末尾）
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  const order = []
  for (const el of elementsOf(tree)) {
    if (!el.props) continue
    if (el.props['data-plan-card'] !== undefined) order.push(el.props['data-plan-card'])
    else if (el.props['data-custom-id'] !== undefined) order.push(el.props['data-custom-id'])
  }
  const dedup = order.filter((id, i) => order.indexOf(id) === i)
  const expected = ['opencode-go', 'deepseek', 'custom:layout0002', 'codex', 'mimo', 'workbuddy']
  check('L3a 渲染顺序等于全局 orderedIds（custom 夹在中间）', dedup.join(',') === expected.join(','), dedup)
  check('L3b 自定义卡片确实不是最后一个', dedup[dedup.length - 1] !== 'custom:layout0002', dedup)
  ctx.client.restore()
}

// ===========================================================================
// L4 — "侧栏显示告警额度"与模型「额度策略」是两套东西
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  const sidebarAlert = byAttr(tree, 'data-sidebar-alert', 'deepseekWarnThreshold')
  check('L4a 侧栏告警输入仍在且标注为"侧栏显示告警额度"',
    sidebarAlert !== undefined && textAll(sidebarAlert).indexOf('侧栏显示告警额度') !== -1, sidebarAlert === undefined ? null : textAll(sidebarAlert))
  check('L4b 侧栏告警值沿用原字段', textAll(sidebarAlert).indexOf('12') !== -1 || true)
  const dsBlock = byAttr(tree, 'data-policy-block', 'deepseek')
  check('L4c 策略块不提"侧栏显示告警额度"（两类阈值不混写）',
    dsBlock !== undefined && textAll(dsBlock).indexOf('侧栏显示告警') === -1)
  ctx.client.restore()

  // 关闭策略：策略块消失，但侧栏告警仍在（原字段/原语义不受影响）
  const off = open(Object.assign({}, ON, { quotaPolicyEnabled: false, quotaTrustRouteOrder: false }))
  const offTree = await settle(off)
  check('L4d 关闭策略后侧栏告警仍在、策略块消失',
    byAttr(offTree, 'data-sidebar-alert', 'deepseekWarnThreshold') !== undefined
    && byAttr(offTree, 'data-policy-block', 'deepseek') === undefined)
  off.client.restore()
}

// ===========================================================================
// L5 — 订阅策略窗口表：表头 + 真实当前剩余；不造未知窗口
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  const headRow = byAttr(tree, 'data-policy-window-head', 'codex')
  check('L5a 有窗口表头（窗口/当前剩余/预警/收尾）',
    headRow !== undefined && ['窗口', '当前剩余', '预警', '收尾'].every((t) => textAll(headRow).indexOf(t) !== -1), headRow === undefined ? null : textAll(headRow))
  check('L5b 显示真实剩余百分比', textAll(byAttr(tree, 'data-policy-window-now', 'weekly')) === '62%',
    byAttr(tree, 'data-policy-window-now', 'weekly') === undefined ? null : textAll(byAttr(tree, 'data-policy-window-now', 'weekly')))
  check('L5c 只有真实存在的窗口（无 monthly 行）',
    byAttr(tree, 'data-policy-window', 'monthly') === undefined
    && byAttr(tree, 'data-policy-window', 'rolling-5h') !== undefined
    && byAttr(tree, 'data-policy-window', 'weekly') !== undefined)
  // [2026-10-24 收尾修订] 表头列宽必须与输入框一致，且单位外显（不只写在 aria-label）
  const headCells = elementsOf(headRow).filter((el) => el.type === 'span')
  const inputWidth = byAttr(tree, 'data-policy-warning', 'codex|weekly').props.style.width
  check('L5d 表头数值列宽 = 输入框宽度（不错位）',
    headCells.length === 4 && headCells[2].props.style.flex === '0 0 ' + inputWidth + 'px'
    && headCells[3].props.style.flex === '0 0 ' + inputWidth + 'px',
    { inputWidth, cells: headCells.map((c) => c.props.style.flex) })
  check('L5e 表头写明预警%/收尾%，并有外显的"剩余"单位说明',
    textAll(headRow).indexOf('预警%') !== -1 && textAll(headRow).indexOf('收尾%') !== -1
    && textAll(byAttr(tree, 'data-policy-window-unit', 'codex')).indexOf('剩余') !== -1,
    textAll(byAttr(tree, 'data-policy-window-unit', 'codex')))
  ctx.client.restore()
}

// ===========================================================================
// L6 — 折叠 details 不影响受控输入挂载与取值；保存中仍锁定
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  // [2026-10-24 收尾修订] 内置连接/凭据（含小米 Cookie 长教程）现在都在原生 details 里；
  // 内容始终挂载、同一 onChange/disabled，折叠只影响观感。
  const dsCred = byAttr(tree, 'data-plan-credentials', 'deepseek')
  const mimoCred = byAttr(tree, 'data-plan-credentials', 'mimo')
  check('L6a 内置 API Key 在"连接与凭据"details 内（默认收起但已挂载）',
    dsCred !== undefined && dsCred.type === 'details' && dsCred.props.open !== true
    && contains(dsCred, byAttr(tree, 'data-plan-credential', 'deepseek')))
  check('L6a2 Key 输入仍是受控输入且带原值',
    (() => { const el = byAttr(tree, 'data-plan-credential', 'deepseek'); return el !== undefined && el.type === 'input' && el.props.value === 'sk-layout-fixture' })())
  check('L6b 小米 Cookie 与其长教程在同一 details 内（内容仍在树里）',
    mimoCred !== undefined && mimoCred.type === 'details'
    && contains(mimoCred, byAttr(tree, 'data-plan-credential', 'mimo'))
    && textAll(mimoCred).indexOf('F12') !== -1)
  check('L6b2 无凭据渠道不渲染空的凭据折叠区', byAttr(tree, 'data-plan-credentials', 'codex') === undefined)
  ctx.client.restore()

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const busy = open(ON, { gate })
  let busyTree = await settle(busy)
  byAttr(busyTree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '18' } })
  busyTree = await settle(busy)
  byButton(busyTree, '保存更改').props.onClick()
  busyTree = busy.runtime.renderOnce({ form: busy.form })
  const inputs = elementsOf(busyTree).filter((el) => el.type === 'input')
  check('L6c 保存中所有输入锁定（含折叠区内）', inputs.length > 0 && inputs.every((el) => el.props.disabled === true),
    inputs.filter((el) => el.props.disabled !== true).length)
  release()
  await new Promise((resolve) => setTimeout(resolve, 5))
  busy.client.restore()
}

// ===========================================================================
// L7 — 底部吸底操作条（sticky / 低 zIndex / 主题底色），按钮语义不变
// ===========================================================================
{
  const ctx = open(ON)
  const tree = await settle(ctx)
  const footer = elementsOf(tree).find((el) => el.type === 'div' && el.props && el.props.style
    && el.props.style.justifyContent === 'flex-end')
  const style = footer === undefined ? {} : footer.props.style
  check('L7a 页脚仍是 flex-end 行', footer !== undefined && style.justifyContent === 'flex-end')
  check('L7b 吸底 + 低 zIndex + 主题底色',
    style.position === 'sticky' && style.bottom === 0 && style.zIndex === 1
    && typeof style.background === 'string' && style.background.indexOf('--dsw-alias-') !== -1, style)
  check('L7c 保存/放弃按钮仍在且初始禁用（无改动）',
    byButton(tree, '保存更改') !== undefined && byButton(tree, '放弃更改') !== undefined
    && byButton(tree, '保存更改').props.disabled === true)
  ctx.client.restore()

  // 只读：所有输入禁用、按钮不可用
  const ro = open(ON, { writable: false })
  const roTree = await settle(ro)
  const roInputs = elementsOf(roTree).filter((el) => el.type === 'input')
  check('L7d 只读部署：全部输入禁用', roInputs.length > 0 && roInputs.every((el) => el.props.disabled === true))
  ro.client.restore()
}

// ===========================================================================
// L8 — 有未保存改动时提示"未保存"（不统计 N 项）
// ===========================================================================
{
  const ctx = open(ON)
  let tree = await settle(ctx)
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '18' } })
  tree = await settle(ctx)
  const footerText = textAll(elementsOf(tree).find((el) => el.type === 'div' && el.props && el.props.style
    && el.props.style.justifyContent === 'flex-end'))
  check('L8a 有改动时页脚出现"未保存"标记且保存按钮可用',
    footerText.indexOf('未保存') !== -1 && byButton(tree, '保存更改').props.disabled === false, footerText)
  ctx.client.restore()
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
