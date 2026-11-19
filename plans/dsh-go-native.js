/**
 * [dsh-go 原生适配] 额度详情卡片 → dsh-go App 原生面板（`panels`）。
 *
 * 背景（交接文档 2026-11-14）：
 *   - dsh-go 左侧聊天记录抽屉不开放插件座位；原生位置固定清单里，「详情卡片」的落点是
 *     `panels`：`session.tab`（对话详情 › 插件页签）+ `features`（全部功能）；
 *   - 同一个包继续保留 Web 半（`package.json` 的 `dsh.client`），`dshGo` 清单只对 App 生效；
 *   - 数据层**不重写**：取数仍在 Host 进程内（原生 fetch）；本模块只做
 *     wire → 白名单数据（复用 `plans/usage-tool.js#projectUsage`）→ 原生视图/数据的映射。
 *
 * 关键取舍：
 *   - 视图是**静态骨架 + 数据绑定**：面板打开时按当前配置生成各内置渠道的分块，数值全部走
 *     `{"$":"data.channels.<key>.<field>"}`。App 每次收到新数据都会整棵重新求值（视图规格 §3），
 *     所以刷新、失败回退都不需要重建视图；
 *   - 自定义余额渠道数量不定，用 `list` + 绑定 `data.customRows` 承载；
 *   - 视图/数据里不出现 Key、URL 或上游原文：`projectUsage` 已做白名单投影；
 *   - 面板预算 32 KiB / 120 组件 / 8 层，本视图约 25 节点。
 *
 * 不在本轮：`composer.strip` 状态条、DeepSeek 峰谷/充值明细、工具结果卡。
 */

import { projectUsage } from './usage-tool.js'
/**
 * [0.11.2-alpha.7] 瞬时失败宽限：复用 Host 的同一套分类与阈值（纯函数、无外部依赖），
 * 不再各数一套失败次数，也不会因为内置 provider 的失败 wire 不带 `transient` 就立刻丢旧值。
 */
import {
  classifyFailure,
  TEMPORARY_FAIL_LIMIT,
  FAIL_PERMANENT,
  FAIL_EXPIRED,
} from './quota-observer.js'

/** 面板 id；`package.json` 的 `dshGo.contributes.panels` 必须与之一致。 */
export const PANEL_ID = 'quota'
/** composer.strip 的 id（跨插槽唯一；面板仍叫 quota）。 */
const STRIP_ID = 'strip'

/**
 * [0.11.0] 原生设置面板 id。额度面板底部的「设置」按钮用 `{ open: 'panel:settings' }` 打开它；
 * 清单里单独声明（placement: plugin），因此 App 的插件详情页也能直达。
 */
export const SETTINGS_PANEL_ID = 'settings'

/** [0.11.0] MiMo 扫码登录面板：从设置页「MiMo 扫码登录」按钮打开。 */
export const MIMO_PANEL_ID = 'mimo-login'

/** 与 Web 半一致的刷新节奏；原生面板打开时才有 feed，关闭即取消。 */
export const REFRESH_INTERVAL_MS = 30_000
/** [0.11.4] 最近一次成功取到的额度面板数据：打开面板时先回放它，再后台刷新。 */
let lastQuotaPayload = null

/**
 * 内置渠道 → 原生展示形态。只登记已确认 wire 形状的渠道：
 * 未来新增渠道若没在这里登记，原生面板宁可不显示，也不猜字段。
 */
const CHANNEL_PRESENTATION = {
  'opencode-go': { key: 'opencodeGo', kind: 'quota', name: 'OpenCode Go' },
  // [0.11.4 用户要求] Codex 只有 5 小时 + 周两个窗口，不再渲染「月」行（上游 wire 也不再给）。
  codex: { key: 'codex', kind: 'quota', name: 'Codex', scopes: ['rolling-5h', 'weekly'] },
  deepseek: { key: 'deepseek', kind: 'balance', name: 'DeepSeek' },
  mimo: { key: 'mimo', kind: 'balance', name: 'MiMo' },
  workbuddy: { key: 'workbuddy', kind: 'credits', name: 'WorkBuddy' },
}

/**
 * [0.11.2-alpha.6] 用户要求的原生默认顺序：DeepSeek → MiMo → WorkBuddy → Codex → OpenCode Go。
 *
 * 设置页的 `CHANNEL_SECTIONS` 同序；`cfg.planOrder` 非空时以**已保存顺序**为准，
 * 这里只做兜底——用户从没拖过顺序（`planOrder` 缺省 / `'[]'` / 坏 JSON）时，
 * 面板按这个顺序出现，不再退回 `plans/index.js` 的注册表顺序。
 */
export const NATIVE_CHANNEL_ORDER = ['deepseek', 'mimo', 'workbuddy', 'codex', 'opencode-go']

/** 内置渠道固定的三个额度窗口；scope 与 plans/usage-tool.js 的 WINDOWS 保持一致。 */
const WINDOW_SLOTS = [
  { field: 'w5', caption: 'c5', scope: 'rolling-5h', zh: '5 小时', en: '5 hours' },
  { field: 'week', caption: 'cWeek', scope: 'weekly', zh: '周', en: 'Week' },
  { field: 'month', caption: 'cMonth', scope: 'monthly', zh: '月', en: 'Month' },
]

/**
 * [原生设置页] 可在 App 里直接编辑的字段（都是**非密钥**字段）。
 *
 * 刻意不包含：各渠道 API Key / Cookie（协议没有密码输入、也不该让用户在插件视图里
 * 录入凭据）、自定义余额条目、额度策略阈值表。这些继续在网页版设置页配置；
 * 原生页只负责最常用的开关、Codex 来源和余额提醒阈值。
 */
/**
 * 设置页控件定义。按渠道分组渲染；每个渠道的额度策略输入**只在关注开关打开时**出现
 * （view 由 Host 按当前已保存配置生成，开关切换走 onChange 即时保存 + refresh 重建视图）。
 */
const POLICY_CHANNEL_ID = 'opencode-go'
const POLICY_WINDOW_SCOPES = [
  { scope: 'rolling-5h', key: '5h', zh: '5 小时', en: '5h' },
  { scope: 'weekly', key: 'Week', zh: '周', en: 'Week' },
  { scope: 'monthly', key: 'Month', zh: '月', en: 'Month' },
]

/** 各渠道的额度策略形状：windows（百分比窗口）/ balance（金额+币种）/ credits（积分）。 */
const POLICY_CHANNELS = {
  // [0.11.4 用户要求] OpenCode Go 不再配置「月」窗口。
  'opencode-go': { kind: 'windows', prefix: 'policyOpencode', scopes: ['rolling-5h', 'weekly'] },
  // [0.11.4 用户要求] Codex 也要能就地配置两档阈值：只给真实存在的 5 小时 / 周两个窗口。
  codex: { kind: 'windows', prefix: 'policyCodex', scopes: ['rolling-5h', 'weekly'] },
  deepseek: { kind: 'balance', prefix: 'policyDeepseek' },
  mimo: { kind: 'balance', prefix: 'policyMimo' },
  workbuddy: { kind: 'credits', prefix: 'policyWorkbuddy' },
}

const FOCUS_FIELDS = {
  'opencode-go': 'policyOpencodeFocus',
  deepseek: 'policyDeepseekFocus',
  codex: 'policyCodexFocus',
  mimo: 'policyMimoFocus',
  workbuddy: 'policyWorkbuddyFocus',
}

/** 「关注额度策略」开关（onChange 即时保存并刷新视图）。 */
function focusToggleDef(channelId) {
  return {
    field: FOCUS_FIELDS[channelId],
    kind: 'toggle',
    onChange: 'policyToggle',
    zh: '关注额度策略',
    en: 'Watch quota policy',
  }
}

/** 所有策略输入字段的元数据（数据绑定 / 校验 / 写回共用）。 */
const POLICY_CONTROL_DEFS = []
for (const [channelId, spec] of Object.entries(POLICY_CHANNELS)) {
  if (spec.kind === 'toggle-only') continue
  if (spec.kind === 'windows') {
    const scopes = Array.isArray(spec.scopes) ? spec.scopes : POLICY_WINDOW_SCOPES.map((w) => w.scope)
    for (const win of POLICY_WINDOW_SCOPES) {
      if (!scopes.includes(win.scope)) continue
      POLICY_CONTROL_DEFS.push({
        field: spec.prefix + 'Warn' + win.key,
        kind: 'number',
        min: 0,
        max: 100,
        zh: win.zh + ' 预警（剩余 %）',
        en: win.en + ' warning (% left)',
        channel: channelId,
        scope: win.scope,
        role: 'warning',
      })
      POLICY_CONTROL_DEFS.push({
        field: spec.prefix + 'Close' + win.key,
        kind: 'number',
        min: 0,
        max: 100,
        zh: win.zh + ' 收尾（剩余 %）',
        en: win.en + ' closing (% left)',
        channel: channelId,
        scope: win.scope,
        role: 'closing',
      })
    }
    continue
  }
  // [0.11.4 用户要求] 统一就叫「预警 / 收尾」，不再带「元 / 积分」后缀。
  POLICY_CONTROL_DEFS.push({ field: spec.prefix + 'Warn', kind: 'number', min: 0, max: 1e9, zh: '预警', en: 'Warning', channel: channelId, role: 'warning' })
  POLICY_CONTROL_DEFS.push({ field: spec.prefix + 'Close', kind: 'number', min: 0, max: 1e9, zh: '收尾', en: 'Closing', channel: channelId, role: 'closing' })
  if (spec.kind === 'balance') {
    POLICY_CONTROL_DEFS.push({
      field: spec.prefix + 'Currency',
      kind: 'select',
      zh: '币种',
      en: 'Currency',
      options: ['CNY', 'USD', 'EUR', 'HKD', 'JPY'].map((code) => ({ value: code, label: code })),
      channel: channelId,
      role: 'currency',
    })
  }
}

const FIELD = {
  enabled: { field: 'enabled', kind: 'toggle', zh: '启用额度插件', en: 'Enable Usage Dock' },
  quotaPolicyEnabled: { field: 'quotaPolicyEnabled', kind: 'toggle', onChange: 'policyToggle', zh: '启用额度策略', en: 'Enable quota policy' },
  quotaTrustRouteOrder: { field: 'quotaTrustRouteOrder', kind: 'toggle', zh: '允许路由观察（策略生效前提）', en: 'Allow route observation (policy requirement)' },
  opencodeGoEnabled: { field: 'opencodeGoEnabled', kind: 'toggle', zh: 'OpenCode Go', en: 'OpenCode Go' },
  deepseekEnabled: { field: 'deepseekEnabled', kind: 'toggle', zh: 'DeepSeek', en: 'DeepSeek' },
  deepseekWarnThreshold: { field: 'deepseekWarnThreshold', kind: 'number', min: 0, max: 100000, zh: '余额提醒（元，0 = 关闭）', en: 'Balance alert (CNY, 0 = off)' },
  codexEnabled: { field: 'codexEnabled', kind: 'toggle', zh: 'Codex', en: 'Codex' },
  codexSource: {
    field: 'codexSource',
    kind: 'select',
    zh: '额度来源',
    en: 'Quota source',
    options: [
      { value: 'connect', label: 'Codex Connect' },
      { value: 'subscription', label: 'Codex Subscription' },
    ],
  },
  mimoEnabled: { field: 'mimoEnabled', kind: 'toggle', zh: 'MiMo', en: 'MiMo' },
  mimoWarnThreshold: { field: 'mimoWarnThreshold', kind: 'number', min: 0, max: 100000, zh: '余额提醒（元，0 = 关闭）', en: 'Balance alert (CNY, 0 = off)' },
  mimoRememberLogin: { field: 'mimoRememberLogin', kind: 'toggle', zh: '记住登录（重启引擎后免扫码）', en: 'Remember login (skip QR after restart)' },
  workbuddyEnabled: { field: 'workbuddyEnabled', kind: 'toggle', zh: 'WorkBuddy', en: 'WorkBuddy' },
}

