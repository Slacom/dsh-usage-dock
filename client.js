/**
 * dsh-plan-usage 的浏览器半：
 *   1. 在 shell.overlay 右下角渲染套餐用量角标（当前支持 OpenCode Go、
 *      GLM Coding Plan 的两个渠道（国际版 Z.AI / 智谱）与 Kimi Code），
 *      胶囊每个套餐一行展示 5小时/周限/月限 三个窗口，展开面板按套餐分区
 *      显示进度条；
 *   2. 在「设置 → 插件 → 插件配置」注册配置卡片：一个「启用套餐用量角标」全局
 *      开关，以及每个套餐各自的开关与 API Key 输入框（write-only 密钥）；
 *      Kimi Code 额外有可选的 kimi-auth Cookie 输入框（用于月度会员额度）。
 *
 * 架构：与 Host 半（index.js + plans/ 目录）一一对应，本文件的套餐相关
 * 内容全部数据化——PLANS 表（id/name/输入框提示，对应 Host 的 plans/*.js）
 * 与 PLAN_NOTES 表（套餐级面板脚注，键为套餐 id）。渲染与配置逻辑是纯
 * 通用的，不出现 `if (plan.id === ...)` 分支；接入新套餐只改这两张表。
 *
 * 为什么浏览器半是单文件：客户端模块系统按「一个插件 id 一个 bundle」加载
 * （`/plugins/<id>/client.js`，HMR 也只按该 id 失效），外部插件没有多文件
 * 加载通道；本插件保持零构建（GitHub 源码安装不跑 prepare 脚本）。因此套餐
 * 解耦在 Host 半拆成物理模块，浏览器半用数据表实现同等的解耦效果。
 *
 * 配置卡片不依赖 harness 的设置命名空间白名单：控制器通过插件自己的
 * `GET/POST /api/plan-usage/config` 路由读写配置（Host 半用 in-process 的
 * settings 命名空间持久化），因此无需修改 harness 源码。
 *
 * 由 client-modules 注册表以「闭包工厂」形式提供给浏览器：React 与
 * `@deepseek-ai/dsh-client-ui-primitives`（折叠箭头图标）通过加载器模块表
 * （platform module）注入。卡片外观逐项复刻 harness 自带插件（终端、Agent
 * 循环、网页搜索）的 PluginCard/fields 设计——折叠头部、未保存徽标、底部
 * 按钮（放弃修改/保存/保存中…）与配色全部一致；伪类（hover/focus-visible）
 * 通过 apply 注入的一枚局部样式表实现，其余内联样式，避免 CSS 构建。
 */
window.__ModuleLoader__.load({ id: 'dsh-usage-dock', factory: (require) => {
var module = { exports: {} }
var exports = module.exports
var React = require('react')
var h = React.createElement

// ===========================================================================
// 用量角标
// ===========================================================================

var WINDOWS = [
  { key: 'rollingUsage', label: '5小时' },
  { key: 'weeklyUsage', label: '周限' },
  { key: 'monthlyUsage', label: '月限' },
]

/**
 * [R3-03] 把 Host 的通用 `windows` 数组适配成原生窗口字段。
 *
 * 两端的投影不是同一套结构：
 *   - 原生 wire（GUI 一直用的）：`rollingUsage/weeklyUsage/monthlyUsage`，
 *     每个是 `{ percent, resetsAt }`，含义由 `percentMode` 决定（Codex 是「剩余」）；
 *   - 模型投影（Host 补齐缓存值时给的）：`windows: [{ scope, percent, percentMode }]`，
 *     `percent` 恒为**剩余**比例。
 *
 * 直接把后者塞给期待「已用」比例的渠道会显示反了，所以这里按 scope 映射字段，
 * 并在 `percentMode === 'used'` 的渠道上换算成已用比例。
 *
 * @returns {object} 补好窗口字段的 plan（不修改入参）
 */
function adaptHostWindows(plan, meta) {
  if (!plan || !Array.isArray(plan.windows) || plan.windows.length === 0) return plan
  var out = Object.assign({}, plan)
  /**
   * [R4-02] 口径判定必须与原生 GUI 完全一致。
   *
   * 原生逻辑是「**非 remaining 即已用**」（见 toneColor/worstPercent/详情标题三处），
   * 而这里原来只认 `=== 'used'`，于是没有显式写 `percentMode` 的 OpenCode
   * （其 `usagePercent` 实为已用）被判成剩余口径，缓存换算反了：
   * 原生已用 80% 被显示成已用 20%。
   *
   * 现在统一为「`=== 'remaining'` 才是剩余，其余都是已用」。
   */
  var usedMode = !(meta && meta.percentMode === 'remaining')
  for (var i = 0; i < plan.windows.length; i++) {
    var win = plan.windows[i]
    if (!win || typeof win.percent !== 'number') continue
    var scope = typeof win.scope === 'string' ? win.scope : ''
    // Host 侧投影恒为「剩余」；原生渠道可能期待「已用」。
    var hostIsRemaining = win.percentMode === undefined || win.percentMode === 'remaining'
    var value = hostIsRemaining && usedMode ? 100 - win.percent : win.percent
    if (value < 0) value = 0
    if (value > 100) value = 100
    var slot = null
    if (scope.indexOf('rolling') !== -1 || scope.indexOf('5h') !== -1) slot = 'rollingUsage'
    else if (scope.indexOf('weekly') !== -1) slot = 'weeklyUsage'
    else if (scope.indexOf('monthly') !== -1) slot = 'monthlyUsage'
    if (slot === null) continue
    // 原生字段优先：已有真实 wire 时不覆盖。
    if (out[slot] && typeof out[slot].percent === 'number') continue
    out[slot] = {
      percent: value,
      resetsAt: typeof win.resetsAt === 'string' ? win.resetsAt : null,
    }
  }
  return out
}

/** 面向用户的通用名称：不绑定具体套餐提供方。 */
var PLAN_NAME = '套餐用量'

/**
 * 已接入的套餐（渠道）：id 与 Host 半的 wire 标识一致，一一对应 Host 的
 * plans/*.js 模块。每接入一个套餐，在这里追加一项（credentialHint 用于
 * 配置卡片的占位/提示文案）。
 *
 * [0.9.0] 渠道退场：`kimi-code` / `glm-zhipu` / `glm-zai` 已从本表移除
 * （用户 2026-10-18 决定：不再使用 Kimi / GLM / Z.AI）。
 *   - 它们不再出现在胶囊、详情面板、设置页开关与排序候选里；
 *   - **不能只删 Host 注册表**：`planMeta()` 对未知 id 会回退成「id 当名字」并
 *     照常画一行，所以客户端这张表也必须同步（两侧都改才算真的退场）；
 *   - 旧配置里的开关/Key/planOrder 条目原样保留，不删除、不清理共享模型凭据。
 * 已退场 id 的清单见 `PLAN_RETIRED_IDS`，仅用于「旧配置/旧 Host 不复活」的守卫。
 */
var PLANS = [
  // fields 与 Host 半各模块的 fields 一一对应：设置页用它读写 DSH 托管的 Config。
    // [R4-02] 显式声明 `percentMode`：OpenCode 的 `usagePercent` 是**已用**比例，
  // 而 Codex 是**剩余**。缓存适配、颜色、详情与原生 wire 必须用同一套口径，
  // 不能依赖「没写就是某一种」的隐式默认。
  { id: 'opencode-go', name: 'OpenCode Go', credentialHint: 'opencode-go', percentMode: 'used', fields: { enabled: 'opencodeGoEnabled', apiKey: 'apiKey' } },
  // DeepSeek 余额：右侧只显示剩余余额（元），阈值可配置（见 deepseekWarnThreshold）。
  // balanceThreshold 仅作「余额类渠道」的标记与兜底默认；实际阈值取 host 返回的
  // warnThreshold（来自配置 deepseekWarnThreshold，默认 10 元）。
  { id: 'deepseek', name: 'DeepSeek', credentialHint: 'DEEPSEEK', balanceThreshold: 10, thresholdField: 'deepseekWarnThreshold', fields: { enabled: 'deepseekEnabled', apiKey: 'deepseekApiKey' } },
  // 复用 dsh-codex-connect 的 ChatGPT OAuth，无需另填 API Key。
  { id: 'codex', name: 'OpenAI Codex', noCredential: true, percentMode: 'remaining', credentialNote: '复用 Codex Connect 的 ChatGPT 登录；请先在 Codex Connect 配置中完成登录。', fields: { enabled: 'codexEnabled' } },
  // [local patch 0.8.0] 小米 MiMo：控制台 Cookie 鉴权（非 API Key），只显示 API 余额。
  // cookieHint 触发设置页的 Cookie 输入框（role secret，与 kimi-auth 同款先例）；
  // balanceThreshold 标记「余额类渠道」，阈值取 host 返回的 warnThreshold（mimoWarnThreshold）。
  { id: 'mimo', name: 'Xiaomi MiMo', credentialHint: 'MIMO', balanceThreshold: 10, thresholdField: 'mimoWarnThreshold', fields: { enabled: 'mimoEnabled', cookie: 'mimoCookie' } },
  // [local patch 0.8.1] WorkBuddy 剩余积分：借用 dsh-workbuddy-connect 的登录态
  //（与 Codex 渠道同款模式），本插件零凭据；未安装/未登录由 host 返回语义提示。
  // [0.8.3] 拆成两个独立渠道：国内版与国际版积分不通用，各自开关/排序
  //（用户 2026-10-17 要求，与 DeepSeek/MiMo 等渠道完全同权）。
  { id: 'workbuddy', name: 'WorkBuddy', noCredential: true, creditMode: true, credentialNote: '读取「设置 → 模型」中 workbuddy 网关配置（复用该网关的 API Key），访问该网关的 /status 查看积分；不需要在此安装或登录 WorkBuddy Connect。', fields: { enabled: 'workbuddyEnabled' } },

]

/**
 * [0.9.0] 已退场的内置渠道 id（与 Host 的 RETIRED_PLAN_IDS 一致）。
 * 只用于两件事：① 旧 `planOrder` 里的这些 id 不占排序槽位；② 万一 Host 仍返回
 * 这些条目（旧 Host + 新客户端），客户端直接丢弃，不画行。
 */
var PLAN_RETIRED_IDS = ['kimi-code', 'glm-zhipu', 'glm-zai']

function isRetiredPlanId(id) {
  return PLAN_RETIRED_IDS.indexOf(id) !== -1
}

function planMeta(id) {
  for (var i = 0; i < PLANS.length; i++) {
    if (PLANS[i].id === id) return PLANS[i]
  }
  return { id: id, name: id, credentialHint: id }
}

/**
 * 套餐级面板脚注：键为套餐 id（对应 Host 的 plans/*.js），值为该套餐的
 * 提示函数（接收 wire 用量对象与设置快照，返回提示文案数组）。没有脚注
 * 的套餐不登记，渲染层统一走 planNotes()。
 */
var PLAN_NOTES = {
  'opencode-go': function (plan) {
    var notes = []
    if (plan.useBalance) notes.push('超出限额后将使用 Zen 余额')
    return notes
  },
  // [0.9.0] 'kimi-code' 的脚注随渠道退场一并删除：它引用的 cookieConfigured
  // 已经没有对应输入框，留着只会提示用户去配一个不存在的字段。
  'codex': function (plan) {
    var notes = ['百分比表示剩余额度']
    if (plan.creditsUnlimited === true) notes.push('预付 credits：不限量')
    else if (typeof plan.creditsBalance === 'string') notes.push('预付 credits 余额：' + plan.creditsBalance)
    if (plan.individualLimit && typeof plan.individualLimit.remaining === 'string') {
      notes.push('工作区成员剩余额度：' + plan.individualLimit.remaining + ' / ' + (plan.individualLimit.limit || '—'))
    }
    return notes
  },
}

function planNotes(plan, settingsSnap) {
  var fn = PLAN_NOTES[plan.id]
  return fn ? fn(plan, settingsSnap) : []
}

/**
 * [local patch 0.8.1] 渠道显示顺序：配置项 planOrder 是渠道 id 的 JSON 数组
 * （设置页「上移/下移」维护）。解析失败/为空返回 null（调用方按默认顺序）。
 */
function parsePlanOrder(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    var arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return null
    var ids = []
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] === 'string' && ids.indexOf(arr[i]) === -1) ids.push(arr[i])
    }
    return ids.length > 0 ? ids : null
  } catch (err) {
    return null
  }
}

/** 按 planOrder 排序一个渠道数组（未列出的渠道按默认顺序排在已列出的后面）。 */
function sortPlansByOrder(list, orderRaw) {
  var order = parsePlanOrder(orderRaw)
  if (order === null) return list
  var rank = {}
  for (var i = 0; i < order.length; i++) rank[order[i]] = i
  return list.slice().sort(function (a, b) {
    // [0.9.0] 退场 id 不参与排序：它们既不占位，也不该影响其他渠道的相对次序。
    var ra = rank[a.id] !== undefined ? rank[a.id] : order.length
    var rb = rank[b.id] !== undefined ? rank[b.id] : order.length
    if (ra !== rb) return ra - rb
    // 未列出渠道之间保持默认相对顺序（稳定排序兜底，兼容旧引擎）。
    return list.indexOf(a) - list.indexOf(b)
  })
}

function fmtReset(sec) {
  if (sec == null || !(sec > 0)) return ''
  if (sec < 60) return Math.round(sec) + ' 秒'
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟'
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时'
  return Math.round(sec / 86400) + ' 天'
}

function toneColor(p) {
  if (p >= 90) return 'var(--dsw-alias-state-error-primary)'
  if (p >= 50) return 'var(--dsw-alias-state-warn-primary)'
  return 'var(--dsw-alias-state-success-primary)'
}

/** 剩余额度语义：越高越绿，越低越红（与 Codex Connect 原生指示器一致）。 */
function remainingToneColor(p) {
  if (p >= 60) return 'var(--dsw-alias-state-success-primary)'
  if (p >= 40) return '#eab308'
  if (p >= 20) return '#f97316'
  return 'var(--dsw-alias-state-error-primary)'
}

function quotaToneColor(meta, p, limited) {
  if (limited) return 'var(--dsw-alias-state-error-primary)'
  return meta.percentMode === 'remaining' ? remainingToneColor(p) : toneColor(p)
}

// ===========================================================================
// [local patch 0.8.0] 余额显示与失败降级
// ===========================================================================

/** 币种 → 显示符号（MiMo 官方返回 CNY/USD；未知币种按 ¥ 处理）。
 * [0.8.3] 符号后带统一薄空格（U+2009）：与 WorkBuddy「✦」前缀共用同一间距基准，
 * 实测「符号→数字」可见间隙 ✦ 3.29 / ¥ 3.31（18px）像素级一致（见 SYMBOL_GAP 定义）。 */
function balanceSymbol(currency) {
  var cur = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  if (cur === 'USD') return '$' + SYMBOL_GAP
  return '¥' + SYMBOL_GAP
}

// ===========================================================================
// [0.9.0] 自定义余额渠道的显示层工具
// ===========================================================================
//
// 口径（与 plans/custom-balance.js 的 C0 冻结一致）：
//   - 币种**只能**来自用户配置，不由厂商名称、符号或 $ 猜测；
//   - 未指定币种时显示裸数字并注明「未指定币种」，绝不默认人民币；
//   - 数值沿用「不向上多显示一分」的截断规则（floorToCent），负数同样截断
//     （-3.216 → -3.22 而不是 -3.21 的"更富"方向），与余额语义一致。

/** 自定义渠道的稳定 id 前缀（与 Host 的 CUSTOM_ID_PATTERN 对应）。 */
var CUSTOM_ID_PREFIX = 'custom:'

/** 该 wire 条目是否为自定义余额（Host 会显式打 custom:true）。 */
function isCustomPlan(plan) {
  return plan != null && plan.custom === true
}

/**
 * [R4] 按 id 形态识别「自定义条目」。
 *
 * 为什么不能只靠 `plan.custom`：0.9.0 在「整体请求连续失败到第 8 轮」时构造的纯错误行
 * 丢掉了 custom 标记，于是客户端再也认不出它是自定义条目——用户删掉该记录后，
 * 这一行仍会走普通 carry 永久残留成「custom:xxx 获取失败」。
 * 该函数给这类行一个兜底身份；配合上面的保留策略，删除/停用后一定能被清理。
 */
function looksCustomId(id) {
  return typeof id === 'string' && id.indexOf('custom:') === 0
}

/** 该条目（或其错误行）是否应被当作自定义条目处理。 */
function isCustomLike(plan) {
  return isCustomPlan(plan) || (plan != null && looksCustomId(plan.id))
}

/**
 * 从已保存配置里算出**每条**自定义条目的公开身份（id → 签名）。
 *
 * 与 `customConfigSignature()` 同源，但保留逐条粒度：这样「只有 A 改了 URL」时
 * 只需作废 A 的旧值，B/C 的成功基线不受影响（复核要求「不要顺带丢掉无关渠道」）。
 */
function customConfigSignatureMap(config) {
  var list = parseCustomBalances(config != null ? config.customBalances : undefined)
  var revs = config != null && config.customKeyRev !== null && typeof config.customKeyRev === 'object'
    ? config.customKeyRev
    : {}
  var map = {}
  for (var i = 0; i < list.length; i++) {
    // [X2] 逐条身份**含公开 Key 修订号**：另一窗口保存 Key 后，即使元数据一模一样，
    // 这条的身份也变了，旧余额与旧基线必须作废（其它条目不受影响）。
    map[list[i].id] = customEntryIdentityWithRev(list[i], revs)
  }
  return map
}

/**
 * [X1] 配置摘要的**字段规范化**：必须与 Host 的 `entryPublicIdentity()` 逐字一致。
 *
 * 第四轮复核发现：Host 对 URL/键路径/引用做 trim + 截断、对币种规范化、对
 * credentialHost 小写化，而客户端直接拼原始字段。于是 `url = ' https://a.example/b '`
 * 这种**设置校验与 Host 解析都接受**的合法输入，会让 Host 的成功证明永远与客户端不等 ——
 * 数据被当成「旧配置」拒绝，界面只剩「—」。
 *
 * 修法不是「保存时 trim」（那样既有配置 / CLI / YAML / 真实 Config 路径仍不一致），
 * 而是把规范化放进**摘要计算**里，两端共用同一规则。
 */
var DIGEST_URL_MAX = 512
var DIGEST_PATH_MAX = 200
var DIGEST_REF_MAX = 80
var DIGEST_HOST_MAX = 200

function digestText(value, maxLength) {
  if (typeof value !== 'string') return ''
  var trimmed = value.trim()
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

/** 币种：trim + 大写；2–6 位字母才算合法，否则归一为空串（与 Host 同规则）。 */
function digestCurrency(value) {
  if (typeof value !== 'string') return ''
  var code = value.trim().toUpperCase()
  if (code.length === 0) return ''
  if (!/^[A-Z]{2,6}$/.test(code)) return ''
  return code
}

/** 单条自定义条目的公开身份（**规范化后**，与 Host 的 entryPublicIdentity 同构）。 */
function digestEntryIdentity(row) {
  if (row == null) return ''
  return [
    digestText(row.id, 80),
    // [CP-04] 与 Host 的 entryPublicIdentity 逐字同构（provider 参与身份）。
    digestText(row.provider, 80),
    digestText(row.balanceEndpoint, 300),
    digestText(row.url, DIGEST_URL_MAX),
    digestText(row.balancePath, DIGEST_PATH_MAX),
    digestText(row.subtractPath, DIGEST_PATH_MAX),
    digestCurrency(row.currency),
    digestText(row.credentialRef, DIGEST_REF_MAX),
    digestText(row.credentialHost, DIGEST_HOST_MAX).toLowerCase(),
    row.enabled === false ? '0' : '1',
  ].join('\u0001')
}

/**
 * [X1] 单条身份签名：只含影响取数结果的字段（不含名称——改名不该让余额失效）。
 *
 * 用与摘要相同的**规范化**，否则 `url = ' https://a '` 与 `'https://a'` 会被当成两条不同
 * 身份，导致「明明没改却被判成改过」而反复作废基线（X1 的同根问题）。
 */
function customEntrySignature(row) {
  if (row == null) return ''
  return digestEntryIdentity(row)
}

/**
 * [X2] 某条在**当前已保存配置**里的公开身份 + 非密密钥修订号。
 *
 * 与 `customEntrySignature()` 的区别：这里额外带上 `customKeyRev[id]`。
 * 用途是「另一窗口保存了 Key」这种**只改修订号**的场景 —— 公开元数据一模一样，
 * 但配置确实变了，旧余额必须作废、旧证明必须拒绝。
 */
function customEntryIdentityWithRev(row, revs) {
  if (row == null) return ''
  return digestEntryIdentity(row) + '\u0002' + String(clientKeyRev(revs, row.id))
}

/**
 * [W3] 上一批数据里各条目的**配置身份**（来自 applied 快照）。
 *
 * wire 条目本身不含原始 URL/路径，无法直接与当前配置比较；但成功响应时我们记录了
 * `applied.entries`（id → 当时的配置签名），拿它和当前签名比即可判断「这条改过没有」。
 * 没有 applied 快照（从未成功过）时返回 null，调用方按「全部保留」处理。
 */
function appliedEntriesOf(applied) {
  if (applied === null || applied === undefined) return null
  if (applied.entries === null || typeof applied.entries !== 'object') return null
  return applied.entries
}

// ===========================================================================
// [R3] 已保存配置的「代次」信号
// ===========================================================================
//
// 审查发现：0.9.0 只比较「本轮 wire 的 gen」与「上轮 wire 的 gen」。可是当用户保存了
// 新的 URL / 币种 / JSON 路径 / 停用 / 删除时，**在途的旧请求**仍会带着旧 gen 回来，
// 客户端把它当成「第一次见到的 gen」接受 —— 于是旧值照样显示（探针 repro B）。
//
// 修法：把「已保存配置的身份」变成一个可订阅的信号，配置一变就
//   ① 作废在途请求（effect 重跑 → cleanup abort）；
//   ② 清空该条旧值、失败计数与 gen 记录（新 effect 闭包里全是空的）。
// Key 的变化配置里看不到（secret 被宿主剥掉），因此设置页保存成功后显式 bump 一次。

/** 模块级配置代次：设置页保存成功后自增；胶囊订阅它来作废旧值。 */
var configEpochValue = 0
var configEpochListeners = []
// [V2] 每次保存「只改了 Key」时，设置页会把受影响的 id 一并报上来。
// 这些条目的旧余额必须立刻作废（配置字段没变，签名比较抓不到）。
var configDirtyIds = {}

function bumpConfigEpoch(changedIds) {
  configEpochValue += 1
  if (Array.isArray(changedIds)) {
    for (var d = 0; d < changedIds.length; d++) {
      if (typeof changedIds[d] === 'string' && changedIds[d].length > 0) {
        configDirtyIds[changedIds[d]] = configEpochValue
      }
    }
  }
  var list = configEpochListeners.slice()
  for (var i = 0; i < list.length; i++) {
    try { list[i](configEpochValue) } catch (err) { /* 单个订阅者出错不影响其它 */ }
  }
}

function subscribeConfigEpoch(listener) {
  configEpochListeners.push(listener)
  return function () {
    var index = configEpochListeners.indexOf(listener)
    if (index !== -1) configEpochListeners.splice(index, 1)
  }
}

function getConfigEpoch() {
  return configEpochValue
}

/**
 * [V2] 某条自定义条目在**当前**配置下是否还能沿用「epochAtApply 那轮」的数据。
 *
 * 复核发现 0.9.0 只清了 effect 闭包（lastList/failStreaks/customGens），
 * 组件 state 里上一次成功余额没动，于是改 URL/币种后、新请求还在飞的那几秒，
 * 屏幕上仍是旧余额（探针：`BEFORE A$ 91.23` → `AFTER_CONFIG_CHANGE A$ 91.23`）。
 *
 * 这里在**渲染时**做三道判定（逐条，不牵连其它渠道）：
 *   ① 配置里已删除 / 已停用 → 不显示；
 *   ② 该条身份签名与「数据所属那轮」不同 → 不显示（改 URL/路径/币种/引用/目标确认）；
 *   ③ 该条在数据那轮之后被「只改 Key」标记为脏 → 不显示。
 */
/**
 * [W1/W2] 已显示的数据在当前配置下是否还有效。
 *
 * 三道判定（逐条，不牵连其它渠道）：
 *   ① 配置里已删除 / 已停用 → 不显示；
 *   ② 该条身份签名与「数据所属那轮」不同 → 不显示（改 URL/路径/币种/引用/目标确认）；
 *   ③ 该条在数据那轮之后被「只改 Key」标记为脏 → 不显示。
 *
 * 注意 ③ 现在只是**保守兜底**：真正的来源确认由响应里的 `data.cfg.digest` 完成
 * （见 `responseMatchesCurrentConfig`）。它保留是为了覆盖「保存动作已发生、但新响应还没到」
 * 的这几秒 —— 这段时间旧值必须先消失。
 */
function customDataStillValid(id, applied, currentEntries) {
  if (applied == null) return true // 没有「数据所属轮次」信息时按旧行为处理
  var nowSignature = currentEntries[id]
  if (nowSignature === undefined) return false
  var appliedSignature = applied.entries[id]
  if (appliedSignature === undefined) return false
  if (appliedSignature !== nowSignature) return false
  var dirtyEpoch = configDirtyIds[id]
  if (typeof dirtyEpoch === 'number' && dirtyEpoch > applied.epoch) return false
  return true
}

/**
 * 从已保存配置里算出「自定义条目的公开身份摘要」。
 *
 * 只包含**会影响取数结果**的字段（不含名称——改名不该让余额失效）。
 * 摘要变化 = 用户改了 URL/路径/扣减键/币种/凭据引用/目标确认/启用状态，或增删了条目。
 */
function customConfigSignature(config) {
  var list = parseCustomBalances(config != null ? config.customBalances : undefined)
  var parts = []
  for (var i = 0; i < list.length; i++) {
    var row = list[i]
    parts.push([
      row.id,
      // [CP-04] 与 Host 的 entryPublicIdentity 逐字同构：provider 必须参与，
      // 否则换来源后客户端以为"配置没变"，Host 的成功证明也对不上。
      row.provider,
      row.balanceEndpoint,
      row.url,
      row.balancePath,
      row.subtractPath,
      row.currency,
      row.credentialRef,
      row.credentialHost,
      row.enabled === false ? '0' : '1',
    ].join('\u0001'))
  }
  return parts.join('\u0002')
}

/** 已保存配置里的自定义条目索引（id → 条目），供显示层过滤使用。 */
function customConfigIndex(config) {
  var list = parseCustomBalances(config != null ? config.customBalances : undefined)
  var index = {}
  for (var i = 0; i < list.length; i++) index[list[i].id] = list[i]
  return index
}

/**
 * [W1/W2] 客户端版的配置摘要，**必须与 Host 的 `configDigestOf()` 逐字一致**。
 *
 * 组成：每条自定义条目的公开身份（id/url/路径/扣减键/币种/凭据引用/目标确认/启用）
 * + 该条的**非密**密钥修订号 `customKeyRev[id]`；条目顺序敏感。
 *
 * 为什么需要修订号：Key 本身是 secret，浏览器拿不到也绝不该拿到，所以「保存了同一把
 * Key」在公开元数据上**没有任何差异**。修订号让「保存动作」进入摘要 —— Host 读到新配置
 * 后修订号就变了，客户端据此确认「这次保存已生效」，即使 wire 的 `gen` 与上一轮相同。
 */
function configDigestOfClient(config) {
  var list = parseCustomBalances(config != null ? config.customBalances : undefined)
  var revs = config != null && config.customKeyRev !== null && typeof config.customKeyRev === 'object'
    ? config.customKeyRev
    : {}
  var parts = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    var row = list[i]
    if (seen[row.id] === true) continue
    seen[row.id] = true
    // [X1] 用**规范化后**的公开身份，与 Host 的 entryPublicIdentity 同构。
    parts.push(digestEntryIdentity(row) + '\u0002' + String(clientKeyRev(revs, row.id)))
  }
  var orphans = []
  for (var id in revs) {
    if (!Object.prototype.hasOwnProperty.call(revs, id)) continue
    if (seen[id] === true) continue
    orphans.push('orphan:' + id + '\u0002' + String(clientKeyRev(revs, id)))
  }
  orphans.sort()
  for (var o = 0; o < orphans.length; o++) parts.push(orphans[o])
  return dshDigest16(parts.join('\u0003'))
}

/** 读取修订号（与 Host 的 keyRevOf 同规则：非数字/负数按 0）。 */
function clientKeyRev(revs, id) {
  if (revs === null || revs === undefined || typeof revs !== 'object') return 0
  var value = revs[id]
  var numeric = typeof value === 'number' ? value : Number(value)
  return isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

/**
 * 16 位十六进制摘要。
 *
 * 浏览器侧没有同步可用的 SHA-256（`crypto.subtle` 是异步的，而这里是渲染期计算），
 * 因此用 FNV-1a 64 位双通道拼成 16 位十六进制。它**只用于「同一份配置是否相同」的比对**，
 * 不是安全摘要：伪造它没有意义（对手要改的是 Host 实际读到的配置），
 * 而真正的秘密（Key）从不进入这个输入。
 */
function dshDigest16(text) {
  var h1 = 0x811c9dc5
  var h2 = 0x01000193
  for (var i = 0; i < text.length; i += 1) {
    var c = text.charCodeAt(i)
    h1 = (h1 ^ c) >>> 0
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0
    h2 = (h2 ^ (c + i)) >>> 0
    h2 = (h2 + ((h2 << 1) + (h2 << 4) + (h2 << 7) + (h2 << 8) + (h2 << 24))) >>> 0
  }
  var a = ('00000000' + h1.toString(16)).slice(-8)
  var b = ('00000000' + h2.toString(16)).slice(-8)
  return a + b
}

/**
 * 自定义渠道的显示符号：
 *   - CNY / RMB → ¥，USD → $（与内置余额渠道同款薄空格）；
 *   - 其它显式币种 → 「XXX 」前缀（不猜符号）；
 *   - 空（未指定）→ ''（裸数字，调用方另加「未指定币种」说明）。
 */
function customCurrencySymbol(currency) {
  var cur = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  if (cur === 'CNY' || cur === 'RMB') return '¥' + SYMBOL_GAP
  if (cur === 'USD') return '$' + SYMBOL_GAP
  if (cur.length === 0) return ''
  return cur + ' '
}

/**
 * 自定义余额的数值格式化：截断到分（不四舍五入），保留负号。
 * 与 floorToCent 的差别只在负数方向：floorToCent(-3.216) 会得到 -3.22（欠费更多），
 * 但内置渠道从未出现负数，这里显式命名以免将来有人误用内置函数。
 */
function formatCustomAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  var truncated = value >= 0
    ? Math.floor(Math.round(value * 1e6) / 1e4) / 100
    : -Math.floor(Math.round(-value * 1e6) / 1e4) / 100
  return Math.abs(truncated).toFixed(2) === '0.00' && truncated < 0 ? '-0.00' : truncated.toFixed(2)
}

/** 自定义渠道的完整数值文本（符号 + 截断数值；未指定币种时只给数字）。 */
function customBalanceText(plan) {
  return customCurrencySymbol(plan.currency) + formatCustomAmount(plan.balance)
}

/**
 * 解析配置里的自定义条目（公开元数据；**不含 Key**）。
 * 与 Host 的 collectCustomEntries 保持同一套容错：非法 id 跳过、重复 id 取第一条；
 * 客户端这里只用于「排序显示」与「设置页草稿」，不参与任何鉴权判断。
 */
function parseCustomBalances(raw) {
  var list = null
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.length > 0) {
    try {
      var parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch (err) {
      list = null
    }
  }
  if (list === null) return []
  var out = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    var id = typeof item.id === 'string' ? item.id : ''
    if (!/^custom:[A-Za-z0-9_-]{6,64}$/.test(id)) continue
    if (seen[id] === true) continue
    seen[id] = true
    out.push({
      id: id,
      // [0.9.1] 余额来源：宿主里已配置的模型渠道 id（地址与凭据都从它派生）。
      provider: typeof item.provider === 'string' ? item.provider : '',
      // [CP-03] 余额接口路径（主机来自所选渠道）。
      balanceEndpoint: typeof item.balanceEndpoint === 'string' ? item.balanceEndpoint : '',
      name: typeof item.name === 'string' ? item.name : '',
      /**
       * [0.9.1] 以下三项是 0.9.0 的旧字段，保留**只为让配置摘要与 Host 逐字同构**。
       *
       * `customConfigSignature()` / `digestEntryIdentity()` 都要拿它们参与计算：
       * 若这里丢掉，客户端摘要会与 Host 的 `entryPublicIdentity()` 不同，
       * 导致「Host 证明永远匹配不上、界面只剩 —」。UI 不再渲染这些字段。
       */
      url: typeof item.url === 'string' ? item.url : '',
      credentialRef: typeof item.credentialRef === 'string' ? item.credentialRef : '',
      credentialHost: typeof item.credentialHost === 'string' ? item.credentialHost : '',
      balancePath: typeof item.balancePath === 'string' ? item.balancePath : '',
      subtractPath: typeof item.subtractPath === 'string' ? item.subtractPath : '',
      currency: typeof item.currency === 'string' ? item.currency : '',
      enabled: item.enabled !== false,
    })
  }
  return out
}

// [local patch 0.8.1] 详情面板积分渠道的大号数值行（与余额类渠道同款排版，
// 但不写死颜色——由调用方传）。模块级常量，避免在 map 回调里重复构造。
var balRowStyleStatic = {
  display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0',
  fontSize: 18, fontWeight: 600,
}

/** 积分数值格式化：千分位、最多两位小数（与 workbuddy-connect 的显示一致）。 */
function formatCredit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

// [0.8.3] 符号与数字间的统一薄空格（U+2009）。
// 背景：✦（U+2726）advance 9.79px vs ¥ 6.47px（12px），墨迹测量显示 ✦ 墨迹几乎
// 顶满字宽、¥ 反而略溢出；「符号→数字」的可见间隙实测（canvas actualBoundingBox）：
//   ✦+普通空格 = 2.08px(12px) / 4.62px(18px)——18px 下比 ¥ 几乎贴死的 -0.3px 大 5px，
//   这正是用户指出的「星星和数字间隔比 ¥ 大」。
// 两边统一加 thin space 后：✦ 1.19 / ¥ 1.87（12px，差 0.7px 不可辨）、
// ✦ 3.29 / ¥ 3.31（18px，像素级一致）。选 U+2009 而非 U+200A（hair）：
// hair 在 12px 下 0.29px 过紧，thin 在两种字号下都落在「贴合但透气」区间。
var SYMBOL_GAP = /* U+2009 thin space（勿改成普通空格，间距实测见上） */' '

// [0.8.3] ✦ 与数字之间的分隔（英文空格 U+0020，与 ¥ 的 thin 等效间隙）。
// ✦ 缩放后进宽变小（8px 语境：6.53 vs ¥ 6.47），可见间隙随之变小；实测配**普通空格**
// 才与 ¥ 的 thin 打平（canvas 墨迹级测量，两个语境）：
//   胶囊 12px：✦@8px + space = 1.81px  vs  ¥@12 + thin = 1.87px（差 0.06）
//   面板 18px：✦@12px + space = 3.74px vs  ¥@18 + thin = 3.60px（差 0.14）
// 因此间距常量分开：¥/$ 用 SYMBOL_GAP，✦ 用 STAR_GAP。
var STAR_GAP = ' '

// [0.8.3] ✦ 的渲染参数（用户三轮实测后定稿：Android 与桌面都要对齐）。
//
// 演进：
//   1) 视觉「大一号」：✦ 在 18px 下墨迹 ascent14/descent2，比 ¥（13/0）更高且
//      基线不对称 → ✦ 缩到基准字号 2/3。
//   2) 符号列错轴：胶囊数值列右对齐，而 ¥ 进宽 6.47px / ✦ 进宽 9.79px
//      → 缩到 2/3 后进宽 6.53 ≈ ¥ 6.47，右对齐下中心与数字起点同时对齐。
//   3) [方案 B] 光学中心偏下：✦ 与数字**基线虽齐**，但 Android Noto 把 ✦ 画得
//      又小又靠下（实测面板：✦ 墨迹 10px vs 数字 16px，中心低 3.0px；胶囊低 2.0px；
//      同一份 CSS 在 Windows Segoe UI Symbol 下偏移 0.00px——纯平台字体差异，
//      用 translateY 只能治好一端）。因此数值区改**flex 中心对齐**
//      （align-items:center 按盒子中心对齐，不依赖字体基线），符号与数字各成子项。
//
// 用法：数值区容器用 valueFlexStyle(fontSize)，内部依次放
//   h('span', { style: starFixStyle(fontSize) }, '✦') 与 h('span', {}, 数字)。
//   ⚠️ 符号必须是**子项**（不能塞回同一个文本 span，那样又回到基线对齐）。
function starFixStyle(fontSize) {
  return {
    display: 'inline-block',
    fontSize: Math.round(fontSize * 2 / 3), // 与 ¥ 进宽/中心对齐的比例（实测见上）
    lineHeight: 1,                          // 防止撑高行框
  }
}

