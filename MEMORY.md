# 项目持久记忆：用户协作偏好

供本项目后续会话、接手主代理及子代理恢复协作规则；以用户最新明确指令和[项目规范](AGENTS.md)为准。这里不保存凭据、金额、认证URL或临时许可。

## 2026-11-12 14:36：**0.10.1 已发布**（第三方补丁工程化）

1. **发布物**：commit **`454b6e7`**、tag **`v0.10.1`**、GitHub Release id **`442567445`**（`/releases/latest` = v0.10.1）；
   npm **`dsh-usage-dock@0.10.1`**，40 文件 / 462 kB，线上 `dist.shasum` = **`a0d8f4facd26cf2827dd975d35f9b348097c9372`**（与本地 dry-run 一致），`dist-tags.latest = 0.10.1`。
2. **内容**：`tools/patch-codex-subscription.mjs`（`--check` 只读 / `--apply` 原子替换+备份 / `--revert`，版本钉死 3.2.6、
   base/program 哈希校验、逐条 hunk 唯一命中、失败零写入）+ `tools/patches/codex-subscription-3.2.6.json`（4 条纯插入 hunk）
   + `tools/test-patch-codex-subscription.mjs`（11 项，临时副本）+ `docs/release-notes-v0.10.1.md`；`AGENTS.md` §7 写入恢复流程。
3. **对真实 profile 的只读验证**：`包版本=3.2.6`、`lib/index.js=4b9498e5…`、**结论：已适配**，exit 0（零写入）。
4. ⚠️ **重要**：`package.json` 的 `files` 不含 `tools/`，因此**补丁工具不进 npm 包**；用户要从**仓库**里跑
   `node tools/patch-codex-subscription.mjs`。若将来希望随包分发，需把该文件与 `tools/patches/` 加入 `files`（会扩大发布面，需单独决定）。
5. **下一步候选**：① 第三方升级到 3.2.12 时，要按新版本重新生成 hunk 清单（4 条 hunk 的上下文很可能变），再 `--apply`；
   ② 0.10.0 遗留的三条夹具能力不足套件；③ `mimoDisplayWire` 对 `freshness:'stale'` 未置 `stale:true`。

## 2026-11-12 13:17：**0.10.0 已正式发布**（主干 / tag / GitHub Release / npm 全部完成）

1. **发布物**：commit **`0a56d32`**（151 文件，含 `plans/mimo-auth/**` 与 `plans/codex-sources.js` 首次入库）；
   tag **`v0.10.0`**；GitHub Release id **`442523103`**（`/releases/latest` 已确认 = v0.10.0）；
   npm **`dsh-usage-dock@0.10.0`**，40 文件 / 462 kB，线上 `dist.shasum` = **`34ec08d7724a1b33717c43d3861301fec4b7733d`**（与本地 dry-run 一致），`dist-tags.latest = 0.10.0`。
2. **发布流程中踩到的两个环境坑**（下次注意）：① 本机 git 配了 `http(s).proxy=127.0.0.1:10909`，用户关掉 VPN 后该端口无监听 ⇒ `git push` 报 `Failed to connect … via 127.0.0.1`；
   **解法**：`git -c http.proxy= -c https.proxy= push`（单次禁用代理，不改全局；直连 GitHub 实测可达），GitHub API 用 `Invoke-RestMethod -NoProxy`。
   ② PowerShell here-string 传中文会被编码搞坏 ⇒ 改为**写 UTF-8 文件再读取**发 Release 正文。
3. **发版前安全终审**（Max）：`docs/review-0.10.0-security-20261112.md`，五面全「已核」，**Pass**；
   其 N1（GUI 路由与提示词仍走旧 Cookie 取数）**已修**（`index.js:1232-1234` 复用 `mimoWireWithDisplay`，全文件恰好两处调用），窄复核再 Pass。
4. **测试基线**：98 套件 / 93 exit 0 / 0 挂起；非 0 的 5 条均为**非产品缺陷**——
   ⑤ `mimo-display-e2e`、⑥ `mimo-remembered-client-e2e`、⑦ `recheck-round3`（三条：mock 夹具能力不足/派生字段）、
   `test-workbuddy-contract`（本机未装第三方包）、`test-mimo-remembered-session`（全量并发时偶发，单独跑 21/21 稳定）。
5. **清理成果**：删除退场模块（`kimi-code`/`glm-zhipu`/`glm-zai`/`glm`、`workbuddyAi`/`fetchPlanAi`）、WorkBuddy 旧 `/status` 簇
   （`gatewayWire`/`creditsFromGatewayStatus`/`creditPackagesOf`）、`fetchStatus`/`fetchPlanWithBase`、本地探针与 poc 期测试（12 条）；
   产品文件里 `DSH_DIAG`/`console.*`/`TODO`/`FIXME` **0 命中**。
6. **0.10.1 待办（已知、非阻断）**：① `mimoDisplayWire` 对 `state:'verified'` 但 `freshness:'stale'` 的旧值未置 `stale:true`（会被当当前值上报）；
   ② 三条夹具能力不足的套件（建议给 mock runtime 加 `awaitPendingFetch()` 并读 `mimoDisplayView()` 派生气对齐）；
   ③ `plans/glm-zai` 等已删模块在历史文档中的提及（不影响运行）。

## 2026-11-12 12:00：⑦/⑤/⑥ 三条红灯的最终定性（**非产品缺陷，均属测试侧能力不足**）

1. **⑦ `recheck-round3` W2a**：环境变量门控的诊断证明 —— W2a 那次渲染**没有** `gate.digest`/`settle.source` 输出，
   即**首轮 fetch 的响应在这套 mock runtime 里根本没被处理到**，`plans` 里没有 A 的 wire 行（`render.plans` 显示 `custom:…:true` 是占位）。
   结论：**mock 缺「等首轮 fetch 被 accept」的能力**（需加 `awaitPendingFetch()` 之类夹具能力），改初始 payload / 改断言都无效。
   产品侧「首屏占位 → 数据到即替换、不重复」由 `test-capsule-pending` P3a/P3c/P3d 与 W1c/W3 守住。
2. **⑤ `mimo-display-e2e`(13/50)**：停止按钮按 `snapshot.canStop === true` 渲染，`canStop` 由 `mimoDisplayView()` **派生**，
   不是夹具能直接塞的字面量；恢复 13 条需先读派生条件再逐条对齐。
3. **⑥ `mimo-remembered-client-e2e`(23/99)**：同类派生/固定文案漂移。
4. **不要再把这三条当「产品缺陷」重查**；要么补夹具能力，要么按已知限制记录并随发版说明。
   全量基线：**114 套件 / 109 exit 0 / 0 挂起**，5 非 0 = ⑤⑥⑦ + `mimo-settings-mount-adapter`(需 Electron) + `test-workbuddy-contract`(需第三方包)。

## 2026-11-12 11:45：**0.10.0 发布准备中**（未提交/未推送/未发布）

1. **用户决定**：版本 **0.10.0**；先把老化断言修到全绿再发；**退场渠道模块删除**（推翻 AGENTS 旧约定，需同步改文档）；
   要求「bug/漏洞尽量少、不留过多无用残留」。
2. **已就绪**：`package.json` → 0.10.0；`docs/release-notes-v0.10.0.md`（更新摘要 + 重要前提 + 已知限制三条 + 工程细节）；
   `AGENTS.md` 已改当前版本/`plans/` 清单/已接入渠道/§7 两条限制；`npm publish --dry-run` 44 文件 / 469.6 kB / shasum `1addd024…`。
3. **测试现状**：114 套件 / **109 exit 0 / 0 挂起**；仍非 0 = ⑤ `mimo-display-e2e`(13/50 夹具缺 `canStop/managed`)、
   ⑥ `mimo-remembered-client-e2e`(23/99 夹具/文案漂移)、⑦ `recheck-round3` W2a、⑨ `mimo-settings-mount-adapter`(需 Electron)、
   `test-workbuddy-contract`(需第三方包，本机未装)。
4. **⑦ 的关键结论（已验证）**：三方 digest **完全相同**（host=client=wire=`4c30f229041d604a`）⇒ 不是 digest 夹具问题；
   真正卡点是 `customDataStillValid()`（`client.js:618`）依赖的 `applied.entries[A]`/`configDirtyIds[A]`。
   下一步只做**条件级诊断**（四项：nowSignature / appliedSignature / 是否相等 / dirtyEpoch vs applied.epoch），再决定改测试还是改产品。
5. **我拍板的两条语义（已写入测试注释）**：⑧ MiMo 恢复失败统一为固定闭集码（不放宽产品白名单，精度损失进已知限制）；
   ⑩ MiMo 为账号/会话型渠道**不冻结凭据**（与 deepseek/codex/workbuddy 一致），保留「不跨身份缓存」不变量。
6. **已删垃圾**：仓库根 0 字节 `test-degrade-refresh.mjs`、`tools/tmp-probe-config.mjs`、`tools/poc/`（21 文件）、`plans/mimo-auth-test.txt`。
7. **待办**：2b（删 WorkBuddy `/status` 老路死代码，逐条实证零引用）、2a（已派：删退场模块）、⑤⑥、全量复跑、
   `npm publish --dry-run` 复核包内不含 tools/docs/.diagnostics/test、**Max 安全向终审**、最后 commit/push/tag/Release/publish。

## 2026-11-12 10:18：**批次 G 已部署**：胶囊首帧列出全部已启用渠道（占位省略号）

1. **用户诉求**：启动时胶囊只显示 MiMo，要等一会儿其它渠道才出现；希望一开始就同步列出全部已勾选渠道。
2. **根因**：首帧主路由 `plans` 为空，只有 `mimoDisplayOverlay` 因「找不到 mimo 就追加一条」而单独出现。
3. **实现（纯客户端、零新增请求、零伪造数值）**：新增 `withPendingPlaceholders(plans, config)`（`client.js:7176`），
   在 sorted 之后、`mimoDisplayOverlay` **之前**调用（`:2074`）；用**已保存配置**枚举启用中的内置渠道（跳退场 id）+ 启用中的自定义条目，
   只对**尚未出现**的 id 插入 `{id,name,custom?,pending:true}`（闭集，无 balance/currency/percent/windows），再走同一 `planOrder` 排序。
   渲染：`plan.pending===true`（`:2099`）⇒ `dot:null`、`values:['…']`、`stale:false`、`title:'<名称> 读取中'`；**详情面板过滤掉占位**（`:2350`）。
4. **已装**：`client.js EBE20F17… → 752E8C8B…`（`atomic-rename`，nlink=1、inode 已变）；44 文件只 1 条变化；`package.json 0.9.0` 未动。
   收据 `.diagnostics/capsule-pending-20261112/RECEIPT.json`，回滚 `node .diagnostics/capsule-pending-20261112/rollback.mjs [--execute]`。
5. **测试**：新 `tools/test-capsule-pending.mjs` **23/23**（U1–U7 纯函数 + P1–P5 渲染）；footer-row 12、settings-layout 30、mixed-currency 5、custom-render 65、
   panel-interactions 12、workbuddy-client-credits 50、settings 6、android-compat 14、codex-source-ui 79 全过；既有失败 `degrade-refresh` T9/T10（5 项）、`custom-settings` C2c（1 项）、`mimo-auth-client`（4 项）**未修未掩盖**。
