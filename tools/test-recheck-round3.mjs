/**
 * 第三轮复核 W1–W3 复现与回归。
 *
 * 对应 [第三轮复核](docs/recheck-v0.9.0-round3.md)：
 *   W1 没有历史成功值时，Host 旧配置缓存返回的 wire 仍被当成当前数据
 *   W2 重复保存同一把 Key 后，渠道永久无法恢复
 *   W3 编辑 A 会清掉未编辑 B（以及内置渠道）的成功基线与失败计数
 *
 * 全部使用真实 client.js（mock React）+ 真实 form 快照变化 + 延迟响应，
 * 不手工改 wire.gen、不假设浏览器「见过」某个 gen。
 *
 * 用法：node tools/test-recheck-round3.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'
import { configDigestOf } from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    }
  }
  return out
}
function textAll(tree) { return elementsOf(tree).map((el) => textOf(el)).join('') }

const A_ENTRY = {
  id: 'custom:round3aaaaa', name: 'A', url: 'https://a.example/balance',
  balancePath: 'data.balance', subtractPath: '', currency: 'USD',
  credentialRef: '', credentialHost: 'https://a.example', urlHostConfirmed: 'https://a.example',
  enabled: true,
}
const B_ENTRY = {
  id: 'custom:round3bbbbb', name: 'B', url: 'https://b.example/balance',
  balancePath: 'data.balance', subtractPath: '', currency: 'USD',
  credentialRef: '', credentialHost: 'https://b.example', urlHostConfirmed: 'https://b.example',
  enabled: true,
}

function makeForm(entries) {
  const listeners = new Set()
  const form = {
    value: { enabled: true, planOrder: '[]', customBalances: entries },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set() { return Promise.resolve(true) },
    publish(next) { this.value = next; listeners.forEach((fn) => fn()) },
  }
  return form
}

/** 构造一份带 Host 配置证明的响应。 */
function payload(plans, entries, extra) {
  const meta = Object.assign({
    digest: configDigestOf({ customBalances: entries }),
    match: true,
    readAt: Date.now(),
    reloadable: true,
  }, extra || {})
  return { ok: true, data: { plans, cfg: meta } }
}

