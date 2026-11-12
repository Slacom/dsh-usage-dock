# MiMo SSO 受控 raw 3xx 交接（2026-11-08）

实机：fresh 扫码当场余额正常；restart 恢复 `E_MIMO_AUTH_REJECTED / …SSO… / stage restore`。
主已读公开 console 源：服务端 `serviceLogin` URL **原样走 raw 3xx Location**，不强加 `_json/_locale`。
本包是**兼容候选修正**，不宣称 vendor 契约已验证，也不宣称 70016 根因已定位。

## 已证差异

- 旧 `deriveConsoleSsoUrl` 会补 `_json/_locale` 并可能重编码 opaque 查询；旧 `runSso` 只接受 200 JSON，raw 302 一律 `FLOW`。
- **兼容反例（合成，单轮）**：临时恢复旧实现后新套 `2 passed / 4 failed`，raw 302 全部 `FLOW`；**未重复、非实机 70016 复现**。

## 改动（仅 `console-grants.js` + `console-protocol.js`）

1. `deriveConsoleSsoUrl` **完整保留**服务端 serviceLogin URL（仅标准规范化），不增删 query；缺省不补 `_json/_locale`。
2. `runSso` 双模式：
   - **raw 交接**仅接受固定 `301/302/303/307/308`；只读本次 Location、不 follow。
   - 分类：精确 `https://account.xiaomi.com/pass/serviceLogin`（无 userinfo/非 443/fragment）→ `AUTH_REJECTED`；
     精确 `/pass/notification` 及其子路径 → `SSO_CHALLENGE`（0 额外账号请求/0 回调）；
     其余必须精确 `https://platform.xiaomimimo.com/sts`，否则 `SSO_TARGET_UNSUPPORTED`（userinfo/port/hash 由既有 authority 判拒）。
   - 目标确认后才做 mandatory jar（uid==accountId+expected）。
   - **200 JSON 兼容全保**：严格 decodeJson、code0 seed/同值重签 metadata、challenge、70016、nonce+ssecurity clientSign。
   - `bSecondValidation`：true→`SSO_CHALLENGE`，false 放行，非 boolean→`SSO_RESPONSE_UNSUPPORTED`。
3. 无新 header、无 deviceId/sdkVersion/snsNone 猜测、QRinit/LP 派生未动、无新 code/DTO。

## 验证（6 组，非循环批量）

`tools/test-mimo-console-redirect-sso.mjs`：**6 passed / 0 failed，exit 0**
- A derive：不补 `_json/_locale`，opaque 片段逐字保留；`derive(SIGNED_WITH_JSON)` 原样。
- B raw302：SSO URL 逐字；SSO Set-Cookie 签发 quoted `"NEW_RAW"` + 精确未来 expiry；导出 exact raw/expiry、旧值不出现；callback 不带 account seed/旧平台票；余额可读。
- C 301/303/307/308 允许；304/300/201 固定 `FLOW` 0 回调。
- D account 登录页→`AUTH_REJECTED`；通知页/子路径→`SSO_CHALLENGE`；外域/http/其它 path/userinfo/port/hash→0 回调（`SSO_TARGET_UNSUPPORTED` 或既有 authority `TARGET_INVALID`）；缺 Location→`FLOW`。
- E JSON200：code0（`bSecondValidation:false`）成功；70016→`AUTH_REJECTED`；true→`CHALLENGE`；非 boolean→unsupported。
- F **迟到 raw 响应**：SSO 请求已发出后 abort/dispose，再释放 302+SetCookie → 固定取消/过期码、0 回调、0 余额、abort 后不可导出。

回归各一次：`test-mimo-console-protocol.mjs` **56/0**、`test-mimo-console-sso-rotation.mjs` **22/0**。
**契约期望变更**：`test-mimo-console-grants.mjs` 原「派生加 _json/_locale」断言改为「不补、保留 _sign」；已于上次交付通过 18/0。

## 未证

- 未读真实 wire、未发账户请求、未部署；raw302 是否解决本账号 70016 **未证**；记录仍保留，本人只需恢复一次不重扫。
