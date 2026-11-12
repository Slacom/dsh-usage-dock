/**
 * [0.10.2] `dsh-codex-subscription` 只读 service 补丁的**共用实现**（CLI 与 Host 路由同构）。
 *
 * 设计要点：
 *   - 清单（hunk 原文 + baseSha/programSha/version）放在 `plans/patches/` 下随包发布；
 *   - 目标包目录**由调用方按自身位置推导**，本模块不接受任何客户端传入的路径/版本参数；
 *   - 版本钉死：`package.json` 的 version 必须等于清单 version，否则 `unsupported`；
 *   - 写入纪律：全部前置检查通过后才写；`wx` 备份 → 同目录 `wx` 临时文件 → 读回校验 → `rename` → 校验新哈希；
 *   - 任何失败都不留半改文件；已适配时幂等返回 `applied:false`。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_PATH = fileURLToPath(new URL('./patches/codex-subscription-3.2.6.json', import.meta.url))
export const PATCH_CODES = {
  ARGS: 'E_CS_PATCH_ARGS',
  UNSUPPORTED: 'E_CS_PATCH_UNSUPPORTED',
  IO: 'E_CS_PATCH_IO',
  VERIFY: 'E_CS_PATCH_VERIFY',
}
export const PATCH_STATES = { PATCHED: 'patched', APPLIABLE: 'appliable', UNSUPPORTED: 'unsupported' }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const fail = (code) => { const err = new Error(code); err.code = code; throw err }

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

/**
 * 由**本模块自身位置**推导目标包目录：`<插件根>/node_modules/dsh-codex-subscription`。
 * 插件根 = `plans/` 的上一级。不接受任何外部参数——这是安全边界。
 */
export function resolvePackageDir(selfFile = fileURLToPath(import.meta.url)) {
  const pluginRoot = dirname(dirname(selfFile))
  return join(pluginRoot, 'node_modules', 'dsh-codex-subscription')
}

/** 只读状态：不读凭据、不联网、不打印源码。 */
export function readPatchState(packageDir, manifest = loadManifest()) {
  const pkgJson = join(packageDir, 'package.json')
  const target = join(packageDir, manifest.file)
  if (!existsSync(pkgJson) || !existsSync(target)) {
    return { installed: false, version: null, state: PATCH_STATES.UNSUPPORTED, currentSha: null, serviceAvailable: false }
  }
  let version = null
  try { version = String(JSON.parse(readFileSync(pkgJson, 'utf8')).version || '') || null } catch { version = null }
  const currentSha = sha256(readFileSync(target))
  const serviceAvailable = readFileSync(target, 'utf8').includes('codexSubscriptionUsage')
  let state
  if (!sameSha(version, manifest.version) && version !== manifest.version) state = PATCH_STATES.UNSUPPORTED
  else if (sameSha(currentSha, manifest.programSha)) state = PATCH_STATES.PATCHED
  else if (sameSha(currentSha, manifest.baseSha)) state = PATCH_STATES.APPLIABLE
  else state = PATCH_STATES.UNSUPPORTED
  return { installed: true, version, state, currentSha, serviceAvailable }
}

/** 每条 hunk 的命中数（1 = 可用）。 */
export function hunkHits(text, manifest = loadManifest()) {
  return manifest.hunks.map((h) => ({ id: h.id, hits: text.split(h.old).length - 1 }))
}

/**
 * 应用补丁。返回 `{ applied, backup, newSha, requiresRestart }`；失败抛 `{code}`。
 * `backupRoot` 由调用方决定（Host 用 profile 下的目录，CLI 用 `tools/patches/backup`）。
 */
export function applyPatch(packageDir, options) {
  const opts = options || {}
  const manifest = loadManifest()
  const target = join(packageDir, manifest.file)
  const state = readPatchState(packageDir, manifest)
  if (!state.installed) fail(PATCH_CODES.UNSUPPORTED)
  if (state.version !== manifest.version) fail(PATCH_CODES.UNSUPPORTED)
  if (state.state === PATCH_STATES.PATCHED) {
    return { applied: false, backup: null, newSha: state.currentSha, requiresRestart: false }
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
      createdAt: new Date().toISOString(), file: manifest.file,
      baseSha: manifest.baseSha, programSha: manifest.programSha, version: manifest.version,
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
  return { applied: true, backup: backupRel, newSha: finalSha, requiresRestart: true }
}

/** 从最近一次备份还原（CLI 用；Host 不暴露回退动作）。 */
export function revertPatch(packageDir, backupRoot) {
  const manifest = loadManifest()
  if (!existsSync(backupRoot)) fail(PATCH_CODES.IO)
  const dirs = readdirSync(backupRoot).filter((d) => statSync(join(backupRoot, d)).isDirectory()).sort()
  if (dirs.length === 0) fail(PATCH_CODES.IO)
  const latest = join(backupRoot, dirs[dirs.length - 1])
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
  return { restoredSha: sha256(readFileSync(target)), backupDir: latest }
}
