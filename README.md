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

用量每 **30 秒**自动刷新；侧栏折叠（rail）时只显示状态圆点，**此时不可点击**——
详情面板只在侧栏展开状态下点击打开（0.6.3 起）。

胶囊在侧栏底部**独占一行**：装了其他同样占用底部席位的插件（如 Remote）时，各自成行、
上下排列，互不挤压抢位（0.7.0 起）。

## 安装

### 前提条件

- DSH `0.1.5` 或更高
- **无需 Python、无需 curl**：插件在 Host 进程内直接用 Node 原生 fetch 取数（0.6.2 起）。
  随附的 `plans/http-fetch.py` 与系统 curl 仅作为兜底后端，只在原生 fetch 传输失败
  （例如必须经系统代理出网的环境）时才会被用到。

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

- **DSH 0.1.5+** 均可用，含**移动端 DSH（Android APK）**——0.6.2 起取数不再依赖
  设备上是否装有 python/curl。
- **DSH 0.2.0 起**：DSH 移除了 `ctx.settings.register(namespace, Schema)` 这套旧 API；
  本插件因此把配置改为**插件自有的 JSON 文件**（`$DSH_HOME/plan-usage.json`），
  不再依赖 DSH 的 settings 服务，可跨 DSH 版本稳定工作。
- 从 0.1.x 升级过来时，请在「设置 → 插件 → 套餐用量」里**重新填写各渠道的 API Key**
  （旧版把这些存在 DSH 的 `settings.yaml` 中，新版本不再读取该文件）。

## 设置页（0.5.0 起）

插件在「**设置 → 内置插件**」里拥有独立标签页（与 Codex Connect 并列），可直接勾选要显示的渠道、
填写各渠道 API Key。实现方式：客户端注册 DSH 的 `settings.plugins.tab` 席位，配置读写走
`configForms` 服务（命名空间即 profile 条目 id `plan-usage`），由 DSH 负责修订号校验与持久化。

### 可配置项

| 项 | 说明 |
| --- | --- |
| 启用套餐用量角标 | 全局开关 |
| 各渠道开关 | OpenCode Go / GLM Z.AI / GLM 智谱 / Kimi Code / DeepSeek / OpenAI Codex |
| 各渠道 API Key | 留空则回退到「设置 → 模型」凭据库中的同名凭据 |
| **DeepSeek 余额警告额度** | `deepseekWarnThreshold`，低于该值时状态灯转警告色；**默认 10 元**，填 0 表示不警告 |

设置页底部提供「放弃更改 / 保存更改」按钮，改动在保存后生效。

## 配置方式（0.4.0 起）

插件导出 `Config` schema，**DSH 会自动在「设置 → 插件」里生成本插件的设置页**，
改动由 DSH 持久化到当前 profile 的 Cordis patch。可配置项包括全局开关、各渠道开关，
以及 OpenCode Go / GLM / Kimi / DeepSeek 的 API Key（密钥字段在界面上按密码处理）。

### DeepSeek 余额的数据来源

插件按以下顺序取数，**账号优先**：

1. **DSH 账号余额**：桌面端登录 DSH 账号后，Host 的 `deepseekAccount` 服务读取 Platform 余额
   （正常余额 + 赠金一并计入）。**不需要 API Key，也不涉及 token**——账号控制器只暴露安全的余额投影。
2. **DeepSeek 开放平台 API Key**（回退）：账号未登录或该服务不存在的部署（如普通 Web）会走这条，
   请求 `api.deepseek.com/user/balance`。

胶囊里两者都显示为同一行「DeepSeek」，取数结果带 `via` 字段标明本次来源（`account` / `api`）。

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
