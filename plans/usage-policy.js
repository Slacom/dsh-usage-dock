/**
 * [方向 6 / T3] 可选的「Agent 收尾建议」策略配置与提示词片段。
 *
 * 设计原则（计划第 6 节 + D6-G/H 复核）：
 *   - **默认关闭**：`quotaPolicyEnabled` 默认 false。没打开时模型只拿到数字。
 *   - **显式选择**：必须显式填关注渠道，并且**明确给出有效阈值**；
 *     **没有默认阈值**（复核发现此前擅自补 20%，而计划里 20% 只是示例）。
 *   - **按单位匹配**：百分比阈值只作用于窗口比例；金额阈值必须指定币种，
 *     只与**币种一致**的余额比较。积分（credits）永远不与金额阈值比较。
 *   - **未知不劝停**：`unknown` / `error` / `stale` / `unlimited` / `unavailable` 都不参与。
 *   - **不硬性停机**：提示只描述「可以考虑收尾」，不改模型、不杀宿主、不重启。
 */

import z from '@deepseek-ai/schemastery'

/** 策略关注的渠道上限（避免提示词无限膨胀）。 */
export const MAX_FOCUS_CHANNELS = 8

/** 百分比阈值的有效区间：(0, 100]。**0 表示未配置**，不是「用默认值」。 */
export const MIN_PERCENT_THRESHOLD = 0
export const MAX_PERCENT_THRESHOLD = 100

/**
 * 策略相关的配置字段（全部 `.volatile()` 以便出现在设置页）。
 *
 * ⚠️ 两个阈值默认都是 **0 = 未配置/不启用**。复核明确要求：
 * 未填、NaN、越界都**必须**被当成「没有可用判据」，绝不能自动补成 20%。
 */
export function quotaPolicySchemaFields() {
  return {
    // ---- 总开关 ----
    // [额度自动感知] 复用旧字段作为总开关：关闭时不自动注入任何额度快照或规则。
    quotaPolicyEnabled: z.boolean().default(false).volatile(),
    // 允许参与自动判定的渠道白名单（JSON 数组字符串）。空 = 不启用。
    // ⚠️ 这是**白名单**，不是「当前正在用哪个渠道」的选择器：当前路由由 RouteObservation 决定。
    quotaFocusChannels: z.string().default('[]').volatile(),

    // ---- 旧单阈值（0.9.0 遗留，保留不删，不参与新两档判定）----
    quotaPercentThreshold: z.number().default(0).volatile(),
    quotaBalanceThreshold: z.number().default(0).volatile(),

    // ---- 新两档：订阅额度（剩余百分比）----
    // 0 = 未配置。配置两档时收尾值必须低于预警值，否则视为未配置（不猜）。
    quotaWarningPercentThreshold: z.number().default(0).volatile(),
    quotaClosingPercentThreshold: z.number().default(0).volatile(),

    // ---- 新两档：账户余额（金额）----
    quotaWarningBalanceThreshold: z.number().default(0).volatile(),
    quotaClosingBalanceThreshold: z.number().default(0).volatile(),
    // 金额阈值的币种（ISO 代码）。空 = 不启用金额判据。
    quotaBalanceCurrency: z.string().default('').volatile(),

    // ---- 新两档：积分（WorkBuddy 类）----
    // 积分不是金额，单独一组字段，不借用金额阈值。
    quotaWarningCreditsThreshold: z.number().default(0).volatile(),
    quotaClosingCreditsThreshold: z.number().default(0).volatile(),

    /**
     * ---- [2026-10-23] 按渠道 / 按窗口的两档阈值（JSON 对象字符串）----
     *
     * 形状（键 = 渠道 id；窗口键只能是 rolling-5h / weekly / monthly）：
     * ```
     * { "codex": { "windows": { "weekly": { "warning": 20, "closing": 5 } } },
     *   "deepseek": { "balance": { "warning": 10, "closing": 3, "currency": "CNY" } },
     *   "workbuddy": { "credits": { "warning": 400, "closing": 100 } } }
     * ```
     *
     * ⚠️ 默认值必须是**空串**：`''` = 未出现 → 全部渠道继续走上面那三组旧全局阈值；
     * 若默认写成 `'{}'`，就再也无法区分"用户没配过"与"用户显式清空"。
     * 解析/判定见 `plans/quota-thresholds.js`（含 null、坏 JSON 的整体 fail closed 语义）。
     * 上面那些旧阈值字段的原值**绝不**因这次新增被修改或清零。
     */
    quotaChannelThresholds: z.string().default('').volatile(),

    // ---- 显式路由绑定（内置表无法证明时的兜底）----
    // JSON 数组字符串：[{ provider, model?, channelId, source? }]
    // 只用于「自定义/别名路由」；正常路由走已核验内置表，不需要用户配置。
    quotaRouteBindings: z.string().default('[]').volatile(),

    // ---- [A06] 路由观察能力闸门 ----
    // `agent/request` 的观察值只有在「已知连接插件的路由写入器先安装」时才可信。
    // **默认关闭**（[R2-03] 审核明确要求）：新增配置项的默认值不能替代用户的显式授权。
    // 开着时：不投放任何额度、normal 零规则，绝不依据未验证路由注入收尾。
    // 用户确认自己部署的安装顺序可信后，手动打开即可。
    quotaTrustRouteOrder: z.boolean().default(false).volatile(),
  }
}

