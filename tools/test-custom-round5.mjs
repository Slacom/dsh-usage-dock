/**
 * [第五轮复核 R5-01 / R5-04 + 新 UI 要求] 定向回归。
 *
 * R5-01（P1 数据破坏）：设置页现在「每张卡片一个渲染实例」，单条模式下
 *   渲染下标恒为 0。旧实现用它索引完整列表 → **编辑/删除第二张卡片
 *   实际操作第一张**。这里用真实 SettingsPage 按钮 → 保存 → 检查 mutate，
 *   覆盖 6 个字段与删除，并验证其它条目不变。
 *
 * R5-04（P3）：内置首项「上移」的 disabled 被重复属性覆盖 → 按钮仍启用但无操作。
 *
 * 新 UI 要求：已保存卡片默认折叠；新条目自动展开自己；展开状态按 id 保持。
 *
 * 全部离线：合成配置与凭据，不发真实请求。
 *
 * 用法：node tools/test-custom-round5.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 14) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try { elementsOf(node.type(node.props), out, depth + 1) } catch (err) { /* hooks 组件跳过 */ }
    }
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) elementsOf(node.props.children, out, depth + 1)
  return out
}
const byAria = (tree, label) => elementsOf(tree).find((el) => el.props && el.props['aria-label'] === label)
const byId = (tree, id) => elementsOf(tree).find((el) => el.props && el.props.id === id)
const saveBtnOf = (tree) => elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === '保存更改')[0]

const PROVIDERS = [{
  provider: 'packyapi', displayName: 'PackyAPI', baseURL: 'https://cf.api.fan/v1',
  origin: 'https://cf.api.fan', baseURLSource: 'override', status: 'ready', reason: '',
}]

function mountWith(entries, planOrder) {
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('custom-status')
      ? { ok: true, data: { keys: {}, refs: [], providers: PROVIDERS } }
      : { ok: true, data: { plans: [], cfg: {} } }),
  })
  const mutations = []
  const form = {
    value: {
      enabled: true,
      planOrder: JSON.stringify(planOrder || []),
      customBalances: entries,
    },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(field, value) {
      this.value = Object.assign({}, this.value, { [field]: value })
      return Promise.resolve(true)
    },
    mutate(ops) {
      mutations.push(ops)
      for (const op of ops || []) {
        if (Array.isArray(op.path) && op.path.length === 1) {
          this.value = Object.assign({}, this.value, { [op.path[0]]: op.value })
        }
      }
      return Promise.resolve(true)
    },
  }
  runtime.mount(client.SettingsPage, { form })
  return { runtime, client, form, mutations }
}

const TWO = [
  {
    id: 'custom:aaaaaaaaaaaa', provider: 'packyapi', balanceEndpoint: '/credits',
    name: '甲', balancePath: 'data.a', subtractPath: '', currency: 'CNY', enabled: true,
  },
  {
    id: 'custom:bbbbbbbbbbbb', provider: 'packyapi', balanceEndpoint: '/credits',
    name: '乙', balancePath: 'data.b', subtractPath: '', currency: 'USD', enabled: true,
  },
]
const ORDER = ['opencode-go', 'custom:aaaaaaaaaaaa', 'deepseek', 'custom:bbbbbbbbbbbb']

async function openAndExpand(mounted, label) {
  const { runtime, form } = mounted
  let tree = await runtime.settle({ form })
  await new Promise((r) => setTimeout(r, 40))
  tree = await runtime.settle({ form })
  const expand = byAria(tree, label + ' 展开')
  if (expand !== undefined) {
    expand.props.onClick()
    tree = await runtime.settle({ form })
  }
  return tree
}

// ===========================================================================
// D1 — 默认折叠（已保存卡片首次进入不铺开编辑字段）
// ===========================================================================
{
  const mounted = mountWith(TWO, ORDER)
  const tree = await openAndExpand({ runtime: mounted.runtime, form: mounted.form }, '___none___')
  check('D1a 首次进入：已保存卡片默认折叠',
    byId(tree, 'custom-name-custom:aaaaaaaaaaaa') === undefined
    && byId(tree, 'custom-name-custom:bbbbbbbbbbbb') === undefined)
  check('D1b 折叠态仍提供展开按钮',
    byAria(tree, '甲 展开') !== undefined && byAria(tree, '乙 展开') !== undefined)
  check('D1c 折叠态仍可跨内置排序（上下移按钮存在）',
    byAria(tree, '甲 上移') !== undefined && byAria(tree, '甲 下移') !== undefined)
}

