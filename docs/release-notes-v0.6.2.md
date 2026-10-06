# dsh-usage-dock v0.6.2 — 移动端取数修复

> 本仓库的**首个 GitHub Release**。npm 上此前的发布版本为 `0.6.1`
> （`0.3.0` → `0.6.1` 之间的 `0.4.x` / `0.5.x` / `0.6.0` 未单独发布到 npm，
> 其内容已包含在本次发布中，见文末「累积变更」）。

---

## 一句话

**移动端（Android APK）上只用 DeepSeek API Key 时余额永远显示「获取失败」的问题已修复**：
取数不再依赖设备上是否装有 `python` / `curl`，改为在 DSH 的 Host 进程内直接用 Node 原生
`fetch` 请求。

## 问题现象

在平板（移动端 DSH，`com.dsharnessmobile`）上安装本插件后：

- 侧栏胶囊：`DeepSeek  获取失败`
- 详情面板：`upstream request failed（API Key 方式；账号侧：账号未登录）`
- 同一屏里的 **OpenAI Codex 却完全正常**（5 小时 / 周限都能读出百分比）

也就是说：API Key 已经正确解析到了，问题不在凭据。

## 根因

0.6.1 的取数实现是「**DSH shell 服务 + 外部命令**」，两个后端依次尝试：

| 后端 | 依赖 | 移动端现状 |
| --- | --- | --- |
| `python plans/http-fetch.py`（首选） | 设备上要有 `python` | ❌ 没有 |
| `curl`（兜底） | 设备上要有 `curl` | ❌ 没有 |

两个后端全部失败后，错误被统一折叠成一句 `upstream request failed`，用户完全看不出原因。

**反证（两条，都指向同一个结论）**：

1. Codex 是唯一**不经过 shell**、直接在 Host 进程里 `fetch()` 取数的渠道 —— 它在平板上正常；
2. 平板上「用 DeepSeek API Key 跑模型」本身就是**同一个 Host 进程**发往 `api.deepseek.com`
   的请求 —— 这说明该进程出网没有问题。

所以正确做法是把插件的请求也放回 Host 进程内，而不是去 shell 里找出路。

## 本次改动（0.6.1 → 0.6.2）

| 文件 | 改动 |
| --- | --- |
| `plans/util.js` | 取数后端顺序改为 **原生 fetch（Host 进程内）→ Python shim → curl**；只有在**传输层**失败（命令缺失 / DNS / TLS / 连接失败）时才换下一个后端，上游已给出 HTTP 或业务错误则立即返回，不再空耗一轮超时；首个成功的后端会被记住并复用 |
| `plans/util.js` | 失败信息具体化：点名后端、退出码与原因，并挖出 Node fetch 默认隐藏的 `err.cause` |
| `index.js` | shell 服务不可用时不再让整个路由返回 `503`，交给后端按可用性降级 |
| `tools/test-fetch-backends.mjs` | **新增** 8 项回归测试（含平板场景复现） |
| `README.md` / `AGENTS.md` | 前提条件去掉「必须装 Python」；把这两个坑写进对接文档第 5 节 |

### 适配与兼容性

- **不再需要 Python**：Windows 桌面端此前的硬前提（沙箱内 `curl` 的 TLS 不可用，
  只能靠 Python/OpenSSL）已解除。Python shim 与 `curl` 保留为兜底后端。
- **兜底仍有意义**：Node 原生 fetch **不读系统代理设置**。在必须经系统代理出网的环境里，
  首次请求会先失败一次（最多 10 秒），随后自动落到会读代理的 Python shim 并被记住，
  功能不受影响，只是首次稍慢。也可给 Host 进程加 `NODE_USE_ENV_PROXY=1`（Node 24+）让
  fetch 直接支持代理。
- **平台覆盖**：移动端（Android APK）、Termux、Windows 桌面端、普通 Web 部署共用同一套代码。
- **未受影响**：桌面端「DSH 账号余额优先（含赠金）、API Key 回退」的优先级不变；
  插件配置项与配置存储格式不变，**升级无需迁移、无需重填 Key**；依旧零 DSH 核心补丁。

### 可诊断性（本次一并改善）

