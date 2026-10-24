# 当前会话渠道自动识别：源码研究与实施边界

> 2026-10-19，含当日21时恢复研究后的复核。用于补充[构建交接](handoff-quota-policy-build-v0.9.0.md)。
> 本文是源码研究及隔离无网络探针，不是新功能已实现/真机通过的声明。未调用真实账号/凭据API，未读取凭据文件或profile配置，未改产品、宿主或已安装插件。

## 1. 研究结论

**可以自动观察当前Agent本次请求的provider route/model，再匹配额度渠道；但“知道路由”不等于“已证明实际计费账号、同一余额来源和正确额度池”。**应分层实现，不能按模型名、UI当前选择或上一次请求记录猜。

当前公开API支持的可行路径：请求中间件观察→每Agent私有路由记录→同次请求动态context刷新→精确渠道映射→额度来源/身份/池校验→已有Host快照→三阶段渲染。

必须处理一个实际存在的限制：request中间件可以在`await next()`之后继续改路由，`prepend:true`不自动保证观察器永远最外层。当前Codex Connect的task与Reserve就会这样做，不是只存在于未知第三方插件。

## 2. 证据基线

- 实际宿主归档SHA256：`47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`。恢复研究后重新核验；agent、agent-loop、system-prompt、Cordis、scope、llm相关提取与归档逐字节一致。
- 当前安装Codex Connect：0.2.0-alpha.6。研究副本[入口源码](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js)SHA256：`6A302EC223471115365437E1A9C98B52CC3619CC90C272CA9630A778A6A27E29`；另保留[公开声明](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.d.ts)。这次恢复时核验到了captureActiveAccount，不能用更早摘要中的“只有accounts，无冻结接口”覆盖当前源码。
- WorkBuddy Connect：0.7.8。[入口源码](../.diagnostics/routing-audit-20261019/installed/dsh-workbuddy-connect/lib/index.js)SHA256：`04125AB31DBB63776FF873CACDAF644A866970E45076985BB6F166D17AD2FD01`。
- 诊断副本可能不入Git；转移机器或依赖更新时须重新提取/核验，不能假装这些相对链接永远可用。读取宿主归档内源须正确解析归档，不用独立Node直接打开嵌套路径。

## 3. 从哪里读“本次路由”

### 3.1 不是以下位置

