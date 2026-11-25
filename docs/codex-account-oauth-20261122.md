# Codex 独立登录：插件私有 Codex OAuth + 多账户（2026-11-22 协议记录，2026-11-23 多账户更新）

> 状态：**0.12.0 开发中（未发布、未真机验收）**。Codex 渠道**只剩本插件自己的 ChatGPT 账号登录**
> 一条来源（`connect` / `subscription` 已退场），并已扩展为**多账户**（最多 8 个、单选生效）。
> 以下是协议、记录形状、账户操作、UI 与边界记录。
> 本轮只做**本地实现 + 离线测试**，**不等同真机验收、不等同已发布**；未经用户验收不得发布
> （见 [release-notes-v0.12.0.md](release-notes-v0.12.0.md)）。
> 历史口径（**已退场，仅作沿革记录**）：Codex 双来源见 [codex-source-ui-20261111.md](codex-source-ui-20261111.md)、
> [codex-source-host-adapter-20261111.md](codex-source-host-adapter-20261111.md)；
> 未完成事项见 [backlog.md](backlog.md) §5。

## 1. 结论先行

### 1.1 为什么不集成官方 SIWC（`openai/sign-in-with-chatgpt-devkit`）

| 事实 | 后果 |
| --- | --- |
| `packages/local` 只提供 **OAuth、凭据存储、账号资料、模型目录、Responses 流**，**没有额度读取 API** | 用它拿不到「剩余额度」，本插件的核心诉求无法满足 |
| 常量 `CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage"` 只是**网页链接**，不是数据接口 | 不能被当作取数端点；只能引导用户自己去看网页 |
| 用 SIWC 的 access token 调 `GET https://chatgpt.com/backend-api/wham/usage` → **401 `no_matching_rule`** | 「用 SIWC 登录 + 调额度接口」这条路**实测不通**（返回码就是 `no_matching_rule`） |
| OpenAI 在 SIWC 仓库 issue #3 官方回复：“This is not supported at the moment. We may build this in the future.” | 额度读取**官方明确不提供**，不能假设短期会补齐 |
| 许可证是 **Sign-in with ChatGPT DevKit Noncommercial License v1.0**；`@siwc/local` 是 private workspace、**未发布 npm** | 引入其代码会带来许可证与分发冲突（见 §7） |

**结论：本项目不集成 SIWC 代码，也不复制其常量/源码。**

### 1.2 为什么仍然能拿到额度

额度来自 **Codex OAuth（Codex CLI 同款公开流程）** 的登录结果：

- 设备码登录 → 拿到 ChatGPT 账号的 access / refresh token；
- 用该 token 调 `GET https://chatgpt.com/backend-api/wham/usage`（Codex 客户端自己在用的接口）；
- 返回 5 小时窗口 / 周窗口的剩余百分比与重置时间。

这条路能通，是因为拿的是**Codex 客户端身份的令牌**（同一 `client_id`），而不是 SIWC 那份被规则拒绝的令牌。
**代价是它属于「与 Codex 客户端同构」的做法，不是 OpenAI 明确授权的第三方集成**（§7 如实写明）。

用户已批准本项目采用**插件私有凭据**方案：登录态只存在本插件自己的凭据记录里，不改 DSH 配置、
不写任何其它插件的登录态、不把令牌交给浏览器。

同一份记录里可以保存**多个账号**（1..8 个），但任何时刻只有被选中的那个（active）参与取数；
切换账户只改「谁生效」，不复制、不合并不同账号的额度。

## 2. 协议时序与固定端点

### 2.1 端到端时序（设备码）

```
[Host] ① POST https://auth.openai.com/api/accounts/deviceauth/usercode
        body: client_id=app_EMoamEEZ73f0CkXaXp7hrann
        → 返回「给用户看的验证码」+「本机轮询用的凭据」+ 轮询间隔
[UI]   ② 显示验证码，提示打开 https://auth.openai.com/codex/device 并输入
[用户] ③ 在浏览器完成登录/授权
[Host] ④ 按间隔轮询 POST https://auth.openai.com/api/accounts/deviceauth/token（JSON）
        （未授权 pending → 继续轮询；上游要求降速 → 间隔递增；授权完成 → 授权码 + PKCE code_verifier；
          过期/拒绝 → 终止并报固定错误码）
[Host] ⑤ POST https://auth.openai.com/oauth/token（form 表单）
        grant_type=authorization_code
        code=<④的授权码>&code_verifier=<④的 code_verifier>
        redirect_uri=https://auth.openai.com/deviceauth/callback
        client_id=app_EMoamEEZ73f0CkXaXp7hrann
        → access_token / refresh_token / 过期时间 / 账号声明（access JWT 的 AUTH 声明）
[Host] ⑥ 把令牌写入凭据记录 `dsh-usage-dock/codex` 的 **v2 payload**（新增账户追加、同账号重登 upsert，
        见 §3），浏览器只拿到「已登录/未登录」与账户列表状态
[Host] ⑦ GET https://chatgpt.com/backend-api/wham/usage
        Authorization: Bearer <active 账户的 access_token>
        chatgpt-account-id: <active 账户的 accountId>
        → 5h / 周窗口的剩余百分比与重置时间
[Host] ⑧ access 过期 → grant_type=refresh_token 刷新（只在记录独占写里落地，
        事务内按 credentialId 定位该账户并复核，见 §2.3 / §3.4）
```

