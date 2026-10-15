# dsh-usage-dock

[![npm version](https://img.shields.io/npm/v/dsh-usage-dock.svg)](https://www.npmjs.com/package/dsh-usage-dock)
[![license](https://img.shields.io/npm/l/dsh-usage-dock.svg)](https://github.com/Slacom/dsh-usage-dock/blob/main/LICENSE)

DeepSeek Harness（DSH）的侧栏套餐用量插件：在左侧栏底部显示余额、积分和剩余额度，点击展开详情。

> 当前版本 **0.8.2**：[发布说明](https://github.com/Slacom/dsh-usage-dock/releases/tag/v0.8.2)。

![侧栏余额与额度预览](https://raw.githubusercontent.com/Slacom/dsh-usage-dock/main/preview.png)

## 支持渠道

| 渠道 | 数据来源 | 显示内容 |
| --- | --- | --- |
| OpenCode Go | OpenCode usage API | 5小时 / 周限 / 月限 |
| GLM Z.AI / GLM 智谱 | 对应 monitor API | 用量窗口、套餐等级 |
| Kimi Code | Kimi API；可选 Cookie | 5小时 / 周限 |
| DeepSeek | DSH 账号余额优先，开放平台 API Key 回退 | 余额；账号模式附峰谷时间条 |
| OpenAI Codex | 已安装的 dsh-codex-connect | 5小时 / 周限剩余额度 |
| Xiaomi MiMo | 开放平台控制台 Cookie | 总余额、现金及赠送余额 |
| WorkBuddy / WorkBuddy AI | 已安装的 dsh-workbuddy-connect 状态接口 | 合计剩余积分、套餐明细 |

- 每 **30 秒**刷新；展开面板、窗口聚焦、页面重新可见时立即刷新。
- 短暂网络失败保留旧值，连续两轮失败显示错误；未登录、缺凭据等错误立即显示。
- 胶囊独占侧栏底部一行，位于其他底部插件上方；侧栏折叠时只显示圆点，不可点击。
- 设置页可开关渠道、配置凭据及余额警告阈值，通过 ▲ / ▼ 调整显示顺序。
- 余额向下取整到分。DeepSeek / MiMo 警告阈值默认 10 元，填 0 不警告。

## 安装 / 更新

目标环境是提供官方 Web 插件席位、Config schema 与 configForms 的 DSH 0.2.0 系列；
安卓端包括基于 `0.2.0-rc.2` 的 DSHA / DeepCode 移植环境。不同移植版本仍需核对宿主 API。

```sh
dsh plugin --profile web add dsh-usage-dock@0.8.2
```

桌面端按实际 profile 使用 `--profile desktop`；也可在「设置 → 插件」添加包名。
安装后重启 DSH / 安卓引擎，再刷新网页或重新打开 WebView。

## 安卓 / DSHA 兼容性

- 取数在 **Host 的 Node 原生 fetch** 中执行，不需要手机安装 Python、curl 或桌面应用。
  随附 Python 脚本和系统 curl 仅为有 shell 环境的备用后端。
- 没有 `deepseekAccount` 服务时使用 DeepSeek API Key；账号模式的峰谷条不出现在 API Key 模式中。
- 不依赖桌面充值桥；本版不提供内嵌充值按钮。充值在相应平台或官方账号设置中操作。
- WebView 缺 WAAPI 时退化为静态相位定位；缺 ResizeObserver 时定时校准轨道宽度。
- 已通过无 shell / 无账号服务 / 无配置编辑服务模拟、窄侧栏折叠守卫、请求竞态回归。
  **代码及接口契约检查不代表所有 Android 机型均已真机测试。**

### 安卓 WorkBuddy 积分

Usage Dock 复用同一 Host 内的这两个接口，不直接读取、复制或解密 WorkBuddy 认证文件：

```text
/plugins/dsh-workbuddy-connect/status
/plugins/dsh-workbuddy-connect/ai/status
```

已核对 DSHA 移植使用的 `dsh-workbuddy-connect@0.7.4` 真实安装包接口，并以真实 status handler
加模拟登录/计费数据完成对接验证。手机上需要：

1. Usage Dock 和 WorkBuddy Connect 安装在同一个 `web` profile，均已启用。
2. WorkBuddy Connect 已能从手机私有目录读取有效的插件自有登录副本。
3. 手机可以访问对应 WorkBuddy 计费上游；仅模型可用不保证计费接口一定可达。
4. Usage Dock 设置页开启 WorkBuddy 渠道。

国内版登录、国际版未登录可以正常显示国内版积分；无需两版同时登录。
一方版本因网络或认证问题取不到数据时，另一版本的积分照常展示，并以灰色脚注
标明未取到的版本（不会静默把部分合计当成完整合计）；两方都失败才显示错误。
WorkBuddy Connect 自带的移动 UI 不出现，不等于它的 Host 状态接口不可用。
不要公开上传认证文件、Cookie 或刷新令牌。

## 设置

进入「设置 → 内置插件 → Usage Dock」，更改后点击「保存更改」。配置通过 DSH 的
`Config` / `configForms` 托管到 profile Cordis patch，**不是独立 JSON 配置文件**。
Host 存在 `configEditor` 时读取最新配置（2 秒内复用）；缺少该服务的旧/移植宿主需重启引擎
才能让凭据和 Host 渠道开关生效。客户端显示过滤仍订阅表单实时变化。

| 渠道 | 配置字段 / 登录方式 |
| --- | --- |
| OpenCode Go | `apiKey`，留空回退模型凭据库 `OPENCODE_GO_API_KEY` |
| GLM Z.AI | `glmApiKey`，回退 `ZAI` |
| GLM 智谱 | `glmZhipuApiKey`，回退 `ZHIPU` / `GLM` |
| Kimi Code | `kimiCodeApiKey`；`kimiCodeCookie` 为可选增强字段 |
| DeepSeek | `deepseekApiKey`；账号服务可用时无需 Key；`deepseekWarnThreshold` |
| OpenAI Codex | 在 Codex Connect 中登录，无需在本插件填 Key |
| Xiaomi MiMo | `mimoCookie`（含 userId / serviceToken）、`mimoWarnThreshold` |
| WorkBuddy | 在 WorkBuddy Connect 中提供登录态，无需在本插件填凭据 |

MiMo Cookie 可在电脑浏览器登录控制台后，从开发者工具的请求头获取，再安全粘贴到安卓设置中。
Cookie 过期需要重新获取；`tp-*` / `ttp-*` 专用 Key 不支持此余额查询。

峰谷条按北京时间工作日 09:00–12:00、14:00–18:00 计算，周末及内置假日表为空闲时段。
假日表需随年份更新。本版保留 2px 柱与修正后的倒三角，光柱等候选仅在开发演示页保留，未实装。

## 卸载

```sh
dsh plugin --profile web remove dsh-usage-dock
```

MIT；沿用上游许可证。
