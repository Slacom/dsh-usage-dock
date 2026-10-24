/**
 * plans/custom-balance.js 的网络侧测试（0.9.0 C3）：真实本地 HTTP 服务 + 注入 transport。
 *
 * 覆盖：
 *   - 请求形态（GET / Authorization: Bearer / Accept: application/json / 不跟随重定向）
 *   - 成功路径：直接键、可选扣减、币种、via 标记
 *   - 凭据：显式 Key 优先；模型凭据引用仅在被明确选择且目标主机已确认时才用
 *   - 错误分类：401 语义立即、429/5xx 暂时、非 JSON、缺键、超大响应
 *   - 停用条目不请求；单条失败不影响其他条目
 *   - 并发上限与整批预算（虚拟时钟）
 *   - 秘密不外泄：结果里没有 Key / 完整 URL / 原始响应
 *
 * 用法：node tools/test-custom-balance-fetch.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  fetchCustomBalance, fetchCustomPlans, collectCustomEntries,
  MAX_BODY_BYTES, CONCURRENCY,
} from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

/** 每轮测试用一个本地服务；requestLog 记录服务端真实收到的请求。 */
async function withServer(routes, fn) {
  const log = []
  const server = createServer((req, res) => {
    log.push({ method: req.method, url: req.url, headers: req.headers })
    const hit = typeof routes === 'function' ? routes(req) : routes[req.url]
    if (hit === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(hit.status, hit.headers || { 'content-type': 'application/json' })
    res.end(hit.body === undefined ? '' : hit.body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    return await fn(base, log)
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

/**
 * 本地服务是 127.0.0.1（正是我们在生产里**拒绝**的地址），因此网络测试统一
 * 注入一个「假装公网」的 transport：把 https://public.example 映射到本地端口。
 * 这样既能跑真实 HTTP 往返，又不用在测试里放宽生产安全规则。
 */
function localTransport(base, options) {
  const opts = options || {}
  return async (url, init) => {
    const mapped = String(url).replace('https://public.example', base)
    const real = typeof fetch === 'function' ? fetch : null
    if (real === null) throw new Error('no fetch')
    if (opts.record) opts.record.push({ url: String(url), init })
    return real(mapped, init)
  }
}

const PUBLIC_RESOLVER = async () => ['93.184.216.34']

function entryOf(overrides) {
  const base = {
    id: 'custom:abcdef123456',
    name: '示例厂商',
    url: 'https://public.example/balance',
    balancePath: 'data.balance',
    subtractPath: '',
    currency: 'CNY',
    credentialRef: '',
    // [R5] 已保存凭据必须带「已确认目标」才会发送；默认夹具按「用户已确认」构造。
    credentialHost: 'https://public.example',
    enabled: true,
    key: 'sk-test-key',
    gen: 'gen0000001',
  }
  return Object.assign(base, overrides || {})
}

const CTX_NONE = { get: () => undefined }

// ---------------------------------------------------------------------------
// F1 — 成功路径与请求形态
// ---------------------------------------------------------------------------
{
  await withServer({
    '/balance': { status: 200, body: JSON.stringify({ data: { balance: '12.34' } }) },
  }, async (base) => {
    const calls = []
    const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
      allowLegacy: true,
      transport: localTransport(base, { record: calls }),
      resolveHost: PUBLIC_RESOLVER,
    })
    check('F1a 成功取到余额（严格十进制字符串 → 12.34）', out.balance === 12.34 && out.error === undefined, out)
    check('F1b wire 标记 custom:true / gen / currency',
      out.custom === true && typeof out.gen === 'string' && /^[0-9a-f]{10}$/.test(out.gen) && out.currency === 'CNY', out)
    check('F1c 请求方法为 GET', calls.length === 1 && calls[0].init.method === 'GET', calls)
    const headers = calls[0].init.headers
    check('F1d Authorization: Bearer <Key>', headers.authorization === 'Bearer sk-test-key', headers)
    check('F1e Accept: application/json', headers.accept === 'application/json', headers)
    check('F1f 不跟随重定向（redirect:error）', calls[0].init.redirect === 'error', calls[0].init.redirect)
    check('F1g 结果不含 Key / 完整 URL / 原始响应体',
      !JSON.stringify(out).includes('sk-test-key')
      && !JSON.stringify(out).includes('/balance')
      && !JSON.stringify(out).includes('12.34"')
      , out)
  })
}

// ---------------------------------------------------------------------------
// F2 — 可选扣减（OpenRouter 式累计额度 − 累计用量）
// ---------------------------------------------------------------------------
{
  await withServer({
    '/credits': { status: 200, body: JSON.stringify({ data: { total_credits: 100, total_usage: 62.25 } }) },
  }, async (base) => {
    const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf({
      url: 'https://public.example/credits',
      balancePath: 'data.total_credits',
      subtractPath: 'data.total_usage',
      currency: 'USD',
    }), { transport: localTransport(base), resolveHost: PUBLIC_RESOLVER })
    check('F2 累计额度 − 累计用量 = 账户剩余 37.75（币种 USD）',
      out.balance === 37.75 && out.currency === 'USD' && out.error === undefined, out)
  })
}

// ---------------------------------------------------------------------------
// F3 — 鉴权与配置错误：语义错误（不 transient）
// ---------------------------------------------------------------------------
{
  for (const [status, label] of [[401, '401'], [403, '403']]) {
    await withServer({
      '/balance': { status, body: JSON.stringify({ error: 'nope' }) },
    }, async (base) => {
      const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
        allowLegacy: true,
        transport: localTransport(base), resolveHost: PUBLIC_RESOLVER,
      })
      check('F3 ' + label + ' → 鉴权错误、transient 不置位（立即提示，不用旧值掩盖）',
        out.error === 'auth' && out.transient !== true && out.balance === undefined, out)
    })
  }

  // 400/404 属端点/配置错误，不是「未安装」，也不是登录失效。
  for (const status of [400, 404, 405]) {
    await withServer({ '/balance': { status, body: '{}' } }, async (base) => {
      const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
        allowLegacy: true,
        transport: localTransport(base), resolveHost: PUBLIC_RESOLVER,
      })
      check('F3 ' + status + ' → 端点/配置错误（语义，非暂时）',
        out.error === 'endpoint' && out.transient !== true && !/未安装/.test(out.message), out)
    })
  }
}

