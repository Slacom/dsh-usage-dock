# 方向6第二次修复复核（第三轮）：仍需修Z1–Z3

> 日期：2026-10-19。对象：8DFEEBBF…本地包，承接[上一轮Y1–Y4报告](recheck-direction6-v0.9.0.md)。
> **结论：Y1–Y4多项原复现条件通过，Y4模型安全条件通过；仍有三个确认缺口，不予方向6整体放行。**本轮不重做已通过项，不把混币UI呈现建议追加为阻塞验收目标。
> 仅只读审查产品、运行隔离探针、更新审查文档；未修改运行时代码、未部署/改宿主/重启/提交/改标签/推送/发布。所有Key均合成，虚拟传输不访问外部余额服务。
>
> **（2026-10-19 第四轮独立复核）Z2/Z3及混币UI通过，凭据链仍需Q1–Q3**：1249项及另7项契约通过、41A6B229…包一致；显式Key身份绑定、正常凭据回退及停用渠道零解析仍有确认缺口。见[第四轮报告](recheck-direction6-round4-v0.9.0.md)和[修复提示词](fix-prompt-direction6-round4-v0.9.0.md)。
>
> **（2026-10-19 整改者补记）Z1–Z3 已逐组整改**：凭据采样即发送快照（内置与自定义同一机制）、自定义渠道外部取消与逐条回传 + 采集时间戳、`app-boot/config-reload` 作废两秒配置缓存并带读取代次。
> 证据：`tools/test-usage-recheck-z1z3.mjs`（25 项）+ `tools/verify-z-mutations.mjs`（四项变异均被用例捕获）。
> 另按用户「继续修复」处理了本文 §5 的非阻塞呈现建议（混币 UI 不再叫「获取失败」，胶囊显示「多币种」、
> 详情说明无法合计并逐笔给出可证单位），记为 Z4；它**不改动** Y4 的安全行为（仍不跨币求和、不参与金额策略）。
> 新包 `41A6B229…`（`91E3596E…` / `8DFEEBBF…` 作废）。真宿主冒烟、策略 UI、Android 仍未验证，本轮**不**声称已通过。


## 1. 已通过与产物

