# dsh-usage-dock（Slacom 定制版）

DeepSeek Harness（DSH）的**套餐用量角标**插件：在 Web 界面**左侧状态栏底部**显示各
AI 套餐的用量与余额，点击可展开详情面板。

> **本插件 fork 自 [`chendefine/dsh-plugins-plan-usage`](https://github.com/chendefine/dsh-plugins-plan-usage)
> （上游包名即 `dsh-plan-usage`），为免与上游混淆已更名为 `dsh-usage-dock`。**
> 不依赖任何 DSH 核心包补丁，可直接用 GitHub 安装，DSH 升级不会让它失效。

## 支持的渠道

| 渠道 | 数据源 | 显示内容 |
| --- | --- | --- |
| OpenCode Go | `opencode.ai/zen/go/v1/usage` | 5小时 / 周限 / 月限 |
| GLM Z.AI（国际版） | Z.AI monitor 接口 | 5小时 / 周限 / 月限 + 套餐等级 |
| GLM 智谱 | 智谱 monitor 接口 | 同上 |
| Kimi Code | `api.kimi.com`（可选 Cookie 增强月限） | 5小时 / 周限（+ 月度会员额度）|
| DeepSeek 官网 | `api.deepseek.com/user/balance` | ¥余额，低于 ¥30 红灯 |
| OpenAI Codex | 复用 `dsh-codex-connect` 的 ChatGPT OAuth | 剩余额度（5小时 / 周限）|

用量每 **30 秒**自动刷新；侧栏折叠时只显示状态圆点。

## 安装

### 前提条件

- DSH `0.1.5` 或更高
- **Windows：需要安装 Python**（原因见下）

### 一条命令

```powershell
dsh plugin --profile web add github:Slacom/dsh-usage-dock
```

安装后**重启 `dsh web` 进程**，浏览器硬刷新（Ctrl+Shift+R）。

## 为什么 Windows 需要 Python

DSH 的 Windows ACL 沙箱以受限令牌启动子进程；受限令牌下 Windows 的 TLS 栈（schannel）
无法获取凭据，报 `SEC_E_NO_CREDENTIALS`。而 Windows 自带的 curl.exe 全部走 schannel
后端，因此在沙箱内 **curl 无法访问任何 HTTPS 接口**（HTTP 正常，仅 TLS 失败）。

插件因此随附 Python 取数脚本 `plans/http-fetch.py`（Python/OpenSSL 在沙箱内可用）。
请求规格通过**环境变量**传递，**API Key 不会出现在命令行里**。

如果 curl 可用（Linux / macOS，或未受该限制的 Windows），插件会**自动改用 curl**——
两个后端谁先成功就被记住，无需手工配置。

## 配置

打开「**设置 → 插件 → 套餐用量**」，可分别开关各渠道并填写 API Key：

| 渠道 | 配置项 | 说明 |
| --- | --- | --- |
| OpenCode Go | `apiKey` | 留空则回退到「设置 → 模型」中的 `OPENCODE_GO_API_KEY` |
| GLM Z.AI | `glmApiKey` | 回退 `ZAI` |
| GLM 智谱 | `glmZhipuApiKey` | 回退 `ZHIPU` / `GLM` |
| Kimi Code | `kimiCodeApiKey` + `kimiCodeCookie` | Cookie 可选，用于月度会员额度 |
| DeepSeek 官网 | `deepseekApiKey` | 回退 `DEEPSEEK_API_KEY` |
| OpenAI Codex | 无需填写 | 需先安装并登录 `dsh-codex-connect` |

## 与原版的差异（定制内容）

1. **显示位置**：右下角悬浮 → **左侧状态栏**（注册进官方公共席位 `sidebar.footer.action`，
   与「更新 / 远程控制」等按钮同行；无需修改 DSH 核心文件）
2. **新增 DeepSeek 官网余额**：`plans/deepseek.js`，显示 `¥xx.xx`，低于 ¥30 红灯
3. **新增 OpenAI Codex 订阅额度**：`plans/codex.js`，复用 `dsh-codex-connect` 公开的
   脱敏额度 API（`readOpenAICodexRateLimits`），**不读取、不复制、不回传任何 token**
4. **取数后端自适应**：Python shim ⇄ curl 自动选择（见上）
5. **刷新间隔**：60 秒 → **30 秒**

## 更新

```powershell
dsh plugin --profile web remove dsh-usage-dock
dsh plugin --profile web add github:Slacom/dsh-usage-dock
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-usage-dock
```

## 与上游的关系

本插件是 [`chendefine/dsh-plugins-plan-usage`](https://github.com/chendefine/dsh-plugins-plan-usage)
的 fork。上游包名为 `dsh-plan-usage`，为避免与上游仓库混淆，本 fork 更名为
**`dsh-usage-dock`**（"用量停靠栏"）。

内部的插件 id、settings 命名空间（`plan-usage`）与 HTTP 路由（`/api/plan-usage`）均**沿用上游**，
因此从上游版本切换过来时，**已有的 API Key 配置不会丢失**。

## 许可

MIT（沿用上游许可证，见 `LICENSE`）。上游作者：chendefine。
