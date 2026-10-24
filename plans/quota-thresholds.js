/**
 * [额度策略 2026-10-23] 按渠道 / 按窗口的两档阈值：解析 + 判定（**纯函数，无 IO**）。
 *
 * 设计依据：`docs/quota-policy-ui-implementation-20261023.md`（含 §10 父 Agent 裁决修订）。
 *
 * 核心契约：
 *   1. **窗口身份稳定**：key 只有 `rolling-5h` / `weekly` / `monthly`，
 *      来源是 provider 归一化后的 wire 槽位名（见 `plans/usage-tool.js` 的 `WINDOWS`），
 *      **不是**数组顺序，也不是展示文案。未知 scope 一律忽略（不判定、不显示、不写配置）。
 *   2. **legacy 分支保持旧行为**：旧全局三组阈值（`thresholdsOf`）**只按 `pickSmallestWindow()`
 *      选出的那一个窗口**判定，与引入本模块之前逐字一致。只有某渠道有了自己的
 *      per-channel 条目后，才改为「各窗口独立判定 + 整体取最严重」。
 *   3. **字段解析的权威语义**（父裁决 R2，不允许"坏配置被当成没配"）：
 *      - 缺字段 / `undefined` / 空串（含仅空白） → `absent`：全部渠道走各自 legacy；
 *      - `null` / 非字符串 / 坏 JSON / 解析结果非普通对象 → **整体 fail closed**；
 *      - 合法 `{}` 或 root 缺该渠道键 → **该渠道仍走 legacy**（编辑 A 不得关闭 B 的旧策略）；
 *      - 该渠道自有 `{}` 或显式全 0 → **该渠道覆盖为零**，不借 global；
 *      - 该渠道键存在但值不是对象 → **该渠道 fail closed**，其它渠道不受影响；
 *      - 该渠道存在但缺某窗口键 → 该窗口 = 未配置（0），**不逐窗口退 global**。
 *   4. **安全**：只按 own property 读写；拒绝 `__proto__` / `constructor` / `prototype`；
 *      输入长度与条目数有上限，超限按 invalid 处理（不截断后继续用）；从不 eval 字符串。
 */

import { STAGE_NORMAL, stageOf, worstStage, stageRank } from './quota-observer.js'

/** 稳定窗口词表（= provider wire 槽位名；新增窗口必须同时扩这里与 `usage-tool.js`）。 */
export const WINDOW_KEYS = ['rolling-5h', 'weekly', 'monthly']

/** 窗口的中文展示标签（固定字面量，绝不来自上游文本）。 */
export const WINDOW_LABELS = {
  'rolling-5h': '5 小时窗口',
  weekly: '周窗口',
  monthly: '月窗口',
}

/** 阈值 JSON 的字节上限（超限按 invalid，不截断后继续用）。 */
export const MAX_THRESHOLD_JSON_LENGTH = 8192

/**
 * 单份阈值 JSON 里的渠道条目上限。
 *
 * ⚠️ 与 `MAX_FOCUS_CHANNELS`(8) **刻意分开**：关注上限管"参与判定的渠道"，
 * 这里管"能保存阈值的条目"。当前 5 个内置 + 最多 12 个自定义 = 17 个渠道，
 * 未关注的自定义卡片同样可以保留已配阈值，所以上限取 32（≥17 且有余量）。
 * 用 8 去限制历史配置条目会误拒合法第 9…17 张卡。
 */
export const MAX_THRESHOLD_CHANNELS = 32

/** 危险键（原型污染）：任何层级都拒绝作为 key。 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

/** 键是否可安全用作普通对象 key / 渠道 id。 */
export function isSafeKey(key) {
  if (typeof key !== 'string') return false
  if (key.length === 0 || key.length > 64) return false
  if (FORBIDDEN_KEYS.indexOf(key) !== -1) return false
  return /^[A-Za-z0-9:_-]+$/.test(key)
}

/** 是否为危险键（原型污染）。 */
export function isForbiddenKey(key) {
  return typeof key === 'string' && FORBIDDEN_KEYS.indexOf(key) !== -1
}

/**
 * 对象里（**任意层**）是否出现危险键。
 *
 * 只做**有界**遍历：深度 ≤ 6、节点数 ≤ 500，超出即停止（不递归无限结构、
 * 不评估任何字符串）。命中即整份配置按 invalid 处理（父裁决 P07：
 * 危险键不能被"跳过"后降级成「缺该渠道 → 继承 legacy」）。
 */
