/**
 * [0.10.6] 「Codex Subscription 需适配」块的**版本感知**客户端回归（离线、全 fake）。
 *
 * 背景：第三方 `dsh-codex-subscription` 升到 3.2.17 后，旧客户端在「设置 → 内置插件 →
 * Codex 订阅」里只显示一句「当前第三方插件版本暂不支持一键适配」——用户看不出**装的是哪个
 * 版本**、本插件**已收录哪些版本**，于是反馈「更新后还是无法正确识别并一键适配」。
 *
 * 覆盖（不联网、不起服务、不 spawn 子进程、不写工作区）：
 *   P1 父组件只在 Subscription 行 `enabled:true + compatible:false` 时把 active 传成 true；
 *      取不到来源 metadata 时不激活（= 不发 patch-state GET），active=false 不渲染/不发 GET。
 *   P2 unsupported（无匹配清单）：显示已装版本 + 已收录清单，且**没有**「应用本地适配」按钮。
 *   P2b unsupported（有清单但文件与基线不符，manifestVersion === version）：明确说「与已知基线
 *      不一致」，**不得**说「暂无适配清单」——避免与「已收录含本版本」自相矛盾。
 *   P3 appliable：显示已装版本 + 「应用本地适配」按钮；点击后沿用原有 POST 逻辑与固定结果文案。
 *   P4 patched：不渲染按钮，提示重启后可读取订阅额度。
 *   P5 GET 抛错：退化成原有兜底（仍渲染按钮），且**只发一次** GET、不重试。
 *   P6 POST 返回固定码 E_CS_PATCH_UNSUPPORTED：沿用原有固定文案，且**不回显固定码**。
 *   P7 信封不可信（ok:false / state 不在闭集）⇒ 兜底显示按钮。
 *   P8 unsupported 但缺 version / covered / manifestVersion（或字段非法）⇒ 退化成不带版本号的原句，
 *      且不误判成「无匹配清单」或「基线不一致」任一分支。
 *
 * 测试手法：客户端用 `module.exports.codexSource.PatchBlock` 这个既有测试入口**直接挂载**
 * 真实组件；父组件接线层（active 计算）通过挂载真实设置页树并断言该元素的 props 覆盖。
 * 全部跑在**真实 client.js 字节**上（`DSH_CLIENT_UNDER_TEST` 可在部署前跑 stage 候选）。
 *
 * 用法：node tools/test-codex-patch-ui.mjs
 *      DSH_CLIENT_UNDER_TEST=<stage/client.js> node tools/test-codex-patch-ui.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else {
    failCount++
    console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : ''))
  }
}

/** 收集组件树里的所有元素（不展开函数组件，函数组件节点本身也收进 out）。 */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out)); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  out.push(node)
  elementsOf(node.props ? node.props.children : undefined, out)
  return out
}

/** 在设置页树里定位「一键适配块」：唯一同时带 active + writable 的函数组件元素。 */
function findPatchBlockElement(tree) {
  return elementsOf(tree).find((el) => typeof el.type === 'function' && el.props
    && Object.prototype.hasOwnProperty.call(el.props, 'active')
    && Object.prototype.hasOwnProperty.call(el.props, 'writable')) || null
}

/** 渲染结果里的按钮（按可见文案）。 */
function buttonsByText(tree, text) {
  return elementsOf(tree).filter((el) => el.type === 'button' && textOf(el) === text)
}

function makeForm(initial) {
  const form = {
    value: Object.assign({ enabled: true, planOrder: '[]', codexEnabled: true, codexSource: 'subscription' }, initial || {}),
    getSnapshot() { assert.equal(this, form); return { value: this.value, writable: true } },
    subscribe() { assert.equal(this, form); return () => {} },
    set() { throw new Error('本套件不保存配置') },
    mutate() { throw new Error('本套件不保存配置') },
  }
  return form
}

/** 默认来源 metadata：Subscription 已启用但接口不兼容（= 需适配）。 */
const CODEX_SOURCES_INCOMPATIBLE = {
  ok: true,
  data: {
    sources: [
      { id: 'connect', label: 'Codex Connect', enabled: true, compatible: true },
      { id: 'subscription', label: 'Codex Subscription', enabled: true, compatible: false },
    ],
    selected: 'subscription',
  },
}

