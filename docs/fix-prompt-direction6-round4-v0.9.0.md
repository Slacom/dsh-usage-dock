# 执行提示词：方向6第四轮整改，仅修凭据契约Q1–Q3

```text
继续整改dsh-usage-dock 0.9.0方向6，只修第四轮独立复核Q1–Q3。Z2自定义取消/逐条结果、Z3策略reload、Z4混币UI本轮已通过，不重做、不回退。

工作区：E:\WorkSpace\DSH\DSH Usage Dock

先完整读AGENTS.md、docs/recheck-direction6-round4-v0.9.0.md、docs/direction6-0.9.0.md、docs/remediation-v0.9.0.md。保护全部未提交成果，不reset/clean，不动v0.8.5标签，不推进方向4/5，不恢复退场渠道。

现状：独立复跑1249项回归+7项契约均通过，41A6B229…包23个payload匹配工作区；现有测试没有覆盖下述三个实际失败边界。先写失败用例再修。

建议先统一契约，不再按单个反例局部补丁：
1. 用当前已启用∩支持∩请求集合决定哪些渠道可以触碰凭据；原请求列表只用于解释disabled/not-found等状态。
2. 每个允许渠道按原优先级选择实际生效来源：显式Key/Cookie优先，再按顺序解析引用候选；只需要的来源参与解析。
3. 对本次有效凭据形成Host私有快照，identity、single-flight和真正发送均取同源值；同时区分该渠道“未提供快照”和“完整采样后确定没有凭据”。不要用空全局字典代表所有渠道无Key。
4. 无法证明身份的账号型来源继续不缓存、不跨账户共享，但正常预算内取数/回退不能因此失效。秘密/私有指纹绝不输出给模型。

Q1/P1 显式Key没有被绑定，仍污染缓存：
index把cfg显式Key哈希进identity，但快照只存refs；collect重新读cfg，resolveApiKey首先用当前显式Key。
独立真实apply+普通configEditor+真实OpenCode：开始apiKey A；身份采样时一个引用解析等待2100ms并把override改B；collect跨过两秒缓存读到B并发送B。恢复A、等缓存到期再查询，仍拿B的remaining50（A应10），requests=1/resolutions=4，唯一发送账户B。
修复：显式Key/Cookie也必须与采样身份同一份有效凭据快照，不只是冻结refs。有效显式Key不应再依赖未用回退引用，但“跳过多余resolve”不能代替真正绑定，因为同批其他条目的等待也会遇到配置变化。
验收：显式A→等待中B→恢复A，检查发送凭据与第二次结果/缓存；增加同批其他渠道等待的变体。保留引用A/B并发、顺序轮换、私有任务和共享取消。

Q2/P2 快照破坏正常回退：
A. DeepSeek账号服务不可用、插件无Key、模型DEEPSEEK_API_KEY可用：同一真实provider直接fetch成功CNY7.25；usage_status却no-credential，resolvedRefs=[]。原因：DeepSeek因账号型跳过identify，但仍收到空builtin快照，resolveApiKey把它当成权威无Key结果，拒绝正常回退。
B. OpenCode首候选OPENCODE_GO_API_KEY为空、第二候选OPENCODE_API_KEY有效：直接provider成功usagePercent90，工具却no-credential。快照循环首个空值后立即return undefined，不再继续下一候选。
修复：逐渠道区分快照未采样/已采样无Key，保持原来源优先级、空值与哨兵语义；空或不存在前候选继续后候选，不能把不缓存渠道变成不能取数。
验收：真实apply/provider对照测试DeepSeek无账号+模型Key，OpenCode第一候选空/不存在+第二候选有效；显式Key可用但credentials服务缺失/慢/抛错也不应影响它。不为修回退偷偷重新解析已冻结的来源，避免复发Z1。

Q3/P2 停用内置渠道仍被解析凭据：
真实apply全部内置开关false，显式query opencode-go，结果虽disabled，credentials.resolve仍收到OPENCODE_GO_API_KEY和OPENCODE_API_KEY。确认的是多余解析，没有声称已发送余额请求。
修复：在identify字段/凭据读取前过滤当前允许集合。可以保留原ids以返回disabled，但不能用原ids访问秘密。
验收：停用内置显式点名、全局关闭、空集合、退场/已删除custom，resolve/DNS/请求计数均零；不得回退之前custom只查A不访问B的修复。

交付要求：
- 三组都提供真实失败→通过；不要只单测解析helper或手工generation，必须验证真实apply/provider的来源、请求次数、结果与缓存。
- 保护C主线secret路径/保存事务、customKeyRev/配置摘要、实际Key gen、IP固定lookup/TLS、绝对预算、失败回退与Web强刷/35/40秒兼容。
- 跑现有32组回归+WorkBuddy契约以及新增用例，准确统计失败/跳过；Z2/Z3/Z4已通过的独立场景保持通过。
- 更新实施/整改记录及审查补记，不提前声称独立验收；真实DSH冒烟、Android、策略UI的未验证边界照实保留。
- 重新打本地包，逐文件核对payload、语法、注册表和新hash。最终回报Q1–Q3修改位置、负例、全量结果、未验证项与新产物，交回复核。

禁止：改DSH宿主、部署当前profile、自动重启、git commit、创建/修改标签、push、Release、npm publish、读取或打印真实凭据。实机冒烟另获授权，无授权不影响可做的离线整改。
```
