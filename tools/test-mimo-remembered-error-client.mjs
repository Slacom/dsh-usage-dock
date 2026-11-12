/**
 * test-mimo-remembered-error-client.mjs — 「恢复失败」真因可见性（客户端单元）
 *
 * 只验一件事：真实 `client.js` 的 managed 面板在**失败态**下显示的是
 *   `remembered.code`（会话失败码）+ 附注 `failureStage / reasonCode`，
 * 而**不是**外层观察 200 的 `code:'E_NONE'`；且原因码只认协议固定枚举，
 * 未知/自造/自由文本一律不落 DOM；普通 GET 多轮轮询不会把原因吞掉。
 *
 * 装配：真实 `mock-react.loadClient` 载入 workspace `client.js`；挂载真实入口闸门
 * `mimoAuth.Panel`（MimoAuthMount）→ 取它渲染出的真实 managed 面板组件再挂载。
 * 数据：**固定投影 JSON**（UI 单元，不冒称全链 e2e）；无真实账号 ID / 票 / URL / 金额。
 *
 * 运行：node tools/test-mimo-remembered-error-client.mjs
 */
import { createRuntime, textOf, loadClient } from './mock-react.mjs'
import { CONSOLE_PROTOCOL_CODES } from '../plans/mimo-auth/console-protocol.js'

let pass = 0
const fails = []
function check(name, ok, detail) {
  if (ok === true) { pass += 1; console.log('PASS ' + name); return true }
  fails.push(name + (detail === undefined ? '' : ' || ' + JSON.stringify(detail)))
  console.log('FAIL ' + name + (detail === undefined ? '' : ' || ' + JSON.stringify(detail)))
  return false
}

const BOOT = 'a'.repeat(32)
const BOOT2 = 'b'.repeat(32)
const FAIL_CODE = 'E_MIMO_REMEMBERED_RESTORE_FAILED'
const REASON = CONSOLE_PROTOCOL_CODES.SSO_CHALLENGE        // 'E_MIMO_CONSOLE_SSO_CHALLENGE'
const REASON2 = CONSOLE_PROTOCOL_CODES.AUTH_REJECTED
const FORGED = 'E_LEAKED_SECRET_ABCDEF'

function projection(over) {
  const remembered = Object.assign({
    supported: true,
    managed: true,
    state: 'failed',
    code: FAIL_CODE,
    reasonCode: REASON,
    failureStage: 'restore',
    revision: 5,
    authId: null,
    generation: 0,
    expiresAt: null,
    hasQr: false,
    candidate: null,
    identity: null,
    balance: null,
    fetchedAt: null,
    paused: false,
    intervalMs: 300000,
    nextReadAt: null,
    approval: null,
    storage: { supported: true, code: 'E_NONE' },
    stats: { readAttempts: 0, readSuccesses: 0, refreshCount: 0, restoreAttempts: 1, restoreSuccesses: 0, transientStreak: 0, restoreAttempts2: 0, renewalAttempts: 0, renewalSuccesses: 0 },
    canBegin: false,
    canConfirm: false,
    canPause: false,
    canResume: false,
    canForget: true,
    canRetry: true
  }, over || {})
  return { ok: true, code: 'E_NONE', bootEpoch: BOOT, rememberedSupported: true, remembered }
}

// ── 装配：真实 client.js + 真实入口闸门 ────────────────────────────────────
const runtime = createRuntime()
const bundle = loadClient(runtime, { payload: { ok: true, data: { plans: [] } }, form: null })
const ui = bundle.module.mimoAuth

// 受控定时器（loadClient 会把 setInterval 打桩成 0；面板是 3 s 轮询）
const intervals = new Map()
let intervalSeq = 0
globalThis.setInterval = (fn) => { const id = ++intervalSeq; intervals.set(id, fn); return id }
globalThis.clearInterval = (id) => { intervals.delete(id) }
async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}
async function driveTick() {
  for (const fn of [...intervals.values()]) { try { fn() } catch (err) { fails.push('轮询抛错 :: ' + err.message) } }
  await flush()
}