export function containsForbiddenKey(value) {
  let visited = 0
  function walk(node, depth) {
    if (visited > 500 || depth > 6) return false
    if (node === null || node === undefined || typeof node !== 'object') return false
    visited += 1
    if (Array.isArray(node)) {
      for (const item of node) if (walk(item, depth + 1)) return true
      return false
    }
    for (const key of Object.keys(node)) {
      if (isForbiddenKey(key)) return true
      if (walk(node[key], depth + 1)) return true
    }
    return false
  }
  return walk(value, 0)
}

/** 判定某 channelId 是否属于阈值配置允许出现的形态（内置 id 或 `custom:<6..64>`）。 */
export function isThresholdChannelId(id) {
  if (!isSafeKey(id)) return false
  if (id.indexOf('custom:') === 0) return id.length > 7
  return true
}

/**
 * 把 wire 上的 `scope` 精确映射成窗口 key。
 *
 * [A12 风格] **精确匹配**，不做 substring / 大小写猜测：不认识就是 null。
 */
export function windowKeyOf(scope) {
  if (typeof scope !== 'string') return null
  return WINDOW_KEYS.indexOf(scope) === -1 ? null : scope
}

/** 窗口 key → 中文标签；未知 key 返回 null（调用方自行回退到安全化后的 key）。 */
export function windowLabelOf(key) {
  if (typeof key !== 'string') return null
  return Object.prototype.hasOwnProperty.call(WINDOW_LABELS, key) ? WINDOW_LABELS[key] : null
}

// ---------------------------------------------------------------------------
// 窗口选择（**旧语义**，legacy 分支专用）
// ---------------------------------------------------------------------------

/**
 * 旧实现里「最小时间单位」的窗口排序。
 *
 * ⚠️ 这段与 `plans/quota-prompt.js` 0.9.x 的实现**逐字一致**（含 substring 匹配与
 * 未知 scope 排在最后）：legacy 分支必须保持旧行为，所以这里刻意保留旧写法，
 * 不要"顺手改成按 key 精确匹配"——那会悄悄改掉旧用户的判定结果。
 */
const WINDOW_ORDER = ['rolling-5h', 'rolling-1d', 'daily', 'weekly', 'monthly']

/** 旧实现：按 `scope` 里出现的时长取最短的那个窗口（legacy 判定与旧 GUI 文本共用）。 */
export function pickSmallestWindow(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const usable = windows.filter((w) => w !== null && typeof w === 'object'
    && typeof w.percent === 'number' && Number.isFinite(w.percent))
  if (usable.length === 0) return null
  const rank = (w) => {
    const scope = typeof w.scope === 'string' ? w.scope : ''
    const idx = WINDOW_ORDER.findIndex((name) => scope.indexOf(name) !== -1)
    return idx === -1 ? WINDOW_ORDER.length : idx
  }
  let best = usable[0]
  for (const w of usable) {
    if (rank(w) < rank(best)) best = w
  }
  return best
}

// ---------------------------------------------------------------------------
// 阈值归一化
// ---------------------------------------------------------------------------

const MAX_PERCENT = 100

function normalizePercentValue(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw <= 0 || raw > MAX_PERCENT) return null
  return raw
}

/**
 * 金额/积分阈值：只有「正的有限数」才算配置。
 *
 * ⚠️ [2026-10-23 父裁决 P08] **不加上限**：旧的 `normalizeBalanceThreshold` 允许任意大的
 * 有限正数（1e14 之类也合法）。擅自加 1e12 上限会悄悄改掉旧配置的判定结果，
 * 也会让合法的新配置失效。上限只保留在百分比（100 是语义上界）。
 */
function normalizeAmountValue(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw <= 0) return null
  return raw
}

