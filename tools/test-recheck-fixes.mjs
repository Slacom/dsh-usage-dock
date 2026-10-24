/**
 * 0.9.0 整改复核（V1–V5）复现与回归。
 *
 * 对应 [复核报告](docs/recheck-v0.9.0-remediation.md) 第 2 节：
 *   V1 非默认端口 origin 计算错误（正确确认被拒、旧 443 确认却能发到 8443）
 *   V2 已渲染 state 未即时作废（改 URL/币种后旧余额仍显示到新响应返回）
 *   V3 单条预算失效（子预算直接继承整批 deadline）
 *   V4 首次并发初始化返回 undefined → TypeError
 *   V5 连接中断被吞成 EOF，截断正文被当成功
 *
 * 前 4 项是纯函数/模块级，V2 需要真实 client.js（mock React），V5 需要真实 TLS 往返。
 * 用法：node tools/test-recheck-fixes.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createServer as createTlsServer } from 'node:tls'
import { createSign, generateKeyPairSync } from 'node:crypto'
import {
  validateBalanceUrl, fetchCustomBalance, fetchCustomPlans, requestJson,
  createBudget, originOf, normalizeOriginField, collectCustomEntries,
  resolveValidatedAddresses, makeLookup, configDigestOf,
} from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PUBLIC = async () => ['93.184.216.34']

function entryOf(over) {
  return Object.assign({
    id: 'custom:recheck12345',
    name: '复核渠道',
    url: 'https://a.example:8443/balance',
    balancePath: 'data.balance',
    subtractPath: '',
    currency: 'CNY',
    credentialRef: '',
    credentialHost: 'https://a.example:8443',
    urlHostConfirmed: 'https://a.example:8443',
    enabled: true,
    key: 'sk-explicit',
  }, over || {})
}

// ===========================================================================
// V1 — 非默认端口的 origin 语义必须一致
// ===========================================================================
{
  // ① validateBalanceUrl 必须把可比较的 origin 一起返回（不能只给 hostname）。
  const target = validateBalanceUrl('https://a.example:8443/balance')
  check('V1a validateBalanceUrl 接受非默认端口', target.ok === true, target)
  check('V1b 返回结果带可比较的 origin（含端口）',
    typeof target.origin === 'string' && target.origin === 'https://a.example:8443', target.origin)

  // ② originOf 对 {protocol, hostname, port} 与对 URL 必须给出同一结果。
  check('V1c originOf({protocol,hostname,port}) 含非默认端口',
    originOf({ protocol: 'https:', hostname: 'a.example', port: '8443' }) === 'https://a.example:8443',
    originOf({ protocol: 'https:', hostname: 'a.example', port: '8443' }))
  check('V1d 默认端口省略',
    originOf({ protocol: 'https:', hostname: 'a.example', port: '443' }) === 'https://a.example'
    && originOf({ protocol: 'https:', hostname: 'a.example', port: '' }) === 'https://a.example')
  check('V1e 不把普通域名当成 IPv6（冒号只可能来自端口）',
    originOf({ protocol: 'https:', hostname: 'a.example', port: '8443' }).indexOf('[') === -1)

  // ③ 已保存的确认字符串规范化后必须与自身相等（幂等）。
  check('V1f normalizeOriginField 对带端口的 origin 幂等',
    normalizeOriginField('https://a.example:8443') === 'https://a.example:8443',
    normalizeOriginField('https://a.example:8443'))
  check('V1g normalizeOriginField 处理大小写/尾点/前导零端口',
    normalizeOriginField('https://A.Example.:08443/') === 'https://a.example:8443',
    normalizeOriginField('https://A.Example.:08443/'))
  check('V1h IPv6 字面量加方括号且端口只出现一次',
    normalizeOriginField('https://[2001:db8::1]:8443/') === 'https://[2001:db8::1]:8443',
    normalizeOriginField('https://[2001:db8::1]:8443/'))
  check('V1i 默认端口不重复追加',
    normalizeOriginField('https://a.example:443/') === 'https://a.example',
    normalizeOriginField('https://a.example:443/'))
}

{
  // ④ 端到端：正确的 8443 确认必须能发请求；旧的 443 确认必须零请求。
  let calls = 0
  const okOut = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf(), {
    allowLegacy: true,
    transport: async () => { calls += 1; return { status: 200, text: async () => JSON.stringify({ data: { balance: 1 } }) } },
    resolveHost: PUBLIC,
  })
  check('V1j 正确的 :8443 确认可以发送（不是被拒绝）', calls === 1 && okOut.balance === 1, { calls, out: okOut })

  let staleCalls = 0
  const staleOut = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf({ credentialHost: 'https://a.example' }), {
    allowLegacy: true,
    transport: async () => { staleCalls += 1; return { status: 200, text: async () => JSON.stringify({ data: { balance: 1 } }) } },
    resolveHost: PUBLIC,
  })
  check('V1k 旧的 443 确认不得向 8443 发送（零请求）', staleCalls === 0, staleCalls)
  check('V1l 跨端口视同跨 origin → credential-unconfirmed', staleOut.error === 'credential-unconfirmed', staleOut)

  // ⑤ 只改端口也要拒绝。
  let portCalls = 0
  const portOut = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf({
    url: 'https://a.example:9443/balance', credentialHost: 'https://a.example:8443',
  }), {
    allowLegacy: true,
    transport: async () => { portCalls += 1; return { status: 200, text: async () => '{}' } },
    resolveHost: PUBLIC,
  })
  check('V1m 只改端口也视同跨 origin（零请求）', portCalls === 0 && portOut.error === 'credential-unconfirmed', { portCalls, out: portOut })
}

// ===========================================================================
// V3 — 单条 deadline 必须是 min(now+perItem, batchDeadline)
// ===========================================================================
{
  const near = createBudget(10, Date.now() + 5000)
  check('V3a 子预算不被更远的整批 deadline 放大',
    near.remaining() <= 60, near.remaining())
  const far = createBudget(10, Date.now() + 5)
  check('V3b 子预算取两者较小值（整批更近时用整批）',
    far.remaining() <= 60, far.remaining())
  // [测试稳定性] 原写法是 `createBudget(1, now+5000).expired === false`：它要求
  // 「构造后立刻读取时 1ms 预算尚未用完」，依赖墙钟跳变与调度速度，偶发失败
  // （第五轮复核首跑即命中）。这里改成**确定性**断言，产品语义（取两者较小值）不变：
  //   - 两个 deadline 都远离现在 → 未过期；
  //   - 整批 deadline 已在过去 → 立即过期（证明取的是较小值，而不是被 perItem 放大）。
  const generous = createBudget(5000, Date.now() + 60000)
  check('V3c 两个 deadline 都在未来时未过期', generous.expired === false && generous.remaining() > 0,
    { expired: generous.expired, remaining: generous.remaining() })
  const pastBatch = createBudget(60000, Date.now() - 1)
  check('V3d 整批 deadline 已过期时立即过期（取较小值）',
    pastBatch.expired === true, pastBatch.expired)
}

{
  // 端到端：单条 15ms、整批 120ms、DNS 65ms → 单条必须到期且零请求。
  let calls = 0
  const started = Date.now()
  const out = await fetchCustomPlans({ get: () => undefined }, undefined, {
    customBalances: [entryOf({ key: '' })],
    customKeys: {},
  }, {
    allowLegacy: true,
    transport: async () => { calls += 1; return { status: 200, text: async () => JSON.stringify({ data: { balance: 12 } }) } },
    resolveHost: async () => { await sleep(65); return ['93.184.216.34'] },
    budgetMs: 120,
    timeoutMs: 15,
    pendingKey: 'sk-pending',
  })
  const elapsed = Date.now() - started
  check('V3d 单条 15ms 到期后不再发请求（迟到 DNS 零发送）', calls === 0, calls)
  check('V3e 单条到期返回结构化暂时失败', out[0].transient === true && out[0].balance === undefined, out[0])
  check('V3f 单条到期时间明显短于整批预算（< 100ms）', elapsed < 100, elapsed)
}

// ===========================================================================
// V4 — 首次并发初始化不得暴露 undefined
// ===========================================================================
{
  // 用查询串取一份**全新模块实例**（同一进程内冷启动），避开前面用例的预热。
  const fresh = await import('../plans/custom-balance.js?cold=' + Date.now())
  const results = await Promise.allSettled([
    fresh.requestJson('https://a.example:9/x', 'k', { target: { host: 'a.example', addresses: [{ address: '127.0.0.1', family: 4 }] }, timeoutMs: 1500 }),
    fresh.requestJson('https://a.example:9/x', 'k', { target: { host: 'a.example', addresses: [{ address: '127.0.0.1', family: 4 }] }, timeoutMs: 1500 }),
    fresh.requestJson('https://a.example:9/x', 'k', { target: { host: 'a.example', addresses: [{ address: '127.0.0.1', family: 4 }] }, timeoutMs: 1500 }),
  ])
  const rejected = results.filter((r) => r.status === 'rejected')
  check('V4a 冷启动三个并发请求都不抛异常', rejected.length === 0,
    rejected.map((r) => String(r.reason && r.reason.message)).slice(0, 3))
  const kinds = results.map((r) => (r.status === 'fulfilled' && r.value ? r.value.kind : 'rejected'))
  check('V4b 都返回结构化的 network 结果', kinds.every((k) => k === 'network'), kinds)
}

// ===========================================================================
// V5 — 截断/中断的 HTTP 正文不得被当成成功
// ===========================================================================
function selfSigned(commonName) {
  const len = (n) => {
    if (n < 0x80) return Buffer.from([n])
    const bytes = []
    let v = n
    while (v > 0) { bytes.unshift(v & 0xff); v >>= 8 }
    return Buffer.from([0x80 | bytes.length].concat(bytes))
  }
  const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
  const seq = (...items) => tlv(0x30, Buffer.concat(items))
  const set = (...items) => tlv(0x31, Buffer.concat(items))
  const int = (buf) => tlv(0x02, buf)
  const nul = () => Buffer.from([0x05, 0x00])
  const oid = (str) => tlv(0x06, Buffer.from(str, 'hex'))
  const utf8 = (str) => tlv(0x0c, Buffer.from(str, 'utf8'))
  const bitStr = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]))
  const ctx = (n, body) => tlv(0xa0 + n, body)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const sigAlg = seq(oid('2a864886f70d01010b'), nul())
  const name = seq(set(seq(oid('550403'), utf8(commonName))))
  const validity = seq(tlv(0x17, Buffer.from('250101000000Z')), tlv(0x17, Buffer.from('350101000000Z')))
  const tbs = seq(ctx(0, int(Buffer.from([0x02]))), int(Buffer.from([0x01])), sigAlg, name, validity, name, spki)
  const signer = createSign('sha256')
  signer.update(tbs)
  const sig = signer.sign(privateKey)
  return { cert: seq(tbs, sigAlg, bitStr(sig)), key: privateKey }
}
const toPem = (der, label) => '-----BEGIN ' + label + '-----\n'
  + der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END ' + label + '-----\n'

async function withTlsServer(handler, fn) {
  const self = selfSigned('a.example')
  const certPem = toPem(self.cert, 'CERTIFICATE')
  const server = createTlsServer({ cert: certPem, key: self.key.export({ type: 'pkcs8', format: 'pem' }) }, handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(server.address().port, certPem)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

{
  // ① 声明 100 字节、只发合法 JSON 前缀就断开 → 必须是网络/结构失败，不能是成功余额。
  await withTlsServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"data":{"balance":1}}')
      // 立刻断开：正文比声明的短得多
      setTimeout(() => { try { socket.destroy() } catch (err) { /* 已关 */ } }, 10)
    })
  }, async (port, ca) => {
    const out = await requestJson('https://a.example:' + port + '/balance', 'k', {
      target: { host: 'a.example', addresses: [{ address: '127.0.0.1', family: 4 }] },
      tlsCa: ca,
      timeoutMs: 3000,
    })
    const text = out.kind === 'response' && out.body ? String(out.body.text || '') : ''
    check('V5a 截断正文不得被判为成功响应体',
      !(out.kind === 'response' && out.body && out.body.ok === true && /balance/.test(text)),
      out)
  })
}

