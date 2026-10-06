# dsh-usage-dock — 项目对接文档

> 面向接手本项目的 AI agent / 开发者。**动手前先读完本文**，尤其是第 5 节的 API 契约，
> 那里记录的都是踩过的坑，重复踩会浪费大量时间。

---

## 1. 项目是什么

DeepSeek Harness（DSH）的**侧栏用量/余额插件**：在 Web/桌面端左侧状态栏底部显示各家 AI 套餐的
用量与余额，点击可展开详情面板。fork 自 `chendefine/dsh-plugins-plan-usage`，改名 `dsh-usage-dock`
以避免与上游混淆，并做了一系列定制（见第 6 节）。

**当前版本**：0.6.1　|　**已发布**：GitHub + npm　|　**已安装**：desktop profile

## 2. 关键路径

| 用途 | 路径 |
| --- | --- |
| **本项目（开发仓库）** | `E:\WorkSpace\DSH\DSH Usage Dock` |
| 已安装的插件副本 | `C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock` |
| DSH 桌面端本体 | `D:\DeepSeek Harness\resources\app.asar\dsh` |
| DSH CLI（桌面端自带） | `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 插件配置（DSH 托管） | `C:\Users\Slacom\.dsh\profiles\desktop\cordis.patch.yml` → `plan-usage` 条目 |
| GitHub | https://github.com/Slacom/dsh-usage-dock |
| npm | https://www.npmjs.com/package/dsh-usage-dock |

> ⚠️ `app.asar` 是 **121MB 的归档文件**，Node/PowerShell 等独立进程**无法**直接读里面的路径；
> 只有 DSH 运行时会注入 asar 支持。用 `dsh.cmd` 调 CLI，不要试图 `node <asar内路径>`。

## 3. 架构

```
index.js          Host 半：导出 Config schema、注册 /api/plan-usage 路由、编排各渠道取数
client.js         Browser 半：侧栏胶囊 + 「内置插件」里的设置页（单文件，零构建）
plans/index.js    渠道注册表（新增渠道只需在此登记）
plans/<渠道>.js   每渠道一个模块，统一接口 { id, name, fields, schema, source, fetch }
plans/util.js     共用工具：curlJson（含后端自适应）、窗口归一化、凭据解析
plans/http-fetch.py  Windows 沙箱专用取数脚本（TLS 走 OpenSSL）
cordis.patch.yml  插件向 profile 贡献的配置层（insert 一个 plan-usage 条目）
```

**已接入渠道**：OpenCode Go、GLM Z.AI、GLM 智谱、Kimi Code、DeepSeek（账号余额优先/API Key 回退）、OpenAI Codex。

## 4. 开发流程

```powershell
# 1) 在本仓库改代码（不要改 profile 里的副本！）
# 2) 部署到 desktop profile
Copy-Item "<本仓库>\index.js","<本仓库>\client.js" "C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock\" -Force
Copy-Item "<本仓库>\plans\*" "C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-usage-dock\plans\" -Force
# 3) 重启 DSH 桌面端（client bundle 在插件激活时缓存，改文件不会热生效）
# 4) 浏览器硬刷新 Ctrl+Shift+R
```

**本地自测**（无需重启，能在部署前抓出大部分错误）：

```powershell
# Host 端：语法 + 注册表 + 取数
node --check index.js; node --check client.js
node --input-type=module -e "const m=await import('./plans/index.js'); console.log(m.PLANS.map(p=>p.id))"