**固定端点（实现里只允许这几个字面量，不做拼接、不读配置覆盖）**

| 用途 | 方法与 URL |
| --- | --- |
| 设备码申请 | `POST https://auth.openai.com/api/accounts/deviceauth/usercode`（JSON `{client_id}`） |
| 用户授权页（打开给用户） | `https://auth.openai.com/codex/device` |
| 设备码轮询 | `POST https://auth.openai.com/api/accounts/deviceauth/token`（JSON `{device_auth_id, user_code}`） |
| 授权码兑换 | `POST https://auth.openai.com/oauth/token`（form：`grant_type=authorization_code` + `code` + `code_verifier` + `client_id` + `redirect_uri`） |
| 兑换回调地址 | `https://auth.openai.com/deviceauth/callback` |
| 令牌刷新 | `POST https://auth.openai.com/oauth/token`（form：`grant_type=refresh_token` + `refresh_token` + `client_id`） |
| 额度读取 | `GET https://chatgpt.com/backend-api/wham/usage` |
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann`（Codex CLI / pi-ai 公开使用的客户端 ID） |

> **字段名以上游当前实现为准**：本文只记录端点与语义，不把上游响应体的具体键名写成契约；
> 解析失败必须走「结构异常」分支，**不猜测、不填 0**。

### 2.2 额度读取

- 请求头固定两条：`Authorization: Bearer <access>`、`chatgpt-account-id: <accountId>`。
- 响应按窗口归一成**剩余百分比**（`percentMode: 'remaining'`，与本插件 Codex 现有口径一致）：
  `percent === 0` 是**有效值**（额度用尽），不得当成缺数据；
  窗口不在响应里就不显示该窗口（不补 0、不沿用上次值掩盖）。
- 额度请求返回 **401/403** → **强制刷新一次**（即使本地记录看起来未过期也刷）并**重试一次**取数；
  此时仍 401/403 才判「需要重新登录」（固定文案「ChatGPT 登录已过期，请重新登录」）。
  **不会**无限重试，也不会改用其它渠道或另一个已保存账户的数字。
- 刷新被上游拒绝（`invalid_grant` / `invalid_refresh_token` / `token_expired` 等）同样落到
  「需要重新登录」；上游的 `error` 码**只参与判定**，原文不外泄。
- 其它网络 / 5xx / 429 / 3xx / 结构异常按「暂时失败或固定错误」处理，不猜数值。

### 2.3 刷新与并发（**边界要说准**）

- 刷新只在 **Host** 发起，条件是 active 账户的 access 已过期（或即将过期）；同一 `credentialId` 的并发
  刷新走 single-flight，只会打一次 `grant_type=refresh_token`。
- 刷新结果落在 `ctx.credentials.modifyRecord(CODEX_ACCOUNT_RECORD_KEY, …)` 的**独占写**里：
  按 `credentialId` 在 v2 的 `accounts` 数组里定位该账户（**不按 active 猜**，所以切换账户不会让在途刷新
  写错人），写事务内**二次检查**（**不用 `revision` 判定**），**两条路径的判据不同**：
  - **普通路径**（调用方已判定 access 过期）：判据是 **同一 `credentialId` 仍在 + 该账户仍未过期（`expires`）**；
    账户已被移除/换 id ⇒ 已不是同一账户，**不写**；同 `credentialId` 且记录已新鲜 ⇒ 别人刷过了，**不写**；
  - **401/403 强制路径**：即使本地 `expires` **还没到也真的去换一次**（否则「未过期但被上游吊销」永远刷不动）。
    写事务内复核 `credentialId`，判据换成「**我们刚用过的那个 `access` 有没有被别人换掉**」：
    没被换掉就写；被换掉说明别人已经处理了这次失效 ⇒ 放弃写入并采用别人的记录。
    写入时 **`accountId` / `credentialId` / `revision` 一律不变**，只换该账户的 `access` / `refresh` / `expires` / `savedAt`；
    **其它账户与 `activeAccountId` 原样保留**。
- **这个锁只保护本插件自己的那条记录**（`dsh-usage-dock/codex`）：
  - **防**：本插件内部（同一次采集的并发、多个进程/多个面板同时刷新同一记录）互相覆盖；
  - **不防**：其它客户端（Codex CLI、`openai-codex` flow、Codex Connect 等）在**同一账号**上轮换
    refresh token。它们换过之后，本插件手里的 refresh 会被上游拒绝（`invalid_grant` 一类），
    表现为「登录已过期，请重新登录」——这是**已知边界**，不是锁能解决的问题，也不在本轮修复范围。
- 账户身份的生命周期：**新增账户**才生成新的 `credentialId`；**同一 `accountId` 重新登录是 upsert**
  （保留 `credentialId`、`revision + 1`），因此旧观察会因 `revision` 变化而作废、但在途刷新仍指向同一账户；
  刷新 token **不改变 `revision`**，不会误触发「账户变了」。

## 3. 记录形状、迁移与账户操作

### 3.1 v2 记录（唯一写盘形状）

| 项 | 值 |
| --- | --- |
| 记录名 | `dsh-usage-dock/codex` |
| kind | `grant` |
| payload | `{ version: 2, activeAccountId, accounts: [credential, …] }` |
| `accounts` | **1..8** 个 credential（`MAX_CODEX_ACCOUNTS = 8`）；数组顺序 = 界面账户顺序 |
| `activeAccountId` | 必须命中某个 credential 的 `credentialId`（恰好一个 active） |
| credential 必填 | `type`（固定 `'oauth'`）/ `access` / `refresh` / `expires` / `accountId` / `credentialId` / `revision` / `savedAt` |
| credential 可选 | `planType` / `email` |
| 白名单 | payload 只允许 `version` / `activeAccountId` / `accounts`；credential 只允许上面这些字段。**多一个 key 即 `incompatible`**，不透传、不「尽力清洗」 |
| 唯一性 | `credentialId` 与 `accountId` **各自唯一**；重复即 `incompatible` |
| 不写入 | 配置（不 `mutate` 任何 Config 字段）、不写 YAML、不写 profile 其它条目 |
| 不下发 | 浏览器永远拿不到 access / refresh / accountId 原文；UI 只拿到 `credentialId`（随机 UUID，可安全外发）、`planType` / `email` 与额度数字 |

`planType` / `email` 只用于界面显示账号身份（例如「某某 · Plus」），不参与取数判定。
到期时间**不在界面显示**：`expires` 是 access token 的过期时间，不是套餐到期，展示会误导。

### 3.2 旧 v1（单账户）记录：读兼容、写落 v2

- 0.12.0 之前的 payload **就是单个 credential**（没有 `version` / `accounts`）。
- **读**：v1 在内存中等价于 `{version:1, accounts:[credential], activeAccountId: credential.credentialId}`，
  因此老用户升级后不会掉登录。
- **写**：任何写操作（登录/重登、切换、移除、刷新 token）都会把整条记录改写成 **v2**；
  没有一次性迁移脚本，也不需要用户操作。
- `revision` 语义不变（同一账户被重新授权时 +1）；token 刷新不动 `revision`。

### 3.3 校验（fail-closed）

- 严格校验：字段缺失 / 类型错 / `expires` 非正 / `revision` 非正安全整数 /
  `accounts` 数量不在 1..8 / `credentialId` 或 `accountId` 重复 / `activeAccountId` 命中不到 /
  出现白名单外的 key —— 一律判 `incompatible`，**不「尽力清洗」后继续用**。
- 坏记录时界面进「状态不可知」，不冒充未登录、不显示数字，给「重试 / 重新登录 / 退出登录」
  （`canLogin:false` 时只给「重试」），见 §6.1。
- 新增账户时若已有 8 个：**不写**记录，返回固定 `limit` 失败；不驱逐旧账户、也不覆盖任何一个。
  **文案现状**：客户端 `parseCodexAccountLoginStatus` 只保留状态、不保留 Host 的 `message`，
  因此该失败与其他登录失败一样显示通用「登录失败，请稍后重试。」——
  **专用上限提示待后续补**（当前没有「账户已达上限」的专用文案）。

### 3.4 账户操作语义（登录 / select / remove）

表中「账户」= `accounts` 里的一项；对客户端暴露的 `id` 就是 `credentialId`（随机 UUID）。

| 操作 | Host 行为 | 对记录的影响 |
| --- | --- | --- |
| **添加账户**（设备码登录） | 新 `credentialId = randomUUID()`、`revision = 1`，**追加到末尾**，并设为 active | 写 v2；已有 8 个 ⇒ `limit` 失败、不写 |
| **重新登录**（同一 `accountId` 再次授权） | **upsert**：保留原 `credentialId`、`revision + 1`、覆盖 token 三件套与 `savedAt`；active **跟随该账户** | 写 v2；`credentialId` 不变 |
| **选择账户**（radio） | **只改 `activeAccountId`**，任何 token 都不动；找不到 id ⇒ `not-found`；已是 active ⇒ 幂等空操作、不写盘 | 写 v2 |
| **移除账户**（指定 id 退出） | 在 `modifyRecord` 内**重读后**只删这一项；`activeAccountId` 取「原 active 若仍在，否则剩余第一个」 | 写 v2；还有其它账户 |
| **移除最后一个** | 删除整条记录（删除调用成功 **且** 重读确认不在了才算成功） | 记录消失，界面回到未登录 |

- 选择 / 移除都按 `credentialId` 定位，**不按邮箱或计划名**（邮箱可能缺失或重复）。
- 设备码登录同一时刻只有**一个在途尝试**（`busy` 互斥）；添加账户不并发登录。
- 写失败一律如实返回固定 `reason`，**不谎报成功**、也不把身份快照清成 `none`。

### 3.5 安全边界

1. **令牌不出 Host**：令牌不进入 `/api/plan-usage` wire、不进 `usage_status` 投影、不进详情 `title`。
2. **记录由 DSH 凭据服务保管/加密**（`ctx.credentials`），插件只通过公开读写接口访问，
   不复制到内存以外的位置、不落磁盘、不写日志。
3. **记录独占写只覆盖本插件自己的记录**：刷新在 `modifyRecord` 内按 `credentialId` 定位账户后二次检查——
   普通路径按「同账户 + `expires`」、**401/403 强制路径**按「同账户 + 用过的 access 是否已被别人换掉」
   （§2.3），**防本插件内部并发覆盖**；**不防**其它客户端轮换同一账号的 refresh token；
   读路径以记录为准，不在进程内长期缓存令牌。
4. **不跟随重定向**：请求用 `redirect: 'manual'`，**3xx 按失败处理**（不重发、不改 origin 重试）；
   `/wham/usage` 与 OAuth 端点都一样。
5. **超时 / 响应体上限 / 轮询上限**：单请求超时 **15 秒**、响应体 **≤ 512 KiB**（超限即判结构异常）、
   只接受 JSON 对象，失败即中止；**设备码登录的 Host 侧总时限是 15 分钟**（超时 ⇒ `expired`），
   客户端关掉面板**不会**让 Host 立刻停止 —— 见 §5 与 §6.1。
6. **零隐式网络**：未启用渠道 / 未登录时**不发任何请求**，也不做「静默探测」；切换账户只改 active，
   不额外请求上游。
7. **错误不外泄原文**：上游 message、令牌片段、账号 ID 一律不进界面与 wire，只给固定文案 + 固定错误码。

## 4. 来源现状：只剩本插件账号，connect / subscription 已退场

### 4.1 活动路径只有一条

| 项 | 现状 |
| --- | --- |
| 取数来源 | **只有**本插件的 `dsh-usage-dock/codex` 记录 + `GET /backend-api/wham/usage` |
| 账户数量 | 1..8 个，单选生效；胶囊/详情只显示 **active** 账户的数字 |
| 网页设置页 | 不再有「额度来源」选择 / 来源摘要 / 来源说明 / Subscription 一键适配块；只剩账户列表与添加/重登/退出 |
| 原生设置页 | 不再有 `codexSource` 下拉与「一键适配」入口；Codex 分组只剩渠道开关与阈值 |
| 历史字段 `codexSource` | 配置字段与 wire 上的 `codexSource:'account'` **仍保留**，只为兼容旧 YAML / 旧摘要 / 旧 wire；`plans/codex.js#fetchPlan` **恒走 account**，不再按它分派 |

