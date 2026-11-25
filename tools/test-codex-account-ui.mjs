/**
 * [2026-11-23 Codex 多账户] 设置页 Codex 卡片：ChatGPT 账号登录（添加 / 切换 / 重登 / 退出）。
 *
 * 全部跑**真实的 client.js**（tools/mock-react.mjs 的极简 React 运行时），
 * 路由全部是 fake（没有 localhost 服务、没有真实 Host、没有真实凭据、不联网）。
 *
 * 组：
 *   A  导出面 / 纯解析函数（来源只剩跨端兼容子集；账户解析白名单）
 *   B  设置页接线：**没有**来源区、不请求 codex-sources，账号卡片始终渲染
 *   C  多账户卡片：添加按钮 / radio / 每行重登与退出（非选中行也显示） / canLogin / 只读 / 进行中
 *   D  安全：无 body / 无 authorization / 哨兵不外泄 / 坏记录恢复入口 / 敌意登录码
 *   E  生命周期：授权后收敛、取消、卸载、轮询节奏
 *
 * 边界：只证明「客户端逻辑 + 合成 wire」。Host 侧路由由另一路实现，
 * 本文件不代表任何真实 Host 已按此契约实现（契约见 client.js 的注释块）。
 *
 * 用法：node tools/test-codex-account-ui.mjs
 *      DSH_CLIENT_UNDER_TEST=<stage/client.js> node tools/test-codex-account-ui.mjs
 */
import { createRuntime, loadClient } from './mock-react.mjs'

let pass = 0
let fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name) } else {
    fail++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 700)))
  }
}

// ---------------------------------------------------------------------------
// 计时器加速：组件用一次性 setTimeout 自续轮询；把它压到 0ms，
// 这样「每 2 秒轮询」的**节拍语义**（一拍一次请求）可被快速驱动。
// ---------------------------------------------------------------------------
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function fastTimeout (fn, _ms, ...rest) { return realSetTimeout(fn, 0, ...rest) }

// ===========================================================================
// 渲染树工具（只遍历**字符串元素**；不主动展开函数组件，避免在 hooks 上下文外调用组件）
// ===========================================================================
function elementsOf (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 40) return out
  if (Array.isArray(node)) { for (const n of node) elementsOf(n, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'string') {
    out.push(node)
    elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
  }
  return out
}
const byAttr = (tree, attr, value) => elementsOf(tree).find((el) => el.props && el.props[attr] === value)
const allByAttr = (tree, attr) => elementsOf(tree).filter((el) => el.props && el.props[attr] !== undefined)
function flatText (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 60) return out.join('')
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out.join('') }
  if (Array.isArray(node)) { for (const n of node) flatText(n, out, depth); return out.join('') }
  if (typeof node !== 'object' || node.type === undefined) return out.join('')
  flatText(node.props ? node.props.children : undefined, out, depth + 1)
  return out.join('')
}
const textAll = (tree) => flatText(tree)
const attrText = (tree, attr, value) => {
  const el = byAttr(tree, attr, value)
  return el === undefined ? '' : textAll(el)
}
/** 收集元素上的**字符串/数字属性值**（跳过 children / ref 的父子环），用于哨兵扫描。 */
function attrTexts (node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 60) return out
  if (Array.isArray(node)) { for (const n of node) attrTexts(n, out, depth); return out }
  if (node.type === undefined) return out
  const props = node.props || {}
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'ref' || key === 'parentElement') continue
    const v = props[key]
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v))
  }
  attrTexts(props.children, out, depth + 1)
  return out
}
/** 整棵树里出现过的**属性名**（用于断言「没有任何 data-codex-source* 属性」）。 */
function propNames (tree) {
  const names = new Set()
  for (const el of elementsOf(tree)) {
    for (const key of Object.keys(el.props || {})) names.add(key)
  }
  return [...names]
}
/** 递归找「函数组件元素」中 type 等于给定组件的节点（不展开其内部）。 */
function findComponentNodes (node, comp, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 60) return out
  if (Array.isArray(node)) { for (const n of node) findComponentNodes(n, comp, out, depth); return out }
  if (node.type === comp) out.push(node)
  const kids = node.props ? node.props.children : undefined
  if (kids !== undefined) findComponentNodes(kids, comp, out, depth + 1)
  return out
}
const within = (tree, attr, value) => byAttr(tree, attr, value) !== undefined

// ===========================================================================
// 夹具
// ===========================================================================
const BASE_CFG = { enabled: true, planOrder: '[]', codexEnabled: true }
const SENTINEL = 'sk-TOKEN-SENTINEL-do-not-render-9f3a'

const ROUTES = {
  state: '/api/plan-usage/codex-account/state',
  login: '/api/plan-usage/codex-account/login',
  status: '/api/plan-usage/codex-account/login/status',
  cancel: '/api/plan-usage/codex-account/login/cancel',
  select: '/api/plan-usage/codex-account/select',
  logout: '/api/plan-usage/codex-account/logout',
}
const withId = (base, id) => base + '?id=' + encodeURIComponent(id)

const ACCOUNTS_MULTI = [
  { id: 'acc-1', label: 'shangsilcom@gmail.com', planType: 'plus', active: true },
  { id: 'acc-2', label: 'work@example.com', plan: 'pro', active: false },
]
const STATE_MULTI = {
  ok: true,
  data: {
    configured: true,
    canLogin: true,
    activeAccountId: 'acc-1',
    account: { label: 'shangsilcom@gmail.com', planType: 'plus' },
    accounts: ACCOUNTS_MULTI,
  },
}
const STATE_ACC2 = {
  ok: true,
  data: {
    configured: true,
    canLogin: true,
    activeAccountId: 'acc-2',
    account: { label: 'work@example.com', planType: 'pro' },
    accounts: ACCOUNTS_MULTI,
  },
}
const STATE_ACC2_ONLY = {
  ok: true,
  data: {
    configured: true,
    canLogin: true,
    activeAccountId: 'acc-2',
    account: { label: 'work@example.com', planType: 'pro' },
    accounts: [ACCOUNTS_MULTI[1]],
  },
}
/** 非选中行（acc-2）退出后：acc-1 仍是唯一账户且仍是 active。 */
const STATE_ACC1_ONLY = {
  ok: true,
  data: {
    configured: true,
    canLogin: true,
    activeAccountId: 'acc-1',
    account: { label: 'shangsilcom@gmail.com', planType: 'plus' },
    accounts: [ACCOUNTS_MULTI[0]],
  },
}
const STATE_ONE = {
  ok: true,
  data: {
    configured: true,
    canLogin: true,
    activeAccountId: 'acc-9',
    account: { label: 'new@example.com', planType: 'plus' },
    accounts: [{ id: 'acc-9', label: 'new@example.com', planType: 'plus', active: true }],
  },
}
const STATE_SIGNED_OUT = { ok: true, data: { configured: false, canLogin: true, accounts: [] } }
const STATE_NO_LOGIN = {
  ok: true,
  data: { configured: false, canLogin: false, accounts: [], reason: 'no-credentials' },
}
const STATE_BAD_RECORD = {
  ok: true,
  data: { configured: false, canLogin: true, accounts: [], reason: 'incompatible' },
}
const STATE_CANNOT_LOGIN = Object.assign({}, STATE_MULTI, {
  data: Object.assign({}, STATE_MULTI.data, { canLogin: false }),
})

const LOGIN_START = {
  ok: true,
  data: {
    status: 'pending',
    userCode: 'ABCD-1234',
    verificationUri: 'https://auth.openai.com/codex/device',
    expiresInSec: 600,
  },
}

const okJson = (body) => ({ status: 200, json: async () => body })

function makeForm (initial, options) {
  const opts = options || {}
  const listeners = new Set()
  const writes = []
  const mutations = []
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]' }, initial || {}),
    writable: opts.writable !== false,
    getSnapshot () { return { value: this.value, writable: this.writable } },
    subscribe (listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set (field, value) {
      writes.push({ field, value })
      form.value = Object.assign({}, form.value, { [field]: value })
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
    mutate (ops) {
      mutations.push(ops)
      for (const op of ops) {
        if (op.op === 'set' && Array.isArray(op.path) && op.path.length === 1) {
          form.value = Object.assign({}, form.value, { [op.path[0]]: op.value })
        }
      }
      listeners.forEach((fn) => fn())
      return Promise.resolve(true)
    },
    publish (next) { form.value = next; listeners.forEach((fn) => fn()) },
  }
  return { form, writes, mutations }
}

/**
 * 可编排的 fake fetch：`routes[url] = 响应对象 | (index) => 响应对象`，
 * index 是**该 URL 的第几次**调用（1 基）。记录每次 { url, init }，
 * 供断言「无 body / 无 authorization / 不重复请求 / 轮询停止」。
 */
function makeFetch (routes, fallback) {
  const calls = []
  const fake = async (url, init) => {
    const key = String(url)
    calls.push({ url: key, init: init === undefined ? null : init })
    const index = calls.filter((c) => c.url === key).length
    const handler = routes[key]
    if (typeof handler === 'function') return handler(index, key)
    if (handler !== undefined) return okJson(handler)
    if (typeof fallback === 'function') {
      const res = fallback(key)
      if (res !== undefined) return res
    }
    return { status: 404, json: async () => ({ ok: false }) }
  }
  return { calls, fake, countOf: (url) => calls.filter((c) => String(c.url) === url).length }
}

