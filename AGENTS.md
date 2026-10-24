# dsh-usage-dock — 项目对接文档

> 面向接手本项目的 AI agent / 开发者。**动手前先读完本文**，尤其是第 5 节的 API 契约，
> 那里记录的都是踩过的坑，重复踩会浪费大量时间。

---

## 1. 项目是什么

DeepSeek Harness（DSH）的**侧栏用量/余额插件**：在 Web/桌面端左侧状态栏底部显示各家 AI 套餐的
用量与余额，点击可展开详情面板。fork 自 `chendefine/dsh-plugins-plan-usage`，改名 `dsh-usage-dock`
以避免与上游混淆，并做了一系列定制（见第 6 节）。

**当前版本**：0.9.0（三渠道退场 + 通用自定义余额 + `usage_status` 只读工具 + 可选额度策略 + 单列设置页。
**0.9.1 曾是过程内的整改标签，已并入 0.9.0**，不要把它当作已单独发布过的版本）　|　
**上一公开版**：0.8.4（GitHub Release + npm）　|　**更早**：0.8.5（仅本地定档）、0.8.3、0.8.2、0.8.1、0.7.2（0.8.0 未单独发布）

> **审核入口（先读这条）**：当前**权威**记录是
> [0.9.0 发布状态](docs/release-status-v0.9.0-20261024.md)（程序已部署、用户已确认本地验收；
> 验收证据、未验证边界、`0.9.1` 标签归属都在那里）。下方 2026-10-21/22 段落是**历史过程记录**，
> 口径以状态文档为准；历史结论不删除、API 契约继续有效。

> **2026-10-22 0.9.1 历史状态（过程记录，已并入 0.9.0）**：
> 冻结 A/B/C 根因已完成本地修复与行为验收；**51 组 1642 项（含12个生命周期场景）+ 行尾75 + 几何144 + 契约7 = 1868项，54脚本全部exit0、0跳过**。
> 新包 `92DC823A…`（232905字节 / 27文件）[本地包](legacy/local-build-0.9.0/operation-fix-20261022/dsh-usage-dock-0.9.0.tgz)已按用户授权备份并部署desktop profile，27文件mismatch=0；**未自动重启，等待用户手动重启及新会话确认，不能把磁盘已部署当作运行时已激活**。[试装步骤与回滚](docs/deploy-local-operation-fix-20261022.md)。
> - 最新修复与验收：[A操作归属修复](docs/fix-custom-operation-v0.9.1-20261022.md)、构建记录§24。真实Host提示词注入/重试、策略UI等仍是独立未完项，不并入自定义渠道修补。
> - 现状与验证分栏：[docs/status-0.9.1-20261021.md](docs/status-0.9.1-20261021.md)
> - 逐轮整改细节：[docs/quota-policy-build-v0.9.0.md](docs/quota-policy-build-v0.9.0.md) §14–§24
> - **内置 WorkBuddy 已改走 WorkBuddy2API 网关**（`plans/workbuddy.js` `fetchFromGateway`，
>   `GET <origin>/status` 根路径 + 复用模型来源 Bearer Key）；`workbuddy-ai` 已退场。
> - **第六轮复核 R6-01…R6-05** 已修：同 Key 指纹分叉（identify/GUI 两套编码）、
>   WorkBuddy 来源与账号选择未进观察身份、明细吃光 8 秒工具预算、错误回显上游正文、
>   `response.ok` 兼容分支。详见构建记录 §20。
> - **构建级缺陷 B1–B12**（超时误 abort、正文读两次、`locked` 未定义导致设置页白屏等）
>   见构建记录 §19.3 —— 这批都是实现错误而非需求变更，且多数只在合成对象上测过，
>   真机先发现。改这类代码请用真实 `signal` / 单次消费 body / 真实作用域验证。

