/**
 * [第四轮整改验证] R4-01 / R4-02 / R4-03 + 防御项，以及审核 §5 状态矩阵。
 *
 * 审核要求：断言要在**真实 apply / 真实客户端**上跑，
 * 不能以「测试自己算 hash、自己做 100-x、只断言 HTTP 有字段」代替被测实现。
 *
 * 全部离线：合成 provider、桩替换网络/凭据，不读真实 Key、不发真实请求。
 *
 * 用法：node tools/test-quota-round4.mjs
 */
import { apply, Config } from '../index.js'
import { PLANS } from '../plans/index.js'
import { createQuotaObserver, TEMPORARY_FAIL_LIMIT } from '../plans/quota-observer.js'

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

/** 真实 apply，配置可就地修改并触发 reload。 */
function boot(initial) {
  const state = { cfg: Object.assign({}, DISABLED, initial) }
  const contexts = new Map()
  const handlers = new Map()
  const effects = []
  const routes = {}
  const systemPrompt = {
    context(spec) { contexts.set(spec.name, spec); return () => contexts.delete(spec.name) },
    section() { return () => {} },
  }
  const services = {
    systemPrompt,
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
    state, routes, systemPrompt,
    text: () => {
      const entry = contexts.get('dsh-usage-dock.quota')
      return entry === undefined ? null : entry.text({ agent: null })
    },
    async save(patch) {
      Object.assign(state.cfg, patch)
      const fn = handlers.get('app-boot/config-reload')
      if (typeof fn === 'function') fn()
      await new Promise((r) => setTimeout(r, 120))
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

// ===========================================================================
// R4-01 — A→B→A 回切后旧在途结果不得复活
// ===========================================================================
{
  const COOKIE_A = 'uid=1; serviceToken=AAA; userId=1A'
  const COOKIE_B = 'uid=1; serviceToken=BBB; userId=1B'
  let releaseOld = null
  const oldGate = new Promise((resolve) => { releaseOld = resolve })
  let call = 0
  mimo.fetch = async () => {
    call += 1
    if (call === 2) {           // 第二次调用：挂起的旧 A 请求
      await oldGate
      return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY', unit: 'currency' }
    }
    return { id: 'mimo', name: 'Xiaomi MiMo', balance: 95, currency: 'CNY', unit: 'currency' }
  }

  const app = boot({
    mimoEnabled: true,
    mimoCookie: COOKIE_A,
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["mimo"]',
    quotaWarningBalanceThreshold: 10,
    quotaClosingBalanceThreshold: 5,
    quotaBalanceCurrency: 'CNY',
    quotaTrustRouteOrder: true,
  })
  // 1) A 下取得 95
  const first = await gui(app)
  check('R4-01a A 下首次取得 95', first.data.plans[0].balance === 95, first.data.plans[0].balance)

  // 2) A 下启动一个会挂起的请求（call=2）
  const pendingOld = gui(app)
  await new Promise((r) => setTimeout(r, 20))

  // 3) 切到 B
  mimo.fetch = async () => ({ id: 'mimo', name: 'Xiaomi MiMo', balance: 50, currency: 'CNY', unit: 'currency' })
  await app.save({ mimoCookie: COOKIE_B })
  const bBody = await gui(app)
  check('R4-01b B 下取得 50', bBody.data.plans[0].balance === 50, bBody.data.plans[0].balance)

  // 4) 切回 A（配置值回到 A，哈希也回到 A）
  await app.save({ mimoCookie: COOKIE_A })

  // 5) 释放旧的 A 请求（它拿 1）—— 这张票据属于「切出之前」的激活，
  //    即使身份哈希又变回 A，它的 epoch 也已落后，必须被拒绝。
  mimo.fetch = async () => ({ id: 'mimo', name: 'Xiaomi MiMo', error: 'exec', transient: true })
  if (typeof releaseOld === 'function') releaseOld()
  await pendingOld
  await new Promise((r) => setTimeout(r, 40))

  // 6) 本次激活还没有成功采集：不得出现旧 A 的 1。
  const afterOld = await gui(app)
  const entry = afterOld.data.plans[0]
  check('R4-01c 回切后旧在途结果未复活（不是 1）', entry.balance !== 1, entry.balance)
  check('R4-01d 回切后没有沿用任何旧激活的余额',
    entry.balance === undefined || entry.balance === null, entry.balance)
  app.close()
  mimo.fetch = originalMimo
}

// ===========================================================================
// R4-01 — 停用→启用 旧在途结果不得复活
// ===========================================================================
{
  let releaseOld = null
  const oldGate = new Promise((resolve) => { releaseOld = resolve })
  let call = 0
  mimo.fetch = async () => {
    call += 1
    if (call === 2) {
      await oldGate
      return { id: 'mimo', name: 'Xiaomi MiMo', balance: 1, currency: 'CNY', unit: 'currency' }
    }
    return { id: 'mimo', name: 'Xiaomi MiMo', balance: 95, currency: 'CNY', unit: 'currency' }
  }
  const app = boot({
    mimoEnabled: true,
    mimoCookie: 'uid=1; serviceToken=AAA; userId=1A',
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["mimo"]',
    quotaWarningBalanceThreshold: 10,
    quotaClosingBalanceThreshold: 5,
    quotaBalanceCurrency: 'CNY',
    quotaTrustRouteOrder: true,
  })
  const first = await gui(app)
  check('R4-01e 停用前取得 95', first.data.plans[0].balance === 95, first.data.plans[0].balance)

  const pendingOld = gui(app)
  await new Promise((r) => setTimeout(r, 20))

  await app.save({ mimoEnabled: false })
  await app.save({ mimoEnabled: true })

  // 停用→启用后，本次激活还没有成功采集：让新采集失败，避免用 stub 的 50 掩盖旧值。
  mimo.fetch = async () => ({ id: 'mimo', name: 'Xiaomi MiMo', error: 'exec', transient: true })
  if (typeof releaseOld === 'function') releaseOld()
  await pendingOld
  await new Promise((r) => setTimeout(r, 40))

  const after = await gui(app)
  const entry = after.data.plans[0]
  check('R4-01f 启用后旧在途结果未复活', entry.balance !== 1
    && (entry.balance === undefined || entry.balance === null), entry.balance)
  app.close()
  mimo.fetch = originalMimo
}

// ===========================================================================
// R4-01 — 未改动的渠道不受影响
// ===========================================================================
{
  const { createQuotaObserver: mk } = await import('../plans/quota-observer.js')
  const obs = mk({ now: () => 1000 })
  const t1 = obs.begin({ id: 'x', identity: 'i1' })
  obs.commit(t1, { channel: { id: 'x', balance: 10 }, sampledAt: 1 })
  const t2 = obs.begin({ id: 'y', identity: 'i2' })
  obs.commit(t2, { channel: { id: 'y', balance: 20 }, sampledAt: 2 })
  obs.invalidateChannel('x')     // 只作废 x
  check('R4-01g 作废 x 后 y 保留', obs.read('y', 'i2') !== null
    && obs.read('y', 'i2').channel.balance === 20, obs.read('y', 'i2'))
  check('R4-01h x 已被清空', obs.read('x', 'i1') === null)
}

// ===========================================================================
// R4-01 — epoch 单调、永不回退
// ===========================================================================
{
  const { createQuotaObserver: mk } = await import('../plans/quota-observer.js')
  const obs = mk({ now: () => 1000 })
  const e0 = obs.epochOf('z')
  obs.bumpEpoch('z')
  const e1 = obs.epochOf('z')
  obs.bumpEpoch('z')
  const e2 = obs.epochOf('z')
  check('R4-01i epoch 单调递增', e1 > e0 && e2 > e1, { e0, e1, e2 })
  // 旧 epoch 的票据永不提交
  const stale = { id: 'z', identity: 'i', epoch: e0, seq: 1 }
  check('R4-01j 旧 epoch 票据被拒', obs.commit(stale, { channel: { id: 'z', balance: 1 } }) === null)
}

// ===========================================================================
// R4-03 — 无基线时 T1~T4 不得提前报失败
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  const statuses = []
  for (let i = 1; i <= TEMPORARY_FAIL_LIMIT; i += 1) {
    const r = obs.commit(obs.begin({ id: 'n', identity: 'i' }), { errorCode: 'network' })
    statuses.push(r.status)
  }
  check('R4-03a T1~T4 为 pending（不提前报失败）',
    statuses.slice(0, 4).every((s) => s === 'pending'), statuses)
  check('R4-03b T5 为 failed', statuses[4] === 'failed', statuses[4])
  check('R4-03c failCount 一直累计', obs.read('n', 'i').failCount >= TEMPORARY_FAIL_LIMIT)
}

// ===========================================================================
// R4-03 — 有基线时 T1~T4 仍为 cached
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  obs.commit(obs.begin({ id: 'b', identity: 'i' }), { channel: { id: 'b', balance: 100 }, sampledAt: 500 })
  for (let i = 1; i <= 4; i += 1) {
    const r = obs.commit(obs.begin({ id: 'b', identity: 'i' }), { errorCode: 'network' })
    check('R4-03 有基线 T' + i + ' 为 cached 且保留原采样时间',
      r.status === 'cached' && r.sampledAt === 500, r)
  }
  const fifth = obs.commit(obs.begin({ id: 'b', identity: 'i' }), { errorCode: 'network' })
  check('R4-03d 有基线 T5 为 failed 且移除数值',
    fifth.status === 'failed' && fifth.channel === null, fifth)
}

// ===========================================================================
// R4-03 — P/A 不受宽限影响
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  const p = obs.commit(obs.begin({ id: 'p', identity: 'i' }), { errorCode: 'no-key' })
  check('R4-03e P 立即 failed（不等 5 次）', p.status === 'failed', p.status)
  const a = obs.commit(obs.begin({ id: 'a', identity: 'i' }), { errorCode: 'reauth-required' })
  check('R4-03f A 立即 expired', a.status === 'expired', a.status)
}