失败不再是一句无信息量的话，而是会说明是哪个后端、什么原因：

```
upstream request failed（fetch: fetch failed (ENOTFOUND api.deepseek.com)）
upstream request failed（fetch: fetch failed (timeout after 10000ms)）
upstream request failed（fetch: exit 1: fetch failed (ECONNREFUSED 127.0.0.1:1)；python: exit 127: ...；curl: exit 127: ...）
```

## 验证

新增的回归测试可离线运行，8 项全部通过：

```powershell
node tools/test-fetch-backends.mjs
```

```
[PASS] T1 透传（Authorization/Cookie/自定义头/POST body，零 shell 调用）
[PASS] T2 无 shell 服务时仍可取数
[PASS] T3 全后端失败时错误消息含逐后端原因
[PASS] T4 真实上游（无效 Key）返回确定性鉴权错误，零 shell 调用
[PASS] T5 fetch 失败时 Python shim 兜底（确定性错误）
[PASS] T6 平板场景：DeepSeek API Key 正确读出余额 ¥11.38（零 shell 调用）
[PASS] T7 桌面端账号余额优先（20.50 + 赠金 5.00 = 25.50）且不发请求
[PASS] T8 全渠道（6 个）在无 shell / 无凭据时降级正常
```

其中 **T6** 就是本次故障的现场复现：没有账号服务、`python`/`curl` 全部不可用，
只给配置里的 API Key，断言余额被正确解析且**一次 shell 都没有调用**。

真实环境另有实测：同一端点下 `curl.exe` 报 `schannel: SEC_E_NO_CREDENTIALS`（沙箱 TLS 限制），
而原生 fetch 正常拿到上游响应；移动端升级后余额恢复显示。

## 升级方式

```powershell
# npm（推荐）
dsh plugin --profile <你的 profile> add dsh-usage-dock@0.6.2

# 或 GitHub 源
dsh plugin --profile <你的 profile> add github:Slacom/dsh-usage-dock
```

安装后**重启 DSH**，浏览器硬刷新（Ctrl+Shift+R）。移动端同理：更新插件 → 重启 App。

> 插件配置改动在 Host 侧生效需要重启，这是 DSH 的既有行为，与本版无关。

---

## 附：累积变更（自 npm 上一公开版本 0.3.0 起）

`0.4.x` / `0.5.x` / `0.6.0` 未单独发布到 npm，内容一并包含在 0.6.2 里：

| 版本 | 内容 |
| --- | --- |
| 0.4.0 | 恢复 `Config` schema 交由 DSH 托管设置页；DeepSeek 改为「账号余额优先、API Key 回退」；移除自建 `/config` 路由与 JSON 配置文件 |
| 0.4.1 | 所有 `Config` 字段补 `.volatile()`（DSH 设置表单只显示 volatile 字段，否则没有设置页）；胶囊展示账号余额失败原因 |
| 0.5.0 | 「设置 → 内置插件 → Usage Dock」独立设置页（`settings.plugins.tab` + `configForms`）；按 Remote 投影契约修正账号余额解析 |
| 0.5.1 | 绑定 `ConfigFormController` 的方法（修设置页白屏）；标签页更名 Usage Dock |
| 0.6.0 | 设置页「保存 / 放弃」草稿态；DeepSeek 余额警告阈值可配（`deepseekWarnThreshold`，默认 10 元，0 表示不警告） |
| 0.6.1 | 胶囊订阅 `configForms`：停用渠道即时消失（DSH 不会热重载插件配置） |
| **0.6.2** | **本版**：移动端取数修复（原生 fetch）+ 失败原因可诊断 + 回归测试 |

以上同时覆盖了 **DSH 0.2.0 的破坏性 API 变更**适配（`ctx.settings.register` 移除、
volatile 字段、`settings.plugins.tab` 席位、`sidebar.footer.action` 公共席位等），
细节记录在仓库 `AGENTS.md` 第 5 节。

## 相关链接

- npm：https://www.npmjs.com/package/dsh-usage-dock
- 上游项目（本插件 fork 自）：https://github.com/chendefine/dsh-plugins-plan-usage
- 许可：MIT
