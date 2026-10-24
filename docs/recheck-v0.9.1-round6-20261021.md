# 0.9.1第六轮复核：界面修复通过，来源与预算边界仍未闭环

> 审查对象：[状态入口](status-0.9.1-20261021.md)所列本地包，SHA256 `12807f0bef83f23e5525700cd201598a281da1c55d7f3ee9b11477258d3a69bb`，224152字节/27文件。
> **正常使用主路径有明显改善：独立UI检查86项通过；原生HTTP流/Response验证通过。整体仍有2项P1、2项P2、1项P3边界缺口。**不是把1777项全绿解释成全面验收，也不是说用户当前正常显示的数据都错了。
> 用户最新截图已经显示WorkBuddy ✦5761，且反馈实测未遇问题，**这是实际运行证据**，不能继续笼统说完全无真机证据；但截图不等于源切换/多账号/故障/真实注入重试均验收，也不能仅凭截图绑定运行bundle的包哈希。

自动context反例均显式开启策略，配置合法阈值、关注渠道/绑定及信任开关；默认关闭策略时不会主动生成收尾规则。这里验证的是启用后的正确性，不声称用户当前默认配置已触发错误收尾。

## 1. 本轮已关闭与限定通过

| 范围 | 结果 |
| --- | --- |
| R5-01双卡误写/误删 | 关闭：双/三卡六字段、按id删除、保存重开/放弃/连续编辑均通过，其它条目原输入字段不变 |
| R5-04首项按钮 | 关闭：重复disabled已删除，内置与自定义首尾禁用通过 |
| 全局混排 | 真实SettingsPage卡片DOM、保存重开、胶囊/详情、非默认顺序保留、初次移动不丢id，共27项通过 |
| 自定义卡片新UI | 首次默认折叠、按id展开保持、新增只展开自己、样式字段与内置一致，通过；不代替全部真机视觉验收 |
| B12设置页作用域 | 真实SettingsPage注入非空两个账号，实际执行渲染/复选框/保存/放弃/只读/保存中，20项通过，未白屏 |
| B10/B11网关正文 | 新建隔离回环HTTP夹具，分两段发送正文，使用Node原生fetch/Response/signal，积分42与1条包明细正确，成功后signal未abort，未重复读body |
| R5-02旧投影撤销 | 原A/B/A与工具→GUI→工具的旧B收尾已消失；但当前常变成暂无数据，只是最低撤销控制通过，不代表来源管道整体通过 |
| R5-03身份域钩子 | 现在取Host逐渠道身份的方向已修；端到端已知失败门控仍被下述新指纹问题破坏，不能整体关闭 |

[UI独立摘要](../.diagnostics/review-custom-provider-round6-20261021/ui-summary.md)：27＋39＋20＝**86项通过**。包明细真实流见[原生HTTP日志](../.diagnostics/review-custom-provider-round6-20261021/real-http-probe.log)。临时HTTP夹具是本次自建随机回环端口，已关闭；不是替换DSH GUI或调用用户真实网关，ctx和Key均为合成。

## 2. R6-01 / P1：同一个Key被两种指纹编码当成不同来源，并自废票据

