/**
 * [额度自动感知] Host 内存中的额度观察快照与三阶段状态机。
 *
 * 设计依据：`docs/handoff-quota-policy-build-v0.9.0.md`。
 *
 * 核心契约：
 *   - **同一份观察**供 GUI 与提示词共用，不各数一套失败次数；
 *   - 失败分 T/P/A/I/C/S，只有 T 计数、第 5 次才移除旧值；
 *   - [A03] 采集**开始**时登记采样票据（sampleId + 提交序号），完成时校验票据是否仍适用，
 *     过期票据一律丢弃 —— 迟到旧响应绝不能覆盖更新的结果；
 *   - [A02] 身份/配置代次变化即时作废该条观察；
 *   - [A09] 失效状态（failed/expired）必须**保持**，不因后续 T 变成「暂无数据」。
 *
 * 本模块是纯函数 + 受控状态容器：无网络、无磁盘、无定时器。
 */

/** 暂时失败（T）在第几次之后不再沿用旧值。 */
export const TEMPORARY_FAIL_LIMIT = 5

/** 阶段常量。 */
export const STAGE_NORMAL = 'normal'
export const STAGE_WARNING = 'warning'
export const STAGE_CLOSING = 'closing'

/** 内部有效状态：统一供 GUI 与模型消费（[A09]）。 */
export const STATUS_PENDING = 'pending'
export const STATUS_OK = 'ok'
export const STATUS_CACHED = 'cached'
export const STATUS_FAILED = 'failed'
export const STATUS_EXPIRED = 'expired'

/**
 * 失败分类（交接文档第 4 节）。
 *
 * - `T` 暂时失败：超时 / 网络 / 408 / 425 / 429 / 5xx / 偶发坏响应 → 计数，前 4 次可沿用缓存
 * - `P` 明确配置/权限/能力/安全问题 → 立即失效，不等待 5 次
 * - `A` 明确查询身份过期 → 立即失效
 * - `I` 身份/配置切换 → 作废旧值与计数
 * - `C` 主动取消/作废 → 丢弃，不计失败
 */
export const FAIL_TEMPORARY = 'T'
export const FAIL_PERMANENT = 'P'
export const FAIL_EXPIRED = 'A'
export const FAIL_REPLACED = 'I'
export const FAIL_CANCELLED = 'C'

/**
 * 把 provider 返回的错误码归入失败类别。
 *
 * [A08] 只按**结构化错误码/线索**判断，不扫描自由文案里的 "401/token" 字样
 * （401/403 本身不等于身份过期）。
 *
 * 分类原则：
 *   - provider 已经明确判定为语义错误（非暂时）的，必须是 P/A，不能降级成 T；
 *   - provider 明确标了 `transient:true` 的，即使是结构/解析错误也先按 T 宽限；
 *   - 完全无法识别的，**先按 T**（宽限 4 次），不当成立即失效。
 *
 * @param {string} errorCode provider 给出的固定错误码
 * @param {object} [hint] 结构化线索：`{ transient, httpStatus, credentialState, authKind }`
 * @returns {'T'|'P'|'A'|'C'|null} null 表示不是失败
 */
