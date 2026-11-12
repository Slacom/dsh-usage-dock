# MiMo UI 收尾：详情强刷 / 读失败分级 / 设置页去 Cookie（2026-11-10，终稿）

本包**只改 Browser 半 `client.js`**（单文件），不动 Host 四源、不动认证/transport/record/cfg，
不做网络/真机/账号动作。金额一律是测试用的合成值（11.11 / 22.22），不记真实余额、UID、凭据。

## 1. 本包做了什么

| 需求 | 实现位置（client.js） |
| --- | --- |
| 详情 false→true 强刷余额**一次**（Host 自动 60 s 之外） | `PlanUsageBadge` 内 `mimoRefreshOpenRef` / `mimoManualRefreshRef` + `useEffect([open])`：闸门 = `managed && selected && state==='verified' && freshness!=='paused'` + 渠道 `mimoEnabled===true` + **全局 `enabled===true`（显式对齐契约）**；POST `rememberedRefresh {action,bootEpoch,generation}`；**manual 单独 coalesce**（不因 status 轮询在途而放弃）；**请求前后 store epoch 必须一致**；返回后**先等既有 `mimoDisplayStore.inflight` 落定**，再走**同一个** `mimoDisplayPump()`（load→revision/owner guard→commit→emit） |
| **可信回复的判据不是 `ok===true`** | 普通读失败（第 1..5 次）Host 也回 `ok:false`（failure/readFailures/freshness 已更新）⇒ 同样立刻走 pureStatus，把灰化/隐藏金额+固定原因落到界面，**不再等下一轮轮询**。只有 `reply==null`（传输/超时）、`bootEpoch` 不是本 boot、或 epoch 已变（退出/换代）才跳过。**不**要求 `reply.remembered.generation` 仍等于旧值（本人主动读触发安全终止时会变 0，那时的墓碑正需要马上拉回来清金额） |
| 不额外造定时器/不 retry/不 restore | 强刷只发一次 POST；失败由 Host 的 `readFailures/freshness` 如实反映 |
| 胶囊 no-key 文案 | MiMo 由「请设置 Cookie」改「请先登录」 |
| 读失败分级（fail-closed） | `mimoDisplayPlanOf()` **先**判 `readFailures>=5 || freshness==='failed'`：即使 DTO 仍带 `balance` 也**不显示金额**，`message='余额读取失败'`、`displayFailureText='余额读取失败：<白名单码>'`；`readFailures>0` 即 `stale`（1–4 次保旧值灰化） |
| 原因只进详情 | 胶囊数值/title 只说「余额读取失败」/「登录状态不可用」，不带码/URL/正文；详情分区在 `plan.error` 分支优先渲染 `displayFailureText` |
| **managed 非活态文案** | `stateText`/`shortText`：`managed` 且 `displaySupported!==true` 时——无固定失败码（= 未登录/已退出）→「请先登录」；有已知固定码 →「登录状态不可用」（具体码只进详情，详情给「登录状态不可用：<code>」）。**不再把退出/失败说成「本机未启用（合成边界）」**；legacy 非 managed 文案原样不动 |
| 状态文案（另一支） | `stateText`：`verified+failed`→「余额读取失败」，无余额→「正在读取余额」；`shortText` 胶囊「待读取」 |
| 设置页只留正常态 | `MimoRememberedPanel` 统一 `mimoTiny()`（= `policyTinyButtonStyle` + disabled 样式）：empty/authorizing/awaiting_confirmation（4 勾 + 短确认）/verified（**只**「更新于」「已绑定账号」「退出账号」）/paused（恢复刷新+退出）/failed（重试+退出，保留固定码提示）；扫码、4 勾同意、历史 paused 恢复、失败重试全部保留 |
| 设置页去 Cookie | 删除 MiMo Cookie 输入框、F12 长教程与旧折叠挂载；`MimoAuthMount` 直接挂在卡片下（唯一入口）。顶部设置说明里过时的「Xiaomi MiMo 填控制台 Cookie」删除。**旧 cfg Cookie 字段/值不迁移、不删除**，只是不再有渲染输入 |
| 详情去会话行 | 正常详情不再渲染 `mimoDisplaySessionRowsOf`（身份/取数时间/自动刷新计数/停止按钮）；**函数本体与旧 display 设置调用保留**，legacy 许可/停止路径未动 |
| DTO 严格化 | `remembered`: `readFailures` int 0..5、`freshness ∈ {fresh,stale,failed,paused,null}`；`display`: 新增 `managed`（true boolean）、`readFailures`、`freshness` 闭集补 `failed`/`paused` |
| **display `code` 三张闭集** | 原 display 表 + console 协议码表 + **新增 `MIMO_REMEMBERED_CODES`**（镜像 `remembered-session.js: REMEMBERED_CODES` 中另两表没有的 15 个固定值，含 `E_MIMO_REMEMBERED_READ_TIMEOUT`、`E_MIMO_REMEMBERED_RECORD_UNREADABLE`…）。**逐条显式、不用正则**，未知码仍折叠成 `''` |

