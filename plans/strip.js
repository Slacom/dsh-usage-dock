/**
 * [dsh-go 原生 strip] 输入框上方「一行额度」的纯逻辑。
 *
 * 全部纯函数，便于单测：
 *   - 会话路由事件 → `{ provider, model }`（latest wins）
 *   - provider → 额度渠道（内置映射 + 自定义余额条目）
 *   - 投影后的渠道快照 → ≤24 字 strip 文本
 *
 * 不读网络、不读磁盘、不发副作用；由 index.js 传入数据与映射函数。
 */

/** 一条 strip 文本的最大长度（App 按 runes 截断，超限会加省略号）。 */
export const STRIP_MAX_CHARS = 24

/** 渠道 → 完整展示名（用户要求用渠道名而不是缩写）。 */
const FULL_NAMES = Object.freeze({
  'opencode-go': 'OpenCode Go',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  mimo: 'MiMo',
  workbuddy: 'WorkBuddy',
})

/** 窗口 scope → 短标签（中文/英文同一套，尽量短）。 */
const WINDOW_LABELS = Object.freeze({
  'rolling-5h': { zh: '5h', en: '5h' },
  weekly: { zh: '周', en: 'wk' },
  monthly: { zh: '月', en: 'mo' },
})

/** 渠道属于哪类 strip 形态：percent（窗口百分比）/ balance（金额）/ credits（积分）。 */
const STRIP_KIND = Object.freeze({
  'opencode-go': 'percent',
  codex: 'percent',
  deepseek: 'balance',
  mimo: 'balance',
  workbuddy: 'credits',
})

function isEn(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en')
}

/** 按 runes 截断（避免拆开 emoji/代理对），超限补省略号。 */
export function truncateRunes(text, max) {
  if (typeof text !== 'string') return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

/**
 * 从一个会话事件里解析路由（provider/model）。
 *
 * 支持三类事件（latest wins 由调用方处理）：
 *   - `model/selection`：`event.data = { provider, model }`
 *   - `request/header`：`event.data.header.config = { provider, model }`
 *   - `assistant/message`：`event.data.message.source = { provider, model }`
 *
 * @returns {{provider: string, model: string}|null}
 */
export function routeFromSessionEvent(event) {
  if (event === null || event === undefined || typeof event !== 'object') return null
  const type = typeof event.type === 'string' ? event.type : ''
  const data = event.data !== null && typeof event.data === 'object' ? event.data : null
  if (data === null) return null
  let provider
  let model
  if (type === 'model/selection') {
    provider = data.provider
    model = data.model
  } else if (type === 'request/header') {
    const header = data.header !== null && typeof data.header === 'object' ? data.header : null
    const config = header !== null && header.config !== null && typeof header.config === 'object' ? header.config : null
    if (config !== null) {
      provider = config.provider
      model = config.model
    }
  } else if (type === 'assistant/message') {
    const message = data.message !== null && typeof data.message === 'object' ? data.message : null
    const source = message !== null && message.source !== null && typeof message.source === 'object' ? message.source : null
    if (source !== null) {
      provider = source.provider
      model = source.model
    }
  }
  if (typeof provider !== 'string' || provider.length === 0) return null
  return { provider, model: typeof model === 'string' ? model : '' }
}

/**
 * 把一个事件并入会话路由表。provider/model 变化时返回 true（调用方据此立即重算 strip）。
 *
 * @param {Map<string, {provider: string, model: string, source: string}>} map
 * @param {string} sessionId
 * @param {object} event
 */
export function applySessionRouteEvent(map, sessionId, event) {
  if (map === null || typeof map !== 'object' || typeof sessionId !== 'string' || sessionId.length === 0) return false
  const route = routeFromSessionEvent(event)
  if (route === null) return false
  const previous = map.get(sessionId)
  map.set(sessionId, { provider: route.provider, model: route.model, source: String(event.type) })
  return previous === undefined || previous.provider !== route.provider || previous.model !== route.model
}

/**
 * provider → 额度渠道。
 *
 * 精确匹配，不做大小写/展示名猜测：
 *   - 内置：复用宿主 `resolveRoute()`（Web 侧同一张 ROUTE_TABLE）；
 *   - 自定义余额：按用户给条目选定的 provider 精确匹配；
 *   - 其余返回 null（strip 隐藏，不拿无关渠道顶替）。
 *
 * @param {string} provider
 * @param {{resolveRoute: (p: string) => ({channelId: string, source: string|null}|null),
 *          customEntries?: Array<{id: string, provider?: string, name?: string}>}} deps
 * @returns {{channelId: string, custom: boolean, name: string|null}|null}
 */
export function providerToChannel(provider, deps) {
  if (typeof provider !== 'string' || provider.length === 0) return null
  const options = deps !== null && deps !== undefined ? deps : {}
  const resolve = typeof options.resolveRoute === 'function' ? options.resolveRoute : null
  if (resolve !== null) {
    const route = resolve(provider)
    if (route !== null && route !== undefined && typeof route.channelId === 'string' && route.channelId.length > 0) {
      return { channelId: route.channelId, custom: false, name: null, source: route.source === undefined ? null : route.source }
    }
  }
  const entries = Array.isArray(options.customEntries) ? options.customEntries : []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.provider !== provider) continue
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    return { channelId: entry.id, custom: true, name: typeof entry.name === 'string' ? entry.name : null }
  }
  return null
}

