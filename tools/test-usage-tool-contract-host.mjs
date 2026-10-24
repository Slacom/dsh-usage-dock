/**
 * [方向 6 / 真机回归] 工具定义必须能被**真实宿主**接受。
 *
 * 背景（0.9.0 真机故障，2026-10-19 发现）：
 *   `plans/usage-tool-register.js` 的 `OUTPUT_SCHEMA` 曾用 `type: ['number','null']`
 *   这类 type 数组。宿主的 `assertSupportedJsonSchema` 只接受**单一** `type` 字符串，
 *   于是 `tools.register(def)` 抛 `JsonSchemaError`；我们的 `registerUsageTool` 把它
 *   catch 成 `registered:false`，`usage_status` 就**静默消失**了——GUI 胶囊和
 *   `/api/plan-usage` 路由全都正常，只有模型看不到工具。
 *
 * 这个文件用宿主真实校验器（`tools/host-json-schema.mjs`）守住这条边界：
 *   1. 参数与输出 schema 必须通过校验；
 *   2. 走真实 `apply` + 真实校验器时注册必须发生；
 *   3. `execute` 的返回值（含 null 字段）必须符合输出 schema。
 *
 * 用法：node tools/test-usage-tool-contract-host.mjs
 */
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from './host-json-schema.mjs'
import { apply, Config } from '../index.js'
import { PARAMETERS, OUTPUT_SCHEMA } from '../plans/usage-tool-register.js'
import { TOOL_NAME } from '../plans/usage-tool.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('[PASS] ' + name) }
  else { failCount++; console.log('[FAIL] ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')) }
}

// ===========================================================================
// K1 — schema 本身必须被宿主接受
// ===========================================================================
for (const [label, schema] of [['参数 schema', PARAMETERS], ['输出 schema', OUTPUT_SCHEMA]]) {
  try {
    assertSupportedJsonSchema(schema)
    check('K1a ' + label + ' 通过宿主真实校验', true)
  } catch (err) {
    check('K1a ' + label + ' 通过宿主真实校验', false, String(err && err.message).slice(0, 400))
  }
}

// ===========================================================================
// K1b — 不允许出现 type 数组（这条专门防回归）
// ===========================================================================
{
  const offenders = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    if (Array.isArray(node.type)) offenders.push(path + '.type')
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, path + '.properties.' + k)
    if (node.items) walk(node.items, path + '.items')
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((v, i) => walk(v, path + '.oneOf[' + i + ']'))
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, path + '.additionalProperties')
    }
  }
  walk(OUTPUT_SCHEMA, 'output')
  walk(PARAMETERS, 'parameters')
  check('K1b 没有宿主不支持的 type 数组', offenders.length === 0, offenders)
}

// ===========================================================================
// K2 — 真实 apply：注册必须发生（假 tools 服务里接入宿主同一套校验）
// ===========================================================================
const registered = []
{
  let def = null
  const services = {
    webServer: { port: 0, register() { return () => {} } },
    tools: {
      register(candidate) {
        // 与宿主 `register()` 的校验顺序一致：先 output 形状，再 schema。
        assert.equal(typeof candidate.output.render, 'function')
        assertSupportedJsonSchema(candidate.output.schema)
        registered.push(candidate.name)
        def = candidate
        return () => {}
      },
    },
  }
  const ctx = {
    webServer: services.webServer,
    get: (n) => (Object.prototype.hasOwnProperty.call(services, n) ? services[n] : undefined),
    on() {}, off() {}, emit() {}, effect: (fn) => fn(),
  }
  let threw = null
  try {
    apply(ctx, new Config({}))
  } catch (err) {
    threw = err
  }
  await new Promise((r) => setTimeout(r, 120))
  check('K2a apply 不抛错（schema 不合规会在这里炸）', threw === null, threw && threw.message)
  check('K2b 工具确实被注册', registered.length === 1 && registered[0] === TOOL_NAME, registered)
  check('K2c 注册到的名字是 usage_status', def !== null && def.name === 'usage_status', def && def.name)

  // =========================================================================
  // K3 — execute 返回值必须符合输出 schema（null 字段也不例外）
  // =========================================================================
  if (def !== null) {
    const cases = [
      { label: '退场渠道（数值全 null）', args: { ids: ['kimi-code'] } },
      { label: '未知渠道（参数错误）', args: { ids: ['no-such-channel'] } },
      { label: '空 ids', args: {} },
    ]
    for (const item of cases) {
      let value = null
      let error = null
      try {
        value = await def.execute(item.args)
      } catch (err) {
        error = err
      }
      if (item.label.indexOf('未知') !== -1) {
        check('K3 ' + item.label + ' 抛出参数错误', error !== null, error === null ? value : undefined)
        continue
      }
      const violations = value === null ? ['no value'] : validateJsonSchemaValue(OUTPUT_SCHEMA, value, 'output')
      check('K3 ' + item.label + ' 的输出符合 schema', violations.length === 0,
        violations.length === 0 ? undefined : violations.slice(0, 6))
    }
  }
}

console.log('\n' + (passCount + failCount) + ' 项：' + passCount + ' 通过, ' + failCount + ' 失败')
process.exit(failCount === 0 ? 0 : 1)
