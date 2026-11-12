# MiMo 本机显示会话（sessionDisplay）· Max 最终风险审核（2026-11-05）

> 审核范围：`plans/mimo-auth/session-display.js`（新）、`host.js`、`routes.js`、`client.js`、
> `tools/test-mimo-display-session.mjs`、`tools/test-mimo-display-client.mjs`、
> `docs/mimo-session-display-20261105.md`、`docs/mimo-real-protocol-operation-sheet-20261105.md`，
> 对照 `plans/mimo-auth/session.js`、`plans/mimo.js`、`plans/index.js`、`index.js`、`tools/mock-react.mjs`。
> **本轮未联网/未扫码/未碰真实接口/未读 profile·cfg·凭据·日志/未跑旧 26·21·56 矩阵/未跑作者的两个新测试。**
> 结论：**不通过（阻断 8 项）**。以下只列安全/功能阻断与覆盖缺口，不列形式问题。

## 1. 阻断清单（必须修）

### B1 本地持有上限与待确认窗口**没有自主计时器**，无 status 时凭据无限保留
- 位置：`session-display.js:383-394`（`arm()` 只在 `grant !== null` 时挂 timer）、`:528-532`（`expireIfDue()` 只在 `status()` 调用时执行）、`:534-543`（`read()` 亦只是迟滞触发）、`:296-300`（pending 到期只清 `awaitingBalanceMatch`，不 halt）。
- 场景：`displayStart` 成功进入 `verified`（未 read，或 read 后未 confirm）后关闭页面/收不到任何 status ⇒ `credential` 与 `actual` 在 Host 内存**永久保留**，与文档「15 min 本地硬上限」不符。测试 `test-mimo-display-session.mjs:344-348` 是靠**显式发 status** 才发现 `expired`，因此掩盖了该缺陷。
- 最小修：`start` 成功后挂一个 `unref()` 的到期 timer（`min(credentialExpiresAt, pendingDeadline)` 中较早者；grant 激活后由现有 `arm()` 接管），到点调用 `expireIfDue()`；`dispose()/halt()` 必须清这个 timer。

### B2 操作超时**不 abort、不失效**，且 DI 在 deadline 检查之前就被调用
- 位置：`session-display.js:239-263`（timeout 分支只 `reject`，未 `invalidateOp`）、`:408/484/497/545`（`producer({...})`/`identityVerifier({...})`/`balanceAdapter({...})` 作为**实参先求值**，因此 deadline 已过的情形仍会真正发起调用）。
- 场景：DI 不理会 `signal`（或响应缓慢）⇒ 10 s 后本地判超时，但旧调用仍在飞；60 s 后 `tick` 再起一次 ⇒ 同一会话**并发两个真实请求**，与「单飞」承诺冲突；且被超时放弃的响应不会被销毁。
- 最小修：timeout 分支里先 `invalidateOp(d)`（推进 `opToken` + `abort()`）再 `reject`；调用点改为传**惰性工厂** `() => producer({...})`，`bounded` 内在启动前检查 `now() < d.opDeadline`，过期则直接以 `CREDENTIAL_EXPIRED` 拒绝且**零调用**。

### B3 `tick` 的 catch 把**终止类错误当成暂时失败**
- 位置：`session-display.js:428-441` 对所有抛错一律 `failures += 1` + `stale` + 继续；而 `applyBalance`（`:314-323`）对 `AUTH_REJECTED / IDENTITY_UNKNOWN / IDENTITY_MISMATCH / BALANCE_PARSE / BALANCE_CODE` 是 **halt 清值**。
- 场景：adapter 以 `throw {code: E_..._AUTH_REJECTED}` 形式回报 401/403 时，会话不停、值继续以 `stale` 展示，并还会再发最多 2 次请求 —— 同一条件两条路径两种语义。
- 最小修：把「终止类 code 集合」提到模块级，`tick` catch 与 `applyBalance` 共用同一判定：命中即 `halt(code)`。

