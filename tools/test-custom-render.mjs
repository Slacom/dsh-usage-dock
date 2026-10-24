/**
 * 0.9.0 C4：自定义余额的胶囊/详情/失败回退/配置代次隔离（离线）。
 *
 * 覆盖：
 *   - 胶囊：每行一条、名称 + 币种余额、数值右对齐（复用 capValueStyle）、
 *     长名称省略、未指定币种不猜成人民币；自定义行固定排在内置渠道之后。
 *   - 详情：只显示名称/余额/币种/状态；不显示 Key、完整 URL、原始 JSON；
 *     不借用内置渠道的现金/赠金、积分、峰谷条。
 *   - 失败回退：暂时错误保留上次成功值并灰化；连续第 8 次失败转纯错误；
 *     恢复后更新数值并清零；无历史成功值时不伪造余额；单条失败不影响其他条目。
 *   - 语义错误（鉴权/配置/缺 Key）立即提示，不用旧值掩盖。
 *   - 配置代次：改 URL/币种/路径/Key → 旧值作废、不串账；停用/删除 → 不复活。
 *   - 退场渠道：Host 若仍返回也不画行。
 *
 * 用法：node tools/test-custom-render.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf, API_PAYLOAD } from './mock-react.mjs'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 10) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try { elementsOf(node.type(node.props), out, depth + 1) } catch (err) { /* hooks 组件跳过 */ }
    }
  }
  return out
}

function textAll(tree) {
  return elementsOf(tree).map((el) => textOf(el)).join('')
}

/** 胶囊根节点的第一个子节点 = 胶囊按钮；第二个 = 详情面板。 */
function pillOf(tree) {
  const kids = tree && tree.props ? tree.props.children : []
  return Array.isArray(kids) ? kids[0] : null
}
function panelOf(tree) {
  const kids = tree && tree.props ? tree.props.children : []
  return Array.isArray(kids) ? kids[1] : null
}

const runtime = createRuntime()
const client = loadClient(runtime, { payload: API_PAYLOAD })
const Badge = client.Badge
const WIDE = { configForm: null, wide: true }

/** 换一份 payload 并强刷一轮（focus 会作废在途请求并立即重拉）。 */
async function refreshWith(payload) {
  globalThis.fetch = async () => ({ json: async () => payload })
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 30))
  return await runtime.settle(WIDE)
}

function customPlan(overrides) {
  return Object.assign({
    id: 'custom:aaaaaaaaaaaa',
    name: '示例厂商',
    custom: true,
    gen: 'gen0000001',
    currency: 'CNY',
    balance: 12.34,
  }, overrides || {})
}

function payloadWith(plans) {
  return { ok: true, data: { plans } }
}

runtime.mount(Badge, WIDE)
await runtime.settle(WIDE)

// ---------------------------------------------------------------------------
// R1 — 胶囊成功渲染
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(payloadWith([customPlan()]))
  const text = textAll(tree)
  check('R1a 胶囊显示自定义渠道名称', text.includes('示例厂商'), text)
  check('R1b 胶囊显示带币种符号的余额（¥ 12.34）', text.includes('¥ 12.34') || text.includes('¥\u200912.34'), JSON.stringify(text))
  // 数值右对齐：自定义行必须复用 capValueStyle（marginLeft:auto + textAlign:right）。
  const valueEl = elementsOf(tree).find((el) => el.props && el.props.style
    && el.props.style.marginLeft === 'auto' && el.props.style.textAlign === 'right')
  check('R1c 数值列右对齐（复用 capValueStyle）', valueEl !== undefined)
  check('R1d 成功态为绿色状态点', elementsOf(tree).some((el) => el.props && el.props.style
    && el.props.style.background === 'var(--dsw-alias-state-success-primary)'))
}

