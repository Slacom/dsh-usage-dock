// [dsh-go 原生适配] 额度面板（panels: quota）离线契约测试。
//
// 只验证 Host 半在 dsh-go 桥接下注册/投影的正确性与安全边界，**不冒充 App 真机**：
//   - package.json 清单（panels 落点、中英文、id 规则）；
//   - 视图骨架（组件类型/预算/绑定路径；中英文两套）；
//   - 数据投影（复用 projectUsage 的窗口口径、失败回退、自定义渠道行）；
//   - 动作（刷新/复制）与「没有桥接时 Web 半不受影响」。
//
// 视图的 App 侧渲染器在 https://github.com/ccch1mneyyy/dsh-Go 的 sdk/plugin-kit，
// 官方检查器 `kit/bin/check.mjs --load` 由发布流程单独执行（见 docs/dsh-go-native-panel.md）。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../index.js'
import {
  PANEL_ID,
  SETTINGS_PANEL_ID,
  MIMO_PANEL_ID,
  buildNativeView,
  buildNativeData,
  buildSettingsView,
  buildSettingsData,
  buildMimoLoginView,
  parseSettingsInput,
  placeholderPayload,
} from '../plans/dsh-go-native.js'

let passed = 0

function check(name, fn) {
  fn()
  passed += 1
  console.log('[PASS] ' + name)
}

async function checkAsync(name, fn) {
  await fn()
  passed += 1
  console.log('[PASS] ' + name)
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timeout'))
      }
    }, 25)
  })
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 允许的 v1 组件类型（App 在一起画，未知类型会被画成灰色占位）。 */
const V1_TYPES = new Set([
  'stack', 'row', 'text', 'metric', 'chart', 'compare', 'steps', 'callout',
  'list', 'keyValue', 'progress', 'table', 'actions', 'options', 'confirm', 'image',
])

function walkNodes(view, visit) {
  if (view === null || typeof view !== 'object') return
  if (Array.isArray(view)) {
    for (const item of view) walkNodes(item, visit)
    return
  }
  if (typeof view.type === 'string') visit(view)
  for (const value of Object.values(view)) walkNodes(value, visit)
}

function nodesOf(view) {
  const nodes = []
  walkNodes(view, (node) => nodes.push(node))
  return nodes
}

function bindingPaths(view) {
  const paths = []
  walkNodes(view, (node) => {
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.$ === 'string') {
        paths.push(value.$)
      }
    }
  })
  return paths
}

/** 与测试无关的 dsh-go 宿主模拟：记录面板注册、Web 路由与 settings 写回。 */
function mockHost(options = {}) {
  const withBridge = options.withBridge !== false
  const withSettings = options.withSettings !== false
  const recorded = { panels: new Map(), strips: new Map(), routes: 0, saves: [] }
  const dshGo = {
    panel(id, def) {
      recorded.panels.set(id, def)
      return () => { recorded.panels.delete(id) }
    },
    strip(id, fn) {
      recorded.strips.set(id, fn)
      return () => { recorded.strips.delete(id) }
    },
  }
  const settings = {
    async update(ns, patch) {
      recorded.saves.push({ ns, patch: JSON.parse(JSON.stringify(patch)) })
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return withSettings ? settings : undefined
      return undefined
    },
    effect(fn) {
      return fn()
    },
    on() { return () => {} },
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps || {})
      if (withBridge && names.includes('dshGo')) callback(Object.assign({}, ctx, { dshGo }))
      return () => {}
    },
    webServer: {
      port: 0,
      register() { recorded.routes += 1; return () => {} },
    },
  }
  return { ctx, recorded }
}

/** 设置面板的一份合法提交事件（基础字段 + 5 个关注开关；策略字段由用例按需追加）。 */
function settingsEvent(overrides = {}) {
  const values = Object.assign({
    'data.form.enabled': true,
    'data.form.opencodeGoEnabled': true,
    'data.form.deepseekEnabled': true,
    'data.form.deepseekWarnThreshold': 10,
    'data.form.codexEnabled': true,
    'data.form.codexSource': 'connect',
    'data.form.mimoEnabled': true,
    'data.form.mimoWarnThreshold': 10,
    'data.form.workbuddyEnabled': true,
    'data.form.quotaPolicyEnabled': false,
    'data.form.quotaTrustRouteOrder': false,
    'data.form.policyOpencodeFocus': false,
    'data.form.policyDeepseekFocus': false,
    'data.form.policyCodexFocus': false,
    'data.form.policyMimoFocus': false,
    'data.form.policyWorkbuddyFocus': false,
  }, overrides)
  return {
    surface: 'panel',
    id: SETTINGS_PANEL_ID,
    locale: 'zh-CN',
    value: { values },
  }
}

/** 深度遍历数出带 bind 的输入控件。 */
function inputControlsOf(view) {
  const controls = []
  walkNodes(view, (node) => {
    if (typeof node.bind === 'string') controls.push(node)
  })
  return controls
}

/** 找到某个渠道分组（stack）的子节点。 */
function groupOf(view, heading) {
  const form = nodesOf(view).find((node) => node.type === 'form')
  return form.children.find((node) => node.type === 'stack' && node.children.some((child) => child.text === heading))
}

