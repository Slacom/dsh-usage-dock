# 0.9.0 本地构建独立审查

> 2026-10-18。审批对象为工作区未提交的 0.9.0 C0–C5 实现；未修改运行时代码、未部署、未重启、未发布。
> **结论：不批准作为可验收完成的 0.9.0。**已有主功能与回归可保留，但下列可复现问题须修复；方向6尚无工具注册，不能视为整体版本完成。
>
> **（2026-10-18 第二次独立复核）仍未通过**：现有21组732项及另7项契约均通过，但新增探针发现R1/R3/R5尚有缺口及HTTPS新路径两项问题，见[整改复核报告](recheck-v0.9.0-remediation.md)。以下“已修复”是整改者提交说明，不代表独立验收通过。
>
> **（2026-10-18 整改者提交补记）**：R1–R7 与「DNS 未绑定连接」安全偏差均已修复，逐项证据见
> [审查整改记录](remediation-v0.9.0.md)。整改后 21 组 732 项通过（新增 3 组 94 项），
> 并重新打包（旧 `87a566…` 包作废）。方向 6 按用户本轮指示**不在整改范围**，仍未实施。

## 1. 已验证的积极结果

- 复跑 19 组，共 **644 项检查/断言通过**（其中峰谷条是144条真实Chromium几何断言），无测试跳过；新增六组281项通过。执行者回复及 AGENTS 中639/632统计与此不一致，后续应统一为实际日志口径。
- 行尾/git子进程和Chromium夹具首跑被沙箱拦截；扩大权限重跑相同命令后通过。行尾测试中的新文件不在HEAD消息不导致用例失败。
- 退场的三个id确实退出活动注册表；其余内置与自定义的正常路径、基本语义/暂时错误显示有覆盖。
- [本地包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：103990字节、20个文件、解包总303403字节。SHA256 `87a56672bc1fb4e7c10e6b491df54ec8b07671b62454433ba1832643c70ce29c`；SHA1 `ead931fd4e83ac7ea2930815d4486a5b23830414`。逐文件读取归档payload与工作区比较，20个文件均一致。包一致不代表下列实现正确。
- 所有补充探针均使用模拟Key、注入transport/DNS或mock React，无真实凭据、无实际外部账户操作。

## 2. 阻止放行的发现

### R1 / P1：整批预算未覆盖凭据解析和DNS，可能拖住全部渠道

位置：[前置await](../plans/custom-balance.js#L765-L808)、[worker预算](../plans/custom-balance.js#L886-L914)、[Host整体合并](../index.js#L173-L177)。

`timeoutMs`只在`requestJson`开始后生效，而`credentials.resolve`和`verifyPublicTarget`均在之前直接await；worker也没有race整条任务。DNS/凭据挂起时20s预算无效，Host的Promise.all不返回，最终客户端40s整体失败，其他渠道也被连带灰化。

复现：注入`budgetMs=15`、`timeoutMs=10`，DNS等待80ms再返回公网IP，transport立即成功；实际约98ms后仍返回成功余额12，明显突破15ms总预算。永久不settle的前置依赖会无限等待。现有F10/S8仅模拟transport挂起，未覆盖这些阶段。

修复：使用贯穿排队、凭据、DNS、连接和body的绝对deadline；每条/整批race并作废过期任务，在DNS/凭据迟到后不得再发请求。测试覆盖每个阶段挂起、迟到及内置成功数据仍返回。

### R2 / P1：模型凭据引用实际换Key不换代次，旧账户余额可沿用

位置：[代次计算](../plans/custom-balance.js#L474-L490)、[收集时先定gen](../plans/custom-balance.js#L512-L529)、[之后才resolve引用](../plans/custom-balance.js#L745-L782)。

gen只纳入显式`customKeys`的Key，引用实际解析到的新Key不参与。引用名不变但凭据从A换B时，两次wire gen相同；B发生500时，客户端把A余额当B当前数据灰化保留。

复现：同一`TEST_KEY`引用依次解析`key-account-A`/`key-account-B`，两次gen均为`42bf98088e`；B返回`server/transient:true`。这不是合法的同账户暂时回退。

修复：以实际使用的凭据身份/代次生成不泄密generation，并处理引用清空、轮换、解析失败与策略缓存。不能暴露明文或可逆凭据；失败时无法证明同一账户就不保留旧成功余额。

### R3 / P1：配置变化没有即时作废旧响应/显示，仅收到不同gen才清理

位置：[generationChanged](../client.js#L953-L971)、[effect依赖](../client.js#L934)、[custom显示过滤](../client.js#L1188-L1195)。

客户端观察的是wire里“最近看到的gen”，不是当前已保存配置身份；自定义显示过滤也只看旧wire的`enabled`。配置保存改变URL/币种/停用/删除不会使本轮请求失效，迟到旧响应仍被接受。

复现A：配置里的customBalances删为空，但不返回新Host响应，旧`Review $91.23`仍显示。
复现B：请求挂起期间把URL从a改b、USD改CNY，然后释放旧响应，仍显示`A $765.43`。探针通过真实Badge和form快照运行。

修复：订阅已保存custom配置及密钥变更通知/可信身份摘要，变更时作废旧请求和旧值；显示层按当前活动id与身份过滤。明确无configEditor时的生效边界，不能宣称即时生效却接受旧响应。补真实配置变化时序测试，不仅手工换wire.gen。

### R4 / P1：整体失败8次剥掉custom身份后，删除条目仍残留

位置：[整体失败转纯错误](../client.js#L1029-L1059)、[custom分支识别](../client.js#L220-L222)。

第8次整体请求失败构造rpc错误时，主动丢掉custom/gen/currency。后续成功响应不含该条时，它不再满足isCustomPlan，于是走普通carry并永久保留旧错误行。

复现：成功显示自定义余额 → 整体网络失败8次 → 删除该记录 → 成功返回plans:[]，仍显示`custom:review123456 获取失败`，错误名称也退化成id。现有测试只覆盖单渠道错误和正常态删除，没覆盖组合。

修复：纯错误条目剥余额等数据，但保留安全类型/id/name/代次元数据；根据权威custom列表清理全部残留、计数和gen记录。测试整体失败到阈值后删除/停用/再添加以及与内置渠道并存。

### R5 / P1：显式已保存Key不受目标确认约束

位置：[配置带确认字段](../plans/custom-balance.js#L523-L525)、[只有引用分支检查主机](../plans/custom-balance.js#L745-L755)、[UI清确认](../client.js#L2215-L2220)。

改URL会清`credentialHost/urlHostConfirmed`，但Host仅在Key为空、使用引用时才检查主机；显式已保存Key直接发送到新URL，`urlHostConfirmed`在Host未被使用。与详细设计“改URL主机须重新确认凭据绑定”不符。

复现：entry带已保存`synthetic-existing-key`、新主机`new-target.example`、两个确认字段空；注入公网DNS后transport仍收到Bearer Key，并返回成功。原始Key不回显并不等于不能被转发到错误目标。

修复：显式Key与引用统一执行可信目标绑定/变更确认，涵盖真正的目标origin及默认端口规范化；未确认零请求，不因Key存在跳过。新建记录的显式输入与已保存Key继续发送的UX可以不同，但Host边界必须明确且可测。

### R6 / P2：拒绝保存Key前，元数据已先写入

位置：[save先set再检查mutate](../client.js#L2689-L2701)。

`jobs.push(api.set(...))`立即发起写入，不是惰性任务。旧宿主无mutate时，随后提示“已取消保存”，但元数据可能已落盘。元数据与Key分开并发写还需考虑失败后的半保存状态，不能声称整页原子提交。

复现：无mutate的form同时修改名称并输入新Key；保存返回提示取消，但writes含`customBalances`且已保存名称从Before变After。

修复：所有能力/字段校验先于任何写操作；支持时把元数据与secret路径变更合并成同一次mutate，按实际宿主revision/返回约定处理拒绝；若只能分步，应明确部分成功并恢复/重试，不能丢草稿或声称全部取消。

### R7 / P2：volatile解包只覆盖开关，已填的内置Key仍可能被忽略（既有兼容性缺口）

位置：[cfgValue](../index.js#L69-L79)、[仍传原配置给内置fetch](../index.js#L173-L175)、[凭据只认字符串](../plans/util.js#L342-L348)。

无configEditor时实际Config解析出的Key也是`{get()}`。当前只在全局/渠道开关读取时解包，没有在传给各plan前统一解包；例如DeepSeek显式Key被当作非字符串，转而找不到模型凭据，返回no-key。它可能早于本次改动已存在，不能标为新引入回归，但当前兼容性与cfgValue修复声明仍不完整。

复现：使用真实`Config({...deepseekEnabled:true, deepseekApiKey:'sk-synthetic-test'})`解析，ctx无configEditor/账号/凭据服务，注入合法余额响应；实际fetch调用0次，返回“未配置DeepSeek API Key”。

修复：统一形成各provider可用的解包配置（包括Key、Cookie、阈值等），不把包装对象当可用原始值；补真实Config→apply路由测试，而不是仅给普通对象或仅断言包装存在。

## 3. 安全偏差与真实宿主验收

- [DNS防护](../plans/custom-balance.js#L399-L448)先独立lookup并缓存60s，真正fetch另做解析，未绑定已验证IP。DNS重绑定是已知残余风险，不能以“best-effort”替代原设计的连接目标约束；[设计](custom-balance-v0.9.0.md)要求无法保证时采用受控核验目标等保守路线。后续执行者需落实连接期校验/可靠安全出网能力，或收窄目标与凭据发送；不批准“任意HTTPS域名安全可用”的结论。
- settings secret剥除与mutate只有源码/桩证明，仍需真实宿主最小写入/读取/清除/卸载验证，确认一条Key修改不会丢另一条。未经许可不改主profile或自动重启。
- OpenRouter真实响应/Key权限未验证，不据此阻塞通用JSON能力，但不能对外声称厂商已验证兼容。
- 自定义低余额告警和跨内置排序未实现，属于另需产品决定，不列为当前缺陷；不应借此挡住方向6的只读工具建设。

## 4. 方向6审批状态

[index.js](../index.js)只注册用量与custom-status两个路由，[注册表](../plans/index.js#L35-L43)也明示模型工具未实现。没有usage_status注册、模型输出schema、工具缓存或政策层。因此C主线正常路径可保留，但不能把0.9.0整体宣告完成。

用户最新要求方向6为本版重要内容。后续提示词应明确：先修R1–R7及安全边界，再实现可真实调用的只读usage_status、统一投影/脱敏/工具短缓存/卸载与可选收尾政策；不因未选示例阈值而交付零工具。真实宿主验证权限不足要准确报告阻塞，不能用文档或mock全绿代替。

## 5. 审查边界

两个并行复核任务在主审查完成后被停止，未返回报告，本结论未引用它们的独立验证。所有R项来自主会话读取与实际补充探针。

本审查未直接修复代码，原包仍对应被审查的缺陷版本。整改后必须重跑新增负例与既有套件、重新打包并更新checksum，旧包不得继续标为修复后可试装版。保持不提交、不打标签、不推送、不发布、不自动重启限制。
