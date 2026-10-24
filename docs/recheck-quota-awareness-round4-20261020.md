# 额度感知第四轮复核：上轮原案例通过，整体仍需整改

> 2026-10-20。审查包SHA256：`678110f0f4c99839ba4d663d3643f3a1c2cb85e54896852a207d4f593a9f7589`。
> 对照：[第三轮报告](recheck-quota-awareness-round3-20261020.md)、[冻结交接要求](handoff-quota-policy-build-v0.9.0.md)。
> **上轮四组P1及两个关联身份原案例均已通过本轮定向复核。**不是原来四组又原样失败。本轮交叉验证另确认3组待改问题（1组P1、2组P2），因此暂不给整体通过/部署结论。另有一项防御性建议，不计入阻断统计。
> 只做审核、合成测试与记录；未修改产品/既有测试/宿主/profile，未部署、重启、提交或发布，未调用子代理。

## 1. 包、回归与证据范围

- 包182950字节、27个文件，与当前源码逐payload比较**mismatch=0**；SHA1 `5ba77da5a974dbd340189ecb579d7aa9188c5421`。[包核验](../.diagnostics/review-quota-round4-20261020/package-audit.json)。
- 实跑41脚本：**38个普通Node组1358项＋行尾60＋几何144＋WorkBuddy契约7＝1569项**，全部exit0、0跳过。[执行清单](../.diagnostics/review-quota-round4-20261020/regression/summary.json)、[分组计数](../.diagnostics/review-quota-round4-20261020/regression/counts.json)。
- [独立探针](../.diagnostics/review-quota-round4-20261020/host-probes.mjs)真实运行当前apply、注册工具、配置reload与context，客户端用现有mock React加载真实源码；[结果日志](../.diagnostics/review-quota-round4-20261020/host-probes.log)包含正例和缺陷复现。
- 全部定向依赖为合成provider/DNS/HTTPS/凭据，本轮**没有补任何全局hash或投影名字**，没有改生产源码来运行用例。
- 日志中FAIL断言“缺陷仍存在”，exit0表示复现成立，并非验收通过。修复后需转成正确期望，不能机械依据该脚本exit码。

## 2. 上轮各项实际修复情况

| 上轮项 | 本轮定向证据 | 结论 |
| --- | --- | --- |
| R3-01 hash作用域/空身份 | 同一实例取得MiMo数据，换Cookie后旧额度立即消失，无全局名字补丁 | 原问题通过 |
| R3-01关联：custom Key/修订 | 同一custom成功后，换Key并加本条rev，旧2CNY消失 | 原问题通过 |
| R3-01关联：A旧结果破坏B | A请求挂起→换B并取得95→释放A，context保留B的95 | 原问题通过 |
| R3-02 工具晚签 | 旧工具挂起→新GUI9000→释放工具1，context仍9000 | 原问题通过 |
| R3-03 本地旧值覆盖Host | WorkBuddy本地见1→工具321→GUI暂败，真实客户端显示321 | 原问题通过 |
| R3-03 Codex冷窗口 | 工具缓存33→冷GUI暂败，真实客户端显示33%，不再获取失败 | 原问题通过 |
| R3-04 重复custom查询 | 混合内置＋custom、策略关闭，真实custom传输桩调用1次，返回1行 | 原问题通过 |

这些是本地代码及模拟链路的通过，不等于真实账号已证明或真实宿主已验证。下面的回切身份、默认已用模式与无成功基线属于此前未覆盖的交叉分支。

## 3. 本轮确定待改项

### R4-01 / P1：切出再切回，已作废的在途结果仍能复活

**用户可见：**停用后重新启用渠道，原本已经作废的旧查询还能回来，重新拿旧低余额要求模型收尾；换Cookie A→B→A也一样。

