# 额度自动感知与分阶段收尾：构建记录（0.9.0）

> 依据：[构建执行交接](handoff-quota-policy-build-v0.9.0.md)。
> 本文记录**开工核验结果**与**实现进度**；未完成项如实标注。

## 1. 开工核验（2026-10-19）

### 1.1 基线与宿主契约

| 项 | 核验结果 |
| --- | --- |
| 版本 / HEAD | 0.9.0 本地构建；`71e71b4`，工作区未提交（75 项变更） |
| 现有失败阈值 | `client.js` `FAIL_THRESHOLD = 8` —— **本次改为 5** |
| 现有策略字段 | `quotaPolicyEnabled` / `quotaFocusChannels` / `quotaPercentThreshold` / `quotaBalanceThreshold` / `quotaBalanceCurrency` |
| 现有策略形态 | 常驻 `systemPrompt.section('dsh-usage-dock.policy')` + 工具结果 `policy` —— **本文要求改为动态 context 原子投放** |
| `section.text` | **同步**求值（`dsh-system-prompt` L388：`section.text(context)` 无 `await`） |
| `assemble()` | 每 step 一次（`dsh-agent-loop` L907） |
| 同 step 重试 | 走 `refreshContext()`（L1053）：**context 重新求值**，sections/tools/variables 保持已接受值 |

**结论**：交接文档 §7.7 的「固定模板 + 动态 context 原子组合」是唯一同时满足
「normal 零规则」与「同 step 重试可撤销」的方案；§7.6 的独立 section 方案在
重试时会残留旧规则，**不采用**。

### 1.2 当前模型供应商的读取入口（本轮新增核验）

宿主公开服务 **`agentDefaultModel`**：

```js
currentSelection()  // → { provider, model, reasoningEffort? }
```

- 配置字段 `provider` / `model` 都是 `.volatile()`，**会话内切换模型时值会变**；
- 因此可在每次 `context.text` 同步读取，实现「切换模型 → 评估渠道随之切换」；
- 读不到时不报错、不猜测，按「未绑定」处理（normal，零规则）。

### 1.3 本机实际 provider 清单 → 渠道映射

从 `cordis.patch.yml` 读到的真实 provider：`workbuddy`、`workbuddy-ai`、`openai-codex`、`packyapi`。

| provider | 对应渠道 | 说明 |
| --- | --- | --- |
| `workbuddy` | `workbuddy` | 积分类 |
| `workbuddy-ai` | `workbuddy-ai` | 积分类 |
| `openai-codex` | `codex` | 订阅额度类 |
| `deepseek` / `deepseek-account` / `deepseek-api-key` | `deepseek` | 余额类 |
| `packyapi` 等其它 | **无映射** | 按未绑定处理：normal、零规则，不拿无关渠道触发收尾 |

**关键**：用 WorkBuddy 渠道跑 DeepSeek 模型时，`provider` 是 `workbuddy`，
评估的是 **WorkBuddy 渠道**，不是 DeepSeek 官方渠道 —— 与本轮要求一致。

## 2. 已实现内容

### 2.1 新增模块

| 文件 | 职责 |
| --- | --- |
| `plans/quota-observer.js` | 观察容器（按渠道+身份隔离）、T/P/A/I/C/S 失败分类、连续 5 次阈值、`stageOf` 两档判定 |
| `plans/quota-route.js` | 路由观察器：在 `agent/request` 外层 `await next()` 后读真实 `{provider, model}`；按 Agent 用 WeakMap 隔离；`agent/created` 晚装 + `agents.list()` 补装 |
| `plans/quota-view.js` | 视图组装：开关 → 白名单 → 路由匹配 → 渠道快照 → 三阶段 |
| `plans/quota-prompt.js` | 路由 → 渠道映射表、最小时间单位窗口、白名单渲染、固定模板 |

### 2.2 对既有代码的改动

- `index.js`：**移除**旧的常驻 `systemPrompt.section('dsh-usage-dock.policy')`；
  改为注册 `systemPrompt.context('dsh-usage-dock.quota')`（`interpolate: false`，order 300）。
  观察容器与路由观察器**提升到 apply 作用域**，GUI 路由与工具 collect 共用同一份状态与计数。
  既有采集成功后调用 `publishObservation()`，**不新增任何上游请求**。
- `plans/usage-policy.js`：新增 7 个配置字段（两档百分比、两档余额、两档积分、路由绑定），
  旧 `quotaPercentThreshold` / `quotaBalanceThreshold` **保留但不参与新判定**。

### 2.3 关键行为

- **normal 零规则**：`FIXED_RULES` 只在 warning/closing 被选中，normal 只输出额度事实。
- **同 step 重试可撤销**：动态 context 每次请求重新求值（已用 N12 系列证明
  closing→normal、normal→closing、closing→失败 三个方向的规则都正确变化）。
- **失败分类**：T 计数、前 4 次沿用缓存（**不刷新** `fetchedAt`）、第 5 次移除旧值；
  P/A 立即失效且此后不被 T 复活；C 不计数。
- **路由优先于猜测**：`packyapi` 等无映射路由 → 不投放；路由对应渠道不在白名单 → 不投放；
  未观察到路由 → 不投放。三者都保持 normal、零规则。

## 3. 测试

`tools/test-quota-awareness.mjs`（92 项）覆盖 N1–N13：失败分类、5 次阈值、
阶段判定、路由映射、最小窗口、渲染白名单、阈值解析、三类单位不混比、
视图组装、路由观察器、同 step 重试撤销、多次渲染零取数。

全量 **36 组 1304 项**通过（另行尾 58、几何 144、WorkBuddy 契约 7）。

## 4. 尚未确定 / 未做

- **具体阈值数字**：全部默认 0 = 未配置，没有任何预设值。
- **设置页控件**：本轮**未做** —— 仍只能改配置字段（见第 5 节）。
- **积分阈值单位**：已按交接 §7.5 用**独立字段**（`quotaWarningCreditsThreshold` /
  `quotaClosingCreditsThreshold`），不借用金额字段。
- **能力闸门**：`createRouteObserver.gate()` 默认放行；「已审查的连接链」名单目前只有
  `dsh-codex-connect`。热重载后顺序失效的自动降级**未实现**，保持 normal。
- **真机验证**：未部署、未重启，动态提示词在真实请求中的文本**未验证**。

## 5. 独立审核整改（2026-10-19 第二轮）

首轮交付被独立审核判定**不通过**（[审核报告](review-quota-awareness-build-20261019.md)），
13 组问题（8 组 P1）。以下逐条说明整改内容；全部补了「修复前失败、修复后通过」的用例。

| 编号 | 问题 | 整改 |
| --- | --- | --- |
| A01 | `projectUsage` 未导入 → 成功采集抛错被吞，提示词永远「暂无额度数据」 | 补导入；**仅自定义分支**也接入统一发布（此前整段 return 跳过） |
| A02 | 身份恒为空；配置/停用变化后旧额度仍生效 | 引入 `identityOfChannel()`（配置摘要 + 渠道）；`reconcileIdentities()` 在配置变化时逐条失效；视图增加全局 `enabled`、单渠道开关、身份、来源四重校验 |
| A03 | `seq` 只是完成计数，迟到旧响应会覆盖新值 | 改为 `begin()/commit()` **票据协议**：开始时登记序号，完成时 `seq <= 已提交` 一律丢弃 |
| A04 | 客户端仍独立 8 次计数，未消费统一状态 | Host 在 GUI 响应写入 `effectiveStatus` / `failCount`；客户端**优先消费**该结论，仅在旧响应缺字段时兜底计数；阈值 8 → 5 |
| A05 | 缺精确主体守卫，合法祖先 scope 下子请求污染父观察 | `payload.agent === subject` 守卫；用**真实 Cordis `EventsService` + `dsh-scope`** 验证（`test-quota-route-scope.mjs`），变异测试确认移除守卫即复现 |
| A06 | 闸门注释写「默认关闭」实际默认放行 | `createRouteObserver` 默认 `chainReady = () => false`；`read()` 在闸门关闭时**不返回**旧观察；新增配置项 `quotaTrustRouteOrder`（默认信任本机已核验标准链，可显式关闭） |
| A07 | DeepSeek source / Reserve 池只当标签，不校验 | 视图比对 `meta.source` 与路由 `source`；`usesReservePool()` 识别 `gpt-reserve`，无池证明时**不投放** |
| A08 | 分类器与实际 provider 语义不接通 | `authKind` / `credentialState` 结构化线索**优先于**错误码字面；WorkBuddy 输出 `authKind: session-dead / hard-credit`；`transient` 优先于「结构错误」；无法识别先按 T；`signed-out`（从未登录）=P 与 `reauth-required`=A 区分 |
| A09 | 第 5 次与 P/A 之后丢固定状态，变「暂无数据」 | 引入统一 `status`（`ok`/`cached`/`failed`/`expired`）；封印态遇 T **保持原状态**；视图按 `status` 给固定短语 |
| A10 | 同次采集被发布两遍，3 次失败跨过 5 次阈值 | 按 **wire 对象身份**（`WeakSet`）去重；同一 wire 复用同一张票据 |
| A11 | 绑定歧义会退回宽松/内置映射 | 绑定解析改为三态 `not-found / bound / ambiguous`；歧义**fail closed**，不退宽松、不拿内置表抹掉 |
| A12 | provider 精确键被 trim/lowercase 误合并 | 内置表**精确匹配**，不做大小写/空白归一化；别名必须显式绑定 |
| A13 | 旧单阈值仍通过工具 `policy` 输出冲突建议 | 工具 `policy` 恒为 `null`，保留字段与 schema 兼容；旧配置不被静默迁移 |

### 5.1 新增回归

- `tools/test-quota-remediation.mjs`（59 项）：A01/A02/A03/A04/A06/A07/A08/A09/A10/A11/A12/A13
- `tools/test-quota-route-scope.mjs`（16 项）：真实 Cordis scope 下的 A05/A06/A12

### 5.2 全量

**36 个 Node 组 1304 项** + 行尾 58 + 几何 144 + WorkBuddy 契约 7 = **1513 项**，0 失败。

新包 `1D46A28A…`（178 340 字节 / 27 文件，mismatch=0）。上一包 `6B4024CC…` 作废。

### 5.3 仍未解决 / 需用户确认

- **A07 的账号级证明**：Codex 冻结 store、WorkBuddy 同次 credits 账号归属**未实现**。
  当前策略是「来源不匹配或池未证明就不投放」，即**功能受限但不会误判**。
- **窗口口径**（审核 §5）：现在只评估**最小时间单位**窗口。若同一账号的周限也约束当前模型，
  会漏保护。需用户确认口径后才能改。
- **A06 闸门默认值**：本机标准链已核验，故默认信任并可显式关闭；
  若部署里存在更外层 writer，应关闭该开关。
- **真机未验证**：仍未部署、未重启。

## 6. 第二轮复核整改（2026-10-19 第三轮交付）

第二轮复核判定**仍不通过**（[复核报告](recheck-quota-awareness-round2-20261019.md)），六组残留。
以下逐条整改，全部在**真实 apply 链**上验证（`tools/test-quota-round2.mjs`，25 项）。

| 编号 | 问题 | 整改 |
| --- | --- | --- |
| R2-01 | 票据仍在采集**完成之后**签，旧响应覆盖新结果 | `begin()` 提前到**每条采集调用之前**（内置 plan、自定义条目、仅自定义分支三处），票据随结果返回；`commit()` 按序号拒绝迟到结果 |
| R2-02 | 身份摘要只覆盖 custom；内置凭据变化不失效，还误清无关渠道 | 改为**逐渠道**身份：该渠道自己的启用状态 + 凭据不可逆指纹（Key/Cookie）+ 该条目的 URL/路径/币种/引用/绑定 + 公开修订号；不再使用全局摘要 |
| R2-03 | 模块默认闭，生产入口仍默认放行 | schema 改 `default(false)`；生产改 `=== true`（**必须显式授权**） |
| R2-04 | 一次 T 错误抹掉来源证明，原本拒绝的余额反被接受 | 来源证明**随数值保留**：成功记本次来源、`cached` 继承上次成功来源、失效才清空；视图对需要 source 的可用数值**缺证明即拒绝**（不再跳过校验） |
| R2-05 | 共享了状态/次数，没有共享有效缓存值 | `cached` 时 Host 用同一份观察的投影补齐 `balance`/`currency`/`unit`/`windows`/`creditsTotal`，并附 `balanceFromCache` 与 `staleSampledAt` |
| R2-06 | 真实内置坏 JSON 立即 P；明确 P 类被降为 T | 坏响应（`parse`/`structure`）默认 **T**（宽限 4 次），仅 `permanent:true` 才 P；新增 `endpoint`/`not-installed`/`incompatible`/`not-supported` → **P** |

### 6.1 测试

- `tools/test-quota-round2.mjs`（25 项）：六组全部走真实 `apply()` + 真实路由/工具/context。
  其中 R2-01 用**可控 Promise 编排完成顺序**（先挂起 → 新请求先完成 → 放行旧的），
  断言迟到结果不覆盖 Host 状态。
- 原 `A08e`（`structure → P`）按 R2-06 更正为 `structure → T`，并补 `permanent:true → P`。
- 全量 **37 组 1334 项** + 行尾 59 + 几何 144 + 契约 7 = **1544 项**，0 失败。

### 6.2 新包

`25AEE92F28BC94906273CDEE6234C0D538431E9A938679836B3F4E259CB5DFBB`（180 836 字节 / 27 文件，mismatch=0）。
旧包 `1D46A28A…` 作废。

### 6.3 使用方式（闸门默认关闭后必须显式开启）

策略要真正生效，需要同时满足：

1. `quotaPolicyEnabled: true`（总开关）
2. `quotaFocusChannels` 非空（允许参与判定的渠道白名单）
3. 至少配置一组两档阈值（`quotaWarning*` + `quotaClosing*`）
4. **`quotaTrustRouteOrder: true`**（[R2-03] 必须显式授权路由观察）

第 4 项是安全闸门：它表示「我确认本部署里连接插件的路由写入器先于观察器安装」。
未开启时保持 normal、零规则 —— 宁可不提示，也不依据未验证的路由注入收尾。

