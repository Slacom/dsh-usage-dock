/**
 * 0.9.0 C1/C2：三渠道退场 + 设置页自定义余额区（离线，复用 tools/mock-react.mjs）。
 *
 * 覆盖：
 *   - 退场：设置页/排序候选不再出现 kimi-code / glm-zhipu / glm-zai；旧 planOrder
 *     里的这些 id 不占槽位；旧启用配置不影响其余渠道。
 *   - 自定义区：位于内置渠道之后、保存按钮之前；增删改、启用/停用、上下移、
 *     统一草稿、放弃、保存中锁定、只读。
 *   - 密钥：Key 输入永不回填；「已配置」来自 Host 布尔摘要；保存走
 *     `customKeys.<id>` 路径写入（不整体替换 dict）；清除走 unset；掩码不当新值。
 *   - 校验：坏 URL / 坏路径 / 空名称在保存前拦截且整页不提交。
 *   - URL 变更必须重新确认凭据主机。
 *
 * 用法：node tools/test-custom-settings.mjs
 */
// [CP-06] 本文件验证的是底层安全语义（DNS/预算/连接绑定/摘要协议），
// 允许读取没有 provider 的旧条目（仅测试进程；生产默认拒绝）。
process.env.DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM = '1'

import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

/** [0.9.1] 可选模型渠道列表（Host 的 custom-status 返回）。 */
var MOCK_PROVIDERS = [{ provider: 'packyapi', displayName: 'PackyAPI', baseURL: 'https://cf.api.fan/v1', origin: 'https://cf.api.fan', baseURLSource: 'override', status: 'ready', reason: '' }]

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

/** 收集组件树里的所有元素（含函数组件展开一层）。 */
function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 12) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try {
        const rendered = node.type(node.props)
        if (rendered !== undefined) elementsOf(rendered, out, depth + 1)
      } catch (err) { /* 带 hooks 的子组件跳过 */ }
    }
  }
  return out
}

function byId(tree, id) {
  return elementsOf(tree).find((el) => el.props && el.props.id === id)
}
/**
 * 文本完全匹配的元素。优先返回 **button**：`textOf` 会向下收集，父容器也会命中
 * 同样的文本，直接取 `[0]` 会拿到 div（没有 onClick）。
 */
function byText(tree, text) {
  const all = elementsOf(tree).filter((el) => textOf(el) === text)
  const buttons = all.filter((el) => el.type === 'button')
  return buttons.length > 0 ? buttons : all
}
function byAria(tree, label) {
  return elementsOf(tree).find((el) => el.props && el.props['aria-label'] === label)
}
/**
 * 展开函数组件后的完整文本（mock 的 textOf 只沿 props.children 递归，
 * 不展开函数组件节点，因此自定义区/内置卡片里的文字看不到）。
 */
function textAll(tree) {
  return elementsOf(tree).map((el) => textOf(el)).join('')
}

/**
 * 构造 form 桩：set 记录整字段写入、mutate 记录路径写入。
 * value 是「已保存」的状态；写入立即生效（模拟 Host 接受）。
 */
/**
 * 构造 form 桩：set 记录整字段写入、mutate 记录路径写入。
 *
 * [R6] mutate 现在承担「元数据 + secret 一次提交」，因此桩必须**真的应用 ops**
 * （set/unset 路径写入到 value），否则后续断言看到的还是旧 value。
 */
