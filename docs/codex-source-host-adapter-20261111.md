# Codex 双来源 Host 适配（2026-11-11，实施交付 · 未部署）

范围：**Host 半的 Codex 选源适配**（`plans/codex.js` / `plans/codex-sources.js` /
`plans/custom-balance.js` 摘要 / `index.js` 身份与只读路由）+ 定向测试。
**未**写 `client.js`（UI 由独立 High 负责；**终审整改轮**按 §11 只改了客户端的两处：
B1 摘要组件位置与 N1 归一）、**未**改 `usage-tool-register.js`、
**未**改 MiMo / DeepSeek / WorkBuddy / 自定义余额取数逻辑、**未**改 package 版本/依赖/profile 配置。
**未部署、未重启、未发布、未安装或调用第三方只读服务**；未读真实 cfg / credential / 浏览器 / 网络 / env / log。

用户口径（主已定）：现用 **dsh-codex-subscription v3.2.6**，仍**保留**旧 **dsh-codex-connect** 适配；
设置页**自动列两个来源**、**未安装与未开启都叫「未启用」**、**用户选一个显示、不合并不 fallback**；
统一后台额度适配（侧栏/详情、`usage_status`、额度策略同一流程）。

---

## 1. 配置

| 项 | 值 |
| --- | --- |
| Config 字段 | `codexSource`：字符串，**缺省 `'connect'`** |
| 允许值 | `'connect'` \| `'subscription'`（**没有 `auto`**，不做后台自动选择/自动迁移） |
| 归一规则 | 缺失 / 未知 / 非字符串 → `connect`（唯一实现在 `normalizeCodexSource()`） |
| 渠道映射 | `plans/codex.js` 的 `fields = { enabled: 'codexEnabled', source: 'codexSource' }` |
| schema 形态 | `z.string().default('connect')`（**不是** `z.union([z.const(..)])`：手改 YAML 写错值不会让整份配置校验失败；闭集由归一函数保证） |

`plan.source` 不再固定绑定 Connect：改为 `{ providers: ['dsh-codex-connect','dsh-codex-subscription'], oauth: true }`
（纯描述；`index.js` 对 codex 走账号型分支，不读它）。真正按源的是 **wire 的 `codexSource` 字段**。

## 2. wire（GUI / `usage_status` 同一份归一）

每个 codex wire（含错误 wire）都带 `codexSource: 'connect'|'subscription'`，字段形状两家**完全一致**：

| 字段 | 语义 |
| --- | --- |
| `rollingUsage` / `weeklyUsage` / `monthlyUsage` | 按 `windowSeconds` 精确匹配 **5h(18000) / 7d(604800) / 30d(2592000)**；缺哪个窗口就是 `null`（**不伪造**） |
| `window.percent` | 剩余百分比 0..100（两位内部四舍五入到 0.1）；**`0` 是有效值**（额度用尽），绝不 fallback |
| `window.resetsAt` | ISO 字符串或 `null`。两家上游都是 **Unix 秒**（Connect `resetAt`、Subscription `resetsAt`），只在转 ISO 时 ×1000；溢出/非法给 `null` |
| `window.resetInSec` | 恒 `null`（不由 Host 推算） |
| `creditsUnlimited` / `creditsBalance` | 布尔 / 严格十进制字符串（Connect 原精确字符串保留；Subscription 的 `balance` 同为字符串，**不**造精确金额） |
| `individualLimit` | `{ limit, used, remaining, remainingPercent }`；`remaining` 仅 Connect 有（精确字符串），**Subscription 恒 `null`**（它没有该字段，不凭浮点百分比反推金额）；`remainingPercent` 0..100 或 `null` |
| `fetchedAt` | **仅 Subscription**：透传 service 内部那次读取的 `usage.fetchedAt`（毫秒）＝原采样时间，不是本轮假新鲜；缺失则不写 |

**只取主 Codex 桶**：`rateLimits[].id === 'codex'`。`additional_rate_limits` / `code_review` 等附加桶
**不合并、不冒主额度**（测试 G2c：附加桶 99% 不得顶替主桶 0%）。`chatPass` / `resetCredits` 不作为主余额，
不与任何字段相加。

## 3. 错误码（闭集，文案固定，绝不回显上游原文）