/** 扁平的全部控件（数据 / 校验 / 写回遍历用；顺序与视图无关）。 */
const SETTINGS_CONTROLS = [
  FIELD.enabled,
  FIELD.quotaPolicyEnabled,
  FIELD.quotaTrustRouteOrder,
  FIELD.opencodeGoEnabled,
  focusToggleDef('opencode-go'),
  FIELD.deepseekEnabled,
  FIELD.deepseekWarnThreshold,
  focusToggleDef('deepseek'),
  FIELD.codexEnabled,
  FIELD.codexSource,
  focusToggleDef('codex'),
  FIELD.mimoEnabled,
  FIELD.mimoWarnThreshold,
  FIELD.mimoRememberLogin,
  focusToggleDef('mimo'),
  FIELD.workbuddyEnabled,
  focusToggleDef('workbuddy'),
].concat(POLICY_CONTROL_DEFS)

/** 直接写回配置的字段：普通渠道字段 + 策略总开关 + 路由观察授权。 */
const CONFIG_FIELD_NAMES = new Set([
  'enabled', 'opencodeGoEnabled', 'deepseekEnabled', 'deepseekWarnThreshold',
  'codexEnabled', 'codexSource', 'mimoEnabled', 'mimoWarnThreshold', 'workbuddyEnabled',
  'mimoRememberLogin', 'quotaPolicyEnabled', 'quotaTrustRouteOrder',
])

/** 与 Config schema 的默认值保持一致（读不到配置时的兜底）。 */
const SETTINGS_DEFAULTS = {
  enabled: true,
  opencodeGoEnabled: true,
  deepseekEnabled: true,
  deepseekWarnThreshold: 10,
  codexEnabled: true,
  codexSource: 'connect',
  mimoEnabled: true,
  mimoWarnThreshold: 10,
  mimoRememberLogin: true,
  workbuddyEnabled: true,
  quotaPolicyEnabled: false,
  quotaTrustRouteOrder: false,
}

/** 设置面板要求的 v2 组件（少一个就走 v1 降级视图）。 */
const SETTINGS_FORM_COMPONENTS = ['form', 'toggle', 'number', 'select']

function defaultSettingValue(def) {
  return SETTINGS_DEFAULTS[def.field] !== undefined ? SETTINGS_DEFAULTS[def.field] : 0
}

/** JSON 字符串 → 普通对象 / 数组；坏值安全返回 null。 */
function safeJsonObject(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch (err) {
    return null
  }
}

function safeJsonArray(raw) {
  if (Array.isArray(raw)) return raw.filter((item) => typeof item === 'string')
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch (err) {
    return []
  }
}

/** 固定错误码的英文短说明；中文说明用 projectUsage 给出的固定文案（不透传上游原文）。 */
const ERROR_TEXT_EN = {
  'no-credential': 'No credential',
  'signed-out': 'Signed out',
  auth: 'Authentication failed',
  config: 'Channel misconfigured',
  endpoint: 'Endpoint invalid',
  'credential-unconfirmed': 'Credential target unconfirmed',
  'rate-limit': 'Rate limited',
  server: 'Upstream unavailable',
  network: 'Network unreachable',
  structure: 'Unexpected response',
  rpc: 'Fetch failed',
  api: 'Upstream rejected the request',
  exec: 'Fetch command failed',
  curl: 'Fetch failed',
  http: 'Upstream error',
  'retired-channel': 'Channel retired',
  disabled: 'Channel disabled',
  'not-found': 'Channel not found',
}

/** 数据绑定写法（视图规格 §3：任何值都能写 `{ "$": "data.a.b" }`）。 */
function binding(path) {
  return { $: path }
}

function isEn(locale) {
  return String(locale === null || locale === undefined ? '' : locale).toLowerCase().startsWith('en')
}

function localeOf(caps) {
  return caps !== null && caps !== undefined && typeof caps.locale === 'string' && caps.locale.length > 0
    ? caps.locale
    : 'zh-CN'
}

function localeOfEvent(event, fallback) {
  return event !== null && event !== undefined && typeof event.locale === 'string' && event.locale.length > 0
    ? event.locale
    : fallback
}

/** 两位小时:分钟（本机时区）。 */
function clockOf(value) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

/** 数字展示：整数原样；小数最多两位（与胶囊/工具投影口径一致）。 */
function numberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}

/** 币种符号；未知币种回退「数值 + 代码」。 */
function amountText(value, currency, unit, locale) {
  const number = numberText(value)
  if (number === null) return null
  if (unit === 'credits') return number
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  const symbol = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$' }[code]
  if (symbol !== undefined) return symbol + number
  if (code.length > 0) return number + ' ' + code
  return number
}

/** 窗口重置说明；没有可信字段时返回空串（视图里就是空 caption）。 */
/** 网页版同款两段式倒计时：<1 分钟用秒，其它保留最多两级单位（floor，不四舍五入）。 */
function resetParts(sec, en) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return []
  const total = Math.floor(sec)
  if (total < 60) return [Math.max(1, total) + (en ? 's' : '秒')]
  if (total < 3600) return [Math.floor(total / 60) + (en ? 'min' : '分')]
  if (total < 86400) {
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    return m === 0 ? [h + (en ? 'h' : '时')] : [h + (en ? 'h' : '时'), m + (en ? 'min' : '分')]
  }
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  return h === 0 ? [d + (en ? 'd' : '天')] : [d + (en ? 'd' : '天'), h + (en ? 'h' : '时')]
}

/** 距离重置还剩多久（优先 resetInSec；否则用 resetsAt - now）。 */
function resetCountdown(win, locale, now) {
  const en = isEn(locale)
  if (win === null || win === undefined) return ''
  let sec = null
  if (typeof win.resetInSec === 'number' && Number.isFinite(win.resetInSec) && win.resetInSec >= 0) {
    sec = win.resetInSec
  } else if (typeof win.resetsAt === 'string' && win.resetsAt.length > 0) {
    const ms = Date.parse(win.resetsAt)
    if (Number.isFinite(ms)) sec = Math.max(0, (ms - now) / 1000)
  }
  return resetParts(sec, en).join(en ? ' ' : '')
}

function errorTextOf(channel, locale) {
  const code = typeof channel.errorCode === 'string' ? channel.errorCode : ''
  if (isEn(locale)) return ERROR_TEXT_EN[code] !== undefined ? ERROR_TEXT_EN[code] : 'Fetch failed'
  if (typeof channel.message === 'string' && channel.message.length > 0) return channel.message
  return '取数失败'
}

/**
 * [0.11.2-alpha.7] 瞬时失败的 5 次宽限（与 Host `plans/quota-observer.js` 同一口径）。
 *
 * 原生面板拿到的是**投影后的 wire**：内置 provider 的失败 wire 基本不带 `transient`
 * （只有个别来源会标），所以不能再靠 `channel.transient === true` 决定要不要保留旧值——
 * 那正是「OpenCode Go 一次闪断就显示取数失败」的根因。
 *
 * 三态：
 *   - `cached`：未满 5 次且**有旧值** → 沿用旧数值与旧时间，灰化提示「暂时失败」；
 *   - `pending`：未满 5 次但**没有旧值**（首次失败 / 换了身份）→ 不编造数值，也不提前报失败；
 *   - `failed`：满 5 次，或失败类别为 P/A（配置/权限/身份过期）→ 立即显示固定错误，
 *     且**绝不**复用旧值。
 *
 * @param {object} channel 投影后的渠道（`availability === 'error'`）
 * @param {object|undefined} previousEntry 同一 carry 键下的上一轮记录
 * @returns {{ mode: 'cached'|'pending'|'failed', failCount: number }}
 */
function failureGraceOf(channel, previousEntry) {
  const entry = previousEntry !== null && previousEntry !== undefined && typeof previousEntry === 'object'
    ? previousEntry
    : null
  const rawCount = entry !== null && typeof entry.failCount === 'number' && Number.isFinite(entry.failCount)
    ? entry.failCount
    : 0
  const prevCount = rawCount > 0 ? Math.floor(rawCount) : 0
  const kind = classifyFailure(channel.errorCode, { transient: channel.transient === true })
  if (kind === FAIL_PERMANENT || kind === FAIL_EXPIRED) {
    // 封存：计数直接拉满，后续失败不会退回 cached。
    return { mode: 'failed', failCount: TEMPORARY_FAIL_LIMIT }
  }
  const count = Math.min(prevCount + 1, TEMPORARY_FAIL_LIMIT + 1000)
  if (count >= TEMPORARY_FAIL_LIMIT) return { mode: 'failed', failCount: count }
  if (entry !== null && entry.hasValues === true) return { mode: 'cached', failCount: count }
  return { mode: 'pending', failCount: count }
}

/** 渠道当前是否至少有一个可展示数值。 */
function hasValues(channel) {
  if (channel.unlimited === true) return true
  if (typeof channel.balance === 'number' && Number.isFinite(channel.balance)) return true
  return Array.isArray(channel.windows) && channel.windows.some((win) => typeof win.percent === 'number')
}

/** 启用中的内置渠道 id（保持 PLANS 原顺序，后面再按 planOrder 排序）。 */
function enabledPlanIds(cfg, plans) {
  const source = cfg !== null && typeof cfg === 'object' ? cfg : {}
  if (source.enabled === false) return []
  const out = []
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (plan === null || typeof plan !== 'object' || typeof plan.id !== 'string') continue
    if (CHANNEL_PRESENTATION[plan.id] === undefined) continue
    const field = plan.fields !== null && plan.fields !== undefined ? plan.fields.enabled : undefined
    if (field !== undefined && source[field] === false) continue
    out.push(plan.id)
  }
  return out
}

/**
 * 解析 `cfg.planOrder`。
 *
 * 真实配置里的值是 **JSON 字符串**（Config schema 是 `z.string().default('[]')`，
 * 内容是 `'["deepseek","mimo",…]'`），只有测试/旧快照里才直接是数组。
 * 口径与 `index.js` 的 `orderPlansByPlanOrder` 一致：只有非空字符串才尝试 `JSON.parse`，
 * 解析失败或不是数组时按空数组处理；再过滤非字符串/空串并去重（先出现者优先）。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parsePlanOrder(value) {
  let order = []
  if (Array.isArray(value)) order = value
  else if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) order = parsed
    } catch (err) { order = [] }
  }
  const out = []
  for (const item of order) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (out.indexOf(item) !== -1) continue
    out.push(item)
  }
  return out
}

/**
 * 渠道显示顺序：先按已保存的 `planOrder`，再按 `NATIVE_CHANNEL_ORDER` 兜底，
 * 仍未知的 id（例如自定义余额 `custom:xxx`）保持原相对顺序排最后。
 *
 * **必须同时接受数组与 JSON 字符串**：0.11.2-alpha.5 只认数组，
 * 于真实配置下视图骨架永远退回注册表顺序（原生「额度」面板渠道顺序错误）。
 *
 * @param {string[]} ids
 * @param {unknown} planOrder
 * @returns {string[]}
 */
function orderedIds(ids, planOrder) {
  const order = parsePlanOrder(planOrder)
  const rank = new Map()
  for (let i = 0; i < order.length; i += 1) rank.set(order[i], i)
  // 未登记的 id 按默认顺序追加在已保存顺序之后。
  for (let i = 0; i < NATIVE_CHANNEL_ORDER.length; i += 1) {
    const id = NATIVE_CHANNEL_ORDER[i]
    if (!rank.has(id)) rank.set(id, order.length + i)
  }
  const list = Array.isArray(ids) ? ids : []
  const decorated = list.map((id, index) => ({ id, index }))
  decorated.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return a.index - b.index
  })
  return decorated.map((item) => item.id)
}

/** 渠道要渲染哪些窗口：默认三个；`presentation.scopes` 显式声明时按它过滤。 */
function slotsFor(presentation) {
  const scopes = presentation !== null && presentation !== undefined && Array.isArray(presentation.scopes)
    ? presentation.scopes
    : null
  if (scopes === null) return WINDOW_SLOTS
  return WINDOW_SLOTS.filter((slot) => scopes.indexOf(slot.scope) !== -1)
}

