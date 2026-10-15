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

/** 面向用户的通用名称：不绑定具体套餐提供方。 */
var PLAN_NAME = '套餐用量'

/**
 * 已接入的套餐（渠道）：id 与 Host 半的 wire 标识一致，一一对应 Host 的
 * plans/*.js 模块。每接入一个套餐，在这里追加一项（credentialHint 用于
 * 配置卡片的占位/提示文案）。GLM 分为两个渠道：`glm-zai` 国际版 Z.AI 与
 * `glm-zhipu` 智谱开放平台，各自独立开关与 API Key。`kimi-code` 额外有
 * `cookieHint`：配置卡片据此渲染可选的 kimi-auth Cookie 输入框（月度会员
 * 额度增强，未配置时角标只显示 5小时/周限）。
 */
var PLANS = [
  // fields 与 Host 半各模块的 fields 一一对应：设置页用它读写 DSH 托管的 Config。
  { id: 'opencode-go', name: 'OpenCode Go', credentialHint: 'opencode-go', fields: { enabled: 'opencodeGoEnabled', apiKey: 'apiKey' } },
  { id: 'glm-zai', name: 'GLM Z.AI', credentialHint: 'ZAI', fields: { enabled: 'glmEnabled', apiKey: 'glmApiKey' } },
  { id: 'glm-zhipu', name: 'GLM 智谱', credentialHint: 'ZHIPU / GLM', fields: { enabled: 'glmZhipuEnabled', apiKey: 'glmZhipuApiKey' } },
  { id: 'kimi-code', name: 'Kimi Code', credentialHint: 'KIMI_CODE', cookieHint: 'kimi-auth', fields: { enabled: 'kimiCodeEnabled', apiKey: 'kimiCodeApiKey', cookie: 'kimiCodeCookie' } },
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
  { id: 'workbuddy', name: 'WorkBuddy', noCredential: true, creditMode: true, credentialNote: '复用 dsh-workbuddy-connect 的登录态，无需在此认证；请先安装并登录 WorkBuddy / WorkBuddy AI 桌面应用。', fields: { enabled: 'workbuddyEnabled' } },
]

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
  'kimi-code': function (plan, settingsSnap) {
    var notes = []
    // 未取到月度窗口时区分「未配置 Cookie」与「Cookie 过期/获取失败」两种情况。
    if (plan.monthlyUsage == null) {
      var kimiSnap = settingsSnap && settingsSnap.plans ? settingsSnap.plans['kimi-code'] : null
      notes.push(kimiSnap && kimiSnap.cookieConfigured
        ? '月度会员额度获取失败（kimi-auth Cookie 可能已过期）'
        : '配置 kimi-auth Cookie 可显示月度会员额度')
    }
    return notes
  },
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