/** 金额格式：千分位 + 最多 2 位小数。 */
export function formatAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const abs = Math.abs(value)
  const fixed = abs >= 1000 ? value.toFixed(0) : value.toFixed(2)
  const parts = fixed.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

function currencySymbol(currency) {
  const code = typeof currency === 'string' ? currency.toUpperCase() : ''
  if (code === 'CNY' || code === 'RMB') return '¥'
  if (code === 'USD') return '$'
  if (code === 'EUR') return '€'
  if (code === 'HKD') return 'HK$'
  if (code === 'JPY') return '¥'
  return code.length > 0 ? code + ' ' : ''
}

/** 名字 + 右侧数值尾巴：总长 ≤24，先截名字保证数值可见。 */
function joinNameAndValues(name, values) {
  const tail = Array.isArray(values) ? values.filter((item) => typeof item === 'string' && item.length > 0).join(' ') : ''
  if (tail.length === 0) return truncateRunes(name, STRIP_MAX_CHARS)
  const full = name + ' ' + tail
  if (Array.from(full).length <= STRIP_MAX_CHARS) return full
  const tailLen = Array.from(tail).length
  const nameBudget = STRIP_MAX_CHARS - tailLen - 1
  if (nameBudget >= 3) return truncateRunes(name, nameBudget) + ' ' + tail
  return truncateRunes(tail, STRIP_MAX_CHARS)
}

/** 按 5 小时 → 周 → 月的顺序取各窗口剩余百分比（不存在的窗口跳过）。 */
function windowPercents(windows) {
  const out = []
  for (const scope of ['rolling-5h', 'weekly', 'monthly']) {
    const win = (Array.isArray(windows) ? windows : []).find((item) => item !== null && typeof item === 'object'
      && item.scope === scope && typeof item.percent === 'number' && Number.isFinite(item.percent))
    if (win !== undefined) out.push({ scope, percent: Math.max(0, Math.min(100, Math.round(win.percent))) })
  }
  return out
}

/**
 * 投影后的渠道快照 → strip 文本。
 *
 * 格式：渠道全名 + 数值（按 5 小时 → 周 → 月 依次，最多 24 字）。
 * 例：`OpenCode Go 96% 79% 90%`、`DeepSeek ¥12.34`、`WorkBuddy 3,200 分`。
 * 单行文本无法做真正的右对齐（宿主会折叠空白），这是宿主 slot 的限制。
 *
 * @param {{channelId: string, custom: boolean, name: string|null}} channel
 * @param {object} projected `projectPlan()` / `projectUsage()` 产出的渠道对象
 * @param {{locale?: string}} [options]
 * @returns {{text: string, tone?: string, icon?: string}|null} 无法生成时返回 null（隐藏）
 */
export function formatStripText(channel, projected, options) {
  const opts = options !== null && options !== undefined ? options : {}
  const en = isEn(opts.locale)
  if (channel === null || channel === undefined || typeof channel.channelId !== 'string') return null
  if (projected === null || projected === undefined || typeof projected !== 'object') return null
  const id = channel.channelId
  const kind = channel.custom === true ? 'balance' : (STRIP_KIND[id] || 'balance')
  const name = channel.custom === true
    ? (typeof channel.name === 'string' && channel.name.length > 0 ? channel.name : (en ? 'Custom' : '自定义'))
    : (FULL_NAMES[id] || (typeof projected.name === 'string' ? projected.name : id))

  if (projected.availability === 'error' || projected.availability === 'unknown') return null
  if (projected.availability === 'unlimited') {
    return { text: joinNameAndValues(name, [en ? 'unlimited' : '无限制']), icon: 'wallet' }
  }

  if (kind === 'percent') {
    const entries = windowPercents(projected.windows)
    if (entries.length === 0) return null
    const values = entries.map((entry) => entry.percent + '%')
    const minPercent = entries.reduce((min, entry) => (entry.percent < min ? entry.percent : min), 100)
    return {
      text: joinNameAndValues(name, values),
      tone: minPercent <= 10 ? 'bad' : minPercent <= 30 ? 'warn' : undefined,
      icon: 'wallet',
    }
  }

  if (kind === 'credits') {
    const credits = typeof projected.balance === 'number' ? projected.balance : null
    if (credits === null) return null
    return { text: joinNameAndValues(name, [formatAmount(Math.round(credits)) + (en ? ' pts' : ' 分')]), icon: 'wallet' }
  }

  const balance = typeof projected.balance === 'number' ? projected.balance : null
  if (balance === null) return null
  return {
    text: joinNameAndValues(name, [currencySymbol(projected.currency) + formatAmount(balance)]),
    tone: balance <= 0 ? 'bad' : undefined,
    icon: 'wallet',
  }
}
