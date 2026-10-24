# 额度感知构建审查：不通过（2026-10-19）

> 审查对象：0.9.0 本地包 SHA256 `6b4024cc77a3adc0a4776c4665e1d7a84fbc98ad8f947de9a0da9d93bc7f270a`。
> 验收依据：[额度策略构建交接](handoff-quota-policy-build-v0.9.0.md)、[渠道识别研究](research-quota-route-binding-20261019.md)和用户已确认的失败/阶段规则。
> **结论：现有回归全绿、包与源码一致，但新功能的真实采集→提示词链未接通，且存在错误账户/渠道收尾与失效隔离缺口。暂不部署，不进入发布验收。**
> 本轮只审查、执行合成用例并保存诊断材料，未修改产品/既有测试/宿主/已安装profile，未重启、提交、推送或发布。仅复用一个子代理做独立路由审查，未新增并行代理。

## 1. 已核实的正面结果与验证范围

- 采用固定模板＋动态context，而非常驻规则section，方向正确；normal格式本身没有行为规则，默认阈值0也没有擅自设20%/50%。
- 既有取数路径顺带发布的设计没有新开供应商轮询；本轮未发现新context回调直接发上游请求。
- 实跑37个脚本：**34个普通Node组1226项＋行尾56＋几何144＋WorkBuddy源码契约7＝1433项检查/断言**，所有进程首次完整回归exit0，未记录SKIP。新套件92项通过。该统计不等于1433个独立端到端场景。
- [原始回归清单](../.diagnostics/review-quota-build-20261019/regression/summary.json)、[分组计数](../.diagnostics/review-quota-build-20261019/regression/counts.json)、[几何结果](../.diagnostics/review-quota-build-20261019/regression/peak-marker.log)留存。
- 包压缩大小172598字节、27个文件，SHA1 `e76bc931302dfd2ef50405422219c712440a33f7`；逐个payload与当前源文件比较，**mismatch=0**。因此下述问题也在该包中，不是“审到别的旧源码”。见[包核验](../.diagnostics/review-quota-build-20261019/package-audit.json)。
- 不要求本次一定交付专用设置UI，未部署真机也已由构建者说明；这两点不是本报告拒绝通过的主要依据。先修下述实现与安全闸门，再做UI/用户试装。

### 复现方式说明

[主审脚本](../.diagnostics/review-quota-build-20261019/main-host-probes.mjs)真实import产品apply、注册表、投影与状态机，使用合成provider、HTTP/DNS桩及配置/事件服务，不调用真实账号API。正常wire成功后，直接读取实际注册的context.text。

A01导致成功发布全被截断。为单独观察后续问题，脚本在**该测试进程内**将产品已有的projectUsage放入全局名字解析环境，模拟仅补齐缺失导入。未编辑生产源码。这类结果明确属于“补齐A01后仍存在的独立缺陷”，不伪称当前未补导入的产品已经显示了这些成功余额。主日志H1是未补齐的原样实际结果，H1_CONTROL证明只补名字即恢复发布。

[主审日志](../.diagnostics/review-quota-build-20261019/main-host-probes.log)含16条已确认输出（包括控制和同根因分支），不是16个独立缺陷。[路由日志](../.diagnostics/review-quota-build-20261019/subagent-route-review.log)含6个独立构造场景，部分归并为同一来源校验问题。其exit0表示“成功复现缺陷”，不表示产品验收通过。

首次自编主审探针因对象字面量少一个闭括号而语法失败，未执行到产品；已定位修正并保留[首次setup失败](../.diagnostics/review-quota-build-20261019/main-host-probes.setup-failure.log)。修正后执行及扩展用例的复跑均exit0；未把该setup错误计为产品缺陷，也未改产品使测试通过。

## 2. 整改总表

优先级P1表示在本功能验收前必须修复的主要功能/错误自动干预问题，不表示均为凭据泄露漏洞；未发现需宣称P0的证据。共13组整改项，其中8组P1、5组P2。另有窗口业务口径风险单独列出，不混计成确定授权违约。