export function classifyFailure(errorCode, hint) {
  const opts = hint !== null && hint !== undefined && typeof hint === 'object' ? hint : {}
  if (errorCode === undefined || errorCode === null || errorCode === '') return null
  const code = String(errorCode)
  const transient = opts.transient === true

  // [A08] provider 给出的**结构化语义**优先于错误码本身的字面含义。
  // WorkBuddy 把 session_dead / hard_credit 都映射成 error:'api'，
  // 只看 `api` 会被当成一般业务异常（T），从而继续用旧积分驱动收尾。
  const authKind = typeof opts.authKind === 'string' ? opts.authKind : ''
  if (authKind === 'session-dead') return FAIL_EXPIRED
  if (authKind === 'hard-credit') return FAIL_PERMANENT
  const credentialState = typeof opts.credentialState === 'string' ? opts.credentialState : ''
  if (credentialState === 'expired' || credentialState === 'reauth-required') return FAIL_EXPIRED
  if (credentialState === 'missing') return FAIL_PERMANENT

  // 明确查询身份过期：只有 provider 明确说出「需要重新登录/会话失效」才算。
  // [A08] `signed-out`（从未登录）与 `reauth-required`（明确需重登）要区分。
  if (code === 'reauth-required' || code === 'expired' || code === 'auth-expired') return FAIL_EXPIRED
  if (code === 'signed-out') return transient ? FAIL_TEMPORARY : FAIL_PERMANENT

  // 明确配置/权限/能力/安全拒绝：立即失效。
  if (code === 'no-key' || code === 'no-credential') return FAIL_PERMANENT
  if (code === 'config' || code === 'credential-unconfirmed' || code === 'unbound') return FAIL_PERMANENT
  if (code === 'disabled' || code === 'not-found' || code === 'retired-channel') return FAIL_PERMANENT
  if (code === 'auth') return FAIL_PERMANENT

  // provider 已判定的硬性语义错误。
  if (code === 'session-dead') return FAIL_EXPIRED
  if (code === 'hard-credit' || code === 'quota-exhausted-semantic') return FAIL_PERMANENT

  // 主动取消：丢弃，不计数。
  if (code === 'cancelled' || code === 'aborted') return FAIL_CANCELLED

  // [R2-06] 明确的**本地**配置/能力问题：立即 P，不必等 5 次。
  // 这些与「上游返回了坏数据」不同，重试不会自愈。
  if (code === 'endpoint' || code === 'not-installed' || code === 'incompatible') return FAIL_PERMANENT
  if (code === 'not-supported' || code === 'unsupported') return FAIL_PERMANENT

  // [A08] transient 线索优先：provider 说这是暂时问题，就按 T 宽限，
  // 即使错误码看起来像结构/解析问题。
  if (transient) return FAIL_TEMPORARY

  // [R2-06] **坏响应默认 T**：`parse` / `structure` 多数是上游改版、半截响应、
  // 网关错误页，重试可能恢复，所以先宽限 4 次。
  // 只有 provider 明确标了 `permanent:true`（本地路径语法等不可自愈问题）才立即 P。
  if (code === 'parse' || code === 'structure') {
    return opts.permanent === true ? FAIL_PERMANENT : FAIL_TEMPORARY
  }

  // 网络/超时/限流/服务端：T。
  if (code === 'network' || code === 'timeout' || code === 'exec' || code === 'curl') return FAIL_TEMPORARY
  if (code === 'rate-limit' || code === 'server' || code === 'api' || code === 'http' || code === 'rpc') return FAIL_TEMPORARY

  // 完全无法识别：**先按 T**（宽限），不擅自判成永久失效。
  return FAIL_TEMPORARY
}

/** 观察的稳定键：渠道 + 身份。 */
function observationKey(id, identity) {
  return String(id) + '\u0000' + (typeof identity === 'string' ? identity : '')
}

/**
 * 创建一个观察容器。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 时钟注入（测试用）
 */