- [assembly context](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js#L291-L296)只有`{agent, scope:agent, signal?}`，没有顶层provider/model/account字段。
- [Agent.options](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1174-L1195)只是请求配置seed，可被后续中间件改变。
- UI选择在[installModelSelection](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js#L166-L204)里先按step采样，再写入request；UI此刻刚选的新模型不一定用于已组装step。
- request/header与request/context到[buildRequest](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1214-L1271)才更新，晚于本次context刷新。读它们预测本次请求会晚一拍。

### 3.2 可用的公开观察点

`agent/request` payload有agent、turn、step、signal。外层监听器`await next()`后可读取下游返回的provider/model，然后不改变config地返回。通过`WeakMap<Agent, RouteObservation>`隔离主会话与子代理；同step重试仍再次观察，不只在新turn记录一次。

关键时序为：

```text
preStep：assemble（这里可能尚无本次最终路由）
  → agent/request waterfall（选择、task、Reserve等可改配置）
  → llm.prepareCall
  → refreshContext（读取本次路由观察＋额度，原子生成事实和阶段规则）
  → buildRequest（此时才写header/context）
  → llm/stream与adapter认证/发送
```

当前[LLM normalizeModelInfo](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L2118-L2140)强制adapter返回的provider/model与登记id和输入model一致；[resolve/prepareCall](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L2182-L2247)不会把已经观察到的路由再换成另一provider。因此在**已审查中间件链且观察器确在其外层**时，观察值可以用于同次context。

不要再额外调用resolveCallConfig/resolveModelInfo当“无副作用查询”：它们是异步接口，adapter解析模型元数据可能有IO，且再次解析不能证明与后续请求使用相同认证。

### 3.3 认证与元数据边界

- [listProviders](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L1904-L1909)只公开id/name；[配置目录](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L1911-L1965)虽含settings定位及默认环境变量等元数据，但不是当前实际baseURL、Key或账号。
- pi-ai及DeepSeek adapter会在stream/request阶段才解析认证，晚于提示词刷新。同一路由可能使用不同Key、OAuth账号或上游网关内部的不同计费来源。
- credentials的reference-updated/record-updated可用于失效通知，但通知不是账号证明；只凭引用名也不能证明真正发送的Key相同。
- llm/stream、已持久化request/header可作后验核对；它们太晚，不能倒过来修复本次已经生成的提示词。后验发现不一致，应作废后续观察与绑定并本地记录，不能声称本次已纠正。

## 4. 为什么prepend仍要设计安装时机

[Cordis dispatch/waterfall/register](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/cordis/lib/index.js#L258-L342)按同一事件监听列表执行，prepend是unshift；[scope过滤](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js#L327-L337)不提供“当前scope永远优先/最后”的排序保障。

已完成无网络探针，复用实际EventsService方法、scopeTarget过滤器、installModelSelection函数，仅替代fiber生命周期/反射绑定，不是完整宿主启动：

- 正例：observer在标准选择器外层，observed与最终returned均为selected-route/selected-model；其它scope监听未被调用。
- 负例：后来注册的prepend外层继续改写，observer仍看到selected-route，但最终返回late-outer-route；成功复现漏观察。
- 两例断言最终exit0。首次探针setup曾因拼接注释末尾缺换行导致scope工厂返回undefined，定位后一次复跑通过；不是产品缺陷，也不把首次失败藏掉。
- 随后补测推荐晚装方式，单次运行exit0、三例断言通过：global Codex式writer先注册，created晚装scoped observer能看到openai-codex/gpt-reserve；已有Agent通过list补装且祖先/子scope以精确subject守卫隔离；未来再加outer writer仍会漏观察的负例再次成立。不是完整Codex插件启动或真实模型请求测试。

当前Codex的真实写入器：

- [task legacy](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js#L8284-L8313)及[V2](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js#L9601-L9618)可后置改provider/model/effort。
- [Reserve路由](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js#L12021-L12107)可普通→gpt-reserve、Reserve→ordinary，并可在额度错误后返回retry重跑request链。
- 这些监听在其标准apply注册；是否命中task/启用Reserve依用户配置，本研究没有读取配置，不能声称用户当前已启用。

具体工程选择：不要只在Usage Dock apply早期装一个全局observer。使用公开[agent/created与agents.list](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js#L574-L615)，为新建/已有Agent安装其scope内的prepend观察器，优先晚于已激活连接插件的全局request写入器。其成立条件、热加载后的重装与更晚动态writer必须测试；不能许诺未知后来prepend仍会被包住。对无法保证顺序的链标记未验证，不投放基于旧路由的额度或规则。已知公开重载通知可以触发失效；没有任何通知的任意外层插入无法保证当次被发现，须明确未支持，不能把后验检查写成提前保护。

## 5. 已核实的路由→额度渠道候选表

候选匹配后还要经过身份、来源和额度池校验，不能只做字符串替换就判收尾。

| 注册provider route | 候选Usage Dock渠道 | 必须补的约束 |
| --- | --- | --- |
| openai-codex | codex | 当前连接账号、实际model对应的额度桶；gpt-reserve/额外metered池不可盲套普通codex主桶 |
| workbuddy | workbuddy | 国内版专属池；同一个模型id也不能映射成DeepSeek官方余额；账号来源需佐证 |
| workbuddy-ai | workbuddy-ai | 国际版独立池；不能与国内版合并；临时loopback shim端口不作稳定键 |
| deepseek-account | deepseek，且source=account | 实际DSH账号与余额账号来源一致；API Key回退值不自动替代该源 |
| deepseek-official | deepseek，且source=api | 实际API Key/账户池匹配；不能误用当前胶囊优先返回的account余额 |
| 其它pi-ai/custom route id | 明确绑定的mimo/opencode-go/deepseek或custom:id | 以实际注册id和精确model条件匹配，不看模型名、协议名、默认endpoint猜；Cookie账户与API Key账户尤其不能自动视为同一账户 |

两个DeepSeek固定id分别来自[account adapter](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek-account/lib/index.js)与[API Key adapter](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js)。当前[Usage Dock取数](../plans/deepseek.js#L164-L231)先account后api，故必须保留via/源身份，不能统一成一个不分源的金额缓存。

预置规则只针对已核验的连接契约/版本和实际启用的标准路由。provider id是adapter route key，不是供应商法定身份，也不是账号；安装了某包不等于其adapter已激活。对同名自定义路由/不明注册来源应使用明确绑定，不能读私有registry反射猜来源。

## 6. 账号与额度池：已发现的具体可用能力和不足

### 6.1 Codex：现在有可用的账号冻结接口

当前[公开类型](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.d.ts#L40-L84)包含captureActiveAccount。它返回绑定于一次文档读取的store；其accounts只返回安全摘要，captureActiveAccount再次调用返回同一snapshot。实际[实现](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js#L907-L936)在令牌刷新时只更新已捕获账号，不改变用户当前选择。

可以在**原本就要执行的额度采集**中这样构造来源证明（示意，研究未调用）：

```js
const captured = await store.captureActiveAccount()
const active = (await captured.accounts()).find((entry) => entry.active)
const usage = await sdk.readOpenAICodexRateLimits(captured)
// Host内部记录active.accountKey的私有摘要＋usage，绝不输出账号标签/邮箱/Key。
```

[额度API公开签名](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.d.ts#L565-L586)接受具captureActiveAccount的store，故能复用此冻结store；不可用“accounts前后各读一次相等”替代，因为A→B→A仍可能串源。不得自行调用store.read去拿token，不直接解析账号存储文件。

但要区分：这证明**本次额度采集的账号归属**，不自动把模型adapter稍后捕获的账号也冻结为同一个。请求前如需当前安全摘要，只能在异步request观察/预处理阶段通过公开SDK读取、设预算并脱敏；context回调依然零IO。原生模型认证晚绑定的竞态不能冒称消除；要求与最终模型认证绝对同源需连接插件提供相应证明/协作，不能改核心或偷偷截token。

另外[原生额度API](../.diagnostics/routing-audit-20261019/installed/dsh-codex-connect/lib/index.js#L3761-L3794)返回主/额外额度池，当前[本项目Codex投影](../plans/codex.js#L70-L86)只选id=codex。必须核实model→池后再决定；reserve未知时不沿用普通主桶0%强行收尾，也不擅自扩展为新的额度查询能力。

### 6.2 WorkBuddy：visibility.account不是同次credits来源证明

[visibilityAccountOf](../.diagnostics/routing-audit-20261019/installed/dsh-workbuddy-connect/lib/index.js#L1969-L1984)使用uid/enterpriseId组成原始身份，不应送模型。它有助于内部诊断，但当前[status生成](../.diagnostics/routing-audit-20261019/installed/dsh-workbuddy-connect/lib/index.js#L1259-L1324)先读取authStatus和runtime visibility，随后另一次await store.current才查credits。两者不是一个不可变凭据快照，所以**不能把status.visibility.account随手哈希就宣称这些积分一定属于该账号**。

status读取本身会访问计费上游，不为身份识别再额外打status；只复用原采集。昵称、domain、过期时间也不能作唯一账号键。adapters-updated/catalogGeneration可帮助作废，但前者是通用事件、后者是连接内部字段，不能假装已有公开账号代次服务。

首版可自动区分国内/国际路由；账号池需要明确绑定或可靠安全元数据，缺证据时不能跨账号复用历史积分作规则依据。若需连接端新增“本次credits所用账号的opaque身份”，另行授权连接插件协作，不在本次直接修改依赖包或读取其token文件。

### 6.3 DeepSeek、MiMo、OpenCode及自定义

- DeepSeek：via=account/api必须参加快照身份；来源变化不是“偶发失败可用上一源余额”的理由。UI允许原安全回退，自动策略只使用与当前请求绑定源匹配的观察；不额外查另一份余额来强行凑匹配。
- MiMo：当前额度使用控制台Cookie，模型通常用API Key，二者不具天然同账号证明；须明确绑定并随任一端身份变化作废。
- OpenCode Go：只证明是OpenCode协议/同域名不足以证明Go套餐额度池；Zen/Go及useBalance等语义要区分。
- custom：显式provider/model→custom稳定id绑定；credentialHost/IP/TLS安全约束不变，供应商显示名不能用于匹配。

## 7. 交给执行模型的落地决策

1. 自动识别首先实现“当前请求路由”，不把它整体丢回待确认，也不要求用户每次切换后手选渠道。
2. 关注列表是允许使用的渠道白名单，不是当前路由选择器；自动识别在该范围内只选本次匹配渠道。空列表/关闭不默认为所有渠道。
3. 使用独立的私有RouteObservation和QuotaSourceProof；route-known、pool-bound、source-current分开表达。人工绑定能表达用户指定的归属，不冒充程序验证的账号证明；所需约束无法验证时不启用自动额度规则。
4. 未识别/冲突/来源不符不是供应商采集失败，不累计5次，不发技术错误或假“身份过期”；normal无规则，不拿无关数据补位。
5. 路由级自动选择与精确账号认证是不同能力，交付逐渠道说明哪些已自动、哪些要绑定、哪些仅有候选，不能笼统写“已全自动识别实际计费账号”。
6. 保留正常无规则、T前4缓存/第5失败normal、P立即失败/A过期normal；新识别机制不改变这些已确认规则。

下一步具体模块、伪代码和验收由[交接第6节](handoff-quota-policy-build-v0.9.0.md)执行；本文保留证据与不能越过的能力边界。
