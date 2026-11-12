# dsh-usage-dock 0.10.1

> 0.10.1 只做一件事：把 Codex `Subscription` 来源依赖的**第三方只读 service 补丁**工程化。

## 更新摘要（GitHub Release 正文）

- **升级第三方插件后能一条命令恢复**：Codex `Subscription` 来源依赖第三方包 `dsh-codex-subscription`
  上的本地只读补丁。该包升级/重装会覆盖补丁，过去只能手工重打；现在运行
  `node tools/patch-codex-subscription.mjs` 即可检查，`--apply` 才写入，`--revert` 可回退。
- **不影响 `Codex Connect` 来源**：该来源不依赖此补丁，补丁没打时它照常可用。
- **工具默认只读**：不带参数只做检查（版本是否匹配、每条改动能否唯一命中），不改任何文件。

## 工程细节（维护者用）

- 目标包默认路径集中在 `tools/patch-codex-subscription.mjs` 文件头（`DEFAULT_PACKAGE_DIR`），
  可用 `--package-dir <path>` 覆盖；仓库内不散落用户目录常量。
- hunk 清单：`tools/patches/codex-subscription-3.2.6.json`（4 条纯插入 hunk，含 `old`/`new` 原文与说明，
  以及 `baseSha`/`programSha`/`version`）。**版本钉死**：`package.json` 的 version 必须等于清单里的
  `version`，不等就直接拒绝（退出码 2）并提示重新生成清单，绝不模糊匹配。
- 写入纪律：先过全部前置检查（版本、`baseSha`、每条 hunk 唯一命中）→ 备份旧字节到
  `tools/patches/backup/<UTC>/`（`wx`）→ 同目录 `wx` 临时文件写入并读回校验 → `rename` 原子替换 →
  校验新哈希等于 `programSha`。任何一步失败都不写目标文件。
- 离线回归：`node tools/test-patch-codex-subscription.mjs`（11 项，全部在临时目录副本上做，
  夹具来自 `.diagnostics/codex-subscription-readonly-service-20261111/base/index.js`）。
- 已知边界（诚实说明）：因 `baseSha` 被钉死，「hunk `old` 出现两次」在物理上不可达（改字节必然先撞哈希门），
  所以该场景由「基线被改动 ⇒ 写入前拒绝、零写入」等价覆盖。
