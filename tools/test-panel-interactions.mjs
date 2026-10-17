/**
 * 浏览器半回归测试（0.8.2）：详情卡片的退出逻辑、展开动画与 WorkBuddy 部分取数脚注。
 *
 * 背景（0.8.2 用户需求）：
 *   - 详情卡片此前只能靠再次点击胶囊关闭 → 打开后点击卡片外任意位置应自动关闭
 *     （pointerdown 捕获阶段判定，胶囊/面板内不关），Esc 同样关闭；
 *   - 参考 DSH 桌面端左侧工作区「点击项目展开会话记录」的动效语言 →
 *     面板出现那一帧播一次「从胶囊向上展开 + 渐显」的 WAAPI 动画；
 *   - WorkBuddy 一方版本取不到数据时整体不再报错 → 展示已取到版本并加灰色脚注。
 *
 * 用法：node tools/test-panel-interactions.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, fakeNode, loadClient, API_PAYLOAD } from './mock-react.mjs'

const results = []
function record(name, status, note) {
  results.push({ name, status })
  console.log('[' + status + '] ' + name + (note ? ' — ' + note : ''))
}

/** 模拟 DOM 节点：沿 parentElement 上溯参与「卡片内」判定。 */
function domNode(tag, parent) {
  return { tagName: tag, nodeType: 1, style: {}, parentElement: parent || null }
}

/** 打开面板并落到稳定态，返回 [tree, pill, panel]。 */
async function openPanel(runtime, client, row) {
  runtime.setParent(row)
  runtime.mount(client.Badge, { wide: true, configForm: null })
  await runtime.settle({ wide: true, configForm: null })
  const tree0 = await runtime.settle({ wide: true, configForm: null })
  tree0.props.children[0].props.onClick()
  const tree = await runtime.settle({ wide: true, configForm: null })
  return [tree, tree.props.children[0], tree.props.children[1]]
}

// ===========================================================================
// 第一组：外点关闭 / Esc（默认 payload 运行时）
// ===========================================================================
const runtime = createRuntime()
const client = loadClient(runtime, { payload: API_PAYLOAD })

