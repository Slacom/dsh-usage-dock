/**
 * [2026-11-11 Codex 双来源 Host 适配] 定向回归：**全离线、全 fake**。
 *
 * 覆盖（不联网、不起服务、不读真实 cfg/凭据/账号、不 import 任何第三方插件）：
 *   G1 旧 Connect 归一化保持（窗口 / 秒→ISO / remaining=0 / 缺月窗不伪造 / credits / individual）
 *   G2 Subscription 主桶归一化（只取 id==='codex'，附加桶不冒主额度、无 remaining 不造金额）
 *   G3 启用 guard 在 import / read 之前（未启用 ⇒ 零 import、零 store、零 read）
 *   G4 状态路由：两行恒在 / 未装＝未启用 / 已激活未打补丁＝enabled+incompatible / 精确名匹配
 *   G5 选源隔离：只读选中来源，**绝不 fallback**
 *   G6 读取期间 revision 变化 / 服务被替换 / 服务消失 ⇒ source-changed，无 value
 *   G7 失败面：只做精确等值映射，绝不回显任意 message / 原型键混淆
 *   G8 配置摘要：缺省 connect 与旧算法**逐字一致**，subscription 才追加组件
 *   G9 真实 apply：GUI 与 usage_status 用同一份归一，切源后旧观察立即失效
 *   G10 调用形态：readUsage 只收一个 `{signal}` 参数，不传 force/URL
 *
 * 用法：node tools/test-codex-sources.mjs
 *      DSH_INDEX_UNDER_TEST=<stage/index.js> node tools/test-codex-sources.mjs
 *
 * [2026-11-11 装包整顿] `DSH_INDEX_UNDER_TEST` 让同一批断言跑在**要装的那份 index.js 字节**上
 * （与客户端套件的 `DSH_CLIENT_UNDER_TEST` 同款）：默认仍取仓库 `index.js`（指向 stub 的路径），
 * 但 staged 文件在 `.diagnostics/.../staged/` 下没有 `plans/` 兄弟目录，因此这里**默认路径**
 * 仍留在仓库根 —— 只改「Host 半」那一个模块的来源，`plans/**` 各模块照常取仓库版。
 *
 * ⚠️ staged 版要求 `plans/` 侧是本轮交付后的版本（同一次安装会一起覆盖），否则
 * codex-sources 的导出/合同会对不上，那是**安装组合**问题，不是本套件放宽断言的理由。
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
/**
 * Host 半（`index.js`）的来源：env 覆盖 → 否则仓库 `index.js`。
 *
 * 用动态 import 而不是静态 `import ... from '../index.js'`：静态导入无法按 env 换目标，
 * 而 `node --check` 只做语法检查、抓不到「staged 字节少了某个 import」这类问题。
 */
const HOST_UNDER_TEST = process.env.DSH_INDEX_UNDER_TEST
const hostModule = await import(HOST_UNDER_TEST
  ? pathToFileURL(resolve(HOST_UNDER_TEST)).href
  : '../index.js')
const { apply, Config } = hostModule
if (typeof apply !== 'function' || typeof Config !== 'function') {
  throw new Error('Host 模块形状不对（apply/Config 不是函数）：' + (HOST_UNDER_TEST || '../index.js'))
}
console.log('[host-under-test] ' + (HOST_UNDER_TEST ? resolve(HOST_UNDER_TEST) : 'workspace index.js'))
import { PLANS } from '../plans/index.js'
import { TOOL_NAME } from '../plans/usage-tool.js'
import { createCodexPlan, normalizeCodexUsage } from '../plans/codex.js'
import {
  configDigestOf,
  entryPublicIdentity,
  keyRevOf,
  unwrapVolatile,
} from '../plans/custom-balance.js'
import {
  normalizeCodexSource,
  codexSourceOf,
  getCodexSourceState,
  codexRuntimeIdentityOf,
  readCodexSubscriptionService,
  subscriptionFailureOf,
  entryIsActivePlugin,
  CODEX_SOURCE_CONNECT,
  CODEX_SOURCE_SUBSCRIPTION,
} from '../plans/codex-sources.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else {
    failCount++
    console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''))
  }
}

const SECRET_SENTINEL = 'SECRET-TOKEN-SENTINEL-9f3a'

// ---------------------------------------------------------------------------
// 公共夹具：fake ctx / fake 服务 / 两家 usage 投影（全部合成，不含真实数据）
// ---------------------------------------------------------------------------

/** services: { <serviceName>: value }，`get` 抛错由 `throwOn` 指定。 */
function fakeCtx(services, throwOn) {
  const map = services !== null && services !== undefined ? services : {}
  const boom = Array.isArray(throwOn) ? throwOn : []
  return {
    get(name) {
      if (boom.indexOf(name) !== -1) throw new Error('service-getter-boom')
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined
    },
  }
}

/** 只读 service 替身：可观察调用次数/参数形态，可控制 revision 与返回。 */
function fakeSubscriptionService(handler) {
  const calls = []
  const state = { revision: 0 }
  const service = {
    apiVersion: 1,
    async readUsage(...args) {
      calls.push(args)
      return handler(args[0], state)
    },
    getRevision() { return state.revision },
  }
  return { service, calls, state }
}

/** Connect 公开 SDK 替身（`importConnectModule` 注入；绝不加载真实包）。 */
function fakeConnectModule(usage) {
  const seen = { stores: 0, reads: 0 }
  class FakeStore { constructor() { seen.stores += 1 } }
  return {
    seen,
    module: {
      OpenAICodexCredentialStore: FakeStore,
      async readOpenAICodexRateLimits(store) {
        seen.reads += 1
        if (store === undefined) throw new Error('store-missing')
        return usage
      },
    },
  }
}

