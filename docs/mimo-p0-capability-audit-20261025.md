# MiMo 扫码认证 P0：宿主能力审计与最小离线基线（2026-10-25）

> 阶段：**P0 静态审计 + 最小离线基线**。本轮**未**写生产代码、**未**发起任何登录/续期/供应商请求、**未**改动安装副本或配置、
> **未**读取真实 profile / `.credentials.yaml` / `.env` / 浏览器或其它插件的认证文件，**未**使用外部网络。
> 上游规划：[mimo-auth-plan-v0.9.1-20261024.md](mimo-auth-plan-v0.9.1-20261024.md)；交接文档 365 行已完整阅读（`D:\Download\dsh-usage-dock_MiMo_QR_persistence_handoff_2026-10-19.md`）。
> 本文件只回答三件事：**宿主到底有什么能力（已证/未知/缺）**、**现有认证状态与来源接线在哪里**、**P1 怎么做才不越线**。
>
> **修订 r2（2026-10-25，父首审后）**：① 撤回"安装不可审"的推导（改为**会话级可见性差异**，当前 SDK 由父另提）；② 撤回"SDK 只有明文一档"的外推，
> 存储方案改为**先调查安全封装/密文载体**；③ 认证端点（含 GET 状态/二维码资源）统一 owner admit + `no-store`；④ 跳转改为**预先批准的精确每跳白名单**
> （不再"一律拒绝"）；⑤ 修正 single-flight 的取消语义（**不得**把单消费者取消并入共享根）；⑥ 探针必须标注**执行模式与二进制**，缺 `getSetCookie` 另有
> `rawHeaders` 路径；⑦ P3 身份方案明确复用 `recordSampledCredential`/`beginOp`，不另造缓存重构。**本文件不是 P1 获批。**
>
> **修订 r3（2026-10-25，父导出当前安装公开 SDK 后）**：① 证据基准从历史快照升级为**当前权威安装 `0.2.1-rc.3`**（19 文件，见 §3.0），
> 并逐文件哈希比对旧 14 份：**10 份字节相同、4 份仅版本号/pin 变化**，所有 `lib/index.js` 实现层字节相同 → **owner/admit、存储、生命周期结论不变**；
> ② 删除"父侧同期 `Test-Path` 为 True"的表述（两侧路径字面不同、等价性未证明，本报告不争路径，改用父导出的当前源码补证）；
> ③ 新增 **`DSH_HOME` record 命名是全局的**：`credentialKey('usage-dock','mimo-account')` 会跨 profile/插件实例混用，**键格式校验不是 ACL**，
> 必须显式设计 profile + 插件实例隔离（§3.3、§5.2）；④ 新增**纯离线运行时探针** `runtime-probe.mjs` 并给出系统 Node 结果（§5.7 关口 0）。

---

## 0. 基线与脏保护（不可协商）

| 项 | 值 |
|---|---|
| HEAD | `d712b7a4a8da54f34108f58fc214030512a40a2f` |
| 分支 | `feat/wb-client-credits-20261025` |
| 工作树 | **11 个已修改 + 7 个未跟踪 = 18 条**（均为已验收未提交的 WorkBuddy 改动与文档） |
| 包版本 | `0.9.1-dev.wbcredits.20261025.3`（用户已确认本地安装；本轮未重新验包、未部署） |
| **宿主编译标识** | 桌面壳 `@deepseek-ai/dsh-desktop` **`0.2.1-rc.3`**、`dshBuildCommit be72761ee1a6736ebcdf4f3739363b083ae53c98`、`dshBuildDirty:false`（`sdk-current-parent/app-package.json`） |
| **审计后基线变化（父动作，非本子代理）** | 父按用户批准"仅本地 WB 基线提交 + MiMo 分支"，把上表 18 条作为 **`70a27b5 fix(workbuddy): use client credits and refine local details`** 提交到 `feat/wb-client-credits-20261025`，并**从该提交新建** `feat/mimo-qr-20261025`（两者同为 `70a27b5`）。审计当时的工作树状态如上表；此后剩余未跟踪只有 `docs/mimo-auth-plan-v0.9.1-20261024.md`、本文件、`项目进度-2026-10-21.md`（个人进度文件，我不读改）。**本子代理全程零 git 写**。 |

已修改：`README.md`、`client.js`、`index.js`、`package.json`、`plans/workbuddy.js`、`tools/test-custom-round5.mjs`、
`tools/test-workbuddy-gateway.mjs`、`tools/test-workbuddy-round6/7/8/9.mjs`。
未跟踪：`docs/deploy-workbuddy-client-credits-20261025.md`、`docs/mimo-auth-plan-v0.9.1-20261024.md`、
`docs/workbuddy-detail-cleanup-20261025.md`、`docs/workbuddy-expiry-label-20261025.md`、
`tools/test-workbuddy-client-credits.mjs`、`tools/test-workbuddy-expiry-label.mjs`、`项目进度-2026-10-21.md`。

本会话对 Git 的写操作：**零**（无 add/commit/reset/checkout/stash/clean/tag/push；未切分支；未触碰上述 18 条）。
（父已获用户批准"**仅本地** WB 基线提交 + 新建 MiMo 分支"；那是父的动作，**本子代理仍不执行任何 git 写**，也不改产品代码。）
本会话新增的文件只有两个位置：
- 本文件（`docs/`，会出现在 `git status` 的未跟踪里，属预期）；
- `.diagnostics/mimo-qr-20261025/`（`.gitignore:12` 已排除 `.diagnostics/`，不污染工作树）。

读取过的产物/源码清单（全部只读）：`AGENTS.md`、`docs/mimo-auth-plan-v0.9.1-20261024.md`、交接文档、`plans/mimo.js`、
`plans/index.js`、`plans/util.js`、`index.js`、`client.js`、`package.json`；**当前权威证据** `.diagnostics/mimo-qr-20261025/sdk-current-parent/`
（父导出，`0.2.1-rc.3`，含 `app-main-entry.js`/`app-package.json`）；以及仅供 §3.0 比对的旧快照
（`.diagnostics/mimo-qr-20261025/sdk/`、`.diagnostics/inspector-public-guide-20261022/public-src/`、
`.diagnostics/asar/dsh/node_modules/@deepseek-ai/`、`.diagnostics/routing-audit-20261019/installed/`、`.diagnostics/wb-client-credits-20261025/sdk/`）。