| error | 含义 | 界面语义 | transient |
| --- | --- | --- | --- |
| `not-enabled` | 未安装 / 未开启（**统一一种说法**） | 「未启用」 | 否 |
| `incompatible` | 服务/模块合同不匹配（需要适配） | 「接口不兼容/需要适配」 | 否 |
| `source-changed` | 读取期间来源/账号变化（revision、换服务、卸载） | 本次作废 | 是 |
| `signed-out` | 第三方固定文案「未登录」 | 去登录 | 否 |
| `reauth-required` | 第三方固定文案「需重新授权」 | 去重新登录 | 否 |
| `not-installed` | Connect 模块 import 失败（Cannot find package/module） | 未安装 | 否 |
| `quota-unavailable` | 已登录但没有任何可显示窗口/credits | 无额度数据 | 否 |
| `exec` | 其它失败（含 `E_CODEX_USAGE_ABORTED` / `E_CODEX_USAGE_FAILED` / `E_CODEX_USAGE_NOT_READY`；`value` 形状非法也走这里） | 获取失败 | 视码而定（ABORTED/NOT_READY 是，FAILED 否） |

映射规则（`plans/codex-sources.js#subscriptionFailureOf`）：
- 服务固定顶层码（**真实返回的字符串**，闭集 5 个，只做 `hasOwnProperty` 精确等值；
  不做前缀剥离的模糊匹配，也不保留第二套短名）：

  | service `code` | wire `error` | transient | 备注 |
  | --- | --- | --- | --- |
  | `E_CODEX_USAGE_BAD_REQUEST` | `incompatible` | 否 | 参数被拒 → 需适配 |
  | `E_CODEX_USAGE_ABORTED` | `exec` | **是** | 已取消 |
  | `E_CODEX_SOURCE_CHANGED` | `source-changed` | **是** | 来源/账号变化、已卸载 |
  | `E_CODEX_USAGE_FAILED` | `exec` | 否 | 委托失败 |
  | `E_CODEX_USAGE_NOT_READY` | `exec` | **是** | 服务尚未就绪 |

- 原 handler 形状 `{ok:false,error:{code:'internal',message}}`：**只做精确等值**匹配
  `'ChatGPT subscription is not signed in'` / `'ChatGPT sign-in needs to be renewed'`；
  其它任何 message（含可能带上游正文的、相似但不相同的）→ generic `exec`，`details` 一律丢弃；
- 查表用 `hasOwnProperty`，`code:'constructor'` / `'toString'` 之类**不会**命中（测试 G7b）；
  无前缀旧写法（`BAD_REQUEST` 等）与带空格的码**也不命中**（落到 generic，测试 G7f2–G7f4）。

## 4. 只读状态接口（给设置页两行来源）

```
GET /api/plan-usage/codex-sources        （其它方法 → 405）
200 { ok:true, data:{
      sources:[ { id:'connect',      label:'Codex Connect',      enabled:bool, compatible:bool },
                { id:'subscription', label:'Codex Subscription', enabled:bool, compatible:bool } ],
      selected:'connect'|'subscription' } }
```

- **闭集**：`data` 只有 `sources` / `selected`；每条**只有** `id/label/enabled/compatible`。
  不返回 runtime entries、不返回配置、不返回账号/路径/令牌、不返回额度。
- **两行恒在**，顺序固定（connect 在前）。
- **零 I/O**：不 import 第三方包、不读 record、不发请求、不写缓存。
- 判定：
  - `connect`：`ctx.get('openaiCodexTransport')` 非空 ⇒ `enabled:true, compatible:true`。
    服务对象没有额度方法（只有 images），它只是**启用闸门**；真正额度函数缺失时取数层报 `incompatible`。
  - `subscription`：服务合同齐全（`apiVersion===1` + `readUsage` + `getRevision()` 返回非负安全整数）
    ⇒ `true/true`；服务在但合同不符 ⇒ `true/false`；服务不在但 loader 条目显示
    目标插件**已激活**（`entry.disabled === false` 且 `entry.fiber.state === 2`）
    ⇒ `true/false`（**已激活但没装只读接口补丁 → 「接口暂不可用/需要适配」，不冒充「未启用」**）；
    其余（未安装 / 已停用 / 无法证明安装）⇒ `false/false`（统一「未启用」）。
  - 条目名**只做等值匹配**：`options.name` / `options.moduleNamespace` = `dsh-codex-subscription`，
    或 `fiber.runtime.name` = `codex-subscription`（Connect 同理：`dsh-codex-connect` / `llm-openai-codex`）。
    不读 `options.config` / `_initTask` / inertia / 私有反射；不做 substring 匹配（防未知插件冒名）。
  - **状态无法证明**（`ctx.get` 抛错）⇒ `200 { ok:false, error:'status', message:'无法确认 Codex 来源状态' }`，
    **不**发布一份假的 `enabled:false`（那会把「不知道」说成「未启用」）。