function normalizeCurrency(raw) {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/**
 * 一对阈值：两档都在且 `closing >= warning` → **两档一起作废**（不猜用户意图）。
 * 单档存在时保留（只有预警或只有收尾都合法，沿用 `stageOf` 语义）。
 */
function normalizePair(raw, kind) {
  const norm = kind === 'percent' ? normalizePercentValue : normalizeAmountValue
  const box = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (box === null) return { warning: null, closing: null }
  const warning = norm(Object.prototype.hasOwnProperty.call(box, 'warning') ? box.warning : undefined)
  const closing = norm(Object.prototype.hasOwnProperty.call(box, 'closing') ? box.closing : undefined)
  if (warning !== null && closing !== null && closing >= warning) {
    return { warning: null, closing: null }
  }
  return { warning, closing }
}

function normalizeBalance(raw) {
  const box = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (box === null) return null
  const pair = normalizePair(box, 'amount')
  const currency = normalizeCurrency(Object.prototype.hasOwnProperty.call(box, 'currency')
    ? box.currency
    : undefined)
  if (pair.warning === null && pair.closing === null) return { warning: null, closing: null, currency }
  return { warning: pair.warning, closing: pair.closing, currency }
}

function emptyResolved(source, reason) {
  return {
    source,
    legacy: false,
    reason: reason === undefined ? null : reason,
    windows: {},
    percent: null,
    balance: null,
    credits: null,
  }
}

/** 解析单个渠道条目；`ok:false` 表示该条目类型坏（该渠道 fail closed）。 */
function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'channel-invalid', windows: {}, balance: null, credits: null }
  }
  const windows = {}
  const winRaw = Object.prototype.hasOwnProperty.call(entry, 'windows') ? entry.windows : undefined
  if (winRaw !== undefined && winRaw !== null) {
    if (typeof winRaw !== 'object' || Array.isArray(winRaw)) {
      return { ok: false, reason: 'channel-invalid', windows: {}, balance: null, credits: null }
    }
    for (const key of Object.keys(winRaw)) {
      // 未知/词表外的窗口键：忽略（不判定、不显示）；原始 JSON 仍由客户端原样保留。
      if (WINDOW_KEYS.indexOf(key) === -1) continue
      windows[key] = normalizePair(winRaw[key], 'percent')
    }
  }
  const balance = Object.prototype.hasOwnProperty.call(entry, 'balance')
    ? normalizeBalance(entry.balance)
    : null
  const creditsRaw = Object.prototype.hasOwnProperty.call(entry, 'credits') ? entry.credits : undefined
  const creditsPair = normalizePair(creditsRaw, 'amount')
  const credits = creditsPair.warning === null && creditsPair.closing === null
    ? null
    : creditsPair
  return { ok: true, reason: null, windows, balance, credits }
}

/**
 * 解析 `quotaChannelThresholds` 原始字符串。
 *
 * @param {unknown} raw 配置里的原值（可能是 volatile 包装解包后的字符串 / undefined / null / 其它）
 * @returns {{ state:'absent'|'invalid'|'ok', reason:string|null, channels:object }}
 */
export function parseChannelThresholds(raw) {
  if (raw === undefined) return { state: 'absent', reason: null, channels: {} }
  if (typeof raw !== 'string') {
    // ⚠️ parent 裁决 R2：`null` 不是「未出现」，而是坏类型 → 整体 fail closed。
    return { state: 'invalid', reason: 'bad-type', channels: {} }
  }
  const text = raw.trim()
  if (text.length === 0) return { state: 'absent', reason: null, channels: {} }
  if (text.length > MAX_THRESHOLD_JSON_LENGTH) {
    return { state: 'invalid', reason: 'too-large', channels: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { state: 'invalid', reason: 'bad-json', channels: {} }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'bad-shape', channels: {} }
  }
  /**
   * [2026-10-23 父裁决 P07] **危险键不能"跳过"**。
   *
   * 之前 `isSafeKey` 只是不把 `constructor` / `__proto__` 当渠道条目，
   * 于是 `{"constructor":{}}` 解析成「合法但没有渠道覆盖」→ 全部渠道回退 legacy，
   * 等于用一个畸形配置悄悄恢复了旧收尾。现在：任意层级出现危险键 → 整份 invalid（fail closed）。
   */
  if (containsForbiddenKey(parsed)) {
    return { state: 'invalid', reason: 'forbidden-key', channels: {} }
  }
  const ids = Object.keys(parsed)
  if (ids.length > MAX_THRESHOLD_CHANNELS) {
    return { state: 'invalid', reason: 'too-many-channels', channels: {} }
  }
  const channels = {}
  for (const id of ids) {
    // 非渠道 id 形态的键（含非法字符）也按 invalid：配置文件只允许渠道 id 作为键。
    if (!isThresholdChannelId(id)) return { state: 'invalid', reason: 'bad-channel-key', channels: {} }
    channels[id] = normalizeEntry(parsed[id])
  }
  return { state: 'ok', reason: null, channels }
}

/**
 * 把旧全局阈值（`thresholdsOf(cfg)` 的形状）转成统一 resolved 形状。
 *
 * legacy 分支：`percent` 只作用于 `pickSmallestWindow()` 选出的那一个窗口。
 */
