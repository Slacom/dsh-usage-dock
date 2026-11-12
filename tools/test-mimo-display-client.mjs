/**
 * 本机显示会话（sessionDisplay）· 客户端半回归（2026-11-05）
 *
 * 用仓库现成的 `tools/mock-react.mjs`（真实 client.js + 极简 React），
 * 经**同一条 owner-only 路由**接 fake fetch：
 *   - 生产 disabled ⇒ 可信 absent，手工 Cookie 来源**不被遮蔽**；
 *   - 已选（selected）⇒ 胶囊/详情由 Host DTO 驱动，且不回落手工旧值；
 *   - boot 变化立刻丢旧 snapshot 与旧代次；
 *   - 单例 store：多订阅/多挂载不产生多个定时器；
 *   - 凭据哨兵：DTO 与渲染文本里不出现 secret。
 *
 * 运行：node tools/test-mimo-display-client.mjs
 */
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS ' + name) } else { fail += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))) }
}

const BOOT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BOOT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const SECRET = 'secret-token-must-not-leak'
const NAMESPACE = 'mimo-platform-synthetic'
const IDENTITY_MASK = 'u***1001'

function jsonResponse(body, status = 200) {
  return { status, json: async () => body }
}

/** 手工 Cookie 路径的既有取值（overlay 必须把它盖掉 / 或原样保留）。 */
const MANUAL_BALANCE = 99.99
const DISPLAY_BALANCE = 12.34

const state = {
  boot: BOOT_A,
  displaySupported: false,
  namespaces: [],
  display: null,
  calls: [],
  capabilityCalls: 0,
  statusCalls: 0,
  stopRequests: [],
}
function displayDto(over) {
  return Object.assign({
    displaySupported: true,
    selected: true,
    state: 'verified',
    displayId: 'c1c2c3c4c5c6c7c8c9c0d1d2d3d4e5f6',
    generation: 1,
    identity: { maskedLabel: IDENTITY_MASK },
    balance: { balance: DISPLAY_BALANCE, currency: 'CNY', cashBalance: 10, giftBalance: 2.34 },
    fetchedAt: 1762300000000,
    freshness: 'fresh',
    code: 'E_NONE',
    awaitingBalanceMatch: false,
    canRead: false,
    canGrant: false,
    canStop: true,
    refreshCount: 2,
    maxAutoRefresh: 14,
    nextRefreshAt: 1762300060000,
    credentialExpiresAt: 1762300900000,
    localLimits: { minIntervalMs: 60000, credentialHoldMs: 900000, pendingMs: 120000, maxAutoRefresh: 14, transientLimit: 3 },
  }, over)
}

function installFetch() {
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/api/plan-usage-mimo-auth')) {
      const method = init !== undefined && init !== null && typeof init.method === 'string' ? init.method : 'GET'
      if (method === 'GET') {
        state.capabilityCalls += 1
        return jsonResponse({
          ok: true,
          supported: true,
          code: 'E_NONE',
          bootEpoch: state.boot,
          displaySupported: state.displaySupported,
          displayNamespaces: state.namespaces,
        })
      }
      const body = JSON.parse(init.body)
      state.calls.push(body)
      if (body.action === 'displayStatus') {
        state.statusCalls += 1
        return jsonResponse({ ok: true, code: 'E_NONE', bootEpoch: state.boot, display: state.display })
      }
      if (body.action === 'displayStop') {
        state.stopRequests.push(body)
        const stopped = Object.assign({}, state.display, {
          state: 'stopped',
          balance: null,
          freshness: null,
          code: 'E_MIMO_AUTH_DISPLAY_STOPPED',
          canStop: false,
          canRead: false,
          canGrant: false,
        })
        state.display = stopped
        return jsonResponse({ ok: true, code: 'E_NONE', bootEpoch: state.boot, display: stopped })
      }
      return jsonResponse({ ok: true, code: 'E_NONE', bootEpoch: state.boot, display: state.display })
    }
    if (href.includes('/api/plan-usage')) {
      return jsonResponse({
        ok: true,
        data: {
          plans: [
            { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
            { id: 'mimo', name: 'Xiaomi MiMo', balance: MANUAL_BALANCE, currency: 'CNY', isAvailable: true },
          ],
        },
      })
    }
    // 全局兜底：未知端点必须显式失败（不静默造数据）。
    throw new Error('unexpected fetch: ' + href)
  }
}

