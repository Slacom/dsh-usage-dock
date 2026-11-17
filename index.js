/**
 * dsh-usage-dock 的 Host 半：注册 `GET /api/plan-usage`（并行拉取各渠道用量/余额）。
 *
 * 架构：每个渠道的取数/归一化逻辑独立封装在 plans/ 目录的模块里
 * （opencode-go、deepseek、codex、mimo、workbuddy、workbuddy-ai，以及 0.9.0 的
 * custom-balance 动态条目），plans/index.js 是注册表。本文件只负责 Config 声明、
 * 路由与通用编排。
 *
 * 配置：导出 `Config`（schemastery schema）交由 DSH 托管——DSH 会据此在
 * 「设置 → 插件」里**自动生成本插件的设置页**，并把改动持久化到 profile 的
 * Cordis patch，随后以 config-reload 通知插件。历史版本（0.3.x）曾自建
 * /config 路由与 JSON 文件存储，0.4.0 起统一交给 DSH，避免双配置源。
 *
 * 每个渠道的 API Key 解析优先级（见 plans/util.js 的 resolveApiKey）：
 *   1. 插件配置里的 `apiKey`；2. 「设置 → 模型」凭据库中该渠道的候选名。
 * 两者都为空时该渠道返回 no-key，由浏览器胶囊提示用户设置。
 *
 * [0.9.0] 自定义余额渠道：
 *   - `customBalances` 是公开元数据数组（名称/URL/键路径/币种/凭据引用…）；
 *   - `customKeys` 是 `id → API Key` 的 secret dict，任何 remote 读取都会把它剥掉
 *     （dsh-settings 的 redactSecrets），浏览器只拿到「是否存在」的布尔摘要；
 *   - 取数走 plans/custom-balance.js（原生 fetch + 自有 URL/重定向/大小/超时边界），
 *     与内置渠道并行、互不拖累，且受整批预算约束。
 */

