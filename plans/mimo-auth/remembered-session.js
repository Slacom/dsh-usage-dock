/**
 * remembered-session.js — 「记住登录」managed owner（Host-only，唯一上游轮询者）
 *
 * 与旧链的关系：
 *   - 旧 `console-session.js` / `session-display.js` / 旧手动 display 模式**保持原样**；
 *     本模块是**新增**的 managed owner，代码开关 `enableRememberedAccount` 打开时由它在
 *     路由层取代旧 managed 入口（旧动作在该模式下固定拒绝，0 请求）。
 *   - 不复用旧 `DISPLAY_LIMITS`（15 min / 14 次）：本模式固定 **60 s** 后台自动读
 *     （Host 唯一 vendor timer，不依赖 UI 挂载），自动刷新上限由「本人忘记 / 服务端拒绝」决定，
 *     不是本地次数。普通读失败连续 5 次才对外「读取失败」，见 `REMEMBERED_LIMITS.readFailureLimit`。
 *
 * 持久化边界：
 *   - 账号态只经 `rememberedVault`（DPAPI + 宿主 credentials record 密文）落盘；
 *     本模块**只**把 `protocol.exportRememberedAccount()` 的返回塞进 record.account。
 *   - 平台短票 / 余额 / QR / URL / 账号 ID 都不写普通 cfg、日志或 DTO。
 *   - 无明文 fallback：vault 能力不足 ⇒ 固定 `unsupported`，不降级。
 *
 * 网络边界：
 *   - `status()` / `capability()` / 快照全是**纯观察**：0 网络、0 vendor、0 解密。
 *   - 只有这些动作会出站：begin 的 login（QR 扫码）、confirm 后的首读、定时刷新、
 *     pause/resume/forget 的本地 CAS 写（无网络）。
 *   - 启动自动恢复是**独立任务**（`boot()`），不在 read/status/caps 里 ensureAuth。
 */

import { randomBytes } from 'node:crypto'
import { createConsoleProtocol, CONSOLE_PROTOCOL_CODES, projectConsoleHandoffSummary } from './console-protocol.js'
import { displayDtoBase } from './session-display.js'

/** 记住登录只支持这一个命名空间（固定，不从 route/UI 收）。 */
export const REMEMBERED_NAMESPACE = 'xiaomi-account-user-id'

/**
 * 本模式的限额。**不是**旧 DISPLAY_LIMITS：
 * 刷新间隔固定 60 s，自动刷新次数不设上限（直到本人忘记或被服务端拒绝）。
 */
export const REMEMBERED_LIMITS = Object.freeze({
  /** 首扫 + 待确认窗口（从 start 起算，不因 status/qr/confirm 重置）。 */
  pendingMs: 120000,
  /** 日常自动读间隔：固定 60 s（唯一上游轮询节拍，Host 自己的 timer）。 */
  intervalMs: 60000,
  /** 每次余额操作的硬预算。 */
  readMs: 10000,
  /**
   * 普通读失败（网络/解析/读操作自身超时）的**展示**阈值：
   * 第 1..4 次保上次成功值（freshness 'stale'），第 5 次对外 `balance=null / freshness 'failed'`；
   * 认证/绑定/owner 失效**不**等这个阈值，立即终止（见 requestRead 的分支顺序）。
   * 达到阈值也**不**停 timer：下一次成功自动恢复。
   */
  readFailureLimit: 5,
  /** 二维码字节上限（内存交付，不进 JSON）。 */
  qrMaxBytes: 256 * 1024,
})

export const REMEMBERED_CODES = Object.freeze({
  OK: 'E_NONE',
  DISABLED: 'E_MIMO_REMEMBERED_DISABLED',
  UNSUPPORTED: 'E_MIMO_REMEMBERED_UNSUPPORTED',
  BAD_REQUEST: 'E_MIMO_AUTH_BAD_REQUEST',
  STALE_ID: 'E_MIMO_REMEMBERED_STALE_ID',
  BUSY: 'E_MIMO_REMEMBERED_BUSY',
  NOT_READY: 'E_MIMO_REMEMBERED_NOT_READY',
  QR_UNAVAILABLE: 'E_MIMO_REMEMBERED_QR_UNAVAILABLE',
  APPROVAL_MISSING: 'E_MIMO_AUTH_APPROVAL_MISSING',
  APPROVAL_UNKNOWN: 'E_MIMO_AUTH_APPROVAL_UNKNOWN',
  EXPIRED: 'E_MIMO_AUTH_TARGET_EXPIRED',
  CONSENT_REQUIRED: 'E_MIMO_REMEMBERED_CONSENT_REQUIRED',
  CONFIRM_FAILED: 'E_MIMO_REMEMBERED_CONFIRM_FAILED',
  SAVE_FAILED: 'E_MIMO_REMEMBERED_SAVE_FAILED',
  PAUSE_SAVE_FAILED: 'E_MIMO_REMEMBERED_PAUSE_SAVE_FAILED',
  FORGET_FAILED: 'E_MIMO_REMEMBERED_FORGET_FAILED',
  RESTORE_FAILED: 'E_MIMO_REMEMBERED_RESTORE_FAILED',
  RECORD_UNREADABLE: 'E_MIMO_REMEMBERED_RECORD_UNREADABLE',
  BINDING_MISMATCH: 'E_MIMO_REMEMBERED_BINDING_MISMATCH',
  READ_TIMEOUT: 'E_MIMO_REMEMBERED_READ_TIMEOUT',
  AUTH_REJECTED: 'E_MIMO_AUTH_REJECTED',
  IDENTITY_MISMATCH: 'E_MIMO_AUTH_IDENTITY_MISMATCH',
  NETWORK: 'E_MIMO_CONSOLE_TRANSIENT',
  BALANCE_PARSE: 'E_MIMO_CONSOLE_BALANCE_PARSE',
  FLOW: 'E_MIMO_CONSOLE_FLOW'
})

const R = REMEMBERED_CODES
const KNOWN = new Set(Object.values(R))
const coded = (code, message) => {
  const fixed = KNOWN.has(code) ? code : R.FLOW
  const e = new Error(typeof message === 'string' && message !== '' ? fixed + ' ' + message : fixed)
  e.code = fixed
  return e
}
const HEX32 = /^[a-f0-9]{32}$/
const PROTOCOL_CODES = new Set(Object.values(CONSOLE_PROTOCOL_CODES))

function protocolCodeOf(error) {
  const c = error !== null && typeof error === 'object' ? error.code : ''
  return PROTOCOL_CODES.has(c) ? c : R.FLOW
}

/** 终态（需要本人重新确认或已停止）：不再自动刷新。 */
const TERMINAL = new Set(['failed', 'stopped', 'unsupported', 'disabled'])
/** 活着的、会占用上游的态。 */
const LIVE = new Set(['authorizing', 'awaiting_confirmation', 'verified', 'paused', 'restoring'])

/**
 * 「普通读失败」固定闭集：只有这些计入 `readFailures`（1..4 保旧值 stale，第 5 次公开失败）。
 * 认证拒绝 / 凭据缺失 / 身份不符 / owner 失效 / 取消 / 保存错误**都不在这里**：
 * 前者立即终止，后者只影响记住登录的写入，不冒充余额读取失败。
 */
const COUNTED_READ_FAILURES = new Set([
  CONSOLE_PROTOCOL_CODES.TRANSIENT,
  CONSOLE_PROTOCOL_CODES.BALANCE_PARSE,
  CONSOLE_PROTOCOL_CODES.EXPIRED,
  'E_REQUEST_TIMEOUT'
])