// ---------------------------------------------------------------------------
// F4 — 暂时错误：429 / 5xx 带 transient
// ---------------------------------------------------------------------------
{
  for (const status of [429, 500, 502, 503]) {
    await withServer({ '/balance': { status, body: '{}' } }, async (base) => {
      const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
        allowLegacy: true,
        transport: localTransport(base), resolveHost: PUBLIC_RESOLVER,
      })
      check('F4 ' + status + ' → transient:true（保留旧值灰化）',
        out.transient === true && out.error !== undefined && out.balance === undefined, out)
    })
  }
}

// ---------------------------------------------------------------------------
// F5 — 结构错误：非 JSON / 缺键 / 类型不符 / 超大响应；都是暂时失败且不返回 0
// ---------------------------------------------------------------------------
{
  const cases = [
    ['非 JSON', 'not json at all', 'data.balance'],
    ['缺键', JSON.stringify({ data: {} }), 'data.balance'],
    ['null 值', JSON.stringify({ data: { balance: null } }), 'data.balance'],
    ['布尔值', JSON.stringify({ data: { balance: true } }), 'data.balance'],
    ['带货币符号', JSON.stringify({ data: { balance: '¥12.5' } }), 'data.balance'],
    ['千分位', JSON.stringify({ data: { balance: '1,234.56' } }), 'data.balance'],
    ['数组而非对象', JSON.stringify([1, 2, 3]), 'data.balance'],
    ['扣减键缺失', JSON.stringify({ data: { total_credits: 5 } }), 'data.total_credits'],
  ]
  for (const [label, body, path] of cases) {
    await withServer({ '/balance': { status: 200, body } }, async (base) => {
      const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf({
        balancePath: path,
        subtractPath: label === '扣减键缺失' ? 'data.total_usage' : '',
      }), { transport: localTransport(base), resolveHost: PUBLIC_RESOLVER })
      check('F5 ' + label + ' → 结构错误（不伪造 0、带 transient）',
        out.error === 'structure' && out.transient === true
        && out.balance === undefined && typeof out.message === 'string' && out.message.length > 0, out)
    })
  }

  await withServer({
    '/balance': { status: 200, body: 'x'.repeat(MAX_BODY_BYTES + 64) },
  }, async (base) => {
    const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
      allowLegacy: true,
      transport: localTransport(base), resolveHost: PUBLIC_RESOLVER,
    })
    check('F5 超大响应 → 拒绝解析（结构错误）', out.error === 'structure' && /过大/.test(out.message), out)
  })
}

