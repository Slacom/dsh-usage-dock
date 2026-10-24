/**
 * [第八轮复核 R8-01 / R8-02] 定向回归。
 *
 * R8-01（P1）：工具 identify / 成功缓存命中采样到 B 时，把一张**旧的、仍挂起的
 *             GUI A 票**提升到 B 代次，旧 A 返回后照样提交，把 context 从 9000
 *             改回 1。根因是「按渠道取全局最新票」，而不是「本次采样自己的票」。
 *
 * R8-02（P2）：调用者 signal 已 abort、但 remaining 仍是正数时，仍向 /status
 *             与 /packages 各发一次携带 Bearer 的请求。
 *
 * 本文件用**真实观察器**验证票据归属规则，用**合成 transport**验证取消守卫；
 * 不访问真实网关、不读真实凭据。
 *
 * 用法：node tools/test-workbuddy-round8.mjs
 */
import { createQuotaObserver, promoteOwnTicket } from '../plans/quota-observer.js'
import { fetchFromGateway } from '../plans/workbuddy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')) }
}

// ===========================================================================
// R8-01 — 只有「本次采样自己的票」能被提升
// ===========================================================================
{
  const observer = createQuotaObserver()
  const ID = 'custom:r8ticket0001'
  const IDENT = 'id|src=fixed'

  // 已经存在 B 的成功观察（模拟工具先用 B 取到 9000 并写入缓存/投影）
  const ticketB = observer.begin({ id: ID, identity: IDENT })
  observer.commit(ticketB, { kind: 'ok', channels: [{ id: ID, balance: 9000 }] })
  const beforeB = observer.read(ID, IDENT)
  check('R8-01a 预置：B 的观察存在且为 9000',
    beforeB !== null && beforeB.status === 'ok', beforeB && beforeB.status)

  // 一张**旧的、仍挂起的** GUI A 票据
  const ticketOldA = observer.begin({ id: ID, identity: IDENT })
  // 工具 identify 采样到 B（缓存命中，没有自己的取数票）
  const nextEpoch = observer.bumpEpoch(ID)
  const promotedNone = promoteOwnTicket(ticketOldA, undefined, nextEpoch)
  check('R8-01b 无归属票时**不提升**任何票', promotedNone === false)

  // 旧 A 返回：必须被 epoch 拒绝
  const committedA = observer.commit(ticketOldA, { kind: 'ok', channels: [{ id: ID, balance: 1 }] })
  check('R8-01c 迟到的旧 A 被拒绝（不会把 9000 改回 1）',
    committedA === null || committedA === undefined, committedA)
  /**
   * 凭据变化本来就会清掉旧观察（R5-02 的要求），所以这里不能断言「仍读到 B」。
   * 要断言的是：**旧 A 没有被写进去** —— 记录要么为空（已被撤销），要么不是 1。
   */
  const after = observer.read(ID, IDENT)
  const afterBalance = after !== null && after.channels && after.channels[0]
    ? after.channels[0].balance
    : null
  check('R8-01d 旧 A 的 1 没有进入观察（为空或被撤销，绝不为 1）',
    afterBalance !== 1, { afterBalance })
}

// ===========================================================================
// R8-01 — 有归属票时提升，本次合法结果仍可提交（不能退回 R7-01 空窗）
// ===========================================================================
{
  const observer = createQuotaObserver()
  const ID = 'custom:r8ticket0002'
  const IDENT = 'id|src=fixed'

  const first = observer.begin({ id: ID, identity: IDENT })
  observer.commit(first, { kind: 'ok', channels: [{ id: ID, balance: 1 }] })

  // 新一次 GUI 采集：它就是发现 A→B 的那次，持有自己的票
  const ownTicket = observer.begin({ id: ID, identity: IDENT })
  const nextEpoch = observer.bumpEpoch(ID)
  const promoted = promoteOwnTicket(ownTicket, ownTicket, nextEpoch)
  check('R8-01e 有归属票时提升成功', promoted === true)

  const committed = observer.commit(ownTicket, { kind: 'ok', channels: [{ id: ID, balance: 9000 }] })
  check('R8-01f 本次合法新值可提交（不出现"暂无数据"空窗）',
    committed !== null && committed !== undefined, committed)
  check('R8-01g 该票提交后不再被 epoch 拒绝（无迟到拒绝）',
    committed !== null && (committed.status === undefined || committed.status !== 'rejected'), committed)
}

// ===========================================================================
// R8-01 — 归属票必须是**当前待提交**那一张
// ===========================================================================
{
  const observer = createQuotaObserver()
  const ID = 'custom:r8ticket0003'
  const IDENT = 'id|src=fixed'
  const older = observer.begin({ id: ID, identity: IDENT })
  const newer = observer.begin({ id: ID, identity: IDENT })
  const nextEpoch = observer.bumpEpoch(ID)
  // 传的是 older，但当前待提交是 newer → 不得提升 older
  check('R8-01h 非当前待提交票不被提升',
    promoteOwnTicket(newer, older, nextEpoch) === false)
  const committedOlder = observer.commit(older, { kind: 'ok', channels: [{ id: ID, balance: 1 }] })
  check('R8-01i 该旧票仍被拒绝', committedOlder === null || committedOlder === undefined)
}

// ===========================================================================
// R8-02 — 父 signal 已取消：零请求
// ===========================================================================
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

{
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify(STATUS) }
  }
  const controller = new AbortController()
  controller.abort()
  let out
  try {
    out = await fetchFromGateway(
      makeCtx(),
      { id: 'workbuddy', name: 'WorkBuddy' },
      {},
      { remaining: () => 5000, signal: controller.signal },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R8-02a 父 signal 已取消时**零 HTTP**', calls.length === 0, calls)
  check('R8-02b 返回可辨的取消结果，不当作失败',
    out.error === 'cancelled' && out.transient === false && out.cancelled === true,
    { err: out.error, transient: out.transient })
}

// ===========================================================================
// R8-02 — 请求进行中父 signal 取消：在途连接被中止
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let sawAbort = false
  globalThis.fetch = async (url, init) => {
    const childSignal = init && init.signal
    return await new Promise((resolve, reject) => {
      const onAbort = () => { sawAbort = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
      if (childSignal && childSignal.aborted) return onAbort()
      if (childSignal && typeof childSignal.addEventListener === 'function') {
        childSignal.addEventListener('abort', onAbort)
      }
      // 永不自行完成：只能靠取消结束
    })
  }
  let out
  const run = fetchFromGateway(
    makeCtx(),
    { id: 'workbuddy', name: 'WorkBuddy' },
    {},
    { remaining: () => 5000, signal: controller.signal },
  )
  // 让 provider 走到 fetch 再取消
  await new Promise((r) => setTimeout(r, 20))
  controller.abort()
  try {
    out = await run
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R8-02c 在途请求收到父取消（子 signal 被 abort）', sawAbort === true)
  check('R8-02d 取消结果归 cancelled，不是暂时失败',
    out.error === 'cancelled' && out.transient === false, { err: out.error, transient: out.transient })
}

// ===========================================================================
// R8-02 — 正控制：signal 未取消时正常成功
// ===========================================================================
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(STATUS) })
  const controller = new AbortController()
  let out
  try {
    out = await fetchFromGateway(
      makeCtx(),
      { id: 'workbuddy', name: 'WorkBuddy' },
      {},
      { remaining: () => 5000, signal: controller.signal },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  check('R8-02e 未取消时正常取到合计（不误伤）',
    out.error === undefined && out.creditsTotal === 42, { err: out.error, total: out.creditsTotal })
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