## 2. 本轮**真实发现并修掉的 client 侧 bug**

1. **`rememberedRefresh` 不在客户端动作白名单**（`MIMO_REMEMBERED_ACTIONS`）：`mimoAuthRequest` 会在**本地**
   直接返回 `E_UNKNOWN`、**一个请求都不发** —— 详情强刷看起来"什么都没发生"。
2. **只认 `ok===true` 才 pump**：Host 的正常读失败也回 `ok:false`，于是点开详情后第 5 次失败仍继续显示旧金额
   直到下一轮轮询。已改为「本 boot + epoch 未变即可信 → 走 pureStatus」。
3. **display `freshness` 闭集只有 `{fresh,stale}`**：Host 的 `paused` 被折成 `null` ⇒ paused 闸门不可达；`failed` 也无法表达。
4. **display `code` 白名单缺 console / REMEMBERED 固定码**（`E_MIMO_CONSOLE_TRANSIENT`、`E_MIMO_REMEMBERED_READ_TIMEOUT`…）
   ⇒ 详情只能显示 `E_UNKNOWN`，读超时原因丢失。
5. **详情从未渲染失败原因**：`plan.error` 分支只渲 `plan.message`，`displayFailureText` 实际不可达。
6. **managed 非活态被说成「本机未启用（合成边界）」**：退出/失败/空态都在骗人。已按 managed 语义分流。

## 3. 证据（离线、无端口/无网络/无凭据）

`tools/test-mimo-footer-refresh.mjs` —— 真 `PlanUsageBadge` + 真 mimo 单例 store/pump，
owner 路由用 fake fetch：**12 项 0 失败**。

- F1 初始 11.11 → 点胶囊开详情 → `rememberedRefresh` **恰 1 次**（body 严格 `action/bootEpoch/generation`）
  → 纯 `displayStatus` 22.22 → **详情卡片真显示 22.22**；关闭 + 反复重渲染 **0 追加**。
- F2 已有 status flight 在途**不抑制**强刷；flight 落定前不凭空换值，落定后走 pump 提交新值。
- F3 强刷在途时重复 open **合并为 1 次**。
- F4 旧 `generation`、旧 `epoch`（退出/换代）在途 status 晚回包 **都不回填**。
- F5 第 5 次失败且 DTO 矛盾仍带 balance：胶囊/详情**都无金额**，胶囊 title 不带码，详情给白名单固定码。
- F6 第 1–4 次失败：保留旧值并**灰化**（`label-tertiary`）+「历史」；`readFailures>0` 即 stale。
- F7 无历史：中性「待读取 / 正在读取余额」，MiMo 行不出现任何金额符号（不造 0）。
- F8 不适用态 0 次强刷：全局 `enabled:false`（胶囊不渲染）/`mimoEnabled:false`/`paused`（两种 DTO 形态）/非 `managed`/
  `holding`（未登录）/`selected:false`。
- **F9**（改）：`ok:false` + 本 boot + `remembered.readFailures=5` → **立刻**补 pureStatus、金额立即消失、
  详情给 `E_MIMO_REMEMBERED_READ_TIMEOUT`；传输失败（fetch 抛错，无可信 bootEpoch）与 `bootEpoch` 不符 → **不 pump**、旧值不变。
- F10 managed 墓碑（`displaySupported:false` + `selected:true`）遮住 `/api/plan-usage` 里手工 Cookie 旧金额（胶囊与详情），
  且**不含**「本机未启用/合成边界」，空态显示「请先登录」；非活会话不取余额。
- **F11**（新，窄场证据）：从 `plans/mimo-auth/remembered-session.js` 的 `REMEMBERED_CODES` **源码里取出真实值**，
  逐条断言 `mimoDisplay.pick()` 原样保留（含 `E_MIMO_REMEMBERED_READ_TIMEOUT`），自造码 `E_MIMO_REMEMBERED_WHATEVER` 仍折叠成 `''`。
- **F12**（新）：managed 空态「请先登录」（stateText/胶囊/title/详情一致）；managed 失败带
  `E_MIMO_REMEMBERED_RECORD_UNREADABLE` → 胶囊只说「登录状态不可用」、不含码；详情给「登录状态不可用：<code>」；
  legacy 非 managed 的 `stateText`/`shortText` 仍是原「合成边界」/「未启用」。

同批：`tools/test-mimo-refresh-ui.mjs` **5/0**、`tools/test-mimo-remembered-tree.mjs` **6/0**；
非 MiMo 浏览器半回归 `test-footer-row` 12/12、`test-collapsed-pill` 4/4、`test-panel-interactions` 12/12。
上面 6 组**全部用最终 stage 候选字节**跑过（`DSH_CLIENT_UNDER_TEST=.diagnostics/mimo-ui-closeout-20261110/staged/client.js`）
→ 要装的那份字节是绿的。

## 4. 未验边界（不要当成"已通过"）

