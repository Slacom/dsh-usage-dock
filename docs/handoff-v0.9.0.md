# 0.9.0 规划交接（渠道精简与自定义余额版）

> **当前状态入口（2026-10-24）**：本文件是**历史规划/交接记录**。0.9.0 的权威状态、验收证据与未验证边界见
> [0.9.0 发布状态](release-status-v0.9.0-20261024.md)；面向用户的说明见 [发布说明](release-notes-v0.9.0.md)。
> 程序已部署且**用户已确认本地验收**；提交/推送/打标签/发布由维护流程执行。
> 下文"仅本地构建 / 未部署 / 未发布"等表述属于当时的阶段性记录，**不代表当前状态**。

> 修订：2026-10-18。配套：[实施计划](build-plan-v0.9.0.md)、[新增主线详细设计](custom-balance-v0.9.0.md)、[路线图](roadmap.md)、[补证记录](evidence-0.9.0.md)。
> **状态：C0→C5 已实施完成（仅本地构建）**；实现记录见 [v0.9.0 发布说明](release-notes-v0.9.0.md)。
> 目标：去除 Kimi Code / GLM 智谱 / GLM Z.AI 三渠道显示 + 设置页底部通用自定义余额渠道。**已落地。**
> **0.9.0 未提交、未打标签、未推送、未 npm publish；上一公开版仍为 0.8.4，0.8.5 为仅本地的定档修复。**
> **下一步是用户试装**；试装通过也不自动解除「不推送」决定。

## 1. 接手第一件事：确认边界

完整阅读 [AGENTS](../AGENTS.md)，再读本交接与实施计划。不要从旧对话的“继续”、旧任务表或 fixture 推断授权。

| 决定 | 接手者必须执行 |
| --- | --- |
| 三个内置渠道退场 | `kimi-code`、`glm-zhipu`、`glm-zai` 从胶囊/卡片/设置/排序/工具退出，建议同时停止 Host 取数；不删除共享模型凭据 |
| Kimi parser 修复仍暂缓 | 可以按退场计划移除 UI 入口，不修口径/ratio-pool/Cookie；不再要求保留原胶囊显示 |
| 自定义余额纳入规划 | 设置页最下方配置名称、URL、Key/模型凭据引用、JSON 键，包含动态胶囊/卡片和失败回退；仅普通余额 API |
| 新余额主线独立 | C0→C5 已完成，不依赖 tools 服务；T0→T4 模型工具是另一路，不以 Kimi 或宿主工具契约阻塞自定义余额 |
| 方向 6 **已获授权实施（本轮）** | T0→T4 按计划推进；先重新核验真实宿主 tools 契约，不照搬补证记录里的推断 |
| 方向 5 独立排期，不并入当前 0.9.0 | 仅保留独立调查与安全约束，不新增更新按钮或安装路由 |
| 方向 4 仍搁置 | 不改 Web 全局缓存、轮询频率或 UI 已定稿的灰化行为 |
| 0.8.5 只在本地定档 | 不 push、不推本地标签、不发 Release、不 npm publish；不得因测试通过自动发布 |

原文“先修 Kimi 再做工具”“工具投影必须覆盖所有渠道”“方向 5 是否合入待确认”均不再是本轮依赖或待办。

## 2. 当前仓库与已知变更归属

- [包清单](../package.json)当前版本 **0.9.0**（本地构建，未提交）。HEAD 仍是 `71e71b4`，
  本地已有 `v0.8.1`–`v0.8.5` 标签；接手时先 `git status --short` 核对，不要强行回退到某个 SHA。
- **0.9.0 的改动未提交、未打标签**（用户明确要求不 commit / 不 tag）。工作区里的大片修改
  就是本次实施结果，不要当成污染清理掉。