const isSafeInt = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** record 的最小结构校验（解密成功之后仍然要校验形状）。 */
function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  if (record.version !== 1) return null
  const consent = record.consent
  if (consent === null || typeof consent !== 'object' || Array.isArray(consent)) return null
  if (consent.version !== 1) return null
  if (consent.autoRestore !== true || consent.autoReadBalance !== true || consent.autoRefresh !== true) return null
  if (!isSafeInt(consent.confirmedAt)) return null
  const prefs = record.preferences
  if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) return null
  if (typeof prefs.paused !== 'boolean') return null
  const account = record.account
  if (account === null || typeof account !== 'object' || Array.isArray(account)) return null
  if (account.version !== 1 || account.namespace !== REMEMBERED_NAMESPACE) return null
  if (typeof account.accountId !== 'string' || account.accountId === '') return null
  if (!Array.isArray(account.cookies) || account.cookies.length === 0) return null
  return record
}

/**
 * @param {object} options
 * @param {string} options.bootEpoch            32 hex（每 boot 一个）
 * @param {object} options.vault                createRememberedVault(...) 的实例（**必须**由调用方注入）
 * @param {() => boolean|Promise<boolean>} [options.isEnabled] 当前渠道/全局开关（每个 tick 前重读）
 * @param {() => number} [options.now]
 * @param {Function} [options.setTimeout]
 * @param {Function} [options.clearTimeout]
 * @param {object} [options.transportDeps]      只给代码级测试注入 fakeDNS/request
 */
