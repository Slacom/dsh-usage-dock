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
/**
 * [2026-11-23 Codex 只保留本插件 ChatGPT 账号登录] 原生设置页**不再**提供「额度来源」下拉：
 * `connect` / `subscription` 两个来源已退场，来源不再是用户可选项，登录/切换账户都在网页版
 * 设置页完成。因此这里也不再 import `normalizeCodexSource`（那只是旧来源值的归一函数）。
 *
 * [2026-11-22 教训] 曾经因为原生页只认 `'subscription'`、其余一律回 `'connect'`，把已保存的
 * `account` 显示成 connect，用户一点保存就静默改回了来源。删除字段是比「再写一套归一」更
 * 安全的收口：没有这个控件，就不会有「保存时改写用户意图」。
 */

/** 面板 id；`package.json` 的 `dshGo.contributes.panels` 必须与之一致。 */
export const PANEL_ID = 'quota'
/** composer.strip 的 id（跨插槽唯一；面板仍叫 quota）。 */
const STRIP_ID = 'strip'

/**
 * [0.11.0] 原生设置面板 id。额度面板底部的「设置」按钮用 `{ open: 'panel:settings' }` 打开它；
 * 清单里单独声明（placement: plugin），因此 App 的插件详情页也能直达。
 */
export const SETTINGS_PANEL_ID = 'settings'

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
}

/**
 * [0.11.2-alpha.6] 原生默认顺序：DeepSeek → MiMo → Codex → OpenCode Go。
 *
 * 设置页的 `CHANNEL_SECTIONS` 同序；`cfg.planOrder` 非空时以**已保存顺序**为准，
 * 这里只做兜底——用户从没拖过顺序（`planOrder` 缺省 / `'[]'` / 坏 JSON）时，
 * 面板按这个顺序出现，不再退回 `plans/index.js` 的注册表顺序。
 *
 * [2026-11-23] 已退场的积分类渠道已从原生半移除（以后改由用户自建「自定义余额渠道」添加），
 * 因此不在本顺序里。
 */
export const NATIVE_CHANNEL_ORDER = ['deepseek', 'mimo', 'codex', 'opencode-go']

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
}

const FOCUS_FIELDS = {
  'opencode-go': 'policyOpencodeFocus',
  deepseek: 'policyDeepseekFocus',
  codex: 'policyCodexFocus',
  mimo: 'policyMimoFocus',
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
  mimoEnabled: { field: 'mimoEnabled', kind: 'toggle', zh: 'MiMo', en: 'MiMo' },
  mimoWarnThreshold: { field: 'mimoWarnThreshold', kind: 'number', min: 0, max: 100000, zh: '余额提醒（元，0 = 关闭）', en: 'Balance alert (CNY, 0 = off)' },
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
  focusToggleDef('codex'),
  FIELD.mimoEnabled,
  FIELD.mimoWarnThreshold,
  focusToggleDef('mimo'),
].concat(POLICY_CONTROL_DEFS)

/** 直接写回配置的字段：普通渠道字段 + 策略总开关 + 路由观察授权。 */
const CONFIG_FIELD_NAMES = new Set([
  'enabled', 'opencodeGoEnabled', 'deepseekEnabled', 'deepseekWarnThreshold',
  'codexEnabled', 'mimoEnabled', 'mimoWarnThreshold',
  'quotaPolicyEnabled', 'quotaTrustRouteOrder',
])

