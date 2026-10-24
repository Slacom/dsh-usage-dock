/**
 * 一次性校验：把 Q1–Q3 的修复分别临时回退，确认用例会失败。
 * 仅本地运行，跑完自动还原文件。
 *
 * 用法：node tools/verify-q-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const runner = 'tools/test-usage-recheck-q1q3.mjs'
const cases = [
  {
    id: 'Q1 provider 不认冻结值（回到读当前配置）',
    file: 'plans/util.js',
    from: '  const frozen = options !== null && options !== undefined ? options.frozenCredential : null',
    to: '  const frozen = null',
    test: 'Q1d',
  },
  {
    id: 'Q2A 未采样渠道被当成无凭据',
    file: 'plans/util.js',
    from: '  const frozen = options !== null && options !== undefined ? options.frozenCredential : null',
    to: "  const frozen = { kind: 'none' }",
    test: 'Q2a',
  },
  {
    id: 'Q2B 首个空候选即返回',
    file: 'index.js',
    from: '            if (resolved.value.length === 0 || isSentinelApiKey(resolved.value)) continue',
    to: '            if (resolved.value.length === 0 || isSentinelApiKey(resolved.value)) { picked = null; break }',
    test: 'Q2b',
  },
  {
    id: 'Q3 停用渠道仍读凭据',
    file: 'index.js',
    from: '        if (cfgNow[plan.fields.enabled] === false) continue\n        if (ACCOUNT_BOUND_PLAN_IDS.has(plan.id)) continue',
    to: '        if (ACCOUNT_BOUND_PLAN_IDS.has(plan.id)) continue',
    test: 'Q3a',
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
