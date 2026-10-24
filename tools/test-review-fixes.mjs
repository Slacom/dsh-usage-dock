/**
 * 0.9.0 审查整改负例（R1–R7 + 连接目标安全）。
 *
 * 这些用例**先于修复编写**：每一条都对应审查报告里一个可复现缺陷，
 * 修复前必须失败、修复后必须通过。断言按「正确行为」写，不按现状写。
 *
 * 用法：node tools/test-review-fixes.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  fetchCustomBalance, fetchCustomPlans, requestJson, collectCustomEntries,
  credentialFingerprint, generationOf, resolveValidatedAddresses, makeLookup,
  verifyPublicTarget, validateBalanceUrl, configGeneration,
} from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PUBLIC = async () => ['93.184.216.34']

function entryOf(over) {
  return Object.assign({
    id: 'custom:review123456',
    name: '审核渠道',
    url: 'https://public.example/balance',
    balancePath: 'data.balance',
    subtractPath: '',
    currency: 'CNY',
    credentialRef: '',
    credentialHost: '',
    urlHostConfirmed: '',
    enabled: true,
    key: 'sk-explicit',
  }, over || {})
}

/** 把 https://public.example 映射到本地端口；可断言请求次数。 */
function localTransport(base, state) {
  return async (url, init) => {
    if (state) { state.calls = (state.calls || 0) + 1; state.lastInit = init }
    // 每个请求显式不复用连接：本地测试服务的响应很短，keep-alive 会把 socket
    // 留在 undici 的连接池里，server.close() 之后进程退出时报 UV_HANDLE_CLOSING。
    const merged = Object.assign({}, init, { headers: Object.assign({ connection: 'close' }, init.headers || {}) })
    return fetch(String(url).replace('https://public.example', base), merged)
  }
}

