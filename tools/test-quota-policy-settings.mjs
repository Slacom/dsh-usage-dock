/**
 * [2026-10-23] 设置页额度策略 UI：真实 client.js + mock React + 真实表单事务。
 *
 * 覆盖（父裁决 R1/R3/R5/R6）：
 *   - 顶部总开关 / 路由信任显式呈现，默认关；勾「关注」不会顺手打开它们；
 *   - 关注 = `quotaFocusChannels` 成员资格；上限 8 阻止新增；未知成员保留可取消；
 *     focus 坏 JSON 拒绝有害写入，重置是单独显式动作；
 *   - 窗口只按**实际采样**渲染：仅 weekly 时绝不出现 5h 输入或"已保存 5h"常规行；
 *     失败/未采样只给状态说明；"刷新窗口信息"按钮存在；
 *   - 金额币种只认可信采样或已保存币种，未知时禁用输入，不猜 CNY；
 *   - 首次勾选某渠道时把"旧时真正生效的那一个窗口 + 旧两档"写进该渠道条目；
 *   - 保存：先校验零副作用；只提交变更字段；无 customKeys 操作；放弃可还原；保存中全锁；
 *   - 自定义余额卡也带公共策略块（只追加，不改其原有逻辑）。
 *
 * 用法：node tools/test-quota-policy-settings.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) }
  else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600))) }
}

/**
 * 收集组件树里的所有元素（含函数组件展开一层）。
 *
 * mock 运行时只执行**根**组件，函数子组件（如 `CustomBalancesSection`）只是节点，
 * 因此这里显式展开一层；带 hooks 的子组件会抛错，按跳过处理。
 */
function elementsOf(node, out, depth) {
  const acc = out || []
  const d = depth || 0
  if (node === null || node === undefined || typeof node === 'boolean' || d > 12) return acc
  if (Array.isArray(node)) { for (const n of node) elementsOf(n, acc, d); return acc }
  if (typeof node !== 'object' || node.type === undefined) return acc
  if (typeof node.type === 'string') {
    acc.push(node)
    elementsOf(node.props ? node.props.children : undefined, acc, d + 1)
  } else if (typeof node.type === 'function') {
    try {
      const rendered = node.type(node.props)
      if (rendered !== undefined) elementsOf(rendered, acc, d + 1)
    } catch (err) { /* 带 hooks 的子组件跳过 */ }
  }
  return acc
}
/** 展开函数组件后的完整文本（`textOf` 不展开函数组件）。 */
function textAll(tree) {
  return elementsOf(tree).map((el) => textOf(el)).join('')
}
function byAttr(tree, attr, value) {
  return elementsOf(tree).find((el) => el.props && el.props[attr] === value)
}
function byText(tree, text) {
  const all = elementsOf(tree).filter((el) => textOf(el) === text)
  const buttons = all.filter((el) => el.type === 'button')
  return buttons.length > 0 ? buttons : all
}
/** 取带某 data 属性元素的可见文本。 */
function attrText(tree, attr, value) {
  const el = byAttr(tree, attr, value)
  return el === undefined ? '' : textOf(el)
}

function makeForm(value, gate) {
  const writes = []
  const mutations = []
  const form = {
    value,
    writes,
    mutations,
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(field, val) {
      writes.push({ field, value: val })
      this.value = Object.assign({}, this.value, { [field]: val })
      return gate ? gate.then(() => true) : Promise.resolve(true)
    },
    mutate(ops) {
      mutations.push(ops)
      if (!gate) {
        for (const op of ops) {
          if (op.path.length === 1 && op.op === 'set') {
            this.value = Object.assign({}, this.value, { [op.path[0]]: op.value })
          }
        }
      }
      return gate ? gate.then(() => true) : Promise.resolve(true)
    },
  }
  return form
}

/** 打开一次设置页（每个场景一个新的运行时，避免 fetch/window 全局互相干扰）。 */
function open(options) {
  const runtime = createRuntime()
  const form = makeForm(options.value, options.gate)
  const client = loadClient(runtime, Object.assign({ form }, options.client || {}))
  // 统计「窗口能力」请求次数（P10：外部配置变化后必须重新拉取）。
  const innerFetch = globalThis.fetch
  let metadataFetches = 0
  globalThis.fetch = function (url, init) {
    if (String(url).includes('quota-windows')) {
      metadataFetches += 1
      // 可选：模拟服务端"失败信封"（审查 F03）
      if (options.quotaWindowsBody !== undefined) {
        return Promise.resolve({ json: async () => options.quotaWindowsBody })
      }
    }
    return innerFetch(url, init)
  }
  return {
    runtime,
    form,
    client,
    get metadataFetches() { return metadataFetches },
  }
}
async function mount(ctx) {
  ctx.runtime.mount(ctx.client.SettingsPage, { form: ctx.form })
  return ctx.runtime.settle({ form: ctx.form })
}
async function runtimeSettle(ctx) {
  return ctx.runtime.settle({ form: ctx.form })
}

/**
 * 交互场景的默认 fixture：**完整开启**（policy + trust 都 true）。
 *
 * [2026-10-24 契约变更] 总开关关闭时渠道策略块整块不渲染，因此凡要操作
 * "关注/阈值/状态"的用例都必须处于完整开启态；默认关闭/旧半启用的场景在
 * S1 组里**显式**设 false 并增强断言，避免把默认关闭漏测成"一律开启"。
 */