- `selected` 取自 Host 最近一次读到的配置（与主 GUI 路由同一 2 秒缓存）。
  **UI 应以自己已保存的配置为准**，本字段用于兜底/校正。

## 5. 配置摘要（双端必须逐字同构）

`plans/custom-balance.js#configDigestOf`：**仅**当规范化来源是 `subscription` 时，
在 `parts` 的**第一个位置**追加一个组件：

```
parts.push('builtin:codex-source' + '\u0002' + 'subscription')
```

`connect` / 缺失 / 未知值**不追加**任何组件 ⇒ **缺省 connect 的摘要与旧版逐字一致**
（既有 custom 摘要 fixture 不受影响）。随后照旧追加自定义条目（`entryPublicIdentity + '\u0002' + keyRev`）
与 orphan 修订，最后 `digest16(parts.join('\u0003'))`。

客户端 `configDigestOfClient` 需镜像：同位置、同分隔符、同 join。收益：切源 ⇒ `proof.digest` 变 ⇒
客户端作废旧值；`generationOfCfg`（`index.js`）也随之变化 ⇒ 工具缓存代次不同源不互用。

## 6. 观察身份（Host 内部，绝不外泄）

`index.js#identityOfChannel` 的 codex 分支新增两项：

```
csrc=connect|subscription
crt=c<0|1|?>/s<0 | 实例序号@revision | 实例序号@x | ?>
```

- `c`：Connect 传输服务在(1)/不在(0)/不可判断(?)；`s`：subscription 只读服务不存在(0)/可用(`N@R`)/
  在但不兼容(`N@x`)/不可判断(?)；`N` 是本进程 `WeakMap` 分配的实例序号，**不含账号 ID**。
- 效果：切源、来源停用（服务消失）、服务被替换（重装/热重载）、订阅账号切换（revision 前进）
  都会让身份变化 ⇒ epoch 推进 ⇒ 旧在途结果被 `publishObservation` 拒收、旧投影被撤销，
  提示词/策略不会再拿上一来源的采样说话。
- 取数层自身还有**读前/读后**双检（同 `ctx.get` 对象 + revision 不变），任一不满足即
  `source-changed` 且**不带任何 value**（测试 G6a–G6d）。

## 7. 取数路径

- `connect`（保旧）：先 `ctx.get('openaiCodexTransport')` 作 guard → 通过后才
  `import('dsh-codex-connect')` → 校验 `readOpenAICodexRateLimits` / `OpenAICodexCredentialStore` →
  `readOpenAICodexRateLimits(new OpenAICodexCredentialStore())`。**不**调用 `store.read`、
  **不**解析凭据文件；OAuth 全由该 SDK 自己处理。
  （未启用时**零 import、零 store 构造**——修掉了旧实现「未启用也会读文件」的风险。）
- `subscription`：只 `ctx.get('codexSubscriptionUsage')` → `readUsage({ signal })`。
  调用 payload **只有 `signal`**（无 `force`、无 URL、无账号）；授权/TTL/缓存/账号绑定全在 service 内部。
  失败按 §3 映射；不 fallback 到 Connect。
- 两条路径共用一个归一函数 `normalizeCodexUsage()`（导出，可直接单测）。
- 测试注入点：`createCodexPlan({ importConnectModule })` **仅供测试替身**；
  生产默认实例永远走真实 `import('dsh-codex-connect')`，不接受任何外部 URL/handler 参数。

## 8. 定向测试（`tools/test-codex-sources.mjs`，**88 项全通过**：整改后 78 → 88）

全离线、全 fake（fake ctx / fake service / fake SDK 模块），不联网、不起服务、不读真实数据：