async function withServer(routes, fn) {
  const log = []
  const server = createServer((req, res) => {
    log.push({ url: req.url, auth: req.headers.authorization })
    const hit = typeof routes === 'function' ? routes(req) : routes[req.url]
    if (hit === undefined) { res.writeHead(404); res.end('{}'); return }
    res.writeHead(hit.status || 200, { 'content-type': 'application/json' })
    res.end(hit.body || '')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  try { return await fn(base, log) } finally { await new Promise((r) => server.close(() => r())) }
}

// ===========================================================================
// R1 — 预算必须覆盖排队 / 凭据 / DNS / 连接 / body
// ===========================================================================
{
  await withServer({ '/balance': { body: JSON.stringify({ data: { balance: 12 } }) } }, async (base) => {
    // DNS 慢 80ms，总预算 15ms：必须在预算内失败，而不是成功。
    // 注意：这条 entry 不带已保存 Key（未走过 R5 的目标确认），才能命中预算分支。
    const started = Date.now()
    const out = await fetchCustomPlans({ get: () => undefined }, undefined, {
      customBalances: [entryOf({ key: '' })],
      customKeys: {},
    }, {
      allowLegacy: true,
      transport: localTransport(base),
      resolveHost: async () => { await sleep(80); return ['93.184.216.34'] },
      resolveHostKey: 'unused',
      budgetMs: 15,
      timeoutMs: 10,
      // 用 pendantKey 走「新录入 Key」路径，跳过已保存凭据的目标确认。
      pendingKey: 'sk-pending',
    })
    const elapsed = Date.now() - started
    /**
     * [CP-05] 现在**来源解析本身也受同一预算约束**：预算耗尽时条目可能根本不产出。
     * 因此这里接受两种正确结果，都满足"不返回成功余额"：
     *   - 条目被预算丢弃（`out.length === 0`）；
     *   - 条目产出结构化失败（`error === 'network'`）。
     * 共同点是**绝不返回成功余额**、且总耗时受预算约束。
     */
    const noSuccessBalance = out.length === 0
      || (out[0] !== undefined && out[0].balance === undefined)
    check('R1a DNS 慢于预算时不返回成功余额', noSuccessBalance, out)
    check('R1b DNS 慢于预算时总耗时受预算约束（< 200ms）', elapsed < 200, elapsed)
    check('R1c 超预算条目被丢弃或为结构化失败、且零成功余额',
      out.length === 0
      || (out[0].transient === true && out[0].error === 'network'),
      out)
  })
}

{
  // 凭据解析永久挂起：整批不得无限等待。
  const started = Date.now()
  const out = await fetchCustomPlans({
    get: (n) => (n === 'credentials' ? { resolve: () => new Promise(() => {}) } : undefined),
  }, undefined, {
    customBalances: [entryOf({ key: '', credentialRef: 'TEST_KEY', credentialHost: 'public.example' })],
    customKeys: {},
  }, {
    allowLegacy: true,
    transport: async () => { throw new Error('不应发请求') },
    resolveHost: PUBLIC,
    budgetMs: 40,
    timeoutMs: 20,
  })
  const elapsed = Date.now() - started
  check('R1d 凭据解析挂起时整批仍按预算返回', elapsed < 400, elapsed)
  // [CP-05] 凭据解析挂起时条目可能被预算丢弃；两种结果都不得出现成功余额。
  check('R1e 凭据挂起 → 该条被丢弃或为结构化失败、且无余额',
    out.length === 0 || (out[0].balance === undefined && out[0].error !== undefined), out)
}

{
  // 迟到的 DNS 结果不得再触发请求（transport 调用数为 0）。
  let transportCalls = 0
  const out = await fetchCustomPlans({ get: () => undefined }, undefined, {
    customBalances: [entryOf()],
    customKeys: { 'custom:review123456': 'sk-explicit' },
  }, {
    allowLegacy: true,
    transport: async () => { transportCalls += 1; throw new Error('不应发请求') },
    resolveHost: async () => { await sleep(60); return ['93.184.216.34'] },
    budgetMs: 20,
  })
  await sleep(120) // 等迟到任务彻底结束
  check('R1f 迟到的 DNS 结果不再发请求', transportCalls === 0, transportCalls)
  check('R1g 迟到任务不回填余额', out[0].balance === undefined, out[0])
}

{
  // body 读取挂起也要受预算约束（之前只 race 到 response 头）。
  const slowBody = async () => ({
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
  })
  const started = Date.now()
  const out = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf(), {
    allowLegacy: true,
    transport: slowBody, resolveHost: PUBLIC, timeoutMs: 40,
  })
  const elapsed = Date.now() - started
  check('R1h body 读取挂起受超时约束', elapsed < 500 && out.balance === undefined, { elapsed, out })
}

// ===========================================================================
// R2 — 模型凭据引用换 Key 必须换代次（不能沿用旧账户余额）
// ===========================================================================
{
  let keyValue = 'key-account-A'
  const ctx = { get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: keyValue }) } : undefined) }
  const entry = entryOf({ key: '', credentialRef: 'TEST_KEY', credentialHost: 'public.example' })
  const baseCfg = { customBalances: [], customKeys: {} }

  await withServer({ '/balance': { body: JSON.stringify({ data: { balance: 91 } }) } }, async (base) => {
    const transport = localTransport(base)
    const a = await fetchCustomBalance(ctx, undefined, baseCfg, entry, { transport, resolveHost: PUBLIC })
    keyValue = 'key-account-B'
    const b = await fetchCustomBalance(ctx, undefined, baseCfg, entry, { transport, resolveHost: PUBLIC })
    check('R2a 引用解析到的 Key 轮换后代次必须改变', a.gen !== b.gen, { a: a.gen, b: b.gen })
    check('R2b 代次不含明文 Key', !String(a.gen).includes('key-account') && !String(b.gen).includes('key-account'))

    keyValue = ''
    const cleared = await fetchCustomBalance(ctx, undefined, baseCfg, entry, { transport, resolveHost: PUBLIC })
    check('R2c 引用被清空后代次与成功代次不同', cleared.gen !== a.gen, cleared.gen)
    check('R2d 引用被清空 → no-key 语义错误', cleared.error === 'no-key', cleared)

    const throwing = { get: (n) => (n === 'credentials' ? { resolve: async () => { throw new Error('boom') } } : undefined) }
    const failed = await fetchCustomBalance(throwing, undefined, baseCfg, entry, { transport, resolveHost: PUBLIC })
    check('R2e 引用解析失败 → no-key 且代次失效', failed.error === 'no-key' && failed.gen !== a.gen, failed)
  })
}

{
  // 显式 Key 与引用 Key 用同一套身份指纹：同 Key 同 gen，不同 Key 不同 gen。
  check('R2f 相同 Key 的指纹稳定', credentialFingerprint('sk-same') === credentialFingerprint('sk-same'))
  check('R2g 不同 Key 的指纹不同', credentialFingerprint('sk-a') !== credentialFingerprint('sk-b'))
  check('R2h 指纹不含明文', !credentialFingerprint('sk-plain-text').includes('sk-plain'))
  check('R2i 空 Key 有专门标记（与任何真实 Key 不同）',
    credentialFingerprint('') !== credentialFingerprint('sk-a'))
}

