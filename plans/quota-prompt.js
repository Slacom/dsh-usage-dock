/**
 * [额度自动感知] 把观察快照渲染成**模型可见**的提示词片段。
 *
 * 硬边界（交接文档 §7.3）：
 *   - 允许：渠道安全名称、额度数值与单位/窗口、缓存标记与原采样时间、当前阶段、
 *     必要的切换说明、固定查询失败/身份过期状态、warning/closing 当前档规则。
 *   - 禁止：HTTP 码、DNS/TLS/代理原因、JSON 路径、响应体、上游文案、异常栈、接口 URL、
 *     账号邮箱、Key/Cookie/token、内部身份指纹、失败计数日志。
 *
 * 本模块只做「读取已算好的数据并拼字符串」，**不取数、不计失败、不发网络请求**。
 */

import {
  STAGE_NORMAL, STAGE_WARNING, STAGE_CLOSING,
  stageOf, worstStage,
} from './quota-observer.js'
import {
  WINDOW_KEYS,
  findWindowByKey,
  windowLabelOf,
  legacyStageForChannel,
  // 旧实现「最小时间单位」的窗口选择器：legacy 分支与旧测试都用它。
  // [2026-10-23] 实现搬进 quota-thresholds.js（避免与判定模块循环依赖），这里只转出。
  pickSmallestWindow,
} from './quota-thresholds.js'

export { pickSmallestWindow }

/**
 * 固定规则模板。
 *
 * 「固定」指**文字固定**，不是每个请求都携带 —— normal 阶段不选中任何一条。
 * 文案必须保持「建议」而非「命令」，不出现强制停工/切模型等措辞。
 */
export const FIXED_RULES = Object.freeze({
  [STAGE_WARNING]:
    '当前额度处于**预警**阶段。请缩小后续工作范围：避免新增大规模重构、长时间运行或高并发任务，'
    + '为收尾保留余量；可以在一个自然断点处保存进度。',
  [STAGE_CLOSING]:
    '当前额度处于**收尾**阶段。请不要再扩张任务范围：完成必要的一致性操作，保存当前进度与检查点，'
    + '做必要的验证，并说明已完成、未完成的部分与恢复步骤，方便下次接手继续。',
})

/**
 * 路由（provider route id）→ 额度渠道的候选映射。
 *
 * **按实际计费路径判断，不看模型展示名**：用 `workbuddy` 路由跑 DeepSeek 模型时，
 * 消耗的是 WorkBuddy 的积分，评估的必须是 `workbuddy` 渠道。
 *
 * 表内容来自已核验的连接契约（`docs/research-quota-route-binding-20261019.md` §5）。
 * 没有映射的 route 一律返回 null —— **不猜、不拿无关渠道触发收尾**。
 *
 * [A12] **精确键**：LLM registry 用的是精确 Map 键，`OPENAI-CODEX` 与 `openai-codex`
 * 是两个不同路由。这里**不做 trim/lowercase 猜测**，别名必须由用户显式绑定。
 *
 * `source` 用于 DeepSeek 这类**同一渠道有多个额度来源**的情况：
 * `deepseek-account` 只能用 account 源快照，`deepseek-official` 只能用 api 源。
 *
 * [A07] `pool` 表达「额度池」约束：Codex 的 `gpt-reserve` 用独立池，
 * 不能拿普通主桶的百分比替它收尾。
 */
const ROUTE_TABLE = Object.freeze({
  'openai-codex': { channelId: 'codex' },
  workbuddy: { channelId: 'workbuddy' },
  'workbuddy-ai': { channelId: 'workbuddy-ai' },
  'deepseek-account': { channelId: 'deepseek', source: 'account' },
  'deepseek-official': { channelId: 'deepseek', source: 'api' },
})

/**
 * 已知需要**独立额度池**的 model 前缀。
 *
 * [A07] Codex 的 `gpt-reserve` 走 Reserve 池，与普通主桶不是同一份额度；
 * 拿普通 `codex` 主桶的百分比替 Reserve 收尾会误判。
 */
const RESERVE_MODEL_PREFIX = 'gpt-reserve'

/**
 * 把 route id 解析成渠道候选。
 *
 * @param {string} provider 本次请求实际使用的 provider route id（精确匹配）
 * @returns {{ channelId: string, source: string|null }|null}
 */