let current = projection()
let authHits = 0
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.indexOf('/api/plan-usage-mimo-auth') >= 0) { authHits += 1; return { status: 200, json: async () => current } }
  if (href.indexOf('custom-status') >= 0) return { json: async () => ({ ok: true, data: { keys: {}, refs: {}, providers: [] } }) }
  if (href.indexOf('quota-windows') >= 0) return { json: async () => ({ ok: true, data: { channels: {}, readAt: 1 } }) }
  return { status: 200, json: async () => ({ ok: true, data: { plans: [] } }) }
}

const PROPS = { disabled: false }
let panelType = null
async function mountManagedPanel() {
  runtime.mount(ui.Panel, PROPS)
  let gate = null
  for (let i = 0; i < 6; i += 1) { await flush(); gate = await runtime.settle(PROPS, 8) }
  panelType = gate !== null && typeof gate === 'object' && typeof gate.type === 'function' ? gate.type : null
  if (panelType === null) return null
  runtime.mount(panelType, gate.props)
  return settle()
}
async function settle(rounds = 4) {
  let tree = null
  for (let i = 0; i < rounds; i += 1) {
    await flush()
    tree = await runtime.settle(PROPS, 8)
  }
  return tree
}
const textNow = async () => textOf(await settle())

// ── 1) 失败态：主码来自快照，外侧 E_NONE 不得顶掉 ──────────────────────────
let tree = await mountManagedPanel()
let text = tree === null ? '' : textOf(tree)
check('挂载出真实 managed 面板（闸门 → MimoRememberedPanel）',
  panelType !== null && panelType.name === 'MimoRememberedPanel',
  { panel: panelType === null ? null : panelType.name })
check('失败文案显示会话失败码（快照 code）', text.indexOf(FAIL_CODE) >= 0, text.slice(0, 240))
check('失败文案**不含**外层 E_NONE', text.indexOf('E_NONE') < 0, text.slice(0, 240))
check('中性「恢复失败」文案（不是「已停止：E_NONE」）',
  text.indexOf('恢复失败') >= 0 && text.indexOf('已停止：E_NONE') < 0, text.slice(0, 240))
check('附注显示阶段（恢复登录）+ 真因（SSO_CHALLENGE）',
  text.indexOf('阶段：恢复登录') >= 0 && text.indexOf(REASON) >= 0, text.slice(0, 240))
check('可重试入口可见', text.indexOf('重试恢复') >= 0, text.slice(0, 240))

// ── 2) 普通 GET 多轮轮询（外层一直 E_NONE）不吞原因 ─────────────────────────
const hitsBefore = authHits
for (let i = 0; i < 3; i += 1) await driveTick()
text = await textNow()
check('多轮普通 GET 后原因仍在（不被 outer E_NONE 抹掉）',
  authHits >= hitsBefore + 3 && text.indexOf(FAIL_CODE) >= 0
  && text.indexOf(REASON) >= 0 && text.indexOf('E_NONE') < 0,
  { hits: authHits - hitsBefore, text: text.slice(0, 240) })

// ── 3) 另一个已知原因码也跟着换 ────────────────────────────────────────────
current = projection({ reasonCode: REASON2, failureStage: 'read' })
await driveTick()
text = await textNow()
check('换原因码后 UI 跟着换（AUTH_REJECTED + 阶段读取余额）',
  text.indexOf(REASON2) >= 0 && text.indexOf('阶段：读取余额') >= 0 && text.indexOf(REASON) < 0,
  text.slice(0, 240))

// ── 4) 未知 / 自造原因码不许透（宁可只显示主码） ────────────────────────────
current = projection({ reasonCode: FORGED })
const forgedPick = ui.pick(current)
check('未知原因码在 picker 层被丢弃（reasonCode 为空）',
  forgedPick.remembered.reasonCode === '', forgedPick.remembered.reasonCode)
await driveTick()
text = await textNow()
check('未知原因码不落 DOM（主码仍在）',
  text.indexOf(FORGED) < 0 && text.indexOf(FAIL_CODE) >= 0, text.slice(0, 240))

// ── 5) 非法阶段值不透 ─────────────────────────────────────────────────────
current = projection({ reasonCode: REASON, failureStage: 'weird-stage' })
const stagePick = ui.pick(current)
check('非法 failureStage 被丢弃（为 null）', stagePick.remembered.failureStage === null, stagePick.remembered.failureStage)
await driveTick()
text = await textNow()
check('非法阶段不落 DOM（原因仍显示）',
  text.indexOf('weird-stage') < 0 && text.indexOf(REASON) >= 0, text.slice(0, 240))

