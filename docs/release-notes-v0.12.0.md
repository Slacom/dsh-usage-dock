# dsh-usage-dock 0.12.0（**草稿，未发布**）

> ⚠️ **本文是草稿**，不代表已发布、已验收。
> - 未经**用户真机验收**，**不得**打 tag、不得发 npm / GitHub Release、不得写「已发布」字样；
> - 测试数字为 **2026-11-25 最终回归**结果（见「工程细节」，禁止填估计值）；
> - 面向用户的措辞需与最终实现一致后再定稿。
>
> 协议与边界记录：[codex-account-oauth-20261122.md](codex-account-oauth-20261122.md)；
> 待办口径：[backlog.md](backlog.md) §5。上一正式版：**0.11.3**。

## 更新摘要

### Codex 改为「只用本插件登录」并支持多账户（设备码）

- 「设置 → 内置插件 → Usage Dock → OpenAI Codex」不再提供「额度来源」选择：
  `Codex Connect` 与 `Codex Subscription` 两个来源**已退场**——设置页不再出现来源单选 / 摘要 /
  来源说明 / Subscription 一键适配块，DSH Go 原生设置页也不再显示 `codexSource` 下拉与适配入口。
  插件只用自己的 **ChatGPT 账号登录**（设备码）读 5 小时 / 周窗口额度，
  **不再需要**为了看额度安装 `dsh-codex-connect` 或维护 `dsh-codex-subscription` 的本地补丁。
- **多账户**：可保存 **最多 8 个** ChatGPT 账户，**单选生效**；胶囊与详情只显示当前选中账户的数字。
  账户列表**上方**有占满整行的「添加账户」；每行 radio +「账号名 · 订阅类型」，
  **只有选中那一行**在同一行最右侧显示「重新登录 / 退出登录」。
- **账户操作**：添加（设备码登录，追加并设为选中）、同账号重登（覆盖该账户，不会变成第二行）、
  切换（只改 active，不动令牌）、移除（只删指定账户；移除最后一个后删除记录并回到未登录）。
- 记录升级为 **v2**（`{version:2, activeAccountId, accounts:[…]}`）；旧 v1 单账户记录**读兼容**，
  任何写操作后落 v2，无需用户迁移。
- 登录态只保存在本插件自己的凭据记录里：**不写配置、不读写其它插件的登录态、不回显令牌**。
- 登录 / 切换 / 移除入口在**桌面网页版设置页**；手机端原生设置页只能看结果，
  **不能完成登录或切换账户**（见「已知限制」）。
- 状态提示：未登录 / 等待验证码 / 已登录 / 登录已过期 / 失败（固定错误码）/ 已取消；
  另有账户切换、移除失败的固定文案。**超过 8 个账户时保存会失败，客户端当前显示通用登录失败
  文案（专用上限提示待后续补）**。

### 渠道调整：WorkBuddy 退场，原生渠道收敛为 4 个

- **WorkBuddy 不再是本插件的原生 / 内置渠道**（0.12.0，用户不再使用反代渠道）：
  没有专用开关、积分口径、账号筛选，原生额度面板里也没有 WorkBuddy 分组；
  `plans/workbuddy.js` 已删除，`workbuddy` / `workbuddy-ai` 两个 id 都进入 `RETIRED_PLAN_IDS`
  （不取数、不复活，旧配置里的字段保留但不生效）。
- **如仍需要，请用「自定义余额渠道」添加**：在「设置 → 模型」里选已有的 WorkBuddy2API 来源，
  再填该来源下的余额接口路径（如 `/v1/credits`）与结果 JSON 键路径。
- 原生 / 内置渠道现为 **4 个**：**OpenCode Go、DeepSeek、OpenAI Codex、小米 MiMo**；
  原生额度面板默认顺序改为 **DeepSeek → MiMo → Codex → OpenCode Go**
  （已保存的渠道顺序设置仍优先）。
- 6 个 WorkBuddy 专用测试随渠道退场删除：`test-workbuddy-contract`、`test-workbuddy-expiry-label`、
  `test-workbuddy-legacy-selection`、`test-workbuddy-round8`、`test-workbuddy-client-credits`、
  `test-workbuddy-gateway`——不要再把它们列为待跑。
