# Codex 双来源契约调研（2026-11-10，只读）

范围：仅已装程序源（**未**读 cfg/credential/OAuth 文件/env/log/网络，未执行 apply/构造/探测）。
来源：`C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-codex-subscription`（3.2.6，main `lib/index.js`）
与 `dsh-codex-connect`（0.2.0-alpha.12，main `lib/index.js` + `lib/index.d.ts`）。

## A. dsh-codex-subscription 3.2.6

**导出（`lib/index.js` 末行 export，L18042）**：`apply, name, inject, Config, CodexLoginCoordinator,
DshOAuthCredentialStore, createCodexAuthService, createCodexRpcHandler, createCodexUsageReader,
parseCodexUsage, createSubscriptionDiagnostics, createCodexResetCreditService, createDefaultModelController,
createSearchProviderSwitcher, createSubscriptionRpcHandler, decodeCodexPng, normalizeContextMode,
normalizeCustomContextWindow, openCodexAuthUrl, commandForCodexAuthUrl, assertCodexAuthUrl,
CODEX_USAGE_URL, CODEX_RESET_CREDITS_URL, CODEX_RESET_CONSUME_URL, CODEX_IMAGE_GENERATION_URL, CODEX_IMAGE_TOOL_NAME,
DEFAULT_MODEL_PROVIDER`。

- **无 cordis Service / 无 `ctx.provide`**：全文件没有服务注册；只 `ctx.llm.registerAdapter([PROVIDER], readyAdapter)`
  （L17599）与 DSH Connection RPC。RPC 不是 `rpc.registry`，而是 **`connection.fetch.register`**
  （L3447 `registerSubscriptionTransport`）：为 `RPC_ENDPOINTS` 每个端点注册
  `POST /api/codex-subscription/<endpoint>`、`requestBody:'buffered'`、JSON envelope 校验
  （`clientRequestSchema`，`method` 必须精确匹配）、`content-type: application/json` 否则 415，
  非法 envelope 400；handler 返回 `{ok:true,value}` 或 `publicError(code,message)`。
  ⇒ **Host 侧没有可直接 `ctx.get` 的服务**；这些是 DSH Connection 的 HTTP 路由，Host 能否作为公开客户端
  调用由 C2 的 Connection 公开 RPC 契约审查决定（本轮不读其 SDK）。
- `status` 由 authHandler 兜底（L16062 `authHandler(endpoint,...)`，定义在 L11849），返回
  `coordinator.accountStatus()` → `{authenticated, provider:'openai-codex', type:'oauth', expiresAt?, accounts?}`；
  它读取当前 credential + vault（`auth.status` L11454），经 `publicClone` 输出**非 secret DTO**。
- **`usage` 端点（L15962）**：payload 只接受 `{force?:boolean}`，返回
  `usageReader.read({force,signal})`；**只读当前 active 账号**（`readSubscriptionCredentials` 每次取
  `getAuth` 当前账号），**不聚合、不切换、不写 vault**。多账号聚合只在 `usage/accounts`（`accountUsageReader.readAll`，
  L16003），本功能不使用。
- 错误区分：已知未登录/需续期/被拦截分别保留消息文本（`"ChatGPT subscription is not signed in"` /
  `"ChatGPT sign-in needs to be renewed"` / `REQUEST_BLOCKED`），但统一包成 `publicError("internal", message)`
  —— **没有独立 error code**；方法未注册表现为该路径 404（未注册路由）或 envelope 400。权限/传输错误由
  Connection 层 HTTP 状态区分，不在 RPC 码内。
- 缓存 scope：handler 的 `usageReader` 是带 forecast 的包装（L15230 起），`read` 记录 `scope()`（account）
  与 generation；`clearCache()` 同时 `generation++` 且清底层 reader 缓存/在途请求。`account/select`、`account/remove`、
  `logout`、`login/status` 成功后会调用 `usageReader.clearCache()`（L16066 起）⇒ 切换账号后旧缓存/旧 forecast
  不会回填；但**已经在途的旧 RPC 响应仍可能返回给它自己的调用方**（reader 层只保证不写缓存），由 UI 侧按代次丢弃。