// ── 6) 恢复成功 / 新 boot 后旧原因清空 ─────────────────────────────────────
current = { ok: true, code: 'E_NONE', bootEpoch: BOOT, rememberedSupported: true, remembered: Object.assign(projection().remembered, { state: 'verified', code: 'E_NONE', reasonCode: '', failureStage: null, balance: { balance: 12.5, currency: 'CNY' }, fetchedAt: 1 }) }
await driveTick()
text = await textNow()
check('恢复成功后不再显示失败码/原因附注',
  text.indexOf(FAIL_CODE) < 0 && text.indexOf(REASON) < 0 && text.indexOf('阶段：') < 0, text.slice(0, 240))

current = projection({ reasonCode: REASON, failureStage: 'restore' })
current.bootEpoch = BOOT2
const newBootPick = ui.pick(current)
check('新 boot 的失败投影可被接收（bootEpoch 变化不吞 reason）',
  newBootPick.bootEpoch === BOOT2 && newBootPick.remembered.reasonCode === REASON,
  { boot: newBootPick.bootEpoch, reason: newBootPick.remembered.reasonCode })

// ── 7) 协议码表同步：CONSOLE_PROTOCOL_CODES 的每个值都必须被客户端接受 ──────
const protocolValues = Object.values(CONSOLE_PROTOCOL_CODES)
const rejected = protocolValues.filter((code) => ui.pick({ ok: true, bootEpoch: BOOT, rememberedSupported: true, remembered: { state: 'failed', code: FAIL_CODE, reasonCode: code, failureStage: 'restore' } }).remembered.reasonCode !== code)
check('客户端原因码白名单覆盖协议全部固定码（无漏同步）',
  rejected.length === 0, { total: protocolValues.length, rejected: rejected.slice(0, 5) })
check('自造/小写/自由文本一律拒（含含空格与路径）',
  ['E_MADE_UP', 'e_mimo_console_sso_challenge', 'SSO challenge', 'E_MIMO_CONSOLE_SSO_CHALLENGE ', 'https://a.example/x'].every((bad) => ui.pick({ ok: true, bootEpoch: BOOT, rememberedSupported: true, remembered: { state: 'failed', code: FAIL_CODE, reasonCode: bad } }).remembered.reasonCode === ''))

// ── 8) 不泄敏感：文本里没有 ID / 票 / URL / 上游域名 ───────────────────────
text = await textNow()
check('面板文本不含账号 ID / 票 / 上游 URL',
  !/passToken/.test(text) && !/api-platform/.test(text) && !/longPolling/.test(text) && !/https:\/\//.test(text),
  text.slice(0, 240))

// ── 9) [sso-target-shape 2026-11-09] 9 个固定分类码：两个静态白名单 + 面板显示；未知/SECRET 后缀不显示 ──
const TARGET_SHAPE_CODES = [
  'E_MIMO_CONSOLE_SSO_TARGET_HTTP_PLATFORM_STS',
  'E_MIMO_CONSOLE_SSO_TARGET_HTTP_PLATFORM_OTHER',
  'E_MIMO_CONSOLE_SSO_TARGET_HTTPS_PLATFORM_API_STS',
  'E_MIMO_CONSOLE_SSO_TARGET_HTTPS_PLATFORM_STS_SLASH',
  'E_MIMO_CONSOLE_SSO_TARGET_HTTPS_PLATFORM_OTHER',
  'E_MIMO_CONSOLE_SSO_TARGET_ACCOUNT_OTHER',
  'E_MIMO_CONSOLE_SSO_TARGET_OTHER_HOST',
  'E_MIMO_CONSOLE_SSO_TARGET_UNSAFE_AUTHORITY',
  'E_MIMO_CONSOLE_SSO_TARGET_OTHER_SCHEME'
]
const consoleOf = bundle.module.mimoDisplay.consoleOf
const pickOne = (code) => ui.pick({
  ok: true, bootEpoch: BOOT, rememberedSupported: true,
  remembered: { state: 'failed', code: FAIL_CODE, reasonCode: code, failureStage: 'restore' }
}).remembered.reasonCode
const acceptedByReason = TARGET_SHAPE_CODES.filter((code) => pickOne(code) === code)
const acceptedByConsole = TARGET_SHAPE_CODES.filter((code) => consoleOf({ supported: true, state: 'failed', code }).code === code)
check('白名单①（remembered reason 关集合）接受全部 9 个分类码',
  acceptedByReason.length === 9, { ok: acceptedByReason.length, missing: TARGET_SHAPE_CODES.filter((c) => !acceptedByReason.includes(c)) })