> ⚠️ **证据口径（r3 已纠正）**：本子代理会话在 `2026-10-25T19:42:02+08:00` 对 `D:\DeepSeek`、`D:\DeepSeek\DeepSeek.exe`、
> `D:\DeepSeek\resources\app.asar` 三项测得 `Test-Path=False` / `fs.statSync=ENOENT`，而 `Get-Process` 报告 `DeepSeek.exe` 的运行路径为
> `D:\DeepSeek\DeepSeek.exe`（PID 34684 / 40124，启动 18:07:22）。
> **父侧测试所用字面路径与本报告写的字符串是否等价，尚未证明** —— 本报告不就此争路径对错，也不据此推断"安装缺失/不可审计"。
> 权威证据已改为**父只读导出的当前安装公开 SDK**（`.diagnostics/mimo-qr-20261025/sdk-current-parent/`，19 文件 + `PROVENANCE.json`，
> `0.2.1-rc.3`）；其执行模式是 **Electron source-reader（`ELECTRON_RUN_AS_NODE`）Node 24.21.0 / Electron 44.7.0 / Chrome 152.0.7977.130**，
> **未加载 profile 或 SDK 服务、未读凭据、零外网**，且**不是运行中 Host 的能力证明**。本报告不再依赖旧 `0.2.1-rc.2` 快照作结论依据
> （旧快照仅用于 §3.0 的差异比对）。`ELECTRON_RUN_AS_NODE` 在本会话不可执行；**没有**换客户端、换 DNS 或其它方式绕过。

---

## 1. 结论摘要

| # | 能力 | 结论 | 证据强度 |
|---|---|---|---|
| 1 | 宿主能拿到**逐条** `Set-Cookie` | **本机 Node 24.14.0 已证**（`Headers.prototype.getSetCookie` 返回数组）；**当前运行 Host 未知**（本会话不可达该二进制，见 §0）。缺 `getSetCookie` ≠ 不支持：另有 MiMo 专用 `node:https` 的 `rawHeaders`/多值 `set-cookie` 路径待审 | 本机实测 + 宿主未知 |
| 2 | 可写、可删、按插件隔离的**秘密存储** | **有**：`ctx.credentials` 的 `refs`（`set/unset/resolve/describe`）与 `records`（`readRecord/modifyRecord/deleteRecord/listRecords`），`credentials-local` 落在 `$DSH_HOME/.credentials.yaml` | **已证**（源码） |
| 3 | 该存储**落盘加密** | **未知（整体）**。只证明 `credentials-local` 这**一个 provider** 的写路径是明文 YAML（无任何加密原语）；**未**排除其它 credentials provider、也未排除把**自加密后的密文**放进 record 作为载体 | 单个 provider 已证 / 整体未知 |
| 4 | **已认证** Host/Client HTTP 通信 | **有**，但只有 `connection.fetch.register` 是 **owner-only**（`:820-838` 二次检查 `peer.principal.kind !== "owner"` → 403）。⚠️ **`connection.requestRejection(req)` 只回 `admit()` 的结论，而 `admit()` 明确接受 API peer**（`:742-750` 先试浏览器 cookie，再试 `browserAuth.authenticateApi`）→ **`requestRejection` 通过 ≠ owner** | **已证**（源码；父已独立复核 `:737-749`/`:826-831`） |
| 5 | 现有 `/api/plan-usage*` 路由是否受该检查保护 | **否**。`webServer.match()` **精确表优先于前缀表**，插件的 `kind:'exact'` 路由绕开了 `/api` 前缀上的 `admit()` | **已证**（源码） |
| 6 | 插件生命周期（加载/卸载/配置变更） | **已证**：`apply(ctx, config)` / `ctx.effect(disposer)` / `Service.init` / `ctx.inject([...])` / `ctx.on('app-boot/config-reload')` | 已证 |
| 7 | Android（DSHA）是否具备 1/2/4 | **未知**。项目文档只确证"无 shell、无账号服务、无 `configEditor`"；`credentials`/`connection` 是否存在未验 | **未知** |

一句话：**"能存"不等于"加密存"，"有认证通道"不等于"我们的路由已受认证"**。这两处必须在 P1 里用真实宿主证明，不能按名字假设。

---

## 2. 宿主能力矩阵

宿主形态与证据边界：
- Desktop 与 `dsh web` 共用**同一套 Host 插件进程**（desktop 只是把窗口指向 `connection.authenticatedUrl(...)`）——
  `.diagnostics/mimo-qr-20261025/sdk/dsh-desktop-host-lib-index.js:342`。
- 因此"Host 能力"主要是**一个 Node 运行时 + 一套 Cordis 服务**，差异集中在 Android 移植端与是否安装某些服务。

| 能力 | Desktop（Electron） | web（`127.0.0.1:6188`） | Android / DSHA |
|---|---|---|---|
| Host 运行时 | 与 web 同一进程模型；具体 Electron/Node 版本 **未知**（U1，待父提取当前 SDK / 查启动器） | 同左 | **不能**把 Termux 的 node 当成 Android DSHA 的 Host 运行时；后者未验 |
| 原生 `fetch` | **已证可用**（生产取数后端，`plans/util.js` 首选项） | 同左 | 文档记载已修（0.6.2 改为 Host 进程内 fetch，`AGENTS.md` §5 第 10 条）；**本轮未真机复测** |
| `Headers.getSetCookie` | **未知**（需在**当前运行 Host**内探针，且必须标注执行模式/二进制） | **未知**（同） | **未知**。缺该 API **不等于**不支持 Cookie 管理——可改审 MiMo 专用 `node:https` 的 `res.rawHeaders` / 多值 `set-cookie`（**绝不**逗号拆分） |
| 可写/可删秘密存储 | `ctx.credentials`（本快照里唯一实现的 provider 是 `credentials-local`）；**是否存在其它 provider 未知** | 同左 | **未知**（若缺该服务，`client-connection` 自身会因 `inject:['credentials']` 不激活，故**很可能存在**，但这是推断不是证明） |
| 命名空间隔离 | `records` 键必须是 `<scope>/<id>`（两段小写连字符）；`refs` 是 POSIX 环境变量名 | 同左 | 同左（若服务存在） |
| 落盘加密 | **未知（整体）**：`credentials-local` 写明文 YAML + `0600`，`win32` 跳过权限位检查；**未**排除其它 provider 或"自加密密文放进 record" | 同左 | **未知**；`0600`（Termux）**不是** Keystore |
| 平台加密原语 | **Windows DPAPI（CurrentUser）API 可用**（合成探针实测，见 §5.2.2）；**Host 是否有适配未知**，Node 无内置 DPAPI，`safeStorage` 在 Node 模式下是否存在待探针 | 同左 | **未知**（Keystore 等价能力未验） |
| 秘密对浏览器可见性 | 插件 `Config` 的 `role('secret')` 字段在 remote `describe` 里被**结构剥离**，只回 `{path, set}` + `revision` | 同左 | 同左 |
| 已认证 Host/Client 通信 | `connection.fetch.register`（内含 owner 判定）；`requestRejection` **只**做围栏+会话校验、**不含** owner 判定 | 同左 | **未知** |
| 生命周期 | `apply`→`ctx.effect`→`Service.init`；退出走 `shutdown.shutdown(0)`（`dsh-desktop-host-lib-index.js:264`） | 同左 | 未验 |