const BASE = {
  enabled: true,
  planOrder: '[]',
  quotaPolicyEnabled: true,
  quotaTrustRouteOrder: true,
  quotaFocusChannels: '[]',
  quotaChannelThresholds: '',
}
/** 显式"默认关闭" fixture（仅用于默认态/隐藏态断言）。 */
const OFF = {
  enabled: true,
  planOrder: '[]',
  quotaPolicyEnabled: false,
  quotaTrustRouteOrder: false,
  quotaFocusChannels: '[]',
  quotaChannelThresholds: '',
}

// ===========================================================================
// S1 — 顶部安全闸门显式可见、默认关、文案正确
// ===========================================================================
{
  const ctx = open({ value: Object.assign({}, OFF) })
  let tree = await mount(ctx)
  const master = byAttr(tree, 'data-policy-master', '1')
  check('S1a 渲染总开关复选框（默认未勾选）', master !== undefined && master.props.checked === false)
  /**
   * [2026-10-23 有意契约变更] 原先这里断言"渲染路由信任复选框（默认未勾选）"。
   * 用户已确认合并为**单一总开关**（一次启用成对置 policy+trust），因此独立控件必须消失；
   * 旧字段与 Host 闸门保留。其余断言不变。
   */
  check('S1b 不再渲染独立的"路由信任"复选框', byAttr(tree, 'data-policy-trust', '1') === undefined)
  check('S1c 总览行显示关注数量上限', textOf(tree).indexOf('已关注 0/8') !== -1, textOf(tree).slice(0, 400))
  check('S1d 文案不写"没有公开安装顺序证据"',
    textOf(tree).indexOf('没有公开安装顺序证据') === -1)
  /**
   * [2026-10-23 有意契约变更] 原先断言"只在确认当前路由观察链可靠时启用"这句第二个开关的说明。
   * 现在总说明必须讲清：打开总开关后按**本次真实路由**自动匹配已关注渠道；
   * 且不得声称已对第三方连接插件的安装顺序做了自动验真。
   */
  check('S1e 文案说明按真实路由自动匹配、且不声称自动验真',
    textOf(tree).indexOf('按本次请求真实使用的供应商路由') !== -1
    && textOf(tree).indexOf('自动匹配') !== -1
    && textOf(tree).indexOf('不是对第三方连接插件安装顺序的自动验真') !== -1,
    textOf(tree).slice(0, 500))
  check('S1f 存在"刷新窗口信息"按钮', byAttr(tree, 'data-policy-refresh', '1') !== undefined)
  // [2026-10-24 新增] 关闭态：所有渠道策略块（关注/阈值/状态）都不渲染
  check('S1g 关闭态不渲染任何渠道策略块',
    elementsOf(tree).filter((el) => el.props && el.props['data-policy-block'] !== undefined).length === 0)
  check('S1h 关闭态没有任何关注复选框/阈值输入/状态行',
    byAttr(tree, 'data-policy-focus', 'codex') === undefined
    && byAttr(tree, 'data-policy-warning', 'codex|weekly') === undefined
    && byAttr(tree, 'data-policy-status', 'codex') === undefined)
  ctx.client.restore()

  // 旧半启用（policy=true, trust=false）同样不渲染子块
  const legacy = open({ value: Object.assign({}, OFF, { quotaPolicyEnabled: true }) })
  const legacyTree = await mount(legacy)
  check('S1i 旧 true/false 半启用也不渲染渠道策略块',
    elementsOf(legacyTree).filter((el) => el.props && el.props['data-policy-block'] !== undefined).length === 0
    && byAttr(legacyTree, 'data-policy-legacy-incomplete', '1') !== undefined)
  legacy.client.restore()
}

// ===========================================================================
// S2 — 勾「关注」只写 focus；不打开总开关/信任；保存只提交变更字段；无 customKeys
// ===========================================================================
{
  const ctx = open({ value: Object.assign({}, BASE) })
  let tree = await mount(ctx)
  const box = byAttr(tree, 'data-policy-focus', 'codex')
  check('S2a 每个活跃内置渠道都有"关注额度策略"复选框', box !== undefined && box.props.checked === false)
  box.props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  const draftFocus = JSON.parse(ctx.form.value.quotaFocusChannels === '[]' ? '[]' : ctx.form.value.quotaFocusChannels)
  check('S2b 勾选写入的是草稿（保存前不改表单）', ctx.form.value.quotaFocusChannels === '[]', ctx.form.value.quotaFocusChannels)
  const checkedBox = byAttr(tree, 'data-policy-focus', 'codex')
  check('S2c 勾选后 UI 立刻反映（草稿生效）', checkedBox.props.checked === true)
  const save = byText(tree, '保存更改')[0]
  check('S2d 有未保存改动 → 保存按钮可用', save.props.disabled === false)
  save.props.onClick()
  await runtimeSettle(ctx)
  const ops = ctx.form.mutations[0] || []
  const fields = ops.filter((op) => op.path.length === 1).map((op) => op.path[0])
  check('S2e 保存只用一次 mutate 提交变更字段', ctx.form.mutations.length === 1, ctx.form.mutations.length)
  check('S2f 只提交 quotaFocusChannels（不顺手改 policy/trust）',
    fields.join(',') === 'quotaFocusChannels', fields)
  check('S2g 没有任何 customKeys 路径写入',
    ops.every((op) => !(op.path.length >= 1 && op.path[0] === 'customKeys')), ops)
  check('S2h 没有写 secret 修订号', ops.every((op) => op.path[0] !== 'customKeyRev'))
  void draftFocus
  ctx.client.restore()
}