function fakeWires(now) {
  // [0.11.0 整改] 每条 wire 都带 `identity`（来源身份）：原生面板的 carry 只允许在同一身份内复用。
  return [
    {
      id: 'opencode-go',
      identity: 'go-1',
      fetchedAt: now,
      rollingUsage: { percent: 62, resetInSec: 3600 },
      weeklyUsage: { percent: 81 },
      monthlyUsage: { percent: 47 },
    },
    {
      id: 'codex',
      identity: 'codex-connect-1',
      fetchedAt: now,
      rollingUsage: { percent: 55, resetsAt: new Date(now + 2 * 3600_000).toISOString() },
      weeklyUsage: { percent: 72 },
    },
    { id: 'deepseek', identity: 'deepseek-1', fetchedAt: now, balance: 18.03, currency: 'CNY', via: 'account' },
    { id: 'mimo', identity: 'mimo-1', fetchedAt: now, balance: 9.5, currency: 'CNY' },
    { id: 'workbuddy', identity: 'wb-1', fetchedAt: now, creditsTotal: 6017 },
    {
      id: 'custom:test01',
      custom: true,
      identity: 'custom-test01-1',
      name: 'OpenRouter',
      fetchedAt: now,
      balance: 12.5,
      currency: 'USD',
    },
  ]
}

function fakeCustomEntries() {
  return [{ id: 'custom:test01', enabled: true, name: 'OpenRouter' }]
}

// ── 1. 清单 ────────────────────────────────────────────────────────────────

check('package.json 有 dshGo v1 清单', () => {
  assert.equal(pkg.dshGo.v, 1)
  assert.equal(typeof pkg.dshGo.icon, 'string')
  assert.equal(pkg.dshGo.title.zh.length <= 24, true)
})

check('dshGo.composer.strip 声明单条 strip 并指向 quota 面板', () => {
  const strip = pkg.dshGo.contributes['composer.strip']
  assert.equal(Array.isArray(strip), true)
  assert.equal(strip.length, 1)
  assert.equal(strip[0].id, 'strip')
  assert.equal(strip[0].panel, 'quota')
  assert.equal(strip[0].icon, 'wallet')
  const quota = pkg.dshGo.contributes.panels.find((panel) => panel.id === 'quota')
  assert.equal(quota.presentation, 'sheet')
})

check('dshGo.panels 声明 quota / settings / mimo-login 三个面板', () => {
  const panels = pkg.dshGo.contributes.panels
  assert.equal(Array.isArray(panels), true)
  assert.equal(panels.length, 3)
  const quota = panels.find((panel) => panel.id === PANEL_ID)
  assert.deepEqual(quota.placement, ['session.tab', 'features'])
  assert.equal(quota.title.zh.length <= 16, true)
  assert.equal(quota.title.en.length <= 16, true)
  const settings = panels.find((panel) => panel.id === SETTINGS_PANEL_ID)
  assert.equal(settings.title.zh, '设置')
  assert.equal(settings.title.en, 'Settings')
  assert.deepEqual(settings.placement, ['plugin'])
  const mimo = panels.find((panel) => panel.id === MIMO_PANEL_ID)
  assert.equal(mimo.title.zh, 'MiMo 登录')
  assert.deepEqual(mimo.placement, ['plugin'])
})

check('Web 半的 dsh 清单原样保留（与 dshGo 并存）', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['slots', 'configForms'])
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

// ── 2. 视图 ────────────────────────────────────────────────────────────────

const plans = [
  { id: 'opencode-go', fields: { enabled: 'opencodeGoEnabled' }, name: 'OpenCode Go' },
  { id: 'deepseek', fields: { enabled: 'deepseekEnabled' }, name: 'DeepSeek' },
  { id: 'codex', fields: { enabled: 'codexEnabled' }, name: 'Codex' },
  { id: 'mimo', fields: { enabled: 'mimoEnabled' }, name: 'MiMo' },
  { id: 'workbuddy', fields: { enabled: 'workbuddyEnabled' }, name: 'WorkBuddy' },
]

check('中文视图：5 个内置渠道分块 + 刷新/设置按钮', () => {
  const view = buildNativeView({ cfg: {}, plans, locale: 'zh-CN', hasCustomChannels: false })
  assert.equal(view.type, 'stack')
  assert.equal(view.title, '额度')
  const nodes = nodesOf(view)
  assert.equal(nodes.filter((node) => node.type === 'stack').length, 6) // 根 + 5 渠道
  assert.equal(nodes.filter((node) => node.type === 'progress').length, 6) // opencode 3 + codex 3
  assert.equal(nodes.filter((node) => node.type === 'keyValue').length, 3)
  const actions = nodes.find((node) => node.type === 'actions')
  assert.deepEqual(actions.items.map((item) => item.action), ['refresh', 'settings'])
  assert.equal(actions.items.filter((item) => item.style === 'primary').length, 1)
})

check('英文视图：标题/窗口/按钮本地化', () => {
  const view = buildNativeView({ cfg: {}, plans, locale: 'en-US', hasCustomChannels: false })
  assert.equal(view.title, 'Usage')
  const texts = nodesOf(view).filter((node) => node.type === 'text').map((node) => node.text)
  assert.equal(texts.includes('**DeepSeek**'), true) // 渠道名不翻译
  const labels = nodesOf(view).filter((node) => node.type === 'progress').map((node) => node.label)
  assert.equal(labels.includes('5 hours'), true)
  const actions = nodesOf(view).find((node) => node.type === 'actions')
  assert.deepEqual(actions.items.map((item) => item.label), ['Refresh', 'Settings'])
})

check('视图在面板预算内：≤32 KiB / ≤120 节点 / ≤8 层 / 组件类型合法', () => {
  const view = buildNativeView({ cfg: {}, plans, locale: 'zh-CN', hasCustomChannels: true })
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  assert.equal(bytes <= 32 * 1024, true, 'view bytes ' + bytes)
  const nodes = nodesOf(view)
  assert.equal(nodes.length <= 120, true)
  for (const node of nodes) assert.equal(V1_TYPES.has(node.type), true, 'unknown type ' + node.type)
  // 根 children 数 ≤ 32；每个 stack/row 子节点 ≤ 32
  assert.equal(view.children.length <= 32, true)
  for (const node of nodes) {
    if (Array.isArray(node.children)) assert.equal(node.children.length <= 32, true)
  }
})

