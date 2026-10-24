/**
 * 一次性校验：把 Y1–Y4 的修复分别临时回退，确认新增用例确实会失败。
 * 仅本地运行，运行完自动还原文件；不改变产品代码。
 *
 * 用法：node tools/verify-y-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const cases = [
  {
    id: 'Y1 共享任务键不含身份',
    file: 'plans/usage-tool-register.js',
    from: "const key = String(snapshot.generation || '') + '\\u0000' + identity + '\\u0000'",
    to: "const key = String(snapshot.generation || '') + '\\u0000'",
    test: 'Y1a',
  },
  {
    id: 'Y2 采集时间不按采集当时写入',
    file: 'index.js',
    from: 'if (wire.fetchedAt === undefined) wire.fetchedAt = Date.now()',
    to: 'void wire /* mutation: 不打采集时间 */',
    test: 'Y2b',
  },
  {
    id: 'Y3 未订阅配置重载',
    file: 'index.js',
    from: "ctx.on('app-boot/config-reload', refreshPolicySection)",
    to: 'void refreshPolicySection /* mutation: 不订阅 */',
    test: 'Y3b',
  },
  {
    id: 'Y4 混币仍相加',
    file: 'plans/deepseek.js',
    from: 'const summed = sameCurrency ? (normal || 0) + (bonus || 0) : null',
    to: 'const summed = (normal || 0) + (bonus || 0)',
    test: 'Y4a',
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
    output = execFileSync(process.execPath, ['tools/test-usage-recheck-y1y4.mjs'], { encoding: 'utf8' })
  } catch (err) {
    failed = true
    output = String(err.stdout || '') + String(err.stderr || '')
  } finally {
    writeFileSync(item.file, original, 'utf8')
  }
  const hit = output.split('\n').filter((line) => line.includes('[FAIL]') && line.includes(item.test))
  const detected = failed && hit.length > 0
  if (detected) {
    console.log('[OK] ' + item.id + ' → 回退后 ' + item.test + ' 失败（用例有效）')
  } else {
    ok = false
    console.log('[MISS] ' + item.id + ' → 回退后没有检测到 ' + item.test + ' 失败')
    console.log('        exitFailed=' + failed + ' failLines=' + JSON.stringify(hit.slice(0, 2)))
  }
}

console.log('\n' + (ok ? '全部变异均被用例捕获' : '有用例未能捕获变异'))
process.exit(ok ? 0 : 1)