function makeForm(initial) {
  const writes = []
  const mutations = []
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]', customBalances: [] }, initial || {}),
    getSnapshot() { assert.equal(this, form); return { value: this.value, writable: true } },
    subscribe() { assert.equal(this, form); return () => {} },
    set(field, value) {
      assert.equal(this, form)
      writes.push({ field, value })
      this.value = Object.assign({}, this.value, { [field]: value })
      return Promise.resolve(true)
    },
    mutate(ops) {
      assert.equal(this, form)
      mutations.push(ops)
      // 按路径应用（与宿主 applyPathOp 的语义一致：set 覆盖、unset 删除对象键）。
      let next = JSON.parse(JSON.stringify(this.value))
      for (const op of ops) {
        const path = op.path.slice()
        const last = path.pop()
        let cursor = next
        for (let i = 0; i < path.length; i += 1) {
          if (cursor[path[i]] === undefined || cursor[path[i]] === null) cursor[path[i]] = {}
          cursor = cursor[path[i]]
        }
        if (op.op === 'unset') delete cursor[last]
        else cursor[last] = op.value
      }
      this.value = next
      return Promise.resolve(true)
    },
  }
  return { form, writes, mutations }
}

/** 渲染设置页并让 fetch 的 promise 链落定。 */
async function mountSettings(runtime, client, form) {
  // mock 运行时只记得「最后一次 mount 的组件」，而这里的客户端同时注册了
  // 胶囊与服务两个席位；因此每次都要显式挂载设置页组件。
  const props = { form }
  runtime.mount(client.SettingsPage, props)
  const tree = await runtime.settle(props)
  return tree
}

const runtime = createRuntime()
// loadClient 的 whileServed 只有在传入 form 时才注册设置页；这里给一个占位 form，
// 真正的 form 在每次 mountSettings 时通过 props 传入。
const client = loadClient(runtime, { form: { getSnapshot() { return { value: {}, writable: false } }, subscribe() { return () => {} } } })
const SettingsPage = client.SettingsPage

// ---------------------------------------------------------------------------
// C1 — 三渠道退场
// ---------------------------------------------------------------------------
{
  const { form } = makeForm({})
  const tree = await mountSettings(runtime, client, form)
  const text = elementsOf(tree).map((el) => textOf(el)).join('')
  check('C1a 设置页不再出现 Kimi Code', !text.includes('Kimi Code'))
  check('C1b 设置页不再出现 GLM Z.AI', !text.includes('GLM Z.AI'))
  check('C1c 设置页不再出现 GLM 智谱', !text.includes('GLM 智谱'))
  check('C1d 退场渠道的开关输入不再存在', byId(tree, 'plan-usage-kimi-code-api-key') === undefined)
  check('C1e 保留渠道仍在（DeepSeek / MiMo / WorkBuddy）',
    text.includes('DeepSeek') && text.includes('Xiaomi MiMo') && text.includes('WorkBuddy'))
  check('C1f 排序候选不含退场 id',
    byAria(tree, 'Kimi Code 上移') === undefined
    && byAria(tree, 'GLM Z.AI 上移') === undefined
    && byAria(tree, 'GLM 智谱 上移') === undefined)
}

// 旧 planOrder 里的退场 id 不占槽位：上移 WorkBuddy 应跨过 mimo，而不是被旧 id 卡住。
{
  const { form, writes, mutations } = makeForm({ planOrder: '["glm-zai","kimi-code","glm-zhipu","deepseek","mimo","workbuddy"]' })
  const tree = await mountSettings(runtime, client, form)
  const up = byAria(tree, 'WorkBuddy 上移')
  assert.ok(up !== undefined, '应能找到 WorkBuddy 上移按钮')
  up.props.onClick()
  // 排序改动先进整页草稿；点「保存更改」才落盘（这是 0.8.1 起的既有交互）。
  const afterMove = await runtime.settle({ form })
  byText(afterMove, '保存更改')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const tree2 = await runtime.settle({ form })
  // [R6] 有 mutate 时整页一次提交；planOrder 可能出现在 mutate 的 ops 里而不是 set。
  const setSaved = writes.filter((w) => w.field === 'planOrder').pop()
  const mutateSaved = mutations.length > 0
    ? mutations[0].filter((op) => op.path.length === 1 && op.path[0] === 'planOrder').pop()
    : undefined
  const savedValue = setSaved !== undefined ? setSaved.value : (mutateSaved !== undefined ? mutateSaved.value : undefined)
  assert.ok(savedValue !== undefined, '点保存后应写入 planOrder（set 或 mutate）')
  const order = JSON.parse(savedValue)
  check('C1g 旧 planOrder 的退场 id 不占排序槽位（WorkBuddy 直接跨过 mimo）',
    order.indexOf('workbuddy') < order.indexOf('mimo'), order)
  check('C1h 保存的排序不再包含退场 id',
    order.indexOf('glm-zai') === -1 && order.indexOf('kimi-code') === -1 && order.indexOf('glm-zhipu') === -1, order)
  // [2026-10-21] workbuddy-ai 已退场，内置渠道由 6 个减为 5 个。
  check('C1i 排序仍保留其余内置渠道', order.length === 5 && order.indexOf('deepseek') !== -1, order)
}

