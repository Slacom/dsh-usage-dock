# dsh-usage-dock 0.9.1 当前状态（供独立审核）

> 更新：2026-10-22（Asia/Shanghai）；最新A操作归属修复见[本地交付记录](fix-custom-operation-v0.9.1-20261022.md)。以下逐轮清单保留为历史索引，以最新修复与冻结验收结论为准。
> 本文只做**状态同步与索引**，不重复论证细节。详细过程见
> [0.9.0 构建与整改记录](quota-policy-build-v0.9.0.md)。
> **本文不含任何真实凭据。** 涉及真实网关的段落只写结构与口径，不写 key 值。

---

## 1. 一句话现状

冻结A/B/C的本地工程修复与行为验收完成：54脚本、1868项校验/场景全部通过，0跳过。原六种时序、GUI旧值撤销、同步同源共享与ABA旧epoch都有真实生产apply加合成服务的门闩验证。

**用户后续授权本机试装，已备份并部署新包，27文件校验一致；未自动重启，等待用户手动重启与新会话测试。**[试装清单与回滚](deploy-local-operation-fix-20261022.md)。已有用户正常GUI/工具运行证据不被否认，但不替代新包试装与真实Host最终context注入/重试验收。策略UI、真实计费池与窗口口径仍是独立未完项，不延长自定义修补主线。

---

## 2. 交付物

| 项目 | 值 |
| --- | --- |
| 包文件 | [本地修复包](../legacy/local-build-0.9.0/operation-fix-20261022/dsh-usage-dock-0.9.0.tgz) |
| SHA-256 | `92DC823AE5ADC8A7CBDC394A6894A02175EE9D7F949C277901C43F3484D00D68` |
| 字节数 | 232905 |
| 文件数 | 27（逐payload与工作区一致，mismatch=0，相对35E946仅3个生产文件变化） |
| 安装状态 | 后续已授权部署desktop profile，27文件mismatch=0；未自动重启，磁盘已部署不等于运行时已加载 |
| 版本号 | 仍是 `0.9.0`（未改 `package.json`，未 commit、未打标签、未 push、未发布） |

---

## 3. 本轮修复清单（按来源索引）

### 3.1 第五轮复核报告（`recheck-custom-provider-v0.9.1-round5-20261020.md`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R5-01 (P1) | 编辑/删除第二张自定义卡实际动了第一张 | 已修：`update`/`remove` 改按稳定 id 定位 |
| R5-02 (P1) | Key 轮换只删元信息，旧数值投影还在 | 已修：完整清理 projection/meta/identity + 推进 epoch；GUI 采样也登记 |
| R5-03 (P2) | 失败缓存钩子传了另一套身份 | 已修：钩子一律自算 `identityOfChannel(id)` |
| R5-04 (P3) | 内置首项上移被重复 `disabled` 覆盖 | 已修：删除重复属性 |

### 3.2 第五轮报告 §1 的用户界面要求

| 要求 | 状态 |
| --- | --- |
| 已有自定义卡片默认折叠 | 已实现（`collapsed` 改为「已展开集合」语义） |
| 折叠/展开按稳定 id 保持 | 已实现（一直按 id，不按数组位置） |
| 新增条目只展开自己 | 已实现 |
| 折叠态保留名称/开关/排序/展开 | 已实现 |
| 视觉与内置卡片一致 | 已实现（去掉整圈边框/圆角/底色，改用上分隔线规范） |

### 3.3 第五轮报告 §10 + 迁移说明：内置 WorkBuddy 改走 WorkBuddy2API 网关

| 项目 | 状态 |
| --- | --- |
| 来源从模型配置解析 `workbuddy` provider | 已实现 |
| `GET <origin>/status`（根路径，非 `/v1/status`） | 已实现 |
| 复用该来源 Bearer Key | 已实现 |
| 回环 HTTP 仅限该网关 | 已实现（`allowLoopbackHttp` 显式开关） |
| 401/404/429/5xx 分类不误译 | 已实现 |

### 3.4 用户三项新需求（2026-10-21 下午）