// ===========================================================================
// S3 — 上限 8：阻止新增并提示（不静默截断）
// ===========================================================================
{
  const eight = []
  for (let i = 0; i < 8; i++) eight.push('custom:cap000000' + i)
  const ctx = open({ value: Object.assign({}, BASE, { quotaFocusChannels: JSON.stringify(eight) }) })
  let tree = await mount(ctx)
  check('S3a 8 个未知成员原样显示（不截断）', textOf(tree).indexOf('已关注 8/8') !== -1, textOf(tree).slice(0, 300))
  const box = byAttr(tree, 'data-policy-focus', 'codex')
  box.props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  const err = byAttr(tree, 'data-policy-error', '1')
  check('S3b 超上限时给出明确错误', err !== undefined && textOf(err).indexOf('最多 8 个') !== -1, err && textOf(err))
  check('S3c 超上限时不写入草稿',
    byAttr(tree, 'data-policy-focus', 'codex').props.checked === false)
  ctx.client.restore()
}

// ===========================================================================
// S4 — 未知/退场成员保留且可单独取消
// ===========================================================================
{
  const ctx = open({ value: Object.assign({}, BASE, { quotaFocusChannels: '["custom:old0000001","workbuddy-ai"]' }) })
  let tree = await mount(ctx)
  check('S4a 未知成员列在"其它已关注条目"', textOf(tree).indexOf('其它已关注条目') !== -1, textOf(tree).slice(0, 400))
  const removeBtn = byAttr(tree, 'data-policy-focus-remove', 'workbuddy-ai')
  check('S4b 未知成员有取消按钮', removeBtn !== undefined)
  removeBtn.props.onClick()
  tree = await runtimeSettle(ctx)
  check('S4c 只移除该成员，另一个保留',
    textOf(tree).indexOf('custom:old0000001') !== -1 && textOf(tree).indexOf('workbuddy-ai') === -1,
    textOf(tree).slice(0, 400))
  ctx.client.restore()
}

// ===========================================================================
// S5 — 仅 weekly 采样：不出现 5h 输入，状态行不列 5h 数值
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      // 两个窗口都配了；本次采样只有 weekly → 只有 weekly 参与、也只有它出现在状态里。
      quotaChannelThresholds: JSON.stringify({
        codex: { windows: { 'rolling-5h': { warning: 25, closing: 8 }, weekly: { warning: 50, closing: 20 } } },
      }),
    }),
    client: {
      quotaWindows: {
        codex: { status: 'ok', windows: [{ key: 'weekly', percent: 12 }], unit: null, currency: null, sampledAt: 1 },
      },
    },
  })
  const tree = await mount(ctx)
  check('S5a 只渲染实际出现的 weekly 输入', byAttr(tree, 'data-policy-warning', 'codex|weekly') !== undefined)
  check('S5b 不渲染 5h 输入', byAttr(tree, 'data-policy-warning', 'codex|rolling-5h') === undefined)
  check('S5c 不显示"已保存 5h 值"常规行',
    textOf(tree).indexOf('已保存 25') === -1 && textOf(tree).indexOf('rolling-5h 25') === -1)
  check('S5d 用一句通用说明"已保存配置已保留"',
    textOf(tree).indexOf('未出现窗口的已保存配置已保留') !== -1, textOf(tree).slice(0, 600))
  // 状态行只能提**本次实际出现**的窗口（P09 的同类要求）。
  check('S5e 状态行只提 weekly、不提 5h 的数值',
    textOf(tree).indexOf('周窗口') !== -1
    && textOf(tree).indexOf('5 小时') === -1, textOf(tree).slice(0, 800))
  ctx.client.restore()
}

// ===========================================================================
// S5b — 配了 5h 但采样只有 weekly 且 weekly 未配置：不得宣称"已参与"
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaChannelThresholds: JSON.stringify({ codex: { windows: { 'rolling-5h': { warning: 25, closing: 8 } } } }),
    }),
    client: {
      quotaWindows: {
        codex: { status: 'ok', windows: [{ key: 'weekly', percent: 12 }], unit: null, currency: null, sampledAt: 1 },
      },
    },
  })
  const tree = await mount(ctx)
  const status = attrText(tree, 'data-policy-status', 'codex')
  check('S5b1 无实际可判窗口时不宣称已参与',
    status.indexOf('已参与') !== 0, status)
  check('S5b2 状态里不出现不存在的 5h', status.indexOf('5 小时') === -1, status)
  check('S5b3 明说"本次采样中都没有出现"',
    status.indexOf('本次采样中都没有出现') !== -1, status)
  ctx.client.restore()
}