6. ⚠️ **一处断言改写（需知悉）**：`test-codex-source-ui` 的 B5a/RV2a 原断言「Codex 整行不出现」，因占位行按设计可以出现，改为守真正意图
   （无 `33%/55%`、无 `获取失败`/`本次采集已作废`、无 `%`）。**副作用**：Codex 已启用但 wire 来源与已保存来源不符时，该行会显示 `…`（读取中）而不是整行消失。
7. **待实机**：重启后确认首帧就有全部已启用渠道（灰点 `…`），随后逐行换成真实数值；停用的渠道全程不出现。

## 2026-11-12 09:56：**批次 F 已部署**：WorkBuddy 10-25 整条线（含数据源切换，待实机验收）

1. **用户选择**：整条线一起装（不是只装显示收口）。此前 10-25 曾部署并经用户确认，但被后续 MiMo 整文件安装覆盖回 0.9.0 基线；本次恢复。
2. **写入 3 个文件**（`atomic-rename`，workbuddy.js 原 **nlink=5** = pnpm store 链接）：
   `plans/workbuddy.js 8AD121D9… → 0998D2E0…`｜`client.js 45932EB7… → EBE20F17…`（= 已装 + codex 15 hunk + WB 11 hunk）｜
   `index.js 7B867D43… → AEAD2461…`（= 已装 + **仅 3 个 WB hunk**：import `GATEWAY_CREDITS_PATH`、观察身份 `/status`→`/v1/credits` 且 `acct=`→`scope=cn`、账号列表路由注释）。
   **排除的 9 个 hunk**：`registerMimoAuth` import 搬运 ×2、`cfg`/`liveConfig` 搬运 ×2、**删 MiMo 两开关 ×1**、路由 payload 加 `mimoAuth: mimoAuthStatus` ×2（保持现状）。
   包内 44 文件只 3 条变化；`package.json` 仍 **0.9.0**（**未**写入 `.3` 开发标签）。
   收据 `.diagnostics/wb-line-20261112/RECEIPT.json`（`checks=21 fail=0`），回滚 `node .diagnostics/wb-line-20261112/rollback.mjs [--execute]`。
3. **本批行为变化（用户重启后可见）**：口径 **只统计严格 cn**（根 `total_credits` 跨区合计不用）；账号勾选退场（`workbuddyAccounts` 保留不生效、设置页不再请求账号列表）；
   详情「其中最早到期部分」→「最近到期 YYYY-MM-DD」按本地日历日；大号总积分旁重复汇总行隐藏。
4. **测试**：workbuddy 26 / client-credits 50 / gateway 51 / legacy-selection 33 / settings-layout 30 / footer-row 12 / codex 88 / mimo-lane 47 / usage-tool 108 全 exit 0；
   并用 `DSH_CLIENT_UNDER_TEST` 对**要部署的那份 client 字节**（`EBE20F17…`）复跑 50/30/12 全过。
5. **实机确认（用户截图 2026-11-12 09:59）**：WorkBuddy 卡已显示新口径（「数据源：客户端接口 `GET /v1/credits`，且只统计国内（cn）积分」/「该接口不提供稳定的账号 ID，暂不支持按账号筛选」），
   胶囊 `✦<积分>` 正常；MiMo `¥<余额>`、DeepSeek `¥<余额>` 未受影响；Codex 因 VPN 关闭显示失败态（预期）。
6. **下一步**：用户提出新体验需求（见下条「批次 G」）——启动首帧胶囊只有 MiMo，希望一开始就列出所有已勾选渠道。

## 2026-11-12 09:45：**MiMo `usage_status` lane 对齐实机通过**（批次 E 生效）

1. **本人重启后主代调 `usage_status`**：`Xiaomi MiMo：余额 <值> CNY` —— **与胶囊同值** ⇒ `getHost()` → `routeDisplay.peek()` 链路在真机接通，
   「GUI / `usage_status` / 策略共用同一来源」对 MiMo 也成立。同时 DeepSeek `<余额>`、WorkBuddy `<积分>` 与胶囊一致。
2. **Codex 行**：本轮用户**关闭 VPN**，工具报「取数命令执行失败（exec）」（网络层失败映射），与 VPN 关闭一致；**不是回归**。
   开 VPN 时应恢复（今早实测 `96%/58%` 且策略段注入了同一份数值）。
3. 至此本轮三条线全部收口：Codex 双来源（端到端）+ MiMo 排版/收尾 + MiMo usage lane 对齐。
4. **遗留（未部署）**：WorkBuddy 10-25 线（`plans/workbuddy.js` 238+/68−、client 5 hunk、`package.json` 标签 `0.9.1-dev.wbcredits.20261025.3`）；
   **未提交、未定版、未推送、未发布**（推送闸门：须用户明确确认）。

## 2026-11-12 09:35：**批次 E 已部署**：MiMo 显示快照 handle 的真正修法（`getHost()`；待重启验证）

1. **批次 D 无效的原因（主代理第三次判断，这次读到了根因）**：`registerMimoAuth()`（`host.js:55-86`）返回的是
   **`{ bootEpoch, dispose }`**；真正的 host 在 `ctx.inject(['connection','webServer'], …)` 回调里**异步**创建、只存在闭包 `child` 中。
   所以 `mimoAuthHost.display` / `.routeDisplay` **恒 undefined** ⇒ peek 恒 null ⇒ 回落旧 provider ⇒ `api`。
2. **修法**：`registerMimoAuth` 返回对象新增 `getHost: () => child`（每次现读、不缓存；`createAuthHost` 一字未动）；
   `index.js#mimoDisplayPeek` = `getHost()` → `routeDisplay.peek()` → `display.peek()` → null（异常→null；`routeDisplay` 抛错不偷偷回退 legacy）。
3. **已装**：`plans/mimo-auth/host.js A994E9AD… → 889F81E3…`、`index.js 8E0D7EAC… → 7B867D43…`；44 文件只 2 条变化；
   收据 `.diagnostics/mimo-gethost-20261112/RECEIPT.json`（`checks=17 fail=0`，含 A6 命名导入对账 + POST 子进程链接通过）；
   回滚 `node .diagnostics/mimo-gethost-20261112/rollback.mjs [--execute]`。
4. **测试**：mimo lane 40→**47**（L10a/L10b 真跑两次组合器证明「`getHost()` 先 null 后自动接上」，L11/L12 源码守卫）。
5. **下一步（等本人）**：重启 → 主调 `usage_status`；预期 MiMo = 胶囊同值。**若仍 `api`**，则说明 `remembered === null`（managed 模式没开）或
   `remembered.displaySnapshot().selected !== true`，下一步应查 `mimoAuthStatus`/路由实际返回，**不要再改 handle**。
6. **Codex 现状**：用户关闭 VPN ⇒ Subscription 来源取不到，工具如实报 `missing`（非故障）；开 VPN 后恢复 `96%/58%`。

## 2026-11-12 09:20：**批次 D 已部署**：MiMo 取错 handle 的修复（待重启验证）+ 策略段注入已实机确认

1. **重启后首次实测**：`usage_status` 恢复（DeepSeek <余额> / Codex <两窗口百分比> / WorkBuddy <积分> 与胶囊一致）⇒ 补装 `plans/usage-tool.js` 生效；
   但 **MiMo 仍报「上游拒绝请求（api）」** ⇒ 不是数据问题，是**取错 handle**。
2. **根因（主代理二次判断错误）**：`plans/mimo-auth/host.js:274-287` 的 `routeDisplay = managedDisplay ?? display` 才是**路由实际使用的**快照；
   `registerMimoAuth()` 返回的 `display` 是**旧 legacy manager**。managed（记住登录）模式下 legacy display 恒 `absent`（`selected:false`）
   ⇒ `mimoDisplayWire` 返回 null ⇒ 回落 provider ⇒ 报 api。**胶囊有值 + 工具报错**由此自洽。
3. **修法**：`host.js` return 里**纯新增** `routeDisplay`（10 行，0 删改，注释写明只供同进程只读消费、不得用于变更动作）；
   `index.js#mimoDisplayPeek` 改为 `routeDisplay.peek()` → 缺失回退 `display.peek()` → 都没有 null；`routeDisplay.peek` 抛错时**不偷偷回退** legacy。
4. **已装**：`plans/mimo-auth/host.js 1C1C8C08… → A994E9AD…`、`index.js 6769E87E… → 8E0D7EAC…`；包内 44 文件只 2 条变化；
   收据 `.diagnostics/mimo-peek-route-20261112/RECEIPT.json`（`checks=17 fail=0`），含 **A6 命名导入对账（15 个相对导入全覆盖）** 与 **POST 子进程链接守卫通过**；
   回滚 `node .diagnostics/mimo-peek-route-20261112/rollback.mjs [--execute]`。备份 `backup/20261112T012031Z/`。
5. **策略段注入（此前长期未验证项）已实机确认**：用户开启 Codex 额度策略后，上下文出现
   「当前额度快照：渠道：OpenAI Codex 阶段：normal 额度：rolling-5h 剩余 96% 额度：weekly 剩余 58% 来源：本次采集 采样时间：…」
   ⇒ `systemPrompt` 策略段**确实进入提示词**，且取的是 **Subscription 来源**，与胶囊逐项一致。**不要再写成「未验证」。**
6. **下一步（等本人）**：重启 → 主调 `usage_status`，预期 MiMo = 胶囊同值（约 `<余额> CNY`）；若仍 `api` 说明 `routeDisplay` 未生效（需查 managed 模式是否真的 active）。

## 2026-11-12 08:50：**事故：批次 C 漏装 `plans/usage-tool.js` 导致插件整体未加载**（已补装，待重启）

1. **事实**：批次 C 只写 `index.js`，但新 `index.js` 第 63 行 `import { projectUsage, mimoWireWithDisplay } from './plans/usage-tool.js'`；
   已装 `plans/usage-tool.js` 仍是 `69AD691A…`（无该导出）⇒ ESM 链接失败 ⇒ **插件不激活**（胶囊消失、`usage_status` 报
   「auto-review: the pending native tool schema is missing or ambiguous」——那是**注册没发生**的假象，不是 schema 问题）。
2. **根因（主代理规划错误）**：把 MiMo lane 改动误判为「Host-only 一个文件」；实际跨 `index.js` + `plans/usage-tool.js`。
   **教训**：任何 index.js 变更都要先对账「新 index 的命名导入 ⊆ 目标包已有导出」，再决定写入集。
3. **补装**：`plans/usage-tool.js 69AD691A… → 0FA8272F…`（`atomic-rename`，原 nlink=5；包内 44 文件只 1 条变化、无新增）。
   现磁盘：`index.js 6769E87E…` + `plans/usage-tool.js 0FA8272F…` + `client.js 45932EB7…` + `package.json 0.9.0`。
4. **补装脚本自检的坑**：POST 守卫在**同进程**二次 `import()` ⇒ 命中装前已加载的旧模块记录，误报 `status=failed`（磁盘其实是对的）。
   已改为 `spawnSync(process.execPath, ['-e', …])` **子进程**校验；独立进程实测已装 `index.js` 可链接、导出 `Config/apply/inject/name`。
   收据 `RECEIPT-usage-tool.json`（failed，**保留原文**）+ `RECEIPT-usage-tool-postcheck.json`（`deployed-verified-by-postcheck`，含 linkBefore/linkAfter）。