/** 直接挂载账号卡片（mock 的树工具不展开带 hooks 的子组件，必须直挂）。 */
function mountBlock (props, routes, fallback) {
  const runtime = createRuntime()
  const client = loadClient(runtime, { form: makeForm({}).form, payload: { ok: true, data: { plans: [] } } })
  const Block = client.module.codexAccount.Block
  const fake = makeFetch(routes, fallback)
  globalThis.fetch = fake.fake
  let currentProps = props
  runtime.mount(Block, currentProps)
  return {
    runtime,
    client,
    Block,
    calls: fake.calls,
    countOf: fake.countOf,
    render: (next) => {
      if (next !== undefined) currentProps = next
      return runtime.renderOnce(currentProps)
    },
    settle: () => runtime.settle(currentProps),
    /** 卸载：mock 的 mount 会先跑上一个实例的 effect cleanup。 */
    unmount: () => runtime.mount(function EmptyAfterUnmount () { return null }, {}),
    /**
     * 收尾：**先卸载再 restore**。
     *
     * 卸载会跑 effect cleanup（`aliveRef=false` + clearTimeout + attempt+1），否则
     * 「等待授权」的 0ms 自续定时器会活到下一个用例，把状态请求打到下一个用例的
     * fake fetch 上（表现为可疑的额外 status 调用）。这是夹具卫生，不是产品行为。
     */
    restore: () => {
      try { runtime.mount(function EmptyAfterUnmount () { return null }, {}) } catch (err) { /* 忽略夹具噪声 */ }
      client.restore()
    },
  }
}

function openSettings (initial, options) {
  const opts = options || {}
  const runtime = createRuntime()
  const { form, writes } = makeForm(initial, opts)
  const client = loadClient(runtime, { form, payload: { ok: true, data: { plans: [] } } })
  const fallback = opts.fallback || ((url) => {
    if (url.includes('custom-status')) return okJson({ ok: true, data: { keys: {}, refs: {}, providers: [] } })
    if (url.includes('quota-windows')) return okJson({ ok: true, data: { channels: {}, readAt: 1 } })
    return undefined
  })
  const fake = makeFetch(opts.routes || {}, fallback)
  globalThis.fetch = fake.fake
  runtime.mount(client.SettingsPage, { form })
  return {
    runtime,
    form,
    writes,
    client,
    calls: fake.calls,
    countOf: fake.countOf,
    settle: () => runtime.settle({ form }),
    restore: () => {
      try { runtime.mount(function EmptyAfterUnmount () { return null }, {}) } catch (err) { /* 忽略夹具噪声 */ }
      client.restore()
    },
  }
}

/** 让 Promise 链 + 0ms 定时器充分推进（轮询自续需要多个宏任务）。 */
async function settleDeep (ctx, rounds = 40) {
  let tree = await ctx.settle()
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0))
    tree = await ctx.settle()
  }
  return tree
}
/** 推进固定拍数（用于「停止轮询后调用数不增加」）。 */
async function pump (ctx, ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => realSetTimeout(resolve, 0))
  return ctx.settle()
}
const urlsOf = (ctx) => ctx.calls.map((c) => c.url)

// ===========================================================================
// A — 导出面 / 纯解析函数
// ===========================================================================
{
  const runtime = createRuntime()
  const client = loadClient(runtime, { payload: { ok: true, data: { plans: [] } } })
  const src = client.module.codexSource
  const acct = client.module.codexAccount
  /** [2026-11-23 多账户] group A 里**第一次** parseState 之前的账户身份（见 A12）。 */
  const identityBeforeAnyState = acct.uiIdentity()
  const mapBeforeAnyState = src.identityMap({ codexSource: 'account' }).codex

  const removedKeys = ['labels', 'label', 'note', 'route', 'stateText', 'parsePayload', 'rowState', 'PatchBlock']
  check('A1a codexSource 只剩跨端安全子集（不再引用已删除的 label/note/PatchBlock 等）',
    removedKeys.every((k) => src[k] === undefined)
    && typeof src.normalize === 'function' && typeof src.digestPart === 'function'
    && typeof src.digest === 'function' && src.planId === 'codex',
    removedKeys.map((k) => [k, typeof src[k]]))

  check('A1b 来源枚举/默认值仍按跨端契约保留（connect 仍是不写摘要的默认）',
    Array.isArray(src.ids) && src.ids.join(',') === 'connect,subscription,account'
    && src.defaultSource === 'connect')

  check("A2  normalize 逐字镜像 Host：大小写/空白归一，未知回 connect",
    src.normalize('account') === 'account' && src.normalize(' Account ') === 'account'
    && src.normalize('ACCOUNT') === 'account' && src.normalize(undefined) === 'connect'
    && src.normalize(null) === 'connect' && src.normalize('bogus') === 'connect'
    && src.normalize(42) === 'connect' && src.normalize('') === 'connect')

  check('A3a 摘要片段：connect（含缺失/非法）不追加片段',
    src.digestPart({}) === '' && src.digestPart({ codexSource: 'connect' }) === ''
    && src.digestPart({ codexSource: 'bogus' }) === '')
  check('A3b 摘要片段：subscription / account 追加同一格式的片段',
    src.digestPart({ codexSource: 'subscription' }) === 'builtin:codex-source\u0002subscription'
    && src.digestPart({ codexSource: 'account' }) === 'builtin:codex-source\u0002account')

  const a4Base = src.identity({ codexSource: 'account' })
  const a4Map = src.identityMap({ codexSource: 'account' }).codex
  check('A4a 内置 Codex 身份 = builtin:codex\\u0002<source>，identityMap 以它开头',
    a4Base === 'builtin:codex\u0002account' && a4Map.indexOf(a4Base) === 0,
    { base: a4Base, map: a4Map })
  check('A4b 老 wire 无 codexSource 时按 connect 兼容（不猜账户来源）',
    src.fromWire({}) === 'connect' && src.fromWire(null) === 'connect'
    && src.fromWire({ codexSource: 'ACCOUNT' }) === 'account')

  check('A4c 16 位摘要：来源不同 ⇒ 摘要不同；来源=connect ⇒ 与缺字段一致',
    src.digest({ codexSource: 'account' }) !== src.digest({})
    && src.digest({ codexSource: 'subscription' }) !== src.digest({ codexSource: 'account' })
    && src.digest({ codexSource: 'connect' }) === src.digest({}))

  check('A5a codexAccount 暴露 Block + 6 条路由（含 select/logout）',
    typeof acct.Block === 'function'
    && acct.routes.state === ROUTES.state && acct.routes.login === ROUTES.login
    && acct.routes.status === ROUTES.status && acct.routes.cancel === ROUTES.cancel
    && acct.routes.select === ROUTES.select && acct.routes.logout === ROUTES.logout,
    acct.routes)
  check('A5b pollMs=2000 / 登录页前缀只允许 auth.openai.com',
    acct.pollMs === 2000 && acct.authPrefix === 'https://auth.openai.com/')

  check('A6  routeWithId：合规 id 走 query，不合规 id 绝不拼接',
    acct.routeWithId(ROUTES.select, 'acc-1') === ROUTES.select + '?id=acc-1'
    && acct.routeWithId(ROUTES.logout, 'a-b-9') === ROUTES.logout + '?id=a-b-9'
    && acct.routeWithId(ROUTES.logout, 'bad id/../x') === ROUTES.logout
    && acct.routeWithId(ROUTES.logout, '') === ROUTES.logout
    && acct.routeWithId(ROUTES.logout, null) === ROUTES.logout
    && acct.routeWithId(ROUTES.logout, 42) === ROUTES.logout)

  const parsed = acct.parseState(STATE_MULTI)
  check('A7a parseState 多账户：signedIn/activeAccountId/accounts/canLogin 全部就位',
    parsed !== null && parsed.signedIn === true && parsed.activeAccountId === 'acc-1'
    && parsed.accounts.length === 2 && parsed.accounts[0].active === true
    && parsed.accounts[1].active === false && parsed.canLogin === true,
    parsed)
  check('A7b 每行 plan 取 planType/plan，只保留 id/label/plan/active（maskedId 丢弃）',
    parsed.accounts[0].plan === 'plus' && parsed.accounts[1].plan === 'pro'
    && Object.keys(parsed.accounts[0]).sort().join(',') === 'active,id,label,plan')
  check('A7c activeAccountId 指向不存在的账户 ⇒ 重新按列表确定（不渲染幽灵选中项）',
    (function () {
      const p = acct.parseState({
        ok: true,
        data: { configured: true, activeAccountId: 'ghost', accounts: ACCOUNTS_MULTI },
      })
      return p.activeAccountId === 'acc-1' && p.accounts.filter((a) => a.active).length === 1
    })())
  check('A7d 老 Host 无 accounts 时仍能用 account 摘要给出已登录',
    (function () {
      const p = acct.parseState({ ok: true, data: { status: 'signed-in', account: { email: 'a@b.c', plan: 'plus' } } })
      return p !== null && p.signedIn === true && p.accounts.length === 0 && p.account.label === 'a@b.c'
    })())

  check('A8a parseList 丢弃不合规/重复行，并把 maskedId 从结果里去掉',
    (function () {
      const list = acct.parseList([
        { id: 'ok-1', label: 'a', planType: 'plus', active: true, maskedId: SENTINEL },
        { id: 'bad id!', label: 'b' },
        { label: 'no-id' },
        { id: 42 },
        { id: 'ok-1', label: 'dup' },
        null,
        'x',
      ])
      return list.length === 1 && list[0].id === 'ok-1' && list[0].maskedId === undefined
        && list[0].plan === 'plus' && list[0].active === true
    })())
  check('A8b parseList 上限 24 项；非数组返回 null（老 Host 走兼容行）',
    acct.parseList(Array.from({ length: 30 }, (_, i) => ({ id: 'a' + i }))).length === 24
    && acct.parseList(null) === null && acct.parseList({}) === null)

  check('A9a 账号文本白名单：控制字符变空格、超长截断到 120',
    acct.parseList([{ id: 'x1', label: '  bad\u0000name  ', planType: 'PLUS' }])[0].label === 'bad name'
    && acct.parseList([{ id: 'x2', label: 'L'.repeat(300) }])[0].label.length === 120)
  const planCases = [['plus', 'Plus'], ['PLUS', 'Plus'], ['pro', 'Pro'], ['team', 'Team'],
    ['enterprise', 'Enterprise'], ['free', 'Free'], ['max', 'Max'], ['', ''], [null, '']]
  check('A9b 订阅类型显示名：已知值映射，未知值首字母大写，空值空串',
    planCases.every(([raw, expected]) => acct.planLabel(raw) === expected),
    planCases.map(([raw]) => [raw, acct.planLabel(raw)]))

  check('A10a parseLoginStart 兼容 camel/snake 字段与毫秒 expiresAt',
    (function () {
      const camel = acct.parseLoginStart(LOGIN_START)
      const snake = acct.parseLoginStart({
        ok: true,
        data: { user_code: 'WXYZ-9876', verification_uri: 'https://auth.openai.com/device', expires_in: 300 },
      })
      const ms = acct.parseLoginStart({
        ok: true,
        data: { userCode: 'ABCD-1234', verificationUri: 'https://auth.openai.com/d', expiresAt: Date.now() + 600000 },
      })
      return camel.userCode === 'ABCD-1234' && camel.expiresInSec === 600
        && snake.userCode === 'WXYZ-9876' && snake.expiresInSec === 300
        && ms.expiresInSec >= 590 && ms.expiresInSec <= 600
    })())
  check('A10b 敌意登录码/链接在解析阶段就被丢弃（全空 ⇒ null）',
    (function () {
      const badCode = acct.parseLoginStart({
        ok: true, data: { userCode: '<script>alert(1)</script>', verificationUri: 'https://auth.openai.com/device' },
      })
      const badUri = acct.parseLoginStart({
        ok: true, data: { userCode: 'ABCD-1234', verificationUri: 'https://evil.example/device' },
      })
      const none = acct.parseLoginStart({ ok: true, data: { userCode: '<x>', verificationUri: 'javascript:alert(1)' } })
      return badCode.userCode === null && badCode.verificationUri === 'https://auth.openai.com/device'
        && badUri.userCode === 'ABCD-1234' && badUri.verificationUri === null
        && none === null
    })())
  check('A10c parseLoginStatus：等待/成功/失败/过期/取消 与 Host 词汇一一映射',
    (function () {
      const st = (data) => acct.parseLoginStatus({ ok: true, data })
      return st({ status: 'waiting' }).status === 'pending'
        && st({ status: 'exchanging' }).status === 'pending'
        && st({ status: 'completed' }).status === 'authorized'
        && st({ status: 'idle' }).status === 'failed'
        && st({ status: 'expired' }).status === 'expired'
        && st({ status: 'canceled' }).status === 'cancelled'
        && st({ status: 'bogus' }) === null
        && acct.parseLoginStatus({ ok: false }) !== null
    })())

  check('A11  安全短 id 白名单：只接受 [A-Za-z0-9-]{1,100}',
    acct.safeId('acc-1') === 'acc-1' && acct.safeId(' acc-1 ') === 'acc-1'
    && acct.safeId('a b') === null && acct.safeId('a/b') === null
    && acct.safeId('a?b') === null && acct.safeId('') === null && acct.safeId(7) === null)

  /**
   * [2026-11-23 多账户] 账户身份进入逐条身份（胶囊/详情 prune 的判据）。
   *
   * 真实缺口：Host 的 wire 身份 `acct=…` 已随切换立即变化，但客户端逐条身份只含「配置来源」，
   * 于是切换账户后上一个账户的数字被当成同一身份沿用（最多 30 秒）。这里断言：
   *   ① 读 state 前不宣称任何账户（`unknown` ⇒ 不追加片段）；
   *   ② 读到 active 账户后追加稳定短串；同一账户重复解析保持稳定；
   *   ③ 换 active / 退出后身份必变；
   *   ④ 短串不含明文 accountId / token（只放 id+修订号的 16 位摘要）。
   */
  {
    const cfg = { codexSource: 'account' }
    const base = src.identity(cfg)
    const mapOf = () => src.identityMap(cfg).codex
    const startIdentity = identityBeforeAnyState
    const mapUnknown = mapBeforeAnyState

    acct.parseState(STATE_MULTI)
    const idAcc1 = acct.uiIdentity()
    const mapAcc1 = mapOf()
    acct.parseState(STATE_MULTI)
    const idAcc1Again = acct.uiIdentity()
    const mapAcc1Again = mapOf()
    acct.parseState(STATE_ACC2)
    const idAcc2 = acct.uiIdentity()
    const mapAcc2 = mapOf()
    acct.parseState(STATE_SIGNED_OUT)
    const idOut = acct.uiIdentity()
    const mapOut = mapOf()

    check('A12a 读 state 前身份 = unknown（不追加账户片段）；读到 active 后 = 来源身份 + acct 片段',
      startIdentity === 'unknown' && mapUnknown === base
      && idAcc1 !== 'unknown' && idAcc1 !== 'none'
      && mapAcc1 === base + '\u0003acct\u0002' + idAcc1,
      { startIdentity, base, mapUnknown, mapAcc1, idAcc1 })

    check('A12b 同一账户重复解析保持稳定；切换账户 / 退出后逐条身份必变',
      idAcc1Again === idAcc1 && mapAcc1Again === mapAcc1
      && idAcc2 !== idAcc1 && mapAcc2 !== mapAcc1
      && idOut === 'none' && mapOut === base + '\u0003acct\u0002none' && mapOut !== mapAcc1,
      { idAcc1, idAcc2, idOut, mapAcc1, mapAcc2, mapOut })

    check('A12c 账户身份短串不含明文 accountId / token（只放 id+revision 的摘要）',
      [idAcc1, idAcc2].every((s) => s.indexOf('acc-1') === -1 && s.indexOf('acc-2') === -1
        && s.indexOf(SENTINEL) === -1 && /^acct\u0002[0-9a-f]{16}$/.test(s))
      && [mapAcc1, mapAcc2, mapOut].every((s) => s.indexOf('acc-1') === -1
        && s.indexOf('acc-2') === -1 && s.indexOf(SENTINEL) === -1),
      { idAcc1, idAcc2, mapAcc1 })
  }

  client.restore()
}

