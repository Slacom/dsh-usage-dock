# 0.9.0 审查整改记录（R1–R7 + 连接目标安全）

> 2026-10-18。对象是 [独立审查](review-v0.9.0-local.md) 对 0.9.0 本地构建提出的 R1–R7 与
> 「DNS 检查未与连接绑定」安全偏差。**只整改既有实现**：未推进方向 6（未注册任何模型工具、
> 未加收尾策略），未部署到当前 profile、未改 DSH 宿主、未重启、未提交、未打标签、未推送、未发布。
>
> 结论：R1–R7 全部按「先写会失败的复现测试，再改实现」处理；安全偏差改为**连接期绑定**
> （`node:https` + 钉死已核验 IP 的 `lookup`），并在无法绑定时保守拒绝而不是静默降级。

## 0. 复现测试（先失败、后通过）

| 文件 | 项数 | 对应 |
| --- | --- | --- |
| `tools/test-review-fixes.mjs` | 40 | R1（8）、R2（9）、R5（5）、安全（12）、R4 wire（4）、R7 前置（2） |
| `tools/test-custom-race.mjs` | 39 | R3（7）、R4（7）、R6（4）、R5 客户端（7）、R4 停用（2）、**V2（7）**、R6 拒绝/抛错（5） |
| `tools/test-config-unwrap.mjs` | 22 | R7 端到端（真实 `Config` → `apply` → provider） |

三组在修复前全部失败（`credentialFingerprint` 等导出甚至不存在），修复后全绿。

## 0b. 第二轮复核（V1–V5）复现与修复

[第二轮复核](recheck-v0.9.0-remediation.md) 指出 R1/R3/R5 尚未关闭，并新发现两项 HTTPS 路径问题。
逐项处理如下，复现用例在 `tools/test-recheck-fixes.mjs`（25 项）。

### V1 / P1 / R5 — 非默认端口 origin 错误

**缺陷**：`validateBalanceUrl()` 只返回 `hostname`，`originOf()` 又从 `host`（`URL.host` **已含端口**）
拼一次并追加 `URL.port`，于是 `https://a.example:8443` 变成 `https://[a.example:8443]:8443`，
普通域名里的冒号还被当成 IPv6。后果：**正确的 `:8443` 确认被拒，旧的 `:443` 确认反而能向 8443 发 Key**。

**修复**：

- 新增 `composeOrigin(scheme, hostname, port)`：只接受 hostname，端口去前导零、空端口回落协议默认值、
  默认端口不写进结果、IPv6 加方括号。
- `originOf()` 统一支持 `URL` / 字符串 / `{protocol,hostname,port}` / `{url}` 四种输入，结果一致；
  另加 `splitHostPort()` 处理 `host[:port]`（IPv6 的端口在 `]` 之后）。
- `normalizeOriginField()` 与 `originOf()` 共用同一套规则（幂等），兼容旧版「只存裸主机名」。
- `validateBalanceUrl()` 返回值新增 `origin`（以及 `hostname`/`port`/`protocol`），请求路径**直接用它**，
  不再从 host 二次拼装。

**复现→通过**：`V1a/b` 返回可比较 origin；`V1f/g/h/i` 幂等、大小写/尾点/前导零端口、IPv6、默认端口；
`V1j` 正确的 `:8443` 能发送；`V1k/l` 旧 `:443` 确认对 8443 **零请求**；`V1m` 只改端口也拒绝。

### V2 / P1 / R3 — 已渲染 state 未即时作废

**缺陷**：`customSignature` 变化能 abort 旧请求、删除/停用也能即时隐藏，但组件 **state 里上一次成功
余额没动**，新 effect 只清 `lastList/failStreaks/customGens`。改 URL/币种后新请求等待期间仍画旧余额
（`BEFORE A$ 91.23` → `AFTER_CHANGE A$ 91.23` → `AFTER_RESPONSE B¥ 1.25`）。

**修复**（[client.js](../client.js)）：

1. **逐条身份签名** `customEntrySignature()` / `customConfigSignatureMap()`：只含影响取数的字段
   （不含名称），粒度到条目——A 改了 URL 不会牵连 B/C 的成功基线。
2. **数据所属身份** `state.applied = { epoch, entries }`：成功响应时打戳；失败沿用旧数据时
   **保留旧戳**（用 ref 跨 effect 重建传递），因此旧值仍会被拦住、不会因一次失败又冒出来。
3. **渲染时校验** `customDataStillValid()`：本条签名 ≠ 数据戳里的签名 → 立即不显示；
   本条在数据戳之后被「只改 Key」标记为脏 → 立即不显示。
4. **Host 配置缓存防护** `wireMatchesCurrentConfig()`：`gen` 由身份算出，「同 id 同 gen 但签名已变」
   只可能是 Host 还在用旧配置（2 秒缓存）→ **丢弃且不让 carry 复活**；只改 Key 时签名不变，
   再看 dirty 代次。`knownGens` 放在**组件级 ref**，否则 effect 重建后旧 gen 记忆丢失、旧快照又会被当成新数据。
5. 设置页保存时把**本次真正写过 Key 的 id** 传给 `bumpConfigEpoch(touched)`。

**复现→通过**：`V2a–d` 已有 `$91.23` → 改 URL+币种 → 旧值立刻消失（旧快照也不冒充新数据）→
新响应到达显示 `¥1.25`；`V2e–g` 只改 Key 同样立刻作废；`tools/test-custom-race.mjs` 的
`V2b/c` 覆盖同场景。无关的内置/自定义渠道不受影响（签名逐条比较）。

### V3 / P2 / R1 — 单条预算被整批 deadline 放大

**缺陷**：`createBudget(totalMs, deadlineAt)` 一旦收到 `deadlineAt` 就**忽略** `totalMs`，
worker 传的是 `createBudget(min(perItem, batch.remaining()), batch.deadlineAt)`，
于是子任务继承整批 20 秒，单条 10 秒（乃至 15 ms）形同虚设。

**修复**：`end = min(now + totalMs, deadlineAt)`。

**复现→通过**：`V3a` 子预算不被更远 deadline 放大；`V3b` 整批更近时取整批；
`V3d–f` 单条 15 ms + 整批 120 ms + DNS 65 ms → 零请求、结构化暂时失败、耗时 < 100 ms。

