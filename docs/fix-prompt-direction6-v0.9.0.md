# 执行提示词：方向6首次审查整改D6-A～D6-H

复制以下正文给执行模型：

```text
继续整改dsh-usage-dock的0.9.0方向6。本轮仅修首次独立审核D6-A～D6-H及必要的provider标准字段，不推进方向4/5，不恢复退场渠道，不改DSH宿主。

工作区：E:\WorkSpace\DSH\DSH Usage Dock

先完整阅读：
AGENTS.md
 docs/review-direction6-v0.9.0.md
 docs/direction6-0.9.0.md
 docs/recheck-v0.9.0-round5.md
 docs/remediation-v0.9.0.md
 docs/build-plan-v0.9.0.md
 docs/handoff-v0.9.0.md

当前方向6框架已搭建，现有1062项回归及另7项契约全绿，但独立探针发现8组问题，尚未通过。F03328…包与工作区一致、包含这些问题；不能把第五轮C主线通过延伸为方向6通过。先将以下时序/真实wire写成失败用例，再修实现，不放宽或删除既有断言。

D6-A/P1 请求范围：index调用fetchCustomPlans传整份cfg，取完所有custom才按ids过滤。已实际观测只查A也resolve B并向B携Bearer发请求（隔离HTTPS桩，无外网）。必须在任何凭据解析/DNS/请求之前筛选，未请求/停用/删除/退场/空集合均零副作用。

D6-B/P1 缓存身份：describe只用自定义配置摘要，未覆盖内置Key、内置开关、账号或外部引用背后的实际凭据。真实apply探针Key A→B后仍返回A91.23，停用后显式查询仍返回旧成功值，provider只调用1次。必须按当前允许集合和实际账户/凭据身份隔离缓存与single-flight；没有可靠身份依据时宁可跳过该来源缓存。describe和collect绑定同一快照，返回前验证代次，旧任务/卸载后不得回填。指纹留Host内部，不泄密。

D6-C/P1 真实语义投影：
- OpenCode usagePercent90是已用，却被工具说成剩余90%；应明确转换为剩余10或支持used口径，并适配schema/render/policy。Codex本来就是remaining，不能反转。
- WorkBuddy和AI真实wire为creditsTotal1906，投影只读creditsBalance，两个有限积分渠道都变unknown/null。按真实字段适配，保留0/负数/unlimited并明确积分单位。
- DeepSeek API实际选USD7.25时wire不带currency，工具币种为null；要保留所选实际币种，不能全硬编码CNY或混币相加。
- 百分比越界置未知，不钳位伪装；缺凭据/停用/自定义不存在/取数missing应可辨，不能全混成同一个missing。
必须用真实provider→project→render/策略的集成测试，不再在测试里发明provider没有的字段。

D6-D/P2 缓存与时间：当前usable判断会缓存network/auth错误及混合批次失败30秒；真实成功路径fetchedAt仍为null。只缓存真正成功，失败应能立即重试；成功采集时打时间，缓存命中不刷新时间，重新采集成功才更新。补失败→成功、混合批次、TTL和时间戳断言。

D6-E/P1 预算/取消：8秒只包collect，入口先await两次describe；各4500ms会9019ms才成功，永久挂起则不受工具deadline限制。exec.signal已abort仍取数；一个快渠道成功12/另一个挂起时，8秒后两个都被丢成missing。实际custom探针还观测工具8秒已返回、凭据9秒才解析好后仍发送Bearer。
从execute入口创建绝对deadline，贯穿配置/身份读取、排队、DNS/请求/body，组合调用方signal。超时/取消不再发后续请求、不回填；保留已完成渠道，仅未完成渠道超时。传递更短的工具预算，不能让custom默认10/20秒覆盖它。共享任务取消、单调用取消和卸载清理要有明确且互不串扰的语义。

D6-F/P2 值级脱敏：resetsAt只检查非空string，真实OpenCode响应可把SENTINEL_SECRET和私有URL逐字带进结构化输出。仅接受可验证并规范化的时间，非法置null；对允许字段做值级校验，不能只删除额外键。补所有上游可控白名单字段的秘密哨兵负例，合法值仍可用。

D6-G/P2 策略未接入：policyPromptFor只有纯函数测试，产品execute/render/systemPrompt路径都没调用。启用策略、关注DeepSeek、余额1且阈值10时，真实apply工具只给余额，没有建议；手工调用生成器才有文本。
不能宣称T3/T0–T4已完成。先核验宿主公开systemPrompt.section/context或工具结果附加策略等合规路径，接入实际模型可见输出，缺服务/默认关闭/无有效配置不受影响，卸载正确清理。审查已比对当前app.asar与提取副本，公开section/context确实存在；不得未经核验就声称“必须改宿主”。若确实不能交付，须明确向用户申请缩减T3范围，不能自行改成只交纯函数。

D6-H/P2 阈值授权：未填或NaN阈值被擅自补20%；计划中20只是示例并非确认默认。默认未配置/无效应不触发，明确有效范围与币种/积分单位。只有用户显式有效关注和阈值才参与；0/负值/NaN/越界、unknown/error/stale/unlimited不能劝停。不把混币或未知单位金额当同一预算比较。

保护已有C主线：配置摘要、customKeyRev、实际Key指纹gen、连接IP固定lookup/TLS、绝对预算、secret路径写入与保存事务、按渠道失败回退、WorkBuddy分类、强刷、阈值8、35/40秒原兼容等不得回退。工具专用逻辑不改变Web即时取数，不引入方向4全局缓存。

验收交付：
1. 每组列真实失败→通过证据；优先补实际provider/真实apply的时序测试，不只测独立纯函数。
2. 跑现有全部回归、WorkBuddy契约和新增用例，准确统计项目与跳过。
3. 更新实施记录、整改与审查补记，明确T0源码契约/真实冒烟、T3实际接入、T4用户试装各自状态；未经独立复核不写已验收。
4. 本地重新打包，核对所有payload、语法、注册表与新hash；因文件数可能随修复变化，按实际清单核对，不硬凑旧23个。
5. 真实宿主冒烟若需要改运行中profile，先单独说明并取得授权；无授权不部署不重启。不能把等价桩当真机，也不能为缺真机权限停掉可做的离线整改。
6. 最终逐项回报D6-A～H修改位置、负例结果、回归、未验证项、新包路径与checksum，交回复核。

硬性禁止：git reset/clean丢弃现有成果；修改DSH宿主；部署当前profile或自动重启；git commit、创建/改标签、push、Release、npm publish。不要为解决问题读取或输出真实凭据。
```
