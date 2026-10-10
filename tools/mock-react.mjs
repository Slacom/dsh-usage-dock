/**
 * 浏览器半（client.js）测试共用的极简 React 运行时 + 模块加载器。
 *
 * 仓库里没有 React / jsdom 依赖，而 client.js 是「零构建、单文件」的浏览器半，
 * 因此这里用最小实现加载**真实的 client.js**，再把组件树当数据结构断言：
 *   - React：createElement / useState / useEffect / useMemo / useRef / useSyncExternalStore
 *   - 模拟 ref 附着与 DOM 父子链（setParent），用来构造 sidebar footer 的宿主容器
 *   - 定时器：胶囊每 30 秒轮询一次，测试里置空，避免进程不退出
 *
 * 用法见 tools/test-collapsed-pill.mjs 与 tools/test-footer-row.mjs。
 */
import { readFileSync } from 'node:fs'

export function createRuntime() {
  let Component = null
  let instance = null
  let current = null
  let dirty = false
  let pending = []
  let currentParent = null

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
      const el = { type, props: out }
      // 带 ref 的元素（= 胶囊根节点）：附着 ref 并挂上测试构造的父链。
      if (out.ref != null && typeof out.ref === 'object') {
        out.ref.current = el
        if (currentParent !== null) el.parentElement = currentParent
      }
      return el
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
    useRef(init) {
      const s = slot('ref')
      if (!('current' in s)) s.current = init === undefined ? null : init
      return s
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }

  function pass(props) {
    // 容错：调用方忘了 mount 时自动建实例（否则 hook 会在 current===null 上崩，
    // 报出 "Cannot set properties of null" 这种与真实原因无关的错误）。
    if (instance === null) instance = { hooks: [], cursor: 0 }
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
    /** 设定胶囊根节点的父链（模拟 DOM）；用 fakeFlexNode() 构造。 */
    setParent(node) { currentParent = node },
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
export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props ? node.props.children : undefined)
}

/**
 * 构造一个假的 DOM 节点：`style` 是可写的行内样式（插件会往上面写），
 * `computed` 是 getComputedStyle 的基础值（测试用来模拟宿主的布局规则）。
 */
export function fakeNode(computed, parent) {
  return { style: {}, computed: computed || {}, parentElement: parent || null }
}

/** 安装假的 window / getComputedStyle / fetch / 定时器，并加载真实的 client.js。 */
export function loadClient(runtime, options) {
  const opts = options || {}
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let exportedModule = null

  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        exportedModule = factory((name) => {
          if (name === 'react') return runtime.React
          throw new Error('未预期的模块依赖: ' + name)
        })
      },
    },
    // 计算样式：行内样式优先（模拟浏览器），没写就回落到测试给的布局规则。
    getComputedStyle(node) {
      return Object.assign({ display: 'block', flexDirection: 'row', flexWrap: 'nowrap' }, node.computed, node.style)
    },
  }

  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  globalThis.fetch = async () => ({ json: async () => opts.payload })

  new Function(source)()

  // 通过 apply(ctx) 取到胶囊组件（组件只经席位注册暴露，不直接导出）。
  let Badge = null
  exportedModule.apply({
    configForms: { get: () => null, whileServed: () => () => {} },
    slots: {
      inject: (_name, cb) => cb(),
      register: (_spec, Comp) => { Badge = Comp; return () => {} },
    },
    effect: (fn) => fn(),
  })

  return {
    module: exportedModule,
    Badge,
    restore() { globalThis.setInterval = realSetInterval },
  }
}

/** 真机截图里的同一组数据：DeepSeek ¥7.38 / Codex 33% 72%。 */
export const API_PAYLOAD = {
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