**进程模型（r3 新增证据，`app-main-entry.js`）**：桌面壳把 Host 作为**独立子进程**启动 ——
`spawn(this.node, ['--expose-internals', …(开发期 --inspect), <runtimeDir>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js,
runtimeDir, projectDir, primaryRuntime, (pnpm, nodeBin)], { cwd: projectDir, env: desktopNodeEnvironment(...), stdio:['ignore','pipe','pipe','ipc'] })`
（`app-main-entry.js:3764-3811`）。其中：
- `this.node` 的注释是 **"Absolute Electron executable in Node mode"**；`desktopNodeEnvironment()` 会设置 **`ELECTRON_RUN_AS_NODE:"1"`**（`:3649-3658`）；
- **`cwd` = `projectDir`（插件 profile 目录）**，`runtimeDir` 是随包不可变运行时；退出走 IPC（`shutdown` → `shutdown-complete`，`:264-270`）；
- 桌面壳自己的设置放在 Electron `userData/desktop/settings.json`，**明确独立于 `DSH_HOME`**（`:10280`）。

→ 由此得到两条对 P1 直接有用的边界：① "Electron Node 模式读源码"与"运行中 Host"**共享二进制与 Node 模式，但 env/argv/cwd/入口不同**，
不能互相当证明；② **profile 是 cwd，不是 `DSH_HOME`** —— 而 `credentials-local` 的文件路径只由 `DSH_HOME` 决定（见 §3.3 的隔离缺陷）。

补充静态证据（父取证，共享副本可核）：`runtimeResources.node = process.execPath`（`app-main-entry.js:11891-11898`），
该值一路传到 `DesktopHostProcess`（`:12182` → `:3793-3804` 的 `spawn(this.node, ['--expose-internals', …])`）；
公开 CLI `dsh.cmd` 同样是设 `ELECTRON_RUN_AS_NODE=1` 后调用**同一个**安装 exe。
**这些都只是"同一二进制/启动器"的静态证据**：它们**不能**证明当前进程里的 `fetch` 没有被宿主/插件覆写，也不能替代运行中进程的实测（§5.7 关口 0）。

**明确不写假保证**：`role('secret')` 的脱敏、`0600`/目录私有、文件存在，**都不等于加密**。本快照里唯一实现的 provider（`credentials-local`）
确实明文落盘（§3.3），参考插件 `dsh-codex-connect` 也明文存 OAuth 令牌 —— 但这**只证明这两个实现**，**不外推**为"SDK 只有这一档"。

---

## 3. 证据清单（文件:行）

**证据基准（r3 起）**：`.diagnostics/mimo-qr-20261025/sdk-current-parent/` —— 父只读导出的**当前权威安装**公开 SDK，
全部为 **`0.2.1-rc.3`**（19 个 SDK 文件 + `app-main-entry.js`/`app-package.json` + `PROVENANCE.json`）。**本节行号以该目录为准**。
旧 `sdk/`（`0.2.1-rc.2`，14 份）仅用于 §3.0 的逐文件差异比对。
唯一例外：`dsh-codex-connect`（第三方插件，Apache-2.0 / v0.2.0-alpha.6）**未复制**，按工作区既有快照
`.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js` 引用 —— 本轮 **0 行第三方代码**进入仓库。

### 3.0 当前安装（rc.3）与旧快照（rc.2）的逐文件比对 —— 4 处差异的影响

| 结果 | 文件 |
|---|---|
| **字节完全相同（10）** | `dsh-host-webserver-lib-index.js`、`dsh-client-connection-lib-index.js`、`dsh-credentials-lib-index.js`、`dsh-credentials-local-lib-index.js`、`dsh-settings-lib-index.js`、`dsh-api-settings-controller-lib-index.js`、`dsh-api-gateway-lib-index.js`、`dsh-api-gateway-lib-types-access.js`、`dsh-desktop-host-lib-index.js`、`dsh-experimental-inspector-lib-index.js` |
| **不同（4，全部是 `package.json`）** | `dsh-host-webserver-package.json`、`dsh-client-connection-package.json`、`dsh-credentials-package.json`、`dsh-credentials-local-package.json` |
| 新增（旧无副本） | `app-main-entry.js`、`app-package.json`，以及 api-gateway / api-settings-controller / desktop-host / inspector / settings 的 `package.json` |

4 个差异的**字段级 diff 只有两类**：`version: 0.2.1-rc.2 → 0.2.1-rc.3`，以及同 monorepo 内 `dependencies`/`peerDependencies`/`devDependencies`
的 pin 从 `0.2.1-rc.2 → 0.2.1-rc.3`。**`inject`/`engines`/`exports`/`files`/`peerDependencies` 集合本身没有任何变化**
（`engines` 在四个包里都不存在；`exports`/`files` 完全相同）。

| 结论领域 | 受影响吗 | 理由 |
|---|---|---|
| **owner / admit（`connection.fetch` / `requestRejection` / `/api` 前缀 admit / 精确路由优先）** | **否** | 语义全在 `dsh-client-connection-lib-index.js` 与 `dsh-host-webserver-lib-index.js` 的 `lib/index.js` 里，两者**字节相同**；`inject` 依赖集合未变（`client-connection` 仍只 `inject:["credentials"]`） |
| **存储（`refs`/`records`、明文、`0600`、`win32` 跳过、原子写、锁）** | **否** | `dsh-credentials{,-local}-lib-index.js` **字节相同**；`credentials-local` 的 peerDeps 仍指向同批包，只是版本 pin 升到 rc.3 |
| **生命周期（`apply`/`ctx.effect`/`Service.init`/shutdown）** | **否（且新增证据见 §2）** | `dsh-desktop-host-lib-index.js` 字节相同；另外 `app-main-entry.js` 补出了 Host 的**进程模型**（子进程 + `ELECTRON_RUN_AS_NODE` + `--expose-internals` + IPC 关闭） |
| **版本口径** | **是（必须更正）** | 此前标 `0.2.1-rc.2`，当前安装实为 **`0.2.1-rc.3`**；本报告已全文改用 rc.3，`rc.2` 仅出现在本 §3.0 的比对说明里 |

> 换句话说：**"实现的语义"没变，"版本标签"变了**。这也意味着本报告此前基于 rc.2 的实现层结论**对当前安装仍然成立**，
> 但不能再把版本号写成 rc.2。

### 3.1 Web 服务器：注册即公开，鉴权不在这一层
- `dsh-host-webserver-lib-index.js:326-333` `register({kind:'exact'|'prefix', path, handler})`，重复 (kind,path) 抛错，返回 disposer。
- `:340-346` `registerUpgrade`；`:355-361` `registerFallback`（唯一）。
- `:378-409` 请求分发：`gzip`（可选）→ `handle` → 路由或 fallback；**没有任何身份/Origin 检查**。
- `:494-504` **`match()`：先查精确表，命中即返回；再走最长前缀**。← 关键
- `:252-255` 绑定地址必须是**具体 IPv4/IPv6 字面量**，通配地址被拒绝（"binding every interface would expose remote code execution to the network"）。
- `:306-318` `origin` = `protocol + bindUrlHost(host) + port`。

