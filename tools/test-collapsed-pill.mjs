/**
 * 浏览器半回归测试（0.6.3）：缩略（rail）状态下用量胶囊必须**不可交互**。
 *
 * 背景（真机故障）：移动端 Web UI 把侧栏收成 rail 后，胶囊只剩两个状态点；
 * 此时点击仍会 `setOpen(true)`，而详情面板是 `position:absolute; width:100%`，
 * 在约 56px 宽的 rail 里被压成一条竖排乱码（桌面端侧栏够宽，所以看不出来）。
 * 0.6.3 起：缩略状态不挂 onClick、元素由 button 换成 div，面板也只在展开态渲染。
 *
 * 做法：本仓库没有 jsdom/React 依赖，这里用**极简 hooks 运行时**加载真实的
 * client.js（沿用 AGENTS.md 第 4 节记载的 mock 思路：mock window.__ModuleLoader__
 * + React + ctx.slots/configForms），再把组件树当数据结构断言。
 *
 * 用法：node tools/test-collapsed-pill.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// 极简 hooks 运行时（只实现 client.js 用到的 React API：
// createElement / useState / useEffect / useMemo / useSyncExternalStore）
// ---------------------------------------------------------------------------
function createRuntime() {
  let Component = null
  let instance = null
  let current = null
  let dirty = false
  let pending = []

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  function slot(kind) {
    const index = current.cursor++
    let s = current.hooks[index]
    if (s === undefined || s.kind !== kind) {
      s = { kind }
      current.hooks[index] = s
    }
    return s
  }

  const React = {
    createElement(type, props) {
      // 与 React 一致：children 保留 null/false 占位（渲染时忽略），不打平数组实参。
      const out = Object.assign({}, props)
      const kids = []
      for (let i = 2; i < arguments.length; i++) kids.push(arguments[i])
      if (kids.length === 1) out.children = kids[0]
      else if (kids.length > 1) out.children = kids
      return { type, props: out }
    },
    useState(init) {
      const s = slot('state')
      if (!('value' in s)) s.value = typeof init === 'function' ? init() : init
      return [s.value, (next) => {
        s.value = typeof next === 'function' ? next(s.value) : next
        dirty = true
      }]
    },
    useEffect(fn, deps) {
      const s = slot('effect')
      if (s.deps === undefined || !sameDeps(s.deps, deps)) {
        s.deps = deps
        pending.push(fn)
      }
    },
    useMemo(fn, deps) {
      const s = slot('memo')
      if (s.deps === undefined || !sameDeps(s.deps, deps)) {
        s.value = fn()
        s.deps = deps
      }
      return s.value
    },
    // client.js 只用它读配置快照；测试里 configForm 为 null，subscribe/getSnapshot 都是空实现。
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }

  function pass(props) {
    current = instance
    instance.cursor = 0
    const tree = Component(props)
    current = null
    const queued = pending
    pending = []
    for (const fn of queued) fn()
    return tree
  }

  return {
    React,
    mount(Comp, props) {
      Component = Comp
      instance = { hooks: [], cursor: 0 }
      return pass(props)
    },
    /** 单帧渲染：用于捕捉「折叠当帧是否闪出面板」。 */
    renderOnce(props) { return pass(props) },
    /** 反复渲染直到没有 setState，并让 fetch 的 promise 链落定。 */
    async settle(props, rounds = 10) {
      let tree = pass(props)
      for (let i = 0; i < rounds; i++) {
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) return tree
        dirty = false
        tree = pass(props)
      }
      return tree
    },
  }
}

/** 收集子树里的可见文本（忽略 title 等属性）。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props ? node.props.children : undefined)
}

// ---------------------------------------------------------------------------
// 加载真实的 client.js（mock window.__ModuleLoader__ + require('react')）
// ---------------------------------------------------------------------------
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const runtime = createRuntime()
const React = runtime.React
let exported = null

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      exported = factory((name) => {
        if (name === 'react') return React
        throw new Error('未预期的模块依赖: ' + name)
      })
    },
  },
}

// 定时器：胶囊每 30 秒轮询一次，测试里不需要它真的跑（否则进程不退出）。
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// 上游数据用真机截图里的同一组数值（DeepSeek ¥7.38 / Codex 33% 72%）。
const API_PAYLOAD = {
  ok: true,
  data: {
    plans: [
      { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
      {
        id: 'codex',
        name: 'OpenAI Codex',
        rollingUsage: { status: null, percent: 33, resetsAt: null, resetInSec: null },
        weeklyUsage: { status: null, percent: 72, resetsAt: null, resetInSec: null },
      },
    ],
  },
}
globalThis.fetch = async () => ({ json: async () => API_PAYLOAD })

new Function(source)()

// 通过 apply(ctx) 取到胶囊组件（它只经席位注册暴露，不直接导出）。
let Badge = null
exported.apply({
  configForms: {
    get: () => null,
    whileServed: () => () => {},
  },
  slots: {
    inject: (_name, cb) => cb(),
    register: (_spec, Comp) => { Badge = Comp; return () => {} },
  },
  effect: (fn) => fn(),
})

const results = []
function record(name, status, note) {
  results.push({ name, status })
  console.log('[' + status + '] ' + name + (note ? ' — ' + note : ''))
}

// ---------------------------------------------------------------------------
// T1 — 展开状态：可点击，点击后出现详情面板
// ---------------------------------------------------------------------------
{
  try {
    assert.ok(Badge, '未能从 apply(ctx) 取到胶囊组件')
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

globalThis.setInterval = realSetInterval

const failed = results.filter((r) => r.status === 'FAIL')
console.log('\n' + results.length + ' 项：' + (results.length - failed.length) + ' 通过, ' + failed.length + ' 失败')
process.exit(failed.length === 0 ? 0 : 1)
