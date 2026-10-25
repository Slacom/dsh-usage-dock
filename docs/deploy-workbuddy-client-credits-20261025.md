# WorkBuddy客户端积分接口：本地预览部署与验收

## 当前状态

已按用户授权部署到desktop profile中的现有插件目录。**这是磁盘部署，不是运行中的Host已激活，也不是用户真机验收通过。** 未自动重启DSH、未修改真实配置/Key/关注/阈值/安装锁，未提交、推送、打标签或发布。

本地标识：`0.9.1-dev.wbcredits.20261025`。本候选只包含WorkBuddy接口增补，**MiMo长期余额认证改进尚未实施**。用户确认的后续顺序为：本地验收通过 → 改进MiMo → 两项合并验收后发布新的正式0.9.1；已发布0.9.0不覆盖、不重指旧标签。

## 改动范围

- 复用模型来源`workbuddy`现有客户端API Key，运行期只请求同origin的`GET /v1/credits`，不探管理员`/status`、`/panel/api/packages`，不自动回退或猜另一把Key。
- 只统计严格`realm==='cn'`且未停用账号的`credits`；冷却账号仍计入。根`total_credits`是跨区合计，不用作国内余额；累计`credits_total`不冒充剩余额度或一个真实积分包。
- 新接口无稳定账号ID，不再提供手工账号勾选。旧`workbuddyAccounts`字段和值保留，但明确不生效；账号元数据兼容路由零凭据解析、零网关I/O。
- 明细仅给可用国内账号剩余与可得的「其中最早到期部分」。最早日期只对应`credits_earliest_remaining`，不把整个余额或未知窗口的`credits_expiring`标为同日到期。
- 真实0与有限负值保留；未停用cn账号缺失/非法数值、合计溢出时固定失败，不产出虚构或部分的完整余额。错误出口不回显上游原文。

## 已核验证据

- 用户授权的两次受限真实端点请求均HTTP 200/`ok:true`；只留脱敏投影/结构，未输出或另存Key、账号昵称/ID、完整上游正文、私有网关地址。部署与回归未再请求真实网关。
- 主独立检查：接口契约124、设置页/保存保值23、两条新增数值与明细边界2，全部通过；6组Host/UI/兼容回归均exit 0。
- 原实现代理收尾回归：新接口50/50、gateway 51/51，均exit 0；之前相关取消/预算/策略/兼容回归通过。上述是离线/模拟检查，不冒充重启后的真实GUI或Android联网验收。
- 固定预览包271807字节、28成员；tar头/白名单/禁止链接/源码逐字节与二次哈希检查通过。与公开0.9.0相比只改5个包内成员。
- SHA-256：`513880e4e8f083156c47b4a083bdd57b7272d94ec19f19a9f4ce70bda078f536`。
- 现有安装已备份28成员；实际只写5个变化成员；部署后28成员逐一匹配固定包，备份28成员逐一匹配部署前哈希；mismatch=0。回滚仅计划检查通过、无拒绝项，**未实际回滚**。

[固定预览包](../.diagnostics/wb-client-credits-20261025/build/dsh-usage-dock-0.9.1-dev.wbcredits.20261025.tgz) · [独立验包](../.diagnostics/wb-client-credits-20261025/candidate-verification.parent.json) · [部署后核验](../.diagnostics/wb-client-credits-20261025/post-deployment-verification.json) · [部署清单](../.diagnostics/deploy-wb-client-credits-20261025/deployment.json)

以上链接为本地工作区证据，不是已发布的下载地址。

## 用户手动验收

1. **完全退出DSH桌面端后重新启动**（不要仅关闭窗口留在托盘）。当前运行中的Host不会因复制文件自动重载。
2. 若使用浏览器访问重启后的DSH地址，再做`Ctrl+Shift+R`。使用重启后实际地址，不固定沿用旧端口。
3. 无需重填Key、重新创建来源、登录WorkBuddy Connect或重新关注WorkBuddy。确认现有`workbuddy`来源启用即可。
4. 侧栏应仍用✦显示WorkBuddy积分，口径是国内cn而非响应根的跨区总额；详情中的「其中最早到期部分」不是可额外相加的一包积分。
5. 设置页应提示客户端`/v1/credits`、仅国内cn、不支持账号筛选；旧勾选若存在，应提示已保留但不生效。其它渠道、顺序、关注和阈值应保持原设置。
6. 将验收结果告诉主代理。**确认通过后才进入MiMo改进与后续正式0.9.1流程**；不要为验证而贴Key/Cookie或完整响应。

## 回滚

[回滚脚本](../.diagnostics/deploy-wb-client-credits-20261025/rollback.mjs)默认只打印计划；[备份目录](../.diagnostics/deploy-wb-client-credits-20261025/backup/)保留部署前28个成员。

先完全退出DSH。默认检查：

```powershell
node .diagnostics/deploy-wb-client-credits-20261025/rollback.mjs
```

确认无refused后，需要实际回滚时再加`--apply`。脚本只恢复本轮变化且仍匹配部署后哈希的成员；若第三方已修改文件或备份不匹配，则整批拒绝，不覆盖他人改动。它不改配置、Key、安装锁或重启；执行外部写入仍需相应权限批准。当前只是验证回滚计划可用，并没有执行回滚。