function channelBlock(id, locale) {
  const presentation = CHANNEL_PRESENTATION[id]
  if (presentation === undefined) return null
  const en = isEn(locale)
  const base = 'data.channels.' + presentation.key
  const block = {
    type: 'stack',
    children: [{ type: 'text', text: '**' + presentation.name + '**' }],
  }
  if (presentation.kind === 'quota') {
    for (const slot of slotsFor(presentation)) {
      block.children.push({
        type: 'progress',
        label: en ? slot.en : slot.zh,
        value: binding(base + '.' + slot.field),
        caption: binding(base + '.' + slot.caption),
        // [0.11.2-alpha.8] 颜色只跟额度多少有关（不再随失败状态变 warn/bad）。
        tone: binding(base + '.barTone'),
      })
    }
  } else {
    const label = presentation.kind === 'credits' ? (en ? 'Credits' : '积分') : (en ? 'Balance' : '余额')
    // [0.11.2-alpha.8] 值对象带 tone：失败缓存期灰化数字（muted），正常态 null 回落默认色。
    block.children.push({
      type: 'keyValue',
      items: [{ label, value: binding(base + '.value'), tone: binding(base + '.valueTone') }],
    })
  }
  /**
   * [2026-11-17 用户要求] 不再单独渲染每个渠道的「更新 HH:MM」行——顶部已有一行。
   * 注意：不能只是把文本置空，App 对空 text 仍会占一整行；因此状态文案改为
   * 复用已有行（余额/积分行的值、或第一个窗口的说明），见 builtinChannelData。
   */
  return block
}

function actionsBlock(locale) {
  const en = isEn(locale)
  return {
    type: 'actions',
    items: [
      { label: en ? 'Refresh' : '刷新', action: 'refresh', icon: 'refresh', style: 'primary' },
      { label: en ? 'Settings' : '设置', action: 'settings', icon: 'settings' },
    ],
  }
}

/**
 * 生成原生面板视图（静态骨架 + 数据绑定）。
 *
 * @param {{ cfg?: object, plans?: Array, locale?: string, hasCustomChannels?: boolean }} [options]
 */
export function buildNativeView(options) {
  const opts = options !== null && options !== undefined ? options : {}
  const locale = typeof opts.locale === 'string' && opts.locale.length > 0 ? opts.locale : 'zh-CN'
  const en = isEn(locale)
  const cfg = opts.cfg !== null && typeof opts.cfg === 'object' ? opts.cfg : {}
  const plans = Array.isArray(opts.plans) ? opts.plans : []
  const enabled = enabledPlanIds(cfg, plans)
  const children = [{ type: 'text', text: binding('data.updated'), tone: 'muted' }]
  // 当前会话渠道标记（从 strip 打开时由 scope.sessionId 决定；未知时为空串）。
  children.push({ type: 'text', text: binding('data.sessionChannel'), tone: 'muted' })
  for (const id of orderedIds(enabled, cfg.planOrder)) {
    const block = channelBlock(id, locale)
    if (block !== null) children.push(block)
  }
  if (opts.hasCustomChannels === true) {
    children.push({ type: 'text', text: en ? '**Custom balances**' : '**自定义余额**' })
    children.push({ type: 'list', items: binding('data.customRows') })
  }
  children.push(actionsBlock(locale))
  return { type: 'stack', title: en ? 'Usage' : '额度', children }
}

/** 初始占位数据：面板刚打开、取数还没回来时避免整屏「—」。 */
export function placeholderPayload(locale) {
  return {
    updated: isEn(locale) ? 'Loading…' : '正在读取…',
    sessionChannel: '',
    channels: {},
    customRows: [],
  }
}

/** 全局停用时的数据。 */
export function disabledPayload(locale) {
  return {
    updated: isEn(locale) ? 'Usage dock is disabled' : '额度已停用',
    sessionChannel: '',
    channels: {},
    customRows: [],
  }
}

/** 读取包装值的安全解包（无 configEditor 的部署里 Config 字段可能是 {get()} 包装）。 */
function plainValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get() } catch (err) { return undefined }
  }
  return value
}

/** 当前 App 是否支持设置表单所需的 v2 组件（缺 caps 时按 v1 处理）。 */
function supportsSettingsForm(caps) {
  const components = caps !== null && caps !== undefined && Array.isArray(caps.components) ? caps.components : null
  if (components === null) return false
  return SETTINGS_FORM_COMPONENTS.every((name) => components.indexOf(name) !== -1)
}

/**
 * [0.11.0 整改] 视图控件节点允许从定义里**透传**的字段白名单（只放协议字段）。
 *
 * 旧实现只产 `type/label/bind[-/min/max/options]`，把 `def.onChange` 丢了 → 生成的 6 个
 * 额度策略 toggle 全都没有 onChange：用户切换既不即时保存、条件字段也不会展开（文档宣称
 * 的行为不成立）。这里用白名单而不是整对象展开，避免 `channel/scope/role` 这类内部元数据
 * 漏进视图（视图里出现未声明字段会被 App 渲染成灰块）。
 */
const CONTROL_PASSTHROUGH_KEYS = ['onChange', 'hint', 'disabled', 'placeholder']

function settingControl(def, locale) {
  const label = isEn(locale) ? def.en : def.zh
  const bind = 'data.form.' + def.field
  const extra = {}
  for (const key of CONTROL_PASSTHROUGH_KEYS) {
    if (def[key] !== undefined) extra[key] = def[key]
  }
  if (def.kind === 'toggle') return Object.assign({ type: 'toggle', label, bind }, extra)
  if (def.kind === 'number') return Object.assign({ type: 'number', label, bind, min: def.min, max: def.max }, extra)
  return Object.assign({ type: 'select', label, bind, options: def.options }, extra)
}

/** 单个渠道分组的展示顺序与固定字段。 */
const CHANNEL_SECTIONS = [
  // [0.11.4 用户要求] 设置页渠道顺序：DeepSeek → MiMo → WorkBuddy → Codex → OpenCode Go。
  // [0.11.4 用户要求] 原生额度面板不显示余额提醒，因此设置页也不再提供该输入。
  { id: 'deepseek', titleZh: 'DeepSeek', titleEn: 'DeepSeek', enabled: FIELD.deepseekEnabled, middle: [] },
  { id: 'mimo', titleZh: 'MiMo', titleEn: 'MiMo', enabled: FIELD.mimoEnabled, middle: [] },
  { id: 'workbuddy', titleZh: 'WorkBuddy', titleEn: 'WorkBuddy', enabled: FIELD.workbuddyEnabled, middle: [] },
  { id: 'codex', titleZh: 'Codex', titleEn: 'Codex', enabled: FIELD.codexEnabled, middle: [FIELD.codexSource] },
  { id: 'opencode-go', titleZh: 'OpenCode Go', titleEn: 'OpenCode Go', enabled: FIELD.opencodeGoEnabled, middle: [] },
]

/** 策略控件节点（windows 每个窗口一行两框；balance 一行两框 + 币种；credits 一行两框）。 */
function policyNodesFor(channelId, locale) {
  const en = isEn(locale)
  const defs = POLICY_CONTROL_DEFS.filter((def) => def.channel === channelId)
  if (defs.length === 0) return []
  const nodes = []
  const spec = POLICY_CHANNELS[channelId]
  if (spec.kind === 'toggle-only') return []
  if (spec.kind === 'windows') {
    const scopes = Array.isArray(spec.scopes) ? spec.scopes : POLICY_WINDOW_SCOPES.map((w) => w.scope)
    for (const win of POLICY_WINDOW_SCOPES) {
      if (!scopes.includes(win.scope)) continue
      const warn = defs.find((def) => def.scope === win.scope && def.role === 'warning')
      const close = defs.find((def) => def.scope === win.scope && def.role === 'closing')
      nodes.push({
        type: 'grid',
        // 用 grid 固定两列：row 在 form 里按「最宽子项」算列数，输入框最小宽度
        // 160dp 会把它压成一列；v2 style.columns 在部分 App 版本不生效。
        columns: 2,
        children: [
          settingControl(Object.assign({}, warn, { zh: win.zh + ' 预警%', en: win.en + ' warn %' }), locale),
          settingControl(Object.assign({}, close, { zh: win.zh + ' 收尾%', en: win.en + ' close %' }), locale),
        ],
      })
    }
    return nodes
  }
  const warn = defs.find((def) => def.role === 'warning')
  const close = defs.find((def) => def.role === 'closing')
  nodes.push({ type: 'grid', columns: 2, children: [settingControl(warn, locale), settingControl(close, locale)] })
  const currency = defs.find((def) => def.role === 'currency')
  // [0.11.4 用户要求] DeepSeek 余额固定为 CNY，不再提供币种选择。
  if (currency !== undefined && channelId !== 'deepseek' && channelId !== 'mimo') nodes.push(settingControl(currency, locale))
  return nodes
}

/**
 * [0.11.2] Codex 分组的「本地适配」节点（纯展示；按钮动作走 settingsActions.codexAdapt）。
 *
 * 由 Host 的 `codexAdaptStatusForNative()` 给出五态，这里只决定画什么：
 *   - `appliable`   → 说明 + 「一键适配」按钮 + 「需重启引擎」提示；
 *   - `pending`     → 只说「已适配，重启引擎后生效」，**不给**按钮（避免重复点按）；
 *   - `unsupported` → 说明已收录哪些版本，**不给**按钮（Host 同样会拒绝写入）；
 *   - 其它（hidden / 未知）→ 一个节点都不渲染。
 *
 * 已适配且能读到余额时 Host 返回 hidden —— 也就是「不显示一键适配按钮」。
 */
function codexAdaptNodes(adapt, locale) {
  const en = isEn(locale)
  if (adapt === null || adapt === undefined || typeof adapt !== 'object') return []
  const state = typeof adapt.state === 'string' ? adapt.state : ''
  const version = typeof adapt.version === 'string' && adapt.version.length > 0 ? adapt.version : null
  const manifestVersion = typeof adapt.manifestVersion === 'string' && adapt.manifestVersion.length > 0 ? adapt.manifestVersion : null
  const covered = Array.isArray(adapt.covered) ? adapt.covered.filter((item) => typeof item === 'string' && item.length > 0) : []
  if (state === 'appliable') {
    const text = version !== null
      ? (en
        ? 'dsh-codex-subscription ' + version + ' installed — one local adapt is needed to read its quota.'
        : '已装 dsh-codex-subscription ' + version + '，需要一次本地适配才能读订阅额度。')
      : (en
        ? 'Codex subscription quota needs a one-time local adapt on this device.'
        : 'Codex 订阅额度需要在本机做一次本地适配。')
    return [
      { type: 'text', text, tone: 'muted' },
      ...(adapt.auto === true && typeof adapt.autoFromVersion === 'string' && adapt.autoFromVersion.length > 0
        ? [{ type: 'text', tone: 'muted', text: en
          ? 'Anchors from ' + adapt.autoFromVersion + ' matched automatically; a backup is kept before adapting.'
          : '已按 ' + adapt.autoFromVersion + ' 的锚点自动匹配当前版本，适配前会先备份。' }]
        : []),
      { type: 'actions', items: [{ label: en ? 'Adapt' : '一键适配', action: 'codexAdapt', icon: 'wrench' }] },
      { type: 'text', text: en ? 'Takes effect after restarting the engine.' : '适配后需重启引擎生效。', tone: 'muted' },
    ]
  }
  if (state === 'pending') {
    return [{
      type: 'text',
      tone: 'muted',
      text: en ? 'Already adapted — restart the engine to take effect.' : '已适配，重启引擎后生效。',
    }]
  }
  if (state === 'unsupported') {
    let text
    if (version !== null && manifestVersion !== null && manifestVersion === version) {
      text = en
        ? version + ' is covered, but the installed file differs from the known baseline — one-click adapt is unavailable.'
        : version + ' 有清单，但本机文件与基线不一致，无法一键适配。'
    } else if (version !== null && covered.length > 0) {
      text = en
        ? 'No adapt manifest for ' + version + ' (covered: ' + covered.join(' / ') + ').'
        : version + ' 暂无适配清单（已收录：' + covered.join(' / ') + '）。'
    } else {
      text = en ? 'No adapt manifest for the installed version.' : '当前第三方插件版本暂无适配清单。'
    }
    return [{ type: 'text', text, tone: 'muted' }]
  }
  return []
}

/**
 * 原生设置面板视图：v2 表单，按渠道分组；策略输入只在「关注额度策略」打开时出现。
 * 老 App 没有 v2 组件时降级成只读说明，不影响额度面板使用。
 *
 * @param {{ caps?: object, locale?: string, cfg?: object,
 *   codexAdapt?: { state: string, version?: string|null, manifestVersion?: string|null, covered?: string[] } }} [options]
 *   `codexAdapt` 为 Host 的本地适配探测结果（见 index.js 的 `codexAdaptStatusForNative`）；
 *   缺省/非对象 ⇒ 不渲染适配入口（fail-closed）。
 */
