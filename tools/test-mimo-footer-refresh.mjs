/**
 * test-mimo-footer-refresh.mjs — footer 胶囊「详情 false→true 强刷余额」**真实事件链**（离线）
 *
 * 真 `PlanUsageBadge` + 真 mimo 单例 store/pump；owner 路由（`/api/plan-usage-mimo-auth`）用
 * fake fetch 应答：**不监听端口、不联网、不读 cfg/record/凭据**，金额 11.11 / 22.22 是合成值。
 *
 * 覆盖（对应本包合同）：
 *   F1 初始余额 → 打开详情 POST `rememberedRefresh` **恰一次**（严格 body）→ pure `displayStatus`
 *      拿到新值 → **卡片真的显示新值**（不是只数 POST）；关闭/重渲染 0 追加。
 *   F2 status 轮询已有 flight 时**不抑制**余额强刷；强刷返回后**等既有 flight 落定**再走同一 pump。
 *   F3 重复 open / 强刷在途 → 合并为一次（manual 单独 coalesce）。
 *   F4 旧 generation 晚回包、旧 epoch（退出/换代）在途 status 晚回包 都不得回填余额。
 *   F5 第 5 次失败 fail-closed：即使 DTO 矛盾还带 balance 也不显示金额；胶囊值/title 只
 *      「余额读取失败」，具体原因（白名单码）只在详情。
 *   F6 第 1–4 次失败：保留旧值并灰化（stale）。
 *   F7 无历史：不造 0 金额。
 *   F8 不适用态（全局禁用 / mimoEnabled false / paused / 非 managed / 未登录 holding /
 *      selected false）一律 0 次余额强刷。
 *   F9 `rememberedRefresh` 返回 ok:false：不补 pump、旧值不变。
 *
 * 运行：node tools/test-mimo-footer-refresh.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fails.push(name + ' :: ' + (e.message || String(e))); console.log('FAIL ' + name + ' :: ' + (e.message || String(e))) }
}

const BOOT = 'a'.repeat(32)
const MIMO_ROUTE = 'plan-usage-mimo-auth'
const tick = (ms) => new Promise((res) => setTimeout(res, ms === undefined ? 5 : ms))

/** owner GET（capability）：只读能力，不含任何 display。 */
function capability() {
  return {
    ok: true, code: 'E_NONE', bootEpoch: BOOT,
    displaySupported: true,
    namespaces: ['xiaomi-account-user-id'],
    displayNamespaces: ['xiaomi-account-user-id'],
    consoleSupported: false,
    consoleNamespaces: [],
  }
}
/**
 * display DTO（合成）。`fetchedAt` 用当前时间：`mimoDisplayView()` 在「fresh 但超过 2×最小间隔」
 * 时本地降级为 stale，用 2023 年的时间戳会让 fresh 用例意外变灰。
 */
function display(over) {
  const now = Date.now()
  return Object.assign({
    displaySupported: true, selected: true, managed: true, readFailures: 0,
    state: 'verified', displayId: 'd'.repeat(32), generation: 2, revision: 5,
    identity: { maskedLabel: 'u***7' },
    balance: { balance: 11.11, currency: 'CNY', cashBalance: 10.11, giftBalance: 1 },
    fetchedAt: now, freshness: 'fresh', code: 'E_NONE',
    awaitingBalanceMatch: false, canRead: true, canGrant: false, canStop: true,
    refreshCount: 1, maxAutoRefresh: 0, nextRefreshAt: null,
    credentialExpiresAt: null, pendingExpiresAt: null,
    localLimits: { minIntervalMs: 60000, credentialHoldMs: 0, pendingMs: 0, maxAutoRefresh: 0, transientLimit: 5 },
  }, over)
}
const PLANS_PAYLOAD = {
  ok: true,
  data: { plans: [{ id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 }] },
}

