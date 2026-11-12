# dsh-usage-dock 0.10.0

> 0.10.0 是 0.9.0 之后第一个**公开发布**的版本（0.9.1 只是过程内的整改标签，未单独发布）。
> 面向用户的能力与用法见 [README](../README.md)；逐轮实施与复核记录见
> [Codex 双来源 Host 适配](codex-source-host-adapter-20261111.md)、
> [Codex 双来源 UI](codex-source-ui-20261111.md)、
> [MiMo 读数对齐](mimo-usage-lane-alignment-20261112.md)。

## 更新摘要（GitHub Release 正文）

- **OpenAI Codex 支持两个来源，由你手选一个**：`Codex Connect`（沿用已有登录）与
  `Codex Subscription`（订阅额度）。两者**不会合并、不会自动回退**——选哪个就显示哪个；
  切换来源后旧来源的数字会立刻消失，不会出现「拿 Connect 的数字冒充订阅额度」。
- **WorkBuddy 改读客户端接口**：直接调用网关的 `GET /v1/credits`，只统计**国内（cn）**积分；
  该接口没有稳定的账号 ID，因此**取消账号勾选**（不再有「选择要合计哪些账号」）。
- **小米 MiMo 的余额口径统一**：胶囊、详情面板、只读工具 `usage_status` 与「额度策略」
  现在读**同一份**显示快照，不会再出现「胶囊有值、工具却说接口不可用」。
- **启动首帧就列出所有已启用渠道**：还没取到数时先显示「灰点 + …」占位，数据回来逐行替换；
  停用的渠道整行不出现（不是变灰）。
- 其它渠道（OpenCode Go / DeepSeek）、设置页、排序、详情面板、30 秒轮询与请求行为**不受影响**。

## 重要前提（请先读）

1. **Codex 的 `Subscription` 来源需要一个第三方本地补丁**：它依赖第三方包
   `dsh-codex-subscription` 上的**本地只读 service 补丁**（把订阅额度以只读服务暴露出来），
   **不在本包的发布内容里**。没打补丁时：`Subscription` 来源显示
   **「接口暂不可用（需适配）」**，而 `Codex Connect` 来源照常可用。
2. **小米 MiMo 需要「记住登录」链路才有数值**：MiMo 现在按本机显示会话读数，
   需要在设置页完成登录并记住；没有该链路时胶囊显示占位/读取中，而不是旧的手工 Cookie 值。

## 一、渠道与读数

- **Codex 双来源**（`plans/codex.js`、`plans/codex-sources.js`）：来源是配置字段
  `codexSource`，默认 `connect`；wire 不带来源时按 `connect` 处理。来源不符的行**整行不画**
  （不换成另一来源的数字）。来源的可用性从只读路由 `GET /api/plan-usage/codex-sources` 读取，
  只回布尔与固定状态文案，不含额度、不含凭据。
- **WorkBuddy 客户端积分**（`plans/workbuddy.js`）：`GET /v1/credits`，只统计 `scope=cn`；
  观察身份不再包含账号指纹（接口没有稳定账号 ID），因此也不再提供账号筛选。
- **MiMo 一份快照**（`plans/mimo-auth/host.js`、`index.js`、`plans/usage-tool.js`）：
  `registerMimoAuth()` 返回 `{ bootEpoch, getHost, dispose }`，`getHost()` 每次现读闭包里
  **异步创建**的 host（inject 未完成时为 `null`）；读显示值走 `routeDisplay.peek()`，
  缺失才回退 `display.peek()`，两者都没有则视为「不适用」并回落原 provider 路径。

## 二、胶囊启动占位（0.10.0 新增）

- 首帧把「已保存配置里已启用、但这一轮还没有数据」的渠道铺成占位行：中性灰点 + `…`，
  **不带**任何数字、币种符号、`✦` 或百分比；真实数据到达后逐行替换，行数与顺序不变。
- 只补**尚未出现**的渠道 id（已有真实行的不会重复）；顺序仍走同一套「渠道顺序」设置，
  未列出的按内置顺序 + 自定义顺序追加。
- 读不到已保存配置时**不铺**占位（保持旧行为，避免把所有渠道误列出来）。
- 占位行**不进详情面板**：面板只列有数据或已有明确失败结论的渠道。

## 三、设置页与排序

- 单列卡片、展平凭据区、保存/放弃吸底等布局沿用 0.9.0；本轮没有改交互。
- 小米 MiMo 的唯一入口是卡片内的登录/状态面板；**不再提供手工 Cookie 输入框**。
  该面板挂载时会做一次**只读**能力探测（用于区分「记住登录」面板与扫码面板），
  除此之外不会在你点击之前发起任何登录动作。

## 四、工程细节（维护者用）