check('白名单②（console code 关集合）接受全部 9 个分类码',
  acceptedByConsole.length === 9, { ok: acceptedByConsole.length, missing: TARGET_SHAPE_CODES.filter((c) => !acceptedByConsole.includes(c)) })
check('old generic 仍保留（E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED）',
  ui.pick({ ok: true, bootEpoch: BOOT, rememberedSupported: true, remembered: { state: 'failed', code: FAIL_CODE, reasonCode: 'E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED' } }).remembered.reasonCode === 'E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED')

const notShown = []
for (const code of TARGET_SHAPE_CODES) {
  current = projection({ reasonCode: code, failureStage: 'restore' })
  await driveTick()
  const shown = await textNow()
  if (shown.indexOf(code) < 0 || shown.indexOf('E_NONE') >= 0) notShown.push(code)
}
check('9 个分类码在真实 managed 面板上逐个显示（且不混入外层 E_NONE）', notShown.length === 0, notShown)

const hiddenProbe = [
  'E_MIMO_CONSOLE_SSO_TARGET_UNKNOWN_X',
  'E_MIMO_CONSOLE_SSO_TARGET_HTTP_PLATFORM_STS_SECRET',
  'E_MIMO_CONSOLE_SSO_TARGET_ACCOUNT_OTHER_TRAILING'
]
const leaked = []
for (const code of hiddenProbe) {
  current = projection({ reasonCode: code, failureStage: 'restore' })
  await driveTick()
  const shown = await textNow()
  if (shown.indexOf(code) >= 0) leaked.push(code)
}
check('未知 / 带 SECRET 后缀的分类码不落 DOM', leaked.length === 0, leaked)

current = projection({ reasonCode: TARGET_SHAPE_CODES[0], failureStage: 'restore' })
await driveTick()
const shapeText = await textNow()
check('分类码渲染不夹带 rawURL / 票名 / ID',
  !/https?:\/\//.test(shapeText) && !/passToken|serviceToken|userId=/.test(shapeText),
  shapeText.slice(0, 200))

// ── 10) [handoff-summary 2026-11-09] 5 字段交接摘要：正常显示 / other+truncated / 恶意透传全拒 / null 不炸 ──
const GOOD = { source: 'header', status: 302, scheme: 'https', pathTokens: ['fe', 'pass', 'service', 'login'], truncated: false }
const pickHandoff = (h) => ui.pick({ ok: true, bootEpoch: BOOT, rememberedSupported: true, remembered: { state: 'failed', code: FAIL_CODE, reasonCode: REASON, failureStage: 'restore', handoffSummary: h } }).remembered.handoffSummary
const p1 = pickHandoff(GOOD)
check('picker 只保留 5 字段（无多余键）',
  p1 !== null && Object.keys(p1).sort().join(',') === 'pathTokens,scheme,source,status,truncated', p1)
check('picker 丢弃未知 pathToken / 非法 source·status·scheme·truncated / 超 8 段',
  pickHandoff({ ...GOOD, pathTokens: ['fe', 'unknownword'] }) === null
  && pickHandoff({ ...GOOD, source: 'cookiejar' }) === null
  && pickHandoff({ ...GOOD, status: 418 }) === null
  && pickHandoff({ ...GOOD, scheme: 'ftp' }) === null
  && pickHandoff({ ...GOOD, truncated: 'yes' }) === null
  && pickHandoff({ ...GOOD, pathTokens: ['fe', 'pass', 'service', 'login', 'api', 'v1', 'v2', 'home', 'index'] }) === null)
check('picker 对 null/非对象返回 null', pickHandoff(null) === null && pickHandoff('x') === null)

