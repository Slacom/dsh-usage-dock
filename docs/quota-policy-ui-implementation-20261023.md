# 额度策略 UI + 按渠道/窗口阈值：实现设计（2026-10-23）

> 状态：**设计已按父 Agent 裁决修订（2026-10-23），并进入实现阶段**。
> 修订条款见 §10「裁决修订（权威）」；与正文冲突处**以 §10 为准**。
> 依据：`docs/quota-policy-ui-followup-20261023.md`（用户 2026-10-23 已确认）、
> `AGENTS.md` §5 契约、当前工作文件（含大量未提交变更）的真实代码。
> 基线：`.diagnostics/policy-ui-implementation-20261023/baseline/`（28 个公开源码基线 + manifest）。
> 本轮**不得**以 HEAD 为准覆盖工作区；以下所有结论均来自**当前工作文件**。

---

## 0. 结论摘要（给父 Agent 看的一页）

1. **窗口身份已经存在且稳定**，不需要新增任何 provider 字段、也不需要扩大 `usage_status` 输出：
   模型侧 `plans/usage-tool.js` 的 `WINDOWS` 已给出 `rollingUsage→rolling-5h`、
   `weeklyUsage→weekly`、`monthlyUsage→monthly`；GUI 侧原生 wire 就是
   `rollingUsage/weeklyUsage/monthlyUsage`（`client.js` 的 `WINDOWS` 同表）。
   **稳定 window key = `'rolling-5h' | 'weekly' | 'monthly'`**，来源是 wire **字段名**
   （= provider 归一化后的槽位），不是数组顺序，也不是展示文案。
   只有 `codex` / `opencode-go` 是窗口型渠道；`deepseek` / `mimo` 是金额型；`workbuddy` 是积分型。
2. **新增 1 个配置字段** `quotaChannelThresholds`（JSON 字符串、默认空串、`.volatile()`），
   承载「渠道 → 窗口/金额/积分」两档阈值。**不新增每个窗口一个 schema 字段**，
   避免 UI/CLI 两套写入互相覆盖，也不让 schema 随渠道×窗口爆炸。
3. **显式 0 / 清空 / 坏 JSON 与新字段「未出现」是四种不同语义**（见 §4）：
   字段未出现（旧配置）→ 才允许回退旧全局三组阈值；字段存在但该渠道有条目 → **该渠道以条目为准，显式 0 不回退**；
   字段存在但 JSON 坏/类型坏 → **整体失败即关闭**（零规则），并给用户可读原因，绝不静默退回旧收尾。
4. **多窗口独立判定、整体取最严重**，`closing > warning > normal`；提示词逐条列出触发窗口与当前值；
   不再 `pickSmallestWindow` 代表全部窗口（该函数保留导出以避免破坏既有单元断言，但不再参与判定）。
5. **设置页如何拿到「本渠道实际有哪些窗口」**：新增一个**只读、零凭据、零上游请求**的
   Host 路由 `GET /api/plan-usage/quota-windows`，数据来自 `index.js` 已有的
   `channelProjection` / `channelMeta`（票据 + identity + source 已校验过的可信观察）。
   浏览器半**不 import Host 模块**（单文件 `__ModuleLoader__` 无多文件通道），
   只在打开设置页时取一次，失败即降级为「只显示已保存的窗口」。
6. **关注复选框 = `quotaFocusChannels` 成员资格**（复用现有白名单，不新增第二份启用状态）；
   复选框**不会**打开 `quotaPolicyEnabled` / `quotaTrustRouteOrder`，也不触碰任何凭据字段。
   总开关/路由信任在页面顶部单独显式呈现，并逐卡解释「为什么当前未生效」。
7. 所有新控件走**原有整页草稿 + 一次 mutate** 事务；`save()` 的 diff 只提交**变更字段**，
   `customKeys` 路径写入与 `this` 绑定逻辑一行不动；校验不通过时零副作用。

---

## 1. 现状核查（真实代码事实，不是推测）

### 1.1 窗口从哪里来（链路）

| 层 | 位置 | 形状 | 说明 |
| --- | --- | --- | --- |
| provider | `plans/codex.js` | `rollingUsage/weeklyUsage/monthlyUsage` | 用 `windowSeconds` 精确匹配 `18000 / 604800 / 2592000`；账户没有的窗口返回 `null` |
| provider | `plans/opencode-go.js` | 同上（`util.js` 的 `norm()` 归一） | `u.rolling / u.weekly / u.monthly`，缺失即 `null` |
| wire→GUI | `client.js` `WINDOWS` + `adaptHostWindows` | `plan.rollingUsage = {percent, resetsAt}` | GUI 一直用原生字段；Host 缓存补值时可能给 `windows:[{scope,...}]` |
| wire→模型 | `plans/usage-tool.js` `WINDOWS`/`projectWindow` | `windows:[{scope,percent,percentMode,resetsAt,resetInSec}]` | 白名单重建；`percentMode` 恒 `remaining`；`scope` 就是稳定 key |
| 观察 | `index.js` `publishObservation` → `channelProjection` | 上面那份模型投影 | 每个渠道一份；`channelMeta` 记 `status/identity/source/sampledAt` |

结论：**「有哪些窗口」= 该渠道本次成功采样里出现的 `scope` 集合**（`rolling-5h` / `weekly` / `monthly`）。
不需要新增 wire 字段；窗口缺失就是 provider 没给（例如只给周额度的账号）。

### 1.2 现有配置字段（`plans/usage-policy.js`，全部 `.volatile()`）

`quotaPolicyEnabled`(false) / `quotaFocusChannels`(`'[]'`) / `quotaPercentThreshold`(0) /
`quotaBalanceThreshold`(0) / 新两档 `quotaWarning|Closing{Percent,Balance,Credits}Threshold`(0) /
`quotaBalanceCurrency`('') / `quotaRouteBindings`('[]') / `quotaTrustRouteOrder`(false)。

- 旧单阈值 `quotaPercentThreshold`/`quotaBalanceThreshold` 已被 `index.js:1302` 显式停用（工具 `policy` 恒 `null`）。
- 现役两档判定在 `plans/quota-view.js`：`thresholdsOf()` 解析全局 6 个数字 + 币种；
  `stageForChannel()` **只取 `pickSmallestWindow()`** 的那一个窗口判阶段 → 这正是要撤掉的「5h 优先」。

