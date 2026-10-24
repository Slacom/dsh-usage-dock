/**
 * 行尾守护测试（0.8.3）：仓库各文件必须保持 git 中记录的行尾风格。
 *
 * 背景（真实踩坑）：本项目的 edit/write 工具与 PowerShell 写文件在这台机器上
 * 会把文件转成 CRLF，而仓库里绝大多数文件是 LF。两个测试（test-peak-marker、
 * test-android-compat）依赖 `client.js` 的**行号/锚点字符串**做代码截取，
 * 锚点用 `\n` 书写——文件一旦变 CRLF，`indexOf` 返回 -1，截取失败，
 * 测试报出「Unexpected token」这类与真实原因无关的错误（浪费过多轮排查）。
 *
 * 本测试按 git index 里的 blob 判定每个文件应有的行尾，直接读工作区字节比较。
 * 用法：node tools/test-line-endings.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** 需要守护的文件（仓库里所有会被工具改写的源码/文档）。 */
const FILES = [
  'client.js',
  'index.js',
  'plans/index.js',
  'plans/util.js',
  'plans/custom-balance.js',
  'plans/usage-tool-register.js',
  'plans/deepseek.js',
  'plans/workbuddy.js',
  'plans/mimo.js',
  'plans/peak-phase.js',
  'tools/mock-react.mjs',
  'tools/test-workbuddy.mjs',
  'tools/test-settings.mjs',
  'tools/test-android-compat.mjs',
  'tools/test-degrade-refresh.mjs',
  'tools/test-peak-marker.mjs',
  'tools/test-panel-interactions.mjs',
  'tools/test-fetch-backends.mjs',
  'tools/test-collapsed-pill.mjs',
  'tools/test-footer-row.mjs',
  'tools/test-custom-balance.mjs',
  'tools/test-custom-balance-fetch.mjs',
  'tools/test-custom-settings.mjs',
  'tools/test-custom-render.mjs',
  'tools/test-custom-security.mjs',
  'tools/test-host-custom.mjs',
  'tools/test-review-fixes.mjs',
  'tools/test-custom-race.mjs',
  'tools/test-config-unwrap.mjs',
  'tools/test-recheck-fixes.mjs',
  'tools/test-recheck-round3.mjs',
  'tools/test-recheck-round4.mjs',
  'tools/test-usage-tool.mjs',
  'tools/test-usage-tool-register.mjs',
  'tools/test-usage-tool-host.mjs',
  'tools/test-usage-policy.mjs',
  'tools/test-usage-integration.mjs',
  'tools/test-usage-recheck-y1y4.mjs',
  'tools/test-usage-recheck-z1z3.mjs',
  'tools/verify-y-mutations.mjs',
  'tools/verify-z-mutations.mjs',
  'tools/test-mixed-currency-ui.mjs',
  'tools/verify-z4-mutations.mjs',
  'tools/test-usage-recheck-q1q3.mjs',
  'tools/verify-q-mutations.mjs',
  'tools/test-usage-recheck-f1f2.mjs',
  'tools/verify-f-mutations.mjs',
  'tools/test-usage-tool-contract-host.mjs',
  'tools/host-json-schema.mjs',
  'plans/quota-observer.js',
  'plans/quota-route.js',
  'plans/quota-view.js',
  'plans/quota-prompt.js',
  'tools/test-quota-awareness.mjs',
  'tools/test-quota-remediation.mjs',
  'tools/test-quota-route-scope.mjs',
  'tools/test-quota-round2.mjs',
  'tools/test-quota-round3.mjs',
  'tools/test-quota-round4.mjs',
  'tools/test-quota-round5.mjs',
  'tools/test-custom-provider-source.mjs',
  'tools/test-custom-provider-round2.mjs',
  'tools/test-custom-order.mjs',
  'tools/test-custom-round3.mjs',
  'tools/test-custom-round5.mjs',
  'tools/test-custom-operation-lifecycle.mjs',
  'tools/fixtures/custom-operation.mjs',
  'tools/test-workbuddy-gateway.mjs',
  'tools/test-workbuddy-round6.mjs',
  'tools/test-workbuddy-round7.mjs',
  'tools/test-workbuddy-round8.mjs',
  'tools/test-workbuddy-round9.mjs',
  'docs/release-notes-v0.8.3.md',
  'AGENTS.md',
  'README.md',
]

/** 读 git index 中的 blob 原始字节（不经 PowerShell 管道，避免行尾被转换）。 */
function headBytes(file) {
  return execFileSync('git', ['cat-file', 'blob', 'HEAD:' + file], {
    cwd: process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
  })
}

/** 统计字节里的 CRLF / 裸 LF 数量。 */
function countEndings(bytes) {
  let crlf = 0
  let lfOnly = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 10) continue
    if (i > 0 && bytes[i - 1] === 13) crlf += 1
    else lfOnly += 1
  }
  return { crlf, lfOnly }
}

const results = []
function record(name, ok, note) {
  results.push({ name, ok })
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (note ? ' — ' + note : ''))
}

let failures = 0
for (const file of FILES) {
  let head
  try {
    head = headBytes(file)
  } catch (err) {
    const message = String(err && err.message).slice(0, 200)
    // [0.9.0] 新增文件在提交前不存在于 git HEAD（`HEAD:<path>` 会失败）。这不是行尾问题，
    // 因此对「文件存在但不在 HEAD」的情况只校验「工作区必须全 LF」；真正的读盘/权限失败
    // （如沙箱禁止 spawn git）仍然报 FAIL，不要拿它掩盖环境问题。
    // 注意 stderr 会把路径截断成 "exists on dis…"，所以匹配词要短且稳健。
    const notInHead = /exists on disk, but not in|not in 'HEAD'|Not a valid object name|does not exist in/i.test(message)
    if (notInHead) {
      let work
      try {
        work = readFileSync(file)
      } catch (readErr) {
        record(file + ' 存在（工作区可读）', false, String(readErr && readErr.message).slice(0, 120))
        failures += 1
        continue
      }
      const endings = countEndings(work)
      const ok = endings.crlf === 0 && endings.lfOnly > 0
      record(file + ' 新增文件行尾 = LF', ok, ok ? null : ('CRLF=' + endings.crlf + ', LF=' + endings.lfOnly))
      if (!ok) failures += 1
      continue
    }
    record(file + ' 存在（git HEAD 可读）', false, message)
    failures += 1
    continue
  }
  const headEndings = countEndings(head)
  // 该文件在 git 里的行尾风格（以多数为准；全 LF 或全 CRLF）。
  const headStyle = headEndings.crlf > 0 && headEndings.lfOnly === 0 ? 'CRLF' : 'LF'
  const worktree = readFileSync(file)
  const workEndings = countEndings(worktree)
  // 工作区不得出现混合行尾。
  const mixed = workEndings.crlf > 0 && workEndings.lfOnly > 0
  const workStyle = workEndings.crlf > 0 && workEndings.lfOnly === 0 ? 'CRLF' : 'LF'
  const ok = !mixed && workStyle === headStyle
  record(file + ' 行尾 = ' + headStyle, ok,
    ok ? null : ('工作区 ' + (mixed ? 'MIXED' : workStyle) + '（CRLF=' + workEndings.crlf + ', LF=' + workEndings.lfOnly + '）'))
  if (!ok) failures += 1
}

console.log(failures === 0
  ? '\n全部 ' + results.length + ' 项通过（行尾与 git 记录一致）'
  : '\n' + results.length + ' 项：' + (results.length - failures) + ' 通过, ' + failures + ' 失败')
process.exit(failures === 0 ? 0 : 1)
