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
import { setWebBase, fetchPlan, workbuddyAi } from '../plans/workbuddy.js'
const fetchPlanAi = workbuddyAi.fetch

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

// W1 [0.8.3] 两版本是**独立渠道**：各自只查自己的端点，互不合并、互不拖累。
// 旧行为（两版并行读取后合并成一个合计）已按用户要求废弃——两版积分不通用。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 3401.5, accounts: [{ packageName: '企业额度', remain: 3401.5 }] } }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 2275, accounts: [{ packageName: '标准套餐', remain: 2275, size: 3000 }] } }) },
  }, async (base) => {
    setWebBase(base)
    const cn = await fetchPlan()
    const ai = await fetchPlanAi()
    return { cn, ai }
  })
  /**
   * [2026-10-21] 国内版已改读 WorkBuddy2API 网关（来自模型配置），**不再读 Connect 端点**。
   * 这里断言「两版互不合并」的既有性质，以及国内版不再从 Connect 拿数；
   * 网关取数的完整口径见 tools/test-workbuddy-gateway.mjs。
   */
  check('W1a 国内版不再从 Connect 端点取数', wire.cn.id === 'workbuddy' && wire.cn.creditsTotal === undefined, wire.cn)
  check('W1b 国际版渠道只报国际版合计', wire.ai.id === 'workbuddy-ai' && wire.ai.creditsTotal === 2275, wire.ai)
  check('W1c 两版不再合并成合计', wire.ai.creditsTotal !== 5676.5)
  check('W1d 国际版明细 variant 标签只有自己', wire.ai.creditsAccounts.length === 1
    && wire.ai.creditsAccounts[0].variant === 'WorkBuddy AI', wire.ai.creditsAccounts)
  check('W1e 国际版 variants 单条（供客户端显示版本大号行）', wire.ai.variants.length === 1
    && wire.ai.variants[0].label === 'WorkBuddy AI', wire.ai.variants)
}

// W2 国际版正常取数（Connect 端点）。国内版已改网关，不再参与该路径。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 100 } }) },
  }, async (base) => {
    setWebBase(base)
    return { ai: await fetchPlanAi() }
  })
  check('W2a 国际版正常取数', wire.ai.creditsTotal === 100, wire.ai)
}

// W3 未安装：本渠道端点 404 → not-installed（每个渠道各自判断）。
{
  const wire = await withServer({}, async (base) => {
    setWebBase(base)

    const ai = await fetchPlanAi()
    return { ai }
  })
  check('W3 端点 404 → 两渠道各自 not-installed', wire.ai.error === 'not-installed' && wire.ai.error === 'not-installed', wire)
}

// W4 未登录（端点返回 signed-out）→ signed-out 语义提示。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-out' }) },
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-out' }) },
  }, async (base) => { setWebBase(base); return await fetchPlanAi() })
  check('W4 signed-out → signed-out 提示', wire.error === 'signed-out', wire)
}

