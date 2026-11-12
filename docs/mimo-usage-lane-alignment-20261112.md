# MiMo `usage_status` 对齐胶囊 lane（2026-11-12，未部署）

> 用户明确要求：模型的 `usage_status` 与**胶囊**看同一份 MiMo 事实。
> 只改 `usage_status` 的读数来源；**未**改胶囊渲染、**未**改 `plans/mimo.js`、**未**改 UI 语义。
> 全离线开发与测试：未部署、未联网、未读真实 cfg/凭据/record。

## 1. 两条 lane 的事实（改动前）

| lane | 数据来源 | 真机表现 |
| --- | --- | --- |
| 胶囊 | `plans/mimo-auth/session-display.js` 的**显示快照**（客户端 `mimoDisplayOverlay` 用 `/api/plan-usage/mimo-*` 覆盖 wire） | `¥14.58` |
| `usage_status` | `plans/mimo.js#fetchPlan`（旧 Cookie / API Key lane） | 「上游拒绝请求（api）」 |

同一渠道同一时刻给出矛盾结论；模型结论还会进入额度策略与提示词，所以这是**事实不一致**。

## 2. 为什么这样改

`registerMimoAuth(ctx, onStatus, options)` 的返回值里本来就有 `display`，其 `peek()` 返回
**零 IO** 的显示 DTO（只读内存：不读凭据、不发请求、不 import 第三包）。因此不需要新路由/新服务，
只要把这份 DTO 折成工具能投影的 wire。两条硬规则：

1. 快照**不适用**（未选中 / 读不到）⇒ 仍走原 provider，行为与改动前一致；
2. 快照**适用**（`selected === true`）⇒ 无论成功失败**都不再碰 provider**（零 import/构造/请求）：
   成功用其数值，不在 `verified` 就如实报 `missing`，绝不回落到会打上游的旧 lane。

## 3. `mimoDisplayWire()` 的闭集规则

输出只有三种可能，**只有**下面这些键：

- `null`：`snapshot` 非对象/数组，或 `snapshot.selected !== true` ⇒「不适用」；
- `{ id:'mimo', name:'Xiaomi MiMo', error:'missing' }`：
  `selected === true` 但 `state !== 'verified'`（`holding`/`stopped`/`expired`/`absent`/未知）；
  或 `state === 'verified'` 但 `balance` 不是对象、`balance.balance` 不是**有限非负 number**、
  `balance.currency` 规范化后不匹配 `/^[A-Z]{2,8}$/`（缺失/非法**不默认 CNY、不造 0**）；
- `{ id:'mimo', name:'Xiaomi MiMo', balance:<number>, currency:<CODE>, fetchedAt?:<ms> }`：
  金额只认 `number`（`"14.58"` 不做 `Number()` 猜测）；币种先 `trim().toUpperCase()` 再校验，
  **只有通过校验后才使用规范化值**（`'cny'`→`'CNY'`）；`fetchedAt` 仅在非负有限数时出现，
  否则该字段**直接省略**（不写 null）。

**零泄漏**：`identity`/`code`/`accountId`/`revision`/会话 Cookie 一律不透传；键集合钉死在闭集里
（测试 L2 用哨兵断言）。**异常**：函数内 try/catch，任何抛错都返回 `null`（不适用），
绝不让快照形状问题把工具带崩。

## 4. 接线（`index.js`）

- `const mimoAuthHost = registerMimoAuth(...)`：**只接住返回值**，`onStatus` 语义未改；
- `mimoDisplayPeek` 包成 `{ peek }`（try/catch → `null`，零 IO）；
- `collectPlans` 的 provider 循环里**在调用 provider 之前**判断：`plan.id === 'mimo'` 走
  `mimoWireWithDisplay(mimoDisplaySource, fetchOnce)`，其它渠道原样 `fetchOnce()`；
- `ACCOUNT_BOUND_PLAN_IDS` 加入 `'mimo'` —— 显示快照的数值来自**控制台会话 / 记住登录**，
  不是配置里的 Cookie 原文：会话切换、记住登录失效、控制台侧换账号都可能**不改配置**却换掉余额。
  若仍按「配置哈希 + 30 秒成功缓存」缓存，工具会把**上一账号/上一会话**的余额当成当前值回答。
  因此 mimo 不进工具缓存、不共享在途结果、也不冻结凭据（身份一致性改由 `identityOfChannel()`
  的 `cookie=` 指纹 + 票据校验兜住，与 deepseek 等账号型渠道同一套机制）。

## 5. 测试

| 套件 | 项数 | 结果 |
| --- | --- | --- |
| `tools/test-mimo-usage-lane.mjs`（新增） | 31 | 全过 |
| `test-usage-tool` / `-register` / `-host` | 108 / 70 / 41 | 全过 |
| `test-usage-integration` / `test-usage-policy` / `test-mimo-parse` | 31 / 89 / 21 | 全过 |
| `test-codex-sources`（`DSH_INDEX_UNDER_TEST` = 批次 C staged） | 88 | 全过 |

新套件分组：L1 纯函数闭集、L2 零泄漏哨兵、L3 快照适用时 provider **零调用**、
L4 不适用时 provider 调用一次且返回值原样透传、L5 真实 `apply()` 冒烟
（默认未选中 ⇒ mimo 仍走原 provider、如实报 `no-credential`）。

## 6. 未验证边界（不得据此宣称已完成）

1. **`verified` 端到端未离线验证**：`peek()` 只有在真实「记住登录」会话下才 `selected:true`，
   fake ctx 造不出；L5e/L5f 因此退化为**源码接线守卫**。真实 DTO 形状只能本机实测。
2. **`stopped`/`expired`/`holding` 的实机表现未观察**：本轮按契约一律 `missing`，
   没有实机样本证明这就是用户想要的措辞。
3. 「切账号后工具立刻换值」的时序未实机验证：只验证了「不进缓存」这条接线，
   另两个前提（`cookie=` 身份、票据校验）沿用既有机制。
4. 未部署、未重启：`staged/index.js` 只是候选字节，未在真实 Host `apply()` 上跑过。
5. 未改 `plans/mimo.js`：快照不适用时旧 lane 仍是唯一来源，其既有缺陷（上游拒绝）不变。
