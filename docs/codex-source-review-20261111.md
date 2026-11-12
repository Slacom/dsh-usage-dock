# Codex 双来源交付 · 独立终审（Max，2026-11-11）

> 范围：本轮三份**未部署**交付（Host 适配 / 客户端 UI / 第三方只读 service 补丁候选）。
> 方式：**纯静态阅读**（源码 + 本地离线交付物）。未部署、未重启、未联网、未读真实配置/凭据/记录/env/log、
> 未跑真实 `apply()`、未运行任何测试套件（判断均可由阅读确定，无需运行）。
> 明确排除：`client.js` 里既有 WorkBuddy dirty、`plans/workbuddy.js`（10-25 另一条未部署线）。

---

## 1. 一句话结论

**Fail（阻断 2 条）**：B1 摘要片段双端位置不一致（选 subscription 且存在自定义条目时证明永远对不上，整盘数据不显示）；
B2 第三方只读 service 的 5 个顶层错误码未被 Host 映射表覆盖（全部落到 generic `exec`）。修掉这两条并补对应用例后可再终审。

---

## 2. 阻断项

| 编号 | 文件与行 | 问题 | 为什么阻断 | 最小修法建议 |
| --- | --- | --- | --- | --- |
| **B1** | Host：[custom-balance.js:1751‑1754](plans/custom-balance.js#L1751-L1754)（`parts` 空时**先** push `builtin:codex-source\u0002subscription`，随后才 push 自定义条目 1756‑1762、orphan 1764‑1767）<br>客户端：[client.js:674‑696](client.js#L674-L696)（先 push 自定义条目 676‑682、orphan 683‑690，**最后**才 push codex 片段 694‑695）<br>待装副本同缺陷：[staged/client.js:674‑696](.diagnostics/codex-source-ui-20261111/staged/client.js#L674-L696) | 同一份配置（`codexSource='subscription'` 且存在任一自定义条目或 orphan 修订）两端 `parts.join('\u0003')` 的**顺序不同** ⇒ `digest16` 不同 ⇒ 客户端 `responseMatchesCurrentConfig` 永远为 false | 摘要证明是「这份 wire 属于当前配置」的唯一凭据。不匹配时 `applyResult` 走 `settleStaleOnly()`：自定义条目全不显示，内置渠道只留上一次基线（首次加载为空）——表现为**整盘无数据/一直「配置生效中」且永不恢复**（Host 每轮都按同一顺序算，客户端每轮都按另一顺序算）。触发条件：选 subscription 且 `customBalances` 有 ≥1 条合法条目，或 `customKeyRev` 有 ≥1 个 orphan（删过自定义渠道）。connect / 无自定义条目时两端恰好同值，故现有测试全绿 | 把客户端改成与 Host **同位置**：在 `configDigestOfClient` 开头（自定义循环之前）按同一条件 `if (part !== '') parts.push(part)`，即从 694‑695 上移到 674‑675；工作区与 `staged/client.js` 两处都要改。修完补一条**跨端向量**用例：同一 `{customBalances:[…], customKeyRev:{…}, codexSource:'subscription'}` 在 Host `configDigestOf` 与客户端 `codexSource.digest` 上必须相等（现有 G8d 只验 Host 自己的期望、D2 只用空 `customBalances`，故都没抓到） |
| **B2** | Host：[codex-sources.js:396‑422](plans/codex-sources.js#L396-L422) 映射表键为 `BAD_REQUEST` / `ABORTED` / `SOURCE_CHANGED` / `FAILED` / `NOT_READY`；查表在 [codex-sources.js:461‑463](plans/codex-sources.js#L461-L463)<br>真实服务：[candidate/index.js:3551‑3580](.diagnostics/codex-subscription-readonly-service-20261111/candidate/index.js#L3551-L3580) 返回的是 **`E_CODEX_USAGE_BAD_REQUEST` / `E_CODEX_USAGE_ABORTED` / `E_CODEX_SOURCE_CHANGED` / `E_CODEX_USAGE_FAILED`**（闭集见 [SHORT.md:78‑85](.diagnostics/codex-subscription-readonly-service-20261111/SHORT.md#L78-L85)） | 键名不带 `E_CODEX_` 前缀，`ownLookup` 用 `hasOwnProperty` 精确查 ⇒ **5 个真实码一个都命中不了**，全部落到 `GENERIC_SUBSCRIPTION_ERROR` | 契约要求 `BAD_REQUEST→incompatible`、`ABORTED/NOT_READY→exec(transient)`、`SOURCE_CHANGED→source-changed(transient)`、`FAILED→exec`。实际全部变成 `exec` + **非 transient**：账号切换/插件处置期间的 `E_CODEX_SOURCE_CHANGED` 被当成**硬失败**立即上屏并计入失败轮数（本应「本次作废、暂时」），`BAD_REQUEST` 不再表达「需适配」。映射表等于死代码，双端错误语汇对不上 | 把 5 个键改成真实码（或查表前 `code.replace(/^E_CODEX_(?:USAGE_)?/, '')` 归一，兼容两种写法）；同步改 [host-adapter 文档 §3:59‑61](docs/codex-source-host-adapter-20261111.md#L59-L61) 与 G7 用例（[test-codex-sources.mjs:458‑462](tools/test-codex-sources.mjs#L458-L462) 现在喂的是无前缀码，正好把错误掩盖了） |

---

## 3. 非阻断观察

| 编号 | 内容 | 建议 |
| --- | --- | --- |
| N1 | **来源归一两端不等价**：Host [codex-sources.js:96‑99](plans/codex-sources.js#L96-L99) 是 `trim().toLowerCase()`；客户端 [client.js:181‑183](client.js#L181-L183) 是 `raw === 'subscription'` 严格等值。配置里写成 `" Subscription "` 时 Host 用 subscription、客户端算作 connect ⇒ 既触发 B1 同款摘要不一致，又让真实 subscription wire 被渲染层过滤（该行消失）。UI 只会写规范值，需手改 YAML 才触发 | 与 B1 同批改：客户端改成 `String(raw).trim().toLowerCase() === 'subscription'`（三行内，一处） |
| N2 | `codexSource` 并非「每个 codex wire 都有」：`execError(plan)`（[util.js:437‑439](plans/util.js#L437-L439)）与 `guiObservationWire` 的 `revoked` 分支（[index.js:774‑783](index.js#L774-L783)）都不带来源字段。选 subscription 时这类 wire 被当 connect ⇒ 行直接消失，而不是显示「本来源失败」 | 两处按 `codexSourceOf(cfgNow)` 补字段；或客户端对「已选订阅但 wire 无来源」按未知来源显示错误行（不显示数字） |
| N3 | Subscription 成功分支未防 `value` 非对象：`usageWire(...)` 后直接读 `usage.fetchedAt`（[codex.js:288‑296](plans/codex.js#L288-L296)）。若 service 违反合同返回 `{ok:true}` 无 `value`，这里抛 `TypeError` → 外层 `.catch` → `execError` → 又落回 N2 | 加一行 `usage !== null && typeof usage === 'object'` 守卫 |
| N4 | 安装前检查项（两条，均与「口径」有关，不构成本轮阻断）：① `ctx.provide("codexSubscriptionUsage")` 同名已存在时会抛（cordis `reflect.provide` 明确 `service "X" has been registered at <fiber>`），异常会让**整个** codex-subscription 插件 `apply` 失败并连带影响模型访问；工作区内无同名 provider（只有本交付自己的引用），但需在安装前确认一次 profile。② `entryIsActivePlugin` 要求 `entry.disabled === false`（[codex-sources.js:253](plans/codex-sources.js#L253)）；若目标 DSH 的 loader 对「未停用」给的是 `undefined`，「已激活但未打补丁」就永远落到「未启用」（等于把 §9.4 降级变成常态） | 安装验证清单加这两条；②若确认是 `undefined`，判据放宽为 `disabled !== true` |
| N5 | `plans/codex-sources.js` 的 `SERVICE_CODE_ERRORS.BAD_REQUEST` 文案「接口版本不匹配」把「参数被拒」说成版本问题（B2 修好后才可见） | B2 一并把文案改成「只读接口拒绝了本次请求」 |
| N6 | 工作区 `client.js:1614‑1621` 重复声明 `var lastList / failStreaks / customGens / timer`（与 1567‑1571 重复；`var` 语义下无害）。**installed 基线同样存在**，属既有代码 | 不在本轮范围，仅记录；将来清理时勿与 WorkBuddy dirty 混改 |

---

## 4. 契约核对清单（1–8）

| # | 契约 | 结论 |
| --- | --- | --- |
| 1 | 摘要字串双端逐字同构（同位置/同分隔符/同 join；仅 subscription 追加；connect 保旧） | **有偏差** → **B1**（位置不同）；另 **N1**（归一口径不同）。分隔符 `\u0002`、join `\u0003`、`dshDigest16` 算法、connect 不追加（旧摘要逐字一致）均已核 |
| 2 | wire 与 UI 解析一致 | **基本已核**：`codexSource` 在两条取数路径的所有分支（成功/未启用/不兼容/quota-unavailable/source-changed/服务失败）都在 [codex.js:199‑213](plans/codex.js#L199-L213)；`percent: 0` 有效（Host 只看类型与范围；客户端 [client.js:2207](client.js#L2207)、[2519](client.js#L2519) 用 `typeof === 'number'`）；`resetsAt` 只 ×1000 一次（Subscription DTO 经 [candidate:13989‑14003](.diagnostics/codex-subscription-readonly-service-20261111/candidate/index.js#L13989-L14003)、[14018‑14022](.diagnostics/codex-subscription-readonly-service-20261111/candidate/index.js#L14018-L14022) 确认是**秒**；客户端只用 `Date.parse(ISO)`）；`remaining` 仅 Connect、Subscription 恒 `null`（其 DTO 无该字段，且 `safeAmount` 只收字符串）。**唯一偏差**：N2/N3 的两条边缘 wire 缺 `codexSource` |
| 3 | service 合同与 Host 消费一致 | **有偏差** → **B2**（码表键名）。其余已核：两种失败形状结构上都接受（顶层 `code` 优先、`error.message` 精确等值、`details` 一律丢弃）；`readUsage` 只传 `{ signal }`（[codex.js:273](plans/codex.js#L273)）；`ctx.get` 同对象 + revision 读前读后各一次，任一变化 ⇒ `source-changed` 且**不带 value**（[codex.js:278‑282](plans/codex.js#L278-L282)）；`getRevision()` 语义要求（同步、非负安全整数）在 [codex-sources.js:178‑189](plans/codex-sources.js#L178-L189) |
| 4 | 来源隔离 | **已核**：所选来源失败零 fallback（`fetchPlan` 只按 `codexSource` 分派）；未启用零 import/零 store（guard 在 `importConnectModule()` 之前，[codex.js:216‑230](plans/codex.js#L216-L230)）；渲染层再兜一道（[client.js:2038](client.js#L2038)）；失败阈值后的纯错误行保留 `codexSource`（[client.js:1826](client.js#L1826)）；切来源只作废该条（prune [client.js:1600‑1609](client.js#L1600-L1609)），其它渠道基线与计数不动。Host 侧身份变化会 `channelMeta.delete` ⇒ 旧来源的 `effectiveStatus`/`failCount` 不会串到新来源（[index.js:930‑938](index.js#L930-L938)） |
| 5 | 只读路由零 I/O 且闭集 | **已核**：[index.js:1289‑1341](index.js#L1289-L1341) 只回 `{sources:[{id,label,enabled,compatible}], selected}`；两行恒在、connect 在前（[codex-sources.js:371‑388](plans/codex-sources.js#L371-L388)）；非 GET ⇒ 405；`ctx.get` 抛错 ⇒ `{ok:false,error:'status'}`（不发布假 `enabled:false`）；不 import 第三方、不读记录、不发请求；客户端 `parseCodexSourcesPayload` 白名单式解析且丢弃 Host 的 `label`（用自有文案） |
| 6 | 无密外泄 | **已核**：Host 只回 `id/label/enabled/compatible/selected`；错误文案全部固定闭集，`message`/`details` 从不透传（[codex-sources.js:459‑469](plans/codex-sources.js#L459-L469)）；查表用 `hasOwnProperty`（`constructor`/`toString` 不命中）；`connectFailureOf` 只做 `includes` 判断后返回固定文案；观察身份只含来源枚举 + 实例序号 + revision（无账号 ID/路径/令牌） |
| 7 | 第三方补丁侵入面 | **已核**：`git diff --no-index --numstat` = **105 增 / 0 删**，四处纯插入，import/export 列表逐字未变；`onAccountChanged` 原有 6 条清理保序（`subagentCatalog/connectorsClient/usageProfileReader/voicePreview/composerPredictions/quotaRetryHandler`），仅在**起始**插入 `usageBridgeRevision += 1`；`base`/`candidate` SHA256 与 SHORT 记录一致；候选内无任何 `ownerPeer`/`createPeer`。`ctx.provide` 同名会抛 = **安装前检查项（N4①）**，静态看无同名 provider，不构成本轮阻断 |
| 8 | A 方案残留 | **已核**：`plans/codex.js`、`plans/codex-sources.js`、`plans/custom-balance.js`、`index.js`、`client.js`、候选补丁内均无 `createPeer` / `principal: {kind:'owner'}` / `createSharedFetchHandler`；仅 [codex-sources.js:20](plans/codex-sources.js#L20) 有一句「不构造 ownerPeer」的说明性注释 |

---

## 5. 主代理两个口径的静态判断

**① §9.4 降级（`loader.entries` 读不到 ⇒ subscription 行退为「未启用」）——可接受，但有两点残余。**

- 它不会导致**错误结论被当成事实**去驱动取数：该降级只作用于「状态接口的两行文案」，不改变取数分派、不影响 wire、不影响 `usage_status`/策略；也无法把「没数据」说成「有数据」或反向。
- 真正会出现的失真只有一类：把「已安装且已激活、但没打只读补丁」说成「未启用」（无法区分未安装/未开启/已激活未打补丁）。这是**文案分类失真**，不是越权、不是换来源、不是错误额度。
- 残余 ①：`entryIsActivePlugin` 要求 `entry.disabled === false`（严格等值）。若目标 DSH loader 对启用中的条目给的是 `undefined`，则「已激活未打补丁」**永远**不会显示「需要适配」，降级从「例外」变成「常态」，与用户「只有未安装/未开启才叫未启用」的口径有偏差。静态无法判定（不能读 profile），列为安装验证项。
- 残余 ②：`readLoaderEntries` 只接受数组 / `Map` / 可迭代；若 DSH 的 `entries()` 返回普通对象或形态变化，一律 `known:false` → 同一降级。属同一条可接受边界的更宽版本。
- 结论：**不阻断**。建议安装后在真机确认一次「subscription 已装但未打补丁」的实际显示；若显示成「未启用」，按 N4② 放宽判据。

**② `selected` 以客户端已保存配置为准、Host 只兜底 —— 无隐蔽风险。**

- 客户端 `parseCodexSourcesPayload` 解析出 `selected` 后，`setCodexSources` **并未保存它**（[client.js:8262](client.js#L8262) 只存 `state/sources/loaded`），渲染用的 `sourceSaved/sourceDraft` 全部来自 `config` 与草稿 ⇒ 事实上「客户端 100% 以自己为准」，Host 的 `selected` 只存在于接口里。
- 唯一需要注意的是它与 **N1** 的组合：客户端对保存值的归一比 Host 严格，手改 YAML 写非规范值时，两边对「已保存来源」的判断会分叉（Host 用 subscription、客户端算 connect）。这条已单列 N1，修法相同。

---

## 6. 未验证 / 不可据此声称

1. **本次交付不可进入部署**（Fail）。B1 修完（工作区 + `staged/client.js` 两处）与 B2 修完、并补一条跨端摘要向量用例后，可再终审。
2. 全部结论来自**静态阅读**，**未运行任何测试**（交付声明的 78 项 / 62 项 / 9 组均未复跑，也未叠加矩阵）。
3. **实机行为一律未验证**：未安装、未部署、未重启、未在真实 Host `apply()`、未接真实 `ctx.provide`、未真实调用 `usage`、未联网、未读真实 profile 配置/凭据/记录/env/log。
4. 未验证真实 DSH 的 `loader.entries()` 形态与 `entry.disabled` 语义、`ctx.provide` 在目标 profile 是否有同名冲突（N4）。
5. 未验证 subscription 真实 usage DTO；本文所有字段结论来自 `candidate/index.js` 的 `parseCodexUsage` 静态代码。
6. 未验证 `client.js` 与已装基线之间除本轮 14 个 hunk 之外的差异是否为 0（`staged-vs-wsnew.diff` 内无 codex 内容、`client.ws-new.js` 与工作区 `client.js` 哈希一致，仅此而已）。
7. 不构成对 B1/B2 之外任何「跨端已对齐」的背书：本文只核对了指定 8 条契约，其余既有链（W1–W3、X1–X2、MiMo、WorkBuddy）沿用此前结论。

---

## 第二轮：窄复核（2026-11-11）

**结论：Pass（可进入部署计划；仍不代表实机可用）。** 阻断项 B1、B2 均闭合，N1/N2/N3 已修，未发现新增阻断。方式同前：纯静态阅读，未跑任何测试、未部署、未读 profile。

| 复核项 | 判定 | 依据（静态） |
| --- | --- | --- |
| A. B1 闭合 | 已闭合 | [client.js:679‑710](client.js#L679-L710) 的 push 顺序现为「codex 组件 → 条目 → orphan」，与 [custom-balance.js:1747‑1769](plans/custom-balance.js#L1747-L1769) 严格同序；orphan 段两端等价（Host 排序 id、客户端排序已格式化串，两者对 `[A-Za-z0-9_-]` 字符集等价）；`clientKeyRev` 与 `keyRevOf` 同规则。新增 V 组（[test-codex-source-ui.mjs:529‑594](tools/test-codex-source-ui.mjs#L529-L594)）真 import Host `configDigestOf` 对同一配置逐字比对，且 V3/V4 覆盖「自定义条目 + subscription」「+ orphan」——位置若错位该组必失败（V0 缺依赖则显式失败，不跳过），属有效守卫 |
| B. B2 闭合 | 已闭合 | [codex-sources.js:404‑430](plans/codex-sources.js#L404-L430) 五键与候选 `fail(...)` 字面量逐字一致（[candidate:3551‑3580](.diagnostics/codex-subscription-readonly-service-20261111/candidate/index.js#L3551-L3580)）；`ownLookup` 仍 `hasOwnProperty`（原型链键名不命中）；顶层 `code` 与 `error:{code,message}` 两种形状都覆盖、`details` 仍丢弃；`transient` 与首轮口径一致。G7 改喂真实码、G7f2–f4 负向、G7f5 端到端验到 wire（`source-changed`+`transient:true`+`codexSource`） |
| C. 新改动风险 | 已闭合 | `withConfiguredCodexSource`（[index.js:296‑300](index.js#L296-L300)）以 `wire.id !== 'codex'` 早退 ⇒ 不会给非 codex 渠道写来源；值取 `codexSourceOf()`（闭集、恒非 undefined），且只写新造的 `execError` 对象。[index.js:810‑813](index.js#L810-L813) 作废行只在源 wire 的 `codexSource` 落在闭集时补字段，其余原样。`plans/codex.js:296‑298` 的 value 守卫不会误杀：service 成功值恒为对象字面量（非 null/非数组）。客户端 `normalizeCodexSource`（[client.js:188‑191](client.js#L188-L191)）与 Host 逐字同式；`codexSourceFromWire` 缺字段仍回落 connect（[client.js:196‑200](client.js#L196-L200)），设置页 radio 的 saved/draft 均按同一归一比较，语义未变 |
| D. stage 完整性 | 已闭合 | `staged/client.js` = `45932EB7…DDF2`（与自述一致）；`installed → staged` 为 **15 hunk / 343+ / 16−**，逐 hunk 检查全部落在 codex 与「预设凭据展平」两处声明面内（无 MiMo/WorkBuddy/DeepSeek 内容）；`finalclient-hunks.json` = `F8787F68…FE93BE`，15 条 hunk 的 `old` 在 installed 中**各出现 1 次**、`new` 在 staged 中**各出现 1 次**（可移植性成立）；`staged → client.ws-new` 为 11 hunk / 52+ / 90−，正文**无任何 codex 内容**（仅 diff 头部路径提及），逐 hunk 均为 WorkBuddy 线 |

残余观察（不阻断，供将来）：

- R1 客户端 `configDigestOfClient` 的 `revs` 只判 `typeof === 'object'`，Host 显式排除数组（[custom-balance.js:1764](plans/custom-balance.js#L1764)）。数组型 `customKeyRev`（手改/YAML）会让 orphan 段分叉。**既有代码，非本轮引入**；将来加 `!Array.isArray(...)` 即两端同构。
- R2 映射表只认一套字面量、不做前缀剥离（G7f2–f4 已把这一点钉住）。若第三方补丁将来改用短码，Host 会静默落回 generic —— 安装时应锁定本轮审计的候选 SHA。
- R3 首轮 N4（`ctx.provide` 同名冲突、`entry.disabled === false` 严格判据）仍未验证，仍属**安装时验证项**，非代码缺陷。
