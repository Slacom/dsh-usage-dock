# 执行提示词：只完成Q1剩余F1/F2，不重做已通过项

```text
继续整改dsh-usage-dock 0.9.0方向6。第五轮独立复核确认Q2正常回退、Q3停用零解析、共用resolveApiKey四态通过；Q1剩余两个P1：custom冻结链路未接通，MiMo忽略冻结none。只修F1/F2及直接关联测试，不推进新功能。

工作区：E:\WorkSpace\DSH\DSH Usage Dock
先读AGENTS.md、docs/recheck-direction6-round5-v0.9.0.md、docs/direction6-0.9.0.md及必要原整改记录。保护未提交成果，不reset/clean，不动v0.8.5标签。

当前E56F9DE0…包与工作区23个payload相同，但下述反例已实际失败。先补失败用例，再修生产接线。

F1/P1 custom冻结协议有两个独立断点，必须都修：
1. identify返回snapshot:{frozen,custom}，register只取snapshot.frozen，丢了custom；collector把只含内置的map传给custom。真实apply→真实custom引用：identify=A、取数又resolve变B、随后恢复A，first/second都50，resolves3/requests1，唯一发B；A本应10，B结果仍污染A缓存。
2. 就算手工正确传入custom冻结explicit A，当前customKeys=B，真实fetchCustomPlans仍发B并返回50。provider先用savedKey，只有key为空且有ref才进入冻结分支，纯显式条目不读冻结值。只补map转发仍会失败。
要求：统一或正确桥接逐id冻结map；custom在选择已保存凭据时完整遵守explicit/ref/none/未采样状态，explicit/ref只用冻结值，none直接缺凭据，只有未采样才走当前cfg/实时解析。保留credentialHost/origin和DNS/IP/TLS约束，绝不能用pendingKey冒充冻结的已保存Key绕过目标确认。
验收：真实apply的custom引用A→B→A；直接provider显式冻结A而当前B；纯显式无ref；none而当前有Key；未采样仍正常；实际发送、结果、resolve次数、缓存及目标未确认零请求都断言。

F2/P1 MiMo只识别explicit，其余状态回cfg，none形同未采样：
直接真实mimo.fetch(cfg带后来Cookie B, frozenCredential={kind:'none'})仍requests1/sent B/balance17.55。真实apply已复现缓存污染：最初无Cookie，identify冻结none；同批custom慢引用2100ms时cfg变Cookie B；collect用B取到17.55并写入none身份。清空Cookie+单次reload后再查相同ids，仍17.55且fetchedAt不变，只有一次MiMo请求B。
要求：有冻结描述时严格遵守；none直接no-key零请求；explicit只读其冻结字段，缺失/无效不回实时cfg；只有null/undefined（未采样）才读cfg。MiMo无ref来源，不支持状态安全拒绝即可，不把人工ref另列生产缺陷。
验收：真实provider状态矩阵；真实apply的none→后来Cookie B→清空→再次查询，确认没有把B成功缓存进无凭据身份。正常显式Cookie与Web路径不变。

测试质量关联修正：
- 当前Q1a配了SLOW_REF但execute只请求opencode-go，所以慢ref根本不会进入；reads从1初始化，reads>=2也不能证明重读。补真正进入等待gate的断言，记录采样A/collector读B，明确请求需要的辅助渠道；不靠自增初始计数证明时序。
- 本轮全量首跑1281回归中旧test-recheck-fixes的V3c失败1项，另7契约通过；随后独立复跑该25项脚本全通过。V3c要求createBudget(1).expired立即为false，依赖1ms墙钟/调度。将其改为可控时钟或确定性断言，不放宽产品预算、不删除15ms迟到DNS零发送等安全断言。不要把首跑写成一次全绿，也不要仅因此宣称产品预算回退。

交付：
1. F1/F2逐条先失败→后通过；必须验真实apply→注册中间层→collector→真实provider，不只测公共helper或OpenCode。
2. 保留Q2/Q3、Z2取消/逐条结果、Z3配置reload、Z4混币UI全部已通过条件，保护C主线secret路径/保存事务、配置摘要/customKeyRev、实际Key gen、IP固定lookup/TLS、预算、失败回退和Web35/40秒兼容。
3. 跑现有33组回归+WorkBuddy契约及新增用例，准确记录失败/复跑/跳过。更新实施/整改补记，但独立复核前不写已验收；真实DSH冒烟、Android和策略UI仍照实标注边界。
4. 重新打本地包，核对payload、语法、注册表与新hash；当前E56F9DE0…不是修复后产物。最终给出修改位置、负例、完整回归、新包路径/hash与未验证项，交回复核。

禁止：改DSH宿主、部署当前profile、自动重启、git commit、创建/修改标签、push、Release、npm publish、读取或打印真实凭据。真机冒烟另获授权，无授权仍完成离线整改。
```