/** fake owner 路由：把「capability GET / displayStatus / rememberedRefresh / 普通取数」分开计量。 */
function makeOwner(opts) {
  const o = opts || {}
  const owner = {
    calls: [],
    display: o.display === undefined ? display() : o.display,
    refreshReply: o.refreshReply || { ok: true, code: 'E_NONE', bootEpoch: BOOT },
    getCalls: 0,
    statusCalls: 0,
    refreshCalls: 0,
    refreshThrows: false,
    holdStatus: null,   // Promise：消费一次 status 请求并挂起
    holdRefresh: null,  // Promise：消费一次 rememberedRefresh 请求并挂起
  }
  const res = (obj) => ({ ok: true, status: 200, json: async () => obj })
  owner.fetch = async (url, init) => {
    const u = String(url)
    const options = init || {}
    if (u.indexOf(MIMO_ROUTE) !== -1) {
      const body = options.body === undefined || options.body === null ? null : JSON.parse(options.body)
      if (body === null) {
        owner.getCalls += 1
        owner.calls.push({ kind: 'get' })
        return res(capability())
      }
      owner.calls.push({ kind: 'action', action: body.action, body })
      if (body.action === 'displayStatus') {
        owner.statusCalls += 1
        // 合同：{ ok, code, bootEpoch, display }（display 是顶层字段，不是整包）
        const payload = res({ ok: true, code: 'E_NONE', bootEpoch: BOOT, display: owner.display })
        if (owner.holdStatus !== null) {
          const gate = owner.holdStatus
          owner.holdStatus = null
          return gate.then(() => payload)
        }
        return payload
      }
      if (body.action === 'rememberedRefresh') {
        owner.refreshCalls += 1
        // 传输层失败（无可信 bootEpoch 的回包）：模拟 fetch 抛错
        if (owner.refreshThrows === true) throw new Error('transport down')
        const payload = res(owner.refreshReply)
        if (owner.holdRefresh !== null) {
          const gate = owner.holdRefresh
          owner.holdRefresh = null
          return gate.then(() => payload)
        }
        return payload
      }
      return res({ ok: true, code: 'E_NONE', bootEpoch: BOOT })
    }
    owner.calls.push({ kind: 'plans' })
    return res(PLANS_PAYLOAD)
  }
  return owner
}

/** 挂真 PlanUsageBadge（footer 席位组件），owner 用 fake fetch；轮询关掉（pollMs=0）。 */
async function bootSession(owner, configValue, payload) {
  const value = configValue === undefined ? { enabled: true, mimoEnabled: true } : configValue
  const runtime = createRuntime()
  const form = { getSnapshot() { return { value, writable: true } }, subscribe() { return () => {} } }
  const boot = loadClient(runtime, { form, payload: payload === undefined ? PLANS_PAYLOAD : payload })
  // loadClient 会重设 globalThis.fetch：必须在加载之后再打桩（同 remembered-tree 的做法）
  globalThis.fetch = owner.fetch
  const client = boot.module
  client.mimoDisplay.reset()
  client.mimoDisplay.setPoll(0)
  const props = { configForm: form, wide: true }
  const session = {
    owner,
    client,
    props,
    tree: runtime.mount(boot.Badge, props),
    async settle(rounds) {
      const n = rounds === undefined ? 6 : rounds
      for (let i = 0; i < n; i += 1) {
        await tick()
        session.tree = await runtime.settle(props, 8)
      }
      return session.tree
    },
  }
  await session.settle()
  return session
}

