# 「记住登录恢复失败」真因可见性：客户端最小修（2026-11-07）

范围：**只改 `client.js`**（MiMo managed 面板的失败态呈现），加一支可运行的 UI 单元测试与本次 literal patch。
未触 Host / controller / routes / protocol / store / index / 99 套件 / mock-react / 已装文件；未部署、未重启；
未读真实账号 / 凭据 / record / cfg；未调用真实 MiMo/小米接口。

## 1. 修的是什么（实机现象 → 代码位置）

实机：本人扫码并确认成功、当时余额正常；**重启后**面板显示「记住登录已停止：`E_NONE`」。

根因（已证，来自读源码）：外层观察响应是 200 成功，`code` 就是 `E_NONE`；旧 `applySnap()` 无条件把它写进 `code`
state，而 `failed/stopped` 分支又用这个 state 渲染 → 会话失败码（`remembered.code`）被 `E_NONE` 盖掉。

本轮在 `client.js` 完成的（5 个 hunk，叠加在上一作者 3 个 partial 之上）：

| id | 作用 |
| --- | --- |
| `reason-code-allowlist` | 客户端自带一份 `CONSOLE_PROTOCOL_CODES` 的**值集合**镜像（76 个）+ `failureStage` 四值枚举；未知/自造/自由文本一律丢弃 |
| `empty-snapshot-reason-stage-defaults` | `mimoRememberedEmpty()` 增 `reasonCode:''` / `failureStage:null`（「没观察到」≠「失败」） |
| `picker-reason-stage-whitelist` | `mimoRememberedOf()` 只重建白名单内的 `reasonCode` / `failureStage` |
| `reason-note-helpers` | `mimoRememberedStageText()` + `mimoRememberedReasonNote()`：阶段中文标注 + 附注串（两者皆空则不显示半截括注） |
| `failed-stopped-reason-annotation` | `failed`/`stopped` 主码仍用 `snap.code`（回退 `actCode`），其下新增附注行：`（阶段：恢复登录；原因：E_MIMO_CONSOLE_SSO_CHALLENGE）` |

沿用上一作者的 3 个 partial（不动）：`actCode` state、`applySnap` 不再把 `E_NONE` 写入、失败文案中性化。

呈现优先级按合同：**主码 = `snap.code`**；`reasonCode`/`failureStage` 只做附注；普通 GET 的外层 `E_NONE` 永不参与。

## 2. 测试：`tools/test-mimo-remembered-error-client.mjs`

```
node tools/test-mimo-remembered-error-client.mjs
→ 17 passed, 0 failed (17)   exit 0
```

装配（与 99 套同一手法，不整页空 props）：真实 `mock-react.loadClient` 载入 workspace `client.js`
→ 挂真实入口闸门 `mimoAuth.Panel`（`MimoAuthMount`）→ 取它渲染出的真实 managed 面板组件
（`MimoRememberedPanel`）再挂载 → 受控 `setInterval` 驱动 3 s 轮询。
数据是**固定投影 JSON**（UI 单元，不冒称全链 e2e；无真实账号 ID / 票 / URL / 金额）。

覆盖：
1. 失败态显示 `remembered.code`，**不含** `E_NONE`；文案是「恢复失败：…」不是「已停止：E_NONE」；
2. 附注显示「阶段：恢复登录」+「原因：E_MIMO_CONSOLE_SSO_CHALLENGE」；重试入口可见；
3. 连续 3 轮普通 GET（外层一直 `E_NONE`）后原因仍在；
4. 换已知原因（`E_MIMO_AUTH_REJECTED` / 阶段 `read`）UI 跟着换；
5. 自造原因 `E_LEAKED_SECRET_ABCDEF`、非法阶段 `weird-stage` 在 picker 层被丢弃且不落 DOM（主码仍在）；
6. 恢复成功（verified）后不再显示失败码/附注；
7. **协议码表同步守卫**：`Object.values(CONSOLE_PROTOCOL_CODES)` 76 个值逐个必须被客户端接受（漏同步即红）；
8. 文本不含 `passToken` / `api-platform` / `longPolling` / `https://`。

## 3. 本次 literal patch

`.diagnostics/mimo-remembered-recovery-fix-20261107/client-hunks.json`（`final:false`）

- 8 个 hunk = 原 3 个 partial（`carryOver`）+ 本轮 5 个；`applyOrder: sequential`
- `targetBaseSha256`（已装 staging 起点）`9273636F…D77475` → `expectedTargetSha256`（**部署后应装上的**）`07EF2C62…F035ABB6`
- `workspaceClientSha256`（仅工作区，含 WB-dirty，**不是**会装上的 hash）`A834C4CA…DFF74DA`；
  `patchedWorkspaceBaseSha256`（上一作者记录的工作区中间态，仅历史自证）`5E126A9C…D295AF`
- 作废 hash：`AFADF1FC…`（hunk#2 修复前的错误 target）、`7DCC9E07…`（错误反演基线），均在 `obsoleteHashes`
- **hunk#2 修复**：`failed-stopped-show-snapshot-code` 的 `oldString` 原来只有 failed 开头 2 行，
  顺序应用会残留 retry/forget/旧 stopped 尾部并破坏语法；现按**已装 9273 的真实 6 行原文**加宽，
  `newString` 仍是被测源码的那一块（`hunk#7.oldString === hunk#2.newString` 已断言）
- 机器校验（`repair-hunk2.mjs`）：从已装文件纯内存按 8 hunk sequential 应用，**每步唯一命中**；
  staged 产物 `node --check` 通过；staged 的 **MiMo 区段与已测工作区逐字相等**（47354 字节），
  五个目标函数（`MimoRememberedPanel`/`mimoRememberedEmpty`/`mimoRememberedOf`/`mimoRememberedStageText`/`mimoRememberedReasonNote`）都在。

## 4. 未证 / 边界（不要当成已修 SSO 根因）

1. **不是 SSO 根因修复**：本轮只让「下一次失败时本人能看到实际固定 cause」；真实 SSO 为何失败仍未知，
   需用户下次自行重试后按显示出的固定码再定位。
2. 本套是 **UI 单元**（固定投影），不是全链 e2e；真实 Host→route→UI 的联调不在本轮断言内
   （backend 侧 `reasonCode/failureStage` 投影已由 High858 交付，`routes.js:343-345` 已白名单透传 —— 本文件只读核对过字段形状）。
3. 两侧白名单不完全同构：Host 侧 unknown 会归一成 `E_MIMO_CONSOLE_FLOW` 再下发，客户端仍按**协议固定集合**收；
   因集合覆盖 76 个协议值（有守卫），不会丢合法码；但若将来协议新增码而客户端镜像漏改，测试会红。
4. 未跑 99 套件与旧 80 套件（本轮按主的要求不回归；已核对它们不引用失败态文案/新字段）。
5. 未做负对照（不声称本轮复现）：实机现象与源码证据由主/前序作者给出，本轮只做修复与呈现验证。
