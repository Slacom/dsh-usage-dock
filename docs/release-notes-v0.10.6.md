# dsh-usage-dock 0.10.6

> **上一公开版**：0.10.5（GitHub Release + npm）。0.10.3 / 0.10.4 是**本地构建、从未发布**的过程版本。

## 更新摘要（GitHub Release 正文）

- **Codex 订阅适配支持第三方 3.2.17**：一键适配能识别 `dsh-codex-subscription` 3.2.17（保留对 3.2.6 / 3.2.13 的支持）。
- **「需适配」不再只给一句话**：现在会直接显示第三方插件**已装版本**，以及本插件**已收录的版本清单**，
  一眼就能判断该「升级本插件」还是「重新应用适配」。
- **三种状态分开显示**：已适配时只提示重启 DSH 生效、不再出现多余的按钮；可适配时给出一键适配按钮；
  版本暂不支持时明确说明是「没有收录该版本」还是「已收录但本机文件与已知基线不一致」，不再让人猜。
- **读不到适配状态也不会变差**：状态查询失败时仍按原样提供「应用本地适配」按钮，行为与之前一致。
- **本地适配仍是只读补丁**：只改第三方插件里的只读读取桥，不碰账号、凭据与网络请求；
  第三方插件升级或重装会覆盖补丁，之后重新应用一次即可。

## 工程细节（维护者用）

- **第三方 3.2.17 的差异只有一处**：`lib/index.js` 的 `onAccountChanged` 首行新增
  `remoteBridge.clearUploads();`（在 `subagentCatalog.clear()` 之前）。这使 3.2.13 清单里
  `revision-bump-on-account-changed` 那条**包含后续清理行**的锚点失配，因此 3.2.17 的锚点收在
  handler 开口处（`onAccountChanged: () => {` 之后），只插入 `usageBridgeRevision += 1;`；
  其余 3 条 hunk 与 3.2.13 逐字相同。
- **新增清单** `plans/patches/codex-subscription-3.2.17.json`：
  `baseSha = 33f07e968ad8df0606b21712d6918e4c5ed658551b52b2303ca4230a00c4df10`、
  `programSha = 687ef5bbdca8de512157f01ecdb7fd4b1a632342fec1402084c7705bdbd2f7fb`，
  版本与已装 `package.json` 精确匹配才生效（不做范围/模糊匹配）。
- **清单继承机制**（`plans/codex-subscription-patch.js`）：清单可写
  `"inheritFrom": "<父清单 version>"`，此时 `hunks` 只写**覆盖项** `{ id, old, new }`；
  `listManifests()` 先把父清单（本身就是展开后的结果）作基底，再按 `id` **原位替换**，
  子清单其余字段（version/file/baseSha/programSha/schema/note/final）以子清单为准。
  继承链 **fail-closed**：缺父清单 / 成环 / **继承链超过 4 条继承边** / 覆盖 `id` 不在父清单
  ⇒ 该清单判为非法并跳过（绝不「追加」hunk）。所有对外函数（`manifestForVersion` / `hunkHits` /
  `readPatchState` / `applyPatch` / `revertPatch`）都只看到**展开后**的清单。
- **继承深度上限的 memo 绕过缺陷（终审发现，已修）**：旧实现 `resolveManifestEntry` 带 memo 缓存，
  按清单缓存「以 depth 0 展开」的父链结果；清单目录按文件名排序（父先子后）时，父链先以 depth 0
  解析并缓存，子清单随后直接命中缓存，于是 `MAX_INHERIT_DEPTH = 4` 形同失效（修复前实测 6 条继承边
  被全部接受）。现在去掉 memo、深度按**当次递归路径**累计：4 条继承边以内可解析，第 5 条起该清单
  被判非法并跳过。可复现证据：新增 W13–W15——目录 `9.9.00 → … → 9.9.06` 父先文件名序下，
  `9.9.05` / `9.9.06` 被拒绝、`9.9.04` 对照可解析；超深版本的 `readPatchState` 为
  `unsupported`（`manifestAvailable:false`），`applyPatch` 抛 `E_CS_PATCH_UNSUPPORTED` 且目标零写入。
