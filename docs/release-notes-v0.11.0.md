# dsh-usage-dock 0.11.0

> 0.11.0 的主线是**手机端 DSH Go 原生适配**：同一份插件包在 Web/桌面端行为不变的前提下，
> 额外提供原生额度面板、原生设置页、输入框上方额度条与 MiMo 登录持久化。
> 承接 0.10.6（本地构建、未单独发布）的 Codex `Subscription` 3.2.17 适配与设置页三态「需适配」。
> **上一公开版：0.10.5（GitHub Release + npm）**。

## 更新摘要（GitHub Release 正文）

- **手机端有了原生「额度」面板**：在对话详情「插件」页签或「全部功能」里打开，各家渠道的余额、
  额度窗口百分比与重置时间一屏看完，支持手动刷新与复制摘要；失败时保留上一次的数值并弱化提示。
- **手机端原生设置页**：额度面板底部新增「设置」，可直接改插件总开关、各渠道开关、Codex 额度来源、
  余额提醒阈值与额度策略阈值，不需要再回网页版。密钥、Cookie 与自定义余额仍留在网页版设置页。
- **输入框上方新增一行额度条**：只显示当前对话所用模型对应的那个渠道（如「OpenCode Go 96% 79% 90%」），
  点按即打开额度面板；拿不到当前渠道时自动隐藏，不猜不显示错的数据。
- **MiMo 扫码登录可以记住登录**：登录成功后重启引擎不用再扫码，余额自动恢复；设置页 MiMo 分组可随时
  关闭并清除这条记录。
- **修好手机端 MiMo 扫码登录在官方接口改版后的失败**：新的官方登录子域、带引号的 cookie、
  偶发的非法 Set-Cookie 行、用户 ID 变成数字、移动网络瞬时断连后重试，都已兼容；网页版登录同样受益。
- **Web / 桌面端行为不变**：侧栏胶囊、详情卡片、设置页与原来一致；本次只是新增原生半，
  不影响已有界面与数据口径。
- **桌面插件入口新增实心钱包图标**：插件管理 / 设置入口可识别出本插件；图标为 Material Symbols
  `wallet`（**Apache-2.0**，取自仓库根 `icon.svg` 的 24 网格路径），素材同时收录在仓库文档目录。

## 工程细节（维护者用）

- **清单**：`package.json` 新增 `dshGo`（v1；`title` 额度 / Usage、`icon: "wallet"`），与 Web 半 `dsh`
  并存。`contributes["composer.strip"]` 1 条（`{id:"strip", icon:"wallet", panel:"quota"}`）；
  `contributes.panels` 3 个：`quota`（`session.tab` + `features`，`presentation:"sheet"`）、
  `settings`（`plugin`）、`mimo-login`（`plugin`）。顶层 `"icon": "./icon.svg"`，`files` 增加 `icon.svg`。
- **原生面板（`plans/dsh-go-native.js`）**：视图 = 静态骨架 + `{"$":"data.channels.<key>.<field>"}` 绑定，
  App 收到新数据整棵求值、刷新不重建视图；预算约 2196 字节 / 27 组件 / 4 层（上限 32 KiB / 120 / 8）。
  数据走 `projectUsage` 白名单投影，不含 Key / URL / Cookie / 上游原文；面板打开才启动 30 秒 feed，
  关闭即取消；`ctx.dshGo.panel()` 注册。仅在有 `dshGo` 桥接的主机执行；无 `webServer` 的隔离宿主
  （官方检查器）注册完即返回，`check --load` 可加载校验。
- **原生设置页**：额度面板「设置」发 `{ open: "panel:settings" }`。按渠道分 6 组；「启用/关注额度策略」
  是 onChange 即时保存 + refresh 重建视图（终审整改前 `onChange` 未透传、6 个策略开关**没有绑定**，
  切换既不保存也不展开条件字段；现已补透传与 `policyToggle` 动作，且 `policyToggle` **只增删本次
  切换的目标渠道**，保留其它关注项含 `custom:*` 与未知 id，不再静默删掉 codex / mimo）。切换会重建
  表单、未保存编辑会丢；保存只提交当前视图实际渲染的字段；`quotaChannelThresholds` 按渠道合并；
  收尾必须小于预警。两列布局用 `grid columns: 2`（`row` 会被 160dp 最小宽压成一列、v2 `style.columns`
  在部分 App 版本不生效）。策略字段上限 32，Codex 只保留关注开关。
- **`composer.strip`**：`plans/strip.js` 纯函数 + `index.js` 订阅。订阅 `session/event` 三类事件
  **latest wins**（`model/selection` → `request/header` → `assistant/message`），首次/换会话用
  `snapshotEvents()` 回填最近 400 条，只按 `sessionId` 隔离；拿不到路由 `emit(null)` 隐藏；
  内置 provider 走 `ROUTE_TABLE` 精确匹配、自定义按条目 `provider` 精确匹配；文本 ≤24 字，
  单渠道 30 秒缓存 + single-flight，优先复用额度策略观察的投影。MiMo provider id 未进
  `ROUTE_TABLE`（待真机确认），手机端 MiMo 暂不出 strip。
- **MiMo 登录持久化（`plans/mimo-legacy-store.js`）**：`mimoRememberLogin`（默认开）扫码成功后把
  平台 4 个 cookie 交 `ctx.credentials`；重启重放 `GET https://platform.xiaomimimo.com/api/v1/balance`，
  200/code=0 恢复，401/403/结构异常删记录回落扫码。坑：登录结束 `jar.clear()`，cookie 必须在读余额时
  （`askBalanceMatch`）抓取；`serviceToken` 的 `Path` 可能为 `/api`，要用余额接口完整 URL 取 cookie。
