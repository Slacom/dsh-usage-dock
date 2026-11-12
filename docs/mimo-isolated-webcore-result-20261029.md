# MiMo R2：唯一一次隔离Web Core真实运行结果

## 结论与范围

2026-10-29 13:50:46–13:50:50 +08:00，主按[原单次许可](mimo-isolation-permission-20261028.md)执行一次隔离Web Core后端验收，**成功，exit 0**。实际SDK最小组合、空临时Home/profile、自有127.0.0.1随机端口；不是mock/Cordis fixture。

**不是完整Electron/Desktop重启或客户端UI验收，未扫码、未查真实钱包，恢复/续期未验。** 未安装到正式desktop、未改其配置、未重启/替换当前DSH；当前GUI端口4245不访问，实际HTTP必须先通过新实例PID归属闸门，故不依赖旧12263硬编码作为唯一保护。

## 证据

- [主独立预检](../.diagnostics/mimo-isolation-20261028/parent-20261029/preflight.json)：PASS、feasible true、无失败检查；执行前功能三项明确NOT_RUN。
- 主执行前`verify-impl2`：与seal `db9bd354143c66fa3b0ccc2231102f76d82f15824a787bbaeea5dd7e64641570`字节一致，DRIFT 0。
- [经安全投影的结果](../.diagnostics/mimo-isolation-20261028/parent-20261029/result.json)：attempts 1、permitConsumed true、exitCode 0、ok true。
- 冻结候选archive：`5d15d89807bd832ed7bb9c1a115f97069ec74344a0b005af9808cafeb60b4678`；未修改候选/stage。

| 运行事实 | 结果 |
| --- | --- |
| 实际后端HTTP就绪 | true |
| listener属于本次spawn的child PID | true |
| 临时owner握手后，空session status返回404及预期missing-session信封 | 通过（runner严格条件） |
| 不带cookie的同接口访问被拒 | true |
| 原始SDK stdout有界捕获，无overflow | true；83 bytes，原文未留存/回显 |
| 守卫报告的网络违规数 | 0（非OS抓包证明） |
| 进程回收/存活数 | killed 1 / survivors 0 |
| 端口关闭且私有temp根清理完成 | handleClosed true |

主supervisor墙钟约3.93秒；runner内部timing 2467ms，不将该内部区间单独冒称纯启动耗时。

## 数据与测量边界

- 不调用Start/Begin/approve/QR或官方供应商服务；实际仅临时owner握手、带owner的GET空session status、不带owner的GET拒绝测试。
- owner通信key/cookie/能力URL仅在新空环境内处理；不打印或保存raw stdout/stderr，不读真实profile/认证库，不回显任何余额。
- path/env字段为null，**没有OS沙箱或完整系统级读写监测**，不能把它们当实测零。子JS看门狗是协作型，父也有独立时限。
- 主supervisor最初将runner结构化requestTrace当字符串数组过滤，未保留该原始trace。已把结果字段更正为`request_actions:null`、`request_trace_not_retained:true`，不以空数组冒充零请求；**不为补trace重跑**。接口结果/身份/退出来自该次实际返回；无Start的结论结合固定执行代码边界，而非声称持有逐请求审计。
- 当前goal自动开关仍被平台标为paused；主已按本次人工“继续”尝试resume，平台拒绝模型恢复。此试验由直接人工请求推进，未创建重复目标、未声称开关已恢复。

## 许可与下一步

这一次许可**已消费且不可重放**，不得删除started或生成第二张permit重试。授权nonce记录不作为聊天附件或公开交付；不要读取其内容。旧mount/旧配置/旧rollback仍不可重放。

原WB High的[结果独立复核](../.diagnostics/mimo-isolation-20261028/audit/RUN-REVIEW-20261029.md)已完成，仅支持上述三项，且确认各项证据限制。主运行后复核7个冻结文件仍drift 0；经安全投影并更正trace字段的result SHA256为`5c788ead99f14eeef9f006b3ed2d902f898ab9e35d6cce91453d53c10fb14fcb`。

后续若要将新包最小试装到用户恢复后的正式desktop，需明确确认新试装范围；仍禁止自动重启，真实扫码须本人主动操作，不默认保存长期票。扫码/余额/跨重启恢复/续期四门继续未通过，不发布正式0.9.1。
