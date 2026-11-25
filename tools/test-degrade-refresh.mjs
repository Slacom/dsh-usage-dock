/**
 * 0.8.0 回归测试：失败降级 + 余额取整 + 点击强刷（离线，复用 tools/mock-react.mjs）。
 *
 * 背景（roadmap 方向 2/3 定稿）：
 *   - 取数失败先保留上次成功值、灰字弱化；连续 2 轮失败才显示「获取失败」；
 *   - 余额向下取整到分（toFixed 的四舍五入会「比设置页多一分」）；
 *   - 点开详情面板立即强刷（作废 in-flight 请求重拉）；
 *   - 轮询请求挂起不能永久停摆（AbortController 20s 超时 + settle 复位）。
 *   - classic 峰谷时间条 / 充值按钮 / MiMo 渠道渲染。
 *
 * 运行时与加载器见 tools/mock-react.mjs（0.8.0 起补了 window/document 事件目标）。
 * 用法：node tools/test-degrade-refresh.mjs
 */
import { createRuntime, loadClient, textOf, API_PAYLOAD } from './mock-react.mjs'

let passCount = 0
let failCount = 0

function check(name, cond, detail) {
  if (cond) {
    passCount++
    console.log('[PASS] ' + name)
  } else {
    failCount++
    console.log('[FAIL] ' + name + (detail ? ' — ' + detail : ''))
  }
}

/** 收集子树里的元素（type 为字符串的节点；无 hooks 的函数组件展开一层——PeakBar）。 */
function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 8) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      // mock 运行时只渲染根组件；这里手动展开一层无 hooks 的函数组件（PeakBar）。
      // 带 hooks 的组件（TopUpOverlay）在 mock 上下文外调用会抛错——跳过不展开。
      try {
        elementsOf(runtime.renderIsolated(node.type, node.props), out, depth + 1)
      } catch (err) { /* hooks 组件跳过 */ }
    }
  }
  return out
}

const runtime = createRuntime()
const client = loadClient(runtime, { payload: API_PAYLOAD })
const Badge = client.Badge

const WIDE = { configForm: null, wide: true }

/** 基于 elementsOf 的文本收集（会展开 PeakBar 这类函数组件；mock 的 textOf 不会）。 */
function textAll(tree) {
  return elementsOf(tree).map((el) => textOf(el)).join('')
}

function pillOf(tree) {
  const kids = tree && tree.props ? tree.props.children : []
  return Array.isArray(kids) ? kids[0] : null
}

/** 换一轮 fetch 实现 → focus 强刷 → 等 promise 链落定。 */
async function refreshWith(fetchImpl) {
  globalThis.fetch = fetchImpl
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 30))
  return await runtime.settle(WIDE)
}

// ---------------------------------------------------------------------------
// T1 余额向下取整到分：34.31662152 → 34.31（不是 34.32）
// ---------------------------------------------------------------------------
{
  runtime.mount(Badge, WIDE)
  const payload = {
    ok: true,
    data: {
      plans: [
        { id: 'deepseek', name: 'DeepSeek', balance: 34.31662152, isAvailable: true, via: 'account', warnThreshold: 10 },
      ],
    },
  }
  const tree = await refreshWith(async () => ({ json: async () => payload }))
  const text = textOf(tree)
  check('T1 余额向下取整到分（34.31662152 → ¥ 34.31）', text.includes('¥ 34.31') && !text.includes('¥ 34.32'), text)
}

// ---------------------------------------------------------------------------
// T2 失败保留旧值：第 1 轮失败 → 胶囊仍显示旧余额（灰字弱化）
// ---------------------------------------------------------------------------
{
  let failing = false
  const tree1 = await refreshWith(async () => {
    if (failing) throw new Error('network down')
    return { json: async () => API_PAYLOAD }
  })
  check('T2.pre 成功轮显示余额', textOf(tree1).includes('¥ 7.38'))

  failing = true
  const tree2 = await refreshWith(globalThis.fetch)
  const text2 = textOf(tree2)
  check('T2 第 1 轮失败保留旧值 ¥ 7.38', text2.includes('¥ 7.38'), text2)
  const valueRow = elementsOf(tree2).find((el) => el.props && el.props.style
    && el.props.style.color === 'var(--dsw-alias-label-tertiary)')
  check('T2 降级数值使用灰色弱化', valueRow !== undefined)
}

