# dsh-usage-dock — 项目对接文档

> 面向接手本项目的 AI agent / 开发者。**动手前先读完本文**，尤其是第 5 节的 API 契约，
> 那里记录的都是踩过的坑，重复踩会浪费大量时间。

---

## 1. 项目是什么

DeepSeek Harness（DSH）的**侧栏用量/余额插件**：在 Web/桌面端左侧状态栏底部显示各家 AI 套餐的
用量与余额，点击可展开详情面板。fork 自 `chendefine/dsh-plugins-plan-usage`，改名 `dsh-usage-dock`
以避免与上游混淆，并做了一系列定制（见第 6 节）。

**当前版本**：0.6.3　|　**已发布**：GitHub + npm　|　**已安装**：desktop profile

## 2. 关键路径

| 用途 | 路径 |
| --- | --- |
| **本项目（开发仓库）** | `E:\WorkSpace\DSH\DSH Usage Dock` |
| 已安装的插件副本 | `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock` |
| DSH 桌面端本体 | `D:\DeepSeek Harness\resources\app.asar\dsh` |
| DSH CLI（桌面端自带） | `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 插件配置（DSH 托管） | `C:\Users\Slacom\.dsh\profiles\desktop\cordis.patch.yml` → `plan-usage` 条目 |
| GitHub | https://github.com/Slacom/dsh-usage-dock |
| npm | https://www.npmjs.com/package/dsh-usage-dock |

> ⚠️ `app.asar` 是 **121MB 的归档文件**，Node/PowerShell 等独立进程**无法**直接读里面的路径；
> 只有 DSH 运行时会注入 asar 支持。用 `dsh.cmd` 调 CLI，不要试图 `node <asar内路径>`。

> 📁 **本项目位于 DSH 工作区之外（E 盘）**。DSH 沙箱首次访问该目录时会自动做一次 ACL 诊断，
> 并为当前用户补上完全控制权限（这是必要的，否则读写会失败），同时在 `E:\WorkSpace\DSH\` 下
> 留下 `acl-recovery-<slug>/` 目录（含原始权限备份与回滚脚本）。诊断结论若为 `rollback: not-needed`，
> 该目录即可删除——**不要**按回滚脚本恢复原权限，那会让沙箱重新无法访问。

## 3. 架构

```
index.js          Host 半：导出 Config schema、注册 /api/plan-usage 路由、编排各渠道取数
client.js         Browser 半：侧栏胶囊 + 「内置插件」里的设置页（单文件，零构建）
plans/index.js    渠道注册表（新增渠道只需在此登记）
plans/<渠道>.js   每渠道一个模块，统一接口 { id, name, fields, schema, source, fetch }
plans/util.js     共用工具：curlJson（原生 fetch / Python / curl 三后端自适应）、窗口归一化、凭据解析
plans/http-fetch.py  兜底取数脚本（Windows 沙箱内 curl 的 TLS 不可用时的 Python/OpenSSL 方案）
cordis.patch.yml  插件向 profile 贡献的配置层（insert 一个 plan-usage 条目）
tools/test-fetch-backends.mjs  取数后端 + DeepSeek 渠道回归测试（见第 4 节）
tools/test-collapsed-pill.mjs  浏览器半回归测试：缩略（rail）状态不可交互（见第 4 节）
```

**已接入渠道**：OpenCode Go、GLM Z.AI、GLM 智谱、Kimi Code、DeepSeek（账号余额优先/API Key 回退）、OpenAI Codex。

## 4. 开发流程

```powershell
# 1) 在本仓库改代码（不要改 profile 里的副本！）
# 2) 部署到 desktop profile
Copy-Item "<本仓库>\index.js","<本仓库>\client.js" "C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock\" -Force
Copy-Item "<本仓库>\plans\*" "C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock\plans\" -Force
# 3) 重启 DSH 桌面端（client bundle 在插件激活时缓存，改文件不会热生效）
# 4) 浏览器硬刷新 Ctrl+Shift+R
```

**本地自测**（无需重启，能在部署前抓出大部分错误）：

```powershell
# Host 端：语法 + 注册表 + 取数
node --check index.js; node --check client.js
node --input-type=module -e "const m=await import('./plans/index.js'); console.log(m.PLANS.map(p=>p.id))"

# 取数后端 + DeepSeek 渠道回归测试（8 项，含「平板场景」复现；T4/T5 需出网）
node tools/test-fetch-backends.mjs

# 浏览器半回归测试：缩略（rail）状态下胶囊必须不可交互（4 项，离线，无需 React 依赖）
node tools/test-collapsed-pill.mjs