export function legacyResolvedOf(legacy) {
  const box = legacy !== null && legacy !== undefined && typeof legacy === 'object' ? legacy : {}
  const warnPercent = normalizePercentValue(box.warningPercent)
  const closePercent = normalizePercentValue(box.closingPercent)
  const percentOk = warnPercent !== null && closePercent !== null ? closePercent < warnPercent : true
  const warnBalance = normalizeAmountValue(box.warningBalance)
  const closeBalance = normalizeAmountValue(box.closingBalance)
  const balanceOk = warnBalance !== null && closeBalance !== null ? closeBalance < warnBalance : true
  const warnCredits = normalizeAmountValue(box.warningCredits)
  const closeCredits = normalizeAmountValue(box.closingCredits)
  const creditsOk = warnCredits !== null && closeCredits !== null ? closeCredits < warnCredits : true
  const currency = normalizeCurrency(box.balanceCurrency)
  return {
    source: 'legacy',
    legacy: true,
    reason: null,
    windows: {},
    percent: {
      warning: percentOk ? warnPercent : null,
      closing: percentOk ? closePercent : null,
    },
    balance: {
      warning: balanceOk ? warnBalance : null,
      closing: balanceOk ? closeBalance : null,
      currency,
    },
    credits: {
      warning: creditsOk ? warnCredits : null,
      closing: creditsOk ? closeCredits : null,
    },
  }
}

/**
 * 解析某渠道**本次**生效的阈值。
 *
 * @param {object} parsed `parseChannelThresholds` 的结果
 * @param {string} channelId 渠道 id
 * @param {object} legacy `thresholdsOf(cfg)` 的结果（旧全局三组）
 * @returns {object} resolved（`source`: 'channel' | 'legacy' | 'blocked'）
 */
export function resolveChannelThresholds(parsed, channelId, legacy) {
  const state = parsed !== null && parsed !== undefined ? parsed : { state: 'absent', channels: {} }
  if (state.state === 'absent') return legacyResolvedOf(legacy)
  if (state.state === 'invalid') return emptyResolved('blocked', state.reason === null ? 'invalid-config' : state.reason)
  const channels = state.channels !== null && typeof state.channels === 'object' ? state.channels : {}
  const hasEntry = typeof channelId === 'string' && Object.prototype.hasOwnProperty.call(channels, channelId)
  // 该渠道没有自己的条目 → 仍走它自己的 legacy（编辑别的渠道不会伤到它）。
  if (!hasEntry) return legacyResolvedOf(legacy)
  const entry = channels[channelId]
  if (entry === null || entry === undefined || entry.ok !== true) {
    return emptyResolved('blocked', entry !== null && entry !== undefined && typeof entry.reason === 'string'
      ? entry.reason
      : 'channel-invalid')
  }
  return {
    source: 'channel',
    legacy: false,
    reason: null,
    // 该渠道权威：条目里没有的窗口/指标一律「未配置」，**不逐窗口退 global**。
    windows: entry.windows,
    percent: null,
    balance: entry.balance,
    credits: entry.credits,
  }
}

