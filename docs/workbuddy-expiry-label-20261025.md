# WorkBuddy最近到期标签：本地验收增补

用户已确认前一预览版积分正常显示，本轮只按反馈调整详情文案及日期展示；不改变Host采集、cn口径、积分计算或最早到期部分的金额。

## 展示规则

- 到期部分显示「最近到期 YYYY-MM-DD」，日期取现有wire的`endTimeMs`实际时间戳，并按浏览器本地日历日期格式化，不写死用户示例日期，不截取UTC字符串造成午夜错日。
- 时间戳缺失、非法或超出可显示日期范围时仅显示「最近到期」。
- 兼容旧wire的「其中最早到期部分」标签；普通套餐名、普通剩余行、其它渠道不改。
- Host未变：没有有效到期摘要时仍按原合约不造摘要行。此处回退用于客户端确实收到摘要但缺少有效日期的情况。

## 验证与部署

- 新增真实客户端渲染的13项离线断言，先在旧客户端复现11项失败；修复后在Asia/Shanghai、UTC、America/Los_Angeles三种时区全部通过。
- footer-row、degrade-refresh、settings-layout、android-compat、workbuddy-client-credits相关回归全部exit 0。没有新增真实网关请求。
- 本地标识`0.9.1-dev.wbcredits.20261025.2`，固定包272246字节、28成员；SHA256：`2a9dd433dec8809dc95e7a08ac718784066e8a61aed4ff70107a5606634a0c93`。
- 与前一受审预览包相比只改[客户端](../client.js)、[包元数据](../package.json)和[README](../README.md)；Host及积分模块逐字节未变。
- 已备份28个原成员，仅部署3个变化成员；安装28项、备份28项哈希全部通过，mismatch=0。回滚仅计划检查通过（restore3、refused0），没有实际回滚。
- 未修改真实配置、Key、关注、阈值或锁；没有自动重启，也未提交、推送或发布。旧预览固定包与旧备份保留，不覆盖。

[本轮部署清单](../.diagnostics/deploy-wb-expiry-label-20261025/deployment.json) · [部署后核验](../.diagnostics/wb-expiry-label-20261025/post-deployment-verification.json) · [回滚脚本](../.diagnostics/deploy-wb-expiry-label-20261025/rollback.mjs)

这些链接为本地工作区证据。回滚脚本默认只打印计划，实际执行需要完全退出DSH、确认无拒绝项后才加`--apply`，并仍受写入权限审批与哈希守卫约束。

## 待用户操作

请完全退出并重启DSH；使用浏览器时再硬刷新，确认最近到期日期与金额显示。磁盘更新不代表当前Host已激活新客户端。详情验收确认后再继续MiMo主线，最终合并发布新的正式0.9.1；不覆盖已发布0.9.0。