| 编号 | 级别 | 问题 | 关键证据 |
| --- | --- | --- | --- |
| A01 | P1 | 成功采集没有进入提示词；仅自定义GUI分支也绕过发布 | H1/H1_CONTROL/H7 |
| A02 | P1 | 观察身份固定为空；改Key/修订、停用后旧额度/规则仍有效 | H4/H4_GLOBAL/H11 |
| A03 | P1 | 没有采集开始序号/旧响应拒绝，迟到旧值覆盖新值 | H5/H5_PURE |
| A04 | P1 | GUI仍独立8次计数，未消费Host统一状态 | 现有degrade-refresh T3＋客户端源码 |
| A05 | P1 | 缺精确Agent守卫，合法祖先scope下子请求污染父观察 | 路由R1 |
| A06 | P1 | 能力闸门默认放行且生产未配置，顺序不可靠也能错误收尾 | 路由R2 |
| A07 | P1 | DeepSeek来源/账号/额度池只作标签，不验证；Reserve误用普通桶 | 路由R4两个分支 |
| A08 | P1 | 失败分类与实际provider语义不接通：明确失效当T、暂时结构错误当P | H6/H10/H12 |
| A09 | P2 | 第5次T及P/A后T丢失固定失败/过期状态，变“暂无数据” | H2/H3 |
| A10 | P2 | 自定义工具同次结果发布两遍，3次失败就清缓存 | H8 |
| A11 | P2 | 精确绑定歧义会退宽松/内置映射，反而注入错误规则 | 路由R3 |
| A12 | P2 | provider精确键被trim/lowercase误合并 | 路由R5 |
| A13 | P2 | 主动工具仍按旧单阈值劝收尾，与新normal阶段冲突 | H13 |

## 3. P1问题与修复出口

### A01 — 缺失投影依赖，且采集入口覆盖不全

