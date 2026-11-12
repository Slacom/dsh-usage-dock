# MiMo 记住登录：60 s 后台自动读 + 读失败分级 + 展开即刷（2026-11-10 后端包）

> 状态：**源码 + 合成定向测试完成，未安装、未重启、未发布**。全部测试是 fake DNS/HTTP +
> fake crypto/provider/owner 的**合成**结果；**没有**任何真实账号、Cookie、余额或 API 请求，
> 也**没有**读取真实 credential record / cfg / 浏览器数据。合成通过 ≠ 实机验收。

## 1. 本轮范围（用户授权边界）

只改 4 个后端源 + 定向 fake 测试 + 本文档：

| 文件 | 变更性质 |
| --- | --- |
| `plans/mimo-auth/remembered-session.js` | 节拍 60 s、读失败分级、单飞重排、`refresh()`、managed 墓碑 |
| `plans/mimo-auth/routes.js` | 新动作 `rememberedRefresh`（严格字段/代次校验）、DTO 两个安全标量 |
| `plans/mimo-auth/host.js` | 门面暴露 `refresh`（一行） |
| `plans/mimo-auth/console-protocol.js` | **只**扩「纯余额读失败」保留 verified 的两层条件 |

**未改**：`secure-transport.js`（仍 `811A4F26…A961F9`，一字未改）、`console-grants.js`、
`remember-store.js`、`session-display.js`、`console-session.js`、`session.js`、
`dynamic-policy.js`、`vendor/*`、`plans/mimo.js`、`index.js`、`client.js`（客户端由 UI 包唯一写）、
安装器/部署脚本、`package.json` 版本号。**未动** URL、headers、Cookie 解析/引号/值/域、
SSO 路径、凭据类、UID/MFA、加密 schema、到期语义、每 op 10 s 预算、续票次数、请求预算；
**没有**新增隐藏 HTTP 重试。

## 2. 后端行为（新合同）

### 2.1 节拍与单飞

- `REMEMBERED_LIMITS.intervalMs` **300000 → 60000**（唯一上游轮询节拍，Host 自己的 timer，
  不依赖 UI 挂载）；`status` / `capability` / `displayStatus` 仍是纯观察（0 vendor / 0 解密 / 0 请求）。
- 读入口收敛为**一个** `requestRead({ first, trigger, op })`：`beginOp()` 会推进 `opSeq`，
  让上一个 op 立刻 `isCurrent()=false`，所以任何并发调用者（tick / 手动 refresh / 首读）
  必须在 `beginOp` **之前**加入已有 flight，返回同一个 promise。
- 计数（`readAttempts` / `refreshCount` / `readFailures`）只在 flight 内部、真正要发这一读时 +1：
  **每个实际读恰好一次**，与订阅者数量/UI 轮询次数无关。
- **加入 ≠ 成功**：`joined` 只表示共用同一个操作，不改变读结果 —— 加入一个失败 flight 的调用者
  同样返回 `ok:false` + 该次失败的安全码。
- 手动 refresh 完成后 `armTick()` 重排同一个 60 s timer，旧 tick 不会紧接再来一次额外读。
- **两入口都在 await 前绑定 owner**（`generation` + `protocol` 实例）：`tick()` 与 `refresh()`
  await 之后只有「仍是同一个 owner 且 `verified`」才 `armTick()`；代次变了返回 stale、**不触**新 owner 的 timer
  （停终端路径造成的 `protocol === null` 不会被误当成新 owner）。同一 owner 上的普通读失败仍继续 60 s 节拍。

### 2.2 读失败分级

`REMEMBERED_LIMITS.readFailureLimit = 5`（原 `transientLimit: 3` 取消，旧字段名在 DTO 里保留为别名）。

