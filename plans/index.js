/**
 * 套餐注册表：接入一个新套餐 = 在 plans/ 下新增一个模块（默认导出统一的
 * plan 对象：{ id, name, fields, schema, source, fetch }，见 plans/opencode-go.js
 * 头注释），然后在这里登记。index.js 的路由与配置读写全部经由此表驱动，
 * 不需要改动任何路由代码。
 *
 * [0.9.0] 渠道退场：`kimi-code` / `glm-zhipu` / `glm-zai` 已从活动注册表移除。
 *   - 胶囊、详情卡片、设置页、排序候选都随之消失（客户端另有一份 PLANS 表，必须同步）；
 *   - Host 不再为它们取数（注册表是唯一的取数来源）；
 *   - **不删除**共享模型凭据，也不清理 profile：旧配置里的 `glmEnabled` /
 *     `glmZhipuEnabled` / `kimiCodeEnabled` / `kimiApiKey` 等键作为普通未知键保留
 *     （schemastery 解析会原样带过），只是不再有人读它们；
 *   - 旧 `planOrder` 里的这三个 id 被排序逻辑自然忽略（不在活动清单里就没有胶囊行）。
 *   `plans/kimi-code.js`、`plans/glm.js`、`plans/glm-zai.js`、`plans/glm-zhipu.js`
 *   作为历史维护资料保留在仓库里，但**不再被 import**（也就不再进入运行时）。
 *   Kimi 的口径 / ratio-pool / Cookie 月限问题按用户决定**不修**。
 */
import opencodeGo from './opencode-go.js'
import deepseek from './deepseek.js'
import codex from './codex.js'
import mimo from './mimo.js'
import workbuddy from './workbuddy.js'

/**
 * 已接入的套餐（渠道）：id 同时用作配置键名与 wire 标识。
 * [0.8.3] WorkBuddy 拆成两个独立渠道：国内版（workbuddy）与国际版（workbuddy-ai）
 * ——两者积分不通用，且需要各自开关与排序（用户 2026-10-17 要求）。
 * [0.9.0] 三个退场渠道（kimi-code / glm-zhipu / glm-zai）已从此表移除。
 */
/**
 * [2026-10-21] workbuddy-ai 已退场：用户确认全部改走国内 WorkBuddy2API 网关，
 * 不再区分国际版；其 id 进入 RETIRED_PLAN_IDS，旧配置里的引用会被安全忽略，
 * 且**不会**再被取数或渲染。
 */
export const PLANS = [opencodeGo, deepseek, codex, mimo, workbuddy]

/** id → plan 的索引（配置读写路由校验未知套餐用）。 */
export const PLAN_BY_ID = Object.fromEntries(PLANS.map((plan) => [plan.id, plan]))

/**
 * [0.9.0] 已退场的内置渠道 id（历史值，只用于「显式请求要能识别成退场」与旧配置迁移）。
 *
 * 它们不在 `PLANS` 里，因此不会被取数、不会出现在胶囊/设置/排序里。
 * 未来方向 6 的模型工具若收到这些 id，应当返回受控的 `unknown` + `retired-channel`，
 * 而不是当成未知参数错误，更不能复活为可查询渠道。这条契约在当前版本**没有**
 * 工具实现（方向 6 仍是规划），仅作为注册表事实保留，避免将来重新猜一遍。
 */
export const RETIRED_PLAN_IDS = ['kimi-code', 'glm-zhipu', 'glm-zai', 'workbuddy-ai']

/** 某 id 是否为已退场的活动渠道（供未来工具层/迁移逻辑复用）。 */
export function isRetiredPlanId(id) {
  return RETIRED_PLAN_IDS.indexOf(id) !== -1
}

/**
 * [D6-C] 各渠道 wire 上 `percent` 的**真实语义**。
 *
 * 复核发现工具曾把两者都当成「剩余」：
 *   - `codex` 的 wire 本来就是**剩余**比例（`remainingPercent`）；
 *   - `opencode-go` 的 wire 是**已用**比例（`usagePercent`），说成「剩余 90%」是错的。
 *
 * 客户端 `client.js` 自己有一张同名表（无法 import 本文件），两边必须保持一致：
 * 只有 codex 是 `remaining`，其余一律 `used`。
 * 未来接入新渠道时必须先核实语义，**不要**为了「都能显示」而猜。
 */
const PLAN_PERCENT_SEMANTICS = { codex: 'remaining' }

/** 返回 'remaining' | 'used'；未知渠道按 'used'（保守：不假设剩余）。 */
export function percentSemanticsOf(id) {
  return PLAN_PERCENT_SEMANTICS[id] === 'remaining' ? 'remaining' : 'used'
}

/**
 * 所有渠道 schema 字段的并集：index.js 据此组装插件的 Config 对象。
 *
 * 这里给每个字段统一补上 `.volatile()`——DSH 的设置表单**只展示 volatile 字段**
 * （见 @deepseek-ai/dsh-settings 文档），没有它插件不会出现设置页。
 * 各渠道模块因此无需自行声明 volatile。
 */
export function planSchemaFields() {
  const fields = {}
  for (const plan of PLANS) {
    for (const key of Object.keys(plan.schema)) {
      const field = plan.schema[key]
      fields[key] = field != null && typeof field.volatile === 'function' ? field.volatile() : field
    }
  }
  return fields
}
