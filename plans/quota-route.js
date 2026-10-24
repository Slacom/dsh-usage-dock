/**
 * [额度自动感知 / §6] 本次请求的真实路由观察。
 *
 * 为什么需要它
 * ------------
 * 「当前模型用哪个供应商」不能靠 UI 名称、AgentOptions 或上一次请求的 header 猜：
 *
 *   - `assemblyContext` 只有 `{ agent, scope, signal }`，没有 provider/model；
 *   - `Agent.options` 只是 seed，UI 选择在 step 组装时才采样；
 *   - `request/header` 与 `request/context` 要到 `buildRequest` 才更新，**晚于**本次 context 刷新。
 *
 * 唯一可靠的公开观察点是 `agent/request` waterfall 的外层：`await next()` 之后能读到
 * 下游最终返回的 `{ provider, model }`，且**不修改配置**。
 *
 * 已核验事实（`@deepseek-ai/dsh-agent-loop` L1191）：
 *   `dispatch.waterfall("agent/request", { turn, step, signal }, ...)`
 * 该 dispatch 由 `agentEvents(loopCtx, this)` 创建，**agent 作用域**；但 scope 准入规则
 * 允许**祖先 scope 的监听收到后代事件**，因此只靠 scope 过滤不足以保证主体隔离。
 * [A05] 必须同时校验 `payload.agent === subject`。
 *
 * [A06] 能力闸门**默认闭合**：没有经过顺序验证前不发布任何观察（保持 normal、零规则）。
 * 宁可不给额度提示，也不能依据不确定的路由注入收尾规则。
 */

/** 已知会改写 provider/model 的连接插件（其 writer 必须先于观察器安装）。 */
const REVIEWED_WRITERS = Object.freeze(['dsh-codex-connect'])

/** 一次请求的观察记录（不可变）。 */
function makeObservation(turn, step, attempt, config) {
  return Object.freeze({
    turn,
    step,
    attempt,
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : '',
  })
}

/**
 * 创建路由观察器。
 *
 * @param {object} deps
 * @param {any} deps.ctx Host 插件 ctx（用于 `ctx.get('agents')` 与根事件订阅）
 * @param {() => boolean} deps.alive 插件是否仍激活
 * @param {(subject:any)=>boolean} [deps.reviewedChainReady] 能力闸门
 * @returns {object}
 */
export function createRouteObserver(deps) {
  const opts = deps !== null && deps !== undefined ? deps : {}
  const ctx = opts.ctx
  const alive = typeof opts.alive === 'function' ? opts.alive : () => true
  // [A06] **默认闭合**：调用方必须显式证明链路已审查，否则永不发布观察。
  let chainReady = typeof opts.reviewedChainReady === 'function'
    ? opts.reviewedChainReady
    : () => false

  /** Agent → 最近一次观察（WeakMap 天然按 Agent 隔离，主会话/子代理不串）。 */
  const observations = new WeakMap()
  /** Agent → 该 Agent 上我们装的 disposer */
  const attached = new Map()
  /** 每个 Agent 的请求序号（同 step 重试也要重新观察） */
  const attempts = new WeakMap()

  const rootDisposers = []
  let disposed = false

  function attach(subject) {
    if (disposed || subject === null || subject === undefined) return
    if (attached.has(subject)) return
    const agentCtx = subject.ctx
    if (agentCtx === null || agentCtx === undefined || typeof agentCtx.on !== 'function') return
    let dispose
    try {
      dispose = agentCtx.on('agent/request', async (payload, next) => {
        const p = payload !== null && payload !== undefined ? payload : {}
        // [A05] 精确主体守卫：scope 准入允许祖先监听收到后代事件，
        // 必须确认事件确实属于本 Agent，否则子请求会污染父观察。
        if (p.agent !== undefined && p.agent !== null && p.agent !== subject) {
          return next()
        }
        const ticket = (attempts.get(subject) || 0) + 1
        attempts.set(subject, ticket)
        // 每次尝试先把旧观察丢掉：宁可没有，也不用上一次的路由。
        observations.delete(subject)
        let config
        try {
          config = await next()
        } catch (error) {
          observations.delete(subject)
          throw error
        }
        try {
          const aborted = p.signal !== undefined && p.signal !== null && p.signal.aborted === true
          // 只有「仍是最新一次尝试」「未取消」「链路已审查」时才记录。
          if (alive() && !aborted && ticket === attempts.get(subject) && chainReady(subject)) {
            observations.set(subject, makeObservation(p.turn, p.step, ticket,
              config !== null && config !== undefined ? config : {}))
          } else {
            observations.delete(subject)
          }
        } catch {
          observations.delete(subject)
        }
        // 原样返回，不改路由、不吞下游错误。
        return config
      }, { prepend: true })
    } catch {
      return
    }
    attached.set(subject, dispose)
  }

  function detach(subject) {
    const dispose = attached.get(subject)
    if (typeof dispose === 'function') {
      try { dispose() } catch { /* 已失效 */ }
    }
    attached.delete(subject)
    observations.delete(subject)
    attempts.delete(subject)
  }

  // ---- 安装：订阅 agent/created + 给已有 Agent 补装 ----
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.on === 'function') {
      // serial 事件：回调返回 undefined，避免 truthy 返回值截断其它监听。
      const offCreated = ctx.on('agent/created', (payload) => {
        attach(payload !== null && payload !== undefined ? payload.agent : undefined)
      })
      if (typeof offCreated === 'function') rootDisposers.push(offCreated)
      const offDisposed = ctx.on('agent/disposed', (payload) => {
        detach(payload !== null && payload !== undefined ? payload.agent : undefined)
      })
      if (typeof offDisposed === 'function') rootDisposers.push(offDisposed)
    }
  } catch {
    // 没有事件总线：保持未观察（normal、零规则）。
  }

  // 补装已有 Agent（覆盖「先创建、后订阅」的竞态）。
  try {
    const agents = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents !== null && agents !== undefined && typeof agents.list === 'function') {
      const list = agents.list()
      if (Array.isArray(list)) for (const agent of list) attach(agent)
    }
  } catch {
    // 可选服务缺失：不报错，保持未观察。
  }

  return {
    /** 读取该 Agent 最近一次**已确认**的路由观察；null 表示未观察/已失效/闸门关闭。 */
    read(agent) {
      if (disposed || agent === null || agent === undefined) return null
      // [A06] 闸门关闭时即使有旧观察也不能放出去。
      if (!chainReady(agent)) return null
      const hit = observations.get(agent)
      return hit === undefined ? null : hit
    },
    /** 测试/能力闸门用：切换「链路是否已审查」。 */
    gate(value) {
      const prev = chainReady
      chainReady = typeof value === 'function' ? value : () => value === true
      if (!chainReady(undefined)) {
        // 闸门关闭时立即作废全部观察，避免旧路由继续生效。
        for (const agent of Array.from(attached.keys())) observations.delete(agent)
      }
      return prev
    },
    /** 当前闸门是否已开（供诊断/测试）。 */
    isOpen() { return chainReady(undefined) === true },
    size() { return attached.size },
    dispose() {
      disposed = true
      for (const off of rootDisposers.splice(0)) {
        try { off() } catch { /* 已失效 */ }
      }
      for (const agent of Array.from(attached.keys())) detach(agent)
    },
  }
}

/** 供能力闸门判断：审查过的 writer 名单（当前仅 Codex Connect 已核验）。 */
export function reviewedWriters() {
  return REVIEWED_WRITERS.slice()
}
