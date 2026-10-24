/**
 * [第六轮复核 R6-01..R6-05] 定向回归。
 *
 * R6-01（P1）同一个 Key 被两种指纹编码当成不同来源，并自废票据
 * R6-02（P1）内置 WorkBuddy 的新来源与账号选择没进入观察身份
 * R6-03（P2）可选积分包明细吃掉 8 秒工具预算，已知合计被丢掉
 * R6-04（P2）解析错误把上游正文 / 合成 Key 哨兵返回 GUI
 * R6-05（P3）status 兼容分支未贯穿调用者
 *
 * 全部离线：合成 ctx / 合成 transport，不发真实请求，不读真实凭据。
 *
 * 用法：node tools/test-workbuddy-round6.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  credentialFingerprint,
} from '../plans/custom-balance.js'
import {
  fetchFromGateway,
  selectedAccountsFingerprint,
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

function makeCtx(opts) {
  const o = opts || {}
  const baseURL = o.baseURL || 'http://localhost:7863/v1'
  const ref = o.ref || 'WB_KEY'
  const key = o.key === undefined ? 'sk-gateway' : o.key
  const rows = o.noProvider === true
    ? [{ entry: { options: { id: 'llm-pi-ai', config: { providers: {} } } }, override: {}, inherited: {} }]
    : [{
      entry: {
        options: {
          id: 'llm-pi-ai',
          config: { providers: { workbuddy: { baseURL, apiKeyEnv: ref } } },
        },
      },
      override: {}, inherited: {},
    }]
  return {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders: () => CATALOG }
      if (name === 'configEditor') return { configuration: () => rows }
      if (name === 'credentials') return { resolve: async () => ({ value: key }) }
      return undefined
    },
  }
}

const STATUS = {
  accounts: [{ credits: 42, credits_total: 100, realm: 'cn', disabled: false }],
}

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  }
}

// ===========================================================================
// R6-01 — 指纹规范：只用一套编码
// ===========================================================================
{
  /**
   * 审核指出工具有一套（无盐 SHA256 前 16）、GUI 有一套（带盐前 12），
   * 同一个 Key 必然"换源"。现在两边都调 `credentialFingerprint`。
   */
  const fp = credentialFingerprint('sk-same-key')
  check('R6-01a 指纹长度固定为 12（与 GUI 同规范）', typeof fp === 'string' && fp.length === 12, fp)
  check('R6-01b 同 Key 稳定', credentialFingerprint('sk-same-key') === fp)
  check('R6-01c 不同 Key 不同', credentialFingerprint('sk-other') !== fp)
  check('R6-01d 空 Key 用固定标记', credentialFingerprint('') === 'none')
  check('R6-01e 指纹不等于无盐 SHA256 前 16（确认走的是带盐规范）',
    fp !== createHash('sha256').update('sk-same-key').digest('hex').slice(0, 16), fp)
}

// ===========================================================================
// R6-05 — 包装 Response 只有 status/text 也要能取数
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    // 故意不提供 ok / json
    text: async () => JSON.stringify(STATUS),
  })
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R6-05a 只有 status+text 的包装 Response 也能成功',
    out.error === undefined && out.creditsTotal === 42, { err: out.error, msg: out.message, total: out.creditsTotal })
}

// ===========================================================================
// R6-04 — 解析失败只给固定分类，不回显上游正文
// ===========================================================================
{
  const SENTINEL = 'sk-SENTINEL-do-not-echo'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    // 非法 JSON，且正文里带哨兵
    text: async () => '{"echo":"' + SENTINEL + '", broken',
  })
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  const msg = String(out.message || '')
  check('R6-04a 解析失败被归类为 exec', out.error === 'exec', out.error)
  check('R6-04b 消息里没有上游正文片段', msg.indexOf(SENTINEL) === -1, msg)
  check('R6-04c 消息里没有"返回内容开头"', msg.indexOf('返回内容开头') === -1, msg)
  check('R6-04d 消息里没有解析器原文（Unexpected token/position）',
    !/Unexpected token|in JSON at position|原因：/.test(msg), msg)
  check('R6-04e 仍然带可诊断的固定分类码', /invalid-json/.test(msg) && /HTTP 200/.test(msg), msg)
}

