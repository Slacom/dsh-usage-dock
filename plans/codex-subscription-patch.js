/**
 * [0.10.2] `dsh-codex-subscription` 只读 service 补丁的**共用实现**（CLI 与 Host 路由同构）。
 * [0.10.3] 清单改为**按版本选择**：`plans/patches/codex-subscription-<version>.json` 多版并存，
 *          用**已装 `package.json` 的 version 精确匹配**；无匹配 ⇒ `unsupported`（拒绝且零写入）。
 *
 * 设计要点：
 *   - 清单（hunk 原文 + baseSha/programSha/version）放在 `plans/patches/` 下随包发布；
 *   - 目标包目录**由调用方按自身位置推导**，本模块不接受任何客户端传入的路径/版本参数；
 *   - 版本钉死：清单 version 必须与已装 package.json 的 version **完全相等**，否则 `unsupported`；
 *   - 写入纪律：全部前置检查通过后才写；`wx` 备份 → 同目录 `wx` 临时文件 → 读回校验 → `rename` → 校验新哈希；
 *   - 任何失败都不留半改文件；已适配时幂等返回 `applied:false`。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 清单目录（不是单个文件）：里面可以同时存在多个版本的清单。 */
export const MANIFEST_DIR = fileURLToPath(new URL('./patches/', import.meta.url))
const MANIFEST_NAME_RE = /^codex-subscription-(.+)\.json$/
export const PATCH_CODES = {
  ARGS: 'E_CS_PATCH_ARGS',
  UNSUPPORTED: 'E_CS_PATCH_UNSUPPORTED',
  IO: 'E_CS_PATCH_IO',
  VERIFY: 'E_CS_PATCH_VERIFY',
}
export const PATCH_STATES = { PATCHED: 'patched', APPLIABLE: 'appliable', UNSUPPORTED: 'unsupported' }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)
const isNonEmpty = (v) => typeof v === 'string' && v.length > 0
const fail = (code) => { const err = new Error(code); err.code = code; throw err }

/** 单个清单文件的**形状校验**：不合格返回 null（一个坏清单不瘫痪其它版本）。 */
function parseManifestFile(file) {
  let m
  try { m = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  if (!m || typeof m !== 'object') return null
  if (!isNonEmpty(m.version) || !isNonEmpty(m.file)) return null
  if (!isSha(m.baseSha) || !isSha(m.programSha)) return null
  if (!Array.isArray(m.hunks) || m.hunks.length === 0) return null
  for (const h of m.hunks) {
    if (!h || typeof h !== 'object') return null
    if (!isNonEmpty(h.id) || !isNonEmpty(h.old) || typeof h.new !== 'string') return null
  }
  return m
}

/**
 * 目录里所有**合法**清单（{ path, manifest }[]，按文件名排序）。目录不存在 ⇒ []。
 * `dir` 仅供同进程内部/测试指定清单目录；不来自 HTTP、不来自客户端。
 */
export function listManifests(dir) {
  const root = isNonEmpty(dir) ? dir : MANIFEST_DIR
  let names
  try { names = readdirSync(root) } catch { return [] }
  const out = []
  for (const name of names.sort()) {
    if (!MANIFEST_NAME_RE.test(name)) continue
    const path = join(root, name)
    const manifest = parseManifestFile(path)
    if (manifest) out.push({ path, manifest })
  }
  return out
}

/** 已装版本 → 清单（精确匹配 package.json 的 version 字段；不做范围/模糊匹配）。 */
export function manifestForVersion(version, dir) {
  if (!isNonEmpty(version)) return null
  return listManifests(dir).find((entry) => entry.manifest.version === version) || null
}

/**
 * 取清单。
 *   - `loadManifest(version)`：按版本精确匹配；无匹配 ⇒ 抛 `E_CS_PATCH_UNSUPPORTED`。
 *   - `loadManifest()`（旧调用）：目录里**恰好一个**清单时返回它，多于一个 ⇒ 抛 `E_CS_PATCH_ARGS`
 *     （不再猜版本；调用方应改用 `readPatchState`/`applyPatch`，它们会按已装版本自动选）。
 */
export function loadManifest(version, dir) {
  if (version === undefined || version === null) {
    const all = listManifests(dir)
    if (all.length === 1) return all[0].manifest
    fail(PATCH_CODES.ARGS)
  }
  const hit = manifestForVersion(String(version), dir)
  if (!hit) fail(PATCH_CODES.UNSUPPORTED)
  return hit.manifest
}

/**
 * 由**本模块自身位置**推导目标包目录：`<插件根>/node_modules/dsh-codex-subscription`。
 * 插件根 = `plans/` 的上一级。不接受任何外部参数——这是安全边界。
 */
export function resolvePackageDir(selfFile = fileURLToPath(import.meta.url), profileDir = null) {
  const pluginRoot = dirname(dirname(selfFile))
  /**
   * [0.10.3] 目标包目录必须有**多个候选**：pnpm 会把插件放进内容寻址目录
   * （`.pnpm/<pkg>/node_modules/<pkg>`），这时"插件根/node_modules"里不会有兄弟包。
   * 仍不接受任意路径：候选只来自「本模块自身位置」与「Host 传入的 profile 根」。
   */
  const hasPkg = (dir) => dir !== null && typeof dir === 'string' && existsSync(join(dir, 'package.json'))
  const candidates = []
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    candidates.push(join(profileDir, 'node_modules', 'dsh-codex-subscription'))
  }
  candidates.push(join(pluginRoot, 'node_modules', 'dsh-codex-subscription'))
  candidates.push(join(dirname(pluginRoot), 'dsh-codex-subscription'))
  let cursor = pluginRoot
  for (let i = 0; i < 6; i += 1) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    // 普通布局：祖先里就有 node_modules/dsh-codex-subscription
    candidates.push(join(parent, 'node_modules', 'dsh-codex-subscription'))
    // 当祖先本身就是 node_modules（pnpm：profile/node_modules/.pnpm/<pkg>/node_modules/<pkg>）
    if (parent.split(/[\\/]/).pop() === 'node_modules') {
      candidates.push(join(parent, 'dsh-codex-subscription'))
      // pnpm 内容寻址目录：<node_modules>/.pnpm/dsh-codex-subscription@<ver>/node_modules/dsh-codex-subscription
      try {
        const pnpmDir = join(parent, '.pnpm')
        if (existsSync(pnpmDir)) {
          for (const entry of readdirSync(pnpmDir)) {
            if (entry.startsWith('dsh-codex-subscription@')) {
              candidates.push(join(pnpmDir, entry, 'node_modules', 'dsh-codex-subscription'))
            }
          }
        }
      } catch { /* 读不到就跳过该布局 */ }
    }
    cursor = parent
  }
  for (const candidate of candidates) if (hasPkg(candidate)) return candidate
  return candidates[0]
}