/** 与 Config schema 的默认值保持一致（读不到配置时的兜底）。 */
const SETTINGS_DEFAULTS = {
  enabled: true,
  opencodeGoEnabled: true,
  deepseekEnabled: true,
  deepseekWarnThreshold: 10,
  codexEnabled: true,
  mimoEnabled: true,
  mimoWarnThreshold: 10,
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

/* ──────────────────────────────────────────────────────────────────────────────
 * ChatGPT 账户列表（原生设置页只做「查看 + 选择」，登录/退出仍在网页版设置页）
 *
 * 设计（2026-11-24 用户定稿）：
 *   - 原生插件设置页**不提供**添加账户 / 退出账号 / 复制代码 / 打开登录页 / 取消登录；
 *     这些能力全部保留在网页版设置页（`client.js#CodexAccountBlock`）；
 *   - 原生页只在 Codex 分组里放一个**账号列表**：显示已登录可用的账号，
 *     点一行即把该账号设为当前（`codexAccountSelect`）；
 *   - 列表用 `list` + `data.codexAccountRows` 绑定：账号增减、当前账号变化都会随数据刷新，
 *     不需要重建视图；
 *   - 没登录 / 状态读不到时，列表退化成一条**不可点**的说明行，不显示点了必然失败的按钮。
 *
 * 硬边界：
 *   - 输入只有 Host 的白名单投影（`codexAccountStateWireOf`），不含 token / 明文账号 id；
 *   - 文案全部固定短语，不回显异常原文；
 *   - 没有桥接（检查器 / 老宿主）时 `codexAccount` 为 `null` ⇒ 视图退回原静态说明。
 * ────────────────────────────────────────────────────────────────────────────── */

/** 账户 id 形状：与 Host `index.js#CODEX_ACCOUNT_ID_PATTERN`、客户端、plans/codex-account.js 同一套。 */
const CODEX_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/u

/** 列表最多显示多少个账户（与 Host 的 `MAX_CODEX_ACCOUNTS_WIRE = 8` 一致）。 */
const CODEX_ACCOUNT_ROW_LIMIT = 8

/** Codex 订阅类型显示名（Host 给的是小写 `planType`；与 Web 半同一张表）。 */
const CODEX_ACCOUNT_PLAN_LABELS = {
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
  free: 'Free',
}

/** 账户列表的固定文案（zh / en）。 */
const CODEX_ACCOUNT_STRINGS = {
  zh: {
    sectionTitle: '账户',
    signedOut: '未登录',
    signedOutHint: '在网页版设置页登录 ChatGPT 账号',
    unavailable: '登录状态无法读取',
    unavailableHint: '请稍后在网页版设置页处理',
    current: '当前',
    chooseAccount: '选择额度来源账号',
    select: '设为当前',
    selectOk: '已切换账户',
    selectFailed: '切换账户失败，请稍后再试。',
    badId: '账户标识无效，请刷新后重试。',
  },
  en: {
    sectionTitle: 'Account',
    signedOut: 'Not signed in',
    signedOutHint: 'Sign in to ChatGPT on the Web settings page',
    unavailable: 'Account status unavailable',
    unavailableHint: 'Try again later on the Web settings page',
    current: 'Current',
    chooseAccount: 'Select quota source account',
    select: 'Set as current',
    selectOk: 'Account switched',
    selectFailed: 'Could not switch account; try again later.',
    badId: 'Invalid account id; refresh and try again.',
  },
}

function codexAccountStrings(locale) {
  return isEn(locale) ? CODEX_ACCOUNT_STRINGS.en : CODEX_ACCOUNT_STRINGS.zh
}

/** 账户 id 形状校验：非法一律 null（不猜目标）。 */
function codexAccountIdOf(raw) {
  return typeof raw === 'string' && CODEX_ACCOUNT_ID_PATTERN.test(raw) ? raw : null
}

/** 展示文本白名单：只接受字符串，去掉控制字符并截断；其它一律空串。 */
function codexAccountTextOf(raw, max) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  const limit = typeof max === 'number' && max > 0 ? max : 320
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned
}

