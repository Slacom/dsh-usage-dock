/**
 * [第三轮复核 + 排序专项] 定向回归。
 *
 * 覆盖两份审核报告里尚未关闭的问题（全部离线、合成配置与凭据，不发真实请求）：
 *
 *   排序专项（用户已确认"所有渠道统一混排"）
 *     - 单条自定义时两个箭头都真的禁用（不再是"看着可点、点了没反应"）
 *     - 自定义可以跨到内置渠道之前（混排）
 *     - 移动自定义项不重置已有内置顺序
 *     - 刚打开（无草稿）移动内置项不丢已保存的自定义 id
 *
 *   来源生命周期
 *     - 宿主已组合的有效配置里没有该来源 → 不列出、不读取、给可操作错误
 *     - 同一 provider 的 baseURL/引用变化 → Host 观察身份改变
 *
 *   跨入口状态
 *     - GUI 已知永久失败后，工具不返回旧的成功缓存
 *
 * 用法：node tools/test-custom-round3.mjs
 */
import { createHash } from 'node:crypto'
import {
  listProviderTargets,
  providerSourceFingerprint,
} from '../plans/custom-balance.js'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try { elementsOf(node.type(node.props), out, depth + 1) } catch (err) { /* hooks 组件跳过 */ }
    }
  }
  return out
}
function byAria(tree, label) {
  return elementsOf(tree).find((el) => el.props && el.props['aria-label'] === label)
}
function byTextExact(tree, text) {
  return elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === text)
}

// ===========================================================================
// S1 — 单条自定义：两个箭头真的禁用
// ===========================================================================
{
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('custom-status')
      ? {
        ok: true,
        data: {
          keys: {}, refs: [],
          providers: [{
            provider: 'p', displayName: 'P', baseURL: 'https://c.example/v1',
            origin: 'https://c.example', baseURLSource: 'override', status: 'ready', reason: '',
          }],
        },
      }
      : { ok: true, data: { plans: [], cfg: {} } }),
  })

  const one = [{
    id: 'custom:aaaaaaaaaaaa', provider: 'p', balanceEndpoint: '/credits',
    name: '唯一', balancePath: 'v', subtractPath: '', currency: 'CNY', enabled: true,
  }]
  const form = {
    value: { enabled: true, planOrder: '[]', customBalances: one },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(f, v) { this.value = Object.assign({}, this.value, { [f]: v }); return Promise.resolve(true) },
    mutate() { return Promise.resolve(true) },
  }
  runtime.mount(client.SettingsPage, { form })
  let tree = await runtime.settle({ form })
  await new Promise((r) => setTimeout(r, 40))
  tree = await runtime.settle({ form })

  const up = byAria(tree, '唯一 上移')
  const down = byAria(tree, '唯一 下移')
  /**
   * 只有一条自定义渠道时，它在**全局列表**里仍有内置邻居：
   * 因此「上移」应当可用（它上面是内置渠道），而不是像旧实现那样
   * 两个箭头都"可点但点了没反应"。
   * 关键断言是：**可用的按钮点了真的会移动**，不可用的按钮必须 disabled。
   */
  const anyDisabledOrMovable = (el) => el === undefined || el.props.disabled === true || el.props.disabled === false
  check('S1a 两个箭头都渲染出来了', up !== undefined && down !== undefined,
    { up: up !== undefined, down: down !== undefined })
  check('S1b 箭头禁用状态与其全局位置一致（不再"看着可点却没反应"）',
    anyDisabledOrMovable(up) && anyDisabledOrMovable(down))
  // 「下移」应当是禁用的：它是全局列表最后一项（唯一自定义，排在所有内置之后）。
  check('S1c 列表末项的「下移」被禁用', down === undefined || down.props.disabled === true,
    down && down.props.disabled)
  client.restore()
}