# 客户端（设置页）：同上思路，mock window.__ModuleLoader__ + React + ctx.slots/configForms
# 历史上抓到过两次真实错误（设置页白屏、this 丢失）
```

> 回归测试需要 `@deepseek-ai/schemastery`（渠道模块的 import）。仓库里没有它的副本时，
> 测试会把这部分记为 SKIP；要跑全量，从已安装的 profile 复制三个包到仓库 `node_modules/`
> （该目录已被 .gitignore 排除）：
>
> ```powershell
> $src='C:\Users\Slacom\.dsh\profiles\desktop\node_modules'
> New-Item -ItemType Directory -Force "$PWD\node_modules\@deepseek-ai","$PWD\node_modules\@standard-schema" | Out-Null
> Copy-Item "$src\@deepseek-ai\schemastery","$src\@deepseek-ai\cosmokit" "$PWD\node_modules\@deepseek-ai\" -Recurse -Force
> Copy-Item "$src\@standard-schema\spec" "$PWD\node_modules\@standard-schema\" -Recurse -Force
> ```
>
> 注意：**不要**用 junction/symlink 指向 profile——DSH 沙箱禁止创建重解析点（拒绝访问）。

## 5. DSH 0.2.0 API 契约（★ 踩坑记录，务必先读）

DSH 0.2.0 相对 0.1.x 有**破坏性变更**，以下每一条都是实际踩过的：

| # | 坑 | 正确做法 |
| --- | --- | --- |
| 1 | `ctx.settings.register(ns, Schema)` **已被移除**（调用即启动失败） | 改为 `export const Config = z.object({...})`，DSH 据此托管配置 |
| 2 | DSH 的设置表单**只展示 `.volatile()` 字段**，没加就没有设置页 | 每个要展示的字段都加 `.volatile()`（本项目在 `planSchemaFields()` 里统一加） |
| 3 | 设置页 tab **不是自动生成**的，要自己注册 | 注册 `settings.plugins.tab` 席位并提供页面组件；参考 `dsh-codex-connect` |
| 4 | `ConfigFormController` 的 `getSnapshot/subscribe/set` **依赖 this**，直接传方法引用会丢 this → 页面白屏 | 包一层再传给 React（见 `useConfigSnapshot`） |
| 5 | 插件配置**运行时不热重载 Host 半**（官方提示「下次启动生效」） | 客户端订阅 `configForms` 做实时过滤，保存即生效 |
| 6 | 账号余额 Remote 返回的是**投影结构**，不是 Platform 原始响应 | `getBalance(client)` 返回 `null \| {status:"ready", value:[钱包], bonusWallets:[钱包]} \| {status:"failed"}` |
| 7 | 侧栏底部席位 | 用官方公共席位 `sidebar.footer.action`（list），**无需改 DSH 核心包** |
| 8 | 设置页读取的是 `entry.fiber.runtime.Config` | 插件必须导出 `Config`，且 loader 已激活该条目 |
| 9 | Windows 沙箱内 curl 无法完成 TLS 握手（`SEC_E_NO_CREDENTIALS`） | 用随附的 Python 脚本取数；`util.js` 已做 Python⇄curl 自适应 |
| 10 | **移动端（Android APK）没有任何取数命令**：设备上没有 python，curl 也不可用，于是「shell + 外部命令」这条路全断，DeepSeek 用 API Key 只能显示「upstream request failed」（0.6.1 的真实故障） | **在 Host 进程内用原生 fetch**（`util.js` 的 fetch 后端，0.6.2 起首选）；移动端宿主本身能出网（模型请求、codex-connect 都在同一个进程里跑 fetch），所以这条路一定通；Python/curl 退化为兜底 |
| 11 | 裸的 `fetch` 报错只有一句 `fetch failed`，看不出 DNS/TLS/代理原因 | 读 `err.cause` 的 `code`/`message` 一并带上（见 `fetchBackend`）；失败信息里同时点名失败后端与退出码 |
| 12 | **侧栏缩略（rail）后 slot 仍照常渲染**：`sidebar.footer.action` 的 `wide` 由 sidebar 经 ownerProps 注入（`renderSlot(name, { wide })`，其值为 `!collapsed \|\| !settled`）；rail 宽度只有约 **56px** | 缩略状态不要挂 `onClick`、也不要渲染 `position:absolute; width:100%` 的面板——它会被压成一条竖排乱码（0.6.3 的真实故障，移动端 Web UI 才看得出来，桌面端侧栏够宽所以不显现）。详情面板只在展开态渲染（`open && wide`），否则「先展开点击、再折叠」时 effect 生效前会闪一帧 |

**账号余额调用方式**（Host 端）：

```js
const account = ctx.get("deepseekAccount")   // 服务名；仅在 Desktop 组合里存在
const summary = await account.getBalance({ version, locale, timezoneOffsetSeconds })
// summary.status === "ready" → summary.value / summary.bonusWallets
```

## 6. 相对上游的定制

1. **显示位置**：右下角悬浮 → 左侧状态栏（官方公共席位 `sidebar.footer.action`，零核心补丁）
2. **DeepSeek 双数据源**：DSH 账号余额优先（含赠金，无需 API Key），API Key 回退
3. **可配置余额警告额度**：`deepseekWarnThreshold`，默认 10 元，0 表示不警告
4. **OpenAI Codex 订阅额度**：复用 `dsh-codex-connect` 的公开额度 API，不碰 token
5. **独立设置页**：在「设置 → 内置插件 → Usage Dock」里勾选渠道、填 Key，带保存/放弃
6. **取数后端自适应**：原生 fetch（首选，Host 进程内）⇄ Python shim ⇄ curl 自动选择，
   只有传输层失败才换下一个后端；上游答复（含 HTTP 错误）立即返回
7. **刷新间隔**：60 秒 → 30 秒
8. **缩略（rail）状态胶囊不可交互**：折叠后只剩状态圆点，且不挂点击、不渲染详情面板
   ——详情只在展开状态点击打开（0.6.3，移动端 Web UI 反馈）

## 7. 已知限制

- **Host 半仍会拉取已禁用渠道的数据**（它读的是插件加载时的配置）。不影响显示，只是有无谓请求；
  若在意，可让 Host 在每次请求时通过 `configEditor` 重读配置。
- 插件配置改动**需要 Host 侧生效时必须重启**；显示层的过滤已做到实时。
- 原生 fetch **不读系统代理设置**（Node/undici 默认行为）。必须走代理出网的环境里首次请求会先
  失败一次（最多 10 秒），随后自动落到会读代理的 Python shim 并被记住——功能不受影响，只是首次稍慢。
  若要让 fetch 直接支持代理，可给 Host 进程加 `NODE_USE_ENV_PROXY=1`（Node 24+）。

## 8. 发布

```powershell
# 1) 改 package.json 版本号 + 更新文档 → 提交 → 推送
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin main

