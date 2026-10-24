/**
 * [方向 6 / T3] 策略层测试：默认关闭、**无默认阈值**、按单位匹配、保守判定。
 *
 * D6-G/H 复核要求：
 *   - 未配置 / NaN / 越界阈值必须**不启用**，不能自动补 20%；
 *   - 金额阈值必须绑定币种，只与同币种的余额比较；积分永不与金额比较；
 *   - 只有显式有效配置才参与，unknown/error/stale/unlimited 不劝停。
 *
 * 用法：node tools/test-usage-policy.mjs
 */
import assert from 'node:assert/strict'
import {
  MAX_FOCUS_CHANNELS, MIN_PERCENT_THRESHOLD, MAX_PERCENT_THRESHOLD,
  quotaPolicySchemaFields, parseFocusChannels, normalizePolicyCurrency,
  normalizePercentThreshold, normalizeBalanceThreshold,
  policyOf, evaluateChannel, policyPromptFor, policyPromptWith, policySectionTextFor,
} from '../plans/usage-policy.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

function channel(over) {
  return Object.assign({
    id: 'deepseek', name: 'DeepSeek', kind: 'balance', availability: 'ok',
    errorCode: null, message: null, windows: [], balance: null, currency: 'CNY',
    unit: 'currency', unlimited: false, fetchedAt: null, stale: false,
  }, over || {})
}

function cfg(over) {
  return Object.assign({
    quotaPolicyEnabled: true,
    quotaFocusChannels: '["deepseek"]',
    quotaPercentThreshold: 20,
    quotaBalanceThreshold: 0,
    quotaBalanceCurrency: '',
  }, over || {})
}

// ===========================================================================
// S1 — schema 字段与默认值（D6-H：阈值默认 0 = 未配置）
// ===========================================================================
{
  const fields = quotaPolicySchemaFields()
  const metaOf = (field) => {
    if (field === null || field === undefined) return {}
    if (field.meta !== undefined) return field.meta
    if (field.refs !== undefined) {
      const first = Object.values(field.refs)[0]
      if (first !== undefined && first.meta !== undefined) return first.meta
    }
    return {}
  }
  check('S1a 策略字段集合（0.9.0 两档 + 绑定 + 2026-10-23 按渠道/窗口阈值）',
    Object.keys(fields).sort().join(',')
    === [
      'quotaPolicyEnabled',
      'quotaFocusChannels',
      'quotaPercentThreshold',
      'quotaBalanceThreshold',
      'quotaWarningPercentThreshold',
      'quotaClosingPercentThreshold',
      'quotaWarningBalanceThreshold',
      'quotaClosingBalanceThreshold',
      'quotaBalanceCurrency',
      'quotaWarningCreditsThreshold',
      'quotaClosingCreditsThreshold',
      // [2026-10-23 有意变更] 新增「按渠道/按窗口」两档阈值的单一 JSON 字段：
      // 订阅渠道必须按**实际窗口**独立判定（用户冻结要求），而旧全局字段全部保留、
      // 只作 legacy 回退（不删、不清零、不迁移）。
      'quotaChannelThresholds',
      'quotaRouteBindings',
      'quotaTrustRouteOrder',
    ].sort().join(','),
    Object.keys(fields).sort())
  // [额度自动感知] 两档阈值默认 0 = 未配置，绝不自动补值。
  check('S1a2 预警/收尾百分比默认 0（未配置）',
    metaOf(fields.quotaWarningPercentThreshold).default === 0
    && metaOf(fields.quotaClosingPercentThreshold).default === 0)
  check('S1a3 预警/收尾余额默认 0（未配置）',
    metaOf(fields.quotaWarningBalanceThreshold).default === 0
    && metaOf(fields.quotaClosingBalanceThreshold).default === 0)
  check('S1a4 预警/收尾积分默认 0（未配置）',
    metaOf(fields.quotaWarningCreditsThreshold).default === 0
    && metaOf(fields.quotaClosingCreditsThreshold).default === 0)
  check('S1a5 路由绑定默认空数组', metaOf(fields.quotaRouteBindings).default === '[]')
  check('S1b 默认关闭', metaOf(fields.quotaPolicyEnabled).default === false)
  check('S1c 关注渠道默认空', metaOf(fields.quotaFocusChannels).default === '[]')
  check('S1d 百分比阈值默认 0（未配置，不是 20）', metaOf(fields.quotaPercentThreshold).default === 0,
    metaOf(fields.quotaPercentThreshold))
  check('S1e 余额阈值默认 0', metaOf(fields.quotaBalanceThreshold).default === 0)
  check('S1f 余额币种默认空', metaOf(fields.quotaBalanceCurrency).default === '')
  check('S1g 全部标记 volatile', Object.keys(fields).every((k) => metaOf(fields[k]).volatile === true),
    Object.keys(fields).map((k) => [k, metaOf(fields[k]).volatile]))
}

