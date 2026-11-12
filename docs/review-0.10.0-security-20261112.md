# 0.10.0 发版前安全向终审（Max，2026-11-12）

> 范围：本轮已本地部署并经用户实机验证的 0.10.0 改动面。方式：**纯静态阅读** + `npm pack --dry-run --json`（只读，未生成 tgz、未上传）。
> 未部署、未重启、未联网、未读真实 cfg/凭据/record/env/log。未运行任何测试套件。

## 1. 一句话结论

**Pass（可发布，含 7 条非阻断观察）**：五个安全面均为「已核」，未发现外泄、凭据错投、越权或调试残留类阻断项。
需主代理知情的唯一实质问题是 **N1（MiMo 提示词 lane 与胶囊/工具不同源）** —— 属一致性/正确性偏差，不是安全事故。

## 2. 阻断项

**无。** 本轮未发现符合「会导致真实事故」标准的问题（无凭据外泄路径、无凭据发往非目标 origin 的路径、
`getHost()` 无外部可达写路径、产品文件无调试残留、包内容只含白名单文件）。

## 3. 非阻断观察

| 编号 | 内容 | 建议 |
| --- | --- | --- |
| **N1** | **MiMo 三条 lane 未完全同源**：`usage_status` 走显示快照（[index.js:2031](index.js#L2031)），客户端胶囊走 DTO overlay；但 **GUI 路由与提示词/策略** 仍走 `plans/mimo.js` 的旧 Cookie 取数（[index.js:1227](index.js#L1227) → `publishObservation` → `channelProjection`）。managed「记住登录」接管后界面显示「无数据/读取中」，提示词仍可能拿到旧 Cookie 余额或旧错误；旧 Cookie 也仍每 30 s 打小米。AGENTS §7「胶囊/详情/工具/策略共用同一份快照」的表述偏乐观 | Host 侧对 mimo 也先取 `mimoDisplayPeek()`（managed 接管时发布 absent），或在 GUI 路由把 mimo 与工具收成同一条 lane；发版说明同步口径 |
| N2 | **curl 后端把请求头放进命令行**（[util.js:167‑181](plans/util.js#L167-L181)：`-H 'Cookie: …'` / `-H 'Authorization: …'`），同机其它进程可见。仅当 fetch 与 python 都不可用时才走到；python shim 已改为走 `PLAN_USAGE_SPEC` 环境变量（[http-fetch.py:25](plans/http-fetch.py#L25)）。**既有代码，非本轮引入** | 后续把 curl 也改成 env/stdin 传头；在此之前避免在 curl-only 环境使用 Cookie/Key 渠道 |
| N3 | `getHost()` 返回**整个 auth host**（含 `manager` / `console` / `display` 及 start/read/grant/confirm/stop 等变更动作，[host.js:99](plans/mimo-auth/host.js#L99)、[707‑717](plans/mimo-auth/host.js#L707-L717)）。当前唯一消费方只用 `routeDisplay.peek()`（[index.js:353‑366](index.js#L353-L366)），managed 下变更动作本身固定拒绝 | 将来可只暴露只读门面（`{ peek }`），降低误用面 |
| N4 | `bootEpoch` 随**未鉴权**的 `/api/plan-usage` 一起下发（[index.js:1277](index.js#L1277)）。owner 准入由 SDK 传输层负责，`bootEpoch` 仅用于防陈旧；当前不构成越权 | 若将来把 `bootEpoch` 当凭据用，必须先把它从普通路由移除 |
| N5 | `plans/mimo-auth/vendor/*.js` 的注释引用了已删除的 `tools/poc/**` 路径（[cookie-jar.js:4](plans/mimo-auth/vendor/cookie-jar.js#L4)、[memory-flow.js:2](plans/mimo-auth/vendor/memory-flow.js#L2)），包内读者看不到该目录 | 纯注释，可留；下次整理时改成「源自冻结夹具」 |
| N6 | `plans/workbuddy.js` 的 `fetchStatus` / `fetchPlanWithBase` / `setWebBase` 在运行期已成死码（`index.js:1108` 仍调 `setWebBase`，但无人读）：不会发请求，仅为历史回归保留 | 下次清理时删除或显式标注 deprecated |
| N7 | `.diagnostics/release-0.10.0/preflight.md` §2/§4 的包体数据**已过期**：文档写 44 文件 / 469.6 kB / shasum `1addd024…`，实测为 **40 文件 / 463484 B / shasum `4e85dc43…`**（退场模块已删） | 发版核对按实测值，或先更新 preflight 再照它执行 |

## 4. 逐面核对

| 面 | 结论 | 依据（静态） |
| --- | --- | --- |
| **秘密外泄**（wire / 路由 / 工具输出 / 错误文案 / 日志） | **已核** | `/api/plan-usage/codex-sources` 只回 `id/label/enabled/compatible/selected`（[index.js:1380‑1413](index.js#L1380-L1413)）；`usage_status` 白名单重建、`mimoDisplayWire` 只出 `balance/currency/fetchedAt`、快照的 `identity/accountId/code` 一律不透传（[usage-tool.js:517‑543](plans/usage-tool.js#L517-L543)）；`projectPlan` 错误分支 `message` 恒 null、码走闭集（[usage-tool.js:189‑210](plans/usage-tool.js#L189-L210)）；WorkBuddy 全部失败文案为固定分类，`preview`（正文前 120 字）**采集但从未进入 wire**（[workbuddy.js:717‑747](plans/workbuddy.js#L717-L747)）；MiMo display DTO 只给 `identity.maskedLabel`；产品文件 0 处 `console.*` / `DSH_DIAG` / `process.env.*DEBUG` / `debugger` / TODO / FIXME。唯一 argv 例外见 N2 |
| **凭据发往错误目标** | **已核** | 自定义余额：DNS 结果全公网校验 + `makeLookup` 连接期钉扎 + `servername` 保留域名 + `redirect:'error'` + 256 KiB 上限 + 全局无 `rejectUnauthorized:false`（[custom-balance.js:1394](plans/custom-balance.js#L1394)、[2000‑2006](plans/custom-balance.js#L2000-L2006)、[2122‑2124](plans/custom-balance.js#L2122-L2124)）；`credentialHost` 未确认即零请求（[2476‑2493](plans/custom-balance.js#L2476-L2493)）。WorkBuddy：地址必须 https 或本机回环 http（`allowLoopbackHttp` 仅此一处传，[workbuddy.js:566‑575](plans/workbuddy.js#L566-L575)），URL 由 `origin + '/v1/credits'` 单向拼出、`redirect:'error'`、只带 `Authorization/accept/accept-encoding`（[609‑617](plans/workbuddy.js#L609-L617)、[691‑701](plans/workbuddy.js#L691-L701)）。Codex connect 仍只调公开 SDK、不读 token/不碰凭据文件（[codex.js:216‑245](plans/codex.js#L216-L245)）；订阅来源零网络、`readUsage` 只传 `{signal}`。MiMo 旧 Cookie 只发固定 `platform.xiaomimimo.com` 端点（[mimo.js:27](plans/mimo.js#L27)）；`secure-transport` 只放行 `accept`/`cookie`、显式拒 `authorization`/`host`、TLS 校验恒开（[secure-transport.js:390‑395](plans/mimo-auth/secure-transport.js#L390-L395)、[647](plans/mimo-auth/secure-transport.js#L647)） |
| **越权 / 状态混淆** | **已核**（偏差见 N1/N3/N4） | `getHost()` 无外部可达写路径：唯一消费方只读 `routeDisplay.peek()`，managed 下 start/read/grant/confirm/stop 全部固定拒绝（[host.js:282‑303](plans/mimo-auth/host.js#L282-L303)），`peek()`/`displaySnapshot()` 为纯读（[remembered-session.js:442](plans/mimo-auth/remembered-session.js#L442)）；`mimoDisplayWire` 只认 `selected===true` + `verified` + 有限非负数 + 合法币种，其余一律 `missing`，A 会话值不会被当成 B（且不回落旧 cookie）；`mimo` 已进 `ACCOUNT_BOUND_PLAN_IDS`（[index.js:94](index.js#L94)）⇒ identify/工具缓存都不采纳，30 s 成功缓存不会跨身份复用；Codex 两来源严格单分派、零 fallback（[codex.js:311‑316](plans/codex.js#L311-L316)），`codexSource` 进观察身份（[index.js:621‑624](index.js#L621-L624)） |
| **调试残留** | **已核** | `index.js` / `client.js` / `plans/**`：`console.*` 0 处、`DSH_DIAG*` 0 处、`process.env.*DEBUG` 0 处、`debugger` 0 处、TODO/FIXME 0 处、`window.__DSH_DEBUG`/debug 面板 0 处；唯一 `window.__` 是 DSH 必需的 `__ModuleLoader__.load`（[client.js:32](client.js#L32)）。两个 `process.env` 读点均非调试门控：`DSH_USAGE_DOCK_ALLOW_LEGACY_CUSTOM`（自定义旧条目，默认 false，[custom-balance.js:2694‑2701](plans/custom-balance.js#L2694-L2701)）与 `SystemRoot/WINDIR/PATH`（DPAPI 子进程最小环境，[windows-dpapi.js:225‑229](plans/mimo-auth/windows-dpapi.js#L225-L229)） |
| **包内容卫生** | **已核** | `npm pack --dry-run --json`：**40 文件 / 463484 B / shasum `4e85dc43f73c3e25678c5ce28949d95f82f2dd03`**，全部为 `package.json` + `index.js` + `client.js` + `plans/**` + `cordis.patch.yml` + `README.md` + `LICENSE`；**无** `tools/`、`.diagnostics/`、`legacy/`、`reference/`、任何 `*test*`、tarball、临时文件（`plans/mimo-auth-test.txt` 已不在包内）。`plans/**` 中运行时 `import` 的相对路径 **0 处不可解析**；无硬编码本地路径 / 用户名 / profile 路径；无夹具或 `tools/poc` 运行时依赖（仅 vendor 注释提到，见 N5） |

## 5. 未验证边界（不得据此声称）

1. **未运行任何测试**（本轮只读）；preflight 记录的 5 条已知失败与 3 条待定项**未复核**，它们属于功能面，不构成本轮安全结论的一部分。
2. **未上传、未发布**：`npm pack` 为 `--dry-run`，只核对清单与 shasum，未生成 tgz。
3. **未在真机验证**：MiMo「记住登录」链路（QR/批准/DPAPI 解密/墓碑）、WorkBuddy `/v1/credits` 实取、Codex Subscription 只读 service（第三方本地补丁**不在本包**，Host 只按合同消费）——以上均依赖真实运行环境。
4. **未验证 Linux/macOS 的 curl 兜底后端行为**（N2 的实际暴露面取决于是否走到 curl）。
5. 未验证 DSH 宿主 `loader.entries()` / `entry.disabled` 语义、`ctx.provide` 同名冲突（沿用 0.10.0 前一轮结论，属安装时检查项）。
6. 本轮只覆盖题面五个面；W1–W3 / X1–X2 / 方向 6 等既有链沿用此前结论，不重新背书。
