# MiMo 收尾 UI / 60s 自动读 / 失败可视 · 窄终审（2026-11-10）

> 范围：**只审本包 5 文件差异 + 单次部署脚本门**。未重跑大矩阵、未执行安装、
> 未做真实账户/API/配置/record/browser/env/log/服务/网络/重启/发布。Codex 不在本包。
> 声明：合成通过 ≠ 实机通过；作者已列出的旧套红灯见 §4。

## 0. 结论

**Pass（仅本包差异 / 合成与静态范围）**。未发现阻断；三条非阻断观察见 §3。

## 1. 版本（实算，8/8 一致）

| 项 | SHA-256 |
| --- | --- |
| `remembered-session.js`（whole） | `AC59AFFB…6BC84EA63B` |
| `console-protocol.js`（whole） | `9768B5F3…17390357B9` |
| `routes.js`（whole） | `01C5BE5B…F86E4881523` |
| `host.js`（whole） | `1C1C8C08…B4EF2F065AC010` |
| `client.js` stage（= UI staged） | `8F010A7C…37E29D509F` |
| `client.js` WS 受测（WB dirty） | `0964518A…764A6E475E` |
| `client-hunks.json`（23 hunks, final） | `7108597D…22431B1301E` |
| `deploy-mimo-ui.mjs` | `CE8ADE9F…6EB12714D5`（260 行） |
| `plan.json` | `E84AD3E6…6616667648939`（finaltrue / pending / **approvedfalse**） |
| helper | `A187A1D7…78CE3D3`（未改） |

`stage/` 恰好 5 个文件；`stage/client.js` 与 `staged/client.js` **同 hash**（8F01，未混目录）；
已装仍 controller `B2294E06…` / protocol `20A7466F…`（0 写）；base = header-profile 的 17。

## 2. 核心核对

1. **唯一读入口与单飞**（`remembered-session.js:736-816`）：`balanceFlight !== null` 时**直接返回同一 promise**；
   判定发生在 `beginOp` **之前**，且 body 延后一个微任务启动，`balanceFlight` 在 body 第一行前已发布 ⇒
   `enabledGate` 的 await 窗口里来的 tick/refresh 也会 join。计数（`readAttempts`/`refreshCount`/`readFailures`）
   只在 flight 内部 +1 ⇒ 每个**实际读**恰好一次；`joined` 失败不会返回 `ok:true`（`refresh()` 用 `ok===true` 才成功）。
2. **tick / refresh 的 owner 绑定**（`:709-724`、`:825-843`）：两者都先 capture `generation` 与 `protocol`，
   await 之后仅当同一 owner 才 `armTick()`；旧 owner 的迟到读数不会重排新 owner 的 60 s timer。
3. **五失败语义**（`:798-807`、`:315-326`、`:374/445`）：只对 `COUNTED_READ_FAILURES`（网络 / `BALANCE_PARSE` / 读自身 timeout）
   计数；1..4 保旧值且 `freshness='stale'`，state 仍 verified、timer 不停；第 5 次 `readFailedOut()` ⇒
   **snapshot 与 displaySnapshot 都把 `balance`/`fetchedAt` 置 null**（内存 last-good 不外透），下一次真实成功 `readFailures=0`。
4. **认证/绑定与非普通失败**：`AUTH_REJECTED`/`ACCOUNT_CREDENTIAL_MISSING`/`IDENTITY_MISMATCH` **立即** `terminateAndForget`（`:778-786`）；
   其它安全/协议码走 `failClosedRead()`（`:794-797`、`:854-862`）：`dropProtocol` + `disarmTick` + `clearValues` + `state=failed`，
   **不写 tombstone**（密文保留），不把旧值当新值。
5. **protocol 保留判定**（`console-protocol.js:502-511`）：`kind==='balance' && state==='verified' && ownerLive()`，
   且仅 `TRANSIENT` / `BALANCE_PARSE` / **有 `now>=deadlineAt` 证据的 `EXPIRED`** 才 keep；`CANCELLED`、owner 失效、
   认证/凭据/SSO/MFA、无证据 EXPIRED 一律不 keep。两处 finish/readBalance catch 共用同一 predicate（`:538`、`:1426-1428`）。
   坏 JSON 仍只在该读内 `JSON_UNSUPPORTED → BALANCE_PARSE`，strict parser / size / 危险 key 未放宽。
