# MiMo「记住登录」managed 主线（2026-11-07）

**状态：已本地磁盘安装（17 文件 closure：8 写 + 9 verify-only 未变）；Max 已通过本地静态/合成复核，唯一阻断已关闭。**
**仍未重启、未真机恢复验证。** 安装执行：`deploy-remembered.mjs --execute`（主按经审原命令执行一次），
receipt `2026-11-07T10:26:49.438Z`（=18:26:49 +08），`status=complete / deployed=true / runtimeVerified=false / realLoginPerformed=false`。

- 权威清单：[INSTALLED-MANIFEST.json](.diagnostics/mimo-remembered-install-20261107/INSTALLED-MANIFEST.json)（17 文件）
  与 [RECEIPT.json](.diagnostics/mimo-remembered-install-20261107/RECEIPT.json)；候选来源 [root-hunks.json](.diagnostics/mimo-remembered-install-20261107/root-hunks.json)。
  旧 `mimo-console-install-20261106/INSTALL-MANIFEST.json`（14 文件）只是**前阶段基线**。
- **source 与候选的差别**：工作区 `index.js` 的注册调用**没有**两个激活 flag（默认 false）；安装进去的 `index.js`
  是按候选 hunk 加上 `enableConsoleProtocol: true` + `enableRememberedAccount: true` 的版本（安装后 sha `c6813698…`），
  这是**唯一**的本地激活差异。同理 `client.js` 安装后为 `9273636f…`。
- `package.json` 版本 0.9.0 与其 sha 未改；WorkBuddy/API/credits 的既有 dirty 差异**未带入**安装；
  旧备份保留、**本次未新建 backup**（`backupCreated=false`）。
- 之前 Max 复核时点记录的「未安装」是**当时的审查事实**，保留在本文件历史里，不作为当前状态。
- **部署脚本不可重跑**：安装后的目标文件 hash 已不再匹配 baseline；本次 approval 不构成未来安装/升级许可。

## 1. 三个包的最新结果（合成环境，无真实账号/凭据/DPAPI）

| 包 | 归属 | 最新结果 |
| --- | --- | --- |
| 协议内核 + Host/route/client | 本包 | protocol **56/0**、remember-protocol **29/0**、backend e2e **17/0** |
| controller 跨 await 栅栏 | High 858f2b04 | **21** 项已修/已交 |
| 存储（DPAPI + credentials record） | High 858f2b04 | store **31/0**、DPAPI **13/0** |
| 独立点击套（真 Host → mockReact → 真 vault/protocol，fakes 仅 IO） | High c2e10aa6 | R6 **99 passed / 0 failed, exit 0**（无 assertion/fixture 改动；仅覆盖当前 UI 链） |
| Host mid-flight disable 反例（`enabled=false` 撤销在途） | High 858f2b04 | **2/0 exit0** |

历史：点击套曾经 39/54、78/21 两次失败基线，其级联根因是 client 侧 setBoot 取值、builder 丢 `authId`、缺 pair 观察、start→begin 用闭包旧快照、approval 空值、QR 走错路由、取消未进白名单、zero-generation 回传、boot 屏障单向等问题，均已逐项修正；此处只作历史，不代表当前状态。

## 2. 新入口与合同

同一条 owner-only 路由 `/api/plan-usage-mimo-auth` 上的 `remembered*` 分支（不新造路由、不新增第二个上游轮询系统）：

- `rememberedStart`：`action, bootEpoch, authConsent:true, consentVersion:1` —— **首扫无 expected/无 ID 输入**。
- `rememberedBegin` / `rememberedQr`：`+ authId, generation`；QR 为二进制 + no-store，UI 用 objectURL 并及时 revoke。
- `rememberedApprove` / `rememberedDeny`：`+ approvalId`（只透四固定字段，不含 rawURL/query）。
- `rememberedConfirm`：`+ consentVersion:1, rememberConsent:true, autoRestore:true, autoReadBalance:true, autoRefresh:true` —— **服务端复核四项全 true**。
- `rememberedCancel`：本地清，**不**写 tombstone。
- `rememberedPause` / `Resume` / `Forget` / `Retry`：`+ generation`（须等于当前快照 generation，含合法 **0**）。
- `rememberedStatus`：`action,bootEpoch`（候选恒 null）或 `action,bootEpoch,authId,generation`（**唯一**可见 `candidate` 的形态）。

候选原始 ID 只在 owner 的待确认态临时出现；`caps` / `displayStatus` / sidebar 一律 null，确认/取消/过期后立即清除。昵称仍未知，UI 显示「小米账号 ID」并由本人确认（**ID 兜底，不猜昵称、不以昵称作身份依据**）。

## 3. 持久化与节拍