- **不合并**：无论保存了几个账户，胶囊与详情始终是**一行 Codex 渠道**，数字永远只来自 active 账户；
  切换账户会作废旧值与在途结果，绝不混用两个账户的百分比。
- **不自动选账户**：登录成功后 active 跟随本次登录/重登的账户；除此之外只有用户点 radio 才会改
  `activeAccountId`，不做后台探测或按额度高低自动切换。
- **渠道清单口径（0.12.0）**：原生 / 内置渠道共 **4 个**（OpenCode Go / DeepSeek / OpenAI Codex /
  小米 MiMo），原生额度面板默认顺序 `DeepSeek → MiMo → Codex → OpenCode Go`；WorkBuddy 已随本版
  退场（不再是内置渠道，如仍需要请用「自定义余额渠道」添加），不在原生分组 / 策略字段里出现。
  **MiMo 在本版只用 API Key 余额**（`mimoApiKey` 或「设置 → 模型」的 MiMo Key），
  扫码 / 记住登录 / `mimo-login` 原生面板已删除，不再是可登录渠道。
  本节只描述 Codex 来源现状，渠道清单以 `AGENTS.md` §3 为准。

### 4.2 旧 `connect` / `subscription` 退场说明

| 旧来源 | 退场后 |
| --- | --- |
| `connect`（0.10.0 起，复用 `dsh-codex-connect` 的公开额度接口） | 设置页不再出现、原生页不再出现、活动取数路径不再走它 |
| `subscription`（第三方 `dsh-codex-subscription` 只读 service + 本地只读补丁） | 同上；「需适配 / 一键应用本地适配」入口随之下线 |

