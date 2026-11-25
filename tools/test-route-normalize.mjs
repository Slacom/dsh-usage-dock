#!/usr/bin/env node
/**
 * [2026-11-17] provider → 渠道映射归一化。
 *
 * 真机故障：手机端把模型来源命名为 `custom-<渠道>`（displayName 才与内置名一致），
 * 旧实现只做精确 id 匹配 → 路由 unmapped → 额度策略不注入、胶囊不显示。
 * [2026-11-23] WorkBuddy 已退场，改用仍在内置 ROUTE_TABLE 的 OpenCode Go / Codex /
 * DeepSeek 覆盖同一套归一化规则。
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
  assert.equal(channelOf('opencode-go'), 'opencode-go')
  assert.equal(channelOf('openai-codex'), 'codex')
  assert.equal(channelOf('deepseek-account'), 'deepseek')
  assert.equal(channelOf('deepseek-official'), 'deepseek')
  assert.equal(resolveRoute('deepseek-official').source, 'api')
  assert.equal(resolveRoute('deepseek-account').source, 'account')
})

check('自定义来源名归一化到同一渠道（手机端真机场景）', () => {
  assert.equal(channelOf('custom-opencode-go'), 'opencode-go')
  assert.equal(channelOf('my-openai-codex'), 'codex')
  assert.equal(channelOf('my-opencode-go'), 'opencode-go')
  assert.equal(channelOf('custom-deepseek-account'), 'deepseek')
  assert.equal(resolveRoute('custom-deepseek-account').source, 'account')
})

check('等长多命中 ⇒ 歧义返回 null（不猜）', () => {
  // `openai-codex` 与 `opencode-go` 都是 2 个词元，同时出现则无法判断
  assert.equal(resolveRoute('openai-codex-opencode-go'), null)
})

check('大小写/前后空白仍不命中（沿用 A12：不做大小写与空白归一化）', () => {
  assert.equal(resolveRoute('OPENCODE-GO'), null)
  assert.equal(resolveRoute('Custom-OpenCode-Go'), null)
  assert.equal(resolveRoute(' opencode-go'), null)
  assert.equal(resolveRoute('opencode-go '), null)
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
  assert.deepEqual(providerToChannel('custom-opencode-go', deps), { channelId: 'opencode-go', custom: false, name: null, source: null })
  assert.equal(providerToChannel('unknown-provider', deps), null)
})

console.log('\n' + (pass + fail) + ' 项：' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
