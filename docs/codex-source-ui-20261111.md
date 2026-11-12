# Codex 双来源选择 UI（客户端包）— 2026-11-11

> **这是「客户端半 + 定向测试 + 文档」的交付，不是安装、不是发布、不是实机验收。**
> 文中所有结论都来自**离线合成夹具**（fake form / fake wire / fake 路由，无 localhost 监听、
> 无真实 Host、无真实 profile 配置、无凭据、无 OAuth、无浏览器自动化）。
> 「测试通过」= 客户端逻辑在合成输入上自洽，**不等于**真机可用，也**不**代表后端已实现该端点。

范围（本轮唯一写者：客户端 Codex 相关配置/选择 UI/digest/渲染隔离 + 预设凭据展平布局）：

| 文件 | 角色 |
| --- | --- |
| `client.js` | 唯一的生产改动面（来源常量/规范化/摘要片段/身份映射/metadata 解析、设置页来源区、胶囊单来源隔离、预设凭据展平） |
| `tools/test-codex-source-ui.mjs` | 新增回归（79 项，见 §7；含终审整改新增的跨端摘要向量 V） |
| `tools/mock-react.mjs` | 只加一条 `codex-sources` 夹具 + `DEFAULT_CODEX_SOURCES` 导出（其它行为不变） |
| `tools/test-settings-layout-20261024.mjs` | 仅更正 L6a/L6b 两处**过时**断言（预设凭据已展平；MiMo 不再有第二份凭据区） |
| `docs/codex-source-ui-20261111.md` | 本文 |

**没碰**：`index.js`、`plans/**`（后端那一路独占）、MiMo 相关区域、WorkBuddy 已存在 dirty 内容、
真实配置/凭据/进程/网络/服务/部署脚本。

> **终审整改（2026-11-11 晚）**：本文件在 B1/N1 两处被改动（来源组件在 `parts` 的**位置**、
> 归一规则镜像 Host），并对 Host 侧 N2/N3 各有一行配合改动（`index.js` 作废行保留来源、
> `plans/codex.js` 校验 `value` 形状）—— 详见
> [host-adapter 文档 §11](codex-source-host-adapter-20261111.md)。

---

## 1. 行为契约（客户端侧）

**字段**：`codexSource: 'connect' | 'subscription'`，默认 `connect`（保旧）。
字段缺失 / 非法值 / 空串 → 一律按 `connect` 处理（老配置、老 Host、老 wire 全兼容）。
**没有 `auto`**：自动发现只决定「哪一行可选」，绝不自动改用户的选择。

**只取所选来源**：两来源**不合并**；所选来源失败时**不静默回退**到另一个来源。

**规范化**（`normalizeCodexSource`）：逐字镜像 Host ——
`typeof raw === 'string' ? raw.trim().toLowerCase() : ''`，等于 `'subscription'` 才算 subscription，
其余（含 `' Subscription '` / `'SUBSCRIPTION'` 之外的任意值、空串、非字符串）一律 `connect`。
（[终审 N1 整改] 之前只做 `raw === 'subscription'` 严格等值，手改 YAML 写成 `" Subscription "` 时
两端会分叉：Host 算 subscription、客户端算 connect。）

## 2. 跨端摘要字串（**必须与 Host 逐字一致**）

客户端 `configDigestOfClient()` 的 `parts` **顺序与 Host `configDigestOf()` 完全相同**：

1. （仅在 subscription 时）**第一个** part = 来源组件：

   ```text
   builtin:codex-source\u0002subscription
   ```

2. 每条自定义条目的公开身份 + 非密 `customKeyRev`（条目顺序敏感）；
3. 已删除条目的 orphan 修订号（排序后）。

- **位置是契约的一部分**：来源组件在**条目之前**（[终审 B1 整改] 之前它被追加在 orphan 之后，
  与 Host 顺序相反 ⇒ `parts.join('\u0003')` 不同 ⇒ 摘要永不相等 ⇒ 选 subscription 且存在
  自定义条目时整盘数据不显示且不会自愈）。
- `connect` / 字段缺失 / 非法值 → **不追加任何 part** ⇒ 摘要与旧版完全相同（旧证明继续有效）。
- 追加后仍走 `parts.join('\u0003')` → `dshDigest16()`（16 位十六进制）。