- 历史发布说明（≤ 0.11.3）里的 WorkBuddy 记录保留，只作沿革，不代表本版现状。

### MiMo 登录退场：只保留 API Key 余额

- **0.12.0 起 MiMo 不再有扫码登录 / 记住登录 / 控制台 Cookie**：
  `plans/mimo-auth/**`（**15 个文件**）、`plans/mimo-legacy-store.js`、client 侧扫码 / 记住登录 UI、
  Host 侧 legacy 凭据记录与 display 覆盖**全部删除**。
- `dshGo.contributes.panels` 从 3 个减为 **2 个**（`quota` / `settings`）；`mimo-login` 面板与
  原生登录入口移除，原生设置页的 MiMo 分组只剩渠道开关、余额提醒与额度策略。
- **唯一凭据是 API Key**：插件设置里的 `mimoApiKey`，或「设置 → 模型」里的 MiMo Key
  （`XIAOMI_API_KEY` 等固定名；provider 名含 mimo/xiaomi 时自动匹配）。没有 Key 时固定返回
  `no-key`（**零请求**）；401/403 提示重新填写 Key。**不再有** Cookie / 扫码 / remembered /
  登录态过期。
- 除 `test-mimo-api-key`（**17 项**）外，**36 个 `test-mimo*` 套件已删除**（auth / console /
  display / remembered / legacy-store / footer-refresh / usage-lane / parse 等），不要再列为待跑。
- 历史 MiMo 文档（`docs/mimo-*.md`）与旧发布说明保留，只作沿革；**不代表本版已发布**。

### 测试回归（2026-11-25 收口）

- **关键 13 套件共 785 项全绿**：`test-dsh-go-boundaries` 29 / `test-usage-recheck-f1f2` 17 /
  `test-mimo-api-key` 17 / `test-dsh-go-native` 53 / `test-degrade-refresh` 41 /
  `test-settings` 17 / `test-settings-layout-20261024` 30 / `test-config-unwrap` 22 /
  `test-usage-tool` 103 / `test-codex-account` 242 / `test-codex-account-host` 46 /
  `test-codex-account-ui` 100 / `test-line-endings` 68；另有 `test-review-fixes` **40** 项通过。
- **全部 WorkBuddy / MiMo 相关改动套件通过**；36 个 `test-mimo*` 已删除，仅留
  `test-mimo-api-key`（17 项）。**0.12 未发布、未真机验收。**

### 其它（待定稿）

- 待补：本轮随包的其它修复与文案调整。

## 重要前提

1. **不是官方支持的接口**：额度来自 `GET https://chatgpt.com/backend-api/wham/usage`，
   这是 **Codex 客户端在用的内部接口**，OpenAI 未承诺第三方使用，**可能随上游改版失效**。
   失效时 Codex 渠道会给出固定错误（不发散上游原文），需要等插件适配。
2. **不是 OpenAI 授权的第三方集成**：本实现使用 Codex CLI 公开的 OAuth 流程与公开客户端 ID，
   做法与 Codex Connect 等社区工具相同，但**没有 OpenAI 的明确授权**。
   留意账号条款风险；不想承担该风险的用户可以在本插件里关闭 Codex 渠道
   （来源已不可选，没有「换回 Codex Connect」这条退路）。
3. **没有集成官方 SIWC**：官方 `openai/sign-in-with-chatgpt-devkit` 不提供额度读取
   （其 `packages/local` 只到 OAuth / 凭据 / 账号资料 / 模型目录 / Responses 流；
   用它的令牌调额度接口实测 401 `no_matching_rule`；OpenAI 在 issue #3 回复「暂不支持」），
   且其许可证为 Noncommercial License v1.0、`@siwc/local` 未发布 npm —— 因此**不引入其任何代码**。
4. **令牌不出 Host**：access / refresh 只存在 Host 侧凭据记录中，不下发浏览器、不写配置、
   不进 `usage_status` 工具有的任何字段。
