/**
 * [0.10.2] `dsh-codex-subscription` 只读 service 补丁的**共用实现**（CLI 与 Host 路由同构）。
 * [0.10.3] 清单改为**按版本选择**：`plans/patches/codex-subscription-<version>.json` 多版并存，
 *          用**已装 `package.json` 的 version 精确匹配**；无匹配 ⇒ `unsupported`（拒绝且零写入）。
 * [0.10.6] 清单可**继承**：`"inheritFrom": "<父清单 version>"` 时，`hunks` 只写覆盖项
 *          （`{ id, old, new }`），父清单的 hunks 作基底、按 id 原位替换——相邻版本只差一条锚点时
 *          不必复制整份插入文本。继承链解析失败（缺父/成环/超深/覆盖 id 不在父清单）⇒ 该清单非法。
 *
 * 设计要点：
 *   - 清单（hunk 原文 + baseSha/programSha/version）放在 `plans/patches/` 下随包发布；
 *   - 目标包目录**由调用方按自身位置推导**，本模块不接受任何客户端传入的路径/版本参数；
 *   - 版本钉死：清单 version 必须与已装 package.json 的 version **完全相等**，否则 `unsupported`；
 *   - 所有对外函数（list/manifestForVersion/loadManifest/hunkHits/readPatchState/applyPatch/revertPatch）
 *     一律基于**解析后**的清单（继承链已展开），调用方看不到「未展开」的中间态；
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
  // [0.10.6] 继承清单的标记：出现时必须是**非空字符串**（父清单按 version 精确匹配）。
  // 覆盖项本身沿用上面的 hunk 形状（id/old/new 缺一即非法），所以这里不再区分两种写法。
  if (m.inheritFrom !== undefined && !isNonEmpty(m.inheritFrom)) return null
  return m
}

/**
 * 读目录里所有**形状合法**的清单文件（{ path, manifest }[]，按文件名排序）。目录不存在 ⇒ []。
 * 这里只做单文件校验，**不解析**继承链。
 */
function readManifestEntries(root) {
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

/** [0.10.6] 继承链深度上限（4 层：子 → 父 → 祖父 → …）。成环由 `seen` 另行判定。 */
const MAX_INHERIT_DEPTH = 4

/**
 * [0.10.6] 把父清单的 hunks 作基底，用子清单的覆盖项按 `id` **原位替换**。
 * 覆盖项 id 不在父清单里 ⇒ 返回 null（该清单非法/跳过，绝不做「追加」）。
 * 父清单可能本身也是继承解析后的结果（链式继承），所以这里拿到的已是展开态。
 */
function mergeInherited(parent, child) {
  const hunks = parent.hunks.map((h) => ({ ...h }))
  for (const override of child.hunks) {
    const at = hunks.findIndex((h) => h.id === override.id)
    if (at < 0) return null
    // 覆盖项没写 why 时沿用父清单的说明（纯追溯信息，不参与哈希/匹配）。
    hunks[at] = { ...hunks[at], ...override }
  }
  // `inheritFrom` 原样保留（可追溯）；其余字段（version/file/baseSha/programSha/schema/note/final）以子清单为准。
  return { ...child, hunks }
}

/**
 * [0.10.6] 解析单条清单的继承链。返回展开后的清单；任何一环不合法 ⇒ null（**fail-closed**）。
 * 失败条件：父清单不存在/本身非法、继承成环、递归超深、覆盖 id 不在父清单。
 *
 * [0.10.6 整改] **不做 memo 缓存**：深度必须在**本次递归路径**上累计。若按清单缓存父链的展开结果，
 * 「父先子后」的文件名顺序会让每个父清单先以 depth 0 解析并缓存，子清单随后直接命中缓存，
 * 从而绕过 `MAX_INHERIT_DEPTH`（终审实测 6 条继承边会被全部接受）。目录里清单只有个位数，
 * 每次从 depth 0 重新递归的成本可忽略，换来上限一定生效。
 */
function resolveManifestEntry(entry, depth, seen, byVersion) {
  const manifest = entry.manifest
  if (manifest.inheritFrom === undefined) return manifest
  if (depth >= MAX_INHERIT_DEPTH) return null
  if (seen.has(manifest.version)) return null
  const parentEntry = byVersion.get(manifest.inheritFrom)
  if (!parentEntry) return null
  const nextSeen = new Set(seen)
  nextSeen.add(manifest.version)
  const parent = resolveManifestEntry(parentEntry, depth + 1, nextSeen, byVersion)
  if (!parent) return null
  return mergeInherited(parent, manifest)
}

/**
 * 目录里所有**合法**清单（{ path, manifest }[]，按文件名排序，manifest 已展开继承链）。目录不存在 ⇒ []。
 * `dir` 仅供同进程内部/测试指定清单目录；不来自 HTTP、不来自客户端。
 */
export function listManifests(dir) {
  const root = isNonEmpty(dir) ? dir : MANIFEST_DIR
  const entries = readManifestEntries(root)
  // 父清单按 version 精确匹配（同名版本重复出现时取文件名序里的第一个）。
  const byVersion = new Map()
  for (const entry of entries) {
    if (!byVersion.has(entry.manifest.version)) byVersion.set(entry.manifest.version, entry)
  }
  const out = []
  for (const entry of entries) {
    const manifest = resolveManifestEntry(entry, 0, new Set(), byVersion)
    if (manifest) out.push({ path: entry.path, manifest })
  }
  return out
}

/** [0.10.6] 版本号比较（纯展示排序用：3.2.6 < 3.2.13 < 3.2.17）。 */
function compareVersions(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i])
    const nb = Number(pb[i])
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
    } else {
      const sa = pa[i] === undefined ? '' : pa[i]
      const sb = pb[i] === undefined ? '' : pb[i]
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return 0
}

