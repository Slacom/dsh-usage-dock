# MiMo 本机显示会话 · 本地试装记录（2026-11-06）

> **仅本地磁盘试装。未重启、运行态未验证；真实链仍残留 `null` DI（fail-closed）。**
> 盘上已装 ≠ 运行时活跃；QR 代码已落盘 **不等于** 运行期二维码/扫码成功。

## 1. 安装事实（由 `INSTALL-MANIFEST.json` 读出的精确值）

| 项 | 值 |
|---|---|
| 安装时间戳 | `20261106-103258` |
| 状态 | `status=complete`、`deployed=true` |
| 目标根 | `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock`（**formal 0.9.0 基线**） |
| 写入规模 | **11 个文件** = **2 覆盖**（`index.js`、`client.js`）+ **9 新增**（`plans\mimo-auth\` 全目录，含 `vendor\`） |
| 备份目录（**唯一可用回档**） | `E:\WorkSpace\DSH\DSH Usage Dock\.diagnostics\mimo-session-display-install-20261106\20261106-101818-formal-0.9.0-pre-mimo-sessionDisplay\backup\20261106-103258-files` |
| 备份内容 | 仅被覆盖的 **2 个旧文件**（`index.js`、`client.js`），写入前逐个核对 `oldSha` 并以写前副本做备份 |
| 写后校验 | 11 个目标文件写后 SHA 与 manifest `newSha` **全部匹配** |
| 版本/元数据 | 插件 `package.json` **保持 0.9.0**，仅做文件叠加，不改 metadata、不改根 package、不改 `cordis.patch.yml` |

> ⚠️ 早前那两个空目录（`20261106-100938-pre-sessionDisplay`、`20261106-101818-formal-0.9.0-pre-mimo-sessionDisplay\backup\` 本身）**不是备份**，不构成回档；**可用回档只有**上面 `20261106-103258-files`。

## 2. 包内容与排除项

- **新增 9 个**（照源逐字）：`plans\mimo-auth\{host,routes,session,session-display,failure,dynamic-policy,secure-transport}.js` + `plans\mimo-auth\vendor\{cookie-jar,memory-flow}.js`。
- **覆盖 `index.js`**：正式基线上**两处纯插入**（`import { registerMimoAuth } …`；`apply()` 内 `let mimoAuthStatus …` + `registerMimoAuth(ctx, …)`）；索引 diff 恰 **2 hunk**；不改 `/api/plan-usage` 响应形状。
- **覆盖 `client.js`**：正式基线上**仅 10 个 MiMo hunk**（H3/4/5/6/8/9/10/11/13/15），stage 相对正式 **恰 10 hunk**，三个 WorkBuddy 哨兵（`workbuddyAccountLabel` / `selectedAccountsFingerprint` / `不再拉取账号列表`）**均不存在**。
- **明确排除 5 个 WorkBuddy/账号端点 hunk**（H1/H2/H7/H12/H14）：源仓库里这些改动**仍留在工作区**，**未**随安装进入目标，也**未**修改源。
- **未覆盖**：`plans\mimo.js`（复用其 `parseMimoBalance`）、`plans\util.js`、其他渠道、所有配置文件。

## 3. 生成与安装的可复现入口（实际实现，非旧方案）

- `prepare-stage.ps1`：只写工作区 `stage\`。**index 用文本级插入并保留基线行尾**（结果 LF、无 BOM，`node --check` 通过）；**client 直接调用 `stage-merge.mjs`**（逐 hunk 校验 old 侧逐行一致后重建），**不再使用 `git apply`**；生成 `client-formal.diff` / `client-mimo-only.patch` / `stage-vs-formal.diff` / `index-vs-formal.diff` / `STAGE-MANIFEST.json`，并断言 15→10 hunk、index 2 hunk、无 WB 哨兵。
- `install-formal-trial.ps1`：以 **`STAGE-MANIFEST.json` 钉住**每个 `newSha`/`targetOldSha`（不接受运行时任意 stage 文件）；精确 11 rel、固定 root、`FullPath` 与 reparse 检查；备份子目录唯一；**先落 journal `status='backup-verified'`**，随后逐文件写入并更新 `written` 与 `status='partial'`，全部成功才 `status='complete'`/`deployed=true`；异常保留 partial 并抛出，**不自动回滚**。
- `rollback-formal-trial.ps1`：接受 `backup-verified` / `partial` / `complete`；固定 11 路径 + `f.target == FullPath(root+rel)` + `backupPath == backupDir+rel` + `backupDir` 必须在 `TrialDir\backup` 下；全量预检通过才动；old 存在→仅当当前 hash==newSha 才恢复并校验 oldSha（已是 oldSha 则幂等跳过）；old 新增→仅当当前 hash==newSha 才删**单文件**；不递归删目录、不碰配置、不重启。

## 4. 回档命令（唯一正确形式）

```powershell
$R='E:\WorkSpace\DSH\DSH Usage Dock\.diagnostics\mimo-session-display-install-20261106\20261106-101818-formal-0.9.0-pre-mimo-sessionDisplay'
pwsh -NoProfile -File "$R\rollback-formal-trial.ps1"            # 预检（不写）
pwsh -NoProfile -File "$R\rollback-formal-trial.ps1" -Execute   # 回档（恢复 2 个旧文件、删除 9 个新增）
# 回档后由用户手动重启 DSH 再确认
```

## 5. 未完成 / 未验证（不得含糊）

1. **未重启**：Host 半不热重载 ⇒ 当前磁盘已装**不等于**运行态生效。
2. **真实链仍 disabled**：生产 DI 恒 `null`（`displayProducer`/`displayIdentityVerifier`/`displayBalanceAdapter`）。
   该状态下 `displayStatus` 仍返回**可信 absent（HTTP 200）**、`displayStop` **幂等 200**；
   **只有** `displayStart` / `displayRead` / `displayConfirm` / `displayGrant` 返回
   `503 E_MIMO_AUTH_DISPLAY_DISABLED`。**真实余额/身份/协议仍未证**。
3. **QR 代码装入 ≠ 运行期二维码可用**：本包没有做任何真实扫码/登录；Beta2 的"二维码可见"是历史观察，**不能**据此声称本次安装后 QR 可用。
4. **未做**：GUI/QR/扫码/联网/真实账号/真机验证/构建包/改版本/发布；旧 26/21/56 矩阵未跑。
5. **装后核对：已 Pass**。Max 已完成安装差异 + rollback（不 `-Execute`）预检并 **Pass**
   （stage==target 11/11、old backup 2/2、rollback 预检 exit 0 = 2 restore + 9 delete、闭包解析完整），
   见 [INSTALL-REVIEW.md](.diagnostics/mimo-session-display-install-20261106/20261106-101818-formal-0.9.0-pre-mimo-sessionDisplay/INSTALL-REVIEW.md)。
   **该 Pass 仅限「磁盘已装」**，**不代表真实运行**：未重启、DI 仍 `null`、真实链未验证。