### V4 / P2 / HTTPS 冷启动并发

**缺陷**：`loadHttps()` 先置 `httpsProbed = true` 再 `await import()`，同轮第二个并发调用拿到
尚未赋值的 `httpsModule`（undefined），读 `https.request` 抛 TypeError，且在 `requestJson` 的
try/catch 之外——冷启动 3 并发时 2 个直接 reject。

**修复**：缓存**同一个 Promise**，所有调用都 await；不可用统一解析为 `null` → 受控 `unbound`。

**复现→通过**：`V4a/b` 用查询串取**全新模块实例**（同进程冷启动，不依赖 TLS 用例预热），
三并发全部返回结构化 network、无一抛错。

### V5 / P2 / 截断响应被当成功

**缺陷**：`makeStreamResponse.read()` 把 `iterator.next()` 的异常 catch 成 `{done:true}`，
`ECONNRESET`/`aborted`/`premature close` 全变成「正常 EOF」；只要前缀是合法 JSON，
不完整 HTTP 响应也会被当成功余额。

**修复**：

- **不 catch**：让 stream 错误冒泡到 `readLimitedBody`，归类为 `unreadable`。
- **校验完整性**：EOF 后若 `res.complete === false`（Content-Length 不足 / chunked 未终止 /
  中途断开）→ 抛错，不当作读完。

**复现→通过**：`V5a` 真实 TLS 服务声明 `Content-Length: 100` 只发合法 JSON 前缀后断开 →
不再被判为成功；`V5b` 完整响应仍正常读取（回归）。

## 0c. 第三轮复核（W1–W3）复现与修复

[第三轮复核](recheck-v0.9.0-round3.md) 确认 V1/V3/V4/V5 通过，但 V2 仍有三处缺口。
逐项处理如下，复现用例在 `tools/test-recheck-round3.mjs`（29 项）。

### 共同根因：客户端在「猜」Host 用的是哪份配置

0.9.0 用「浏览器是否见过这个 gen」判断数据新旧。这个判据有两处结构性缺陷：

- **W1**：从没见过 gen（首个请求被取消）时，旧配置 wire 被直接接受；
- **W2**：重复保存同一把 Key 时 gen 不变，脏标记永远拒绝，没有恢复路径。

### 配置身份协议（W1 + W2 的统一修法）

改为**由 Host 出证**，不再让客户端猜：

1. `configDigestOf(cfg)`（Host）与 `configDigestOfClient(config)`（客户端）用**同一套规则**
   计算 16 位摘要，输入是每条自定义条目的公开身份
   （id/url/路径/扣减键/币种/凭据引用/目标确认/启用）+ 该条的**非密**修订号。
   条目顺序敏感；已删条目但修订号仍在时按 `orphan:` 参与（防「删了 Host 还回旧条目」被当成一致）。
2. 新增公开配置字段 `customKeyRev`（`z.dict(z.number())`，**非密、单调递增**）。
   设置页每次写该条 secret（**包括写入相同的值**）都在**同一次 mutate** 里把它 +1，
   因此「Host 读到的修订号」与「Host 读到的 Key」永远配套。
3. Host 路由把 `data.cfg = { digest, readAt, reloadable }` 随响应返回。
   `digest` 用**本次实际读到的 cfg** 计算；`reloadable` 表示本部署有没有 `configEditor`。
4. 客户端 `responseMatchesCurrentConfig(result)` 只比较摘要：相等才认这批数据，
   不相等（Host 还在读旧配置）→ 整批不显示、**也不**把它标成当前配置的 applied。
   旧 Host 不返回 `cfg` 时退回不校验，避免把老版本用户全部打挂。

**W1 复现→通过**（`W1a–d`）：初始 A 配置的首个请求挂起 → 保存 B → 第二次请求命中 Host 旧缓存
（返回 A 的 USD 91.23 与一个浏览器从没见过的 gen）→ 现在**不显示**；迟到响应不回填；
Host 读到新配置后恢复显示 `¥1.25`；**组件重挂**（所有 ref 清空）后仍拒绝。

**W2 复现→通过**（`W2a–g`）：先显示 `$91.23` → 重复保存同一把 Key（幂等写入）→ 旧值立刻隐藏 →
Host 返回同一 gen 的合法结果 → **恢复显示**（不再永久拒收）；真正换 Key 也能恢复；
Host 配置不匹配时仍拒绝（W2 的修复没有破坏 W1）。

> 为什么不删掉 dirty 检查：`configDirtyIds` 保留为**渲染期兜底**，覆盖「保存动作已发生、
> 新响应还没到」的几秒；真正的来源确认交给摘要。删掉它会让保存后的旧值回填。

> 为什么不用 SHA-256：浏览器渲染期没有同步的 SHA-256（`crypto.subtle` 是异步的），
> 两端必须能算同一个值，因此统一用 FNV-1a 64 位双通道。它是**一致性指纹**不是安全摘要 ——
> 伪造它没有意义（对手要改的是 Host 实际读到的配置），而 Key 从不进入这个输入。

### W3 — 按渠道保留基线与失败计数

**缺陷**：effect 依赖整个 `customSignature`/`configEpoch`，每次重建都 `lastList=null`、
`failStreaks={}`；组件级 ref 只保留了 applied/knownGens，没保留成功余额。
于是「只改 A」会让未改动的 B（以及所有内置渠道）首次暂时失败就直接报「获取失败」。

**修复**（[client.js](../client.js)）：

- `lastList` / `failStreaks` / `customGens` 移到**组件级 ref**（`lastListRef` / `failStreaksRef` /
  `customGensRef`），effect 重建不再清空全表。
- effect 启动时只**逐条**作废：配置里已删除/已停用，或该条的身份签名与 `applied.entries`
  快照不同 → 清掉它的基线与计数；其余条目（含内置渠道）原样保留。
- 整体请求失败时也走同一条「沿用 + 计数」路径，因此内置渠道的基线同样不受自定义配置变更牵连。

**复现→通过**（`W3a–i`）：A 11.11 / B 22.22 → 只改 A → 下一轮 A 33.33、B 同 gen 暂时 500 →
显示 A 新值 + B 的 22.22（灰化，**不**报获取失败）；整体网络失败时内置 `7.38` 仍沿用；
第 7 轮暂时失败仍保留旧值、第 8 轮才转「获取失败」。