### 3.2 认证通道：`connection`
- `dsh-client-connection-lib-index.js:1013` `inject = ["credentials"]`；`:1034` `BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)`。
- `:276` `TOKEN_QUERY="token"`；`:440-444` `authenticatedUrl()` 把**进程级启动令牌**拼到 URL；`:458-477` 只在 `GET /`、恰好一个 token 时换取 cookie 并 302 到 `./`。
- `:346-350` cookie 属性：`Max-Age` / `Path=/` / `Expires` / **`HttpOnly`** / **`SameSite=Strict`**，TLS 时加 `Secure`。
- `:335-337` cookie 名 = `前缀 + sha256(authority)`（**绑定到当前监听 authority**）；`:351-357` HMAC-SHA256 签 body；`:330-334` `timingSafeEqual` 比较令牌。
- `:391-410` 签名密钥本身通过 **`credentials.modifyRecord(AUTH_RECORD_KEY, …)`** 持久化（即 SDK 把长期秘密放进 credentials 的 records）。
- `:742-750` `admit(request)`：`isTrusted` 不过 → 403；已销毁 → 401；浏览器 cookie 验签通过 → 复用 owner peer；否则尝试 API operator，失败 → 401。
- `:777-780` `isTrusted` = Host/Origin 围栏（`isTrustedApiRequest`）；`:736-740` `requestRejection(request)` 公开给任意路由使用。
  ⚠️ **它只返回 `admit()` 的拒绝码**；`admit()` 在浏览器 cookie 之后还会尝试 **API operator**（`:747`），成功则给出对应 Peer 而不是拒绝
  → 对"远端 API 客户端"而言 `requestRejection` **不会**拦住它。**owner 判定只存在于 fetch 注册表内部**（`:826-831`）。
- `:731-734`、`:840-854` **`connection.fetch.register({path, methods, requestBody, fetch})`**：Path 必须在 `/api` 下（`:973-977` 校验），重复注册抛错，返回 disposer。
- `:820-838` 该前缀的 fetch 分发：**`peer.principal.kind !== "owner"` → 403**（远端的 API operator 打不进来）。
- `:1044-1058` `/api` **prefix** 路由先 `admit()` 再 `bridge`；`:1059-1065` `/connect` 精确路由。
- 结论对照：`index.js:998`、`:1173`、`:1227`、`:1260` 注册的都是 **`kind:'exact'`**，按 §3.1 `:494-504` 的精确优先规则，它们**不经过** `/api` 前缀的 `admit()`。→ 当前 MiMo 相关只读路由是"仅回环可达但无会话校验"。
- 参考用法（真实插件）：`.diagnostics/mimo-qr-20261025/sdk/dsh-experimental-inspector-lib-index.js:2329` 定义 `/api/experimental-inspector/bootstrap`，`:2386-2391` 用 `ctx.connection.fetch.register({methods:['GET'], requestBody:'buffered', fetch})`。
- API 网关同样挂在认证层之上：`dsh-api-gateway-lib-index.js:772-774`（`rpc.intercept('/api', …)`）、`:786-791`（WebSocket upgrade 先 `admitConnection`，失败 401/403）。

### 3.3 秘密存储：`credentials`（本快照里只有 `credentials-local`：文件型、明文）

> **证明范围**：以下全部只针对 `credentials-local` 这**一个** provider 的实现。是否还有其它 provider（平台密钥库封装等）、
> 以及"把**自加密的密文**写进 `records` 当载体"是否可行，本轮**均未调查** —— 结论不得外推。
- `dsh-credentials-lib-index.js:56-72` `CredentialKey = "<scope>/<id>"`（两段 `[a-z][a-z0-9-]*`）；`:93-108` 注释明确：record 的一半"没有环境可分层，记录存在即全部事实"，且 **`modifyRecord` 是唯一写路径**（读-改-写需要当前值，例如刷新令牌）。
- `dsh-credentials-local-lib-index.js:48-59` 文件名 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`，`DSH_HOME` 可覆盖）。
- `:123-157` 文档版本 1，顶层只有 `refs` / `records`；未知顶层键**保留但忽略**并告警（不阻断启动）。
- `:236-265` record 两种 tag：`api-key`（`key` + 可选 `env`）与 `grant`（任意 JSON `payload`）。
- `:92-106` `assertOwnerOnly`：POSIX 检查 group/other 位，**`if (process.platform === "win32") return;`**（原文注释：Windows 没有可检查的 mode，ACL 无法在此表达，所以**跳过而不伪造**）。
- `:552-568` / `:575-594` / `:608-623` 原子写 `writeFileAtomic(..., {mode: 0o600, dirMode: 0o700})` + 跨进程文件锁（等待上限 30s，`:78`）。
- `:444-478` chokidar 监听外部改动（写后重载）。
- ⚠️ **命名空间是全局的，不是 profile / 插件实例隔离**：文件名只由 `$DSH_HOME` 决定（`:48-59`，**不含 profile 组件**），
  records 的键仅做 `<scope>/<id>` 的**语法**校验，**没有任何 per-profile / per-instance 分区、没有 ACL、没有所有权检查**。
  于是固定键 `credentialKey('usage-dock','mimo-account')` 在"同一 `DSH_HOME` 下的多个 profile"或"同一 profile 的多个插件实例/多窗口"之间
  会**共用同一条记录**：后写覆盖先写、彼此读出对方的值。**键格式合法 ≠ 访问隔离** —— 这一点必须在 P1 设计里正面解决，不能拿"键带 scope 前缀"当隔离证据。
  另注：文件锁是按**整份文档**加的（`:556` `withFileLock(this.spec.filename, …)`），它只保证写不撕裂，**不区分是哪个 profile/实例在写同一个键**。
- **该文件内无任何加密原语**（无 `crypto`/`safeStorage`/DPAPI/Keystore 调用）→ 明文写作是 **`credentials-local` 的事实**，不是"SDK 全档位"的结论。
- 反面对照（参考插件，**未复制**，按既有快照引用）：`.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js:732` `.openai-codex-auth.json`、
  `:766-784` 明文存 OAuth `access`/`refresh`、`:759-765` 同样 `win32` 跳过权限位检查。→ **本项目不是唯一这么做的，但这不构成安全证明。**
  （该插件 `package.json` 声明的许可是 Apache-2.0 / v0.2.0-alpha.6，仅作事实记录；外部参考源码/许可证复核仍由父负责。）

### 3.4 插件配置里的 `role('secret')`
- `dsh-settings-lib-index.js:65-73` `redactSecrets(schema, value)`：按 schema 结构性剥除 `role('secret')` 字段（不改入参）。
- `:413-450` `describe({redactSecrets:true})` 返回 `value/base/user` 的脱敏副本 + `secrets: [{path, set}]` + `revision`。
- `:488-511` `mutate(ns, ops, expectedRevision)`：修订号不一致抛 `SettingsConflictError`。
- `dsh-api-settings-controller-lib-index.js:396-398` remote `describe()` 一律 `redactSecrets: true`；`:433-434` `mutate` 走同一写路径。
- 落盘位置：插件配置由 DSH 托管进 profile 的 Cordis patch（`AGENTS.md` §2 记录为 `…\profiles\desktop\cordis.patch.yml` 的 `plan-usage` 条目）——**同样是明文 YAML**（本轮未读取该文件）。

---

## 4. 认证状态与来源接线的源码地图

### 4.1 MiMo 现状（只有手填 Cookie）
- `plans/mimo.js:27` 唯一端点 `https://platform.xiaomimimo.com/api/v1/balance`；`:44` `mimoCookie` 为 `z.string().role('secret')`；`:46` `mimoWarnThreshold`。
- `:56-68` `normalizeMimoCookie()`：整段 Cookie 头 → 校验 `userId` + `(api-platform_)?serviceToken`，其它键原样保留（`;` 分割，不解析属性）。
- `:103-175` `fetchPlan(ctx, shell, cfg, options)`：
  - `:109-126` **冻结凭据语义**：`options.frozenCredential` 只接受 `kind:'explicit'` 且带 `fields.mimoCookie`；`none`/未知/显式但缺字段 → 直接 `no-key`，**绝不回退实时 cfg**；只有"未采样"（`undefined`）才读 `cfg.mimoCookie`。
  - `:135-144` 请求经 `curlJson(...)`，只带 `cookie` + `user-agent` + `referer`。
  - `:145-154` 401/403 或业务 `code=401/403` → "登录态已过期，请重新复制"。
