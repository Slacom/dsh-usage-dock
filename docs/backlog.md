# 待办清单（未实施）

> 本文件记录**用户已确认要做、但尚未实施**的事项。排序不分先后；每条都写清
> 「为什么 / 怎么改 / 约束 / 验收」，避免下次接手重新推导。
> 已发布版本的已知限制见 `AGENTS.md` §7。

> **0.12.0 已关闭项（2026-11-24）**：MiMo 扫码登录 / 记住登录 / 控制台 Cookie 已**彻底删除**
> （`plans/mimo-auth/**` 15 文件、`plans/mimo-legacy-store.js`、client 登录 UI、Host legacy 记录、
> `mimo-login` 面板与 36 个 `test-mimo*` 套件）。现行 MiMo **只有 API Key** 余额；
> 下列第 1 节与第 2 节里的 MiMo 登录/票据内容**只作历史，不再排期**。

## 1. ~~MiMo「平台票据缺失」做 3 次有限自动重试~~（**已关闭，不再实施**）

> **0.12.0 决定**：MiMo 的扫码 / 记住登录 / 平台票据链已整体删除，`plans/mimo-auth/**` 与
> `plans/mimo-legacy-store.js` 都不存在了。本节保留的是 **0.10.5 时期**的待办与验收设想，
> 只在历史语境有效。现行 MiMo 只有 API Key 余额（无 Key 固定 `no-key`），不存在票据恢复，
> **不要按本节改代码、补测试或排期**。

**以下为历史原文（0.10.5），不要执行**
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

**现象（2026-11-12 真机，MiMo 部分已随 0.12.0 关闭）**
- MiMo 已有登录入口的功能在 0.12.0 **整体删除**，只剩 API Key 余额；不会再出现
  「登录不可用（需要新版宿主）」。若 Android 上配了 API Key 仍失败，按 API Key 通道排查
  （401 / 网络 / 结构），不再有「宿主缺 connection/webServer」这类登录能力问题。
- Codex `Subscription` 显示「当前第三方插件版本暂不支持一键适配，请升级本插件」——该来源也已在
  0.12.0 退场，只作历史。

**已知线索**
- ~~MiMo：`plans/mimo-auth/host.js` 的 `createAuthHost()`…~~ **该模块已删除，线索作废**；
  0.12.0 不存在 MiMo 登录宿主服务，不要再按 `connection` / `webServer` 缺失推断 MiMo 登录能力。
- Codex：`plans/codex-subscription-patch.js` 的 `resolvePackageDir()` 决定目标目录；
  当前内置清单只有 `3.2.6` 与 `3.2.13`。手机端若为其它版本 ⇒ `unsupported`（历史来源，已无入口）。

**要做的**
- ~~先确认安卓 Host 是否提供 `connection` / `webServer`；若确实缺服务，MiMo 扫码登录在该平台属于
  不可用~~：**已关闭**，MiMo 登录已删除，无需再确认或补文案。
- 确认手机端 `dsh-codex-subscription` 的实际版本与安装路径；若为其它版本，
  按 `.diagnostics/codex-subscription-<ver>/` 的方式生成清单（该目录**未入库**，
  需在桌面端重新生成后随包发布）。**该来源已在 0.12.0 退场，此项只作历史遗留，不再排期。**
- 视结论决定：新增清单 / 调整目录解析 / 或明确「该平台不支持」。

**进展（0.11.0 / 2026-11-14～16，历史；MiMo 登录部分已被 0.12.0 删除）**

> ⚠️ 以下 MiMo 扫码 / 登录持久化 / `mimo-login` 面板的进展只作沿革。0.12.0 已删除这些能力，
> 不要再把它们当作待验收或待修项；现行 MiMo 只有 API Key 余额。

- 「详情卡片」已适配为 dsh-go 原生面板（`dshGo.contributes.panels`：`session.tab` + `features`），
  实现与验证记录见 [dsh-go-native-panel.md](dsh-go-native-panel.md)；离线测试 37 项（另 strip 17 项、
  MiMo legacy 持久化 11 项）、官方 `check --load` 通过（当时面板 3 个：quota / settings / mimo-login；
  **0.12.0 已删除 `mimo-login`，现为 2 个**）。
