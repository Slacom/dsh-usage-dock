/**
 * MiMo API Key 余额通道（0.11.2）单元测试。
 *
 * 覆盖：
 *   - 请求形态：GET https://api.xiaomimimo.com/v1/platform/balance + `api-key` 头，不带 Cookie
 *   - 解析口径：balance = 现金 + 赠金（**不含**授信额度）；cash/gift/credit 明细
 *   - 币种、isAvailable、via='api-key'
 *   - 401/403（invalid_api_key）→ 鉴权失效文案；结构异常 → parse
 *   - fetchPlan 优先 API Key；无 Key 且无 Cookie → no-key（零请求）
 *
 * 用法：node tools/test-mimo-api-key.mjs
 */
import assert from 'node:assert/strict'
import { fetchApiKeyBalance, fetchPlan, API_KEY_ENDPOINT } from '../plans/mimo.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

const calls = []
function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const hit = handler(calls.length)
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: { get: () => 'application/json', forEach: () => {} },
      text: async () => JSON.stringify(hit.body === undefined ? {} : hit.body),
      json: async () => hit.body,
    }
  }
}

const origin = globalThis.fetch
const BODY_OK = {
  object: 'balance',
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    cash_balance: '100.50',
    gift_balance: '20.00',
    frozen_balance: '0.00',
    credit_limit: '500.00',
    credit_available: '380.00',
    total_available: '500.50',
  }],
}

// 1) 成功：金额 = 现金 + 赠金（不含授信）
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-test-key', {}, {})
  check('成功：balance = 现金 100.5 + 赠金 20 = 120.5（不含授信 380）', wire.balance === 120.5, wire)
  check('成功：cashBalance / giftBalance / creditAvailable 明细', wire.cashBalance === 100.5 && wire.giftBalance === 20 && wire.creditAvailable === 380, wire)
  check('成功：币种 CNY、isAvailable=true、via=api-key',
    wire.currency === 'CNY' && wire.isAvailable === true && wire.via === 'api-key', wire)
  check('请求：GET 固定端点', calls.length === 1 && calls[0].url === API_KEY_ENDPOINT, calls)
  const headers = calls[0].init.headers || {}
  check('请求：带 api-key 头，且不带 Cookie',
    headers['api-key'] === 'sk-test-key' && headers.Cookie === undefined, headers)
}

// 2) 只有 total_available：回退到总额
stubFetch(() => ({ status: 200, body: { object: 'balance', is_available: true, balance_infos: [{ currency: 'CNY', total_available: '42.00' }] } }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-test-key', {}, {})
  check('只有 total_available 时回退用总额 42', wire.balance === 42, wire)
  check('缺 cash/gift 时明细为 null（不伪造成 0）', wire.cashBalance === null && wire.giftBalance === null, wire)
}

// 3) 401 → 鉴权失效（永久）
stubFetch(() => ({ status: 401, body: { error: { message: 'Invalid API key.', code: 'invalid_api_key' } } }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-bad', {}, {})
  check('401：标记错误且文案提示重新填写 Key',
    typeof wire.error === 'string' && wire.message.includes('重新填写'), wire)
}

// 4) 结构异常 → parse
stubFetch(() => ({ status: 200, body: { object: 'balance', is_available: true, balance_infos: [] } }))
{
  const wire = await fetchApiKeyBalance(null, 'sk-test-key', {}, {})
  check('空 balance_infos → parse 错误', wire.error === 'parse', wire)
}

// 5) fetchPlan 优先 API Key
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const ctx = { get: () => undefined }
  const wire = await fetchPlan(ctx, null, { mimoApiKey: 'sk-cfg', mimoCookie: 'userId=1; serviceToken=x' }, {})
  check('fetchPlan：配了 API Key 就走 API Key 通道（via=api-key）', wire.via === 'api-key' && wire.balance === 120.5, wire)
  const headers = calls[0].init.headers || {}
  check('fetchPlan：请求头用配置里的 key', headers['api-key'] === 'sk-cfg', headers)
}

// 6) 无 Key 且无 Cookie → no-key，且零请求
stubFetch(() => ({ status: 200, body: BODY_OK }))
{
  const ctx = { get: () => undefined }
  const wire = await fetchPlan(ctx, null, {}, {})
  check('fetchPlan：无 Key 无 Cookie → no-key', wire.error === 'no-key', wire)
  check('fetchPlan：no-key 时零请求', calls.length === 0, calls)
}

globalThis.fetch = origin
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