## 0d. 第四轮复核（X1–X2）复现与修复

[第四轮复核](recheck-v0.9.0-round4.md) 确认 W1–W3 已通过，但配置身份协议仍有两处边界缺口。
复现用例在 `tools/test-recheck-round4.mjs`（33 项）。

### X1 / P2 — 双端摘要规范化不一致

**缺陷**：Host 的 `entryPublicIdentity()` 对 URL/键路径/引用做 trim + 截断、对币种规范化、
对 `credentialHost` 小写化；客户端的 `configDigestOfClient()` 直接拼**原始字段**。
于是 `url = ' https://a.example/b '`、`balancePath = ' balance '`、`currency = 'usd '`
这些**设置校验与 Host 解析都接受**的合法输入，会让 Host 的成功证明永远与客户端不等 ——
数据被当成「旧配置」拒绝，界面只剩「—」，且无法自行恢复。

**修复**：把规范化放进**摘要计算**里，两端共用同一规则（不是「保存时 trim」——
那样既有配置 / CLI / YAML / 真实 Config 解析路径仍会不一致）。

- 客户端新增 `digestText()`（trim + 按上限截断）、`digestCurrency()`（trim + 大写，
  2–6 位字母否则归一为空串）、`digestEntryIdentity()`（与 Host `entryPublicIdentity` 逐字同构）。
- `configDigestOfClient()` 改用 `digestEntryIdentity()`。
- `customEntrySignature()` 也改用同一规范化 —— 否则 `' https://a '` 与 `'https://a'`
  会被当成两条不同身份，导致「明明没改却被判成改过」而反复作废基线。
- Host 侧 `entryPublicIdentity()` 补注释明确它是**双端共用契约**，任一侧都不能单独改。

**复现→通过**（`X1` 12 个用例 + 3 个负例）：URL 首/尾/两侧空格、路径空格、扣减键空格、
币种小写/混合/带空格、`credentialHost` 大写/尾点、`credentialRef` 空格、缺字段、
非法币种、超长 URL 截断、重复/非法 id —— 全部「Host 出证 → 真实 Badge 显示余额」；
配置**确实不同**时仍然拒绝（没有为了「都能显示」而放宽比较）。

### X2 / P2 — 只有 customKeyRev 变化时不生效

**缺陷**：`expectedDigest` 在 effect 启动时被读进**闭包变量**，而 effect 依赖只有
`enabled/customSignature/configEpoch`。别的窗口保存 Key 时，本页只收到 form 快照里
`customKeyRev` 的变化（没有本地 `bumpConfigEpoch`），于是：
① 旧余额不隐藏；② 在途/后续响应全部与闭包里的旧摘要比较 → 连**匹配新修订**的正确结果
也被拒绝，强刷不恢复。

**修复**：

- `responseMatchesCurrentConfig()` 改为比较 `expectedDigestRef.current`（每轮 render 更新的
  **当前**摘要），不再用闭包变量。
- effect 依赖加入 `expectedDigest`：公开修订变化也会重跑 effect → abort 在途旧请求 →
  按新摘要比较。
- 逐条身份 `customConfigSignatureMap()` 改为 `customEntryIdentityWithRev()`：
  **包含该条公开 Key 修订号**。这样「另一窗口保存 Key」即使元数据一模一样，该条身份也变了，
  旧余额与旧基线作废；其它条目不受影响。
- effect 启动时的逐条清理改用渲染期算好的 `customSignatures`（含修订号），不再自己重算。

**复现→通过**（`X2a–k`）：form.publish 只改 `customKeyRev`、**不调用**
`invalidateCustomChannel` —— 新请求挂起期间旧值立刻隐藏；旧修订证明被拒绝（不回填）；
匹配新修订后显示 `$12.34`，连续强刷仍稳定；A 的修订变化不牵连 B 的 22.22 与失败计数；
幂等保存（同一把 Key 再 +1）也能恢复。

> 没有删摘要校验、没有删 dirty 兜底、没有每次清空全表、没有固定等待 2 秒、
> 也没有放宽任何旧断言。

## 0e. 方向 6 实施（`usage_status` 模型工具，本轮授权）

用户本轮明确授权实施方向 6（T0–T4）。**重新核验**了宿主 tools 契约（从 `app.asar` 直读
`@deepseek-ai/dsh-tools` 真实实现，未沿用补证记录里的推断），据此手写符合契约的工具定义
（**不 import** 宿主包）。完整记录见 [方向 6 实施记录](direction6-0.9.0.md)。

### T0 契约（写代码的依据）

- `ctx.tools.register(definition)` 返回**精确 disposer**；定义形状
  `{ name, description, parameters, output:{ schema, render }, execute(args, exec) }`。
- 注册校验：必须有 `output.render`；`assertSupportedJsonSchema(output.schema)`；
  `run_code` 是保留名。
- `execute` 返回值必须是 lossless JSON 且**符合 `output.schema`**，否则宿主报 `INVALID_TOOL_OUTPUT`。
- Schema 只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解关键字。

### T1 投影（`plans/usage-tool.js`，纯函数）

白名单逐字段重建（**不透传** wire）；脱敏（Key/Cookie/URL/路径/账号/上游原文一律不出）；
`0` 有效、负数保留、缺失为 `null`；Codex 百分比显式 `percentMode:'remaining'`；
退场 id → `unknown + retired-channel`（不取数、不复活）；未知 id 是**参数错误**。

### T2 编排（`plans/usage-tool-register.js` + `index.js`）

查询范围 = 白名单 ∩ 已启用 ∩ 用户请求（停用渠道**显式点名也不取数、不发凭据**）；
只取需要的渠道；30 秒**成功**缓存 + single-flight + 按配置摘要分代；
单次 8 秒预算（超时不 reject，标 `missing`）；缺 `tools` 服务时静默跳过且不影响胶囊与路由。

> **实现中真实发现并修掉的两个问题**：① 注册发生在 `apply` 时（配置还没读到），
> 早期把启用集合当同步值求值，导致**首次调用永远查不到渠道**（回归 `R11a–e`、`R12a–c`）；
> ② 空查询集合仍会打一遍上游（已改为直接返回空）。
> 另有 ③ 显式查询未与「已启用」求交集，停用渠道仍被取数（`E12b` 抓出，已修）。