function nodes(node, out) {
  const acc = out === undefined ? [] : out
  if (node === null || node === undefined || typeof node !== 'object') return acc
  acc.push(node)
  const kids = node.props !== undefined && node.props !== null ? node.props.children : node.children
  if (Array.isArray(kids)) for (const k of kids) nodes(k, acc)
  else if (kids !== undefined) nodes(kids, acc)
  return acc
}
function pillOf(tree) {
  return nodes(tree).find((n) => n.props !== undefined && n.props !== null && n.props.className === 'dsh-plan-usage-pill') || null
}
function panelOf(tree) {
  return nodes(tree).find((n) => n.props !== undefined && n.props !== null
    && Object.prototype.hasOwnProperty.call(n.props, 'data-plan-usage-panel')) || null
}
/** 胶囊里 MiMo 那一行（overlay 追加在末尾）：断言只针对它，避免误读其它渠道的金额。 */
function mimoRowOf(tree) {
  const pill = pillOf(tree)
  if (pill === null) return null
  const rows = Array.isArray(pill.props.children) ? pill.props.children : [pill.props.children]
  return rows.find((r) => textOf(r).includes('Xiaomi MiMo')) || null
}
function countRefresh(owner) {
  return owner.calls.filter((c) => c.kind === 'action' && c.action === 'rememberedRefresh')
}