5. **账户之间不合并**：胶囊与详情仍是**一行 Codex**；只显示当前选中账户的数字，
   切换账户会让旧值与在途结果作废，不同账户的百分比绝不混用；某个账户失败时也不会改用另一个账户的数字。

## 已知限制

- **上游接口可能变**：`/wham/usage` 一旦改变结构或鉴权规则，Codex 渠道会显示失败（固定错误码），
  不会自行降级去猜数值。
- **来源已不可切换（明确变更）**：`Codex Connect` / `Codex Subscription` 两个来源在网页设置页与
  DSH Go 原生设置页都已移除，本版**没有**「改回旧来源」的 UI 开关。担心账号条款风险时，
  只能在 Usage Dock 里关闭 Codex 渠道。
- **刷新只锁本插件自己的记录**：`ctx.credentials.modifyRecord` 的独占写**防的是本插件内部**
  （同一次采集的并发、多个进程/面板同时刷新同一条记录）互相覆盖；事务内先按 `credentialId`
  定位账户，再以 **`credentialId` + `expires`** 二次检查（账户被移除/换 id 不写、记录已新鲜不写），
  其它账户与 `activeAccountId` 原样保留。
  它**不防**其它客户端（Codex CLI / `openai-codex` flow / Codex Connect 等）在**同一账号**上轮换
  refresh token —— 那种情况下本插件手里的 refresh 会被上游拒绝，界面如实提示「登录已过期，请重新登录」。
- **refresh token 行为未实测**：轮换、撤销、在别处登录导致失效、**多账户切换后额度归属**，
  都要按上游实际表现验证（本轮未做）。
- **窗口口径未实测**：5 小时窗口 / 周窗口的重置时间与「剩余百分比」是否符合上游当前实际，
  需真机比对 Codex 客户端显示的数值。
- **多账户未真机验证（明确限制）**：最多 **8** 个账户、单选生效、添加 / 重登（upsert）/ 切换 / 移除
  都只有离线测试；尚未在真实桌面验证「切换后数字跟随」「移除 active 后落到剩余第一个」
  「已满 8 个时拒绝添加」。真实账号目前只成功登录过**一个**账户一次。
- **手机端不能完成登录 / 切换（明确限制）**：移动端原生设置页已没有来源选项与登录入口，
  移动端也没有网页版设置页 ⇒ **无法在手机端添加、重登、切换或移除账户**；
  需先在**桌面网页版设置页**操作，手机端只读取同一份记录。设备码流程在 App 内是否可用也**未验证**。
- **启动时可能短暂显示「本次采集已作废」**：Host 启动时异步（fire-and-forget）读一次记录刷新身份快照，
  若首个采集赶在快照就位之前，界面可能**短暂**显示「本次采集已作废，等待最新额度」，
  **下一轮采集自愈**；不是数据错误，也不会显示伪造数字。
- **本机记录坏了 / 不可读时**：界面进入「状态不可知」（坏记录与一般不可用是两段固定文案），
  **不冒充未登录、不显示数字**，并给恢复入口：「重试」、「重新登录」（无凭据服务以外的情形）、
  「退出登录」（Host 明确凭据服务可用时）。Host 未提供凭据服务（`no-credentials`）时只给「重试」，
  不给登录/退出按钮。Host 对记录做严格校验（缺字段 / 类型错 / `expires` 非正 / 重复 id /
  超过 8 个 / 白名单外 key 一律 `incompatible`），坏记录不会被「尽力清洗」后继续使用。
- **取消或登录失败后以 Host 的真实状态为准**：客户端会回读登录态——原本已登录的用户取消一次重登，
  仍显示「已登录」并保留「已取消登录」提示，不会被本地写成未登录。
- **等待登录时关掉面板不等于取消**：客户端只是停止展示轮询；Host 侧的登录尝试仍在继续，
  直到点「取消」或 **15 分钟**上限到期。