### T3 策略（`plans/usage-policy.js`，**默认关闭**）

四个 `.volatile()` 字段（`quotaPolicyEnabled` 默认 false）；`policyOf()` 在未启用/无关注渠道/
阈值无效时返回 `null`（宁可不说话）；`evaluateChannel()` 对 `error/unknown/unavailable/
unlimited/stale` **一律不参与**；提示文本明确「不构成强制停工」，且不含「必须停工/重启/切模型」
（有断言守）。

## 0f. 方向 6 首次复核整改（D6-A～D6-H）

[方向 6 首次复核](review-direction6-v0.9.0.md) 判定「框架已搭建、尚不通过」，列出 8 组问题。
本轮逐组修复，完整对照见 [方向 6 实施记录](direction6-0.9.0.md)。要点：

- **D6-A 请求范围**：`fetchCustomPlans` 新增 `onlyIds`，在**任何凭据解析/DNS/请求之前**缩小条目；
  工具层 `describe` 不再解析凭据，身份解析单独由 `identify(ids)` 按本次请求完成。
  此前「取完所有条目再过滤结果」的越界已消除（`E3a–f`）。
- **D6-B 缓存身份**：缓存键 = `id + 配置代次 + 凭据身份`（身份为 Host 内部短哈希）；
  账号/会话型渠道（deepseek/codex/workbuddy/workbuddy-ai）**完全不缓存**，宁可重取也不猜账户。
  collect 返回前校验代次，不一致就不出数（`R9a–h`、`E12`）。
- **D6-C 真实语义**：新增 `percentSemanticsOf()`（只有 codex 是 remaining，OpenCode 的
  `usagePercent` 是已用 → 换算成剩余）；WorkBuddy 读 `creditsTotal`；DeepSeek 带回实际币种
  （不再硬编码 CNY、混合币种返回 null）；百分比越界置 null 不钳位；
  `disabled` / `not-found` / `missing` / `no-credential` / `retired-channel` 各自可辨。
- **D6-D 缓存与时间**：只缓存 `ok`/`unlimited`；失败不缓存可立即重试；成功采集写 `fetchedAt`，
  命中缓存不刷新，重新采集才更新（`R7`、`R8`）。
- **D6-E 预算与取消**：deadline 从 `execute` 入口创建，覆盖 describe/identify/取数；
  组合 `exec.signal`；`onChannel` 逐渠道回传，慢渠道不再抹掉快渠道；
  所有调用方离开即 abort 底层；卸载清空缓存与在途任务（`R4`、`R5`、`R6`）。
- **D6-F 值级脱敏**：`resetsAt` 严格校验并规范化 ISO，`resetInSec` 限制区间，非法置 null
  （`P4`、`P10f–j`）。
- **D6-G 策略接入**：策略文本进入工具结果 `policy` 字段与 `render`；
  另注册宿主公开 `systemPrompt.section`（`dsh-usage-dock.policy`），配置变化重建、卸载清理、
  缺服务静默跳过。**确认「必须改宿主」的原判断不成立**（`R10`、`E8`、`S7`）。
- **D6-H 阈值授权**：两个阈值默认 **0 = 未配置**，不再自动补 20%；金额判据必须绑定币种，
  积分永不与金额比较（`S1`–`S4`）。

## 0g. 方向 6 二次复核整改（Y1–Y4）

[二次复核](recheck-direction6-v0.9.0.md) 确认 D6 多数条件已修复，仍列四组缺口。逐项：

- **Y1 身份贯穿缓存与 single-flight**：共享任务键加入 `identity`，任务记录启动时的
  generation/identity，交付与回写都以任务身份为准；调用方身份不符则不交付；
  身份不可证明的渠道改用**私有任务**（不共享在途）。内置渠道的身份改为同时解析
  provider 真实回退的 `source.refs` 实际值（OpenCode 就是走这条），轮换引用后必然重取。
- **Y2 预算贯穿真实内置路径**：`plan.fetch(ctx, shell, cfg, options)` 接收
  `{ signal, remaining }`，`curlJson` / `fetchBackend` 绑定更短预算，取消后**不再尝试下一个后端**；
  `collectPlans` 逐渠道 `emit` 回传并在**采集当时**写 `fetchedAt`，不再等悬挂渠道；
  `withinDeadline` / `awaitWithinDeadline` 监听 abort（配置读取阶段也能立即取消）。
- **Y3 策略段落独立生命周期**：订阅宿主公开事件 `app-boot/config-reload` 刷新段落
  （`dsh-settings` 自身也使用该事件），不调用工具也能在启用/关闭/改阈值后更新；
  加 `alive` 保护，卸载后不再注册。文案改为「`policy` 非 null 且带 text 才算触发」。
- **Y4 DeepSeek 混币**：只对**可证明同币种**的钱包求和；异币或未知币种 →
  `balance: null` + `mixedCurrency: true`（明细仍用 cashBalance/bonusBalance），
  工具投影为 `unknown`，不得进入金额策略。

证据：`tools/test-usage-recheck-y1y4.mjs`（41 项）；另有
`tools/verify-y-mutations.mjs` 做变异校验——把上述任一修复回退，对应用例都会失败
（Y1a / Y2b / Y3b / Y4a），证明用例不是「写完就绿」的摆设。

## 0h. 方向 6 第三轮复核整改（Z1–Z3）

[第三轮复核](recheck-direction6-round3-v0.9.0.md) 确认 Y4 模型安全条件通过，仍列三处缺口：

- **Z1 身份即发送凭据**：`identify` 采样后把解析到的凭据值作为**快照**随请求下发；
  `resolveApiKey`（内置）与 `fetchCustomBalance`（自定义）都优先用快照，不再二次解析，
  从根上消除「采样 A、发送 B」的窗口；快照缺失按未配置处理，不偷偷回退。
- **Z2 自定义渠道取消与逐条进度**：`fetchCustomPlans` 把外部 signal 联到整批预算与
  `requestJson` 的传输 controller（取消即中断在途请求、worker 不再启动新条目）；
  新增 `onItem` 逐条回传并在**采集当时**写 `fetchedAt`，快条目不再被慢条目拖丢。