const runtime = createRuntime()
const form = makeForm({})
const client = loadClient(runtime, { form })
/** loadClient 装好的离线 fetch（含 codex-sources / custom-status / quota-windows 夹具）。 */
const baseFetch = globalThis.fetch

/**
 * 装一层按 URL 分流的 fetch：patch-state / apply-patch / codex-sources 用本用例的夹具，
 * 其余仍交给 loadClient 的离线夹具。
 */
function installFetch(scenario) {
  const state = { probeCalls: [], applyCalls: [] }
  globalThis.fetch = async function (url, init) {
    const urlText = String(url)
    if (urlText.includes('/codex-subscription/patch-state')) {
      state.probeCalls.push({ method: init && init.method })
      if (scenario.probeThrows === true) throw new Error('patch-state-unreachable')
      return { status: 200, json: async () => scenario.probePayload }
    }
    if (urlText.includes('/codex-subscription/apply-patch')) {
      state.applyCalls.push({ method: init && init.method, body: init ? init.body : undefined })
      if (scenario.applyThrows === true) throw new Error('apply-unreachable')
      return { status: 200, json: async () => scenario.applyPayload }
    }
    if (urlText.includes('codex-sources')) {
      if (scenario.codexSourcesError === true) throw new Error('codex-sources-unreachable')
      return { json: async () => (scenario.codexSources !== undefined ? scenario.codexSources : CODEX_SOURCES_INCOMPATIBLE) }
    }
    return baseFetch(url, init)
  }
  return state
}

/** 挂载真实设置页、取出一键适配块的函数组件元素（并返回该次渲染的 active 值）。 */
async function extractPatchBlock(settingsForm) {
  const props = { form: settingsForm }
  runtime.mount(client.SettingsPage, props)
  const tree = await runtime.settle(props)
  const el = findPatchBlockElement(tree)
  return el
}

// ---------------------------------------------------------------------------
// 先拿到内部块组件：client.js 已通过 `module.exports.codexSource.PatchBlock`
// 暴露组件级入口（与既有浏览器半测试同一入口），后续按 props 直接挂载。
// ---------------------------------------------------------------------------
const PatchBlock = client.module && client.module.codexSource && client.module.codexSource.PatchBlock
if (typeof PatchBlock !== 'function') {
  console.log('[FAIL] client.js 未暴露 codexSource.PatchBlock 组件入口（夹具缺口，后续用例无法进行）')
  client.restore()
  process.exit(1)
}
console.log('[PASS] P0 client.js 暴露组件级入口 codexSource.PatchBlock')
passCount++

// ---------------------------------------------------------------------------
// P1 — 父组件只在 incompatible 时激活；取不到 metadata 不激活（不发 GET）
// ---------------------------------------------------------------------------
{
  installFetch({ codexSources: CODEX_SOURCES_INCOMPATIBLE })
  const el = await extractPatchBlock(makeForm({}))
  check('P1a Subscription 已启用且接口不兼容 ⇒ 父组件把 active 传成 true',
    el !== null && el.props.active === true, el && el.props)

  installFetch({ codexSourcesError: true })
  const el2 = await extractPatchBlock(makeForm({}))
  check('P1b 取不到来源 metadata ⇒ 不激活（active=false，后续不会发 patch-state GET）',
    el2 !== null && el2.props.active === false, el2 && el2.props)

  // 结论：来源 metadata 读取失败时不该触发任何 patch-state 探测。
  const state = installFetch({ codexSourcesError: true })
  runtime.mount(PatchBlock, { active: false, writable: true })
  const tree = await runtime.settle({ active: false, writable: true })
  check('P1c active=false ⇒ 不渲染任何内容、不发 GET', tree === null && state.probeCalls.length === 0, { tree, calls: state.probeCalls.length })
}

