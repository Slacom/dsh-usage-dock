#!/usr/bin/env node
/**
 * deploy-local-profile.mjs —— 本地部署脚本（离线，不联网、不发布、不重启）
 *
 * 用途：把工作区这一版插件装到 desktop profile 的
 *   C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock
 * 源 = 工作区仓库根目录下由 package.json `files` 字段决定的内容（含 package.json 自身）。
 * 全程只用本地文件，不执行 npm install / npm pack / 任何网络请求。
 *
 * 用法：
 *   node tools/deploy-local-profile.mjs              # 默认 dry-run：只打印计划
 *   node tools/deploy-local-profile.mjs --execute    # 真正执行（备份 → 部署 → 校验 → 收据）
 *
 * 部署方式（按优先级）：
 *   a. 整目录交换：内容先建到 <parent>\.dsh-usage-dock.new，成功后
 *      旧目录 → .dsh-usage-dock.old，.new → dsh-usage-dock，最后删除 .old。
 *   b. 逐文件原子替换（改名失败/占用时回退）：同目录唯一临时名 wx 写入 → 读回 SHA256 →
 *      rename 覆盖；随后删除目标里多余的文件（删除前逐个确认已存在且同哈希于备份中）。
 *
 * 安全边界：只写目标插件目录 + 仓库 .diagnostics/local-deploy-0.10.3/。
 * 不读取、不写入 profile 根目录的 cordis.patch.yml（那是 profile 级配置，与本任务无关）。
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync,
  renameSync, rmSync, openSync, writeSync, closeSync, unlinkSync, existsSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'C:\\Users\\Slacom\\.dsh\\profiles\\desktop\\node_modules\\dsh-usage-dock'
const TARGET_PARENT = path.dirname(TARGET)
const NEW_DIR = path.join(TARGET_PARENT, '.dsh-usage-dock.new')
const OLD_DIR = path.join(TARGET_PARENT, '.dsh-usage-dock.old')
const STAGING = path.join(REPO, '.diagnostics', 'local-deploy-0.10.3')
const TMP_PREFIX = '.deploy-tmp-'

const EXECUTE = process.argv.includes('--execute')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 基础工具 ----------

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex')
const sha256File = (abs) => sha256Buf(readFileSync(abs))
const toPosix = (p) => p.split(path.sep).join('/')

/** 递归列出目录下的文件（相对路径，posix 分隔），并镜像空目录 */
function walkFiles(root, base = root, out = []) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, name.name)
    if (name.isDirectory()) walkFiles(abs, base, out)
    else if (name.isFile()) out.push(toPosix(path.relative(base, abs)))
  }
  return out
}

function walkDirs(root, base = root, out = []) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const abs = path.join(root, name.name)
    out.push(toPosix(path.relative(base, abs)))
    walkDirs(abs, base, out)
  }
  return out
}

/** files 字段 → 源文件集合（rel → abs） */
function collectSource() {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const entries = [...new Set([...(pkg.files || []), 'package.json'])]
  const map = new Map()
  for (const entry of entries) {
    const abs = path.join(REPO, entry)
    if (!existsSync(abs)) throw new Error(`package.json files 声明的路径不存在：${entry}`)
    if (statSync(abs).isDirectory()) {
      for (const rel of walkFiles(abs)) map.set(`${entry}/${rel}`, path.join(abs, rel))
    } else {
      map.set(toPosix(entry), abs)
    }
  }
  return { map, version: pkg.version }
}

/** 目标目录现状（rel → sha） */
function snapshotTarget() {
  const map = new Map()
  if (!existsSync(TARGET)) return map
  for (const rel of walkFiles(TARGET)) map.set(rel, sha256File(path.join(TARGET, rel)))
  return map
}

/** 源/目标 SHA 对比 */
function compare(sourceMap, targetSnap) {
  const missing = []
  const changed = []
  const extra = []
  for (const [rel, abs] of sourceMap) {
    const sha = sha256File(abs)
    if (!targetSnap.has(rel)) missing.push(rel)
    else if (targetSnap.get(rel) !== sha) changed.push(rel)
  }
  for (const rel of targetSnap.keys()) if (!sourceMap.has(rel)) extra.push(rel)
  return { missing, changed, extra, mismatches: missing.length + changed.length + extra.length }
}

