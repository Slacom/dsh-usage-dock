# MiMo 正式 console 扫码登录 · 主线实施记录（2026-11-06）

> 范围：只动工作区源码 + 新测试 + 本文档。**未**修改 profile/已装副本/备份，**未**重启、安装、发版、
> git 提交、改版本号、联网、开浏览器、扫真实二维码、读任何账号/余额/配置/凭据。
> 所有运行验证均为 **fakeDNS + fake `node:https` request**（真实 authority / 真实 transport /
> 真实协议状态机 / 真实 Host 路由 / 真实 client.js），**没有**跑过 `usage_status` 或任何真实上游 fetch。

## 1. 改动清单（实际落地）

| 文件 | 改动 |
| --- | --- |
| `plans/mimo-auth/console-protocol.js` | 内核闭环：`bodyJson(res, op)` 三处复核；`absorb` / `absorbAccountSeed` 写前 `assertOp`；`markSource` 前复核；`onQr` / `approveTarget` await 之后复核；verified 提交前复核。删除无用 `raceDeadline`。`runOperation` 总 deadline race（先定 `settled` + 摘监听再 abort，正常 close 不改写成失败）。公开 `login` 入口在**开新 op 之前**拒重复/在途（BUSY），避免新 op 覆盖 `currentOp` 把有效会话误清。LP 改为**有界多轮**：`requestDeadline = min(now+35000, op.deadlineAt)` 同时用于 authority 校验、transport `deadlineAt` 与本地 `assertAuthorized`；只有「AuthResult 这一跳超时且整体未到期」才是内部 `POLL_WAIT`（不导出、不外泄，终态映射 EXPIRED），取消/整体到期/未知 payload/MFA/challenge 一律终止。`MAX_CALLS = 20` 覆盖 ctx/init/image/多轮 poll/callback。余额 single-flight 判定在开新 op **之前**；一个 balance op 涵盖首读 → 必要 SSO（三跳）→ 一次重试，共用同一绝对 deadline；`TRANSIENT`(500/429/network) 保留 verified 与凭据，终止错误清 Jar/身份。 |
| `plans/mimo-auth/console-session.js`（**新增**） | pre-auth owner：`start` 纯本地（32hex authId + 正 generation + 120 s 独立期限，零 IO）；`begin` 异步启动真实 `protocol.login` 并立刻 ACK（`done` 只给 Host/测试）；`status`/`takeQr` 零 vendor；`takeQr` 一次性交付内存字节（≤256 KiB，不进 JSON、不 base64）；regional 目标只挂**私有** pending resolver，DTO 仅 `{approvalId, origin, purpose, method}`；`approve`/`deny` 校验 boot/记录/authId/gen/approvalId + ownerLive；`stop`/到期/`dispose` 顺序为「先失效（状态+revision）→ 清 QR/expected/审批 → resolve 待审批 false → `protocol.dispose()`」，到期由自跑 timer 完成（无人轮询也会自动清）。`claim()` 同步一次把 ready protocol 移进私有 `WeakMap` 的 opaque 空 handle，丢强引用与 timer，lease 从 `preauth` 切 `display`；`verifyCredential` / `readCredential` / `disposeCredential` 是唯一出口。已 claim 的记录 `stop`/`dispose` **不**偷偷停 display。 |
| `plans/mimo-auth/session-display.js` | 仅必要的可选 `credentialDisposer`；`haltFor`/`dispose` 改为「先清 owned state 再释放旧 handle」；producer 产物槽：超时/取消/stop/换会话之后迟到、或 `start` 的 await 回来时 op 已不 live，产物立即 `dispose`（不依赖 GC）。不传 disposer 时旧合成 DI 行为不变；`DISPLAY_LIMITS` 未改。 |
| `plans/mimo-auth/host.js` | 代码级 `enableConsoleProtocol === true`（默认 **false**）才构造真实 console manager；缺省绑定真实 console DI（producer=claim / verifier / adapter / disposer / 固定 namespace），任何显式注入的合成 DI 优先、不被覆盖；`consoleApi.attach` 内部取事前预期 → `display.start`（只 attach、不读余额）；`consoleBusy()`（display holding/verified 或 legacy 会话在跑 ⇒ consoleStart 0 请求拒）；`host.idle` 收 console `done`；dispose 顺序 display 先（释放 handle）→ console manager。 |
| `plans/mimo-auth/routes.js` | 新增 `consoleStart/Begin/Status/Stop/Attach/Qr/Approve/Deny` 严格字段集（多余键即 400，不静默忽略）；`consoleQr` 返回**二进制 + no-store**；`consoleStatus`/`consoleStop` 在未启用时给可信 absent 200，其余动作固定 503 码；`capability()` 增加 `consoleSupported` + `consoleNamespaces` + 白名单 `console` 快照；`displayStatus` 与所有 display/console 动作响应附同一白名单 `console` 快照（前端只需一个观察定时器）；顺手纠正 `handleAuth` GET 把布尔当 `bootEpoch` 的笔误；legacy 分支只记非密 `{ticketId, generation}` 用于双登录防护。 |
| `client.js` | 沿既有 `mimoDisplayStore/pump/flight/boot/generation/revision/barrier` 接 console 快照（不新起轮询）；`console` 逐字段白名单重建 + `generation/authId/revision` 单调接受；动作响应与 `displayStatus` 同源更新；正式登录 UI 放进现有 `MimoDisplayPanel`：预期账号是 **non-controlled** `type=password` + `ref`（无 `value`/`defaultValue`，点击先清空再只 POST 一次），一次点击内 `consoleStart → consoleBegin` 两个本地动作，二维码只在本机内存转 objectURL 并在换代/结束/卸载时 revoke，regional 审批独立可见、deny 立即取消，ready 显示遮蔽标签 + 显式「确认身份并接入显示（尚不读余额）」，之后复用既有 `displayRead/Confirm/Grant/Stop` 与胶囊/详情 overlay。`consoleSupported=false` 时如实显示「正式个人扫码登录尚未启用真实试接入」，不谎称可用。 |
| `tools/test-mimo-console-protocol.mjs` | 新增 5 例（见 §2）。 |
| `tools/test-mimo-console-session.mjs`（**新增**） | 17 例：纯本地 start、观察 0 请求、begin 5 跳/balance 0、takeQr 一次性、claim/lease/凭据、401 相关映射、到期自清、approve/deny、stop/dispose、revision 单调、BUSY、错 id/gen 拒绝、SSO 分支。 |
| `tools/test-mimo-console-e2e.mjs`（**新增**） | 54 例：真实 `createAuthHost` 路由 + 真实 `client.js`（mock React）端到端（见 §2）。 |