> **代码可保留为死代码**：`plans/codex-sources.js`、`plans/codex-subscription-patch.js`、
> `plans/patches/codex-subscription-*.json` 与 Host 的 `patch-state` / `apply-patch` 路由仍在仓库里，
> 但**活动路径不读取、设置页与原生设置页不再提供入口**。保留它们只为：旧配置里的字段继续能通过校验、
> 旧清单与工具脚本不被破坏。**不要**据此认为「来源仍可选」。
> 因此旧文档 [codex-source-ui-20261111.md](codex-source-ui-20261111.md) 与
> [codex-source-host-adapter-20261111.md](codex-source-host-adapter-20261111.md) 只作历史沿革，不再描述现状。

### 4.3 同步点（已落地，复核用）

| 位置 | 现状（0.12.0 开发中） |
| --- | --- |
| `plans/codex.js` | `fetchPlan` **恒走 account**；`schema.codexSource` 保留 `z.string().default('connect')` 只为让旧 YAML 继续通过校验；失败 wire 仍带 `codexSource:'account'` |
| `plans/codex-sources.js` | 三值闭集与归一函数仍在（**死代码**），活动路径不再按它分派 |
| 配置摘要（两端） | Host `configDigestOf` 与客户端 `codexSource.digestPart` 仍按「非 `connect` 即追加 `builtin:codex-source\u0002<source>`」同位置、逐字同构——保留是为了**旧配置 / 旧 wire 的摘要不漂移**，不代表来源选择仍生效 |
| 观察身份 | `identityOfChannel('codex')` **只**追加 `acct=<快照>`；快照 = `acct:<accountId 的 sha256 前 8 位>@<credentialId 前 8 位>r<revision>`（或 `none` / `unknown`）。**不再包含** `codexSource`，也不再包含第三方 service 的实例 / revision |
| `plans/dsh-go-native.js` | 原生设置页已删除「额度来源」下拉与适配入口；Codex 分组只剩开关与阈值（§6.1） |
| `client.js` | 不再有来源单选 / 摘要 / 说明；Codex 卡片 = 「添加账户」整行 + 账户列表 + 设备码等待区 + 固定提示（§5） |

