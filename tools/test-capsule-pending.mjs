/**
 * [2026-11-12 批次 G] 胶囊启动占位：首帧就列出**所有已启用**渠道（灰点 + '…'），
 * 真实 wire 到达后逐行替换。
 *
 * 全离线（tools/mock-react.mjs 的极简 React 运行时 + fake fetch）：无 localhost、无真实 Host、
 * 不读真实配置/凭据。
 *
 *   U*  纯函数 `withPendingPlaceholders`（经 client 的离线挂载点导出）
 *   P1  首帧：空的 wire ⇒ 每个已启用渠道一行 '…'，顺序 = planOrder
 *   P2  停用渠道**整行不存在**（不是灰掉）
 *   P3  wire 到达 ⇒ 占位消失、换成数值行、行数不变、无重复
 *   P4  自定义条目：启用的有占位（用其名称）、停用的没有
 *   P5  config 不可用 ⇒ 不铺任何占位（保持原行为）
 *
 * 用法：node tools/test-capsule-pending.mjs
 *      DSH_CLIENT_UNDER_TEST=<stage/client.js> node tools/test-capsule-pending.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else {
    fail++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 600)))
  }
}

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 16) return out
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
function textAll(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 26) return out.join('')
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out.join('') }
  if (Array.isArray(node)) { for (const n of node) textAll(n, out, depth); return out.join('') }
  if (typeof node !== 'object' || node.type === undefined) return out.join('')
  textAll(node.props ? node.props.children : undefined, out, depth + 1)
  return out.join('')
}
/** 胶囊里的占位行：结构是 [dot, 名称, 数值] 且数值区恰好是 '…'。 */
const pendingRows = (tree) => elementsOf(tree).filter((el) => {
  const kids = el.props ? el.props.children : undefined
  return Array.isArray(kids) && kids.length === 3 && textOf(kids[2]) === '…'
})

const BASE = {
  enabled: true,
  planOrder: '[]',
  opencodeGoEnabled: false,
  codexEnabled: false,
  mimoEnabled: false,
  deepseekEnabled: true,
  workbuddyEnabled: true,
}

function makeForm(initial) {
  const listeners = new Set()
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]' }, initial || {}),
    writable: true,
    getSnapshot() { return { value: this.value, writable: this.writable } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(field, value) { form.value = Object.assign({}, form.value, { [field]: value }); listeners.forEach((fn) => fn()) },
  }
  return form
}

async function mountBadge(config, payload) {
  const runtime = createRuntime()
  const form = makeForm(config)
  const client = loadClient(runtime, { form, payload })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  return { tree, client, form, runtime }
}

const EMPTY = { ok: true, data: { plans: [] } }

// ===========================================================================
// U — 纯函数
// ===========================================================================
{
  const { client } = await mountBadge(BASE, EMPTY)
  const fn = client.module.pendingPlaceholders
  check('U0 client 导出了 pendingPlaceholders（纯函数挂载点）', typeof fn === 'function')

  const input = [{ id: 'deepseek' }]
  check('U1 config 不可用（null/undefined/字符串）⇒ 原样返回、不铺占位',
    fn(input, null) === input && fn(input, undefined) === input && fn(input, 'x') === input)

  const all = fn([], BASE)
  check('U2 空 wire ⇒ 只铺已启用的内置渠道（deepseek + workbuddy），顺序 = PLANS 顺序',
    all.length === 2 && all[0].id === 'deepseek' && all[1].id === 'workbuddy'
    && all.every((p) => p.pending === true), all.map((p) => p.id))

  check('U3 停用渠道不铺（workbuddyEnabled:false ⇒ 只剩 deepseek）',
    fn([], Object.assign({}, BASE, { workbuddyEnabled: false })).map((p) => p.id).join(',') === 'deepseek')

  const dedupe = fn([{ id: 'deepseek', balance: 7.38 }], BASE)
  check('U4 已有真实 plan 的 id 不重复铺',
    dedupe.filter((p) => p.id === 'deepseek').length === 1 && dedupe[0].pending !== true, dedupe.map((p) => p.id))

  check('U5 planOrder 生效（workbuddy 排到 deepseek 前）',
    fn([], Object.assign({}, BASE, { planOrder: JSON.stringify(['workbuddy', 'deepseek']) }))
      .map((p) => p.id).join(',') === 'workbuddy,deepseek')

  const custom = {
    id: 'custom:pendingAAA1', name: '测试渠道A', provider: 'x', balanceEndpoint: '/v1/balance',
    url: 'https://a.example/b', balancePath: 'data.balance', currency: 'CNY', enabled: true,
  }
  const off = Object.assign({}, custom, { id: 'custom:pendingBBB2', name: '停产渠道B', enabled: false })
  const withCustom = fn([], Object.assign({}, BASE, { customBalances: [custom, off] }))
  check('U6 自定义条目：启用的铺占位（用其名称），停用的不铺',
    withCustom.some((p) => p.id === 'custom:pendingAAA1' && p.name === '测试渠道A' && p.pending === true)
    && !withCustom.some((p) => p.id === 'custom:pendingBBB2'), withCustom.map((p) => p.id))

  check('U7 占位对象不带任何数值字段（不伪造数据）',
    withCustom.every((p) => p.pending !== true
      || (p.balance === undefined && p.currency === undefined && p.percent === undefined && p.windows === undefined)))
  client.restore()
}