## 7. 第三轮复核整改（2026-10-20 第四轮交付）

第三轮复核仍判**不通过**（[复核报告](recheck-quota-awareness-round3-20261020.md)），四组 P1 + 两项身份残留。

| 编号 | 问题 | 整改 |
| --- | --- | --- |
| R3-01 | `identityOfChannel` 调用只在 effect 闭包里的 `shortHash` → ReferenceError 被 catch 吞成**空身份**，所有账户共享一个缓存槽位 | 改用本作用域内的 `entryPublicFingerprint`；**异常返回 `null`** 而非空串；`begin()` 保留 `null`；`commit()` 对 `null` 身份**永不提交**；`publishObservation` 在身份为 `null` 时直接不发布 |
| R3-01 §4.1 | 自定义身份漏了 Key 与该条公开修订号 | 身份纳入 `customKeys[id]` 的不可逆指纹 + `keyRevOf(customKeyRev, id)`；`keyRevOf` 从 `custom-balance.js` 导出 |
| R3-01 §4.2 | 旧身份结果仍能改写按 id 索引的共享映射 | 提交前校验 `useTicket.identity === identityOfChannel(id)`，不一致直接丢弃 |
| R3-02 | 工具采集仍完成后签票 | 工具内置渠道在 `plan.fetch` **之前**签票；自定义条目按 `onlyIds` 逐条预签；`emit` 接收票据 |
| R3-03 | 客户端优先用自己的旧值；冷启动窗口格式不认 | 客户端 `cached` 分支**优先消费 Host 的值**（`balanceFromCache`/`creditsTotal`/`balance`/`windows`），仅在 Host 未提供时回退本地基线；新增 `adaptHostWindows()` 把 Host 通用 `windows` 映射成原生窗口字段，并按 `percentMode` 做 remaining↔used 换算 |
| R3-04 | 混合 GUI 重复查询每个自定义渠道 | 自定义采集改为**惰性 memo**（`runCustomTask`），仅自定义分支与混合分支消费同一份结果，不再第二次 `fetchCustomPlans` |

### 7.1 测试

`tools/test-quota-round3.mjs`（24 项）—— 按审核要求补齐了它指出的盲区：

- **同一实例保存配置**再断言行为（不是另起两个实例对比）；
- **身份为 null 时永不提交**（R3-01 的核心出口）；
- **旧身份提交不影响新身份记录**；
- 跨入口迟到结果不覆盖（挂起 → 新结果 → 放行旧的）；
- 混合分支只返回一条 custom 行。

全量 **38 组 1358 项** + 行尾 60 + 几何 144 + 契约 7 = **1569 项**，0 失败。

### 7.2 新包

`678110F0F4C99839BA4D663D3643F3A1C2CB85E54896852A207D4F593A9F7589`（182 950 字节 / 27 文件，mismatch=0）。
旧包 `25AEE92F…` 作废。

### 7.3 仍未完成（不得写成已验收）

- **真实账号/额度池证明**（Codex 冻结 store、WorkBuddy credits 账号归属）
- **窗口口径**（是否评估周限）
- **策略设置 UI**（未做，只能改配置字段）
- **真实宿主注入/重试验证**（未部署）

> 交付口径提醒：阈值控制 warning/closing；**未配置阈值本来仍允许 normal 额度事实**，
> 不是「必须两档都填才有任何功能」。默认关闭的安全闸门（`quotaTrustRouteOrder`）
> 是**独立**的授权项，不替代上述未完成项。

## 8. 部署故障修复 + 第四轮复核整改（2026-10-20 第五轮交付）

### 8.1 先说部署故障（用户报告：胶囊消失、设置页也没有）

**现象**：本机 profile 里 `package.json` 写着 0.9.0，但目录里只有 **19 个文件** ——
实际是 0.8.4 的骨架，缺 `custom-balance.js`、`usage-tool*.js`、`usage-policy.js`、
`quota-*.js` 共 8 个新模块。`index.js` 一 import 就 `ERR_MODULE_NOT_FOUND`，
整个插件没挂上，所以胶囊和设置页一起消失。

**影响范围**：只是**已安装副本**不完整，仓库与构建包都是完整的 27 个文件。

**修复**：备份那份不完整安装（`plugin-backups\dsh-usage-dock-broken-20261020-122050`），
清空后用当前构建**完整重装** 27 个文件；安装后冒烟：两条路由 + `usage_status` +
`dsh-usage-dock.quota` context 全部注册成功，与仓库 `mismatch=0`。

> 教训：只复制 `index.js`/`client.js` 而漏掉 `plans/*` 会造成"版本号对、文件不全"。
> 安装后必须校验**文件数**与**可 import**，不能只看 `package.json` 的版本号。

### 8.2 第四轮复核整改

第四轮复核确认**上轮四组 P1 与两个身份原案例均已通过**，另提出 3 组待改（1 P1 + 2 P2）
与 1 项防御性建议。

| 编号 | 问题 | 整改 |
| --- | --- | --- |
| R4-01 P1 | A→B→A / 停用→启用 后，已作废的在途结果仍能复活 | 新增**激活 epoch**：`begin()` 捕获当时 epoch，`commit()` 校验必须等于当前 epoch；`invalidateChannel`/`clear` 都推进 epoch（单调递增、永不回退）；GUI 与工具**两个入口**都在读到配置后同步 `reconcileIdentities`，不等异步事件 |
| R4-02 P2 | OpenCode 默认已用口径没参与缓存换算（已用 80% 被显示成已用 20%） | `PLANS` 给 OpenCode 显式标 `percentMode: 'used'`；`adaptHostWindows` 的口径判定统一为「**非 remaining 即已用**」，与原生 GUI 的 `toneColor`/`worstPercent`/详情标题三处一致；补 0–100 钳位 |
| R4-03 P2 | 无成功基线时第 1 次 T 就报「获取额度失败」 | 新增 `pending` 状态：无基线且未满 5 次 → `pending`（不投放、不报失败）；满 5 次 → `failed`；有基线 1–4 次 → `cached`；P/A 不受宽限影响 |
| 防御项 | C（取消）结果把旧 record 当新成功，抹掉 source | `commit()` 对 C 返回 `null`（= 不提交），发布器据此**完全不触碰**任何投影/元信息；另在 GUI 侧用有效投影改写 C wire，保证两端一致 |

### 8.3 测试

`tools/test-quota-round4.mjs`（30 项）+ 更新 `test-quota-round3.mjs` 的 2 处旧期望。

覆盖审核 §5 状态矩阵中的：A→B→A 回切、停用→启用、未改动渠道不受影响、
epoch 单调性、无基线 T1~T4/T5、有基线 T1~T4/T5、P/A 不受宽限、C 无操作
（含"有效快照前后完全相等"）、真实 apply 下 C wire 不清空数值、口径换算方向。

全量 **39 组 1388 项** + 行尾 61 + 几何 144 + 契约 7 = **1600 项**，0 失败。

### 8.4 新包

`EDE80340E9E6F5DB8EE579CAE8180AAEE70A630B2CC25BF220C8D38DD6029CB2`（186 101 字节 / 27 文件，mismatch=0）。
旧包 `678110F0…` 作废。**已重装到本机 profile 并冒烟通过。**

### 8.5 仍需用户操作 / 未完成

- **需要重启 DSH 桌面端**（Host 半不热重载）才能让新代码生效；重启后硬刷新 `Ctrl+Shift+R`。
- 策略要生效还需**显式打开** `quotaTrustRouteOrder`（安全闸门默认关闭）。
- 仍未完成：真实账号/额度池证明、窗口口径、策略设置 UI、真机注入与重试验证。

## 9. 第五轮复核整改（2026-10-20 第六轮交付）

第五轮复核确认 **R4-02（百分比口径）、R4-03（pending）、C 取消项全部通过**，
仅剩一组 P1：**epoch 不是完整的激活状态，仍依赖已提交元信息**。

### 9.1 三个缺口与修法

| 缺口 | 表现 | 修法 |
| --- | --- | --- |
| §3.1 首次查询无结局时回切 | 冷启动第一条查询挂起（无 `channelMeta`）→ A→B→A → 旧 1CNY 被接受并触发收尾 | 新增 `seenActivation`（`id → {identity, monitorOn}`）**独立于数据观察**：首次见到只登记不推进，之后任何变化都推进 epoch |
| §3.2 监控总开关不参与激活边界 | `enabled` 关→开 后旧在途结果复活 | `monitorOnOf()` 纳入激活状态比对；全局开关与渠道启停走同一条生命周期 |
| §3.3 `clear()` 漏掉从未提交的票据 | `begin → clear → commit` 仍成功 | `begin()` 首次即把 id 登记进 `epochs`（只登记、不递增），`clear()` 才能覆盖到它 |

### 9.2 关键额外发现（本轮的真正根因）

复核给的出口是「激活状态与数据观察分离」，但实现时发现还有**第二层**问题：

`bumpEpoch()` 只推进代次、**不清记录**。而记录是按 `id + identity` 分槽存放的，
A→B→A 之后 A 槽位的旧记录仍在，回切 A 的**第一次失败**会读到它、按「有基线」走缓存，
把上一个激活的余额又拿回来（实测：回切后仍显示 cached 95）。

修复：`bumpEpoch()` 同时清除该渠道全部记录 —— 推进代次拒绝旧票据，清除数据拒绝旧值。
这一处修完，R4 的两条旧用例也一并恢复（它们之前因数据未清而失败）。

### 9.3 测试

`tools/test-quota-round5.mjs`（15 项）：

- 首次查询无结局时回切 / 停启，旧结果均不被采纳，context 无收尾规则；
- 监控关→开后旧在途结果不被采纳；
- `begin → clear → commit` 被拒；
- **不得饿死**：同身份并发请求共享同一 epoch，第一条能正常建立基线；
- 只改另一条渠道时本条 epoch/基线/计数不变。

全量 **40 组 1403 项** + 行尾 62 + 几何 144 + 契约 7 = **1616 项**，0 失败。

### 9.4 新包

`BC858056A81A20D83FB2F712392AAAB45BBB7F19C64F242C1C3655300A60FB04`（187 174 字节 / 27 文件，mismatch=0）。
旧包 `EDE80340…` 作废。**已重装到本机 profile 并冒烟通过**（两条路由 + `usage_status` + quota context）。

### 9.5 仍未完成

- 真实账号/额度池证明
- 窗口业务口径（是否评估周限）
- 策略设置 UI
- 真实宿主注入/重试验证
- **需用户重启 DSH 才能让新代码生效**

## 10. 自定义渠道改造（0.9.1，2026-10-20）

用户提出 5 个自定义渠道问题，本轮一并解决。**这是一次破坏性变更**（按用户决定：升级后清空自定义渠道，需重新选择来源）。

### 10.1 核心变化：余额地址不再由用户输入

| 项 | 0.9.0（旧） | 0.9.1（新） |
| --- | --- | --- |
| 余额地址 | 用户手填 HTTPS URL | **从已配置的模型渠道中选择** |
| API Key | 用户手填，或手填凭据引用名 | **自动复用所选渠道的 `apiKeyEnv`** |
| 发送目标确认 | 需要（改 URL 后必须重新确认） | **移除**（地址来自配置，不存在"用户改目标"） |
| DNS 私网检查 | 全部条目 | **provider 来源跳过**（见 10.3） |
| `customKeys` | 使用 | 不再写入（仅为清理旧数据保留 unset 路径） |

**为什么这样更安全**：原来的防护（DNS 公网校验 + IP 钉死 + 目标确认）都是为了应对"用户可能填任何地址"。
地址改为从**用户自己配置并正在使用的模型服务商**派生后，这层风险消失，因此可以简化 —— 同时
fake-ip 代理（198.18/15）不再被误判为内网。

### 10.2 五个问题的实现

| # | 问题 | 实现 |
| --- | --- | --- |
| 1 | 排序失效 | **根因**：`orderedIds()` 的 `known` 集合只含内置渠道，自定义 id 被当作"未知 id"过滤掉，所以上移/下移改了草稿顺序却被重排回原样。现在把 `draft.customBalances` 的 id 也纳入，并把未列入 `planOrder` 的补在队尾 |
| 2 | 凭据引用手填 | 改为**自动复用**：`resolveProviderTarget()` 读 `providers.<id>.apiKeyEnv` → `credentials.resolve(ref)` → 值只用于本次请求。UI 移除 Key 输入与引用输入 |
| 3 | 字段占空间 | 新增 `customFieldPairStyle`/`customFieldHalfStyle`：结果 JSON 键 + 可选扣减键**并排**；币种独立一行 |
| 4 | 卡片折叠 | 名称旁加 `▸/▾` 按钮，折叠后只显示"渠道 + 键"摘要；状态存组件级 `customCollapsed` |
| 5 | OpenRouter fake-ip | 见 10.3 |

### 10.3 安全边界的变化（必须如实说明）

`validateBalanceUrl(text, { skipPrivateHostCheck })` 与 `fetchCustomBalance` 里的 DNS 校验：

- **provider 来源的条目**：跳过"环回/私网/单标签主机"检查，**也不钉死 IP**（交给系统解析）。
  原因：地址来自配置、可信；且 fake-ip 代理会把域名解析成 198.18/15，检查会误判。
- **仍然保留的底线**：必须 https；拒绝 URL userinfo；拒绝把凭据放查询串；不跟随重定向；TLS 证书校验不关闭。
- **手填 URL 的旧路径**（仅兼容/测试）：私网检查照旧生效。

**代价明确**：provider 来源失去"检查的 IP 就是连接的 IP"这层保证。连错服务器会因 TLS 握手失败而拒绝，
因此不会把 Key 发给伪装者，但 DNS 重绑定的防护不再覆盖这类条目。

### 10.4 测试

- 新增 `tools/test-custom-provider-source.mjs`（16 项）：渠道筛选、旧条目兼容、skipPrivateHostCheck 的正负例、custom-status 返回渠道列表、缺渠道时的可操作提示。
- 更新 `test-custom-settings`（48 项）、`test-custom-race`（34 项）、`test-custom-security`（37 项）、`tools/mock-react.mjs`（按 URL 区分 custom-status，返回 providers）。

