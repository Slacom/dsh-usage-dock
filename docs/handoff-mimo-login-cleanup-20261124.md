# MiMo 扫码登录清理 — 关机交接（2026-11-24）

> 用户要求：将当前测试版中残留的 MiMo 扫码登录 / 记住登录 / 控制台 Cookie 相关内容彻底删除，
> 只保留 MiMo API Key 余额。用户准备关机，本文件用于下次直接续接。

## 0. 先看这两条（避免误判）

1. **已部署清理版 `0.12.0-dev.20261124.9` 到 desktop profile。**
   `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock` 现有 33 个文件，
   `plans/mimo-auth`、`plans/mimo-legacy-store.js`、`plans/workbuddy.js` 均已不存在；
   但 **DSH 尚未重启**，运行中的旧进程仍加载旧代码。重启 + 硬刷新后才生效。
2. **工作区已清理并已构建 `.9` 手机包，但尚未提交。**
   工作区 `package.json` 版本已是 `0.12.0-dev.20261124.9`，有未提交改动。

## 1. 已完成

### 1.1 合并手机版基线
将手机包 `.8` 的 4 个改动文件合并进工作区：
- `index.js`
- `plans/dsh-go-native.js`
- `README.md`
- `package.json`

备份：`.diagnostics/mimo-auth-clean-20261124/before-merge/`

### 1.2 删除 MiMo 登录模块
- 删除 `plans/mimo-auth/**`（15 个文件）
- 删除 `plans/mimo-legacy-store.js`

### 1.3 Host 清理
- `index.js`：删除 `mimo-legacy-store` import、`mimoRememberLogin` 配置、legacy 记录恢复/清除、
  `mimoDisplay*` 显示覆盖、`mimoAuth` 路由字段、MiMo Cookie 身份指纹；MiMo 取数改回普通 `plan.fetch`。
- `plans/mimo.js`：只剩 `mimoEnabled` / `mimoApiKey` / `mimoWarnThreshold`；
  无 Key 固定 `no-key`，不再有 Cookie/扫码/登录态文案。
- `plans/usage-tool.js`：删除 `mimoDisplayWire` / `mimoWireWithDisplay`。
- `plans/dsh-go-native.js`：删除 `MIMO_PANEL_ID`、`mimoRememberLogin`、MiMo 登录面板/动作；
  原生只剩 quota / settings 两个面板。

验证：`node --check` 四个文件均 0；`grep` 在 Host 四文件对这组关键词为 0；
`plans/index.js` 导入为 4 渠道 `opencode-go,deepseek,codex,mimo`。

### 1.4 客户端清理
`client.js` 从 10802 行降到约 7193 行（+29 / −3638）：
- 删除全部 MiMo auth / remembered / QR / console / display 组件、常量、请求与 `data-mimo-*`。
- 删除 `mimoCookie` 字段和 `mimoDisplayOverlay` 覆盖。
- 保留 MiMo API Key 卡片、余额/阈值、四内置渠道、自定义余额。

验证：`node --check client.js` 0；相关 grep 0；mock 冒烟 7/7。
备份：`.diagnostics/client.js.before-mimo-purge.bak`

### 1.5 测试与文档（大部分完成）
- 删除 36 个 MiMo 专用测试，仅保留 `tools/test-mimo-api-key.mjs`（17 项）。
- 修改 7 个测试：`test-quota-round2/3/4/5`、`test-degrade-refresh`、`test-dsh-go-native`。
- 已通过（测试代理实跑）：`mimo-api-key` 17、`dsh-go-native` 53、`dsh-go-strip` 16、
  `degrade-refresh` 41、`settings` 17、`settings-layout` 30、`android-compat` 14、
  `usage-tool` 103、`usage-tool-register` 70、`usage-tool-host` 41、`usage-integration` 31、
  `config-unwrap` 22、`quota-policy-settings` 93、`quota-round2/3/4/5` 25/24/30/15、
  `host-custom` 31、`review-fixes` 40、`capsule-pending` 23、`footer-row` 12、`line-endings` 68。
- README / AGENTS / MEMORY / backlog / release-notes / dsh-go-native-panel 已更新为
  “MiMo 只有 API Key，扫码/记住登录/Cookie 已删除”。
- 未完成：3 个测试文件仍有旧引用/无法运行，见下。

## 2. 未完成 / 下次继续

