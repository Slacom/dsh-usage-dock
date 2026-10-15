/**
 * plans/mimo.js 纯函数单元测试（离线，不发请求）。
 *
 * 解析口径对照 dsh-cost-meter lib/coding-plans.js（Cookie 归一化 / 余额解析）。
 * 跑法：node tools/test-mimo-parse.mjs
 */
import { normalizeMimoCookie, parseMimoBalance, currencySymbol } from '../plans/mimo.js'

let passCount = 0
let failCount = 0

function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')) }
}

// ── Cookie 归一化 ──────────────────────────────────────────────

const VALID = 'userId=12345; api-platform_serviceToken=abc; other=x'
const VALID_ALT = 'userId=12345; serviceToken=abc'

check('C1 完整合法 Cookie 通过', normalizeMimoCookie(VALID) === VALID)
check('C2 serviceToken（无前缀）也接受', normalizeMimoCookie(VALID_ALT) === VALID_ALT)
check('C3 容忍 Cookie: 前缀', normalizeMimoCookie('Cookie: ' + VALID) === VALID)
check('C4 容忍整体引号', normalizeMimoCookie('"' + VALID + '"') === VALID)
check('C5 容忍换行', normalizeMimoCookie('userId=12345;\napi-platform_serviceToken=abc') !== null)
check('C6 缺 userId 拒绝', normalizeMimoCookie('api-platform_serviceToken=abc') === null)
check('C7 缺 serviceToken 拒绝', normalizeMimoCookie('userId=12345') === null)
check('C8 空串拒绝', normalizeMimoCookie('') === null)
check('C9 非字符串拒绝', normalizeMimoCookie(undefined) === null)
check('C10 空值 token 拒绝', normalizeMimoCookie('userId=; serviceToken=') === null)

// ── 余额解析（官方响应数值为字符串）──────────────────────────────

check('B1 官方信封结构解析', (() => {
  const r = parseMimoBalance({ code: 0, data: { balance: '16.48', currency: 'CNY', cashBalance: '16.48', giftBalance: '0.00' } })
  return r !== null && r.balance === 16.48 && r.cashBalance === 16.48 && r.giftBalance === 0 && r.currency === 'CNY'
})())
check('B2 顶层结构（无 data 包裹）兼容', (() => {
  const r = parseMimoBalance({ balance: '25.51', currency: 'USD', cashBalance: '20', giftBalance: '5.51' })
  return r !== null && r.balance === 25.51 && r.currency === 'USD'
})())
check('B3 缺 balance 但有 cashBalance 时回退', (() => {
  const r = parseMimoBalance({ data: { cashBalance: '12.3', currency: 'CNY' } })
  return r !== null && r.balance === 12.3
})())
check('B4 缺币种默认 CNY', (() => {
  const r = parseMimoBalance({ data: { balance: '1' } })
  return r !== null && r.currency === 'CNY'
})())
check('B5 非法输入返回 null', parseMimoBalance(null) === null && parseMimoBalance('x') === null)
check('B6 负余额拒绝', parseMimoBalance({ data: { balance: '-1' } }) === null)
check('B7 缺赠送余额为 null 不编造 0', (() => {
  const r = parseMimoBalance({ data: { balance: '5', currency: 'CNY' } })
  return r.giftBalance === null
})())

// ── 币种符号 ──────────────────────────────────────────────────

check('S1 CNY → ¥', currencySymbol('CNY') === '¥')
check('S2 RMB → ¥', currencySymbol('RMB') === '¥')
check('S3 USD → $', currencySymbol('USD') === '$')
check('S4 缺省 → ¥', currencySymbol(undefined) === '¥')

console.log(failCount === 0
  ? '\n全部 ' + (passCount + failCount) + ' 项：' + passCount + ' 通过, 0 失败'
  : '\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
