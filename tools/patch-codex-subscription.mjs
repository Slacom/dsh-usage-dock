/**
 * [0.10.1] `dsh-codex-subscription` 只读 service 补丁工具（可入库、可复用）。
 * [0.10.3] 不再自带清单路径/版本判断：全部委托 `plans/codex-subscription-patch.js`
 *          （`readPatchState` / `applyPatch` / `revertPatch` / `manifestForVersion`），
 *          按**已装第三方包版本**选清单，多版本清单并存时自动命中。
 *
 * 背景：本仓库的 Codex `Subscription` 来源依赖第三方包上的**本地只读 service 补丁**。
 * 第三方升级 / 重装会覆盖它，本工具用一条命令重新打上并给出可验证结果。
 *
 * 用法：
 *   node tools/patch-codex-subscription.mjs                 # --check（默认，只读）
 *   node tools/patch-codex-subscription.mjs --apply         # 打补丁（原子替换 + 备份）
 *   node tools/patch-codex-subscription.mjs --revert        # 从最近一次备份恢复
 *   node tools/patch-codex-subscription.mjs --package-dir <path>   # 覆盖目标包目录
 *
 * 退出码：0 = 已适配 / 可适配 / 操作成功；2 = 不可适配或拒绝（零写入）；1 = 用法或 IO 错误。
 * 输出只含版本、哈希、布尔与 hunk id，**不打印包内源码**。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PATCH_CODES,
  PATCH_STATES,
  applyPatch,
  listManifests,
  readPatchState,
  revertPatch,
} from '../plans/codex-subscription-patch.js'

/** 目标包目录（唯一写死的用户路径，集中在这里；可用 --package-dir 覆盖）。 */
const DEFAULT_PACKAGE_DIR = 'C:\\Users\\Slacom\\.dsh\\profiles\\desktop\\node_modules\\dsh-codex-subscription'
const HERE = dirname(fileURLToPath(import.meta.url))
const BACKUP_ROOT = process.env.DSH_PATCH_BACKUP_ROOT ? resolve(process.env.DSH_PATCH_BACKUP_ROOT) : join(HERE, 'patches', 'backup')

const args = process.argv.slice(2)
const mode = args.includes('--apply') ? 'apply' : args.includes('--revert') ? 'revert' : 'check'
const dirIdx = args.indexOf('--package-dir')
const packageDir = dirIdx >= 0 && args[dirIdx + 1] ? resolve(args[dirIdx + 1]) : DEFAULT_PACKAGE_DIR

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const abort = (msg) => { console.log('不可适配：' + msg); process.exit(2) }

/** 目录里可用的清单版本（只用于提示，不参与选择）。 */
const coveredVersions = () => {
  try { return listManifests().map((e) => e.manifest.version).join(', ') || '（无）' } catch { return '（无）' }
}

const noManifest = (installed) => abort('当前第三方版本暂无对应补丁清单（已装 ' + (installed || '未知')
  + '，本插件覆盖 ' + coveredVersions() + '）——需按新版本重新生成 hunk 清单')

const pkgJsonPath = join(packageDir, 'package.json')
if (!existsSync(pkgJsonPath)) {
  console.error('目标包不完整（缺 package.json）：' + packageDir)
  process.exit(1)
}

// 状态一律由共用模块计算：按已装版本选清单，选不到 ⇒ unsupported（不读目标哈希、零写入）
let state
try {
  state = readPatchState(packageDir)
} catch (err) {
  console.error('读取补丁状态失败：' + (err && err.message ? err.message : String(err)))
  process.exit(1)
}
const manifest = state.manifest || null
console.log('包版本 = ' + (state.version || '未知')
  + '   清单 = ' + (manifest ? manifest.version : '（无匹配）')
  + '   模式 = ' + mode)
if (manifest && state.currentSha) console.log('当前 ' + manifest.file + ' = ' + state.currentSha)
console.log('状态 = ' + state.state)