> **2026-10-18 0.9.0 审查整改（R1–R7 + 连接目标安全）**：独立审查发现 7 个可复现缺陷与 1 个安全偏差，
> 已全部修复并各自补了「先失败、后通过」的复现用例。要点（细节见
> [审查整改记录](docs/remediation-v0.9.0.md)）：
> - **R1 预算贯穿全流程**：`createBudget()` 的绝对 deadline 覆盖排队、`credentials.resolve`、
>   DNS、连接与 body；过期后**不再发请求**，迟到依赖不回填。
> - **R2 代次用实际凭据**：`credentialFingerprint()` 对**真正发送的 Key**（含引用解析结果）取
>   不可逆短哈希，`generationOf()` 在拿到 Key 后才定稿 = 引用轮换/清空/解析失败都会换 gen。
> - **R3 配置变化即时作废**：客户端 `customConfigSignature()` + 模块级 `configEpoch`
>   （保存成功即 bump，覆盖「只改 Key」）作为轮询 effect 依赖 —— 配置一变就 abort 在途请求、
>   清空旧值与失败计数；显示层按**当前已保存配置**过滤。旧实现只比较两份 wire.gen，在途旧响应会被接受。
> - **R4 错误行保留身份**：整体失败第 8 轮的纯错误行保留 `custom`/`gen`（只剥余额），
>   carry 按已保存配置清理，删除/停用后不再残留成 `custom:xxx 获取失败`。
> - **R5 显式 Key 也受目标绑定**：显式已保存 Key 与凭据引用**统一**要求
>   `credentialHost === originOf(url)`（规范化 origin，大小写/默认端口/IPv6 一致），
>   否则**零请求**返回 `credential-unconfirmed`。新录入的 Key 保存时自动绑定当前 origin。
> - **R6 先校验后写**：`save()` 改为「校验（零副作用）→ 一次 mutate 提交公开字段+secret 路径 →
>   如实报告」；无 `mutate` 且要写 Key 时整页拒绝，绝不先写元数据再提示取消。部分成功会明说。
> - **R7 统一解包 volatile**：`unpackConfig()` 在交给 provider 前解包**所有**字段（Key/Cookie/阈值/
>   数组），修掉「无 configEditor 时用户填了 Key 仍报 no-key」的既有缺口。
> - **安全（连接目标）**：不再「先 lookup 再让 fetch 自己解析」。`resolveValidatedAddresses()`
>   拿到全部公网地址后，`requestJson` 用 `node:https` + `makeLookup()` 把 `lookup` **钉死**在这份
>   地址上（`servername` 仍为真实域名，TLS 校验从不关闭，不跟随重定向）；拿不到 `node:https`
>   时返回 `unbound` 并**保守拒绝**，不静默降级。
> 测试：新增 `test-review-fixes`（40）、`test-custom-race`（39）、`test-config-unwrap`（22）、
> `test-recheck-fixes`（25），全量 **22 组 768 项通过**（另契约 7 项）。
> 仍为**仅本地构建**：未部署、未重启、未提交、未推送。（方向 6 后来已获授权实施，见下方条目。）
>
> **第二轮复核（V1–V5）追加修复**（[复核报告](docs/recheck-v0.9.0-remediation.md)）：
> - **V1 端口 origin**：新增 `composeOrigin()`，只接受 hostname、端口去前导零、默认端口不写入；
>   `originOf()` 统一四种输入；`validateBalanceUrl()` 直接返回可比较的 `origin`。
>   此前 `https://a.example:8443` 被算成 `https://[a.example:8443]:8443`，
>   导致**正确确认被拒、旧 443 确认却能向 8443 发 Key**。
> - **V2 已渲染数据作废**：`state.applied`（数据所属配置身份）+ 逐条签名 + `customDataStillValid()`
>   在**渲染时**判定；`wireMatchesCurrentConfig()` 用 wire `gen` 识别「Host 2 秒配置缓存回旧数据」；
>   `knownGens` 放组件级 ref（否则 effect 重建后旧快照又会被当新数据）。改 URL/币种/只改 Key 都**立刻**生效。
> - **V3 单条预算**：`createBudget()` 取 `min(now+totalMs, deadlineAt)`，不再被子任务继承整批 20 秒放大。
> - **V4 冷启动并发**：`loadHttps()` 缓存**同一个 Promise**，不再在 import 完成前暴露 undefined。
> - **V5 截断响应**：stream 错误不再被吞成 EOF；EOF 后校验 `res.complete`，
>   Content-Length 不足 / chunked 未终止 / 中途断开一律判失败，合法 JSON 前缀也不能冒充成功。
> 新包 `AAE306…`（旧 `e4fc46…` 作废）。
>
> **第三轮复核（W1–W3）追加修复**（[第三轮复核](docs/recheck-v0.9.0-round3.md)）：
> V1/V3/V4/V5 通过，V2 仍有三处缺口，根因都是「客户端在猜 Host 用的是哪份配置」。改为 **Host 出证**：
> - **配置身份协议**：`configDigestOf()`（Host）与 `configDigestOfClient()`（客户端）用同一套规则
>   算 16 位摘要（条目公开身份 + **非密**修订号 `customKeyRev`）。Host 路由返回
>   `data.cfg = { digest, readAt, reloadable }`，`digest` 用**本次实际读到的 cfg** 计算。
>   客户端只比较摘要：不等 → 整批不显示，也不标成当前配置的 applied。
> - **W1**：从没见过 gen 时不再直接接受旧配置 wire（首个请求被取消 + Host 2 秒缓存场景）；
>   组件重挂、快速修改、旧缓存回放都覆盖，Host 读到新配置后自动恢复。
> - **W2**：`customKeyRev` 与 secret 写**同一次 mutate**，幂等写入（同一把 Key）也会 +1，
>   因此「保存是否生效」不再靠 gen 变化判断；收到可信摘要后同一 gen 也能恢复。
>   不删 `configDirtyIds` 兜底，否则保存后旧值会回填。
> - **W3**：`lastList`/`failStreaks`/`customGens` 移到组件级 ref，effect 重建**不再清空全表**；
>   只逐条作废「身份确实变了 / 停用 / 删除」的条目，未改动的 B 与内置渠道继续沿用基线与失败计数。
> 新增 `test-recheck-round3`（29），全量 **22 组 776 项通过**。新包 `E4861F38…`（旧 `AAE306…` 作废）。
>
> **第四轮复核（X1–X2）追加修复**（[第四轮复核](docs/recheck-v0.9.0-round4.md)）：
> - **X1 双端摘要规范化统一**：Host 的 `entryPublicIdentity()` 会 trim URL/路径/引用、
>   规范化币种、小写 `credentialHost`，而客户端拼的是原始字段 —— 于是
>   `url = ' https://a.example/b '` 这类**合法输入**让 Host 的成功证明永远不匹配，
>   界面只剩「—」。现在客户端 `digestEntryIdentity()` 与 Host 逐字同构
>   （`digestText` trim+截断、`digestCurrency` trim+大写、host 小写）；
>   `customEntrySignature()` 也走同一规范化，避免「没改却被判成改过」。
>   **规范化放在摘要计算里**，不是保存时 trim —— 这样既有配置 / CLI / YAML / 真实 Config 都覆盖。
> - **X2 只改 `customKeyRev` 也生效**：`expectedDigest` 原来被读进 effect 闭包、依赖里也没有它，
>   于是别的窗口保存 Key 后（本页无 `bumpConfigEpoch`）旧值不隐藏、匹配新修订的结果被永久拒绝。
>   现在比较 `expectedDigestRef.current`（当前值）、`expectedDigest` 进入 effect 依赖、
>   逐条身份 `customEntryIdentityWithRev()` 纳入该条公开 Key 修订号（其它条目不受影响）。
> 新增 `test-recheck-round4`（33）。**口径更正**：此前「776 项」漏计 `mimo-parse`（21）与
> line-endings 增量，实际为 **23 组 831 项**（22 个 `node` 组 654 + line-endings 33 +
> peak-marker 144）。新包 `E41967…`（旧 `E4861F38…` 作废）。
>
> **方向 6 实施：`usage_status` 只读模型工具（2026-10-18 获明确授权）**（[实施记录](docs/direction6-0.9.0.md)）：
> - **T0 契约重新核验**（从 `app.asar` 直读 `@deepseek-ai/dsh-tools` 真实实现，**不沿用**补证推断）：
>   `ctx.tools.register(def)` 返回**精确 disposer**；def 形如
>   `{name, description, parameters, output:{schema, render}, execute(args, exec)}`；
>   `execute` 返回值必须是 lossless JSON 且符合 `output.schema`；schema 只支持
>   `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解；
>   `run_code` 是保留名。**不 import** 宿主包，按契约手写定义。
> - **T1 投影**（`plans/usage-tool.js`，纯函数）：白名单逐字段重建（**不透传** wire）；
>   Key/Cookie/URL/路径/账号/上游原文一律不出；`0` 有效、负数保留、缺失为 `null`；
>   Codex 百分比显式 `percentMode:'remaining'`；退场 id → `unknown + retired-channel`
>   （不取数、不复活）；未知 id 是**参数错误**。
> - **T2 编排**（`plans/usage-tool-register.js` + `index.js`）：查询范围 = 白名单 ∩ 已启用 ∩ 用户请求
>   （**停用渠道显式点名也不取数、不发凭据**）；只取需要的渠道；30 秒**成功**缓存 +
>   single-flight + 按配置摘要分代；单次 8 秒预算（超时不 reject，标 `missing`）；
>   缺 `tools` 服务时**静默跳过**且不影响胶囊与路由。
> - **T3 策略**（`plans/usage-policy.js`）：五个 `.volatile()` 字段，`quotaPolicyEnabled`
>   **默认 false**，两个阈值默认 **0 = 未配置**；未启用/无关注渠道/无有效阈值 → 不说话；
>   `error/unknown/unavailable/unlimited/stale` 一律不参与；提示文本明写「不构成强制停工」。
>   （D6-H 整改后不再有「默认 20%」；详见下方 D6 条目。）
> - **实现中真实发现并修掉的三个问题**：① 注册发生在 `apply` 时（配置未读到），早期把启用集合
>   当同步值求值 → **首次调用永远查不到渠道**（回归 `R11`/`R12`）；② 空查询集合仍会打上游；
>   ③ 显式查询未与「已启用」求交集，停用渠道仍被取数（`E12b` 抓出）。
>
> **方向 6 首次复核整改（D6-A～D6-H）**（[复核报告](docs/review-direction6-v0.9.0.md)、
> [实施记录](docs/direction6-0.9.0.md)）：首次复核判定「框架有、尚不通过」，八组问题已逐组修复。
> - **D6-A 请求范围**：`fetchCustomPlans` 新增 `onlyIds`，在**任何凭据解析/DNS/请求之前**缩小条目；
>   `describe` 不再解析凭据，身份解析单独由 `identify(ids)` 按本次请求完成。
> - **D6-B 缓存身份**：缓存键 = `id + 配置代次 + 凭据身份`（Host 内部短哈希）；
>   账号/会话型渠道（deepseek/codex/workbuddy/workbuddy-ai）**完全不缓存**；collect 返回前校验代次。
> - **D6-C 真实语义**：`percentSemanticsOf()` 声明口径（只有 codex 是 remaining；OpenCode 的
>   `usagePercent` 是已用 → 换算成剩余）；WorkBuddy 读 `creditsTotal`；DeepSeek 带回实际币种；
>   越界置 null 不钳位；`disabled`/`not-found`/`missing`/`no-credential`/`retired-channel` 可辨。
> - **D6-D**：只缓存 `ok`/`unlimited`，失败可立即重试；成功采集写 `fetchedAt`，命中不刷新。
> - **D6-E**：deadline 从 `execute` 入口创建并贯穿 describe/identify/取数，组合 `exec.signal`；
>   `onChannel` 逐渠道回传（慢渠道不抹掉快渠道）；卸载清空缓存与在途任务。
> - **D6-F**：`resetsAt` 严格校验并规范化 ISO，`resetInSec` 限区间，非法置 null。
> - **D6-G**：策略进入工具结果 `policy` 字段与 `render`，并注册宿主**公开**
>   `systemPrompt.section`（配置变化重建、卸载清理）。**「必须改宿主」的原判断不成立。**
> - **D6-H**：阈值默认 **0 = 未配置**（不再补 20%）；金额判据必须绑定币种；积分不与金额比较。
> 方向 6 十二组共 **509 项**（`test-usage-tool` 108 / `-register` 70 / `-host` 41 /
> `test-usage-policy` 85 / `test-usage-integration` 31（**真实 provider**）/ `recheck-y1y4` 41 /
> `recheck-z1z3` 25 / `mixed-currency-ui` 5 / `recheck-q1q3` 30 / `recheck-f1f2` 32 / `usage-tool-contract-host` 9）。
> 全量 **33 组 1328 项**（33 个 Node 组 1133 + 行尾 51 + 几何 144），另契约 7 项。
> 新包 `5A9DE120…`（旧 `411C577C…` 作废）。
> **真机冒烟（2026-10-19）**：`usage_status` 已装入本机 desktop profile 并**被模型实际调用成功**，
> 返回值与 GUI 胶囊一致（DeepSeek 18.03 CNY / Codex 31%、54% / WorkBuddy 6017 / WorkBuddy AI 349 /
> MiMo 为 `api` 语义错误）。首装时曾因 `OUTPUT_SCHEMA` 使用 **type 数组**（宿主只支持单一 `type`
> 字符串）导致 `register()` 抛错、被吞成 `registered:false`，工具**静默消失**（GUI 与路由都正常）；
> 已改用 `oneOf` 表达可空字段，并补 `test-usage-tool-contract-host`（9 项，含宿主校验器副本）守门。
> **仍未验证**：`systemPrompt` 策略段落是否真的进入提示词、策略 UI（未实现）、Android 可用性。
> 未经独立复核，**不**声称方向 6 已通过。

> **2026-10-18 0.9.0**：① 移除 `kimi-code` / `glm-zhipu` / `glm-zai` 三个内置渠道的胶囊、
> 详情、设置与排序入口，并**停止后台取数**（注册表是唯一取数来源）；旧配置字段与共享模型凭据
> 原样保留，不清理 profile。Kimi parser / ratio-pool / Cookie 月限按用户决定**不修**。
> ② 设置页最下方（统一保存/放弃之前）新增「自定义余额渠道」：名称、HTTPS 余额 URL、API Key
> （可留空复用**明确选定**的模型凭据引用）、结果 JSON 键路径，可选币种与固定扣减键。
> 只做 `GET` + Bearer + JSON，不做厂商特例；不跟随重定向，拒绝环回/私网/云元数据目标，
> DNS 解析结果必须全部公网，响应体上限 256 KiB、单条 10 s / 整批 20 s、并发 3、最多 12 条。
> Key 存放于 `role('secret')` 的 `customKeys` dict（**不是**数组元素），设置页按
> `['customKeys', id]` 路径 set/unset，输入框从不回填已有 Key。
> ③ 失败回退沿用阈值 8：暂时错误灰化保留上次成功值，鉴权/配置错误立即提示；
> 每条带 `gen`（身份字段 + Key 指纹），改 URL/Key/引用/路径/币种或停用/删除即作废旧值与在途响应。
> 详见 [v0.9.0 发布说明](docs/release-notes-v0.9.0.md)。
> ④ 顺带修正既有缺陷：无 `configEditor` 的部署里 volatile 字段是 `{get()}` 包装，0.8.x 的
> `cfg.enabled === false` 判断恒不成立（全局与渠道开关实际不生效），已填的 Key/Cookie/阈值也被
> 当成非字符串/非数字。整改版用 `unpackConfig()` 在交给 provider 前**统一解包所有字段**（R7）。
> 测试：新增 `test-review-fixes`（40）、`test-custom-race`（39）、`test-config-unwrap`（22）、
> `test-recheck-fixes`（25）、`test-recheck-round3`（29）、`test-recheck-round4`（33）；
> 全量 **33 组 1328 项通过**（另契约 7 项）。**本地回归不等于真机验证。**

> **2026-10-15 0.8.2 说明**：主方向为 DSHA WorkBuddy「fetch failed」修复（宿主
> dsh-web-mobile compress.js × gzip 中间件踩踏，消费侧两处绕过：status 请求声明
> `accept-encoding: identity` + 失败降级为 partial 部分数据与灰色脚注）；另含
> 详情卡片外点/Esc 关闭、向上展开渐变动画（WAAPI）、峰谷条方案 K「上下对尖」
> 游标（白柱移出轨道）。根因诊断与宿主侧修复建议见 `DHSA移植反馈/交接文档-0.8.2修复.md`。
> 0.8.1 时期：WorkBuddy 积分与渠道排序、充值入口整体移除、峰谷条固定中点 + 24h 平滑移动图案；
> 0.8.0 的 classic/充值记录是历史阶段，最终实现以 [v0.8.2 发布说明](docs/release-notes-v0.8.2.md) 与 [v0.8.1 发布说明](docs/release-notes-v0.8.1.md) 为准。
> DSHA/安卓检查包括无 shell、无账号/configEditor 服务、无 WAAPI/ResizeObserver 的降级与 hooks 稳定性；真实 WorkBuddy Connect 0.7.4 状态处理器对接通过，但并非 Android 真机联网实测。
> 测试：`test-android-compat.mjs`（14）、`test-settings.mjs`（6）、`test-workbuddy.mjs`（27）、`test-workbuddy-contract.mjs <上游lib/index.js>`（7，0.8.5 拆语义/暂时两组）、`test-panel-interactions.mjs`（12，0.8.2 新增 8 项 / 0.8.3 扩到 12）、`test-peak-marker.mjs`（144 几何断言，0.8.2 改方案 K）、`test-line-endings.mjs`（21，0.8.3 新增）、`test-fetch-backends.mjs`（13，0.8.3 扩到 13）、`test-footer-row.mjs`（12，0.8.4 新增 T12）、`test-degrade-refresh.mjs`（43，0.8.5 适配阈值 8）。
> **2026-10-16 / 17 0.8.3**：胶囊 WorkBuddy 积分改「✦ 」前缀（U+2726 单色符号，随主题深浅），
> 替换「（积分）」全角后缀，与「¥39.86」前缀语法同构（用户选定；候选符号与真实渲染
> 截图留档 `docs/demos/credit-symbol-demos.html` 与 `legacy/symbol-check/`）。同版还包含
> WorkBuddy / WorkBuddy AI 拆成两个独立渠道、DeepSeek 充值/赠金分行（账号路径 `value`/`bonusWallets`，
> API Key 路径 `topped_up_balance`/`granted_balance`——后者是 2026-10-17 补的漏项）、胶囊数值右对齐、
> 超时 30s / 失败阈值 5、API Key 模式也显示峰谷条、`tools/test-line-endings.mjs`（21）守卫，
> 以及详情卡片「点空白偶尔不关」兜底——按下类事件从只挂 `pointerdown` 扩到
> `pointerdown` + `mousedown` + `touchstart`，并补 `click` 兜底（键盘激活也能关），用
> `downInside` 标记区分「从面板内起手拖选」与外点。详见
> [v0.8.3 发布说明](docs/release-notes-v0.8.3.md)。注意：窗口顶部
> `-webkit-app-region: drag` 拖拽条与原生滚动条**不产生任何 DOM 事件**，页面侧无法感知，
> 属于 DSH/Chromium 的固有限制。
> **2026-10-17 0.8.4**：胶囊不再盖住 DSH 官方通知卡——`rootStyle` 里去掉了自 0.2.1-slacom.1
> 就有的 `zIndex:1000`（它把透明背景的胶囊抬到 portal 通知卡之上，两段文字互相穿透）。
> 回到 `auto` 后由 DOM 顺序决定，后挂的通知/浮层自然覆盖胶囊。像素证据与核查过程见
> [v0.8.4 发布说明](docs/release-notes-v0.8.4.md)。
> **2026-10-18 0.8.5**：WorkBuddy / WorkBuddy AI 不再「动不动就获取失败」——根因是 Host 侧把
> connect 的 `creditsError` **一律**当成语义错误（`api`），客户端于是跳过「灰化保旧值」直接报错。
> 现在按文案里的 `kind` 分流：`session_dead` / `hard_credit` 才算语义错误，限流 / 5xx / 超时 /
> 结构变化都归暂时失败（`exec` + `transient:true`）；分类器**只认固定前缀**再退回启发式，
> 避免被上游文案里的「401」带偏。同时：`STATUS_TIMEOUT_MS` 30s→35s（必须大于
> connect 内部的 30s 计费超时才能拿到真实原因）、`FAIL_THRESHOLD` 5→8（约 4 分钟）、客户端整体请求
> 超时 30s→40s（必须大于 Host 的 35s）。详见 [v0.8.5 发布说明](docs/release-notes-v0.8.5.md)。

## 2. 关键路径

| 用途 | 路径 |
| --- | --- |
| **本项目（开发仓库）** | `E:\WorkSpace\DSH\DSH Usage Dock` |
| 已安装的插件副本 | `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock` |
| DSH 桌面端本体 | `D:\DeepSeek Harness\resources\app.asar\dsh` |
| DSH CLI（桌面端自带） | `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 插件配置（DSH 托管） | `C:\Users\Slacom\.dsh\profiles\desktop\cordis.patch.yml` → `plan-usage` 条目 |
| GitHub | https://github.com/Slacom/dsh-usage-dock |
| npm | https://www.npmjs.com/package/dsh-usage-dock |

