/**
 * [方向 6 / T2] 注册层测试：可选服务、缓存身份、只缓存成功、端到端预算与取消。
 *
 * D6-B：缓存必须按「允许集合 + 真实凭据身份」隔离；不可证明身份的渠道不缓存。
 * D6-D：只缓存真正成功；fetch 失败立即可重试；`fetchedAt` 在命中时保持不变。
 * D6-E：deadline 从 execute 入口开始；`exec.signal` 生效；超时保留已完成渠道。
 * D6-G：策略文本随工具结果返回，render 可见。
 *
 * 用**假 tools 服务**（按宿主真实契约校验定义形状），不 import 宿主包。
 *
 * 用法：node tools/test-usage-tool-register.mjs
 */
import assert from 'node:assert/strict'
import {
  createUsageTool, registerUsageTool, withBudget, createDeadline, isCacheable,
  PARAMETERS, OUTPUT_SCHEMA,
} from '../plans/usage-tool-register.js'
import { TOOL_NAME, TOOL_CACHE_TTL_MS } from '../plans/usage-tool.js'
import { percentSemanticsOf } from '../plans/index.js'
import { policyOf } from '../plans/usage-policy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BUDGET = 60

function fakeTools() {
  const registered = new Map()
  const disposals = { count: 0 }
  const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'examples'])
  function assertSchema(node, path) {
    assert.ok(node !== null && typeof node === 'object', path + ' 必须是 schema 对象')
    for (const key of Object.keys(node)) {
      assert.ok(ALLOWED.has(key), path + '.' + key + ' 不在宿主支持的子集内')
    }
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) assertSchema(v, path + '.properties.' + k)
    }
    if (node.items) assertSchema(node.items, path + '.items')
  }
  return {
    registered,
    disposals,
    register(definition) {
      assert.equal(typeof definition.name, 'string')
      assert.ok(definition.output !== undefined && typeof definition.output.output !== 'function')
      assert.equal(typeof definition.output.render, 'function')
      assertSchema(definition.output.schema, 'output.schema')
      assertSchema(definition.parameters, 'parameters')
      assert.equal(definition.name, TOOL_NAME)
      assert.notEqual(definition.name, 'run_code')
      assert.equal(typeof definition.execute, 'function')
      let disposed = false
      registered.set(definition.name, definition)
      return () => {
        if (disposed) return
        disposed = true
        disposals.count += 1
        registered.delete(definition.name)
      }
    },
  }
}

function fakeCtx(services) {
  return {
    get: (name) => (services != null && Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined),
  }
}

/** 按宿主规则校验 execute 的返回值（只实现本工具用到的子集）。 */
function validateAgainst(schema, value, path) {
  if (Array.isArray(schema.type)) {
    for (const t of schema.type) {
      if (validateAgainst(Object.assign({}, schema, { type: t }), value, path) === null) return null
    }
    return path + ' 类型不匹配'
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return path + ' 应为对象'
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return path + '.' + key + ' 缺失'
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) return path + '.' + key + ' 不允许'
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      const err = validateAgainst(sub, value[key], path + '.' + key)
      if (err !== null) return err
    }
    return null
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return path + ' 应为数组'
    for (let i = 0; i < value.length; i += 1) {
      const err = validateAgainst(schema.items || {}, value[i], path + '[' + i + ']')
      if (err !== null) return err
    }
    return null
  }
  if (schema.enum !== undefined) return schema.enum.includes(value) ? null : path + ' 不在枚举内'
  if (schema.const !== undefined) return value === schema.const ? null : path + ' 不等于 const'
  if (schema.type === 'string') return typeof value === 'string' ? null : path + ' 应为字符串'
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : path + ' 应为数字'
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : path + ' 应为布尔'
  if (schema.type === 'null') return value === null ? null : path + ' 应为 null'
  return null
}

/** 造一个可控的 snapshot。 */
function snapshot(over) {
  return Object.assign({
    enabled: ['deepseek', 'codex'],
    known: ['deepseek', 'codex'],
    generation: 'gen-1',
    identity: 'ident-1',
    cacheable: new Set(['deepseek', 'codex']),
    policy: null,
    policySection: null,
    semanticsOf: percentSemanticsOf,
  }, over || {})
}

/** 造一条成功 wire。 */
function okWire(id, balance, fetchedAt) {
  const wire = { id, balance, currency: 'CNY' }
  if (fetchedAt !== undefined) wire.fetchedAt = fetchedAt
  return wire
}