// ===========================================================================
// B — 设置页接线：没有来源区、不请求 codex-sources、账号卡片始终渲染
// ===========================================================================
{
  const ctx = openSettings(BASE_CFG, {
    routes: {
      [ROUTES.state]: STATE_MULTI,
      '/api/plan-usage/codex-sources': { ok: true, data: { sources: [], selected: 'connect' } },
      '/api/plan-usage/codex-subscription/patch-state': { ok: true, data: { state: 'appliable' } },
    },
  })
  const tree = await ctx.settle()
  const card = byAttr(tree, 'data-plan-card', 'codex')
  const Block = ctx.client.module.codexAccount.Block

  check('B1  设置页树里没有任何 Codex 来源区属性（data-codex-source*）',
    propNames(tree).filter((k) => k.indexOf('data-codex-source') === 0).length === 0,
    propNames(tree).filter((k) => k.indexOf('data-codex-source') === 0))

  check('B2a 不再请求 GET /api/plan-usage/codex-sources（0 次）',
    ctx.countOf('/api/plan-usage/codex-sources') === 0, urlsOf(ctx))
  check('B2b 也不再请求 codex-subscription/patch-state（一键适配已退场）',
    ctx.countOf('/api/plan-usage/codex-subscription/patch-state') === 0, urlsOf(ctx))

  check('B3  Codex 卡片内直接渲染 CodexAccountBlock（唯一一个，且不再有 active 入参）',
    card !== undefined && (function () {
      const nodes = findComponentNodes(card, Block)
      return nodes.length === 1 && nodes[0].props.active === undefined && nodes[0].props.writable === true
    })(), card === undefined ? 'codex card missing' : findComponentNodes(card, Block).map((n) => n.props))

  const cardText = textAll(card)
  check('B4  卡片里没有来源选择/摘要/说明/一键适配文案',
    cardText.indexOf('Codex Connect') === -1 && cardText.indexOf('Codex Subscription') === -1
    && cardText.indexOf('额度来源') === -1 && cardText.indexOf('一键适配') === -1
    && cardText.indexOf('当前来源') === -1 && cardText.indexOf('将切换到') === -1,
    cardText.slice(0, 400))

  // 老配置里可能还留着 codexSource：UI 不读它，账号卡片照样渲染。
  const ctxLegacy = openSettings(Object.assign({}, BASE_CFG, { codexSource: 'subscription' }), {
    routes: { [ROUTES.state]: STATE_MULTI },
  })
  const treeLegacy = await ctxLegacy.settle()
  const cardLegacy = byAttr(treeLegacy, 'data-plan-card', 'codex')
  check('B5a 旧配置 codexSource=subscription 不影响 UI：账号卡片仍在、仍无来源区',
    cardLegacy !== undefined && findComponentNodes(cardLegacy, ctxLegacy.client.module.codexAccount.Block).length === 1
    && byAttr(treeLegacy, 'data-codex-source-block', '1') === undefined)

  const ctxOff = openSettings(Object.assign({}, BASE_CFG, { codexEnabled: false }), {
    routes: { [ROUTES.state]: STATE_MULTI },
  })
  const treeOff = await ctxOff.settle()
  const cardOff = byAttr(treeOff, 'data-plan-card', 'codex')
  check('B5b 渠道关闭时 Codex 卡片不渲染账号卡片（与其它渠道一致）',
    cardOff !== undefined
    && findComponentNodes(cardOff, ctxOff.client.module.codexAccount.Block).length === 0
    && byAttr(treeOff, 'data-codex-account-add', '1') === undefined)

  const ctxRO = openSettings(BASE_CFG, { writable: false, routes: { [ROUTES.state]: STATE_MULTI } })
  const treeRO = await ctxRO.settle()
  const cardRO = byAttr(treeRO, 'data-plan-card', 'codex')
  check('B6  只读部署：账号卡片收到 writable:false（卡片内入口全部禁用）',
    (function () {
      const nodes = findComponentNodes(cardRO, ctxRO.client.module.codexAccount.Block)
      return nodes.length === 1 && nodes[0].props.writable === false
    })())

  ctx.restore()
  ctxLegacy.restore()
  ctxOff.restore()
  ctxRO.restore()
}