5. **新守卫（后续所有部署沿用）**：A7「新 index 命名导入 ⊆ 源模块导出」+ 装后**子进程**链接检查；selftest C20–C23 复现「同进程缓存伪影」并证明子进程法可避开。
6. **下一步（等本人）**：重启 → 主调 `usage_status`，预期 MiMo 与胶囊同值（`<余额> CNY`），DeepSeek/Codex/WorkBuddy 不变。

## 2026-11-12 00:05：MiMo `usage_status` lane 对齐 **批次 C 已部署**（待重启验证）

1. **为什么做**：胶囊 MiMo 数值来自 display 快照（`plans/mimo-auth/session-display.js`，客户端 `mimoDisplayOverlay` 覆盖），
   而 `usage_status` 走 `plans/mimo.js#fetchPlan`（旧 Cookie/API Key lane）⇒ 真机上工具报「上游拒绝请求（api）」而胶囊显示 `¥<余额>`。
2. **改法（Host only，不改客户端）**：`plans/usage-tool.js` 新增纯函数 `mimoDisplayWire(snapshot)` +
   组合器 `mimoWireWithDisplay(source, fetchProvider)`；`index.js` 接住 `registerMimoAuth()` 返回的 `display.peek`（零 IO），
   在 `collectPlans` 里**provider 之前**分流；`ACCOUNT_BOUND_PLAN_IDS` 加 `'mimo'`（显示值依赖会话，配置哈希不能当缓存键；副作用是 mimo 不再冻结凭据，与 deepseek/codex/workbuddy 一致）。
   闭集：`selected!==true → null`（走原路径）｜`selected && state!=='verified' → error:'missing'`（零请求、不回落）｜verified+合法 → `{balance,currency,fetchedAt?}`；**不造 0、不默认 CNY、不透传 identity/code**。
3. **已装**：`index.js F9DED617…B81B10 → 6769E87E…76EA0D`（`atomic-rename`，nlink=1、inode 已变）；包内 **44** 文件只 1 条变化、无新增；
   `client.js 45932EB7…`、`plans/codex-sources.js AF8EDC36…`、`package.json 0.9.0` 均未动。
   收据 `.diagnostics/mimo-usage-lane-20261112/RECEIPT.json`（`checks=11 fail=0`），回滚 `node .diagnostics/mimo-usage-lane-20261112/rollback.mjs [--execute]`。
4. **staged 复核（主代理自查）**：`6769E87E…` 2153 行；`mimoWireWithDisplay(mimoDisplaySource, fetchOnce)` 落在 provider 调用**之前**；
   `ACCOUNT_BOUND_PLAN_IDS` 含 `'mimo'`；`enableConsoleProtocol` **仍在**（MiMo 未被关）；`GATEWAY_CREDITS_PATH` 计数 **0**（WB 线未夹带）。
   本轮是 **Host-only** 改动，`client.js` 不需要动。
5. **测试**：新 `tools/test-mimo-usage-lane.mjs` **31/31**；`test-usage-tool/-register/-host/-integration/-policy`、`test-mimo-parse`、`test-codex-sources`（staged 字节 88/0）全 exit 0。
6. **下一步（等本人）**：重启 → 主再调 `usage_status` 应与胶囊同值（预期 MiMo ≈ `¥<余额>`）；若得「本次没有该渠道的数据」说明快照当时不在 `verified`（准确信息，非故障）；
   `stopped/expired/holding` 的实机文案、"切账号后立刻换值" 的时序仍**未实机验证**。

## 2026-11-11 23:50：Codex 双来源 **端到端实机通过**（订阅来源真实取到额度）

1. **本人截图确认**：设置页 `Codex Subscription` 行 = **可用**（已选中）｜`Codex Connect` = 未启用｜「当前来源：Codex Subscription」；
   **侧栏 Codex 行显示 `100% 59%`（绿点，成功态）** ⇒ 第三方只读 service → Host `plans/codex-sources.js` → 胶囊 的完整链路在真机走通。
2. 这是本轮（批次 A + 批次 B）**唯一需要的实机验收项**，已达成；`100%` 是有效值（未消耗），未出现的窗口（如月窗）是按合同**不伪造**。
3. **`usage_status` 同值核对（主代调，2026-11-11 23:44）**：DeepSeek `<余额> CNY`✓、WorkBuddy `<积分>`✓、
   **Codex `rolling-5h 剩余 100% / weekly 剩余 59%` = 胶囊 `100% 59%` 逐项一致**（口径 correct：remaining）⇒ GUI 与工具同源成立。
   **MiMo 不一致**：工具报「上游拒绝请求（api）」，而胶囊显示 `¥<余额>`。原因是**两条 lane**：胶囊走 MiMo 控制台/记住登录链，
   `usage_status` 仍走 `plans/mimo.js` 旧 provider（Cookie/API Key）⇒ **既有分流，非本轮引入**；要统一属独立改动。
4. 未验证/不声称：策略段、Connect 来源（其插件当前「异常」且关闭，属另一件事）、长期稳定性、MiMo 跨重启以外的场景。
4. **尚未做**：Git 提交/版本定档/打标签/发布（推送闸门：须用户明确确认）；工作区仍含 **WorkBuddy 10-25 未部署线**（`plans/workbuddy.js` 238+/68−、client 5 hunk、`package.json` 标签 `0.9.1-dev.wbcredits.20261025.3`）。

## 2026-11-11 23:40：Codex 双来源 **批次 A 已实机验证 + 批次 B 已部署**（B 待重启验证）

1. **批次 A 实机证据（用户截图）**：设置页 Codex 卡出现「额度来源」两行 —— Connect = **未启用**、Subscription = **接口暂不可用（需适配）**；
   侧栏新出现 `OpenAI Codex 获取失败`（灰点，未 fallback、未整行消失 = N2 生效）；**MiMo ¥<余额>、WorkBuddy ✦<积分>、DeepSeek ¥<余额> 均正常**
   ⇒ staged `index.js` 保留 MiMo 两开关正确、`plans/workbuddy.js` 未被覆盖。
   **N4② 降级点在真机不成立**：loader `disabled` 就是严格 `false`，无需放宽为 `disabled !== true`。
   ⚠️ 该两行**只在渠道勾选启用时渲染**（`client.js:9236` `enabled && meta.source !== undefined`）；用户第一次没看到是因为 Codex 复选框未勾。
2. **批次 B 已部署**：`dsh-codex-subscription@3.2.6` 的 `lib/index.js` `E4C75851…AAF8DC` → **`4B9498E5…887672`**（4 个纯插入 hunk，新增只读 service `codexSubscriptionUsage`）；
   `atomic-rename`、`nlink=1`、inode 已变；**原 nlink=2**（兄弟是 pnpm store blob，原地写会污染 store）。`package.json` 仍 `3.2.6`、包内 58 文件只 1 条变化。
   收据 `.diagnostics/codex-subscription-service-install-20261111/RECEIPT.json`（`checks=9 fail=0`），备份 `backup/20261111T154002Z/`，
   回滚 `node .diagnostics/codex-subscription-service-install-20261111/rollback.mjs [--execute]`。
   **升级该第三方包会覆盖本补丁，届时需重打**（收据已记）。
3. **下一步（等本人）**：重启 → Subscription 行应从「接口暂不可用（需适配）」变「**可用**」→ 点选它 + 保存更改 → 侧栏 Codex 行应显示订阅额度
   （只有上游实有的窗口才显示，缺窗口不伪造）；若变「可用」但仍失败，按固定码（未登录 / 需重新授权 / 无额度数据）继续，不回显上游原文。
4. **Connect 来源现状**：`dsh-codex-connect` 插件在插件页显示**异常**且开关关闭 ⇒ Connect = 未启用是**它自己的状态**，不是本次改动造成；要修另议。

## 2026-11-11 23:11：Codex 双来源 **批次 A 已部署**（未重启、未实机验收）

1. **性质**：`status=deployed / deployed=true / atomicReplace=true`，**`runtimeVerified:false`**（`realLoginPerformed/networkUsed` 全 false）；**未重启**、未读/未改真实 cfg 与 credential、无联网。
2. **授权链**：用户选「先跑 Max 终审」+「Codex 单独一轮、WorkBuddy 10-25 不进」→ Max 首轮 **Fail(B1,B2)** →
   High 整改 → Max 窄复核 **Pass** → 用户批准批次 A（由主代跑经审原命令）；批次 B（第三方补丁）**用户定为「A 验证通过后再单独批」**。
3. **写入 5 个文件**（`atomic-rename`，`nlink=1`、inode 已变；备份 `backup/20261111T151102Z/`）：
   `index.js F9DED617…B81B10`（staged = 已装 C681 + **7 个 codex hunk**，不含 WB/MiMo 线）｜
   `client.js 45932EB7…3DBDF2`（staged = 已装 85906 + **15 个 codex hunk**，不含 WB dirty）｜
   `plans/codex.js C6AB894B…94FC4B`｜`plans/codex-sources.js AF8EDC36…075547E`（新增）｜
   `plans/custom-balance.js F9C6C928…BC86D5`（**必须装**：缺它则客户端有 codex 摘要组件、Host 没有 ⇒ subscription 态整盘无数据）。
   `package.json` 仍 **0.9.0**；`plans/workbuddy.js 8AD121D9…`、`plans/index.js`、`plans/mimo-auth/**` 等 verify-only 全未变（44 文件 / 非预期差异 0）。
4. **收据**：`.diagnostics/codex-source-install-20261111/RECEIPT.json`（`checks=18 fail=0`）+ `INSTALLED-MANIFEST.json`（新权威 44）；
   回滚 `node .diagnostics/codex-source-install-20261111/rollback.mjs [--execute]`（逐项判定 restore/delete/skip，非幂等）。
5. **本轮修掉的三个真问题**：① 终审 B1 —— 客户端 codex 摘要组件原先 push 在条目/orphan **之后**，与 Host「条目之前」错位 ⇒ 有自定义条目时双端 digest 恒不等；② 终审 B2 —— Host 映射表键无 `E_CODEX_` 前缀，5 个真实码一个不命中、全落 generic 非 transient；③ 部署脚本 `install-lib` 读回校验用大小写敏感 `!==`（Node 小写 vs 常量大写）⇒ execute 首个文件必抛（安全失败，目标不动）。
6. **为什么必须 staged 而不是工作区整份**：工作区 `index.js` 夹带 WB 线（`GATEWAY_CREDITS_PATH` 导出在已装 `plans/workbuddy.js` 里**不存在** ⇒ ESM 链接失败、插件不激活）与 MiMo `enableConsoleProtocol/enableRememberedAccount` 两行删除（会让当前正常的 MiMo 关掉）。
   **不要把工作区 `index.js`/`client.js` 直接覆盖 profile**，要用两份 staged。
7. **实测新事实**：`plans/custom-balance.js` 与 `plans/codex.js` 原 `nlink=5` —— 兄弟链接是 **pnpm store blob + `_tmp_*`**，原地写会污染 store（影响其它 profile 与将来 `pnpm install`）；原子 rename 后 desktop 换新 inode，store 保持旧字节。
8. **下一步（等本人）**：手动重启 DSH → 看 ① 胶囊与 DeepSeek/WorkBuddy/MiMo/自定义数值未变 ② 设置页 Codex 卡出现两行来源、Connect 仍默认 ③ Subscription 行显示「未启用」还是「接口暂不可用」；该项决定批次 B 是否值得马上装。`entry.disabled === false` 严格判据若在真机给 `undefined`，才按 N4② 放宽（未改）。