| 次数 | 公开 `balance` / `fetchedAt` | `freshness` | `state` | timer |
| --- | --- | --- | --- | --- |
| 成功 | 新值 / 本次时间 | `fresh` | `verified` | 重排 60 s |
| 1–4 次普通失败 | **上次成功值 / 原时间戳** | `stale` | `verified` | 继续 60 s |
| 第 5 次普通失败 | **`null` / `null`**（内存 last-good 不外透） | `failed` | `verified` | **继续** 60 s |
| 之后成功 | 新值 / 本次时间 | `fresh` | `verified` | 重排 60 s |

- 「普通失败」= 网络/暂时（`E_MIMO_CONSOLE_TRANSIENT`）、**纯**余额解析（`E_MIMO_CONSOLE_BALANCE_PARSE`）、
  读操作自身 deadline 到点（`E_MIMO_AUTH_TARGET_EXPIRED` + `E_REQUEST_TIMEOUT`）。
- 首次没有历史数据时余额保持 `null`、**不编 0 金额**（可 `stale`）。
- `freshness` 闭集 `fresh | stale | failed | paused | null`（`snapshot()` 新增，`displaySnapshot()` 扩 `failed`）。

#### 2.2.1 非普通失败 = 立即 fail-closed（**不计入 5 次**，也不许假 fresh）

安全流程 / 协议自检类固定码（`FLOW`、`SSO_CHALLENGE`、`SSO_*`/`LP_*`/Cookie 策略、
`JSON_UNSUPPORTED`、`NOT_VERIFIED`、`CONFIRM_REQUIRED`、`INVALID`、`UNSUPPORTED`、`BUSY` 等，
即：既不是上表三类普通失败、也不是认证/身份终止的其余固定码）**不**走 5 次阈值，而是
一次性 fail-closed（`failClosedRead()`）：

- 撤活会话（`dropProtocol()`：租约作废 + `protocol.dispose()`）⇒ 在途/后续读一律不再 live；
- 清公开与私有缓存（`clearValues()`：`balance` / `fetchedAt` / 身份 / `readFailures` / `refreshCount`）；
- `state = 'failed'`、对外固定码 `E_MIMO_CONSOLE_FLOW`（真实安全 cause 保留在 `reasonCode`，
  例如 `E_MIMO_CONSOLE_SSO_CHALLENGE`，`failureStage = 'read'`）；
- **停掉 timer**（无可用会话时不允许 60 s 节拍空转），`canRetry / canForget = true`；
- **不**写 tombstone：记住登录密文保留（只有既有 `AUTH_REJECTED` / `IDENTITY_MISMATCH` 才 forget）。

原因（这是本轮修掉的一个静态缺陷）：这类错误的协议侧已经 `clearSecrets()`，下一次读只会
`NOT_VERIFIED`——如果仍留在 `verified` 且保留旧值，`readFailures` 一直是 0 ⇒ `freshness` 会被算成
`fresh`，等于**把旧金额当新值**无限展示。

### 2.3 语义不变的终止（不等 5 次）

`AUTH_REJECTED` / `ACCOUNT_CREDENTIAL_MISSING` / `IDENTITY_MISMATCH` / owner 失效（退出、禁用、
换号、暂停、代次变更）/ `CANCELLED` / 保存错误 —— 立即清值 + 清 `readFailures`（不冒充普通读失败）。
晚到的成功/失败一律被 `isCurrent(op)`、`protocol !== p`、`generation !== gen` 拦住，**不回填**新 owner。

### 2.4 `refresh()`（本人展开详情时主动读一次）

- 仅 `verified` 且未暂停（`enabledGate` 照旧）；已有 flight ⇒ 加入，**不**另开 op。
- 只做一次真实余额读：**不** retry、**不** restore、**不** 新扫、**不** 清记录、**不** 新扫二维码。
- **返回值 = 这次实际读的结果**：`ok` 只在真的读成功时为 `true`；加入别人的 flight（含失败的 flight）
  只说明共用同一个操作 ⇒ 失败时同样 `ok:false` + 该次失败的安全码（绝不谎报成功）。