/** 币种 → 显示符号（MiMo 官方返回 CNY/USD；未知币种按 ¥ 处理）。 */
function balanceSymbol(currency) {
  var cur = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  if (cur === 'USD') return '$'
  return '¥'
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

/** 连续失败达到该轮数后才显示「获取失败」（更早的失败保留旧值 + 灰字）。 */
var FAIL_THRESHOLD = 2

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
var peakStageStyle = { position: 'relative', height: 8, marginTop: 5, minWidth: 0 }
var peakTrackStyle = { position: 'relative', width: '100%', height: '100%', borderRadius: 999, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-3)' }
var peakPatternStyle = { position: 'absolute', left: 0, top: 0, height: '100%', willChange: 'transform' }
// 两个图形只共享一个 50% 锚点，子项只相对于 x=0 定位；不以负 margin / 独立行补偿。
var peakMarkerStyle = { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 0, pointerEvents: 'none', zIndex: 2 }
// 替代样式待用户选定；此次仅修正几何，保留原来的 2px 柱。
var peakCursorStyle = { position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: 'var(--dsw-alias-bg-base)', transform: 'translateX(-50%)' }
// 明确的 8×5 图形盒，避免零宽 border 三角受宿主通用 box-sizing / border 样式影响。
var peakCaretStyle = { position: 'absolute', left: 0, top: -5, width: 8, height: 5, background: 'var(--dsw-alias-label-tertiary)', clipPath: 'polygon(0 0, 100% 0, 50% 100%)', transform: 'translateX(-50%)' }
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
      // marker 是轨道的兄弟，不被圆角裁切；三角尖端 y=0，恰好接触轨道上缘。
      h('div', { style: peakMarkerStyle, 'data-peak-marker': '' },
        h('span', { style: peakCursorStyle, 'data-peak-cursor': '' }),
        h('span', { style: peakCaretStyle, 'data-peak-caret': '' }),
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
var rootStyle = { position: 'relative', flex: '1 1 auto', minWidth: 0, boxSizing: 'border-box', zIndex: 1000, fontFamily: 'inherit' }
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

  // [0.8.1 回退记录] 内嵌充值入口已按用户要求**整体移除**：原生 Platform 视图
  // 的 bounds 在窗口状态变化时会被主进程按 open 时的值重放，与网页层返回栏
  // 反复互相遮挡（返回栏消失/重合/加载后又被盖），真机多轮修正仍无法稳定，
  // 2026-10-15 用户拍板放弃该入口。官方路径仍是「设置 → 账号与余额 → 充值」，
  // 详情面板余额行的提示文案会引导过去。focus/visibilitychange 的余额强刷
  // （roadmap 方向 2）与充值无耦合，保留。

  var stateHook = React.useState({ loading: true })
  var state = stateHook[0]
  var setState = stateHook[1]
  var openHook = React.useState(false)
  var open = openHook[0]
  var setOpen = openHook[1]
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

  // [local patch 0.8.0] 轮询数据层重写：
  //   1. **失败降级**（roadmap 方向 3 定稿）：单渠道失败先保留上次成功值、数值
  //      用灰色弱化（不加「更新于」标注）；连续 FAIL_THRESHOLD 轮失败才显示
  //      「获取失败」。整体请求失败按「所有渠道 +1 轮」同样处理。
  //   2. **轮询防卡死**：fetch 加 AbortController 20s 超时；请求 settle（成功/
  //      失败/超时）后 in-flight 标记必然复位——旧版请求挂起即轮询永久停摆。
  //   3. **手动强刷**：load(true) 作废旧请求立即重拉（点开面板 / 窗口 focus /
  //      visibilitychange 触发，见下方 effect）。
  var loadRef = React.useRef(null)

  React.useEffect(function () {
    if (enabled === false) return
    var alive = true
    var controller = null // 当前 in-flight 请求的 AbortController（null = 空闲）
    var lastList = null   // 上一轮渲染用的渠道列表（含 error 条目），降级时沿用
    var failStreaks = {}  // 渠道 id → 连续失败轮数
    var timer = null

    function findPlan(list, id) {
      if (!Array.isArray(list)) return null
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i]
      }
      return null
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
      for (var i = 0; i < source.length; i++) {
        var plan = source[i]
        if (!plan || typeof plan.id !== 'string') continue
        seen[plan.id] = true
        if (plan.error) {
          // 缺凭据、登录失效等语义错误立即透传；仅暂时的网络/执行错误允许保留旧值。
          var transient = plan.error === 'curl' || plan.error === 'exec' || plan.error === 'rpc'
            || (plan.error === 'http' && /HTTP (429|5\d\d)/.test(plan.message || ''))
          if (!transient) {
            delete failStreaks[plan.id]
            merged.push(plan)
            continue
          }
          var streak = (failStreaks[plan.id] || 0) + 1
          failStreaks[plan.id] = streak
          var prev = findPlan(lastList, plan.id)
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
          merged.push({ id: old.id, name: old.name, error: 'rpc', message: '获取失败' })
        }
      }
      lastList = merged
      return merged
    }

    function applyResult(result) {
      if (!alive) return
      if (result && typeof result === 'object' && result.error === 'disabled') {
        setState({ ok: false, error: 'disabled' })
        return
      }
      if (result && typeof result === 'object' && result.ok && result.data
        && Array.isArray(result.data.plans)) {
        setState({ ok: true, data: { plans: settle(result.data.plans) } })
        return
      }
      // 请求失败：有旧数据就降级展示，否则按整体失败提示。
      if (Array.isArray(lastList) && lastList.length > 0) {
        setState({ ok: true, data: { plans: settle(null) } })
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
        timer = setTimeout(function () { current.abort(); reject(new Error('usage timeout')) }, 20000)
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
  }, [enabled])

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

  if (enabled === false || (state && state.error === 'disabled')) return null

  // 只展示当前仍启用的套餐（禁用后旧数据一并丢弃）。
  var data = state && state.ok ? state.data : null
  var plans = data && Array.isArray(data.plans) ? data.plans : []
  // 按 DSH 托管的配置过滤：Host 半的配置在插件加载时读取、运行时不热重载，
  // 所以这里必须再筛一次，取消勾选才能立即生效。
  plans = plans.filter(function (p) {
    var meta = planMeta(p.id)
    var key = meta.fields && meta.fields.enabled
    return key === undefined || settingBool(config, key, true)
  })
  // [local patch 0.8.1] 按 planOrder 配置排序（设置页「上移/下移」维护），
  // 胶囊行与详情面板分区共用同一顺序。
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
    // [local patch 0.8.1] WorkBuddy 积分渠道：右侧显示剩余积分（千分位）+
    //「（积分）」后缀与各家余额区分；不限额 ∞（积分）。
    if (meta.creditMode === true && (typeof plan.creditsTotal === 'number' || plan.creditsUnlimited === true)) {
      var wbText = (plan.creditsUnlimited === true ? '∞' : formatCredit(plan.creditsTotal)) + '（积分）'
      capsuleRows.push({
        dot: plan.stale === true ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-success-primary)',
        label: meta.name,
        values: [wbText],
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
          wide && h('span', { style: r.stale ? Object.assign({}, capValueStyle, staleValueStyle) : capValueStyle }, r.values.join(' ')),
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
      var title = meta.name + (meta.creditMode === true ? ' 积分'
        : meta.balanceThreshold !== undefined ? ' 余额'
        : (meta.percentMode === 'remaining' ? ' 剩余额度' : ' 用量')) + (plan.level ? ' · ' + plan.level : '')
      var inner
      if (plan.error) {
        inner = h('div', { style: sectionNoteStyle }, plan.message || '无法获取用量')
      } else if (meta.creditMode === true) {
        // [local patch 0.8.1] WorkBuddy 积分渠道：合计 + 各版本/各套餐明细。
        if (plan.creditsUnlimited === true) {
          inner = h('div', {},
            h('div', { style: Object.assign({}, balRowStyleStatic, { color: 'var(--dsw-alias-label-primary)' }) },
              h('span', { style: Object.assign({}, dotStyle, { width: 9, height: 9, background: 'var(--dsw-alias-state-success-primary)' }) }),
              h('span', {}, '∞（不限额）'),
            ),
          )
        } else if (typeof plan.creditsTotal === 'number') {
          // [0.8.1 定稿] 明细行组装（版本小计 + 各套餐）。展示形态按高度自适应：
          //   - 行数少（≤ 深度上限，见 WB_DETAIL_MAX_ROWS）：正常灰字文字铺开；
          //   - 超过则收进固定高度列表滚动查看；paddingRight 预留滚动条宽度。
          // 「WorkBuddy：合计」版本小计行**不再显示**——与上方大号合计重复
          //（用户定稿）；多版本并存时在套餐名前带 variant 前缀区分。
          var wbRows = []
          // 各套餐明细（remain>0 或企业套餐；与 workbuddy-connect 卡片口径一致）。
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
          var listStyle = wbRows.length > WB_DETAIL_MAX_ROWS
            ? Object.assign({}, wbDetailListStyle)
            : null
          var detailBlock = listStyle !== null
            ? h('div', { style: listStyle, key: 'wbdetail' }, wbRows)
            : wbRows
          inner = h('div', {},
            h('div', { style: Object.assign({}, balRowStyleStatic, { color: 'var(--dsw-alias-label-primary)' }) },
              h('span', { style: Object.assign({}, dotStyle, { width: 9, height: 9, background: 'var(--dsw-alias-state-success-primary)' }) }),
              h('span', {}, formatCredit(plan.creditsTotal)),
            ),
            detailBlock,
          )
        } else {
          inner = h('div', { style: sectionNoteStyle }, '积分获取失败')
        }
      } else if (meta.balanceThreshold !== undefined) {
        // [local patch] 余额类套餐：显示剩余余额与可用状态；低于阈值红灯提示。
        if (typeof plan.balance !== 'number') {
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
          // [local patch 0.8.0/0.8.1] Xiaomi MiMo 的现金/赠送明细：同一行，现金
          // 左对齐、赠送右对齐（用户定稿，比两行更紧凑美观）。
          var detailChildren = []
          if (typeof plan.cashBalance === 'number' || typeof plan.giftBalance === 'number') {
            var sym = balanceSymbol(plan.currency)
            detailChildren.push(h('div', {
              key: 'cashgift',
              style: { display: 'flex', alignItems: 'baseline', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: 1.5, margin: '2px 0' },
            },
              h('span', {}, '现金余额：' + sym + floorToCent(plan.cashBalance)),
              h('span', { style: { marginLeft: 'auto' } }, '赠送余额：' + sym + floorToCent(plan.giftBalance)),
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
            // [local patch 0.8.0/0.8.1] DeepSeek 账号登录时显示峰谷时间条
            // （host 附 peakSegs + peakPhase；API Key 模式没有）。
            plan.id === 'deepseek' ? h(PeakBar, { segs: plan.peakSegs, phase: plan.peakPhase, key: 'peak' }) : null,
          )
        }
      } else {
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
    panel = h('div', { style: panelStyle },
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
var settingsFooterStyle = { display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: "0.5px solid var(--dsw-alias-border-l2)" }
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
  var current = draft !== null ? draft : value
  var dirty = draft !== null && writable

  /** 复制一个对象并覆盖单个字段（ES5 风格，避免计算属性名）。 */
  function withField(base, field, val) {
    var next = {}
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k]
    }
    next[field] = val
    return next
  }

  function change(field, val) { setDraft(withField(current, field, val)) }
  function discard() { setDraft(null) }

  // [local patch 0.8.1] 渠道顺序维护：基于当前（草稿优先）planOrder 计算新数组。
  // 未列渠道按注册表默认顺序补在队尾；上/下移一格后全量落盘。
  function orderedIds() {
    var order = parsePlanOrder(current.planOrder) || []
    for (var i = 0; i < PLANS.length; i++) {
      if (order.indexOf(PLANS[i].id) === -1) order.push(PLANS[i].id)
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

  /** 把草稿里与已保存值不同的字段逐个写回（DSH 负责修订号校验与持久化）。 */
  function save() {
    if (draft === null || saving || !writable) return
    var jobs = []
    for (var k in draft) {
      if (!Object.prototype.hasOwnProperty.call(draft, k)) continue
      if (draft[k] !== value[k]) jobs.push(api.set(k, draft[k]))
    }
    if (jobs.length === 0) { setDraft(null); return }
    setSaving(true)
    Promise.all(jobs).then(function () {
      setSaving(false)
      setDraft(null)
    }, function () {
      // 写入被拒绝时保留草稿，用户可以重试或放弃。
      setSaving(false)
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

  // [0.8.1 定稿] 卡片按当前顺序排列；名称行与右缘的 ▲/▼ 箭头列**严格横向
  // 对位**——箭头列不在卡片上 absolute 浮动，而是挂在名称行内部（flex 两端），
  // 与「厂商名称」同一行同一中线；卡片其余内容（Key/Cookie/阈值/提示）照常
  // 在下方铺开，不受箭头列影响。
  var planMetas = orderedPlanMetas()
  for (var pi = 0; pi < planMetas.length; pi++) {
    var meta = planMetas[pi]
    var fields = meta.fields || {}
    var enabledKey = fields.enabled
    if (enabledKey === undefined) continue
    var enabled = settingBool(current, enabledKey, true)
    var arrowBtnStyle = Object.assign({}, settingsButtonStyle, {
      padding: 0, fontSize: 9, lineHeight: '12px', height: 14, width: 22, margin: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    })
    // 箭头列垂直中点 = 名称行中线：gap:0（两按钮紧贴，中缝即组的中线），
    // 列本身作为名称行 flex 的子项由 alignItems:center 以**自身几何中心**对齐。
    // ▲14px + ▼14px = 28px 高的列，中心点恰好在两按钮的贴合缝上。
    var arrows = h("div", {
      key: "arrows",
      style: { display: 'flex', flexDirection: 'column', gap: 0, flex: 'none', marginLeft: 'auto' },
    },
      h("button", {
        type: "button",
        'aria-label': meta.name + ' 上移',
        title: '上移',
        style: Object.assign({}, arrowBtnStyle, !writable ? settingsButtonDisabledStyle : {}),
        disabled: !writable || saving,
        onClick: (function (id) { return function () { movePlan(id, -1) } })(meta.id),
      }, '▲'),
      h("button", {
        type: "button",
        'aria-label': meta.name + ' 下移',
        title: '下移',
        style: Object.assign({}, arrowBtnStyle, !writable ? settingsButtonDisabledStyle : {}),
        disabled: !writable || saving,
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
        ),
        arrows,
      ),
    ]
    if (enabled && fields.apiKey !== undefined) {
      children.push(h("input", {
        key: "key",
        type: "password",
        autoComplete: "off",
        style: settingsInputStyle,
        placeholder: meta.name + " API Key（留空则回退到「设置 → 模型」中的凭据）",
        value: settingText(current, fields.apiKey),
        disabled: !writable || saving,
        onChange: (function (key) { return function (e) { change(key, e.target.value) } })(fields.apiKey),
      }))
    }
    // [0.8.1 定稿] Xiaomi MiMo：布局对齐 DeepSeek——凭据框在上（紧跟名称行）、
    // 余额警告额度在下、操作提示最后；不再套 settingsGroupStyle（去掉多余横线）。
    if (enabled && fields.cookie !== undefined && fields.apiKey === undefined && meta.id === 'mimo') {
      children.push(h("input", {
        key: "mimo-cookie",
        type: "password",
        autoComplete: "off",
        style: settingsInputStyle,
        placeholder: "小米开放平台控制台 Cookie（必填）",
        value: settingText(current, fields.cookie),
        disabled: !writable || saving,
        onChange: (function (key) { return function (e) { change(key, e.target.value) } })(fields.cookie),
      }))
    }
    // 余额类渠道的警告阈值（留空/0 表示不警告；host 侧默认 10 元）。
    if (enabled && meta.thresholdField !== undefined) {
      var thresholdRaw = current[meta.thresholdField]
      children.push(h("label", { key: "threshold", style: settingsThresholdStyle },
        h("span", { style: settingsHintStyle }, "余额警告额度（元）"),
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
        h("span", { style: settingsHintStyle }, "低于该值时状态灯转为警告色；填 0 表示不警告"),
      ))
    }
    // Xiaomi MiMo 的操作提示：放卡片最底（与凭据框分离，不再夹在中间）。
    if (enabled && fields.cookie !== undefined && fields.apiKey === undefined && meta.id === 'mimo') {
      children.push(h("p", { key: "mimo-hint", style: settingsHintStyle },
        "登录 platform.xiaomimimo.com 后，按 F12 打开开发者工具 → 网络 → 任一请求 → 复制请求头中完整的 Cookie 值粘贴到这里（需包含 userId 与 serviceToken 字段）。安卓设备可在电脑上获取后安全粘贴到此处。过期后需重新复制；tp-*/ttp-* 专用 Key 不支持余额查询。"))
    }
    if (enabled && meta.noCredential) {
      children.push(h("p", { key: "note", style: settingsHintStyle },
        meta.credentialNote || "请先在对应的登录插件中完成登录。"))
    }
    rows.push(h("div", { key: meta.id, style: settingsGroupStyle }, children))
  }

  return h("div", { style: settingsPageStyle },
    h("p", { style: settingsIntroStyle },
      writable
        ? "选择要显示的渠道并填入各自的凭据（Xiaomi MiMo 填控制台 Cookie）；卡片右侧 ▲/▼ 调整显示顺序（胶囊与详情面板共用）。改动在点击「保存更改」后生效。"
        : "当前部署的设置为只读，无法在此修改。"),
    rows,
    writable
      ? h("div", { style: settingsFooterStyle },
          h("button", {
            type: "button",
            style: Object.assign({}, settingsButtonStyle, (!dirty || saving) ? settingsButtonDisabledStyle : {}),
            disabled: !dirty || saving,
            onClick: discard,
          }, "放弃更改"),
          h("button", {
            type: "button",
            style: Object.assign({}, settingsButtonPrimaryStyle, (!dirty || saving) ? settingsButtonDisabledStyle : {}),
            disabled: !dirty || saving,
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

module.exports = { name: 'plan-usage', inject: inject, apply: apply }
return module.exports
} })