// ===========================================================================
// S6 — 无采样：只给状态说明与刷新入口，不造窗口
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
    }),
    client: { quotaWindows: {} },
  })
  const tree = await mount(ctx)
  check('S6a 无采样时没有可编辑窗口',
    byAttr(tree, 'data-policy-warning', 'codex|weekly') === undefined
    && byAttr(tree, 'data-policy-warning', 'codex|rolling-5h') === undefined)
  check('S6b 给出"尚未取得本渠道的额度窗口"说明',
    textOf(tree).indexOf('尚未取得本渠道的额度窗口') !== -1, textOf(tree).slice(0, 600))
  ctx.client.restore()

  const failedCtx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
    }),
    client: { quotaWindows: { codex: { status: 'failed', windows: [] } } },
  })
  const failedTree = await mount(failedCtx)
  check('S6c 取数失败 ≠ 没有窗口（明确说明）',
    textOf(failedTree).indexOf('这不是') !== -1, textOf(failedTree).slice(0, 600))
  failedCtx.client.restore()

  // 端点不可用：不阻塞页面，只显示"只显示已保存窗口"
  const errCtx = open({
    value: Object.assign({}, BASE),
    client: { quotaWindowsError: true },
  })
  const errTree = await mount(errCtx)
  check('S6d 窗口信息读取失败时有明确提示',
    textOf(errTree).indexOf('未能读取窗口信息') !== -1, textOf(errTree).slice(0, 600))
  errCtx.client.restore()
}

// ===========================================================================
// S7 — 金额币种：未知则禁用输入，不猜 CNY；已知则显示并启用
// ===========================================================================
{
  const noCurrency = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["deepseek"]',
    }),
    client: { quotaWindows: {} },
  })
  let tree = await mount(noCurrency)
  const warnUnknown = byAttr(tree, 'data-policy-warning', 'deepseek|balance')
  check('S7a 币种未知时金额输入被禁用', warnUnknown !== undefined && warnUnknown.props.disabled === true)
  check('S7b 明确说明不会猜成 CNY',
    textOf(tree).indexOf('不会猜成 CNY') !== -1, textOf(tree).slice(0, 600))
  noCurrency.client.restore()

  const withCurrency = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["deepseek"]',
    }),
    client: { quotaWindows: { deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 } } },
  })
  tree = await mount(withCurrency)
  const warnKnown = byAttr(tree, 'data-policy-warning', 'deepseek|balance')
  check('S7c 有可信币种时启用输入', warnKnown !== undefined && warnKnown.props.disabled === false)
  check('S7d 标签显示实际币种',
    textOf(tree).indexOf('余额阈值（CNY）') !== -1, textOf(tree).slice(0, 600))
  warnKnown.props.onChange({ target: { value: '8' } })
  tree = await runtimeSettle(withCurrency)
  // 草稿只存在于组件状态：点保存后才能在 form 上看到（同时也验证了写入路径）。
  byText(tree, '保存更改')[0].props.onClick()
  tree = await runtimeSettle(withCurrency)
  const parsed = JSON.parse(withCurrency.form.value.quotaChannelThresholds)
  check('S7e 写入带币种的金额阈值',
    parsed.deepseek.balance.warning === 8 && parsed.deepseek.balance.currency === 'CNY', parsed)
  check('S7f 未填的收尾保持 0（= 未配置）', parsed.deepseek.balance.closing === undefined
    || parsed.deepseek.balance.closing === 0, parsed.deepseek.balance)
  withCurrency.client.restore()
}

// ===========================================================================
// S8 — 写某渠道阈值不影响其它渠道条目（含未知子键）
// ===========================================================================
{
  const existing = { codex: { windows: { weekly: { warning: 20, closing: 5, customNote: 'keep' } }, extra: 'keep' } }
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["deepseek","codex"]',
      quotaChannelThresholds: JSON.stringify(existing),
    }),
    client: { quotaWindows: { deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-closing', 'deepseek|balance').props.onChange({ target: { value: '3' } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  tree = await runtimeSettle(ctx)
  const parsed = JSON.parse(ctx.form.value.quotaChannelThresholds)
  check('S8a 新渠道写入成功', parsed.deepseek.balance.closing === 3, parsed.deepseek)
  check('S8b 其它渠道条目原样保留（含未知子键）',
    parsed.codex.windows.weekly.customNote === 'keep' && parsed.codex.extra === 'keep', parsed.codex)
  ctx.client.restore()
}

// ===========================================================================
// S9 — 首次勾选：把"旧时真正生效的那一个窗口 + 旧两档"写进该渠道条目
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaWarningPercentThreshold: 40,
      quotaClosingPercentThreshold: 20,
    }),
    client: {
      quotaWindows: {
        codex: {
          status: 'ok',
          windows: [{ key: 'weekly', percent: 50 }, { key: 'rolling-5h', percent: 50 }],
          sampledAt: 1,
        },
      },
    },
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  tree = await runtimeSettle(ctx)
  const parsed = JSON.parse(ctx.form.value.quotaChannelThresholds)
  check('S9a 勾选时建立了本渠道条目', parsed.codex !== undefined, parsed)
  check('S9b 只把"最短窗口"的旧值搬进来（5h 40/20）',
    parsed.codex.windows['rolling-5h'].warning === 40
    && parsed.codex.windows['rolling-5h'].closing === 20, parsed.codex.windows)
  check('S9c 不把旧值扩散到周窗口', parsed.codex.windows.weekly === undefined, parsed.codex.windows)
  check('S9d 旧全局阈值字段本身没被改动',
    ctx.form.value.quotaWarningPercentThreshold === 40 && ctx.form.value.quotaClosingPercentThreshold === 20)
  ctx.client.restore()
}