/**
 * [0.8.3 方案 B] 数值区容器：flex 横向 + 垂直中心对齐。
 * 不依赖字体基线，因此在 Windows / Android 的字体回退差异下都能把 ✦ 与数字居中对齐。
 *
 * ⚠️ 两个必须同时满足的条件（各自都踩过一次真实故障）：
 *   1) **块级 flex**（不是 inline-flex）：胶囊数值列靠 `marginLeft:'auto'` 贴右，
 *      而 auto 外边距在 inline-flex 元素上不推挤——用 inline-flex 会让数值区
 *      脱离右缘（0.8.3 第一版方案 B 左移约 51px）。
 *   2) **justifyContent:'flex-end'**：改成 flex 后，外层的 `textAlign:'right'`
 *      对 **flex 子项不再生效**（textAlign 只影响行内内容），内容会默认靠左
 *      （0.8.3 第二版方案 B 的胶囊仍左偏）。
 * 面板语境外层本来就是 flex 行，这里再套一层只影响「✦ + 数字」这一组。
 */
function valueFlexStyle(fontSize) {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    fontSize: fontSize,
    lineHeight: 1.2,
  }
}

// ===========================================================================
// [0.8.1 定稿] WorkBuddy 积分明细的自适应列表
// ===========================================================================
// 高度基准 = DeepSeek 当前区块的视觉高度（大号余额行 27px + 状态脚注 ≈17px
// + 上下 margin 8px ≈ 52px；再减去明细行的行高 17px，让列表整体不高于
// DeepSeek 区块）。行数少时按普通文字铺开；超过阈值才收进列表滚动。
// 列表右侧 paddingRight 预留滚动条（约 10px），避免与明细文字重合。
var WB_DETAIL_MAX_ROWS = 3
var wbDetailListStyle = {
  maxHeight: 72,           // [0.8.1 定稿] 首版 36px 太局促，扩大一倍（约 4 行）
  overflowY: 'auto',
  boxSizing: 'border-box',
  paddingRight: 10,        // 滚动条避让：明细文字不与滚动条重合
  overscrollBehavior: 'contain',
}

/**
 * 余额**向下取整到分**：与 DSH 设置页的截断语义一致。
 * [local patch 0.8.0] 0.7.x 用 toFixed(2)（四舍五入），真实余额 34.31662152 会
 * 显示成 34.32，而设置页截断成 34.31——用户看到的「胶囊总比实际多一分」即此。
 */
function floorToCent(value) {
  var n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return (Math.floor(Math.round(n * 1e6) / 1e4) / 100).toFixed(2)
}

/** 连续失败达到该轮数后才显示「获取失败」（更早的失败保留旧值 + 灰字）。
 * [0.8.3] 2 → 5（用户 2026-10-16 决定）：30 秒轮询下约 2.5 分钟才转「获取失败」，
 * 给 WorkBuddy 实时计费查询的偶发超时留出恢复窗口，避免数值灰一下就直接报错。
 * [0.9.0][A04] 8 → 5：与 Host 统一状态机对齐（第 5 次才移除旧值）。`n * 注意：正常情况下客户端**不再自己计数**，而是消费 Host 的 `effectiveStatus`；`n * FAIL_THRESHOLD 只用于 Host 未提供该字段的旧响应兜底。
 * 配合 WorkBuddy 渠道的错误分类（限流/5xx/超时都算暂时失败）一起生效。 */
var FAIL_THRESHOLD = 5

/** 失败期间旧值的显示色：弱化灰（不加「更新于」标注，见 roadmap 方向 3 定稿）。 */
var staleValueStyle = { color: 'var(--dsw-alias-label-tertiary)' }

/** 判断一个 wire 条目是否为「余额类渠道」（deepseek / mimo）。 */
function isBalancePlan(plan) {
  var meta = planMeta(plan.id)
  return meta.balanceThreshold !== undefined
}

// ===========================================================================
// [local patch 0.8.1] 峰谷时间条 A+C 方案（transform 图案层 + WAAPI 合成器动画
// + 每分钟漂移阈值校准）。游标固定正中 = 「现在」；峰谷图案层从右向左匀速滑动，
// 速率与真实时间轴一致（可视窗口 = 24h，即游标左右各 12 小时）。
// 文案与样式按用户定稿：无刻度、灰色小字（与面板脚注同款）、「峰价/平价」措辞。
// ===========================================================================

var peakWrapStyle = { display: 'flex', flexDirection: 'column', marginTop: 6, minWidth: 0 }
// 单一无边框坐标面：图案、动画测量与标记共用同一宽度；不再混用轨道 border-box / 内容宽。
// [0.8.2] marginBottom 6 为下方小正三角（轨道下缘外再占 6px）预留空间，避免压到脚注。
var peakStageStyle = { position: 'relative', height: 8, marginTop: 5, marginBottom: 6, minWidth: 0 }
var peakTrackStyle = { position: 'relative', width: '100%', height: '100%', borderRadius: 999, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-3)' }
var peakPatternStyle = { position: 'absolute', left: 0, top: 0, height: '100%', willChange: 'transform' }
// 两个图形只共享一个 50% 锚点，子项只相对于 x=0 定位；不以负 margin / 独立行补偿。
var peakMarkerStyle = { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 0, pointerEvents: 'none', zIndex: 2 }
// [0.8.2] 方案 K「上下对尖」（用户定稿，出自 docs/demos/cursor-directions-v2.html K）：
// 白柱整体移出轨道——上方 8×5 倒三角 + 下方 6×4 小正三角夹住「现在」，
// 色条内部没有任何覆盖物，也没有类似边界的竖线。与演示页一致：倒三角底缘
// 与轨道上缘留 1px 空隙（top:-6 + height 5 → 底缘 y=-1），小正三角顶缘与
// 轨道下缘留 2px 空隙（top:10）。stage 的 marginBottom:6 为下三角预留高度。
var peakCaretStyle = { position: 'absolute', left: 0, top: -6, width: 8, height: 5, background: 'var(--dsw-alias-label-tertiary)', clipPath: 'polygon(0 0, 100% 0, 50% 100%)', transform: 'translateX(-50%)' }
var peakFootStyle = { position: 'absolute', left: 0, top: 10, width: 6, height: 4, background: 'var(--dsw-alias-label-tertiary)', clipPath: 'polygon(50% 0, 100% 100%, 0 100%)', transform: 'translateX(-50%)' }
// 与面板脚注同款灰字（sectionNoteStyle 的字号/行高），无背景无边框。
var peakNoteStyle = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: 1.5, margin: '3px 0 2px' }

/** 峰/谷/周末/假日的段底色（与 cost-meter 一致）。 */
var PEAK_SEG_COLORS = {
  peak: '#ff9800',
  off: 'var(--dsw-alias-state-business-primary)',
  weekend: '#34a853',
  holiday: '#34a853',
}

/** 可视窗口 = 24 小时（游标居中，左右各 12h）；轨道宽度运行时测量。 */
var PEAK_VISIBLE_MS = 24 * 3600e3

/** 分钟数 → 「N 小时 M 分钟」/「M 分钟」短文案（不足 1 分钟按 <1 分钟）。 */
function fmtDuration(ms) {
  var total = Math.max(0, Math.round(ms / 60000))
  if (total < 1) return '不足 1 分钟'
  var hours = Math.floor(total / 60)
  var minutes = total % 60
  if (hours <= 0) return minutes + ' 分钟'
  return minutes > 0 ? hours + ' 小时 ' + minutes + ' 分钟' : hours + ' 小时'
}

/** 峰谷相位的灰字描述（0.8.1 定稿措辞：高峰时段/空闲时段）。 */
function peakNoteText(phase) {
  var countdown = '约 ' + fmtDuration((phase.nextAtMs || 0) - Date.now())
  if (phase.weekend === true) return '空闲时段（周末）· ' + countdown + '后进入高峰时段'
  if (phase.holiday === true) return '空闲时段（假期）· ' + countdown + '后进入高峰时段'
  if (phase.inPeak === true) return '高峰时段 · ' + countdown + '后进入空闲时段'
  return '空闲时段 · ' + countdown + '后进入高峰时段'
}

/**
 * 峰谷时间条（A+C）：
 *   - host 在 wire 上附带 peakSegs（[{s,e,t}] 连续峰谷段，30h 窗口）与
 *     peakPhase（相位/切换点，供文案）。二者缺一即不渲染。
 *   - 动画走 WAAPI（element.animate，transform 合成器路径）；无 WAAPI 的环境
 *     （测试 mock）退化为静态 translateX。
 *   - 校准：每 60s 读 anim.currentTime 与理论值比对，偏差折算 >1px 才拉回
 *     （currentTime 是时间基拉齐，肉眼无感）。
 */
function PeakBar(props) {
  var segs = Array.isArray(props.segs) ? props.segs : null
  var phase = props.phase
  var hasPhase = phase && typeof phase === 'object'
  var hasSegs = segs !== null && segs.length > 0
  var spanStart = hasSegs ? segs[0].s : 0
  var spanEnd = hasSegs ? segs[segs.length - 1].e : 0
  var spanMs = spanEnd - spanStart
  var hasTrack = !!hasPhase && hasSegs && Number.isFinite(spanMs) && spanMs > 0
  // hooks 始终按同一顺序调用；缺段/恢复时不能改变 React hooks 数量。

  // 轨道宽：挂载后量一次（面板宽度可变），量不到按 320 兜底。
  var trackRef = React.useRef(null)
  var widthHook = React.useState(0)
  var trackW = widthHook[0]
  var setTrackW = widthHook[1]
  React.useEffect(function () {
    var el = trackRef.current
    if (!hasTrack || !el || typeof el.getBoundingClientRect !== 'function') return
    var measure = function () {
      var w = el.getBoundingClientRect().width
      if (Number.isFinite(w) && w > 40) setTrackW(w)
    }
    measure()
    // 侧栏拖宽也会改变轨道尺寸，但不一定触发 window.resize。
    var observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
    if (observer) observer.observe(el)
    // 老 WebView 无 RO 时，仅在已挂载的详情条内轻量校准宽度。
    var measureTimer = observer ? null : setInterval(measure, 1000)
    window.addEventListener('resize', measure)
    return function () {
      if (observer) observer.disconnect()
      if (measureTimer !== null) clearInterval(measureTimer)
      window.removeEventListener('resize', measure)
    }
  }, [hasTrack])

  var scale = trackW > 40 ? trackW / PEAK_VISIBLE_MS : (320 / PEAK_VISIBLE_MS) // px / ms

  // 动画：transform 从「spanStart 对准游标」匀速滑到「spanEnd 对准游标」。
  var animRef = React.useRef(null)
  React.useEffect(function () {
    var track = trackRef.current
    var pattern = track && track.firstChild
    if (!hasTrack || !pattern || trackW <= 40) return
    var startTX = trackW / 2
    var endTX = trackW / 2 - spanMs * scale
    if (typeof pattern.animate !== 'function') {
      // 兜底（无 WAAPI）：静态摆到当前相位。
      pattern.style.transform = 'translateX(' + (startTX - (Date.now() - spanStart) * scale) + 'px)'
      return
    }
    if (animRef.current !== null) { animRef.current.cancel(); animRef.current = null }
    var anim = pattern.animate(
      [{ transform: 'translateX(' + startTX + 'px)' }, { transform: 'translateX(' + endTX + 'px)' }],
      { duration: spanMs, fill: 'both', easing: 'linear' })
    anim.currentTime = Math.max(0, Date.now() - spanStart)
    animRef.current = anim
    return function () {
      if (animRef.current !== null) { animRef.current.cancel(); animRef.current = null }
    }
  }, [hasTrack, trackW, spanStart, spanMs])

  // 每分钟校准：漂移 > 1px 才拉回（A+C 的核心——动画自身漂移几乎为零，
  // 这里主要兜底标签页休眠恢复 / 系统挂起等时间基跳变）。
  React.useEffect(function () {
    var timer = setInterval(function () {
      var anim = animRef.current
      if (anim === null || typeof anim.currentTime !== 'number') return
      var expected = Math.max(0, Date.now() - spanStart)
      if (Math.abs(anim.currentTime - expected) * scale > 1) anim.currentTime = expected
    }, 60000)
    return function () { clearInterval(timer) }
  }, [spanStart, scale])

  if (!hasPhase) return null
  // 旧 host 缺段时只显示文案；有效轨道恢复时 hooks 与 effect 仍保持稳定。
  if (!hasSegs) return h('div', { style: peakWrapStyle },
    h('div', { style: peakNoteStyle }, peakNoteText(phase)))
  if (!hasTrack) return null

  var children = []
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i]
    children.push(h('span', {
      key: i,
      style: {
        position: 'absolute', top: 0, height: '100%',
        left: ((seg.s - spanStart) * scale) + 'px',
        width: Math.max(1, (seg.e - seg.s) * scale) + 'px',
        background: PEAK_SEG_COLORS[seg.t] || PEAK_SEG_COLORS.off,
      },
    }))
  }
  return h('div', { style: peakWrapStyle },
    h('div', { style: peakStageStyle, 'aria-hidden': 'true', 'data-peak-stage': '' },
      h('div', { style: peakTrackStyle, ref: trackRef, 'data-peak-track': '' },
        h('div', { style: Object.assign({}, peakPatternStyle, { width: (spanMs * scale) + 'px' }) }, children),
      ),
      // marker 是轨道的兄弟，不被圆角裁切；上下两个三角同轴于 50% 锚点（x=0），
      // 色条内部无任何覆盖物（方案 K：「上下对尖」夹住「现在」）。
      h('div', { style: peakMarkerStyle, 'data-peak-marker': '' },
        h('span', { style: peakCaretStyle, 'data-peak-caret': '' }),
        h('span', { style: peakFootStyle, 'data-peak-foot': '' }),
      ),
    ),
    h('div', { style: peakNoteStyle }, peakNoteText(phase)),
  )
}

// ===========================================================================
// [0.8.1 回退记录] 内嵌充值入口（TopUpOverlay）已整体移除
// ===========================================================================
// 背景：原生 Platform 视图（WebContentsView）的 bounds 由主进程管理，窗口状态
// 变化（最大化/还原）时按 open 时的值重放，与网页层渲染的返回栏反复互相遮挡
// （返回栏消失/与图标重合/加载完成后又被盖住），真机多轮修正（open 时传栏下
// bounds、统一公式、加载态提示）仍无法在所有窗口状态下稳定。2026-10-15 用户
// 拍板：放弃该入口，充值走官方「设置 → 账号与余额」。相关状态与函数一并移除；
// focus/visibilitychange 的余额强刷（roadmap 方向 2）与充值无耦合，保留。

// [local patch] 零补丁版：胶囊注册进 DSH 官方公共席位 sidebar.footer.action
// （list 类型，与「更新 / 远程控制」等按钮同行），不再依赖任何 DSH 核心包补丁，
// 因此 DSH 升级或插件重装都不会让胶囊消失。
// flex:1 1 auto 占满按钮之外的空间；minWidth:0 允许在窄侧栏里收缩。
// [local patch 0.7.0] 该席位是多个插件共享的**横向 flex 行**，因此挂载后由 useOwnRow()
// 把容器改成可换行、并把胶囊声明成整行（flex-basis:100%），避免与其他插件抢同一行。
//
// [local patch 0.7.1] 只声明整行还不够：这一行会给条目留内距（实测内容区 x 15..334，
// 而整行可用宽度是 x 10..339），于是悬停灰底比别家按钮两侧各短约 5px。
// ds-harness-remote 的解法是显式向外贴边：
//   .dshRemoteSidebarEntry.isWide{width:calc(100% + 8px);height:34px;margin:4px -4px}
// 我们照抄同样的 4px（ROW_BLEED），让两种灰底的左右边界对齐。
var ROW_BLEED = 4
// [0.8.4] 去掉 zIndex:1000 —— 那是 0.2.1 最早版本为「浮层压在侧栏内容上」随手加的，
// 但它同时把胶囊抬到了 DSH 官方通知卡（底左悬浮卡，portal 挂在页面尾部）**上面**：
// 胶囊背景本来就是透明的，于是两段文字互相穿透，看着像「重合」。
// 现在回到 `auto`：DOM 顺序决定绘制次序，后挂的 portal（通知/浮层）自然盖住我们。
// 侧栏内容都是静态流（侧栏 CSS 里只有顶部固定按钮用 z-index:30，与底部面板不重叠），
// 所以去掉 1000 不会让详情面板被侧栏内容压住。守卫用例：test-footer-row.mjs 的 T12。
var rootStyle = { position: 'relative', flex: '1 1 auto', minWidth: 0, boxSizing: 'border-box', fontFamily: 'inherit' }
// [local patch 0.7.0] 外形与 DSH 侧栏里的其他按钮保持一致：默认**完全透明**、
// 无边框无阴影（不再是那个「边缘分明的胶囊」），只保留状态点 + 套餐额度文字；
// 只有鼠标悬停（且当前可交互）时才浮出与其他按钮同款的灰色底。
//
// 圆角/内距照抄侧栏其它条目（不是拍脑袋取的数）：
//   - 圆角 **12px**：DSH 自带的「新会话」按钮是 `border-radius:12px`；
//     社区插件 ds-harness-remote 的侧栏条目 `.dshRemoteSidebarEntry.isWide
//     .dshRemoteModeButton{height:34px;padding:6px 48px 6px 10px;border-radius:12px}`
//     同样是 12px（`iconButton` 那种 28px 圆形按钮用 50%，与条目不通用）。
//   - 内距 `6px 10px`：与上面那条 Remote 规则的左内距一致，悬停底色左右留白对得上。
// 改这两个值前先去那两个出处核对，别再凭感觉调。
//
// ⚠️ 这里**绝不能**写行内 `background`：行内样式优先级高于任何选择器，会把
// `:hover` 的底色彻底压死 —— 0.7.0 的第一版就踩了这个坑（鼠标移上去没有灰底，
// 但 title 提示照常弹出，说明 :hover 其实在触发、只是被行内盖住）。
// 悬停底色现在由 React 状态直接写行内（见组件里的 hot 状态），不经过选择器。
var pillStyle = { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px', appearance: 'none', border: 0, boxShadow: 'none', borderRadius: 12, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, userSelect: 'none' }
var pillRowStyle = { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', lineHeight: 1.4 }
var pillSegStyle = { display: 'inline-flex', alignItems: 'center', gap: 6 }
var dotStyle = { width: 7, height: 7, borderRadius: '50%', flex: 'none' }
// [local patch] 名称列按内容自然宽度；数值列 marginLeft:auto 贴右缘，
// 空隙自动落在名称与数值之间，胶囊随侧栏宽度变化。
// 名称用侧栏次要文字色（继承 pill 的 label-secondary），数值用主文字色，读数更清楚。
var capNameStyle = { flex: 'none', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }
// 用量值列固定宽度：保证各行百分比右缘对齐（最宽场景如 "100% 100% 100%" 也放得下）。
var capValueStyle = { flex: 'none', width: 80, marginLeft: 'auto', textAlign: 'right', color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }
var valueStyle = { fontVariantNumeric: 'tabular-nums' }

/**
 * [local patch 0.7.0] 悬停/焦点态无法内联表达，这里注入一枚极小的样式表。
 * 只针对本插件自己的类名，不碰 DSH 的任何选择器；同名标签只会插一次。
 */
function ensureStyles() {
  if (typeof document === 'undefined' || document.head == null) return
  if (typeof document.querySelector === 'function' && document.querySelector('style[data-plan-usage-style]') !== null) return
  var tag = document.createElement('style')
  tag.dataset.planUsageStyle = '1'
  tag.textContent = [
    // 兜底的基础底色（正常情况下行内也写着 transparent）。
    '.dsh-plan-usage-pill{background:transparent}',
    // 悬停/聚焦底色由 React 状态写行内（见 hotHook），这里只补键盘聚焦的可见轮廓。
    '.dsh-plan-usage-pill[data-interactive]:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:-2px}',
  ].join('')
  document.head.appendChild(tag)
}
// [local patch] 侧栏版面板：left:0/right:0 使其宽度 = 胶囊宽度，
// 左边界与胶囊左侧对齐（不再超出屏幕左缘），右边界与胶囊右侧一致，
// 随侧栏宽度自动伸缩；minWidth 去掉以免窄栏溢出。
var panelStyle = { position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 10px)', minWidth: 0, width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 12, background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 8px 28px rgba(0,0,0,0.22)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, overflowY: 'auto', maxHeight: '70vh' }
var panelTitleStyle = { fontWeight: 600, margin: '0 0 10px', fontSize: 13 }
var sectionTitleStyle = { fontWeight: 600, margin: '10px 0 4px', fontSize: 12 }
var rowStyle = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }
var rowLabelStyle = { width: 44, flex: 'none', color: 'var(--dsw-alias-label-secondary)' }
var barStyle = { flex: 1, height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l1)', overflow: 'hidden' }
var barFillStyle = { display: 'block', height: '100%', borderRadius: 3, transition: 'width 0.2s ease' }
// 列宽全部固定（label/bar/百分比/剩余时间），保证各行进度条与文字逐列对齐。
var rowPctStyle = { width: 40, textAlign: 'right', flex: 'none', fontVariantNumeric: 'tabular-nums' }
var rowResetStyle = { width: 48, flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }
var noteStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, marginTop: 6 }
var sectionNoteStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, margin: '2px 0 6px' }

/** 某套餐最差窗口：已用语义取最大值，剩余语义取最小值；无数据返回 -1。 */
function worstPercent(plan, meta) {
  var found = false
  var worst = meta.percentMode === 'remaining' ? 101 : -1
  for (var i = 0; i < WINDOWS.length; i++) {
    var v = plan[WINDOWS[i].key]
    if (!v || typeof v.percent !== 'number') continue
    found = true
    if (meta.percentMode === 'remaining') {
      if (v.percent < worst) worst = v.percent
    } else if (v.percent > worst) worst = v.percent
  }
  return found ? worst : -1
}

/**
 * [0.9.0] 自定义余额渠道的详情分区。
 *
 * 口径（严格按设计与用户要求，不多做也不臆造）：
 *   - 只显示：厂商名称、余额、币种、（降级/错误时的）状态说明；
 *   - 不显示：API Key（根本拿不到）、完整 URL、原始 JSON、错误堆栈、上游原文；
 *   - 不借用内置渠道的现金/赠金拆行、积分、额度条、峰谷条与重置时间；
 *   - 零余额是正常值（不是失败）；未指定币种时明确写「未指定币种」而不是默认人民币。
 *
 * 状态三分：
 *   1. `stale === true`（Host/客户端判定暂时失败，保留上次成功值）：数值与状态点
 *      同为灰色，脚注说明「显示的是上次成功值」；
 *   2. 有 `error`（语义/配置错误，或连续 8 次失败后的纯错误）：只显示固定诊断，
 *      **不残留旧余额**；
 *   3. 正常：主文字色 + 绿色状态点。
 */
function customBalanceSection(plan) {
  var label = typeof plan.name === 'string' && plan.name.length > 0 ? plan.name : '自定义余额'
  var hasValue = typeof plan.balance === 'number' && Number.isFinite(plan.balance)
  var currencyNote = typeof plan.currency === 'string' && plan.currency.length > 0
    ? plan.currency
    : '未指定币种'
  var inner
  if (plan.error !== undefined && plan.stale !== true) {
    // 语义/配置错误：立即提示，不拿旧值掩盖。文案来自 Host 的固定分类，不含上游原文。
    inner = h('div', {},
      h('div', { style: sectionNoteStyle }, plan.message || '余额获取失败，请检查渠道配置'),
      h('div', { style: sectionNoteStyle }, '可在「设置 → 内置插件 → Usage Dock → 自定义余额渠道」中修改或停用该条。'),
    )
  } else if (hasValue) {
    var stale = plan.stale === true
    var balRow = {
      display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0',
      fontSize: 18, fontWeight: 600,
      color: stale ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
    }
    var balDot = Object.assign({}, dotStyle, {
      width: 9, height: 9,
      background: stale
        ? 'var(--dsw-alias-label-tertiary)'
        : 'var(--dsw-alias-state-success-primary)',
    })
    inner = h('div', {},
      h('div', { style: balRow },
        h('span', { style: balDot }),
        h('span', {}, customBalanceText(plan)),
      ),
      h('div', { style: sectionNoteStyle }, '币种：' + currencyNote),
      h('div', { style: sectionNoteStyle },
        stale
          ? '余额更新暂时失败，显示的是上次成功值'
          : (plan.balance === 0 ? '余额为 0' : (plan.balance < 0 ? '余额为负（欠费）' : '余额可用'))),
    )
  } else {
    inner = h('div', { style: sectionNoteStyle }, '余额获取失败，请检查渠道配置')
  }
  return h('div', { key: plan.id },
    h('div', { style: sectionTitleStyle }, label + ' 余额'),
    inner,
  )
}

/**
 * [local patch 0.7.0] 让胶囊独占侧栏底部的一整行，而不是与其他插件抢同一行。
 *
 * 底部席位 `sidebar.footer.action` 是 **list** 类型：DSH 把所有插件注册的动作放在
 * 同一个**横向 flex 行**里（0.1.x 核心包里叫 footerActions，规则就是 `display:flex`）。
 * 胶囊此前用 `flex:1 1 auto` 参与这一行，于是和别的插件（如 ds-harness-remote，
 * 它用 order:-20 注册）挤在一起互相抢宽度。
 *
 * 做法：挂载后向上找最近的 flex 容器——
 *   - `flex-direction: row`：给容器补一条 `flex-wrap: wrap`（只动这一条，不碰其他样式），
 *     并把胶囊声明为 `flex-basis:100%`。这样胶囊必然独占一行，其他插件各自成行，
 *     上下顺序交给各插件的 slot order 决定；
 *   - 纵向容器（旧版 footArea 就是 column）：什么都不做，保持 `flex:1 1 auto`——
 *     纵向容器里 basis:100% 会被解释成「高度」，会压扁同列的其他条目。
 *
 * 用运行时探测而不是写死类名：DSH 的 CSS Module 类名带哈希（如 hHd-Xa_footerActions）、
 * 跨版本会变，而 `:has()` 在旧版 Android WebView 上又不保证支持。
 */
function useOwnRow() {
  var ref = React.useRef(null)
  var hook = React.useState(false)
  var ownRow = hook[0]
  var setOwnRow = hook[1]
  React.useEffect(function () {
    var el = ref.current
    if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return
    var node = el.parentElement
    var hops = 0
    while (node && hops < 8) {
      var cs = window.getComputedStyle(node)
      var display = cs != null && typeof cs.display === 'string' ? cs.display : ''
      if (display.indexOf('flex') !== -1) {
        var direction = (cs.flexDirection != null ? cs.flexDirection : 'row')
        if (direction.indexOf('row') === 0) {
          if ((cs.flexWrap != null ? cs.flexWrap : 'nowrap') === 'nowrap') node.style.flexWrap = 'wrap'
          setOwnRow(true)
        }
        return
      }
      node = node.parentElement
      hops++
    }
  }, [])
  return [ref, ownRow]
}