// ===========================================================================
// R5 — 显式已保存 Key 也必须执行目标绑定
// ===========================================================================
{
  let calls = 0
  const out = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf({
    key: 'synthetic-existing-key',
    url: 'https://new-target.example/balance',
    credentialHost: '',
    urlHostConfirmed: '',
  }), {
    allowLegacy: true,
    transport: async () => { calls += 1; return { status: 200, text: async () => '{}' } },
    resolveHost: PUBLIC,
  })
  check('R5a 已保存显式 Key 在目标未确认时零请求', calls === 0, calls)
  check('R5b 返回可操作的「凭据目标未确认」错误',
    out.error === 'credential-unconfirmed' && /确认/.test(out.message), out)
  check('R5c 该错误是语义错误（不灰化）', out.transient !== true, out)
}

{
  // 确认后放行；且 origin 规范化（默认端口 / 大小写）不影响判定。
  let calls = 0
  const out = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf({
    key: 'synthetic-existing-key',
    url: 'https://Public.Example:443/balance',
    credentialHost: 'public.example',
  }), {
    allowLegacy: true,
    transport: async () => { calls += 1; return { status: 200, text: async () => JSON.stringify({ data: { balance: 5 } }) } },
    resolveHost: PUBLIC,
  })
  check('R5d 已确认目标（含默认端口/大小写规范化）后正常发送', calls === 1 && out.balance === 5, { calls, out })
}

{
  // 改了 URL 主机但确认字段还停留在旧主机 → 拒绝。
  let calls = 0
  const out = await fetchCustomBalance({ get: () => undefined }, undefined, {}, entryOf({
    key: 'synthetic-existing-key',
    url: 'https://changed.example/balance',
    credentialHost: 'old.example',
  }), {
    allowLegacy: true,
    transport: async () => { calls += 1; return { status: 200, text: async () => '{}' } },
    resolveHost: PUBLIC,
  })
  check('R5e 目标主机变化后旧确认失效（零请求）', calls === 0 && out.error === 'credential-unconfirmed', { calls, out })
}

// ===========================================================================
// 安全 — 连接目标必须绑定到已验证 IP（不能只做独立 DNS 检查）
// ===========================================================================
{
  const resolved = await resolveValidatedAddresses('public.example', async () => ['93.184.216.34', '2606:4700::1111'])
  check('安全a 解析出全部公网地址', resolved.ok === true && resolved.addresses.length === 2, resolved)

  const mixed = await resolveValidatedAddresses('evil.example', async () => ['93.184.216.34', '10.0.0.5'])
  check('安全b 混合地址整体拒绝', mixed.ok === false && mixed.reason === 'private', mixed)

  // 关键：连接期 lookup 只能返回已验证 IP，且不再调用解析器（杜绝重绑定）。
  const lookup = makeLookup(resolved.addresses)
  const got = await new Promise((resolve, reject) => lookup('public.example', { family: 4 }, (err, addr, fam) => (err ? reject(err) : resolve({ addr, fam }))))
  check('安全c 连接期 lookup 返回已验证 IP', got.addr === '93.184.216.34' && got.fam === 4, got)

  const all = await new Promise((resolve, reject) => lookup('public.example', { all: true }, (err, list) => (err ? reject(err) : resolve(list))))
  check('安全d all:true 时也只返回已验证列表', Array.isArray(all) && all.length === 2, all)

  // 传入非法主机名也不会被重新解析（lookup 忽略 hostname）。
  const spoofed = await new Promise((resolve) => lookup('attacker.example', { family: 4 }, (err, addr) => resolve(addr)))
  check('安全e lookup 不理会调用方给的主机名（绑定已核验地址）', spoofed === '93.184.216.34', spoofed)

  // 私网地址永远进不了 lookup。
  const privateOnly = await resolveValidatedAddresses('meta.example', async () => ['169.254.169.254'])
  check('安全f 云元数据地址被拒（不生成连接绑定）', privateOnly.ok === false, privateOnly)
}