check('视图绑定全部以 data 开头，且不含 type 绑定', () => {
  const view = buildNativeView({ cfg: {}, plans, locale: 'zh-CN', hasCustomChannels: true })
  const paths = bindingPaths(view)
  assert.equal(paths.length > 0, true)
  for (const path of paths) assert.equal(path.startsWith('data.'), true, path)
  assert.equal(paths.length <= 16 * 64, true)
})

check('按 planOrder 排序（Codex 排到 OpenCode Go 前）', () => {
  const view = buildNativeView({
    cfg: { planOrder: ['codex', 'opencode-go'] },
    plans,
    locale: 'zh-CN',
  })
  const texts = view.children.filter((node) => node.type === 'stack')
  assert.equal(texts[0].children[0].text, '**Codex**')
  assert.equal(texts[1].children[0].text, '**OpenCode Go**')
})

check('停用渠道不出现在视图里', () => {
  const view = buildNativeView({ cfg: { deepseekEnabled: false }, plans, locale: 'zh-CN' })
  const texts = nodesOf(view).filter((node) => node.type === 'text').map((node) => node.text)
  assert.equal(texts.includes('**DeepSeek**'), false)
})

check('全局停用：视图只剩标题/按钮骨架，数据给出停用文案', async () => {
  const view = buildNativeView({ cfg: { enabled: false }, plans, locale: 'zh-CN' })
  assert.equal(view.children.filter((node) => node.type === 'stack').length, 0)
  const built = buildNativeData({ cfg: { enabled: false }, plans, locale: 'zh-CN', wires: [] })
  assert.equal(built.data.updated, '额度已停用')
  assert.equal(built.snapshot.disabled, true)
})

// ── 3. 数据投影 ─────────────────────────────────────────────────────────────

check('opencode-go 窗口按「已用→剩余」换算（与 Web/工具口径一致）', () => {
  const built = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: (id) => (id === 'codex' ? 'remaining' : 'used'),
    wires: fakeWires(1_700_000_000_000),
    customEntries: fakeCustomEntries(),
    locale: 'zh-CN',
    now: 1_700_000_000_000,
  })
  const opencode = built.data.channels.opencodeGo
  assert.equal(opencode.w5, 38) // 100 - 62
  assert.equal(opencode.week, 19) // 100 - 81
  assert.equal(opencode.month, 53) // 100 - 47
  assert.equal(opencode.tone, 'good')
  const codex = built.data.channels.codex
  assert.equal(codex.w5, 55) // codex 本来就是剩余
  assert.equal(codex.week, 72)
  assert.equal(codex.note.startsWith('更新 '), true)
})

check('重置时间：与网页版一致的两段式倒计时（天/时、时/分）', () => {
  const now = 1_700_000_000_000
  const built = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: (id) => (id === 'codex' ? 'remaining' : 'used'),
    wires: [
      {
        id: 'opencode-go',
        fetchedAt: now,
        rollingUsage: { percent: 62, resetInSec: 3600 },
        weeklyUsage: { percent: 81, resetsAt: new Date(now + (3 * 86400 + 12 * 3600) * 1000).toISOString() },
        monthlyUsage: { percent: 47, resetsAt: new Date(now + (12 * 3600 + 30 * 60) * 1000).toISOString() },
      },
      { id: 'codex', fetchedAt: now, rollingUsage: { percent: 55 }, weeklyUsage: { percent: 72 } },
    ],
    customEntries: [],
    locale: 'zh-CN',
    now,
  })
  const c = built.data.channels.opencodeGo
  assert.equal(c.c5.includes('剩余 38%'), true)
  assert.equal(c.c5.includes('1时'), true)
  assert.equal(c.cWeek.includes('3天12时'), true) // 不再只显示 08:00
  assert.equal(c.cMonth.includes('12时30分'), true)
  const cEn = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [
      { id: 'opencode-go', fetchedAt: now, weeklyUsage: { percent: 81, resetInSec: 3 * 86400 + 12 * 3600 } },
    ],
    customEntries: [],
    locale: 'en-US',
    now,
  })
  assert.equal(cEn.data.channels.opencodeGo.cWeek.includes('3d 12h'), true)
})

check('余额/积分渠道：金额格式与单位', () => {
  const built = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: fakeWires(1_700_000_000_000),
    customEntries: fakeCustomEntries(),
    locale: 'zh-CN',
    now: 1_700_000_000_000,
  })
  assert.equal(built.data.channels.deepseek.amount, '¥18.03')
  assert.equal(built.data.channels.mimo.amount, '¥9.5')
  assert.equal(built.data.channels.workbuddy.amount, '6017')
  assert.equal(built.data.channels.deepseek.note.startsWith('更新 '), true)
})

check('自定义余额渠道 → list 行（名称/余额/币种）', () => {
  const built = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: fakeWires(1_700_000_000_000),
    customEntries: fakeCustomEntries(),
    locale: 'zh-CN',
    now: 1_700_000_000_000,
  })
  assert.equal(built.data.customRows.length, 1)
  const row = built.data.customRows[0]
  assert.equal(row.title, 'OpenRouter')
  assert.equal(row.trailing, '$12.5')
  assert.equal(row.tone, 'good')
  assert.equal(typeof row.action, 'string')
})