function PlanUsageBadge(props) {
  // 订阅 DSH 托管的配置：DSH 的插件配置在运行时不会热重载 Host 半，
  // 因此「取消勾选某渠道」需要在这里即时过滤，才能立刻反映到胶囊上。
  var form = props.configForm
  var config = useConfigSnapshot(form)
  var enabled = settingBool(config, "enabled", true)
  // [R3] 已保存配置的「自定义身份摘要」与全局配置代次：
  //   - 摘要变化 = 改了会影晌取数结果的字段（URL/路径/扣减/币种/凭据引用/目标确认/启停/增删）；
  //   - 代次变化 = 设置页刚保存过（含「只改了 Key」这种配置里看不出来的情况）。
  // 两者一起作为轮询 effect 的依赖：任一变化都会 abort 在途请求并丢弃旧值。
  var customSignature = customConfigSignature(config)
  var epochHook = React.useSyncExternalStore(subscribeConfigEpoch, getConfigEpoch)
  var configEpoch = epochHook

  // [R3] 显示层用**当前已保存配置**过滤：Host 还没回新数据时，已删除/停用的条目
  // 也不能因为旧 wire / 旧 carry 留在屏幕上。
  // 没有 configForm（旧宿主 / 纯 mock）时没有配置视图，退回以 Host 的 wire 为准。
  var hasConfigView = form !== null && form !== undefined
  var customIndex = customConfigIndex(config)
  // [V2] 逐条身份签名；`applied`（已显示数据所属的配置身份）在 stateHook 之后读取。
  var customSignatures = customConfigSignatureMap(config)

  // [0.8.1 回退记录] 内嵌充值入口已按用户要求**整体移除**：原生 Platform 视图
  // 的 bounds 在窗口状态变化时会被主进程按 open 时的值重放，与网页层返回栏
  // 反复互相遮挡（返回栏消失/重合/加载后又被盖），真机多轮修正仍无法稳定，
  // 2026-10-15 用户拍板放弃该入口。官方路径仍是「设置 → 账号与余额 → 充值」，
  // 详情面板余额行的提示文案会引导过去。focus/visibilitychange 的余额强刷
  // （roadmap 方向 2）与充值无耦合，保留。

  var stateHook = React.useState({ loading: true })
  var state = stateHook[0]
  var setState = stateHook[1]
  // [V2] 「已显示数据所属的配置身份」。必须在这里（stateHook 之后）读取——
  // 依赖 `state.applied` 才算得出「这条余额是不是当前配置下取的」。
  var applied = state ? state.applied : null
  // 供 effect 内的失败路径保留「上一个身份」（effect 重建时闭包变量会丢）。
  var appliedRef = React.useRef(null)
  appliedRef.current = applied
  // [W3] 成功基线与失败计数必须**跨 effect 重建**保留：配置变化只该作废真正变更的条目，
  // 不能把整表（含未改动的内置渠道）清空，否则它们首次暂时失败就直接报「获取失败」。
  var lastListRef = React.useRef(null)
  if (lastListRef.current === null) lastListRef.current = []
  var failStreaksRef = React.useRef(null)
  if (failStreaksRef.current === null) failStreaksRef.current = {}
  var customGensRef = React.useRef(null)
  if (customGensRef.current === null) customGensRef.current = {}
  // [W1/W2] 当前配置的期望摘要（Host 会用它出证）。在下面由 useMemo 计算。
  var expectedDigestRef = React.useRef('')
  var openHook = React.useState(false)
  var open = openHook[0]
  var setOpen = openHook[1]
  // [0.8.2] 外点关闭：需要拿到胶囊与详情面板的真实元素做「点击是否在卡片内」判定。
  var pillRef = React.useRef(null)
  var panelRef = React.useRef(null)
  // [local patch 0.7.0] 悬停/聚焦态由 React 状态驱动，而不是靠 CSS :hover ——
  // 行内样式优先级高于任何选择器，用 :hover 会被行内 background 压死（第一版就是这样翻车的）。
  // 状态驱动顺带解决了焦点态：键盘 Tab 聚焦也能看到同款底色。
  var hotHook = React.useState(false)
  var hot = hotHook[0]
  var setHot = hotHook[1]
  // [local patch 0.7.0] 底部席位是被多个插件共享的横向 flex 行：让自己独占一行。
  var rowHook = useOwnRow()
  var rootRef = rowHook[0]
  var ownRow = rowHook[1]

  // [local patch] 侧栏折叠（wide→false）时自动收起详情面板：rail 窄条下
  // absolute 面板会溢出错乱，折叠即关闭。
  React.useEffect(function () {
    if (props.wide === false) setOpen(false)
  }, [props.wide])

  // [0.8.2] 详情卡片打开时，点击卡片外的任意位置自动关闭；Esc 同样关闭。
  //   - 开/关仍由胶囊的 click 翻转（键盘 Enter 也能开）。这里只负责「外部按下」：
  //     pointerdown 走 window 捕获，比 click 更早，也不受宿主 UI 冒泡阶段的
  //     stopPropagation 影响；按在胶囊或面板内（parentElement 上溯 /
  //     Shadow DOM composedPath）不关，按在外部立即关——关闭发生在按下瞬间，
  //     观感接近原生浮层。胶囊自身的按下会命中「卡片内」判定，天然豁免；
  //   - 窗口失焦/切换应用不清面板：只响应「明确点在面板外」的动作。
  // 面板仅在展开态渲染，监听只在 open && wide 时存在，收起即随之拆除。
  // [0.8.3] 用户反馈「点空白偶尔不关」：只挂 pointerdown 时有三类盲区——
  //   ① 旧 Android WebView / 非 PointerEvent 宿主根本不投递 pointerdown；
  //   ② 键盘 Enter/Space 激活面板外的按钮只有 click，没有按下事件；
  //   ③ 某些宿主把 pointerdown 吞掉（自己 preventDefault/stopPropagation 的
  //      手势层）。故按下类事件补 mousedown/touchstart，并额外挂 click 兜底。
  //   去重靠 downInside：只有「这次交互没有从卡片内按下」时 click 才关，
  //   这样面板里拖选文字、松手落到面板外（click 的 target 变成共同祖先）
  //   不会被误判成外点。setOpen(false) 幂等，多个事件重复命中无副作用。
  var panelOpenNow = open && props.wide !== false
  React.useEffect(function () {
    if (!panelOpenNow) return
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    // 「是否点在卡片内」：从事件 target 沿 parentElement 上溯到胶囊根或面板即算内。
    // 用上溯而不是 root.contains(node)：面板/胶囊的嵌套子节点在真实 DOM 里
    // 会逐层挂 parentElement，mock 测试的假节点也一样，两端语义一致。
    // ref 在事件发生时现读（不闭包捕获）：重渲染后 ref 总是指向当前元素。
    // 最近一次按下是否落在卡片内（null = 本轮交互还没有按下事件）：
    // click 兜底靠它区分「键盘/被吞掉的点击」与「从面板里拖选到外面」。
    var downInside = null
    function inCard(node) {
      var root = rootRef.current
      var panel = panelRef.current
      var hops = 0
      var n = node
      while (n && hops < 16) {
        if (root !== null && n === root) return true
        if (panel !== null && n === panel) return true
        // Shadow DOM：composedPath 命中胶囊根/面板即算「卡片内」。
        if (typeof n.composedPath === 'function') {
          var path = n.composedPath()
          for (var i = 0; i < path.length; i++) {
            if ((root !== null && path[i] === root) || (panel !== null && path[i] === panel)) return true
          }
        }
        n = n.parentElement
        hops++
      }
      return false
    }
    function onOutside(event) {
      var inside = inCard(event.target)
      downInside = inside
      if (!inside) setOpen(false)
    }
    function onClickOutside(event) {
      var inside = inCard(event.target)
      // 键盘激活（无按下事件）或按下事件被宿主吞掉时的兜底；从卡片内开始的交互不关。
      if (downInside !== true && !inside) setOpen(false)
      downInside = null
    }
    function onKey(event) {
      if (event && event.key === 'Escape') setOpen(false)
    }
    // 按下类事件三种都挂：pointerdown 首选（覆盖鼠标/触摸/笔且最早），
    // mousedown/touchstart 只在宿主不投递 PointerEvent 时才生效，重复触发无副作用。
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('mousedown', onOutside, true)
    window.addEventListener('touchstart', onOutside, { capture: true, passive: true })
    window.addEventListener('click', onClickOutside, true)
    document.addEventListener('keydown', onKey, true)
    return function () {
      window.removeEventListener('pointerdown', onOutside, true)
      window.removeEventListener('mousedown', onOutside, true)
      window.removeEventListener('touchstart', onOutside, { capture: true, passive: true })
      window.removeEventListener('click', onClickOutside, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [panelOpenNow])

  // [local patch 0.8.0] 轮询数据层重写：
  //   1. **失败降级**（roadmap 方向 3 定稿）：单渠道失败先保留上次成功值、数值
  //      用灰色弱化（不加「更新于」标注）；连续 FAIL_THRESHOLD 轮失败才显示
  //      「获取失败」。整体请求失败按「所有渠道 +1 轮」同样处理。
  //   2. **轮询防卡死**：fetch 加 AbortController 20s 超时；请求 settle（成功/
  //      失败/超时）后 in-flight 标记必然复位——旧版请求挂起即轮询永久停摆。
  //   3. **手动强刷**：load(true) 作废旧请求立即重拉（点开面板 / 窗口 focus /
  //      visibilitychange 触发，见下方 effect）。
  var loadRef = React.useRef(null)

  // [W1/W2] 当前配置的期望摘要：与 Host 的 `configDigestOf()` **同一套规则**。
  // 它只包含公开元数据 + 非密修订号，不含 Key。
  var expectedDigest = configDigestOfClient(config)
  expectedDigestRef.current = expectedDigest

  React.useEffect(function () {
    if (enabled === false) return
    var alive = true
    var controller = null // 当前 in-flight 请求的 AbortController（null = 空闲）
    // [X2] **不要**把摘要读进闭包变量：另一窗口保存 Key 只会改变 `customKeyRev`，
    // 配置对象每轮 render 都会重算 `expectedDigestRef.current`。闭包一旦缓存旧值，
    // 后续所有响应都会被当成「旧配置」拒绝，强刷也恢复不了。
    // 因此所有比较都通过 ref 读**当前**摘要。
    // [W3] 成功基线与失败计数**按渠道 id 保留**，放在组件级 ref 里。
    // effect 因配置变化重建 ≠ 清空全表：只有身份确实变了/停用/删除的条目才失效，
    // 未改动的渠道（含内置）继续沿用它们的旧值与失败计数。
    var lastList = lastListRef.current
    var failStreaks = failStreaksRef.current
    // [0.9.0] 自定义条目 id → 最近一次见到的配置代次（见 generationChanged）。
    var customGens = customGensRef.current
    var timer = null

    // [W3/X2] 只作废「这条的身份确实变了」的条目，保留其它渠道的基线与计数。
    // 判据：成功响应时记录的 `applied.entries`（id → 当时的身份，**含公开 Key 修订号**）
    // 与当前身份比较。没有 applied 快照（从未成功过）时全部保留——基线本来就不存在。
    var prevEntries = appliedEntriesOf(appliedRef.current)
    var pruned = []
    for (var pi = 0; pi < lastList.length; pi += 1) {
      var prevItem = lastList[pi]
      if (prevItem === null || prevItem === undefined || typeof prevItem.id !== 'string') continue
      if (isCustomLike(prevItem)) {
        var savedNow = customIndex[prevItem.id]
        if (savedNow === undefined || savedNow.enabled === false) {
          delete failStreaks[prevItem.id]
          delete customGens[prevItem.id]
          continue
        }
        if (prevEntries !== null) {
          var before = prevEntries[prevItem.id]
          // [X2] 用渲染期算好的逐条身份（含该条公开 Key 修订号）。
          var now = customSignatures[prevItem.id]
          if (before !== undefined && before !== now) {
            // 这条改过（含「只改 Key」）→ 旧值作废；未改动的条目不受牵连。
            delete failStreaks[prevItem.id]
            delete customGens[prevItem.id]
            continue
          }
        }
      }
      pruned.push(prevItem)
    }
    lastList = pruned
    lastListRef.current = pruned
    // [W3] 成功基线与失败计数**按渠道 id 保留**，放在组件级 ref 里。
    // effect 因配置变化重建 ≠ 清空全表：只有身份确实变了/停用/删除的条目才失效，
    // 未改动的渠道（含内置）继续沿用它们的旧值与失败计数。
    var lastList = lastListRef.current
    var failStreaks = failStreaksRef.current
    // [0.9.0] 自定义条目 id → 最近一次见到的配置代次（见 generationChanged）。
    var customGens = customGensRef.current
    var timer = null

    /**
     * [W1/W2] 这份响应能否证明「Host 用的是我当前保存的配置」。
     *
     * 0.9.0 靠「浏览器见过这个 gen 吗」，于是
     *   ① 首个请求被取消（从没记过 gen）时，Host 旧缓存返回的旧配置 wire 被直接接受；
     *   ② 重复保存同一把 Key 时 gen 不变，脏标记永远拒绝、无法恢复。
     *
     * 现在只看 Host 自己出的证：`data.cfg.digest` 是 Host **用实际读到的 cfg** 算的摘要，
     * 客户端用当前保存的配置算同一个摘要，相等才认。Key 不参与摘要，但「保存动作」
     * 通过 `customKeyRev` 进入摘要，因此幂等写入也能在 Host 读到新配置后恢复。
     * 旧 Host（不返回 cfg）退回「不校验」，避免把老版本用户全部打挂。
     */
    function responseMatchesCurrentConfig(result) {
      if (!hasConfigView) return true
      var proof = result && result.data ? result.data.cfg : null
      if (proof === null || proof === undefined || typeof proof.digest !== 'string') return true
      // [X2] 每次都读 ref 里的**当前**摘要：另一窗口保存 Key 后 `customKeyRev` 变化，
      // 摘要随之改变；若比较闭包里的旧值，匹配新修订的正确结果会被永久拒绝。
      return proof.digest === expectedDigestRef.current
    }

    function findPlan(list, id) {
      if (!Array.isArray(list)) return null
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i]
      }
      return null
    }

    /**
     * [0.9.0] 自定义条目的「配置代次」判定：Host 会给每个自定义 wire 条目附 `gen`
     * （身份字段 + Key 指纹的短哈希）。代次变化意味着 URL / Key / 凭据引用 / JSON 路径 /
     * 币种 / 停用状态改过了——此时**必须作废**该条的旧成功值、失败计数与在途响应，
     * 否则会出现「旧账户余额配新 URL」「旧币种配新数值」这类串账。
     *
     * 返回 true 表示本轮结果属于新代次，需要先清掉旧状态。
     */
    function generationChanged(plan) {
      if (!isCustomPlan(plan)) return false
      var prevGen = customGens[plan.id]
      if (typeof plan.gen !== 'string' || plan.gen.length === 0) return false
      if (prevGen === undefined) {
        customGens[plan.id] = plan.gen
        return false
      }
      if (prevGen === plan.gen) return false
      customGens[plan.id] = plan.gen
      delete failStreaks[plan.id]
      return true
    }

    /**
     * 把本轮取数结果合并进展示列表：失败渠道沿用旧值（标 stale）直到连续
     * FAIL_THRESHOLD 轮失败；成功渠道替换新值并清零计数。next=null 表示整体
     * 失败，对所有渠道做同样的「沿用 + 计数」。
     */
    function settle(next) {
      var merged = []
      var seen = {}
      var source = Array.isArray(next) ? next : []
      // [0.9.0] 先处理代次：配置身份变了的条目，其旧值一律不参与本轮合并。
      var invalidated = {}
      for (var g = 0; g < source.length; g++) {
        var probe = source[g]
        if (!probe || typeof probe.id !== 'string') continue
        if (generationChanged(probe)) invalidated[probe.id] = true
      }
      for (var i = 0; i < source.length; i++) {
        var plan = source[i]
        if (!plan || typeof plan.id !== 'string') continue
        seen[plan.id] = true
        // [W3] 自定义条目被停用：Host 回 {enabled:false} 且不请求。这里把它从
        // 展示列表里彻底移除（seen 已置位，carry 不会用旧值把它复活），
        // 同时清掉失败计数与代次记录。
        if (isCustomPlan(plan) && plan.enabled === false) {
          delete failStreaks[plan.id]
          delete customGens[plan.id]
          continue
        }
        if (plan.error) {
          // [A04] Host 现在会给出**统一结论** `effectiveStatus`，客户端优先消费它，
          // 不再自己累加一套失败次数（否则胶囊与模型会各数一套）。
          //   - failed / expired：已达到判据（第 5 次或明确失效），直接展示错误；
          //   - cached：前 4 次暂时失败，沿用旧值并灰化；
          //   - ok：正常。
          if (plan.effectiveStatus === 'failed' || plan.effectiveStatus === 'expired') {
            delete failStreaks[plan.id]
            merged.push(plan)
            continue
          }
          if (plan.effectiveStatus === 'cached') {
            /**
             * [R3-03] **Host 的有效值优先**。
             *
             * 之前优先用本地 `lastList`，于是：
             *   - 胶囊见过 1、Host 缓存已是 321 → 仍显示 1（本地旧值覆盖 Host 新值）；
             *   - 新窗口无本地基线 → 直接显示「获取失败」。
             * 现在 Host 在 cached 时会补齐数值（`balanceFromCache`），客户端直接用它；
             * 仅当 Host 没有提供数值时才回退本地基线（兼容旧响应）。
             */
            var hostHasValue = plan.balanceFromCache === true
              || (typeof plan.creditsTotal === 'number')
              || (typeof plan.balance === 'number')
              || (Array.isArray(plan.windows) && plan.windows.length > 0)
            if (hostHasValue) {
              merged.push(Object.assign({}, plan, {
                error: undefined,
                stale: true,
                staleMessage: plan.message || '',
              }))
              continue
            }
            var prevCached = invalidated[plan.id] === true ? null : findPlan(lastList, plan.id)
            if (prevCached && !prevCached.error) {
              merged.push(Object.assign({}, prevCached, { stale: true, staleMessage: plan.message || '' }))
            } else {
              merged.push(plan)
            }
            continue
          }
          // 缺凭据、登录失效等语义错误立即透传；仅暂时的网络/执行错误允许保留旧值。
          // [0.8.5] host 可以在条目上显式标 transient:true（目前 WorkBuddy 渠道用它
          // 区分「限流/5xx/超时/结构变化」与「登录失效」），显式标记优先于按 error 名猜。
          var transient = plan.transient === true
            || plan.error === 'curl' || plan.error === 'exec' || plan.error === 'rpc'
            || (plan.error === 'http' && /HTTP (429|5\d\d)/.test(plan.message || ''))
          if (!transient) {
            delete failStreaks[plan.id]
            merged.push(plan)
            continue
          }
          var streak = (failStreaks[plan.id] || 0) + 1
          failStreaks[plan.id] = streak
          // 代次变了：旧值作废，即使还没到阈值也不沿用（避免串账）。
          var prev = invalidated[plan.id] === true ? null : findPlan(lastList, plan.id)
          if (prev && !prev.error && streak < FAIL_THRESHOLD) {
            merged.push(Object.assign({}, prev, { stale: true, staleMessage: plan.message || '' }))
          } else {
            // 连续失败达到阈值：host 的错误条目本来就不带数据，直接展示。
            merged.push(plan)
          }
        } else {
          delete failStreaks[plan.id]
          merged.push(plan)
        }
      }
      // 整体失败（next=null）或本轮缺某渠道：沿用旧条目。
      var carry = Array.isArray(lastList) ? lastList : []
      for (var j = 0; j < carry.length; j++) {
        var old = carry[j]
        if (!old || typeof old.id !== 'string' || seen[old.id]) continue
        // [R3/R4] 自定义条目的「消失」必须按**权威列表**判定，不能靠 custom 标记：
        //   ① 配置里删掉/停用了 → 当前已保存配置里找不到（或 enabled:false）：
        //      **直接丢弃**并清掉计数与代次记录，不能沿用旧值，更不能复活；
        //   ② 仍在使用中但本轮没回（整体失败 next===null / 单条被跳过）→ 沿用旧值。
        if (isCustomLike(old)) {
          var savedEntry = customIndex[old.id]
          if (savedEntry === undefined || savedEntry.enabled === false) {
            delete failStreaks[old.id]
            delete customGens[old.id]
            continue
          }
          if (next !== null) {
            // 新一轮成功响应里没有它，但配置里还在：Host 侧按条目隔离，通常意味着
            // 该条本轮被跳过/超预算。按暂时失败沿用（下面统一计数），不要凭空清空。
          }
        }
        if (old.error) {
          merged.push(old) // 静态错误行（如 no-key）原样保留，不计入失败轮数
          continue
        }
        var streak2 = (failStreaks[old.id] || 0) + 1
        failStreaks[old.id] = streak2
        if (streak2 < FAIL_THRESHOLD) {
          merged.push(Object.assign({}, old, { stale: true, staleMessage: '获取失败' }))
        } else {
          // [local patch 0.8.0] 连续失败达到阈值：转为**纯错误条目**——必须剥掉
          // 旧的 balance / 窗口数据，否则胶囊的余额分支会拿着旧值当正常数据渲染
          // （红灯 + 旧数字），用户看不到「获取失败」。
          //
          // [R4] 但**不能剥掉身份**：0.9.0 把 custom/gen 一起丢了，于是这条错误行
          // 不再被认成自定义条目，用户删除该记录后它仍走普通 carry 永久残留
          // （显示成「custom:xxx 获取失败」）。现在保留 custom/gen/name，
          // 只剥余额与窗口数据。
          var stripped = {
            id: old.id,
            name: old.name,
            error: 'rpc',
            message: '获取失败',
          }
          if (isCustomLike(old)) {
            stripped.custom = true
            if (typeof old.gen === 'string') stripped.gen = old.gen
          }
          merged.push(stripped)
        }
      }
      lastList = merged
      lastListRef.current = merged
      failStreaksRef.current = failStreaks
      customGensRef.current = customGens
      return merged
    }

    /**
     * [W1] Host 配置未生效时的展示列表：**只保留仍然可信的条目**。
     *
     * 整批数据来源不可信（Host 读的是旧配置）时：
     *   - 自定义条目一律不显示（它们的配置身份无法确认）；
     *   - 内置渠道的配置没变，但整批响应也可能来自旧配置——保守起见同样只保留
     *     上一次**已验证**的成功基线，且不推进失败计数（这一轮不算它们的失败）。
     */
    function settleStaleOnly() {
      var kept = []
      var carry = Array.isArray(lastList) ? lastList : []
      for (var i = 0; i < carry.length; i++) {
        var old = carry[i]
        if (old === null || old === undefined || typeof old.id !== 'string') continue
        if (isCustomLike(old)) continue
        if (old.error) { kept.push(old); continue }
        kept.push(Object.assign({}, old, { stale: true, staleMessage: '配置生效中' }))
      }
      return kept
    }

    // [V2] 「本轮数据所属的配置身份」。渲染时用它判断已显示的数据是否还属于当前配置。
    // 只在拿到**成功响应**时更新：失败/降级沿用旧值时保留旧的 applied，
    // 这样旧值仍会被签名/dirty 判定拦住，不会因为一次失败又冒出来。
    // 用 ref 而不是闭包变量：失败路径发生在**新** effect 闭包里，闭包变量会丢掉上一个身份。
    var appliedIdentity = appliedRef.current

    function applyResult(result) {
      if (!alive) return
      if (result && typeof result === 'object' && result.error === 'disabled') {
        setState({ ok: false, error: 'disabled' })
        return
      }
      if (result && typeof result === 'object' && result.ok && result.data
        && Array.isArray(result.data.plans)) {
        // [W1/W2] 先验来源：Host 是否用**当前**配置取的数。
        // 不一致 = 它读到的还是旧配置（2 秒缓存 / 尚未重读）。这时整批数据都不可信，
        // 既不能显示，也不能把它标成「当前配置的 applied」。
        var trusted = responseMatchesCurrentConfig(result)
        if (!trusted) {
          setState({
            ok: true,
            data: { plans: settleStaleOnly() },
            applied: appliedIdentity,
            pendingConfig: true,
          })
          return
        }
        appliedIdentity = { epoch: configEpoch, digest: expectedDigestRef.current, entries: customConfigSignatureMap(config) }
        appliedRef.current = appliedIdentity
        lastListRef.current = settle(result.data.plans)
        setState({ ok: true, data: { plans: lastListRef.current }, applied: appliedIdentity })
        return
      }
      // 请求失败：有旧数据就降级展示，否则按整体失败提示。
      if (Array.isArray(lastList) && lastList.length > 0) {
        setState({
          ok: true,
          data: { plans: settle(null) },
          // 沿用旧数据时保留**旧**的身份：配置已变的条目会被渲染层拦掉。
          applied: appliedIdentity,
        })
      } else {
        setState({
          ok: false,
          error: 'rpc',
          message: result && typeof result.message === 'string' ? result.message : null,
        })
      }
    }

    function load(force) {
      if (controller) {
        if (force !== true) return // 已有请求在飞：常规轮询直接跳过（防重入）
        // 手动强刷：作废旧请求并立即重拉。旧请求标记 superseded——它的
        // 失败回调不计入失败轮数、清理回调不碰新一轮的计时器。
        controller.superseded = true
        controller.abort()
      }
      if (timer) { clearTimeout(timer); timer = null }
      var aborter = typeof AbortController === 'function' ? new AbortController() : null
      // 请求身份与 AbortController 解耦：裁剪版 WebView 无 AbortController 仍防重入。
      controller = { abort: function () { if (aborter) aborter.abort() }, superseded: false }
      var current = controller
      var timeout = new Promise(function (_resolve, reject) {
        // [0.8.3] 20s → 30s（用户 2026-10-16 实测：WorkBuddy 实时计费查询偶发超时，
        // 20s 偏紧；超时被归为 transient 失败，会推进「获取失败」轮数）。
        // [0.8.5] 30s → 40s：Host 的 WorkBuddy 单次读取上限已提到 35s（要等
        // workbuddy-connect 自己的 30s 计费超时落地，才能拿到结构化错误原因）。
        // 浏览器侧若仍是 30s，会**先**掐断整个 /api/plan-usage，连带所有渠道一起失败。
        // 因此这里必须严格大于 35s，且留 5s 余量。
        timer = setTimeout(function () { current.abort(); reject(new Error('usage timeout')) }, 40000)
      })
      // 包含 json 解析的超时；即使底层不能取消，也会释放请求锁并忽略迟到结果。
      var pending = Promise.resolve().then(function () {
        return fetch('/api/plan-usage', aborter ? { signal: aborter.signal } : undefined)
      }).then(function (r) { return r.json() })
      Promise.race([pending, timeout])
        .then(function (result) {
          if (alive && current === controller && !current.superseded) applyResult(result)
        })
        .catch(function () {
          if (alive && current === controller && !current.superseded) applyResult(null)
        })
        .finally(function () {
          if (current === controller && timer) { clearTimeout(timer); timer = null }
          if (current === controller) controller = null
        })
    }

    // 强刷入口暴露给组件（面板展开 / focus / visibilitychange 用）。
    loadRef.current = load
    load()
    // [local patch] 用量刷新间隔 30 秒（原 60 秒）。
    var interval = setInterval(function () { load(false) }, 30000)
    return function () {
      alive = false
      clearInterval(interval)
      if (timer) clearTimeout(timer)
      if (controller) {
        controller.superseded = true
        controller.abort()
      }
      controller = null
      loadRef.current = null
    }
    // [R3/X2] 依赖里加上「已保存配置身份」「配置代次」与「期望摘要」：
    //   - customSignature 变化（改 URL / 路径 / 币种 / 凭据引用 / 启停 / 增删）→
    //     effect 重跑：cleanup 会 abort 在途请求，并按条目作废旧值与失败计数。
    //   - configEpoch 由**本页**设置页保存成功后 bump，用于覆盖「只改 Key、配置字段没变」。
    //   - expectedDigest 覆盖**别的窗口**保存 Key：那种情况本页不会收到 epoch 事件，
    //     只有 form 快照里的 `customKeyRev` 变了。把它作为依赖，effect 才会重跑、
    //     在途旧请求才会被 abort，且新闭包比较的是新摘要（X2）。
  }, [enabled, customSignature, configEpoch, expectedDigest])

  // [local patch 0.8.0] 立即刷新触发点（roadmap 方向 2 保底方案）：
  // 窗口 focus / 标签页重新可见时强拉一次——充值页是覆盖窗口的原生视图，
  // 支付完成返回时窗口重新聚焦，正好接住「充值后余额同步」。
  React.useEffect(function () {
    if (enabled === false) return
    var refresh = function () {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      if (loadRef.current) loadRef.current(true)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return function () {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [enabled])

  // [0.8.2] 展开动画：面板从胶囊处向上展开（下缘为原点，轻微上浮 + 渐显），
  // 参考 DSH 桌面端左侧工作区「点击项目展开会话记录」的入场动效语言。
  // 走 WAAPI（element.animate，transform/opacity 合成器路径，与峰谷条动画同款）：
  //   - 无 WAAPI 的环境（旧 WebView / 测试 mock）直接静态呈现，行为与 0.8.1 一致；
  //   - 只在「面板出现」那一帧播一次；打开期间的数据刷新不重播（deps 只有 open）。
  React.useEffect(function () {
    var el = panelRef.current
    if (!panelOpenNow || !el || typeof el.animate !== 'function') return
    var anim = el.animate(
      [
        { transform: 'translateY(6px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      { duration: 170, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
    return function () { anim.cancel() }
  }, [panelOpenNow])

  if (enabled === false || (state && state.error === 'disabled')) return null

  // 只展示当前仍启用的套餐（禁用后旧数据一并丢弃）。
  var data = state && state.ok ? state.data : null
  var plans = data && Array.isArray(data.plans) ? data.plans : []
  // 按 DSH 托管的配置过滤：Host 半的配置在插件加载时读取、运行时不热重载，
  // 所以这里必须再筛一次，取消勾选才能立即生效。
  plans = plans.filter(function (p) {
    if (p == null) return false
    // [0.9.0] 已退场的内置渠道：即使 Host 仍返回（旧 Host + 新客户端），也不画行。
    if (isRetiredPlanId(p.id)) return false
    // [R3/R4/V2] 自定义条目以**当前已保存配置**为准，而不是 wire 里的 enabled：
    //   - 配置里已删除 → 立刻不显示（哪怕旧 wire / 旧 carry 还带着它）；
    //   - 配置里已停用 → 立刻不显示；
    //   - 错误行丢了 custom 标记也照样按 id 认出并清理（isCustomLike）；
    //   - 已显示的数据必须仍然「属于当前配置」：改 URL/路径/币种/引用/目标确认或只改 Key，
    //     都会让上一条成功余额**立刻**失效，不等新请求返回（见 customDataStillValid）。
    // 没有配置视图时（configForm 缺失 / 旧宿主）退回 Host 的判定——那是有权限的一方。
    if (isCustomLike(p)) {
      if (!hasConfigView) return p.enabled !== false
      // 已删除 / 已停用：立刻不显示（与 wire 里的 enabled 无关）。
      var savedEntry = customIndex[p.id]
      if (savedEntry === undefined || savedEntry.enabled === false) return false
      // 已显示的数据必须仍属于当前配置（V2）。
      return customDataStillValid(p.id, applied, customSignatures)
    }
    var meta = planMeta(p.id)
    var key = meta.fields && meta.fields.enabled
    return key === undefined || settingBool(config, key, true)
  })
  // [顺序修复 2026-10-20 第三次] **全局混排**：内置与自定义渠道共用同一 `planOrder`。
  //
  // 用户已明确要求：OpenRouter 这类自定义渠道必须能移到 Codex / WorkBuddy **之前**，
  // 所有渠道统一上下排序；设置页卡片、侧栏胶囊、详情面板共用同一顺序。
  //
  // 旧的「内置在前 + 自定义在后」分组（`sortPlansByOrder(builtIns).concat(customs)`）
  // 从设计上就做不到跨组移动 —— 这是审核指出的
  // FAIL_BADGE_FORCES_CUSTOM_AFTER_BUILTINS / FAIL_DETAIL_FORCES_CUSTOM_AFTER_BUILTINS。
  //
  // 现在只做一件事：按 `planOrder` 对**完整列表**排序，未列入的按原有相对顺序追加。
  // 不再分成两组，也不再有 `concat` 造成的强制分组。
  plans = sortPlansByOrder(plans, config.planOrder)

  // 胶囊：多行，每个套餐一行。用量类套餐展示 5小时/周限/月限 三个窗口的
  // 百分比；余额类套餐（deepseek / mimo，带 balanceThreshold）只显示剩余余额
  // （带币种符号，向下取整到分），余额低于阈值时状态灯红灯。
  // [local patch 0.8.0] 失败降级：plan.stale=true 表示该渠道本轮取数失败、正在
  // 保留旧值——数值用灰色弱化（不加「更新于」标注），状态灯转灰。
  var capsuleRows = []
  var pillTitle = PLAN_NAME
  for (var i = 0; i < plans.length; i++) {
    var plan = plans[i]
    var meta = planMeta(plan.id)
    // [0.9.0] 自定义余额渠道：成功显示「名称 + 币种余额」，暂时失败保留旧值并灰化，
    // 语义错误（鉴权/配置/缺 Key）立即显示可操作提示，绝不拿旧值顶着。
    // 名称过长时胶囊里省略（tooltip 给完整名称），数值列仍右对齐（capValueStyle）。
    if (isCustomPlan(plan)) {
      var customLabel = typeof plan.name === 'string' && plan.name.length > 0 ? plan.name : '自定义余额'
      if (typeof plan.balance === 'number' && plan.error === undefined) {
        capsuleRows.push({
          dot: plan.stale === true
            ? 'var(--dsw-alias-label-tertiary)'
            : 'var(--dsw-alias-state-success-primary)',
          label: customLabel,
          values: [customBalanceText(plan)],
          stale: plan.stale === true,
          title: customLabel + ' ' + customBalanceText(plan),
        })
      } else if (plan.error === 'no-key') {
        capsuleRows.push({ dot: null, label: customLabel, values: ['请设置 Key'], stale: false })
      } else if (plan.error === 'credential-unconfirmed') {
        capsuleRows.push({ dot: null, label: customLabel, values: ['凭据待确认'], stale: false })
      } else if (plan.error === 'auth') {
        // [0.9.0] 明确鉴权错误：胶囊里必须能看出「要动 Key」，不能笼统说获取失败
        // （否则用户会一直等它自己恢复）。细节在详情面板。
        capsuleRows.push({ dot: 'var(--dsw-alias-state-error-primary)', label: customLabel, values: ['鉴权失败'], stale: false })
      } else if (plan.error === 'config' || plan.error === 'endpoint') {
        // 配置类错误：URL / 键路径 / 端点不对，同样需要用户动手。
        capsuleRows.push({ dot: 'var(--dsw-alias-state-error-primary)', label: customLabel, values: ['配置有误'], stale: false })
      } else {
        capsuleRows.push({ dot: null, label: customLabel, values: ['获取失败'], stale: false })
      }
      continue
    }
    // [local patch 0.8.1] WorkBuddy 积分渠道：右侧显示剩余积分（千分位）；
    // [0.8.3] 「（积分）」全角后缀改为「✦」前缀（U+2726，单色、随主题深浅）。
    // ✦ 用 starFixStyle(12)=8px 缩放（进宽 ≈ ¥），并用 valueFlexStyle 做 flex
    // **中心对齐**——Android Noto 把 ✦ 画得偏下，基线对齐会低 2–3px（实测），
    // flex 的 align-items:center 不依赖字体基线，两端都居中。
    //
    // [0.8.3] 国内版 WorkBuddy 与国际版 WorkBuddy AI 的积分**不通用**
    //（用户 2026-10-17 在第二台设备实测发现）：Host 的 variants 已给出各版本
    // 独立小计，这里**按版本各占一行**分别显示，而不是把两版加成一个合计。
    // 未登录/未配置的版本不会出现在 variants 里，因此不会产生空行。
    if (meta.creditMode === true && (typeof plan.creditsTotal === 'number' || plan.creditsUnlimited === true)) {
      var wbVariants = Array.isArray(plan.variants) && plan.variants.length > 0 ? plan.variants : null
      var wbDot = plan.stale === true
        ? 'var(--dsw-alias-label-tertiary)'
        : 'var(--dsw-alias-state-success-primary)'
      if (wbVariants !== null) {
        for (var vi = 0; vi < wbVariants.length; vi++) {
          var variant = wbVariants[vi]
          if (variant == null || typeof variant !== 'object') continue
          var vNum = variant.unlimited === true ? '∞'
            : (typeof variant.total === 'number' ? formatCredit(variant.total) : '—')
          capsuleRows.push({
            dot: wbDot,
            label: typeof variant.label === 'string' && variant.label.length > 0 ? variant.label : meta.name,
            values: ['✦' + STAR_GAP + vNum],
            valueNodes: [
              h('span', { style: starFixStyle(12), key: 'star' }, '✦'),
              h('span', { style: { marginLeft: '0.34em' }, key: 'num' }, vNum),
            ],
            valueFlex: true,
            stale: plan.stale === true,
          })
        }
        continue
      }
      // 旧 Host（无 variants）：退回单行合计显示，保持向后兼容。
      var wbNum = plan.creditsUnlimited === true ? '∞' : formatCredit(plan.creditsTotal)
      capsuleRows.push({
        dot: wbDot,
        label: meta.name,
        values: ['✦' + STAR_GAP + wbNum], // title / 无障碍文本用纯字符串
        valueNodes: [
          h('span', { style: starFixStyle(12), key: 'star' }, '✦'),
          h('span', { style: { marginLeft: '0.34em' }, key: 'num' }, wbNum),
        ],
        valueFlex: true,
        stale: plan.stale === true,
      })
      continue
    }
    // [local patch] 余额类套餐：右侧只显示剩余余额，低于阈值红灯。
    if (meta.balanceThreshold !== undefined && typeof plan.balance === 'number') {
      // 阈值优先取 host 下发的配置值；0 表示不警告。
      var threshold = typeof plan.warnThreshold === 'number' ? plan.warnThreshold : meta.balanceThreshold
      var low = threshold > 0 && plan.balance < threshold
      // 注意：不能用 toneColor(90)——它按「用量百分比」语义返回红色；
      // 余额充足用 success 绿，低于阈值用 error 红，降级保留旧值用灰色。
      var dot = plan.stale
        ? 'var(--dsw-alias-label-tertiary)'
        : (low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)')
      var balText = balanceSymbol(plan.currency) + floorToCent(plan.balance)
      capsuleRows.push({ dot: dot, label: meta.name, values: [balText], stale: plan.stale === true })
      continue
    }
    // [Z4] 多币种：没有可合计的统一总额。明确说「多币种」，
    // 既不能冒充「获取失败」（数据其实已经拿到了），也不能编造跨币总额。
    if (plan.mixedCurrency === true && typeof plan.balance !== 'number') {
      capsuleRows.push({ dot: null, label: meta.name, values: ['多币种'], stale: plan.stale === true })
      continue
    }
    plan = adaptHostWindows(plan, meta)
    var worst = worstPercent(plan, meta)
    if (worst >= 0) {
      // 只展示上游实际返回的窗口，避免缺失的 5小时/月限被误写为 0%。
      var values = WINDOWS
        .filter(function (w) { return plan[w.key] != null })
        .map(function (w) {
          var v = plan[w.key]
          return (v && typeof v.percent === 'number' ? v.percent : 0) + '%'
        })
      capsuleRows.push({ dot: quotaToneColor(meta, worst, false), label: meta.name, values: values, stale: plan.stale === true })
    } else if (plan.error === 'no-key') {
      // [local patch 0.8.1] MiMo 的凭据是控制台 Cookie，提示语区分开（no-key 泛指缺凭据）。
      capsuleRows.push({ dot: null, label: meta.name, values: [meta.id === 'mimo' ? '请设置 Cookie' : '请设置 Key'], stale: false })
    } else {
      capsuleRows.push({ dot: null, label: meta.name, values: ['获取失败'], stale: false })
    }
  }
  var dotColor = 'var(--dsw-alias-label-secondary)'
  var text = '…'
  if (state && state.loading) {
    text = '…'
  } else if (capsuleRows.length > 0) {
    text = capsuleRows.map(function (r) { return r.label + ' ' + r.values.join(' ') }).join('\n')
    pillTitle = text
  } else if (state && state.error) {
    text = '获取失败'
    pillTitle = state.message || '获取失败'
  } else {
    text = '—'
  }

  // [local patch 0.6.3] 缩略（rail）状态下胶囊**不可交互**：rail 只有约 56px 宽，
  // 而详情面板是 `position:absolute; width:100%`，在 rail 里会被压成一条竖排的
  // 乱码（移动端 Web UI 实测，桌面端因侧栏够宽不显现）。详情面板只在展开状态
  // 点击获得；这里在缩略状态**根本不挂 onClick**，元素也从 button 换成 div，
  // 连键盘/回车都触发不了。
  // 折叠信号来自 sidebar 的 renderSlot('sidebar.footer.action', { wide })。
  // 缺失该属性（旧版 sidebar / 其他宿主）时按展开处理，保持既有行为。
  var wide = props.wide !== false
  var interactive = wide
  var pillProps = {
    className: 'dsh-plan-usage-pill',
    // [0.8.2] 外点关闭用：胶囊元素引用（点击是否落在卡片内的判定起点）。
    ref: pillRef,
    // 悬停底色的开关（见 ensureStyles 注入的 CSS）；缩略态不加。
    'data-interactive': interactive ? 'true' : undefined,
    style: Object.assign({}, pillStyle, {
      width: '100%',
      boxSizing: 'border-box',
      // [local patch 0.7.2] 缩略（rail）态把状态点**水平居中**。
      // 注意：pill 是 column 方向的 flex 容器，`justifyContent` 管的是纵轴，用它对
      // 状态点居中无效（0.7.1 及以前就是这样：rail 里圆点贴在左边）。
      // 横向居中要用 `alignItems: 'center'`：子项不再被拉伸成满宽，而是按内容宽度居中。
      // 展开态保持 undefined（默认 stretch），这样「圆点 + 名称 + 数值」的左右位置不受影响。
      alignItems: wide ? undefined : 'center',
      justifyContent: wide ? undefined : 'center',
      // 圆角/内距统一由 pillStyle 提供（12px / 6px 10px，出处见上面的注释），此处不再覆盖。
      // 缩略状态不再显示手型光标，避免暗示「可以点」。
      cursor: interactive ? 'pointer' : 'default',
      // 悬停/聚焦底色：直接由状态写入行内，不经过 CSS 优先级。
      background: interactive && hot ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      transition: 'background .16s var(--ds-ease-in-out)',
    }),
    title: pillTitle,
  }
  if (interactive) {
    pillProps.type = 'button'
    // [local patch 0.8.0] 点开详情面板时立即强刷一次（绕过 in-flight 守卫）：
    // 对齐 dsh-cost-meter「点击即刷新」的交互，也覆盖 30 秒轮询之外的最新需求。
    pillProps.onClick = function () {
      var next = !open
      setOpen(next)
      if (next && loadRef.current) loadRef.current(true)
    }
    pillProps.onMouseEnter = function () { setHot(true) }
    pillProps.onMouseLeave = function () { setHot(false) }
    pillProps.onFocus = function () { setHot(true) }
    pillProps.onBlur = function () { setHot(false) }
    pillProps['aria-expanded'] = open
    pillProps['aria-haspopup'] = 'true'
  }
  var pill = h(interactive ? 'button' : 'div', pillProps,
    capsuleRows.length > 0
      ? capsuleRows.map(function (r, idx) {
        // [local patch 0.8.0] 降级保留旧值时：数值灰字（staleValueStyle），
        // 状态灯灰色——「数据还在，但可能已过期」的弱化表达。
        return h('span', { style: pillRowStyle, key: idx },
          h('span', { style: Object.assign({}, dotStyle, { background: r.dot || dotColor }) }),
          wide && h('span', { style: capNameStyle }, r.label),
          wide && h('span', {
            style: r.valueFlex === true
              // [0.8.3 方案 B] WorkBuddy 行：flex 中心对齐（符号盒与数字盒按中心对齐）
              ? Object.assign({}, capValueStyle, valueFlexStyle(12), r.stale ? staleValueStyle : {})
              : (r.stale ? Object.assign({}, capValueStyle, staleValueStyle) : capValueStyle),
          },
            r.valueNodes ? r.valueNodes : r.values.join(' ')),
        )
      })
      : h('span', { style: pillSegStyle },
        h('span', { style: Object.assign({}, dotStyle, { background: dotColor }) }),
        wide && h('span', { style: valueStyle }, text),
      ),
  )

  var panel = null
  // 面板只可能在展开状态出现：`wide` 一并作为渲染条件，避免「先展开点击、
  // 再折叠」时effect 生效前的那一帧里在 rail 内闪出面板。
  if (open && wide) {
    var sections = plans.map(function (plan) {
      var meta = planMeta(plan.id)
      // [0.9.0] 自定义余额渠道：独立分区，只显示厂商名称、余额、币种与状态；
      // 不臆造现金/赠金、积分、额度条、峰谷条或重置时间，也不展示 Key / 完整 URL /
      // 原始 JSON / 错误堆栈。
      if (isCustomPlan(plan)) {
        return customBalanceSection(plan)
      }
      var title = meta.name + (meta.creditMode === true ? ' 积分'
        : meta.balanceThreshold !== undefined ? ' 余额'
        : (meta.percentMode === 'remaining' ? ' 剩余额度' : ' 用量')) + (plan.level ? ' · ' + plan.level : '')
      var inner
      if (plan.error) {
        inner = h('div', { style: sectionNoteStyle }, plan.message || '无法获取用量')
      } else if (meta.creditMode === true) {
        // [local patch 0.8.1 / 0.8.3] WorkBuddy 积分渠道。
        //
        // [0.8.3] 国内版 WorkBuddy 与国际版 WorkBuddy AI 的积分**不通用**
        //（用户 2026-10-17 在第二台设备实测发现）：因此大号数值行**按版本各显示
        // 一行**，不再把两版合并成一个「合计」（合并会让人误以为积分可通用）。
        // Host 的 variants 已给出各版本的独立小计与 unlimited 状态；
        // 旧 Host（无 variants）退回单行合计，保持向后兼容。
        var wbVariantRows = Array.isArray(plan.variants)
          ? plan.variants.filter(function (v) { return v !== null && typeof v === 'object' })
          : []
        // 若 Host 只给了合计（旧版 / 结构变化），用合计造一行，保证始终有数值行。
        if (wbVariantRows.length === 0) {
          wbVariantRows = [{
            label: meta.name,
            total: typeof plan.creditsTotal === 'number' ? plan.creditsTotal : null,
            unlimited: plan.creditsUnlimited === true,
          }]
        }
        /** 一个版本的大号数值行：dot + ✦ + 该版本剩余积分。 */
        function wbVariantRow(variant, key) {
          var vNum = variant.unlimited === true ? '∞'
            : (typeof variant.total === 'number' ? formatCredit(variant.total) : '—')
          return h('div', {
            style: Object.assign({}, balRowStyleStatic, { color: 'var(--dsw-alias-label-primary)' }),
            key: key,
          },
            h('span', { style: Object.assign({}, dotStyle, { width: 9, height: 9, background: 'var(--dsw-alias-state-success-primary)' }) }),
            // 版本名（WorkBuddy / WorkBuddy AI）在有多个版本时标在数值前，
            // 否则两行数字无法区分属于哪个版本。
            wbVariantRows.length > 1 && typeof variant.label === 'string'
              ? h('span', { style: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, variant.label)
              : null,
            // [0.8.3 方案 B] flex 中心对齐的「✦ + 数字」（Android Noto 的 ✦ 偏下）。
            h('span', { style: valueFlexStyle(18) },
              h('span', { style: starFixStyle(18) }, '✦'),
              h('span', { style: { marginLeft: '0.34em' } }, vNum),
            ),
          )
        }

        // 套餐明细（remain>0 或企业套餐；与 workbuddy-connect 卡片口径一致）。
        var wbRows = []
        if (Array.isArray(plan.creditsAccounts) && plan.creditsAccounts.length > 0) {
          for (var ai = 0; ai < plan.creditsAccounts.length; ai++) {
            var account = plan.creditsAccounts[ai]
            if (account.remain === null || (account.remain === 0 && account.packageName !== 'enterprise')) continue
            wbRows.push(h('div', { key: 'a' + ai, style: sectionNoteStyle },
              (account.variant ? account.variant + ' · ' : '') + (account.packageName || '套餐')
              + '：' + formatCredit(account.remain)
              + (typeof account.size === 'number' && account.size > 0 ? ' / ' + formatCredit(account.size) : '')))
          }
        }
        var wbListStyle = wbRows.length > WB_DETAIL_MAX_ROWS
          ? Object.assign({}, wbDetailListStyle)
          : null
        var wbDetailBlock = wbListStyle !== null
          ? h('div', { style: wbListStyle, key: 'wbdetail' }, wbRows)
          : wbRows
        inner = h('div', {},
          wbVariantRows.map(function (variant, vi) {
            return wbVariantRow(variant, 'wbv' + vi)
          }),
          wbDetailBlock,
          // [0.8.2] 部分取数脚注：某个版本取不到数据时，上方只是已取到版本的数据，
          // 用灰色说明行点出来。creditMode 不走 planNotes()，必须内联。
          plan.partial === true && plan.partialNote
            ? h('div', { style: sectionNoteStyle, key: 'wbpartial' }, plan.partialNote)
            : null,
        )
      } else if (meta.balanceThreshold !== undefined) {
        // [local patch] 余额类套餐：显示剩余余额与可用状态；低于阈值红灯提示。
        if (plan.mixedCurrency === true && typeof plan.balance !== 'number') {
          // [Z4] 混币：不编造总额，只说明「币种不同」并列出单位可证的明细。
          var mixedRows = []
          var mixedParts = [
            { field: 'cashBalance', currency: 'cashCurrency', label: plan.id === 'deepseek' ? '充值余额' : '现金余额' },
            { field: 'bonusBalance', currency: 'bonusCurrency', label: plan.id === 'deepseek' ? '赠金余额' : '赠送余额' },
          ]
          for (var mi = 0; mi < mixedParts.length; mi += 1) {
            var part = mixedParts[mi]
            var amount = plan[part.field]
            if (typeof amount !== 'number') continue
            var unit = typeof plan[part.currency] === 'string' && plan[part.currency].length > 0
              ? plan[part.currency]
              : null
            mixedRows.push(h('div', {
              key: 'mixed' + part.field,
              style: { display: 'flex', alignItems: 'baseline', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
            },
              h('span', {}, part.label + '：'),
              // 单位可证 → 带币种；不可证 → 只给数字并说明「币种未知」，绝不套用另一笔的符号。
              h('span', { style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' } },
                unit === null
                  ? floorToCent(amount) + '（币种未知）'
                  : unit + ' ' + floorToCent(amount)),
            ))
          }
          inner = h('div', {},
            h('div', { style: sectionNoteStyle, key: 'mixednote' }, '余额包含不同币种，无法合计为一个数字'),
            mixedRows.length > 0 ? h('div', { key: 'mixedlist' }, mixedRows) : null,
          )
        } else if (typeof plan.balance !== 'number') {
          inner = h('div', { style: sectionNoteStyle }, '余额获取失败')
        } else {
          var panelThreshold = typeof plan.warnThreshold === 'number' ? plan.warnThreshold : meta.balanceThreshold
          var low = panelThreshold > 0 && plan.balance < panelThreshold
          var balRow = {
            display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0',
            fontSize: 18, fontWeight: 600,
            color: plan.stale
              ? 'var(--dsw-alias-label-tertiary)'
              : (low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)'),
          }
          var balDot = Object.assign({}, dotStyle, {
            width: 9, height: 9,
            background: plan.stale
              ? 'var(--dsw-alias-label-tertiary)'
              : (low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'),
          })
          // [local patch 0.8.0/0.8.1] 余额明细：DeepSeek 与 MiMo 各自拆行显示。
          //   - MiMo：cashBalance / giftBalance（控制台口径：现金 / 赠送）；
          //   - DeepSeek [0.8.3]：cashBalance（充值余额）/ bonusBalance（赠金余额）——
          //     用户 2026-10-17 要求「和 MiMo 一样分开描述」。
          // 同一行布局（左充值/现金，右赠金/赠送），比两行更紧凑（用户 0.8.0 定稿）。
          var detailChildren = []
          var hasSplit = plan.id === 'deepseek'
            ? (typeof plan.cashBalance === 'number' || typeof plan.bonusBalance === 'number')
            : (typeof plan.cashBalance === 'number' || typeof plan.giftBalance === 'number')
          if (hasSplit) {
            var sym = balanceSymbol(plan.currency)
            var isDeepseek = plan.id === 'deepseek'
            var leftLabel = isDeepseek ? '充值余额：' : '现金余额：'
            var rightLabel = isDeepseek ? '赠金余额：' : '赠送余额：'
            var leftVal = typeof plan.cashBalance === 'number' ? plan.cashBalance : 0
            var rightVal = isDeepseek
              ? (typeof plan.bonusBalance === 'number' ? plan.bonusBalance : 0)
              : (typeof plan.giftBalance === 'number' ? plan.giftBalance : 0)
            detailChildren.push(h('div', {
              key: 'cashgift',
              style: { display: 'flex', alignItems: 'baseline', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: 1.5, margin: '2px 0' },
            },
              h('span', {}, leftLabel + sym + floorToCent(leftVal)),
              h('span', { style: { marginLeft: 'auto' } }, rightLabel + sym + floorToCent(rightVal)),
            ))
          }
          // [0.8.1 回退] 充值按钮已整体移除（原生视图 bounds 与网页返回栏互相
          // 遮挡无法稳定，用户拍板放弃）。低余额提示文案保留引导语义。
          inner = h('div', {},
            h('div', { style: balRow },
              h('span', { style: balDot }),
              h('span', {}, balanceSymbol(plan.currency) + floorToCent(plan.balance)),
            ),
            detailChildren,
            h('div', { style: sectionNoteStyle },
              plan.stale
                ? '余额更新失败，显示的是上次成功值'
                : (low
                  ? '余额低于 ' + panelThreshold + ' 元，' + (plan.id === 'mimo'
                    ? '请到小米 MiMo 开放平台控制台充值'
                    : (plan.via === 'api' ? '请到 DeepSeek 开放平台充值' : '请到「设置 → 账号与余额」充值'))
                  : (plan.isAvailable === false ? '账户当前不可用' : '余额充足'))),
            // [local patch 0.8.0/0.8.1] DeepSeek 峰谷时间条（host 附 peakSegs +
            // peakPhase 才渲染）。[0.8.3] Host 不再限定账号模式——API Key 计费同样
            // 按平台峰谷规则计价，因此两种鉴权方式的所有设备都会显示（见 index.js）。
            plan.id === 'deepseek' ? h(PeakBar, { segs: plan.peakSegs, phase: plan.peakPhase, key: 'peak' }) : null,
          )
        }
      } else {
        // [R3-03] 详情面板与胶囊用同一套窗口适配（Host 的通用 windows → 原生字段）。
        plan = adaptHostWindows(plan, meta)
        // 只渲染有数据的窗口：套餐没有的窗口（如某些 GLM 套餐无周限）不占行。
        var rows = WINDOWS
          .filter(function (w) { return plan[w.key] != null })
          .map(function (w) {
          var v = plan[w.key]
          var pct = v && typeof v.percent === 'number' ? v.percent : 0
          var limited = v && v.status === 'rate-limited'
          var reset = ''
          if (v && typeof v.resetsAt === 'string' && v.resetsAt.length > 0) {
            reset = fmtReset((Date.parse(v.resetsAt) - Date.now()) / 1000)
          } else if (v && typeof v.resetInSec === 'number') {
            reset = fmtReset(v.resetInSec)
          }
          var fill = Object.assign({}, barFillStyle, { width: Math.max(0, Math.min(100, pct)) + '%', background: quotaToneColor(meta, pct, limited) })
          return h('div', { style: rowStyle, key: w.key },
            h('span', { style: rowLabelStyle }, w.label),
            h('span', { style: barStyle }, h('span', { style: fill })),
            h('span', { style: rowPctStyle }, pct + '%'),
            h('span', { style: rowResetStyle }, reset),
          )
        })
        // 套餐级脚注：各套餐的提示逻辑集中在 PLAN_NOTES 表（见上），
        // 渲染层不感知具体套餐。
        var notes = planNotes(plan, null)
        inner = h('div', {},
          rows,
          notes.map(function (note, ni) {
            return h('div', { style: sectionNoteStyle, key: 'note' + ni }, note)
          }),
        )
      }
      return h('div', { key: plan.id },
        h('div', { style: sectionTitleStyle }, title),
        inner,
      )
    })
    panel = h('div', { style: panelStyle, ref: panelRef, 'data-plan-usage-panel': '' },
      h('div', { style: panelTitleStyle }, PLAN_NAME),
      sections,
    )
  }

  // [local patch 0.7.0] 独占一行时把胶囊声明为整行宽（basis:100%）；保留 flex-shrink，
  // 万一宿主容器仍是 nowrap，也只是按比例分宽，不会把其他插件的按钮挤没。
  //
  // ⚠️ 变量名必须是 ownRowStyle —— 0.7.1 曾把它写成 rowStyle，而 `var` 会提升到整个
  // 组件作用域，于是**遮蔽**了模块级那个面板额度行样式（rowStyle = display:flex…），
  // 导致详情面板里的额度行全部丢掉 display:flex、进度条被压成竖排文字
  // （真机故障：2026-10-10 用户发现面板里 Codex 没有额度条了）。
  // 这个作用域里的任何局部变量都不要再叫 rowStyle。
  var ownRowStyle = null
  if (ownRow) {
    ownRowStyle = wide
      // [local patch 0.7.1] 展开态额外向外贴边 4px（同 ds-harness-remote），
      // 抵消整行给条目留的内距，让悬停灰底的左右边界与别家按钮对齐。
      ? {
          flex: '0 0 auto',
          width: 'calc(100% + ' + (ROW_BLEED * 2) + 'px)',
          marginLeft: -ROW_BLEED,
          marginRight: -ROW_BLEED,
        }
      // 缩略（rail）态不贴边：rail 只有约 36px 宽，外扩会溢出。
      : { flex: '1 1 100%', width: '100%' }
  }
  var rootStyleNow = ownRowStyle === null ? rootStyle : Object.assign({}, rootStyle, ownRowStyle)
  return h('div', { style: rootStyleNow, ref: rootRef }, pill, panel)
}

// ===========================================================================
// 配置卡片（设置 → 插件 → 插件配置）
// ===========================================================================

// 卡片外观与 harness 自带的插件卡片（PluginCard.module.css / fields.module.css）
// 逐项一致：折叠头部 + 未保存徽标 + 底部按钮，全部使用同一套 dsw 设计令牌。
// 伪类规则（:hover / :focus-visible）无法内联，由 apply 注入的局部样式表承担。

var cardStyle = { listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-3)', transition: 'border-color .16s, background .16s' }
var cardOpenStyle = { background: 'var(--dsw-alias-bg-layer-2)', borderColor: 'var(--dsw-alias-label-dimmed)' }
var headerStyle = { width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12 }
var headTextStyle = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }
var nameStyle = { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' }
var descriptionStyle = { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
var chevronStyle = { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .16s' }
var chevronOpenStyle = Object.assign({}, chevronStyle, { transform: 'rotate(180deg)' })
var pendingStyle = { flex: 'none', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)' }
var bodyStyle = { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: 8 }
var readOnlyStyle = { margin: '12px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
var fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }
var fieldSplitStyle = Object.assign({}, fieldStyle, { borderTop: '1px solid var(--dsw-alias-border-l2)' })
var fieldHeadStyle = { display: 'flex', alignItems: 'center', gap: 8 }
var fieldLabelStyle = { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' }
var checkboxRowStyle = { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }
var badgesStyle = { display: 'inline-flex', alignItems: 'center', gap: 8 }
var badgeStyle = { borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', whiteSpace: 'nowrap', fontWeight: 500, background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)' }
var badgeMutedStyle = { borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)' }
var resetStyle = { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' }
var inputStyle = { width: '100%', boxSizing: 'border-box', height: 34, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' }
var hintStyle = { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
var footerStyle = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 0 4px', borderTop: '1px solid var(--dsw-alias-border-l2)' }
var failedStyle = { flex: 1, minWidth: 0, margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' }
var btnBaseStyle = { appearance: 'none', border: '1px solid transparent', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }
var discardBtnStyle = Object.assign({}, btnBaseStyle, { borderColor: 'var(--dsw-alias-border-l2)', background: 'none', color: 'var(--dsw-alias-label-secondary)' })
var saveBtnStyle = Object.assign({}, btnBaseStyle, { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)' })
var btnDisabledStyle = { opacity: 0.4, cursor: 'default' }

/** 折叠头部与按钮的伪类规则：与 PluginCard.module.css / fields.module.css 一致。 */
var CARD_CSS = [
  '.dsh-plan-usage-card:hover { border-color: var(--dsw-alias-label-dimmed); }',
  '.dsh-plan-usage-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }',
  '.dsh-plan-usage-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
  '.dsh-plan-usage-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }',
  '.dsh-plan-usage-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }',
  '.dsh-plan-usage-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }',
].join('\n')

/**
 * 配置卡片控制器：通过插件自己的 `GET/POST /api/plan-usage/config` 读写配置，
 * 维护分阶段草稿（保存才写入）。同时为角标提供 `enabled` 全局开关与
 * `plans.<id>.enabled` 套餐开关快照。
 */
function PlanUsageController(ctx) {
  var listeners = new Set()
  var snapshot = {
    available: false, writable: true,
    enabled: true, dirty: false, saving: false, failed: false,
    plans: {},
  }

  var loaded = false
  var enabled = true
  var writable = true
  var enabledDraft = undefined
  var saving = false
  var failed = false

  // id -> { enabled, apiKeyConfigured, cookieConfigured, enabledDraft,
  //          apiKeyDraft, apiKeyClear, cookieDraft, cookieClear }
  var planState = {}

  function planStore(id) {
    var st = planState[id]
    if (st === undefined) {
      st = { enabled: true, apiKeyConfigured: false, cookieConfigured: false }
      planState[id] = st
    }
    return st
  }

  function applyData(data) {
    if (!data) return
    enabled = data.enabled !== false
    writable = data.writable !== false
    loaded = true
    var plans = data.plans && typeof data.plans === 'object' ? data.plans : {}
    for (var i = 0; i < PLANS.length; i++) {
      var ps = plans[PLANS[i].id]
      if (!ps) continue
      var st = planStore(PLANS[i].id)
      st.enabled = ps.enabled !== false
      st.apiKeyConfigured = ps.apiKeyConfigured === true
      st.cookieConfigured = ps.cookieConfigured === true
    }
  }

  function load() {
    return fetch('/api/plan-usage/config')
      .then(function (r) { return r.json() })
      .then(function (result) {
        if (result && result.ok) applyData(result.data)
        publish()
      })
      .catch(function () { publish() })
  }

  function project() {
    var dirty = enabledDraft !== undefined
    var plans = {}
    for (var i = 0; i < PLANS.length; i++) {
      var plan = PLANS[i]
      var st = planStore(plan.id)
      var checked = st.enabledDraft !== undefined ? st.enabledDraft : st.enabled
      var planDirty = st.enabledDraft !== undefined || st.apiKeyClear
        || (typeof st.apiKeyDraft === 'string' && st.apiKeyDraft.trim() !== '')
        || st.cookieClear
        || (typeof st.cookieDraft === 'string' && st.cookieDraft.trim() !== '')
      if (planDirty) dirty = true
      plans[plan.id] = {
        enabled: checked,
        apiKeyConfigured: st.apiKeyConfigured === true,
        apiKeyDraft: typeof st.apiKeyDraft === 'string' ? st.apiKeyDraft : '',
        apiKeyClear: st.apiKeyClear === true,
        cookieConfigured: st.cookieConfigured === true,
        cookieDraft: typeof st.cookieDraft === 'string' ? st.cookieDraft : '',
        cookieClear: st.cookieClear === true,
      }
    }
    return {
      available: loaded,
      writable: writable,
      enabled: enabledDraft !== undefined ? enabledDraft : enabled,
      plans: plans,
      dirty: dirty,
      saving: saving,
      failed: failed,
    }
  }

  function publish() {
    snapshot = project()
    var arr = Array.from(listeners)
    for (var i = 0; i < arr.length; i++) arr[i]()
  }

  // 周期刷新，跟随 settings.yaml 的外部改动（如直接编辑文档）。
  ctx.effect(function () {
    var timer = setInterval(load, 60000)
    return function () { clearInterval(timer) }
  }, 'plan-usage: config refresh')

  function save() {
    if (saving) return Promise.resolve()
    var payload = {}
    if (enabledDraft !== undefined) payload.enabled = enabledDraft
    var plans = {}
    for (var i = 0; i < PLANS.length; i++) {
      var plan = PLANS[i]
      var st = planStore(plan.id)
      var entry = {}
      if (st.enabledDraft !== undefined) entry.enabled = st.enabledDraft
      if (st.apiKeyClear) entry.clearKey = true
      else {
        var key = typeof st.apiKeyDraft === 'string' ? st.apiKeyDraft.trim() : ''
        if (key !== '') entry.apiKey = key
      }
      if (st.cookieClear) entry.clearCookie = true
      else {
        var cookie = typeof st.cookieDraft === 'string' ? st.cookieDraft.trim() : ''
        if (cookie !== '') entry.cookie = cookie
      }
      if (Object.keys(entry).length > 0) plans[plan.id] = entry
    }
    if (Object.keys(plans).length > 0) payload.plans = plans
    if (Object.keys(payload).length === 0) return Promise.resolve()

    saving = true
    failed = false
    publish()
    return fetch('/api/plan-usage/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json() })
      .then(function (result) {
        enabledDraft = undefined
        for (var i = 0; i < PLANS.length; i++) {
          var st = planStore(PLANS[i].id)
          st.enabledDraft = undefined
          st.apiKeyDraft = ''
          st.apiKeyClear = false
          st.cookieDraft = ''
          st.cookieClear = false
        }
        saving = false
        failed = !(result && result.ok)
        if (result && result.ok) applyData(result.data)
        publish()
      })
      .catch(function () {
        enabledDraft = undefined
        for (var i = 0; i < PLANS.length; i++) {
          var st = planStore(PLANS[i].id)
          st.enabledDraft = undefined
          st.apiKeyDraft = ''
          st.apiKeyClear = false
          st.cookieDraft = ''
          st.cookieClear = false
        }
        saving = false
        failed = true
        publish()
      })
  }

  load()
  publish()

  return {
    getSnapshot: function () { return snapshot },
    subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn) } },
    setEnabled: function (v) { enabledDraft = !!v; failed = false; publish() },
    setPlanEnabled: function (id, v) { planStore(id).enabledDraft = !!v; failed = false; publish() },
    setPlanApiKey: function (id, text) { planStore(id).apiKeyDraft = text; planStore(id).apiKeyClear = false; failed = false; publish() },
    clearPlanApiKey: function (id) { planStore(id).apiKeyClear = true; planStore(id).apiKeyDraft = ''; failed = false; publish() },
    setPlanCookie: function (id, text) { planStore(id).cookieDraft = text; planStore(id).cookieClear = false; failed = false; publish() },
    clearPlanCookie: function (id) { planStore(id).cookieClear = true; planStore(id).cookieDraft = ''; failed = false; publish() },
    discard: function () {
      enabledDraft = undefined
      for (var i = 0; i < PLANS.length; i++) {
        var st = planStore(PLANS[i].id)
        st.enabledDraft = undefined
        st.apiKeyDraft = ''
        st.apiKeyClear = false
        st.cookieDraft = ''
        st.cookieClear = false
      }
      failed = false
      publish()
    },
    save: save,
  }
}

/** 单个套餐的配置区块：开关 + （启用时）API Key 输入；Kimi Code 额外有 Cookie 输入。 */
function PlanBlock(props) {
  var c = props.controller
  var plan = props.plan
  var snap = props.snap
  var disabled = props.disabled
  var planSnap = snap.plans[plan.id] || { enabled: true, apiKeyConfigured: false, apiKeyDraft: '', apiKeyClear: false, cookieConfigured: false, cookieDraft: '', cookieClear: false }
  return h('div', { style: fieldSplitStyle },
    h('label', { style: checkboxRowStyle },
      h('input', {
        type: 'checkbox',
        checked: planSnap.enabled,
        disabled: disabled,
        onChange: function (e) { c.setPlanEnabled(plan.id, e.target.checked) },
      }),
      h('span', { style: fieldLabelStyle }, '启用 ' + plan.name + ' 用量角标'),
    ),
    planSnap.enabled
      ? h('div', {},
        plan.noCredential
          ? h('p', { style: hintStyle }, plan.credentialNote || '此套餐不需要单独配置凭据。')
          : h('div', {},
            h('div', { style: Object.assign({}, fieldHeadStyle, { marginTop: 6 }) },
              h('label', { style: fieldLabelStyle, htmlFor: 'plan-usage-' + plan.id + '-api-key' }, plan.name + ' API Key（可选）'),
              h('span', { style: badgesStyle },
                h('span', { style: planSnap.apiKeyConfigured ? badgeStyle : badgeMutedStyle }, planSnap.apiKeyConfigured ? '已配置' : '未配置'),
                planSnap.apiKeyConfigured
                  ? h('button', { type: 'button', style: resetStyle, className: 'dsh-plan-usage-reset', disabled: disabled, onClick: function () { c.clearPlanApiKey(plan.id) } }, '清除')
                  : null,
              ),
            ),
            h('input', {
              id: 'plan-usage-' + plan.id + '-api-key',
              type: 'password',
              autoComplete: 'off',
              style: inputStyle,
              className: 'dsh-plan-usage-input',
              value: planSnap.apiKeyDraft,
              placeholder: '留空则使用「设置 → 模型」中的 ' + plan.credentialHint + ' API Key',
              disabled: disabled,
              onChange: function (e) { c.setPlanApiKey(plan.id, e.target.value) },
            }),
            h('p', { style: hintStyle }, '此处填写的 Key 优先级高于「设置 → 模型」中的 ' + plan.credentialHint + ' Key；两边都未设置时，角标会提示配置。'),
          ),
        plan.cookieHint
          ? h('div', {},
            h('div', { style: Object.assign({}, fieldHeadStyle, { marginTop: 6 }) },
              h('label', { style: fieldLabelStyle, htmlFor: 'plan-usage-' + plan.id + '-cookie' }, plan.name + ' ' + plan.cookieHint + ' Cookie（可选）'),
              h('span', { style: badgesStyle },
                h('span', { style: planSnap.cookieConfigured ? badgeStyle : badgeMutedStyle }, planSnap.cookieConfigured ? '已配置' : '未配置'),
                planSnap.cookieConfigured
                  ? h('button', { type: 'button', style: resetStyle, className: 'dsh-plan-usage-reset', disabled: disabled, onClick: function () { c.clearPlanCookie(plan.id) } }, '清除')
                  : null,
              ),
            ),
            h('input', {
              id: 'plan-usage-' + plan.id + '-cookie',
              type: 'password',
              autoComplete: 'off',
              style: inputStyle,
              className: 'dsh-plan-usage-input',
              value: planSnap.cookieDraft,
              placeholder: '留空则读取环境变量 KIMI_AUTH_TOKEN',
              disabled: disabled,
              onChange: function (e) { c.setPlanCookie(plan.id, e.target.value) },
            }),
            h('p', { style: hintStyle }, '用于获取 Kimi 会员月度额度；可在 kimi.com 浏览器开发者工具中复制 ' + plan.cookieHint + ' Cookie 值，过期后需重新复制。'),
          )
          : null,
      )
      : null,
  )
}

/**
 * 配置卡片：结构与交互逐项复刻 harness 的 PluginCard——
 * 头部按钮折叠/展开（chevron 旋转、aria-expanded），未保存徽标，只读提示，
 * 底部「放弃修改 / 保存 / 保存中…」按钮及失败提示；按钮与字段配色、字号、
 * 圆角均取同一套 dsw 令牌。展开区按套餐拆成多个区块，各配自己的开关与 Key。
 */
function PlanUsageConfigCard(props) {
  var c = props.settings
  var snap = React.useSyncExternalStore(c.subscribe, c.getSnapshot)
  var openHook = React.useState(false)
  var open = openHook[0]
  var setOpen = openHook[1]
  if (!snap.available) return null
  var disabled = !snap.writable
  var dirty = snap.dirty
  var saving = snap.saving
  var saveDisabled = !dirty || saving || disabled

  var card = h('li', { style: open ? Object.assign({}, cardStyle, cardOpenStyle) : cardStyle, className: 'dsh-plan-usage-card' },
    h('button', {
      type: 'button',
      style: headerStyle,
      className: 'dsh-plan-usage-header',
      'aria-expanded': open,
      'aria-label': (open ? '收起设置：' : '展开设置：') + PLAN_NAME,
      onClick: function () { setOpen(!open) },
    },
      h('span', { style: headTextStyle },
        h('span', { style: nameStyle }, PLAN_NAME),
        h('span', { style: descriptionStyle }, '在左侧状态栏显示套餐用量与余额（OpenCode Go / GLM / Kimi / DeepSeek / OpenAI Codex / Xiaomi MiMo）。'),
      ),
      dirty ? h('span', { style: pendingStyle }, '未保存') : null,
      h('span', { style: open ? chevronOpenStyle : chevronStyle, 'aria-hidden': 'true' }, '⌄'),
    ),
    open
      ? h('div', { style: bodyStyle },
        !snap.writable ? h('p', { style: readOnlyStyle, role: 'status' }, '本部署的设置为只读。') : null,
        h('div', { style: fieldStyle },
          h('label', { style: checkboxRowStyle },
            h('input', {
              type: 'checkbox',
              checked: snap.enabled,
              disabled: disabled,
              onChange: function (e) { c.setEnabled(e.target.checked) },
            }),
            h('span', { style: fieldLabelStyle }, '启用套餐用量角标'),
          ),
          h('p', { style: hintStyle }, '关闭后左侧状态栏不再显示套餐用量。'),
        ),
        snap.enabled
          ? PLANS.map(function (plan) {
            return h(PlanBlock, { key: plan.id, controller: c, plan: plan, snap: snap, disabled: disabled })
          })
          : null,
        h('div', { style: footerStyle },
          snap.failed ? h('p', { style: failedStyle, role: 'status' }, '本部署没有接受这些值，已保留供你修改。') : null,
          h('button', {
            type: 'button',
            style: Object.assign({}, discardBtnStyle, (!dirty || saving) ? btnDisabledStyle : {}),
            className: 'dsh-plan-usage-btn dsh-plan-usage-discard',
            disabled: !dirty || saving,
            onClick: function () { c.discard() },
          }, '放弃修改'),
          h('button', {
            type: 'button',
            style: Object.assign({}, saveBtnStyle, saveDisabled ? btnDisabledStyle : {}),
            className: 'dsh-plan-usage-btn dsh-plan-usage-save',
            disabled: saveDisabled,
            onClick: function () { c.save() },
          }, saving ? '保存中…' : '保存'),
        ),
      )
      : null,
  )
  return card
}

// ===========================================================================
// 「内置插件」里的设置页（settings.plugins.tab 席位）
// ===========================================================================
// 配置由 DSH 托管：Host 半导出 Config schema，客户端通过 configForms 服务
// 读写当前 profile 条目的配置（命名空间 = 条目 id，即 plan-usage）。
// 表单控制器负责修订号校验、写队列与持久化，这里只负责渲染。

var settingsPageStyle = { display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }
var settingsIntroStyle = { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px" }
var settingsGroupStyle = { display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "0.5px solid var(--dsw-alias-border-l2)" }
var settingsRowStyle = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--dsw-alias-label-primary)" }
var settingsInputStyle = { boxSizing: "border-box", width: "100%", padding: "6px 9px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", fontSize: 13 }
var settingsHintStyle = { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" }
var settingsThresholdStyle = { display: "flex", alignItems: "center", gap: 8, fontSize: 12, flexWrap: "wrap" }
var settingsThresholdInputStyle = { boxSizing: "border-box", width: 96, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", fontSize: 13 }
/**
 * [2026-10-24 布局重做] 底部操作条吸底。
 * 不透明主题底色 + **低**局部 zIndex（不盖住宿主通知/浮层，也不改 sidebar 胶囊）。
 * `justifyContent: 'flex-end'` 保持原样（既有测试用该特征定位页脚）。
 */
var settingsFooterStyle = {
  display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8,
  position: "sticky", bottom: 0, zIndex: 1,
  paddingTop: 12, paddingBottom: 8, marginTop: 4,
  background: "var(--dsw-alias-bg-layer-1)",
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
}
var settingsButtonStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", fontSize: 13, cursor: "pointer" }
var settingsButtonPrimaryStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid transparent", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-1)", fontSize: 13, cursor: "pointer" }
var settingsButtonDisabledStyle = { opacity: 0.45, cursor: "default" }

/** 读取当前配置里的布尔值（未设置时按 schema 默认值处理）。 */
function settingBool(value, key, fallback) {
  var raw = value[key]
  return typeof raw === "boolean" ? raw : fallback
}

/** 读取当前配置里的字符串值。 */
function settingText(value, key) {
  var raw = value[key]
  return typeof raw === "string" ? raw : ""
}

// ===========================================================================
// [2026-10-23] 额度策略：按渠道 / 按窗口的两档阈值（客户端侧）
// ===========================================================================
//
// 分工（与 Host 严格一致，两边各自一份实现、注释互指）：
//   - **Host** `plans/quota-thresholds.js` 负责解析语义 + 阶段判定；
//   - **浏览器** 这里只做「读-改-写 + 校验 + 展示」，不判定阶段；
//   - 窗口词表 `POLICY_WINDOW_KEYS` 必须与 Host 的 `WINDOW_KEYS` 逐字一致，
//     否则用户输入会写进 Host 不认识的 key（写进去也不会生效）。
//
// 关键语义（父裁决 R2）：阈值 JSON 有四种可区分状态，UI 必须如实反映——
//   absent（缺字段/空串）→ 全部渠道沿用旧全局阈值；
//   invalid（null/非字符串/坏 JSON/非对象/超限）→ 整体暂停判定；
//   某渠道有条目（含全 0）→ 该渠道以条目为准，**不**回头借旧全局；
//   某渠道无条目 → 该渠道仍走它自己的旧全局阈值（编辑 A 不会关掉 B 的旧策略）。

var POLICY_WINDOW_KEYS = ['rolling-5h', 'weekly', 'monthly']
var POLICY_WINDOW_LABELS = { 'rolling-5h': '5 小时窗口', weekly: '周窗口', monthly: '月窗口' }
/** 旧实现的窗口先后（与 Host `pickSmallestWindow` 同表）：legacy 只判最短窗口。 */
var POLICY_LEGACY_WINDOW_ORDER = ['rolling-5h', 'rolling-1d', 'daily', 'weekly', 'monthly']
/** 关注渠道上限（与 Host `MAX_FOCUS_CHANNELS` 一致）。 */
var POLICY_MAX_FOCUS = 8
/** 阈值条目上限（与 Host `MAX_THRESHOLD_CHANNELS` 一致；**不是**关注上限）。 */
var POLICY_MAX_CHANNELS = 32
/** 阈值 JSON 字符上限（与 Host `MAX_THRESHOLD_JSON_LENGTH` 一致）。 */
var POLICY_MAX_JSON = 8192
var POLICY_FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

/**
 * [2026-10-23 UI 微调] 策略块是**卡片内部**的从属区域，不是另一张卡片。
 *
 * 之前用通栏 `borderTop` 分隔，视觉上与上面的渠道名称行"平级"（像同一层另一张卡）。
 * 现在改成缩进的从属块：左缩进 + 左侧细边 + 浅背景 + 内距，**去掉通栏顶边**。
 * 只写相对/自适应属性（不写固定总宽）：`minWidth:0` + `boxSizing:border-box`，
 * 窄宽度靠行内 `flexWrap` 换行，不引入水平溢出。
 */
var policyBlockStyle = {
  display: 'flex', flexDirection: 'column', gap: 6,
  boxSizing: 'border-box', minWidth: 0,
  marginLeft: 20, marginTop: 4,
  padding: '8px 10px 8px 12px',
  borderLeft: '2px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
}
var policyPairRowStyle = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
/** 阈值输入框宽度常量（表头列宽与输入框共用，避免两处各写数字导致错位）。 */
var POLICY_INPUT_WIDTH = 78
var policyInputStyle = Object.assign({}, settingsThresholdInputStyle, { width: POLICY_INPUT_WIDTH })
var policyStatusStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
var policyErrorStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' }
/** 提醒色（"旧版设置未完整启用"这类需要用户操作但不报错的提示）。 */
var policyWarnHintStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-primary)' }

/**
 * [2026-10-24 布局重做] 设置页视觉统一用的少量样式。
 * 全部走现有 DSH 主题 token；不写死颜色、不写固定总宽、不引入装饰图形。
 */
var policyHeadStyle = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  boxSizing: 'border-box', minWidth: 0,
}
var policyStateChipOnStyle = {
  padding: '1px 8px', borderRadius: 999, fontSize: 12, lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
}
var policyStateChipOffStyle = Object.assign({}, policyStateChipOnStyle, { color: 'var(--dsw-alias-label-tertiary)' })
var policyDetailsStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', minWidth: 0 }
var policySummaryStyle = { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '2px 0' }
/** 渠道卡片容器（内置与自定义共用外观：轻边框 + 圆角 + 统一内距）。 */
var planCardStyle = {
  display: 'flex', flexDirection: 'column', gap: 8,
  boxSizing: 'border-box', minWidth: 0,
  padding: '10px 12px', marginTop: 10,
  borderRadius: 10, border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
}
/** 中性类型小标签（订阅/金额/积分），只用文字与弱色，不用彩色圆标。 */
var planTypeChipStyle = {
  padding: '0 6px', borderRadius: 6, fontSize: 11, lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)', border: '0.5px solid var(--dsw-alias-border-l2)',
}
/** 订阅策略窗口表：表头与数据行共用列宽，窄屏整体折行（不写固定总宽）。 */
var policyWindowHeadStyle = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
  boxSizing: 'border-box', minWidth: 0, fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)', paddingBottom: 2,
}
var policyWindowRowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
  boxSizing: 'border-box', minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
}
var policyWindowLabelCellStyle = { minWidth: 92, flex: '0 1 92px', boxSizing: 'border-box' }
/**
 * 数值列宽必须与输入框一致（`policyInputStyle.width`），否则表头和行会错位。
 * 两者共用上面同一个 `POLICY_INPUT_WIDTH` 常量。
 */
var policyWindowValueCellStyle = {
  minWidth: POLICY_INPUT_WIDTH, flex: '0 0 ' + POLICY_INPUT_WIDTH + 'px',
  boxSizing: 'border-box', textAlign: 'right',
}

/**
 * **完整授权**定义（单总开关）：两个布尔都严格 `true` 才算已启用。
 *
 * 旧字段 `quotaTrustRouteOrder` 仍保留在 schema / Host 判定里（默认 false、Host 旧闸门不变）；
 * 这里只是把"用户的一次启用动作"映射成这一对状态，**不是**把内部路由闸门恒 true。
 */
function policyFullyEnabled (current) {
  if (current === null || current === undefined || typeof current !== 'object') return false
  return current.quotaPolicyEnabled === true && current.quotaTrustRouteOrder === true
}
var policyTinyButtonStyle = Object.assign({}, settingsButtonStyle, { padding: '3px 9px', fontSize: 12 })

/** 可作为对象 key / 渠道 id 的安全键（拒原型污染三件套）。 */
function policyIsSafeKey(key) {
  if (typeof key !== 'string') return false
  if (key.length === 0 || key.length > 64) return false
  if (POLICY_FORBIDDEN_KEYS.indexOf(key) !== -1) return false
  return /^[A-Za-z0-9:_-]+$/.test(key)
}

/** 窗口 key → 中文标签；未知返回 null。 */
function policyLabelOf(key) {
  if (typeof key !== 'string') return null
  return Object.prototype.hasOwnProperty.call(POLICY_WINDOW_LABELS, key) ? POLICY_WINDOW_LABELS[key] : null
}

/** 该渠道用哪一类阈值：金额 / 积分 / 订阅窗口（与 Host 的 unit 判定对应）。 */
function policyKindOf(meta) {
  if (!meta) return 'window'
  if (meta.creditMode === true) return 'credits'
  if (meta.thresholdField !== undefined || meta.balanceThreshold !== undefined) return 'balance'
  return 'window'
}

/** 按渠道 id 取阈值类型（自定义余额 = 金额）。 */
function policyKindOfById(channelId) {
  for (var i = 0; i < PLANS.length; i++) {
    if (PLANS[i].id === channelId) return policyKindOf(PLANS[i])
  }
  return 'balance'
}

/** 类型小标签的固定文案（不来自上游、不含配色）。 */
function planKindLabelOf(meta) {
  var kind = policyKindOf(meta)
  if (kind === 'credits') return '积分'
  if (kind === 'balance') return '金额'
  return '订阅'
}

/**
 * 「已保存配置」里会影响窗口能力/身份的那些公开字段的签名。
 *
 * 用途：设置页据此判断「是否需要重新拉取窗口能力并作废旧结果」（P10 / 审查 E01/E02）。
 *
 * ⚠️ **不要自造残缺的来源字段表**：这里复用已经与 Host 同构的
 * `configDigestOfClient(value)`（含自定义条目的 provider / balanceEndpoint / 路径 /
 * 扣减键 / 币种 / 凭据引用 / 目标确认 / 启用状态，以及**公开**的 Key 修订号），
 * 再补上 WorkBuddy 的**账号选择**（规范化、顺序无关）。
 * 只用公开字段：secret 已被 DSH 剥掉，这里既读不到也不缓存任何密钥。
 * 依赖 `value`（已保存快照）而不是草稿 —— 未保存的编辑不应被当成"来源已切换"。
 */
function policyConfigSignature(value) {
  var v = value !== null && value !== undefined && typeof value === 'object' ? value : {}
  var parts = ['g=' + (v.enabled === false ? '0' : '1')]
  for (var i = 0; i < PLANS.length; i++) {
    var plan = PLANS[i]
    var field = plan.fields !== undefined && plan.fields !== null ? plan.fields.enabled : undefined
    parts.push(plan.id + '=' + (field !== undefined && v[field] === false ? '0' : '1'))
  }
  // 自定义条目 + 公开 Key 修订号（与 Host 的配置摘要同一套规范化）
  parts.push('custom=' + configDigestOfClient(v))
  // WorkBuddy：账号选择是**真实来源**的一部分（换账号 = 换来源）
  parts.push('wb=' + policyAccountsSignature(v.workbuddyAccounts))
  return parts.join('|')
}

/** WorkBuddy 账号选择的规范化签名（顺序无关；坏值用原文兜底，保证"变了就变"）。 */
function policyAccountsSignature(raw) {
  if (typeof raw !== 'string') return 'raw:' + String(raw === undefined ? '' : raw)
  var text = raw.trim()
  if (text.length === 0) return ''
  var parsed
  try { parsed = JSON.parse(text) } catch (err) { return 'raw:' + text }
  if (!Array.isArray(parsed)) return 'raw:' + text
  var list = []
  for (var i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'string') continue
    var id = parsed[i].trim()
    if (id.length === 0 || list.indexOf(id) !== -1) continue
    list.push(id)
  }
  list.sort()
  return list.join(',')
}

/**
 * 保存前的策略校验（**零副作用**；返回 `null` = 通过）。
 *
 * 只校验**本次草稿确实改动**的字段（父裁决 R6）：
 * 未改动的历史配置（哪怕是坏 JSON）不阻塞其它渠道保存，也不会被自动重写。
 */
function policyValidateDraft(base, saved) {
  var nextThresholds = base.quotaChannelThresholds
  var prevThresholds = saved !== null && saved !== undefined ? saved.quotaChannelThresholds : undefined
  if (nextThresholds !== prevThresholds) {
    var thresholdProblem = policyValidateThresholdsRaw(nextThresholds)
    if (thresholdProblem !== null) return thresholdProblem
  }
  var nextFocus = base.quotaFocusChannels
  var prevFocus = saved !== null && saved !== undefined ? saved.quotaFocusChannels : undefined
  if (nextFocus !== prevFocus) {
    var fInfo = policyParseFocus(nextFocus)
    if (fInfo.state === 'invalid') return '关注渠道列表必须是字符串数组的 JSON 文本。'
    if (fInfo.list.length > POLICY_MAX_FOCUS) {
      return '关注渠道最多 ' + POLICY_MAX_FOCUS + ' 个（当前 ' + fInfo.list.length + ' 个）。'
    }
    for (var fi = 0; fi < fInfo.list.length; fi++) {
      if (!policyIsSafeKey(fInfo.list[fi])) return '关注渠道里有不合法的渠道 id：' + fInfo.list[fi]
    }
  }
  return null
}

/**
 * 校验阈值 JSON 的**原始**内容（不是归一化后的值）。
 *
 * 父裁决 P04：`policyParseThresholds` 会把越界/非法值归一成「未配置」，
 * 若保存校验只看归一化结果，105 会被悄悄变成 0 而"通过"。这里直接检查原始 JSON 的
 * 类型与范围（>100 / 负数 / NaN / Infinity / 非数字 / 非法币种 → 明确报错），
 * 校验失败时整页零写入、草稿保留。
 */
function policyValidateThresholdsRaw(raw) {
  if (typeof raw !== 'string') return '额度阈值必须是 JSON 文本。'
  var text = raw.trim()
  if (text.length === 0) return null
  if (text.length > POLICY_MAX_JSON) return '额度阈值配置过大（上限 ' + POLICY_MAX_JSON + ' 字符）。'
  var parsed
  try { parsed = JSON.parse(text) } catch (err) { return '额度阈值不是合法 JSON。' }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '额度阈值的顶层必须是对象。'
  if (policyContainsForbiddenKey(parsed)) {
    return '额度阈值里出现不允许的键（__proto__ / constructor / prototype）。'
  }
  var ids = Object.keys(parsed)
  if (ids.length > POLICY_MAX_CHANNELS) return '额度阈值的渠道条目过多（上限 ' + POLICY_MAX_CHANNELS + '）。'
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    if (!policyIsSafeKey(id)) return '额度阈值里的渠道键不合法：' + id
    var entry = parsed[id]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return '渠道 ' + id + ' 的阈值条目必须是对象。'
    }
    var windows = Object.prototype.hasOwnProperty.call(entry, 'windows') ? entry.windows : undefined
    if (windows !== undefined && windows !== null) {
      if (typeof windows !== 'object' || Array.isArray(windows)) return '渠道 ' + id + ' 的 windows 必须是对象。'
      for (var w = 0; w < POLICY_WINDOW_KEYS.length; w++) {
        var key = POLICY_WINDOW_KEYS[w]
        if (!Object.prototype.hasOwnProperty.call(windows, key)) continue
        var winProblem = policyValidateRawPair(windows[key], 100, id + ' ' + (policyLabelOf(key) || key))
        if (winProblem !== null) return winProblem
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'balance') && entry.balance !== null) {
      var bal = entry.balance
      if (typeof bal !== 'object' || Array.isArray(bal)) return '渠道 ' + id + ' 的余额阈值必须是对象。'
      var balProblem = policyValidateRawPair(bal, Infinity, id + ' 余额')
      if (balProblem !== null) return balProblem
      if (Object.prototype.hasOwnProperty.call(bal, 'currency')) {
        var cur = bal.currency
        var trimmed = typeof cur === 'string' ? cur.trim() : null
        if (trimmed === null || (trimmed.length > 0 && !/^[A-Za-z]{3}$/.test(trimmed))) {
          return id + ' 的余额阈值币种必须是 3 位字母代码（如 CNY）。'
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'credits') && entry.credits !== null) {
      var credits = entry.credits
      if (typeof credits !== 'object' || Array.isArray(credits)) return '渠道 ' + id + ' 的积分阈值必须是对象。'
      var creditProblem = policyValidateRawPair(credits, Infinity, id + ' 积分')
      if (creditProblem !== null) return creditProblem
    }
  }
  return null
}

/** 原始一对阈值的类型/范围/顺序校验（缺省字段 = 未配置）。 */
function policyValidateRawPair(rawPair, maxValue, label) {
  if (rawPair === null || typeof rawPair !== 'object' || Array.isArray(rawPair)) return label + ' 必须是对象。'
  var values = { warning: 0, closing: 0 }
  var names = ['warning', 'closing']
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    if (!Object.prototype.hasOwnProperty.call(rawPair, name)) continue
    var v = rawPair[name]
    if (typeof v !== 'number' || !isFinite(v)) {
      return label + ' 的' + (name === 'warning' ? '预警' : '收尾') + '必须是数字。'
    }
    if (v < 0) return label + ' 的阈值不能是负数。'
    if (v > maxValue) return label + ' 的阈值超出范围（上限 ' + maxValue + '）。'
    values[name] = v
  }
  if (values.warning > 0 && values.closing > 0 && values.closing >= values.warning) {
    return label + ' 的收尾阈值必须小于预警阈值（例如 预警 20 / 收尾 5）。'
  }
  return null
}

function policyNum(value) {
  return typeof value === 'number' && isFinite(value) ? value : 0
}

/**
 * 输入框文本 → 数字。
 *
 * 空串 = 0 = 未配置；**非法文本返回 NaN**（写入层拒绝并提示），绝不静默当成 0。
 * 越界值（105 / -5）原样保留，交给保存校验报错——绝不在这里夹到 0，
 * 否则"越界输入"会被悄悄变成"未配置"，保存也就永远不会失败（父裁决 P04）。
 */
function policyTextNum(text) {
  var raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) return 0
  var num = Number(raw)
  return Number.isFinite(num) ? num : NaN
}

/**
 * 从原生 `input[type=number]` 的事件里安全读值。
 *
 * 父裁决（审查 E03，组件事件合同反例）：用户输入非法内容时，原生 number 输入给出
 * `value === ''` **同时** `validity.badInput === true` —— 那**不是**"清空"，
 * 绝不能当成 0 静默写入（曾把 WB 400/100 保存成 0/100）。
 * 真正的空输入（`badInput !== true`）仍然是 0 = 未配置，不能被误禁。
 *
 * @returns {{ ok:boolean, value?:number, reason?:string }}
 */
function policyReadNumberEvent(event) {
  var target = event !== null && event !== undefined ? event.target : null
  var validity = target !== null && target !== undefined ? target.validity : null
  if (validity !== null && validity !== undefined && validity.badInput === true) {
    return {
      ok: false,
      reason: '输入的不是有效数字（浏览器已拒绝该内容）。本次未修改：请重新输入，或留空表示未配置。',
    }
  }
  var value = policyTextNum(target !== null && target !== undefined ? target.value : '')
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: '阈值必须是数字（留空 = 未配置）。本次未修改。' }
  }
  return { ok: true, value: value }
}

/** 解析关注渠道列表（own property、去重、保序；**不截断**）。 */
function policyParseFocus(raw) {
  if (raw === undefined) return { state: 'absent', list: [] }
  if (typeof raw === 'string' && raw.trim().length === 0) return { state: 'absent', list: [] }
  if (typeof raw !== 'string') return { state: 'invalid', list: [] }
  var parsed
  try { parsed = JSON.parse(raw) } catch (err) { return { state: 'invalid', list: [] } }
  if (!Array.isArray(parsed)) return { state: 'invalid', list: [] }
  var list = []
  for (var i = 0; i < parsed.length; i++) {
    var item = parsed[i]
    if (typeof item !== 'string') continue
    var id = item.trim()
    if (id.length === 0 || list.indexOf(id) !== -1) continue
    list.push(id)
  }
  return { state: 'ok', list: list }
}

function policyFocusJson(list) {
  return JSON.stringify(Array.isArray(list) ? list : [])
}

/**
 * 一对阈值的展示形态（数值 0 = 未配置）。
 *
 * ⚠️ 这里**不夹取**越界值：已保存的 105 要如实显示出来，让保存校验报错；
 * 若在这里夹成 0，「越界」就变成「未配置」，用户永远看不到问题（父裁决 P04）。
 */
function policyPairOf(raw) {
  var box = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (box === null) return { warning: 0, closing: 0, present: false }
  var warning = policyNum(Object.prototype.hasOwnProperty.call(box, 'warning') ? box.warning : 0)
  var closing = policyNum(Object.prototype.hasOwnProperty.call(box, 'closing') ? box.closing : 0)
  return { warning: warning, closing: closing, present: warning > 0 || closing > 0 }
}

function policyCurrencyOf(raw) {
  var box = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (box === null) return ''
  var code = typeof box.currency === 'string' ? box.currency.trim().toUpperCase() : ''
  return /^[A-Z]{3}$/.test(code) ? code : ''
}

/**
 * 解析 `quotaChannelThresholds`（与 Host `parseChannelThresholds` 同构）。
 *
 * 返回 `{ state:'absent'|'invalid'|'ok', reason, channels }`；`channels[id]` 形如
 * `{ ok, windows:{key:{warning,closing,present}}, balance, credits }`。
 * 保留原始条目对象（`raw`）以便写回时**原样带过**未知键。
 */
function policyParseThresholds(raw) {
  if (raw === undefined) return { state: 'absent', reason: '', channels: {} }
  if (typeof raw !== 'string') return { state: 'invalid', reason: '不是文本', channels: {} }
  var text = raw.trim()
  if (text.length === 0) return { state: 'absent', reason: '', channels: {} }
  if (text.length > POLICY_MAX_JSON) return { state: 'invalid', reason: '配置过大（上限 ' + POLICY_MAX_JSON + ' 字符）', channels: {} }
  var parsed
  try { parsed = JSON.parse(text) } catch (err) { return { state: 'invalid', reason: '不是合法 JSON', channels: {} } }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', reason: '顶层不是对象', channels: {} }
  }
  /**
   * [2026-10-23 父裁决 P07] 危险键（任意层级）→ 整体 invalid：不能"跳过"后
   * 降级成「缺该渠道 → 继承 legacy」。遍历有界（深度 ≤ 6、节点 ≤ 500）。
   */
  if (policyContainsForbiddenKey(parsed)) {
    return { state: 'invalid', reason: '配置里出现不允许的键（__proto__ / constructor / prototype）', channels: {} }
  }
  var ids = Object.keys(parsed)
  if (ids.length > POLICY_MAX_CHANNELS) {
    return { state: 'invalid', reason: '渠道条目过多（上限 ' + POLICY_MAX_CHANNELS + '）', channels: {} }
  }
  var channels = {}
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    if (!policyIsSafeKey(id)) {
      return { state: 'invalid', reason: '渠道键不合法：' + id, channels: {} }
    }
    var entry = parsed[id]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      channels[id] = { ok: false, raw: null, windows: {}, balance: null, credits: null }
      continue
    }
    var windows = {}
    var winRaw = Object.prototype.hasOwnProperty.call(entry, 'windows') && entry.windows !== null
      && typeof entry.windows === 'object' && !Array.isArray(entry.windows)
      ? entry.windows
      : null
    if (winRaw !== null) {
      for (var k = 0; k < POLICY_WINDOW_KEYS.length; k++) {
        var key = POLICY_WINDOW_KEYS[k]
        if (!Object.prototype.hasOwnProperty.call(winRaw, key)) continue
        windows[key] = policyPairOf(winRaw[key])
      }
    }
    var balanceRaw = Object.prototype.hasOwnProperty.call(entry, 'balance') ? entry.balance : null
    var balance = balanceRaw !== null && typeof balanceRaw === 'object' && !Array.isArray(balanceRaw)
      ? Object.assign(policyPairOf(balanceRaw), { currency: policyCurrencyOf(balanceRaw) })
      : null
    var creditsRaw = Object.prototype.hasOwnProperty.call(entry, 'credits') ? entry.credits : null
    var credits = creditsRaw !== null && typeof creditsRaw === 'object' && !Array.isArray(creditsRaw)
      ? policyPairOf(creditsRaw)
      : null
    channels[id] = { ok: true, raw: entry, windows: windows, balance: balance, credits: credits }
  }
  return { state: 'ok', reason: '', channels: channels }
}

/** 该渠道是否已配置了任何有效阈值（0 = 未配置）。 */
function policyEntryActive(entry, kind) {
  if (entry === null || entry === undefined || entry.ok !== true) return false
  if (kind === 'window') {
    for (var k = 0; k < POLICY_WINDOW_KEYS.length; k++) {
      var pair = entry.windows[POLICY_WINDOW_KEYS[k]]
      if (pair !== undefined && (pair.warning > 0 || pair.closing > 0)) return true
    }
    return false
  }
  if (kind === 'credits') return entry.credits !== null && (entry.credits.warning > 0 || entry.credits.closing > 0)
  return entry.balance !== null && (entry.balance.warning > 0 || entry.balance.closing > 0)
}

/** 旧全局阈值在该渠道类型下的取值（legacy 分支）。 */
function policyLegacyPair(current, kind) {
  if (kind === 'balance') {
    return {
      warning: policyNum(current.quotaWarningBalanceThreshold),
      closing: policyNum(current.quotaClosingBalanceThreshold),
      currency: settingText(current, 'quotaBalanceCurrency').trim().toUpperCase(),
    }
  }
  if (kind === 'credits') {
    return {
      warning: policyNum(current.quotaWarningCreditsThreshold),
      closing: policyNum(current.quotaClosingCreditsThreshold),
      currency: '',
    }
  }
  return {
    warning: policyNum(current.quotaWarningPercentThreshold),
    closing: policyNum(current.quotaClosingPercentThreshold),
    currency: '',
  }
}

/** 旧语义「最短窗口」：在没有 per-channel 条目时，真正被旧阈值判定的是这一个窗口。 */
function policyLegacyWindowKey(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return null
  var rank = function (key) {
    for (var i = 0; i < POLICY_LEGACY_WINDOW_ORDER.length; i++) {
      if (key.indexOf(POLICY_LEGACY_WINDOW_ORDER[i]) !== -1) return i
    }
    return POLICY_LEGACY_WINDOW_ORDER.length
  }
  var best = keys[0]
  for (var j = 1; j < keys.length; j++) {
    if (rank(keys[j]) < rank(best)) best = keys[j]
  }
  return best
}

/**
 * 旧全局阈值在该渠道类型下**真正有效**的取值。
 *
 * 父裁决 P06：`legacy` 金额阈值只有在**旧币种字段本身有效**时才算有效规则；
 * 旧币种为空 → 旧实现根本不比较（不是"等采样来了再补币种"），因此这里返回 null，
 * **绝不**用当前采样币种把一条本来无效的旧规则"补"成有效规则。
 *
 * @returns {object|null} `{ warning, closing, windowKey?, currency? }`；null = 旧规则无效/不可知
 */
function policyLegacyEffective(current, kind, samples) {
  var pair = policyLegacyPair(current, kind)
  if (pair.warning <= 0 && pair.closing <= 0) return null
  if (pair.warning > 0 && pair.closing > 0 && pair.closing >= pair.warning) return null
  if (kind === 'window') {
    // 旧语义只作用于「最短窗口」；还不知道有哪些窗口时无法复现 → 不可知。
    var key = policyLegacyWindowKey(samples && samples.keys)
    if (key === null) return null
    return { warning: pair.warning, closing: pair.closing, windowKey: key }
  }
  if (kind === 'balance') {
    if (typeof pair.currency !== 'string' || pair.currency.length === 0) return null
    return { warning: pair.warning, closing: pair.closing, currency: pair.currency }
  }
  return { warning: pair.warning, closing: pair.closing }
}

/**
 * 界面应显示的某指标两档数值。
 *
 * 有该渠道条目 → 用条目（0 = 未配置）；
 * 没有条目 → 显示它**当前真正生效**的旧全局值（P01：不能显示空白却按旧值判定）。
 * 旧规则无效/不可知 → 显示 0（= 未配置），与 Host 的判定保持一致。
 */
function policyDisplayPair(kind, entry, key, current, samples) {
  if (entry !== null && entry !== undefined && entry.ok === true) {
    if (kind === 'window') {
      var pair = entry.windows[key]
      if (pair !== undefined) return { warning: pair.warning, closing: pair.closing }
      return { warning: 0, closing: 0 }
    }
    if (kind === 'credits') {
      return entry.credits !== null ? { warning: entry.credits.warning, closing: entry.credits.closing } : { warning: 0, closing: 0 }
    }
    return entry.balance !== null ? { warning: entry.balance.warning, closing: entry.balance.closing } : { warning: 0, closing: 0 }
  }
  var eff = policyLegacyEffective(current, kind, samples)
  if (eff === null) return { warning: 0, closing: 0 }
  if (kind === 'window' && eff.windowKey !== key) return { warning: 0, closing: 0 }
  return { warning: eff.warning, closing: eff.closing }
}

/** 对象里（任意层）是否出现危险键；有界遍历（深度 ≤ 6、节点 ≤ 500）。 */
function policyContainsForbiddenKey(value) {
  var visited = 0
  function walk(node, depth) {
    if (visited > 500 || depth > 6) return false
    if (node === null || node === undefined || typeof node !== 'object') return false
    visited += 1
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) if (walk(node[i], depth + 1)) return true
      return false
    }
    var keys = Object.keys(node)
    for (var k = 0; k < keys.length; k++) {
      if (POLICY_FORBIDDEN_KEYS.indexOf(keys[k]) !== -1) return true
      if (walk(node[keys[k]], depth + 1)) return true
    }
    return false
  }
  return walk(value, 0)
}

/**
 * 往阈值 JSON 里写一条渠道条目（保留其它条目与未知键）。
 *
 * @returns {{ ok:boolean, json?:string, reason?:string }}
 */
function policyMutateThresholds(baseJson, channelId, mutator) {
  if (!policyIsSafeKey(channelId)) return { ok: false, reason: '渠道 id 不合法' }
  var text = typeof baseJson === 'string' ? baseJson.trim() : ''
  var root = {}
  if (text.length > 0) {
    var parsed
    try { parsed = JSON.parse(text) } catch (err) { return { ok: false, reason: '当前阈值配置不是合法 JSON，已取消本次写入（不会覆盖原数据）' } }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: '当前阈值配置顶层不是对象，已取消本次写入（不会覆盖原数据）' }
    }
    if (policyContainsForbiddenKey(parsed)) {
      return { ok: false, reason: '当前阈值配置里含不允许的键（__proto__ / constructor / prototype），已取消本次写入' }
    }
    root = parsed
  }
  var entry = Object.prototype.hasOwnProperty.call(root, channelId) ? root[channelId] : undefined
  if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
    // 只有用户**明确编辑本渠道**时才重建这一条（其它渠道一律不动）。
    entry = {}
  }
  mutator(entry)
  root[channelId] = entry
  var next = JSON.stringify(root)
  if (next.length > POLICY_MAX_JSON) return { ok: false, reason: '阈值配置过大（上限 ' + POLICY_MAX_JSON + ' 字符）' }
  return { ok: true, json: next }
}

