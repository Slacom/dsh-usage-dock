# MiMo设置页隔离试验：2026-10-26授权与证据

## 本轮授权

用户直接说“继续”，目标已恢复（revision3，active）。随后明确批准：

1. 一次最小脱敏目标诊断，最多两个官方初始化请求，不取二维码、不轮询、不登录、不存票、不扩大白名单。
2. 采用设置页内嵌方向，并**先构建、离线审查独立的MiMo登录试验设置页插件**。仅工作区候选与测试，不安装、不改现有UsageDock、不发真实账号请求。安装、可能的手动重启和真实扫码仍需另行确认。

当前GUI为`http://127.0.0.1:10505`，不是昨日端口。分支仍`feat/mimo-qr-20261025`，HEAD为已验收WB本地提交`70a27b5f97fa1efa96dd4324c0cbeec33db1b5e6`。不提交、推送、发布或覆盖旧版。

## 诊断结果：已执行，许可已消费

[脱敏结果](../.diagnostics/mimo-qr-20261026/target-diagnostic.result.json)：入口302、初始化200、识别固定反XSSI前缀；sid与callback单值检查通过。

- 图片目标：`account-exact`，现有策略接受。
- 长轮询目标：`account-subdomain`、`reason=host`，现有策略拒绝；`literalOrigin=null`。
- 具体主机仍未知，不能写成c3或其它猜测；这不是TLS或余额解析失败的证据。
- 实际仅两个初始化调用意图，无图片、长轮询、SSO、余额或新增目标请求。26号marker/result独占保存，不可删除重跑。25号两项旧许可也不复用。
- 主逐段读诊断源码，独立重跑21项离线测试及捆绑Electron Node自测，全过。这里的成功只表示诊断完成，不是登录通过。

## 独立设置页候选

新实施代理继续负责候选，主负责规划/复核。候选放`tools/poc/mimo-settings-plugin/`，独立包名/namespace/tab，正式UsageDock39文件与已安装副本不动。不嵌第三方登录网页，不读浏览器Cookie，不开替代服务器。

候选仅内存扫码与余额，暂不接真实records。所有状态、图像、开始、批准、取消资源都走当前SDK `connection.fetch.register`的owner鉴权，并补严格方法、JSON体限制、同源/CSRF保护和`no-store`；缺能力明确不可用，无裸路由降级。

新初始化返回的未知account子域先验证HTTPS443、无userinfo/fragment及合法DNS标签。Host只在内存保存精确轮询URL，受owner保护的本地设置页用纯文本显示完整origin供本人判断（不送模型或日志）。客户端仅回sessionId/approvalId；批准只绑定本次会话/代次/精确URL/GET/用途，不扩大整个子域，不持久化批准。未批准、取消或过期均零目标请求。

UI不触其它表单草稿；清理blob、定时器、监听与所有后台任务，取消/卸载根abort，迟到结果不能更新新会话。上游票、query、QR能力URL、错误正文不进聊天/诊断或localStorage。余额数值仅本机owner页面，模型结果只报告门槛与一致性状态。

## 当前SDK补证（公开安装源码，只读）

[固定源清单](../.diagnostics/mimo-qr-20261026/ui-sdk-current/PROVENANCE.json)来自当前ASAR，不加载模块或profile，不调用迁移/配置CLI。

- [设置页tab消费逻辑](../.diagnostics/mimo-qr-20261026/ui-sdk-current/dsh-client-ui-settings-plugins-lib-client.js#L176-L211)：直接遍历`slots.entries('settings.plugins.tab')`，以id/order/label注册root list；此处没有configForms门控。独立tab的可行性已有源码证据，实际渲染仍待受准安装验收。
- [客户端包发现](../.diagnostics/mimo-qr-20261026/ui-sdk-current/dsh-client-modules-lib-index.js#L720-L749)：从已加载包的`dsh.client.platform=web`及`exports['./client']`定位bundle；[宿主资源注册](../.diagnostics/mimo-qr-20261026/ui-sdk-current/dsh-client-modules-lib-index.js#L545-L573)负责plugin bundle与启动图，不自行开服务器。
- [owner路由检查](../.diagnostics/mimo-qr-20261026/ui-sdk-current/dsh-client-connection-lib-index.js#L820-L853)：Fetch route命中后明确拒绝非owner。只调用requestRejection不等同owner检查。
- [安装激活结果](../.diagnostics/mimo-qr-20261026/ui-sdk-current/dsh-plugin-manager-lib-index.js#L2355-L2396)：按HMR能力与reconcile结果区分applied/restart-required。因此不能一概宣称必须重启，也不能许诺自动热更新；获准安装后以实际返回和当前GUI刷新核验为准，永不自行重启。

## 当前未完成

独立候选正在构建，尚未父审、打包、安装或真实显示；扫码、余额、冷启动恢复、续期四关未过。下一步先审候选和离线测试，再向用户说明最小安装/回滚范围及真实扫码试验许可。