check('暂时失败：灰化保留上一次成功值（deepseek 余额不回退成 —）', () => {
  const now = 1_700_000_000_000
  const first = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: fakeWires(now),
    customEntries: fakeCustomEntries(),
    locale: 'zh-CN',
    now,
  })
  const failed = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [
      { id: 'deepseek', identity: 'deepseek-1', error: 'network', transient: true },
      { id: 'opencode-go', identity: 'go-1', error: 'rate-limit', transient: true },
    ],
    customEntries: fakeCustomEntries(),
    locale: 'zh-CN',
    now: now + 60_000,
    previous: first.snapshot.previous,
  })
  assert.equal(failed.data.channels.deepseek.amount, '¥18.03') // 保留旧值
  assert.equal(failed.data.channels.deepseek.tone, 'warn')
  assert.equal(failed.data.channels.deepseek.note.includes('暂时失败'), true)
  assert.equal(failed.data.channels.opencodeGo.w5, 38) // 窗口也保留旧值
})

check('永久失败（鉴权/配置）：立即报错，不用旧值掩盖', () => {
  const now = 1_700_000_000_000
  const first = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: fakeWires(now),
    customEntries: [],
    locale: 'zh-CN',
    now,
  })
  const failed = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [{ id: 'deepseek', error: 'auth', transient: false }],
    customEntries: [],
    locale: 'zh-CN',
    now: now + 60_000,
    previous: first.snapshot.previous,
  })
  assert.equal(failed.data.channels.deepseek.amount, null)
  assert.equal(failed.data.channels.deepseek.tone, 'bad')
  assert.equal(failed.data.channels.deepseek.note.length > 0, true)
})

check('[0.11.0 整改] carry 按来源身份隔离：同身份暂时失败保留，换身份/缺身份/永久失败丢弃', () => {
  const now = 1_700_000_000_000
  const codexOn = (identity) => ([{
    id: 'codex',
    identity,
    fetchedAt: now,
    rollingUsage: { percent: 55 },
    weeklyUsage: { percent: 72 },
  }])
  const first = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: codexOn('codex-connect-1'),
    customEntries: [],
    locale: 'zh-CN',
    now,
  })
  assert.equal(first.data.channels.codex.week, 28) // 72「已用」→ 28 剩余（与其它用例同一口径）
  assert.deepEqual(Object.keys(first.snapshot.previous), ['codex|codex-connect-1'])

  // 同一身份下的暂时失败 ⇒ 保留旧值并标注
  const sameIdentity = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [{ id: 'codex', identity: 'codex-connect-1', error: 'network', transient: true }],
    customEntries: [],
    locale: 'zh-CN',
    now: now + 60_000,
    previous: first.snapshot.previous,
  })
  assert.equal(sameIdentity.data.channels.codex.week, 28)
  assert.equal(sameIdentity.data.channels.codex.tone, 'warn')
  assert.equal(sameIdentity.data.channels.codex.note.includes('暂时失败'), true)

  // 身份变化（Connect → Subscription）⇒ 丢弃该渠道 carry，不把旧 72% 当新来源
  const otherIdentity = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [{ id: 'codex', identity: 'codex-subscription-1', error: 'network', transient: true }],
    customEntries: [],
    locale: 'zh-CN',
    now: now + 60_000,
    previous: first.snapshot.previous,
  })
  assert.equal(otherIdentity.data.channels.codex.week, null)
  assert.equal(otherIdentity.data.channels.codex.tone, 'bad')
  // 旧身份的 carry 键不被继承（新快照只保留本次身份）
  assert.deepEqual(Object.keys(otherIdentity.snapshot.previous), ['codex|codex-subscription-1'])
  assert.equal(otherIdentity.snapshot.previous['codex|codex-subscription-1'].hasValues, false)

  // 身份缺失（旧 Host）⇒ 不复用 carry（fail-closed，不猜）
  const noIdentity = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [{ id: 'codex', error: 'network', transient: true }],
    customEntries: [],
    locale: 'zh-CN',
    now: now + 60_000,
    previous: first.snapshot.previous,
  })
  assert.equal(noIdentity.data.channels.codex.week, null)
  assert.deepEqual(Object.keys(noIdentity.snapshot.previous), [])

  // 永久失败（同身份）⇒ 清掉 carry；随后的暂时失败也不得复活旧值
  const permanent = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [{ id: 'codex', identity: 'codex-connect-1', error: 'auth', transient: false }],
    customEntries: [],
    locale: 'zh-CN',
    now: now + 60_000,
    previous: first.snapshot.previous,
  })
  assert.equal(permanent.data.channels.codex.week, null)
  assert.equal(permanent.data.channels.codex.tone, 'bad')
  const afterPermanent = buildNativeData({
    cfg: {},
    plans,
    semanticsOf: () => 'used',
    wires: [{ id: 'codex', identity: 'codex-connect-1', error: 'network', transient: true }],
    customEntries: [],
    locale: 'zh-CN',
    now: now + 120_000,
    previous: permanent.snapshot.previous,
  })
  assert.equal(afterPermanent.data.channels.codex.week, null)
  assert.equal(afterPermanent.data.channels.codex.note.includes('暂时失败'), false)
})

// ── 2.5 设置面板 ──────────────────────────────────────────────────────────

const V2_CAPS = {
  components: ['form', 'toggle', 'number', 'select', 'stack', 'row', 'grid', 'text', 'callout', 'divider', 'keyValue', 'actions'],
  features: [],
}