| 需求 | 状态 |
| --- | --- |
| 去除 WorkBuddy AI 渠道卡片 | 已实现（id 进 `RETIRED_PLAN_IDS`，不再取数/渲染） |
| WorkBuddy 卡片内可选账号、只合计选中账号 | 已实现（新字段 + 新路由 + 勾选 UI） |
| 详情显示具体积分包与到期 | 已实现（`/panel/api/packages` → 复用现有明细渲染） |

### 3.5 第六轮复核（`recheck-v0.9.1-round6-20261021.md`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R6-01 (P1) | 同一个 Key 被两种指纹编码当成不同来源，并自废票据 | 已修：identify 与 GUI 统一 `credentialFingerprint`；首次采样不再失效；`cred=` 退出观察身份 |
| R6-02 (P1) | 内置 WorkBuddy 的来源与账号选择没进观察身份 | 已修：身份追加 `src=`（真实模型来源）与 `acct=`（规范化账号选择） |
| R6-03 (P2) | 可选积分包明细吃掉 8 秒工具预算，已知合计被丢掉 | 已修：明细独立 2.5s 超时；剩余预算贯穿凭据/状态/明细；合计保底交付 |
| R6-04 (P2) | 解析错误把上游正文与合成 Key 哨兵返回 GUI | 已修：只回固定分类 + HTTP 状态，不含正文与解析器原文 |
| R6-05 (P3) | `response.ok` 兼容分支没贯穿调用者 | 已修：状态与明细都改为归一化 `status`/`ok` 判定 |

报告同时确认**已关闭**：R5-01 双卡误写误删、R5-04 首项按钮、全局混排、
自定义卡片新 UI、B12 设置页作用域、B10/B11 网关正文。

### 3.6 第七轮复核（`recheck-v0.9.1-round7-20261021.md`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R7-01 (P2) | 已知 Key A→B 时本次新采样被自己的旧票拒绝（新值空窗） | 已修：`latestTicketOf` 把最新在途票据提升到新代次；更早的迟到旧票仍被拒 |
| R7-02 (P2) | 账号列表/设置路由仍回显解析器原文 | 已修：与主 wire 同规范，只回固定分类 + HTTP 状态 |
| R7-03 (P2) | 预算耗尽后仍发 HTTP，私有任务重获完整 8 秒 | 已修：`capTimeout` 归零即短路、入口/凭据后双重检查、任务预算夹取调用者剩余 |

报告同时确认**已关闭**：R4-01 同 Key 指纹、冷启动首采样、A/B/A 新成功进 context、
WorkBuddy 账号切换撤旧、R6-04 主 wire 脱敏、R6-05 包装 Response、明细 2.5s 保底。

### 3.7 用户新网关（2026-10-21 晚）

WorkBuddy 反代换主机后：`/status` 正常，**`/panel/api/packages` 返回 404**（该反代未暴露面板接口）。
因此**积分包明细不可用**，插件按设计退回「按账号汇总」一行，合计照常显示；
并新增能力记忆（同 origin 10 分钟内不再重试明细），避免每轮白打 404。
这是**上游能力缺失**，不是插件缺陷；换回带面板接口的网关会自动恢复。

### 3.8 第八轮复核（`recheck-v0.9.1-round8-20261021.md`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R8-01 (P1) | 「提升最新票据」把一张挂起的**旧 GUI A 票**升到 B 代次，旧 A 返回后把 context 从 9000 改回 1 | 已修：采样回调必须携带**本次操作自己的票据**；`promoteOwnTicket(pending, ticket, nextEpoch)` 只认「传了票且仍是当前待提交票」；工具 identify / 缓存命中不提升任何票 |
| R8-02 (P2) | 父 signal 已 abort、remaining 仍为正时照常发 HTTP | 已修：入口 / 凭据后 / 明细前三处检查；父取消转发给在途连接与正文；返回 `cancelled` + `stale`，不计 T 失败 |