/** 解析关注渠道 id 列表（容错：坏 JSON / 非数组 / 非字符串都安全退化）。 */
export function parseFocusChannels(raw) {
  let list = null
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch (err) {
      list = null
    }
  }
  if (list === null) return []
  const out = []
  const seen = {}
  for (const item of list) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id.length === 0 || seen[id] === true) continue
    seen[id] = true
    out.push(id)
    if (out.length >= MAX_FOCUS_CHANNELS) break
  }
  return out
}

/** 归一化币种：大写，只接受 3 位字母；其它返回 null。 */
export function normalizePolicyCurrency(raw) {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return null
  return code
}

/**
 * 解析显式路由绑定（JSON 数组字符串）。
 *
 * 只用于内置表无法证明的自定义/别名路由。每项形如：
 * `{ provider, model?, channelId, source? }`
 *
 * 容错：坏 JSON / 非数组 / 缺字段 / 字段类型不对的条目**整条丢弃**，不猜。
 * 同一 provider（+model）指向多个不同目标属于歧义，由调用方拒绝。
 */
export function parseRouteBindings(raw) {
  let list = null
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch (err) {
      list = null
    }
  }
  if (list === null) return []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    if (item.enabled === false) continue
    const provider = typeof item.provider === 'string' ? item.provider.trim() : ''
    const channelId = typeof item.channelId === 'string' ? item.channelId.trim() : ''
    if (provider.length === 0 || channelId.length === 0) continue
    const model = typeof item.model === 'string' && item.model.trim().length > 0 ? item.model.trim() : null
    const source = typeof item.source === 'string' && item.source.trim().length > 0 ? item.source.trim() : null
    out.push({ provider, model, channelId, source })
    if (out.length >= MAX_FOCUS_CHANNELS * 2) break
  }
  return out
}

/** 百分比阈值：只有 (0, 100] 内的有限数才算配置；其它一律 null。 */
export function normalizePercentThreshold(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw <= MIN_PERCENT_THRESHOLD || raw > MAX_PERCENT_THRESHOLD) return null
  return raw
}

/** 余额阈值：只有 > 0 的有限数才算配置。 */
export function normalizeBalanceThreshold(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw <= 0) return null
  return raw
}

/**
 * 从策略配置里读出**生效**的策略；未启用、配置不完整或阈值无效时返回 `null`。
 *
 * 「有效」= 至少有一个判据成立：
 *   - 百分比阈值在 (0, 100] 内；
 *   - **或**余额阈值为正、且同时配置了合法币种。
 * 只有关注渠道而没有有效阈值 → 不产生任何建议（宁可不说）。
 */
export function policyOf(cfg) {
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return null
  if (cfg.quotaPolicyEnabled !== true) return null
  const focus = parseFocusChannels(cfg.quotaFocusChannels)
  if (focus.length === 0) return null
  const percent = normalizePercentThreshold(cfg.quotaPercentThreshold)
  const balanceRaw = normalizeBalanceThreshold(cfg.quotaBalanceThreshold)
  const currency = normalizePolicyCurrency(cfg.quotaBalanceCurrency)
  // 金额判据必须「有阈值 + 有币种」同时成立，否则不参与。
  const balance = balanceRaw !== null && currency !== null ? balanceRaw : null
  if (percent === null && balance === null) return null
  return {
    focus,
    percent,
    balance,
    currency: balance === null ? null : currency,
  }
}

/**
 * 判断一条渠道是否触发「建议收尾」。
 *
 * 保守规则：
 *   - 只有 `availability === 'ok'` 才参与（unlimited / unavailable / error / unknown 都不参与）；
 *   - `stale` 不参与；
 *   - 百分比判据只看**窗口剩余比例**，且必须低于阈值；
 *   - 金额判据只在渠道 `unit === 'currency'` 且**币种一致**时比较；
 *   - 积分（`unit === 'credits'`）永不与金额阈值比较。
 */