// ===========================================================================
// S2 — 阈值归一化：只有显式有效值才算配置
// ===========================================================================
{
  check('S2a 有效百分比被接受', normalizePercentThreshold(20) === 20)
  check('S2b 100 是上界（含）', normalizePercentThreshold(100) === 100)
  check('S2c 0 视为未配置', normalizePercentThreshold(0) === null)
  check('S2d 负数视为未配置', normalizePercentThreshold(-5) === null)
  check('S2e 超过 100 视为无效', normalizePercentThreshold(101) === null)
  check('S2f NaN 视为未配置', normalizePercentThreshold(NaN) === null)
  check('S2g 字符串数字不自动转换', normalizePercentThreshold('20') === null)
  check('S2h Infinity 无效', normalizePercentThreshold(Infinity) === null)
  check('S2i 区间常量正确', MIN_PERCENT_THRESHOLD === 0 && MAX_PERCENT_THRESHOLD === 100)

  check('S2j 余额阈值正数有效', normalizeBalanceThreshold(10) === 10)
  check('S2k 余额阈值 0 无效', normalizeBalanceThreshold(0) === null)
  check('S2l 余额阈值负数无效', normalizeBalanceThreshold(-1) === null)
  check('S2m 余额阈值 NaN 无效', normalizeBalanceThreshold(NaN) === null)

  check('S2n 币种合法', normalizePolicyCurrency('cny') === 'CNY')
  check('S2o 币种空无效', normalizePolicyCurrency('') === null)
  check('S2p 币种非三位无效', normalizePolicyCurrency('RMB¥') === null)
  check('S2q 非字符串无效', normalizePolicyCurrency(42) === null)
}

// ===========================================================================
// S3 — policyOf：默认关闭 / 无默认阈值
// ===========================================================================
{
  check('S3a 未启用返回 null', policyOf(cfg({ quotaPolicyEnabled: false })) === null)
  check('S3b 缺字段返回 null', policyOf({}) === null)
  check('S3c null 配置返回 null', policyOf(null) === null)
  check('S3d 没有关注渠道返回 null', policyOf(cfg({ quotaFocusChannels: '[]' })) === null)

  // [D6-H] 核心：只启用 + 选渠道、但不填阈值 → **不得**自动补 20%。
  check('S3e 未填阈值不启用（不再默认 20%）',
    policyOf(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 0 })) === null)
  check('S3f NaN 阈值不启用',
    policyOf(cfg({ quotaPercentThreshold: NaN, quotaBalanceThreshold: NaN })) === null)
  check('S3g 越界阈值不启用',
    policyOf(cfg({ quotaPercentThreshold: 150, quotaBalanceThreshold: -3 })) === null)
  check('S3h 只有余额阈值、没有币种 → 不启用',
    policyOf(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 10, quotaBalanceCurrency: '' })) === null)
  check('S3i 只有币种、没有余额阈值 → 不启用',
    policyOf(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 0, quotaBalanceCurrency: 'CNY' })) === null)

  const p = policyOf(cfg())
  check('S3j 显式百分比阈值生效', p !== null && p.percent === 20, p)
  check('S3k 有效配置里余额判据为空', p.balance === null && p.currency === null, p)

  const money = policyOf(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 10, quotaBalanceCurrency: 'cny' }))
  check('S3l 金额判据需要币种且归一化', money !== null && money.balance === 10 && money.currency === 'CNY', money)
}

