/**
 * 第四轮复核 X1–X2 复现与回归。
 *
 * 对应 [第四轮复核](docs/recheck-v0.9.0-round4.md)：
 *   X1 双端配置摘要规范化不一致 —— 合法空格输入（URL / JSON 路径首尾空格、币种大小写、
 *      credentialHost 大小写）会让 Host 的成功响应永远被客户端当成「旧配置」拒绝。
 *   X2 只更新 customKeyRev 时，effect 仍捕获旧摘要、旧余额未即时作废，
 *      匹配新修订的结果也被拒绝（强刷不恢复）。
 *
 * 用法：node tools/test-recheck-round4.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'
import {
  configDigestOf, entryPublicIdentity, customSchemaFields, normalizeCurrency,
} from '../plans/custom-balance.js'

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

const BASE = {
  id: 'custom:round4aaaaa', name: 'A', url: 'https://a.example/balance',
  balancePath: 'data.balance', subtractPath: '', currency: 'USD',
  credentialRef: '', credentialHost: 'https://a.example', urlHostConfirmed: 'https://a.example',
  enabled: true,
}

function makeForm(entries, revs) {
  const listeners = new Set()
  const form = {
    value: { enabled: true, planOrder: '[]', customBalances: entries, customKeyRev: revs || {} },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set() { return Promise.resolve(true) },
    publish(next) { this.value = next; listeners.forEach((fn) => fn()) },
  }
  return form
}

/** Host 侧证明：用真实 configDigestOf 计算。 */
function hostProof(entries, revs) {
  return {
    digest: configDigestOf({ customBalances: entries, customKeyRev: revs || {} }),
    readAt: Date.now(),
    reloadable: true,
  }
}

function payload(plans, proof) {
  return { ok: true, data: { plans, cfg: proof } }
}

function planOf(over) {
  return Object.assign({
    id: BASE.id, name: 'A', custom: true, gen: 'gen-1', currency: 'USD', balance: 91.23,
  }, over || {})
}

// ===========================================================================
// X1 — 双端摘要规范化必须同构
// ===========================================================================
//
// 这里直接比较「Host 算的摘要」与「客户端算的摘要」。客户端函数不可 import，
// 因此用真实 Badge 做端到端验证：Host 用 configDigestOf 出证，客户端若能显示，
// 说明两端算出了同一个摘要。
const NORMALIZATION_CASES = [
  ['normal', { url: 'https://a.example/balance', balancePath: 'data.balance' }],
  ['url 首尾空格', { url: '  https://a.example/balance  ' }],
  ['url 尾部空格', { url: 'https://a.example/balance ' }],
  ['path 首尾空格', { balancePath: '  data.balance  ' }],
  ['subtractPath 空格', { subtractPath: ' data.used ' }],
  ['币种小写', { currency: 'usd' }],
  ['币种混合大小写', { currency: 'Usd' }],
  ['币种带空格', { currency: ' USD ' }],
  ['credentialHost 大写', { credentialHost: 'HTTPS://A.EXAMPLE' }],
  ['credentialHost 尾点', { credentialHost: 'https://a.example.' }],
  ['credentialRef 空格', { credentialRef: ' DEEPSEEK_API_KEY ' }],
  ['缺字段', { balancePath: undefined, subtractPath: undefined, credentialRef: undefined }],
]