### 1.3 现有注入闸门（不得放宽）

`index.js` → `buildQuotaView()` 顺序：`quotaPolicyEnabled` → `focus` 非空 → 全局 `enabled` →
路由观察存在（否则 `unobserved`）→ Reserve 池未证明则不投放 → 绑定/内置表解析（歧义 fail closed）→
`focus` 白名单 → 渠道开关 → identity → source → status → 数据。
`routeObserver` 只有在 `quotaTrustRouteOrder === true` 时才发布观察（默认闭合）。

### 1.4 设置页现状

- `client.js` 是**单文件**（`window.__ModuleLoader__.load({factory})`），**不能** `import` Host 模块；
  Host 与 client 各自有一份结构表（`plans/index.js` vs `client.js` 的 `PLANS`），改动要**两边对齐**。
- 设置页 `PlanUsageSettingsPage`：`props.form` 是 `ConfigFormController`，方法**依赖 this**（AGENTS §5 #4），
  必须先包一层；`snapshot.value` 不含任何 `role('secret')`。
- 草稿：`draft`（整页快照副本）+ `customKeyDrafts/customKeyClears`（secret 侧草稿）；
  `save()` 三段式（校验零副作用 → 一次 mutate → 如实报告）；`mutate` 的 ops 来自
  `for (k in base)` 的**逐字段差异**，因此**新增的顶层字段会自动只提交变更项**，无需改 save 骨架。
- 卡片：`renderBuiltInCard(meta)`，`meta.fields.enabled` 决定是否展开内容；`saving`/`!writable` 时全部控件 disabled
  （`test-settings.mjs` C 项、`test-custom-settings.mjs` C2an 都断言这一点）。
- 目前**完全没有**任何策略 UI（grep `quota` 在 `client.js` 里只有历史注释）。

---

## 2. 设计决策

### D1 window key（稳定身份）

- 词表固定：`WINDOW_KEYS = ['rolling-5h', 'weekly', 'monthly']`，来源是 wire 字段名映射，**不是**数组下标、
  也**不是** `label`/`scope` 展示文案（展示用 `5 小时窗口 / 周窗口 / 月窗口` 固定表）。
- 不在词表里的 `scope`（未来新增）→ 不显示、不参与判定、不写入配置；Host/客户端都忽略。
  将来真的要支持新窗口时，必须同时扩这张表（这是**显式**扩展点，避免"按文案猜"）。
- provider 不动；`usage_status` 输出 schema 不动（`WINDOW_SCHEMA` 已含 `scope`，无需扩字段）。

### D2 每渠道两档阈值的存储

新增字段（`plans/usage-policy.js` 的 `quotaPolicySchemaFields()`）：

```js
quotaChannelThresholds: z.string().default('').volatile(),
```

JSON 形状（客户端只写自己认识的部分，未知键**原样保留**，Host 忽略未知键）：

```json
{
  "codex":       { "windows": { "rolling-5h": { "warning": 25, "closing": 8 },
                                "weekly":     { "warning": 20, "closing": 5 } } },
  "opencode-go": { "windows": { "weekly":     { "warning": 30, "closing": 10 } } },
  "deepseek":    { "balance": { "warning": 10, "closing": 3, "currency": "CNY" } },
  "mimo":        { "balance": { "warning": 8,  "closing": 2, "currency": "CNY" } },
  "workbuddy":   { "credits": { "warning": 400, "closing": 100 } }
}
```

语义：

- 键 = 内置渠道 id（精确匹配）。条目存在即「该渠道以此为准」。
- `windows` 只放该渠道**实际出现过或曾经保存过**的窗口 key；没有的窗口不写、不猜。
- `balance` 必须带 `currency`（3 位 ISO，大写）；`credits` 不带币种。
- 每档：`0` / 负数 / 非有限数 / `percent > 100` → 该档「未配置」；
  两档都存在且 `closing >= warning` → **该指标整体作废**（沿用 `stageOf` 既有规则，不猜意图）。
- 阈值默认 **0 = 未配置**，绝不自动补 20%；解析不合法不静默修正。

### D3 多窗口判定与合并（`closing > warning > normal`）

新增纯函数模块 `plans/quota-thresholds.js`（无 IO，Host 与测试共用）：

```js
WINDOW_KEYS                       // 词表
windowLabelOf(key)                // 固定中文标签，未知 key 回退到安全化后的 key
parseChannelThresholds(raw)       // → { state: 'absent'|'invalid'|'ok', channels: {...} }
resolveChannelThresholds(parsed, channelId, legacyThresholds)
                                  // → { source:'channel'|'legacy'|'none', invalid:boolean,
                                  //     windows:{key:{warning,closing}}, balance:{warning,closing,currency}|null,
                                  //     credits:{warning,closing}|null }
evaluateChannelMetrics(channel, resolved)
                                  // → { stage, metrics:[{kind,scope,value,stage,warning,closing,currency}] }
```

判定规则（沿用现有保守口径）：

- `availability !== 'ok'` / `unlimited` / `stale` → 不参与（`failed`/`expired` 由视图层给固定状态）。
- 每个**实际存在**的窗口独立用**自己的**两档判定；窗口没配阈值 → 该窗口不参与（不借用别的窗口阈值）。
- 金额只与**同币种**比较；币种不一致或条目缺币种 → 该指标不参与并给出原因码。
- 积分只与积分阈值比较，永不与金额混比。
- 渠道整体阶段 = 所有指标阶段的 `worstStage`（`stageRank`: closing 2 > warning 1 > normal 0）。
- `metrics` 只含**触发**项，按「严重度降序 → 词表固定序」排序（**与数组顺序无关**），
  每项带 `scope / value / stage / warning / closing`，供提示词解释「哪个窗口、当前多少」。

兼容：视图对象同时保留单值 `metric`（= 最严重的那一项），避免内部/外部消费者拿不到字段；
`stageForChannel(channel, thresholds, pickSmallestWindow)` 签名保留（第三个参数不再参与判定），
旧单元断言（单窗口场景）继续成立。

### D4 提示词渲染（`plans/quota-prompt.js`）