// ===========================================================================
// S4 — evaluateChannel：按单位匹配
// ===========================================================================
{
  const pct = policyOf(cfg({ quotaPercentThreshold: 20, quotaBalanceThreshold: 0 }))
  check('S4a 窗口剩余低于阈值触发',
    evaluateChannel(channel({ windows: [{ scope: 'weekly', percent: 15, percentMode: 'remaining' }] }), pct).triggered)
  check('S4b 窗口剩余高于阈值不触发',
    !evaluateChannel(channel({ windows: [{ scope: 'weekly', percent: 80, percentMode: 'remaining' }] }), pct).triggered)
  check('S4c 0% 触发', evaluateChannel(channel({ windows: [{ scope: 'w', percent: 0 }] }), pct).triggered)

  const money = policyOf(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 10, quotaBalanceCurrency: 'CNY' }))
  check('S4d 同币种余额低于阈值触发', evaluateChannel(channel({ balance: 5 }), money).triggered)
  check('S4e 同币种余额高于阈值不触发', !evaluateChannel(channel({ balance: 50 }), money).triggered)
  check('S4f 等于阈值不触发（严格小于）', !evaluateChannel(channel({ balance: 10 }), money).triggered)
  check('S4g 不同币种不比较',
    !evaluateChannel(channel({ balance: 5, currency: 'USD' }), money).triggered)
  check('S4h 币种未知不比较',
    !evaluateChannel(channel({ balance: 5, currency: null, unit: 'currency' }), money).triggered)
  check('S4i 积分不与金额比较',
    !evaluateChannel(channel({ balance: 5, currency: null, unit: 'credits', kind: 'credits' }), money).triggered)

  check('S4j error 不参与', !evaluateChannel(channel({ availability: 'error', balance: 1 }), money).triggered)
  check('S4k unknown 不参与', !evaluateChannel(channel({ availability: 'unknown', balance: 1 }), money).triggered)
  check('S4l unavailable 不参与', !evaluateChannel(channel({ availability: 'unavailable', balance: 1 }), money).triggered)
  check('S4m unlimited 不参与',
    !evaluateChannel(channel({ availability: 'unlimited', unlimited: true, balance: 1 }), money).triggered)
  check('S4n stale 不参与', !evaluateChannel(channel({ stale: true, balance: 1 }), money).triggered)
  check('S4o null 策略不触发', !evaluateChannel(channel({ balance: 1 }), null).triggered)
  check('S4p null 渠道不触发', !evaluateChannel(null, money).triggered)
  check('S4q 非法 percent 不参与',
    !evaluateChannel(channel({ windows: [{ scope: 'w', percent: null }] }), pct).triggered)
}

// ===========================================================================
// S5 — 提示词
// ===========================================================================
{
  const ok = { channels: [channel({ balance: 100 })] }
  check('S5a 未触发返回 null', policyPromptFor(cfg(), ok) === null)
  check('S5b 未启用返回 null',
    policyPromptFor(cfg({ quotaPolicyEnabled: false }), { channels: [channel({ balance: 1 })] }) === null)
  check('S5c 空结果返回 null', policyPromptFor(cfg(), { channels: [] }) === null)
  check('S5d 未配阈值返回 null',
    policyPromptFor(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 0 }), { channels: [channel({ balance: 1 })] }) === null)

  const moneyCfg = cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 10, quotaBalanceCurrency: 'CNY' })
  const text = policyPromptFor(moneyCfg, { channels: [channel({ balance: 3 })] })
  check('S5e 触发时给出提示', typeof text === 'string' && text.includes('DeepSeek'), text)
  check('S5f 含具体数值与币种', text.includes('3') && text.includes('CNY'), text)
  check('S5g 明确不构成强制停工', text.includes('不构成强制停工'), text)
  check('S5h 含收尾步骤', text.includes('检查变更') && text.includes('保存进度'), text)
  check('S5i 无硬性措辞', !/必须停工|立即停止|强制终止/.test(text), text)
  check('S5j 无重启/切模型建议', !/重启|切换模型|杀进程/.test(text), text)

  check('S5k policyPromptWith 可直接用策略对象', typeof policyPromptWith(policyOf(moneyCfg), { channels: [channel({ balance: 3 })] }) === 'string')
}

