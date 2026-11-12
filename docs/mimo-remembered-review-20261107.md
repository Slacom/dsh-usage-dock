# MiMo「记住登录 / 自动恢复」候选 · Max 终审（2026-11-07）

> 范围：**本地合成 + 静态**。审的是即将安装的候选源码/接线（工作区 + `stage/`）。
> 未执行安装、未跑测试套、未联网、未读真实凭据/配置/记录/QR/余额。角色：Max（独立终审）。

## 0. 结论

**Pass（本地静态 / 合成范围）** —— 2026-11-07 晚更新。
初版曾判 Blocked（1 项：`enabled=false` 未接线中止在途，见 §1），该阻断已在唯一修正中关闭（§6），
新 stage 8 哈希已逐项复核（§7）。

**此 Pass 的边界**：只覆盖本地源码、合成测试与安装候选（stage）本身。
不表示真实 runtime 可用：真实扫码/余额/自然换票/跨重启恢复、生产 credentials 服务写入、
Host 的 lazy `resolveVault` 生产分支、QR 120s / restore 10s 真实时长、Android 均**未验证**；
本轮也**未执行安装、未重启、未触真实账号/记录**。


## 1. 阻断项（具体位置与最小修复原则）

**位置**
- `plans/mimo-auth/remembered-session.js:1207` 导出 `disable`；`:1161-1172` 实现正确
  （`invalidateOps()` + `dropProtocol()` + `disarm*` + 清值 + `state='disabled'`）。
- 唯一调用：`remembered-session.js:591-595`（`tick()` 开头 `enabledNow()` 为 false 时）。
- `plans/mimo-auth/host.js:228` 只把 `isEnabled` 注入 controller；全文件**无** `disable(` 调用；
  `:625` 返回 `rememberedSession` 未被使用。
- `index.js:284-300` 只传两个 flag 与 `isEnabled`，没有把 session 句柄或配置变化事件接出去。
- `routes.js` 的 `remembered*` 分支在 `enabledNow()` 为 false 时只返回 `E_MIMO_REMEMBERED_DISABLED`，
  **不做 teardown**。

**后果（真实行为，不是形式问题）**
1. 一次余额刷新可能走 401 → SSO → callback → 重试（最多 5 跳，协议在此路径上没有逐跳的
   `enabled` 判断，只有 `isLive()`；而 controller 的 `isLive` 只看 `LIVE.has(state)` 与
   `lease.revoked`，`state` 仍是 `verified`）。
2. 因此用户中途关闭渠道/全局开关时，**剩余 hop 仍会发出**，成功后还会把余额提交并
   `persistIfChanged`；与「禁用后 0 请求、立即中止在途」的文案
   （`index.js:288`、`remembered-session.js:1160` 注释）不一致。
3. 最坏情况：禁用到下一次 tick 之间最长 5 分钟仍显示 `verified` 的旧余额（客户端按配置隐藏，
   但 Host 状态仍是 verified）。

**最小修复原则（不是实现稿）**
- Host 侧必须在开关翻转时**主动**调用 `remembered.disable()`：让 `registerMimoAuth` 能拿到
  session（或其 `disable` 回调），由 `index.js` 的 `liveConfig`/配置订阅触发；仅靠 5 分钟 tick 不足。
- 作为兜底，`routes.js` 里凡是 `enabledNow() !== true` 的分支应调用 `disable()`（而不是只回码），
  使「本人操作时发现已禁用」也能立刻中止在途并清值。
- 若不想引入配置订阅，至少要让协议逐跳的 `isLive()` 读一个**同步缓存**的 `enabled` 标志，
  由 Host 以 ≤1s 的廉价轮询刷新；不要把判断放在 `await enabledNow()` 之后的一次性入口。

**最小反例（离线可写，不必跑真实）**
fake transport 下进入 `verified` → 让下一次 `balance` 返回 401 并在 SSO 请求上前置 gate（挂起）→
把 `isEnabled` 翻成 false（不直接调 `disable()`）→ 放行 gate：当前实现会继续发出 SSO/callback 并提交余额；
期望是后续 hop 数为 0、状态转 `disabled`、余额被清。

## 2. 已核通过（本轮实际读过、未发现阻断）

