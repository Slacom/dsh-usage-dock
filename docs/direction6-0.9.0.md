# 方向 6 实施记录：`usage_status` 只读模型工具（0.9.0）

> 日期：2026-10-18（D6-A～D6-H 整改后重写）。用户已授权实施方向 6（T0–T4），
> 但**未**授权部署当前 profile、重启、提交或发布。
> 本文只记录**已实现并有证据**的部分；未经独立复核不写「已验收」。

## 1. 整改对照（D6-A～D6-H）

| 编号 | 问题 | 处理 | 证据 |
| --- | --- | --- | --- |
| D6-A | 只查 A 也会解析 B 的凭据并发请求 | `fetchCustomPlans` 新增 `onlyIds`，在**任何**凭据解析/DNS/请求之前缩小条目；工具层同样先筛后取 | `E3a–f`：只解析 `ref-A`，`ref-B` 从未出现；空集合零解析 |
| D6-B | 缓存不按实际账户/凭据隔离 | 缓存键改为 `id + 配置代次 + 凭据身份`；身份 = 渠道密钥/引用解析值的 Host 内部短哈希；**账号/会话型渠道（deepseek/codex/workbuddy/workbuddy-ai）完全不缓存** | `R9a–h`：身份变化即重取；非 cacheable 渠道每次重取；停用后不读缓存 |
| D6-C | 真实 provider 语义投影错误 | OpenCode `usagePercent` 按**已用**→剩余换算；Codex 保持 remaining；WorkBuddy 读 `creditsTotal`；DeepSeek 带回实际币种；越界不钳位；停用/不存在/缺失/缺凭据/退场各自可辨 | `I1a–j`、`I2a–c`、`I4a–h`、`I5a–e`、`P7a–h`（真实 provider 集成） |
| D6-D | 错误被缓存、`fetchedAt` 恒为空 | 只缓存 `availability ∈ {ok, unlimited}` 的渠道；失败/未知不缓存、可立即重试；成功采集时写 `fetchedAt`，命中缓存不刷新 | `R7a–f`、`R8a–f` |
| D6-E | 8 秒不覆盖 describe、忽略 `exec.signal`、慢渠道抹掉快渠道 | deadline 从 `execute` 入口创建并贯穿 describe/identify/取数；组合调用方 signal；`onChannel` 逐渠道回传已完成结果；所有调用方离开即 abort 底层 | `R4a–e`、`R5a–e`、`R6a–b`、`E7a–c` |
| D6-F | 时间字段可透传上游自由文本 | `resetsAt` 只接受可解析的日期时间并规范化，`resetInSec` 校验区间；非法一律 `null` | `P4a–o`、`P10f–j` |
| D6-G | 策略只有死路径纯函数 | 策略文本进入**工具结果 `policy` 字段与 render**；另注册宿主公开 `systemPrompt.section`，配置变化重建、卸载清理；缺服务静默跳过 | `R10a–f`、`E8a–g`、`S7a–j` |
| D6-H | 未配置阈值被擅自补 20% | 两个阈值默认 **0 = 未配置**；`policyOf` 要求显式有效值，金额判据还必须绑定币种；积分永不与金额比较 | `S1d–f`、`S2a–q`、`S3e–l`、`S4d–i` |

## 2. T0 — 宿主 tools 契约（重新核验，未沿用补证推断）

从 `D:\DeepSeek Harness\resources\app.asar` 直接提取 `@deepseek-ai/dsh-tools` 与
`@deepseek-ai/dsh-system-prompt` 的真实实现逐条核对：

- `ctx.tools.register(def)` 返回**精确 disposer**；
- def 形状 `{name, description, parameters, output:{schema, render}, execute(args, exec)}`；
- `execute` 返回值必须是 **lossless JSON 且符合 `output.schema`**（否则 `INVALID_TOOL_OUTPUT`）；
- schema 只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解；
- `run_code` 是保留名；
- `systemPrompt.section({name, order, text})` / `.context(...)` 是**公开接口**，返回 disposer，
  无需改宿主（D6-G 中「必须改宿主」的说法不成立）。

据此**不 import** 宿主包，按契约手写定义；测试用假 tools 服务按同一套规则校验。

