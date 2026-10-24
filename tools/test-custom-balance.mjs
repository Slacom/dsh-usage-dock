/**
 * plans/custom-balance.js 单元测试（0.9.0 C0/C3，离线）。
 *
 * 覆盖：
 *   - JSON 键路径语法（字段 / 下标 / $ 前缀 / 拒绝表达式与危险字段名 / 深度与下标上限）
 *   - 数值语义（number、严格十进制字符串、0、负数、拒绝 null/布尔/千分位/带符号/科学计数法）
 *   - 可选固定扣减键（累计额度 − 累计用量），且**不把累计充值当余额**
 *   - URL 安全（仅 https、拒绝 userinfo/fragment/query 里的 Key/私网/环回/云元数据/单标签主机）
 *   - DNS 目标核验（全部地址必须公网）
 *   - HTTP 错误分类（401/403 语义立即、429/5xx 暂时、3xx 不跟随、400/404 端点错误）
 *   - 响应体上限、超时、并发与整批预算、停用条目不请求
 *   - 凭据：显式 Key 优先、模型凭据引用复用、主机变更未确认则拒发、缺凭据可操作提示
 *   - 秘密不外泄：wire 结果与状态摘要都不含 Key
 *
 * 用法：node tools/test-custom-balance.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import {
  parseJsonPath, readJsonPath, numberFromJson, extractCustomBalance,
  validateBalanceUrl, isPrivateIpv4, isPrivateIpv6, isPrivateHostname,
  verifyPublicTarget, classifyStatus, normalizeCurrency, readLimitedBody,
  collectCustomEntries, configGeneration,
  MAX_CUSTOM_RECORDS, MAX_BODY_BYTES, PATH_MAX_INDEX,
} from '../plans/custom-balance.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')) }
}
async function checkAsync(name, fn) {
  try { const detail = await fn(); passCount++; console.log('[PASS] ' + name) }
  catch (err) { failCount++; console.log('[FAIL] ' + name + ' — ' + err.message) }
}

// ---------------------------------------------------------------------------
// P — JSON 键路径语法
// ---------------------------------------------------------------------------
{
  const okCases = [
    ['data.balance', [{ key: 'data' }, { key: 'balance' }]],
    ['balance_infos[0].total_balance', [{ key: 'balance_infos' }, { index: 0 }, { key: 'total_balance' }]],
    ['$.data.balance', [{ key: 'data' }, { key: 'balance' }]],
    ['$', null], // 只有 $ 没有字段 → empty
    ['amount', [{ key: 'amount' }]],
    ['a[0][1].b', [{ key: 'a' }, { index: 0 }, { index: 1 }, { key: 'b' }]],
    ['  data.balance  ', [{ key: 'data' }, { key: 'balance' }]],
    ['x-y_z', [{ key: 'x-y_z' }]],
  ]
  let allOk = true
  for (const [text, expected] of okCases) {
    const parsed = parseJsonPath(text)
    if (expected === null) { if (parsed.ok) allOk = false; continue }
    if (!parsed.ok || JSON.stringify(parsed.segments) !== JSON.stringify(expected)) {
      allOk = false
      console.log('   路径解析不符: ' + JSON.stringify(text) + ' → ' + JSON.stringify(parsed))
    }
  }
  check('P1 合法路径（字段/下标/$ 前缀/连字符下划线/首尾空白）', allOk)

  const badCases = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['$', 'empty'],
    ['$..x', 'syntax'],
    ['data..balance', 'syntax'],
    ['data.', 'syntax'],
    ['.data', 'syntax'],
    ['data[0', 'syntax'],
    ['data[]', 'syntax'],
    ['data[01]', 'syntax'],
    ['data[-1]', 'syntax'],
    ['data[+1]', 'syntax'],
    ['data[1.5]', 'syntax'],
    ['data[1e3]', 'syntax'],
    ['data[0]balance', 'syntax'],
    ['data balance', 'syntax'],
    ['data[*]', 'syntax'],
    ['data[?(@.x)]', 'syntax'],
    ['$..[0]', 'syntax'],
    ['__proto__.x', 'forbidden'],
    ['a.__proto__', 'forbidden'],
    ['constructor', 'forbidden'],
    ['a.prototype.b', 'forbidden'],
    ['data[' + (PATH_MAX_INDEX + 1) + ']', 'index-range'],
    ['data[99999999999999999999]', 'index-range'],
    ['a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r', 'too-deep'],
    ['x'.repeat(300), 'too-long'],
  ]
  let allBad = true
  for (const [text, expected] of badCases) {
    const parsed = parseJsonPath(text)
    if (parsed.ok || parsed.error !== expected) {
      allBad = false
      console.log('   应拒绝但结果不符: ' + JSON.stringify(text) + ' → ' + JSON.stringify(parsed))
    }
  }
  check('P2 非法路径被拒绝（空/语法/通配/越界下标/危险字段/超限）', allBad)

  // 只读自身属性：原型链上的字段读不到。
  const proto = { inherited: 42 }
  const obj = Object.create(proto)
  obj.own = 7
  const ownRead = readJsonPath(obj, [{ key: 'own' }])
  const protoRead = readJsonPath(obj, [{ key: 'inherited' }])
  check('P3 只读对象自身属性，原型链字段读不到',
    ownRead.ok && ownRead.value === 7 && protoRead.ok === false && protoRead.reason === 'missing')

  // 类型不匹配与越界要分清 missing / type。
  check('P4 数组越界 → missing', readJsonPath({ a: [1] }, [{ key: 'a' }, { index: 3 }]).reason === 'missing')
  check('P5 对非数组取下标 → type', readJsonPath({ a: 1 }, [{ key: 'a' }, { index: 0 }]).reason === 'type')
  check('P6 对数组取字段 → type', readJsonPath({ a: [] }, [{ key: 'a' }, { key: 'x' }]).reason === 'type')
}

// ---------------------------------------------------------------------------
// N — 数值语义
// ---------------------------------------------------------------------------
{
  const accept = [[12.5, 12.5], [0, 0], [-3.2, -3.2], ['11.38', 11.38], [' 7 ', 7], ['0', 0], ['-0.5', -0.5], ['1234567890.12', 1234567890.12]]
  let allAccept = true
  for (const [input, expected] of accept) {
    const got = numberFromJson(input)
    if (!got.ok || got.value !== expected) { allAccept = false; console.log('   应接受: ' + JSON.stringify(input) + ' → ' + JSON.stringify(got)) }
  }
  check('N1 接受有限数值与严格十进制字符串（含 0 与负数）', allAccept)

  // 这些**不得**变成 0：缺值、非法类型、带货币符号、千分位、科学计数法、空串。
  const reject = [null, undefined, true, false, {}, [], '', '   ', 'NaN', 'Infinity', '-Infinity',
    '$12.5', '¥12.5', '1,234.56', '1e3', '1E3', '.5', '5.', '+5', '0x10', '12abc', [12]]
  let allReject = true
  for (const input of reject) {
    const got = numberFromJson(input)
    if (got.ok) { allReject = false; console.log('   应拒绝: ' + JSON.stringify(input) + ' → ' + JSON.stringify(got)) }
  }
  check('N2 拒绝缺值/非法类型/带符号/千分位/科学计数法（不折算成 0）', allReject)
  check('N3 NaN 与 Infinity 被拒绝', numberFromJson(NaN).ok === false && numberFromJson(Infinity).ok === false)
}

// ---------------------------------------------------------------------------
// E — 取值与可选扣减
// ---------------------------------------------------------------------------
{
  const deepseek = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '11.38' }] }
  const direct = extractCustomBalance(deepseek, 'balance_infos[0].total_balance', '')
  check('E1 直接键（DeepSeek 形态）', direct.ok && direct.value === 11.38, direct)

  const nested = { data: { wallet: { amount: -2.5 } } }
  const neg = extractCustomBalance(nested, 'data.wallet.amount', '')
  check('E2 嵌套路径 + 负余额保留（不钳成 0）', neg.ok && neg.value === -2.5, neg)

  const zero = extractCustomBalance({ data: { balance: 0 } }, 'data.balance', '')
  check('E3 真实 0 余额有效（不是缺值）', zero.ok && zero.value === 0, zero)

  // OpenRouter 式：累计额度 − 累计用量 = 账户剩余。
  const credits = { data: { total_credits: 100, total_usage: 37.5 } }
  const minus = extractCustomBalance(credits, 'data.total_credits', 'data.total_usage')
  check('E4 可选固定扣减（累计额度 − 累计用量 = 62.5）', minus.ok && minus.value === 62.5, minus)

  // 扣减后可以为负（透支）——保留负数，不当 0。
  const over = extractCustomBalance({ data: { total_credits: 10, total_usage: 12.75 } }, 'data.total_credits', 'data.total_usage')
  check('E5 扣减后为负保留（-2.75）', over.ok && over.value === -2.75, over)

  // 关键语义守卫：不能把「累计充值」或「Key 限额」当成账户剩余。
  const cumulativeAsBalance = extractCustomBalance({ data: { total_credits: 100 } }, 'data.total_credits', '')
  check('E6 单键取累计额度会得到 100（因此必须配扣减键才能声称支持 credits 形态）',
    cumulativeAsBalance.ok && cumulativeAsBalance.value === 100)
  const keyLimit = { data: { limit: 50, limit_remaining: 10, usage: 40 } }
  const asRemaining = extractCustomBalance(keyLimit, 'data.limit_remaining', '')
  check('E7 limit_remaining 只能作为「单独配置的键」读取，不会自动当账户余额', asRemaining.ok && asRemaining.value === 10)

  const missing = extractCustomBalance({ data: {} }, 'data.balance', '')
  check('E8 缺键 → missing（不返回 0）', !missing.ok && missing.reason === 'missing', missing)
  const wrongType = extractCustomBalance({ data: { balance: null } }, 'data.balance', '')
  check('E9 null → type（不返回 0）', !wrongType.ok && wrongType.reason === 'type', wrongType)
  const badPath = extractCustomBalance({}, 'data[' , '')
  check('E10 非法路径 → path', !badPath.ok && badPath.reason === 'path', badPath)
  const missingSubtract = extractCustomBalance({ data: { total_credits: 5 } }, 'data.total_credits', 'data.total_usage')
  check('E11 扣减键缺失 → subtract-missing（不把累计值当余额）', !missingSubtract.ok && missingSubtract.reason === 'subtract-missing', missingSubtract)
  const badSubtract = extractCustomBalance({ data: { total_credits: 5, total_usage: 'n/a' } }, 'data.total_credits', 'data.total_usage')
  check('E12 扣减键非法类型 → subtract-type', !badSubtract.ok && badSubtract.reason === 'subtract-type', badSubtract)
}

// ---------------------------------------------------------------------------
// U — URL 安全
// ---------------------------------------------------------------------------
{
  const good = [
    'https://api.deepseek.com/user/balance',
    'https://openrouter.ai/api/v1/credits',
    'https://api.example.com:8443/v1/balance?scope=account',
  ]
  let allGood = true
  for (const url of good) {
    const got = validateBalanceUrl(url)
    if (!got.ok) { allGood = false; console.log('   应通过: ' + url + ' → ' + JSON.stringify(got)) }
  }
  check('U1 公网 https 地址通过（含非默认端口与普通查询参数）', allGood)

  const bad = [
    ['http://api.example.com/balance', 'protocol'],
    ['ftp://api.example.com/balance', 'protocol'],
    ['file:///etc/passwd', 'protocol'],
    ['data:text/plain,hi', 'protocol'],
    ['https://user:pass@api.example.com/balance', 'userinfo'],
    ['https://api.example.com/balance#frag', 'fragment'],
    ['https://api.example.com/balance?api_key=sk-1', 'query-secret'],
    ['https://api.example.com/balance?token=abc', 'query-secret'],
    ['https://api.example.com/balance?access-token=abc', 'query-secret'],
    ['https://api.example.com/balance?signature=x', 'query-secret'],
    ['https://localhost/balance', 'private-host'],
    ['https://127.0.0.1/balance', 'private-host'],
    ['https://[::1]/balance', 'private-host'],
    ['https://169.254.169.254/latest/meta-data/', 'private-host'],
    ['https://10.0.0.5/balance', 'private-host'],
    ['https://192.168.1.1/balance', 'private-host'],
    ['https://172.20.0.1/balance', 'private-host'],
    ['https://metadata.google.internal/balance', 'private-host'],
    ['https://api.localhost/balance', 'private-host'],
    ['https://intranet/balance', 'private-host'],
    ['https://[fd00::1]/balance', 'private-host'],
    ['https://[fe80::1]/balance', 'private-host'],
    ['', 'empty'],
    ['not a url', 'syntax'],
    ['//api.example.com/balance', 'syntax'],
  ]
  let allBad = true
  for (const [url, expected] of bad) {
    const got = validateBalanceUrl(url)
    if (got.ok || got.error !== expected) { allBad = false; console.log('   应拒绝: ' + JSON.stringify(url) + ' → ' + JSON.stringify(got)) }
  }
  check('U2 拒绝 http/其它协议、userinfo、fragment、查询串里的 Key、私网/环回/云元数据/单标签主机', allBad)

  check('U3 IPv4 私网段判定', isPrivateIpv4('192.168.0.1') && isPrivateIpv4('10.1.2.3')
    && isPrivateIpv4('172.16.0.1') && isPrivateIpv4('172.31.255.255')
    && isPrivateIpv4('100.64.0.1') && isPrivateIpv4('224.0.0.1')
    && !isPrivateIpv4('8.8.8.8') && !isPrivateIpv4('1.1.1.1') && !isPrivateIpv4('172.32.0.1'))
  check('U4 IPv6 私网/环回/映射判定', isPrivateIpv6('::1') && isPrivateIpv6('fd00::1') && isPrivateIpv6('fe80::1')
    && isPrivateIpv6('ff02::1') && isPrivateIpv6('::ffff:127.0.0.1') && !isPrivateIpv6('2606:4700::1111'))
  check('U5 主机名判定（localhost/单标签/内网后缀）', isPrivateHostname('localhost')
    && isPrivateHostname('db.local') && isPrivateHostname('metadata')
    && !isPrivateHostname('api.deepseek.com'))

  await checkAsync('U6 DNS 核验：任一地址落在私网即拒绝（DNS 重绑定窗口的 best-effort 防护）', async () => {
    const publicOnly = await verifyPublicTarget('api.example.com', async () => ['93.184.216.34', '2606:2800:220:1::1'])
    assert.equal(publicOnly.ok, true)
    const mixed = await verifyPublicTarget('evil.example.com', async () => ['93.184.216.34', '127.0.0.1'])
    assert.equal(mixed.ok, false)
    assert.equal(mixed.reason, 'private')
    const dnsFail = await verifyPublicTarget('nope.example.com', async () => { throw new Error('ENOTFOUND') })
    assert.equal(dnsFail.reason, 'dns')
    const literalPublic = await verifyPublicTarget('8.8.8.8', async () => { throw new Error('不应解析 IP 字面量') })
    assert.equal(literalPublic.ok, true)
    const literalPrivate = await verifyPublicTarget('10.0.0.1', async () => { throw new Error('不应解析 IP 字面量') })
    assert.equal(literalPrivate.ok, false)
  })
}

// ---------------------------------------------------------------------------
// C — 币种
// ---------------------------------------------------------------------------
{
  check('C1 币种规范化（大写、空白、空=未指定）', normalizeCurrency('cny') === 'CNY'
    && normalizeCurrency(' usd ') === 'USD' && normalizeCurrency('') === '' && normalizeCurrency(undefined) === '')
  check('C2 非法币种返回 null（不猜成人民币）', normalizeCurrency('￥') === null && normalizeCurrency('RMB$') === null)
}

// ---------------------------------------------------------------------------
// S — HTTP 状态分类
// ---------------------------------------------------------------------------
{
  check('S1 2xx 无错误', classifyStatus(200) === null && classifyStatus(204) === null)
  const auth = classifyStatus(401)
  check('S2 401 → 鉴权语义错误（不灰化、立即提示）', auth.error === 'auth' && auth.transient === false)
  check('S3 403 → 鉴权语义错误', classifyStatus(403).error === 'auth' && classifyStatus(403).transient === false)
  const rate = classifyStatus(429)
  check('S4 429 → 暂时失败（保留旧值灰化）', rate.error === 'rate-limit' && rate.transient === true)
  check('S5 5xx → 暂时失败', classifyStatus(500).transient === true && classifyStatus(503).transient === true)
  check('S6 3xx → 端点错误（不跟随重定向，明确提示）', classifyStatus(302).error === 'endpoint'
    && classifyStatus(302).transient === false && /重定向/.test(classifyStatus(302).message))
  check('S7 400/404/405 → 端点/配置错误（不猜登录失效）', classifyStatus(404).error === 'endpoint'
    && classifyStatus(404).transient === false && classifyStatus(405).error === 'endpoint')
  check('S8 错误文案不冒充「插件未安装」', !/未安装/.test(classifyStatus(404).message))
}

// ---------------------------------------------------------------------------
// B — 响应体上限
// ---------------------------------------------------------------------------
{
  const okayBody = { get: () => null, text: async () => 'x'.repeat(100) }
  const okay = await readLimitedBody(okayBody)
  check('B1 正常响应体可读', okay.ok === true && okay.text.length === 100)

  const declared = { headers: { get: () => String(MAX_BODY_BYTES + 1) }, text: async () => 'x' }
  const tooLarge = await readLimitedBody(declared)
  check('B2 声明长度超限即拒绝（不先读完）', tooLarge.ok === false && tooLarge.reason === 'too-large')

  const bigText = { text: async () => 'y'.repeat(MAX_BODY_BYTES + 10) }
  const tooLarge2 = await readLimitedBody(bigText)
  check('B3 实际超限拒绝（无 content-length 时）', tooLarge2.ok === false && tooLarge2.reason === 'too-large')

  const streamed = {
    body: {
      getReader: () => {
        let sent = 0
        return {
          read: async () => {
            if (sent > 0) return { done: true }
            sent += 1
            return { done: false, value: new Uint8Array(MAX_BODY_BYTES + 5) }
          },
          cancel: async () => {},
        }
      },
    },
  }
  const streamedTooLarge = await readLimitedBody(streamed)
  check('B4 流式读取超限中止', streamedTooLarge.ok === false && streamedTooLarge.reason === 'too-large')
}

// ---------------------------------------------------------------------------
// G — 配置语义（id 稳定、代次隔离、数量上限、未知/坏配置容错）
// ---------------------------------------------------------------------------
{
  const cfg = {
    customBalances: [
      { id: 'custom:aaaaaaaaaaaa', name: 'A', url: 'https://a.example/b', balancePath: 'data.balance', enabled: true },
      { id: 'custom:bbbbbbbbbbbb', name: 'A', url: 'https://b.example/b', balancePath: 'data.balance', enabled: false },
      { id: 'not-a-custom-id', name: '坏条目', url: 'https://c.example/b', balancePath: 'x', enabled: true },
      { id: 'custom:aaaaaaaaaaaa', name: '重复 id', url: 'https://d.example/b', balancePath: 'x', enabled: true },
    ],
    customKeys: { 'custom:aaaaaaaaaaaa': 'sk-secret-a' },
  }
  const entries = collectCustomEntries(cfg, { allowLegacy: true })
  check('G1 非法 id 被跳过、重复 id 只保留第一条', entries.length === 2
    && entries[0].id === 'custom:aaaaaaaaaaaa' && entries[1].id === 'custom:bbbbbbbbbbbb', entries.map((e) => e.id))
  check('G2 同名不同 URL 仍是两条独立记录', entries[0].id !== entries[1].id && entries[0].url !== entries[1].url)
  check('G3 停用条目标记保留（enabled=false）', entries[1].enabled === false)
  check('G4 Key 只进内存条目不进公开字段', entries[0].key === 'sk-secret-a')

  const many = []
  for (let i = 0; i < MAX_CUSTOM_RECORDS + 5; i += 1) {
    many.push({ id: 'custom:' + String(i).padStart(12, '0'), name: 'n' + i, url: 'https://x.example/b', balancePath: 'b', enabled: true })
  }
  check('G5 条目数量上限生效', collectCustomEntries({ customBalances: many }, { allowLegacy: true }).length === MAX_CUSTOM_RECORDS)

  const base = { id: 'custom:aaaaaaaaaaaa', name: 'A', url: 'https://a.example/b', balancePath: 'data.balance', subtractPath: '', currency: 'CNY', credentialRef: '', credentialHost: '', enabled: true, key: 'sk-1' }
  const gen = configGeneration(base)
  check('G6 代次对身份无关字段（名称）不敏感', configGeneration(Object.assign({}, base, { name: '改名了' })) === gen)
  check('G7 改 URL 换代次', configGeneration(Object.assign({}, base, { url: 'https://a.example/c' })) !== gen)
  check('G8 改 Key 换代次（旧值与旧响应必须作废）', configGeneration(Object.assign({}, base, { key: 'sk-2' })) !== gen)
  check('G9 改路径/扣减/币种/凭据引用/停用都换代次',
    configGeneration(Object.assign({}, base, { balancePath: 'data.b' })) !== gen
    && configGeneration(Object.assign({}, base, { subtractPath: 'data.u' })) !== gen
    && configGeneration(Object.assign({}, base, { currency: 'USD' })) !== gen
    && configGeneration(Object.assign({}, base, { credentialRef: 'DEEPSEEK_API_KEY' })) !== gen
    && configGeneration(Object.assign({}, base, { enabled: false })) !== gen)
  check('G10 代次不含明文 Key', gen.length === 10 && !/[a-zA-Z0-9]{12,}/.test(gen))

  check('G11 键序不影响代次', (() => {
    const a = { id: 'x', url: 'u', balancePath: 'p', subtractPath: '', currency: '', credentialRef: '', credentialHost: '', enabled: true, key: 'k' }
    const b = { key: 'k', enabled: true, credentialHost: '', credentialRef: '', currency: '', subtractPath: '', balancePath: 'p', url: 'u', id: 'x' }
    return configGeneration(a) === configGeneration(b)
  })())
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