// ===========================================================================
// W1 — 没有历史成功值时，旧配置 wire 不得被接受
// ===========================================================================
{
  const runtime = createRuntime()
  const form = makeForm([A_ENTRY])
  let call = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const cfgA = [A_ENTRY]
  const cfgB = [Object.assign({}, A_ENTRY, {
    url: 'https://b.example/balance', credentialHost: 'https://b.example', urlHostConfirmed: 'https://b.example', currency: 'CNY',
  })]

  const client = loadClient(runtime, { form, payload: payload([], cfgA) })
  globalThis.fetch = async () => {
    call += 1
    if (call === 1) {
      // 第一次请求（A 配置）挂起，稍后被 cleanup 作废。
      await firstGate
      return { json: async () => payload([{ id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-A-original', currency: 'USD', balance: 91.23 }], cfgA) }
    }
    if (call === 2) {
      // 第二次请求：客户端已是 B 配置，但 Host 仍读旧缓存（A）。
      return { json: async () => payload([{ id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-A-original', currency: 'USD', balance: 91.23 }], cfgA) }
    }
    // 之后：Host 已读到 B 配置。
    return { json: async () => payload([{ id: A_ENTRY.id, name: 'B', custom: true, gen: 'gen-B', currency: 'CNY', balance: 1.25 }], cfgB) }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  await runtime.settle({ configForm: form, wide: true })

  // 保存 B 配置（第一个请求仍未返回 → 从未有过 known gen）。
  form.publish({ enabled: true, planOrder: '[]', customBalances: cfgB })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('W1a 旧配置 wire 不被显示（没有历史成功值也一样）', !/91\.23/.test(textAll(tree)), textAll(tree))

  releaseFirst()
  await sleep(60)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W1b 迟到的 A 响应也不回填', !/91\.23/.test(textAll(tree)), textAll(tree))

  // Host 读到 B 配置后必须恢复。
  client.windowEvents.dispatch('focus')
  await sleep(60)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W1c Host 读到新配置后恢复显示 ¥ 1.25', /¥\s?1\.25/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 组件重挂（相当于切页面回来）：仍不得接受旧配置 wire。
  const runtime = createRuntime()
  const form = makeForm([A_ENTRY])
  const cfgA = [A_ENTRY]
  const cfgB = [Object.assign({}, A_ENTRY, { currency: 'CNY', url: 'https://b.example/balance', credentialHost: 'https://b.example', urlHostConfirmed: 'https://b.example' })]
  const client = loadClient(runtime, { form, payload: payload([], cfgA) })
  globalThis.fetch = async () => ({
    json: async () => payload([{ id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-A', currency: 'USD', balance: 44.44 }], cfgA),
  })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  await runtime.settle({ configForm: form, wide: true })
  form.publish({ enabled: true, planOrder: '[]', customBalances: cfgB })
  await runtime.settle({ configForm: form, wide: true })
  // 重新挂载组件（新实例 → 所有 ref 都是空的，不能依赖「见过 gen」）。
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('W1d 组件重挂后仍拒绝旧配置 wire', !/44\.44/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// W2 — 重复保存同一把 Key 必须能恢复
// ===========================================================================
{
  const runtime = createRuntime()
  const form = makeForm([A_ENTRY])
  const cfg = [A_ENTRY]
  let gateOpen = false
  let releaseGate = null
  let call = 0
  const client = loadClient(runtime, { form, payload: payload([], cfg) })
  globalThis.fetch = async () => {
    call += 1
    if (call > 1 && !gateOpen) {
      // 保存后的那一轮：新请求挂起，验证「旧值立刻隐藏」。
      await new Promise((resolve) => { releaseGate = resolve })
    }
    return {
      json: async () => payload(
        [{ id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-same', currency: 'USD', balance: 91.23 }],
        cfg,
        { readAt: Date.now() },
      ),
    }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('W2a 先显示 $ 91.23', /\$\s?91\.23/.test(textAll(tree)), textAll(tree))

  // 用户在设置页重新填写并保存**同一把** Key（幂等写入）：走同一条失效入口。
  client.module.invalidateCustomChannel(A_ENTRY.id)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W2b 保存后旧值立刻隐藏（保守）', !/91\.23/.test(textAll(tree)), textAll(tree))

  // Host 连续返回当前有效配置的同一 gen。
  gateOpen = true
  if (releaseGate !== null) releaseGate()
  for (let i = 0; i < 3; i += 1) {
    client.windowEvents.dispatch('focus')
    await sleep(30)
    tree = await runtime.settle({ configForm: form, wide: true })
  }
  check('W2c 同一 Key 的合法响应必须能恢复（不得永久拒收）', /91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 真正换 Key（gen 变化）也要能恢复。
  const runtime = createRuntime()
  const form = makeForm([A_ENTRY])
  const cfg = [A_ENTRY]
  let gen = 'gen-k1'
  const client = loadClient(runtime, { form, payload: payload([], cfg) })
  globalThis.fetch = async () => ({
    json: async () => payload(
      [{ id: A_ENTRY.id, name: 'A', custom: true, gen, currency: 'USD', balance: gen === 'gen-k1' ? 10.1 : 20.2 }],
      cfg,
      { readAt: Date.now() },
    ),
  })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('W2d.pre 显示 $ 10.10', /10\.10/.test(textAll(tree)), textAll(tree))
  client.module.invalidateCustomChannel(A_ENTRY.id)
  gen = 'gen-k2'
  client.windowEvents.dispatch('focus')
  await sleep(40)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W2e 真正换 Key 后显示新值 $ 20.20', /20\.20/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // Host 仍读旧配置期间，必须继续拒绝（W2 的修复不能破坏 W1）。
  // 用真实语义构造：Host 返回的摘要对应**旧**配置（少一个条目）。
  const runtime = createRuntime()
  const form = makeForm([A_ENTRY])
  const cfgOld = []           // Host 读到的旧配置：条目还没保存进去
  const client = loadClient(runtime, { form, payload: payload([], [A_ENTRY]) })
  globalThis.fetch = async () => ({
    json: async () => payload(
      [{ id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-old', currency: 'USD', balance: 77.77 }],
      cfgOld,
      { readAt: Date.now() - 5000 },
    ),
  })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('W2f Host 配置不匹配时仍拒绝显示', !/77\.77/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// W3 — 只改 A 不得清掉 B 的基线与失败计数
// ===========================================================================
{
  const runtime = createRuntime()
  const form = makeForm([A_ENTRY, B_ENTRY])
  const cfg = [A_ENTRY, B_ENTRY]
  let phase = 'ok'
  let aValue = 11.11
  const client = loadClient(runtime, { form, payload: payload([], cfg) })
  let currentCfg = cfg
  globalThis.fetch = async () => {
    if (phase === 'ok') {
      return {
        json: async () => payload([
          { id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-a1', currency: 'USD', balance: aValue },
          { id: B_ENTRY.id, name: 'B', custom: true, gen: 'gen-b1', currency: 'USD', balance: 22.22 },
        ], currentCfg, { readAt: Date.now() }),
      }
    }
    // A 有新值；B 暂时 500（同 gen，transient）。Host 已读到新配置（只改了 A）。
    return {
      json: async () => payload([
        { id: A_ENTRY.id, name: 'A', custom: true, gen: 'gen-a2', currency: 'USD', balance: 33.33 },
        { id: B_ENTRY.id, name: 'B', custom: true, gen: 'gen-b1', currency: 'USD', error: 'server', transient: true, message: 'HTTP 500' },
      ], currentCfg, { readAt: Date.now() }),
    }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('W3a 基线 A 11.11 / B 22.22', /11\.11/.test(textAll(tree)) && /22\.22/.test(textAll(tree)), textAll(tree))

  // 只改 A 的 URL/确认目标；B 完全不动。
  const cfg2 = [Object.assign({}, A_ENTRY, {
    url: 'https://a2.example/balance', credentialHost: 'https://a2.example', urlHostConfirmed: 'https://a2.example',
  }), B_ENTRY]
  phase = 'fail'
  currentCfg = cfg2
  form.publish({ enabled: true, planOrder: '[]', customBalances: cfg2 })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W3b A 显示新值 33.33', /33\.33/.test(textAll(tree)), textAll(tree))
  check('W3c B 保留旧值 22.22（灰化，不立即报错）', /22\.22/.test(textAll(tree)), textAll(tree))
  check('W3d B 没有被标成「获取失败」', !/获取失败/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 整体网络失败时，内置渠道与自定义渠道都要沿用基线（而不是整表清空）。
  const runtime = createRuntime()
  const form = makeForm([B_ENTRY])
  const cfg = [B_ENTRY]
  let fail = false
  const client = loadClient(runtime, {
    form,
    payload: payload([
      { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, warnThreshold: 10 },
      { id: B_ENTRY.id, name: 'B', custom: true, gen: 'gen-b1', currency: 'USD', balance: 22.22 },
    ], cfg),
  })
  globalThis.fetch = async () => {
    if (fail) throw new TypeError('fetch failed')
    return {
      json: async () => payload([
        { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, warnThreshold: 10 },
        { id: B_ENTRY.id, name: 'B', custom: true, gen: 'gen-b1', currency: 'USD', balance: 22.22 },
      ], cfg, { readAt: Date.now() }),
    }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('W3e.pre 内置 7.38 与自定义 22.22 都在', /7\.38/.test(textAll(tree)) && /22\.22/.test(textAll(tree)), textAll(tree))

  // 改 B 的币种 → effect 重建；随后整体网络失败。
  const cfg2 = [Object.assign({}, B_ENTRY, { currency: 'CNY' })]
  fail = true
  form.publish({ enabled: true, planOrder: '[]', customBalances: cfg2 })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W3f 整体失败时内置渠道仍沿用 7.38（不被自定义配置变更牵连）',
    /7\.38/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 第 7/8 轮边界：B 连续暂时失败到阈值才转纯错误。
  const runtime = createRuntime()
  const form = makeForm([B_ENTRY])
  const cfg = [B_ENTRY]
  let failCount = 0
  let failing = false
  const client = loadClient(runtime, { form, payload: payload([], cfg) })
  globalThis.fetch = async () => {
    if (!failing) {
      return {
        json: async () => payload(
          [{ id: B_ENTRY.id, name: 'B', custom: true, gen: 'gen-b1', currency: 'USD', balance: 55.55 }],
          cfg, { readAt: Date.now() },
        ),
      }
    }
    failCount += 1
    return {
      json: async () => payload(
        [{ id: B_ENTRY.id, name: 'B', custom: true, gen: 'gen-b1', currency: 'USD', error: 'server', transient: true, message: 'HTTP 500' }],
        cfg, { readAt: Date.now() },
      ),
    }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('W3g.pre 显示 55.55', /55\.55/.test(textAll(tree)), textAll(tree))

  failing = true
  // [A04] 阈值 8 → 5：第 4 轮仍保留旧值（未到阈值），第 5 轮才转失败。
  for (let i = 1; i <= 4; i += 1) {
    client.windowEvents.dispatch('focus')
    await sleep(20)
    tree = await runtime.settle({ configForm: form, wide: true })
    if (i === 4) {
      check('W3h 第 4 轮暂时失败仍保留旧值（未到阈值 5）', /55\.55/.test(textAll(tree)), { round: i, text: textAll(tree) })
    }
  }
  client.windowEvents.dispatch('focus')
  await sleep(20)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('W3i 第 8 轮转为「获取失败」', /获取失败/.test(textAll(tree)) && !/55\.55/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// W1/W2 Host 侧契约：配置证明必须由 Host 用自己的 cfg 生成
// ===========================================================================
{
  const { apply, Config } = await import('../index.js')
  const { PLANS } = await import('../plans/index.js')
  const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
  const routes = {}
  const parsed = Config(Object.assign({}, disabledAll, {
    customBalances: [A_ENTRY],
    customKeyRev: { [A_ENTRY.id]: 3 },
  }))
  apply({
    get: () => undefined,
    webServer: { port: 1, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    effect: (fn) => fn(),
  }, parsed)
  let body
  await routes['/api/plan-usage']({ method: 'GET' }, { writeHead() {}, end(t) { body = JSON.parse(t) } })
  check('H1 响应带 cfg 证明', body && body.data && body.data.cfg !== undefined, body && Object.keys(body))
  check('H2 摘要与 Host 实际读到的配置一致',
    body.data.cfg.digest === configDigestOf({ customBalances: [A_ENTRY], customKeyRev: { [A_ENTRY.id]: 3 } }),
    body.data.cfg.digest)
  check('H3 证明不含 Key / URL 明文之外的可疑字段',
    typeof body.data.cfg.digest === 'string' && body.data.cfg.digest.length === 16
    && !('customKeys' in body.data.cfg), body.data.cfg)
  check('H4 修订号改变会改变摘要（幂等写入也能被确认）',
    body.data.cfg.digest !== configDigestOf({ customBalances: [A_ENTRY], customKeyRev: { [A_ENTRY.id]: 4 } }),
    body.data.cfg.digest)
}

{
  // 两端摘要必须**逐字一致**：Host 用 configDigestOf，客户端用 dshDigest16。
  // 这里通过真实 client.js 暴露的内部实现间接验证（client 里同名函数不可直接 import），
  // 做法是让 Host 生成摘要、客户端接受它 —— W1c/W2c 已经端到端证明。
  // 额外守一条：同一份配置重复计算稳定、不同配置不同。
  const base = { customBalances: [A_ENTRY], customKeyRev: { [A_ENTRY.id]: 1 } }
  check('D1 同一份配置摘要稳定', configDigestOf(base) === configDigestOf(base))
  check('D2 改 URL 会改摘要',
    configDigestOf(base) !== configDigestOf({ customBalances: [Object.assign({}, A_ENTRY, { url: 'https://z.example/b' })], customKeyRev: base.customKeyRev }))
  check('D3 只改修订号会改摘要（幂等保存可被确认）',
    configDigestOf(base) !== configDigestOf({ customBalances: [A_ENTRY], customKeyRev: { [A_ENTRY.id]: 2 } }))
  check('D4 改币种会改摘要',
    configDigestOf(base) !== configDigestOf({ customBalances: [Object.assign({}, A_ENTRY, { currency: 'CNY' })], customKeyRev: base.customKeyRev }))
  check('D5 增删条目会改摘要',
    configDigestOf(base) !== configDigestOf({ customBalances: [A_ENTRY, B_ENTRY], customKeyRev: base.customKeyRev }))
  check('D6 摘要不含 Key 明文（输入里也没有 Key）',
    !configDigestOf(base).includes('sk-') && configDigestOf(base).length === 16, configDigestOf(base))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