// ---------------------------------------------------------------------------
// T3 连续失败达阈值（0.8.3: 2→5；0.8.5: →8；**[A04] 0.9.0: →5**）→ 显示「获取失败」
//    （且不再拿旧余额顶替）
// ---------------------------------------------------------------------------
{
  // T2 已经失败 1 轮；这里再失败 5 轮 → 共 7 轮，仍未到阈值 8。
  let tree = await refreshWith(globalThis.fetch)
  check('T3.pre 第 2 轮失败仍保留旧值（阈值 5，未到）', textOf(tree).includes('¥ 7.38'), textOf(tree))
  for (let i = 0; i < 2; i++) tree = await refreshWith(globalThis.fetch)
  check('T3.pre2 第 4 轮失败仍保留旧值（阈值 5，未到）', textOf(tree).includes('¥ 7.38'), textOf(tree))
  for (let i = 0; i < 2; i++) tree = await refreshWith(globalThis.fetch)
  const text = textOf(tree)
  check('T3 连续 8 轮失败显示「获取失败」', text.includes('获取失败'), text)
  check('T3 失败后不再显示旧余额', !text.includes('¥ 7.38'), text)
}
// ---------------------------------------------------------------------------
// T4 恢复：成功后旧值替换、降级样式消失
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(async () => ({ json: async () => API_PAYLOAD }))
  check('T4 恢复后重新显示余额', textOf(tree).includes('¥ 7.38'))
  const grayRows = elementsOf(tree).filter((el) => el.props && el.props.style
    && el.props.style.color === 'var(--dsw-alias-label-tertiary)')
  check('T4 恢复后无灰色降级样式', grayRows.length === 0)
}