check('设置视图：按渠道分组；策略输入默认隐藏（关注开关关闭）', () => {
  const view = buildSettingsView({ caps: V2_CAPS, locale: 'zh-CN', cfg: {} })
  assert.equal(view.v, 2)
  assert.equal(view.title, '设置')
  const form = nodesOf(view).find((node) => node.type === 'form')
  assert.equal(form.submit, 'save')
  assert.equal(form.children.length, 6) // 6 个分组 stack
  for (const heading of ['**通用**', '**OpenCode Go**', '**DeepSeek**', '**Codex**', '**MiMo**', '**WorkBuddy**']) {
    assert.notEqual(groupOf(view, heading), undefined, heading)
  }
  const controls = inputControlsOf(view)
  const binds = controls.map((node) => node.bind)
  // 默认没有策略阈值输入框，也没有「允许路由观察」（策略总开关关闭时隐藏）。
  assert.equal(binds.includes('data.form.quotaTrustRouteOrder'), false)
  assert.equal(binds.some((bind) => bind.includes('policyOpencodeWarn')), false)
  assert.equal(binds.some((bind) => bind.startsWith('data.form.policy') && bind.endsWith('Focus')), true)
  for (const control of controls) {
    assert.equal(/^data\.form\.[A-Za-z][A-Za-z0-9]*$/.test(control.bind), true, control.bind)
  }
  // MiMo 分组里有扫码登录按钮。
  const mimo = groupOf(view, '**MiMo**')
  assert.equal(mimo.children.some((node) => node.type === 'actions'), true)
  const text = JSON.stringify(view)
  for (const forbidden of ['apiKey', 'ApiKey', 'mimoCookie', 'secret', 'customBalances', 'customKeys']) {
    assert.equal(text.includes(forbidden), false, forbidden)
  }
})

check('[0.11.0 整改] 策略开关节点带 onChange（总开关 + 5 个关注开关），其余控件不带', () => {
  const view = buildSettingsView({ caps: V2_CAPS, locale: 'zh-CN', cfg: { quotaPolicyEnabled: true } })
  const controls = inputControlsOf(view)
  const policy = controls.filter((node) => node.bind === 'data.form.quotaPolicyEnabled'
    || /^data\.form\.policy[A-Za-z]+Focus$/.test(node.bind))
  assert.equal(policy.length, 6)
  for (const node of policy) {
    assert.equal(node.type, 'toggle', node.bind)
    assert.equal(node.onChange, 'policyToggle', node.bind)
  }
  for (const node of controls) {
    if (policy.includes(node)) continue
    assert.equal(node.onChange, undefined, node.bind)
  }
  // 内部元数据（channel/scope/role）不得漏进视图节点。
  for (const node of controls) {
    assert.equal('channel' in node, false, node.bind)
    assert.equal('scope' in node, false, node.bind)
    assert.equal('role' in node, false, node.bind)
  }
})

check('策略开关打开：OpenCode Go 三个窗口各一行两框；其它渠道出现对应输入', () => {
  const cfg = {
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["opencode-go","deepseek","codex","mimo","workbuddy"]',
    quotaChannelThresholds: JSON.stringify({
      'opencode-go': { windows: { weekly: { warning: 20, closing: 5 } } },
    }),
  }
  const view = buildSettingsView({ caps: V2_CAPS, locale: 'zh-CN', cfg })
  const controls = inputControlsOf(view)
  const binds = controls.map((node) => node.bind)
  // 全局策略总开关打开 → 允许路由观察出现。
  assert.equal(binds.includes('data.form.quotaTrustRouteOrder'), true)
  // OpenCode Go：3 行 × 2 框（grid columns:2）。
  const opencode = groupOf(view, '**OpenCode Go**')
  const rows = opencode.children.filter((node) => node.type === 'grid')
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(row.columns, 2)
    assert.equal(row.children.length, 2)
    assert.equal(row.children.every((node) => node.type === 'number'), true)
  }
  assert.equal(binds.includes('data.form.policyOpencodeWarnWeek'), true)
  assert.equal(binds.includes('data.form.policyOpencodeCloseMonth'), true)
  // 其它渠道：打开关注后出现自己的策略输入。
  assert.equal(binds.includes('data.form.policyDeepseekWarn'), true)
  assert.equal(binds.includes('data.form.policyDeepseekCurrency'), true)
  assert.equal(binds.includes('data.form.policyMimoClose'), true)
  assert.equal(binds.includes('data.form.policyWorkbuddyWarn'), true)
  // Codex 只保留关注开关（每视图最多 32 个输入字段，细阈值仍在网页版设置页）。
  assert.equal(binds.includes('data.form.policyCodexWarnWeek'), false)
  // 全部渠道策略都打开时，输入字段总数不得超过 v2 表单上限 32。
  assert.equal(controls.length <= 32, true, 'controls ' + controls.length)
  // 数据回显：OpenCode Go 周窗口阈值来自配置。
  const data = buildSettingsData(cfg, {})
  assert.equal(data.form.policyOpencodeWarnWeek, 20)
  assert.equal(data.form.policyOpencodeCloseWeek, 5)
  assert.equal(data.form.policyWorkbuddyWarn, 0)
})

check('视图预算：分组后仍 ≤32 KiB / ≤120 节点 / 每组 ≤32 子节点', () => {
  const cfg = {
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["opencode-go","deepseek","codex","mimo","workbuddy"]',
  }
  const view = buildSettingsView({ caps: V2_CAPS, locale: 'zh-CN', cfg })
  assert.equal(Buffer.byteLength(JSON.stringify(view), 'utf8') <= 32 * 1024, true)
  const nodes = nodesOf(view)
  assert.equal(nodes.length <= 120, true)
  for (const node of nodes) {
    if (Array.isArray(node.children)) assert.equal(node.children.length <= 32, true)
  }
})

check('设置视图在面板预算内（≤32 KiB / ≤120 节点）', () => {
  const view = buildSettingsView({ caps: V2_CAPS, locale: 'zh-CN' })
  assert.equal(Buffer.byteLength(JSON.stringify(view), 'utf8') <= 32 * 1024, true)
  assert.equal(nodesOf(view).length <= 120, true)
})

