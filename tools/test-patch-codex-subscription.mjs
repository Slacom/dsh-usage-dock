/**
 * [0.10.1] `tools/patch-codex-subscription.mjs` 的离线回归。
 * [0.10.3] 追加多版本清单回归：3.2.13 移植清单、按已装版本选清单、缺/非法清单零写入。
 *
 * 全部在**临时目录里的副本**上做：不读也不写真实 profile（真实包的路径只出现在工具里）。
 * 夹具来源：`.diagnostics/codex-subscription-readonly-service-20261111/base/index.js`（3.2.6 base 字节）、
 *          `.diagnostics/codex-subscription-3.2.13/extracted/package/lib/index.js`（3.2.13 base 字节）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, 'patch-codex-subscription.mjs')
const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'plans', 'patches', 'codex-subscription-3.2.6.json'), 'utf8'))
const BASE_SRC = join(HERE, '..', '.diagnostics', 'codex-subscription-readonly-service-20261111', 'base', 'index.js')

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('[PASS] ' + name) } else { fail++; console.log('[FAIL] ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300))) }
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

if (!existsSync(BASE_SRC)) {
  console.error('缺少 base 夹具：' + BASE_SRC)
  process.exit(1)
}
const baseBytes = readFileSync(BASE_SRC)
if (sha256(baseBytes).toLowerCase() !== MANIFEST.baseSha.toLowerCase()) {
  console.error('base 夹具哈希与清单不一致')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-patch-cs-'))
const backupRoot = join(root, 'backup')
mkdirSync(backupRoot, { recursive: true })

function makeFixture(name, version, transform) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-codex-subscription', version }, null, 2) + '\n')
  const bytes = transform ? transform(Buffer.from(baseBytes)) : Buffer.from(baseBytes)
  writeFileSync(join(dir, 'lib', 'index.js'), bytes)
  return { dir, target: join(dir, 'lib', 'index.js'), bytes }
}
const run = (extra, dir) => spawnSync(process.execPath, [TOOL, ...extra, '--package-dir', dir], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { DSH_PATCH_BACKUP_ROOT: backupRoot }),
})
const out = (r) => String(r.stdout || '') + String(r.stderr || '')

// 1) --check 于未适配副本：可适配、零写入
{
  const fx = makeFixture('plain', MANIFEST.version)
  const before = sha256(readFileSync(fx.target))
  const r = run([], fx.dir)
  check('1a --check 未适配副本 → exit 0 且报「可适配」', r.status === 0 && out(r).includes('可适配'), out(r))
  check('1b --check 不写文件（字节不变）', sha256(readFileSync(fx.target)) === before)

  // 2) --apply
  const a = run(['--apply'], fx.dir)
  const afterSha = sha256(readFileSync(fx.target))
  check('2a --apply → exit 0 且新哈希 == programSha', a.status === 0 && afterSha.toLowerCase() === MANIFEST.programSha.toLowerCase(), { status: a.status, afterSha })
  const st = statSync(fx.target)
  check('2b 目标 nlink = 1（原子替换不是就地写）', st.nlink === 1, st.nlink)
  const dirs = readdirSync(backupRoot).filter((d) => statSync(join(backupRoot, d)).isDirectory())
  const bk = dirs.length > 0 ? join(backupRoot, dirs.sort()[dirs.length - 1], 'lib__index.js') : null
  check('2c 备份存在且等于 baseSha', bk !== null && existsSync(bk) && sha256(readFileSync(bk)).toLowerCase() === MANIFEST.baseSha.toLowerCase(), dirs)

  // 3) 已适配后再 --check
  const c = run([], fx.dir)
  check('3 已适配后 --check → exit 0 且报「已适配」', c.status === 0 && out(c).includes('已适配'), out(c))

  // 4) --revert
  const rv = run(['--revert'], fx.dir)
  check('4 --revert → 字节与 baseSha 完全一致', rv.status === 0 && sha256(readFileSync(fx.target)).toLowerCase() === MANIFEST.baseSha.toLowerCase(), { status: rv.status, sha: sha256(readFileSync(fx.target)) })
}

// 5) 版本不符 ⇒ 拒绝、零写入、exit 2
{
  const fx = makeFixture('wrongver', '3.2.12')
  const before = sha256(readFileSync(fx.target))
  const r = run(['--apply'], fx.dir)
  check('5 版本不符 → exit 2、零写入、提示需重新生成清单',
    r.status === 2 && sha256(readFileSync(fx.target)) === before && out(r).includes('重新生成'), { status: r.status })
}

// 6) base 哈希不符 ⇒ 拒绝、零写入、exit 2
{
  const fx = makeFixture('badbase', MANIFEST.version, (b) => { const c = Buffer.from(b); c[Math.floor(c.length / 2)] = c[Math.floor(c.length / 2)] ^ 0x01; return c })
  const before = sha256(readFileSync(fx.target))
  const r = run(['--apply'], fx.dir)
  check('6 base 哈希不符 → exit 2、零写入、提示基线未知',
    r.status === 2 && sha256(readFileSync(fx.target)) === before && out(r).includes('基线'), { status: r.status, o: out(r).slice(0, 120) })
}

// 7) hunk 级校验与「写入前拒绝」：baseSha 钉死时「old 不唯一」在物理上不可达（改字节必然先撞哈希门），
//    所以这里改为守两条等价且可达的性质：① `--check` 会逐条报告 hunk 命中数；
//    ② 任何 hunk 层面的异常（这里用「删掉某条 hunk 的 old」模拟）都在**写入前**被拒绝、零写入。
{
  const fx = makeFixture('hunks', MANIFEST.version)
  const before = sha256(readFileSync(fx.target))
  const r = run([], fx.dir)
  const reported = MANIFEST.hunks.every((h) => out(r).includes('hunk ' + h.id + ' 命中 1 次'))
  check('7a --check 逐条报告 4 条 hunk 的命中数（均为 1 次）', r.status === 0 && reported, out(r).slice(0, 200))

  const h = MANIFEST.hunks[0]
  const tampered = makeFixture('hunkmissing', MANIFEST.version, (b) => Buffer.from(b.toString('utf8').replace(h.old, ''), 'utf8'))
  const before2 = sha256(readFileSync(tampered.target))
  const a = run(['--apply'], tampered.dir)
  check('7b 基线被改动（hunk old 缺失）→ exit 2、零写入、拒绝在未知基线上写入',
    a.status === 2 && sha256(readFileSync(tampered.target)) === before2, { status: a.status, o: out(a).slice(0, 140) })
}
// ===========================================================================
// [0.10.2] 共用模块（Host 路由与 CLI 同一实现）：状态三态 + 幂等 + 失败零写入
// ===========================================================================
{
  const mod = await import('../plans/codex-subscription-patch.js')
  const root2 = mkdtempSync(join(tmpdir(), 'dsh-cs-shared-'))
  const mk = (name, version, bytes) => {
    const dir = join(root2, name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-codex-subscription', version }) + '\n')
    writeFileSync(join(dir, 'lib', 'index.js'), bytes)
    return dir
  }
  const baseDir = mk('base', MANIFEST.version, Buffer.from(baseBytes))
  const s1 = mod.readPatchState(baseDir)
  check('H1 readPatchState 未适配副本 → state=appliable', s1.state === 'appliable' && s1.installed === true, s1)

  const wrongVer = mk('wrongver', '3.2.12', Buffer.from(baseBytes))
  check('H2 版本不符 → state=unsupported', mod.readPatchState(wrongVer).state === 'unsupported', mod.readPatchState(wrongVer))

  const out1 = mod.applyPatch(baseDir, { backupRoot: join(root2, 'bk') })
  check('H3 applyPatch 成功 → applied:true 且 newSha == programSha',
    out1.applied === true && out1.newSha.toLowerCase() === MANIFEST.programSha.toLowerCase(), out1)
  const s2 = mod.readPatchState(baseDir)
  check('H4 打完后再读状态 → patched', s2.state === 'patched', s2)
  const out2 = mod.applyPatch(baseDir, { backupRoot: join(root2, 'bk') })
  check('H5 幂等：已适配时 applied:false、不重复写',
    out2.applied === false && out2.requiresRestart === false, out2)

  const tampered = mk('tampered', MANIFEST.version, (() => { const b = Buffer.from(baseBytes); b[b.length - 2] = b[b.length - 2] ^ 0x01; return b })())
  const beforeTampered = readFileSync(join(tampered, 'lib', 'index.js'))
  let threw = null
  try { mod.applyPatch(tampered, { backupRoot: join(root2, 'bk2') }) } catch (err) { threw = err && err.code }
  check('H6 基线不符 → 抛 E_CS_PATCH_UNSUPPORTED 且目标零改动',
    threw === 'E_CS_PATCH_UNSUPPORTED' && Buffer.compare(readFileSync(join(tampered, 'lib', 'index.js')), beforeTampered) === 0, threw)

  const missing = join(root2, 'nope')
  let threw2 = null
  try { mod.applyPatch(missing, { backupRoot: join(root2, 'bk3') }) } catch (err) { threw2 = err && err.code }
  check('H7 包不存在 → 抛 E_CS_PATCH_UNSUPPORTED（不建目录、不写文件）',
    threw2 === 'E_CS_PATCH_UNSUPPORTED' && !existsSync(missing), threw2)

  rmSync(root2, { recursive: true, force: true })

  // 客户端文案守卫：[0.10.2] MiMo 默认态不得再出现开发者措辞
  const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  check('H8 源码守卫：MiMo 默认态已无「实验性：临时扫码登录」字样',
    !clientSrc.includes('实验性：临时扫码登录'))
  check('H9 源码守卫：已无「合成边界；生产未启用」字样', !clientSrc.includes('合成边界；生产未启用'))
  check('H10 源码守卫：默认态含「未登录（点击登录）」状态行与单行提示',
    clientSrc.includes('未登录（点击登录）') && clientSrc.includes('登录后可自动读取余额'))
}

// ===========================================================================
// [0.10.3] 多版本清单：3.2.13 移植 + 按已装版本选清单 + 缺/非法清单零写入
// ===========================================================================
{
  const mod = await import('../plans/codex-subscription-patch.js')
  const M13 = JSON.parse(readFileSync(join(HERE, '..', 'plans', 'patches', 'codex-subscription-3.2.13.json'), 'utf8'))
  const BASE13 = join(HERE, '..', '.diagnostics', 'codex-subscription-3.2.13', 'extracted', 'package', 'lib', 'index.js')
  if (!existsSync(BASE13)) {
    console.error('缺少 3.2.13 基线夹具：' + BASE13)
    process.exit(1)
  }
  const base13 = readFileSync(BASE13)
  const root3 = mkdtempSync(join(tmpdir(), 'dsh-cs-multi-'))
  const mk3 = (name, version, bytes) => {
    const dir = join(root3, name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-codex-subscription', version }) + '\n')
    writeFileSync(join(dir, 'lib', 'index.js'), bytes)
    return dir
  }
  const target13 = (dir) => join(dir, 'lib', 'index.js')

  const all = mod.listManifests()
  check('V1 清单目录同时提供 3.2.6 与 3.2.13', all.map((e) => e.manifest.version).sort().join(',') === '3.2.13,3.2.6', all.map((e) => e.manifest.version))
  check('V2 3.2.13 清单 baseSha == 3.2.13 基线哈希', M13.baseSha.toLowerCase() === sha256(base13).toLowerCase(), { want: M13.baseSha, got: sha256(base13) })
  check('V3 loadManifest("3.2.13") 版本精确命中', mod.loadManifest('3.2.13').version === '3.2.13')
  check('V4 loadManifest("3.2.6") 仍可用（两版并存）', mod.loadManifest('3.2.6').version === MANIFEST.version)

  const hits13 = mod.hunkHits(base13.toString('utf8'), M13)
  check('V5 3.2.13 基线 4 条 hunk 各命中 1 次', hits13.length === 4 && hits13.every((r) => r.hits === 1), hits13)

  const dir13 = mk3('v3213', '3.2.13', Buffer.from(base13))
  const s13 = mod.readPatchState(dir13)
  check('V6 readPatchState 按已装版本自动选 3.2.13 清单 → appliable',
    s13.state === 'appliable' && s13.manifestVersion === '3.2.13', { state: s13.state, mv: s13.manifestVersion })
  const a13 = mod.applyPatch(dir13, { backupRoot: join(root3, 'bk13') })
  const sha13 = sha256(readFileSync(target13(dir13)))
  check('V7 applyPatch(3.2.13) → applied 且 newSha == programSha',
    a13.applied === true && sha13.toLowerCase() === M13.programSha.toLowerCase(), { sha13, want: M13.programSha })
  const chk13 = spawnSync(process.execPath, ['--check', target13(dir13)], { encoding: 'utf8' })
  check('V8 打完的 3.2.13 文件 node --check 通过', chk13.status === 0, chk13.stderr)
  check('V9 打完状态 patched', mod.readPatchState(dir13).state === 'patched')
  const rv13 = mod.revertPatch(dir13, join(root3, 'bk13'))
  check('V10 revertPatch(3.2.13) → 与基线逐字节一致',
    rv13.restoredSha.toLowerCase() === M13.baseSha.toLowerCase() && Buffer.compare(readFileSync(target13(dir13)), base13) === 0, rv13)

  // 未收录版本 ⇒ unsupported + 零写入
  const dir312 = mk3('v3212', '3.2.12', Buffer.from(base13))
  const s312 = mod.readPatchState(dir312)
  let threw312 = null
  try { mod.applyPatch(dir312, { backupRoot: join(root3, 'bk-none') }) } catch (err) { threw312 = err && err.code }
  check('V11 版本 3.2.12（两版都无）→ unsupported 且 apply 抛 UNSUPPORTED、零写入',
    s312.state === 'unsupported' && s312.manifestAvailable === false && threw312 === 'E_CS_PATCH_UNSUPPORTED'
      && Buffer.compare(readFileSync(target13(dir312)), base13) === 0, { state: s312.state, threw312 })

  // 空清单目录（缺清单）⇒ 拒绝零写入
  const emptyDir = join(root3, 'manifests-empty')
  mkdirSync(emptyDir, { recursive: true })
  let threwEmpty = null
  try { mod.loadManifest('3.2.6', emptyDir) } catch (err) { threwEmpty = err && err.code }
  const dir26 = mk3('v326-nomanifest', '3.2.6', Buffer.from(baseBytes))
  let threwEmptyApply = null
  try { mod.applyPatch(dir26, { backupRoot: join(root3, 'bk-empty'), manifestDir: emptyDir }) } catch (err) { threwEmptyApply = err && err.code }
  check('V12 清单目录为空 → loadManifest 抛 UNSUPPORTED，apply 抛 UNSUPPORTED 且零写入',
    threwEmpty === 'E_CS_PATCH_UNSUPPORTED' && threwEmptyApply === 'E_CS_PATCH_UNSUPPORTED'
      && Buffer.compare(readFileSync(target13(dir26)), baseBytes) === 0, { threwEmpty, threwEmptyApply })

  // 非法清单（坏 JSON / 缺 programSha）不瘫痪其它版本
  const mixedDir = join(root3, 'manifests-mixed')
  mkdirSync(mixedDir, { recursive: true })
  writeFileSync(join(mixedDir, 'codex-subscription-3.2.7.json'), '{ this is not json ')
  writeFileSync(join(mixedDir, 'codex-subscription-3.2.8.json'), JSON.stringify({ version: '3.2.8', file: 'lib/index.js', baseSha: 'x', hunks: [] }))
  writeFileSync(join(mixedDir, 'codex-subscription-3.2.6.json'), readFileSync(join(HERE, '..', 'plans', 'patches', 'codex-subscription-3.2.6.json'), 'utf8'))
  const mixedList = mod.listManifests(mixedDir)
  const dir26b = mk3('v326-mixed', '3.2.6', Buffer.from(baseBytes))
  let mixedApplied = null
  try { mixedApplied = mod.applyPatch(dir26b, { backupRoot: join(root3, 'bk-mixed'), manifestDir: mixedDir }) } catch (err) { mixedApplied = err && err.code }
  check('V13 坏清单被跳过、合法清单照常可用（apply 成功）',
    mixedList.length === 1 && mixedList[0].manifest.version === '3.2.6'
      && Boolean(mixedApplied && mixedApplied.applied === true)
      && sha256(readFileSync(target13(dir26b))).toLowerCase() === MANIFEST.programSha.toLowerCase(),
    { mixed: mixedList.map((e) => e.manifest.version), mixedApplied })

  rmSync(root3, { recursive: true, force: true })
}

rmSync(root, { recursive: true, force: true })
console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
