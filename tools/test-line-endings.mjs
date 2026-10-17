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
    record(file + ' 存在（git HEAD 可读）', false, String(err && err.message).slice(0, 120))
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
