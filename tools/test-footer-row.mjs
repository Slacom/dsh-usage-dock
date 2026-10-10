/**
 * 浏览器半回归测试（0.7.0）：胶囊必须**独占侧栏底部的一整行**。
 *
 * 背景（真机故障）：`sidebar.footer.action` 是 list 席位，DSH 把所有插件注册的
 * 动作放在同一个**横向 flex 行**里（0.1.x 核心包叫 footerActions，规则 `display:flex`）。
 * ds-harness-remote 用 order:-20 注册、本插件用 order:10，于是两者挤在同一行互相抢宽度，
 * 胶囊被压窄、内容显示不全。
 *
 * 0.7.0 的做法：挂载后向上找最近的 flex 容器——横向容器补 `flex-wrap: wrap`
 * 并把胶囊声明为 `flex-basis:100%`（独占一行）；纵向容器不动（basis:100% 会变成高度）。
 * 本测试就是守住这三条分支。
 *
 * 用法：node tools/test-footer-row.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, fakeNode, loadClient, API_PAYLOAD } from './mock-react.mjs'

const results = []
function record(name, status, note) {
  results.push({ name, status })
  console.log('[' + status + '] ' + name + (note ? ' — ' + note : ''))
}

const runtime = createRuntime()
const client = loadClient(runtime, { payload: API_PAYLOAD })

const ROOT_FLEX_WHEN_OWN_ROW = '1 1 100%'

/** 每个用例都重新挂载（hooks/state 归零），并返回 [root 元素, pill, panel]。 */
async function render(parent) {
  runtime.setParent(parent)
  runtime.mount(client.Badge, { wide: true, configForm: null })
  const tree = await runtime.settle({ wide: true, configForm: null })
  return [tree, tree.props.children[0], tree.props.children[1]]
}