// ===========================================================================
// S6 — 只提示显式关注的渠道
// ===========================================================================
{
  const both = {
    channels: [
      channel({ id: 'deepseek', name: 'DeepSeek', balance: 1 }),
      channel({ id: 'codex', name: 'Codex', windows: [{ scope: 'weekly', percent: 5 }], unit: null }),
    ],
  }
  const onlyDs = policyPromptFor(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 10, quotaBalanceCurrency: 'CNY' }), both)
  check('S6a 只提示关注渠道', onlyDs.includes('DeepSeek') && !onlyDs.includes('Codex'), onlyDs)

  const onlyCodex = policyPromptFor(cfg({ quotaFocusChannels: '["codex"]', quotaPercentThreshold: 20, quotaBalanceThreshold: 0 }), both)
  check('S6b 换渠道只提示它', onlyCodex.includes('Codex') && !onlyCodex.includes('DeepSeek'), onlyCodex)

  check('S6c 关注渠道不在结果里时不提示',
    policyPromptFor(cfg({ quotaFocusChannels: '["mimo"]' }), both) === null)
}

// ===========================================================================
// S7 — D6-G：系统提示词段落只在策略生效时产生
// ===========================================================================
{
  check('S7a 未启用时无段落', policySectionTextFor(cfg({ quotaPolicyEnabled: false })) === null)
  check('S7b 未配阈值时无段落',
    policySectionTextFor(cfg({ quotaPercentThreshold: 0, quotaBalanceThreshold: 0 })) === null)
  check('S7c 无关注渠道时无段落', policySectionTextFor(cfg({ quotaFocusChannels: '[]' })) === null)

  const text = policySectionTextFor(cfg({ quotaPercentThreshold: 25, quotaFocusChannels: '["codex"]' }))
  check('S7d 生效时产生段落', typeof text === 'string' && text.length > 0, text)
  check('S7e 段落含关注渠道', text.includes('codex'), text)
  check('S7f 段落含阈值', text.includes('25'), text)
  check('S7g 段落说明 policy 字段', text.includes('usage_status') && text.includes('policy'), text)
  check('S7h 段落不含实时数值噪声', !/\d{4}-\d{2}-\d{2}/.test(text), text)
  check('S7i 段落不授权停机', text.includes('不构成强制停工'), text)

  const moneyText = policySectionTextFor(cfg({
    quotaPercentThreshold: 0, quotaBalanceThreshold: 10, quotaBalanceCurrency: 'USD',
  }))
  check('S7j 金额段落含币种', moneyText.includes('USD'), moneyText)
}

// ===========================================================================
// S8 — 关注渠道解析
// ===========================================================================
{
  check('S8a 解析 JSON 数组', parseFocusChannels('["a","b"]').join(',') === 'a,b')
  check('S8b 直接接受数组', parseFocusChannels(['a', 'b']).join(',') === 'a,b')
  check('S8c 坏 JSON 安全退化', parseFocusChannels('[bad').length === 0)
  check('S8d 非数组 JSON 退化', parseFocusChannels('{"a":1}').length === 0)
  check('S8e null 返回空', parseFocusChannels(null).length === 0)
  check('S8f 非字符串项被过滤', parseFocusChannels('["a",1,null,"b"]').join(',') === 'a,b')
  check('S8g 去重保序', parseFocusChannels('["b","a","b"]').join(',') === 'b,a')
  check('S8h 有上限',
    parseFocusChannels(JSON.stringify(new Array(50).fill('x').map((_, i) => 'c' + i))).length === MAX_FOCUS_CHANNELS)
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
