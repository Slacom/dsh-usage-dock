# MiMo 本机显示会话（sessionDisplay）· 设计与实现记录（2026-11-05）

> **状态：仅本地合成实现。生产 DI 恒为 null ⇒ 全部 display 动作 fail-closed。**
> 本文不主张任何真实厂商协议已证；`合成通过 ≠ 真实可用`。

## 0. 一句话

在**旧单次链完全不动**的前提下，新增一个**独立的**本机显示会话管理器：本人核对身份 →
只读一次余额 → 本人比对 → **新的持续刷新授权（refreshGrant）** → 有界自动刷新，供侧栏胶囊/
详情显示；停止/过期/换号即清空凭据与数值。

## 1. 与旧单次链的隔离（必须一起读）

| 关注点 | 旧单次链（0.9.x / post-QR local） | 本机显示会话（本次新增） |
| --- | --- | --- |
| 管理器 | `plans/mimo-auth/session.js` | `plans/mimo-auth/session-display.js`（新） |
| 凭据来源 | post-QR `postQrAuthResult`（合成 producer） | **DI `displayProducer`**（独立，合成） |
| 票的处理 | `claimReadBalance` 后**同步段**清 `authResultMemory/accountRef` | 凭证由 display manager **唯一 owner** 持有，按 grant 交给 DI adapter |
| 交叉引用 | — | **不调用**旧 start/begin/readBalance/claim/authResultMemory；**不复用也不复制旧票** |
| 状态 | 7 值：`idle/running/done/failed/cancelled/expired/disposed` | 5 值：`absent/holding/verified/stopped/expired`（旧 `done` **完全未改**：`session.js` 的 `done` 走 `clearPostQr(s,true)`，**保留** `balance`/`confirmedByUser`，只清凭据相关字段；本模块不触碰） |
| 停止 | `cancel` → `cancelFlow` | 独立 `displayStop`，**不调用 `cancelFlow`** |

> 因此不存在"同一张票在旧槽与新 vault 各存一份"的问题：两条链**没有任何共享的凭据对象**。
> 旧路径的销毁承诺一字未改（`session.js` 未修改）。

## 2. 状态机

```
absent ──displayStart(producer+verifier 成功, expected==actual)──> verified
      └──(任一失败)──> stopped（tombstone: selected=true）
verified ──displayRead(单次)──> verified(+value, awaitingBalanceMatch)
verified ──displayConfirm(match)──> canGrant=true
verified ──displayConfirm(mismatch)──> stopped（清值）
verified ──displayGrant──> verified(+grant，按 60 s 开始调度)
verified/stopped ──displayStop──> stopped（清 timers/vault/grant/value/mask/account 关联）
holding/verified ──15 min 本地持有到期──> expired（清值，tombstone 保留）
```

`selected` 是**进程内墓碑**：stop/expire 之后仍为 `true`，阻止手工 Cookie 旧值回填；
Host 重启（新 boot）后一律 `absent`，无跨 boot 快照。

## 3. API（复用现有 owner-only 路由，不新增路由/transport）

路由：`/api/plan-usage-mimo-auth`（既有；`connection.fetch.register` 的 owner admission 不变；
`no-store` / 8192 body / boot 校验 / 严格 JSON 均复用）。

| 动作 | 请求体（**严格字段，越权即 400**） | 说明 |
| --- | --- | --- |
| `displayStart` | `{action,bootEpoch,expected:{namespace,identifier}}` | 建立会话；`expected` 只是**期望** |
| `displayStatus` | `{action,bootEpoch}` | **纯观察：0 DI 调用**；生产 disabled 也给可信 absent |
| `displayRead` | `{action,bootEpoch,displayId,generation}` | 只读一次；同步 claim，第二次拒绝 |
| `displayConfirm` | `{...displayId,generation,verdict:'match'\|'mismatch'\|'later'}` | 本人余额比对（G4） |
| `displayGrant` | `{action,bootEpoch,displayId,generation}` | **G5 新授权**；必须已 match 且尚未 grant |
| `displayStop` | `{action,bootEpoch,displayId,generation}` | 独立停止；disabled/已停/已过期均幂等 200 |

响应：`{ ok, code, bootEpoch, display }`；`display` 为白名单 DTO（见 §5）。
`GET` capability 追加 `displaySupported` 与 `displayNamespaces`（只读能力，不加载 flow、不发网）。

明确**不接受**的字段（出现即 400，不静默忽略）：`url` / `host` / `path` / `token` /
`credential` / `actual` / `verified` / `sourceProof` / `maxLifetime` / 任何 grant 内部字段。

## 4. DI 合同（唯一出站边界，代码级注入）

