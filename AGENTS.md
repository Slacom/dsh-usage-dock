# dsh-usage-dock — 项目对接文档

> 面向接手本项目的 AI agent / 开发者。**动手前先读完本文**，尤其是第 5 节的 API 契约，
> 那里记录的都是踩过的坑，重复踩会浪费大量时间。

---

## 1. 项目是什么

DeepSeek Harness（DSH）的**侧栏用量/余额插件**：在 Web/桌面端左侧状态栏底部显示各家 AI 套餐的
用量与余额，点击可展开详情面板。fork 自 `chendefine/dsh-plugins-plan-usage`，改名 `dsh-usage-dock`
以避免与上游混淆，并做了一系列定制（见第 6 节）。

**当前版本**：0.7.1　|　**已发布**：GitHub + npm　|　**已安装**：desktop profile

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
tools/mock-react.mjs           浏览器半测试共用的极简 React 运行时 + client.js 加载器
tools/test-collapsed-pill.mjs  浏览器半回归测试：缩略（rail）状态不可交互（见第 4 节）
tools/test-footer-row.mjs      浏览器半回归测试：胶囊独占侧栏底部一行（见第 4 节）
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
# 5) 交给用户安装测试 —— 用户确认之前不要 push / 打标签 / 发 Release（见第 8 节的推送闸门）
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

# 浏览器半回归测试：胶囊独占底部一行、排在最上面、外观对齐侧栏按钮（9 项，离线）
node tools/test-footer-row.mjs

# 上面两个 client 测试共用 tools/mock-react.mjs（极简 React 运行时 + client.js 加载器）
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
| 13 | **`sidebar.footer.action` 是多个插件共享的同一条横向 flex 行**（0.1.x 核心包里叫 `footerActions`，规则就是 `display:flex`，且默认 `nowrap`）。装了两个及以上用该席位的插件时（本插件旧 `order:10`、`ds-harness-remote` `order:-20`），它们会挤在同一行互相抢宽度，本插件被压窄导致内容显示不全（0.7.0 的真实故障） | 不要用 `flex:1 1 auto` 去参与这一行。挂载后**运行时探测**最近的 `flex-direction: row` 祖先，给它补 `flex-wrap: wrap`，并把胶囊声明为 `flex-basis:100%`——这样胶囊独占一行，其他插件各自成行，上下顺序交给各自的 slot `order`（见 client.js 的 `useOwnRow`；本插件取 `order:-1000` 排到最上面，向上展开的详情面板就不会挡住别人）。注意：**纵向**容器（旧版 `footArea` 是 `column`）绝不能加 wrap / basis:100%，那会被解释成高度并压扁同列条目。用运行时探测而非写死类名，是因为 DSH 的 CSS Module 类名带哈希、跨版本会变，而 `:has()` 在旧版 Android WebView 上不保证支持 |
| 14 | **行内样式优先级高于任何选择器**：元素上一旦写了行内 `background`，再注入 `.x:hover{background:…}` 也**永远不生效**（0.7.0 第一版的真实故障：鼠标移上去没有灰底，但 `title` 提示照常弹出——「提示能弹、样式不变」正是这类问题的关键线索，说明 `:hover` 在触发、只是被行内盖住） | 交互态（hover / focus）**用 React 状态写行内**，别指望 CSS 伪类去覆盖行内：`onMouseEnter/onMouseLeave/onFocus/onBlur` 切一个 `hot` 状态直接决定行内底色。行内只保留交互态不会覆盖的属性；`appearance:none` 用来去掉 `button` 的原生外观（否则会回落到系统灰底） |
| 15 | **该行还会给条目留内距**：`sidebar.footer.action` 的整行可用宽度是 x 10..339，但条目内容区只有 x 15..334。只写 `width:100%` 的话，悬停底色会比同容器里的 Remote **左右各短约 5px**（0.7.1 的真实故障，靠量真机截图的像素才发现：Remote 灰底 330px / 我们 320px） | 照抄 `ds-harness-remote` 的向外贴边写法：`.dshRemoteSidebarEntry.isWide{width:calc(100% + 8px);height:34px;margin:4px -4px}` → 本插件在 client.js 里用 `ROW_BLEED = 4`，展开态给根节点 `width:calc(100% + 8px)` + `margin:0 -4px`。**缩略（rail）态绝不能贴边**（rail 仅约 36px 宽，外扩会溢出）。量像素的办法：用打包的 Python + Pillow 找悬停灰底 `#ECEEF0` 的逐行游程，比肉眼可靠 |
| 16 | **同一件事在 DSH 里有三个不同宽度，别量错基准**（2026-10-10 实测，同一张截图的绝对值）：DSH 自带列表行（工作区／「调试」悬停）= x 15..334 = **320px**；同容器里的 `ds-harness-remote` 条目 = x 10..339 = **330px**；「新会话」按钮的常驻边框 = x 23..324 = **302px**（那是按钮表面，不是悬停底色） | 本插件**按 330px 对齐 Remote**——同一容器里的直接邻居；这是用户看过三者数据后**明确选定**的基准（2026-10-10），**不要**因为「DSH 原生行是 320」就擅自改回去。若将来 DSH 改了内距，重新量一遍再决定 |

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
9. **底部席位独占一行、且排在最上面一行**：胶囊不再与其他插件（如 Remote）抢同一条横向行，
   而是整行独占、上下排列；席位 `order` 取 `-1000`，这样向上展开的详情面板不会遮挡别的按钮；
   外观也与侧栏按钮对齐（默认透明、无边框无阴影，悬停才出灰底）——0.7.0，做法见第 5 节第 13 条。
   **圆角/内距照抄侧栏条目**：`border-radius:12px` + `padding:6px 10px`，出处是 DSH 自带
   「新会话」按钮与 `ds-harness-remote` 的 `.dshRemoteSidebarEntry.isWide .dshRemoteModeButton`
   （`iconButton` 那类 28px 圆形按钮用 50%，与条目不通用）——改这两个值前先回去核对，别凭感觉调