- 事实行：每个实际窗口一行 `额度：<label> 剩余 X%`（单窗口时与今天逐字一致），金额/积分沿用
  `额度：9000 CNY` / `额度：9000 积分`。
- 触发解释（仅 `stage !== normal`）：每个触发项一行
  `触发：周窗口 剩余 12% < 预警 20%（warning）`、
  `触发：余额 8 CNY < 收尾 10 CNY（closing）`、`触发：积分 80 < 预警 400（warning）`。
  然后才是原有 `[当前阶段规则]` 固定模板（按**整体**阶段选模板）。
- `normal` 仍然**零规则、零指令词**（保留 N6b/N6c 断言口径）；不做平均、不求和、不 5h 优先。
- 失败/过期/未采样：固定短语 + 无旧数值（既有行为不变）。

### D5 设置页如何拿到「实际窗口」（不额外取凭据）

新增只读路由 `GET /api/plan-usage/quota-windows`（`index.js`，与 `/custom-status` 同风格）：

```json
{ "ok": true, "data": { "channels": {
  "codex":    { "status": "ok",    "sampledAt": 1761…, "unit": null, "currency": null,
                "windows": [ { "key": "weekly", "percent": 34.5 } ] },
  "deepseek": { "status": "failed", "windows": [] }
} } }
```

- 数据来源：`channelMeta` + `channelProjection`（**已经过票据/epoch/identity** 校验的观察），
  取数时再核一次 `meta.identity === identityOfChannel(id)`；不一致（改 Key/改配置/切账号）→ 只回 `status`，**不回窗口**。
- `status` 仅 `ok`/`cached` 才带窗口；`failed`/`expired`/`none` 只回状态（**不拿旧账号窗口**）。
- **零凭据解析、零上游请求、零缓存写入**；不返回任何 secret/URL/账号；GET-only，其它方法 405。
- 浏览器开设置页时**取一次**（保存成功后再取一次），**不轮询**。路由不存在/失败 → 页面对应区块显示
  「未能读取当前窗口（只显示已保存的窗口配置）」，不阻塞保存。

为什么不用「浏览器共享 store（badge 的数据）」：badge 的数据在组件级 ref 里（`lastListRef`），
设置页是另一个 slot 的独立组件树；要做共享就得把整份 wire 镜像提到模块级并同步失效逻辑，
反而增加"两端各数一套"的风险。Host 侧 `channelProjection/channelMeta` 是**唯一可信快照**，
用一个只读路由暴露「窗口 key + 当前百分比」是改动面最小的做法（新增对外接口面 1 条，只读）。

### D6 设置页布局与交互（`client.js`）

页面顶部（全局开关那一行之后）新增「额度策略」小节：

- `quotaPolicyEnabled` 复选（**总开关**，默认关）+ 说明「关闭时不注入任何额度事实与规则」。
- `quotaTrustRouteOrder` 复选（**路由信任**，默认关）+ 说明「本版本没有公开的安装顺序证据；
  关闭时**永远不会**注入提示。只有在你确认安装顺序可信后才打开」。
- 只读总览行：`当前：总开关<开/关>，路由信任<开/关>，已关注 N 个渠道`。

每个活跃内置渠道卡片底部（`renderBuiltInCard` 的 `children` 末尾）新增「关注额度策略」块：

- 复选 = `quotaFocusChannels` 成员资格（**只改这一个字段**；不打开 policy/trust，不动凭据）。
- 勾选后按渠道类型渲染阈值：
  - 窗口型（`codex` / `opencode-go`）：按 `quota-windows` 返回的**实际窗口**逐个渲染「预警 / 收尾（剩余 %）」两输入框；
    另对「配置里已有但本次采样没出现」的窗口渲染为**只读保留行**：`周窗口：已保存 20%/5%（本次采样未出现，配置保留）`。
  - 金额型（`deepseek` / `mimo`）：两个数值输入 + 币种标签（来自采样；采样未知 → 显示「等待一次成功采样后才能配置」并禁用输入）。
  - 积分型（`workbuddy`）：两个数值输入（单位「积分」，永不与金额混比）。
- 「生效状态」一行，说明当前**实际**为什么不生效（按顺序取第一条命中）：
  `总策略开关未打开` / `路由信任未开启，不会注入任何提示` / `本渠道未关注` / `未配置有效阈值` /
  `尚未取得本渠道窗口（等待一次成功采样）` / `阈值配置无法解析，已暂停自动判定` /
  `已参与：路由命中本渠道时按 <窗口 X%/Y%、…> 判定`。
- 关注上限：`MAX_FOCUS_CHANNELS = 8`（Host 侧既有常量）。列表里若有**未知/退场/自定义** id，
  在块底部列出「其它已关注条目：<id> [取消关注]」——**原样保留、不静默截断**；
  勾选会超过 8 个时不写入并提示「关注渠道已达上限 8（本次未修改）」。
  `quotaFocusChannels` 原值 JSON 坏 → 显示「关注渠道配置无法解析」，勾选时按当前可见状态重建并提示已替换。
- 所有新控件：`disabled: !writable || saving`；不新增任何 secret 输入框。

### D7 保存/放弃事务

- 所有策略改动都通过既有 `change(field, value)` 进同一份 `draft`；「放弃更改」原样还原（无需新代码）。
- `save()` 在校验段追加 `validatePolicyDraft(base)`：
  数值型阈值必须是有限数（空串→0）、`0..100`（百分比）、`closing < warning`（同时配置时）、
  关注列表 ≤ 8、渠道 id 必须在活动渠道集内、币种已知（金额型）。
  任一不合格 → `setCustomErrors({ __policy: … })` 并 **return（零写入）**。
- 提交段不变：`fieldOps` 逐字段 diff → 一次 `mutate`；`customKeys`/`customKeyRev` 仍走路径写入；
  绝不整页 replace，绝不把被 redact 的空 secret 字段写回。

---

## 3. schema / Host / 客户端一致性