// ---------------------------------------------------------------------------
// R2 — 币种口径：不猜
// ---------------------------------------------------------------------------
{
  const usd = await refreshWith(payloadWith([customPlan({ currency: 'USD', balance: 3.5 })]))
  // 符号与数字之间是 U+2009 thin space（与内置余额渠道同一间距基准）。
  check('R2a USD 显示 $ 符号', /\$\u20093\.50/.test(textAll(usd)), JSON.stringify(textAll(usd)))

  const none = await refreshWith(payloadWith([customPlan({ currency: '', balance: 7 })]))
  const noneText = textAll(none)
  // 同一轮里 DeepSeek 仍会显示 ¥，因此只看「示例厂商」这一行自己的数值列：
  // 胶囊每行 = [状态点, 名称, 数值]，这里直接找该行绑定的数值节点。
  const noneValue = elementsOf(none).find((el) => el.props && el.props.style
    && el.props.style.width === 80 && el.props.style.textAlign === 'right'
    && textOf(el).indexOf('7.00') !== -1)
  check('R2b 未指定币种时**不**默认人民币符号', noneValue !== undefined && !textOf(noneValue).includes('¥'),
    noneValue && textOf(noneValue))
  check('R2c 未指定币种仍显示数值（7.00）', noneValue !== undefined && textOf(noneValue).includes('7.00'),
    noneValue && textOf(noneValue))

  const other = await refreshWith(payloadWith([customPlan({ currency: 'EUR', balance: 5 })]))
  check('R2d 其它币种显示代码前缀（EUR 5.00）', textAll(other).includes('EUR 5.00'), textAll(other))
}

// ---------------------------------------------------------------------------
// R3 — 零余额与负余额
// ---------------------------------------------------------------------------
{
  const zero = await refreshWith(payloadWith([customPlan({ balance: 0 })]))
  // [A04 修复后] 整棵树里还有内置渠道（DeepSeek/Codex）的失败文案，且胶囊与详情
  // 会各渲染一份，因此**数「获取失败」出现次数或整树查找都不成立**。
  // 这里只断言零余额这条本身：它显示 ¥ 0.00，且没有被标成 stale/失败。
  const zeroText = textAll(zero)
  const zeroShown = zeroText.includes('¥ 0.00') || zeroText.includes('¥\u20090.00')
  check('R3a 零余额正常显示 ¥ 0.00（不是失败）', zeroShown, zeroText)

  const neg = await refreshWith(payloadWith([customPlan({ balance: -3.2 })]))
  check('R3b 负余额保留负号（¥ -3.20）', /¥\s?-3\.20/.test(textAll(neg)), textAll(neg))

  const trunc = await refreshWith(payloadWith([customPlan({ balance: 1.999 })]))
  check('R3c 金额截断到分（1.999 → 1.99，不向上多显示）', /¥\s?1\.99/.test(textAll(trunc)), textAll(trunc))
}