> ⚠️ 这段字串与位置由父代理与 Host 侧同步。**单方面改动（字串或位置）会让双端证明永远对不上**
> （表现：界面只剩「—」或一直「配置生效中」）。客户端侧的落点见
> `codexSourceDigestPart()`，测试 `D1b` 逐字守住字串。
>
> **跨端向量用例（`V1`–`V7`，`tools/test-codex-source-ui.mjs`）**：直接 `import` Host 的
> `configDigestOf()`（依赖 `@deepseek-ai/schemastery`，仓库 `node_modules` 已有；缺包时 `V0`
> **显式失败而不是跳过**），对同一批配置两端各算一次并断言**逐字相等**：
> ① 无自定义条目 + 缺省来源；② 无自定义条目 + subscription；③ 有自定义条目 + subscription
> （B1 的主用例，修复前 `bb3d3731…` ≠ `2491204…`）；④ 有自定义条目 + orphan 修订 + subscription；
> ⑤ 有自定义条目 + connect（保旧）；⑥ 非规范写法 `' Subscription '`（N1+B1 组合）。
> `V7` 另证 subscription 与 connect 摘要确实不同（组件确实参与）。

## 3. 只读元数据端点（后端合同，客户端已按此实现）

```text
GET /api/plan-usage/codex-sources
→ { ok: true, data: { sources: [ { id: 'connect'|'subscription',
                                   label: 'Codex Connect'|'Codex Subscription',
                                   enabled: boolean, compatible: boolean } ],
                      selected: 'connect'|'subscription' } }
```

- 纯 metadata：**不读额度、不读凭据、不打任何上游**（打开设置页/局部刷新的成本为 0 上游）。
- 客户端只用它决定**哪一行可点**，不用它改选择、不用它取数。
- 解析是白名单式的（`parseCodexSourcesPayload`）：信封不合法 / `sources` 不是数组 →
  `state:'error'`；`enabled`/`compatible` 不是显式布尔 → 该行 `unknown`。
  **绝不上屏任何上游文本或错误正文。**

## 4. 来源行三态（设置页）

| metadata | 行状态 | 文案 | 可点 |
| --- | --- | --- | --- |
| `enabled:false`（无论未安装还是未开启） | `not-enabled` | **未启用** | ✗ |
| `enabled:true` + `compatible:false` | `incompatible` | **接口暂不可用（需适配）** | ✗ |
| `enabled:true` + `compatible:true` | `ready` | 可用 | ✓ |
| 取不到 / 未知 | `unknown` | **状态暂不可用** | ✗ |

- 两行来源**始终列出**（不会因为某行未启用就把 Connect 或 Subscription 藏掉）。
- 停用行 radio `disabled`，但**已保存来源仍保持勾选**；不静默迁移到另一行。
- 未知一律显示「状态暂不可用」，**不假称未启用**。

## 5. 设置页交互

- 点来源 = 只改**草稿** `codexSource`（不写后台、不发请求）；必须走统一「保存更改」才落盘
  （`mutate([{ op:'set', path:['codexSource'], value }])`），其它配置字段原样不动。
- 「放弃更改」回到已保存值。
- 保存中/只读：所有输入（含来源 radio）一律 `disabled`（与既有整页语义一致）。
- 登录说明**跟随 saved/draft 来源**：Connect 来源讲 Codex Connect 登录，Subscription 来源讲
  Codex Subscription 登录；同一张卡片只渲染**一段**说明（不再固定讲 Connect）。
- 无 token/Key 输入：来源选择**不需要**填凭据（Codex 仍由对应插件持有登录态）。

## 6. 胶囊数据隔离（切来源的关键）

1. **摘要进依赖**：`expectedDigest = configDigestOfClient(config)` 已是轮询 effect 依赖，
   subscription 追加 part 后，切来源 = 摘要变化 → 旧 effect cleanup **abort 在途请求**。
2. **内置 Codex 身份**（`builtin:codex\u0002<source>`）进入 `applied.entries`：
   effect 重建时只作废「身份真的变了」的那一条（`lastList` / `failStreaks`），
   其它渠道（DeepSeek / WorkBuddy / MiMo / 其它自定义）继续沿用基线与失败计数，**不整批清空**。