// ===========================================================================
// R6-03 — 明细挂住不能吃掉已成功的合计
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  let statusServed = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('/panel/api/packages')) {
      // 明细**永远不返回**（模拟挂起）
      return await new Promise(() => {})
    }
    statusServed += 1
    return okResponse(STATUS)
  }
  const started = Date.now()
  let out
  try {
    out = await fetchFromGateway(makeCtx(), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
  const elapsed = Date.now() - started
  check('R6-03a /status 成功时合计仍然交付（不被明细拖没）',
    out.error === undefined && out.creditsTotal === 42, { err: out.error, total: out.creditsTotal })
  check('R6-03b 状态确实只取了一次', statusServed === 1, statusServed)
  check('R6-03c 明细超时远小于主超时（<6s 内返回）', elapsed < 6000, elapsed)
  check('R6-03d 明细拿不到时退回账号汇总一行，详情不空',
    Array.isArray(out.creditsAccounts) && out.creditsAccounts.length >= 1, out.creditsAccounts && out.creditsAccounts.length)
}

// ===========================================================================
// R6-03 — 预算贯穿：剩余预算不足时不再发起明细
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return okResponse(STATUS)
  }
  let out
  try {
    out = await fetchFromGateway(
      makeCtx(),
      { id: 'workbuddy', name: 'WorkBuddy' },
      {},
      { remaining: () => 900 },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R6-03e 剩余预算很小时仍然交付合计', out.error === undefined && out.creditsTotal === 42,
    { err: out.error, total: out.creditsTotal })
}

// ===========================================================================
// R6-02 — 账号选择进入来源身份（规范化）
// ===========================================================================
{
  check('R6-02a 空选择/未选 = all', selectedAccountsFingerprint('[]') === 'all')
  check('R6-02b 非法 JSON 视为 all（不崩）', selectedAccountsFingerprint('{oops') === 'all')
  check('R6-02c 与顺序无关',
    selectedAccountsFingerprint('["b","a"]') === selectedAccountsFingerprint('["a","b"]'))
  check('R6-02d 换成另一组账号会变',
    selectedAccountsFingerprint('["a"]') !== selectedAccountsFingerprint('["b"]'))
  check('R6-02e 去重后与单个等价',
    selectedAccountsFingerprint('["a","a"]') === selectedAccountsFingerprint('["a"]'))
  check('R6-02f 不输出 uid 原文',
    selectedAccountsFingerprint('["secret-uid-1234"]').indexOf('secret-uid-1234') === -1)
}

// ===========================================================================
// R6-02 — 来源（主机/引用/删除）变化体现为取数失败或不同结果
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const served = []
  globalThis.fetch = async (url, init) => {
    served.push(String(url))
    return okResponse(STATUS)
  }
  try {
    await fetchFromGateway(makeCtx({ baseURL: 'http://localhost:7863/v1' }), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
    await fetchFromGateway(makeCtx({ baseURL: 'http://127.0.0.1:7863/v1' }), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R6-02g 不同主机各自解析到自己的 /status',
    served.length >= 2 && served[0] !== served[1], served.slice(0, 2))

  const originalFetch2 = globalThis.fetch
  globalThis.fetch = async () => okResponse(STATUS)
  let out
  try {
    out = await fetchFromGateway(makeCtx({ noProvider: true }), { id: 'workbuddy', name: 'WorkBuddy' }, {}, undefined)
  } finally {
    globalThis.fetch = originalFetch2
  }
  check('R6-02h 模型里删掉 provider 后不再取数（给可操作提示）',
    out.error !== undefined && /设置 → 模型/.test(String(out.message || '')) && out.creditsTotal === undefined,
    { err: out.error, msg: out.message })
}

// ===========================================================================
// R6-01 / R6-02 — 源码契约（防止编码分叉再出现）
// ===========================================================================
{
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('R6-01f identify 与 GUI 共用 credentialFingerprint（不再用无盐 shortHash 采样）',
    host.indexOf('credentialFingerprint(resolved.value)') !== -1
    && host.indexOf('shortHash(resolved.value)') === -1)
  check('R6-01g 首次采样不清状态（有 prev === undefined 早退）',
    /if \(prev === undefined\) return/.test(host))
  check('R6-01h 凭据指纹不再进入观察身份（避免自废票据）',
    host.indexOf("parts.push('cred='") === -1)
  check('R6-02i WorkBuddy 身份含真实来源与账号选择',
    /id === 'workbuddy'/.test(host)
    && host.indexOf("parts.push('src=' + src)") !== -1
    && host.indexOf("parts.push('acct=' + selectedAccountsFingerprint(") !== -1)
  check('R6-02j 账号选择指纹只有一份实现（import 自 plans/workbuddy.js）',
    host.indexOf('selectedAccountsFingerprint') !== -1
    && !/const selectedAccountsFingerprint = \(raw\)/.test(host))
}
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