// ---------------------------------------------------------------------------
// P2 — unsupported：显示已装版本 + 已收录清单，且没有按钮
// ---------------------------------------------------------------------------
{
  const state = installFetch({
    probePayload: {
      ok: true,
      data: {
        installed: true,
        version: '3.2.17',
        state: 'unsupported',
        serviceAvailable: false,
        // Host 语义：没有与已装 3.2.17 精确匹配的清单 ⇒ manifestVersion 为 null；
        // 这里用「命中的是旧清单 3.2.13」表示「确实没有 3.2.17 的清单」。
        manifestVersion: '3.2.13',
        covered: ['3.2.6', '3.2.13'],
      },
    },
  })
  const props = { active: true, writable: true }
  runtime.mount(PatchBlock, props)
  const tree = await runtime.settle(props)
  const text = textOf(tree)
  check('P2a unsupported 显示已装第三方版本 3.2.17', text.includes('第三方插件 3.2.17 暂无适配清单'), text)
  check('P2b unsupported 显示本插件已收录清单（3.2.6 / 3.2.13）',
    text.includes('本插件已收录：3.2.6 / 3.2.13'), text)
  // [0.11.2] unsupported（无匹配清单）现在会列出「已收录」版本，不再只说「请升级本插件」。
  check('P2c unsupported 列出已收录清单（而不是误导性的「请升级本插件」）',
    text.includes('暂无适配清单') && text.includes('已收录') && text.includes('3.2.'),
    text)
  check('P2d unsupported 不渲染「应用本地适配」按钮', buttonsByText(tree, '应用本地适配').length === 0, text)
  check('P2e unsupported 只读一次 patch-state（不重试/不轮询）', state.probeCalls.length === 1, state.probeCalls)
  check('P2f 文案不含固定码/异常细节', !/E_CS_|Error|stack/iu.test(text), text)
}

// ---------------------------------------------------------------------------
// P2b — unsupported 但「有清单、文件与基线不符」：不能说「暂无适配清单」
// ---------------------------------------------------------------------------
{
  const state = installFetch({
    probePayload: {
      ok: true,
      data: {
        installed: true,
        version: '3.2.17',
        state: 'unsupported',
        serviceAvailable: false,
        // 清单命中 3.2.17（= 已装版本），但当前文件 sha 既非 baseSha 也非 programSha。
        manifestVersion: '3.2.17',
        covered: ['3.2.6', '3.2.13', '3.2.17'],
      },
    },
  })
  const props = { active: true, writable: true }
  runtime.mount(PatchBlock, props)
  const tree = await runtime.settle(props)
  const text = textOf(tree)
  check('P2b-a 有清单但基线不符 ⇒ 明确说明「本机第三方文件与已知基线不一致」',
    text.includes('已收录') && text.includes('已知基线不一致') && text.includes('无法一键适配'), text)
  check('P2b-b 文案不含自相矛盾的「暂无适配清单」', !text.includes('暂无适配清单'), text)
  check('P2b-c 给出可执行建议（重装/升级或命令行工具）',
    /重装|升级/.test(text) && text.includes('命令行工具'), text)
  check('P2b-d 基线不符同样不渲染「应用本地适配」按钮',
    buttonsByText(tree, '应用本地适配').length === 0, text)
  check('P2b-e 基线不符只读一次 patch-state', state.probeCalls.length === 1, state.probeCalls)
  check('P2b-f 文案不含固定码/异常细节', !/E_CS_|Error|stack/iu.test(text), text)
}