/** 该渠道在 `/api/plan-usage/quota-windows` 里的样本摘要。 */
function policySamplesOf(windowsState, channelId) {
  var empty = { status: 'none', keys: [], currency: '', unit: '', percentOf: {} }
  if (!windowsState || !windowsState.channels) return empty
  var row = windowsState.channels[channelId]
  if (!row || typeof row !== 'object') return empty
  var keys = []
  var percentOf = {}
  if (Array.isArray(row.windows)) {
    for (var i = 0; i < row.windows.length; i++) {
      var win = row.windows[i]
      if (!win || typeof win !== 'object') continue
      if (POLICY_WINDOW_KEYS.indexOf(win.key) === -1) continue
      if (typeof win.percent !== 'number' || !isFinite(win.percent)) continue
      keys.push(win.key)
      percentOf[win.key] = win.percent
    }
  }
  return {
    status: typeof row.status === 'string' ? row.status : 'none',
    keys: keys,
    percentOf: percentOf,
    currency: typeof row.currency === 'string' ? row.currency.toUpperCase() : '',
    unit: typeof row.unit === 'string' ? row.unit : '',
    sampledAt: typeof row.sampledAt === 'number' ? row.sampledAt : null,
  }
}

/**
 * 「生效状态」一句话：按闸门顺序给出**实际**原因（用户问"为什么没生效"时看这里）。
 */