// ===========================================================================
// C — 多账户卡片
// ===========================================================================
{
  // C1：未登录（无账户）——「添加账户」占满整行且在列表上方
  const ctx1 = mountBlock({ writable: true }, { [ROUTES.state]: STATE_SIGNED_OUT })
  const tree1 = await ctx1.settle()
  const add1 = byAttr(tree1, 'data-codex-account-add', '1')
  check('C1a 未登录：状态 signed-out + 固定说明',
    tree1.props['data-codex-account-state'] === 'signed-out'
    && attrText(tree1, 'data-codex-account-signed-out', '1').indexOf('尚未登录') !== -1)
  check('C1b 无账户也显示「添加账户」（第一个子节点 = 列表上方）',
    add1 !== undefined && textAll(add1) === '添加账户'
    && Array.isArray(tree1.props.children) && tree1.props.children[0] === add1)
  check('C1c 添加账户占满整行（width:100% / border-box / 居中）',
    add1.props.style.width === '100%' && add1.props.style.boxSizing === 'border-box'
    && add1.props.style.textAlign === 'center')
  check('C1d 未登录时添加账户可用（canLogin:true / 可写）', add1.props.disabled === false)
  ctx1.restore()

  // C2/C3：多账户行 —— radio + 名称 · 订阅类型；动作区**每行都有**（不再只在选中行）
  const ctx2 = mountBlock({ writable: true }, { [ROUTES.state]: STATE_MULTI })
  const tree2 = await ctx2.settle()
  const row1 = byAttr(tree2, 'data-codex-account-row', 'acc-1')
  const row2 = byAttr(tree2, 'data-codex-account-row', 'acc-2')
  const radio1 = byAttr(row1, 'data-codex-account-radio', 'acc-1')
  const radio2 = byAttr(row2, 'data-codex-account-radio', 'acc-2')
  check('C2a 每个已保存账户一行，含 radio（选中 = active）',
    row1 !== undefined && row2 !== undefined
    && radio1 !== undefined && radio1.props.type === 'radio'
    && radio1.props.checked === true && radio2.props.checked === false)
  check('C2b 行内文本是「账号名 · 订阅类型」，分隔点为弱色 tertiary',
    textAll(row1).indexOf('shangsilcom@gmail.com') !== -1
    && textAll(row1).indexOf('Plus') !== -1
    && byAttr(row1, 'data-codex-account-label', 'acc-1').props.style.fontSize === 14
    && byAttr(row1, 'data-codex-account-label', 'acc-1').props.style.fontWeight === 500
    && byAttr(row1, 'data-codex-account-label', 'acc-1').props.style.color === 'var(--dsw-alias-label-primary)'
    && byAttr(row1, 'data-codex-account-plan', 'acc-1').props.style.fontSize === 13
    && byAttr(row1, 'data-codex-account-plan', 'acc-1').props.style.color === 'var(--dsw-alias-label-secondary)',
    textAll(row1))
  const sepEl = elementsOf(row1).find((el) => el.props && el.props['aria-hidden'] === 'true' && textAll(el) === '·')
  check('C2c 分隔点「·」13px / tertiary 且 aria-hidden（读屏不念）',
    sepEl !== undefined && sepEl.props.style.fontSize === 13
    && sepEl.props.style.color === 'var(--dsw-alias-label-tertiary)')
  /**
   * [2026-11-23 终审] 省略号必须挂在**文本子项**上：`display:flex` 的容器不参与 inline
   * 文本溢出计算，写在外层 `textOverflow` 永远不生效。守门断言直接检查两组行内样式：
   * 外层只负责占宽/收缩（flex:1 1 auto + minWidth:0），省略号与 nowrap 在 label 上。
   */
  {
    const nameBox = row1.props.children[1]
    const labelEl = byAttr(row1, 'data-codex-account-label', 'acc-1')
    const labelStyle = labelEl !== undefined ? labelEl.props.style : {}
    const nameStyle = nameBox !== undefined ? nameBox.props.style : {}
    check('C2d 账号名省略号在 label 子项上（overflow:hidden / textOverflow:ellipsis / nowrap / minWidth:0）',
      labelStyle.overflow === 'hidden' && labelStyle.textOverflow === 'ellipsis'
      && labelStyle.whiteSpace === 'nowrap' && labelStyle.minWidth === 0
      && nameStyle.display === 'flex' && nameStyle.flex === '1 1 auto' && nameStyle.minWidth === 0,
      { label: labelStyle, name: nameStyle })
  }
  check('C3a 选中行（radio 在该行）右侧同一行有「重新登录」「退出账号」',
    row1.props['data-codex-account-selected'] === '1'
    && within(row1, 'data-codex-account-relogin', 'acc-1')
    && within(row1, 'data-codex-account-logout', 'acc-1')
    && textAll(byAttr(row1, 'data-codex-account-relogin', 'acc-1')) === '重新登录'
    && textAll(byAttr(row1, 'data-codex-account-logout', 'acc-1')) === '退出账号')
  const actions = row1.props.children[2]
  check('C3b 动作区 marginLeft:auto（贴最右）+ 行不换行（flexWrap:nowrap）',
    actions !== undefined && actions.props.style.marginLeft === 'auto'
    && row1.props.style.flexWrap === 'nowrap' && row1.props.style.display === 'flex')
  check('C3c 非选中行也显示「重新登录」「退出账号」（data-codex-account-logout=acc-2）',
    row2.props['data-codex-account-selected'] === undefined
    && within(row2, 'data-codex-account-relogin', 'acc-2')
    && within(row2, 'data-codex-account-logout', 'acc-2')
    && textAll(byAttr(row2, 'data-codex-account-relogin', 'acc-2')) === '重新登录'
    && textAll(byAttr(row2, 'data-codex-account-logout', 'acc-2')) === '退出账号',
    textAll(row2))
  check('C3e 每一行都渲染两个按钮（数量 = 账户数 × 2），动作区 marginLeft:auto 且 flex:0 0 auto',
    allByAttr(tree2, 'data-codex-account-relogin').length === ACCOUNTS_MULTI.length
    && allByAttr(tree2, 'data-codex-account-logout').length === ACCOUNTS_MULTI.length
    && [row1, row2].every((r) => {
      const kids = r.props.children || []
      const acts = kids[2]
      return acts !== undefined && acts.props.style.marginLeft === 'auto'
        && acts.props.style.flex === '0 0 auto'
        && Array.isArray(acts.props.children) && acts.props.children.length === 2
        && acts.props.children[0].props['data-codex-account-relogin'] === r.props['data-codex-account-row']
        && acts.props.children[1].props['data-codex-account-logout'] === r.props['data-codex-account-row']
    }),
    { relogin: allByAttr(tree2, 'data-codex-account-relogin').length,
      logout: allByAttr(tree2, 'data-codex-account-logout').length,
      rows: allByAttr(tree2, 'data-codex-account-row').length })
  ctx2.restore()

  // C3d：点**非选中行**的「退出账号」→ 只移除该行（logout?id=acc-2），不动 active 的 acc-1
  {
    let state = STATE_MULTI
    const logout1 = withId(ROUTES.logout, 'acc-1')
    const logout2 = withId(ROUTES.logout, 'acc-2')
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: () => okJson(state),
      [logout2]: () => { state = STATE_ACC1_ONLY; return okJson({ ok: true }) },
    })
    let tree = await ctx.settle()
    const nonActiveRow = byAttr(tree, 'data-codex-account-row', 'acc-2')
    check('C3d0 非选中行渲染自己的「退出账号」（data-codex-account-logout=acc-2）',
      nonActiveRow !== undefined && nonActiveRow.props['data-codex-account-selected'] === undefined
      && byAttr(nonActiveRow, 'data-codex-account-logout', 'acc-2') !== undefined)
    byAttr(tree, 'data-codex-account-logout', 'acc-2').props.onClick()
    tree = await ctx.settle()
    const logoutCall = ctx.calls.find((c) => c.url === logout2)
    check('C3d 点非选中行的「退出账号」= POST /codex-account/logout?id=acc-2（不是 active 的 acc-1，空 body）',
      ctx.countOf(logout2) === 1 && ctx.countOf(logout1) === 0
      && logoutCall !== undefined && logoutCall.init.method === 'POST'
      && logoutCall.init.body === undefined, urlsOf(ctx))
    check('C3d2 Host 返回后按 state 收敛：只移除 acc-2，acc-1 仍是选中行 + 「已退出账号。」',
      ctx.countOf(ROUTES.state) === 2
      && byAttr(tree, 'data-codex-account-row', 'acc-2') === undefined
      && byAttr(tree, 'data-codex-account-row', 'acc-1') !== undefined
      && byAttr(tree, 'data-codex-account-row', 'acc-1').props['data-codex-account-selected'] === '1'
      && attrText(tree, 'data-codex-account-notice', '1') === '已退出账号。', urlsOf(ctx))
    ctx.restore()
  }

  // C3f：老 Host 兼容行（无 accounts / id=null）仍有两个按钮，退出走无 id 的整体退出
  {
    const STATE_LEGACY = {
      ok: true,
      data: { configured: true, canLogin: true, account: { label: 'legacy@example.com', planType: 'plus' } },
    }
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: STATE_LEGACY,
      [ROUTES.logout]: { ok: true },
    })
    const tree = await ctx.settle()
    const legacy = byAttr(tree, 'data-codex-account-row', 'legacy')
    check('C3f 老 Host 兼容行（id=null）仍渲染两个按钮，且退出不带 id（整体退出）',
      legacy !== undefined
      && byAttr(legacy, 'data-codex-account-radio', '1') === undefined
      && textAll(byAttr(legacy, 'data-codex-account-relogin', '1')) === '重新登录'
      && textAll(byAttr(legacy, 'data-codex-account-logout', '1')) === '退出账号'
      && (function () { const acts = legacy.props.children[1]; return acts !== undefined
        && acts.props.style.marginLeft === 'auto' })())
    byAttr(tree, 'data-codex-account-logout', '1').props.onClick()
    await pump(ctx, 4)
    check('C3f2 兼容行的「退出账号」= POST /codex-account/logout（无 query、空 body）',
      ctx.countOf(ROUTES.logout) === 1
      && ctx.calls.some((c) => c.url === ROUTES.logout && c.init.method === 'POST' && c.init.body === undefined),
      urlsOf(ctx))
    ctx.restore()
  }

  // C4：radio → POST select?id= → 重新 GET state
  {
    let state = STATE_MULTI
    const selectUrl = withId(ROUTES.select, 'acc-2')
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: () => okJson(state),
      [selectUrl]: () => { state = STATE_ACC2; return okJson({ ok: true }) },
    })
    let tree = await ctx.settle()
    const epochBefore = ctx.client.module.configEpoch()
    const identityBefore = ctx.client.module.codexAccount.uiIdentity()
    byAttr(tree, 'data-codex-account-radio', 'acc-2').props.onChange()
    tree = await ctx.settle()
    const urls = urlsOf(ctx)
    const calls = ctx.calls
    const stateCallIndexes = calls.map((c, i) => (c.url === ROUTES.state ? i : -1)).filter((i) => i >= 0)
    const selectIndex = calls.findIndex((c) => c.url === selectUrl)
    const selectCall = calls.find((c) => c.url === selectUrl)
    check('C4a radio 切换 = POST /codex-account/select?id=acc-2（空 body）',
      ctx.countOf(selectUrl) === 1 && selectCall !== undefined
      && selectCall.init.method === 'POST' && selectCall.init.body === undefined, urls)
    check('C4b 切换成功后重新 GET state，选中行随之更新',
      stateCallIndexes.length === 2 && stateCallIndexes[1] > selectIndex
      && (function () {
        const r = byAttr(tree, 'data-codex-account-row', 'acc-2')
        return byAttr(r, 'data-codex-account-radio', 'acc-2').props.checked === true
          && r.props['data-codex-account-selected'] === '1'
          && within(r, 'data-codex-account-logout', 'acc-2')
          && within(byAttr(tree, 'data-codex-account-row', 'acc-1'), 'data-codex-account-logout', 'acc-1')
      })())
    check('C4c 切换成功 bump 配置代次 + 账户身份变化（胶囊/详情立即重取，不等 30 秒轮询）',
      ctx.client.module.configEpoch() === epochBefore + 1
      && ctx.client.module.codexAccount.uiIdentity() !== identityBefore,
      { epochBefore, epochAfter: ctx.client.module.configEpoch(),
        identityBefore, identityAfter: ctx.client.module.codexAccount.uiIdentity() })
    ctx.restore()
  }

  // C4d：切换失败不 bump（「没生效」不是账户变化），且以 Host 的 state 收敛
  {
    const selectUrl = withId(ROUTES.select, 'acc-2')
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: STATE_MULTI,
      // 网络/HTTP 失败：adapter 走 rejection 分支（失败的 select 才有固定文案）
      [selectUrl]: () => { throw new Error('select failed') },
    })
    let tree = await ctx.settle()
    const epochBefore = ctx.client.module.configEpoch()
    const identityBefore = ctx.client.module.codexAccount.uiIdentity()
    byAttr(tree, 'data-codex-account-radio', 'acc-2').props.onChange()
    tree = await ctx.settle()
    check('C4d 切换失败：固定文案 + 代次/账户身份都不变（失败不 bump），选中项仍是 Host 的 active',
      ctx.countOf(selectUrl) === 1
      && attrText(tree, 'data-codex-account-notice', '1') === '切换账户失败，请稍后重试。'
      && ctx.client.module.configEpoch() === epochBefore
      && ctx.client.module.codexAccount.uiIdentity() === identityBefore
      && byAttr(tree, 'data-codex-account-row', 'acc-1').props['data-codex-account-selected'] === '1',
      { notice: attrText(tree, 'data-codex-account-notice', '1'),
        epochBefore, epochAfter: ctx.client.module.configEpoch() })
    ctx.restore()
  }

  // C4e–C4g：HTTP 200 只代表「请求到了」——`{ok:false}` 必须按失败处理，且可重试
  {
    const selectUrl = withId(ROUTES.select, 'acc-2')
    let state = STATE_MULTI
    let attempt = 0
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: () => okJson(state),
      [selectUrl]: () => {
        attempt += 1
        // 第 1 次：Host 明确说「没切」（HTTP 200 + ok:false，旧 active 不变）；
        // 第 2 次：真的切成功，回 {ok:true, data:<B 的 state>}。
        if (attempt === 1) return okJson({ ok: false, error: 'select', message: '切换账户失败' })
        state = STATE_ACC2
        return okJson({ ok: true, data: STATE_ACC2.data })
      },
    })
    let tree = await ctx.settle()
    const epochBefore = ctx.client.module.configEpoch()
    const identityBefore = ctx.client.module.codexAccount.uiIdentity()
    byAttr(tree, 'data-codex-account-radio', 'acc-2').props.onChange()
    tree = await ctx.settle()
    check('C4e 200 + {ok:false} 不当成切换成功：固定文案 + Host active 仍是 acc-1 + 恢复可交互',
      ctx.countOf(selectUrl) === 1
      && attrText(tree, 'data-codex-account-notice', '1') === '切换账户失败，请稍后重试。'
      && byAttr(tree, 'data-codex-account-row', 'acc-1').props['data-codex-account-selected'] === '1'
      && byAttr(tree, 'data-codex-account-radio', 'acc-1').props.checked === true
      && byAttr(tree, 'data-codex-account-radio', 'acc-2').props.checked === false
      && byAttr(tree, 'data-codex-account-radio', 'acc-2').props.disabled === false
      && ctx.client.module.configEpoch() === epochBefore
      && ctx.client.module.codexAccount.uiIdentity() === identityBefore,
      { notice: attrText(tree, 'data-codex-account-notice', '1'),
        state: tree.props['data-codex-account-state'], urls: urlsOf(ctx) })

    const noticeAfterFailure = attrText(tree, 'data-codex-account-notice', '1')
    await pump(ctx, 6)
    const treeIdle = await ctx.settle()
    check('C4f 失败提示不会被后续刷新/重渲染清掉（keepNotice 生效）',
      noticeAfterFailure.indexOf('切换账户失败') !== -1
      && attrText(treeIdle, 'data-codex-account-notice', '1') === noticeAfterFailure,
      { noticeAfterFailure, after: attrText(treeIdle, 'data-codex-account-notice', '1') })

    // 同一个 radio 再点一次 = 重试；这次 Host 回 200 + {ok:true, data:<B state>}。
    byAttr(tree, 'data-codex-account-radio', 'acc-2').props.onChange()
    tree = await ctx.settle()
    check('C4g 可重试且 200 + {ok:true} ⇒ 以 Host state 收敛到 B（acc-2 选中、提示清空）',
      ctx.countOf(selectUrl) === 2
      && byAttr(tree, 'data-codex-account-row', 'acc-2').props['data-codex-account-selected'] === '1'
      && byAttr(tree, 'data-codex-account-radio', 'acc-2').props.checked === true
      && byAttr(tree, 'data-codex-account-radio', 'acc-2').props.disabled === false
      && byAttr(tree, 'data-codex-account-notice', '1') === undefined,
      { urls: urlsOf(ctx), state: tree.props['data-codex-account-state'] })
    ctx.restore()
  }

  // C5：添加账户 → POST login → 设备码 → 轮询 → authorized → 重新 GET state
  {
    let state = STATE_SIGNED_OUT
    let statusCount = 0
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: () => okJson(state),
      [ROUTES.login]: LOGIN_START,
      [ROUTES.status]: (i) => {
        statusCount = i
        if (i >= 3) { state = STATE_ONE; return okJson({ ok: true, data: { status: 'authorized' } }) }
        return okJson({ ok: true, data: { status: 'pending' } })
      },
    })
    let tree = await ctx.settle()
    const add = byAttr(tree, 'data-codex-account-add', '1')
    add.props.onClick()
    tree = await settleDeep(ctx, 40)
    const loginCall = ctx.calls.find((c) => c.url === ROUTES.login)
    check('C5a 添加账户 = POST /codex-account/login（空 body），随后轮询 status',
      ctx.countOf(ROUTES.login) === 1 && loginCall !== undefined && loginCall.init.method === 'POST'
      && loginCall.init.body === undefined && ctx.countOf(ROUTES.status) >= 3,
      urlsOf(ctx))
    check('C5b authorized 后 Host 会说 upsert+选中：客户端重新 GET state 并按新列表渲染',
      ctx.countOf(ROUTES.state) === 2
      && tree.props['data-codex-account-state'] === 'signed-in'
      && byAttr(tree, 'data-codex-account-row', 'acc-9') !== undefined
      && byAttr(tree, 'data-codex-account-user-code', '1') === undefined
      && textAll(tree).indexOf('new@example.com') !== -1,
      urlsOf(ctx))
    check('C5c 授权成功后设备码区域消失、添加账户按钮仍在（可继续添加）',
      byAttr(tree, 'data-codex-account-waiting', '1') === undefined
      && byAttr(tree, 'data-codex-account-add', '1') !== undefined)
    check('C5d 轮询在 authorized 后停止（status 调用数不再增长）',
      await (async () => {
        const before = ctx.countOf(ROUTES.status)
        await pump(ctx, 6)
        return ctx.countOf(ROUTES.status) === before
      })())
    ctx.restore()
  }

  // C6：退出账号 → POST logout?id= → 重新 GET state；最后一个退完后回到未登录
  {
    let state = STATE_MULTI
    const logout1 = withId(ROUTES.logout, 'acc-1')
    const logout2 = withId(ROUTES.logout, 'acc-2')
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: () => okJson(state),
      [logout1]: () => { state = STATE_ACC2_ONLY; return okJson({ ok: true }) },
      [logout2]: () => { state = STATE_SIGNED_OUT; return okJson({ ok: true }) },
    })
    let tree = await ctx.settle()
    byAttr(tree, 'data-codex-account-logout', 'acc-1').props.onClick()
    tree = await ctx.settle()
    const firstCall = ctx.calls.find((c) => c.url === logout1)
    check('C6a 退出账号 = POST /codex-account/logout?id=<id>（空 body）',
      ctx.countOf(logout1) === 1 && firstCall !== undefined && firstCall.init.method === 'POST'
      && firstCall.init.body === undefined, urlsOf(ctx))
    check('C6b 退出后以 Host 的 state 为准：剩下账户成为选中行',
      ctx.countOf(ROUTES.state) === 2
      && byAttr(tree, 'data-codex-account-row', 'acc-1') === undefined
      && byAttr(tree, 'data-codex-account-row', 'acc-2') !== undefined
      && byAttr(tree, 'data-codex-account-row', 'acc-2').props['data-codex-account-selected'] === '1'
      && attrText(tree, 'data-codex-account-notice', '1') === '已退出账号。', urlsOf(ctx))
    byAttr(tree, 'data-codex-account-logout', 'acc-2').props.onClick()
    tree = await ctx.settle()
    check('C6c 最后一个账户退出后：未登录 + 添加账户（无残留账户行）',
      ctx.countOf(logout2) === 1
      && tree.props['data-codex-account-state'] === 'signed-out'
      && allByAttr(tree, 'data-codex-account-row').length === 0
      && byAttr(tree, 'data-codex-account-add', '1') !== undefined,
      urlsOf(ctx))
    ctx.restore()
  }

  // C7：canLogin:false ⇒ 添加/重登禁用（退出仍可用），且程序化点击零请求
  {
    const ctx = mountBlock({ writable: true }, { [ROUTES.state]: STATE_CANNOT_LOGIN, [ROUTES.login]: LOGIN_START })
    const tree = await ctx.settle()
    const add = byAttr(tree, 'data-codex-account-add', '1')
    const relogin = byAttr(tree, 'data-codex-account-relogin', 'acc-1')
    const logout = byAttr(tree, 'data-codex-account-logout', 'acc-1')
    check('C7a canLogin:false ⇒ 添加账户 / 重新登录禁用，退出账号仍可用',
      add.props.disabled === true && relogin.props.disabled === true && logout.props.disabled === false)
    add.props.onClick()
    await pump(ctx, 3)
    check('C7b canLogin:false 时即使程序化触发也不发 login 请求（零请求兜底）',
      ctx.countOf(ROUTES.login) === 0 && ctx.countOf(ROUTES.status) === 0, urlsOf(ctx))
    ctx.restore()
  }

  // C8：只读部署 ⇒ 全部入口禁用，且不产生额外请求
  {
    const ctx = mountBlock({ writable: false }, { [ROUTES.state]: STATE_MULTI })
    const tree = await ctx.settle()
    check('C8a 只读：添加/radio/重登/退出全部禁用',
      byAttr(tree, 'data-codex-account-add', '1').props.disabled === true
      && byAttr(tree, 'data-codex-account-radio', 'acc-1').props.disabled === true
      && byAttr(tree, 'data-codex-account-relogin', 'acc-1').props.disabled === true
      && byAttr(tree, 'data-codex-account-logout', 'acc-1').props.disabled === true)
    check('C8b 只读：只读一次 state，没有触发任何动作请求',
      ctx.countOf(ROUTES.state) === 1 && ctx.countOf(ROUTES.login) === 0
      && ctx.countOf(ROUTES.select) === 0 && ctx.countOf(ROUTES.logout) === 0, urlsOf(ctx))
    ctx.restore()
  }

  // C9：进行中（等待授权）⇒ 添加/radio/重登 禁用，退出仍可用
  {
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: STATE_MULTI,
      [ROUTES.login]: LOGIN_START,
      [ROUTES.status]: { ok: true, data: { status: 'pending' } },
      [ROUTES.cancel]: { ok: true },
    })
    let tree = await ctx.settle()
    byAttr(tree, 'data-codex-account-relogin', 'acc-1').props.onClick()
    tree = await settleDeep(ctx, 10)
    const phase = tree.props['data-codex-account-block']
    check('C9a 等待授权期间：添加/radio/重登/退出 全部禁用（避免重入；取消用下面单独的按钮）',
      phase === 'waiting'
      && byAttr(tree, 'data-codex-account-add', '1').props.disabled === true
      && byAttr(tree, 'data-codex-account-radio', 'acc-1').props.disabled === true
      && byAttr(tree, 'data-codex-account-relogin', 'acc-1').props.disabled === true
      && byAttr(tree, 'data-codex-account-logout', 'acc-1').props.disabled === true,
      phase)
    check('C9b 进行中：设备码/打开登录页/取消 三件套都在',
      byAttr(tree, 'data-codex-account-user-code', '1') !== undefined
      && byAttr(tree, 'data-codex-account-open', '1') !== undefined
      && byAttr(tree, 'data-codex-account-cancel', '1') !== undefined)
    byAttr(tree, 'data-codex-account-cancel', '1').props.onClick()
    const epochBeforeCancel = ctx.client.module.configEpoch()
    tree = await settleDeep(ctx, 6)
    check('C9c 取消后停轮询并回到 Host 的真实 state（仍显示已登录账户）',
      ctx.countOf(ROUTES.cancel) === 1
      && tree.props['data-codex-account-state'] === 'signed-in'
      && attrText(tree, 'data-codex-account-notice', '1') === '已取消登录。'
      && byAttr(tree, 'data-codex-account-row', 'acc-1') !== undefined)
    check('C9d 取消登录不 bump 配置代次（账户没变，胶囊不必重取）',
      ctx.client.module.configEpoch() === epochBeforeCancel,
      { epochBeforeCancel, epochAfter: ctx.client.module.configEpoch() })
    ctx.restore()
  }

  // C10：退出失败 ⇒ 固定文案「退出账号失败」并以 Host 的 state 收敛（不本地猜结果）
  {
    const logout2 = withId(ROUTES.logout, 'acc-2')
    const ctx = mountBlock({ writable: true }, {
      [ROUTES.state]: STATE_MULTI,
      [logout2]: () => { throw new Error('logout failed') },
    })
    let tree = await ctx.settle()
    byAttr(tree, 'data-codex-account-logout', 'acc-2').props.onClick()
    tree = await ctx.settle()
    check('C10 退出失败：固定文案「退出账号失败，请稍后重试。」+ 账户列表按 Host state 保留',
      ctx.countOf(logout2) === 1
      && attrText(tree, 'data-codex-account-notice', '1') === '退出账号失败，请稍后重试。'
      && byAttr(tree, 'data-codex-account-row', 'acc-2') !== undefined
      && byAttr(tree, 'data-codex-account-row', 'acc-1').props['data-codex-account-selected'] === '1',
      { notice: attrText(tree, 'data-codex-account-notice', '1'), urls: urlsOf(ctx) })
    ctx.restore()
  }
}