# 客户端：用 mock 的 require/React/ctx 加载模块并渲染页面组件（历史上抓到过两次真实错误）
# 见 docs/ 或直接照着旧测试脚本写：mock window.__ModuleLoader__ + React + ctx.slots/configForms
```

## 5. DSH 0.2.0 API 契约（★ 踩坑记录，务必先读）

DSH 0.2.0 相对 0.1.x 有**破坏性变更**，以下每一条都是实际踩过的：

| # | 坑 | 正确做法 |
| --- | --- | --- |
| 1 | `ctx.settings.register(ns, Schema)` **已被移除**（调用即启动失败） | 改为 `export const Config = z.object({...})`，DSH 据此托管配置 |
| 2 | DSH 的设置表单**只展示 `.volatile()` 字段**，没加就没有设置页 | 每个要展示的字段都加 `.volatile()`（本项目在 `planSchemaFields()` 里统一加） |
| 3 | 设置页 tab **不是自动生成**的，要自己注册 | 注册 `settings.plugins.tab` 席位并提供页面组件；参考 `dsh-codex-connect` |
| 4 | `ConfigFormController` 的 `getSnapshot/subscribe/set` **依赖 this**，直接传方法引用会丢 this → 页面白屏 | 包一层再传给 React（见 `useConfigSnapshot`） |
| 5 | 插件配置**运行时不热重载 Host 半**（官方提示「下次启动生效」） | 客户端订阅 `configForms` 做实时过滤，保存即生效 |
| 6 | 账号余额 Remote 返回的是**投影结构**，不是 Platform 原始响应 | `getBalance(client)` 返回 `null \| {status:"ready", value:[钱包], bonusWallets:[钱包]} \| {status:"failed"}` |
| 7 | 侧栏底部席位 | 用官方公共席位 `sidebar.footer.action`（list），**无需改 DSH 核心包** |
| 8 | 设置页读取的是 `entry.fiber.runtime.Config` | 插件必须导出 `Config`，且 loader 已激活该条目 |
| 9 | Windows 沙箱内 curl 无法完成 TLS 握手（`SEC_E_NO_CREDENTIALS`） | 用随附的 Python 脚本取数；`util.js` 已做 Python⇄curl 自适应 |

**账号余额调用方式**（Host 端）：

```js
const account = ctx.get("deepseekAccount")   // 服务名；仅在 Desktop 组合里存在
const summary = await account.getBalance({ version, locale, timezoneOffsetSeconds })
// summary.status === "ready" → summary.value / summary.bonusWallets
```

## 6. 相对上游的定制

1. **显示位置**：右下角悬浮 → 左侧状态栏（官方公共席位 `sidebar.footer.action`，零核心补丁）
2. **DeepSeek 双数据源**：DSH 账号余额优先（含赠金，无需 API Key），API Key 回退
3. **可配置余额警告额度**：`deepseekWarnThreshold`，默认 10 元，0 表示不警告
4. **OpenAI Codex 订阅额度**：复用 `dsh-codex-connect` 的公开额度 API，不碰 token
5. **独立设置页**：在「设置 → 内置插件 → Usage Dock」里勾选渠道、填 Key，带保存/放弃
6. **取数后端自适应**：Python shim ⇄ curl 自动选择
7. **刷新间隔**：60 秒 → 30 秒

## 7. 已知限制

- **Host 半仍会拉取已禁用渠道的数据**（它读的是插件加载时的配置）。不影响显示，只是有无谓请求；
  若在意，可让 Host 在每次请求时通过 `configEditor` 重读配置。
- 插件配置改动**需要 Host 侧生效时必须重启**；显示层的过滤已做到实时。
- `plans/http-fetch.py` 使 Windows 上**必须装 Python**（沙箱内 curl 的 TLS 不可用）。

## 8. 发布

```powershell
# 版本号（package.json）→ 提交 → 推送 → 发布
git -C "E:\WorkSpace\DSH\DSH Usage Dock" push origin main
npm publish   # 需在交互式终端输入 OTP；agent 无法代劳
```

> npm 发布需要 2FA 验证码，**agent 环境无法完成**（npm 会把认证链接脱敏成 `***`），必须由人执行。

## 9. 目录说明

| 目录 | 内容 | 是否入库 |
| --- | --- | --- |
| 根目录 | 插件本体（index/client/plans/package.json/…） | ✅ 会发布到 npm |
| `docs/` | 开发文档、安装指南、迁移记录 | ✅ |
| `tools/` | 辅助脚本（如 DSH 侧栏补丁重放） | ✅ |
| `legacy/` | 历史补丁包、旧备份仓库、诊断报告 | ❌ 仅本地（.gitignore 排除） |
| `reference/` | 第三方参考源码（如 dsh-codex-connect） | ❌ 仅本地 |

## 10. 历史脉络（简）

1. 最初是上游 `dsh-plan-usage` + Termux 侧栏补丁（见 `docs/plan-usage插件修改记录.md`）
2. 新增 DeepSeek 余额、Codex 额度；侧栏方案从「改 sidebar 核心包」改为「注册官方席位」（零补丁）
3. DSH 升级到 0.2.0 后适配了大量 API 变更（见第 5 节），改名 `dsh-usage-dock` 并发布 npm
4. 加入独立设置页、可配置阈值、保存/放弃按钮、实时配置过滤

---

*文档更新时间：2026-10-06*
