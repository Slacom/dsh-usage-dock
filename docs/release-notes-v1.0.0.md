# dsh-usage-dock 1.0.0（2026-11-25）

> 定版版本。桌面端由用户测试通过；手机端此前试装的是较早测试包，1.0.0 尚未在手机真机验证。
> 详细边界见文末「已知限制」。

## 更新摘要

- **Codex 改为本插件自己的 ChatGPT 账号登录**：设备码登录，最多保存 8 个账户，单选生效；
  支持添加、重登、切换、移除，移除最后一个回到未登录。旧 `Codex Connect` / `Codex Subscription`
  来源退场，不再需要安装或维护第三方插件。
- **WorkBuddy 退场**：不再作为内置渠道，也不再有专用开关、积分口径和原生分组；
  如需继续使用，请通过「自定义余额渠道」添加。内置渠道收敛为 4 个：
  OpenCode Go、DeepSeek、OpenAI Codex、小米 MiMo。
- **MiMo 只保留 API Key 余额**：扫码登录、记住登录、控制台 Cookie 与 `mimo-login` 原生面板全部删除；
  支持插件里的 `mimoApiKey`，或复用「设置 → 模型」中的 MiMo Key。没有 Key 时固定显示未配置，
  不发起请求，也不会回退到 Cookie。
- **1.0.0 安全与一致性加固**：
  - MiMo 自动复用「设置 → 模型」Key 时校验来源，只信任 `https://api.xiaomimimo.com`；
  - Codex 额度响应带脱敏采集代次，外部切换账户后网页立即作废旧显示与迟到响应；
  - 移除已经下线的 Codex 补丁 HTTP 写入口，避免运行时改写第三方插件目录；
  - 网页切换账户收到业务失败时显示固定错误提示，不再静默；
  - 移除最后一个 ChatGPT 账户改为原子空态写入，避免与并发新增账户互相覆盖。
- **DSH Go 原生半**：原生额度面板与设置页保留；原生设置页可查看并选择 Codex 账户，
  添加 / 重登 / 退出仍在桌面网页版设置页完成。`mimo-login` 面板已删除，原生清单只有
  `quota` / `settings`。
- **兼容性**：旧 Codex v1 单账户记录可读、写后升级为 v2；旧 WorkBuddy / MiMo Cookie 配置字段
  保留但不生效，不需要手动清理。

## 安装 / 升级

```powershell
dsh plugin --profile web add dsh-usage-dock
```

或按 DSH Go 的插件安装流程安装 npm 包 / 本地 tgz。升级后重启 DSH 并硬刷新页面。

## 重要前提

1. Codex 额度来自 `GET https://chatgpt.com/backend-api/wham/usage`，这是 Codex 客户端使用的
   内部接口，OpenAI 未承诺第三方使用，可能随上游改版失效。
2. 本实现使用 Codex CLI 公开的 OAuth 流程与公开客户端 ID，不是 OpenAI 授权的第三方集成；
   不愿承担账号条款风险时可以在插件里关闭 Codex 渠道。
3. access / refresh token 只存在 Host 侧本插件私有凭据记录中，不下发浏览器、不写配置、
   不进入 `usage_status` 工具字段。
4. 账户之间不合并：胶囊与详情只有一行 Codex，只显示当前选中账户的数字。

## 已知限制

- **手机端尚未验证 1.0.0**：桌面端已由用户测试通过；手机端此前试装的是较早测试包。
  手机原生设置页只能查看 / 选择 Codex 账户，不能完成登录、重登或退出；这些操作需在桌面网页版完成。
- **多账户真实场景覆盖有限**：最多 8 个账户、切换、移除 active、移除最后一个等只有离线测试；
  真实账号目前主要验证过单账户登录。真实设备码登录、令牌刷新、跨客户端轮换 token 仍需实际使用观察。
- **Codex 额度接口可能变化**：上游结构或鉴权变化时显示固定失败状态，不会猜测数值。
- **MiMo 自动复用 Key 只信任 `api.xiaomimimo.com`**：自建 Xiaomi 代理不会自动取 Key；
  可在插件里显式填写 `mimoApiKey`，或使用固定候选名。
- **Host 热重载边界**：Codex 额度代次以 Host 进程内的账户 epoch 为准；Host 半重启后若浏览器页面
  长期不刷新，极少数情况下可能把新代次当作旧代次，刷新页面即可恢复。
- **最后账户空态记录**：移除最后一个 ChatGPT 账户后，凭据服务里会保留一条 0 账户的本插件私有
  记录（所有插件读路径都视为未登录），用于避免并发删除竞态。
- **DSH Go 原生视觉 / 真机渲染未在本版重新验收**：原生半只有离线契约测试。

## 工程细节（维护者用）

| 项 | 内容 |
| --- | --- |
| 版本 | `1.0.0` |
| 内置渠道 | OpenCode Go、DeepSeek、OpenAI Codex、小米 MiMo；WorkBuddy 已退场 |
| Codex 记录 | `dsh-usage-dock/codex`，kind `grant`；v2 `{version:2, activeAccountId, accounts:[…]}`，1..8 个账户；v1 读兼容、写后落 v2 |
| Codex 端点 | 设备码 / 轮询 / 兑换 / 刷新均走 `https://auth.openai.com/…`；额度 `GET https://chatgpt.com/backend-api/wham/usage` |
| MiMo | 唯一 API Key；`GET https://api.xiaomimimo.com/v1/platform/balance`，`api-key` 头；自动来源只信任 `https://api.xiaomimimo.com` |
| 原生清单 | `dshGo.contributes.panels` 只有 `quota` / `settings`；无 `mimo-login` |
| 已删除 | `plans/mimo-auth/**`（15 文件）、`plans/mimo-legacy-store.js`、`plans/workbuddy.js`、36 个 `test-mimo*` 与 6 个 WorkBuddy 套件、旧 Codex 补丁 POST 写入口 |
| 保留 | 只读 `GET /api/plan-usage/codex-subscription/patch-state`、`plans/codex-subscription-patch.js` 与清单、维护 CLI |
| 本轮测试 | **14 套件 892 项全过**：mimo-api-key 42 / codex-account-generation 28 / codex-account 267 / codex-account-host 47 / codex-account-ui 103 / dsh-go-native 55 / dsh-go-boundaries 29 / degrade-refresh 41 / settings 17 / settings-layout 30 / config-unwrap 22 / usage-tool 103 / review-fixes 40 / line-endings 68 |
| 未验证 | 手机 1.0.0 真机、真实多账户切换 / 满 8 个、跨客户端 refresh token、原生视觉 |