// ---------------------------------------------------------------------------
// F6 — 凭据：显式 Key 优先、模型凭据引用、主机未确认则拒发、缺凭据提示
// ---------------------------------------------------------------------------
{
  await withServer({
    '/balance': { status: 200, body: JSON.stringify({ data: { balance: 1 } }) },
  }, async (base) => {
    // 显式 Key 优先于凭据引用：凭据服务不该被调用。
    let refCalls = 0
    const ctx = { get: (name) => (name === 'credentials' ? { resolve: async () => { refCalls += 1; return { value: 'sk-from-store' } } } : undefined) }
    const calls = []
    const out = await fetchCustomBalance(ctx, undefined, {}, entryOf({
      key: 'sk-explicit',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialHost: 'public.example',
    }), { transport: localTransport(base, { record: calls }), resolveHost: PUBLIC_RESOLVER })
    check('F6a 显式 Key 优先（不解析凭据引用）', out.error === undefined && refCalls === 0
      && calls[0].init.headers.authorization === 'Bearer sk-explicit', { out, refCalls })

    // 留空 Key → 用明确选定且主机已确认的模型凭据引用。
    const calls2 = []
    const out2 = await fetchCustomBalance(ctx, undefined, {}, entryOf({
      key: '',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialHost: 'public.example',
    }), { transport: localTransport(base, { record: calls2 }), resolveHost: PUBLIC_RESOLVER })
    check('F6b 留空 Key 时复用模型凭据引用', out2.error === undefined && out2.via === 'credential-ref'
      && calls2[0].init.headers.authorization === 'Bearer sk-from-store', { out2 })

    // 主机变了但没重新确认 → 拒发（不把凭据试发到新域名）。
    const calls3 = []
    const out3 = await fetchCustomBalance(ctx, undefined, {}, entryOf({
      key: '',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialHost: 'old.example.com',
    }), { transport: localTransport(base, { record: calls3 }), resolveHost: PUBLIC_RESOLVER })
    check('F6c 目标主机变更未确认 → 拒发凭据（零请求）',
      out3.error === 'credential-unconfirmed' && calls3.length === 0, { out3, calls3: calls3.length })

    // 凭据服务缺失 → 可操作提示，不崩。
    const out4 = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf({
      key: '', credentialRef: 'DEEPSEEK_API_KEY', credentialHost: 'public.example',
    }), { transport: localTransport(base), resolveHost: PUBLIC_RESOLVER })
    check('F6d 无凭据服务 → no-key + 可操作说明',
      out4.error === 'no-key' && /凭据服务/.test(out4.message), out4)

    // 引用解析不到值 → no-key。
    const emptyCtx = { get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined) }
    const out5 = await fetchCustomBalance(emptyCtx, undefined, {}, entryOf({
      key: '', credentialRef: 'MISSING_REF', credentialHost: 'public.example',
    }), { transport: localTransport(base), resolveHost: PUBLIC_RESOLVER })
    check('F6e 引用无值 → no-key（提示去设置模型凭据）',
      out5.error === 'no-key' && /模型/.test(out5.message), out5)

    // 完全没 Key 也没引用 → no-key。
    const out6 = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf({ key: '' }), {
      allowLegacy: true,
      transport: localTransport(base), resolveHost: PUBLIC_RESOLVER,
    })
    check('F6f 未配置任何 Key → no-key（零请求）', out6.error === 'no-key', out6)
  })

  // 凭据解析抛错也必须被隔离。
  const throwingCtx = { get: (name) => (name === 'credentials' ? { resolve: async () => { throw new Error('boom') } } : undefined) }
  const out7 = await fetchCustomBalance(throwingCtx, undefined, {}, entryOf({
    key: '', credentialRef: 'X_API_KEY', credentialHost: 'public.example',
  }), { transport: async () => { throw new Error('不应发请求') }, resolveHost: PUBLIC_RESOLVER })
  check('F6g 凭据解析抛错 → no-key（不冒泡）', out7.error === 'no-key', out7)
}