- 面板内已加「设置」入口 + 原生设置页（v2 表单：总开关/渠道开关/Codex 来源/余额阈值/
  OpenCode Go 额度策略档位），写回复用 Host `settings` 服务；**密钥 / Cookie / 自定义余额仍走网页版设置页**。
- **（已删除，仅历史）MiMo 扫码登录**：设置页入口 + 原生 `mimo-login` 面板（QR、轮询、取消），
  复用 Host auth/QR handler；曾定位并修复 vendor 域名白名单对官方子域的误拒
  （`E_URL_PURPOSE_MISMATCH`）。**0.12.0 起面板、入口与后端流程全部删除**，MiMo 只保留 API Key。
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
- 2026-11-15/16 **（已删除，仅历史）MiMo 登录持久化**：凭据记录保存平台 cookie，重启引擎后重放余额接口
  免扫码（当时真机验证通过）；设置页可关闭并清除；纯逻辑+可注入 fetch 测试 11 项。
  **0.12.0 起记录、重放与 `mimoRememberLogin` 全部删除，不再是待观察项。**
- **（已删除，仅历史）MiMo 联调收尾**：原生面板曾自动跳过「确认账号匹配」等待（原先空等 100 秒）、
  legacy 登录余额投影给额度面板读取、二维码过期提示；**这些随登录通道一起删除**。
- 2026-11-15 composer.strip 胶囊：当前会话渠道一行摘要（≤24 字）+ 详情 sheet；会话路由事件跟踪与回填、
  内置/自定义 provider 精确映射、单渠道 30s 缓存。MiMo provider id 待确认后补 ROUTE_TABLE。
- 2026-11-14 设置页两列：`row` 在 form 里会被最小宽压成一列、v2 `style.columns` 在部分 App
  版本不生效，改用 `grid columns: 2`；策略字段上限 32 故 Codex 只保留关注开关。
- 状态条（`composer.strip`）**已完成**（0.11.0，见 `docs/dsh-go-native-panel.md` §4.4），
  但**尚未在真机确认观感**；Codex 旧来源问题已随 0.12.0 退场关闭，MiMo 登录问题已随代码删除关闭。

## 3. 其它已知未完成项

- **Codex 适配的路由级端到端测试**：`patch-state` / `apply-patch` 目前只有纯函数与
  CLI 覆盖，缺「真实 webServer 路由 + 真实目录」的用例。
- **额度策略表口径**：设置页「额度策略」表格里「当前剩余」的百分比来自
  `/api/plan-usage/quota-windows`，对 `used` 口径渠道（OpenCode Go）是否已换算**未核实**；
  行动作只在显示层修过 GUI 胶囊与详情，未覆盖该表。
- ~~**MiMo 卡片展开态的开发者措辞**：仍有少数技术词（如「显示会话」「合成边界」）…~~
  **已关闭（0.12.0）**：MiMo 登录 / 显示会话整块删除，只剩 API Key 余额，相关技术词不再出现；
  剩余设置页文案按普通 UI 维护，不再单列 MiMo 排期。
- ~~**`rememberedStart` 的 `rememberConsent`**：路由层已接受并归一…~~ **已删除（0.12.0）**：
  `rememberedStart` / 记住登录 / 不落盘分支随 `plans/mimo-auth/**` 一起移除，不存在「记住登录勾选」。
- **插件管理页看不到更新信息**：桌面 profile 曾以 `git:…#<commit>` 形式安装，
  该形态下无版本元数据可比对。若用户希望插件页显示版本/更新，需要改为从 npm 安装。