- `plans/util.js:263` `curlJson()`：**只返回解析后的 JSON 与 `__DSH_HTTP__<status>` 尾标记**（`:14`），**没有响应头通道** → 拿不到 `Set-Cookie`。→ P1 必须另写 MiMo 专用 HTTP（与规划 §6 一致），不动全渠道传输。

### 4.2 Host 侧：身份 / 票据 / 冻结 / 迟到回执
| 机制 | 位置 | 关键语义 |
|---|---|---|
| 缓存资格 | `index.js:69-75` `ACCOUNT_BOUND_PLAN_IDS` | 账号/会话型渠道（deepseek/codex/workbuddy/workbuddy-ai）**不缓存身份**；**MiMo 目前不在集合内**（因为凭据就在配置里，可哈希） |
| 配置读取 | `index.js:128-216` | 2 秒缓存 `liveConfig()`；只读入口用 `freshStrict()`（绕缓存、**不吞异常**） |
| 观察身份 | `index.js:478-495` | `id + on=<启用> + key=<hash>/cookie=<hash>`（`secretFingerprint` = sha256 前 12 位，`:613-616`） |
| 采样即事实 | `index.js:392-455` `recordSampledCredential` | 首次采样只登记；**已知 A → 已知 B** 才 `bumpEpoch` + 清 `channelProjection/channelMeta/channelIdentity`，且只提升**本次自己的票据**（`:450`） |
| 操作归属 | `index.js:336-349`、`:461-474` | 每个入口先领 `beginOp` 序号；`isCurrentOp` / `liveSourceTicket` 决定能否写状态、能否派发 |
| 发布观察 | `index.js:631-720` | 同一 wire 只提交一次；提交前校验 `useTicket.identity === identityOfChannel(id)`（`:654-655`） |
| GUI 复用观察 | `index.js:722-739`、`:747-826` | 被撤销的响应改写成 `cancelled`；GUI 与模型共用 `status/failCount` |
| 激活重算 | `index.js:864-895`、`:903-916` | 身份变化/监控开关变化 → 推进 epoch；首次见到只登记 |
| GUI 路由 | `index.js:998-1163` | 每次请求 `unpackConfig` + `reconcileIdentities()`；`:1104-1114` 逐渠道签票后 **`plan.fetch(ctx, shell, cfgNow)`（三个参数，无 `options`）** |
| 工具 identify | `index.js:1466-1695` | 只碰"已启用 ∩ 已知 ∩ 请求"的渠道；冻结形状 `{kind:'explicit'|'ref'|'none'|'provider'}`（`:1556-1567`）；账号型渠道**跳过冻结**（`:1522`） |
| 工具取数 | `index.js:1842-1864` | 逐渠道 `frozenCredential: frozenOf(plan.id)`（`:1854`），`staleSnapshot()` 拦下被取代的来源 |
| 只读元数据 | `index.js:1260-1325` | `quota-windows` 用 `freshStrict`，**零凭据解析、零上游请求**；读不到配置就 fail closed |

### 4.3 客户端接线
- `client.js:128-131` MiMo 渠道元数据（`credentialHint:'MIMO'`、`thresholdField:'mimoWarnThreshold'`）。
- `client.js:5513-5528` MiMo 唯一凭据入口：`type="password"` 的手填 Cookie + 长教程，包在 `:5529-5534` 的 `<details>`（"连接与凭据"）里。
- `client.js:5733` `ctx.configForms.get('plan-usage')`；`:5752-5762` `whileServed(['plan-usage'], …)` 注册 `settings.plugins.tab`。
- 保存走 `form.mutate(ops, expectedRevision)`（`:4493-4494`，见 `AGENTS.md` §6 第 14 条的"先校验后写"）。
- **死代码告警**：`client.js:2410` / `:2492` 仍在 `fetch('/api/plan-usage/config')`（含 POST）。Host 现在只注册 4 条路由
  （`/api/plan-usage`、`/custom-status`、`/workbuddy-accounts`、`/quota-windows`），**这条 POST 早已无对应实现**（会 404）。
  不要拿它当"插件已有 POST 通道"的先例。

### 4.4 GUI 与 `usage_status` 要一致，必须改的窄接口（P3 才动，本轮不动）
1. **冻结协议要能表达"会话来源"**：`plans/mimo.js:115-126` 目前只认 `explicit`。若凭据改由认证管理器持有，必须新增一种冻结形状
   （例如 `{kind:'session', sessionId, fingerprint, platformTokenExp, …}`），并且**派发只能使用快照里的那一份**（对齐 `index.js:1613-1639` 的 provider 冻结做法）。
2. **认证状态必须进入观察身份，但复用既有机制、不另造缓存重构**：`identityOfChannel()`（`index.js:478-495`）现在只看配置字段。
   会话票若存在 credentials/内存里，换票、切账号、注销都**不会**推进 epoch → 旧余额会在注销后复活。
   做法应落在既有两条链上：`beginOp`/`isCurrentOp`（`index.js:336-349`，入场领序号、过时操作一律不写）与
   **`recordSampledCredential`（`index.js:392-455`）的"已知 A → 已知 B 才撤销 + 只提升本次自己那张票"**语义 ——
   把会话指纹当作一次采样登记进去即可，**不新增全局缓存层、不改其它渠道**。
3. **MiMo 应加入 `ACCOUNT_BOUND_PLAN_IDS`**（`index.js:75`）：一旦凭据不在配置里，Host 就无法用配置哈希证明身份，
   工具缓存跨账号复用会变成"拿 A 的余额回答 B"。
4. **GUI 路由要传 `options`**：`index.js:1111` 现在传 3 个参数 → MiMo 走"未采样"分支读实时 cfg；工具走冻结。
   两条入口若一个读 cfg、一个读会话，会出现"侧栏有余额、主动工具说没凭据"（规划 §7 明令禁止）。
   （此条已由父独立核实：三参数差异为真。）
