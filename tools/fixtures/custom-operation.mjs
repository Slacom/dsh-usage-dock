/** Offline public-service fixture for the real apply() implementation; no profile or real credentials. */
import { setImmediate as flush } from 'node:timers/promises'
import { apply } from '../../index.js'
import { PLANS } from '../../plans/index.js'

export const A = 'SYNTHETIC_OPERATION_A'
export const B = 'SYNTHETIC_OPERATION_B'
export const cid = 'custom:provider1'
export const entry = { id: cid, provider: 'alpha', name: 'Audit quota', enabled: true, balanceEndpoint: '/balance', balancePath: 'balance', currency: 'CNY' }
export const baseProviders = {
  alpha: { baseURL: 'https://alpha.audit.invalid/v1', apiKeyEnv: 'A_REF' },
  beta: { baseURL: 'https://beta.audit.invalid/v1', apiKeyEnv: 'B_REF' },
}
export const modelRow = providers => ({ entry: { id: 'llm-pi-ai', options: { id: 'llm-pi-ai', config: { providers } } }, override: { providers }, inherited: {} })
export const catalog = Object.entries(baseProviders).map(([provider, config]) => ({ provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], defaultBaseURL: config.baseURL }))
const disabled = Object.fromEntries(PLANS.map(plan => [plan.fields.enabled, false]))
const defaults = {
  enabled: true, ...disabled, customBalances: [entry], quotaPolicyEnabled: true,
  quotaFocusChannels: JSON.stringify([cid]), quotaRouteBindings: JSON.stringify([{ provider: 'audit-model', channelId: cid }]),
  quotaTrustRouteOrder: true, quotaWarningBalanceThreshold: 10, quotaClosingBalanceThreshold: 5, quotaBalanceCurrency: 'CNY',
}

export async function boot(extra = {}, options = {}) {
  let config = { ...defaults, ...extra }
  let rows = options.rows || [modelRow(baseProviders)]
  const hooks = [], events = new Map(), routes = new Map(), contexts = new Map(), tools = new Map(), effects = [], credentialRefs = []
  const agent = { id: 'audit', session: { id: 'audit' }, ctx: { on(name, listener, opts) {
    if (name === 'agent/request') opts?.prepend ? hooks.unshift(listener) : hooks.push(listener)
    return () => { const index = hooks.indexOf(listener); if (index >= 0) hooks.splice(index, 1) }
  } } }
  const services = {
    agents: { list: () => [agent] },
    configEditor: { configuration: () => [{ entry: { options: { id: 'plan-usage' } }, override: config }, ...rows] },
    credentials: { resolve: async ref => { credentialRefs.push(ref); return options.resolve ? options.resolve(ref, credentialRefs.length) : { value: ref === 'B_REF' ? B : A } } },
    llm: { listProviders: () => [], listConfigurableProviders: () => options.catalog || catalog },
    systemPrompt: { context(spec) { contexts.set(spec.name, spec); return () => contexts.delete(spec.name) } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    webServer: { port: 12345, register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } },
  }
  const ctx = {
    get: name => services[name], webServer: services.webServer,
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
    on(name, listener) { const list = events.get(name) || []; list.push(listener); events.set(name, list); return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1) } },
    off(name, listener) { const list = events.get(name) || []; const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1) },
  }
  apply(ctx, config)
  await flush()
  let index = 0
  const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal }
  const next = () => index < hooks.length ? hooks[index++](payload, next) : Promise.resolve({ provider: 'audit-model', model: 'ordinary' })
  await next()
  const changed = async () => { for (const listener of events.get('app-boot/config-reload') || []) listener(); await flush() }
  const call = async path => {
    let body
    await routes.get(path)({ method: 'GET' }, { writeHead() {}, end(text) { body = JSON.parse(text) } })
    return body
  }
  return {
    ctx, call, get credentialRefs() { return [...credentialRefs] },
    text: () => contexts.get('dsh-usage-dock.quota').text({ agent, scope: agent }),
    gui: () => call('/api/plan-usage'),
    execute: (ids, signal) => tools.get('usage_status').execute({ ids }, { signal: signal || new AbortController().signal }),
    async update(patch) { config = { ...config, ...patch }; await changed() },
    async updateRows(nextRows) { rows = nextRows; await changed() },
    close() { for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose() },
  }
}