export function createRememberedSession(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const bootEpoch = typeof source.bootEpoch === 'string' && source.bootEpoch !== '' ? source.bootEpoch : ''
  const now = typeof source.now === 'function' ? source.now : Date.now
  const schedule = typeof source.setTimeout === 'function' ? source.setTimeout : globalThis.setTimeout
  const unschedule = typeof source.clearTimeout === 'function' ? source.clearTimeout : globalThis.clearTimeout
  const vault = source.vault !== null && typeof source.vault === 'object' ? source.vault : null
  const isEnabledFn = typeof source.isEnabled === 'function' ? source.isEnabled : null
  /**
   * 同步 enabled 缓存（Host watcher 维护）：**只读**、不发请求。
   * 协议每个 hop 的 `isLive`/`ownerLive` 都读它，所以 Host 一旦探测到关闭，
   * 在途 SSO/callback/retry 立即 0 跳；未提供时视为 true（保持旧行为）。
   */
  const isEnabledSyncFn = typeof source.isEnabledSync === 'function' ? source.isEnabledSync : null
  const transportDeps = source.transportDeps !== null && typeof source.transportDeps === 'object'
    ? { ...source.transportDeps }
    : {}

  let disposed = false
  /**
   * 操作栅栏：每个 async 动作在入口取一个 op（id + AbortController），
   * 任何 await 之后、写全局状态之前都必须 `isCurrent(op)`；取消/忘记/暂停/禁用/dispose/换 owner
   * 会 `invalidateOps()` 使旧 op 全部失效并 abort。晚到的成功/失败只返回固定码，不改 state、
   * 不删新绑定、不读新候选、不发下一请求。
   */
  let opSeq = 0
  const activeOps = new Set()
  /** 'booting' | 'disabled' | 'unsupported' | 'unreadable' | 'empty' | 'authorizing'
   *  | 'awaiting_confirmation' | 'restoring' | 'verified' | 'paused' | 'failed' | 'stopped' */
  let state = 'booting'
  /** 启动自动恢复任务：所有本人动作先与它对齐，避免「boot 还没判定就拒/就开扫」。 */
  let bootPromise = null
  let bootSettled = false
  let code = R.OK
  let revisionSeq = 0
  let generation = 0
  /**
   * **display 视图专用**的单调 generation（非敏感，只增不减）。
   * 客户端按 `display.generation < prev.generation` 丢弃快照；如果退出/失败/空态时
   * 把 generation 退回 0，墓碑会被丢掉、旧余额残留。controller.snapshot 的
   * `live ? generation : 0` 口径**不变**（routes 的控制动作 gen 校验继续用它）。
   */
  let displayGen = 0
  /** 保存/加载的 CAS 令牌（只在 Host 内存）。 */
  let casRevision = null
  /** 当前 boot 内已知的偏好（用于 pause 失败时回滚判断）。 */
  let pausedPref = false
  /** 已解密的账号绑定 ID（**不输出**到 DTO）。 */
  let boundId = null
  /** 上一次成功写入密文的账号导出（Host 私有，仅用于「有没有变化」比较）。 */
  let lastExport = null
  let balance = null
  let fetchedAt = null
  let readAttempts = 0
  let readSuccesses = 0
  /** 连续普通读失败次数（0..readFailureLimit，封顶）。每次**实际读**失败 +1，成功归零。 */
  let readFailures = 0
  /** 旧字段名（同一语义，保留给仍读 stats.transientStreak 的旧 UI）。 */
  let transientStreak = 0
  let refreshCount = 0
  let lastCode = R.OK
  /** 诊断用：失败阶段（固定 enum）与协议固定码；成功/新动作时清空。 */
  let failureStage = null
  let reasonCode = ''
  /** 失败时的已知 ACCOUNT 目标安全摘要（5 字段、来自 protocol；不持久化） */
  let handoffSnapshot = null
  let restoreAttempts = 0
  let restoreSuccesses = 0
  let vaultCaps = { supported: null, code: R.OK }
  /** 当前待确认候选（**只**在 awaiting_confirmation 期间存在于内存）。 */
  let candidate = null
  let expiresAt = null
  let qr = null
  let approval = null
  let authId = null
  let protocol = null
  let lease = null
  let pendingTimer = null
  let balanceFlight = null
  let balanceFlightOp = null
  /** tombstone 提交在途：新的首扫必须等它落定，避免用旧 casRevision 抢跑 */
  let deleteFlight = null
  /** 任何 safeForget 的 revision-transition 在途计数（覆盖 commit+ack+元数据回写） */
  let deleteTransitions = 0
  let tickTimer = null
  let nextReadAt = null
  /** 身份标签（masked，绝不输出原始 ID）。 */
  let maskedLabel = null

  function bump() { revisionSeq += 1; return revisionSeq }

  /** 记录 display 侧的单调代次（每次真实 owner 代次前进后调用；绝不回退）。 */
  function raiseDisplayGen() { if (generation > displayGen) displayGen = generation; return displayGen }

  const FAILURE_STAGES = new Set(['restore', 'login', 'read', 'store'])
  /** 只记录固定诊断：阶段 enum + 协议固定码（未知/非协议 → FLOW；store 无协议码 → ''）。 */
  function noteFailure(stage, protocolCode) {
    failureStage = FAILURE_STAGES.has(stage) ? stage : null
    if (typeof protocolCode !== 'string' || protocolCode === '') reasonCode = ''
    else reasonCode = PROTOCOL_CODES.has(protocolCode) ? protocolCode : CONSOLE_PROTOCOL_CODES.FLOW
  }
  function clearFailure() { failureStage = null; reasonCode = ''; handoffSnapshot = null }

  /** 开始一次受栅栏保护的操作（每个 async 动作只取一次；内部链路继承同一个 op）。 */
  function beginOp(kind) {
    const op = { id: ++opSeq, kind, controller: new AbortController() }
    op.signal = op.controller.signal
    activeOps.add(op)
    return op
  }
  function endOp(op) { if (op !== null && op !== undefined) activeOps.delete(op) }

  /** 失效**全部**在途操作：旧 confirm/save/load/read 立即变 stale，且拿到 aborted signal。 */
  function invalidateOps() {
    opSeq += 1
    for (const op of activeOps) { try { op.controller.abort() } catch { /* ok */ } }
    activeOps.clear()
    balanceFlight = null
    balanceFlightOp = null
  }

  function isCurrent(op) {
    return op !== null && op !== undefined && op.id === opSeq && disposed !== true && op.signal.aborted !== true
  }

  const staleResult = (code) => ({ ok: false, code: typeof code === 'string' ? code : R.STALE_ID })

  function disarmPending() {
    if (pendingTimer !== null) { try { unschedule(pendingTimer) } catch { /* ok */ } pendingTimer = null }
  }
  function disarmTick() {
    if (tickTimer !== null) { try { unschedule(tickTimer) } catch { /* ok */ } tickTimer = null }
    nextReadAt = null
  }

  function settleApproval(value) {
    const p = approval
    approval = null
    if (p !== null && typeof p.resolve === 'function') { try { p.resolve(value) } catch { /* ok */ } }
  }

  /** 释放当前 protocol（先失效 lease，保证任何在途 op 立即不再 live）。 */
  function dropProtocol() {
    const p = protocol
    protocol = null
    const l = lease
    lease = null
    if (l !== null) { try { l.revoked = true } catch { /* ok */ } }
    settleApproval(false)
    if (p !== null) { try { p.dispose() } catch { /* ok */ } }
  }

  /** 清掉一切私有值（**不**删除记住登录）。含 last-good 余额 / 失败计数 / freshness。 */
  function clearValues() {
    balance = null
    fetchedAt = null
    candidate = null
    qr = null
    maskedLabel = null
    boundId = null
    lastExport = null
    readFailures = 0
    transientStreak = 0
    refreshCount = 0
    disarmTick()
  }

  /** 已到「公开失败」阈值 ⇒ 余额/取数时间**一律不对外**（内存里仍可留 last-good）。 */
  function readFailedOut() { return readFailures >= REMEMBERED_LIMITS.readFailureLimit }

  /**
   * 公开 freshness（固定闭集）：
   *   - 'failed' 连续普通读失败到阈值；
   *   - 'paused' 本人暂停（暂停不冒充 fresh）；
   *   - 'stale'  1..4 次普通读失败，显示的是上次成功值；
   *   - null     还没有成功过（**不**编 0 金额）；
   *   - 'fresh'  最近一次读成功。
   */
  function freshnessNow() {
    if (readFailedOut()) return 'failed'
    if (pausedPref === true || state === 'paused') return 'paused'
    if (readFailures > 0) return 'stale'
    return balance === null ? null : 'fresh'
  }

  function ownerLive() {
    if (isEnabledSyncFn !== null && isEnabledSyncFn() !== true) return false
    return disposed !== true && LIVE.has(state) && lease !== null && lease.revoked !== true
  }

  async function enabledNow() {
    if (isEnabledFn === null) return false
    try { return (await isEnabledFn()) === true } catch { return false }
  }

  /**
   * 统一 enabled 闸门：false 或读失败 ⇒ **主动 disable**（撤 lease/abort 在途、清值，不 forget），
   * 不是只回一个错误码而保留 verified；只有当前 op 才能 disable 新 owner。
   */
  async function enabledGate(op) {
    if ((await enabledNow()) === true) return true
    if (op === null || op === undefined || isCurrent(op)) disable()
    return false
  }

  /** capability 只合成、不读 record；结果缓存供 status 同步使用。 */
  async function refreshCaps() {
    if (vault === null) { vaultCaps = { supported: false, code: R.UNSUPPORTED }; return vaultCaps }
    let out
    try { out = await vault.capability() } catch { out = null }
    const supported = out !== null && typeof out === 'object' && out.supported === true
    const c = out !== null && typeof out === 'object' && typeof out.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(out.code)
      ? out.code : (supported ? R.OK : R.UNSUPPORTED)
    vaultCaps = { supported, code: supported ? R.OK : (c === R.OK ? R.UNSUPPORTED : c) }
    return vaultCaps
  }

  // ── 快照（白名单重建；无票、无原始 ID、无 URL） ───────────────────────────
  function kernelStat(key) {
    try {
      const d = protocol === null ? null : protocol.describe()
      const v = d !== null && typeof d === 'object' ? d[key] : null
      return Number.isSafeInteger(v) && v >= 0 ? v : 0
    } catch { return 0 }
  }
  function snapshot() {
    const live = LIVE.has(state)
    const failedOut = readFailedOut()
    return {
      supported: state !== 'unsupported' && state !== 'disabled',
      managed: true,
      state,
      code,
      reasonCode,
      failureStage,
      handoffSummary: handoffSnapshot === null ? null : projectConsoleHandoffSummary(handoffSnapshot),
      revision: revisionSeq,
      authId: state === 'authorizing' || state === 'awaiting_confirmation' ? authId : null,
      generation: live ? generation : 0,
      expiresAt: state === 'awaiting_confirmation' || state === 'authorizing' ? expiresAt : null,
      hasQr: qr !== null,
      // 候选 ID **只**在 owner 的待确认态出现；确认/取消/过期立即消失
      candidate: state === 'awaiting_confirmation' && candidate !== null
        ? { label: '小米账号ID', identifier: candidate }
        : null,
      identity: maskedLabel === null ? null : { maskedLabel },
      // 连续普通读失败到阈值后：公开 null（内存 last-good 不外透），state 仍是 verified
      balance: failedOut ? null : balance,
      fetchedAt: failedOut ? null : fetchedAt,
      readFailures,
      freshness: freshnessNow(),
      paused: pausedPref === true || state === 'paused',
      intervalMs: REMEMBERED_LIMITS.intervalMs,
      nextReadAt,
      approval: approval === null ? null : {
        approvalId: approval.id,
        origin: approval.origin,
        purpose: 'consoleAuthResult',
        method: 'GET'
      },
      storage: { supported: vaultCaps.supported === true, code: vaultCaps.code },
      stats: {
        readAttempts,
        readSuccesses,
        refreshCount,
        restoreAttempts,
        restoreSuccesses,
        readFailures,
        // 旧字段名（= readFailures），保留兼容
        transientStreak,
        // 换票统计来自内核 describe（UI 用来区分「真的换过票」与「普通刷新」）
        renewalAttempts: kernelStat('renewalAttempts'),
        renewalSuccesses: kernelStat('renewalSuccesses')
      },
      canBegin: state === 'empty' || state === 'authorizing' ? state === 'empty' : false,
      canConfirm: state === 'awaiting_confirmation' && candidate !== null,
      canPause: state === 'verified',
      canResume: state === 'paused',
      canForget: state === 'verified' || state === 'paused' || state === 'failed' || state === 'awaiting_confirmation',
      canRetry: state === 'failed'
    }
  }

  /** 给现有胶囊/详情 overlay 的 display-兼容快照（同一 key 集 + managed 标记）。 */
  /**
   * display 侧安全裁剪：**绝不**带候选原始 ID。
   * 待确认态的真实候选只在 Host 内部 status/peek 里；displayStatus（含侧栏/详情）一律 candidate:null，
   * 不把 raw ID 改名塞到别的字段。
   */
  function displayRememberedView() {
    const view = snapshot()
    view.candidate = null
    return view
  }

  function displaySnapshot() {
    const base = displayDtoBase()
    const live = state === 'verified' || state === 'paused' || state === 'restoring'
    const failedOut = readFailedOut()
    /**
     * managed 墓碑：只要 managed owner 已接管（不是 disabled/unsupported），`selected` 恒 true。
     * 否则 empty/failed 等非 live 态会让客户端认为「没有来源被选中」而**回落到旧手工 Cookie
     * 值**（用户删输入但不删旧 cfgCookie 字段值）——退出/改号/失败后不得回填旧值。
     * 非 live 态同时把 balance/fetchedAt/identity 置空，display 正文不含金额或身份。
     */
    const tombstone = state !== 'disabled' && state !== 'unsupported'
    const identityVisible = tombstone && maskedLabel !== null && state !== 'empty' && state !== 'failed'
      && state !== 'unreadable' && state !== 'stopped'
    return {
      ...base,
      displaySupported: live,
      selected: tombstone,
      state: state === 'verified' ? 'verified'
        : state === 'paused' ? 'stopped'
          : state === 'restoring' ? 'holding'
            : 'absent',
      managed: true,
      // 单调 display 代次：退出/失败/空态**不退回 0**，否则客户端的 `gen < prev` 会丢掉墓碑
      generation: displayGen,
      revision: revisionSeq,
      identity: identityVisible ? { maskedLabel } : null,
      balance: failedOut ? null : balance,
      fetchedAt: failedOut ? null : fetchedAt,
      readFailures,
      freshness: freshnessNow(),
      code,
      remainingMs: null,
      // 本模式**不是** 15 min / 14 次：上限=无（直到本人忘记或服务端拒绝）
      refreshCount,
      maxAutoRefresh: 0,
      nextRefreshAt: nextReadAt,
      credentialExpiresAt: null,
      pendingExpiresAt: state === 'awaiting_confirmation' ? expiresAt : null,
      localLimits: {
        intervalMs: REMEMBERED_LIMITS.intervalMs,
        readMs: REMEMBERED_LIMITS.readMs,
        pendingMs: REMEMBERED_LIMITS.pendingMs,
        readFailureLimit: REMEMBERED_LIMITS.readFailureLimit,
        // 旧键名（= readFailureLimit），保留兼容
        transientLimit: REMEMBERED_LIMITS.readFailureLimit
      },
      remembered: displayRememberedView()
    }
  }

  // ── 启动自动恢复（独立任务；不在 read/status/caps 里 ensureAuth） ─────────
  function boot() {
    if (bootPromise === null) {
      bootPromise = runBoot()
        .catch(() => ({ ok: false, code: R.FLOW }))
        .finally(() => { bootSettled = true })
    }
    return bootPromise
  }

  /** 本人动作前与启动任务对齐：避免「boot 尚未判定」被误报成 disabled/失败。 */
  async function settleBoot() {
    if (bootPromise === null || bootSettled === true) return
    try { await bootPromise } catch { /* 状态快照里已有固定码 */ }
  }

  async function runBoot() {
    if (disposed) return { ok: false, code: R.DISABLED }
    const op = beginOp('boot')
    try {
      const caps = await refreshCaps()
      if (!isCurrent(op)) return staleResult()
      if (caps.supported !== true) {
        state = 'unsupported'
        code = caps.code
        bump()
        return { ok: false, code: caps.code }
      }
      if (!(await enabledGate(op))) {
        // 渠道/插件被禁用：**不解密、不请求**，也不清掉已记住的密文
        return { ok: false, code: R.DISABLED }
      }
      let loaded = null
      try { loaded = await vault.load({ signal: op.signal }) } catch { loaded = null }
      if (!isCurrent(op)) return staleResult()
      if (loaded === null || typeof loaded !== 'object') {
        noteFailure('store', '')
        state = 'unreadable'
        code = R.RECORD_UNREADABLE
        bump()
        return { ok: false, code: R.RECORD_UNREADABLE }
      }
      casRevision = typeof loaded.revision === 'string' ? loaded.revision : null
      if (loaded.record === null) {
        // tombstone / 从未记住：等本人发起，**不**自动弹二维码
        clearFailure()
        state = 'empty'
        code = R.OK
        bump()
        return { ok: true, code: R.OK, restored: false }
      }
      const record = validateRecord(loaded.record)
      if (record === null) {
        noteFailure('store', '')
        state = 'unreadable'
        code = R.RECORD_UNREADABLE
        bump()
        return { ok: false, code: R.RECORD_UNREADABLE }
      }
      pausedPref = record.preferences.paused === true
      if (pausedPref === true) {
        // 已暂停：显示已暂停，**0 账号请求**
        clearFailure()
        state = 'paused'
        code = R.OK
        maskedLabel = null
        bump()
        return { ok: true, code: R.OK, restored: false, paused: true }
      }
      return await restore(record.account, { automatic: true, op })
    } finally {
      endOp(op)
    }
  }

  async function restore(account, { automatic = false, op: inherited = null } = {}) {
    if (disposed) return { ok: false, code: R.DISABLED }
    const ownOp = inherited === null || inherited === undefined
    const op = ownOp ? beginOp('restore') : inherited
    try {
      const enabledAtStart = isCurrent(op)
      if (!(await enabledGate(op))) return enabledAtStart ? { ok: false, code: R.DISABLED } : staleResult()
      if (!isCurrent(op)) return staleResult()
      const savedId = typeof account?.accountId === 'string' ? account.accountId : ''
      if (savedId === '') return { ok: false, code: R.BINDING_MISMATCH }
      dropProtocol()
      state = 'restoring'
      code = R.OK
      restoreAttempts += 1
      // 每个 boot 内每次恢复都是一次新的 owner 代次（协议要求 generation >= 1）
      generation += 1
      raiseDisplayGen()
      bump()
      const gen = generation
      const l = { revoked: false }
      lease = l
      let p
      try {
        p = createConsoleProtocol({
          owner: l,
          bootEpoch,
          generation: gen,
          expected: { namespace: REMEMBERED_NAMESPACE, identifier: savedId },
          now,
          isLive: () => ownerLive() && l.revoked !== true,
          transportDeps
        })
      } catch {
        if (!isCurrent(op)) return staleResult()
        lease = null
        state = 'failed'
        code = R.UNSUPPORTED
        bump()
        return { ok: false, code: R.UNSUPPORTED }
      }
      protocol = p
      let out
      try {
        out = await p.restoreRememberedAccount(account, { deadlineAt: now() + REMEMBERED_LIMITS.readMs })
      } catch (error) {
        // 晚到的失败不得改新 owner 的状态，也不得删掉新绑定
        if (!isCurrent(op) || protocol !== p) return staleResult()
        const c = protocolCodeOf(error)
        // 诊断：先从当前协议安全导出 5 字段摘要（在 dropProtocol 之前），再记固定码
        try {
          const hs = projectConsoleHandoffSummary(protocol === null ? null : protocol.describe().handoffSummary)
          if (hs !== null) handoffSnapshot = hs
        } catch { /* 摘要失败不影响主错误 */ }
        noteFailure('restore', c)
        const fixed = c === CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH ? R.BINDING_MISMATCH
          : c === CONSOLE_PROTOCOL_CODES.TRANSIENT ? R.NETWORK
            : c === CONSOLE_PROTOCOL_CODES.ACCOUNT_CREDENTIAL_MISSING ? R.AUTH_REJECTED
              : R.RESTORE_FAILED
        if (fixed === R.BINDING_MISMATCH) {
          // 绑定不符：**不**反造预期、不重试；清掉密文（复用 forget 语义）
          dropProtocol()
          clearValues()
          state = 'failed'
          code = fixed
          bump()
          await safeForget(op)
          return { ok: false, code: fixed }
        }
        dropProtocol()
        if (fixed === R.NETWORK) {
          // 暂时网络失败：保留密文，等本人显式重试（不自动重连，不删记录）
          state = 'failed'
          code = fixed
          bump()
          return { ok: false, code: fixed }
        }
        clearValues()
        state = 'failed'
        code = fixed
        bump()
        return { ok: false, code: fixed }
      }
      if (!isCurrent(op) || protocol !== p) return staleResult()
      if (out === null || out.ok !== true) {
        noteFailure('restore', '')
        dropProtocol()
        state = 'failed'
        code = R.RESTORE_FAILED
        bump()
        return { ok: false, code: R.RESTORE_FAILED }
      }
      restoreSuccesses += 1
      clearFailure()
      boundId = savedId
      lastExport = account
      syncMasked()
      state = 'verified'
      code = R.OK
      pausedPref = false
      bump()
      // 首读：恢复后立刻一次（不是 QR、不是用户按钮）；继承同一 op，不另开代次
      await requestRead({ first: true, trigger: 'first', op })
      if (!isCurrent(op)) return staleResult()
      armTick()
      return { ok: true, code: state === 'verified' ? R.OK : code, automatic, restored: true }
    } finally {
      if (ownOp) endOp(op)
    }
  }

  function syncMasked() {
    try {
      const id = protocol === null ? null : protocol.verifyIdentity()
      const raw = id !== null && typeof id.identifier === 'string' ? id.identifier : boundId
      maskedLabel = raw === null ? null : maskId(raw)
    } catch { /* 身份不可读时保持上一次 */ }
  }

  function maskId(v) {
    if (typeof v !== 'string' || v === '') return null
    if (v.length <= 4) return '*'.repeat(v.length)
    return v.slice(0, 2) + '*'.repeat(Math.min(10, Math.max(2, v.length - 4))) + v.slice(-2)
  }

  /** 单一上游轮询 owner：先 disarm 再 arm，绝不叠加第二个 timer。 */
  function armTick() {
    disarmTick()
    if (disposed || state !== 'verified' || pausedPref === true) return
    nextReadAt = now() + REMEMBERED_LIMITS.intervalMs
    tickTimer = schedule(() => {
      tickTimer = null
      nextReadAt = null
      void tick()
    }, REMEMBERED_LIMITS.intervalMs)
    if (tickTimer !== null && typeof tickTimer.unref === 'function') tickTimer.unref()
  }

  /**
   * 定时拍（Host 唯一 timer）：到点读一次。
   * 已有在途读/刷新 flight ⇒ **加入**它，绝不再开第二个 op
   * （`beginOp` 会推进 opSeq，让上一个 op 立即 isCurrent()=false，首 op 的结果就被丢弃）。
   */
  async function tick() {
    if (disposed || state !== 'verified' || pausedPref === true) return
    // 绑定**本次等待前**的 owner：await 之后只有仍是同一 owner 才允许重排 timer
    const genAtStart = generation
    const pAtStart = protocol
    const joined = balanceFlight !== null
    await requestRead({ trigger: 'tick' })
    if (disposed) return
    if (state !== 'verified' || pausedPref === true) return
    // 旧 owner 的迟到读（新 owner 已经 verified）：绝不重排新 owner 的 60 s timer
    if (generation !== genAtStart) return
    if (protocol !== pAtStart && protocol !== null) return
    // joined 时由该 flight 的所有者（首读/refresh/上一 tick）决定；这里 armTick 幂等，
    // 保证「刷新完成后 reset 同一个 60 s timer，不会旧 tick 紧接再来一次额外读」。
    if (joined || balanceFlight === null) armTick()
  }

  /**
   * 唯一余额读入口（首读 / tick / 手动 refresh 共用）。
   *
   * 单飞硬约束：`beginOp()` 推进 opSeq ⇒ 任何**并发**调用者都必须在这里就加入已有 flight
   * （返回同一个 promise），不能先 beginOp。判定与发布在同一同步段内完成（无 await 夹在中间），
   * 所以 enableGate 的 await 窗口里来的 tick/手动刷新也会加入同一个 flight。
   * 计数（readAttempts/refreshCount/readFailures）只在 flight 内部 +1：每个**实际读**恰好一次。
   *
   * @returns {Promise<boolean>} 该次读是否成功（加入他人 flight 时返回他人结果）
   */
  function requestRead({ first = false, trigger = 'read', op: inherited = null } = {}) {
    if (disposed || protocol === null || state !== 'verified') return Promise.resolve(false)
    if (balanceFlight !== null) return balanceFlight
    const ownOp = inherited === null || inherited === undefined
    const op = ownOp ? beginOp(trigger) : inherited
    if (!isCurrent(op)) {
      if (ownOp) endOp(op)
      return Promise.resolve(false)
    }
    const gen = generation
    const p = protocol
    let flight = null
    // 延后一个微任务启动 body：保证 `balanceFlight` 在 body 第一行之前已发布（无重入窗口）
    flight = Promise.resolve().then(async () => {
      try {
        // 运行时开关闸门在 flight 内：禁用 ⇒ 中止在途、清旧值、0 请求（也未计数）
        if (ownOp && !(await enabledGate(op))) return false
        if (!isCurrent(op) || state !== 'verified' || protocol !== p || generation !== gen) return false
        // 计数只在**真正要发这一读**时 +1（每个实际读恰好一次，与订阅者/轮询次数无关）
        if (first !== true) refreshCount += 1
        readAttempts += 1
        bump()
        const out = await p.readBalance({ deadlineAt: now() + REMEMBERED_LIMITS.readMs })
        // 晚到的成功：不得写新 owner 的 state/余额
        if (!isCurrent(op) || state !== 'verified' || protocol !== p || generation !== gen) return false
        readSuccesses += 1
        readFailures = 0
        transientStreak = 0
        balance = out.balance
        fetchedAt = now()
        lastCode = R.OK
        code = R.OK
        clearFailure()
        maskedLabel = maskId(boundId)
        bump()
        void persistIfChanged(op)
        return true
      } catch (error) {
        if (!isCurrent(op) || protocol !== p || generation !== gen) return false
        const c = protocolCodeOf(error)
        // 诊断：只留协议固定码（不把外层 E_NONE 当 cause）
        noteFailure('read', c)
        // ① 认证/绑定终止：**立即**清旧值 + 计数（不等 5 次），原终止语义不削弱
        if (c === CONSOLE_PROTOCOL_CODES.AUTH_REJECTED || c === CONSOLE_PROTOCOL_CODES.ACCOUNT_CREDENTIAL_MISSING) {
          await terminateAndForget(R.AUTH_REJECTED, op)
          return false
        }
        if (c === CONSOLE_PROTOCOL_CODES.IDENTITY_MISMATCH) {
          await terminateAndForget(R.IDENTITY_MISMATCH, op)
          return false
        }
        // ② owner 已失效（退出/禁用/换号/暂停/代次变更）或已不在 verified：
        //    由对应动作负责清值，这里**不**记账、不冒充「普通读失败」
        if (!ownerLive() || state !== 'verified') return false
        // ③ 非普通失败（安全流程/协议自检类：FLOW / SSO_CHALLENGE / Cookie 策略 / NOT_VERIFIED …）：
        //    **不**计入 5 次 I/O 阈值，但**也不得**把旧余额当新值显示 —— fail-closed：
        //    立即撤活会话、清公开与私有缓存、进 failed 供 retry、停掉无效 timer；密文保留
        //    （只有既有 AUTH_REJECTED / IDENTITY_MISMATCH 路径才 forget）。
        if (!COUNTED_READ_FAILURES.has(c)) {
          failClosedRead()
          return false
        }
        // ④ 普通读失败（网络 / 纯余额解析 / 读操作自身 deadline 超时）：
        //    1..4 保上次成功值（stale），第 5 次公开失败；state 保持 verified、timer 不停，
        //    下一次成功自动复位。首次没有历史数据时余额保持 null（**不**编 0 金额）。
        readFailures = Math.min(REMEMBERED_LIMITS.readFailureLimit, readFailures + 1)
        transientStreak = readFailures
        lastCode = c === 'E_REQUEST_TIMEOUT' ? R.READ_TIMEOUT
          : c === CONSOLE_PROTOCOL_CODES.BALANCE_PARSE ? R.BALANCE_PARSE : R.NETWORK
        code = lastCode
        bump()
        return false
      } finally {
        if (balanceFlight === flight) { balanceFlight = null; balanceFlightOp = null }
        if (ownOp) endOp(op)
      }
    })
    balanceFlight = flight
    balanceFlightOp = op
    return flight
  }

  /**
   * 本人动作（详情展开）触发的刷新：**只**做一次真实余额读。
   * 不 retry、不 restore、不新扫、不清记录；已有在途 read/tick flight 就加入它（不重复计数）。
   *
   * 返回值 = **这次实际读**的结果：加入别人的 flight 只说明共用同一个操作，
   * **不**代表成功 —— 加入一个失败 flight 同样返回 `ok:false` + 该次失败的安全码。
   */
  async function refresh() {
    if (disposed) return { ok: false, code: R.DISABLED }
    await settleBoot()
    if (disposed) return { ok: false, code: R.DISABLED }
    if (state !== 'verified' || pausedPref === true) return { ok: false, code: R.NOT_READY }
    // 绑定**本次等待前**的 owner（代次 + 协议实例），await 之后据此判断是否还是同一个 owner
    const genAtStart = generation
    const pAtStart = protocol
    const ok = await requestRead({ trigger: 'refresh' })
    if (disposed) return { ok: false, code: R.DISABLED }
    // 自己的读 fail-closed / 被终止 / 暂停：按**原失败码**返回（不是 stale），且不重建 timer
    if (state !== 'verified' || pausedPref === true) return { ok: false, code: code || R.FLOW }
    // owner 代次已变（旧 owner 的读迟到，新 owner 已 verified）：stale，且**不**去 armTick 新 owner
    if (generation !== genAtStart) return staleResult()
    if (protocol !== pAtStart && protocol !== null) return staleResult()
    armTick()   // 同一 owner：无论成功还是普通读失败，都继续同一个 60 s 节拍
    if (ok === true) return { ok: true, code: R.OK }
    return { ok: false, code: code || R.FLOW }
  }

  /**
   * 非普通读失败（安全流程/协议自检类）的 fail-closed 收口。
   *
   * 与「普通读失败」的区别：普通失败（网络/纯解析/读自身超时）保留旧值并继续 60 s 节拍，
   * 到第 5 次才公开失败；而这类错误的协议侧已经清掉了 Jar/认证态（下一次读只会
   * `NOT_VERIFIED`），继续显示旧金额就是**把旧值当新值**（`freshness` 会被算成 fresh）。
   * 所以：不计入 5 次阈值，立即撤活会话 + 清公开/私有缓存 + 进 `failed`（retry 入口可用），
   * 停掉 timer。**不**写 tombstone：记住登录的密文保留，除既有 AUTH/身份不符路径外不 forget。
   */
  function failClosedRead() {
    dropProtocol()          // 租约作废 + protocol.dispose ⇒ 在途/后续读一律不再 live
    disarmTick()            // 不再自动空读：没有可用会话时不允许 60 s 节拍空转
    clearValues()           // 余额/取数时间/身份/计数全部清空（绝不冒充 fresh）
    state = 'failed'
    code = R.FLOW           // 对外固定码；真实安全 cause 留在 reasonCode（noteFailure 已记）
    lastCode = code
    bump()
  }

  /** 终止（鉴权/身份）并把记住登录一起清掉；网络/解析失败不走这里。 */
  async function terminateAndForget(fixed, op = null) {
    if (op !== null && !isCurrent(op)) return
    // 先失效所有在途（含触发本次终止的 read），再用**新的 cleanup op** 做删除交接，
    // 不能把已失效 op 交给 safeForget（否则 tomb 永远写不出去）
    invalidateOps()
    const cleanupOp = beginOp('cleanup')
    try {
      dropProtocol()
      disarmTick()
      clearValues()
      state = 'failed'
      code = fixed
      bump()
      await safeForget(cleanupOp)
    } finally {
      endOp(cleanupOp)
    }
  }


  /** 账号态有变化才重写密文（避免每 5 min 无谓写）。 */
  async function persistIfChanged(op = null) {
    if (protocol === null || boundId === null) return false
    if (op !== null && !isCurrent(op)) return false
    const p = protocol
    let next
    try { next = protocol.exportRememberedAccount() } catch { return false }
    if (lastExport !== null && sameExport(lastExport, next)) return false
    const record = makeRecord(next, { paused: pausedPref })
    const revisionAtStart = casRevision
    let saved
    try {
      saved = await vault.save(record, {
        expectedRevision: revisionAtStart,
        ...op === null ? {} : { signal: op.signal },
      })
    } catch {
      if (op !== null && !isCurrent(op)) return false
      if (protocol !== p) return false
      noteFailure('store', '')
      // 保存失败：不假装已记住（保留内存态，明确报固定码）
      code = R.SAVE_FAILED
      bump()
      return false
    }
    if (op !== null && !isCurrent(op)) return false
    if (protocol !== p) return false
    casRevision = saved !== null && typeof saved === 'object' && typeof saved.revision === 'string' ? saved.revision : casRevision
    lastExport = next
    clearFailure()
    return true
  }

  function sameExport(a, b) {
    try {
      const pick = (x) => JSON.stringify({
        accountId: x.accountId,
        cookies: (Array.isArray(x.cookies) ? x.cookies : []).map((c) => [c.name, c.value, c.domain, c.path, c.hostOnly, c.secure, c.httpOnly, c.expiresAt])
      })
      return pick(a) === pick(b)
    } catch { return false }
  }

  function makeRecord(account, { paused }) {
    return {
      version: 1,
      consent: {
        version: 1,
        autoRestore: true,
        autoReadBalance: true,
        autoRefresh: true,
        confirmedAt: now()
      },
      preferences: { paused: paused === true },
      account
    }
  }

  async function safeForget(op = null) {
    if (vault === null) return false
    if (op !== null && !isCurrent(op)) return false
    // revision-transition gate：从 commit 到 ack/元数据回写整体占用，期间新首扫必须 BUSY
    deleteTransitions += 1
    try {
      let out
      try { out = await vault.forget({}) } catch { return false }
      const rev = out !== null && typeof out === 'object'
        && typeof out.revision === 'string' && /^[a-f0-9]{16,64}$/.test(out.revision) ? out.revision : null
      if (rev === null) return false
      // 迟到 ack 不得覆盖新 owner 的 CAS 元数据
      if (op !== null && !isCurrent(op)) return false
      casRevision = rev
      lastExport = null
      return true
    } finally {
      deleteTransitions -= 1
    }
  }

  // ── 首扫：本地 start → begin（唯一出站点）→ QR → 待确认 ────────────────────
  async function startAuth(args = {}) {
    if (disposed) return { ok: false, code: R.DISABLED }
    await settleBoot()
    if (disposed) return { ok: false, code: R.DISABLED }
    if (state === 'unsupported' || state === 'disabled') return { ok: false, code: state === 'disabled' ? R.DISABLED : R.UNSUPPORTED }
    if (args === null || typeof args !== 'object' || args.authConsent !== true) return { ok: false, code: R.BAD_REQUEST }
    if (deleteFlight !== null || deleteTransitions !== 0) return { ok: false, code: R.BUSY }
    if (state === 'authorizing' || state === 'awaiting_confirmation' || state === 'restoring') {
      return { ok: false, code: R.BUSY }
    }
    // 关闸门：同步缓存已 false 就立即 disable；否则 await 一次 fresh 检查（读失败同样 fail closed）
    if (isEnabledSyncFn !== null && isEnabledSyncFn() !== true) {
      disable()
      return { ok: false, code: R.DISABLED }
    }
    const startOp = beginOp('start')
    try {
      if (!(await enabledGate(startOp))) return { ok: false, code: R.DISABLED }
    } finally {
      endOp(startOp)
    }
    // 换 owner：先失效旧 confirm/read/save，再建立新 authId
    invalidateOps()
    clearFailure()
    generation += 1
    raiseDisplayGen()
    dropProtocol()
    authId = randomBytes(16).toString('hex')
    expiresAt = now() + REMEMBERED_LIMITS.pendingMs
    qr = null
    candidate = null
    balance = null
    fetchedAt = null
    // 新 owner（换账号/重新扫码）：旧的读失败计数不得带过去
    readFailures = 0
    transientStreak = 0
    disarmTick()
    state = 'authorizing'
    code = R.OK
    bump()
    armPending()
    return { ok: true, code: R.OK, authId, generation }
  }

  function armPending() {
    disarmPending()
    pendingTimer = schedule(() => {
      pendingTimer = null
      expireIfDue()
    }, Math.max(1, (expiresAt === null ? now() : expiresAt) - now()))
    if (pendingTimer !== null && typeof pendingTimer.unref === 'function') pendingTimer.unref()
  }

  function expireIfDue() {
    if (!(state === 'authorizing' || state === 'awaiting_confirmation')) return
    if (expiresAt === null || now() < expiresAt) return
    // 取消/过期：清候选/QR/协议，**0 存储写、0 余额**；同时失效在途 confirm
    invalidateOps()
    dropProtocol()
    disarmPending()
    clearValues()
    authId = null
    expiresAt = null
    state = 'empty'
    code = R.EXPIRED
    bump()
  }

  function matches(id, gen) {
    if (typeof id !== 'string' || !HEX32.test(id)) return false
    if (!isSafeInt(gen)) return false
    return authId === id && generation === gen
  }

  /** 唯一的登录出站点（QR 只在这里产生）。 */
  function beginAuth(id, gen) {
    if (disposed) return { ok: false, code: R.DISABLED }
    if (!matches(id, gen)) return { ok: false, code: R.STALE_ID }
    expireIfDue()
    if (state !== 'authorizing' || protocol !== null) return { ok: false, code: R.BUSY }
    const op = beginOp('login')
    const l = { revoked: false }
    lease = l
    let p
    try {
      // 首扫**无 expected**：confirmAfterScan 模式下 login 由平台签发 ID 决定
      p = createConsoleProtocol({
        owner: l,
        bootEpoch,
        generation: gen,
        confirmAfterScan: true,
        now,
        isLive: () => ownerLive() && l.revoked !== true,
        transportDeps
      })
    } catch {
      lease = null
      state = 'failed'
      code = R.UNSUPPORTED
      bump()
      return { ok: false, code: R.UNSUPPORTED }
    }
    protocol = p
    const done = p.login({
      deadlineAt: expiresAt,
      onQr: (q) => {
        if (!isCurrent(op) || state !== 'authorizing') return
        if (q === null || typeof q !== 'object') return
        const bytes = q.bytes instanceof Uint8Array ? q.bytes : null
        if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > REMEMBERED_LIMITS.qrMaxBytes) return
        qr = { bytes: Uint8Array.from(bytes), mime: q.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png' }
        bump()
      },
      approveTarget: (info) => new Promise((resolve) => {
        if (!isCurrent(op) || approval !== null || state !== 'authorizing') { resolve(false); return }
        approval = {
          id: randomBytes(16).toString('hex'),
          origin: typeof info?.origin === 'string' ? info.origin : '',
          resolve
        }
        bump()
      })
    }).then(async () => {
      if (!isCurrent(op) || protocol !== p || state !== 'authorizing') { endOp(op); return }
      // 认证已完 → 候选（真实平台签发 ID），**不**落盘、**不**读余额
      let pend = null
      try { pend = p.pendingAccount() } catch { pend = null }
      if (pend === null || typeof pend.identifier !== 'string' || pend.identifier === '') {
        dropProtocol()
        state = 'failed'
        code = R.CONFIRM_FAILED
        bump()
        endOp(op)
        return
      }
      candidate = pend.identifier
      state = 'awaiting_confirmation'
      code = R.OK
      bump()
      endOp(op)
    }, () => {
      if (!isCurrent(op)) { endOp(op); return }
      if (protocol === p && (state === 'authorizing' || state === 'awaiting_confirmation')) {
        dropProtocol()
        clearValues()
        state = 'failed'
        code = R.CONFIRM_FAILED
        bump()
      }
      endOp(op)
    })
    return { ok: true, code: R.OK, done }
  }

  function takeQr(id, gen) {
    if (disposed) return { ok: false, code: R.DISABLED }
    if (!matches(id, gen)) return { ok: false, code: R.STALE_ID }
    expireIfDue()
    if (qr === null) return { ok: false, code: R.QR_UNAVAILABLE }
    const out = { ok: true, bytes: qr.bytes, mime: qr.mime }
    qr = null
    bump()
    return out
  }

  function decideApproval(id, gen, approvalId, allow) {
    if (disposed) return { ok: false, code: R.DISABLED }
    if (!matches(id, gen)) return { ok: false, code: R.STALE_ID }
    expireIfDue()
    if (approval === null) return { ok: false, code: R.APPROVAL_MISSING }
    if (typeof approvalId !== 'string' || approvalId !== approval.id) return { ok: false, code: R.APPROVAL_UNKNOWN }
    const p = approval
    approval = null
    bump()
    try { p.resolve(allow === true) } catch { /* ok */ }
    return { ok: true, code: R.OK }
  }

  /**
   * 本人确认：路由只带 authId/generation（**不**接受 ID 或原票）。
   * Host 自己取候选 → confirmAccount → export → vault.save(CAS) → 成功后首读 + 起定时器。
   */
  async function confirmAccountAction(id, gen) {
    if (disposed) return { ok: false, code: R.DISABLED }
    await settleBoot()
    if (!matches(id, gen)) return { ok: false, code: R.STALE_ID }
    expireIfDue()
    if (state !== 'awaiting_confirmation' || protocol === null || candidate === null) {
      return { ok: false, code: R.NOT_READY }
    }
    // 关键：在**任何 await 之前**固定这次确认的 owner/候选/CAS；await 之后只认这些引用。
    const op = beginOp('confirm')
    try {
      const p = protocol
      const cand = candidate
      const leaseAtStart = lease
      const revisionAtStart = casRevision
      const enabledAtStart = isCurrent(op)
      if (!(await enabledGate(op))) return enabledAtStart ? { ok: false, code: R.DISABLED } : staleResult()
      if (!isCurrent(op) || protocol !== p || lease !== leaseAtStart || candidate !== cand ||
        authId !== id || generation !== gen) {
        return staleResult()
      }
      let exported
      try {
        p.confirmAccount(cand)
        exported = p.exportRememberedAccount()
      } catch (error) {
        if (!isCurrent(op) || protocol !== p) return staleResult()
        const c = protocolCodeOf(error)
        noteFailure('login', c)
        code = c === CONSOLE_PROTOCOL_CODES.CONFIRM_REQUIRED ? R.NOT_READY : R.CONFIRM_FAILED
        bump()
        return { ok: false, code }
      }
      const record = makeRecord(exported, { paused: false })
      let saved
      try {
        saved = await vault.save(record, { expectedRevision: revisionAtStart, signal: op.signal })
      } catch {
        // 迟到失败：新 owner 可能已接管，**不**清值、**不**删新绑定
        if (!isCurrent(op) || protocol !== p) return staleResult()
        // 保存失败：不假装已记住、不先发余额；本次首扫作废，要求重新扫码
        noteFailure('store', '')
        dropProtocol()
        disarmPending()
        clearValues()
        authId = null
        expiresAt = null
        state = 'failed'
        code = R.SAVE_FAILED
        bump()
        return { ok: false, code: R.SAVE_FAILED }
      }
      // 迟到成功：密文可能已写入，但绝不能把新 owner 标成 verified
      if (!isCurrent(op) || protocol !== p || authId !== id || generation !== gen) return staleResult()
      casRevision = saved !== null && typeof saved === 'object' && typeof saved.revision === 'string' ? saved.revision : casRevision
      lastExport = exported
      boundId = exported.accountId
      candidate = null
      expiredCandidateCleanup()
      syncMasked()
      state = 'verified'
      code = R.OK
      clearFailure()
      pausedPref = false
      bump()
      // 只有在密文写入成功之后，才首次自动读余额；继承同一个 op
      await requestRead({ first: true, trigger: 'first', op })
      if (!isCurrent(op)) return staleResult()
      armTick()
      return { ok: true, code: state === 'verified' ? R.OK : code }
    } finally {
      endOp(op)
    }
  }

  function expiredCandidateCleanup() {
    disarmPending()
    expiresAt = null
  }

  // ── 暂停 / 恢复 / 忘记 / 重试 ────────────────────────────────────────────
  async function pause() {
    if (disposed) return { ok: false, code: R.DISABLED }
    await settleBoot()
    if (state !== 'verified') return { ok: false, code: R.NOT_READY }
    // 暂停即换 owner：让在途 read/save/confirm 立即 stale，再写 paused=true
    invalidateOps()
    const op = beginOp('pause')
    try {
      const revisionAtStart = casRevision
      const exportAtStart = lastExport
      // 先取消活动/清旧值：paused 不得冒充 fresh
      dropProtocol()
      disarmTick()
      balance = null
      fetchedAt = null
      readFailures = 0
      transientStreak = 0
      state = 'paused'
      code = R.OK
      pausedPref = true
      bump()
      let saved
      try {
        saved = await vault.save(makeRecord(exportAtStart, { paused: true }), {
          expectedRevision: revisionAtStart,
          signal: op.signal,
        })
      } catch {
        // 迟到失败：新 owner 可能已接管，**不**删它的 record
        if (!isCurrent(op)) return staleResult()
        noteFailure('store', '')
        // 暂停保存失败 ⇒ fail-closed：停掉并清掉密文，且如实报错（忘记失败也不假报）
        const forgot = await safeForget(op)
        if (!isCurrent(op)) return staleResult()
        state = 'stopped'
        code = forgot ? R.PAUSE_SAVE_FAILED : R.FORGET_FAILED
        pausedPref = false
        clearValues()
        bump()
        return { ok: false, code }
      }
      if (!isCurrent(op)) return staleResult()
      casRevision = saved !== null && typeof saved === 'object' && typeof saved.revision === 'string' ? saved.revision : casRevision
      clearFailure()
      return { ok: true, code: R.OK }
    } finally {
      endOp(op)
    }
  }

  async function resume() {
    if (disposed) return { ok: false, code: R.DISABLED }
    await settleBoot()
    if (deleteFlight !== null || deleteTransitions !== 0) return { ok: false, code: R.BUSY }
    if (state !== 'paused') return { ok: false, code: R.NOT_READY }
    invalidateOps()
    const op = beginOp('resume')
    try {
      const enabledAtStart = isCurrent(op)
      if (!(await enabledGate(op))) return enabledAtStart ? { ok: false, code: R.DISABLED } : staleResult()
      if (!isCurrent(op)) return staleResult()
      let loaded
      try { loaded = await vault.load({ signal: op.signal }) } catch { loaded = null; noteFailure('store', '') }
      if (!isCurrent(op)) return staleResult()
      const record = loaded === null || typeof loaded !== 'object' ? null : validateRecord(loaded.record)
      if (record === null) {
        if (!isCurrent(op)) return staleResult()
        noteFailure('store', '')
        state = 'unreadable'
        code = R.RECORD_UNREADABLE
        bump()
        return { ok: false, code: R.RECORD_UNREADABLE }
      }
      const revisionAtStart = typeof loaded.revision === 'string' ? loaded.revision : casRevision
      let saved
      try {
        saved = await vault.save(makeRecord(record.account, { paused: false }), {
          expectedRevision: revisionAtStart,
          signal: op.signal,
        })
      } catch {
        if (!isCurrent(op)) return staleResult()
        noteFailure('store', '')
        state = 'paused'
        code = R.SAVE_FAILED
        bump()
        return { ok: false, code: R.SAVE_FAILED }
      }
      if (!isCurrent(op)) return staleResult()
      casRevision = saved !== null && typeof saved === 'object' && typeof saved.revision === 'string' ? saved.revision : casRevision
      clearFailure()
      pausedPref = false
      // 恢复刷新：先 fresh restore 核 ID 再读；继承同一 op，不为父操作另开代次
      return await restore(record.account, { automatic: true, op })
    } finally {
      endOp(op)
    }
  }

  /**
   * 本人取消首扫：**纯本地**清候选/QR/协议，不写存储（不写 tombstone、不 pretend 0 写承诺之外的语义）。
   */
  function cancelAuth(id, gen) {
    if (disposed) return { ok: false, code: R.DISABLED }
    if (state !== 'authorizing' && state !== 'awaiting_confirmation') return { ok: false, code: R.NOT_READY }
    if (id !== undefined && id !== null && !matches(id, gen)) return { ok: false, code: R.STALE_ID }
    // 先失效在途确认/读，再清候选：迟到的 confirm/save 不得作用到下一次候选
    invalidateOps()
    dropProtocol()
    disarmPending()
    clearValues()
    authId = null
    expiresAt = null
    state = 'empty'
    code = R.OK
    bump()
    return { ok: true, code: R.OK }
  }

  async function forget() {
    if (disposed) return { ok: false, code: R.DISABLED }
    if (deleteFlight !== null) return { ok: false, code: R.BUSY }
    // **立即**失效在途（不先等 boot 网络结束）：旧 save/load/read 全部 stale+abort
    invalidateOps()
    const op = beginOp('forget')
    const flight = (async () => {
      try {
        generation += 1
        raiseDisplayGen()
        dropProtocol()
        disarmTick()
        disarmPending()
        clearValues()
        authId = null
        expiresAt = null
        pausedPref = false
        state = 'empty'
        code = R.OK
        clearFailure()
        bump()
        // tombstone 写入必然覆盖旧密文；已进入 provider 的原子提交只能被它覆盖，不夸物理取消
        const ok = await safeForget(op)
        if (!isCurrent(op)) return staleResult()
        if (!ok) {
          // 如实报：会话已停，但本地清除失败/未拿到 revision
          state = 'stopped'
          code = R.FORGET_FAILED
          bump()
          return { ok: false, code: R.FORGET_FAILED }
        }
        return { ok: true, code: R.OK }
      } finally {
        endOp(op)
        if (deleteFlight === flight) deleteFlight = null
      }
    })()
    deleteFlight = flight
    return flight
  }


  async function retry() {
    if (disposed) return { ok: false, code: R.DISABLED }
    handoffSnapshot = null
    await settleBoot()
    if (deleteFlight !== null || deleteTransitions !== 0) return { ok: false, code: R.BUSY }
    if (state !== 'failed') return { ok: false, code: R.NOT_READY }
    invalidateOps()
    const op = beginOp('retry')
    try {
      const enabledAtStart = isCurrent(op)
      if (!(await enabledGate(op))) return enabledAtStart ? { ok: false, code: R.DISABLED } : staleResult()
      if (!isCurrent(op)) return staleResult()
      let loaded
      try { loaded = await vault.load({ signal: op.signal }) } catch { loaded = null; noteFailure('store', '') }
      if (!isCurrent(op)) return staleResult()
      const record = loaded === null || typeof loaded !== 'object' ? null : validateRecord(loaded.record)
      if (record === null) return isCurrent(op) ? (noteFailure('store', ''), { ok: false, code: R.RECORD_UNREADABLE }) : staleResult()
      casRevision = typeof loaded.revision === 'string' ? loaded.revision : casRevision
      pausedPref = record.preferences.paused === true
      return await restore(record.account, { automatic: false, op })
    } finally {
      endOp(op)
    }
  }

  /** 运行时开关变化（Host 在配置变化/禁用时调用）：中止在途、清旧值、0 请求。 */
  function disable() {
    // 已是 disabled 且没有在途/协议/租约/定时器：幂等返回，watcher 每秒调用也不无意义 bump
    if (state === 'disabled' && protocol === null && lease === null && balanceFlight === null &&
      activeOps.size === 0 && authId === null && pendingTimer === null && tickTimer === null) return
    invalidateOps()
    dropProtocol()
    disarmTick()
    disarmPending()
    clearValues()
    authId = null
    expiresAt = null
    state = 'disabled'
    code = R.DISABLED
    clearFailure()
    handoffSnapshot = null
    bump()
  }

  function dispose() {
    if (disposed) return { ok: true }
    disposed = true
    // 先失效并 abort 所有在途（含 vault load/save 的 signal），再拆协议/清值
    invalidateOps()
    dropProtocol()
    disarmTick()
    disarmPending()
    clearValues()
    state = 'stopped'
    bump()
    // **不** forget：退出只清内存，记住登录留给下次启动
    try { vault?.dispose?.() } catch { /* ok */ }
    return { ok: true }
  }

  return Object.freeze({
    namespace: REMEMBERED_NAMESPACE,
    bootEpoch,
    limits: REMEMBERED_LIMITS,
    codes: REMEMBERED_CODES,
    boot,
    startAuth,
    beginAuth,
    takeQr,
    approve: (id, gen, aid) => decideApproval(id, gen, aid, true),
    deny: (id, gen, aid) => decideApproval(id, gen, aid, false),
    confirmAccount: confirmAccountAction,
    cancelAuth,
    pause,
    resume,
    forget,
    retry,
    refresh,
    disable,
    status: () => { expireIfDue(); return snapshot() },
    displaySnapshot,
    dispose,
    /** Host/测试内部：纯观察，不含任何凭据。 */
    peek: () => snapshot()
  })
}
