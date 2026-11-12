# MiMo「忘记→重扫」CAS/tombstone 修正 · 窄差异终审（2026-11-08）

> 范围：**只审 `remember-store.js` + `remembered-session.js` 的 CAS 交接差异、对应 4 例新测试、双文件 deployer 的门**。
> 未重审 SSO/B 架构、未跑大矩阵、未执行安装、未联网、未读真实 record/账号/cfg。
> 用户实机事实：按指导「同进程忘记 → 重新扫码确认」后出现
> `E_MIMO_REMEMBERED_SAVE_FAILED` / stage `store` / 无余额，**尚未重启**。
> **诊断已由主代理读源证实**：`vault.forget` 写 tombstone 但返回 void ⇒ controller 把 `casRevision` 置 null ⇒
> 下一次 `confirm` 的 `save(expected:null)` 撞 tombstone 必 `REVISION_CONFLICT`。
> 重启走 `load()` 能读到正确 revision，所以此前只在重启后出现（这解释了「为何以前没炸」）。

## 0. 结论

**Pass（仅本次 CAS 差异 / 合成范围）**。未发现阻断；三条残余风险见 §3。
安装仅待主代理置 `deployApproved=true` 后执行；本报告不构成真实 runtime 验证。

## 1. 版本与范围（实算）

| 文件 | 新（本轮 pin） | 已装（未动） |
| --- | --- | --- |
| `plans/mimo-auth/remember-store.js` | `E05C7AAC…57E57CA` | `2A6279D7…F6890CA8F` |
| `plans/mimo-auth/remembered-session.js` | `FAC41400…629B97E` | `EE675829…5A81D1` |
| `tools/test-mimo-remembered-reenroll.mjs` | `915C9C48…2B395C10F` | — |

基线并用：`stage` 逐项 == workspace 源 == 候选 target（whole-file）。
其它 15 个 source（含**已装的 SSO protocol `B547A5E4…6F14`**、Host/routes/client/index/grants/transport/DPAPI/vendor、
全部 flags/purpose）未改；record/tombstone schema、key namespace、身份、TTL、明文策略未改。
已核：目标 `console-protocol.js` 现为 `B547A5E4…`，与 SSO 的 `INSTALLED-MANIFEST.json`（17/complete/deployed）一致。

## 2. 差异核对

1. **store.forget 返回真实 revision**（`remember-store.js:339-361`）：`committed` 只在 provider **真的调用**独占回调时置真，
   之后返回 `{ revision: tomb.revision }`（随机 12 字节 hex，Host-only 非 secret）；provider 跳过回调 / disposed ⇒
   `fail(CANCELLED)`，不会假成功。tombstone 仍持久随机 rev、不抹成 null；`load(tomb)` 仍返回 `record:null` + 该 rev 且不解密。
2. **save 的 CAS 语义未放宽**（`:304-315`）：`expectedRevision === null` 且已有信封（含 tombstone）⇒ `REVISION_CONFLICT`；
   非 null 必须等于现有 `seen.revision`。⇒ 只要 controller 采纳 tomb rev，下一次 confirm 就能覆盖 tombstone。
3. **controller.safeForget 采纳真实 rev**（`remembered-session.js:793-812`）：`vault.forget()` 后校验
   `^[a-f0-9]{16,64}$`，非法/缺失 ⇒ 返回 false（fail closed，不写 `casRevision`）；只有 op 仍 current 才写回，
   迟到 ack 不覆盖新 owner 的 CAS 元数据；**不通过重新 load「最新 rev」盲覆盖**。
4. **delete transition gate**：`deleteTransitions` 从 `vault.forget` 调用前自增，到 revision 采纳/失败退出为止（`finally` 递减），
   `startAuth` 在 `deleteFlight !== null || deleteTransitions !== 0` 时返回 `BUSY`（`:821`），
   因此 ack 未交接前不会开新 QR、不会 0 网络抢跑；`forget()` 自身 `deleteFlight` 单飞（`:1193`、`:1224`）。
