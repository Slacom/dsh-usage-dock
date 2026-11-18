/**
 * [0.11.2] Codex Subscription「一键适配」块的**离线渲染**回归。
 *
 * 覆盖用户要求的两条行为：
 *   ① 装了并启用第三方插件、但还没适配 → 设置页里出现「应用本地适配」按钮；
 *   ② 已经适配（`patched`）或已能读到服务（块根本不挂载）→ 不出现按钮。
 *
 * 全部跑**真实的 client.js**（tools/mock-react.mjs 的极简 React 运行时）+ fake fetch：
 * 没有 localhost 服务、没有真实 Host、没有真实第三方包。
 *
 * 用法：node tools/test-codex-adapt-ui.mjs
 *      DSH_CLIENT_UNDER_TEST=<stage/client.js> node tools/test-codex-adapt-ui.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else {
    fail++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600)))
  }
}

/** 深度优先收集元素节点（只认 type 为字符串的真实宿主元素）。 */
function elementsOf (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 16) return out
  if (Array.isArray(node)) { for (const n of node) elementsOf(n, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'string') {
    out.push(node)
    elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
  }
  return out
}
const byAttr = (tree, key, value) => elementsOf(tree).find((n) => n.props && n.props[key] === value)
const allByAttr = (tree, key, value) => elementsOf(tree).filter((n) => n.props && n.props[key] === value)
const treeText = (tree) => textOf(tree)

const INCOMPATIBLE = {
  ok: true,
  data: {
    sources: [
      { id: 'connect', label: 'Codex Connect', enabled: true, compatible: true },
      { id: 'subscription', label: 'Codex Subscription', enabled: true, compatible: false },
    ],
    selected: 'connect',
  },
}

const patchState = (data) => ({ ok: true, data })

async function mountBlock (opts = {}) {
  const runtime = createRuntime()
  const client = loadClient(runtime, Object.assign({
    payload: { ok: true, data: { plans: [] } },
    codexSources: INCOMPATIBLE,
  }, opts.clientOpts || {}))
  runtime.mount(client.module.codexSource.PatchBlock, Object.assign({ active: true, writable: true }, opts.props || {}))
  const tree = await runtime.settle(Object.assign({ active: true, writable: true }, opts.props || {}))
  return { tree, client, runtime }
}

// ── P1 未适配 + 版本可适配 → 出现按钮 ────────────────────────────────────────
{
  const { tree, client } = await mountBlock({
    clientOpts: {
      patchState: patchState({
        installed: true, version: '3.2.23', state: 'appliable', serviceAvailable: false,
        manifestVersion: '3.2.23', covered: ['3.2.6', '3.2.13', '3.2.23'],
      }),
    },
  })
  const text = treeText(tree)
  const button = byAttr(tree, 'data-cs-patch', 'apply')
  check('P1a 可适配 ⇒ 渲染「应用本地适配」按钮', button !== undefined && button.type === 'button')
  check('P1b 按钮文案是「应用本地适配」', button !== undefined && textOf(button) === '应用本地适配')
  check('P1c 说明里带已装版本号', text.indexOf('3.2.23') !== -1, text.slice(0, 160))
  check('P1d 说明交代「可一键适配」', text.indexOf('可一键适配') !== -1, text.slice(0, 160))
  check('P1e 块标记为 appliable', byAttr(tree, 'data-codex-source-patch', 'appliable') !== undefined)
  client.restore()
}

// ── P2 已适配（等重启）→ 不给按钮 ──────────────────────────────────────────
{
  const { tree, client } = await mountBlock({
    clientOpts: {
      patchState: patchState({ installed: true, version: '3.2.23', state: 'patched', serviceAvailable: true, manifestVersion: '3.2.23', covered: ['3.2.23'] }),
    },
  })
  const text = treeText(tree)
  check('P2a 已适配 ⇒ 不出现按钮', byAttr(tree, 'data-cs-patch', 'apply') === undefined)
  check('P2b 已适配 ⇒ 说明「重启 DSH 后可读取订阅额度」', text.indexOf('已适配') !== -1 && text.indexOf('重启 DSH') !== -1, text.slice(0, 160))
  check('P2c 块标记为 patched', byAttr(tree, 'data-codex-source-patch', 'patched') !== undefined)
  client.restore()
}

// ── P3 版本无清单 → 说明 + 不给按钮 ────────────────────────────────────────
{
  const { tree, client } = await mountBlock({
    clientOpts: {
      patchState: patchState({ installed: true, version: '3.2.99', state: 'unsupported', serviceAvailable: false, manifestVersion: null, covered: ['3.2.6', '3.2.13'] }),
    },
  })
  const text = treeText(tree)
  check('P3a 无清单 ⇒ 不出现按钮', byAttr(tree, 'data-cs-patch', 'apply') === undefined)
  check('P3b 说明里列出已收录版本', text.indexOf('已收录') !== -1 && text.indexOf('3.2.6 / 3.2.13') !== -1, text.slice(0, 200))
  check('P3c 不再退回「请升级本插件」这种误导话（版本号可见）', text.indexOf('3.2.99') !== -1 && text.indexOf('请升级本插件') === -1, text.slice(0, 200))
  client.restore()
}

