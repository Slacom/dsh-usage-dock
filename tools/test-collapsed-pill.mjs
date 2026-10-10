/**
 * 浏览器半回归测试（0.6.3）：缩略（rail）状态下用量胶囊必须**不可交互**。
 *
 * 背景（真机故障）：移动端 Web UI 把侧栏收成 rail 后，胶囊只剩两个状态点；
 * 此时点击仍会 `setOpen(true)`，而详情面板是 `position:absolute; width:100%`，
 * 在约 56px 宽的 rail 里被压成一条竖排乱码（桌面端侧栏够宽，所以看不出来）。
 * 0.6.3 起：缩略状态不挂 onClick、元素由 button 换成 div，面板也只在展开态渲染。
 *
 * 运行时与加载器见 tools/mock-react.mjs（0.7.0 起与 test-footer-row.mjs 共用）。
 *
 * 用法：node tools/test-collapsed-pill.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf, API_PAYLOAD } from './mock-react.mjs'

const results = []
function record(name, status, note) {
  results.push({ name, status })
  console.log('[' + status + '] ' + name + (note ? ' — ' + note : ''))
}

const runtime = createRuntime()
const client = loadClient(runtime, { payload: API_PAYLOAD })
const Badge = client.Badge
assert.ok(Badge, '未能从 apply(ctx) 取到胶囊组件')

// ---------------------------------------------------------------------------
// T1 — 展开状态：可点击，点击后出现详情面板
// ---------------------------------------------------------------------------
{
  try {
    runtime.mount(Badge, { wide: true, configForm: null })
    const tree = await runtime.settle({ wide: true, configForm: null })
    const [pill, panel] = tree.props.children
    assert.equal(pill.type, 'button', '展开状态胶囊应是 button')
    assert.equal(typeof pill.props.onClick, 'function', '展开状态必须可点击')
    assert.equal(pill.props.style.cursor, 'pointer')
    assert.equal(panel, null, '未点击时不应有详情面板')
    assert.match(textOf(pill), /DeepSeek/, '展开状态胶囊应显示渠道名')
    assert.match(textOf(pill), /¥7\.38/, '展开状态胶囊应显示余额')

    pill.props.onClick()
    const opened = await runtime.settle({ wide: true, configForm: null })
    const panelOpen = opened.props.children[1]
    assert.ok(panelOpen, '点击后应渲染详情面板')
    const panelText = textOf(panelOpen)
    assert.match(panelText, /余额/, '面板应含余额分区')
    assert.match(panelText, /¥7\.38/)
    assert.match(panelText, /5小时/)
    record('T1 展开状态：可点击、点击后显示完整详情面板', 'PASS')
  } catch (err) {
    record('T1 展开状态可点击', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T2 — 缩略状态：完全不可交互，也不渲染面板（本次修复的核心）
// ---------------------------------------------------------------------------
{
  try {
    const tree = await runtime.settle({ wide: false, configForm: null })
    const [pill, panel] = tree.props.children
    assert.equal(pill.type, 'div', '缩略状态胶囊不应是 button')
    assert.equal(pill.props.onClick, undefined, '缩略状态不得挂 onClick')
    assert.equal(pill.props.onKeyDown, undefined)
    assert.equal(pill.props.type, undefined, '不得残留 type="button"')
    assert.equal(pill.props['aria-expanded'], undefined)
    assert.equal(pill.props['aria-haspopup'], undefined)
    assert.equal(pill.props.style.cursor, 'default', '缩略状态不应显示手型光标')
    assert.equal(panel, null, '缩略状态不得渲染详情面板')
    // 缩略状态只留状态点，不再铺文字（rail 放不下，之前正是这里被压成竖排乱码）。
    assert.equal(textOf(pill), '', '缩略状态胶囊不应输出任何文字')
    assert.match(String(pill.props.title), /DeepSeek/, '悬停提示保留（非点击交互）')
    record('T2 缩略状态：无 onClick / 非 button / 无面板 / 无文字', 'PASS')
  } catch (err) {
    record('T2 缩略状态不可交互', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T3 — 展开时打开面板 → 折叠：当帧不得闪出面板，且状态被收起
// ---------------------------------------------------------------------------
{
  try {
    runtime.mount(Badge, { wide: true, configForm: null })
    await runtime.settle({ wide: true, configForm: null })
    const pill = (await runtime.settle({ wide: true, configForm: null })).props.children[0]
    pill.props.onClick()
    const opened = await runtime.settle({ wide: true, configForm: null })
    assert.ok(opened.props.children[1], '前置条件：面板应已打开')

    // 折叠当帧（effect 还没跑）就不该渲染面板——否则 rail 里会闪一下竖排乱码。
    const firstFrame = runtime.renderOnce({ wide: false, configForm: null })
    assert.equal(firstFrame.props.children[1], null, '折叠当帧不得渲染面板')

    const settled = await runtime.settle({ wide: false, configForm: null })
    assert.equal(settled.props.children[1], null, '折叠后面板应保持关闭')
    assert.equal(settled.props.children[0].props.onClick, undefined)
    record('T3 展开→折叠：面板即时收起且无闪烁', 'PASS')
  } catch (err) {
    record('T3 展开→折叠收敛', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// T4 — 兼容性：未提供 wide（旧版 sidebar / 其他宿主）时按展开处理
// ---------------------------------------------------------------------------
{
  try {
    runtime.mount(Badge, { configForm: null })
    const tree = await runtime.settle({ configForm: null })
    const [pill, panel] = tree.props.children
    assert.equal(pill.type, 'button', '缺失 wide 时保持原有可点击行为')
    assert.equal(typeof pill.props.onClick, 'function')
    assert.equal(panel, null)
    record('T4 缺失 wide 时保持展开语义（向后兼容）', 'PASS')
  } catch (err) {
    record('T4 缺失 wide 的兼容性', 'FAIL', err.message)
  }
}

client.restore()
const failed = results.filter((r) => r.status === 'FAIL')
console.log('\n' + results.length + ' 项：' + (results.length - failed.length) + ' 通过, ' + failed.length + ' 失败')
process.exit(failed.length === 0 ? 0 : 1)