## 3. T1 — 白名单投影与真实语义

`plans/usage-tool.js`（纯函数）：

- **白名单重建**，绝不 `Object.assign` 透传 wire；
- **值级校验**（D6-F）：`resetsAt` 用严格正则 + `Date.parse` 双重校验并规范化为 ISO；
  `resetInSec` 限制在 `[0, 十年]`；
- **口径换算**（D6-C）：`percentSemanticsOf(id)` 声明 `remaining`/`used`（只有 codex 是剩余），
  统一输出 `percentMode: 'remaining'`；**越界不钳位**，置 `null`；
- **单位**：`unit: 'currency' | 'credits' | null`，积分（WorkBuddy `creditsTotal`）显式标注；
- **状态可辨**：`retired-channel` / `disabled` / `not-found` / `missing` / `no-credential` /
  `signed-out` / `auth` / `network` … 各有固定码与固定中文说明，绝不透传上游原文。

## 4. T2 — 编排、缓存与预算

`plans/usage-tool-register.js` + `index.js`：

- **范围**：支持白名单 ∩ 当前已启用 ∩ 用户请求；停用渠道即使被点名也**不取数、不发凭据**。
- **零副作用筛选**（D6-A）：`onlyIds` 在取数前生效；`describe` **不解析任何凭据**，
  身份解析单独由 `identify(ids)` 按本次请求完成。
- **缓存**（D6-B/D）：逐渠道缓存，键 = `id + 配置代次 + 凭据身份`；只存 `ok`/`unlimited`；
  `fetchedAt` 在采集时写入、命中不刷新；账号型渠道不缓存。
- **预算与取消**（D6-E）：deadline 从入口创建，覆盖 describe/identify/取数；
  组合 `exec.signal`；`onChannel` 逐渠道回传，慢渠道不抹掉快渠道；
  所有调用方离开时 abort 底层并清理任务；卸载时清空缓存与在途任务。
- **可选注册**：缺 `tools` 服务 / 返回 null / `register()` 抛错 / `ctx.get` 抛错
  → 全部静默跳过，胶囊与路由照常。

## 5. T3 — 可选收尾策略（默认关闭）

`plans/usage-policy.js`：

- 五个 `.volatile()` 字段：`quotaPolicyEnabled`（默认 **false**）、`quotaFocusChannels`、
  `quotaPercentThreshold`（默认 **0 = 未配置**）、`quotaBalanceThreshold`（默认 0）、
  `quotaBalanceCurrency`（默认空）；
- `policyOf()` 在未启用 / 无关注渠道 / **没有有效阈值** 时返回 `null`（不再补 20%）；
  金额判据必须同时有阈值与币种；
- `evaluateChannel()` 对 `error/unknown/unavailable/unlimited/stale` 一律不参与，
  百分比只看窗口剩余，金额只与**同币种**的 `unit:'currency'` 比较，积分永不比较；
- 输出分两条合规链路（D6-G）：
  1. 工具结果 `policy` 字段 + `render` 文本（模型调用工具时可见）；
  2. `systemPrompt.section('dsh-usage-dock.policy')` 静态规则摘要（配置变化重建、卸载清理）。
- 文案明确「不构成强制停工」，不含「必须停工 / 重启 / 切模型 / 杀进程」（有断言守）。

## 5b. 二次复核整改（Y1–Y4）

[二次复核](recheck-direction6-v0.9.0.md) 确认 D6 多数条件已修复，但仍有四组缺口。逐项处理：

