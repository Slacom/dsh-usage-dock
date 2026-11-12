# R2 试装事故：回档记录与根因分析（2026-10-29）

> **权威更正入口：[本轮只读复核](mimo-startup-recheck-20261029.md)。** 已找回三次同形真实错误，确认为客户端`dsh-mimo-login-poc: loading`导致web boot审计失败，不再用下文A/B猜测代替现场证据。

> **证据修订 · 2026-10-29 16:19 +08:00：下文为上轮过程记录，不是已证根因。** 撤回“由DSH设置服务写入”“sanitizeProfile自动净化”及“再次报错就说明旧实例写回”等因果断言：当时没有写入者调用链或报错原文，文件mtime也不能识别写入者。A/B只是未验证假设，不能据此再改依赖或安装。`inject=['connection']`在既有真实Cordis试验中会等待服务，不能忽略该证据而把一次`ctx.get`认定为本次根因。YAML能解析和字节前缀完整，只证明局部检查通过，不能排除宿主补丁语义、包身份、客户端构建或完整桌面启动问题。
>
> 用户已重启并重新启用的是Usage Dock，不是MiMo。16:19有限只读摘要确认当前配置中有`plan-usage`，没有`mimo-login-poc`；当前7459字节是用户恢复并调整后的新状态，**不得再用旧7417字节备份自动覆盖**。此次复查只读、不复现危险启动、不重新挂载；后续结论另文记录。

## 一、事故与回档结果

15:16 我按许可把 MiMo 独立条目追加进 desktop 配置（7417→7582 字节，`E_MOUNT_OK`）。15:53 你重启 DSH 时出现与上次相同的启动报错。

**回档已完成**：desktop 的 `cordis.patch.yml` 已恢复为追加前字节，7417 字节、SHA256 `6b906521dba07f3e468678b4c1157ef7bfcdd211f9860e6f10f3368e5c60a8ea`，与被改前**逐字节相同**（`E_RESTORE_OK`，`exactGoodBytes: true`）。**未自动重启 DSH**，需你手动重启后生效。

回档只在该文件等于三个已知指纹之一时才写：正常基线、我追加后的版本、或 DSH 自己重写后的版本；本次命中“DSH 重写版”，写前已把该 827 字节版本另存为私有备份目录内的 `overwritten-7166705f3089.bin`，可复查。备份目录仍在 profile 内，**不要上传**（可能含原有秘密）。

## 二、证据链（结构性取证，未打印任何配置正文）

时间线（UTC）：

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 07:16:57 | 我追加成功，配置 7582 字节 | apply 输出 `E_MOUNT_OK`、after `8e1238e4…` |
| 07:16:57 | DSH 设置服务把 7582 版本另存为 `cordis.patch.yml.bak-1793260612044` | 该备份 7582 字节、mtime 同刻 |
| 07:57:06 | 配置被重写为 827 字节 | 现文件 mtime、`7166705f…` |
| 07:57:32 | `cordis.yml` 被重写（profile 启动） | mtime |

827 字节版本只剩 4 个条目：`ui-settings-account`、`ui-chat`、`ui-settings`、`agent-default-model`；`plan-usage`、`dsh-usage-dock`、`dsh-codex-connect`、`ds-harness-remote`、模型供应商等 **15 个条目全部消失**。这是 DSH 侧的“整理/净化”行为（app-boot 导出 `sanitizeProfile`），不是我的工具写的——我的工具只做“原字节 + 一个 insert 块”，且写后校验通过。

## 三、根因方向（尚未最终坐实，需一条关键信息）

两个已排除项：

1. **不是 YAML 语法错误**：追加后文件用真实 `yaml` 解析器（packaged Electron + ASAR 内解析器）校验通过，`prefixExact` 与 `wholeFileExact` 均为 true。
2. **不是条目被截断**：追加块完整（165 字节、1 个 insert、3 行），落盘校验与实际一致。

剩下最可能的两个方向：

- **A. 硬依赖 `connection` 在 Desktop 组合里迟迟不满足**：候选 `index.js` 第 8 行 `export const inject=['connection']`，而 `apply` 里只取一次 `ctx.get('connection')`，取不到就静默 `available:false`。若该服务在桌面端冷启动路径上不出现或很晚，fiber 会长期 pending；DSH 有 fail-loud 超时机制，可能在启动时直接报错。
- **B. 客户端插件构建失败**：候选声明 `dsh.client.platform: web` 且 `inject: ['slots']`，客户端半在启动时由宿主构建/加载。把插件放在工作区 `.diagnostics` 的 file URL 上（不在 profile 的 node_modules 内），客户端构建器可能解析失败并中断启动。

隔离试验里同一份候选能正常起服务（owner 接口 404 且无 cookie 被拒），说明“服务端加载该模块”本身可用；桌面端报错更可能来自启动期的 fiber 超时或客户端构建。

**要坐实是 A 还是 B，我需要看报错原文**（它通常会指明是 pending/fail-loud 超时，还是 client/bundle 构建错误）。

## 四、下一步

1. 你手动重启 DSH，确认已恢复正常（配置已是 7417 基线）。若仍报错，说明运行中的实例把旧状态写回，需要再回档一次；请把报错原文给我。
2. 重启后**先不要在设置里保存任何配置**，避免覆盖回档。
3. 拿到报错原文后，我按 A/B 定向验证（可离线调用 `prepareProfilePatches`/校验器，不需起服务），再决定是改候选的 `inject` 声明与取服务方式，还是把插件改成安装进 profile 的正式包。
4. 在此之前不重复挂载。本次挂载 permission/started 已消费，不得重放。

范围不变：未扫码、未请求官方、未持久化票据、未发布。
