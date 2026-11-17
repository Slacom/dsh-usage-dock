# 0.11.0 合入记录：DSH Go 原生适配包 → dsh-usage-dock

> 2026-11-16。本文记录 **DSH Go（手机 App）原生适配包**合入本仓库的过程与取舍，供接手者核对
> 「哪些文件来自适配包、哪些是本仓库 0.10.6 的既有内容、哪些还没验证」。
>
> - 适配包（下称 **src**）：`.diagnostics/dshgo-20261116/unpacked/dsh-usage-dock`，
>   基于 0.10.5 的完整插件包，由 DSH Go 侧完成原生界面适配。
> - 干净 0.10.5 检出（下称 **base**）：`.diagnostics/dshgo-20261116/base`。
> - 本仓库工作区 = 0.10.6（未单独发布，内容随 0.11.0）+ 0.11.0 合入内容；版本号 **0.11.0**，
>   已于 2026-11-17 发布（tag `v0.11.0` / commit `c54e0ea` / npm `dsh-usage-dock@0.11.0`）。
> - 设计/实现/真机验证细节见 [dsh-go-native-panel.md](dsh-go-native-panel.md)。

## 1. 适配包结构总览

### 1.1 清单（`package.json`）

`dsh`（Web 半）与新增的 `dshGo`（原生半）并存，互不影响：

| 字段 | 内容 |
| --- | --- |
| `dshGo.v` | `1` |
| `dshGo.title` | `{ zh: "额度", en: "Usage" }` |
| `dshGo.icon` | `"wallet"`（App 内置图标名） |
| `dshGo.contributes["composer.strip"]` | 1 条：`{ id: "strip", icon: "wallet", panel: "quota" }` |
| `dshGo.contributes.panels` | 3 个：`quota`（`session.tab` + `features`，`presentation: "sheet"`）、`settings`（`plugin`）、`mimo-login`（`plugin`） |
| 顶层 `icon` | `"./icon.svg"`（桌面 Cordis 插件同款约定） |
| `files` | 增加 `"icon.svg"` |

### 1.2 新增模块

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `plans/dsh-go-native.js` | 1701 → **1767**（终审整改后） | 原生半全部纯逻辑：三个面板的静态视图骨架 / 数据投影 / 失败回退 / 复制摘要 / 原生设置页 / MiMo 扫码登录面板 / `ctx.dshGo.panel()` 注册 |
| `plans/strip.js` | 236 | `composer.strip` 纯函数：会话路由事件解析（latest wins）、provider → 渠道映射、≤24 字文本模板、tone / 隐藏规则；不读网络、不读磁盘 |
| `plans/mimo-legacy-store.js` | 146 | MiMo legacy 扫码登录凭据：平台 4 个 cookie 的白名单提取 / 记录年龄 / `ctx.credentials` 存储 / 重启后重放余额接口（纯逻辑 + 可注入 fetch） |

### 1.3 改动文件（base → src 的 diff 统计）

| 文件 | 增 / 删 | 说明 |
| --- | --- | --- |
| `index.js` | +674 / −5 | 注册原生面板（`registerDshGoSurface`）、`loadConfig` / `collect`、strip 订阅与 30 秒缓存、MiMo legacy 恢复、额度策略定期刷新桥接、`dshGoBridgeSeen` 判定 |
| `package.json` | +55 / −0 | 见 §1.1 |
| `plans/mimo-auth/host.js` | +91 / −3 | 官方接口变化兼容 + MiMo 登录持久化接线 |
| `plans/mimo-auth/session.js` | +15 / −5 | 同上 |
| `plans/mimo-auth/failure.js` | +37 / −0 | 失败诊断固定枚举 |
| `plans/mimo-auth/vendor/memory-flow.js` | +119 / −22 | CookieJar `allowQuotedValues`、官方子域放宽、非法 Set-Cookie 行忽略、GET 单次重试、诊断枚举 |
| `tools/test-mimo-usage-lane.mjs` | +7 / −3 | 配合 legacy 余额投影的既有测试调整 |

### 1.4 资产

