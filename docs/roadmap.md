# dsh-usage-dock 未来方向（roadmap）

> 记录已经想清楚、但**尚未排期实现**的改进点。每条都注明动机、涉及位置与实现约束，
> 未来排版本时直接从这里取。已实现的条目移到文末「已落地」并注明版本。

**当前版本**：0.8.5（本地构建，见 [release-notes-v0.8.5.md](release-notes-v0.8.5.md)）；
上一公开版 0.8.4（2026-10-17 正式发布）。
0.8.0 是未单独发布的本地阶段；最终版已移除内嵌充值入口，增加 WorkBuddy 积分与渠道排序。
游标替代方案用户决定暂保留、不实装，见 [新方向演示](demos/cursor-directions-v2.html)。

**0.9.0 构建准备（2026-10-18）**：已核对当前实现与测试基线，建议先方向 7、再方向 6；
方向 5 单独验收，是否合入本版待确认。范围、契约缺口与验证记录见
[0.9.0 构建准备](build-plan-v0.9.0.md)，面向其他模型的调查证据、任务拆分与验收见
[实施交接](handoff-v0.9.0.md)。用户明确本轮只调查及编写计划，具体实施交给其他模型；未实现或发布。

---

## 方向 4：Host 端 `/api/plan-usage` 结果缓存 + 请求合并（⚠️ 配套方案，暂不推进）

> **状态（2026-10-14）**：用户确认**仍作为备选方向、暂时不推进**。方向 1/2/3 已在
> 0.8.0 落地后，本方向的排期前提（方向 2 的触发点）已具备，随时可以启动。

**提出**：2026-10-12（30 秒全渠道齐射的频率问题排查后提出）。渠道级降频（如 Codex 2~5 分钟）
**用户已否决，不做**；本方案是替代思路——不动频率，改收敛取数次数。

**动机（现状）**：轮询节拍在浏览器（每窗口 30s），但 Host 端**每收到一次请求就全量现取**
（index.js 的 `Promise.all`，无缓存）——开 N 个窗口 = 每条渠道每 30s 被打 N 次，
每次真实穿透上游（DeepSeek 平台 getBalance、chatgpt.com usage 接口、各家 API），
慢网络/高负载下极易撞上超时窗口（即「获取失败」抖动的温床），且各窗口数字互相不一致。
0.8.0 落地的失败降级已把「抖动可见性」压掉大半，本方向解决的是**上游请求量**本身。

**方案**：Host 端加**按渠道独立**的内存缓存 + **single-flight 请求合并**：

- 每渠道结果缓存 TTL（建议 30s 起步，观察后再考虑 60s）；TTL 内的请求直接复用；
- 同时到达的多个请求合并为一次上游取数；
- **stale-if-error**：上游失败时返回上一次成功结果（附数据时间），不报错。

### ⚠️ 负面效果与风险（必须一并考虑，尤其第 1 条）

1. **与「充值后同步」直接冲突（最大风险）**：0.8.0 已把充值后同步做到「focus/展开
   即刷」，加缓存后这些强刷必须绕过缓存才能保住体验——**`?fresh=1` 强制刷新通道
   是本项的前置条件、不是可选项**（现状：充值后余额最多慢 30 秒；若缓存不设 bypass，
   最坏慢 TTL + 30s ≈ 60~90 秒）。
2. **数据年龄上升**：任何一端看到的数据最坏旧 TTL~TTL+30s。余额/额度场景通常可接受，
   但「刚花完钱想立刻看剩多少」会显旧——这是用「请求少」换「没那么实时」，明确接受再做。
3. **stale-if-error 不能吞掉需要用户行动的语义错误**：`no-key` / `signed-out` /
   `reauth-required` 这类必须**立即透传**，绝不能拿旧值顶着——否则用户 Key 配错了、
   登录过期了都不知道，胶囊还显示着好看的旧数字。只有**传输层/超时类失败**才走 stale。
4. **Host 状态复杂度上升**：多一层内存缓存状态（按渠道 TTL + staleAt + 失败标记），
   错误分支变多；重启即失（内存即可，不持久化）。用户报「数字不对」时要能区分
   「缓存旧」与「上游真错」——所以响应必须带 `fetchedAt`/`stale` 标记。
