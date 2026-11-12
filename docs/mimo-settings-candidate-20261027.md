# MiMo旧候选：已撤回，以下仅为历史记录

> **2026-10-28更新：此包不可重新试装。** 真实桌面和启动问题见[撤回记录](mimo-candidate-withdrawn-20261028.md)；新的私有修复包及独立验收见[修复构建记录](mimo-repaired-build-20261028.md)。新包也尚未获准部署，用户已恢复的正式配置不得被旧备份覆盖。原单次许可不重放。

以下保留当时冻结及试装依据，不代表当前就绪状态。

## 冻结产物

- [本地候选包](../.diagnostics/mimo-settings-20261027/build/dsh-mimo-login-poc-0.0.0-poc.20261026.tgz)：独立包`dsh-mimo-login-poc`、private，39,987字节、11个普通文件。
- SHA256：`c70bc81c9ffed543ab6a9208fb31041939798a36ff10935ffed29677d9197fb4`。
- [逐文件清单](../.diagnostics/mimo-settings-20261027/build/candidate-manifest.json)：tar回读与源文件逐字节一致，打包期间源未变；不运行npm/构建钩子，不读取profile/凭据。
- [冻结的工作区运行入口](../.diagnostics/mimo-settings-20261027/staged/dsh-mimo-login-poc/index.js)：从上述包白名单逐项展开、校验11文件hash，非安装。父另用该入口重跑完整假上游链，15/15通过，证明包内没有工作区外部模块依赖。

包版本中的26号是候选起始版本，不是正式0.9.1，也没有发布到npm/GitHub。不可覆盖旧0.9.0或已验收WB副本。

## 父独立复核证据

| 离线脚本 | 结果 |
|---|---:|
| [包内认证流程](../tools/test-mimo-settings-flow.mjs) | 42/42 |
| [会话生命周期](../tools/test-mimo-settings-session-lifecycle.mjs) | 18/18 |
| [Host接线](../tools/test-mimo-settings-host.mjs) | 35/35 |
| [设置页客户端](../tools/test-mimo-settings-client.mjs) | 38/38 |
| [整合旧集](../tools/test-mimo-settings-plugin.mjs) | 34/34 |
| 合计 | **167项** |

另有父[实际模块+假上游串联](../.diagnostics/mimo-qr-20261026/parent-settings-e2e.mjs)15项和[会话负例](../.diagnostics/mimo-qr-20261026/parent-settings-session-probe.mjs)4项，均通过。前者同样在解包后的冻结入口运行通过，不是实际DSH实例或真实供应商联网。无HTTP/DNS/账号试验。

- 当前ASAR三份固定公开SDK与26号受审源一致，仍0.2.1-rc.3；未加载profile服务。
- 主最后再次验证已验收WB基线39/39文件hash一致，tracked diff为空。未安装、重启、提交、推送或发布。
- 子代理固定显式`workbuddy / cn:deepseek-v4.1-flash / high|max`；本批流程与页面由WB Max实施/复核，主独立验收。不再复用GPT子代理。

## 关键边界

全部敏感资源由`connection.fetch.register` owner鉴权；缺服务不可用且无裸HTTP降级。POST严格同源/JSON/非简单头、8KiB及2秒入口读取预算，资源全部no-store。

Start只准备8秒租约，零供应商请求；客户端拿到随机会话id后才Begin。Host持有会话，图像仅由owner资源传bytes，浏览器只建blob，不接收官方QR能力URL。未知轮询目标只有合法一级account子域可在本机本人确认后按本次精确URL/GET/用途批准，不扩通配域；更深层或其它目标仍拒绝，其真实形态尚未知。

离开页面、取消、过期和迟到响应都作废当前epoch/operation并清图。pagehide不自动恢复；切到其它窗口/手机（visibilitychange）不会误取消。状态挂起也有不延长的5分钟本地上限。终态只保留本机可见的白名单核对结果，不保留认证票；不保存records，不读旧Cookie/其它认证库，不做续期或验证码绕过。

## 四关仍未过

| 用户要求的关卡 | 真机状态 |
|---|---|
| 官方二维码扫码及平台会话 | 未通过 |
| 真实钱包余额与本人核对 | 未测试 |
| 跨重启恢复 | 未测试 |
| 续期 | 未测试 |

25/26号单次探针许可均已消费，不删除marker重跑。此后用户在主对话明确回复“都允许”，授权独立临时挂载及本人一次仅内存扫码/钱包核对；28日已挂载并校验，见[实际挂载记录](mimo-local-mount-20261028.md)。本机客户端资源已生效，真实页面/扫码与钱包一致性仍等本人反馈；恢复和续期没有获准或通过。

## 拟议的下一步（须用户明确确认）

1. 将冻结候选**独立临时挂载到desktop profile**，只新增自己的入口，并在本机备份、校验原配置；配置内容不输出到聊天，不读取凭据库。优先使用受支持的file URL入口，**不重新解析整套npm依赖**，避免回滚/改变现有WB开发版。若现有布局或公开加载契约与预期不符，停下报告，不扩大改动。
2. 根据实际Host激活情况决定是否需要用户手动重启；不自行重启或另开服务器。只在当前DSH GUI刷新核验设置页，不把磁盘文件存在当作已激活。
3. 若另获一次真实内存试验许可，由用户本人在新设置页开始、核对官方轮询origin、扫码、比较三项钱包金额并点一致/不一致。遇未覆盖目标或安全验证立即停止，不自动重试。
4. QR、认证URL、Cookie/passToken/Key及金额不发到聊天；用户仅报告显示/扫码/金额一致性与固定码。本次结束不保存票，跨重启恢复/续期另获具体许可再做。

本候选不是持续显示功能正式交付；四关与用户联合验收完成后才能接正式MiMo卡/查询链并发布新的0.9.1。