6. **路由**：新动作 `rememberedRefresh` 在动作集合内、严格 `action/bootEpoch/generation` 字段，先过原 owner gate 与
   `generation` 相等（否则 409），并有**显式分支**调用 `api.refresh()`，绝不落到末尾 `retry()`（`routes.js:483-541`）；
   `rememberedSnapshot` 只投影 `readFailures`（0..5 夹取）与 `freshness` 固定闭集（`:366-370`），status/caps 不读 record。
7. **host**：`rememberedApi.refresh = () => remembered.refresh()`（`host.js:263`），无额外路径。
8. **client**：
   - 投影闭集：`readFailures` 必须是 0..5 整数、`freshness` ∈ {fresh,stale,failed,paused}（`:4533/4571-4572`、显示侧同套 `:6267/6279`）。
   - **五次判断先于金额**：`:6991-6997` 在设置 `plan.balance` 之前拦截，即使 DTO 带 balance 也不显示金额；
     `:7003` `stale = freshness==='stale' || readFailures>0`（计数>0 必灰）。
   - 胶囊/标题**不带 cause**：`:6892/6922` 只出「余额读取失败 / 待读取」；具体固定码只进详情文案。
   - 展开刷新：只在 `open` false→true 触发，要求 managed+selected+verified、非 paused、`mimoEnabled`/`enabled` 为真、
     `bootEpoch` 合法；manual 单独 coalesce（不被 status flight 抑制），回包按 **bootEpoch + store.epoch** 校验，
     `ok:false` 也走 pureStatus 落灰/隐藏金额，随后等 `inflight` 落定再 pump（`:1251-1294`）。
9. **部署脚本（CE8A，260 行）**：write 5（4 whole + client 23 冻结 hunk）/ verify 12 + 2 meta；
   old 三方同值、WS/client goal/hunks 三 pin 分开、`staged.size === WRITES.length`（final+pins 齐全时 5）、
   任一 false 拒、meta 读失败或字段非法 false、`abs` 限 TARGET 后 `dirname+basename` 交 A187 helper、
   写后 newSHA+nlink1+ino 变、12+meta 不变、新 17 逐项 5 goal/12 base、partial 如实、`approved` 才 exec。

## 3. 非阻断观察

1. 第 5 次失败后 `state` 仍是 `verified`、`balance=null`；UI 以「余额读取失败」呈现，语义一致，但 `state` 与展示隐含不同——已由 `readFailures/freshness` 表达，属设计取舍。
2. `tick()` 在 joined 情况下仍会 `armTick()`（`:723`），依赖 flight 所有者与幂等 arm；正常路径不会双 timer，但这是「靠幂等」而非硬互斥。
3. 本包未提供真正的 Host.route→controller→client 全贯通测试；作者明确两侧各自真实链 + 字段对照。

## 4. 未证与已知红灯（不掩盖）

- 作者已列旧套红灯：auth / postqr / remembered-client-e2e / display-e2e 多为旧 Cookie/折叠/文案/pause/管理行预期，尚未更新；
  `degrade-refresh` 38/43 与原装 113C 同样 5 fail（假 fetch 无可信 display，N4 遮罩），**不是本包新 root**。
  **不能**称这些旧测试通过。
- 未验证：真实 60 s 节奏、真实余额读、真实展开刷新、跨重启、Codex（本包不含）。
- 作者自测：后端 14/0、UI 12/0 + 5/0 + 6/0、非 MiMo footer 12/0 / collapsed 4/0 / interactions 12/0；本报告不把这些当实机证据。
- 23 hunks 我做了独立模拟：对已装 `113C` 逐个 `oldString` 唯一命中，结果 SHA = stage `8F01`（= `stage/client.js`），
  但这仍只证明「hunk 应用正确」，不证明 UI 运行时的全部行为。

## 5. 结论与下一步

**Pass（本包差异 / 合成与静态范围）**。安装仅待主代理置 `deployApproved=true` 后执行这 5 个文件；
真实效果（60 s 自动、展开一次真实读、五次失败可视、退出即清）需用户本轮本地试装后自证；Codex 另启。