const runtime = createRuntime()
const loaded = loadClient(runtime, { payload: { ok: false }, form: null })
const D = loaded.module
const api = D.mimoDisplay
installFetch()
api.setPoll(0)

function capsuleText(tree) {
  const pill = tree.props.children[0]
  return textOf(pill)
}
async function mountBadge() {
  runtime.mount(loaded.Badge, { wide: true })
  return runtime.settle({ wide: true })
}

try {
  // 1) 生产 disabled：可信 absent，**不遮蔽**手工 Cookie 来源
  {
    api.reset()
    api.setPoll(0)
    state.displaySupported = false
    state.namespaces = []
    state.display = { displaySupported: false, selected: false, state: 'absent', displayId: null, generation: 0, balance: null }
    const tree = await mountBadge()
    const text = capsuleText(tree)
    check('disabled: 胶囊仍显示手工来源数值', text.includes('99.99'), text)
    check('disabled: 不显示"未启用/已停止"等会话文本', !text.includes('未启用') && !text.includes('已停止'), text)
    const snap = api.store.snapshot
    check('disabled: store 得到可信 absent（非通信故障）', snap !== null && snap.displaySupported === false && snap.state === 'absent', snap)
    check('disabled: overlay 不改动 plans', api.overlay([{ id: 'mimo', balance: 1 }], snap).length === 1)
    check('disabled: 只发纯观察 displayStatus，绝不 start/read/grant',
      state.calls.every((c) => c.action === 'displayStatus'), state.calls)
  }

  // 2) 已选 + 有值：胶囊由 Host DTO 驱动，手工旧值被覆盖
  {
    api.reset()
    api.setPoll(0)
    state.displaySupported = true
    state.namespaces = [NAMESPACE]
    state.display = displayDto()
    state.statusCalls = 0
    const tree = await mountBadge()
    const text = capsuleText(tree)
    check('selected: 胶囊显示显示会话余额', text.includes('12.34'), text)
    check('selected: 手工旧值不再出现', !text.includes('99.99'), text)
    const snap = api.store.snapshot
    check('selected: store 快照含身份/刷新计数', snap !== null && snap.identity !== null
      && snap.identity.maskedLabel === IDENTITY_MASK && snap.refreshCount === 2, snap)
    check('selected: status 是纯观察（无 display 动作依赖）', state.statusCalls >= 1 && state.calls.every((c) => c.action === 'displayStatus'), state.calls)
  }

  // 3) 已选但无值（已停止）：显示状态文本，不回落手工值
  {
    api.reset()
    api.setPoll(0)
    state.display = displayDto({ state: 'stopped', balance: null, freshness: null, code: 'E_MIMO_AUTH_DISPLAY_STOPPED', canStop: false })
    const tree = await mountBadge()
    const text = capsuleText(tree)
    check('stopped: 胶囊显示"已停止"', text.includes('已停止'), text)
    check('stopped: 不回落手工旧值', !text.includes('99.99'), text)
    const plan = api.planOf(api.store.snapshot, { name: 'Xiaomi MiMo' })
    check('stopped: 计划对象无 balance 字段', plan.balance === undefined && plan.displaySource === true, plan)
  }

  // 4) 正常详情里的会话管理行 + 停止按钮（用户不必去设置页）
  {
    api.reset()
    api.setPoll(0)
    state.display = displayDto({ canStop: true })
    await mountBadge()
    const snapshot = api.store.snapshot
    const rows = runtime.renderIsolated(api.SessionRows, { snapshot })
    const text = textOf(rows)
    check('detail: 会话状态行可见', text.includes('本机显示会话'), text)
    check('detail: 身份遮蔽标签可见、无原始标识', text.includes(IDENTITY_MASK) && !text.includes(SECRET), text)
    check('detail: 刷新进度 2 / 14', text.includes('2 / 14'), text)
    check('detail: 明确"本地界不代表厂商有效期"', text.includes('不代表厂商有效期'), text)
    let stopButton = null
    ;(function walk(node) {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const k of node) walk(k); return }
      if (node.props !== undefined && node.props['data-mimo-display'] === 'stop') { stopButton = node; return }
      walk(node.props ? node.props.children : undefined)
    })(rows)
    check('detail: 有可见"停止本机显示会话"按钮', stopButton !== null && textOf(stopButton).includes('停止本机显示会话'))
    // 点击停止 ⇒ 真的走 displayStop（且带 index id/gen，不带凭据）
    stopButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('detail: 停止发出 displayStop', state.stopRequests.length === 1
      && state.stopRequests[0].action === 'displayStop'
      && typeof state.stopRequests[0].displayId === 'string'
      && typeof state.stopRequests[0].generation === 'number', state.stopRequests[0])
    check('detail: 停止请求不含凭据/身份原值', !JSON.stringify(state.stopRequests[0]).includes(SECRET)
      && !JSON.stringify(state.stopRequests[0]).includes('credential'))
    check('detail: 停止后 store 变成 stopped', api.store.snapshot !== null && api.store.snapshot.state === 'stopped')
  }

  // 5) DTO picker：未知字段一律丢弃（凭据哨兵）
  {
    const picked = api.pick({
      ok: true,
      code: 'E_NONE',
      bootEpoch: BOOT_A,
      credential: SECRET,
      expected: { namespace: NAMESPACE, identifier: SECRET },
      display: Object.assign(displayDto(), { credential: SECRET, accountRef: SECRET, actual: SECRET, url: 'https://evil.example' }),
    })
    const dump = JSON.stringify(picked)
    check('picker: 丢弃 credential/expected/accountRef/actual/url', !dump.includes(SECRET)
      && !dump.includes('accountRef') && !dump.includes('evil.example'), dump.slice(0, 240))
    check('picker: 保留白名单字段', picked.display !== null && picked.display.balance.balance === DISPLAY_BALANCE
      && picked.display.identity.maskedLabel === IDENTITY_MASK)
    const badCurrency = api.pick({ ok: true, display: Object.assign(displayDto(), { balance: { balance: 5 } }) })
    check('picker: 无币种 ⇒ 余额为 null（不默认 CNY）', badCurrency.display.balance === null)
  }

  // 6) boot 变化：立刻丢旧 snapshot 与旧代次，迟到旧 boot 不覆盖新值
  {
    api.reset()
    api.setPoll(0)
    state.boot = BOOT_A
    state.display = displayDto({ balance: { balance: DISPLAY_BALANCE, currency: 'CNY' } })
    await mountBadge()
    const before = api.store.snapshot
    check('boot A: 初始快照就绪', before !== null && before.balance.balance === DISPLAY_BALANCE)
    const epochBefore = api.store.epoch
    state.boot = BOOT_B
    state.display = displayDto({ balance: { balance: 77.7, currency: 'CNY' } })
    await api.pump()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await api.pump()
    const after = api.store.snapshot
    check('boot B: 旧代次已作废（epoch 递增）', api.store.epoch > epochBefore, { epochBefore, now: api.store.epoch })
    check('boot B: 新 boot 的值生效、旧值不再显示', after !== null && after.balance !== null
      && after.balance.balance === 77.7, after)
  }

  // 7) 单例 store：多挂载只有一个定时器/一条能力探测
  {
    api.reset()
    api.setPoll(60000)
    state.boot = BOOT_B
    state.display = displayDto()
    state.capabilityCalls = 0
    await mountBadge()
    const afterFirst = state.capabilityCalls
    const timerAfterFirst = api.store.timer
    // 第二个订阅者（模拟详情/设置面板同时挂载）
    const off = api.subscribe(() => {})
    api.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('store: 第二个订阅者不再重复探测能力', state.capabilityCalls === afterFirst, { afterFirst, now: state.capabilityCalls })
    check('store: 只有一个定时器', api.store.timer !== null && timerAfterFirst !== null)
    off()
    api.release()
    api.setPoll(0)
    api.reset()
    check('store: release+reset 后无残留定时器', api.store.timer === null && api.store.snapshot === null)
  }
  // 8) B5：渠道停用时 overlay 不得把 MiMo 加回来
  {
    const snap = api.pick({ ok: true, display: displayDto() }).display
    const disabledRows = api.overlay([{ id: 'deepseek', balance: 1 }], snap, { allowMimo: false })
    check('B5: allowMimo=false 时不新增 MiMo 行', disabledRows.length === 1 && disabledRows[0].id === 'deepseek', disabledRows)
    const enabledRows = api.overlay([{ id: 'deepseek', balance: 1 }], snap, { allowMimo: true })
    check('B5: allowMimo=true 时按 DTO 驱动 MiMo 行', enabledRows.length === 2 && enabledRows[1].id === 'mimo', enabledRows)
  }

  // 9) N4：尚未拿到可信状态时的遮蔽规则
  //
  // [0.10.5] 契约收窄：只有**旧 Cookie 通道的遗留值**才必须遮蔽（墓碑语义）。
  // 本机显示会话来的 wire 已经是 Host 的权威结论，resolving 期间也要如实显示
  // （真机故障：Host 返回 14.58 CNY，胶囊却长期显示「读取中…」）。
  {
    // 9a) 旧 Cookie 遗留值（带 via:'console' 标记）仍必须遮蔽
    const legacy = api.overlay([{ id: 'mimo', balance: MANUAL_BALANCE, currency: 'CNY', via: 'console' }], null, { allowMimo: true, resolving: true })
    const legacyMimo = legacy.filter((p) => p.id === 'mimo')[0]
    check('N4: resolving 时旧 Cookie 遗留值被遮蔽（显示读取中）', legacyMimo !== undefined && legacyMimo.balance === undefined
      && api.shortText(null, true).indexOf('读取中') === 0, legacyMimo)
    check('N4: resolving 时不显示旧 Cookie 手工值', JSON.stringify(legacy).indexOf(String(MANUAL_BALANCE)) < 0)

    // 9b) 本机显示会话来的 wire（无遗留标记）不得被占位盖掉
    const trustedWire = api.overlay([{ id: 'mimo', balance: MANUAL_BALANCE, currency: 'CNY' }], null, { allowMimo: true, resolving: true })
    const trustedMimo = trustedWire.filter((p) => p.id === 'mimo')[0]
    check('N4: resolving 时显示会话 wire 保留真实余额（不被读取中盖掉）',
      trustedMimo !== undefined && trustedMimo.balance === MANUAL_BALANCE, trustedMimo)

    const absentSnap = api.pick({ ok: true, display: { displaySupported: false, selected: false, state: 'absent' } }).display
    const trustedAbsent = api.overlay([{ id: 'mimo', balance: MANUAL_BALANCE, currency: 'CNY' }], absentSnap, { allowMimo: true, resolving: false })
    check('N4: 可信 absent 后恢复手工来源', trustedAbsent[0].balance === MANUAL_BALANCE, trustedAbsent)
  }

  // 10) N1 + N5：停止待确认的本地遮蔽、以及按 2×间隔的本地"历史"降级
  {
    api.reset()
    api.setPoll(0)
    const snap = api.pick({ ok: true, display: displayDto() }).display
    api.store.snapshot = snap
    api.store.resolving = false
    api.store.stopping = { displayId: snap.displayId, generation: snap.generation }
    const maskedView = api.view()
    check('N1: 停止未确认时视图已遮蔽数值', maskedView.state === 'stopped'
      && maskedView.balance === null && maskedView.localPendingStop === true, maskedView)
    api.store.stopping = null
    api.store.snapshot = Object.assign({}, snap, { fetchedAt: Date.now() - 1000 })
    check('N5: 新鲜值不受影响', api.view().freshness === 'fresh')
    api.store.snapshot = Object.assign({}, snap, { fetchedAt: Date.now() - 3 * 60000 })
    check('N5: 超过 2×间隔本地降级为历史', api.view().freshness === 'stale')
    api.reset()
  }
  // 11) N3：底层 fetch 不理 abort，也必须靠 10 s race 落定，single-flight 可恢复
  {
    api.reset()
    api.setPoll(0)
    const realFetch = globalThis.fetch
    const realSetTimeout = globalThis.setTimeout
    let hang = true
    globalThis.fetch = (url, init) => {
      if (String(url).indexOf('mimo-auth') >= 0 && hang) return new Promise(() => {}) // 永挂且不理会 abort
      return realFetch(url, init)
    }
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0) // 把 10 s 压成 0，只用于测 race
    await api.pump()
    check('N3: 永挂 fetch 也在 race 后落定（single-flight 不卡死）', api.store.inflight === null)
    globalThis.setTimeout = realSetTimeout
    hang = false
    await api.pump()
    check('N3: 恢复后能重新取到可信状态', api.store.snapshot !== null
      && api.store.resolving === false, { state: api.store.snapshot && api.store.snapshot.state, resolving: api.store.resolving })
    globalThis.fetch = realFetch
    globalThis.setTimeout = realSetTimeout
  }
} finally {
  api.setPoll(0)
  api.reset()
  loaded.restore()
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