未改（按边界）：`dynamic-policy.js`、旧 `session.js`、`vendor/*`、`plans/mimo.js`、`index.js`、WorkBuddy 相关、旧 ACTIONS 白名单、`DISPLAY_LIMITS`、MEMORY/AGENTS/旧交接。

## 2. 本轮**实际执行**的测试（不重跑旧大矩阵）

```
node tools/test-mimo-console-protocol.mjs   → 29 passed, 0 failed   (exit 0)
node tools/test-mimo-console-session.mjs     → 17 passed, 0 failed   (exit 0)
node tools/test-mimo-console-e2e.mjs         → 54 passed, 0 failed   (exit 0)
```

受改动直接影响、额外做的定向回归（同样是本轮实跑，不是「全量矩阵」）：

```
node tools/test-mimo-display-session.mjs     → 78 passed, 0 failed   (exit 0)   # session-display.js 改动
node tools/test-mimo-display-e2e.mjs         → 50 passed, 0 failed   (exit 0)   # host/routes/client 改动（合成 DI 路径）
node tools/test-mimo-display-client.mjs      → 39 passed, 0 failed   (exit 0)   # DTO picker 增加 console 字段
```

覆盖到的关键断言（每条都是实跑通过，不是设计意图）：

- `start` / `GET capability` / `status` **0 vendor 请求**；构造与观察绝不自动 `login`。
- `begin` 恰好 5 跳（ctx / QR init / QR image / LP / callback）、**balance 0**；`consoleAttach` 仍 **0**；点「读取一次余额」才 +1。
- 确认（`displayConfirm`）**0 上游请求**；`displayGrant` 在 Host 侧排下一轮；反复 `status`/UI 刷新 **0 上游请求**。
- `401 → 一次 fresh SSO + 重试` 精确 **5 跳**（2×balance + ctx + sso + callback）。
- displayStop 之后 read 按钮消失、状态 stopped/无值、**0 新请求**（旧协议无法被路由复活）；`disposeCredential` 后 `verifyCredential` 立刻拒且 **0 新请求**（session 套）。
- 伪造 `url` 字段、`expected` 里的 `id`、缺 `authConsent`、错 boot、非 hex `authId`、`generation=0`、坏 `approvalId`、`consoleAttach` 带 `enable` → 一律 400/409，且 **0 上游请求**。
- 所有响应 JSON：无 passToken 哨兵、无原始账号 ID、无 `longPolling`/`xiaomi.com`/`https://`。
- 余额读到一半**身份变号**（401 → fresh SSO 换回不同 userId）⇒ 终止并清值，不写回旧值、不重试。
- display active 时 `consoleStart` → `E_MIMO_CONSOLE_SESSION_BUSY` 且 **0 上游请求**（防双登录）。
- 代码级开关**默认关闭**：`consoleSupported=false`；`consoleStatus` 200 + 可信 absent；`consoleStop` 幂等 200；`consoleStart`/`consoleBegin` 固定 503；面板文案如实写「尚未启用真实试接入」且不渲染正式入口。
- 旧 legacy QR flow loader 调用 **0 次**。
- 协议层：`deadline` 之后才手工 resolve 的 `onQr` / regional approval **不再 LP、不 verified**；强制 `AbortSignal.any` 缺失时 fallback 桥 add/remove **成对**（各 1）；单跳 LP 超时 → 同一已批准 LP 有界多轮（LP=2，ctx/init/img 各 1，无新 approval）；多轮中整体 deadline 到点 → **不进入下一跳**。

