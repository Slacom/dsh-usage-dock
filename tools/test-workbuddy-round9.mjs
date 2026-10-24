/**
 * [第九轮复核 R9-01..R9-03 / 冻结根因 A、B、C] 定向回归。
 *
 * A（P1）操作归属：旧凭据解析迟到不得重新激活旧源
 * B（P2）主状态正文取消必须归 C，不能算 T
 * C（P2）所有公开错误出口只允许固定分类，不透传 exception 原文
 *
 * 离线：合成 ctx / 合成 transport，不发真实请求、不读真实凭据。
 *
 * 用法：node tools/test-workbuddy-round9.mjs
 */
import { readFileSync } from 'node:fs'
import { fetchFromGateway, listWorkbuddyAccounts } from '../plans/workbuddy.js'

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
// R9-02 / 根因 B — 正文阶段取消必须归 C
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = async (url, init) => {
    const child = init && init.signal
    return {
      ok: true,
      status: 200,
      text: async () => {
        // 模拟「响应头已到、正在读正文」时被取消
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          }
          if (child && child.aborted) return onAbort()
          if (child && typeof child.addEventListener === 'function') child.addEventListener('abort', onAbort)
          setTimeout(resolve, 50)
        })
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    }
  }
  const run = fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, {
    remaining: () => 5000,
    signal: controller.signal,
  })
  await new Promise((r) => setTimeout(r, 10))
  controller.abort()
  let out
  try { out = await run } finally { globalThis.fetch = originalFetch }
  check('R9-02a 正文阶段取消 → error=cancelled（不是 exec）', out.error === 'cancelled', out.error)
  check('R9-02b 不计 T：transient=false', out.transient === false, out.transient)
  check('R9-02c 不产生 invalid-json 分类', !/invalid-json/.test(String(out.message || '')), out.message)
  check('R9-02d 客户端不会显示为失败（stale=true）', out.stale === true, out.stale)
}

// ===========================================================================
// R9-03 / 根因 C — 公开错误出口不得回显 exception 原文
// ===========================================================================
{
  const SENTINEL = 'SYNTHETIC_KEY_WITH\nNEWLINE_abcdef'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Invalid header value: ' + SENTINEL) }
  let wire
  let accounts
  try {
    wire = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
    accounts = await listWorkbuddyAccounts(makeCtx())
  } finally {
    globalThis.fetch = originalFetch
  }
  const wireMsg = String(wire.message || '')
  const accMsg = String(accounts.message || '')
  check('R9-03a 主 wire 不含 exception 原文', wireMsg.indexOf('SYNTHETIC_KEY') === -1, wireMsg)
  check('R9-03b 主 wire 不含 Invalid header 原文', !/Invalid header/.test(wireMsg), wireMsg)
  check('R9-03c 账号列表不含 exception 原文', accMsg.indexOf('SYNTHETIC_KEY') === -1, accMsg)
  check('R9-03d 仍带可操作分类（transport）', /transport/.test(wireMsg) && /transport/.test(accMsg),
    { wireMsg, accMsg })
}

{
  // 外层兜底 catch 也必须脱敏
  const SENTINEL2 = 'SYNTHETIC_KEY_OUTER_0123456789'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new Error(SENTINEL2), { code: 'EOTHER' }) }
  let out
  try {
    // 直接调 plan wrapper（含外层 catch）
    const mod = await import('../plans/workbuddy.js')
    out = await mod.workbuddy.fetch(makeCtx(), undefined, {}, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R9-03e 外层 catch 同样不含 exception 原文',
    String(out.message || '').indexOf('SYNTHETIC_KEY_OUTER') === -1, out.message)
}

// ===========================================================================
// R9-01 / 根因 A — 源码契约（操作归属贯穿三个入口）
// ===========================================================================
{
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('R9-01a 有操作序号协议（beginOp / isCurrentOp）',
    /const beginOp = \(id\) =>/.test(host) && /const isCurrentOp = \(id, seq\) =>/.test(host))
  check('R9-01b 过时操作不得改来源状态（采样前置守卫）',
    /if \(!isCurrentOp\(id, opSeq\)\) return/.test(host))
  check('R9-01c identify 为自定义与内置渠道都领序号',
    /opSeqs\[entry\.id\] = opSeq/.test(host) && /opSeqs\[plan\.id\] = beginOp\(plan\.id\)/.test(host))
  check('R9-01d collect 拒绝已过时的 identify 快照',
    /const staleSnapshot = \(id\) => !isCurrentOp\(id, identifySeqs\[id\]\)/.test(host)
    && /if \(staleSnapshot\(plan\.id\)\) continue/.test(host)
    && /if \(staleSnapshot\(id\)\) continue/.test(host))
  check('R9-01e 工具 collect 也登记全局 pending 票（不再只写本地）',
    /pendingTickets\.set\(id, customTicket\)/.test(host))
  check('R9-01f GUI 采样回调携带自己的票据与序号',
    /recordSampledCredential\(\s*id, fingerprint, customTicketsFor\.get\(id\), opSeqsFor\.get\(id\),?\s*\)/.test(host))
  check('R9-01g 已移除按渠道取「全局最新票」的旧实现',
    host.indexOf('latestTicketOf') === -1)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