// ===========================================================================
// D — 安全
// ===========================================================================
{
  let state = Object.assign({}, STATE_MULTI, {
    data: Object.assign({}, STATE_MULTI.data, {
      accessToken: SENTINEL,
      refreshToken: SENTINEL,
      refresh_token: SENTINEL,
      idToken: SENTINEL,
      accounts: [
        Object.assign({}, ACCOUNTS_MULTI[0], { maskedId: SENTINEL, email: 'shangsilcom@gmail.com' }),
        ACCOUNTS_MULTI[1],
      ],
    }),
  })
  const selectUrl = withId(ROUTES.select, 'acc-2')
  const logoutUrl = withId(ROUTES.logout, 'acc-2')
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: () => okJson(state),
    [selectUrl]: () => { state = STATE_ACC2; return okJson({ ok: true }) },
    [ROUTES.login]: LOGIN_START,
    [ROUTES.status]: { ok: true, data: { status: 'pending' } },
    [ROUTES.cancel]: { ok: true },
    [logoutUrl]: () => { state = STATE_ONE; return okJson({ ok: true }) },
  })

  let tree = await ctx.settle()
  check('D1  上游附带的 token / maskedId 一律不上屏（文本与属性都扫）',
    textAll(tree).indexOf(SENTINEL) === -1
    && attrTexts(tree).join('\u0001').indexOf(SENTINEL) === -1,
    textAll(tree).slice(0, 200))

  byAttr(tree, 'data-codex-account-radio', 'acc-2').props.onChange()
  tree = await ctx.settle()
  byAttr(tree, 'data-codex-account-relogin', 'acc-2').props.onClick()
  tree = await settleDeep(ctx, 8)
  byAttr(tree, 'data-codex-account-cancel', '1').props.onClick()
  tree = await settleDeep(ctx, 6)
  byAttr(tree, 'data-codex-account-logout', 'acc-2').props.onClick()
  tree = await settleDeep(ctx, 6)

  const forbidden = ctx.calls.filter((c) => {
    const init = c.init || {}
    if (init.body !== undefined) return true
    if (init.headers === undefined || init.headers === null) return false
    return Object.keys(init.headers).some((k) => k.toLowerCase() !== 'accept')
  })
  check('D2a 每条请求都**无 body / 只带 accept**（绝不回显或上送凭据）',
    forbidden.length === 0, forbidden.map((c) => [c.url, c.init]))

  check('D2b 所有请求带 cache:no-store + credentials:same-origin（登录态不复用 HTTP 缓存）',
    ctx.calls.length > 0 && ctx.calls.every((c) => c.init !== null
      && c.init.cache === 'no-store' && c.init.credentials === 'same-origin'))

  check('D2c 方法：state/status 是 GET，login/select/logout/cancel 是 POST',
    ctx.calls.every((c) => {
      const isPost = c.url === ROUTES.login || c.url === ROUTES.status ? false : true
      if (c.url === ROUTES.state || c.url === ROUTES.status) return c.init.method === undefined
      if (c.url.indexOf(ROUTES.login) === 0 || c.url.indexOf(ROUTES.select) === 0
        || c.url.indexOf(ROUTES.logout) === 0) return c.init.method === 'POST'
      return c.init.method === undefined || isPost
    }), ctx.calls.map((c) => [c.url, c.init && c.init.method]))

  check('D2d select/logout 的 id 走 query（不出现在 body，也不带其它字段）',
    ctx.calls.some((c) => c.url === selectUrl)
    && ctx.calls.some((c) => c.url === logoutUrl)
    && ctx.calls.every((c) => c.init.body === undefined))
  ctx.restore()
}