// ---------------------------------------------------------------------------
// T5 请求挂起不卡死轮询：挂起的旧请求被强刷作废后轮询恢复
// ---------------------------------------------------------------------------
{
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const tree = await refreshWith(async () => {
    calls++
    if (calls === 1) {
      await gate // 第 1 次调用挂起（模拟网络停滞）
      return { json: async () => API_PAYLOAD }
    }
    return { json: async () => API_PAYLOAD }
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const finalTree = await runtime.settle(WIDE)
  check('T5 挂起请求作废后轮询恢复、显示正常余额', textOf(finalTree).includes('¥ 7.38'))
}

// ---------------------------------------------------------------------------
// T6 点击胶囊展开 → 触发一次强制刷新（fetch 调用数 +1）
// ---------------------------------------------------------------------------
{
  let calls = 0
  const tree = await refreshWith(async () => {
    calls++
    return { json: async () => API_PAYLOAD }
  })
  const before = calls
  const pill = pillOf(tree)
  check('T6.pre 胶囊为可点击 button', pill !== undefined && pill.type === 'button')
  pill.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await runtime.settle(WIDE)
  check('T6 点击展开触发立即刷新', calls > before, 'calls=' + calls + ' before=' + before)
}

// ---------------------------------------------------------------------------
// T7 峰谷时间条（classic）：账号登录 + peakPhase 时渲染；API Key 模式不渲染
// ---------------------------------------------------------------------------
async function openPanel(payload) {
  await refreshWith(async () => ({ json: async () => payload }))
  let tree = await runtime.settle(WIDE)
  const pill = pillOf(tree)
  // open 状态跨用例保留（mock 无卸载）：面板未开才点击，保证幂等。
  if (pill.props['aria-expanded'] !== true) {
    pill.props.onClick()
    tree = await runtime.settle(WIDE)
  }
  return tree
}

{
  const payloadWithPhase = {
    ok: true,
    data: {
      plans: [
        {
          id: 'deepseek', name: 'DeepSeek', balance: 20.5, isAvailable: true,
          via: 'account', warnThreshold: 10,
          peakPhase: {
            inPeak: true, weekend: false,
            prevAtMs: Date.now() - 3600e3, nextAtMs: Date.now() + 1800e3, nextIntoPeak: false,
          },
        },
      ],
    },
  }
  const tree = await openPanel(payloadWithPhase)
  const text = textAll(tree)
  // 0.8.1 定稿文案：灰字「高峰时段 · 约…后进入空闲时段」。
  check('T7 账号登录显示高峰时段文案', text.includes('高峰时段') && text.includes('后进入空闲时段'), text)

  // [0.8.3] 峰谷条不再限定账号模式：API Key 计费同样按平台峰谷规则，
  // 因此 Host 会给 API Key 条目也附 peakPhase/peakSegs（见 index.js）。
  const payloadApiPhase = {
    ok: true,
    data: {
      plans: [{
        id: 'deepseek', name: 'DeepSeek', balance: 20.5, isAvailable: true, via: 'api', warnThreshold: 10,
        peakPhase: {
          inPeak: false, weekend: false,
          prevAtMs: Date.now() - 600e3, nextAtMs: Date.now() + 3600e3, nextIntoPeak: true,
        },
      }],
    },
  }
  const tree3 = await openPanel(payloadApiPhase)
  const text3 = textAll(tree3)
  check('T7 API Key 模式也显示峰谷条（0.8.3 放宽）', text3.includes('空闲时段'), text3)

  // 完全没有 peakPhase 的条目（旧 Host / 未来结构变化）仍不渲染峰谷条。
  const payloadNoPhase = {
    ok: true,
    data: {
      plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 20.5, isAvailable: true, via: 'api', warnThreshold: 10 }],
    },
  }
  const tree2 = await openPanel(payloadNoPhase)
  const text2 = textAll(tree2)
  check('T7 无 peakPhase 时不显示峰谷条（旧 Host 兼容）', !text2.includes('高峰时段') && !text2.includes('空闲时段'), text2)
}

// ---------------------------------------------------------------------------
// T8 充值入口已移除（0.8.1 回退）：任何环境下都不应渲染「充值」按钮
// ---------------------------------------------------------------------------
{
  globalThis.window.dshPlatform = {
    open() { return Promise.resolve() },
  }
  const payload = {
    ok: true,
    data: {
      plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 4.42, isAvailable: true, via: 'account', warnThreshold: 10 }],
    },
  }
  const tree = await openPanel(payload)
  let btn = elementsOf(tree).find((el) => el.type === 'button' && textOf(el) === '充值')
  check('T8 账号登录 + 桥 → 无充值按钮（已移除）', btn === undefined)

  const payloadApi = {
    ok: true,
    data: {
      plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 4.42, isAvailable: true, via: 'api', warnThreshold: 10 }],
    },
  }
  const tree2 = await openPanel(payloadApi)
  btn = elementsOf(tree2).find((el) => el.type === 'button' && textOf(el) === '充值')
  check('T8 API Key 模式无充值按钮', btn === undefined)

  delete globalThis.window.dshPlatform
  const tree3 = await openPanel(payload)
  btn = elementsOf(tree3).find((el) => el.type === 'button' && textOf(el) === '充值')
  check('T8 无桥（浏览器/移动端）无充值按钮', btn === undefined)
  // 低余额提示引导到官方设置入口。
  const text3 = textAll(tree3)
  check('T8b 低余额提示引导「设置 → 账号与余额」', text3.includes('设置 → 账号与余额'), text3)
}

