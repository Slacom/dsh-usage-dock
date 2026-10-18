# 0.9.0 调查结论与实施交接（给接手模型）

> ⏸ **2026-10-18 用户决定：0.9.0 暂停，先更新规划文档再开工。**
> - **Kimi（方向 7）暂不修复**：用户当前没有 Kimi 订阅，无法真机核对效果。
> - **方向 5 不并入 0.9.0**，独立排期；且其协议文档与校验脚本**实际不存在**（见下条第 5 点修正）。
> - 方向 6（模型工具）技术路径已验证，但同样随本轮一起暂缓。
> - 本轮唯一产出是补证：见 [evidence-0.9.0.md](evidence-0.9.0.md)（含真实 fixture 与当前 parser 的实测行为）。
> - 恢复工作时，先读 evidence-0.9.0.md 第 7 节（还差 D6 最小契约冒烟）与本文决策清单。

> 交接日期：2026-10-18。本文与[构建计划](build-plan-v0.9.0.md)一起使用。
> **用户明确授权范围：本轮只调查方向 5/6/7，编写计划实施文档；具体实施交给其他模型。**
> 接手模型必须取得后续实施任务后才编码，不能把本文或此前“继续”理解为本轮编码授权。

## 1. 当前交付状态

- 起点提交：`3cfd34b`（调查当时）；**2026-10-18 0.8.5 已定档**（本地 `ebe5115` + 标签 `v0.8.5`，未推送），公开版本仍为 0.8.4。请重新执行 `git status --short`，以接手时状态为准。
- 本轮交付只有文档：本交接、构建计划、路线图的准备入口与缺件纠正；没有新增功能。
- 调查过程中曾误开始修改 Kimi 及客户端，用户澄清后已逐项撤回；`git diff --exit-code -- client.js plans/kimi-code.js` 返回 0。不要寻找或依赖所谓“已经写好的 0.9.0 parser”。
- 本会话未改包版本、未提交、未部署到 profile、未重启、未推送、未打标签、未发布。
- **交接时发现并发工作区变动**：[WorkBuddy 模块](../plans/workbuddy.js)出现本会话未执行的超时及注释修改（30s → 35s）。已保留，不归入本轮文档交付；前述基线运行早于该修改，不能证明此差异已验证。接手者先与用户确认来源，勿覆盖或将其混入本轮调查成果。
- 两次独立复核子任务均因子进程退出而失败，没有产出；本文结论来自主会话实际读取及测试，不把委托当成已完成复核。

## 2. 接手前必读与证据等级

首先完整阅读 [AGENTS](../AGENTS.md)，尤其 API 契约、安装副本与开发仓库的区分、发布闸门。再读[路线图](roadmap.md)、[构建计划](build-plan-v0.9.0.md)。

本文用三个等级区分：

- **已核实**：当前仓库可直接复查的实现、文件存在性或本轮命令结果。
- **沿用记录**：路线图曾调查所得，本轮未读取真实宿主源码再次核验。
- **建议/待验证**：实施方案，不能宣称是上游协议事实或用户已批准的设计。