| 侧 | 改动 | 一致性要求 |
| --- | --- | --- |
| schema | `quotaChannelThresholds: z.string().default('').volatile()` | 默认空串 = 旧配置语义；`.volatile()` 必须 |
| Host | `plans/quota-thresholds.js`（新）+ `quota-view.js` 接入 + `index.js` 新只读路由 | 解析/判定只用这个纯模块，禁止在视图里再写一套 |
| client | 同名常量 `WINDOW_KEYS`、同构解析（只做「读-改-写 + 校验」，不做判定） | 两侧 key 词表必须逐字一致（像 `PLAN_PERCENT_SEMANTICS` 那样的双份表，注释互指） |
| tool | **不改**。`usage_status` 的 `policy` 仍恒为 `null` | 见 §9 待决项 F3 |

已核实：schemastery `z.object` 对**未知键不抛错、原样保留**（离线实测 `OK {"a":"y","b":0,"c":5}`），
因此「旧 Host + 新配置里的新字段」不会炸，新字段被当成普通未知键携带（与 AGENTS 既有结论一致）。

---

## 4. 迁移 / 回退语义（四种状态必须可区分）

`parseChannelThresholds(raw)` 的三态：

| 状态 | 触发条件 | 判定行为 | UI |
| --- | --- | --- | --- |
| `absent`（旧配置） | `undefined / null / ''`（默认值） | **回落旧全局三组阈值**（六个数 + 币种），语义见下 | 卡片显示「正在使用旧版全局阈值：预警 X / 收尾 Y」并提供「本渠道单独配置」入口 |
| `invalid` | 非空且在 JSON.parse 失败 / 解析出非对象 / 顶层类型不是对象 | **零规则**（不注入任何阈值判定），并给出原因码 `invalid-config`；**绝不**退回旧全局（避免"坏配置被当成没配 → 旧收尾突然生效"） | 「阈值配置无法解析，已暂停自动判定」；不静默清空用户数据 |
| `ok` + 有该渠道条目 | 渠道键存在（哪怕全是 0） | **该渠道以条目为准**：条目里没配的指标 = 未配置，**不回落旧全局**（显式 0 不会复活旧阈值） | 逐项显示「未配置」 |
| `ok` + 无该渠道条目 | 渠道键不存在 | 该渠道无阈值 → 零规则（**不回落旧全局**：新结构一旦存在，就以它为准） | 「本渠道未配置阈值」 |

旧全局阈值的语义（`absent` 分支）：六个数字 + `quotaBalanceCurrency` 原样读取；
**百分比两档对每个实际窗口分别判定**（不再只取最短窗口）。这是**有意的口径变更**：

- 理由：用户 2026-10-23 已冻结「不再 5h 优先 / 不只拿一个窗口代表全部」；
  若旧分支继续按最短窗口，就等于保留被否决的行为。
- 影响面：仅影响「仍在用旧全局百分比阈值」的配置。当前用户 profile 的 6 个阈值全为 0
  （`docs/quota-policy-ui-followup-20261023.md` 末节记录：policy/trust 关闭、focus 空、阈值归零），
  因此**实际不改变任何现有行为**。
- 旧测试里的多窗口断言只有 1 处（`test-quota-awareness` N5b 直接测 `pickSmallestWindow` 函数本身，
  该函数保留 → 不受影响）。

其他迁移规则：

- **不自动迁移**旧全局值到新结构（不静默改变授权、不补默认值）。用户主动在卡片里填写才会写新字段。
- 旧单阈值 `quotaPercentThreshold/quotaBalanceThreshold`：继续保留字段、继续不参与（行为不变）。
- 窗口暂时消失：**已保存的窗口配置永不因一次失败/一次采样缺失被删除**；判定只使用
  「本次实际存在且状态 ok」的窗口。窗口回来时其配置自动恢复生效。
- 渠道停用/删除：条目保留在配置里（不清理），不参与判定（既有 `PLAN_ENABLED_FIELDS` 逻辑）。
- 降级（旧 Host/旧 client + 新字段）：未知键被保留，旧端完全忽略 → 旧行为。
- 坏 JSON 的用户恢复路径：UI 提供一个「重置本渠道阈值」显式动作（写入该渠道条目为 0），
  以及顶层坏 JSON 时「重建为当前可见状态」的显式勾选动作，都会**先说明再写**。

---

## 5. 需要改的文件（最小集）

| 文件 | 改动 |
| --- | --- |
| `plans/quota-thresholds.js` | **新增**纯模块：词表、解析三态、per-channel 解析、多窗口/金额/积分判定 |
| `plans/usage-policy.js` | 只加 1 个字段 `quotaChannelThresholds`（并在注释里写清四态语义） |
| `plans/quota-view.js` | `stageForChannel`/`buildQuotaView` 改用 per-channel 解析 + 多窗口合并；`thresholdsOf` 保留（旧全局） |
| `plans/quota-prompt.js` | 多窗口事实行 + 触发解释行；`pickSmallestWindow` 保留导出但退出判定 |
| `index.js` | 新增 `GET /api/plan-usage/quota-windows`（只读，复用 `channelProjection/channelMeta`） |
| `client.js` | 顶部策略小节 + 每卡关注块/阈值/生效状态 + 窗口信息获取 + 校验；`save()` 只加校验段 |
| `README.md` | 「设置」节补一段策略说明（怎么勾关注、两种阈值含义、为什么不生效） |
| `tools/test-*.mjs` | 新增 3 个测试文件；2 处字段集合/计数断言按新增字段更新（理由写明） |
| `docs/…`、`.diagnostics/…` | 本设计与实现记录 |

**明确不改**：`plans/usage-tool.js`（工具输出 schema/投影）、`plans/usage-tool-register.js`
（`policy` 仍 `null`）、`plans/custom-balance.js`（自定义余额、凭据、出网）、
各 provider 模块、`plans/quota-observer.js`、`plans/quota-route.js`、退场渠道历史文件。

---

## 6. 测试矩阵

### 6.1 新增（针对性，全部用真实生产函数/真实组件）

