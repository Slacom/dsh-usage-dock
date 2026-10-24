/**
 * [方向 6 / T2] `usage_status` 工具注册层：可选服务、成功缓存、single-flight、预算与清理。
 *
 * 与 T1 的分工：
 *   - `plans/usage-tool.js` 是**纯投影**（无 IO、无状态）；
 *   - 本模块负责**编排**：拿 `ctx.tools`、按需取数、30 秒成功缓存、single-flight、
 *     端到端预算、注册 disposer。
 *
 * D6 复核后的关键约束：
 *   - **D6-E**：deadline 从 `execute` 入口开始，覆盖配置读取、身份解析与取数；
 *     组合调用方 `exec.signal`；到期/取消后**不再**开启后续请求、**不**回写缓存；
 *     逐渠道保留已完成结果，慢渠道不会抹掉快渠道。
 *   - **D6-B**：缓存按「当前允许集合 + 真实账户/凭据身份」隔离；无法证明身份的渠道
 *     **不缓存**（宁可重取，也不猜账户）。
 *   - **D6-D**：只缓存**真正成功**的数据并写 `fetchedAt`；失败/未知不缓存，可立即重试。
 *   - **D6-G**：策略文本随工具结果返回（模型可见），Index 另外注册 systemPrompt 段落。
 *
 * 硬约束（计划第 5 节）：通过 `ctx.get('tools')` 取可选服务，**不 import** 宿主工具包。
 */

import {
  TOOL_NAME, TOOL_CACHE_TTL_MS, TOOL_BUDGET_MS,
  parseToolArgs, projectUsage, renderUsage,
} from './usage-tool.js'
import { policyPromptWith } from './usage-policy.js'

/** 参数 schema：只接受可选的 `ids` 字符串数组。 */
const PARAMETERS = {
  type: 'object',
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string' },
      description: '要查询的渠道 id 列表；留空表示查询当前已启用且受支持的全部渠道。',
    },
  },
  additionalProperties: false,
}

/**
 * 可空字段：宿主只支持**单一** `type` 字符串，`type: ['number','null']` 会被
 * `assertSupportedJsonSchema` 直接拒绝（注册抛错 → 工具静默消失）。
 * 这里统一用 `oneOf` 表达「T 或 null」。
 */
const nullable = (type) => ({ oneOf: [{ type }, { type: 'null' }] })

const WINDOW_SCHEMA = {
  type: 'object',
  required: ['scope', 'percent', 'percentMode'],
  properties: {
    scope: { type: 'string' },
    percent: nullable('number'),
    percentMode: { type: 'string', const: 'remaining' },
    resetsAt: nullable('string'),
    resetInSec: nullable('number'),
  },
  additionalProperties: false,
}

const CHANNEL_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'kind', 'availability'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['balance', 'quota', 'credits', 'unknown'] },
    availability: { type: 'string', enum: ['ok', 'unlimited', 'unavailable', 'error', 'unknown'] },
    errorCode: nullable('string'),
    message: nullable('string'),
    transient: { type: 'boolean' },
    balance: nullable('number'),
    currency: nullable('string'),
    unit: nullable('string'),
    unlimited: { type: 'boolean' },
    fetchedAt: nullable('number'),
    stale: { type: 'boolean' },
    windows: { type: 'array', items: WINDOW_SCHEMA },
  },
  additionalProperties: false,
}

/** 输出 schema：对象根，白名单字段（宿主只支持 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['channels'],
  properties: {
    channels: { type: 'array', items: CHANNEL_SCHEMA },
    policy: {
      oneOf: [
        {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } },
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
  },
  additionalProperties: false,
}

/**
 * [D6-E] 绝对 deadline：从调用入口开始计时，可组合调用方 `AbortSignal`。
 *
 * 返回对象同时暴露 `signal`（供底层请求使用）与 `remaining()`（供子任务分配预算）。
 * `expired` 一旦为真，就**不得**再发起新的凭据解析或网络请求。
 */