for (const [label, over] of NORMALIZATION_CASES) {
  const runtime = createRuntime()
  const entry = Object.assign({}, BASE, over)
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key]
  }
  const form = makeForm([entry])
  const client = loadClient(runtime, { form, payload: payload([planOf()], hostProof([entry])) })
  globalThis.fetch = async () => ({ json: async () => payload([planOf()], hostProof([entry])) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('X1 ' + label + '：Host 的证明被客户端接受并显示余额', /91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 真正不同的配置仍必须被拒绝（不能为了「都能显示」而放宽比较）。
  const runtime = createRuntime()
  const form = makeForm([BASE])
  const other = [Object.assign({}, BASE, { url: 'https://different.example/balance' })]
  const client = loadClient(runtime, { form, payload: payload([planOf()], hostProof(other)) })
  globalThis.fetch = async () => ({ json: async () => payload([planOf()], hostProof(other)) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('X1 负例：配置确实不同时仍拒绝显示', !/91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 币种非法值（Host 归一化为空串）也要两端一致。
  const runtime = createRuntime()
  const entry = Object.assign({}, BASE, { currency: '人民币' })
  const form = makeForm([entry])
  const client = loadClient(runtime, { form, payload: payload([planOf({ currency: '' })], hostProof([entry])) })
  globalThis.fetch = async () => ({ json: async () => payload([planOf({ currency: '' })], hostProof([entry])) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('X1 非法币种（Host 归一为空）两端仍一致', /91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 重复 id / 非法 id 的过滤规则也必须一致（Host 跳过，客户端也跳过）。
  const dupA = Object.assign({}, BASE, { currency: 'USD' })
  const dupB = Object.assign({}, BASE, { currency: 'CNY' }) // 同 id，Host 取第一条
  const bad = { id: 'not-custom', name: 'bad', url: 'https://x.example/b', balancePath: 'a', enabled: true }
  const entries = [dupA, dupB, bad]
  const runtime = createRuntime()
  const form = makeForm(entries)
  const client = loadClient(runtime, { form, payload: payload([planOf()], hostProof(entries)) })
  globalThis.fetch = async () => ({ json: async () => payload([planOf()], hostProof(entries)) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('X1 重复/非法 id 的过滤两端一致', /91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 长度边界：超长 URL 在两端都被同样截断。
  const longUrl = 'https://a.example/' + 'x'.repeat(600)
  const entry = Object.assign({}, BASE, { url: longUrl })
  const runtime = createRuntime()
  const form = makeForm([entry])
  const client = loadClient(runtime, { form, payload: payload([planOf()], hostProof([entry])) })
  globalThis.fetch = async () => ({ json: async () => payload([planOf()], hostProof([entry])) })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  const tree = await runtime.settle({ configForm: form, wide: true })
  check('X1 超长 URL 的截断两端一致', /91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// X2 — 只有 customKeyRev 变化（另一窗口保存 Key）
// ===========================================================================
{
  const runtime = createRuntime()
  const form = makeForm([BASE], {})
  const client = loadClient(runtime, { form, payload: payload([planOf()], hostProof([BASE], {})) })
  let phase = 'old'
  let gateOpen = false
  let releaseGate = null
  globalThis.fetch = async () => {
    if (phase === 'pending') {
      await new Promise((resolve) => { releaseGate = resolve })
    }
    if (phase === 'new') {
      return {
        json: async () => payload(
          [planOf({ gen: 'gen-2', balance: 12.34 })],
          hostProof([BASE], { [BASE.id]: 1 }),
        ),
      }
    }
    // old / pending：Host 仍返回 rev=0 的证明
    return { json: async () => payload([planOf()], hostProof([BASE], {})) }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('X2a 先显示 $ 91.23', /91\.23/.test(textAll(tree)), textAll(tree))

  // 另一窗口保存了该条 Key：只有公开修订号变化，本页没有 bumpConfigEpoch。
  phase = 'pending'
  form.publish({ enabled: true, planOrder: '[]', customBalances: [BASE], customKeyRev: { [BASE.id]: 1 } })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('X2b 修订变化时旧值立刻隐藏（新请求挂起期间）', !/91\.23/.test(textAll(tree)), textAll(tree))

  // 放行：Host 返回 rev=0 的旧证明 → 必须继续拒绝。
  phase = 'old'
  if (releaseGate !== null) releaseGate()
  await sleep(50)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('X2c 旧修订的证明被拒绝（不回填）', !/91\.23/.test(textAll(tree)), textAll(tree))

  // Host 已读到 rev=1 → 必须能恢复。
  phase = 'new'
  client.windowEvents.dispatch('focus')
  await sleep(50)
  tree = await runtime.settle({ configForm: form, wide: true })
  check('X2d 匹配新修订的结果被接受并显示 $ 12.34', /12\.34/.test(textAll(tree)), textAll(tree))

  // 再强刷两次仍应稳定显示（不得因闭包旧摘要而反复拒绝）。
  for (let i = 0; i < 2; i += 1) {
    client.windowEvents.dispatch('focus')
    await sleep(40)
    tree = await runtime.settle({ configForm: form, wide: true })
  }
  check('X2e 连续强刷后仍稳定显示（不被旧摘要拒绝）', /12\.34/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // A 的修订变化不能牵连 B 的基线与失败计数。
  const runtime = createRuntime()
  const B = Object.assign({}, BASE, {
    id: 'custom:round4bbbbb', name: 'B', url: 'https://b.example/balance',
    credentialHost: 'https://b.example', urlHostConfirmed: 'https://b.example',
  })
  const entries = [BASE, B]
  const form = makeForm(entries, {})
  const client = loadClient(runtime, { form, payload: payload([], hostProof(entries, {})) })
  let phase = 'ok'
  const revs = () => (phase === 'rev' ? { [BASE.id]: 1 } : {})
  globalThis.fetch = async () => {
    if (phase === 'ok') {
      return {
        json: async () => payload([
          planOf({ gen: 'gen-a1' }),
          planOf({ id: B.id, name: 'B', gen: 'gen-b1', balance: 22.22 }),
        ], hostProof(entries, {})),
      }
    }
    // A 修订变了 → 新代次；B 暂时 500（同 gen，transient）。
    return {
      json: async () => payload([
        planOf({ gen: 'gen-a2', balance: 33.33 }),
        planOf({ id: B.id, name: 'B', gen: 'gen-b1', error: 'server', transient: true, message: 'HTTP 500' }),
      ], hostProof(entries, revs())),
    }
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('X2f 基线 A 91.23 / B 22.22', /91\.23/.test(textAll(tree)) && /22\.22/.test(textAll(tree)), textAll(tree))

  phase = 'rev'
  form.publish({ enabled: true, planOrder: '[]', customBalances: entries, customKeyRev: { [BASE.id]: 1 } })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('X2g A 显示新值 33.33', /33\.33/.test(textAll(tree)), textAll(tree))
  check('X2h B 保留旧值 22.22（不因 A 的修订变化被牵连）', /22\.22/.test(textAll(tree)), textAll(tree))
  check('X2i B 没有被标成获取失败', !/获取失败/.test(textAll(tree)), textAll(tree))
  client.restore()
}

{
  // 重复保存同一把 Key（rev 再 +1）也必须能恢复。
  const runtime = createRuntime()
  const form = makeForm([BASE], { [BASE.id]: 1 })
  const client = loadClient(runtime, { form, payload: payload([planOf()], hostProof([BASE], { [BASE.id]: 1 })) })
  let rev = 1
  globalThis.fetch = async () => ({
    json: async () => payload([planOf({ gen: 'gen-same' })], hostProof([BASE], { [BASE.id]: rev })),
  })
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('X2j 幂等保存前显示 $ 91.23', /91\.23/.test(textAll(tree)), textAll(tree))

  rev = 2
  form.publish({ enabled: true, planOrder: '[]', customBalances: [BASE], customKeyRev: { [BASE.id]: 2 } })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('X2k 幂等保存后能恢复（同一 gen 也接受）', /91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

// ===========================================================================
// 双端摘要一致性（纯函数层，直接比较 Host 侧的规范化输出）
// ===========================================================================
{
  // entryPublicIdentity 必须是「规范化后」的稳定表示：同类输入得到同一结果。
  const a = entryPublicIdentity(Object.assign({}, BASE, { url: '  https://a.example/balance  ' }))
  const b = entryPublicIdentity(Object.assign({}, BASE, { url: 'https://a.example/balance' }))
  check('D1 entryPublicIdentity 对 URL 空格归一', a === b, { a, b })

  const c = entryPublicIdentity(Object.assign({}, BASE, { currency: ' usd ' }))
  const d = entryPublicIdentity(Object.assign({}, BASE, { currency: 'USD' }))
  check('D2 entryPublicIdentity 对币种大小写/空格归一', c === d, { c, d })

  const e = entryPublicIdentity(Object.assign({}, BASE, { credentialHost: 'HTTPS://A.EXAMPLE' }))
  const f = entryPublicIdentity(Object.assign({}, BASE, { credentialHost: 'https://a.example' }))
  check('D3 entryPublicIdentity 对 credentialHost 大小写归一', e === f, { e, f })

  check('D4 缺字段与显式空串等价',
    entryPublicIdentity(Object.assign({}, BASE, { subtractPath: undefined }))
    === entryPublicIdentity(Object.assign({}, BASE, { subtractPath: '' })))

  check('D5 摘要对同一份配置稳定', configDigestOf({ customBalances: [BASE] }) === configDigestOf({ customBalances: [BASE] }))
  check('D6 规范化后的摘要与原文一致',
    configDigestOf({ customBalances: [Object.assign({}, BASE, { url: ' https://a.example/balance ' })] })
    === configDigestOf({ customBalances: [BASE] }))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