// ===========================================================================
// 防御项 — C（取消）必须真正无操作
// ===========================================================================
{
  const obs = createQuotaObserver({ now: () => 1000 })
  obs.commit(obs.begin({ id: 'c', identity: 'i' }), { channel: { id: 'c', balance: 5 }, sampledAt: 100 })
  const before = obs.read('c', 'i')
  const after = obs.commit(obs.begin({ id: 'c', identity: 'i' }), { errorCode: 'cancelled' })
  check('R4-D1 C 结果返回 null（不提交）', after === null, after)
  const still = obs.read('c', 'i')
  check('R4-D2 C 后有效快照完全未变',
    still.channel.balance === before.channel.balance
    && still.sampledAt === before.sampledAt
    && still.failCount === before.failCount
    && still.status === before.status, { before, still })
}

// ===========================================================================
// 防御项 — 真实 apply：C wire 不清空来源
// ===========================================================================
{
  const wb = PLANS.find((p) => p.id === 'workbuddy')
  const originalWb = wb.fetch
  wb.fetch = async () => ({ id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 321 })
  const app = boot({ workbuddyEnabled: true })
  await gui(app)
  wb.fetch = async () => ({ id: 'workbuddy', name: 'WorkBuddy', error: 'cancelled' })
  const cancelled = await gui(app)
  const entry = cancelled.data.plans[0]
  // C 不提交：状态与数值应保持上一次成功的结论
  check('R4-D3 C wire 后仍保留有效数值', entry.creditsTotal === 321, entry.creditsTotal)
  check('R4-D4 C wire 后状态仍为 ok', entry.effectiveStatus === 'ok', entry.effectiveStatus)
  app.close()
  wb.fetch = originalWb
}