- **测试已收口（2026-11-25 最终回归）**：关键 **13 套件共 785 项全绿**
  （`test-dsh-go-boundaries` 29 / `test-usage-recheck-f1f2` 17 / `test-mimo-api-key` 17 /
  `test-dsh-go-native` 53 / `test-degrade-refresh` 41 / `test-settings` 17 /
  `test-settings-layout-20261024` 30 / `test-config-unwrap` 22 / `test-usage-tool` 103 /
  `test-codex-account` 242 / `-host` 46 / `-ui` 100 / `test-line-endings` 68），
  另有 `test-review-fixes` **40** 项通过；**全部 WorkBuddy / MiMo 相关改动套件通过**。
  2026-11-23 的 102/94 与 8 个失败名单已过期（其中 5 个 MiMo 登录套件已删除），不得再引用；
  `test-codex-auto-adapt`、`test-fetch-backends` 等旧套件不在本轮关键清单内，不据此声称全仓全绿。
  **0.12 未发布、未真机验收。**
- **WorkBuddy 已退场（0.12.0，已完成决定，无需再排期）**：用户决定 WorkBuddy **不再作为插件原生 /
  内置渠道**（不再使用反代渠道），以后要用只通过「自定义余额渠道」添加。`plans/workbuddy.js` 已删除，
  `workbuddy` / `workbuddy-ai` 进 `RETIRED_PLAN_IDS`；原生渠道只剩 OpenCode Go / DeepSeek /
  OpenAI Codex / 小米 MiMo 4 个，原生面板默认顺序 `DeepSeek → MiMo → Codex → OpenCode Go`。
  6 个 WorkBuddy 专用测试（`test-workbuddy-contract` / `-expiry-label` / `-legacy-selection` /
  `-round8` / `-client-credits` / `-gateway`）随渠道退场删除。
  **没有**遗留的 WorkBuddy 专用开关 / 积分口径 / 账号筛选 / 原生分组待做。

## 4. ✅ [0.11.2 已完成；0.12.0 收敛为唯一通道] MiMo 改用 API Key 直接查余额

> 状态：**0.11.2 已实现**（`plans/mimo.js` + `tools/test-mimo-api-key.mjs`）。
> **0.12.0 用户决定彻底删除旧扫码 / Cookie 通道**，`mimoApiKey` 现在是 MiMo 的**唯一凭据**。
> 仍未做：套餐余量 / 日用量进详情卡片（与登录无关）。

- **接口（2026-11-18 已核对文档并实测）**：`GET https://api.xiaomimimo.com/v1/platform/balance`，
  鉴权 `api-key: sk-…` 或 `Authorization: Bearer sk-…`；响应 `{object:"balance", is_available,
  balance_infos:[{currency, cash_balance, gift_balance, frozen_balance, credit_limit,
  credit_available, total_available}]}`。无 key / 假 key 返回 `401 invalid_api_key`（端点存在）。
  文档：<https://mimo.mi.com/docs/zh-CN/api/asset/balance-get>；同组还有 credits / consumption /
  daily-bill 三个财务接口。详见 `docs/mimo-api-key-balance.md`。
- **为什么做（当时）**：0.11.2 之前 MiMo 依赖控制台 Cookie（扫码 → 4 个 cookie → 重启重放），
  是最脆弱的一环；改成 API Key 后与 DeepSeek 同构（填 Key 就出余额，401 即失效）。
  WorkBuddy 已在 0.12.0 退场，这里只作当时的对比对象。
- **怎么改（0.11.2 实现记录）**：`plans/mimo.js` 加 `mimoApiKey`（secret）与 API Key 通道；观察身份加
  `key=` 指纹；胶囊/详情/`usage_status`/额度策略/`composer.strip` 走**同一 API Key wire**；Web 设置页 MiMo 分组加 Key 输入；
  新增 `tools/test-mimo-api-key.mjs`（200/401/403/5xx/结构异常/无 Key/身份隔离）。
- **已决定（0.12.0）**：余额口径用 `cash_balance + gift_balance`（不含授信）；
  **扫码（Cookie）通道直接删除，不再保留回退**。MiMo 登录相关代码与 36 个测试已移除。
- **发布节奏**：与 **DSH Go 那边的 Codex Subscription 适配按钮**一起，作为 0.11.2 发布。