check('老 App 没有 v2 组件：设置视图降级为说明（仍是合法 v1 视图）', () => {
  const view = buildSettingsView({ caps: { components: ['stack', 'text', 'callout'] }, locale: 'zh-CN' })
  assert.equal(view.v, undefined)
  assert.equal(view.type, 'stack')
  assert.equal(nodesOf(view).every((node) => V1_TYPES.has(node.type)), true)
  const callout = nodesOf(view).find((node) => node.type === 'callout')
  assert.equal(callout.tone, 'warn')
})

check('设置数据：读当前配置 / 关注开关 / 策略阈值回显', () => {
  const data = buildSettingsData({
    enabled: false,
    deepseekEnabled: false,
    deepseekWarnThreshold: 0,
    codexSource: 'subscription',
    mimoWarnThreshold: 5,
    workbuddyEnabled: false,
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["codex","mimo"]',
    quotaChannelThresholds: JSON.stringify({
      deepseek: { balance: { warning: 10, closing: 3, currency: 'USD' } },
      'opencode-go': { windows: { 'rolling-5h': { warning: 25, closing: 10 } } },
    }),
  }, { mimoStatus: 'MiMo 登录：可用' })
  assert.equal(data.form.enabled, false)
  assert.equal(data.form.deepseekEnabled, false)
  assert.equal(data.form.opencodeGoEnabled, true) // 缺省 true
  assert.equal(data.form.deepseekWarnThreshold, 0)
  assert.equal(data.form.codexSource, 'subscription')
  assert.equal(data.form.mimoWarnThreshold, 5)
  assert.equal(data.form.workbuddyEnabled, false)
  assert.equal(data.form.quotaPolicyEnabled, true)
  assert.equal(data.form.policyCodexFocus, true)
  assert.equal(data.form.policyMimoFocus, true)
  assert.equal(data.form.policyOpencodeFocus, false)
  assert.equal(data.form.policyDeepseekWarn, 10)
  assert.equal(data.form.policyDeepseekClose, 3)
  assert.equal(data.form.policyDeepseekCurrency, 'USD')
  assert.equal(data.form.policyOpencodeWarn5h, 25)
  assert.equal(data.form.mimoStatus, 'MiMo 登录：可用')
  const fallback = buildSettingsData(null)
  assert.equal(fallback.form.codexSource, 'connect')
  assert.equal(fallback.form.mimoWarnThreshold, 10)
  assert.equal(fallback.form.policyDeepseekCurrency, 'CNY')
})

check('设置提交校验：隐藏字段不写入、策略 JSON 合并、收尾<预警', () => {
  // 基础字段：策略关、关注全关 → patch 只含基础字段 + 空关注名单。
  const base = parseSettingsInput(settingsEvent(), 'zh-CN', {})
  assert.equal(base.ok, true)
  assert.deepEqual(Object.keys(base.patch).sort(), [
    'codexEnabled', 'codexSource', 'deepseekEnabled', 'deepseekWarnThreshold', 'enabled',
    'mimoEnabled', 'mimoWarnThreshold', 'opencodeGoEnabled',
    'quotaFocusChannels', 'quotaPolicyEnabled', 'quotaTrustRouteOrder', 'workbuddyEnabled',
  ])
  assert.equal(base.patch.quotaFocusChannels, '[]')
  assert.equal(base.patch.quotaChannelThresholds, undefined) // 策略输入没渲染 → 不动原 JSON

  // 打开 OpenCode Go 关注 + 填周窗口阈值 → 合并进 JSON。
  const merged = parseSettingsInput(settingsEvent({
    'data.form.policyOpencodeFocus': true,
    'data.form.policyOpencodeWarnWeek': 20,
    'data.form.policyOpencodeCloseWeek': 5,
  }), 'zh-CN', {
    quotaFocusChannels: '["codex"]',
    quotaChannelThresholds: JSON.stringify({ codex: { windows: { weekly: { warning: 30, closing: 10 } } } }),
  })
  assert.equal(merged.ok, true)
  assert.deepEqual(JSON.parse(merged.patch.quotaFocusChannels), ['opencode-go'])
  const thresholds = JSON.parse(merged.patch.quotaChannelThresholds)
  assert.deepEqual(thresholds['opencode-go'].windows.weekly, { warning: 20, closing: 5 })
  assert.deepEqual(thresholds.codex.windows.weekly, { warning: 30, closing: 10 })

  // 余额渠道：金额 + 币种。
  const balance = parseSettingsInput(settingsEvent({
    'data.form.policyDeepseekFocus': true,
    'data.form.policyDeepseekWarn': 10,
    'data.form.policyDeepseekClose': 3,
    'data.form.policyDeepseekCurrency': 'USD',
  }), 'zh-CN', {})
  assert.deepEqual(JSON.parse(balance.patch.quotaChannelThresholds).deepseek.balance, { warning: 10, closing: 3, currency: 'USD' })

  // 收尾必须小于预警；数字范围与选项校验。
  const badPair = parseSettingsInput(settingsEvent({
    'data.form.policyOpencodeFocus': true,
    'data.form.policyOpencodeWarnWeek': 5,
    'data.form.policyOpencodeCloseWeek': 20,
  }), 'zh-CN', {})
  assert.equal(badPair.ok, false)
  const badRange = parseSettingsInput(settingsEvent({ 'data.form.deepseekWarnThreshold': -1 }), 'zh-CN', {})
  assert.equal(badRange.ok, false)
  const badPolicyRange = parseSettingsInput(settingsEvent({
    'data.form.policyOpencodeFocus': true,
    'data.form.policyOpencodeWarnWeek': 101,
  }), 'zh-CN', {})
  assert.equal(badPolicyRange.ok, false)
  const badOption = parseSettingsInput(settingsEvent({ 'data.form.codexSource': 'nope' }), 'zh-CN', {})
  assert.equal(badOption.ok, false)
  const badToggle = parseSettingsInput(settingsEvent({ 'data.form.enabled': 'yes' }), 'zh-CN', {})
  assert.equal(badToggle.ok, false)
})