### 2.1 测试旧引用（当前仍有 10 个文件命中，共 25 处）
先跑：
```powershell
cd 'E:\WorkSpace\DSH\DSH Usage Dock'
Select-String -Path tools/*.mjs -Pattern 'mimoCookie|mimoRememberLogin|mimoAuth|mimoDisplay|mimoRemembered|mimo-legacy|data-mimo-auth|mimo-login' -CaseSensitive:$false
```
命中文件：
- `tools/test-usage-recheck-f1f2.mjs`（9）
- `tools/test-dsh-go-boundaries.mjs`（5）
- `tools/test-config-unwrap.mjs`（2）
- `tools/test-settings-layout-20261024.mjs`（2）
- `tools/verify-f-mutations.mjs`（2）
- `tools/mock-react.mjs`（1，通常是注释/辅助）
- `tools/test-degrade-refresh.mjs`（1）
- `tools/test-dsh-go-native.mjs`（1）
- `tools/test-mimo-api-key.mjs`（1）
- `tools/test-review-fixes.mjs`（1）

原则：MiMo 只保留 API Key；删除扫码/显示/remembered 断言，不要改产品代码。

### 2.2 关键验证
```powershell
node --check index.js
node --check client.js
node --check plans/mimo.js
node --check plans/dsh-go-native.js
node tools/test-mimo-api-key.mjs
node tools/test-dsh-go-native.mjs
node tools/test-dsh-go-boundaries.mjs
node tools/test-degrade-refresh.mjs
node tools/test-settings.mjs
node tools/test-usage-tool.mjs
node tools/test-config-unwrap.mjs
node tools/test-codex-account.mjs / -host / -ui
node tools/test-line-endings.mjs
```

### 2.3 部署（已完成 2026-11-25）
- 版本：`0.12.0-dev.20261124.9`；安装副本 33 文件、0 mismatch、0 闭包差；
- 旧安装 49 文件；删除 16 个旧 MiMo 文件（`plans/mimo-auth/**`、`mimo-legacy-store.js`）；
- 安装副本 `plans/mimo-auth` / `mimo-legacy-store.js` / `workbuddy.js` 均不存在；
- **还需重启 DSH + Ctrl+Shift+R 才生效**。
- 回执：`.diagnostics\install-mimo-clean-20261125\RECEIPT.json`
- 回滚：`.diagnostics\install-mimo-clean-20261125\rollback.ps1`（默认 dry-run，`-Execute` 恢复旧 `.8`）
- 旧安装备份：`.diagnostics\install-mimo-clean-20261125\before\dsh-usage-dock`

### 2.4 手机包（已完成 2026-11-25）
- `.diagnostics\package-0.12.0-test-20261125\dist\dsh-usage-dock-0.12.0-dev.20261124.9.tgz`
  - 374,248 bytes；SHA256 `7566a8b375ace06dbeabd6da804d63384b21f6606f9a812fe60b7f6e4163aee0`
- `.diagnostics\package-0.12.0-test-20261125\dist\dsh-usage-dock-0.12.0-dev.20261124.9-mobile.zip`
  - 786,166 bytes；SHA256 `2c21045eb9a6be2d5f5882e8e8e5c0c6458610a79c9a2f4646dd890c9e0ff3bf`
- 包内 33 个成员；`tools/`、`.diagnostics/`、`plans/mimo-auth`、`mimo-legacy-store.js` 均已排除；
  含 `INSTALL.txt`、`SHA256SUMS.txt`；导入实测 4 渠道。

## 3. 备份/回滚

| 内容 | 路径 |
| --- | --- |
| 手机 .8 原始 zip | `D:\MiShare\dsh-usage-dock-0.12.0-dev.20261124.8-mobile.zip` |
| 解包手机包 | `.diagnostics\phone-package-20261124.8\` |
| 合并前 4 文件 | `.diagnostics\mimo-auth-clean-20261124\before-merge\` |
| client 清理前 | `.diagnostics\client.js.before-mimo-purge.bak` |
| 当前安装副本（旧 .8） | `.diagnostics\install-phone-20261124.8\before\dsh-usage-dock\` |
| 安装回滚 | `.diagnostics\install-phone-20261124.8\rollback.ps1`（默认 dry-run，`-Execute`） |

## 4. 子代理状态

- `mimo-host-purge`、`mimo-client-purge`：已完成。
- `mimo-tests-purge`、`mimo-docs-purge`：已发送“立即停止/交接”消息；下次恢复前先检查
  `list_agents` 与 `git status`，确认没有代理仍在写文件。
- 手机包 .8 的 Codex 原生账户选择功能已合入工作区，未在清理中删除。

## 5. 关键结论

- MiMo **只保留 API Key**，没有 Cookie/二维码/记住登录/`mimo-login` 面板。
- 关键 13 套件 785 项 + `test-review-fixes` 40 项全绿；Max 复核 **PASS**（无阻断）。
- 工作区、desktop 安装副本、`.9` 手机包均为清理版；安装副本已无旧 MiMo 模块。
- **唯一未完成：重启 DSH + 硬刷新后的运行时验收**；未提交、未发布、未真机验收。