{
  // ② 正常完整响应仍要成功（回归）。
  await withTlsServer((socket) => {
    socket.once('data', () => {
      const body = '{"data":{"balance":9}}'
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: '
        + Buffer.byteLength(body) + '\r\n\r\n' + body)
    })
  }, async (port, ca) => {
    const out = await requestJson('https://a.example:' + port + '/balance', 'k', {
      target: { host: 'a.example', addresses: [{ address: '127.0.0.1', family: 4 }] },
      tlsCa: ca,
      timeoutMs: 3000,
    })
    check('V5b 完整响应仍被正常读取',
      out.kind === 'response' && out.body.ok === true && /balance/.test(String(out.body.text)), out)
  })
}

// ===========================================================================
// V2 — 已渲染 state 必须在配置身份变化时立即作废（真实 client.js）
// ===========================================================================
{
  const { createRuntime, loadClient, textOf } = await import('./mock-react.mjs')
  const runtime = createRuntime()
  const listeners = new Set()
  const ENTRY = {
    id: 'custom:recheckv2aaaa', name: 'A', url: 'https://a.example/balance',
    balancePath: 'data.balance', subtractPath: '', currency: 'USD',
    credentialRef: '', credentialHost: 'https://a.example', urlHostConfirmed: 'https://a.example',
    enabled: true,
  }
  const form = {
    value: { enabled: true, planOrder: '[]', customBalances: [ENTRY] },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set() { return Promise.resolve(true) },
    publish(next) { this.value = next; listeners.forEach((fn) => fn()) },
  }
  const client = loadClient(runtime, {
    form,
    // [W1] 新契约：响应带 Host 的配置证明（摘要对应**当前**配置）。
    payload: {
      ok: true,
      data: {
        plans: [{ id: ENTRY.id, name: 'A', custom: true, gen: 'g1', currency: 'USD', balance: 91.23 }],
        cfg: { digest: configDigestOf({ customBalances: [ENTRY] }), readAt: Date.now(), reloadable: true },
      },
    },
  })
  const textAll = (node) => {
    const out = []
    const walk = (n, d) => {
      if (n === null || n === undefined || d > 10) return
      if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
      if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return }
      if (typeof n === 'object') {
        if (typeof n.type === 'string') { walk(n.props && n.props.children, d + 1); return }
        walk(n.props && n.props.children, d + 1)
      }
    }
    walk(node, 0)
    return out.join('')
  }
  runtime.mount(client.Badge, { configForm: form, wide: true })
  let tree = await runtime.settle({ configForm: form, wide: true })
  check('V2a 先显示成功余额 $ 91.23', /91\.23/.test(textAll(tree)), textAll(tree))

  // 改 URL + 币种；Host 仍可能回旧快照（同一 gen）。
  form.publish({
    enabled: true, planOrder: '[]',
    customBalances: [Object.assign({}, ENTRY, { url: 'https://b.example/balance', credentialHost: 'https://b.example', currency: 'CNY' })],
  })
  tree = await runtime.settle({ configForm: form, wide: true })
  check('V2b 身份变化后旧余额立刻消失（不等新响应）', !/91\.23/.test(textAll(tree)), textAll(tree))
  client.restore()
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