### B4 刷新次数预算只统计**成功**，实际请求数可远超 14
- 位置：`session-display.js:415-427`（仅成功时 `grant.used += 1`）、`:431-440`（失败只增 `failures`，不增 `used`；成功会把 `failures` 归零，见 `:349`）。
- 场景：`fail-fail-success` 交替 ⇒ 14 次成功 + 每轮 2 次失败 ⇒ 实际最多约 40 次请求，与对外文案「最多 14 次」不符。
- 最小修：进入 `tick` 且实际调用 adapter 时即 `grant.used += 1`（attempt 语义），`maxAutoRefresh` 同时对 attempt 生效；文案与文档同步为「最多 14 次请求（含失败）」。

### B5 overlay 在渠道过滤**之后**执行，会把已停用的 MiMo 重新加回
- 位置：`client.js:1801-1823`（按配置过滤，停用即剔除）→ `:1838` `mimoDisplayOverlay` → `:5795`（未找到 `mimo` 时 `out.push(mimoDisplayPlanOf(snapshot, null))`）。
- 场景：用户在设置里取消 MiMo、但 Host 仍有 selected 会话 ⇒ 胶囊再次出现 MiMo 行，停用失效。
- 最小修：overlay 增加「是否允许渲染 MiMo」入参（由同一 `settingBool(config, meta.fields.enabled, true)` 计算），不允许时**不得 push**；或把 overlay 移到过滤之前并让过滤规则识别 `displaySource` 行。

### B6 「pending 关闭即取消」**未接任何 UI**，且文案与之相反
- 位置：`client.js:5739-5744` 定义 `mimoDisplayAbandonPending()`、`:7814` 仅作为 `mimoDisplay` 导出给测试；**全文件无调用点**；`:6011-6012` 反而声明「收起或刷新页面不会结束会话」。
- 场景：用户在 `holding`（核对身份中）或 `awaitingBalanceMatch`（等本人比对）阶段关闭面板 ⇒ 会话继续、凭据继续持有到 15 min，与既定要求「pending close 取消、active 收起继续」不符。
- 最小修：`MimoDisplayPanel` 卸载 / 关闭按钮路径在 `state==='holding' || awaitingBalanceMatch===true` 时调用 `mimoDisplayAbandonPending()`；文案改为「核对/比对阶段关闭会取消；已显示后收起不结束」。

### B7 详情「现金/赠金」缺项**补 0**
- 位置：`client.js:2226-2234`（`leftVal = typeof plan.cashBalance === 'number' ? plan.cashBalance : 0`，右侧同理）。
- 场景：Host 只回 `giftBalance`（或只回 `balance`）时，详情显示「现金余额：¥0.00」——与 `session-display.js:110-126`、`client.js:5414-5426` 明定的「缺项不造 0」冲突，对 display 来源属**编造数值**。
- 最小修：两侧改为「字段存在才渲染该侧」；`plan.displaySource === true` 时尤其不得补 0（手工来源可保持现状，避免动旧行为）。

### B8 无「真实 Host 联接」的端到端覆盖（用户明确要求的验收项缺失）
- 现状：`tools/test-mimo-display-session.mjs:12-14` 直调**真实 `handleAuth` + 真实 `createDisplayManager`**，但**未建 `createAuthHost` / `connection.fetch.register`**；`tools/test-mimo-display-client.mjs:70-122` 用手写假 DTO + 假 `globalThis.fetch`，因此 **Host DTO 形状漂移（字段改名/增删）不会被任何测试抓到**。
- 最小增量（交 High 写，全合成、无网络、不动旧矩阵）：
  1. 新建 `tools/test-mimo-display-e2e.mjs`：`createAuthHost(fakeCtx, BOOT, onStatus, { displayProducer, displayIdentityVerifier, displayBalanceAdapter, displayNamespace, now, setTimeout, clearTimeout, randomId })`，用 `fakeCtx.connection.fetch.register` 捕获的 handler 桥接为 `globalThis.fetch`；
  2. 载入**真实 `client.js`**（复用 `tools/mock-react.mjs`）→ 断言胶囊出现金额与币种、详情出现「停止」按钮；
  3. 点击停止 → 断言 Host 侧 DTO `balance === null && state === 'stopped'`，且**再次 status 不会重新出现数值**；
  4. 断言全流程 DTO/渲染文本不含秘密哨兵。
