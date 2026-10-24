# 执行提示词：方向6二次整改，仅修Y1–Y4

```text
继续整改dsh-usage-dock 0.9.0方向6，仅处理二次独立复核Y1–Y4，不重做已经通过的D6整改，不推进方向4/5，不恢复退场渠道。

工作区：E:\WorkSpace\DSH\DSH Usage Dock

先完整阅读AGENTS.md、docs/recheck-direction6-v0.9.0.md、docs/direction6-0.9.0.md、docs/remediation-v0.9.0.md和原计划。保护全部未提交成果，不reset/clean；不修改v0.8.5标签。

现状：独立运行1172项回归+7项契约全绿，D9C6813A…包的23个payload与工作区一致。原单条查询范围、OpenCode/WorkBuddy正常投影、单币USD、时间哨兵、显式阈值与策略实际输出等已通过。但补测仍有四组问题，不能据此称方向6已验收。

先将以下负例写成失败测试，再修实现：

Y1/P1：实际凭据身份没有贯穿缓存和single-flight。
1. result cache key有identity，但task key只有generation+ids。同公开配置、同custom id，A身份任务挂起；引用换成B后并发查询；放行A，两个调用和随后第三次B查询全返回A91.23（B应12.34），collect仅1次、cacheSize2。A结果被用B的identity写进B缓存。
2. 真实apply+真实OpenCode provider，插件未填Key、通过source.refs回退。credentials.resolve值A→B，B应剩余50，实际仍剩余10，requests=1/resolutions=1。identify内置分支只看配置字段，没有读取provider真正使用的回退引用。
修复：缓存/共享任务使用相同的可信身份，返回/写入前验证；内置与custom都对齐真实解析路径。无法证明账户身份时不仅不缓存，也不能跨账户共享在途任务。补A/B并发与第三次缓存、顺序内置回退引用轮换、账号型在途变化、共享调用之一取消不影响另一有效调用；所有指纹留在Host内部。

Y2/P1：预算/取消与逐渠道回传仍未接入真实内置路径。
- 真实apply+OpenCode，凭据9000ms才解析，工具8006ms返回空channels，9014ms仍发Bearer请求。index只race plan.fetch，没有传deadline/signal到provider凭据/HTTP/body/后端回退。
- 真实apply，DeepSeek立即成功12、MiMo挂起，8003ms返回channels:[]。注册层有onChannel，但index collect从没调用它，只向局部results.push再Promise.all。
- describe挂起，预算150ms，第5ms abort，157ms才返回；awaitWithinDeadline/withinDeadline没有监听abort。测试入口已abort为零取数不能证明中途取消正确。
修复：工具入口绝对deadline贯穿真实内置与custom的后续阶段；所有等待响应取消，依赖迟到后不得启动新请求或回填。每个真实渠道完成即回传并记采集时间，保留快渠道，未完成id给明确状态，不用空channels冒充没有渠道。卸载中仍在describe/identify的调用也不能稍后再取数。
无法物理中止的宿主依赖允许自行settle，但不能让后续网络/缓存步骤继续。可为provider/共用HTTP增可选工具预算参数，绝不可改变Web原有35/40秒等行为。所有验收走真实apply→真实provider，而不只手动模拟collect/onChannel。

Y3/P2：策略段落没有独立配置生命周期。
section只在startup与工具execute同步。无工具调用，仅改volatile配置getter：false→true时sections0→0，true→false时1→1；开启不生效，关闭仍留旧系统规则。
修复：使用核验过的配置事件或装配时变量/动态context等公开契约，支持不调用工具的开启/关闭/阈值/关注项变更，卸载清理。不要改宿主，不在提示词装配中无界取数。文本应写明policy非null且有有效text才算触发，不能仅说“有policy字段”。
简化桩里的卸载后startup尝试重注册未证实是真宿主泄漏，Cordis有失活检查；可以补alive保护，但不要将其作为已确认真机漏洞夸大。

Y4/P2：DeepSeek混币和未知单位仍加总。
真实账号provider：CNY10+USD2→balance12/currencynull；CNY10+无currency赠金2→balance12/currencyCNY/unitcurrency/availabilityok。后者会进入CNY金额策略。
修复：仅可证同币种/单位求和；异币/未知不能归入统一余额。可按币种表达、选证据充分的钱包并说明范围，或不确定总额置未知；不能只给错误总额加currency:null。覆盖CNY+USD、CNY+未知、单币、0/负数与策略集成，不回退旧UI正常单币行为。

交付要求：
- 逐项先失败→后通过，保留所有旧断言；尤其生产接线必须由真实apply集成验证。
- 保护已通过C主线的secret路径/保存事务、配置摘要/customKeyRev、实际Key gen、连接IP绑定/TLS、绝对预算、强刷和按渠道失败回退。
- 跑全部现有29组回归、WorkBuddy契约与新用例，准确统计失败/跳过；需要时独立重定向日志，不将采集层竞争混同产品故障。
- 更新实施/整改/审查补记，不提前声称独立验收通过；真宿主冒烟、Android、策略UI的未验证/未实施状态保持真实。
- 重新打本地包并逐个核对payload、语法和新hash，D9C6813A…不是本轮修复后包。最终给出修改位置、负例结果、回归、未验证项与产物，交回复核。

硬性禁止：修改DSH宿主、部署当前profile、自动重启、git commit、创建/修改标签、push、Release、npm publish。若真机冒烟需要影响运行环境，必须另行取得用户授权，不以缺真机权限阻止可完成的离线整改。
```