// ===========================================================================
// S10 — 校验：closing >= warning → 零写入且错误可见
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
    }),
    client: { quotaWindows: { codex: { status: 'ok', windows: [{ key: 'weekly', percent: 50 }], sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '10' } })
  tree = await runtimeSettle(ctx)
  byAttr(tree, 'data-policy-closing', 'codex|weekly').props.onChange({ target: { value: '30' } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  tree = await runtimeSettle(ctx)
  check('S10a 非法两档 → 没有任何写入', ctx.form.mutations.length === 0 && ctx.form.writes.length === 0,
    { mutations: ctx.form.mutations.length, writes: ctx.form.writes.length })
  check('S10b 错误信息可见且说明原因',
    textOf(tree).indexOf('收尾阈值必须小于预警阈值') !== -1, textOf(tree).slice(0, 600))
  check('S10c 草稿仍保留供修改', byAttr(tree, 'data-policy-closing', 'codex|weekly').props.value === '30')
  ctx.client.restore()
}

// ===========================================================================
// S11 — 历史坏 JSON：不许静默重写，也不阻塞**未触碰**它的保存
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["deepseek"]',
      quotaChannelThresholds: '{oops',
    }),
    client: { quotaWindows: { deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  check('S11a 坏 JSON 有可见提示', textOf(tree).indexOf('无法解析') !== -1, textOf(tree).slice(0, 600))
  byAttr(tree, 'data-policy-warning', 'deepseek|balance').props.onChange({ target: { value: '9' } })
  tree = await runtimeSettle(ctx)
  check('S11b 拒绝写入坏 JSON（输入框仍为空、草稿未变）',
    byAttr(tree, 'data-policy-warning', 'deepseek|balance').props.value === ''
    && (ctx.form.value.quotaChannelThresholds === '{oops'))
  check('S11c 给出不覆盖的说明', textOf(tree).indexOf('为避免覆盖原数据') !== -1, textOf(tree).slice(0, 700))

  // 改别的字段（关注名单）→ 保存必须成功，且不得重写坏的阈值字段
  byAttr(tree, 'data-policy-focus', 'deepseek').props.onChange({ target: { checked: false } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  tree = await runtimeSettle(ctx)
  const ops = ctx.form.mutations[0] || []
  check('S11d 未触碰的坏字段不阻塞其它保存', ctx.form.mutations.length === 1, ctx.form.mutations.length)
  check('S11e 保存没有提交/改写阈值字段',
    ops.every((op) => op.path[0] !== 'quotaChannelThresholds'), ops.map((op) => op.path))
  ctx.client.restore()
}

// ===========================================================================
// S12 — focus 坏 JSON：拒绝勾选；重置是单独显式动作且只进草稿
// ===========================================================================
{
  const ctx = open({ value: Object.assign({}, BASE, { quotaFocusChannels: '{"not":"array"}' }) })
  let tree = await mount(ctx)
  check('S12a 坏 focus 有错误提示', textOf(tree).indexOf('关注渠道列表无法解析') !== -1, textOf(tree).slice(0, 500))
  byAttr(tree, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  check('S12b 拒绝在坏 JSON 上自动重建', ctx.form.value.quotaFocusChannels === '{"not":"array"}')
  const reset = byAttr(tree, 'data-policy-focus-reset', '1')
  check('S12c 提供单独的重置动作', reset !== undefined)
  reset.props.onClick()
  tree = await runtimeSettle(ctx)
  check('S12d 重置只写草稿为 []（保存后才生效）', ctx.form.value.quotaFocusChannels === '{"not":"array"}')
  byText(tree, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx)
  const ops = ctx.form.mutations[0] || []
  check('S12e 保存后 focus 确实被显式清空', ops.some((op) => op.path[0] === 'quotaFocusChannels'
    && op.value === '[]'), ops)
  ctx.client.restore()
}

// ===========================================================================
// S13 — 放弃更改还原策略草稿；保存中全部输入禁用
// ===========================================================================
{
  const gate = (() => { let release; const p = new Promise((resolve) => { release = resolve }); p.release = release; return p })()
  const ctx = open({
    value: Object.assign({}, BASE, { quotaPolicyEnabled: true, quotaTrustRouteOrder: true }),
    gate,
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  check('S13a 勾选后处于草稿态', byAttr(tree, 'data-policy-focus', 'codex').props.checked === true)
  byText(tree, '放弃更改')[0].props.onClick()
  tree = await runtimeSettle(ctx)
  check('S13b 放弃后恢复未勾选', byAttr(tree, 'data-policy-focus', 'codex').props.checked === false)

  byAttr(tree, 'data-policy-focus', 'codex').props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  tree = ctx.runtime.renderOnce({ form: ctx.form })
  const inputs = elementsOf(tree).filter((el) => el.type === 'input')
  check('S13c 保存中所有输入禁用',
    inputs.length > 0 && inputs.every((el) => el.props.disabled === true),
    inputs.filter((el) => el.props.disabled !== true).length)
  gate.release()
  await new Promise((resolve) => setTimeout(resolve, 5))
  ctx.client.restore()
}

// ===========================================================================
// S14 — 自定义余额卡也带公共策略块（只追加，不改其逻辑）
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["custom:zzzzzzzz01"]',
      customBalances: [{
        id: 'custom:zzzzzzzz01',
        name: '自定义甲',
        provider: 'review-fixture',
        balanceEndpoint: '/v1/credits',
        balancePath: 'data.balance',
        enabled: true,
      }],
    }),
    client: { quotaWindows: { 'custom:zzzzzzzz01': { status: 'ok', windows: [], unit: 'currency', currency: 'USD', sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  const block = byAttr(tree, 'data-policy-block', 'custom:zzzzzzzz01')
  check('S14a 自定义卡有公共策略块', block !== undefined)
  const box = byAttr(tree, 'data-policy-focus', 'custom:zzzzzzzz01')
  check('S14b 自定义卡的关键关注复选框已勾选', box !== undefined && box.props.checked === true)
  check('S14c 自定义卡金额输入使用其可信币种',
    byAttr(tree, 'data-policy-warning', 'custom:zzzzzzzz01|balance') !== undefined
    && textAll(tree).indexOf('余额阈值（USD）') !== -1, textAll(tree).slice(0, 900))
  // 自定义卡默认折叠：展开后原有字段必须仍在（我们只追加了底部策略块）。
  const expand = byAttr(tree, 'aria-label', '自定义甲 展开')
  if (expand !== undefined) {
    expand.props.onClick()
    tree = await runtimeSettle(ctx)
  }
  check('S14d 自定义卡原有字段仍在（名称/渠道/路径/币种）',
    byAttr(tree, 'id', 'custom-name-custom:zzzzzzzz01') !== undefined
    && byAttr(tree, 'id', 'custom-path-custom:zzzzzzzz01') !== undefined
    && byAttr(tree, 'id', 'custom-cur-custom:zzzzzzzz01') !== undefined,
    textAll(tree).slice(0, 900))
  ctx.client.restore()
}

// ===========================================================================
// S15 — 独立审查 P01：已关注但走 legacy 的渠道，输入框要显示旧有效值
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["workbuddy"]',
      quotaWarningCreditsThreshold: 400,
      quotaClosingCreditsThreshold: 100,
    }),
  })
  const tree = await mount(ctx)
  check('S15a 积分类 legacy 两档显示在输入框（不是空白）',
    byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.value === '400'
    && byAttr(tree, 'data-policy-closing', 'workbuddy|credits').props.value === '100',
    { warn: byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.value })
  check('S15b 状态行说明正在按旧版全局阈值判定',
    attrText(tree, 'data-policy-status', 'workbuddy').indexOf('旧版全局阈值') !== -1,
    attrText(tree, 'data-policy-status', 'workbuddy'))
  ctx.client.restore()
}

// ===========================================================================
// S16 — 独立审查 P02/P03：首次**直接改输入**也要先 seed 旧有效值
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["workbuddy"]',
      quotaWarningCreditsThreshold: 400,
      quotaClosingCreditsThreshold: 100,
    }),
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.onChange({ target: { value: '500' } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx)
  const p = JSON.parse(ctx.form.value.quotaChannelThresholds)
  check('S16a 改预警后收尾 100 不丢（先 seed 旧值）',
    p.workbuddy.credits.warning === 500 && p.workbuddy.credits.closing === 100, p.workbuddy)
  ctx.client.restore()

  const ctx2 = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaWarningPercentThreshold: 25,
      quotaClosingPercentThreshold: 8,
    }),
    client: { quotaWindows: { codex: { status: 'ok', windows: [{ key: 'rolling-5h', percent: 90 }, { key: 'weekly', percent: 60 }], sampledAt: 1 } } },
  })
  let tree2 = await mount(ctx2)
  byAttr(tree2, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '15' } })
  tree2 = await runtimeSettle(ctx2)
  byText(tree2, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx2)
  const p2 = JSON.parse(ctx2.form.value.quotaChannelThresholds)
  check('S16b 改周阈值后旧的最短窗口（5h 25/8）不丢',
    p2.codex.windows['rolling-5h'].warning === 25 && p2.codex.windows['rolling-5h'].closing === 8,
    p2.codex.windows)
  check('S16c 周窗口写入的是新值', p2.codex.windows.weekly.warning === 15, p2.codex.windows.weekly)
  ctx2.client.restore()
}