| 编号 | 问题 | 处理 | 证据 |
| --- | --- | --- | --- |
| Y1 | 在途任务不按身份隔离（A 的结果被写成 B 的缓存）；内置渠道未把 provider 回退引用的实际值纳入身份 | 共享任务键加入 `identity`，任务记录启动时的 generation/identity；交付与回写都以**任务身份**为准，调用方身份不符则不交付；不可证明身份的渠道改用**私有任务**（不共享）；`identify` 对内置渠道解析 `source.refs` 实际值并哈希 | `Y1a`（A 挂起→切 B→放行：B 拿到 12.34，第三次命中 B 缓存）、`Y1b`、`Y1c`、`Y1d`（真实 apply + 真实 OpenCode：引用 A→10%，B→50%） |
| Y2 | 真实内置路径超时后仍发请求；快渠道被慢渠道抹掉；配置读取阶段取消不及时 | `plan.fetch(ctx, shell, cfg, options)` 接收 `{signal, remaining}`，`curlJson`/`fetchBackend` 绑定预算并在取消后**不再尝试下一个后端**；`collectPlans` 逐渠道 `emit` 并**在采集当时**写 `fetchedAt`，不再 `await` 悬挂渠道；`withinDeadline`/`awaitWithinDeadline` 监听 abort | `Y2a`（配置读取阶段 5ms 取消 → <300ms 返回）、`Y2b`（真实 apply：快渠道保留 + 采集时间早于整批结束）、`Y2c`、`Y2e`（共享调用之一取消不影响另一调用） |
| Y3 | 策略段落不随配置更新（不调用工具时开启无效、关闭残留） | 订阅宿主公开事件 `app-boot/config-reload`（`dsh-settings` 自身也用它），刷新配置并重建/移除段落；加 `alive` 保护，卸载后不再注册 | `Y3a–e`（不调用工具，false→true 注册、true→false 移除）、`Y3f`（卸载后不再注册） |
| Y4 | DeepSeek 混币/未知币种仍相加，未知单位被当成 CNY | 只对**可证明同币种**的钱包求和；异币或未知 → `balance: null` + `mixedCurrency: true`（明细仍用 cashBalance/bonusBalance）；工具投影为 `unknown`，不进入金额策略 | `Y4a–l`（CNY+USD、CNY+未知、单币、0、负数、策略集成） |

> 说明：Y2 的 `onChannel` 与「不等悬挂任务」是两道并行保障——前者保证已完成渠道
> 立即回传并在采集当时打时间戳，后者保证整批不被悬挂渠道拖死。变异测试证明：
> 去掉采集时间戳或回退共享任务身份、去掉配置事件订阅、回退混币求和，都会让对应用例失败
> （见 `tools/verify-y-mutations.mjs`）。

## 5c. 第三轮复核整改（Z1–Z3）

[第三轮复核](recheck-direction6-round3-v0.9.0.md) 判定 Y4（模型安全）通过，仍有三处缺口：

| 编号 | 问题 | 处理 | 证据 |
| --- | --- | --- | --- |
| Z1 | 身份采样与实际发送的 Key 可能不是同一把（采样后引用轮换），成功结果被写进错误身份 | `identify` 采样后把**解析到的凭据值**作为快照随请求下发；`resolveApiKey` 与自定义条目解析**优先使用快照**，不再二次解析；快照缺失按「未配置」处理，不偷偷回退 | `Z1a–c`：真实 apply + 真实 OpenCode provider，采样 A、发送时引用已是 B → 首次发送的 Authorization 仍是 A、结果 10%；切 B 后 50%；回 A 命中 A 自己的缓存 |
| Z2 | 自定义渠道未接外部取消；快条目被慢条目拖丢 | `fetchCustomPlans` 把外部 signal 联到整批预算（取消即 `expire`，worker 不再启动新条目）；`requestJson` 监听外部 signal 并能中断在途传输；新增 `onItem` 逐条回传，**采集当时**写 `fetchedAt` | `Z2a`（取消后零传输请求）、`Z2a2`（在途传输被中断，<800ms 返回）、`Z2b`（A 快 1ms 回传且带时间戳，B 挂起不拖死整批） |
| Z3 | `app-boot/config-reload` 落在两秒配置缓存内，读到旧配置，之后不自动更新 | `createLiveConfig` 暴露 `invalidate()`（并带读取代次，防止较早的慢读覆盖新状态）；reload 回调先作废缓存再重建段落 | `Z3a–f`：真实 apply + 普通 override 的 `configEditor`，缓存窗口内**一次事件**即开启/关闭/改阈值；`Z3g` getter 路径；`Z3h` 缺服务与卸载 |

> 变异校验：`tools/verify-z-mutations.mjs` 分别回退「凭据快照」「传输层取消监听」
> 「逐条回传」「reload 作废缓存」，对应用例（Z1a / Z2a2 / Z2b / Z3b）全部失败，
> 证明用例确实覆盖这些修复，而不是恰好通过。

