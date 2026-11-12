# MiMo settings「更新于 / 已绑定账号」两行排版 · 极窄终审（2026-11-11）

> 范围：**只审 1 个 combined hunk 的 2 行 style + 注释，以及单文件部署脚本门**。
> 未重跑 UI/业务/认证矩阵，未执行安装、未读真实账户/API/cfg/credentials/env/log/net；Codex bridge 不在本包。

## 0. 结论

**Pass**。无阻断。

## 1. 版本（实算全部一致）

| 项 | SHA-256 |
| --- | --- |
| installed client（old） | `8F010A7C…37E29D509F` |
| stage client（goal） | `85906C30…F3343A1DD8`（483,548 B） |
| `staged/client.js` | 与 stage **同 hash** |
| WS client（仅 proof，WB dirty） | `B22B1848…3E3AA0F2` |
| `client-hunks.json`（final，1 hunk） | `307F9BAF…FE4310D5` |
| `deploy-typography.mjs` | `037E579934DA1BB11C27B0696FC0E5ECD1788AA9476E9FC9F422D2A711A89E7C` |
| `plan.json` | `A8E7F5E469B18DDDAF8D78B696F073F7B38506FEFB1F294FAB9C461BB8CC118D` |
| helper | `A187A1D7…78CE3D3`（未改） |

## 2. 差异范围

唯一 hunk `verified-lines-typography`：只给 `st === 'verified'` 的
`v1`（更新于 …）与 `v2`（已绑定账号：…）两行加 `style: settingsHintStyle`，另加 2 行注释；
文本、`mimoTiny('v5')` 退出按钮、`paused/restoring/failed` 等其它分支**均未动**。
`settingsHintStyle` 是模块级 `var`（client 第 2792 行定义），hunk 位置约 5073 行，**作用域可见**。

## 3. hunk 应用（独立模拟）

对已装 `8F01` 应用该 hunk：`oldString` **唯一命中 1 次**，结果 SHA = **`85906C30…`**（= stage = staged 目录），
行数 9303 → 9305（+2，正是两行注释）；未整拷 WS。

## 4. 部署脚本门（实算读码）

- base = `.diagnostics/mimo-ui-closeout-20261110/INSTALLED-MANIFEST.json`（complete / deployed / 17，client 记 `8F01`）。
- write **1**（client，hunks 模式）；verify **16** 未变 + **2 meta**（`package.json`/`plans/mimo.js`）**fail-closed**。
- pin 三方：`goal ≠ base`、`goal ≠ WS`；hunks 文件 SHA 必须等于 plan pin（防旧 hunks 冒充）。
- `staged.size === 1` 只在 `final && pinsOk && oldOk` 时成立；任一 false 即拒。
- `--execute` 需 `plan.deployApproved === true`；目标固定为 desktop profile 路径。
- 写入走已审 helper：`abs` 在 TARGET 下 → `dirname/basename` → 同目录 `wx` 临时文件 → rename；
  写后核 `sha == goal`、`nlink === 1`、`ino` 已变；随后复核 16 + 2 meta；新 17 清单逐项 1 goal + 16 base；partial 如实。

## 5. 最小结论

纯排版 hunk，作用域与范围都符合描述，脚本门与 atomic 路径齐全。**Pass**，
安装仅待主代理置 `deployApproved=true` 后本人执行该 1 个文件。
