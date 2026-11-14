# 待办清单（未实施）

> 本文件记录**用户已确认要做、但尚未实施**的事项。排序不分先后；每条都写清
> 「为什么 / 怎么改 / 约束 / 验收」，避免下次接手重新推导。
> 已发布版本的已知限制见 `AGENTS.md` §7。

## 1. MiMo 自动恢复：对「平台票据缺失」做**3 次**有限自动重试（**不改文案**）

**现状（0.10.5）**
- 恢复流程 = 重放账号凭据 → SSO 三次跳转换平台票据 → 读余额。
- 若第二次跳转后没拿到 `api-platform-serviceToken` / `userId`，抛
  `E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING`，外层包成
  `E_MIMO_CONSOLE_FLOW`（阶段 `read`）。
- `plans/mimo-auth/host.js` 的 `mapConsoleBalanceError()` 把它归入 401「终止类」，
  因此**不会自动重试**：用户必须手动点「重试恢复」。真机已验证：手点一次即恢复，
  说明多数情况是**上游当次未发票据**的瞬时问题，不是记录损坏。

**要做的**
- 仅针对 `E_MIMO_CONSOLE_PLATFORM_CREDENTIAL_MISSING`：允许 **最多 3 次**有限自动重试
  （建议间隔 2s / 5s / 10s 退避，总耗时可控），仍失败才按终止上报。
- 重试必须复用**同一次恢复**的语义（幂等；不新增凭据读取、不更改绑定、不跨身份）。
- 其它错误码的映射**一律不动**（尤其 `IDENTITY_MISMATCH`、`AUTH_REJECTED` 不得被重试掩盖）。

**约束（用户 2026-11-14 明确）**
- **不要改任何用户可见文案**：失败时仍显示现有的「恢复失败：<码>」形态。
- 与**安卓移动端适配**一并推进，不单独发版。

**验收**
- 单元测试：注入「前 1/2/3 次抛该码、第 N 次成功」的序列，断言重试次数与最终状态；
  注入「一直抛该码」断言恰好 3 次后终止且不再重试。
- 断言其它错误码**零重试**（防止误重试放大）。
- 真机：模拟首次自动恢复失败，观察是否自动恢复而无需手点。

## 2. 安卓（com.dsharnessmobile.shell）移动端适配

**现象（2026-11-12 真机）**
- MiMo 卡片显示「登录不可用（需要新版宿主），请升级 DSH」。
- Codex `Subscription` 显示「当前第三方插件版本暂不支持一键适配，请升级本插件」。

**已知线索**
- MiMo：`plans/mimo-auth/host.js` 的 `createAuthHost()` 只在
  `ctx.inject(['connection','webServer'], …)` 回调里执行；该回调永不触发时
  `getHost()` 恒为 `null` ⇒ 能力回包 `supported:false`、`rememberedSupported:false`。
  客户端据此走 managed 之外的分支（旧实验面板已在 0.10.3 停止挂载）。
- Codex：`plans/codex-subscription-patch.js` 的 `resolvePackageDir()` 决定目标目录；
  当前内置清单只有 `3.2.6` 与 `3.2.13`。手机端若为其它版本 ⇒ `unsupported`。

**要做的**
- 先确认安卓 Host 是否提供 `connection` / `webServer`；若确实缺服务，
  MiMo 扫码登录在该平台属于**不可用**，应如实说明（文案另行评审，不在本轮）。
- 确认手机端 `dsh-codex-subscription` 的实际版本与安装路径；若为其它版本，
  按 `.diagnostics/codex-subscription-<ver>/` 的方式生成清单（该目录**未入库**，
  需在桌面端重新生成后随包发布）。
- 视结论决定：新增清单 / 调整目录解析 / 或明确「该平台不支持」。

## 3. 其它已知未完成项

- **Codex 适配的路由级端到端测试**：`patch-state` / `apply-patch` 目前只有纯函数与
  CLI 覆盖，缺「真实 webServer 路由 + 真实目录」的用例。
- **额度策略表口径**：设置页「额度策略」表格里「当前剩余」的百分比来自
  `/api/plan-usage/quota-windows`，对 `used` 口径渠道（OpenCode Go）是否已换算**未核实**；
  行动作只在显示层修过 GUI 胶囊与详情，未覆盖该表。
- **MiMo 卡片展开态的开发者措辞**：仍有少数技术词（如「显示会话」「合成边界」）只应出现在
  排障语境，需要一次面向用户的收敛（与 `AGENTS.md` §7 的 MiMo 条目相关）。
- **`rememberedStart` 的 `rememberConsent`**：路由层已接受并归一，但**会话侧「不落盘」分支未实现**，
  因此界面不提供「记住登录」勾选（用户 2026-11-12 决定先不做）。
- **插件管理页看不到更新信息**：桌面 profile 曾以 `git:…#<commit>` 形式安装，
  该形态下无版本元数据可比对。若用户希望插件页显示版本/更新，需要改为从 npm 安装。
- **仍红的测试**（非产品缺陷，属离线 harness 能力缺口，勿当回归）：
  `test-mimo-display-e2e`、`test-mimo-remembered-client-e2e`、
  `test-workbuddy-contract`（需第三方包参数）、`test-recheck-round3` 的 W2a。
