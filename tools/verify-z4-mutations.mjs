/**
 * 一次性校验：把 Z4（混币 UI）的修复分别临时回退，确认用例会失败。
 * 仅本地运行，跑完自动还原文件。
 *
 * 用法：node tools/verify-z4-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const runner = 'tools/test-mixed-currency-ui.mjs'
const cases = [
  {
    id: 'Z4a 胶囊回退为「获取失败」',
    file: 'client.js',
    from: "    if (plan.mixedCurrency === true && typeof plan.balance !== 'number') {\n      capsuleRows.push({ dot: null, label: meta.name, values: ['多币种'], stale: plan.stale === true })",
    to: "    if (false) {\n      capsuleRows.push({ dot: null, label: meta.name, values: ['多币种'], stale: plan.stale === true })",
    test: 'Z4a',
  },
  {
    id: 'Z4b 详情回退为「余额获取失败」',
    file: 'client.js',
    from: "        if (plan.mixedCurrency === true && typeof plan.balance !== 'number') {",
    to: "        if (false) {",
    test: 'Z4b',
  },
  {
    id: 'Z4c 不传逐钱包币种',
    file: 'plans/deepseek.js',
    from: '      cashCurrency: account.cashCurrency === undefined ? null : account.cashCurrency,',
    to: '      cashCurrency: null,',
    test: 'Z4e',
  },
]

let ok = true
for (const item of cases) {
  const original = readFileSync(item.file, 'utf8')
  if (!original.includes(item.from)) {
    console.log('[SKIP] ' + item.id + '（未找到待替换片段）')
    ok = false
    continue
  }
  writeFileSync(item.file, original.replace(item.from, item.to), 'utf8')
  let output = ''
  let failed = false
  try {
    output = execFileSync(process.execPath, [runner], { encoding: 'utf8' })
  } catch (err) {
    failed = true
    output = String(err.stdout || '') + String(err.stderr || '')
  } finally {
    writeFileSync(item.file, original, 'utf8')
  }
  const hit = output.split('\n').filter((line) => line.includes('[FAIL]') && line.includes(item.test))
  if (failed && hit.length > 0) {
    console.log('[OK] ' + item.id + ' → 回退后 ' + item.test + ' 失败（用例有效）')
  } else {
    ok = false
    console.log('[MISS] ' + item.id + ' → 回退后没有检测到 ' + item.test + ' 失败')
    console.log('        exitFailed=' + failed + ' failLines=' + JSON.stringify(hit.slice(0, 2)))
  }
}

console.log('\n' + (ok ? '全部变异均被用例捕获' : '有用例未能捕获变异'))
process.exit(ok ? 0 : 1)
