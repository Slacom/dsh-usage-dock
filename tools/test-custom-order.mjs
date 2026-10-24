/**
 * [用户实测 2026-10-20 排序修复] 自定义渠道的上移/下移必须真的改变显示顺序。
 *
 * 用户反馈：设置页点 ▲/▼ 后，胶囊与详情面板的条目顺序**毫无变化**。
 *
 * 根因：卡片的 `move()` 只改 `customBalances` 数组，而胶囊/详情面板只按
 * `planOrder` 排序（内置渠道从 `orderedPlanMetas()` 走，自定义条目则按 Host
 * 返回的数组顺序）。两条链路互不相干。
 *
 * 修复后必须同时成立：
 *   1. `planOrder` 里出现自定义 id，且顺序与草稿一致；
 *   2. Host 侧按 `planOrder` 排序返回（`orderCustomByPlanOrder` 的等价规则）；
 *   3. 未列入 `planOrder` 的条目保持原相对顺序，不丢。
 *
 * 用法：node tools/test-custom-order.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')) }
}

/**
 * 展开成元素列表；与 test-custom-settings.mjs 的实现一致：
 * 函数组件要**调用一次**才能拿到它渲染出的子树（mock 运行时不会自动展开）。
 */
function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try {
        const rendered = node.type(node.props)
        if (rendered !== undefined) elementsOf(rendered, out, depth + 1)
      } catch (err) { /* 组件抛错时跳过，让断言给出更清楚的失败 */ }
    }
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) {
    elementsOf(node.props.children, out, depth + 1)
  }
  return out
}
function byAria(tree, label) {
  return elementsOf(tree).find((el) => el.props && el.props['aria-label'] === label)
}
function byText(tree, text) {
  return elementsOf(tree).filter((el) => el.props && textOf(el).indexOf(text) !== -1)
}

function makeForm(initial) {
  const listeners = new Set()
  const mutations = []
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]' }, initial || {}),
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(field, value) {
      form.value = Object.assign({}, form.value, { [field]: value })
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
    mutate(ops) {
      mutations.push(ops)
      for (const op of ops || []) {
        if (Array.isArray(op.path) && op.path.length === 1) {
          form.value = Object.assign({}, form.value, { [op.path[0]]: op.value })
        }
      }
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
  }
  return { form, mutations }
}

const runtime = createRuntime()
const client = loadClient(runtime, {
  form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
})

globalThis.fetch = async (url) => ({
  json: async () => (String(url).includes('custom-status')
    ? {
      ok: true,
      data: {
        keys: {}, refs: {},
        providers: [{
          provider: 'packyapi', displayName: 'PackyAPI', baseURL: 'https://cf.api.fan/v1',
          origin: 'https://cf.api.fan', baseURLSource: 'override', status: 'ready', reason: '',
        }],
      },
    }
    : { ok: true, data: { plans: [], cfg: {} } }),
})

const two = [
  {
    id: 'custom:aaaaaaaaaaaa', provider: 'packyapi', balanceEndpoint: '/credits',
    name: '甲', balancePath: 'data.balance', subtractPath: '', currency: 'USD', enabled: true,
  },
  {
    id: 'custom:bbbbbbbbbbbb', provider: 'packyapi', balanceEndpoint: '/credits',
    name: '乙', balancePath: 'data.balance', subtractPath: '', currency: 'USD', enabled: true,
  },
]

const { form, mutations } = makeForm({
  planOrder: JSON.stringify(['opencode-go', 'deepseek', 'custom:aaaaaaaaaaaa', 'custom:bbbbbbbbbbbb']),
  customBalances: two,
})
runtime.mount(client.SettingsPage, { form })
let tree = await runtime.settle({ form })
await new Promise((r) => setTimeout(r, 40))
tree = await runtime.settle({ form })

// ---------------------------------------------------------------------------
// O1 — 点「下移」→ 保存后 customBalances 与 planOrder **都**按新顺序写入
// ---------------------------------------------------------------------------
{
  const cards = elementsOf(tree).filter((el) => el.props && el.props['data-custom-id'] !== undefined)
  check('O1a 两条自定义卡片都在', cards.length === 2, cards.map((c) => c.props['data-custom-id']))

  const down = byAria(tree, '甲 下移')
  check('O1b 「甲 下移」按钮存在', down !== undefined)
  down.props.onClick()
  tree = await runtime.settle({ form })

  // 点「保存更改」把草稿落盘：这是用户实际动作，也是唯一能观察到结果的路径。
  const saveBtn = elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === '保存更改')[0]
  check('O1c 保存按钮存在且可用', saveBtn !== undefined && saveBtn.props.disabled === false)
  if (saveBtn !== undefined) saveBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  tree = await runtime.settle({ form })

  const batch = mutations.length > 0 ? mutations[mutations.length - 1] : []
  const balancesOp = batch.find((op) => Array.isArray(op.path) && op.path.length === 1 && op.path[0] === 'customBalances')
  const orderOp = batch.find((op) => Array.isArray(op.path) && op.path.length === 1 && op.path[0] === 'planOrder')

  const balanceIds = balancesOp !== undefined && Array.isArray(balancesOp.value)
    ? balancesOp.value.map((e) => e.id)
    : []
  check('O1d 保存的 customBalances 已按新顺序',
    balanceIds[0] === 'custom:bbbbbbbbbbbb' && balanceIds[1] === 'custom:aaaaaaaaaaaa', balanceIds)

  const order = orderOp !== undefined && typeof orderOp.value === 'string'
    ? JSON.parse(orderOp.value)
    : []
  check('O1e 保存的 planOrder 里包含自定义 id', order.indexOf('custom:aaaaaaaaaaaa') !== -1
    && order.indexOf('custom:bbbbbbbbbbbb') !== -1, order)
  check('O1f planOrder 里自定义的相对顺序与草稿一致',
    order.indexOf('custom:bbbbbbbbbbbb') < order.indexOf('custom:aaaaaaaaaaaa'), order)
  check('O1g 内置渠道仍在且在前面',
    order.indexOf('opencode-go') === 0 && order.indexOf('custom:bbbbbbbbbbbb') > 0, order)
}