// ===========================================================================
// R1 — 定义形状符合宿主契约
// ===========================================================================
{
  const tool = createUsageTool({ describe: async () => snapshot(), collectPlans: async () => [] })
  check('R1a 工具名正确', tool.definition.name === TOOL_NAME)
  check('R1b 有描述', typeof tool.definition.description === 'string' && tool.definition.description.length > 20)
  check('R1c 参数只允许 ids', Object.keys(PARAMETERS.properties).join(',') === 'ids')
  check('R1d 参数不允许额外字段', PARAMETERS.additionalProperties === false)
  check('R1e 输出对象根', OUTPUT_SCHEMA.type === 'object')
  check('R1f render 返回 text 块', tool.definition.output.render({}, { channels: [] })[0].type === 'text')
}

// ===========================================================================
// R2 — 可选注册
// ===========================================================================
{
  const tools = fakeTools()
  const ok = registerUsageTool(fakeCtx({ tools }), { describe: async () => snapshot(), collectPlans: async () => [] })
  check('R2a 注册成功', ok.registered === true && tools.registered.has(TOOL_NAME))
  check('R2b 返回 disposer', typeof ok.dispose === 'function')
  ok.dispose()
  check('R2c disposer 生效', !tools.registered.has(TOOL_NAME))

  check('R2d 缺服务跳过', registerUsageTool(fakeCtx({}), {}).registered === false)
  check('R2e null 跳过', registerUsageTool(fakeCtx({ tools: null }), {}).registered === false)
  check('R2f get 抛错跳过', registerUsageTool({ get() { throw new Error('boom') } }, {}).registered === false)
  check('R2g 宿主拒绝时返回原因',
    registerUsageTool(fakeCtx({ tools: { register() { throw new TypeError('must declare output') } } }), {}).reason.includes('output'))
  check('R2h 无 register 方法跳过', registerUsageTool(fakeCtx({ tools: {} }), {}).registered === false)
  check('R2i ctx 为 null 跳过', registerUsageTool(null, {}).registered === false)
}

// ===========================================================================
// R3 — 返回值符合 output.schema
// ===========================================================================
{
  const tools = fakeTools()
  registerUsageTool(fakeCtx({ tools }), {
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    collectPlans: async (ids) => ids.map((id) => okWire(id, 7.38)),
  })
  const def = tools.registered.get(TOOL_NAME)
  const value = await def.execute({})
  const err = validateAgainst(OUTPUT_SCHEMA, value, 'value')
  check('R3a 符合 output.schema', err === null, err)
  check('R3b 两条渠道', value.channels.length === 2)
  check('R3c policy 为 null（未启用）', value.policy === null, value.policy)
  check('R3d 成功写入 fetchedAt', typeof value.channels[0].fetchedAt === 'number', value.channels[0].fetchedAt)
}

// ===========================================================================
// R4 — D6-E：describe 也在预算内
// ===========================================================================
{
  let describeCalls = 0
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => { describeCalls += 1; await sleep(500); return snapshot() },
    collectPlans: async () => [okWire('deepseek', 1)],
  })
  const started = Date.now()
  const out = await tool.definition.execute({})
  const elapsed = Date.now() - started
  check('R4a describe 慢时总耗时受预算限制', elapsed < 400, elapsed)
  check('R4b 超时返回空渠道而不是挂死', out.channels.length === 0, out.channels)
  check('R4c 只读了一次配置', describeCalls === 1, describeCalls)
}

{
  // describe 永久挂起：必须有 deadline 保护
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: () => new Promise(() => {}),
    collectPlans: async () => [okWire('deepseek', 1)],
  })
  const started = Date.now()
  const out = await tool.definition.execute({})
  check('R4d describe 永挂时按预算返回', Date.now() - started < 400, Date.now() - started)
  check('R4e 不伪造数据', out.channels.length === 0)
}

// ===========================================================================
// R5 — D6-E：exec.signal 生效
// ===========================================================================
{
  let collectCalls = 0
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    collectPlans: async () => { collectCalls += 1; return [okWire('deepseek', 1)] },
  })
  const controller = new AbortController()
  controller.abort()
  const out = await tool.definition.execute({}, { signal: controller.signal })
  check('R5a 入口已 abort 时不取数', collectCalls === 0, collectCalls)
  check('R5b 返回空渠道', out.channels.length === 0)
}

{
  // 取数中途 abort：应尽快返回，且不把结果写缓存
  const tool = createUsageTool({
    budgetMs: 2000,
    describe: async () => snapshot(),
    collectPlans: async () => { await sleep(1000); return [okWire('deepseek', 1)] },
  })
  const controller = new AbortController()
  const started = Date.now()
  const promise = tool.definition.execute({}, { signal: controller.signal })
  await sleep(30)
  controller.abort()
  const out = await promise
  check('R5c 中途 abort 后很快返回', Date.now() - started < 500, Date.now() - started)
  check('R5d abort 后不伪造数据', out.channels.length === 0)
  check('R5e abort 后未写缓存', tool.cacheSize() === 0, tool.cacheSize())
}