// ---------------------------------------------------------------------------
// T9 MiMo 渠道：只有普通 API Key wire（0.11.4 删除显示会话 / displaySource / 覆盖层）
// ---------------------------------------------------------------------------
{
  const payload = {
    ok: true,
    data: {
      plans: [{
        id: 'mimo', name: 'Xiaomi MiMo', balance: 16.48, cashBalance: 16.48, giftBalance: 0,
        currency: 'CNY', isAvailable: true, via: 'api-key', warnThreshold: 10,
      }],
    },
  }
  const tree = await refreshWith(async () => ({ json: async () => payload }))
  const pillText = textOf(tree)
  check('T9 MiMo 余额按普通 wire 直接上胶囊（Xiaomi MiMo 16.48）',
    pillText.includes('Xiaomi MiMo') && pillText.includes('16.48'), pillText)
  check('T9 客户端不再导出 MiMo 登录 / 显示会话模块',
    Object.keys(client.module).every((key) => !/^mimo(Display|Auth|Login|Remember)/.test(key)),
    Object.keys(client.module).filter((k) => /mimo/i.test(k)))
  const opened = await openPanel(payload)
  const panelText = textAll(opened)
  check('T9 详情面板保留现金 / 赠送明细（面板据此分行）',
    panelText.includes('现金余额') && panelText.includes('赠送余额'), panelText.slice(0, 300))
}

// T10 MiMo 低余额：红灯判据来自 wire 余额与 warnThreshold（无显示层覆盖）
// ---------------------------------------------------------------------------
{
  const payload = {
    ok: true,
    data: {
      plans: [{ id: 'mimo', name: 'Xiaomi MiMo', balance: 5.2, currency: 'CNY', isAvailable: true, via: 'api-key', warnThreshold: 10 }],
    },
  }
  const tree = await refreshWith(async () => ({ json: async () => payload }))
  const lowText = textOf(tree)
  check('T10 低余额 5.2 仍按 wire 显示（不被显示会话遮蔽）', lowText.includes('5.20'), lowText)
  const redDot = elementsOf(tree).find((el) => el.props && el.props.style
    && el.props.style.background === 'var(--dsw-alias-state-error-primary)')
  check('T10 余额 5.2 < 阈值 10 ⇒ 状态点转红', redDot !== undefined)
  const high = await refreshWith(async () => ({
    json: async () => ({
      ok: true,
      data: { plans: [{ id: 'mimo', name: 'Xiaomi MiMo', balance: 16.48, currency: 'CNY', isAvailable: true, via: 'api-key', warnThreshold: 10 }] },
    }),
  }))
  const noRed = elementsOf(high).find((el) => el.props && el.props.style
    && el.props.style.background === 'var(--dsw-alias-state-error-primary)')
  check('T10 对照：余额 16.48 > 阈值 10 不红', noRed === undefined)
}