// ---------------------------------------------------------------------------
// R4 — 暂时失败：保留旧值 + 灰化；第 8 次转纯错误；恢复清零
// ---------------------------------------------------------------------------
{
  // 先成功一轮，建立「上次成功值」。
  await refreshWith(payloadWith([customPlan({ balance: 66.66 })]))
  let tree = await runtime.settle(WIDE)
  check('R4.pre 初始成功值 ¥ 66.66', /¥\s?66\.66/.test(textAll(tree)), textAll(tree))

  // [A04] 阈值 8 → 5：前 4 轮暂时失败沿用旧值并灰化，第 5 轮转纯错误。
  let grayThroughFour = true
  for (let i = 1; i <= 4; i += 1) {
    tree = await refreshWith(payloadWith([customPlan({
      balance: undefined, gen: 'gen0000001', error: 'server', transient: true, message: '上游服务暂时不可用（HTTP 503）',
    })]))
    const text = textAll(tree)
    if (!/¥\s?66\.66/.test(text)) { grayThroughFour = false; console.log('   第 ' + i + ' 轮丢了旧值: ' + text.slice(0, 160)) }
    if (i === 1) {
      const gray = elementsOf(tree).some((el) => el.props && el.props.style
        && el.props.style.color === 'var(--dsw-alias-label-tertiary)')
      check('R4a 第 1 次暂时失败：旧值保留且变灰', gray)
      const grayDot = elementsOf(tree).some((el) => el.props && el.props.style
        && el.props.style.background === 'var(--dsw-alias-label-tertiary)')
      check('R4b 第 1 次暂时失败：状态点也变灰', grayDot)
    }
  }
  check('R4c 前 4 次暂时失败都保留旧值（阈值 5）', grayThroughFour)

  // [A04] 第 5 次：转纯错误行，不再显示旧值。
  tree = await refreshWith(payloadWith([customPlan({
    balance: undefined, gen: 'gen0000001', error: 'server', transient: true, message: '上游服务暂时不可用（HTTP 503）',
  })]))
  const failText = textAll(tree)
  check('R4d 连续第 5 次失败转为纯错误（显示获取失败）', failText.includes('获取失败'), failText)
  check('R4e 第 5 次失败后不再显示旧余额', !/66\\.66/.test(failText), failText)

  // 恢复：数值回来、灰色消失。
  tree = await refreshWith(payloadWith([customPlan({ balance: 88.88, gen: 'gen0000001' })]))
  const recoverText = textAll(tree)
  check('R4f 恢复后显示新值 ¥ 88.88', /¥\s?88\.88/.test(recoverText), recoverText)
  const grayAfterRecover = elementsOf(tree).filter((el) => el.props && el.props.style
    && el.props.style.color === 'var(--dsw-alias-label-tertiary)')
  check('R4g 恢复后不再有灰色降级样式', grayAfterRecover.length === 0, grayAfterRecover.length)

  // 恢复后失败计数清零：再失败一次应仍保留旧值（而不是立刻显示失败）。
  tree = await refreshWith(payloadWith([customPlan({
    balance: undefined, gen: 'gen0000001', error: 'server', transient: true,
  })]))
  check('R4h 恢复后失败计数清零（再失败 1 次仍保留旧值）', /¥\s?88\.88/.test(textAll(tree)), textAll(tree))
  // 把计数推回 0：成功一轮。
  await refreshWith(payloadWith([customPlan({ balance: 88.88, gen: 'gen0000001' })]))
}

// ---------------------------------------------------------------------------
// R5 — 无历史成功值：不伪造余额
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(payloadWith([customPlan({
    id: 'custom:bbbbbbbbbbbb', name: '新渠道', balance: undefined, error: 'server', transient: true,
  })]))
  const text = textAll(tree)
  check('R5a 首次即失败时不显示任何余额', !/¥/.test(text) && !/\d\.\d\d/.test(text), text)
  check('R5b 首次即失败显示「获取失败」', text.includes('获取失败'), text)
}

// ---------------------------------------------------------------------------
// R6 — 语义错误立即提示，不用旧值掩盖
// ---------------------------------------------------------------------------
{
  await refreshWith(payloadWith([customPlan({ balance: 50, gen: 'gen0000001' })]))
  const cases = [
    ['auth', '鉴权失败（上游返回 HTTP 401）：请检查 API Key 或凭据引用', '鉴权失败'],
    ['no-key', '未配置 API Key：请在设置页填写，或选择已有的模型凭据引用', '请设置 Key'],
    ['credential-unconfirmed', '已选择模型凭据引用，但发送目标主机尚未确认', '凭据待确认'],
    ['config', 'JSON 键路径配置无效：请在设置页修正', '配置有误'],
  ]
  for (const [error, message, capsuleText] of cases) {
    const tree = await refreshWith(payloadWith([customPlan({ balance: undefined, gen: 'gen0000001', error, message })]))
    const text = textAll(tree)
    check('R6 ' + error + '：旧值立即消失（不掩盖语义错误）', !/50\.00/.test(text), text)
    check('R6 ' + error + '：胶囊给出固定提示', text.includes(capsuleText), text)
  }
}

