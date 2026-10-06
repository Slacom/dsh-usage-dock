# dsh-usage-dock

[![npm version](https://img.shields.io/npm/v/dsh-usage-dock.svg)](https://www.npmjs.com/package/dsh-usage-dock)
[![license](https://img.shields.io/npm/l/dsh-usage-dock.svg)](https://github.com/Slacom/dsh-usage-dock/blob/main/LICENSE)

DeepSeek Harness（DSH）的**套餐用量角标**插件：在 Web 界面**左侧状态栏底部**显示各
AI 套餐的用量与余额，点击可展开详情面板。

> **本插件 fork 自 [`chendefine/dsh-plugins-plan-usage`](https://github.com/chendefine/dsh-plugins-plan-usage)
> （上游包名即 `dsh-plan-usage`）**

![效果预览：左侧状态栏底部显示 DeepSeek 官网余额与 OpenAI Codex 额度](https://raw.githubusercontent.com/Slacom/dsh-usage-dock/main/preview.png)

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

### 方式一：从 npm 安装（推荐）

```powershell
dsh plugin --profile web add dsh-usage-dock
```

也可以在 DSH 的「**设置 → 插件 → 添加插件**」中直接填入包名 `dsh-usage-dock`。

### 方式二：从 GitHub 安装

```powershell
dsh plugin --profile web add github:Slacom/dsh-usage-dock
```

安装后**重启 `dsh web` 进程**，浏览器硬刷新（Ctrl+Shift+R）。


## 兼容性

- **DSH 0.1.5+** 均可用。
- **DSH 0.2.0 起**：DSH 移除了 `ctx.settings.register(namespace, Schema)` 这套旧 API；
  本插件因此把配置改为**插件自有的 JSON 文件**（`$DSH_HOME/plan-usage.json`），
  不再依赖 DSH 的 settings 服务，可跨 DSH 版本稳定工作。
- 从 0.1.x 升级过来时，请在「设置 → 插件 → 套餐用量」里**重新填写各渠道的 API Key**
  （旧版把这些存在 DSH 的 `settings.yaml` 中，新版本不再读取该文件）。

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
dsh plugin --profile web add dsh-usage-dock          # npm 源
# 或
dsh plugin --profile web add github:Slacom/dsh-usage-dock   # GitHub 源
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