// ---------------------------------------------------------------------------
// P3 — appliable：显示版本 + 按钮；点击沿用原有 POST 与固定结果文案
// ---------------------------------------------------------------------------
{
  const state = installFetch({
    probePayload: {
      ok: true,
      data: {
        installed: true,
        version: '3.2.17',
        state: 'appliable',
        serviceAvailable: false,
        manifestVersion: '3.2.17',
        covered: ['3.2.6', '3.2.17'],
      },
    },
    applyPayload: { ok: true, data: { applied: true } },
  })
  const props = { active: true, writable: true }
  runtime.mount(PatchBlock, props)
  let tree = await runtime.settle(props)
  const text = textOf(tree)
  const applyButtons = buttonsByText(tree, '应用本地适配')
  check('P3a appliable 显示「第三方插件 3.2.17，可一键适配」', text.includes('第三方插件 3.2.17，可一键适配'), text)
  check('P3b appliable 渲染「应用本地适配」按钮', applyButtons.length === 1, text)
  check('P3c appliable 只读一次 patch-state', state.probeCalls.length === 1, state.probeCalls)

  applyButtons[0].props.onClick()
  tree = await runtime.settle(props)
  const doneText = textOf(tree)
  check('P3d 点击后走原 POST 逻辑（空 body、一条请求）',
    state.applyCalls.length === 1 && state.applyCalls[0].method === 'POST' && state.applyCalls[0].body === undefined,
    state.applyCalls)
  check('P3e 点击后沿用固定结果文案「已应用，重启 DSH 后可读取订阅额度」',
    doneText.includes('已应用，重启 DSH 后可读取订阅额度'), doneText)
  check('P3f 点击后按钮消失、且不再重复探测', buttonsByText(tree, '应用本地适配').length === 0 && state.probeCalls.length === 1,
    { buttons: buttonsByText(tree, '应用本地适配').length, probes: state.probeCalls.length })
}

// ---------------------------------------------------------------------------
// P4 — patched：不渲染按钮，提示重启后可读取
// ---------------------------------------------------------------------------
{
  const state = installFetch({
    probePayload: {
      ok: true,
      data: {
        installed: true,
        version: '3.2.17',
        state: 'patched',
        serviceAvailable: true,
        manifestVersion: '3.2.17',
        covered: ['3.2.6', '3.2.13', '3.2.17'],
      },
    },
  })
  const props = { active: true, writable: true }
  runtime.mount(PatchBlock, props)
  const tree = await runtime.settle(props)
  const text = textOf(tree)
  check('P4a patched 提示已适配且重启后生效', text.includes('已适配，重启 DSH 后可读取订阅额度'), text)
  check('P4b patched 不渲染「应用本地适配」按钮', buttonsByText(tree, '应用本地适配').length === 0, text)
  check('P4c patched 不显示「已应用」以外的误导文案（未发生点击）', !text.includes('已应用'), text)
  check('P4d patched 只读一次 patch-state', state.probeCalls.length === 1, state.probeCalls)
}

// ---------------------------------------------------------------------------
// P5 — GET 抛错：保持原有兜底（仍渲染按钮），且只发一次、不重试
// ---------------------------------------------------------------------------
{
  const state = installFetch({ probeThrows: true })
  const props = { active: true, writable: true }
  runtime.mount(PatchBlock, props)
  const tree = await runtime.settle(props)
  const text = textOf(tree)
  check('P5a patch-state 读取失败 ⇒ 显示原有适配说明', text.includes('需要在本机做一次适配'), text)
  check('P5b patch-state 读取失败 ⇒ 仍渲染「应用本地适配」按钮', buttonsByText(tree, '应用本地适配').length === 1, text)
  check('P5c 读取失败不重试（只发一次 GET）', state.probeCalls.length === 1, state.probeCalls)
  check('P5d 读取失败不渲染错误细节', !/patch-state-unreachable|Error|E_CS_/iu.test(text), text)
}

// ---------------------------------------------------------------------------
// P6 — POST 返回固定码 E_CS_PATCH_UNSUPPORTED：沿用固定文案，不回显固定码
// ---------------------------------------------------------------------------
{
  const state = installFetch({
    probeThrows: true,
    applyPayload: { ok: false, error: 'E_CS_PATCH_UNSUPPORTED' },
  })
  const props = { active: true, writable: true }
  runtime.mount(PatchBlock, props)
  let tree = await runtime.settle(props)
  buttonsByText(tree, '应用本地适配')[0].props.onClick()
  tree = await runtime.settle(props)
  const text = textOf(tree)
  check('P6a POST 固定码 ⇒ 原「版本暂不支持一键适配」文案',
    text.includes('当前第三方插件版本暂不支持一键适配，请升级本插件。'), text)
  check('P6b 固定码只用于内部分流，绝不渲染到界面', !text.includes('E_CS_PATCH_UNSUPPORTED'), text)
  check('P6c POST 后不再显示按钮', buttonsByText(tree, '应用本地适配').length === 0, text)
}