/** 同目录唯一临时名 + wx 创建 → 读回校验 SHA256 → rename 覆盖 */
function writeFileAtomic(targetAbs, buf) {
  mkdirSync(path.dirname(targetAbs), { recursive: true })
  const tmp = path.join(
    path.dirname(targetAbs),
    `${TMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const fd = openSync(tmp, 'wx') // wx：已存在即失败，绝不覆盖他人临时文件
  try {
    writeSync(fd, buf)
  } finally {
    closeSync(fd)
  }
  const want = sha256Buf(buf)
  if (sha256Buf(readFileSync(tmp)) !== want) {
    rmSync(tmp, { force: true })
    throw new Error(`临时文件读回校验失败：${tmp}`)
  }
  renameSync(tmp, targetAbs) // 同目录 rename 覆盖目标
  return want
}

/** 完整复制目录（含子目录），返回文件数 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  let count = 0
  for (const rel of walkDirs(src)) mkdirSync(path.join(dest, rel), { recursive: true })
  for (const rel of walkFiles(src)) {
    const to = path.join(dest, rel)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(path.join(src, rel), to)
    count++
  }
  return count
}

async function rmTreeRetry(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      return true
    } catch {
      await sleep(250)
    }
  }
  return !existsSync(dir)
}

// ---------- 主流程 ----------

async function main() {
  const source = collectSource()
  const targetSnap = snapshotTarget()
  const diff = compare(source.map, targetSnap)

  const utc = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z')
  const backupDir = path.join(STAGING, 'backup', utc)

  console.log('=== dsh-usage-dock 本地部署（desktop profile）===')
  console.log(`模式        : ${EXECUTE ? 'EXECUTE（真实写入）' : 'DRY-RUN（只打印计划）'}`)
  console.log(`源仓库      : ${REPO}  (version ${source.version})`)
  console.log(`目标目录    : ${TARGET}`)
  console.log(`目标已存在  : ${existsSync(TARGET)}`)
  console.log(`源文件数    : ${source.map.size}`)
  console.log(`目标文件数  : ${targetSnap.size}`)
  console.log(`将写入      : ${diff.missing.length + diff.changed.length}（新增 ${diff.missing.length} / 变更 ${diff.changed.length}）`)
  console.log(`将删除      : ${diff.extra.length}`)
  console.log(`备份路径    : ${backupDir}`)
  if (diff.extra.length) {
    console.log('--- 待删除（目标有、新版本没有）---')
    for (const rel of diff.extra) console.log(`  - ${rel}`)
  }
  const writeList = [...diff.missing, ...diff.changed].sort()
  if (writeList.length) {
    console.log('--- 待写入 ---')
    for (const rel of writeList) console.log(`  + ${rel}`)
  }
  if (!EXECUTE) {
    console.log('\nDRY-RUN 结束：未写入任何文件。加 --execute 真正执行。')
    return 0
  }

  if (!existsSync(TARGET)) throw new Error(`目标目录不存在：${TARGET}（本脚本只做覆盖式本地部署）`)
  if (existsSync(NEW_DIR) || existsSync(OLD_DIR)) {
    throw new Error(`检测到残留临时目录，请先人工确认：${NEW_DIR} / ${OLD_DIR}`)
  }

  // 1) 备份（含所有子目录），并逐文件校验
  const backupCount = copyTree(TARGET, backupDir)
  const backupSnap = snapshotTarget()
  for (const [rel, sha] of backupSnap) {
    const bAbs = path.join(backupDir, rel)
    if (!existsSync(bAbs) || sha256File(bAbs) !== sha) throw new Error(`备份校验失败：${rel}`)
  }
  if (backupCount !== backupSnap.size) {
    throw new Error(`备份文件数不符：复制 ${backupCount} / 现状 ${backupSnap.size}`)
  }
  console.log(`\n[1/5] 备份完成：${backupCount} 个文件 → ${backupDir}`)

  // 2) 构建新内容
  let method = 'dir-swap'
  let removed = []
  const written = []

  const buildInto = (dest) => {
    let n = 0
    for (const [rel, abs] of source.map) {
      const to = path.join(dest, rel)
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(abs, to)
      n++
    }
    return n
  }

  // 3) 优先整目录交换
  let swapped = false
  try {
    const built = buildInto(NEW_DIR)
    if (built !== source.map.size) throw new Error(`.new 构建文件数不符：${built} / ${source.map.size}`)
    renameSync(TARGET, OLD_DIR)
    try {
      renameSync(NEW_DIR, TARGET)
      swapped = true
    } catch (e) {
      renameSync(OLD_DIR, TARGET) // 还原旧目录，避免半成品状态
      throw e
    }
    written.push(...[...source.map.keys()].sort())
    removed = [...diff.extra].sort()
    console.log(`[2/5] 整目录交换成功（${built} 个文件）`)
  } catch (e) {
    console.log(`[2/5] 整目录交换不可用（${e.code || e.message}），回退逐文件原子替换`)
    method = 'per-file'
    await rmTreeRetry(NEW_DIR)
    for (const [rel, abs] of source.map) {
      const sha = writeFileAtomic(path.join(TARGET, rel), readFileSync(abs))
      if (sha) written.push(rel)
    }
    written.sort()
    // 删除目标多余文件：必须先在备份里找到且哈希一致
    for (const rel of diff.extra) {
      const tAbs = path.join(TARGET, rel)
      const bAbs = path.join(backupDir, rel)
      if (!existsSync(bAbs)) throw new Error(`拒绝删除：备份中不存在 ${rel}`)
      if (existsSync(tAbs) && sha256File(tAbs) !== sha256File(bAbs)) {
        throw new Error(`拒绝删除：目标内容与备份不一致 ${rel}`)
      }
      rmSync(tAbs, { force: true })
      removed.push(rel)
    }
    // 清掉逐文件遗留的空目录不用管；清理可能残留的临时文件
    for (const rel of walkFiles(TARGET)) {
      if (path.basename(rel).startsWith(TMP_PREFIX)) rmSync(path.join(TARGET, rel), { force: true })
    }
    console.log(`[2/5] 逐文件替换完成：写 ${written.length} / 删 ${removed.length}`)
  }

  // 4) 清理 .old / .new
  let residual = []
  for (const dir of [OLD_DIR, NEW_DIR]) {
    if (!existsSync(dir)) continue
    if (!(await rmTreeRetry(dir))) residual.push(dir)
  }
  console.log(`[3/5] 临时目录清理：${residual.length ? '残留 ' + residual.join(', ') : '无残留'}`)

  // 5) 校验：新版本文件集合 == 目标文件集合，且逐文件 SHA256 相等
  const finalSnap = snapshotTarget()
  const verify = compare(source.map, finalSnap)
  if (existsSync(OLD_DIR)) residual.push(OLD_DIR)
  if (existsSync(NEW_DIR)) residual.push(NEW_DIR)
  const mismatchCount = verify.mismatches
  console.log(`[4/5] 校验：mismatch=${mismatchCount}（缺 ${verify.missing.length} / 变 ${verify.changed.length} / 多 ${verify.extra.length}）`)

  // 6) 收据 + 清单
  mkdirSync(STAGING, { recursive: true })
  const verifiedAt = new Date().toISOString()
  const ok = mismatchCount === 0 && residual.length === 0
  const receipt = {
    status: ok ? 'ok' : 'mismatch',
    deployed: ok,
    method,
    backupDir,
    fileCount: source.map.size,
    backupFileCount: backupCount,
    mismatchCount,
    mismatches: verify.mismatches,
    mismatchDetail: { missing: verify.missing, changed: verify.changed, extra: verify.extra },
    residualTempDirs: residual,
    removed: removed.sort(),
    written,
    target: TARGET,
    verifiedAt,
  }
  const receiptPath = path.join(STAGING, 'RECEIPT.json')
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8')

  const manifest = {}
  for (const rel of [...finalSnap.keys()].sort()) manifest[rel] = finalSnap.get(rel)
  const manifestPath = path.join(STAGING, 'INSTALLED-MANIFEST.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  // 收据写进诊断目录本身也校验一次（防止收据路径写错）
  const summary = {
    sourceFiles: source.map.size,
    targetFiles: finalSnap.size,
    indexSha: finalSnap.get('index.js'),
    clientSha: finalSnap.get('client.js'),
    sourceIndexSha: sha256File(path.join(REPO, 'index.js')),
    sourceClientSha: sha256File(path.join(REPO, 'client.js')),
  }
  console.log(`[5/5] 收据：${receiptPath}`)
  console.log(`      清单：${manifestPath}`)
  console.log(`      index.js  ${summary.indexSha} ${summary.indexSha === summary.sourceIndexSha ? '== 工作区' : '!= 工作区'}`)
  console.log(`      client.js ${summary.clientSha} ${summary.clientSha === summary.sourceClientSha ? '== 工作区' : '!= 工作区'}`)
  console.log(`\n结果：status=${receipt.status} method=${receipt.method} 文件 ${summary.sourceFiles} mismatch=${mismatchCount} 残留=${residual.length}`)
  return ok ? 0 : 1
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('部署失败：', e && e.stack ? e.stack : e)
  try {
    mkdirSync(STAGING, { recursive: true })
    writeFileSync(path.join(STAGING, 'RECEIPT.json'), JSON.stringify({
      status: 'failed', deployed: false, method: null, backupDir: null, fileCount: 0,
      mismatches: null, removed: [], written: [], error: String(e && e.message ? e.message : e),
      verifiedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
  } catch { /* ignore */ }
  process.exit(1)
})