- **mimo-auth 官方接口兼容**：`vendor/memory-flow.js` 的 CookieJar 开 `allowQuotedValues`、
  官方子域（`account.xiaomi.com` 及其子域）放宽域名/用途校验、非法 `Set-Cookie` 行按浏览器语义忽略
  （固定枚举诊断）、回执凭据字段允许严格引号、`userId` 允许 JSON number（安全非负整数转十进制字符串）、
  GET 单次重试（300ms）、网络失败点带固定枚举 `step + networkCode`。
- **启用闸门（终审整改，Web/桌面行为不变由此才真正成立）**：
  - MiMo legacy「记住登录」保存/恢复统一要求 `dshGo 桥存在 && enabled !== false && mimoEnabled !== false
    && mimoRememberLogin !== false`；桥未就绪直接返回、不排队；`app-boot/config-reload` 与原生设置页
    保存都会推进代次、作废在途状态与旧值（停用后不闪回旧余额）。
  - `composer.strip` 在总开关/渠道开关停用时**不调 provider、不显示旧值**：读缓存/投影前与调用取数前
    各判一次闸门，配置重载窗口内同步遮蔽（`stripConfigPending`）并清缓存。
- **来源身份隔离与「永久失败清旧值」**：strip 缓存/在途 key = `channelId|identityOfChannel(id)`
  （Codex 含 `codexSource`，自定义含 provider/端点/修订号）；永久失败清旧值，只有同一身份下的
  暂时失败才 carry 并标 `stale`。原生面板 carry 同规则 `${channelId}|identity`、缺身份不复用；
  Host 为每条原生 wire（含 error wire）附不可逆 `identity`（不含路径/凭据/上游原文）。
  **第二轮整改**：原生 collect 改为**采样前固化身份、采样后复核**——采样期间身份漂移的旧 wire
  不带 identity，下一轮暂时失败不再 carry 旧百分比，第二轮会重新采样（E1–E3）。
- **策略刷新定时器生命周期**：刷新循环与插件作用域无条件绑定清理（不再依赖 `usage_status` 注册成功
  分支）；桥退出即停循环；tick 在各 `await` 前后复检存活，卸载/桥退出后的迟到结果不再发布。
- **MiMo legacy 余额新鲜度**：`legacyDoneBalance()` 返回**稳定采样时间**（真正拿到余额那一刻，
  多次 peek 不变）；宿主侧超过 **5 分钟**或缺时间戳不再当 fresh。**第二轮整改**：新增
  `pickLegacyBalanceView` 统一选择顺序「done 新鲜优先 → record 新鲜 → 都不新鲜才限频重放」，
  **过期 done 只失去优先权、不短路**已重放成功的新余额（F1–F9：记录缓存的新余额 19 CNY 最终
  显示在原生额度面板，F9 为端到端断言）。
- **`index.js`**：适配包 base→src 为 +674 / −5；**终审整改后 base→当前工作区为 +1065 / −6**——
  `registerDshGoSurface`、`loadConfig` / `collect`、strip 订阅与缓存、MiMo legacy 恢复与闸门、
  额度策略定期刷新桥接（`dshGoBridgeSeen` 后才启动）、设置保存后的状态作废。
- **测试**：`test-dsh-go-native` **40**、`test-dsh-go-boundaries` **47**（终审整改新增：闸门/身份/
  定时器 + 第二轮 E1–E3 / F1–F9）、`test-dsh-go-strip` **17**、`test-mimo-legacy-store` **12**；
  主代理实跑全绿：`test-patch-codex-subscription` **49/0**、`test-codex-patch-ui` **35**、
  `test-codex-source-ui` **91**、`test-android-compat` **14**、`test-usage-tool` **108**、
  `test-footer-row` **12**、`test-line-endings` **71**。
- **未验证 / 未做**：**第三轮定向复审通过（定向范围）——GPT-6.1-Sol Max 判定 E（collect 身份采样前
  固化/采样后复核）与 F（`pickLegacyBalanceView` 顺序、过期 done 不短路）两项阻断闭合、未发现新阻断，
  并额外验证「身份稳定后能自愈（29% 再 carry）」「记录缓存再次过期会重新重放」「恰好 5 分钟仍新鲜、
  +1ms 重放」；但这是离线代码与定向行为复审通过，不等同手机真机、原生视觉或发布验收**；
  前两轮整改后未再上真机复核；`composer.strip` 尚未在真机确认观感（单行文本、空白被折叠，数值只能
  跟在名字后）；原生面板不是真机渲染验证（视图只由官方检查器的 App 解析器副本验证）；面板未搬 Web
  卡片细节（DeepSeek 峰谷条、充值入口、赠金明细、Codex `Subscription` 适配入口）；面板与 Web GUI
  可能各请求一次（不共用缓存）；运行中改配置/排序需重开面板才更新分块。MiMo / Codex 两条平台问题
  仍按 `docs/backlog.md` §2 单独处理。
- 版本状态：**0.11.0 为本地构建，已部署到 desktop profile**（2026-11-16，部署前备份
  `.diagnostics/deploy-0.11.0-20261116/before`），**待用户重启 DSH 验证**；未 git 提交、未发布。
  按 `AGENTS.md` §8 的推送闸门，用户真机确认后再 push / 打标签 / 发 Release / npm publish。
