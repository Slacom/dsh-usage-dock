# MiMo SSO 目标形状分类诊断 · 窄差异终审（2026-11-09）

> 范围：**只审 protocol 分类函数 + client 两个枚举镜像 hunk + 混合 deployer 的门**。
> 未回审 raw/CAS、未跑矩阵、未装、未联网（含 public web）、未读真实 cfg/record/账号/browser。
> 实机事实：11/9 重启后 reason 从 `70016` 变为 **`E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED` / stage `restore`**，
> **具体 scheme/host/path 未知**。本包只做**固定分类**，不改 allow-set、不升级 HTTP、不新增请求、不动记录。
> **不得把诊断通过说成「已定位」或「已修」。**

## 0. 结论

**Pass（仅诊断分类差异 / 合成范围）**。未发现阻断；两条非阻断观察见 §3。

## 1. 版本与范围（实算）

| 文件 | 新（本轮 pin） | 已装（未动） |
| --- | --- | --- |
| `plans/mimo-auth/console-protocol.js` | `835CA3DE…56BEAE73`（80,487 B） | `93F90677…E128C99D` |
| `client.js`（stage/target） | `62E7B8AA…692736`（473,448 B） | `07EF2C62…35ABB6` |
| `client.js`（WS 受测源） | `74BAE6E4…3B26DC7` | — |
| `client-hunks.json` | `503BEA57…CA69DD`（final:true，2 hunks） | — |
| `deploy-target-shape.mjs` | `A07183A5…E5867E1` | — |
| `plan.json` | `922ECBE3…958BCF4`（approved:false） | — |

stage protocol == workspace 源 == `expectedSourceSHA`；stage client == `62E7B8AA…`，**不等于** WS `74BAE6E4…`（预期）。
其它 15 + pkg/mimo 两 meta 未改（含 grants `6AA94DF6…`、store `E05…`、controller `15FB…`）。

## 2. 差异核对

1. **拒绝集合没有放宽（最终允许集合与旧相同）**：`targetKindOf(u)`（`console-protocol.js:144-160`）只分类、无副作用；
   只有 `https` + 精确 `platform.xiaomimimo.com` + `/sts` + **clean authority（无 userinfo/hash/port）** 返回
   `null`（= 原允许路径）。其余全部返回固定 tag：`http` 的 `/sts` 与其它 path 都**继续拒**（不升级）、
   `https` 的 `/api/sts`、`/sts/`、其它 path 分别给独立 tag；account 精确 `login`/`notification` 仍
   `AUTH_REJECTED`/`SSO_CHALLENGE`，其它 account 路径 `ACCOUNT_OTHER`；外域 `OTHER_HOST`；非 http(s) `OTHER_SCHEME`。
   与旧代码相比：新分类把 authority 清洁检查提到**分类阶段**、更早给出固定 tag；
   但旧路径的 `markSource.canonicalUrl` 与 transport 本就会拒绝 userinfo/hash/非默认 port，
   **最终可发出的 request 允许集合与旧代码相同**，不是新增收窄。
   （标准 WHATWG 会把显式默认 `:443` 归一成空串 `u.port === ''`，所以这条检查**不会**拒显式 443。）
2. **9 个码是静态常量**（`:101-109`），`fail(rejectKind)` 只传常量；无 URL 原文/路径/票/摘要/ID 进入码、DTO 或日志。
   前缀统一 `E_MIMO_CONSOLE_`，最长 52 字符（≤64）。
3. **raw 与 JSON 两条路径共用同一分类**：raw 3xx 在建 seed/absorb 之前（`:943-945`）；JSON 在 `signedSsoTarget`
   之后、`markSource` 之前（`:988-989`）——早于任何回调；原 authority/transport 二层校验、7 purpose、URI 派生、
   headers、DNS pin、TLS、GET、限时/次数、seed/UID/MFA/存储全部未动。
4. **client 两个闭集合各 +9**（hunk 文件逐字）：
   `MIMO_REMEMBERED_REASON_CODE_LIST` 数组与 `MIMO_CONSOLE_*` 对象各追加 9 个同值常量，**old generic 保留**，
   不扩 regex、不改 `applySnap`/既有字段/DOM/任何 WB 区。
5. **WS client 未被整拷（实算验证）**：把 2 个 hunk 顺序应用到**已装** `07EF2C62…`，每步 `oldString` 唯一命中，
   结果 SHA = `62E7B8AA…`，与 stage 文件字节一致；stage 与 WS 的行差异为 **staged-only 67 行 / ws-only 47 行**，
   逐行检查**全部是 WorkBuddy 区**，MiMo/remembered 相关差异 **0 行**；两段枚举区域在 stage 与 WS 中**逐字相同**、9 码各出现 1 次。

## 3. 非阻断观察

1. （已更正）不成立：标准 WHATWG 对 `https://platform.xiaomimimo.com:443/sts` 会把 `port` 归一为空串，
   所以 `u.port !== ''` **不会**拒显式默认 443，也不存在「新拒旧发」的差异；
   `userinfo`/`hash`/非默认 port 的拒绝在旧路径（`markSource.canonicalUrl` + transport）就已存在，
   新旧**最终允许集合相同**，本轮只是把同一拒绝提前分类成固定 tag。
2. `http://account…/pass/serviceLogin` 现在落 `ACCOUNT_OTHER` 而不是 `AUTH_REJECTED`（旧 `cleanAuthority` 不查 scheme）；
   两者都是拒绝，仅标签不同。

## 4. deployer（混合 whole-file + hunks）

- 写集合固定 2：protocol whole-file + client（**只**按 `client-hunks.json` 的 2 个冻结 literal 应用到**已装** base）。
- 客户端路径的门：hunks 文件必须 `final:true` 且**恰好 2** 条；每步 `oldString` 唯一；`ws-proof`（WS pin 匹配，
  仅证明枚举区来源）、`staged-sha`（== `expectedSourceSHA['client.js']`）、`staged-not-ws`（与 WS 同值即 false）、
  `enum-set`（stage/WS 各含 9 码）、`enum-region`（两段区域逐字相同）；任何异常 `record(false)`。
- 其余：17 base 完整核验、old sha 三方同值、meta manifest 读失败/字段非法皆 false、required staged 恰 2、
  `--execute` 需 `plan.deployApproved === true`、写前再核 target 未被改、写后逐 hash、verify-only 15 + 2 meta 复核、
  `partial` 如实、新 17 manifest 不覆旧；不 backup/delete/move/rollback/重启/账户 IO。与 plan 一致，未发现偏差。

## 5. 未证与不主张

- **不主张已定位**：真实 `scheme/host/path` 仍未知；这 9 个 tag 只用于下一次本人恢复时**一次**读出固定分类。
- **不主张已修**：没有任何 allow-set 变化；HTTP 仍拒、外域仍拒、`/api/sts` 与 `/sts/` 仍拒。
- 作者自测（新 5 组 0 fail、旧 redirect 6 组、client 23/0）只作参考；baseline「2 pass/3 fail」是**分类能力反例**，
  不是实机现象复现。未跑 56/22/31/21/99/crypto 矩阵。
- 下一步只能是：用户用**现有 record** 正常恢复**一次**看固定 tag；不重扫、不连续重试。