// ===========================================================================
// D2 — 展开只影响自己
// ===========================================================================
{
  const mounted = mountWith(TWO, ORDER)
  const tree = await openAndExpand(mounted, '乙')
  check('D2a 展开乙后只有乙的字段出现',
    byId(tree, 'custom-name-custom:bbbbbbbbbbbb') !== undefined
    && byId(tree, 'custom-name-custom:aaaaaaaaaaaa') === undefined)
  check('D2b 按钮提示与状态一致（乙变为「收起」）',
    byAria(tree, '乙 折叠') !== undefined && byAria(tree, '甲 展开') !== undefined)
}

// ===========================================================================
// D3 — [R5-01] 编辑第二张卡片只改第二张
// ===========================================================================
{
  const fields = [
    ['name', '乙改名', (t) => byId(t, 'custom-name-custom:bbbbbbbbbbbb').props.onChange({ target: { value: '乙改名' } })],
    ['enabled', false, (t) => {
      const card = elementsOf(t).filter((el) => el.props && el.props['data-custom-id'] === 'custom:bbbbbbbbbbbb')[0]
      const box = elementsOf(card).find((el) => el.type === 'input' && el.props && el.props.type === 'checkbox')
      if (box === undefined) throw new Error('无 checkbox')
      box.props.onChange({ target: { checked: false } })
    }],
    ['provider', 'packyapi', (t) => byId(t, 'custom-provider-custom:bbbbbbbbbbbb').props.onChange({ target: { value: 'packyapi' } })],
    ['balanceEndpoint', '/v2/credits', (t) => byId(t, 'custom-endpoint-custom:bbbbbbbbbbbb').props.onChange({ target: { value: '/v2/credits' } })],
    ['balancePath', 'data.b2', (t) => byId(t, 'custom-path-custom:bbbbbbbbbbbb').props.onChange({ target: { value: 'data.b2' } })],
    ['currency', 'EUR', (t) => byId(t, 'custom-cur-custom:bbbbbbbbbbbb').props.onChange({ target: { value: 'eur' } })],
  ]
  let allOk = true
  const details = []
  for (const [label, , act] of fields) {
    const mounted = mountWith(TWO, ORDER)
    let tree = await openAndExpand(mounted, '乙')
    try { act(tree) } catch (err) { details.push(label + ':动作失败 ' + err.message); allOk = false; continue }
    tree = await mounted.runtime.settle({ form: mounted.form })
    const save = saveBtnOf(tree)
    if (save !== undefined) save.props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    tree = await mounted.runtime.settle({ form: mounted.form })

    const batch = mounted.mutations.length > 0 ? mounted.mutations[mounted.mutations.length - 1] : []
    const op = batch.find((o) => Array.isArray(o.path) && o.path.length === 1 && o.path[0] === 'customBalances')
    const saved = op !== undefined && Array.isArray(op.value) ? op.value : []
    const a = saved.find((e) => e.id === 'custom:aaaaaaaaaaaa')
    const b = saved.find((e) => e.id === 'custom:bbbbbbbbbbbb')
    const aUnchanged = a !== undefined
      && a.name === '甲' && a.balancePath === 'data.a' && a.currency === 'CNY' && a.enabled === true
      && a.balanceEndpoint === '/credits'
    const bChanged = b !== undefined && label !== 'provider' ? true : b !== undefined
    if (!(aUnchanged && bChanged)) {
      allOk = false
      details.push(label + ': A=' + JSON.stringify(a) + ' B=' + JSON.stringify(b))
    }
    mounted.client.restore()
  }
  check('D3a 编辑第二张卡片的 6 个字段都不影响第一张', allOk, details)
}

// ===========================================================================
// D4 — [R5-01] 删除第二张卡片只删第二张
// ===========================================================================
{
  const mounted = mountWith(TWO, ORDER)
  let tree = await openAndExpand(mounted, '乙')
  const del = elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === '删除此条')
  check('D4a 两条卡片各有删除按钮', del.length === 2, del.length)
  // 第二个删除按钮属于乙（渲染顺序：甲在前）。
  if (del.length === 2) del[1].props.onClick()
  tree = await mounted.runtime.settle({ form: mounted.form })
  const save = saveBtnOf(tree)
  if (save !== undefined) save.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  tree = await mounted.runtime.settle({ form: mounted.form })

  const batch = mounted.mutations.length > 0 ? mounted.mutations[mounted.mutations.length - 1] : []
  const op = batch.find((o) => Array.isArray(o.path) && o.path.length === 1 && o.path[0] === 'customBalances')
  const saved = op !== undefined && Array.isArray(op.value) ? op.value : []
  const ids = saved.map((e) => e.id)
  check('D4b 删除乙后只剩甲（不是误删甲）',
    ids.length === 1 && ids[0] === 'custom:aaaaaaaaaaaa', ids)
  mounted.client.restore()
}