### 2.1 主代理接口审追加（非基线复现声明）

- 源码检查发现：display 释放 handle 后，pre-auth 的非密记录仍为 `claimed`，后续 `start` 会一直 BUSY。`disposeCredential` 现仅对同一 authId/generation 的记录置 stopped、清 mask；迟到旧 handle 的释放不能改写新代次。新增管理层 1 例、e2e 2 项，证明释放后可本地重新登录、无新增上游请求。此前没有跑旧实现的失败基线，因此不称“已做基线复现”。
- 额外 e2e 3 项验证旧会话互斥：旧 `start` 只创建本地记录即可验证，不需要真实 flow 或联网。主代理仅重跑改动直接涉及的 manager/e2e 新套，分别 **17/0、54/0，exit 0**；协议 29/0 沿用新实施代理实跑结果，未重复执行。
- 原 Max 已完成本轮一次独立终审：**Pass（仅限本地合成主线闭环），无阻断项**，见[独立终审记录](mimo-console-mainline-review-20261106.md)。审核只读逻辑与断言、未重复跑测试，也未联网。非阻断的 mask 一致性、死条件、极端 dispose 兜底、timer unref 等保留，不为它们再开整改轮；此 Pass 不构成真实可用性证明。

## 2.2 分层覆盖与本轮未执行项（不要扩大为已验证）

| 项 | 实际状态 |
| --- | --- |
| 双登录防护的 **legacy auth active** 分支 | 主代理已补实跑：仅本地 `start` 创建旧会话，不 `begin`，即能证明正式 `consoleStart` 被拒、上游请求 0、legacy loader 0。先前“必须真实旧 flow 才能验证”的判断撤回；本行保留为纠正记录，不再列未验证。 |
| 「`displayStop` 之后 `protocol.verifyIdentity` 不能复活」 | 由 `test-mimo-console-session.mjs` 的 `disposeCredential → verify 拒 + 0 新请求` 覆盖；e2e 只覆盖「没有任何路由能复活旧会话 + 0 新请求」。 |
| 分项（`cash`/`gift`）缺失不造 0 | 由 `test-mimo-console-protocol.mjs`「只有 balance+currency：成功且不含 cash/gift 字段」覆盖；console e2e 未单跑该场景。 |
| `host.idle` 收 console 登录 `done` | 已实现（`trackTask`），未写断言。 |
| 真实链路（真扫码 / 真上游 / 真余额） | **完全未执行**，且未获许可。 |

## 3. 当前状态（必须如实读）

- **默认未激活**：`enableConsoleProtocol` 默认 `false`，route/UI 都无法打开它；没有真实试运行或部署许可。
- **未部署、未重启、未提交、未发版**：profile/已装副本/版本号均未改动。
- **未做真实验证**：没有真实小米账号、真实二维码、真实上游响应；协议字段与流程来自第三方实现证据
  （`docs/mimo-original-reference-evidence-20261106.md`，首要参考 XiaomiTokenMonitor@6f0edbba…），
  是**第三方实现**而非官方契约/实测，因此不保证与线上服务当前行为一致。
- 本轮所有「通过」都是 fakeDNS + fake request 的离线结果，**不构成真实可用性证明**。

## 4. 已知 unsupported / 未证实字段与限制

- 需要交互的响应（`challenge` / MFA）一律固定 `E_MIMO_CONSOLE_UNSUPPORTED`，**不**尝试猜算法或新 URL。
- `clientSign` 等签名算法未实现、也不猜；未知 URL / 未知字段不推断，直接拒。
- 二维码 `mime` 只接受 PNG / JPEG；>256 KiB 的 QR 图与响应体一律拒。
- 余额只做**四字段投影**（`balance` 必填、`currency` 必须可证；`cashBalance` / `giftBalance` 缺项**省略**，不造 0、不改口径、不与套餐/积分混算）。
- 时间界全部是**临时本地界**：pre-auth 120 s、单次 LP 等待 35 s、整个 operation 最多 20 次调用、
  display 持有可能 15 分钟 / 60 s 间隔 / 最多 14 次刷新 / 单次 DI 10 s。**不**主张等于厂商有效期，
  也**不**主张「1–2 天」或「跨重启保持登录」——重启必须重新登录。
- 到期/取消后迟到结果一律丢弃（协议侧 `assertOp` + display 侧 fail-stop + 凭据显式 dispose），不依赖 GC 时机。