**因本轮破坏性变更而失效并已按新契约重写的用例**（用户同意"核心安全测试优先，其余标记"）：

| 用例 | 原验证 | 现状 |
| --- | --- | --- |
| `R5-Aa~Ad`（client race） | 改 URL 后重新确认目标、新 Key 自动绑定 origin | 机制已移除；改为断言"不再渲染确认/Key/URL 控件" |
| `C2v~C2aa`（settings） | Key 输入框、隐藏回显、customKeys 路径写入 | 改为断言"不再提供 Key/引用输入" |
| `C2ab~C2ad` | 清除已保存 Key → unset | 改为"不再渲染清除按钮、不写 secret 路径" |
| `C2aj~C2am` | 发送目标确认 UI | 改为"旧字段不再渲染、下拉显示已保存渠道" |
| `R6-Aa`、`R6-Bb` | 无 mutate 时拒绝写 Key；同批写 customBalances + customKeys | 改为"纯元数据不触碰 secret 路径" |
| `C2q` | 保存写入 url | 改为保存 `provider` |

**保留未改的核心安全用例**：`test-custom-security`（URL/DNS/重定向/预算/秘密不外泄）、
`test-review-fixes`（连接期 IP 绑定 + 真实 TLS 往返）、`test-recheck-fixes` / `round3` / `round4`
（端口 origin、配置证明、双端摘要规范化）—— 这些全部通过。

### 10.5 全量

**41 组 1412 项** + 行尾 63 + 几何 144 + 契约 7 = **1626 项**，0 失败。

新包 `6284D9F114AB6336997F31E68126230335171AFEEFA56CA079CD150F2A0C054C`（191 800 字节 / 27 文件，mismatch=0）。
旧包 `BC858056…` 作废。**已重装到本机 profile。**

### 10.6 用户需要做的事

1. **重启 DSH 桌面端**（Host 半不热重载）+ `Ctrl+Shift+R`。
2. 自定义渠道会被清空（旧条目没有 `provider`）：到「设置 → 模型」确认要用的服务商已配置好
   （需要 `接口地址 + API Key`），再回自定义区从下拉中选择。

### 10.7 仍未完成

- 真实账号/额度池证明
- 窗口业务口径（是否评估周限）
- 策略设置 UI
- 真实宿主注入/重试验证（动态提示词的真实请求/重试尚未抓取）

## 11. 自定义渠道新方案审核整改（2026-10-20）

[审核报告](review-custom-provider-v0.9.1-20261020.md) 判定「方向可保留，当前实现不通过」：
4 组 P1 + 3 组 P2，其中 **CP-01 可把旧条目的 Key 发到新选服务商**。

### 11.1 已修（CP-01 / CP-02 / CP-04 / CP-05 / CP-06 / CP-07）

| 编号 | 问题 | 整改 |
| --- | --- | --- |
| **CP-01** P1 | 新旧凭据冻结协议混用：工具对只有 provider 的新条目冻结成 `none`（报缺凭据）；若同时有遗留 `customKeys`，则冻结旧 Key，而 provider 解析把目标改成新服务商 → **旧 Key 被发到新地址** | `identify` 为 provider 条目新增独立冻结类型 `{kind:'provider', provider}`，**不含任何旧 Key 值**；`fetchCustomBalance` 在 provider 模式下**完全绕开旧冻结协议**，只认本次 provider 解析出的凭据。身份里带 provider 与凭据指纹 |
| **CP-02** P1 | 任意配置行的 providers 都进列表，同 id first-wins | 新增 `findProviderOwner()`：按行判定归属，**多行声明即判歧义并拒绝**；跳过 Loader 已禁用的条目；不再 first-wins |
| **CP-04** P1 | provider 没进身份与配置证明，换源仍用旧额度收尾 | `generationOf()`、`entryPublicIdentity()`、客户端 `digestEntryIdentity`/`customConfigSignature` 全部纳入 `provider`（双端逐字同构） |
| **CP-05** P2 | 新凭据解析绕过单条绝对预算 | `resolveProviderTarget` 的 `credentials.resolve` 走 `budget.race`，超时/取消后不再派发 |
| **CP-06** P2 | 文档说升级会清空，生产仍主动读取旧条目 | `collectCustomExpressions` 默认**不采纳**无 `provider` 的旧条目；`fetchCustomPlans` 与两个生产入口不再后台查旧地址。测试钩子 `DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM=1` 仅测试进程设置，让底层安全回归仍走同一份实现 |
| **CP-07** P2 | 预设添加的来源漏列 | `listProviderTargets` 不再要求显式 `baseURL`：省略时用目录默认地址；**来源可见性与可查询性分离**，缺地址/非 https/需 OAuth 的条目带 `status` + `reason` 显示，不静默消失。按**提供商身份**排除 DeepSeek/MiMo（OpenRouter/PackyAPI 跑 DeepSeek 模型仍出现） |

### 11.2 实测验证（CP-01 两个反例）

- 工具路径请求携带的是 **Beta 的 Key**，旧 Alpha Key **未发出**；
- 只有 provider 的新条目在工具路径**正常发出请求**，不再报 `no-credential`。

### 11.3 CP-03：余额端点（方案一，用户 2026-10-20 确认）

审核指出：**模型 `baseURL` 不能通用推导余额端点**（模型根 `/api/v1`、余额 `/api/v1/credits`）。
用户确认采用**方案一**：只从所选模型渠道取**主机**，余额**端点路径由用户显式填写**。

实现：

| 项 | 说明 |
| --- | --- |
| 数据字段 | 新增 `balanceEndpoint`（如 `/api/v1/credits`），进入 schema 与配置身份 |
| 来源根 | `readProviderSource` 现在只返回 `origin`（主机 + 协议 + 端口），**不再返回完整模型 baseURL** |
| 拼接 | 新增 `buildBalanceUrl(origin, endpoint)`：只接受以 `/` 开头的**路径**，拼出完整余额 URL |
| 安全边界 | 主机永远来自所选渠道；用户只能填路径，**无法把凭据引到别的主机**。拒绝完整 URL、拒绝 `//` 协议相对前缀，并用 `URL` 规范化后校验 origin 不变（防 `..`/编码绕过） |
| UI | 「余额来源」下拉下方新增「余额接口路径（主机来自上面的渠道，只填路径）」输入框 |
| 校验 | 客户端 `validateCustomEntry` 与 Host 同规则：必填、`/` 开头、非 `//`、≤300 字符 |

**这解决了审核的 `FAIL_MODEL_BASE_URL_IS_BALANCE_URL`**：模型根不再被当作余额地址，
用户可以填真正的余额端点，而主机仍受约束。

新增回归（6 项）：正常拼接、空路径拒绝、缺前导斜杠拒绝、`//` 拒绝、完整 URL 拒绝、
`..` 规范化后仍同主机。

### 11.4 文档安全论证的更正（审核 §3）

原文 §10.1/10.3 的两句推导**不成立**，已在此更正：

- ~~「这层风险消失」~~ → 准确说法：**用户输入地址**这一路径消失，但来源归属、端点正确性、
  Key 与目标的一致性仍需独立验证；
- ~~「连错服务器会因 TLS 握手失败而拒绝」~~ → TLS 只验证**所选 hostname 的证书**，
  不判断「这把 Key 是否应该发给该服务商」。CP-01/CP-02 在目标持合法证书时照样可能错发；
- fake-ip 兼容与「放开所有环回/私网地址」**不是同一范围**；网络可达性与 SSRF 保证确实减少，
  不能表述为「风险消失」；
- 普通 `fetch` 不等于自动走代理，能否经过 fake-ip 网关仍取决于运行环境。

**保留的正确结论**：对已唯一绑定并确认的目标，仍保持 TLS 校验、禁重定向、拒绝 userinfo、
拒绝把凭据放查询串。

### 11.5 测试

新增/更新：`test-custom-provider-source`（18 项，含 CP-02 歧义、CP-07 状态可见性、CP-06 迁移）、
`test-custom-security`（37）、`test-review-fixes`（40）、`test-host-custom`（31）等。

全量 **41 组 1420 项** + 行尾 63 + 几何 144 + 契约 7 = **1634 项**，0 失败。

新包 `6B587CE935E0BEEA32B94D147254BB34EA72BF159448593E47BDB2C8C01B6FD1`（198 801 字节 / 27 文件，mismatch=0）。
旧包 `6284D9F1…` 作废。已重装到本机 profile。

### 11.6 仍未完成

- 真实账号/额度池证明、窗口业务口径、策略设置 UI、真实宿主注入/重试验证

## 12. 第二轮复核整改（2026-10-20）

[第二轮复核](recheck-custom-provider-v0.9.1-round2-20261020.md) 判「整体仍不通过」：
CP-01 原两个反例已修、CP-03/05/06 通过，但 **CP-01/02/04/07 有残留**，另新增 CP-08（用户要求的
baseURL 展示）。本轮全部处理。

### 12.1 最关键的实机问题：OpenRouter 报「没有可用接口地址」

复核定位准确：`readProviderSource` 从**配置行**找 `defaultBaseURL`，而真实
`configEditor.configuration()` 只返回 `entry/inherited/override` 这些配置层，
**默认地址在宿主目录里**（`llm.listConfigurableProviders()` → `defaultBaseURL`）。
所以 OpenRouter 这类省略 `baseURL` 的预设来源必然报错——而且是在拼端点、解析 Key、发请求**之前**。

**整改**：来源解析改为「**先读公开目录，再读配置**」。

| 步骤 | 做法 |
| --- | --- |
| 1 | `llm.listConfigurableProviders()` 取权威目录（含 `settingsNs`/`settingsPath`/`defaultBaseURL`/`nativeAuth`） |
| 2 | 目录里没有该 provider → **直接拒绝**，不扫配置行猜 |
| 3 | 用目录的 `settingsNs` 定位**唯一** owner 行（宿主源码：`settingsNs = ctx.fiber.entry?.options.id`） |
| 4 | 按 `settingsPath` 逐层读 `override` → `inherited` 得到有效配置 |
| 5 | 显式 `baseURL` 优先；真正省略时才用目录 `defaultBaseURL` |
| 6 | 认证按目录 `nativeAuth` 如实分类（OAuth/原生 ≠ 用户没配置 Key） |

新增 `readProviderCatalog()` 与 `readPathConfig()`；`listProviderTargets(ctx)` 签名从
「传配置列表」改为「传 ctx」（因为要读两个服务）。

### 12.2 CP-01 残留：冻结完整来源，派发不再二次解析

复核复现 `FAIL_IDENTITY_A_CACHES_DISPATCH_B`：采样解析到 Key A 并计入缓存身份，但快照只留
provider 名；派发又解析到 Key B 并发出 B 的请求 → 「身份 A、数据 B」，下次还把 B 当 A 命中。

**整改**：

- `resolveProviderCredential()` 现在返回**完整来源**：`{value, ref, url, origin}`；
- `identify` 冻结 `{kind:'provider', provider, url, origin, ref, value, fingerprint}`；
- `fetchCustomBalance` **优先使用这份冻结**（`useFrozen`），不再二次解析；
- 缓存身份包含 provider + 余额端点 + **冻结时的 URL** + 凭据指纹。

**复核要求的「不能用『完全绕开旧冻结协议』替代新协议」已按此落实。**

### 12.3 CP-02 残留：owner 由目录核验，不再看配置行形状

之前只跳禁用/多候选，仍从**任意行**的 `providers` 形状取值 —— 无关插件只要有同名字段就被认作模型来源。

**整改**：`findProviderOwner` 不再被生产路径使用；来源定位完全以目录为准（12.1 第 2/3 步）。
`listProviderTargets` 也按同样规则：目录里没有 → 不列出；配置行不属于目录声明的 ns → 不算已添加。

**仍未处理**：`Object.assign(inherited, override)` 的「整份配置替换」语义。
本轮改为 `readPathConfig()` 逐层读取（`override` 命中即用，否则退回 `inherited`），
不再做对象合并；但**显式空 override 是否应复活 inherited** 这一层没有改（需要宿主配置组合语义的更多证据），
如实记录为未完成项。

### 12.4 CP-04 残留：Host 观察身份补上 provider 与端点

`identityOfChannel` 之前手拼旧字段（url/JSON 键/币种/旧引用），漏 `provider` 与 `balanceEndpoint`
→ 换来源后公共摘要变了、Host 观察身份没变，epoch 不推进，旧额度继续驱动收尾。

**整改**：`parts.push('provider=' …)` 与 `parts.push('endpoint=' …)` 已加入；
`generationOf()` 与 `entryPublicIdentity()` 同步覆盖（双端逐字同构）。

### 12.5 CP-07 残留：状态贯穿到设置页

`custom-status` 路由 map 时只留 `provider/displayName/origin`，把 `status`/`reason` 剥掉了。

**整改**：路由现在返回 `{provider, displayName, baseURL, origin, baseURLSource, status, reason}`，
客户端在下拉下方直接显示状态与原因。

### 12.6 CP-08：显示所选渠道实际生效的 baseURL

设置页在「余额来源」下方显示：

```
模型接口地址：https://openrouter.ai/api/v1（该渠道的预设默认）
```

- 显示**完整路径**（能看出结尾有没有 `/v1`），来源区分「你配置的 / 预设默认」；
- **脱敏**：`sanitizeDisplayUrl()` 去掉 userinfo、查询串、fragment，保留协议/主机/路径；
- 仅 GUI 展示，**不进** `usage_status` 与自动 context，不为显示发上游请求；
- 未能解析时明说「未能解析，请到「设置 → 模型」检查」。

### 12.7 顺带修掉的真实健壮性缺口

- **来源解析异常未被捕获**：`fetchCustomBalance` 里 provider 解析块原来直接 `await`，
  宿主目录/凭据服务抛错会越过本条失败分类，整批变成「余额请求发生未预期的异常」。
  现已 try/catch 转成结构化 `config` 错误。
- **采样阶段凭据解析无预算**：`resolveProviderCredential` 的 `credentials.resolve` 原来不受预算约束，
  凭据服务挂起时采样会等到自己的 10 s 超时。现已走 `budget.race`
  （`identify` 用 deadline 构造 `samplingBudget`）。
