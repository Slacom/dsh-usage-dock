#!/usr/bin/env node
/**
 * [dsh-go composer.strip] 纯函数契约测试：
 *   - session/event → 路由（三类事件、latest wins、坏事件忽略）
 *   - provider → 渠道（内置映射 / 自定义条目 / 未映射隐藏）
 *   - 投影快照 → ≤24 字文本（百分比取最紧窗口、余额/积分/自定义、截断、失败隐藏）
 */
import assert from 'node:assert/strict'
import {
  STRIP_MAX_CHARS,
  truncateRunes,
  routeFromSessionEvent,
  applySessionRouteEvent,
  providerToChannel,
  formatAmount,
  formatStripText,
} from '../plans/strip.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('[PASS] ' + name)
  } catch (error) {
    console.error('[FAIL] ' + name)
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

check('路由事件：model/selection', () => {
  assert.deepEqual(routeFromSessionEvent({ type: 'model/selection', data: { provider: 'opencode-go', model: 'm' } }), { provider: 'opencode-go', model: 'm' })
})
check('路由事件：request/header 取实际 route', () => {
  assert.deepEqual(
    routeFromSessionEvent({ type: 'request/header', data: { header: { config: { provider: 'codex', model: 'x' } } } }),
    { provider: 'codex', model: 'x' },
  )
})
check('路由事件：assistant/message 取 message.source', () => {
  assert.deepEqual(
    routeFromSessionEvent({ type: 'assistant/message', data: { message: { source: { provider: 'deepseek-account', model: 'y' } } } }),
    { provider: 'deepseek-account', model: 'y' },
  )
})
check('路由事件：坏形状/未知类型/缺 provider 返回 null', () => {
  assert.equal(routeFromSessionEvent(null), null)
  assert.equal(routeFromSessionEvent({ type: 'tool/call', data: {} }), null)
  assert.equal(routeFromSessionEvent({ type: 'model/selection', data: { model: 'm' } }), null)
})
check('latest wins：后到事件覆盖，同值不重复通知', () => {
  const map = new Map()
  assert.equal(applySessionRouteEvent(map, 's1', { type: 'model/selection', data: { provider: 'opencode-go', model: 'a' } }), true)
  assert.equal(applySessionRouteEvent(map, 's1', { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'b' } } } }), true)
  assert.equal(map.get('s1').provider, 'deepseek-account')
  assert.equal(applySessionRouteEvent(map, 's1', { type: 'assistant/message', data: { message: { source: { provider: 'deepseek-account', model: 'b' } } } }), false)
})
check('会话隔离：不同 session 各自保存', () => {
  const map = new Map()
  applySessionRouteEvent(map, 'a', { type: 'model/selection', data: { provider: 'opencode-go', model: 'm' } })
  applySessionRouteEvent(map, 'b', { type: 'model/selection', data: { provider: 'codex', model: 'm' } })
  assert.equal(map.get('a').provider, 'opencode-go')
  assert.equal(map.get('b').provider, 'codex')
})

const resolveRoute = (provider) => (provider === 'opencode-go' ? { channelId: 'opencode-go', source: null }
  : provider === 'codex' ? { channelId: 'codex', source: null }
  : null)
check('provider→渠道：内置映射精确匹配', () => {
  assert.deepEqual(providerToChannel('opencode-go', { resolveRoute }), { channelId: 'opencode-go', custom: false, name: null, source: null })
  assert.equal(providerToChannel('OpenCode-Go', { resolveRoute }), null)
})
check('provider→渠道：自定义余额条目按 provider 精确匹配', () => {
  const customEntries = [
    { id: 'custom:openrouter', provider: 'openrouter', name: 'OpenRouter' },
    { id: 'custom:other', provider: 'other-route', name: 'Other' },
  ]
  assert.deepEqual(providerToChannel('openrouter', { resolveRoute, customEntries }), { channelId: 'custom:openrouter', custom: true, name: 'OpenRouter' })
  assert.equal(providerToChannel('unmapped', { resolveRoute, customEntries }), null)
})