5. **行为变化**：一端的强制刷新会让所有端同时更新（通常无感，但排查时要知道）。

### 必须配套的设计（缺一不可）

1. **bypass 强制刷新**：`GET /api/plan-usage?fresh=1`（或等价机制），供 0.8.0 的
   各个「立即刷新」触发点（点开面板 / focus / visibilitychange）使用；
2. **响应带 `fetchedAt` / `stale: true`**：供「更新于 HH:mm」类标注（如将来需要）；
3. **语义错误不 stale**（见风险 3）；
4. **按渠道独立缓存**：一个渠道失败/过期不影响其他渠道刷新。

**涉及文件**：`index.js`（缓存 + single-flight + `?fresh=1`）、`client.js`（触发 bypass、
渲染 `fetchedAt` 标注）。

---

## 方向 5：Agent 协作的更新/安装流程（设计已定，排期待定）

> **状态（2026-10-18）**：方向确认，**设计已定，但尚无任何可执行物**。
> 此前记录称协议文档与校验脚本已落库（`docs/agent-update.md`、`tools/verify-install.mjs`），
> **经核对与事实不符**：两个文件在当前检出与本地 git 历史（`git log --all`）中都不存在。
> 若启动本方向，需从零补：只读更新检查端点、完整 semver 比较（含 prerelease）、防降级、
> 10 分钟缓存、离线/限流状态、设置页入口、带精确目标与校验值的复制提示词、能力探测与
> 安装校验协议。
> **用户 2026-10-18 决定：不并入 0.9.0，独立排期。**

**提出**：2026-10-17（用户希望插件能自助更新；评估后确认“插件不能替换自己”）。

**为什么不让插件自己装**（结论性，别再回头试）：
- DSH 的 `pluginManager.installBundle` 在 `hmr` 服务存在时对已安装包直接抛
  `already-installed`（见 `dsh-plugin-manager/lib/index.js`，`dsh-base` 默认挂载 `hmr`）；
  唯一出路是先 `removeBundle` 卸载自己 → loader 立刻卸载当前 fiber，后续安装调用链断掉；
- 绕过 pnpm 直接覆盖 `node_modules` 会让 profile 清单/锁文件与磁盘长期不一致
  （0.8.3 期间排查过的「代码来源 0.7.2 / 当前版本 0.8.3」就是这个后果）；
- 自下载自覆盖还绕开了 pnpm 的 integrity 校验，且失败时可能让整个 profile 起不来。

**方案：三角色分工**
1. **插件**（只读）：设置页顶部「检查更新」→ 命中新版本显示徽标 + changelog 摘要 +
   「复制更新提示词」按钮。提示词里带**精确参数**：当前版本、目标版本、安装目录绝对路径、
   附件直链、sha256、profile 名、是否跟踪预发布。
2. **用户**：点复制 → 粘进会话。
3. **会话 Agent**：按 `docs/agent-update.md` 执行——能力自检 → 下载 → 校验 sha256 →
   解包验证 → 备份 → 逐文件原子覆盖 → `tools/verify-install.mjs` 校验 → 提示重启；
   任何一步失败按回滚流程处理。

**0.8.6 待做**：
- Host：`/api/plan-usage/update-check`（GitHub Releases 含 prerelease + semver 比较 +
  **防降级** + 10 分钟缓存 + 可选“跟踪预发布”开关）。版本源**不能只查 npm**：
  `latest` 会落后于 GitHub 上的 prerelease，会误判成“该降级”。
- Client：按钮/徽标/changelog 摘要/复制提示词（提示词由插件按模板生成，与文档同源）。
- 能力探测：Agent 写不了安装目录（移动端沙箱/只读）时降级为「下载到工作区 + 引导走插件页」。
- 测试：update-check 的版本比较与防降级、提示词模板字段完整性、离线/限流降级。
- 明确的边界：**永不自动重启 DSH**（没有公开 API，且会杀掉宿主），只提示。