## 5. [0.12.0 开发中] Codex 独立登录（插件私有 Codex OAuth）+ 多账户

> 协议、端点、v2 记录形状、账户操作与合规说明见
> [codex-account-oauth-20261122.md](codex-account-oauth-20261122.md)；发布草稿见
> [release-notes-v0.12.0.md](release-notes-v0.12.0.md)。

**状态**

- **开发中**：本轮做本地实现 + 离线测试；**未部署、未真机验证、未发布、未经用户验收**；
  `package.json` 仍是 **0.11.3**（0.12.0 只是草稿）。
- Codex **只剩本插件自己的 ChatGPT 账号登录**：`connect` / `subscription` 两个来源**已退场** ——
  网页设置页不再有来源单选 / 摘要 / 说明 / Subscription 适配块，DSH Go 原生设置页不再有来源下拉与
  适配入口，活动取数路径（`plans/codex.js#fetchPlan`）**恒走 account**。
- **多账户已实现（仅离线）**：私有记录升级为 **v2**（`{version:2, activeAccountId, accounts:[…]}`），
  最多 **8** 个账户、单选生效；支持添加（设备码）、同账号重登（upsert）、切换、移除。
  真实账号目前只成功登录过**一个**账户一次。

**为什么**

- 旧的两个来源都要靠第三方插件：
  `Codex Connect` 依赖 `dsh-codex-connect`；`Codex Subscription` 依赖第三方
  `dsh-codex-subscription` **加本地只读补丁**，第三方一升级补丁就失效（见 `AGENTS.md` §7）。
  用户不想为了看额度再装一个第三方包、也不想反复适配补丁。
- 官方 `openai/sign-in-with-chatgpt-devkit`（SIWC）**不能解决**这个问题：`packages/local`
  只提供 OAuth / 凭据存储 / 账号资料 / 模型目录 / Responses 流，**没有额度读取 API**；
  `CHATGPT_USAGE_URL` 只是网页链接；用 SIWC 的 access token 调 `/backend-api/wham/usage`
  实测返回 **401 `no_matching_rule`**，OpenAI 在 issue #3 明确回复
  “This is not supported at the moment. We may build this in the future.”；
  且其许可证是 **Sign-in with ChatGPT DevKit Noncommercial License v1.0**、`@siwc/local`
  是 private workspace 未发布 npm ⇒ **不能集成其代码**（分发与许可证冲突）。
- 因此改用 **Codex OAuth（Codex CLI 同款公开流程，设备码 + 令牌刷新）**，
  用 Codex 客户端在用的 `GET https://chatgpt.com/backend-api/wham/usage` 读 5h / 周窗口。
  用户已批准「插件私有凭据」：登录态只进本插件自己的凭据记录，不改配置、不写别的插件的登录态。
- 用户进一步要求**同一插件里保存多个 ChatGPT 账户并切换**（不必反复退出/重登），
  因此记录从单账户升级为 v2 集合，上限 **8** 个、单选生效。

**怎么改（已落地，复核用）**

1. `plans/codex.js`：`fetchPlan` **恒走 account**；`codexSource` 字段保留仅为旧 YAML / 旧摘要 /
   旧 wire 兼容，**不再参与分派**。`plans/codex-sources.js` 的三值闭集与归一函数保留为**死代码**。
2. Host OAuth 模块 `plans/codex-account.js`：设备码申请 → 轮询 `…/deviceauth/token` → 兑换
   `POST https://auth.openai.com/oauth/token`（`grant_type=authorization_code`，
   `redirect_uri=https://auth.openai.com/deviceauth/callback`，
   `client_id app_EMoamEEZ73f0CkXaXp7hrann`）→ 写 **v2 记录** `dsh-usage-dock/codex`（kind `grant`；
   `accounts` 1..8、`credentialId`/`accountId` 各自唯一、`activeAccountId` 必须命中）。
   **v1 单账户读兼容、任何写操作后落 v2**。
