# 额度感知第三轮复核：仍不通过

> 2026-10-20。审查包SHA256：`25aee92f28bc94906273cdee6234c0d538431e9a938679836b3f4e259cb5dfbb`。
> 依据：[第二轮六组问题](recheck-quota-awareness-round2-20261019.md)。**不是全部六组已闭环：三组有明确修复，另外三组仍有残留，并新增混合GUI重复取数。**
> 本轮只审核、合成复现和保存报告，没有改产品/既有测试、读取真实凭据、部署、重启、提交或发布；未调用子代理。

## 1. 核验结果

- 全量40个脚本均exit0：**37个普通Node组1334项＋行尾59＋几何144＋契约7＝1544项**，0跳过。[执行清单](../.diagnostics/review-quota-round3-20261020/regression/summary.json)、[分组计数](../.diagnostics/review-quota-round3-20261020/regression/counts.json)。
- 包180836字节、27个文件，逐payload与当前源码比对**mismatch=0**，SHA1 `1de396631feed0e0a8c83569d2683b0fce39b894`。[包核验](../.diagnostics/review-quota-round3-20261020/package-audit.json)。下列问题确实在新包里。
- [定向探针](../.diagnostics/review-quota-round3-20261020/host-probes.mjs)真实import当前apply/provider/工具编排；客户端用项目现有mock React加载**真实客户端源码**，而非手工复写settle。
- 网络、DNS、Key、Cookie及账号均为合成依赖，没有向真实供应商发探针。复现输出在[日志](../.diagnostics/review-quota-round3-20261020/host-probes.log)。
- 日志FAIL是“缺陷复现成立”的断言，不是正式回归失败；本轮探针所有运行均exit0。此前“旧脚本断言缺陷存在”的口径仍适用，整改时要转成正确行为断言。

## 2. 六组整改逐项结论

| 第二轮项 | 本轮结论 | 证据 |
| --- | --- | --- |
| R2-01 开始票据 | **部分**：GUI同身份乱序修好；工具仍完成后签票；缺当前身份校验 | PASS_GUI_TICKETS / FAIL_TOOL_TICKET_LATE；另见隔离控制 |
| R2-02 逐渠道身份 | **未通过**：调用不可见的shortHash，异常后所有现存活动渠道身份仍为空；自定义Key/修订另有遗漏 | FAIL_IDENTITY_HASH_SCOPE / CONTROL_HASH_NAME_ONLY / 自定义控制 |
| R2-03 信任开关缺省 | **本项已修**：schema默认false、生产===true；不配置时实际context为空 | PASS_PRODUCTION_GATE_DEFAULT_CLOSED |
| R2-04 T不抹来源 | **原数值绕过已修**：account值在api路由下经过T后仍被拒绝 | PASS_SOURCE_STAYS_BOUND_AFTER_T |
| R2-05 GUI有效缓存 | **部分**：Host开始补数值，但客户端没消费；窗口结构也未适配 | 两个真实客户端复现 |
| R2-06 错误分类 | **原问题已修**：真实内置坏JSON走缓存宽限；已知endpoint/未安装/不兼容为P | PASS_NATIVE_PARSE_AND_KNOWN_P |

这里的“本项已修”只指已复核的原场景，不意味着真实计费账号已绑定、任意热插writer已支持、完整UI或真机验收已经完成。

## 3. 四组当前包的P1阻断问题

### R3-01：身份函数的hash在错误作用域，try/catch掩盖了故障