5. **认证动作不得顺手保存草稿**：扫码/注销是即时操作，必须与 `form.mutate` 的草稿保存完全分开；也**不得**用"写回 `mimoCookie`"来传播每次换票
   （会改用户配置、触发 config-reload、并让 `role('secret')` 的只读脱敏语义变味）。
6. **状态查询必须是纯读**：沿用 `quota-windows` 的纪律（`index.js:1252-1258`）——零凭据解析、零上游请求、`no-store`。

---

## 5. 隔离 P1 方案（**提案，未获批**）

> **本文档不是 P1 获批**：方案仅供父按主规划**第 11 节评审闸门**审阅。未通过前不写 PoC、不扫登录、不发真实平台认证请求；
> 真实账号动作另需用户单独同意。

### 5.1 位置与产物
- 代码：`tools/poc/mimo-auth/`（`package.json:12-19` 的 `files` 不含 `tools/`，不会进包）。
- 产物：`.diagnostics/mimo-qr-20261025/p1/`（已 gitignore）。
- 不 import、不改 `plans/mimo.js`、不改 `plans/util.js`、不动 `index.js` 的正式查询路径、不动设置页。

### 5.2 安全存储（**先调查安全封装，不默认明文**）

- **撤回**先前的"默认 `modifyRecord` 明文 payload / 明文私有文件"两种默认方案：那只是"能存"，不是"安全存"。
- **必须先调查（P1 前置，不写产品代码）**，且结论逐条标"已证/未知"：
  1. 是否存在**其它 credentials provider**（平台密钥库/封装）可用；本快照里只见到 `credentials-local`。
  2. `records` 能否只当 **ciphertext carrier**：由本插件自己加密后再写入（key 从哪来？平台密钥库 / 用户口令 / 宿主能力），
     —— 若 key 只能与密文同放一处，等于没有加密，必须明确说"不构成保护"。
  3. 平台安全封装是否可达：Electron `safeStorage` / Windows DPAPI / Android Keystore（含 DSHA 是否暴露）。
     只以**当前运行 Host 的实际执行模式**取证，不拿别的二进制冒充。
- **调查出能力缺口时给替代方案（由父决定何时告知用户）**，例如：不落盘长期票、只在会话内存活（放弃"跨重启"关口）、
  要求用户每次扫码、或仅在具备平台封装的环境开启持久化并明确降级。**不由我**把工程取舍直接抛给用户。
- **不擅自改 DSH 本体**（不 patch 宿主、不注入 provider）。

#### 5.2.1 必须显式设计的 profile / 插件实例隔离（r3 新增，§3.3 的缺陷）

`$DSH_HOME/.credentials.yaml` 是**全局一份**，records 键没有所有权语义。因此：

1. **不得**直接使用 `credentialKey('usage-dock','mimo-account')` 这类"看起来带 scope"的固定键当作隔离依据。
2. 存储记录必须自带**归属字段**并在读取时校验：至少 `{ profileId, pluginInstanceId, schemaVersion }`，
   与当前上下文不匹配的记录一律**视为他人数据**（不读用、不覆盖、不删除）。
3. `profileId` 的取值来源必须来自**该 profile 自己的配置/目录标识**（桌面 Host 的 `cwd` 就是 profile 目录，可据此派生不可逆短哈希），
   **不能**假设 `DSH_HOME` 或 `scope` 名字能区分 profile。
4. `pluginInstanceId` 建议由**该 profile 配置里的一个持久随机值**提供（首次写入时生成），这样"同一 profile 重装/重载"能续用，
   而"另一个 profile"天然拿不到。
5. 并发语义按"同键多写者"设计：写入前重读 → 校验归属 → 原子写；**冲突时失败并如实报告**，不静默覆盖；
   注销只删**自己那份**（归属匹配）记录。
6. 若上述任一环无法在目标宿主证明，则**不得**启用持久化（退回"不落盘"路线），而不是用固定键先跑起来。

#### 5.2.2 Windows DPAPI 合成探针（已跑；**只证 API 可用**）

脚本：`.diagnostics/mimo-qr-20261025/probe-dpapi.synthetic.ps1`（PowerShell 7.6.7，全程内存、随机合成数据、无文件读写、无系统设置改动）。
结果（`probe-dpapi.synthetic.result.json`）：`apiAssemblyLoaded=true`、`apiCallable=true`、`roundtripOk=true`、
`wrongEntropyRejected=true`（错误 entropy 被 `CryptographicException` 拒绝）、`emptyEntropyRoundtrip=true`、`cipherBytes=262`（仅计数）。

**它证明**：本机 OS/DPAPI（`CurrentUser` scope）在这些 API 形态下可用，且密文与 entropy 绑定。
**它不证明**：① DSH Host 有任何 DPAPI 适配/集成；② Node（更别说 Electron Node 模式子进程）能直接调 DPAPI（Node 无内置 DPAPI，
`safeStorage` 是否可达需 Electron 面探针，见 §5.7 关口 0 的 (e)）；③ Android/Keystore 有任何等价能力。
→ 因此 DPAPI 只能作为"**若**决定做平台封装，则 Windows 侧存在可用原语"的一块证据，不构成 P1 的存储方案批准，也不得把测试样本当真实票据保存。
- **无条件拒绝项**：写 `mimoCookie` 配置字段传播换票；写 `localStorage`/`window`；写日志/诊断 JSON/Git；写二维码或轮询票据；
  "明文 + 自定义加盐混淆"冒充加密。

### 5.3 授权通信（**所有认证相关端点一视同仁**）

- 适用范围**包括纯 GET 状态查询与二维码资源**：报名、轮询状态、二维码图、取消、注销、已连接状态 —— 全部属于高敏登录能力资源。
- **默认（且只推荐）`connection.fetch.register`**：owner 检查在它内部（`peer.principal.kind !== "owner"` → 403）。
- ⚠️ **不要把"调用了 `requestRejection`"当成 owner 证明**：`admit()` 会接受 **API operator**，那类请求 `requestRejection` **不返回拒绝**（§3.2、
  父已独立复核 `:737-749` 与 `:826-831`）。只做 `requestRejection` 的 exact 路由 = **对远端 API 客户端敞开**。
- **只有在确实无法用 `fetch.register` 时**才考虑 exact 路由，且必须**同时**满足两个条件：
  ① `connection.requestRejection(req)` 不返回拒绝（围栏 + 会话有效）；**并且**
  ② 自行取得 admission 并断言 `peer.principal.kind === 'owner'`，否则 403；
  两条都需在**当前运行 Host** 实测；**缺任一条就不得注册该路由**（不存在"只做 ①"的安全版本）。
- **两者都不可用 → 认证功能整体 `auth-channel-unavailable`**，不裸开任何认证路由（含 GET）。
- 所有认证响应一律 `cache-control: no-store`（含状态/二维码/错误），不写 `ETag`、不允许被缓存或进 bfcache 复用。
- **不要把 `connection` 加进 `inject`**（`index.js:81` 现在是 `['webServer']`）：在缺该服务的宿主上会让整个插件激活失败。
  用 `ctx.get('connection')` 可选读取（与 `ctx.get('shell')`/`configEditor` 同一模式）。