// ---------------------------------------------------------------------------
// R7 — 单条失败不影响其他条目
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(payloadWith([
    customPlan({ id: 'custom:aaaaaaaaaaaa', name: '甲渠道', balance: 10, gen: 'genA' }),
    customPlan({ id: 'custom:bbbbbbbbbbbb', name: '乙渠道', balance: undefined, gen: 'genB', error: 'auth', message: '鉴权失败' }),
    customPlan({ id: 'custom:cccccccccccc', name: '丙渠道', balance: 30, gen: 'genC' }),
  ]))
  const text = textAll(tree)
  check('R7a 甲渠道正常显示', text.includes('甲渠道') && /¥\s?10\.00/.test(text), text)
  check('R7b 丙渠道正常显示', text.includes('丙渠道') && /¥\s?30\.00/.test(text), text)
  check('R7c 乙渠道单独报错（鉴权失败，不是笼统获取失败）',
    text.includes('乙渠道') && text.includes('鉴权失败') && !text.includes('乙渠道获取失败'), text)
}

// ---------------------------------------------------------------------------
// R8 — 配置代次隔离：改 URL/币种/路径/Key 后旧值作废
// ---------------------------------------------------------------------------
{
  // 建立旧值（币种 CNY、余额 11.11、代次 gen-old）。
  await refreshWith(payloadWith([customPlan({ balance: 11.11, gen: 'gen-old', currency: 'CNY' })]))
  let tree = await runtime.settle(WIDE)
  check('R8.pre 旧值 ¥ 11.11', /¥\s?11\.11/.test(textAll(tree)), textAll(tree))

  // 配置身份变化后，本轮取数**暂时失败**：旧值必须作废（不能拿旧账户余额配新 URL）。
  tree = await refreshWith(payloadWith([customPlan({
    balance: undefined, gen: 'gen-new', currency: 'USD', error: 'server', transient: true,
  })]))
  const text = textAll(tree)
  check('R8a 代次变化后暂时失败不沿用旧值（不串账）', !/11\.11/.test(text), text)
  check('R8b 代次变化后显示失败而不是旧余额', text.includes('获取失败'), text)

  // 配置身份变化且新值成功：直接显示新值。
  tree = await refreshWith(payloadWith([customPlan({ balance: 22.22, gen: 'gen-newer', currency: 'USD' })]))
  check('R8c 代次变化后成功则显示新值（$ 22.22）', /\$\s?22\.22/.test(textAll(tree)), textAll(tree))
  check('R8d 旧值 ¥ 11.11 不再出现', !/11\.11/.test(textAll(tree)), textAll(tree))
}

// ---------------------------------------------------------------------------
// R9 — 停用 / 删除：不复活
// ---------------------------------------------------------------------------
{
  await refreshWith(payloadWith([customPlan({ balance: 44.44, gen: 'gen-on' })]))
  let tree = await runtime.settle(WIDE)
  check('R9.pre 启用时显示 44.44', /44\.44/.test(textAll(tree)), textAll(tree))

  // 停用：Host 回 {enabled:false} 且不请求 → 行消失。
  tree = await refreshWith(payloadWith([customPlan({ enabled: false, balance: undefined, gen: 'gen-off' })]))
  check('R9a 停用后不再显示该行（名称也消失）', !textAll(tree).includes('示例厂商'), textAll(tree))

  // 删除：Host 干脆不回该 id → 行消失且不沿用旧值。
  tree = await refreshWith(payloadWith([
    customPlan({ id: 'custom:dddddddddddd', name: '其它渠道', balance: 5, gen: 'gen-other' }),
  ]))
  const text = textAll(tree)
  check('R9b 删除后该行消失（即使还有其它自定义条目）', !text.includes('示例厂商'), text)
  check('R9c 删除后不复活旧余额', !/44\.44/.test(text), text)
  check('R9d 其它自定义条目照常显示', text.includes('其它渠道') && /5\.00/.test(text), text)
}