export function resolveRoute(provider) {
  if (typeof provider !== 'string' || provider.length === 0) return null
  // [A12] 精确匹配，不做大小写/空白归一化。
  if (!Object.prototype.hasOwnProperty.call(ROUTE_TABLE, provider)) return null
  const hit = ROUTE_TABLE[provider]
  return { channelId: hit.channelId, source: hit.source === undefined ? null : hit.source }
}

/**
 * 判定该 model 是否使用**独立额度池**（当前只有 Codex Reserve）。
 *
 * @param {string} model
 * @returns {boolean}
 */
export function usesReservePool(model) {
  if (typeof model !== 'string' || model.length === 0) return false
  return model.indexOf(RESERVE_MODEL_PREFIX) === 0
}

/**
 * 只要渠道 id 的便捷函数。
 * @param {string} provider
 * @returns {string|null}
 */
export function channelForProvider(provider) {
  const route = resolveRoute(provider)
  return route === null ? null : route.channelId
}

/** 安全名称：只允许白名单字符，防止把上游自由文本带进提示词。 */
function safeName(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 40) return fallback
  // 只允许中文、字母、数字、空格与少量安全标点。
  if (!/^[\u4e00-\u9fa5A-Za-z0-9 ._+-]+$/.test(trimmed)) return fallback
  return trimmed
}

/** 数字格式化：保留精度，整数不带小数点。 */
function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}

/** 时间格式化：只给到分钟，避免秒级抖动造成快照反复变化。 */
function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 单位后缀：金额带币种、积分带「积分」、其它不带。 */
function unitSuffix(channel) {
  if (channel === null || channel === undefined) return ''
  if (channel.unit === 'currency' && typeof channel.currency === 'string' && channel.currency.length > 0) {
    return ' ' + channel.currency.toUpperCase()
  }
  if (channel.unit === 'credits') return ' 积分'
  return ''
}

/**
 * 计算某渠道在**旧全局阈值**下的阶段与可见数值。
 *
 * [2026-10-23] 这里保留旧签名与旧语义（只判 `pickSmallestWindow()` 选出的那一个窗口），
 * 供既有调用方/测试使用；新的「按渠道 + 按窗口」判定走
 * `plans/quota-thresholds.js` 的 `evaluateChannelMetrics()`。
 *
 * @param {object} channel 脱敏后的渠道投影
 * @param {object} thresholds `{ warningPercent, closingPercent, warningBalance, closingBalance }`
 * @returns {{ stage: string, metric: object|null }}
 */
export function evaluateStage(channel, thresholds) {
  return legacyStageForChannel(channel, thresholds, pickSmallestWindow)
}

/**
 * 渲染模型可见的额度片段。
 *
 * @param {object} view
 * @param {boolean} view.enabled 总开关
 * @param {string} view.provider 当前 provider（可空）
 * @param {string|null} view.channelId 解析出的渠道
 * @param {object|null} view.channel 该渠道的脱敏投影（可能来自缓存）
 * @param {boolean} view.fromCache 是否用了缓存
 * @param {number|null} view.fetchedAt 原采样时间
 * @param {string} view.stage 阶段
 * @param {string|null} view.status 固定状态：'failed' | 'expired' | null
 * @returns {string} 空串表示不投放任何内容
 */