function installedVersionOf(packageDir) {
  const pkgJson = join(packageDir, 'package.json')
  if (!existsSync(pkgJson)) return null
  try {
    const version = String(JSON.parse(readFileSync(pkgJson, 'utf8')).version || '')
    return version.length > 0 ? version : null
  } catch {
    return null
  }
}

/**
 * 只读状态：不读凭据、不联网、不打印源码。
 * `manifest` 省略时**按已装版本自动选清单**；选不到 ⇒ `unsupported`（且不算目标哈希、零写入）。
 */
export function readPatchState(packageDir, manifest, dir) {
  const version = installedVersionOf(packageDir)
  const chosen = manifest || (version ? (manifestForVersion(version, dir)?.manifest ?? null) : null)
  const target = chosen ? join(packageDir, chosen.file) : null
  const base = { manifest: chosen || null, manifestVersion: chosen ? chosen.version : null, manifestAvailable: Boolean(chosen) }
  if (!version || !chosen || !target || !existsSync(target)) {
    return { installed: Boolean(version), version, state: PATCH_STATES.UNSUPPORTED, currentSha: null, serviceAvailable: false, ...base }
  }
  const currentSha = sha256(readFileSync(target))
  const serviceAvailable = readFileSync(target, 'utf8').includes('codexSubscriptionUsage')
  let state
  if (version !== chosen.version) state = PATCH_STATES.UNSUPPORTED
  else if (sameSha(currentSha, chosen.programSha)) state = PATCH_STATES.PATCHED
  else if (sameSha(currentSha, chosen.baseSha)) state = PATCH_STATES.APPLIABLE
  else state = PATCH_STATES.UNSUPPORTED
  return { installed: true, version, state, currentSha, serviceAvailable, ...base }
}

/** 每条 hunk 的命中数（1 = 可用）。`manifest` 省略时按 `loadManifest()` 旧语义解析。 */
export function hunkHits(text, manifest) {
  const m = manifest || loadManifest()
  return m.hunks.map((h) => ({ id: h.id, hits: text.split(h.old).length - 1 }))
}

/**
 * 应用补丁。返回 `{ applied, backup, newSha, requiresRestart }`；失败抛 `{code}`。
 * 目标版本没有对应清单 ⇒ `E_CS_PATCH_UNSUPPORTED` 且**零写入**。
 * `backupRoot` 由调用方决定（Host 用 profile 下的目录，CLI 用 `tools/patches/backup`）。
 */