- **旧测试套未重写、未全跑**：`test-mimo-auth-client.mjs`（C1b/C2 折叠与 entry 结构、postqr 旧结构）、
  `test-mimo-remembered-client-e2e.mjs`、`test-mimo-settings-client.mjs` 的多处断言仍是**手工 Cookie / 旧 UI 结构**
  的预期，与当前 managed 路径不同源。本包只新写 F1–F12，没有回头改这些旧套。
- `test-degrade-refresh.mjs` **38/43**：T9 的 4 项与 T10 断言"胶囊显示手工 Cookie 的 MiMo 余额"。
  用**已装 113C** 同一套跑也是同样 5 项失败（逐条文案一致）⇒ **本包之前就存在**。原因：该套 fetch 桩对 owner 路由
  返回的是取数 payload，拿不到可信 display ⇒ `resolving` 保持 true，MiMo 被 N4「读取中…」占位遮蔽。
  真实部署里"手工 Cookie 值会不会显示"取决于 Host 是否给出可信 absent display（Host 合同，本包未改）——
  不把这条失败说成"旧断言无关紧要"。
- **没有做 Host.route→controller→client 的贯通测试**：客户端用 fake DTO 覆盖；Host 侧由后端包自测覆盖。
  两侧字段对齐是按 `remembered-session.js: displaySnapshot()` / `REMEMBERED_CODES` **读源码逐字段核对**，
  F11 进一步把 controller 的真实码值当输入证据（但仍不是运行验证）。
- 未做真机/未重启/未装 target；`paused`、`readFailures` 的真实取值仍以 Host 为准。
- `E_MIMO_REMEMBERED_*` 之外若有 controller 将来新增的码，需要同步 `MIMO_REMEMBERED_CODES`（这是**有意的**
  白名单维护点：宁可折叠成 `E_UNKNOWN`，也不放宽成正则）。

## 5. Host 合同（本包只消费，不改）

`rememberedRefresh` 走同一条 owner-only 路由，字段严格 `{action,bootEpoch,generation}`；Host
`controller.refresh` 读**当前** balance 一次（单飞、不 retry/不 restore），之后 `displayStatus`（纯观察、0 vendor）
即可拿到新 `display`。**读成功与读失败都回 `{ok,code,bootEpoch,remembered}`**（读失败 `ok:false` + 已更新的
`readFailures/freshness`），所以 UI 必须按"可信回复"而不是"ok===true"处理。`state` 即便 `readFailures===5`
仍是 `verified`（认证有效、只是读失败），公开 `balance=null`、`freshness='failed'`，后台定时继续；
第 5 次之后继续自动读，下一次成功 reset。`displayGen` 只增不减；退出/换号/禁用/安全认证拒绝立即清不适用缓存。
managed 空/失败/已停止给 `selected:true` + `displaySupported:false`，前端遮罩按 `managed||selected`（不要求 displaySupported）。

## 6. 冻结 hunks 与 stage 目标（单文件 `client.js`）

- base（唯一装载基线，已装）：`client.js` = `113C5F0EE99D173A6FA13FB9C28A5CBFAED2D6C612373B1358D2979E2952E1A9`
- 工作区（**含 WorkBuddy 未发布 dirty，绝不可整拷**）：`0964518A4B8C74F94662173CC1D025FF04B479EB02649820592477764A6E475E`
- stage 候选：`.diagnostics/mimo-ui-closeout-20261110/staged/client.js` = **`8F010A7C25349FD25F53E39D4465039B5C10ECB67BAEE8E898F63837E29D509F`**（483219 B，`node --check` 通过）
- hunks：`.diagnostics/mimo-ui-closeout-20261110/client-hunks.json`（`final:true`，**23** 个 hunk，
  每个 `oldString` 在 base 里**唯一命中 1 次**）= `7108597D919244975544BCC93F8279DD345BBA82AF936FA21C68E22431B1301E`
- 生成与自证脚本：`make-client-hunks.mjs`（读 `gen-hunks.mjs` 产出的 `diff-unified3.patch`）
  1. **全部 28 个 hunk** 顺序应用 == 工作区（`0964518A…`）⇒ diff 解析无损；
  2. 只选 23 个 MiMo hunk → staged（`8F010A7C…`），每个 oldString 唯一命中；
  3. **staged + 5 个 WB hunk == 工作区**，且 WB `oldString` 在 staged 原样存在、WB `newString` 不在 staged
     ⇒ 反证"staged 只少了 WB，没夹带其它变化"；
  4. 索引漂移护栏：排除项改动必须含 WorkBuddy 标记；选中项**改动行**不得出现 WorkBuddy。
- 排除的 5 个 hunk（WorkBuddy dirty，**不在本包**，也不擅自还原）：PLANS `credentialNote`、
  `workbuddyAccountLabel()` helper、详情积分行 label/去重、设置页 WB 账号 state、设置页 WB 账号勾选 UI。
- **`goalStageHash ≠ WS hash`**：staged `8F010A7C…` vs WS `0964518A…`。
- 交付边界：**未 dry-run、未写 target、未改 `plan.json`**（写集合/安装由主代理的统一合并包负责）。
