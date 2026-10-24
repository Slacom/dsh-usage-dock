# 方向6首次独立复核：尚不通过

> 2026-10-18。审核对象：声称已完成T0–T4的方向6本地构建，包SHA256以F03328…开头。
> **结论：工具框架已经搭建，但尚不能验收为T0–T4全部完成。**本报告按八个整改组D6-A～D6-H列出已复现问题与验收要求。
> 本轮只读产品代码、运行隔离探针及更新审查文档；未部署profile、未改宿主、未重启、未提交/打标签/推送/发布。
>
> **（2026-10-18 二次独立复核）仍需修Y1–Y4**：1172项及另7项契约通过，D9C6813A…包一致；原条件多项已修，但身份/single-flight、真实内置预算接线、策略配置生命周期及混币余额仍有确认缺口。见[二次复核报告](recheck-direction6-v0.9.0.md)和[二次整改提示词](fix-prompt-direction6-round2-v0.9.0.md)。
>
> **（2026-10-18 整改者补记）D6-A～D6-H 已逐组整改**：请求范围前置筛选、缓存按代次+凭据身份隔离、
> 真实 provider 语义（OpenCode 已用→剩余、WorkBuddy `creditsTotal`、DeepSeek 实际币种）、
> 只缓存成功并写 `fetchedAt`、入口 deadline 与 `exec.signal`、时间字段值级校验、
> 策略接入工具结果与 `systemPrompt.section`、阈值不再默认 20%。
> 逐项证据见 [整改记录 §0f](remediation-v0.9.0.md#0f-方向-6-首次复核整改d6-ad6-h) 与
> [方向 6 实施记录](direction6-0.9.0.md)。新包 `D9C681…`（本文所核 `F03328…` 作废）。
> 真实宿主冒烟、策略 UI、Android 可用性仍未验证，本轮**不**声称已通过。

## 1. 已通过、证据与边界

- 独立复跑全部现有回归：26个普通Node组880项、行尾38项、几何144项，共1062项；另WorkBuddy契约7项，全部通过，无跳过。按实际脚本计数共28组回归加1组契约，不等于1069个独立端到端场景。
- 新增四组226项与既有C主线整改回归维持通过；缺tools服务不使插件崩溃、工具定义基本形状与disposer已有检查。
- [本地包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：141494字节、23文件、解包412344字节，23个payload全部与工作区逐字节相同。
- SHA256：`f033285d9263ea2924e3ed5ff9c3520c18a57926cb41931eb5f6aaa12316ff7a`。
- SHA1：`b88f9bc3a96d81b84e8941ba3e6693124818f43a`。
- 当前归档与提交说明一致，但包含下述问题，不能以现有测试全绿代替方向6验收。
- 从当前桌面app.asar只读取出tools/systemPrompt入口，和[本地提取副本](../.diagnostics/host-src/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js)逐字节核对一致。核验不是仅相信执行者补记；未修改宿主。
- 原[第五轮C主线结论](recheck-v0.9.0-round5.md)绑定旧E41967…包和当时范围，不能自动延伸为当前方向6新包通过。

## 2. D6-A / P1：查询单条自定义余额，实际取数整批条目

**位置**：[工具Host编排](../index.js#L300-L307)。先求customIds，但调用fetchCustomPlans时仍传完整cfg，**取完所有自定义条目后才过滤结果**。

**实际探针**：真实apply，两条启用自定义记录A/B，请求ids只有A。

```text
requested: [custom:reviewAAAAAA]
resolvedReferences: [ref-A, ref-B]
resultIds: [custom:reviewAAAAAA]
```

第二个隔离探针把DNS与HTTPS替换为本进程内桩，使用合成Key：在约6ms观察到`/unrequested-B`携带Bearer的请求。没有向外部域名发出真实网络请求，但执行路径确实启动了B请求。

**影响**：违背“白名单∩已启用∩用户请求”，模型未请求B也会解析其凭据并访问上游；结果过滤不能补救已发生的副作用。

**要求**：在任何凭据解析/DNS/网络之前把自定义条目缩为本次允许集合；保留稳定id对应的secret路径，不做仅事后过滤。补A/B均有合法凭据、只查A时B的resolve/DNS/request计数均为零；空集合、停用、删除、退场同样零取数。

## 3. D6-B / P1：工具缓存未按实际账户/凭据与内置开关隔离

**位置**：[describe](../index.js#L265-L283)只返回configDigestOf(cfgNow)；该摘要是自定义元数据+customKeyRev，不含内置Key、内置开关或外部凭据引用实际值。注释称含“各开关状态”，与实现不符。[缓存命中](../plans/usage-tool-register.js#L146-L165)不再确认当前允许集合。

**实际探针**：真实apply、真实配置解包，替换DeepSeek provider为返回合成账户余额的函数；volatile getter依次返回Key A、Key B、enabled=false。

```text
BUILTIN_SEED     balance=91.23, fetchedAt=null
BUILTIN_ROTATED  balance=91.23, fetches=1  // B的模拟余额应为12.34
BUILTIN_DISABLED balance=91.23, fetches=1  // 已停用仍给旧成功数据
```

这不是Host的两秒重读缓存：探针用volatile getter，当前cfg已能读到新Key和新开关，工具30秒结果缓存仍命中。

**要求**：
- 按当前允许集合及真实账户/凭据身份隔离缓存与single-flight；显式查询停用渠道不能绕过过滤命中旧成功值。
- 自定义引用背后Key轮换也必须隔离，不能只依赖引用名/customKeyRev。内置账号登录/退出/换账号同理；无法可靠判定身份时宁可禁用该来源缓存，不猜账户。
- describe与collect应绑定同一个配置/身份快照；返回前再确认代次，旧代迟到不得回填或作为新代输出，卸载后在途任务不能继续回写。
- 指纹仅在Host内部，不得向工具输出真实Key或可逆秘密。
- 测内置Key A→B、开关、引用实际值轮换、登录源变化、在途切配置与缓存TTL命中；不是只手改测试generation字符串。

## 4. D6-C / P1：实际provider到模型的语义适配错误

### C1：OpenCode把已用90%说成剩余90%

[OpenCode provider](../plans/opencode-go.js#L45-L50)调用[norm](../plans/util.js#L275-L285)，将usagePercent作为已用percent保留；[工具投影](../plans/usage-tool.js#L105-L117)却无条件标成remaining。

隔离真实fetchPlan接收`usage.rolling.usagePercent=90`后：

```text
wire.percent=90
project.percent=90, percentMode=remaining
render: OpenCode Go：rolling-5h 剩余 90%
policy(percentThreshold=20): null
```

实际剩余应为10%，当前不仅误报，接入策略后还会反向影响收尾判定。计划原本要求OpenCode用途核实后扩展，不能为了全部覆盖而猜口径。

### C2：WorkBuddy两个有限积分渠道全部丢失

[真实wire](../plans/workbuddy.js#L288-L298)使用creditsTotal；[投影](../plans/usage-tool.js#L181-L191)仅读balance或creditsBalance字符串。

真实workbuddy/workbuddy-ai provider返回creditsTotal=1906，投影均得到：

```text
kind=credits, availability=unknown, balance=null, fetchedAt=null
```

### C3：DeepSeek币种丢失

[真实API路径](../plans/deepseek.js#L167-L185)优先CNY否则使用首个币种，但wire没有返回所选currency。真实USD7.25响应投影为balance=7.25、currency=null；账号路径也没有可靠的工具币种输出。

**要求**：
- 按真实provider契约逐渠道适配，不靠测试中发明的wire字段。OpenCode转换为100-used或明确输出used并配套schema/render/policy；Codex保持剩余口径，不能一起反转。
- WorkBuddy读取有限creditsTotal，0/负数/缺失/unlimited分别处理，并明确积分单位。
- DeepSeek带回实际所选币种，不把USD硬编码为CNY，不把多币金额无条件相加。
- 比例只接受可信0..100，越界未知而非钳位。支持清单之外先返回受控不支持，不猜窗口用途。
- 真正的unknown、停用、已删除/不存在的自定义记录、传输missing、缺凭据/未登录应有可辨状态码；不能一律混成missing或丢掉原渠道类型。
- 验收必须真实provider→工具→render/策略；包括OpenCode used=0/90/100、WorkBuddy 0/1906/负数/unlimited、DeepSeek CNY/USD与未知币种。

## 5. D6-D / P2：“只缓存成功”与采集时间契约没有实现

**位置**：[usable判断](../plans/usage-tool-register.js#L162-L164)只有“unknown+missing”不缓存，error/network、auth等均会缓存；[fetchedAt](../plans/usage-tool.js#L211)只读原wire，真实provider/工具collect都未赋成功采集时间。

**实际探针**：第一次collect返回network错误，第二次本应成功12；两次execute却均返回同一network，collectCalls=1、cacheSize=1。混合成功+失败批次也会把失败一并固化30秒。真实成功provider和apply探针的fetchedAt均为null。

**要求**：只缓存真实成功，错误/unknown/缺失/语义拒绝不作为成功缓存；混合批次失败应可重试。成功采集时写fetchedAt，TTL命中保持原时间，真正重新采集成功才更新；不能用cache命中/渲染时刻伪造新鲜度。补失败→恢复、混合批次、TTL/时间戳断言。

## 6. D6-E / P1：8秒不是端到端预算，超时/取消后仍会取数

**位置**：[execute与query](../plans/usage-tool-register.js#L146-L199)预算前先await两次describe，[withBudget](../plans/usage-tool-register.js#L221-L235)仅race collect且不取消底层，execute也忽略exec.signal。[真实collect](../index.js#L295-L310)先Promise.all所有provider，故超时只能丢掉整批。

**已执行结果**：

```text
END_TO_END_BUDGET: elapsedMs=9019, describeCalls=2, availability=ok
  // 每次describe4500ms，已超过8秒还返回成功；describe永久挂起则没有工具自身deadline保护。
ALREADY_ABORTED: collectCalls=1, availability=ok
  // exec.signal在调用前已abort，仍取数。
PARTIAL_RESULTS: elapsedMs=8009, deepseek=missing, mimo=missing
  // DeepSeek立即成功12，MiMo挂起，已完成的DeepSeek仍被一起丢掉。
```

隔离真实apply+custom余额探针（虚拟DNS/HTTPS，无外部请求）还观察到：

```text
AT_TOOL_RETURN elapsedMs=8010, A=missing
AFTER_LATE_CREDENTIAL_RESOLUTION:
  /unrequested-B  elapsedMs=6     hasBearer=true
  /requested-A    elapsedMs=9005  hasBearer=true
```

A的凭据解析9000ms后完成，工具已在8秒返回，底层仍继续发Bearer请求。C主线自己的10/20秒预算没有被破坏，但它**不能代替**工具更短的8秒预算。

**要求**：从execute入口创建绝对deadline，贯穿配置读取、解析身份、排队、DNS/网络/body；传递/组合exec.signal；到期/取消不得开启后续凭据请求，不回写结果缓存。逐渠道保留已完成成功值，只有未完成项超时；不能让慢渠道抹去快渠道。single-flight要有明确调用方取消与共享任务清理语义，卸载清理在途任务。补上述真实路径负例，不只测withBudget(Promise,短ms)。

## 7. D6-F / P2：时间字段仍可透传上游自由文本

**位置**：[projectWindow](../plans/usage-tool.js#L105-L117)只检查resetsAt非空字符串；OpenCode norm也保留原字符串。

真实OpenCode provider的隔离响应把resetsAt置为：

```text
SENTINEL_SECRET https://private.example/account/123
```

结果该值逐字进入结构化工具输出，availability仍为ok。这里确认的是execute结构化结果，不声称当前render摘要显示了该字段，也没有使用真实秘密。

**要求**：时间字段只接受可验证且规范化的时间，非法置null；对resetInSec等数值也做合理语义校验。补上游把Key/URL/账号哨兵塞到所有允许字段的脱敏负例。不要只证明未知额外键被删除，就声称所有白名单字段都是安全值；用户自填厂商名应单独按授权边界处理。

## 8. D6-G / P2：T3只有死路径纯函数，不是可用策略

**位置**：[index](../index.js#L43-L62)只引入策略schema；工具execute/render均不调用policyPromptFor。产品中没有任何实际路径将其文本交给模型。

**实际apply探针**：policy enabled=true、关注DeepSeek、余额阈值10、真实账号桩余额1。execute得到balance=1，render仅“DeepSeek：余额 1”；手工调用policyPromptFor相同cfg/result却生成完整建议。证明开关对真实工具输出无效，不是“等待真机验证”才知道的缺口。

[实施记录](direction6-0.9.0.md#L98-L105)坦承未注入，但把T3称已实施、整体T0–T4称完成不准确；“注入必须改宿主”的理由也未经证实。当前app.asar与提取副本逐字节一致，而[公开systemPrompt.section/context](../.diagnostics/host-src/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js#L245-L281)客观存在，返回disposer。这里不宣称它已被本轮真机接通，只说明不能直接断言唯有改宿主。

**要求**：核验可选公开section/context或工具结果附加策略等合规路径，接入真实模型可见链路；不改宿主、不硬inject。缺服务/未启用/无阈值不产生影响，配置变化和卸载正确清理。若确实只能交付只读工具，须先向用户明确缩减T3范围并获确认，而不是自行用“纯函数已测”替代完成。策略UI未做和真实宿主冒烟未跑应继续如实标记。

## 9. D6-H / P2：策略擅自采用未授权的20%默认阈值

**位置**：[schema默认20及policyOf](../plans/usage-policy.js#L21-L38)、[阈值解析](../plans/usage-policy.js#L73-L86)。

**实际探针**：启用策略+关注codex，但不填percent阈值，或阈值为NaN，均得到`percent=20`。计划明确20%只是示例，不是确认默认；无效/未配置不应自动补成有效阈值。该问题目前被D6-G的死路径掩盖，接通前必须修。

**要求**：未配置/无效阈值安全禁用，明确范围和单位，不能拿全局金额阈值对未知币种作肯定预算判断。只有显式有效、适用于该渠道/单位的配置才参与；0/负数/NaN/越界、未关注、错误/unknown/stale/unlimited均不劝停。

## 10. 整体验收与后续

- T0：已有真实源码契约证据；真正运行宿主的注册/调用/render/卸载冒烟仍未跑，不冒充实机完成。
- T1：白名单框架有，但D6-C/F的实际语义与字段值安全未过。
- T2：可选注册框架有，但D6-A/B/D/E未过。
- T3：生成器有，但实际接入和阈值授权未过。
- T4：本地现有回归/打包通过；新增反例尚未纳入，用户试装未做。

只整改方向6与必要的provider标准字段，不顺手推进方向4/5，不恢复退场渠道。保护C主线已验收的配置摘要、customKeyRev、实际凭据gen、连接IP绑定、绝对预算、整页保存事务、按渠道失败回退及全部既有用例。新包重新回归打包后交回复核。

完整执行提示词见[方向6整改提示词](fix-prompt-direction6-v0.9.0.md)。