// ===========================================================================
// S23 — 审查 E01：WorkBuddy 账号选择变化也算来源变化 → 重取窗口能力
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["workbuddy"]',
      workbuddyAccounts: '["review-A"]',
    }),
  })
  await mount(ctx)
  const before = ctx.metadataFetches
  ctx.form.value = Object.assign({}, ctx.form.value, { workbuddyAccounts: '["review-B"]' })
  await runtimeSettle(ctx)
  check('S23a 换账号选择会重新拉取窗口能力',
    ctx.metadataFetches > before, { before, after: ctx.metadataFetches })
  // 顺序无关：同样内容换个顺序不算来源变化
  const beforeOrder = ctx.metadataFetches
  ctx.form.value = Object.assign({}, ctx.form.value, { workbuddyAccounts: '["review-B","review-C"]' })
  await runtimeSettle(ctx)
  const afterOrder = ctx.metadataFetches
  ctx.form.value = Object.assign({}, ctx.form.value, { workbuddyAccounts: '["review-C","review-B"]' })
  await runtimeSettle(ctx)
  check('S23b 账号列表顺序变化不算来源切换（不重复重取）',
    ctx.metadataFetches === afterOrder, { afterOrder, now: ctx.metadataFetches })
  void beforeOrder
  ctx.client.restore()
}

// ===========================================================================
// S24 — 审查 E02：自定义条目的 provider / 余额接口变化 → 重取窗口能力
// ===========================================================================
{
  const entry = (endpoint) => ({
    id: 'custom:edges00001',
    name: '边界甲',
    provider: 'review-fixture',
    balanceEndpoint: endpoint,
    balancePath: 'data.balance',
    enabled: true,
  })
  const ctx = open({
    value: Object.assign({}, BASE, { customBalances: [entry('/a')] }),
  })
  await mount(ctx)
  const before = ctx.metadataFetches
  ctx.form.value = Object.assign({}, ctx.form.value, { customBalances: [entry('/b')] })
  await runtimeSettle(ctx)
  check('S24a 改余额接口路径会重新拉取窗口能力',
    ctx.metadataFetches > before, { before, after: ctx.metadataFetches })
  ctx.client.restore()
}