const CONNECT_USAGE = {
  rateLimits: [
    {
      id: 'codex',
      name: 'Codex',
      windows: [
        { usedPercent: 69, remainingPercent: 31, windowSeconds: 18000, resetAt: 1762000000 },
        { usedPercent: 46, remainingPercent: 54, windowSeconds: 604800, resetAt: 1762500000 },
      ],
    },
    { id: 'code_review', windows: [{ remainingPercent: 99, windowSeconds: 18000 }] },
  ],
  credits: { unlimited: false, balance: '12.50' },
  individualLimit: { limit: '400.00', used: '100.00', remaining: '300.00', remainingPercent: 75 },
}

const SUBSCRIPTION_USAGE = {
  rateLimits: [
    {
      id: 'codex',
      windows: [
        // 0% 是**有效**值（额度用尽），不能被当成缺数据。
        { usedPercent: 100, remainingPercent: 0, windowSeconds: 18000, resetsAt: 1762000000 },
        { usedPercent: 20, remainingPercent: 80, windowSeconds: 604800, resetsAt: 1762500000 },
        { usedPercent: 60, remainingPercent: 40, windowSeconds: 2592000 },
      ],
    },
    // 附加桶：5h 窗口 99%，**不得**顶替主桶的 0%。
    { id: 'code_review', windows: [{ remainingPercent: 99, windowSeconds: 18000, resetsAt: 1762000000 }] },
  ],
  credits: { unlimited: true },
  individualLimit: { limit: '40.00', used: '10.00', remainingPercent: 75 },
  fetchedAt: 1761999000123,
}

const isoOfSeconds = (seconds) => new Date(seconds * 1000).toISOString()

// ===========================================================================
// G1 — 旧 Connect 归一化保持（传 fake 模块，行为必须与旧实现一致）
// ===========================================================================
{
  const fake = fakeConnectModule(CONNECT_USAGE)
  const { fetch } = createCodexPlan({ importConnectModule: async () => fake.module })
  const ctx = fakeCtx({ openaiCodexTransport: { generateImages() {} } })
  const wire = await fetch(ctx, undefined, { codexEnabled: true, codexSource: 'connect' }, {})

  check('G1a Connect wire 带 codexSource=connect', wire.codexSource === CODEX_SOURCE_CONNECT, wire)
  check('G1b 5 小时窗口 = remaining 31 / resetAt 秒→ISO',
    wire.rollingUsage !== null && wire.rollingUsage.percent === 31
    && wire.rollingUsage.resetsAt === isoOfSeconds(1762000000), wire.rollingUsage)
  check('G1c 周窗口 = 54', wire.weeklyUsage !== null && wire.weeklyUsage.percent === 54, wire.weeklyUsage)
  check('G1d 没有月窗口就缺席（不伪造）', wire.monthlyUsage === null, wire.monthlyUsage)
  check('G1e credits 精确十进制字符串原样保留',
    wire.creditsUnlimited === false && wire.creditsBalance === '12.50', wire.creditsBalance)
  check('G1f individualLimit 保留 Connect 的精确 remaining',
    wire.individualLimit !== null && wire.individualLimit.remaining === '300.00'
    && wire.individualLimit.remainingPercent === 75, wire.individualLimit)
  check('G1g 只构造了一次 store、只读一次额度',
    fake.seen.stores === 1 && fake.seen.reads === 1, fake.seen)

  // 只读没有 id==='codex' 的主桶 ⇒ quota-unavailable（不拿附加桶冒充）
  const noBucket = fakeConnectModule({ rateLimits: [{ id: 'code_review', windows: [{ remainingPercent: 99, windowSeconds: 18000 }] }] })
  const { fetch: fetchNoBucket } = createCodexPlan({ importConnectModule: async () => noBucket.module })
  const wire2 = await fetchNoBucket(ctx, undefined, { codexEnabled: true }, {})
  check('G1h 缺主桶 ⇒ quota-unavailable（不冒用附加桶）',
    wire2.error === 'quota-unavailable' && wire2.rollingUsage === undefined, wire2)
}

// ===========================================================================
// G2 — Subscription 主桶归一化
// ===========================================================================
{
  const fake = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const { fetch } = createCodexPlan()
  const ctx = fakeCtx({ codexSubscriptionUsage: fake.service })
  const wire = await fetch(ctx, undefined, { codexEnabled: true, codexSource: 'subscription' }, {})

  check('G2a Subscription wire 带 codexSource=subscription', wire.codexSource === CODEX_SOURCE_SUBSCRIPTION, wire)
  check('G2b remaining=0 是有效值（不被 fallback）',
    wire.rollingUsage !== null && wire.rollingUsage.percent === 0, wire.rollingUsage)
  check('G2c 附加桶 99% 不冒充主桶 0%',
    wire.rollingUsage.percent === 0, wire.rollingUsage)
  check('G2d 周窗 80 / 月窗 40（各自 seconds 匹配）',
    wire.weeklyUsage.percent === 80 && wire.monthlyUsage.percent === 40,
    { weekly: wire.weeklyUsage, monthly: wire.monthlyUsage })
  check('G2e resetsAt 按 Unix 秒转 ISO（不 ×1000 两次）',
    wire.rollingUsage.resetsAt === isoOfSeconds(1762000000), wire.rollingUsage.resetsAt)
  check('G2f 无 resetsAt 的窗口 resetsAt=null（不造日期）',
    wire.monthlyUsage.resetsAt === null, wire.monthlyUsage)
  check('G2g credits.unlimited=true 且不编造余额',
    wire.creditsUnlimited === true && wire.creditsBalance === null, wire)
  check('G2h individualLimit 无 remaining ⇒ null，但保留 remainingPercent',
    wire.individualLimit.remaining === null && wire.individualLimit.remainingPercent === 75,
    wire.individualLimit)
  check('G2i 原采样时间 fetchedAt 如实透传（不假新鲜）',
    wire.fetchedAt === 1761999000123, wire.fetchedAt)

  // 纯函数直接打：不接受非法窗口（NaN / 越界 / 非法 seconds）
  const bad = normalizeCodexUsage({
    rateLimits: [{ id: 'codex', windows: [
      { remainingPercent: 120, windowSeconds: 18000 },
      { remainingPercent: 50, windowSeconds: 1.5 },
      { remainingPercent: null, windowSeconds: 604800 },
    ] }],
  }, { resetKey: 'resetsAt' })
  check('G2j 非法百分比/时长一律舍弃（全空 ⇒ null）', bad === null, bad)
}

