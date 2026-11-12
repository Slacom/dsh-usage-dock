# dsh-usage-dock 0.10.5

> 0.10.3 / 0.10.4 是**本地构建、从未发布**的过程版本；正式发布从 0.10.5 起。

## 更新摘要（GitHub Release 正文）

- **MiMo 登录更简单**：点「扫码登录」直接出二维码，不需要勾选、不需要批准、不需要填账号 ID；
  手机扫码后先显示账号，由你确认一次即可。
- **登录没走完不会残留**：等扫码、扫了没确认时关掉设置页，再打开一定是起始界面（未登录 + 扫码登录）。
- **余额不再"永远读取中"**：已经拿到的余额会照常显示；未登录说「未登录」、连续失败才说「获取失败」。
- **OpenCode Go 百分比修正**：之前把"已用"当成"剩余"，看起来像额度耗尽；现在显示真实剩余。
- **Codex 订阅额度支持 3.2.13**：一键适配能识别新版第三方包（含 pnpm 安装布局），
  版本不支持时会明确提示，而不是笼统一句失败。
- **额度提示真的进提示词了**：修掉 OpenCode Go 的路由未识别问题；策略生效时会附带当前额度快照，
  并可在设置页之外通过只读字段自证"是否注册 / 为何没输出"。
- **卡片里的重置时间更细、更整齐**：由「4 小时」变为「4时11分」「3天13时」，
  每行进度条等长、单位竖直对齐，鼠标悬停可看具体时间点。

## 工程细节（维护者用）

- **MiMo**
  - `index.js` 的 `registerMimoAuth()` 显式打开 `enableConsoleProtocol` / `enableRememberedAccount`
    （0.10.2 漏掉导致新装环境回退到旧实验面板）。
  - 面板收敛为：未登录 = 「未登录账号 + 一行说明 + 整行扫码登录」；`authorizing` = 二维码在上、
    「请用手机扫码确认。」与整行取消在下；`awaiting_confirmation` = 候选账号 + 两个各占一半的按钮。
    二维码改用 **data URL**（去掉 blob 生命周期问题）。
  - 动态目标批准改为**检测到即自动发送一次** `rememberedApprove`（按 `approvalId` 去重），
    不再渲染批准/拒绝；`rememberedStart` 只发 `authConsent` + `consentVersion`（路由对键集是精确校验）。
  - 重挂载语义：`authorizing` / `awaiting_confirmation` 且本次挂载无图/无候选 ⇒ 发一次
    `rememberedCancel`（按 authId 去重）回到 `empty`。
  - 修复 `shownQr` 未定义导致的**渲染崩溃**（点「扫码登录」整页空白）。
  - 显示层：不再用 `holding` 占位盖掉 Host 已返回的真实余额（只遮蔽旧 Cookie 通道的遗留值）；
    缺席态新增固定枚举 `mimoState`（`signed-out` / `failed` / `pending`）驱动胶囊用词。
- **OpenCode Go**：`used` 口径在**显示层**换算为剩余（进度条/百分比/着色/标题一起对齐），
  不动 wire 语义。
- **Codex 订阅适配**
  - 新增 `plans/patches/codex-subscription-3.2.13.json`（`programSha = aa57c939…`），与 3.2.6 并存；
    4 段纯插入，已在真实字节上验证 apply → patched → revert 与基线逐字节一致。
  - `resolvePackageDir()` 支持多候选布局（含 pnpm 的 `.pnpm/<pkg>@<ver>/node_modules/<pkg>`），
    修复新装环境判「版本不支持」。
  - `apply-patch` 的 `E_CS_PATCH_UNSUPPORTED` 有独立文案「当前第三方插件版本暂不支持一键适配，请升级本插件。」
- **额度策略**
  - `ROUTE_TABLE` 补 `opencode-go → opencode-go`（漏映射 ⇒ `resolveRoute` 返回 null ⇒ 静默不投放）。
  - `systemPrompt.context` 注册改为 `ctx.inject(['systemPrompt'], …)`，避免服务晚就绪时静默失败。
  - `/api/plan-usage` 新增只读自证字段 `quotaContext: { registered, state, channelId }`，
    `state` 为固定枚举（`rendered` / `route-unmapped` / `route-not-focused` / `policy-off` / `unobserved-route` …）。
- **详情卡片**：重置时间两段精度（`4时11分` / `3天13时`）、`tabular-nums`、定宽右对齐；
  进度条高度 6 → 8、标签列 44 → 40、行间距 8 → 4；悬停 `title` 给本地绝对时间。
- **测试**：把「旧面板 4 勾选」「旧 Cookie 通道」「旧文案」等过时断言更新到新契约；
  `mimo-usage-lane` 的缺失态白名单加入 `mimoState`。
  已知仍红（非产品缺陷，属离线 harness 能力缺口）：`test-mimo-display-e2e`、
  `test-mimo-remembered-client-e2e`、`test-workbuddy-contract`（需第三方包参数）、
  `test-recheck-round3` 的 W2a。
- **未做**：`rememberedStart` 已接受 `rememberConsent`，但会话侧「不落盘」分支未实现，
  因此界面暂不提供「记住登录」勾选（用户决定不做）。