export function buildSettingsView(options) {
  const opts = options !== null && options !== undefined ? options : {}
  const locale = typeof opts.locale === 'string' && opts.locale.length > 0 ? opts.locale : 'zh-CN'
  const en = isEn(locale)
  if (!supportsSettingsForm(opts.caps)) {
    return {
      type: 'stack',
      title: en ? 'Settings' : '设置',
      children: [
        {
          type: 'callout',
          tone: 'warn',
          text: en
            ? 'This App version cannot render native forms. Update DSH Go, or change settings in the Web settings page.'
            : '当前 App 版本不能渲染原生表单。请升级 DSH Go，或到网页版设置页修改。',
        },
        {
          type: 'text',
          tone: 'muted',
          text: en ? 'The usage panel keeps working.' : '额度面板不受影响，仍可正常使用。',
        },
      ],
    }
  }
  const cfg = opts.cfg !== null && typeof opts.cfg === 'object' ? opts.cfg : {}
  const focus = new Set(safeJsonArray(plainValue(cfg.quotaFocusChannels)))
  const policyMaster = plainValue(cfg.quotaPolicyEnabled) === true
  const groups = []

  const general = [{ type: 'text', text: '**' + (en ? 'General' : '通用') + '**' }, settingControl(FIELD.enabled, locale), settingControl(FIELD.quotaPolicyEnabled, locale)]
  if (policyMaster) {
    general.push(settingControl(FIELD.quotaTrustRouteOrder, locale))
    general.push({ type: 'text', text: en ? 'Quota policy only feeds hints to the model; it never changes quota.' : '额度策略只影响给模型的提示，不改变额度。', tone: 'muted' })
  }
  groups.push({ type: 'stack', children: general })

  for (const section of CHANNEL_SECTIONS) {
    const children = [{ type: 'text', text: '**' + (en ? section.titleEn : section.titleZh) + '**' }, settingControl(section.enabled, locale)]
    for (const def of section.middle) children.push(settingControl(def, locale))
    // [0.11.2] Codex 分组：紧跟在「额度来源」下面显示本地适配入口（需适配时才出现）。
    if (section.id === 'codex') children.push(...codexAdaptNodes(opts.codexAdapt, locale))
    children.push(settingControl(focusToggleDef(section.id), locale))
    if (focus.has(section.id)) children.push(...policyNodesFor(section.id, locale))
    groups.push({ type: 'stack', children })
  }

  return {
    v: 2,
    type: 'stack',
    title: en ? 'Settings' : '设置',
    children: [
      {
        type: 'callout',
        tone: 'info',
        text: en
          ? 'Changes take effect after saving; turning a policy switch on/off saves and refreshes right away. API keys, cookies and custom balances stay in the Web settings page.'
          : '修改后点保存生效；额度策略开关会即时保存并刷新表单。API Key、Cookie 和自定义余额仍在网页版设置页配置。',
      },
      {
        type: 'form',
        submit: 'save',
        submitLabel: en ? 'Save' : '保存',
        children: groups,
      },
      {
        type: 'text',
        tone: 'muted',
        text: en
          ? 'Saved to the same profile config as the Web settings page.'
          : '保存在 profile 配置里，与网页版设置页共用同一份配置。',
      },
    ],
  }
}

/** 从 quotaChannelThresholds 中取出某渠道条目（坏值安全）。 */
function policyEntryOf(thresholds, channelId) {
  const entry = thresholds !== null && typeof thresholds === 'object' ? thresholds[channelId] : undefined
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
}

/** 读取一个策略控件当前的配置值（缺省 0 / CNY）。 */
function policyValueOf(def, thresholds) {
  const entry = policyEntryOf(thresholds, def.channel)
  const spec = POLICY_CHANNELS[def.channel]
  let box = null
  if (spec.kind === 'windows') {
    box = entry.windows !== null && typeof entry.windows === 'object' ? entry.windows[def.scope] : null
  } else if (spec.kind === 'balance') {
    box = entry.balance !== null && typeof entry.balance === 'object' ? entry.balance : null
    if (def.role === 'currency') {
      return box !== null && typeof box.currency === 'string' && box.currency.length > 0 ? box.currency : 'CNY'
    }
  } else {
    box = entry.credits !== null && typeof entry.credits === 'object' ? entry.credits : null
  }
  if (box === null || typeof box !== 'object') return 0
  const value = box[def.role]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 设置面板数据：当前配置值（未配置时用 schema 默认值）。 */
export function buildSettingsData(cfg, options) {
  const source = cfg !== null && typeof cfg === 'object' ? cfg : {}
  const opts = options !== null && options !== undefined && typeof options === 'object' ? options : {}
  const form = {}
  const baseDefs = [
    FIELD.enabled, FIELD.quotaPolicyEnabled, FIELD.quotaTrustRouteOrder,
    FIELD.opencodeGoEnabled, FIELD.deepseekEnabled, FIELD.deepseekWarnThreshold,
    FIELD.codexEnabled, FIELD.codexSource, FIELD.mimoEnabled, FIELD.mimoWarnThreshold,
    FIELD.mimoRememberLogin, FIELD.workbuddyEnabled,
  ]
  for (const def of baseDefs) {
    const raw = plainValue(source[def.field])
    if (def.kind === 'toggle') {
      form[def.field] = typeof raw === 'boolean' ? raw : defaultSettingValue(def) === true
    } else if (def.kind === 'number') {
      form[def.field] = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultSettingValue(def)
    } else {
      form[def.field] = raw === 'subscription' ? 'subscription' : 'connect'
    }
  }
  const focus = safeJsonArray(plainValue(source.quotaFocusChannels))
  for (const channelId of Object.keys(FOCUS_FIELDS)) {
    form[FOCUS_FIELDS[channelId]] = focus.indexOf(channelId) !== -1
  }
  const thresholds = safeJsonObject(plainValue(source.quotaChannelThresholds)) || {}
  for (const def of POLICY_CONTROL_DEFS) form[def.field] = policyValueOf(def, thresholds)
  form.mimoStatus = typeof opts.mimoStatus === 'string' ? opts.mimoStatus : ''
  return { form }
}

/** 把一个渠道的策略输入合并进 JSON 条目；全为 0 时删掉该分支。返回新条目（可能为空对象）。 */
function mergePolicyChannel(channelId, form) {
  const spec = POLICY_CHANNELS[channelId]
  const defs = POLICY_CONTROL_DEFS.filter((def) => def.channel === channelId)
  if (spec.kind === 'windows') {
    const windows = {}
    const scopes = Array.isArray(spec.scopes) ? spec.scopes : POLICY_WINDOW_SCOPES.map((w) => w.scope)
    for (const win of POLICY_WINDOW_SCOPES) {
      if (!scopes.includes(win.scope)) continue
      const warn = form[defs.find((def) => def.scope === win.scope && def.role === 'warning').field]
      const close = form[defs.find((def) => def.scope === win.scope && def.role === 'closing').field]
      const box = {}
      if (warn > 0) box.warning = warn
      if (close > 0) box.closing = close
      if (Object.keys(box).length > 0) windows[win.scope] = box
    }
    return Object.keys(windows).length > 0 ? { windows } : null
  }
  const warnDef = defs.find((def) => def.role === 'warning')
  const closeDef = defs.find((def) => def.role === 'closing')
  const warn = warnDef !== undefined ? form[warnDef.field] : 0
  const close = closeDef !== undefined ? form[closeDef.field] : 0
  const box = {}
  if (warn > 0) box.warning = warn
  if (close > 0) box.closing = close
  if (Object.keys(box).length === 0) return null
  if (spec.kind === 'balance') {
    const currencyDef = defs.find((def) => def.role === 'currency')
    const currency = currencyDef !== undefined && typeof form[currencyDef.field] === 'string' && form[currencyDef.field].length > 0
      ? form[currencyDef.field]
      : 'CNY'
    return { balance: Object.assign(box, { currency }) }
  }
  return { credits: box }
}

/**
 * 校验并转换表单提交值。返回 `{ ok:true, patch, form }` 或 `{ ok:false, error }`。
 *
 * - 只有当前视图里实际渲染的字段会出现在 `event.value.values` 里；隐藏的策略输入
 *   （关注开关关闭）**不写入**，保留原配置。
 * - `patch` 只含非密钥字段；策略写回时合并 `quotaChannelThresholds`，保留其它渠道条目。
 */
export function parseSettingsInput(event, locale, cfg) {
  const en = isEn(locale)
  const source = cfg !== null && typeof cfg === 'object' ? cfg : {}
  const values = event !== null && event !== undefined && event.value !== null && event.value !== undefined
    && event.value.values !== null && typeof event.value.values === 'object'
    ? event.value.values
    : null
  if (values === null) return { ok: false, error: en ? 'No settings submitted' : '没有收到设置内容' }
  const patch = {}
  const form = {}
  for (const def of SETTINGS_CONTROLS) {
    const raw = values['data.form.' + def.field]
    // 未渲染（条件隐藏）的字段：不动，保留原配置。
    if (raw === undefined) continue
    if (def.kind === 'toggle') {
      if (typeof raw !== 'boolean') return { ok: false, error: (en ? 'Invalid toggle: ' : '开关值无效：') + def.field }
      form[def.field] = raw
      if (CONFIG_FIELD_NAMES.has(def.field)) patch[def.field] = raw
      continue
    }
    if (def.kind === 'number') {
      // 数字输入框清空时提交 null：阈值按「0 = 关闭」处理。
      if (raw === null) {
        form[def.field] = 0
        if (CONFIG_FIELD_NAMES.has(def.field)) patch[def.field] = 0
        continue
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, error: (en ? 'Invalid number: ' : '数字无效：') + def.field }
      }
      if (raw < def.min || raw > def.max) {
        return { ok: false, error: (en ? 'Out of range: ' : '超出范围：') + def.field }
      }
      form[def.field] = raw
      if (CONFIG_FIELD_NAMES.has(def.field)) patch[def.field] = raw
      continue
    }
    if (typeof raw !== 'string' || !def.options.some((option) => option.value === raw)) {
      return { ok: false, error: (en ? 'Invalid option: ' : '选项无效：') + def.field }
    }
    form[def.field] = raw
    if (CONFIG_FIELD_NAMES.has(def.field)) patch[def.field] = raw
  }

  // 收尾必须小于预警（成对出现时校验）。
  for (const channelId of Object.keys(POLICY_CHANNELS)) {
    const defs = POLICY_CONTROL_DEFS.filter((def) => def.channel === channelId)
    if (defs.every((def) => form[def.field] === undefined)) continue
    for (const win of (POLICY_CHANNELS[channelId].kind === 'windows' ? POLICY_WINDOW_SCOPES : [{ key: '', zh: '', en: '' }])) {
      const warnDef = defs.find((def) => def.role === 'warning' && (win.key === '' || def.scope === win.scope))
      const closeDef = defs.find((def) => def.role === 'closing' && (win.key === '' || def.scope === win.scope))
      const warn = warnDef !== undefined ? form[warnDef.field] : 0
      const close = closeDef !== undefined ? form[closeDef.field] : 0
      if (typeof warn === 'number' && typeof close === 'number' && warn > 0 && close > 0 && close >= warn) {
        return { ok: false, error: (en ? 'Closing must be lower than warning: ' : '收尾阈值必须小于预警阈值：') + (en ? win.en : win.zh) }
      }
    }
  }

  // 关注名单按 5 个开关重建（保留未知 id）。
  const builtinFocus = new Set(Object.keys(FOCUS_FIELDS))
  const focus = safeJsonArray(plainValue(source.quotaFocusChannels)).filter((id) => !builtinFocus.has(id))
  for (const channelId of Object.keys(FOCUS_FIELDS)) {
    if (form[FOCUS_FIELDS[channelId]] === true) focus.push(channelId)
  }
  patch.quotaFocusChannels = JSON.stringify(focus)

  // 只合并「本次视图中实际渲染」的渠道策略；未渲染的渠道保留原 JSON。
  const thresholds = safeJsonObject(plainValue(source.quotaChannelThresholds))
  const next = thresholds !== null ? Object.assign({}, thresholds) : {}
  let touched = false
  for (const channelId of Object.keys(POLICY_CHANNELS)) {
    const defs = POLICY_CONTROL_DEFS.filter((def) => def.channel === channelId)
    if (defs.every((def) => form[def.field] === undefined)) continue
    touched = true
    const merged = mergePolicyChannel(channelId, form)
    const existing = policyEntryOf(next, channelId)
    if (merged === null) {
      const keys = Object.keys(existing).filter((key) => key !== 'windows' && key !== 'balance' && key !== 'credits')
      if (keys.length > 0) {
        const kept = {}
        for (const key of keys) kept[key] = existing[key]
        next[channelId] = kept
      } else {
        delete next[channelId]
      }
    } else {
      next[channelId] = Object.assign({}, existing, merged)
    }
  }
  if (touched) patch.quotaChannelThresholds = Object.keys(next).length > 0 ? JSON.stringify(next) : ''

  return { ok: true, patch, form }
}