## 5. UI：账户列表与登录状态机

### 5.1 账户列表布局（用户定稿）

```
┌─ OpenAI Codex ─────────────────────────────────────────────┐
│ [        添加账户（占满整行，无账户时也在）        ]        │
│ (radio) 某某某 · Plus                        [重新登录] [退出登录] │  ← 仅选中行有右侧按钮
│ (radio) 另一个账号 · Pro                                    │
│ ── 设备码等待区（starting / waiting 时才出现）──            │
│ 固定提示（成功 / 失败 / 已取消 …）                          │
└────────────────────────────────────────────────────────────┘
```

- **「添加账户」占满整行**，在账户列表**上方**；没有账户时也显示（此时列表为空 + 「尚未登录」提示）。
- 每个已保存账户一行：`radio`（选中 = active）+「账号名 · 订阅类型」。
  - 账号名：**14px / primary / 500**；订阅类型：**13px / secondary**；分隔点最弱（tertiary）。
  - 名称区 `flex:1 1 auto; min-width:0` + 省略号：长账号名自己截断，**不会**把按钮挤到下一行。
- **只有选中那一行**在行尾同一行显示「重新登录 / 退出登录」，靠 `margin-left:auto` 贴右；
  未选中行不显示这两个按钮（避免误操作别的账户）。
- 只读部署 / 一次性动作进行中（登录、切换、移除）时，radio 与按钮禁用；**勾选状态原样保留**。
- 到期时间不显示（那是 access token 的过期时间，不是套餐到期）。