- **`let entry` 声明位置**：冻结快照读取曾在 `frozenMap` 定义之前，触发
  `Cannot access 'frozenMap' before initialization`。已调整顺序。

### 12.8 测试

新增 `tools/test-custom-provider-round2.mjs`（24 项），逐条对应复核反例：

| 项 | 覆盖 |
| --- | --- |
| R1a–R1d | OpenRouter 默认地址从目录读到、标 catalog、状态 ready |
| R2a–R2c | 目录里没有/非 owner namespace 的 provider 一律拒绝 |
| R3a–R3e | 冻结含本次凭据与 URL；派发**不再二次读取**，用的是 A 不是 B |
| R4a–R4d | 公共摘要与代次都对 provider / 端点敏感 |
| R5a–R5e | 展示 URL 保留路径、去掉敏感部分 |
| R6a–R6c | 凭据挂起按预算返回、零请求、结构化失败 |

另更新 `test-custom-provider-source`（27）、`test-custom-settings`（48）。

全量 **42 组 1447 项** + 行尾 64 + 几何 144 + 契约 7 = **1662 项**，0 失败。

> ⚠️ 并发跑会互相串扰（`test-custom-balance-fetch` / `test-workbuddy` 曾各失败 1–2 项），
> **必须串行**逐文件执行；串行后全部通过。

新包 `EC757F5CF0B3FB294FE25762EDFBC47B04A60FE5D17E377150903D4BCC14FD2E`
（203 516 字节 / 27 文件，mismatch=0）。旧包 `6B587CE9…` 作废。已重装本机 profile。

### 12.9 仍未完成

- `Object.assign(inherited, override)` 的整份替换语义（见 12.3）
- 真实账号/额度池证明、窗口业务口径、策略设置 UI、真实宿主注入/重试验证
- 复核明确指出：本轮**未**独立哈希正在运行的插件模块，不宣称新包已实机通过

## 13. 用户实测反馈修复（2026-10-20）

用户在实机测试中报告两个问题，均确认为真实缺陷。

### 13.1 余额端点必须重写 `/api/v1`（反直觉）

**现象**：接口地址已经是 `https://openrouter.ai/api/v1`，但余额路径必须填 `/api/v1/credits`
才能用；填 `/credits` 反而失败。

**根因**：`buildBalanceUrl` 拿 **`origin`**（`https://openrouter.ai`）当拼接基准，
把 baseURL 里的 `/api/v1` 丢掉了。用户等于要重写一遍路径 —— 与「接口地址已含路径」的直觉相反。

**修复**：端点改为**相对 baseURL 的路径**解析，并兼容老习惯：

| 输入 | 结果 |
| --- | --- |
| baseURL `…/api/v1` + `/credits` | `…/api/v1/credits` ✅ 只填 `/credits` |
| baseURL `…/api/v1` + `/api/v1/credits` | `…/api/v1/credits` ✅ 不重复拼成 `/api/v1/api/v1/...` |
| baseURL `…/api/v1/`（尾斜杠）+ `/credits` | `…/api/v1/credits` ✅ |
| baseURL `https://x.example`（无路径）+ `/credits` | `https://x.example/credits` ✅ |

**注意不能用 `new URL(path, baseDir)`**：那样 `/credits` 会**替换**最后一段
（`…/api/v1` → `…/api/credits`），把用户看得见的 `v1` 丢掉。实现改为字符串拼接后交给
`URL` 规范化，`..` 仍被正确处理，且拼接后校验 origin 未变（凭据不会被引到别的主机）。

`readProviderSource` 现在同时返回 `baseURL`（含路径）与 `origin`。

### 13.2 自定义渠道无法上下移动改变顺序

**现象**：设置页点 ▲/▼，胶囊与详情面板的条目顺序毫无变化。

**根因（两层）**：

1. **显示链路不通**：卡片的 `move()` 只改 `customBalances` 数组，而胶囊与详情面板
   只按 `planOrder` 排序。`orderedIds()` 虽然已把自定义 id 纳入，但**没有任何渲染路径
   使用它**——自定义条目始终按 Host 返回的数组顺序出现。
2. **两次 `change()` 互相覆盖**：`change(field, val)` 基于 `current` 重建草稿，
   连续调用两次时后一次会把前一次的改动抹掉。

**修复**：

- `move()` 改为一次调用 `props.onReorder(ids, next)`，父组件 `reorderCustomEntries`
  在**同一次** `setDraft` 里同时写 `customBalances` 与 `planOrder`；
- `planOrder` 写成「内置渠道原相对顺序 + 自定义条目新顺序」；
- Host 侧新增 `orderCustomByPlanOrder(custom, planOrder)`，按 `planOrder` 重排自定义条目
  （未列入的保持原相对顺序追加），主分支与「仅自定义」分支都走它；
- 因此设置页卡片、胶囊、详情面板三处顺序**同源**。

### 13.3 测试

- `tools/test-custom-provider-source.mjs` 新增 **P7（5 项）**：baseURL 含路径、
  不重复拼接、尾斜杠、无路径退化、带查询串。
- 新增 `tools/test-custom-order.mjs`（**15 项**）：
  - O1：点「下移」→ 保存后 `customBalances` 与 `planOrder` **都**按新顺序写入；
  - O2：点「上移」同样生效，内置渠道仍在前；
  - O3：首位再上移不改动；
  - O4：Host 排序规则（按 `planOrder`、未列入的保持相对顺序、空顺序不变）。

全量 **43 组 1467 项** + 行尾 65 + 几何 144 + 契约 7 = **1683 项**，0 失败（串行）。

新包 `078525C78EE2F10BFBAE68919BD660EBDCD81B022C7E9502B98690040BAD2AFA`
（205 716 字节 / 27 文件，mismatch=0）。旧包 `EC757F5C…` 作废。已重装本机 profile。

### 13.4 顺带确认的两个既有结论仍然成立

- 来源必须从**公开目录**读取（12.1），本轮 `readProviderSource` 改动没有破坏它；
- 展示用 baseURL 仍脱敏（去掉 userinfo/查询串/fragment），保留完整路径供用户辨认 `/v1`。

### 13.5 排序修复的**真正**根因（第二次，2026-10-20）

13.2 的修复只落在「Host 侧排序 + 设置页写 planOrder」，**胶囊仍然不动**。用户复测确认。

**真正的最后一环在客户端**（`client.js` 胶囊数据准备处）：

```js
// 旧代码
plans = sortPlansByOrder(builtIns, config.planOrder).concat(customs)
```

`customs` 被**原样追加**，注释还明确写着「自定义条目**不参与**内置排序：它们固定排在
内置渠道之后，内部按配置里的列表顺序显示」。于是：

- Host 按 `planOrder` 排好了 → 客户端这一步又把它覆盖回数组原序；
- 设置页写入的 `planOrder` 在胶囊/详情面板里**从来没有被读取过**（对自定义条目而言）。

**修复**：新增 `sortCustomByOrder(list)`，按 `planOrder` 里自定义 id 的先后重排，
未列入的保持原相对顺序追加。`plans = 内置(按 planOrder) + 自定义(按 planOrder)`。

### 13.6 为什么这个 bug 躲过了前面所有测试

`test-custom-render.mjs` 的挂载参数是 `{ configForm: null, wide: true }` ——
**从没提供过 `planOrder`**，所以「胶囊是否按 planOrder 排自定义条目」这条路径
从来没有被执行。新增 **R14**（2 项）补上：

- `configForm` 提供真实的 `planOrder` 与匹配的 `customBalances`；
- payload 故意按**相反**顺序给，断言胶囊必须重排出「乙厂在前」。

**已验证它能抓到 bug**：把修复临时回退后 R14b 失败（`iA=0, iB=8`，顺序反），
恢复后通过 —— 是真正的「先失败、后通过」用例。

> 另一个坑：`configForm` 里只给 `planOrder` 而不给对应的 `customBalances`，
> 客户端会按已保存配置校验身份并整批隐藏（显示 `————`）。测试必须两者都给。

全量 **43 组 1469 项** + 行尾 65 + 几何 144 + 契约 7 = **1685 项**，0 失败（串行）。

新包 `FB39D4F6A032748E64D34E4D1C8BA23553734850A40C83D22BD7EC8B7908E688`
（206 229 字节 / 27 文件，mismatch=0）。旧包 `078525C7…` 作废。已重装本机 profile。

## 14. 排序专项 + 第三轮复核整改（2026-10-20）

两份报告：[排序专项](review-custom-order-20261020.md) 与
[第三轮复核](recheck-custom-provider-v0.9.1-round3-20261020.md)。

### 14.1 排序：用户已确认**全局混排**（覆盖旧的分组设计）

用户明确要求：OpenRouter 这类自定义渠道必须能移到 Codex / WorkBuddy **之前**，
所有渠道统一上下排序；设置页卡片、胶囊、详情面板共用同一顺序。
**旧的「已有自定义项固定在底部」限制作废。**

审核指出四处维持分组的位置，全部改掉：

| 位置 | 旧行为 | 现在 |
| --- | --- | --- |
| 胶囊/详情（client） | `sortPlansByOrder(builtIns).concat(customs)` | `sortPlansByOrder(plans)` —— 按完整列表排 |
| 自定义重排写入 | `builtIn.concat(nextOrder)`，且重新遍历 `PLANS` 生成默认顺序 | 直接写调用方给的**全局顺序**，不再重置内置顺序 |
| Host 结果 | `builtIn.concat(orderedCustom)` | `orderPlansByPlanOrder(builtIn.concat(custom))` |
| 设置页 | 自定义区固定在底部 | 箭头按**全局位置**判定相邻项，可跨组移动 |

另外修掉两个独立的顺序损坏：

- **FAIL_CUSTOM_REORDER_RESETS_BUILTIN_ORDER**：旧 `reorderCustomEntries` 重新遍历 `PLANS`
  生成注册表默认顺序，把用户已保存的内置顺序重置了。现在直接采用传入的完整顺序。
- **FAIL_INITIAL_BUILTIN_MOVE_DROPS_CUSTOM_ORDER**：`orderedIds()` 只从 `draft.customBalances`
  收集自定义 id，刚打开设置（`draft === null`）时已保存的自定义 id 被当成「未知 id」过滤掉，
  移动一个内置项并保存后它们**永久消失**。现在草稿为空时退回 `current.customBalances`。

**单条自定义的箭头**（SINGLE_CUSTOM_BOTH_ARROWS_NO_OP）：旧实现 `index±1` 在只有一条时必然越界，
按钮却按 `locked` 判定为可点 → 点了没有任何反应。现在按**全局顺序定位**判定：
有内置邻居就能移动，真正到首/尾才 `disabled`。

### 14.2 P1-1：宿主移除来源后不再"复活"

审核用宿主原组合器（`applyEntryPatches`: `target[key] = value`，config **整份替换**）
证明：上层提交 `config: {}` 或 `config: { providers: {} }` 时，**有效配置里没有该 provider**。

旧实现 `readPathConfig` 在 override 未命中时退回 `inherited`，于是宿主已删除的来源被复活，
插件继续读旧凭据、向旧主机发请求、用旧额度收尾。

**整改**：新增 `composedConfigOf()` —— 优先读 Loader 条目上**已组合**的 `options.config`
（宿主权威结果），用 `readPathFrom()` 在其中查 `settingsPath`，**没有层间回退**。
`listProviderTargets` 与来源解析都改用它。

**正控制仍然成立**：没有覆盖时，inherited 来源依旧有效（S4c）——不能把所有空 override
都当清空，区别由组合结果决定，而不是"override 是否非空"。

### 14.3 P1-2：同一 provider 的真实来源变化也换身份

`identityOfChannel` 之前只拼条目里的 `provider` 字符串与端点，比较的是"用户选了什么"，
不是"当前生效的模型来源是什么"。于是只改模型配置里该 provider 的 `baseURL`/`apiKeyEnv`
时，Host 观察身份不变，旧额度继续驱动收尾。

**整改**：新增 `providerSourceFingerprint(ctx, provider, endpoint)`，把 provider 的
**实际 baseURL + origin + 引用名 + 端点**做短哈希纳入身份。来源一变身份即变，
epoch 推进、旧观察作废。该函数只读目录与已组合配置（同步、本地、无网络、不解析凭据值）。

### 14.4 P2：GUI 已知永久失败后，工具不再返回旧的成功缓存

审核复现：同源同 Key，工具先成功（30 秒缓存），随后 GUI 真实取数收到 401、Host 显示
「获取额度失败」，但工具仍返回旧的 `ok/1` 且零新请求。

**整改**：`registerUsageTool` 新增 `deps.isSourceFailed(id)`（由 `quotaObserver.read(id)`
判断 `failed`/`expired`）。命中缓存前先问一句；已知失败则**丢弃该缓存项**并转真实重试。
只拦永久失败/过期 —— 暂时失败保留宽限缓存是正确行为，不粗暴清空无关渠道。

### 14.5 测试

新增 `tools/test-custom-round3.mjs`（**15 项**）：

| 组 | 覆盖 |
| --- | --- |
| S1 | 单条自定义时两个箭头的禁用状态与全局位置一致；末项「下移」确实 disabled |
| S2 | 自定义**跨组**上移越过 workbuddy；内置**非默认**顺序不被重置；其它项相对顺序不变 |
| S3 | 刚打开（无草稿）移动内置项并保存，已保存的自定义 id 仍在 planOrder 里 |
| S4 | 显式清空后不列出、不复活；指纹标为 `gone`；**正控制**：无覆盖时继承来源仍有效 |
| S5 | baseURL 变化 / 引用变化 → 来源指纹变化；未变化时稳定 |

另更新 `test-custom-render` R11a（旧断言「自定义必须在内置之后」已被用户推翻）与新增 R14（2 项）。

**已验证能抓到 bug**：把胶囊分组回退后 R11a/R14b 失败，恢复后通过。

全量 **44 组 1484 项** + 行尾 66 + 几何 144 + 契约 7 = **1701 项**，0 失败（串行）。