3. 额度：读 active 账户 → 需要时刷新 → `GET …/wham/usage`
   （`Authorization: Bearer` + `chatgpt-account-id`）→ 归一成 `remaining` 百分比。
4. 账户操作：添加 = 新 `credentialId`（`randomUUID`）追加并设为 active；同 `accountId` 重登 = **upsert**
   （保留 `credentialId`、`revision + 1`、active 跟随）；select = 只改 `activeAccountId`；
   remove = 只删指定 id，移除最后一个时删除整条记录并回到未登录；满 8 个返回 `limit`、不写。
5. 设置页 Codex 卡片：账户列表**上方**整行「添加账户」；每行 radio +「账号名 · 订阅类型」；
   **仅选中行**在同一行最右显示「重新登录 / 退出登录」；设备码等待区 + 六态状态机
   （未登录 / 等待设备码 / 已登录 / 过期 / 失败 / 取消）；**没有任何**令牌输入框。
6. 原生（DSH Go）半：来源下拉与一键适配入口**已删除**，Codex 分组只剩开关与阈值；
   手机端**没有登录/切换入口** ⇒ 需在桌面网页版操作，手机端只读同一份记录。
7. 身份：`identityOfChannel('codex')` **只**追加 `acct=<快照>`；快照 =
   `acct:<accountId sha256 前 8>@<credentialId 前 8>r<revision>`（或 `none` / `unknown`）。
   **不再含** `codexSource` 或第三方 service 的实例/revision；切换/重登/移除/刷新后更新。
8. 测试（2026-11-25 最终回归）：`test-codex-account` **242** / `test-codex-account-host` **46** /
   `test-codex-account-ui` **100** / `test-dsh-go-native` **53** / `test-dsh-go-boundaries` **29**
   （含账号切换身份隔离 C1b/C1c/E1b）；关键 13 套件共 **785 项全绿**，另有 `test-review-fixes` 40。
   已删除的退场测试：`test-codex-sources`、`test-codex-source-ui`、`test-codex-patch-ui`、
   `test-codex-adapt-ui` —— **不要再列为待跑**。

**约束**

- **不集成 SIWC 代码**，不复制其常量（许可证原因），也不依赖 `@siwc/local`（未发布 npm）。
- **只保留本插件账号**：不再有 `connect` / `subscription` 可选；相关代码可保留为死代码，
  但**活动路径、设置页、原生页都不使用**。**账户之间不合并**：胶囊/详情只显示 active 账户的数字，
  切换账户即作废旧值与在途结果，失败也不会改用另一个账户的数字。
- **令牌不出 Host**：v2 payload 只含 `version` / `activeAccountId` / `accounts`，credential 只含
  `type`（固定 `'oauth'`）/ `access` / `refresh` / `expires` / `accountId` / `credentialId` /
  `revision` / `savedAt`，外加可选的 `planType` / `email`；白名单外的 key、重复 id、超过 8 个、
  `activeAccountId` 未命中一律判 `incompatible`；都不进 wire、不进 `usage_status` 投影、
  不回显浏览器、不写配置。
- **刷新只锁本插件自己的记录**：`ctx.credentials.modifyRecord` 的独占写**只防本插件内部**
  并发覆盖（同一次采集的并发、多进程/多面板同时刷新）；先在 `accounts` 里按 `credentialId`
  定位账户（不按 active 猜），写事务内**不用 `revision` 判定**，两条路径判据不同：
  - **普通路径**（调用方已判定 access 过期）：**同一 `credentialId` 仍在 + 该账户仍未过期（`expires`）**
    才写——账户被移除/换 id 不写、记录已新鲜（别人刷过）不写；
  - **401/403 强制路径**：**即使 `expires` 还没到也强制刷一次**（否则「未过期但被上游吊销」永远刷不动），
    写事务内改按「同一 `credentialId` + **我们刚用过的那个 `access` 没被别人换掉**」复核，
    写入时 **`accountId` / `credentialId` / `revision` 一律不变**，只换该账户的
    `access` / `refresh` / `expires` / `savedAt`，**其它账户与 `activeAccountId` 原样保留**。
  它**不防**其它客户端（Codex CLI / `openai-codex` flow / Codex Connect）在**同一账号**上轮换
  refresh token —— 那种情况下本插件登录会失效并提示「登录已过期，请重新登录」（已知边界，不在本轮修）。