- **RPC endpoints**（L3375 起固定表）：`status, login/*, logout, account/select, account/remove, usage,
  usage/accounts, usage/history, usage/profile, diagnostics, preferences/*, default-model/*, predictions/generate,
  runtime/*, storage/*, voice/*, remote/*, reset-credit/*`。
- `status` 返回（auth.status L11454）：`{ authenticated, provider:'openai-codex', type:'oauth', expiresAt?, accounts? }`；
  未登录 `{authenticated:false, provider}`。**不含 token**。
- 多账号池：存储为 DSH credential record（kind grant，payload `{version, activeId, accounts:[{id,label,credential}]}`，
  L11033 起）；`add()` 新账号即设为 active（L11224），`select(id)` 改 activeId（L11252），
  `remove(id)` 需显式 replacement（RPC `account/remove` 参数 `{id}` 语义见 L11895 附近）。
- 配额：`createCodexUsageReader({getAuth, readCredential, fetch?, now?, ttlMs?, timeoutMs?, failureTtlMs?, maxRetryAfterMs?})`
  → `{ read({force?, signal?}), clear() }`；`read` **会发网络请求**（`CODEX_USAGE_URL`，Bearer + `chatgpt-account-id`）
  并可能刷新 OAuth ⇒ **非纯观察**。
- `parseCodexUsage(value, nowMs?)` 纯函数：`rateLimits:[{id,name?,windows:[{usedPercent, remainingPercent=100-used,
  windowSeconds, resetsAt?}]}]`（primary/secondary），另有 `additional_rate_limits`、`code_review`、
  `chatPass`、`credits{unlimited,balance?,expiresAt?,approx*Messages?}`、`individualLimit{limit,used,remainingPercent,resetsAt?}`、
  `spendControlReached`、`resetCredits{availableCount,credits?,nextExpiresAt?}`、`planType`、`rateLimitReachedType`。
  单位：`windowSeconds` 秒；窗口 `resetsAt` 为 **Unix 秒**（`epochSeconds()` 返回原值，client.js L10793 显示前
  `resetsAt * 1e3` 转毫秒）；`credits.expiresAt` / `resetCredits.nextExpiresAt` 为**毫秒**（`expires_at*1000`）。
  **注意与 Connect 命名区分：订阅叫 `resetsAt`，Connect 叫 `resetAt`，两者当前都是秒。**

## B. dsh-codex-connect 0.2.0-alpha.12

- **公开 cordis 服务**：`OPENAI_CODEX_TRANSPORT_SERVICE = 'openaiCodexTransport'`（`lib/index.d.ts` L279，
  `class OpenAICodexTransport extends Service` L351）。⇒ `ctx.get('openaiCodexTransport')` 非空即插件已启用
  （无网络、无 credential 读取；服务由 fiber 在 load 时构造）。
- `name = 'llm-openai-codex'`（L880），`inject`（L882），`Config`（L978，`enableQuotaTool` 等启动期开关）。
- 纯函数：`parseOpenAICodexUsage(value)` → `{rateLimits, credits?, individualLimit?}`，窗口同样是
  `remainingPercent`；窗口 `resetAt` d.ts 标明 **Unix seconds**（L371–377）。
- **服务类没有 quota 方法**：`OpenAICodexTransport` / `OpenAICodexTransportV1`（d.ts L340–362）只有
  `generateImages` / `editImages`；`ctx.get('openaiCodexTransport')` 只能作为“已启用”的纯观察，
  **不能经该 service 读额度**。`QUOTA_TOOL_NAME` 是注册的 model-callable tool（需实际调用才执行，且受
  `enableQuotaTool` 启动开关），不是只读 API。
- **非纯**：`readOpenAICodexRateLimits(store)` 需要 `captureActiveAccount()`（会刷新 OAuth、发网络，d.ts L427）。
- **非 secret 登录态**：`openAICodexAuthStatus(store?)` → `{authenticated, expiresAt?}`，**不刷新 token**（d.ts L750–755）；
  但它读取磁盘 credential 文档（非网络），本调研未执行。