| 文件 | 说明 |
| --- | --- |
| `icon.svg`（636 B） | 桌面插件入口 / 设置主页图标，36×36，Material Symbols `wallet` 风格，`currentColor` |
| `icon-outline.svg`（453 B） | 描边备选（更接近手机胶囊观感） |
| `preview.png`（49 464 B） | 图标预览截图 |
| `WALLET-ICON.md`（根目录） | 图标来源说明（App 内置图标名 vs 桌面素材） |
| `docs/capsule-wallet-icon.md` | 胶囊钱包图标详细说明 |
| `docs/assets/wallet/**` | `NOTICE.md`、`preview.html`、3 个 svg（Material Symbols / Lucide / 自绘描边） |

> 手机胶囊上的钱包图是 **App 内置图标名** `wallet`，插件包不含该图形；上面这些是给**桌面端**
> 复用的视觉近似素材，不是从 App 提取的原始矢量（手机端没有 APK 可提取）。

### 1.5 文档与测试

| 文件 | 内容 |
| --- | --- |
| `docs/dsh-go-native-panel.md`（221 行） | 原生面板设计 / 实现 / 真机验证 / 限制（含原生设置页、MiMo 登录、strip 章节） |
| `docs/backlog.md` | 新增「进展（0.11.0 / 2026-11-14～16）」小节 |
| `tools/test-dsh-go-native.mjs` | **40** 项离线契约：清单 / 视图 / 数据 / 动作 / 设置页 / MiMo 登录 / strip 注册 / 无桥接回归 |
| `tools/test-dsh-go-boundaries.mjs`（终审整改新增） | **47** 项：启用与桥接闸门 / 来源身份隔离 / 永久失败清值 / 定时器生命周期 / 原生 collect 身份采样前固化与采样后复核（E1–E3）/ legacy 余额选择顺序（F1–F9） |
| `tools/test-dsh-go-strip.mjs` | **17** 项 strip 纯函数：路由事件 / provider 映射 / 文本 / 截断 / 隐藏 |
| `tools/test-mimo-legacy-store.mjs` | **12** 项：cookie 白名单 / 记录年龄 / 重放成功与失败枚举 / 非法 cookie 零请求 / 稳定采样时间 |

> 括号里是**终审整改后**的计数；适配包刚合入时分别是 37 / 17 / 11（无 boundaries 套件）。

## 2. 本次合入取舍

### 2.1 以 src 的 `index.js` 为底

src 的 `index.js` 已包含原生半的全部代码（基于 0.10.5）。本仓库 0.10.6 只改了其中的
`codex-subscription/patch-state` 路由，因此在 src 版本上**补回 0.10.6 的两处增量**：

- `GET /api/plan-usage/codex-subscription/patch-state` 的只读字段 `manifestVersion`
  （与已装版本精确匹配的清单版本）与 `covered`（本包所有合法清单版本号、升序、纯版本号）；
- `plans/codex-subscription-patch.js` 的 `coveredVersions()`：旧版模块（混合部署）没有该函数时
  退化为空数组，不让路由整体失败；路由返回处对 `state.manifestVersion === undefined` 兜底为 `null`。

### 2.2 保留本仓库 0.10.6 的 `client.js`

**src 的 `client.js` 就是 0.10.5 原样**（base → src 的 `git diff --name-status` 里 `client.js`
没有变化，521 947 字节与 0.10.5 一致）。本仓库 0.10.6 的 `client.js`（`patch-state` 三态 /
`covered` / `manifestVersion` 展示与两种 unsupported 文案）**必须保留**，不能用 src 覆盖。

### 2.3 保留 0.10.6 的 Codex 补丁内容

- `plans/codex-subscription-patch.js`：0.10.6 版本（`inheritFrom` 继承链、深度上限按递归路径累计、
  无 memo 缓存）。
- `plans/patches/codex-subscription-3.2.17.json`：0.10.6 新增，src 里没有（src 只有 3.2.6 / 3.2.13）。
- `tools/test-patch-codex-subscription.mjs`、`tools/test-codex-patch-ui.mjs`、`tools/test-codex-source-ui.mjs`
  等 0.10.6 测试与 `tools/test-mimo-usage-lane.mjs` 的 0.10.6 增量一并保留。

### 2.4 `plans/mimo-auth/**` 采用 src 版本

官方接口变化兼容（官方子域、quoted cookie、非法 `Set-Cookie` 行忽略、JSON number `userId`、
GET 单次重试、固定枚举诊断）与 MiMo 登录持久化的接线都在 src 版本里，直接采用；网页版同样受益。

### 2.5 新增文件直接取 src、`package.json` 叠加

