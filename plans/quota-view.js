/**
 * [额度自动感知] 动态提示词视图：把「本次路由观察 + 该渠道的额度观察 + 阈值配置」
 * 合成一份**不可变、白名单**的快照视图，供 `systemPrompt.context` 的同步回调读取。
 *
 * 关键约束（交接文档 §7）：
 *   - 回调**同步**、零网络、零磁盘、不计失败、不改采样时间；
 *   - 每次请求重新求值，所以同 step 重试也能换档（这是选择 context 而非 section 的原因）；
 *   - normal 不输出任何行为规则；warning/closing 才附固定模板。
 */

import {
  STAGE_NORMAL,
} from './quota-observer.js'
import { resolveRoute } from './quota-prompt.js'
import { parseFocusChannels, parseRouteBindings, normalizePercentThreshold, normalizeBalanceThreshold, normalizePolicyCurrency } from './usage-policy.js'
import {
  parseChannelThresholds,
  resolveChannelThresholds,
  resolvedActive,
  evaluateChannelMetrics,
  legacyStageForChannel,
  simplestMetric,
} from './quota-thresholds.js'

/**
 * 从配置解析出两档阈值。
 *
 * 两档都配置时收尾必须低于预警；否则**视为未配置**（不猜、不擅自修正）。
 */
export function thresholdsOf(cfg) {
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return null
  const warnPercent = normalizePercentThreshold(cfg.quotaWarningPercentThreshold)
  const closePercent = normalizePercentThreshold(cfg.quotaClosingPercentThreshold)
  const warnBalance = normalizeBalanceThreshold(cfg.quotaWarningBalanceThreshold)
  const closeBalance = normalizeBalanceThreshold(cfg.quotaClosingBalanceThreshold)
  const warnCredits = normalizeBalanceThreshold(cfg.quotaWarningCreditsThreshold)
  const closeCredits = normalizeBalanceThreshold(cfg.quotaClosingCreditsThreshold)
  const currency = normalizePolicyCurrency(cfg.quotaBalanceCurrency)

  // 两档都配置且收尾 >= 预警 → 该指标作废（不猜用户想表达什么）。
  const percentOk = warnPercent !== null && closePercent !== null ? closePercent < warnPercent : true
  const balanceOk = warnBalance !== null && closeBalance !== null ? closeBalance < warnBalance : true
  const creditsOk = warnCredits !== null && closeCredits !== null ? closeCredits < warnCredits : true

  return {
    warningPercent: percentOk ? warnPercent : null,
    closingPercent: percentOk ? closePercent : null,
    warningBalance: balanceOk ? warnBalance : null,
    closingBalance: balanceOk ? closeBalance : null,
    warningCredits: creditsOk ? warnCredits : null,
    closingCredits: creditsOk ? closeCredits : null,
    balanceCurrency: currency,
  }
}

/** 是否至少配置了一个有效阈值。 */
export function hasAnyThreshold(thresholds) {
  if (thresholds === null || thresholds === undefined) return false
  return thresholds.warningPercent !== null || thresholds.closingPercent !== null
    || thresholds.warningBalance !== null || thresholds.closingBalance !== null
    || thresholds.warningCredits !== null || thresholds.closingCredits !== null
}

/**
 * 解析某一渠道在**旧全局阈值**下的阶段。
 *
 * [2026-10-23] 旧签名与旧语义**保持不变**（订阅额度只看 `pickSmallestWindow()` 选出的
 * 那一个窗口；余额看同币种金额；积分绝不与金额混比）。新的「按渠道 + 按窗口」判定走
 * `plans/quota-thresholds.js` 的 `evaluateChannelMetrics()`，只在某渠道有自己的条目时启用。
 */
export function stageForChannel(channel, thresholds, pickSmallestWindow) {
  return legacyStageForChannel(channel, thresholds, pickSmallestWindow)
}

/**
 * 组装一份模型可见视图。
 *
 * @param {object} input
 * @param {object} input.cfg 当前配置（已 unpack）
 * @param {object|null} input.observation 本次路由观察 `{provider, model}`
 * @param {(id:string)=>object|null} input.readChannel 读取某渠道的脱敏投影
 * @param {(id:string)=>object|null} input.readObservation 读取某渠道的观察元信息
 * @param {(windows:any)=>object|null} input.pickSmallestWindow
 * @param {(id:string)=>string|null} [input.identityOf] 读取某渠道当前应有的身份指纹
 * @returns {object} 视图
 */
