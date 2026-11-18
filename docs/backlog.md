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

**进展（0.11.0 / 2026-11-14～16）**

- 「详情卡片」已适配为 dsh-go 原生面板（`dshGo.contributes.panels`：`session.tab` + `features`），
  实现与验证记录见 [dsh-go-native-panel.md](dsh-go-native-panel.md)；离线测试 37 项（另 strip 17 项、
  MiMo legacy 持久化 11 项）、官方 `check --load` 通过（面板 3：quota / settings / mimo-login）。
- 面板内已加「设置」入口 + 原生设置页（v2 表单：总开关/渠道开关/Codex 来源/余额阈值/
  OpenCode Go 额度策略档位），写回复用 Host `settings` 服务；**密钥 / Cookie / 自定义余额仍走网页版设置页**。
- MiMo 扫码登录：设置页入口 + 原生 `mimo-login` 面板（QR、轮询、取消），复用 Host auth/QR handler；
  已定位并修复 vendor 域名白名单对官方子域的误拒（`E_URL_PURPOSE_MISMATCH`），本机真实流程可拿到二维码；
  动态审批场景仍提示去网页版。
- 2026-11-14 返工：设置页按渠道分组、策略输入随「关注额度策略」开关条件显示、
  OpenCode Go 三个窗口各一行两框；重置时间改为网页同款两段式倒计时。
- 2026-11-14 MiMo 联调：按官方接口变化与真实网络做最小兼容（官方子域 URL、quoted/账号域
  cookie、非法 Set-Cookie 行按浏览器语义忽略），流程仍复用 0.10.5 Host 实现，网页版同样受益。
- 2026-11-17 ✅ **已做**：`provider → 渠道` 映射归一化（`plans/quota-prompt.js#resolveRoute`）。
  精确 id 优先；其次按「词元连续包含 + 最长匹配」（`custom-workbuddy` → `workbuddy`、
  `custom-workbuddy-ai` → `workbuddy-ai`）；等长多命中视为歧义返回 null；**不**做大小写/空白归一化（A12）。
  胶囊 `providerToChannel` 走同一个 `resolveRoute`，因此两处一起修好。测试 `tools/test-route-normalize.mjs`。
- 2026-11-17 WorkBuddy「渠道配置有误」真机修复：网关 provider id 与设备相关
  （桌面端 `workbuddy`、手机端自定义来源 `custom-workbuddy`，只有 displayName 是 workbuddy），
  旧代码写死 id 导致手机端目录查不到 → `config`。现按「显式配置 → id → displayName → id 后缀」
  自动识别，歧义要求显式指定；新增 `workbuddyProvider` 配置（留空=自动）。测试 G13–G19。
- 2026-11-15/16 MiMo 登录持久化：凭据记录保存平台 cookie，重启引擎后重放余额接口免扫码
  （真机验证通过）；设置页可关闭并清除；纯逻辑+可注入 fetch 测试 11 项。
  待观察：serviceToken 实际有效期、设备/IP 绑定是否会失效。
- 2026-11-15 MiMo 联调收尾：原生面板自动跳过「确认账号匹配」等待（原先空等 100 秒）、
  legacy 登录余额投影给额度面板读取、二维码过期提示；strip 文案改渠道全名 + 依次数值。
- 2026-11-15 composer.strip 胶囊：当前会话渠道一行摘要（≤24 字）+ 详情 sheet；会话路由事件跟踪与回填、
  内置/自定义 provider 精确映射、单渠道 30s 缓存。MiMo provider id 待确认后补 ROUTE_TABLE。
- 2026-11-14 设置页两列：`row` 在 form 里会被最小宽压成一列、v2 `style.columns` 在部分 App
  版本不生效，改用 `grid columns: 2`；策略字段上限 32 故 Codex 只保留关注开关。
- 状态条（`composer.strip`）**已完成**（0.11.0，见 `docs/dsh-go-native-panel.md` §4.4），
  但**尚未在真机确认观感**；MiMo / Codex 两条平台问题仍未处理。

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

## 4. ✅ [0.11.2 已完成] MiMo 改用 API Key 直接查余额（API Key 优先，旧 Cookie 保留为回退）

> 状态：**0.11.2 已实现**（`plans/mimo.js` + `tools/test-mimo-api-key.mjs`）。
> 仍未做：套餐余量 / 日用量进详情卡片；旧扫码通道退役仍待用户决定。

- **接口（2026-11-18 已核对文档并实测）**：`GET https://api.xiaomimimo.com/v1/platform/balance`，
  鉴权 `api-key: sk-…` 或 `Authorization: Bearer sk-…`；响应 `{object:"balance", is_available,
  balance_infos:[{currency, cash_balance, gift_balance, frozen_balance, credit_limit,
  credit_available, total_available}]}`。无 key / 假 key 返回 `401 invalid_api_key`（端点存在）。
  文档：<https://mimo.mi.com/docs/zh-CN/api/asset/balance-get>；同组还有 credits / consumption /
  daily-bill 三个财务接口。详见 `docs/mimo-api-key-balance.md`。
- **为什么做**：现在 MiMo 依赖控制台 Cookie（扫码 → 4 个 cookie → 重启重放），是最脆弱的一环；
  改成 API Key 后与 DeepSeek / WorkBuddy 同构（填 Key 就出余额，401 即失效）。
- **怎么改**：`plans/mimo.js` 加 `mimoApiKey`（secret）与 API Key 通道；观察身份加 `key=` 指纹；
  胶囊/详情/`usage_status`/额度策略/`composer.strip` 同源；Web 设置页 MiMo 分组加 Key 输入；
  新增 `tools/test-mimo-api-key.mjs`（200/401/403/5xx/结构异常/无 Key/身份隔离）。
- **待用户决定**：余额口径用 `total_available` 还是 `cash_balance + gift_balance`；
  扫码（Cookie）通道保留为回退还是直接退役。
- **发布节奏**：与 **DSH Go 那边的 Codex Subscription 适配按钮**一起，作为 0.11.2 发布。