- **owner 绑定**：await 前捕获 `generation`/`protocol`；await 之后
  ① 自己这一读 fail-closed / 被终止 / 暂停 ⇒ 返回**原失败码**、不重建 timer；
  ② 代次已变（旧 owner 的读迟到，新 owner 已 `verified`）⇒ 返回 `E_MIMO_REMEMBERED_STALE_ID`、
  **不**对新 owner 调 `armTick()`；
  ③ 仍是同一 owner ⇒ 真成功 `ok:true`，普通读失败 `ok:false` + 安全码，两种都继续同一个 60 s 节拍。
- 路由动作 `rememberedRefresh`，严格字段 `{action, bootEpoch, generation}`：
  未知字段 400、缺 generation 400、旧 generation 409 `E_MIMO_REMEMBERED_STALE_ID`、
  错 boot 409 `E_MIMO_AUTH_BOOT_STALE`，**被拒一律 0 上游请求**；显式分支，绝不掉进末尾 `api.retry()`。

### 2.5 managed 墓碑（display）

- `displaySnapshot().selected` 现在对**所有** managed 状态为 `true`（除 `disabled` / `unsupported`）：
  empty / failed / stopped 也「接管显示」，客户端因此**不会**回落到旧 `cfgCookie` 手工值
  （用户删输入但没删旧字段值的情况）。
- 非 live 态 `balance` / `fetchedAt` / `identity` 一律为空；`candidate` 始终 `null`（原始 ID 只在 paired 确认视图）。
- `displaySnapshot().generation` 改为**单调**（`displayGen`，只增不减）：客户端按
  `display.generation < prev.generation` 丢弃快照，若退出/失败时退回 0，墓碑会被拒收、旧金额残留。
  **`snapshot()`（controller 视图，路由控制动作校验用）仍是 `live ? generation : 0`，未改。**

### 2.6 protocol 两层小修（唯一的协议改动）

只放宽「**纯余额读失败**」保留已认证 owner，两处一致（同一个私有 helper `keepsVerifiedOnReadFailure`）：

1. `runOperation().finish()`：`kind === 'balance' && state === 'verified' && ownerLive() &&
   (TRANSISTENT | BALANCE_PARSE | EXPIRED∧now>=deadlineAt)` ⇒ 不 `clearSecrets()`、不把 state 打回 `'new'`。
2. `readBalance()` 的 `catch`：同一谓词（`EXPIRED` 用 `args.deadlineAt` 作「已到点」证据）。

理由：旧实现 `BALANCE_PARSE` 会 `clearSecrets()`，下一次读永久 `NOT_VERIFIED` —— 一次解析抖动
就把记住登录读死。`readBalanceOnce` 在 200 之后**先** `parse/project`、**后** `absorb` 平台 Cookie，
所以保留 verified 不会提前接纳变号 Cookie；身份校验与 `absorb` 顺序**未动**。

不保留（原样终止）：认证拒绝、凭据缺失、身份不符、SSO/挑战类、`CANCELLED`、owner 已失效、
无到点证据的 `EXPIRED`、以及**一切非 balance 操作**（login / restore / export …）。

### 2.7 余额 200 但 raw JSON 畸形：局部归一成 BALANCE_PARSE

`bodyJson()` → `decodeJson()` 对畸形/重复 key/危险 key/超限的 raw body 抛 `JSON_UNSUPPORTED`。
对**余额这一次读**来说它是纯响应体解析失败，因此只在该调用点做局部归一
（写在 `readBalanceOnce` 里 `await bodyJson(res, op)` 的 try/catch，与既有 `bodyJsonWithNonce`
对 SSO 侧做归一的写法一致）：

- **只**把 `JSON_UNSUPPORTED → BALANCE_PARSE`，于是走 §2.2 的「保留 verified、下一次读恢复」路径；
- owner 失效 / `EXPIRED` / `RESPONSE_SIZE` / 传输（URL/TLS/超时）/ SSO 错误**原样上抛**；
- **不**改全局 `decodeJson`，**不**接受坏 body，**不**放松重复 key / 危险 key / 256 KiB 上限。