export function createQuotaObserver(options) {
  const opts = options !== null && options !== undefined ? options : {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  /** key → 观察记录 */
  const records = new Map()
  /** [R4-01] 渠道 id → 激活 epoch（单调递增，永不回退）。 */
  const epochs = new Map()
  /** 全局提交序号：每次开始时 +1，用于拒绝迟到结果。 */
  let ticketSeq = 0

  /**
   * [A03] 登记一次采集的开始票据。
   *
   * @param {object} input
   * @param {string} input.id 渠道 id
   * @param {string} [input.identity] 身份（配置代次 + 凭据指纹等，Host 内部）
   * @param {number} [input.at] 采集开始时间
   * @returns {{id:string, identity:string, seq:number, startedAt:number}|null}
   */
  function begin(input) {
    if (input === null || input === undefined || typeof input.id !== 'string') return null
    ticketSeq += 1
    /**
     * [R5-01 §3.3] 首次 `begin` 就把该 id 登记进 `epochs`（值为 0）。
     *
     * 否则 `clear()` 遍历不到它，`clear` 之后旧票据拿着 epoch 0 仍能提交成功。
     * 这里只登记、**不递增**：同身份并发请求共享同一个 epoch，不会互相取消。
     */
    if (!epochs.has(input.id)) epochs.set(input.id, 0)
    return {
      id: input.id,
      // [R3-01] 身份无法证明时保留 `null`，**不**退回空字符串：
      // 空字符串会让所有账户共享同一个缓存槽位。
      identity: typeof input.identity === 'string' ? input.identity : null,
      /**
       * [R4-01] 激活 epoch：票据捕获**签发当时**的渠道激活代次。
       *
       * 为什么需要它：身份是按配置值算的哈希，A→B→A 之后哈希又变回 A，
       * 于是旧 A 的在途票据重新"等于当前身份"并复活。
       * **身份哈希相等 ≠ 同一次有效激活**。
       *
       * epoch 单调递增、**永不回退**：配置身份变化、停用、删除都会推进它，
       * 因此旧票据的 epoch 一旦落后就永远不能提交。
       */
      epoch: epochOf(input.id),
      // 开始序号：完成时必须晚于该 key 已提交的序号，否则说明被更新的采集超越。
      seq: ticketSeq,
      startedAt: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : now(),
    }
  }

  /** [R4-01] 读取某渠道当前激活 epoch（未激活过为 0）。 */
  function epochOf(id) {
    const value = epochs.get(String(id))
    return typeof value === 'number' ? value : 0
  }

  /**
   * [R4-01][R5-01] 推进某渠道的激活 epoch（作废所有在途票据**与该渠道的数据**）。
   *
   * 调用时机：身份变化、停用、删除、启用、监控总开关切换。
   *
   * ⚠️ 光推进 epoch 不够：记录是按 `id + identity` 分别存放的，A→B→A 之后
   * A 槽位里的旧记录仍然存在。若不在这里一并清除，回切 A 后的**第一次失败**
   * 会读到那条旧记录、按「有基线」分支走缓存，把上一个激活的余额又拿回来。
   *
   * 因此这里同时做两件事：推进 epoch（拒绝旧票据）+ 清掉该渠道全部数据（拒绝旧值）。
   */
  function bumpEpoch(id) {
    if (typeof id !== 'string') return 0
    const next = epochOf(id) + 1
    epochs.set(id, next)
    for (const key of Array.from(records.keys())) {
      const record = records.get(key)
      if (record !== undefined && record.id === id) records.delete(key)
    }
    return next
  }

  /**
   * 提交一次采集结局。
   *
   * @param {object} ticket `begin()` 返回的票据
   * @param {object} outcome
   * @param {object} [outcome.channel] 成功时的脱敏投影
   * @param {string} [outcome.errorCode] 失败时的固定错误码
   * @param {object} [outcome.hint] 失败分类线索
   * @param {number} [outcome.sampledAt] 真实采样时间
   * @returns {object|null} 更新后的记录；票据过期或无效时返回 null（**不提交**）
   */
  function commit(ticket, outcome) {
    if (ticket === null || ticket === undefined || typeof ticket.id !== 'string') return null
    // [R3-01] 身份为 null（无法证明）的票据**永不提交**。
    if (typeof ticket.identity !== 'string') return null
    /**
     * [R4-01] epoch 校验：票据签发的激活代次必须**仍是**当前代次。
     *
     * 这一步专门堵 A→B→A 与 停用→启用 两条回切路径：
     * 身份哈希会随配置值回到旧值，但 epoch 只增不减，旧票据永远落在后面。
     */
    if (typeof ticket.epoch === 'number' && ticket.epoch !== epochOf(ticket.id)) return null
    const key = observationKey(ticket.id, ticket.identity)
    const existing = records.get(key)
    // [A03] 只有比已提交结果更新的票据才能写入；迟到旧响应一律丢弃。
    if (existing !== undefined && typeof existing.commitSeq === 'number' && ticket.seq <= existing.commitSeq) {
      return null
    }
    const out = outcome !== null && outcome !== undefined ? outcome : {}
    const isSuccess = out.errorCode === undefined || out.errorCode === null || out.errorCode === ''
    const sampledAt = typeof out.sampledAt === 'number' && Number.isFinite(out.sampledAt)
      ? out.sampledAt
      : now()

    if (isSuccess) {
      const record = {
        id: ticket.id,
        identity: ticket.identity,
        channel: out.channel === undefined ? null : out.channel,
        sampledAt,
        status: STATUS_OK,
        failKind: null,
        failCount: 0,
        commitSeq: ticket.seq,
        sealed: false,
      }
      records.set(key, record)
      return record
    }

    const kind = classifyFailure(out.errorCode, out.hint)
    if (kind === null) return existing !== undefined ? existing : null
    /**
     * [R4-01 防御项] C（主动取消）必须**真正无操作**。
     *
     * 之前这里返回旧的 record，发布器拿到后把它当「一次新的成功」重新处理：
     * `wire.via` 在取消 wire 里通常缺失，于是 `meta.source` 被覆盖成 undefined，
     * 原本有效的 API 来源 1CNY 反而被清空。
     *
     * 现在返回 `null`（= 不提交），发布器据此**完全不触碰**任何投影/元信息。
     */
    if (kind === FAIL_CANCELLED) return null

    // 身份/配置切换：作废旧值与计数。
    if (kind === FAIL_REPLACED) {
      records.delete(key)
      return null
    }

    // P/A：立即失效；[A09] 该状态必须**保持**，不被后续 T 降级成「暂无数据」。
    if (kind === FAIL_PERMANENT || kind === FAIL_EXPIRED) {
      const record = {
        id: ticket.id,
        identity: ticket.identity,
        channel: null,
        sampledAt: null,
        status: kind === FAIL_EXPIRED ? STATUS_EXPIRED : STATUS_FAILED,
        failKind: kind,
        failCount: TEMPORARY_FAIL_LIMIT,
        commitSeq: ticket.seq,
        sealed: true,
      }
      records.set(key, record)
      return record
    }

    // T：连续计数；已达 P/A 的封存态不再回退（[A09] 保持固定状态）。
    const previous = existing
    const sealed = previous !== undefined && previous.sealed === true
    const previousCount = sealed ? TEMPORARY_FAIL_LIMIT
      : (previous !== undefined && typeof previous.failCount === 'number' ? previous.failCount : 0)
    const failCount = previousCount + 1
    const hasBaseline = previous !== undefined
      && previous.channel !== null && previous.channel !== undefined
    const usable = failCount < TEMPORARY_FAIL_LIMIT && hasBaseline
    /**
     * [R4-03] 三条分支必须分开：
     *
     *   1. `sealed`（已 P/A）—— 保持原来的确定状态，不回退；
     *   2. `usable`（有基线且未满 5 次）—— cached，沿用旧值；
     *   3. **无基线且未满 5 次** —— `pending`，既不编造数值，也**不提前报失败**；
     *   4. 满 5 次 —— failed，固定失败状态。
     *
     * 之前把 3 也归成 failed，于是刚启动/刚换身份时偶发一次暂时错误就告诉模型
     * 「获取额度失败」，违背「前 4 次宽限」。计数正确不等于提示时机正确。
     */
    let status
    if (sealed) status = previous.status
    else if (usable) status = STATUS_CACHED
    else if (!hasBaseline && failCount < TEMPORARY_FAIL_LIMIT) status = STATUS_PENDING
    else status = STATUS_FAILED
    const record = {
      id: ticket.id,
      identity: ticket.identity,
      // 前 4 次沿用同一身份的旧值；第 5 次起移除。
      channel: usable ? previous.channel : null,
      // 沿用缓存时**不刷新**原采样时间。
      sampledAt: usable ? previous.sampledAt : null,
      status,
      failKind: FAIL_TEMPORARY,
      failCount: Math.min(failCount, TEMPORARY_FAIL_LIMIT + 1000),
      commitSeq: ticket.seq,
      sealed,
    }
    records.set(key, record)
    return record
  }

  /** 读取某渠道+身份的当前记录。 */
  function read(id, identity) {
    return records.get(observationKey(id, identity)) || null
  }

  /** 按渠道 id 找到最新身份的记录（视图层通常只知道渠道 id）。 */
  function readAny(id) {
    let found = null
    for (const record of records.values()) {
      if (record.id !== id) continue
      if (found === null || record.commitSeq > found.commitSeq) found = record
    }
    return found
  }

  /**
   * [A02][R4-01] 作废某渠道的全部身份观察。
   *
   * **同时推进 epoch**：仅删除记录不够 —— 旧在途票据在自己的槽位里没有更大的
   * commitSeq 拦截，配置回切后仍会重新生效。
   */
  function invalidateChannel(id) {
    let removed = 0
    for (const key of Array.from(records.keys())) {
      const record = records.get(key)
      if (record !== undefined && record.id === id) { records.delete(key); removed += 1 }
    }
    bumpEpoch(id)
    return removed
  }

  /** 作废全部观察（卸载/全局禁用）。 */
  function clear() {
    records.clear()
    // 全部渠道代次一起推进：任何在途结果都不再有效。
    for (const id of Array.from(epochs.keys())) bumpEpoch(id)
  }

  /** 当前记录数量（测试用）。 */
  function size() {
    return records.size
  }

  return { begin, commit, read, readAny, invalidateChannel, clear, size, bumpEpoch, epochOf }
}

/**
 * 判定某一指标处于哪个阶段。
 *
 * 规则：
 *   - 只有**收尾阈值低于预警阈值**才是合法配置；
 *   - 沿用「低于」的 `<` 语义：等于边界不触发；
 *   - 收尾优先于预警；
 *   - 非法配置（收尾 ≥ 预警）该指标整体作废，不猜用户意图。
 *
 * @param {number} value 当前值（剩余比例或余额）
 * @param {number} warning 预警阈值（0 = 未配置）
 * @param {number} closing 收尾阈值（0 = 未配置）
 * @returns {'normal'|'warning'|'closing'}
 */
export function stageOf(value, warning, closing) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return STAGE_NORMAL
  const hasWarning = typeof warning === 'number' && Number.isFinite(warning) && warning > 0
  const hasClosing = typeof closing === 'number' && Number.isFinite(closing) && closing > 0
  if (!hasWarning && !hasClosing) return STAGE_NORMAL
  // 非法配置：整体作废，不退化成一档。
  if (hasWarning && hasClosing && closing >= warning) return STAGE_NORMAL
  if (hasClosing && value < closing) return STAGE_CLOSING
  if (hasWarning && value < warning) return STAGE_WARNING
  return STAGE_NORMAL
}