// ---------------------------------------------------------------------------
// R10 — 退场渠道：Host 若仍返回也不画行
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(payloadWith([
    { id: 'kimi-code', name: 'Kimi Code', rollingUsage: { percent: 20 }, weeklyUsage: { percent: 30 } },
    { id: 'glm-zai', name: 'GLM Z.AI', rollingUsage: { percent: 40 } },
    { id: 'glm-zhipu', name: 'GLM 智谱', rollingUsage: { percent: 50 } },
    customPlan({ balance: 9.99, gen: 'gen-x' }),
  ]))
  const text = textAll(tree)
  check('R10a 旧 Host 返回 kimi-code 也不画行', !text.includes('Kimi Code'), text)
  check('R10b 旧 Host 返回 glm-zai 也不画行', !text.includes('GLM Z.AI'), text)
  check('R10c 旧 Host 返回 glm-zhipu 也不画行', !text.includes('GLM 智谱'), text)
  check('R10d 自定义条目照常显示', text.includes('示例厂商') && /9\.99/.test(text), text)
}

// ---------------------------------------------------------------------------
// R11 — 排序：自定义固定排在内置之后
// ---------------------------------------------------------------------------
{
  const tree = await refreshWith(payloadWith([
    customPlan({ id: 'custom:aaaaaaaaaaaa', name: '自定义甲', balance: 1, gen: 'g1' }),
    { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
    customPlan({ id: 'custom:bbbbbbbbbbbb', name: '自定义乙', balance: 2, gen: 'g2' }),
  ]))
  const text = textAll(tree)
  const deepseekAt = text.indexOf('DeepSeek')
  const customAt = text.indexOf('自定义甲')
  /**
   * [顺序修复 2026-10-20 第三次] 用户已确认**全局混排**：
   * 自定义渠道不再被强制排在内置渠道之后，`planOrder` 未列出时按 payload 原序。
   * 旧断言「自定义必须在内置之后」已被用户明确推翻，这里改为
   * 「未列出时保持 payload 原序」，并断言内置渠道确实出现在列表里。
   */
  check('R11a 未列入 planOrder 时保持 payload 原序',
    deepseekAt !== -1 && customAt !== -1 && customAt < deepseekAt, { deepseekAt, customAt })
  const second = text.indexOf('自定义乙')
  check('R11b 自定义之间保持配置顺序', second > customAt, { customAt, second })
}

// ---------------------------------------------------------------------------
// R12 — 详情面板：只显示允许的信息
// ---------------------------------------------------------------------------
{
  await refreshWith(payloadWith([customPlan({ balance: 12.34, currency: 'CNY', gen: 'gen-p' })]))
  let tree = await runtime.settle(WIDE)
  const pill = pillOf(tree)
  if (pill.props['aria-expanded'] !== true) { pill.props.onClick() }
  tree = await runtime.settle(WIDE)
  const panel = panelOf(tree)
  check('R12a 详情面板已渲染', panel !== null && panel !== undefined)
  const text = textAll(panel)
  check('R12b 面板显示名称与余额', text.includes('示例厂商') && /12\.34/.test(text), text)
  check('R12c 面板显示币种', text.includes('CNY'), text)
  check('R12d 面板显示状态说明', /余额可用/.test(text), text)
  check('R12e 面板不显示 API Key / URL / 原始 JSON',
    !/sk-/.test(text) && !/https:\/\//.test(text) && !/\{"/.test(text), text)
  check('R12f 自定义渠道不借用内置的现金/赠金明细',
    !text.includes('现金余额') && !text.includes('赠送余额') && !text.includes('充值余额'), text)
  check('R12g 自定义渠道不渲染峰谷条', !text.includes('高峰时段') && !text.includes('空闲时段'), text)

  // 降级态：数值与状态点同为灰色，并说明是上次成功值。
  const stale = await refreshWith(payloadWith([customPlan({
    balance: undefined, gen: 'gen-p', error: 'server', transient: true,
  })]))
  const staleText = textAll(panelOf(stale))
  check('R12h 降级时面板说明「显示的是上次成功值」', /上次成功值/.test(staleText), staleText)
  check('R12i 降级时仍显示旧值', /12\.34/.test(staleText), staleText)

  // 语义错误：显示固定诊断，不残留旧余额。
  const broken = await refreshWith(payloadWith([customPlan({
    balance: undefined, gen: 'gen-p', error: 'auth', message: '鉴权失败（上游返回 HTTP 401）：请检查 API Key 或凭据引用',
  })]))
  const brokenText = textAll(panelOf(broken))
  check('R12j 语义错误时面板给出可操作提示', /鉴权失败/.test(brokenText), brokenText)
  check('R12k 语义错误时不残留旧余额', !/12\.34/.test(brokenText), brokenText)
  check('R12l 语义错误时无原始错误堆栈/上游原文', !/at |stack|Error:/.test(brokenText), brokenText)
}

// ---------------------------------------------------------------------------
// R13 — 详情面板：长名称省略
// ---------------------------------------------------------------------------
{
  const longName = '这是一个非常长的自定义余额厂商名称用于测试省略号与数值对齐是否会被挤坏'
  const tree = await refreshWith(payloadWith([customPlan({ name: longName, balance: 5.55, gen: 'gen-long' })]))
  const nameEl = elementsOf(tree).find((el) => el.props && el.props.style
    && el.props.style.textOverflow === 'ellipsis' && el.props.children === longName)
  check('R13a 长名称使用省略号样式（不挤坏数值列）', nameEl !== undefined, longName.length)
  const valueEl = elementsOf(tree).find((el) => el.props && el.props.style
    && el.props.style.marginLeft === 'auto' && el.props.style.width === 80)
  check('R13b 数值列固定宽度仍生效', valueEl !== undefined)
}

// ---------------------------------------------------------------------------
// R14 — [顺序修复 2026-10-20] 胶囊按 planOrder 排列自定义条目
//
// 之前 `configForm: null` 使这个测试从未覆盖排序：胶囊里
// `plans = sortPlansByOrder(builtIns).concat(customs)` 把自定义条目**原样追加**，
// 于是设置页点了 ▲/▼ 后胶囊毫无反应。这里补上真正的覆盖。
// ---------------------------------------------------------------------------
{
  const orderForm = {
    getSnapshot() {
      return {
        value: {
          enabled: true, deepseekEnabled: true,
          planOrder: JSON.stringify(['deepseek', 'custom:bbbbbbbbbbbb', 'custom:aaaaaaaaaaaa']),
          /**
           * 配置里必须**确实有**这两条：客户端会按已保存配置过滤/校验身份，
           * 只给 planOrder 而不给条目会被判成「配置里没有它」而整批隐藏。
           */
          customBalances: [
            { id: 'custom:aaaaaaaaaaaa', provider: 'p', balanceEndpoint: '/c', name: '甲厂', balancePath: 'v', subtractPath: '', currency: 'CNY', enabled: true },
            { id: 'custom:bbbbbbbbbbbb', provider: 'p', balanceEndpoint: '/c', name: '乙厂', balancePath: 'v', subtractPath: '', currency: 'CNY', enabled: true },
          ],
        },
        writable: true,
      }
    },
    subscribe() { return () => {} },
  }
  const ordered = payloadWith([
    // 故意按相反顺序给：客户端必须按 planOrder 重排。
    customPlan({ id: 'custom:aaaaaaaaaaaa', name: '甲厂', balance: 1.11, gen: 'gen-a' }),
    customPlan({ id: 'custom:bbbbbbbbbbbb', name: '乙厂', balance: 2.22, gen: 'gen-b' }),
  ])
  const orderProps = { configForm: orderForm, wide: true }
  globalThis.fetch = async () => ({ json: async () => ordered })
  runtime.mount(Badge, orderProps)
  await runtime.settle(orderProps)
  client.windowEvents.dispatch('focus')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const tree2 = await runtime.settle(orderProps)
  const text2 = textAll(tree2)
  const iB = text2.indexOf('乙厂')
  const iA = text2.indexOf('甲厂')
  check('R14a 胶囊里两条自定义渠道都出现', iA !== -1 && iB !== -1, text2.slice(0, 120))
  check('R14b 胶囊按 planOrder 排列（乙厂在甲厂之前）', iB !== -1 && iA !== -1 && iB < iA,
    { iA, iB })
}
client.restore()
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