### 5.2 登录状态机

状态由 Host 给出（固定枚举），客户端只渲染，不自行推测：

| 状态 | 含义 | 界面表现 | 可交互 |
| --- | --- | --- | --- |
| `signed-out` | Host **明确**回答未登录（从没登录过 / 已移除最后一个账户 / 取消或超时后仍未登录） | 「尚未登录」+「添加账户」 | 可添加账户 |
| `waiting-device-code` | 已拿到验证码，等用户在浏览器完成授权 | 显示验证码 + `https://auth.openai.com/codex/device` + 「取消」 | 可取消；轮询中禁止重复点登录 |
| `signed-in` | 至少一个有效账户；active 账户的 access 可用 | 账户列表（radio + 账号名·计划）+ 额度数字；选中行有「重新登录 / 退出登录」 | 可切换 / 重登 / 退出 |
| `expired` | access 刷新被上游拒绝（401/403、`invalid_grant` 等）——即「需要重新登录」；设备码登录尝试超时也按超时提示后回到未登录 | 「ChatGPT 登录已过期，请重新登录」+ 可对选中账户重新登录（设备码超时为「设备码登录已超时，请重新开始」） | 可重新登录 |
| `failed` | 设备码申请 / 兑换 / 保存记录 / 额度请求的**固定错误**（含被上游拒绝、3xx、结构异常、本机不可写、账户已达 8 个） | 固定文案（客户端对 `failed` 统一显示通用「登录失败，请稍后重试。」；**账户已达 8 个尚无专用提示，待后续补**）+ 固定错误码，**不显示上游原文**，也不猜数值 | 可重试/重新登录 |
| `cancelled` | 用户点了「取消」（**只是关掉设置页/面板不算**，见 §6.1）；**终态以 Host 的 `state` 为准** | 回读 Host：说已登录 ⇒ **仍显示「已登录」**并保留「已取消登录」提示；明确未登录 ⇒ 回 `signed-out`；不可知 ⇒ 进 `unknown` | 可重新登录 |

补充约定：

- **移除账户** = 从记录里删掉该 `credentialId`；移除最后一个 = 删除整条 `dsh-usage-dock/codex` 记录，
  界面回到未登录。**不碰**其它插件的登录态、不改配置。
- **终态一律以 Host 的 `state` 为准**：切换 / 退出 / 授权成功 / 取消 / 失败之后，客户端都重新
  `GET …/codex-account/state`，绝不把本地推断当结果——既不会把已登录用户显示成未登录，
  也不会出现两份互相矛盾的账户列表。
- 等待设备码期间关掉设置页/面板 → **只是客户端停止展示轮询**（不再每 2 秒查一次状态）；
  **Host 侧的登录尝试仍在继续**，直到用户点「取消」或 15 分钟上限到期（分别落 `cancelled` / `expired`）。
  重新打开设置页/面板时按 Host 的状态快照继续显示当前相位。
- 验证码 / 登录尝试超时 → 提示「设备码登录已超时，请重新开始」，再回读 Host
  （通常回未登录；若原本已登录则保持已登录），**不自动换新码循环刷屏**；
  被上游拒绝或兑换/保存失败 → `failed` + 固定文案（同样先回读 Host，不把已登录用户说成未登录）。
- Codex 卡片**始终**渲染账户区（不再由任何「来源」草稿控制），且**没有任何**令牌 / Key 输入框。

## 6. 兼容性

| 环境 | 预期 | 已验证程度 |
| --- | --- | --- |
| DSH 桌面 runtime `0.2.2-rc.5` | 已内置 `dsh-llm-pi-ai` 的 `openai-codex` OAuth flow 与 `dsh-authorization`/`dsh-credentials`；本实现只用 `ctx.credentials` + Host 原生 fetch | **本地离线实现/测试**，未做真机端到端 |
| DSH Go（移动端） | 原生设置页**已没有来源选项**，也不提供登录入口；手机端**读同一份记录**、只显示 active 账户的额度 ⇒ **无法在手机端完成登录或切换账户**，需先在**桌面网页版设置页**操作 | **未验证**（设备码在 App 内是否可用也未知） |
| 与 Codex Connect 共存 | 不依赖、不 import `dsh-codex-connect`；不改它的登录态；不注册 `openai-codex` adapter，因此不与它抢同一个 adapter 槽位 | 设计上无冲突；但本插件只锁自己的记录，**不防**其它客户端轮换同一账号的 refresh token（§2.3） |
| 与 `dsh-codex-subscription` 共存 | 完全无关（活动路径不走它的只读 service、不碰补丁） | 无耦合 |
| 与宿主自己的 `openai-codex` 模型路由 | 本插件**只读额度**，不注册 adapter、不改路由顺序 | 不构成对扣费账号/额度池的自动认证 |