export function evaluateChannel(channel, policy) {
  const reasons = []
  if (channel === null || channel === undefined || typeof channel !== 'object') {
    return { triggered: false, reasons }
  }
  if (policy === null || policy === undefined) return { triggered: false, reasons }
  if (channel.stale === true) return { triggered: false, reasons }
  if (channel.unlimited === true) return { triggered: false, reasons }
  if (channel.availability !== 'ok') return { triggered: false, reasons }

  const percent = normalizePercentThreshold(policy.percent)
  if (percent !== null && Array.isArray(channel.windows)) {
    for (const win of channel.windows) {
      if (win === null || typeof win !== 'object') continue
      if (typeof win.percent !== 'number' || !Number.isFinite(win.percent)) continue
      if (win.percent < percent) {
        reasons.push((win.scope || '窗口') + ' 剩余 ' + formatNum(win.percent) + '% < ' + formatNum(percent) + '%')
      }
    }
  }

  const balance = normalizeBalanceThreshold(policy.balance)
  const currency = normalizePolicyCurrency(policy.currency)
  if (balance !== null && currency !== null) {
    // 只有明确的「金额」单位、且币种与配置一致时才比较。
    if (channel.unit === 'currency') {
      const channelCurrency = typeof channel.currency === 'string' ? channel.currency.toUpperCase() : ''
      if (channelCurrency === currency && typeof channel.balance === 'number' && Number.isFinite(channel.balance)) {
        if (channel.balance < balance) {
          reasons.push('余额 ' + formatNum(channel.balance) + ' ' + currency + ' < ' + formatNum(balance) + ' ' + currency)
        }
      }
    }
  }
  return { triggered: reasons.length > 0, reasons }
}

/**
 * 生成给模型的策略提示片段。
 *
 * 返回 `null` 表示「不附加任何内容」（未启用 / 无触发 / 配置不完整）。
 * 绝不返回「必须停工」这类硬性结论（计划第 6 节）。
 */
export function policyPromptFor(cfg, result) {
  const policy = policyOf(cfg)
  if (policy === null) return null
  return policyPromptWith(policy, result)
}

/**
 * 用**已解析**的策略对象生成提示（供工具编排层复用，避免重复解析配置）。
 */
export function policyPromptWith(policy, result) {
  if (policy === null || policy === undefined) return null
  const channels = result !== null && result !== undefined && Array.isArray(result.channels)
    ? result.channels
    : []
  if (channels.length === 0) return null
  const hits = []
  for (const ch of channels) {
    if (policy.focus.indexOf(ch.id) === -1) continue
    const evaluated = evaluateChannel(ch, policy)
    if (!evaluated.triggered) continue
    hits.push({ channel: ch, reasons: evaluated.reasons })
  }
  if (hits.length === 0) return null
  const lines = [
    '【用量提示】以下关注渠道已低于你设置的阈值：',
  ]
  for (const hit of hits) {
    lines.push('- ' + (hit.channel.name || hit.channel.id) + '：' + hit.reasons.join('，'))
  }
  lines.push(
    '这只说明当前数值偏低，不构成强制停工要求。若你判断继续工作会超出预算，'
    + '可以选择收尾：完成当前最小工作单元 → 检查变更 → 运行必要测试 → 保存进度并说明交接。',
  )
  return lines.join('\n')
}

/**
 * [D6-G] 系统提示词里常驻的策略摘要（静态规则，不含实时数值）。
 *
 * 只有当策略**确实生效**（`policyOf` 非 null）时才应注册；返回 `null` 表示不需要。
 * 实时数值仍然放在工具结果的 `policy` 字段里，避免提示词随每次取数抖动。
 */
export function policySectionTextFor(cfg) {
  const policy = policyOf(cfg)
  if (policy === null) return null
  const rules = []
  if (policy.percent !== null) rules.push('配额窗口剩余比例低于 ' + formatNum(policy.percent) + '%')
  if (policy.balance !== null) rules.push('余额低于 ' + formatNum(policy.balance) + ' ' + policy.currency)
  if (rules.length === 0) return null
  return [
    '用户已启用用量策略，关注渠道：' + policy.focus.join('、') + '。',
    '判定条件：' + rules.join('；') + '。',
    'usage_status 的返回里只有 `policy` **非 null 且带 text** 时才表示当前已触发；'
    + '`policy: null` 表示未触发（不是「有字段就算触发」）。触发时可按建议收尾：'
    + '完成当前最小工作单元 → 检查变更 → 运行必要测试 → 保存进度并说明交接。',
    '该提示不构成强制停工要求，也不得据此终止未完成的关键工作或自行切换模型。',
  ].join('\n')
}

function formatNum(value) {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}