// ---------------------------------------------------------------------------
// C2 — 自定义区布局位置
// ---------------------------------------------------------------------------
{
  const { form } = makeForm({})
  const tree = await mountSettings(runtime, client, form)
  // 自定义区是函数组件（CustomBalancesSection），渲染后才出现 data-custom-balances；
  // elementsOf 会展开一层函数组件，因此这里按渲染后的标记定位。
  const customIndex = elementsOf(tree).findIndex((el) => el.props && el.props['data-custom-balances'] !== undefined)
  // 页脚 = 带 justifyContent:flex-end 的 div（保存/放弃按钮所在行）。
  const footer = elementsOf(tree).find((el) => el.type === 'div' && el.props && el.props.style
    && el.props.style.justifyContent === 'flex-end')
  const footerIndex = elementsOf(tree).indexOf(footer)
  check('C2a 自定义区存在且固定在页面内', customIndex !== -1)
  check('C2b 自定义区在统一保存/放弃按钮之前', customIndex !== -1 && footer !== undefined && footerIndex > customIndex,
    { customIndex, footerIndex })
  // 自定义区必须在「最后一个内置渠道卡片」之后：用 MiMo 的 Cookie 输入框位置作参照。
  const builtInIndex = elementsOf(tree).findIndex((el) => el.props && el.props.placeholder
    && el.props.placeholder.indexOf('小米开放平台控制台 Cookie') !== -1)
  check('C2c 自定义区在内置渠道之后', builtInIndex !== -1 && customIndex > builtInIndex,
    { builtInIndex, customIndex })
  const text = textAll(tree)
  check('C2d 文案说明只做普通 HTTPS 余额接口', /普通 HTTPS 余额接口/.test(text))
}