> ⚠️ `app.asar` 是 **121MB 的归档文件**，Node/PowerShell 等独立进程**无法**直接读里面的路径；
> 只有 DSH 运行时会注入 asar 支持。用 `dsh.cmd` 调 CLI，不要试图 `node <asar内路径>`。

> 📁 **本项目位于 DSH 工作区之外（E 盘）**。DSH 沙箱首次访问该目录时会自动做一次 ACL 诊断，
> 并为当前用户补上完全控制权限（这是必要的，否则读写会失败），同时在 `E:\WorkSpace\DSH\` 下
> 留下 `acl-recovery-<slug>/` 目录（含原始权限备份与回滚脚本）。诊断结论若为 `rollback: not-needed`，
> 该目录即可删除——**不要**按回滚脚本恢复原权限，那会让沙箱重新无法访问。

## 3. 架构

```
index.js          Host 半：导出 Config schema、注册 /api/plan-usage 路由、编排各渠道取数
client.js         Browser 半：侧栏胶囊 + 「内置插件」里的设置页（单文件，零构建）
plans/index.js    渠道注册表（新增渠道只需在此登记；0.9.0 起导出 RETIRED_PLAN_IDS）
plans/<渠道>.js   每渠道一个模块，统一接口 { id, name, fields, schema, source, fetch }
plans/custom-balance.js  [0.9.0] 通用自定义余额：JSON 键路径、数值语义、URL/DNS 安全、
                  请求（GET+Bearer、不跟随重定向、响应体上限）、错误分类、整批调度、状态摘要
