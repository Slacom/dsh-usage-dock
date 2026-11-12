# MiMo「记住登录」managed 模式：**真实 client.js 点击**验证（2026-11-07，独立测试包）

范围：只新增 `tools/test-mimo-remembered-client-e2e.mjs` + 本文。**不改任何源码、不部署、不重启、不发布**；
不使用真实账号 / 二维码 / 余额 / DPAPI / 凭据记录，不调用真实 `ctx.get('credentials')`。

## 1. 这套测试到底是什么

| 层 | 真实 / 合成 |
| --- | --- |
| 组件 | **真实** `client.js`（`loadClient` 加载整份文件），`mimoAuth.Panel`（`MimoAuthMount` 闸门）→ 从真实渲染树里取出 managed 面板组件挂载；点击/勾选都打真实 `onClick` / `onChange` |
| 传输 | `globalThis.fetch` 桥接到**真实** `createAuthHost` 注册的 owner 路由 handler（`/api/plan-usage-mimo-auth`、`/api/plan-usage-mimo-qr`） |
| Host/协议 | **真实** `remembered-session` → **真实** `console-protocol`（A1 authority + `secure-transport`）→ **真实** `createRememberedVault` |
| 合成 | 只 fake：DNS + `node:https` request、DPAPI crypto（XOR 假 crypt）、宿主 credentials provider（`modifyRecord` 真串行排队）、`URL.createObjectURL`、Host/客户端定时器、合成 `profile` scope |

即「除 IO/OS 外全真」。没有往测试里塞 fake Host 响应来冒充全链：所有 UI 断言背后都真的打到了 owner 路由；
唯一的例外是 §5 的两 boot 屏障，那里只是**控制两个真实响应的交付顺序**（响应仍由各自的真实 Host 生成）。

运行：

```powershell
node tools/test-mimo-remembered-client-e2e.mjs
```

## 2. 实测轮次（同一套 99 断言，没有放宽）

| 轮次 | 状态 | 结果 | 留档 |
| --- | --- | --- | --- |
| R1 基线 | f195 的 7 项修正**之前** | `39 passed, 54 failed (93)` exit 1 | `.diagnostics/mimo-client-e2e-baseline-20261107.txt` |
| R2 | f195 7 项 + 设置页单 Panel wrapper；并修掉我的 3 个测量时序缺陷 | `78 passed, 21 failed (99)` exit 1 | `.diagnostics/mimo-client-e2e-after-f195-20261107.txt`、`...-run2-...txt` |
| R3 | client `5AB1C702` / session `C3FCE6E2` | `79 passed, 20 failed (99)` exit 1 | `.diagnostics/mimo-client-e2e-run3-20261107.txt` |
| R4 | client `0535E89C` / session `ACE30C2D`（displayRememberedView） | `98 passed, 1 failed (99)` exit 1（唯一红是 `G1` 的 fixture 前置） | `.diagnostics/mimo-client-e2e-final-20261107.txt` |
| R5 收口 | 同 R4 source，只把 `G1` 前移到 `F1 forget` 之前 | **`99 passed, 0 failed (99)` exit 0** | `.diagnostics/mimo-client-e2e-final2-20261107.txt` |
| **R6 回归（Max midflight-disable 修正后）** | client `0535E89C47F45493` / session `F4B31554CEC3D65C` / routes `222D31E6E688FF27` / host `C0BC22C813668D5F` / index `BDE16765E244D2B8` | **`99 passed, 0 failed (99)` exit 0** | `.diagnostics/mimo-client-e2e-regress-20261107.txt` |

R6 只跑一次、未改断言/时点/fixture：新增的本地 enabled watcher（config 事件立即 probe + ≤1 s 兜底、`syncEnabled` 初始 false、先 probe 再 boot、false 主动 disable 不 forget）
没有扰动本套的 boot 与时钟语义 —— `C2 Host 仍按 5 min 计数/每周期只 1 读`、`D2 暂停态重启 0 请求`、`D3 resume 3+1`、`E1 未暂停重启 3+1`、`G1 陈旧 gen 409+0 副作用` 全绿。
注：本套只用 `isEnabled: () => true` 的合成开关，**未覆盖**「关闭渠道」分支（那是 High858 的 Host 反例范围）。

R2→R3 之间只改了「测量时点」（5 跳改到扫码完成后取；屏障的「采纳」与「迟到改写」拆成两条），断言未放宽。