- **Z3 reload 必须作废配置缓存**：`createLiveConfig` 增加 `invalidate()` 与读取代次
  （防止较早的慢读覆盖新状态）；`app-boot/config-reload` 回调先 `invalidate` 再重建段落，
  缓存窗口内一次事件即生效。

证据：`tools/test-usage-recheck-z1z3.mjs`（25 项）；`tools/verify-z-mutations.mjs` 做变异校验，
回退任一修复都会让对应用例（Z1a / Z2a2 / Z2b / Z3b）失败。

## 0i. 增量改进（Z4）：混币界面不再叫「获取失败」

第三轮复核的非阻塞呈现建议（原话：不要追加为放行条件、不要恢复错误求和）。
本轮按用户「继续修复」处理，范围限定在**呈现**，安全行为不变：

- `plans/deepseek.js` 增补逐钱包币种 `cashCurrency` / `bonusCurrency`；
- 胶囊：混币且无总额 → 「多币种」（原为「获取失败」）；
- 详情：说明「余额包含不同币种，无法合计为一个数字」，逐笔展示；只在币种可证时带符号，
  未知单位标「（币种未知）」；单币种展示完全不变。

证据：`tools/test-mixed-currency-ui.mjs`（5 项）、`tools/verify-z4-mutations.mjs`（三项变异均被捕获）。

## 0j. 方向 6 第四轮复核整改（Q1–Q3）：凭据契约统一

第四轮复核把剩余问题收敛到凭据链。本轮改为统一契约（不再逐个特例补丁）：
**允许渠道 → 选实际生效来源 → 一次解析并冻结 → 身份与发送同源**。

- **Q1 显式来源也要冻结**：冻结粒度从「ref 字典」改为**逐渠道的实际生效来源**
  `{kind:'explicit'|'ref'|'none'}`；显式 Key/Cookie 优先冻结其值，引用只解析真正生效的那一个。
  provider（`resolveApiKey` / MiMo Cookie / 自定义条目）一律先看冻结值。
- **Q2 不能破坏正常回退**：区分「未冻结（未采样）→ 走原解析」「`none` → 确认无凭据」
  「`explicit`/`ref` → 用冻结值」；引用候选遇空值/哨兵**继续下一个**。
- **Q3 允许集合前置**：`identifyChannels` 在读任何字段/凭据之前先按「已启用 ∩ 已知 ∩ 请求」过滤，
  停用渠道零解析，但仍返回 `disabled` 状态。

证据：`tools/test-usage-recheck-q1q3.mjs`（30 项）；`tools/verify-q-mutations.mjs` 四项变异
分别让 Q1d / Q2a / Q2b / Q3a 失败。

## 0k. 方向 6 第五轮复核整改（F1–F2）

第五轮复核确认 Q2/Q3 通过，剩余缺口都在冻结协议的**逐层传递**与**状态服从**上：

- **F1.1 中间层丢快照**：注册层原本只转发 `snapshot.frozen`，把 `snapshot.custom` 丢掉。
  新增 `mergeFrozenSnapshot()`，把两部分合并成一张逐 id 冻结表再下发。
- **F1.2 provider 不看冻结值**：自定义渠道原实现先用当前 `entry.key`，纯显式条目不读冻结。
  现在冻结协议**前移到选择已保存凭据之前**：`explicit`/`ref` 只用冻结值、`none` 直接缺凭据、
  未采样才走原路径；冻结值同样要过 `credentialHost`/origin 校验，**不绕过目标确认**。
- **F2 MiMo 把 none 当未采样**：有冻结描述即严格遵守其状态（none 零请求、
  explicit 只用其字段、其它状态安全拒绝），只有 `null` 才读 cfg。

证据：`tools/test-usage-recheck-f1f2.mjs`（32 项）；`tools/verify-f-mutations.mjs`
五项变异（丢弃 custom 表 / 忽略 explicit / 忽略 none / MiMo 把 none 当未采样 /
MiMo 显式缺字段回退 cfg）全部被分别捕获。

测试质量：Q1a 改为显式 gate 握手并断言真的进入采样等待；V3c 的 1ms 墙钟断言改为
确定性断言（不放宽产品预算、不删安全断言），连跑 5 次稳定。

## 0l. 真机安装冒烟（2026-10-19）与 K 组回归

首次真机安装后 `usage_status` **静默消失**（GUI 胶囊与 `/api/plan-usage` 均正常）。

- **根因**：`OUTPUT_SCHEMA` 使用 `type: ['number','null']` 等 **type 数组**；
  宿主的 `assertSupportedJsonSchema` 只接受单一 `type` 字符串，
  `tools.register(def)` 抛 `JsonSchemaError`，被 `registerUsageTool` 的 `catch`
  吞成 `registered:false` —— 只有工具消失，其它一切照常。
- **定位**：从 `app.asar` 抽出宿主真实校验器，对 schema 实跑，
  得到 `output.schema: FAIL -> … type arrays are not supported`。
  离线回归发现不了，是因为假 tools 服务不校验 schema，且「缺服务静默跳过」被当作优雅降级。
- **修复**：`nullable(type) = { oneOf: [{type}, {type:'null'}] }`，替换全部 10 处；
  `policy` 用 `oneOf: [object, null]`。
- **新守卫**：`tools/test-usage-tool-contract-host.mjs`（9 项）+
  `tools/host-json-schema.mjs`（宿主校验器本地副本）。K1b 禁止 type 数组，
  K2b 断言工具确实被注册；把 `nullable` 改回 type 数组可精确复现故障。

修复后真机冒烟通过：模型成功调用 `usage_status`，返回值与 GUI 一致
（DeepSeek 18.03 CNY、Codex 31%/54%、WorkBuddy 6017 积分、WorkBuddy AI 349 积分、
MiMo 为 `api` 语义错误）。这也补上了此前长期标注为「未验证」的真实宿主 `tools` 注册与模型调用。

## R1 — 预算必须覆盖排队、凭据、DNS、连接与 body

**缺陷**：`timeoutMs` 只在 `requestJson` 内生效；`credentials.resolve` 与
`verifyPublicTarget` 都在它之前直接 await。DNS 或凭据服务挂起时 20 s 预算无效，
Host 的 `Promise.all` 不返回 → 客户端 40 s 整体失败 → 其他渠道一起灰化。

**修复**（[plans/custom-balance.js](../plans/custom-balance.js)）：

