# WorkBuddy 积分「获取失败」与设置页无可用账号（2026-10-30）

> 状态：**开发仓库已补 / 待审核与部署（2026-10-30）；运行期仍靠 `workbuddyAccounts: '[]'` 规避。**
> 本文只记录结构、口径与复现证据，不含任何真实 Key、Cookie、账号 ID 原文或网关正文。
> 仓库内「哪些早已修、本次只补了什么证明」见 §9；§1–§8 是 2026-10-30 的现场事实，不改写。

## 1. 现象

- 侧栏 WorkBuddy 行显示「获取失败」；Host 内部 `failCount` 已累计到 94。
- `GET /api/plan-usage` 的 WorkBuddy 条目返回：

  ```json
  {
    "id": "workbuddy",
    "error": "exec",
    "message": "WorkBuddy：网关状态响应里没有可用的积分字段（已确认的字段为 accounts[].credits）",
    "effectiveStatus": "failed"
  }
  ```

- 设置页 WorkBuddy 卡仍显示旧版「账号合计 / 勾选账号」UI，账号列表为空：
  「没有可用账号（或网关未配置/未启动）」，并曾带出过「网关返回 HTTP 502」。

## 2. 运行版本与版本差

| 项 | 值 |
| --- | --- |
| 实际加载的 desktop profile 副本 | `dsh-usage-dock@0.9.0` |
| 当前开发仓库 | `0.9.1-dev.wbcredits.20261025.3` |
| 取数路径（0.9.0） | `GET <model origin>/status`（根路径） |
| 账号筛选（0.9.0） | 仍读取 `cfg.workbuddyAccounts`，按 `account.uid` 过滤 |

结论：**运行中的 0.9.0 还没有包含仓库 0.9.1-dev 里「取消按账号筛选」的修改**。

## 3. 关键证据（2026-10-30 实测）

### 3.1 网关本身正常

用模型来源的 Bearer Key 直接请求（不打印 Key/正文）：

| 路径 | HTTP | 顶层字段 |
| --- | --- | --- |
| `/status` | 200 | `ok, time, request_id, total_credits, total, healthy, cooling, disabled, accounts` |
| `/v1/status` | 200 | 同上 |
| `/v1/credits` | 200 | 同上 |

`accounts` 共 2 条：

- `realm = "global"`，`credits = 380`，`disabled = true`
- `realm = "cn"`，`credits = 7389`，`disabled = false`

**两条账号都没有 `uid` 字段**（只有 `nickname, realm, credits, credits_total, credits_expiring, credits_earliest_expiry, credits_earliest_remaining, cooling, disabled, token_usage, tokens`）。

因此「HTTP 502」不是当前根因；它是某一次账号列表请求的瞬时上游错误。网关恢复 200 后，接口仍会返回空账号列表，原因见下。

### 3.2 旧筛选把全部账号排除

用 0.9.0 的真实解析函数和真实响应复现：

```text
带旧 workbuddyAccounts（1 个 uid） → {"ok":false,"reason":"no-account"}
不带选择（[]）                    → {"ok":true,"total":7363,"accounts":1}
```

配置里当时保存的是旧管理接口时代的 uid：
`workbuddyAccounts: '["7350e484-…"]'`。

### 3.3 设置页账号列表同样依赖 uid

0.9.0 的 `listWorkbuddyAccounts()` 逐个账号执行：

```js
if (typeof account.uid !== 'string' || account.uid.length === 0) continue
```

新网关响应没有 `uid`，所以账号列表必然为空。该路由实测返回：

```json
{ "ok": true, "data": { "accounts": [] } }
```

设置页没有可勾选项，正是这个原因，与侧栏失败同源。

## 4. 根因（一句话）

**0.9.0 仍按旧管理接口的 `account.uid` 做账号筛选，而新客户端积分响应不再提供 `uid`；旧 `workbuddyAccounts` 选择把所有账号都过滤掉，侧栏解析成 `no-account`，设置页账号列表也变成空。**

不是网关路径问题，也不是 `/v1/status` 404；根路径 `/status` 已正常返回。

## 5. 即时处置（已完成，运行期）

