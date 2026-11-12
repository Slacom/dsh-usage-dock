/**
 * test-mimo-remembered-tree.mjs — 真实 MimoAuthMount → managed panel 树与点击（fake owner API）
 * 覆盖 empty/authorizing/awaiting_confirmation/verified/paused/failed；点击退出只发 rememberedForget 一次。
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fails.push(name + ' :: ' + (e.message || String(e))); console.log('FAIL ' + name + ' :: ' + (e.message || String(e))) }
}
const BOOT = 'a'.repeat(32)
const base = { ok: true, code: 'E_NONE', bootEpoch: BOOT, rememberedSupported: true }

function snap(over) {
  return Object.assign({ supported: true, managed: true, state: 'empty', code: 'E_NONE', revision: 1, generation: 2, hasQr: false, paused: false, canBegin: true, canConfirm: false, canPause: false, canResume: false, canForget: false, canRetry: false, readFailures: 0, freshness: null }, over)
}
function makeApi(state) {
  const calls = []
  const api = {
    calls,
    async fetch(url, init = {}) {
      const body = init.body === undefined || init.body === null ? null : JSON.parse(init.body)
      calls.push({ url: String(url), method: init.method || 'GET', body })
      if (body !== null && body.action === 'rememberedForget') return json({ ...base, ok: true, remembered: state.snapshot })
      if (body !== null && body.action === 'rememberedStatus') return json({ ...base, remembered: state.snapshot })
      return json({ ...base, remembered: state.snapshot })
    },
  }
  function json(obj) { return { ok: true, status: 200, json: async () => obj } }
  return api
}
async function mountPanel(api, props = {}) {
  const r = createRuntime()
  const b = loadClient(r, { form: { getSnapshot() { return { value: {}, writable: false } }, subscribe() { return () => {} } }, payload: { plans: [] } })
  // loadClient 会重设 globalThis.fetch：必须在加载之后再打桩
  globalThis.fetch = api.fetch
  r.mount(b.module.mimoAuth.Panel, props)
  let tree = null
  for (let i = 0; i < 6; i += 1) { await new Promise((res) => setTimeout(res, 5)); tree = await r.settle(props, 8) }
  // 展开 MimoAuthMount 返回的 managed 子组件（同 e2e 做法）
  if (tree !== null && typeof tree === 'object' && typeof tree.type === 'function' && tree.type.name === 'MimoRememberedPanel') {
    const panelProps = tree.props
    r.mount(tree.type, panelProps)
    for (let i = 0; i < 6; i += 1) { await new Promise((res) => setTimeout(res, 5)); tree = await r.settle(panelProps, 8) }
  }
  return tree
}
function nodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  const c = node.props !== undefined && node.props !== null ? node.props.children : node.children
  if (Array.isArray(c)) for (const k of c) nodes(k, out)
  else if (c !== undefined) nodes(c, out)
  return out
}
function buttons(tree) {
  return nodes(tree).filter((n) => typeof n.type === 'string' && n.type === 'button')
}

async function main() {
  // [0.10.5] 面板在 0.10.3 收敛成「未登录账号 + 一行说明 + 整行扫码登录」：
  // 不再有 consent 勾选、不再要求用户事先输入账号 ID。
  await check('T1 empty：未登录文案 + 一个整行扫码登录按钮（无勾选/无输入）', async () => {
    const api = makeApi({ snapshot: snap({ state: 'empty' }) })
    const tree = await mountPanel(api)
    const txt = textOf(tree)
    assert.ok(txt.includes('未登录账号'))
    assert.ok(txt.includes('扫码登录后自动读取该账号余额'))
    const btn = buttons(tree).find((b) => textOf(b).includes('扫码登录'))
    assert.ok(btn !== undefined)
    assert.equal(btn.props['data-mimo-wide'], 'e1')
    assert.equal(btn.props.disabled, false)
    // 用户要求：登录前**不要**任何勾选与账号输入框
    assert.equal(nodes(tree).filter((n) => n.type === 'input').length, 0)
    assert.equal(txt.includes('记住登录（下次启动自动恢复）'), false)
  })

  await check('T2 authorizing：二维码提示 + 整行取消按钮，点击只发一次 rememberedCancel', async () => {
    const api = makeApi({ snapshot: snap({ state: 'authorizing', hasQr: true, authId: 'a'.repeat(32), canBegin: false }) })
    const tree = await mountPanel(api)
    const txt = textOf(tree)
    assert.ok(txt.includes('请用手机扫码确认'))
    const b = buttons(tree).find((x) => textOf(x) === '取消')
    assert.ok(b !== undefined)
    assert.equal(b.props['data-mimo-wide'], 'a5')
    const before = api.calls.filter((x) => x.body !== null && x.body.action === 'rememberedCancel').length
    b.props.onClick()
    await new Promise((r) => setTimeout(r, 0))
    const after = api.calls.filter((x) => x.body !== null && x.body.action === 'rememberedCancel').length
    assert.equal(after - before, 1)
  })

  // [0.10.5] 扫码成功后由 Host 给出**候选账号 ID**，用户只点一次确认；全程不手输 ID。
  await check('T3 awaiting_confirmation：显示候选账号 + 两个并排按钮（确认/取消）', async () => {
    const api = makeApi({ snapshot: snap({ state: 'awaiting_confirmation', authId: 'b'.repeat(32), candidate: { label: '小米账号ID', identifier: '777' }, canConfirm: true }) })
    const tree = await mountPanel(api)
    const txt = textOf(tree)
    assert.ok(txt.includes('确认这是你的账号'))
    assert.ok(txt.includes('账号：777'))
    const confirm = buttons(tree).find((x) => textOf(x).includes('确认这是我的账号'))
    assert.ok(confirm !== undefined)
    assert.equal(confirm.props['data-mimo-wide'], 'c9')
    const cancel = buttons(tree).find((x) => textOf(x) === '取消')
    assert.ok(cancel !== undefined)
    assert.equal(cancel.props['data-mimo-wide'], 'c8')
    // 不再有 4 个 consent 勾选，也不需要用户输入账号
    assert.equal(nodes(tree).filter((n) => n.type === 'input').length, 0)
    for (const s of ['启动后自动恢复登录', '启动后自动查询余额', '启动后自动刷新余额']) {
      assert.equal(txt.includes(s), false, s)
    }
  })

  await check('T4 verified：只有更新于/账号/退出；退出点击恰好一次 rememberedForget', async () => {
    const state = { snapshot: snap({ state: 'verified', identity: { maskedLabel: 'u***7' }, balance: { balance: 13.5, currency: 'CNY' }, fetchedAt: 1700000000000, canForget: true }) }
    const api = makeApi(state)
    const tree = await mountPanel(api)
    const txt = textOf(tree)
    assert.ok(txt.includes('更新于'))
    assert.ok(txt.includes('已绑定账号'))
    assert.ok(txt.includes('退出账号'))
    assert.equal(txt.includes('余额：'), false)
    assert.equal(txt.includes('暂停刷新'), false)
    assert.equal(txt.includes('只读'), false)
    const exit = buttons(tree).find((x) => textOf(x) === '退出账号')
    assert.ok(exit !== undefined)
    assert.equal(exit.props.style.fontSize, 12)
    // [typography 2026-11-11] 「更新于 / 已绑定账号」两行必须是灰色小字（settingsHintStyle），
    // 不能是卡片正文黑体大字；只这两行加样式，失败/QR/确认信息不整块灰化。
    const v1 = nodes(tree).find((n) => textOf(n).startsWith('更新于 ') && !textOf(n).includes('已绑定账号'))
    const v2 = nodes(tree).find((n) => textOf(n).startsWith('已绑定账号：') && !textOf(n).includes('退出账号'))
    for (const [label, node] of [['更新于', v1], ['已绑定账号', v2]]) {
      assert.ok(node !== undefined && node.props !== undefined, label + ' 行必须存在')
      assert.ok(node.props.style !== undefined && node.props.style !== null, label + ' 行必须有 style')
      assert.equal(node.props.style.color, 'var(--dsw-alias-label-tertiary)', label + ' 行应为灰色小字')
      assert.equal(node.props.style.fontSize, 12, label + ' 行字号 12')
      assert.equal(node.props.style.margin, 0)
    }
    api.calls.length = 0
    exit.props.onClick()
    await new Promise((res) => setTimeout(res, 20))
    const forgets = api.calls.filter((c) => c.body !== null && c.body.action === 'rememberedForget')
    assert.equal(forgets.length, 1)
    assert.equal(forgets[0].body.bootEpoch, BOOT)
    assert.equal(forgets[0].body.generation, 2)
  })

  await check('T5 disabled：退出按钮 disabled 且点击不发送', async () => {
    const state = { snapshot: snap({ state: 'verified', identity: { maskedLabel: 'u***7' }, fetchedAt: 1700000000000, canForget: true }) }
    const api = makeApi(state)
    const tree = await mountPanel(api, { disabled: true })
    const exit = buttons(tree).find((x) => textOf(x) === '退出账号')
    assert.ok(exit !== undefined)
    assert.equal(exit.props.disabled, true)
    assert.equal(exit.props.style.opacity, 0.45)
    api.calls.length = 0
    exit.props.onClick()
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(api.calls.length, 0)
  })

  await check('T6 paused：恢复刷新 + 退出；failed：重试 + 退出与固定码', async () => {
    const p = await mountPanel(makeApi({ snapshot: snap({ state: 'paused', canResume: true, canForget: true }) }))
    assert.ok(textOf(p).includes('恢复刷新'))
    assert.ok(buttons(p).some((b) => textOf(b) === '退出账号'))
    const f = await mountPanel(makeApi({ snapshot: snap({ state: 'failed', code: 'E_MIMO_AUTH_REJECTED', canRetry: true, canForget: true }) }))
    assert.ok(textOf(f).includes('恢复失败：E_MIMO_AUTH_REJECTED'))
    assert.ok(buttons(f).some((b) => textOf(b) === '重试恢复'))
    assert.ok(buttons(f).some((b) => textOf(b) === '退出账号'))
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length) { console.error(summary); process.exitCode = 1 } else console.log(summary + ' (' + (pass + fails.length) + ')')
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