5. **终止路径修复**（`:715-732`）：`terminateAndForget` 先 `invalidateOps()`，再用**新 `cleanupOp`** 调 `safeForget`，
   `finally endOp` —— 修掉「把已失效 op 交给 safeForget 导致 tomb 永远写不出去」的旧缺陷；
   `state/code` 在删除前落位，旧 ack/旧 failure 不覆新 `casRevision`/state。
6. **无 secret 外泄**：revision 只存在 `casRevision` 内部；`snapshot()/displaySnapshot()/status` 白名单未新增该字段，
   route/DTO/日志均无。

## 3. 残余风险（记录，不阻断）

1. **provider 契约依赖**：若 `modifyRecord` 调用了回调却静默不落盘，store 会返回一个「未真正写入」的 rev。
   这属于 provider 违约（不在本包责任面），但会让后续 save 报 `REVISION_CONFLICT`（fail closed，不会静默丢数据）。
2. `vault.forget({})` 未传 `signal`：删除不可被中途取消。这是刻意的（tombstone 一旦开始就应完成），
   代价是 dispose 时可能等到 provider 返回；`bump()` 保证后续写不生效。
3. tomb 已写但 op 恰好失效时，`safeForget` 不采纳 rev（`:805`）⇒ 该 owner 后续 save 会 `REVISION_CONFLICT`（报 SAVE_FAILED）。
   属 fail closed，不是数据损坏；下一次 `load()`/重启即自愈。
   **更正（2026-11-08 晚）**：此前把它写成「后续一定 conflict 所以不安全面有限」过强。
   若在 tomb 提交挂起期间有**新的入口**抢跑（如 `retry`/`resume`），`invalidateOps()` 会中止 cleanup op ⇒
   `safeForget` 不采纳 rev，而 tomb 仍可能落盘；`retry` 随后仍读到**旧密文**并可能进入 `verified` 显示余额，
   此时 `persistIfChanged` 若判 `sameExport` 会**跳过写**，于是不会立刻报 CONFLICT —— 表现为「内存 verified / 磁盘已 tombstone」，
   直到重启才归空。是否可达取决于各入口是否都有 delete-transition gate（见 §7）。


## 4. 未证与不主张

- **不证明真实保存/恢复**：4 例与旧 31/21 套都是**合成**（真 `createRememberedVault` + in-memory credentials + fake crypto，
  真 controller、必要 fake HTTP）；真实 DPAPI、真实 credentials 服务、真实扫码/余额/跨重启未验。
- **不证明此前 SSO `70016` 根因已解决**：本包只修「同进程重扫的 CAS 交接」，与 SSO 拒绝码是两件事。
- 未让用户继续扫码盲试；真实结果仍待用户本人下一次正常操作后的 safe real reason 与余额。

## 5. deployer（双文件）

`plan.json`（final:true / review pending / **deployApproved:false**）：write 2 whole-file、expectedOld = 已装 `2A62…`/`EE67…`、
expectedSource = 本轮 pin；verify 15 + `package.json`/`plans/mimo.js` 2 meta；任何 stage/语法/依赖/导出失败都 `record(false)`；
`required staged 恰好 2` 进入 `results`；`metaManifest` 读失败或两 64-hex 字段非法 ⇒ `record(false)`（fail closed）；
`--execute` 需 `plan.deployApproved === true`，execute 内**无条件**复核两 meta 与写后 15 项、`partial` 如实，
不 backup/delete/move/rollback/重启/联网。以上与 `plan.json` 声明一致，未发现写盘集合或门上的偏差。

## 6. stage2 定稿（关包）

**实算 4/4 一致，`stage/` 恰 2 个文件**，已装仍为旧版本（0 写）：

| 项 | SHA-256 | 字节 |
| --- | --- | --- |
| stage `plans/mimo-auth/remember-store.js` | `E05C7AAC1334614EDD05BF62892C6C3AAC77943C84602B85B45F4DFAF57E57CA` | 17,985 |
| stage `plans/mimo-auth/remembered-session.js` | `FAC41400FBBFB6DD3BE70D07801E79BDFEA7F7A7D61935D5B8A022377629B97E` | 51,011 |
| `deploy-reenroll.mjs` | `2734B5CCDE4F12A00F858B48B0020FC06E59C7EECF1DD1877BE1DB4324502A85` | 13,962 |
| `plan.json` | `4AAFB582C53FB4F30E50D82D2407CC50BA616F735CE8E56DB643E1E3E3015904` | 3,155 |

