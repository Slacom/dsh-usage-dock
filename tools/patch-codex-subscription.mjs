/**
 * [0.10.1] `dsh-codex-subscription` 只读 service 补丁工具（可入库、可复用）。
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
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 目标包目录（唯一写死的用户路径，集中在这里；可用 --package-dir 覆盖）。 */
const DEFAULT_PACKAGE_DIR = 'C:\\Users\\Slacom\\.dsh\\profiles\\desktop\\node_modules\\dsh-codex-subscription'
const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, '..', 'plans', 'patches', 'codex-subscription-3.2.6.json')
const BACKUP_ROOT = process.env.DSH_PATCH_BACKUP_ROOT ? resolve(process.env.DSH_PATCH_BACKUP_ROOT) : join(HERE, 'patches', 'backup')

const args = process.argv.slice(2)
const mode = args.includes('--apply') ? 'apply' : args.includes('--revert') ? 'revert' : 'check'
const dirIdx = args.indexOf('--package-dir')
const packageDir = dirIdx >= 0 && args[dirIdx + 1] ? resolve(args[dirIdx + 1]) : DEFAULT_PACKAGE_DIR

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const abort = (msg) => { console.log('不可适配：' + msg); process.exit(2) }

if (!existsSync(MANIFEST)) { console.error('缺少 hunk 清单：' + MANIFEST); process.exit(1) }
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const pkgJsonPath = join(packageDir, 'package.json')
const targetPath = join(packageDir, manifest.file)
if (!existsSync(pkgJsonPath) || !existsSync(targetPath)) {
  console.error('目标包不完整（缺 package.json 或 ' + manifest.file + '）：' + packageDir)
  process.exit(1)
}
const installedVersion = String(JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version || '')
console.log('包版本 = ' + installedVersion + '（清单钉死 ' + manifest.version + '）   模式 = ' + mode)

// 版本钉死：不做模糊匹配
if (installedVersion !== manifest.version) {
  abort('版本不符（' + installedVersion + ' ≠ ' + manifest.version + '）——需按新版本重新生成 hunk 清单')
}

const currentBytes = readFileSync(targetPath)
const currentSha = sha256(currentBytes)
console.log('当前 ' + manifest.file + ' = ' + currentSha)

function hunkCheck(bytes) {
  const text = bytes.toString('utf8')
  const results = []
  for (const h of manifest.hunks) {
    const count = text.split(h.old).length - 1
    results.push({ id: h.id, hits: count, ok: count === 1 })
  }
  return results
}

function applyHunks(bytes) {
  let text = bytes.toString('utf8')
  for (const h of manifest.hunks) {
    if (text.split(h.old).length - 1 !== 1) throw new Error('hunk 命中数不为 1：' + h.id)
    text = text.replace(h.old, h.new)
  }
  return Buffer.from(text, 'utf8')
}

const alreadyAdapted = sameSha(currentSha, manifest.programSha)
const isBase = sameSha(currentSha, manifest.baseSha)
if (mode === 'check') {
  if (alreadyAdapted) {
    console.log('结论：已适配（哈希等于 programSha）')
    process.exit(0)
  }
  if (!isBase) abort('既不是 baseSha 也不是 programSha —— 基线未知（可能被其它补丁改过）')
  const results = hunkCheck(currentBytes)
  for (const r of results) console.log('hunk ' + r.id + ' 命中 ' + r.hits + ' 次' + (r.ok ? ' ✓' : ' ✗'))
  const bad = results.filter((r) => !r.ok)
  if (bad.length > 0) abort('有 ' + bad.length + ' 条 hunk 无法唯一命中：' + bad.map((r) => r.id).join(', '))
  console.log('结论：可适配（' + results.length + ' 条 hunk 均可唯一命中，尚未写入）')
  process.exit(0)
}

if (mode === 'apply') {
  if (alreadyAdapted) {
    console.log('结论：已适配，无需重复写入')
    process.exit(0)
  }
  if (!isBase) abort('当前哈希不是 baseSha（' + manifest.baseSha + '），拒绝在未知基线上打补丁')
  const results = hunkCheck(currentBytes)
  const bad = results.filter((r) => !r.ok)
  if (bad.length > 0) abort('有 ' + bad.length + ' 条 hunk 无法唯一命中：' + bad.map((r) => r.id).join(', '))

  let next
  try { next = applyHunks(currentBytes) } catch (err) { abort(err.message) }
  const nextSha = sha256(next)
  if (!sameSha(nextSha, manifest.programSha)) abort('打完后哈希 ' + nextSha + ' ≠ programSha')

  // 备份（先备份后写入；备份本身用 wx 防覆盖）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(BACKUP_ROOT, stamp)
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, manifest.file.replace(/[\\/]/g, '__'))
  writeFileSync(backupPath, currentBytes, { flag: 'wx' })
  writeFileSync(join(backupDir, 'meta.json'), JSON.stringify({
    createdAt: new Date().toISOString(), manifest: MANIFEST, packageDir,
    file: manifest.file, baseSha: manifest.baseSha, programSha: manifest.programSha,
  }, null, 2) + '\n')

  // 原子替换：同目录 wx 临时文件 → 写 → 读回校验 → rename
  const tmp = targetPath + '.tmp-' + process.pid
  writeFileSync(tmp, next, { flag: 'wx' })
  const readBack = readFileSync(tmp)
  if (!sameSha(sha256(readBack), manifest.programSha)) { try { unlinkSync(tmp) } catch { /* ignore */ } abort('临时文件读回校验失败') }
  renameSync(tmp, targetPath)
  const finalSha = sha256(readFileSync(targetPath))
  if (!sameSha(finalSha, manifest.programSha)) abort('写入后哈希不符（已备份，可 --revert 回退）')
  console.log('结论：已打上补丁（' + currentSha.slice(0, 8) + ' → ' + finalSha.slice(0, 8) + '），备份 = ' + backupPath)
  process.exit(0)
}

if (mode === 'revert') {
  if (!existsSync(BACKUP_ROOT)) { console.log('没有备份可回退'); process.exit(1) }
  const dirs = readdirSync(BACKUP_ROOT).filter((d) => statSync(join(BACKUP_ROOT, d)).isDirectory()).sort()
  if (dirs.length === 0) { console.log('没有备份可回退'); process.exit(1) }
  const latest = join(BACKUP_ROOT, dirs[dirs.length - 1])
  const backupPath = join(latest, manifest.file.replace(/[\\/]/g, '__'))
  if (!existsSync(backupPath)) { console.log('最近一次备份里没有 ' + manifest.file); process.exit(1) }
  const backupBytes = readFileSync(backupPath)
  const backupSha = sha256(backupBytes)
  if (!sameSha(backupSha, manifest.baseSha)) abort('备份哈希 ' + backupSha + ' ≠ baseSha，拒绝恢复')
  const tmp = targetPath + '.tmp-' + process.pid
  writeFileSync(tmp, backupBytes, { flag: 'wx' })
  if (!sameSha(sha256(readFileSync(tmp)), manifest.baseSha)) { try { unlinkSync(tmp) } catch { /* ignore */ } abort('临时文件读回校验失败') }
  renameSync(tmp, targetPath)
  const restored = sha256(readFileSync(targetPath))
  if (!sameSha(restored, manifest.baseSha)) abort('恢复后哈希不符')
  console.log('结论：已回退到 baseSha（来自备份 ' + latest + '）')
  process.exit(0)
}