// ---------------------------------------------------------------------------
// C2 — 增 / 删 / 改 / 排序 / 草稿
// ---------------------------------------------------------------------------
{
  const { form } = makeForm({})
  // [0.9.1] 自定义区需要「可选模型渠道」列表（来自 custom-status），先装好 fetch 再挂载。
  globalThis.fetch = async (url) => ({ json: async () => (String(url).includes('custom-status')
    ? { ok: true, data: { keys: {}, refs: {}, providers: MOCK_PROVIDERS } }
    : { ok: true, data: { plans: [], cfg: {} } }) })
let tree = await mountSettings(runtime, client, form)
  let addBtn = byText(tree, '＋ 添加自定义余额渠道')[0]
  check('C2e 初始状态显示「尚未添加」且添加按钮可用',
    textAll(tree).includes('尚未添加自定义渠道') && addBtn !== undefined && addBtn.props.disabled === false)

  addBtn.props.onClick()
  tree = await runtime.settle({ form })
  const card = elementsOf(tree).find((el) => el.props && el.props['data-custom-id'] !== undefined)
  check('C2f 点击添加后出现一条自定义记录（带稳定 id）',
    card !== undefined && /^custom:[A-Za-z0-9_-]{6,64}$/.test(card.props['data-custom-id']), card && card.props['data-custom-id'])

  // 填写名称/URL/路径：草稿状态，未保存时 form.value 不变。
  const nameInput = byId(tree, 'custom-name-' + card.props['data-custom-id'])
  check('C2g 新记录的厂商名称输入框存在', nameInput !== undefined)
  nameInput.props.onChange({ target: { value: '示例厂商' } })
  tree = await runtime.settle({ form })
  // [0.9.1] providers 来自 custom-status 的异步请求：等一拍，否则下拉还没数据。
  await new Promise((resolve) => setTimeout(resolve, 40))
  tree = await runtime.settle({ form })
  // [0.9.1] URL 输入框已改为「模型渠道下拉」：余额地址与凭据都从所选渠道派生。
  const providerSelect = byId(tree, 'custom-provider-' + card.props['data-custom-id'])
  check('C2g2 自定义条目的余额来源改为模型渠道下拉（不再有 URL 输入框）',
    providerSelect !== undefined && byId(tree, 'custom-url-' + card.props['data-custom-id']) === undefined,
    { hasSelect: providerSelect !== undefined, seen: elementsOf(tree).map(function(el){return el.props && el.props.id}).filter(function(v){return typeof v === 'string'}).slice(0,10) })
  if (providerSelect !== undefined) {
    providerSelect.props.onChange({ target: { value: 'packyapi' } })
    tree = await runtime.settle({ form })
  }
  const pathInput = byId(tree, 'custom-path-' + card.props['data-custom-id'])
  pathInput.props.onChange({ target: { value: 'data.balance' } })
  tree = await runtime.settle({ form })
  check('C2h 编辑只改草稿，未点保存前不写入配置',
    Array.isArray(form.value.customBalances) && form.value.customBalances.length === 0, form.value.customBalances)
  check('C2i 草稿里能看到新填写的内容',
    elementsOf(tree).some((el) => el.props && el.props.value === '示例厂商')
    && elementsOf(tree).some((el) => el.props && el.props.value === 'packyapi'))

  // 再加一条，验证同名两条独立 + 上移/下移。
  const addBtn2 = byText(tree, '＋ 添加自定义余额渠道')[0]
  addBtn2.props.onClick()
  tree = await runtime.settle({ form })
  const cards = elementsOf(tree).filter((el) => el.props && el.props['data-custom-id'] !== undefined)
  check('C2j 可添加多条记录', cards.length === 2, cards.length)
  check('C2k 两条记录 id 不同（不按名称识别）', cards[0].props['data-custom-id'] !== cards[1].props['data-custom-id'])

  const firstId = cards[0].props['data-custom-id']
  const secondId = cards[1].props['data-custom-id']
  const downFirst = byAria(tree, '示例厂商 下移')
  check('C2l 自定义条目有上移/下移按钮', downFirst !== undefined)
  downFirst.props.onClick()
  tree = await runtime.settle({ form })
  const reordered = elementsOf(tree).filter((el) => el.props && el.props['data-custom-id'] !== undefined)
  check('C2m 下移交换两条顺序', reordered[0].props['data-custom-id'] === secondId
    && reordered[1].props['data-custom-id'] === firstId)

  // 删除第二条。
  const deleteBtns = byText(tree, '删除此条')
  check('C2n 每条都有删除按钮', deleteBtns.length === 2, { n: deleteBtns.length, cards: elementsOf(tree).filter(function(e){return e.props && e.props['data-custom-id']}).map(function(e){return e.props['data-custom-id']}) })
  deleteBtns[1].props.onClick()
  tree = await runtime.settle({ form })
  const left = elementsOf(tree).filter((el) => el.props && el.props['data-custom-id'] !== undefined)
  check('C2o 删除后只剩一条', left.length === 1, left.length)
}