报告同时确认**已关闭**：串行 A→B 首采样可提交、同 Key 失败门控重试、账号路由固定错误分类、
零/负 deadline、紧预算合计、慢明细保底、包装 Response、404 汇总与能力记忆。

**本轮自查发现的自造回归**：修复中曾把 `onlyIds: allowedCustom` 误删，导致工具请求 A 时也解析 B 的凭据；
既有 `test-usage-tool-host` E4b 当场抓到并已恢复。这不是产品缺陷，但说明行级编辑必须靠测试兜底。

### 3.9 第九轮复核（`recheck-v0.9.1-round9-20261021.md`，按冻结十条验收）

| 根因 | 已改善 | 本轮整改 |
| --- | --- | --- |
| A / P1 操作归属 | 自己的票据不再被无票 identify 提升；串行与旧 HTTP 原例通过 | 新增**操作序号协议**：`beginOp` 在任何异步 I/O 前领号，`isCurrentOp` 校验；采样前置守卫、identify 双入口领号并随快照返回、collect 拒绝过时快照、工具登记全局 pending 票 |
| B / P2 父取消 | 入口零 I/O、连接中传播、共享消费者隔离通过 | 正文读取取消抛 `ECANCELLED` + `await` 后再查一次父 signal，保证归 C 不归 T |
| C / P2 公开异常 | malformed JSON 三出口固定分类 | 新增 `transportCodeOf`，主 wire / 账号列表 / 外层兜底三处只给固定分类，不透传 exception 原文 |

**未闭环**：根因 A 的三条交错时序仍只有源码契约 + 单点行为覆盖，尚未在真实 apply 下重建完整门闩矩阵。

---

## 4. 构建级缺陷：本轮我自己引入并修掉的

单列一张表，因为这几项**不是需求变更，而是实现错误**，且都被真机或回归抓出来过。

| # | 缺陷 | 表现 | 根因 | 守卫 |
| --- | --- | --- | --- | --- |
| B1 | `client.js` 被写成 CRLF | `test-android-compat` 切片标记失效、报语法错 | 用 `Set-Content` 改文件 | `test-line-endings`（68） |
| B2 | 路由注册用 `ctx.webServer.route` | 17 组测试连锁崩 | 该方法不存在，应为 `register` | 各组 apply 时即暴露 |
| B3 | `isCustomId` 未定义 | 渲染即 `ReferenceError` | 函数实际叫 `looksCustomId` | `test-custom-settings` |
| B4 | 单条模式下 `entries` 被抓成单元素数组 | `move()` 重建数组时**丢条目** | 渲染列表与数据列表混用 | `test-custom-order` O1d |
| B5 | `move()` 用渲染下标索引完整列表 | 点「甲」的箭头移动了「乙」 | `renderEntries` 下标当 `allEntries` 下标 | `test-custom-order` |
| B6 | `reorderCustomEntries` 用渲染期闭包 `current` | 连续点两次箭头互相覆盖 | 闭包快照滞后 | 新增 `draftRef` |
| B7 | 内置箭头重复 `disabled` 属性 | 首项按钮启用但无操作 | 对象字面量同名键后者覆盖 | `test-custom-round5` D5 |
| B8 | 失败缓存钩子 `read(id)` 少传 identity | 钩子恒 false，P2 修复等于没做 | 观察器签名是 `read(id, identity)` | `test-custom-round3` S7 |
| B9 | 失败钩子传「批次缓存身份」 | 身份域不同，查不到记录 | 工具身份 ≠ 逐渠道身份 | S7 + `isSourceFailed` 自算 |
| B10 | 网关请求 `finally` 无条件 `abort()` | 成功响应也被掐断 | `Promise.race` 在响应头就 resolve | `test-workbuddy-gateway` G11 |
| B11 | 正文被读两次（`text()` 后又 `json()`） | 永远显示「不是合法 JSON」 | 辅助函数已消费流 | G12 |
| B12 | 设置页用 `locked`（另一组件局部变量） | **整页白屏** | 作用域错用 | `test-custom-round5` D7 |