### 14.6 顺带修掉的一个构建问题

`client.js` 曾被写成 CRLF（我前面用 `Set-Content` 时引入），导致 `test-android-compat`
的切片标记（按 `\n` 查找）找不到、`new Function` 报语法错。已统一回 LF
（`test-line-endings` 66 项通过）。

新包 `E0D7AC4E04C1B56A9A0324DBD71C1B1E8FF3C28154B38B986E24D65C5C6FC95F`
（209 785 字节 / 27 文件，mismatch=0）。旧包 `FB39D4F6…` 作废。已重装本机 profile。

### 14.7 仍未完成

- 真实账号/额度池证明、窗口业务口径、策略设置 UI、真实宿主注入/重试验证
- 审核明确指出：本地合成分支通过 ≠ 运行副本已重载或真实 Key 权限已验证

## 15. 第四轮复核整改（2026-10-20）

[第四轮复核](recheck-custom-provider-v0.9.1-round4-20261020.md)：1 组 P1 + 2 组 P2，
另有排序组两处界面残留。来源删除、主机/引用变更已转通过。

### 15.1 R4-02（P2）：`isSourceFailed` 调错了观察器接口

`quotaObserver.read(id)` 的真实签名是 **`read(id, identity)`** —— 记录按
`observationKey(id, identity)` 存。只传 id 永远查不到，钩子恒返回 `false`，等于完全没生效。

**整改**：`isSourceFailed(id, identity)` 接受身份；调用方（工具缓存层）把本次身份传下去；
未传时退回 `identityOfChannel(id)` 的当前有效身份，**仍不跨身份读取**。

### 15.2 R4-01（P1）：同一引用下 Key 值轮换，Host 仍按旧值收尾

上一轮的 `providerSourceFingerprint` 只覆盖「主机 + 引用名 + 端点」，**不覆盖引用背后的值**。
审核复现：provider/主机/引用名/端点全不变，凭据服务返回 A→B→A，第三次工具已确认当前是 A，
context 仍写 B 的「额度 1CNY / closing」。

**整改**：新增 `sampledCredentials` 旁路表 + `recordSampledCredential()`：

- identify 采样成功后登记**本次真正解析到**的凭据指纹（`shortHash(value)`）；
- `identityOfChannel` 写出 `cred=<指纹>`（未采样时 `unsampled`），与旧值可区分；
- 登记时若指纹变化，**推进 epoch + 清掉该渠道记录**，让 B 的数值/收尾规则立即失效。

这是「本次请求已经知道的事实」，不是现场再解密一次；表为空时也不会把旧来源当当前来源。

### 15.3 R4-03（P2）：设置卡片 DOM 仍是固定分组

`orderedPlanMetas` 只从 `PLANS` 建索引、排除了自定义 id；卡片循环画完内置后，
设置页仍**整块追加** `CustomBalancesSection`。于是 `planOrder` 写对了，卡片位置却没跨组。

**整改**：设置页改为按 `orderedIds()` **逐项渲染完整列表**：

| 项 | 做法 |
| --- | --- |
| 内置 id | `renderBuiltInCard(meta)`（原来循环体抽成函数） |
| 自定义 id | `CustomBalancesSection` 的**单条模式**（`onlyId`） |
| 页尾 | 只留「添加自定义余额渠道」入口与说明（`addOnly`，审核允许） |

顺带修掉三个连带缺陷（都是这次重构暴露出来的真实问题）：

1. **单条模式下 `entries` 被抓成单元素数组** → `move()` 重建数组时只得到一条，
   保存后把另一条**删掉了**。现在 `entries` 永远是完整列表，另用 `renderEntries` 决定渲染哪几条。
2. **`move()` 取错条目** → `index` 是 `renderEntries` 的下标（单条模式恒 0），
   直接拿它索引 `allEntries` 会移动第一条。现在先用 `renderEntries[index]` 取出被点的是谁。
3. **连续操作互相覆盖** → `reorderCustomEntries` 用渲染期闭包里的 `current` 构造新草稿，
   连续点两次时第二次的 `current` 还是上一帧快照。新增 `draftRef`（每次写入同步更新），
   排序一律基于最新草稿；`setDraft(null)` 的三处同时清空该 ref。

**内置渠道首尾箭头**（§4.2）：`disabled` 原来只看可写/保存状态，`movePlan` 到边界后默默 return。
现在按**全局位置**判定：列表首项禁用上移、末项禁用下移。

### 15.4 测试

`test-custom-round3.mjs` 增至 **20 项**，新增：

- **S6a/S6b**：同一引用下 A/B 两个值产生不同身份；未采样与已采样可区分
- **S7a/S7b/S7c**：观察器 `read(id)` 返回 `null`（这就是钩子失效的根因）、
  `read(id, 正确身份)` 能查到、`read(id, 错误身份)` 查不到（不跨身份读取）

`test-custom-order.mjs`（15 项）重写 O2 为「同一实例连续操作」，断言**相对前移**而非绝对下标；
`test-custom-render` R11a 按混排更新。

全量 **44 组 1484 项** + 行尾 66 + 几何 144 + 契约 7 = **1701 项**，0 失败（串行）。

新包 `513FD981CC5D28F859D0442653EF857CEF8C235CB7CFCFB51205B1C0F458D669`
（213 524 字节 / 27 文件，mismatch=0）。旧包 `E0D7AC4E…` 作废。已重装本机 profile。

### 15.5 仍未完成

- 真实账号/额度池、窗口口径、策略 UI、真实宿主注入/重试验收
- 审核指出：本轮未核正在运行的插件副本；不凭"已重装 profile"代替运行验收

## 16. 第五轮复核 + 新界面要求整改（2026-10-21）

[第五轮复核](recheck-custom-provider-v0.9.1-round5-20261020.md)：2 项 P1 + 1 项 P2 + 1 项 P3，
另有一组用户新增的界面要求。混排链路已通过，本轮**保留**它们。

### 16.1 R5-01（P1，数据破坏）：改/删第二张卡实际动了第一张

**根因**：设置页改成「每张卡片一个渲染实例」后，单条模式的渲染下标 `i` 恒为 0，
而它是 `renderEntries` 的下标。`update()` / `remove()` 直接拿它索引完整 `entries`：
**编辑第二张 = 改第一张**，删除同理。审核用真实 SettingsPage 复现了 6 个字段 + 删除。

**整改**：`update(entryId, …)` 与 `remove(entryId)` 一律按**稳定条目 id** 遍历定位，
不再用数组下标。7 处调用点（enabled/name/provider/balanceEndpoint/balancePath/
subtractPath/currency）与删除按钮全部改为传 `id`。

> 上一轮修 `move()` 时漏了同样错位的 `update`/`remove` —— 这是同一类缺陷的残留。

### 16.2 R5-02（P1）：只删元信息，旧数值投影还在

`recordSampledCredential` 上一版只 `channelMeta.delete`，而同步 context 还会独立读
`channelProjection` / `channelIdentity` → **元信息没了、旧的 B 数值还在**，照样能收尾。

**整改**：
- 对齐 `syncActivation` 的完整清理路径：`channelProjection` / `channelMeta` /
  `channelIdentity` 全部删除并推进 epoch（迟到结果被 commit 拒绝，**不重签新票**）。
- **GUI 采样也登记**：`fetchCustomBalance` 在 provider 分支上报
  `opts.onSampledCredential(id, 指纹)`，GUI 路由与工具 identify 接同一个
  `recordSampledCredential`。采样事实属于来源，与哪条入口采样无关。

### 16.3 R5-03（P2）：参数个数对了，身份域仍然错

工具缓存层传的 `identity` 是 `identifyChannels` 把**多渠道** `parts` join 出来的
**批次缓存身份**；`quotaObserver` 的槽位是每渠道各自的 16 位摘要。两者编码与粒度都不同，
透传必然查不到 → 钩子又恒为 false。

**整改**：钩子**不再采信**传入字符串，一律用 `identityOfChannel(id)` 计算 Host 逐渠道身份；
也不使用 `readAny` 跨身份绕读。传入值仅作为「有渠道上下文」的信号。

### 16.4 R5-04（P3）：内置首项上移被重复 `disabled` 覆盖

同一对象字面量写了两次 `disabled`，后者（`!writable || saving`）覆盖了含 `!builtInCanUp`
的正确条件 → 首项按钮仍启用但点了无操作。已删除重复属性，并补回丢失的 `title: '上移'`。

### 16.5 新界面要求（默认折叠 + 视觉一致）

| 要求 | 实现 |
| --- | --- |
| 已保存卡片**默认折叠** | `collapsed` 语义改为「已展开集合」：不在集合 = 折叠。首次进入/重建/重挂载都自然折叠 |
| 折叠/展开按**稳定 id** 保持 | 一直用 `collapsed[id]`，不按数组位置；排序、刷新、重渲染都不重置 |
| 新增条目自动展开**自己** | `addCustomEntry` 只把新 id 加进展开集合，不连带展开其它 |
| 折叠态保留名称/开关/排序/展开 | 名称行与箭头列始终渲染，只有编辑字段区收起 |
| 视觉与内置卡片一致 | `customCardStyle` 改为内置的 `settingsGroupStyle` 规范（上分隔线、无外框/圆角/底色） |
| 展开 ≠ 启用 | 纯展示状态，不改凭据/余额配置，不触发额外取数 |

### 16.6 测试

新增 `tools/test-custom-round5.mjs`（**13 项**）：D1 默认折叠、D2 展开只影响自己、
D3 双卡 6 字段互不影响、D4 删除只删目标、D5 内置首末项按钮禁用、D6 新增只展开自己。

**已验证能抓到 R5-01**：把 `update` 回退成按下标定位后 D3a 失败
（A 被改名成「乙改名」，与报告现象一致），恢复后通过。

同时更新 `test-custom-settings`（49）、`test-custom-race`（34）适配默认折叠语义。

全量 **45 组 1503 项** + 行尾 67 + 几何 144 + 契约 7 = **1721 项**，0 失败（串行）。

新包 `E78227190DD41FF586BE95F4536C0E0B0FA8F1AA2B7E3DA44E46B61FAFA88D74`
（215 048 字节 / 27 文件，mismatch=0）。旧包 `513FD981…` 作废。已重装本机 profile。

### 16.7 未实施：内置 WorkBuddy 迁移到 WorkBuddy2API 网关（§10）

用户已撤销「新增自定义卡片/积分格式选项」方案，改为替换内置国内 WorkBuddy 数据源
（[迁移说明](workbuddy2api-panel-credits-integration-20261021.md)）。

**本轮未实施，原因明确**：该文档 §4 指出 **`/status` 响应 JSON 结构尚缺**——
README 只说含积分，没给字段与合计口径。现有解析器认的是旧 Connect 的 `credits.total`
与套餐明细，不能假定网关相同。在拿到脱敏 `/status` 样本（或该版本公开源码的响应定义）之前，
**不猜字段**：猜错会把「累计发放/已用」当成「剩余」，直接显示错误积分。

需要的事实：剩余 vs 累计的口径、单账号与多账号池的合计方式、冷却/禁用账号是否计入、
缺值与真实 0 的区别。

可先做、且不依赖样本的部分（下一轮可直接接）：按宿主目录定位 `workbuddy` provider 的
当前有效来源、`new URL('/status', baseURL)` 取根路径、复用该来源的 Bearer Key、
仅对本机回环 HTTP 放行并限制在原 origin、来源/Key 变化后完整撤销投影（复用 16.2 的路径）。

### 16.8 其它仍未完成

- 真实账号/额度池、窗口口径、策略 UI、真实宿主注入/重试验证
- 审核口径：未核正在运行的插件副本，不凭"已重装 profile"代替运行验收

## 17. 内置 WorkBuddy 迁移到 WorkBuddy2API 网关（2026-10-21 实施）

用户已撤销「新增自定义卡片/积分格式选项」方案，改为**替换内置国内 WorkBuddy 的数据源**。
需求见[迁移说明](workbuddy2api-panel-credits-integration-20261021.md)。

### 17.1 协议事实：已实测确认（不再缺样本）

上一轮我以「`/status` 结构未知」为由未实施。本轮**直接向本机网关取到了真实响应**
（`wb2api-panel v1.13.0`，`:7863`），结构与口径如下：

```
{ total, healthy, cooling, disabled, in_flight_full, credit_floor,
  sticky_sessions, redis_mode, realm_totals:{cn:{...},global:{...}},
  cost_explore:{events_total, per_model},
  model_locks: null | {...},          // 无锁定时为 null
  accounts: [ { uid, nickname,
                credits,                  // ← 剩余积分
                credits_total,            // ← 累计额度（不是余额）
                credits_earliest_expiry, credits_earliest_remaining,
                cooling, until, realm, disabled,
                success_count, last_success, last_err, checkin_done,
                token_usage, model_costs, consecutive_fails,
                degrade_until, in_flight, breaker_fails, breaker_until } ] }
```

**三条关键口径（实测核对，不是推断）**：

1. `accounts[].credits` 是**剩余**；`credits_total` 是累计额度 —— 拿后者当余额会多报。
2. 顶层**没有**积分汇总字段（只有 `credit_floor` 这个下限配置）→ 合计必须自行按账号求和。
3. `realm` 区分 `cn` / `global`；本渠道**只取 `cn`**，不把国际池混进国内积分。

### 17.2 实现

`plans/workbuddy.js` 新增 `fetchFromGateway()`：

| 环节 | 做法 |
| --- | --- |
| 来源 | `providerSourceOf(ctx, 'workbuddy', { allowLoopbackHttp: true })` —— 走宿主公开目录 + **已组合**配置，不扫任意 providers、不做深合并 |
| 地址 | `new URL('/status', base.origin)` → `http://localhost:7863/status`（**根路径**，不是 `/v1/status`）；不写死端口，随模型配置变化 |
| 鉴权 | 复用该来源的 Bearer Key（`credentials.resolve(apiKeyEnv)`）；不读 auths、不抓浏览器存储、不试探其它 provider |
| 传输 | `redirect: 'error'` —— 凭据不随跳转离开所选 origin |
| 解析 | `creditsFromGatewayStatus(body, 'cn')`：只取 `accounts[].credits`，排除 `disabled`，冷却账号仍计入（积分还在） |
| 输出 | 映射回原有积分 wire（`creditsTotal` / `creditsAccounts` / `variants`），保留 ✦ 符号与详情结构 |