// ---------------------------------------------------------------------------
// C2 — 保存 / 放弃
// ---------------------------------------------------------------------------
{
  const { form, writes, mutations } = makeForm({})
let tree = await mountSettings(runtime, client, form)
  byText(tree, '＋ 添加自定义余额渠道')[0].props.onClick()
  tree = await runtime.settle({ form })
  let card = elementsOf(tree).find((el) => el.props && el.props['data-custom-id'] !== undefined)
  const id = card.props['data-custom-id']
  byId(tree, 'custom-name-' + id).props.onChange({ target: { value: '甲厂' } })
  tree = await runtime.settle({ form })
  // [0.9.1] 改为选择模型渠道（地址与凭据由它派生）。
  byId(tree, 'custom-provider-' + id).props.onChange({ target: { value: 'packyapi' } })
  tree = await runtime.settle({ form })
  // [CP-03] 余额接口路径必填（模型根不等于余额端点）。
  byId(tree, 'custom-endpoint-' + id).props.onChange({ target: { value: '/api/v1/credits' } })
  tree = await runtime.settle({ form })
  byId(tree, 'custom-path-' + id).props.onChange({ target: { value: 'data.balance' } })
  tree = await runtime.settle({ form })

  const saveBtn = byText(tree, '保存更改')[0]
  check('C2p 有草稿时保存按钮可用', saveBtn.props.disabled === false)
  saveBtn.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  tree = await runtime.settle({ form })
  // [R6] 有 mutate 时整页一次提交；customBalances 会在 mutate 的 ops 里。
  const setWritten = writes.find((w) => w.field === 'customBalances')
  const mutateWritten = mutations.length > 0
    ? mutations[0].filter((op) => op.path.length === 1 && op.path[0] === 'customBalances').pop()
    : undefined
  const written = setWritten !== undefined
    ? setWritten
    : (mutateWritten !== undefined ? { field: 'customBalances', value: mutateWritten.value } : undefined)
  // [0.9.1] 保存的是 provider（余额来源），不再写 url。
  check('C2q 保存写入 customBalances（含 id/name/provider/path）', written !== undefined
    && written.value.length === 1
    && written.value[0].id === id
    && written.value[0].name === '甲厂'
    && written.value[0].provider === 'packyapi'
    && written.value[0].balancePath === 'data.balance', written && written.value)
  check('C2r 保存后草稿清空（按钮回到禁用）', byText(tree, '保存更改')[0].props.disabled === true)

  // 放弃：编辑后点放弃，配置不变。
  byId(tree, 'custom-name-' + id).props.onChange({ target: { value: '改过的名字' } })
  tree = await runtime.settle({ form })
  const discardBtn = byText(tree, '放弃更改')[0]
  check('C2s 有草稿时放弃按钮可用', discardBtn.props.disabled === false)
  discardBtn.props.onClick()
  tree = await runtime.settle({ form })
  check('C2t 放弃后名称回到已保存值', byId(tree, 'custom-name-' + id).props.value === '甲厂')
}

// ---------------------------------------------------------------------------
// C2 — 校验：坏配置在保存前拦截，且整页不提交
// ---------------------------------------------------------------------------
{
  const bads = [
    /**
     * [CP-03] URL 不再由用户填写（主机来自所选渠道），因此原来的 "http URL" 用例
     * 换成「余额接口路径不合法」；其余仍是 JSON 键路径的语法拦截。
     */
    ['空名称', '', '/credits', 'data.balance', /厂商名称/],
    ['端点路径缺前导斜杠', '厂', 'credits', 'data.balance', /以 \/ 开头/],
    ['端点路径是完整网址', '厂', 'https://evil.example/x', 'data.balance', /以 \/ 开头|完整网址/],
    ['空键路径', '厂', '/credits', '', /键路径/],
    ['通配路径', '厂', '/credits', 'data.*', /语法|通配|字段名/],
    ['危险路径', '厂', '/credits', '__proto__.x', /禁止/],
    ['越界下标', '厂', '/credits', 'data[5000]', /下标/],
  ]
  let allBlocked = true
  for (const [label, name, url, path, pattern] of bads) {
    const { form, writes } = makeForm({})
let tree = await mountSettings(runtime, client, form)
    byText(tree, '＋ 添加自定义余额渠道')[0].props.onClick()
    tree = await runtime.settle({ form })
    const card = elementsOf(tree).find((el) => el.props && el.props['data-custom-id'] !== undefined)
    const id = card.props['data-custom-id']
    byId(tree, 'custom-name-' + id).props.onChange({ target: { value: name } })
    tree = await runtime.settle({ form })
    // [0.9.1] 改为选择模型渠道。
  byId(tree, 'custom-provider-' + id).props.onChange({ target: { value: 'packyapi' } })
    tree = await runtime.settle({ form })
    byId(tree, 'custom-endpoint-' + id).props.onChange({ target: { value: url } })
    tree = await runtime.settle({ form })
    byId(tree, 'custom-path-' + id).props.onChange({ target: { value: path } })
    tree = await runtime.settle({ form })
    byText(tree, '保存更改')[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 10))
    tree = await runtime.settle({ form })
    const pageText = textAll(tree)
    const blocked = writes.length === 0 && pattern.test(pageText)
    if (!blocked) {
      allBlocked = false
      console.log('   ' + label + ' 未拦截: writes=' + writes.length + ' text=' + pageText.slice(0, 120))
    }
  }
  check('C2u 坏名称/URL/路径在保存前拦截，且不写入任何字段', allBlocked)
}