## 2026-11-11 17:39：MiMo 设置页两行排版 **已部署**（非实机验收）

1. **性质**：`complete / deployed=true / atomicReplace=true`，**`runtimeVerified:false`**（`realLoginPerformed/networkUsed/backupCreated/rollbackPrepared` 全 false）；
   **未重启**、未读/未改真实 credential record 与 cfg、未调用真实 API。
2. **授权链**：Max **极窄 Pass**（`docs/mimo-settings-typography-review-20261111.md`，scope=2 行 style）→ 用户 ask **允许本次排版试装** →
   主亲读 plan 只改 `reviewStatus=pass-typography-scoped` + `deployApproved=true` → 本人代原命令
   `node .diagnostics/mimo-settings-typography-20261111/deploy-typography.mjs --execute`，结果 `ready=YES / checks=21 / fail=0 / stage=1`。
3. **收据**：`.diagnostics/mimo-settings-typography-20261111/RECEIPT.json` `2026-11-11T09:38:57.020Z`（=17:38:57 +08）。
   `client.js` `8F01…→85906C30A3A0276377E3BE233FAE761AC5C3A6D96C9D05BD18F34EF3343A1DD8`，`written+verified / nlink=1 / inode 已变`；
   其余 **16 项 + 2 meta 未变**。plan 已补 `deployed:true` + `executedAt`。
4. **权威清单**：**本排版目录的 `INSTALLED-MANIFEST.json` 是最新 17**；`mimo-ui-closeout-20261110/INSTALLED-MANIFEST.json`
   降为**上一个 base**；`mimo-sso-header-profile-20261109` 更早，仅历史。
5. **改了什么**：只把设置页 verified 的两行（「更新于」「已绑定账号」）加 `style: settingsHintStyle`（灰色 label-tertiary / 12 px），
   与其它渠道说明小字一致；**不**整块灰化（失败原因 / QR / 4 勾确认仍原色），文本/按钮/逻辑/其它 state 未动。
6. **client 来源**：实际装入 `85906…` = 已装 `8F01…` + **1 个合并 style hunk**（v1/v2 两处），**不含 WorkBuddy 改动**；
   工作区 `B22B…` 含 **WB dirty** 仅作受测证明（`staged + 5 WB hunk == WS` 反证无夹带）。
7. **证据强度**：用户**新截图**只确认「先前精简 UI 已激活、正常有值」，并指出**文字需灰小**；
   **不是** 60 s 自动读 / 1–4 stale / 第 5 failed 的实机完整验收，**本次 85906 更未实机**。
   2026-11-10 的跨重启恢复验收（17:00 条）**仍是上一阶段历史结论**，本包不改写、不叠加。
8. **下一步（等本人，不加测试）**：本人正常重开看设置页两行是否已灰小；**不要求**断网、重扫、点退出等破坏性操作。
9. **Codex 下一阶段（用户 11-11 新 ask，本轮不写代码）**：选择**增加 Subscription 只读 service**；允许**开发准备**
   第三方**最小本地接口补丁**，**实际试装需另行确认**；方向为**统一 Host 来源 → GUI / `usage_status` / 策略共用**，
   **缺省 connect 不 auto**；实现交 **High82 的桥服务候选**。**ownerPeer 自授方案未获选，绝不运行**（早前 GUI-only 提议亦已撤回）。


## 2026-11-11 17:05：MiMo UI 收尾 + 后端 4 源 **stage 5 已部署（未实机验收）**

1. **性质**：`complete / deployed=true / atomicReplace=true`，但 **`runtimeVerified:false`**、`realLoginPerformed=false`、
   `networkUsed=false`、`backupCreated=false`、`rollbackPrepared=false`；真实 credential record / cfg **未读未改**。
   **11/11 本人仅说「继续」，未反馈新版实机表现** ⇒ 本条**不是**新 UI 的实机验收。
2. **授权链**：Max 完整包（script `CE8A…` / plan `E84A…` / hunks `7108…` / client goal `8F01…`）**一次审 Pass** →
   用户 ask 允许本次试装 → 主亲读 plan 只改 `reviewStatus=pass-mimo-ui-refresh-scoped` + `deployApproved=true` →
   主**代原 execute 命令**执行成功（`ready=YES / checks=44 / fail=0 / staged=5/5`）。
3. **收据**：`.diagnostics/mimo-ui-closeout-20261110/RECEIPT.json` `2026-11-10T13:16:19.028Z`（=21:16:19 +08）。
   **新权威 17 = 同目录 `INSTALLED-MANIFEST.json`**；`.diagnostics/mimo-sso-header-profile-20261109/INSTALLED-MANIFEST.json`（SSO 17）
   从本条起**只是 base**，不再是当前状态。plan 已补 `deployed:true` + `executedAt`。
4. **写了哪 5 个（各 written+verified / nlink=1 / inode 已变）**：
   `remembered-session B2294E06→AC59AFFB`、`routes A99D36D9→01C5BE5B`、`host C093B9E0→1C1C8C08`、
   `console-protocol 20A7476F→9768B5F3`、`client 113C5F0E→8F010A7C`。
   **未写**：`index C681…`、`secure-transport 811A4F26…`（SSO 传输一字未改）、`console-grants 6AA…`、`remember-store E05C…`
   等 12 项 verify-only + `package.json` / `plans/mimo.js` 两 meta，收据核实全未变。
5. **client 来源**：目标 `8F01…` = **已装 113C + 23 个 MiMo unique hunk**（`hunksSha256=7108597D… / final:true`）；
   工作区 `0964…` **含 WB dirty**，只作受测证明、**不入目标**（脚本 `not-ws` 强制 staged≠WS）。旧 `0CA6`/`9409` 作废。
6. **本包行为（记要点，不记金额/UID/URL）**：UI 精简（details 只金额；settings 只更新时间/绑定账号/退出 + tiny 按钮）；
   后台 **60 s** 自动读、展开（false→true）**主动读一次**；普通失败 **1–4 stale 保旧值 / 第 5 次公开 failed 但 timer 继续**，
   下一成功 reset；**auth / UID / owner 变更立即清**；protocol 只对**纯 balance 错误**保留认证，
   **未**放宽 SSO、schema、headers、目标；非普通失败 fail-closed 进 failed 供 retry。
7. **证据强度**：fake 14 组 + UI 12/5/6 + Max Pass = **合成/静态**，**不等于实机**；旧套红灯、无全链路贯通等结论
   仍在 `docs/mimo-remembered-refresh-freshness-20261110.md` 等文档里保留，不因部署改变。
8. **下一步（等本人，不加测试）**：本人**正常重开**观察余额/详情金额/更新时间即可；**不要求**断网、新扫、点退出等破坏性操作。
   若仍失败只报固定原因码 + 安全摘要，**不**贴原始 URL/Cookie/UID/金额。
9. **历史保留**：下面 **2026-11-10 17:00 的「现有记录跨重启恢复 + 连续读取」验收通过**是**上一阶段**的结论，
   **继续有效但不代表新 UI**；**不得**把它改写成新 UI 验收。11/10 之前各条同样只作历史。
10. **Codex 下一阶段（用户已批准，本轮不写）**：方向定为**统一 Host 来源适配 → UI / `usage_status` / 策略共用**；
    早前「GUI-only」提议**已撤回**，不要保留「待用户同意 GUI-only」的旧结论。先完成 MiMo 收尾，Codex 等新会话再实施。


## 2026-11-10 17:00：本轮**实机验收通过**（现有记录跨重启恢复 + 连续读取）

1. **本人明确回报**：「这次可以正常显示了」——managed 面板**余额正常显示**、**每 5 分钟刷新**；
   面板计数 恢复 **1/1** / 自动读取 **55/55** / 换票 **0/0**。
2. **性质**：这是**现有记录跨重启的自动恢复 + 连续读取**在实机通过，**不是**又一次扫码后的首次成功。状态记为
   `passed-this-runtime-restoration`（文档 [docs/mimo-remembered-runtime-acceptance-20261110.md](docs/mimo-remembered-runtime-acceptance-20261110.md)）。
3. **当时安装**：SSO 传输层 = 单文件 `secure-transport.js` `811A4F26…A961F9`，其余 **16 项未改**，`version` 仍 0.9.0；
   权威清单 `.diagnostics/mimo-sso-header-profile-20261109/INSTALLED-MANIFEST.json`（17）。**安装时点 RECEIPT 的 `runtimeVerified:false` 保持原样**（不回填）。
4. **证据强度**：只证明「**当前组合候选（固定 UA/Accept/Accept-Language + 既有恢复路径）在本机这一次运行时通过**」；
   **不**宣称 UA/Accept/Accept-Language 哪一项必要或唯一因果；**不**保证未来长期有效、**不**保证厂商永不再要求登录。
5. **换票观测 0/0** ⇒ **不**宣称「平台票过期后的自动 renewal 已实机验收」。
6. **不再继续**该 scope 的盲改/部署/测试/扫码/额外重启/发布；**不记录**实际金额、账号 UID、截图 token、URL。
7. **未来**若账号要求重新登录，那是**另一次实测事件**，本结论不预支保证。

## 2026-11-09 17:58：上一阶段状态（SSO 固定非敏感头组合候选已装；已被 11-10 验收条目接续）

1. **实机事实**：17:20 本人重启后 safe 摘要为 **header / HTTP 302 / https / `/fe/service/login`**，reason `ACCOUNT_OTHER`。
   服务端返回**普通登录前端页**，不是平台 HTTP 目标 ⇒ **不能断言记录未存/已过期**。
2. **本轮动作（用户明确批准的范围）**：只在 `purposeAccountSso` 内使用**固定 UA/Accept/Accept-Language 组合**，
   模板来自**公开原文 literal（PR#824）**、**未读取本机浏览器信息**；caller 白名单照旧（只 accept+cookie，自带 UA 仍拒）；
   grant 后注入、**冻结 effective headers 重建激活**（SSO 实际用 `active.headers`）；其它 6 用途/legacy 原样；
   URI / Cookie / 目标 / MFA / 预算 / 次数 / 重试**均未动**。
3. **已装（恰 1 项，原子替换）**：`secure-transport.js` `91F8DEA8…` → `811A4F2642B5134C3A8FE0DC49261C4800E660655D4AED86424B86AC86A961F9`（nlink=1/ino 已变）；
   其余 **16 项 + 2 meta 未变**；`version` 仍 **0.9.0**；**登录记录未改**。
   receipt `2026-11-09T09:58:33.482Z`（=17:58:33 +08）：`complete/deployed=true/atomicReplace=true/**runtimeVerified=false**/no real login/no network/no backup`。
4. **权威清单**：`.diagnostics/mimo-sso-header-profile-20261109/INSTALLED-MANIFEST.json`（新 17）；handoff-summary 17 只是本轮 base。
5. **证据强度**：fake 6 + transport 20 / grants 18 / redirect 6 + Max 窄审 = **合成** ⇒
   **不称根因已证、不称任一单项必要、不称登录已修**。
6. **下一步（本人）**：完整退出重开 → existing record **自动恢复一次**；本次**不同时更新其它插件**；
   成功报余额；失败只发**原因 + safe 摘要**（**不发原始 URL/Cookie**）；不忘记/不填 Cookie/不扫码/不连续重试。
7. **止损**：**若仍落登录页 ⇒ 本 scope 停止盲改，不再加 diag、不拓目标。**

