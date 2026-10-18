# dsh-usage-dock v0.8.5

> 0.8.4 已正式发布（GitHub Release + npm）。本版解决「胶囊里 WorkBuddy / WorkBuddy AI 经常
> 直接显示『获取失败』，而不是先灰化」的问题，并放宽整体的失败判定。

## 更新摘要（GitHub Release 正文）

## 本次修复
- 问题：WorkBuddy / WorkBuddy AI 偶尔直接显示「获取失败」，没有先保留旧数值变灰。
- 解决：区分「登录失效」和「临时故障」。只有登录失效才立刻报错；限流、上游 5xx、
  超时、返回结构变化都改为保留上次的积分并置灰，连续多次失败后才显示「获取失败」。
- 顺带放宽：连续失败判定从 5 次提高到 8 次（约 4 分钟），单次等待上限从 30 秒放宽到
  35 秒，避免一次慢响应就被判死。

---

## 工程细节（维护者用）

### 根因：不是「没有降级」，而是「分类太粗」

客户端的降级逻辑（`settle()`）本来就是对的：**暂时失败**保留旧值并灰化，**语义失败**
（缺凭据 / 登录失效）立即透传。问题出在 Host 侧的分类：

- `plans/workbuddy.js` 见到 `creditsError` 就一律返回 `error:'api'`；
- 而 `error:'api'` 在客户端属于**语义错误** → 立即显示「获取失败」，直接跳过灰化阶段。

但 connect 侧抛出的 `creditsError` 绝大多数是**暂时的**：其 `fetchCredits()` 里
`!response.ok || envelope.code !== 0` 一律向上抛，再由 status 路由包装成
`creditsError`，文案由 `envelopeError()` 生成：

```
workbuddy upstream <kind> (http <status>): <msg>
```

`kind` 来自其 `classifyUpstreamError()`：`hard_credit` / `session_dead` / `soft_rate` /
`not_found` / `server` / `client`。也就是说**错误原因本来就在文案里**，我们只是没有读它。

### 改动

| 位置 | 改动 |
| --- | --- |
| `plans/workbuddy.js` | 新增 `classifyCreditsError(text)`：`session_dead` / `hard_credit` / 401 / 402 → `error:'api'`（语义）；`soft_rate` / `server` / 5xx / timeout / network → `error:'exec'` + `transient:true`；无法识别 → 也按暂时处理（保守）。`credits` 结构解析失败同样改为 `exec`。 |
| `plans/workbuddy.js` | `STATUS_TIMEOUT_MS` 30s → **35s**：必须**大于** connect 内部的 `JSON_TIMEOUT_MS = 30000`，否则我们先超时，拿到的是自己造的 AbortError，丢失上游错误类别。 |
| `client.js` | `settle()` 增加 `plan.transient === true` 优先判定，Host 可显式标记「可重试」。 |
| `client.js` | `FAIL_THRESHOLD` 5 → **8**（30s 轮询 ≈ 4 分钟）；`/api/plan-usage` 超时 30s → **40s**（必须大于 Host 侧 35s，否则浏览器先掐断会让所有渠道一起失败）。 |

### 第二轮修正（代码审查发现的两个 P2）

**P2-1：分类器会被上游文案带偏。** 第一版对整段 `creditsError` 做子串匹配，而上游原始
`msg` 是第三方文案，可能包含「http 401」「timeout」等字样。实测场景：`soft_rate (http 429)`
的响应体里写着 `... (http 401) ...` → 被误判语义错误 → 又一次跳过灰化。

改为**前缀优先**：先按 connect 固定模板 `^workbuddy upstream <kind> (http <status>):` 解析
`kind`/`status`，这两项来自 connect 自己的 `classifyUpstreamError`，不受上游文案影响；
仅当前缀不匹配（旧版 connect / 文案改写）才退回启发式，且**先判暂时、再判语义**——
误判成语义的代价（胶囊直接失败）远大于多灰化几轮。

**P2-2：真实源码契约测试与新语义不一致。** `test-workbuddy-contract.mjs` 原本用一句
`throw new Error('synthetic token expired')` 断言 `error === 'api'`，而新分类器把这类
无前缀裸文本归为暂时失败。已拆成两组验证：

| 场景 | 期望 |
| --- | --- |
| `session_dead (http 401)` | `api`，无 `transient`，不伪造余额 |
| `soft_rate (http 429)` | `exec` + `transient:true` |
| `soft_rate` 前缀 + 正文含 `http 401` | 仍 `exec`（前缀优先） |

### 测试

- `test-workbuddy.mjs` 26 → **27** 项：W5b 覆盖 **13** 类 `creditsError` 文案
  （含「前缀优先」「暂时优先」「无法识别 → 暂时」三类边界）；W5c 断言「结构解析失败 → exec」；
  W8 的语义样例改为真实的 `session_dead` 文案。
- `test-workbuddy-contract.mjs` 5 → **7** 项：语义/暂时/冲突文案三组独立验证。
- `test-degrade-refresh.mjs` 42 → **43** 项：T3 适配阈值 8（新增 T3.pre2「第 6 轮仍保留旧值」）。

### 仍然会立即报错的情况（有意为之）

`not-installed`、`signed-out`、`no-key`、`session_dead`、`hard_credit` —— 这些是**确定的**
状态，拿旧值顶会让用户以为「还有积分」。

---