plans/util.js     共用工具：curlJson（原生 fetch / Python / curl 三后端自适应）、窗口归一化、凭据解析
plans/peak-phase.js  DeepSeek 峰谷计价相位纯函数（峰窗口/周末/假日表，0.8.0）
plans/http-fetch.py  兜底取数脚本（Windows 沙箱内 curl 的 TLS 不可用时的 Python/OpenSSL 方案）
cordis.patch.yml  插件向 profile 贡献的配置层（insert 一个 plan-usage 条目）
tools/test-fetch-backends.mjs  取数后端 + DeepSeek 渠道回归测试（见第 4 节）
tools/mock-react.mjs           浏览器半测试共用的极简 React 运行时 + client.js 加载器
tools/test-collapsed-pill.mjs  浏览器半回归测试：缩略（rail）状态不可交互（见第 4 节）
tools/test-footer-row.mjs      浏览器半回归测试：胶囊独占侧栏底部一行（见第 4 节）
tools/test-degrade-refresh.mjs 浏览器半回归测试：失败降级/取整/强刷/峰谷条/充值按钮/MiMo（0.8.0）
tools/test-peak-phase.mjs      plans/peak-phase.js 单元测试（0.8.0）
tools/test-mimo-parse.mjs      plans/mimo.js 纯函数单元测试（0.8.0）
tools/test-custom-balance.mjs        [0.9.0] 自定义余额纯函数：路径/数值/扣减/URL/状态/代次
tools/test-custom-balance-fetch.mjs  [0.9.0] 自定义余额网络层：请求形态/凭据/错误/并发/预算
tools/test-custom-settings.mjs       [0.9.0] 设置页自定义区 + 渠道退场 + Key 路径写入
tools/test-custom-render.mjs         [0.9.0] 胶囊/详情/灰化→第8次错误/恢复/代次作废/停用删除
tools/test-custom-security.mjs       [0.9.0] 秘密哨兵/重定向/DNS/上限/迟到响应
tools/test-host-custom.mjs           [0.9.0] 真实 apply() 路由端到端（退场不取数、秘密不外泄）
tools/test-review-fixes.mjs          [0.9.0 整改] R1/R2/R5 + 连接期绑定（含真实 TLS 往返）
tools/test-custom-race.mjs           [0.9.0 整改] R3/R4/R6 客户端时序与保存事务
tools/test-config-unwrap.mjs         [0.9.0 整改] R7：真实 Config → apply → provider
tools/test-recheck-fixes.mjs         [0.9.0 复核] V1 端口 origin / V3 单条预算 / V4 冷启并发 / V5 截断响应
tools/test-recheck-round3.mjs        [0.9.0 复核] W1 配置证明 / W2 幂等 Key 恢复 / W3 按渠道保留基线
tools/test-recheck-round4.mjs        [0.9.0 复核] X1 双端规范化 / X2 公开修订进入请求身份
tools/test-usage-tool.mjs            [方向6/T1] 投影与脱敏（白名单/数值语义/退场/参数）
tools/test-usage-tool-register.mjs   [方向6/T2] 注册层：契约形状/缓存/single-flight/预算
tools/test-usage-tool-host.mjs       [方向6/T2] **真实 apply**：注册、dispose、开关隔离、环回拒绝
tools/test-usage-policy.mjs          [方向6/T3] 策略：默认关闭/显式关注/保守判定/措辞约束
tools/test-custom-round3.mjs         [0.9.1] 第三/四轮复核：来源删除不复活、观察器身份、单条自定义边界
tools/test-custom-round5.mjs         [0.9.1] 第五轮复核：双卡误写误删、默认折叠、账号选择不白屏
tools/test-workbuddy-gateway.mjs     [0.9.1] WorkBuddy2API 网关：根路径/鉴权/口径/账号筛选/积分包/超时
plans/usage-tool.js                  [方向6/T1] usage_status 投影（纯函数，无 IO）
plans/usage-tool-register.js         [方向6/T2] 工具注册/缓存/预算（不 import 宿主包）
plans/usage-policy.js                [方向6/T3] 可选收尾策略（默认关闭）
```

**已接入渠道**（0.9.1 起）：OpenCode Go、DeepSeek（账号余额优先/API Key 回退）、OpenAI Codex、
小米 MiMo（控制台 Cookie → API 余额）、WorkBuddy（**2026-10-21 起改读 WorkBuddy2API 网关**，
见 `plans/workbuddy.js` 的 `fetchFromGateway`），以及用户自建的
**自定义余额渠道**（0.9.0，任意 HTTPS GET+Bearer+JSON，见第 6 节第 14 条）。

**已退场渠道**：`kimi-code`、`glm-zhipu`、`glm-zai`（0.9.0），以及
`workbuddy-ai`（0.9.1，用户决定全部改走国内网关，不再区分国际版）。
它们的模块文件仍留在 `plans/` 作为历史资料，但 `workbuddy-ai` **已不在 `PLANS` 且进 `RETIRED_PLAN_IDS`**；
不要把它们的 schema 字段或 UI 加回来，除非用户明确要求恢复。

## 4. 开发流程

```powershell
# 1) 在本仓库改代码（不要改 profile 里的副本！）
# 2) 部署到 desktop profile
Copy-Item "<本仓库>\index.js","<本仓库>\client.js" "C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock\" -Force
Copy-Item "<本仓库>\plans\*" "C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock\plans\" -Force
# 3) 重启 DSH 桌面端（client bundle 在插件激活时缓存，改文件不会热生效）
# 4) 浏览器硬刷新 Ctrl+Shift+R
# 5) 交给用户安装测试 —— 用户确认之前不要 push / 打标签 / 发 Release（见第 8 节的推送闸门）
```

**本地自测**（无需重启，能在部署前抓出大部分错误）：

```powershell
# Host 端：语法 + 注册表 + 取数
node --check index.js; node --check client.js
node --input-type=module -e "const m=await import('./plans/index.js'); console.log(m.PLANS.map(p=>p.id))"

# 取数后端 + DeepSeek 渠道回归测试（8 项，含「平板场景」复现；T4/T5 需出网）
node tools/test-fetch-backends.mjs

# 浏览器半回归测试：缩略（rail）状态下胶囊必须不可交互（4 项，离线，无需 React 依赖）
node tools/test-collapsed-pill.mjs

# 浏览器半回归测试：胶囊独占底部一行、排在最上面、外观对齐侧栏按钮（11 项，离线）
node tools/test-footer-row.mjs

