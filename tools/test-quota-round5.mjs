/**
 * [第五轮整改验证] R5-01：epoch 生命周期完整性。
 *
 * 第五轮复核确认 R4-02（百分比口径）、R4-03（pending）、C 取消项均通过，
 * 仅剩一组 P1：**epoch 不是完整的激活状态，仍依赖已提交元信息**。
 *
 * 三个缺口（本文件逐一覆盖）：
 *   1. 首次查询还没有任何结局时（无 channelMeta），回切/停启仍能复活旧结果；
 *   2. 监控总开关（`enabled`）变化不参与激活边界；
 *   3. `clear()` 漏掉从未提交过的票据。
 *
 * 全部离线：合成 provider、桩替换网络/凭据，不读真实 Key、不发真实请求。
 *
 * 用法：node tools/test-quota-round5.mjs
 */
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { createQuotaObserver } from '../plans/quota-observer.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

const DISABLED = {
  opencodeGoEnabled: false, deepseekEnabled: false, codexEnabled: false,
  mimoEnabled: false, workbuddyEnabled: false, workbuddyAiEnabled: false,
}

/** 真实 apply，配置就地修改 + 触发 reload，并暴露 context 读取。 */
function boot(initial) {
  const state = { cfg: Object.assign({}, DISABLED, initial) }
  const contexts = new Map()
  const handlers = new Map()
  const effects = []
  const routes = {}
  const services = {
    systemPrompt: {
      context(spec) { contexts.set(spec.name, spec); return () => contexts.delete(spec.name) },
      section() { return () => {} },
    },
    tools: { register() { return () => {} } },
    agents: { list: () => [] },
    configEditor: { configuration: () => [{ entry: { options: { id: 'plan-usage' } }, override: state.cfg, inherited: {} }] },
  }
  const ctx = {
    webServer: { port: 0, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    get: (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    off(name) { handlers.delete(name) },
    emit(name) { const fn = handlers.get(name); if (typeof fn === 'function') fn() },
    effect(fn) { const dep = fn(); effects.push(dep); return dep },
  }
  apply(ctx, new Config(state.cfg))
  return {
    state, routes,
    text: () => {
      const entry = contexts.get('dsh-usage-dock.quota')
      return entry === undefined ? null : entry.text({ agent: null })
    },
    async save(patch) {
      Object.assign(state.cfg, patch)
      const fn = handlers.get('app-boot/config-reload')
      if (typeof fn === 'function') fn()
      await new Promise((r) => setTimeout(r, 100))
    },
    close() { for (const dep of effects.reverse()) if (typeof dep === 'function') dep() },
  }
}

function fakeRes() {
  const s = { status: 0, body: '' }
  return { s, writeHead(x) { s.status = x }, end(c) { s.body = String(c === undefined ? '' : c) } }
}
async function gui(app) {
  const res = fakeRes()
  await app.routes['/api/plan-usage']({ method: 'GET' }, res)
  return JSON.parse(res.s.body)
}

const mimo = PLANS.find((p) => p.id === 'mimo')
const originalMimo = mimo.fetch

const COOKIE_A = 'uid=1; serviceToken=AAA; userId=1A'
const COOKIE_B = 'uid=1; serviceToken=BBB; userId=1B'
const POLICY = {
  mimoEnabled: true,
  mimoCookie: COOKIE_A,
  quotaPolicyEnabled: true,
  quotaFocusChannels: '["mimo"]',
  quotaWarningBalanceThreshold: 10,
  quotaClosingBalanceThreshold: 5,
  quotaBalanceCurrency: 'CNY',
  quotaTrustRouteOrder: true,
}

// ===========================================================================
// §3.1 — 首次查询**还没有任何结局**时，回切不得复活旧结果
// ===========================================================================
{
  let call = 0
  let releaseFirst = null
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  mimo.fetch = async () => {
    call += 1
    if (call === 1) {
      // 冷启动的第一条查询：挂起，**不产生任何 channelMeta**
      await firstGate
      return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY', unit: 'currency' }
    }
    return { id: 'mimo', name: 'Xiaomi MiMo', balance: 95, currency: 'CNY', unit: 'currency' }
  }

  const app = boot(POLICY)
  // 第一条请求挂起（此时没有任何观察元信息）
  const pendingFirst = gui(app)
  await new Promise((r) => setTimeout(r, 30))

  // 逐次 reload：A → B → A
  await app.save({ mimoCookie: COOKIE_B })
  await app.save({ mimoCookie: COOKIE_A })

  // 放行旧 A 的 1CNY
  if (typeof releaseFirst === 'function') releaseFirst()
  await pendingFirst
  await new Promise((r) => setTimeout(r, 60))

  // 本次激活还没有成功采集：让后续采集失败，观察是否出现旧值
  mimo.fetch = async () => ({ id: 'mimo', name: 'Xiaomi MiMo', error: 'exec', transient: true })
  const after = await gui(app)
  const entry = after.data.plans[0]
  check('R5-01a 首次查询回切后旧结果未被采纳（不是 1）', entry.balance !== 1, entry.balance)
  check('R5-01b 状态不是 ok（本次激活没有成功采集）',
    entry.effectiveStatus !== 'ok', entry.effectiveStatus)
  check('R5-01c context 不含收尾规则（旧低余额未驱动）',
    /收尾/.test(app.text() || '') === false, app.text())
  app.close()
  mimo.fetch = originalMimo
}

// ===========================================================================
// §3.1 — 首次查询还没有结局时，停用→启用不得复活
// ===========================================================================
{
  let call = 0
  let releaseFirst = null
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  mimo.fetch = async () => {
    call += 1
    if (call === 1) {
      await firstGate
      return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY', unit: 'currency' }
    }
    return { id: 'mimo', name: 'Xiaomi MiMo', balance: 95, currency: 'CNY', unit: 'currency' }
  }
  const app = boot(POLICY)
  const pendingFirst = gui(app)
  await new Promise((r) => setTimeout(r, 30))

  await app.save({ mimoEnabled: false })
  await app.save({ mimoEnabled: true })

  if (typeof releaseFirst === 'function') releaseFirst()
  await pendingFirst
  await new Promise((r) => setTimeout(r, 60))

  mimo.fetch = async () => ({ id: 'mimo', name: 'Xiaomi MiMo', error: 'exec', transient: true })
  const after = await gui(app)
  const entry = after.data.plans[0]
  check('R5-01d 首次查询停启后旧结果未被采纳', entry.balance !== 1, entry.balance)
  check('R5-01e 状态不是 ok', entry.effectiveStatus !== 'ok', entry.effectiveStatus)
  app.close()
  mimo.fetch = originalMimo
}

// ===========================================================================
// §3.2 — 监控总开关变化必须参与激活边界
// ===========================================================================
{
  let call = 0
  let releaseOld = null
  const oldGate = new Promise((resolve) => { releaseOld = resolve })
  mimo.fetch = async () => {
    call += 1
    if (call === 2) {
      await oldGate
      return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY', unit: 'currency' }
    }
    return { id: 'mimo', name: 'Xiaomi MiMo', balance: 95, currency: 'CNY', unit: 'currency' }
  }
  const app = boot(Object.assign({ enabled: true }, POLICY))
  await gui(app)                        // 建立 95 基线
  const pendingOld = gui(app)           // 挂起第二条（会返回 1）
  await new Promise((r) => setTimeout(r, 30))

  await app.save({ enabled: false })    // 监控总开关关
  await gui(app)                        // 走一次路由，让 reconcile 执行
  await app.save({ enabled: true })     // 再开
  await gui(app)

  if (typeof releaseOld === 'function') releaseOld()
  await pendingOld
  await new Promise((r) => setTimeout(r, 60))

  mimo.fetch = async () => ({ id: 'mimo', name: 'Xiaomi MiMo', error: 'exec', transient: true })
  const after = await gui(app)
  const entry = after.data.plans[0]
  check('R5-02a 监控关→开后旧在途结果未被采纳（不是 1）', entry.balance !== 1, entry.balance)
  check('R5-02b context 不含收尾规则', /收尾/.test(app.text() || '') === false, app.text())
  app.close()
  mimo.fetch = originalMimo
}

// ===========================================================================
// §3.3 — clear() 必须覆盖从未提交过的票据
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  const ticket = obs.begin({ id: 'never', identity: 'i' })
  check('R5-03a begin 即登记初始 epoch', obs.epochOf('never') === 0, obs.epochOf('never'))
  obs.clear()
  check('R5-03b clear 后 epoch 已推进', obs.epochOf('never') === 1, obs.epochOf('never'))
  const record = obs.commit(ticket, { channel: { id: 'never', balance: 1 } })
  check('R5-03c 未提交过的旧票据被拒绝', record === null, record)
}

// ===========================================================================
// 不得饿死 — 同身份两个请求、无配置变化，第一条可以正常建立基线
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  const t1 = obs.begin({ id: 's', identity: 'i' })
  const t2 = obs.begin({ id: 's', identity: 'i' })
  check('R5-04a 同身份并发请求共享同一 epoch', t1.epoch === t2.epoch, { e1: t1.epoch, e2: t2.epoch })
  const r1 = obs.commit(t1, { channel: { id: 's', balance: 10 }, sampledAt: 1 })
  check('R5-04b 第一条可以建立基线', r1 !== null && r1.status === 'ok', r1)
  const r2 = obs.commit(t2, { channel: { id: 's', balance: 20 }, sampledAt: 2 })
  check('R5-04c 第二条按序号覆盖（更新）', r2 !== null && r2.channel.balance === 20, r2)
}