1. `tools/test-quota-channel-thresholds.mjs`（Host 纯函数）
   - 三态：absent / invalid(坏 JSON、数组、`"3"`、字符串) / ok；坏态**不回落旧全局**
   - 显式 0 / 清空 / `closing>=warning` / `>100` / 负数 / `NaN` → 不参与，且不借旧全局
   - **双渠道隔离**：改 codex 周阈值不影响 codex 5h，也不影响 opencode-go 周阈值
   - **窗口顺序变动不串值**：`windows` 数组顺序反转/插入未知 scope → 各窗口取值不变（按 key 取值）
   - **仅周**：只有 weekly 时 5h 不参与、不借用、不显示为 5h 的回退
   - 多窗口合并：5h normal + weekly warning → 整体 warning 且 metric 指向 weekly；任一 closing → closing
   - 缺失窗口 / 未采样 / 瞬时失败：判定不用其它窗口/不用旧值（阈值解析与采样解耦，纯函数层验证）
   - 金额：币种一致才比；不一致/缺币种不参与；积分不与金额混比
   - 未知渠道键/未知窗口键：保留但不参与
2. `tools/test-quota-window-prompt.mjs`（真实 `buildQuotaView` + `renderQuotaPrompt`）
   - 单窗口文本与今天逐字一致（保护既有断言）
   - 双窗口：两行事实 + 触发行指明窗口与当前值；`normal` 零规则零指令词
   - 不平均/不求和（断言不出现相加结果）、不 5h 优先、不出现被禁用窗口的数值
   - `unobserved / unmapped / notAllowed / channelDisabled / sourceMismatch / failed / expired / noData` 零注入
3. `tools/test-quota-policy-settings.mjs`（真实 `client.js` + `mock-react` + 真实 form 事务）
   - 关注复选：只写 `quotaFocusChannels`，**不写** `quotaPolicyEnabled`/`quotaTrustRouteOrder`/凭据字段
   - 上限 8：第 9 个不写入 + 明确提示；未知/退场 id 原样保留并可取消
   - 窗口行来自 `/quota-windows` 桩（仅周 → 只渲染周）；路由缺失/失败 → 只显示已保存窗口
   - 阈值输入 → 草稿 → 保存一次 mutate，**只含变更字段**；`customKeys` 无任何 op
   - 校验失败（closing≥warning / >100 / 非数 / 超上限）→ **零写入**且错误可见
   - 「放弃更改」还原全部策略草稿；保存中所有新控件 disabled
4. `tools/test-quota-windows-endpoint.mjs`（真实 `apply` + 假 webServer/credentials 探针）
   - 形状/方法 405/未采样 → `status:'none'` 无窗口
   - identity 变了 → 只回 `status`；`failed/expired` → 无窗口（**不复活旧账号窗口**）
   - 凭据探针：`credentials.resolve` 调用次数 0；provider fetch 次数 0；响应内无 secret/URL/账号

### 6.2 受影响的既有测试（先跑、逐条记录 exit 与 assert 数）

| 文件 | 预期 | 处理 |
| --- | --- | --- |
| `test-quota-awareness.mjs` | 通过（单窗口口径不变；`pickSmallestWindow` 仍导出） | 若有「只取最短窗口」含义的断言，改为按 key 判定并注明理由 |
| `test-quota-remediation.mjs` / `test-quota-round2/3/4/5.mjs` / `test-quota-route-scope.mjs` | 通过（多用旧全局阈值，走 absent 分支） | 同上 |
| `test-usage-policy.mjs` | **S1a 字段集合失败**（多 1 个字段） | 在断言里加入 `quotaChannelThresholds` + 注释「新增按渠道/窗口阈值字段」 |
| `test-usage-tool-host.mjs` | **E9a `keys.length === 13` 失败** | 改 14，注释同上 |
| `test-usage-tool.mjs` / `-register` / `-contract-host` | 通过（工具输出未改） | 无 |
| `test-usage-integration.mjs` / `test-usage-recheck-*.mjs` | 通过（`policy` 仍 `null`） | 无 |
| `test-custom-settings.mjs` / `test-custom-race.mjs` / `test-settings.mjs` | 需实测：设置页多了 1 次 `fetch('/quota-windows')`、卡片多了控件 | fetch 桩须容错；断言按「新增控件」显式更新，不删旧断言 |
| `test-line-endings.mjs` | 必须通过 | 所有改动文件保持 **LF**（已核实现有文件 CRLF=0） |

不做：不跑无关 54 脚本全量；不因新特性重写旧断言；每条命令记录 exit code 与 passed/failed/skip 计数。

---

## 7. 本地构建与产物

- 命令：`npm pack --ignore-scripts --offline --pack-destination <dir> --cache <dir>/npm-cache`
  （`pack-destination` 与 `cache` 都在本轮工作区目录内，**禁联网、禁 publish、禁装依赖**）。
- 产物目录：`.diagnostics/policy-ui-implementation-20261023/build/`（已确认**不存在**；
  `legacy/local-build-0.9.0/policy-ui-20261023/` 也不存在，二者择一，默认用 `.diagnostics/.../build`）。
- 记录：`npm pack` 输出的文件清单、tgz 字节数、`sha256`，以及 tgz 内每个文件与工作区源码的
  逐文件 `sha256` 对照（要求 100% 一致）；`package.json` 版本**不变**（0.9.0）。
- 不部署、不重启、不 commit/push/tag/release/publish。

---

## 8. 与用户冻结要求的对照

| 要求 | 落点 |
| --- | --- |
| 1 每卡关注开关 + 阈值；focus 仍是白名单；空集=不参与 | D6 复选写 `quotaFocusChannels`；`buildQuotaView` 白名单不变 |
| 1 会话/子 Agent 按自身真实路由匹配，未知/歧义零注入 | 既有 `routeObserver` + `resolveRoute`/`resolveBinding` 不动；视图先判 `unobserved/unmapped/ambiguous` |
| 2 金额按实际币种、积分独立、双阈值、closing<warning、0=未配置、不覆盖胶囊 warn 字段 | D2/D3；`deepseekWarnThreshold`/`mimoWarnThreshold` 与胶囊 `quotaToneColor` **完全不碰** |
| 3 每窗口独立双阈值；不硬造窗口 | D1/D5/D6：窗口来自实际采样 ∪ 已保存；无采样则不给输入 |
| 4 各自判阶段、整体取最严重、提示说明触发窗口与当前值；不再 5h 优先 | D3 合并规则 + D4 触发行 |
| 4 缺失窗口/未采样/短时失败沿用既有有效性/缓存规则；不删已保存配置 | D3 只判 `ok`；`quota-observer` 的 T 分类与缓存不动；配置层永不因采样删除 |
| 5 保持总开关/信任闸门、安全默认、来源/身份/代次、Reserve 不证明不注入 | 全部**不改**；只新增解释文案 |
| 5 关注复选不打开 policy/trust、不扩凭据获取 | D6 写死：只写 focus 数组；Host 不新增凭据路径 |
| 5 UI 说明为什么未生效 + 总 policy/trust 的最小放置 | D6 顶部小节 + 逐卡「生效状态」 |
| 6 纳入整页草稿/放弃事务、绑定 this、先校验再提交、不回写 secret、不抹其它卡片字段 | D7：复用 `change`/`draft`，只加校验段；`save()` 骨架不动 |
| 6 不重写自定义 provider/取数/操作归属；不恢复退场渠道；不扩修 Inspector | 明确不改 `custom-balance.js` 等 |
| 7 旧全局阈值兼容、`.volatile()`、不假定 UI 自动生成、不静默改授权 | D2/§4 四态表；schema 字段显式声明 `.volatile()`；UI 自己渲染 |