[工具identify](../index.js#L1055)使用**无盐SHA256前16位**；[采样回调](../plans/custom-balance.js#L2425-L2426)调用[credentialFingerprint](../plans/custom-balance.js#L1592-L1595)，使用**带盐SHA256前12位**。两者写入同一sampledCredentials表，所以**同一个真实Key也必然“换源”**，不仅GUI/工具交替，同一次工具identify→collect也可能发生。

新的完整清理确实能撤掉旧projection，但现在误换源会同时撤掉正确的失败封存/当前采集票据：

- **FAIL_SAME_KEY_FINGERPRINT_DOMAINS_RESET_FAILED_STATE**：工具先成功→GUI同Key401，context已获取失败→工具立即同Key调用，identify误换源清掉失败，仍旧ok缓存、**零新HTTP**，context变暂无数据。不是isSourceFailed又少传参数，而是失败记录在查询前已经被别的代码删了。
- **FAIL_COLD_GUI_SELF_INVALIDATES_TICKET**：GUI首次取得1，模型却暂无数据；同Key第二次GUI才正常发布1。原因是[先签票](../index.js#L843-L852)，采样回调再[推进epoch/改变身份](../index.js#L306-L328)，本次合法结果被自己的变更拒绝。
- 原A/B/A工具返回9000/1/9000虽不再旧B收尾，但context持续暂无数据，不能把这种“清到没数据”的状态当完整功能恢复。

[独立编码与来源日志](../.diagnostics/review-custom-provider-round6-20261021/identity-isolation.log#L1)、[真实apply路径日志1–5行](../.diagnostics/review-custom-provider-round6-20261021/host-probes.log#L1-L5)。合成同Key编码长度分别16/12，不依赖猜测真实凭据。

**修复出口：**只有一套基于真正发送值的指纹规范，identify、GUI、collect调用同一函数；同源同Key不能反复清状态。协调采集操作序号、冻结身份与激活epoch，使本次合法首次采样可发布，又拒绝迟到旧操作；不能在完成时随手重签新票。不要再用readAny或放宽身份检查掩盖本问题。

## 3. R6-02 / P1：内置WorkBuddy新来源和账号选择未进入观察身份

[内置身份分支](../index.js#L335-L350)只含开关及plan.fields中显式Key/Cookie。WorkBuddy的Key来自模型配置，不在这些字段；账号选择workbuddyAccounts、模型baseURL/引用、实际Key也没有被纳入其有效源身份。此前给自定义源修过的隔离规则没有同步到新内置网关。

真实apply同一实例已复现：

1. 账号a1剩余1，context正常进入收尾；保存选择b1（合成余额9000）并真实reload，**仍拿a1的1积分收尾**，未撤旧观察。
2. 独立于账号选择，再用新实例先取1，仅更换模型来源主机/引用，reload后仍旧1收尾。
3. 随后从有效模型配置删除此provider，context仍旧1收尾；没有新的HTTP或未知凭据假设。

见[选择变更日志](../.diagnostics/review-custom-provider-round6-20261021/host-probes.log#L7-L8)、[独立主机/删除源日志](../.diagnostics/review-custom-provider-round6-20261021/identity-isolation.log#L2-L3)。这是已知配置切换后用旧源数值，不是要求证明每次网关实际轮转到哪个计费账号。

**修复出口：**WorkBuddy有效来源身份包括真实有效模型来源、已采样凭据身份及规范化账号选择；保存选择、来源消失/更换、凭据轮换都撤销旧projection/meta/计数和在途票据，GUI/工具/context共用。没有新值时暂无数据/normal，不继续旧收尾。不要把账号列表或uid额外泄漏到模型。

## 4. R6-03 / P2：可选积分包明细吃掉8秒工具预算，已知合计被丢掉

[fetchFromGateway](../plans/workbuddy.js#L770-L839)取到有效/status后，还要等/panel/api/packages返回，才构造/交付合计。每个fetch计时12秒，但usage_status的整个公开预算是8秒，明细又是文档定义的“锦上添花”。

对照已复现：明细立即成功时工具返回积分1；仅挂起可选明细，/status已经成功1，约**8010ms**工具返回**channels空列表**，已知积分消失。之后释放明细只是清理测试，不把它当工具当时已成功。

[日志11–12行](../.diagnostics/review-custom-provider-round6-20261021/host-probes.log#L11-L12)。该案例不要求网关完全故障，单纯明细慢于工具剩余预算就能触发。

**修复出口：**从入口到来源解析/凭据/状态正文/明细贯穿同一剩余预算，合计先保底交付，明细超时不抹掉成功合计；取消应传递至仍在进行的操作。不要为明细简单增大工具8秒契约。另来源凭据解析目前在网络计时器之外，应一起纳入deadline；本轮未额外以真实凭据挂起验证，不伪称已复现该分支。

## 5. R6-04 / P2：解析错误把上游正文和合成Key哨兵返回GUI

[辅助函数](../plans/workbuddy.js#L671-L688)保留正文前120字；[错误wire](../plans/workbuddy.js#L813-L819)又把preview和原始JSON.parse错误message直接拼入公开响应。JSON.parse错误本身也可能带正文片段，不能只删preview就认为已脱敏。

**FAIL_GATEWAY_ERROR_EXPOSES_UPSTREAM_SENTINEL**：合成网关的非法JSON正文回显本次合成Key，真实GUI路由返回的wire.message也包含该哨兵。证明上游回显内容可穿过secret不回显边界；**不是声称用户真实Key已经泄露**。模型工具仍做白名单投影，本轮没有把GUI回显夸大成已发现模型工具泄漏。

[日志9行](../.diagnostics/review-custom-provider-round6-20261021/host-probes.log#L9)。应只返回固定解析分类/HTTP状态和安全诊断码，不返回任意上游正文或解析器自带的原文。正常服务返回好JSON时不触发，因此与用户当前正常显示不矛盾。

## 6. R6-05 / P3：status兼容分支未贯穿调用者

helper及listWorkbuddyAccounts已在无ok属性时按status判定；但[fetchFromGateway仍直接if(!response.ok)](../plans/workbuddy.js#L785-L803)，包明细也[只看response.ok](../plans/workbuddy.js#L831-L835)。合成包装Response只有status=200/text时，已解析到合法状态仍返回“网关返回HTTP 200”。

[日志10行](../.diagnostics/review-custom-provider-round6-20261021/host-probes.log#L10)。标准Node/浏览器Response不受此项影响；属于声明过的包装fetch兼容残留，不当作当前DSH环境必然故障。建议辅助函数统一返回normalized status/ok/body，调用者不再混用原始response能力。

## 7. 口径与非缺陷说明

- WorkBuddy空选择[]代表全部，而非零；界面明确提示，取消最后一个会恢复全部。UI及纯投影一致。若用户希望“全不选=0”，需另改契约，本轮不把当前明确设计误报成筛选失效。
- 当前统计排除停用、计入冷却；合计以/status为准，包明细口径差额已在[状态入口](status-0.9.1-20261021.md#L123-L130)说明。是否排除冷却不擅自决定。
- 折叠后删除按钮仍可见；用户之前参考截图也含删除入口，没有明确禁止，因此不列新阻断，不擅自要求执行模型隐藏它。视觉一致的全部真机审美仍交用户确认。
- workbuddy-ai已按更新指示退场，不要求恢复。真实账号池每次计费、窗口口径、策略UI、真实提示词注入与重试、Android真机仍为独立待验范围。

## 8. 包、回归与复现边界

- **49脚本串行：46组1558＋行尾68＋几何144＋契约7＝1777项，exit0、0跳过。**[退出清单](../.diagnostics/review-custom-provider-round6-20261021/regression/summary.json)、[逐组统计](../.diagnostics/review-custom-provider-round6-20261021/regression/counts.json)。
- 包224152字节/27文件，逐payload与工作区一致，mismatch=0，SHA1 `9ba29e11524df09fae5fd717d60dbc3969e061ff`。[包核验](../.diagnostics/review-custom-provider-round6-20261021/package-audit.json)。未将执行方“已重装”当成我方再次核过安装副本或缓存bundle。
- [Host探针](../.diagnostics/review-custom-provider-round6-20261021/host-probes.mjs)、[身份隔离探针](../.diagnostics/review-custom-provider-round6-20261021/identity-isolation.mjs)、[原生HTTP探针](../.diagnostics/review-custom-provider-round6-20261021/real-http-probe.mjs)：真实apply/工具与原生Response，使用合成目录/Key/状态，不访问真实账号服务。Host/身份脚本的exit0包含“缺陷存在”断言，不能作为产品通过。
- UI三脚本及日志见[独立摘要](../.diagnostics/review-custom-provider-round6-20261021/ui-summary.md)，共86项。子代理仅一个并复用，未并行开多个审查者。
- 保留诊断脚本自身修正记录：Host首稿假定超时结果至少有一行，实际空列表引发TypeError，修正空列表处理并补快明细正控制后完整重跑；[首稿日志](../.diagnostics/review-custom-provider-round6-20261021/host-probes-first-run.log)不计产品异常。UI初稿把序列化形状差异当修改，其后逐原字段验证通过，见独立摘要；不能拿探针修正当产品先红后绿。

本轮未改产品、正式测试、已装副本或真实配置；未读取真实凭据、未调用用户网关、未重启/部署/提交/发布。仅新增本轮审计证据及报告。优先修来源身份与采集事务，再处理明细预算和错误脱敏；保留已通过的UI与真实流修复，避免重新推翻已验证路径。