export function buildQuotaView(input) {
  const opts = input !== null && input !== undefined ? input : {}
  const cfg = opts.cfg !== null && opts.cfg !== undefined && typeof opts.cfg === 'object' ? opts.cfg : {}
  const disabled = { enabled: false, stage: STAGE_NORMAL, channelId: null, source: null }

  // 总开关关闭：什么都不投放（GUI 与主动工具完全不受影响）。
  if (cfg.quotaPolicyEnabled !== true) return disabled

  const thresholds = thresholdsOf(cfg)

  // 关注渠道是**白名单**：没列进去的渠道不参与（空列表 = 不启用）。
  const focus = parseFocusChannels(cfg.quotaFocusChannels)
  if (focus.length === 0) return disabled

  // [A02] 全局开关：`enabled === false` 时不得输出任何额度（GUI 与提示词一致）。
  if (cfg.enabled === false) return disabled

  const observation = opts.observation !== null && opts.observation !== undefined ? opts.observation : null
  if (observation === null || typeof observation !== 'object') {
    // 未观察到本次路由：不猜、不拿无关渠道的数据。
    return { enabled: true, stage: STAGE_NORMAL, channelId: null, source: null, unobserved: true }
  }

  // [A07] Reserve 等独立额度池：没有该池的证明时**不投放**，
  // 绝不拿普通主桶的百分比替它收尾。
  if (typeof opts.reservePoolReady === 'function' && opts.reservePoolReady(observation) !== true) {
    if (typeof opts.usesReservePool === 'function' && opts.usesReservePool(observation.model)) {
      return {
        enabled: true, stage: STAGE_NORMAL, channelId: null, source: null,
        poolUnproven: observation.model,
      }
    }
  }

  // 路由 → 渠道：[A11] 绑定解析三态，歧义必须 fail closed。
  const resolution = resolveBinding(cfg, observation)
  if (resolution.state === 'ambiguous') {
    // 精确命中但冲突：**不**退回宽松，也**不**拿内置表抹掉错误。
    return { enabled: true, stage: STAGE_NORMAL, channelId: null, source: null, ambiguous: true }
  }
  const route = resolution.state === 'bound' ? resolution.route : resolveRoute(observation.provider)
  if (route === null) {
    return { enabled: true, stage: STAGE_NORMAL, channelId: null, source: null, unmapped: observation.provider }
  }
  if (focus.indexOf(route.channelId) === -1) {
    // 当前路由对应的渠道不在白名单里：不投放（用户没授权这个渠道）。
    return { enabled: true, stage: STAGE_NORMAL, channelId: null, source: null, notAllowed: route.channelId }
  }

  // [A02] 单渠道开关：该渠道被停用时立刻撤掉（不保留旧值）。
  const enabledField = PLAN_ENABLED_FIELDS[route.channelId]
  if (enabledField !== undefined && cfg[enabledField] === false) {
    return { enabled: true, stage: STAGE_NORMAL, channelId: null, source: null, channelDisabled: route.channelId }
  }

  const readChannel = typeof opts.readChannel === 'function' ? opts.readChannel : () => null
  const readObservation = typeof opts.readObservation === 'function' ? opts.readObservation : () => null
  const meta = readObservation(route.channelId) !== null && readObservation(route.channelId) !== undefined
    ? readObservation(route.channelId)
    : {}

  // [A02] 身份校验：观察所属身份必须与当前应有的身份一致；
  // 不一致说明 Key/账号/配置已变，旧额度**立即失效**（不等待采集）。
  const identityOf = typeof opts.identityOf === 'function' ? opts.identityOf : null
  if (identityOf !== null && meta.identity !== undefined) {
    const expected = identityOf(route.channelId)
    if (expected !== meta.identity) {
      return { enabled: true, stage: STAGE_NORMAL, channelId: null, source: null, staleIdentity: route.channelId }
    }
  }

  // [R2-04] 来源校验：路由声明了 source（如 DeepSeek account/api）时，
  // 有可用数值就必须能证明来源一致。
  //
  // **缺证明要拒绝，不能跳过**：之前写成 `meta.source !== undefined` 才比较，
  // 于是一次没有 via 的暂时性错误（把 source 抹成 undefined）就绕过了整条限制，
  // 让另一个来源的余额被当作缓存接受并驱动收尾。
  if (route.source !== null) {
    const hasValue = meta.status === 'ok' || meta.status === 'cached'
    if (hasValue && meta.source !== route.source) {
      return {
        enabled: true, stage: STAGE_NORMAL, channelId: null, source: null,
        sourceMismatch: route.channelId, sourceUnproven: meta.source === undefined,
      }
    }
  }

  // [A09] 统一有效状态：失败/过期必须给固定状态，**不能**降级成「暂无数据」。
  if (meta.status === 'failed' || meta.status === 'expired') {
    return {
      enabled: true,
      stage: STAGE_NORMAL,
      channelId: route.channelId,
      source: route.source,
      status: meta.status,
      channel: null,
      fromCache: false,
      fetchedAt: null,
    }
  }

  const channel = readChannel(route.channelId)
  if (channel === null || channel === undefined) {
    // 尚无数据（例如刚启动）：给「暂无额度数据」，不编造数值、不谎报失败。
    return {
      enabled: true,
      stage: STAGE_NORMAL,
      channelId: route.channelId,
      source: route.source,
      channel: null,
      fromCache: false,
      fetchedAt: null,
      noData: true,
    }
  }

  /**
   * [2026-10-23] 阈值解析：按渠道与是否出现分三种情况。
   *
   * - 该渠道**没有**自己的条目（含整份字段未出现）→ 沿用旧全局阈值（legacy，最短窗口）；
   * - 该渠道**有**条目 → 各窗口独立判定 + 整体取最严重；
   * - 配置整体坏（null / 坏 JSON / 非对象）或该渠道条目坏类型 → fail closed（零规则）。
   */
  const parsedThresholds = parseChannelThresholds(cfg.quotaChannelThresholds)
  const resolved = resolveChannelThresholds(parsedThresholds, route.channelId, thresholds)

  // 没有任何有效阈值：只给额度事实，阶段恒为 normal（零规则）。
  if (resolvedActive(resolved) !== true) {
    return {
      enabled: true,
      stage: STAGE_NORMAL,
      channelId: route.channelId,
      source: route.source,
      channel,
      fromCache: meta.status === 'cached',
      fetchedAt: typeof meta.sampledAt === 'number' ? meta.sampledAt : null,
      metric: null,
      metrics: [],
      legacyPolicy: false,
      policyBlocked: resolved.source === 'blocked'
        ? (typeof resolved.reason === 'string' && resolved.reason.length > 0 ? resolved.reason : 'invalid-config')
        : null,
    }
  }

  const evaluated = evaluateChannelMetrics(channel, resolved, opts.pickSmallestWindow)
  return {
    enabled: true,
    stage: evaluated.stage,
    channelId: route.channelId,
    source: route.source,
    channel,
    fromCache: meta.status === 'cached',
    fetchedAt: typeof meta.sampledAt === 'number' ? meta.sampledAt : null,
    // 旧单值字段保留（= 最严重的一条），另给完整 `metrics` 用于解释触发窗口。
    metric: simplestMetric(evaluated.metrics),
    metrics: evaluated.metrics,
    legacyPolicy: resolved.legacy === true,
    policyBlocked: null,
  }
}