/** 阶段严重度：用于多窗口/多渠道取最严重。 */
export function stageRank(stage) {
  if (stage === STAGE_CLOSING) return 2
  if (stage === STAGE_WARNING) return 1
  return 0
}

/** 取两个阶段中更严重的那个。 */
export function worstStage(a, b) {
  return stageRank(a) >= stageRank(b) ? a : b
}

/**
 * [R8-01] 凭据变化时，**只**允许提升本次采样自己那张票。
 *
 * 规则很简单但很关键：采样回调必须携带 ticket，且它必须仍是该渠道当前
 * 待提交的那一张。工具 identify / 成功缓存命中没有取数票 → 不提升任何东西，
 * 于是旧的挂起请求仍持旧 epoch，返回时被 commit 拒绝。
 *
 * 抽成纯函数是为了能用真实观察器直接回归（而不是靠正则断言源码形状）。
 *
 * @returns {boolean} 是否真的提升了
 */
export function promoteOwnTicket(pending, ticket, nextEpoch) {
  if (ticket === null || ticket === undefined || typeof ticket.epoch !== 'number') return false
  if (pending === null || pending === undefined || pending !== ticket) return false
  if (typeof nextEpoch !== 'number' || !Number.isFinite(nextEpoch)) return false
  ticket.epoch = nextEpoch
  return true
}
