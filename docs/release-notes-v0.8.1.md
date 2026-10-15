# dsh-usage-dock v0.8.1

2026-10-15。上一公开版本为 **v0.7.2**；此前本地规划的 0.8.0 没有单独发布，相关功能一并纳入本版。

## 新增与改进

- **小米 MiMo 余额**：控制台 Cookie 鉴权，显示总余额及现金/赠送明细，可设低余额警告阈值。
- **WorkBuddy 积分**：复用 dsh-workbuddy-connect 的国内/国际版状态接口，显示剩余积分及套餐明细；无需本插件另行认证。
- **渠道排序**：设置页 ▲ / ▼ 调整胶囊及面板中的渠道顺序。
- **DeepSeek 峰谷条**：以现在为固定中点，24h 峰谷图案平滑移动，分钟级漂移校准；小字显示高峰/空闲时段与下一切换时间。
- **倒三角定位修复**：三角与柱共享唯一中心锚点，三角尖端接触轨道上沿；用户已确认修复成功。
  保留 2px 柱，光柱/引线等候选仅保留为演示，未实装。
- **失败降级与刷新**：短暂传输失败保留旧值，连续两轮失败显示错误；展开、focus、重新可见时立即刷新，余额向下取整到分。
- **配置读取**：Host 可用时通过 configEditor 重读配置；保存 Cookie/Key 与关闭渠道不必总是依赖重启。无该服务的移植宿主回退启动快照。
- **充值入口回退**：移除本地试验的内嵌/原生充值按钮，避免视图与返回栏互相遮挡；低余额提示引导相应平台操作。

## 安卓 / DSHA 检查与防护

- 继续使用 Host 原生 fetch，无 shell、无 Python/curl、无桌面账号服务时可以走 API Key 读取余额。
- 修复单渠道异常导致整条用量接口失败的问题；同步抛错、异步拒绝均返回本渠道结构化错误。
- 修复旧请求 JSON 解析迟到覆盖最新强刷结果；请求身份与 AbortController 解耦，缺少该 API 的裁剪 WebView 仍有锁与超时兜底。
- 修复 PeakBar 数据缺失/恢复时 hooks 数量变化；无 WAAPI 时静态定位，无 ResizeObserver 时定时校准宽度。
- 登录失效、缺凭据等语义错误立即透传，不拿旧余额掩盖。
- WorkBuddy 外层异常返回结构化错误；一版成功、另一版异常时不再把部分积分伪装成完整合计。
- 设置保存期间锁定字段和排序，避免慢网下继续编辑后草稿丢失；纠正 WorkBuddy 登录来源提示。

已核对 DSHA 移植使用的 **dsh-workbuddy-connect 0.7.4** 安装包：两条 status 路由、回环安全限制、
`credits.total/accounts` 字段与手机插件自有认证副本读取方式均匹配。以真实 status handler + 模拟认证/计费
完成接口对接；无需在安卓安装 WorkBuddy 桌面应用。两插件应装在同一 profile，登录副本和计费网络必须可用。

**验证边界**：这是源码、模拟宿主与真实浏览器几何检查，不是 Android 手机联网真机测试；不能保证所有移植版本及 WebView 版本都一致。

## 验证

| 检查 | 通过数 |
| --- | ---: |
| 取数后端（含真实上游无效 Key 鉴权与 Python 兜底） | 8 |
| 侧栏折叠 | 4 |
| 底部独占行及额度布局 | 11 |
| 失败降级、刷新竞态、余额与各渠道渲染 | 39 |
| 峰谷相位与段窗口 | 32 |
| MiMo Cookie / 余额解析 | 21 |
| WorkBuddy 归一化及异常路径 | 13 |
| 安卓 Host、可选服务、hooks 与 API 降级 | 13 |
| 设置页、排序及保存锁 | 6 |
| 真实 Chrome 标记几何（宽度 / 缩放） | 120 |
| 真实 WorkBuddy 0.7.4 status handler 接口契约 | 5 |

合计 **272 条断言/检查通过**，其中 120 条是布局矩阵的几何断言，不应理解为 120 台设备。

## 安装

```sh
dsh plugin --profile web add dsh-usage-dock@0.8.1
```

安卓使用 `web` profile；桌面按实际配置使用 `desktop`。安装后重启引擎，重新打开 WebView / 刷新页面。

- [npm](https://www.npmjs.com/package/dsh-usage-dock)
- [GitHub](https://github.com/Slacom/dsh-usage-dock)
- [v0.7.2](https://github.com/Slacom/dsh-usage-dock/releases/tag/v0.7.2)