3. **wire 来源必须等于当前已保存来源**：`settle()` 里不同来源的响应直接丢弃（`seen` 已置位，
   carry 也不会把旧值顶回来）；渲染层再兜一道 `plan.id === 'codex' && fromWire(plan) !== saved` → 不画行。
   老 wire 缺 `codexSource` 视为 `connect`（因此「已选 subscription 却显示 Connect 数字」不可能发生；
   反方向则是「Connect 未带字段的旧响应」在订阅态被隐藏，符合「不静默回退」）。
4. **错误行保留来源**：连续失败到阈值后构造的纯错误行会带上 `codexSource`，
   否则它会被当成「另一来源的结果」而被过滤掉，用户看不到「本来源失败」。
5. 日常失败仍沿用该渠道原机制（`FAIL_THRESHOLD`/灰化）；**没有**为两个来源改全渠道间隔或阈值。
6. Host 2 秒配置缓存导致的「旧配置证明」→ 走既有 `responseMatchesCurrentConfig`：
   不显示旧批数据（placeholder/「配置生效中」），也不把它记成当前配置的 `applied`。
7. 胶囊/详情**保持一行一个 Codex 渠道**（用户明确：不合并 bucket、不额外多一行重复渠道）。
   来源只体现在设置页文案与取数身份上；胶囊里的 Codex 失败态文案仍是既有的「获取失败」，
   具体原因只在详情面板显示 Host 的固定文案（不把 error code / 上游正文放进胶囊 `title`）。

## 7. 测试（离线，合成）

```powershell
# 工作区版本
node tools/test-codex-source-ui.mjs

# 直接跑**要装的那份字节**（stage 候选）
$env:DSH_CLIENT_UNDER_TEST = ".diagnostics\codex-source-ui-20261111\staged\client.js"
node tools/test-codex-source-ui.mjs
$env:DSH_CLIENT_UNDER_TEST = $null
```

`test-codex-source-ui.mjs` = **79 项全过**（工作区版与 stage 版同值），分组：

| 组 | 覆盖 |
| --- | --- |
| S（16） | 两行始终列出；`ready`/`not-enabled`(未启用)/`incompatible`(需适配)/`unknown`(状态暂不可用)；停用行不可交互；**无 token/password 输入**；每卡只有一段登录说明 |
| R（16） | 点击只改草稿（无 mutate/set）；统一保存**只写 `codexSource`**、其它键零变化；放弃回原值；已保存的停用来源保持勾选、不迁移 |
| B（13） | 首屏只显示所选来源；切来源后旧来源值立刻消失；旧配置证明的迟到响应不回填；新来源证明匹配才显示；跨窗口改同样；所选来源未启用时**不回退**且 Codex 行仍显示失败态；其它渠道全程保留；0% 是有效值 |
| L（9） | 预设渠道 Key **无 details 祖先**、仍是 `password/autoComplete=off` 受控输入、容器为 `data-plan-credentials-flat="1"`；只读/保存中锁定；自定义卡折叠结构未动 |
| D（8） | 摘要片段逐字字串；connect 与老配置摘要相同；subscription 摘要不同；身份/解析纯函数 |
| **V（8）** | **跨端摘要向量**（§2）：V0 真 import Host `configDigestOf`/`normalizeCodexSource`（缺依赖**显式失败**）；V1–V6 六个配置双端摘要**逐字相等**；V7 subscription ≠ connect |
| **N1（4）** | 客户端归一与 Host **逐值同结果**（`' Subscription '` / `'SUBSCRIPTION'` ⇒ subscription；`'connect'`/`''`/`null`/`{x:1}` ⇒ connect）；`" Subscription "` 与非规范写法的摘要相同 |
| **RV（5）** | **作废（revoked/cancelled）行保留来源**：带 `codexSource` 时该行仍渲染（失败态、不伪造 0%）；缺 `codexSource` 时被当成另一来源而隐藏（证明 Host 必须补字段）；其它渠道全程不受牵连 |

**同时跑的既有代表套件**（工作区版与 stage 版结果**完全一致**）：

