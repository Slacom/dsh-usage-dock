# MiMo SSO redirect 兼容修正 · 窄差异终审（2026-11-08）

> 范围：**只审 `console-grants.js` + `console-protocol.js` 的 redirect/SSO 差异、定向测试与双文件 deployer 的写盘/门**。
> 未重审 CAS/全 B、未跑大矩阵、未执行安装、未联网（含公共源码）、未读真实 record/账号/cfg。
> 用户最新实测：CAS 修后**新扫码确认当场余额正常**；**fresh restart 仍 `E_MIMO_AUTH_REJECTED` / stage `restore`（70016）**。
> 主代理已读公开第三方实现（PR824 / conky 的 `api-platform`）：均原样把 `serverLoginURL` 交给 `raw 3xx Location`，
> 我方此前自加 `_json`/`_locale` 且只收 200 属**兼容缺口**。**未证明这就是实际 70016 根因**。

## 0. 结论

**Pass（仅本次 redirect 差异 / 合成范围）**。未发现阻断；两条非阻断观察见 §3。
安装仅待主代理置 `deployApproved=true` 后执行这 2 个文件；本报告不构成真实恢复验证。

## 1. 版本与范围（实算）

| 文件 | 新（本轮 pin） | 已装（未动） |
| --- | --- | --- |
| `plans/mimo-auth/console-grants.js` | `6AA94DF6…4625BC4A`（17,748 B） | `705C3934…F359BE569` |
| `plans/mimo-auth/console-protocol.js` | `93F90677…E128C99D`（79,149 B） | `B547A5E4…0616F14` |
| `tools/test-mimo-console-redirect-sso.mjs` | `5EC3CFE4…86CDB8DB`（13,510 B） | — |
| `deploy-redirect.mjs` | `4E12E49C…A43576C4D` | — |
| `plan.json` | `F7BF3D56…F9DCF9`（final:true / review pending / **approved:false**） | — |

未改（实算与上轮一致）：store `E05C7AAC…`、controller `15FB626F…`、host `C093B9E0…`、routes `959354B6…`、
client `A834C4CA…`、index `BDE16765…`、secure-transport `91F8DEA8…`、vendor/DPAPI。
**无 viewport/UA/Accept/Origin/sns/device/sdkVersion/entryEndpoint/quota/QR-init/LP 改动**（diff 只落在这两个文件）。

## 2. 差异核对

1. **`deriveConsoleSsoUrl` 改为逐字保留**（`console-grants.js:139-144`）：`canonicalUrl(serviceLoginUrl).toString()`，
   **不** `searchParams.set`、**不**删 `callback`/`_sign`、不重建 sid-only URL、缺省也不补；
   `canonicalUrl` 的 https/端口/无 userinfo/无 fragment/host 标签校验全部保留。
   授权侧仍以同一纯函数派生 `expectedUrl(ACCOUNT_SSO)` 并做**字符串全等**比较（`:303`、`:356-360`），
   context 源仍强制 `account.xiaomi.com/pass/serviceLogin` + `sid=api-platform` + `callback=platform/sts`（`:257-270`）。
2. **`runSso` 增加受控 3xx 交接**（`console-protocol.js:903-922`）：
   - 200 走原 JSON 分支；`301/302/303/307/308` 读**本次** `Location`，其它状态 `FLOW`；
   - `Location` 必须 https；`cleanAuthority` 要求无 userinfo/hash、端口为空或 443；
   - 精确 `account.xiaomi.com/pass/serviceLogin` ⇒ `AUTH_REJECTED`；`/pass/notification[/…]` ⇒ `SSO_CHALLENGE`（0 额外请求、0 回调）；
   - 其余必须**精确** `platform.xiaomimimo.com/sts`，否则 `SSO_TARGET_UNSUPPORTED`（0 回调）；
   - 无自动 follow / 无 HTML 提链 / 无二次 SSO 盲试。
3. **顺序**：目标识别在任何 mandatory jar 检查**之前**；随后仍 `absorb(accountJar)` → `passToken`/`userId` 必备 →
   `accUid` 与 `accountId`/`expected` 双比对（`:956-962`）→ `markSource('sso')` → `call(platform callback)`；
   回调请求**不带 account jar**（`call` 未传 `jar`），`assertPurposeTarget` 再核一次 platform `/sts`。
4. **200 JSON 语义不退**（`:940-955`）：strict `decodeJson`/XSSI 前缀/dup key/危险 key/深度/顶层 `nonce` lexeme、
   `challenge` 非空即拒、`code 70016 → AUTH_REJECTED`、code 0 的 seed/fullPair/同值重签/header 权威/nonce+ssecurity 签名全部保留。
   新增 `bSecondValidation`：`true → SSO_CHALLENGE`、非 boolean → `SSO_RESPONSE_UNSUPPORTED`、`false` 放行，无新 DTO/新码。
5. **cookie/导出不变**：账号响应仍走原过滤/删除/raw/TTL/UID 双比对；raw 302 的 `Set-Cookie`
   （quoted 值 + 未来 Expires）会真实写入并按原 metadata 导出；不改 record schema、不回灌 deleted secret。
6. **transport/authority 未松**：7 个 purpose、精确域/path、source WeakMap、owner boot/gen/deadline、DNS pin、TLS、
   no-redirect、GET 全部沿用；`consoleTarget` 无 `_json` 硬编码，双层目标授权保持。

## 3. 非阻断观察

1. 200 JSON 分支的判断顺序是 `challenge → bSecondValidation → code`：若某响应同时带 `bSecondValidation:true` 与
   `code:70016`，会显示为 `SSO_CHALLENGE` 而非 `AUTH_REJECTED`。两者都是**拒绝**、无绕过，仅诊断标签不同。
2. 3xx 指向 `account/pass/serviceLogin` 时**在 absorb 之前**就抛 `AUTH_REJECTED`，该响应的 `Set-Cookie`
   （若有轮换）不会写入。这是保守选择，与「账号被拒」结论一致。

## 4. 未证与不主张

- **不证明真实 70016 根因已解**：本包只修「强制 JSON 200 + 自加 `_json`/`_locale`」这一兼容缺口；
  真实恢复要等用户用**现有 record** 本人恢复一次。若服务端实际行为不同，仍会失败。
- 未跑真实账号/record/cfg/browser/vendor 请求；作者自测（新 6 组 0 fail、protocol 56/0、rotation 22/0、grants 18/0）
  只作参考。作者的 baseline「2 pass / 4 fail」是**兼容反例**，不是实机 70016 复现。
- 未重跑 store/controller/crypto/99/大 B。

## 5. deployer（双文件）

write 2 whole-file（grants→protocol）/ verify 15 + `package.json`·`plans/mimo.js` 2 meta；
base = `.diagnostics/mimo-reenroll-cas-fix-20261108/INSTALLED-MANIFEST.json`（当前 17，store E05 / controller 15FB 已装）；
expectedOld 与盘上 `705C…`/`B547…` 三方同值；`required staged` 恰 2 且进入 `results`；
任何 stage/语法/依赖/导出失败 `record(false)`；`metaManifest` 读失败或两 64-hex 字段非法 ⇒ `record(false)`；
`--execute` 需 `plan.deployApproved === true`，execute 内**无条件**复核两 meta 与写后 15 项，`partial` 如实，
不 backup/delete/move/rollback/重启/账户 IO，新 17 manifest 不覆旧。与 plan 声明一致，未发现偏差。