// ---------------------------------------------------------------------------
// F7 — 配置错误在发请求前拦下（坏路径 / 坏 URL / 私网）
// ---------------------------------------------------------------------------
{
  const cases = [
    ['坏路径', entryOf({ balancePath: 'data[' }), 'config'],
    ['坏扣减路径', entryOf({ subtractPath: 'data[[' }), 'config'],
    ['http 地址', entryOf({ url: 'http://public.example/balance' }), 'config'],
    ['私网地址', entryOf({ url: 'https://127.0.0.1/balance' }), 'config'],
    ['URL 带 Key 查询', entryOf({ url: 'https://public.example/balance?api_key=x' }), 'config'],
  ]
  let zeroRequests = true
  for (const [label, entry, expected] of cases) {
    const calls = []
    const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entry, {
      allowLegacy: true,
      transport: async (url, init) => { calls.push(url); throw new Error('不应发请求') },
      resolveHost: PUBLIC_RESOLVER,
    })
    if (out.error !== expected || calls.length !== 0) {
      zeroRequests = false
      console.log('   ' + label + ' → ' + JSON.stringify(out) + ' calls=' + calls.length)
    }
  }
  check('F7 坏路径/坏 URL/私网/查询串带 Key 均在发请求前拦下（零请求）', zeroRequests)

  // DNS 解析到私网也算配置错误。
  const dnsCalls = []
  const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
    allowLegacy: true,
    transport: async (url) => { dnsCalls.push(url); throw new Error('不应发请求') },
    resolveHost: async () => ['127.0.0.1'],
  })
  check('F7 DNS 解析到环回 → 拒绝请求（零请求）',
    out.error === 'config' && dnsCalls.length === 0 && /环回/.test(out.message), out)
}

// ---------------------------------------------------------------------------
// F8 — 超时与网络失败
// ---------------------------------------------------------------------------
{
  const slow = async (url, init) => {
    // 真实等待，让 AbortController 生效。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000)
      if (init.signal !== undefined) {
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
      }
    })
    return { status: 200, text: async () => '{}' }
  }
  const started = Date.now()
  const out = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
    allowLegacy: true,
    transport: slow, resolveHost: PUBLIC_RESOLVER, timeoutMs: 60,
  })
  const elapsed = Date.now() - started
  check('F8a 超时 → transient 网络错误（不抛异常）',
    out.error === 'network' && out.transient === true && /超时/.test(out.message), out)
  check('F8b 超时确实提前返回（< 2s）', elapsed < 2000, elapsed)

  const refused = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
    allowLegacy: true,
    transport: async () => { throw new TypeError('fetch failed') },
    resolveHost: PUBLIC_RESOLVER,
  })
  check('F8c 网络不可达 → transient 网络错误', refused.error === 'network' && refused.transient === true, refused)

  const noFetch = await fetchCustomBalance(CTX_NONE, undefined, {}, entryOf(), {
    allowLegacy: true,
    transport: async () => { throw new Error('x') }, resolveHost: PUBLIC_RESOLVER,
  })
  check('F8d 传输异常不泄露内部错误原文到 message', !/x$/m.test(noFetch.message || ''), noFetch)
}