check('金额格式：千分位与两位小数', () => {
  assert.equal(formatAmount(12.345), '12.35')
  assert.equal(formatAmount(1234.5), '1,235')
  assert.equal(formatAmount(0), '0.00')
})
check('rune 截断：≤24 字，超长补省略号', () => {
  assert.equal(truncateRunes('short', STRIP_MAX_CHARS), 'short')
  const long = '一'.repeat(30)
  const out = truncateRunes(long, STRIP_MAX_CHARS)
  assert.equal(Array.from(out).length, STRIP_MAX_CHARS)
  assert.equal(out.endsWith('…'), true)
})

const projectedPercent = {
  availability: 'ok',
  name: 'OpenCode Go',
  windows: [
    { scope: 'rolling-5h', percent: 62 },
    { scope: 'weekly', percent: 80 },
  ],
  balance: null,
}
check('strip 百分比：优先 5 小时窗口（不是取最紧），含渠道短名与窗口标签', () => {
  const out = formatStripText({ channelId: 'opencode-go', custom: false, name: null }, projectedPercent, { locale: 'zh-CN' })
  assert.equal(out.text, 'OpenCode Go 62% 80%')
  const fiveHourHigh = formatStripText({ channelId: 'opencode-go', custom: false }, { availability: 'ok', windows: [{ scope: 'rolling-5h', percent: 96 }, { scope: 'weekly', percent: 79 }] }, { locale: 'zh-CN' })
  assert.equal(fiveHourHigh.text, 'OpenCode Go 96% 79%')
  assert.equal(out.icon, 'wallet')
  assert.equal(out.tone, undefined)
})
check('strip 百分比：低额度 tone=warn/bad', () => {
  const warn = formatStripText({ channelId: 'codex', custom: false }, { availability: 'ok', windows: [{ scope: 'weekly', percent: 25 }] }, { locale: 'en-US' })
  assert.equal(warn.text, 'Codex 25%')
  assert.equal(warn.tone, 'warn')
  const bad = formatStripText({ channelId: 'codex', custom: false }, { availability: 'ok', windows: [{ scope: 'weekly', percent: 5 }] }, { locale: 'zh-CN' })
  assert.equal(bad.tone, 'bad')
})
check('strip 余额：DeepSeek/MiMo 带币种符号', () => {
  assert.equal(formatStripText({ channelId: 'deepseek', custom: false }, { availability: 'ok', balance: 12.34, currency: 'CNY' }, { locale: 'zh-CN' }).text, 'DeepSeek ¥12.34')
  assert.equal(formatStripText({ channelId: 'mimo', custom: false }, { availability: 'ok', balance: 8.5, currency: 'CNY' }, { locale: 'zh-CN' }).text, 'MiMo ¥8.50')
})
check('strip 自定义：名称截断且数字可见', () => {
  const out = formatStripText({ channelId: 'custom:abcdefghijklmnopqrstuvwxyz', custom: true, name: '一个非常非常长的自定义渠道名称' }, { availability: 'ok', balance: 5, currency: 'USD' }, { locale: 'zh-CN' })
  assert.equal(Array.from(out.text).length <= STRIP_MAX_CHARS, true)
  assert.equal(out.text.includes('$5.00'), true)
})
check('strip 隐藏：失败/未知/无窗口/无余额都返回 null', () => {
  assert.equal(formatStripText({ channelId: 'opencode-go', custom: false }, { availability: 'error' }), null)
  assert.equal(formatStripText({ channelId: 'opencode-go', custom: false }, { availability: 'unknown' }), null)
  assert.equal(formatStripText({ channelId: 'opencode-go', custom: false }, { availability: 'ok', windows: [] }), null)
  assert.equal(formatStripText({ channelId: 'deepseek', custom: false }, { availability: 'ok', balance: null }), null)
})
check('strip 文本永远 ≤24 字（含自定义长名）', () => {
  const out = formatStripText({ channelId: 'custom:x', custom: true, name: '超级无敌特别长的渠道名字啊' }, { availability: 'ok', balance: 12345.67, currency: 'USD' })
  assert.equal(Array.from(out.text).length <= STRIP_MAX_CHARS, true)
})

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log('strip 纯函数：' + passed + ' 项全部通过')
}