- **TOFU/绑定**：`confirmAccountAction`（`remembered-session.js:921-992`）在**任何 await 之前**固定
  `protocol/candidate/lease/casRevision`，用 Host 自己的 `candidate`（`:933/:946`），
  路由**不接受**客户端 ID；`vault.save` 成功后才 `verified` 并首读（`:984-985`），
  失败则作废本次首扫（`:961-970`）。
- **恢复不反造**：`restore()` 用**已解密记录里的** `account.accountId` 作为 expected（`:466-484`），
  与 incoming 身份比较；`BINDING_MISMATCH` 时清密文且不重试（`:509-515`）。
- **导出最小化**：`selectExportRecords`（`console-protocol.js:1152-1179`）只取 4 个账号名、
  必须 `domain===account.xiaomi.com` 且 `path==='/'`、排除已过期、值保留原始字节；
  `expiresAt` 只存服务器**绝对值**或 `null`（不编 Max-Age）；`:1185-1205` 要求
  `verified + exportTrusted + bound` 且三处 ID 相等。
- **存储**：`remember-store.js` 无明文退路；record 白名单逐字段校验；`save` 的
  `expectedRevision` 在 `modifyRecord` 独占回调里比较后才加密（`:306-327`）；
  `forget` 先 `bump()` 再写无密文 tombstone（`:339-356`）；迟到 save 因 epoch 变化不返回成功。
- **DPAPI**：只 `win32` + `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` 绝对路径
  （`windows-dpapi.js:64-70`）；秘密只走 stdin、stdout 只回 Base64，stderr 丢弃；
  argv 只带脚本（内含 scope 派生 entropy，非凭据）；5s 预算、256KiB 上限、逐 op 取消、
  `dispose` 取消全部在途。
- **0 网络观察面**：`status()`/`snapshot()`/`displaySnapshot()` 只读内存与 `protocol.describe()`；
  `boot()` 在 `enabledNow()` 为 false 时**不解密**直接 `disabled`（`remembered-session.js:412-419`）。
- **候选 stagged 接线**：`stage/index.js:284-285` 的 `enableConsoleProtocol: true` /
  `enableRememberedAccount: true` 仅在候选里，workspace 默认无；`stage/.../host.js:228` 确实把
  `isEnabled` 透传进 controller、`:177` 用 `enableRememberedAccount === true` 才创建。

## 3. 未核 / 未证（不构成 Pass 依据）

- 未跑任何测试套（作者自测：protocol 56/0、remember 29/0、store 31/0、dpapi 13/0、
  controller 21/0、backend e2e 17/0、client-click R5 99/0），本报告不把它们当结论。
- 未验证：真实扫码/真实余额/自然券过期换票/跨重启恢复；生产 profile 凭据服务写入与 Host
  的 lazy `resolveVault` 分支（当前 DI 注入真 Vault）；QR 120s / restore 10s 的真实时长。
- 未审 `client.js` 的 React 细节（只核了 DTO 白名单与 panel gate 的存在性），
  也未核 `deploy-remembered.mjs` 的写盘流程（等 staged root hashes 后再核）。
- Android 明确 unsupported，未测。

## 4. stage 说明

本轮审的是 `stage/` 候选（8 个 staged full SHA 由主代理给出），
`rootStage` 由「已装基线 + 10 个 MiMo literal hunk」构成，因此与 worktree 的 client/index 哈希不同属预期；
workspace 里的 WorkBuddy dirty 不应进入本包。上述结论对 stage 与 worktree 的同一逻辑均成立
（两处 `host.js` 均无 `disable(` 调用）。

## 5. 部署脚本（deploy-remembered.mjs）写盘过程 · 追加核对

**写盘集合正确**：`execute()` 只写 `kind != verify-only` 的 **8** 项
（root-hunk 2：index/client；copy 3：host/routes/console-protocol；new 3：windows-dpapi/remember-store/remembered-session），
`verify-only` 的 **9** 项只记录不写。与「write8 / verify9 / closure17」一致。

**关键闸门（都在 execute 之前，任一失败即 `REFUSE` + exit 3，不写目标）**
- 基线：`mimo-console-install-20261106/INSTALL-MANIFEST.json` 必须 `complete` 且 14 项、目标根一致；
  14 项逐个比对现有安装 hash（含即将被 root-hunk 覆盖的 index/client）。