// ===========================================================================
// S25 — 审查 E03：原生 number 的非法编辑（value:'' + badInput:true）不是"清空"
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["workbuddy"]',
      quotaChannelThresholds: JSON.stringify({ workbuddy: { credits: { warning: 400, closing: 100 } } }),
    }),
  })
  let tree = await mount(ctx)
  // 原生 DOM：非法输入时 value 为空串但 badInput 为 true
  byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.onChange({
    target: { value: '', validity: { badInput: true } },
  })
  tree = await runtimeSettle(ctx)
  check('S25a 非法编辑被拒绝（不写入草稿）',
    ctx.form.value.quotaChannelThresholds === JSON.stringify({ workbuddy: { credits: { warning: 400, closing: 100 } } })
    && byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.value === '400',
    byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.value)
  check('S25b 给出"不是有效数字"的提示',
    textAll(tree).indexOf('输入的不是有效数字') !== -1, textAll(tree).slice(0, 800))
  byText(tree, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx)
  check('S25c 保存后原来的 400/100 没有被清成 0',
    ctx.form.mutations.length === 0
    || JSON.parse(ctx.form.value.quotaChannelThresholds).workbuddy.credits.warning === 400,
    { mutations: ctx.form.mutations.length, value: ctx.form.value.quotaChannelThresholds })
  ctx.client.restore()

  // 真正清空（badInput=false）仍然 = 0 = 未配置，不能被误禁
  const ctx2 = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["workbuddy"]',
      quotaChannelThresholds: JSON.stringify({ workbuddy: { credits: { warning: 400, closing: 100 } } }),
    }),
  })
  let tree2 = await mount(ctx2)
  byAttr(tree2, 'data-policy-warning', 'workbuddy|credits').props.onChange({
    target: { value: '', validity: { badInput: false } },
  })
  tree2 = await runtimeSettle(ctx2)
  byText(tree2, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx2)
  const saved = JSON.parse(ctx2.form.value.quotaChannelThresholds)
  check('S25d 真正的空输入仍是 0（未配置），另一档保留',
    saved.workbuddy.credits.warning === 0 && saved.workbuddy.credits.closing === 100, saved.workbuddy)
  ctx2.client.restore()
}

// ===========================================================================
// S17 — 独立审查 P04：越界输入必须被保存校验拦住（不能被夹成 0 混过去）
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
    }),
    client: { quotaWindows: { codex: { status: 'ok', windows: [{ key: 'weekly', percent: 60 }], sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '105' } })
  tree = await runtimeSettle(ctx)
  check('S17a 越界值原样进草稿（不被夹成 0）',
    byAttr(tree, 'data-policy-warning', 'codex|weekly').props.value === '105')
  byText(tree, '保存更改')[0].props.onClick()
  tree = await runtimeSettle(ctx)
  check('S17b 越界 → 零写入', ctx.form.mutations.length === 0 && ctx.form.writes.length === 0,
    { mutations: ctx.form.mutations.length })
  check('S17c 错误可见（说明超出范围）',
    textAll(tree).indexOf('超出范围') !== -1, textAll(tree).slice(0, 900))
  ctx.client.restore()

  // 非数字文本在写入层就拒绝，不会污染草稿
  const ctx2 = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
    }),
    client: { quotaWindows: { codex: { status: 'ok', windows: [{ key: 'weekly', percent: 60 }], sampledAt: 1 } } },
  })
  let tree2 = await mount(ctx2)
  const before = ctx2.form.value.quotaChannelThresholds
  byAttr(tree2, 'data-policy-closing', 'codex|weekly').props.onChange({ target: { value: 'abc' } })
  tree2 = await runtimeSettle(ctx2)
  check('S17d 非数字文本被拒绝写入（草稿不变）',
    ctx2.form.value.quotaChannelThresholds === before
    && byAttr(tree2, 'data-policy-closing', 'codex|weekly').props.value === '5')
  check('S17e 给出"必须是数字"的提示',
    textAll(tree2).indexOf('必须是数字') !== -1, textAll(tree2).slice(0, 900))
  ctx2.client.restore()
}

