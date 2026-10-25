# WorkBuddy详情重复行清理：本地验收增补

用户已确认客户端积分可正常显示，随后要求日期标签及去除重复的小字「WorkBuddy · 套餐」汇总。本轮只做显示收尾，不开始MiMo改进。

## 最新本地状态

- 标识：`0.9.1-dev.wbcredits.20261025.3`。
- 大号总积分保留；仅隐藏金额与总积分完全相同、无名称/面额/日期且不是到期部分的普通汇总行。独立账号金额、具名套餐、到期部分均保留，不把无限模式误当有限总额处理。
- [上一轮日期规则](./workbuddy-expiry-label-20261025.md)继续有效：实际日期按浏览器本地日历显示「最近到期 YYYY-MM-DD」，缺有效日期时只显示「最近到期」。
- Host采集、国内cn口径及金额计算逐字节未改；没有新增真实上游请求。

## 验证与部署

真实客户端渲染测试16项全部通过（先在旧客户端复现重复行断言失败），footer-row与degrade-refresh相关回归exit 0，语法和补丁空白检查通过。

固定预览包272415字节/28成员，SHA256：`0baa7f76c91430e3bc9826630bb3ba9bd025c1a09fccbe81e136269050bd551e`。相比上一预览只改[客户端](../client.js)、[包元数据](../package.json)、[README](../README.md)。旧包不覆盖。

已备份28成员，仅替换3个变化成员；安装28项与备份28项全部匹配，mismatch=0。回滚仅计划检查通过（restore3/refused0），没有执行回滚。

[部署清单](../.diagnostics/deploy-wb-detail-cleanup-20261025/deployment.json) · [部署后核验](../.diagnostics/wb-detail-cleanup-20261025/post-deployment-verification.json) · [回滚脚本](../.diagnostics/deploy-wb-detail-cleanup-20261025/rollback.mjs)

以上是本地工作区证据。回滚脚本默认只打印计划，执行需先完全退出DSH、确认无refused后加`--apply`，并仍受审批与哈希守卫约束。

未改配置/Key/关注/阈值/锁、未重启、未提交或发布。**请用户完全退出重启DSH并刷新后验收；磁盘部署不代表当前Host已激活。** 验收通过后再继续MiMo，最终两项合并验收后发布新的正式0.9.1；不覆盖0.9.0。当前额度预警，先在该收尾点保存状态，不启动新大任务。