current = projection({ reasonCode: REASON, failureStage: 'restore', handoffSummary: GOOD })
await driveTick()
let hText = await textNow()
check('面板显示 5 字段中文摘要',
  hText.indexOf('交接摘要：') >= 0 && hText.indexOf('来源=响应跳转') >= 0 && hText.indexOf('HTTP=302') >= 0
  && hText.indexOf('协议=https') >= 0 && hText.indexOf('路径标签=/fe/pass/service/login') >= 0,
  hText.slice(0, 260))

current = projection({ reasonCode: REASON, failureStage: 'restore', handoffSummary: { source: 'json', status: 200, scheme: 'other', pathTokens: ['other', 'sts'], truncated: true } })
await driveTick()
hText = await textNow()
check('other 段 → `/*`、truncated → 末尾 /…（且来源=JSON）',
  hText.indexOf('来源=JSON') >= 0 && hText.indexOf('路径标签=/*/sts/…') >= 0, hText.slice(0, 260))

current = projection({
  reasonCode: REASON, failureStage: 'restore',
  handoffSummary: { ...GOOD, rawUrl: 'https://account.xiaomi.com/pass/serviceLogin?x=1', token: 'SECRET-TOKEN', userId: '771234567', query: '?a=b', fragment: '#f' }
})
await driveTick()
hText = await textNow()
check('恶意额外字段（rawURL/token/ID/query/fragment）不落 DOM',
  hText.indexOf('https://') < 0 && hText.indexOf('SECRET-TOKEN') < 0 && hText.indexOf('771234567') < 0
  && hText.indexOf('rawUrl') < 0 && hText.indexOf('?a=b') < 0, hText.slice(0, 260))

const badSummaries = [
  { ...GOOD, pathTokens: ['fe', 'rawsecret'] },
  { ...GOOD, status: 999 },
  { ...GOOD, source: 'body' },
  { ...GOOD, scheme: 'file' },
  { ...GOOD, truncated: 1 },
  { ...GOOD, pathTokens: ['fe', 'pass', 'service', 'login', 'api', 'v1', 'v2', 'home', 'index'] }
]
let leakedBad = 0
for (const bad of badSummaries) {
  current = projection({ reasonCode: REASON, failureStage: 'restore', handoffSummary: bad })
  await driveTick()
  const t = await textNow()
  if (t.indexOf('交接摘要') >= 0) leakedBad += 1
}
check('非法 summary（未知词/坏 status/source/scheme/truncated/超长）整段不显示', leakedBad === 0, leakedBad)

current = projection({ reasonCode: REASON, failureStage: 'restore', handoffSummary: null })
await driveTick()
hText = await textNow()
check('summary=null 不报错且旧 reason 仍显示',
  hText.indexOf('交接摘要') < 0 && hText.indexOf(REASON) >= 0, hText.slice(0, 200))

// ── 11) 合同细节：root [] → '/'、string status → null、other 分段保留 '/fe/*/login' ──
check('pathTokens=[]（root 首页）被接受', pickHandoff({ ...GOOD, pathTokens: [] }) !== null)
check('status 为字符串 "302" ⇒ 整段 null（只要 number）', pickHandoff({ ...GOOD, status: '302' }) === null)
current = projection({ reasonCode: REASON, failureStage: 'restore', handoffSummary: { ...GOOD, pathTokens: [], scheme: 'other', status: 200 } })
await driveTick()
let rootText = await textNow()
check('root 渲染为 路径标签=/', rootText.indexOf('路径标签=/') >= 0, rootText.slice(0, 220))
current = projection({ reasonCode: REASON, failureStage: 'restore', handoffSummary: { ...GOOD, pathTokens: ['fe', 'other', 'login'] } })
await driveTick()
let segText = await textNow()
check("other 段保留分段：'/fe/*/login'", segText.indexOf('路径标签=/fe/*/login') >= 0, segText.slice(0, 220))

bundle.restore()

const summary = pass + ' passed, ' + fails.length + ' failed'
if (fails.length > 0) {
  for (const item of fails) console.error('FAILED ' + item)
  console.error(summary + ' (' + (pass + fails.length) + ')')
  process.exitCode = 1
} else {
  console.log(summary + ' (' + (pass + fails.length) + ')')
}
