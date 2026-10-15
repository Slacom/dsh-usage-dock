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
  check('T1 余额向下取整到分（34.31662152 → ¥34.31）', text.includes('¥34.31') && !text.includes('¥34.32'), text)
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
  check('T2.pre 成功轮显示余额', textOf(tree1).includes('¥7.38'))

  failing = true
  const tree2 = await refreshWith(globalThis.fetch)
  const text2 = textOf(tree2)
  check('T2 第 1 轮失败保留旧值 ¥7.38', text2.includes('¥7.38'), text2)
  const valueRow = elementsOf(tree2).find((el) => el.props && el.props.style
    && el.props.style.color === 'var(--dsw-alias-label-tertiary)')
  check('T2 降级数值使用灰色弱化', valueRow !== undefined)
}

// ---------------------------------------------------------------------------
// T3 连续 2 轮失败 → 显示「获取失败」（且不再拿旧余额顶替）
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(globalThis.fetch)
  const text = textOf(tree)
  check('T3 连续 2 轮失败显示「获取失败」', text.includes('获取失败'), text)
  check('T3 失败后不再显示旧余额', !text.includes('¥7.38'), text)
}

// ---------------------------------------------------------------------------
// T4 恢复：成功后旧值替换、降级样式消失
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(async () => ({ json: async () => API_PAYLOAD }))
  check('T4 恢复后重新显示余额', textOf(tree).includes('¥7.38'))
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
  check('T5 挂起请求作废后轮询恢复、显示正常余额', textOf(finalTree).includes('¥7.38'))
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

  const payloadNoPhase = {
    ok: true,
    data: {
      plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 20.5, isAvailable: true, via: 'api', warnThreshold: 10 }],
    },
  }
  const tree2 = await openPanel(payloadNoPhase)
  const text2 = textAll(tree2)
  check('T7 API Key 模式不显示峰谷条', !text2.includes('高峰时段') && !text2.includes('空闲时段'), text2)
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
// T9 MiMo 渠道：胶囊显示带币种余额，面板显示现金/赠送明细
// ---------------------------------------------------------------------------
{
  const payload = {
    ok: true,
    data: {
      plans: [
        {
          id: 'mimo', name: '小米 MiMo', balance: 16.48, cashBalance: 16.48,
          giftBalance: 0, currency: 'CNY', isAvailable: true, via: 'console', warnThreshold: 10,
        },
      ],
    },
  }
  await refreshWith(async () => ({ json: async () => payload }))
  let tree = await runtime.settle(WIDE)
  check('T9 胶囊显示 MiMo 余额 ¥16.48', textOf(tree).includes('¥16.48'), textOf(tree))
  tree = await openPanel(payload)
  const text = textOf(tree)
  check('T9 面板显示现金余额明细', text.includes('现金余额'), text)
  check('T9 面板显示赠送余额明细', text.includes('赠送余额'), text)

  const payloadUsd = {
    ok: true,
    data: {
      plans: [{ id: 'mimo', name: '小米 MiMo', balance: 25.51, cashBalance: 20, giftBalance: 5.51, currency: 'USD', isAvailable: true, via: 'console', warnThreshold: 10 }],
    },
  }
  const tree2 = await refreshWith(async () => ({ json: async () => payloadUsd }))
  check('T9 USD 币种显示 $ 符号', textOf(tree2).includes('$25.51'), textOf(tree2))
}

// ---------------------------------------------------------------------------
// T10 MiMo 低余额红灯
// ---------------------------------------------------------------------------
{
  const payload = {
    ok: true,
    data: {
      plans: [{ id: 'mimo', name: '小米 MiMo', balance: 5.2, cashBalance: 5.2, giftBalance: 0, currency: 'CNY', isAvailable: true, via: 'console', warnThreshold: 10 }],
    },
  }
  const tree = await refreshWith(async () => ({ json: async () => payload }))
  const dot = elementsOf(tree).find((el) => el.props && el.props.style
    && el.props.style.background === 'var(--dsw-alias-state-error-primary)')
  check('T10 低余额状态灯转红', dot !== undefined)
}

