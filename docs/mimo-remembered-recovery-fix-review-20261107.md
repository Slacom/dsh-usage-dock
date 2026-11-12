# MiMo「记住登录」恢复失败诊断补丁 · 短差异终审（2026-11-07）

> 范围：**仅本诊断补丁的源码/合成/候选差异**。未重审全部 B、未跑大矩阵、未执行安装、
> 未读生产 credentials record / 账号 / cfg / GUI、未做任何真实探测请求。
> 用户侧事实：首扫+勾选确认后真实余额正常；**重启恢复失败**，UI 曾显示「记住登录已停止:E_NONE」。
> **真实根因未知**，本补丁只让实际安全 cause 可见，不构成修复。

## 0. 结论

**Pass（诊断源码 / 合成 / 候选范围）**。未发现阻断；两条非阻断观察见 §3。

## 1. 差异范围与哈希（实算）

| 文件 | 本补丁 SHA-256 | 判定 |
| --- | --- | --- |
| `client.js` | `A834C4CAC9A8055C1FB1FFBC59F6DD57C238F86E5B0C62D7BEADDB030DFF74DA` | 仅 MiMo 错误呈现；工作区含 WB dirty，未整份拷 |
| `plans/mimo-auth/remembered-session.js` | `EE675829EBA2DFDCCC1449850864440DD8600CB3F4D70621F8F1C18DDF5A81D1` | reasonCode / failureStage |
| `plans/mimo-auth/host.js` | `C093B9E05E16F0DAF29601D14ED0E6963F7DAA4D42180FB411D4B0132B0BD74D` | 仅代码级 DI `rememberedCrypto` |
| `plans/mimo-auth/routes.js` | `959354B60136B356E4900924838E1667A6F4A1617F535D30CEEDF41DB2B01756` | 快照白名单投影两字段 |

**未改（实算与上轮终审一致）**：`console-protocol.js` `D1C1BCCD…`、`console-grants.js` `705C3934…`、
`secure-transport.js` `91F8DEA8…`、`remember-store.js` `2A6279D7…`、`windows-dpapi.js` `BC054C95…`、
`index.js` `BDE16765…`。⇒ 协议/授权/传输/存储/DPAPI/flags/身份绑定/TTL 均未触碰。

## 2. 逐项核对

1. **只出固定枚举**：`noteFailure(stage, protocolCode)`（`remembered-session.js:204-211`）把阶段限在
   `restore|login|read|store`，原因码只接受 `CONSOLE_PROTOCOL_CODES`；未知/非协议一律折 `FLOW`，
   store 阶段显式 `''`。快照只多这两个非密字段（`:323-324`）。
2. **失败码不再被外层掩盖**：restore catch 保留 sealed cause 进 `reasonCode`，公开 `code` 仍是
   `RESTORE_FAILED`/`NETWORK`/`BINDING_MISMATCH`（`:533-565`）；`IDENTITY_MISMATCH` 才 `safeForget`，
   **其余失败不删用户 record**（密文保留）。
3. **路由白名单**：`reasonCode` 必须匹配 `^[A-Z][A-Z0-9_]{0,63}$`，`failureStage` 四值枚举
   （`routes.js:343-345`）；status 仍纯观察，无重试/网络/rawID/票/URL/nonce。
4. **Host 新 seam 只给代码级**：`resolveVault` 仍要求 `ctx.get('credentials')` 与
   `profileContext.dir` 为**绝对路径**；`dependencies.rememberedCrypto` 仅由 `createAuthHost(...)` 取得，
   route/GUI/cfg 都到不了（`host.js:178-198`）；默认仍真实 DPAPI。
5. **UI 呈现**：`snap.code` 为主（不再被正常 GET 的 `E_NONE` 覆盖），actCode 只在非 `E_NONE` 且形态合法时记录
   （`client.js:4804-4807`/`5005-5024`）；原因/阶段经闭集合 `MIMO_REMEMBERED_REASON_CODES` 与四阶段过滤，
   非白名单值被 picker 丢弃、不进 DOM（`:4536-4545`、`:4717-4723`）。成功/新 boot 会清空这两个字段。

## 3. 非阻断观察（可选，不必现在改）