// ===========================================================================
// G3 — 启用 guard 必须在 import / read 之前
// ===========================================================================
{
  let imported = 0
  const { fetch } = createCodexPlan({ importConnectModule: async () => { imported += 1; return {} } })
  const wire = await fetch(fakeCtx({}), undefined, { codexEnabled: true, codexSource: 'connect' }, {})
  check('G3a Connect 未启用 ⇒ not-enabled 且零 import', wire.error === 'not-enabled' && imported === 0, { wire, imported })
  check('G3b 未启用 wire 不携带任何窗口/余额',
    wire.rollingUsage === undefined && wire.creditsBalance === undefined, wire)

  const sub = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const { fetch: fetchSub } = createCodexPlan()
  const wireSub = await fetchSub(fakeCtx({}), undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G3c Subscription 未启用 ⇒ not-enabled 且零 readUsage',
    wireSub.error === 'not-enabled' && sub.calls.length === 0, { wireSub, calls: sub.calls.length })

  // guard 通过后才 import：service 合同版本不对 ⇒ incompatible（不是「未启用」）
  const { fetch: fetchIncompat } = createCodexPlan({ importConnectModule: async () => { imported += 1; return {} } })
  const wireIncompat = await fetchIncompat(fakeCtx({ openaiCodexTransport: {} }), undefined,
    { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G3d 选了 subscription 就绝不碰 Connect 通道', imported === 0 && wireIncompat.error === 'not-enabled', { imported, wireIncompat })
}

// ===========================================================================
// G4 — 状态：两行恒在 / 未装＝未启用 / 已激活未打补丁＝enabled+incompatible
// ===========================================================================
{
  const none = getCodexSourceState(fakeCtx({}), { cfg: { codexSource: 'connect' } })
  check('G4a 两行恒在且顺序固定',
    none.sources.length === 2 && none.sources[0].id === 'connect' && none.sources[1].id === 'subscription',
    none.sources)
  check('G4b 两个来源都未安装 ⇒ 都是 enabled:false / compatible:false',
    none.sources.every((s) => s.enabled === false && s.compatible === false), none.sources)
  check('G4c selected 缺省 connect（未知值也回落 connect）',
    none.selected === 'connect'
    && getCodexSourceState(fakeCtx({}), { cfg: { codexSource: 'AUTO-GUESS' } }).selected === 'connect')

  const connectOn = getCodexSourceState(fakeCtx({ openaiCodexTransport: { generateImages() {} } }),
    { cfg: { codexSource: 'connect' } })
  check('G4d Connect 服务在 ⇒ enabled:true / compatible:true',
    connectOn.sources[0].enabled === true && connectOn.sources[0].compatible === true, connectOn.sources[0])

  const patched = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const patchedState = getCodexSourceState(fakeCtx({ codexSubscriptionUsage: patched.service }),
    { cfg: { codexSource: 'subscription' } })
  check('G4e Subscription 只读服务可用 ⇒ enabled:true / compatible:true',
    patchedState.sources[1].enabled === true && patchedState.sources[1].compatible === true,
    patchedState.sources[1])

  // 已安装且已激活，但**没有**只读接口补丁：必须 enabled:true + compatible:false
  const activeEntry = {
    options: { name: 'dsh-codex-subscription', moduleNamespace: 'dsh-codex-subscription' },
    disabled: false,
    fiber: { state: 2, runtime: { name: 'codex-subscription' } },
  }
  const unpatched = getCodexSourceState(fakeCtx({ loader: { entries: [activeEntry] } }),
    { cfg: { codexSource: 'subscription' } })
  check('G4f 已激活未打补丁 ⇒ enabled:true / compatible:false（不冒充未启用）',
    unpatched.sources[1].enabled === true && unpatched.sources[1].compatible === false, unpatched.sources[1])

  const stopped = getCodexSourceState(fakeCtx({
    loader: { entries: [Object.assign({}, activeEntry, { disabled: true })] },
  }), { cfg: { codexSource: 'subscription' } })
  check('G4g 已安装但停用 ⇒ enabled:false / compatible:false（统一「未启用」）',
    stopped.sources[1].enabled === false && stopped.sources[1].compatible === false, stopped.sources[1])

  const notActive = getCodexSourceState(fakeCtx({
    loader: { entries: [Object.assign({}, activeEntry, { fiber: { state: 1, runtime: { name: 'codex-subscription' } } })] },
  }), { cfg: {} })
  check('G4h fiber 非 ACTIVE ⇒ 未启用', notActive.sources[1].enabled === false, notActive.sources[1])

  const spoof = getCodexSourceState(fakeCtx({
    loader: { entries: [{ options: { name: 'my-dsh-codex-subscription-fork' }, disabled: false, fiber: { state: 2 } }] },
  }), { cfg: {} })
  check('G4i 名称只做等值匹配，不接受 substring 冒名', spoof.sources[1].enabled === false, spoof.sources[1])

  const runtimeNameOnly = getCodexSourceState(fakeCtx({
    loader: { entries: [{ options: {}, disabled: false, fiber: { state: 2, runtime: { name: 'codex-subscription' } } }] },
  }), { cfg: {} })
  check('G4j 只凭 runtime.name 的精确命中同样算已激活',
    runtimeNameOnly.sources[1].enabled === true && runtimeNameOnly.sources[1].compatible === false,
    runtimeNameOnly.sources[1])

  // getter 抛错 ⇒ 状态不可证明（unknown:true），由路由 fail-closed
  const boom = getCodexSourceState(fakeCtx({}, ['codexSubscriptionUsage']), { cfg: {} })
  check('G4k getter 抛错 ⇒ unknown:true（不假装未启用）', boom.unknown === true, boom)

  // 合同版本不匹配 ⇒ 在但不兼容
  const wrongVersion = getCodexSourceState(fakeCtx({ codexSubscriptionUsage: { apiVersion: 2, readUsage() {}, getRevision() { return 0 } } }), { cfg: {} })
  check('G4l apiVersion≠1 ⇒ enabled:true / compatible:false',
    wrongVersion.sources[1].enabled === true && wrongVersion.sources[1].compatible === false, wrongVersion.sources[1])

  const badRevision = getCodexSourceState(fakeCtx({
    codexSubscriptionUsage: { apiVersion: 1, readUsage() {}, getRevision() { return -1 } },
  }), { cfg: {} })
  check('G4m revision 非非负安全整数 ⇒ 不兼容', badRevision.sources[1].enabled === true
    && badRevision.sources[1].compatible === false, badRevision.sources[1])

  check('G4n 条目匹配只看公开字段（options.name / moduleNamespace / runtime.name）',
    entryIsActivePlugin(activeEntry, 'dsh-codex-subscription', 'codex-subscription') === true
    && entryIsActivePlugin({ options: { name: 'dsh-codex-subscription' }, disabled: undefined, fiber: { state: 2 } },
      'dsh-codex-subscription', 'codex-subscription') === false)
}

// ===========================================================================
// G5 — 选源隔离：只读选中来源，绝不 fallback
// ===========================================================================
{
  // 选 subscription，服务不可用 + Connect 可用 ⇒ 必须报错、且**不**读 Connect
  let imported = 0
  const fakeConnect = fakeConnectModule(CONNECT_USAGE)
  const { fetch } = createCodexPlan({
    importConnectModule: async () => { imported += 1; return fakeConnect.module },
  })
  const wire = await fetch(fakeCtx({ openaiCodexTransport: { generateImages() {} } }),
    undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G5a 选 subscription 不可用 ⇒ 报错且零 fallback',
    wire.error === 'not-enabled' && wire.codexSource === 'subscription' && imported === 0
    && wire.rollingUsage === undefined, { wire, imported })

  // 选 connect，Subscription 服务可用 ⇒ 不读 subscription
  const sub = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const { fetch: fetchConnect } = createCodexPlan({ importConnectModule: async () => fakeConnect.module })
  const wireConnect = await fetchConnect(fakeCtx({
    openaiCodexTransport: { generateImages() {} },
    codexSubscriptionUsage: sub.service,
  }), undefined, { codexEnabled: true, codexSource: 'connect' }, {})
  check('G5b 选 connect ⇒ 不调用 subscription.readUsage',
    sub.calls.length === 0 && wireConnect.codexSource === 'connect' && wireConnect.rollingUsage.percent === 31,
    { calls: sub.calls.length, wire: wireConnect })

  // 读取用的 service 失败 ⇒ 报错，不尝试 Connect
  imported = 0
  const failing = fakeSubscriptionService(async () => ({ ok: false, code: 'FAILED' }))
  const { fetch: fetchFail } = createCodexPlan({ importConnectModule: async () => { imported += 1; return fakeConnect.module } })
  const wireFail = await fetchFail(fakeCtx({ openaiCodexTransport: {}, codexSubscriptionUsage: failing.service }),
    undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G5c Subscription 读取失败 ⇒ 报错且不 fallback Connect',
    wireFail.error === 'exec' && imported === 0 && wireFail.rollingUsage === undefined, { wireFail, imported })
}

// ===========================================================================
// G6 — 在途变化：revision / 服务替换 / 服务消失 ⇒ 拒旧（无 value）
// ===========================================================================
{
  // revision 在读前读后变化（账号切换 / ABA）
  const bump = fakeSubscriptionService(async () => {
    bump.state.revision += 1
    return { ok: true, value: SUBSCRIPTION_USAGE }
  })
  const { fetch: fetchBump } = createCodexPlan()
  const wireBump = await fetchBump(fakeCtx({ codexSubscriptionUsage: bump.service }),
    undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G6a revision 变化 ⇒ source-changed 且无 value',
    wireBump.error === 'source-changed' && wireBump.rollingUsage === undefined
    && wireBump.transient === true, wireBump)

  // 服务被替换（同一个 ctx.get 在读后返回另一个对象）
  const first = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const second = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  let current = first.service
  const swappingCtx = {
    get(name) {
      if (name !== 'codexSubscriptionUsage') return undefined
      const value = current
      current = second.service // 读后立刻换服务
      return value
    },
  }
  const { fetch: fetchSwap } = createCodexPlan()
  const wireSwap = await fetchSwap(swappingCtx, undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G6b 服务被替换 ⇒ source-changed 且无 value',
    wireSwap.error === 'source-changed' && wireSwap.rollingUsage === undefined, wireSwap)

  // 服务在读取期间消失（卸载）
  let alive = true
  const vanishingCtx = {
    get(name) {
      if (name !== 'codexSubscriptionUsage') return undefined
      if (!alive) return undefined
      alive = false
      return fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE })).service
    },
  }
  const { fetch: fetchGone } = createCodexPlan()
  const wireGone = await fetchGone(vanishingCtx, undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G6c 读取期间服务消失 ⇒ source-changed 且无 value',
    wireGone.error === 'source-changed' && wireGone.rollingUsage === undefined, wireGone)

  // 后续失败也要先判变化：失败结果若发生在变化之后同样按 source-changed
  const changedThenFail = fakeSubscriptionService(async () => {
    changedThenFail.state.revision += 2
    return { ok: false, code: 'FAILED' }
  })
  const { fetch: fetchChangedFail } = createCodexPlan()
  const wireChangedFail = await fetchChangedFail(fakeCtx({ codexSubscriptionUsage: changedThenFail.service }),
    undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G6d 变化优先于失败码 ⇒ source-changed', wireChangedFail.error === 'source-changed', wireChangedFail)

  // 运行时身份摘要：换服务 / revision 前进 / 无服务 都得到不同值
  const a = fakeSubscriptionService(async () => ({ ok: true }))
  const b = fakeSubscriptionService(async () => ({ ok: true }))
  const idA = codexRuntimeIdentityOf(fakeCtx({ codexSubscriptionUsage: a.service }))
  const idA2 = codexRuntimeIdentityOf(fakeCtx({ codexSubscriptionUsage: a.service }))
  a.state.revision += 1
  const idA3 = codexRuntimeIdentityOf(fakeCtx({ codexSubscriptionUsage: a.service }))
  const idB = codexRuntimeIdentityOf(fakeCtx({ codexSubscriptionUsage: b.service }))
  const idNone = codexRuntimeIdentityOf(fakeCtx({}))
  check('G6e 同一服务同一 revision ⇒ 身份稳定', idA === idA2, { idA, idA2 })
  check('G6f revision 前进 / 换服务 / 无服务 ⇒ 身份各不相同',
    new Set([idA, idA3, idB, idNone]).size === 4, { idA, idA3, idB, idNone })
  check('G6g 身份摘要不含账号/路径/令牌形态', /^c[01?]\/s(\d+(@(\d+|x))?|0|\?)$/u.test(idA), idA)
}

