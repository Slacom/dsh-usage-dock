# 事件记录：web boot 单条目未激活 → 应用打不开 → 恢复按钮清空 profile 用户层（2026-10-28）

## 一句话

在 desktop profile 的 `cordis.patch.yml` 里用 **file:// 路径**插入了一条带网页半（`client.js`）的本地插件条目后，
下次启动时该条目停在 `loading`，DSH 的 web boot 因「有 1 个条目未激活」直接 fatal、窗口打不开；
随后使用恢复对话框的「**禁用第三方插件、备份 profile patch 并重启**」，该动作把**整个用户 patch 层**移走并按内置默认重建，
于是界面上的全部第三方插件与模型供应商配置一起消失（文件本身仍可从 `.bak-<epoch>` 找回）。

## 事实时间线

| 时间（+08:00） | 事件 | 证据 |
| --- | --- | --- |
| 10-28 15:29:46 | 挂载工具向 `profiles/desktop/cordis.patch.yml` 追加 162 B `insert`（id `mimo-login-poc`，name 为 `file:///E:/…/staged/dsh-mimo-login-poc/index.js`），7417 → 7579 B；原始字节备份到 `.mimo-poc-backup-20261027/before.bin` | `meta.json`：`beforeSize 7417` / `beforeSha256 6b9065…` / `afterSize 7579` / `afterSha256 c7a95f…` |
| 17:31:56、17:32:09 | 两次启动失败 | `crash-…-web-boot.log`：`Error: web boot: 1 entry did not activate` + `dsh-mimo-login-poc: loading` |
| 17:33:34 | 执行恢复动作：`renameSync(cordis.patch.yml → cordis.patch.yml.bak-1793180014344)`，并重写 `package.json#dsh.profile.bundles` | 备份名内嵌 `Date.now()=1793180014344`（=17:33:34）；文件 mtime 仍是 15:29:46，符合 rename 保留 mtime |
| 17:33:34–35 | 应用重启；profile 内出现 661 B、只含 `ui-settings-account`/`ui-chat`/`ui-settings` 三项内置默认值的 patch | 661 B 文件 + `package.json`（`pnpm-lock.yaml` 的 importers 与之完全一致，依赖未丢） |
| 17:39 | 按 `before.bin` 整字节还原 patch（7417 B，sha256 `6b9065…`），PyYAML 解析 12 条、0 条 insert | 见下节 |

## 根因

**已证实：**

1. DSH web boot 的审计是「任一非 `active` 条目即 fatal」：
   `throw new Error(\`web boot: ${n} entry/entries did not activate\n…\`)`（`app.asar` → `lib/main.js`）。
   对照：Host 侧另有 `auditStartupEntries()`，区分 required / 可选条目；**web boot 这条路径没有可选降级**。
2. 报出的 `loading` 是 Cordis 的状态名，含义是「插件回调仍在执行、尚未返回」
   （`PENDING` 才是「等 service」）。也就是说：不是 import 失败，也不是缺服务，而是**永远等不到结束**。
3. 该 POC 的宿主半（`index.js`）在 Node 里能正常 import（`apply`/`inject` 齐全，`apply` 是同步函数），
   所以「回调一直不返回」不在宿主半的同步路径上。

**待定（未证实的唯一环节）：**

4. 卡住的更可能是它的网页半：`client.js` 通过 `window.__ModuleLoader__.load({id:'dsh-mimo-login-poc', …})` 自注册，
   而 file:// 直挂的包并不在 profile 的 `node_modules` 里，客户端 bundle 没有投递路径；
   注册若永远不发生，条目就会一直 `loading`。**没有做重启级对照实验，故记为待定。**

**已排除：** 语法错误、缺依赖、`webServer` 服务名不存在（服务名确为 `webServer`，由 `class WebServer extends Service` 提供）。

## 恢复按钮到底做了什么（与文案不符）

- 文案：`disableThirdPartyPlugins: "禁用第三方插件、备份 profile patch 并重启"`
- 实现：`disableAllPlugins() { return this.withLock(() => sanitizeProfile("dsh", this.paths.profile, WEB_PROFILE.bundles)) }`
- `sanitizeProfile()`：`renameSync(patchPath, backupPath)` → 按新的 bundle 列表重写 `package.json`；
  文档写明「Installed packages and other manifest fields are preserved; **patches are never parsed**」。