**涉及文件**：`index.js`（新路由）、`client.js`（设置页顶部）、`docs/agent-update.md`（当前检出缺失，待补）、
`tools/verify-install.mjs`（当前检出缺失，待补）、`tools/test-*.mjs`。安装一致性与校验来源仍需先补证，见实施交接。

---

## 备选：通知覆盖检测（0.8.4 已验证生效，保留作将来备选）

> **状态（2026-10-17）**：0.8.4 已把胶囊的 `zIndex:1000` 去掉，用户真机确认「安装并重启」提示卡可以盖住胶囊。
> 官方通知是服务端下发的，本地无法复现验证；若真实通知仍然与胶囊互相穿透（说明该卡先于我们
> 挂载），再启用本方案。

**做法**：胶囊挂载后，用 `document.elementFromPoint()` 取胶囊中心点的最顶层元素；若它不在
我们自己的子树里，说明被外部浮层覆盖 → 给胶囊内容加 `visibility: hidden`（视觉上等同「被压住」），
并在 `pointerdown` / `visibilitychange` / 30s 轮询时重新检测，一旦不再被覆盖就还原。

**约束**：只在展开（wide）态启用；检测频率不得高于 500ms；不得影响胶囊的点击与悬停状态；
mock 环境没有 `elementFromPoint` 时直接跳过。

---

## 方向 6：把额度/余额暴露给模型，让 Agent 按余额阶段降级（已评估，**排期待定**）

> **状态（2026-10-18）**：用户提出「余额低于阈值时让模型收尾而不是开新任务」。技术路径已验证
> 可行（工具注册、`ctx.get` 约束、短缓存方案均已核实，见 evidence-0.9.0.md 第 5 节）。
>
> **用户 2026-10-18 决定：0.9.0 暂缓，先更新规划文档再排期。**
> 原前置条件「必须先修方向 7」已随方向 7 暂缓而失效——工具契约本身允许 `percentMode` 与
> `unknown` 状态并存，Kimi 口径未定时如实报 `unknown` 即可，不必等修复。

**需求**：插件通过 DSH 官方工具注册（`ctx.tools.register()`）或 MCP，向模型提供「各渠道还剩多少」，
使 Agent 能在额度紧张时改变行为——例如 Codex 剩余 <20% 时不再启动高成本任务，改为：
完成当前最小工作单元 → 检查 Git 变更 → 跑必要测试 → 保存进度与后续操作 → 停止。

**可行性（已核对 DSH 0.2.1-rc.1 源码）**：

| 事实 | 结论 |
| --- | --- |
| `ctx.tools` 由 `@deepseek-ai/dsh-tools` 提供，`dsh-base` 默认挂载（id: `tools`） | 官方路径存在，**不需要 MCP** |
| 注册即生效：schema 自动流入提示词组装（`wireSchemas`），无需额外声明 | 一条 `register()` 就够 |
| `register(definition)` 只校验 `name` / `output.schema` / `output.render` | **可以不 import `defineTool`**，手写 JSON Schema 即可 |
| `@deepseek-ai/dsh-tools` 在本机**无法从插件目录解析**（`ERR_MODULE_NOT_FOUND`；连 `dsh-codex-connect` 也解析不到，profile 的 `node_modules` 只投影了 `schemastery`/`cosmokit`） | **绝不能 `import`**；只能 `ctx.get('tools')` 运行时取，缺服务就静默跳过 |
| 当前 `index.js` 的 `inject = ['webServer']`，cordis 的 inject 是**硬依赖**（服务缺失即不加载） | **不能**把 `'tools'` 加进 inject——DSHA/移动端没有该服务会整插件不加载 |
| `ctx.systemPrompt.section({name, order, text})` 可注入提示词段（`dsh-time-context` 是现成先例） | 政策文案可走这里；同样只能 `ctx.get` 取 |

**设计草案**：

1. **工具 `usage_status`**（只读，无副作用）：返回每个渠道的结构化状态——
   `{ id, kind: 'balance'|'quota'|'credits', remaining, limit, percent, percentMode, state: 'ok'|'low'|'exhausted', resetsAt, fetchedAt, stale }`。
   **不返回**任何 Key/Cookie/token，只返回数字与时间。