## 5d. 增量改进（Z4）：混币在界面上的正确表达

> 第三轮复核把这条列为**非阻塞呈现建议**，不追加为放行条件。这里作为「继续修复」的增量处理，
> 且**不改变** Y4 的安全行为（仍然不跨币种求和、不参与金额策略）。

- **胶囊**：`mixedCurrency === true` 且没有总额时显示「多币种」，不再显示「获取失败」
  ——数据其实已经拿到了，叫失败是错误归因。
- **详情**：写明「余额包含不同币种，无法合计为一个数字」，并逐笔列出明细；
  只在**该笔币种可证**时带币种（`CNY 10` / `USD 2`），未知单位显示「（币种未知）」，
  绝不套用另一笔的符号，也不编造总额。
- **provider**：`plans/deepseek.js` 增补 `cashCurrency` / `bonusCurrency`，让 UI 能判断
  「哪一笔的单位可证」。
- 单币种的合计与明细保持不变（`Z4d` 守）。

证据：`tools/test-mixed-currency-ui.mjs`（5 项）+ `tools/verify-z4-mutations.mjs`
（回退胶囊分支 / 详情分支 / 逐钱包币种，分别让 Z4a / Z4b / Z4e 失败）。

## 5e. 第四轮复核整改（Q1–Q3）：凭据契约统一

第四轮复核判定 Z2/Z3/Z4 通过，剩余问题收敛到**凭据处理**。本轮不再逐特例打补丁，
而是把契约统一成四步：**允许渠道 → 选实际来源 → 一次解析/冻结 → 身份与发送同源**。

| 编号 | 问题 | 处理 | 证据 |
| --- | --- | --- | --- |
| Q1 | 只冻结了引用，显式 Key/Cookie 没冻结；`collect` 重读配置后 provider 用的是新值，B 的结果被存进 A 的身份 | 冻结粒度改为**逐渠道的实际生效来源**（`{kind:'explicit'|'ref'|'none'}`）。显式 Key/Cookie 优先并冻结其值；引用按候选顺序只解析**真正生效**的那一个并冻结。provider 侧 `resolveApiKey` / MiMo Cookie / 自定义条目一律**先看冻结值**，无冻结才走原路径 | `Q1a–c`（真实 apply：采样 A → collect 读到 B → 发送仍是 A、结果 10%、缓存未被污染）、`Q1d–e`（provider 直接收到冻结值，引用不再二次解析）、`Q1f`（未冻结仍正常解析；`none` 直接报缺凭据且零请求） |
| Q2 | 新快照把「未采样」当成「确认没有凭据」，破坏正常回退：DeepSeek 账号不可用时模型 Key 被挡；OpenCode 首候选为空时不看第二候选 | 区分三种语义：**未冻结 → 走原解析**、`none` → 确认无凭据、`explicit`/`ref` → 用冻结值。引用候选遇到空值/哨兵**继续下一个**（保持原候选顺序与哨兵规则） | `Q2a`（账号不可用 + 模型 Key → 7.25 正常、不再 no-credential）、`Q2b`（首候选空 → 用第二候选）、`Q2c`（显式 Key 可用时凭据服务抛错也不受影响，且零多余解析） |
| Q3 | 停用的内置渠道被显式点名时仍解析凭据 | `identifyChannels` 在读取任何字段/凭据**之前**先按「已启用 ∩ 已知 ∩ 请求」过滤；原 `ids` 只用于产出 `disabled` 状态 | `Q3a`（disabled + 零解析）、`Q3b`（全局关闭零解析）、`Q3c`（只查 A 不碰 B，D6-A 契约不回退） |

> 变异校验：`tools/verify-q-mutations.mjs` 回退「provider 认冻结值」「未冻结语义」
> 「候选继续规则」「停用前置过滤」四项，分别让 Q1d / Q2a / Q2b / Q3a 失败。

## 5f. 第五轮复核整改（F1–F2）：冻结协议逐层落地

第五轮复核确认 Q2/Q3 通过，剩余两处都在 Q1 的冻结协议上：**中间层丢快照**与
**provider 不服从 none**。