/** 本次是否有任何有效阈值（false = 零规则）。 */
export function resolvedActive(resolved) {
  if (resolved === null || resolved === undefined || typeof resolved !== 'object') return false
  if (resolved.source === 'blocked') return false
  if (resolved.legacy === true) {
    const p = resolved.percent
    const b = resolved.balance
    const c = resolved.credits
    return (p !== null && typeof p === 'object' && (p.warning !== null || p.closing !== null))
      || (b !== null && typeof b === 'object' && (b.warning !== null || b.closing !== null))
      || (c !== null && typeof c === 'object' && (c.warning !== null || c.closing !== null))
  }
  for (const key of Object.keys(resolved.windows !== null && typeof resolved.windows === 'object' ? resolved.windows : {})) {
    const pair = resolved.windows[key]
    if (pair !== null && typeof pair === 'object' && (pair.warning !== null || pair.closing !== null)) return true
  }
  const b = resolved.balance
  if (b !== null && typeof b === 'object' && (b.warning !== null || b.closing !== null)) return true
  const c = resolved.credits
  if (c !== null && typeof c === 'object' && (c.warning !== null || c.closing !== null)) return true
  return false
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function pushMetric(metrics, metric) {
  if (metric === null) return
  const stage = metric.stage
  if (stage === STAGE_NORMAL || stage === undefined) return
  metrics.push(metric)
}

function windowMetric(kind, scope, value, stage, pair, extra) {
  const metric = {
    kind,
    scope: scope === undefined ? null : scope,
    value,
    stage,
    warning: pair !== null && typeof pair === 'object' ? pair.warning : null,
    closing: pair !== null && typeof pair === 'object' ? pair.closing : null,
  }
  if (extra !== undefined && extra !== null && typeof extra === 'object') {
    if (typeof extra.currency === 'string') metric.currency = extra.currency
  }
  return metric
}

/** 找某个窗口 key 对应的窗口对象（**精确匹配** scope）。 */
export function findWindowByKey(windows, key) {
  if (!Array.isArray(windows) || typeof key !== 'string') return null
  for (const win of windows) {
    if (win === null || typeof win !== 'object') continue
    if (win.scope !== key) continue
    if (typeof win.percent !== 'number' || !Number.isFinite(win.percent)) continue
    return win
  }
  return null
}

/**
 * 判定一个渠道的阶段与触发明细。
 *
 * - `legacy` 分支：只判 `pickSmallestWindow()` 选出的一个窗口（旧行为）；
 * - per-channel 分支：**每个实际存在的窗口**用自己的两档独立判定，整体取最严重；
 * - 金额只与**同币种**比较（配置缺币种 → 不参与）；积分只与积分阈值比较。
 *
 * @param {object} channel 脱敏渠道投影（`windows/balance/currency/unit/availability`）
 * @param {object} resolved `resolveChannelThresholds` 的结果
 * @param {(windows:any)=>object|null} [pickWindow] 旧语义的窗口选择器（默认 `pickSmallestWindow`）
 * @returns {{ stage:string, metrics:Array }}
 */
export function evaluateChannelMetrics(channel, resolved, pickWindow) {
  const metrics = []
  if (channel === null || channel === undefined || typeof channel !== 'object') {
    return { stage: STAGE_NORMAL, metrics }
  }
  if (resolved === null || resolved === undefined || typeof resolved !== 'object') {
    return { stage: STAGE_NORMAL, metrics }
  }
  if (resolved.source === 'blocked') return { stage: STAGE_NORMAL, metrics }
  if (channel.availability !== 'ok') return { stage: STAGE_NORMAL, metrics }
  if (channel.unlimited === true) return { stage: STAGE_NORMAL, metrics }
  if (channel.stale === true) return { stage: STAGE_NORMAL, metrics }

  if (resolved.legacy === true) {
    const pick = typeof pickWindow === 'function' ? pickWindow : pickSmallestWindow
    const win = pick(channel.windows)
    if (win !== null && win !== undefined && typeof win.percent === 'number' && Number.isFinite(win.percent)) {
      const pair = resolved.percent
      pushMetric(metrics, windowMetric('percent', win.scope, win.percent,
        stageOf(win.percent, pair.warning, pair.closing), pair))
    }
  } else {
    const pairs = resolved.windows !== null && typeof resolved.windows === 'object' ? resolved.windows : {}
    for (const key of WINDOW_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(pairs, key)) continue
      const pair = pairs[key]
      if (pair === null || typeof pair !== 'object') continue
      const win = findWindowByKey(channel.windows, key)
      if (win === null) continue // 该窗口本次不存在：不判、不借别的窗口
      pushMetric(metrics, windowMetric('percent', key, win.percent,
        stageOf(win.percent, pair.warning, pair.closing), pair))
    }
  }

  const balance = resolved.balance
  if (channel.unit === 'currency' && typeof channel.balance === 'number' && Number.isFinite(channel.balance)
    && balance !== null && typeof balance === 'object'
    && typeof balance.currency === 'string'
    && typeof channel.currency === 'string'
    && channel.currency.toUpperCase() === balance.currency) {
    pushMetric(metrics, windowMetric('balance', null, channel.balance,
      stageOf(channel.balance, balance.warning, balance.closing), balance, { currency: balance.currency }))
  }

  const credits = resolved.credits
  if (channel.unit === 'credits' && typeof channel.balance === 'number' && Number.isFinite(channel.balance)
    && credits !== null && typeof credits === 'object') {
    pushMetric(metrics, windowMetric('credits', null, channel.balance,
      stageOf(channel.balance, credits.warning, credits.closing), credits))
  }

  // 稳定排序：严重度降序 → 窗口词表序 → kind 序（**与数组顺序无关**）。
  const kindRank = (m) => (m.kind === 'percent' ? 0 : m.kind === 'balance' ? 1 : 2)
  const windowRank = (m) => {
    if (typeof m.scope !== 'string') return WINDOW_KEYS.length + 1
    const idx = WINDOW_KEYS.indexOf(m.scope)
    return idx === -1 ? WINDOW_KEYS.length : idx
  }
  metrics.sort((a, b) => {
    const byStage = stageRank(b.stage) - stageRank(a.stage)
    if (byStage !== 0) return byStage
    const byWindow = windowRank(a) - windowRank(b)
    if (byWindow !== 0) return byWindow
    return kindRank(a) - kindRank(b)
  })

  let stage = STAGE_NORMAL
  for (const metric of metrics) stage = worstStage(stage, metric.stage)
  return { stage, metrics }
}