2. **复用现有取数**：工具内部走与 `/api/plan-usage` 相同的 `PLANS` 编排，但要加**短 TTL 缓存（30s）
   + single-flight**（否则模型每一步都调一次，等于把上游打成 DDoS；这也顺带是方向 4 的最小版本）。
3. **政策层是提示词，不是代码**：阈值阶梯（如 20% / 50%）写进可选的 `systemPrompt.section`，
   默认**关闭**（`quotaPolicyEnabled`），因为这会实质改变 Agent 行为。工具描述里写明
   「需要决策是否继续高成本任务时调用」。
4. **门槛**：必须先在设置页配置阈值（复用 `*WarnThreshold` 的形态），未配置就只报数不劝停。
5. **风险**：
   - 模型可能反复调用工具 → 靠 TTL 缓存 + 描述里写明「一次任务内调用 1–2 次足够」；
   - 数据必须可信 → **依赖方向 7 先修**，否则「已用 94%」被当成「只剩 6%」，会让 Agent 无谓停工；
   - 移动端没有 `ctx.tools` → 功能整体缺席，不能报错，胶囊照常工作。

**工作量**：工具 + 缓存 + 测试 ≈ 1 天；提示词段与配置项 +0.5 天；文档 +0.5 天。

**涉及文件**：`index.js`（`ctx.get('tools')` / `ctx.get('systemPrompt')` 守卫 + 工具定义）、
`plans/*`（复用）、`client.js`（设置页开关与阈值）、`tools/test-*.mjs`。

---

## 方向 7：Kimi Code 的百分比口径错误（确认存在，**用户决定暂缓**）

> **状态（2026-10-18）**：用户在仓库审查时提出「Kimi 显示的疑似是已用而不是剩余」。
> **核实结果：确实显示的是「已用」，而界面没有任何口径说明**，与 Codex 的「剩余」并列时会被误读。
>
> **2026-10-18 用户决定：暂不修复。** 原因：当前没有使用 Kimi 订阅，无法在真机核对修复效果；
> 等恢复使用或用户更新规划后再排期。**期间不要擅自改 Kimi 口径或解析逻辑。**
> fixture 与「当前 parser 实测行为」已留在 [evidence-0.9.0.md](evidence-0.9.0.md)（含三个缺口：
> ratio-pool 月池完全未读、并存矛盾无法表达、成功但无窗口被显示成「获取失败」）。

**证据链**：

