# R1–R5 修复与最小验收报告（2026-11-25）

> 审核基线：`docs/release-review-v1.0.0-20261125.md`；候选版本 `.9`。
> 本轮只改工作区，**未部署、未重启、未提交、未发布**；等待用户确认是否定版。

## 组合验收

- 产品文件 `node --check`：`index.js`、`client.js`、`plans/mimo.js`、`plans/codex-account.js`、
  `plans/dsh-go-native.js`、`plans/usage-tool.js` 全部 exit 0。
- 关键 9 套件合计 **680 项全过**：

| 套件 | 项数 |
| --- | ---: |
| `test-mimo-api-key` | 42 |
| `test-codex-account-generation`（新增） | 28 |
| `test-codex-account` | 267 |
| `test-codex-account-host` | 47 |
| `test-codex-account-ui` | 103 |
| `test-dsh-go-native` | 55 |
| `test-dsh-go-boundaries` | 29 |
| `test-degrade-refresh` | 41 |
| `test-line-endings` | 68 |

---

## R1 · P1 · MiMo 自动取 Key 绑定主机

**改动**
- `plans/mimo.js:54` 新增 `TRUSTED_MIMO_ORIGINS = {'https://api.xiaomimimo.com'}`。
- `plans/mimo.js:70` 新增 fail-closed 的 `trustedMimoOriginOf(baseURL)`：必须 HTTPS、无 userinfo、
  无显式端口（含 `:443` 原文判断），规范化 origin 精确命中集合；路径可带 `/v1`。
- `plans/mimo.js:121` 在名称命中之后、读取 `apiKeyEnv` 之前校验来源；不可信直接 `continue`，
  **不调用 `creds.resolve`**。`hasMimoApiKey` 与 `fetchPlan` 共用同一 `providerKeyOf()`。
- 显式 `mimoApiKey` → 固定候选名 → provider 自动匹配的优先级不变。

**最小验收**（`tools/test-mimo-api-key.mjs`，42/42，exit 0）
- 第三方 `mimo-relay` / 仅 displayName 命中：不解析 provider Key、`hasMimoApiKey=false`、
  `fetchPlan` 固定 `no-key` 且零请求。
- 可信 `https://api.xiaomimimo.com/v1`：自动选中，唯一请求固定余额端点，头为 `api-key`。
- 缺失/非 URL/HTTP/`:8443`/`:443`/userinfo/相近域名全部 fail-closed。
- 显式 Key 优先；固定候选名在第三方 provider 存在时仍生效。
- 负向对照：临时去掉 origin 闸门后 14 项失败，恢复后 42/42。

**限制**：只信任 `api.xiaomimimo.com`；其它自建 Xiaomi 代理即使名称命中也不会自动取 Key，
但显式插件 Key / 固定候选名仍可用。

---

## R2 · P1 · 外部切换账户后网页灰显旧额度

**改动**
- `index.js:2024–2056`：在 `plans.map(guiObservationWire)` 之后，用**该批采集的 ticket**
  （不是响应时当前身份）给 Codex 条目附：
  - `codexGeneration` = `sha256('codex-gen|' + ticket.identity + '|' + ticket.epoch)` 前 16 位；
  - `codexGenerationOrder` = `ticket.epoch`（不用 `ticket.seq`，避免每轮轮询都换代）。
- `client.js:1857`：模块级 `codexPlanGenerationOrder = -1`。
- `client.js:2851–2862`：
  - `order < 水位`：忽略该 Codex 行，`seen` 置位，保留当前已应用行；迟到 A 不回填；
  - `order > 水位`：推进水位、作废旧值/失败计数，B 首次暂时失败不会回退 A；
  - `order` 相同：正常处理，B 自己的短期失败仍可灰显 B 的缓存；
  - 旧 Host 无字段时行为不变。
- 代次为不透明哈希/整数，不渲染、不写日志、不含账号/凭据。

**最小验收**（`tools/test-codex-account-generation.mjs`，28/28，exit 0）
- A 成功（order 0）→ B 失败（order 1）：A 的额度消失，显示失败/等待。
- 迟到 A（order 0）：不覆盖 B。
- B 成功（order 1）→ B 短期失败（order 1）：仍灰显 B 自己的值。
- 换代 order 2 后迟到 A 仍被忽略；老 Host 无代次字段仍接受。
- 真实 `apply()` 离线 H 组：连续两次轮询 order/generation 稳定；select 后 order 增加且再稳定；
  无账号/凭据/邮箱泄漏。
- 负向对照：去掉客户端代次块会复现 A 回填；用 `ticket.seq` 会使同一代次失败被误判换代。

**限制**：Host 半重启会把 epoch 归零；若浏览器页面不刷新且水位已 >0，新的 Codex 行可能被当成旧代次
直到刷新。当前最小验收限定同一 Host 生命周期；如要覆盖热重载，需再加 Host boot id。

