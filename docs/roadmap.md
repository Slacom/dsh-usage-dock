# dsh-usage-dock 未来方向（roadmap）

> 记录已经想清楚、但**尚未排期实现**的改进点。每条都注明动机、涉及位置与实现约束，
> 未来排版本时直接从这里取。已实现的条目移到文末「已落地」并注明版本。

**当前版本**：0.8.3，见 [release-notes-v0.8.3.md](release-notes-v0.8.3.md)（2026-10-17 正式发布）。
0.8.0 是未单独发布的本地阶段；最终版已移除内嵌充值入口，增加 WorkBuddy 积分与渠道排序。
游标替代方案用户决定暂保留、不实装，见 [新方向演示](demos/cursor-directions-v2.html)。

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

## 方向 5：Agent 协作的更新/安装流程（已设计，排在 0.8.4）

> **状态（2026-10-17）**：用户确认方向，**设计已定，暂不实现**；0.8.3 封版发布后开工。
> 协议文档与校验脚本已在 0.8.3 期间落库（`docs/agent-update.md`、`tools/verify-install.mjs`）。

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

**0.8.4 待做**：
- Host：`/api/plan-usage/update-check`（GitHub Releases 含 prerelease + semver 比较 +
  **防降级** + 10 分钟缓存 + 可选“跟踪预发布”开关）。版本源**不能只查 npm**：
  `latest` 会落后于 GitHub 上的 prerelease，会误判成“该降级”。
- Client：按钮/徽标/changelog 摘要/复制提示词（提示词由插件按模板生成，与文档同源）。
- 能力探测：Agent 写不了安装目录（移动端沙箱/只读）时降级为「下载到工作区 + 引导走插件页」。
- 测试：update-check 的版本比较与防降级、提示词模板字段完整性、离线/限流降级。
- 明确的边界：**永不自动重启 DSH**（没有公开 API，且会杀掉宿主），只提示。

**涉及文件**：`index.js`（新路由）、`client.js`（设置页顶部）、`docs/agent-update.md`（已存在）、
`tools/verify-install.mjs`（已存在）、`tools/test-*.mjs`。

---

## 已落地

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