# 上面两个 client 测试共用 tools/mock-react.mjs（极简 React 运行时 + client.js 加载器）
# 客户端（设置页）：同上思路，mock window.__ModuleLoader__ + React + ctx.slots/configForms
# 历史上抓到过两次真实错误（设置页白屏、this 丢失）
```

> 回归测试需要 `@deepseek-ai/schemastery`（渠道模块的 import）。仓库里没有它的副本时，
> 测试会把这部分记为 SKIP；要跑全量，从已安装的 profile 复制三个包到仓库 `node_modules/`
> （该目录已被 .gitignore 排除）：
>
> ```powershell
> $src='C:\Users\Slacom\.dsh\profiles\desktop\node_modules'
> New-Item -ItemType Directory -Force "$PWD\node_modules\@deepseek-ai","$PWD\node_modules\@standard-schema" | Out-Null
> Copy-Item "$src\@deepseek-ai\schemastery","$src\@deepseek-ai\cosmokit" "$PWD\node_modules\@deepseek-ai\" -Recurse -Force
> Copy-Item "$src\@standard-schema\spec" "$PWD\node_modules\@standard-schema\" -Recurse -Force
> ```
>
> 注意：**不要**用 junction/symlink 指向 profile——DSH 沙箱禁止创建重解析点（拒绝访问）。

## 5. DSH 0.2.0 API 契约（★ 踩坑记录，务必先读）

DSH 0.2.0 相对 0.1.x 有**破坏性变更**，以下每一条都是实际踩过的：

| # | 坑 | 正确做法 |
| --- | --- | --- |
| 1 | `ctx.settings.register(ns, Schema)` **已被移除**（调用即启动失败） | 改为 `export const Config = z.object({...})`，DSH 据此托管配置 |
| 2 | DSH 的设置表单**只展示 `.volatile()` 字段**，没加就没有设置页 | 每个要展示的字段都加 `.volatile()`（本项目在 `planSchemaFields()` 里统一加） |
| 3 | 设置页 tab **不是自动生成**的，要自己注册 | 注册 `settings.plugins.tab` 席位并提供页面组件；参考 `dsh-codex-connect` |
| 4 | `ConfigFormController` 的 `getSnapshot/subscribe/set` **依赖 this**，直接传方法引用会丢 this → 页面白屏 | 包一层再传给 React（见 `useConfigSnapshot`） |
| 5 | 插件配置**运行时不热重载 Host 半**（官方提示「下次启动生效」） | 客户端订阅 `configForms` 做实时过滤，保存即生效 |
| 6 | 账号余额 Remote 返回的是**投影结构**，不是 Platform 原始响应 | `getBalance(client)` 返回 `null \| {status:"ready", value:[钱包], bonusWallets:[钱包]} \| {status:"failed"}` |
| 7 | 侧栏底部席位 | 用官方公共席位 `sidebar.footer.action`（list），**无需改 DSH 核心包** |
| 8 | 设置页读取的是 `entry.fiber.runtime.Config` | 插件必须导出 `Config`，且 loader 已激活该条目 |
| 9 | Windows 沙箱内 curl 无法完成 TLS 握手（`SEC_E_NO_CREDENTIALS`） | 用随附的 Python 脚本取数；`util.js` 已做 Python⇄curl 自适应 |
| 10 | **移动端（Android APK）没有任何取数命令**：设备上没有 python，curl 也不可用，于是「shell + 外部命令」这条路全断，DeepSeek 用 API Key 只能显示「upstream request failed」（0.6.1 的真实故障） | **在 Host 进程内用原生 fetch**（`util.js` 的 fetch 后端，0.6.2 起首选）；移动端宿主本身能出网（模型请求、codex-connect 都在同一个进程里跑 fetch），所以这条路一定通；Python/curl 退化为兜底 |
| 11 | 裸的 `fetch` 报错只有一句 `fetch failed`，看不出 DNS/TLS/代理原因 | 读 `err.cause` 的 `code`/`message` 一并带上（见 `fetchBackend`）；失败信息里同时点名失败后端与退出码 |
| 12 | **侧栏缩略（rail）后 slot 仍照常渲染**：`sidebar.footer.action` 的 `wide` 由 sidebar 经 ownerProps 注入（`renderSlot(name, { wide })`，其值为 `!collapsed \|\| !settled`）；rail 宽度只有约 **56px** | 缩略状态不要挂 `onClick`、也不要渲染 `position:absolute; width:100%` 的面板——它会被压成一条竖排乱码（0.6.3 的真实故障，移动端 Web UI 才看得出来，桌面端侧栏够宽所以不显现）。详情面板只在展开态渲染（`open && wide`），否则「先展开点击、再折叠」时 effect 生效前会闪一帧 |
| 13 | **`sidebar.footer.action` 是多个插件共享的同一条横向 flex 行**（0.1.x 核心包里叫 `footerActions`，规则就是 `display:flex`，且默认 `nowrap`）。装了两个及以上用该席位的插件时（本插件旧 `order:10`、`ds-harness-remote` `order:-20`），它们会挤在同一行互相抢宽度，本插件被压窄导致内容显示不全（0.7.0 的真实故障） | 不要用 `flex:1 1 auto` 去参与这一行。挂载后**运行时探测**最近的 `flex-direction: row` 祖先，给它补 `flex-wrap: wrap`，并把胶囊声明为 `flex-basis:100%`——这样胶囊独占一行，其他插件各自成行，上下顺序交给各自的 slot `order`（见 client.js 的 `useOwnRow`；本插件取 `order:-1000` 排到最上面，向上展开的详情面板就不会挡住别人）。注意：**纵向**容器（旧版 `footArea` 是 `column`）绝不能加 wrap / basis:100%，那会被解释成高度并压扁同列条目。用运行时探测而非写死类名，是因为 DSH 的 CSS Module 类名带哈希、跨版本会变，而 `:has()` 在旧版 Android WebView 上不保证支持 |
| 14 | **行内样式优先级高于任何选择器**：元素上一旦写了行内 `background`，再注入 `.x:hover{background:…}` 也**永远不生效**（0.7.0 第一版的真实故障：鼠标移上去没有灰底，但 `title` 提示照常弹出——「提示能弹、样式不变」正是这类问题的关键线索，说明 `:hover` 在触发、只是被行内盖住） | 交互态（hover / focus）**用 React 状态写行内**，别指望 CSS 伪类去覆盖行内：`onMouseEnter/onMouseLeave/onFocus/onBlur` 切一个 `hot` 状态直接决定行内底色。行内只保留交互态不会覆盖的属性；`appearance:none` 用来去掉 `button` 的原生外观（否则会回落到系统灰底） |
| 15 | **该行还会给条目留内距**：`sidebar.footer.action` 的整行可用宽度是 x 10..339，但条目内容区只有 x 15..334。只写 `width:100%` 的话，悬停底色会比同容器里的 Remote **左右各短约 5px**（0.7.1 的真实故障，靠量真机截图的像素才发现：Remote 灰底 330px / 我们 320px） | 照抄 `ds-harness-remote` 的向外贴边写法：`.dshRemoteSidebarEntry.isWide{width:calc(100% + 8px);height:34px;margin:4px -4px}` → 本插件在 client.js 里用 `ROW_BLEED = 4`，展开态给根节点 `width:calc(100% + 8px)` + `margin:0 -4px`。**缩略（rail）态绝不能贴边**（rail 仅约 36px 宽，外扩会溢出）。量像素的办法：用打包的 Python + Pillow 找悬停灰底 `#ECEEF0` 的逐行游程，比肉眼可靠 |
| 16 | **同一件事在 DSH 里有三个不同宽度，别量错基准**（2026-10-10 实测，同一张截图的绝对值）：DSH 自带列表行（工作区／「调试」悬停）= x 15..334 = **320px**；同容器里的 `ds-harness-remote` 条目 = x 10..339 = **330px**；「新会话」按钮的常驻边框 = x 23..324 = **302px**（那是按钮表面，不是悬停底色） | 本插件**按 330px 对齐 Remote**——同一容器里的直接邻居；这是用户看过三者数据后**明确选定**的基准（2026-10-10），**不要**因为「DSH 原生行是 320」就擅自改回去。若将来 DSH 改了内距，重新量一遍再决定 |
| 17 | **`var` 没有块级作用域：组件里的同名局部变量会静默遮蔽模块级样式常量**。0.7.1 在组件内写了 `var rowStyle = null`（本意是根节点的贴边样式），把模块级给**详情面板额度行**用的 `var rowStyle = {display:'flex',…}` 遮蔽掉了 —— 面板里所有额度行丢掉 `display:flex`，进度条塌成 0 宽度直接消失，真机表现是「Codex 没有额度条了、标签和百分比竖着堆」（2026-10-10 用户发现的真实故障，是 0.7.1 引入的回归） | 组件作用域内**不要复用模块级样式常量的名字**；本插件已把贴边样式改名 `ownRowStyle` 并在注释里写明禁令，新增样式常量前先 grep 同名。守卫用例：`test-footer-row.mjs` 的 **T10**（打开面板、遍历组件树，断言额度行仍是 `display:flex` 四列结构且进度条轨道与百分比填充都在）——它先在 v0.7.1 上失败、在修复版上通过 |
| 18 | **column 方向的 flex 容器里，`justifyContent` 管的是纵轴**。胶囊是 `flexDirection: column`，所以折叠态想「让状态点水平居中」写 `justifyContent:'center'` 是无效的；子项还因默认 `align-items: stretch` 被拉成满宽，圆点贴在左端（0.6.3→0.7.1 一直如此，2026-10-10 用户发现） | 横向居中要用 **`alignItems:'center'`**（子项按内容宽度居中）。**只改缩略态**、展开态保持 `undefined`（默认 stretch），否则会动到「圆点 + 名称 + 数值」的横向位置。守卫用例：`test-footer-row.mjs` 的 **T11** |

**账号余额调用方式**（Host 端）：

```js
const account = ctx.get("deepseekAccount")   // 服务名；仅在 Desktop 组合里存在
const summary = await account.getBalance({ version, locale, timezoneOffsetSeconds })
// summary.status === "ready" → summary.value / summary.bonusWallets
```

## 6. 相对上游的定制