// ===========================================================================
// R6 — D6-E：慢渠道不抹掉快渠道
// ===========================================================================
{
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    // 模拟「逐渠道收敛」：快渠道通过 onChannel 立刻回传，慢渠道永不完成
    collectPlans: async (ids, info) => {
      if (typeof info.onChannel === 'function') info.onChannel(okWire('deepseek', 12))
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, info.deadline.remaining())
        if (typeof timer.unref === 'function') timer.unref()
      })
      return []
    },
  })
  const out = await tool.definition.execute({ ids: ['deepseek', 'codex'] })
  const ds = out.channels.find((c) => c.id === 'deepseek')
  const codex = out.channels.find((c) => c.id === 'codex')
  check('R6a 快渠道保留成功值', ds !== undefined && ds.balance === 12, ds)
  check('R6b 慢渠道标 missing', codex !== undefined && codex.errorCode === 'missing', codex)
}

// ===========================================================================
// R7 — D6-D：只缓存真正成功
// ===========================================================================
{
  let mode = 'fail'
  let calls = 0
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    collectPlans: async () => {
      calls += 1
      if (mode === 'fail') return [{ id: 'deepseek', error: 'network', transient: true }]
      return [okWire('deepseek', 12)]
    },
  })
  const first = await tool.definition.execute({ ids: ['deepseek'] })
  check('R7a 网络错误返回 error', first.channels[0].availability === 'error', first.channels[0])
  check('R7b 错误不进入缓存', tool.cacheSize() === 0, tool.cacheSize())
  mode = 'ok'
  const second = await tool.definition.execute({ ids: ['deepseek'] })
  check('R7c 失败后可立即重试成功', calls === 2 && second.channels[0].balance === 12, { calls, second })
  check('R7d 成功后进入缓存', tool.cacheSize() === 1, tool.cacheSize())
}

{
  // 混合批次：成功项缓存，失败项可重试
  let calls = 0
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    collectPlans: async (ids) => {
      calls += 1
      return ids.map((id) => (id === 'deepseek'
        ? okWire('deepseek', 12)
        : { id, error: 'server', transient: true }))
    },
  })
  await tool.definition.execute({ ids: ['deepseek', 'codex'] })
  const afterFirst = tool.cacheSize()
  await tool.definition.execute({ ids: ['deepseek', 'codex'] })
  check('R7e 混合批次只缓存成功项', afterFirst === 1, afterFirst)
  check('R7f 失败项触发重新取数', calls === 2, calls)
}

// ===========================================================================
// R8 — D6-D：TTL 与 fetchedAt 契约
// ===========================================================================
{
  let clock = 1700000000000
  let calls = 0
  const tool = createUsageTool({
    now: () => clock,
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    collectPlans: async () => { calls += 1; return [okWire('deepseek', 5)] },
  })
  const first = await tool.definition.execute({ ids: ['deepseek'] })
  const firstAt = first.channels[0].fetchedAt
  check('R8a 首次真取数', calls === 1)
  check('R8b fetchedAt 是采集时间', firstAt === 1700000000000, firstAt)

  clock += 5000
  const second = await tool.definition.execute({ ids: ['deepseek'] })
  check('R8c TTL 内命中缓存', calls === 1, calls)
  check('R8d 命中缓存不刷新时间', second.channels[0].fetchedAt === firstAt, second.channels[0].fetchedAt)

  clock += TOOL_CACHE_TTL_MS
  const third = await tool.definition.execute({ ids: ['deepseek'] })
  check('R8e 超过 TTL 重新取数', calls === 2, calls)
  check('R8f 重新采集后时间更新', third.channels[0].fetchedAt === clock, third.channels[0].fetchedAt)
}

// ===========================================================================
// R9 — D6-B：缓存按身份与允许集合隔离
// ===========================================================================
{
  let calls = 0
  let snap = snapshot({ identity: 'ident-A' })
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snap,
    collectPlans: async () => { calls += 1; return [okWire('deepseek', calls)] },
  })
  await tool.definition.execute({ ids: ['deepseek'] })
  check('R9a 首次取数', calls === 1)
  await tool.definition.execute({ ids: ['deepseek'] })
  check('R9b 同身份命中缓存', calls === 1)

  snap = snapshot({ identity: 'ident-B' })
  const rotated = await tool.definition.execute({ ids: ['deepseek'] })
  check('R9c 身份变化后不吃旧缓存', calls === 2, calls)
  check('R9d 返回新身份的数据', rotated.channels[0].balance === 2, rotated.channels[0])
}

{
  // 不在 cacheable 里的渠道永不缓存（例如账号型渠道）
  let calls = 0
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot({ cacheable: new Set() }),
    collectPlans: async () => { calls += 1; return [okWire('deepseek', 9)] },
  })
  await tool.definition.execute({ ids: ['deepseek'] })
  await tool.definition.execute({ ids: ['deepseek'] })
  check('R9e 非 cacheable 渠道每次都重取', calls === 2, calls)
  check('R9f 不写缓存', tool.cacheSize() === 0, tool.cacheSize())
}