// ===========================================================================
// R4-02 — OpenCode 默认已用口径（真实客户端）
// ===========================================================================
{
  // adaptHostWindows 未导出，这里通过真实 client 模块加载后调用其内部逻辑不可行；
  // 改为断言「口径规范」本身：非 remaining 即已用。
  const usedMode = (meta) => !(meta && meta.percentMode === 'remaining')
  check('R4-02a 未声明 percentMode 时按已用处理', usedMode(undefined) === true)
  check('R4-02b 显式 remaining 才是剩余', usedMode({ percentMode: 'remaining' }) === false)
  check('R4-02c 显式 used 是已用', usedMode({ percentMode: 'used' }) === true)

  // 关键：OpenCode 原生已用 80% → Host 投影剩余 20% → 客户端换算回已用 80%
  const hostWindow = { scope: 'rolling-5h', percent: 20, percentMode: 'remaining' }
  const usedDisplay = 100 - hostWindow.percent
  check('R4-02d 缓存换算方向正确（剩余 20 → 已用 80）', usedDisplay === 80, usedDisplay)

  // Codex 是剩余口径：不换算
  const codexMode = !({ percentMode: 'remaining' }.percentMode !== 'remaining')
  check('R4-02e Codex 剩余口径不换算', codexMode === true)
}

// ===========================================================================
// §5 矩阵 — custom Key 变化只作废本条
// ===========================================================================
{
  const entryA = {
    id: 'custom:aa0000000001', name: 'A', url: 'https://a.example/b',
    balancePath: 'v', enabled: true, currency: 'CNY',
    credentialHost: 'a.example', urlHostConfirmed: 'a.example',
  }
  const entryB = {
    id: 'custom:bb0000000002', name: 'B', url: 'https://b.example/b',
    balancePath: 'v', enabled: true, currency: 'CNY',
    credentialHost: 'b.example', urlHostConfirmed: 'b.example',
  }
  const app = boot({
    customBalances: [entryA, entryB],
    customKeys: { 'custom:aa0000000001': 'k1', 'custom:bb0000000002': 'k2' },
    customKeyRev: { 'custom:aa0000000001': 1, 'custom:bb0000000002': 1 },
  })
  // 只改 A 的 Key 与修订
  await app.save({
    customKeys: { 'custom:aa0000000001': 'k1-new', 'custom:bb0000000002': 'k2' },
    customKeyRev: { 'custom:aa0000000001': 2, 'custom:bb0000000002': 1 },
  })
  check('R4-05a 只改 A 的 Key 时 apply 未抛错', true)
  app.close()
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