若畸形 JSON 出现在 **SSO 侧**（`/pass/serviceLogin` 等），仍按原逻辑映射
`SSO_RESPONSE_UNSUPPORTED` 并**终止**（§2.2.1 的 fail-closed），不会被当成可重试的解析抖动。

## 3. DTO 字段（给客户端包）

`remembered`（`rememberedStatus` / caps）与 `display`（`displayStatus`）新增：

- `readFailures`: int `0..5`（服务端已封顶，客户端不必再夹）
- `freshness`: `'fresh' | 'stale' | 'failed' | 'paused' | null`（display 侧同一套）
- `display.managed`: 已有（恒 `true`）；`display.selected`: 见 §2.5 墓碑
- `localLimits.intervalMs = 60000`，`localLimits.readFailureLimit = 5`（保留旧键 `transientLimit` 同值）
- `stats.readFailures`（新增），`stats.transientStreak` 保留为同值别名

### 3.1 给客户端包的实现要点（重要）

- **遮罩判据用 `managed === true`（或 `selected === true`），不要用 `displaySupported`**：
  后端刻意**不**伪造 `displaySupported`——它仍表示「本次 boot 有没有活着的显示会话」，
  empty / failed / stopped 时为 `false`。墓碑由 `managed:true` + `selected:true` + 空 `balance/identity` 表达；
  若客户端某条 mask 分支要求 `displaySupported===true`，那条分支在退出/失败后会把旧手工值放回来。
- `display.generation` 单调不减（controller 视图 `remembered.generation` 仍是 `live ? gen : 0`）。
  客户端已有的 `display.generation < prev.generation` 丢弃规则因此不会拒收墓碑。
- 胶囊文案：`state==='verified' && freshness==='failed'`（或 `readFailures>=5`）⇒ 固定「余额读取失败」，
  **不带原因**；原因码只在详情里展示。`freshness==='stale'` ⇒ 灰显上次成功值（不报错）。

## 4. 测试

**新增**：`tools/test-mimo-remembered-freshness.mjs` — **14 组 / 14 通过 / 0 失败**
（`node tools/test-mimo-remembered-freshness.mjs`）。全合成：fakeDNS/fakeHTTP（无 localhost 监听、
无真实网络）、fake DPAPI crypto、fake credentials provider。

- G1 60 s 节拍：`status`/`displaySnapshot` 连打 20 次 → 0 请求 / 0 存储 / 不 bump；到点只读 1 次并重排
- G2 手动 refresh：恰好 1 次余额请求，0 SSO / 0 QR / 0 存储写
- G3 auto+manual 单飞：并发窗口内只 1 次余额请求、只记 1 次读，**首 op 结果被采纳**（不被兄弟调用判过时）；
  再叠一层**加入失败 flight**：两个 caller 都不得报成功（仍只 1 次实际读 / 1 次失败计数，普通失败保旧值 stale）
- G4 1–4 次失败保旧值 + 原时间戳 + `stale`；第 5 次公开 `null`/`failed` 但 `verified` 且 timer 仍在；第 6 次成功复位
- G5 首次无历史：`balance` 保持 `null`（不编 0），可 `stale`
- G6 退出（在途读挂起时 forget）晚到 200 不回填 + tombstone；禁用立即清且不删记录；display 墓碑无金额/身份；
  **旧 owner 的迟到回包**（refresh 与 tick 各一例，时钟前推 5 s 让断言有鉴别力）⇒ 新 owner 的 `nextReadAt` 不被改、
  数值不被回填、迟到读不计到新 owner 头上、旧 refresh 只回 `ok:false` 固定码
- G7 display 墓碑：空态 `selected:true`、generation 只增不减、`unsupported` 明确不接管
- G8 真实 protocol：**200 raw 畸形 JSON** 与「结构化但金额非法」都归一成纯解析失败 ⇒ 保留 verified、
  计 1/2 次、下一次正常 200 即恢复（同一 owner，不重新 SSO、密文不删）