| 套件 | 结果 |
| --- | --- |
| `test-settings-layout-20261024.mjs` | 30/30 ✅（L6a/L6b 已按展平布局更正） |
| `test-quota-policy-settings.mjs` | 95/95 ✅ |
| `test-policy-block-layout.mjs` | 22/22 ✅ |
| `test-footer-row.mjs` / `test-panel-interactions.mjs` | 12/12、12/12 ✅ |
| `test-recheck-round4.mjs`（双端摘要规范化） | 33/33 ✅ |
| `test-workbuddy-client-credits.mjs` | 50/50 ✅ |
| `test-mixed-currency-ui.mjs` | 5/5 ✅ |
| `test-mimo-settings-client.mjs` | 80/80 ✅ |

**已存在的失败（与本次改动无关，installed 基线同样失败，逐条比对过）**：
`test-degrade-refresh.mjs` 5 项（T9/T10：MiMo 显示会话改造后的旧断言）、
`test-custom-settings.mjs` 1 项（C2c「自定义区在内置渠道之后」，与全局混排定稿冲突）、
`test-mimo-auth-client.mjs` 4 项（MiMo 登录面板改造后的旧断言）。
**这些不在本包范围**，未改、未掩盖。

## 8. Stage 候选（不是安装）

- 基线：已安装 `client.js` = `85906C30A3A0276377E3BE233FAE761AC5C3A6D96C9D05BD18F34EF3343A1DD8`
  （权威清单 `.diagnostics/mimo-settings-typography-20261111/INSTALLED-MANIFEST.json`）。
- 工件：`.diagnostics/codex-source-ui-20261111/staged/client.js`
  = **installed + 本轮 15 个 hunk**（终审整改后多出 N1 归一那一个 hunk），
  **不含** WorkBuddy dirty（5 处 WB 改动仍只留在工作区）。
  SHA256 `45932EB77C6BD37F99125D735DD418E9DDA9A9BD8125187A0F85CC3FEC3DBDF2`（501806 字节）。
- hunk 清单：`.diagnostics/codex-source-ui-20261111/finalclient-hunks.json`
  （每条 old/new 原文；每条 old 在 installed 中**恰好出现一次**，纯插入用「前 K 行 + 紧跟行」锚定）。
  SHA256 `F8787F680BED076E4476B45D82CA37CF60DD3D5C643D05467D874A96F8FE93BE`。
- 复现：`node .diagnostics/codex-source-ui-20261111/build-stage.mjs`
  （只读 installed 程序副本 + 本地改前/改后副本，不碰真实配置）。
- 校核：`git diff --no-index -U0 staged/client.js client.ws-new.js` 的差异**只有** WorkBuddy dirty
  （11 个 hunk / 52+/90-，与 installed↔WS 的 52+/90- 一致；diff 内 `codex` 出现 **0** 次）。

> 上一轮的 stage hash 见当时交付消息的「封存」一节；**本轮（终审整改后）**的
> `staged/client.js` 与 `finalclient-hunks.json` 的 SHA256 已就近写在上面的「工件」条目里
> —— 以 `.diagnostics/codex-source-ui-20261111/` 下的实际字节为准，不在文档里另存副本。

## 9. 与父/后端的同步点（需要时由父协调）

1. **摘要字串**：`builtin:codex-source\u0002subscription`，只在 subscription 追加（§2）。
2. **端点形状**：§3 的 payload；`enabled=false` 不区分「未安装/未开启」。
3. **Config schema**：`codexSource` 必须是 `volatile()` 字段，否则设置页读不到、保存也会被宿主拒绝。
4. **Host 侧错误语义**：所选来源未启用时该渠道 0 上游、返回可辨的失败条目；
   客户端胶囊只显示失败态（不复用另一来源数字），具体原因由详情面板显示 Host 文案。
5. 两行来源的 `label` 以客户端固定文案为准（`Codex Connect` / `Codex Subscription`），
   不采用后端任意文案（避免上游文本上屏）。

## 10. 明确未做 / 未验证

- 未安装、未部署、未重启、未发布；未生成部署脚本或安装计划（完整源码终审后由统一 Installer 处理）。
- 未在真机/真实 Host 上验证：真实 `codexSource` 落盘、真实 `/api/plan-usage/codex-sources`、
  真实订阅量取数、登录态判定，全部仍是**待后端与实机确认**的事项。
- 未改 WorkBuddy / MiMo 语义；未清理工作区里已存在的 WorkBuddy dirty。
