/**
 * 一次性校验：把 F1/F2 的修复分别临时回退，确认用例会失败。
 * 仅本地运行，跑完自动还原文件。
 *
 * 用法：node tools/verify-f-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const runner = 'tools/test-usage-recheck-f1f2.mjs'
const cases = [
  {
    id: 'F1a 注册层丢弃 custom 冻结表',
    file: 'plans/usage-tool-register.js',
    from: '  for (const part of [snapshot.frozen, snapshot.custom]) {',
    to: '  for (const part of [snapshot.frozen]) {',
    test: 'F1.6',
  },
  {
    id: 'F1b provider 忽略冻结显式值',
    file: 'plans/custom-balance.js',
    from: "  } else if (frozenKind === 'explicit' || frozenKind === 'ref') {",
    to: "  } else if (false) {",
    test: 'F1.2',
  },
  {
    id: 'F1c provider 忽略冻结 none',
    file: 'plans/custom-balance.js',
    from: "  } else if (frozenKind === 'none' || frozenKind === 'unsupported') {",
    to: "  } else if (false) {",
    test: 'F1.3',
  },
  {
    id: 'F2a MiMo 把 none 当未采样',
    file: 'plans/mimo.js',
    from: '  if (frozen !== null) {',
    to: "  if (frozen !== null && frozen.kind !== 'none') {",
    test: 'F2.1',
  },
  {
    id: 'F2b MiMo 显式缺字段回退 cfg',
    file: 'plans/mimo.js',
    from: '    cookieSource = frozen.fields.mimoCookie',
    to: '    cookieSource = cfg != null ? cfg.mimoCookie : undefined',
    test: 'F2.2',
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