/** MiMo 登录固定错误码 → 人话（不把原始英文异常直接抛给用户）。 */
function mimoCodeText(code, locale) {
  const en = isEn(locale)
  const map = {
    E_MIMO_AUTH_UNAVAILABLE: en ? 'This host does not support scan login.' : '当前宿主不支持扫码登录。',
    E_MIMO_AUTH_SESSION_ACTIVE: en ? 'Another MiMo login is already running.' : '已有 MiMo 登录会话在进行中。',
    E_MIMO_AUTH_SESSION_MISSING: en ? 'The login session has gone.' : '登录会话不存在。',
    E_MIMO_AUTH_SESSION_EXPIRED: en ? 'The login session expired.' : '登录会话已过期。',
    E_MIMO_AUTH_FLOW: en ? 'The login flow failed.' : '登录流程失败。',
    E_MIMO_AUTH_QR_UNAVAILABLE: en ? 'QR code is not available yet.' : '二维码暂不可用。',
    E_MIMO_AUTH_TARGET_EXPIRED: en ? 'The QR code expired; request a new one.' : '二维码已过期，请重新获取。',
    E_MIMO_AUTH_CANCELLED: en ? 'Login cancelled.' : '登录已取消。',
    E_MIMO_AUTH_REJECTED: en ? 'This login was rejected.' : '这次登录被拒绝。',
    E_MIMO_CONSOLE_FLOW: en ? 'MiMo console login failed.' : 'MiMo 控制台登录失败。',
    E_SET_COOKIE_REJECTED: en
      ? 'The login cookies were rejected (official login domain may have changed).'
      : '登录返回的 Cookie 被安全校验拒绝（官方登录域可能又变了）。',
    E_URL_PURPOSE_MISMATCH: en
      ? 'The official login address failed the host check.'
      : '官方登录地址未通过域名校验。',
  }
  if (typeof code === 'string' && map[code] !== undefined) return map[code]
  return (en ? 'Login failed: ' : '登录失败：') + (typeof code === 'string' && code.length > 0 ? code : 'unknown')
}

/** 余额展示（登录完成时如果 Host 顺带读到余额就显示出来）。 */
function mimoBalanceLine(balance, locale) {
  if (balance === null || balance === undefined || typeof balance !== 'object') return ''
  const value = typeof balance.balance === 'number' ? balance.balance : null
  if (value === null) return ''
  const amount = amountText(value, balance.currency, null, locale)
  return amount === null ? '' : (isEn(locale) ? 'Balance: ' : '余额：') + amount
}

/** MiMo 扫码登录面板视图（静态骨架 + 数据绑定）。 */
export function buildMimoLoginView(options) {
  const opts = options !== null && options !== undefined ? options : {}
  const locale = typeof opts.locale === 'string' && opts.locale.length > 0 ? opts.locale : 'zh-CN'
  const en = isEn(locale)
  return {
    type: 'stack',
    title: en ? 'MiMo login' : 'MiMo 登录',
    children: [
      { type: 'callout', text: binding('data.note'), tone: binding('data.tone') },
      { type: 'text', text: binding('data.status') },
      { type: 'image', src: binding('data.qr'), alt: en ? 'QR code' : '二维码', aspect: 1 },
      { type: 'text', text: binding('data.hint'), tone: 'muted' },
      {
        type: 'actions',
        items: [
          { label: en ? 'New QR code' : '重新获取二维码', action: 'restart', icon: 'refresh', style: 'primary' },
          { label: en ? 'Cancel' : '取消', action: 'cancel', icon: 'clear' },
        ],
      },
    ],
  }
}


/** 进度条 caption：把「具体剩余百分比」和重置时间一起显示（否则只有轨道、看不出剩余多少）。 */
function windowCaption(percent, resetText, locale) {
  const en = isEn(locale)
  const head = typeof percent === 'number' && Number.isFinite(percent)
    ? (en ? percent + '% left' : '剩余 ' + percent + '%')
    : ''
  if (head.length > 0 && resetText.length > 0) return head + ' · ' + resetText
  return head.length > 0 ? head : resetText
}

function windowsOf(channel, locale, now) {
  const out = {}
  for (const win of Array.isArray(channel.windows) ? channel.windows : []) {
    const slot = WINDOW_SLOTS.find((item) => item.scope === win.scope)
    if (slot === undefined) continue
    const percent = typeof win.percent === 'number' && Number.isFinite(win.percent)
      ? Math.round(win.percent * 10) / 10
      : null
    out[slot.field] = percent
    out[slot.caption] = windowCaption(percent, resetCountdown(win, locale, now), locale)
  }
  return out
}

/**
 * [0.11.0 整改] carry（暂时失败保留旧值）的隔离键 = 渠道 id + **来源身份**。
 *
 * 身份由 Host 投影在 wire 上给出（`identity`，短指纹：来源/账号/Key 变化即变）。旧实现只按
 * `channel.id` 缓存，Codex 从 Connect 切到 Subscription 后仍会复用 Connect 的旧百分比。
 * 身份缺失（旧 Host / 未知渠道）⇒ 返回 null ⇒ **不复用** carry（fail-closed，不猜）。
 *
 * 只在本进程内部做键，**不**写进 data / snapshot.channels / 行文本。
 */
function carryKeyOf(channelId, identity) {
  if (typeof channelId !== 'string' || channelId.length === 0) return null
  if (typeof identity !== 'string' || identity.length === 0) return null
  return channelId + '|' + identity
}

/**
 * [0.11.0 整改] `wires` →「渠道 id → 来源身份」。`projectUsage` 的白名单不投影 identity
 * （避免进入模型输出/视图），所以 carry 的隔离键在这里从**原始 wire** 取；若将来投影层
 * 直接带上 `channel.identity`，调用处会优先用它。
 */
function identityMapOf(wires) {
  const map = new Map()
  if (!Array.isArray(wires)) return map
  for (const wire of wires) {
    if (wire === null || wire === undefined || typeof wire !== 'object') continue
    const id = typeof wire.id === 'string' ? wire.id : ''
    const identity = typeof wire.identity === 'string' ? wire.identity : ''
    if (id.length === 0 || identity.length === 0) continue
    if (!map.has(id)) map.set(id, identity)
  }
  return map
}

/**
 * [0.11.2-alpha.8] 进度条颜色只由**剩余额度**决定（用户要求）。
 *
 * 取当前展示的各窗口剩余百分比的最小值：≤10 危险、≤30 注意、否则正常；
 * 没有任何可判定的百分比（取数失败且无缓存 / 未知）→ `muted`。
 *
 * 关键点：**不再**因为「取数失败」把颜色改成 warn/bad。缓存显示旧值时用的是
 * 旧 windows，所以额度多的时候颜色保持正常（旧实现会把进度条染成黄褐色）。
 *
 * @param {object|null} windows `windowsOf()` 的输出（槽位字段 → 百分比）
 * @returns {'good'|'warn'|'bad'|'muted'}
 */