export function createDeadline(ms, externalSignal) {
  const total = typeof ms === 'number' && ms > 0 ? ms : TOOL_BUDGET_MS
  const controller = new AbortController()
  const deadlineAt = Date.now() + total
  let settled = false
  const timer = setTimeout(() => {
    settled = true
    try { controller.abort(new Error('usage_status deadline')) } catch (err) { /* 已中止 */ }
  }, total)
  if (typeof timer.unref === 'function') timer.unref()
  const onExternal = () => {
    settled = true
    try { controller.abort(new Error('usage_status aborted')) } catch (err) { /* 已中止 */ }
  }
  const hasExternal = externalSignal !== null && externalSignal !== undefined
  if (hasExternal) {
    if (externalSignal.aborted === true) onExternal()
    else if (typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', onExternal, { once: true })
    }
  }
  return {
    deadlineAt,
    get expired() { return settled || Date.now() >= deadlineAt },
    get signal() { return controller.signal },
    remaining() { return Math.max(0, deadlineAt - Date.now()) },
    dispose() {
      settled = true
      clearTimeout(timer)
      if (hasExternal && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', onExternal)
      }
    },
  }
}

/**
 * 给一个 Promise 套上预算。
 *
 * 超时**不 reject**，而是返回空数组：让投影层把每个请求的渠道标成 missing，
 * 模型看到的是「这次没取到」而不是整次调用失败。迟到的结果被丢弃。
 */
export async function withBudget(promise, ms) {
  const timeout = typeof ms === 'number' && ms > 0 ? ms : TOOL_BUDGET_MS
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve([]), timeout)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    const raced = await Promise.race([
      Promise.resolve(promise).catch(() => []),
      guard,
    ])
    return Array.isArray(raced) ? raced : []
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 在 deadline 内等待；超时或调用方取消时返回 `{ done:false }`（不 reject、不悬挂）。 */
async function awaitWithinDeadline(promise, deadline) {
  if (deadline.expired) return { done: false, value: undefined }
  let timer = null
  let detach = null
  const guard = new Promise((resolve) => {
    const finish = () => resolve({ done: false, value: undefined })
    timer = setTimeout(finish, deadline.remaining())
    if (typeof timer.unref === 'function') timer.unref()
    // [Y2] 中途取消必须立刻返回，而不是等满整个 deadline。
    if (deadline.signal !== null && deadline.signal !== undefined
      && typeof deadline.signal.addEventListener === 'function') {
      deadline.signal.addEventListener('abort', finish, { once: true })
      detach = () => deadline.signal.removeEventListener('abort', finish)
    }
  })
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ done: true, value }))
        .catch(() => ({ done: false, value: undefined })),
      guard,
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (typeof detach === 'function') detach()
  }
}

/**
 * [F1] 把 identify 返回的快照合并成一张逐 id 的冻结表。
 *
 * `identify` 分别产出 `frozen`（内置渠道）与 `custom`（自定义条目）；
 * **两者都必须转发**，否则自定义条目会丢掉冻结值、退回二次解析，
 * 于是「采样 A、发送 B」的窗口会重新出现。
 */
function mergeFrozenSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return null
  const merged = {}
  let count = 0
  for (const part of [snapshot.frozen, snapshot.custom]) {
    if (part === null || part === undefined || typeof part !== 'object') continue
    for (const id of Object.keys(part)) {
      merged[id] = part[id]
      count += 1
    }
  }
  return count === 0 ? null : merged
}

/** 只有「确实拿到了数值」的结果才允许进入缓存（D6-D）。 */
export function isCacheable(channel) {
  if (channel === null || channel === undefined) return false
  if (channel.availability !== 'ok' && channel.availability !== 'unlimited') return false
  if (channel.unlimited === true) return true
  if (Array.isArray(channel.windows) && channel.windows.length > 0) return true
  return typeof channel.balance === 'number'
}

/**
 * 构造工具定义（**不注册**）。
 *
 * `deps` 由 index.js 注入：
 *   - `describe({ deadline })` → Promise<{ enabled, known, generation, identity, cacheable, policy, policySection }>
 *       `enabled`：当前启用 id；`known`：配置里存在的 id；`identity`：可缓存的凭据身份；
 *       `cacheable`：允许进入缓存的 id 集合（无法证明身份的渠道不要放进来）；
 *       `policy`：当前生效的策略对象或 null；`policySection`：系统提示词段落文本或 null。
 *   - `collect(ids, { snapshot, deadline, signal })` → Promise<wire 计划数组>：
 *       必须**逐渠道**在 deadline 内收敛，已完成的成功项要原样返回。
 *   - `onPolicySection(text)`：可选；Index 用来同步 systemPrompt 段落。
 *   - `now()`：注入时钟（测试用）。
 */
