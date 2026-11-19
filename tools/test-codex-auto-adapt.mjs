#!/usr/bin/env node
/**
 * [0.11.4] Codex Subscription **自动适配**（无专属清单时按最新清单的锚点唯一匹配）。
 *
 * 为什么要有这条：上游版本更新后，本包不一定已收录该版本的补丁清单；只要补丁要插入的
 * 位置（每条 hunk 的 old 锚点）在新版本里仍**恰好出现一次**，就可以安全地自动适配。
 *
 * 测试用真实已装的 3.2.24 文件作样本（只读取 profile 里的包，写入的是临时目录副本）。
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readPatchState, applyPatch, autoAdaptCandidate, loadManifest, coveredVersions,
} from '../plans/codex-subscription-patch.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('[PASS] ' + name) } else {
    failed += 1
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  }
}

const INSTALLED = 'C:\\Users\\Slacom\\.dsh\\profiles\\desktop\\node_modules\\dsh-codex-subscription'
const linked = existsSync(join(INSTALLED, 'package.json'))
check('样本：本机存在已装的 dsh-codex-subscription', linked)

const newest = loadManifest('3.2.23')
check('清单：最新收录版本为 3.2.23', newest.version === '3.2.23', coveredVersions())

let root = null
if (linked) {
  root = mkdtempSync(join(tmpdir(), 'cs-auto-'))
  const file = newest.file
  cpSync(join(INSTALLED, file), join(root, file))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-codex-subscription', version: '3.2.24' }) + '\n')

  const candidate = autoAdaptCandidate(root)
  check('自动适配：3.2.24 可命中 3.2.23 的锚点', candidate !== null && candidate.fromVersion === '3.2.23', candidate && candidate.fromVersion)

  const before = readPatchState(root)
  check('判定：无专属清单时状态为 appliable 且 auto=true',
    before.state === 'appliable' && before.auto === true && before.autoFromVersion === '3.2.23',
    { state: before.state, auto: before.auto, from: before.autoFromVersion })

  const backupRoot = join(root, 'backup')
  let applied = null
  try { applied = applyPatch(root, { backupRoot }) } catch (err) { applied = err }
  check('应用：自动模式写入成功并返回 auto=true',
    applied !== null && applied.applied === true && applied.auto === true && typeof applied.backup === 'string',
    applied && (applied.code || applied.message || applied))
  const text = readFileSync(join(root, newest.file), 'utf8')
  check('应用：文件中出现服务标记 codexSubscriptionUsage', text.includes('codexSubscriptionUsage'))
  const after = readPatchState(root)
  check('复测：自动模式下已适配 → pending', after.state === 'patched', after.state)
  const again = applyPatch(root, { backupRoot })
  check('幂等：再次调用不重复写入', again.applied === false, again.applied)

  // 负例：把某条锚点破坏 ⇒ 自动适配必须 fail-closed
  const broken = mkdtempSync(join(tmpdir(), 'cs-auto-broken-'))
  cpSync(join(INSTALLED, newest.file), join(broken, newest.file))
  writeFileSync(join(broken, 'package.json'), JSON.stringify({ name: 'dsh-codex-subscription', version: '9.9.9' }) + '\n')
  const brokenText = readFileSync(join(broken, newest.file), 'utf8').replace(newest.hunks[0].old, '/* anchor removed */')
  writeFileSync(join(broken, newest.file), brokenText)
  const brokenState = readPatchState(broken)
  check('负例：锚点缺失 ⇒ unsupported（不猜）', brokenState.state === 'unsupported', brokenState.state)
  rmSync(broken, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

console.log('\n' + (passed + failed) + ' 项：' + passed + ' 通过, ' + failed + ' 失败')
if (failed > 0) process.exitCode = 1