export function barToneOf(windows) {
  if (windows === null || windows === undefined || typeof windows !== 'object') return 'muted'
  let min = null
  for (const slot of WINDOW_SLOTS) {
    const value = windows[slot.field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (min === null || value < min) min = value
  }
  if (min === null) return 'muted'
  if (min <= 10) return 'bad'
  if (min <= 30) return 'warn'
  return 'good'
}

/** 单个内置渠道的展示值（含暂时失败时的旧值回退）。 */
function builtinChannelData(channel, presentation, locale, previous, now, identity) {
  const en = isEn(locale)
  const carryKey = carryKeyOf(channel.id, identity)
  const previousEntry = carryKey !== null && previous !== null && previous !== undefined && typeof previous === 'object'
    ? previous[carryKey]
    : undefined
  let amount = null
  let windows = null
  let note
  let tone = 'good'
  let clock = clockOf(typeof channel.fetchedAt === 'number' ? channel.fetchedAt : now)
  /** 连续暂时失败次数；成功后归零。随 carry 传给下一轮做 5 次宽限。 */
  let failCount = 0
  /** [0.11.2-alpha.8] 数值颜色：失败缓存期只灰化数字，不显示任何失败文案。 */
  let valueTone = null

  if (channel.availability === 'error') {
    /**
     * [0.11.2-alpha.7] 瞬时失败宽限：前 4 次沿用旧值（cached），没有旧值时 pending，
     * 第 5 次或 P/A 类错误才 failed。不再依赖 `channel.transient`（内置 provider 不带它）。
     */
    const grace = failureGraceOf(channel, previousEntry)
    failCount = grace.failCount
    if (grace.mode === 'cached' && previousEntry !== undefined && previousEntry !== null) {
      amount = previousEntry.amount
      windows = previousEntry.windows
      // [0.11.2-alpha.8] 前 4 次失败不显示文案，只把数字灰化。
      note = ''
      tone = 'warn'
      valueTone = 'muted'
      clock = previousEntry.clock
    } else if (grace.mode === 'pending') {
      note = ''
      tone = 'warn'
      valueTone = 'muted'
    } else {
      note = errorTextOf(channel, locale)
      tone = 'bad'
    }
  } else if (channel.availability === 'unavailable') {
    amount = amountText(channel.balance, channel.currency, channel.unit, locale)
    windows = windowsOf(channel, locale, now)
    note = en ? 'Account unavailable' : '账户当前不可用'
    tone = 'warn'
  } else if (channel.availability === 'unknown') {
    note = en ? (ERROR_TEXT_EN[channel.errorCode] !== undefined ? ERROR_TEXT_EN[channel.errorCode] : 'Status unknown') : (channel.message || '状态未知')
    tone = 'info'
  } else {
    if (channel.unlimited === true) amount = en ? 'Unlimited' : '不限量'
    else amount = amountText(channel.balance, channel.currency, channel.unit, locale)
    windows = windowsOf(channel, locale, now)
    /**
     * [2026-11-17 用户要求] 正常态**不再逐条显示更新时间**：面板顶部已经有
     * 一行「更新 HH:MM」，每个渠道下方再来一行纯属重复。这里留空，
     * 只有失败/不可用/未知这类**需要逐条说明**的状态才写文字。
     */
    note = ''
    tone = 'good'
  }

  // [0.11.2-alpha.8] barTone 只按显示中的额度算（缓存时即旧额度）；valueTone 只在缓存失败时灰化数字。
  const data = { note, tone, barTone: barToneOf(windows), valueTone }
  if (presentation.kind === 'quota') {
    for (const slot of WINDOW_SLOTS) {
      const source = windows !== null && windows[slot.field] !== undefined ? windows[slot.field] : null
      data[slot.field] = source
      data[slot.caption] = windows !== null && windows[slot.caption] !== undefined ? windows[slot.caption] : ''
    }
    // 没有窗口数据（失败/不可用/未知）时，把状态文案放到第一行说明里，避免另起一行。
    if (windows === null && note !== '') data[WINDOW_SLOTS[0].caption] = note
  } else {
    data.amount = amount
    // 值列：有金额就用金额，没有就显示状态文案（原来那一行的位置不变）。
    data.value = amount !== null && amount !== undefined ? amount : (note !== '' ? note : null)
  }

  const line = presentation.kind === 'quota'
    ? quotaSummaryLine(channel.name, data, note, locale)
    : balanceSummaryLine(channel.name, data.amount, note, locale)

  return {
    data,
    line,
    carry: {
      clock,
      hasValues: amount !== null || (windows !== null && WINDOW_SLOTS.some((slot) => typeof windows[slot.field] === 'number')),
      amount,
      windows,
      failCount,
    },
  }
}

function quotaSummaryLine(name, data, note, locale) {
  const en = isEn(locale)
  const parts = []
  for (const slot of WINDOW_SLOTS) {
    const value = data[slot.field]
    if (typeof value === 'number') parts.push((en ? slot.en : slot.zh) + (en ? ' ' : ' ') + value + '%')
  }
  const detail = typeof note === 'string' ? note : ''
  if (parts.length === 0) return detail.length > 0 ? name + '：' + detail : name
  return name + '：' + parts.join('，') + (detail.length > 0 ? '（' + detail + '）' : '')
}

function balanceSummaryLine(name, amount, note, locale) {
  const value = typeof amount === 'string' && amount.length > 0 ? amount : note
  return name + '：' + value
}

/** 自定义余额渠道 → 原生 `list` 行。 */
function customRowOf(channel, locale, previous, identity) {
  const en = isEn(locale)
  const carryKey = carryKeyOf(channel.id, identity)
  const previousEntry = carryKey !== null && previous !== null && previous !== undefined && typeof previous === 'object'
    ? previous[carryKey]
    : undefined
  let trailing = null
  let tone = 'good'
  let note = en ? 'Updated ' : '更新 '
  /** 连续暂时失败次数（成功后归零）；与内置渠道共用同一套 5 次宽限。 */
  let failCount = 0
  /** carry 里是否有真正可复用的余额（错误态下只有 cached 才有）。 */
  let hasCarryValues = false
  if (channel.availability === 'error') {
    const grace = failureGraceOf(channel, previousEntry)
    failCount = grace.failCount
    if (grace.mode === 'cached' && previousEntry !== undefined && previousEntry !== null) {
      trailing = previousEntry.amount
      hasCarryValues = true
      // [0.11.2-alpha.8] 前 4 次失败不显示文案，只把金额灰化。
      tone = 'muted'
      note = ''
    } else if (grace.mode === 'pending') {
      // [0.11.2-alpha.8] 前 4 次失败不显示文案，只把金额灰化。
      tone = 'muted'
      note = ''
    } else {
      trailing = errorTextOf(channel, locale)
      tone = 'bad'
      note = '取数失败'
    }
  } else if (channel.availability === 'unavailable') {
    trailing = amountText(channel.balance, channel.currency, channel.unit, locale)
    hasCarryValues = trailing !== null && trailing !== undefined
    tone = 'warn'
    note = en ? 'Account unavailable' : '账户当前不可用'
  } else if (channel.availability === 'unknown') {
    tone = 'info'
    note = en ? 'Status unknown' : '状态未知'
  } else {
    trailing = amountText(channel.balance, channel.currency, channel.unit, locale)
    hasCarryValues = trailing !== null && trailing !== undefined
  }
  const row = {
    title: typeof channel.name === 'string' && channel.name.length > 0 ? channel.name : '自定义余额',
    subtitle: en ? 'Balance' : '余额',
    tone,
    action: 'refresh',
  }
  if (trailing !== null && trailing !== undefined) row.trailing = trailing
  const line = row.title + '：' + (trailing !== null && trailing !== undefined ? trailing : note)
  return {
    row,
    line,
    carry: {
      clock: clockOf(Date.now()),
      // [0.11.2-alpha.7] cached 时也必须为 true，否则下一轮会把旧余额当成「没有值」丢掉。
      hasValues: hasCarryValues,
      amount: hasCarryValues ? trailing : null,
      windows: null,
      failCount,
    },
  }
}

/**
 * 把一次采集得到的 wire 列表投影成原生面板数据。
 *
 * @param {{
 *   cfg?: object, plans?: Array, semanticsOf?: Function, wires?: Array,
 *   customEntries?: Array, locale?: string, now?: number, previous?: object,
 * }} [options]
 * @returns {{ data: object, snapshot: object }}
 */
export function buildNativeData(options) {
  const opts = options !== null && options !== undefined ? options : {}
  const locale = typeof opts.locale === 'string' && opts.locale.length > 0 ? opts.locale : 'zh-CN'
  const en = isEn(locale)
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const cfg = opts.cfg !== null && typeof opts.cfg === 'object' ? opts.cfg : {}
  const plans = Array.isArray(opts.plans) ? opts.plans : []
  const customEntries = Array.isArray(opts.customEntries) ? opts.customEntries : []
  const previous = opts.previous !== null && opts.previous !== undefined && typeof opts.previous === 'object'
    ? opts.previous
    : {}
  const semanticsOf = typeof opts.semanticsOf === 'function' ? opts.semanticsOf : () => 'used'
  const wires = Array.isArray(opts.wires) ? opts.wires : []

  const data = { updated: '', channels: {}, customRows: [] }
  const snapshot = { at: now, clock: clockOf(now), disabled: false, channels: [], previous: {} }

  if (cfg.enabled === false) {
    const disabled = disabledPayload(locale)
    snapshot.disabled = true
    return { data: disabled, snapshot }
  }

  const builtinEnabled = enabledPlanIds(cfg, plans)
  const customEnabled = []
  const known = new Set()
  for (const plan of plans) {
    if (plan !== null && plan !== undefined && typeof plan.id === 'string') known.add(plan.id)
  }
  for (const entry of customEntries) {
    if (entry === null || entry === undefined || typeof entry.id !== 'string') continue
    known.add(entry.id)
    if (entry.enabled !== false) customEnabled.push(entry.id)
  }
  const enabledSet = new Set(builtinEnabled.concat(customEnabled))
  const requested = []
  for (const wire of wires) {
    if (wire === null || wire === undefined || typeof wire.id !== 'string') continue
    if (!enabledSet.has(wire.id)) continue
    if (requested.indexOf(wire.id) !== -1) continue
    requested.push(wire.id)
  }
  /**
   * [0.11.2-alpha.6] 快照顺序与视图骨架共用同一个 `orderedIds`：
   * planOrder（JSON 字符串）优先 + NATIVE_CHANNEL_ORDER 兜底。
   * alpha.5 在这里另写了一套只认 NATIVE_CHANNEL_ORDER 的硬编码排序，
   * 于是数据顺序和视图顺序可能不一致。
   */
  const orderedRequested = orderedIds(requested, cfg.planOrder)
  const projected = projectUsage(wires, orderedRequested, { enabled: enabledSet, known, semanticsOf })
  // [0.11.0 整改] carry 的身份映射：从原始 wire 取（投影白名单不含 identity）。
  const identityById = identityMapOf(wires)

  /**
   * 原始 wire 里带着 MiMo 的「缺失原因」枚举（`mimoState`），投影层不保留它。
   * 首屏/恢复尚未完成时用它区分「正在读取」与「确实没登录」，避免把读取中写成缺数据。
   */
  const mimoWireState = (() => {
    for (const wire of wires) {
      if (wire !== null && wire !== undefined && wire.id === 'mimo' && typeof wire.mimoState === 'string') return wire.mimoState
    }
    return null
  })()

  for (const channel of projected.channels) {
    const identity = typeof channel.identity === 'string' && channel.identity.length > 0
      ? channel.identity
      : (identityById.has(channel.id) ? identityById.get(channel.id) : null)
    const presentation = CHANNEL_PRESENTATION[channel.id]
    if (presentation !== undefined) {
      const built = builtinChannelData(channel, presentation, locale, previous, now, identity)
      if (channel.id === 'mimo' && mimoWireState === 'pending' && built.data.amount === null) {
        // 登录态还在恢复（首次打开面板常见）：显示读取中，而不是「没有数据」。
        built.data.value = isEn(locale) ? 'Reading…' : '正在读取…'
        built.data.tone = 'info'
      }
      data.channels[presentation.key] = built.data
      snapshot.channels.push(built.line)
      const key = carryKeyOf(channel.id, identity)
      if (key !== null) snapshot.previous[key] = built.carry
    } else {
      const custom = customRowOf(channel, locale, previous, identity)
      data.customRows.push(custom.row)
      snapshot.channels.push(custom.line)
      const key = carryKeyOf(channel.id, identity)
      if (key !== null) snapshot.previous[key] = custom.carry
    }
  }

  if (requested.length === 0) {
    data.updated = en ? 'No channels enabled' : '没有启用的渠道'
  } else {
    data.updated = (en ? 'Updated ' : '更新 ') + snapshot.clock
  }
  return { data, snapshot }
}

/**
 * 注册原生面板（额度 + 设置）。
 *
 * 只有装了 dsh-go 桥接的主机会回 `ctx.inject(['dshGo'])`（与技能要求一致：写 `['dshGo']`，
 * 不要写可选依赖语法、也不要放进插件顶层 inject）。其它主机上回调永不执行，Web 半不受影响。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{
 *   plans?: Array, semanticsOf?: Function,
 *   loadConfig: () => Promise<object>,
 *   collect: (cfg: object) => Promise<Array>,
 *   customEntries?: (cfg: object) => Array,
 *   saveConfig?: (patch: object) => Promise<void>,
 *   onConfigReload?: (fn: Function) => (Function | null),
 * }} deps
 */
export function registerDshGoSurface(ctx, deps) {
  const state = { disposers: [] }
  const options = deps !== null && deps !== undefined && typeof deps === 'object' ? deps : {}
  if (ctx !== null && ctx !== undefined && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['dshGo'], (hostCtx) => {
        try {
          const service = hostCtx !== null && hostCtx !== undefined ? hostCtx.dshGo : undefined
          if (service === null || service === undefined || typeof service.panel !== 'function') return
          // 让宿主知道「原生桥接真的存在」（额度策略的轻量后台刷新只在这种主机上启动）。
          if (typeof options.onBridge === 'function') {
            try { options.onBridge(service) } catch (err) { /* 回调失败不影响面板 */ }
          }
          const surfaces = createSurface(options)
          const register = (id, surface) => {
            const dispose = service.panel(id, surface)
            if (typeof dispose === 'function') state.disposers.push(dispose)
          }
          register(PANEL_ID, surfaces.quota)
          register(SETTINGS_PANEL_ID, surfaces.settings)
          // composer.strip：输入框上方一行「当前会话渠道」摘要。
          //
          // 注意：检查器/宿主可能在 `apply()` 还没跑完时就来订阅 strip；此时 index.js 里
          // 的 strip 数据函数尚未完成初始化（const TDZ：Cannot access 'subscribeStrip'
          // before initialization）。用一个 microtask 把首次订阅推迟到 apply 结束后，
          // 期间保持「隐藏」；取消函数同步可用。
          if (typeof service.strip === 'function' && typeof options.strip === 'function') {
            const stripDispose = service.strip(STRIP_ID, (scope, emit, caps) => {
              let inner = null
              let stopped = false
              Promise.resolve().then(() => {
                if (stopped) return
                try {
                  inner = options.strip(scope, emit, caps)
                                  } catch (err) {
                                    try { emit(null) } catch (err2) { /* 已断开 */ }
                }
              }).catch(() => {})
              return () => {
                stopped = true
                if (typeof inner === 'function') {
                  try { inner() } catch (err) { /* 已清理 */ }
                }
              }
            })
            if (typeof stripDispose === 'function') state.disposers.push(stripDispose)
          }
        } catch (err) {
          // 原生面板注册失败只影响 App；Web 半继续工作。
        }
      })
    } catch (err) {
      // 没有 inject 能力（非 Cordis 宿主）：不注册原生面板，返回空操作 disposer。
    }
  }
  return {
    dispose: () => {
      while (state.disposers.length > 0) {
        const dispose = state.disposers.pop()
        try { dispose() } catch (err) { /* 已卸载 */ }
      }
    },
  }
}