// ---------------------------------------------------------------------------
// T11 WorkBuddy 积分渠道：胶囊「（积分）」后缀 + 明细自适应列表
// ---------------------------------------------------------------------------
{
  // 少量明细（≤3 行）：普通文字铺开，无滚动容器。
  const few = {
    ok: true,
    data: {
      plans: [{
        id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 3401.5, creditsUnlimited: false,
        creditsAccounts: [{ variant: 'WorkBuddy', packageName: '企业额度', remain: 3401.5, size: null, endTimeMs: null }],
        variants: [{ label: 'WorkBuddy', total: 3401.5, unlimited: false }],
        isAvailable: true,
      }],
    },
  }
  let tree = await refreshWith(async () => ({ json: async () => few }))
  check('T11a 胶囊显示「3,401.5（积分）」', textOf(tree).includes('3,401.5（积分）'), textOf(tree))
  tree = await openPanel(few)
  let text = textAll(tree)
  check('T11b 少量明细以文字铺开（无滚动容器）', text.includes('企业额度') && !text.includes('积分来自'), text)
  check('T11b2 无「WorkBuddy：合计」小计行（与合计重复，用户定稿移除）', !text.includes('WorkBuddy：3,401.5'), text)
  const scrollers = elementsOf(tree).filter((el) => el.props && el.props.style
    && el.props.style.overflowY === 'auto' && typeof el.props.style.maxHeight === 'number')
  // 面板本体也是滚动容器（maxHeight:'70vh' 字符串），这里只断言**数值高度**的
  // 明细列表不存在——少量明细不应产生固定高度的滚动列表。
  check('T11c 少量明细不出固定高度滚动列表', scrollers.length === 0)

  // 大量明细（>3 行）：收进 maxHeight 列表，滚动条避让（paddingRight）。
  const manyAccounts = []
  for (let i = 1; i <= 6; i++) {
    manyAccounts.push({ variant: 'WorkBuddy', packageName: '套餐 ' + i, remain: 100 * i, size: 1000, endTimeMs: null })
  }
  const many = {
    ok: true,
    data: {
      plans: [{
        id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 2100, creditsUnlimited: false,
        creditsAccounts: manyAccounts,
        variants: [{ label: 'WorkBuddy', total: 2100, unlimited: false }],
        isAvailable: true,
      }],
    },
  }
  tree = await refreshWith(async () => ({ json: async () => many }))
  tree = await openPanel(many)
  text = textAll(tree)
  check('T11d 大量明细文字仍在（滚动列表渲染）', text.includes('套餐 6'), text)
  const list = elementsOf(tree).find((el) => el.props && el.props.style
    && el.props.style.overflowY === 'auto' && typeof el.props.style.maxHeight === 'number')
  check('T11e 明细收进固定高度列表', list !== undefined, null)
  if (list) {
    check('T11f 列表滚动条避让（paddingRight 预留）', list.props.style.paddingRight >= 8, list.props.style.paddingRight)
    check('T11g maxHeight 已设置（72px，用户定稿）', list.props.style.maxHeight === 72, list.props.style.maxHeight)
  }
  check('T11h 无「积分来自」脚注（用户定稿移除）', !text.includes('积分来自'), text)
  check('T11i 列表高度扩大一倍（72px）', list !== undefined && list.props.style.maxHeight === 72, list ? list.props.style.maxHeight : null)
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
  check('T12 迟到旧响应不覆盖新余额', textOf(tree).includes('¥88.88') && !textOf(tree).includes('¥7.38'))
}
// T13 登录/配置错误不参与传输失败降级，立即清除旧值。
{
  for (const error of ['no-key', 'signed-out', 'reauth-required', 'api']) {
    await refreshWith(async () => ({ json: async () => API_PAYLOAD }))
    const payload = { ok: true, data: { plans: [{ id: 'deepseek', name: 'DeepSeek', error, message: '凭据失效' }] } }
    const tree = await refreshWith(async () => ({ json: async () => payload }))
    check('T13 ' + error + ' 不沿用旧余额', !textOf(tree).includes('¥7.38'))
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
    check('T14 无 AbortController 时迟到响应仍被忽略', textOf(await runtime.settle(WIDE)).includes('¥66.66'))
  } finally { globalThis.AbortController = original }
}

client.restore()
console.log(failCount === 0
  ? '\n全部 ' + (passCount + failCount) + ' 项：' + passCount + ' 通过, 0 失败'
  : '\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