位置：[身份由配置值确定](../index.js#L229-L277)、[发布只比身份值相等](../index.js#L324-L332)、[失效删除记录](../index.js#L453-L463)、[票据只有identity/seq](../plans/quota-observer.js#L148-L158)。

本轮两条真实apply复现：

1. **FAIL_IDENTITY_ABA_REACTIVATES_OLD_RESULT**：已有A的95；A下启动旧请求并挂起→切B、再切回A，尚未发起新的A采集→释放旧A的1CNY，旧结果重新进入closing，且被标“本次采集”。
2. **FAIL_DISABLE_ENABLE_REACTIVATES_OLD_RESULT**：已有95；挂起旧查询→mimoEnabled=false→true→释放旧1CNY，同样恢复closing。

原因是配置值恢复后哈希也恢复；旧ticket.identity又等于当前哈希。失效时删除了旧记录，旧ticket在自己的槽位也没有更大的commitSeq拦截。**身份哈希相等不代表是同一次有效激活。**这是生命周期/作废代次问题，不是在增加数据TTL或要求“样本必须几秒内”。

这仍是[原I/C约束](handoff-quota-policy-build-v0.9.0.md#L115-L116)：切换立即作废旧观察与在途响应；不是临时新增产品要求。仅A→B且B不回切的场景已修，但不足以证明作废完整。

**修复出口：**每条渠道维护不随配置值回退的激活/失效epoch，票据捕获该epoch；配置身份变化、停用/删除时推进，旧epoch永不重新提交。开始时和发布时都验证当前代次，且没有成功记录、只有pending时也须有效。保持未改动渠道不受影响；不能用全局reload清空全部来替代逐条机制。

### R4-02 / P2：OpenCode的默认已用口径没有参与缓存换算

**用户可见：**原本已用80%，暂时失败转缓存后，胶囊却显示已用20%；模型的“剩余20%”是对的，错在GUI换算。

位置：[适配器只认显式used](../client.js#L62-L71)、[OpenCode表项没有显式percentMode](../client.js#L103-L105)、[planMeta不补默认值](../client.js#L135-L139)。原GUI其它逻辑以非remaining作为已用模式，但新适配器只认===used，默认语义不一致。

**FAIL_USED_MODE_DEFAULT_REVERSED：**真实OpenCode投影把原生已用80换成Host剩余20；GUI失败响应有windows.percent=20/remaining；加载真实客户端得到`OpenCode Go20%`，而原生GUI在该渠道期待已用80%。Codex剩余模式冷启动用例已经通过，不能代表另一种默认模式也正确。

**修复出口：**统一百分比模式默认值/规范化，或给所有已接入配额渠道明确模式。缓存适配、颜色、详情与原生wire都使用同一规范。不要为让测试通过擅自把整个OpenCode UI改成剩余口径；两端单位与原习惯须一致。

### R4-03 / P2：没有成功缓存时，第1次T就提前发送获取失败

**用户可见：**刚启动或刚换身份，还没有成功值，偶发一次暂时错误就告诉模型“获取额度失败”，没有等连续5次。

位置：[T分支只把usable归cached，其余都failed](../plans/quota-observer.js#L232-L255)。failCount确实按1～5累计，但状态在第1次已经failed。不要把计数正确当作提示时机正确。

**FAIL_NO_BASELINE_FAILURE_BEFORE_FIVE：**同一新实例连续5次合成exec/transient:true；日志显示failCount=1、2、3、4时，自动context都已输出“获取额度失败”。

[冻结交接§4.2](handoff-quota-policy-build-v0.9.0.md#L131-L138)明确写过：第1～4次无缓存，不编造额度、**不提前报告获取失败**，阶段normal。该分支前几轮未被覆盖，不是本轮改变验收。与已经修好的“有缓存第5次必须固定失败”不矛盾。

**修复出口：**对未封存的T区分“无基线且未满5次”的pending/no-data状态，与最终failed分开；前4次自动提示只可暂无/不投放，不能冒充失败或成功额度。P/A立即失效不受此宽限影响，sealed之后T继续保持确定状态。主动usage_status的只读错误契约不应被一并粗暴隐藏。

现有[身份测试](../tools/test-quota-round3.mjs#L116-L126)用“新身份首错=failed”来判断没沿用旧缓存，恰好把这个错误状态当成期望。应直接断言旧数值不存在，再独立验证正确的pending/normal/不提前失败，而不是靠failed证明隔离。

## 4. 非阻断的防御性建议：C输出应当真正无操作

**DEFENSIVE_C_RESULT_ERASES_SOURCE：**按已支持的C错误码构造provider返回`error:cancelled`，此前API源1CNY有效。observer返回旧成功record，发布器将它再次当ok处理，把source换成取消wire中缺失的via；API context因此从1CNY变为空，尽管failCount仍为0。

本轮**没有证明当前内置网络adapter的真实abort会返回该wire码**：工具预算/信号取消可能在上层就丢弃，不进入发布器。因此此项只作协议防御建议，**不计入上述三组阻断统计，也不声称用户一点击取消就必然触发**。

若接受C wire进入发布器，就应直接不提交、不更新任何投影/元信息；不能把旧record返回给通用发布逻辑当“新成功”再发。最好用有效快照前后完全相等来验证，不只检查失败次数未加。

## 5. 建议一次补齐的有限状态矩阵

为避免继续只补单条日志，下一轮按已有规则验证以下分支。这不是新增产品范围：

| 场景 | 应验证的最终行为 |
| --- | --- |
| 同身份GUI→GUI、工具→GUI、GUI→工具乱序 | 已提交的新样本不被旧票据覆盖 |
| A→B，旧A返回 | 保留B有效快照 |
| A→B→A，或启用→停用→启用，旧票据返回 | 旧激活epoch始终无效；必须等本次激活的新数据 |
| 没有成功基线，T1～T4 | 无伪造数字、无提前固定失败、normal |
| 没有成功基线，T5 | 固定获取失败、normal |
| 有成功基线，T1～T4/T5 | 前4缓存且原采样时间不变；第5移除数值并固定失败 |
| P/A→T、P/A→C | 不复活旧成功、不清计数、不降回暂不提示 |
| C（如该协议入口受支持） | 有效快照/来源/阶段/计数均不变 |
| custom Key/本条rev变化 | 只作废本条；未改条保留基线与计数 |
| mixed/only-custom | 每条实际传输一次、有效提交一次 |
| WorkBuddy暖窗口 | Host当前321优先于本地旧1 |
| Codex剩余33缓存、OpenCode已用80缓存 | GUI分别33%、80%；模型分别剩余33%、20% |
| 身份无法证明/null | 不写入共享空槽位、不沿用无法证明的数据 |

这些断言应跑真实apply和真实客户端；不要以测试自己计算hash、自己做100-x、仅断言HTTP有字段，代替被测实现。保留本轮已经确认的有效整改，别为修新边界回滚它们。

## 6. 后续与证据

```powershell
# 只适用于当前待审版本；FAIL用例目前断言缺陷存在
node .diagnostics/review-quota-round4-20261020/host-probes.mjs
node .diagnostics/review-quota-round4-20261020/audit-package.mjs
```

本报告绑定678110…包。后续修复应使用新证据目录及新hash，不覆盖本轮结果。后台job `pwsh-4344c76bb2a64f29`已收集、exit0，无在途作业；没有新建或复用子代理。

仍须另行完成/确认：真实账号和额度池证明、窗口业务口径、策略设置UI、真实宿主注入与重试验证。本轮不以这些已声明限制推翻局部通过，但也不把局部通过写成整版已验收或允许发布。**先补上述三组确定问题，再复核；本轮不部署。**