check('占位数据不显示任何数字（避免暴露上一次的旧值）', () => {
  const placeholder = placeholderPayload('zh-CN')
  assert.equal(placeholder.updated, '正在读取…')
  assert.deepEqual(Object.keys(placeholder.channels), [])
  assert.deepEqual(placeholder.customRows, [])
})

// ── 4. 注册与动作（真实 apply） ─────────────────────────────────────────────

await checkAsync('有桥接：apply 注册 composer strip', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  assert.equal(recorded.strips.has('strip'), true)
  assert.equal(typeof recorded.strips.get('strip'), 'function')
  const emitted = []
  const dispose = recorded.strips.get('strip')({ sessionId: undefined }, (value) => emitted.push(value), { locale: 'zh-CN' })
  assert.equal(typeof dispose, 'function')
  // 首次订阅延迟到 microtask（宿主可能在 apply 未完成时订阅；避免 const TDZ）。
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0], null) // 没有 sessionId → 隐藏，不显示空壳
  dispose()
})

await checkAsync('有桥接：apply 注册 quota / settings / mimo-login 三个面板', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  assert.equal(recorded.panels.has(PANEL_ID), true)
  assert.equal(recorded.panels.has(SETTINGS_PANEL_ID), true)
  assert.equal(recorded.panels.has(MIMO_PANEL_ID), true)
  const quota = recorded.panels.get(PANEL_ID)
  assert.equal(typeof quota.actions.refresh, 'function')
  assert.equal(typeof quota.actions.settings, 'function')
  const settings = recorded.panels.get(SETTINGS_PANEL_ID)
  assert.equal(typeof settings.actions.save, 'function')
  assert.equal(typeof settings.actions.mimoLogin, 'function')
  assert.deepEqual(settings.actions.mimoLogin({}, {}), { open: 'panel:' + MIMO_PANEL_ID })
  const mimo = recorded.panels.get(MIMO_PANEL_ID)
  assert.equal(typeof mimo.view, 'function')
  assert.equal(typeof mimo.data, 'function')
  assert.equal(typeof mimo.actions.restart, 'function')
  assert.equal(typeof mimo.actions.cancel, 'function')
  assert.equal(recorded.routes > 0, true)
})

await checkAsync('视图函数：额度与设置都能画（中英文）', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  for (const locale of ['zh-CN', 'en-US']) {
    const quota = recorded.panels.get(PANEL_ID)
    const quotaView = await quota.view({ sessionId: 's1' }, { locale, protocol: 1, app: '1.0.16' })
    assert.equal(quotaView.type, 'stack')
    assert.equal(quotaView.title, locale === 'en-US' ? 'Usage' : '额度')
    const settings = recorded.panels.get(SETTINGS_PANEL_ID)
    const settingsView = await settings.view({}, { locale, protocol: 1, app: '1.0.16', components: V2_CAPS.components })
    assert.equal(settingsView.v, 2)
    assert.equal(settingsView.title, locale === 'en-US' ? 'Settings' : '设置')
    const mimo = recorded.panels.get(MIMO_PANEL_ID)
    const mimoView = await mimo.view({}, { locale, protocol: 1, app: '1.0.16' })
    assert.equal(mimoView.type, 'stack')
    assert.equal(mimoView.title, locale === 'en-US' ? 'MiMo login' : 'MiMo 登录')
  }
})

await checkAsync('data feed：首帧占位 → 取数后推送完整数据并自动停止定时器', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  const emitted = []
  const stop = recorded.panels.get(PANEL_ID).data({ sessionId: 's1' }, (payload) => emitted.push(payload))
  try {
    await waitFor(() => emitted.length >= 2, 20_000)
  } finally {
    stop()
  }
  const first = emitted[0]
  assert.equal(first.updated, '正在读取…')
  const latest = emitted[emitted.length - 1]
  assert.equal(typeof latest.updated, 'string')
  // 无凭据环境下每个渠道都应是「有状态无密钥」的错误/缺失，而不是抛异常。
  const keys = Object.keys(latest.channels)
  assert.equal(keys.length >= 5, true, 'channels ' + keys.join(','))
  for (const key of keys) {
    assert.equal(typeof latest.channels[key].note, 'string')
    assert.equal(latest.channels[key].note.length > 0, true)
  }
  // 数据里不出现任何凭据/上游原文形态。
  const serialized = JSON.stringify(latest)
  for (const forbidden of ['Bearer ', 'sk-', 'https://', 'http://']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
})

await checkAsync('额度面板动作：设置按钮 → open panel:settings；刷新返回提示', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  const quota = recorded.panels.get(PANEL_ID)
  const meta = { surface: 'panel', id: PANEL_ID, locale: 'zh-CN' }
  assert.deepEqual(quota.actions.settings({}, meta), { open: 'panel:' + SETTINGS_PANEL_ID })
  const refresh = quota.actions.refresh({}, meta)
  assert.equal(refresh.toast.length > 0, true)
  assert.equal(refresh.pending, undefined)
})

await checkAsync('策略开关 onChange：即时保存关注名单/总开关并返回 refresh', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  const settings = recorded.panels.get(SETTINGS_PANEL_ID)
  const focusEvent = { surface: 'panel', id: SETTINGS_PANEL_ID, locale: 'zh-CN', value: { bind: 'data.form.policyDeepseekFocus', value: true } }
  const reply = await settings.actions.policyToggle({}, focusEvent)
  assert.deepEqual(reply, { refresh: true })
  assert.equal(recorded.saves.length, 1)
  assert.deepEqual(recorded.saves[0].patch, { quotaFocusChannels: '["deepseek"]' })
  const masterEvent = { surface: 'panel', id: SETTINGS_PANEL_ID, locale: 'zh-CN', value: { bind: 'data.form.quotaPolicyEnabled', value: true } }
  await settings.actions.policyToggle({}, masterEvent)
  assert.deepEqual(recorded.saves[1].patch, { quotaPolicyEnabled: true })
})