- 日志：`Desktop profile recovery completed: { profilePatchBackup, homePatch: "unchanged" }`
- `WEB_PROFILE.bundles` 恰好等于 desktop 原有的 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`，
  所以依赖面没有变化——**丢的只有 `cordis.patch.yml` 这一层，而它承载了全部用户配置**
  （第三方插件条目、模型供应商、默认模型、UI 设置、额度策略、MiMo Cookie、WorkBuddy 账号）。

结论：文案说的是「禁用第三方插件」，实际做的是「移走整层用户配置」；对用户而言等价于「全部重置」，
且备份文件名不可读（`.bak-1793180014344`），没有任何提示告诉用户备份在哪、怎么恢复。

## 本次恢复步骤（可复用）

```powershell
$p = "C:\Users\Slacom\.dsh\profiles\desktop"
# 1) 校验备份（应该等于事件前的 sha256）
(Get-FileHash "$p\.mimo-poc-backup-20261027\before.bin" -Algorithm SHA256).Hash
# 2) 保留当前（默认）patch 作为对照
Copy-Item "$p\cordis.patch.yml" "$p\cordis.patch.yml.bak-default-$(Get-Date -Format yyyyMMddTHHmm)"
# 3) 整字节还原（不要用编辑器另存，避免 BOM/换行变化）
Copy-Item "$p\.mimo-poc-backup-20261027\before.bin" "$p\cordis.patch.yml" -Force
# 4) 校验：应为 7417 B / sha256 6b906521dba07f3e468678b4c1157ef7bfcdd211f9860e6f10f3368e5c60a8ea
```

还原后 `cordis.patch.yml`：7417 B、12 条、无 `insert`；`package.json`、`pnpm-lock.yaml`、
`.credentials.yaml`、`.openai-codex-auth.json` 均未被动过。**必须完全退出应用再启动**（Host 半与 patch 只在启动时读一次）。

## 下次操作规范（防止复发）

1. **带 `dsh.client` 的插件一律按包安装**，patch 里写 `name: <包名>`；不要用 `file://` 直挂。
2. 一次只改一个条目；改完**先备份 patch 到 profile 之外**，再重启验证。
3. 启动失败时**不要**按「禁用第三方插件…」那颗按钮，直接按上节步骤还原 patch 再启动。
4. 需要保留「上次可用」的复本：`cordis.patch.yml` 中的 `mimoCookie` 等是 secret，**不要入库或贴到聊天**。
5. 桌面 profile 不能被 CLI 校验：`dsh --profile desktop --dump-config` 会返回
   `profile "desktop" is managed exclusively by the Electron application`。要预检只能另建 profile 或靠备份回滚。

## 给上游的两份 issue 草稿

### 1) 单条目未激活即整体 fatal，且没有「仅禁用失败条目」

标题：`web boot: 1 entry did not activate` 使整个应用无法启动，恢复选项只有「整层禁用」

环境：@deepseek-ai/dsh-desktop 0.2.1-rc.3 / Electron 44.7.0 / win32 x64 / Node 24.21.0 / zh-CN

复现：在 `profiles/desktop/cordis.patch.yml` 末尾插入
`- insert: [{ id: mimo-login-poc, name: "file:///…/index.js" }]`（该包带 `dsh.client` 网页半），重启桌面端。

实际：窗口不打开，弹「DeepSeek Harness 无法使用」；日志
`Error: web boot: 1 entry did not activate` + `dsh-mimo-login-poc: loading`。
`loading` 对应 Cordis「插件回调仍在执行」，即永远等不到结束。

期望：非 required 条目失败时降级为警告并继续启动（Host 侧 `auditStartupEntries()` 已有 required/optional 两级，
web boot 的审计没有）；或至少提供「仅禁用这些条目」——patch 本身支持按 id 写 `disabled`。

附：`loading` 只给出状态名，没有给出「在等什么」（等 service / 等客户端 bundle / 等 apply），
排障只能靠读源码猜；建议把等待点写进该行。

### 2) 「禁用第三方插件」实际重置整层用户配置

标题：恢复按钮「禁用第三方插件、备份 profile patch 并重启」会移走整个用户 patch 层，丢失模型供应商与内置设置

复现：任意一次启动失败 → 点第三颗按钮。

实际：`disableAllPlugins()` → `sanitizeProfile()` 把 `cordis.patch.yml` 改名移走、重写 `dsh.profile.bundles`，
重启后应用按内置默认重建一份 661 B 的 patch。结果：第三方插件条目、`llm-pi-ai`/`llm-openai-codex` 供应商、
`agent-default-model`、UI 设置、额度策略全部消失（本次事件实测；备份在 `.bak-1793180014344`，无任何提示）。

期望：
- 只对失败条目写 `disabled: true`，其余条目原样保留；或
- 执行前二次确认「会丢失以下 N 项配置」，并把备份路径显示在对话框与日志里；备份文件名用可读时间戳。

## MiMo 试验的下一步

1. 打好的候选包已存在：`.diagnostics/mimo-settings-20261027/build/dsh-mimo-login-poc-0.0.0-poc.20261026.tgz`
   （sha256 `c70bc81c…`，11 个成员）。先把它**按包安装**进 profile（应用内插件管理器，或写进
   `package.json` 后 `pnpm install`），patch 里用 `name: dsh-mimo-login-poc`。
2. 若应用内插件管理器不支持本地 tgz：把该包登记到已有 `plugin-market` 索引
   （patch 里的 `https://raw.githubusercontent.com/Slacom/Slacom-dsh-plugin-market/main/site/index.json`），从 UI 安装。
3. 安装前备份 patch；只加这一个条目；重启验证入口「设置 → 内置插件 → MiMo 登录试验」；
   失败按上节还原，**不要**按第三颗按钮。
4. 通过后再验收 Start/Begin、二维码、余额核对；未通过不进入 0.9.1 正式发布。