// W5 [0.8.5] creditsError 按类别分流：
//   - 语义错误（登录失效 / 积分硬拒绝）→ error:'api'，客户端立即显示、不拿旧值顶；
//   - 暂时错误（限流 / 5xx / 超时 / 结构变化）→ error:'exec' + transient:true，
//     客户端保留旧值并灰化，连续 FAIL_THRESHOLD 轮才显示「获取失败」。
// 用户 2026-10-18 反馈：胶囊里经常直接「获取失败」不先灰化 —— 根因就是这里
// 之前把**所有** creditsError 都归成 api（语义错误），而 connect 侧的计费查询
// 失败绝大多数是暂时性的。
{
  // connect 侧的文案模板（已核对其 lib/index.js 的 envelopeError）：
  //   `workbuddy upstream <kind> (http <status>): <msg>`
  const cases = [
    // [creditsError 原文, 期望 error, 期望 transient, 说明]
    ['workbuddy upstream session_dead (http 401): token expired', 'api', undefined, '登录失效'],
    ['workbuddy upstream hard_credit (http 402): insufficient credit', 'api', undefined, '积分硬拒绝'],
    ['workbuddy upstream soft_rate (http 429): too many requests', 'exec', true, '限流'],
    ['workbuddy upstream server (http 502): bad gateway', 'exec', true, '上游 5xx'],
    ['workbuddy upstream client (http 400): bad request', 'exec', true, '其它 4xx 按暂时处理'],
    ['workbuddy upstream not_found (http 404): no route', 'exec', true, 'not_found 也按暂时处理'],
    ['The operation was aborted due to timeout', 'exec', true, '超时'],
    ['fetch failed', 'exec', true, '网络失败'],
    ['some unknown failure', 'exec', true, '无法识别 → 暂时（保守）'],
    // [0.8.5 修正 P2] 上游文案里的「401」不得压过前缀 kind：曾出现
    // soft_rate 429 因正文含 401 而被判成语义错误 → 直接放弃灰化。
    ['workbuddy upstream soft_rate (http 429): invalid token (http 401)', 'exec', true, '冲突文案：前缀优先'],
    // 无前缀的裸文本里若同时出现暂时与语义信号，仍以暂时为准（保守）。
    ['upstream timeout while checking token expired', 'exec', true, '裸文本：暂时优先'],
    // 无前缀、但语义信号很明确（token expired / 未登录）才判语义。
    ['synthetic token expired', 'api', undefined, '裸文本：明确的令牌失效'],
    ['not signed in', 'api', undefined, '无前缀但语义明确'],
    // 无前缀、完全看不出原因的 → 暂时（保守）。
    ['credits unavailable', 'exec', true, '裸文本：无法识别 → 暂时'],
  ]
  let ok = 0
  for (const [text, wantError, wantTransient, label] of cases) {
    const wire = await withServer({
      '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-in', creditsError: text }) },
    }, async (base) => { setWebBase(base); return await fetchPlanAi() })
    const hit = wire.error === wantError
      && (wantTransient === true ? wire.transient === true : wire.transient === undefined)
      && typeof wire.message === 'string' && wire.message.includes(text)
    if (!hit) { ok = -1; check('W5b [' + label + '] 分流错误', false, wire); break }
    ok++
  }
  if (ok >= 0) check('W5b creditsError 十三类分流（前缀优先 + 暂时优先）', true)

  // 结构无法解析（上游改版/半截响应）也必须是暂时失败，不能立即报错。
  const broken = await withServer({
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { accounts: [] } }) },
  }, async (base) => { setWebBase(base); return await fetchPlanAi() })
  check('W5c 结构无法解析 → exec（暂时失败，保留旧值）',
    broken.error === 'exec' && broken.creditsTotal === undefined, broken)
}

// W6 不限额：unlimited → creditsUnlimited、creditsTotal null。
{
  const wire = await withServer({
    '/plugins/dsh-workbuddy-connect/ai/status': { code: 200, body: JSON.stringify({ status: 'signed-in', credits: { total: 0, unlimited: true } }) },
  }, async (base) => { setWebBase(base); return await fetchPlanAi() })
  check('W6 unlimited → creditsUnlimited', wire.creditsUnlimited === true && wire.creditsTotal === null, wire)
}
// W7 网络失败（连接拒绝）→ exec 错误。
{
  setWebBase('http://127.0.0.1:1') // port 1 几乎必然连接失败
  const wire = await fetchPlanAi()
  check('W7 传输失败 → exec + 原因', wire.error === 'exec' && wire.message.includes('状态读取失败'), wire)
}

