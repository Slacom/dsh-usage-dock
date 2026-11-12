# MiMo SSO handoff 安全摘要诊断 · 窄终审（2026-11-09）

> 范围：**只审 5 字段摘要的协议/控制器/路由/客户端差异、生命周期与安装门**。
> 未重审旧 SSO/CAS/复原，未跑大矩阵，未联网，未读真实 cfg/record/browser/账号/环境/日志。
> 实机事实：原子复原后 UI 与新 9 码已激活；最近一次 16:04 显示 **`SSO_TARGET_ACCOUNT_OTHER` / stage `restore`**，
> 不是 platform HTTP；具体账号路由未知。本包只做**已收到响应的安全摘要**，不新增请求、不 follow 新路径、不改凭据；
> **不是登录修复**。

## 0. 结论

**Pass（仅摘要诊断 / 合成范围）**。未发现阻断；三条非阻断观察见 §3。

## 1. 版本与目标（实算）

| 文件 | 新（本轮 pin） | 已装（未动） |
| --- | --- | --- |
| `console-protocol.js` | `20A7476F…F7323D74` | `835CA3DE…56BEAE73` |
| `remembered-session.js` | `B2294E06…762B487E` | `15FB626F…97DF997` |
| `routes.js` | `A99D36D9…8662FE7E` | `959354B6…2B01756` |
| `client.js`（staged/target） | `113C5F0E…2952E1A9` | `62E7B8AA…692736` |
| `client.js`（WS 受测） | `67B7E1B1…3B49CC74` | — |
| `client-hunks.json` | `1E877049…0E15E495`（final，4 hunks） | — |
| `deploy-handoff.mjs` | `D9375ECC…6641DC566` | — |
| helper（复用） | `A187A1D7…78CE3D3` | — |
| `plan.json` | `B017C54A…BB167E75`（approved:false） | — |

其余 13（index `C681…`、grants `6AA…`、store `E05…`、transport/vendor/DPAPI 等）+ pkg/mimo 两 meta 未写。

## 2. 核心核对

1. **5 字段闭集**：`handoffSummary = {source, status, scheme, pathTokens, truncated}`。
   - `source ∈ {header,json}`；`status ∈ {200,301,302,303,307,308}`；`scheme ∈ {http,https,other}`；
   - `pathTokens` 只允许 **33 个固定词**（protocol `HANDOFF_PATH_WORDS` 与 client `MIMO_HANDOFF_PATH_TOKENS` 逐词一致），
     长度 ≤8、可 `[]`（root）；`truncated:boolean`；
   - 未知段/数字/票/%编码段 → `other`；**不读 query、不 decode**；输出**无 host/原 URI/原 path/fragment/userinfo/port/nonce/digest/ID**；
   - `projectConsoleHandoffSummary` 严格重建新对象（不 copy 额外字段），坏值 → `null`。
2. **只在已知 ACCOUNT 目标被拒时生成**：raw 3xx 在 `targetKindOf !== null && host===ACCOUNT` 时（`console-protocol.js:996`）、
   JSON 在 `jsonRejectKind !== null && target.hostname===ACCOUNT` 时（`:1044`）——两处都在 `assertOp(op)` **之后**赋值；
   成功路径、`openOp`（新 op）、`dispose` 均清零。
3. **生命周期/迟到**：失败时 `runOperation` 的 `clearSecrets` 只擦 jar/ id（`:1268-1277`），**不清** `handoffSummary`；
   `describe()` 只回 `projectConsoleHandoffSummary(...)` 的安全副本（`:1405`）。controller 在
   `isCurrent(op) && protocol === p` **之后、`dropProtocol()` 之前**复制（`remembered-session.js:542-548`），
   stale 失败直接 return staleResult 不会回填；`clearFailure`/`retry`/`forget`/`disable`/成功均清 `handoffSnapshot`。
4. **路由**：`handoffSummary` 默认 `null`，只有 `state === 'failed'` 且值合法才投 `projectConsoleHandoffSummary`；
   非法 → null；不 loadRecord、不发请求（`routes.js:359-413`）。
5. **客户端**：独立五字段闭集重建（`status` 必须是 **number** 且在集合内、`pathTokens` 0..8、root `[]` 合法、
   未知词 drop 整体 null）；渲染为**纯文本**：`other → *`、root → `/`、`truncated → /…`，不是 href、不用 innerHTML；
   只在 failed 块渲染（`client.js:5063-5066`）；9 码/applySnap/WB 区不动。
6. **无请求放宽**：所有 URL 派生/7 purpose/目标允许集合/headers/DNS/TLS/MFA/seed/UID/预算/自动 retry/record schema 未改
   （已装 vs 工作区 diff 只有新增摘要代码与两处 `if (rejectKind)` 改块）。
7. **客户端 stage 仅 WB 差**：4 hunks 应用到**已装** `62E7…` 每步唯一命中，结果 SHA = `113C5F0E…`（= stage），
   ≠ WS `67B7E1B1…`；deployer 另有 `ws-proof` / `staged-sha` / `not-ws` 三条 record。
8. **4 文件 atomic 门**：`abs = path.resolve(TARGET, rel)`，先校验 `abs` 在 `TARGET` 之下，再用
   `atomicReplaceFile({dir: dirname(abs), rel: basename(abs)})`（修掉 nested-rel `E_ESCAPE_PATH`）；
   写前 old SHA、写后 goal SHA + `nlink===1` + `ino` 变化；13 项 verify + 2 meta；新 manifest 逐项核 4 goal / 13 原值，
   不机械计数、不覆旧 manifest；`--execute` 需 `deployApproved===true`。

## 3. 非阻断观察

1. `retry()` 在入口**先**清 `handoffSnapshot`，再判 `deleteFlight/deleteTransitions` BUSY；删除转场期间点重试会让
   摘要提前消失（不影响安全，只是少一次诊断信息）。
2. `projectConsoleHandoffSummary` 不拒绝额外 key，只是不 copy；与「不 copy 额外字段」一致，若将来要更严可改 reject。
3. 摘要只在 restore catch 复制；本轮不声称覆盖 read/其它场景（包的声明已经限定）。

## 4. 未证与不主张

- **不主张已定位/已修**：真实账号路由仍未知；本包只让下一次本人恢复时看到 5 字段安全摘要。
- 作者自测（core 6 组 0 fail、UI 35/0、route 7/0、manager/shape/redirect 各一次）只作参考，未重跑矩阵。
- 未验证真实 cfg/record/browser/账号/环境/日志；不扫码、不发完整 URL；下一步只能是本人 existingRecord 正常恢复**一次**截图摘要。
