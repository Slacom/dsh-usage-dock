#!/usr/bin/env node
/**
 * [2026-11-17] provider → 渠道映射归一化。
 *
 * 真机故障：手机端把 WorkBuddy 网关命名为 `custom-workbuddy`（displayName 才叫 workbuddy），
 * 旧实现只做精确 id 匹配 → 路由 unmapped → 额度策略不注入、胶囊不显示。
 *
 * 规则：精确 id 优先；其次按「词元连续包含 + 最长匹配」；等长多命中视为歧义（返回 null）。
 */
import assert from 'node:assert/strict'
import { resolveRoute } from '../plans/quota-prompt.js'
import { providerToChannel } from '../plans/strip.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('[PASS] ' + name) } catch (error) {
    fail += 1
    console.error('[FAIL] ' + name)
    console.error(String(error && error.message ? error.message : error).slice(0, 300))
  }
}

const channelOf = (provider) => {
  const route = resolveRoute(provider)
  return route === null ? null : route.channelId
}

check('精确 id 全部照旧（不因归一化改变既有映射）', () => {
  assert.equal(channelOf('workbuddy'), 'workbuddy')
  assert.equal(channelOf('workbuddy-ai'), 'workbuddy-ai')
  assert.equal(channelOf('opencode-go'), 'opencode-go')
  assert.equal(channelOf('openai-codex'), 'codex')
  assert.equal(channelOf('deepseek-account'), 'deepseek')
  assert.equal(channelOf('deepseek-official'), 'deepseek')
  assert.equal(resolveRoute('deepseek-official').source, 'api')
  assert.equal(resolveRoute('deepseek-account').source, 'account')
})

check('自定义来源名归一化到同一渠道（手机端真机场景）', () => {
  assert.equal(channelOf('custom-workbuddy'), 'workbuddy')
  assert.equal(channelOf('my-workbuddy-api'), 'workbuddy')
  assert.equal(channelOf('my-opencode-go'), 'opencode-go')
  assert.equal(channelOf('custom-deepseek-account'), 'deepseek')
  assert.equal(resolveRoute('custom-deepseek-account').source, 'account')
})

check('最长词元序列优先：custom-workbuddy-ai → workbuddy-ai（不是 workbuddy）', () => {
  assert.equal(channelOf('custom-workbuddy-ai'), 'workbuddy-ai')
  assert.equal(channelOf('x-workbuddy-ai'), 'workbuddy-ai')
})

check('等长多命中 ⇒ 歧义返回 null（不猜）', () => {
  // `opencode-go` 与 `workbuddy-ai` 都是 2 个词元，同时出现则无法判断
  assert.equal(resolveRoute('opencode-go-workbuddy-ai'), null)
})

check('大小写/前后空白仍不命中（沿用 A12：不做大小写与空白归一化）', () => {
  assert.equal(resolveRoute('WORKBUDDY'), null)
  assert.equal(resolveRoute('Custom-WorkBuddy'), null)
  assert.equal(resolveRoute(' workbuddy'), null)
  assert.equal(resolveRoute('workbuddy '), null)
})

check('不认识的名字仍然 null（不误认）', () => {
  assert.equal(resolveRoute('deepseek'), null)
  assert.equal(resolveRoute('unknown-provider'), null)
  assert.equal(resolveRoute(''), null)
  assert.equal(resolveRoute(null), null)
  assert.equal(resolveRoute(42), null)
})

check('胶囊映射同样受益（strip 走同一个 resolveRoute）', () => {
  const deps = { resolveRoute, customEntries: [] }
  assert.deepEqual(providerToChannel('custom-workbuddy', deps), { channelId: 'workbuddy', custom: false, name: null, source: null })
  assert.equal(providerToChannel('unknown-provider', deps), null)
})

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