function printHunks() {
  if (!manifest) return []
  const text = readFileSync(join(packageDir, manifest.file), 'utf8')
  const results = manifest.hunks.map((h) => ({ id: h.id, hits: text.split(h.old).length - 1 }))
  for (const r of results) console.log('hunk ' + r.id + ' 命中 ' + r.hits + ' 次' + (r.hits === 1 ? ' ✓' : ' ✗'))
  return results
}

if (mode === 'check') {
  if (state.state === PATCH_STATES.PATCHED) {
    console.log('结论：已适配（哈希等于 programSha）')
    process.exit(0)
  }
  if (state.state === PATCH_STATES.APPLIABLE) {
    const results = printHunks()
    const bad = results.filter((r) => r.hits !== 1)
    if (bad.length > 0) abort('有 ' + bad.length + ' 条 hunk 无法唯一命中：' + bad.map((r) => r.id).join(', '))
    console.log('结论：可适配（' + results.length + ' 条 hunk 均可唯一命中，尚未写入）')
    process.exit(0)
  }
  if (!manifest) noManifest(state.version)
  abort('既不是 baseSha 也不是 programSha —— 基线未知（可能被其它补丁改过）')
}

if (mode === 'apply') {
  if (!manifest) noManifest(state.version)
  if (state.state === PATCH_STATES.APPLIABLE) {
    const results = printHunks()
    const bad = results.filter((r) => r.hits !== 1)
    if (bad.length > 0) abort('有 ' + bad.length + ' 条 hunk 无法唯一命中：' + bad.map((r) => r.id).join(', '))
  }
  let out
  try {
    out = applyPatch(packageDir, { backupRoot: BACKUP_ROOT })
  } catch (err) {
    const code = err && err.code
    if (code === PATCH_CODES.UNSUPPORTED) {
      if (!manifest || state.state === PATCH_STATES.UNSUPPORTED) {
        // 目标哈希既非 base 也非 program：拒绝在未知基线上写入（零写入）
        abort('当前哈希不是 baseSha 也不是 programSha，拒绝在未知基线上打补丁（' + (manifest ? manifest.baseSha : '无清单') + '）')
      }
      abort('不可写入（' + String(code) + '）')
    }
    if (code === PATCH_CODES.VERIFY) abort('打完后哈希 ≠ programSha（零写入，可 --check 复核）')
    if (code === PATCH_CODES.ARGS) {
      console.error('缺少备份目录（E_CS_PATCH_ARGS）')
      process.exit(1)
    }
    console.error('打补丁失败（' + String(code || 'IO') + '）')
    process.exit(1)
  }
  if (out.applied !== true) {
    console.log('结论：已适配，无需重复写入')
    process.exit(0)
  }
  console.log('结论：已打上补丁（' + String(state.currentSha).slice(0, 8) + ' → ' + out.newSha.slice(0, 8) + '），备份 = ' + out.backup)
  process.exit(0)
}

if (mode === 'revert') {
  if (!existsSync(BACKUP_ROOT)) { console.log('没有备份可回退'); process.exit(1) }
  const dirs = readdirSync(BACKUP_ROOT).filter((d) => statSync(join(BACKUP_ROOT, d)).isDirectory()).sort()
  if (dirs.length === 0) { console.log('没有备份可回退'); process.exit(1) }
  let out
  try {
    out = revertPatch(packageDir, BACKUP_ROOT)
  } catch (err) {
    const code = err && err.code
    if (code === PATCH_CODES.UNSUPPORTED) noManifest(state.version)
    if (code === PATCH_CODES.VERIFY) abort('备份哈希 ≠ baseSha，拒绝恢复')
    console.error('回退失败（' + String(code || 'IO') + '）')
    process.exit(1)
  }
  console.log('结论：已回退到 baseSha（' + String(out.restoredSha).slice(0, 8) + '，来自备份 ' + out.backupDir + '）')
  process.exit(0)
}

console.error('用法：node tools/patch-codex-subscription.mjs [--apply|--revert] [--package-dir <path>]')
process.exit(1)
