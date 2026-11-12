# dsh-usage-dock 0.10.2

> 0.10.2 收敛 MiMo 的登录入口与读数通道，并给 Codex `Subscription` 加一键适配。
> **0.10.1 已撤包**（`npm unpublish`），其内容（补丁 CLI 工具与 hunk 清单）已并入本版。

## 更新摘要（GitHub Release 正文）

- **MiMo 卡片干净了**：未登录时只看到「未登录（点击登录）」+ 一个登录按钮 + 一行提示；
  开发者措辞（实验性/合成边界/阶段语义）不再出现在界面上。
- **MiMo 只用扫码登录一条通道**：不再读取旧的 Cookie，因此「控制台登录态已过期 / 请复制新的 Cookie /
  API error code 401」这类旧错误不再出现。**已有配置不会被清除**（`mimoCookie` 原样保留，只是不再读取）。
- **Codex `Subscription` 可一键适配**：设置页看到「需适配」时点「应用本地适配」即可，
  不用再手工跑命令；应用后需重启 DSH 生效，`Codex Connect` 来源始终不受影响。

## 工程细节（维护者用）

- MiMo 单通道：`plans/usage-tool.js` 的 `mimoWireWithDisplay()` 语义改为「快照不适用 ⇒ 固定
  `{error:'missing'}`，**零请求**」，GUI 路由与 `usage_status` 两处共用同一 helper（`fetchProvider`
  参数仅保留调用形状，不再被调用）。`plans/mimo.js` 保留（纯函数仍被 `test-mimo-parse` 使用），
  但**产品路径不再调用其 `fetchPlan`**——若后续确认全死，再决定是否删除。
- 一键适配：逻辑抽到 `plans/codex-subscription-patch.js`（CLI 与 Host 共用），清单
  `plans/patches/codex-subscription-3.2.6.json` 随包发布；目标包目录由模块自身位置推导，
  不接受客户端传入的路径/版本；`POST` 拒绝任何非空请求体（`E_CS_PATCH_ARGS`）。
  写入纪律与 CLI 同构（`wx` 备份 → 同目录 `wx` 临时文件 → 读回校验 → `rename` → 校验新哈希），
  已适配时幂等返回 `applied:false`；失败码限定 `E_CS_PATCH_*` 闭集，不回显堆栈或源码。
- 回归：`test-mimo-usage-lane` 62 项（含单通道零调用与用户可见文案哨兵）、
  `test-patch-codex-subscription` 21 项（含共用模块状态三态/幂等/失败零写入）、
  `test-codex-source-ui` 新增 **Q1–Q8**（组件层 6 条 + 接线层 2 条：按钮出现/不出现、
  点击恰好一次 POST 且无 body、成功/失败文案、失败文案不含错误码、`writable:false` 时 disabled、
  `incompatible` 与 `ready` 两种夹具的 props 区分）。Q 段断言**计入退出码**（已用「故意失败的副本」验证 exit=1），
  但该套件原有的「79 项」汇总行在 Q 段之前打印，因此另加了一行「累计（含 Q 段）」。
- 补丁 CLI（随 0.10.1 引入、本版继续提供）：`tools/patch-codex-subscription.mjs`
  （默认 `--check` 只读 / `--apply` / `--revert`）+ `tools/patches/codex-subscription-3.2.6.json`。
  **注意该工具在仓库里，不在 npm 包内**（`files` 不含 `tools/`）；包内提供的是 Host 侧
  `plans/codex-subscription-patch.js` 与同一份 hunk 清单，供「一键适配」使用。
- 诚实说明：Host 那两条路由（`patch-state` / `apply-patch`）**没有**路由级端到端用例——
  handler 与共用模块是同一实现，模块层已覆盖；路由接入只在真实 profile 上做过只读检查。