### 5.4 精确域、跳转与 `Set-Cookie`

- 自建 MiMo 专用 HTTP（不碰 `curlJson`）。
- **受信跳转**：SSO 可能需要跨域跳转，因此**不是"一律拒绝"**，而是**预先批准的精确每跳白名单**：
  每一跳都以 `(scheme, host, port, path 前缀)` 精确匹配既有清单；**未在清单里的 hop → fail-closed（立即失败并记录）**；
  **不允许"先跟随、再从结果倒推白名单"**。
- **Cookie 按来源收、按目标域发**：接收时以**该跳响应的实际 authority** 为来源域吸收 `Set-Cookie`；
  发送时只挑与**本次目标**的域/路径/`Secure` 属性匹配的 Cookie。账号域票**绝不**发往 `platform.xiaomimimo.com`，平台票**绝不**发往账号域。
  同名多票按 `(domain, path, name)` 分槽；host-only 与 `Domain` 明确区分。
- 读取 `Set-Cookie`：优先 `res.headers.getSetCookie()`（**仅在当前运行 Host 证明存在后**）；
  若不存在，改用 MiMo 专用 `node:https` 的 `res.rawHeaders`（同名字段**多值逐条**取）。**任何情况下都不按逗号拆分。**
- 正确处理 `Path` / `Secure` / `HttpOnly` / `Max-Age` / `Expires` / 删除标记；**不编造 7 天/30 天有效期**，
  只信服务端字段；未知时用"实际认证状态"驱动刷新，并把"未知过期"如实显示。
- 具体官方路径不在本报告里固化（本轮未实测、外部参考亦未核）；P1 关口 1 观测到的真实跳转与 Cookie 才会进入白名单。

### 5.5 取消 / 预算 / single-flight
- 单活跃扫码会话；`sessionId` 一次性；过期时间取服务端字段，缺则本地硬上限（建议 5 分钟）并在 UI 显示剩余。
- 取消/超时/卸载/注销：`AbortController` + `ctx.effect` disposer 清理定时器与长轮询；**注销后旧任务不得写回任何令牌**（代次校验）。
- single-flight 只在 MiMo 内部，且**共享请求的根 signal 不得并入任何单个消费者的取消**：
  每个消费者只取消**它自己等待的那一段**（本地 `Promise.race` + 自己的 signal/超时）；
  共享根只由**最后一个消费者离开**、插件卸载、注销、停用等策略中止。
  （即：不能用 `AbortSignal.any([root, consumerA])` 之类把 A 的取消传播到共享请求根 —— 那会误杀 B。）
- 预算：余额请求 ≤10s；401/403（或已确认业务鉴权码）**至多一次**换票 + **一次**重试；429/5xx 有上限的指数退避；网络错误与鉴权失败分类不同。
- 每次扫码/注销/切账号推进认证代次；迟到回执一律按代次丢弃。

### 5.6 最小凭据与日志投影
- 只保存 P1 证明**必要且可恢复**的字段（`passToken` 等）+ 平台票与其服务端过期时间；逐字段只报"存在/不存在"。
- 不保存：二维码内容/图片、轮询 URL、一次性登录 URL、响应全文、整段 Cookie 串、`cuserId/deviceId` 等未证明必要的字段。
- 日志投影白名单：`{state, hasAccountToken:boolean, hasPlatformToken:boolean, platformTokenExp, balanceCompare:'PASS'|'FAIL'|'UNKNOWN', errorCode}`；
  令牌指纹只允许"本地盐 HMAC 短哈希"，**不打印任何前后缀片段**；不把任何令牌写进异常消息。

### 5.7 五个关口（关口 0 是新增的前置，四关仍各自独立验收）
0. **宿主能力探针（零外部网络）** —— 脚本已交付：`.diagnostics/mimo-qr-20261025/runtime-probe.mjs`
   （`--mode=` 由调用方声明执行模式、`--out=` 可落 JSON；只起 `127.0.0.1:0` 临时 fixture，跑完 `closeAllConnections()` + `close()` 并显式退出；
   不访问任何真实 API/服务/配置，不读环境变量内容，不打印可执行路径与 Cookie 值，输出只有布尔/计数 + 版本号）。
   断言项：
   (a) `fetch` 与 `Headers.prototype.getSetCookie` 是否存在、逐条数是否等于 fixture 的 3 条；
   (b) `node:http` 的 `res.rawHeaders` 是否给出 **3 条** `set-cookie`（与 `node:https` 共用同一 HTTP 解析器；**本轮不建 TLS fixture**，
       因此该项只证"解析器/rawHeaders 机制"，不证 TLS 链路本身）；
   (c) `AbortSignal.timeout` / `AbortSignal.any` 是否存在；
   (d) **消费者取消隔离**：A 取消后 B 仍拿到结果、共享根仍存活；并有**反例对照**证明 `AbortSignal.any([root, consumer])` 会连根中止；
   (e) Electron 面：能否拿到 API 对象、`safeStorage` 是否存在（仅 Electron 模式有意义，只输出布尔）。

   **本轮实测（系统 Node，不是宿主编译）**：node `24.14.0` / undici `7.21.0` →
   `getSetCookiePresent=true`、`getSetCookieCount=3`（fixture 恰 3 条）、`rawSetCookieCount=3`、
   `timeoutPresent=true`、`anyPresent=true`、`consumerCancelRejectedOnlyItself=true`、`otherConsumerStillResolved=true`、
   `sharedRootStillAlive=true`、`anyCompositeAbortsWithConsumer=true`（反例成立）、`electronRuntime=false`。
   两次运行均 `exit 0`，退出后无残留监听端口。结果：`runtime-probe.system-node.json` / `.log`。

   **仍需父在"确认的捆绑 Electron Node 模式"下再跑一次**（建议 `--mode=electron-node-mode-source-reader`），
   但**无论结果如何都不是运行中 Host 的证明**：
   - `ELECTRON_RUN_AS_NODE`＝桌面 Electron 的 Node 模式 ≠ 运行中的 DSH Host（env/argv/cwd/入口都不同）；
   - Termux `node` ≠ Android DSHA Host；
   - **当前运行 Host 进程里 `fetch` 是否被覆写、`getSetCookie` 是否存在**，仍需另一条取证路径（Host 侧一次性探针或插件只读诊断通道；本轮不做）。
1. **扫码**：官方二维码可显示、用户在官方支持方式下确认、Host 取得**可恢复**的账号态（只报字段存在性）。
2. **余额**：该平台会话真实调用 `GET /api/v1/balance`，用户在本机对照官网总额/现金/赠送/币种（只记 `PASS/FAIL`）。
3. **跨进程恢复**：关闭并重启测试进程，**仅**从安全存储恢复后再次余额成功（"文件存在"不算）。
4. **续期**：不注销、不撤销真实账号，非破坏性证明短期票不可用而长期票可用时可换票，余额最多重试一次后恢复。