`plans/dsh-go-native.js`、`plans/strip.js`、`plans/mimo-legacy-store.js`、三个新测试、图标与文档
均按 src 逐字合入；`package.json` 以 0.10.6 为底叠加 `icon` / `files: ["icon.svg"]` / `dshGo` 清单，
版本号 0.11.0。

### 2.6 合入前备份

`.diagnostics/dshgo-20261116/merge-backup/` 留有合入前的本仓库版本：
`index.js.worktree-0.10.6`、`package.json.worktree-0.10.6`、
`test-mimo-usage-lane.mjs.worktree-0.10.6`、`index.js.0.10.6.diff`（0.10.6 相对 base 的增量 diff）。

## 3. 测试与验证记录

### 3.1 适配包侧（2026-11-14～16，src 内实跑；整改前计数）

- `node tools/test-dsh-go-native.mjs` → **37 项通过**（Host 半契约，非 App 真机渲染；整改后 40 项）。
- `node tools/test-dsh-go-strip.mjs` → **17 项通过**（整改后仍 17）。
- `node tools/test-mimo-legacy-store.mjs` → **11 项通过**（整改后 12 项）。
- 官方插件检查器 `check.mjs . --load` 通过：`quota` 面板 `session.tab` / `features` 的 zh-CN 与 en-US
  视图均可显示（约 2196 / 2201 字节、27 组件、0 issue），面板注册显示 `ready:true / live:true`。
- MiMo 登录持久化**真机验证**（2026-11-16）：扫码登录成功写入记录（4 个平台 cookie，余额 14.58 CNY）；
  重启引擎后未再扫码，`restore-attempt` 重放余额接口成功，额度面板直接显示余额。
- 文档明写：**原生面板不是真机渲染验证**——视图结构只由官方检查器的 App 解析器副本验证过，
  尚未在 App 里实际打开看过。

### 3.2 适配包记录的回归面

`test-android-compat` 14、`test-usage-tool` 108、`test-usage-tool-register` 70、`test-usage-tool-host` 41、
`test-usage-policy` 89、`test-usage-integration` 31、`test-host-custom` 31、`test-config-unwrap` 22、
`test-footer-row` 12、`test-collapsed-pill` 4、`test-degrade-refresh` 44、`test-line-endings` 71 全部通过。
（以上是**适配包内的记录**，不是本仓库合入后工作区的实跑结果。）

### 3.3 本仓库合入后（工作区，终审整改后主代理实跑）

- 新增/更新的 DSH Go 套件：`test-dsh-go-native` **40/40**、`test-dsh-go-boundaries` **47/47**（终审整改新增，
  含第二轮 E1–E3 / F1–F9）、`test-dsh-go-strip` **17/17**、`test-mimo-legacy-store` **12/12**。
- 关键回归（主代理实跑全绿）：`test-patch-codex-subscription` **49/0**、`test-codex-patch-ui` **35**、
  `test-codex-source-ui` **91**、`test-android-compat` **14**、`test-usage-tool` **108**、
  `test-footer-row` **12**、`test-line-endings` **71**。
- 行尾：文档代理改动/复制的全部文件保持 **LF**，`node tools/test-line-endings.mjs` 全绿（71/71）。
- **未真机复核**（整改后）：`composer.strip` 的观感（单行文本、空白被折叠，数值只能跟在名字后）；
  原生设置页 / 额度面板的视觉观感；MiMo provider id 是否进 `ROUTE_TABLE`（当前手机 profile 没有
  MiMo 模型路由，手机端 MiMo 暂不出 strip）。真机验证记录仍是整改前的两项
  （2026-11-16 MiMo 登录持久化、官方 `check --load`），**整改后未再上真机**。

## 4. 合入后整改（终审三轮）