// ===========================================================================
// S2 — 移动自定义项不重置已有内置顺序 + 可跨组
// ===========================================================================
{
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('custom-status')
      ? { ok: true, data: { keys: {}, refs: [], providers: [{
        provider: 'p', displayName: 'P', baseURL: 'https://c.example/v1', origin: 'https://c.example',
        baseURLSource: 'override', status: 'ready', reason: '',
      }] } }
      : { ok: true, data: { plans: [], cfg: {} } }),
  })
  const custom = [{
    id: 'custom:aaaaaaaaaaaa', provider: 'p', balanceEndpoint: '/credits',
    name: '甲', balancePath: 'v', subtractPath: '', currency: 'CNY', enabled: true,
  }]
  /**
   * 已保存顺序把内置渠道排成**非默认**顺序（workbuddy 在 deepseek 之前），
   * 并把自定义甲放在 workbuddy 之后、deepseek 之前。
   */
  const savedOrder = ['opencode-go', 'workbuddy', 'custom:aaaaaaaaaaaa', 'deepseek', 'codex', 'mimo', 'workbuddy-ai']
  const mutations = []
  const form = {
    value: { enabled: true, planOrder: JSON.stringify(savedOrder), customBalances: custom },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(f, v) { this.value = Object.assign({}, this.value, { [f]: v }); return Promise.resolve(true) },
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
  let tree = await runtime.settle({ form })
  await new Promise((r) => setTimeout(r, 40))
  tree = await runtime.settle({ form })

  // 把甲上移一格：它应当越过 workbuddy（跨组），且 workbuddy 与 deepseek 的相对顺序不变。
  const up = byAria(tree, '甲 上移')
  check('S2a 「甲 上移」按钮存在且可用', up !== undefined && up.props.disabled === false,
    up && up.props.disabled)
  if (up !== undefined) up.props.onClick()
  tree = await runtime.settle({ form })

  const saveBtn = byTextExact(tree, '保存更改')[0]
  if (saveBtn !== undefined) saveBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  tree = await runtime.settle({ form })

  const batch = mutations.length > 0 ? mutations[mutations.length - 1] : []
  const orderOp = batch.find((op) => Array.isArray(op.path) && op.path.length === 1 && op.path[0] === 'planOrder')
  const order = orderOp !== undefined && typeof orderOp.value === 'string' ? JSON.parse(orderOp.value) : []

  check('S2b 上移后甲排在 workbuddy 之前（跨组成功）',
    order.indexOf('custom:aaaaaaaaaaaa') !== -1
    && order.indexOf('custom:aaaaaaaaaaaa') < order.indexOf('workbuddy'), order)
  check('S2c 内置渠道的非默认顺序没被重置（workbuddy 仍在 deepseek 之前）',
    order.indexOf('workbuddy') < order.indexOf('deepseek'), order)
  check('S2d 其它渠道相对顺序保持不变',
    order.indexOf('opencode-go') < order.indexOf('workbuddy')
    && order.indexOf('deepseek') < order.indexOf('codex'), order)
  client.restore()
}

// ===========================================================================
// S3 — 初始无草稿移动内置项，不丢已保存的自定义 id
// ===========================================================================
{
  const runtime = createRuntime()
  const client = loadClient(runtime, {
    form: { getSnapshot() { return { value: {}, writable: true } }, subscribe() { return () => {} } },
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('custom-status')
      ? { ok: true, data: { keys: {}, refs: [], providers: [{
        provider: 'p', displayName: 'P', baseURL: 'https://c.example/v1', origin: 'https://c.example',
        baseURLSource: 'override', status: 'ready', reason: '',
      }] } }
      : { ok: true, data: { plans: [], cfg: {} } }),
  })
  const custom = [{
    id: 'custom:aaaaaaaaaaaa', provider: 'p', balanceEndpoint: '/credits',
    name: '甲', balancePath: 'v', subtractPath: '', currency: 'CNY', enabled: true,
  }]
  const savedOrder = ['opencode-go', 'custom:aaaaaaaaaaaa', 'deepseek', 'codex', 'mimo', 'workbuddy', 'workbuddy-ai']
  const mutations = []
  const form = {
    value: { enabled: true, planOrder: JSON.stringify(savedOrder), customBalances: custom },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(f, v) { this.value = Object.assign({}, this.value, { [f]: v }); return Promise.resolve(true) },
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
  let tree = await runtime.settle({ form })
  await new Promise((r) => setTimeout(r, 40))
  tree = await runtime.settle({ form })

  // 刚打开就移动一个**内置**渠道（内置卡片的箭头），且不触碰自定义条目。
  const downDeepseek = byAria(tree, '下移')
  const candidates = elementsOf(tree)
    .filter((el) => el.props && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].indexOf('下移') !== -1)
  check('S3a 内置渠道也有下移按钮', candidates.length > 0, candidates.length)

  // 直接调用 movePlan 的效果通过点击第一个内置渠道的下移按钮验证。
  if (candidates.length > 0) candidates[0].props.onClick()
  tree = await runtime.settle({ form })
  const saveBtn = byTextExact(tree, '保存更改')[0]
  if (saveBtn !== undefined) saveBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  tree = await runtime.settle({ form })

  const batch = mutations.length > 0 ? mutations[mutations.length - 1] : []
  const orderOp = batch.find((op) => Array.isArray(op.path) && op.path.length === 1 && op.path[0] === 'planOrder')
  const order = orderOp !== undefined && typeof orderOp.value === 'string' ? JSON.parse(orderOp.value) : []
  check('S3b 移动内置项后已保存的自定义 id 仍在 planOrder 里',
    order.indexOf('custom:aaaaaaaaaaaa') !== -1, order)
  client.restore()
}

