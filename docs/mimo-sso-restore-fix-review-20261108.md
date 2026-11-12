# MiMo SSO 握手修正 · 窄差异终审（2026-11-08）

> 范围：**只审本次 `console-protocol.js` 差异 + 对应新测试 + 单文件 deployer 的写盘/门**。
> 未重审 B 架构、未跑大矩阵、未执行安装、未联网、未读真实 wire/record/账号/cfg。
> 用户实机事实：首扫+四勾选+确认后当场余额正常；**重启恢复失败**，
> 显示 `E_MIMO_AUTH_REJECTED` / reason `E_MIMO_CONSOLE_ACCOUNT_CREDENTIAL_MISSING` / stage `restore`。
> **真实根因仍未证**（没有 wire 证据），本补丁是「握手顺序 + seed 轮换」的候选修正。

## 0. 结论

**Pass（仅协议差异 / 合成范围）**。未发现协议侧阻断。脚本侧前置（meta fail-closed 门）已关闭（见 §4），
安装仅待主代理执行 `--execute`；本报告不构成真实 runtime 验证。

## 1. 版本与范围（实算）

| 项 | SHA-256 |
| --- | --- |
| workspace 源 = stage 候选 | `B547A5E4A102FAB8091CA134629945711CB59E455E7C706629874A8EA0616F14`（77,493 B） |
| 已装目标（未动） | `D1C1BCCD6E5211C42E2AABC9D83DE297798676F4880C9E85FE5C82F05F3AED88` |
| 新测试 `tools/test-mimo-console-sso-rotation.mjs` | `66E9644A997AA657A25D510B58C5C1F8764815E36D10612D85784208E4289DA0` |
| `plan.json` | `8004E7EEF37EBF24150F5BCC87A9A24432047DF633468780EB0AA0B69920646C`（final:true / review pending / deployApproved:false） |

`stage/` 恰好 1 个文件；**workspace 源 == stage == 候选 target**（单文件整拷贝，无 hunk、无 WB 混合）。
未改（实算与上轮一致）：grants / transport / host / routes / store / dpapi / controller / client / index。
固定码集合、purpose、DNS pin、TLS、no-redirect、one-renew、identity、owner epoch 均未动。

## 2. 协议差异核对

1. **顺序修正（本补丁核心）**：`runSso` 现在依次为
   `ctx → SSO(200) → 快照 seedPrior → absorb(headers) → bodyJsonWithNonce → challenge → code → seed → jar/UID 校验 → STS callback`。
   `70016` 在**读 cookie 之前**判 `AUTH_REJECTED`（`console-protocol.js:926`），
   不再被「先查账号 cookie」掩成 `ACCOUNT_CREDENTIAL_MISSING`；其它非 0 仍走原固定 unsupported（不放行）。
2. **challenge 严格**：只有 `null/undefined` 视为无 challenge，任何交互 challenge → `SSO_CHALLENGE`（`:924`）。
3. **seed 轮换只认本次响应**：`applySsoAccountSeed`（`:770-861`）
   - 显式 `userId` 进入即先比 expected/accountId（`:791`），不等装进 jar 再比；
   - 同响应 header 已用**不同值**设置 ⇒ `SSO_RESPONSE_UNSUPPORTED`（`:812`）；同值则以 header 为准（保留其 expiry）；
   - `passToken` 被本响应删除时必须 `fullPair`（本次明确同时给出 userId+passToken 且 UID 为绑定）；
   - `userId` 被删除时只允许补回**同值**，且要求当前 passToken 仍有效未被撤，或 fullPair；
   - 其余情况**同值不重装**（保留 raw/flags/expiry），不同值才作为新 seed 安装；
   - 全程**不从入参旧 record 回灌**、不复活过期、不生成 Max-Age。
4. **同值重签**：仅 `fullPair` 下允许把 prior 原值按 prior 原 metadata 重装（`:842-860`），
   不扩 `hostOnly`、不翻转 secure/httpOnly、不延长 expiry（`:847-851`）。
5. **签名分支**：`signedSsoTarget`（`:870-893`）——已有 `clientSign`/`_ssign` 必须唯一非空并原样保留；
   否则需要 `nonce` + `ssecurity` **同时**存在，只用**顶层原始十进制 lexeme**（`^[0-9]{1,64}$`）算
   `SHA1('nonce=' + raw + '&' + ssecurity)` base64；只有一种材料 ⇒ fail closed；
   两者都没有 ⇒ 保留服务器原 opaque URL（不凭空加参）。目标仍强制 `platform.xiaomimimo.com` + `/sts`（`:937`）。
6. **nonce 采集不宽松**：`decodeJson(text, capture)` 保持原有严格解码（`&&&START&&&`、dup key、危险 key、
   深度、数值 `userId` lexeme 全保留），capture 只在 **depth 0** 且首次出现时记录；
   数字记原始 lexeme（不舍入），字符串记已解值（不带 JSON 引号），嵌套 nonce 不覆盖（`:177-188`）。
7. **absorb 返回值语义**：`{revoked, set}`，`set` 只来自 `accepted > 0` 的 bindings
   （删除标记/空 tombstone 不算新值，`:544-548`、`:633`）；语义比较用去外层引号的值，输出保留原字节。
8. **无新增网络面**：SSO 仍是一条 ctx + 一条 SSO + 一条 `/sts`（3 hop），无额外 HTTP、无跨 class 头 Cookie；
   **导出路径不变**（仍只 4 名、root path、绝对 expiry）。

## 3. 未证与不主张

- **不声称实机根因已修**：70016 / challenge / seed 轮换都是**合成**覆盖；真实 wire、真实账号、
  真实厂商接口未读未证。若真实原因不是这条顺序缺陷，重启仍可能失败。
- 真实 lazy vault、生产 record 写入、跨重启恢复、自然券过期换票、Android 均未验证。
- 作者自测（新套 22/0、protocol 56/0、remembered 29/0、旧顺序负对照 4 例退化 `ACC_MISSING`）
  只作参考，不作为本报告结论。

## 4. 脚本门（已补齐，本包可安装但未执行）

新 deployer `deploy-sso.mjs` = `FC98D922AC2CE10A13634448360C46FA68BD7F896168AA5433337BEC4A1AD1FC`（实算一致），
`plan.json` = `8004E7EE…646C`，`stage` 仍 `B547A5E4…6F14`。meta 保护已从 fail-open 改为 **fail-closed**：

1. **preflight 两条 record**：`meta/manifest`（读失败/null ⇒ false）与 `meta/sha-fields`
   （要求 `packageSha`/`mimoSha` 均为 `^[0-9A-F]{64}$`）都进入 `results`；任一失败 ⇒ `ready=NO` + 0 写。
2. **execute 无条件校验**：`metaManifest === null` 直接 throw，`package.json`/`plans/mimo.js`
   逐项比对基线 SHA，不再有「非 null 才校验」的跳过路径。
3. 其余写盘语义未变：**write 1 / verify 16 + 2 meta**、source=stage=targetNew 同一 hash、
   写前后 SHA 复核、`partial` 如实、不 backup/delete/move/rollback/重启/联网。
4. 作者 dry-run：`ready=YES checks=29 fail=0 staged=1 exit=0`（只作参考）；已装仍 `D1C1BCCD…`、0 写。

**最终判定：Pass（仅协议差异 / 合成范围）**，安装仅待主代理把 `deployApproved` 置真后执行这 1 个文件。
仍**不声称**实机根因已修；真实 wire / 账号 / record / 跨重启恢复未被本报告验证。