| 编号 | 问题 | 处理 | 证据 |
| --- | --- | --- | --- |
| F1.1 | 注册层只取 `snapshot.frozen`，把 `snapshot.custom` 丢了，collector 只拿到内置表 | 新增 `mergeFrozenSnapshot()`：把 `frozen` 与 `custom` 合并成**一张逐 id 冻结表**再下发 | `F1.6`（真实注册层：断言 collector 收到的确有 custom 条目、值是采样时的 ref-A） |
| F1.2 | 即使传到了，provider 也先用当前 `entry.key`，纯显式条目不读冻结值 | 冻结协议**前移到选择已保存凭据之前**：`explicit`/`ref` 只用冻结值、`none` 直接缺凭据、未采样才走原路径；冻结值仍过 `credentialHost`/origin 校验（不绕过目标确认） | `F1.1`（ref A→B→A 仍发 A、零额外解析）、`F1.2`（当前 B、冻结 A → 发 A）、`F1.3`（none 零请求）、`F1.4`（未采样照旧）、`F1.5`（目标未确认零请求） |
| F2 | MiMo 只认 `explicit`，`none` 回退到 cfg，于是把后来的 Cookie B 的成功写进「无凭据」身份 | 有冻结描述即严格遵守：`none` 零请求、`explicit` 只用其字段（缺失/无效也不回退）、其它状态安全拒绝；只有 `null` 才读 cfg | `F2.1`（none 零请求）、`F2.2`（explicit 发 A）、`F2.3`（显式缺字段零请求）、`F2.4`（未采样照旧）、`F2.5`（不支持的 ref 状态零请求）、`F2.6`（真实 apply：none→Cookie B→清空→再查，全程零 MiMo 请求、无缓存成功） |

### 测试质量修正（复核指出）

- **Q1a 时序**：原用例请求里没有慢引用条目，gate 从未进入，`reads` 自增起点也不足。
  现在请求**两个**条目、显式 gate 握手（断言「gate 已进入」），跨过两秒配置窗口后改配置再放行，
  并断言 `reads >= 2` 证明真的重读。
- **V3c 时钟脆弱性**：原断言 `createBudget(1, now+5000).expired === false` 依赖 1ms 墙钟与调度，
  首跑偶发失败。改为确定性断言（两个 deadline 都在未来→未过期；整批 deadline 在过去→立即过期），
  **不放宽**产品预算，也不删除「15ms 到期后迟到 DNS 零发送」等安全断言；连跑 5 次稳定通过。

## 5g. 真机安装与初次冒烟（2026-10-19）

**部署**：0.9.0 payload 复制到 `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock`
（原 0.8.4 备份在 `profiles\desktop\plugin-backups\dsh-usage-dock-0.8.4-20261019-141133`）；
profile 的 `package.json` 依赖**仍写 0.8.4**（0.9.0 未发布到 npm，改成 0.9.0 会让下次 `pnpm install`
去 registry 找不存在的版本而失败）。未 commit、未打标签、未 push、未发布。

### 首次冒烟失败：`usage_status` 静默消失（已修）

重启后 GUI 胶囊与 `/api/plan-usage`（200、5 个渠道、带 `cfg.digest`）都正常，
但新会话里问「有哪些用量/余额工具」时模型**看不到任何工具**。

- **根因**：`OUTPUT_SCHEMA` 里用了 `type: ['number','null']` 这类 **type 数组**。
  宿主的 `assertSupportedJsonSchema` 只接受**单一** `type` 字符串，
  `tools.register(def)` 抛 `JsonSchemaError`；`registerUsageTool` 的 `try/catch`
  把它吞成 `registered:false`，于是**只有工具消失，其它一切照常**。
- **定位方法**：从 `app.asar` 抽出宿主 `@deepseek-ai/dsh-tools` 的真实校验器
  （`assertSupportedJsonSchema` / `checkSchemaNode`），对我们的 schema 实跑，
  立刻得到 `output.schema: FAIL -> … type arrays are not supported`。
  仅靠离线回归发现不了，是因为测试里的假 tools 服务**不做 schema 校验**，
  而「缺服务时静默跳过」还被当成优雅降级。