1. **显示位置**：右下角悬浮 → 左侧状态栏（官方公共席位 `sidebar.footer.action`，零核心补丁）
2. **DeepSeek 双数据源**：DSH 账号余额优先（含赠金，无需 API Key），API Key 回退
3. **可配置余额警告额度**：`deepseekWarnThreshold`，默认 10 元，0 表示不警告
4. **OpenAI Codex 订阅额度**：复用 `dsh-codex-connect` 的公开额度 API，不碰 token
5. **独立设置页**：在「设置 → 内置插件 → Usage Dock」里勾选渠道、填 Key，带保存/放弃
6. **取数后端自适应**：原生 fetch（首选，Host 进程内）⇄ Python shim ⇄ curl 自动选择，
   只有传输层失败才换下一个后端；上游答复（含 HTTP 错误）立即返回
7. **刷新间隔**：60 秒 → 30 秒
8. **缩略（rail）状态胶囊不可交互**：折叠后只剩状态圆点，且不挂点击、不渲染详情面板
   ——详情只在展开状态点击打开（0.6.3，移动端 Web UI 反馈）
9. **底部席位独占一行、且排在最上面一行**：胶囊不再与其他插件（如 Remote）抢同一条横向行，
   而是整行独占、上下排列；席位 `order` 取 `-1000`，这样向上展开的详情面板不会遮挡别的按钮；
   外观也与侧栏按钮对齐（默认透明、无边框无阴影，悬停才出灰底）——0.7.0，做法见第 5 节第 13 条。
   **圆角/内距照抄侧栏条目**：`border-radius:12px` + `padding:6px 10px`，出处是 DSH 自带
   「新会话」按钮与 `ds-harness-remote` 的 `.dshRemoteSidebarEntry.isWide .dshRemoteModeButton`
   （`iconButton` 那类 28px 圆形按钮用 50%，与条目不通用）——改这两个值前先回去核对，别凭感觉调
10. **失败降级 + 点击强刷**（0.8.0）：取数失败保留上次成功值、灰字弱化，连续 2 轮失败才显示
   「获取失败」（不加「更新于」标注，用户定稿）；点开详情面板 / 窗口 focus /
   visibilitychange 时**作废 in-flight 请求立即重拉**；余额向下取整到分（对齐设置页截断）
11. **DeepSeek 充值入口**（0.8.0）：面板余额行「充值」按钮，经 preload 暴露的
   `dshPlatform.open("top-up", bounds)` 打开**原生充值页**（bounds 必须是合法的
   `{x,y,width,height}` 数值对象，缺失会被主进程拒绝）；仅账号登录 + 桌面端（有桥）时渲染，
   浏览器/移动端无桥、不渲染也不做外链回退（用户确认）
12. **DeepSeek 峰谷时间条**（0.8.0）：classic 样式（照抄 dsh-cost-meter `cm-peak-classic`），
   相位计算在 `plans/peak-phase.js`（纯函数，峰窗口 UTC 1-4/6-10、周末与假日全谷价），
   host 在 `/api/plan-usage` 响应里给账号登录的 DeepSeek 条目附 `peakPhase`；假日表硬编码，
   国务院公布新年份安排时在 `PEAK_HOLIDAYS` 里追加
13. **小米 MiMo 渠道**（0.8.0）：控制台 Cookie 鉴权（非 API Key，需 userId + serviceToken），
   只查 `GET /api/v1/balance` 显示账户余额（用户明确：不做套餐积分额度）；
   `util.js` 的 `parseResult` 已放行 `{code:0}` 成功信封（code 非 0/非 200 才是错误）
14. **自定义余额渠道**（0.9.0）：用户在设置页最下方自建「厂商名称 + HTTPS 余额 URL + API Key
   / 模型凭据引用 + JSON 键路径（可选扣减键、币种）」，每条一条胶囊行与一个详情分区。
   实现要点：
   - 取数在 `plans/custom-balance.js`，**只用原生 fetch / `node:https`**（不回落 Python/curl，
     否则会绕过 URL/重定向限制）；有已核验地址时走 `node:https` + 固定 `lookup`
     （见第 7 节「连接目标绑定」），`redirect` 不跟随，DNS 结果必须全部公网，
     响应体 ≤256 KiB，单条 10 s / 整批 20 s、并发 3、最多 12 条；
   - **Key 不进 `customBalances`**：它在 `customKeys`（`z.dict(z.string().role('secret'))`）。
     这是刻意的：DSH 的 settings 投影会把 secret 从 `value` 里剥掉，浏览器拿不到已有 Key，
     若 Key 在数组元素里，客户端回写整个数组会把其它条目的 Key 抹掉。设置页因此用
     `form.mutate([{op:'set'|'unset', path:['customKeys', id]}])` 精确写入，且输入框永不回填；
   - `role('secret')` 的剥除与 `mutate` 的数组/路径寻址语义，是按 `dsh-settings` 的
     `redactSecrets` / `applyPathOp` 与 `dsh-api-settings-controller` 的 `namespaceView`
     源码核对的（remote `describe` 一律 `redactSecrets: true`）；
   - 每条 wire 结果带 `gen`（身份字段 + Key 的 SHA-256 前 12 位），代次一变客户端就作废旧值
     与失败计数，防「旧账户余额配新 URL」；
   - 暂时错误（网络/429/5xx/结构）灰化保留旧值、连续 8 次转纯错误；鉴权（401/403）、
     配置（坏 URL/坏路径）、缺 Key 一律**立即提示**，不用旧值掩盖。

## 7. 已知限制

- 0.8.1 的 Host 已通过可选 `configEditor` 重读配置（2 秒内复用）；缺少该服务的旧版/移植端回退启动快照，修改凭据和 Host 开关后仍需重启引擎。显示层过滤与排序订阅表单。
  （0.9.0 起 `cfgValue()` 能正确解包 volatile 包装，因此**开关本身**在没有 configEditor 的
  部署里也生效；但「改完不重启就换 Key」仍要求 configEditor。）
- **国内 WorkBuddy**（0.9.1 起）不再依赖 WorkBuddy Connect：改为读「设置 → 模型」里 `workbuddy`
  网关配置，访问 `<origin>/status` 根路径并复用该来源的 Bearer Key。因此它依赖**模型配置里
  确实存在该 provider**，且该网关在运行。国际版 `workbuddy-ai` 已退场。
  源码/模拟检查通过不等同所有 DSHA 设备真机验证。
- 原生 fetch **不读系统代理设置**（Node/undici 默认行为）。必须走代理出网的环境里首次请求会先
  失败一次（最多 10 秒），随后自动落到会读代理的 Python shim 并被记住——功能不受影响，只是首次稍慢。
  若要让 fetch 直接支持代理，可给 Host 进程加 `NODE_USE_ENV_PROXY=1`（Node 24+）。
- **自定义余额渠道**（0.9.0）：
  - 只支持 `GET` + `Authorization: Bearer` + JSON；**没有** Cookie / OAuth / 签名 / GraphQL /
    网页抓取 / 套餐窗口，也没有厂商特例。
  - **OpenRouter 类响应未经真机核验**：本轮抓取官方文档被本机网络策略拦下（域名解析到
    非公网地址），因此只声明「支持直接返回剩余值的接口」与「可用可选扣减键表达
    累计额度 − 累计用量」，不声称已验证该厂商兼容。累计充值不会自动被当成余额。
  - **连接目标绑定（已整改，不再是 best-effort）**：先 `resolveValidatedAddresses()` 把域名解析成
    **全部**公网 IP（任一是私网/环回/链路本地/云元数据即整体拒绝），再用 `node:https` +
    `makeLookup()` 把 `lookup` 钉死在这份地址上——检查的 IP 就是连接的 IP，DNS 重绑定窗口被消除。
    `servername` 仍是真实域名（TLS SNI 与证书校验按域名），**从不关闭**证书校验，不跟随重定向。
    拿不到 `node:https` 时返回 `unbound` 并**保守拒绝**（不发凭据），不会静默降级。
    残余风险：若运行时的 `node:https` 行为被宿主改写，绑定即失效——本项目不作此假设，但不声称绝对。
  - 没有低余额告警阈值（不继承 DeepSeek 的 10 元）；需要时另开需求。
  - `/api/plan-usage/custom-status` 是 0.9.0 新增的只读路由（只回布尔），扩大了对外接口面。

## 8. 发布

> ⛔ **推送闸门（用户 2026-10-08 明确要求，优先于本节其余内容）**：
> 版本构建完成后**不要急着 push / 打标签 / 发 Release / npm publish**。
> 先在本地部署、由**用户安装测试**，**用户确认没问题之后**才做推送与发布。
> 反例：0.6.3 是在用户测试前就推送并发了 Release，用户随后纠正了这一点。
> 如果用户需要**在平板等其它设备上试装**（那些设备只能从 npm / GitHub 取包），
> 先问用户希望怎么给包，不要自行推送。

用户确认测试通过之后的发布次序：