- 新增 `createBudget(totalMs, deadlineAt)`：贯穿全流程的**绝对 deadline**，提供
  `remaining()` / `expired` / `race(promise)`；过期后 `race` 立即返回 `{ok:false,reason:'timeout'}`，
  后续阶段检查 `budget.expired` 后**直接返回，不再发请求**。
- `fetchCustomBalance` 的每个前置阶段都走 `budget.race`：凭据解析、`resolveValidatedAddresses`；
  连接前再查一次 `budget.expired`（迟到依赖不得发请求）。
- 单条子预算 = `min(自身超时, 整批剩余)` 且继承整批 `deadlineAt`（不放大）。
- `fetchCustomPlans` 整批共享一个 `createBudget(budgetMs)`，worker 取子预算；
  另加一层 `Promise.race(全部 worker, 到点+5ms)` 兜底，未填的位置统一转结构化暂时失败。

**复现→通过**：

- `R1a/b/c` DNS 慢 80 ms、预算 15 ms：不返回余额、总耗时 < 200 ms、`transient:true`。
- `R1d/e` `credentials.resolve` 永久挂起：整批按预算返回结构化失败。
- `R1f/g` 迟到 DNS 结果：transport 调用数 **0**，且不回填余额。
- `R1h` body 读取挂起：受超时约束（`readLimitedBody` 在 `requestJson` 的 race 内）。

## R2 — 模型凭据引用换 Key 必须换代次

**缺陷**：`gen` 只纳入 `customKeys` 里**显式保存**的 Key。引用名不变、背后的 Key 从 A 换 B 时，
两次 wire 的 gen 相同 → B 返回 500 时客户端把 A 的余额当成 B 的「上次成功值」灰化保留。

**修复**：

- 新增 `credentialFingerprint(key)`：`sha256('dsh-usage-dock:credential\0' + key)` 前 12 位；
  空 Key 固定为 `none`（与任何真实 Key 的指纹都不同）。不可逆、不含明文、不进 message/日志。
- 新增 `generationOf(fields, keyFingerprint)`：代次在**拿到实际要发送的 Key 之后**才定稿，
  因此「引用轮换 / 引用清空 / 解析失败」都会换 gen。
- `configGeneration(fields)` 保留为兼容包装（内部改用 `generationOf` + 显式 Key 指纹）。
- 失败与无凭据路径用 `generationOf(entry, 'none')`：代次与任何成功态都不同，
  客户端据此放弃旧余额而不是沿用。

**复现→通过**：`R2a` 同一引用解析出 A→B，两次 gen 不同；`R2b` gen 不含明文；
`R2c/d` 引用清空 → 代次变 + `no-key`；`R2e` 解析抛错 → `no-key` + 代次失效；
`R2f–i` 指纹稳定性/区分性/不含明文/空 Key 专有标记。

## R3 — 配置变化必须即时作废旧值与在途响应

**缺陷**：客户端只比较「本轮 wire 的 gen」与「上轮 wire 的 gen」。配置保存改变 URL/币种/停用/删除时，
**在途的旧请求**仍带着旧 gen 回来，被当作「第一次见到的 gen」接受 → 旧值照样显示。

**修复**（[client.js](../client.js)）：

- 新增模块级配置代次 `configEpoch` + `subscribeConfigEpoch` / `bumpConfigEpoch`
  （设置页保存成功后自增，覆盖「只改 Key、配置字段没变」——Key 被宿主剥掉，客户端看不到）。
- 新增 `customConfigSignature(config)`：只取影响取数的字段（不含名称），
  配置一变摘要就变。
- 胶囊轮询 effect 的依赖改为 `[enabled, customSignature, configEpoch]`：任一变化即重跑 →
  cleanup `abort()` 在途请求 → 新闭包里 `lastList`/`failStreaks`/`customGens` 全空，
  旧值、失败计数与「见过的 gen」一起作废。
- 显示层改为按**当前已保存配置**过滤（`customConfigIndex`）：已删除/停用的条目立刻不画，
  哪怕旧 wire / 旧 carry 还带着它。无 `configForm` 时退回以 Host 的 wire 为准。

**复现→通过**：`R3-Aa/Ab` 配置删空但**不发新请求** → 旧值立刻消失；
`R3-Ba/b/c` 请求挂起期间改 URL(a→b)+币种(USD→CNY)，放行迟到旧响应 →
不回填旧余额、不回填旧币种。两条都跑真实 form 快照与真实 `Badge`，不是手工改 wire.gen。

## R4 — 整体失败 8 次后，删除/停用条目不得残留

**缺陷**：第 8 次整体失败构造纯错误行时丢掉了 `custom`/`gen`，于是 `isCustomPlan` 认不出它，
删除该记录后仍走普通 carry 永久残留成 `custom:review123456 获取失败`。

**修复**：

- 纯错误行**保留身份**：`custom:true` + `gen`（剥掉 `balance`/窗口数据，只留 id/name/error/message）。
- 新增 `looksCustomId(id)` / `isCustomLike(plan)`：按 `custom:` 前缀兜底认出「丢了标记的历史错误行」。
- carry 循环改为按**已保存配置**判定：id 不在 `customIndex`（或 `enabled:false`）→ 丢弃并清
  `failStreaks`/`customGens`，不再依赖 `old.custom` 是否存在。
- Host 侧：停用条目仍回 `{enabled:false, custom:true, gen}`，且**零请求**；失败 wire 仍带
  `custom`/`gen`（`R4a–d`）。

**复现→通过**：`R4a` 8 轮整体失败后显示「获取失败」；`R4b/c/c2` 删除后不再以名称/id 出现、
不再残留旧余额；`R4d/d2` 后续成功响应不复活；`R4f` 停用后立刻不显示。

> 说明：配置删空后已无任何可显示渠道，胶囊退化为整体的「获取失败」是**合法聚合态**，
> 不是残留。测试因此断言「该条自己不再出现」，而不是「页面上没有获取失败字样」。

## R5 — 显式已保存 Key 也必须执行目标绑定

**缺陷**：改 URL 会清 `credentialHost`/`urlHostConfirmed`，但 Host **只在用引用时**检查目标，
显式已保存的 Key 直接发到新 URL。

**修复**：