/**
 * 页面顶部「额度策略」小节。
 *
 * [2026-10-23 单总开关] 用户确认：不再保留独立的「路由信任」控件。
 * 顶栏只有一个总开关；它代表**完整授权状态**——
 * `quotaPolicyEnabled === true` **且** `quotaTrustRouteOrder === true`（旧字段仍在 Host 侧保留）。
 * 旧的 `true/false`（含缺字段/坏类型）一律显示为"未完整启用"，只提示、**不静默写入**。
 */
function renderPolicyGlobalSection(p) {
  var current = p.current || {}
  var locked = p.writable !== true || p.saving === true
  var focusInfo = p.focusInfo || { state: 'absent', list: [] }
  var known = {}
  for (var i = 0; i < PLANS.length; i++) known[PLANS[i].id] = true
  var others = []
  for (var j = 0; j < focusInfo.list.length; j++) {
    if (known[focusInfo.list[j]] !== true) others.push(focusInfo.list[j])
  }
  var fullOn = policyFullyEnabled(current)
  var legacyIncomplete = current.quotaPolicyEnabled === true && current.quotaTrustRouteOrder !== true
  var stateText = fullOn ? '已启用' : (legacyIncomplete ? '未完整启用（需再打开一次总开关）' : '未启用')
  /**
   * [2026-10-24 布局重做] 紧凑顶部：主开关与状态/关注计数同一行，长说明折叠进 details。
   *
   * 折叠用原生 `<details>`：内容是**照常挂载**的（不会卸载受控输入、不会丢草稿），
   * 只是默认收起；告警与错误**不**放进 details，保证始终可见。
   */
  var children = [
    h('div', { key: 'head', style: policyHeadStyle, 'data-policy-head': '1' },
      h('label', { style: settingsRowStyle },
        h('input', {
          type: 'checkbox',
          'data-policy-master': '1',
          checked: fullOn,
          disabled: locked,
          onChange: function (e) { p.onTogglePolicy(e.target.checked) },
        }),
        h('span', {}, '启用额度策略'),
      ),
      h('span', {
        style: fullOn ? policyStateChipOnStyle : policyStateChipOffStyle,
        'data-policy-state': fullOn ? 'on' : (legacyIncomplete ? 'incomplete' : 'off'),
      }, stateText),
      h('span', { style: policyStatusStyle, 'data-policy-summary': '1' },
        '已关注 ' + focusInfo.list.length + '/' + POLICY_MAX_FOCUS + ' 个渠道'),
    ),
    // 长说明折叠（内容始终挂载；默认收起不占纵向空间）
    h('details', { key: 'how', style: policyDetailsStyle, 'data-policy-help': '1' },
      h('summary', { style: policySummaryStyle }, '额度策略怎么工作（点开查看）'),
      h('p', { key: 'intro', style: settingsHintStyle },
        '额度策略只是给模型的一段建议：不改变额度、不强制停工、也不会自动切模型。'
        + '打开总开关后，插件会按本次请求真实使用的供应商路由，自动匹配你在卡片底部勾选「关注额度策略」的渠道，'
        + '并按该渠道自己的阈值给出提示；未关注、未知或歧义路由不注入任何额度事实或规则。'
        + '这不是对第三方连接插件安装顺序的自动验真。'),
      h('p', { key: 'enabled-hint', style: policyStatusStyle },
        '关闭时不注入任何额度事实与规则；关闭时各渠道的「关注额度策略」区域会整块隐藏（已保存的关注与阈值保留）。'
        + '勾选渠道「关注」不会替你打开这个开关。'),
    ),
    legacyIncomplete
      ? h('p', { key: 'legacy-incomplete', style: policyWarnHintStyle, 'data-policy-legacy-incomplete': '1' },
        '旧版设置未完整启用，请打开总开关完成启用。')
      : null,
    /**
     * [2026-10-24] 渠道块隐藏时，**不能把该渠道的坏草稿错误一起吞掉**：
     * 这里把 `__policy_<id>` 的错误提升到全局可见，并给出"打开总开关修正 / 放弃更改"两条路。
     */
    (!fullOn && Array.isArray(p.hiddenErrors) && p.hiddenErrors.length > 0)
      ? h('div', { key: 'hidden-errors', 'data-policy-hidden-errors': '1' },
        [h('p', { key: 'title', style: policyWarnHintStyle },
          '总开关关闭时渠道策略区已隐藏，但仍有未解决的额度策略问题：打开总开关可回去修正，或点下方「放弃更改」。')].concat(
          p.hiddenErrors.map(function (item) {
            return h('p', { key: 'e-' + item.id, style: policyErrorStyle, role: 'alert', 'data-policy-hidden-error': item.id },
              item.id + '：' + item.message)
          })
        ))
      : null,
  ]
  if (focusInfo.state === 'invalid') {
    children.push(h('p', { key: 'focus-invalid', style: policyErrorStyle, role: 'alert', 'data-policy-focus-error': '1' },
      '关注渠道列表无法解析（当前配置不是合法数组）。为避免覆盖原数据，勾选不会自动重建它；'
      + '可点下面的「清空关注名单」把它显式重置为 []（只写入草稿，保存后生效）。'))
    children.push(h('div', { key: 'focus-reset', style: policyPairRowStyle },
      h('button', {
        type: 'button', style: policyTinyButtonStyle, disabled: locked,
        'data-policy-focus-reset': '1',
        onClick: function () { p.onResetFocus() },
      }, '清空关注名单（写为 []）'),
    ))
  }
  if (others.length > 0) {
    var otherRows = [
      h('p', { key: 'others-title', style: policyStatusStyle },
        '其它已关注条目（不在当前渠道列表里；原样保留，可单独取消）：'),
    ]
    for (var o = 0; o < others.length; o++) {
      otherRows.push(h('div', { key: 'other-' + others[o], style: policyPairRowStyle },
        h('span', {}, others[o]),
        h('button', {
          type: 'button', style: policyTinyButtonStyle, disabled: locked,
          'data-policy-focus-remove': others[o],
          onClick: function (id) { return function () { p.onRemoveFocus(id) } }(others[o]),
        }, '取消关注'),
      ))
    }
    children.push(h('div', { key: 'others', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, otherRows))
  }
  if (typeof p.error === 'string' && p.error.length > 0) {
    children.push(h('p', { key: 'error', style: policyErrorStyle, role: 'alert', 'data-policy-error': '1' }, p.error))
  }
  var ws = p.windowsState || { loaded: false, error: false }
  children.push(h('div', { key: 'refresh', style: policyPairRowStyle },
    h('button', {
      type: 'button', style: policyTinyButtonStyle, disabled: locked || ws.loading === true,
      'data-policy-refresh': '1',
      onClick: function () { p.onRefresh() },
    }, ws.loading === true ? '正在读取窗口…' : '刷新窗口信息'),
    h('span', { style: policyStatusStyle },
      ws.error === true
        // 父裁决：失败 ≠ 没有该窗口；已保存配置保留，且不造可编辑窗口。
        ? '未能读取窗口信息，已保存配置保留；获取失败不代表没有该窗口。'
        : (ws.loaded === true
          ? '窗口信息来自本插件已有的采集观察，不会额外请求任何供应商。'
          : '窗口信息是只读的采集状态，不会额外请求任何供应商。')),
  ))
  return h('div', { key: '__policy_global', style: settingsGroupStyle, 'data-policy-global': '1' }, children)
}

/**
 * 单个渠道卡片底部的「关注额度策略」+ 阈值块。
 *
 * 只用**实际采样到**的窗口渲染输入（不硬造）；失败/未采样只给状态说明。
 * 只做「关注 / 阈值」两件事：绝不改总开关、路由信任或任何凭据字段。
 */
function renderChannelPolicyBlock(p) {
  var current = p.current || {}
  /**
   * [2026-10-24 用户需求] 总开关关闭时，渠道级的「关注额度策略」整块**直接不渲染**。
   *
   * 判据用 `policyFullyEnabled`（两个授权布尔都严格 true），而不是只看 `quotaPolicyEnabled`
   * ——否则旧的 `true/false`（主区显示"未完整启用"）仍会把子块露出来，自相矛盾。
   * 隐藏的是整块（关注 + 阈值 + 状态说明），**不动**已保存的 focus / 阈值草稿与错误，
   * 也不动渠道监控、凭据字段、自定义条目的复制/删除/排序。
   * 自定义余额卡走同一个函数（`policyFooter`），因此两类渠道一起隐藏。
   */
  if (policyFullyEnabled(current) !== true) return null
  var locked = p.writable !== true || p.saving === true
  var channelId = p.channelId
  var kind = p.kind
  var samples = p.samples || { status: 'none', keys: [], currency: '', percentOf: {} }
  var entry = p.entry
  var focused = p.focused === true
  /**
   * 阈值输入的统一入口：**先分辨原生非法输入**（`validity.badInput`），再写入。
   * 这样 `input[type=number]` 的非法编辑（value:'' + badInput:true）不会被当成"清空"。
   */
  function pairInputHandler(kindArg, keyArg, field) {
    return function (e) {
      var read = policyReadNumberEvent(e)
      if (read.ok !== true) {
        if (typeof p.onInputRejected === 'function') p.onInputRejected(channelId, read.reason)
        return
      }
      p.onWritePair(channelId, kindArg, keyArg, field, read.value)
    }
  }
  var children = [
    h('label', { key: 'focus', style: settingsRowStyle },
      h('input', {
        type: 'checkbox',
        'data-policy-focus': channelId,
        checked: focused,
        disabled: locked,
        onChange: function (e) { p.onToggleFocus(channelId, e.target.checked) },
      }),
      h('span', { style: { fontWeight: 500 } }, '关注额度策略'),
    ),
  ]
  if (focused) {
    if (kind === 'window') {
      if (samples.keys.length === 0) {
        var why = '尚未取得本渠道的额度窗口。'
        if (samples.status === 'failed' || samples.status === 'expired') {
          why = '本渠道额度获取失败／身份过期：**这不是**"没有该窗口"，因此不显示可编辑窗口。'
        } else if (samples.status === 'cached') {
          why = '本次是缓存值，尚未确认窗口列表。'
        } else if (samples.status === 'stale-identity') {
          why = '渠道身份已变化（Key/配置/账号），旧窗口信息作废，等待一次新的成功采样。'
        }
        children.push(h('p', { key: 'no-window', style: policyStatusStyle, 'data-policy-no-window': channelId }, why
          + '可点击上方「刷新窗口信息」，或等待一次成功采集后自动出现。'))
      } else {
        /**
         * [2026-10-24 布局重做] 订阅策略改成对齐的表格式行：
         * `窗口 | 当前剩余 | 预警% | 收尾%`，只在**真实存在的窗口**上渲染（不造月窗）。
         * 行仍用 flex + flexWrap + minWidth:0：窄屏逐行折行，不写固定总宽、不产生横向溢出。
         */
        children.push(h('div', { key: 'win-head', style: policyWindowHeadStyle, 'data-policy-window-head': channelId },
          h('span', { style: policyWindowLabelCellStyle }, '窗口'),
          h('span', { style: policyWindowValueCellStyle }, '当前剩余'),
          h('span', { style: policyWindowValueCellStyle }, '预警%'),
          h('span', { style: policyWindowValueCellStyle }, '收尾%'),
        ))
        // 单位外显（不只写在 aria-label 里）：整表百分比都是"剩余"口径。
        children.push(h('p', { key: 'win-unit', style: policyStatusStyle, 'data-policy-window-unit': channelId },
          '表中百分比均为该窗口的**剩余**额度占比；0 = 未配置。'))
        for (var i = 0; i < POLICY_WINDOW_KEYS.length; i++) {
          var key = POLICY_WINDOW_KEYS[i]
          if (samples.keys.indexOf(key) === -1) continue
          // P01：没有条目时显示**旧时真正生效**的那一个窗口的两档（不是空白）。
          var shown = policyDisplayPair(kind, entry, key, current, samples)
          var warn = shown.warning
          var close = shown.closing
          var pct = typeof samples.percentOf[key] === 'number' ? samples.percentOf[key] : null
          children.push(h('div', { key: 'win-' + key, style: policyWindowRowStyle, 'data-policy-window': key },
            h('span', { style: policyWindowLabelCellStyle }, policyLabelOf(key) || key),
            h('span', { style: policyWindowValueCellStyle, 'data-policy-window-now': key },
              pct === null ? '—' : (pct + '%')),
            h('input', {
              type: 'number', min: 0, max: 100, step: 1, style: policyInputStyle,
              'data-policy-warning': channelId + '|' + key,
              value: warn > 0 ? String(warn) : '',
              placeholder: '0',
              disabled: locked,
              'aria-label': (policyLabelOf(key) || key) + ' 预警（剩余 %）',
              onChange: function (k) {
                return pairInputHandler(kind, k, 'warning')
              }(key),
            }),
            h('input', {
              type: 'number', min: 0, max: 100, step: 1, style: policyInputStyle,
              'data-policy-closing': channelId + '|' + key,
              value: close > 0 ? String(close) : '',
              placeholder: '0',
              disabled: locked,
              'aria-label': (policyLabelOf(key) || key) + ' 收尾（剩余 %）',
              onChange: function (k) {
                return pairInputHandler(kind, k, 'closing')
              }(key),
            }),
          ))
        }
        // 已保存但本次采样没出现的窗口：只给一句通用说明（F2：不算成"已保存 5h 值"常规行）。
        var hasHidden = false
        if (entry !== null && entry !== undefined && entry.ok === true) {
          for (var hk = 0; hk < POLICY_WINDOW_KEYS.length; hk++) {
            var hkey = POLICY_WINDOW_KEYS[hk]
            var hp = entry.windows[hkey]
            if (hp === undefined) continue
            if (samples.keys.indexOf(hkey) !== -1) continue
            if (hp.warning === 0 && hp.closing === 0) continue
            hasHidden = true
            break
          }
        }
        if (hasHidden) {
          children.push(h('p', { key: 'hidden-windows', style: policyStatusStyle, 'data-policy-hidden-windows': channelId },
            '未出现窗口的已保存配置已保留（本次采样没有它们，因此不显示、也不参与判定）。'))
        }
      }
    } else if (kind === 'credits') {
      // P01：没有条目时显示旧时生效的积分类两档（旧规则无效则显示 0）。
      var shownC = policyDisplayPair('credits', entry, null, current, samples)
      var cp = { warning: shownC.warning, closing: shownC.closing }
      children.push(h('div', { key: 'credits', style: policyPairRowStyle },
        h('span', { style: { minWidth: 96 } }, '积分阈值'),
        h('span', {}, '预警'),
        h('input', {
          type: 'number', min: 0, step: 1, style: policyInputStyle,
          'data-policy-warning': channelId + '|credits',
          value: cp.warning > 0 ? String(cp.warning) : '', placeholder: '0', disabled: locked,
          onChange: pairInputHandler(kind, null, 'warning'),
        }),
        h('span', {}, '收尾'),
        h('input', {
          type: 'number', min: 0, step: 1, style: policyInputStyle,
          'data-policy-closing': channelId + '|credits',
          value: cp.closing > 0 ? String(cp.closing) : '', placeholder: '0', disabled: locked,
          onChange: pairInputHandler(kind, null, 'closing'),
        }),
        h('span', {}, '积分（不与金额比较）'),
      ))
    } else {
      // 金额：币种只认「已保存条目里的币种」或「可信采样里的币种」或「旧规则自己的币种」，绝不默认 CNY。
      var shownB = policyDisplayPair('balance', entry, null, current, samples)
      var bp = { warning: shownB.warning, closing: shownB.closing }
      var effLegacyBalance = policyLegacyEffective(current, 'balance', samples)
      var code = entry !== null && entry !== undefined && entry.ok === true && entry.balance !== null
        ? entry.balance.currency
        : (samples.currency.length > 0 ? samples.currency : (effLegacyBalance !== null ? effLegacyBalance.currency : ''))
      var noCurrency = code.length === 0
      children.push(h('div', { key: 'balance', style: policyPairRowStyle },
        h('span', { style: { minWidth: 96 } }, '余额阈值' + (code ? '（' + code + '）' : '')),
        h('span', {}, '预警'),
        h('input', {
          type: 'number', min: 0, step: 1, style: policyInputStyle,
          'data-policy-warning': channelId + '|balance',
          value: bp.warning > 0 ? String(bp.warning) : '', placeholder: '0',
          disabled: locked || noCurrency,
          onChange: pairInputHandler(kind, null, 'warning'),
        }),
        h('span', {}, '收尾'),
        h('input', {
          type: 'number', min: 0, step: 1, style: policyInputStyle,
          'data-policy-closing': channelId + '|balance',
          value: bp.closing > 0 ? String(bp.closing) : '', placeholder: '0',
          disabled: locked || noCurrency,
          onChange: pairInputHandler(kind, null, 'closing'),
        }),
      ))
      if (noCurrency) {
        children.push(h('p', { key: 'no-currency', style: policyStatusStyle, 'data-policy-no-currency': channelId },
          '币种未知（还没有成功采样、条目里也没保存币种）：金额阈值暂不可填。'
          + '这里不会猜成 CNY —— 币种不一致的阈值一律不参与判定。'))
      }
    }
    children.push(h('p', { key: 'status', style: policyStatusStyle, 'data-policy-status': channelId },
      policyStatusText({
        current: current,
        kind: kind,
        focused: focused,
        focusState: p.focusState,
        thresholdsState: p.thresholdsState,
        entry: entry,
        samples: samples,
        monitorOn: p.monitorOn !== false,
        channelEnabled: p.channelEnabled !== false,
      })))
    if (typeof p.error === 'string' && p.error.length > 0) {
      children.push(h('p', { key: 'err', style: policyErrorStyle, role: 'alert', 'data-policy-channel-error': channelId }, p.error))
    }
  }
  return h('div', { key: '__policy_' + channelId, style: policyBlockStyle, 'data-policy-block': channelId }, children)
}

/**
 * 「生效状态」一句话：按闸门顺序给出**实际**原因（用户问"为什么没生效"时看这里）。
 */
function policyStatusText(args) {
  var current = args.current || {}
  var kind = args.kind
  var samples = args.samples || { status: 'none', keys: [], currency: '', percentOf: {} }
  var entry = args.entry !== undefined ? args.entry : null

  // ---- ① 闸门（配置层，任何一条不满足都"不会注入任何东西"）----
  // [2026-10-23 单总开关] 完整授权 = policy 与 trust 都严格 true；
  // 旧 true/false（含缺字段/坏类型）只能说明"旧版没配全"，这里如实说明并指引用户打开总开关。
  if (policyFullyEnabled(current) !== true) {
    if (current.quotaPolicyEnabled === true && current.quotaTrustRouteOrder !== true) {
      return '未完整启用：旧版设置未同时打开路由授权，请打开上方总开关完成启用（当前不会注入任何提示）。'
    }
    return '未生效：额度策略总开关未打开。'
  }
  /**
   * P11：用量监控总开关关闭时 Host **根本不采集**，也不会注入任何额度或规则。
   * 这里必须如实说"未生效"，不能因为阈值填好了就宣称"已参与"。
   */
  if (args.monitorOn === false || current.enabled === false) {
    return '未生效：用量监控总开关已关闭（Host 不采集额度，也不会注入任何提示）。'
  }
  if (args.focusState === 'invalid') return '未生效：关注渠道列表无法解析，已停止参与（不会静默重建）。'
  if (args.focused !== true) return '未生效：本渠道未勾选「关注额度策略」。'
  if (args.channelEnabled === false) return '未生效：本渠道已停用（Host 不采集该渠道）。'
  if (args.thresholdsState === 'invalid') return '未生效：阈值配置无法解析，已暂停自动判定。'
  if (entry !== null && entry !== undefined && entry.ok === false) {
    return '未生效：本渠道阈值条目类型不正确，已暂停该渠道判定（重新填写即可修复）。'
  }

  // ---- ② 规则本身（per-channel 条目 或 旧全局阈值）----
  var sourceLabel = '本渠道阈值'
  var windowPairs = null // 窗口型：key → {warn, close}
  var scalarText = ''
  var currencyMismatch = ''
  if (entry !== null && entry !== undefined) {
    if (!policyEntryActive(entry, kind)) return '未生效：本渠道尚未填写有效阈值（0 = 未配置）。'
    if (kind === 'window') {
      windowPairs = {}
      for (var i = 0; i < POLICY_WINDOW_KEYS.length; i++) {
        var k = POLICY_WINDOW_KEYS[i]
        var pair = entry.windows[k]
        if (pair === undefined) continue
        if (pair.warning === 0 && pair.closing === 0) continue
        windowPairs[k] = { warning: pair.warning, closing: pair.closing }
      }
    } else if (kind === 'credits') {
      scalarText = '积分 预警 ' + entry.credits.warning + ' / 收尾 ' + entry.credits.closing
    } else if (entry.balance !== null) {
      var codeSuffix = entry.balance.currency ? ' ' + entry.balance.currency : ''
      scalarText = '余额 预警 ' + entry.balance.warning + codeSuffix + ' / 收尾 ' + entry.balance.closing + codeSuffix
      if (entry.balance.currency && samples.currency && entry.balance.currency !== samples.currency) {
        currencyMismatch = entry.balance.currency + ' → ' + samples.currency
      }
    }
  } else {
    var eff = policyLegacyEffective(current, kind, samples)
    if (eff === null) {
      if (kind === 'balance') {
        var rawLegacy = policyLegacyPair(current, kind)
        if ((rawLegacy.warning > 0 || rawLegacy.closing > 0) && !rawLegacy.currency) {
          return '未生效：旧版全局余额阈值没有配置币种，旧实现本来就不比较（不会用当前采样币种替它补一个）。'
        }
      }
      return '未生效：本渠道尚未填写有效阈值（0 = 未配置）。'
    }
    sourceLabel = '旧版全局阈值（按最短窗口判定）'
    if (kind === 'window') {
      windowPairs = {}
      windowPairs[eff.windowKey] = { warning: eff.warning, closing: eff.closing }
    } else if (kind === 'credits') {
      scalarText = '积分 预警 ' + eff.warning + ' / 收尾 ' + eff.closing
    } else {
      scalarText = '余额 预警 ' + eff.warning + ' ' + eff.currency + ' / 收尾 ' + eff.closing + ' ' + eff.currency
      if (samples.currency && samples.currency !== eff.currency) currencyMismatch = eff.currency + ' → ' + samples.currency
    }
  }

  // ---- ③ 额度事实是否可用（失败 ≠ 没有窗口/没有余额）----
  var facts = typeof samples.status === 'string' ? samples.status : 'none'
  var factsAvailable = facts === 'ok' || facts === 'cached'
  var configText = kind === 'window' ? '' : scalarText
  if (!factsAvailable) {
    var why = '等待一次成功采样'
    if (facts === 'failed') why = '本渠道额度获取失败（失败不等于没有额度）'
    else if (facts === 'expired') why = '本渠道用量查询身份已过期'
    else if (facts === 'stale-identity') why = '渠道身份已变化（Key/配置/账号），旧能力已作废'
    else if (facts === 'cached') why = '当前只有缓存采样'
    return '已就绪，等待可信采样：' + why + '；规则（' + sourceLabel + '）会在有可信数值时判定' + (configText ? '：' + configText : '') + '。'
  }

  // ---- ④ 可判定范围：只列**本次实际出现**且已配置的窗口 ----
  if (kind === 'window') {
    var present = []
    var presentLabels = []
    for (var w = 0; w < POLICY_WINDOW_KEYS.length; w++) {
      var wk = POLICY_WINDOW_KEYS[w]
      if (windowPairs[wk] === undefined) continue
      if (samples.keys.indexOf(wk) === -1) continue
      present.push(wk)
      presentLabels.push((policyLabelOf(wk) || wk) + ' 预警 ' + windowPairs[wk].warning + '% / 收尾 ' + windowPairs[wk].closing + '%')
    }
    if (present.length === 0) {
      if (samples.keys.length === 0) {
        return '未参与本次判定：本次采样没有给出该渠道的任何额度窗口（配置保留）。'
      }
      return '未参与本次判定：已保存的窗口配置在本次采样中都没有出现（配置保留，不借用其它窗口阈值）。'
    }
    return '已参与：' + (entry !== null && entry !== undefined ? '' : '（' + sourceLabel + '）')
      + presentLabels.join('；') + '；各窗口独立判定，整体取最严重。'
  }
  if (currencyMismatch.length > 0) {
    return '未参与本次判定：币种不一致（已保存 ' + currencyMismatch.split(' → ')[0] + '，当前 '
      + currencyMismatch.split(' → ')[1] + '）。'
  }
  return '已参与：按 ' + sourceLabel + ' 判定（' + scalarText + '）。'
}

// ===========================================================================
// [0.9.0] 设置页「自定义余额渠道」区
// ===========================================================================
//
// 位置固定在**内置渠道之后、统一保存/放弃按钮之前**（用户要求）；增删改、启用/
// 停用、上下移、整页统一草稿都由本区自己维护，提交仍走页面底部的「保存更改」。
//
// 密钥边界（本版最关键的安全要求）：
//   - 配置里每条记录的 Key 存放在**独立的 secret dict** `customKeys[id]`，
//     由 DSH 的 `role('secret')` 托管；任何 remote 读取都会把它剥掉，浏览器永远
//     收不到已有的 Key 值；
//   - 因此输入框**从不回填**旧 Key，只显示「已配置/未配置」徽标（来自 Host 的
//     `/api/plan-usage/custom-status` 布尔摘要）；
//   - 保存时用**路径寻址**写入（`customKeys.<id>` 的 set/unset），绝不整体回写
//     这个 dict——整体回写会把其它条目的 Key 抹掉（客户端根本没有它们）；
//   - 掩码不是值：留空 = 不改；填新值 = 覆盖；点「清除已保存 Key」= 显式 unset。

/**
 * [第五轮 UI 要求] 自定义卡片**与内置渠道卡片视觉一致**。
 *
 * 内置用 `settingsGroupStyle`：上分隔线、无外框/无圆角/无底色。
 * 之前自定义是「整圈边框 + 圆角 + 背景」，同页两套样式明显割裂。
 * 现在复用同一套分隔与间距规范，不再加重外框。
 */
/**
 * [2026-10-24 布局重做] 自定义卡片与内置卡片用**同一套**容器外观（轻边框/圆角/内距），
 * 两者仍由页面按全局 `orderedIds` 混排渲染，不分组、不挪到末尾。
 */
var customCardStyle = Object.assign({}, planCardStyle, { gap: 8, marginTop: 10 })
var customFieldRowStyle = { display: 'flex', flexDirection: 'column', gap: 4 }
// [0.9.1] 并排布局：两个短字段同行，节省纵向空间（用户要求把 JSON 键与扣减键放一行）。
var customFieldPairStyle = { display: 'flex', gap: 8, alignItems: 'flex-start' }
var customFieldHalfStyle = { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 0', minWidth: 0 }
var customLabelStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
var customErrorStyle = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' }
var customActionsStyle = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
var customSmallButtonStyle = Object.assign({}, settingsButtonStyle, { padding: '3px 9px', fontSize: 12 })
var customDangerButtonStyle = Object.assign({}, customSmallButtonStyle, { color: 'var(--dsw-alias-state-error-primary)' })

/** 客户端生成稳定 id：优先 crypto.randomUUID，退回随机串（不依赖名称与顺序）。 */
function newClientCustomId() {
  var random = ''
  try {
    if (typeof crypto !== 'undefined' && crypto !== null && typeof crypto.randomUUID === 'function') {
      random = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    }
  } catch (err) {
    random = ''
  }
  if (random.length === 0) {
    // 无 crypto 的裁剪 WebView：用时间 + 随机数拼一个足够散的串（仍不是名称派生）。
    random = (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 16)
    while (random.length < 16) random += Math.floor(Math.random() * 36).toString(36)
  }
  return 'custom:' + random.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16).padEnd(6, '0')
}

/** 客户端侧的条目校验（与 Host 的 C0 规则同构；保存前先给用户明确提示）。 */
function validateCustomEntry(entry) {
  var name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name.length === 0) return '请填写厂商名称'
  if (name.length > 64) return '厂商名称过长（上限 64 字符）'
  /**
   * [0.9.1] 余额来源改为「从已配置的模型渠道中选择」，不再校验 URL。
   *
   * 校验只做「是否已选择」：地址与凭据由 Host 从该 provider 的配置派生，
   * 因此这里没有任何 URL 语法可以检查（也没有用户可填的 URL）。
   */
  var provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
  if (provider.length === 0) return '请选择一个模型渠道作为余额来源'
  if (provider.length > 80) return '模型渠道 id 过长'
  /**
   * [CP-03] 余额接口路径必填：模型接口根通常不是余额端点，插件无法推导。
   * 与 Host 的 `buildBalanceUrl` 同规则（只接受以 / 开头的路径）。
   */
  var endpoint = typeof entry.balanceEndpoint === 'string' ? entry.balanceEndpoint.trim() : ''
  if (endpoint.length === 0) return '请填写余额接口路径（例如 /api/v1/credits）'
  if (endpoint.length > 300) return '余额接口路径过长（上限 300 字符）'
  if (endpoint.charAt(0) !== '/') return '余额接口路径必须以 / 开头，不能填完整网址'
  if (endpoint.slice(0, 2) === '//') return '余额接口路径不能以 // 开头'
  var path = typeof entry.balancePath === 'string' ? entry.balancePath.trim() : ''
  if (path.length === 0) return '请填写结果 JSON 键路径（例如 data.balance）'
  var badPath = checkJsonPathSyntax(path)
  if (badPath !== null) return badPath
  var sub = typeof entry.subtractPath === 'string' ? entry.subtractPath.trim() : ''
  if (sub.length > 0) {
    var badSub = checkJsonPathSyntax(sub)
    if (badSub !== null) return '扣减键：' + badSub
  }
  var cur = typeof entry.currency === 'string' ? entry.currency.trim().toUpperCase() : ''
  if (cur.length > 0 && !/^[A-Z]{2,6}$/.test(cur)) return '币种只接受 2–6 位字母代码（如 CNY / USD），留空表示未指定'
  return null
}