# 2) npm 发布（需在交互式终端输入 OTP；agent 无法代劳）
npm publish

# 3) 打标签并推送（标签命名 v<版本号>）
git -C "E:\WorkSpace\DSH\DSH Usage Dock" tag -a v0.6.3 -m "dsh-usage-dock v0.6.3"
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin v0.6.3
```

> npm 发布需要 2FA 验证码，**agent 环境无法完成**（npm 会把认证链接脱敏成 `***`），必须由人执行。

**GitHub Release**：本机**没有装 `gh`**，用 REST API 创建即可（已验证可行）：

```powershell
# 凭据从已存的 git 凭据里取（本机装了 GCM；token 不要打印出来）
$token = (("protocol=https`nhost=github.com`n`n" | git credential fill) -replace '^password=','' |
  Where-Object { $_ -notlike 'protocol=*' -and $_ -notlike 'host=*' -and $_ -notlike 'username=*' })
# 然后 POST https://api.github.com/repos/Slacom/dsh-usage-dock/releases
#   { tag_name, name, body（markdown，UTF-8 字节发送）, draft:false, prerelease:false }
```

- 发布说明写在仓库里（如 `docs/release-notes-v0.6.2.md`），既进版本库、又可直接作为 Release 正文；
- 历史：**v0.6.2 是本仓库的第一个 tag 与第一个 GitHub Release**；npm 上 0.4.x/0.5.x/0.6.0
  从未单独发布，用户是从 `0.3.0` 直接跳到 `0.6.1`/`0.6.2` 的——写发布说明时注意这一点，
  否则「相比上一版」会漏掉一大段变更。

## 9. 目录说明

| 目录 | 内容 | 是否入库 |
| --- | --- | --- |
| 根目录 | 插件本体（index/client/plans/package.json/…） | ✅ 会发布到 npm |
| `docs/` | 开发文档、安装指南、迁移记录 | ✅ |
| `tools/` | 辅助脚本（如 DSH 侧栏补丁重放） | ✅ |
| `legacy/` | 历史补丁包、旧备份仓库、诊断报告 | ❌ 仅本地（.gitignore 排除） |
| `reference/` | 第三方参考源码（如 dsh-codex-connect） | ❌ 仅本地 |

## 10. 历史脉络（简）

1. 最初是上游 `dsh-plan-usage` + Termux 侧栏补丁（见 `docs/plan-usage插件修改记录.md`）
2. 新增 DeepSeek 余额、Codex 额度；侧栏方案从「改 sidebar 核心包」改为「注册官方席位」（零补丁）
3. DSH 升级到 0.2.0 后适配了大量 API 变更（见第 5 节），改名 `dsh-usage-dock` 并发布 npm
4. 加入独立设置页、可配置阈值、保存/放弃按钮、实时配置过滤
5. 0.6.2 修掉移动端（Android APK）取数全断的问题：改为 Host 进程内原生 fetch，
   Python/curl 降级兜底；顺带补上逐后端失败原因与 8 项回归测试
6. 0.6.3 修掉移动端 Web UI 侧栏缩略时点击状态点弹出竖排乱码面板的问题：
   缩略状态不再挂点击、面板只在展开态渲染；新增浏览器半回归测试（4 项）

---

*文档更新时间：2026-10-06*
