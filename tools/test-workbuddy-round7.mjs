/**
 * [第七轮复核 R7-01..R7-03] 定向回归。
 *
 * R7-01（P2）已知 Key A→B 的 GUI 采样仍自废本次合法票据
 * R7-02（P2）账号列表/设置路由仍回显解析器原文
 * R7-03（P2）预算耗尽后仍发 HTTP，且私有任务重新获得完整 8 秒
 *
 * 全部离线：合成 ctx / 合成 transport，不发真实请求，不读真实凭据。
 *
 * 用法：node tools/test-workbuddy-round7.mjs
 */
import { readFileSync } from 'node:fs'
import {
  fetchFromGateway,
  listWorkbuddyAccounts,
} from '../plans/workbuddy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

const CATALOG = [{
  provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'workbuddy'], defaultBaseURL: '',
}]

function makeCtx() {
  const rows = [{
    entry: {
      options: {
        id: 'llm-pi-ai',
        config: { providers: { workbuddy: { baseURL: 'http://localhost:7863/v1', apiKeyEnv: 'WB_KEY' } } },
      },
    },
    override: {}, inherited: {},
  }]
  return {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => CATALOG }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-gateway' }) }
      return undefined
    },
  }
}

const STATUS = { accounts: [{ credits: 42, credits_total: 100, realm: 'cn', disabled: false }] }

// ===========================================================================
// R7-02 — 账号列表错误不得回显上游正文
// ===========================================================================
{
  const SENTINEL = 'SYNTHETIC_KEY_0123456789'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    // 非法 JSON，解析器 message 会带出正文开头
    text: async () => SENTINEL + ' this is not json',
  })
  let out
  try {
    out = await listWorkbuddyAccounts(makeCtx())
  } finally {
    globalThis.fetch = originalFetch
  }
  const msg = String(out.message || '')
  check('R7-02a 账号列表失败时返回空列表', Array.isArray(out.accounts) && out.accounts.length === 0)
  check('R7-02b 账号列表消息里没有上游正文', msg.indexOf('SYNTHETIC_KEY') === -1, msg)
  check('R7-02c 账号列表消息里没有解析器原文',
    !/Unexpected token|is not valid JSON|in JSON at position/.test(msg), msg)
  check('R7-02d 仍带固定分类与 HTTP 状态',
    /invalid-json/.test(msg) && /HTTP 200/.test(msg), msg)
}

// ===========================================================================
// R7-03 — 预算耗尽时零请求
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify(STATUS) }
  }
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, { remaining: () => 0 })
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R7-03a remaining=0 时不发任何 HTTP', calls.length === 0, calls)
  check('R7-03b remaining=0 时给出可辨的「未取」结果',
    out.error !== undefined && /预算/.test(String(out.message || '')), { err: out.error, msg: out.message })
}

{
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify(STATUS) }
  }
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, { remaining: () => -50 })
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R7-03c 负剩余同样零请求', calls.length === 0, calls)
}

// ===========================================================================
// R7-03 — 剩余不足以跑明细时不再外发明细
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify(STATUS) }
  }
  let out
  try {
    // 剩余 600ms：够跑 /status，但明细预算 = 600-50 = 550 > 0，仍会尝试；
    // 这里只断言「合计仍然交付」，明细是否发出由下一个用例覆盖。
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, { remaining: () => 600 })
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R7-03d 剩余紧张时合计仍交付', out.error === undefined && out.creditsTotal === 42,
    { err: out.error, total: out.creditsTotal })
}

// ===========================================================================
// 用户新网关：/status 可用但 /panel/api/packages 404 → 合计照常交付
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/panel/api/packages')) {
      return { ok: false, status: 404, text: async () => 'not found' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(STATUS) }
  }
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, { remaining: () => 7000 })
  } finally {
    globalThis.fetch = originalFetch
  }
  check('G-新网关a 明细 404 时合计仍然交付', out.error === undefined && out.creditsTotal === 42,
    { err: out.error, total: out.creditsTotal })
  check('G-新网关b 明细不可用时退回账号汇总一行，详情不空',
    Array.isArray(out.creditsAccounts) && out.creditsAccounts.length === 1,
    out.creditsAccounts && out.creditsAccounts.length)
  check('G-新网关c 没有把 404 当成整条渠道失败', out.isAvailable === true)
}
// ===========================================================================
// R7-01 的票据归属已改由 tools/test-workbuddy-round8.mjs 的行为回归覆盖
// （真实观察器 + promoteOwnTicket 纯函数）。这里只保留 R7-03 的源码契约。
// ===========================================================================
{
  const reg = readFileSync(new URL('../plans/usage-tool-register.js', import.meta.url), 'utf8')
  check('R7-03e 私有任务不再重开完整 8 秒（调用者剩余预算被夹入）',
    /taskFor\(key, (shareableIds|privateIds), snapshot, callerRemaining\)/.test(reg)
    && /Math\.min\(budgetMs, clamped\)/.test(reg))
  check('R7-03f 预算耗尽时任务直接完成、零请求',
    /taskBudget <= 0/.test(reg) && /progress\.done = true/.test(reg))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
