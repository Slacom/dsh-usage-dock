/**
 * 0.9.0 安全与竞态专项（离线）。
 *
 * 覆盖：
 *   ① 日志/错误脱敏：Key 不出现在 message、notice、wire 字段里（秘密哨兵）；
 *   ② 迟到响应：配置代次变化后的旧响应不得回填（Host 层用 gen 表达，客户端按 gen 丢弃）；
 *   ③ URL 重定向与 DNS 目标：redirect:'error' + 全部地址必须公网；
 *   ④ 响应体上限与解析深度；
 *   ⑤ 配置数量/长度上限（防止一条坏配置拖垮整页）。
 *
 * 用法：node tools/test-custom-security.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {

  fetchCustomBalance, fetchCustomPlans, validateBalanceUrl, verifyPublicTarget,
  readLimitedBody, parseJsonPath, collectCustomEntries, configGeneration,
  MAX_CUSTOM_RECORDS, MAX_BODY_BYTES, NAME_MAX_LEN,
} from '../plans/custom-balance.js'

// [CP-06] 本文件验证底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

const SENTINEL = 'sk-SECURITY-SENTINEL-7c1d'
const PUBLIC_RESOLVER = async () => ['93.184.216.34']
const CTX = { get: () => undefined }

function entryOf(overrides) {
  return Object.assign({
    id: 'custom:abcdef123456',
    name: '安全用例',
    url: 'https://public.example/balance',
    balancePath: 'data.balance',
    subtractPath: '',
    currency: 'CNY',
    credentialRef: '',
    // [R5] 已保存凭据必须带「已确认目标」才会发送；默认夹具按用户已确认构造。
    credentialHost: 'https://public.example',
    enabled: true,
    key: SENTINEL,
    gen: 'gen-sec0001',
  }, overrides || {})
}

async function withServer(routes, fn) {
  const log = []
  const server = createServer((req, res) => {
    log.push({ url: req.url, auth: req.headers.authorization })
    const hit = routes(req)
    if (hit === undefined) { res.writeHead(404); res.end('{}'); return }
    if (hit.redirect !== undefined) {
      res.writeHead(hit.status, Object.assign({ location: hit.redirect }, hit.headers || {}))
      res.end('')
      return
    }
    res.writeHead(hit.status || 200, hit.headers || { 'content-type': 'application/json' })
    res.end(hit.body || '')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    return await fn(base, log)
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

function transportFor(base) {
  return async (url, init) => fetch(String(url).replace('https://public.example', base), init)
}

// ---------------------------------------------------------------------------
// S1 — 秘密永不进入结果/错误文案
// ---------------------------------------------------------------------------
{
  // 各种失败路径都必须只给固定文案。
  const cases = [
    ['401', () => ({ status: 401, body: '{"error":"invalid key ' + SENTINEL + '"}' })],
    ['429', () => ({ status: 429, body: '{"msg":"rate limited"}' })],
    ['500', () => ({ status: 500, body: '{"msg":"boom ' + SENTINEL + '"}' })],
    ['404', () => ({ status: 404, body: '{}' })],
    ['坏 JSON', () => ({ status: 200, body: 'not json ' + SENTINEL })],
    ['缺键', () => ({ status: 200, body: '{"data":{}}' })],
    ['类型错', () => ({ status: 200, body: '{"data":{"balance":"' + SENTINEL + '"}}' })],
  ]
  for (const [label, hit] of cases) {
    await withServer(hit, async (base) => {
      const out = await fetchCustomBalance(CTX, undefined, {}, entryOf(), {
        transport: transportFor(base), resolveHost: PUBLIC_RESOLVER,
      })
      const text = JSON.stringify(out)
      check('S1 ' + label + '：结果里不含 Key（哨兵）', !text.includes(SENTINEL), text)
      check('S1 ' + label + '：message 不含上游原文', typeof out.message === 'string'
        && !out.message.includes('invalid key') && !out.message.includes('boom'), out.message)
    })
  }
}

// ---------------------------------------------------------------------------
// S2 — 重定向：不跟随，Authorization 不流到新 origin
// ---------------------------------------------------------------------------
{
  await withServer((req) => (req.url === '/balance'
    ? { status: 302, redirect: 'https://evil.example/steal' }
    : undefined), async (base, log) => {
    const calls = []
    const out = await fetchCustomBalance(CTX, undefined, {}, entryOf(), {
      transport: async (url, init) => {
        calls.push(String(url))
        return fetch(String(url).replace('https://public.example', base), init)
      },
      resolveHost: PUBLIC_RESOLVER,
    })
    check('S2a 3xx 视为端点错误（不当作成功）', out.error === 'endpoint' && out.balance === undefined, out)
    check('S2b 只发了一次请求（没有去追重定向目标）', calls.length === 1, calls)
    check('S2c 没有向重定向目标发请求', log.every((row) => row.url !== '/steal'), log.map((r) => r.url))
  })
}

// ---------------------------------------------------------------------------
// S3 — DNS 目标核验：解析到私网/混合/失败
// ---------------------------------------------------------------------------
{
  const privateHit = await fetchCustomBalance(CTX, undefined, {}, entryOf(), {
    transport: async () => { throw new Error('不应发请求') },
    resolveHost: async () => ['10.1.2.3'],
  })
  check('S3a 解析到私网 → config 错误（零请求）', privateHit.error === 'config' && /环回|私网/.test(privateHit.message), privateHit)

  const mixedHit = await fetchCustomBalance(CTX, undefined, {}, entryOf(), {
    transport: async () => { throw new Error('不应发请求') },
    resolveHost: async () => ['93.184.216.34', '169.254.169.254'],
  })
  check('S3b 混合结果（含云元数据地址）→ 拒绝', mixedHit.error === 'config', mixedHit)

  const dnsFail = await fetchCustomBalance(CTX, undefined, {}, entryOf(), {
    transport: async () => { throw new Error('不应发请求') },
    resolveHost: async () => { throw new Error('ENOTFOUND') },
  })
  check('S3c DNS 失败 → 暂时失败（不是语义错误）', dnsFail.error === 'network' && dnsFail.transient === true, dnsFail)

  const ipv6Private = await verifyPublicTarget('public.example', async () => ['fd12::1'])
  check('S3d IPv6 唯一本地地址被拒', ipv6Private.ok === false && ipv6Private.reason === 'private')
  const ipv6Public = await verifyPublicTarget('public.example', async () => ['2606:4700::1111'])
  check('S3e 公网 IPv6 通过', ipv6Public.ok === true)
}

// ---------------------------------------------------------------------------
// S4 — 响应体上限与解析深度
// ---------------------------------------------------------------------------
{
  const huge = await readLimitedBody({ text: async () => 'z'.repeat(MAX_BODY_BYTES + 1) })
  check('S4a 超限响应被拒（不解析）', huge.ok === false && huge.reason === 'too-large')

  // 深层嵌套路径超过 16 段必须被拒（防构造性深路径）。
  const deep = parseJsonPath('a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q')
  check('S4b 超过 16 段的路径被拒', deep.ok === false && deep.error === 'too-deep', deep)

  // 超长响应即使合法 JSON 也必须先被大小限制拦住。
  const bigJson = JSON.stringify({ data: { balance: 1, padding: 'x'.repeat(MAX_BODY_BYTES) } })
  await withServer(() => ({ status: 200, body: bigJson }), async (base) => {
    const out = await fetchCustomBalance(CTX, undefined, {}, entryOf(), {
      transport: transportFor(base), resolveHost: PUBLIC_RESOLVER,
    })
    check('S4c 大 JSON 响应被大小限制拒绝（结构错误）', out.error === 'structure' && /过大/.test(out.message), out)
  })
}

// ---------------------------------------------------------------------------
// S5 — URL 边界补充（端口/畸形/超长）
// ---------------------------------------------------------------------------
{
  const cases = [
    ['https://public.example:8443/balance', true],
    ['https://public.example:99999/balance', false],
    ['https://user@public.example/balance', false],
    ['https://public.example/balance?a=1&b=2', true],
    ['https://public.example/balance?apikey=1', false],
    ['https://public.example/balance?API_KEY=1', false],
    ['https://public.example/balance?access_token=1', false],
    ['https://' + 'a'.repeat(600) + '.example/balance', false],
    ['https://[2001:db8::1]/balance', true],
    ['https://[::ffff:127.0.0.1]/balance', false],
  ]
  let allGood = true
  for (const [url, expected] of cases) {
    const got = validateBalanceUrl(url)
    if (got.ok !== expected) { allGood = false; console.log('   ' + url.slice(0, 60) + ' → ' + JSON.stringify(got)) }
  }
  check('S5 URL 边界（端口/重复查询/Key 查询/超长/IPv6 字面量/映射地址）', allGood)
}

// ---------------------------------------------------------------------------
// S6 — 数量/长度上限：一条坏配置不拖垮整页
// ---------------------------------------------------------------------------
{
  const hugeName = 'x'.repeat(500)
  const cfg = {
    customBalances: [{
      id: 'custom:abcdef123456', name: hugeName,
      provider: 'packyapi', balancePath: 'data.balance', enabled: true,
    }],
    customKeys: { 'custom:abcdef123456': SENTINEL },
  }
  const entries = collectCustomEntries(cfg, { allowLegacy: true })
  check('S6a 超长名称被截断（不撑破布局/不拖垮配置）',
    entries.length === 1 && entries[0].name.length <= NAME_MAX_LEN, entries.length ? entries[0].name.length : null)

  const many = []
  for (let i = 0; i < MAX_CUSTOM_RECORDS + 20; i += 1) {
    many.push({ id: 'custom:' + String(i).padStart(12, '0'), name: 'n' + i, provider: 'packyapi', balancePath: 'b', enabled: true })
  }
  check('S6b 超出数量上限的多余条目被忽略（不发请求）',
    collectCustomEntries({ customBalances: many }, { allowLegacy: true }).length === MAX_CUSTOM_RECORDS)

  // 坏配置（缺 id / id 非法 / 非对象）不会导致整批失败。
  const mixed = collectCustomEntries({
    customBalances: [
      null,
      'string',
      { name: 'no id', provider: 'packyapi', balancePath: 'b' },
      { id: 'bad id', name: 'bad', provider: 'packyapi', balancePath: 'b' },
      { id: 'custom:good00000000', name: 'good', provider: 'packyapi', balancePath: 'b', enabled: true },
    ],
  })
  check('S6c 坏条目被跳过，好条目仍保留', mixed.length === 1 && mixed[0].id === 'custom:good00000000', mixed.map((e) => e.id))
}

// ---------------------------------------------------------------------------
// S7 — 迟到响应 / 代次隔离（Host 视角）
// ---------------------------------------------------------------------------
{
  // 同一 id 在配置变化后 gen 必须不同 —— 这是客户端丢弃旧响应的依据。
  const before = entryOf({ url: 'https://public.example/old', key: 'sk-old' })
  const afterUrl = entryOf({ url: 'https://public.example/new', key: 'sk-old' })
  const afterKey = entryOf({ url: 'https://public.example/old', key: 'sk-new' })
  const afterPath = entryOf({ url: 'https://public.example/old', key: 'sk-old', balancePath: 'data.other' })
  const afterCurrency = entryOf({ url: 'https://public.example/old', key: 'sk-old', currency: 'USD' })
  const gens = new Set([
    configGeneration(before), configGeneration(afterUrl), configGeneration(afterKey),
    configGeneration(afterPath), configGeneration(afterCurrency),
  ])
  check('S7a 改 URL/Key/路径/币种各自产生不同代次', gens.size === 5, [...gens])
  // 名称只用于显示，不参与身份：与**同一条**记录（同样的 url/key）比较。
  const sameIdentity = entryOf({ url: 'https://public.example/old', key: 'sk-old' })
  check('S7b 改名不改变代次', configGeneration(entryOf({
    url: 'https://public.example/old', key: 'sk-old', name: '换个名字',
  })) === configGeneration(sameIdentity))

  // 迟到的成功响应属于旧代次：它的 gen 必须与当前配置不一致，客户端据此丢弃。
  await withServer(() => ({ status: 200, body: '{"data":{"balance":99.99}}' }), async (base) => {
    const stale = await fetchCustomBalance(CTX, undefined, {}, entryOf({ gen: 'gen-old' }), {
      transport: transportFor(base), resolveHost: PUBLIC_RESOLVER,
    })
    // [R2] gen 由 Host 依据**实际身份**计算，不再透传 fixture 里的值；
    // 客户端比较的是前后两次 wire 的 gen，而不是某个外部指定值。
    check('S7c wire 携带 Host 计算的 gen（供客户端丢弃旧代次响应）',
      typeof stale.gen === 'string' && /^[0-9a-f]{10}$/.test(stale.gen) && stale.balance === 99.99, stale)
    const again = await fetchCustomBalance(CTX, undefined, {}, entryOf({ gen: 'gen-other' }), {
      transport: transportFor(base), resolveHost: PUBLIC_RESOLVER,
    })
    check('S7d 同一身份两次请求 gen 稳定（与 fixture 传入值无关）', again.gen === stale.gen, { a: stale.gen, b: again.gen })
    const changedKey = await fetchCustomBalance(CTX, undefined, {}, entryOf({ key: 'sk-different' }), {
      transport: transportFor(base), resolveHost: PUBLIC_RESOLVER,
    })
    check('S7e 换 Key 后 gen 改变', changedKey.gen !== stale.gen, { a: stale.gen, b: changedKey.gen })
  })
}

// ---------------------------------------------------------------------------
// S8 — 整批预算下不会无界等待；超时后不伪造余额
// ---------------------------------------------------------------------------
{
  const list = []
  const keys = {}
  for (let i = 0; i < 8; i += 1) {
    const id = 'custom:' + String(i).padStart(12, '0')
    list.push({ id, name: 'n' + i, provider: 'packyapi', balancePath: 'data.balance', enabled: true })
    keys[id] = 'sk-' + i + SENTINEL
  }
  const started = Date.now()
  const out = await fetchCustomPlans(CTX, undefined, { customBalances: list, customKeys: keys }, {
    transport: async () => new Promise(() => {}),
    resolveHost: PUBLIC_RESOLVER,
    budgetMs: 120,
    timeoutMs: 4000,
  })
  const elapsed = Date.now() - started
  check('S8a 整批受预算约束（< 3s 返回）', elapsed < 3000, elapsed)
  check('S8b 未完成条目为结构化失败且无余额', out.length === 8
    && out.every((row) => row.error !== undefined && row.balance === undefined), out.map((r) => r.error))
  check('S8c 失败结果不带 Key', !JSON.stringify(out).includes(SENTINEL))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