## 2026-11-09 16:51：上一阶段状态（交接摘要 safe 5-field 诊断已装；已被 17:58 条目接续）

1. **实机接续**：16:04 本人重启后已见**新诊断** `E_MIMO_CONSOLE_SSO_TARGET_ACCOUNT_OTHER` / restore ⇒ **诊断代码激活成功**；
   **具体账号站路由仍未知**（不是平台 HTTP，**不能猜 HTTP 升级 / UA / 过期**）。
2. **本轮只装「safe 5-field 摘要」诊断**：`handoffSummary{source,status,scheme,pathTokens,truncated}`——
   33 词闭集（未知→`other`→显示 `*`）、最多 8 段、root `[]` 显示 `/`、`status` 只接受 number、未知 extra 字段不透；
   只读取**正常恢复响应里的既有元信息**：不加请求、不 follow 账号新路径、不加 headers/凭据字段、不落盘/不打日志、不改网络或安全规则。
3. **已装 4 项（原子替换，各 nlink=1/inode 已变）**：protocol `835CA3DE→20A7476F…`、controller `15FB626F→B2294E06…`、
   routes `959354B6→A99D36D9…`、client `62E7B8AA→113C5F0E…`（root-hunk-x4）；其余 **13 项 + 2 meta 未变**
   （index `C6813698`/grants `6AA`/store `E05C`/transport 等）。
   receipt `2026-11-09T08:51:29.928Z`（=16:51:29 +08）`complete/deployed=true/atomicReplace=true/**runtimeVerified=false**/no real login/no network/no backup`。
4. **工作区 ≠ 目标**：受测 WS client 是 `67B7E1B1…`（WB dirty），**实际只装 `113C5F0E…` 的 4 个 hunk、未带 WB dirty**。
5. **权威清单**：`.diagnostics/mimo-handoff-summary-diag-20261109/INSTALLED-MANIFEST.json`（新 17）；root-restore 17 是本轮 base。
6. **证据强度**：Core 6 / Manager 21 / shape 5 / redirect 6 / route 7 / UI 35 + Max 窄审**全为合成** ⇒
   **不称登录已修、不称具体路由已取到**；`runtimeVerified` 保持 false（以收据时点为准）。
7. **下一步（本人）**：完整退出重开 → existing record **正常自动恢复一次**；本轮**先不同时更新其它插件**；
   失败贴**交接摘要整行 + 原因码**（截图也只截该区域的安全过滤文本，**不复制原始 URL/浏览器地址/Cookie**）；
   不点忘记、不填 Cookie、不扫码、不连续重试；正常余额则回报；仍无摘要先停查代码/字段流，不先怪用户。

## 2026-11-09 15:51：上一阶段状态（root2 被 0.9.0 formal 覆盖 → 已原子替换复原诊断版；已被 16:51 条目接续）

1. **已证的回退**：`index.js`、`client.js` 被 **0.9.0 formal** 覆盖（`9B19C55B…` / `3E7E0C13…`，mtime 15:03:17，
   在我方 15:02:52 执行后约 25 秒），两者 `nlink=5`（共享 inode，另有 4 条未知链接）。MiMo 其余 15 项当时仍在。
2. **覆盖者/机制未定因**：用户报告「更新了另一个插件」只是**干扰源假设**；主按用户「直接再试装」**停止扩查**，不再追来源/历史/DSH 源码。
3. **已复原（仅代码，不是新功能）**：用**原子替换**（同目录 `wx` 唯一临时文件 `nlink=1` → `rename`）把两个文件换成已审诊断版：
   `index.js` → `C6813698…29DBF`、`client.js` → `62E7B8AA…692736`；两项 `nlink=1`、**inode 已变**，**从未对共享 inode 原地写**（helper 的硬链接反例 smoke 6/0）。
4. **未变**：其余 15 项 + `package.json`/`plans/mimo.js`（protocol `835CA3DE`、grants `6AA`、store `E05C`、controller `15FB` 等）；`version` 仍 **0.9.0**（本次未改 meta）。
   receipt `2026-11-09T07:51:13.704Z`（=15:51:13 +08）：`complete/deployed=true/atomicReplace=true/**runtimeVerified=false**/no real login/no network/no backup`；新 17 manifest == desired。
5. **权威清单**：`.diagnostics/mimo-root-entry-restore-20261109/INSTALLED-MANIFEST.json`；`mimo-sso-target-shape-diag-20261109` 的 17 是本轮 desired/base。
   旧 restore/deployer 一律**非幂等、不可重跑**。
6. **不保证**：原子替换只解决「这次不写穿共享 inode」；**不能保证未来任何按路径的整包重装不会再次覆盖**。
7. **不声称**：恢复的是此前已审的**诊断版代码**，**不表示余额/登录已修**；**具体 SSO 目标 shape 仍未知**；未读取/未清除任何真实 record。
8. **下一步（本人执行）**：**完整退出重开 → 用 existing record 自动恢复一次**；本次**先不同时更新其它插件**；
   不点忘记、不填 Cookie、不扫码、不连续重试；看 managed「记住登录」界面 / 余额 / 细化原因码；**不凭版本号判 formal**；
   若又失去 UI，先停、别重登。不保存个人金额 / UID / URL。

## 2026-11-09 15:02：上一阶段状态（SSO target 形状**诊断分类**已装；已被 15:51 条目接续）

1. **实机事实（接续 18:38）**：11/9 本人重启后 reason 由 `E_MIMO_AUTH_REJECTED`(70016) 变为
   **`E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED` / restore** ⇒ 目标检查确实在拒；**具体 shape 未取到**。
   公开参考里确有 HTTP 提升的做法，但**不因此猜实机就是 HTTP**。
2. **本轮性质**：只做**分类诊断**（9 个固定 `E_MIMO_CONSOLE_SSO_TARGET_*` tag），**没有**网络放宽、**没有** HTTP 升级、
   **没有**新请求、**没有**存储改动、**没有**扩大真实 profile 数据读取许可；9 个 tag **不含 URL / path / query / 票 / ID / 摘要**。
3. **已装（恰好 2 项）**：`console-protocol.js` `93F90677…` → `835CA3DEFF5EB9A3EBE3F77B13261111E2F9E4704AB8D739A936435D56BEAE73`（copy）；
   `client.js` `07EF2C62…` → `62E7B8AACAF458D63BD8FE4342411437F428FF62FCFEECBE4EFDBF3742692736`（**root-hunk-x2**）。
   其余 **15 项 verify 未变**（grants `6AA`、store `E05C`、controller `15FB`、Host/routes/transport/DPAPI/vendor…）；
   receipt `2026-11-09T07:02:52.693Z`（=15:02:52 +08）`complete/deployed=true/**runtimeVerified=false**/no real login/no network/no backup`。
4. **工作区 ≠ 目标**：工作区 client 受测份是 `74BAE6E4…3B26DC7`，但**只装 62E7B8…（2 个枚举 hunk）**，**未带任何 WB dirty**。
5. **权威清单**：`.diagnostics/mimo-sso-target-shape-diag-20261109/INSTALLED-MANIFEST.json`（新 17）；
   `.diagnostics/mimo-console-redirect-fix-20261108/` 的 17 只是本轮 base。
6. **证据强度**：新 5 组 + 旧 redirect 6 组 + UI 23 项 + Max 窄审 = **仅诊断分类的合成 Pass**，
   **不能叫「已定位」或「已修」**；实机是否因此变化尚未复测。
7. **Max 的文字更正（勿误写成缺陷）**：标准 WHATWG URL 显式 `:443` 会**归一成空 port**、会过该检查；
   旧 authority 本就拒非 443/userinfo/hash，**最终允许集合不变** —— 本次只是**提前分类**，不存在「false 默认端口问题」。
8. **下一步（主请用户做）**：**完整退出重开 → 用现有 record 自动恢复一次**；这版**预期仍可能失败**，目的只是**看细化原因**。
   不要填 Cookie、不要点忘记、不要新扫码、不要连续重试；回报**固定原因码/截图**即可，**不要完整 URL**；
   若仍是 generic，先停、查诊断是否激活，**不要先怪用户**。不保存截图里的个人 ID / 金额 / URL。

## 2026-11-08 18:38：上一阶段状态（console SSO 改「跟随服务端 URL/受控 Location」，两文件已装；已被 11-09 条目接续）

1. **CAS 补丁后的实机事实（已过的一半）**：主同一 Host「忘记→重扫」时，**本人新扫码当场余额正常**，保存路径实测走通（不是丢记录）。
2. **仍存在的一半**：同一记录 **fresh restart 仍是账号域 SSO `70016`（通用「登录验证失败」）**——**不要**再说「平台挑战 / 一定过期 / 旧态过期」，也**不能**再让本人重扫来解释。
3. **存储侧已排除**：真实 SDK 经复核为正常 `await` 落盘，**没有证据**显示丢记录；故不再改存储、不读真实 record。
4. **公开源码证据**：两份 **api-platform** 实现（token-monitor PR#824、conky-ai-quota）都是「服务端点 401/302 给出登录 URL → **原样**跟受控 30x」；
   我方旧实现自己 `set _json=true`/`_locale=zh_CN` 且**只认 JSON 200**，属**形状兼容缺口**（形状差异 ≠ 根因已证）。
5. **本轮已装（仅 2 文件 whole-file）**：`console-grants.js` `705C3934…` → `6AA94DF6D51B99A8037314589D77F725604390D588007DFA7E5BAB314625BC4A`；
   `console-protocol.js` `B547A5E4…` → `93F9067715547C8037C398F9CD71B7523E8178D1D11D6CEE3BAAA21AE128C99D`。
   其余 **15 项 verify 未变**（含 store `E05C`、controller `15FB`）。receipt `2026-11-08T10:38:29.333Z`（=18:38:29 +08），
   `complete / deployed=true / **runtimeVerified=false** / no real login / no network / no backup`，两 item `written+verified`。
6. **权威清单**：`.diagnostics/mimo-console-redirect-fix-20261108/INSTALLED-MANIFEST.json`；CAS reenroll 17 只是本轮 base。
7. **证据强度**：6 组 fake（quoted 轮换 exact value+absolute expiry、挂起后 abort/dispose 0 callback、拒 accountLogin/notification/坏 target、旧 JSON `bSecondValidation=false` 兼容）
   + 协议 56/0、SSO rotation 22/0、grants 18/0 + Max 窄审 Pass —— **只证明 compat**，**不证明真实 70016 已解**，也不是实机复现。
8. **授权范围**：本轮用户只授权 **public 静态资料** + **本次 2 文件试装**；真实 record/cfg/browser/账号请求**禁令未扩**；不保存个人 ID / 金额 / token / URL。
9. **下一步（主请用户做）**：**完整退出重开 → 用现有记录等自动恢复一次**；**不点忘记 / 不重扫 / 不连续重试**；
   正常显示即回报；失败只报「阶段/原因」；若出现 `empty`/扫码入口**也先别操作**，先回报。运行验证未完成，`runtimeVerified` 仍 false。
10. **不可重跑**：旧 deployer 均非幂等（目标 hash 已变），本次用户 ask 的 2 文件授权只此一回，不扩未来。

## 2026-11-08 17:10：上一阶段状态（重新登记 CAS/reenroll，两文件已装；已被 18:38 条目接续）