export function createUsageTool(deps) {
  const opts = deps || {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const describe = typeof opts.describe === 'function' ? opts.describe : async () => ({ enabled: [], known: [] })
  const collect = typeof opts.collectPlans === 'function' ? opts.collectPlans : async () => []
  const identify = typeof opts.identify === 'function' ? opts.identify : null
  const onPolicySection = typeof opts.onPolicySection === 'function' ? opts.onPolicySection : null
  // 测试可注入更短的预算；生产恒为 TOOL_BUDGET_MS。
  const budgetMs = typeof opts.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : TOOL_BUDGET_MS

  // 成功缓存：`id\u0000identity` → { at, channel }（**逐渠道**，便于部分命中）
  const cache = new Map()
  // 共享取数任务：`generation\u0000ids` → { progress, promise, controller, refs }
  const tasks = new Map()
  // [Y1] 无法证明身份的渠道用私有任务，键里带唯一序号（不跨账户复用）。
  let privateSeq = 0

  function cacheKeyOf(id, generation, identity) {
    // 代次（配置摘要 + 开关）与凭据身份都参与：任何一层变化都不得命中旧值。
    return id + '\u0000' + String(generation || '') + '\u0000' + String(identity || '')
  }

  function readCache(id, generation, identity) {
    const key = cacheKeyOf(id, generation, identity)
    const hit = cache.get(key)
    if (hit === undefined) return null
    if (now() - hit.at >= TOOL_CACHE_TTL_MS) {
      cache.delete(key)
      return null
    }
    return hit.channel
  }

  function writeCache(id, generation, identity, channel) {
    cache.set(cacheKeyOf(id, generation, identity), { at: now(), channel })
  }

  /** 启动/复用一次共享取数任务（[Y1] 任务本身绑定启动时的真实身份）。 */
  function taskFor(key, ids, snapshot, callerRemaining) {
    const exists = tasks.get(key)
    if (exists !== undefined) {
      exists.refs += 1
      return exists
    }
    /**
     * [R7-03] **私有任务不得重新获得一整份 8 秒。**
     *
     * 新建任务时把调用者的剩余预算夹进来：调用者已经花了 667ms 做 identify，
     * 它就只能拿到剩下的部分。共享任务的独立生命周期仍然保留
     * ——已存在的任务不因新调用者加入而被缩短。
     */
    const clamped = typeof callerRemaining === 'number' && Number.isFinite(callerRemaining)
      ? Math.max(0, callerRemaining)
      : null
    const taskBudget = clamped === null ? budgetMs : Math.min(budgetMs, clamped)
    const controller = new AbortController()
    const progress = { channels: new Map(), done: false, aborted: false }
    // 任务记录**启动时**的 generation 与 identity：回写缓存与交付结果都以它为准，
    // 绝不用调用方当前的 identity 去包装别的任务取回的数据。
    const task = {
      progress,
      controller,
      refs: 1,
      key,
      generation: String(snapshot.generation || ''),
      identity: String(snapshot.identity || ''),
    }
    /**
     * 预算已耗尽：直接置为完成、**零请求**。
     * `createDeadline(0)` 会回落到整份 8 秒，所以必须在这里短路。
     */
    if (taskBudget <= 0) {
      progress.done = true
      task.promise = Promise.resolve(progress)
      tasks.set(key, task)
      tasks.delete(key)
      return task
    }
    // 共享任务用**自己**的 deadline：不因某个调用方提前离开而中断其它调用方。
    const taskDeadline = createDeadline(Math.max(1, taskBudget), controller.signal)
    task.promise = (async () => {
      try {
        const wires = await collect(ids, {
          snapshot,
          deadline: taskDeadline,
          signal: taskDeadline.signal,
          // [D6-E] 逐渠道回传：快渠道即使在全批结束前也能被保留。
          onChannel: (wire) => {
            if (wire === null || typeof wire !== 'object' || typeof wire.id !== 'string') return
            progress.channels.set(wire.id, wire)
          },
        })
        if (Array.isArray(wires)) {
          for (const wire of wires) {
            if (wire === null || typeof wire !== 'object' || typeof wire.id !== 'string') continue
            progress.channels.set(wire.id, wire)
          }
        }
      } catch (err) {
        /* 取数失败：按缺失处理，不写缓存 */
      } finally {
        progress.done = true
        taskDeadline.dispose()
        if (tasks.get(key) === task) tasks.delete(key)
      }
      return progress
    })()
    tasks.set(key, task)
    return task
  }

  /** 把一条 wire 投影成渠道（含 `fetchedAt` 与状态判定）。 */
  function projectWire(wire, snapshot) {
    // [D6-D] 成功采集时打时间戳（仅当 wire 没有自带时间）。
    const candidate = wire.error === undefined && wire.fetchedAt === undefined
      ? Object.assign({}, wire, { fetchedAt: now() })
      : wire
    const projected = projectUsage([candidate], [wire.id], {
      enabled: snapshot.enabled,
      known: snapshot.known,
      semanticsOf: snapshot.semanticsOf,
    })
    return projected.channels.length > 0 ? projected.channels[0] : null
  }

  /** 单次调用的核心：读缓存 + 取缺失渠道，并在本调用 deadline 内返回。 */
  async function resolve(ids, snapshot, deadline) {
    /**
     * [R7-03] 本次调用**入口**算起的剩余预算。
     *
     * identify 等前置步骤已经花掉一部分；新建的取数任务只能拿剩下的，
     * 不能再开一份完整 8 秒（审核实测：剩余 7333ms 的任务却拿到 7997ms）。
     */
    const callerRemaining = deadline !== null && deadline !== undefined
      && typeof deadline.remaining === 'function'
      ? deadline.remaining()
      : undefined
    const identity = String(snapshot.identity || '')
    const cacheable = snapshot.cacheable instanceof Set
      ? snapshot.cacheable
      : new Set(snapshot.cacheable || [])
    const resolved = new Map()
    const missing = []
    const enabledSet = snapshot.enabled instanceof Set ? snapshot.enabled : new Set(snapshot.enabled || [])
    for (const id of ids) {
      // [D6-B] 停用/不存在的渠道**不读缓存、不取数**：由 finalize 给出可辨状态。
      if (!enabledSet.has(id)) continue
      /**
       * [P2 第三次] 命中缓存前先问**同一来源**是否已被判为永久失败。
       *
       * 审核复现：GUI 已经收到 401、Host 也显示「获取额度失败」，
       * 工具却仍凭 30 秒成功缓存返回旧的 ok/1，且零新请求 —— 等于用旧成功
       * 掩盖当前的确定失败。这里让已知失败优先：不采用该缓存项，
       * 转成 missing 走真实重试；重试拿到真正的新成功后才恢复。
       *
       * 只拦「永久失败/过期」；暂时失败仍按原有宽限规则（保留缓存是正确行为）。
       */
      // [R4-02] 必须把本次身份一起传下去：观察记录按 (id, identity) 存储。
      const sourceFailed = typeof deps.isSourceFailed === 'function'
        ? deps.isSourceFailed(id, identity) === true
        : false
      if (sourceFailed) {
        // 丢弃该身份的旧成功缓存，避免下一次又被它命中。
        cache.delete(cacheKeyOf(id, snapshot.generation, identity))
        missing.push(id)
        continue
      }
      if (cacheable.has(id)) {
        const hit = readCache(id, snapshot.generation, identity)
        if (hit !== null) { resolved.set(id, hit); continue }
      }
      missing.push(id)
    }
    if (missing.length === 0) return resolved

    // [Y1] 可证明身份的渠道才能共享在途任务；无法证明的（账号/会话型）每次单独取证，
    // 否则 A 账户的在途结果会被当成 B 账户的数据。
    const shareableIds = missing.filter((id) => cacheable.has(id))
    const privateIds = missing.filter((id) => !cacheable.has(id))
    const groups = []
    if (shareableIds.length > 0) {
      const key = String(snapshot.generation || '') + '\u0000' + identity + '\u0000'
        + shareableIds.slice().sort().join(',')
      groups.push({ task: taskFor(key, shareableIds, snapshot, callerRemaining), ids: shareableIds, shareable: true })
    }
    if (privateIds.length > 0) {
      // 私有任务：键里带唯一后缀，永不与他人复用。
      const key = String(snapshot.generation || '') + '\u0000private\u0000' + (privateSeq += 1)
        + '\u0000' + privateIds.slice().sort().join(',')
      groups.push({ task: taskFor(key, privateIds, snapshot, callerRemaining), ids: privateIds, shareable: false })
    }

    let timedOut = false
    let timer = null
    let detach = null
    const guard = new Promise((resolveGuard) => {
      const finish = () => { timedOut = true; resolveGuard() }
      timer = setTimeout(finish, deadline.remaining())
      if (typeof timer.unref === 'function') timer.unref()
      // 调用方取消：立刻停止等待（底层由引用计数负责收尾）。
      const signal = deadline.signal
      if (signal !== null && signal !== undefined && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', finish, { once: true })
        detach = () => signal.removeEventListener('abort', finish)
      }
    })
    try {
      await Promise.race([Promise.all(groups.map((group) => group.task.promise)), guard])
    } finally {
      if (timer !== null) clearTimeout(timer)
      if (typeof detach === 'function') detach()
    }
    // 本调用到点/被取消：**不**写缓存、**不**等待，只取已完成的部分。
    const aborted = deadline.expired || timedOut
    for (const group of groups) {
      for (const wire of Array.from(group.task.progress.channels.values())) {
        if (!group.ids.includes(wire.id)) continue
        // [Y1] 共享任务只向「身份与任务启动身份一致」的调用方交付。
        if (group.shareable && group.task.identity !== identity) continue
        const channel = projectWire(wire, snapshot)
        if (channel === null) continue
        resolved.set(wire.id, channel)
        // [D6-D] 只缓存**真正成功**的渠道，且只在未取消、身份未变时写入。
        if (!aborted && cacheable.has(wire.id) && isCacheable(channel)
          && group.task.identity === identity && group.task.generation === String(snapshot.generation || '')) {
          writeCache(wire.id, snapshot.generation, identity, channel)
        }
      }
      group.task.refs -= 1
      if (group.task.refs <= 0) {
        // 所有调用方都走了：停止底层请求，防止「工具已返回仍在发凭据请求」。
        group.task.progress.aborted = true
        try { group.task.controller.abort(new Error('usage_status no callers')) } catch (err) { /* 已中止 */ }
        if (tasks.get(group.task.key) === group.task) tasks.delete(group.task.key)
      }
    }
    return resolved
  }

  /** 组装最终结果：投影（含缺失/停用/不存在）+ 策略文本。 */
  function finalize(ids, resolved, snapshot) {
    const channels = []
    for (const id of ids) {
      const channel = resolved.get(id)
      if (channel !== undefined) { channels.push(channel); continue }
      const projected = projectUsage([], [id], {
        enabled: snapshot.enabled,
        known: snapshot.known,
        semanticsOf: snapshot.semanticsOf,
      })
      if (projected.channels.length > 0) channels.push(projected.channels[0])
    }
    const policy = snapshot.policy === undefined ? null : snapshot.policy
    const prompt = policy === null ? null : policyPromptWith(policy, { channels })
    return { channels, policy: prompt === null ? null : { text: prompt } }
  }

  /** 工具定义。`execute` 的返回值必须符合 `OUTPUT_SCHEMA`。 */
  const definition = {
    name: TOOL_NAME,
    description:
      '查询当前已启用渠道的用量与余额（只读）。返回结构化数值：余额/积分（含币种或积分单位）、'
      + '配额窗口百分比（percentMode 为 remaining，即剩余比例）、可用性与固定错误码。'
      + '不返回凭据、URL 或上游原文。留空 ids 查询全部已启用渠道。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderUsage(value) }]
      },
    },
    async execute(args, exec) {
      // [D6-E] deadline 从入口开始：配置读取、身份解析、取数全部计入。
      const deadline = createDeadline(budgetMs, exec === null || exec === undefined ? null : exec.signal)
      try {
        if (deadline.expired) return { channels: [], policy: null }
        const described = await awaitWithinDeadline(describe({ deadline }), deadline)
        if (!described.done || described.value === undefined || described.value === null) {
          // 配置读取本身超时/失败：不取数、不缓存，按「本次没取到」返回。
          return { channels: [], policy: null }
        }
        const snapshot = described.value
        if (onPolicySection !== null) {
          try {
            onPolicySection(snapshot.policySection === undefined ? null : snapshot.policySection)
          } catch (err) { /* 可选服务，失败不影响工具 */ }
        }
        if (deadline.expired) return { channels: [], policy: null }
        const parsed = parseToolArgs(args, snapshot.enabled)
        if (!parsed.ok) throw new Error(parsed.reason)
        // [D6-A/B] 只对**本次请求**的渠道计算凭据身份（不触碰未请求条目的凭据）。
        let scoped = snapshot
        if (identify !== null) {
          const identified = await awaitWithinDeadline(
            identify({ ids: parsed.ids, deadline, snapshot }),
            deadline,
          )
          if (identified.done && identified.value !== null && identified.value !== undefined) {
            scoped = Object.assign({}, snapshot, {
              identity: String(identified.value.identity || ''),
              cacheable: identified.value.cacheable instanceof Set
                ? identified.value.cacheable
                : new Set(identified.value.cacheable || []),
              // [Q1][F1] 采样的**逐渠道**冻结来源随请求下发：
              // 真正发送的 Key 必须与计算身份用的那份同源；未采样渠道保持缺席。
              // 内置渠道与自定义条目共用同一张逐 id 表，**两部分都必须转发**
              // （只转发 frozen 会让 custom 丢掉冻结值、退回二次解析）。
              credentials: mergeFrozenSnapshot(identified.value.snapshot),
              // Host 私有操作证明必须与冻结凭据一起贯穿；不进入 finalize 的公开白名单。
              opSeqs: identified.value.snapshot !== null && identified.value.snapshot !== undefined
                ? identified.value.snapshot.opSeqs : undefined,
              sourceEpochs: identified.value.snapshot !== null && identified.value.snapshot !== undefined
                ? identified.value.snapshot.sourceEpochs : undefined,
            })
          } else {
            // 身份不可证明 → 不读也不写缓存。
            scoped = Object.assign({}, snapshot, { identity: '', cacheable: new Set() })
          }
        }
        if (deadline.expired) return { channels: [], policy: null }
        const resolved = await resolve(parsed.ids, scoped, deadline)
        // 到期/取消且**一点数据都没拿到**：返回空，而不是给每个渠道编一个 missing。
        if (deadline.expired && resolved.size === 0) return { channels: [], policy: null }
        return finalize(parsed.ids, resolved, scoped)
      } finally {
        deadline.dispose()
      }
    },
  }

  return {
    definition,
    /** 当前启用渠道（测试/诊断用）。 */
    enabledIds: async () => {
      const deadline = createDeadline(budgetMs, null)
      try {
        const snapshot = await describe({ deadline })
        return Array.isArray(snapshot.enabled) ? snapshot.enabled : []
      } finally {
        deadline.dispose()
      }
    },
    /** 测试用：清空缓存与在途任务。 */
    clear() {
      cache.clear()
      for (const task of tasks.values()) {
        try { task.controller.abort(new Error('cleared')) } catch (err) { /* 已中止 */ }
      }
      tasks.clear()
    },
    /** 测试用：缓存条目数。 */
    cacheSize() { return cache.size },
    /** 测试用：在途任务数。 */
    inFlight() { return tasks.size },
  }
}