export function applyPatch(packageDir, options) {
  const opts = options || {}
  const state = readPatchState(packageDir, null, opts.manifestDir)
  const manifest = state.manifest
  if (!manifest || !state.installed) fail(PATCH_CODES.UNSUPPORTED)
  if (state.version !== manifest.version) fail(PATCH_CODES.UNSUPPORTED)
  const target = join(packageDir, manifest.file)
  if (state.state === PATCH_STATES.PATCHED) {
    return { applied: false, backup: null, newSha: state.currentSha, requiresRestart: false, version: manifest.version }
  }
  if (state.state !== PATCH_STATES.APPLIABLE) fail(PATCH_CODES.UNSUPPORTED)

  const baseBytes = readFileSync(target)
  if (!sameSha(sha256(baseBytes), manifest.baseSha)) fail(PATCH_CODES.UNSUPPORTED)
  let text = baseBytes.toString('utf8')
  for (const h of manifest.hunks) {
    if (text.split(h.old).length - 1 !== 1) fail(PATCH_CODES.UNSUPPORTED)
    text = text.replace(h.old, h.new)
  }
  const next = Buffer.from(text, 'utf8')
  if (!sameSha(sha256(next), manifest.programSha)) fail(PATCH_CODES.VERIFY)

  const backupRoot = opts.backupRoot
  if (typeof backupRoot !== 'string' || backupRoot.length === 0) fail(PATCH_CODES.ARGS)
  let backupRel = null
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(backupRoot, stamp)
    mkdirSync(dir, { recursive: true })
    const backupPath = join(dir, manifest.file.replace(/[\\/]/g, '__'))
    writeFileSync(backupPath, baseBytes, { flag: 'wx' })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      createdAt: new Date().toISOString(), file: manifest.file, version: manifest.version,
      baseSha: manifest.baseSha, programSha: manifest.programSha,
    }, null, 2) + '\n')
    backupRel = stamp + '/' + manifest.file.replace(/[\\/]/g, '__')
  } catch {
    fail(PATCH_CODES.IO)
  }

  const tmp = target + '.tmp-' + process.pid
  try {
    writeFileSync(tmp, next, { flag: 'wx' })
    if (!sameSha(sha256(readFileSync(tmp)), manifest.programSha)) { try { unlinkSync(tmp) } catch { /* ignore */ } fail(PATCH_CODES.VERIFY) }
    renameSync(tmp, target)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    if (err && err.code && String(err.code).startsWith('E_CS_PATCH_')) throw err
    fail(PATCH_CODES.IO)
  }
  const finalSha = sha256(readFileSync(target))
  if (!sameSha(finalSha, manifest.programSha)) fail(PATCH_CODES.VERIFY)
  return { applied: true, backup: backupRel, newSha: finalSha, requiresRestart: true, version: manifest.version }
}

/**
 * 从最近一次备份还原（CLI 用；Host 不暴露回退动作）。
 * 清单同样**按备份里的 meta.json 版本**选（回退不该依赖当前目录里装的版本），
 * meta 缺失时退化为「按已装版本选清单」。
 */
export function revertPatch(packageDir, backupRoot, dir) {
  if (!existsSync(backupRoot)) fail(PATCH_CODES.IO)
  const dirs = readdirSync(backupRoot).filter((d) => statSync(join(backupRoot, d)).isDirectory()).sort()
  if (dirs.length === 0) fail(PATCH_CODES.IO)
  const latest = join(backupRoot, dirs[dirs.length - 1])
  let meta = null
  try { meta = JSON.parse(readFileSync(join(latest, 'meta.json'), 'utf8')) } catch { meta = null }
  const manifest = (meta && isNonEmpty(meta.version) ? (manifestForVersion(meta.version, dir)?.manifest ?? null) : null)
    || (meta && isNonEmpty(meta.file) && isSha(meta.baseSha) ? { file: meta.file, baseSha: meta.baseSha } : null)
    || readPatchState(packageDir, null, dir).manifest
  if (!manifest) fail(PATCH_CODES.UNSUPPORTED)
  const backupPath = join(latest, manifest.file.replace(/[\\/]/g, '__'))
  if (!existsSync(backupPath)) fail(PATCH_CODES.IO)
  const bytes = readFileSync(backupPath)
  if (!sameSha(sha256(bytes), manifest.baseSha)) fail(PATCH_CODES.VERIFY)
  const target = join(packageDir, manifest.file)
  const tmp = target + '.tmp-' + process.pid
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' })
    if (!sameSha(sha256(readFileSync(tmp)), manifest.baseSha)) { try { unlinkSync(tmp) } catch { /* ignore */ } fail(PATCH_CODES.VERIFY) }
    renameSync(tmp, target)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    if (err && err.code && String(err.code).startsWith('E_CS_PATCH_')) throw err
    fail(PATCH_CODES.IO)
  }
  return { restoredSha: sha256(readFileSync(target)), backupDir: latest, version: manifest.version ?? null }
}