---

## R3 · P2 · 旧 Codex 补丁 POST 仍可写第三方插件

**改动**
- `index.js`：删除 `POST /api/plan-usage/codex-subscription/apply-patch` 整段注册；
  删除 `codexAdaptStatusForNative()` / `applyCodexPatchOnce()` 及 `registerDshGoSurface` 的
  `codexAdapt` / `codexAdaptApply` 两个依赖键。
- 保留 `GET .../codex-subscription/patch-state` 只读路由、`plans/codex-subscription-patch.js`
  与 `plans/patches/**` 清单；`tools/patch-codex-subscription.mjs` 仍可解析其依赖。
- `plans/dsh-go-native.js:1629` 注释改为“Host 已不再传两个回调”，不重新引入适配视图。
- `tools/mock-react.mjs` 删除已无消费的 apply-patch 分支。

**最小验收**
- `test-dsh-go-native` **55/55**（新增 2 项）：真实 `apply()` 假注册器记录 11 条路由，
  **无 apply-patch**，`patch-state` 仍在；源码 deps 无 `codexAdapt:` / `codexAdaptApply`。
- `test-dsh-go-boundaries` 29/29、`test-codex-account-host` 47/47、`test-line-endings` 68/68。
- `tools/patch-codex-subscription.mjs` 的 import 解析成功，未执行补丁写入。

**限制**：只读 `patch-state` 仍暴露本机第三方包版本/适配状态；无写能力。维护 CLI 仍在仓库中，
需要用户显式执行。

---

## R4 · P2 · 网页切换 200 `ok:false` 静默

**改动**
- `client.js:1185–1208`：`selectAccount()` 只在 `body.ok === true` 时算成功；
  `ok:false` / 非对象 / 缺 `ok` → 设置现有 `CODEX_ACCOUNT_TEXT.selectFailed`，
  再 `refreshAuthoritativeState({ keepNotice: true })`；Host 的 active 保持原账户，
  轮询/操作恢复可交互；`attemptRef` 继续丢弃过期回包。

**最小验收**（`tools/test-codex-account-ui.mjs`，103/103，exit 0）
- `200 {ok:false}`：固定失败文案可见，acc-1 仍 active，radio 可重试，账户身份/epoch 不变。
- 失败提示在后续 state 刷新/重渲染后仍保留。
- 对照 `200 {ok:true,data:<B state>}`：acc-2 active，提示清除。
- 负向对照：忽略 `ok:false` 的客户端会使 C4e/C4f 失败。

---

## R5 · P2 · 移除最后账户竞态

**改动**
- `plans/codex-account.js:132` 新增精确空态 tombstone：
  `{kind:'grant', payload:{version:2, activeAccountId:null, accounts:[]}}`。
- `:143` 只认精确形状；`:394` 校验为空态 ⇒ `{state:'absent'}`；其它空账户形状仍 `incompatible`。
- `:1470–1526` `removeCodexAccount()` 最后一个账户分支改为**单次 `modifyRecord` 原子写 tombstone**：
  - 当前 absent（含 tombstone）⇒ 幂等成功；
  - 只剩目标 ⇒ 写空态，身份 none；
  - 已有 B ⇒ 正常移除 A、保留 B，返回 active B；
  - 目标不在/记录变坏 ⇒ `not-found`/`incompatible`；写抛错 ⇒ `write-failed`；
  - mutate 内**无 `deleteRecord`、无二次取锁**。
- `clearCodexAccount()` 的 delete 语义保持不变，仅用于坏记录恢复/显式整条清理。
- `defaultSaveCredential()` 读到 tombstone 时按 absent ⇒ accounts=[] ⇒ 可正常新增 B。

**最小验收**
- `test-codex-account` **267/267**（+25）：
  - 无并发：移除唯一 A ⇒ 精确 tombstone、零 delete、身份 none、state 未登录；之后新增 B 成功。
  - 竞态：B 在 remove 独占写前先落库 ⇒ remove 只移除 A、B 仍在且 active、B 的 token 字段一字节不丢、
    不挂起（3 秒守卫）。
  - 对照：A+B 移除 A ⇒ 普通 v2 只剩 B、零 delete。
- `test-codex-account-host` **47/47**（P6 改 tombstone 预期，新增 P3g 坏记录仍走 delete）。
- `test-line-endings` 68/68。

**限制**：最后账户移除后凭据服务里仍保留一条 0 账户的 `grant` 记录（所有插件读路径都当未登录）；
这是避免删除竞态的兼容方案，若其它 UI 枚举原始记录会看到它。

---

## 结论

R1–R5 的 P1/P2 均已按审核目标修复并通过离线最小验收；无联网、无真实配置/凭据读取、
无部署、无提交、无版本变更。等待用户确认是否定版发布。
