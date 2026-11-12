/**
 * [0.10.1] `tools/patch-codex-subscription.mjs` 的离线回归。
 *
 * 全部在**临时目录里的副本**上做：不读也不写真实 profile（真实包的路径只出现在工具里）。
 * 夹具来源：`.diagnostics/codex-subscription-readonly-service-20261111/base/index.js`（base 字节）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, 'patch-codex-subscription.mjs')
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'patches', 'codex-subscription-3.2.6.json'), 'utf8'))
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
rmSync(root, { recursive: true, force: true })
console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
