# MiMo 重启恢复失败：诊断可见性（2026-11-07）

真实 B 试用：首次确认后当场余额正常；重启后 UI 显示“记住登录已停止：E_NONE”。
截图含真实账号 ID，本文**不复述**，也不写入任何日志/测试/存储。

## 已证（源码 + 合成复现）

- 用户看到的是 client `st==='failed'` 分支文案，不是 controller `stopped`/dispose；
  外层 `E_NONE` 由 client 覆盖真实 `code`（f195 另修，本包不改 client）。
- controller `restore` 的 catch（`plans/mimo-auth/remembered-session.js`）此前只保留三类协议码
  （`IDENTITY_MISMATCH→BINDING_MISMATCH`、`TRANSIENT→NETWORK`、`ACCOUNT_CREDENTIAL_MISSING→AUTH_REJECTED`），
  其余全部折成 `RESTORE_FAILED`，`snapshot` 只有 `code`，**协议固定码与阶段全部丢失**。
- `routes.rememberedSnapshot` 白名单此前也没有任何协议码/阶段字段。
- 恢复链（`console-protocol.restoreRememberedAccount` → `runSso`）在这些固定点抛错：
  `FLOW`（ctx 非 30x / SSO 非 200 / 缺 location）、`SSO_CHALLENGE`（`challenge !== undefined`，null 也拒）、
  `AUTH_REJECTED`（SSO `code===70016`）、`SSO_RESPONSE_UNSUPPORTED`（其他非 0）、
  `SSO_TARGET_UNSUPPORTED`（location 非 `platform.xiaomimimo.com/sts`）、
  `ACCOUNT_CREDENTIAL_MISSING`、`PLATFORM_CREDENTIAL_MISSING`、`ACCOUNT_COOKIE_POLICY`、`IDENTITY_MISMATCH`。
- 生产 lazy vault 分支（`host.resolveVault`：`ctx.get('credentials')` + `profileContext.dir` + 真工厂）
  在 99 里从未被覆盖；本包新增合成覆盖并证明“首次确认写入 → 新 Host 重启 → 恢复失败”可区分配置。

## 本包改动（最小）

- `remembered-session.js`：新增只读诊断字段 `reasonCode`（默认 `''`，仅 `CONSOLE_PROTOCOL_CODES`
  固定集合；未知折 `E_MIMO_CONSOLE_FLOW`；store 阶段无协议 cause 时 `''`）与
  `failureStage`（默认 `null`，枚举 `restore|read|login|store`）；restore catch 保留 sealed 协议码，
  首读失败记 `read`，save/load 失败记 `store`；成功/新操作/forget/disable 清空；迟到失败仍受 op/gen 栅栏。
- `routes.js`：白名单直传上述两个**非 secret** 字段（`snapshot/status/displaySnapshot` 同步可见）。
- `host.js`：只在真实 lazy `resolveVault` 里新增代码级 DI `dependencies.rememberedCrypto`
  （route/GUI/配置不可达，默认仍是真 DPAPI）。
- 新套 `tools/test-mimo-remembered-recovery-errors.mjs`：fake ctx + 串行 in-memory provider +
  合成 scope + fake crypto；首次确认写密文 → 新 Host 重启 → 6 类 SSO/ctx 失败断言
  `state=failed`、`failureStage=restore`、`reasonCode` 为对应协议码、0 余额、不泄 ID、密文保留。

## 未证（不得当根因已修）

- **真实失败点未知**：当前只证明“可见性原来丢失”，没有证明真实环境到底落在哪一类
  （`SSO_CHALLENGE` / `AUTH_REJECTED` / `SSO_TARGET_UNSUPPORTED` / `PLATFORM_CREDENTIAL_MISSING` 等）。
- 公开 SDK 的 `_signed_sts_url` 在 URL 缺 `clientSign/_ssign` 时会用 nonce/ssecurity 计算；
  当前 `runSso` **没有**这段签名，且 `challenge !== undefined` 连 `null` 都拒绝。
  这两条是**候选兼容线索**，未经真实固定 reason 证实前不改 protocol。
- 平台短票未落盘（record 只存 4 个账号 cookie）意味着每次重启都要新签平台票；
  若 /sts 需要签名或风控，同样会落 `PLATFORM_CREDENTIAL_MISSING`/`FLOW`。
- 未接真实 credentials/DPAPI/账号/网络；未重启、未部署；未改 install 17 闭包。
