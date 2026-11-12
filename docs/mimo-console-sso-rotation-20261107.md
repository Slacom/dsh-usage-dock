# MiMo SSO 握手补齐（2026-11-08）

用户实机固定原因：`reason E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING / stage restore`。本包**不读取**
其 record/账号、不宣称已读真实 wire；若真实返回 70016/主动 challenge，本包只准确拒绝。

## 已证（源码 + 合成）

- 旧 `runSso` 顺序：SSO200 → absorb（尊重 Set-Cookie 删除）→ **先要求 jar 仍有 passToken/userId** → 才读 JSON。
  真实 SSO 若在响应中删除旧 cookie、并在 JSON 里重签 seed（SDK `_update_account_seed`），旧实现会在读 JSON 前
  报 `ACCOUNT_CREDENTIAL_MISSING`，真实拒绝码也被掩掉。
- 旧实现只从 LP 补种，SSO code0 的 seed 完全不消费；`challenge` 连 `null` 都拒；STS URL 无 clientSign 补签。
- 合成负向对照（临时恢复旧顺序）：新套 4 例退化 `ACCOUNT_CREDENTIAL_MISSING`；改后全绿。

## 本包改动（仅 `console-protocol.js`）

1. **SSO 解析复用严格 `decodeJson`**（`&&&START&&&` 前缀、重复/危险 key、深度、数值 UID 词素保护不变）；
   仅对**顶层** `nonce` 保留原始十进制 lexeme（数字）或已解析字符串（不带 JSON 引号），嵌套 nonce 不覆盖。
   JSON 异常映射为固定 `SSO_RESPONSE_UNSUPPORTED`，不新增 enum。
2. **顺序**：SSO200 → absorb → 严格解析 → challenge（仅 `null`/缺省）→ code（`70016→AUTH_REJECTED`，
   其它非 0/`'0'`→`SSO_RESPONSE_UNSUPPORTED`）→ code0 处理 seed → 再查 jar → STS 目标 → callback。
3. **Seed 来源语义（SSO 与 LP 分离）**：只有**本次可信 account SSO、code0、明确同时给出 userId+passToken、
   UID 严格等于绑定**的**完整 pair** 才能重装 seed —— 即使 token 字节与 prior 相同也合法（新授权来自
   本次可信响应，不以字符串不同为证明）。LP 的删除规则**完全不变**（删除后同旧值不得补种）。
   - 同响应非删除 Set-Cookie 与 JSON 同名不同值 ⇒ 拒；header 已用同值设置 ⇒ header 权威、skip JSON（保 expiry）。
   - 同值且未被删除 ⇒ 不重装，保留 prior raw/有限 expiry（不续命、不抹 null）。
   - 被删除 + 完整明确同值 pair ⇒ 按 prior **原 raw 值与原绝对 expiry** 重装；不是从 record 取旧 token fallback。
     重装按 prior 原 `domain/path/hostOnly/secure/httpOnly` 与绝对 expiry 重建，**不扩 cookie 范围**、不延长 TTL。
   - 不同新 token：header 无 expiry ⇒ `expiresAt:null`。
   - **身份 vs 秘钥**：`userId` 被删时只需本次 JSON 明确同值 UID + 当前 passToken 仍有效且未被本响应撤销即可补回（公开 SDK 常不返回未轮换的 token）；`passToken` 被撤销时无论同值/异值都必须由本次完整明确 pair 提供，否则 0 callback。
4. **签名**：已有 `clientSign/_ssign` 必须**恰好一个且非空**才逐字保留；空串/重复 ⇒ 固定拒绝；
   二者皆无 ⇒ 原 opaque STS URL；只有 nonce 或只有 ssecurity ⇒ fail closed；齐全 ⇒
   `base64(sha1("nonce=<raw>&<ssecurity>"))` 追加 clientSign，仅同一可信 SSO 响应的精确 `platform.xiaomimimo.com/sts`；
   nonce/ssecurity 仅内存，不进 DTO/日志/磁盘。
5. 保存仍只 4 个账号 seed，不含平台票/URL/nonce；quote 原值不 decode。

## 未证

- 未读真实 wire/record；不宣称 SSO 真实根因已修，也不保证登录未丢（旧身份不符保护可能曾 forget）。
- 未部署；已装 17 闭包未动；旧 deploy 脚本非幂等，不可重跑。

## 验证

- 新套 `tools/test-mimo-console-sso-rotation.mjs`：**20 passed / 0 failed，exit 0**
  （前缀 code0、字符串/大整数 nonce 精确签名、嵌套 nonce 不混、重复/危险 key 拒、header expiry 精确保留、
  删除标记+新 seed 允许、quoted 同值不重装、空/重复 clientSign 拒、同值重签合法且不延长 expiry）。
- 回归各一次：`test-mimo-console-protocol.mjs` **56/0**、`test-mimo-console-remember-protocol.mjs` **29/0**。