| 位置 | 事实 |
| --- | --- |
| `plans/kimi-code.js:70` | `percent = Math.round(used / limit * 100)` → **已用百分比** |
| `plans/kimi-code.js:116` | 月度会员额度用 `amountUsedRatio` / `kimiCodeUsedRatio` → 同样是**已用比例** |
| `client.js:64` | Kimi 没有 `percentMode`，默认按「用量」语义：`toneColor`（≥90 红）、标题写「用量」、`worstPercent` 取最大值 |
| `client.js:70` + `plans/codex.js:34` | Codex 显式 `percentMode: 'remaining'`，取的是 `remainingPercent`，面板标题「剩余额度」，并有脚注「百分比表示剩余额度」 |
| 第三方实现交叉验证 | [pi-kimi-code-usage](https://www.npmjs.com/package/pi-kimi-code-usage) 的 `pctOf` 同样 `used/limit` 并显式标注「已用 X%」；[kimi-quota-line](https://www.npmjs.com/package/kimi-quota-line) 则算 `remaining/limit` 并标注「X% left」——**上游同时给了 used 与 remaining，取哪个是显示层选择** |

**结论**：不是解析错，是**语义未声明**。当前 Kimi 胶囊显示「94%」= 已用 94%，但旁边 Codex 的
「98%」= 剩余 98%，两个数字方向相反且都只有百分号，用户（以及未来的 Agent 工具）必然误读。

**修复方案（二选一，倾向 A + B 并行）**：

- **A（最小改动，零风险）**：保留「已用」口径，但把口径**显式化**——面板标题已写「用量」，
  再补一条脚注「百分比表示已用量」；胶囊 tooltip 同步。与 GLM / OpenCode 保持一致
  （它们的 `percentage` 同样是已用，见 [glm-quota-line](https://www.npmjs.com/package/glm-quota-line)
  注释「historically this has represented used percent」）。
- **B（口径统一，用户直觉）**：把 Kimi 改成 `percentMode: 'remaining'`（与 Codex 一致），
  host 侧改算 `remaining / limit`（月度同理改用 `1 - usedRatio`）。代价：Kimi 与 GLM/OpenCode
  口径不同，需在 `PLAN_NOTES` 里逐渠道标注。
- **建议**：A 先落地（保证不误导），同时给 `PLAN_NOTES` 补一张「口径表」；B 作为配置项
  （`kimiPercentMode`）后置。

**顺带发现（同批修）**：

- Kimi 新版响应可能返回**ratio-pool 结构** `usages: { limit_5h, limit_month_total, limit_month_code }`
  （字段 `used_ratio` / `reset_time`），而当前解析只认 `usage` + `limits[]`，遇到这种账号会
  **整块显示为空**（社区同类实现已踩过：CodexBar #3694 / #4306）。建议加 fallback：优先
  `limits[]`，缺失时读 `usages.limit_5h`，月度优先 `limit_month_total`。

**涉及文件**：`plans/kimi-code.js`（口径 + ratio-pool fallback）、`client.js`（`percentMode`、
`PLAN_NOTES` 脚注、tooltip）、`tools/test-*.mjs`（新增口径断言，防止再退回去）。

---

## 已落地

### 0.8.5（2026-10-18）

- WorkBuddy `creditsError` 按 connect 的 kind 分流：session_dead/hard_credit 才算语义错误，
  限流 / 5xx / 超时 / 结构变化为暂时失败（`exec` + `transient:true`）。
- 客户端 `settle()` 信任显式 `transient:true`；`FAIL_THRESHOLD` 5 → 8。
- 两端超时 30/30s → 35/40s（必须先让 connect 的 30s 计费超时落地，才能拿到结构化原因）。

### 0.8.4（2026-10-17，正式发布）

- 胶囊不再盖住 DSH 官方通知/提示卡：去掉 `rootStyle` 的 `zIndex:1000`，改由 DOM 顺序决定绘制次序。
- 守望测试：`test-footer-row.mjs` T12（胶囊不得带正 z-index + 面板仍为浮层），已做变异验证。

### 0.8.3（2026-10-17，正式发布）

- WorkBuddy 积分改「✦ 」前缀（U+2726），缩放行内块 + flex 中心对齐，跨平台光学居中对齐。
- WorkBuddy 与 WorkBuddy AI 拆成两个独立渠道（分别开关、排序、胶囊分行、面板分行）。
- DeepSeek 余额明细：账号路径 `value`/`bonusWallets`、API Key 路径
  `topped_up_balance`/`granted_balance`，缺失字段不伪造 0。
- 详情卡片外点关闭兜底：`pointerdown` + `mousedown` + `touchstart` + `click`，`downInside` 去重。
- 超时 30s / 失败阈值 5；API Key 模式也渲染峰谷条；哨兵 API Key 跳过注定 401 的请求。
- 新增 `tools/test-line-endings.mjs` 守卫 LF/CRLF 混改。

### 0.8.1（2026-10-15，最终实现）

- WorkBuddy / WorkBuddy AI 积分与套餐明细，复用登录插件的回环状态接口。
- 设置页调整渠道显示顺序；有 configEditor 时 Host 重读最新配置，停用渠道不再继续拉取。
- 峰谷条固定中点 + 24h 平滑图案，修复窗口左半空白及三角/柱错位；2px 柱保留。
- 移除充值入口，余额同步/取整保留。
- 安卓/DSHA 可选服务降级、hooks 稳定性、旧请求竞态及渠道异常隔离守卫。
- 核对 WorkBuddy Connect 0.7.4 移植包真实状态处理器接口；无真实凭据参与测试，非安卓真机联网验证。

### 0.8.0（2026-10-14，本地历史阶段；以下充值/classic 描述已被 0.8.1 替代）

1. **方向 3 — 失败保留旧值 + 弱化标注（定稿修改版）**：取数失败先保留上次成功值、
   数值灰字弱化（**不加**「更新于 HH:mm」，用户定稿）；连续 **2 轮**失败才显示
   「获取失败」（用户定稿）；语义错误（no-key 等）立即透传。附带修**轮询防卡死**
   （客户端 AbortController 20s + settle 必复位；Host 端 getBalance 包 20s 超时）；
   三后端超时放宽 10s → 20s（用户定稿）。测试：test-degrade-refresh.mjs T2/T3/T5。
2. **方向 2 — 充值后胶囊余额与设置页实时同步（保底方案）**：窗口 focus /
   visibilitychange / **点开详情面板**三个触发点立即强刷（强刷作废 in-flight 请求
   重拉）。事件驱动方案（订阅设置页同款数据源）未做——保底方案已覆盖实测场景
   （充值页返回 = 窗口重新聚焦）。附带修**余额向下取整到分**（34.31662152：
   0.7.x 四舍五入显示 34.32、设置页截断 34.31 的「总多一分」）。测试：
   test-degrade-refresh.mjs T1/T4/T6。
3. **方向 1 — 详情面板内 DeepSeek 充值入口**：余额行「充值」按钮，经 preload 暴露的
   `dshPlatform.open("top-up", bounds)` 打开**原生充值页**（与「设置 → 账号与余额」
   同一条 `top-up` 通道，不自己拼 URL）；仅账号登录（`via === "account"`）且存在
   原生桥（桌面端）时渲染；浏览器/移动端无桥，不渲染、不做外链回退（用户确认）。
   测试：test-degrade-refresh.mjs T8（三种环境）。
4. **峰谷价时间条（用户 2026-10-14 新增需求）**：详情面板 DeepSeek 区块渲染
   **classic** 样式时间条（用户选定；8px 橙/蓝分段条 + 橙描边三角指针 + 胶囊徽章，
   样式照抄 dsh-cost-meter `cm-peak-classic`）。峰窗口 UTC 1-4 / 6-10（北京
   09:00–12:00、14:00–18:00），周末与法定假日全天空闲价（假日表硬编码 2026 年
   安排，见 plans/peak-phase.js）。仅账号登录时显示（host 附 `peakPhase`）。
   测试：test-peak-phase.mjs（22 项）+ test-degrade-refresh.mjs T7。
5. **新渠道 — 小米 MiMo API 余额（用户 2026-10-14 新增需求）**：控制台 Cookie 鉴权
   （platform.xiaomimimo.com，需 userId + serviceToken），只查 `GET /api/v1/balance`
   显示账户余额（**不做**套餐积分额度——用户明确），面板附现金/赠送明细；带
   `mimoWarnThreshold` 警告阈值（默认 10 元）。取数/解析口径照抄 dsh-cost-meter
   的 coding-plans.js。测试：test-mimo-parse.mjs（21 项）+ test-degrade-refresh.mjs T9/T10。

### 0.7.2（2026-10-12）

- 修回详情面板额度条（`var rowStyle` 遮蔽，见 AGENTS.md 第 5 节坑 #17）；
- 缩略态状态点居中（column flex 的 justifyContent/alignItems 语义，坑 #18）。
  见 [release-notes-v0.7.2.md](release-notes-v0.7.2.md)。

### 0.7.1（2026-10-10）

- 悬停灰底与侧栏按钮对齐（照抄 ds-harness-remote 的 `+8px / -4px` 向外贴边，
  见第 5 节坑 #15）；footer 行测试增至 9 项。

### 0.7.0（2026-10-10）

- 底部席位独占一行、排到最上面（`order:-1000`），外观对齐侧栏按钮；footer 行测试 8 项。
  见 [release-notes-v0.7.0.md](release-notes-v0.7.0.md)。

### 0.6.x 及更早

- 0.6.2：移动端取数全断修复（Host 进程内原生 fetch 首选，Python/curl 兜底）；
- 0.6.3：缩略（rail）态胶囊不可交互。见 [release-notes-v0.6.3.md](release-notes-v0.6.3.md)。