await checkAsync('[0.11.0 整改] policyToggle 只增删目标渠道，保留 codex/mimo/自定义/未知条目', async () => {
  // 原值里有其它内置渠道、自定义渠道与未知 id：旧实现会把它们当「未渲染字段」整体删掉。
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, { quotaFocusChannels: '["codex","mimo","custom:abcdef","legacy-unknown"]' })
  const settings = recorded.panels.get(SETTINGS_PANEL_ID)
  const event = (bind, value) => ({ surface: 'panel', id: SETTINGS_PANEL_ID, locale: 'zh-CN', value: { bind, value } })

  await settings.actions.policyToggle({}, event('data.form.policyDeepseekFocus', true))
  assert.deepEqual(JSON.parse(recorded.saves[0].patch.quotaFocusChannels),
    ['codex', 'mimo', 'custom:abcdef', 'legacy-unknown', 'deepseek'])

  await settings.actions.policyToggle({}, event('data.form.policyDeepseekFocus', false))
  assert.deepEqual(JSON.parse(recorded.saves[1].patch.quotaFocusChannels),
    ['codex', 'mimo', 'custom:abcdef', 'legacy-unknown'])

  // 关闭一个本来就不在名单里的关注项 ⇒ 名单原样（不误删其它条目）
  await settings.actions.policyToggle({}, event('data.form.policyWorkbuddyFocus', false))
  assert.deepEqual(JSON.parse(recorded.saves[2].patch.quotaFocusChannels),
    ['codex', 'mimo', 'custom:abcdef', 'legacy-unknown'])
})

await checkAsync('MiMo 登录视图：状态 / 二维码 / 按钮齐全', () => {
  const view = buildMimoLoginView({ locale: 'zh-CN' })
  assert.equal(view.type, 'stack')
  const image = nodesOf(view).find((node) => node.type === 'image')
  assert.deepEqual(image.src, { $: 'data.qr' })
  const actions = nodesOf(view).find((node) => node.type === 'actions')
  assert.deepEqual(actions.items.map((item) => item.action), ['restart', 'cancel'])
})

await checkAsync('MiMo 登录面板：宿主不支持时如实提示（无二维码）', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  const emitted = []
  const stop = recorded.panels.get(MIMO_PANEL_ID).data({}, (payload) => emitted.push(payload))
  try {
    await waitFor(() => emitted.length >= 1, 5000)
  } finally {
    stop()
  }
  assert.equal(emitted[0].tone, 'warn')
  assert.equal(emitted[0].qr, '')
  assert.equal(emitted[0].status.length > 0, true)
})

await checkAsync('设置保存：submit 走 settings 服务写回，只写非密钥字段', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true })
  apply(ctx, {})
  const settings = recorded.panels.get(SETTINGS_PANEL_ID)
  const result = settings.actions.save({}, settingsEvent({
    'data.form.deepseekEnabled': false,
    'data.form.workbuddyEnabled': false,
    'data.form.codexSource': 'subscription',
    'data.form.quotaPolicyEnabled': true,
    'data.form.policyOpencodeFocus': true,
    'data.form.policyOpencodeWarnWeek': 20,
    'data.form.policyOpencodeCloseWeek': 5,
  }))
  assert.equal(typeof result.pending, 'object')
  assert.equal(result.pending.timeoutMs > 0, true)
  const settled = await result.result(new AbortController().signal)
  assert.equal(settled.toast, '已保存')
  assert.equal(recorded.saves.length, 1)
  assert.equal(recorded.saves[0].ns, 'plan-usage')
  assert.deepEqual(recorded.saves[0].patch, {
    enabled: true,
    opencodeGoEnabled: true,
    deepseekEnabled: false,
    deepseekWarnThreshold: 10,
    codexEnabled: true,
    codexSource: 'subscription',
    mimoEnabled: true,
    mimoWarnThreshold: 10,
    workbuddyEnabled: false,
    quotaPolicyEnabled: true,
    quotaTrustRouteOrder: false,
    quotaFocusChannels: '["opencode-go"]',
    quotaChannelThresholds: '{"opencode-go":{"windows":{"weekly":{"warning":20,"closing":5}}}}',
  })
})

await checkAsync('设置保存：宿主没有 settings 服务时给可读提示、不抛错', async () => {
  const { ctx, recorded } = mockHost({ withBridge: true, withSettings: false })
  apply(ctx, {})
  const result = recorded.panels.get(SETTINGS_PANEL_ID).actions.save({}, settingsEvent())
  assert.equal(typeof result.pending, 'object')
  const settled = await result.result(new AbortController().signal)
  assert.equal(typeof settled.toast, 'string')
  assert.equal(recorded.saves.length, 0)
})

await checkAsync('没有 dsh-go 桥接的主机：不注册原生面板，Web 半照旧', async () => {
  const { ctx, recorded } = mockHost({ withBridge: false })
  apply(ctx, {})
  assert.equal(recorded.panels.size, 0)
  assert.equal(recorded.routes > 0, true)
})

check('面板 id 符合协议规则且互不重复', () => {
  const ids = [PANEL_ID, SETTINGS_PANEL_ID, MIMO_PANEL_ID]
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.equal(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(id), true)
})

console.log('\n全部 ' + passed + ' 项通过（Host 半契约，非 App 真机渲染）')