## 7. 已知限制

- **Host 半仍会拉取已禁用渠道的数据**（它读的是插件加载时的配置）。不影响显示，只是有无谓请求；
  若在意，可让 Host 在每次请求时通过 `configEditor` 重读配置。
- 插件配置改动**需要 Host 侧生效时必须重启**；显示层的过滤已做到实时。
- 原生 fetch **不读系统代理设置**（Node/undici 默认行为）。必须走代理出网的环境里首次请求会先
  失败一次（最多 10 秒），随后自动落到会读代理的 Python shim 并被记住——功能不受影响，只是首次稍慢。
  若要让 fetch 直接支持代理，可给 Host 进程加 `NODE_USE_ENV_PROXY=1`（Node 24+）。

## 8. 发布

> ⛔ **推送闸门（用户 2026-10-08 明确要求，优先于本节其余内容）**：
> 版本构建完成后**不要急着 push / 打标签 / 发 Release / npm publish**。
> 先在本地部署、由**用户安装测试**，**用户确认没问题之后**才做推送与发布。
> 反例：0.6.3 是在用户测试前就推送并发了 Release，用户随后纠正了这一点。
> 如果用户需要**在平板等其它设备上试装**（那些设备只能从 npm / GitHub 取包），
> 先问用户希望怎么给包，不要自行推送。

用户确认测试通过之后的发布次序：

```powershell
# 1) 改 package.json 版本号 + 更新文档（含 docs/release-notes-v<版本>.md）
# 2) 提交并推送主干
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin main

# 3) 打标签并推送（标签命名 v<版本号>）
git -C "E:\WorkSpace\DSH\DSH Usage Dock" tag -a v0.6.4 -m "dsh-usage-dock v0.6.4"
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin v0.6.4

# 4) GitHub Release（见下）

# 5) npm 发布 —— 由 agent 执行（用户 2026-10-10 起授权，别再让用户手动跑）
npm publish --dry-run      # 先核对打包内容与 shasum
npm publish                # Automation token 已配置，非交互可直接发
```