- G8b 真实 protocol：畸形 JSON 出现在 **SSO 侧** ⇒ 仍 `SSO_RESPONSE_UNSUPPORTED` 终止（不归一、不删密文）
- G9 纯读 deadline 超时（保留 verified、下一读恢复）**vs** owner 在途撤销（立即清、之后读不再成功）
- G10 认证拒绝立即终止（不等 5 次）+ tombstone + 失败态 refresh 0 请求
- G13 **非普通失败反例**（余额 403 → 续票落到 `/pass/notification` ⇒ `E_MIMO_CONSOLE_SSO_CHALLENGE`）：
  第一次即无余额、`freshness=null`（**不**是 fresh）、`readFailures=0`、`state=failed`、`reasonCode` 保留安全 cause、
  timer 停（连推 3 个 60 s 周期 0 额外读）、display 墓碑遮罩、密文未删、`retry()` 一次即恢复
- G11 路由：refresh 正常读 1 次 / 未知字段 400 / 缺 gen 400 / 旧 gen 409 / 错 boot 409（全 0 请求）/ 不落 retry
- G12 **真实 controller + host 路由链**（真实 `createAuthHost` 注册 handler，非 fakeApi）：
  跨 boot 自动恢复 → `rememberedRefresh` → 1–4 次 `stale` → 第 5 次 `failed`（`displayStatus` 同见）→ 第 6 次恢复

**既有套件（受影响的最小集，各跑一次）**

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `test-mimo-remembered-session.mjs` | 21/0 | 2 处旧断言按新需求更新（`intervalMs 60000`、`readFailureLimit 5`） |
| `test-mimo-remembered-e2e.mjs` | 17/0 | 2 处 `intervalMs` 断言更新（300000→60000） |
| `test-mimo-console-remember-protocol.mjs` | 29/0 | 1 处 `describe()` 键集补 `handoffSummary`（**既有漂移**，非本轮新增字段） |
| `test-mimo-console-protocol.mjs` | 56/0 | 2 处旧断言改为新需求：`BALANCE_PARSE` 后 `verifyIdentity` 应成功；读 deadline 超时不再把 state 打回 `'new'` |
| `test-mimo-console-e2e.mjs` | 59/0 | 未改 |
| `test-mimo-remembered-disable.mjs` | 2/0 | 未改 |
| `test-mimo-remembered-reenroll.mjs` | 4/0 | 未改 |
| `test-mimo-remembered-error-client.mjs` | 35/0 | 未改 |
| `test-mimo-console-handoff-summary.mjs` | 6/0 | 未改 |
| `test-line-endings.mjs` | 75/0 | 行尾一致（LF） |

> **关于被改的那两条 `console-protocol` 断言**：它们编码的正是本轮要修的旧行为
> （解析失败清 Jar ⇒ 之后每次读永久 `NOT_VERIFIED`；读超时把 state 打回 `'new'`）。
> 改成新预期是**需求变更**，不是「复现并修复了某次真实认证故障」——**没有**任何实机证据支持
> 「认证曾经故障」。同理 `intervalMs` 的 300000→60000 只是节拍需求变化。
> 这些旧断言在改动前的文件上本就是「通过但语义过时」，改动后才是新语义。

### 已知**与本包无关**的既有红灯（未改、不代表本轮通过）