// ---------------------------------------------------------------------------
// C2 — Key 安全：不回填、路径写入、清除
// ---------------------------------------------------------------------------
{
  const { form, writes, mutations } = makeForm({
    customBalances: [{
      id: 'custom:aaaaaaaaaaaa', name: '甲', provider: 'packyapi', balanceEndpoint: '/credits',
      balancePath: 'data.balance', enabled: true,
    }],
  })
  // 先装好 fetch，再挂载：custom-status 的读取发生在首帧 effect 里，
  // 挂载之后再替换 fetch 不会影响已经发出的那次请求。
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('custom-status')
      ? { ok: true, data: { keys: { 'custom:aaaaaaaaaaaa': true }, refs: {}, providers: MOCK_PROVIDERS } }
      : { ok: true }),
  })
let tree = await mountSettings(runtime, client, form)
  tree = await runtime.settle({ form })
  // 再挂载一次让 effect 重新读到状态（mock 的 effect deps 为空数组，不会重跑；
  // 这里重新 mount 是测试侧的等价手段：新实例会重新发起 custom-status 读取）。
  tree = await mountSettings(runtime, client, form)
  /**
   * [第五轮 UI 要求] 已保存的自定义卡片**默认折叠**，编辑字段不渲染。
   * 因此这里先点「展开」再断言字段级内容。
   */
  const expandBtn = byAria(tree, '甲 展开')
  check('C2v0 已保存卡片默认折叠（提供展开按钮）', expandBtn !== undefined,
    elementsOf(tree).map(function (el) { return el.props && el.props['aria-label'] }).filter(Boolean).slice(0, 12))
  if (expandBtn !== undefined) {
    expandBtn.props.onClick()
    tree = await runtime.settle({ form })
  }
  // [0.9.1] 自定义渠道不再有自己的 Key：地址与凭据都来自所选模型渠道。
  // 这里改为断言「Key 输入框与凭据引用已彻底移除」。
  const keyInput = byId(tree, 'custom-key-custom:aaaaaaaaaaaa')
  const refInput = byId(tree, 'custom-ref-custom:aaaaaaaaaaaa')
  check('C2v 不再提供 API Key 输入框', keyInput === undefined)
  check('C2w 不再提供凭据引用输入框', refInput === undefined)
  /**
   * [CP-08] 设置页现在显示所选渠道**实际生效的模型 baseURL**（含路径），
   * 并标出来源（用户覆盖 / 预设默认）。原来的「提示凭据来自渠道」被这条更强的展示取代。
   */
  check('C2x 显示所选渠道的模型接口地址', /模型接口地址：https:\/\//.test(textAll(tree)),
    textAll(tree).slice(0, 200))
}

