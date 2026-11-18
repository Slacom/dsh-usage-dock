# dsh-usage-dock 0.11.3

> 上一公开版：**0.11.1**（0.11.2 仍是 pre-release）。本版把 MiMo 的 API Key 通道真正接通到
> 「设置 → 模型」里已有的 Key，并下线原生设置页的扫码入口。

## 更新摘要（GitHub Release 正文）

- **MiMo 直接用「设置 → 模型」里的 Key 查余额**：桌面端配了 `XIAOMI_API_KEY` 也能识别（此前只认
  `MIMO_API_KEY` 等三个名字，导致明明配了 Key 还显示未登录）；没固定名字时，还会按 provider 名
  （含 mimo / xiaomi）自动找到该来源的 Key。不用再扫码，也不用另填一份 Key。
- **原生设置页去掉「记住登录 / 扫码登录」**：MiMo 分组只保留开关、余额提醒与策略，并说明余额来自
  「设置 → 模型」的 API Key。
- 0.11.2 的其它内容不变（Codex 一键适配、Codex 只显示 5 小时 + 周、3.2.23 清单等）。

## 工程细节（维护者用）

- `plans/mimo.js`：`API_KEY_REFS` 增加 `XIAOMI_API_KEY`（首位）；新增 `providerKeyOf(ctx)`——
  用 `listProviderTargets(ctx)` 找出 provider id / displayName 含 `mimo|xiaomi` 的条目，
  读它的 `apiKeyEnv` 去凭据库取值（不解析地址、不联网）；新增导出 `hasMimoApiKey()`。
  `fetchPlan()` 的解析顺序：配置 `mimoApiKey` → 固定候选名 → provider 自动匹配；有 Key 即走
  `GET https://api.xiaomimimo.com/v1/platform/balance`（`api-key` 头）。
- `index.js#mimoWireReady()`：改为用 `hasMimoApiKey()` 判断，命中就**直接走 provider**，不吃扫码快照。
- `plans/dsh-go-native.js`：`CHANNEL_SECTIONS.mimo` 去掉 `mimoRememberLogin` 与 `mimoLogin: true`，
  改为渲染一行说明（`mimoApiKeyHint`）。
- 测试：`test-mimo-api-key` 增至 **17 项**（新增凭据库 `XIAOMI_API_KEY` 命中、`hasMimoApiKey`
  有/无凭据两组）；`test-dsh-go-native` 的 MiMo 分组断言改为「无扫码按钮 + 有 API Key 说明」。

### 已知未做

- 旧的扫码/Cookie 代码（`plans/mimo-auth/**`、`mimo-legacy-store.js`、`mimo-login` 面板）**仍留在
  仓库**，但界面已无入口、有 Key 时也不会被读取；彻底删除留作单独清理。
- 手机端没有输入框：Key 只能来自「设置 → 模型」（或 profile 的 `cordis.patch.yml` 手写 `mimoApiKey`）。

---

版本状态：`0.11.3`（pre-release）。