- **`GET /api/plan-usage/codex-subscription/patch-state` 新增两个只读字段**（旧字段语义不变）：
  - `manifestVersion`：与**已装版本**精确匹配的清单版本（继承链已展开）。语义要点：
    清单命中但目标文件 sha 既非 `baseSha` 也非 `programSha`、或目标文件缺失时，`state:'unsupported'`
    但 `manifestVersion` **仍等于已装版本**；只有完全没有匹配清单时才为 `null`。
  - `covered`：本包清单目录里所有**合法**清单的版本号数组（纯版本号、升序、不含路径）。
    旧版补丁模块（混合部署）没有 `coveredVersions()` 时退化为 `[]`，路由不整体失败。
  路由仍是纯只读 metadata：不 import 第三方模块、不读凭据、不联网（仅动态 import 本包自己的
  `plans/codex-subscription-patch.js` 读取清单）。
- **客户端「需适配」块改为版本感知**：挂载（行状态 = incompatible）时发**一次** GET `patch-state`
  （不重试、不轮询、卸载后不 setState），按三态渲染：
  `patched` → 「已适配，重启 DSH 后可读取订阅额度」（无按钮）；
  `appliable` → 「第三方插件 <version>，可一键适配」+「应用本地适配」按钮（沿用原 POST 逻辑与固定结果文案）；
  `unsupported` 再按 `manifestVersion` 分两种（**都不给**按钮）：
  - `manifestVersion === version`（有清单但本机文件与基线不符）→「第三方插件 <version> 已收录，但本机
    第三方文件与已知基线不一致，无法一键适配；建议重装或升级该第三方插件，或用命令行工具检查。」
    ——**不会**再出现「暂无适配清单（已收录 …）」这种自相矛盾的话；
  - 否则 → 「第三方插件 <version> 暂无适配清单（本插件已收录：a / b / c），请升级 dsh-usage-dock。」
  GET 失败 / 信封不可信 / `state` 不在闭集 / 关键版本字段缺失或非法 → 保持原兜底（显示按钮，
  POST 后按固定码分流），或退化成不带版本号的原句。版本号与已收录清单先过**字符白名单**再渲染；
  固定错误码只在内存比较，绝不渲染。顺手合并了 `status === 'unsupported'` 的重复死分支。
- **测试夹具修正**：W9–W11 的 `applyPatch` 断言把夹具包已装版本改为与非法清单一致（`9.9.1`），
  确保失败走的是「清单不存在/不合法」路径，真正验证继承 fail-closed 的**零写入**；
  此前版本不匹配会先被拒绝，测不到目标路径。
- **验证结果**（均在本机跑通）：
  - `tools/test-patch-codex-subscription.mjs`：**49 passed / 0 failed**（含 1a–7b 的 CLI `spawnSync`
    子进程用例与 V8；3.2.17 清单 `baseSha` 对齐、继承解析 4 条 hunk、`coveredVersions()` =
    `3.2.6/3.2.13/3.2.17`、apply→patched、revert 与基线逐字节一致、W9–W15 继承/深度 fail-closed 零写入）。
  - `tools/test-codex-patch-ui.mjs`（离线、复用 `tools/mock-react.mjs`，不 spawn 子进程）：
    **35/35**。覆盖父组件只在不兼容时激活、三态渲染与按钮显隐、两种 unsupported 文案与降级、
    GET 只发一次且失败不重试、POST 固定码文案与不回显、不可信响应兜底。
  - `tools/test-codex-source-ui.mjs`：**91/91**（Q 段含 Q3a/Q3b/Q3c：点击前只有一次 `patch-state` GET
    且零 POST、点击后恰好一次 POST 且无 body、全程 GET+POST 各一次）。
  - `tools/test-settings.mjs` 6/6、`tools/test-android-compat.mjs` 14/14、
    `tools/test-custom-settings.mjs` 49/49、`tools/test-mimo-auth-client.mjs` 113/113。
  - `node --check client.js` / `node --check index.js` 通过。
- **部署与现状**：0.10.6 文件已复制到 `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock`；
  真实第三方包已由 CLI 打上补丁（备份在 `tools/patches/backup/2026-11-16T13-01-43-361Z/`）；
  **等待用户重启 DSH 验证**（客户端 bundle 在插件激活时缓存，改文件不会热生效）。
  **未 git 提交、未发布**。尚未验证：重启后设置页三态显示与订阅额度读取的真机表现、
  「已收录但基线不符」文案在真实损坏包上的外观（仅离线组件级验证）。