/**
 * 客户端 JSON 键路径语法检查（与 plans/custom-balance.js 的 parseJsonPath 同规则）。
 * 这里只做语法拦截，真正的读取仍在 Host 侧；两边规则必须一致，否则会出现
 * 「设置页放行、取数时报配置错」的割裂。
 */
function checkJsonPathSyntax(text) {
  var raw = String(text).trim()
  if (raw.length === 0) return 'JSON 键路径不能为空'
  if (raw.length > 200) return 'JSON 键路径过长（上限 200 字符）'
  var body = raw
  if (body.charAt(0) === '$') {
    body = body.slice(1)
    if (body.length > 0) {
      if (body.charAt(0) !== '.') return 'JSON 键路径语法无效'
      body = body.slice(1)
    }
  }
  if (body.length === 0) return 'JSON 键路径不能为空'
  var segments = 0
  var i = 0
  while (i < body.length) {
    var start = i
    while (i < body.length && body.charAt(i) !== '.' && body.charAt(i) !== '[') i += 1
    var name = body.slice(start, i)
    if (name.length === 0) return 'JSON 键路径语法无效'
    if (!/^[A-Za-z0-9_$-]+$/.test(name)) return 'JSON 键路径只支持字段名与 [下标]，不支持通配/表达式'
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') return 'JSON 键路径包含禁止的字段名'
    segments += 1
    if (segments > 16) return 'JSON 键路径层级过深（上限 16 段）'
    while (i < body.length && body.charAt(i) === '[') {
      var close = body.indexOf(']', i)
      if (close === -1) return 'JSON 键路径语法无效'
      var digits = body.slice(i + 1, close)
      if (!/^(0|[1-9][0-9]*)$/.test(digits)) return 'JSON 键路径的数组下标必须是非负整数'
      if (Number(digits) > 1000) return '数组下标超出允许范围（0–1000）'
      segments += 1
      if (segments > 16) return 'JSON 键路径层级过深（上限 16 段）'
      i = close + 1
    }
    if (i >= body.length) break
    if (body.charAt(i) !== '.') return 'JSON 键路径语法无效'
    i += 1
    if (i >= body.length) return 'JSON 键路径语法无效'
  }
  return null
}

/**
 * 自定义余额编辑区。props：
 *   entries    当前（草稿优先）条目数组
 *   onChange   接收新数组（整页草稿的一部分）
 *   keyDrafts  { id: 新 Key 文本 }（空串 = 不修改）
 *   keyClears  { id: true }（显式清除已保存 Key）
 *   keyStatus  { id: true } 表示该条已保存 Key（布尔摘要，来自 Host）
 *   refStatus  { id: true } 表示所选凭据引用当前有值
 *   disabled / saving / writable
 *   onKeyChange(id, text) / onKeyClear(id) / onKeyUndoClear(id)
 */
function CustomBalancesSection(props) {
  /**
   * [R4-03] 设置页现在按**全局顺序**逐项渲染，因此本组件可能只被要求渲染
   * 其中**一条**（`props.onlyId`）。这样已有自定义卡片能与内置卡片混排，
   * 而不是永远整块追加在页尾。
   */
  var allEntries = Array.isArray(props.entries) ? props.entries : []
  var singleMode = typeof props.onlyId === 'string' && props.onlyId.length > 0
  /**
   * [R4-03] 单条模式下**仍然保留完整列表**用于排序计算。
   *
   * `entries` 曾被抓成单元素数组，于是 `move()` 里「按自定义顺序重建数组」
   * 只得到一条，保存后把另一条**删掉了**。现在 `entries` 永远是完整列表，
   * 另用一个派生数组决定**渲染哪几条**。
   */
  var entries = allEntries
  var renderEntries = singleMode
    ? allEntries.filter(function (e) { return e !== null && e.id === props.onlyId })
    : allEntries
  var disabled = props.disabled === true
  var locked = disabled || props.saving === true
  var errors = props.errors || {}
  /** [0.9.1] 可选的模型渠道（来自 Host `/api/plan-usage/custom-status`）。 */
  var providerOptions = Array.isArray(props.providers) ? props.providers : []
  var providerNames = {}
  for (var pi = 0; pi < providerOptions.length; pi++) {
    providerNames[providerOptions[pi].provider] = true
  }
  /**
   * [0.9.1] 折叠状态：按条目 id 记忆（组件级，重新渲染不丢）。
   * 折叠时只显示名称、余额/状态与排序箭头，方便一次看到多条再调顺序。
   */
  var collapsed = props.collapsed !== null && typeof props.collapsed === 'object' ? props.collapsed : {}
  var onToggleCollapsed = typeof props.onToggleCollapsed === 'function' ? props.onToggleCollapsed : null

  /**
   * [R5-01] 按**稳定条目 id** 定位并更新，不用数组下标。
   *
   * 设置页现在是「每张卡片一个渲染实例」：单条模式下 `i` 恒为 0，而它是
   * `renderEntries` 的下标。旧实现直接用它索引 `entries`（完整列表），
   * 于是**编辑第二张卡片实际改的是第一张**，保存后 A 被覆盖、B 不变。
   *
   * 审核用真实 SettingsPage 复现了 6 个字段（名称/enabled/provider/
   * balanceEndpoint/balancePath/currency）与删除，这里是同一条根因。
   */
  function update(entryId, field, val) {
    var next = []
    var found = false
    for (var ui = 0; ui < entries.length; ui++) {
      var src = entries[ui]
      if (src === null || src === undefined) continue
      if (src.id !== entryId) { next.push(src); continue }
      var row = {}
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) row[k] = src[k]
      }
      row[field] = val
      // [C0] 改 URL 就必须重新确认凭据发送目标：主机变了就把确认记录清空。
      if (field === 'url') {
        row.credentialHost = ''
        row.urlHostConfirmed = ''
      }
      next.push(row)
      found = true
    }
    if (!found) return
    props.onChange(next)
  }

  /**
   * [顺序修复 2026-10-20 第三次] 自定义条目的 ▲/▼ 在**完整渠道列表**上移动。
   *
   * 审核指出两个必须修的缺陷：
   *   - 只有一条自定义时，`index+delta` 必然越界 → 按钮看起来可点、实际零操作
   *     （SINGLE_CUSTOM_BOTH_ARROWS_NO_OP）；
   *   - 自定义与内置必须能**互相跨越**（用户要求 OpenRouter 移到 Codex/WorkBuddy 之前）。
   *
   * 因此这里不再「只在自定义数组内换位」，而是：
   *   1. 取当前**全局**顺序（`props.globalOrder()`，内置 + 自定义混排）；
   *   2. 在该列表里找到本条的相邻项并交换；
   *   3. 同时把新的自定义相对顺序写回 `customBalances`（Host 取数/投影顺序）。
   */
  function move(index, delta) {
    /**
     * [R4-03] 单条模式下 `entries` 只有一个元素、`index` 恒为 0，
     * 不能拿它当"在完整列表里的位置"。这里一律以**完整自定义列表**为准。
    /**
     * [R4-03] `index` 是 `renderEntries` 里的下标（单条模式下恒为 0），
     * **不是**完整列表里的位置。必须先用 `renderEntries[index]` 取出到底是哪一条，
     * 再回 `allEntries` 找真实下标 —— 否则点「甲」的箭头会移动第一条（乙）。
     */
    var clicked = renderEntries[index]
    if (clicked === undefined || clicked === null) return
    var realIndex = index
    for (var ri = 0; ri < allEntries.length; ri++) {
      if (allEntries[ri] !== null && allEntries[ri].id === clicked.id) { realIndex = ri; break }
    }
    index = realIndex
    var entry = allEntries[index]
    if (entry === undefined) return
    var fullOrder = typeof props.globalOrder === 'function' ? props.globalOrder() : null
    if (!Array.isArray(fullOrder) || fullOrder.length === 0) {
      // 拿不到全局顺序时退回「自定义组内换位」，至少不会完全无响应。
      var to = index + delta
      if (to < 0 || to >= entries.length) return
      var within = entries.slice()
      var rowWithin = within.splice(index, 1)[0]
      within.splice(to, 0, rowWithin)
      if (typeof props.onReorder === 'function') props.onReorder(within.map(function (e) { return e.id }), within)
      else props.onChange(within)
      return
    }
    var at = fullOrder.indexOf(entry.id)
    if (at < 0) return
    var target = at + delta
    if (target < 0 || target >= fullOrder.length) return
    var nextFull = fullOrder.slice()
    nextFull.splice(at, 1)
    nextFull.splice(target, 0, entry.id)
    // 自定义条目的新相对顺序：从完整顺序里筛出**属于本插件自定义条目**的 id。
    var customIds = {}
    for (var ci = 0; ci < allEntries.length; ci++) customIds[allEntries[ci].id] = true
    var orderedCustomIds = []
    for (var fi = 0; fi < nextFull.length; fi++) {
      if (customIds[nextFull[fi]] === true) orderedCustomIds.push(nextFull[fi])
    }
    var nextEntries = []
    for (var oi = 0; oi < orderedCustomIds.length; oi++) {
      for (var ei = 0; ei < entries.length; ei++) {
        if (entries[ei].id === orderedCustomIds[oi]) { nextEntries.push(entries[ei]); break }
      }
    }
    if (typeof props.onReorder === 'function') props.onReorder(nextFull, nextEntries)
  }

  /** [R5-01] 删除同样按 id 定位：旧实现用下标，会误删第一条。 */
  function remove(entryId) {
    if (typeof entryId !== 'string' || entryId.length === 0) return
    props.onDelete(entryId)
  }

  function add() {
    props.onAdd(newClientCustomId())
  }

  function badText(id) {
    var message = errors[id]
    return message ? h('p', { style: customErrorStyle, role: 'alert' }, message) : null
  }

  var rows = []
  for (var i = 0; i < renderEntries.length; i++) {
    var entry = renderEntries[i]
    var id = entry.id
    // [0.9.1] 自定义渠道不再有独立 Key / 凭据引用 / 目标确认：
    // 地址与凭据都来自所选模型渠道，因此这里不再读取 keyStatus / keyDrafts / refStatus。
    var arrowStyle = Object.assign({}, settingsButtonStyle, {
      padding: 0, fontSize: 9, lineHeight: '12px', height: 14, width: 22, margin: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    })
    // [0.9.1] 该条是否折叠；以及所选渠道是否仍可用（用于提示重新选择）。
    /**
     * [顺序修复 2026-10-20 第三次] 按**全局顺序**判定这条能否上移/下移。
     *
     * 单条自定义渠道时，它在完整列表里仍有内置邻居，可以跨组移动；
     * 真正做到列表首/尾时按钮才禁用。
     */
    var fullOrderForRow = typeof props.globalOrder === 'function' ? props.globalOrder() : null
    var globalPos = Array.isArray(fullOrderForRow) ? fullOrderForRow.indexOf(id) : -1
    var canMoveUp = globalPos > 0
    var canMoveDown = Array.isArray(fullOrderForRow) && globalPos >= 0 && globalPos < fullOrderForRow.length - 1
    // [UI 要求] 默认折叠：只有**明确展开过**的条目才铺开编辑字段。
    var isExpanded = collapsed[id] === true
    var isCollapsed = !isExpanded
    var providerKnown = entry.provider ? providerNames[entry.provider] === true : true
    rows.push(h('div', { key: id, style: customCardStyle, 'data-custom-id': id },
      h('div', { style: Object.assign({}, settingsRowStyle, { alignItems: 'center' }) },
        h('label', { style: Object.assign({}, settingsRowStyle, { flex: '1 1 auto', minWidth: 0 }) },
          h('input', {
            type: 'checkbox',
            checked: entry.enabled !== false,
            disabled: locked,
            onChange: function (entryId) { return function (e) { update(entryId, 'enabled', e.target.checked) } }(id),
          }),
          h('span', {}, (entry.name && entry.name.length > 0 ? entry.name : '未命名渠道') + '（自定义）'),
          // [0.9.1] 折叠按钮放在名称旁（用户要求），折叠后便于观察多条并调顺序。
          onToggleCollapsed !== null
            ? h('button', {
              type: 'button',
              'aria-label': (entry.name || '自定义渠道') + (isCollapsed ? ' 展开' : ' 折叠'),
              title: isCollapsed ? '展开' : '折叠',
              style: Object.assign({}, arrowStyle, { width: 18, marginLeft: 4 },
                locked ? settingsButtonDisabledStyle : {}),
              disabled: locked,
              onClick: function (entryId) { return function () { onToggleCollapsed(entryId) } }(id),
            }, isCollapsed ? '▸' : '▾')
            : null,
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0, flex: 'none', marginLeft: 'auto' } },
          h('button', {
            type: 'button', 'aria-label': (entry.name || '自定义渠道') + ' 上移', title: '上移',
            style: Object.assign({}, arrowStyle, (locked || !canMoveUp) ? settingsButtonDisabledStyle : {}),
            disabled: locked || !canMoveUp,
            onClick: function (index) { return function () { move(index, -1) } }(i),
          }, '▲'),
          h('button', {
            type: 'button', 'aria-label': (entry.name || '自定义渠道') + ' 下移', title: '下移',
            style: Object.assign({}, arrowStyle, (locked || !canMoveDown) ? settingsButtonDisabledStyle : {}),
            disabled: locked || !canMoveDown,
            onClick: function (index) { return function () { move(index, +1) } }(i),
          }, '▼'),
        ),
      ),
      // 折叠态：只显示一行摘要（渠道 + 键），方便排序时一眼看多条。
      isCollapsed
        ? h('p', { style: settingsHintStyle },
          (entry.provider ? ('渠道：' + entry.provider) : '未选择渠道')
          + (entry.balancePath ? ' · 键：' + entry.balancePath : ''))
        : h('div', {},
          h('div', { style: customFieldRowStyle },
            h('label', { style: customLabelStyle, htmlFor: 'custom-name-' + id }, '厂商名称（仅显示）'),
            h('input', {
              id: 'custom-name-' + id, type: 'text', style: settingsInputStyle,
              value: entry.name, placeholder: '例如：某某平台余额', maxLength: 64,
              disabled: locked,
              onChange: function (entryId) { return function (e) { update(entryId, 'name', e.target.value) } }(id),
            }),
          ),
      // [0.9.1] 余额地址改为**从已配置的模型渠道中选择**，不再手输。
      // 地址与凭据都从该渠道的配置派生，因此不再需要 Key 输入、凭据引用与目标确认。
      h('div', { style: customFieldRowStyle },
        h('label', { style: customLabelStyle, htmlFor: 'custom-provider-' + id },
          '模型渠道（余额地址与凭据都从该渠道读取）'),
        providerOptions.length === 0
          ? h('p', { style: settingsHintStyle },
            '还没有可选的模型渠道。请先到「设置 → 模型」配置一个服务商（需要填接口地址与 API Key），再回到这里选择。')
          : h('select', {
            id: 'custom-provider-' + id, style: settingsInputStyle,
            value: entry.provider || '', disabled: locked,
            onChange: function (entryId) { return function (e) { update(entryId, 'provider', e.target.value) } }(id),
          },
            h('option', { value: '' }, '— 请选择 —'),
            providerOptions.map(function (opt) {
              return h('option', { key: opt.provider, value: opt.provider },
                opt.displayName + (opt.origin ? '（' + opt.origin + '）' : ''))
            }),
          ),
        /**
         * [CP-08] 显示所选渠道**实际生效的模型 baseURL**（含路径），
         * 让用户看清结尾有没有 `/v1`。同时提示它已脱敏。
         */
        entry.provider
          ? (function () {
            var picked = null
            for (var pi2 = 0; pi2 < providerOptions.length; pi2 += 1) {
              if (providerOptions[pi2].provider === entry.provider) { picked = providerOptions[pi2]; break }
            }
            if (picked === null) return null
            var lines = []
            if (picked.baseURL) {
              lines.push('模型接口地址：' + picked.baseURL
                + (picked.baseURLSource === 'override' ? '（你配置的）' : '（该渠道的预设默认）'))
            } else {
              lines.push('模型接口地址：未能解析，请到「设置 → 模型」检查')
            }
            if (picked.status && picked.status !== 'ready' && picked.reason) {
              lines.push('状态：' + picked.reason)
            }
            return h('p', { style: settingsHintStyle }, lines.join('　'))
          })()
          : null,
        /**
         * [CP-03] 余额接口**路径**必须由用户填写：模型接口根（如 /api/v1）
         * 通常不是余额端点（如 /api/v1/credits），插件不能猜。
         * 主机固定来自所选渠道，用户只能填路径 —— 凭据不会被引到别的主机。
         */
        entry.provider
          ? h('div', { style: customFieldRowStyle },
            h('label', { style: customLabelStyle, htmlFor: 'custom-endpoint-' + id },
              '余额接口路径（主机来自上面的渠道，只填路径）'),
            h('input', {
              id: 'custom-endpoint-' + id, type: 'text', style: settingsInputStyle,
              value: typeof entry.balanceEndpoint === 'string' ? entry.balanceEndpoint : '',
              placeholder: '例如 /api/v1/credits',
              maxLength: 300, disabled: locked,
              onChange: function (entryId) { return function (e) { update(entryId, 'balanceEndpoint', e.target.value) } }(id),
            }),
          )
          : null,
        entry.provider && !providerKnown
          ? h('p', { style: customErrorStyle, role: 'alert' },
            '所选渠道已不可用（可能已在「模型」里删除或改成非 https），请重新选择。')
          : null,
      ),
      // [0.9.1] 两个键并排显示，节省纵向空间。
      h('div', { style: customFieldPairStyle },
        h('div', { style: customFieldHalfStyle },
          h('label', { style: customLabelStyle, htmlFor: 'custom-path-' + id }, '结果 JSON 键'),
          h('input', {
            id: 'custom-path-' + id, type: 'text', style: settingsInputStyle,
            value: entry.balancePath, placeholder: 'data.balance',
            maxLength: 200, disabled: locked,
            onChange: function (entryId) { return function (e) { update(entryId, 'balancePath', e.target.value) } }(id),
          }),
        ),
        h('div', { style: customFieldHalfStyle },
          h('label', { style: customLabelStyle, htmlFor: 'custom-sub-' + id }, '可选扣减键'),
          h('input', {
            id: 'custom-sub-' + id, type: 'text', style: settingsInputStyle,
            value: typeof entry.subtractPath === 'string' ? entry.subtractPath : '',
            placeholder: '留空则直接取余额键',
            maxLength: 200, disabled: locked,
            onChange: function (entryId) { return function (e) { update(entryId, 'subtractPath', e.target.value) } }(id),
          }),
        ),
      ),
      h('div', { style: customFieldPairStyle },
        h('div', { style: customFieldHalfStyle },
          h('label', { style: customLabelStyle, htmlFor: 'custom-cur-' + id }, '币种（可留空）'),
          h('input', {
            id: 'custom-cur-' + id, type: 'text', style: settingsInputStyle,
            value: entry.currency, placeholder: 'CNY / USD', maxLength: 6,
            disabled: locked,
            onChange: function (entryId) { return function (e) { update(entryId, 'currency', e.target.value.toUpperCase()) } }(id),
          }),
        ),
      ),
        ),   // 结束「非折叠内容」容器
      badText(id),
      /**
       * [2026-10-23 父裁决 R5] 自定义余额卡片也提供「关注额度策略」+ 金额两档。
       *
       * 只由设置页通过 `policyFooter` 传入**公共策略块**（同样的组件、同样的草稿/校验），
       * 本组件不感知策略语义，也不因此改动 provider/取数/Key/复制删除/折叠逻辑。
       */
      typeof props.policyFooter === 'function' ? props.policyFooter({ id: id, entry: entry }) : null,
      h('div', { style: customActionsStyle },
        h('button', {
          type: 'button', style: customDangerButtonStyle, disabled: locked,
          onClick: function (entryId) { return function () { remove(entryId) } }(id),
        }, '删除此条'),
      ),
    ))
  }

  /**
   * [R4-03] 单条模式：只渲染这一张卡片本身，不带区块标题与「添加」入口。
   *
   * 设置页会按全局顺序把内置卡片与本组件渲染的单张自定义卡片**逐项混排**；
   * 「添加自定义余额渠道」按钮与说明仍单独留在页尾（审核允许这两项固定页尾）。
   */
  if (singleMode) {
    return h('div', { 'data-custom-balances': '' }, rows)
  }
  /**
   * [R4-03] 页尾「仅添加」模式：只渲染标题、添加入口与说明。
   *
   * 已有条目卡片已按全局顺序混排（`singleMode`），这里不再重复渲染它们。
   */
  if (props.addOnly === true) {
    return h('div', { style: settingsGroupStyle, 'data-custom-balances': '' },
      h('p', { style: settingsHintStyle },
        '自定义余额渠道：普通 HTTPS 余额接口（GET + Bearer + JSON），不做厂商特例。每行独占一条胶囊，支持失败回退与详情卡片。'),
      h('div', { style: customActionsStyle },
        h('button', {
          type: 'button', style: customSmallButtonStyle, disabled: locked || allEntries.length >= 12,
          onClick: add,
        }, '＋ 添加自定义余额渠道'),
        allEntries.length >= 12 ? h('span', { style: settingsHintStyle }, '最多 12 条') : null,
      ),
      allEntries.length === 0
        ? h('p', { style: settingsHintStyle }, '尚未添加自定义渠道。')
        : null,
      h('p', { style: settingsHintStyle },
        '改动需要点击页面底部的「保存更改」；「放弃更改」会连同这里一起还原。用 ▲/▼ 可把任意渠道（含自定义）移到内置渠道之前或之后，顺序在卡片、胶囊与详情面板中一致。'),
    )
  }

  return h('div', { style: settingsGroupStyle, 'data-custom-balances': '' },
    h('p', { style: settingsHintStyle },
      '自定义余额渠道：普通 HTTPS 余额接口（GET + Bearer + JSON），不做厂商特例。每行独占一条胶囊，支持失败回退与详情卡片。'),
    rows.length === 0
      ? h('p', { style: settingsHintStyle }, '尚未添加自定义渠道。')
      : rows,
    h('div', { style: customActionsStyle },
      h('button', {
        type: 'button', style: customSmallButtonStyle, disabled: locked || allEntries.length >= 12,
        onClick: add,
      }, '＋ 添加自定义余额渠道'),
      allEntries.length >= 12 ? h('span', { style: settingsHintStyle }, '最多 12 条') : null,
    ),
    h('p', { style: settingsHintStyle },
      '改动需要点击页面底部的「保存更改」；「放弃更改」会连同这里一起还原。用 ▲/▼ 可把这条移到任意渠道（含内置）之前或之后，顺序在卡片、胶囊与详情面板中一致。'),
  )
}

