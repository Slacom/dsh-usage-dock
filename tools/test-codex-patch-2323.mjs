/**
 * [0.11.2] 3.2.23 适配清单的离线回归（不需要 .diagnostics 夹具）。
 *
 * 两组断言：
 *   M  清单本身：文件名/版本/哈希形态、`coveredVersions()` 能列出它、以及**与已装包精确匹配**；
 *   A  真打一遍：把已装的 `dsh-codex-subscription` **复制到临时目录**，用插件自己的 API
 *      （`readPatchState` → `applyPatch` → `readPatchState`）走一遍，证明
 *      `appliable → patched`、打完的文件哈希等于清单里的 `programSha`，且 `node --check` 通过。
 *
 * 已装包不存在 / 版本不是 3.2.23 / 基线哈希不是清单里的 `baseSha` 时，A 组**跳过并打印原因**
 * （不伪造通过）；这种情况说明「本机那份不是清单对应的字节」，真机上应当在界面上看到
 * 「与基线不一致」而不是给按钮。
 *
 * 用法：node tools/test-codex-patch-2323.mjs
 *      DSH_CS_PACKAGE_DIR=<dsh-codex-subscription 目录> node tools/test-codex-patch-2323.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { coveredVersions, manifestForVersion, readPatchState, applyPatch, resolvePackageDir } from '../plans/codex-subscription-patch.js'

const VERSION = '3.2.23'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let pass = 0
let fail = 0
let skipped = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('[PASS] ' + name) } else {
    fail++
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300)))
  }
}
const skip = (name, why) => { skipped++; console.log('[SKIP] ' + name + ' — ' + why) }

// ── M 清单本身 ────────────────────────────────────────────────────────────
const entry = manifestForVersion(VERSION)
check('M1 清单目录里有 ' + VERSION + ' 的清单', entry !== null && entry.manifest.version === VERSION)
const manifest = entry ? entry.manifest : null
check('M2 清单字段合法（file / baseSha / programSha / 至少 1 条 hunk）',
  manifest !== null && manifest.file === 'lib/index.js'
  && /^[0-9a-f]{64}$/.test(manifest.baseSha) && /^[0-9a-f]{64}$/.test(manifest.programSha)
  && Array.isArray(manifest.hunks) && manifest.hunks.length > 0)
check('M3 清单是**独立**的（不依赖 inheritFrom，旧版模块也能用）',
  manifest !== null && manifest.inheritFrom === undefined)
check('M4 coveredVersions() 列出 ' + VERSION, coveredVersions().includes(VERSION), coveredVersions())
check('M5 每条 hunk 的 id 唯一', manifest !== null
  && new Set(manifest.hunks.map((h) => h.id)).size === manifest.hunks.length)

// ── A 在真实安装的副本上真打一遍 ──────────────────────────────────────────
const candidates = [
  process.env.DSH_CS_PACKAGE_DIR,
  join(process.env.HOME || '', '.dsh', 'profiles', 'web', 'node_modules', 'dsh-codex-subscription'),
  // 插件自身位置推导（pnpm 布局也能命中）
  (() => { try { return resolvePackageDir() } catch (err) { return null } })(),
].filter((dir) => typeof dir === 'string' && dir.length > 0 && existsSync(join(dir, 'package.json')))

if (candidates.length === 0) {
  skip('A 真打一遍', '本机没有安装 dsh-codex-subscription')
} else {
  const src = candidates[0]
  const require = createRequire(join(src, 'package.json'))
  let installed = null
  try { installed = require('./package.json').version } catch (err) { installed = null }
  const targetSha = sha256(readFileSync(join(src, 'lib', 'index.js')))
  if (installed !== VERSION) {
    skip('A 真打一遍', '已装版本是 ' + String(installed) + '，不是 ' + VERSION)
  } else if (manifest !== null && targetSha === manifest.programSha) {
    /**
     * 本机**已经适配过**（文件哈希 == programSha）：不再重打（会破坏幂等断言的前提），
     * 改为验证「已适配」这一态：state=patched、serviceAvailable=true、再打一次不写入。
     */
    const st = readPatchState(src)
    check('A1\u2032 已适配的安装 ⇒ state=patched', st.state === 'patched', st.state)
    check('A2\u2032 已适配的安装 ⇒ serviceAvailable=true', st.serviceAvailable === true)
    const again = applyPatch(src, { backupRoot: join(tmpdir(), 'dsh-cs-2323-noop') })
    check('A3\u2032 已适配时幂等：不写入、不要求重启', again.applied === false && again.requiresRestart === false, again)
  } else if (manifest !== null && targetSha !== manifest.baseSha) {
    skip('A 真打一遍', '已装文件哈希与清单 baseSha 不一致（真机应显示「与基线不一致」）')
  } else {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cs-2323-'))
    try {
      const fixture = join(root, 'dsh-codex-subscription')
      cpSync(src, fixture, { recursive: true })
      const before = readPatchState(fixture)
      check('A1 未适配副本 ⇒ state=appliable', before.state === 'appliable', before.state)
      check('A2 未适配副本 ⇒ serviceAvailable=false', before.serviceAvailable === false)
      const out = applyPatch(fixture, { backupRoot: join(root, 'backup') })
      check('A3 applyPatch 报告已写入且需要重启', out.applied === true && out.requiresRestart === true, out)
      const patchedFile = join(fixture, 'lib', 'index.js')
      const patchedSha = sha256(readFileSync(patchedFile))
      check('A4 打完的文件哈希 == programSha', manifest !== null && patchedSha === manifest.programSha, patchedSha.slice(0, 12))
      const after = readPatchState(fixture)
      check('A5 打完 ⇒ state=patched 且 serviceAvailable=true',
        after.state === 'patched' && after.serviceAvailable === true, { state: after.state, service: after.serviceAvailable })
      const checked = spawnSync(process.execPath, ['--check', patchedFile], { encoding: 'utf8' })
      check('A6 打完的文件能通过 node --check', checked.status === 0, String(checked.stderr).slice(0, 200))
      // 幂等：再打一次不应再写（applied:false，requiresRestart:false）。
      const again = applyPatch(fixture, { backupRoot: join(root, 'backup') })
      check('A7 已适配时幂等（applied=false、不再要求重启）', again.applied === false && again.requiresRestart === false, again)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

console.log('累计：' + (pass + fail) + ' 项断言：' + pass + ' 通过, ' + fail + ' 失败' + (skipped > 0 ? ', ' + skipped + ' 组跳过' : ''))
process.exit(fail === 0 ? 0 : 1)