R2 之前修的是**测试侧缺陷**（不改任何断言语义）：
- 面板走 3 s 轮询，原实现在两次捕获之间不发观察 → 断言读到上一状态的树。现在 `settlePanel()` 先给一轮真实观察再渲染。
- 假 IO 会在一帧内完成「扫码」，`authorizing + hasQr` 的真实窗口观察不到。现在给等待扫码的 lp 跳加可控闸门，扫码前先验二维码，再放行进入待确认。
- «5 跳» 原来在放行扫码**之前**取（此时 `sts` 还没发生），已改到扫码完成后取，仍要求恰好 5 跳。

R2 已转绿的关键链路：真实点击 → `rememberedStart/consent1` → `rememberedBegin`（带 pair）→ 5 跳 → **QR 本机二进制 objectURL + `<img>`** → 待确认候选（完整 ID + 「小米账号ID」+ 明说无昵称）→ 四项勾选 → `rememberedConfirm`（version1 + 四项 true + authId/gen/boot，且不带 ID）→ **密文 1 条无明文** → **首读 1 次** → verified/`intervalMs=300000` → 候选与 QR 清空 + objectURL revoke → 侧栏显示 Host 真值、不被 manual `99.99` 顶回 → 收起 settings 后 UI interval 已清、Host 5 min 仍计数、每周期只 1 读、刷新不计换票 → pause 持久化且不显示 fresh 旧值 → 跨 Host dispose 密文保留 → 暂停态重启 0 请求 → 生产设置页 managed 只挂一个 Panel 且无旧话术 → 请求层 `H1-H4` 全绿 → `Z1` 无未捕获异常。

## 3. R3 的 3 个独立根因（R4 已全部消除，留档用）

1. **合同 C 泄漏：`displayStatus` 带出候选完整账号 ID** —— 根因 `remembered-session.js:336 displaySnapshot()` 把 `snapshot()` 原样嵌入，
   而 pair 栅栏只管 `/rememberedStatus`。探针 `.diagnostics/probe-id-leak-20261107.mjs`。
   **R4 状态：已修**（`displayRememberedView` 显式 `candidate: null`），断言 `A4 候选 ID 不进 displayStatus`、`G4` 绿。
2. **零代次被客户端丢弃** —— 重启后 paused 快照 `generation=0`、`canResume: true`；路由**接受** `generation: 0`（探针
   `.diagnostics/probe-paused-generation-20261107.mjs`），而 `client.js:4777` 的 `> 0` 条件把它丢掉 → 400。
   **R4 状态：已修**（按快照原样回传，含 0），`D3 点击「恢复刷新」`后 4 项 + `F1 forget 写 tombstone` + `G3` 全绿。
3. **boot 屏障单向** —— 旧实现「boot 只固定一次」，Host 重启后新 boot 永不被采纳。
   **R4 状态：已修**（latestDiscSeq 权威发现 + epoch/expectedBoot 绑定 + 同 boot 用 revision 拒旧），
   `E3 新 boot 先返回即被采用（66.6，不残留 42.75）` 与 `E3 迟到的旧 boot 结果不得改写当前显示` 两条都绿。

## 3b. `G1` 的处理（R4 曾报 98/1，R5 已实测通过）

R4 里 `G1 当前无 generation 可测陈旧控制动作` 报红，原因是**测试前置不足**：该组跑在 `F1 退出并忘记`之后，
Host 已是 `empty`、`generation=0`，没有可用的陈旧 generation 对照（不是源码缺陷，当时也不据此声称 source 已绿）。

R5 按主决定只做**测试顺序调整**（断言语义与总数 99 不变，不动业务源）：把 `G1` 前移到 `E1` 之后 —— 那里是**真实 verified**、
带当前 generation 的 fixture，并且真正发送**陈旧 generation 的 `rememberedPause`**（不是拿错 confirm 替代），断言：

- `409` 且 `code === 'E_MIMO_REMEMBERED_STALE_ID'`；
- 0 副作用：`state/generation/revision` 不变、`provider.writes` 不变、上游跳数不变。

R5 结果：`G1` **PASS**（实测 409 STALE + 快照/写/上游三者均未变），整套 `99/0 exit 0`。

## 4. 断言覆盖（对应任务书的 6 条合同）