- 只改 desktop profile 的 `cordis.patch.yml` 一行：

  ```yaml
  workbuddyAccounts: '[]'
  ```

  即「全部账号」；旧值不再参与过滤。
- 改前备份：`cordis.patch.yml.bak-workbuddy-20261030-150310`。
- 未改代码、未重启、未触碰 MiMo 配置；profile diff 仅此一行。
- 验证：`/api/plan-usage` 返回 `creditsTotal` 正常、`effectiveStatus: "ok"`、`failCount: 0`；
  用户 GUI 已确认积分恢复显示。
- 注意：**不要恢复旧备份**，否则 `workbuddyAccounts` 旧 uid 会把故障带回来。

## 6. 合并到 0.9.1 的修复范围（待办）

1. **取数路径**：`fetchFromGateway` 完全不读取 `workbuddyAccounts`（仓库 0.9.1-dev 已如此）；
   字段保留在 schema 中用于兼容旧配置，不迁移、不清空，但运行期不生效。
2. **设置页**：不再渲染「账号合计 / 勾选账号」控件；`listWorkbuddyAccounts()` 返回
   `{ accounts: [], supported: false, message: '…该接口不提供稳定账号 ID，暂不支持按账号筛选…' }`。
   不得再把「空列表」渲染成「网关未配置/未启动」。
3. **错误文案分离**：
   - 网关 HTTP 502 / 超时 → 「网关请求失败（HTTP 502）」；
   - 200 但没有 cn 账号 → 「响应里没有国内（cn）账号」；
   - 200 有 cn 账号但 `credits` 缺失/非法 → 「国内账号积分数值不可用」。
   三者不能再用同一句「没有可用账号」兜底。
4. **口径**：只统计 `realm === 'cn'` 且未停用的账号；根 `total_credits` 是跨区合计，不使用；
   `credits_total` 是累计额度，不当余额。
5. **回归用例（合并时补）**：
   - 真实形状 fixture：`accounts` 无 `uid`，`workbuddyAccounts` 仍为非空旧值 → 仍能解析出 cn 合计；
   - `listWorkbuddyAccounts()` 在无 `uid` 响应上返回 `supported:false`，不返回误导性空列表；
   - 设置页无账号选择控件，且不出现「没有可用账号（或网关未配置/未启动）」；
   - 网关 502 与「无 cn 账号」分别命中不同文案；
   - 0.9.0 旧配置（含 uid）升级后无需手工清字段即可正常显示。

## 7. 验收标准

- `/api/plan-usage` 的 WorkBuddy 条目 `error` 为空，`creditsTotal` 为 cn 账号剩余合计；
- `/api/plan-usage/workbuddy-accounts` 明确返回「不支持账号筛选」，设置页有解释性文案而非空白选择器；
- 不改动 `workbuddyAccounts` 旧值时，侧栏也不会再因 `uid` 缺失而失败；
- 真实网关 200、502、无 cn 账号三种情况文案可区分。

## 8. 边界

- 本文不主张「0.9.0 已修复」：0.9.0 仍保留旧筛选逻辑，当前只是配置规避。
- 未部署新包、未重启 DSH、未影响另一会话的 MiMo 工作。
- 未保存网关响应原文、账号昵称、uid 或任何凭据。

## 9. 开发仓库落实（2026-10-30，本会话）

> 本节只描述**开发仓库**；运行中的 0.9.0 副本未改、未部署、未重启。

### 9.1 先核缺项：仓库已修，不是「从零重写」

核对结果：§6 的 1、2、4 条与 §7 的主要契约在 `0.9.1-dev.wbcredits.20261025.3` 里**已经落实**，
本次没有重写这些功能，只补了 §6.3 的文案一致性与 §6.5 的部分回归证明。