位置：[身份函数返回](../index.js#L228-L255)、[shortHash实际定义](../index.js#L689-L699)。

identityOfChannel定义在apply作用域，却调用只在内部tools effect闭包声明的shortHash。JavaScript是词法作用域，调用栈里有这个名字也不能让外部函数看到它。调用抛ReferenceError后被catch转换成空字符串，现存活动渠道继续用空身份缓存。

**原样产品复现FAIL_IDENTITY_HASH_SCOPE：**MiMo Cookie A取得1CNY/closing→保存Cookie B并发config-reload→模型仍收到旧1CNY及收尾规则。这不是强账号证明尚未实现的问题，而是已经拥有的Cookie配置变化都没有生效。

为排除其它因素，诊断进程临时提供同签名SHA函数，仅补该名字，不改源文件，控制组立刻能在换Cookie后撤掉旧额度。见CONTROL_HASH_NAME_ONLY。

**修复出口：**将hash helper放到双方可见作用域或在身份函数中直接实现。身份计算异常不能返回一个可被所有采集共享的“有效空身份”；应撤掉相应缓存/规则，并仅在本地报告原因。正式测试必须同一个apply实例里保存配置，再断言实际context改变。

### R3-02：工具采集仍晚签票，能覆盖较新的GUI结果

位置：[工具emit](../index.js#L978-L983)、[工具provider调用](../index.js#L995-L1009)、[publish的补签](../index.js#L290-L296)。

GUI签票确实提前了，但工具调用仍是publishObservation(wire)，没有开始票据。工具结果到达时再补签，拿到的序号晚于已经完成的GUI采集。

**FAIL_TOOL_TICKET_LATE：**先启动工具请求并挂起→GUI返回9000积分/normal→旧工具返回1积分，context再次变成1积分/closing。单看GUI双请求用例会误判整个R2-01通过。

**修复出口：**盘点所有真实调用点，GUI与工具的内置/自定义采集都在开始处绑定ticket、配置和源身份，完成时传同一张。工具自定义onItem与batch去重不能重新签票。不同入口交叉并发必须纳入正式测试。

### R3-03：Host补了缓存，但客户端仍用自己的旧值，冷启动窗口格式不识别

位置：[Host补数值](../index.js#L378-L412)、[客户端cached分支](../client.js#L1418-L1424)、[原生窗口渲染](../client.js#L1834-L1848)。

两条已真实加载客户端代码的复现：

1. **FAIL_CLIENT_LOCAL_OVERRIDES_HOST_CACHE**：胶囊曾见WorkBuddy=1；工具采集得到321；下一次GUI失败，Host明确回cached、creditsTotal=321，模型也是321，但客户端优先找prevCached，实际渲染文本仍为`WorkBuddy✦1`。
2. **FAIL_COLD_QUOTA_WINDOW_SHAPE**：工具已有Codex剩余33%；新窗口首次GUI失败，Host附上通用windows数组，模型显示缓存33%；客户端仍找rollingUsage/weeklyUsage，实际渲染`OpenAI Codex获取失败`。

balanceFromCache/staleSampledAt在客户端没有对应消费路径，不能因为HTTP包里有数值就宣称GUI已经共享有效观察。

**修复出口：**客户端优先使用Host这一版有效值，并正确设置缓存/灰化状态；本地lastList只能兼容缺乏新协议的旧响应。配额窗口需做双端结构适配，不能直接把模型投影的剩余比例塞给期待原始已用比例的渠道。覆盖冷/热窗口、工具更新后的GUI失败，及金额/积分/窗口三类。

### R3-04：混合GUI路径会重复查询每个自定义渠道，即使策略关闭

位置：[无条件启动customTask](../index.js#L539-L550)、[有内置渠道时再次启动customWork](../index.js#L591-L604)。

只要有启用内置渠道，代码仍先启动customTask，然后另起customWork调用第二次fetchCustomPlans。第一份结果没有发布或返回，但请求已经发出。

**FAIL_MIXED_GUI_DUPLICATES_UPSTREAM：**真实custom provider＋合成DNS/HTTPS计数，同一GUI请求只有一个启用custom条目，传输调用2次，返回custom行1条。用例明确设置quotaPolicyEnabled=false，证明不是只有开启新策略才会触发；关闭策略也不能规避此取数回归。

**修复出口：**只创建一份自定义采集任务，并由仅自定义/混合分支消费同一份结果；不要以丢弃结果当成没有发请求。给每个渠道的实际传输数和提交数各加断言，确保一轮一个采集、一个提交，不额外轮询。

## 4. 修hash时必须一并处理的两项残留

以下用例仅在**该诊断Node进程**临时补入缺失shortHash名字后执行，未改产品文件。目的是把后续逻辑与R3-01的吞异常分开，不伪称当前原样包已走通这些身份分支。日志名称均明确含AFTER_HASH_FIX。

### 4.1 自定义身份遗漏Key与公开修订

[自定义身份分支](../index.js#L243-L252)只拼URL/路径/币种/引用名/目标绑定，没有使用entry.key、实际引用解析结果、wire.gen或该条customKeyRev。注释说拼修订号，但代码没有。

FAIL_CUSTOM_KEY_REV_IGNORED_AFTER_HASH_FIX：取得2CNY后保存另一把合成Key并将该条修订1→2，旧2CNY/closing仍保留。应按该条实际凭据/非密修订失效，且不影响别条；不能只修hash名字就再次宣布身份完成。

### 4.2 旧身份结果仍能破坏新身份的有效状态

[publish提交](../index.js#L312-L330)没有在改channelProjection/Meta前核对ticket.identity是否仍为当前身份；observer按每个身份分别存，旧身份没有新commitSeq，仍能通过自身key的提交。

FAIL_OLD_IDENTITY_CLOBBERS_NEW_AFTER_HASH_FIX：Cookie A请求先挂起→换B→B得到95CNY/normal→放行A，旧A覆盖id级projection/meta；view虽拒绝显示A的值，却把有效B快照也遮掉，context从95变为空。

这不是“旧A余额已被当成B显示”的复现，而是“旧结果仍改写当前id映射，导致当前数据消失”。必须在提交及更新共享映射前验证当前身份/作废代次，不只是最后让view挡住旧值。

## 5. 为什么本次30项整改测试仍全绿

- 新R2-01确实测试了真实GUI乱序，值得保留；但没覆盖工具→GUI交叉，遗漏实际另一入口。
- [R2-02测试](../tools/test-quota-round2.mjs#L150-L163)用测试自己写的fp(A)!=fp(B)，再另起两个apply实例看都能返回，**没有在同一个实例保存Cookie并验证旧观察撤销**；产品内部hash完全不可见也能绿。
- 测试boot没有实际Agent路由观察；缺省新闸门又是关闭，若只断言context为空，更无法检验已有规则随身份变化被撤销。
- [GUI补缓存测试](../tools/test-quota-round2.mjs)检查HTTP字段，不执行真实客户端cached分支，漏掉本地旧值优先和窗口格式不一致。
- 混合与仅自定义分支仅验返回行，没数传输调用，额外请求被忽略。

不能删这些用例，而应补齐相同实例的配置变化、跨入口并发、真实客户端消费及真实传输计数。1544项检查全过的事实不变，但不能外推为这四个链路已验收。

## 6. 下一轮建议一次闭环的范围

1. 先修hash作用域＋逐条凭据/修订＋提交前当前身份/代次校验，避免修了一个后另一个才显现。
2. 将GUI内置、GUI自定义、工具内置、工具自定义四类provider调用列清单：开始票据、实际发送来源、每个结果只提交一次；仅自定义与混合分支复用任务，不做第二次查询。
3. 把Host有效缓存协议真正接到客户端，并测试新窗口与已有旧基线的窗口，不只读HTTP JSON。
4. 保留本轮已修的默认闭合、缓存来源绑定、解析宽限/明确P分类，以及GUI同身份票据顺序。
5. 将本轮原样与控制用例转为正式“修复后”断言，重新打包并交独立复核。本报告只对25aee…包有效，后续不要覆盖本轮证据目录。

仍未验收：真实账号/额度池证明、窗口口径、策略设置UI、真实宿主注入/重试验证。交付文案也要区分：阈值控制warning/closing；未配置阈值本来仍允许normal额度事实，并非必须两档都填才有任何功能。不要把默认关安全闸门解释为这些未完成项已经无需处理。

## 7. 复跑与交接

```powershell
# 当前版本下确认缺陷及正向控制，exit0表示复现成立；整改后请改为正确行为断言
node .diagnostics/review-quota-round3-20261020/host-probes.mjs
# 仅用于当前审查版本；后续新包请使用新目录，不覆盖本轮证据
node .diagnostics/review-quota-round3-20261020/audit-package.mjs
```

后台回归job `pwsh-490bad52df814a92`已收集、exit0，无未收集作业。没有启动子代理。所有诊断材料只在隔离目录，可能未入Git；跨机器交接需携带或按正文重建。**下一步是执行者整改，不是部署/发布。**