stage == workspace 源 == `expectedSourceSHA`（同一值，无第二套 target hash）；已装
`remember-store.js` 仍 `2A6279D7…`、`remembered-session.js` 仍 `EE675829…`；protected 15 含 SSO protocol
`B547A5E4…` 未被写入。作者 dry-run：`ready=YES checks=33 fail=0 staged=2 exit=0`（只作参考）。

**最终判定：Pass（仅本次 CAS 差异 / 合成范围）**，安装仅待主代理置 `deployApproved=true` 后执行这 2 个文件。
真实保存/恢复仍待用户本人；本包即使修好「同进程重扫」也**不证明**此前 SSO `70016` 根因已解决。

## 7. delete-transition gate 覆盖审计（2026-11-08 晚，阻断关包前发现的入口缺口）

**结论：主代理的怀疑成立——在 pinned/staged 版本里 `retry`/`resume` 没有该 gate。**

- staged `remembered-session.js`（`FAC41400…`，1313 行）只有 **1 处** gate：`startAuth` 的 `:821`。
  `retry`（staged `:1233`）与 `resume`（staged `:1123`）在 `invalidateOps()` 之前**没有**任何
  `deleteFlight/deleteTransitions` 检查。
- 可达性：`terminateAndForget` 会先把 `state='failed'` 再 `await safeForget(cleanupOp)`，
  所以 tomb 挂起窗口内 `retry()` 的 `state !== 'failed'` 前置**放行**；`pause` 保存失败停在 `paused` 时
  `resume()` 同样放行。⇒ 不是理论路径。
- 后果：`retry/resume` 的 `invalidateOps()` 会中止 cleanup op ⇒ `safeForget` 不采纳 rev，而 tomb 仍可能落盘；
  `retry` 读旧密文后可能进 `verified` 并显示旧余额，`persistIfChanged` 判 `sameExport` 时**跳过写**，
  于是不会立刻 CONFLICT（我 §3-③ 的旧措辞已更正）。
- **修正已在 workspace 出现但尚未入 stage**：workspace 现为 `15FB626F…`，与 staged `FAC41400…` 的 diff
  **恰好只有 2 行**，即 `resume`/`retry` 各加一条
  `if (deleteFlight !== null || deleteTransitions !== 0) return { ok:false, code: R.BUSY }`，
  位置都在 `invalidateOps()` 与 state 检查**之前**，无其它改动。
- **关包条件**：plan 重新 pin 到 `15FB626F…`、重新 stage（controller 哈希会变，store 不变），
  并对 `retry`/`resume` 各补一条「tomb 挂起期间 BUSY + 0 网络」的反例（可复用现有 D 例）。
  新 stage/plan hash 给我后，我**只确认这 2 行 gate 与版本一致性**即关包，不再重开整审。
- **已关闭（2026-11-08 17:0x，实算）**：
  stage `remember-store.js` = `E05C7AAC…57E57CA`、stage `remembered-session.js` = `15FB626F…97DF997`
  （与 workspace 源、`expectedSource` 同值），`deploy-reenroll.mjs` = `2734B5CC…4502A85`（未改），
  `plan.json` = `3A7DA2D0…4E384F54`（仅 controller pin 由 FAC41400 改为 15FB626F）；
  staged controller 内 **gate 恰好 3 处**：`:821` startAuth、`:1126` resume、`:1236` retry，
  均在 `invalidateOps()` 之前。已装仍 store `2A6279D7…` / controller `EE675829…`（target 0 写），
  protocol `B547A5E4…` 及其它 15 + 2 meta 未动。
- 另记一处不对称（非本轮要求）：显式 `forget()` 只查 `deleteFlight`，不查 `deleteTransitions`；
  在 terminate cleanup 期间再点「退出并忘记」会中止那次 cleanup 并再写一个 tomb（同一 key，最终仍为 tombstone），
  属可接受的降级，不阻断。