- WorkBuddy 改动已由用户确认来自另一会话，不是未知污染；最新本地版包含本会话审查提出的两个 P2 的后续修正。**不要撤回这批代码或恢复成 0.8.4。**
- 本会话早期误做的 Kimi 代码已撤回，没有可直接接用的 0.9.0 parser。
- [补证记录](evidence-0.9.0.md)、[探针](../tools/probe-kimi-0.9.0.mjs)及脱敏 fixture 是另一会话的调查成果，保留，不自动运行修复、不删除或混同产品实现。它们也不表示用户现在使用 Kimi。
- 工作区可能包含已跟踪的文档改动与未跟踪调查文件。不得用 `git reset --hard`、clean 或整文件恢复清掉其他工作；提交也需另行授权，本轮不提交。
- 该补证记录的“工作区干净/文档已单独提交”是当时记录，不能代替接手时 `git status --short`。

建议只读检查：

```powershell
git status --short
git log -5 --oneline
git show --no-patch v0.8.5
git diff --stat
```

不使用远端同步或发布操作来“确认”本地定档。

## 3. 当前证据与仍需补证

| 主题 | 已有证据 | 尚未证明 |
| --- | --- | --- |
| Host 编排 | 用量路由按渠道并行取数（内置 + 自定义两条编排合并）；配置重读复用 2 秒；`cfgValue()` 解包 volatile | 配置缓存不是额度缓存；模型工具见第 4 节（T0–T4 本轮实施） |
| 可选工具服务 | 路线图及补证记录保留 DSH 0.2.1-rc.1 的源码调查 | **契约必须重新核验**；补证记录里的签名推断不得直接采用 |
| Kimi 口径 | 渠道已退场（不再取数/显示）；parser 与 fixture 保留为历史资料 | 不再修复；这是渠道退场而非口径修复 |
| WorkBuddy 0.8.5 | [修复说明](release-notes-v0.8.5.md)包含固定前缀分类、语义/暂时区分及契约修正 | 本轮模拟回归不等于所有真机网络状态验证 |
| 自定义余额 | 6 组专项 + 历轮整改（含真实 `apply()` 路由端到端、秘密哨兵、重定向/DNS/上限、配置摘要协议） | **未在真实 DSH 宿主里跑过**：未部署、未重启；`mutate` 路径写入与 `role('secret')` 剥除按宿主源码核对 + 等价桩验证 |
| OpenRouter 类响应 | 已实现通用可选扣减键；文档说明「累计充值不是余额」 | **官方最新响应与 Key 权限未核验**（本轮抓取被网络策略拦下），不声称兼容 |
| SSRF 防护 | **已升级为连接期 IP 绑定**：`resolveValidatedAddresses()` 全地址核验 + `node:https` + `makeLookup()` 钉死已核验 IP，`servername` 保持真实域名、TLS 校验从不关闭、不跟随重定向 | 若运行时 `node:https` 不可用则保守 `unbound` 拒绝；不做「绝对安全」声明 |
| 更新流程 | 当前缺少规划中的协议与校验器；方向 5 只有设计意图 | 可信 hash 来源、安装一致性、恢复、profile 能力检测未闭环 |
| 打包 | npm `files` 含 `plans`（覆盖新模块 `plans/custom-balance.js`） | 当前包 20 文件 / 129 086 字节，payload 与工作区逐一相同；真机安装未验证 |

`ctx.get('tools')` / `ctx.get('systemPrompt')`、不 import 宿主工具包、不加硬 inject 的约束继续保留。任何需在已安装 profile 内注册工具的冒烟测试，都要先说明影响并另获授权，不能把“调查”当作改运行环境的许可。

## 4. 方向 6：适配精简后的渠道与自定义余额

### 4.1 渠道范围与退场隔离

首批保留 Codex、DeepSeek、MiMo、WorkBuddy、WorkBuddy AI；OpenCode 在用途核实后扩展。GLM 智谱/Z.AI 不再是后续扩展候选，与 Kimi 一起退场。自定义条目通过通用 balance 投影接入，不写厂商分支；稳定 id 与支持清单见新增主线设计。