- **修复**：新增 `nullable(type) = { oneOf: [{type}, {type:'null'}] }`，10 处 type 数组全部替换
  （`policy` 用 `oneOf: [object, null]`）。
- **新守卫**：`tools/test-usage-tool-contract-host.mjs`（9 项）+ `tools/host-json-schema.mjs`
  （宿主校验器的本地只读副本）。K1b 专门禁止 type 数组，K2b 断言「工具确实被注册」。
  把 `nullable` 改回 type 数组可精确复现真机故障（`register calls: []`）。

### 第二次冒烟：通过

修复并重启后，新会话里模型**成功调用 `usage_status`**，输出与 GUI 完全一致：

| 渠道 | 工具返回值 | GUI 胶囊 |
| --- | --- | --- |
| DeepSeek | 余额 18.03 CNY | ¥18.03 |
| OpenAI Codex | rolling-5h 剩余 31%、weekly 剩余 54% | 31% 54% |
| WorkBuddy | 积分 6017 | ✦6,017 |
| WorkBuddy AI | 积分 349 | ✦349 |
| Xiaomi MiMo | 无数值，`errorCode=api`（上游拒绝请求） | 获取失败 |

MiMo 的 `api` 是**语义错误**（`transient:false`），立即提示、不用旧值掩盖；
模型据此建议「Cookie 可能已过期」——与实际语义一致，属于预期行为而非缺陷。

**这次真机冒烟覆盖到了之前一直标注为「未验证」的项**：
真实宿主 `tools` 注册、模型实际调用、工具结果进入对话。
仍未验证：`systemPrompt` 段落是否真的进入提示词、Android 能力、策略 UI（未实现）。

## 6. 剩余边界（未验证，不得写成已通过）

1. **真实宿主 `tools` 冒烟：已通过（2026-10-19 真机）**——`usage_status` 注册成功、模型实际调用、
   结果与 GUI 一致（见 §5g）。**仍未验证**：`systemPrompt` 策略段落是否真的进入提示词
   （需要在启用策略后让模型原文复述一次）。
2. **策略 UI 未做**：只能改配置字段，设置页没有对应控件。
3. **Android / DSHA**：`tools` / `systemPrompt` / `node:https` 可用性未实机确认
   （缺服务时按设计静默跳过）。
4. **不支持清单之外的渠道**：未核实窗口用途的渠道仍按 `used` 保守处理，不声称已验证。
5. **不宣称**：不保证模型一定调用工具、不保证绝对不超额、不做硬性停机。

## 7. 测试结果

二次复核后新增 `test-usage-recheck-y1y4`（41 项）；第三轮复核后新增 `test-usage-recheck-z1z3`（25 项）与 `test-mixed-currency-ui`（5 项）；第四轮复核后新增 `test-usage-recheck-q1q3`（30 项）。

| 组 | 项数 | 覆盖 |
| --- | --- | --- |
| `test-usage-tool` | 108 | 投影/真实语义/时间校验/状态码/脱敏/渲染 |
| `test-usage-tool-register` | 70 | 契约形状/缓存身份/只缓存成功/预算/取消/single-flight/策略附加 |
| `test-usage-tool-host` | 41 | **真实 apply**：注册、dispose、请求范围、状态码、systemPrompt 段落 |
| `test-usage-policy` | 85 | 默认关闭/无默认阈值/单位匹配/保守判定/段落 |
| `test-usage-integration` | 31 | **真实 provider** → 投影 → render/策略（OpenCode/DeepSeek/WorkBuddy） |

全量：**33 个 Node 组 1133 项** + 行尾 51 + 几何 144 = **1328 项**，另 WorkBuddy 契约 7 项（合计 1335 项）。
全部通过，0 失败、0 跳过。

> 采集方式说明：本轮用「输出重定向到文件再取尾行」的方式跑批量回归。
> 早期用管道同时捕获 27 个进程的 stdout 时，出现过程序退出期的
> `UV_HANDLE_CLOSING` 断言崩溃；改为文件重定向后稳定通过，
> 单测独立运行也始终通过——判定为采集层管道竞争，不是产品缺陷。

## 8. 产物

`legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz`（校验值见整改记录）。

**未做**：部署当前 profile、重启、git commit、改标签、push、Release、npm publish。