{
  // D3：坏记录（incompatible）⇒ 「无法识别」+ 三个恢复入口
  const ctx = mountBlock({ writable: true }, { [ROUTES.state]: STATE_BAD_RECORD, [ROUTES.login]: LOGIN_START })
  const tree = await ctx.settle()
  check('D3a 坏记录：unknown 态 + 「登录记录无法识别」固定文案（不冒充未登录）',
    tree.props['data-codex-account-block'] === 'unknown'
    && byAttr(tree, 'data-codex-account-unknown-reason', 'incompatible') !== undefined
    && attrText(tree, 'data-codex-account-unavailable', '1').indexOf('登录记录无法识别') !== -1
    && attrText(tree, 'data-codex-account-unavailable', '1').indexOf('退出账号清除后再登录') !== -1
    && byAttr(tree, 'data-codex-account-signed-out', '1') === undefined,
    textAll(tree).slice(0, 240))
  check('D3b 坏记录的安全恢复入口：重试 + 重新登录 + 退出账号（清除坏记录）',
    byAttr(tree, 'data-codex-account-retry', '1') !== undefined
    && byAttr(tree, 'data-codex-account-relogin', '1') !== undefined
    && byAttr(tree, 'data-codex-account-logout', '1') !== undefined)
  byAttr(tree, 'data-codex-account-logout', '1').props.onClick()
  await pump(ctx, 4)
  check('D3c 坏记录时「退出账号」走无 id 的整体退出（保留老 Host 语义）',
    ctx.countOf(ROUTES.logout) === 1, urlsOf(ctx))
  ctx.restore()
}