- 元数据：`package.json` / `plans/mimo.js` 必须保持基线 SHA（写前一次、写后复核一次）。
- 新模块：目标**必须不存在**，否则拒绝覆盖未知旧版本。
- root hunks：缺清单 / 缺条目 / `final !== true` 一律 `INCOMPLETE` 拒绝；`oldString` 必须在
  **已安装基线内容**中唯一命中（`applyHunks`），因此不会把 workspace 的 WorkBuddy dirty 带进来。
- staging 后逐个 `node --check`；并做两个 flag 门：staged `index.js` 必须含
  `enableConsoleProtocol: true` 与 `enableRememberedAccount: true`；staged `host.js` 必须保持
  源码默认 false（`dependencies.enableConsoleProtocol === true` / `source.enableRememberedAccount === true`）。
- 写前再核一次目标仍是 preflight 看到的内容；写后逐个核对 newSha；最后复核 verify-only 9 未变。

**当前实际状态**：`root-hunks.json` 现为 `final:false`、`reviewStatus:"blocked"`、
`deploymentApproved:false` ⇒ 按上面的闸门，**现在跑 execute 会在 root-hunk 处 INCOMPLETE 拒绝**，
与「未部署」一致。

**边界（记录，不作为本轮的额外要求）**
1. 脚本**不建备份、不产出回滚脚本**（RECEIPT 里 `backupCreated:false`、`rollbackPrepared:false`）；
   回滚只能依赖既有 trial 产物与 14 项基线清单，属人工动作。
2. 脚本**不校验** `reviewStatus`/`deploymentApproved`，只认 `final:true`；审批是脚本外的操作者闸门。
3. 8 次写入**非原子**：中途失败会留下部分新文件 + `RECEIPT.status=partial`（每步有写后 hash 校验）。
4. `stage/` 目录不先清空；hash 清单必须以同一次 dry-run 的 `staged=8` 输出为准。

## 6. 阻断项关闭复核（唯一 block 修正 · 2026-11-07 晚）

**修正源（已按主代理给的 SHA 校验，读的就是这三份）**
- `plans/mimo-auth/host.js` = `C0BC22C8…E4FB3`
- `plans/mimo-auth/remembered-session.js` = `F4B31554…347C5`
- `index.js` = `BDE16765E244…`
- 新反例 `tools/test-mimo-remembered-disable.mjs` = `59CEE4C5…A306`

**接线核对（逐条）**
1. Host 侧 `syncEnabled` 初值 **false**（fail-closed），并以 `isEnabledSync: () => syncEnabled === true` 注入 controller（`host.js:225/238`）。
2. `probeEnabled()`：单飞（`probePromise`）+ 代次（`probeSeq`，旧 true 不得覆盖更新的 false）；**false 或抛错 ⇒ `syncEnabled=false` 且主动 `remembered.disable()`**（`host.js:353-371`）。
3. 触发面：`ctx.on('app-boot/config-reload', …)` **立即探测**（`:673-675`）；另 `≤1000ms` 本地 watchdog 兜底（`:374-381`，`unref`），**先 probe 再 boot**（`:680`），`dispose()` 先 `stopEnabledWatch()`（`:395`）。
4. Controller 侧 `ownerLive()` 新增 `isEnabledSync() === true` 前置判断（`remembered-session.js:264-267`），而协议每个 hop 的 `isLive` 就是 `() => ownerLive() && l.revoked !== true`（`:500`、`:852`）⇒ **逐 hop 闸门成立**。
5. `enabledGate(op)` 集中处理 false/读失败 ⇒ 仅在**当前 op** 才 `disable()`（`:278-282`），旧 op 不会关掉新 owner；`boot/restore/tick/startAuth/confirm/resume/retry` 均走该 gate。
6. `disable()` 幂等（已 disabled 且有在途/协议/定时器时才做事）、`bump()` 触发 UI 刷新、**不调用 `forget`**（密文保留，`:1182-1196`）。