1. **事实链①（SSO 旧态）**：旧保存态在新协议 B547 下重启真实失败，reason 为 `E_MIMO_AUTH_REJECTED`（平台 70016 类挑战）。
2. **事实链②（本轮现象）**：主让本人在**同一 Host**「忘记 → 重新扫码确认」，**未重启**即 `E_MIMO_REMEMBERED_SAVE_FAILED`（stage `store`、0 余额）。
3. **事实链③（根因，源已证）**：`Vault.forget` 写 tombstone 但**返回 void** ⇒ `safeForget` 之后 `casRevision=null` ⇒ 下一次 `confirm.save(null)` 撞 tombstone 必 `RevisionConflict`；重启走 `load` 读到正确 revision 故被绕过。**不是账号问题、不是用户少点确认**。本轮修 2 源（见 4）另加：terminate 后用新 cleanup op/transition 覆盖所有 `safeForget`；`failed`/`paused` 的 retry/resume 各加一行 BUSY gate。
4. **已装（磁盘，本轮只 2 个 whole-file）**：`remember-store.js` `2A6279D7…` → `E05C7AAC…F57E57CA`；`remembered-session.js` `EE675829…` → `15FB626F…7DF997`。其余 **15 项 verify**（含 SSO `console-protocol.js` B547）+ `package.json`/`plans/mimo.js` 未变。receipt `2026-11-08T09:10:58.061Z`（=17:10:58 +08）`complete/deployed=true/runtimeVerified=false/no network/no backup`，两 item `written+verified`。
5. **权威清单**：`.diagnostics/mimo-reenroll-cas-fix-20261108/INSTALLED-MANIFEST.json`；`.diagnostics/mimo-sso-restore-fix-20261108/INSTALLED-MANIFEST.json`（SSO 17）只是本轮 base。
6. **证据仅合成**：真 Vault 同 Host 基线 0/3→**4/0**；去 retry gate 时 D 3/1→恢复 4/0；manager 21/0、store 31/0；Max 主体 + 最后 3 入口 gate 终审 Pass。
7. **事实链④（未验收，不要说已解决）**：新登录的**首次余额**与**跨重启自动恢复**都还没由本人验证；**不声称 SSO 的 70016 已解决**。未读真实 credential/wire；不记截图 UID/金额/token/URL。
8. **不可重跑**：所有旧 deployer 均非幂等（目标 hash 已变），本次 approval 只这一回，不扩未来。
9. **下一步（主请用户做）**：**完整重启**加载新代码 → 旧记住态已被手动忘记，出现「未记住/扫码入口」属预期（不是又丢记录）→ **不再额外点忘记**，新扫码一次并确认、先看**当场余额** → 当场正常就立即重启检查恢复 → 任一步失败标注「确认后未重启」或「重启后」，只报阶段/原因，停、不反复扫码。

## 2026-11-08：上一阶段状态（MiMo SSO 恢复修复，单文件 console-protocol；已被 17:10 条目接续）

1. **事实链**：本人初扫后确认当时余额正常 → 重启后出现失败，诊断显示固定 `reason=E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING`（stage `restore`）→ 11-07 先装「失败真因可见性」客户端 patch → 11-08 装 SSO 顺序/seed/signature 候选，**等本人恢复验证**。
2. **已装（磁盘，仅 1 文件）**：`plans/mimo-auth/console-protocol.js` 旧 `D1C1BCCD…3AED88` → 新 `B547A5E4…0616F14`（whole-file）；其余 16 项已装文件 + `package.json` / `plans/mimo.js` 只 verify 未变。receipt `2026-11-08T06:20:45.738Z`（=14:20:45 +08），`status=complete / deployed=true / runtimeVerified=false / realLoginPerformed=false / networkUsed=false`，`checks=29 fail=0`。
3. **权威清单**：`.diagnostics/mimo-sso-restore-fix-20261108/INSTALLED-MANIFEST.json`（+ `RECEIPT.json`、`plan.json`、`deploy-sso.mjs`）。11-07 recovery-fix 的 17 项只是**本轮安装 base**，不是当前状态。
4. **证据只在合成范围**：targeted 22/0、协议 56/0、remembered 29/0（旧预期未改）；Max 协议窄审 Pass（script `FC98D922…`，含 meta fail-closed 门）。**未做本人新 runtime 复测、未读真实 wire/账号 ⇒ 不声称根因已修，也不声称账户一定未过期。**
5. **不可重跑**：旧 deployer 均非幂等（目标 hash 已变），本次 approval 只这一回，不构成未来安装/发布许可。
6. **下一步（主请用户做）**：完整退出重开（必要时硬刷新），**不点忘记 / 不重扫**先试现有记录；正常显示余额则再重启一次确认；若失败只报「阶段 / 原因」，**不把外层 `AUTH_REJECTED` 当原因**；需要交互（真实 70016 等）尊重厂商流程不绕。
7. 不记录截图账号 UID、任何金额、密钥或 URL。

## 2026-11-07：上一阶段状态（MiMo「记住登录」B，managed 模式；已被 11-08 条目接续）

1. **已本地磁盘安装**：`node .diagnostics/mimo-remembered-install-20261107/deploy-remembered.mjs --execute` 由主按经审原命令执行一次，receipt `2026-11-07T10:26:49.438Z`（=18:26:49 +08）。
   结果：`status=complete / deployed=true / runtimeVerified=false / realLoginPerformed=false`，**17 文件 closure（8 写 + 9 verify-only 未变）**，`checks=24 fail=0`。
2. **尚未重启、未真机恢复**：磁盘已换新不等于运行时已激活；真实 scope / credentials 服务 / DPAPI 生产分支与真实账号恢复**均未验证**。
3. **权威清单**：`.diagnostics/mimo-remembered-install-20261107/INSTALLED-MANIFEST.json`（+ `RECEIPT.json`、候选 `root-hunks.json`）。
   `mimo-console-install-20261106/INSTALL-MANIFEST.json`（14 文件）只是**前阶段基线**，不是当前状态。
4. **旧用户实机「15 min 短链」通过不等于新 B 通过**：那是旧手动链的验收，新 B 是 managed 记住登录，需本人按主线文档的顺序实测（首要：完整重启 + 首次扫码确认 + **不点忘记直接重启**看自动恢复）。
5. **部署脚本不可重跑**：安装后目标文件 hash 已不再匹配 baseline，再跑会因 `oldSha` 不匹配失败；那次 approval 不构成未来安装/升级许可。

## 2026-10-28：等待、复用、并行上限

1. **没有独立工作时暂停当前回合。** 如果主代理剩下的只是等待子代理完成，可以先暂停，让子代理继续工作；完成后会自动汇报，再继续审查/整合。不要忙轮询、sleep占位、重复子代理工作或为了保持运行制造无意义任务。暂停等待不等于中断子代理、放弃任务或擅自更改自动目标开关。
2. **优先复用已有子代理。** 委派前检查已有代理的模型、状态、职责和上下文；适合本任务且可继续的代理，优先通过`send_message`续接（包括已完成但可继续的代理）。没有必要不要新建，以免累计大量代理。只有现有代理不适合、不可继续或确需独立上下文时才新建，并简要说明理由；不能为复用而继续调用已被禁止的模型。
3. **按独立构建包并行，最多4个。** 能拆分的具体实现可同时分给多个代理，例如Host、客户端、测试、独立审查；不必串行，也不为凑数强开4个。**同时运行的子代理及其后代合计不得超过4个，不含主代理**。主代理统一调度并在委派中传递上限，不能靠子代理再委派绕过。任务要明确文件写入边界、接口合同和验收条件，避免同文件并发覆盖；主代理负责整合和独立验收。

## 2026-10-29：主代理只规划指挥，实施与验证交子代理；审核取最小必要

1. **主代理只做规划/指挥/最必要验收与报告**：不亲自实现、不构建、不重复跑验证。所有具体实施、运行、测试、文档交子代理（仍 `provider: workbuddy` / `model: cn:deepseek-v4.1-flash`，`high` 或 `max`；优先复用已有代理，含后代合计 ≤4）。
2. **审核与验证按风险取必要项**：不叠加大矩阵、不反复封存、不重复跑已完成测试；一次交付一次短审，只追阻断项，不追非阻断的形式问题。
3. **安全边界不放松**：真实故障必须可复现（一次真实 baseline；若要称"复现"须再重复一次同结果 + 一个干预对照）、"baseline 不失败 ≠ 已修"、不动生产/真实配置/凭据、不起服务或联网等边界照旧。
4. **只在等待时暂停当前回合**：不忙轮询、不做无意义任务。

## 既有模型约束（继续有效）

用户另行明确变更之前，本项目子代理只使用`provider: workbuddy`、`model: cn:deepseek-v4.1-flash`，显式选择`reasoning_effort: high`或`max`。不使用默认路由、GPT子代理或可能继承错误模型的fork；复用已有代理也必须确认其符合此约束。

## 2026-11-01：权限敏感动作由主代理代执行

1. 预判子代理固定权限不足的**已获当次业务授权、已审原命令**，直接交由主代理代执行原命令；子代理继续普通实现、工作区测试、准备、审查、后验和文档，不先让子代理反复失败再转主，也不反复让子代理请求其继承不了的权限。
2. 不再每次为这一“主体代执行”单独询问例外；实际新部署、联网、账号、读 cfg 等范围仍需具体许可。平台明确拒绝时停止，不自动更改权限、ACL 或换命令，不把主代理代执行当作绕过审批。
3. 用户临时切换执行权限由用户本人完成；当前 approval policy 为 never 时不设置 `sandbox_permissions`。本规则仅适用于权限敏感动作，不是主代理接管所有实现和测试。

上述规则是长期协作偏好，不自动扩大部署、重启、联网、真实账号或发布许可；具体操作仍逐项遵守当次授权范围。

## 本次恢复入口（2026-11-06，本轮最新续接）

### 当前实施状态与本轮分工例外

- **2026-11-07 用户需求变更（存储/恢复边界，取代“仅内存/必须事前 expectedID”）**：用户要求 MiMo 像 DeepSeek/WorkBuddy 一样**启动自动恢复并显示余额**；**同意必要凭据通过安全存储或安全加密本地保存**；取消首次扫码前手填 expected 账号ID，改为**扫码后展示可信昵称（优先）/ID 由本人确认绑定**，恢复仍严格核对稳定账号 ID。**不授权**真实账号/配置读取、主替扫码、重启/发布、把平台短票或余额未加密落盘、记录实际金额/账号尾号。自动恢复不得代码伪调 `confirmedByUser:'match'` 冒充本人比对，需独立的“首次本人确认账号并记住、允许未来自动读/刷新”授权；昵称仅待确认 UI 可见。**主已定后端**：Windows DPAPI(CurrentUser) 整 record 加密 + credentials grant 只放密文，无明文退路；record 含 `preferences.paused`（暂停刷新跨重启），暂停保存失败即 fail closed 停止并 forget 当前密文（可能需要重扫）；scope 用 `ctx.get('profileContext').dir` 解析路径（不可只用 dshHome，多 profile 会共享），owner key `plan-usage`（index.js:67）。本归档公开 credential/storage 契约不提供加密（safeStorage/DPAPI/osvault 字节 0 命中；Host 是 `ELECTRON_RUN_AS_NODE` 子进程），见[存储取证](docs/mimo-persistence-storage-evidence-20261107.md)。