- 账号池（`OpenAICodexCredentialStore`，d.ts L57–96）：`accounts()` → `[{accountKey, displayName, maskedEmail?,
  profileSource, active}]`（浏览器安全摘要，无 provider account id）；`activate(accountKey)`；`removeAccount(key, replacement?)`；
  `captureActiveAccount()` 固定一次请求使用的账号，**不改变用户当前选择**。
- 配额工具：`QUOTA_TOOL_NAME = 'codex_connect_quota'`（L429），仅 `enableQuotaTool` 为 true 且启动时注册。

## C. 结论与阻断（供实现决策，不含实现）

1. **能证明“已启用”的纯观察**：
   - Connect：`ctx.get('openaiCodexTransport') !== undefined`（公开服务名，无副作用）。
   - Subscription：**没有 cordis 服务/纯 availability API**，但**并非绝对无 Host 入口**：它为 40+ 端点注册了
     DSH Connection 的 `POST /api/codex-subscription/<endpoint>` 路由（`connection.fetch.register`，L3447）。
     Host 是否可作为公开客户端调用这些路由，取决于 C2 正在审的 DSH Connection 公开 RPC 契约；**本轮不下结论、
     不用私有闭包/token 绕过**。
2. **额度读取都需要凭据/网络**：两个来源的 usage 读取都不是纯函数（subscription `usage` RPC 只读当前 active 账号；
   connect `readOpenAICodexRateLimits` 会刷新 OAuth）。纯函数只有 `parse*Usage`（需要上游 JSON）。
   Connect 的公开 `OpenAICodexTransport` 服务**没有** quota 方法，只能先 `ctx.get` 作启用 guard，再用公开
   `OpenAICodexCredentialStore` + `readOpenAICodexRateLimits`（或等价公开 quota tool 的只读调用，需主决定）。
3. **多账号选择语义**：Connect 以 `accounts()`+`activate(key)` 明示；Subscription 以 vault `activeId` +
   `account/select{id}`，`add` 即切 active；两者都**不允许**用 token 直接调 API 绕过 store。
4. **禁止**：直接读 `~/.dsh/.openai-codex-auth.json`、订阅 credential record、或任何 Bearer/token；
   现有 `plans/codex.js` 的 `dynamic import + new OpenAICodexCredentialStore()` **不判启用**（未开也会读文件），
   新实现必须改为先用服务/状态判断，再走公开 quota API，且未安装/未启用统一“未启用”。
5. **登录态与启用分开**：Connect 可用 `openAICodexAuthStatus`（读文件、无网络）；Subscription 只有 RPC `status`。
   两者都不得输出 token/账号 id（Connect summary 已脱敏；Subscription accounts 字段需浏览器侧按 RPC DTO 处理）。

## D. 未解决/需主决定

- Subscription 的启用观察与额度查询在 Host 侧的公开入口：`connection.fetch.register` 的路由存在，但 Host 作为
  客户端调用是否属于公开契约由 **C2 的 DSH Connection 公开 RPC 审查**决定；本轮不实现、不读其 SDK。
- **单位纠正**：旧 `plans/codex.js` 的 `normalizeWindow` 对 `resetAt * 1000` 只适用于 **Connect（resetAt 秒）**；
  Subscription 的 `resetsAt` 也是**秒**（index `epochSeconds` 原值；client 显示前乘 1e3），不是毫秒。
  不要为兼容去改旧转换；若未来接 Subscription，仍按秒处理 `resetsAt`。
- Subscription `accounts` DTO 的精确字段未在此审计中完全读毕（`publicClone` 路径），未输出任何真实账号信息；
  本轮功能只取 active 账号，不需要该 DTO。
- 两家 provider id 均为 `openai-codex`，同时启用会有注册冲突（Connect 有 `assertNoOpenAICodexProviderConflict`）；
  设置必须“只选一个、未安装/未开启=未启用、不自动 fallback”。