| 套件 | 现象 | 判定依据 |
| --- | --- | --- |
| `test-mimo-remembered-client-e2e.mjs` | 74/25 | 客户端 UI 已被重写：`client.js` 里**已无** `暂停刷新` / `退出并忘记` 按钮字符串（`0` 命中），设置区只剩「更新时间 / 已绑定账号 / 退出账号」。该套点击的是旧按钮，属 **UI 包**范围。本包只更新了其中 2 处 `intervalMs` 断言。 |
| `test-mimo-display-e2e.mjs` | 37/13 | 该套只注入 `displayProducer`（`remembered === null`、`consoleSessions === null`），本包的 4 源改动全部不在其执行路径上；失败点为旧 display 面板的 UI 点击序列，同属 UI 重写漂移。 |
| `test-mimo-remembered-recovery-errors.mjs` | 5/2 | `challenge` / `badTarget` 两个变体仍期望 2026-11-09 SSO 目标形状诊断**之前**的通用码（`SSO_CHALLENGE` / `SSO_TARGET_UNSUPPORTED`），现分别落到 `FLOW` / `SSO_TARGET_OTHER_HOST`。属 SSO 诊断轮的既有漂移，本包按合同**不碰** SSO。 |
| `test-mimo-auth-host.mjs` | 无法运行 | 依赖 `vm.SourceTextModule`（需 `--experimental-vm-modules`），与源码无关。 |

## 5. 未验证 / 不声称

- **未**做真实登录、扫码、余额请求；**未**读真实 credential record / cfg / 浏览器数据；
  **未**安装到 profile、**未**重启、**未**发布。
- **不**声称「余额读取失败」在实机上已按新分级呈现；**不**声称 60 s 后台读在实机跑通。
- 既有实机结论（2026-11-10 跨重启恢复 + 连续读取通过）本包**不重新验证、不推翻、不预支**未来。
- 认证路径（SSO/transport/grants/DPAPI/record 格式）**零改动**。

## 6. 本包 4 源 SHA-256（本包末次：fail-closed + raw-JSON 归一 + 单飞合同补齐）

```
plans/mimo-auth/remembered-session.js  AC59AFFBBC5FF87AE11E7F2C804BE01D85BCD3330674EB246A6E2A6BC84EA63B
plans/mimo-auth/routes.js              01C5BE5B825A2D3120552D27F8E033532ED3E45AEEA564A668F8CF86E4881523
plans/mimo-auth/host.js                1C1C8C084E75BCB1486894AB5C908CDEAC2D7C5A68D31707C7B4EF2F065AC010
plans/mimo-auth/console-protocol.js    9768B5F3079CF4E9CA98D74E55BA7F1FD42BD7BD280886D5AC171117390357B9
（未改）secure-transport.js           811A4F2642B5134C3A8FE0DC49261C4800E660655D4AED86424B86AC86A961F9
（新增测试）tools/test-mimo-remembered-freshness.mjs  272ECB58E4035119F70F73C931AC3F26993C34B892E5A7AA60CC31F504147D1D
```

> 本轮只动 `remembered-session.js`（`failClosedRead()`；`refresh()` 返回实际结果、await 前绑定 owner；
> `tick()` 同样绑定 owner）与 `console-protocol.js`（`readBalanceOnce` 里 `JSON_UNSUPPORTED → BALANCE_PARSE`
> 的局部归一）。`routes.js` / `host.js` SHA 与最初一轮**完全相同**（未改，沿用）。

### 6.1 关于「owner 绑定」这条守卫的可测强度（如实说明）

`refresh()`/`tick()` 的 `generation`/`protocol` 绑定是**防御性守卫**：当前公开动作集里
所有换 owner 的路径（`startAuth` / `forget` / `disable` / `pause` / `resume` / `retry`）都先
`invalidateOps()` 或先改 `state`，在途读会被 abort 提前结束，所以「旧读的 continuation 恰好在新
owner 已 verified 之后运行」这个竞态**目前无法通过公开动作构造**。
`G3` 的「加入失败 flight 不得报成功」是可实测的缺口（回归用例在旧实现上确实失败：
`{"ok":true,"code":"E_NONE"}`）；`G6` 的迟到回包用例锁的是**可观测不变量**
（新 owner 的 `nextReadAt` 不变、数值不回填），两者合起来保证将来重构不会把这条不变量弄丢。

> 说明：安装仍以 `.diagnostics/mimo-sso-header-profile-20261109/INSTALLED-MANIFEST.json`（17 项）为 base，
> 本包**不**产出新的安装清单、**不**改 installer——精确合并/落盘交由源码主另委派。