- 新增 `originOf(target)` / `normalizeClientOrigin(field)`：目标统一规范化为
  `scheme://host[:port]`（小写、去末尾点、省略默认 443、IPv6 加方括号），
  Host 与 UI 用**同一个字符串**比较。
- Host：只要「这次要用一把已保存的凭据」（显式 Key **或**引用），就必须
  `credentialHost === originOf(target)`；否则**零请求**返回 `credential-unconfirmed`（语义错误）。
- 客户端：确认按钮写入/展示的都是规范化 origin；只要有凭据会发出去就显示确认条
  （`willSendCredential`）。
- UX 分层：**本轮新输入**的 Key 在保存时自动把当前 origin 记为已确认（新建条目的显式输入）；
  **已保存**的 Key 在 URL 变更后不自动续期，必须手动确认。

**复现→通过**：`R5a` 已保存 Key + 未确认 → transport 调用数 **0**；`R5b` 返回可操作的
「凭据目标未确认」；`R5c` 不灰化；`R5d` 确认后放行（大小写/默认端口规范化）；
`R5e` 主机变化后旧确认失效（零请求）；`R5-Aa/b/c` UI 提示；`R5-Ad` 改 URL 保存后确认字段为空
（不自动续期）；`R5-Ba/b` 新录入 Key 自动绑定 `https://a.example` 且同批写 Key。

## R6 — 校验必须先于任何写操作；元数据与 secret 合并为一次 mutate

**缺陷**：`jobs.push(api.set(...))` 是**立即发起**的写入，而「没有 mutate 就取消保存」的检查
在它之后 → 提示「已取消保存」时元数据其实已经落盘。

**修复**（[client.js](../client.js) `save()` 重写为三段式）：

1. **校验阶段**（零副作用）：自定义字段逐条校验 + 判断是否需要写 secret + 检查
   `typeof api.mutate` 能力；任一不合格直接返回，**此时没有任何写入**。
2. **提交阶段**：有 `mutate` 时把「公开字段 ops + secret 路径 ops」放进**同一次**
   `api.mutate(ops)`；`accepted === false` 或 reject 都按「整批未生效」处理。
   没有 `mutate` 且确实要写 Key → 直接拒绝（绝不退回整体 `set` 抹掉别条 Key）；
   不需要写 Key 时才退回逐个 `api.set`（第一个 set 同步发起，保持既有交互）。
3. **如实报告**：一次 mutate 失败 → 「没有写入任何改动」；只能逐个 set 时若部分成功 →
   「保存未完全成功：部分设置可能已经写入」。两种情况都**保留草稿**。

**复现→通过**：`R6-Aa` 无 mutate 时 `writes.length === 0`；`R6-Ab` 提示「没有保存任何改动」；
`R6-Ac` 已保存配置未变；`R6-Ad` 草稿仍在；`R6-Ba/b/c` 只调一次 mutate，同一批里既有
`customBalances` 也有 `customKeys.<id>`，且不再用 set 单独写自定义字段；
`R6-Ca/b` 返回 false → 明说未写入 + 草稿保留；`R6-Da` 抛错同款。

> 关于 revision：`mutate(ops)` 由宿主 `ConfigFormController` 负责修订号校验，本项目不额外
> 传 revision、也不缓存 revision；因此这里只依赖宿主返回的 boolean/reject 判定「是否生效」。

## R7 — 无 configEditor 时统一解包 volatile 配置

**缺陷**：只在读**开关**时解包，传给各 plan 的仍是解析后的 Config。无 `configEditor` 的部署里
`deepseekApiKey` 是 `{get()}` 包装对象，`resolveApiKey` 的字符串判断失败 → 用户填了 Key 却报 no-key。
这是 0.9.0 之前就存在的兼容性缺口，不是本版引入。

**修复**：

- `plans/custom-balance.js` 新增 `unpackConfig(config)`：一次性解包**所有**顶层字段
  （数组元素也逐字段解包），`unwrapVolatile` 增加 `try/catch`（包装的 getter 抛错时返回 undefined）。
  未知字段原样保留（旧 glm/kimi 键因此不丢）。
- [index.js](../index.js) 路由内改为 `const cfgNow = unpackConfig(await liveConfig())`，
  provider、自定义条目、开关判断全部只看这个普通对象；`cfgValue` 保留为薄包装。
- `/api/plan-usage/custom-status` 同样先解包再读自定义条目。

**复现→通过**（`tools/test-config-unwrap.mjs`，用**真实** schemastery `Config`）：

- `U1a` 先证明「原始解析结果确实是包装对象」（缺陷前提成立），`U1b–g` 解包后 Key/Cookie/阈值/
  数组/customKeys/旧字段全部为普通值，`U1h` 幂等，`U1i–k` `unwrapVolatile` 边界。
- `U2a` 真实 `Config` → `apply()` → 路由：DeepSeek **真的发起了请求**；
  `U2b` `Authorization: Bearer sk-synthetic-deepseek`（用户填的那把）；`U2c` 返回真实余额。
- `U3a` 自定义阈值 42 被读出（不是默认 10）；`U4a`/`U5a` 渠道/全局开关真的生效；
  `U6a–c` 自定义条目在真实 Config 下返回结构化结果；`U7a/b` 两个响应都不含真实 Key。

## 安全 — 连接目标必须绑定到已核验 IP

**缺陷**：先独立 `lookup` 并缓存 60 s，真正 `fetch` 另做一次解析；检查与 connect 之间仍有
DNS 重绑定窗口。审查明确指出不能以「best-effort」当作满足设计。

**修复**：

- 新增 `resolveValidatedAddresses(host, resolveHost)`：返回**全部**已核验公网地址
  （`{address, family}`）；任一是私网/环回/链路本地/云元数据即整体拒绝（不做「挑公网那个连」）。
- 新增 `makeLookup(addresses)`：只返回构造时那份地址的 `lookup` 实现，忽略调用方传入的 hostname，
  支持 `{all:true}`/`{family}`，没有可用地址时返回 `ENOTFOUND`（**不回退解析**）。