- （B1–B4 的最小用例也建议落在同一文件：无 status 时的自主到期、超时后 adapter 调用数为 0 的下一轮、`fail-fail-success` 交替下的 attempt 上限。）

## 2. 应修但非阻断（同批可带，不做也行）

| # | 位置 | 现象 | 最小修 |
| --- | --- | --- | --- |
| N1 | `client.js:5641-5681` | `pump()` 无在途守卫；用户点停止后，**先发出、后返回**的旧 status 会把 `snapshot` 覆盖回 `verified` + 数值，数值短暂复活（≤3 s，下次轮询自愈） | store 记 `lastActionSeq` / `stoppedIds`，`pump` 只接受比最近动作更新的 DTO（或 `displayId+generation` 不在墓碑集合里） |
| N2 | `client.js:5622-5640` | bootstrap 不登记 `inflight`，多挂载并发发出重复 GET（纯观察、0 副作用） | bootstrap 也登记 `inflight` 复用同一 Promise |
| N3 | `client.js:5489-5569` | 客户端请求无超时；单个 status 挂死会阻断 `arm()` 重排（界面仍可用） | 加 `AbortController` + 定时 abort，超时按 `E_REQUEST_TIMEOUT` 处理 |
| N4 | `client.js:5659-5671` + 首挂 | boot 变化/页面刷新瞬间 `snapshot=null` ⇒ MiMo 行短暂回落手工 Cookie 旧值（墓碑意图被短暂绕过） | 增加 `bootstrapping` 态：MiMo 行在此期间显示「读取中」，不渲染手工值 |
| N5 | 显示新鲜度 | 路由整体不可达（非刷新失败）时 Host 不会标记 `stale`，客户端 `freshness` 永远 `fresh` | 客户端按 `now - fetchedAt > 2 × minInterval` 降级为「历史值」显示 |

## 3. 已核通过（不需再动）

- 旧单次链**未改**：`session.js:97-134` 与 `host.js:253-311` 的 `postQrRuntime`/`claimReadBalance` 原样；display 的 `credential` 是独立 owner（`session-display.js:12-13, 495-496`），**无双存/无抢救**。
- DTO 白名单：`session-display.js:354-380` 只投影非密字段；路由响应体不含 credential/expected/actual/grant（`:198-215`）。
- 严格字段集与越权拒绝（`routes.js:155-174`，含 `url/credential/token` 即 400）、boot 校验 409（`:173`）。
- disabled 语义：`displayStatus` 返回可信 `absent`（不伪装成通信故障）、`displayStop` 幂等 200、其余 503（`routes.js:175-186`）。
- `status` 纯观察：`routes.js:178-181` 不碰 DI；`session-display.js:528-532` 只读投影。
- 401/403 → halt 清值且**不写「过期」**（`session-display.js:313-317`）；换号/身份不明/缺币种 → halt（`:334-345`，`:113-126`）。
- 首读单次 claim（`:539-541`）；`grant` 需 `confirmedByUser==='match'` 且仅一次（`:583-604`）。
- 胶囊与详情**同源 overlay**、详情有可见停止入口（`client.js:1838`、`:2304-2306`）；客户端 picker 逐字段重建、无凭据字段（`:5428-5467`）。

## 4. 文档更正（非代码，但属交付物准确性）

| 位置 | 现文 | 事实 |
| --- | --- | --- |
| `docs/mimo-session-display-20261105.md:20` | 「`done` 语义**不变**，仍清快照」 | `session.js:119-126`：`done` 时 `clearPostQr(s, true)` 且 **不清** `balance`/`confirmedByUser`。旧链 `done` **保留**余额投影 |
| 同文件 `:109`；`session-display.js:29-30` | 「14 × 60 s = 840 s < 900 s，自动刷新一定落在本地持有上限内」 | 900 s 从**收到凭证**起算，grant 发生在登录+身份+首读+比对之后，剩余窗口通常 < 900 s。代码 `:599` 用 `min(credentialExpiresAt, …)` 已正确处理，**是文案过度主张** |
| 同文件 `:134-136` | 「15 min 本地持到期 expired」 | 只在**下一次 status/read/grant/tick** 才生效（见 B1）；应写「惰性判定 +（应补）自主到期 timer」 |
| `docs/mimo-real-protocol-operation-sheet-20261105.md:26` | V0「无需许可」 | 离线诊断器仍属**新增代码**，与「未许可不改代码」冲突；应写「V0 亦需一次代码许可」 |
| 同文件 `:37`、`:49-50` | 「含敏感值的 query **只允许本机私有保存**」 | 与「凭据/敏感值不落盘」冲突；应改为「不得保存，仅允许内存内短暂持有」 |
| 同文件 `:74` | 「真实适配必须继承 14 次/15 min 等约束，不得放宽」 | 这些是**临时本地界**（待产品批准），不应冻结为真实适配的正式策略；应标注「临时，随产品批准调整」 |

