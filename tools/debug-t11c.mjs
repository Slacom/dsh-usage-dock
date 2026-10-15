/** 临时调试：T11c 少量明细时 scrollers 从哪来。跑完即删。 */
import { createRuntime, loadClient, textOf, API_PAYLOAD } from './mock-react.mjs'

const runtime = createRuntime()
const client = loadClient(runtime, { payload: API_PAYLOAD })
const Badge = client.Badge
const WIDE = { configForm: null, wide: true }

function elementsOf(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || depth > 8) return out
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(n, out, depth)); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'string') {
      out.push(node)
      elementsOf(node.props ? node.props.children : undefined, out, depth + 1)
    } else if (typeof node.type === 'function') {
      try { elementsOf(node.type(node.props), out, depth + 1) } catch {}
    }
  }
  return out
}

const few = {
  ok: true,
  data: {
    plans: [{
      id: 'workbuddy', name: 'WorkBuddy', creditsTotal: 3401.5, creditsUnlimited: false,
      creditsAccounts: [{ variant: 'WorkBuddy', packageName: '企业额度', remain: 3401.5, size: null, endTimeMs: null }],
      variants: [{ label: 'WorkBuddy', total: 3401.5, unlimited: false }],
      isAvailable: true,
    }],
  },
}
globalThis.fetch = async () => ({ json: async () => few })
runtime.mount(Badge, WIDE)
let tree = await runtime.settle(WIDE)
const pill = tree.props.children[0]
pill.props.onClick()
tree = await runtime.settle(WIDE)
const els = elementsOf(tree)
const scrollers = els.filter((el) => el.props && el.props.style && el.props.style.overflowY === 'auto')
for (const s of scrollers) {
  console.log('scroller type=' + s.type + ' class=' + (s.props.className || '') + ' maxHeight=' + s.props.style.maxHeight)
  console.log('  text:', textOf(s).slice(0, 80))
}
client.restore()