| 组 | 覆盖 |
| --- | --- |
| G1 | 旧 Connect 归一保持：5h/周窗、`resetAt` 秒→ISO、缺月窗不伪造、credits 精确字符串、individual 精确 remaining、只构造一次 store/读一次、缺主桶 ⇒ quota-unavailable |
| G2 | Subscription 主桶归一：`0%` 有效、附加桶不冒主桶、三窗各自 seconds、`resetsAt` 只 ×1000 一次、无 resetsAt ⇒ null、unlimited 不造余额、无 remaining ⇒ null 但保留 percent、`fetchedAt` 透传、非法百分比/时长全舍弃 |
| G3 | 启用 guard 在 import/read 之前（Connect 未启用零 import；Subscription 未启用零 readUsage；选 subscription 不碰 Connect 通道） |
| G4 | 状态：两行恒在、未装＝未启用、已激活未打补丁＝`true/false`、停用＝`false/false`、fiber 非 ACTIVE、等值匹配反冒名、`runtime.name` 精确命中、getter 抛错⇒`unknown`、apiVersion≠1 / revision 非法⇒不兼容 |
| G5 | 选源隔离：选 subscription 不可用 ⇒ 报错且零 fallback；选 connect 不碰 subscription；读取失败也不 fallback |
| G6 | 在途：revision 前进（含 ABA）、服务被替换、服务消失 ⇒ `source-changed` 无 value；变化优先于失败码；运行时身份摘要的稳定性/区分度/形态 |
| G7 | 失败面：任意 message/`details` 不外泄（哨兵）、原型链键名不命中、固定登录/续期文案命中、相似文案不命中、**真实顶层码逐个命中映射**（5 个）+ 端到端带出 `transient`、无前缀旧写法/带空格码不命中、wire 无账号/令牌字段 |
| G8 | 摘要：缺省/显式 connect/未知值 与旧算法**逐字一致**（独立复刻旧算法对照）、subscription 追加固定组件且值不同、volatile 包装同样生效、归一闭集 |
| G9 | **真实 `apply()`**：路由注册、状态闭集形状/405、`selected` 跟随配置、GUI 与 `usage_status` **逐窗口同值**、切源后立即按新来源取数（`not-enabled` 无 fallback）、proof 变化、**旧 subscription 观察不再提供窗口能力**（`stale-identity`/空）、`selected` 随之更新 |
| G10 | 调用形态：`readUsage` 只收一个 `{signal}` 参数、无 force/accounts/URL、上游 signal 原样透传 |
| **G11** | **成功分支的 `value` 形状**（N3）：`undefined/null/字符串/数字/数组` ⇒ `exec` **非 transient**、固定文案，且不伪造任何窗口/百分比/credits；合法对象仍正常归一（守卫未误杀） |
| **G12** | **作废行保留来源**（N2）：真实 `apply()` 下让读取期间 `getRevision()` 前进 ⇒ 该条被改写成 `cancelled`，且**带 `codexSource:'subscription'`**、不伪造数字 |

代表例回归（一次跑，不叠矩阵）：`test-host-custom` 31、`test-usage-tool-host` 41、
`test-usage-tool-register` 70、`test-recheck-round4` 33、`test-config-unwrap` 22、
`test-quota-windows-endpoint` 26、`test-custom-round3` 20、`test-custom-balance` 52、
`test-usage-integration` 31、`test-usage-tool` 108、`test-quota-policy-settings` 95、
`test-line-endings` 75 —— **全部 exit 0、0 失败**。

## 9. 未做 / 边界（不得据此宣称可用）

1. **未部署、未重启、未发布**；工作区源码 ≠ 已装运行时代码。
2. **未安装、未调用**第三方只读 service（High82 的本地最小补丁候选仍在修 final，本实现按合同对接，
   不需要 pin 其最终 hash）。因此 **Subscription 路径的实机行为完全未验证**。
3. `plans/**` 侧不改 UI 文案；`client.js` 的整改（B1 摘要位置、N1 归一）见 §11，其余 UI 语义
   （设置页两行来源、文案、`codexSource` 保存/剪枝）仍归 UI 那一路。
4. `loader.entries` 读不到时（宿主没有 `loader` 服务或形态未知），subscription 会落回
   `enabled:false`（「未启用」）。这是**已知的保守降级**：此时无法区分「未安装」与
   「已激活未打补丁」。**请主确认是否可接受**；若不可接受，需要主给出可用的公开 entries 访问方式。
5. `connect.compatible` 只表示「公开传输服务在」；若已装版本没有额度函数，取数层会报 `incompatible`
   （状态接口不会提前 import 去验证 —— 状态接口保持零 I/O）。