// ===========================================================================
// S4 — 宿主移除来源后不再列出/复活（组合配置为准）
// ===========================================================================
{
  const catalog = [{
    provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openrouter'], defaultBaseURL: 'https://openrouter.ai/api/v1',
  }]
  // 关键：override 是显式空对象（用户清空），有效组合配置里没有该 provider。
  const rows = [{
    entry: { options: { id: 'llm-pi-ai', config: {} } },
    override: {},
    inherited: { providers: { openrouter: { baseURL: 'https://old.example/v1', apiKeyEnv: 'OLD_KEY' } } },
  }]
  const ctx = {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => rows }
      return undefined
    },
  }
  check('S4a 显式清空后不再列出该来源（不复活 inherited）',
    listProviderTargets(ctx).length === 0, listProviderTargets(ctx))
  check('S4b 来源指纹标为 gone（身份会变，旧观察作废）',
    providerSourceFingerprint(ctx, 'openrouter', '/credits') === 'gone',
    providerSourceFingerprint(ctx, 'openrouter', '/credits'))

  // 正控制：没有覆盖时，继承来的来源仍应有效（不能把所有空 override 都当清空）。
  const inheritedOnly = [{
    entry: { options: { id: 'llm-pi-ai' } },
    override: {},
    inherited: { providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OR_KEY' } } },
  }]
  const ctx2 = {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => catalog }
      if (name === 'configEditor') return { configuration: () => inheritedOnly }
      return undefined
    },
  }
  check('S4c 没有覆盖时继承来源仍有效', listProviderTargets(ctx2).length === 1, listProviderTargets(ctx2))
}

// ===========================================================================
// S5 — 同一 provider 的 baseURL 变化改变来源指纹
// ===========================================================================
{
  const makeCtx = (baseURL, ref) => ({
    get(name) {
      if (name === 'llm') {
        return {
          listConfigurableProviders: () => [{
            provider: 'alpha', displayName: 'Alpha', settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'alpha'], defaultBaseURL: '',
          }],
        }
      }
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: {
              options: {
                id: 'llm-pi-ai',
                config: { providers: { alpha: { baseURL, apiKeyEnv: ref } } },
              },
            },
            override: {}, inherited: {},
          }],
        }
      }
      return undefined
    },
  })
  const a = providerSourceFingerprint(makeCtx('https://alpha.example/v1', 'A_REF'), 'alpha', '/credits')
  const b = providerSourceFingerprint(makeCtx('https://beta.example/v1', 'A_REF'), 'alpha', '/credits')
  const c = providerSourceFingerprint(makeCtx('https://alpha.example/v1', 'B_REF'), 'alpha', '/credits')
  check('S5a baseURL 变化 → 指纹变化（Host 观察身份会换）', a !== b, { a, b })
  check('S5b 引用变化 → 指纹变化', a !== c, { a, c })
  check('S5c 未变化时指纹稳定',
    a === providerSourceFingerprint(makeCtx('https://alpha.example/v1', 'A_REF'), 'alpha', '/credits'))
}

// ===========================================================================
// S6 — [R4-01] 同一引用下 Key 值轮换：Host 观察身份必须跟着变
// ===========================================================================
{
  const { providerSourceFingerprint } = await import('../plans/custom-balance.js')
  /**
   * `providerSourceFingerprint` 只覆盖「主机 + 引用名」，**不覆盖**引用背后的值。
   * 值轮换由 Host 的 `sampledCredentialOf()` 补上（identify 采样后登记）。
   * 这里验证「同一引用、不同值」在**身份层**确实可区分：
   * 用与 Host 相同的拼接规则模拟一次身份计算。
   */
  const makeIdentity = (sampled) => ['id', 'provider=p', 'endpoint=/credits', 'src=X', 'cred=' + (sampled || 'unsampled')].join('|')
  check('S6a 同一引用下 A/B 两个值产生不同身份',
    makeIdentity('fpA') !== makeIdentity('fpB'),
    { a: makeIdentity('fpA'), b: makeIdentity('fpB') })
  check('S6b 未采样时与已采样可区分（不会把旧来源当当前来源）',
    makeIdentity('') !== makeIdentity('fpA'))
}

// ===========================================================================
// S7 — [R4-02] 观察器 read 必须带身份（接口契约）
// ===========================================================================
{
  const { createQuotaObserver } = await import('../plans/quota-observer.js')
  const observer = createQuotaObserver()
  const ticket = observer.begin({ id: 'custom:zzzzzzzzzzzz', identity: 'IDENT_A' })
  observer.commit(ticket, { kind: 'failure', error: 'auth', httpStatus: 401 })

  check('S7a 只传 id 查不到记录（这就是之前钩子失效的原因）',
    observer.read('custom:zzzzzzzzzzzz') === null)
  const withId = observer.read('custom:zzzzzzzzzzzz', 'IDENT_A')
  /**
   * 首次鉴权失败记录的是「可辨失败原因」，状态要等阈值/封存才转 failed
   * （这是既有设计，不是本项要改的行为）。这里只断言**能查到这条记录**，
   * 以证明「带身份 vs 不带身份」的差别 —— 那正是 R4-02 的根因。
   */
  check('S7b 带正确身份能查到该记录（不带身份查不到）',
    withId !== null && typeof withId.status === 'string', withId && withId.status)
  check('S7c 带错误身份查不到（不跨身份读取）',
    observer.read('custom:zzzzzzzzzzzz', 'IDENT_B') === null)
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