## 5. 第一轮结论（历史）

**不通过**：B1–B8 需修（B1/B2/B4 属安全边界，B5/B6/B7 属功能承诺，B8 属用户明确要求的验收）。

---

# 6. 第二轮复核（2026-11-06）· 终审

> 范围：只核原 B1–B8 / N1–N5 及相关差异；未跑三套新测试（作者实跑 session 78/0、client 39/0、e2e 50/0）、
> 未跑旧 26/21/56、未封存/hash/现场、未联网。

## 6.1 逐项核对（全部通过）

| 项 | 判定 | 证据位置 |
| --- | --- | --- |
| **B1** 自主生命周期 | 通过 | `session-display.js:428-442` `armLifecycle()`（`pendingDeadline`/`credentialExpiresAt` 较早者，`unref`）；`:417-426` `expireIfDue()` 惰性+幂等；`:662-667` **拿到凭证才起算** hold/pending；`:761-762` confirm **不重置** pending；`:777` grant 后取消 pending 界。用例 `test-mimo-display-session.mjs:355-365`（`peek()` 不触发惰性判定，故只能由 timer 生效）+ e2e `:371-380` |
| **B2** 超时 fail-stop | 通过 | `:243-253` `beginOp` 统一 `min(now+10s, phaseDeadline)`；`:284-363` `bounded` 收**工厂**并先校验 live+deadline（过期**零调用**）；timeout 分支 `:316-328` 先归属校验再 `haltFor(d,TIMEOUT)`；`:309-313` `onAbort`/`op.cleanup` 让外部 abort 与 stop **立即 settle**；`:330-339` 同步 throw 捕获；`:340-350` 迟到结果同样 fail-stop。旧 timer 只按 `display===d && opToken && opController` 判定，**不会杀新会话**（`:318-322`）。用例 session `:420-443`（挂死→10s→stopped 且不再发请求、晚到不复活）、`:444-465`（旧 op 停后立即 settle + 新会话不被旧 deadline 杀）、`:466-490`（producer6s+verifier5s 共享 10s，verifier 观察到 abort） |
| **B3** 终止类一致分类 | 通过 | `:80-90` `DISPLAY_TERMINAL_CODES` + `TEMP_ONLY`；`:445-455` `classifyFailure`、`:457-470` `classifyThrow`（含 `throw {status:403}`、未知错误→终止）；三处调用 `:489-496`、`:590-595`、`:736-744` 共用。用例 session `:392-400`、`:492-512` |
| **B4** attempt 预算 | 通过 | `:566-574` **dispatch 前**同步 `grant.used += 1`；`:567`、`:586`、`:597` 三处到期即 stop。强断言在 e2e `:354-364`（`attempts === 14` 精确等值 + Host 终态 `REFRESH_EXHAUSTED` + 清值，且先读**注册 handler** 再断 client 投影） |
| **B5** 停用不复活 | 通过 | `client.js:1838-1842` `allowMimo: settingBool(config,'mimoEnabled',true)`；`:5941-5944` 不允许即原样返回；`:5972` 仍需显式允许才 push。用例 e2e `:416-425`、client test `:286-292` |
| **B6** pending 显式关闭 | 通过 | `client.js:6099-6116` 真实「关闭并取消本次核对」按钮（holding / verified-未-grant / awaiting 三段）；`:5866-5873` 只在被调用时 stop；`:5806-5814` 普通卸载**只**减挂载与停轮询。用例 e2e `:293-308`（关闭→Host stopped；已 grant 的被动卸载不取消） |
| **B7** 缺项不造 0 | 通过 | `client.js:2246-2256` `strictSplit = plan.displaySource` 时缺失侧渲染 `null`（手工来源保持旧行为）。用例 e2e `:407-413` |
| **B8** 端到端 | 通过 | `test-mimo-display-e2e.mjs:11` 真实 `createAuthHost`、`:94-108` 真实 `connection.fetch.register` 捕获、`:128-133` 桥接为 `fetch`、`:146-151` 经**组件 `onClick`** 点击、`:202-205` 直连 handler 取 Host 原始状态；覆盖 start/read/confirm/grant→胶囊/详情/停止/重挂/刷新/换号/预算/自主到期/挂死/throw/缺分项/停用 |
| **N1** revision 屏障 | 通过（实现） | `session-display.js:365-374` manager 级单调 `revisionSeq`（跨 display 代次不重置）、`:370-374` `bump`；`client.js:5692-5714` 接受规则（旧 gen 永拒 / 同 gen 比 revision / 同 gen 不同 id 拒）、`:5761-5766` status 发送捕获 `barrier` 与当前不等即丢、`:5838-5845` 动作发出即升 barrier 并本地遮蔽 |
| **N2** 单飞 | 通过 | `client.js:5675-5691` 共用 flight（旧 finally 不清新 flight）、`:5794-5804` 多挂载只走一条轮询。用例 client test `:268-284` |
| **N3** 客户端 deadline | 通过 | `client.js:5657-5674` 10 s `Promise.race` + abort，底层不理 abort 也落定。用例 client test `:334-342`（永挂 fetch 不卡死 single-flight） |
| **N4** 首帧/换 boot 遮蔽 | 通过 | `client.js:5609-5610` `resolving=true` 初值、`:5715-5729` `dropBoot` 重置、`:5946-5959` resolving 且无快照时用"读取中"占位。用例 client test `:296-304`、e2e `:235` |
| **N5** 本地新鲜度降级 | 通过 | `client.js:5874-5890` `now-fetchedAt > 2×minInterval` ⇒ `stale`，配套文案 `:6014-6018` 带时间。用例 client test `:318-322` |