// ===========================================================================
// P1 — 首帧：所有已启用渠道都出现占位
// ===========================================================================
{
  const { tree, client } = await mountBadge(BASE, EMPTY)
  const text = textAll(tree)
  const rows = pendingRows(tree)
  check('P1a 首帧两行占位（deepseek + workbuddy）', rows.length === 2, rows.length)
  check('P1b 行名与顺序：DeepSeek 在 WorkBuddy 之前',
    text.indexOf('DeepSeek') !== -1 && text.indexOf('WorkBuddy') !== -1
    && text.indexOf('DeepSeek') < text.indexOf('WorkBuddy'), text.slice(0, 120))
  check('P1c 数值区是单个 …，且不含数字/币种/✦/%',
    rows.every((r) => textOf(r.props.children[2]) === '…') && !/[0-9]/.test(text)
    && text.indexOf('¥') === -1 && text.indexOf('✦') === -1 && text.indexOf('%') === -1, text.slice(0, 160))
  check('P1d 状态点是中性灰（dot:null ⇒ label-secondary），不是成功/失败色',
    rows.every((r) => {
      const dot = r.props.children[0]
      return dot !== undefined && dot.props && dot.props.style
        && dot.props.style.background === 'var(--dsw-alias-label-secondary)'
    }), rows.map((r) => r.props.children[0].props.style.background))
  check('P1e 未启用渠道整行不存在（OpenCode/Codex/MiMo）',
    ['OpenCode Go', 'OpenAI Codex', 'Xiaomi MiMo'].every((n) => text.indexOf(n) === -1), text.slice(0, 160))
  client.restore()
}

// ===========================================================================
// P2 — 停用即整行消失
// ===========================================================================
{
  const { tree, client } = await mountBadge(Object.assign({}, BASE, { workbuddyEnabled: false }), EMPTY)
  const text = textAll(tree)
  check('P2a 停用 workbuddy ⇒ 该行完全不存在', text.indexOf('WorkBuddy') === -1, text.slice(0, 120))
  check('P2b 其余启用渠道仍在（deepseek），且只有 1 行占位',
    text.indexOf('DeepSeek') !== -1 && pendingRows(tree).length === 1, text.slice(0, 120))
  client.restore()
}

// ===========================================================================
// P3 — wire 到达：占位换成真实数值行，行数不变、无重复
// ===========================================================================
{
  const WIRE = {
    ok: true,
    data: {
      plans: [
        { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
        { id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 1234 },
      ],
      cfg: { digest: null, readAt: 1, reloadable: true },
    },
  }
  const { tree, client, form } = await mountBadge(BASE, WIRE)
  const text = textAll(tree)
  check('P3a 真实数据到达后没有占位行', pendingRows(tree).length === 0, pendingRows(tree).length)
  check('P3b 显示真实数值（DeepSeek 7.38 / WorkBuddy ✦1,234）',
    /7\.38/.test(text) && /1,234/.test(text), text.slice(0, 160))
  check('P3c 行数仍是 2、无重复渠道名',
    (text.match(/DeepSeek/g) || []).length === 1 && (text.match(/WorkBuddy/g) || []).length === 1, text.slice(0, 160))
  const merged = client.module.pendingPlaceholders(WIRE.data.plans, form.value)
  check('P3d 同一批 wire 再跑占位函数不新增任何行', merged.length === 2, merged.map((p) => p.id))
  client.restore()
}

// ===========================================================================
// P4 — 自定义条目占位（启用有、停用无）
// ===========================================================================
{
  const custom = {
    id: 'custom:pendingAAA1', name: '测试渠道A', provider: 'x', balanceEndpoint: '/v1/balance',
    url: 'https://a.example/b', balancePath: 'data.balance', currency: 'CNY', enabled: true,
  }
  const off = Object.assign({}, custom, { id: 'custom:pendingBBB2', name: '停产渠道B', enabled: false })
  const { tree, client } = await mountBadge(
    Object.assign({}, BASE, { deepseekEnabled: false, workbuddyEnabled: false, customBalances: [custom, off] }),
    EMPTY,
  )
  const text = textAll(tree)
  check('P4a 启用中的自定义条目首帧有占位（用自己的名称）',
    text.indexOf('测试渠道A') !== -1 && pendingRows(tree).length === 1,
    { text: text.slice(0, 120), rows: pendingRows(tree).length })
  check('P4b 停用的自定义条目完全不出现', text.indexOf('停产渠道B') === -1)
  check('P4c 占位行不含数字/币种（没把 CNY 之类漏进去）',
    !/[0-9]/.test(text) && text.indexOf('CNY') === -1, text.slice(0, 120))
  client.restore()
}

// ===========================================================================
// P5 — config 不可用 ⇒ 不铺占位（保持原行为）
// ===========================================================================
{
  const runtime = createRuntime()
  const client = loadClient(runtime, { payload: EMPTY })
  runtime.mount(client.Badge, { wide: true })
  const tree = await runtime.settle({ wide: true })
  check('P5a 没有 configForm ⇒ 不铺任何占位行', pendingRows(tree).length === 0, textAll(tree).slice(0, 120))
  client.restore()
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
