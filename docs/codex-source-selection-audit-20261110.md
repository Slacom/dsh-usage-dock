# Codex 双来源（Connect / Subscription）选源：只读审计（2026-11-10，rev2 事实修正）

范围：**只读 workspace 源码 + 既有程序缓存结构**。未读真实 cfg / 凭据 / 浏览器 / 接口 / env / log，未联网、未跑测试、未部署。
MiMo 已验收 17 件闭包**一字未动**；未写工作区 `client.js`（含 WB dirty 区）。
rev2 修正三处事实（缓存结论、digest 出口位置、默认值取舍叙述），结论方向不变。

## 结论摘要
1. **现状只有一条 Codex 来源**：`plans/codex.js` 固定 `source.provider='dsh-codex-connect'`，实现 `await import('dsh-codex-connect')`；
   client `PLANS`（`client.js:127`）codex = `noCredential:true` + Connect 文案，`fields` 只有 `{ enabled: 'codexEnabled' }`。代码里**没有** `codexSource`。
2. **设置页只有一个真实生效入口**：`PlanUsageSettingsPage`（`client.js:7794`）注册到 `settings.plugins.tab`（`9071–9077`）；grep 未发现仍注册的旧 `PlanSettings` ⇒ 不存在新旧并存。
3. **配置证明未覆盖 codex 选源**：`configDigestOf` 实际定义/导出在 **`plans/custom-balance.js:1735`**（`index.js:45` 只是 import），
   它只读 `customBalances` / `customKeyRev` ⇒ `codexSource` 不进 digest。
4. **codex 当前不缓存（已核实）**：`index.js:76` `ACCOUNT_BOUND_PLAN_IDS = new Set(['deepseek','codex','workbuddy','workbuddy-ai'])`，
   `index.js:1546` 对这类 id `continue`（身份不可证明 → 不缓存、不冻结）⇒ **不需要改 `usage-tool-register.js`**。

## 1. 选源配置落点（最小面）
- `plans/codex.js` 的 `schema` 目前只有 `codexEnabled`（default `true`）。`codexSource` 加在**这里**，走现有 `planSchemaFields()` 的 `.volatile()`；
  client `PLANS` 的 `codex.fields` 增加 `source: 'codexSource'`。
- 单渠道字段，**不需要**新建「全渠道身份体系」。

## 2. 配置证明与代次（未来由主整合，非本轮实施）
- 缺口后果：① 切来源后旧 Connect wire 仍满足 `proof.digest === expectedDigestRef.current`（`client.js:1438`）⇒ **误用旧来源**；
  ② 别的窗口保存 `codexSource` 时本页收不到 epoch ⇒ 旧值不失效（R3/X2 同类）。
- 建议落点：在 **`plans/custom-balance.js:1735 configDigestOf`** 追加拿规范化后的 `codexSource` **domain separator 组件**，
  client 侧 `configDigestOfClient`（`client.js:532`）**同构**同步；
  **保持缺省 `'connect'` 的 digest 值不变**（即：只有 `'subscription'` 才追加该组件，`connect` 不追加），以免既有 custom 摘要 fixture 大改、也不必新增测试面。
- 这样 `generationOfCfg`（`index.js:1722`）与 `appliedIdentity`（`client.js:1672`）自动获得失效信号。
- 不建议本轮上 R2-02 逐渠道身份（改动大、牵动缓存键）。

## 3. 数据隔离（rev2 修正）
- **工具缓存**：`index.js:1492` 的 `cacheable` 集合由采样路径填充，**codex 因 `ACCOUNT_BOUND_PLAN_IDS`（`:76` + `:1546` 跳过）本就不加入**；
  `usage-tool-register.js:219 isCacheable()` 只判**结果形态**，另需该 `cacheable` 许可集合才会真正缓存。
  ⇒ **目前 codex 不会进缓存，本轮无需改 `usage-tool-register.js`**（多改缓存层违反最小范围）。
- **仍需**：`generationOfCfg` / 逐条 `gen` 纳入 `codexSource`，保证**工具与 GUI 切源后互不复用**（见 §2）。
- **客户端状态**：`inflight` / `lastList` / `failStreak` / `appliedIdentity`（`client.js:1672`）按 `expectedDigestRef` 与逐条签名过滤，§2 生效后自动覆盖。
- **提示词/观察链**：`createQuotaObserver` / `createRouteObserver` / `buildQuotaView` / `renderQuotaPrompt`（`index.js:61–64`）从当轮采样投影。
  切源后若残留旧 Connect 采样 ⇒ 提示词沿旧来源说话。**本轮先只要求 fail-closed**（采样来源 ≠ 选中来源 ⇒ 不出该渠道数据），
  **不做**整条提示链的 Subscription 模型路由/新认证，具体边界等 858 公开契约。

## 4. 最小改动清单（清单，未实现；由主整合）
1. `plans/codex.js`：`schema` 加 `codexSource`；`fetch` 按来源分派，**旧 Connect 适配保留不动**。
2. `plans/custom-balance.js:1735 configDigestOf` + `client.js:532 configDigestOfClient`：各追加同步的 `codexSource` 组件（缺省 connect 不追加）。
3. `index.js`：codex 按来源选 provider；未装/未开 ⇒ 统一「未启用」，**不 fallback**。
4. `client.js`：`codex.fields.source` 映射；设置页两行来源（每行都显示 enabled 状态）+ 单选；文案随来源；「未启用」统一；**不合并计数**。
5. **不改** `usage-tool-register.js` / 缓存层（§3）。

## 5. `codexSource` 取值与默认（主已决定，本文照记）
- 枚举**只有** `'connect' | 'subscription'`，**缺省 `'connect'`（保旧）**；**不设 `auto`**、**不后台自动选**。
- **自动发现 ≠ 自动改选择**：设置页两行来源**始终可见并显示各自 enabled 状态**，所以「缺省 connect」**不会**让新来源不可见
  （rev1 中「新来源难被发现」的说法**已删**）。
- 用户可选 `subscription` 并保存一次即生效；**不暗迁移**既有用户。
- 铁律：**显式选择停用来源 ⇒ 只显示「未启用」、绝不 fallback**；**只对选中来源取数**，未选中来源不取额度、不读 token/文件。

## 6. 未核实 / 边界
- **未读** `dsh-codex-subscription` 任何代码/契约（858 负责）。
- 「quota-route 是否已按来源绑定」仅静态推断，实现时以 §3 的 fail-closed 判据兜底。
- 本文不含任何真实账号/金额/票据/URL/配置值。