/** 渠道 id → 配置里的启用字段名（与 plans/index.js 的 fields.enabled 对应）。 */
const PLAN_ENABLED_FIELDS = Object.freeze({
  'opencode-go': 'opencodeGoEnabled',
  deepseek: 'deepseekEnabled',
  codex: 'codexEnabled',
  mimo: 'mimoEnabled',
  workbuddy: 'workbuddyEnabled',
  'workbuddy-ai': 'workbuddyAiEnabled',
})

/**
 * 显式绑定解析：[A11] 三态 —— not-found / bound / ambiguous。
 *
 * 规则：
 *   - 精确（provider + model）命中且**唯一** → bound；
 *   - 精确命中但指向多个不同目标 → **ambiguous（fail closed，不放宽）**；
 *   - 无精确命中，再看 provider 通用绑定（model 为空）：唯一 → bound，冲突 → ambiguous；
 *   - 都没有 → not-found（由调用方回退内置表），**但内置表只在没有任何绑定命中时使用**。
 */
function resolveBinding(cfg, observation) {
  const bindings = parseRouteBindings(cfg.quotaRouteBindings)
  if (bindings.length === 0) return { state: 'not-found' }
  const provider = String(observation.provider || '')
  const model = String(observation.model || '')
  const exact = bindings.filter((b) => b.provider === provider && b.model !== null && b.model === model)
  if (exact.length > 0) {
    const uniq = uniqueTarget(exact)
    return uniq === null ? { state: 'ambiguous' } : { state: 'bound', route: uniq }
  }
  const loose = bindings.filter((b) => b.provider === provider && b.model === null)
  if (loose.length > 0) {
    const uniq = uniqueTarget(loose)
    return uniq === null ? { state: 'ambiguous' } : { state: 'bound', route: uniq }
  }
  return { state: 'not-found' }
}

/** 一组绑定是否只指向唯一目标；冲突返回 null。 */
function uniqueTarget(list) {
  const targets = new Set(list.map((b) => b.channelId + '\u0000' + (b.source === null ? '' : b.source)))
  if (targets.size !== 1) return null
  const first = list[0]
  return { channelId: first.channelId, source: first.source }
}
