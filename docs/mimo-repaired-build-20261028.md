# MiMo修复候选：构建及离线验收完成，未试装

## 产物与状态

- 私有包版本`0.0.0-poc.20261028.1`，与[已撤回旧候选](mimo-candidate-withdrawn-20261028.md)分开保存。
- [修复包](../.diagnostics/mimo-settings-20261028-r2/build/dsh-mimo-login-poc-0.0.0-poc.20261028.1.tgz)：44,148字节、11个普通文件。
- SHA256：`5d15d89807bd832ed7bb9c1a115f97069ec74344a0b005af9808cafeb60b4678`。
- [逐文件校验清单](../.diagnostics/mimo-settings-20261028-r2/build/candidate-manifest.json)：tar回读、源字节及展开后字节一致；新的[冻结入口](../.diagnostics/mimo-settings-20261028-r2/staged/dsh-mimo-login-poc/index.js)也通过父完整假上游链18项。
- **未部署、未重启、未初始化官方扫码、未查询真实钱包、未读取或修改用户已恢复的新profile/凭据库。** 未npm安装、未提交推送发布。
- WB工作区基线39文件hash一致；旧撤回包与旧staged11文件也保持不变，仅作为反例保存。本轮不声明用户恢复后的安装/配置内容与旧时完全相同，不擅自还原它们。

## 已修的插件缺陷

1. **连接服务时序**：旧代码只声明webServer依赖，却在apply时一次性读异步connection。真实Cordis/Loader证明它可能active但0接口。新入口声明实际消费的connection，延迟后注册7条owner接口；移除时注销/abort，重提供是新manager；缺底座时明确pending/不可用，不伪造业务可用或裸HTTP降级。
2. **桌面头部契约**：公开Electron转发会剥离Origin等头，旧POST守卫因此拒绝合法桌面请求。新策略允许缺Origin，但保留SDK owner硬准入、非简单头、严格JSON；有Origin仍严格同源，null/异源/跨scheme/cross-site拒绝。敏感后续变更还要求会话绑定CSRF，不能以客户端自报“桌面”绕过认证。
3. **握手和归属**：Start零供应商、8秒准备租约，返回sid32/正generation/token64；Begin/approve/cancel/confirm带该会话私有CSRF。旧回调只能使用其捕获的旧sid+token，不能借新令牌；状态/UI/URL/日志不带CSRF，供应商请求也不带它。
4. **先检测本机，不先扫码**：新增本人主动点击的只读探针，唯一就绪条件是HTTP404及本插件固定missing-session信封。未通过不能Start；绝对5秒覆盖fetch与body，不配合取消也退出，迟到不回填。没有自动probe/重试/扫码。
5. **路由与错误**：使用官方document-relative路由及正确绑定的原生fetch；本构建没有transport.fetch，不发明IPC接口、不读owner Cookie。将本机取消、超时、fetch拒绝、HTTP鉴权/端点、协议错误分层为固定码，不回显异常原文或认证URL。

原有epoch/预算/有界正文/QR blob/迟到丢弃与官方认证流程保留。包内flow与Cookie Jar仍为此前受审的原hash，未为修客户端放宽域集合、预算或挑战处理。

## 父独立验收（全部离线）

| 脚本 | 通过 |
|---|---:|
| [客户端](../tools/test-mimo-settings-client.mjs) | 80 |
| [载波契约](../tools/test-mimo-settings-carrier.mjs) | 15 |
| [Host](../tools/test-mimo-settings-host.mjs) | 43 |
| [整合](../tools/test-mimo-settings-plugin.mjs) | 34 |
| [认证流程](../tools/test-mimo-settings-flow.mjs) | 42 |
| [会话](../tools/test-mimo-settings-session-lifecycle.mjs) | 18 |
| 合计 | **232项** |

另由主执行[真实Cordis冷启动](../tools/test-mimo-coldboot-contract.mjs)A–I九场景、[完整真实模块+全假上游](../.diagnostics/mimo-qr-20261028-fix/parent-repaired-e2e.mjs)18项、[固定旧包反例/载波回归](../.diagnostics/mimo-qr-20261028-fix/run-all.mjs)45项，全部exit0。该18项在源及新展开包上各通过一次；完整性闸门2文件/9 marker通过。所有供应商传输被替换，未起HTTP服务器、未载入真实profile或账号。

## 未被证明，不能扩大表述

- 真实截图的E_NETWORK具体fetch拒绝原因仍未确定，接口缺失通常应404，不等于网络拒绝。
- 真实永久loading和web launcher整机fatal未被Cordis fixture重现。它证明的是受控竞态及依赖生命周期，不是完整DSH启动成功。
- 用户说已修复DSH，应以当前修复后环境为基线。几份公开SDK源未变只证明那几份未变，不能据此推断整个修复只改了profile。
- 尚未有新包实际桌面往返、自定义scheme keepalive保证、官方扫码、真实钱包一致性或恢复/续期证据，四关仍未通过。

## 下一步需另获许可

建议先评估并执行**临时独立Home/profile的整机冷启动和只读本机连接检测**，不要再直接写正式desktop试错。执行前须从公开源码确认隔离路径、环境、凭据服务与网络行为；不加载原有真实账号/供应商凭据，不修改desktop，不重启当前DSH，不访问官方。若需本机临时服务，必须用户明确允许；无法确认隔离时停止报告，不启动。

该隔离验证也不能替代真正Desktop试装；应先通过必要门槛，再向用户说明范围、回滚和边界，重新确认新试装与是否开始新的内存扫码。旧备份/旧挂载helper/旧单次供应商许可均不重放。