/** [R5] 规范化配置里记录的「已确认目标」；兼容旧版只存裸主机名的写法。 */
function normalizeClientOrigin(field) {
  if (typeof field !== 'string') return ''
  var text = field.trim()
  if (text.length === 0) return ''
  if (text.indexOf('://') === -1) {
    // 旧数据只存 host：补成 https origin（与 Host 的 normalizeOriginField 一致）。
    var host = text.toLowerCase().replace(/\.$/, '')
    if (host.length === 0) return ''
    var bare = host.replace(/^\[|\]$/g, '')
    if (bare.indexOf(':') !== -1) return 'https://[' + bare + ']'
    return 'https://' + host
  }
  var origin = originOfUrl(text)
  return origin === null ? '' : origin
}

/**
 * 从 URL 取「规范化 origin」，供设置页展示与确认使用。
 *
 * [R5] 必须与 Host 的 `originOf()` **字面一致**：`scheme://host[:port]`，
 * 小写、去末尾点、省略默认 443。否则用户在这里确认的值和 Host 判定用的值
 * 会差一个 `https://` 前缀或一个 `:443`，导致「明明确认过还是被拒」。
 * 只做展示与绑定；真正的安全判定仍在 Host 侧。
 */
function originOfUrl(text) {
  if (typeof text !== 'string') return null
  var trimmed = text.trim()
  if (trimmed.length === 0) return null
  var match = /^(https):\/\/([^\/?#]+)/i.exec(trimmed)
  if (match === null) return null
  var authority = match[2]
  if (authority.indexOf('@') !== -1) return null // userinfo：不由客户端猜目标
  var host = authority
  var port = ''
  var colon = authority.lastIndexOf(':')
  // IPv6 字面量形如 [::1]:8443 —— 用括号位置判断冒号是不是端口分隔符。
  var bracket = authority.lastIndexOf(']')
  if (colon !== -1 && colon > bracket) {
    host = authority.slice(0, colon)
    port = authority.slice(colon + 1)
  }
  host = host.toLowerCase().replace(/\.$/, '')
  if (host.length === 0) return null
  var bare = host.replace(/^\[|\]$/g, '')
  var isV6 = bare.indexOf(':') !== -1
  var effective = port.length > 0 ? port : '443'
  if (!/^[0-9]+$/.test(effective)) return null
  var authorityOut = (isV6 ? '[' + bare + ']' : bare) + (effective === '443' ? '' : ':' + effective)
  return 'https://' + authorityOut
}

/**
 * 设置页组件：一个全局开关 + 每个渠道的开关与（可选）密钥输入。
 * props.form 由 ConfigForms.get(entryId) 提供。
 */
/**
 * 订阅 DSH 托管配置的快照（ConfigFormController 的方法依赖 this，需包一层）。
 * form 缺失（例如未提供 configForms）时返回空对象，调用方按默认值处理。
 */
function useConfigSnapshot(form) {
  var api = React.useMemo(function () {
    if (!form) return null
    return {
      subscribe: function (listener) { return form.subscribe(listener) },
      getSnapshot: function () { return form.getSnapshot() },
    }
  }, [form])
  var snap = React.useSyncExternalStore(
    api ? api.subscribe : function () { return function () {} },
    api ? api.getSnapshot : function () { return null },
  )
  return (snap && snap.value) || {}
}
function PlanUsageSettingsPage(props) {
  // form 是 ConfigFormController 实例，其 getSnapshot/subscribe/set 都依赖 this；
  // 直接传方法引用会丢 this 并抛错（页面显示空白），因此先包一层。
  var form = props.form
  var api = React.useMemo(function () {
    return {
      subscribe: function (listener) { return form.subscribe(listener) },
      getSnapshot: function () { return form.getSnapshot() },
      set: function (field, value) { return form.set(field, value) },
      // [0.9.0] 自定义 Key 必须**按路径**写入（见 save() 的说明）：整体 set 一个
      // `customKeys` 对象会把客户端从未收到过的其它条目密钥一并抹掉。
      // 旧宿主没有 mutate 时退回 set（此时只会影响该条自身，且 set 仍会覆盖整个 dict
      // ——因此我们在缺失 mutate 时**拒绝**保存 Key，并给出明确提示）。
      mutate: typeof form.mutate === 'function'
        ? function (ops, expectedRevision) { return form.mutate(ops, expectedRevision) }
        : null,
    }
  }, [form])
  var snap = React.useSyncExternalStore(api.subscribe, api.getSnapshot)
  var value = (snap && snap.value) || {}
  var writable = snap ? snap.writable === true : false

  // 草稿：非 null 表示存在未保存的修改；按钮提交或放弃后才回到 null。
  var draftHook = React.useState(null)
  var draft = draftHook[0]
  var setDraft = draftHook[1]
  var savingHook = React.useState(false)
  var saving = savingHook[0]
  var setSaving = savingHook[1]
  /**
   * [R4-03] 草稿的**最新值**旁路：`useState` 的闭包值在连续操作间会滞后，
   * 而排序需要"基于上一次结果继续改"，必须读最新。
   */
  var draftRef = React.useRef(null)
  function commitDraft(next) {
    draftRef.current = next
    setDraft(next)
  }  var current = draft !== null ? draft : value
  var dirty = draft !== null && writable

  // [0.9.0] 自定义余额区：条目的公开元数据走整页草稿（`customBalances` 数组），
  // 但 **Key 走独立的 secret dict**，因此需要自己的草稿状态：
  //   customKeyDrafts[id] = 新 Key 文本（空串 = 不修改）
  //   customKeyClears[id] = true（显式清除已保存的 Key）
  // 这两份草稿同样受「放弃更改」与「保存中」约束，且**永不回填**旧 Key。
  var keyDraftHook = React.useState({})
  var customKeyDrafts = keyDraftHook[0]
  var setCustomKeyDrafts = keyDraftHook[1]
  var keyClearHook = React.useState({})
  var customKeyClears = keyClearHook[0]
  var setCustomKeyClears = keyClearHook[1]
  // Host 侧的「Key/引用是否存在」摘要（只回布尔，绝不回 Key），以及可选模型渠道列表。
  var statusHook = React.useState({ keys: {}, refs: {}, providers: [] })
  var customStatus = statusHook[0]
  var setCustomStatus = statusHook[1]
  var customErrorsHook = React.useState({})
  var customErrors = customErrorsHook[0]
  var setCustomErrors = customErrorsHook[1]
  /**
   * [2026-10-23] 额度窗口信息（只读 metadata，来自 `/api/plan-usage/quota-windows`）。
   *
   * 用途：只给「这个渠道本次实际有的窗口」渲染阈值输入，绝不硬造 5h/周/月。
   * 边界：该路由不解析凭据、不请求任何供应商，只读 Host 已有的观察快照。
   * 刷新时机：打开页面 / 配置代次变化（保存成功或别的窗口保存） / 用户点「刷新窗口信息」。
   */
  var windowsHook = React.useState({ loaded: false, loading: false, error: false, channels: {} })
  var windowsState = windowsHook[0]
  var setWindowsState = windowsHook[1]
  /** 单调序号：卸载、重建、并发刷新时让**迟到旧响应**作废（不覆盖新结果）。 */
  var windowsSeqRef = React.useRef(0)
  /**
   * 读取窗口能力（只读 metadata）。
   *
   * `options.clear === true`：先把旧能力清掉再取（身份/开关变化后不能继续显示旧账号的窗口）。
   */
  function refreshWindowsInfo(options) {
    var clear = options !== null && options !== undefined && options.clear === true
    var seq = windowsSeqRef.current + 1
    windowsSeqRef.current = seq
    setWindowsState(function (prev) {
      return clear
        ? { loaded: false, loading: true, error: false, channels: {} }
        : Object.assign({}, prev, { loading: true })
    })
    return fetch('/api/plan-usage/quota-windows', { headers: { accept: 'application/json' } })
      .then(function (r) {
        // HTTP 状态：mock/旧宿主可能不提供 status，只在其明确给出时校验。
        var status = r !== null && r !== undefined && typeof r.status === 'number' ? r.status : null
        if (status !== null && status !== 200) throw new Error('http-status')
        return r.json()
      })
      .then(function (body) {
        if (seq !== windowsSeqRef.current) return
        /**
         * [F03] 服务端失败信封不是成功：必须校验 `body.ok === true` 且 `data.channels`
         * 是普通对象；否则按"未能读取"处理并**清空**旧能力 —— 不能继续把旧窗口说成
         * "来自采集观察"。也不透传任何异常或上游文本。
         */
        var ok = body !== null && body !== undefined && body.ok === true
        var data = ok && body.data !== null && body.data !== undefined
          && typeof body.data === 'object' && !Array.isArray(body.data)
          ? body.data
          : null
        var channels = data !== null && data.channels !== null && data.channels !== undefined
          && typeof data.channels === 'object' && !Array.isArray(data.channels)
          ? data.channels
          : null
        if (!ok || channels === null) {
          setWindowsState({ loaded: true, loading: false, error: true, channels: {} })
          return
        }
        setWindowsState({ loaded: true, loading: false, error: false, channels: channels })
      })
      .catch(function () {
        if (seq !== windowsSeqRef.current) return
        setWindowsState({ loaded: true, loading: false, error: true, channels: {} })
      })
  }
  var policyEpochHook = React.useState(0)
  var policyEpoch = policyEpochHook[0]
  var setPolicyEpoch = policyEpochHook[1]
  React.useEffect(function () {
    return subscribeConfigEpoch(function () {
      setPolicyEpoch(function (n) { return n + 1 })
    })
  }, [])
  /**
   * P10：**已保存配置**变化（其它窗口保存、外部改 profile、开关切换）时也要刷新/作废 metadata。
   *
   * 依赖用「公开字段签名」而不是对象引用：签名是字符串，稳定且不会造成 effect 无限重跑；
   * 一旦签名变化（渠道开关、自定义条目、Key 修订号等）就先清掉旧能力再取新的，
   * 迟到的旧响应由序号丢弃。
   */
  var policySignature = policyConfigSignature(value)
  React.useEffect(function () {
    refreshWindowsInfo({ clear: true })
    // 卸载/重建时推进序号：迟到的旧 metadata 不得回写已消失的组件。
    return function () { windowsSeqRef.current += 1 }
  }, [policyEpoch, policySignature])

  /**
   * [0.9.1] 自定义卡片的折叠状态：`{ [id]: true }`。
   *
   * 放在组件级 ref 而不是普通 state，是为了「重新渲染/刷新状态后折叠状态不丢」——
   * 折叠只影响展示，不需要触发额外重渲染；用 state 会造成不必要的整页重排。
   */
  /**
   * [2026-10-21 用户需求] WorkBuddy 账号选择：设置页列出网关账号，勾选要合计的账号。
   *
   * 只读列表来自 Host 的 `/api/plan-usage/workbuddy-accounts`（不含凭据）；
   * 选择结果存进字符串字段 `workbuddyAccounts`（JSON 数组，空 = 全部）。
   */
  var wbAccountsHook = React.useState({ accounts: [], message: '', loaded: false })
  var wbAccounts = wbAccountsHook[0]
  var setWbAccounts = wbAccountsHook[1]
  React.useEffect(function () {
    var alive = true
    fetch('/api/plan-usage/workbuddy-accounts', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .then(function (body) {
        if (!alive) return
        var data = body !== null && body !== undefined && body.data !== undefined ? body.data : {}
        setWbAccounts({
          accounts: Array.isArray(data.accounts) ? data.accounts : [],
          message: typeof data.message === 'string' ? data.message : '',
          loaded: true,
        })
      })
      .catch(function () {
        if (alive) setWbAccounts({ accounts: [], message: '读取账号列表失败', loaded: true })
      })
    return function () { alive = false }
  }, [])
  var collapsedHook = React.useState({})
  var customCollapsed = collapsedHook[0]
  var setCustomCollapsed = collapsedHook[1]
  function toggleCustomCollapsed(entryId) {
    if (typeof entryId !== 'string' || entryId.length === 0) return
    var next = {}
    for (var k in customCollapsed) {
      if (Object.prototype.hasOwnProperty.call(customCollapsed, k)) next[k] = customCollapsed[k]
    }
    if (next[entryId] === true) delete next[entryId]
    else next[entryId] = true
    setCustomCollapsed(next)
  }

  // 读取密钥存在性摘要：加载时一次 + 保存成功后一次（不轮询，避免无谓请求）。
  function refreshCustomStatus() {
    return fetch('/api/plan-usage/custom-status')
      .then(function (r) { return r.json() })
      .then(function (result) {
        if (result && result.ok && result.data) {
          setCustomStatus({
            keys: result.data.keys && typeof result.data.keys === 'object' ? result.data.keys : {},
            refs: result.data.refs && typeof result.data.refs === 'object' ? result.data.refs : {},
            // [0.9.1] 可选模型渠道：设置页的自定义区用它渲染「余额来源」下拉。
            providers: Array.isArray(result.data.providers) ? result.data.providers : [],
          })
        }
      })
      .catch(function () { /* 状态是增强信息，取不到时按「未知」显示 */ })
  }
  React.useEffect(function () { refreshCustomStatus() }, [])

  /** 复制一个对象并覆盖单个字段（ES5 风格，避免计算属性名）。 */
  function withField(base, field, val) {
    var next = {}
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k]
    }
    next[field] = val
    return next
  }

  function change(field, val) { commitDraft(withField(current, field, val)) }

  // -------------------------------------------------------------------------
  // [2026-10-23] 额度策略：关注名单 + 按渠道/窗口阈值（全部走同一份草稿）
  // -------------------------------------------------------------------------
  //
  // 安全边界（父裁决 R6）：这里**只**写 `quotaChannelThresholds` / `quotaFocusChannels`，
  // 以及用户显式点击的**单个**总开关（成对写 `quotaPolicyEnabled` + `quotaTrustRouteOrder`）。
  // 勾「关注」绝不顺手打开总开关，也绝不触碰任何凭据字段。

  /** 草稿的最新基底（连续操作必须基于上一次结果，不能基于渲染期闭包）。 */
  function policyBase() {
    return draftRef.current !== null && draftRef.current !== undefined ? draftRef.current : current
  }

  /** 一次性写多个字段（避免连续 change 互相覆盖）。 */
  function policyCommit(patch) {
    var base = policyBase()
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) base = withField(base, k, patch[k])
    }
    commitDraft(base)
  }

  function policyFocusInfo() { return policyParseFocus(current.quotaFocusChannels) }
  function policyThresholdsInfo() { return policyParseThresholds(current.quotaChannelThresholds) }

  function policyChannelError(id) {
    return typeof customErrors['__policy_' + id] === 'string' ? customErrors['__policy_' + id] : ''
  }
  function policySetChannelError(id, message) {
    var next = {}
    for (var k in customErrors) {
      if (Object.prototype.hasOwnProperty.call(customErrors, k)) next[k] = customErrors[k]
    }
    if (typeof message === 'string' && message.length > 0) next['__policy_' + id] = message
    else delete next['__policy_' + id]
    setCustomErrors(next)
  }

  /**
   * 渠道块被隐藏（总开关关闭/旧半启用）时，把逐渠道的策略错误汇总给全局展示。
   * 隐藏**不等于**丢弃：错误仍要可见，用户才能选择"打开总开关修正"或"放弃更改"。
   */
  function policyHiddenChannelErrors () {
    if (policyFullyEnabled(current) === true) return []
    var out = []
    for (var k in customErrors) {
      if (!Object.prototype.hasOwnProperty.call(customErrors, k)) continue
      if (k.indexOf('__policy_') !== 0) continue
      out.push({ id: k.slice('__policy_'.length), message: String(customErrors[k]) })
    }
    return out
  }

  function policyScrollError(message) {
    var next = {}
    for (var k in customErrors) {
      if (Object.prototype.hasOwnProperty.call(customErrors, k)) next[k] = customErrors[k]
    }
    next.__policy = message
    setCustomErrors(next)
  }

  /**
   * 首次为某渠道建立条目时，把**界面此前显示的旧有效值**原样搬进自己的条目。
   *
   * 父裁决 P01/P02/P03/P06：
   *   - 不论是 toggle「关注」还是**首次直接改输入**，都必须先 seed —— 否则
   *     旧时不改的那一档/那一个窗口会被写丢（legacy 400/100 改成 500 → closing 100 消失）；
   *   - seed 只能用**旧时真正有效**的规则：旧金额币种为空 = 旧规则本来无效，
   *     绝不用当前采样币种把它"补"成有效规则（那会凭空产生一条旧规则）；
   *   - 订阅型只搬「旧语义真正判定的那一个窗口」，其它窗口保持 0（不扩散）。
   *
   * @returns {object|null} `{windows}|{balance}|{credits}`；null = 没有可安全搬的旧有效规则
   */
  function policySeedEntry(kind, channelId) {
    var samples = policySamplesOf(windowsState, channelId)
    var eff = policyLegacyEffective(current, kind, samples)
    if (eff === null) return null
    if (kind === 'window') {
      var windows = {}
      windows[eff.windowKey] = { warning: eff.warning, closing: eff.closing }
      return { windows: windows }
    }
    if (kind === 'balance') {
      return { balance: { warning: eff.warning, closing: eff.closing, currency: eff.currency } }
    }
    return { credits: { warning: eff.warning, closing: eff.closing } }
  }

  /** 把 seed 结果合并进条目：只补**缺失**的字段，绝不覆盖用户已有的值。 */
  function policyApplySeed(entry, seeded) {
    if (seeded === null || seeded === undefined) return
    if (seeded.windows !== undefined) {
      var existing = entry.windows !== null && typeof entry.windows === 'object' && !Array.isArray(entry.windows)
        ? entry.windows
        : null
      if (existing === null) entry.windows = seeded.windows
      else {
        for (var key in seeded.windows) {
          if (!Object.prototype.hasOwnProperty.call(seeded.windows, key)) continue
          if (Object.prototype.hasOwnProperty.call(existing, key)) continue
          existing[key] = seeded.windows[key]
        }
      }
    }
    if (seeded.balance !== undefined && !Object.prototype.hasOwnProperty.call(entry, 'balance')) {
      entry.balance = seeded.balance
    }
    if (seeded.credits !== undefined && !Object.prototype.hasOwnProperty.call(entry, 'credits')) {
      entry.credits = seeded.credits
    }
  }

  /** 把策略块需要的入参打包（内置卡片与自定义卡片共用）。 */
  function policyBlockProps(channelId, name, kind, channelEnabled) {
    var tInfo = policyThresholdsInfo()
    var fInfo = policyFocusInfo()
    var entry = tInfo.state === 'ok' && Object.prototype.hasOwnProperty.call(tInfo.channels, channelId)
      ? tInfo.channels[channelId]
      : null
    return {
      channelId: channelId,
      channelName: name,
      kind: kind,
      current: current,
      writable: writable,
      saving: saving,
      samples: policySamplesOf(windowsState, channelId),
      entry: entry,
      focused: fInfo.list.indexOf(channelId) !== -1,
      focusState: fInfo.state,
      thresholdsState: tInfo.state,
      monitorOn: current.enabled !== false,
      channelEnabled: channelEnabled !== false,
      error: policyChannelError(channelId),
      onToggleFocus: policyToggleFocus,
      onWritePair: policyWritePair,
      onInputRejected: policySetChannelError,
    }
  }

  /**
   * 顶部**唯一**总开关：一次显式操作成对设置两个授权字段（同一份最新草稿）。
   *
   * [2026-10-23 单总开关] 用户确认取消独立的「路由信任」控件：
   *   - 打开 → `quotaPolicyEnabled=true` **且** `quotaTrustRouteOrder=true`；
   *   - 关闭 → 两者同时 `false`；
   *   - 一律基于 `policyBase()`（最新 draftRef），避免同批其它改动被覆盖（P05/E04 同类），
   *     且**不得**夹带 focus / 阈值 / Key / 绑定 / 渠道监控的修改。
   *
   * ⚠️ 这只是"用户启用动作"的成对写入：Host 侧旧闸门 `quotaTrustRouteOrder` 仍按原样判断，
   * **没有**把 chainReady 硬编码为 true，也没有新增任何"自动链路验真"。
   */
  function policyTogglePolicy (on) {
    if (on === true) policyCommit({ quotaPolicyEnabled: true, quotaTrustRouteOrder: true })
    else policyCommit({ quotaPolicyEnabled: false, quotaTrustRouteOrder: false })
  }

  function policyToggleFocus(channelId, on) {
    // P05：一律基于**最新草稿**，否则同一批里先后改两个渠道会互相覆盖。
    var base = policyBase()
    var info = policyParseFocus(base.quotaFocusChannels)
    if (info.state === 'invalid') {
      policyScrollError('关注渠道列表无法解析（当前配置不是合法数组）。为避免破坏原数据，本次勾选未写入；'
        + '可先点「清空关注名单」显式重置，再重新勾选。')
      return
    }
    var list = info.list.slice()
    var at = list.indexOf(channelId)
    var patch = {}
    if (on === true) {
      if (at !== -1) return
      if (list.length >= POLICY_MAX_FOCUS) {
        policyScrollError('关注渠道最多 ' + POLICY_MAX_FOCUS + ' 个（当前已满）。请先取消一个再勾选；本次未修改。')
        return
      }
      list.push(channelId)
      /**
       * 已有条目的渠道不动；没有条目的渠道按「旧时真正生效的值」建条目。
       *
       * `absent`（字段还没出现过）也算"没有条目"：此时该渠道正走旧全局阈值，
       * 一旦建条目就不再回退，所以必须先把旧有效值抄进来。`invalid` 则**不写**。
       */
      var tInfo = policyParseThresholds(base.quotaChannelThresholds)
      if (tInfo.state !== 'invalid') {
        var hasEntry = tInfo.state === 'ok' && Object.prototype.hasOwnProperty.call(tInfo.channels, channelId)
        if (!hasEntry) {
          var seeded = policySeedEntry(policyKindOfById(channelId), channelId)
          if (seeded !== null) {
            var mutated = policyMutateThresholds(base.quotaChannelThresholds, channelId, function (entry) {
              policyApplySeed(entry, seeded)
            })
            if (!mutated.ok) {
              policyScrollError(mutated.reason)
              return
            }
            patch.quotaChannelThresholds = mutated.json
          }
        }
      }
    } else {
      if (at === -1) return
      list.splice(at, 1)
      // [刻意] 取消关注**不删除**该渠道已保存的阈值（删条目会把它退回 legacy 语义）。
    }
    patch.quotaFocusChannels = policyFocusJson(list)
    policySetChannelError(channelId, '')
    policyCommit(patch)
  }

  function policyRemoveFocus(channelId) {
    var base = policyBase()
    var info = policyParseFocus(base.quotaFocusChannels)
    if (info.state !== 'ok') return
    var list = info.list.slice()
    var at = list.indexOf(channelId)
    if (at === -1) return
    list.splice(at, 1)
    policyCommit({ quotaFocusChannels: policyFocusJson(list) })
  }

  function policyResetFocus() {
    // 显式动作：只写进草稿（保存后才落盘），绝不隐式删除原数据。
    policyCommit({ quotaFocusChannels: policyFocusJson([]) })
  }

  function policyWritePair(channelId, kind, windowKey, field, value) {
    // P04：非法文本/NaN 在**写入层**就拒绝，绝不静默变成 0；越界数值原样写入，由保存校验报错。
    if (typeof value !== 'number' || !isFinite(value)) {
      policySetChannelError(channelId, '阈值必须是数字（留空 = 未配置）。本次未写入。')
      return
    }
    // P05：基于最新草稿，保证同一批内多个渠道/窗口的修改互不覆盖。
    var base = policyBase()
    var tInfo = policyParseThresholds(base.quotaChannelThresholds)
    if (tInfo.state === 'invalid') {
      policyScrollError('阈值配置无法解析，为避免覆盖原数据，本次未写入。请先修正或重置该字段。')
      return
    }
    var hasEntry = tInfo.state === 'ok' && Object.prototype.hasOwnProperty.call(tInfo.channels, channelId)
    // P02/P03：首次直接改输入也要先 seed 该渠道旧时**有效**的档/窗口。
    var seeded = hasEntry ? null : policySeedEntry(kind, channelId)
    var samples = policySamplesOf(windowsState, channelId)
    var mutated = policyMutateThresholds(base.quotaChannelThresholds, channelId, function (entry) {
      policyApplySeed(entry, seeded)
      if (kind === 'window') {
        if (typeof windowKey !== 'string' || POLICY_WINDOW_KEYS.indexOf(windowKey) === -1) return
        if (entry.windows === null || typeof entry.windows !== 'object' || Array.isArray(entry.windows)) entry.windows = {}
        var pair = entry.windows[windowKey]
        var box = pair !== null && typeof pair === 'object' && !Array.isArray(pair) ? pair : {}
        var nextPair = {}
        for (var pk in box) {
          if (Object.prototype.hasOwnProperty.call(box, pk)) nextPair[pk] = box[pk]
        }
        nextPair[field] = value
        nextPair.warning = policyNum(nextPair.warning)
        nextPair.closing = policyNum(nextPair.closing)
        if (nextPair.warning === 0 && nextPair.closing === 0) delete entry.windows[windowKey]
        else entry.windows[windowKey] = nextPair
        if (Object.keys(entry.windows).length === 0) delete entry.windows
        return
      }
      if (kind === 'credits') {
        var cur = entry.credits !== null && typeof entry.credits === 'object' && !Array.isArray(entry.credits)
          ? entry.credits
          : {}
        var nextCredits = {}
        for (var ck in cur) {
          if (Object.prototype.hasOwnProperty.call(cur, ck)) nextCredits[ck] = cur[ck]
        }
        nextCredits[field] = value
        nextCredits.warning = policyNum(nextCredits.warning)
        nextCredits.closing = policyNum(nextCredits.closing)
        if (nextCredits.warning === 0 && nextCredits.closing === 0) delete entry.credits
        else entry.credits = nextCredits
        return
      }
      // 金额：币种只认已保存条目或可信采样，绝不默认 CNY。
      var curBal = entry.balance !== null && typeof entry.balance === 'object' && !Array.isArray(entry.balance)
        ? entry.balance
        : {}
      var code = policyCurrencyOf(curBal)
      if (code.length === 0) code = samples.currency
      if (code.length === 0) return // 币种未知：输入框本应禁用，保守不写
      var nextBal = {}
      for (var bk in curBal) {
        if (Object.prototype.hasOwnProperty.call(curBal, bk)) nextBal[bk] = curBal[bk]
      }
      nextBal[field] = value
      nextBal.currency = code
      nextBal.warning = policyNum(nextBal.warning)
      nextBal.closing = policyNum(nextBal.closing)
      if (nextBal.warning === 0 && nextBal.closing === 0) delete entry.balance
      else entry.balance = nextBal
    })
    if (!mutated.ok) {
      policySetChannelError(channelId, mutated.reason)
      return
    }
    policySetChannelError(channelId, '')
    policyCommit({ quotaChannelThresholds: mutated.json })
  }

  function discard() {
    draftRef.current = null
    setDraft(null)
    // [0.9.0] 自定义区一起还原：Key 草稿与「待清除」标记都丢弃。
    setCustomKeyDrafts({})
    setCustomKeyClears({})
    setCustomErrors({})
  }

  // [0.9.0] 自定义条目的草稿操作。数组改动走通用 change('customBalances', …)，
  // 因此与内置渠道共用同一份草稿、同一次保存、同一次放弃。
  function customEntries() {
    return parseCustomBalances(current.customBalances)
  }
  function setCustomEntries(next) {
    change('customBalances', next)
  }
  /**
   * [顺序修复 2026-10-20] 把自定义条目的新顺序写进 `planOrder`。
   *
   * 之前自定义卡片的上移/下移只改 `customBalances` 数组，而胶囊与详情面板
   * 只按 `planOrder` 排序 —— 于是用户点箭头时"看起来没反应"。
   *
   * 这里把自定义 id 的**相对顺序**按新草稿重排后写回 `planOrder`：
   *   - 内置渠道的相对位置不变；
   *   - 自定义条目在 `planOrder` 里的位置整体按新顺序替换。
   */
  /**
   * [顺序修复 2026-10-20 第三次] 写入**全局**顺序（内置 + 自定义混排）。
   *
   * 审核指出的两个缺陷都在这里修掉：
   *   - FAIL_CUSTOM_REORDER_RESETS_BUILTIN_ORDER：旧实现重新遍历 `PLANS`
   *     生成注册表默认顺序，把用户已保存的内置顺序**重置**了。
   *     现在直接采用调用方给的完整顺序（`nextOrder` 已是全局顺序）。
   *   - 分组 concat：旧实现写成 `builtIn.concat(nextOrder)`，自定义永远排最后。
   *     现在不再分组。
   *
   * ⚠️ 必须**一次**写两个字段：`change()` 基于 `current` 重建草稿，
   * 连续调用两次会互相覆盖（后一次抹掉前一次）。
   */
  function reorderCustomEntries(nextFullOrder, nextEntries) {
    if (!Array.isArray(nextFullOrder) || nextFullOrder.length === 0) return
    /**
     * [R4-03] 必须基于**最新草稿**构造，不能用渲染期闭包里的 `current`。
     *
     * 设置页现在每张卡片是独立渲染实例，连续点两次箭头时第二次的
     * `current` 可能还是上一帧快照 —— 用它做 withField 会把第一次的排序
     * 结果覆盖掉（表现为"顺序反而乱了"）。`draftRef` 每次写入都同步更新。
     */
    var base = draftRef.current !== null && draftRef.current !== undefined ? draftRef.current : current
    var nextDraft = withField(base, 'planOrder', JSON.stringify(nextFullOrder))
    if (Array.isArray(nextEntries)) nextDraft = withField(nextDraft, 'customBalances', nextEntries)
    commitDraft(nextDraft)
  }
  function addCustomEntry(id) {
    if (customEntries().length >= 12) return
    /**
     * [第五轮 UI 要求] 新增条目是「默认折叠」的唯一例外：主动展开**这一条**
     * 便于立即填写，但不顺带展开其它已有条目（要求 5）。
     * 展开 ≠ 启用，不改凭据/余额配置，也不触发额外取数。
     */
    var expand = {}
    for (var ek in customCollapsed) {
      if (Object.prototype.hasOwnProperty.call(customCollapsed, ek)) expand[ek] = customCollapsed[ek]
    }
    expand[id] = true
    setCustomCollapsed(expand)
    var next = customEntries().concat([{
      // [0.9.1] 新条目从「选择模型渠道」开始：provider 为空表示还没选。
      // 不再有 url / credentialRef / credentialHost —— 地址与凭据都由 provider 派生。
      id: id, provider: '', balanceEndpoint: '', name: '', balancePath: '', subtractPath: '', currency: '',
      enabled: true,
    }])
    setCustomEntries(next)
  }
  function deleteCustomEntry(id) {
    var next = []
    var all = customEntries()
    for (var i = 0; i < all.length; i++) if (all[i].id !== id) next.push(all[i])
    setCustomEntries(next)
    // 删除条目时把它自己的 Key 与草稿一并标记清除（Host 保存时 unset 该 id）。
    // 这只影响本插件拥有的该条秘密，不触碰任何共享模型凭据。
    var clears = {}
    for (var k in customKeyClears) if (Object.prototype.hasOwnProperty.call(customKeyClears, k)) clears[k] = customKeyClears[k]
    clears[id] = true
    setCustomKeyClears(clears)
    var drafts = {}
    for (var d in customKeyDrafts) if (Object.prototype.hasOwnProperty.call(customKeyDrafts, d)) drafts[d] = customKeyDrafts[d]
    delete drafts[id]
    setCustomKeyDrafts(drafts)
  }
  function setCustomKey(id, text) {
    var drafts = {}
    for (var k in customKeyDrafts) if (Object.prototype.hasOwnProperty.call(customKeyDrafts, k)) drafts[k] = customKeyDrafts[k]
    drafts[id] = text
    setCustomKeyDrafts(drafts)
    if (customKeyClears[id] === true && text.length > 0) {
      var clears = {}
      for (var c in customKeyClears) if (Object.prototype.hasOwnProperty.call(customKeyClears, c)) clears[c] = customKeyClears[c]
      delete clears[id]
      setCustomKeyClears(clears)
    }
  }
  function clearCustomKey(id) {
    var clears = {}
    for (var k in customKeyClears) if (Object.prototype.hasOwnProperty.call(customKeyClears, k)) clears[k] = customKeyClears[k]
    clears[id] = true
    setCustomKeyClears(clears)
    var drafts = {}
    for (var d in customKeyDrafts) if (Object.prototype.hasOwnProperty.call(customKeyDrafts, d)) drafts[d] = customKeyDrafts[d]
    drafts[id] = ''
    setCustomKeyDrafts(drafts)
  }
  function undoClearCustomKey(id) {
    var clears = {}
    for (var k in customKeyClears) if (Object.prototype.hasOwnProperty.call(customKeyClears, k)) clears[k] = customKeyClears[k]
    delete clears[id]
    setCustomKeyClears(clears)
  }

  /** 自定义区自身是否还有未保存的改动（Key 草稿/清除标记）。 */
  function customKeyDirty() {
    if (customKeyClears && Object.keys(customKeyClears).length > 0) return true
    if (!customKeyDrafts) return false
    for (var k in customKeyDrafts) {
      if (Object.prototype.hasOwnProperty.call(customKeyDrafts, k) && customKeyDrafts[k].length > 0) return true
    }
    return false
  }
  var anyDirty = dirty || customKeyDirty()

  // [local patch 0.8.1] 渠道顺序维护：基于当前（草稿优先）planOrder 计算新数组。
  // 未列渠道按注册表默认顺序补在队尾；上/下移一格后全量落盘。
  // [0.9.0] 只保留**当前活动**的渠道 id：旧 planOrder 里的退场 id
  //（kimi-code / glm-zhipu / glm-zai）与任何未知 id 都不进入这个数组，
  // 否则它们会占住一个上移/下移槽位（用户点一下箭头看起来「没动」）。
  function orderedIds() {
    var raw = parsePlanOrder(current.planOrder) || []
    /**
     * [顺序修复 2026-10-20 第三次] 已知 id 必须涵盖**当前有效**的全部渠道。
     *
     * 审核复现 FAIL_INITIAL_BUILTIN_MOVE_DROPS_CUSTOM_ORDER：刚打开设置时
     * `draft === null`，旧实现只从 `draft.customBalances` 收集自定义 id，
     * 于是已保存的自定义 id 被当成「未知 id」过滤掉 —— 移动一个内置项并保存后，
     * `planOrder` 里那些自定义 id 就**永久消失**了。
     *
     * 现在优先用草稿，草稿为空时退回**已保存配置**（`current.customBalances`）。
     */
    var customList = null
    if (draft !== null && draft !== undefined && Array.isArray(draft.customBalances)) customList = draft.customBalances
    else if (current !== null && current !== undefined && Array.isArray(current.customBalances)) customList = current.customBalances
    if (customList === null) customList = []
    var known = {}
    for (var i = 0; i < PLANS.length; i++) known[PLANS[i].id] = true
    var customIds = []
    for (var c = 0; c < customList.length; c++) {
      var cid = customList[c] !== null && typeof customList[c] === 'object' ? customList[c].id : null
      if (typeof cid === 'string' && cid.length > 0 && customIds.indexOf(cid) === -1) {
        known[cid] = true
        customIds.push(cid)
      }
    }
    var order = []
    for (var r = 0; r < raw.length; r++) {
      if (known[raw[r]] === true && order.indexOf(raw[r]) === -1) order.push(raw[r])
    }
    /**
     * [全局混排] 未被 `planOrder` 列出的渠道按「内置注册表顺序 + 自定义顺序」补在队尾。
     *
     * 这里只是**首次**给出一个合法顺序；一旦用户移动过，全部 id 都会进 `planOrder`，
     * 之后不再受这段补齐逻辑影响（也就不会把自定义强行推到内置之后）。
     */
    for (var j = 0; j < PLANS.length; j++) {
      if (order.indexOf(PLANS[j].id) === -1) order.push(PLANS[j].id)
    }
    for (var k = 0; k < customIds.length; k++) {
      if (order.indexOf(customIds[k]) === -1) order.push(customIds[k])
    }
    return order
  }
  function movePlan(id, delta) {
    var order = orderedIds()
    var idx = order.indexOf(id)
    if (idx < 0) return
    var to = idx + delta
    if (to < 0 || to >= order.length) return
    order.splice(idx, 1)
    order.splice(to, 0, id)
    change("planOrder", JSON.stringify(order))
  }
  // 设置页卡片按「当前顺序」（草稿优先）排列，与胶囊/详情面板一致。
  function orderedPlanMetas() {
    var order = orderedIds()
    var byId = {}
    for (var i = 0; i < PLANS.length; i++) byId[PLANS[i].id] = PLANS[i]
    var list = []
    for (var j = 0; j < order.length; j++) {
      if (byId[order[j]] !== undefined) list.push(byId[order[j]])
    }
    return list
  }

  /**
   * 提交整页草稿。
   *
   * [R6] 审查发现 0.9.0 的顺序错了：`jobs.push(api.set(...))` 是**立即发起**的写入，
   * 而「没有 mutate 就取消保存」的检查在它之后——于是提示「已取消保存」时，
   * 元数据其实已经落盘。这里改成严格三段式：
   *
   *   ① **先校验**：所有自定义字段 + 宿主写入能力（有无 mutate / set），一条不合格就
   *      整体不写，只显示错误；此时**没有任何副作用**。
   *   ② **再提交**：能拿到 mutate 时，把「公开元数据 + secret 路径变更」合并成
   *      **同一次 mutate**（ops 数组一次提交），尽量做成一次原子写；
   *      拿不到 mutate 且确实需要写 Key 时直接拒绝（绝不退回整体 set 抹掉别条 Key）。
   *   ③ **如实报告**：一次 mutate 失败 = 什么都没有写；只能退回多次 set 时，
   *      部分成功必须明说（不能宣称「已全部取消」），并保留草稿供重试。
   *
   * 自定义 Key 的两条特殊规则（保持不变）：
   *   1. **路径寻址**：Key 写 `['customKeys', id]`，删 Key 用 unset 同一个路径——
   *      绝不整体替换 `customKeys`，否则会把客户端从来没有过的其它条目 Key 抹掉；
   *   2. **掩码不是值**：只有「用户真的输入了新文本」或「用户显式点了清除」才写，
   *      输入框留空一律视为「保持不变」。
   */
  function save() {
    if (saving || !writable) return
    if (draft === null && !customKeyDirty()) return
    var base = draft !== null ? draft : value

    // ---- ① 校验阶段：不产生任何写入 ----
    var entries = parseCustomBalances(base.customBalances)
    var problems = {}
    var bad = false
    for (var e = 0; e < entries.length; e++) {
      var problem = validateCustomEntry(entries[e])
      if (problem !== null) { problems[entries[e].id] = problem; bad = true }
    }
    /**
     * [2026-10-23] 额度策略校验：同样在**任何写入之前**。
     *
     * 只校验本次**确实改动**的两个字段（`quotaChannelThresholds` / `quotaFocusChannels`）：
     * 未改动的历史配置（哪怕本身是坏 JSON）不会阻塞其它渠道的保存，也不会被自动重写。
     */
    var policyProblem = policyValidateDraft(base, value)
    if (policyProblem !== null) {
      problems.__policy = policyProblem
      bad = true
    }
    setCustomErrors(problems)
    if (bad) return

    /**
     * [0.9.1] 自定义渠道不再有自己的 Key：地址与凭据都来自所选模型渠道。
     *
     * 因此这里不再做「新 Key → 绑定 origin」的逻辑。`customKeyDrafts` /
     * `customKeyClears` 只为**清理旧版本遗留数据**而保留：如果某个旧条目之前
     * 存过 Key，删除该条目时会通过下面的 unset 把它一并清掉。
     */
    if (entries.length > 0 || base.customBalances !== undefined) {
      base = Object.assign({}, base, { customBalances: entries })
    }

    // 需要写 secret 吗？（新 Key 文本或显式清除）
    var secretOps = []
    for (var clearId in customKeyClears) {
      if (!Object.prototype.hasOwnProperty.call(customKeyClears, clearId)) continue
      if (customKeyClears[clearId] === true) {
        secretOps.push({ op: 'unset', path: ['customKeys', clearId] })
      }
    }
    for (var keyId in customKeyDrafts) {
      if (!Object.prototype.hasOwnProperty.call(customKeyDrafts, keyId)) continue
      var text = typeof customKeyDrafts[keyId] === 'string' ? customKeyDrafts[keyId].trim() : ''
      if (text.length === 0) continue
      if (customKeyClears[keyId] === true) continue // 同一轮里清除优先，避免歧义
      secretOps.push({ op: 'set', path: ['customKeys', keyId], value: text })
    }
    var needsSecretWrite = secretOps.length > 0
    var canMutate = typeof api.mutate === 'function'

    // 能力检查必须在**任何写操作之前**：旧宿主没有路径寻址写入时，
    // 宁可整页拒绝，也不能先写元数据再提示「已取消」。
    if (needsSecretWrite && !canMutate) {
      setCustomErrors({ __global: '当前宿主的设置接口不支持按路径写入密钥，为避免覆盖其它条目的 Key，本次没有保存任何改动；请升级 DSH 后重试。' })
      return
    }

    // [W1/W2] 每次写 secret 都**递增该条目的公开修订号**，并和 secret 写在同一次 mutate 里。
    // 这样「保存动作」进入配置摘要：Host 读到新配置后摘要就变了，客户端据此确认生效；
    // 写相同的 Key 也照样递增，因此幂等写入不会卡死（W2）。
    var revWrites = []
    if (needsSecretWrite) {
      var revsNow = value.customKeyRev !== null && typeof value.customKeyRev === 'object' ? value.customKeyRev : {}
      var touchedIds = {}
      for (var si = 0; si < secretOps.length; si++) {
        var sid = secretOps[si].path[1]
        if (touchedIds[sid] === true) continue
        touchedIds[sid] = true
        var prev = typeof revsNow[sid] === 'number' && isFinite(revsNow[sid]) ? revsNow[sid] : 0
        revWrites.push({ op: 'set', path: ['customKeyRev', sid], value: prev + 1 })
      }
    }

    // 公开字段（含整个 customBalances 数组）的待写项。
    var fieldOps = []
    for (var k in base) {
      if (!Object.prototype.hasOwnProperty.call(base, k)) continue
      if (k === 'customKeys') continue // secret dict 绝不整体写
      if (k === 'customKeyRev') continue // 修订号由上面按路径写
      if (base[k] !== value[k]) fieldOps.push({ field: k, value: base[k] })
    }

    if (fieldOps.length === 0 && !needsSecretWrite) {
      draftRef.current = null
      setDraft(null)
      setCustomKeyDrafts({})
      setCustomKeyClears({})
      return
    }

    // ---- ② 提交阶段 ----
    setSaving(true)
    setCustomErrors({})

    /** 提交成功后统一清理草稿并刷新密钥摘要。 */
    var settleOk = function () {
      setSaving(false)
      draftRef.current = null
      setDraft(null)
      setCustomKeyDrafts({})
      setCustomKeyClears({})
      setCustomErrors({})
      refreshCustomStatus()
      // [R3/V2] 保存成功 = 配置身份已变（可能只是 Key 变了，配置字段却没差异）。
      // 把**本次真正写过 Key 的 id** 一并报上去：这些条目的旧余额必须立刻作废，
      // 而不是等新请求返回；其它条目不受牵连。
      var touched = []
      for (var ti = 0; ti < secretOps.length; ti++) {
        var opPath = secretOps[ti].path
        if (Array.isArray(opPath) && opPath.length >= 2) touched.push(opPath[1])
      }
      bumpConfigEpoch(touched)
    }
    /** 提交失败：保留草稿，并说明「已写入/未写入」的真实情况。 */
    var settleFail = function (partial) {
      setSaving(false)
      if (partial) {
        setCustomErrors({
          __global: '保存未完全成功：部分设置可能已经写入。你的草稿仍然保留，请核对后重试或放弃。',
        })
      }
    }

    // 首选：一次 mutate 同时提交公开字段与 secret 路径（顺序：先元数据，再密钥）。
    if (canMutate) {
      var ops = []
      for (var f = 0; f < fieldOps.length; f++) {
        ops.push({ op: 'set', path: [fieldOps[f].field], value: fieldOps[f].value })
      }
      // [W1/W2] 修订号与 secret 同一批：要么都落盘，要么都不落盘，
      // 因此「Host 读到的修订号」与「Host 读到的 Key」永远配套。
      for (var rw = 0; rw < revWrites.length; rw++) ops.push(revWrites[rw])
      for (var s = 0; s < secretOps.length; s++) ops.push(secretOps[s])
      return Promise.resolve()
        .then(function () { return api.mutate(ops) })
        .then(function (accepted) {
          // 宿主契约：mutate 返回 boolean（是否被接受）。false = 明确拒绝，且没有落盘。
          if (accepted === false) {
            setSaving(false)
            setCustomErrors({ __global: '宿主拒绝了这次保存（修订号可能已变化）。没有写入任何改动，你的草稿仍在，请重试。' })
            return
          }
          settleOk()
        }, function () {
          // 抛错 = 这次 mutate 未被接受；按契约整批不生效。
          settleFail(false)
          setCustomErrors({ __global: '保存被宿主拒绝，没有写入任何改动。你的草稿仍在，请重试。' })
        })
    }

    // 退路：只能逐个字段 set（此时不会有 secret 写入，上面已拒绝）。
    // 逐个 set 不是原子的，失败时必须如实说「可能已部分写入」。
    //
    // 注意：**第一个 set 同步发起**（所有校验已通过），后续按序串起来——
    // 这样「点保存后立即开始写」的既有行为不变（有同步副作用测试依赖它）。
    var succeeded = 0
    var rejected = false
    var startNext = function (index) {
      if (index >= fieldOps.length) return Promise.resolve()
      var op = fieldOps[index]
      return Promise.resolve(api.set(op.field, op.value)).then(function (accepted) {
        if (accepted === false) { rejected = true; return Promise.reject(new Error('rejected')) }
        succeeded += 1
        return startNext(index + 1)
      })
    }
    return (fieldOps.length > 0 ? startNext(0) : Promise.resolve()).then(function () {
      settleOk()
    }, function () {
      settleFail(succeeded > 0)
      if (succeeded === 0) {
        setCustomErrors({ __global: '保存被宿主拒绝，没有写入任何改动。你的草稿仍在，请重试。' })
      }
    })
  }

  var rows = []

  rows.push(h("label", { key: "__global", style: settingsRowStyle },
    h("input", {
      type: "checkbox",
      checked: settingBool(current, "enabled", true),
      disabled: !writable || saving,
      onChange: function (e) { change("enabled", e.target.checked) },
    }),
    h("span", {}, "启用套餐用量角标"),
  ))

  /**
   * [2026-10-23] 额度策略小节放在**全局开关之后、渠道卡片之前**：
   * 两个安全闸门必须显式可见（默认关闭），并且能一眼看到"为什么没生效"。
   */
  rows.push(renderPolicyGlobalSection({
    current: current,
    writable: writable,
    saving: saving,
    focusInfo: policyFocusInfo(),
    windowsState: windowsState,
    error: typeof customErrors.__policy === 'string' ? customErrors.__policy : '',
    onTogglePolicy: policyTogglePolicy,
    onRefresh: refreshWindowsInfo,
    onResetFocus: policyResetFocus,
    onRemoveFocus: policyRemoveFocus,
    // 渠道块隐藏时把该渠道的策略错误提升到全局（不吞数据）
    hiddenErrors: policyHiddenChannelErrors(),
  }))

  // [0.8.1 定稿] 卡片按当前顺序排列；名称行与右缘的 ▲/▼ 箭头列**严格横向
  // 对位**——箭头列不在卡片上 absolute 浮动，而是挂在名称行内部（flex 两端），
  // 与「厂商名称」同一行同一中线；卡片其余内容（Key/Cookie/阈值/提示）照常
  // 在下方铺开，不受箭头列影响。
  /**
   * [R4-03] 设置页卡片按**全局顺序**逐个渲染（内置 + 自定义混排）。
   *
   * 旧实现先把所有内置卡片画完，再把整个 `CustomBalancesSection` 追加到页尾 ——
   * 于是 `planOrder` 即便写对了，用户看到的卡片位置仍然固定分组
   * （审核 FAIL：草稿/保存顺序正确但 DOM 没跨组）。
   *
   * 现在只按 `orderedIds()` 一项项渲染：
   *   - 内置 id → 走下面这个 `renderBuiltInCard(meta)`；
   *   - 自定义 id → 渲染 `CustomBalancesSection` 的**单条**模式。
   * 「添加自定义余额渠道」入口与说明仍留在页尾（审核允许）。
   */
  function renderBuiltInCard(meta) {
  var fields = meta.fields || {}
  var enabledKey = fields.enabled
  if (enabledKey === undefined) return null
  var enabled = settingBool(current, enabledKey, true)
  var arrowBtnStyle = Object.assign({}, settingsButtonStyle, {
    padding: 0, fontSize: 9, lineHeight: '12px', height: 14, width: 22, margin: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  })
  // 箭头列垂直中点 = 名称行中线：gap:0（两按钮紧贴，中缝即组的中线），
  // 列本身作为名称行 flex 的子项由 alignItems:center 以**自身几何中心**对齐。
  // ▲14px + ▼14px = 28px 高的列，中心点恰好在两按钮的贴合缝上。
  /**
   * [R4-03 §4.2] 该内置渠道在**全局顺序**里的位置，用于首尾按钮禁用。
   */
  var builtInOrder = orderedIds()
  var builtInPos = builtInOrder.indexOf(meta.id)
  var builtInCanUp = builtInPos > 0
  var builtInCanDown = builtInPos >= 0 && builtInPos < builtInOrder.length - 1
  var arrows = h("div", {
    key: "arrows",
    style: { display: 'flex', flexDirection: 'column', gap: 0, flex: 'none', marginLeft: 'auto' },
  },
    h("button", {
      type: "button",
      'aria-label': meta.name + ' 上移',
      title: '上移',
      style: Object.assign({}, arrowBtnStyle, (!writable || saving || !builtInCanUp) ? settingsButtonDisabledStyle : {}),
      disabled: !writable || saving || !builtInCanUp,
      onClick: (function (id) { return function () { movePlan(id, -1) } })(meta.id),
    }, '▲'),
    h("button", {
      type: "button",
      'aria-label': meta.name + ' 下移',
      title: '下移',
      style: Object.assign({}, arrowBtnStyle, (!writable || saving || !builtInCanDown) ? settingsButtonDisabledStyle : {}),
      disabled: !writable || saving || !builtInCanDown,
      onClick: (function (id) { return function () { movePlan(id, +1) } })(meta.id),
    }, '▼'),
  )
  var children = [
    // 名称行 = flex 容器：左「勾选 + 厂商名称」，右箭头列。alignItems:center
    // 让箭头列以**自身垂直中点**对齐名称行中线——gap:0 时中点即 ▲/▼ 贴合缝，
    // 视觉上就是「两枚按钮的中横线与渠道名称同一水平位」。
    h("div", { key: "row", style: Object.assign({}, settingsRowStyle, { alignItems: 'center' }) },
      h("label", { style: Object.assign({}, settingsRowStyle, { flex: '1 1 auto', minWidth: 0 }) },
        h("input", {
          type: "checkbox",
          checked: enabled,
          disabled: !writable || saving,
          onChange: (function (key) { return function (e) { change(key, e.target.checked) } })(enabledKey),
        }),
        h("span", {}, meta.name),
        // [2026-10-24] 中性类型小标签（订阅 / 金额 / 积分），仅文字+弱色，不用彩色圆标。
        h("span", { style: planTypeChipStyle, 'data-plan-kind': policyKindOf(meta) }, planKindLabelOf(meta)),
      ),
      arrows,
    ),
  ]
  /**
   * [2026-10-24 布局重做] 内置渠道的**连接/凭据 + 对应长教程**统一放进原生 `<details>`：
   *   - 内容始终挂载（同一个受控 input、同一 onChange / disabled），折叠只影响观感；
   *   - 默认收起，卡片首屏只留名称与监控开关；
   *   - 关键错误仍由外层（页首/卡片外）可见，不因折叠被藏起来。
   * 自定义余额卡已有自己的整卡折叠体系，保持原样不动。
   */
  var credentialChildren = []
  if (fields.apiKey !== undefined) {
    credentialChildren.push(h("input", {
      key: "key",
      type: "password",
      autoComplete: "off",
      style: settingsInputStyle,
      placeholder: meta.name + " API Key（留空则回退到「设置 → 模型」中的凭据）",
      value: settingText(current, fields.apiKey),
      disabled: !writable || saving,
      'data-plan-credential': meta.id,
      onChange: (function (key) { return function (e) { change(key, e.target.value) } })(fields.apiKey),
    }))
  }
  if (fields.cookie !== undefined && fields.apiKey === undefined && meta.id === 'mimo') {
    credentialChildren.push(h("input", {
      key: "mimo-cookie",
      type: "password",
      autoComplete: "off",
      style: settingsInputStyle,
      placeholder: "小米开放平台控制台 Cookie（必填）",
      value: settingText(current, fields.cookie),
      disabled: !writable || saving,
      'data-plan-credential': meta.id,
      onChange: (function (key) { return function (e) { change(key, e.target.value) } })(fields.cookie),
    }))
    // 长教程与凭据放在同一个折叠区（内容始终挂载）
    credentialChildren.push(h("p", { key: "mimo-hint", style: settingsHintStyle },
      "登录 platform.xiaomimimo.com 后，按 F12 打开开发者工具 → 网络 → 任一请求 → 复制请求头中完整的 Cookie 值粘贴到这里（需包含 userId 与 serviceToken 字段）。安卓设备可在电脑上获取后安全粘贴到此处。过期后需重新复制；tp-*/ttp-* 专用 Key 不支持余额查询。"))
  }
  if (enabled && credentialChildren.length > 0) {
    children.push(h("details", { key: "credentials", style: policyDetailsStyle, 'data-plan-credentials': meta.id },
      h("summary", { style: policySummaryStyle }, '连接与凭据（点开填写）'),
      credentialChildren,
    ))
  }
  // 余额类渠道的**侧栏显示**告警阈值（留空/0 表示不警告；host 侧默认 10 元）。
  // [2026-10-24] 措辞明确这是"侧栏状态灯"的告警，与模型「额度策略」是两套不同阈值。
  if (enabled && meta.thresholdField !== undefined) {
    var thresholdRaw = current[meta.thresholdField]
    children.push(h("label", { key: "threshold", style: settingsThresholdStyle, 'data-sidebar-alert': meta.thresholdField },
      h("span", { style: settingsHintStyle }, "侧栏显示告警额度（元）"),
      h("input", {
        type: "number",
        min: 0,
        step: 1,
        style: settingsThresholdInputStyle,
        placeholder: "默认 10",
        value: typeof thresholdRaw === "number" ? String(thresholdRaw) : "",
        disabled: !writable || saving,
        onChange: (function (key) {
          return function (e) {
            var raw = e.target.value
            change(key, raw === "" ? 0 : Number(raw))
          }
        })(meta.thresholdField),
      }),
      h("span", { style: settingsHintStyle }, "只影响侧栏胶囊状态灯的颜色；填 0 表示不告警。"),
    ))
  }
  // Xiaomi MiMo 的长教程已并入上面的「连接与凭据」折叠区（同一 details 内），此处不再重复渲染。
  if (enabled && meta.noCredential) {
    children.push(h("p", { key: "note", style: settingsHintStyle },
      meta.credentialNote || "请先在对应的登录插件中完成登录。"))
  }
  /**
   * [2026-10-21 用户需求] WorkBuddy 账号选择：勾选后只合计选中账号的积分。
   * 不勾任何账号 = 全部（保持既有行为）。纯显示偏好，不改凭据、不额外取数。
   */
  if (enabled && meta.id === 'workbuddy') {
    /**
     * [2026-10-21 真机] 整块**必须容错**：账号列表只是附加信息，
     * 任何异常都不能把整页设置带成白屏（真机已出现过一次白屏）。
     */
    try {
    var selectedIds = []
    try {
      var rawSel = settingText(current, 'workbuddyAccounts')
      var parsedSel = rawSel.length > 0 ? JSON.parse(rawSel) : []
      if (Array.isArray(parsedSel)) selectedIds = parsedSel
    } catch (err) { selectedIds = [] }
    var boxStyle = { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 }
    var accList = wbAccounts !== null && wbAccounts !== undefined && Array.isArray(wbAccounts.accounts)
      ? wbAccounts.accounts
      : []
    var accMessage = wbAccounts !== null && wbAccounts !== undefined && typeof wbAccounts.message === 'string'
      ? wbAccounts.message
      : ''
    var accLoaded = wbAccounts !== null && wbAccounts !== undefined && wbAccounts.loaded === true
    var items = [h("p", { key: 'hint', style: settingsHintStyle },
      selectedIds.length === 0
        ? '账号合计：全部账号（未选择 = 全部）。勾选可只统计部分账号。'
        : '账号合计：已选 ' + selectedIds.length + ' 个账号。')]
    if (accMessage.length > 0) {
      items.push(h("p", { key: 'msg', style: settingsHintStyle }, accMessage))
    }
    if (!accLoaded) {
      items.push(h("p", { key: 'loading', style: settingsHintStyle }, '正在读取账号列表…'))
    } else if (accList.length === 0) {
      items.push(h("p", { key: 'empty', style: settingsHintStyle }, '没有可用账号（或网关未配置/未启动）。'))
    } else {
      for (var ai = 0; ai < accList.length; ai++) {
        items.push((function (account) {
          var checked = selectedIds.indexOf(account.id) !== -1
          var label = String(account.label === undefined || account.label === null ? account.id : account.label)
            + (account.disabled ? '（已停用）' : (account.cooling ? '（冷却中）' : ''))
            + (account.remain === null || account.remain === undefined ? '' : '  ·  剩余 ' + account.remain)
          return h('label', {
            key: 'acc-' + account.id,
            style: Object.assign({}, settingsRowStyle, { fontSize: 12, cursor: (!writable || saving) ? 'default' : 'pointer' }),
          },
            h('input', {
              type: 'checkbox',
              'data-workbuddy-account': account.id,
              checked: checked,
              disabled: !writable || saving,
              onChange: function (e) {
                var next = selectedIds.slice()
                var at = next.indexOf(account.id)
                if (e.target.checked) { if (at === -1) next.push(account.id) }
                else if (at !== -1) next.splice(at, 1)
                change('workbuddyAccounts', JSON.stringify(next))
              },
            }),
            h('span', {}, label),
          )
        })(accList[ai]))
      }
    }
    children.push(h('div', { key: 'wb-accounts', style: boxStyle }, items))
    } catch (err) {
      children.push(h("p", { key: 'wb-accounts-failed', style: settingsHintStyle },
        '账号选择暂不可用（' + (err && err.message ? err.message : String(err)) + '）'))
    }
  }
  /**
   * [2026-10-23] 卡片底部：每个**活跃**内置渠道都有「关注额度策略」+ 自己的两档阈值。
   *
   * 只写 `quotaFocusChannels` / `quotaChannelThresholds`，不动总开关/信任/凭据；
   * 阈值输入只按该渠道**本次实际采样到**的窗口/币种渲染，不硬造窗口、不猜币种。
   */
  if (enabled) {
    children.push(renderChannelPolicyBlock(policyBlockProps(meta.id, meta.name, policyKindOf(meta), enabled)))
  }
  rows.push(h("div", { key: meta.id, style: planCardStyle, 'data-plan-card': meta.id }, children))
  }

  /**
   * [R4-03] 渲染顺序 = 全局顺序，但必须**保证当前所有自定义条目都被渲染**。
   *
   * `orderedIds()` 依赖 `planOrder` 与已知 id；刚「添加」一条新条目时它还没进
   * `planOrder`，如果只遍历 `renderOrder` 就会漏渲染（用户看不到新卡片）。
   * 因此这里把尚未出现的自定义 id 按草稿顺序追加在后面。
   */
  var renderOrder = orderedIds()

  var rendered = {}
  for (var rri = 0; rri < renderOrder.length; rri++) rendered[renderOrder[rri]] = true
  var draftCustom = customEntries()
  for (var rci = 0; rci < draftCustom.length; rci++) {
    var rid = draftCustom[rci] !== null && draftCustom[rci] !== undefined ? draftCustom[rci].id : null
    if (typeof rid === 'string' && rid.length > 0 && rendered[rid] !== true) {
      renderOrder.push(rid)
      rendered[rid] = true
    }
  }
  for (var roi = 0; roi < renderOrder.length; roi++) {
    var renderId = renderOrder[roi]
    if (looksCustomId(renderId)) {
      // 自定义卡片：只渲染这一条，位置由全局顺序决定。
      rows.push(h(CustomBalancesSection, {
        key: renderId,
        onlyId: renderId,
        entries: customEntries(),
        errors: customErrors,
        providers: Array.isArray(customStatus.providers) ? customStatus.providers : [],
        collapsed: customCollapsed,
        onToggleCollapsed: toggleCustomCollapsed,
        disabled: !writable,
        saving: saving,
        onChange: setCustomEntries,
        onReorder: reorderCustomEntries,
        globalOrder: orderedIds,
        onAdd: addCustomEntry,
        onDelete: deleteCustomEntry,
        onKeyChange: setCustomKey,
        onKeyClear: clearCustomKey,
        onKeyUndoClear: undoClearCustomKey,
        /**
         * [2026-10-23] 自定义余额卡也纳入「每个渠道都有额度策略」的要求：
         * 由页面传入**公共策略块**（金额两档 + 关注开关），本组件的其余逻辑不变。
         */
        policyFooter: function (info) {
          var name = info && info.entry && typeof info.entry.name === 'string' && info.entry.name.length > 0
            ? info.entry.name
            : '自定义余额'
          return renderChannelPolicyBlock(policyBlockProps(info.id, name, 'balance', info.entry && info.entry.enabled === false ? false : true))
        },
      }))
      continue
    }
    var metaForRow = null
    for (var mi = 0; mi < PLANS.length; mi++) {
      if (PLANS[mi].id === renderId) { metaForRow = PLANS[mi]; break }
    }
    if (metaForRow === null) continue
    if (metaForRow.fields === undefined || metaForRow.fields.enabled === undefined) continue
    rows.push(renderBuiltInCard(metaForRow))
  }

  return h("div", { style: settingsPageStyle },
    h("p", { style: settingsIntroStyle },
      writable
        ? "选择要显示的渠道并填入各自的凭据（Xiaomi MiMo 填控制台 Cookie）；卡片右侧 ▲/▼ 调整显示顺序（胶囊与详情面板共用）。改动在点击「保存更改」后生效。"
        : "当前部署的设置为只读，无法在此修改。"),
    rows,
    /**
     * [R4-03] 页尾只保留「添加入口 + 说明」。
     *
     * 已有自定义卡片已经按全局顺序与内置卡片混排渲染（见上面的
     * `renderOrder` 循环），这里**不再**整块重复渲染 `CustomBalancesSection`，
     * 否则会出现两份卡片、且页尾那份仍然固定分组。
     */
    h(CustomBalancesSection, {
      key: '__custom-add',
      addOnly: true,
      entries: customEntries(),
      errors: customErrors,
      providers: Array.isArray(customStatus.providers) ? customStatus.providers : [],
      disabled: !writable,
      saving: saving,
      onChange: setCustomEntries,
      onReorder: reorderCustomEntries,
      globalOrder: orderedIds,
      onAdd: addCustomEntry,
      onDelete: deleteCustomEntry,
    }),
    customErrors.__global
      ? h("p", { key: "__custom-error", style: customErrorStyle, role: "alert" }, customErrors.__global)
      : null,
    writable
      ? h("div", { style: settingsFooterStyle },
          // [2026-10-24] 只标"未保存"，**不统计 N 项**（避免把旧 custom 数组规范化误算成改动）。
          anyDirty
            ? h("span", { style: policyStatusStyle, 'data-unsaved': '1' }, saving ? '保存中…' : '有未保存更改')
            : null,
          h("button", {
            type: "button",
            style: Object.assign({}, settingsButtonStyle, (!anyDirty || saving) ? settingsButtonDisabledStyle : {}),
            disabled: !anyDirty || saving,
            onClick: discard,
          }, "放弃更改"),
          h("button", {
            type: "button",
            style: Object.assign({}, settingsButtonPrimaryStyle, (!anyDirty || saving) ? settingsButtonDisabledStyle : {}),
            disabled: !anyDirty || saving,
            onClick: save,
          }, saving ? "保存中…" : "保存更改"),
        )
      : null,
  )
}
// ===========================================================================
// apply
// ===========================================================================