6. 未改 `usage-tool.js` 投影：工具输出**不带** `codexSource`（保持白名单字段不变；需要的话另开）。
7. 未做强开全局路由信任（`quotaTrustRouteOrder` 闸门与策略静默逻辑原样保留）。

## 10. 需要主/UI 对齐的三点

1. **来源显示名**：状态接口给 `label = 'Codex Connect'` / `'Codex Subscription'`；UI 若要中文
   或用包名，请改自己那侧文案（不用改接口）。
2. **`selected` 的权威**：Host 侧取最近一次读到的配置（≤2 秒缓存）。UI 应以自己已保存的
   `codexSource` 为准；`selected` 仅作兜底。
3. **§9.4 的 entries 降级**是否接受。

---

## 11. 终审整改（2026-11-11）

> 依据 [独立终审](codex-source-review-20261111.md)（该文件**原文保留、未改动**）。
> 本轮只动 5 处：B1 / B2 两个阻断，N1 / N2 / N3 三个观察项。仍**未部署、未重启、未联网**，
> 未读真实 cfg / 凭据 / 记录 / 浏览器 / env / log，未跑真实 `apply()` 以外的任何生产路径。

### B1（阻断）摘要组件双端位置不一致

- **根因**：Host `configDigestOf()` 在 `parts` 建好后**先** push codex 来源组件、**再**进入自定义
  条目循环、最后 push orphan；客户端 `configDigestOfClient()` 是「条目 → orphan → **最后**才
  push 来源组件」。同一份配置两端 `parts.join('\u0003')` 顺序不同 ⇒ `dshDigest16` 不同 ⇒
  客户端 `responseMatchesCurrentConfig` 永远 false ⇒ `settleStaleOnly()` 生效：
  自定义条目全不显示、内置渠道只剩上次基线（首屏为空），且 Host/客户端每轮各按自己的顺序算，
  **永不自愈**。只有「无自定义条目 + 无 orphan」时两端恰好同值，所以既有用例全绿。
- **修法**（只改客户端，Host 与 G8 旧算法对照保持基线）：把两行 `codexSourceDigestPart()` 计算
  从 orphan 循环之后**上移**到 `var parts = []` 之后、条目循环之前；
  `codexSourceDigestPart()` 本身的字串（`builtin:codex-source` + `\u0002` + `subscription`）**一字未改**。
- **新增测试**：`tools/test-codex-source-ui.mjs` 的 **V 组**——直接 `import` Host
  `configDigestOf()`（缺 `@deepseek-ai/schemastery` 时 `V0` **显式失败**，不跳过），
  对 6 个配置断言 `configDigestOfClient(cfg) === configDigestOf(cfg)`（无自定义×缺省 / 无自定义×subscription /
  **有自定义×subscription** / 有自定义+orphan×subscription / 有自定义×connect / 非规范写法）。
  修复前 V3/V4/V6 失败（`bb3d3731…` ≠ `2491204…`），修复后全过。
  工作区版与 stage 版各跑一次，**79/79**。

### B2（阻断）第三方错误码映射键错位

- **根因**：`SERVICE_CODE_ERRORS` 的键写成无前缀短名（`BAD_REQUEST` 等），而只读 service 真实返回
  `E_CODEX_USAGE_BAD_REQUEST` / `E_CODEX_USAGE_ABORTED` / `E_CODEX_SOURCE_CHANGED` /
  `E_CODEX_USAGE_FAILED` / `E_CODEX_USAGE_NOT_READY`（见候选 `fail(...)` 调用）。查表是
  `hasOwnProperty` 精确等值 ⇒ 5 个真实码**一个都命中不了**，全部落到 generic `exec` **非 transient**：
  账号切换期间的 `E_CODEX_SOURCE_CHANGED` 被当硬失败立即上屏并计失败轮数，
  `E_CODEX_USAGE_BAD_REQUEST` 也不再表达「需适配」。旧 G7 用例喂的正是无前缀短名，把问题掩盖了。
- **修法**：5 个键改成**真实码字符串**（不做前缀剥离的模糊匹配，精确码表是唯一真相）；
  `error`/`transient`/`message` 语义不变（BAD_REQUEST→incompatible 非 transient、ABORTED→exec transient、
  SOURCE_CHANGED→source-changed transient、FAILED→exec 非 transient、NOT_READY→exec transient）；
  模块头注释与 §3 表格的码名同步更新。