```powershell
# 1) 改 package.json 版本号 + 更新文档（含 docs/release-notes-v<版本>.md）
# 2) 提交并推送主干
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin main

# 3) 打标签并推送（标签命名 v<版本号>）
git -C "E:\WorkSpace\DSH\DSH Usage Dock" tag -a v0.6.4 -m "dsh-usage-dock v0.6.4"
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin v0.6.4

# 4) GitHub Release（见下）

# 5) npm 发布 —— 由 agent 执行（用户 2026-10-10 起授权，别再让用户手动跑）
npm publish --dry-run      # 先核对打包内容与 shasum
npm publish                # Automation token 已配置，非交互可直接发
```

> ✅ **npm publish 现在由 agent 负责**（用户 2026-10-10 明确授权：「之后 npm 也由你来推送」）。
> `~/.npmrc` 里是一个 **Automation 类型的 token**（绕过 2FA），所以 `npm publish` 非交互可完成，
> 不需要用户输验证码。发布前先 `npm publish --dry-run` 核对（0.7.0 为 16 个文件 / 38.9 kB）。
>
> ⏳ **两个时间点要记住**：
> - 该 token 创建于 **2026-10-08、有效期 90 天**（约 **2027-01-06** 到期）——到期后发布同样会报
>   401/E404，需要用户重新生成一个 Automation token 并写进 `~/.npmrc`；
> - npm 已公告 **2027 年 1 月**起取消「bypass-2FA token 直接发布」的能力，届时要么走
>   Trusted Publishing（仅 CI 场景），要么回到人工 `npm publish` + OTP。
>
> ⚠️ **token 失效的假象（2026-10-08 实测，浪费过一次排查时间）**：`npm login` 在 10-06 12:28
> 写入的 token 当天 14:15 还能发布 0.6.2，两天后同样的命令变成
> `npm whoami` → **401 Unauthorized**、`npm publish` → **E404 Not Found - PUT
> https://registry.npmjs.org/dsh-usage-dock**。
> 「404 找不到包」极具迷惑性（包确实存在、账号也是 maintainer），**根因是凭据失效**，
> 与包名、scope、权限、代码都无关。排查顺序固定为：
> `npm whoami`（401 = 凭据问题，先解决它）→ `npm publish --dry-run`（打包是否正常）→ 再真发。

> ℹ️ **发布成功后 registry 有短暂延迟**（2026-10-08 实测约 **2 分钟**）：`npm publish` 打印
> `+ dsh-usage-dock@0.6.3` 和 “Your package is being processed and may take a few minutes to
> become available.” 之后，服务端才真正对外生效。这段时间 `npm view <pkg> version`
> **读的是本地缓存**，会继续显示旧版本（连查两次都一样），极易误判成发布失败。正确校验方式：
> `npm view dsh-usage-dock@0.6.3 version --prefer-online`，或直接请求版本端点
> `https://registry.npmjs.org/<pkg>/<version>`（200 = 已上线）。也可以比对线上 `dist.shasum`
> 与本地 `npm publish --dry-run` 的 shasum，确认线上产物就是被测过的那一个
> （0.6.3 两者一致：`2c76b6a38b0a11522bfbb5f08306d4b5b0d54523`）。

**GitHub Release**：本机**没有装 `gh`**，用 REST API 创建即可（已验证可行）：

```powershell
# 凭据从已存的 git 凭据里取（本机装了 GCM；token 不要打印出来）
$token = (("protocol=https`nhost=github.com`n`n" | git credential fill) -replace '^password=','' |
  Where-Object { $_ -notlike 'protocol=*' -and $_ -notlike 'host=*' -and $_ -notlike 'username=*' })