```js
createAuthHost(ctx, bootEpoch, onStatus, {
  displayProducer,          // async ({namespace,signal,deadlineAt}) => {credential}
  displayIdentityVerifier,  // async ({credential,signal,deadlineAt}) => {identity:{namespace,identifier}}
  displayBalanceAdapter,    // async ({credential,purpose:'balance',signal,deadlineAt})
                            //   => {ok:true, identity, balance}|{ok:false,code,status?}
  displayNamespace,         // 合成 DI 支持的 namespace（生产未证 ⇒ 不传 ⇒ disabled）
  now, setTimeout, clearTimeout, randomId,
})
```

- **四者缺任一 ⇒ `enabled=false`**：`displayStart/Read/Confirm/Grant` 一律 503
  `E_MIMO_AUTH_DISPLAY_DISABLED`；`displayStatus` 仍返回 `displaySupported:false` 的安全 absent，
  `displayStop` 幂等 200。UI 勾选/JSON 布尔**无法**启用。
- adapter 每次都必须回 `identity`，且必须与 start 时绑定的 `actual` 相同；
  **变号或身份不明 ⇒ 立即 stop + 清值**（fail-closed）。
- 合成边界：不写真实 URL / cookie 名 / 厂商三键；真实 method/path/scope 仍未证（见操作单）。

## 5. DTO 白名单（客户端 `mimoDisplayPick` 逐字段重建）

`displaySupported, selected, state, displayId, generation, identity{maskedLabel}, balance{balance,cashBalance?,giftBalance?,currency}, fetchedAt, freshness, code, awaitingBalanceMatch, canRead, canGrant, canStop, refreshCount, maxAutoRefresh, nextRefreshAt, credentialExpiresAt, localLimits{...}`

**永不出现**：credential / expected / actual / accountRef / grant 内部对象 / 上游错误正文 / URL / 原始账号。
`currency` **必须可证**：缺失即判 `E_BALANCE_PARSE`，**不默认 CNY**；现金/赠金缺项**不造 0**。
`maskedLabel` 只由 Host 侧 `u***` + 尾部 4 位安全字符生成（≤32），**仅展示、永不作身份依据**。

## 6. 身份口径（G2 的真实边界）

- `expected` 来自**本机事前输入/选择**，只是"本人期望"，**不是真实性证明**。
- `actual` 只来自代码级受信 `identityVerifier`；Host 内部比较 "expected == actual（同 namespace 同标识）"。
- **禁止**：从 actual 反算 expected；用 mask 相似放行；用本人自述/`confirmedByUser` 替代。
- 真实 namespace 未证 ⇒ 生产无可用真输入链 ⇒ 走 blocked（本实现即"disabled"这一合法结果）。
  合成 DI 指定 namespace，并在测试中**真实比较** expected 与 verifier 输出的同 namespace 标识。

## 7. 限额（`DISPLAY_LIMITS`，Object.freeze）—— **临时本地界，随产品批准调整**

> 这些是**临时**本地保守值，不是厂商策略，也不冻结为真实适配的正式政策。

| 项 | 值 | 口径 |
| --- | --- | --- |
| 最小刷新间隔 | 60 000 ms | 本地界 |
| 凭证本地持有上限 | 900 000 ms（15 min） | **从收到凭证起算；不主张等于厂商有效期** |
| 无-grant 阶段期限 | 120 000 ms | **从收到凭证起算**，覆盖 verify→未 read→待 confirm→match 待 grant；**不因 read/confirm 重置**；到点 halt 清凭据 |
| 自动刷新次数 | 14 **attempt**（含失败；首次读取不计） | 第 14 次尝试后立即 stop 清值 |
| 连续暂时失败 | 3 次即停 | 只认明确 network/429/5xx；**超时与 401/403 属终止，不重试** |
| 单次 DI 操作 | 10 000 ms | deadline race + AbortController；超时 = **fail-stop**（清值、取消 grant、不重试） |

到期清理由 **`lifecycleTimer` 自主完成**（不需要任何人先读 status；timer 与 status 同时触发幂等）。
grant 之后 14×60 s = 840 s 只是**典型**上限；实际可用次数会被登录/核对/失败操作耗时挤压，故不写"一定刷 14 次"。

## 8. 用户可见流程与语义

1. **G1 建立会话**（设置 → MiMo 卡片内面板）：填 expected namespace/identifier → `displayStart`。
2. **G2 身份**：status 只显示 `maskedLabel`；不一致/不明 ⇒ 直接 stopped。
3. **G3 读一次**：显式按钮 → `displayRead`；单次语义由 Host 强制（UI 去重只是体验层）。
4. **G4 本人比对**：`match` / `mismatch`（停）/ `later`（不追加请求）。
5. **G5 持续授权**：`displayGrant` → 60 s 调度，最多 14 次。

**收起 ≠ 取消**：面板卸载/收起/页面刷新**不发** `displayStop`，Host 内存合法状态可恢复
（pending 仍受 120 s 限制）。**只有**显式「停止」（详情里也有按钮）或 pending 视图被明确关闭才 stop。
本地清除 ≠ 上游注销（本实现根本没有上游登出能力）。

