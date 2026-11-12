# MiMo 同进程「忘记 → 重新扫码」CAS 交接修复（2026-11-08）

实机现象：同进程「退出并忘记 → 重新扫码确认」后余额不显示，固定 `E_MIMO_REMEMBERED_SAVE_FAILED / stage store`。
**不是 SSO 根因**，不读生产 record 即可用真实 store 复现。

## 已证代码缺陷

- `remember-store.forget()` 写入随机 revision 的 tombstone，但**不返回 revision**；
- `remembered-session.safeForget()` 之后把 `casRevision` 置 `null`；
- 下一次 `save({expectedRevision:null})` 在 store 里只接受 `seen.kind==='none'`，而当前是 tombstone ⇒ 必 `REVISION_CONFLICT` ⇒ 控制器报 `SAVE_FAILED`。
- 只有重启后 `boot().load()` 返回 tomb revision 才能绕过，所以“重启能恢复、同进程重登必坏”。

## 本包改动（仅 2 源）

1. `remember-store.forget()` 在 **commit 成功**后返回 `{ revision: tomb.revision }`（Host-only、非 secret；
   不改变 tomb 内容/键/schema；commit 未发生则固定 `CANCELLED`，绝不假成功）。`load()` 的 tombstone 语义不变
   （不 unprotect、`record:null`、`expectedRevision:null` 仍不能覆 tomb）。
2. `remembered-session`：
   - `safeForget(op)` 采纳真实 tomb revision 作为新 `casRevision`（不再置 null）；无/坏 revision 视为失败；
     await 后复核 `isCurrent(op)`，迟到 ack 不得覆盖新 owner 的 CAS 元数据。
   - `terminateAndForget` 先失效在途，再用**新建 cleanup op** 完成删除（不能把已失效 op 交给 `safeForget`）；
     `safeForget` 内部用 `deleteTransitions` 计数覆盖 commit→ack→元数据回写全过程，`startAuth` 在任一 transition
     或 `deleteFlight` 在途时固定 `BUSY`（0 QR/0 网络）；
   - `forget()` 使用自己的 op + `deleteFlight`；删除在途时 `startAuth`/`retry`/`resume` 均固定 `BUSY`
     （0 QR/0 网络；retry/resume 在 settleBoot 后、任何 load/restore/SSO 之前判定），
     commit 落定后才允许新扫码。其它 `safeForget` 调用（身份不符、pause 失败）传原 op。
   - 不重做控制器；epoch/op 栅栏、paused 语义、0 预确认余额、dispose 不 forget 均不变。

## 验证

- 新套 `tools/test-mimo-remembered-reenroll.mjs`：**4 passed / 0 failed，exit 0**
  - A：同 Host 首次 QR→确认→余额→forget(tomb)→**不重启**再 QR→确认成功 + 首读 1 次 + 新活密文；
  - B：`forget()` 返回 revision == 随后 `load().revision`、load 不 unprotect、null 仍不可覆 tomb、正确 revision 可再存；
  - C：tombstone commit 在途时新 `startAuth` 返回 BUSY 且 0 网络，commit 后可正常重新确认。
- **修复前基线**：新套 `0/3`（A 第二次 confirm 失败、B 返回 undefined、C 抢跑成功）；修复后 3/0。
- 回归各一次：`test-mimo-remember-store.mjs` **31/0**、`test-mimo-remembered-session.mjs` **21/0**
  （后者 fake vault 的 `forget` 按新契约返回 `{revision}`；未放宽任何反例）。

## 未证

- 未读真实 record/账号；不宣称用户实机已恢复；未部署、未重启。
- 跨 Host 外部改写 record 仍按 CAS 拒绝（不盲重试覆盖）；本包只修同进程删除→重登的 revision 交接。