// ---------------------------------------------------------------------------
// P7 — 信封不可信（ok:false / state 不在闭集）⇒ 兜底显示按钮
// ---------------------------------------------------------------------------
{
  const badPayloads = [
    { label: 'ok:false', payload: { ok: false, error: 'E_X' } },
    { label: 'state 未知', payload: { ok: true, data: { state: 'unknown-state', version: '3.2.17' } } },
    { label: 'data 缺失', payload: { ok: true } },
    { label: 'body=null', payload: null },
  ]
  let allFallback = true
  const seen = []
  for (const bad of badPayloads) {
    const state = installFetch({ probePayload: bad.payload })
    const props = { active: true, writable: true }
    runtime.mount(PatchBlock, props)
    const tree = await runtime.settle(props)
    const hasButton = buttonsByText(tree, '应用本地适配').length === 1
    const hasHint = textOf(tree).includes('需要在本机做一次适配')
    if (!hasButton || !hasHint) allFallback = false
    seen.push({ label: bad.label, hasButton, probes: state.probeCalls.length })
  }
  check('P7 不可信响应一律退化成「显示按钮」的兜底行为', allFallback, seen)
}

// ---------------------------------------------------------------------------
// P8 — unsupported 但缺 version / covered：退化成不带版本号的原句
// ---------------------------------------------------------------------------
{
  const cases = [
    { label: '缺 version', data: { state: 'unsupported', covered: ['3.2.17'], manifestVersion: '3.2.17' }, expect: 'fallback' },
    { label: '缺 covered', data: { state: 'unsupported', version: '3.2.17', manifestVersion: '3.2.17' }, expect: 'baseline' },
    { label: '空 covered', data: { state: 'unsupported', version: '3.2.17', covered: [], manifestVersion: '3.2.17' }, expect: 'baseline' },
    { label: 'version 非法', data: { state: 'unsupported', version: 3.2, covered: ['3.2.17'], manifestVersion: '3.2.17' }, expect: 'fallback' },
    // [0.11.2] manifestVersion 为 null 才表示「本包没有该版本清单」；缺失/非法按此处理，不再吞掉版本号。
    { label: '缺 manifestVersion', data: { state: 'unsupported', version: '3.2.17', covered: ['3.2.6', '3.2.13', '3.2.17'] }, expect: 'noManifest' },
    { label: 'manifestVersion 非法字符', data: { state: 'unsupported', version: '3.2.17', covered: ['3.2.17'], manifestVersion: '3.2.17; rm -rf /' }, expect: 'noManifest' },
    { label: 'manifestVersion 非字符串', data: { state: 'unsupported', version: '3.2.17', covered: ['3.2.17'], manifestVersion: 17 }, expect: 'noManifest' },
    { label: 'manifestVersion 空串', data: { state: 'unsupported', version: '3.2.17', covered: ['3.2.17'], manifestVersion: '   ' }, expect: 'noManifest' },
  ]
  let allDegraded = true
  const seen = []
  for (const item of cases) {
    installFetch({ probePayload: { ok: true, data: item.data } })
    const props = { active: true, writable: true }
    runtime.mount(PatchBlock, props)
    const tree = await runtime.settle(props)
    const text = textOf(tree)
    const noButton = buttonsByText(tree, '应用本地适配').length === 0
    let ok = noButton
    if (ok && item.expect === 'fallback') {
      ok = text.includes('当前第三方插件版本暂不支持一键适配，请升级本插件。')
        && !text.includes('暂无适配清单') && !text.includes('基线不一致')
    }
    if (ok && item.expect === 'baseline') {
      ok = text.includes('基线不一致') && !text.includes('暂无适配清单')
    }
    if (ok && item.expect === 'noManifest') {
      ok = text.includes('暂无适配清单') && text.includes('3.2.17') && !text.includes('基线不一致')
    }
    if (!ok) allDegraded = false
    seen.push({ label: item.label, expect: item.expect, text: text.slice(0, 120) })
  }
  check('P8 缺失/非法字段按真实语义分流（fallback / 基线不一致 / 无匹配清单），且都不给按钮',
    allDegraded, seen)
}

client.restore()
console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
