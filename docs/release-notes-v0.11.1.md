# dsh-usage-dock 0.11.1

> 上一公开版：**0.11.0**（GitHub Release + npm）。本版是手机端 DSH Go 的适配收尾：
> WorkBuddy 渠道在手机上的识别与显示修正 + 额度面板信息密度收敛 + 模型路由名归一化。

## 更新摘要（GitHub Release 正文）

- **手机端 WorkBuddy 不再显示「渠道配置有误」**：网关的 provider id 在不同设备上不一样
  （桌面端叫 `workbuddy`、手机上是自定义来源 `custom-workbuddy`），现在会自动识别，
  积分正常显示；识别歧义时会明确要求你在设置里指定，不会猜错渠道。
- **手机端用 WorkBuddy 聊天时也有额度条与额度策略**：`custom-workbuddy` 这类自定义来源名
  现在能映射到 WorkBuddy 渠道，输入框上方的额度条与 `[当前额度快照]` 一并恢复。
- **额度面板更干净**：每个渠道下方不再重复显示「更新 HH:MM」，只在面板顶部保留一行；
  渠道自身出问题（失败 / 不可用 / 未知）时仍会显示说明，只是复用了原有的一行。
- **新增「WorkBuddy 网关来源」设置项**：留空即自动识别；设备上有多个相似来源时，
  可显式指定 provider id，填错会如实报「渠道配置有误」。
- **Web / 桌面端行为不变**：侧栏胶囊、详情卡片、顶层「Usage Dock」设置页都保持原样。

## 工程细节（维护者用）

### WorkBuddy 网关 provider 解析（`plans/workbuddy.js`）

- 新增导出 `readGatewayProviders()` / `pickGatewayProvider()` / `gatewayProviderIdOf()`；
  schema 新增 `workbuddyProvider`（`z.string().default('')`，留空=自动）。
- 判定顺序（命中即止）：① 显式 `workbuddyProvider`（填了只认它，不回退）；② provider id
  归一化（小写 + 仅字母数字）后等于 `workbuddy`；③ `displayName` 归一化后等于 `workbuddy`；
  ④ provider id 归一化后**以 `workbuddy` 结尾**（`custom-workbuddy`）。
- ③/④ 命中多条 ⇒ 歧义错误（要求显式指定），不猜；`workbuddy-api` / `wb-workbuddy-2` 这类
  「workbuddy 不在结尾」的命名不会自动命中（避免认错不同额度池的来源）。
- `index.js` 三处配合：导入 `gatewayProviderIdOf`；新增 `GATEWAY_PROVIDER_FALLBACK = 'workbuddy'`；
  观察身份里的来源指纹改为按**实际解析出的** provider id 计算（手机端网关 id 变化会进身份）。
- 回归：`tools/test-workbuddy-gateway.mjs` **39 项**（新增 G13–G20：显式指定 / displayName /
  后缀 / 歧义 / 归一化 / 指纹）、`tools/test-workbuddy-client-credits.mjs` **50 项**。

### 路由映射归一化（`plans/quota-prompt.js#resolveRoute`）

- 精确 id 优先；其次「词元连续包含 + 最长匹配」：`custom-workbuddy` → `workbuddy`、
  `custom-workbuddy-ai` → `workbuddy-ai`；等长多命中返回 `null`（不猜）。
- **不**转小写、**不**去前后空白：`WORKBUDDY` / `" workbuddy"` 仍不命中（沿用 A12 约定）。
- 胶囊 `providerToChannel()` 本来就先调 `resolveRoute()`，因此一处修好胶囊与额度策略两处。
- 新增 `tools/test-route-normalize.mjs` **7 项**。

### 原生面板：去掉逐渠道更新时间（`plans/dsh-go-native.js`）

- 渠道块不再渲染独立 `.note` 文本行（**不能只置空**：App 对空 text 仍占一整行）；
  余额/积分行改绑 `.value`（有金额显示金额，没有则显示状态文案）；
  配额渠道无窗口数据时，状态文案写进第一个窗口的说明（`c5`）。
- 正常态 `note` 为空串；失败 / 不可用 / 未知仍显示说明（位置改为值列或第一窗口说明）。
- `quotaSummaryLine()` 不再拼裸括号；`test-dsh-go-native` 增至 **43 项**（新增「渠道块不再渲染
  独立状态行」「状态文案复用现有行」「更新时间只在顶部」）。

### 验证（主代理实跑）

`test-workbuddy-gateway` 39/39、`test-workbuddy-client-credits` 50/50、
`test-route-normalize` 7/7、`test-dsh-go-native` 43/43、`test-dsh-go-strip` 17/17、
`test-dsh-go-boundaries` 47/47、`test-mimo-legacy-store` 12/12、`test-usage-tool` 108/108、
`test-usage-tool-register` 70/70、`test-footer-row` 12/12、`test-degrade-refresh` 44/44、
`test-codex-patch-ui` 35/35、`test-codex-source-ui` 91/91、`test-settings` 17/17、
`test-android-compat` 14/14、`test-line-endings` 71/71。

### 已知未做（用户确认暂不处理）

- `provider → 渠道` 映射在**额度策略 `ROUTE_TABLE` 与胶囊 `providerToChannel`** 上已按本版归一化；
  自定义余额条目仍按条目 `provider` 精确匹配，遇到自定义命名需显式配置。
- 原生面板仍未搬 Web 详情卡片里的 DeepSeek 峰谷条、充值入口、赠金明细、Codex Subscription 适配入口。
- 本版未在手机真机重新验收（依赖手机侧 2026-11-17 的真机结果：WorkBuddy 1097 积分、
  OpenCode Go / DeepSeek / MiMo 正常）。

---

版本状态：**已发布** —— tag `v0.11.1`（commit `7db237b`）、GitHub Release id **449662483**（`make_latest: true`）、npm `dsh-usage-dock@0.11.1`（48 文件，`dist.shasum` 前缀 `6a770ef8…`）。