---

## 9. 待父/用户决定项（先说明，不自创默认）

- **F1 旧全局百分比阈值的多窗口口径**：本设计让 `absent` 分支对每个窗口分别判定（撤掉 5h 优先）。
  若父要求「旧分支逐字保持旧行为（仅最短窗口）」，我改成保留 `pickSmallestWindow` 并只在卡片里标注「旧版：按最短窗口」。
  现状用户配置全 0，两种选择都不改变其实际行为。
- **F2 设置页窗口列表为「采样驱动」**：渠道从未成功采样时，窗口行不出现（避免硬造）。
  备选是「允许对三个已知 key 都输入」——我**不建议**（会硬造不存在的窗口）。
- **F3 `usage_status` 工具是否也带按渠道策略**：本设计保持 `policy: null`（唯一注入点是动态 context，
  避免提示词双源与工具输出膨胀）。若需要，可另开一轮。
- **F4 总开关/路由信任的位置**：放在设置页顶部（最小改动、显式、默认关）。
  若用户希望完全不在渠道卡里出现任何"总开关"，请明确；我不建议把它藏起来——否则"为什么没生效"无法解释。
- **F5 焦点上限策略**：达到 8 个时阻止新增并提示（不静默截断）。备选是自动淘汰最早条目——不建议（静默改授权）。

---

## 10. 裁决修订（权威，2026-10-23 父 Agent 裁决；与上文冲突以此为准）

### R1 旧配置 / legacy 分支保持最短窗口行为（F1）

- `legacy`（= 旧全局三组阈值）**继续只按 `pickSmallestWindow()` 选出的那一个窗口判定**，
  与今天逐字一致；`stageForChannel(channel, thresholdsOf, pickSmallestWindow)` **旧 API 与旧语义保留**。
- 「各窗口独立 + 整体取最严重」**只在某渠道有了自己的 per-channel 条目后启用**。
- 不因"当前用户六个阈值都是 0"就改变其它旧用户的行为；**旧阈值字段原值一律不修改**。
- UI 把 legacy 标清：`正在使用旧版全局阈值（按最短窗口判定）：预警 X / 收尾 Y`。
- **首次编辑某渠道**时，以"旧实现真正生效的那一个窗口 + 该窗口的旧两档值"初始化该渠道草稿，
  其它窗口默认 0（**不把旧 global 扩散到周/月**）。已显示的旧有效值不得在写入后凭空消失。

### R2 字段解析的权威语义（修正 §4；不再逐字用「四态」）

| `quotaChannelThresholds` 原始值 | 语义 |
| --- | --- |
| 缺字段 / `undefined` / `''`（含仅空白） | **absent**：无任何渠道覆盖 → **全部渠道走各自 legacy** |
| `null`、非字符串、坏 JSON、解析结果非对象/数组 | **整体 fail closed**：零规则，原因 `invalid-config` |
| 合法 `{}` | 没有渠道覆盖 → **全部渠道仍走 legacy** |
| 合法 root 但**没有**该渠道键 | **该渠道走 legacy**（编辑 A 不得关闭 B 的旧策略） |
| 该渠道自有 `{}` 或显式全 0 | **该渠道覆盖为零**，不借 global |
| 该渠道键存在但值不是对象 | **该渠道 fail closed**，不借 global（其它渠道不受影响） |
| 该渠道存在但**缺某个窗口键** | 该窗口 = 未配置（0），**不逐窗口退 global** |

- 条目存在 = 该渠道权威：条目里没配的指标一律「未配置」，**显式 0 不会复活旧阈值**。
- 未知/保留键：客户端只做 `JSON.parse` → 只改自己那一条 → `JSON.stringify` 原样带过；
  读写一律 **own property**，`__proto__` / `constructor` / `prototype` 直接拒绝；
  字符串上限 8192 字节、渠道条目上限 16，超出按 invalid 处理（不截断后继续用）。
- 不 eval 任何字符串，不做任何"按文案/顺序猜 key"。

### R3 设置页窗口信息（F2）

- 真实采样驱动：成功采样**只返回 weekly** 时，**不显示任何 5h 输入**、也不显示「已保存 5h 值」常规行；
  隐藏的配置原样保留，只用一句通用说明「未出现窗口的已保存配置已保留」。
- 失败 / 404 / 从未采样 **不等于确认无窗口**：只显示状态说明，不出现可编辑窗口，不造。
- 新增「刷新窗口信息」按钮（只打本插件 metadata 路由，**不触发任何 provider 取数/凭据解析**）；
  开页一次 + 保存成功 + 配置代次变化（`subscribeConfigEpoch`）时自动刷新/失效；
  用单调序号防「先发后到」的旧响应覆盖新结果，卸载时序号自增使迟到响应作废。

### R4 失败/过期提示不得被顺手改成零注入（修正 §6.1.2）

- **保留**既有契约：渠道已关注、路由已知时的 `failed` / `expired` / 暂无额度数据
  仍输出固定状态短语（`获取额度失败` / `用量查询身份已过期` / `暂无额度数据`）。
