# 失败 ACCOUNT 目标的 5 字段安全摘要（2026-11-09）

实机：恢复 root2 后新码为 `E_MIMO_CONSOLE_SSO_TARGET_ACCOUNT_OTHER / restore`；具体 account 路径未知。
本包**只观察已收到的正常恢复响应**生成安全摘要，**不新增请求、不 follow、不改凭据/目标规则/预算**。

## 公开合同（C2 routes/client 复用）

`projectConsoleHandoffSummary(raw)` 导出纯投影，只保留 5 字段，任一坏值 → `null`，额外字段不 copy：

```
{ source: 'header'|'json', status: 200|301|302|303|307|308,
  scheme: 'http'|'https'|'other', pathTokens: string[] (≤8, 固定词表),
  truncated: boolean }
```

路径词表（小写精确闭集）：`fe,pass,service,login,servicelogin,auth,notification,security,password,phone,qr,qrlogin,qrcode,verify,verification,identity,account,passport,callback,sts,api,v1,v2,login2,loginurl,home,index,confirmation,authorize,oauth,web,ui,other`。
按 `pathname` 的 `/` 非空段小写后**精确命中才保词**；数字/ID/token/编码串一律 `other`；最多 8 段，超出
`truncated:true`；根路径 `[]`。**不读/不解码 query**，不含 host/URI/query/fragment/userinfo/port/nonce/值/digest/ID。

## 改动

- `console-protocol.js`：私有 `buildHandoffSummary` 仅在 **已知 ACCOUNT** 目标被 `targetKindOf` 拒绝前、
  当前 op 下从本次响应（raw header 或 JSON 200）生成；`describe().handoffSummary` 为安全拷贝；
  新 op/成功/dispose 清空；失败时 `clearSecrets` 只清 secret，不清摘要。
- `remembered-session.js`：snapshot 增加 `handoffSummary`（默认 null）；restore catch 中在
  `isCurrent(op) && protocol===p` 且 `dropProtocol` 之前，经 projector 复制到控制器；
  `clearFailure`/forget/disable/retry 入口清空；旧/迟到 op 不覆盖。
- 无新错误码、无新请求、无 header 改动、无记录字段、不持久化/不日志。

## 验证

- 新套 `tools/test-mimo-console-handoff-summary.mjs`：**6 passed / 0 failed，exit 0**
  （projector 闭集/未知字段不 copy；raw ACCOUNT_OTHER 5 字段、未知段→other、secret/host 不出现；
  JSON 代表例 source=json/status=200、>8 段 truncated；有效 https `/sts` 摘要 null 且仍 3 hop+余额；
  controller 失败后摘要保留、retry/forget 清除；**迟到响应**：请求发出后 abort/dispose 再放行
  ACCOUNT_OTHER，`describe().handoffSummary` 必须仍为 null）。
- 两个摘要写入点前均有显式 `assertOp(op)`（raw/JSON 各一），dispose/取消/owner 失效后不会晚写摘要。
- 影响面回归各一次：target-shapes **5/0**、redirect **6/0**、manager **21/0**。

## 未证

- 仍不知道 11/9 实机具体 account 路径；本包只让下一次恢复安全报出 5 字段摘要（UI 由 C2 把 `other` 显示为 `*`）。
- 未部署、未读真实 record/网络；不宣称登录恢复成功。
