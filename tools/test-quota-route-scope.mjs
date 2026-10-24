/**
 * [整改验证 / A05、A06、A11、A12] 路由观察在**真实 Cordis scope 语义**下的行为。
 *
 * 为什么单独一个文件：这几条缺陷只有在使用真实 `EventsService` 派发 + 真实
 * `dsh-scope` 过滤时才暴露（scope 准入允许**祖先监听收到后代事件**）。
 * 用简化 fake 永远测不出来 —— 这正是原实现漏掉 `payload.agent === subject` 的原因。
 *
 * 依赖已提取的宿主源码（`.diagnostics/routing-audit-20261019`）。
 * 该目录缺失时整个文件 SKIP（不伪装通过）。
 *
 * 用法：node tools/test-quota-route-scope.mjs
 */
import fs from 'node:fs'
import { createRouteObserver } from '../plans/quota-route.js'
import { buildQuotaView } from '../plans/quota-view.js'
import { resolveRoute } from '../plans/quota-prompt.js'

const prefix = '.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/'
const eventPath = prefix + 'cordis/lib/index.js'
const scopePath = prefix + 'dsh-scope/lib/index.js'

if (!fs.existsSync(eventPath) || !fs.existsSync(scopePath)) {
  console.log('SKIP：缺少宿主提取源码（' + prefix + '），无法验证真实 scope 语义')
  process.exit(0)
}

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

// 真实 EventsService + 真实 scope 过滤（仅 fiber 生命周期用替身）。
const Context = { filter: Symbol('filter') }
const eventSource = fs.readFileSync(eventPath, 'utf8')
const start = eventSource.indexOf('var EventsService = class {')
const end = eventSource.indexOf('\n//#endregion', start)
const Events = new Function('Context', 'isBailed', eventSource.slice(start, end) + '\nreturn EventsService;')(
  Context, (value) => value !== null && value !== false && value !== undefined,
)
const scopeSource = fs.readFileSync(scopePath, 'utf8')
const scopeStart = scopeSource.indexOf('const kScope =')
const scopeEnd = scopeSource.lastIndexOf('\nexport ')
const scope = new Function('Context', scopeSource.slice(scopeStart, scopeEnd)
  + '\nreturn {scopeTarget,bindScopeParent,tag:(ctx,key)=>{ctx[kScope]=key;return ctx}};')(Context)

/**
 * 构造「真实 scope 语义」的运行环境。
 *
 * 用 `Object.create(Events.prototype)` 而不是 `new Events()`：真实构造器依赖
 * Cordis 内部的 `symbols`/`defineProperty` 注入，这里只借用它的派发与过滤逻辑。
 */
function busFor(agents) {
  const bus = Object.create(Events.prototype)
  bus._hooks = {}
  function context(agent) {
    const owner = {
      fiber: { assertActive() {}, effect(callback) { return callback() } },
      reflect: { bind: (fn) => fn },
    }
    if (agent !== undefined) scope.tag(owner, agent)
    const events = Object.create(bus)
    events.ctx = owner
    return events
  }
  for (const agent of agents) agent.ctx = context(agent)
  const root = context(undefined)
  root.get = (name) => (name === 'agents' ? { list: () => agents } : undefined)
  const request = (agent, seed) => bus.waterfall(
    scope.scopeTarget(agent, agent), 'agent/request',
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(seed),
  )
  return { root, request, bus }
}

const HIGH_WB = { id: 'workbuddy', name: 'WorkBuddy', availability: 'ok', unit: 'credits', balance: 1000 }
const LOW_CODEX = { id: 'codex', name: 'Codex', availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 1 }] }
const cfg = {
  quotaPolicyEnabled: true,
  quotaFocusChannels: JSON.stringify(['codex', 'workbuddy']),
  quotaWarningPercentThreshold: 20,
  quotaClosingPercentThreshold: 10,
  quotaWarningCreditsThreshold: 100,
  quotaClosingCreditsThreshold: 50,
}

function viewOf(observation, channels) {
  return buildQuotaView({
    cfg,
    observation,
    readChannel: (id) => channels[id] || null,
    readObservation: () => ({ status: 'ok', identity: 'i', sampledAt: 1 }),
    pickSmallestWindow: (w) => (Array.isArray(w) && w.length > 0 ? w[0] : null),
    identityOf: () => 'i',
  })
}