// configForms 提供 DSH 托管的配置表单（读写当前 profile 条目的 Config）。
var inject = ['slots', 'configForms']

function apply(ctx) {
  // 配置由 DSH 基于 Host 半导出的 Config schema 自动生成设置页并持久化，
  // 客户端不再自建配置卡片，因此这里只注册用量胶囊本身。
  // [local patch] 零补丁版：注册进 DSH 官方公共席位 sidebar.footer.action
  // （由 sidebar 核心包声明，官方插件 dsh-client-ui-cordis 亦注册于此）。
  // 该席位是 list 类型，可容纳多个条目；order 10 让胶囊排在既有按钮之后。
  // configForms 的表单在这里获取一次，同时供胶囊订阅（实时反映设置改动）与设置页使用。
  var form = ctx.configForms.get('plan-usage')
  // [local patch 0.7.0] 注入悬停/焦点用的极小样式表（只作用于本插件自己的类名）。
  ensureStyles()
  ctx.slots.inject('sidebar.footer.action', function () {
    return ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'plan-usage',
      // [local patch 0.7.0] order 取一个很小的负数，让本插件排到**最上面一行**：
      // 详情面板是向上展开的（bottom: 100% + 10px），排在最后一行时会盖住
      // 其他插件的底部按钮；排到最上面就没有可遮挡的对象了。
      // 参考：ds-harness-remote 用 order:-20。
      order: -1000,
      // wide 由 sidebar 渲染时通过 ownerProps 注入（renderSlot('sidebar.footer.action', { wide })）
      inject: function () { return { configForm: form } },
    }, PlanUsageBadge)
  })
  // 设置页：注册进「内置插件」页面的 tab 席位 settings.plugins.tab，
  // 与 Codex Connect 的做法一致。configForms 提供该条目的配置表单，
  // whileServed 保证只有 Host 真正提供该命名空间时才出现这个页面。
  ctx.effect(function () {
    return ctx.configForms.whileServed(['plan-usage'], function () {
      return ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'plan-usage',
        order: 40,
        label: function () { return 'Usage Dock' },
        inject: function () { return { form: form } },
      }, PlanUsageSettingsPage)
    })
  }, 'plan-usage: settings page')
}

// [V2] 额外导出「作废某条已显示余额」：设置页保存 Key 后内部走同一条路径。
// 语义：把该条标记为比当前已显示数据更新，胶囊渲染时立刻不再展示旧值（不用等新响应）。
module.exports = {
  name: 'plan-usage',
  inject: inject,
  apply: apply,
  invalidateCustomChannel: function (id) { bumpConfigEpoch([id]) },
}
return module.exports
} })