/**
 * 旧签名的阶段判定（legacy 语义，供既有测试/调用方保持兼容）。
 *
 * @param {object} channel 渠道投影
 * @param {object} thresholds `thresholdsOf(cfg)` 的形状（旧全局三组）
 * @param {(windows:any)=>object|null} [pickWindow] 窗口选择器（默认 `pickSmallestWindow`）
 * @returns {{ stage:string, metric:object|null }}
 */
export function legacyStageForChannel(channel, thresholds, pickWindow) {
  const resolved = legacyResolvedOf(thresholds)
  const evaluated = evaluateChannelMetrics(channel, resolved, pickWindow)
  return { stage: evaluated.stage, metric: simplestMetric(evaluated.metrics) }
}

// ---------------------------------------------------------------------------
// 窗口能力描述（设置页「实际有哪些窗口」的唯一来源）
// ---------------------------------------------------------------------------

/**
 * 把一条 Host 观察描述成「这个渠道本次实际具备哪些窗口」。
 *
 * 纯函数，**不取数、不解析凭据**。语义（父裁决 F2）：
 *   - 身份不一致 → `stale-identity`，且**不回窗口**（不拿上一个账号的能力）；
 *   - `failed` / `expired` / 其它非 ok|cached 状态 → 只回状态、不回窗口
 *     （"失败"≠"确认没有这个窗口"）；
 *   - `ok` / `cached` → 按**词表固定序**列出实际出现的窗口 key 与剩余百分比。
 *
 * @param {object} input
 * @param {object|null} input.meta `channelMeta` 条目（`{status, identity, sampledAt}`）
 * @param {object|null} input.channel `channelProjection` 条目（模型投影）
 * @param {string|null} input.expectedIdentity 当前配置应有的身份指纹
 * @returns {{ status:string, sampledAt:number|null, unit:string|null, currency:string|null, windows:Array }}
 */
export function describeWindowCapability(input) {
  const opts = input !== null && input !== undefined ? input : {}
  const meta = opts.meta !== null && opts.meta !== undefined && typeof opts.meta === 'object' ? opts.meta : null
  const channel = opts.channel !== null && opts.channel !== undefined && typeof opts.channel === 'object'
    ? opts.channel
    : null
  const expected = typeof opts.expectedIdentity === 'string' && opts.expectedIdentity.length > 0
    ? opts.expectedIdentity
    : null
  const out = {
    status: 'none',
    sampledAt: meta !== null && typeof meta.sampledAt === 'number' ? meta.sampledAt : null,
    unit: null,
    currency: null,
    windows: [],
  }
  if (meta === null) return out
  const identityOk = expected !== null && meta.identity === expected
  out.status = identityOk
    ? (typeof meta.status === 'string' && meta.status.length > 0 ? meta.status : 'pending')
    : 'stale-identity'
  if (!identityOk) return out
  if (meta.status !== 'ok' && meta.status !== 'cached') return out
  if (channel === null) return out
  if (typeof channel.unit === 'string') out.unit = channel.unit
  if (typeof channel.currency === 'string') out.currency = channel.currency.toUpperCase()
  const list = []
  for (const key of WINDOW_KEYS) {
    const win = findWindowByKey(channel.windows, key)
    if (win === null) continue
    list.push({ key, percent: win.percent })
  }
  out.windows = list
  return out
}


/** 取最严重的一条 metric，并退回旧的最小形状（`{kind,value,scope|currency}`）。 */
export function simplestMetric(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return null
  const worst = metrics[0]
  if (worst.kind === 'percent') return { kind: 'percent', value: worst.value, scope: worst.scope }
  if (worst.kind === 'balance') return { kind: 'balance', value: worst.value, currency: worst.currency }
  return { kind: 'credits', value: worst.value }
}
