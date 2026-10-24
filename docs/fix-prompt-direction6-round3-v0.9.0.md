# 执行提示词：方向6第三轮整改，仅修Z1–Z3

```text
继续整改dsh-usage-dock 0.9.0方向6，只修第三轮独立复核Z1–Z3。不重做已通过的Y项，不推进方向4/5，不恢复退场渠道，不顺手扩展UI功能。

工作区：E:\WorkSpace\DSH\DSH Usage Dock

先读AGENTS.md、docs/recheck-direction6-round3-v0.9.0.md、docs/direction6-0.9.0.md、docs/remediation-v0.9.0.md及必要原设计。保护未提交成果，不reset/clean，不修改v0.8.5标签。

当前：1214项回归+7项契约独立复跑全绿，8DFEEBBF…包23个payload与工作区一致。Y4模型安全条件通过，其他Y项原条件多项通过。变异测试能捕获所选回退，但不能代替以下真实调用链补测。

先把下面三个失败场景写成回归，再修实现：

Z1/P1：凭据身份采样与实际发送仍不一致。
identifyChannels解析并哈希引用，实际OpenCode provider又resolve一次。真实apply+真实provider探针：身份采样两次都是合成A，发送时引用变B，随后恢复A。首次输出B的remaining50，却被缓存到A；第二次当前为A（应remaining10），仍remaining50，requests=1，resolutions=5，唯一发送账户B。
要求：缓存/共享任务身份必须绑定真正发送的Key，不能仅记录旁路采样hash。可以固定本次已解析凭据给实际provider，或由取数路径私下返回实际所用身份再验证；无法证明时不缓存/不复用。覆盖内置与custom引用、真实解析优先级和回退，不向模型输出Key/指纹。
补identify A→真正发送B→恢复A的provider集成，检查来源、下一次值/请求次数/缓存；保留原A/B并发、顺序轮换、账号型私有任务及共享取消测试。

Z2/P1：自定义渠道取消与逐条进度没有贯穿。
- 真实apply+custom：第一次identify解析立即成功，实际取数第二次凭据解析100ms，第20ms取消。工具31ms已返回，110ms仍发送Bearer。opts.signal虽被传入，但custom独立budget/request controller未联动外部取消。
- 两条custom：A约6ms成功balance12，B挂起，8004ms工具返回channels:[]。fetchCustomPlans只存结果数组，直到整批返回后index才emit，快值仍被抹掉。
要求：联动custom的外部signal、绝对预算、credentials/DNS/transport/body阶段；取消/到期后迟到依赖不能启动后续请求或回填缓存。为custom增加逐条完成通道，在采集当时写fetchedAt并emit；快结果保留，未完成id有明确状态。保护C主线默认10/20秒、IP固定lookup/TLS与全部安全边界；更短工具预算是附加约束，不改变Web默认。
补真实apply→真实custom的100ms凭据/20ms取消，断言零迟到DNS/请求；A快/B挂起，断言保留A12及采集时间；共享调用之一取消不影响仍有效的另一调用。不要只用手工collect回调测试。

Z3/P2：策略reload事件被两秒配置缓存吞掉。
真实apply+configEditor.configuration()普通override：启动30ms后修改配置并发一次app-boot/config-reload，回调复用liveConfig旧缓存；开启后sections仍0，关闭后仍1；2.27秒后无新事件/无工具调用仍不更新。额外晚事件才恢复。getter测试掩盖此问题。
要求：reload必须invalidate或forceFresh当前配置，确保事件读取真实新值；防并发旧读取覆盖新状态。不能要求用户再发事件、调用工具或重启，不能仅固定等两秒。
补普通override在缓存期内的开/关/阈值/关注项变更，只有一次事件、不调用工具也能更新/移除；保留getter路径、缺服务与卸载alive测试。

注意：Y4模型侧已通过，混币不求和、不参与金额策略的安全行为必须保留。混币UI把unknown叫获取失败是报告中的非阻塞呈现建议，本轮不追加为放行条件，不要求恢复错误求和；若要做UI改进另行列范围。

交付：
1. 三组先失败→后通过，生产接线用真实apply/provider验证，不删或放宽旧断言。
2. 跑全部现有30组回归+WorkBuddy契约及新增用例，准确统计失败和跳过。
3. 更新实施/整改/审查补记，不提前称独立验收通过；保留真实DSH冒烟、Android、策略UI的未验收边界。
4. 重新打本地包，按实际清单逐个核对payload、语法、注册表和新hash；8DFEEBBF…不是本轮修复后产物。
5. 最终逐项报告Z1–Z3修改位置、失败→通过证据、全量结果、未验证项与新包校验值，交回复核。

禁止：改DSH宿主、部署当前profile、自动重启、git commit、创建/修改标签、push、Release、npm publish，及读取/输出真实凭据。真实冒烟若影响运行环境，必须另获用户授权；无授权仍应完成可做的离线整改。
```