// [0.9.1] 自定义渠道不再有独立 Key：旧的「清除已保存 Key」用例整体替换为
// 「旧版残留 Key 不再影响新契约」的断言。
{
  // 旧配置里可能还留着 url / credentialHost 等字段（本版本已不再读取）。
  const { form, mutations } = makeForm({
    customBalances: [{
      id: 'custom:bbbbbbbbbbbb', name: '乙', provider: 'packyapi',
      balancePath: 'data.balance', enabled: true,
    }],
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes("custom-status")
      ? { ok: true, data: { keys: {}, refs: {}, providers: MOCK_PROVIDERS } }
      : { ok: true }),
  })
  let tree = await mountSettings(runtime, client, form)
  tree = await runtime.settle({ form })
  check("C2ab 不再渲染「清除已保存 Key」按钮", byText(tree, "清除已保存 Key").length === 0)
  check("C2ac 不再显示 Key 状态徽标", !/Key 状态/.test(textAll(tree)))
  // [第五轮 UI 要求] 默认折叠：先展开这条再改字段。
  const expandB = byAria(tree, '乙 展开')
  if (expandB !== undefined) { expandB.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, "custom-name-custom:bbbbbbbbbbbb").props.onChange({ target: { value: "乙改" } })
  tree = await runtime.settle({ form })
  byText(tree, "保存更改")[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const secretOps = []
  for (const batch of mutations) {
    for (const op of batch) {
      if (Array.isArray(op.path) && op.path[0] === "customKeys") secretOps.push(op)
    }
  }
  check("C2ad 改名不会写任何 customKeys", secretOps.length === 0, secretOps)
}

// 留空 Key = 不修改（不能把空串写进去，把旧 Key 抹掉）。
{
  const { form, mutations } = makeForm({
    customBalances: [{
      id: 'custom:cccccccccccc', name: '丙', url: 'https://c.example.com/b',
      balancePath: 'data.balance', enabled: true,
    }],
  })
let tree = await mountSettings(runtime, client, form)
  // [第五轮 UI 要求] 默认折叠：先展开。
  const expandC = byAria(tree, '丙 展开')
  if (expandC !== undefined) { expandC.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, 'custom-name-custom:cccccccccccc').props.onChange({ target: { value: '丙改' } })
  tree = await runtime.settle({ form })
  byText(tree, '保存更改')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  tree = await runtime.settle({ form })
  // [R6] 现在整页一次 mutate：要断言的是「ops 里没有 customKeys」，而不是「没有 mutate」。
  const secretOps = []
  for (const batch of mutations) {
    for (const op of batch) {
      if (Array.isArray(op.path) && op.path[0] === 'customKeys') secretOps.push(op)
    }
  }
  check('C2ae 只改名不动 Key：没有任何 customKeys 写入', secretOps.length === 0, secretOps)
}

// ---------------------------------------------------------------------------
// C2 — 只读状态
// ---------------------------------------------------------------------------
{
  const readonlyForm = {
    value: { enabled: true, planOrder: '[]', customBalances: [{ id: 'custom:dddddddddddd', name: '丁', provider: 'packyapi', balancePath: 'data.balance', enabled: true }] },
    getSnapshot() { return { value: this.value, writable: false } },
    subscribe() { return () => {} },
    set() { throw new Error('只读部署不得写入') },
    mutate() { throw new Error('只读部署不得写入') },
  }
  // [0.9.1] 必须**重新挂载**：mock 运行时只记住最后一次 mount 的组件，
  // 直接 settle 会沿用上一个组的树（曾导致读到 cccccccccccc 而非 dddddddddddd）。
  runtime.mount(client.SettingsPage, { form: readonlyForm })
  const tree = await runtime.settle({ form: readonlyForm })
  const text = textAll(tree)
  check('C2af 只读部署显示只读提示', text.includes('只读'))
  check('C2ag 只读部署不渲染保存/放弃按钮',
    byText(tree, '保存更改').length === 0 && byText(tree, '放弃更改').length === 0)
  const addBtn = byText(tree, '＋ 添加自定义余额渠道')[0]
  check('C2ah 只读部署禁用添加与编辑', addBtn !== undefined && addBtn.props.disabled === true)
  // [第五轮] 默认折叠：先展开只读卡片的对应条目不可行（只读禁用），改为断言折叠态。
  const nameInput = byId(tree, 'custom-name-custom:dddddddddddd')
  /**
   * [第五轮 UI 要求] 已保存卡片默认折叠，只读部署里也没有可编辑输入框；
   * 展开按钮本身被禁用。这比"输入框 disabled"更强（根本不给编辑入口）。
   */
  const expandD = byAria(tree, '丁 展开')
  check('C2ai 只读部署：默认折叠且展开按钮被禁用',
    nameInput === undefined && expandD !== undefined && expandD.props.disabled === true,
    { hasInput: nameInput !== undefined, hasExpand: expandD !== undefined, disabled: expandD && expandD.props.disabled })
}