> ✅ **npm publish 现在由 agent 负责**（用户 2026-10-10 明确授权：「之后 npm 也由你来推送」）。
> `~/.npmrc` 里是一个 **Automation 类型的 token**（绕过 2FA），所以 `npm publish` 非交互可完成，
> 不需要用户输验证码。发布前先 `npm publish --dry-run` 核对（0.7.0 为 16 个文件 / 38.9 kB）。
>
> ⏳ **两个时间点要记住**：
> - 该 token 创建于 **2026-10-08、有效期 90 天**（约 **2027-01-06** 到期）——到期后发布同样会报
>   401/E404，需要用户重新生成一个 Automation token 并写进 `~/.npmrc`；
> - npm 已公告 **2027 年 1 月**起取消「bypass-2FA token 直接发布」的能力，届时要么走
>   Trusted Publishing（仅 CI 场景），要么回到人工 `npm publish` + OTP。
>
> ⚠️ **token 失效的假象（2026-10-08 实测，浪费过一次排查时间）**：`npm login` 在 10-06 12:28
> 写入的 token 当天 14:15 还能发布 0.6.2，两天后同样的命令变成
> `npm whoami` → **401 Unauthorized**、`npm publish` → **E404 Not Found - PUT
> https://registry.npmjs.org/dsh-usage-dock**。
> 「404 找不到包」极具迷惑性（包确实存在、账号也是 maintainer），**根因是凭据失效**，
> 与包名、scope、权限、代码都无关。排查顺序固定为：
> `npm whoami`（401 = 凭据问题，先解决它）→ `npm publish --dry-run`（打包是否正常）→ 再真发。

> ℹ️ **发布成功后 registry 有短暂延迟**（2026-10-08 实测约 **2 分钟**）：`npm publish` 打印
> `+ dsh-usage-dock@0.6.3` 和 “Your package is being processed and may take a few minutes to
> become available.” 之后，服务端才真正对外生效。这段时间 `npm view <pkg> version`
> **读的是本地缓存**，会继续显示旧版本（连查两次都一样），极易误判成发布失败。正确校验方式：
> `npm view dsh-usage-dock@0.6.3 version --prefer-online`，或直接请求版本端点
> `https://registry.npmjs.org/<pkg>/<version>`（200 = 已上线）。也可以比对线上 `dist.shasum`
> 与本地 `npm publish --dry-run` 的 shasum，确认线上产物就是被测过的那一个
> （0.6.3 两者一致：`2c76b6a38b0a11522bfbb5f08306d4b5b0d54523`）。

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
7. 0.7.0 修掉底部席位多个插件挤同一行的问题：胶囊改为整行独占、席位 `order:-1000` 排到最上面
   （详情面板向上展开不再遮挡其他按钮），外观也改成与侧栏按钮一致（透明 + 悬停灰底）；
   新增 footer 行回归测试（8 项），并把浏览器半测试的 mock 运行时抽成 tools/mock-react.mjs
8. 0.7.1 修掉悬停灰底比别家按钮两侧各短约 5px 的问题（照抄 Remote 的 `+8px / -4px` 向外贴边，
   见第 5 节第 15 条）；footer 行测试增至 9 项（新增「缩略态不得贴边」）

## 11. 未来方向（roadmap）

完整记录在 **[docs/roadmap.md](docs/roadmap.md)**，排新版本时从那里取。当前待做：

1. **详情面板内提供 DeepSeek 充值入口**：与「设置 → 账号与余额」的充值按钮一致，
   点击跳转 DSH 内嵌充值页；仅账号登录（`via === "account"`）时显示。
2. **充值后胶囊余额与设置页余额实时同步**：设置页立即更新、胶囊却停在旧值
   （2026-10-10 充值实测：设置 ¥34.42 vs 胶囊 ¥4.42）；优先事件驱动/订阅设置页同款数据源，
   保底在 focus / 路由返回 / 面板展开时立即刷新，同样仅账号登录时实现。

两条都**尚未排期**，动手前先读 roadmap 里的现状数据流与实现要点。

---

*文档更新时间：2026-10-10*
