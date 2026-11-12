# MiMo 账号 SSO 固定浏览器请求头候选 · 窄终审（2026-11-09）

> 范围：**只审 `secure-transport.js` 的 SSO 内部 header profile 差异 + 单文件原子部署脚本**。
> 未重审 B/SSO/CAS、未跑大矩阵、未联网、未读真实 cfg/record/browser/creds/log/账号。
> 实机事实：17:20 safe 摘要 = `header / 302 / https / fe/service/login`，`ACCOUNT_OTHER` —— 服务端返回**登录前端**而非平台票；
> 说明没有无交互换到平台票，**不能**说丢记录/已过期。用户明确只批准「账号 SSO 固定非 secret UA/Accept/Accept-Language 一次兼容试装」，
> 不 follow 登录页、不扩目标、不新增 diag；**不是根因已证**。

## 0. 结论

**Pass（仅本次 header profile 差异 / 合成范围）**。未发现阻断；三条非阻断观察见 §3。

## 1. 版本（实算）

| 项 | SHA-256 |
| --- | --- |
| `secure-transport.js`（新/final） | `811A4F26…86A961F9` |
| 已装（old） | `91F8DEA8…6DA56CE` |
| 新测试 `tools/test-mimo-console-sso-headers.mjs` | `0622EAC1…708142E9` |
| `deploy-sso-headers.mjs`（实算） | `4F29A8DA…3703159A`（stage1 后未变） |
| `plan.json`（实算，final） | `3775AC66…7918CE06`（finaltrue/pending/approvedfalse） |
| stage `plans/mimo-auth/secure-transport.js` | `811A4F26…86A961F9`（30,844 B，= source = targetNew） |
| helper（复用） | `A187A1D7…78CE3D3`（未改） |

其余 16 项 + `package.json`/`plans/mimo.js` 未改（已装 protocol `20A7…`、controller `B229…`、routes `A99D…`、client `113C…`、
grants `6AA…`、store `E05…`）。plan：write 1（secure-transport whole-file）/ verify 16 + 2 meta / old `91F8…` → new `811A…` /
approved:false；base = handoff 的 `INSTALLED-MANIFEST.json`（17/complete/deployed，已与磁盘一致）。

## 2. 差异核对

1. **注入面只在 `consoleAccountSso`**：`fetchConsole` 先用 `freezeEffectiveReq(req)` 冻结原请求，再做 grant 预验与
   `consoleTarget`，然后 `sanitizeHeaders(eff.headers)`；**仅当 `eff.purpose === 'consoleAccountSso'`** 才
   `merged = {...callerHeaders, ...SSO_BROWSER_HEADERS}`，并以**原冻结 eff** 重建 `active`（`{...eff, headers: merged,
   assertAuthorized: () => eff.assertAuthorized()}`），随后所有 `check()`、DNS 解析、`requestOnce` 都用 `active`；
   实际发送 headers 为 `active.headers`（`secure-transport.js:729-749`、`:643`）。
2. **固定值、非动态、非本机读取**：`SSO_BROWSER_HEADERS` 是三个字面常量（accept / accept-language / user-agent），
   代码无 `os`/`navigator`/env/配置读取；plan 明确 `noBrowserProfileRead`。
3. **caller 不能借 profile 注入**：`sanitizeHeaders` 仍只允许 `accept` 与 `cookie`，`authorization`/`host`/`connection`/`te` 等列入拒绝，
   任意 `user-agent`/`accept-language` 等**在 merge 之前就 throw**（0 DNS、0 请求）。因此 3 个固定头只能由 SSO 分支产生。
4. **Cookie 逐字保留**：`merged` 只覆盖 accept（固定值），cookie 来自 `callerHeaders` 原值；无 decode/重编码；
   `validateCookieHeader` 仍按 purpose 校验（SSO required），未放宽。
5. **授权一致性**：`active.assertAuthorized` = 原 `eff.assertAuthorized()`（对**原** caller headers 的 grant 复审） **&&**
   `validateGrant(grant, active)`（对 merged headers 的复审）；`check(active)` 在 DNS 前后、request 前后都跑；
   原 7 purpose / URL 派生 / credentialClass / UID / MFA / nonce / 目标 / 预算 / 次数 / 无自动重试均未变。
6. **非 SSO 与 legacy 不变**：其它 6 个 console purpose 与 `longPoll`/legacy 仍走 `sanitizeHeaders` 结果，不注入；
   `requestOnce` 对非 SSO 传 `callerHeaders`（与旧实现同一份 sanitize 输出）。
7. **测试覆盖（作者，全 fake）**：SSO 三固定值 + exact Cookie + 无其它头；非 SSO 不注入且大写 Accept 归一；
   caller UA/Lang/Host/Auth/secHint/重复 Cookie 拒 0 DNS；无 grant/错 purpose/过期/预 cancel 拒；DNS await 后 headers 不变；
   realKernel 3 hop + 余额成功率与「固定返回 302 account/fe/service/login 仍拒、safeSummary 保留、0 callback/0 balance」。
   作者明说 mock 不按「有 UA 才成功」造假因果，baseline 只证明 shape 缺失，不是 vendor 复现。

## 3. 非阻断观察

1. `check(active)` 会同时触发「原 eff 的 host assert」与「active 的 grant 复审」两次验证；两次用的 headers 不同是刻意的
   （原 caller headers 仍要被验），只是多一次开销。
2. UA 模板是**公开仓库的固定字面**，会随 Chrome 版本老化；若厂商以后按版本拒绝，这是维护点，不是本次缺陷。
3. 本包只改传输层 header 形状；**若服务端仍返回登录页，说明仅 header 不是充分条件**——按用户要求应停止盲改，不扩 diag。

## 4. 未证与不主张

- **不主张根因已证/登录已修**：这是有公开参考的头组合候选；成功与否要等本人用 existing record 恢复一次。
- 未读真实 browser/OS/cfg/creds/log，未发真实账号请求；未跑 transport 20 / grants 18 / redirect 6 的全量（作者称已各过一次）。
- 部署脚本仍是**草案 hash**（`4F29A8DA…`），C2 回真实 stage/plan hash 后我只确认该 1 文件 gate 与版本一致性。

## 5. stage1 定稿（关包）

实算 3/3 一致、stage 目录恰 1 个 stage 文件、目标仍 `91F8…`（**0 写**）：
stage `secure-transport.js` = `811A4F26…86A961F9`（30,844 B，= workspace 源 = expectedSource）；
`deploy-sso-headers.mjs` = `4F29A8DA…3703159A`；`plan.json` = `3775AC66…7918CE06`（finaltrue/pending/approvedfalse）；
helper 仍 `A187A1D7…78CE3D3`。作者 dry-run：`ready=YES checks=12 fail=0 staged=1 exit=0`（只作参考）。

**最终判定：Pass（仅本次 header profile 差异 / 合成范围）**，安装仅待主代理置 `deployApproved=true` 后执行这 1 个文件。
成功与否仍取决于服务端是否接受该固定头组合，需本人 existing record 恢复一次验证；若仍返回登录页，按约定停止盲改。