{
  // D4：no-credentials ⇒ 只给重试（登录/退出都不可能出现）
  const ctx = mountBlock({ writable: true }, { [ROUTES.state]: STATE_NO_LOGIN })
  const tree = await ctx.settle()
  check('D4a 无凭据服务：unknown + 「账号登录服务暂不可用」，且不是「未登录」',
    tree.props['data-codex-account-block'] === 'unknown'
    && byAttr(tree, 'data-codex-account-unknown-reason', 'no-credentials') !== undefined
    && attrText(tree, 'data-codex-account-unavailable', '1').indexOf('暂不可用') !== -1
    && byAttr(tree, 'data-codex-account-signed-out', '1') === undefined)
  check('D4b 无凭据服务：只有重试，没有必然失败的登录/退出按钮',
    byAttr(tree, 'data-codex-account-retry', '1') !== undefined
    && byAttr(tree, 'data-codex-account-relogin', '1') === undefined
    && byAttr(tree, 'data-codex-account-logout', '1') === undefined)
  ctx.restore()
}

{
  // D5：信封不可信 ⇒ unknown + 重试；坏行被丢弃
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: {
      ok: true,
      data: { configured: true, canLogin: true, activeAccountId: 'good-1', accounts: [
        { id: 'good-1', label: 'good@example.com', planType: 'plus', active: true },
        { id: 'bad id', label: 'bad@example.com' },
        { id: '', label: 'empty@example.com' },
        { label: 'noid@example.com' },
      ] },
    },
  })
  const tree = await ctx.settle()
  const rows = allByAttr(tree, 'data-codex-account-row')
  check('D5a 不合规账户 id 整行丢弃（不渲染、也不会拼进 select/logout）',
    rows.length === 1 && rows[0].props['data-codex-account-row'] === 'good-1'
    && textAll(tree).indexOf('bad@example.com') === -1,
    rows.map((r) => r.props['data-codex-account-row']))
  ctx.restore()

  const ctxBad = mountBlock({ writable: true }, { [ROUTES.state]: { ok: false, error: 'E_X' } })
  const treeBad = await ctxBad.settle()
  check('D5b 信封不可信：unknown + 重试入口，不崩溃、不回显错误码',
    treeBad.props['data-codex-account-block'] === 'unknown'
    && byAttr(treeBad, 'data-codex-account-retry', '1') !== undefined
    && textAll(treeBad).indexOf('E_X') === -1)
  ctxBad.restore()
}

{
  // D6：敌意登录码 / 登录链接
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: STATE_SIGNED_OUT,
    [ROUTES.login]: {
      ok: true,
      data: { userCode: '<script>alert(1)</script>', verificationUri: 'https://auth.openai.com/device' },
    },
    [ROUTES.status]: { ok: true, data: { status: 'pending' } },
  })
  let tree = await ctx.settle()
  byAttr(tree, 'data-codex-account-add', '1').props.onClick()
  tree = await settleDeep(ctx, 6)
  check('D6a 敌意 user_code 不渲染（但合规登录链接仍可用）',
    byAttr(tree, 'data-codex-account-user-code', '1') === undefined
    && textAll(tree).indexOf('<script>') === -1
    && byAttr(tree, 'data-codex-account-open', '1') !== undefined)
  ctx.restore()

  const ctxUri = mountBlock({ writable: true }, {
    [ROUTES.state]: STATE_SIGNED_OUT,
    [ROUTES.login]: {
      ok: true,
      data: { userCode: 'ABCD-1234', verificationUri: 'https://evil.example/device' },
    },
    [ROUTES.status]: { ok: true, data: { status: 'pending' } },
  })
  tree = await ctxUri.settle()
  byAttr(tree, 'data-codex-account-add', '1').props.onClick()
  tree = await settleDeep(ctxUri, 6)
  check('D6b 非 auth.openai.com 的登录链接不渲染、不给「打开」按钮',
    byAttr(tree, 'data-codex-account-open', '1') === undefined
    && byAttr(tree, 'data-codex-account-uri', '1') === undefined
    && textAll(tree).indexOf('evil.example') === -1
    && byAttr(tree, 'data-codex-account-user-code', '1') !== undefined)
  ctxUri.restore()
}

// ===========================================================================
// E — 生命周期
// ===========================================================================
{
  // E1：pending 会持续轮询（节拍由 2 秒定时器驱动，这里压到 0ms）
  let n = 0
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: STATE_SIGNED_OUT,
    [ROUTES.login]: LOGIN_START,
    [ROUTES.status]: (i) => {
      n = i
      if (i >= 4) return okJson({ ok: true, data: { status: 'failed' } })
      return okJson({ ok: true, data: { status: 'pending' } })
    },
  })
  let tree = await ctx.settle()
  byAttr(tree, 'data-codex-account-add', '1').props.onClick()
  tree = await settleDeep(ctx, 40)
  check('E1a pending 期间按拍轮询（≥3 次），到终态即停',
    ctx.countOf(ROUTES.status) === n && n >= 3 && n <= 4, { statusCalls: ctx.countOf(ROUTES.status), n })
  check('E1b failed ⇒ 固定失败文案 + 回到 Host 的真实 state（未登录）',
    tree.props['data-codex-account-state'] === 'signed-out'
    && attrText(tree, 'data-codex-account-notice', '1') === '登录失败，请稍后重试。'
    && byAttr(tree, 'data-codex-account-add', '1') !== undefined)
  ctx.restore()
}

{
  // E2：expired ⇒ 过期文案 + 设备码消失
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: STATE_SIGNED_OUT,
    [ROUTES.login]: LOGIN_START,
    [ROUTES.status]: { ok: true, data: { status: 'expired' } },
  })
  let tree = await ctx.settle()
  byAttr(tree, 'data-codex-account-add', '1').props.onClick()
  tree = await settleDeep(ctx, 10)
  check('E2  expired ⇒ 「登录代码已过期」+ 设备码不再显示',
    attrText(tree, 'data-codex-account-notice', '1') === '登录代码已过期，请重新登录。'
    && byAttr(tree, 'data-codex-account-user-code', '1') === undefined
    && tree.props['data-codex-account-state'] === 'signed-out')
  ctx.restore()
}

{
  // E3：授权失败不清掉既有登录态（已登录用户重登失败仍显示原账户）
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: STATE_MULTI,
    [ROUTES.login]: LOGIN_START,
    [ROUTES.status]: { ok: true, data: { status: 'failed' } },
  })
  let tree = await ctx.settle()
  byAttr(tree, 'data-codex-account-relogin', 'acc-1').props.onClick()
  tree = await settleDeep(ctx, 10)
  check('E3  已登录用户重登失败：不变成未登录，仍显示原账户 + 失败文案',
    tree.props['data-codex-account-state'] === 'signed-in'
    && byAttr(tree, 'data-codex-account-row', 'acc-1') !== undefined
    && attrText(tree, 'data-codex-account-notice', '1') === '登录失败，请稍后重试。')
  ctx.restore()
}

