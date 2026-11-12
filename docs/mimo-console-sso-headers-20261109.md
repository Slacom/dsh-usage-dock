# SSO 固定浏览器请求头模板（2026-11-09）

实机 17:20 安全摘要：`header / HTTP 302 / https / fe / service / login`，仍是 `ACCOUNT_OTHER`（账号登录前端）。
本包**只做一次兼容性请求头试装**：把公开 console 实现里固定的浏览器头模板用于 `consoleAccountSso`，
**不宣称**因果已证或 70016/登录页问题已解决。

## 行为（仅 `secure-transport.js`）

- 仅 `purpose === 'consoleAccountSso'` 时，在**内部**把三项固定模板并入实际请求头：
  - `accept: application/json, text/plain, */*`
  - `accept-language: en-US,en;q=0.9`
  - `user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36`
- 固定跨平台模板，**不读取/不冒充**本机真实 browser info；不添加 `sec-ch-ua`/`Origin`/`Referer`/
  `x-timezone`/device/sdkVersion/snsNone。
- **未扩对外 header 白名单**：`sanitizeHeaders` 仍只允许 `accept`/`cookie`，caller 传入 UA/AcceptLang/Host/Auth
  等即使固定值也在 DNS 前拒绝；这些头只能来自本文件内部常量。
- 顺序保持：原 `freezeEffectiveReq` → 真 grant + consoleTarget 先验 → `sanitizeHeaders` → 仅 SSO 合成最终冻结
  headers（Cookie 原串不变）→ 以**原冻结 eff** 重建最终 eff（`assertAuthorized` 捕获原 eff，未重读可变 req）
  → 再 `check`/DNS pin/TLS/单次请求；实际发送时 **仅 SSO** 用 `active.headers`（最终冻结且受授权检查的那份），
  **其它用途仍用 `sanitizeHeaders` 的 `callerHeaders`**（header 名小写规范化、Accept 重复处理与旧版一致）。

## 验证（全 fake）

- 新套 `tools/test-mimo-console-sso-headers.mjs`：**6 passed / 0 failed，exit 0**
  （SSO 实际三项+精确 Cookie、无 Origin/Referer/sec-ch-ua；其它用途不注入；caller 任意 UA/accept-language/host/auth/
  sec-ch-ua → 0 DNS/0 请求；无 grant/错 purpose/过期/预取消 0 请求；DNS await 中改 `req.headers` 实际 cookie/profile 不变；
  **真实 kernel 3 hop+余额成功**；**真实观测形状 302 到 `https account/fe/service/login` 仍 `ACCOUNT_OTHER`+安全摘要、0 callback**）。
- 影响面各一次：console transport **20/0**（3 行冻结修正后的 sanity）、grants **18/0**、redirect **6/0**。

## 未证

- 未读真实 browser/log/record，未出网；是否因此让账号 SSO 不再落到 `/fe/service/login` **只能由本人实机验证**。
- 未部署；协议/目标/签名/Cookie/UID/MFA/预算/次数均未改，无新 UI/字段/码。