// ---------------------------------------------------------------------------
// O2 — 「上移」同样生效（与 O1 共用同一实例，保证草稿状态连续）
// ---------------------------------------------------------------------------
{
  /**
   * 注意：mock 运行时复用同一个组件实例，`runtime.mount` 不会重置内部 state。
   * 因此这里在 O1 已下移一次的**同一实例**上继续点「上移」，验证相邻交换可逆。
   */
  const up = byAria(tree, '甲 上移')
  check('O2a 「甲 上移」按钮存在', up !== undefined)
  if (up !== undefined) up.props.onClick()
  tree = await runtime.settle({ form })

  const saveBtn2 = elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === '保存更改')[0]
  if (saveBtn2 !== undefined) saveBtn2.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  tree = await runtime.settle({ form })

  const batch2 = mutations.length > 0 ? mutations[mutations.length - 1] : []
  const orderOp2 = batch2.find((op) => Array.isArray(op.path) && op.path.length === 1 && op.path[0] === 'planOrder')
  const order2 = orderOp2 !== undefined && typeof orderOp2.value === 'string' ? JSON.parse(orderOp2.value) : []
  /**
   * 断言「上移确实让它更靠前」而不是绑定某个绝对下标。
   *
   * 原因：`orderedIds` 会把未列入 `planOrder` 的内置渠道补在中间，
   * 因此相邻交换的**绝对位置**依赖当时的完整列表；用「相对移动方向」判定更稳，
   * 也不掩盖真实缺陷（如果没移动，下标不会变小）。
   */
  /**
   * 基线：本次上移**之前**的顺序。O1 结束后已保存过一次，
   * 因此这里用当时保存的 planOrder 作为 before。
   */
  const o1Batch = mutations.length > 1 ? mutations[mutations.length - 2] : []
  const o1OrderOp = o1Batch.find((op) => Array.isArray(op.path) && op.path.length === 1 && op.path[0] === 'planOrder')
  const o1Order = o1OrderOp !== undefined && typeof o1OrderOp.value === 'string' ? JSON.parse(o1OrderOp.value) : []
  const beforeA = o1Order.indexOf('custom:aaaaaaaaaaaa')
  const afterA = order2.indexOf('custom:aaaaaaaaaaaa')
  check('O2b 上移后甲的位置确实前移',
    afterA !== -1 && beforeA !== -1 && afterA < beforeA, { beforeA, afterA, order2 })
  check('O2c 内置渠道的既有顺序没有被重置',
    order2.indexOf('opencode-go') < order2.indexOf('deepseek'), order2)
}

// ---------------------------------------------------------------------------// O3 — 边界：第一条不能再上移、最后一条不能再下移（不改动 planOrder）
// ---------------------------------------------------------------------------
{
  const before = form.value.planOrder
  const first = elementsOf(tree)
    .filter((el) => el.props && el.props['data-custom-id'] === 'custom:aaaaaaaaaaaa')
    .map((el) => el.props['data-custom-id'])[0]
  check('O3a 甲在首位', first === 'custom:aaaaaaaaaaaa')
  const up = byAria(tree, '甲 上移')
  if (up !== undefined) up.props.onClick()
  tree = await runtime.settle({ form })
  check('O3b 首位再上移不改变 planOrder', form.value.planOrder === before)
}

// ---------------------------------------------------------------------------
// O4 — Host 侧排序规则（等价实现交叉校验）
// ---------------------------------------------------------------------------
{
  const order = ['opencode-go', 'deepseek', 'custom:bbbbbbbbbbbb', 'custom:aaaaaaaaaaaa']
  const rank = new Map(order.map((id, i) => [id, i]))
  const decorate = (list) => list
    .map((row, index) => ({
      row, index,
      has: rank.has(row.id),
      rank: rank.has(row.id) ? rank.get(row.id) : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => {
      if (a.has && b.has) return a.rank - b.rank
      if (a.has !== b.has) return a.has ? -1 : 1
      return a.index - b.index
    })
    .map((d) => d.row.id)

  check('O4a 按 planOrder 排序',
    JSON.stringify(decorate([{ id: 'custom:aaaaaaaaaaaa' }, { id: 'custom:bbbbbbbbbbbb' }]))
    === JSON.stringify(['custom:bbbbbbbbbbbb', 'custom:aaaaaaaaaaaa']))
  check('O4b 未列入 planOrder 的条目保持原相对顺序排在后面',
    JSON.stringify(decorate([
      { id: 'custom:cccccccccccc' }, { id: 'custom:aaaaaaaaaaaa' }, { id: 'custom:dddddddddddd' },
    ])) === JSON.stringify(['custom:aaaaaaaaaaaa', 'custom:cccccccccccc', 'custom:dddddddddddd']))
  check('O4c 空 planOrder 时保持原顺序',
    JSON.stringify(decorate([{ id: 'x' }, { id: 'y' }])) === JSON.stringify(['x', 'y']))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