## 6.2 文档更正（已落实）

`docs/mimo-session-display-20261105.md:20`（`done` 保留 balance）、`:111-112`（timer 自主到期 + 840 s 只是典型上限，不再写"一定刷 14 次"）、`:98-107`（限额标为**临时本地界**、14 为 attempt）；操作单 `:26`（V0 亦需代码许可）、`:38/:54`（敏感 query 只内存、不得落盘）、`:79`（临时界不冻结为真实适配硬约束）。MEMORY 与 AGENTS 新增段与代码口径一致，无真实成功主张。

## 6.3 残余（**不阻断**，仅记录事实）

1. `client.js:5393-5421` 的 `MIMO_DISPLAY_CODES` **未登记** `E_MIMO_AUTH_DISPLAY_PENDING_EXPIRED`（Host `session-display.js:60` 新增）：120 s 自主到期时 Host 回该码，client 会折叠成空串，详情只显示"已停止"而**不显示原因码**（值已清空，不冒充）。一行可补（加该键后 `:6029-6032` 自动显示）。
2. N1 的 revision/barrier 顺序逻辑**无直接断言**（e2e `:326` 覆盖的是 `stopping` 本地遮蔽；client test 未构造"同 gen 低 revision 迟到"或"动作后旧 status 迟到"）。属覆盖缺口，不是功能缺陷。
3. `test-mimo-display-session.mjs:414` 用 `attempts <= 14`，可被"零请求"满足；同 case `:416` 的终态断言可挡住大部分空过，且 e2e `:360` 已用精确 `=== 14`。建议下次触碰时对齐为等值。

## 7. 终审结论

**Pass（仅限本地合成范围）**：B1–B8 与 N1–N5 全部落实，阻断项清零；残余 3 条均不阻断。
**Pass 不包含**：真实供应商余额 method/path/scope/audience、auth result 字段与载体、独立 expected 身份来源、
上游 cancel/revoke 的任何验证；也不代表真机/GUI/部署/版本可用性。生产 DI 恒 null ⇒ `display*` 动作 fail-closed。