// ── P4 有清单但基线不符 → 说明 + 不给按钮 ──────────────────────────────────
{
  const { tree, client } = await mountBlock({
    clientOpts: {
      patchState: patchState({ installed: true, version: '3.2.23', state: 'unsupported', serviceAvailable: false, manifestVersion: '3.2.23', covered: ['3.2.23'] }),
    },
  })
  const text = treeText(tree)
  check('P4a 基线不符 ⇒ 不出现按钮', byAttr(tree, 'data-cs-patch', 'apply') === undefined)
  check('P4b 说明是「基线不一致」', text.indexOf('基线不一致') !== -1, text.slice(0, 200))
  check('P4c 不说「暂无适配清单」', text.indexOf('暂无适配清单') === -1, text.slice(0, 200))
  client.restore()
}

// ── P5 探测失败 → 退回旧行为（显示按钮，点击后按固定文案分流） ──────────────
{
  const { tree, client } = await mountBlock({ clientOpts: { patchStateError: true } })
  check('P5a 探测失败 ⇒ 仍显示按钮（不因探测失败把功能藏掉）', byAttr(tree, 'data-cs-patch', 'apply') !== undefined)
  client.restore()
}

// ── P6 点按 → 只发一次 POST，成功后给「已应用」文案 ────────────────────────
{
  let applyCalls = 0
  const clientOpts = {
    patchState: patchState({ installed: true, version: '3.2.23', state: 'appliable', serviceAvailable: false, manifestVersion: '3.2.23', covered: ['3.2.23'] }),
  }
  const runtime = createRuntime()
  const client = loadClient(runtime, Object.assign({
    payload: { ok: true, data: { plans: [] } },
    codexSources: INCOMPATIBLE,
  }, clientOpts))
  runtime.mount(client.module.codexSource.PatchBlock, { active: true, writable: true })
  const before = await runtime.settle({ active: true, writable: true })
  const button = byAttr(before, 'data-cs-patch', 'apply')
  check('P6a 点击前按钮存在', button !== undefined)
  if (button !== undefined && typeof button.props.onClick === 'function') {
    applyCalls += 1
    button.props.onClick()
    const after = await runtime.settle({ active: true, writable: true })
    const text = treeText(after)
    check('P6b 点击后显示「已应用，重启 DSH 后可读取订阅额度」', text.indexOf('已应用') !== -1 && text.indexOf('重启 DSH') !== -1, text.slice(0, 200))
    check('P6c 点击后不再有按钮（不会重复点按）', byAttr(after, 'data-cs-patch', 'apply') === undefined)
  } else {
    check('P6b 点击后显示「已应用」文案', false, 'no onClick')
    check('P6c 点击后不再有按钮', false, 'no onClick')
  }
  check('P6d 只触发一次点击（用例自身计数）', applyCalls === 1)
  client.restore()
}

// ── P7 active=false（来源 metadata 还没到位 / 已可用）→ 一个节点都不渲染 ────
{
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    payload: { ok: true, data: { plans: [] } },
    codexSources: INCOMPATIBLE,
    patchState: patchState({ installed: true, version: '3.2.23', state: 'appliable', serviceAvailable: false, manifestVersion: '3.2.23', covered: ['3.2.23'] }),
  })
  runtime.mount(client.module.codexSource.PatchBlock, { active: false, writable: true })
  const tree = await runtime.settle({ active: false, writable: true })
  check('P7 active=false ⇒ 不渲染块', tree === null || allByAttr(tree, 'data-codex-source-patch', 'appliable').length === 0)
  client.restore()
}

// ── P8 设置页落点：顶层分区 settings.section（与 Codex 订阅并列）+ 钱包图标 ──
{
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: {},
    payload: { ok: true, data: { plans: [] } },
    codexSources: INCOMPATIBLE,
    patchState: patchState({ installed: true, version: '3.2.23', state: 'appliable', serviceAvailable: false, manifestVersion: '3.2.23', covered: ['3.2.23'] }),
  })
  check('P8a 设置页注册在顶层分区 settings.section（id=plan-usage）',
    client.sectionSpec !== null && client.sectionSpec.name === 'settings.section' && client.sectionSpec.id === 'plan-usage',
    client.sectionSpec)
  check('P8b 分区 order=16（紧跟在 Codex 订阅的 15 之后）', client.sectionSpec !== null && client.sectionSpec.order === 16)
  check('P8c 图标槽位 settings.section.icon 注册了组件', typeof client.sectionIcon === 'function')
  check('P8d 不再注册「内置插件」tab', client.slotNames.indexOf('settings.plugins.tab') === -1, client.slotNames)
  client.restore()
}

console.log('累计：' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