- 现有30个回归脚本共1214项检查/断言；另WorkBuddy契约7项，总1221项均通过，无跳过。独立日志采集，无退出期断言。
- 新增test-usage-recheck-y1y4的41项通过；其余方向6套件108/70/41/85/31项维持通过，C主线旧用例维持通过。
- 共享任务键现在包含identity，不可证明身份的渠道使用私有任务；原已知A/B并发身份、顺序OpenCode引用轮换的用例通过。
- 内置provider已接入可选signal/remaining，配置等待中途abort监听与逐个内置结果回传已加入。
- Y3已增加公开reload事件订阅及alive保护；但普通configEditor配置路径仍有Z3。
- Y4模型原条件通过：混币/未知币种不再求和，balance=null、availability=unknown，不触发金额策略；正常同币/单币/零正常。
- [当前包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：153473字节、23文件、解包452313字节；全部payload与工作区逐字节相同。
- SHA256 `8dfeebbf7d9f919e2ebf4b8f28c953000380436d53a2102cad5222cc8dbd77a5`。
- SHA1 `e0b0e7f805b84722809b241f8c0fb2ca62f3ad6d`。
- 入口语法与git diff --check通过。

执行者提供的变异测试证明所选回退会被现有断言捕获，但不证明其他时序/调用路径已覆盖。本轮未临时回退产品源文件，而是用当前实现独立重放下列实际失败条件。

## 2. Z1 / P1：身份采样与真正发送的Key仍可不一致，污染缓存

### 原因

[index的identifyChannels](../index.js)解析source.refs并哈希，但没有把解析出的凭据快照交给实际provider；[OpenCode取数](../plans/opencode-go.js#L36-L45)再次调用resolveApiKey。

任务虽然绑定了identify采样的identity，却没有证明这就是请求真正使用的Key。修复“任务A不能被调用方包装成身份B”不等于修复“任务自己也可能按另一个Key取数”。

### 实际探针

真实apply＋真实OpenCode provider，credentials.resolve先供两次身份采样返回合成A，实际发请求时引用已变为B；随后恢复A。虚拟fetch按真正Authorization返回A已用90/B已用50。

```text
SAMPLING_VS_TRANSMISSION:
first remaining=50
second remaining=50
resolutions=5, requests=1, actualTransmittedAccounts=[B]
```

第一次请求实际用B，因此50正确属于B；但它被写入采样身份A的缓存。第二次当前引用已是A，本应剩余10，却命中B的50且没有再请求。这是身份解析→实际请求之间发生轮换/回滚的窗口，不是要求禁止用户换Key，也不是两秒配置缓存。

### 修复/验收

- 身份与**真正发送的凭据**绑定：例如固定本次已解析凭据供provider使用，或由实际取数路径私下回报所用身份再验证；不得只在旁路采样两次hash就声称一致。
- 不向模型输出凭据或私有指纹，不改变显式Key优先/引用回退规则；无法证明一致时不复用或写入成功缓存。
- 绑定应覆盖内置回退引用与custom引用；不能只修OpenCode而漏另一条二次解析路径。
- 补真实provider的identify A→实际发送B→恢复A，检查首次来源、第二次值/请求次数及缓存；同时保留原A/B并发、顺序轮换与私有任务测试。

## 3. Z2 / P1：自定义渠道未接通外部取消和逐条进度

### 3.1 中途取消后仍发Bearer请求

工具collect把signal传给fetchCustomPlans，但[custom调度](../plans/custom-balance.js#L1619-L1640)创建独立budget；该模块没有把外部opts.signal联到预算/请求阶段。[requestJson](../plans/custom-balance.js)使用自己的controller，不能因此响应调用方提前取消。

真实apply＋custom provider，identify第一次引用解析立即成功，实际取数第二次解析等待100ms；第20ms取消调用。虚拟DNS/HTTPS记录：

```text
CUSTOM_AT_CANCELLED_RETURN: elapsedMs=31, sent=[]
CUSTOM_REQUESTS_AFTER_CANCEL:
 resolutions=2
 sent=[{elapsedMs:110,path:/balance,hasBearer:true}]
```

用户已取消且工具已返回，依赖迟到后仍启动新的带凭据请求。此前修复了内置路径，不代表custom的外部取消也已贯穿。这里不是要求回收一个已经在途且无法取消的服务调用，而是禁止取消后继续下一阶段。

### 3.2 custom A快/B慢，A成功结果仍整体丢失

[custom调度](../plans/custom-balance.js#L1635-L1663)只把完成值写进数组，没有逐条回调；index要等整个fetchCustomPlans返回后才逐条emit。只修内置emit不能保全custom快结果。

真实apply，两个custom都有合成显式Key；A约6ms返回balance12，B挂起，结果：

```text
FAST_SLOW_CUSTOM:
 elapsedMs=8004
 sent=[{elapsedMs:6,path:/fast-A},{elapsedMs:6,path:/slow-B}]
 result={channels:[],policy:null}
```

A已完成却没有交付；所有明确请求id也被空列表抹掉。

### 修复/验收

- 将外部signal与custom现有绝对budget、credentials/DNS/body/transport等待联动；取消/到期后不再发起下一阶段，不回填缓存。保留C主线的URL/连接绑定/TLS与10/20秒默认行为，工具预算只作为更短上限。
- 给custom逐条完成通道，在真正采集时记录fetchedAt并向工具emit；快值不能等待整批超时才出现，未完成id要有明确状态。
- 用真实apply→真实custom provider重放20ms取消/100ms凭据、A快/B挂起；虚拟HTTPS请求计数验零迟到发送、确认A12保留。共享调用还有其他有效等待者时不得错误中止共同任务。

## 4. Z3 / P2：reload事件被两秒配置缓存吞掉，策略仍不独立更新

### 原因

[createLiveConfig](../index.js#L108-L129)在两秒内返回旧cached.value；[reload回调](../index.js#L589-L604)虽新增了订阅，却只调用buildSnapshot，没有失效/强制重读配置缓存，也没有缓存到期后重试。

Y3测试使用volatile getter，旧对象也能读到新值，因此没有覆盖configEditor.configuration()返回普通override对象的正常路径。

### 实际探针

真实apply＋普通override的configEditor服务桩。启动30ms后替换override，立即发公开reload事件；不调用工具，不重复事件：

```text
false→true:
 before sections=0, configReads=1
 event后约65ms sections=0, configReads=1
 2271ms后仍sections=0, configReads=1
true→false:
 before sections=1, configReads=1
 event后约64ms sections=1, configReads=1
 2270ms后仍sections=1, configReads=1
```

两秒后额外再发事件作对照，两种情况才分别变为1与0，configReads变2。订阅有效，但第一次事件没有读取当前配置，缓存到期本身不触发刷新。

### 修复/验收

- reload语义必须触发可信的新配置读取，而非复用旧两秒缓存；可以提供明确invalidate/forceFresh，并防止并发较旧读取覆盖新状态。
- 不以“再等两秒、再手动调用工具或再发一次事件”作为用户恢复要求；固定等待两秒也不能替代配置版本一致性。
- 补普通override在缓存期内的开启/关闭/阈值/关注项变更，无工具调用且只有一次事件；还要保留getter路径、缺服务和卸载不复活的测试。

## 5. 非阻塞呈现建议：混币UI尚未表达unknown

Y4模型安全条件已通过，不把它重新列为本轮阻塞。当前真实provider成功取得CNY10+USD2或CNY10+未知赠金2时，UI仍把balance=null叫作“获取失败”，现金/赠金明细被隐藏（[胶囊余额分支](../client.js#L1795-L1823)、[详情分支](../client.js#L2001-L2045)）。

建议后续显示“币种不同/总额无法合计”，并只展示单位可证的明细。不要为了恢复显示而重新跨币求和；若另行处理，独立说明验收范围并保护正常单币UI。

## 6. 结论与交接

- Y1旧的任务身份串用条件通过，但实际发送身份绑定仍有Z1。
- Y2内置/等待取消等条件有进展，但custom路径仍有Z2。
- Y3增加订阅但普通configEditor路径仍有Z3。
- Y4模型安全条件通过，UI建议不阻塞本轮。

只继续修Z1–Z3，完整回归并重新打包后交回复核。真实DSH tools/systemPrompt冒烟、Android能力和策略UI仍未验证或未实施；本轮不因没有实机授权新增缺陷，也不以本地测试冒充实机通过。

执行提示词见[第三轮整改提示词](fix-prompt-direction6-round3-v0.9.0.md)。