/**
 * 注册工具（**可选**）。
 *
 * 返回 `{ registered, dispose, reason }`：缺服务/宿主拒绝注册都不抛给插件。
 */
export function registerUsageTool(ctx, deps) {
  let tools
  try {
    tools = ctx != null && typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  } catch (err) {
    return { registered: false, dispose: null, reason: 'tools 服务读取失败' }
  }
  if (tools === undefined || tools === null) {
    return { registered: false, dispose: null, reason: '本部署没有 tools 服务' }
  }
  if (typeof tools.register !== 'function') {
    return { registered: false, dispose: null, reason: 'tools 服务没有 register 方法' }
  }
  const tool = createUsageTool(deps)
  let dispose
  try {
    dispose = tools.register(tool.definition)
  } catch (err) {
    const message = err !== null && typeof err === 'object' && typeof err.message === 'string'
      ? err.message
      : '注册失败'
    return { registered: false, dispose: null, reason: message }
  }
  return {
    registered: true,
    dispose: () => {
      // [D6-E] 卸载时清空缓存并中止在途任务，避免卸载后仍有任务回写。
      try { tool.clear() } catch (err) { /* 已清理 */ }
      if (typeof dispose === 'function') {
        try { dispose() } catch (err) { /* 已卸载 */ }
      }
    },
    tool,
  }
}

export { PARAMETERS, OUTPUT_SCHEMA }