// ---------------------------------------------------------------------------
// T12 — 打开时挂 window 按下类/click 捕获 + document keydown，收起即拆除
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    await openPanel(runtime, client, row)
    assert.ok(window.listeners.pointerdown && window.listeners.pointerdown.length === 1,
      '打开时应在 window 挂 pointerdown 监听')
    // [0.8.3] 三种按下事件 + click 兜底：只挂 pointerdown 时，不投递 PointerEvent
    // 的宿主与键盘激活都关不掉面板（用户反馈的「点空白偶尔不关」）。
    assert.ok(window.listeners.mousedown && window.listeners.mousedown.length === 1,
      '打开时应在 window 挂 mousedown 兜底监听')
    assert.ok(window.listeners.touchstart && window.listeners.touchstart.length === 1,
      '打开时应在 window 挂 touchstart 兜底监听')
    assert.ok(window.listeners.click && window.listeners.click.length === 1,
      '打开时应在 window 挂 click 兜底监听')
    assert.ok(document.listeners.keydown && document.listeners.keydown.length === 1,
      '打开时应在 document 挂 keydown 监听')
    runtime.setParent(row)
    runtime.mount(client.Badge, { wide: true, configForm: null }) // 重新挂载（含 cleanup）
    await runtime.settle({ wide: true, configForm: null })
    assert.equal(window.listeners.pointerdown.length, 0, '收起/重挂后应拆除 pointerdown 监听')
    assert.equal(window.listeners.mousedown.length, 0, '收起/重挂后应拆除 mousedown 监听')
    assert.equal(window.listeners.touchstart.length, 0, '收起/重挂后应拆除 touchstart 监听')
    assert.equal(window.listeners.click.length, 0, '收起/重挂后应拆除 click 监听')
    assert.equal(document.listeners.keydown.length, 0, '收起/重挂后应拆除 keydown 监听')
    record('T12 打开挂外点/Esc 监听，收起即拆除', 'PASS')
  } catch (err) {
    record('T12 外点/Esc 监听生命周期', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T13 — 点击卡片外（普通节点、无 parentElement）自动关闭
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    await openPanel(runtime, client, row)
    window.dispatch('pointerdown', { target: domNode('div') }) // 侧栏里任何其他元素
    const tree = await runtime.settle({ wide: true, configForm: null })
    assert.equal(tree.props.children[1], null, '点击卡片外面板必须关闭')
    assert.equal(window.listeners.pointerdown.length, 0, '关闭后监听拆除')
    record('T13 点击卡片外自动关闭', 'PASS')
  } catch (err) {
    record('T13 点击卡片外自动关闭', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T14 — 按在胶囊/面板内部不关（沿 parentElement 上溯命中根/面板）
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const [, pill] = await openPanel(runtime, client, row)
    // 胶囊内的真实子元素：mock 渲染后已接好父子链，上溯会到达根节点。
    const pillRow = pill.props.children[0]
    window.dispatch('pointerdown', { target: pillRow })
    let tree = await runtime.settle({ wide: true, configForm: null })
    assert.ok(tree.props.children[1], '按在胶囊内不得关闭面板')
    // 面板内深处的节点：上溯命中面板元素。
    const panel = tree.props.children[1]
    const deepInPanel = domNode('span', panel)
    window.dispatch('pointerdown', { target: deepInPanel })
    tree = await runtime.settle({ wide: true, configForm: null })
    assert.ok(tree.props.children[1], '按在面板内不得关闭面板')
    record('T14 按在胶囊/面板内不关（parentElement 上溯判定）', 'PASS')
  } catch (err) {
    record('T14 卡片内按下不关闭', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T15 — composedPath（Shadow DOM）命中卡片根时不算外部
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const [tree] = await openPanel(runtime, client, row)
    const rootEl = tree // mock 里 ref 附着在根元素上，effect 捕获的就是它
    window.dispatch('pointerdown', {
      target: { composedPath: () => [domNode('span'), rootEl, window] },
    })
    const after = await runtime.settle({ wide: true, configForm: null })
    assert.ok(after.props.children[1], 'composedPath 命中根节点不得关闭')
    record('T15 Shadow DOM composedPath 命中卡片内不关', 'PASS')
  } catch (err) {
    record('T15 Shadow DOM 判定', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T16 — Esc 关闭；其他按键不关
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    await openPanel(runtime, client, row)
    document.dispatch('keydown', { key: 'a' })
    let tree = await runtime.settle({ wide: true, configForm: null })
    assert.ok(tree.props.children[1], '普通按键不得关闭面板')
    document.dispatch('keydown', { key: 'Escape' })
    tree = await runtime.settle({ wide: true, configForm: null })
    assert.equal(tree.props.children[1], null, 'Esc 必须关闭面板')
    record('T16 Esc 关闭面板（其他按键不受影响）', 'PASS')
  } catch (err) {
    record('T16 Esc 关闭', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T20 — 只有 mousedown（宿主不投递 PointerEvent）也要能关
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    await openPanel(runtime, client, row)
    window.dispatch('mousedown', { target: domNode('div') })
    const tree = await runtime.settle({ wide: true, configForm: null })
    assert.equal(tree.props.children[1], null, '没有 pointerdown 时 mousedown 必须兜底关闭')
    record('T20 mousedown 兜底关闭（无 PointerEvent 宿主）', 'PASS')
  } catch (err) {
    record('T20 mousedown 兜底关闭', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T21 — 只有 click（键盘 Enter/Space 激活面板外按钮）也要能关
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    await openPanel(runtime, client, row)
    window.dispatch('click', { target: domNode('button') })
    const tree = await runtime.settle({ wide: true, configForm: null })
    assert.equal(tree.props.children[1], null, '没有按下事件时 click 必须兜底关闭')
    record('T21 click 兜底关闭（键盘激活面板外控件）', 'PASS')
  } catch (err) {
    record('T21 click 兜底关闭', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T22 — 从面板内按下、松手落到面板外（拖选文字）不误关；下一次外点仍关
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const [tree0, , panel] = await openPanel(runtime, client, row)
    assert.ok(panel, '前置条件：面板已打开')
    window.dispatch('pointerdown', { target: domNode('span', tree0.props.children[1]) })
    window.dispatch('click', { target: domNode('div') }) // 松手在面板外：click 的 target 不再是面板
    let tree = await runtime.settle({ wide: true, configForm: null })
    assert.ok(tree.props.children[1], '从卡片内开始的拖动松手在外不得关闭面板')
    window.dispatch('click', { target: domNode('div') }) // 下一次独立的外点
    tree = await runtime.settle({ wide: true, configForm: null })
    assert.equal(tree.props.children[1], null, '拖选结束后再点外部仍应关闭')
    record('T22 卡片内起手的拖动不误关（downInside 去重）', 'PASS')
  } catch (err) {
    record('T22 拖动不误关', 'FAIL', err.message)
  }
}


//       这里直接验证它们的面板不含「未取到数据」脚注——字段不落地时零影响）
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const [, , panel] = await openPanel(runtime, client, row)
    const texts = []
    const walk = (n) => {
      if (n === null || n === undefined) return
      if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
      if (typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      const kids = n.props ? n.props.children : undefined
      if (Array.isArray(kids)) kids.forEach(walk)
      else if (kids !== undefined) walk(kids)
    }
    walk(panel)
    assert.ok(!texts.join('').includes('未取到数据'), '无 partial 标记不得出现脚注')
    record('T19 无 partial 标记不渲染脚注', 'PASS')
  } catch (err) {
    record('T19 无 partial 标记', 'FAIL', err.message)
  }
}

client.restore()

// ===========================================================================
// 第二组：WorkBuddy partial 脚注（独立运行时 + 专属 payload）
// ===========================================================================
{
  try {
    const runtimeB = createRuntime()
    const clientB = loadClient(runtimeB, {
      payload: {
        ok: true,
        data: { plans: [{ id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 1846, creditsUnlimited: false,
          creditsAccounts: [{ packageName: '企业额度', remain: 1846 }],
          partial: true, partialNote: '以下版本未取到数据：WorkBuddy AI：fetch failed' }] },
      },
    })
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    runtimeB.setParent(row)
    runtimeB.mount(clientB.Badge, { wide: true, configForm: null })
    await runtimeB.settle({ wide: true, configForm: null })
    const tree = await runtimeB.settle({ wide: true, configForm: null })
    tree.props.children[0].props.onClick()
    const opened = await runtimeB.settle({ wide: true, configForm: null })
    const texts = []
    const walk = (n) => {
      if (n === null || n === undefined) return
      if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
      if (typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      const kids = n.props ? n.props.children : undefined
      if (Array.isArray(kids)) kids.forEach(walk)
      else if (kids !== undefined) walk(kids)
    }
    walk(opened.props.children[1])
    const joined = texts.join('\n')
    assert.ok(joined.includes('以下版本未取到数据：WorkBuddy AI：fetch failed'), '应渲染 partial 脚注')
    assert.ok(joined.includes('1,846') || joined.includes('1846'), '合计行仍应展示已取到版本的数据')
    clientB.restore()
    record('T18 WorkBuddy 部分取数脚注渲染', 'PASS')
  } catch (err) {
    record('T18 WorkBuddy 部分取数脚注', 'FAIL', err.message)
  }
}

// ===========================================================================
// 第三组：展开动画（waapi 运行时记录 element.animate）
// ===========================================================================
{
  try {
    const runtimeC = createRuntime({ waapi: true })
    const clientC = loadClient(runtimeC, { payload: API_PAYLOAD })
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    runtimeC.setParent(row)
    runtimeC.mount(clientC.Badge, { wide: true, configForm: null })
    await runtimeC.settle({ wide: true, configForm: null })
    const before = runtimeC.animations.length
    const tree = await runtimeC.settle({ wide: true, configForm: null })
    tree.props.children[0].props.onClick()
    await runtimeC.settle({ wide: true, configForm: null })
    const played = runtimeC.animations.slice(before)
    assert.equal(played.length, 1, '面板出现那一帧应恰好播一次动画')
    const frames = played[0].frames
    assert.ok(Array.isArray(frames) && frames.length === 2, '应为两帧关键帧（起点/终点）')
    assert.match(frames[0].transform, /translateY\(6px\)/, '起点应从胶囊处（+6px）开始')
    assert.match(frames[1].transform, /translateY\(0\)/, '终点应落在原位')
    assert.equal(frames[0].opacity, 0, '起点应全透明（渐显）')
    assert.equal(frames[1].opacity, 1, '终点应完全不透明')
    // 打开期间的数据刷新不重播：再 settle 几轮，动画数不变。
    await runtimeC.settle({ wide: true, configForm: null })
    await runtimeC.settle({ wide: true, configForm: null })
    assert.equal(runtimeC.animations.length, before + 1, '打开期间不得重播动画')
    clientC.restore()
    record('T17 面板展开动画：从胶囊向上 + 渐显，仅播一次', 'PASS')
  } catch (err) {
    record('T17 展开动画', 'FAIL', err.message)
  }
}

const failed = results.filter((r) => r.status === 'FAIL')
console.log('\n' + results.length + ' 项：' + (results.length - failed.length) + ' 通过, ' + failed.length + ' 失败')
process.exit(failed.length === 0 ? 0 : 1)