1. 若某个 `failed/stopped` 快照的 `code` 字面就是 `E_NONE`，UI 仍会显示「…：E_NONE」；建议把 `E_NONE`
   当空处理（显示「未取得原因码」），避免与这次的症状再次混淆。
2. `actCode` 一旦写入没有在成功路径清空的调用点；当前优先级（`snap.code` 优先）使其基本不可见，
   但下次触碰可顺手清。

## 4. 未证实 / 不主张

- **未证根因**：新字段只说明「下次失败时 Host 看到的是哪一类固定 cause」；真正的 SSO/ctx/jar 失败原因
  要等用户下次自行恢复后报告 sealed reason 才能判断，本补丁不修自恢复、也不改 MFA/clientSign 语义。
- 未跑作者自测之外的套件（作者报：恢复诊断 7/0、client 17/0、manager 21、disable 2）；
  本报告不把自测计数当结论。
- 未验证真实 lazy factory 生产分支、真实 DPAPI 写入、重启恢复、跨设备/Android。
- 候选 stage 4 文件哈希尚未给出；给出后只做 hash 版本确认，不重开完整审。

## 5. stage 包装缺陷（源码之外，阻断 stage 而非源码）

`client-hunks.json` 第 3 个 hunk `failed-stopped-show-snapshot-code` 的 `oldString` **只有已装过的那两行**：

```
  if (st === 'failed') {
    children.push(h('div', { key: 'f0' }, '记住登录已停止：' + code))
```

而 `newString` 已包含**完整的 failed 块（含 retry/forget 按钮）+ 完整的 stopped 块**。把它应用到已装
`client.js 9273…`（R6 版仍保留旧的 retry/forget/stopped 尾部）时，旧尾部不会被替换 ⇒ 产生**重复/残留尾部**。
这是 **literal 记录被截断**的包装问题，不是业务源码问题，也不是「已装 base 选错」。

**修正要求（原则）**：把该 hunk 的 `oldString` 扩到已装 base 里**完整的旧 failed/stopped 块**（含 retry/forget 与
stopped 段），`newString` 保持现有业务内容；随后重算 `expectedTarget`（旧的 `AFADF…` 已失效，**不视为通过**）、
重跑 `--check` 与函数等价断言，并确认 guard 在 base 不匹配时仍拒写。源码侧本报告的 Pass 不受此影响；
**stage 未就绪前本包不关闭**。

## 6. 包装修正与候选定稿（关包）

**hunk 完整性（只读模拟）**：8 个 hunk 在**已装 9273 base** 上顺序应用，每个 `oldString` 在应用时刻
恰好命中 **1 次**；结果 `sha256 = 07EF2C62…35ABB6`，与 C2 给的新 target **逐字符相同**；
旧文案「记住登录已停止」在结果中 **0 次**（无残留尾部），`node --check` 通过。

**4 个候选 stage 实算（4/4 一致，目录恰 4 文件）**
- `client.js` `07EF2C62B101B5F683AAF9D77EAB5D201306DDAE702CD8E459EE3923F035ABB6`（472,318 B）
- `plans/mimo-auth/host.js` `C093B9E0…2B0BD74D`（31,937 B）
- `plans/mimo-auth/routes.js` `959354B6…2B01756`（42,664 B）
- `plans/mimo-auth/remembered-session.js` `EE675829…5A81D1`（49,390 B）

已装 `client.js` 仍为 `9273636F…`（**目标 0 写**）；`package.json` / `plans/mimo.js` 仍等于基线 SHA；
protocol/grants/transport/store/DPAPI/index 哈希未变。

**deployer 守门（script `1951C9C027AA85AD22A70B4E33CAA4559E9118D248035CE9892C4B43439505F2`，实算一致）**
1. whole-file stage：try/catch 中失败 `record(rel,'stage',false,固定说明)`——不再出现「只 log 不记 false」；
2. `REQUIRED_STAGED`（3 个 whole + client）在 `ready` 前显式校验 `missing===0 && staged.size===4` 并
   `record('stage-set', …)`，该记录进入 `results.every`，因此缺项会 `ready=NO` + `REFUSE`，不会到 execute 才发现。

**最终结论：可安装（仅 diagnostic 范围）**。安装后仍需用户本人下一次启动观察 safe real reason；
本补丁**不修** SSO/恢复根因，不自动忘记、不自动重扫，也不构成「真实可用」的证据。


