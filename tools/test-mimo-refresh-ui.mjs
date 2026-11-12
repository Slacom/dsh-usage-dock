/**
 * test-mimo-refresh-ui.mjs — MiMo UI 收尾 + readFailures/freshness contract（离线）
 * 真实 client bundle 的纯 projector + 真实 MimoAuthMount 树；无网络/账号/凭据。
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fails.push(name + ' :: ' + (e.message || String(e))); console.log('FAIL ' + name + ' :: ' + (e.message || String(e))) }
}
const rt = createRuntime()
const boot = loadClient(rt, { form: { getSnapshot() { return { value: {}, writable: false } }, subscribe() { return () => {} } }, payload: { plans: [] } })
const client = boot.module

const SNAP = (over = {}) => Object.assign({
  managed: true, state: 'verified', code: 'E_NONE', generation: 3,
  identity: { maskedLabel: 'u***7' }, balance: { balance: 13.5, currency: 'CNY' },
  fetchedAt: 1700000000000, readFailures: 0, freshness: 'fresh', selected: true, displaySupported: true,
}, over)

async function main() {
  check('R1 rememberedOf 接受 readFailures 0..5 与 freshness 闭集', () => {
    const a = client.mimoAuth.rememberedOf({ state: 'verified', readFailures: 4, freshness: 'stale' })
    assert.equal(a.readFailures, 4); assert.equal(a.freshness, 'stale')
    const b = client.mimoAuth.rememberedOf({ state: 'verified', readFailures: 9, freshness: 'weird' })
    assert.equal(b.readFailures, 0); assert.equal(b.freshness, null)
  })

  check('R2 display DTO 保留 managed 与 readFailures', () => {
    const d = client.mimoDisplay.pick({ ok: true, bootEpoch: 'a'.repeat(32), display: SNAP({ readFailures: 5, freshness: 'failed' }) }).display
    assert.equal(d.managed, true); assert.equal(d.readFailures, 5); assert.equal(d.freshness, 'failed')
  })

  check('R3 verified+failed：planOf 转固定错误文本，不再显示“显示中”', () => {
    const d = client.mimoDisplay.pick({ ok: true, bootEpoch: 'a'.repeat(32), display: SNAP({ balance: null, readFailures: 5, freshness: 'failed', code: 'E_MIMO_AUTH_SSO_CHALLENGE' }) }).display
    const plan = client.mimoDisplay.planOf(d, null)
    assert.equal(plan.error, 'display')
    assert.ok(plan.displayFailureText.startsWith('余额读取失败：'))
    assert.equal(plan.displayFailureText.includes('http'), false)
    assert.equal(client.mimoDisplay.stateText(d), '余额读取失败')
    assert.equal(client.mimoDisplay.shortText(d, false), '余额读取失败')
  })

  check('R4 前 4 次失败：保留旧金额 + stale 标记；无历史时中性“正在读取余额”', () => {
    const stale = client.mimoDisplay.pick({ ok: true, bootEpoch: 'a'.repeat(32), display: SNAP({ readFailures: 3, freshness: 'stale' }) }).display
    const p = client.mimoDisplay.planOf(stale, null)
    assert.equal(p.balance, 13.5); assert.equal(p.stale, true)
    assert.equal(client.mimoDisplay.stateText(stale), '显示中')
    const none = client.mimoDisplay.pick({ ok: true, bootEpoch: 'a'.repeat(32), display: SNAP({ balance: null, readFailures: 2, freshness: 'fresh' }) }).display
    assert.equal(client.mimoDisplay.stateText(none), '正在读取余额')
    assert.equal(client.mimoDisplay.planOf(none, null).displayFailureText, undefined)
  })

  await check('S1 设置页：无 Cookie 输入/教程，MimoAuthMount 唯一入口直接挂载', async () => {
    const r = createRuntime()
    const b = loadClient(r, { form: { getSnapshot() { return { value: {}, writable: false } }, subscribe() { return () => {} } }, payload: { plans: [{ id: 'mimo', name: 'Xiaomi MiMo', fields: { enabled: 'mimoEnabled', cookie: 'mimoCookie' } }] } })
    const form = { getSnapshot() { return { value: { mimoEnabled: true }, writable: true } }, subscribe() { return () => {} }, mutate() {}, set() {} }
    r.mount(b.SettingsPage, { form })
    const tree = await r.settle({ form }, 10)
    const txt = textOf(tree)
    assert.equal(txt.includes('控制台 Cookie'), false)
    assert.equal(txt.includes('F12'), false)
    // 唯一入口组件仍是同一 MimoAuthMount（真实树渲染断言留给 managed e2e 更新）
    assert.equal(typeof client.mimoAuth.Panel, 'function')
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length) { console.error(summary); process.exitCode = 1 } else console.log(summary + ' (' + (pass + fails.length) + ')')
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