/**
 * [0.10.6] 本包清单目录里**所有合法**清单覆盖的版本号（已去重、按版本升序；纯版本号、不含路径）。
 * 仅供提示与路由使用，是只读 metadata：不读包、不读凭据、不联网。
 */
export function coveredVersions(dir) {
  const versions = new Set(listManifests(dir).map((entry) => entry.manifest.version))
  return [...versions].sort(compareVersions)
}

/** 已装版本 → 清单（精确匹配 package.json 的 version 字段；不做范围/模糊匹配）。 */
export function manifestForVersion(version, dir) {
  if (!isNonEmpty(version)) return null
  return listManifests(dir).find((entry) => entry.manifest.version === version) || null
}

/**
 * [0.11.4] **自动适配候选**：已装版本没有对应清单时，用「本包收录的最新清单」的锚点
 * 去已装文件里做**唯一命中**校验：
 *
 *   - 每条 hunk 的 `old` 必须**恰好出现一次**（0 次=上游改了锚点；>1 次=会改错位置）；
 *   - 全部命中 ⇒ 认为这份清单的**插入位置**对新版本仍然成立，可以按它适配；
 *   - 任一条件不满足 ⇒ `null`（fail-closed，绝不猜）。
 *
 * 注意：自动模式**不校验** `baseSha` / `programSha` —— 那是把清单钉死到某个上游版本的哈希，
 * 新版本必然不同。作为补偿，`applyPatch()` 在自动模式下会额外校验：
 * 写入后服务标记只出现一次、且不重复注册。
 */
