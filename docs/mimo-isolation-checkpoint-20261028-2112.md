# 隔离Web Core检查点 · 2026-10-28 21:12 +08:00

## 已完成

- 用户三条长期协作规则已写[项目记忆](../MEMORY.md)与[AGENTS第0节](../AGENTS.md#L6)：无独立工作只等代理时暂停；优先复用；分包并行但同时含后代最多4名。本阶段仍仅两名原WB代理，未新建。
- 主真实执行了[无服务预启动探针](../.diagnostics/mimo-isolation-20261028/audit/prelaunch-probes.mjs)，[结果](../.diagnostics/mimo-isolation-20261028/audit/PRELAUNCH-PROBES.json)为ALL_OBSERVED、4项全true：runtime_node_mode、guard_preload、guard_cooperative_watchdog、scoped_query_command_available。
- 结果sha256：`f7b799577b59ed8cbfba56698bc18865a619a23ee5e45a17ab92bc28bdd12045`；ranAt `2026-10-28T13:11:43.366Z`；guard sha `fbdbd35a54c9e42ef4073d895553bfc2221943ab5f1f808e46d56ddb54cf4c58`。
- 4个短命纯程序helper均退出，temp清理已核true；服务/端口/socket为0、permit未消费。不是SDK启动、更不是完整Desktop验收。
- 主先修了探针自身缺陷才运行：错误引用双参数参考env函数→实际impl单参数白名单函数；A2禁用其看门狗避免误exit70；C使用同一packaged exe；已退出子进程不再裸taskkill PID，live用child handle并等退出；所有child退出且root realpath/marker重验后才删temp。未改候选/DSH/真实配置。

## 尚待两名既有WB收尾

1. WB Max `00fb0951-8343-4682-b17d-8a2d08421422`：v2已经补manifest原始bytes硬pin，修了单靠stage+可变manifest的信任链缺口。manifest固定sha `ef07820f88761cb30be862c62d4255d29672290559457a19e1fd770e2be28396`；R2 archive仍 `5d15d89807bd832ed7bb9c1a115f97069ec74344a0b005af9808cafeb60b4678`。35项自测通过属其报告。
2. **v2 Gate仍有死环，未获主放行**：它要求CLI真的启动/端口归属/退出这些试验结论先存在才能执行首次试验。已令Max撤销v2 freeze，最后一次小修为 `feasible = staticSafety && 实际预启动证据有效`；固定上述父结果SHA、schema/status、4cap、guardsha、无truncated、cleanuptrue、计数0。功能三项维持NOT_RUN，不参与feasible；实际启动后观测，PID归属校验失败仍必须在任何HTTP前硬停。不得把P_OK伪装成SDK成功。
3. WB High `ec032345-3f2c-45be-bf8a-3b9b5983e753`：等Max新freeze后只审新字节diff、核父证据、重新seal；旧seal `86c6f67f…`不能覆盖新版本。其先前P7a/P9为判定式误报，已认错更正；不能用自己的参考65项冒充实际guard通过。父不再增加测试面/代理/框架。

## 操作授权与不变量

[用户许可](mimo-isolation-permission-20261028.md)仅允许条件满足后**一次独立temp Home/profile、本机Web Core后端**启动+临时owner握手+GET空session status；当前尚未创建任何新permit/started，实际SDK服务仍NOT_RUN。无Start/Begin/approve/QR/官方请求，现有GUI端口12263不可碰，不恢复旧配置/旧mount/旧rollback。

只有父可在最终源码与新seal核验后新建wx单次permit并执行。未能确认隔离就不启动。JS守卫非OS沙箱，残余如实记录；所有进程与port清理必须真实观测，不能由rm成功推算。

R2候选及[构建记录](mimo-repaired-build-20261028.md)不变。MiMo扫码/余额/跨重启恢复/续期四门仍未通过，未安装、未发布、未重启正式DSH。当前无后台shell job；只等上述两条代理的自然回报时主暂停，不忙轮询。
