# MiMo 根入口文件恢复（硬链接安全）· 窄终审（2026-11-09）

> 范围：**只审恢复脚本 + 原子替换 helper + plan 的固定字节与门**。
> 未审任何业务/协议功能、未扩查外因、未跑矩阵、未联网、未读真实 cfg/credential/record/browser/env/进程命令行。
> 背景事实：上次试装后约 25 秒，`installed index.js/client.js` 被**正式 0.9.0 字节**覆盖；
> 其余 15 个 auth 代码 + package/mimo 两 meta 仍是 desired；root 两文件各 **nlink=5 共享 inode**，目录不是 symlink；**谁写未知**。
> 用户已明确「直接再试装看看」，本轮只把这两个根入口恢复回**上次已审 closure**，不改功能/版本/配置/记录/请求规则。

## 0. 结论

**Pass（仅恢复脚本 / 固定字节范围）**。未发现阻断；三条非阻断观察见 §3。

## 1. 版本与目标字节（实算）

| 项 | SHA-256 |
| --- | --- |
| `restore-root-entry.mjs` | `09537F45…2F584A6D`（13,885 B） |
| `atomic-replace.mjs` | `A187A1D7…78CE3D3`（4,074 B） |
| `plan.json` | `E5A0AAA1…34DA1EC1A`（final:true / pending / **approved:false**） |
| stage `index.js` | `C6813698…EFF29DBF`（103,210 B） |
| stage `client.js` | `62E7B8AA…692736`（473,448 B） |

磁盘现状：`index.js` = `9B19C55B…C847DE78`、`client.js` = `3E7E0C13…BFD1302`（正是 plan 的 old formal，**0 写**）；
desired17 = `.diagnostics/mimo-sso-target-shape-diag-20261109/INSTALLED-MANIFEST.json`（17/complete/deployed），
其 root2 记录正是 `C681…`/`62E7…`。plan 的 `expectedTargetOldSHA` / `expectedSourceSHA` 与磁盘、desired **三方同值**。

## 2. 核心核对

1. **不写穿共享 inode**：`atomicReplaceFile` 只对**同目录**建唯一 temp（`wx` + `0o600`，独立 inode，`nlink===1` 显式校验），
   写冻结字节 → `fsync`（失败可忽略）→ 关 FD → 校验 temp 内容 hash；**从不打开目标 fd 做写入**。
2. **目录/目标防逃逸**：`realpath(dir)` 必须等于 `dir`（拒绝符号链接目录）；`path.dirname(dst)` 必须等于固定 `TARGET`；
   `dst` 必须 `lstat.isFile()` 且非 symlink；`oldSha` 必须匹配 plan pin。
3. **rename 前再核**：目标仍是普通文件、非 symlink、SHA 未变、**inode 未变**；随后
   `renameSync(tmp, dst)` —— 同目录原子替换**目录项**，旧 inode（含其它 4 条链接）原封不动。
4. **写后校验**：新 SHA == goal、`nlink===1`、`ino !== oldIno` 三者都过才记 `verified`；否则 throw → `partial`。
5. **门（全部在写前）**：desired17 完整；其余 15 项当前 == desired；root2 当前 == plan old；
   **`goal-eq-desired` 两条写前 record**（goal pin 必须等于 desired 记录，防止「先写非 desired、写后才在 post 发现」）；
   source SHA == goal；`node --check` + 相对 import 闭包；required staged 恰 2；meta manifest 读失败/字段非法 ⇒ `false`；
   `--execute` 需 `plan.deployApproved === true`。
6. **写后**：15 项 + `package.json`/`plans/mimo.js` 必须未变；新 17 manifest 与 desired **逐项 hash 差异数必须为 0**
   （这正是旧 8D 脚本的阻断：它要求差异数 == 2，会把成功误报成 partial）；新 manifest 写在本轮目录，不覆盖 desired/旧 manifest。
7. **原子性表述如实**：逐文件独立 rename，不声称两文件事务；失败 `partial`，无自动 rollback、不删用户数据、不追未知硬链接。

## 3. 非阻断观察

1. **未知写入者可能再次覆盖**：本脚本只保证「本次替换不写穿共享 inode」；若那个 25 秒后的未知写入者再次按路径写，
   新文件仍可能被覆盖。这是环境问题，不是本脚本缺陷；若复现，应记录时间与目标而不是继续盲试。
2. **权限从原 mode 变为 0600**：temp 以 `0o600` 创建，rename 后新文件即 0600。同用户运行的 DSH 可读，功能无碍；
   但与原文件 mode 不同，属可接受的最小面（若要保原 mode，需额外 stat 传递，不在本轮）。
3. **失败时 temp 残留**：若 `atomicReplaceFile` 在 rename 前 throw，`.restore-*.tmp` 会留在插件目录（收据里没有清理）；
   不影响正确性，但下次可顺手加清理。

## 4. 未证与不主张

- 恢复的是**诊断版** closure（含最新 9 个分类枚举），**不代表余额/SSO 已修**；具体 SSO 目标类别仍待用户本人用 existing record 重启看固定 code。
- 未验证未知写入者身份、未验证 nlink 5 的其它 4 条链接归属；未跑协议/UI/存储矩阵。
- 用户明确要求直接试装；失败或再次被覆盖时应保留现场（时间、两文件 hash、nlink），不要再盲目重装。