- 只有**原本就零投放**的分支才必须继续零投放：`quotaPolicyEnabled!==true`、focus 为空、
  路由未观察、`unmapped`、`ambiguous`、不在 focus、渠道停用、identity/source 不匹配、
  Reserve 池未证明、阈值配置被 fail closed。

### R5 每个渠道（含自定义余额卡）的覆盖方式（修正 §D6/F4）

- 自定义余额卡**也提供**「关注额度策略」+ 金额两档，实现方式仅限：设置页通过 `policyFooter` prop
  把**公共策略块**追加到该卡底部（不改 `CustomBalancesSection` 的 provider/取数/Key/复制删除/折叠逻辑）。
- 自定义渠道的币种只认「可信采样的 `currency`」或「该条目已明确保存的 `currency`」；
  两者都没有 → 输入禁用并说明「币种未知，无法比较金额」，**绝不默认 CNY**。
- 若某渠道在实现中无法以"孤立 UI 附加"的方式安全覆盖，将在实现记录里**明确写未覆盖**，
  不静默把该卡从「每渠道」需求里删掉；不新增任何 provider/取数路径。

### R6 保存校验不得由"未改动的卡片"阻塞（F5 + #5）

- 只校验**本次草稿实际改动**的字段：`quotaChannelThresholds` / `quotaFocusChannels` 未变 → 完全跳过校验
  （历史坏 JSON 不阻塞其它保存，也不会被自动重写）。
- `quotaFocusChannels` 里的**合法未知成员**（退场 id、自定义 id）不阻止保存；也不新增未知成员。
- focus 坏 JSON：显示解析错误并**拒绝有害写入**；若提供重置，必须是单独显式动作、只写进草稿
  （重置为 `[]` 是安全值，但绝不隐式删除原数据）。
- 金额币种只认可信采样或已明确保存的币种；**不猜**、不默认 CNY。来源改变时按既有 identity/source
  保护直接拒绝旧数据（不改这条链路）。

### R7 回退/回滚说明（对交付文档的强制要求）

- 「schemastery 对未知键原样保留」只证明**字段不会丢**，**不证明语义等价**：
  旧版本忽略新条目时，可能**复活旧 global 收尾**。
- 因此交付文档必须写明：回滚代码 = **同时关闭策略** 且 **恢复试装前的公开策略配置**；
  不得宣称"换回旧 tgz 即语义相同"。也不许用清零旧字段的方式掩盖该风险。

### R8 已确定不再需要决策的项

F1（legacy 最短窗口）→ 按 R1；F2（采样驱动 + 刷新按钮）→ 按 R3；F3（`usage_status` 仍 `policy: null`，
公开 schema/投影不动）→ 保持；F4（顶部显式 policy/trust，默认不变；文案改为
「仅确认当前路由观察链可靠时启用；不能确认则保持关闭」，不得写"本版本没有公开安装顺序证据"，
勾关注绝不暗开信任）→ 按此实现；F5（8 上限阻止新增 + 未知成员保留可取消）→ 按 R6。

---

## 11. 实现与验证记录（2026-10-23，已实现并本地构建）

- 新增 `plans/quota-thresholds.js`（解析四态 + 多窗口/金额/积分判定 + `describeWindowCapability`）；
  `plans/usage-policy.js` 只加 1 个字段；`quota-view.js` / `quota-prompt.js` 接入；
  `index.js` 加只读路由 `GET /api/plan-usage/quota-windows`；`client.js` 加顶部策略闸门、
  每卡关注/阈值/「为什么未生效」、窗口信息获取（序号防迟到）与保存前校验；README 补「额度策略」小节。
- 旧签名旧语义全部保留：`thresholdsOf`、`stageForChannel(ch, thresholds, pickSmallestWindow)`、
  `evaluateStage`、`pickSmallestWindow`；legacy 分支仍只判最短窗口。
- 测试（**按轮次记，不把某一轮的数字当作"当前总数"**）：
  - 首轮（候选 `5B5721E1`）：4 新文件 183 项 + 相关 42 脚本 1427 项；父独立 probe 11 红 → 拒收。
  - R2（候选 `98AE7AFF`）：4 新文件 216 项 + 相关 42 脚本 1427 项 = 当轮 1643 项；
    父 probe 12/12 + 验包 PASS，但 `reviewer-source-change.mjs` FAIL（metadata 旧缓存）→ 阻断。
  - R3（候选 `7B856194`）：4 新文件 225 项 + 少量既有脚本 394 项 = 当轮 **619 项、0 失败**；
    另跑过 15 个只依赖 `index.js` 的 Host 侧脚本（其后 `index.js` 未再改动）全部 exit 0；
    父 3 个 probe 全 PASS（行为 12/12、source-change、ui-edges 3/3）。
  - R4（候选 `EE51B81A`，**最终**）：4 新文件 **233 项** + 5 个核心脚本 **280 项** =
    当轮 **513 项、0 失败**；父 4 个脚本 **20 场景全 PASS**
    （probe 12 + source-change 1 + ui-edges 4 + metadata-errors 3）。
  逐条命令与计数见 `.diagnostics/policy-ui-implementation-20261023/build-record.md`。
  两处既有断言按新增字段更新（`test-usage-policy` S1a、`test-usage-tool-host` E9a 13→14），
  理由已在断言里注明；**没有删除任何旧断言来凑通过**。
- `test-line-endings` 在受限会话里无法运行（沙箱禁止 Node 用管道 stdio 启动子进程，
  `spawnSync('git',…)` 恒 `EPERM`）；改动文件均字节扫描确认 `CRLF=0`，
  父已在规范环境跑过该脚本（exit 0）。
- 最终候选包：`build/dsh-usage-dock-0.9.0.tgz` = 263563 字节 /
  sha256 `EE51B81A…42CB2626` / 28 文件 / 与源码逐文件对照 mismatch=0（版本仍 0.9.0）。
  历史候选按原字节保留：`rejected-r1/`（`5B5721E1`）、`rejected-r2-98AE/`（`98AE7AFF`）、
  `rejected-r3-7B85/`（`7B856194`），未覆盖未删除。
- **未部署、未重启、未提交、未发布、未做真机验证**；真实 GUI 与模型提示词注入仍待父核查。


### 独立审查 R1 修订（2026-10-23 第二轮）

父用独立 probe 复现了 11 项缺陷（P01–P11，P12 已通过），本轮逐条修复：