| §6 要求 | 仓库现状（已修，本次未改） |
| --- | --- |
| 1 取数不读旧字段、schema 保留 | [fetchFromGateway](plans/workbuddy.js#L1062) 全程不读 `cfg`；字段仍在 [schema](plans/workbuddy.js#L71)，不清空/不迁移 |
| 2 设置页无选择器、`supported:false` | [listWorkbuddyAccounts](plans/workbuddy.js#L932) 返回固定元数据；[路由](index.js#L1227) 保留兼容；[设置页](client.js#L5571) 只给说明、不再 GET 账号列表 |
| 3 错误文案分离 | 解析侧三分类已在（`no-cn-account` / `bad-cn-credits` / 结构类）；**传输侧两处仍是旧措辞**，本次改 |
| 4 口径：只 cn、只用 `accounts[].credits` | [creditsFromClientCredits](plans/workbuddy.js#L481)：realm 严格 `=== 'cn'`、停用不计入、零值有效、负数保留；不看根 `total_credits` 与累计 `credits_total`；[wire](plans/workbuddy.js#L563) 保持到期摘要口径不变 |

### 9.2 本次改动（最小）

1. **文案**（[plans/workbuddy.js](plans/workbuddy.js#L1146)、[#L1181](plans/workbuddy.js#L1181)）：
   - 传输失败/超时：`网关状态读取失败（timeout）` → `网关请求失败（timeout）`
     （取数端点早已是 `/v1/credits`，旧文案的「状态」指向已废弃的 `/status`）；
   - 网关 HTTP 错误（含 502）：`网关返回 HTTP 502` → `网关请求失败（HTTP 502）`。
   两处都保持 `error:'exec'` + `transient` 语义（5xx/429 才算暂时失败），未改分类与预算逻辑。
2. **定向回归**（新增 [test-workbuddy-legacy-selection.mjs](tools/test-workbuddy-legacy-selection.mjs)，33 项，全离线）：
   真实形状 fixture（`accounts[]` 无 `uid`、有跨区 `total_credits` 与 `credits_total` 干扰项、
   值全为 `SYNTH-`/`DUMMY-` 假值）+ **真实 `apply()`** 注册的 `/api/plan-usage` 路由；
   真实 `/api/plan-usage/workbuddy-accounts` 路由；真实 `client.js` 设置页渲染（mock-react）。
   覆盖 §6.5 五条：无 uid + 非空旧选择仍出 cn 合计、旧字段原值保留、`supported:false` 不冒充
   「未配置」、502/无 cn/非法 credits/超时四类文案两两不同、设置页无选择器且不出现
   「没有可用账号（或网关未配置/未启动）」。

### 9.3 一次必要验证结果

- 新增回归：`node tools/test-workbuddy-legacy-selection.mjs` → **33 项全部通过**。
- 「先失败、后通过」：临时在 `creditsFromClientCredits` 里加回 `if (typeof account.uid !== 'string') continue`
  （等价于 0.9.0 的 uid 过滤）后，同一文件 **5 项失败**，报文正是现场那句
  「客户端积分响应里没有国内（cn）账号」；还原后重新全绿。该临时改动**已完全还原**
  （`git diff plans/workbuddy.js` 只剩上面两处文案）。
- 相关既有 WB 基线（各一次，均通过）：`test-workbuddy-client-credits` 50、`test-workbuddy-gateway` 51、
  `test-workbuddy` 26、`test-workbuddy-round6` 29、`test-workbuddy-round7` 16、`test-workbuddy-round8` 14、
  `test-workbuddy-round9` 16、`test-workbuddy-expiry-label` 16；设置页面
  `test-quota-policy-settings` 95、`test-custom-round5` 18。
- `test-workbuddy-contract.mjs` **N/A**：它要求传入外部 WorkBuddy Connect `lib/index.js` 路径，
  本次不接触已安装副本/外部 SDK。

### 9.4 边界与未验证

- **不主张运行中的 0.9.0 已修**：未部署新包、未重启、未改 `cordis.patch.yml`（旧备份也未恢复）、
  未动 MiMo 工作区与真实 profile/凭据。
- **真实网关 200 / 502 / 无 cn 三种情况的真机验收 = NOT_RUN**（本次只做合成 fixture 与真实函数链）。
- 未跑全项目大矩阵；`workbuddy-ai` 退场渠道与 `creditsFromGatewayStatus` / `creditPackagesOf` 等
  **历史纯函数**（uid 口径）保留给历史回归，运行期不可达，未删除。
- 一个残留：沙箱拒绝删除文件，`tools/tmp-probe-config.mjs` 只剩一行 `console.log` 空壳（无 import、
  无引用），可手工删除。

