# 小米 MiMo：API Key 直接查余额（2026-11-18 确认）

> 状态：**接口已确认可用**，CC Switch 侧已验证能显示余额。插件侧改造排入 **0.11.2**，
> 与 DSH Go 的「Codex Subscription 适配按钮」一起发布。

## 官方接口（已核对文档 + 实测）

- 文档：<https://mimo.mi.com/docs/zh-CN/api/asset/balance-get>（新一代文档站，旧站
  `platform.xiaomimimo.com/docs` 里没有此接口）
- 请求：`GET https://api.xiaomimimo.com/v1/platform/balance`
- 鉴权（二选一，文档要求**普通 API Key**，`sk-` 开头）：
  - `api-key: <key>`
  - `Authorization: Bearer <key>`
- 响应（文档示例）：

```json
{
  "object": "balance",
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "cash_balance": "100.50",
      "gift_balance": "20.00",
      "frozen_balance": "0.00",
      "credit_limit": "500.00",
      "credit_available": "380.00",
      "total_available": "500.50"
    }
  ]
}
```

- `total_available` = 现金 + 赠金 + 可用授信（冻结已加回）；`is_available` 在
  `total_available - frozen_balance > 0` 时为 `true`。
- **实测（2026-11-18，无 key / 假 key）**：`401 {"error":{"message":"Invalid API key.",
  "type":"invalid_request_error","code":"invalid_api_key"}}` —— 端点存在且两种请求头都能识别。
  旧路径 `/v1/balance` 为 404，已废弃。
- 同组接口（后续可扩展）：`/api/asset/credits-get`（查询套餐余量）、
  `/api/asset/consumption-get`（查询日用量）、`/api/asset/daily-bill-get`（查询日账单）。

## CC Switch 里的可用配置（用户已验证显示余额）

CC Switch 把「提取器代码」交给 **QuickJS `eval`** 执行（`src-tauri/src/usage_script.rs` →
`ctx.eval(script)`，失败报「解析配置失败」），所以有两个硬约束：

1. **整段必须是表达式**：裸的 `{ ... }` 会被当成代码块导致语法错误，必须用 `(...)` 或 IIFE 包起来；
2. **占位符大小写**：源码只替换 `{{apiKey}}` / `{{baseUrl}}`，而界面默认模板显示的是
   `{{apikey}}` / `{{baseurl}}`，版本间可能不同 → 脚本里做兼容回落。

可用版本（API Key 填普通 `sk-` key，请求地址留空）：

```js
(function () {
  var key = "{{apiKey}}";
  if (key.indexOf("{{") === 0) key = "{{apikey}}";
  return {
    request: {
      url: "https://api.xiaomimimo.com/v1/platform/balance",
      method: "GET",
      headers: { "api-key": key, "User-Agent": "cc-switch/1.0" }
    },
    extractor: function (response) {
      var info = (response && response.balance_infos && response.balance_infos[0]) || {};
      var total = Number(info.total_available);
      var cash = Number(info.cash_balance);
      var gift = Number(info.gift_balance);
      if (!isFinite(total)) total = (isFinite(cash) ? cash : 0) + (isFinite(gift) ? gift : 0);
      return {
        isValid: !!(response && response.object === "balance"),
        remaining: total,
        unit: info.currency || "CNY"
      };
    }
  };
})()
```

说明：`remaining` 取 `total_available`；若只想看「现金 + 赠金」改用 `cash + gift`。
`isValid` 用 `object === "balance"`（0 元也是合法状态）；想「余额为 0 即标红」可改用
`response.is_available === true`。

## 插件侧改造计划（0.11.2）

现状：MiMo 走控制台 Cookie（扫码 → 4 个 cookie 交 `ctx.credentials` → 重启重放
`platform.xiaomimimo.com/api/v1/balance`），是最脆弱的一条链。

计划：

1. `plans/mimo.js` 增加 API Key 通道：新增配置字段 `mimoApiKey`（`role('secret')`），
   走原生 fetch 调 `GET https://api.xiaomimimo.com/v1/platform/balance`；
   错误分类：401/403 → 鉴权失败（永久，立即提示）；5xx/网络/结构 → 暂时失败（沿用阈值 8）。
2. 身份指纹：MiMo 观察身份加入 `key=`（与 WorkBuddy/DeepSeek 的 `key=` 同构），
   换 Key 立即作废旧值与在途请求；`ACCOUNT_BOUND_PLAN_IDS` 已含 `mimo`（不进 30 秒缓存）。
3. 显示与工具同源：胶囊 / 详情 / `usage_status` / 额度策略 / `composer.strip` 全部读同一份投影；
   旧的扫码快照通道保留为**回退**（没有 Key 时仍可用），或按用户决定直接退役。
4. 设置页：Web 设置页 MiMo 分组加「API Key」输入（不回填）+「使用 API Key（推荐）」开关；
   原生设置页按既有约定不放密钥字段。
5. 测试：新增 `tools/test-mimo-api-key.mjs`（200 / 401 / 403 / 5xx / 结构异常 / 无 Key / 身份隔离），
   扩展 `test-mimo-parse` 与 `test-dsh-go-*` 的相关断言。

## 待用户决定

- 余额显示口径：`total_available`（含可用授信）还是 `cash_balance + gift_balance`？
- 扫码登录（Cookie）通道：保留为回退，还是 0.11.2 直接退役？
- 套餐余量（`credits-get`）与日用量是否进详情卡片（本次可不做）。

## 节奏

0.11.2 = **本项（MiMo API Key 余额）** + **DSH Go 的 Codex Subscription 适配按钮**，
两者齐了再一起构建、测试、发布。