import { randomUUID, createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { PLANS, planSchemaFields, percentSemanticsOf } from './plans/index.js'
import { parseMimoBalance } from './plans/mimo.js'
import {
  MIMO_LEGACY_RECORD_KEY,
  buildLegacyRecord,
  parseLegacyRecord,
  replayLegacyBalance,
} from './plans/mimo-legacy-store.js'
import { peakPhaseAt, peakSegments } from './plans/peak-phase.js'
/**
 * [2026-10-25 客户端 Key 端点] WorkBuddy 只读客户端积分接口 + 账号列表（固定"不支持"元数据）。
 * 旧的 `selectedAccountsFingerprint` 已不参与观察身份（无稳定账号 ID，筛选不再生效），
 * 但仍留在 plans/workbuddy.js 里供历史测试。
 */
import { setWebBase, listWorkbuddyAccounts, GATEWAY_CREDITS_PATH } from './plans/workbuddy.js'
import { execError, isSentinelApiKey } from './plans/util.js'
import {
  customSchemaFields,
  fetchCustomPlans,
  customStatusOf,
  newCustomId,
  unpackConfig,
  unwrapVolatile,
  configProofOf,
  configDigestOf,
  collectCustomEntries,
  keyRevOf,
  listProviderTargets,
  resolveProviderCredential,
  legacyCustomAllowed,
  providerSourceFingerprint,
  credentialFingerprint,
} from './plans/custom-balance.js'
// [2026-11-11 Codex 双来源] 来源归一 / 启用探测 / 运行期身份 / 只读状态路由：
// 全部来自 `plans/codex-sources.js`（纯观察，零 I/O），与取数层共用同一套规则。
import {
  codexSourceOf,
  codexRuntimeIdentityOf,
  getCodexSourceState,
  normalizeCodexSource,
  CODEX_SOURCE_CONNECT,
  CODEX_SOURCE_SUBSCRIPTION,
} from './plans/codex-sources.js'
import { registerUsageTool } from './plans/usage-tool-register.js'
// [A01] `projectUsage` 是发布观察时把 wire 投影成白名单渠道的唯一入口。
// 漏了这个导入会让**每一次成功采集**都抛 ReferenceError，被外层 catch 吞掉，
// 于是提示词永远只剩「暂无额度数据」。`node --check` 抓不到未绑定的运行时名字。
import { projectUsage, mimoWireWithDisplay } from './plans/usage-tool.js'
// [dsh-go 原生 strip] 会话路由 → 渠道 → ≤24 字文本（纯函数）。
import { applySessionRouteEvent, providerToChannel, formatStripText } from './plans/strip.js'
// [dsh-go 原生适配] 详情卡片 → App 原生面板（panels: session.tab / features）。
import { registerDshGoSurface } from './plans/dsh-go-native.js'
import { quotaPolicySchemaFields, parseFocusChannels } from './plans/usage-policy.js'
import { registerMimoAuth } from './plans/mimo-auth/host.js'
import { createQuotaObserver, promoteOwnTicket } from './plans/quota-observer.js'
import { createRouteObserver } from './plans/quota-route.js'
import { buildQuotaView } from './plans/quota-view.js'
import { renderQuotaPrompt, pickSmallestWindow, usesReservePool, resolveRoute } from './plans/quota-prompt.js'
import { describeWindowCapability } from './plans/quota-thresholds.js'

export const name = 'plan-usage'

/**
 * [D6-B] 结果依赖「账号/会话」而非可读配置的内置渠道。
 *
 * 这些渠道的实际身份（登录态、外部 token 所属账户）Host 侧**无法可靠读取**，
 * 因此工具缓存**不收录**它们：宁可每次重取，也不拿旧账户余额回答新账户的问题。
 * 其余渠道（OpenCode / 自定义条目）的凭据就在配置里，可以按哈希隔离缓存。
 *
 * [2026-11-12 MiMo lane 对齐] **MiMo 也归入这里**：模型的 `usage_status` 现在优先读
 * `mimo-auth` 的显示快照（与胶囊同一条 lane），而那份数值来自**控制台会话 / 记住登录**
 * （`plans/mimo-auth/session-display.js` 的 `verified` 状态），不是配置里的 Cookie 原文。
 * 会话切换、记住登录失效、控制台侧换账号，都可能**不改配置**却换掉余额 —— 若仍按配置哈希
 * 缓存 30 秒，工具会把上一账号/上一会话的余额当成当前值回答。所以：不进缓存、不共享在途
 * 结果、也不冻结凭据（身份一致性改由 `identityOfChannel()` 的 `cookie=` 指纹 + 票据校验兜住，
 * 与 deepseek 等账号型渠道同一套机制）。
 */
const ACCOUNT_BOUND_PLAN_IDS = new Set(['deepseek', 'codex', 'workbuddy', 'workbuddy-ai', 'mimo'])

/** [D6-G] systemPrompt 段落的排序位：排在工具说明之后、SDK 之前。 */
const POLICY_CONTEXT_ORDER = 300

/**
 * [终审 F] legacy 余额的新鲜期：只认**真实采集时间**（`fetchedAt`），5 分钟后不再当新鲜值。
 */
const LEGACY_BALANCE_FRESH_MS = 5 * 60_000

/**
 * [终审 F] legacy 余额的**选择顺序**（纯函数，便于离线守门）。
 *
 * ① `done` 快照（当前进程里扫码登录完成的余额）只有在真实 `fetchedAt` 新鲜（≤5 分钟）时
 *    才有**优先权**；
 * ② 否则看凭据记录缓存 `record`，同样只按真实 `fetchedAt` 判新鲜；
 * ③ 都没有新鲜值 ⇒ `needsReplay:true`，由调用方限频触发一次重放并返回 null（读取中/缺失）。
 *
 * **过期/缺时间戳的 done 不得短路整条路径**——否则重放成功的新余额会被过期的 done
 * 快照永久挡住（终审 F 的真实故障）。
 *
 * @param {{done?: object|null, record?: object|null, now?: number}} input
 * @returns {{value: {balance:{balance:number,currency:string}, fetchedAt:number}|null, needsReplay:boolean}}
 */
export function pickLegacyBalanceView(input) {
  const src = input !== null && typeof input === 'object' ? input : {}
  const now = typeof src.now === 'number' && Number.isFinite(src.now) ? src.now : Date.now()
  const sampledAtOf = (entry) => {
    if (entry === null || entry === undefined || typeof entry !== 'object') return null
    const at = entry.fetchedAt
    return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null
  }
  const fresh = (sampledAt) => sampledAt !== null && now - sampledAt <= LEGACY_BALANCE_FRESH_MS
  const valueOf = (entry, sampledAt) => ({
    balance: { balance: entry.balance, currency: entry.currency },
    fetchedAt: sampledAt,
  })
  const done = src.done !== null && src.done !== undefined && typeof src.done === 'object' ? src.done : null
  if (done !== null) {
    const sampledAt = sampledAtOf(done)
    if (fresh(sampledAt) && typeof done.balance === 'number' && Number.isFinite(done.balance)) {
      return { value: valueOf(done, sampledAt), needsReplay: false }
    }
  }
  const record = src.record !== null && src.record !== undefined && typeof src.record === 'object' ? src.record : null
  if (record !== null) {
    const sampledAt = sampledAtOf(record)
    if (fresh(sampledAt) && typeof record.balance === 'number' && Number.isFinite(record.balance)) {
      return { value: valueOf(record, sampledAt), needsReplay: false }
    }
  }
  return { value: null, needsReplay: true }
}

/** 只需要 Web 服务器；账号余额通过可选的 deepseekAccount 服务读取。 */
export const inject = ['webServer']

/** 插件配置 schema：DSH 据此渲染设置页并持久化到 profile 的 Cordis patch。 */
export const Config = z.object(Object.assign(
  // .volatile() 是 DSH 设置表单显示该字段的前提。
  { enabled: z.boolean().default(true).volatile() },
  // [local patch 0.8.1] 渠道显示顺序（胶囊与详情面板共用）：渠道 id 的 JSON 数组，
  // 设置页用「上移/下移」按钮维护；未列出的渠道按注册表默认顺序排在后面。
  { planOrder: z.string().default('[]').volatile() },
  // [dsh-go/MiMo 持久化] 扫码登录成功后把平台 cookie 存进 DSH 凭据记录，
  // 重启引擎后重放余额接口，免去重新扫码。默认开启，可在设置页关闭（关闭即清除）。
  { mimoRememberLogin: z.boolean().default(true).volatile() },
  planSchemaFields(),
  // [0.9.0] 自定义余额渠道（公开元数据 + 分离的 secret dict）。
  customSchemaFields(),
  // [方向 6 / T3] 可选的「收尾建议」策略（默认关闭，只影响模型可见提示）。
  quotaPolicySchemaFields(),
))

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * [0.9.0 / R7] 解包一份配置里的 volatile 包装（委托给 custom-balance 的 unpackConfig）。
 *
 * 审查发现：0.8.x/0.9.0 只在读**开关**时解包，传给各 plan 的仍是原始 Config。
 * 无 `configEditor` 的部署里（DSHA / 移动端），`deepseekApiKey` 是 `{get()}` 包装对象，
 * `resolveApiKey` 的字符串判断失败 → 用户填了 Key 也报 no-key。这里在**交给 provider
 * 之前**统一解包，覆盖 Key / Cookie / 阈值 / 自定义数组等所有字段。
 */
function cfgValue(cfg, key) {
  const raw = cfg != null ? cfg[key] : undefined
  return unwrapVolatile(raw)
}

/**
 * [local patch 0.8.1] 每次请求时重读最新配置（读不到就用 apply 时的快照兜底）。
 *
 * 背景（已知限制的修复）：Host 半的 `config` 参数是**插件加载时**的快照，设置页
 * 保存（尤其 role('secret') 的 Cookie/Key）后运行时不热重载——用户填了小米 MiMo
 * Cookie 仍报 no-key 就是这个原因。configEditor 服务能同步读出该条目「inherited +
 * profile override」的合成配置（与设置页同源），这里在每次 /api/plan-usage 请求时
 * 合并进工作副本；失败静默回退快照。
 *
 * 合并策略：以重读值为准，缺失的键回落快照（重读值只包含 profile patch 里显式
 * 写下的字段）。enabled/渠道开关同样以重读为准——顺带把「停用渠道后 Host 仍
 * 取数」的无谓请求也一并修掉。
 */
function createLiveConfig(ctx, snapshot) {
  let cached = { at: 0, value: snapshot }
  // [Z3] 读取代次：并发读时只允许**最新**的一次提交，避免较早的慢读把新状态盖回旧的。
  let seq = 0
  let committed = 0
  async function read(force) {
    const now = Date.now()
    if (!force && now - cached.at < 2000) return cached.value // 2 秒内复用，多窗口齐射不重复读盘
    const ticket = (seq += 1)
    try {
      const editor = ctx.get('configEditor')
      if (editor === undefined || typeof editor.configuration !== 'function') return cached.value
      const row = editor.configuration().find((row) => row.entry && row.entry.options
        && row.entry.options.id === 'plan-usage')
      if (row === undefined) return cached.value
      // override = profile patch 显式配置；inherited = 组合层配置。override 优先。
      const merged = Object.assign({}, snapshot,
        row.inherited != null && typeof row.inherited === 'object' ? row.inherited : {},
        row.override != null && typeof row.override === 'object' ? row.override : {})
      if (ticket >= committed) {
        committed = ticket
        cached.value = merged
        cached.at = Date.now()
      }
      return merged
    } catch (err) {
      return cached.value
    }
  }
  const liveConfig = () => read(false)
  /**
   * 作废两秒缓存。宿主发出 `app-boot/config-reload` 时必须调用：
   * 否则事件落在缓存窗口内会读到**旧**配置，策略段落就永远不更新。
   */
  liveConfig.invalidate = () => { cached.at = 0 }
  /** 强制重读（等价于 invalidate + 立刻读一次）。 */
  liveConfig.forceFresh = () => read(true)
  /**
   * [2026-10-23 独立审查阻断项] **严格 FRESH 读取**：绕过 2 秒缓存，且**不吞异常**。
   *
   * 为什么需要单独一个入口：`read(true)` 的错误分支会静默回落到上一次的 `cached.value`，
   * 于是「读不到当前配置」会被当成「配置没变」，只读入口就会继续拿旧配置算身份、
   * 把**上一个来源的额度窗口**当成当前能力（父用例已实际复现：换 Key 后 0ms 请求仍回旧窗口）。
   *
   * 语义：
   *   - 有 `configEditor`：直接读一次它的 configuration()（异常**向上抛**，由调用方 fail closed），
   *     并把结果提交进缓存（与其它路径共享同一份新鲜值）；
   *   - 没有 `configEditor`：返回启动快照 —— 该部署本来就不能热重读配置（既有已知限制），
   *     不是读取失败，因此不抛错；
   *   - 找不到本插件条目：返回上一次的已知值（条目消失不属于"读取失败"）。
   *
   * ⚠️ **只供明确要求"当前配置"的只读入口使用**（如 `/api/plan-usage/quota-windows`）。
   * 不要拿它替换取数路径上的 2 秒缓存（那会把多窗口齐射变成重复读盘）。
   */
  liveConfig.freshStrict = async () => {
    const now = Date.now()
    const editor = (() => {
      try { return ctx.get('configEditor') } catch (err) { return undefined }
    })()
    if (editor === undefined || editor === null || typeof editor.configuration !== 'function') {
      return snapshot
    }
    const ticket = (seq += 1)
    // 故意不 try/catch：读取失败必须让调用方知道"无法证明这是当前配置"。
    const rows = editor.configuration()
    /**
     * [2026-10-23 独立审查 F01/F02]**有服务却拿不到当前配置 = 失败**，不能 quiet fallback。
     *
     * 之前这两种坏返回都回落到 `cached.value`，于是 metadata 把**上一次来源的窗口**
     * 连同 `fresh:true` 一起返回。现在：
     *   - `configuration()` 返回的不是数组 → 抛固定错误；
     *   - 数组里找不到本插件条目 → 同样抛固定错误（条目被移除 / 宿主结构变化）。
     * 调用方据此 fail closed，绝不把旧缓存标成"当前"。
     */
    if (!Array.isArray(rows)) throw new Error('config-unavailable')
    const row = rows.find((item) => item && item.entry && item.entry.options && item.entry.options.id === 'plan-usage')
    if (row === undefined) throw new Error('config-unavailable')
    const merged = Object.assign({}, snapshot,
      row.inherited != null && typeof row.inherited === 'object' ? row.inherited : {},
      row.override != null && typeof row.override === 'object' ? row.override : {})
    if (ticket >= committed) {
      committed = ticket
      cached.value = merged
      cached.at = now
    }
    return merged
  }
  return liveConfig
}

/**
 * [CP-08] 展示用 URL 脱敏。
 *
 * 只去掉**敏感部分**（userinfo、查询串、fragment），保留协议、主机与**路径**——
 * 用户需要看清结尾有没有 `/v1`，这与安全无关但影响配置正确性。
 */
function sanitizeDisplayUrl(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return ''
  try {
    const url = new URL(text.trim())
    // 重建：去掉 userinfo / search / hash。
    return url.protocol + '//' + url.host + url.pathname
  } catch (err) {
    return ''
  }
}
/**
 * [顺序修复 2026-10-20 第三次] 按 `planOrder` 排**完整渠道列表**（内置 + 自定义）。
 *
 * 客户端的上移/下移会同时写 `customBalances` 与 `planOrder`；Host 侧也据此
 * 返回相同顺序，胶囊、详情面板、设置页卡片才不会各说各话。
 *
 * 不在 `planOrder` 里的条目保持原有相对顺序排在后面（不丢、不乱了序）。
 *
 * @param {Array} list 完整 wire 结果（内置 + 自定义混排）
 * @param {string|Array} planOrder 已保存的顺序（可能是 JSON 字符串）
 * @returns {Array}
 */
function orderPlansByPlanOrder(list, planOrder) {
  if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? list : []
  let order = []
  if (Array.isArray(planOrder)) order = planOrder
  else if (typeof planOrder === 'string' && planOrder.length > 0) {
    try {
      const parsed = JSON.parse(planOrder)
      if (Array.isArray(parsed)) order = parsed
    } catch (err) { order = [] }
  }
  const rank = new Map()
  for (let i = 0; i < order.length; i += 1) {
    if (typeof order[i] === 'string' && !rank.has(order[i])) rank.set(order[i], i)
  }
  if (rank.size === 0) return list
  // 稳定排序：命中 planOrder 的按其次序，未命中的按原相对位置排在后面。
  const decorated = list.map((row, index) => ({
    row,
    index,
    has: row !== null && row !== undefined && typeof row.id === 'string' && rank.has(row.id),
    rank: row !== null && row !== undefined && typeof row.id === 'string' && rank.has(row.id)
      ? rank.get(row.id)
      : Number.MAX_SAFE_INTEGER,
  }))
  decorated.sort((a, b) => {
    if (a.has && b.has) return a.rank - b.rank
    if (a.has !== b.has) return a.has ? -1 : 1
    return a.index - b.index
  })
  return decorated.map((d) => d.row)
}

/**
 * [终审 N2 整改] 兜底错误 wire 补上 codex 来源身份。
 *
 * `execError(plan)`（取数被异常打断）与作废行一样是「没有数值的 codex 行」：不带
 * `codexSource` 时客户端按默认 `connect` 处理，订阅态下这行会被渲染层过滤掉 ——
 * 用户看不到「本来源失败」，只看到整行消失。只对 codex 生效，其它渠道原样返回。
 */
function withConfiguredCodexSource(wire, cfgNow) {
  if (wire === null || typeof wire !== 'object' || wire.id !== 'codex') return wire
  if (wire.codexSource !== undefined) return wire
  return Object.assign(wire, { codexSource: codexSourceOf(cfgNow) })
}

export function apply(ctx, config) {
  // DSH 托管的配置；config-reload 时会以新对象重新进入 apply 之前的读取路径。
  // [local patch 0.8.1] 路由内改用 liveConfig()（每次请求重读），快照只作兜底。
  const cfg = config != null && typeof config === 'object' ? config : {}
  const liveConfig = createLiveConfig(ctx, cfg)

  // [dsh-go 原生适配] 原生面板不依赖 webServer，先注册再决定是否启动 Web 半：
  //   - 只有装了 dsh-go 桥接的主机（手机本机引擎）才会执行 ctx.inject(['dshGo'])；
  //   - 面板视图是静态骨架 + 数据绑定，数据在面板打开时由下面的 collect 拉取；
  //   - 其它主机（含 dsh-go 插件检查器的隔离宿主）上 Web 半行为完全不变。
  const nativeCollectRef = { fn: null }
  /** [dsh-go] 原生桥接是否可用：只有这种主机才需要「策略快照后台刷新」。 */
  let dshGoBridgeSeen = false
  /** [终审 D] 插件作用域是否已卸载：后台刷新 tick 在异步前后都要检查它。 */
  let applyDisposed = false
  // 原生面板注册跟随桥接的插件作用域回收（官方示例 dsh-go-example-usage / -workbench /
  // -readaloud 也不额外包 ctx.effect）：自己再包一层清理，会让官方检查器在 dispose() 之后
  // 读到空注册表、误报「quota has no view file and no panel registration」。
  const dshGoSurface = registerDshGoSurface(ctx, {
    plans: PLANS,
    semanticsOf: percentSemanticsOf,
    onBridge: () => {
      dshGoBridgeSeen = true
      // [终审 D] 桥接出现/重载后恢复后台刷新循环（桥退出时会被停掉，重进要能重新启动）。
      Promise.resolve().then(() => {
        if (applyDisposed) return
        policyRefreshStopped = false
        startPolicyRefreshLoop()
      }).catch(() => {})
    },
    // [终审 D] 桥接作用域退出：撤销桥接状态并停止后台循环（原生半调用；缺省时由下面的 inject 兜住）。
    onBridgeDetach: () => {
      dshGoBridgeSeen = false
      try { policyRefreshStop() } catch (err) { /* 旧宿主 */ }
    },
    strip: (scope, emit, caps) => subscribeStrip(scope, emit, caps),
    mimoSessionBalance: () => legacyMimoBalance(),
    sessionChannelLabel: (sessionId, localeNow) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
      try {
        backfillSessionRoute(sessionId)
        const route = sessionRoute.get(sessionId)
        if (route === undefined) return ''
        const cfgNow = quotaCfg !== null && typeof quotaCfg === 'object' ? quotaCfg : {}
        const channel = channelForRoute(route, cfgNow)
        if (channel === null) return ''
        const names = {
          'opencode-go': 'OpenCode Go', codex: 'Codex', deepseek: 'DeepSeek', mimo: 'MiMo', workbuddy: 'WorkBuddy',
        }
        const name = channel.custom === true
          ? (typeof channel.name === 'string' && channel.name.length > 0 ? channel.name : '自定义余额')
          : (names[channel.channelId] || channel.channelId)
        const en = typeof localeNow === 'string' && localeNow.toLowerCase().startsWith('en')
        return (en ? 'Current session: ' : '当前会话：') + name
      } catch (err) {
        return ''
      }
    },
    loadConfig: async () => unpackConfig(await liveConfig()),
    collect: (cfgNow) => (nativeCollectRef.fn === null ? Promise.resolve([]) : nativeCollectRef.fn(cfgNow)),
    customEntries: (cfgNow) => {
      try {
        return collectCustomEntries(cfgNow === null || cfgNow === undefined ? {} : cfgNow, { allowLegacy: legacyCustomAllowed() })
      } catch (err) {
        return []
      }
    },
    // [0.11.0 原生设置页] 写回配置：复用 DSH 的 settings 服务（与网页版设置页同一条写盘通道，
    // 会走 volatile 字段校验 + Loader 热重载）。不可用时由设置页提示「当前主机不能保存设置」。
    saveConfig: async (patch) => {
      const settings = (() => {
        try { return ctx.get('settings') } catch (err) { return undefined }
      })()
      if (settings === null || settings === undefined || typeof settings.update !== 'function') {
        throw new Error('settings service unavailable')
      }
      await settings.update('plan-usage', patch)
      // 原生设置页的策略开关保存后立即 refresh 视图；作废 2 秒缓存，避免重建时读到旧配置。
      if (typeof liveConfig.invalidate === 'function') liveConfig.invalidate()
      /**
       * [终审 A/B/C] 设置页保存**不依赖**是否收到 `app-boot/config-reload`：
       * 立即撤销 legacy 旧值、让 strip 进入同步遮蔽并作废旧缓存/在途结果，
       * 然后重读配置再放行 strip 重新计算。
       */
      invalidateLegacyMimoState()
      markStripConfigDirty()
      void Promise.resolve().then(() => refreshQuotaCfg()).finally(() => {
        stripConfigPending = false
        notifyStripSubs()
      })
      if (patch !== null && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'mimoRememberLogin')) {
        if (patch.mimoRememberLogin === false) clearLegacyMimoRecord()
        else void restoreLegacyMimo(true)
      }
    },
    // 设置面板打开时订阅配置热重载，外部（网页版）改了配置也能立即回显。
    onConfigReload: (fn) => {
      if (typeof ctx.on !== 'function' || typeof fn !== 'function') return null
      try {
        const dispose = ctx.on('app-boot/config-reload', fn)
        return typeof dispose === 'function' ? dispose : null
      } catch (err) {
        return null
      }
    },
    // [0.11.0 原生面板 · MiMo 扫码登录] 直接调用本插件已经在 connection.fetch 注册的
    // auth / qr handler（同进程、非 HTTP），复用完整的 MiMo 登录状态机与 QR 图片。
    mimoAuth: {
      status: () => mimoAuthStatus,
      request: async (kind, body) => {
        const host = (() => {
          try { return mimoAuthHost.getHost() } catch (err) { return null }
        })()
        if (host === null || host === undefined || host.native === undefined || host.native === null) return null
        const handler = kind === 'qr' ? host.native.qr : host.native.auth
        if (typeof handler !== 'function') return null
        const path = kind === 'qr' ? '/api/plan-usage-mimo-qr' : '/api/plan-usage-mimo-auth'
        const init = body === null || body === undefined
          ? { method: 'GET' }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        let response
        try {
          response = await handler(new Request('http://127.0.0.1' + path, init))
        } catch (err) {
          return null
        }
        if (response === null || response === undefined) return null
        if (kind === 'qr') {
          if (response.status !== 200) return { ok: false, status: response.status }
          try {
            const bytes = Buffer.from(await response.arrayBuffer())
            return { ok: true, mime: response.headers.get('content-type') || 'image/png', bytes }
          } catch (err) {
            return null
          }
        }
        let payload = null
        try { payload = await response.json() } catch (err) { payload = null }
        return { ok: response.status === 200, status: response.status, body: payload }
      },
    },
  })
  // dsh-go 插件检查器的隔离宿主没有 webServer（它不是完整的 DSH 组合环境）。
  // 原生面板已经注册，Web 路由 / 工具 / 观察器都依赖 webServer，不再在这里启动。
  if (ctx == null || ctx.webServer == null) return

  // [MiMo G1] Optional owner-only auth capability; main plugin never hard-injects connection.
  let mimoAuthStatus = { supported: false, code: 'E_MIMO_AUTH_UNAVAILABLE' }
  /**
   * [remembered 2026-11-07] 「记住登录」managed 模式的**启用闸门**：
   * `global enabled && mimoEnabled`（默认 `!== false` 视为开）。
   * 探测时机：Host 在配置事件（boot / config-reload）时**立即**调用本回调重新探测；
   * 另有 ≤1s 的本地 probe 兜底（本地读，不走上游网络、不解密）。检测到 false 即
   * 撤销在途操作（不是"0ms 可观察"——这里是"配置事件即时 + ≤1s 兜底"，如实表述）。
   * 必须用 **freshStrict**（无 2 秒成功缓存）：`liveConfig()` 在 ≤1s 窗口内可能仍返回
   * 旧的 `true`，那会违背 fail-closed。
   * 代码级开关 `enableRememberedAccount` 在本仓库保持默认 false（现有本地保护），
   * 由安装 overlay 在**本调用的 options 里**显式加 `enableRememberedAccount: true`。
   */
  const mimoAuthHost = registerMimoAuth(ctx, (status) => { mimoAuthStatus = status }, {
    isEnabled: async () => {
      try {
        const live = (await liveConfig.freshStrict()) ?? cfg
        if (cfgValue(live, 'enabled') === false) return false
        if (cfgValue(live, 'mimoEnabled') === false) return false
        return true
      } catch { return false }
    },
    /**
     * [0.10.3] 生产默认开启：之前这两项只在本地 staged 版里有，发布包缺失，
     * 导致新装环境进不了 managed 模式、客户端回退到旧的实验面板。
     */
    enableConsoleProtocol: true,
    enableRememberedAccount: true,
    onLegacyLogin: (payload) => { persistLegacyMimoLogin(payload) },
  })

  /**
   * [2026-11-12 MiMo lane 对齐 · 第二层修正] **零 IO** 的显示快照 peek（与胶囊同一条 lane）。
   *
   * 三层来源，缺一不可：
   *   ① `registerMimoAuth()` 的返回值**只有** `{ bootEpoch, dispose, getHost }` —— 真正的 host 是
   *      `ctx.inject(['connection','webServer'], …)` 里**异步**创建、只存在于闭包 `child` 的，
   *      必须经 `getHost()` 每次现读（inject 未完成时为 `null`，之后会自动接上）；
   *   ② host 上优先用 `routeDisplay`：它才是**路由实际使用**的那份（managed「记住登录」模式 =
   *      `remembered.displaySnapshot()`）；`display` 是旧 legacy manager，managed 下是 `absent`；
   *   ③ 两者都缺 ⇒ `null`（=「不适用」，回落 provider）。
   *
   * 任何异常/缺失都退化成 `null`；`routeDisplay.peek()` 抛错**不**偷偷回退 legacy（保持批次 D 语义）。
   * 只读消费，绝不用于变更动作（managed 下 start/read/grant/… 固定拒绝）。
   */
  // ---- [MiMo legacy 登录持久化] ----
  /**
   * 扫码登录成功后把**平台侧 cookie** 交给 DSH 凭据记录保管（`ctx.credentials`），
   * 重启引擎后重放余额接口即可免扫码。记录落盘在 `$DSH_HOME/.credentials.yaml`
   * （0600、原子写），不含账号密码/账号 cookie/上游原文。
   */
  const legacyRecordState = { checkedAt: 0, data: null, inFlight: null }
  const credentialsService = () => {
    try {
      const service = ctx.get('credentials')
      return service !== null && service !== undefined && typeof service.modifyRecord === 'function' ? service : null
    } catch (err) {
      return null
    }
  }
  /** [终审 A] legacy 状态代次：配置变化 / 关闭 remember 时递增，让在途结果全部作废。 */
  let legacyEpoch = 0
  /** 记录重放的最小重试间隔（避免每次读显示都打上游）。 */
  const LEGACY_RESTORE_RETRY_MS = 30_000
  /**
   * [终审 A｜legacy 闸门] 凭据读取 / 余额重放的**唯一**开关，四层全部满足才放行：
   *   ① 本机存在 dsh-go 原生桥接（只有手机本机引擎才有这条 lane）；
   *   ② 插件总开关 `enabled !== false`；
   *   ③ MiMo 渠道开关 `mimoEnabled !== false`；
   *   ④ `mimoRememberLogin !== false`。
   * 任何一项不满足 ⇒ 零凭据读取、零上游重放；读配置失败按 fail-closed 处理。
   */
  const legacyMimoGate = async () => {
    if (dshGoBridgeSeen !== true) return false
    try {
      const live = unpackConfig(await liveConfig())
      if (cfgValue(live, 'enabled') === false) return false
      if (cfgValue(live, 'mimoEnabled') === false) return false
      return cfgValue(live, 'mimoRememberLogin') !== false
    } catch (err) {
      return false
    }
  }
  /** 同步版闸门（显示路径不能 await）：只信已缓存的配置快照；缺快照时仅校验桥接。 */
  const legacyMimoGateSync = () => {
    if (dshGoBridgeSeen !== true) return false
    const snapshot = quotaCfg
    if (snapshot === null || typeof snapshot !== 'object') return true
    if (cfgValue(snapshot, 'enabled') === false) return false
    if (cfgValue(snapshot, 'mimoEnabled') === false) return false
    return cfgValue(snapshot, 'mimoRememberLogin') !== false
  }
  /**
   * [终审 A] 配置变化 / 关闭 remember 时**立即**撤销在途与旧值：
   * 推进代次让在途任务的结果作废，并清掉展示缓存，避免停用后旧值继续显示。
   */
  const invalidateLegacyMimoState = () => {
    legacyEpoch += 1
    legacyRecordState.checkedAt = 0
    legacyRecordState.data = null
    legacyRecordState.inFlight = null
  }
  const persistLegacyMimoLogin = (payload) => {
    const epoch = legacyEpoch
    const stopped = () => epoch !== legacyEpoch || dshGoBridgeSeen !== true
    void Promise.resolve().then(async () => {
      try {
        if (!(await legacyMimoGate())) return
        if (stopped()) return
        const record = buildLegacyRecord(payload)
        if (record === null) return
        // 记录新鲜度只信 buildLegacyRecord 给出的真实采样时间（payload.fetchedAt 缺失才用当前时间）。
        const credentials = credentialsService()
        if (credentials === null) return
        if (stopped()) return
        await credentials.modifyRecord(MIMO_LEGACY_RECORD_KEY, async () => ({ kind: 'grant', payload: record }))
        if (stopped()) return
        legacyRecordState.checkedAt = Date.now()
        legacyRecordState.data = { balance: record.balance, currency: record.currency, fetchedAt: record.fetchedAt }
      } catch (err) { /* 持久化失败不影响登录结果 */ }
    })
  }
  const clearLegacyMimoRecord = () => {
    // [终审 A] 关闭即撤销：清展示缓存 + 作废在途任务，再尽力删除凭据记录。
    invalidateLegacyMimoState()
    void Promise.resolve().then(async () => {
      try {
        const credentials = credentialsService()
        if (credentials !== null && typeof credentials.deleteRecord === 'function') {
          await credentials.deleteRecord(MIMO_LEGACY_RECORD_KEY)
        }
      } catch (err) { /* 删除失败下次仍会尝试 */ }
    })
  }
  /** 读记录 → 重放余额接口；返回 `{balance,currency,fetchedAt}` 或 null。 */
  const restoreLegacyMimo = (force) => {
    // [终审 A] 触发时桥接就必须已存在：apply 早期（桥接尚未注入）的调用直接不排队，
    // 否则等微任务跑到时桥接可能已就绪，会凭空打一次凭据读取。
    if (dshGoBridgeSeen !== true) return Promise.resolve(null)
    if (legacyRecordState.inFlight !== null) return legacyRecordState.inFlight
    const epoch = legacyEpoch
    const stopped = () => epoch !== legacyEpoch || dshGoBridgeSeen !== true
    const task = Promise.resolve().then(async () => {
      try {
        if (!(await legacyMimoGate())) return null
        if (stopped()) return null
        // 只有**真实 fetchedAt** 新鲜时才复用缓存；checkedAt 只用于限制重放频率。
        if (force !== true && legacyRecordState.data !== null) {
          const sampledAt = typeof legacyRecordState.data.fetchedAt === 'number'
            && Number.isFinite(legacyRecordState.data.fetchedAt) && legacyRecordState.data.fetchedAt > 0
            ? legacyRecordState.data.fetchedAt
            : null
          if (sampledAt !== null && Date.now() - sampledAt < LEGACY_BALANCE_FRESH_MS) return legacyRecordState.data
        }
        const credentials = credentialsService()
        if (credentials === null || typeof credentials.readRecord !== 'function') return null
        let record
        try { record = await credentials.readRecord(MIMO_LEGACY_RECORD_KEY) } catch (err) { record = undefined }
        if (stopped()) return null
        const parsed = parseLegacyRecord(record)
        if (parsed === null) {
          if (record !== undefined && record !== null && typeof credentials.deleteRecord === 'function') {
            try { await credentials.deleteRecord(MIMO_LEGACY_RECORD_KEY) } catch (err) { /* 忽略 */ }
          }
          if (stopped()) return null
          legacyRecordState.checkedAt = Date.now()
          legacyRecordState.data = null
          return null
        }
        const result = await replayLegacyBalance(parsed.cookie, { parseBalance: parseMimoBalance })
        if (stopped()) return null
        if (result.ok === true) {
          const data = { balance: result.balance, currency: result.currency, fetchedAt: result.fetchedAt }
          legacyRecordState.checkedAt = Date.now()
          legacyRecordState.data = data
          return data
        }
        if (result.reason === 'unauthorized' || result.reason === 'parse') {
          if (typeof credentials.deleteRecord === 'function') {
            try { await credentials.deleteRecord(MIMO_LEGACY_RECORD_KEY) } catch (err) { /* 忽略 */ }
          }
          legacyRecordState.checkedAt = Date.now()
          legacyRecordState.data = null
        }
        return null
      } catch (err) {
        return null
      } finally {
        if (legacyRecordState.inFlight === task) legacyRecordState.inFlight = null
      }
    })
    legacyRecordState.inFlight = task
    return task
  }

  /** legacy 余额：优先当前进程内的登录会话，其次凭据记录重放（重启后免扫码）。 */
  const legacyMimoBalance = () => {
    /**
     * [终审 A] 无桥 / 停用 / 关 remember：既不读凭据，也不把历史余额说成新鲜。
     * 同步闸门只能读缓存的配置快照；配置重载时 `invalidateLegacyMimoState()` 已清空旧值。
     */
    if (!legacyMimoGateSync()) {
      if (legacyRecordState.data !== null) invalidateLegacyMimoState()
      return null
    }
    const triggerRestore = (force) => {
      if (legacyRecordState.checkedAt !== 0 && Date.now() - legacyRecordState.checkedAt < LEGACY_RESTORE_RETRY_MS) return
      void restoreLegacyMimo(force)
    }
    // ① 当前进程内的 done 快照：只有 host 给出**真实 fetchedAt** 时才参与选择；
    //    过期/缺时间戳**只失去优先权**，不能短路后面的记录缓存（终审 F）。
    let done = null
    try {
      const h = mimoAuthHost !== null && mimoAuthHost !== undefined && typeof mimoAuthHost.getHost === 'function'
        ? mimoAuthHost.getHost()
        : null
      if (h !== null && h !== undefined && typeof h.legacyDoneBalance === 'function') {
        const hit = h.legacyDoneBalance()
        if (hit !== null && typeof hit === 'object') done = hit
      }
    } catch (err) { /* 下一步走记录 */ }
    // ②/③ 统一由纯函数决定：done 新鲜 → 用它；否则记录缓存新鲜 → 用它；都没有 → 限频重放并返回 null。
    const decision = pickLegacyBalanceView({ done, record: legacyRecordState.data, now: Date.now() })
    if (decision.value !== null) return decision.value
    if (decision.needsReplay) triggerRestore(true)
    return null
  }

  const mimoDisplayPeek = () => {
    try {
      const h = mimoAuthHost !== null && mimoAuthHost !== undefined && typeof mimoAuthHost.getHost === 'function'
        ? mimoAuthHost.getHost()
        : null
      if (h === null || h === undefined) return null
      // routeDisplay/display 可能返回「缺席 DTO」（非 null 但不可用），
      // 会挡住 legacy 兜底；只有真的能投影成 wire 的才直接返回。
      // 本地轻量判定（与 mimoDisplayWire 的可用条件一致）：避免测试/离线环境依赖额外 import。
      const usable = (candidate) => {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null
        if (candidate.selected !== true || candidate.state !== 'verified') return null
        const money = candidate.balance
        if (money === null || typeof money !== 'object' || Array.isArray(money)) return null
        if (typeof money.balance !== 'number' || !Number.isFinite(money.balance) || money.balance < 0) return null
        return candidate
      }
      if (h.routeDisplay !== null && h.routeDisplay !== undefined && typeof h.routeDisplay.peek === 'function') {
        const direct = usable(h.routeDisplay.peek())
        if (direct !== null) return direct
      }
      if (h.display !== null && h.display !== undefined && typeof h.display.peek === 'function') {
        const direct = usable(h.display.peek())
        if (direct !== null) return direct
      }
      // [local 2026-11-15] legacy 扫码登录只把余额写进会话 manager，不会生成 display 快照；
      // 用量面板会一直 `mimo:missing`。这里把 done 会话的余额投影成 display 形状，
      // 让面板/策略/网页胶囊都能读到（只读、不带凭据）。
      const legacy = legacyMimoBalance()
      if (legacy === null) return null
      return {
        displaySupported: true,
        selected: true,
        state: 'verified',
        balance: legacy.balance,
        currency: legacy.balance.currency,
        freshness: 'fresh',
        fetchedAt: legacy.fetchedAt,
        displayId: 'legacy-session',
        generation: 1,
        revision: 1,
        code: 'E_NONE',
        identity: null,
        awaitingBalanceMatch: false,
        confirmedByUser: true,
        canStop: false,
        managed: false,
        readFailures: 0,
        refreshCount: 0,
        maxAutoRefresh: 0,
      }
    } catch (err) {
      return null
    }
  }
  const mimoDisplaySource = { peek: mimoDisplayPeek }
  /** [终审 E] MiMo 显示快照的来源身份（非密；采样前后各取一次，用于发现会话/代次漂移）。 */
  const mimoDisplayIdentity = () => {
    try {
      const h = mimoAuthHost !== null && mimoAuthHost !== undefined && typeof mimoAuthHost.getHost === 'function'
        ? mimoAuthHost.getHost()
        : null
      if (h === null || h === undefined) return ''
      const snap = h.routeDisplay !== null && h.routeDisplay !== undefined && typeof h.routeDisplay.peek === 'function'
        ? h.routeDisplay.peek()
        : (h.display !== null && h.display !== undefined && typeof h.display.peek === 'function' ? h.display.peek() : null)
      if (snap === null || typeof snap !== 'object') return ''
      const parts = []
      if (typeof snap.displayId === 'string' && snap.displayId.length > 0) parts.push(snap.displayId)
      if (typeof snap.generation === 'number' && Number.isFinite(snap.generation)) parts.push('g' + snap.generation)
      if (typeof snap.revision === 'number' && Number.isFinite(snap.revision)) parts.push('r' + snap.revision)
      return parts.length > 0 ? '|disp=' + parts.join('.') : ''
    } catch (err) {
      return ''
    }
  }

  /**
   * [dsh-go 原生适配] 原生面板取数：与 Web 路由共用 provider / 配置热读 / 自定义渠道路径，
   * 但不经过 GUI 的观察票据（原生面板只读展示，不参与额度策略观察）。
   *
   * 面板关闭后 data feed 被取消，不再轮询；面板打开时每 30 秒一次（与 Web 半一致）。
   */
  nativeCollectRef.fn = async (cfgNow) => {
    const cfgSnapshot = cfgNow !== null && typeof cfgNow === 'object' ? cfgNow : {}
    /**
     * [终审 E｜身份必须在采样前固化]
     *
     * 旧实现「整批 await 完再统一算身份」：慢渠道等待期间 Codex revision / 账号变化时，
     * 先完成的旧结果会被贴上**新**身份，carry 隔离反而信任这个错误标记。
     *
     * 现在：
     *   - 采样**之前**把共享配置缓存对齐到本次采样用的配置，并逐渠道记录 `identityBefore`；
     *   - 采样**之后**再算一次 `identityAfter`（按当时的真实缓存，**不再回写旧 cfg**）；
     *   - 只有两者相等、且（MiMo）显示快照身份也相等时，才把 `identity` 附到该条 wire；
     *     不等 ⇒ 不带 identity（原生半按「不复用旧值」处理）。
     */
    try { quotaCfg = cfgSnapshot } catch (err) { /* 只读缓存 */ }
    const identityBefore = new Map()
    const displayBefore = new Map()
    const captureIdentityBefore = (id) => {
      if (typeof id !== 'string' || id.length === 0) return
      let value = null
      try { value = identityOfChannel(id) } catch (err) { value = null }
      identityBefore.set(id, typeof value === 'string' && value.length > 0 ? value : null)
      if (id === 'mimo') displayBefore.set(id, mimoDisplayIdentity())
    }
    const enabledPlans = PLANS.filter((plan) => cfgSnapshot[plan.fields.enabled] !== false)
    for (const plan of enabledPlans) captureIdentityBefore(plan.id)
    try {
      for (const entry of collectCustomEntries(cfgSnapshot, { allowLegacy: legacyCustomAllowed() })) {
        captureIdentityBefore(entry.id)
      }
    } catch (err) { /* 条目读不到时对应 wire 不会带 identity */ }
    let shell
    try { shell = ctx.get('shell') } catch (err) { shell = undefined }
    const builtIn = await Promise.all(enabledPlans.map((plan) => Promise.resolve()
      .then(() => (plan.id === 'mimo'
        ? mimoWireWithDisplay(mimoDisplaySource, () => plan.fetch(ctx, shell, cfgSnapshot))
        : plan.fetch(ctx, shell, cfgSnapshot)))
      .catch(() => withConfiguredCodexSource(execError(plan), cfgSnapshot))))
    let custom = []
    try {
      custom = await fetchCustomPlans(ctx, undefined, cfgSnapshot, { allowLegacy: legacyCustomAllowed() })
    } catch (err) {
      custom = []
    }
    const ordered = orderPlansByPlanOrder(builtIn.concat(Array.isArray(custom) ? custom : []), cfgSnapshot.planOrder)
    /**
     * [carry 身份] 原生面板每个渠道附一个**不可逆来源身份**字符串（非密：不含 URL/Key/账号），
     * 由原生半用 `${channelId}|${identity}` 做旧值 carry 隔离。
     * 该字段只进原生面板数据，**不**写回 Web wire 的既有字段。
     */
    const nativeWires = []
    for (const wire of Array.isArray(ordered) ? ordered : []) {
      if (wire === null || typeof wire !== 'object') { nativeWires.push(wire); continue }
      const id = wire.id
      const before = identityBefore.get(id)
      let after = null
      try { after = identityOfChannel(id) } catch (err) { after = null }
      const sameChannelIdentity = typeof before === 'string' && before.length > 0 && before === after
      const displayAfter = id === 'mimo' ? mimoDisplayIdentity() : ''
      const sameDisplayIdentity = id !== 'mimo' || displayAfter === (displayBefore.get(id) || '')
      if (sameChannelIdentity && sameDisplayIdentity) {
        nativeWires.push(Object.assign({}, wire, { identity: after + displayAfter }))
      } else {
        // 采样期间身份发生漂移：不带 identity（原生半按「不复用旧值」处理）。
        nativeWires.push(Object.assign({}, wire))
      }
    }
    return nativeWires
  }

  // [额度自动感知] 观察容器与路由观察器提升到 apply 作用域：
  // **GUI 路由与模型工具共用同一份状态与失败计数**（交接文档 §3.1）。
  void restoreLegacyMimo()

  const quotaObserver = createQuotaObserver()
  const routeObserver = createRouteObserver({
    ctx,
    // apply 期间的 effect 生命周期由下面各自的闭包负责；这里只判断 ctx 是否仍有效。
    alive: () => true,
    // [A06] 能力闸门：只有**显式确认**安装顺序可信时才发布路由观察。
    // 本版本没有公开的安装顺序证据，所以默认闭合（normal、零规则）；
    // 用户确认自己部署顺序可接受后，用 `quotaTrustRouteOrder` 打开。
    reviewedChainReady: () => quotaTrustsRouteOrder(),
  })
  /**
   * [A06] 读取用户的显式授权（配置项 `quotaTrustRouteOrder`）。
   *
   * 为什么默认关闭：观察器只能看到 `await next()` 之后的结果；
   * 若某个更外层的 writer 在之后又改写路由（Codex 的 task / Reserve 就有这种能力），
   * 我们会观察到错误的 provider 并据此注入收尾规则。宁可不提示，也不误判。
   */
  const quotaTrustsRouteOrder = () => {
    const cfgNow = quotaCfg
    // 配置尚未读到时不放行：宁可少一次提示，也不拿未确认的顺序做判断。
    if (cfgNow === null || cfgNow === undefined) return false
    // [R2-03] **必须显式授权**：缺省（含旧配置没有该字段）一律不放行。
    // 新增配置项的默认值不能替代用户对「安装顺序可信」的明确确认。
    return cfgNow.quotaTrustRouteOrder === true
  }

  /**
   * [A02] 观察身份：渠道 → 当前应有的身份指纹（配置代次 + 公开凭据修订）。
   *
   * 身份变了说明 Key/URL/来源/启用状态已改，旧额度**必须立即失效**，
   * 不能等到下一次采集；也不能把上一个身份的余额当成新身份的证据。
   */
  const channelIdentity = new Map()
  /** 渠道 → 脱敏投影（同步 context 回调只能读这里）。 */
  const channelProjection = new Map()
  /** 渠道 → 观察元信息 `{status, identity, sampledAt, failCount, source}`。 */
  const channelMeta = new Map()
  /** 策略配置快照（异步读一次，context 同步读）。 */
  let quotaCfg = null
  /** 采集中：id → ticket（[A03] 开始序号，用于拒绝迟到结果） */
  const pendingTickets = new Map()
  /**
   * [R9-01 / 根因 A] **操作归属**：每个渠道最近一次「入场」的序号。
   *
   * 只靠票据对象归属不够：凭据解析是**前置异步 I/O**，一次旧操作可能在新的 B 已经
   * 提交之后才返回，此时它的回调仍会写指纹、推进 epoch、清掉 B 的投影
   * （审核 R9：旧 A 迟到 → context 变 1/closing）。
   *
   * 因此每个入口在**任何异步 I/O 之前**领一个序号；任何要修改来源状态的动作
   * 都必须先证明自己仍是该渠道的当前操作，否则一律不写、不推进、不授权。
   */
  let opSeqCounter = 0
  const currentOpOf = new Map()
  // 已确认的来源/观察才撤销更早操作；两个尚在识别的同源消费者不能互相取消。
  const confirmedOpOf = new Map()
  const beginOp = (id) => {
    opSeqCounter += 1
    currentOpOf.set(id, opSeqCounter)
    return opSeqCounter
  }
  const isCurrentOp = (id, seq) => typeof seq === 'number' && seq > 0
    && seq <= (currentOpOf.get(id) || 0) && seq >= (confirmedOpOf.get(id) || 0)
  const confirmOp = (id, seq) => {
    if (typeof seq === 'number') confirmedOpOf.set(id, Math.max(seq, confirmedOpOf.get(id) || 0))
  }

  /**
   * [A10] 同一个 wire 对象只允许提交一次观察。
   *
   * 工具采集的两个消费者会拿到**同一个** wire 实例：
   * `emit()`（逐渠道回传）与最终的 `results` 整批。若每次都用新票据，
   * 一次成功会被计两遍、一次失败也会被计两遍，导致 3 次失败就跨过 5 次阈值。
   *
   * 因此按**对象身份**去重（而不是按票据），并让同一 wire 复用同一张票据。
   */
  /** [R4-01] 曾出现过的自定义条目 id（用于「删除后仍推进 epoch」）。 */
  const knownCustomIds = new Set()

  const publishedWires = new WeakSet()
  const acceptedWires = new WeakSet()
  const revokedResponses = new WeakSet()
  const wireTickets = new WeakMap()
  // Host 私有归属证明；wire 不能靠完成时补票获得写入权限。
  const ticketOperations = new WeakMap()

  /**
   * [R2-02] 计算某渠道**自己的**身份指纹（Host 内部，绝不外泄）。
   *
   * 为什么不能用全局配置摘要：`configDigestOf` 只折叠自定义条目的公开身份，
   * 用它 + id 冒充「每条渠道的身份」会导致两个方向的错误：
   *   1. **漏失效**：改 MiMo Cookie / 内置 Key 身份不变 → 旧余额继续驱动收尾；
   *   2. **误失效**：只改某个自定义条目的 Key，所有渠道（含 WorkBuddy）都被清空。
   *
   * 因此这里逐渠道取**该渠道自己的**公开配置字段，只对具备 secret 的字段取
   * 长度与首尾字符的不可逆指纹（绝不保留原文），并拼上该条目的公开修订号。
   */
  /**
   * [R4-01] 「上一次实际采样到的凭据指纹」按条目 id 记录。
   *
   * 为什么需要这张表：`identityOfChannel` 是**同步纯函数**，不能在里面解密凭据；
   * 而 identify / 取数层是异步的，它真正解析出了本次要发送的 Key。
   * 审核要求「本次 identify 已经读到并计算了 A 指纹，不能把这一已知来源事实
   * 只用于工具 cache，却不更新 Host 观察身份」。
   *
   * 因此：采样层把指纹登记进来，身份计算时直接消费 —— 这是**已经知道的事实**，
   * 不是现场再查一次；也不能因为表为空就把旧来源当成当前来源。
   */
  const sampledCredentials = new Map()
  /**
   * [R8-01] 采样回调必须**携带本次操作的票据**。
   *
   * 上一版按渠道 id 取「全局最近签发」的票来提升 epoch，结果工具 identify 采样到 B 时
   * （成功缓存命中、没有新的取数票），把一张**旧的、仍挂起的 GUI A 票**提升到 B 代次；
   * 旧 A 返回后照样提交，把 context 从 9000 改回 1。所谓「最新一张」不等于
   * 「本次采样的票」。
   *
   * 现在只有显式传入、且仍是该渠道当前待提交票的那一张才能被提升；
   * 没有票据（工具 identify / 缓存命中）就只登记来源、撤旧，绝不授权别的请求。
   */
  const recordSampledCredential = (id, fingerprint, ticket, opSeq) => {
    if (typeof id !== 'string' || id.length === 0) return false
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) return false
    /**
     * [R9-01] **过时操作一律不写**：它既不能改指纹，也不能推进 epoch、
     * 清投影或授权票据。这一条挡住「旧凭据迟到把已提交的 B 清成 1」。
     */
    if (!isCurrentOp(id, opSeq)) return fingerprint === sampledCredentialOf(id) && liveSourceTicket(id, ticket)
    confirmOp(id, opSeq)
    const owned = ticket !== null && ticket !== undefined ? ticketOperations.get(ticket) : undefined
    if (owned !== undefined) owned.fingerprint = fingerprint
    const prev = sampledCredentials.get(id)
    if (prev === fingerprint) return true
    sampledCredentials.set(id, fingerprint)
    /**
     * [R6-01] **首次采样只登记，不失效。**
     *
     * 「从不知道到知道」不是来源变化：此时没有任何旧投影需要被新指纹否定，
     * 而这次采样本就属于**正在进行的那次采集**。上一版无条件清状态，
     * 把本次合法结果连同票据一起作废，界面于是变成「暂无数据」
     * （FAIL_COLD_GUI_SELF_INVALIDATES_TICKET）。
     *
     * 只有「已知 A → 已知 B」才是真的凭据轮换，必须完整撤销。
     */
    if (prev === undefined) return true
    /**
     * [R5-02] 凭据身份一变，必须**完整撤销**该来源的全部状态。
     *
     * 上一版只删了 `channelMeta`，而同步 context 还会独立读
     * `channelProjection` 与 `channelIdentity` —— 结果「元信息没了、旧的 B 数值还在」，
     * 视图照样能拿它收尾，甚至丢掉原采样时间
     * （FAIL_ALL_TOOL_KEY_ROTATION_STALE_PROJECTION）。
     *
     * 这里对齐 `syncActivation` 的完整清理路径：投影 / 元信息 / 身份 / 观察器记录
     * 全部清掉并推进 epoch，迟到的旧结果会被 commit 拒绝。
     * 保留原有的票据与 epoch 约束，**不**给迟到结果重签新票。
     */
    let nextEpoch = null
    try { nextEpoch = quotaObserver.bumpEpoch(id) } catch (err) { /* 观察器可能已清理 */ }
    /**
     * [R8-01] 只提升**本次采样自己那张**票，且它必须仍是该渠道当前的待提交票。
     *
     * - 有归属票（GUI 采集内部发现换 Key）→ 提升，本次合法结果可提交；
     * - 无归属票（工具 identify / 成功缓存命中）→ 什么都不提升，
     *   老的挂起请求仍持旧 epoch，返回时被拒（这正是 R8-01 的修复点）。
     */
    if (nextEpoch !== null) promoteOwnTicket(pendingTickets.get(id), ticket, nextEpoch)
    try { channelProjection.delete(id) } catch (err) { /* 同上 */ }
    try { channelMeta.delete(id) } catch (err) { /* 同上 */ }
    try { channelIdentity.delete(id) } catch (err) { /* 同上 */ }
    return true
  }

  const sampledCredentialOf = (id) => {
    const value = sampledCredentials.get(id)
    return typeof value === 'string' ? value : ''
  }
  const ownTicket = (id, ticket, seq) => {
    ticketOperations.set(ticket, { seq, fingerprint: sampledCredentialOf(id) })
    return ticket
  }
  // 同源 shared-flight 可由另一个消费者继续使用；不能仅因它又做了 identify 就杀掉任务。
  const liveSourceTicket = (id, ticket) => {
    if (ticket === null || ticket === undefined || typeof ticket !== 'object') return false
    const owned = ticketOperations.get(ticket)
    return owned !== undefined && typeof owned.seq === 'number'
      && ticket.id === id && ticket.epoch === quotaObserver.epochOf(id)
      && ticket.identity === identityOfChannel(id)
      && owned.fingerprint === sampledCredentialOf(id)
  }
  const operationMayProceed = (id, ticket, seq) => isCurrentOp(id, seq) || liveSourceTicket(id, ticket)

  // [R6-02] 账号选择指纹来自 `plans/workbuddy.js`（纯函数，可单测）——
  // 避免这里再写一份，两边规则漂移。
  const identityOfChannel = (id) => {
    const cfgNow = quotaCfg
    if (cfgNow === null || cfgNow === undefined) return ''
    try {
      const parts = [String(id)]
      const plan = PLANS.find((p) => p.id === id)
      if (plan !== undefined) {
        // 内置渠道：启用状态 + 该渠道自己的凭据指纹（不跨渠道共享）。
        parts.push('on=' + (cfgNow[plan.fields.enabled] === false ? '0' : '1'))
        if (typeof plan.fields.apiKey === 'string') {
          parts.push('key=' + secretFingerprint(cfgNow[plan.fields.apiKey]))
        }
        if (typeof plan.fields.cookie === 'string') {
          parts.push('cookie=' + secretFingerprint(cfgNow[plan.fields.cookie]))
        }
        /**
         * [R6-02] 内置 WorkBuddy 的**有效来源**必须进入观察身份。
         *
         * 它的 Key 不在 `plan.fields` 里，而是来自「设置 → 模型」的 provider 配置，
         * 所以上面那两行覆盖不到。结果：换账号选择、换模型主机/引用、甚至把该
         * provider 从模型配置里删掉，Host 观察身份都不变 → epoch 不推进 →
         * 继续用旧积分收尾。
         *
         * 这里纳入两项（都只做**不可逆摘要**，不把账号 uid 或 Key 明文外泄）：
         *   1. 真实有效模型来源（origin + baseURL + 引用名）；
         *   2. 规范化后的账号选择（排序后拼接，顺序无关）。
         *
         * 凭据指纹**不**放进身份：它在 begin 之后才采样到，放进来会让首次采集
         * 自废票据（与 R6-01 同一个坑）。凭据轮换改由
         * `recordSampledCredential()` 的「已知 A → 已知 B」分支撤销投影与在途票据。
         */
        if (id === 'workbuddy') {
          /**
           * [2026-10-25 客户端 Key 端点] 端点从管理员 `/status` 换成客户端 `/v1/credits`，
           * 并把**统计范围 cn** 显式写进身份。
           *
           * 不再拼 `acct=`：新端点没有稳定账号 ID，`workbuddyAccounts` 已不生效，
           * 若继续把它放进身份，等于向观察链暗示"仍在按账号筛选"。
           */
          const src = providerSourceFingerprint(ctx, 'workbuddy', GATEWAY_CREDITS_PATH)
          parts.push('src=' + src)
          parts.push('scope=' + 'cn')
        }
        /**
         * [2026-11-11 Codex 双来源] 选中来源 + **实际可用服务**的实例/修订摘要。
         *
         * 为什么必须进身份：codex 的两条来源读的是**完全不同的**第三方通道
         * （旧 Connect 公开 SDK / 新的只读 service）。切来源、来源被停用（服务消失）、
         * 服务被替换（重装/热重载）、订阅账号被切换（revision 前进）—— 这些都不改变
         * 上面的 `on=` 开关，若不进身份，epoch 不会推进，旧来源的采样会继续驱动
         * 胶囊与提示词（用户看到的「Connect 数值冒充 Subscription」）。
         *
         * 只拼**不可逆的本地摘要**（来源枚举 + `c<0|1|?>/s<实例序号@revision|0|?>`）：
         * 不含账号 ID、不含记录路径、不含令牌；序号来自本进程的 WeakMap，
         * 仅用于区分「还是不是同一个 service 对象」。
         */
        if (id === 'codex') {
          parts.push('csrc=' + codexSourceOf(cfgNow))
          parts.push('crt=' + codexRuntimeIdentityOf(ctx))
        }
      } else {
        /**
         * 自定义条目：该条目自己的公开身份 + **该条目的** secret 与公开修订号。
         *
         * [R3-01 §4.1] 只拼 URL/路径/币种/引用名**不够**：
         * 保存另一把 Key 后 URL 没变，身份却必须变，否则旧余额继续当缓存。
         * 但 Key 原文绝不进指纹之外的任何地方 —— 这里只用不可逆短哈希。
         */
        const entry = collectCustomEntries(cfgNow, { allowLegacy: legacyCustomAllowed() }).find((item) => item.id === id)
        if (entry !== undefined) knownCustomIds.add(id)
        if (entry === undefined) return parts.join('|') + '|gone=1'
        parts.push('on=' + (entry.enabled === false ? '0' : '1'))
        /**
         * [CP-04 残留] provider 与余额端点必须进入 Host 观察身份。
         *
         * 之前这里仍手拼旧字段（url/JSON 键/币种/旧引用），漏掉 `provider` 与
         * `balanceEndpoint`：换来源或改端点后，公共配置摘要变了、但 Host 观察身份不变，
         * epoch 不推进，于是旧额度继续驱动收尾。
         */
        parts.push('provider=' + (entry.provider || ''))
        parts.push('endpoint=' + (entry.balanceEndpoint || ''))
        /**
         * [P1-2 第三次] 同一 provider 的**真实来源**（baseURL / 引用）变化也必须换身份。
         *
         * 审核复现 FAIL_EFFECTIVE_MODEL_SOURCE_CHANGE_RETAINS_OLD_QUOTA：
         * 条目里的 provider 与端点都没变，只把模型配置里该 provider 的 baseURL
         * 改成另一台主机、引用改成另一个 Key —— 设置页已读到新地址，
         * Host 却仍用旧额度收尾。
         *
         * 只比较条目里的 provider 字符串（第 328 行）显然不够：
         * 它不是"当前生效的模型来源"。这里把来源解析结果（origin + 引用名）
         * 也纳入身份，来源一变身份即变，epoch 推进、旧观察作废。
         */
        if (entry.provider.length > 0) {
          const src = providerSourceFingerprint(ctx, entry.provider, entry.balanceEndpoint)
          parts.push('src=' + src)
          /**
           * [R4-01] **把工具/取数已确认的凭据身份纳入 Host 观察身份。**
           *
           * 上一版只纳入「主机 + 引用名」，审核继续复现：同一引用下的 Key 值轮换
           * （引用名不变、实际 Key 变了）时身份不变，第三次工具已采到 A，
           * context 仍按 B 收尾。
           *
           * `sampledCredential` 是 identify/取数层**实际解析到**的凭据指纹 ——
           * 这是本次请求已经知道的事实，不是"现场再解密一次"。
           * 有它就用它；没有（比如纯 GUI 路径尚未采样）则退回静态来源指纹，
           * 绝不因为"暂时不知道"就把旧来源当成当前来源。
           */
          /**
           * [R6-01] 凭据指纹**不再进入观察身份**。
           *
           * 原因：身份是在 `quotaObserver.begin()` 时固化进票据的，而凭据要在取数时才解析。
           * 首次采样必然把 `cred=unsampled` 改成 `cred=<fp>`，于是**本次合法结果
           * 被自己的身份变更拒绝**（审核 FAIL_COLD_GUI_SELF_INVALIDATES_TICKET），
           * 记录还会落在旧身份槽位里，界面变成「暂无数据」。
           *
           * 现在凭据轮换改由 `recordSampledCredential()` 的「显式失效」处理：
           * 指纹**变化**时清投影/元信息/推进 epoch；首次采样只登记、不清任何东西。
           * 观察身份只表达「配置来源」这一层，因此整个采集周期内稳定。
           */
          void sampledCredentialOf
        }
        parts.push('url=' + entryPublicFingerprint(entry.url + '|' + entry.balancePath
          + '|' + (entry.subtractPath || '') + '|' + (entry.currency || '')
          + '|' + (entry.credentialRef || '') + '|' + (entry.credentialHost || '')))
        // 该条目自己的 Key（customKeys 字典里按 id 存放）。
        const keys = cfgNow.customKeys
        const ownKey = keys !== null && keys !== undefined && typeof keys === 'object'
          ? keys[id]
          : undefined
        parts.push('k=' + secretFingerprint(ownKey))
        // 非密公开修订号：保存动作（含幂等写入）都会 +1。
        parts.push('rev=' + String(keyRevOf(cfgNow.customKeyRev, id)))
      }
      return entryPublicFingerprint(parts.join('|'))
    } catch (err) {
      /**
       * [R3-01] 身份计算失败**绝不能**返回一个「看起来有效」的空身份。
       *
       * 空字符串会被所有采集共享，等于「所有账户都是同一个身份」——
       * 旧账户的余额会继续被当作当前账户的缓存来驱动收尾。
       * 这里返回 `null` 表示「无法证明身份」，调用方据此**拒绝沿用缓存**。
       */
      return null
    }
  }

  /**
   * 只对 secret 取**不可逆短指纹**：不进日志、不进响应、不进提示词。
   *
   * 空值单独成标记（`empty`），这样「从无到有」「从有到无」都能区分。
   */
  const secretFingerprint = (value) => {
    if (typeof value !== 'string' || value.length === 0) return 'empty'
    return createHash('sha256').update(value).digest('hex').slice(0, 12)
  }

  /** 公开字段的指纹（不含 secret 原文）。 */
  const entryPublicFingerprint = (text) => createHash('sha256')
    .update(String(text === undefined ? '' : text)).digest('hex').slice(0, 16)

  /**
   * [A01][A02][A03][A10] 发布一次采集观察。
   *
   * 由**既有**取数路径调用（GUI 路由 / 工具 collect），不额外访问供应商。
   *
   * @param {object} wire provider 返回的原始 wire
   * @param {object} [ticket] 采集开始票据（缺省则临时登记，保证去重仍然生效）
   * @param {number} [sampledAt] 真实采样时间
   */
  const publishObservation = (wire, ticket, sampledAt) => {
    if (wire === null || wire === undefined || typeof wire !== 'object') return
    const id = wire.id
    if (typeof id !== 'string') return

    // [A10] 同一个 wire 实例只提交一次（GUI 的逐条回传与整批回传共用同一实例）。
    if (publishedWires.has(wire)) return
    publishedWires.add(wire)

    let useTicket = ticket !== null && ticket !== undefined && typeof ticket.seq === 'number'
      ? ticket
      : wireTickets.get(wire)
    // 无归属、旧激活代次的结果不能在完成时补票；重复回传只复用原票。
    if (!liveSourceTicket(id, useTicket)) return
    wireTickets.set(wire, useTicket)

    /**
     * [R3-01 §4.2] 提交前校验票据身份**仍是当前身份**。
     *
     * observer 按「id + 身份」分别存储，所以旧身份的票据在它自己的槽位里
     * 永远"合法"。若不校验，旧请求完成时仍会改写 `channelProjection` /
     * `channelMeta` 这两个**按 id 索引**的共享映射，把新身份的有效快照遮掉。
     */
    const currentIdentity = identityOfChannel(id)
    if (currentIdentity === null || useTicket.identity !== currentIdentity) return

    const errorCode = typeof wire.error === 'string' ? wire.error : null
    let projected = null
    if (errorCode === null) {
      try {
        const usage = projectUsage([wire], [id], {
          enabled: [id], known: [id], semanticsOf: percentSemanticsOf,
        })
        projected = usage.channels.length > 0 ? usage.channels[0] : null
      } catch (err) {
        // 投影失败**不能**静默变成「成功但空数据」：按结构错误处理，走可见的失败状态。
        projected = null
      }
    }

    const identity = useTicket.identity
    const record = quotaObserver.commit(useTicket, {
      channel: projected,
      errorCode,
      hint: {
        transient: wire.transient === true,
        // [A08] 把 provider 的结构化语义带进分类：这些字段不进入模型文本。
        credentialState: typeof wire.credentialState === 'string' ? wire.credentialState : undefined,
        authKind: typeof wire.authKind === 'string' ? wire.authKind : undefined,
        httpStatus: typeof wire.httpStatus === 'number' ? wire.httpStatus : undefined,
      },
      sampledAt: typeof sampledAt === 'number' ? sampledAt : wire.fetchedAt,
    })
    // 迟到票据 / 被更新采集超越：**不覆盖**当前状态。
    if (record === null) return
    confirmOp(id, ticketOperations.get(useTicket).seq)

    if (record.channel !== null) channelProjection.set(id, record.channel)
    else channelProjection.delete(id)
    channelIdentity.set(id, identity)
    // [R2-04] 来源证明必须**跟着数值走**，不能被一次没有 via 的错误 wire 抹掉。
    //
    // 否则会出现：api 路由下先拿到 account 余额（正确拒绝）→ 下一次暂时性网络错误
    // 没有 via → 来源变成 undefined → 视图跳过校验 → **错误来源的余额被接受并驱动收尾**。
    //
    // 规则：
    //   - 成功采集：记录本次的来源；
    //   - 暂时失败（沿用缓存）：**继承**上次成功的来源；
    //   - 明确失效（P/A）：来源随数值一起清空（此时本就没有可用数值）。
    const previousMeta = channelMeta.get(id)
    let source
    if (record.status === 'ok') source = typeof wire.via === 'string' ? wire.via : undefined
    else if (record.status === 'cached') {
      source = previousMeta !== undefined && previousMeta.source !== undefined
        ? previousMeta.source
        : (typeof wire.via === 'string' ? wire.via : undefined)
    } else source = undefined
    channelMeta.set(id, {
      status: record.status,
      identity: record.identity,
      sampledAt: record.sampledAt,
      failCount: record.failCount,
      source,
      // 已有观察的公开 wire 镜像，不新增采集/TTL缓存；保留同一来源的 gen 与采样时间。
      wire: record.status === 'ok'
        ? Object.assign({}, wire, { fetchedAt: record.sampledAt })
        : (record.status === 'cached' && previousMeta !== undefined ? previousMeta.wire : undefined),
    })
    acceptedWires.add(wire)
  }

  const guiObservationWire = (wire) => {
    if (wire === null || typeof wire !== 'object' || wire.enabled === false || acceptedWires.has(wire)) return wire
    const meta = channelMeta.get(wire.id)
    if (meta !== undefined && meta.identity === identityOfChannel(wire.id)
      && (meta.status === 'ok' || meta.status === 'cached') && meta.wire !== undefined) {
      // 整份采用当前有效观察，不能把 B 的数值拼进 A 的 gen / 时间戳。
      return Object.assign({}, meta.wire, { balanceFromCache: true, staleSampledAt: meta.sampledAt })
    }
    const revoked = {
      id: wire.id, name: wire.name, custom: wire.custom, gen: wire.gen, currency: wire.currency,
      error: 'cancelled', cancelled: true, transient: false, stale: true,
      message: '本次采集已作废，等待最新额度',
      effectiveStatus: meta !== undefined ? meta.status : 'pending',
      failCount: meta !== undefined ? meta.failCount : 0,
    }
    /**
     * [终审 N2 整改] 作废行必须**保留来源身份**。
     *
     * 客户端渲染层会滤掉「wire 来源 ≠ 已保存来源」的行；这条行若不带 `codexSource`，
     * 订阅态下它会被当成另一来源的结果而**整行消失**（用户看不到「本次采集已作废」）。
     * 只从源 wire 上已有的 `codexSource` 取值，且必须落在来源闭集里 —— 不在别的渠道
     * 上凭空造这个字段，也不写 `undefined`（那会污染闭集判断）。
     */
    const revokedRawSource = typeof wire.codexSource === 'string' ? wire.codexSource.trim().toLowerCase() : ''
    if (revokedRawSource === CODEX_SOURCE_CONNECT || revokedRawSource === CODEX_SOURCE_SUBSCRIPTION) {
      revoked.codexSource = normalizeCodexSource(revokedRawSource)
    }
    revokedResponses.add(revoked)
    return revoked
  }

  /**
   * [A04] 把 Host 的统一状态附到 GUI 响应条目上。
   *
   * GUI 与模型共用同一份 `status` / `failCount`，客户端只做展示与灰化，
   * **不再自己累加失败次数**（否则两端会各数一套）。
   */
  const attachEffectiveStatus = (plans) => {
    if (!Array.isArray(plans)) return
    for (const wire of plans) {
      if (wire === null || wire === undefined || typeof wire !== 'object' || revokedResponses.has(wire)) continue
      const meta = channelMeta.get(wire.id)
      /**
       * [R4 防御项] C（取消）等「不提交」的 wire 不该被当成一次新结果展示。
       *
       * 这类 wire 到达时 `channelMeta` 仍是上一次成功值，但 wire 自身是错误态：
       * 若直接透传，客户端会看到一次「失败」，而模型那边（观察未变）仍是成功 —— 两端不一致。
       * 这里用 Host 的有效值把它改写成与模型同源的结论。
       */
      if (meta !== undefined && (meta.status === 'ok' || meta.status === 'cached')) {
        const hasErr = typeof wire.error === 'string' && wire.error.length > 0
        if (hasErr) {
          const effective = channelProjection.get(wire.id)
          if (effective !== null && effective !== undefined) {
            // 用有效投影覆盖错误态（保留原始 wire 的其它字段，如峰值相位）。
            delete wire.error
            delete wire.message
            if (effective.balance !== undefined) wire.balance = effective.balance
            if (effective.currency !== undefined) wire.currency = effective.currency
            if (effective.unit !== undefined) wire.unit = effective.unit
            if (effective.windows !== undefined) wire.windows = effective.windows
            // 积分类渠道：模型投影把它放在 `balance`，GUI 原生字段是 `creditsTotal`。
            if (effective.unit === 'credits' && typeof effective.balance === 'number') {
              wire.creditsTotal = effective.balance
            }
            wire.balanceFromCache = meta.status === 'cached'
          }
        }
      }
      if (meta === undefined) continue
      wire.effectiveStatus = meta.status
      wire.failCount = meta.failCount
      if (meta.status === 'failed' || meta.status === 'expired') {
        // 达到判据后不再携带旧数值（与模型侧一致）。
        // 用 `delete` 而不是置 null：原 wire 本来就**不带**这些字段时，
        // 凭空加一个 null 会让「不伪造余额」的既有断言失效。
        delete wire.balance
        delete wire.windows
        delete wire.creditsTotal
      } else if (meta.status === 'cached') {
        /**
         * [R2-05] `cached` 必须把**Host 的有效缓存值**一起交出去。
         *
         * 之前只给「cached」标签，客户端只能读自己的 `lastList`：
         * 新开窗口（无本地基线）会直接显示错误，旧窗口会继续用它**自己的**更旧数值 ——
         * 两端结论不一致，也可能与模型拿到的缓存值不同。
         *
         * 这里用同一份观察里的投影补齐缺字段（不覆盖 wire 自己已有的值）。
         */
        const cachedChannel = channelProjection.get(wire.id)
        if (cachedChannel !== null && cachedChannel !== undefined) {
          if (wire.balance === undefined && typeof cachedChannel.balance === 'number') {
            wire.balance = cachedChannel.balance
            wire.balanceFromCache = true
          }
          if (wire.currency === undefined && typeof cachedChannel.currency === 'string') {
            wire.currency = cachedChannel.currency
          }
          if (wire.unit === undefined && typeof cachedChannel.unit === 'string') {
            wire.unit = cachedChannel.unit
          }
          if ((wire.windows === undefined || wire.windows.length === 0)
            && Array.isArray(cachedChannel.windows) && cachedChannel.windows.length > 0) {
            wire.windows = cachedChannel.windows
            wire.balanceFromCache = true
          }
          // 积分类渠道（WorkBuddy）：数值经 creditsTotal 走 wire，这里补回。
          if (wire.creditsTotal === undefined && typeof cachedChannel.balance === 'number'
            && cachedChannel.unit === 'credits') {
            wire.creditsTotal = cachedChannel.balance
            wire.balanceFromCache = true
          }
        }
        if (typeof meta.sampledAt === 'number') wire.staleSampledAt = meta.sampledAt
      }
    }
  }

  /**
   * [A02][R2-02][R4-01] 配置变化时作废**受影响**渠道的旧观察与在途票据。
   *
   * 关键点：
   *   - 遍历**全部**已知渠道（不只是有观察的那些）：渠道被停用/删除后，
   *     `channelMeta` 里可能已经没有它的条目，但仍需推进 epoch，
   *     否则该渠道重新启用时，旧在途请求还能复活。
   *   - 反向也要覆盖：`epochs` 里有的、但当前配置已删除的自定义条目。
   *   - 未改动的渠道保留基线与失败计数（不能整表清空）。
   */
  /**
   * [R5-01] 已见激活状态：`id → { identity, monitorOn }`。
   *
   * **独立于** `channelMeta`（数据观察）。这一点是第五轮 P1 的核心：
   * 之前只从 `channelMeta` 推断「身份变没变」，于是
   *   - 冷启动第一笔查询还没结局（没有 channelMeta）→ 回切/停启不推进 epoch → 旧结果复活；
   *   - 全局监控开关变化不被视为激活变化。
   *
   * 现在把**激活状态**与**数据观察**分开登记：只要见过一次该渠道的激活状态，
   * 后续任何变化都会推进 epoch，与是否已有数据无关。
   */
  const seenActivation = new Map()

  /** 读取当前全局监控开关（`enabled` 是数据监控总开关，不是策略注入开关）。 */
  const monitorOnOf = () => !(quotaCfg !== null && quotaCfg !== undefined && quotaCfg.enabled === false)

  /**
   * [R5-01] 同步一个渠道的激活状态。
   *
   * 规则：
   *   - 首次见到（无记录）→ 只登记，**不**推进 epoch（避免冷启动时互相取消）；
   *   - 已登记且身份或监控状态**确实变化** → 推进 epoch 并清掉该渠道的数据观察；
   *   - 未变化 → 什么都不做（同身份并发不会被误取消）。
   *
   * @returns {boolean} 是否发生了失效
   */
  const syncActivation = (id) => {
    const identity = identityOfChannel(id)
    const monitorOn = monitorOnOf()
    const prev = seenActivation.get(id)

    // 身份无法证明：撤销该渠道的全部可用状态并推进 epoch。
    if (identity === null) {
      if (prev !== undefined) {
        quotaObserver.bumpEpoch(id)
        seenActivation.set(id, { identity: null, monitorOn })
      }
      channelProjection.delete(id)
      channelMeta.delete(id)
      channelIdentity.delete(id)
      return true
    }

    // 首次见到：只登记，不推进（否则冷启动的并发请求会互相作废）。
    if (prev === undefined) {
      seenActivation.set(id, { identity, monitorOn })
      return false
    }
    if (prev.identity === identity && prev.monitorOn === monitorOn) return false

    // 激活状态确实变了：推进 epoch + 撤掉数据观察。
    quotaObserver.bumpEpoch(id)
    seenActivation.set(id, { identity, monitorOn })
    channelProjection.delete(id)
    channelMeta.delete(id)
    channelIdentity.delete(id)
    return true
  }

  /**
   * [R2-02][R4-01][R5-01] 配置变化时同步全部渠道的激活状态。
   *
   * 遍历**全部**已知渠道（不只已有观察的）：监控开关、停用、删除都走同一条路径。
   * 未改动的渠道不会被动到（`syncActivation` 内部比对后才推进）。
   */
  const reconcileIdentities = () => {
    const allIds = new Set()
    for (const id of channelMeta.keys()) allIds.add(id)
    for (const id of channelIdentity.keys()) allIds.add(id)
    for (const id of seenActivation.keys()) allIds.add(id)
    for (const plan of PLANS) allIds.add(plan.id)
    for (const entry of collectCustomEntries(quotaCfg !== null && quotaCfg !== undefined ? quotaCfg : {})) {
      allIds.add(entry.id)
    }
    // 已推进过 epoch 但已从配置消失的自定义条目（删除场景）。
    for (const id of knownCustomIds) allIds.add(id)

    for (const id of allIds) syncActivation(id)
  }

  /** 重读策略配置（context 是同步回调，只能读缓存）。 */
  const refreshQuotaCfg = async () => {
    try {
      quotaCfg = unpackConfig(await liveConfig())
      reconcileIdentities()
    } catch (err) { /* 保持上一份 */ }
  }
  void refreshQuotaCfg()

  // ---- [dsh-go] 策略快照的后台刷新 ----
  /**
   * 额度策略的提示词快照读的是「观察容器」里的额度投影，而投影平时只由
   * Web GUI 的 30 秒轮询或 `usage_status` 工具调用填充。手机原生端没有网页轮询，
   * 模型也很少主动调工具，于是策略一直显示「暂无额度数据」。
   *
   * 这里补一个轻量后台刷新：只在「原生桥接存在 + 额度策略开启」时，每 60 秒
   * 只取**关注渠道**（配置里 quotaFocusChannels ∩ 已启用），走与 GUI 相同的
   * 签票 → 取数 → 发布观察路径；不新增任何对外接口，也不额外访问非关注渠道。
   */
  let policyRefreshTimer = null
  let policyRefreshRunning = false
  let policyRefreshStopped = false
  const policyRefreshStop = () => {
    policyRefreshStopped = true
    if (policyRefreshTimer !== null) {
      try { clearInterval(policyRefreshTimer) } catch (err) { /* 已清理 */ }
      policyRefreshTimer = null
    }
  }
  const policyRefreshTick = async () => {
    if (applyDisposed || policyRefreshStopped || policyRefreshRunning || dshGoBridgeSeen !== true) return
    policyRefreshRunning = true
    try {
      const cfgNow = unpackConfig(await liveConfig())
      // [终审 D] 异步读配置前后都要复检存活 / 桥接 / 开关，避免卸载后仍打 provider。
      if (applyDisposed || policyRefreshStopped || dshGoBridgeSeen !== true) return
      quotaCfg = cfgNow
      if (cfgNow === null || typeof cfgNow !== 'object' || cfgNow.enabled === false || cfgNow.quotaPolicyEnabled !== true) return
      let focus = []
      try { focus = parseFocusChannels(cfgNow.quotaFocusChannels) } catch (err) { focus = [] }
      const wanted = new Set(Array.isArray(focus) ? focus : [])
      const plans = PLANS.filter((plan) => wanted.has(plan.id) && cfgNow[plan.fields.enabled] !== false)
      if (plans.length === 0) return
      try { reconcileIdentities() } catch (err) { /* 身份重算失败不影响取数 */ }
      let shell
      try { shell = ctx.get('shell') } catch (err) { shell = undefined }
      await Promise.all(plans.map(async (plan) => {
        if (applyDisposed || policyRefreshStopped || dshGoBridgeSeen !== true) return
        let ticket = null
        try {
          const opSeq = beginOp(plan.id)
          ticket = quotaObserver.begin({ id: plan.id, identity: identityOfChannel(plan.id) })
          ownTicket(plan.id, ticket, opSeq)
          pendingTickets.set(plan.id, ticket)
          const wire = await (plan.id === 'mimo'
            ? mimoWireWithDisplay(mimoDisplaySource, () => plan.fetch(ctx, shell, cfgNow))
            : plan.fetch(ctx, shell, cfgNow))
          // provider 返回后再复检：卸载 / 桥退出 / 配置停用的迟到结果不得再发布。
          if (applyDisposed || policyRefreshStopped || dshGoBridgeSeen !== true) return
          publishObservation(wire, ticket)
        } catch (err) {
          if (applyDisposed || policyRefreshStopped || dshGoBridgeSeen !== true) return
          try { publishObservation(withConfiguredCodexSource(execError(plan), cfgNow), ticket) } catch (err2) { /* 观察失败不影响其它渠道 */ }
        }
      }))
    } catch (err) {
      /* 后台刷新失败不打扰用户：下一轮会再试 */
    } finally {
      policyRefreshRunning = false
    }
  }
  const startPolicyRefreshLoop = () => {
    if (applyDisposed || policyRefreshTimer !== null || policyRefreshStopped) return
    policyRefreshTick()
    policyRefreshTimer = setInterval(() => { policyRefreshTick() }, 60_000)
    if (policyRefreshTimer !== null && typeof policyRefreshTimer.unref === 'function') policyRefreshTimer.unref()
  }
  /**
   * [终审 D] 刷新循环的生命周期**无条件**绑定插件作用域（不依赖 usage_status 注册成功）：
   * 即使宿主没有 tools 服务、注册分支提前返回，卸载时也必须清掉 60 秒 interval。
   */
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        applyDisposed = true
        dshGoBridgeSeen = false
        policyRefreshStop()
        // 原生面板 / strip 订阅也跟随插件作用域回收（含它们各自的 interval）。
        try {
          if (dshGoSurface !== null && dshGoSurface !== undefined && typeof dshGoSurface.dispose === 'function') {
            dshGoSurface.dispose()
          }
        } catch (err) { /* 已卸载 */ }
      })
    }
  } catch (err) { /* 旧宿主没有 effect：退化为桥接 ticking 自检 */ }
  /**
   * [终审 D] 桥接作用域就是刷新循环的生命周期来源：桥退出（服务消失 / 宿主重载）时
   * 撤销桥接状态并停止循环；桥重新出现时 onBridge 会再次启动。
   */
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['dshGo'], (bridgeCtx) => {
        dshGoBridgeSeen = true
        Promise.resolve().then(() => {
          if (applyDisposed) return
          policyRefreshStopped = false
          startPolicyRefreshLoop()
        }).catch(() => {})
        try {
          if (bridgeCtx !== null && bridgeCtx !== undefined && typeof bridgeCtx.effect === 'function') {
            bridgeCtx.effect(() => () => {
              dshGoBridgeSeen = false
              policyRefreshStop()
            })
          }
        } catch (err) { /* 旧宿主 */ }
        return () => {
          dshGoBridgeSeen = false
          policyRefreshStop()
        }
      })
    }
  } catch (err) { /* 旧宿主没有 inject */ }

  // ---- [dsh-go] composer.strip：当前会话渠道的一行摘要 ----
  /**
   * 会话 → 最近一次实际/选择的路由。只跟踪主会话；事件由 `session/event` 增量更新，
   * strip 首次订阅时用 `snapshotEvents()` 回填一次。
   */
  const sessionRoute = new Map()
  const sessionRouteSubs = new Map()
  const sessionBackfilled = new Set()
  const stripSubs = new Set()
  const stripCache = new Map()
  const stripInflight = new Map()
  const STRIP_ID = 'strip'
  const STRIP_FRESH_MS = 30_000
  const notifyStripSubs = () => {
    for (const fn of stripSubs) {
      try { fn() } catch (err) { /* 单个订阅失败不影响其它 */ }
    }
  }
  const notifySessionRoute = (sessionId) => {
    const subs = sessionRouteSubs.get(sessionId)
    if (subs === undefined) return
    for (const fn of subs) {
      try { fn() } catch (err) { /* 同上 */ }
    }
  }
  const applyRouteEventForSession = (sessionId, event) => {
    if (applySessionRouteEvent(sessionRoute, sessionId, event)) notifySessionRoute(sessionId)
  }
  /** 从 sessions 服务读「当前会话实际/最近一次请求的路由」（事件没收到时的兜底）。 */
  const routeFromSessionService = (sessionId) => {
    let session = null
    try {
      const sessions = ctx.get('sessions')
      session = sessions !== null && sessions !== undefined && typeof sessions.get === 'function'
        ? sessions.get(sessionId)
        : null
    } catch (err) { session = null }
    if (session === null || session === undefined) {
            return null
    }
    try {
      if (typeof session.requestContext === 'function') {
        const info = session.requestContext()
        if (info !== null && info !== undefined && typeof info.provider === 'string' && info.provider.length > 0) {
                    return { provider: info.provider, model: typeof info.model === 'string' ? info.model : '', source: 'request/context' }
        }
      }
      if (typeof session.requestHeader === 'function') {
        const header = session.requestHeader()
        const config = header !== null && header !== undefined && header.config !== null && typeof header.config === 'object' ? header.config : null
        if (config !== null && typeof config.provider === 'string' && config.provider.length > 0) {
                    return { provider: config.provider, model: typeof config.model === 'string' ? config.model : '', source: 'request/header' }
        }
      }
      if (typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents()
        if (Array.isArray(events)) {
          let found = null
          for (let index = Math.max(0, events.length - 400); index < events.length; index += 1) {
            const route = routeFromEventLite(events[index])
            if (route !== null) found = route
          }
          if (found !== null) {
                        return { provider: found.provider, model: found.model, source: 'snapshot' }
          }
        }
      }
          } catch (err) {
          }
    return null
  }
  /** 轻量事件解析（避免额外 import；与 plans/strip.js 的规则一致）。 */
  const routeFromEventLite = (event) => {
    if (event === null || event === undefined || typeof event !== 'object') return null
    const data = event.data !== null && typeof event.data === 'object' ? event.data : null
    if (data === null) return null
    if (event.type === 'model/selection' && typeof data.provider === 'string' && data.provider.length > 0) return { provider: data.provider, model: typeof data.model === 'string' ? data.model : '' }
    if (event.type === 'request/header') {
      const config = data.header !== null && typeof data.header === 'object' && data.header.config !== null && typeof data.header.config === 'object' ? data.header.config : null
      if (config !== null && typeof config.provider === 'string' && config.provider.length > 0) return { provider: config.provider, model: typeof config.model === 'string' ? config.model : '' }
    }
    if (event.type === 'assistant/message') {
      const message = data.message !== null && typeof data.message === 'object' ? data.message : null
      const source = message !== null && message.source !== null && typeof message.source === 'object' ? message.source : null
      if (source !== null && typeof source.provider === 'string' && source.provider.length > 0) return { provider: source.provider, model: typeof source.model === 'string' ? source.model : '' }
    }
    return null
  }
  const backfillSessionRoute = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionBackfilled.has(sessionId)) return
    sessionBackfilled.add(sessionId)
    try {
      const sessions = ctx.get('sessions')
      const session = sessions !== null && sessions !== undefined && typeof sessions.get === 'function'
        ? sessions.get(sessionId)
        : undefined
      const events = session !== null && session !== undefined && typeof session.snapshotEvents === 'function'
        ? session.snapshotEvents()
        : null
      if (!Array.isArray(events)) return
      const start = Math.max(0, events.length - 400)
      for (let index = start; index < events.length; index += 1) {
        applySessionRouteEvent(sessionRoute, sessionId, events[index])
      }
    } catch (err) { /* 会话未加载/旧宿主：等下一次事件 */ }
    if (!sessionRoute.has(sessionId)) {
      const route = routeFromSessionService(sessionId)
      if (route !== null) sessionRoute.set(sessionId, route)
    }
  }
  const customEntriesForStrip = (cfgNow) => {
    try {
      return collectCustomEntries(cfgNow !== null && typeof cfgNow === 'object' ? cfgNow : {}, { allowLegacy: legacyCustomAllowed() })
    } catch (err) {
      return []
    }
  }
  const channelForRoute = (route, cfgNow) => {
    if (route === null || typeof route !== 'object' || typeof route.provider !== 'string') return null
    return providerToChannel(route.provider, {
      resolveRoute,
      customEntries: customEntriesForStrip(cfgNow),
    })
  }
  /**
   * [终审 B/C] strip 数据的配置代次与同步遮蔽：
   *   - `stripEpoch` 让配置变化后所有在途结果作废（不写缓存、不发布观察）；
   *   - `stripConfigPending` 在配置重读完成前同步隐藏 strip，避免停用后旧值闪回。
   */
  let stripEpoch = 0
  let stripConfigPending = false
  const invalidateStripCaches = () => {
    stripEpoch += 1
    stripCache.clear()
  }
  const markStripConfigDirty = () => {
    stripConfigPending = true
    invalidateStripCaches()
  }
  /**
   * [终审 B｜strip 启用闸门] 全局开关 + 该渠道开关（自定义条目看自身 enabled）。
   * 停用时必须在**读缓存/投影之前**返回 false，不能先展示旧值再取消。
   */
  const stripChannelAllowed = (channel, cfgNow) => {
    if (channel === null || typeof channel !== 'object') return false
    const live = cfgNow !== null && cfgNow !== undefined && typeof cfgNow === 'object' ? cfgNow : {}
    if (cfgValue(live, 'enabled') === false) return false
    const id = channel.channelId
    if (typeof id !== 'string' || id.length === 0) return false
    if (channel.custom === true) {
      const entry = collectCustomEntries(live, { allowLegacy: legacyCustomAllowed() }).find((item) => item.id === id)
      return entry !== undefined && entry !== null && entry.enabled !== false
    }
    const plan = PLANS.find((item) => item.id === id)
    if (plan === undefined) return false
    return cfgValue(live, plan.fields.enabled) !== false
  }
  /**
   * [终审 C] strip 缓存/在途按「渠道 + 来源身份」隔离：
   * Codex 来源（connect / subscription）、自定义条目的 provider/URL/Key 修订都会改变身份，
   * 新来源不得复用旧来源的百分比。
   */
  const stripChannelKey = (channel) => {
    const id = channel !== null && typeof channel === 'object' ? channel.channelId : null
    if (typeof id !== 'string' || id.length === 0) return null
    let identity = null
    try { identity = identityOfChannel(id) } catch (err) { identity = null }
    return id + '|' + (typeof identity === 'string' && identity.length > 0 ? identity : 'unknown')
  }
  const invalidateStripChannel = (channel) => {
    const key = stripChannelKey(channel)
    if (key === null) return
    stripCache.delete(key)
    // 在途任务由 stripEpoch 与身份键守卫，结果不会写回缓存/不会发布。
  }
  /** 取一次单渠道数据（strip 专用缓存 + single-flight，按来源身份隔离，30 秒内复用）。 */
  const ensureStripChannel = (channel) => {
    const id = channel !== null && typeof channel === 'object' ? channel.channelId : null
    if (typeof id !== 'string' || id.length === 0) return Promise.resolve()
    // [终审 B] 触发取数前先过闸门（定时器/缓存缺失路径也要拦住）。
    if (!stripChannelAllowed(channel, quotaCfg)) {
      invalidateStripChannel(channel)
      return Promise.resolve()
    }
    const key = stripChannelKey(channel)
    if (key === null) return Promise.resolve()
    const cached = stripCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < STRIP_FRESH_MS) return Promise.resolve()
    if (stripInflight.has(key)) return stripInflight.get(key)
    const epoch = stripEpoch
    const task = Promise.resolve().then(async () => {
      let wire = null
      let cfgNow = null
      let stripTicket = null
      try {
        cfgNow = unpackConfig(await liveConfig())
        if (epoch !== stripEpoch) return
        quotaCfg = cfgNow
        // [终审 B] 真正调用 provider 之前**再**检查一次（配置可能在等待期间被停用）。
        if (!stripChannelAllowed(channel, cfgNow)) {
          invalidateStripChannel(channel)
          return
        }
        if (channel.custom === true) {
          const wires = await fetchCustomPlans(ctx, [id], cfgNow, { allowLegacy: legacyCustomAllowed() })
          wire = Array.isArray(wires) && wires.length > 0 ? wires[0] : null
        } else {
          const plan = PLANS.find((item) => item.id === id)
          if (plan !== undefined) {
            let shell
            try { shell = ctx.get('shell') } catch (err) { shell = undefined }
            const opSeq = beginOp(id)
            const ticket = quotaObserver.begin({ id, identity: identityOfChannel(id) })
            ownTicket(id, ticket, opSeq)
            pendingTickets.set(id, ticket)
            stripTicket = ticket
            try {
              wire = await (id === 'mimo'
                ? mimoWireWithDisplay(mimoDisplaySource, () => plan.fetch(ctx, shell, cfgNow))
                : plan.fetch(ctx, shell, cfgNow))
            } catch (err) {
              wire = withConfiguredCodexSource(execError(plan), cfgNow)
            }
          }
        }
      } catch (err) {
        wire = null
      }
      // [终审 B] provider 返回后配置可能已停用/变化：不写缓存、不显示、不发布观察。
      if (epoch !== stripEpoch) return
      let gateCfg = cfgNow
      try { gateCfg = unpackConfig(await liveConfig()) } catch (err) { gateCfg = cfgNow }
      if (epoch !== stripEpoch || !stripChannelAllowed(channel, gateCfg)) {
        invalidateStripChannel(channel)
        return
      }
      if (stripTicket !== null) {
        try { publishObservation(wire, stripTicket) } catch (err) { /* 观察失败不影响 strip */ }
      }
      let projected = null
      if (wire !== null && wire !== undefined) {
        try {
          const usage = projectUsage([wire], [id], {
            enabled: [id], known: [id], semanticsOf: percentSemanticsOf,
          })
          projected = usage.channels.length > 0 ? usage.channels[0] : null
        } catch (err) { projected = null }
      }
      const previous = stripCache.get(key)
      const usable = projected !== null && projected.availability !== 'error' && projected.availability !== 'unknown'
      /**
       * [终审 C] `transient !== true` 的失败是**永久失败**：不得 carry 旧 good 值，
       * 交给上层 emit(null) 隐藏；只有同一身份下的暂时失败才保留旧值并标 stale。
       */
      const permanentFailure = projected !== null && projected.availability === 'error' && projected.transient !== true
      const previousGood = previous !== undefined && previous.good !== null && previous.good !== undefined
        ? previous.good
        : null
      const carried = previousGood === null || permanentFailure
        ? null
        : Object.assign({}, previousGood, { stale: true, transient: true })
      stripCache.set(key, {
        at: Date.now(),
        wire,
        projected,
        good: usable ? projected : carried,
      })
      notifyStripSubs()
    }).catch(() => {}).finally(() => {
      if (stripInflight.get(key) === task) stripInflight.delete(key)
    })
    stripInflight.set(key, task)
    return task
  }
  /** 计算某会话当前应展示的 strip 载荷；数据缺失时顺便触发一次取数。 */
  const stripPayloadFor = (scope, locale) => {
    const sessionId = scope !== null && scope !== undefined ? scope.sessionId : undefined
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    // [终审 B] 配置重载窗口内同步遮蔽：刷新完成前不显示旧值（停用后不得闪回）。
    if (stripConfigPending) return null
    backfillSessionRoute(sessionId)
    let route = sessionRoute.get(sessionId)
    if (route === undefined) {
      const fallback = routeFromSessionService(sessionId)
      if (fallback === null) return null
      route = fallback
      sessionRoute.set(sessionId, fallback)
    }
    const cfgNow = quotaCfg !== null && typeof quotaCfg === 'object' ? quotaCfg : {}
    // [终审 B] 全局开关关闭 ⇒ 立即作废所有 strip 缓存并隐藏。
    if (cfgValue(cfgNow, 'enabled') === false) {
      invalidateStripCaches()
      return null
    }
    const channel = channelForRoute(route, cfgNow)
    if (channel === null) return null
    // [终审 B] 该渠道停用 ⇒ 清掉该渠道缓存并立即隐藏，绝不先展示旧值。
    if (!stripChannelAllowed(channel, cfgNow)) {
      invalidateStripChannel(channel)
      return null
    }
    let identity = null
    try { identity = identityOfChannel(channel.channelId) } catch (err) { identity = null }
    const identityKnown = typeof identity === 'string' && identity.length > 0
    // 优先复用额度策略观察里已有的投影（同一份数据），但必须**同一来源身份**。
    const observed = channelProjection.get(channel.channelId)
    const meta = channelMeta.get(channel.channelId)
    if (observed !== undefined && observed !== null && identityKnown
      && meta !== undefined && typeof meta.identity === 'string' && meta.identity === identity) {
      // [终审 C] 同一身份下的永久失败：不沿用旧百分比，立即隐藏并清掉缓存。
      if (observed.availability === 'error' && observed.transient !== true) {
        invalidateStripChannel(channel)
        return null
      }
      const payload = formatStripText(channel, observed, { locale })
      if (payload !== null) {
        if (typeof meta.sampledAt !== 'number' || Date.now() - meta.sampledAt >= STRIP_FRESH_MS) ensureStripChannel(channel)
        return payload
      }
    }
    const key = stripChannelKey(channel)
    const cached = key !== null ? stripCache.get(key) : undefined
    if (cached === undefined || cached.good === null || cached.good === undefined) {
      ensureStripChannel(channel)
      return null
    }
    const payload = formatStripText(channel, cached.good, { locale })
    if (Date.now() - cached.at >= STRIP_FRESH_MS) ensureStripChannel(channel)
    return payload
  }
  const subscribeStrip = (scope, emit, caps) => {
    const locale = caps !== null && caps !== undefined && typeof caps.locale === 'string' ? caps.locale : 'zh-CN'
    const sessionId = scope !== null && scope !== undefined ? scope.sessionId : undefined
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      try { emit(null) } catch (err) { /* 桥接已断开 */ }
      return () => {}
    }
    const push = () => {
      let payload = null
      try { payload = stripPayloadFor(scope, locale) } catch (err) { payload = null }
      try { emit(payload) } catch (err) { /* 桥接已断开 */ }
    }
        stripSubs.add(push)
    let subs = sessionRouteSubs.get(sessionId)
    if (subs === undefined) {
      subs = new Set()
      sessionRouteSubs.set(sessionId, subs)
    }
    subs.add(push)
    backfillSessionRoute(sessionId)
    push()
    const timer = setInterval(push, 15_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      try { clearInterval(timer) } catch (err) { /* 已清理 */ }
      stripSubs.delete(push)
      const current = sessionRouteSubs.get(sessionId)
      if (current !== undefined) {
        current.delete(push)
        if (current.size === 0) sessionRouteSubs.delete(sessionId)
      }
    }
  }
  // 会话事件：latest wins 更新路由（模型选择 / 实际请求 / 实际生成）。
  try {
    const offSessionEvent = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
        const sessionId = session !== null && session !== undefined ? session.id : undefined
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        try { applyRouteEventForSession(sessionId, event) } catch (err) { /* 忽略坏事件 */ }
        try {
          const sessions = ctx.get('sessions')
          const service = sessions !== null && sessions !== undefined ? sessions : null
          const store = service !== null && typeof service.get === 'function' ? service : null
          // 会话释放不提供事件时，用 LRU 上限兜底，防止 map 无限增长。
          if (sessionRoute.size > 64 && store !== null) {
            const oldest = sessionRoute.keys().next().value
            if (oldest !== undefined) sessionRoute.delete(oldest)
          }
        } catch (err) { /* 忽略 */ }
      })
      : null
    if (typeof offSessionEvent === 'function') {
      try {
        ctx.effect(() => () => { try { offSessionEvent() } catch (err) { /* 已失效 */ } })
      } catch (err) { /* 旧宿主 */ }
    }
  } catch (err) { /* 旧宿主没有事件总线：strip 靠 backfill + 定时重算 */ }

  // ---- 动态 context：每次请求（含同 step 重试）重新求值 ----
  let quotaContextDispose = null
  /**
   * [0.10.5] 注入可观测性：用户看不到「上下文注入」时，必须能自证"有没有注册、为什么没文本"。
   * 只记录**固定枚举**（不含额度数值、不含账号、不含上游原文）。
   */
  let quotaContextRegistered = false
  let quotaContextState = 'unregistered'
  let quotaContextChannel = null
  const quotaContextReasonOf = (view) => {
    if (view === null || view === undefined || typeof view !== 'object') return 'no-view'
    if (view.enabled !== true) return 'policy-off'
    if (typeof view.channelId !== 'string' || view.channelId.length === 0) {
      if (view.unobserved === true) return 'unobserved-route'
      if (view.notAllowed !== undefined) return 'route-not-focused'
      if (view.ambiguous === true) return 'route-ambiguous'
      if (view.unmapped !== undefined) return 'route-unmapped'
      if (view.channelDisabled !== undefined) return 'channel-disabled'
      if (view.poolUnproven !== undefined) return 'pool-unproven'
      return 'no-channel'
    }
    return 'rendered'
  }
  const registerQuotaContext = (serviceCtx) => {
    const systemPrompt = serviceCtx !== null && serviceCtx !== undefined && serviceCtx.systemPrompt !== undefined
      ? serviceCtx.systemPrompt
      : (serviceCtx !== null && serviceCtx !== undefined && typeof serviceCtx.get === 'function' ? serviceCtx.get('systemPrompt') : undefined)
    if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') return
    quotaContextDispose = systemPrompt.context({
      name: 'dsh-usage-dock.quota',
      order: POLICY_CONTEXT_ORDER,
      interpolate: false,
      text: (assemblyContext) => {
        try {
          const view = buildQuotaView({
            cfg: quotaCfg,
            observation: routeObserver.read(assemblyContext !== null && assemblyContext !== undefined
              ? assemblyContext.agent
              : undefined),
            readChannel: (id) => (channelProjection.has(id) ? channelProjection.get(id) : null),
            readObservation: (id) => (channelMeta.has(id) ? channelMeta.get(id) : null),
            pickSmallestWindow,
            identityOf: identityOfChannel,
            usesReservePool,
            // [A07] 本版本没有 Reserve 额度池的来源证明，因此该池恒为「未证明」。
            reservePoolReady: () => false,
          })
          quotaContextState = quotaContextReasonOf(view)
          quotaContextChannel = typeof view.channelId === 'string' && view.channelId.length > 0 ? view.channelId : null
          return renderQuotaPrompt(view)
        } catch (err) {
          quotaContextState = 'error'
          return ''
        }
      },
    })
    quotaContextRegistered = typeof quotaContextDispose === 'function'
    if (quotaContextRegistered) quotaContextState = 'registered-no-request-yet'
    // 原生端没有网页轮询，需要后台把关注渠道的额度喂给策略快照。
    if (dshGoBridgeSeen) startPolicyRefreshLoop()
  }
  try {
    /**
     * [0.10.5] 用 `ctx.inject` 而不是 apply 时一次性 `ctx.get`：宿主服务可能在本插件之后
     * 才就绪，一次性读取会静默注册失败（用户侧表现＝"策略开了但提示词里没有"）。
     */
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (serviceCtx) => { registerQuotaContext(serviceCtx) })
    } else {
      registerQuotaContext(ctx)
    }
  } catch (err) {
    quotaContextDispose = null
  }
  /** [0.10.5] 只读自证视图：注册与否 + 最近一次求值为什么没文本（固定枚举）。 */
  const quotaContextView = () => ({
    registered: quotaContextRegistered,
    state: quotaContextState,
    channelId: quotaContextChannel,
  })
  // 配置变化时刷新策略缓存（宿主公开事件）。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('app-boot/config-reload', () => {
        if (typeof liveConfig.invalidate === 'function') liveConfig.invalidate()
        /**
         * [终审 A/B/C] 配置一变：legacy 立即失效（不把停用前的余额说成新鲜），
         * strip 进入同步遮蔽并作废旧缓存/在途结果；配置重读完成后再放行重新计算。
         */
        invalidateLegacyMimoState()
        markStripConfigDirty()
        if (dshGoBridgeSeen) void restoreLegacyMimo(true)
        void Promise.resolve().then(() => refreshQuotaCfg()).finally(() => {
          stripConfigPending = false
          notifyStripSubs()
        })
      })
    }
  } catch (err) { /* 旧宿主没有事件总线 */ }
  // 卸载：注销 context、清空观察、断开路由监听。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof quotaContextDispose === 'function') {
          try { quotaContextDispose() } catch (err) { /* 已清理 */ }
          quotaContextDispose = null
        }
        // [0.10.5] 自证视图必须跟着复位：卸载后仍报 registered 会误导排障。
        quotaContextRegistered = false
        quotaContextState = 'disposed'
        quotaContextChannel = null
        try { routeObserver.dispose() } catch (err) { /* 已清理 */ }
        try { quotaObserver.clear() } catch (err) { /* 已清理 */ }
        channelProjection.clear()
        channelMeta.clear()
      })
    }
  } catch (err) { /* 无 effect 能力时退化为进程生命周期 */ }

  // [local patch 0.8.1] WorkBuddy 渠道借用 dsh-workbuddy-connect 的同源 status
  // 端点（仅回环请求可信），把本插件 web 服务的回环地址注入给它。
  // webServer.port 是官方公开属性（端口 0 时为 OS 分配后的实际监听端口）。
  try {
    const port = ctx.webServer != null ? ctx.webServer.port : undefined
    if (typeof port === 'number' && port > 0) {
      setWebBase('http://127.0.0.1:' + String(port))
    }
  } catch (err) {
    // 注入失败时 WorkBuddy 渠道会在取数时给出可读错误，不影响其他渠道。
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      const rawCfg = await liveConfig()
      // [R7] 一次性解包全部 volatile 包装：后续 provider / 自定义条目 / 开关判断
      // 都只看这个普通对象，不再出现「包装对象被当成非字符串」的漏读。
      const cfgNow = unpackConfig(rawCfg)
      /**
       * [R4-01] 用**本次实际读到的配置**同步刷新策略快照并推进 epoch。
       *
       * `refreshQuotaCfg()` 是异步的（走 `liveConfig()` 的 2 秒缓存 + 事件订阅），
       * 因此配置刚保存、事件还没跑完时，GUI 路由可能先拿到新配置却仍用旧身份：
       * 旧在途票据的 epoch 没被推进，于是「切出再切回」后仍能复活。
       *
       * 这里在每次路由入口同步做一次，保证「配置变了 → epoch 立刻推进」。
       */
      quotaCfg = cfgNow
      try { reconcileIdentities() } catch (err) { /* 身份重算失败不影响取数 */ }
      if (cfgNow.enabled === false) {
        json(res, 200, { ok: false, error: 'disabled', message: '套餐用量已停用' })
        return
      }
      const enabledPlans = PLANS.filter((plan) => cfgNow[plan.fields.enabled] !== false)
      // [W1/W2] 配置证明：用**本次实际读到的** cfg 计算摘要并随响应返回。
      // 客户端拿它和自己当前保存的配置比对，一致才认这份数据 —— 不依赖「浏览器是否见过 gen」。
      // `reloadable` 表示本部署能否热重读配置（有 configEditor），客户端据此区分
      // 「再等一会儿会生效」与「必须重启」。
      let reloadable = false
      try {
        const editor = ctx.get('configEditor')
        reloadable = editor !== undefined && editor !== null && typeof editor.configuration === 'function'
      } catch (err) { /* 无该服务：只能重启生效 */ }
      const proof = configProofOf(cfgNow, { readAt: Date.now(), reloadable })
      /**
       * [R3-04] 自定义采集任务**惰性且唯一**。
       *
       * 之前这里无条件先启动一份，主分支又另起一份 `fetchCustomPlans`：
       * 第一份结果被丢弃，但**请求已经发出** —— 每条自定义渠道被查两次。
       * 现在用一个 memo，只创建一次；两条分支消费同一份结果。
       */
      let customTaskMemo = null
      const customTicketsFor = new Map()
      const runCustomTask = () => {
        if (customTaskMemo !== null) return customTaskMemo
        customTaskMemo = Promise.resolve().then(() => {
          // [R2-01][R3-02] 在 provider 调用**之前**逐条签票。
          const opSeqsFor = new Map()
          for (const entry of collectCustomEntries(cfgNow, { allowLegacy: legacyCustomAllowed() })) {
            // [R9-01] 入场即领序号（在任何异步 I/O 之前）。
            opSeqsFor.set(entry.id, beginOp(entry.id))
            const ticket = quotaObserver.begin({ id: entry.id, identity: identityOfChannel(entry.id) })
            ownTicket(entry.id, ticket, opSeqsFor.get(entry.id))
            customTicketsFor.set(entry.id, ticket)
            pendingTickets.set(entry.id, ticket)
          }
          // [R8-01] 传**本次采集自己的**票据：只有它能在换 Key 时被提升。
          return fetchCustomPlans(ctx, undefined, cfgNow, {
            isCurrentOperation: (id) => operationMayProceed(id, customTicketsFor.get(id), opSeqsFor.get(id)),
            onSampledCredential: (id, fingerprint) => recordSampledCredential(
              id, fingerprint, customTicketsFor.get(id), opSeqsFor.get(id),
            ),
          })
            .then((wires) => (Array.isArray(wires) ? wires : []))
            .catch(() => [])
        })
        return customTaskMemo
      }
      if (enabledPlans.length === 0) {
        const customOnlyRaw = await runCustomTask()
        let customOnly = orderPlansByPlanOrder(customOnlyRaw, cfgNow.planOrder)
        // [A01] 仅自定义分支也必须发布观察，否则模型永远看不到自定义渠道的
        // 成功数值与固定失败状态（此前直接 return，整条链路被跳过）。
        // [R2-01] 同样在采集前签票，保证迟到结果不会覆盖新结果。
        for (const wire of customOnly) {
          const ticket = wire !== null && wire !== undefined && typeof wire.id === 'string'
            ? customTicketsFor.get(wire.id)
            : undefined
          try { publishObservation(wire, ticket) } catch (err) { /* 观察失败不影响路由 */ }
        }
        if (customOnly.length === 0) {
          json(res, 200, { ok: false, error: 'disabled', message: '套餐用量已停用' })
          return
        }
        customOnly = customOnly.map(guiObservationWire)
        // [A04] 仅自定义分支同样要附统一状态（与主分支一致）。
        attachEffectiveStatus(customOnly)
        json(res, 200, { ok: true, data: { plans: customOnly, cfg: proof, mimoAuth: mimoAuthStatus, quotaContext: quotaContextView() } })
        return
      }
      // shell 服务只用于 Python/curl 兜底后端；原生 fetch 后端（0.6.2 起首选）
      // 不需要它。移动端曾因为缺 python/curl 而整体取数失败，所以这里不再把
      // shell 缺失当成致命错误——交给 util.js 按可用后端降级。
      // [0.9.0] 自定义余额**不使用** shell 后端（见 plans/custom-balance.js 头注释），
      // 因此这里显式只把 shell 交给内置渠道。
      let shell
      try { shell = ctx.get('shell') } catch { /* 可选服务在移植端缺失，不阻断原生 fetch */ }
      // 包括服务/凭据解析的同步 throw 与异步 reject：异常仅影响本渠道。
      //
      // [R2-01] 票据必须在**采集开始前**签好，随结果一起回来。
      // 否则序号会按「完成顺序」分配，挂起的旧请求后返回时反而拿到更大的 seq，
      // 把更新的结果覆盖掉 —— 这正是上一轮仍未修掉的用户风险。
      const builtInTask = Promise.all(enabledPlans.map((plan) => {
        // [R9-01] 内置渠道同样入场即领序号。
        const opSeq = beginOp(plan.id)
        const ticket = quotaObserver.begin({ id: plan.id, identity: identityOfChannel(plan.id) })
        ownTicket(plan.id, ticket, opSeq)
        pendingTickets.set(plan.id, ticket)
        return Promise.resolve()
          /**
           * [0.10.0 N1] GUI 路由与 `usage_status` 用**同一套** MiMo 分流：
           * 显示快照适用（routeDisplay/display 给得出值）时零请求、直接用快照；
           * 不适用时回落 provider。复用同一个 helper，不复制分支、不加新请求。
           */
          .then(() => (plan.id === 'mimo'
            ? mimoWireWithDisplay(mimoDisplaySource, () => plan.fetch(ctx, shell, cfgNow))
            : plan.fetch(ctx, shell, cfgNow)))
          .then((wire) => ({ wire, ticket }))
          .catch(() => ({ wire: withConfiguredCodexSource(execError(plan), cfgNow), ticket }))
      }))
      // [R3-04] 复用同一个 memo，绝不在这里再起一次 fetchCustomPlans。
      const [builtInPairs, custom] = await Promise.all([builtInTask, runCustomTask()])
      const builtIn = builtInPairs.map((pair) => pair.wire)
      const customTickets = customTicketsFor
      /**
       * [顺序修复 2026-10-20 第三次] **全局混排**：内置与自定义共用同一 `planOrder`。
       *
       * 审核指出 `builtIn.concat(orderedCustom)` 从设计上就禁止跨组移动：
       * 用户要求 OpenRouter 能移到 Codex / WorkBuddy 之前，分组 concat 做不到。
       *
       * 现在按 `planOrder` 对**完整列表**排序，未列入的按原相对顺序追加。
       */
      let plans = orderPlansByPlanOrder(builtIn.concat(custom), cfgNow.planOrder)
      // [R2-01] 用**采集开始**时签的票据发布；迟到结果由 commit 的序号比较拒绝。
      for (const pair of builtInPairs) {
        try { publishObservation(pair.wire, pair.ticket) } catch (err) { /* 观察失败不影响路由 */ }
      }
      for (const wire of custom) {
        const ticket = wire !== null && wire !== undefined && typeof wire.id === 'string'
          ? customTickets.get(wire.id)
          : undefined
        try { publishObservation(wire, ticket) } catch (err) { /* 观察失败不影响路由 */ }
      }
      plans = plans.map(guiObservationWire)
      // [A04] 把 Host 的统一状态附到每个条目上，客户端**只消费**、不再自己计数。
      attachEffectiveStatus(plans)
      // [local patch 0.8.0/0.8.1] DeepSeek 峰谷计价相位与段序列（时间条渲染用）。
      // 纯本地计算（plans/peak-phase.js），不请求网络、不抛错——算不出来就不附，
      // 客户端按「无时间条」处理。
      // [0.8.3] 不再限定 via==='account'：峰谷计价是 **DeepSeek 平台侧的计费规则**
      //（北京时间 09:00–12:00 / 14:00–18:00 峰价，周末与假日谷价），与「用账号余额
      // 还是 API Key 查询」无关——API Key 计费的模型同样按该规则计价。因此只要
      // DeepSeek 条目取数成功（无 error）就附相位/段序列，所有设备与两种鉴权方式
      // 统一显示峰谷条（用户 2026-10-16 明确要求）。
      // 客户端可视窗 = 24h（游标居中，左右各 12h），因此段窗口
      // 取 now-12h-2min .. now+24h：左侧必须给满 12h（0.8.1 只给 6h 导致条左
      // 半出现空白），右侧留 12h 余量，30s 轮询与短暂取数失败都不会露白边。
      for (const plan of plans) {
        if (plan != null && plan.id === 'deepseek' && plan.error === undefined) {
          const now = Date.now()
          const phase = peakPhaseAt(now)
          const segs = peakSegments(now - 12 * 3600e3 - 120e3, now + 24 * 3600e3)
          if (phase !== null) plan.peakPhase = phase
          if (segs !== null && segs.length > 0) plan.peakSegs = segs
        }
      }
      json(res, 200, { ok: true, data: { plans, cfg: proof, mimoAuth: mimoAuthStatus, quotaContext: quotaContextView() } })
    },
  }), 'plan-usage: usage route')

  /**
   * [0.9.0] 自定义条目的**密钥存在性**摘要（只回布尔，绝不回 Key）。
   *
   * 为什么需要它：DSH 的 settings 投影会把 `role('secret')` 从 `value` 里剥掉，
   * 浏览器侧的 ConfigFormController 快照也不含 `secrets` 侧信道，因此设置页无法
   * 仅凭表单判断「这条记录是否已保存 Key」，也就无法给出「已配置/未配置」与「清除」。
   * 这条路由只回 `{ keys: {id:boolean}, refs: {id:boolean} }`，不泄露任何值。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/custom-status',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      try {
        const cfgNow = await liveConfig()
        const status = await customStatusOf(ctx, cfgNow)
        /**
         * [0.9.1] 同时返回**可选的模型渠道列表**（设置页下拉的数据源）。
         *
         * 只含同时具备 `baseURL` 与 `apiKeyEnv` 的 provider：
         * 地址与凭据都从配置派生，用户不再手输 —— 这是本轮安全边界变化的根据。
         * 这里只暴露 provider id / 显示名 / origin，**不含**任何凭据值。
         */
        /**
         * [CP-07 残留] 保留 `status` / `reason`，并给出**完整 baseURL**（含路径）。
         *
         * 之前 map 时只留 provider/displayName/origin，把状态与原因剥掉了，
         * 用户在设置页看不到「为什么这个渠道查不了余额」。
         * 同时 [CP-08] 要求显示实际生效的模型 baseURL（保留 /v1 这类路径），
         * 所以这里返回完整 baseURL（已脱敏：去掉 userinfo 与查询串）。
         */
        let providers = []
        try {
          providers = listProviderTargets(ctx).map((row) => ({
            provider: row.provider,
            displayName: row.displayName,
            baseURL: sanitizeDisplayUrl(row.baseURL),
            origin: (() => {
              try { return new URL(row.baseURL).origin } catch (err) { return '' }
            })(),
            baseURLSource: row.baseURLSource,
            status: row.status,
            reason: row.reason,
          }))
        } catch (err) { providers = [] }
        json(res, 200, { ok: true, data: { keys: status.keys, refs: status.refs, providers } })
      } catch (err) {
        json(res, 200, { ok: false, error: 'status', message: '无法读取自定义渠道状态' })
      }
    },
  }), 'plan-usage: custom status route')

  /**
   * [2026-10-25 客户端 Key 端点] WorkBuddy 账号列表路由：**保留兼容，但已不支持筛选**。
   *
   * 新客户端接口没有稳定账号 ID，`listWorkbuddyAccounts` 现在只返回固定元数据
   * （`supported:false` + 说明），**零凭据解析、零网关请求、零缓存**；
   * 设置页也已不再调用本路由（避免旧 404/401 反复探测）。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/workbuddy-accounts',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      try {
        const result = await listWorkbuddyAccounts(ctx)
        json(res, 200, { ok: true, data: result })
      } catch (err) {
        json(res, 200, { ok: false, error: 'status', message: '无法读取 WorkBuddy 账号列表' })
      }
    },
  }), 'plan-usage: workbuddy accounts route')


  /**
   * [2026-11-11 Codex 双来源] 只读的**来源状态**查询（设置页两行来源用）。
   *
   * 合同（闭集，客户端按此渲染，多一个字段都不给）：
   *   `{ ok:true, data:{ sources:[{id:'connect'|'subscription', label, enabled, compatible}],
   *                       selected:'connect'|'subscription' } }`
   *
   * 硬边界：
   *   - **纯 metadata**：零额度读取、零 credential record 读取、零 import、零网络。
   *     只读 `ctx.get(...)` 的公开服务对象与 loader 条目的公开元信息；
   *   - 两行**始终**都在（未安装/未开启都是 `enabled:false`，界面统一显示「未启用」）；
   *   - 「已安装且已激活，但没装只读接口补丁」= `enabled:true, compatible:false`
   *     （界面显示「接口不兼容/需要适配」），**不**冒充「未启用」；
   *   - 状态**无法证明**（`ctx.get` 抛错）⇒ `ok:false` 整体失败，**不**发布一份假的
   *     `enabled:false`（那会把「不知道」说成「未启用」）；
   *   - 不返回 runtime entries、不返回配置、不返回账号/路径/令牌；
   *   - GET-only，只读，不落任何状态。
   */
  /**
   * [0.10.2] Codex Subscription「一键应用本地适配」。
   *
   * 两条路由都**不接受任何参数**：目标包目录由 `plans/codex-subscription-patch.js` 按自身位置推导，
   * 客户端无法指定路径 / URL / 版本。只读路由不读凭据、不联网；动作路由走与 CLI 同一套实现
   * （`wx` 备份 → 同目录 `wx` 临时文件 → 读回校验 → rename → 校验新哈希），失败不留半改文件。
   *
   * [0.10.6] 只读路由的响应字段（闭集，仍全部是只读 metadata）：
   *   `{ ok:true, data:{ installed, version, state, serviceAvailable, manifestVersion, covered } }`
   *   - `manifestVersion`：与**已装版本**精确匹配的清单版本（继承链已展开；无匹配 ⇒ `null`）；
   *   - `covered`：本包清单目录里所有**合法**清单的版本号数组（纯版本号、升序、不含路径）——
   *     只用于界面提示「本包支持哪些版本」，**不**表示已装版本一定在其中。
   *   `apply-patch` 路由的行为与响应字段不变。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/codex-subscription/patch-state',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      try {
        const mod = await import('./plans/codex-subscription-patch.js')
        const state = mod.readPatchState(mod.resolvePackageDir())
        // [0.10.6] 新增两个只读字段（向后兼容：原有字段语义不变）：
        //   manifestVersion = 解析命中的清单版本（无则 null）；covered = 所有合法清单版本（纯版本号）。
        // 旧版模块（混合部署）没有 coveredVersions 时退化为空数组，不让路由整体失败。
        const covered = typeof mod.coveredVersions === 'function' ? mod.coveredVersions() : []
        json(res, 200, {
          ok: true,
          data: {
            installed: state.installed,
            version: state.version,
            state: state.state,
            serviceAvailable: state.serviceAvailable,
            manifestVersion: state.manifestVersion === undefined ? null : state.manifestVersion,
            covered,
          },
        })
      } catch (err) {
        json(res, 200, { ok: false, error: 'E_CS_PATCH_IO' })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/codex-subscription/apply-patch',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      // 请求体必须为空：任何多余字段都拒绝（固定码，不解释细节）
      const len = Number(req.headers && req.headers['content-length'] ? req.headers['content-length'] : 0)
      if (len > 0) {
        json(res, 400, { ok: false, error: 'E_CS_PATCH_ARGS' })
        return
      }
      try {
        const mod = await import('./plans/codex-subscription-patch.js')
        const baseDir = process.env.TEMP || process.env.TMPDIR || '.'
        const sep = baseDir.indexOf('\\') >= 0 ? '\\' : '/'
        const backupRoot = baseDir + (baseDir.endsWith(sep) ? '' : sep) + 'dsh-cs-patch-backup'
        const out = mod.applyPatch(mod.resolvePackageDir(), { backupRoot: backupRoot })
        json(res, 200, {
          ok: true,
          data: { applied: out.applied === true, backup: out.backup, newSha: out.newSha, requiresRestart: out.requiresRestart === true },
        })
      } catch (err) {
        const code = err && typeof err.code === 'string' && err.code.startsWith('E_CS_PATCH_') ? err.code : 'E_CS_PATCH_IO'
        json(res, 200, { ok: false, error: code })
      }
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/codex-sources',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      try {
        /**
         * 用**当前**配置算 `selected`（与 GUI 主路由一致地先解包 volatile）。
         * 读不到配置时不猜来源：直接拒绝，避免把上一份配置的 selected 当当前值。
         */
        let cfgNow = null
        try { cfgNow = unpackConfig(await liveConfig()) } catch (err) { cfgNow = null }
        if (cfgNow === null || cfgNow === undefined) {
          json(res, 200, { ok: false, error: 'status', message: '无法确认当前配置' })
          return
        }
        const state = getCodexSourceState(ctx, { cfg: cfgNow })
        if (state.unknown === true) {
          json(res, 200, { ok: false, error: 'status', message: '无法确认 Codex 来源状态' })
          return
        }
        json(res, 200, { ok: true, data: { sources: state.sources, selected: state.selected } })
      } catch (err) {
        json(res, 200, { ok: false, error: 'status', message: '无法读取 Codex 来源状态' })
      }
    },
  }), 'plan-usage: codex sources route')


  /**
   * [2026-10-23 额度策略 UI] 只读的**额度窗口能力**查询（设置页按渠道/窗口配阈值时用）。
   *
   * 为什么需要：设置页要只给"这个渠道实际有的窗口"渲染输入框，不能硬造 5h/周/月。
   * 数据只来自 Host 已有的 `channelProjection` / `channelMeta` —— 那是取数时按票据、
   * epoch、identity、source 校验过的可信观察。
   *
   * 硬边界：
   *   - **零凭据解析、零上游请求、零缓存写入**（不解析 Key/Cookie，不发任何 provider 请求）；
   *   - 只回窗口 key 与当前剩余百分比（这些数字 GUI 本来就在显示），不含 URL/账号/Key；
   *   - 身份不一致（改 Key/改配置/换账号）→ 只回 `stale-identity`，**不回窗口**
   *     （绝不拿上一个账号的窗口当当前能力）；
   *   - `failed` / `expired` / 尚无观察 → 只回状态，不回窗口（失败 ≠ 确认无窗口）；
   *   - GET-only，只读。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/plan-usage/quota-windows',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
        return
      }
      try {
        /**
         * [2026-10-23 父裁决] 必须与 GUI 取数入口一样**先同步配置与激活状态**。
         *
         * 只读 `quotaCfg` 旧缓存 + 依赖异步 `config-reload` 事件，会让「刚改 Key/来源」
         * 与「这条 metadata 请求」之间出现窗口期：旧账号的窗口能力被当成当前能力。
         *
         * 更关键的一步（独立审查阻断项）：这里必须用 **freshStrict**，不能用带 2 秒缓存的
         * `liveConfig()` —— 缓存窗口内会读到旧配置，身份因此"没变"，于是把**上一个来源的
         * 窗口**原样返回（父用例：换 Key 后 0ms 请求仍回 A 的两窗口）。
         *
         * fail closed：读不到当前配置就**不投放任何窗口能力**（回空 channels + stale 标记），
         * 绝不用旧配置冒充当前配置。仍然**零凭据解析、零上游请求、零采样**。
         */
        let cfgNow = null
        try {
          cfgNow = unpackConfig(await liveConfig.freshStrict())
        } catch (err) {
          /**
           * [F01/F02] **无法证明这是当前配置 → 明确失败**（`ok:false`），
           * 绝不把旧缓存连同 `fresh:true` 一起返回（那是把上一个来源的窗口冒充当前能力）。
           */
          json(res, 200, {
            ok: false,
            error: 'status',
            message: '无法确认当前配置，已停止返回窗口能力',
          })
          return
        }
        if (cfgNow === null || cfgNow === undefined) {
          json(res, 200, {
            ok: false,
            error: 'status',
            message: '无法确认当前配置，已停止返回窗口能力',
          })
          return
        }
        quotaCfg = cfgNow
        try { reconcileIdentities() } catch (err) { /* 身份重算失败不影响只读查询 */ }
        const channels = {}
        for (const [id, meta] of channelMeta) {
          if (meta === null || meta === undefined || typeof meta !== 'object') continue
          let expected = null
          try { expected = identityOfChannel(id) } catch (err) { expected = null }
          // 描述逻辑放在纯模块里（`describeWindowCapability`）：身份/状态门槛与窗口映射
          // 只有一份实现，测试可以直接打它，不需要为了断言去伪造 Host 内部结构。
          channels[id] = describeWindowCapability({
            meta,
            channel: channelProjection.get(id),
            expectedIdentity: expected,
          })
        }
        json(res, 200, { ok: true, data: { channels, readAt: Date.now(), fresh: true } })
      } catch (err) {
        json(res, 200, { ok: false, error: 'status', message: '无法读取额度窗口信息' })
      }
    },
  }), 'plan-usage: quota windows route')


  /**
   * [0.9.0 / 方向 6 · T2] `usage_status` 模型工具（**只读**）。
   *
   * 契约核验（T0，读自 DSH 自带 `@deepseek-ai/dsh-tools` 的真实实现）：
   *   - `ctx.tools.register(definition)` 返回**精确 disposer**，卸载时调用即可；
   *   - definition 形状：`{ name, description, parameters, output:{ schema, render }, execute(args, exec) }`；
   *   - `output.render(args, value)` 返回内容块数组；`execute` 返回值必须是
   *     lossless JSON 且**符合 `output.schema`**（否则宿主报 INVALID_TOOL_OUTPUT）；
   *   - schema 只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const`
   *     与注解关键字（description/title/default/examples）；
   *   - `run_code` 是宿主保留名，不能注册。
   *
   * 因此这里**不 import** 宿主工具包（插件目录解析不到），而是按上述契约手写定义。
   * 缺 `tools` 服务时静默跳过，胶囊与设置页照常工作。
   *
   * 取数**复用**与 Web 路由同一套编排（内置 + 自定义），但**不**走 HTTP、不读浏览器
   * 灰化缓存；工具侧另有 30 秒成功缓存与 single-flight（见 plans/usage-tool-register.js）。
   */
  ctx.effect(() => {
    let disposed = null
    // [Y3] 卸载后不再注册段落、不再取数（简化桩里卸载后的启动微任务会走到这里）。
    let alive = true
    // [额度自动感知] 观察容器、路由观察器与动态 context 已在 apply 作用域创建
    // （GUI 路由与模型工具必须共用同一份状态与失败计数），这里只做生命周期收尾。

    /**
     * [D6-B] 短哈希：只用 Host 内部做缓存身份，**绝不**出现在工具输出里。
     */
    const shortHash = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)

    /** 在 deadline 内等待一个 Promise；超时或取消返回 undefined（不抛错）。 */
    const withinDeadline = async (promise, deadline) => {
      if (deadline.expired) return undefined
      let timer = null
      let detach = null
      const guard = new Promise((resolve) => {
        const finish = () => resolve(undefined)
        timer = setTimeout(finish, deadline.remaining())
        if (typeof timer.unref === 'function') timer.unref()
        // [Y2] 取消要立刻生效，不能等满整个 deadline。
        if (deadline.signal !== null && deadline.signal !== undefined
          && typeof deadline.signal.addEventListener === 'function') {
          deadline.signal.addEventListener('abort', finish, { once: true })
          detach = () => deadline.signal.removeEventListener('abort', finish)
        }
      })
      try {
        return await Promise.race([Promise.resolve(promise).catch(() => undefined), guard])
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (typeof detach === 'function') detach()
      }
    }

    /** 读可选凭据服务的引用值（Host 内部使用，永不外泄）。 */
    const resolveRefValue = async (ctx2, ref, deadline) => {
      if (typeof ref !== 'string' || ref.length === 0) return { known: true, value: '' }
      let credentials
      try {
        credentials = ctx2 != null && typeof ctx2.get === 'function' ? ctx2.get('credentials') : undefined
      } catch (err) {
        credentials = undefined
      }
      if (credentials === undefined || credentials === null || typeof credentials.resolve !== 'function') {
        // 无法解析 → 身份不可证明。
        return { known: false, value: '' }
      }
      const hit = await withinDeadline(Promise.resolve().then(() => credentials.resolve(ref)), deadline)
      if (hit === undefined || hit === null) return { known: false, value: '' }
      const value = typeof hit.value === 'string' ? hit.value : ''
      return { known: true, value }
    }

    /**
     * 读配置快照（**不解析任何凭据**）。
     *
     * [D6-A] 复核指出：即使只查 A，也不能在取数前解析 B 的凭据。
     * 因此这里只做纯配置读取；真实凭据身份交给 `identify()` 按**本次请求**计算。
     */
    const buildSnapshot = async (deadline) => {
      let cfgNow
      try {
        cfgNow = unpackConfig(await withinDeadline(liveConfig(), deadline))
      } catch (err) {
        cfgNow = null
      }
      if (cfgNow === null || cfgNow === undefined) {
        return {
          enabled: [], known: [], generation: 'config-unavailable',
          policy: null, semanticsOf: percentSemanticsOf,
        }
      }
      const enabled = []
      const known = []
      const globalOn = cfgNow.enabled !== false
      for (const plan of PLANS) {
        known.push(plan.id)
        if (!globalOn) continue
        if (cfgNow[plan.fields.enabled] === false) continue
        enabled.push(plan.id)
      }
      for (const entry of collectCustomEntries(cfgNow, { allowLegacy: legacyCustomAllowed() })) {
        known.push(entry.id)
        if (!globalOn || !entry.enabled) continue
        enabled.push(entry.id)
      }
      return {
        enabled,
        known,
        // 配置摘要（自定义公开元数据 + 公开 Key 修订号）+ 各内置开关：粗粒度失效。
        generation: generationOfCfg(cfgNow),
        /**
         * [A13] 旧的单阈值自动建议**已停用**。
         *
         * 原因：新机制用「预警 + 收尾」两档写在动态 context 里，normal 阶段零规则；
         * 而旧的 `quotaPercentThreshold` / `quotaBalanceThreshold` 仍会让
         * `usage_status` 附一段「低于 X% 建议收尾」，与 context 的 normal 直接冲突。
         *
         * 处理：不再据此生成建议（`policy` 恒为 null），但**保留字段与工具 schema**，
         * 旧配置不会被静默迁移成新档位，也不会让工具调用报错。
         */
        policy: null,
        semanticsOf: percentSemanticsOf,
      }
    }

    /**
     * [D6-B][Q1][Q2][Q3] 计算**本次请求**涉及渠道的真实凭据身份，并冻结本次实际生效的来源。
     *
     * 统一契约（不再逐特例补丁）：
     *   1. 只有「当前已启用 ∩ 已知 ∩ 用户请求」的渠道才允许触碰凭据——否则零解析（Q3）。
     *   2. 每个允许渠道按**原来源优先级**选出实际生效的一份凭据：
     *      配置里的显式 Key/Cookie 优先；否则按候选顺序解析引用，跳过空值/哨兵继续下一个（Q2B）。
     *   3. 该值写进 `frozen` 快照，identity、single-flight 与真正发送都取这份值（Q1）；
     *      「已采样但确认无凭据」与「该渠道未采样」必须可区分（Q2A）。
     *   4. 账号/会话型来源无法证明身份 → 不缓存、不跨账户共享，但**不受快照约束**，
     *      仍按原路径正常解析（否则会凭空报告缺少凭据）。
     */
    const identifyChannels = async (ids, deadline) => {
      const wanted = new Set(Array.isArray(ids) ? ids : [])
      const cacheable = new Set()
      /**
       * [CP-05 残留] 把 identify 的绝对 deadline 包成 budget 形状，交给凭据解析。
       *
       * 这样「身份采样」阶段的 `credentials.resolve` 也受同一条预算约束：
       * 凭据服务挂起时不会把采样拖到它自己的 10 s 超时。
       */
      const samplingBudget = (() => {
        const end = typeof deadline === 'number' ? deadline : Date.now() + 5000
        let expired = false
        const budget = {
          get deadlineAt() { return end },
          get expired() { return expired || Date.now() >= end },
          remaining() { return Math.max(0, end - Date.now()) },
          expire() { expired = true },
          async race(promise) {
            if (budget.expired) return { ok: false, reason: 'timeout' }
            const left = budget.remaining()
            if (left <= 0) { expired = true; return { ok: false, reason: 'timeout' } }
            let timer = null
            const guard = new Promise((resolve) => {
              timer = setTimeout(() => { expired = true; resolve({ ok: false, reason: 'timeout' }) }, left)
            })
            try {
              return await Promise.race([Promise.resolve(promise).then((value) => ({ ok: true, value })), guard])
            } finally {
              if (timer !== null) clearTimeout(timer)
            }
          },
        }
        return budget
      })()
      const parts = []
      let cfgNow
      try {
        cfgNow = unpackConfig(await withinDeadline(liveConfig(), deadline))
      } catch (err) {
        cfgNow = null
      }
      if (cfgNow === null || cfgNow === undefined || cfgNow.enabled === false) {
        return { identity: '', cacheable, snapshot: { frozen: {}, custom: {} } }
      }
      // key = plan.id / entry.id；value = 本次冻结的凭据描述（永不外泄）
      const frozen = {}
      const customSnapshot = {}
      /** [R9-01] 每个渠道在**本次 identify 入场时**领到的序号，随快照返回给 collect 校验。 */
      const opSeqs = {}
      const sourceEpochs = {}
      for (const plan of PLANS) {
        if (!wanted.has(plan.id)) continue
        // [R9-01] 内置渠道也要有入场序号（供 collect 判断自己是否已过时）。
        opSeqs[plan.id] = beginOp(plan.id)
        // [Q3] 停用/全局关闭的渠道不进入任何凭据读取。
        if (cfgNow[plan.fields.enabled] === false) continue
        if (ACCOUNT_BOUND_PLAN_IDS.has(plan.id)) continue // 身份不可证明 → 不缓存、不冻结
        const source = plan.source !== null && plan.source !== undefined ? plan.source : {}
        const refs = Array.isArray(source.refs) ? source.refs.filter((ref) => typeof ref === 'string' && ref.length > 0) : []
        const pieces = [plan.id]
        // 1) 显式 Key / Cookie：与原 provider 完全相同的优先级与哨兵规则。
        const explicit = {}
        let hasExplicit = false
        for (const key of Object.values(plan.fields || {})) {
          const raw = cfgNow[key]
          if (typeof raw !== 'string' || raw.length === 0) continue
          pieces.push(key + ':' + shortHash(raw))
          if (key === plan.fields.apiKey && isSentinelApiKey(raw)) continue
          if (key === plan.fields.apiKey || key === plan.fields.cookie) {
            explicit[key] = raw
            hasExplicit = true
          }
        }
        // 2) 引用候选：只在**没有**有效显式凭据时按顺序尝试（有效显式值不应依赖未使用的回退）。
        let failure = null
        if (!hasExplicit && refs.length > 0) {
          let picked = null
          let unresolved = false
          for (const ref of refs) {
            const resolved = await resolveRefValue(ctx, ref, deadline)
            if (!resolved.known) { unresolved = true; break }
            if (resolved.value.length === 0 || isSentinelApiKey(resolved.value)) continue
            picked = { ref, value: resolved.value }
            break
          }
          if (unresolved) failure = 'unresolved'
          else if (picked === null) explicit.__none = true
          else {
            // 只记录真正生效的那一个引用（其余的没有参与发送，无需进入身份）。
            pieces.push('ref:' + picked.ref + ':' + shortHash(picked.value))
            frozen[plan.id] = { kind: 'ref', field: plan.fields.apiKey, ref: picked.ref, value: picked.value }
          }
        } else if (hasExplicit) {
          frozen[plan.id] = { kind: 'explicit', fields: explicit }
        } else {
          // 既无显式值、也没有候选引用：确认「采样完成且没有凭据」。
          explicit.__none = true
        }
        if (!hasExplicit && frozen[plan.id] === undefined && failure === null) {
          // 已采样且确认无凭据：provider 据此直接报缺凭据，不再二次解析。
          if (explicit.__none === true) frozen[plan.id] = { kind: 'none' }
        }
        if (failure !== null) continue // 身份不可证明 → 不缓存、不冻结
        parts.push(pieces.join('|'))
        cacheable.add(plan.id)
      }
      for (const entry of collectCustomEntries(cfgNow, { allowLegacy: legacyCustomAllowed() })) {
        if (!wanted.has(entry.id) || !entry.enabled) continue
        /**
         * [R9-01] 先领**操作序号**，再做任何异步解析。
         * 这样即便这次 identify 的凭据解析很慢，等它回来时若已被更新的操作取代，
         * 就不会再写指纹/推进 epoch（审核：旧 identify 晚签票、晚返回仍误收尾）。
         */
        const opSeq = beginOp(entry.id)
        opSeqs[entry.id] = opSeq
        const entryEpoch = quotaObserver.epochOf(entry.id)
        const rev = cfgNow.customKeyRev !== null && typeof cfgNow.customKeyRev === 'object'
          ? Number(cfgNow.customKeyRev[entry.id]) || 0
          : 0
        /**
         * [CP-01] **provider 来源走独立冻结协议**。
         *
         * 旧条目的凭据在 `customKeys`（显式 Key）或 `credentialRef` 里；新条目只有
         * `provider`，Key 由该 provider 的 `apiKeyEnv` 在取数时解析。
         *
         * 之前这里不区分两者：新条目因为 `key`/`credentialRef` 都是空，被冻结成
         * `{kind:'none'}` → 工具调用直接报缺凭据；
         * 而**同时**存在遗留 `customKeys` 时又会冻结成旧 Key，
         * 由 provider 解析把目标改成新服务商，于是**旧 Key 被发到新地址**。
         *
         * 现在 provider 条目冻结 `{kind:'provider', provider}`：
         *   - 不含任何旧 Key 值，旧 Key 无法借道；
         *   - 由 `fetchCustomBalance` 用**同一份** provider 解析取地址与凭据；
         *   - 身份里带上 provider 与解析出的凭据指纹，换源即换身份。
         */
        if (entry.provider.length > 0) {
          const resolved = await withinDeadline(
            Promise.resolve().then(() => resolveProviderCredential(ctx, entry.provider, entry.balanceEndpoint, samplingBudget)),
            deadline,
          )
          if (resolved === undefined) continue // 预算内没解析出来：不冻结、不缓存
          if (resolved.ok !== true) {
            // 解析失败是**可辨状态**（如渠道不存在/无 Key），照常冻结成 none 并由取数层报错。
            customSnapshot[entry.id] = { kind: 'none' }
            parts.push([entry.id, String(rev), 'provider', entry.provider, 'fail'].join('|'))
            continue
          }
          /**
           * [CP-01 残留] 冻结**完整来源**：provider + 本次余额 URL/origin + 引用 + 凭据值 + 指纹。
           *
           * 之前只冻 `{kind:'provider', provider}`，派发时二次解析：
           * 若两次读到的 Key 不同，就会出现「身份 A、数据 B」——缓存还会把 B 的结果当 A 命中。
           * 现在派发只能使用这份快照里的值，不再重新解析。
           */
          parts.push([
            entry.id,
            String(rev),
            'provider',
            entry.provider,
            entry.balanceEndpoint,
            resolved.url,
            // [R6-01] 与 GUI 采样共用**同一个**指纹函数，否则同一把 Key 会被当成两个来源。
            credentialFingerprint(resolved.value),
          ].join('|'))
          const sampledFingerprint = credentialFingerprint(resolved.value)
          customSnapshot[entry.id] = {
            kind: 'provider',
            provider: entry.provider,
            url: resolved.url,
            origin: resolved.origin,
            ref: resolved.ref,
            value: resolved.value,
            fingerprint: sampledFingerprint,
          }
          /**
           * [R4-01] 把这次**真正解析到**的凭据指纹同步给 Host 观察身份。
           *
           * 审核场景：同一引用下 Key 值 A→B→A 轮换。工具第三次已确认当前是 A，
           * 若不同步，context 仍会残留 B 的数值与收尾规则。
           * 登记后 `identityOfChannel` 会写出 `cred=<A>`，与 B 的身份不同，
           * 于是旧观察自然失效（并推进 epoch）。
           */
          const confirmed = recordSampledCredential(entry.id, sampledFingerprint, null, opSeq)
          // 同源并发 identify 可以共享已有任务，但 A→B→A 不得复用旧 epoch 的快照。
          if (confirmed === true || (entryEpoch === quotaObserver.epochOf(entry.id)
            && sampledCredentialOf(entry.id) === sampledFingerprint)) {
            sourceEpochs[entry.id] = quotaObserver.epochOf(entry.id)
          }
          cacheable.add(entry.id)
          continue
        }
        // [F1] 纯显式条目（没有引用）同样要冻结：否则 provider 会读当前 cfg 的 Key。
        if (entry.key.length === 0 && entry.credentialRef.length === 0) {
          customSnapshot[entry.id] = { kind: 'none' }
          continue
        }
        // [Q1] 显式 Key 优先：有显式值就不解析引用。
        if (entry.key.length > 0) {
          parts.push([
            entry.id,
            String(rev),
            shortHash(entry.key),
            entry.credentialRef,
            '',
          ].join('|'))
          customSnapshot[entry.id] = { kind: 'explicit', value: entry.key }
          cacheable.add(entry.id)
          continue
        }
        const refResolved = await resolveRefValue(ctx, entry.credentialRef, deadline)
        if (!refResolved.known) continue
        parts.push([
          entry.id,
          String(rev),
          '',
          entry.credentialRef,
          refResolved.value.length > 0 ? shortHash(refResolved.value) : '',
        ].join('|'))
        customSnapshot[entry.id] = refResolved.value.length === 0
          ? { kind: 'none' }
          : { kind: 'ref', value: refResolved.value }
        cacheable.add(entry.id)
      }
      parts.sort()
      return {
        identity: parts.join('\u0003'),
        cacheable,
        snapshot: { frozen, custom: customSnapshot, opSeqs, sourceEpochs },
      }
    }

    /** 配置代次：粗粒度失效信号（describe 与 collect 共用同一算法）。 */
    const generationOfCfg = (cfgNow) => configDigestOf(cfgNow) + '|' + PLANS
      .map((plan) => (cfgNow[plan.fields.enabled] === false ? '0' : '1'))
      .join('')

    const registered = registerUsageTool(ctx, {
      describe: async (info) => (alive ? buildSnapshot(info !== null && info !== undefined && info.deadline !== undefined
        ? info.deadline
        : { expired: false, remaining: () => 0 }) : { enabled: [], known: [], generation: 'unloaded', policy: null, policySection: null, semanticsOf: percentSemanticsOf }),
      /**
       * [P2 第三次] 工具成功缓存必须服从**同一来源已知的永久失败**。
       *
       * 审核复现 FAIL_GUI_PERMANENT_FAILURE_LEAVES_TOOL_SUCCESS_CACHE：
       * 同源同 Key，工具先成功（建立 30 s 缓存），随后 GUI 真实取数收到 401，
       * Host 已显示「获取额度失败」并撤掉阶段规则，但工具仍返回旧的 ok/1，
       * 零新 HTTP。这是「已知 P 类失败之后还用旧成功掩盖当前状态」。
       *
       * 这里把 Host 观察到的**永久失败/过期**状态暴露给工具缓存层：
       * 命中缓存前先问一句，失败则视为不可用，让工具走真实重试。
       * 暂时失败（transient）不在此列 —— 那种情况保留宽限缓存是正确行为。
       */
      isSourceFailed: (id, identity) => {
        if (typeof id !== 'string' || id.length === 0) return false
        /**
         * [R4-02] `read(id, identity)` 必须带身份 —— 观察记录是按
         * `observationKey(id, identity)` 存的。只传 id 会查不到任何记录，
         * 钩子恒返回 false，等于完全没生效（审核 CONTROL_READ_REQUIRES_IDENTITY 已证实）。
         *
         * 调用方（工具缓存层）传入它本次身份计算用的 identity；
         * 没传时退回该渠道**当前**的有效身份，仍不跨身份读取。
         */
        /**
         * [R5-03] **必须用 Host 的逐渠道观察身份**，不能用调用方传进来的字符串。
         *
         * 工具缓存层的 `identity` 是 `identifyChannels` 把**多个渠道**的
         * `parts` 用分隔符 join 出来的**批次缓存身份**；而 `quotaObserver`
         * 的槽位是每个渠道各自的 16 位摘要。两者编码与粒度都不同，
         * 直接透传必然查不到记录 —— 于是钩子又恒为 false
         * （FAIL_PERMANENT_GUI_FAILURE_TOOL_CACHE_STILL_OK）。
         *
         * 这里一律自己算当前源对应的 Host 身份；调用方传的值只作为
         * 「确实有渠道上下文」的信号，不参与查表。
         * 也不使用 `readAny` 跨身份绕读。
         */
        void identity
        let key = ''
        try { key = identityOfChannel(id) } catch (err) { key = '' }
        if (key.length === 0) return false
        let record
        try { record = quotaObserver.read(id, key) } catch (err) { return false }
        if (record === null || record === undefined || typeof record !== 'object') return false
        const status = record.status
        // 永久失败/过期：状态已封存，旧成功值不得再冒充当前可用。
        // 暂时失败（transient）不在此列：那种情况保留宽限缓存是正确行为。
        return status === 'failed' || status === 'expired'
      },
      identify: async (info) => {
        const deadline = info !== null && info !== undefined && info.deadline !== undefined
          ? info.deadline
          : { expired: false, remaining: () => 0 }
        if (!alive) return { identity: '', cacheable: new Set() }
        return identifyChannels(info !== null && info !== undefined ? info.ids : [], deadline)
      },
      // 真正取数：**先**按允许集合缩小，再逐渠道并发；每个渠道独立受 deadline 约束，
      // 已完成的成功项原样返回（慢渠道不会抹掉快渠道）。
      collectPlans: async (ids, info) => {
        // [Y3] 已卸载：不得再启动任何取数（含 describe/identify 之后迟到的调用）。
        if (!alive) return []
        const deadline = info !== null && info !== undefined ? info.deadline : null
        if (deadline !== null && deadline.expired) return []
        // [Q1][Q2] identify 冻结的**逐渠道**实际生效来源：真正发送必须与身份同源。
        // 未冻结的渠道（例如账号型 DeepSeek）传 null，provider 仍走正常解析，
        // 不能因为「没有快照」就凭空报缺凭据。
        const frozenMap = info !== null && info !== undefined
          && info.snapshot !== null && typeof info.snapshot === 'object'
          && info.snapshot.credentials !== null && typeof info.snapshot.credentials === 'object'
          ? info.snapshot.credentials
          : null
        const frozenOf = (id) => (frozenMap !== null && Object.prototype.hasOwnProperty.call(frozenMap, id)
          ? frozenMap[id]
          : null)
        let cfgNow
        try {
          cfgNow = unpackConfig(await liveConfig())
        } catch (err) {
          return []
        }
        // [R4-01] 与 GUI 路由一致：用本次读到的配置同步刷新并推进 epoch，
        // 保证「配置变化 → 旧在途票据立即失效」在**两个入口**都成立。
        quotaCfg = cfgNow
        try { reconcileIdentities() } catch (err) { /* 身份重算失败不影响取数 */ }
        if (cfgNow === null || cfgNow === undefined || cfgNow.enabled === false) return []
        // [D6-B] 返回前校验代次：配置在 describe 之后变过就**不出数**（旧代不得回填）。
        const expectedGeneration = info !== null && info !== undefined && info.snapshot !== undefined
          ? info.snapshot.generation
          : undefined
        if (typeof expectedGeneration === 'string' && generationOfCfg(cfgNow) !== expectedGeneration) return []
        const wanted = new Set(Array.isArray(ids) ? ids : [])
        let shell
        try { shell = ctx.get('shell') } catch (err) { /* 可选服务 */ }

        const results = []
        const tasks = []
        /**
         * [R3-02] 工具采集的票据必须在**provider 调用之前**签好。
         *
         * 之前仍是 `publishObservation(wire)`，等于在结果到达时才补签：
         * 旧工具请求后完成时反而拿到更大的 seq，把较新的 GUI 结果覆盖回去。
         */
        const emittedWires = new WeakSet()
        const emit = (wire, ticket) => {
          if (wire === null || wire === undefined || typeof wire !== 'object' || emittedWires.has(wire)) return
          if (deadline !== null && deadline.expired) return
          const ownedTicket = ticket !== undefined ? ticket : wireTickets.get(wire)
          if (!liveSourceTicket(wire.id, ownedTicket)) return
          if (wire.fetchedAt === undefined) wire.fetchedAt = Date.now()
          // [额度自动感知] 既有采集顺带发布观察：不额外打上游，GUI 与提示词共用同一份状态。
          try { publishObservation(wire, ownedTicket) } catch (err) { /* 观察失败不影响取数 */ }
          if (!acceptedWires.has(wire) && wire.error !== 'cancelled') return
          emittedWires.add(wire)
          results.push(wire)
          if (info !== null && info !== undefined && typeof info.onChannel === 'function') {
            try { info.onChannel(wire) } catch (err) { /* 回传失败不影响取数 */ }
          }
        }
        const baseFetchOptions = {
          // [Y2] 把工具预算贯穿到 provider 的凭据解析与传输层：
          // 到期后不再发起新的凭据请求 / HTTP 请求 / 后端回退。
          signal: deadline !== null ? deadline.signal : undefined,
          remaining: () => (deadline !== null ? deadline.remaining() : undefined),
        }
        /**
         * [R9-01] **identify 的入场序号**：如果这次 identify 已经被更新的操作取代，
         * 它带回来的来源就不再代表「当前有效来源」，不能继续为它派发请求。
         */
        const identifySeqs = info !== null && info !== undefined
          && info.snapshot !== null && typeof info.snapshot === 'object'
          && info.snapshot.opSeqs !== null && typeof info.snapshot.opSeqs === 'object'
          ? info.snapshot.opSeqs
          : {}
        const sourceEpochs = info !== null && info !== undefined && info.snapshot !== null
          && typeof info.snapshot === 'object' ? info.snapshot.sourceEpochs : null
        const sameSnapshotSource = (id) => sourceEpochs !== null && sourceEpochs !== undefined
          && typeof sourceEpochs[id] === 'number' && sourceEpochs[id] === quotaObserver.epochOf(id)
        const staleSnapshot = (id) => !isCurrentOp(id, identifySeqs[id]) && !sameSnapshotSource(id)
        for (const plan of PLANS) {
          if (!wanted.has(plan.id)) continue
          if (cfgNow[plan.fields.enabled] === false) continue
          // [R9-01] 该来源已被更新的操作取代：不签票、不派发。
          if (staleSnapshot(plan.id)) continue
          // [R3-02] 在 provider 调用**之前**签票。
          // [R9-01] 工具侧内置渠道同样入场即领序号。
          const opSeq = beginOp(plan.id)
          const planTicket = quotaObserver.begin({ id: plan.id, identity: identityOfChannel(plan.id) })
          ownTicket(plan.id, planTicket, opSeq)
          // [Q1] 逐渠道下发它**自己**被冻结的来源；没有冻结就传 null（按原路径解析）。
          const planOptions = Object.assign({}, baseFetchOptions, {
            frozenCredential: frozenOf(plan.id),
          })
          tasks.push((async () => {
            const fetchOnce = () => plan.fetch(ctx, shell, cfgNow, planOptions)
            const wire = await withinDeadline(
              Promise.resolve()
                /**
                 * [2026-11-12 MiMo lane 对齐] MiMo 先看**显示快照**（与胶囊同一条 lane）：
                 * 快照适用时连 provider 都不进（零 import、零构造、零请求）；不适用
                 * （未选中 / 读不到）才走原来的 `plans/mimo.js` 路径，行为完全不变。
                 */
                .then(() => (plan.id === 'mimo'
                  ? mimoWireWithDisplay(mimoDisplaySource, fetchOnce)
                  : fetchOnce()))
                .catch(() => withConfiguredCodexSource(execError(plan), cfgNow)),
              deadline,
            )
            emit(wire, planTicket)
          })())
        }
        // [D6-A] 自定义条目在**任何凭据解析/DNS/请求之前**先缩到本次允许集合。
        const allowedCustom = new Set()
        for (const entry of collectCustomEntries(cfgNow, { allowLegacy: legacyCustomAllowed() })) {
          if (entry.enabled && wanted.has(entry.id)) allowedCustom.add(entry.id)
        }
        // [R3-02] 自定义条目同样在请求前逐条签票。
        const customTickets = new Map()
        const customOpSeqs = new Map()
        const dispatchIds = new Set()
        for (const id of allowedCustom) {
          // [R9-01] identify 已被更新操作取代 → 不为旧来源派发。
          if (staleSnapshot(id)) continue
          /**
           * [R9-01] 工具侧也要领序号并登记到**全局** pending 表：
           * 之前只写本地 `customTickets`，导致 pending 仍指向旧 GUI 票，
           * 旧 GUI 的迟到 A 反而满足「当前票」检查。
           */
          customOpSeqs.set(id, beginOp(id))
          const customTicket = quotaObserver.begin({ id, identity: identityOfChannel(id) })
          ownTicket(id, customTicket, customOpSeqs.get(id))
          customTickets.set(id, customTicket)
          pendingTickets.set(id, customTicket)
          dispatchIds.add(id)
        }
        if (dispatchIds.size > 0) {
          tasks.push((async () => {
            try {
              const list = await fetchCustomPlans(ctx, undefined, cfgNow, {
                // [R5-02] 工具与 GUI 共用同一份采样事实。
                // [R8-01] 传**本次采集自己的**票据，避免提升别的挂起请求。
                onSampledCredential: (id, fingerprint) => recordSampledCredential(
                  id, fingerprint, customTickets.get(id), customOpSeqs.get(id),
                ),
                isCurrentOperation: (id) => operationMayProceed(id, customTickets.get(id), customOpSeqs.get(id)),
                onlyIds: dispatchIds,
                budgetMs: deadline !== null ? Math.max(1, deadline.remaining()) : undefined,
                signal: deadline !== null ? deadline.signal : undefined,
                // [Q1] 自定义条目同样固定本次采样的**逐条**来源。
                credentialSnapshot: frozenMap !== null ? frozenMap : null,
                // [Z2] 逐条完成即回传：快条目不必等整批。
                // [R3-02] 用该条目**开始时**的票据，重复回传由 publishObservation 去重。
                onItem: (wire) => emit(wire, customTickets.get(wire !== null && wire !== undefined ? wire.id : undefined)),
              })
              if (Array.isArray(list)) {
                for (const wire of list) emit(wire)
              }
            } catch (err) { /* 整批失败按缺失处理 */ }
          })())
        }
        // [Y2] 不等已经悬挂的渠道：到点就返回已完成的部分。
        if (deadline !== null && !deadline.expired) {
          let timer = null
          const guard = new Promise((resolve) => {
            timer = setTimeout(resolve, Math.max(1, deadline.remaining()))
            if (typeof timer.unref === 'function') timer.unref()
          })
          try {
            await Promise.race([Promise.all(tasks), guard])
          } finally {
            if (timer !== null) clearTimeout(timer)
          }
        } else {
          await Promise.all(tasks)
        }
        return results
      },
    })
    if (registered.registered === true) {
      disposed = registered.dispose

      /**
       * [额度自动感知] 配置变化时重读策略配置。
       *
       * 动态 context 每次请求都重新求值，所以这里只需要刷新 `quotaCfg` 缓存，
       * 不再需要重建/注销 section（旧方案的撤销缺陷也随之消失）。
       */
      const refreshPolicySection = () => {
        if (!alive) return
        // [Z3] 配置重载必须作废两秒缓存，否则事件落在缓存窗口内会读回旧策略。
        if (typeof liveConfig.invalidate === 'function') liveConfig.invalidate()
        void Promise.resolve().then(async () => {
          if (!alive) return
          await refreshQuotaCfg()
        }).catch(() => {})
        if (dshGoBridgeSeen) void Promise.resolve().then(policyRefreshTick).catch(() => {})
        void restoreLegacyMimo(true)
      }

      // 订阅宿主公开的配置重载事件（`dsh-settings` 自己也用同一个事件名）。
      let detachConfigReload = null
      try {
        if (typeof ctx.on === 'function') {
          ctx.on('app-boot/config-reload', refreshPolicySection)
          detachConfigReload = () => {
            try {
              if (typeof ctx.off === 'function') ctx.off('app-boot/config-reload', refreshPolicySection)
            } catch (err) { /* 上下文已失活 */ }
          }
        }
      } catch (err) { /* 旧宿主没有事件总线：退化为仅在工具调用时同步 */ }

      refreshPolicySection()

      return () => {
        alive = false
        policyRefreshStop()
        if (detachConfigReload !== null) {
          try { detachConfigReload() } catch (err) { /* 已解绑 */ }
          detachConfigReload = null
        }
        // 观察容器、路由观察器与动态 context 的生命周期在 apply 作用域收尾。
        if (typeof disposed === 'function') {
          try { disposed() } catch (err) { /* 已卸载 */ }
        }
        disposed = null
      }
    }
    // 没有 tools 服务 / 宿主拒绝注册：不抛出，也不留半成品。
    return () => {
      alive = false
    }
  }, 'plan-usage: usage_status tool')
}

/**
 * [0.9.0] 供设置页/测试复用：生成一个不与现有条目冲突的稳定 id。
 * id 由随机串构成，**不可由名称推导**——改名、同名两条记录都不会串数据。
 */
export function allocateCustomId(existing) {
  const taken = new Set(Array.isArray(existing) ? existing : [])
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newCustomId()
    if (!taken.has(id)) return id
  }
  // 极端冲突：退回带随机后缀的形态（仍是合法 id）。
  return 'custom:' + randomUUID().replace(/-/g, '').slice(0, 24)
}
