# dsh-usage-dock

DeepSeek Harness（DSH）的**套餐用量角标**插件：在 Web 界面**左侧状态栏底部**显示各
AI 套餐的用量与余额，点击可展开详情面板。

> **本插件 fork 自 [`chendefine/dsh-plugins-plan-usage`](https://github.com/chendefine/dsh-plugins-plan-usage)
> （上游包名即 `dsh-plan-usage`）**


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
- **Windows：需要安装 Python**（DSH 沙箱内 curl 无法完成 TLS 握手，插件会改用随附的 Python 脚本取数；curl 可用时自动走 curl）

### 一条命令

```powershell
dsh plugin --profile web add github:Slacom/dsh-usage-dock
```

安装后**重启 `dsh web` 进程**，浏览器硬刷新（Ctrl+Shift+R）。


## 配置

打开「**设置 → 插件 → 套餐用量**」，可分别开关各渠道并填写 API Key：

| 渠道 | 配置项 | 说明 |
| --- | --- | --- |
| OpenCode Go | `apiKey` | 留空则回退到「设置 → 模型」中的 `OPENCODE_GO_API_KEY` |
| GLM Z.AI | `glmApiKey` | 回退 `ZAI` |
| GLM 智谱 | `glmZhipuApiKey` | 回退 `ZHIPU` / `GLM` |
| Kimi Code | `kimiCodeApiKey` + `kimiCodeCookie` | Cookie 可选，用于月度会员额度 |
| DeepSeek 官网 | `deepseekApiKey` | 回退 `DEEPSEEK_API_KEY` |
| OpenAI Codex | 无需填写 | 针对 [`dsh-codex-connect`](https://github.com/franksong2702/dsh-codex-connect) 社区插件进行适配|


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
的 fork。


## 许可

MIT（沿用上游许可证，见 `LICENSE`）。上游作者：chendefine。