// ===========================================================================
// 只改另一条渠道 — 本条票据/基线/计数不变
// ===========================================================================
{
  const entryA = {
    id: 'custom:aa1100000001', name: 'A', url: 'https://a.example/b',
    balancePath: 'v', enabled: true, currency: 'CNY',
    credentialHost: 'a.example', urlHostConfirmed: 'a.example',
  }
  const entryB = {
    id: 'custom:bb2200000002', name: 'B', url: 'https://b.example/b',
    balancePath: 'v', enabled: true, currency: 'CNY',
    credentialHost: 'b.example', urlHostConfirmed: 'b.example',
  }
  const obs = createQuotaObserver({ now: () => 1000 })
  const tB = obs.begin({ id: entryB.id, identity: 'B1' })
  obs.commit(tB, { channel: { id: entryB.id, balance: 5 }, sampledAt: 1 })
  const epochBefore = obs.epochOf(entryB.id)
  // 只推进 A
  obs.bumpEpoch(entryA.id)
  check('R5-05a 改另一条渠道时本条 epoch 不变',
    obs.epochOf(entryB.id) === epochBefore, { before: epochBefore, after: obs.epochOf(entryB.id) })
  check('R5-05b 本条基线保留', obs.read(entryB.id, 'B1') !== null
    && obs.read(entryB.id, 'B1').channel.balance === 5)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