- **测试**：G7 改为喂真实码（5 个全覆盖，断言各自 `error`+`transient`），新增
  **负向**用例 G7f2–G7f4（无前缀 `BAD_REQUEST`、`ABORTED`、带尾空格的码**必须不命中**，落到 generic），
  以及 G7f5（真实码端到端带出 `wire.error='source-changed'` + `transient:true`）。
  把键临时改回旧短名后 G7f/G7f2/G7f3/G7f5 **4 项失败**，改回真实码后 **88/88 全过**。

### N1（观察项）客户端来源规范化与 Host 不等价 —— 已修

客户端 `normalizeCodexSource()` 改为逐字镜像 Host（`typeof === 'string' ? trim().toLowerCase() : ''`），
ES5 写法不变。测试：V6（跨端摘要）、N1a（与 Host `normalizeCodexSource` **逐值同结果**）、
N1b/N1c（正反例）、N1d（`' Subscription '` 与非规范写法摘要相同）。

### N2（观察项）revoked 行丢来源身份 —— 已修

`index.js` 的 `guiObservationWire()` 里 `revoked` 对象现在**仅当源 wire 上确实带合法来源时**
补 `codexSource`（从 `wire.codexSource` 读，落在 `connect|subscription` 闭集内才写，
再用 Host 既有 `normalizeCodexSource()` 归一；不写 `undefined`，也不给其它渠道凭空造字段）。
同类遗漏一并补：两处 `execError(plan)` 兜底（GUI 路由与 `usage_status` collect）经
`withConfiguredCodexSource()` 只对 codex 补配置里的来源，其它渠道原样。
测试：G12（真实 `apply()`，读取期间 revision 前进触发作废行，断言 `codexSource==='subscription'`）
+ 客户端 RV 组（作废行带来源时仍渲染；缺来源时被当成另一来源而隐藏 —— 证明该字段是这行的生杀开关）。
修复前 G12c 失败。

### N3（观察项）subscription 成功分支未校验 `value` 形状 —— 已修

`plans/codex.js` 在 `{ok:true}` 之后先校验 `value` 必须是**非 null 的非数组对象**，否则按
`exec`（非 transient，固定文案「Codex 额度获取失败」）处理，**不伪造**任何窗口/百分比/credits。
修复前 `null`/`undefined` 会抛 `TypeError`（
`Cannot read properties of null (reading 'fetchedAt')`），字符串/数字/数组则被读成
`quota-unavailable`（「没有额度」）。测试：G11a（5 种非法值）+ G11b（合法对象仍成功，守卫未误杀）；
修复前 G11a 失败。

---

### 本轮回归（只跑必要项，不叠矩阵）

| 套件 | 结果 |
| --- | --- |
| `tools/test-codex-sources.mjs` | **88/88**，exit 0 |
| `tools/test-codex-source-ui.mjs`（工作区版） | **79/79**，exit 0 |
| `tools/test-codex-source-ui.mjs`（**stage 字节**） | **79/79**，exit 0 |
| `tools/test-recheck-round4.mjs`（双端摘要规范化守卫） | **33/33**，exit 0 |
| `.diagnostics/codex-subscription-readonly-service-20261111/test-readonly-service.mjs` | **9/9**，exit 0（第三方候选未被牵连） |
| `node --check client.js / index.js / plans/codex-sources.js / plans/codex.js` | exit 0 |

已存在的失败（**未修、未掩盖**，与本轮无关）：`test-degrade-refresh` 的 T9/T10、
`test-custom-settings` 的 C2c、`test-mimo-auth-client` 的 4 项 —— 本轮未运行也未改动它们。

**stage 候选**：`client.js` 改动后重新生成 `client.ws-new.js` → `round.diff`（15 hunk）→
`build-stage.mjs`（installed 85906C30… + 15 hunk，**不含** WorkBuddy dirty）。
`staged/client.js` SHA256 `45932EB7…`（501806 字节）、`finalclient-hunks.json` SHA256 `F8787F68…`；
`git diff --no-index -U0 staged/client.js client.ws-new.js` 仍只有 WorkBuddy dirty
（11 hunk / 52+/90-，`codex` 在该 diff 中出现 **0** 次）。

**仍未做**：未部署、未重启、未发布；未在真实 Host/profile 上验证；未接真实订阅 service；
真实 `codexSource` 落盘与真实 `/api/plan-usage/codex-sources` 均**未验证**。
