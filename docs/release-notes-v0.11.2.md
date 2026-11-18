# dsh-usage-dock 0.11.2

> 上一公开版：**0.11.1**。本版把手机端（DSH Go）这轮的适配收进来，并让 **MiMo 支持 API Key 直接查余额**。

## 更新摘要（GitHub Release 正文）

- **手机端可以一键完成 Codex 订阅适配**：设置页的 Codex 分组在需要适配时直接给「一键适配」按钮，
  点完提示重启引擎；不支持或文件与基线不符时给出明确说明，不再只留一句「需适配」。
- **Codex 额度只看 5 小时与周**：上游偶尔返回的「月额度」是噪音，界面不再显示空白的月行。
- **MiMo 支持 API Key 查余额**：像 DeepSeek 一样在设置里填普通 API Key（`sk-…`）即可，
  不再依赖扫码登录；原来的控制台 Cookie 配置仍然可用（填了 Key 就优先用 Key）。
- **打开额度面板时 MiMo 不再显示「没有数据」**：登录态还在恢复时显示「正在读取…」，恢复后自动出数值。
- **桌面设置页的「需适配」说明更准确**：现在会区分「本插件没收录这个版本」与
  「本机文件与已知基线不一致」，并列出已收录的版本。
- Web / 桌面端其余行为不变。

## 工程细节（维护者用）

### DSH Go 原生半：Codex 一键适配（来自手机端 0.11.2 包）

- Host：新增 `codexAdaptStatusForNative()`（只读，五态 `hidden` / `appliable` / `pending` /
  `unsupported`，fail-closed）与 `applyCodexPatchOnce()`；`POST …/apply-patch` 路由改为调用它，
  与原生按钮**共用同一实现**（`wx` 备份 → 临时文件 → 读回校验 → rename → 校验新哈希）。
- 原生设置页：`codexAdaptNodes()` 在 Codex 分组渲染（appliable 才给按钮）；
  `settingsActions.codexAdapt` 成功后 `refresh` 重建设置视图。
- 新增 `plans/patches/codex-subscription-3.2.23.json`（**不继承**的完整 4 条 hunk），
  `covered` 变为 `3.2.6 / 3.2.13 / 3.2.17 / 3.2.23`。
- 网页设置页：修正 `codexPatchUnsupportedText()` 的分支顺序——`manifestVersion === null`
  现在按「无匹配清单」处理（并列出已收录版本），不再被兜底句吞掉。

### Codex 不再显示月额度

- `plans/codex.js#normalizeCodexUsage`：`monthlyUsage` 恒为 `null`（仍解析一次用于「是否全空」判断）。
- 原生面板：`CHANNEL_PRESENTATION.codex` 声明 `scopes: ['rolling-5h','weekly']`，
  `channelBlock` 按 `slotsFor(presentation)` 渲染。

### MiMo：API Key 余额通道（新）

- `plans/mimo.js`：新增配置 `mimoApiKey`（`role('secret')`）与 `fields.apiKey`；
  `fetchApiKeyBalance()` 调 `GET https://api.xiaomimimo.com/v1/platform/balance`，
  请求头 `api-key: sk-…`；`balance = cash_balance + gift_balance`（**不含**授信额度），
  明细 `cashBalance` / `giftBalance` / `creditAvailable`，`via: 'api-key'`。
- `fetchPlan()`：有 Key 走 API Key，否则回退旧的 Cookie 通道（存量配置不破坏）。
- 错误分类：上游 401/403（`invalid_api_key`，被 `curlJson` 归为 `error:'api'`）→
  「MiMo 拒绝了这个 API Key（可能无效或已失效），请到「设置 → Usage Dock」重新填写」。
- 身份指纹：`fields.apiKey` 已登记 ⇒ `identityOfChannel('mimo')` 自动加入 `key=`，
  换 Key 立即作废旧值与在途请求。
- `index.js#mimoWireReady()`：**配了 Key 就直接走 provider**（不吃扫码/Cookie 的显示快照），
  并保留首屏「等待恢复最多 3 秒」的行为（无 Key 时）。

### 验证（主代理实跑，全绿）

`test-mimo-api-key` **13**、`test-mimo-usage-lane` 63、`test-mimo-legacy-store` 12、
`test-dsh-go-native` **46**、`test-dsh-go-boundaries` 47、`test-dsh-go-strip` 17、
`test-codex-adapt-ui` **24**、`test-codex-patch-2323` 5（1 组跳过：本机未装该第三方包）、
`test-codex-patch-ui` 35、`test-codex-source-ui` 91、`test-codex-sources` 89、
`test-patch-codex-subscription` 49、`test-settings` 17、`test-footer-row` 12、
`test-android-compat` 14、`test-degrade-refresh` 44、`test-usage-tool` 108、
`test-usage-tool-register` 70、`test-usage-policy` 89、`test-workbuddy-gateway` 39、
`test-route-normalize` 7、`test-line-endings` 71。

### 已知未做 / 边界

- MiMo 的 Token Plan 余量（`credits-get`）与日用量（`consumption-get`）未接入界面。
- 旧的扫码/Cookie 通道保留为回退，未退役（用户尚未决定）。
- 手机真机未复验（本轮为离线测试 + 主代理实跑）；原生面板视觉仍需用户确认。
- `3.2.23` 清单未在本机真打（本机装的是 3.2.17，已按 3.2.17 打补丁）；清单结构由
  `test-codex-patch-2323` 的静态断言守门。

---

版本状态：`0.11.2`。
