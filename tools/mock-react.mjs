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

export function createRuntime(options) {
  // [0.8.2] waapi:true 时给每个元素挂 animate 记录器（默认关闭——
  // test-android-compat 断言 PeakBar 在「无 WAAPI」环境走静态 transform 兜底，
  // 全局打开会破坏该前提；只有需要验证面板动画的测试显式开启）。
  const opts = options || {}
  const animations = []
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
      if (opts.waapi === true) {
        el.animate = (frames, animOpts) => {
          animations.push({ frames, opts: animOpts })
          return { cancel() {}, currentTime: 0 }
        }
      }
      // 带 ref 的元素（= 胶囊根节点）：附着 ref 并挂上测试构造的父链。
      // 子元素的 parentElement 链在渲染后统一补（见 pass 里的 wireDomChain）。
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
        // [0.8.2] 与 React 对齐：effect 返回的 cleanup 要保存；deps 变化重跑前
        // 先执行旧 cleanup。此前 mock 直接丢弃返回值，全局监听（外点关闭等）
        // 在测试里永远拆不掉。mount() 卸载时也会统一跑 cleanup。
        pending.push(() => {
          if (typeof s.cleanup === 'function') s.cleanup()
          s.cleanup = fn()
        })
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

  /**
   * [0.8.2] 渲染后补全 mock DOM 父子链：沿 children 递归，给每个元素挂
   * parentElement。真实 DOM 天然有这条链，外点关闭的「上溯到根」判定
   * 依赖它；根元素的 parent 已由 createElement 的 ref 分支指向测试宿主。
   */
  function wireDomChain(node, parent) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const k of node) wireDomChain(k, parent); return }
    if (node.type === undefined) return // 文本节点没有 children
    if (parent !== undefined) node.parentElement = parent
    const kids = node.props ? node.props.children : undefined
    if (Array.isArray(kids)) { for (const k of kids) wireDomChain(k, node) }
    else if (kids !== undefined) wireDomChain(kids, node)
  }

  function pass(props) {
    if (instance === null) instance = { hooks: [], cursor: 0 }
    current = instance
    instance.cursor = 0
    const tree = Component(props)
    current = null
    const queued = pending
    pending = []
    for (const fn of queued) fn()
    wireDomChain(tree, tree.parentElement)
    return tree
  }

  return {
    React,
    /** 设定胶囊根节点的父链（模拟 DOM）；用 fakeFlexNode() 构造。 */
    setParent(node) { currentParent = node },
    /** [0.8.2] waapi 运行时里所有 element.animate 的记录（供动画断言）。 */
    animations,
    mount(Comp, props) {
      // [0.8.2] 与真实 React 对齐：重新 mount 前先跑上一轮 effect cleanup，
      // 否则打开面板挂的全局监听会泄漏进下一个用例。
      for (const s of (instance && instance.hooks) || []) {
        if (s.kind === 'effect' && typeof s.cleanup === 'function') { s.cleanup(); s.cleanup = undefined }
      }
      Component = Comp
      instance = { hooks: [], cursor: 0 }
      return pass(props)
    },
    /** 在同一个 React 实现内隔离渲染子组件，避免在 hooks 上下文外直接调用。 */
    renderIsolated(Comp, props) {
      const saved = { Component, instance, current, dirty, pending }
      try {
        Component = Comp
        instance = { hooks: [], cursor: 0 }
        pending = []
        return pass(props)
      } finally {
        Component = saved.Component
        instance = saved.instance
        current = saved.current
        dirty = saved.dirty
        pending = saved.pending
      }
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

  // [local patch 0.8.0] 极简事件目标：0.8.0 起 client.js 会在 window/document 上
  // 挂 focus / visibilitychange 监听（充值后余额同步的刷新触发点），mock 需要
  // 承接这两个 API，并保留监听表供测试触发/断言。
  // [0.8.2] dispatch 支持携带事件字段（如 keydown 的 event.key），供外点/Esc 关闭测试用。
  function makeEventTarget() {
    const listeners = {}
    return {
      listeners,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
      removeEventListener(type, fn) {
        const arr = listeners[type] || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      },
      dispatch(type, extra) {
        const arr = (listeners[type] || []).slice()
        for (const fn of arr) fn(Object.assign({ type }, extra))
      },
    }
  }
  const fakeWindowEvents = makeEventTarget()
  const fakeDocEvents = makeEventTarget()

  globalThis.window = Object.assign(fakeWindowEvents, {
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
    innerWidth: 1200,
    innerHeight: 800,
  })

  // 极简 document：只覆盖插件用到的 createElement / head.appendChild / querySelector，
  // 用来断言「注入的样式表」内容（:hover 这类伪类规则无法内联表达）。
  // visibilityState / 事件监听为 0.8.0 的 focus 刷新路径服务。
  const styleTags = []
  globalThis.document = Object.assign(fakeDocEvents, {
    visibilityState: 'visible',
    createElement(tagName) { return { tagName, dataset: {}, textContent: '' } },
    head: { appendChild(node) { styleTags.push(node) } },
    querySelector() { return styleTags.length > 0 ? styleTags[0] : null },
  })

  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  /**
   * [0.9.1] 按 URL 区分：
   *   - `/api/plan-usage/custom-status` 返回**可选模型渠道**列表
   *     （设置页的自定义区需要它渲染「余额来源」下拉）；
   *   - 其它一律返回 `opts.payload`（取数响应）。
   *
   * 之前所有 URL 都返回同一个 payload，导致 custom-status 拿到取数结构、
   * `providers` 为空，自定义区只能显示「还没有可选的模型渠道」。
   */
  globalThis.fetch = async (url) => {
    if (String(url).includes('custom-status')) {
      return {
        json: async () => ({
          ok: true,
          data: {
            keys: opts.customStatusKeys || {},
            refs: opts.customStatusRefs || {},
            providers: opts.providers || [{ provider: 'review-fixture', displayName: 'Review Fixture', origin: 'https://a.example' }],
          },
        }),
      }
    }
    /**
     * [2026-10-23] 额度窗口能力（设置页按渠道/窗口配阈值时读取的**只读 metadata**）。
     *
     * 默认返回空 `channels`：没有样本就是"未知"，设置页只显示已保存的窗口配置。
     * 需要特定样本的测试用 `opts.quotaWindows` 注入，`opts.quotaWindowsError` 可模拟失败。
     */
    if (String(url).includes('quota-windows')) {
      if (opts.quotaWindowsError === true) throw new Error('quota-windows unreachable')
      return {
        json: async () => ({ ok: true, data: { channels: opts.quotaWindows || {}, readAt: 1 } }),
      }
    }
    return { json: async () => opts.payload }
  }

  new Function(source)()

  // 通过 apply(ctx) 取到胶囊组件与席位注册规格（两者都只经 ctx 暴露，不直接导出）。
  let Badge = null
  let SettingsPage = null
  let registration = null
  exportedModule.apply({
    configForms: { get: () => opts.form || null, whileServed: (_names, fn) => opts.form ? fn() : () => {} },
    slots: {
      inject: (_name, cb) => cb(),
      register: (spec, Comp) => {
        if (spec.name === 'sidebar.footer.action') { registration = spec; Badge = Comp }
        if (spec.name === 'settings.plugins.tab') SettingsPage = Comp
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })

  return {
    module: exportedModule,
    Badge,
    SettingsPage,
    registration,
    styleTags,
    windowEvents: fakeWindowEvents,
    documentEvents: fakeDocEvents,
    restore() {
      globalThis.setInterval = realSetInterval
      delete globalThis.document
      delete globalThis.window
      delete globalThis.fetch
    },
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