export function renderQuotaPrompt(view) {
  if (view === null || view === undefined || typeof view !== 'object') return ''
  if (view.enabled !== true) return ''
  // 未绑定到具体渠道：不投放（不拿无关渠道的数据冒充当前模型）。
  if (typeof view.channelId !== 'string' || view.channelId.length === 0) return ''

  const lines = []
  const name = safeName(view.channel !== null && view.channel !== undefined ? view.channel.name : '', view.channelId)

  // 固定状态：只给允许的两句话，不附技术细节。
  if (view.status === 'failed') {
    lines.push('[当前额度快照]')
    lines.push('渠道：' + name)
    lines.push('状态：获取额度失败')
    return lines.join('\n')
  }
  if (view.status === 'expired') {
    lines.push('[当前额度快照]')
    lines.push('渠道：' + name)
    lines.push('状态：用量查询身份已过期')
    return lines.join('\n')
  }

  const channel = view.channel
  if (channel === null || channel === undefined) {
    // 没有任何可用数据：既不编造数值，也不谎报失败。
    lines.push('[当前额度快照]')
    lines.push('渠道：' + name)
    lines.push('状态：暂无额度数据')
    return lines.join('\n')
  }

  const stage = typeof view.stage === 'string' ? view.stage : STAGE_NORMAL

  lines.push('[当前额度快照]')
  lines.push('渠道：' + name)
  lines.push('阶段：' + stage)

  // 数值：**本次实际存在的每个窗口各一行**（词表固定序，与数组顺序无关）。
  //
  // [2026-10-23] 旧行为只打印「最小时间单位」那一个窗口；现在单窗口时输出与旧版逐字一致，
  // 多窗口时逐行列出（不合并、不平均、不求百分比之和）。
  let printedWindows = 0
  if (Array.isArray(channel.windows)) {
    for (const key of WINDOW_KEYS) {
      const win = findWindowByKey(channel.windows, key)
      if (win === null) continue
      lines.push('额度：' + key + ' 剩余 ' + formatNumber(win.percent) + '%')
      printedWindows += 1
    }
  }
  if (printedWindows === 0) {
    // 词表外的 scope（历史/异常数据）：保持旧文本形态，但**不**参与阈值判定。
    const fallbackWin = pickSmallestWindow(channel.windows)
    if (fallbackWin !== null) {
      lines.push('额度：' + (fallbackWin.scope ? safeName(fallbackWin.scope, '窗口') + ' ' : '')
        + '剩余 ' + formatNumber(fallbackWin.percent) + '%')
    } else if (typeof channel.balance === 'number') {
      lines.push('额度：' + formatNumber(channel.balance) + unitSuffix(channel))
    }
  }

  // 触发解释：说明**哪个窗口/哪个指标**、当前值多少、越过哪一档（整体阶段取最严重）。
  const metrics = Array.isArray(view.metrics) ? view.metrics : []
  for (const metric of metrics) {
    const line = triggerLineOf(metric)
    if (line !== null) lines.push(line)
  }

  if (typeof view.policyBlocked === 'string' && view.policyBlocked.length > 0) {
    lines.push('说明：阈值配置无法解析，本次未做阈值判定。')
  } else if (view.legacyPolicy === true) {
    lines.push('说明：当前使用旧版全局阈值（按最短窗口判定）。')
  }

  const when = formatTime(view.fetchedAt)
  if (view.fromCache === true) {
    lines.push('来源：缓存')
    if (when !== null) lines.push('采样时间：' + when)
  } else {
    lines.push('来源：本次采集')
    if (when !== null) lines.push('采样时间：' + when)
  }

  // 只有 warning / closing 才附规则；normal 一行行为指令都不加。
  const rule = stage === STAGE_WARNING || stage === STAGE_CLOSING ? FIXED_RULES[stage] : ''
  const facts = lines.join('\n')
  return rule.length > 0 ? facts + '\n\n[当前阶段规则]\n' + rule : facts
}

/** 触发说明的一行文本（窗口/指标 + 当前值 + 越过的阈值 + 该指标自己的阶段）。 */
function triggerLineOf(metric) {
  if (metric === null || metric === undefined || typeof metric !== 'object') return null
  const stage = typeof metric.stage === 'string' ? metric.stage : ''
  const stageWord = stage === STAGE_CLOSING ? '收尾' : stage === STAGE_WARNING ? '预警' : ''
  if (stageWord.length === 0) return null
  const threshold = stage === STAGE_CLOSING ? metric.closing : metric.warning
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null
  if (metric.kind === 'percent') {
    const key = typeof metric.scope === 'string' ? metric.scope : ''
    const label = windowLabelOf(key)
    const name = label === null ? (safeName(key, '窗口')) : label
    const tag = key.length > 0 && label !== null ? '（' + key + '）' : ''
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return null
    return '触发：' + name + tag + ' 剩余 ' + formatNumber(metric.value) + '% < '
      + stageWord + ' ' + formatNumber(threshold) + '%（' + stage + '）'
  }
  if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return null
  if (metric.kind === 'balance') {
    const code = typeof metric.currency === 'string' ? ' ' + metric.currency : ''
    return '触发：余额 ' + formatNumber(metric.value) + code + ' < '
      + stageWord + ' ' + formatNumber(threshold) + code + '（' + stage + '）'
  }
  if (metric.kind === 'credits') {
    return '触发：积分 ' + formatNumber(metric.value) + ' < '
      + stageWord + ' ' + formatNumber(threshold) + '（' + stage + '）'
  }
  return null
}