### 6.1 已知行为与限制（终审记录）

| 项 | 说明 |
| --- | --- |
| **启动身份快照是 fire-and-forget** | Host `apply` 时异步读一次记录来刷新**同步**身份快照（`acct:<账号哈希前 8 位>@<credentialId 前 8 位>r<revision>`）。若首个采集赶在快照就位之前，可能**短暂**显示「本次采集已作废，等待最新额度」，**下一轮采集自愈**。这是已知表现（已记录），不是数据错误，也不会伪造数字 |
| **记录坏了 / 不可读时的恢复入口（已补）** | `GET …/codex-account/state` 给出 `signedIn:null` + `reason` 时，客户端进入「状态不可知」相位（`incompatible` 用「本机记录坏了」文案，其它未知用「状态暂不可用」），**不冒充未登录、不显示数字**，并给恢复入口：**「重试」**（再问一次 Host）、**「重新登录」**（仅 `canLogin !== false` 时给，Host 侧会用新登录覆盖坏记录）、**「退出登录」**（仅 `canLogin === true` 时给）。另有 **`no-credentials`** 分支（Host 没有凭据服务、`canLogin:false`）⇒ **只给「重试」**，不给登录/退出，避免按了必然失败的按钮。Host 侧严格校验记录：缺字段 / 类型错 / `expires` 非正 / 重复 id / 超过 8 个 / 出现白名单外的 key 一律判 `incompatible`，**不「尽力清洗」后继续用** |
| **手机端不能完成登录 / 切换** | 见上表：移动端原生设置页已没有来源与登录入口，也没有网页版设置页 ⇒ 只能在桌面网页版添加 / 重登 / 切换 / 移除账户，手机端读同一份记录 |
| **多账户的已知边界** | ① 最多 **8** 个，满了只能先移除；② 同一账号重登是 **upsert**（`credentialId` 不变、`revision + 1`），不会变成第二行；③ 切换账户只改 active，**不刷新** token（下一次采集按需刷新）；④ 移除 active 后自动落到剩余第一个，不会「一个都没选中」；⑤ 两个账户的额度**永不混用**，切换会让旧值与在途结果作废 |
| **不防跨客户端轮换** | 见 §2.3：其它客户端换了同一账号的 refresh token 后，本插件登录会失效并提示重新登录 |

## 7. 许可证与合规说明

1. **不使用 SIWC 代码**：不复制 `packages/local` 源码、不 import、不复制其常量；
   因此不适用 Sign-in with ChatGPT DevKit Noncommercial License v1.0 的义务，也不引入与 MIT
   发布分发相冲突的条款。本插件自身仍为 MIT。
2. **不依赖 npm 上不存在的东西**：`@siwc/local` 是 private workspace、未发布，任何「装它来用」的方案
   在本项目里都不可行（这也是不改投 SIWC 的现实原因之一）。
3. **本实现的性质**：使用 Codex CLI 公开的 OAuth 流程与公开客户端 ID，调用 Codex 客户端在用的
   `/backend-api/wham/usage`。这与 Codex Connect 等社区工具的做法相同，但**不是 OpenAI 明确授权的
   第三方集成**；文档与发布说明必须如实这样写，不宣称「官方支持」。
4. **不绕过任何授权**：没有抓包重放、没有盗用他人令牌、没有把用户凭据上传第三方；
   登录由用户本人在 OpenAI 官方域名完成。

## 8. 测试与验收边界

**本轮范围：只做本地实现 + 离线测试**（不联网，fetch 全部注入假实现），覆盖以下方面：

- 端点常量与请求形状（client_id、`grant_type`、`redirect_uri`、`chatgpt-account-id` 头）；
- 记录形状：v2 白名单（`version` / `activeAccountId` / `accounts` 三个 key）、
  credential 白名单（`type:'oauth'` + 7 个必填 + `planType`/`email` 两个可选，多一个 key 即 `incompatible`）、
  `accounts` 1..8、id 唯一性、`activeAccountId` 必须命中；v1 单账户读兼容、写后落 v2；
- 账户操作：添加（追加 + 设为 active）、同账号重登 upsert（`credentialId` 不变、`revision + 1`、active 跟随）、
  select 只改 `activeAccountId`、remove 只删指定项、移除最后一个删整条记录、满 8 个返回 `limit`；
- 刷新二次检查（判据 **`credentialId` + `expires`**：账户被移除/换 id 不写、记录已新鲜不写、
  只有同账户且确实过期才写）；