function createSurface(deps) {
  const loadConfig = typeof deps.loadConfig === 'function' ? deps.loadConfig : async () => ({})
  const collect = typeof deps.collect === 'function' ? deps.collect : async () => []
  const listCustom = typeof deps.customEntries === 'function' ? deps.customEntries : () => []
  const sessionChannelLabel = typeof deps.sessionChannelLabel === 'function' ? deps.sessionChannelLabel : null
  const debugLog = typeof deps.debug === 'function' ? deps.debug : null
  const mimoSessionBalance = typeof deps.mimoSessionBalance === 'function' ? deps.mimoSessionBalance : null
  const dbg = (line) => { if (debugLog !== null) { try { debugLog(line) } catch (err) { /* 忽略 */ } } }
  /** 面板请求超时：宿主 handler 挂住时宁可报错，也不要永远停在旧画面。 */
  const withTimeout = (promise, ms, label) => {
    let timer = null
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
                    reject(Object.assign(new Error('E_REQUEST_TIMEOUT'), { code: 'E_REQUEST_TIMEOUT' }))
        }, ms)
        if (timer !== null && typeof timer.unref === 'function') timer.unref()
      }),
    ]).finally(() => { if (timer !== null) clearTimeout(timer) })
  }
  const plans = Array.isArray(deps.plans) ? deps.plans : []
  const semanticsOf = typeof deps.semanticsOf === 'function' ? deps.semanticsOf : () => 'used'
  const saveConfig = typeof deps.saveConfig === 'function' ? deps.saveConfig : null
  const onConfigReload = typeof deps.onConfigReload === 'function' ? deps.onConfigReload : null
  const mimoAuth = deps.mimoAuth !== null && deps.mimoAuth !== undefined && typeof deps.mimoAuth === 'object'
    ? deps.mimoAuth
    : null
  /** [0.11.2] Codex Subscription 本地适配：状态探测（异步、只读）与一次性应用。 */
  const codexAdapt = typeof deps.codexAdapt === 'function' ? deps.codexAdapt : null
  const codexAdaptApply = typeof deps.codexAdaptApply === 'function' ? deps.codexAdaptApply : null

  let locale = 'zh-CN'
  let lastSnapshot = null
  let kick = null
  /** MiMo 登录面板的控制句柄（面板 data 启动时挂上，关闭/取消时摘除）。 */
  let mimoControl = null

  // ── 额度面板 ────────────────────────────────────────────────────────────

  const quotaView = async (scope, caps) => {
    locale = localeOf(caps)
    let cfgNow = null
    try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
    let customEntries = []
    try { customEntries = listCustom(cfgNow) } catch (err) { customEntries = [] }
    return buildNativeView({
      cfg: cfgNow,
      plans,
      locale,
      hasCustomChannels: Array.isArray(customEntries) && customEntries.length > 0,
    })
  }

  const quotaData = (scope, emit) => {
    let stopped = false
    let timer = null
    let running = false
    const run = () => {
      if (stopped || running) return
      running = true
      Promise.resolve().then(async () => {
        let payload
        try {
          let cfgNow = null
          try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
          if (cfgNow !== null && cfgNow !== undefined && cfgNow.enabled === false) {
            payload = disabledPayload(locale)
          } else {
            let wires = []
            try { wires = await collect(cfgNow) } catch (err) { wires = [] }
            let customEntries = []
            try { customEntries = listCustom(cfgNow) } catch (err) { customEntries = [] }
            const built = buildNativeData({
              cfg: cfgNow,
              plans,
              semanticsOf,
              wires,
              customEntries,
              locale,
              previous: lastSnapshot !== null ? lastSnapshot.previous : null,
              now: Date.now(),
            })
            lastSnapshot = built.snapshot
            payload = built.data
            if (typeof sessionChannelLabel === 'function') {
              try { payload.sessionChannel = sessionChannelLabel(scope !== null && scope !== undefined ? scope.sessionId : undefined, locale) } catch (err) { payload.sessionChannel = '' }
            }
          }
        } catch (err) {
          payload = placeholderPayload(locale)
        } finally {
          running = false
        }
        if (!stopped) {
          lastQuotaPayload = payload
          try { emit(payload) } catch (err) { /* 取消/断开时桥接会拒绝 */ }
        }
      })
    }
    kick = run
    /** [0.11.4 用户要求] 打开面板先显示上次缓存的数据，再在后台取新数据。 */
    if (lastQuotaPayload !== null) {
      try { emit(lastQuotaPayload) } catch (err) { /* 首帧失败不致命 */ }
    } else {
      try { emit(placeholderPayload(locale)) } catch (err) { /* 首帧失败不致命 */ }
    }
    run()
    timer = setInterval(run, REFRESH_INTERVAL_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    return () => {
      stopped = true
      kick = null
      if (timer !== null) clearInterval(timer)
      timer = null
    }
  }

  const quotaActions = {
    refresh: (scope, event) => {
      const loc = localeOfEvent(event, locale)
      if (typeof kick === 'function') kick()
      return { toast: isEn(loc) ? 'Refreshing…' : '正在刷新…' }
    },
    // [0.11.0] 面板底部「设置」→ 打开本插件的原生设置面板（清单里已声明 settings）。
    settings: () => ({ open: 'panel:' + SETTINGS_PANEL_ID }),
  }

  // ── 设置面板 ────────────────────────────────────────────────────────────

  const settingsView = async (scope, caps) => {
    locale = localeOf(caps)
    let cfgNow = null
    try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
    /**
     * [0.11.2] 每次重建视图都重新探测一次本地适配状态：点过「一键适配」后 App 会
     * `refresh` 重建视图，于是按钮变成「已适配，重启引擎后生效」；引擎重启后服务出现，
     * 状态变 hidden，按钮自然消失。
     */
    let adapt = null
    if (codexAdapt !== null) {
      try { adapt = await codexAdapt() } catch (err) { adapt = null }
    }
    // 策略开关是即时保存后再 refresh 视图的，所以这里必须按当前配置重建分组。
    return buildSettingsView({ caps, locale, cfg: cfgNow, codexAdapt: adapt })
  }

  const settingsData = (scope, emit) => {
    let stopped = false
    const push = () => {
      if (stopped) return
      Promise.resolve().then(async () => {
        let cfgNow = null
        try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
        if (stopped) return
        try { emit(buildSettingsData(cfgNow, { mimoStatus: mimoStatusText() })) } catch (err) { /* 取消/断开 */ }
      })
    }
    push()
    let off = null
    if (onConfigReload !== null) {
      try { off = onConfigReload(push) } catch (err) { off = null }
    }
    return () => {
      stopped = true
      if (typeof off === 'function') {
        try { off() } catch (err) { /* 已取消 */ }
      }
    }
  }

  const settingsActions = {
    save: (scope, event) => {
      const loc = localeOfEvent(event, locale)
      if (saveConfig === null) return { toast: isEn(loc) ? 'Settings are read-only on this host' : '当前主机不能保存设置' }
      // 写盘 + loader 重载可能超过 3 秒：用延后结果，避免丢失点击手势。
      // 额度策略要合并进现有 JSON，必须先把当前配置读出来再解析（所以校验也放在延后结果里）。
      return {
        pending: { label: isEn(loc) ? 'Saving…' : '正在保存…', timeoutMs: 15000 },
        result: async () => {
          let cfgNow = null
          try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
          const parsed = parseSettingsInput(event, loc, cfgNow)
          if (!parsed.ok) return { toast: parsed.error }
          try {
            await saveConfig(parsed.patch)
          } catch (err) {
            return { toast: isEn(loc) ? 'Save failed' : '保存失败' }
          }
          return { toast: isEn(loc) ? 'Saved' : '已保存', patch: { form: parsed.form } }
        },
      }
    },
  }

  /** MiMo 登录可用性（显示在设置页底部）。 */
  const mimoStatusText = () => {
    if (mimoAuth === null) return isEn(locale) ? 'MiMo login: bridge unavailable' : 'MiMo 登录：桥接不可用'
    let status = null
    try { status = mimoAuth.status() } catch (err) { status = null }
    if (status !== null && status.supported === true) return isEn(locale) ? 'MiMo login: available' : 'MiMo 登录：可用'
    const code = status !== null && typeof status.code === 'string' && status.code.length > 0 ? status.code : 'E_MIMO_AUTH_UNAVAILABLE'
    return (isEn(locale) ? 'MiMo login: unavailable (' : 'MiMo 登录：不可用（') + code + '）'
  }

  settingsActions.mimoLogin = () => ({ open: 'panel:' + MIMO_PANEL_ID })

  /**
   * [0.11.2] 「一键适配」：调用 Host 的 `applyCodexPatchOnce()`（与网页版 POST 路由、CLI
   * 同一实现：wx 备份 → 临时文件 → 读回校验 → rename → 校验新哈希）。
   *
   * 写完立刻 `refresh` 重建设置视图，让按钮变成「已适配，重启引擎后生效」；
   * 失败只回固定文案，不回显错误码/路径/上游正文。
   */
  settingsActions.codexAdapt = async (scope, event) => {
    const loc = localeOfEvent(event, locale)
    if (codexAdaptApply === null) {
      return { toast: isEn(loc) ? 'This host cannot apply it' : '当前主机无法执行适配' }
    }
    let out = null
    try { out = await codexAdaptApply() } catch (err) { out = null }
    if (out === null || out === undefined) return { toast: isEn(loc) ? 'Adapt failed, try again later' : '适配失败，请稍后重试' }
    if (out.ok !== true) {
      const code = typeof out.code === 'string' ? out.code : ''
      return {
        toast: code === 'E_CS_PATCH_UNSUPPORTED'
          ? (isEn(loc) ? 'This version cannot be adapted' : '该版本暂不支持一键适配')
          : (isEn(loc) ? 'Adapt failed, try again later' : '适配失败，请稍后重试'),
      }
    }
    return {
      refresh: true,
      toast: isEn(loc) ? 'Adapted — restart the engine to take effect' : '已适配，重启引擎后生效',
    }
  }

  /**
   * 额度策略开关的 onChange：即时写入配置并请求 App 重建视图，
   * 这样「打开关注开关 → 出现阈值输入 / 关闭 → 收起」是实时的。
   * 视图由 Host 按已保存配置生成，所以必须保存成功后再 refresh。
   */
  settingsActions.policyToggle = async (scope, event) => {
    const bind = event !== null && event !== undefined && event.value !== null && event.value !== undefined
      ? event.value.bind
      : undefined
    const value = event !== null && event !== undefined && event.value !== null && event.value !== undefined
      ? event.value.value
      : undefined
    if (typeof bind !== 'string' || typeof value !== 'boolean') return null
    const field = bind.indexOf('data.form.') === 0 ? bind.slice('data.form.'.length) : bind
    if (saveConfig === null) return null
    try {
      if (field === 'quotaPolicyEnabled') {
        await saveConfig({ quotaPolicyEnabled: value })
      } else {
        const channelId = Object.keys(FOCUS_FIELDS).find((id) => FOCUS_FIELDS[id] === field)
        if (channelId === undefined) return null
        let cfgNow = null
        try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
        const source = cfgNow !== null && typeof cfgNow === 'object' ? cfgNow : {}
        // [0.11.0 整改] 只增删**本次切换的 channelId**，其它关注项原样保留
        // （含 codex/mimo 等其它内置渠道、自定义渠道 `custom:*` 以及未知 id）。
        // 旧实现用「当前视图渲染的关注项」当全集重写，切一次 DeepSeek 就会静默删掉 codex/mimo。
        const seen = new Set()
        const focus = []
        for (const id of safeJsonArray(plainValue(source.quotaFocusChannels))) {
          if (typeof id !== 'string' || id.length === 0) continue
          if (id === channelId || seen.has(id)) continue
          seen.add(id)
          focus.push(id)
        }
        if (value === true) focus.push(channelId)
        await saveConfig({ quotaFocusChannels: JSON.stringify(focus) })
      }
    } catch (err) {
      return null
    }
    return { refresh: true }
  }

  // ── MiMo 扫码登录面板 ─────────────────────────────────────────────────────
  //
  // 直接调用 Host 已注册在 connection.fetch 上的 auth / qr handler（同进程，不过 HTTP）：
  //   capability(GET) → start → begin → 轮询 status；hasQr 时一次性取 QR（PNG → data URL）。
  // 动态审批（approvalId）只在 long-poll 场景出现，原生面板不提供批准控件，只提示去网页版。

  const mimoData = (scope, emit) => {
    let stopped = false
    let timer = null
    let busy = false
    let lastQr = ''
    const session = { bootEpoch: null, ticketId: null, generation: null, qrTaken: false, balanceSkipped: false }

    const emitSafe = (payload) => {
      if (stopped) return
      try { emit(payload) } catch (err) { /* 取消/断开 */ }
    }
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const fail = (code, diagnostic) => {
      clearTimer()
      const cookieCodes = diagnostic !== null && diagnostic !== undefined && Array.isArray(diagnostic.cookieCodes)
        ? diagnostic.cookieCodes.filter((item) => typeof item === 'string')
        : []
      const credential = diagnostic !== null && diagnostic !== undefined && typeof diagnostic.field === 'string'
        ? { field: diagnostic.field, reason: typeof diagnostic.reason === 'string' ? diagnostic.reason : 'unknown' }
        : null
      const network = diagnostic !== null && diagnostic !== undefined && typeof diagnostic.networkCode === 'string'
        ? { step: typeof diagnostic.step === 'string' ? diagnostic.step : 'unknown', code: diagnostic.networkCode }
        : null
      const urlCheck = diagnostic !== null && diagnostic !== undefined && typeof diagnostic.rejectedPurpose === 'string'
        ? {
          purpose: diagnostic.rejectedPurpose,
          reason: typeof diagnostic.rejectedReason === 'string' ? diagnostic.rejectedReason : 'unknown',
          hostClass: typeof diagnostic.hostClass === 'string' ? diagnostic.hostClass : 'other',
        }
        : null
      emitSafe({
        status: isEn(locale) ? 'Login unavailable' : '无法完成登录',
        note: mimoCodeText(code, locale),
        tone: 'warn',
        qr: lastQr,
        hint: cookieCodes.length > 0
          ? (isEn(locale) ? 'Cookie reject reason: ' : 'Cookie 拒绝原因：') + cookieCodes.join(', ')
          : credential !== null
          ? (isEn(locale) ? 'Bad credential field: ' : '凭据字段异常：') + credential.field + ' · ' + credential.reason
          : network !== null
          ? (isEn(locale) ? 'Network error: ' : '网络错误：') + network.step + ' · ' + network.code
          : urlCheck !== null
          ? (isEn(locale) ? 'Login URL check: ' : '登录地址校验：') + urlCheck.purpose + ' · ' + urlCheck.reason + ' · ' + urlCheck.hostClass
          : '',
      })
    }
    const cancelHostSession = () => {
      if (mimoAuth === null || typeof session.ticketId !== 'string' || session.bootEpoch === null) return Promise.resolve()
      const body = {
        action: 'cancel',
        bootEpoch: session.bootEpoch,
        ticketId: session.ticketId,
        generation: session.generation,
      }
      return Promise.resolve()
        .then(() => mimoAuth.request('auth', body))
        .catch(() => null)
    }

    let loggedState = ''
    let pollCount = 0
    const pollOnce = async () => {
      if (stopped || busy) return
      busy = true
      try {
        const reply = await withTimeout(mimoAuth.request('auth', {
          action: 'status',
          bootEpoch: session.bootEpoch,
          ticketId: session.ticketId,
          generation: session.generation,
        }), 20_000, 'mimo-status')
        const statusBody = reply !== null && reply.body !== null && reply.body !== undefined ? reply.body : null
        pollCount += 1
        const stateLabel = String(statusBody !== null ? (statusBody.state ?? statusBody.code ?? '') : 'null')
        if (stateLabel !== loggedState || pollCount % 6 === 1) {
          loggedState = stateLabel
                  }
        const body = reply !== null && reply.body !== null && typeof reply.body === 'object' ? reply.body : null
        if (body === null || body.ok !== true) { fail(body !== null && typeof body.code === 'string' ? body.code : 'E_MIMO_AUTH_FLOW'); return }
        const state = typeof body.state === 'string' ? body.state : ''
        // legacy 流程读余额后会等界面确认（约 100 秒超时）；原生面板没有确认控件，
        // 直接回 later 表示「稍后再说」，让流程立即完成，不再让用户空等。
        if (state === 'running' && body.awaitingBalanceMatch === true && session.balanceSkipped !== true) {
          session.balanceSkipped = true
          try {
            await withTimeout(mimoAuth.request('auth', {
              action: 'confirm',
              bootEpoch: session.bootEpoch,
              ticketId: session.ticketId,
              generation: session.generation,
              verdict: 'later',
            }), 10_000, 'mimo-confirm')
          } catch (err) { /* 忽略：让下一次轮询决定 */ }
          emitSafe({
            status: isEn(locale) ? 'Signed in, reading balance…' : '已登录，正在读取余额…',
            note: '',
            tone: 'info',
            qr: lastQr,
            hint: '',
          })
        }
        if (state === 'done') {
          clearTimer()
          emitSafe({
            status: isEn(locale) ? 'Signed in' : '登录完成',
            note: mimoBalanceLine(body.balance, locale),
            tone: 'good',
            qr: lastQr,
            hint: isEn(locale) ? 'Close this panel and reopen the usage panel.' : '可以返回额度面板查看 MiMo 余额。',
          })
          return
        }
        if (state === 'failed' || state === 'expired' || state === 'cancelled' || state === 'disposed') {
          const failure = body.failure !== null && typeof body.failure === 'object' ? body.failure : null
          const code = failure !== null && typeof failure.code === 'string' && failure.code.length > 0
            ? failure.code
            : (typeof body.failureCode === 'string' && body.failureCode.length > 0 ? body.failureCode : 'E_MIMO_AUTH_FLOW')
          fail(code, failure !== null ? failure.diagnostic : null)
          return
        }
        if (body.hasQr === true && session.qrTaken !== true) {
          session.qrTaken = true
          const qr = await withTimeout(mimoAuth.request('qr', {
            bootEpoch: session.bootEpoch,
            ticketId: session.ticketId,
            generation: session.generation,
          }), 20_000, 'mimo-qr')
          if (qr !== null && qr.ok === true && qr.bytes !== undefined) {
            lastQr = 'data:' + (typeof qr.mime === 'string' ? qr.mime : 'image/png') + ';base64,' + Buffer.from(qr.bytes).toString('base64')
          }
        }
        const waitingApproval = typeof body.approvalId === 'string' && body.approvalId.length > 0
        const remainingSec = statusBody !== null && typeof statusBody.remainingMs === 'number'
          ? statusBody.remainingMs / 1000
          : null
        // 二维码过期：宿主会一直停在 running 等回执；直接告诉用户而不是「卡住」。
        if (state === 'running' && remainingSec !== null && remainingSec <= 0) {
          clearTimer()
          emitSafe({
            status: isEn(locale) ? 'QR code expired' : '二维码已过期',
            note: isEn(locale) ? 'The login window ended before the scan was confirmed.' : '登录窗口已结束（未在有效期内完成扫码确认）。',
            tone: 'warn',
            qr: lastQr,
            hint: isEn(locale) ? 'Tap “New QR code” and scan again.' : '点「重新获取二维码」后重新扫描。',
          })
          return
        }
        const expiringSoon = state === 'running' && remainingSec !== null && remainingSec > 0 && remainingSec < 45
        const status = state === 'running'
          ? (lastQr.length > 0
            ? (isEn(locale) ? 'Scan with the MiMo app' : '请用 MiMo App 扫码登录')
            : (isEn(locale) ? 'Preparing QR code…' : '正在准备二维码…'))
          : (isEn(locale) ? 'Waiting…' : '等待中…')
        emitSafe({
          status,
          note: '',
          tone: 'info',
          qr: lastQr,
          hint: waitingApproval
            ? (isEn(locale) ? 'This login needs an approval in the Web settings page.' : '这次登录需要在网页版设置页批准后才能继续。')
            : expiringSoon
            ? (isEn(locale) ? 'The QR code expires soon; scan now.' : '二维码即将过期，请尽快扫描。')
            : '',
        })
        if (waitingApproval) return
        timer = setTimeout(() => { void pollOnce() }, 2000)
        if (timer !== null && typeof timer.unref === 'function') timer.unref()
      } catch (err) {
                fail(err !== null && err !== undefined && err.code === 'E_REQUEST_TIMEOUT' ? 'E_REQUEST_TIMEOUT' : 'E_MIMO_AUTH_FLOW')
      } finally {
        busy = false
      }
    }

    const startFlow = async () => {
      clearTimer()
      lastQr = ''
      session.bootEpoch = null
      session.ticketId = null
      session.generation = null
      session.qrTaken = false
      session.balanceSkipped = false
      // 本引擎里已经完成过 legacy 扫码登录：直接显示已有余额，不重新出二维码。
      if (mimoSessionBalance !== null) {
        let existing = null
        try { existing = mimoSessionBalance() } catch (err) { existing = null }
        if (existing !== null && existing.balance !== null && typeof existing.balance.balance === 'number') {
          emitSafe({
            status: isEn(locale) ? 'Signed in' : '已登录',
            note: (isEn(locale) ? 'Balance: ' : '余额：') + '¥' + Number(existing.balance.balance).toFixed(2),
            tone: 'good',
            qr: '',
            hint: isEn(locale) ? 'Tap “New QR code” to sign in with another account.' : '要换账号可点「重新获取二维码」。',
          })
          return
        }
      }
      if (mimoAuth === null) { fail('E_MIMO_AUTH_UNAVAILABLE'); return }
      let capability = null
      try { capability = mimoAuth.status() } catch (err) { capability = null }
      if (capability === null || capability.supported !== true) {
        fail(capability !== null && typeof capability.code === 'string' ? capability.code : 'E_MIMO_AUTH_UNAVAILABLE')
        return
      }
      emitSafe({ status: isEn(locale) ? 'Requesting QR code…' : '正在获取二维码…', note: '', tone: 'info', qr: '', hint: '' })
      const cap = await withTimeout(mimoAuth.request('auth', null), 20_000, 'mimo-cap')
      const capBody = cap !== null && cap.body !== null ? cap.body : null
      if (capBody === null || capBody.ok !== true || capBody.supported !== true) { fail(capBody !== null && typeof capBody.code === 'string' ? capBody.code : 'E_MIMO_AUTH_UNAVAILABLE'); return }
      if (typeof capBody.bootEpoch !== 'string') { fail('E_MIMO_AUTH_UNAVAILABLE'); return }
      session.bootEpoch = capBody.bootEpoch
      const started = await withTimeout(mimoAuth.request('auth', { action: 'start', bootEpoch: session.bootEpoch }), 20_000, 'mimo-start')
      const startBody = started !== null && started.body !== null ? started.body : null
      if (startBody === null || startBody.ok !== true || typeof startBody.ticketId !== 'string' || typeof startBody.generation !== 'number') {
        fail(startBody !== null && typeof startBody.code === 'string' ? startBody.code : 'E_MIMO_AUTH_FLOW', startBody !== null ? startBody.diagnostic : null)
        return
      }
      session.ticketId = startBody.ticketId
      session.generation = startBody.generation
      const begun = await withTimeout(mimoAuth.request('auth', {
        action: 'begin',
        bootEpoch: session.bootEpoch,
        ticketId: session.ticketId,
        generation: session.generation,
      }), 20_000, 'mimo-begin')
      const beginBody = begun !== null && begun.body !== null ? begun.body : null
      if (beginBody === null || beginBody.ok !== true) { fail(beginBody !== null && typeof beginBody.code === 'string' ? beginBody.code : 'E_MIMO_AUTH_FLOW', beginBody !== null ? beginBody.diagnostic : null); return }
      await pollOnce()
    }

    mimoControl = {
      restart: () => { void cancelHostSession().then(() => startFlow()) },
      cancel: () => { void cancelHostSession() },
    }
    void startFlow()
    return () => {
      stopped = true
      mimoControl = null
      clearTimer()
      void cancelHostSession()
    }
  }

  const mimoView = async (scope, caps) => {
    locale = localeOf(caps)
    return buildMimoLoginView({ locale })
  }

  return {
    quota: { view: quotaView, data: quotaData, actions: quotaActions },
    settings: { view: settingsView, data: settingsData, actions: settingsActions },
    mimo: {
      view: mimoView,
      data: mimoData,
      actions: {
        restart: () => {
          if (mimoControl !== null) mimoControl.restart()
          return { toast: isEn(locale) ? 'Requesting a new QR code…' : '正在重新获取二维码…' }
        },
        cancel: () => {
          if (mimoControl !== null) mimoControl.cancel()
          return { toast: isEn(locale) ? 'Cancel requested' : '已请求取消' }
        },
      },
    },
  }
}