// ===========================================================================
// A05 — 合法父子 scope 拓扑下，子请求不得污染父观察
// ===========================================================================
{
  const parent = { id: 'synthetic-parent' }
  const child = { id: 'synthetic-child' }
  const runtime = busFor([parent, child])
  scope.bindScopeParent(child, parent)
  const routes = createRouteObserver({ ctx: runtime.root })
  routes.gate(true)

  await runtime.request(parent, { provider: 'workbuddy', model: 'same-model' })
  const parentBefore = routes.read(parent)
  check('A05a 父请求被正确观察', parentBefore !== null && parentBefore.provider === 'workbuddy', parentBefore)
  const beforeView = viewOf(parentBefore, { workbuddy: HIGH_WB, codex: LOW_CODEX })
  check('A05b 父初始为 normal', beforeView.stage === 'normal', beforeView)

  // 子请求（合法后代 scope）完成 —— 修复前这里会把父观察改写成 codex
  await runtime.request(child, { provider: 'openai-codex', model: 'same-model' })
  const parentAfter = routes.read(parent)
  check('A05c 子请求不污染父观察（父仍是 workbuddy）',
    parentAfter !== null && parentAfter.provider === 'workbuddy', parentAfter)
  const afterView = viewOf(parentAfter, { workbuddy: HIGH_WB, codex: LOW_CODEX })
  check('A05d 父阶段仍为 normal（未被子的低额度带动收尾）',
    afterView.stage === 'normal', afterView)
  check('A05e 子自己也被观察', routes.read(child) !== null
    && routes.read(child).provider === 'openai-codex', routes.read(child))
  routes.dispose()
}

// ===========================================================================
// A05 — 同 step 重试：新尝试覆盖旧观察
// ===========================================================================
{
  const agent = { id: 'retry-agent' }
  const runtime = busFor([agent])
  const routes = createRouteObserver({ ctx: runtime.root })
  routes.gate(true)

  await runtime.request(agent, { provider: 'workbuddy' })
  const first = routes.read(agent)
  check('A05f 首次观察为 workbuddy', first !== null && first.provider === 'workbuddy', first)

  await runtime.request(agent, { provider: 'openai-codex' })
  const second = routes.read(agent)
  check('A05g 重试后观察更新为 codex',
    second !== null && second.provider === 'openai-codex', second)
  routes.dispose()
}

// ===========================================================================
// A06 — 闸门默认闭合：未显式放行时不得发布观察
// ===========================================================================
{
  const agent = { id: 'gated-agent' }
  const runtime = busFor([agent])
  const routes = createRouteObserver({ ctx: runtime.root })
  // 不调用 gate(true)：默认闭合
  check('A06a 默认闸门闭合', routes.isOpen() === false)
  await runtime.request(agent, { provider: 'workbuddy' })
  check('A06b 闸门闭合时不发布观察', routes.read(agent) === null, routes.read(agent))

  // 打开后应正常工作
  routes.gate(true)
  await runtime.request(agent, { provider: 'workbuddy' })
  check('A06c 打开闸门后可观察', routes.read(agent) !== null, routes.read(agent))

  // 再次关闭：已存在的观察也必须立刻失效
  routes.gate(false)
  check('A06d 关闭闸门后旧观察立即失效', routes.read(agent) === null, routes.read(agent))
  routes.dispose()
}

// ===========================================================================
// A06 — 下游抛错不记录、原样抛出
// ===========================================================================
{
  const agent = { id: 'error-agent' }
  const runtime = busFor([agent])
  const routes = createRouteObserver({ ctx: runtime.root })
  routes.gate(true)
  let threw = false
  try {
    await runtime.root.waterfall(
      scope.scopeTarget(agent, agent), 'agent/request',
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.reject(new Error('upstream boom')),
    )
  } catch (err) {
    threw = true
  }
  check('A06e 下游错误原样抛出', threw === true)
  check('A06f 出错后不留观察', routes.read(agent) === null, routes.read(agent))
  routes.dispose()
}

// ===========================================================================
// A12 — 精确 provider 键
// ===========================================================================
{
  check('A12e 精确命中 openai-codex', resolveRoute('openai-codex') !== null)
  check('A12f 大小写变体不命中', resolveRoute('OpenAI-Codex') === null)
  check('A12g 前后空白不命中', resolveRoute(' openai-codex') === null)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