- **无浏览器回调备用路径**：本轮只做设备码；本机回调 / 手动粘贴回调 URL 的兜底方案未实现。
- 沿用 0.11.x 的既有已知问题（见 `AGENTS.md` §7 与各版发布说明），本版不额外修复。
  2026-11-23 的 **8 个失败名单已过期**（其中 5 个 MiMo 登录套件已删除）：本轮最终回归的
  关键 13 套件 **785 项全绿**，另 `test-review-fixes` **40** 项通过；
  `test-codex-auto-adapt`、`test-fetch-backends` 等旧套件不在关键清单内，**不据此声称全仓全绿**。
  **全部 WorkBuddy / MiMo 相关改动套件通过。**
- **MiMo 没有登录能力（明确变更）**：本版只支持 API Key 余额，**不再提供扫码 / 记住登录**；
  迁移方式是直接在「设置 → Usage Dock → Xiaomi MiMo」填 `mimoApiKey`，或在「设置 → 模型」里配好
  MiMo Key。没有 Key 时显示「未配置 API Key」，不会回退到 Cookie 或旧记录。

## 工程细节（测试数字为 2026-11-25 最终回归）

| 项 | 内容 |
| --- | --- |
| 取数来源 | **只有** account：本插件记录 `dsh-usage-dock/codex` + `/wham/usage`。`connect` / `subscription` 已退场，`codexSource` 配置字段仅作兼容（`plans/codex.js#fetchPlan` 恒走 account），设置页与原生页不再有来源选择 |
| 记录 | `dsh-usage-dock/codex`，kind `grant`；**v2 payload** `{version:2, activeAccountId, accounts:[credential…]}`；`accounts` **1..8**，`credentialId` / `accountId` **各自唯一**，`activeAccountId` 必须命中；credential 必填 `type`（`'oauth'`）/ `access` / `refresh` / `expires` / `accountId` / `credentialId` / `revision` / `savedAt`，可选 `planType` / `email`；白名单外 key、重复 id、超过上限、active 未命中一律 `incompatible`；**v1 单账户读兼容、写后落 v2** |
| 账户操作 | 添加 = 新 `credentialId`（`randomUUID`）追加并设为 active；同 `accountId` 重登 = **upsert**（`credentialId` 不变、`revision + 1`、active 跟随）；select = 只改 `activeAccountId`；remove = 只删指定 id，移除最后一个时删除整条记录 |
| UI 布局 | 「添加账户」**占满整行**且在列表上方（无账户时也在）；账户行 = radio +「账号名 · 订阅类型」（名称 14px/primary/500、计划 13px/secondary、名称区省略号不换行）；**仅选中行**在同一行最右显示「重新登录 / 退出登录」 |
| OAuth 端点 | 设备码 `POST https://auth.openai.com/api/accounts/deviceauth/usercode`；验证页 `https://auth.openai.com/codex/device`；轮询 `POST …/deviceauth/token`；兑换/刷新 `POST https://auth.openai.com/oauth/token`；回调 `https://auth.openai.com/deviceauth/callback`；`client_id app_EMoamEEZ73f0CkXaXp7hrann` |
| 额度端点 | `GET https://chatgpt.com/backend-api/wham/usage`（Bearer + `chatgpt-account-id`，取 active 账户） |
| 刷新一致性 | 同一 `credentialId` single-flight；结果只在 `ctx.credentials.modifyRecord` 独占写内落地（**非** `revision` 判定）。先在 `accounts` 里按 `credentialId` 定位账户；**普通路径**只在 access 已过期时刷新，事务内按 `credentialId` + `expires` 复核；**401/403 会强制刷新一次（即使未过期）**，事务内改按「同一 `credentialId` + 我们刚用过的 `access` 没被别人换掉」复核。写入时 `accountId` / `credentialId` / `revision` 不变、只换该账户 token 与 `expires`，**其它账户与 `activeAccountId` 原样保留**。只防本插件内部并发覆盖，**不防**其它客户端轮换同一账号的 refresh token |
| 身份 | `identityOfChannel('codex')` **只**追加 `acct=<快照>`；快照 = `acct:<accountId sha256 前 8 位>@<credentialId 前 8 位>r<revision>`（或 `none` / `unknown`）。不再含 `codexSource`，也不再含第三方 service 的实例 / revision |
| 摘要 | Host `configDigestOf` 与客户端 `codexSource.digestPart` 仍是「非 `connect` 即追加 `builtin:codex-source\u0002<source>`」（同位置、逐字同构）——**只为旧配置 / 旧 wire 的摘要不漂移**，不代表来源选择仍生效；有跨端向量用例 |
| 依赖边界 | 不依赖 `dsh-codex-connect` / `dsh-codex-subscription`；不注册 `openai-codex` adapter；不 import SIWC。来源探测与 Subscription 补丁相关模块/路由**保留为死代码**，活动路径不再使用 |
| 网络限制 | `redirect:'manual'` 且 **3xx 按失败处理**；单请求 **15 秒**超时、响应体 **≤ 512 KiB**、只接受 JSON 对象；设备码登录 Host 侧总时限 **15 分钟**；未启用 / 未登录时**零请求**，切换账户不额外请求上游 |
| 测试数字 | **2026-11-25 最终回归**：关键 **13 套件共 785 项全绿**（`test-dsh-go-boundaries` 29 / `test-usage-recheck-f1f2` 17 / `test-mimo-api-key` 17 / `test-dsh-go-native` 53 / `test-degrade-refresh` 41 / `test-settings` 17 / `test-settings-layout-20261024` 30 / `test-config-unwrap` 22 / `test-usage-tool` 103 / `test-codex-account` 242 / `-host` 46 / `-ui` 100 / `test-line-endings` 68），另有 `test-review-fixes` **40** 项通过；**全部 WorkBuddy / MiMo 相关改动套件通过**。2026-11-23 的 102/94 产生于 MiMo 清理前，已过期不能引用。 |
| 旧失败名单口径 | 2026-11-23 的 8 个失败名单已过期：其中 5 个 MiMo 套件已删除；`test-codex-auto-adapt`、`test-fetch-backends` 等旧套件不在本轮关键清单内，**不据此声称全仓全绿**；本轮关键 13 套件 785 项与 `test-review-fixes` 40 项均通过。 |
| 已删除 | `plans/workbuddy.js` + 6 个 WorkBuddy 套件 + 1 个 WorkBuddy debug 脚本；`plans/mimo-auth/**`（15 文件）+ `plans/mimo-legacy-store.js` + 36 个 `test-mimo*` 套件 + client 扫码/记住登录 UI + Host legacy 记录/display 覆盖 + `mimo-login` 面板；**未发布、未真机验收** |
| 未做的验证 | 真机设备码登录、令牌刷新、真实取数、**多账户切换 / 移除 / 满 8 个**、手机端登录（明确不可用）、跨客户端轮换 token 的真实表现；**未部署、未发布、未经用户验收** |