> 终审（GPT-6.1-Sol Max）共**三轮**：首轮不通过（5 类）、第二轮不通过（2 项），整改后
> **第三轮定向复审通过（定向范围）**：
> - **首轮不通过（5 类问题）**：原生半在「Web/桌面行为不变」这条承诺上存在真实缺口，且 strip /
>   原生面板的旧值复用与定时器生命周期有问题 —— 整改见下面 1–5。
> - **第二轮不通过（2 项）**：① 原生 collect 的**身份事后贴标**（fetch 之后才算身份，采样期间换来源
>   会让旧 wire 带上新身份并被下一轮 carry）；② **过期 done 短路**重放结果（legacy 余额选择里 stale
>   done 提前 return，挡住已重放成功的新记录余额）—— 整改见下面 6–7。
> - **第三轮定向复审：通过（定向范围）**——E（collect 身份采样前固化 / 采样后复核）与
>   F（`pickLegacyBalanceView` 顺序、过期 done 不短路）两项阻断均已闭合，未发现新阻断；
>   复审还额外验证「身份稳定后能自愈（29% 再 carry）」「记录缓存再次过期会重新重放」
>   「恰好 5 分钟仍新鲜、+1ms 重放」。
> - **验收边界**：这是**离线代码与定向行为复审通过**，**不等同**手机真机、原生视觉或发布验收。
>
> 前两轮整改由两个实现代理完成，`tools/test-dsh-go-boundaries.mjs` 扩充至 **47** 项守门。

1. **启用 / 桥接闸门（此前 Web/桌面行为并不真正不变）**
   - MiMo legacy「记住登录」的保存与恢复统一要求四层闸门：`dshGo 桥存在 && enabled !== false &&
     mimoEnabled !== false && mimoRememberLogin !== false`；触发时桥未就绪直接返回、**不排队**；
     `app-boot/config-reload` 与原生设置页保存都会推进 legacy 代次、作废在途状态与旧值
     （`invalidateLegacyMimoState()`），停用后不会闪回旧余额。
   - `composer.strip`：总开关 / 渠道开关停用时**不调 provider、不显示旧值**——在读缓存/投影前与
     调用取数前各判一次闸门；配置重载窗口内同步遮蔽（`stripConfigPending`）并清缓存。
2. **来源身份隔离与「永久失败不显示旧值」（carry 跨来源）**
   - strip 缓存/在途 key = `channelId|identityOfChannel(id)`（Codex 含 `codexSource`，自定义含
     provider / 端点 / 修订号）；**永久失败清旧值**，只有**同一身份**下的暂时失败才 carry 并标 `stale`。
   - 原生面板 carry 同规则 `${channelId}|identity`，缺身份**不复用**；Host 为每条原生 wire
     （含 error wire）附不可逆 `identity`（不含路径 / 凭据 / 上游原文）。
3. **策略刷新定时器生命周期**：刷新循环与插件作用域**无条件**绑定清理（不再依赖 `usage_status`
   注册成功分支）；桥退出即停循环；tick 在各 `await` 前后复检 `applyDisposed` / 桥状态 /
   开关，卸载或桥退出后的迟到结果不再发布。
4. **原生设置页：策略开关此前没有 `onChange`**：控件定义里的 `onChange` 未被透传 ⇒ 6 个策略
   toggle 全无绑定（切换既不即时保存、条件字段也不展开，与文档宣称不符）。现补透传 +
   `policyToggle` 动作；且 `policyToggle` **只增删本次切换的目标渠道**，保留其它关注项
   （含 `codex` / `mimo` 等其它内置渠道、`custom:*` 与未知 id）——旧实现用「当前视图渲染的关注项」
   当全集重写，切一次 DeepSeek 会静默删掉 codex / mimo。
5. **MiMo legacy 一次性余额「伪刷新」**：`legacyDoneBalance()` 以前每次 peek 都用 `Date.now()`
   伪造采样时间，等于永远「刚刚拿到」。现改为返回**真正拿到余额那一刻**的稳定 `fetchedAt`
   （多次 peek 不变）；宿主侧超过 **5 分钟**或缺稳定时间戳时不再当 fresh。
6. **原生 collect 身份采样前固化 / 采样后复核（第二轮，E1–E3）**：collect 取数**前**先固化每个渠道的
   `identityOfChannel(id)`，采样结束后用**同一时刻的期望值**复核；期间身份漂移（改 Codex 来源 /
   自定义端点或 Key 修订）的旧 wire **不带 identity**，原生面板按「缺身份不复用」处理——
   下一轮暂时失败**不会 carry 旧百分比**，且第二轮会重新采样（E3 断言 provider 调用 2 次）。
7. **legacy 余额选择顺序（第二轮，F1–F9，`pickLegacyBalanceView`）**：统一为「done 新鲜优先 →
   record 新鲜 → 都不新鲜才限频重放」；**过期 done 只失去优先权、不短路**已重放成功的新余额
   （F1/F7/F9：记录缓存的新余额 **19 CNY** 最终显示在原生额度面板；F2 对照：done 新鲜时优先 done；
   F3：都不新鲜返回 null 并请求一次重放；F4：缺 `fetchedAt` 同样不短路；F5/F6：运行时统一走该函数、
   旧短路已移除）。