| 主题 | 本轮核实 | 限制 |
| --- | --- | --- |
| Kimi 已用口径 | [计算](../plans/kimi-code.js#L58-L98)与[月限](../plans/kimi-code.js#L106-L123)均为已用；[客户端](../client.js#L59-L70)仅 Codex 显式 remaining | 没有真实 Kimi 账号响应，未验证 ratio-pool 字段单位与并存冲突 |
| Kimi 展示歧义 | [脚注](../client.js#L95-L125)没有 Kimi 已用说明；[胶囊 title](../client.js#L1050-L1074)只有名称与百分数 | 不能据此认定上游数值算错；问题是语义未声明 |
| Host 编排 | [取数](../index.js#L99-L148)每请求并行拉取，无结果缓存；[配置](../index.js#L57-L79)重读复用 2 秒 | 2 秒是配置缓存，不是额度缓存 |
| 工具接入 | [inject](../index.js#L24-L37)仅 webServer，当前没有模型工具 | `ctx.tools.register`、输出 schema/render、systemPrompt 生命周期属于沿用记录，需真实宿主契约核验 |
| 更新缺件 | 当前 glob/read 未找到路线图所称的协议文档、校验脚本；对二者执行 `git log --all --oneline -- ...` 无输出 | 仅说明当前检出及本地已有 refs 无记录；未联网 fetch 所有远端历史，不能断言历史上绝不存在 |
| Release 安装附件 | [发布说明](release-notes-v0.8.4.md#L52-L61)给出 tgz 直链与先卸载后安装说明 | 本轮未下载附件，未核验远端存在性或校验信息 |
| 打包范围 | [包清单](../package.json#L12-L19)仅入口、plans、patch、README、LICENSE | tools/docs 当前不会随 npm 包发出 |

### 外部信息核验边界

搜索得到 [CodexBar #4306](https://github.com/steipete/CodexBar/issues/4306)（legacy/ratio 并存冲突）及 [#3536](https://github.com/steipete/CodexBar/issues/3536)（会员月池与周/5h 不一致）线索；抓取 #4306 正文被网络安全检查拒绝，因此本轮**没有核验正文或 fixture**。不要把搜索摘要升级为已证实接口契约，也不要绕过网络限制。后续使用可访问的公开源码或用户主动提供的脱敏响应补证。

## 3. 方向 7：口径修复与 parser 兼容

### 调查结论

旧版主接口是 `usage` 周限与 `limits[]` 5 小时；[当前选窗](../plans/kimi-code.js#L79-L97)找 300 分钟，找不到就用首项。月度来自可选 Cookie 请求；[增强路径](../plans/kimi-code.js#L135-L176)成功即写月限，失败忽略。新版 ratio-pool 当前完全不读。

另有需要测试确认的防御性缺口：

- [toNum](../plans/util.js#L289-L295)对 number 原样返回，Kimi 仅检查 null 与 limit 正值；NaN / Infinity 的拒绝不能依赖 toNum。
- [membership 读取](../plans/kimi-code.js#L146-L152)未先保护空 data；空响应可能转成笼统 exec 错误。
- 若新版能直接给月池，现有“没 Cookie 就不能显示月限”的[脚注](../client.js#L101-L110)和设置文案需要同步审查。

### 推荐方案（不是已批准协议）

1. 先选 A：保留已用计算，面板脚注和 tooltip 明示已用；Codex 保留剩余。不要单方面做 B 或新增 `kimiPercentMode`。
2. 有效旧窗口与 ratio-pool 逐窗口匹配，不能把月池改名周限。一般建议旧有效窗口优先，但**并存矛盾时哪个权威尚未证实**；收集 fixture 后决定，不能仅依路线图一句“优先 limits”掩盖冲突。
3. ratio 0..1 与百分数 0..100、reset 秒/毫秒/ISO 各自必须有证据。确认不了保留 null/unknown，不能自动猜单位。
4. 月池 total/code 与 Cookie 的优先级应作为显式决策记录。建议总月池优先、Cookie 仅补缺；但两池若不同计费范围，需保留身份而不是静默互相覆盖。
5. 保留现有 wire 兼容；若增显式 `percentMode`，不要只改 Host——当前客户端色阶和最坏值依赖自己的 meta。

### 首批实施步骤

- 获取至少旧版、新版、并存、Cookie 增强四种脱敏 fixture；不得要求或提交真实 Key/Cookie。
- 为 parser 提供可独立测试的纯函数入口；是否拆文件由接手者决定，避免为测私有函数依赖脆弱字符串截取。
- 先写口径和空值失败用例，再修 parser 与 UI；同步月度来源说明，不触碰余额、WorkBuddy 排版和峰谷条。
- 专项验收：used=94/limit=100 仍显示已用 94%，不变成剩余 94%；ratio=0 与 1 有明确含义；缺数据不产生 0% 假象；非法数拒绝；Cookie 失败不丢已有窗口；tooltip 和面板同义。

## 4. 方向 6：模型工具与可选收尾策略

### 渠道数据映射（以当前实现为准）

| 渠道 | 输入/口径 | 必须防止的误判 |
| --- | --- | --- |
| Kimi | [已用窗口](../plans/kimi-code.js#L58-L123) | 94% 已用不能报成 94% 剩余；空窗口不是充足 |
| Codex | [remainingPercent](../plans/codex.js#L32-L53)，只取 codex 主桶固定时长；另有 credits/individual | 无窗口但有 credits 并不等于订阅窗口有额度；不要把预付金额与订阅百分比混合 |
| GLM 两渠道 | [percentage](../plans/glm.js#L13-L39)，客户端按已用；月限是 MCP 工具用量 | MCP 月限不一定限制模型生成；上游 percentage 语义仍应补协议证据 |
| OpenCode | [通用 norm](../plans/opencode-go.js#L35-L51)，有 useBalance 回退 | 套餐耗尽后可能可用余额继续；不能擅自推断账户金额 |
| DeepSeek / MiMo | 各自余额投影与币种，现有告警阈值 | 人民币和美元不可相加；UI 默认告警不等于用户授权改变模型行为 |
| WorkBuddy / AI | [两个独立渠道](../plans/workbuddy.js#L153-L215)，creditsTotal 或 unlimited | unlimited 不能被 null 金额误判耗尽；两渠道不能合计 |

### 建议输出形状（需冻结后再编码）

```text
{
  schemaVersion: 1,
  observedAt: ISO时间,
  plans: [{
    id, kind: balance|quota|credits,
    availability: ready|unknown|error|disabled,
    errorCode: 白名单错误码或null,
    fetchedAt: 成功采集时间或null,
    stale: boolean,
    remaining: 有单位的剩余数或null,
    limit: 总额或null,
    unit: CNY|USD|credits|null,
    unlimited: boolean,
    windows: [{ id, scope, percent, percentMode, remainingPercent, resetsAt }],
    policy: { configured: boolean, state: unknown|ok|low|exhausted, reasonCode }
  }]
}
```

这是建议，不是实际 DSH 输出 schema。比例与绝对额度不可互推；未知字段用 null；工具顶层 unavailable 与单渠道 error 需区分。scope 要区分模型窗口与 MCP 月池等用途。多渠道不做“全局最小值”自动停工；首次建议只支持用户明确选定的策略渠道，无法自动匹配当前模型时如实说明。

### 架构与接入步骤

1. 先核验宿主实际可用的 tools 定义、调用参数、返回结构、output schema/render 和 disposer；补一个无凭据最小 mock 契约测试。路线图关于注册即入提示词等结论须标注宿主版本。
2. 抽取共享渠道编排：保留单渠道异常隔离、最新配置、可选 shell 与 WorkBuddy 回环初始化；不通过请求自己的 HTTP 路由调用工具，避免认证、端口和递归耦合。
3. 工具只接受白名单 plan ids；默认是否全部查询需定案。推荐空参数查已启用渠道，显式列表只查交集，未知 id 返回参数错误。
4. 可选服务用 `ctx.get`，兼容 undefined/null/throw；不把 tools/systemPrompt 加硬 inject，不 import 无法解析的宿主工具包。注册必须可随插件卸载清理，缺服务时胶囊仍正常。
5. 工具侧 30 秒成功缓存 + single-flight；先只服务工具，不改变 Web 路由刷新语义。当前 UI 强刷无需改成缓存 bypass；若未来共享 Web 缓存则须另批落实方向 4 的 fresh 通道。
6. 缓存按渠道与配置代次隔离；同代并发复用一个 Promise，失败 finally 清理；旧请求不得回填新代。外部凭据库变化可能绕过配置代次，应重新解析身份或设计失效机制，不把 Key 放进日志/返回值。
7. TTL 从完成采集时刻计算；缓存命中 fetchedAt 不变；失败只短暂合并在途，不长存失败。首版建议不做 stale-if-error，避免拿旧值劝停；配置停用立即可见（现有配置重读有最多 2 秒窗口，应明确兼容或收紧）。
8. 再加 `quotaPolicyEnabled` 默认关闭、阈值和关注渠道。保持 UI 告警阈值与 Agent 策略授权分离；提示词段切换应清理旧段，不重复堆积。

### 策略行为边界

政策是建议不是守护进程：必要时调用工具，一次任务 1–2 次；余额紧张时先完成当前最小工作单元、检查变更、必要测试、保存交接、收尾。不得承诺模型必调用、绝对防超额、自动切模型或即时强制停止。未知、过期或错误数据不得给出肯定“余额充足/耗尽”的结论。

### 脱敏与安全

工具输出使用白名单重建，不能直接返回 plan 原对象；尤其 [WorkBuddy 错误](../plans/workbuddy.js#L162-L190)含上游字符串。禁止 Key/Cookie/token、原始响应、路径、账号标识、套餐自由文本或原始错误堆栈进入模型输出和渲染。测试放入唯一哨兵秘密，断言序列化结果与日志均无泄露。上游文本不能写入政策提示词。

## 5. 方向 5：更新检测与 Agent 安装协作

### 沿用设计与必须重查之处

路线图已否定插件自替换，要求插件只读检测、用户复制提示词、会话 Agent 安装，永不自动重启。宿主 `already-installed` 与卸载中断链的解释属沿用记录，本轮未再读取宿主实现。

真正未解决的是安装一致性：路线图同时指出直接覆盖会造成锁文件/清单不一致，却描述逐文件原子覆盖。**单文件原子不等于整包事务，不能原样照搬为已批准安装协议。**

### 推荐分期

**U1：先交付只读检查与可验证提示词。**

- `/api/plan-usage/update-check` 仅检查远端 release，不安装、不下载执行代码；10 分钟缓存与并发合并，区分最新/有更新/不可用/限流。
- 使用完整 semver 解析；禁止字符串大小排序。默认排除 draft/prerelease；跟踪预发布时枚举 Releases 而非仅 `/latest`。当前是更高 prerelease 而正式版较旧时，提示“无可用升级”而不是建议降级。
- 目标必须属于受信仓库和精确版本。检查 tag、资产名、包名/版本一致性；没有安装绝对路径/profile 的可靠数据就让用户补充，不能猜 desktop。
- Release 摘要当不可信文本，只展示，不作为执行指令；限制长度并安全渲染。离线/403/429/无资产/格式坏均有可读状态，不影响胶囊。
- sha256 必须绑定实际附件来源；同页提供的 hash 只能防传输/附件误配，不等于独立签名信任。若没有可信校验元数据，不得伪造值或使用占位值生成“已验证”提示词。

**U2：确定安装协议后再开放安装交接。**

优先调查官方 CLI/插件管理器能否由外部 Agent 安全更新，或受控卸载/安装并保留配置、失败恢复。若只能暂存到工作区，让用户通过插件页处理，就明确这一能力边界。原地覆盖只能作为单独批准的开发部署方式，不作为默认正式升级。

拟补的协议至少包含：能力检查 → 验证目标/profile/允许路径 → 下载到工作区 → sha256 校验 → 检查归档路径穿越/软链接/超大包/包名版本 → 选择一致的安装途径 → 记录备份与恢复命令 → 事后核验 → 提示用户自行重启。任何写入前的失败不得碰安装副本；更新失败保留旧可用版本或明确进入可恢复状态。不要在校验前运行归档里的校验脚本。

### 复制提示词字段与禁止事项

字段：当前/目标版本、精确包源与附件 URL、可信 sha256 与来源、目标 profile、已验证安装目录、跟踪预发布开关、协议版本与可访问协议位置、禁止自动重启、不可写时降级方式。

当前协议与脚本未在包内，不能只让用户复制“参见仓库某文件”却不给接手 Agent 可访问路径。是否把受审协议/只读校验器随 npm 发布、或提供版本固定的公开链接，需与白名单改动一起定案。不要内嵌执行远端动态脚本，也不让安装包自证完整性。

## 6. 决策清单（不要静默替用户定案）

| 编号 | 需要确定 | 推荐/默认 |
| --- | --- | --- |
| D1 | 0.9.0 是否包含方向 5，还是保留独立版本 | 不把方向 5 作为方向 6 依赖；用户确认后排期 |
| D2 | Kimi 展示保留已用还是改剩余 | 保留已用 + 明示；B 配置项后置 |
| D3 | Kimi 并存响应及月池/Cookie 优先级 | fixture 与协议补证后决定，不猜单位 |
| D4 | 工具默认查询范围、是否所有渠道开放 | 默认已启用渠道；只读工具与策略分别开关需明确 |
| D5 | 策略关注渠道、阈值、窗口 scope | 显式选渠道；默认策略关闭，未配阈值只报数 |
| D6 | 真实宿主服务契约与热配置清理方式 | 小型契约验证先行，不凭名称补调用签名 |
| D7 | 更新资产/hash 来源及安装一致性路线 | 无可信元数据不生成可执行安装承诺；优先官方管理途径 |

D1/D2/D4/D5 为产品范围决策；D3/D6/D7 为技术补证门槛。路线图的示例 20% / 50% 不是用户定稿默认值。

## 7. 建议任务拆分与依赖

| 任务 | 输入/输出 | 依赖与建议写入范围 |
| --- | --- | --- |
| T0 补证与契约冻结 | 脱敏 fixture、宿主 API 证据、D1–D7 决策记录 | 先做；只写调查文档/fixture |
| T1 Kimi 语义及解析 | parser + UI 同义脚注/tooltip + 专项测试 | T0 的 D2/D3；Kimi 模块、客户端、Kimi 测试 |
| T2 纯工具投影 | schema 与白名单转换器，覆盖所有渠道 | T1；建议新建独立模块及测试，运行时文件须入包 |
| T3 可选工具与短缓存 | 共享编排、注册、失效及清理 | T2 和 D6；Host、工具模块、测试 |
| T4 可选政策 | 默认关闭配置、关注渠道、提示词生命周期 | T3 和 D5；Host schema/客户端/测试 |
| T5 更新只读服务 | semver、release 选择、缓存与错误状态 | T0 的 D1/D7；可独立于 T1–T4 |
| T6 更新 UI/协议/校验 | 提示词、能力降级、安装与恢复验收 | T5；客户端、协议、校验测试、打包白名单 |
| T7 综合验收与用户试装 | 测试日志、dry-run、用户验证清单 | 所有纳入任务完成后；未确认不得发布 |

Host 和客户端是交叉写入热点，不能让多个模型同时改同一文件。先固定纯模块接口，再由单一集成人合入 Host/客户端；每批复核 diff 和测试，不靠最终一次全量大改。

## 8. 测试、验收和交付

已运行基线与沙箱重试记录见[构建计划第 7 节](build-plan-v0.9.0.md#7-基线记录)：11 组、334 项检查/断言通过（含 144 几何断言）；不是 334 个独立功能测试，也不代表真机验证。未跑 fetch-backends 的出网组与真实 WorkBuddy 契约组。

```powershell
node --check index.js
node --check client.js
node tools/test-collapsed-pill.mjs
node tools/test-footer-row.mjs
node tools/test-degrade-refresh.mjs
node tools/test-peak-phase.mjs
node tools/test-mimo-parse.mjs
node tools/test-workbuddy.mjs
node tools/test-settings.mjs
node tools/test-android-compat.mjs
node tools/test-peak-marker.mjs
node tools/test-line-endings.mjs
node tools/test-panel-interactions.mjs
git diff --check
```

新增测试矩阵：

- Kimi：旧/新/并存、空响应、非法数、单位、边界、Cookie 失败、优先级、tooltip/色阶/最坏窗口一致性。
- 工具：所有渠道映射、多个窗口、MCP scope、unlimited、零余额/缺值区别、disabled/no-key/signed-out/reauth/transport、秘密哨兵不泄露。
- 缓存：并发只取一次、30 秒过期、失败可重试、旧代迟到不可回填、渠道/凭据变化、卸载清理、Web 三个立即刷新触发点不受影响。
- 策略：默认无政策段、未配置不劝停、关注渠道不串用、unknown/stale 不肯定判断、开关切换不残留。
- 更新：1.9/1.10、多位 semver、alpha/rc/正式、当前较新、draft、空资产、伪 hash、403/429/离线、路径穿越、只读目录、安装失败恢复、禁止自动重启。
- DSHA：无 tools/systemPrompt/configEditor/shell/WAAPI/ResizeObserver 都不能让既有胶囊或设置页白屏。

完成定义：纳入范围的实现、fixture、专项测试、既有回归、版本对应发布说明、打包核对与用户试装都具证据。接手模型应记录“改了什么、验证了什么、没验证什么、待用户什么决定”，不能以 mock 测试冒充联网/桌面/Android 真机通过。

## 9. 可复制给实施模型的启动任务

> 先完整阅读 AGENTS、roadmap、build-plan-v0.9.0、handoff-v0.9.0。当前版本仍 0.8.4，本轮调查没有实现任何 0.9.0 功能。先复查 git 状态，逐项处理交接文档 D1–D7，列出仍缺证据再申请必要确认。取得实施授权后，按 T0→T1→T2→T3→T4 分批实现；方向 5 按确认的范围独立处理。不要开启搁置的方向 4，不要擅自改 Kimi 为剩余口径，不 import 宿主工具包、不增加可选服务硬依赖、不暴露凭据、不自动重启。每批提供 diff 与测试记录；用户试装确认前禁止 push/tag/Release/npm publish。