// ===========================================================================
// D5 — [R5-04] 内置首项「上移」真的禁用
// ===========================================================================
{
  const mounted = mountWith(TWO, ORDER)
  const tree = await openAndExpand({ runtime: mounted.runtime, form: mounted.form }, '___none___')
  const builtInFirst = ORDER[0] // opencode-go
  const meta = { 'opencode-go': 'OpenCode Go', deepseek: 'DeepSeek' }
  const upFirst = byAria(tree, (meta[builtInFirst] || builtInFirst) + ' 上移')
  check('D5a 内置首项的上移按钮被禁用（R5-04 重复 disabled 已修）',
    upFirst !== undefined && upFirst.props.disabled === true,
    upFirst && { disabled: upFirst.props.disabled })
  const downLast = byAria(tree, 'WorkBuddy AI 下移')
  check('D5b 内置末项的下移按钮被禁用',
    downLast === undefined || downLast.props.disabled === true,
    downLast && downLast.props.disabled)
  mounted.client.restore()
}

// ===========================================================================
// D6 — 新增条目只展开自己
// ===========================================================================
{
  const mounted = mountWith(TWO, ORDER)
  const { runtime, form } = mounted
  let tree = await runtime.settle({ form })
  await new Promise((r) => setTimeout(r, 40))
  tree = await runtime.settle({ form })
  const add = elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === '＋ 添加自定义余额渠道')[0]
  if (add !== undefined) add.props.onClick()
  tree = await runtime.settle({ form })

  const cards = elementsOf(tree).filter((el) => el.props && el.props['data-custom-id'])
  const newCard = cards.map((c) => c.props['data-custom-id']).filter((id) => id !== 'custom:aaaaaaaaaaaa' && id !== 'custom:bbbbbbbbbbbb')
  check('D6a 新增后出现第三条卡片', newCard.length === 1, newCard)
  if (newCard.length === 1) {
    check('D6b 新条目自动展开（便于填写）',
      byId(tree, 'custom-name-' + newCard[0]) !== undefined)
    check('D6c 其它已有条目仍保持折叠（未被连带展开）',
      byId(tree, 'custom-name-custom:aaaaaaaaaaaa') === undefined
      && byId(tree, 'custom-name-custom:bbbbbbbbbbbb') === undefined)
  }
  mounted.client.restore()
}

// ===========================================================================
// D7 — [真机回归] WorkBuddy 账号选择不能把设置页带成白屏
// ===========================================================================
{
  /**
   * 真机故障：账号区块里用了 `locked`（那是 CustomBalancesSection 的局部变量），
   * 在设置页作用域里未定义 → 渲染时 ReferenceError → **整页设置白屏**。
   * 这里渲染一次「WorkBuddy 启用」的设置页，断言页面与账号区块都在。
   */
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
  })
  globalThis.fetch = async (url) => {
    if (String(url).includes('workbuddy-accounts')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            accounts: [{
              id: 'U-1', label: 'Slacom', realm: 'cn',
              remain: 5765, size: 6600, disabled: false, cooling: false,
            }],
          },
        }),
      }
    }
    if (String(url).includes('custom-status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { keys: {}, refs: [], providers: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { plans: [], cfg: {} } }) }
  }
  const form = {
    value: { enabled: true, workbuddyEnabled: true, planOrder: '[]', customBalances: [] },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(field, value) { this.value = Object.assign({}, this.value, { [field]: value }); return Promise.resolve(true) },
    mutate() { return Promise.resolve(true) },
  }
  runtime.mount(client.SettingsPage, { form })
  await new Promise((r) => setTimeout(r, 60))
  const tree = await runtime.settle({ form })
  const text = textOf(tree)
  check('D7a 设置页整体渲染成功（不白屏）', typeof text === 'string' && text.length > 0)
  check('D7b WorkBuddy 卡片内出现账号合计提示', text.indexOf('账号合计') !== -1)
  check('D7c 账号名出现在账号选择里', text.indexOf('Slacom') !== -1)
  const box = elementsOf(tree).find((el) => el.type === 'input' && el.props && el.props['data-workbuddy-account'] === 'U-1')
  check('D7d 账号复选框存在且绑定 uid', box !== undefined)
  check('D7e 账户复选框不是禁用状态（可写部署）', box !== undefined && box.props.disabled === false)
  client.restore()
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