// ===========================================================================
// S18 — 独立审查 P05：同一批里先改 A 再改 B，不能互相覆盖
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex","workbuddy"]',
      quotaChannelThresholds: JSON.stringify({
        codex: { windows: { weekly: { warning: 20, closing: 5 } } },
        workbuddy: { credits: { warning: 400, closing: 100 } },
      }),
    }),
    client: { quotaWindows: { codex: { status: 'ok', windows: [{ key: 'weekly', percent: 60 }], sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-warning', 'workbuddy|credits').props.onChange({ target: { value: '500' } })
  byAttr(tree, 'data-policy-warning', 'codex|weekly').props.onChange({ target: { value: '30' } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx)
  const p = JSON.parse(ctx.form.value.quotaChannelThresholds)
  check('S18a 两个渠道的改动都在（互不覆盖）',
    p.workbuddy.credits.warning === 500 && p.codex.windows.weekly.warning === 30, p)
  ctx.client.restore()
}

// ===========================================================================
// S19 — 独立审查 P06：toggling 关注不得把"无币种的旧规则"激活
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaWarningBalanceThreshold: 10,
      quotaClosingBalanceThreshold: 3,
      quotaBalanceCurrency: '',
    }),
    client: { quotaWindows: { deepseek: { status: 'ok', windows: [], unit: 'currency', currency: 'CNY', sampledAt: 1 } } },
  })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-focus', 'deepseek').props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  check('S19a 不创建"补了币种"的条目',
    ctx.form.value.quotaChannelThresholds === '' || ctx.form.value.quotaChannelThresholds === undefined,
    ctx.form.value.quotaChannelThresholds)
  check('S19b 状态行说明旧余额阈值缺币种、本来就不比较',
    attrText(tree, 'data-policy-status', 'deepseek').indexOf('没有配置币种') !== -1,
    attrText(tree, 'data-policy-status', 'deepseek'))
  ctx.client.restore()
}

// ===========================================================================
// S20 — 独立审查 P07：危险键 → 配置整体不可解析（不降级成 legacy）
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaChannelThresholds: '{"constructor":{}}',
    }),
  })
  const tree = await mount(ctx)
  check('S20a 危险键 → 明确报"无法解析"',
    textAll(tree).indexOf('无法解析') !== -1, textAll(tree).slice(0, 700))
  check('S20b 状态行不宣称已参与',
    attrText(tree, 'data-policy-status', 'codex').indexOf('已参与') !== 0,
    attrText(tree, 'data-policy-status', 'codex'))
  ctx.client.restore()
}

// ===========================================================================
// S21 — 独立审查 P11：监控总开关关闭时不得宣称已参与
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      enabled: false,
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["workbuddy"]',
      quotaChannelThresholds: JSON.stringify({ workbuddy: { credits: { warning: 400, closing: 100 } } }),
    }),
  })
  const tree = await mount(ctx)
  const status = attrText(tree, 'data-policy-status', 'workbuddy')
  check('S21a 监控关闭 → 状态为未生效', status.indexOf('未生效') === 0, status)
  ctx.client.restore()
}

// ===========================================================================
// S22 — 独立审查 P10：已保存配置（外部）变化 → 重新拉取窗口能力并作废旧值
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
    }),
    client: { quotaWindows: { codex: { status: 'ok', windows: [{ key: 'weekly', percent: 60 }], sampledAt: 1 } } },
  })
  const tree = await mount(ctx)
  // 外部（其它窗口/直接改 profile）替换了已保存配置：必须重新拉取窗口能力。
  const callsBefore = ctx.metadataFetches
  ctx.form.value = Object.assign({}, ctx.form.value, { codexEnabled: false })
  await runtimeSettle(ctx)
  const callsAfter = ctx.metadataFetches
  check('S22a 已保存配置变化会触发新的窗口能力请求',
    callsAfter > callsBefore, { callsBefore, callsAfter })
  void tree
  ctx.client.restore()
}

// ===========================================================================
// S26 — 审查 F03：服务端"失败信封"不能被当成成功（不冒用旧能力、给固定提示）
// ===========================================================================
{
  const ctx = open({
    value: Object.assign({}, BASE, {
      quotaPolicyEnabled: true,
      quotaTrustRouteOrder: true,
      quotaFocusChannels: '["codex"]',
      quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 20, closing: 5 } } } }),
    }),
    // HTTP 200 + {ok:false}：这是失败，不是"没有窗口"
    quotaWindowsBody: { ok: false, error: 'status' },
  })
  const tree = await mount(ctx)
  check('S26a 失败信封 → 显示固定提示（不声称来自采集观察）',
    textAll(tree).indexOf('未能读取窗口信息') !== -1
    && textAll(tree).indexOf('获取失败不代表没有该窗口') !== -1, textAll(tree).slice(0, 700))
  check('S26b 失败时不造可编辑窗口',
    byAttr(tree, 'data-policy-warning', 'codex|weekly') === undefined)
  check('S26c 失败时不显示"来自采集观察"的成功说明',
    textAll(tree).indexOf('窗口信息来自本插件已有的采集观察') === -1, textAll(tree).slice(0, 700))
  ctx.client.restore()
}

// S27 — 单总开关：一次点击成对写入（原 E04 两个独立开关的契约已变更）
// ===========================================================================
{
  /**
   * [2026-10-23 有意契约变更] 原断言是"同批点开总开关 + 路由信任，两个都保留"
   * （当时是两个独立控件）。用户已确认合并成**单一总开关**：一次显式打开就成对置
   * `quotaPolicyEnabled=true` 与 `quotaTrustRouteOrder=true`，所以现在断言的是成对结果。
   */
  const ctx = open({ value: Object.assign({}, BASE) })
  let tree = await mount(ctx)
  byAttr(tree, 'data-policy-master', '1').props.onChange({ target: { checked: true } })
  tree = await runtimeSettle(ctx)
  byText(tree, '保存更改')[0].props.onClick()
  await runtimeSettle(ctx)
  check('S27a 一次打开总开关 → policy 与 trust 成对为 true',
    ctx.form.value.quotaPolicyEnabled === true && ctx.form.value.quotaTrustRouteOrder === true,
    { policy: ctx.form.value.quotaPolicyEnabled, trust: ctx.form.value.quotaTrustRouteOrder })
  ctx.client.restore()
}

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