8. **`test-dsh-go-boundaries.mjs`（47 项）**：覆盖前述闸门（无桥 / 停用 / 关 remember 零凭据零请求）、
   身份隔离（换来源不复用、永久失败清值）、定时器清理与迟到结果丢弃，以及新增的 **E1–E3**
   （原生 collect 身份固化 / 漂移旧 wire 无 identity / 第二轮重采样）与 **F1–F9**（legacy 选择顺序、
   过期 done 不短路、端到端面板显示 19 CNY）。

## 5. 风险与未搬项（摘要）

- **发布与部署（2026-11-17）**：**已发布**——tag `v0.11.0`（commit `c54e0ea`，push `origin/main`）、
  GitHub Release id **448193666**（`make_latest: true`）、npm **`dsh-usage-dock@0.11.0`**
  （48 文件 / 533.1 kB，`dist.shasum` 前缀 `fe78c06c…`）；desktop profile 已部署
  （2026-11-16 备份 `.diagnostics/deploy-0.11.0-20261116/before`，`client.js` 于 2026-11-17 补部署），
  **仍需用户重启 DSH + 硬刷新完成运行时验证**——发布 ≠ 真机/视觉验收。
- **第三轮定向复审通过（定向范围），但不等同手机真机、原生视觉或发布验收**：复审只覆盖离线代码与
  定向行为（E/F 两项阻断闭合、未发现新阻断；额外验证自愈 / 再次过期重放 / 5 分钟边界）；
  前两轮整改后也**没有重新上手机验收**。「Web/桌面行为不变」在**启用闸门整改后**才成立
  （此前缺闸门），复审时仍应重点回归桌面端。
- `composer.strip` 尚未在真机确认观感。
- 原生面板未搬 Web 卡片细节：DeepSeek 峰谷条、充值入口、赠金明细、Codex `Subscription` 适配入口等。
- 面板打开期间与 Web GUI 可能各自请求一次（30 秒节奏，暂不共用缓存）；视图骨架在面板打开时生成，
  运行中改配置 / 排序后需重新打开面板才更新分块。
- MiMo 登录持久化的残余风险：`serviceToken` 实际有效期、设备/IP 绑定是否会失效未知，过期需重扫。
- MiMo「登录不可用（需要新版宿主）」与 Codex Subscription 版本 / 补丁问题仍按 `docs/backlog.md` §2
  单独处理，与本面板无耦合。

## 6. 下一步（待用户确认）

**桌面端设置页位置拟迁移**（尚未实现，等用户选择）：

- **方案 A（推荐，已实施）**：从「设置 → 内置插件 → Usage Dock」迁到**顶层设置分区**——
  用 `settings.section` + `settings.section.icon`（与「Codex 订阅」同款），图标采用**实心钱包**
  （Material Symbols `wallet`，**Apache-2.0**，取自仓库根 `icon.svg` 的 24 网格单条
  `<path fill="currentColor">`；`active` 只把 opacity 0.85→1、不改尺寸），入口更显眼、与其它功能设置同级。
- **方案 B**：两处都保留（顶层分区 + 内置插件列表各一个入口），迁移期最稳但入口重复。
- **方案 C**：改为插件详情内嵌（`plugins.bundle.config`），设置与插件介绍在同一页，位置最靠后。

> 方案 A 已实现（图标按用户选择为实心款）；B/C 未采用。候选对比（16/20/24 px × 浅/深色）保留在
> `docs/demos/settings-icon-preview.html` 供以后参考。

> 版本状态：**已发布**——tag **`v0.11.0`**（commit **`c54e0ea`**，push `origin/main`）、
> GitHub Release id **448193666**（`make_latest: true`）、npm **`dsh-usage-dock@0.11.0`**
> （48 文件 / 533.1 kB，`dist.shasum` 前缀 **`fe78c06c…`**；registry 初始约 2 分钟延迟后可用）。
> 此前已部署到 desktop profile（2026-11-16 备份 `.diagnostics/deploy-0.11.0-20261116/before`；
> `client.js` 于 2026-11-17 补部署），运行时验收仍需用户重启 DSH + 硬刷新确认。