- 3xx 按失败处理（`redirect:'manual'`，不跟随、不重试到新 origin）；
- 错误分类与固定文案；状态机迁移（含取消、超时、被上游拒绝、关闭面板只停客户端轮询）；
- 账户隔离断言（不混用不同账户的数字、切换作废旧值）；身份快照
  `acct:<账号哈希前 8>@<credentialId 前 8>r<revision>` 随切换/重登/移除/刷新更新；
  摘要两端一致（跨端向量）。

> **测试数字（2026-11-25 最终回归）**：关键 **13 套件共 785 项全绿**——
> `test-dsh-go-boundaries` **29**（含账号切换身份隔离 C1b/C1c/E1b） / `test-usage-recheck-f1f2` 17 / `test-mimo-api-key` 17 /
> `test-dsh-go-native` **53** / `test-degrade-refresh` 41 / `test-settings` 17 /
> `test-settings-layout-20261024` 30 / `test-config-unwrap` 22 / `test-usage-tool` 103 /
> `test-codex-account` **242** / `test-codex-account-host` **46** / `test-codex-account-ui` **100** /
> `test-line-endings` 68；另有 `test-review-fixes` **40** 项通过。
> **全部 WorkBuddy / MiMo 相关改动套件通过**；36 个 `test-mimo*` 已删除，仅留 `test-mimo-api-key`。
> 2026-11-23 的 **102 套件 / 94 通过**与 8 个失败名单是 MiMo 清理前的旧结果，**不能再用**；
> `test-codex-auto-adapt`、`test-fetch-backends` 等旧套件不在本轮关键清单内，不据此声称全仓全绿。
> **0.12 未发布、未真机验收。**
> 已删除的退场测试：`test-codex-sources.mjs`、`test-codex-source-ui.mjs`、
> `test-codex-patch-ui.mjs`、`test-codex-adapt-ui.mjs`、全部 `test-mimo*`（`test-mimo-api-key` 除外）。

**本轮没做、因此不能声称的**

- 真实设备码登录、真实令牌刷新、真实 `/wham/usage` 取数（需要真人账号与网络；
  目前真实账号只成功登录过**一个**账户一次，见发布说明）；
- refresh token 轮换/撤销、**多账户切换**、5h 与周窗口重置的实际行为；
- 移动端（DSH Go）设备码流程可用性，以及手机端能否完成登录（**结论按已知边界写：不能**）；
- 其它客户端（Codex CLI / `openai-codex` flow / Codex Connect）在主账号上轮换 refresh token 的实际表现
  —— 本插件**不防**这种情况（§2.3），本轮也没有真机复现；
- 启动身份快照与首个采集的真实时间窗（只有离线行为断言，没有真机观察）；
- 任何真机/发布验收。

> 离线用例通过 **≠** 功能可用。发布前必须有用户真机确认（见 §9 与发布说明草稿）。

## 9. 未决问题 / 后续

1. **浏览器回调兜底 / 手机端登录入口**：设备码在桌面很合适；本轮没有可用的移动端登录入口
   （原生设置页已没有来源与登录入口，见 §6），也没有「本机 HTTP 回调 + 手动粘贴回调 URL」的备用路径——
   **本轮都不做**，避免扩大回环端口与安全面。若将来要支持手机端登录，需先评估原生面板内的
   设备码 UI + 打开系统浏览器，或让网页版设置页在移动端可用。
2. **多账户已完成，但真机未验证**：v2 记录（1..8、单选 active）、添加/重登/切换/移除与
   「添加账户整行 + 选中行右侧按钮」布局均已落地并通过离线测试；**尚未部署、未在真机上验证**
   多账户切换与额度跟随，也**没有**多账号并发/满 8 个的真实操作记录。
3. **真机验证清单**：桌面登录/多账户切换/移除/过期恢复；手机端读取桌面登录结果的显示；
   其它客户端轮换同一账号 token 后本插件是否如实提示「请重新登录」（**不期望「互不踢下线」**，
   见 §2.3）；5h/周窗口重置显示是否符合上游实际。
4. **上游变更监控**：`/wham/usage` 是内部接口，可能随 Codex 客户端改版失效；
   实现已用固定 `reason` 枚举区分成因（`structure` 结构异常 / `redirect` 3xx / `reauth` 需重新登录 /
   `network` / `timeout` / `too-large` 等），排障时按 reason 判断是上游改动还是用户问题，**不要回显上游正文**。
5. **SIWC 后续**：若 OpenAI 未来真的在 SIWC 里开放额度读取，再评估是否改用它（届时需重新评估许可证）。