- **不跟随重定向（`redirect:'manual'`，3xx 按失败处理）**；单请求 15 秒超时、响应体 ≤ 512 KiB、
  只接受 JSON 对象；设备码登录 Host 侧总时限 15 分钟；未启用渠道 / 未登录时**零请求**，
  切换账户不额外请求上游。
- 上游错误原文与令牌片段一律不进界面，只给固定文案 + 固定错误码。
- 不注册 `openai-codex` adapter、不改宿主模型路由（只读额度）。

**已知行为（终审记录，均已如实写进主文档 §6.1）**

- **启动身份快照是 fire-and-forget**：Host `apply` 时异步读一次记录刷新同步身份快照
  （`acct:<accountId hash 前 8>@<credentialId 前 8>r<revision>`）；首个采集若赶在快照就位之前，
  可能**短暂**显示「本次采集已作废，等待最新额度」，**下一轮自愈**，不伪造数字。
- **坏记录恢复入口已补**：`GET …/codex-account/state` 返回 `signedIn:null` + `reason` 时，
  界面进入「状态不可知」（坏记录与一般不可用是两段固定文案），不冒充未登录、不显示数字，
  并给恢复入口：**「重试」**（再问一次 Host）、**「重新登录」**（仅 `canLogin !== false` 时给，
  Host 侧会用新登录覆盖坏记录）、**「退出登录」**（仅 `canLogin === true` 时给）；
  Host 未提供凭据服务（**`no-credentials`**、`canLogin:false`）时**只给「重试」**，不给登录/退出。
  Host 严格校验记录：缺字段 / 类型错 / `expires` 非正 / `revision` 非法 / 重复 id / 超过 8 个 /
  `activeAccountId` 未命中 / 白名单外 key 一律 `incompatible`，不「尽力清洗」。
- **多账户边界**：满 8 个时添加被拒绝且不驱逐旧账户；同一账号重登是 upsert、不会新增第二行；
  切换只改 active、不刷新 token；移除 active 后落到剩余第一个；移除最后一个后删除整条记录、
  界面回到未登录。
- **关闭设置页/面板 ≠ 取消登录**：客户端只停止展示轮询，Host 侧登录尝试继续到「取消」或 15 分钟超时。

**验收**

- 离线：v2 白名单 / `accounts` 1..8 / id 唯一 / `activeAccountId` 命中 / v1 读兼容；
  添加 / 同账号重登 upsert / select / remove / 移除最后一个 / 满 8 个 `limit`；
  刷新写入复核（**普通路径**按 **`credentialId` + `expires`**；**401/403 强制路径**按
  **`credentialId` + 用过的 `access` 未被换掉**，且其它账户与 active 不变）；
  端点常量与请求形状、3xx 按失败处理、错误分类与固定文案、状态机迁移（含取消、超时、
  被上游拒绝、关面板只停客户端轮询、取消/失败后回读 Host 真实状态）、
  账户隔离（切换作废旧值、不混用数字）、身份快照 `acct=…r<revision>`、摘要两端一致（跨端向量）。
- **真机（未做，发布前必须）**：桌面设备码登录 → **添加第二个账户 → 切换看数字跟随 → 移除 active →
  移除最后一个 → 重新登录**；access 过期后自动刷新恢复；手机端读取桌面登录结果的显示；
  其它客户端轮换同一账号 token 后本插件是否如实提示「请重新登录」（**不期望「互不踢下线」**）。
- **手机端登录/切换能力按「不可用」写**：原生设置页已无来源与登录入口，需桌面网页版操作。
- **只有离线测试通过不等于可用**；未完成真机验收不得发布，且当前**未部署 / 未提交 / 未发布**。