| 合同 | 断言组 | 说明 |
| --- | --- | --- |
| 1 首扫 | `A0-A4` | 闸门→managed 面板、无任何输入框、点击「创建二维码并登录」后 5 跳、确认前 0 余额 0 写、QR 本机二进制 objectURL、候选只在待确认 UI 且不造假昵称、caps/displayStatus 无完整 ID |
| 2 确认 | `B1-B2` | 4 复选框未勾满即禁用；请求 = version1 + 四项 true + authId/gen/boot 且不带 ID/expected/revision/ticketId；密文 1 条无明文；1 次余额；verified + `intervalMs=300000`；侧栏真值不被 manual `99.99` 顶回 |
| 3 离开待确认 | `C1-C3` | 候选与 QR 清空 + objectURL revoke；侧栏仍显示 Host 值；卸载 settings 后 UI interval 已清、「Host 5 min 仍计数」、每周期只 1 次读、普通刷新不计换票；重开后反复观察 0 上游 |
| 4 暂停/重启/恢复 | `D1-D3`、`E1` | pause 持久化 `paused` 且快照余额 null（不冒充 fresh）；dispose 保留密文；同 scope 新 Host 暂停态 0 请求；resume 先 3 跳核 ID 再 1 跳读、不需扫码/手填 ID；未暂停重启自动 3+1、0 QR、restore 计数真实 |
| 5 忘记/竞态 | `F1-F2`、`E3`、`G1` | forget 第一帧即清值、tombstone、0 上游、绑定当前 generation；tombstone 后重启 0 请求；取消待确认只本地清、0 写 0 余额；陈旧 generation 控制动作 409 0 副作用；两 boot 交付顺序屏障 |
| 6 路由硬化 | `G2-G4`、`H*` | 缺同意 flag / 错 boot / 未知字段 / 确认带 ID / 少一项授权 = 400-409 且 0 写 0 上游；UI 发出的 `remembered*` 无一条被后端拒；UI 请求不含 ID/expected/revision/ticketId；响应正文无 passToken/原始 ID/上游 URL/scope；面板文案从不出现「15 分钟」「14 次」 |

## 5. 未证边界 / 运行前提（不要当成已通过）

1. **未证**：真实 DPAPI、真实 credentials 记录、真实 MiMo/小米接口、真实二维码与余额；全套仍只在本机合成边界。
2. **未证**：`host.js` 的 `resolveVault()` 懒加载分支（本套注入 `rememberedVault`，不碰真实 `ctx.get`）。
3. **未证**：restore 10 s / QR 120 s 的**时长**本身——本套只验证 `intervalMs=300000`、与「120 s 待确认窗口」相关的
   状态文案，不伪造时间流逝去掐 10 s 预算。
4. 本套驱动 UI 轮询用的是**受控 `setInterval`**（`loadClient` 会把 `setInterval` 打桩，测试随后换成可控队列）。
   若后续把面板观察改成别的机制（store 订阅 / `setTimeout` 链），`clientTick()` 与 `C2 interval 已清理` 两条需要同步调整；
   其余断言不受影响。
5. mock 运行时**不展开子组件**：本套从真实渲染树里取到 managed 面板组件再挂载（不是手写 UI）。
6. 一个 93 项里 39 项通过 = **合同里的「不该发生」类断言**（0 余额、0 写、无 ID 泄漏、无 15 min 文案）在基线上天然成立，
   不代表功能可用；判据是整份转绿。

## 6. 归因约定（复跑报告用）

复跑若仍有红，报告按**层**分开写，不把后端的红算到 UI 头上、也不为了变绿去拆 fake Host：

| 层 | 断言组（名字前缀） | 红了该找谁 |
| --- | --- | --- |
| 客户端渲染/点击 | `A0-A4`、`B1-B2`、`C1-C3`、`D1`、`D3`、`E3`、`F1`、`F2` | `client.js`（UI 唯一 writer f195） |
| 客户端请求层 | `H1-H4` | `client.js` 请求白名单/body 组包（f195） |
| 路由合同 | `G2`、`G3`、`G4`、`E2`（错 boot 409） | `plans/mimo-auth/routes.js`（f195） |
| Host/controller 行为 | `D1-D3` 的 `stats/密文/paused` 部分、`E1`、`G1`、`A2` 的「5 跳」、`B2` 的「1 次余额/1 条密文」 | `plans/mimo-auth/remembered-session.js` + controller epoch/gen 栅栏（High858） |

同一项若既依赖点击又依赖 Host 结果（如 `B2` 的余额、`D3` 的 3+1 跳），以「UI 已过、后端未过」的措辞报，
并注明该项不是 UI 缺陷；不会改成 fake Host 让红变绿。
