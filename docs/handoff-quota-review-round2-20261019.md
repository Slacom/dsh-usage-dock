# 额度感知整改第二轮复核：续接检查点

> 用户于2026-10-19 23:24要求复核整改，提醒当前额度剩27%；先保存本检查点，防止审核中途丢失进度。
> **状态：本轮复核已完成，仍不通过。**结论与六组残留问题见[第二轮复核报告](recheck-quota-awareness-round2-20261019.md)。只审核/合成复现/记录，未修产品、部署、重启、提交或发布。

## 1. 范围与上一轮证据

- 工作区：`E:\WorkSpace\DSH\DSH Usage Dock`。
- 上轮不通过：[13组整改项](review-quota-awareness-build-20261019.md)，包6b4024…，8组P1/5组P2。
- 当前执行者声明：[构建记录§5](quota-policy-build-v0.9.0.md#L99)，新包1D46A28A…、36个Node组1304项，另行尾58/几何144/契约7。
- 原验收：[完整交接](handoff-quota-policy-build-v0.9.0.md)、[路由研究](research-quota-route-binding-20261019.md)。
- 旧诊断目录：`.diagnostics/review-quota-build-20261019/`。旧主审和子代理脚本的许多assert是在确认“旧缺陷仍存在”，修复后退出1可能正说明修复生效，**不能把旧脚本exit1直接当新回归失败**。

## 2. 本轮最初源码观察（仅线索，不替代复现）

- 已新增observer begin/commit票据、显式status、客户端effectiveStatus，分类增加authKind/credentialState；需要沿真实采集链核验，不能只测helper。
- route模块默认闸门改false，但[生产调用](../index.js#L165-L186)通过quotaTrustRouteOrder读取，缺省仍按`!== false`放行。不能因为模块默认false就认定A06整体修好。
- [identityOfChannel](../index.js#L216-L224)使用全局configDigestOf＋id；需检查该digest究竟覆盖哪些字段，是否包含实际内置Key/账号，以及是否把未修改渠道一起失效。
- [publish](../index.js#L236-L293)提交票据后会直接更新channelProjection/Meta；需查旧身份结果能否通过commit写回当前id、begin时机是否真的早于采集。
- [构建记录](quota-policy-build-v0.9.0.md#L131-L139)明确账号证明仍未实现，但声称功能受限不会误判；必须验证“缺少证明”是否真的不投放，而非只检测某些source不匹配。

## 3. 继续步骤

1. 获取新包完整hash和payload比对；保存到新的第二轮诊断目录，不覆盖上一轮证据。
2. 优先实跑新增quota-remediation、quota-route-scope和原quota-awareness测试；对原A01/A02/A03/A04/A06/A07/A09/A10做实际apply→采集→context复核。
3. 针对身份切换/内置Key变化/无关渠道配置变化/旧身份迟到结果/模型与GUI计数一致做交叉边界。检查begin/commit不是只添加了API名称。
4. 路由能力闸门应审核生产入口，来源与pool必须审核证明缺失时的行为；账号级能力未做不能用默认信任掩盖。
5. 额度足够时跑全量；不足则记录完成的测试、未跑项、job id和明确未验证范围，交接后续模型。不以局部绿灯宣称全量通过。
6. 新报告按上轮A编号给通过/部分/未通过及复现日志；无新部署授权不安装真机。

## 4. 协作与安全

- 同时最多一个运行子代理，优先复用已有；为节约额度可不使用子代理。
- 可继续复用的宿主/路由审查代理：`58f3718d-524d-4252-9d7a-2d0e4a3ad4fe`（仅在当前会话有权限时）；不要新开并行代理。
- 使用合成凭据、网络桩；不读取真实profile配置/凭据，不通过真实供应商额度查询做探针。
- 只写审核文档/隔离诊断，不改生产与既有测试。

## 5. 当前执行记录

- 新包SHA256：`1d46a28acdcb8751e932b3343e00d79f256ae169e3db665d71c522c6cf169758`，178340字节、27个payload，mismatch=0。
- 已跑39脚本：36个普通Node组1304项＋行尾58＋几何144＋契约7＝1513项，全部exit0、0跳过；job `pwsh-143e8e88e0cc456d`已收集，无在途作业。
- 新诊断目录：`.diagnostics/review-quota-round2-20261019/`；[定向日志](../.diagnostics/review-quota-round2-20261019/recheck-host.log)、[回归计数](../.diagnostics/review-quota-round2-20261019/regression/counts.json)、[包核验](../.diagnostics/review-quota-round2-20261019/package-audit.json)。
- [定向脚本](../.diagnostics/review-quota-round2-20261019/recheck-host.mjs)确认A01与A09实质修复，仍能复现A02/A03/A04/A06/A07/A08残留；没有再用补全局导入的旧故障隔离。
- 继续修复/复核优先看[本轮报告](recheck-quota-awareness-round2-20261019.md)，不必重复最初宿主研究。本轮未启动子代理。

```powershell
# 注意：该脚本当前断言残留缺陷存在，整改后需要转为修复后行为断言，不能机械看exit码。
node .diagnostics/review-quota-round2-20261019/recheck-host.mjs
node .diagnostics/review-quota-round2-20261019/audit-package.mjs
```

当前不是“额度不足未做完审核”，而是“本轮审核完成并发现阻断问题”；下一步应由执行者补齐上述六组再申请复审。
