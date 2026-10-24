/**
 * 一次性校验：把 Z1–Z3 的修复分别临时回退，确认 `test-usage-recheck-z1z3.mjs` 会失败。
 * 仅本地运行，跑完自动还原文件。
 *
 * 用法：node tools/verify-z-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const cases = [
  {
    id: 'Z1 不看凭据快照，二次解析',
    file: 'plans/util.js',
    from: '  if (snapshot !== null) {',
    to: '  if (false) { /* mutation: 忽略快照 */',
    test: 'Z1a',
  },
  {
    id: 'Z2a 传输层不监听外部取消',
    file: 'plans/custom-balance.js',
    from: "      external.addEventListener('abort', onAbort, { once: true })",
    to: '      void onAbort /* mutation: 不监听取消 */',
    test: 'Z2a2',
  },
  {
    id: 'Z2b 不逐条回传',
    file: 'plans/custom-balance.js',
    from: '      try { onItem(wire) } catch (err) { /* 回传失败不影响整批 */ }',
    to: '      /* mutation: 不回传 */',
    test: 'Z2b',
  },
  {
    id: 'Z3 reload 不作废配置缓存',
    file: 'index.js',
    from: '        if (typeof liveConfig.invalidate === \'function\') liveConfig.invalidate()',
    to: '        /* mutation: 沿用两秒缓存 */',
    test: 'Z3b',
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
    output = execFileSync(process.execPath, ['tools/test-usage-recheck-z1z3.mjs'], { encoding: 'utf8' })
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