// ---------------------------------------------------------------------------
// T11 [2026-11-23 B1] WorkBuddy 退场：即使旧 Host 仍返回 `workbuddy` / `workbuddy-ai`
// 的 wire，客户端也不画行、不渲染积分符号；清单外的未知内置 id 同样丢弃，自定义条目不受影响。
// ---------------------------------------------------------------------------
{
  const payload = {
    ok: true,
    data: {
      plans: [
        { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
        {
          id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 3401.5, creditsUnlimited: false,
          creditsAccounts: [{ variant: 'WorkBuddy', packageName: '企业额度', remain: 3401.5 }],
          variants: [{ label: 'WorkBuddy', total: 3401.5, unlimited: false }],
          isAvailable: true,
        },
        {
          id: 'workbuddy-ai', name: 'WorkBuddy AI', creditsTotal: 349, creditsUnlimited: false,
          variants: [{ label: 'WorkBuddy AI', total: 349, unlimited: false }],
          isAvailable: true,
        },
        // 既不在 PLANS 也不在退场清单的旧内置 id：白名单守卫应直接丢弃（B1 根因回归）。
        { id: 'old-plan-x', name: 'OldPlanX', balance: 3, isAvailable: true },
        // 自定义渠道（custom:*）不能被白名单守卫误杀。
        {
          id: 'custom:abcdef123456', name: '自定义渠道A', custom: true, balance: 12.3,
          isAvailable: true, enabled: true,
        },
      ],
    },
  }
  const tree = await refreshWith(async () => ({ json: async () => payload }))
  const pillText = textOf(tree)
  check('T11a 退场渠道不出现在胶囊里',
    !pillText.includes('WorkBuddy') && !pillText.includes('workbuddy-ai') && !pillText.includes('WorkBuddy AI'), pillText)
  check('T11b 不再渲染积分符号/数值（无 ✦、无 3,401.5 / 349）',
    !pillText.includes('✦') && !pillText.includes('3,401.5') && !pillText.includes('349'), pillText)
  check('T11c 清单外的未知内置 id 也不画行（不再回退成「id 当名字」）',
    !pillText.includes('OldPlanX') && !pillText.includes('old-plan-x'), pillText)
  check('T11d 自定义条目不受白名单守卫影响（custom:* 仍显示）',
    pillText.includes('自定义渠道A'), pillText)
  const opened = await openPanel(payload)
  const text = textAll(opened)
  check('T11e 详情面板也没有 WorkBuddy / workbuddy-ai 行',
    !text.includes('WorkBuddy') && !text.includes('workbuddy-ai'), text.slice(0, 200))
  check('T11f 详情面板也没有未知内置 id', !text.includes('OldPlanX'), text.slice(0, 200))
  check('T11g 详情面板仍显示自定义条目', text.includes('自定义渠道A'), text.slice(0, 200))
  check('T11h 真实渠道仍显示（DeepSeek ¥7.38）', text.includes('¥ 7.38') || text.includes('7.38'), text.slice(0, 160))
}

// T12 旧请求已进入 JSON 解析，abort 也不能阻止其迟到；不得覆盖强刷结果。
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let parsing = false
  globalThis.fetch = async () => ({ json: async () => { parsing = true; await gate; return API_PAYLOAD } })
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('T12.pre 旧响应正在解析', parsing)
  const latest = { ok: true, data: { plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 88.88, isAvailable: true, via: 'api' }] } }
  await refreshWith(async () => ({ json: async () => latest }))
  release()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const tree = await runtime.settle(WIDE)
  check('T12 迟到旧响应不覆盖新余额', textOf(tree).includes('¥ 88.88') && !textOf(tree).includes('¥ 7.38'))
}
// T13 登录/配置错误不参与传输失败降级，立即清除旧值。
{
  for (const error of ['no-key', 'signed-out', 'reauth-required', 'api']) {
    await refreshWith(async () => ({ json: async () => API_PAYLOAD }))
    const payload = { ok: true, data: { plans: [{ id: 'deepseek', name: 'DeepSeek', error, message: '凭据失效' }] } }
    const tree = await refreshWith(async () => ({ json: async () => payload }))
    check('T13 ' + error + ' 不沿用旧余额', !textOf(tree).includes('¥ 7.38'))
  }
}
// T14 裁剪 WebView 没有 AbortController：请求身份仍然隔离。
{
  const original = globalThis.AbortController
  try {
    globalThis.AbortController = undefined
    let release
    const gate = new Promise((resolve) => { release = resolve })
    globalThis.fetch = async () => ({ json: async () => { await gate; return API_PAYLOAD } })
    client.windowEvents.dispatch('focus')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const latest = { ok: true, data: { plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 66.66, isAvailable: true }] } }
    await refreshWith(async () => ({ json: async () => latest }))
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    check('T14 无 AbortController 时迟到响应仍被忽略', textOf(await runtime.settle(WIDE)).includes('¥ 66.66'))
  } finally { globalThis.AbortController = original }
}

client.restore()
console.log(failCount === 0
  ? '\n全部 ' + (passCount + failCount) + ' 项：' + passCount + ' 通过, 0 失败'
  : '\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