位置：[Host导入与发布](../index.js#L26-L48)、[调用](../index.js#L176-L208)、[异常被吞](../index.js#L339-L342)。

publishObservation成功分支调用projectUsage，但该函数既未导入，也未在本模块定义。成功wire进入这里会ReferenceError，GUI/工具外层catch将错误吞掉，context始终只剩“暂无额度数据”。静态node --check抓不到未绑定运行时名字。

**原样复现H1：**真实GUI路由返回creditsTotal=123；本次路由已观察为workbuddy、关注和阈值均设置，context仍无数值。H1_CONTROL只在进程里补入该名字，立刻出现123积分和closing，定位明确。

另有[仅自定义分支](../index.js#L317-L324)直接返回customOnly，未执行后面的发布循环。H7用合法custom id＋本地URL校验失败（零网络）验证：GUI有config错误，模型仍“暂无”，不报应立即出现的固定获取失败。补一个import不能修复此分支。

**出口：**所有既有采集完成路径进入统一发布入口；补真实apply成功和仅自定义路径用例，断言实际context包含对应数据/固定状态，不仅断言函数已注册。不靠全局变量修生产。

### A02 — 身份、配置和启用状态未贯穿观察缓存

位置：[identity恒空](../index.js#L188-L207)、[配置更新仅换quotaCfg](../index.js#L210-L255)、[视图入口](../plans/quota-view.js#L119-L159)、[观察键](../plans/quota-observer.js#L77-L80)。

- publish对所有渠道都传identity=''，不使用已有custom gen、customKeyRev、实际凭据/账号来源信息。
- 配置变化不清理已失效的channelProjection/channelMeta；view只看quotaPolicyEnabled和关注列表，不检查全局enabled、单渠道enabled、当前custom是否仍存在/启用，也不核对当前身份。
- H11：自定义额度2CNY进入closing后保存新Key并增加公开修订，未采集新身份时仍显示旧2CNY并称“本次采集”，继续closing。
- H4/H4_GLOBAL：关闭WorkBuddy渠道，甚至enabled=false，旧123积分和收尾规则均继续输出。

**出口：**观察及视图按真正源身份/配置代次隔离；当前配置先过滤授权/启用/存在性，身份变化即时逐条失效并撤规则。未改动渠道保留原基线和计数，不能简单每次reload清空全表。账号证明拿不到时按交接限制功能，不把空身份当可共享账户。

### A03 — seq只是完成计数，不能拒绝迟到旧响应

位置：[observe成功覆盖](../plans/quota-observer.js#L106-L127)、[Host发布时间](../index.js#L188-L195)。

observe不接收采集开始id/序号，不比较旧代，成功一律覆盖；seq=(existing.seq+1)只是完成次数。at即使更旧也接受，Host又用完成时Date.now替代采集原时间。

**H5真实双路由复现：**先启动旧请求挂起→新请求返回9000积分、normal→放行旧请求返回1积分，模型又变closing。H5_PURE补证较旧at=1000能覆盖at=2000的新值。

**出口：**采集开始时带入稳定采集id、配置/身份代次、提交顺序；完成时验证是否仍适用，并保留原成功采样时间。过期请求/旧代/被替代结果不提交，读取/缓存命中不生成新观察。不得靠完成后seq++假装已处理并发。

### A04 — “统一5次”未落实到胶囊

位置：[客户端仍为8](../client.js#L709)、[仍独立settle/失败Ref](../client.js#L1384-L1487)、[GUI仍返回原wire](../index.js#L339-L363)。

Host新观察只用于模型，GUI继续收到原始wire，客户端自己计数/保旧值；没有消费Host统一结果。与构建摘要“胶囊与提示词共用状态/次数”不符，既不是统一5次，也不是同一计数。

现有[回归T3](../tools/test-degrade-refresh.mjs#L111-L123)正是在断言第6轮仍保旧、第8轮才失败，本次也通过了。因此全绿反而证明旧行为仍在，而非证明新契约完成。

**出口：**胶囊与模型读同一有效观察和失败状态；工具采集参与后，两窗口/模型/胶囊不能各数各的。修改8→5只是必要但不充分。前端只保留展示、配置过滤及断线交付处理，不能再重复累计Host已经累计的失败；保护此前自定义配置证明与删除/停用过滤。

### A05 — 把祖先scope准入误认为精确主体隔离

位置：[路由监听](../plans/quota-route.js#L80-L104)。注释说payload没有agent，但实际agentEvents明确注入agent；scope规则还允许祖先scope监听收到后代事件。

路由R1用公开bindScopeParent构造合法祖先/子scope，父原路由workbuddy、余额充足；子请求codex余额1%，父WeakMap被写成codex，父从normal变closing。

**前提说明：**此复现证明合法公开scope拓扑会污染，不声称当前每个spawn默认都建立该拓扑。交接已明确要求精确守卫，不能依赖“暂时没遇到”。

**出口：**在attempt++和delete旧观察之前检查payload.agent===subject；当前请求、signal、代次也需正确对应。加入真实scope过滤方法的父子案例，不能用永不向父派发的简化fake掩盖。

### A06 — 闸门注释“默认关闭”，实际默认true

位置：[默认放行](../plans/quota-route.js#L60-L61)、[生产未传闸门](../index.js#L161-L165)、[gate仅供手动调用](../plans/quota-route.js#L166-L174)。

没有落实已审查链/重载代次。reviewedWriters常量不是能力证明，也没有生产调用把gate关闭。不能以“尚未实现热重载”解释成“保持normal”，因为实际会发布和注入规则。

路由R2复现：observer读到workbuddy，稍后外层writer把真实请求改为openai-codex；context却依据WorkBuddy的1积分进入closing。当前Codex task/Reserve有真实post-next writer，风险并非只是假想恶意插件。

**出口：**默认闭合，接入明确已审查链与生命周期证据，失效后read也不继续放出旧观察。对无通知任意outer writer承认未支持，不能假称能提前检测；但也不能把已知顺序未验证的场景默认放行。

### A07 — source、账号与额度池没有形成适用性校验

位置：[候选映射仅附source](../plans/quota-prompt.js#L45-L64)、[view只按channelId读](../plans/quota-view.js#L143-L199)、[投影丢via](../plans/usage-tool.js#L270-L285)、[meta不保留源证明](../index.js#L203-L207)。

路由R4两例：

1. deepseek-official要求api源，但实际wire.via=account，1CNY仍被判closing；即使测试额外给meta.source=account，view也完全不检查。输出view.source='api'只是给错误数据贴标签。
2. 本次model=gpt-reserve，没有Reserve池证明，却直接用普通codex主桶rolling-5h=0%进入closing，忽略model。

账号型渠道也统一空identity，当前构建未落地研究中Codex冻结store/安全账号源证明。这不是要求凭空读取token，而是证据缺失应限制自动判断，而非照用别的池。

**出口：**保留Host私有的via、账号/凭据代次、quotaPool及匹配证据；验证匹配后才提供数字/规则。显式绑定需验证source与pool，不是复制字段。不能证明时normal，不为识别增加计费查询或直接读秘密。Codex普通/Reserve、DeepSeek账号/API至少各有正负例。

### A08 — 分类函数未接通provider真实语义

位置：[分类器](../plans/quota-observer.js#L47-L74)、[Host只传transient](../index.js#L188-L194)。

- structure即便transient:true也被判P；parse未显式transient就P；未识别错误没有transient也P，与“无法判断的一般故障先T”相反。
- credentialState/httpStatus在注释中声明，但实际没用；api不分明确session失效、付费拒绝或一般业务异常，一律T。
- H10经过真实custom provider的坏JSON路径，wire是structure/transient:true，第一回就移除原2CNY并报获取失败，未给1～4次宽限。
- H12经过真实WorkBuddy provider，固定session_dead/401前缀已被原provider判为非暂时语义错误，但wire统一成api后新观察器又把它当T；模型仍引用旧123积分、标缓存并closing，没有立即过期/normal。
- signed-out也不能无条件等于“过期”：首次未登录和明确需重登要保留区别。

**出口：**在provider归一层保留可信结构化原因，区分已知P/A与普通T。复用明确固定契约，不扫描任意自由文案里的401/token。让既有provider→发布→最终prompt跑通分类用例，不仅测手填errorCode的helper。

## 4. P2问题与修复出口

### A09 — 第5次与封存失效的固定状态丢失

位置：[T的lastOutcome](../plans/quota-observer.js#L161-L179)、[meta映射](../index.js#L203-L207)。

第5次记录为lastOutcome='transient'/channel=null；发布器只把failed/expired映射为固定状态，故view进入无数据分支，输出“暂无额度数据”而非“获取额度失败”。H2确认。

P/A后再遇T虽未复活数值，但lastOutcome改成transient，旧固定状态也消失。H3是过期→T后变“暂无”，违反保持已确定失效的约定。

**出口：**统一effectiveStatus（pending/ok/cached/failed/expired等内部状态）到GUI/模型；达到5次映射failed，sealed过期/失败保持，直到当前身份可信成功或确认换代。计数、数值和固定状态要一起断言。

### A10 — custom工具采集重复发布

位置：[emit发布](../index.js#L690-L699)、[onItem及批结果二次emit](../index.js#L732-L743)。

同一wire先经onItem发布，再被最终list循环发布一次；工具输出progress Map可能去重，但观察器在Map之前已经累计两次。

H8以真实custom请求链＋合成DNS/HTTPS验证：成功1次后连续3次注入HTTP503，fake HTTPS总调用4次；第1次仍缓存、第2次仍缓存、第3次已清掉2CNY，实际只3次失败就跨5次阈值。虚拟时钟仅用于跨过既有30秒工具成功缓存，每次确实执行一次采集，没有改产品预算。

**出口：**每次采集稳定sampleId，onItem/最终batch只能提交一次。不能简单把阈值翻倍；重试、成功清零与事件去重都应测试。

### A11 — 歧义绑定会继续退回宽松/内置映射

位置：[pick把歧义和未命中都返回null](../plans/quota-view.js#L207-L223)、[null后再走内置](../plans/quota-view.js#L143-L145)。

同一provider/model有两个冲突精确目标，函数先退provider通用绑定，若还为空则退内置codex。路由R3两种分支都错误closing，冲突没有fail closed。

**出口：**区分not-found、bound、ambiguous/invalid三态；精确命中且冲突即停止，不放宽条件，也不拿builtin抹掉错误。保存和读取都校验。

### A12 — 精确provider key不应大小写/空白猜测

位置：[隐式归一化](../plans/quota-prompt.js#L59-L64)。

真实LLM registry使用精确Map键；合法自定义route `OPENAI-CODEX`不等于内置`openai-codex`，却被toLowerCase映射成后者并依据其余额closing。路由R5确认。

**出口：**内置表用实际精确id。用户别名须显式绑定；不要凭大小写/空白相似猜供应商。

### A13 — 工具policy仍用旧单阈值，与新阶段冲突

位置：[describe仍传旧policyOf](../index.js#L504)、[旧字段取值](../plans/usage-policy.js#L157-L173)、[工具继续渲染旧建议](../plans/usage-tool-register.js#L440-L442)。

H13实际apply＋主动工具复现：新预警20、收尾10、当前剩余30%，动态context为normal无规则；旧quotaPercentThreshold=50仍让usage_status.policy附“30%<50%，可以选择收尾”。旧字段未参与新view，但仍通过工具结果进入模型，违背“不算两套冲突结论”和“旧字段保留但不参与新判定”。

**出口：**给工具policy明确迁移/兼容设计，与同一新判定源一致，或停用旧自动建议但保持只读查询/schema兼容。不能只删除旧section却留下旧工具建议；不能暗把旧50迁移成新的档位。

## 5. 另列的窗口业务风险（需确认口径）

[最短窗口选择](../plans/quota-prompt.js#L114-L137)与[阶段评估](../plans/quota-view.js#L74-L82)只看rolling-5h等最小周期。H9：rolling=80%、weekly=0%，仍normal且只告诉模型80%。

现有交接只要求“确认用于模型调用的相关窗口”，并没有明确授权“只看最短，忽略周限”。若同一账号的周限也约束当前模型，会错过保护。应由用户确认窗口选择口径；确认前不能把N5的存在当成该业务选择正确的证明。建议评估所有已确认适用的约束窗口，或提供明确窗口配置；不要混入不相关MCP/Reserve池。由于其它执行会话可能有额外业务确认，本报告不将此项混入13组确定问题统计。

## 6. 为什么92项新测试没有发现这些问题

- N12直接手工填projection/meta并调用view/renderer，证明的是纯渲染换档，不是实际apply采集已经发布成功；因此A01未被覆盖。
- N1把“未知无transient→P”写成期望，测试与用户确定的分类规则相反。此类绿灯不能替代需求验收。
- N13的fetchCount始终是局部常量状态，没有接到任何provider；[N13c](../tools/test-quota-awareness.mjs#L425-L449)甚至以`|| true`结尾，采样时间断言永远通过。
- GUI旧T3继续证明8次，未覆盖新统一5次与工具采集同步。
- 当前Y3配置重载用例在从未有路由/数据的情况下开关都断言空串，只证明注册/无观察时空，不证明warning/closing产生后撤销。

这些不是要求删除旧测试；应保留其安全语义、更新明确改变的契约，并新增真实apply→采集→观察→当前配置/路由→context→GUI的正负链路。

## 7. 建议整改顺序与再审出口

1. **先修A01接通数据链，但不要马上部署。**连接成功后，原来被A01掩盖的身份/来源问题会开始真的影响模型。
2. 优先完成A02/A03/A05/A06/A07的身份、时序、路由和能力闸门；不能先开闸再补证明。
3. 统一GUI/模型状态与5次计数，修A08/A09/A10并跑真实provider错误矩阵。
4. 修绑定解析、精确provider和旧工具policy；确认窗口口径后覆盖相应多窗口用例。
5. 将本次隔离复现转成项目正式、先失败后通过的回归，特别是原样apply成功、同源失效、后加outer负例及父子scope。移除永真断言，不修改测试来遮掩缺陷。
6. 复跑全量、重新本地打包，逐payload核对并给**新hash**。本报告只绑定6b4024…包，不能复用旧hash声称整改通过。
7. 更新构建记录：目前其中1218项、agentDefaultModel读路由、旧provider别名等段落已与本次实测/当前代码不同；“gate默认放行但未实现降级”不能写成“保持normal”。
8. 交独立复核后，再另获用户授权部署/真机验证。此时至少验证真实新turn、工具续轮、同step重试、normal无规则、错误固定状态及渠道切换；本地桩测试不冒充真机验证。

**本报告没有授权执行整改或覆盖安装。**用户若交给执行模型修复，仍须保持最多一个运行子代理、优先复用，不改宿主、不读/打印真实凭据、不提交、不推送、不发布、不自动重启。

## 8. 可重跑证据

```powershell
# 原样产品入口＋只在测试进程内补缺失名字后的故障隔离；均为合成依赖
node .diagnostics/review-quota-build-20261019/main-host-probes.mjs
# 实际scope/Event方法＋真实产品路由/视图模块，六场景
node .diagnostics/review-quota-build-20261019/subagent-route-review.mjs
# 压缩包与每个当前源文件的字节哈希比较
node .diagnostics/review-quota-build-20261019/audit-package.mjs
```

诊断目录可能未入库；转交到其它机器时需要携带这些材料或按正文重建正式用例。回归测试原日志位于[计数索引](../.diagnostics/review-quota-build-20261019/regression/counts.json)记录的各路径；没有后台作业残留。