- 只经 `createRememberedVault({credentials, scope})`（DPAPI CurrentUser + 宿主 credentials record 密文），scope = `profileContext.dir`（不落盘、不进 DTO）；能力不足/缺服务/缺 scope ⇒ 固定 `unsupported`，**无明文 fallback**。
- record：`{version:1, consent:{…四项}, preferences:{paused}, account: exportRememberedAccount()}`；账号侧只原四件 `passToken/userId/cUserId/deviceId`，**不含**平台短票/余额/QR/URL/grant/boot ID。
- 节拍：`intervalMs=300000`（固定 **5 min**）、`readMs=10000`、`transientLimit=3`、`pendingMs=120000`（仅首扫/待确认窗口）。**没有**旧 15 min 持有上限与 14 次自动刷新上限。

## 4. 设置页入口

`MimoAuthMount` 是设置页**唯一**入口闸门：managed ⇒ 只渲染 `MimoRememberedPanel`（旧 auth/display 面板完全不挂载，不出现 expected 表单或旧「15 min / 14 次 / 重启重登」文案）；非 managed ⇒ 保持旧两面板原语义；能力未知 ⇒ 中性占位。旧面板内部与 legacy export 未改。

## 5. 已安装内容（原候选 stage 清单）

- `root-hunks.json`（10 hunk，MiMo-only literal）：`index.js` 1 处（`registerMimoAuth` 的 `isEnabled` 回调 + **本地候选激活** `enableConsoleProtocol:true`、`enableRememberedAccount:true`）＋ `client.js` 9 处（动作/状态白名单含 cancel、请求门禁、body `authId`、consent 转发、快照 picker（approval 四字段）、managed 面板 + 唯一闸门、凭据区 seam、移除旧 display 面板 push、Panel seam）。
- 两个激活 flag **只存在于候选 hunk**；工作区 `index.js` 与 `createAuthHost` 的默认 gate 仍为 `false`（Host 侧按 source 正确透传，不是文本摆设）。
- 附 `sourceHashes`（将被 stage 的 8 个文件的 sha256）与 `stageIntent`。

## 6. 本人实测顺序（重启后按这个来，不必跑矩阵）

1. **手动完整重启 DSH**（必要时再硬刷新一次），确认设置里出现的是**新的记住登录面板**：**没有**预填 ID / expected 输入框，也没有旧「15 min / 14 次」文案。
2. 点「创建二维码并登录」→ 手机扫码 → 界面显示**「小米账号 ID：<候选>」**（昵称未知，用 ID 兜底）→ 勾选四项授权 → 点「确认此账号并记住登录（允许启动后自动查询与刷新）」。
3. 首次应显示正常钱包余额；关掉设置面板、等待约 **5 min**，看余额与「更新于」是否刷新（关面板不影响后台节拍）。
4. **不点忘记，直接完整重启 DSH** → 应**无需扫码**自动恢复并读到余额。**这是本版最关键的一步**，与第 2 步一起构成最小验收。
5. 可选：暂停刷新 → 重启 → 应显示「已暂停」且不产生账号请求；恢复刷新应先核对绑定 ID 再读数；退出并忘记 → 重启后应无任何自动查询。
6. 安全能力不足时（DPAPI/凭据服务不可用、记录损坏、绑定不符）界面只显示**固定错误码**；此时**不要**向任何人提供 Cookie、二维码截图、账号 ID 或票据。

## 7. 仍未验证（不得当成已可用）

1. **已写入磁盘但未激活**：17 文件 closure 已安装到本地 profile（见顶部 receipt），但**尚未重启 DSH**，运行时是否已加载新代码未验证；也未发布。
2. `resolveVault` 的**真实 factory 支路**（懒 `import('./remember-store.js')` + 真实 `ctx.get('credentials')/profileContext`）在本机未执行——离线套一律注入 vault；真实 DPAPI 与真实凭据记录写未测。
3. 真实 MiMo/小米接口、真实账号扫码与恢复未验证；真实运行期的 profile 挂载待用户下次验收。
4. 单次操作 **10 s** 预算与 120 s 首扫窗口的实际时长未在真实链路上计时。
5. 昵称字段仍未知（公开资料无 schema），首版 ID 兜底。
6. **「退出并忘记」只清本机**：它删除本地密文并停止本机自动查询，**不代表**撤销该小米账号在其它设备/浏览器上的会话。
7. **DPAPI 的作用域**：密文绑定当前 Windows 用户，能防跨用户读取，但**不防同一 Windows 用户下的其它进程**读取/滥用。
8. **Android 不受支持**：没有 DPAPI 等价能力，该记住登录在 Android 上按「能力不足」固定码拒绝，不做明文兜底。
9. 真实 `scope` / 宿主 credentials 服务 / DPAPI 生产分支与真实账号恢复**均未验证**，本文件不声称已在真实链路成功。