// ===========================================================================
// G7 — 失败面：只做精确等值映射，绝不回显任意 message
// ===========================================================================
{
  const withMessage = subscriptionFailureOf({
    ok: false,
    error: { code: 'internal', message: SECRET_SENTINEL, details: { token: SECRET_SENTINEL } },
  })
  check('G7a 任意 message ⇒ generic，且不含原文',
    withMessage.error === 'exec' && !withMessage.message.includes(SECRET_SENTINEL)
    && !JSON.stringify(withMessage).includes(SECRET_SENTINEL), withMessage)

  const proto = subscriptionFailureOf({ ok: false, code: 'constructor' })
  const proto2 = subscriptionFailureOf({ ok: false, code: 'toString' })
  const proto3 = subscriptionFailureOf({ ok: false, error: { message: 'constructor' } })
  check('G7b 原型链键名不被当成已知码',
    proto.error === 'exec' && proto2.error === 'exec' && proto3.error === 'exec', { proto, proto2, proto3 })

  const signedOut = subscriptionFailureOf({
    ok: false, error: { code: 'internal', message: 'ChatGPT subscription is not signed in' },
  })
  check('G7c 固定登录文案 ⇒ signed-out（用自己的固定文案）',
    signedOut.error === 'signed-out' && signedOut.message.includes('登录'), signedOut)

  const renew = subscriptionFailureOf({
    ok: false, error: { code: 'internal', message: 'ChatGPT sign-in needs to be renewed' },
  })
  check('G7d 固定续期文案 ⇒ reauth-required', renew.error === 'reauth-required', renew)

  const similar = subscriptionFailureOf({
    ok: false, error: { code: 'internal', message: 'ChatGPT subscription is not signed in ' + SECRET_SENTINEL },
  })
  check('G7e 相似但不完全相等 ⇒ generic（不做 substring 匹配）', similar.error === 'exec', similar)

  // [终审 B2 整改] 喂 service **真实返回的码**（闭集 5 个）。之前这里喂的是无前缀短名，
  // 正好把「映射表键名错位、5 个真实码一个都命中不了」的问题掩盖掉了。
  const REAL_SERVICE_CODES = [
    ['E_CODEX_USAGE_BAD_REQUEST', 'incompatible', false],
    ['E_CODEX_USAGE_ABORTED', 'exec', true],
    ['E_CODEX_SOURCE_CHANGED', 'source-changed', true],
    ['E_CODEX_USAGE_FAILED', 'exec', false],
    ['E_CODEX_USAGE_NOT_READY', 'exec', true],
  ]
  const codeMisses = []
  for (const [code, expectedError, expectedTransient] of REAL_SERVICE_CODES) {
    const mapped = subscriptionFailureOf({ ok: false, code })
    if (mapped.error !== expectedError || mapped.transient !== expectedTransient) {
      codeMisses.push({ code, mapped, expectedError, expectedTransient })
    }
  }
  check('G7f 真实顶层码逐个命中映射（BAD_REQUEST→incompatible；ABORTED/NOT_READY 暂时；'
    + 'SOURCE_CHANGED→source-changed 暂时；FAILED→exec 非暂时）', codeMisses.length === 0, codeMisses)

  // 负向：无前缀的旧写法**不得**再命中（守住「只有一套键名」，不做前缀剥离的模糊匹配）。
  const legacyBadRequest = subscriptionFailureOf({ ok: false, code: 'BAD_REQUEST' })
  const legacyAborted = subscriptionFailureOf({ ok: false, code: 'ABORTED' })
  const legacyFailed = subscriptionFailureOf({ ok: false, code: 'E_CODEX_USAGE_FAILED ' })
  check('G7f2 无前缀旧写法 BAD_REQUEST 不再命中（落到 generic，非 incompatible）',
    legacyBadRequest.error === 'exec' && legacyBadRequest.transient === false
    && legacyBadRequest.message === 'Codex 额度获取失败', legacyBadRequest)
  check('G7f3 无前缀旧写法 ABORTED 不再命中（generic 非暂时，不是映射的 transient:true）',
    legacyAborted.error === 'exec' && legacyAborted.transient === false, legacyAborted)
  check('G7f4 真实码带首尾空格也不命中（精确等值，不做 trim 猜测）',
    legacyFailed.error === 'exec' && legacyFailed.transient === false
    && legacyFailed.message === 'Codex 额度获取失败', legacyFailed)

  // 端到端：真实码走到 wire 上（不只是映射函数），暂时性必须随行带出。
  const changedService = fakeSubscriptionService(async () => ({ ok: false, code: 'E_CODEX_SOURCE_CHANGED' }))
  const { fetch: fetchChanged } = createCodexPlan()
  const wireChanged = await fetchChanged(fakeCtx({ codexSubscriptionUsage: changedService.service }),
    undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G7f5 真实码 E_CODEX_SOURCE_CHANGED ⇒ wire source-changed + transient:true',
    wireChanged.error === 'source-changed' && wireChanged.transient === true
    && wireChanged.codexSource === 'subscription', wireChanged)

  // 端到端：wire 上不出现哨兵
  const leaky = fakeSubscriptionService(async () => ({
    ok: false,
    error: { code: 'internal', message: SECRET_SENTINEL, details: { url: 'https://secret.example/' + SECRET_SENTINEL } },
  }))
  const { fetch: fetchLeak } = createCodexPlan()
  const wireLeak = await fetchLeak(fakeCtx({ codexSubscriptionUsage: leaky.service }),
    undefined, { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G7g wire 不含哨兵（message/details 都不透）',
    !JSON.stringify(wireLeak).includes(SECRET_SENTINEL), wireLeak)
  check('G7h wire 不含账号/令牌字段',
    !/token|accountId|account_id|authorization/iu.test(JSON.stringify(wireLeak)), wireLeak)
}

// ===========================================================================
// G8 — 配置摘要：缺省 connect 与旧算法逐字一致，subscription 才追加组件
// ===========================================================================
{
  /** 旧算法（本次改动之前的实现）——独立复刻，用来证明「connect 不追加」。 */
  function digest16(text) {
    let h1 = 0x811c9dc5
    let h2 = 0x01000193
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i)
      h1 = (h1 ^ c) >>> 0
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0
      h2 = (h2 ^ (c + i)) >>> 0
      h2 = (h2 + ((h2 << 1) + (h2 << 4) + (h2 << 7) + (h2 << 8) + (h2 << 24))) >>> 0
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8)
  }
  function legacyDigestOf(cfg) {
    const list = unwrapVolatile(cfg != null ? cfg.customBalances : undefined)
    const revs = unwrapVolatile(cfg != null ? cfg.customKeyRev : undefined)
    const rows = Array.isArray(list) ? list : []
    const parts = []
    const seen = new Set()
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const id = typeof row.id === 'string' ? row.id.trim().slice(0, 80) : ''
      if (!/^custom:[A-Za-z0-9_-]{6,64}$/u.test(id) || seen.has(id)) continue
      seen.add(id)
      parts.push(entryPublicIdentity(row) + '\u0002' + String(keyRevOf(revs, id)))
    }
    if (revs !== null && typeof revs === 'object' && !Array.isArray(revs)) {
      const orphan = Object.keys(revs).filter((id) => !seen.has(id)).sort()
      for (const id of orphan) parts.push('orphan:' + id + '\u0002' + String(keyRevOf(revs, id)))
    }
    return digest16(parts.join('\u0003'))
  }

  const customRow = {
    id: 'custom:digestAAAAAA', name: 'A', url: 'https://a.example/b', balancePath: 'data.balance',
    currency: 'usd', enabled: true, credentialRef: '', credentialHost: '', urlHostConfirmed: 'https://a.example',
  }
  const baseCfg = { customBalances: [customRow], customKeyRev: { 'custom:digestAAAAAA': 3 } }

  check('G8a 缺省 codexSource 的摘要与旧算法逐字一致',
    configDigestOf(baseCfg) === legacyDigestOf(baseCfg))
  check('G8b 显式 connect 与缺省一致',
    configDigestOf(Object.assign({ codexSource: 'connect' }, baseCfg)) === legacyDigestOf(baseCfg))
  check('G8c 未知值回落 connect（摘要不变）',
    configDigestOf(Object.assign({ codexSource: 'nonsense' }, baseCfg)) === legacyDigestOf(baseCfg))

  const subDigest = configDigestOf(Object.assign({ codexSource: 'subscription' }, baseCfg))
  const expectedSub = digest16(['builtin:codex-source\u0002subscription',
    entryPublicIdentity(customRow) + '\u0002' + '3'].join('\u0003'))
  check('G8d subscription 追加固定组件（首个位置，固定分隔符）',
    subDigest === expectedSub, { subDigest, expectedSub })
  check('G8e subscription 摘要与 connect 不同（切源必然换 proof）',
    subDigest !== configDigestOf(baseCfg), { subDigest, connect: configDigestOf(baseCfg) })

  const volatileCfg = {
    customBalances: { get: () => [customRow] },
    customKeyRev: { get: () => ({ 'custom:digestAAAAAA': 3 }) },
    codexSource: { get: () => 'subscription' },
  }
  check('G8f volatile 包装同样生效（未解包也一致）', configDigestOf(volatileCfg) === subDigest, configDigestOf(volatileCfg))

  check('G8g 归一函数闭集：只有两值',
    normalizeCodexSource(' Subscription ') === 'subscription'
    && normalizeCodexSource('connect') === 'connect'
    && normalizeCodexSource(undefined) === 'connect'
    && normalizeCodexSource(42) === 'connect'
    && codexSourceOf({ codexSource: 'subscription' }) === 'subscription')
}