- **2026-11-07 重启恢复故障（本人真实事实，诊断补丁已装）**：用户明确**曾点确认且当时余额正常**；随后完整重启后 UI 显示「记住登录已停止：E_NONE」。**不能说漏点确认，也不能说新 B 已跨重启通过**。已装 4-file 诊断补丁只修**错误可见性**（snapshot/routes 的 `reasonCode`/`failureStage`，保留 sealed 协议码），SSO 真实根因未修、未读其真实 record；旧「身份不符」保护可能曾 forget，未知。权威目标 manifest：`.diagnostics/mimo-remembered-recovery-fix-20261107/INSTALLED-MANIFEST.json`（17 项，runtime 未验证）；旧两个 deploy 均非幂等不可重跑；protocol/grants/transport/store/DPAPI/index 未改。本人下一步：完整退出重开 DSH（必要时硬刷新），**不忘记/不改 Cookie/不重扫**，复制「恢复失败…」「阶段/原因…」两行；若变未记住或其它状态先报文字，不立即扫码。

- **最新本人短时验收进展（2026-11-07）**：用户真实扫码→身份核对→接入→余额读取→正常胶囊/详情→授权后自动刷新已走通；先前截图5/14且取数时间推进，用户明确收起界面等待后再打开计数增长，无MiMo消费所以金额不变。随后用户等到上限，截图 `E_MIMO_AUTH_DISPLAY_REFRESH_EXHAUSTED`、详情与胶囊均“已停止”且无旧余额；**本地刷新授权上限触发的UI终止/旧值移除路径也已观察通过**。该码还用于刷新授权deadline，截图不单独证明15分钟独立计时路径或内存擦除；更不是厂商票过期。当前短时闭环可收口，无需重启/重扫/改代码或制造消费。真实401续期/长时运行/跨重启仍未验，当前仅内存15分钟/60秒/最多14次；若下一阶段延长这些上限，须取得新的具体授权，不自动扩大窗口或凭据持有。代理仅看用户截图，不自主网络读取、不落实际金额/账号尾号/凭据。此前待验说法为历史；usage_status仍原lane。