- **摘要组件双端同构**：`configDigestOf()`（Host，`plans/custom-balance.js`）与
  `configDigestOfClient()`（`client.js`）必须逐字节相等，顺序是合同的一部分：
  Codex 来源片段（`builtin:codex-source` + `\u0002` + 来源 id）固定排在自定义条目**之前**，
  再接孤儿条目。改动任一侧都要同时改另一侧并有回归守卫。
- **`ACCOUNT_BOUND_PLAN_IDS` 含 `mimo`**：MiMo 的显示值取决于本机显示会话 / 记住登录，
  不由配置摘要决定，因此 `usage_status` 的成功缓存（键含配置代次）**不得**缓存 MiMo。
  与 deepseek / codex / workbuddy 同列，理由相同：账号/会话型读数不能跨配置代次复用。
- **`getHost()` / `routeDisplay` 是只读句柄**：`registerMimoAuth()` 的返回值里从来没有
  `display`/`routeDisplay` 字段——host 是 `ctx.inject([...], cb)` 里异步创建的，只存在于闭包。
  读它必须每次调用 `getHost()`（不要缓存），且只做只读消费：拿到 host 也**不得**调用任何变更动作
  （managed 模式下 start/read/grant/confirm/stop 固定拒绝）。
- **占位行不进详情面板**：面板渲染前过滤 `pending === true`，否则刚启动每个已启用渠道
  都会多出一段「无法获取用量」的空分区。
- **清理（0.10.0）**：删除已退场渠道模块 `plans/kimi-code.js`、`plans/glm-zhipu.js`、`plans/glm-zai.js`
  与 WorkBuddy 旧 `/status` 路径的零引用死代码（`listWorkbuddyAccountsLegacy`、`parseAccountSelection`、
  `selectedAccountsFingerprint`、`workbuddyAi`/`fetchPlanAi`/`aiPlan`/`AI_PATH`/`makeFetchPlan`）；
  `RETIRED_PLAN_IDS` 的 4 个 id 字符串**原样保留**（旧配置识别、防复活）；同时删除仓库里的临时探针与 poc 脚本；并移除 poc 期测试（其夹具是本地未跟踪文件，删除后不可运行）。
- **本版修掉的失败项**（都是断言老化，不是产品缺陷；每处都在测试里写了「旧断言假设 → 现行为 → 依据」）：
  - `test-degrade-refresh` T9/T10（5 项）：MiMo 改「显示会话优先」后，未拿到可信显示状态时
    胶囊会遮蔽成「读取中」；改为断言投影函数在 `resolving:true`（遮蔽）与
    `resolving:false` + 可信 absent（按 wire 渲染）两种状态下的行为，并保留低余额红灯判据对照。
  - `test-custom-settings` C2c（1 项）：原来拿 MiMo 的手工 Cookie 输入框当「最后一个内置卡片」的
    参照，该输入框已随登录面板改造移除；改用卡片级标记 `data-plan-card` 取最后一个内置卡片。
  - `test-mimo-auth-client` C1b/C2a/C2b/C2c（4 项）：MiMo 卡片不再有手工 Cookie 输入
    （改由登录/状态面板承担）；面板挂载会先做一次只读能力探测，因此「首次渲染不发请求」不再成立。
    改为断言「只发一次只读 GET、无 POST/QR、探测返回前只显示占位文案、探测完成后面板默认收起」，
    并把 start body 的闭集扩到含 `postQrConsent`。同时给 mock 运行时补上 `React.Fragment`、
    给 client 增加 `mimoAuth.LegacyPanel` 离线挂载点（都只服务测试，不改变生产行为）。

## 五、已知限制（0.10.0）

1. **Codex 的 `Subscription` 来源需要第三方只读补丁**：依赖第三方包 `dsh-codex-subscription` 上的
   本地只读 service 补丁，**不在本包发布内容里**；未打补丁时该来源显示「接口暂不可用（需适配）」，
   `Codex Connect` 来源不受影响。
2. **MiMo 恢复失败对外统一为固定闭集码**：重启恢复失败时，对外只给协议白名单里的固定码
   （例如统一粗化为 `E_MIMO_CONSOLE_FLOW` 一类），**更细的 SSO 细分码不外露**。
   这是刻意的取舍：宁可少给诊断精度，也不把上游正文 / URL / 账号 / Cookie 带出去。
3. **一条离线套件需要 Electron 运行时**：`tools/test-mimo-settings-mount-adapter.mjs` 依赖打包
   Electron 运行时才能读取 ASAR 内的 yaml 包，纯 `node` 下会打印 `E_YAML_UNAVAILABLE` 并以非 0 退出；
   因此本机/CI 的「纯 node 全绿」口径把它计为 `A3-需环境`，离线无法判定。
## 历史

- 0.9.0：三渠道退场 + 通用自定义余额 + `usage_status` + 可选额度策略（已发布）。
- 0.9.1：**过程内整改标签，未单独发布**，内容已并入 0.10.0 的基线。
- 0.10.0：Codex 双来源、WorkBuddy 客户端积分、MiMo 读数同源、胶囊启动占位、失败断言全部修绿。