/** 订阅类型显示名：已知值查表，未知值首字母大写后原样展示。 */
function codexAccountPlanLabelOf(raw) {
  const text = codexAccountTextOf(raw, 40)
  if (text.length === 0) return ''
  const known = CODEX_ACCOUNT_PLAN_LABELS[text.toLowerCase()]
  if (known !== undefined) return known
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * 账号选择器的数据（**纯函数**，供视图绑定与测试共用）。
 *
 * 用户定稿（2026-11-24 第二版）：
 *   - 界面上是**一个折叠框**：收起时只显示当前账号的邮箱；
 *   - 点开框 → 展开所有可用账号；点某个账号 → 收起并显示该账号邮箱。
 *
 * @param {object|null} state `codexAccountStateWireOf()` 的输出；null = 读不到 / 无桥接。
 * @param {string} [locale]
 * @returns {{
 *   currentLabel: string,
 *   options: Array<{ label: string, value: string, description?: string }>,
 *   selected: string,
 * }}
 */
export function codexAccountOptionsOf(state, locale) {
  const text = codexAccountStrings(locale)
  const source = state !== null && state !== undefined && typeof state === 'object' ? state : null
  if (source === null) {
    return { currentLabel: text.unavailable, options: [], selected: '' }
  }
  if (source.configured !== true) {
    return { currentLabel: text.signedOut, options: [], selected: '' }
  }
  const activeAccountId = codexAccountIdOf(source.activeAccountId)
  const options = []
  let currentLabel = ''
  for (const raw of Array.isArray(source.accounts) ? source.accounts : []) {
    if (options.length >= CODEX_ACCOUNT_ROW_LIMIT) break
    if (raw === null || raw === undefined || typeof raw !== 'object') continue
    const id = codexAccountIdOf(raw.id)
    if (id === null) continue
    const label = codexAccountTextOf(raw.label, 120)
    const plan = codexAccountPlanLabelOf(raw.planType !== undefined ? raw.planType : raw.plan)
    const shown = (label.length > 0 ? label : text.signedOut) + (plan.length > 0 ? ' · ' + plan : '')
    // [2026-11-24 用户要求] 选中态由 App 的对勾表示，**不再**输出「当前/已选」文字。
    if ((raw.active === true || id === activeAccountId) && currentLabel.length === 0) {
      currentLabel = label.length > 0 ? label : shown
    }
    options.push({ label: shown, value: id })
  }
  if (options.length === 0) {
    return { currentLabel: text.signedOut, options: [], selected: '' }
  }
  const selected = activeAccountId !== null && options.some((o) => o.value === activeAccountId)
    ? activeAccountId
    : (options[0] !== undefined ? options[0].value : '')
  if (currentLabel.length === 0) {
    const hit = options.find((o) => o.value === selected)
    currentLabel = hit !== undefined ? String(hit.label).split(' · ')[0] : text.signedOut
  }
  return { currentLabel, options, selected }
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
  // [2026-11-23] 原生设置页渠道顺序：DeepSeek → MiMo → Codex → OpenCode Go。
  // [0.11.4 用户要求] 原生额度面板不显示余额提醒，因此设置页也不再提供该输入。
  { id: 'deepseek', titleZh: 'DeepSeek', titleEn: 'DeepSeek', enabled: FIELD.deepseekEnabled, middle: [] },
  { id: 'mimo', titleZh: 'MiMo', titleEn: 'MiMo', enabled: FIELD.mimoEnabled, middle: [] },
  /**
   * [2026-11-23] Codex 分组只剩开关：`connect` / `subscription` 来源退场，「额度来源」下拉与
   * 「一键适配」按钮均已下线（见 `buildSettingsView` 里的静态说明）。
   */
  { id: 'codex', titleZh: 'Codex', titleEn: 'Codex', enabled: FIELD.codexEnabled, middle: [] },
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
 * 原生设置面板视图：v2 表单，按渠道分组；策略输入只在「关注额度策略」打开时出现。
 * 老 App 没有 v2 组件时降级成只读说明，不影响额度面板使用。
 *
 * [2026-11-23] Codex「本地适配」入口**已下线**：Subscription 来源退场后，那个「一键适配」
 * （给第三方 dsh-codex-subscription 打本地只读补丁）不再有意义 —— 原生设置页既没有来源可选，
 * 也没有订阅额度可读。Host 侧的写入口（同一路径下的 `POST` 应用接口与两个适配回调）也已
 * 整体删除（R3 2026-11-25），只剩只读的 `GET …/patch-state` 供维护/诊断；任何视图/动作都不再
 * 把它暴露给用户。
 *
 * @param {{
 *   caps?: object, locale?: string, cfg?: object,
 *   codexAccount?: object|null,
 * }} [options]
 *   `codexAccount` 是 `codexAccountStateWireOf()` 的输出（**原始 state wire**）：
 *   **省略 / null** ⇒ 保持旧的静态说明（无桥接 / 检查器）；
 *   有值 ⇒ 在 Codex 分组里插入「账户」列表（`list` + `data.codexAccountRows` 绑定）。
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
  /**
   * [2026-11-24 原生设置页 ChatGPT 账户] 只有 Host 真的给了桥接模型才渲染账户块：
   * `codexAccount === null/undefined`（检查器、老宿主、apply 提前返回）⇒ 保持原静态说明。
   */
  const codexAccount = opts.codexAccount !== null && opts.codexAccount !== undefined
    && typeof opts.codexAccount === 'object'
    ? opts.codexAccount
    : null
  /**
   * [2026-11-24] 折叠框依赖 v2 的 `collapsible` + `options` 组件；老 App 没有这两样时
   * 退回原来的静态说明（不渲染半截控件，也不影响其它设置项）。
   */
  const capsComponents = opts.caps !== null && opts.caps !== undefined && Array.isArray(opts.caps.components)
    ? opts.caps.components
    : []
  const supportsAccountPicker = capsComponents.indexOf('collapsible') !== -1 && capsComponents.indexOf('options') !== -1
  const focus = new Set(safeJsonArray(plainValue(cfg.quotaFocusChannels)))
  const policyMaster = plainValue(cfg.quotaPolicyEnabled) === true
  const groups = []

  const general = [{ type: 'text', text: '**' + (en ? 'General' : '通用') + '**' }, settingControl(FIELD.enabled, locale), settingControl(FIELD.quotaPolicyEnabled, locale)]
  if (policyMaster) {
    general.push(settingControl(FIELD.quotaTrustRouteOrder, locale))
  }
  // [2026-11-24 用户要求] 通用分组末尾也加横线：与第一个渠道（DeepSeek）区分开。
  general.push({ type: 'divider' })
  groups.push({ type: 'stack', children: general })

  for (const section of CHANNEL_SECTIONS) {
    /**
     * [2026-11-24 用户要求] 不再单独渲染渠道标题：开关本身的 label 就是渠道名，
     * 上一版「Codex」标题 + 「Codex」开关重复显示，看起来冗余。
     */
    const children = [settingControl(section.enabled, locale)]
    for (const def of section.middle) children.push(settingControl(def, locale))
    /**
     * [2026-11-24 ChatGPT 账户 · 用户定稿] 原生设置页**只做「查看 + 选择」**：
     *   - 添加账户 / 退出账号 / 重新登录全部保留在**网页版设置页**（那里已有完整 UI）；
     *   - 这里只在 Codex 分组里放一个账号列表：显示已登录可用的账号，点一行 = 设为当前；
     *   - 列表是 `list` + `data.codexAccountRows` 绑定：账号增减、当前账号变化都会随数据刷新；
     *   - 没有桥接（检查器 / 老宿主）时退回原来的静态说明。
     */
    if (section.id === 'codex') {
      if (codexAccount === null) {
        children.push({
          type: 'text',
          tone: 'muted',
          text: en
            ? 'The ChatGPT account is signed in and switched on the Web settings page.'
            : 'ChatGPT 账号在网页版设置登录/切换。',
        })
      } else if (supportsAccountPicker) {
        // [2026-11-24 第二版] 折叠框：收起只显示当前账号邮箱，点开显示全部账号。
        children.push({
          type: 'collapsible',
          // [2026-11-24 用户要求] 标题固定为「选择额度来源账号」，不再显示当前账号；
          // 自动收起在真机上不生效（App 的 collapsible 不受数据控制），先不做。
          label: codexAccountStrings(locale).chooseAccount,
          children: [
            {
              type: 'options',
              id: 'codexAccountSelect',
              options: binding('data.codexAccountOptions'),
              selected: binding('data.codexAccountSelected'),
            },
          ],
        })
      } else {
        children.push({
          type: 'text',
          tone: 'muted',
          text: en
            ? 'The ChatGPT account is signed in and switched on the Web settings page.'
            : 'ChatGPT 账号在网页版设置登录/切换。',
        })
      }
    }
    children.push(settingControl(focusToggleDef(section.id), locale))
    if (focus.has(section.id)) children.push(...policyNodesFor(section.id, locale))
    // [2026-11-24 用户要求] 每个渠道末尾一条横线，区分相邻渠道。
    children.push({ type: 'divider' })
    groups.push({ type: 'stack', children })
  }

  const children = [
    {
      type: 'form',
      submit: 'save',
      submitLabel: en ? 'Save' : '保存',
      children: groups,
    },
  ]
  return {
    v: 2,
    type: 'stack',
    title: en ? 'Settings' : '设置',
    children,
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

/**
 * 设置面板数据：当前配置值（未配置时用 schema 默认值）。
 *
 * @param {object} cfg 当前配置
 * @param {{ codexAccount?: object|null, locale?: string }} [options]
 *   `codexAccount` 是 `codexAccountStateWireOf()` 的输出（缺省 ⇒ 列表退化成一条「未登录」说明行）。
 */
export function buildSettingsData(cfg, options) {
  const source = cfg !== null && typeof cfg === 'object' ? cfg : {}
  const opts = options !== null && options !== undefined && typeof options === 'object' ? options : {}
  const form = {}
  /**
   * [2026-11-23] 这里只剩开关与数字阈值：`codexSource` 下拉已随 `connect` / `subscription`
   * 退场而删除，读配置时不再归一/回写任何来源值（旧配置里的该字段保持原样、不被本页触碰）。
   */
  const baseDefs = [
    FIELD.enabled, FIELD.quotaPolicyEnabled, FIELD.quotaTrustRouteOrder,
    FIELD.opencodeGoEnabled, FIELD.deepseekEnabled, FIELD.deepseekWarnThreshold,
    FIELD.codexEnabled, FIELD.mimoEnabled, FIELD.mimoWarnThreshold,
  ]
  for (const def of baseDefs) {
    const raw = plainValue(source[def.field])
    if (def.kind === 'toggle') {
      form[def.field] = typeof raw === 'boolean' ? raw : defaultSettingValue(def) === true
    } else {
      form[def.field] = typeof raw === 'number' && Number.isFinite(raw) ? raw : defaultSettingValue(def)
    }
  }
  const focus = safeJsonArray(plainValue(source.quotaFocusChannels))
  for (const channelId of Object.keys(FOCUS_FIELDS)) {
    form[FOCUS_FIELDS[channelId]] = focus.indexOf(channelId) !== -1
  }
  const thresholds = safeJsonObject(plainValue(source.quotaChannelThresholds)) || {}
  for (const def of POLICY_CONTROL_DEFS) form[def.field] = policyValueOf(def, thresholds)
  /**
   * [2026-11-24 ChatGPT 账户] 折叠框 + 账号选项数据：
   *   - `codexAccountCurrentLabel`：收起时显示的当前账号邮箱；
   *   - `codexAccountOptions`：展开后的全部可用账号；
   *   - `codexAccountSelected`：当前选中项（options 控件的 selected 绑定）。
   */
  const account = codexAccountOptionsOf(opts.codexAccount, opts.locale)
  return {
    form,
    codexAccountCurrentLabel: account.currentLabel,
    codexAccountOptions: account.options,
    codexAccountSelected: account.selected,
    codexAccountExpanded: false,
  }
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

  for (const channel of projected.channels) {
    const identity = typeof channel.identity === 'string' && channel.identity.length > 0
      ? channel.identity
      : (identityById.has(channel.id) ? identityById.get(channel.id) : null)
    const presentation = CHANNEL_PRESENTATION[channel.id]
    if (presentation !== undefined) {
      const built = builtinChannelData(channel, presentation, locale, previous, now, identity)
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
 *   codexAccount?: () => (object | null),
 * }} deps
 *   `codexAccount` 是**惰性**取 Host 账户桥接的函数（可能返回 null：检查器 / 老宿主 /
 *   `apply()` 还没走到 codex 路由注册）。原位调用即抛错也无害——这里一律当 null 处理。
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
  const plans = Array.isArray(deps.plans) ? deps.plans : []
  const semanticsOf = typeof deps.semanticsOf === 'function' ? deps.semanticsOf : () => 'used'
  const saveConfig = typeof deps.saveConfig === 'function' ? deps.saveConfig : null
  const onConfigReload = typeof deps.onConfigReload === 'function' ? deps.onConfigReload : null
  /**
   * [0.11.4 MiMo 扫码登录彻底删除] 不再读取 `deps.mimoAuth` / `deps.mimoSessionBalance` /
   * `deps.debug`：本机登录面板已经整块移除（MiMo 只保留 API Key 查余额，配置在网页版设置页）。
   * Host 仍可以传这些键，这里一律忽略，不会因此报错。
   *
   * [R3 2026-11-25] Codex「一键适配」的两个 deps 回调**Host 已不再传**（不是「仍传但忽略」）：
   * 写入口与该适配入口都已整体删除，Host 的 deps 对象里没有这两个键。
   * 本模块同样**不读取**它们（不探测补丁状态、不写任何文件）；万一旧版 Host 仍传，
   * 这里也只是安静忽略未知 deps 键，不会报错，更不会重新引入适配视图。
   */
  /**
   * [2026-11-24 原生设置页 ChatGPT 账户] `deps.codexAccount` 是**惰性**函数：Host 在 codex
   * 路由注册之后才赋值那个桥接对象，而 `ctx.inject` 的回调可能更早触发 —— 所以这里只记住
   * **取函数本身**，每次用的时候再调（可能拿到 null）。
   */
  const codexAccountDep = typeof deps.codexAccount === 'function' ? deps.codexAccount : null

  /** 取当前账户桥接（形状不对/抛错一律 null：原生半绝不能因此崩掉设置页）。 */
  const codexAccountBridgeOf = () => {
    if (codexAccountDep === null) return null
    let api = null
    try { api = codexAccountDep() } catch (err) { api = null }
    return api !== null && api !== undefined && typeof api === 'object' ? api : null
  }

  let locale = 'zh-CN'
  let lastSnapshot = null
  let kick = null

  /**
   * 账户 **state wire**（无桥接 ⇒ `null`，视图退回静态说明；读失败 ⇒ `null`，
   * 列表显示「登录状态无法读取」）。原生页只读、不登录、不退出。
   */
  const codexAccountStateOf = async () => {
    const api = codexAccountBridgeOf()
    if (api === null) return null
    try {
      const state = await api.state()
      return state !== null && state !== undefined && typeof state === 'object' ? state : null
    } catch (err) {
      return null
    }
  }

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
     * [2026-11-24 ChatGPT 账户] 只在**视图被请求时**读一次账户状态（`state()` 是本地凭据记录
     * 读取，不发上游请求）；没有桥接 ⇒ null ⇒ 视图保留原静态说明。
     */
    const codexAccount = await codexAccountStateOf()
    // 策略开关是即时保存后再 refresh 视图的，所以这里必须按当前配置重建分组。
    return buildSettingsView({ caps, locale, cfg: cfgNow, codexAccount })
  }

  const settingsData = (scope, emit) => {
    let stopped = false
    let running = false
    const emitSafe = (payload) => {
      if (stopped) return
      try { emit(payload) } catch (err) { /* 取消/断开 */ }
    }
    /**
     * [2026-11-24 ChatGPT 账户] 原生页只有**账号列表**（不登录、不退出），所以不需要轮询：
     * 面板打开时推一次（含账号列表），配置重载时再推一次。账号变化（网页版登录/退出）
     * 下次打开设置页或点保存/刷新时自然生效。
     */
    const push = () => {
      if (stopped || running) return
      running = true
      Promise.resolve().then(async () => {
        let cfgNow = null
        try { cfgNow = await loadConfig() } catch (err) { cfgNow = null }
        const codexAccount = await codexAccountStateOf()
        running = false
        if (stopped) return
        emitSafe(buildSettingsData(cfgNow, { codexAccount, locale }))
      }).catch(() => { running = false })
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

  // ── ChatGPT 账户动作（原生页只做「选择当前账户」）────────────────────────────
  //
  // 用户定稿（2026-11-24）：添加账户 / 退出账号 / 重新登录全部保留在**网页版设置页**；
  // 原生设置页只显示账号列表，点一行 = 把该账号设为当前（`codexAccountSelect`）。
  //
  // 账户 id **必须再验一次**形状：不合法就给固定 toast，绝不扫描/猜测其它账户。

  /**
   * 事件里的账户 id。
   *
   * **协议形状（真机实测 2026-11-24）**：视图里 `action: { id, args }` 的 `args` 会**直接**
   * 作为 `event.value` 传给 handler —— 即 `event.value = { id: 'acc-1' }`，不是
   * `{ args: { id } }`。上一版按 `event.value.args.id` 读，真机点列表就报「账户标识无效」。
   * 这里同时兼容两种形状（App 直传 / 旧测试包一层），但只认 `id` 一个字段。
   *
   * 缺省 / 空 ⇒ `{ ok:false }`：本动作必须显式指定目标账户，不猜「当前账户」。
   */
  const codexAccountArgIdOf = (event) => {
    const value = event !== null && event !== undefined && event.value !== null && event.value !== undefined
      ? event.value
      : null
    // ① 直接是字符串（某些 App 版本把单选值直接当 value）
    if (typeof value === 'string') {
      const id = codexAccountIdOf(value)
      return id === null ? { ok: false, id: null } : { ok: true, id }
    }
    if (value === null || typeof value !== 'object') return { ok: false, id: null }
    // ② 协议形状：args 直接作为 value（`{ id }`）
    // ③ 兼容旧形状：`{ args: { id } }`
    // ④ 兼容 `{ value: 'id' }`（options 风格）
    let raw = value.id
    if (raw === undefined && value.args !== null && value.args !== undefined && typeof value.args === 'object') raw = value.args.id
    if (raw === undefined && typeof value.value === 'string') raw = value.value
    const id = codexAccountIdOf(raw)
    return id === null ? { ok: false, id: null } : { ok: true, id }
  }

  /**
   * 切换当前账户（下拉里点选；必须带该行 id）。成功 ⇒ toast + **patch**（立即更新
   * 折叠框标题 / 选中项，不依赖 App 是否重新拉数据）+ refresh（重建视图、收起折叠框）。
   */
  settingsActions.codexAccountSelect = async (scope, event) => {
    const loc = localeOfEvent(event, locale)
    const text = codexAccountStrings(loc)
    const api = codexAccountBridgeOf()
    if (api === null) return { toast: text.selectFailed }
    const picked = codexAccountArgIdOf(event)
    if (picked.ok !== true || picked.id === null) return { toast: text.badId }
    if (typeof api.select !== 'function') return { toast: text.selectFailed }
    let out = null
    try {
      out = await api.select(picked.id)
    } catch (err) {
      out = null
    }
    if (out === null || typeof out !== 'object' || out.ok !== true) return { toast: text.selectFailed }
    // 用**刚切换后的**真实 state 重算数据，保证 patch 与磁盘一致（不猜）。
    const account = codexAccountOptionsOf(await codexAccountStateOf(), loc)
    return {
      toast: text.selectOk,
      patch: {
        codexAccountCurrentLabel: account.currentLabel,
        codexAccountOptions: account.options,
        codexAccountSelected: account.selected,
        codexAccountExpanded: false,
      },
      refresh: true,
    }
  }

  // [0.11.4 MiMo 扫码登录彻底删除] 原生半只剩两个面板：额度（quota）与设置（settings）。
  // MiMo 没有登录面板、也没有「登录/扫码/记住登录」动作；余额只由 API Key 取数。
  return {
    quota: { view: quotaView, data: quotaData, actions: quotaActions },
    settings: { view: settingsView, data: settingsData, actions: settingsActions },
  }
}