每一关单独记录证据；扫码成功 ≠ 余额成功 ≠ 可恢复 ≠ 可续期。

### 5.8 P1 明确不做
不做浏览器/CDP/Playwright/Puppeteer、不读浏览器或其它插件认证文件、不做 Token Plan 套餐、不做 MiMo 模型代理、不加 Python/curl 依赖、
不改全局请求后端、不改其它渠道缓存/轮询、不写 `passToken` 明文到 config/日志/诊断、不为求快开裸路由。

---

## 6. 最小离线基线（4 脚本，全部 exit 0）

| 脚本 | exit | 通过 | 失败 | SKIP | 日志 |
|---|---|---|---|---|---|
| `tools/test-mimo-parse.mjs` | 0 | 21 | 0 | 0 | `.diagnostics/mimo-qr-20261025/baseline/test-mimo-parse.log` |
| `tools/test-settings.mjs` | 0 | 6 | 0 | 0 | `…/baseline/test-settings.log` |
| `tools/test-degrade-refresh.mjs` | 0 | 43 | 0 | 0 | `…/baseline/test-degrade-refresh.log` |
| `tools/test-android-compat.mjs` | 0 | 14 | 0 | 0 | `…/baseline/test-android-compat.log` |

合计 **84 项通过、0 失败、0 SKIP**（依赖齐全：仓库 `node_modules/@deepseek-ai/schemastery` 等已在，本轮**未安装任何依赖**）。
环境：Windows，系统 `node v24.14.0`。**父已确认无需复跑**（此处仅留档，不构成新的验收动作）。

**明确未跑**（按指示）：
- `tools/test-fetch-backends.mjs`（含 T4/T5 真实联网，本轮不跑）；
- 42 / 456 项大套件（WorkBuddy 已验收，不再复跑）；
- 任何会写真实配置/profile/安装副本的脚本。

---

## 7. 未知项与待决事项

> 分工原则（按父指示）：**工程取舍由父裁定**，不把 D2/D3/D4 之类抛给用户；只有"产品体验/真实账号授权"这类必须由用户本人表态的才列用户。

### 7.1 未知项（待父给新证据）

| 编号 | 事项 | 现状 |
|---|---|---|
| U1 | **当前运行 Host 进程内**的运行时事实（`fetch` 是否被覆写、`getSetCookie`、`rawHeaders` 多值、`credentials` 实际 provider） | SDK 层已解决：当前安装 `0.2.1-rc.3` 的公开源已由父导出并逐文件比对（§3.0）。**仍未解决的是"运行中进程"**——Electron Node 模式探针即便通过也只代表该模式；本会话不可执行该二进制 |
| U2 | Android/DSHA 是否有 `credentials` / `connection`，以及是否有 Keystore 级封装 | **未知**（项目文档只确证无 shell/账号/`configEditor`） |
| U3 | `connection.fetch.register` 的稳定性承诺 | 在 **`0.2.1-rc.3`** 存在且被官方 inspector 使用；**无公开稳定性声明** |
| U4 | 是否存在**其它 credentials provider**，或 record 能否作为**自加密密文载体** | **未调查**（§3.3 的明文结论只覆盖 `credentials-local`） |
| U5 | 宿主是否提供任何 **profile / 插件实例级**的命名空间隔离 | **已证：`credentials-local` 没有**（文件名只由 `DSH_HOME` 决定，键只做语法校验）；是否另有可用机制**未知** → 需按 §5.2.1 自行设计归属字段 |
| U6 | 运行中 Host 的 `fetch` 是否被宿主/其它插件覆写 | **未知**；同二进制/启动器只是静态证据（§2） |
| U7 | Node/Electron-Node 侧能否触达平台加密（`safeStorage` / DPAPI） | **未知**；Windows DPAPI 的 **PowerShell** 可用性已实测（§5.2.2），但 Node 无内置 DPAPI，`safeStorage` 需在 Electron 面探针（`runtime-probe.mjs` 的 (e) 项） |

### 7.2 待父裁定（工程取舍，不建议直接问用户）

| 编号 | 事项 | 我方建议 |
|---|---|---|
| E1 | 安全存储路线（平台封装优先 / 自加密密文进 record / 不落盘只保会话 / 放弃跨重启关口） | 先按 §5.2 做完能力调查再定；缺口给替代方案，由父决定何时告知用户 |
| E2 | 认证通道选型 | **默认只用 `connection.fetch.register`**（owner 检查在其内部）；`requestRejection` 单独使用**不构成** owner 证明，exact 方案必须额外断言 `principal.kind === 'owner'`，两者都实测才可采纳 |
| E3 | MiMo 是否进 `ACCOUNT_BOUND_PLAN_IDS` | 建议进（凭据不再能被配置哈希证明） |
| E4 | PoC 目录与是否入库 | `tools/poc/mimo-auth/`（`files` 不含 tools/） |
| E5 | 外部参考源码/许可证 | 父并行复核：GitHub API repo 元数据与 PyPI `xiaomi-mimo` JSON 两次 `web_fetch` 均被"域名解析为非公网地址"拒绝，`reference/` 无 mimo/qr-login 缓存 → **仍未核**；本轮不声称已查、不复用、仓库内 **0 行第三方代码** |
| E6 | P1 方案的评审路径 | 按主规划**第 11 节评审闸门**；本文档**不是**获批 |

### 7.3 需用户本人表态（仅这两项）

| 编号 | 事项 | 现状 |
|---|---|---|
| D6 | 扫码 UI 落点与"单设备无法自扫"的体验取舍 | 规划 §7 已有要求；P3 才实现，届时由父决定何时问 |
| D7 | **真实账号测试授权** | **尚未取得**；取得前不扫码、不向真实平台发任何认证请求 |

---

## 8. 本轮可复现性

- **当前权威 SDK 证据**：`.diagnostics/mimo-qr-20261025/sdk-current-parent/`（父只读导出，`0.2.1-rc.3`，19 SDK 文件 + `app-main-entry.js` + `app-package.json` + `PROVENANCE.json`）。
- 旧快照（仅用于 §3.0 比对）：`.diagnostics/mimo-qr-20261025/sdk/`（14 个 `0.2.1-rc.2` 副本 + `PROVENANCE.json`，复制件与原件双份 SHA-256）。第三方插件代码**未复制**。
- 基线日志与摘要：`.diagnostics/mimo-qr-20261025/baseline/`（4 个 `.log` + `summary.json`）。
- **运行时能力探针**：`runtime-probe.mjs` + `runtime-probe.system-node.json` / `.log`（系统 Node 24.14.0；待父在 Electron Node 模式复跑）。
- **DPAPI 合成探针**：`probe-dpapi.synthetic.ps1` + `.result.json` / `.log`（PowerShell 7.6.7；仅内存、随机数据）。
- 全部产物**不含任何凭据、令牌、Cookie、entropy、私有路径或真实 profile 内容**（本轮完全未接触）。