// ---------------------------------------------------------------------------
// F9 — 整批：停用不请求、单条失败隔离、同名不串、并发上限、预算
// ---------------------------------------------------------------------------
{
  await withServer((req) => {
    if (req.url === '/a') return { status: 200, body: JSON.stringify({ data: { balance: 1.5 } }) }
    if (req.url === '/b') return { status: 200, body: JSON.stringify({ data: { balance: 2.5 } }) }
    if (req.url === '/fail') return { status: 500, body: '{}' }
    return undefined
  }, async (base) => {
    const cfg = {
      customBalances: [
        // [R5] 已保存 Key 需要「已确认目标」，夹具按用户已确认构造。
        { id: 'custom:aaaaaaaaaaaa', name: '同名', url: 'https://public.example/a', balancePath: 'data.balance', credentialHost: 'https://public.example', enabled: true },
        { id: 'custom:bbbbbbbbbbbb', name: '同名', url: 'https://public.example/b', balancePath: 'data.balance', credentialHost: 'https://public.example', enabled: true },
        { id: 'custom:cccccccccccc', name: '失败', url: 'https://public.example/fail', balancePath: 'data.balance', credentialHost: 'https://public.example', enabled: true },
        { id: 'custom:dddddddddddd', name: '停用', url: 'https://public.example/a', balancePath: 'data.balance', credentialHost: 'https://public.example', enabled: false },
      ],
      customKeys: {
        'custom:aaaaaaaaaaaa': 'sk-a',
        'custom:bbbbbbbbbbbb': 'sk-b',
        'custom:cccccccccccc': 'sk-c',
        'custom:dddddddddddd': 'sk-d',
      },
    }
    const calls = []
    const out = await fetchCustomPlans(CTX_NONE, undefined, cfg, { allowLegacy: true,
      allowLegacy: true,
      transport: localTransport(base, { record: calls }),
      resolveHost: PUBLIC_RESOLVER,
    })
    check('F9a 四条记录都返回（含停用）', out.length === 4, out.length)
    check('F9b 停用条目不请求、无 balance', out[3].enabled === false && out[3].balance === undefined, out[3])
    check('F9c 同名两条按 id 各自取到正确余额', out[0].balance === 1.5 && out[1].balance === 2.5, out)
    check('F9d 单条失败不影响其他条目', out[2].error === 'server' && out[0].error === undefined, out[2])
    check('F9e 停用条目没有发出请求（3 次请求）', calls.length === 3, calls.length)
    check('F9f 每条结果的 Key 没有串用', calls.map((c) => c.init.headers.authorization).sort().join(',')
      === 'Bearer sk-a,Bearer sk-b,Bearer sk-c', calls.map((c) => c.init.headers.authorization))

    // 并发上限：同时未完成的请求数不得超过 CONCURRENCY。
    let active = 0
    let peak = 0
    const gate = []
    const list = []
    const keys = {}
    for (let i = 0; i < 9; i += 1) {
      const id = 'custom:' + String(i).padStart(12, '0')
      list.push({ id, name: 'n' + i, url: 'https://public.example/a', balancePath: 'data.balance', credentialHost: 'https://public.example', enabled: true })
      keys[id] = 'sk-' + i
    }
    const blocked = new Promise((resolve) => gate.push(resolve))
    const transport = async (url, init) => {
      active += 1
      peak = Math.max(peak, active)
      await blocked
      active -= 1
      return { status: 200, text: async () => JSON.stringify({ data: { balance: 1 } }) }
    }
    const batch = fetchCustomPlans(CTX_NONE, undefined, { customBalances: list, customKeys: keys }, {
      allowLegacy: true,
      transport, resolveHost: PUBLIC_RESOLVER,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const peakDuring = peak
    gate.forEach((resolve) => resolve())
    await batch
    check('F9g 并发被限制在 CONCURRENCY（' + CONCURRENCY + '）以内', peakDuring > 0 && peakDuring <= CONCURRENCY, peakDuring)
  })
}

// ---------------------------------------------------------------------------
// F10 — 整批预算：超预算的条目转结构化暂时失败，而不是无限等待
// ---------------------------------------------------------------------------
{
  const list = []
  const keys = {}
  for (let i = 0; i < 6; i += 1) {
    const id = 'custom:' + String(i).padStart(12, '0')
    list.push({ id, name: 'n' + i, url: 'https://public.example/a', balancePath: 'data.balance', credentialHost: 'https://public.example', enabled: true })
    keys[id] = 'sk-' + i
  }
  const hang = async () => new Promise(() => {}) // 永不 settle（最坏情况）
  const started = Date.now()
  const out = await fetchCustomPlans(CTX_NONE, undefined, { customBalances: list, customKeys: keys }, {
    allowLegacy: true,
    transport: hang,
    resolveHost: PUBLIC_RESOLVER,
    budgetMs: 80,
    timeoutMs: 5000,
  })
  const elapsed = Date.now() - started
  check('F10a 有预算时整批不会无限挂起（< 2s 返回）', elapsed < 2000, elapsed)
  check('F10b 超时/未调度条目全部是结构化暂时失败', out.length === 6
    && out.every((row) => row.transient === true && row.error === 'network'), out)
  check('F10c 没有伪造余额', out.every((row) => row.balance === undefined), out)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