- **P01/P02/P03**：设置页对「走旧全局阈值」的渠道显示旧有效值；**首次直接改输入也先 seed**
  该渠道旧时真正生效的那一档/那一个窗口，再改目标字段（不再依赖 toggle）。
- **P04**：保存校验改为校验**原始 JSON**（>100、负数、非数字、非法币种、坏结构都拒绝），
  写入层不再把非法文本静默变 0，显示层不再夹取越界值；校验失败整页零写入、草稿保留。
- **P05**：所有策略处理器基于最新草稿（`policyBase()`）计算并一次提交，同批多字段/多窗口不再互相覆盖。
- **P06**：旧金额阈值缺币种 = 旧规则本来无效，seed 不用当前采样币种给它"补"成有效规则。
- **P07**：Host 与 UI 双端都**拒绝**任意层级的 `__proto__`/`constructor`/`prototype`（整份 invalid），
  不再"跳过危险键后降级成 legacy"。
- **P08**：金额/积分阈值不再有 1e12 上限（旧 `normalizeBalanceThreshold` 本就允许任意有限正数）；
  百分比仍为 (0, 100]。
- **P09/P11**：状态行只列**本次实际出现且已配置**的窗口；监控总开关关闭、失败/过期、身份变化、
  币种不一致都如实说明"为什么没参与"，不再把"仅事实"说成"已参与"。
- **P10**：窗口能力按**已保存配置签名**变化刷新并先清旧值（防迟到旧响应），保留手工刷新按钮。
- **路由级身份**：`/api/plan-usage/quota-windows` 入口改为读一次配置 → 同步 `quotaCfg`
  → `reconcileIdentities()` 后再描述能力（仍零凭据、零上游），不再依赖异步事件。

### 阻断项 R2：metadata 不得读 2 秒旧配置（2026-10-23 第三轮）

父用真实 apply 复现：opencode 成功建立两窗口后换 Key，**0ms** 请求 metadata 仍返回上一个来源的
`ok` + 两窗口，且 `configurationReads` 增量 0 —— 该路由当时走的是带 2 秒缓存的 `liveConfig()`。

- `createLiveConfig` 新增 **`freshStrict()`**：绕过 2 秒缓存且**不吞异常**（无 `configEditor` 时返回启动
  快照，该部署本来就不能热重读，属既有已知限制）。**没有全局关闭 2 秒缓存**，取数路径不变。
- metadata 路由改用 `freshStrict()`：读一次 → 同步 `quotaCfg` → `reconcileIdentities()` → 再描述；
  **读不到当前配置即 fail closed**（回空 `channels` + `fresh:false`），绝不用旧配置冒充当前配置。
- 复测：父用例 PASS（`configurationReadDelta=1`、0 采样、0 凭据解析）；我的 W3 按同构造重写
  （合成两窗口、**不 sleep、不等 TTL/事件**）。

### R3 批次：UI 来源签名 + 原生非法输入（2026-10-23 第四轮）

父的 `reviewer-ui-edges.mjs` 复现两项 UI 侧缺陷，另加一项原生输入合同反例：

- **E01/E02 来源签名不完整**：`policyConfigSignature` 曾漏掉 WorkBuddy 账号选择与自定义条目的
  provider / 余额接口字段，换来源后不重取窗口能力。现改为复用已与 Host 同构的
  `configDigestOfClient(value)`（含 provider / balanceEndpoint / 路径 / 扣减键 / 币种 / 凭据引用 /
  目标确认 / 启用状态 / **公开** Key 修订号）+ 规范化的 `workbuddyAccounts`；只读公开字段，
  依赖**已保存**快照（未保存草稿不会被当成"来源已切换"），账号列表顺序变化不算切换。
- **E03 原生非法数字输入**：`input[type=number]` 里非法内容给出 `value:''` **同时**
  `validity.badInput:true`，那不是"清空"。新增 `policyReadNumberEvent()`：`badInput` 为真 → 拒绝并提示
  「输入的不是有效数字…本次未修改」，**不写入**；真正空输入（`badInput !== true`）仍是 0 = 未配置。
  四类阈值输入统一走该入口。
- 复测：父三个脚本原样重跑全部 PASS（行为 12/12、source-change、ui-edges 3/3）；
  本轮只重跑 4 个新测试（225 项）与少量既有脚本（394 项），不重跑无关全量。

### R4 批次：错误信封 fail-closed + 顶部开关保草稿（2026-10-23 第五轮）

- **F01/F02（父 `reviewer-metadata-errors.mjs`）**：`configEditor.configuration()` 返回 `{}`（坏形状）
  或 `[]`（缺本插件条目）时，`freshStrict` 曾回落到 `cached.value`，于是 metadata 把上一个来源的
  窗口连同 `fresh:true` 一起返回。现在「有服务却拿不到当前配置」= **抛固定错误**，
  路由返回明确失败信封；「没有 configEditor → 启动快照」的既有兼容分支保留。
- **F03**：客户端对 metadata 响应增加校验（HTTP 状态按约定兼容缺失、`body.ok === true`、
  `data.channels` 为普通对象）；失败即标 error、清空旧能力，固定提示
  「未能读取窗口信息，已保存配置保留；获取失败不代表没有该窗口。」（不透传异常文本）。
- **E04（父 ui-edges 追加项）**：两个顶部开关（总开关 / 路由信任）同批点开时前者丢失，
  根因是它们仍走通用 `change()`（基于渲染期 `current`）。现已改为 `policyCommit`（最新草稿），
  未改动通用 `change()`。
- 复测：父 4 个脚本 **20 场景全 PASS**；我的测试新增 W5a–W5d、S26a–S26c、S27a。



### 回滚（必读）

「未知键原样保留」只保证字段不丢，**不等于语义等价**：旧版本会忽略新字段，
某些渠道可能退回旧全局阈值（旧收尾重新生效）。因此回滚 = **关闭额度策略 + 恢复试装前的
公开策略配置**；不要宣称"换回旧 tgz 即语义相同"，也不要用清零旧字段来掩盖这个风险。

---

*设计完成：2026-10-23；已按 §10 裁决修订并完成实现/针对性测试/本地候选包（未真机验证）。*