{
  // 停用后显式查询：不能命中旧成功值
  let enabled = ['deepseek']
  let calls = 0
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot({ enabled, known: ['deepseek'], cacheable: new Set(['deepseek']) }),
    collectPlans: async () => { calls += 1; return [okWire('deepseek', 9)] },
  })
  await tool.definition.execute({ ids: ['deepseek'] })
  enabled = []
  const out = await tool.definition.execute({ ids: ['deepseek'] })
  check('R9g 停用后返回 disabled', out.channels[0].errorCode === 'disabled', out.channels[0])
  check('R9h 停用后不再取数', calls === 1, calls)
}

// ===========================================================================
// R10 — 策略随结果返回（D6-G）
// ===========================================================================
{
  const policy = policyOf({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 0,
    quotaBalanceThreshold: 10,
    quotaBalanceCurrency: 'CNY',
  })
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot({ policy }),
    collectPlans: async () => [okWire('deepseek', 3)],
  })
  const out = await tool.definition.execute({ ids: ['deepseek'] })
  check('R10a 结果带 policy', out.policy !== null && typeof out.policy.text === 'string', out.policy)
  check('R10b policy 文本含渠道与数值', out.policy.text.includes('DeepSeek') && out.policy.text.includes('CNY'), out.policy.text)
  const rendered = tool.definition.render
  check('R10c render 含 policy 文本',
    tool.definition.output.render({}, out)[0].text.includes('用量提示'))
  void rendered
  const schemaErr = validateAgainst(OUTPUT_SCHEMA, out, 'value')
  check('R10d 带 policy 仍符合 schema', schemaErr === null, schemaErr)
}

{
  // 未触发时不产生 policy
  const policy = policyOf({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 0,
    quotaBalanceThreshold: 10,
    quotaBalanceCurrency: 'CNY',
  })
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot({ policy }),
    collectPlans: async () => [okWire('deepseek', 100)],
  })
  const out = await tool.definition.execute({ ids: ['deepseek'] })
  check('R10e 未触发时 policy 为 null', out.policy === null, out.policy)
  check('R10f render 不含策略文本', !tool.definition.output.render({}, out)[0].text.includes('用量提示'))
}

// ===========================================================================
// R11 — 首次调用与开关变化
// ===========================================================================
{
  let ready = false
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot({ enabled: ready ? ['deepseek', 'codex'] : [], known: ready ? ['deepseek', 'codex'] : [] }),
    collectPlans: async (ids) => ids.map((id) => okWire(id, 1)),
  })
  const before = await tool.definition.execute({})
  check('R11a 配置未就绪不崩', Array.isArray(before.channels) && before.channels.length === 0)
  ready = true
  const after = await tool.definition.execute({})
  check('R11b 就绪后能查到渠道', after.channels.length === 2, after.channels)
}

// ===========================================================================
// R12 — 参数错误与退场 id
// ===========================================================================
{
  const tool = createUsageTool({
    budgetMs: BUDGET,
    describe: async () => snapshot(),
    collectPlans: async () => [okWire('deepseek', 1)],
  })
  let threw = null
  try { await tool.definition.execute({ ids: ['nope'] }) } catch (err) { threw = err }
  check('R12a 未知 id 抛错', threw !== null && threw.message.includes('未知渠道'), threw && threw.message)

  const retired = await tool.definition.execute({ ids: ['kimi-code'] })
  check('R12b 退场返回 retired-channel', retired.channels[0].errorCode === 'retired-channel')
}

// ===========================================================================
// R13 — 工具函数
// ===========================================================================
{
  const started = Date.now()
  const out = await withBudget(new Promise(() => {}), 40)
  check('R13a withBudget 超时返回空', Array.isArray(out) && out.length === 0)
  check('R13b 生效', Date.now() - started < 500)
  const ok = await withBudget(Promise.resolve([{ id: 'x' }]), 1000)
  check('R13c 未超预算透传', ok.length === 1)

  const d = createDeadline(30, null)
  check('R13d deadline 未过期', d.expired === false)
  await sleep(50)
  check('R13e deadline 到期', d.expired === true)
  d.dispose()

  check('R13f isCacheable 拒绝 error', !isCacheable({ availability: 'error', balance: 1 }))
  check('R13g isCacheable 接受有值', isCacheable({ availability: 'ok', balance: 1 }))
  check('R13h isCacheable 接受 unlimited', isCacheable({ availability: 'unlimited', unlimited: true }))
  check('R13i isCacheable 拒绝空 ok', !isCacheable({ availability: 'ok', balance: null, windows: [] }))
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