async function main() {
  await check('F1 打开详情：POST 恰一次（严格 body）→ pure displayStatus → 卡片真显示新值；关闭/重渲染 0 追加', async () => {
    const owner = makeOwner()
    const s = await bootSession(owner)
    assert.ok(textOf(s.tree).includes('11.11'), '初始胶囊应显示 11.11')
    assert.equal(panelOf(s.tree), null, '未打开时不得渲染面板')
    assert.equal(owner.refreshCalls, 0)

    const pill = pillOf(s.tree)
    assert.ok(pill !== null)
    pill.props.onClick()
    // 打开这一帧之后 owner 才有新值（POST 仍在微任务里）
    owner.display = display({ revision: 6, balance: { balance: 22.22, currency: 'CNY', cashBalance: 20, giftBalance: 2.22 } })
    await s.settle()

    assert.equal(owner.refreshCalls, 1, '打开详情应恰好强刷一次')
    const posts = countRefresh(owner)
    assert.equal(posts.length, 1)
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['action', 'bootEpoch', 'generation'])
    assert.equal(posts[0].body.bootEpoch, BOOT)
    assert.equal(posts[0].body.generation, 2)

    const panel = panelOf(s.tree)
    assert.ok(panel !== null, '打开后应渲染详情面板')
    assert.ok(textOf(panel).includes('22.22'), '详情卡片必须显示新余额 22.22（不只是发了 POST）')
    assert.ok(textOf(panel).includes('现金余额'), '现金/赠送分行仍按 display 来源渲染')
    assert.equal(textOf(s.tree).includes('11.11'), false, '旧值不得残留')

    // 关闭 + 反复重渲染：不得再发任何强刷
    pillOf(s.tree).props.onClick()
    await s.settle(4)
    assert.equal(panelOf(s.tree), null)
    assert.equal(owner.refreshCalls, 1, '关闭/重渲染不得触发强刷')
  })

  await check('F2 status 轮询已有 flight 不抑制强刷；先等既有 flight 落定再走同一 pump', async () => {
    const owner = makeOwner()
    const s = await bootSession(owner)
    assert.ok(textOf(s.tree).includes('11.11'))
    const statusBefore = owner.statusCalls
    let releaseStatus = null
    owner.holdStatus = new Promise((res) => { releaseStatus = res })
    owner.display = display({ revision: 6 })
    const polled = s.client.mimoDisplay.pump()
    await tick()
    assert.equal(owner.statusCalls, statusBefore + 1, '应有一个 status 在途')

    pillOf(s.tree).props.onClick()
    await s.settle(1)
    assert.equal(owner.refreshCalls, 1, 'status 在途不得抑制打开详情的余额强刷')
    assert.ok(textOf(s.tree).includes('11.11'), '既有 flight 未落定前不得凭空换值')

    owner.display = display({ revision: 7, balance: { balance: 22.22, currency: 'CNY' } })
    releaseStatus()
    await Promise.resolve(polled).catch(() => null)
    await s.settle()

    const panel = panelOf(s.tree)
    assert.ok(panel !== null)
    assert.ok(textOf(panel).includes('22.22'), 'flight 落定后应走 pump 提交新值')
    assert.equal(textOf(s.tree).includes('11.11'), false)
  })

  await check('F3 强刷在途时重复 open：合并为一次', async () => {
    const owner = makeOwner()
    const s = await bootSession(owner)
    owner.display = display({ revision: 6, balance: { balance: 22.22, currency: 'CNY' } })
    let releaseRefresh = null
    owner.holdRefresh = new Promise((res) => { releaseRefresh = res })

    pillOf(s.tree).props.onClick()
    await s.settle(1)
    assert.equal(owner.refreshCalls, 1)

    pillOf(s.tree).props.onClick() // 关闭
    await s.settle(2)
    pillOf(s.tree).props.onClick() // 再打开（POST 仍在途）
    await s.settle(2)
    assert.equal(owner.refreshCalls, 1, '在途期间重复 open 必须合并')

    releaseRefresh()
    await s.settle()
    assert.equal(owner.refreshCalls, 1)
    const panel = panelOf(s.tree)
    assert.ok(panel !== null)
    assert.ok(textOf(panel).includes('22.22'))
  })

  await check('F4 旧 generation / 旧 epoch 晚回包都不回填余额', async () => {
    const owner = makeOwner()
    const s = await bootSession(owner)
    assert.ok(textOf(s.tree).includes('11.11'))

    // 4a 旧 generation：数值更“新”但代次更旧 ⇒ 整包拒绝
    owner.display = display({ generation: 1, revision: 99, balance: { balance: 99.99, currency: 'CNY' } })
    await s.client.mimoDisplay.pump()
    await s.settle()
    assert.equal(textOf(s.tree).includes('99.99'), false, '旧 generation 不得回填')
    assert.ok(textOf(s.tree).includes('11.11'))

    // 4b 旧 epoch：退出/换代（reset 模拟 boot epoch 前进）后在途 status 晚回包
    let release = null
    owner.holdStatus = new Promise((res) => { release = res })
    owner.display = display({ revision: 8, balance: { balance: 33.33, currency: 'CNY' } })
    const inFlight = s.client.mimoDisplay.pump()
    await tick()
    s.client.mimoDisplay.reset()
    release()
    await Promise.resolve(inFlight).catch(() => null)
    await s.settle()
    assert.equal(textOf(s.tree).includes('33.33'), false, '旧 epoch 晚回包不得回填')
    assert.equal(owner.refreshCalls, 0, '上述过程不得发余额强刷')
  })

  await check('F5 第 5 次失败 fail-closed：DTO 矛盾带 balance 也不显示；原因只在详情', async () => {
    const owner = makeOwner({
      display: display({ readFailures: 5, freshness: 'failed', code: 'E_MIMO_CONSOLE_TRANSIENT' }),
    })
    const s = await bootSession(owner)
    const txt = textOf(s.tree)
    assert.equal(txt.includes('11.11'), false, '失败态不得显示任何金额')
    assert.ok(txt.includes('余额读取失败'))

    const pill = pillOf(s.tree)
    assert.ok(pill !== null)
    assert.ok(pill.props.title.includes('余额读取失败'))
    assert.equal(pill.props.title.includes('E_MIMO'), false, '胶囊 title 不得带原因码')
    assert.equal(pill.props.title.includes('TRANSIENT'), false)
    assert.equal(pill.props['aria-label'], undefined, '胶囊不得另挂 aria-label 泄原因')

    pill.props.onClick()
    await s.settle()
    const panel = panelOf(s.tree)
    assert.ok(panel !== null)
    const panelText = textOf(panel)
    // 详情里给白名单固定码；胶囊值/title 一律不带
    assert.ok(panelText.includes('E_MIMO_CONSOLE_TRANSIENT'), '详情里给白名单固定码')
    assert.ok(panelText.includes('余额读取失败'), '详情保留固定前缀文案')
    assert.equal(panelText.includes('11.11'), false, '详情也不得显示金额')
    assert.equal(owner.refreshCalls, 1, '失败态打开详情仍允许一次主动读（Host 侧继续自动读）')
    const pillAfter = pillOf(s.tree)
    assert.equal(pillAfter.props.title.includes('E_MIMO_CONSOLE_TRANSIENT'), false)
  })

  await check('F6 第 1–4 次失败：保留旧值并灰化（stale），不冒充成功', async () => {
    const owner = makeOwner({ display: display({ readFailures: 3, freshness: 'stale' }) })
    const s = await bootSession(owner)
    const txt = textOf(s.tree)
    assert.ok(txt.includes('11.11'), '1–4 次失败必须保留上次成功值')
    assert.ok(txt.includes('历史'), '胶囊数值需标出历史值')
    const gray = nodes(s.tree).find((n) => n.props !== undefined && n.props !== null
      && n.props.style !== undefined && n.props.style.color === 'var(--dsw-alias-label-tertiary)'
      && textOf(n).includes('11.11'))
    assert.ok(gray !== undefined, '保留值必须灰化')

    // 只计数未到阈值（freshness 仍 fresh）也必须按 stale 处理
    const owner2 = makeOwner({ display: display({ readFailures: 2, freshness: 'fresh' }) })
    const s2 = await bootSession(owner2)
    assert.ok(textOf(s2.tree).includes('11.11'))
    const gray2 = nodes(s2.tree).find((n) => n.props !== undefined && n.props !== null
      && n.props.style !== undefined && n.props.style.color === 'var(--dsw-alias-label-tertiary)'
      && textOf(n).includes('11.11'))
    assert.ok(gray2 !== undefined, 'readFailures>0 即灰化')
  })

  await check('F7 无历史：中性“正在读取余额”，不造 0 金额', async () => {
    const owner = makeOwner({ display: display({ balance: null, readFailures: 2, freshness: 'fresh' }) })
    const s = await bootSession(owner)
    const row = mimoRowOf(s.tree)
    assert.ok(row !== null, '胶囊里应有 MiMo 行')
    const rowText = textOf(row)
    assert.equal(rowText.includes('¥'), false, '无历史时 MiMo 行不得出现金额符号')
    assert.equal(rowText.includes('0.00'), false)
    assert.ok(rowText.includes('待读取'))

    const pill = pillOf(s.tree)
    assert.ok(pill !== null)
    assert.ok(pill.props.title.includes('待读取'), '胶囊 title 用中性读取中文案')
    pill.props.onClick()
    await s.settle()
    const panel = panelOf(s.tree)
    assert.ok(panel !== null)
    assert.ok(textOf(panel).includes('正在读取余额'))
    assert.equal(textOf(panel).includes('0.00'), false)
  })

  await check('F8 不适用态一律 0 次余额强刷', async () => {
    // 8a 全局禁用：整个胶囊不渲染，也就无从打开详情
    const ownerOff = makeOwner()
    const sOff = await bootSession(ownerOff, { enabled: false })
    assert.equal(sOff.tree, null, '全局禁用时不渲染胶囊')
    assert.equal(pillOf(sOff.tree), null)
    assert.equal(ownerOff.refreshCalls, 0)

    // 8b mimoEnabled=false
    const ownerMute = makeOwner()
    const sMute = await bootSession(ownerMute, { enabled: true, mimoEnabled: false })
    const pillMute = pillOf(sMute.tree)
    assert.ok(pillMute !== null)
    pillMute.props.onClick()
    await sMute.settle()
    assert.equal(ownerMute.refreshCalls, 0, 'mimoEnabled=false 不得强刷')

    // 8c paused（freshness 闭集必须保留 'paused'，且闸门生效）
    const ownerPaused = makeOwner({ display: display({ freshness: 'paused' }) })
    const sPaused = await bootSession(ownerPaused)
    assert.equal(sPaused.client.mimoDisplay.store.snapshot.freshness, 'paused', 'display DTO 必须保留 paused')
    pillOf(sPaused.tree).props.onClick()
    await sPaused.settle()
    assert.equal(ownerPaused.refreshCalls, 0, 'paused 不得强刷')

    // 8d paused 的后端形态（state 映射成 stopped）
    const ownerStopped = makeOwner({ display: display({ state: 'stopped', freshness: 'paused', balance: null }) })
    const sStopped = await bootSession(ownerStopped)
    pillOf(sStopped.tree).props.onClick()
    await sStopped.settle()
    assert.equal(ownerStopped.refreshCalls, 0)

    // 8e 非 managed（旧手工 Cookie 来源）
    const ownerManual = makeOwner({ display: display({ managed: false }) })
    const sManual = await bootSession(ownerManual)
    pillOf(sManual.tree).props.onClick()
    await sManual.settle()
    assert.equal(ownerManual.refreshCalls, 0, '非 managed 不得强刷')

    // 8f 未登录（holding）
    const ownerHolding = makeOwner({ display: display({ state: 'holding', balance: null }) })
    const sHolding = await bootSession(ownerHolding)
    pillOf(sHolding.tree).props.onClick()
    await sHolding.settle()
    assert.equal(ownerHolding.refreshCalls, 0, '未登录不得强刷')

    // 8g 未选中（selected=false）
    const ownerUnsel = makeOwner({ display: display({ selected: false }) })
    const sUnsel = await bootSession(ownerUnsel)
    pillOf(sUnsel.tree).props.onClick()
    await sUnsel.settle()
    assert.equal(ownerUnsel.refreshCalls, 0, 'selected=false 不得强刷')
  })

  await check('F9 可信 ok:false（读失败/超时）也立刻 pureStatus；不可信回包（传输/boot 不符）不 pump', async () => {
    // 9a 可信：ok:false + 本 boot + 已更新的 remembered.readFailures=5 ⇒ 必须**马上**反映失败分级
    const ownerA = makeOwner({
      refreshReply: {
        ok: false, code: 'E_MIMO_REMEMBERED_READ_TIMEOUT', bootEpoch: BOOT,
        remembered: { readFailures: 5, freshness: 'failed', generation: 2 },
      },
    })
    const a = await bootSession(ownerA)
    assert.ok(textOf(a.tree).includes('11.11'))
    const statusBeforeA = ownerA.statusCalls
    ownerA.display = display({ readFailures: 5, freshness: 'failed', code: 'E_MIMO_REMEMBERED_READ_TIMEOUT' })
    pillOf(a.tree).props.onClick()
    await a.settle()
    assert.equal(ownerA.refreshCalls, 1)
    assert.ok(ownerA.statusCalls > statusBeforeA, '可信 ok:false 之后必须补一次 pureStatus（不能等下一轮轮询）')
    const txtA = textOf(a.tree)
    assert.equal(txtA.includes('11.11'), false, '第 5 次失败必须立刻隐藏金额')
    assert.ok(txtA.includes('余额读取失败'))
    const panelA = panelOf(a.tree)
    assert.ok(panelA !== null)
    assert.ok(textOf(panelA).includes('E_MIMO_REMEMBERED_READ_TIMEOUT'), '详情给固定超时码（不是 E_UNKNOWN）')
    assert.equal(pillOf(a.tree).props.title.includes('E_MIMO'), false, '胶囊 title 仍不带原因')

    // 9b 不可信：传输失败（fetch 抛错 ⇒ 无可信 bootEpoch）
    const ownerB = makeOwner()
    ownerB.refreshThrows = true
    const b = await bootSession(ownerB)
    const statusBeforeB = ownerB.statusCalls
    pillOf(b.tree).props.onClick()
    await b.settle()
    assert.equal(ownerB.refreshCalls, 1)
    assert.equal(ownerB.statusCalls, statusBeforeB, '传输失败不得补 pump')
    assert.ok(textOf(b.tree).includes('11.11'))

    // 9c 不可信：回包 bootEpoch 不是本 boot
    const ownerC = makeOwner({ refreshReply: { ok: true, code: 'E_NONE', bootEpoch: 'b'.repeat(32) } })
    const c = await bootSession(ownerC)
    const statusBeforeC = ownerC.statusCalls
    pillOf(c.tree).props.onClick()
    await c.settle()
    assert.equal(ownerC.refreshCalls, 1)
    assert.equal(ownerC.statusCalls, statusBeforeC, 'bootEpoch 不一致不得补 pump')
    assert.ok(textOf(c.tree).includes('11.11'))
  })

  await check('F10 managed 墓碑（displaySupported:false + selected:true）必须遮住手工 Cookie 旧金额', async () => {
    // /api/plan-usage 里仍带着「手工 Cookie 来源」的旧金额（用户只删了输入、没删旧 cfg 字段值）
    const rawPlans = {
      ok: true,
      data: {
        plans: [
          { id: 'deepseek', name: 'DeepSeek', balance: 7.38, isAvailable: true, via: 'account', warnThreshold: 10 },
          { id: 'mimo', name: 'Xiaomi MiMo', balance: 88.88, currency: 'CNY', isAvailable: true },
        ],
      },
    }
    // 退出/空态诚实墓碑：没有活会话（displaySupported:false），但 managed+selected 仍为真
    const owner = makeOwner({
      display: display({
        displaySupported: false, selected: true, managed: true, state: 'absent',
        balance: null, fetchedAt: null, freshness: null, code: 'E_NONE',
      }),
    })
    const s = await bootSession(owner, undefined, rawPlans)
    assert.equal(textOf(s.tree).includes('88.88'), false, '墓碑下绝不回填手工 Cookie 旧金额')
    assert.ok(textOf(s.tree).includes('7.38'), '其它渠道不受影响')
    assert.equal(textOf(s.tree).includes('本机未启用'), false, 'managed 空态不得说成「本机未启用」')
    assert.equal(textOf(s.tree).includes('合成边界'), false)
    assert.ok(textOf(mimoRowOf(s.tree)).includes('请先登录'), '空态诚实说「请先登录」')
    pillOf(s.tree).props.onClick()
    await s.settle()
    const panel = panelOf(s.tree)
    assert.ok(panel !== null)
    assert.equal(textOf(panel).includes('88.88'), false, '详情也不得回填旧金额')
    assert.equal(owner.refreshCalls, 0, '非活会话（displaySupported:false）不取余额')
  })

  await check('F11 display code 白名单：controller REMEMBERED_CODES 的真实值全部保留，未知码仍折叠', async () => {
    // 输入证据直接来自 controller 源码（窄套），不靠手抄一张表自证
    const src = readFileSync('plans/mimo-auth/remembered-session.js', 'utf8')
    const block = /export const REMEMBERED_CODES = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(src)
    assert.ok(block !== null, '应能从 controller 源码读到 REMEMBERED_CODES')
    const codes = []
    const re = /'([A-Z][A-Z0-9_]{2,63})'/g
    let hit = re.exec(block[1])
    while (hit !== null) { codes.push(hit[1]); hit = re.exec(block[1]) }
    assert.ok(codes.length >= 20, 'REMEMBERED_CODES 应有多条，实际 ' + codes.length)
    assert.ok(codes.indexOf('E_MIMO_REMEMBERED_READ_TIMEOUT') !== -1, '读超时固定码必须在 controller 闭集里')

    const owner = makeOwner()
    const s = await bootSession(owner)
    const pick = s.client.mimoDisplay.pick
    for (const code of codes) {
      const picked = pick({
        ok: true, bootEpoch: BOOT,
        display: display({ readFailures: 5, freshness: 'failed', code }),
      }).display
      assert.equal(picked.code, code, 'controller 固定码必须原样保留：' + code)
    }
    // 自造/未知码一律折叠（白名单是闭集，不放宽成正则）
    const junk = pick({ ok: true, bootEpoch: BOOT, display: display({ code: 'E_MIMO_REMEMBERED_WHATEVER' }) }).display
    assert.equal(junk.code, '')
  })

  await check('F12 managed 非活态文案：空态「请先登录」/ 失败「登录状态不可用」+ 原因只在详情', async () => {
    // 12a empty（无错、非活）
    const ownerEmpty = makeOwner({
      display: display({
        displaySupported: false, selected: true, managed: true, state: 'absent',
        balance: null, fetchedAt: null, freshness: null, code: 'E_NONE',
      }),
    })
    const e = await bootSession(ownerEmpty)
    assert.equal(e.client.mimoDisplay.stateText(e.client.mimoDisplay.store.snapshot), '请先登录')
    const eRow = mimoRowOf(e.tree)
    assert.ok(eRow !== null)
    assert.ok(textOf(eRow).includes('请先登录'))
    assert.equal(textOf(e.tree).includes('本机未启用'), false)
    assert.equal(textOf(e.tree).includes('合成边界'), false)
    const ePill = pillOf(e.tree)
    assert.ok(ePill.props.title.includes('请先登录'))
    ePill.props.onClick()
    await e.settle()
    assert.ok(textOf(panelOf(e.tree)).includes('请先登录'))
    assert.equal(ownerEmpty.refreshCalls, 0, '未登录不得取余额')

    // 12b failed（带已知固定码）：胶囊只说「登录状态不可用」，原因只进详情
    const ownerFailed = makeOwner({
      display: display({
        displaySupported: false, selected: true, managed: true, state: 'absent',
        balance: null, fetchedAt: null, freshness: null, code: 'E_MIMO_REMEMBERED_RECORD_UNREADABLE',
      }),
    })
    const f = await bootSession(ownerFailed)
    const fTxt = textOf(f.tree)
    assert.ok(fTxt.includes('登录状态不可用'))
    assert.equal(fTxt.includes('E_MIMO_REMEMBERED_RECORD_UNREADABLE'), false, '胶囊不得泄漏原因码')
    assert.equal(fTxt.includes('本机未启用'), false)
    assert.equal(fTxt.includes('合成边界'), false)
    const fPill = pillOf(f.tree)
    assert.equal(fPill.props.title.includes('E_MIMO'), false, '胶囊 title 不得带原因码')
    fPill.props.onClick()
    await f.settle()
    const fPanel = panelOf(f.tree)
    assert.ok(fPanel !== null)
    assert.ok(textOf(fPanel).includes('登录状态不可用：E_MIMO_REMEMBERED_RECORD_UNREADABLE'), '详情给固定原因码')
    assert.equal(ownerFailed.refreshCalls, 0, '非活态不取余额')

    // 12c legacy 非 managed 文案不动（纯函数直测，不挂载）
    assert.equal(
      e.client.mimoDisplay.stateText({ managed: false, displaySupported: false, state: 'absent', code: '', freshness: null, balance: null }),
      '本机未启用（合成边界）',
    )
    assert.equal(
      e.client.mimoDisplay.shortText({ managed: false, displaySupported: false, state: 'absent', code: '', freshness: null, balance: null }, false),
      '未启用',
    )
  })

  const summary = pass + ' passed, ' + fails.length + ' failed'
  if (fails.length) { console.error(summary); for (const f of fails) console.error(' - ' + f); process.exitCode = 1 } else console.log(summary + ' (' + (pass + fails.length) + ')')
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