- **2026-11-07 最新本人结果**：用户扫码后首次截图为“已确认，待接入显示”ready，真实认证／身份核对阶段已成功；此前各“尚未真实登录成功”为历史。随后用户接入并首次读取余额，截图 `E_BALANCE_PARSE`，显示停止，真实余额尚未通过。代理未读真实回包／账号／金额。只读原[MiMo契约](plans/mimo.js#L4-L9)发现金额为string，而新链直交number-only投影漏转换；正确契约例旧52/1。仅protocol新增私有四字段入口，规范十进制string（≤64）转number，仍原finite非负＋真实currency；不补0／CNY、不cash-as-total、不别名搜索、不改shared display。修后protocol56/0、e2e59/0（wire金额全string），Max最小helper/1行静态无阻断。**已只覆protocol1文件并验证仅helper/1行差异，14/14闭包匹配；引号补丁和enabledHost保留，无新备份／代理重启或请求。等本人重启再扫码接入读一次。**[补丁清单](.diagnostics/mimo-console-install-20261106/PATCH-DECIMAL-WALLET-MANIFEST.json)。不得称实际回包仅因string，或真实余额／持续刷新已成功。

- **最新第六次失败与引号兼容授权**：用户截图 `E_MIMO_CONSOLE_PLATFORM_COOKIE_VALUE_FORMAT`，真实值未读取，不能认定引号就是实际原因。主解释后用户明确“这样的话我觉得挺合理，允许”：**仅本次允许最小修改此前只读的 vendor/cookie-jar.js**，新增默认false的allowQuotedValues（仅严格true），console的7个Jar显式启用；旧memory-flow/session不传，默认predicate不变，其余vendor/旧链保护未解除。Jar保留引号原字节出站，不decode/unescape/重编码；console-grants只为匹配合法引号内容且非空更新出站验证；protocol仅做语义比较去外引号，原header仍带引号，身份/域/用途不变。正确quote例修前49/1；修后新quoted套8/0、直接受影响grants18/0、protocol52/0、e2e59/0，Max仅3源差异无阻断。**3文件已覆盖（含vendor Jar），14/14闭包核对，Host仍启用，无新备份/代理重启或请求。**等本人重启再试，尚未真实登录/余额成功。清单：[可选引号兼容补丁](.diagnostics/mimo-console-install-20261106/PATCH-QUOTED-COOKIE-MANIFEST.json)。

- **最新第五次试用与补丁**：用户截图 `E_MIMO_CONSOLE_PLATFORM_COOKIE_DOMAIN`，失败已在平台响应Cookie接收，不是LP；实际Cookie／域未知。主修2源protocol/client：账号入口改固定class共享算法，平台仅精确HTTPS platform.xiaomimimo.com，parent=xiaomimimo.com只收窄到platform主机，原4平台凭据名才解析，永久Jar不放宽；首次callback/freshSSO/balance200续发/401删除全同入口，fresh失败finally清、成功清旧票；补13固定原因码无数据外泄。正确父域例旧44/1，修后protocol49/0、e2e59/0，Max两文件静态无阻断。**已覆盖2文件，14/14闭包匹配，Host仍启用，无回退/代理重启或请求，等本人再试。**见[平台补丁记录](.diagnostics/mimo-console-install-20261106/PATCH-PLATFORM-COOKIE-INTAKE-MANIFEST.json)。不得称真实认证／余额已成功；普通provider/usage_status仍原lane。

- **最新第四次试用／补丁**：用户仍报 `E_MIMO_CONSOLE_LP_COOKIE_POLICY`，实际被拒行未知，无回包读取。主承认前因码太粗导致多轮扫码，不能将错误变化称真实修好。已修本地无关Cookie也先probe而误阻断的缺陷：账号响应先精确匹配原4名，其他行直接丢弃、不入Jar不出站；必要4名仍完整验证／窄化／身份比对／冲突／撤销／Path TTL不变。必要凭据细分26个LP/ACCOUNT固定原因码（CRLF、VALUE_FORMAT、EXPIRY_FORMAT、DUP_DOMAIN、DUP_VALUE、COUNT_LIMIT等），仅枚举不含实际数据。正确排除例旧实现42/1，修后协议45/0、e2e58/0，Max2文件静态无阻断。**已覆盖协议和client白名单2文件，14/14闭包匹配、Host仍启用，无代理重启／请求／备份；等待本人下次测试。**清单：[凭据限定入口补丁](.diagnostics/mimo-console-install-20261106/PATCH-CREDENTIAL-ONLY-INTAKE-MANIFEST.json)。真实登录、余额均尚未成功验证。

- **最新第三次试用**：用户手机确认后插件固定码 `E_MIMO_CONSOLE_LP_COOKIE_DOMAIN`；已确认是 LP 响应Cookie域解析拒绝，不知道具体Cookie／域，不记录账号ID或回包。仅协议新增账号入口窄化接收：原始每行先按真实账号来源和原Jar验证，合法父域xiaomi.com的原有4凭据名单向收窄到account.xiaomi.com，必要外其它已验证Cookie丢弃；不改平台、grants/transport、网络目标、host-only/Path/TTL。跨所有路径冲突、删除/到期不可被JSONseed覆盖，外域/公共后缀/兄弟域仍拒。修前正确父域例37/1，修后协议43/0、e2e57/0，Max最小差异无阻断。**已单文件覆盖，14/14闭包核对，Host启用未变；无新回退、无代理重启／请求，等本人重启后测试。仍未真实登录或余额成功。**清单：[账号Cookie补丁](.diagnostics/mimo-console-install-20261106/PATCH-ACCOUNT-COOKIE-SCOPE-MANIFEST.json)。

- **最新第二次本人试用**：手机扫码确认后显示登录成功，但插件报 `E_MIMO_CONSOLE_UNSUPPORTED`。上次safe-integer修正未证明真实链成功，亦不能据错误码变化认定首次根因。主没有再猜字段或放宽域，补齐原unsupported所有抛点的20个预定义原因码（JSON/LP Cookie域或其它策略/seed冲突/挑战/未知跳转/SSO/平台Cookie等）；只读Jar拒绝固定枚举，不含账号/Cookie名值/URL/回包/原异常，不新存实际响应。协议38/0、e2e57/0；Max只读差异确认无阻断。**2文件诊断补丁已覆盖并核对14/14完整闭包，正式入口仍启用；未自动重启或请求。等待用户重启后一次定位测试，只需回新的固定错误码。**详见[安装及试用记录](docs/mimo-console-install-20261106.md)。真实登录／余额依然未成功验证。

- **本人首次真实尝试反馈及修正**：用户已见真实二维码、手机可确认登录；手机确认后正式面板报 `E_MIMO_CONSOLE_AUTH_REQUIRED`。未读取/保存上游响应，**未认定真实故障根因**，不要记用户账号ID。核对原pin参考发现当前实现错误地只收string userId；新增正确兼容例在旧实现得到28/1（numeric例失败），修后协议34/0、numeric真实代码链e2e56/0，Max对3源文件差异静态Pass。仅允许词法纯正整数且安全可精确表示的数字ID归一化，身份三方比较不变；新增4类固定错误码区分seed/ID/账号态/平台态，不透上游数据。补丁已精准覆盖安装3文件，14文件闭包核对一致，入口仍启用、无新备份或重启/请求；**等待用户重启后再试，尚未证明真实登录成功**。清单：[补丁记录](.diagnostics/mimo-console-install-20261106/PATCH-ACCOUNT-ID-MANIFEST.json)。

- **最新安装（2026-11-06 16:24:26 +08:00）**：用户明确要求直接覆盖、不准备回退；已完成 desktop 插件 MiMo 主线覆盖，14文件闭包匹配，实际覆盖6/新增3/不变5。安装副本 Host 注册显式 `enableConsoleProtocol:true`，**不再是安装副本默认关闭**；工作区源码默认仍关闭。无新备份/回退脚本，不删旧备份，不动配置或版本，仍0.9.0。安装清单与后续本人测试见[直接覆盖记录](docs/mimo-console-install-20261106.md)。**未自动重启、未真实登录；等待用户本人重启和测试。**
- 现场是官方入口/客户端 + 9份旧辅助文件残留，并非“认证目录全部不在”；glob漏报已由逐文件哈希纠正。旧11文件安装清单是历史，不能再拿其预期hash或回退脚本直接套本轮14文件状态。新安装无回退准备，不自动恢复旧状态。

- 原始参考已回到用户指定的 XiaomiTokenMonitor / xiaomi-mimo / dsh-mimo-connect / dsh-token-stats；CodexBar 不作认证与续期主线。四项目证据见 [原始参考核查](docs/mimo-original-reference-evidence-20261106.md)。
- 用户已允许扩展 `secure-transport.js` 的精确正式用途；A1 授权模块与 A2 传输接线已有新增定向测试 18/0、20/0。**新实施上下文已补完 D/L、内存登录 manager、Host/路由、显示释放及 client 接线**：协议新套 29/0，管理层作者 16/0、主修后 17/0，console e2e 作者 49/0、主修后 54/0（均 exit 0）。主修问题是 display 释放后非密记录仍 claimed 导致不能重新登录；并补证旧会话仅 local start 就能测互斥、无需加载 legacy flow。原 Max 已完成 **一次独立终审：Pass（仅限本地合成主线闭环），无阻断项**，见[终审记录](docs/mimo-console-mainline-review-20261106.md)及[主线实施记录](docs/mimo-console-mainline-20261106.md)。审核未改源码、未重跑测试。非阻断观察保留，不开新整改轮。全部仍为 fakeDNS/HTTPS，未做真实协议验证。
- 用户明确同意主代理本轮接管实施/定向测试以结束旧 High 的碎片化续接；主只在协议内核的 `openOp` / `closeOp` 做了两处修改，随后用户又建议换全新实施上下文。旧 High 已停止写入。
- 用户查看旧 High 的 GUI 上下文约 45%（454K/1M）。**没有已核实的上下文超限错误**；代理自述“容量用尽”不能当作原因。主已纠正此前未经核实的归因。
- 用户通过确认工具明确允许 **本次一个实施代理的 workflow**，固定 `workbuddy` / `cn:deepseek-v4.1-flash`，并只对本次允许工具默认推理等级（不能声称已显式 high）。新任务 `workflow-958ae1ea8a8c48f9` 已完成、结果已收取；运行时主未与其并发改源码，交付后主只修必要接口问题并重跑直接涉及的两个新套。原 Max 已据完整交付完成独立终审，结论为仅限本地合成范围的 Pass。这是本轮例外，不改长期模型约束。
- 本轮正式协议源码、Host/路由/客户端接线及定向离线测试属于工作区实施；**不授权真实登录/二维码/账号/余额请求、配置或浏览器数据读取、凭据持久化、安装/重启/发布**。新正式入口先用代码级关闭开关保护，不得从 UI/JSON 开启真实模式；测试启用走实际协议实现、仅 fake DNS/HTTPS。
- `dynamic-policy.js`、旧 `session.js`、`vendor/*`、`plans/mimo.js`、`index.js` 与 WorkBuddy 不在本轮修改范围；当前已装 11 文件和 `103258-files` 备份保持不动。下方“尚未开始/仍只读/未重启”仅对应其历史时点。

### 2026-11-06 11:00 用户 GUI 观察（历史时点，仍有效）

**用户**本人在 GUI**的观察，不是 agent 访问 GUI**

- 用户已**手动重启** DSH、**未报错**；设置页**两个面板可见**（用户截图确认）。
- 点入口**查询 capability 成功**；两个 opt-in 均 `false`；点 start 后显示「会话已创建 / 已创建待开始」。
- **未点 begin、未 QR、未扫码、无真实 auth/balance 结果**。
- ⇒ 这只是**用户侧 GUI 观察**；**不得**再沿用"当前未重启 / 全无运行验证"的旧表述（那是 **10:32 时点**事实）。
- **安全事实（旧源码，本轮未改）**：`plans/mimo-auth/vendor/memory-flow.js` **L609–663 自动 receipt → follow / SSO**，
  **L770–772 随后 `gateBalance`**；**display/postQR 的 DI disabled 并不能阻止旧默认路径取余额**
  ⇒ **不能**凭"两个 opt-in 为 `false`"就判定扫码安全。
- 用户已**放弃**"为一次测试另做回执即停版"，回**正式主线**；主线仍缺真实 receipt carrier / namespace / audience / endpoint 证据，
  **不编造 adapter、不加合成壳**；主代理正在确定**最少证据获取范围**。
- **2026-11-06 11:26 证据记录**：主已匿名只读四份第三方公开材料并写下
  [原始参考证据](docs/mimo-original-reference-evidence-20261106.md)（XiaomiTokenMonitor 锁 `6f0edbb…`、
  PyPI `xiaomi-mimo` 0.2.0 元数据、`dsh-mimo-connect`（commit 未锁）、`dsh-token-stats` 锁 `5615ece…` 但仅前 324 行）。
  均为**非官方**线索：`schema`/`clientSign` 未读、carrier/namespace/audience/endpoint 仍缺 ⇒ 不编造。
  主决定：正式链分**账号态/平台态（均内存）**，signed context → SSO 平台票 → 绑定预期账户 → 本人确认 readBalance →
  另授权 display refresh；singleflight + 跨代 cancel + 鉴权失败最多一轮换票 + 余额一次重试，`status` 零网络，
  未知/MFA/captcha/撤销 fail-closed；**旧动态 LP 只读、认证结果用途须独立授权**。
  ⚠️ `secure-transport` 本轮**只读**（仅 longPoll `never other purpose`），正式链要增
  `authReceipt`/`accountSSO`/`platformCallback`/`balance` 用途**需用户一次确认解除只读**，未确认前不得改。
  ✅ **2026-11-06 11:26 用户已明确允许**修改 `secure-transport.js` 扩**精确正式用途**；
  `dynamic-policy.js` **仍只读**、旧 LP 防线不取消。第 1 包范围（授权已给、**尚未开始实现**）：
  `secure-transport.js` 扩用途 + 新 `console-grants.js` + 新 `console-session.js` +
  `tools/test-mimo-console-transport.mjs`/`test-mimo-console-session.mjs` +
  `docs/mimo-console-mainline-20261106.md`；**不**改 `session.js`/`vendor/memory-flow.js`/`dynamic-policy.js`/
  源 `plans/mimo.js`/`index.js`/`workbuddy.js`；不部署/不真实请求/不跑旧套。

- **协作角色（用户 2026-11-06 09:38 再次确认）**：**主代理负责方案与技术决策、并亲自读获准范围内的源码**；
  具体实施 / 脚本 / 测试 / 文档交 **High** 子代理；**Max 在交付后做一次终审**（本轮专项的终审范围
  被限定为 B1–B8 / N1–N5 差异；这是**本轮限定**，不作为未来所有审核的永久范围）。
  不重复循环构建、不叠加大矩阵、不重跑旧 26/21/56。

### 2026-11-05/06：MiMo 本机显示会话（sessionDisplay）实现轮

- 交付（**仅本地合成**）：`plans/mimo-auth/session-display.js`（独立 display manager，
  `absent/holding/verified/stopped/expired`）、`routes.js`/`host.js` 的 `display*` 严格动作与 DI 注入
  （生产恒 null ⇒ fail-closed）、`client.js` 的 store/hook/面板 + 胶囊详情 overlay + 详情内可见停止入口。
- **测试（2026-11-06 最后一次实跑，全绿）**：
  `tools/test-mimo-display-session.mjs` **78/0**、`tools/test-mimo-display-client.mjs` **39/0**、
  `tools/test-mimo-display-e2e.mjs` **50/0**（真实 `createAuthHost` + 注册 handler 桥接 + 真实 client.js，
  经 UI 按钮走 start/read/confirm/grant）。旧 26/21/56 **未重跑**。
- **根因更正（此前"测试装配错误"的说法仅作历史）**：e2e 连环红的三个真实原因分别是
  ① **Host `revision` 每代重置**导致 client 丢弃新 generation 的低 revision（已改 manager 级全局单调 revision，
  client 改为 generation 前进即接受、旧 gen 永拒）；② e2e fixture 设了 `adapterIdentity=B` 却用 `ID_A` 起会话
  （Host 正确拒绝，不是缺陷）；③ 预算 case 在 `poll=0` 下用 **client store** 代表 Host 终态（已改为先经
  **注册 handler 读原始 displayStatus** 再断言 client 投影）。
- 边界：旧单次链语义与销毁承诺**未改**（`session.js`/`failure.js`/`index.js`/`plans/mimo.js`/
  `dynamic-policy.js`/`secure-transport.js` 均未修改）；未构建/未部署/未改版本/未发布。
- 仍未证：真实余额 method/path/scope/audience、auth result 字段与载体、独立 expected 身份来源、
  上游 cancel/revoke。**合成通过 ≠ 真实可用；本地清除 ≠ 上游注销；本地 TTL ≠ 厂商有效期。**
- **审核状态（2026-11-06）**：**本地合成 Pass** —— 作者实跑 78/39/50，Max 做**静态差异复核**并 Pass
  （B1–B8 全闭、N1–N5 落实），记录见
  [Max 复核 §6–§7](docs/mimo-session-display-review-20261105.md)。**真实链仍未完成**（全部 disabled）。

### 2026-11-06 10:32 本地磁盘试装（MiMo sessionDisplay）—— **历史时点记录**
（当时未重启；此后用户已**手动重启**，见顶部「最新事实」。旧条不删，仅作时点存档。）

- **已装（磁盘）**：目标 `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock`（**formal 0.9.0 基线**），
  **11 文件 = 2 覆盖（`index.js`/`client.js`）+ 9 新增（`plans\mimo-auth\` 含 `vendor\`）**；
  `INSTALL-MANIFEST.json` `status=complete`/`deployed=true`；11 个写后 SHA 全匹配。
- **备份（唯一可用回档）**：`…\20261106-101818-formal-0.9.0-pre-mimo-sessionDisplay\backup\20261106-103258-files`（仅 2 个被覆盖旧文件）；
  早前两个空目录**不是备份**。
- **版本/元数据未动**：插件 `package.json` 保持 **0.9.0**（仅文件叠加，不改 metadata/根 package/`cordis.patch.yml`）。
- **排除**：WorkBuddy/账号端点 5 个 hunk（H1/H2/H7/H12/H14）未部署，源仓库改动仍在工作区、未改源。
- **未重启 ⇒ 运行态未验证**；真实 DI 仍 `null`（该状态下 `displayStatus` = 可信 absent HTTP 200、`displayStop` 幂等 200，
  **仅** `displayStart/Read/Confirm/Grant` 为 `503 DISPLAY_DISABLED`）；
  **QR 代码装入 ≠ 运行期二维码/扫码可用**（Beta2 可见为历史观察）。
- 回档：`pwsh -NoProfile -File "<R>\rollback-formal-trial.ps1"`（预检）/ 加 `-Execute` 恢复；回档后用户手动重启。
- 记录：`docs/mimo-session-display-install-trial-20261106.md`、`<R>\INSTALL-HANDOFF.md`；
  **装后核对已 Pass**（Max：stage==target 11/11、old backup 2/2、rollback 预检 exit 0 = 2 restore + 9 delete、闭包解析全），
  见 `<R>\INSTALL-REVIEW.md`。**该 Pass 仅限磁盘已装，不代表真实运行**（未重启、DI null）。

## 本次恢复入口（2026-11-05 17:16 停止后更新）

- 新会话最新先读 [SESSION-HANDOFF-20261105](.diagnostics/mimo-dynamic-20261101/post-qr-local/SESSION-HANDOFF-20261105.md)；[PUBLIC-RESEARCH-HANDOFF](.diagnostics/mimo-dynamic-20261101/post-qr-local/PUBLIC-RESEARCH-HANDOFF.md) 是研究明细，[LOCAL-RESULT-HANDOFF](.diagnostics/mimo-dynamic-20261101/post-qr-local/LOCAL-RESULT-HANDOFF.md) 是已完成本地阶段，[SHUTDOWN-HANDOFF](.diagnostics/mimo-dynamic-20261101/post-qr-local/SHUTDOWN-HANDOFF.md) 是 11/1 历史。
- 用户 2026-11-05 17:16 明确停止所有实现与调研：无自动联网/QR/账号/代码/部署/现场核验；本地 26/21/56、五源固定、production adapter disabled、11/1 `.2`/`211332` 恢复链继续作为历史事实。
- Goal **20** 最后已知 paused/disarmed，恢复请求被拒不重试；Goal17/19 为历史。模型不改 goal 存储/不另建；临时许可均非长期放权。