// ---------------------------------------------------------------------------
// C2 — [0.9.1] 旧条目迁移：url / credentialRef / credentialHost 已不再使用
// ---------------------------------------------------------------------------
{
  // 旧配置里残留的 url 与凭据绑定字段：本版本不再读取，也不再渲染目标确认 UI。
  const { form } = makeForm({
    customBalances: [{
      id: 'custom:eeeeeeeeeeee', name: '戊', provider: 'packyapi',
      balancePath: 'data.balance', enabled: true,
      url: 'https://old.example.com/b',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialHost: 'old.example.com', urlHostConfirmed: 'old.example.com',
    }],
  })
  let tree = await mountSettings(runtime, client, form)
  // [第五轮 UI 要求] 默认折叠：先展开这条以检查字段级内容。
  const expandE = byAria(tree, '戊 展开')
  if (expandE !== undefined) { expandE.props.onClick(); tree = await runtime.settle({ form }) }
  check("C2aj 不再显示发送目标确认 UI", !/发送目标已确认|尚未确认发送目标/.test(textAll(tree)))
  check("C2ak 不再显示凭据引用输入框", byId(tree, "custom-ref-custom:eeeeeeeeeeee") === undefined)
  check("C2al 余额来源下拉显示已保存的渠道", (function () {
    const sel = byId(tree, "custom-provider-custom:eeeeeeeeeeee")
    return sel !== undefined && sel.props.value === "packyapi"
  })())
  check("C2am 不再渲染「确认把该凭据发送到此主机」", byText(tree, "确认把该凭据发送到此主机").length === 0)
}

// ---------------------------------------------------------------------------
// C2 — 保存中锁定（整页）
// ---------------------------------------------------------------------------
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const form = {
    value: { enabled: true, planOrder: '[]', customBalances: [{ id: 'custom:ffffffffffff', name: '己', provider: 'packyapi', balanceEndpoint: '/credits', balancePath: 'data.balance', enabled: true }] },
    getSnapshot() { return { value: this.value, writable: true } },
    subscribe() { return () => {} },
    set(field, value) { this.value = Object.assign({}, this.value, { [field]: value }); return gate.then(() => true) },
    mutate() { return gate.then(() => true) },
  }
let tree = await mountSettings(runtime, client, form)
  // [第五轮 UI 要求] 默认折叠：先展开。
  const expandF = byAria(tree, '己 展开')
  if (expandF !== undefined) { expandF.props.onClick(); tree = await runtime.settle({ form }) }
  byId(tree, 'custom-name-custom:ffffffffffff').props.onChange({ target: { value: '己改' } })
  tree = await runtime.settle({ form })
  byText(tree, '保存更改')[0].props.onClick()
  tree = runtime.renderOnce({ form })
  const allInputs = elementsOf(tree).filter((el) => el.type === 'input')
  check('C2an 保存中整页输入被锁定', allInputs.length > 0 && allInputs.every((el) => el.props.disabled === true),
    allInputs.filter((el) => el.props.disabled !== true).length)
  check('C2ao 保存中按钮显示「保存中…」', byText(tree, '保存中…').length === 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 10))
}

client.restore()
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