{
  // requestJson 必须把「已核验地址」交给传输层作为连接约束，而不是让传输层自己解析。
  let seen = null
  const out = await requestJson('https://public.example/balance', 'sk-x', {
    target: { host: 'public.example', addresses: [{ address: '93.184.216.34', family: 4 }] },
    allowLegacy: true,
    transport: async (url, init) => {
      seen = init
      return { status: 200, text: async () => '{"ok":true}' }
    },
  })
  check('安全g 传输层收到 lookup 约束', out.kind === 'response' && typeof seen.lookup === 'function', { out, hasLookup: seen && typeof seen.lookup })
  if (seen && typeof seen.lookup === 'function') {
    const addr = await new Promise((resolve) => seen.lookup('anything', { family: 4 }, (err, a) => resolve(a)))
    check('安全h 该 lookup 返回已核验 IP', addr === '93.184.216.34', addr)
  }
  check('安全i servername 保留真实主机名（TLS SNI 不被 IP 取代）',
    seen !== null && seen.servername === 'public.example', seen && seen.servername)
}

{
  // ★ 连接期绑定必须真的生效：用自签证书起一个本地 TLS 服务，
  //   把「public.example」核验为 127.0.0.1，确认请求真的连上了本地服务
  //   （证明 lookup 生效、而不是又去解析 DNS），且 SNI 送的是真实域名。
  const { generateKeyPairSync, createSign } = await import('node:crypto')
  const tls = await import('node:tls')

  // 手工拼一张自签证书：不需要 openssl，也不需要外部依赖。
  function selfSignedCert(commonName) {
    // 极简 DER 编码器（只够拼 X.509 v3）。
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
    const sigAlg = seq(oid('2a864886f70d01010b'), nul()) // sha256WithRSAEncryption
    const name = seq(set(seq(oid('550403'), utf8(commonName)))) // CN
    const validity = seq(tlv(0x17, Buffer.from('250101000000Z')), tlv(0x17, Buffer.from('350101000000Z')))
    const tbs = seq(
      ctx(0, int(Buffer.from([0x02]))), // v3
      int(Buffer.from([0x01])),
      sigAlg,
      name,
      validity,
      name,
      spki,
    )
    const signer = createSign('sha256')
    signer.update(tbs)
    const sig = signer.sign(privateKey)
    return { cert: seq(tbs, sigAlg, bitStr(sig)), key: privateKey }
  }

  const self = selfSignedCert('public.example')
  // tls.createServer 要 PEM 文本，不是 DER Buffer。
  const toPem = (der, label) => '-----BEGIN ' + label + '-----\n'
    + der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END ' + label + '-----\n'

  const server = tls.createServer({
    cert: toPem(self.cert, 'CERTIFICATE'),
    key: self.key.export({ type: 'pkcs8', format: 'pem' }),
  }, (socket) => {
    socket.on('data', () => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 17\r\n\r\n{"data":{"balance":5}}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  // 让「public.example」的 443 端口请求改到本地随机端口：这里直接构造带端口的 URL，
  // 目标主机仍是 public.example，lookup 由我们钉死到 127.0.0.1。
  const previousReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1' // 明确保持校验开启（不能关）

  try {
    const out = await requestJson('https://public.example:' + port + '/balance', 'sk-x', {
      target: {
        host: 'public.example',
        addresses: [{ address: '127.0.0.1', family: 4 }],
      },
      // 自签证书：用自定义校验确认「传进来的 servername 就是真实域名」，
      // 既证明 SNI 正确，也不用为了测试放宽全局校验。
      servernameCheck: true,
      timeoutMs: 4000,
    })
    // 证书是自签的且 CN 与目标一致；node 默认会拒绝自签。
    // 关键是三点同时成立：
    //   ① 连接确实到达了本地服务（不是 ECONNREFUSED / DNS 失败）；
    //   ② 失败原因是**证书校验**（说明 TLS 校验没有被关闭）；
    //   ③ detail 被归为 tls（用户可以据此排查证书而不是网络）。
    check('安全j 连接期 lookup 生效：请求真的连到已核验 IP（TLS 校验仍开启）',
      out.kind === 'network' && (out.detail === 'tls' || out.detail === 'transport'),
      out)
    check('安全k TLS 证书错误被单独归类、不被误报成「网络不可达」',
      out.detail === 'tls' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(out.code || '')),
      out)
  } finally {
    if (previousReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousReject
    await new Promise((resolve) => server.close(resolve))
  }
}

{
  // ★ 正向：pinned 传输层能完整读取 HTTPS 响应体。
  //   用「额外信任这张自签 CA」的方式通过校验——**不关** TLS 校验
  //   （不设 NODE_TLS_REJECT_UNAUTHORIZED，产品代码也没有关闭分支）。
  const { generateKeyPairSync, createSign } = await import('node:crypto')
  const tls = await import('node:tls')

  function selfSigned() {
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
    const name = seq(set(seq(oid('550403'), utf8('public.example'))))
    const validity = seq(tlv(0x17, Buffer.from('250101000000Z')), tlv(0x17, Buffer.from('350101000000Z')))
    const tbs = seq(ctx(0, int(Buffer.from([0x02]))), int(Buffer.from([0x01])), sigAlg, name, validity, name, spki)
    const signer = createSign('sha256')
    signer.update(tbs)
    const sig = signer.sign(privateKey)
    return { cert: seq(tbs, sigAlg, bitStr(sig)), key: privateKey }
  }
  const self = selfSigned()
  const toPem = (der, label) => '-----BEGIN ' + label + '-----\n'
    + der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END ' + label + '-----\n'
  const certPem = toPem(self.cert, 'CERTIFICATE')

  const server = tls.createServer({ cert: certPem, key: self.key.export({ type: 'pkcs8', format: 'pem' }) }, (socket) => {
    socket.once('data', () => {
      const body = '{"data":{"balance":77.5}}'
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const out = await requestJson('https://public.example:' + port + '/balance', 'sk-x', {
      target: { host: 'public.example', addresses: [{ address: '127.0.0.1', family: 4 }] },
      tlsCa: certPem,
      timeoutMs: 4000,
    })
    check('安全l pinned HTTPS 传输层能完整读取响应体（真实 TLS 往返，校验证书未关闭）',
      out.kind === 'response' && out.status === 200 && out.body.ok === true
      && /77\.5/.test(String(out.body.text)), out)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ===========================================================================
// R4 / R3 的 Host 侧契约：错误行保留 custom 身份
// ===========================================================================
{
  // 单条暂时失败时 wire 必须保留 custom/gen，供客户端识别为自定义条目。
  const out = await fetchCustomPlans({ get: () => undefined }, undefined, {
    customBalances: [entryOf()],
    customKeys: { 'custom:review123456': 'sk-explicit' },
  }, {
    allowLegacy: true,
    transport: async () => { throw new TypeError('fetch failed') },
    resolveHost: PUBLIC,
  })
  check('R4a 失败 wire 仍带 custom:true 与 gen', out[0].custom === true && typeof out[0].gen === 'string', out[0])
  check('R4b 失败 wire 不带余额', out[0].balance === undefined, out[0])
}

{
  // 停用条目：enabled:false + 仍带身份（便于客户端清理），且不请求。
  let calls = 0
  const out = await fetchCustomPlans({ get: () => undefined }, undefined, {
    customBalances: [entryOf({ enabled: false })],
    customKeys: { 'custom:review123456': 'sk-explicit' },
  }, { transport: async () => { calls += 1 }, resolveHost: PUBLIC })
  check('R4c 停用条目零请求', calls === 0, calls)
  check('R4d 停用条目明确标记 enabled:false', out[0].enabled === false, out[0])
}

// ===========================================================================
// R7 — 真实 Config → apply → provider 的解包（本文件只测 provider 侧契约）
// ===========================================================================
{
  const cfg = {
    deepseekApiKey: { get: () => 'sk-synthetic-test' },
    deepseekEnabled: { get: () => true },
    deepseekWarnThreshold: { get: () => 10 },
    mimoCookie: { get: () => '' },
    customBalances: { get: () => [] },
    customKeys: { get: () => ({}) },
  }
  const entries = collectCustomEntries(cfg, { allowLegacy: true })
  check('R7a collectCustomEntries 能解包 volatile 的 customBalances', Array.isArray(entries) && entries.length === 0, entries)

  // 内置 provider 侧：util 的凭据解析必须看到字符串而不是包装对象。
  const { resolveApiKey } = await import('../plans/util.js')
  const key = await resolveApiKey({ get: () => undefined }, cfg, 'deepseekApiKey', ['DEEPSEEK_API_KEY'])
  check('R7b resolveApiKey 直接读包装对象时拿不到 Key（现状缺陷，Host 必须先行解包）', key === undefined, key)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