# 然后 POST https://api.github.com/repos/Slacom/dsh-usage-dock/releases
#   { tag_name, name: '<tag 名，如 v0.8.4>', body（markdown，UTF-8 字节发送）,
#     draft:false, prerelease:false, make_latest:"true" }
```

- **Release 标题统一用 tag 名**（`v0.8.4`、`v0.7.2`…），不要再写「dsh-usage-dock v0.8.4」或
  「v0.7.2 — 某某修复」这类描述性标题；`/releases` 列表和「Latest」徽标才整齐可扫。
- **必须带 `make_latest:"true"`**（仅正式版；预发布用 `prerelease:true` + `make_latest:"false"`）：
  用 REST API 建的 release 不会自动抢「Latest」，2026-10-17 就是因为漏了它，
  `/releases/latest` 一直停在 v0.8.2。事后修正：`PATCH /releases/<id>` 传 `{ make_latest:"true" }`。
- **正文只写「改了什么 / 解决了什么问题 / 怎么解决」**：面向用户、3–8 条，标题已经给出
  版本号就不要再重复标题。**不要**写像素值、CSS 属性名、内部类名/事件名、宿主实现细节
  （用户 2026-10-17 明确要求，0.8.2 那种「对齐到 330px、差 5px」的写法不再使用）。
  工程细节留在 `docs/release-notes-v<版本>.md` 的「工程细节（维护者用）」小节。
  0.8.3 起的文档都带「更新摘要（GitHub Release 正文）」小节，Release 正文直接取该节；
  更早版本（0.6.2–0.8.2）的文档只有工程细节，其 Release 正文已于 2026-10-17 在 GitHub 上改写。
- **README 不写版本号 / 「本版」说明**（用户 2026-10-17 要求）：README 只描述能力、用法与兼容性，
  版本信息以 npm 徽标和 Releases 为准；安装命令写成不带版本号的
  `dsh plugin --profile web add dsh-usage-dock`，避免每次发版都要改 README。
- 发布说明写在仓库里（如 `docs/release-notes-v0.6.2.md`），既进版本库、又可直接作为 Release 正文；
- 历史：**v0.6.2 是本仓库的第一个 tag 与第一个 GitHub Release**；npm 上 0.4.x/0.5.x/0.6.0
  从未单独发布，用户是从 `0.3.0` 直接跳到 `0.6.1`/`0.6.2` 的——写发布说明时注意这一点，
  否则「相比上一版」会漏掉一大段变更。

## 9. 目录说明

| 目录 | 内容 | 是否入库 |
| --- | --- | --- |
| 根目录 | 插件本体（index/client/plans/package.json/…） | ✅ 会发布到 npm |
| `docs/` | 开发文档、安装指南、迁移记录 | ✅ |
| `tools/` | 辅助脚本（如 DSH 侧栏补丁重放） | ✅ |
| `legacy/` | 历史补丁包、旧备份仓库、诊断报告 | ❌ 仅本地（.gitignore 排除） |
| `reference/` | 第三方参考源码（如 dsh-codex-connect） | ❌ 仅本地 |

## 10. 历史脉络（简）

1. 最初是上游 `dsh-plan-usage` + Termux 侧栏补丁（见 `docs/plan-usage插件修改记录.md`）
2. 新增 DeepSeek 余额、Codex 额度；侧栏方案从「改 sidebar 核心包」改为「注册官方席位」（零补丁）
3. DSH 升级到 0.2.0 后适配了大量 API 变更（见第 5 节），改名 `dsh-usage-dock` 并发布 npm
4. 加入独立设置页、可配置阈值、保存/放弃按钮、实时配置过滤
5. 0.6.2 修掉移动端（Android APK）取数全断的问题：改为 Host 进程内原生 fetch，
   Python/curl 降级兜底；顺带补上逐后端失败原因与 8 项回归测试
6. 0.6.3 修掉移动端 Web UI 侧栏缩略时点击状态点弹出竖排乱码面板的问题：
   缩略状态不再挂点击、面板只在展开态渲染；新增浏览器半回归测试（4 项）
7. 0.7.0 修掉底部席位多个插件挤同一行的问题：胶囊改为整行独占、席位 `order:-1000` 排到最上面
   （详情面板向上展开不再遮挡其他按钮），外观也改成与侧栏按钮一致（透明 + 悬停灰底）；
   新增 footer 行回归测试（8 项），并把浏览器半测试的 mock 运行时抽成 tools/mock-react.mjs
8. 0.7.1 修掉悬停灰底比别家按钮两侧各短约 5px 的问题（照抄 Remote 的 `+8px / -4px` 向外贴边，
   见第 5 节第 15 条）；footer 行测试增至 9 项（新增「缩略态不得贴边」）
9. 0.7.2 修两个显示问题：① 0.7.1 因 `var rowStyle` 遮蔽导致**详情面板额度条消失**
   （见第 5 节第 17 条）；② 缩略态状态点贴左 → 水平居中（见第 5 节第 18 条）。
   footer 行测试增至 11 项（T10 面板额度行、T11 缩略态居中），两条都先在 v0.7.1 上失败
10. 0.8.0 功能版：失败降级（保留旧值+灰字+2 轮失败）与轮询防卡死、余额向下取整到分、
   点击展开即刷 + focus 同步（充值后余额不再停在旧值）、DeepSeek 充值入口（原生 top-up 页）、
   DeepSeek 峰谷时间条（classic）、新渠道小米 MiMo（控制台 Cookie → API 余额）。
   回归测试从 23 项增至 88 项（新增 degrade-refresh 22 / peak-phase 22 / mimo-parse 21）；
   期间抓到并修掉一个真实回归：降级转错误态时必须剥离旧 balance 字段，否则胶囊拿旧值顶替
11. 0.8.2（2026-10-15）：DSHA WorkBuddy「fetch failed」修复——宿主 dsh-web-mobile
   `compress.js` 与 gzip 中间件在「<1 KiB 且带 Content-Length」响应上互相踩踏致连接被
   reset（根因与宿主侧修复建议见 `DHSA移植反馈/交接文档-0.8.2修复.md`）。消费侧两处绕过：
   ① status 请求声明 `accept-encoding: identity`；② 失败降级——任一版本拿到 credits 即
   展示合计并带 `partial`/`partialNote`，客户端渲染灰色脚注，全部失败才维持原分类。
   另加：详情卡片点击外部/Esc 自动关闭（pointerdown 捕获 + parentElement 上溯 +
   Shadow DOM composedPath）、面板从胶囊向上展开渐变动画（WAAPI 170ms，无 WAAPI 静态
   降级）、峰谷条游标改方案 K「上下对尖」（上下三角夹住「现在」，白柱与轨道内覆盖物
   全部移除）。测试：workbuddy 22 项、panel-interactions 8 项（新增）、peak-marker
   144 几何断言（改方案 K）；mock-react 对齐 effect cleanup 与 mock DOM 父子链语义。
12. 0.8.3（2026-10-16 / 17，**已正式发布**：GitHub Release + npm `0.8.3`，桌面端与平板实测通过）：
   WorkBuddy 积分改「✦ 」前缀、WorkBuddy 与 WorkBuddy AI 拆成两个独立渠道
   （可分别开关与排序）、DeepSeek 充值/赠金分行、胶囊数值右对齐、超时 30s / 失败阈值 5、
   API Key 模式也渲染峰谷条，并新增 `tools/test-line-endings.mjs`（21）守卫 LF/CRLF 混改；
   另含详情卡片「点空白偶尔不关」兜底：按下类事件三路（pointerdown/mousedown/
   touchstart）+ click 兜底，`downInside` 去重防拖选误关，panel-interactions 8 → 11。
   已知无法修复的盲区：窗口顶部 `-webkit-app-region: drag` 拖拽条与原生滚动条不产生 DOM 事件。
13. 0.8.4（2026-10-17，**已正式发布**：GitHub Release + npm `0.8.4`，用户真机确认提示卡可覆盖胶囊）：DSH 官方通知卡（左下角悬浮、portal 挂在页面尾部）
   出现时与胶囊文字互相穿透。像素测量确认胶囊是**全对比**画在通知卡白底之上 → 我们在上；
   根因是 `rootStyle` 的 `zIndex:1000`（第一版就有）。改为默认 `auto` 后由 DOM 顺序决定，
   通知/浮层自然覆盖胶囊。footer-row 测试 11 → 12（T12 守住「胶囊不得带正 z-index」）。
14. 0.8.5（2026-10-18，本地构建）：胶囊「获取失败」过多。根因是 `plans/workbuddy.js` 把
    `creditsError` 一律译为 `error:'api'`（客户端视为语义错误 → 立即透传、不灰化）。
    改为按 connect 的 `classifyUpstreamError` 类别分流（session_dead/hard_credit 语义，其余暂时），
    并给条目加 `transient:true`；客户端 `settle()` 显式信任该标记。阈值 5 → 8，
    两端超时 30/30s → 35/40s。workbuddy 26 → 27、degrade-refresh 42 → 43。
15. 0.9.0（2026-10-18，**仅本地构建**：未提交、未打标签、未推送、未发布）：
   三渠道退场（`kimi-code` / `glm-zhipu` / `glm-zai`，双端注册表 + 设置 + 排序 + 后台取数）+
    通用自定义余额渠道（`plans/custom-balance.js`，设置页最下方可多条增删改启停排序，
    与内置渠道共用整页草稿；Key 走 `customKeys` secret dict 的路径写入）。
    实现期间抓到并修掉的真实问题：① `orderedIds()` 把退场 id 留在排序数组里，箭头点了「没动」；
    ② 自定义条的鉴权错误在胶囊里只显示笼统「获取失败」，没给出「鉴权失败」这一可操作提示；
    ③ `redirect:'error'` 的错误原因藏在 `err.cause` 里，只看顶层消息会误报成「网络不可达」；
    ④ 超时只靠 `AbortSignal` 时，不理会 signal 的 transport 会把整批拖死（改为请求层 race）。
    另修正既有缺陷：volatile 字段是 `{get()}` 包装，0.8.x 的 `cfg.enabled === false` 判断
    在没有 configEditor 的部署里恒不成立。回归 19 组 632 项通过；**不等于真机验证**。
    随后按独立审查整改 R1–R7 与连接目标安全（见本节开头与
    [整改记录](docs/remediation-v0.9.0.md)）：预算贯穿全流程、代次改用实际凭据、配置变化即时作废、
    错误行保留身份、显式 Key 也受目标绑定、保存改为「先校验后一次 mutate」、统一解包 volatile，
    并把 SSRF 防护从 best-effort 升级为 `node:https` 连接期 IP 绑定。整改后 21 组 732 项通过。
    随后第二轮复核（V1–V5）又修了端口 origin、已渲染数据作废、单条预算、
    HTTPS 冷启动并发与截断响应；第三轮复核（W1–W3）改为 Host 出配置证明
    （`data.cfg.digest` + 非密 `customKeyRev`）、按渠道保留基线与失败计数；
    第四轮复核（X1–X2）统一了双端摘要的字段规范化，并让公开 Key 修订进入请求身份；
    **方向 6 已实施**（`usage_status` 只读模型工具 + 默认关闭的收尾策略）。
    方向 6 首次复核后又整改 D6-A～D6-H。全量 **33 组 1328 项通过**。

## 11. 未来方向（roadmap）

完整记录在 **[docs/roadmap.md](docs/roadmap.md)**，排新版本时从那里取。当前待做：

1. **方向 5：Agent 协作更新/安装（独立排期，不并入当前 0.9.0）**：插件不能自我替换，
   保留「只读检测 → 用户复制提示词 → 外部 Agent 安装」方向。规划中的协议文档与
   `tools/verify-install.mjs` 在当前检出均缺失，不得假定已交付；校验来源、安装一致性与
   恢复方案尚需补证。**永不自动重启 DSH**。详见 roadmap 方向 5。

   **0.9.0 最新规划（2026-10-18）**：新增方向8，移除 `kimi-code` / `glm-zhipu` /
   `glm-zai` 三个内置渠道的显示，建议同步退出后台取数、设置和排序；兼容旧配置，不删除模型凭据。
   Kimi parser 修复仍暂缓，不再要求保留原胶囊显示，也不作为方向6的前置条件。
   设置页底部新增通用自定义余额（名称、URL、Key/明确模型凭据引用、JSON键），做好失败回退和
   胶囊/卡片；只做普通GET/Bearer/JSON余额，不做特殊渠道适配。配置身份变化必须隔离旧值与旧请求。
   细节与C0–C5验收见 [新增设计](docs/custom-balance-v0.9.0.md)；OpenRouter式累计额扣减、币种、
   秘密托管与安全出网须先冻结，不能把累计充值当余额。该主线不依赖tools服务。
   当前仅更新文档；后续实施需另获授权。总范围见 [计划](docs/build-plan-v0.9.0.md)及
   [交接](docs/handoff-v0.9.0.md)。**0.8.5 仅本地定档，不推送、不发布。**

2. **Host 端 `/api/plan-usage` 结果缓存 + 请求合并**（⚠️ 配套方案，roadmap 方向 4 里负面效果
   与风险写得很全，动手前必读）：按渠道独立内存缓存（TTL 30s 起步）+ single-flight +
   stale-if-error，收敛多窗口翻倍打上游的请求量。**用户 2026-10-14 确认：备选方向，
   暂不推进**。前置条件：`?fresh=1` 强制刷新通道（0.8.0 的三个立即刷新触发点必须能
   绕过缓存）；语义错误（no-key/signed-out/reauth-required）绝不许 stale 顶着；
   响应必须带 `fetchedAt`/`stale`。渠道级降频用户已否决，不要重提。

原方向 1（充值入口）/2（充值后同步+取整）/3（失败降级+防卡死）均已在 0.8.0 落地，
实现要点见 roadmap「已落地」节与 release-notes-v0.8.0.md。

---

*文档更新时间：2026-10-24（当前权威状态：[docs/release-status-v0.9.0-20261024.md](docs/release-status-v0.9.0-20261024.md)；`0.9.1` 为过程标签，已并入 0.9.0）*