// ===========================================================================
// G9 — 真实 apply：GUI 与 usage_status 同一份归一 + 切源后旧观察失效
// ===========================================================================
{
  const routes = {}
  const registered = new Map()
  let reloadHandler = null
  const override = { ref: null }
  const services = {
    webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    tools: {
      register(definition) { registered.set(definition.name, definition); return () => { registered.delete(definition.name) } },
    },
    configEditor: {
      configuration() {
        return [{ entry: { options: { id: 'plan-usage' } }, inherited: {}, override: override.ref || {} }]
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'codexSubscriptionUsage') return services.codexSubscriptionUsage
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
    webServer: services.webServer,
    effect: (fn) => fn(),
    on(name, fn) { if (name === 'app-boot/config-reload') reloadHandler = fn },
    off() {},
  }
  const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
  const snapshot = new Config(Object.assign({}, disabledAll, { codexEnabled: true, codexSource: 'subscription' }))
  override.ref = { codexEnabled: true, codexSource: 'subscription' }
  const sub = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  services.codexSubscriptionUsage = sub.service

  let threw = null
  try { apply(ctx, snapshot) } catch (err) { threw = err }
  check('G9a 真实 apply 不抛错', threw === null, threw && threw.message)
  check('G9b codex-sources 路由已注册', typeof routes['/api/plan-usage/codex-sources'] === 'function')

  const call = async (path, method) => {
    let status, body
    await routes[path]({ method: method || 'GET' }, {
      writeHead(s) { status = s },
      end(text) { body = JSON.parse(text) },
    })
    return { status, body }
  }

  const statusRes = await call('/api/plan-usage/codex-sources')
  check('G9c 状态路由闭集形状',
    statusRes.body.ok === true
    && Array.isArray(statusRes.body.data.sources) && statusRes.body.data.sources.length === 2
    && Object.keys(statusRes.body.data.sources[0]).sort().join(',') === 'compatible,enabled,id,label'
    && Object.keys(statusRes.body.data).sort().join(',') === 'selected,sources',
    statusRes.body)
  check('G9d selected 跟随配置',
    statusRes.body.data.selected === 'subscription'
    && statusRes.body.data.sources[1].enabled === true && statusRes.body.data.sources[1].compatible === true,
    statusRes.body.data)
  const methodRes = await call('/api/plan-usage/codex-sources', 'POST')
  check('G9e 只接受 GET', methodRes.status === 405, methodRes)

  const gui = await call('/api/plan-usage')
  const guiCodex = gui.body.data.plans.find((p) => p.id === 'codex')
  check('G9f GUI 用 subscription 归一（0% 有效 / 带 codexSource）',
    guiCodex !== undefined && guiCodex.error === undefined
    && guiCodex.codexSource === 'subscription'
    && guiCodex.rollingUsage.percent === 0, guiCodex)
  check('G9g GUI 返回配置证明（digest 非空）',
    typeof gui.body.data.cfg.digest === 'string' && gui.body.data.cfg.digest.length === 16, gui.body.data.cfg)

  // usage_status 走同一份 provider 归一（同一次 apply、同一 fake 服务）。
  // 工具投影会有自己的白名单字段名（`scope`），因此按 scope 逐个比对百分比与重置时间。
  const tool = registered.get(TOOL_NAME)
  const toolOut = tool === undefined ? null : await tool.execute({ ids: ['codex'] })
  const toolCodex = toolOut === null ? null : (toolOut.channels || []).find((c) => c.id === 'codex')
  const toolWindows = toolCodex !== null && toolCodex !== undefined && Array.isArray(toolCodex.windows)
    ? toolCodex.windows
    : []
  const toolByScope = Object.fromEntries(toolWindows.map((w) => [w.scope, w]))
  const guiPairs = [
    ['rolling-5h', guiCodex.rollingUsage],
    ['weekly', guiCodex.weeklyUsage],
    ['monthly', guiCodex.monthlyUsage],
  ]
  const sameWindows = guiPairs.every(([scope, guiWindow]) => {
    const hit = toolByScope[scope]
    if (guiWindow === null) return hit === undefined
    return hit !== undefined && hit.percent === guiWindow.percent
      && hit.resetsAt === guiWindow.resetsAt && hit.percentMode === 'remaining'
  })
  check('G9h usage_status 与 GUI 同源同值（逐窗口百分比/重置时间一致）', sameWindows,
    { toolWindows, guiWindows: guiPairs })
  check('G9h2 工具侧同样是 0% 有效值、不 fallback', toolByScope['rolling-5h'] !== undefined
    && toolByScope['rolling-5h'].percent === 0, toolByScope['rolling-5h'])

  // 切源：subscription → connect（未装 Connect）⇒ 立即 not-enabled，不 fallback，proof 变
  override.ref = { codexEnabled: true, codexSource: 'connect' }
  if (typeof reloadHandler === 'function') reloadHandler()
  const switched = await call('/api/plan-usage')
  const switchedCodex = switched.body.data.plans.find((p) => p.id === 'codex')
  check('G9i 切源后 GUI 立即按新来源取数（not-enabled，无 fallback）',
    switchedCodex.error === 'not-enabled' && switchedCodex.codexSource === 'connect'
    && switchedCodex.rollingUsage === undefined, switchedCodex)
  check('G9j 切源后配置证明改变',
    switched.body.data.cfg.digest !== gui.body.data.cfg.digest,
    { before: gui.body.data.cfg.digest, after: switched.body.data.cfg.digest })

  // 旧来源的观测不得继续驱动窗口能力（身份变了）
  const windows = await call('/api/plan-usage/quota-windows')
  const codexWindows = windows.body.data.channels === undefined ? null : windows.body.data.channels.codex
  const noOldWindows = codexWindows === null || codexWindows === undefined
    || codexWindows.status === 'stale-identity'
    || (Array.isArray(codexWindows.windows) && codexWindows.windows.length === 0)
    || (typeof codexWindows === 'object' && Object.keys(codexWindows).length === 0)
  check('G9k 切源后旧 subscription 观察不再提供窗口能力', noOldWindows, codexWindows)

  const statusAfter = await call('/api/plan-usage/codex-sources')
  check('G9l 状态路由 selected 随之更新且 Connect 仍为未启用',
    statusAfter.body.data.selected === 'connect' && statusAfter.body.data.sources[0].enabled === false,
    statusAfter.body.data)
}

// ===========================================================================
// G10 — 调用形态：readUsage 只收一个 { signal } 参数
// ===========================================================================
{
  const sub = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const { fetch } = createCodexPlan()
  await fetch(fakeCtx({ codexSubscriptionUsage: sub.service }), undefined,
    { codexEnabled: true, codexSource: 'subscription' }, { signal: undefined })
  const first = sub.calls[0]
  check('G10a 只传一个参数', sub.calls.length === 1 && first.length === 1, sub.calls.length)
  check('G10b payload 只有一个键 signal', Object.keys(first[0]).join(',') === 'signal', Object.keys(first[0]))
  check('G10c 不传 force / accounts / URL',
    first[0].force === undefined && first[0].accounts === undefined && first[0].url === undefined, first[0])

  const controller = new AbortController()
  const sub2 = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const { fetch: fetch2 } = createCodexPlan()
  await fetch2(fakeCtx({ codexSubscriptionUsage: sub2.service }), undefined,
    { codexEnabled: true, codexSource: 'subscription' }, { signal: controller.signal })
  check('G10d 上游 signal 原样透传（budget 取消能传到 service）',
    sub2.calls[0][0].signal === controller.signal, sub2.calls[0][0].signal === controller.signal)
}

// ===========================================================================
// G11 — 成功分支必须校验 value 形状（N3）：非对象 value ⇒ exec 非暂时，且不伪造任何数值
// ===========================================================================
{
  const badValues = [undefined, null, 'usage', 42, []]
  const rows = []
  for (const bad of badValues) {
    const svc = fakeSubscriptionService(async () => ({ ok: true, value: bad }))
    const { fetch } = createCodexPlan()
    try {
      rows.push({
        bad: String(bad),
        wire: await fetch(fakeCtx({ codexSubscriptionUsage: svc.service }), undefined,
          { codexEnabled: true, codexSource: 'subscription' }, {}),
      })
    } catch (err) {
      // 修复前 `value:null` 会在这里抛 TypeError（外层 `.catch` 才兜住）。
      rows.push({ bad: String(bad), threw: String(err && err.message) })
    }
  }
  const shapeOk = rows.every((row) => row.wire !== undefined && row.wire.error === 'exec'
    && row.wire.transient !== true && row.wire.message === 'Codex 额度获取失败'
    && row.wire.codexSource === 'subscription'
    && row.wire.rollingUsage === undefined && row.wire.weeklyUsage === undefined
    && row.wire.monthlyUsage === undefined && row.wire.creditsBalance === undefined
    && row.wire.individualLimit === undefined)
  check('G11a value 非对象（undefined/null/字符串/数字/数组）⇒ exec 非暂时，且不伪造窗口/百分比/credits',
    shapeOk, rows)

  // 对照：合法对象仍然成功归一（守卫不得误杀）
  const good = fakeSubscriptionService(async () => ({ ok: true, value: SUBSCRIPTION_USAGE }))
  const { fetch: fetchGood } = createCodexPlan()
  const goodWire = await fetchGood(fakeCtx({ codexSubscriptionUsage: good.service }), undefined,
    { codexEnabled: true, codexSource: 'subscription' }, {})
  check('G11b 合法对象 value 仍正常归一（守卫未误杀；0% 仍是有效值）',
    goodWire.error === undefined && goodWire.rollingUsage !== null && goodWire.rollingUsage.percent === 0, goodWire)
}

// ===========================================================================
// G12 — 作废行保留来源身份（N2）：`guiObservationWire()` 的 revoked 行必须带 codexSource
// ===========================================================================
//
// 复现路径（全 fake、离线）：GUI 请求读 subscription 期间**来源身份变化**（这里用
// `getRevision()` 前进模拟账号切换）⇒ `publishObservation` 拒收该 wire ⇒ 路由把这一条
// 改写成「本次采集已作废」。修复前该对象没有 `codexSource`，客户端渲染层会按
// 「wire 来源 ≠ 已保存来源」把它**整行滤掉**（用户看不到「本次采集已作废」）。
{
  const routes = {}
  const override = { ref: { codexEnabled: true, codexSource: 'subscription' } }
  const services = {
    webServer: { port: 12345, register(spec) { routes[spec.path] = spec.handler; return () => {} } },
    configEditor: {
      configuration() {
        return [{ entry: { options: { id: 'plan-usage' } }, inherited: {}, override: override.ref }]
      },
    },
  }
  const ctx = {
    get(name) { return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined },
    webServer: services.webServer,
    effect: (fn) => fn(),
    on() {},
    off() {},
  }
  const disabledAll = Object.fromEntries(PLANS.map((p) => [p.fields.enabled, false]))
  const snapshot = new Config(Object.assign({}, disabledAll, { codexEnabled: true, codexSource: 'subscription' }))

  // 可闸控的只读 service：先让读取挂住，再在「读取期间」推进 revision（= 订阅账号切换）。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const gated = fakeSubscriptionService(async () => { await gate; return { ok: true, value: SUBSCRIPTION_USAGE } })
  services.codexSubscriptionUsage = gated.service

  let applyError = null
  try { apply(ctx, snapshot) } catch (err) { applyError = err }
  check('G12a 真实 apply 不抛错（N2 夹具）', applyError === null, applyError && applyError.message)

  let body = null
  const pending = routes['/api/plan-usage']({ method: 'GET' }, {
    writeHead() {},
    end(text) { body = text },
  })
  // 让 handler 真正推进到 `readUsage()`（它 await 在闸门上），再改身份并放行。
  await new Promise((resolve) => setTimeout(resolve, 10))
  gated.state.revision += 1
  release()
  await pending

  const parsed = body === null ? null : JSON.parse(body)
  const codexRow = parsed === null ? undefined : parsed.data.plans.find((p) => p.id === 'codex')
  check('G12b 读取期间身份变化 ⇒ codex 条目被改写成「本次采集已作废」',
    codexRow !== undefined && codexRow.cancelled === true && codexRow.error === 'cancelled', codexRow)
  check('G12c 作废行保留 codexSource（否则订阅态下渲染层把它整行滤掉）',
    codexRow !== undefined && codexRow.codexSource === 'subscription', codexRow)
  check('G12d 作废行不伪造数字/窗口',
    codexRow !== undefined && codexRow.rollingUsage === undefined
    && codexRow.weeklyUsage === undefined && codexRow.balance === undefined, codexRow)
}

console.log('\n' + passCount + ' passed, ' + failCount + ' failed')
if (failCount > 0) process.exitCode = 1