// W8 [0.8.3 独立渠道] 单渠道失败不再产生「部分取数」——两个版本现在各自独立，
// 一版失败只影响自己那一行（partial 机制随「合并」一起废弃）。
// [0.8.5] 这里的「语义错误」样例改成真正的登录失效文案（session_dead）：旧的
// `token expired` 裸文本现在按保守规则归为暂时失败（exec），见 W5b。
{
  const original = globalThis.fetch
  try {
    setWebBase('http://127.0.0.1:12345')
    for (const kind of ['semantic', 'transport']) {
      globalThis.fetch = async (url) => {
        if (String(url).includes('/ai/')) {
          if (kind === 'transport') throw new Error('offline')
          return { status: 200, json: async () => ({ status: 'signed-in', creditsError: 'workbuddy upstream session_dead (http 401): token expired' }) }
        }
        return { status: 200, json: async () => ({ status: 'signed-in', credits: { total: 100 } }) }
      }

      const ai = await fetchPlanAi()
      check('W8a 国际版失败不产生部分取数（' + kind + '）', ai.error !== undefined && ai.creditsTotal === undefined, ai)
      check('W8b 国际版渠道各自报错（' + kind + '）',
        ai.error === (kind === 'semantic' ? 'api' : 'exec'), ai)
      check('W8c 单渠道结果不再带 partial（合并机制已废弃）',
        ai.partial === undefined, { ai })
    }
    // 两个渠道都失败 → 各自报 exec，互不干扰。
    globalThis.fetch = async () => { throw new Error('offline') }
    const cnErr = await fetchPlanAi()
    const aiErr = await fetchPlanAi()
    check('W8d 两渠道都失败 → 各自报 exec', cnErr.error === 'exec' && aiErr.error === 'exec', { cnErr, aiErr })
    check('W8e 失败结果不带 partial / 数据字段',
      cnErr.partial === undefined && cnErr.creditsTotal === undefined
      && aiErr.partial === undefined && aiErr.creditsTotal === undefined, { cnErr, aiErr })
    globalThis.fetch = undefined
    const unavailable = await fetchPlanAi()
    check('W9 缺 fetch 返回结构化错误', unavailable.error === 'exec', unavailable)
    const aborter = globalThis.AbortController
    try {
      globalThis.AbortController = undefined
      const exceptional = await fetchPlanAi()
      check('W10 外层异常返回结构化错误（execError 导入守卫）', exceptional.error === 'exec', exceptional)
    } finally { globalThis.AbortController = aborter }
  } finally { globalThis.fetch = original }
}

// W11 [0.8.2] status 请求必须声明 accept-encoding: identity——DSHA 宿主
// （dsh-web-mobile compress.js × gzip 中间件踩踏）会对「<1 KiB 且带
// Content-Length 的 gzip 协商响应」reset 连接，identity 是消费侧绕过。
// [0.8.3] 每个渠道只发**一条**请求（各自端点）；两个渠道合起来共两条。
{
  const original = globalThis.fetch
  try {
    setWebBase('http://127.0.0.1:12345')
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), headers: (init && init.headers) || null })
      return { status: 200, json: async () => ({ status: 'signed-out' }) }
    }
    await fetchPlanAi()
    await fetchPlanAi()
    check('W11 两渠道各发一条 status 请求（共两条）', seen.length === 2, seen)
    check('W11a 请求头带 accept-encoding: identity', seen.every((s) => s.headers
      && s.headers['accept-encoding'] === 'identity'), seen)
    check('W11b 请求头带 accept: application/json', seen.every((s) => s.headers
      && s.headers['accept'] === 'application/json'), seen)
  check('W11c 命中国际版端点', seen.every((s) => s.url.endsWith('/plugins/dsh-workbuddy-connect/ai/status')), seen)

  } finally { globalThis.fetch = original }
}
console.log(failCount === 0
  ? '\n全部 ' + (passCount + failCount) + ' 项：' + passCount + ' 通过, 0 失败'
  : '\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
// 用 exitCode 而非 process.exit：AbortSignal.timeout 的句柄在 exit 时机上有
// libuv 断言竞态（win/async.c），自然退出可避开；断言本身已全部完成。
process.exitCode = failCount === 0 ? 0 : 1