**B10–B12 的共同点**：都只在**合成对象**上测过。合成 transport 不尊重 `signal`、
允许多次读 body、变量作用域要到运行时才炸 —— 所以三次都是真机先发现。
从 B11 起改为「先回退验证测试会红，再修」。

---

## 5. 验证矩阵（诚实分栏）

### 5.1 已验证（可复现）

| 项 | 依据 |
| --- | --- |
| 本地回归全绿 | 50 组 1630 项 + 行尾 72 + 几何 144 + 契约 7 = **1853 项，0 失败**（逐文件串行执行） |
| 打包一致性 | 27 文件逐 payload 比对，mismatch = 0 |
| 安装一致性 | profile 副本与工作区逐文件 SHA-256 比对，mismatch = 0 |
| **真实网关 HTTP + 真实解析** | 用本机 `config.json` 的 key（未打印）跑 `fetchFromGateway`：`error=undefined`、`creditsTotal=5754`、明细 9 条带到期、账号列表 1 个 `Slacom(5754)` |
| 关键缺陷「先失败、后通过」 | B4/B6/B10/B11/B12 均回退验证过测试会红 |

### 5.2 未验证（不得写成已验收）

| 项 | 说明 |
| --- | --- |
| **真实 DSH 运行时** | 所有 plan 取数测试的 `ctx` 都是合成的。`providerSourceOf` 能否在真实宿主按 `settingsPath` 命中 `workbuddy` 条目，**只有真机重启后才能确认** |
| 「跑一阵就不显示」 | 18.1 的超时修复**未经真机确认**；前两次都被 B10/B11 掩盖，不能算已解决 |
| 真实账号/额度池 | 未证明每次派发实际用哪个账号计费 |
| 窗口业务口径 / 策略 UI / 真实注入与重试 | 一直未做 |
| Android 真机 | 只有模拟宿主与 hooks 契约（14 项） |
| `model_locks`（限流视图） | 只读通结构，未展示 |

---

## 6. 已知未闭环 / 需要用户确认

1. **多账号合计口径**：现为「全部未停用账号之和」，冷却账号仍计入。
   若用户要「排除冷却」或「可用/总数分开显示」，需要改。
2. **积分包明细与 `/status` 合计有差额**：实测 5779 vs 5782（差 3 分），
   属上游自身两套统计口径。当前**合计以 `/status` 为准**，明细只作展示。
3. **账号选择存于配置字符串**（`workbuddyAccounts`），跨设备不同步。
4. **`credits_earliest_remaining`（分段到期）与 `model_locks` 未进 UI**。
5. 版本号仍为 0.9.0，`package.json` 未改。

---

## 7. 给审核模型的入口

| 想复核什么 | 从这里开始 |
| --- | --- |
| 排序与混排 | `client.js` 的 `orderedIds` / `reorderCustomEntries` / `renderOrder` 循环；`index.js` 的 `orderPlansByPlanOrder` |
| 自定义卡片的编辑/删除定位 | `client.js` `update(entryId, …)` / `remove(entryId)` |
| 来源生命周期（删除/继承/变更） | `plans/custom-balance.js` `providerSourceOf` / `providerSourceFingerprint` / `composedConfigOf` |
| 观察器身份与失败缓存 | `plans/quota-observer.js` `read(id, identity)`；`index.js` `isSourceFailed` |
| WorkBuddy 网关 | `plans/workbuddy.js` `fetchJsonWithTimeout` / `creditsFromGatewayStatus` / `creditPackagesOf` / `fetchFromGateway` |
| 账号选择 | 同上 `parseAccountSelection` + `listWorkbuddyAccounts`；`index.js` 的 `/api/plan-usage/workbuddy-accounts` |
| 回归脚本 | `tools/test-custom-round5.mjs`（18）、`tools/test-workbuddy-gateway.mjs`（51）、`tools/test-custom-round3.mjs`（20） |

**建议的审核顺序**：先看 B10–B12 是否真的修好（这三个最容易再犯），
再看 R5-01 的 id 定位是否覆盖全部字段，最后看 WorkBuddy 的多账号口径。