export function autoAdaptCandidate(packageDir, dir) {
  const version = installedVersionOf(packageDir)
  if (!version) return null
  const entries = listManifests(dir)
    .slice()
    .sort((a, b) => compareVersions(a.manifest.version, b.manifest.version))
  if (entries.length === 0) return null
  const newest = entries[entries.length - 1].manifest
  const target = join(packageDir, newest.file)
  if (!existsSync(target)) return null
  const text = readFileSync(target, 'utf8')
  const alreadyPatched = text.includes('codexSubscriptionUsage')
  if (!alreadyPatched) {
    let work = text
    for (const h of newest.hunks) {
      if (typeof h.old !== 'string' || h.old.length === 0) return null
      if (work.split(h.old).length - 1 !== 1) return null
      work = work.replace(h.old, h.new)
    }
  }
  return { version, fromVersion: newest.version, manifest: newest, alreadyPatched }
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
  /**
   * [0.11.4] 没有精确清单时不直接判 unsupported：先试「自动适配候选」（锚点唯一命中）。
   * 命中即按 appliable / patched 上报，并带 `auto: true` 让界面说明这是按新版本自动匹配的。
   */
  if (!chosen) {
    const auto = autoAdaptCandidate(packageDir, dir)
    if (!auto) {
      return {
        installed: Boolean(version), version, state: PATCH_STATES.UNSUPPORTED,
        currentSha: null, serviceAvailable: false,
        manifest: null, manifestVersion: null, manifestAvailable: false, auto: false,
      }
    }
    const target = join(packageDir, auto.manifest.file)
    if (!existsSync(target)) {
      return {
        installed: true, version, state: PATCH_STATES.UNSUPPORTED,
        currentSha: null, serviceAvailable: false,
        manifest: auto.manifest, manifestVersion: null, manifestAvailable: true,
        auto: true, autoFromVersion: auto.fromVersion,
      }
    }
    const text = readFileSync(target, 'utf8')
    return {
      installed: true, version,
      state: auto.alreadyPatched ? PATCH_STATES.PATCHED : PATCH_STATES.APPLIABLE,
      currentSha: sha256(readFileSync(target)),
      serviceAvailable: auto.alreadyPatched,
      manifest: auto.manifest, manifestVersion: null, manifestAvailable: true,
      auto: true, autoFromVersion: auto.fromVersion,
    }
  }
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
  const auto = state.auto === true
  if (!manifest || !state.installed) fail(PATCH_CODES.UNSUPPORTED)
  if (!auto && state.version !== manifest.version) fail(PATCH_CODES.UNSUPPORTED)
  const target = join(packageDir, manifest.file)
  if (state.state === PATCH_STATES.PATCHED) {
    return { applied: false, backup: null, newSha: state.currentSha, requiresRestart: false, version: state.version, auto, autoFromVersion: state.autoFromVersion || null }
  }
  if (state.state !== PATCH_STATES.APPLIABLE) fail(PATCH_CODES.UNSUPPORTED)

  const baseBytes = readFileSync(target)
  if (!auto && !sameSha(sha256(baseBytes), manifest.baseSha)) fail(PATCH_CODES.UNSUPPORTED)
  let text = baseBytes.toString('utf8')
  for (const h of manifest.hunks) {
    if (text.split(h.old).length - 1 !== 1) fail(PATCH_CODES.UNSUPPORTED)
    text = text.replace(h.old, h.new)
  }
  const next = Buffer.from(text, 'utf8')
  if (!auto && !sameSha(sha256(next), manifest.programSha)) fail(PATCH_CODES.VERIFY)
  /** [0.11.4] 自动模式没有 programSha 可比：至少要确认插入后的服务标记存在。 */
  if (auto && !text.includes('codexSubscriptionUsage')) fail(PATCH_CODES.VERIFY)

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
    if (!auto && !sameSha(sha256(readFileSync(tmp)), manifest.programSha)) { try { unlinkSync(tmp) } catch { /* ignore */ } fail(PATCH_CODES.VERIFY) }
    renameSync(tmp, target)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    if (err && err.code && String(err.code).startsWith('E_CS_PATCH_')) throw err
    fail(PATCH_CODES.IO)
  }
  const finalSha = sha256(readFileSync(target))
  if (!auto && !sameSha(finalSha, manifest.programSha)) fail(PATCH_CODES.VERIFY)
  if (auto && !readFileSync(target, 'utf8').includes('codexSubscriptionUsage')) fail(PATCH_CODES.VERIFY)
  return {
    applied: true, backup: backupRel, newSha: finalSha, requiresRestart: true,
    version: state.version, auto, autoFromVersion: state.autoFromVersion || null,
  }
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