- `requestJson` 在有 `target.addresses` 时把默认传输换成 `node:https`（`pinnedHttpsTransport`），
  把 `lookup` 钉死在已核验地址上：
  - `servername` 保持**真实域名** → TLS SNI 与证书校验按域名进行；
  - `agent:false` 不复用连接；不跟随重定向（3xx 作为状态码返回）；
  - `rejectUnauthorized` 从不为 false；只接受测试/受控宿主传入的 `tlsCa`（额外信任，不关校验）。
  - 拿不到 `node:https` 时返回 `{detail:'unbound'}`，由调用方**保守拒绝**并给出明确文案，
    绝不静默降级、绝不把凭据发到未核验目标。
- `verifyPublicTarget` 保留为预检（快速失败、零请求），但注释明确它**不是**安全边界。

**可见性**：注入的传输层（测试/受控宿主）同样能拿到 `init.lookup` / `init.servername`，
便于断言与自行遵守。

**复现→通过**：`安全a/b` 全公网通过、混合私网整体拒绝；`安全c/d/e` lookup 只回已核验地址、
`all:true` 用同一份列表、忽略调用方 hostname；`安全f` 云元数据被拒；`安全g/h/i` 传输层收到
lookup/servername；`安全j/k` 用自签证书证明**连接真的打到已核验 IP**（出现
`SELF_SIGNED_CERT_IN_CHAIN` 而不是 `ECONNREFUSED`），且证书错误被单独归类为 `tls`；
`安全l` 用额外信任该自签 CA 的方式完成一次**真实 TLS 往返**并完整读出响应体（校验未关闭）。

## 保留的既有行为

三渠道退场（不显示/不取数，旧配置与模型凭据保留）、自定义设置与 secret 托管、
动态胶囊/详情、灰化保旧值、阈值 8、语义错误立即提示、配置代次隔离、
WorkBuddy 前缀优先分类、rail/footer/通知层级/安卓降级——对应回归全部通过（见下）。

## 测试结果

**33 组 1328 项通过、0 失败、0 跳过**（另 `workbuddy-contract` 7 项通过）：

口径：33 个 Node 组 = **1133 项**，+ line-endings 51 + peak-marker 144 = **1328 项**；
再 + WorkBuddy 契约 7 = **1335 项**。这是检查/断言数，不是端到端场景数。

| 组 | 项数 | 组 | 项数 |
| --- | --- | --- | --- |
| custom-balance | 52 | fetch-backends | 13 |
| custom-balance-fetch | 49 | degrade-refresh | 43 |
| custom-settings | 50 | workbuddy | 27 |
| custom-render | 63 | android-compat | 14 |
| custom-security | 37 | settings | 6 |
| custom-race | 39 | peak-phase | 32 |
| host-custom | 31 | mimo-parse | 21 |
| config-unwrap | 22 | footer-row | 12 |
| review-fixes | 40 | collapsed-pill | 4 |
| recheck-fixes（第二轮） | 25 | panel-interactions | 12 |
| recheck-round3（第三轮） | 29 | peak-marker | 144（几何断言） |
| recheck-round4（第四轮） | 33 | line-endings | 51 |
| **usage-tool（D6/T1）** | **108** | **usage-tool-register（T2）** | **70** |
| **usage-tool-host（T2 真实 apply）** | **41** | **usage-policy（T3）** | **85** |
| **usage-integration（D6-C 真实 provider）** | **31** | **recheck-y1y4（二次复核）** | **41** |
| **recheck-z1z3（三轮复核）** | **25** | **mixed-currency-ui（Z4）** | **5** |

方向 6 七组共 **401 项**（108 + 70 + 41 + 85 + 31 + 41 + 25）。
`test-line-endings` 与 `test-peak-marker` 需完全权限（git 子进程 / 写 `legacy/` 并启动 Chrome），
受限沙箱下会被拒绝——是环境限制，不是代码缺陷。

> 采集方式：批量回归改用「输出重定向到文件再取尾行」。用管道同时捕获 27 个进程的 stdout 时，
> 出现过程序退出期的 `UV_HANDLE_CLOSING` 断言崩溃；改文件重定向后稳定通过，
> 单测独立运行也始终通过——属采集层管道竞争，非产品缺陷。

## 打包

旧包 `87a566…`（首轮）、`e4fc46…`（第二轮）、`AAE306…`（第三轮）、`E4861F38…`（第四轮前）、
`E41967…`（第五轮前）、`F03328…`（方向 6 首版，含 D6-A～H 问题）、`D9C681…`（D6 整改版）、`8DFEEB…`（Y1–Y4 整改版）、`91E3596E…`（Z1–Z3 整改版）、`41A6B229…`（Z1–Z4 整改版）、`E56F9DE0…`（Q1–Q3 整改版，custom/MiMo 冻结未贯通）都**不得**作为整改后产物。
本轮（D6 整改）后已重新打包。

## 第十三版打包（K 组 schema 修复后）

| 项 | 值 |
| --- | --- |
| 产物 | `legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz` |
| 大小 | 158 999 字节 |
| 文件数 | 23 |
| SHA-256 | `5A9DE1201544161B7677363002FF2611EAC377AD8D0FC697B66EA759EEC8BED6` |
| SHA-1 | `76DFF9E79DFBEFB29145662616778E2C29E948D0` |

解包核对：23 个 payload 齐全，`index.js` / `client.js` `node --check` 通过，
`PLANS` 为 6 个活动渠道，`percentSemanticsOf('codex')='remaining'`、
`percentSemanticsOf('opencode-go')='used'`，策略字段 5 个；
**23 个 payload 与工作区对应文件 SHA-256 逐一相同**（mismatch=0）。

## 仍未验证 / 已知风险

- **未在真实 DSH 宿主里跑过**：未部署、未重启。`mutate` 路径写入、`role('secret')` 剥除、
  修订号约定都是按宿主源码核对 + 等价桩验证，真机仍需用户试装确认。
- **未在 Android/DSHA 真机验证**（只有无 shell / 无 configEditor 的模拟回归）。
- **OpenRouter 类响应与 Key 权限未核验**（本机网络策略拒绝抓取），不声称厂商兼容。
- **`node:https` 的可用性**：若某移植运行时拿不到 `node:https`，自定义余额会以 `unbound`
  保守拒绝（这是刻意行为，不是缺陷），需在真机上确认该运行时具备它。
- 自定义渠道仍无低余额阈值、不参与内置排序。
- 方向 6（`usage_status` 工具）**未实施**，本轮按用户要求只整改。
