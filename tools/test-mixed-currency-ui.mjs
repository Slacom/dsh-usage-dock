/**
 * 浏览器半回归测试（Z4）：DeepSeek 多币种余额的呈现。
 *
 * 背景（第三轮复核的非阻塞建议）：Y4 之后混币返回 `balance: null` + `mixedCurrency: true`，
 * 但胶囊把 null 一律叫「获取失败」——数据其实已经拿到了，这是错误归因；详情里
 * 现金/赠金明细也被一起隐藏。要求：说明「币种不同、无法合计」，只展示单位可证的明细，
 * **绝不**为了恢复显示而重新跨币求和，也不能回退正常单币的展示。
 *
 * 用法：node tools/test-mixed-currency-ui.mjs
 */
import assert from 'node:assert/strict'
import { createRuntime, loadClient, textOf } from './mock-react.mjs'
import deepseek from '../plans/deepseek.js'

const results = []
function record(name, status, note) {
  results.push({ name, status })
  console.log('[' + status + '] ' + name + (note ? ' — ' + note : ''))
}

/** 两个钱包币种不同的 DeepSeek（真实 provider 会给出同样的字段）。 */
const MIXED_PAYLOAD = {
  ok: true,
  data: {
    plans: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        balance: null,
        currency: null,
        mixedCurrency: true,
        cashBalance: 10,
        cashCurrency: 'CNY',
        bonusBalance: 2,
        bonusCurrency: 'USD',
        isAvailable: true,
        via: 'account',
        warnThreshold: 10,
      },
    ],
  },
}

/** 单币种（旧行为，必须保持不变）。 */
const SINGLE_PAYLOAD = {
  ok: true,
  data: {
    plans: [
      {
        id: 'deepseek', name: 'DeepSeek', balance: 12, currency: 'CNY',
        cashBalance: 10, cashCurrency: 'CNY', bonusBalance: 2, bonusCurrency: 'CNY',
        isAvailable: true, via: 'account', warnThreshold: 10,
      },
    ],
  },
}

/** 赠金币种未知：不得套用 CNY 符号。 */
const UNKNOWN_UNIT_PAYLOAD = {
  ok: true,
  data: {
    plans: [
      {
        id: 'deepseek', name: 'DeepSeek', balance: null, currency: null, mixedCurrency: true,
        cashBalance: 10, cashCurrency: 'CNY', bonusBalance: 2, bonusCurrency: null,
        isAvailable: true, via: 'account', warnThreshold: 10,
      },
    ],
  },
}

async function render(payload) {
  const runtime = createRuntime()
  const client = loadClient(runtime, { payload })
  const Badge = client.Badge
  assert.ok(Badge, '未能从 apply(ctx) 取到胶囊组件')
  runtime.mount(Badge, { wide: true, configForm: null })
  const tree = await runtime.settle({ wide: true, configForm: null })
  const pill = tree.props.children[0]
  pill.props.onClick()
  const opened = await runtime.settle({ wide: true, configForm: null })
  return { pillText: textOf(pill), panelText: textOf(opened.props.children[1]) }
}

// ---------------------------------------------------------------------------
// Z4a — 混币：胶囊不叫「获取失败」，而是明确「多币种」
// ---------------------------------------------------------------------------
{
  try {
    const { pillText } = await render(MIXED_PAYLOAD)
    assert.match(pillText, /DeepSeek/, '胶囊仍要显示渠道名')
    assert.match(pillText, /多币种/, '混币应显示「多币种」')
    assert.doesNotMatch(pillText, /获取失败/, '数据已拿到，不得归因为获取失败')
    assert.doesNotMatch(pillText, /¥|CNY|USD/, '胶囊不得编造单一币种总额')
    record('Z4a 混币胶囊显示「多币种」，不再叫获取失败', 'PASS')
  } catch (err) {
    record('Z4a 混币胶囊显示「多币种」', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// Z4b — 混币详情：说明无法合计，并列出单位可证的明细
// ---------------------------------------------------------------------------
{
  try {
    const { panelText } = await render(MIXED_PAYLOAD)
    assert.match(panelText, /不同币种|无法合计/, '详情应说明币种不同/无法合计')
    assert.doesNotMatch(panelText, /余额获取失败/, '不得把混币说成获取失败')
    assert.match(panelText, /CNY\s*10(\.0+)?/, '应展示 CNY 10 的明细')
    assert.match(panelText, /USD\s*2(\.0+)?/, '应展示 USD 2 的明细')
    assert.doesNotMatch(panelText, /¥\s*12|总余额/, '不得编造跨币总额')
    record('Z4b 混币详情给出明细与「无法合计」说明', 'PASS')
  } catch (err) {
    record('Z4b 混币详情说明与明细', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// Z4c — 币种未知：只给数字并注明，不套用另一笔的符号
// ---------------------------------------------------------------------------
{
  try {
    const { panelText } = await render(UNKNOWN_UNIT_PAYLOAD)
    assert.match(panelText, /CNY\s*10(\.0+)?/, '可证的一笔照常带币种')
    assert.match(panelText, /币种未知/, '未知币种要明确说明')
    assert.doesNotMatch(panelText, /¥\s*2|CNY\s*2/, '未知单位不得被当成 CNY')
    record('Z4c 未知币种标注「币种未知」，不冒充 CNY', 'PASS')
  } catch (err) {
    record('Z4c 未知币种标注', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// Z4d — 单币种行为不回退
// ---------------------------------------------------------------------------
{
  try {
    const { pillText, panelText } = await render(SINGLE_PAYLOAD)
    assert.match(pillText, /12/, '单币种仍显示合计金额')
    assert.doesNotMatch(pillText, /多币种/, '单币种不得出现多币种文案')
    assert.match(panelText, /充值余额/, '单币种仍显示明细')
    assert.match(panelText, /赠金余额/)
    record('Z4d 单币种合计与明细保持不变', 'PASS')
  } catch (err) {
    record('Z4d 单币种行为', 'FAIL', err.message)
  }
}

// ---------------------------------------------------------------------------
// Z4e — 真实 provider 会给出逐钱包币种（UI 才可能「只展示单位可证的明细」）
// ---------------------------------------------------------------------------
{
  try {
    const account = {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: 10 }],
        bonusWallets: [{ currency: 'USD', balance: 2 }],
      }),
    }
    const wire = await deepseek.fetch({ get: (name) => (name === 'deepseekAccount' ? account : undefined) },
      undefined, { deepseekEnabled: true }, {})
    assert.equal(wire.mixedCurrency, true, '混币应标记 mixedCurrency')
    assert.equal(wire.balance, null, '混币不得给出跨币总额')
    assert.equal(wire.cashCurrency, 'CNY', '应带充值钱包币种')
    assert.equal(wire.bonusCurrency, 'USD', '应带赠金钱包币种')
    record('Z4e provider 回传逐钱包币种且不编造总额', 'PASS')
  } catch (err) {
    record('Z4e provider 逐钱包币种', 'FAIL', err.message)
  }
}
const failed = results.filter((r) => r.status === 'FAIL')
console.log('\n' + results.length + ' 项：' + (results.length - failed.length) + ' 通过, ' + failed.length + ' 失败')
process.exit(failed.length === 0 ? 0 : 1)