## 9. 测试证据（仅本地、无网络）

```text
node tools/test-mimo-display-session.mjs   → 78 passed, 0 failed
node tools/test-mimo-display-client.mjs    → 39 passed, 0 failed
node tools/test-mimo-display-e2e.mjs       → 50 passed, 0 failed
node --check plans/mimo-auth/session-display.js / routes.js / host.js / client.js  → 均通过
```

覆盖（Host 侧）：生产 disabled 的可信 absent / 503 / 幂等 stop、严格字段越权 400、boot 409、
start 成功与身份 mismatch、status 纯观察 0 adapter、read 恰 1 次且第二次拒绝、
未比对不给 grant、60 s 间隔与次数、**14 次用尽即停清值**、临时失败 1–2 次 stale 保值 / 3 次停、
401 与 403 一律 stop 且**不称过期**、adapter 变号/缺身份/缺币种 stop、单飞、错 id/gen 409、
15 min 本地持到期 expired 且 selected 墓碑保留、**秘密哨兵（token 不出现在 DTO）**。

覆盖（客户端）：disabled 时胶囊仍显示手工来源、selected 时 DTO 驱动且手工旧值不出现、
stopped 时显示"已停止"且不回填、详情里有**可见停止按钮**并真的发 `displayStop`（请求不含凭据）、
picker 丢弃未知字段、无币种不默认 CNY、boot 变化立刻作废旧 snapshot 与旧代次、
单例 store（第二个订阅者不重复探测、只有 1 个定时器、reset 无残留）。

**未运行**：旧 26 / 21 / 56 矩阵（按本轮约束不重跑）。

## 10. 已知未完成 / 未证（不得对外声称）

1. 真实 producer / verifier / balance adapter **不存在**（生产恒 null），真实 method / path /
   scope / audience / 身份 namespace 全部未证（见操作单）。
2. 真实厂商 TTL / 撤销语义未证：本地 15 min 只是**本地界**；本地清除 ≠ 上游注销。
3. 每次刷新的"真实身份已复验"只有在受信 adapter 回 identity 时成立；合成件不构成证据。
4. 未做真机/GUI 验证；未构建包、未部署、未改版本、未发布。
5. 客户端 display 轮询默认 3 s（仅状态、0 上游），未做多标签页互斥（Host 侧单活会话兜底）。
6. **端到端测试已全绿（50/0）**。此前"6 项红＝测试装配问题"的判断**作废（仅作历史）**，
   真实根因有三：① Host `revision` 每代重置 ⇒ client 丢弃新 generation 的低 revision
   （已改**manager 级全局单调** revision；client 改为 generation 前进即接受、旧 gen 永拒、
   同 gen 才比 revision 且不同 id 拒）；② e2e fixture 设 `adapterIdentity=B` 却用 `ID_A` 起会话
   ⇒ Host **正确拒绝**（不是缺陷）；③ 预算 case 在 `poll=0` 下拿 client store 代表 Host 终态
   （已改为先经**注册 handler** 读原始 `displayStatus`，断 `attempts===14` + `stopped` +
   `REFRESH_EXHAUSTED`，再 `pump` 断 client 投影）。
   另补最小边界用例：旧挂死 op → stop → 新会话；旧 deadline/迟到结果不得杀新会话；
   producer 6 s + verifier 5 s 共享同一 10 s 预算且 signal 被 abort；`throw {status:403}`
   首读与刷新都 halt；client 侧"fetch 不理 abort 也能靠 race 落定且 single-flight 可恢复"。
7. **审核状态（2026-11-06）：本地合成 Pass** —— 作者实跑 78/39/50，Max 完成**静态差异复核**并 Pass
   （B1–B8 全闭、N1–N5 落实），记录见
   [Max 复核 §6–§7](mimo-session-display-review-20261105.md)。**真实链仍未完成**（生产 DI 恒 null）。

### 10.1 Max 复核提出的 3 项**非阻断**遗留（本轮不修，如实记录）

1. **客户端未登记 `E_MIMO_AUTH_DISPLAY_PENDING_EXPIRED`**：Host 会返回该码，但 client 的
   `MIMO_DISPLAY_CODES` 白名单里没有 ⇒ 界面只显示"已停止"而**不显示具体原因**（不构成安全/功能阻断，
   但排障时少一条线索）。
2. **直接 `revision`/`barrier` 的迟到专用断言缺口**：现有用例覆盖了"停止后迟到不复活"（行为层），
   但没有**单独**构造"旧 revision 的 status 迟到 + barrier 已推进"的单元断言。
3. **session 单测的 attempt 断言是 `≤14`**，由 e2e 的 `attempts === 14` 兜住（两层合起来足够，
   但单层不够精确）。