{
  // E4：卸载后不再请求、不再 setState
  const ctx = mountBlock({ writable: true }, {
    [ROUTES.state]: STATE_SIGNED_OUT,
    [ROUTES.login]: LOGIN_START,
    [ROUTES.status]: { ok: true, data: { status: 'pending' } },
  })
  let tree = await ctx.settle()
  byAttr(tree, 'data-codex-account-add', '1').props.onClick()
  tree = await settleDeep(ctx, 6)
  const beforeStatus = ctx.countOf(ROUTES.status)
  const beforeState = ctx.countOf(ROUTES.state)
  ctx.unmount()
  await pump(ctx, 8)
  check('E4a 卸载后停止轮询：status / state 调用数都不再增长',
    ctx.countOf(ROUTES.status) === beforeStatus && ctx.countOf(ROUTES.state) === beforeState,
    { beforeStatus, beforeState, afterStatus: ctx.countOf(ROUTES.status), afterState: ctx.countOf(ROUTES.state) })
  check('E4b 轮询确实发生过（不是「本来就没请求」）', beforeStatus >= 1)
  ctx.restore()
}

// ===========================================================================
// F — 跨端接线：Host 的 Codex wire（单一来源）不得被「已保存来源」过滤掉
// ===========================================================================
/**
 * [2026-11-23] 这一组是为一个**真实集成缺口**写的守门用例：
 * `plans/codex.js` 现在对每条 Codex wire 恒写 `codexSource:'account'`（来源分派已退场），
 * 而老配置里的 `codexSource` 可能仍是 `connect` / `subscription`。客户端若继续按
 * 「wire 来源 ≠ 已保存来源」丢行，**唯一的 Codex 行会被整个丢掉**（胶囊/详情里没有 Codex）。
 * 所以这里从胶囊（真实 Badge 组件）反证：三种组合都必须看得见 Codex。
 */
const CODEX_WIRE_BASE = {
  id: 'codex',
  name: 'OpenAI Codex',
  rollingUsage: { status: null, percent: 33, resetsAt: null, resetInSec: null },
  weeklyUsage: { status: null, percent: 72, resetsAt: null, resetInSec: null },
}
const BADGE_PAYLOAD = (codexSource) => ({
  ok: true,
  data: {
    plans: [
      Object.assign({}, CODEX_WIRE_BASE, { codexSource }),
      { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
    ],
  },
})
{
  // 胶囊用真实的 30 秒轮询定时器：这里临时恢复真 setTimeout，避免 0ms 自续把进程挂住。
  const fastTimeout = globalThis.setTimeout
  globalThis.setTimeout = realSetTimeout

  async function renderBadge (payload, cfgSource) {
    const runtime = createRuntime()
    const { form } = makeForm(Object.assign({}, BASE_CFG, { codexSource: cfgSource }))
    const client = loadClient(runtime, { form, payload })
    runtime.mount(client.Badge, { wide: true, configForm: form })
    const tree = await runtime.settle({ wide: true, configForm: form })
    const pill = tree.props.children[0]
    const pillText = textAll(pill)
    pill.props.onClick()
    const opened = await runtime.settle({ wide: true, configForm: form })
    const panelText = textAll(opened.props.children[1])
    // 卸载：清掉胶囊的定时器与全局监听。
    runtime.mount(function EmptyAfterBadge () { return null }, {})
    client.restore()
    return { pillText, panelText }
  }

  const hostAccount = await renderBadge(BADGE_PAYLOAD('account'), 'connect')
  check('F1  Host 恒写 codexSource:"account" + 老配置 connect：胶囊仍显示 Codex（不再按来源丢行）',
    hostAccount.pillText.indexOf('OpenAI Codex') !== -1
    && hostAccount.pillText.indexOf('33%') !== -1
    && hostAccount.pillText.indexOf('72%') !== -1,
    hostAccount.pillText)
  check('F2  详情面板同样显示 Codex 的两个窗口（剩余百分比口径不变）',
    hostAccount.panelText.indexOf('OpenAI Codex') !== -1
    && hostAccount.panelText.indexOf('5小时') !== -1
    && hostAccount.panelText.indexOf('周限') !== -1,
    hostAccount.panelText.slice(0, 300))

  const legacyWire = await renderBadge(BADGE_PAYLOAD('connect'), 'connect')
  check('F3  旧 Host 的 wire（codexSource:"connect"）也照常显示（兼容未升级的 Host）',
    legacyWire.pillText.indexOf('OpenAI Codex') !== -1
    && legacyWire.pillText.indexOf('33%') !== -1, legacyWire.pillText)

  const oldSubConfig = await renderBadge(BADGE_PAYLOAD('account'), 'subscription')
  check('F4  老配置里残留 codexSource:"subscription" 也不挡住 Codex 行',
    oldSubConfig.pillText.indexOf('OpenAI Codex') !== -1
    && oldSubConfig.pillText.indexOf('33%') !== -1, oldSubConfig.pillText)

  /**
   * [2026-11-23 多账户] F5：账户身份进入逐条身份。
   *
   * 真实缺口：Host 的 wire 身份 `acct=…` 已随切换立即变化，但客户端逐条身份
   * （`configIdentityMap`）此前只拼「配置来源」，于是切换账户后 Host 的旧 wire /
   * 旧 carry 仍被当成同一身份，胶囊最多把上一个账户的百分比保留 30 秒。
   */
  {
    const runtime = createRuntime()
    const { form } = makeForm(BASE_CFG)
    const client = loadClient(runtime, { form, payload: BADGE_PAYLOAD('account') })
    const acct = client.module.codexAccount
    const src = client.module.codexSource
    const cfg = Object.assign({}, BASE_CFG) // 无 codexSource ⇒ 归一为 connect
    const base = src.identity(cfg)

    const startIdentity = acct.uiIdentity()
    const mapUnknown = src.identityMap(cfg).codex
    acct.parseState(STATE_MULTI)
    const idAcc1 = acct.uiIdentity()
    const mapAcc1 = src.identityMap(cfg).codex
    acct.parseState(STATE_ACC2)
    const idAcc2 = acct.uiIdentity()
    const mapAcc2 = src.identityMap(cfg).codex
    acct.parseState(STATE_SIGNED_OUT)
    const mapOut = src.identityMap(cfg).codex

    check('F5a 逐条身份 = 来源身份 + 账户身份（读 state 前不宣称账户，读到后追加 acct 片段）',
      startIdentity === 'unknown' && mapUnknown === base
      && mapAcc1 === base + '\u0003acct\u0002' + idAcc1 && idAcc1 !== idAcc2,
      { startIdentity, base, mapUnknown, mapAcc1, idAcc1 })
    check('F5b 切换账户 / 退出后逐条身份必变（旧值因此可被 prune），且不含明文 id / token',
      mapAcc1 !== mapAcc2 && mapAcc2 !== mapOut && mapOut !== mapAcc1
      && mapOut.indexOf('\u0003acct\u0002none') !== -1
      && [mapAcc1, mapAcc2, mapOut].every((s) => s.indexOf('acc-1') === -1
        && s.indexOf('acc-2') === -1 && s.indexOf(SENTINEL) === -1),
      { mapAcc1, mapAcc2, mapOut })
    client.restore()
  }

  /**
   * F6：切换账户后旧值被 prune（不再靠 30 秒轮询自然覆盖）。
   *
   * 夹具：第一次 `/api/plan-usage` 成功（33%），之后的重取一律失败。
   *   - 账户身份真的变了（cred-a → cred-b）+ 真实失效入口 bump ⇒ effect 重跑，
   *     applied.entries 与当前身份不等 ⇒ 旧值被 prune，失败重取也不会把它当 stale 顶回来；
   *   - 对照：身份没变（同一账户）时同样失败重取，旧值按 stale 保留 —— 证明 prune 是
   *     「身份驱动」而不是「一 bump 就清空」。
   */
  async function runAccountIdentityPrune (switchAccount) {
    const API = '/api/plan-usage'
    const runtime = createRuntime()
    const { form } = makeForm(BASE_CFG)
    const client = loadClient(runtime, { form, payload: BADGE_PAYLOAD('account') })
    const fake = makeFetch({
      [API]: (index) => {
        if (index >= 2) throw new Error('refetch failed')
        return okJson(BADGE_PAYLOAD('account'))
      },
    })
    globalThis.fetch = fake.fake
    const props = { wide: true, configForm: form }
    const acct = client.module.codexAccount
    // 胶囊第一轮成功的数据属于 cred-a（设置页此时读到的是 cred-a）。
    acct.parseState(STATE_MULTI)
    runtime.mount(client.Badge, props)
    let tree = await runtime.settle(props)
    const before = textAll(tree)
    // 账户切换（正常由设置页的 select 成功 → 重新 GET state 完成）。
    acct.parseState(switchAccount === true ? STATE_ACC2 : STATE_MULTI)
    // 「现有等价失效入口」：与 select / authorized / logout 成功后同一条 bump。
    client.module.invalidateCustomChannel('codex')
    // mock 的 useSyncExternalStore 不订阅外部 store，手动渲染一帧让 effect 看到新代次。
    runtime.renderOnce(props)
    tree = await runtime.settle(props)
    const after = textAll(tree)
    const requests = fake.countOf(API)
    runtime.mount(function EmptyAfterPrune () { return null }, {})
    client.restore()
    return { before, after, requests }
  }

  const switchedAccount = await runAccountIdentityPrune(true)
  check('F6a 切换账户后旧值被 prune：重取失败也不会沿用上一个账户的 33%',
    switchedAccount.before.indexOf('33%') !== -1 && switchedAccount.after.indexOf('33%') === -1,
    switchedAccount)
  check('F6b 身份变化 + 失效入口让胶囊立即重取（第二次 /api/plan-usage，不等 30 秒）',
    switchedAccount.requests === 2, switchedAccount.requests)

  const sameAccount = await runAccountIdentityPrune(false)
  check('F6c 对照：身份没变时同一次失败重取仍按 stale 保留旧值（不会误 prune）',
    sameAccount.before.indexOf('33%') !== -1 && sameAccount.after.indexOf('33%') !== -1,
    sameAccount)

  globalThis.setTimeout = fastTimeout
}

console.log('')
console.log((pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