**回环 HTTP 例外是显式、最小化的**：`providerSourceOf` 新增可选 `allowLoopbackHttp`，
只有本网关传它，且主机必须是 `localhost`/`127.0.0.0/8`/`::1`。通用自定义渠道**不传**这个参数，
「只接受 https」的规则对它们完全不变。

**错误分类**（按审核要求不再乱翻译）：

- 401/403 → `auth` +「网关鉴权失败，请检查设置→模型中的 API Key」（**不**说"需重新登录 WorkBuddy 平台"）
- 404 → `api` +「网关没有 /status 端点，请确认版本」（**不**再说"未安装 Connect"）
- 429 / 5xx / 网络 / 结构 → 暂时失败，沿用既有有界降级
- 无来源 / 无 Key / 地址非法 → `not-configured` / `no-key` / `config`，给可操作提示且**零请求**

国际版 `workbuddyAi` **不动**，仍走旧的 Connect 端点。

### 17.3 顺带修正的错误码语义

`providerSourceOf` 里三个失败分支原来都报 `config`，现在区分开：

| 情况 | 错误码 | 含义 |
| --- | --- | --- |
| 宿主不提供模型目录 | `unavailable` | 能力问题（升级宿主） |
| 模型里没配这个 provider | `not-configured` | 用户补配置 |
| 配了但地址不合法/非回环 http | `config` | 用户改配置 |

### 17.4 测试

新增 `tools/test-workbuddy-gateway.mjs`（**32 项**）：G1 实测结构口径、G2 多账号池与域过滤、
G3 缺值 vs 真实 0、G4 回环白名单、G5 端到端（根路径/Bearer/不跟随重定向/wire 形状）、
G6 失败分类、G7 非回环 http 被拒、G8 来源缺失。

**既有测试的改动（都是产品行为真实变化，不是为过而改）**：

- `test-workbuddy`（27→26）：W1–W11 的 Connect 语义改由**国际版**承载。删掉 W2b
  （「国内版登录/国际版未登录互不影响」随国内版离开 Connect 而失去意义）。
- `test-android-compat`（14）：国内版不再 `not-installed`，改为 `unavailable`（无模型目录）；
  国际版仍 `not-installed`。断言标题同步改名。
- `test-workbuddy-contract`（7）：Connect 兼容性契约（真实移植包 status handler）改由**国际版**承载；新增 `fetchPlanAi` 同义导出。

全量 **46 组 1534 项** + 行尾 68 + 几何 144 + 契约 7 = **1753 项**，0 失败（串行）。

新包 `A8FC5FA8525549B61161F1F5BED9BBF9D62C08212A00D0D54ECDC912D776FCF5`
（218 873 字节 / 27 文件，mismatch=0）。旧包 `E7822719…` 作废。已重装本机 profile。

### 17.5 仍未验证 / 未实现

- **真实 DSH 运行时未验收**：本地测试用合成 ctx 与合成 transport；`providerSourceOf` 在真实
  宿主里能否按 `settingsPath` 命中 `workbuddy` 条目，需真机确认（这决定胶囊是否真的显示积分）。
- `model_locks`（限流视图）、`credits_earliest_remaining`（分段到期）本轮**只是读通结构，
  未展示**。用户描述里提到它们是可选信息，未要求进入胶囊/详情。
- 多账号池的**合计口径**现按「全部未停用的 cn 账号求和」；若用户希望排除冷却账号或按
  「可用/总数」分开展示，需要再确认。
- 真实账号/额度池证明、窗口口径、策略 UI、真实注入/重试仍为此前独立待验项。

## 18. 真机反馈整改 + WorkBuddy 增强（2026-10-21 下午）

用户真机反馈三件事：运行一段时间后胶囊与设置页不显示；要求去掉 WorkBuddy AI 渠道；
要求 WorkBuddy 卡片能选账号、详情能看到具体积分包与到期。

### 18.1 「跑一阵就不显示」：网关请求既无超时也未声明 identity

**根因判定**：`fetchFromGateway` 直接 `await fetch(...)`，有两个真实缺陷：

1. **没有超时**。网关一旦不响应，Host 整批取数被这一条拖住，路由迟迟不返回，
   胶囊就没有数据可渲染。重启后前几轮正常、跑一阵复发 —— 正是挂起型故障的特征。
2. **没有 `accept-encoding: identity`**。DSH 的 compress.js × gzip 中间件在
   「小响应体 + Content-Length」上会互相踩踏导致连接被 reset（0.8.2 在 Connect status
   上已经踩过一次）。本网关 `/status` 只有约 1.3 KB，正落在这个区间。

**整改**：新增 `fetchWithTimeout()` —— 12 秒硬超时（`AbortController` + `Promise.race`，
超时后主动 abort 释放连接），并显式声明 `accept-encoding: identity`。

> 诚实说明：这是**基于故障特征与既有踩坑的最可能原因**，不是我在真机上复现后确认的。
> 若重启后仍消失，需要 DSH 的运行时日志才能继续定位。

### 18.2 WorkBuddy AI 渠道退场

- `plans/index.js`：从 `PLANS` 移除 `workbuddyAi`，其 id 加入 `RETIRED_PLAN_IDS`
  （旧配置里的引用会被安全忽略，**不再取数、不再渲染**）。
- `client.js`：从 `PLANS` 注册表移除该卡片。
- 国际版模块与 `fetchPlanAi` 导出保留，仅作历史资料与 Connect 契约测试载体。

### 18.3 账号选择（只合计选中账号）

| 层 | 实现 |
| --- | --- |
| 配置 | 新字段 `workbuddyAccounts`（`z.string().default('[]')`，存选中的 uid 数组） |
| 解析 | `parseAccountSelection()`：空串/非法 JSON → 空数组（= 全部）；去重、忽略非字符串 |
| 筛选 | `creditsFromGatewayStatus(body, realm, selectedUids)`：非空时只统计选中账号 |
| 列表 | 新路由 `GET /api/plan-usage/workbuddy-accounts`（`listWorkbuddyAccounts()`，**不含凭据**） |
| UI | WorkBuddy 卡片内勾选框列表；**不勾任何账号 = 全部**（保持既有行为） |

**选了一个不存在的账号时不静默回退成全量**（G9e）—— 那会让用户以为筛掉了，实际没筛。

### 18.4 详情显示具体积分包与到期

明细在**另一个端点** `/panel/api/packages`（面板「积分构成」页的数据源）：

```
accounts[]: { uid, nickname, realm, remain, size,
              packages[]: { name, size, remain, used, expires_at(epoch ms), package_code, ... } }
```

- `creditPackagesOf(body, realm, selectedUids)` 纯函数：只输出 `packageName/remain/size/endTimeMs`，
  **不带** uid/nickname/package_code；已用完（`remain<=0`）的包不列；按到期升序。
- 映射进既有的 `creditsAccounts`，**复用现有详情渲染**（套餐明细行 + 到期），零客户端改动。
- 明细是**锦上添花**：`/panel/api/packages` 失败只退回合计一行，**不**把渠道判成失败。

**实测核对**（真实网关，2026-10-21）：9 个未用完积分包，明细剩余之和 5779 vs `/status`
合计 5782 —— 差 3 分是上游自身统计口径差异，**合计以 `/status` 为准**，明细只作展示。

### 18.5 测试

`test-workbuddy-gateway.mjs` 32 → **48 项**：新增 G9（账号选择：全部/单选/多选/不存在账号/
解析容错）、G10（积分包：过滤已用完、到期排序、缺到期、身份字段不外泄、按账号过滤），
G5 增加「明细请求打到 `/panel/api/packages`」。

**既有测试因产品行为变化而更新**（非为过而改）：
`test-settings`（文案改为「workbuddy 网关配置」、箭头改为点「WorkBuddy 上移」）、
`test-android-compat`（只剩一个 WorkBuddy 渠道）、`test-host-custom`（退场 4 个）、
`test-custom-settings`（内置渠道 6→5）。

全量 **46 组 1550 项** + 行尾 68 + 几何 144 + 契约 7 = **1769 项**，0 失败（串行）。

新包 `12807F0BEF83F23E5525700CD201598A281DA1C55D7F3EE9B11477258D3A69BB`
（224 152 字节 / 27 文件，mismatch=0）。旧包 `A8FC5FA8…` 作废。已重装本机 profile。

### 18.6 仍未验证

- 18.1 的超时修复**未经真机确认**；若仍复发需运行时日志。
- 真实 DSH 运行时里 `providerSourceOf` 能否命中 `workbuddy` 条目仍需真机确认。
- 账号选择的勾选状态存于配置，跨设备不同步；多账号池的「合计口径」仍为全部未停用账号之和。
- `model_locks`（限流视图）仍只读通结构、未展示。

### 18.7 真机构建问题：超时逻辑把成功响应也 abort 了

用户真机截图：WorkBuddy 卡片显示「读取网关账号失败：**This operation was aborted**」，
同时「没有可用账号」，胶囊也「获取失败」。**这是我在 18.1 引入的自造缺陷。**

**根因**：`fetchWithTimeout` 用 `Promise.race([request, timeout])` 做超时 ——
但 `fetch()` 的 Promise 在**响应头**到达时就 resolve，正文还没读。
`finally` 里无条件 `controller.abort()`，紧接着调用方 `response.json()` 读正文，
连接已被自己掐断 → 抛 `This operation was aborted`。

**整改**：改为 `fetchJsonWithTimeout()`：

- **正文读取放进超时窗口内**（在辅助函数里 `await response.json()`，
  而不是返回 response 让调用方在外面读）；
- **只有真的超时（`timedOut === true`）才 abort**，成功路径只 `clearTimeout`，不动 signal。

**回归守卫**：`test-workbuddy-gateway.mjs` 新增 G11（2 项），用**真实 abort 语义**模拟
「响应头已到、正文未读完」的窗口：`json()` 期间若 signal 已 abort 就 reject。
旧实现必失败、新实现通过 —— 已验证（回退 `if (timedOut)` → `if (true)` 后 G11a/G11b 双失败）。

> 教训记一笔：18.1 的超时是「凭故障特征推断」加的，加完只在**合成 transport** 上跑过，
> 而合成对象不尊重 `signal`，所以完全没测出这个必然的失败。**超时/取消类代码必须用
> 真实 abort 语义验证**，否则等于没测。

全量 **46 组 1552 项** + 行尾 68 + 几何 144 + 契约 7 = **1771 项**，0 失败（串行）。

### 18.8 真机第二轮：正文被读两次 + 设置页白屏

用户真机截图：WorkBuddy 仍是「网关响应不是合法 JSON」，**设置页整个白屏**。两个都是我引入的。

**① 正文被读两次（JSON 报错的原因）**

`fetchJsonWithTimeout` 已经 `await response.text()` 把正文读完，但 `fetchFromGateway`
里仍保留着旧的 `body = await response.json()`。流的 body 已被消费，第二次读必然抛错，
于是不管网关返回什么都是「不是合法 JSON」——**数据其实是好的**。

整改：直接用辅助函数返回的 `parsedBody`，并删掉第二次读取。同时把失败原因带出来
（`原因：…；返回内容开头：…`），以后同类问题在界面上就能直接看见。

**② 设置页白屏（`locked is not defined`）**

账号选择区块里写了 `cursor: locked ? …` 和 `disabled: locked` ——
`locked` 是 `CustomBalancesSection` 的**局部变量**，在设置页的 `renderBuiltInCard`
作用域里根本不存在。渲染时抛 `ReferenceError` → React 卸载整棵子树 → 白屏。

整改：

- 改用设置页自己的 `!writable || saving`；
- 整块包 `try/catch`，任何异常只降级成一行提示，**绝不再带崩整页**；
- `wbAccounts` 的字段做形状收敛（`accounts/message/loaded` 都先判类型再用）。

**③ 顺带修掉的两个隐患**

- `fetchJsonWithTimeout` 不再依赖 `response.ok` / `response.json()`：用 `status` 判定成功，
  用 `text()` + `JSON.parse` 解析。宿主/移植端的 fetch 包装未必提供标准 `ok`。
- `listWorkbuddyAccounts` 同样改用 `status` 判定，并在解析失败时带出原因。

**回归守卫（都已验证「先失败、后通过」）**

| 用例 | 抓的问题 |
| --- | --- |
| G11（2 项） | 成功路径被自己的超时 abort（上一轮） |
| G12（1 项） | **正文只能消费一次**：mock 第二次读直接抛，旧实现必失败 |
| D7（5 项） | **设置页白屏**：WorkBuddy 启用时页面、账号区块、复选框都要在 |

我还用**真实网关**做了一次端到端（读本机 `config.json` 的 key，不打印值）：

```
error = undefined
creditsTotal = 5765 | 明细条数 = 9
  CodeBuddy个人版国内运营裂变包  剩余264/500  到期 2026-11-17
  ...
账号列表 = 1  Slacom(5765)
```

这是本轮唯一一次「真实上游 + 真实解析」的验证，但它仍**不是** DSH 运行时验证
（ctx 是合成的）。

全量 **46 组 1558 项** + 行尾 68 + 几何 144 + 契约 7 = **1777 项**，0 失败（串行）。

## 19. 状态汇总与构建级缺陷索引（2026-10-21 收口）

本节把 0.9.1 周期的修复收口成一张可审核的总表，并单列**构建级缺陷**——
那些不属于需求变更、而是我自己实现错误、被真机或回归抓出来的问题。
面向审核的完整版见 [0.9.1 当前状态](status-0.9.1-20261021.md)。

### 19.1 最终交付物

| 项目 | 值 |
| --- | --- |
| 包 | `legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz` |
| SHA-256 | `12807F0BEF83F23E5525700CD201598A281DA1C55D7F3EE9B11477258D3A69BB` |
| 大小 / 文件数 | 224 152 字节 / 27 |
| 打包一致性 | 逐 payload 比对 mismatch = 0 |
| 安装一致性 | profile 副本逐文件 SHA-256 比对 mismatch = 0 |
| 版本号 | 仍为 0.9.0（**未** commit / 打标签 / push / 发布） |

