# 方向6整改后二次独立复核：仍需修Y1–Y4

> 日期：2026-10-18。对象：声称已整改D6-A～D6-H的D9C6813A…本地包。
> **结论：已修复多项原复现条件，但仍不通过；仅继续整改下面四组，不重做已通过项。**
> 本轮未修改产品源代码、未部署、未改宿主、未重启、未提交/打标签/推送/发布。探针使用合成凭据、隔离网络桩或替换内存中的provider；均已恢复，未读取真实凭据。
>
> **（2026-10-19 第三轮独立复核）仍需修Z1–Z3**：1214项及另7项契约通过、8DFEEBBF…包一致；Y4模型安全条件通过，但实际发送身份绑定、custom取消/进度与两秒缓存内策略reload仍有确认缺口。见[第三轮报告](recheck-direction6-round3-v0.9.0.md)及[修复提示词](fix-prompt-direction6-round3-v0.9.0.md)。
>
> **（2026-10-19 整改者补记）Y1–Y4 已逐组整改**：共享任务键纳入身份并改按任务身份交付/回写、内置渠道解析source.refs实际值、plan.fetch接收工具signal/预算、逐渠道回传并在采集当时写时间戳、订阅`app-boot/config-reload`更新策略段落、DeepSeek只对同币种求和。
> 证据：[Y1–Y4测试](../tools/test-usage-recheck-y1y4.mjs)（41项）与[变异校验](../tools/verify-y-mutations.mjs)。
> 新包8DFEEBBF…（本文所核D9C6813A…作废）。此为实现者提交说明，不代表独立验收；真宿主冒烟、策略UI、Android仍未验证。

## 1. 已通过与产物

