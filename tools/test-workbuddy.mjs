/**
 * plans/workbuddy.js 单元测试（离线，status 端点用本地 http 服务模拟）。
 *
 * 口径对照 dsh-workbuddy-connect（本机安装副本逐一核对）：
 *   - status 端点仅回环；404 = 未安装；signed-out 不显示；
 *   - credits = { total, accounts[], unlimited?, expiry? }；creditsError 语义错误透传。
 *
 * 跑法：node tools/test-workbuddy.mjs
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { setWebBase, fetchPlan } from '../plans/workbuddy.js'

let passCount = 0
let failCount = 0

function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')) }
}

/** 起一个按 path 返回的 mock 服务，跑完即关（等待 close 落定，避免 libuv 断言）。 */
async function withServer(routes, fn) {
  const srv = http.createServer((req, res) => {
    const hit = routes[req.url]
    res.writeHead(hit ? hit.code : 404, { 'content-type': 'application/json' })
    res.end(hit ? hit.body : '{}')
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  try {
    return await fn('http://127.0.0.1:' + srv.address().port)
  } finally {
    await new Promise((resolve) => srv.close(() => resolve()))
  }
}

// W1 双版本并存：合计 + 明细透传。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 3401.5, accounts: [{ packageName: '企业额度', remain: 3401.5 }] } }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 2275, accounts: [{ packageName: '标准套餐', remain: 2275, size: 3000 }] } }) },
  }, async (base) => { setWebBase(base); return await fetchPlan() })
  check('W1a 合计 = 两版本相加', wire.creditsTotal === 5676.5, wire)
  check('W1b 明细带 variant 标签', wire.creditsAccounts.length === 2
    && wire.creditsAccounts[0].variant === 'WorkBuddy'
    && wire.creditsAccounts[1].variant === 'WorkBuddy AI', wire)
  check('W1c variants 小计齐全', wire.variants.length === 2, wire)
}

// W2 单版本登录：另一版本 signed-out 不显示。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 100 } }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-out' }) },
  }, async (base) => { setWebBase(base); return await fetchPlan() })
  check('W2 仅国内版登录 → 合计 100、明细仅一条', wire.creditsTotal === 100 && wire.creditsAccounts.length === 0, wire)
}

// W3 未安装：两个端点都 404。
{
  const wire = await withServer({}, async (base) => { setWebBase(base); return await fetchPlan() })
  check('W3 双 404 → not-installed', wire.error === 'not-installed', wire)
}

// W4 未登录（都 signed-out）→ signed-out 语义提示。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/status': { code: 200, body: JSON.stringify({ status: 'signed-out' }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-out' }) },
  }, async (base) => { setWebBase(base); return await fetchPlan() })
  check('W4 双 signed-out → signed-out 提示', wire.error === 'signed-out', wire)
}

// W5 creditsError 语义错误透传。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/status': { code: 200, body: JSON.stringify({ status: 'signed-in', creditsError: 'token expired' }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-out' }) },
  }, async (base) => { setWebBase(base); return await fetchPlan() })
  check('W5 creditsError 透传', wire.error === 'api' && wire.message.includes('token expired'), wire)
}

// W6 不限额：unlimited → creditsUnlimited、creditsTotal null。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 0, unlimited: true } }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 404, body: '{}' },
  }, async (base) => { setWebBase(base); return await fetchPlan() })
  check('W6 unlimited → creditsUnlimited', wire.creditsUnlimited === true && wire.creditsTotal === null, wire)
}

// W7 网络失败（连接拒绝）→ exec 错误。
{
  setWebBase('http://127.0.0.1:1') // port 1 几乎必然连接失败
  const wire = await fetchPlan()
  check('W7 传输失败 → exec + 原因', wire.error === 'exec' && wire.message.includes('WorkBuddy 状态读取失败'), wire)
}

// W8 另一版本失败时不能将部分积分报告成完整合计。
{
  const original = globalThis.fetch
  try {
    setWebBase('http://127.0.0.1:12345')
    for (const kind of ['semantic', 'transport']) {
      globalThis.fetch = async (url) => {
        if (String(url).includes('/ai/')) {
          if (kind === 'transport') throw new Error('offline')
          return { status: 200, json: async () => ({ status: 'signed-in', creditsError: 'token expired' }) }
        }
        return { status: 200, json: async () => ({ status: 'signed-in', credits: { total: 100 } }) }
      }
      const wire = await fetchPlan()
      check('W8 部分成功 + ' + kind + ' 不静默少算', wire.error === (kind === 'semantic' ? 'api' : 'exec') && wire.creditsTotal === undefined, wire)
    }
    globalThis.fetch = undefined
    const unavailable = await fetchPlan()
    check('W9 缺 fetch 返回结构化错误', unavailable.error === 'exec', unavailable)
    const aborter = globalThis.AbortController
    try {
      globalThis.AbortController = undefined
      const exceptional = await fetchPlan()
      check('W10 外层异常返回结构化错误（execError 导入守卫）', exceptional.error === 'exec', exceptional)
    } finally { globalThis.AbortController = aborter }
  } finally { globalThis.fetch = original }
}

console.log(failCount === 0
  ? '\n全部 ' + (passCount + failCount) + ' 项：' + passCount + ' 通过, 0 失败'
  : '\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
// 用 exitCode 而非 process.exit：AbortSignal.timeout 的句柄在 exit 时机上有
// libuv 断言竞态（win/async.c），自然退出可避开；断言本身已全部完成。
process.exitCode = failCount === 0 ? 0 : 1