**全量：46 组 1558 项 + 行尾 68 + 几何 144 + 契约 7 = 1777 项，0 失败**（逐文件串行）。

> 本文件前面各节里的 1701 / 1721 / 1753 / 1769 / 1771 都是**当轮**的数字，
> 保留以反映演进过程；最终数字以本节 1777 为准。

### 19.2 五轮复核报告对应关系

| 报告 | 本节之前的位置 | 主要结论 |
| --- | --- | --- |
| 排序专项 `review-custom-order-20261020.md` | §14 | 全局混排（用户已确认覆盖旧的「固定在内置之后」） |
| 第三轮 `…round3-20261020.md` | §14 | 来源复活 / 来源变更身份 / 工具旧缓存 |
| 第四轮 `…round4-20261020.md` | §15 | 观察器接口签名 / Key 轮换投影 / 卡片 DOM 分组 |
| 第五轮 `…round5-20261020.md` | §16 | 双卡误写误删（P1）/ 投影残留 / 身份域 / 重复 disabled |
| 第五轮 §10 + 迁移说明 | §17 | 内置 WorkBuddy 改走 WorkBuddy2API 网关 |
| 用户真机反馈（三轮） | §18.1–18.8 | 超时/identity、去 WorkBuddy AI、账号选择、积分包、三个构建级缺陷 |

### 19.3 构建级缺陷总表（本轮新增，全部已修并有守卫）

| # | 缺陷 | 真机/回归表现 | 守卫 |
| --- | --- | --- | --- |
| B1 | `client.js` 被写成 CRLF | `test-android-compat` 切片失效 | `test-line-endings`（68） |
| B2 | 路由用了不存在的 `ctx.webServer.route` | 17 组连锁崩 | apply 即暴露 |
| B3 | `isCustomId` 未定义（实为 `looksCustomId`） | 渲染 `ReferenceError` | `test-custom-settings` |
| B4 | 单条模式 `entries` 被抓成单元素数组 | `move()` 重建数组**丢条目** | `test-custom-order` O1d |
| B5 | `move()` 用渲染下标索引完整列表 | 点「甲」移动了「乙」 | `test-custom-order` |
| B6 | `reorderCustomEntries` 用渲染期闭包 `current` | 连点两次互相覆盖 | 新增 `draftRef` |
| B7 | 内置箭头重复 `disabled` 属性 | 首项启用但无操作 | `test-custom-round5` D5 |
| B8 | 观察器 `read(id)` 少传 identity | 钩子恒 false | `test-custom-round3` S7 |
| B9 | 失败钩子传「批次缓存身份」 | 身份域不同查不到 | `isSourceFailed` 自算 |
| B10 | 网关请求 `finally` 无条件 `abort()` | 成功响应被掐断 | G11（2 项） |
| B11 | 正文被读两次（`text()` 后又 `json()`） | 永远「不是合法 JSON」 | G12（1 项） |
| B12 | 设置页用 `locked`（另一组件局部变量） | **整页白屏** | D7（5 项） |

**B10–B12 的共同教训**：都只在**合成对象**上测过。合成 transport 不尊重 `signal`、
允许多次读 body、变量作用域要到运行时才炸 —— 三次都是真机先发现的。
因此从 B11 起改为「先回退验证测试会红，再修」，且 WorkBuddy 增加了一次
**真实网关 HTTP + 真实解析**的端到端（`error=undefined`、`creditsTotal=5765`、
明细 9 条带到期、账号列表 1 个）。

### 19.4 明确未验收的部分

- **真实 DSH 运行时**：所有 plan 取数测试的 `ctx` 都是合成的；
  `providerSourceOf` 能否在真实宿主按 `settingsPath` 命中 `workbuddy` 条目，
  只有真机重启后能确认。
- **「跑一阵就不显示」**：18.1 的超时修复未经真机确认，且前两次都被 B10/B11 掩盖。
- 真实账号/额度池、窗口口径、策略 UI、真实注入与重试、Android 真机。
- `model_locks`（限流视图）与 `credits_earliest_remaining`（分段到期）只读通结构，未进 UI。
- 多账号合计口径现为「全部未停用账号之和」；积分包明细与 `/status` 合计有 3 分差异
  （上游自身口径），合计以 `/status` 为准。

## 20. 第六轮复核整改（2026-10-21 收口）

[第六轮报告](recheck-v0.9.1-round6-20261021.md)：2 项 P1、2 项 P2、1 项 P3。
报告同时确认前几轮的 UI、双卡、混排、正文流、设置页作用域**已关闭**。

### 20.1 R6-01（P1）：同一把 Key 被两种指纹编码当成两个来源

identify 用**无盐** SHA256 前 16 位，GUI 采样用 `credentialFingerprint()`（**带盐**前 12 位），
两者写进同一张 `sampledCredentials` 表 → **同一把真实 Key 也必然"换源"**。
换源又触发完整清理，于是把正确的失败封存和本次票据一起删掉：

- 工具成功 → GUI 同 Key 401 → 工具再调：**失败记录在查询前已被别的代码删掉**；
- GUI 首次取到 1，却因为采样回调推进 epoch 而**自己拒掉自己的合法结果**。

**整改（三步）**：

1. **只有一套指纹规范**：identify 改为 `credentialFingerprint(resolved.value)`，
   与 GUI 采样、`generationOf()` 完全同源。
2. **首次采样不失效**：`recordSampledCredential` 增加 `if (prev === undefined) return`。
   「从不知道到知道」不是来源变化，此时没有任何旧投影需要被否定，而这次采样本就属于
   正在进行的那次采集。只有「已知 A → 已知 B」才完整撤销 + 推进 epoch。
3. **凭据指纹退出观察身份**：`cred=` 不再进入 `identityOfChannel`。
   它在 `begin()` 之后才可能采到，放进去会让每次首次采集都自废票据
   （记录还会落在旧身份槽位里，界面变「暂无数据」）。凭据轮换仍由第 2 步的
   「A → B」分支撤销投影与在途票据，语义不变。

### 20.2 R6-02（P1）：内置 WorkBuddy 的来源与账号选择没进观察身份

内置分支只拼了开关与 `plan.fields` 里的 Key/Cookie，而 WorkBuddy 的 Key 来自**模型配置**，
账号选择是新字段 —— 三者都不在身份里。于是换账号、换模型主机/引用、甚至删掉 provider，
epoch 都不推进，继续用旧积分收尾。

**整改**：`id === 'workbuddy'` 时追加两项（均为不可逆摘要）：

- `src=` 真实有效模型来源（origin + baseURL + 引用名，复用 `providerSourceFingerprint`）；
- `acct=` 规范化账号选择（排序后摘要，顺序无关、换组必变、**不输出 uid**）。

实现提取为 `plans/workbuddy.js` 的 `selectedAccountsFingerprint()` 纯函数，
Host 直接 import —— **只有一份实现**，避免两边规则漂移。

### 20.3 R6-03（P2）：可选明细吃掉 8 秒工具预算

`/status` 成功后还要等 `/panel/api/packages`，而两者各自 12 秒；工具整体只有 8 秒。
明细一挂住，**已经成功的合计也被判成 missing**（审核实测 8010ms 返回空列表）。

**整改**：

- 明细改用**独立短超时** `GATEWAY_PACKAGES_TIMEOUT_MS = 2500`；
- 新增 `remainingOf()/capTimeout()`：把调用方（工具）的**剩余预算**贯穿到
  凭据解析、`/status`、明细三处，每步都取 `min(自身超时, 剩余 - 250ms)`；
- 凭据解析原先在网络计时器之外，现在用 `raceWithTimeout()` 一并纳入；
- 明细失败/超时只退回「按账号汇总」一行，**合计照常交付**。

### 20.4 R6-04（P2）：解析错误把上游正文回显给 GUI

上一版把正文前 120 字（`preview`）和 `JSON.parse` 的原始 message 拼进公开 `wire.message`。
解析器 message 自身也可能回显正文，只删 preview 不够。

**整改**：只返回**固定分类 + HTTP 状态**：
`网关状态响应无法解析（HTTP 200，shape=invalid-json）`。不含正文、不含解析器原文。

### 20.5 R6-05（P3）：`response.ok` 兼容分支没贯穿调用者

`fetchFromGateway` 与明细仍直接 `if (!response.ok)`，而包装 fetch 可能只有 `status`。
合成 Response（只有 `status:200` + `text`）会得到「网关返回 HTTP 200」这一自相矛盾的结果。

**整改**：两处都改为归一化判定 —— `typeof response.ok === 'boolean' ? response.ok : status 2xx`。

### 20.6 测试

新增 `tools/test-workbuddy-round6.mjs`（**29 项**）：

| 组 | 覆盖 |
| --- | --- |
| R6-01 | 指纹长度/稳定性/空值标记/确认走带盐规范；源码契约：identify 与 GUI 同函数、首次采样早退、`cred=` 不进身份 |
| R6-02 | 账号指纹顺序无关、换组必变、去重、不泄漏 uid；不同主机各自解析；删 provider 后不再取数 |
| R6-03 | 明细挂住时合计仍交付、状态只取一次、6 秒内返回、退回账号汇总 |
| R6-04 | 消息不含哨兵/「返回内容开头」/解析器原文，仍带固定分类码 |
| R6-05 | 只有 `status+text` 的包装 Response 也能成功 |

**已验证「先失败、后通过」**：把明细超时改回 12 秒 → R6-03c 失败（12012ms）；
错误消息加回正文 → R6-04c 失败；`okFlag` 改回 `response.ok` → R6-05a 失败
（且复现了审核看到的「网关返回 HTTP 200」）。恢复后 29 项全通过。

全量 **47 组 1587 项** + 行尾 69 + 几何 144 + 契约 7 = **1807 项**，0 失败（串行）。

新包 `DD84A00133B9DBB4F02E5936AF51C86CE8F2C47C4B9E6DB3ACE94012E4B68CD2`
（226 595 字节 / 27 文件，mismatch=0）。旧包 `12807F0B…` 作废。已重装本机 profile。

真实网关复验（读本机 config 的 key，不打印）：`error=undefined`、`creditsTotal=5754`、
明细 9 条带到期、账号列表 1 个 `Slacom(5754)`。

### 20.7 仍未验证

- 真实 DSH 运行时（所有 ctx 仍是合成的）；「跑一阵不显示」仍未经真机确认。
- 真实账号池每次计费、窗口口径、策略 UI、真实提示词注入与重试、Android 真机。
- 多账号合计口径仍为「全部未停用账号之和」；积分包明细与 `/status` 合计存在上游自身差额。

## 21. 第七轮复核整改 + 新网关适配（2026-10-21 收口）

[第七轮报告](recheck-v0.9.1-round7-20261021.md)：上一轮两个 P1 未复现，剩 3 项 P2。
用户同时把 WorkBuddy 反代换到另一台主机（`/status` 可用、`/panel/api/packages` 404）。

### 21.1 R7-01（P2）：已知 Key A→B 时本次新采样被自己的旧票拒绝

R6-01 修好的是「同 Key」与「冷启动首次采样」；**已知 A→B** 是另一条路径：
票据在采集前签发、捕获旧 epoch，采样发现凭据变化 → 推进 epoch → 本次刚取到的 B 被旧票拒绝，
界面「暂无数据」，要等下一次采集才恢复。

**整改**：新增 `latestTicketOf`（每个渠道**最近一次**签发的在途票据）。
凭据变化推进 epoch 后，把这张票的 `epoch` 提升到新代次，让它合法提交。

- 只提升**最新一张**：更早的票据（可能是迟到的旧 A）保持旧 epoch，仍被拒绝；
- 仍在采样环节完成，**不是**在提交时重签票，也没有放宽 epoch 检查。

### 21.2 R7-02（P2）：账号列表 / 设置路由仍回显解析器原文

R6-04 只收紧了主取数 wire。`listWorkbuddyAccounts` 仍把 `JSON.parse` 的 message 拼进
`message`，而解析器原文会带正文片段（`Unexpected token 'S', "SYNTHETIC_"...`）。
该函数由 `/api/plan-usage/workbuddy-accounts` 直接暴露给 GUI。

**整改**：与主 wire 同规范 —— 只回 `账号响应无法解析（HTTP 200，shape=invalid-json）`，
不拼 parser 原文、不回正文。

### 21.3 R7-03（P2）：预算耗尽后仍发 HTTP，私有任务重获 8 秒

三个具体缺口：

1. `capTimeout` 下限写死 300ms —— 剩余为 0 甚至负数时仍被放大，继续外发；
2. 进入 `/status`、`/packages` 前没有耗尽守卫；
3. `usage-tool-register` 的 `taskFor` 给新任务开**整份 8 秒**，
   与调用者已消耗的 identify 时间无关（实测：剩余 7333ms，任务却拿到 7997ms）。

**整改**：

- `capTimeout`：剩余 ≤ 0 返回 **0**；否则 `max(1, min(want, left - 50))`，不再抬高；
- 新增 `exhaustedResult()`：入口、凭据解析返回后各检查一次，耗尽即**零请求**返回；
- 明细：预算 ≤ 0 直接跳过（合计已拿到）；
- `taskFor(key, ids, snapshot, callerRemaining)`：新任务预算 = `min(budgetMs, callerRemaining)`；
  `<= 0` 时直接完成、零请求。共享任务仍保留自己的生命周期（已存在的任务不被新调用者缩短）。

### 21.4 用户新网关：明细端点不可用

反代换主机后：`/status` 200（401 无凭据），**`/panel/api/packages` 404**。
即该反代没有暴露面板接口，**积分包明细无法读取**（用户已确认）。

**适配**：

- 明细 404 **不影响合计**：退回「按账号汇总」一行，详情不为空，也不把渠道判成失败；
- 新增**能力记忆** `packagesUnsupportedUntil`：同一 origin 记住「不提供明细」10 分钟，
  避免每 30 秒白打一次 404；对方后续若补上接口，10 分钟后自动恢复。

### 21.5 测试