- 独立复跑29个回归脚本：27个普通组989项、行尾39项、几何144项，共1172项；另WorkBuddy契约7项。全部1179项通过，无跳过。采用独立日志重定向采集，没有遇到执行者所述退出期断言。
- 五个方向6套件108/70/41/85/31项通过。普通真实provider条件：OpenCode已用90→剩余10，WorkBuddy两渠道1906积分正常，DeepSeek单币USD7.25正常，恶意resetsAt哨兵置null，缺省/NaN/越界阈值不触发，工具结果与render已有实际策略文本。
- 原“查A却访问B”探针现在只resolve ref-A（身份解析和取数各一次），不再出现ref-B。
- 原DeepSeek顺序Key A→B探针输出91.23→12.34；停用后返回disabled，provider总调用2次。不缓存账号型渠道的保守策略对此有效。
- [当前包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：150385字节、23文件、解包441905字节；全部23个payload逐字节匹配工作区。
- SHA256 `d9c6813ae29bc02ec4e5fa952bffaa27cf69e13d586b25beb97c89eb1985ae2f`。
- SHA1 `cff12a47d2d8f93fe3f0f7679926382bf07373b6`。
- 入口语法与git diff --check通过。现有测试全绿没有覆盖以下真实Host接线/并发边界。

## 2. Y1 / P1：实际身份没有贯穿single-flight；OpenCode引用仍未纳入身份

### 2.1 A的在途结果被当成B的数据，并写入B缓存

[结果缓存键](../plans/usage-tool-register.js#L213-L215)包含identity，但[共享任务键](../plans/usage-tool-register.js#L310-L311)只有generation和ids，**不含identity**。

已执行createUsageTool真实编排探针：同一custom id、同一公开配置，identify先返回实际身份A，A取数挂起；轮换到B后同时调用，再放行A。结果：

```text
ROTATION_IN_FLIGHT:
first=91.23, second=91.23, third=91.23
collectCalls=1, cacheSize=2
```

第二次调用确认的是B（应为12.34），却复用A任务；[resolve写缓存](../plans/usage-tool-register.js#L331-L337)又用各自snapshot.identity，把A余额分别写入A和B两个缓存。第三次B查询继续命中错误余额。

仅“不缓存账号型渠道”也不能证明账号型渠道的single-flight安全：若无法证明账号身份，仍不能将不同账户时点的请求盲目共享。

### 2.2 OpenCode模型凭据引用轮换后仍命中旧值

[identifyChannels内置分支](../index.js#L408-L417)只哈希插件配置字段，没有解析OpenCode真正回退使用的source.refs；实际Key只在provider中解析。

真实apply＋真实OpenCode provider，credentials.resolve返回合成Key A→B，虚拟fetch按Key分别返回已用90%和50%：

```text
BUILTIN_REFERENCE_ROTATION:
first remaining=10, second remaining=10
requests=1, resolutions=1
```

B本应剩余50%。第一次之后再也没解析当前引用，身份仍是静态的opencode-go，旧缓存继续有效。这不是两秒配置缓存，而是引用的实际值变化根本未进入缓存身份。

**修复/验收**：
- 缓存和共享任务使用同一套可证明的实际身份；不只是给结果缓存加hash。
- 内置和自定义都按provider真实凭据解析路径判断身份；无法证明身份的来源同时避免跨账户缓存/共享，或使用已核验的会话修订。
- 校验应在返回/回写前执行，不仅在[启动取数前](../index.js#L469-L473)比较公开generation。
- 补引用A/B并发、第三次缓存命中、顺序OpenCode回退引用轮换、账号型在途换账号、取消其中一个共享调用不影响另一有效调用。所有指纹留在Host内部。

## 3. Y2 / P1：D6-E仍只在抽象层成立，真实内置调用没有接好

### 3.1 deadline到期后内置provider仍发Bearer请求

[index内置调用](../index.js#L483-L489)只有withinDeadline(Promise)，没有将deadline/signal交给plan.fetch或其凭据/传输阶段；[util fetchBackend](../plans/util.js#L59-L69)仍创建独立30秒controller。

真实apply＋真实OpenCode provider，凭据解析等待9000ms，虚拟fetch记录发送，不出外网：

```text
BUILTIN_AT_TOOL_RETURN:
elapsedMs=8006, sent=[], result={channels:[],policy:null}
BUILTIN_LATE_REQUESTS:
elapsedMs=9014, hasBearer=true
```

与首次审查的custom迟到发送不同：custom现在有预算传递，但**内置路径仍继续**。已开始且无法取消的宿主依赖可以迟到settle，但不能因此再启动新的凭据请求/HTTP请求、回填或缓存。

### 3.2 快渠道仍被慢渠道抹掉

注册层提供[onChannel](../plans/usage-tool-register.js#L247-L255)，但[index实际collect](../index.js#L478-L513)只向局部results.push，**从未调用info.onChannel**，最后仍await Promise.all。

真实apply探针：DeepSeek立即成功12，MiMo永久挂起。结果：

```text
ACTUAL_APPLY_PARTIAL:
elapsedMs=8003, result={channels:[],policy:null}
```

DeepSeek成功值没有保留；超时后空channels也无法区分“未启用渠道”和“明确查询但未完成”。新单元测试中手动调用onChannel，不等于生产接线已经使用它。

### 3.3 配置/身份阶段取消不及时

[awaitWithinDeadline](../plans/usage-tool-register.js#L158-L170)没有监听deadline.signal；index的withinDeadline同样只等待timer。

注入150ms预算、describe挂起，第5ms abort，实际157ms才返回。生产8秒预算下，配置读取期间的取消可能仍等到整个deadline，而不是尽快停止。已经abort的请求入口零取数条件通过，并不能替代中途取消测试。

**修复/验收**：
- 将更短的工具deadline/signal贯穿实际内置provider的凭据、等待、传输、body与后端回退；Web原有35/40秒等行为保持不变。
- 所有等待阶段响应abort，到期后迟到依赖不再进入下一阶段。卸载期间尚在describe/identify的调用也不得再启动取数。
- 每个真实渠道完成时调用onChannel并记录真实采集时间，不等整批结束再投影/打时间；保留快渠道，只给未完成id返回明确缺失/取消状态。
- 用真实apply→真实provider补负例；不要只测withBudget或自造collect回调。测9秒凭据、5ms中途取消、快/慢混合和卸载中的调用。

## 4. Y3 / P2：systemPrompt段落不随配置独立更新

原“策略没有输出”已修：实际execute.policy.text与render有收尾文本，公开section调用形状也匹配宿主。

但[syncPolicySection](../index.js#L278-L305)仅由[启动微任务](../index.js#L519-L523)和[工具execute](../plans/usage-tool-register.js#L392-L395)调用。没有配置更新订阅或不调用工具时的刷新途径。

真实apply＋记录型公开section桩、volatile配置getter，仅改变quotaPolicyEnabled，**不调用工具**：

```text
false → true: sections 0 → 0
true → false: sections 1 → 1
```

因此用户启用后新指令没有进入，关闭后旧系统规则仍残留，不能称“配置变化重建”已经实现。

**要求**：通过已核验的配置事件、提示词装配时变量/动态context等公开契约同步；不在提示词装配中无界取数、不改宿主、不硬inject。补无工具调用下的开启/关闭/阈值/关注项变化、缺服务与卸载清理。提示文本应明确`policy`非null才表示触发，而不是仅字段存在（当前输出即使不触发也会有policy:null）。

**不计作已证实宿主漏洞**：简化桩中立即dispose后启动微任务仍尝试section注册；真实Cordis有失活Context检查，可能已经拒绝。因此仅建议加alive保护，不将桩中的重注册直接写成真机泄漏。

## 5. Y4 / P2：DeepSeek混币/未知币种钱包仍被相加

[账号路径](../plans/deepseek.js#L128-L148)先忽略currency=null的钱包，给其余币种去重，最后不论单位是否一致都计算normal+bonus。

真实账户provider→工具投影结果：

```text
normal CNY10 + bonus USD2:
 balance=12, currency=null, unit=null, availability=ok
normal CNY10 + bonus 无currency的2:
 balance=12, currency=CNY, unit=currency, availability=ok
```

第一种仍在制造跨币总额；第二种更把未知单位赠金当作CNY，可能进入同币金额策略。给混币结果加currency:null不等于停止错误求和。

**要求**：只对可证明相同单位/币种的钱包求和；未知或异币不能冒充统一余额。可以分币种表达、选定有证据的钱包并说明范围，或将不确定总额置未知；不要对旧UI正常单币行为造成回归。验收CNY+USD、CNY+未知、仅单币、0/负数及金额策略集成，不能只测API单币或两个都明确异币时currency=null。

## 6. 状态与下一步

- D6-A原请求范围通过；C/F/H原主要条件通过；D6-D基本错误缓存/时间字段用例通过。
- D6-B仍有Y1；D6-E仍有Y2；D6-G实际输出已接入但配置生命周期仍有Y3；D6-C币种仍有Y4。
- 继续只修Y1–Y4，保护C主线及已通过整改，完整回归后重新打包再复核。
- 真实DSH工具/提示词冒烟、Android能力、策略UI仍待验证或未实施，本轮没有把这些待办冒充已复现缺陷。

完整提示词见[二次整改提示词](fix-prompt-direction6-round2-v0.9.0.md)。