- 默认仅查询“模型工具支持白名单 ∩ 当前已启用渠道”，显式请求再取交集。
- 三个退场 id 是已知历史 id，建议返回 unknown + `retired-channel`、空数值/窗口、`policy.eligible: false`，且不取数；未知 id 和已删除的自定义 id 另行处理，不复活已删除条目。
- 策略选项不包含退场渠道；旧策略引用安全退回不可参与，不偷偷查询或删除模型凭据。
- 胶囊、卡片、设置和活动取数同步退场，不仅是工具层隔离。
- 未知/退场数据不是 0% 剩余、100% 已用、耗尽或已退出登录。自定义 UI 灰化旧值不能成为模型肯定判断依据。

### 新增余额主线交接要点

先读 [完整设计与验收](custom-balance-v0.9.0.md)。关键调查发现：

1. [planMeta](../client.js#L83-L88)未知 id 只回退名称，不能识别自定义 balance；需要服务端安全 wire 元数据或配置驱动元数据，且不暴露秘密配置。
2. Host [注册表](../plans/index.js)当前静态，动态自定义条目需参与编排，但不能用删除客户端 meta 代替 Host 停取数。旧启用字段及 planOrder 应兼容忽略，不删除账户凭据。
3. [凭据解析](../plans/util.js#L322-L348)只按引用名 resolve，自定义厂商名称不会天然找到模型 Key；需要明确引用/来源选择，插件显式 Key 优先。不要把显示名称当密钥引用，或把另一厂商 Key 试发到任意 URL。
4. [设置页](../client.js#L1832-L1905)已有 draft/保存/放弃和排序，需接入统一草稿、saving/只读行为，并在内置设置之后、保存区之前固定自定义编辑区。检查另一旧设置卡路径也不再出现退场渠道。
5. 自定义 Key 不能混入普通 JSON 配置字符串；先验证嵌套 secret 托管与掩码保留契约，必要时公共元数据和 secret 映射分开。
6. 不能只“换 URL 调 curlJson”：现有 util 有内置业务信封规则、自动重定向/降级和多后端超时限制需重新审查。通用请求需保留原始 JSON/HTTP 状态，实施安全 URL/鉴权边界与总预算。
7. OpenRouter 类余额可能需 total_credits − total_usage。推荐可选固定扣减键而非厂商特例/任意表达式；若只支持直接键，不能宣称该响应已正确支持。最新官方响应/Key 权限仍待补证。
8. 每条成功/失败由稳定 custom id + 配置代次隔离，改 URL/Key/引用/键路径/币种后旧值和迟到响应都作废；灰化、阈值8、语义立即提示与胶囊/详情一致。

### 4.2 拟议输出（待冻结，不是现有宿主 schema）

```text
{
  schemaVersion: 1,
  observedAt: ISO时间,
  plans: [{
    id, kind: balance|quota|credits,
    availability: ready|unknown|error|disabled,
    reasonCode: 固定原因或null,
    errorCode: 白名单错误码或null,
    fetchedAt: 成功采集时间或null,
    stale: boolean,
    remaining: 数值或null, limit: 数值或null,
    unit: CNY|USD|credits|null,
    unlimited: boolean,
    windows: [{id, scope, percent, percentMode, remainingPercent, resetsAt}],
    policy: {eligible: boolean, configured: boolean, state: unknown|ok|low|exhausted, reasonCode}
  }]
}
```

对三个退场 id 返回 `availability: unknown`、`reasonCode: retired-channel`、`remaining/limit/fetchedAt: null`、`windows: []`、`policy.eligible: false`，不把退场伪装成取数失败；具体 nullable/省略规则在 schema 冻结时统一。`eligible` 指该渠道的策略支持资格，不代表已经启用政策；还需开关、有效阈值和新鲜有效数据才允许判断。

### 4.3 数据含义

- Codex [窗口](../plans/codex.js#L32-L53)为剩余比例；credits/individual 是独立维度，不与订阅比例合成一笔钱。
- DeepSeek/MiMo 保留各自币种，现金/赠金是否参与策略要明确，不跨币种相加。
- WorkBuddy/AI 保留两个独立 id 与积分，unlimited 与金额缺失不同，不能合计。
- 自定义余额保持明确币种，不写厂商特殊适配，不臆造赠金/额度条；OpenCode 的 useBalance 不等于已知备用余额。GLM 两渠道不再参与新投影。
- 不反推上游未给出的绝对额度，不猜计费账户/模型对应关系，不求所有渠道最小值作为自动停工依据。

### 4.4 架构与缓存

1. 先用无真实凭据的最小案例核实宿主注册、调用、输出和卸载契约，再冻结 JSON schema。
2. 提取共享“配置 + 渠道取数”编排，保留单渠道异常隔离、可选 shell 和 WorkBuddy 回环初始化；不请求自己的 Web API 来实现工具。
3. 工具服务可选，缺失 undefined/null/throw 时跳过工具，不阻断既有胶囊/设置页。注册和政策段必须能清理。
4. 仅工具使用 30 秒成功缓存 + single-flight，Web 不加结果缓存、不改强刷；不恢复搁置的方向 4。
5. 缓存按渠道和配置/凭据代次隔离，TTL 从采集完成算；失败 finally 清锁，旧代迟到不回填，外部凭据变化须有失效方案。不能把 Key 写到日志或返回值。
6. 首版不做 stale-if-error，不拿浏览器缓存的灰色旧积分为模型判断余额。工具请求失败即报告 error/unknown，不掩盖凭据错误。

### 4.5 策略默认关闭与脱敏

`quotaPolicyEnabled` 默认 false，显式选受支持渠道与阈值；UI 现有告警阈值不能默认为模型行为授权。示例 20%/50% 未定稿；配置 `.volatile()`，开关变更清理旧提示词段。

只有政策开启、渠道受支持、阈值明确且数据新鲜有效，才建议“完成最小单元 → 检查变更 → 必要测试 → 保存交接 → 收尾”。unknown/error/stale/暂缓渠道不自动劝停。提示词不是硬性停机，不保证模型必调用工具、绝不超额；不自动切模型、不重启宿主。

输出必须白名单重建，不直接返回 plan 原对象；不暴露凭据、路径、账号、套餐自由文本、错误堆栈或上游错误原文。测试放入秘密哨兵，检查输出与日志均不泄露；不让上游文案进入政策提示词。

## 5. 方向 5：独立排期的调查备忘

不并入当前 0.9.0，不再作为本版待确认范围，也不成为工具依赖。保留以下独立任务，未来明确授权后再启动：

- U0：补协议和能力检查，确定官方 CLI/插件管理器安装路线、profile/锁文件一致性、备份与恢复。逐文件原子覆盖不等于整包事务，不默认绕过包管理器。
- U1：只读更新检查，完整 semver + prerelease + 防降级、10 分钟缓存/合并、离线/限流/无资产状态。当前本地 0.8.5 比公开 0.8.4 新时，应显示无可用升级，不能建议降级。
- U2：冻结可信附件/hash 来源后才做可验证提示词和安装引导；缺 hash 不伪造，缺写权限降级到工作区下载和插件页引导。

协议必须覆盖：目标/profile/安装路径确认、下载暂存、hash、归档路径穿越/软链接/体积/包名版本检查、安装一致性、失败回滚及事后核验。校验前不执行归档内脚本，不让包自己证明可信。Release 文本视为不可信展示数据，不当执行指令。

复制提示词应带版本、精确资产 URL、sha256 与来源、profile、验证后的安装目录、协议版本/可访问位置、预发布开关与能力降级说明。永不自动重启。不能在缺少协议或元数据时声称安装流程已可用。

## 6. 已决与未决（沿用 D 编号，避免旧证据引用失效）

| 编号 | 当前状态 |
| --- | --- |
| D1 | **已决**：方向 5 不并入当前 0.9.0，独立排期 |
| D2 | **已决并更新**：Kimi parser 不修，Kimi/GLM智谱/Z.AI 在0.9.0退场；不再要求保留原UI |
| D3 | **移入搁置记录**：Kimi 新旧响应及月池优先级不再是 T0 门槛；恢复使用后重议 |
| D4 | **待决**：工具参数默认范围及只读工具是否另有开关；排除三个退场id，自定义balance按通用契约纳入 |
| D5 | **待决**：策略关注渠道、单位、阈值与窗口 scope；默认策略关闭 |
| D6 | **技术门槛未过**：真实宿主最小调用、render、disposer 和热配置清理；涉及 profile 修改需授权 |
| D7 | **独立项目门槛**：更新资产/hash/一致性方案，不阻塞本版工具 |
| D8 | **新增技术冻结项**：自定义JSON路径、币种、凭据引用、secret托管、可选固定减法、请求预算与安全出网；见C0 |

不再向用户追问 Kimi A/B 或要求先提供 Kimi 凭据。先确认 D4/D5，再补证 D6；已经暂停实施，不能拿这张表自行开工。

## 7. 任务拆分（新增 C 主线，保留独立 T 主线）

**新增主线 C0→C5**：契约冻结 → 三渠道退场 → 动态配置/秘密与设置 → 通用取数/JSON → 胶囊/卡片/代次隔离 → 综合验收。具体依赖和测试见 [详细设计第9节](custom-balance-v0.9.0.md#9-实施分解与验收)。它不依赖 D6/tools；C0 的 D8 先过，Host/客户端交叉写入需协调。以下 T 表仅指模型工具主线，不能代替 C 主线。

| 任务 | 输出 | 依赖 / 建议写入范围 |
| --- | --- | --- |
| T0 | 冻结 D4/D5，验证 D6，记下证据与 schema | 实施新授权；不要求 D3/Kimi 或 D7/更新先完成 |
| T1 | 活动渠道纯转换器、自定义balance投影、三个退场id占位和脱敏测试 | T0；自定义wire对接C3/C4，不强行重写通用余额模块 |
| T2 | 共享编排、可选注册、工具缓存、清理 | T1；Host 与工具模块及测试 |
| T3 | 默认关闭的配置/提示词/关注渠道校验 | T2；Host schema、客户端、测试 |
| T4 | 既有回归、打包核对、用户试装与新交接 | 前述任务；不包含 Kimi 修复或方向 5 |

Host/客户端属于交叉写入热点，避免多模型同时改。先分离纯模块，再让一个集成人合入并复核 diff。新增运行时模块记得进入 npm files；方向 5 的协议/工具打包变更留独立任务。

## 8. 验证快照与验收清单

### 8.1 0.9.0 实施后的实测结果（2026-10-18）

```powershell
node tools/test-custom-balance.mjs           # 52
node tools/test-custom-balance-fetch.mjs     # 49
node tools/test-custom-settings.mjs          # 50
node tools/test-custom-render.mjs            # 63
node tools/test-custom-security.mjs          # 36
node tools/test-host-custom.mjs              # 31
node tools/test-line-endings.mjs             # 21
node tools/test-fetch-backends.mjs           # 13
node tools/test-degrade-refresh.mjs          # 43
node tools/test-workbuddy.mjs                # 27
node tools/test-android-compat.mjs           # 14
node tools/test-settings.mjs                 # 6
node tools/test-peak-phase.mjs               # 32
node tools/test-mimo-parse.mjs               # 21
node tools/test-footer-row.mjs               # 12
node tools/test-collapsed-pill.mjs           # 4
node tools/test-peak-marker.mjs              # 144 几何断言
node tools/test-panel-interactions.mjs       # 12
node tools/test-workbuddy-contract.mjs legacy/workbuddy-android-contract/package/lib/index.js  # 7
```

**33 组 1133 项 + 行尾 51 + 几何 144 = 1328 项通过、0 失败、0 跳过**，`workbuddy-contract` 另 7 项通过
（第五轮复核实测，24 个脚本 / 838 项）。
打包：`npm pack --dry-run` → 20 文件 / package 103.3 kB / unpacked 302.0 kB /
shasum `6aa5ea70c068161f98b40e7ac2cc6e455cd486d2`（此后若再改文件需重跑）。

环境说明：`test-line-endings`（`git` 子进程）与 `test-peak-marker`（写 `legacy/` + 启动 Chrome）
在受限沙箱下会 EPERM，需完全权限运行；不是代码问题。

### 8.2 历史快照（0.8.5，保留）

```powershell
node tools/test-workbuddy.mjs
node tools/test-degrade-refresh.mjs
node tools/test-workbuddy-contract.mjs legacy/workbuddy-android-contract/package/lib/index.js
```

结果 **27 + 43 + 7 = 77 项通过**。确认契约中的 session_dead→api、soft_rate→exec+transient、
soft_rate 前缀而正文含 401 仍为暂时失败。使用本地留存上游源码配模拟认证/计费，不读取真实凭据，
不是 Android 真机联网验证。

### 8.3 验收重点（0.9.0 已覆盖项用 ✅ 标注）

- 工具：可信渠道、多窗口/scope、单位、unlimited、零与缺失、语义/传输错误隔离、秘密哨兵不泄露。
  （方向 6 未实施）
- 三渠道退场 ✅：旧配置启用仍无胶囊/卡片/设置项/后台请求，排序无空槽，不删除模型凭据
  （H1a–f、C1a–i、R10a–d）。
- 自定义余额 ✅：多条增删改和保存/放弃/只读、凭据复用与脱敏、JSON 路径/数组/0/负数/可选扣减、
  限流/网络/鉴权/结构错误、前 7 次灰化第 8 次失败、恢复、配置变化旧响应隔离、长名称/不同币种/
  rail 与卡片（C2a–ao、R1–R13、F1–F10、S1–S8）。
- 缓存：并发合并、30 秒过期、失败可重试、配置/凭据变化、旧代迟到隔离、卸载清理；
  Web 三个强刷触发点不受影响。（方向 4 未实施；自定义条目只有「整批预算 + 单条超时」，
  没有结果缓存）
- 策略：未实施（方向 6）。
- 0.8.5 保留 ✅：错误分类前缀优先，WorkBuddy 两渠道暂时失败灰化、语义立即透传、
  第 8 次失败转错误、恢复清零；Host 35s / Client 40s 不倒置（degrade-refresh 43、workbuddy 27）。
- DSHA ✅：无 tools/systemPrompt/configEditor/shell/WAAPI/ResizeObserver 不导致原功能白屏
  （android-compat 14；另注：`cfgValue()` 修掉了无 configEditor 时开关失效的既有缺陷）。

新增 Kimi parser/ratio-pool 修复测试不属于当前完成条件；保留调查 fixture 即可。
方向 5 的 semver/归档/安装恢复测试也不计入当前 0.9.0 完成门槛。

## 9. 给接手模型的可复制启动任务

> 阅读 AGENTS、roadmap、build-plan-v0.9.0、handoff-v0.9.0、custom-balance-v0.9.0、evidence-0.9.0
> 和 release-notes-v0.9.0，先复查工作区/HEAD/标签。**0.9.0 已实施完成但未提交、未推送，公开版仍 0.8.4。**
> 下一步是**用户试装**（安装测试步骤见 release-notes 第 6 节）；试装通过也**不**自动授权 commit、
> push、tag、Release 或 npm publish，必须等用户明确开启发布流程。
> 若要继续开发：三渠道已退场（不要加回来）；自定义余额只做普通 GET/Bearer/JSON，不做厂商特例；
> 新增运行时文件必须落在 npm `files` 的 `plans` 白名单内。模型工具 T0→T4 仍独立排期，D6 未过。
> 方向 5 独立排期、方向 4 仍搁置；不重启宿主、不部署到已安装 profile。
