/**
 * 0.9.0 / T0 证据探针：用 fixture 跑**当前** Kimi parser，记录真实行为。
 * 不改产品代码，只读。用法：node tools/probe-kimi-0.9.0.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fxDir = join(here, 'fixtures', 'kimi-usages')

// 用 fetchPlan + stub fetch 观察 wire 结果（parser 未导出纯函数，这是当前唯一入口）
const { default: kimi } = await import('../plans/kimi-code.js')

const realFetch = globalThis.fetch
let payload = null
// util.js 的 fetch 后端读的是 res.text()（内部再 JSON.parse），不是 res.json()。
globalThis.fetch = async () => ({
  status: 200,
  ok: true,
  text: async () => JSON.stringify(payload),
})

/** 把一个 fixture 对象塞进 fetchPlan，返回 wire 里与窗口相关的字段。 */
async function wireOf(obj) {
  payload = obj
  const out = await kimi.fetch(
    { get: () => undefined }, // 无 shell：走原生 fetch 后端
    undefined,
    { kimiCodeApiKey: 'sk-kimi-probe' },
  )
  const pick = (w) => (w == null ? null : { percent: w.percent, resetsAt: w.resetsAt })
  return {
    error: out.error,
    rolling: pick(out.rollingUsage),
    weekly: pick(out.weeklyUsage),
    monthly: pick(out.monthlyUsage),
  }
}

const one = (file) => JSON.parse(readFileSync(join(fxDir, file), 'utf8'))

console.log('=== 当前 parser 对脱敏 fixture 的行为 ===\n')

for (const f of readdirSync(fxDir).filter((n) => n.endsWith('.json'))) {
  if (f === 'broken.json') continue
  console.log('[' + f + ']')
  console.log('  ' + JSON.stringify(await wireOf(one(f))))
  console.log('')
}

console.log('[broken.json 各变体]')
const broken = one('broken.json').variants
for (const [name, obj] of Object.entries(broken)) {
  const w = await wireOf(obj)
  console.log('  ' + name.padEnd(24) + JSON.stringify(w))
}

globalThis.fetch = realFetch