新增 `tools/test-workbuddy-round7.mjs`（**16 项**）：

| 组 | 覆盖 |
| --- | --- |
| R7-02 | 账号列表 malformed 响应不含哨兵/解析器原文，仍带固定分类 |
| R7-03 | `remaining=0` / 负剩余 → **零 HTTP** 且给可辨的「未取」结果；剩余紧张时合计仍交付 |
| 新网关 | 明细 404 时合计照常交付、退回账号汇总、不判整条失败 |
| R7-01 | 源码契约：票据登记 ≥4 处、凭据变化时提升最新票、只提升一张 |

**已验证「先失败、后通过」**：回退账号列表消息 → R7-02c 失败（`Unexpected token 'S', "SYNTHETIC_"`）；
回退 `capTimeout` 的 0 → R7-03a/b/c 失败（status+packages 各发一次）；
去掉票据提升 → R7-01a/c 失败。恢复后 16 项全通过。

全量 **48 组 1603 项** + 行尾 70 + 几何 144 + 契约 7 = **1824 项**，0 失败（串行）。

新包 `B87F36F61973D29F20B98648F7900D2A99EFFECA2EC645DAA00E08864A813E3C`
（228 320 字节 / 27 文件，mismatch=0）。旧包 `DD84A001…` 作废。已重装本机 profile。

### 21.6 仍未验证

- 真实 DSH 运行时（ctx 合成）；长时稳定性与真实源/账号切换仍需观察。
- 真实账号池每次计费、窗口口径、策略 UI、真实提示词注入与重试、Android 真机。
- **积分包明细在新网关下不可用**（404），属上游能力缺失，不是插件缺陷；
  换回带面板接口的网关会自动恢复（10 分钟内生效）。

## 22. 第八轮复核整改（2026-10-21 收口）

[第八轮报告](recheck-v0.9.1-round8-20261021.md)：1 项 P1 并发回归 + 1 项 P2 取消残留。

### 22.1 R8-01（P1）：最新票据提升复活了旧请求

R7-01 的修法是「凭据一变，就把该渠道**最近签发**的那张票提升到新代次」。
它只证明了「不循环提升全部」，**没有证明这张票属于本次采样**。

审核用可控门闩复现：工具用 B 成功（写缓存）→ GUI 读 A 并发起 HTTP 挂起 →
凭据回 B、工具 identify 命中缓存（**没有新的取数票**）→ 解锁旧 A → **context 被改成 A=1**。
原因是 identify 的采样回调按渠道 id 取到了那张挂起的旧 A 票并给它升了代。

**整改（票据归属）**：

- `recordSampledCredential(id, fingerprint, ticket)` 必须由调用方传**本次操作自己的票据**；
- 规则抽成纯函数 `promoteOwnTicket(pending, ticket, nextEpoch)`：
  只有「传了票」且「它仍是该渠道当前待提交票」时才提升；
- **工具 identify / 成功缓存命中没有取数票 → 什么都不提升**，旧挂起请求保持旧 epoch，
  返回时被 `commit` 拒绝；
- 删除全局 `latestTicketOf`，统一用已有的 `pendingTickets`（逐渠道当前票）；
- GUI 自定义采集的回调改为 `(id, fp) => recordSampledCredential(id, fp, customTicketsFor.get(id))`，
  工具采集同理传 `customTickets.get(id)`。

> 顺带修掉一个由本轮行级编辑引入的**自造回归**：`onlyIds: allowedCustom` 被覆盖掉，
> 导致工具请求 A 时把 B 的凭据也解析了。`test-usage-tool-host` 的 E4b 当场抓住，已恢复。

### 22.2 R8-02（P2）：父 signal 已取消仍发 HTTP

`fetchFromGateway` 只检查 `remaining`，不看 `options.signal`；`fetchJsonWithTimeout`
自建 controller 也不组合父 signal。于是「已经 abort、但剩余时间还是正数」时会照常外发。

**整改**：

- 入口、凭据返回后、明细前各检查一次父 signal；已取消 → **零请求**；
- `fetchJsonWithTimeout(url, key, timeoutMs, parentSignal)`：入口先判 aborted，
  并 `addEventListener('abort')` 把父取消转发给子 controller（含正文读取），
  `finally` 里解绑；
- 返回 `error: 'cancelled'`、`transient: false`、`stale: true` ——
  **归 C、不计 T 失败**，客户端据此跳过「获取失败」红字、保留上一份数据。

### 22.3 测试

新增 `tools/test-workbuddy-round8.mjs`（**14 项**）：用**真实观察器**验证票据归属
（无票不提升 / 有归属票可提交 / 非当前票不提升），用合成 transport 验证取消
（已取消零请求 / 在途取消 / 正控制不误伤）。

**已验证「先失败、后通过」**：把 `promoteOwnTicket` 回退成「只要渠道有待提交票就提升」后，
R8-01b / R8-01c / R8-01h 三项失败，且 R8-01c 的失败明细正是「旧 A 的记录被写入」——
与审核描述的现象一致。

同时**删除了 R7 的静态形状断言**（它把危险实现写成了绿灯契约），把该场景改由上述行为回归覆盖。

全量 **49 组 1614 项** + 行尾 71 + 几何 144 + 契约 7 = **1836 项**，0 失败（串行，连跑两轮一致）。

新包 `B5A79B2B5FBED8302D4EC6FC2FAB244DB7B5B2FDBBD6D4D7D0E1AA06ED96E62E`
（229 455 字节 / 27 文件，mismatch=0）。旧包 `B87F36F6…` 作废。已重装本机 profile。

### 22.4 交付前自检

- 语法：`index.js` / `client.js` / `plans/workbuddy.js` / `plans/quota-observer.js` 全部通过；
- 打包一致性：27 文件逐 payload 比对 mismatch=0；安装副本逐文件 SHA-256 mismatch=0；
- 行尾守卫：71 项通过（本轮曾因 `Set-Content` 把 index.js 写成 CRLF，已归一并复验）；
- 敏感回显复查：`plans/*.js` 与 `index.js` 中已无把 `parseError.message` / preview 拼进公开消息的代码；
- 真实网关冒烟：`GET /status` 返回 401（无 Key，符合预期），未读取/打印凭据。

### 22.5 仍未验证

- 真实 DSH 运行时（ctx 合成）；长时稳定性与真实源/账号切换仍需观察。
- 真实账号池每次计费、窗口口径、策略 UI、真实提示词注入与重试、Android 真机。
- 积分包明细在用户当前网关下不可用（`/panel/api/packages` 404），属上游能力缺失。

## 23. 第九轮复核整改：操作归属 / 正文取消 / 公开异常（2026-10-21 收口）

[第九轮报告](recheck-v0.9.1-round9-20261021.md)按[冻结十条](closure-audit-custom-and-quota-20261021.md)验收。
本轮不再按单号补洞，而是把 A/B/C 三个根因在共享基础设施上一次处理。

### 23.1 根因 A（P1）：迟到的凭据解析能重新激活旧源

审核用门闩复现两例（都无时间猜测）：

- 旧 GUI A 的 `credentials.resolve` 挂起 → 工具 B 真正提交 9000 → 释放 A → **context 变 1/closing**；
- 旧工具 A 的 identify 解析挂起 → GUI B 提交 9000 → 旧 A 返回 → **context 变 1/closing**。

根因不是票据对象，而是**操作归属缺失**：

1. 采样回调无条件先写 fingerprints、再推进 epoch、清投影 —— 旧回调即使不能提升票，**仍能清掉新的 B 事实**；
2. 工具 collect 只登记本地 `customTickets`，没更新全局 `pendingTickets`，于是 pending 仍指向旧 GUI 票；
3. identify 的异步凭据解析没有入场序号，旧 identify 晚返回后还能派发。

**整改：统一的「操作序号」协议**

| 机制 | 实现 |
| --- | --- |
| 领号 | `beginOp(id)`：每个入口在**任何异步 I/O 之前**领一个单调序号 |
| 校验 | `isCurrentOp(id, seq)`：序号仍是该渠道最新才算当前操作 |
| 采样前置守卫 | `recordSampledCredential(id, fp, ticket, opSeq)` 首行 `if (!isCurrentOp(id, opSeq)) return` —— **过时操作不写指纹、不推进 epoch、不清投影、不授权票** |
| identify | 为自定义与内置渠道都领号，并写进 `snapshot.opSeqs` 随快照返回 |
| collect | `staleSnapshot(id)` 为真则**不签票、不派发**（挡住旧 identify 晚签票） |
| 工具 collect | 登记 `pendingTickets`，与 GUI 共用同一张表 |
| GUI 采样回调 | 携带自己的票据**与序号**：`recordSampledCredential(id, fp, tickets.get(id), opSeqs.get(id))` |

保留已通过的行为：串行 A→B 首样本可提交、原「B 缓存预热 + 挂起 A」反例、成功缓存与新结果序号拒旧 A。
**没有**关闭缓存、没有重复查余额、没有在完成时重签票、没有放宽 epoch。

### 23.2 根因 B（P2）：主状态正文取消被吞成 T

`response.text()` 的 AbortError 被塞进 `parseError` 后正常返回，绕过取消分支，
最终按 `invalid-json` 归类成 `exec` + `transient: true`。

**整改**（双保险）：

- 正文读取的 catch 里若父 signal 已 abort → 抛 `ECANCELLED`；
- `await fetchJsonWithTimeout` 返回后**再查一次** `cancelled()` → 直接返回取消结果。

取消结果 `error:'cancelled'` + `transient:false` + `stale:true`，不计 T、不显示为失败。

### 23.3 根因 C（P2）：公开异常出口回显 exception 原文

账号列表与主 wire 的 catch 仍把 `err.message` 拼进公开 message；Node 原生 Headers
对非法头字符的报错**会把输入值带进消息**，于是合成 Key 可经公开路由回显。

**整改**：新增 `transportCodeOf(err)`，所有公开错误 DTO 只给固定分类
（`transport` / `timeout` / `cancelled`），**不透传任何 exception 原文**。
覆盖三处：主 wire、`listWorkbuddyAccounts`、plan 外层兜底 catch。

### 23.4 测试

新增 `tools/test-workbuddy-round9.mjs`（**16 项**）：

| 组 | 覆盖 |
| --- | --- |
| R9-02 | 正文阶段取消 → `cancelled` / `transient:false` / 无 `invalid-json` / `stale:true` |
| R9-03 | 主 wire、账号列表、外层兜底三个出口都不含合成 Key 与 `Invalid header` 原文，仍带 `transport` 分类 |
| R9-01 | 源码契约：`beginOp`/`isCurrentOp` 存在、采样前置守卫、identify 双入口领号、collect 拒绝过时快照、工具登记全局 pending、GUI 回调带票+序号、旧 `latestTicketOf` 已移除 |

**已验证「先失败、后通过」**：回退 C 的三处拼接后 R9-03a…e **5 项失败**，失败明细正是
`Invalid header value: SYNTHETIC_KEY_WITH\nNEWLINE_abcdef` —— 与审核描述的回显路径一致。

全量 **50 组 1630 项** + 行尾 72 + 几何 144 + 契约 7 = **1853 项**，0 失败（串行）。

新包 `35E946D0394435D5C722E76A09498305FCF4A7AF6B9529B10C3D35D66A07912F`
（231 088 字节 / 27 文件，mismatch=0）。旧包 `B5A79B2B…` 作废。已重装本机 profile。

### 23.5 仍未验证

- 根因 A 的三条交错时序：本轮以**源码契约 + 单点行为**覆盖，尚未在真实 apply 下重建
  「旧 resolve 挂起 → 新 B 提交 → 释放旧 A」的完整门闩矩阵（审核用的是该方法）。
- 真实 DSH 运行时（ctx 合成）、长时稳定性、真实账号池计费、窗口口径、策略 UI、Android 真机。
- 新网关不提供 `/panel/api/packages`（404），明细不可用属上游能力缺失。

## 24. 用户授权直接修复A并完成本地收口（2026-10-22）

完整交付与边界见[操作归属修复记录](fix-custom-operation-v0.9.1-20261022.md)。原§23的静态合同未覆盖真实调用接线，本轮没有继续逐例打补丁：

- 实际使用dispatchIds缩小取数集合，空集合不启动请求；无归属wire不允许完成时补票。
- 工具适配器不仅转发冻结credentials，还转发内部opSeqs/sourceEpochs；原来缺字段被默认放行掩盖，现拒绝缺归属。
- 通用取数贯穿操作守卫，凭据迟到、连接前、正文返回均可撤销；采样回调拒绝即返回无数字C。
- GUI不再透传已拒旧成功wire：整份采用当前有效公开观察，gen和采样时间也同源；无当前值则明确无数字，不伪装成ok/旧1。
- 入场序号与来源/观察确认分开，不因同源并发识别相互取消；epoch约束使ABA回切不能恢复旧票。未加长预算、未关闭成功缓存、未重复查余额。

新增正式12个真实apply门闩行为场景：旧35E946独立归档运行原10项为4通过/6失败，最终新12项全通过。修正旧round2/3中各一条“迟到GUI仍应返回1”的不安全测试合同为当前9000，其余断言保留；未靠删断言过审。

最终全量：54脚本，51普通组1642项（含12行为场景）＋行尾75＋几何144＋契约7＝1868，全部exit0、0跳过。B/C及网关正控制35项、收口链22项与原生HTTP也保持通过，不重复相加。一次安全组37/37之后的Node原生退出及无改动复跑通过均在完整记录中保留，不隐藏非零退出。

新包SHA256 `92DC823AE5ADC8A7CBDC394A6894A02175EE9D7F949C277901C43F3484D00D68`，232905字节/27文件，payload mismatch=0；仅index、custom-balance、usage-tool-register三个生产文件变化。旧归档未覆盖。[本地包](../legacy/local-build-0.9.0/operation-fix-20261022/dsh-usage-dock-0.9.0.tgz)。

**本轮未部署、未重启、未改真实配置、未读真实凭据、未提交/推送/发布。**冻结自定义A/B/C的本地工程修复至此收口，进入用户试装；真实Host策略注入/重试、策略UI、池/窗口口径与Android仍独立未验或未完，不能冒充通过。