**反例证据（作者实跑，fake IO）**：`test-mimo-remembered-disable.mjs` 用真实 `createAuthHost` + 真 protocol + 假 provider/加密/DNS/时钟：verified 后让 balance 401 并在 SSO 前挂 gate → 翻 `global=false`／`channel=false`（**不直接调 `disable()`**，走真实 Host 事件或 ≤1s watcher）→ 放行后断言 `SSO=0 / callback=0 / retry=0`、`state=disabled`、`balance=null`、无 persist/无 tombstone、cipher 保留、`dispose` 后 watcher timer=0；并做了「移除中间层 disable」的负对照（0/2）。R6 冻结的 99 点击套 99/0。

**判定：该阻断关闭（Pass，仅此差异）。** 说明：99 套恒 `enabled=true`，它证明的是「watcher 未扰动 boot/5min/single-owner/paused/dual-boot」，**不**用来证明关闭分支；关闭分支由上面的真实 Host 小反例覆盖。

**关闭仍待的前置**：新 `stage` 8 个 full SHA（旧 stage 已失效）+ 候选 metadata 从 `final:false/blocked` 更新为 final 后再 dry-run；届时只核 hash 版本与 §1/§5 一致性，不重开完整审。

## 7. 刷新后 stage 终验（2026-11-07 晚，本轮最后一次 hash 确认）

**8 个 staged SHA 逐项实算 = 主代理给的新清单一一致（8/8，stage 目录恰好 8 个文件，无旧残留）**

| rel | SHA-256 | 字节 | 与上轮 |
| --- | --- | --- | --- |
| index.js | `C6813698235FB72063A5C6705686A6135744654D476AE8BA0A27E8E6EFF29DBF` | 103210 | **变**（local 两 flag + freshStrict） |
| client.js | `9273636F51231E72D0A0C3CBDE851B2EEBE480E24954BD0E3A6DC1BF37D77475` | 465276 | 同 |
| plans/mimo-auth/host.js | `C0BC22C813668D5FA1DF207C5F7A66D471BBA245316CB1455B740C856B0E4FB3` | 31614 | **变**（enabled watcher） |
| plans/mimo-auth/routes.js | `222D31E6E688FF27E42427FCC80B60098FBED02CC2D2ECA398618F5D2D9279E2` | 42280 | 同 |
| plans/mimo-auth/console-protocol.js | `D1C1BCCD6E5211C42E2AABC9D83DE297798676F4880C9E85FE5C82F05F3AED88` | 66965 | 同 |
| plans/mimo-auth/windows-dpapi.js | `BC054C9552307E3EA25677B0971661C4504EB82C387D6F1BC1B6A5F281ED538F` | 13996 | 同 |
| plans/mimo-auth/remember-store.js | `2A6279D7746839FF780C64F8600CE2A08B8BC9EB7031D2DA4CA528DF6890CA8F` | 17751 | 同 |
| plans/mimo-auth/remembered-session.js | `F4B31554CEC3D65C6275D3CADD4F987E7E8EC69FC02118A8AA56E34E817347C5` | 47750 | **变**（ownerLive/enabledGate/disable） |

与「仅 index/Host/controller 3 项变化、其它 5 项 same」一致。

**staged 内容抽检**（只读文本匹配）
- staged `index.js`：`enableConsoleProtocol: true` ✓、`enableRememberedAccount: true` ✓、`isEnabled` 里用 `freshStrict()` ✓。
- staged `host.js`：保留 `dependencies.enableConsoleProtocol === true` 与 `source.enableRememberedAccount === true`
  的**源码默认 false** ✓；含 `isEnabledSync` 注入 ✓、`remembered.disable()` ✓、`app-boot/config-reload` 立即探测 ✓。
- staged `remembered-session.js`：`ownerLive` 由 `isEnabledSyncFn() !== true` 前置拦截 ✓、存在 `enabledGate` ✓。

**未改文件**：目标 `package.json` = 基线 `packageSha`、`plans/mimo.js` = 基线 `mimoSha`（实算一致）；
verify-only 9 项由 deployer 在写后复核（本报告不重复跑脚本）。

**终态**：`Pass（本地静态/合成范围）`。执行仍由主代理用已审的 `--execute` 写这 8 个文件；
本报告不构成安装批准，也不代表真实 runtime 已验证。