## 发布检查表（全部满足才允许发布）

- [ ] 用户真机验收通过（桌面：登录 / **多账户切换与移除** / 过期恢复 / 数值与 Codex 客户端一致）
- [ ] 手机端口径确认：**明确写「手机端不能完成登录或切换，需桌面网页版操作」**
- [x] 离线测试数字已按 2026-11-25 最终回归补齐：关键 13 套件 **785 项全绿** + `test-review-fixes` 40；
      全部 WorkBuddy / MiMo 相关改动套件通过（2026-11-23 的 102/94 已过期，不得照抄）
- [ ] 渠道口径确认：README / AGENTS.md 的「现行渠道」段只列 4 个原生渠道（OpenCode Go / DeepSeek /
      OpenAI Codex / 小米 MiMo）+ 自定义余额渠道；WorkBuddy 明确标为已退场并引导到自定义余额渠道；
      **MiMo 明确写「只用 API Key，无扫码/记住登录」**；6 个 WorkBuddy 专用测试与 36 个 MiMo 登录测试
      不再出现在任何待跑列表里
- [ ] `README.md` 与 `AGENTS.md` §7 的口径与实现一致
- [ ] 版本号、tag、dist-tag、GitHub Release 由用户确认后再执行（本文件不预设版本发布形态）