// ---------------------------------------------------------------------------
// T1 — 横向 flex 行（多插件共存的真实现场）：容器被允许换行，胶囊整行独占
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const [root, pill] = await render(row)
    assert.equal(row.style.flexWrap, 'wrap', '横向容器应被补上 flex-wrap: wrap')
    assert.equal(root.props.style.flex, ROOT_FLEX_WHEN_OWN_ROW, '胶囊应声明整行（flex-basis:100%）')
    assert.equal(root.props.style.width, '100%')
    assert.equal(root.props.style.position, 'relative', '定位不能丢：详情面板靠它做绝对定位')
    assert.equal(pill.type, 'button', '展开状态下仍可点击')
    record('T1 横向 flex 行：容器开放换行 + 胶囊独占整行', 'PASS')
  } catch (err) {
    record('T1 横向 flex 行独占一行', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T2 — 纵向容器（旧版 footArea 是 column）：绝不动它
//     —— 纵向容器里 flex-basis:100% 会被解释成「高度」，会把同列其他条目压扁
// ---------------------------------------------------------------------------
{
  try {
    const col = fakeNode({ display: 'flex', flexDirection: 'column', flexWrap: 'nowrap' })
    const [root] = await render(col)
    assert.equal(col.style.flexWrap, undefined, '纵向容器不得被改动（换行会变成多列）')
    assert.equal(root.props.style.flex, '1 1 auto', '纵向容器里保持原行为（绝不能声明 basis:100%，那会被当成高度）')
    assert.equal(root.props.style.width, undefined)
    record('T2 纵向容器：保持原样（不加 wrap、不声明整行）', 'PASS')
  } catch (err) {
    record('T2 纵向容器保持原样', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T3 — 中间隔着非 flex 包裹层：继续向上找到真正的横向 flex 行
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const wrapper = fakeNode({ display: 'block' }, row)
    const [root] = await render(wrapper)
    assert.equal(row.style.flexWrap, 'wrap', '应跨过非 flex 包裹层找到行容器')
    assert.equal(wrapper.style.flexWrap, undefined, '中间的包裹层不应被改')
    assert.equal(root.props.style.flex, ROOT_FLEX_WHEN_OWN_ROW)
    record('T3 跨过非 flex 包裹层找到行容器', 'PASS')
  } catch (err) {
    record('T3 跨层查找行容器', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T4 — 已经是 wrap 的容器（将来 DSH 自己开放换行）：不重复写样式，但胶囊仍独占整行
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' })
    const [root] = await render(row)
    assert.equal(row.style.flexWrap, undefined, '宿主本来就允许换行时不应改写它的行内样式')
    assert.equal(root.props.style.flex, ROOT_FLEX_WHEN_OWN_ROW)
    record('T4 容器本就允许换行：不改宿主样式，胶囊仍独占整行', 'PASS')
  } catch (err) {
    record('T4 已可换行的容器', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T5 — 没有 DOM 的宿主（老环境 / SSR）：探测失败也不能抛错，退化为原行为
// ---------------------------------------------------------------------------
{
  try {
    const [root, pill] = await render(null)
    assert.equal(root.props.style.flex, '1 1 auto', '无法探测宿主时保持原行为（flex:1 1 auto）')
    assert.equal(pill.type, 'button')
    record('T5 无法探测宿主时退化为原行为且不报错', 'PASS')
  } catch (err) {
    record('T5 无法探测宿主时退化', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T6 — 层级：order 必须排在所有已知的底部插件之前（最上面一行）
//     详情面板向上展开，排在最后一行时会盖住其他插件的底部按钮
// ---------------------------------------------------------------------------
{
  try {
    const order = client.registration && client.registration.order
    assert.equal(typeof order, 'number', '注册席位时必须声明 order')
    assert.ok(order < 0, 'order 应为负数才排得到前面，实际 ' + order)
    assert.ok(order < -20, '必须比 ds-harness-remote（order:-20）更靠前，实际 ' + order)
    assert.equal(client.registration.name, 'sidebar.footer.action')
    record('T6 席位 order=' + order + '：排在 Remote(-20) 之前，详情面板不再遮挡其他按钮', 'PASS')
  } catch (err) {
    record('T6 席位层级', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T7 — 外观：不再是「边缘分明的胶囊」，只剩状态点 + 文字；悬停底色交给注入的 CSS
// ---------------------------------------------------------------------------
{
  try {
    const row = fakeNode({ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' })
    const [, pill] = await render(row)
    assert.equal(pill.props.style.background, 'transparent', '默认底色应为透明')
    assert.equal(pill.props.style.appearance, 'none', 'button 需要 appearance:none，否则会回落到系统灰底')
    assert.equal(pill.props.style.border, 0, '不得有边框')
    assert.equal(pill.props.style.boxShadow, 'none', '不得有阴影')
    assert.equal(pill.props.style.borderRadius, 8, '圆角应与侧栏其他按钮一致（8px）')
    assert.equal(pill.props.style.color, 'var(--dsw-alias-label-secondary)', '文字用侧栏次要色')
    assert.equal(pill.props['data-interactive'], 'true', '展开态需要标记可交互')
    // 悬停必须由 React 状态驱动：只写 CSS :hover 会被行内样式压死（0.7.0 第一版的真实故障）
    assert.equal(typeof pill.props.onMouseEnter, 'function', '展开态必须挂 onMouseEnter')
    pill.props.onMouseEnter()
    const hovered = (await runtime.settle({ wide: true, configForm: null })).props.children[0]
    assert.equal(hovered.props.style.background, 'var(--dsw-alias-interactive-bg-hover)', '鼠标移上去必须出现灰底')
    hovered.props.onMouseLeave()
    const left = (await runtime.settle({ wide: true, configForm: null })).props.children[0]
    assert.equal(left.props.style.background, 'transparent', '鼠标移开后必须恢复透明')
    // 状态点仍在（用户明确要求保留）
    const firstRow = pill.props.children[0]
    assert.equal(firstRow.props.children[0].props.style.borderRadius, '50%', '状态点必须保留')

    // 缩略态不是可交互形态：不挂处理器，也不该出现悬停底色
    const railTree = await runtime.settle({ wide: false, configForm: null })
    const railPill = railTree.props.children[0]
    assert.equal(railPill.props['data-interactive'], undefined, '缩略态不应标记可交互')
    assert.equal(railPill.props.onMouseEnter, undefined, '缩略态不应挂悬停处理')
    assert.equal(railPill.props.style.background, 'transparent')
    record('T7 外观：透明无边框，悬停/移开由状态驱动（灰底 ↔ 透明）', 'PASS')
  } catch (err) {
    record('T7 外观对齐侧栏按钮', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T8 — 注入的样式表：悬停底色用 sidebar 同款令牌，且只注入一次
// ---------------------------------------------------------------------------
{
  try {
    assert.equal(client.styleTags.length, 1, '应只注入一枚样式表')
    const tag = client.styleTags[0]
    assert.equal(tag.dataset.planUsageStyle, '1')
    assert.ok(tag.textContent.indexOf('.dsh-plan-usage-pill{background:transparent}') !== -1,
      '兜底的基础透明底色应存在')
    assert.match(tag.textContent, /:focus-visible/, '键盘聚焦要有可见轮廓（悬停底色本身由状态驱动）')
    assert.ok(!/body|\.hHd|sidebar-/.test(tag.textContent), '只允许作用于本插件自己的类名')
    record('T8 注入样式表：悬停/聚焦规则正确，且不碰宿主选择器', 'PASS')
  } catch (err) {
    record('T8 注入样式表', 'FAIL', err.message)
  }
}

client.restore()
const failed = results.filter((r) => r.status === 'FAIL')
console.log('\n' + results.length + ' 项：' + (results.length - failed.length) + ' 通过, ' + failed.length + ' 失败')
process.exit(failed.length === 0 ? 0 : 1)
