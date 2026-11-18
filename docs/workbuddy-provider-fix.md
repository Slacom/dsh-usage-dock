# WorkBuddy 手机端「渠道配置有误」修复（0.11.1）

## 现象

桌面端 WorkBuddy 积分正常显示；手机端（DSH Go 原生额度面板）WorkBuddy 一行显示
「—」和「渠道配置有误」，OpenCode Go / DeepSeek / MiMo 都正常。

## 根因

取数要按「模型提供商 id」在宿主目录（`llm.listConfigurableProviders()`）里找网关，
旧代码把 id 写死成 `workbuddy`。而 provider id 是 `设置 → 模型` 里 `providers` 下的**键**，
与设备上的配置写法有关：

| 设备 | provider id | displayName |
|---|---|---|
| 桌面端 | `workbuddy` | workbuddy |
| 手机端 | `custom-workbuddy` | workbuddy |

手机上目录里根本没有 id 为 `workbuddy` 的条目 → `readProviderCatalog` 返回
`config` → 界面显示「渠道配置有误」，而且**一个请求都没发**（所以不是网络或 Key 的问题）。

## 修复

`plans/workbuddy.js` 新增 `pickGatewayProvider()`（纯函数）与 `readGatewayProviders()`，
按下面顺序确定 provider id：

1. 设置里的 **`workbuddyProvider`**（新配置项，默认空 = 自动）填了就只认它；填错如实报错，不静默换源；
2. provider id 归一化（小写、只留字母数字）后等于 `workbuddy`；
3. 目录里的 `displayName` 归一化后等于 `workbuddy` —— **手机端命中这条**；
4. provider id 归一化后以 `workbuddy` 结尾（`custom-workbuddy`）。

第 3/4 条命中多条时视为歧义，提示用户显式指定，绝不猜。

另外 `index.js` 里 WorkBuddy 的「观察身份」来源指纹原本也写死 `workbuddy`，一并改成
按解析出的 id 计算（否则手机上来源变化在身份里看不出来）。

## 改动清单

| 文件 | 改动 |
|---|---|
| `plans/workbuddy.js` | schema 新增 `workbuddyProvider`；新增 `readGatewayProviders()` / `pickGatewayProvider()` / `gatewayProviderIdOf()`；`resolveGatewaySource()` 改为按解析出的 id 取数 |
| `index.js` | 导入 `gatewayProviderIdOf`；来源指纹改用解析出的 id（3 小处，含一个兜底常量） |
| `tools/test-workbuddy-gateway.mjs` | 新增 G13–G20（手机端自定义来源、显式指定、歧义、后缀、归一化、指纹解析） |

`plans/custom-balance.js` **未改动**（修复自包含在 `workbuddy.js`，便于只替换一个文件）。

## 补丁怎么用

- `workbuddy-provider-fix.patch`：`plans/workbuddy.js` 的 unified diff，可
  `git apply workbuddy-provider-fix.patch`；不一致时直接整文件替换 `plans/workbuddy.js`
  （该文件除本次新增外与原 0.11.0 一致）。
- `index.js` 的三处改动较小，按下面查找替换：

```js
// 1) 导入
import { setWebBase, listWorkbuddyAccounts, GATEWAY_CREDITS_PATH, gatewayProviderIdOf } from './plans/workbuddy.js'

// 2) 兜底常量（放在 ACCOUNT_BOUND_PLAN_IDS 之前）
const GATEWAY_PROVIDER_FALLBACK = 'workbuddy'

// 3) 观察身份里的来源指纹
const resolvedGateway = (() => {
  try {
    const hit = gatewayProviderIdOf(ctx, cfgValue(cfgNow, 'workbuddyProvider'))
    return hit !== null && hit !== undefined && hit.ok === true ? hit.provider : GATEWAY_PROVIDER_FALLBACK
  } catch (err) {
    return GATEWAY_PROVIDER_FALLBACK
  }
})()
const src = providerSourceFingerprint(ctx, resolvedGateway, GATEWAY_CREDITS_PATH)
```

## 验证

- 手机端用凭据库里的 Key 直连网关 `GET https://<网关>/v1/credits` → `200`，
  `creditsFromClientCredits()` 解析出 `total: 1110`（1 个账号，纯数值，不含身份）；
- 回归测试 `tools/test-workbuddy-gateway.mjs` 39 项全过（其中 G13–G20 是本次新增）；
- 手机端已把修复部署到 `$DSH_HOME/profiles/web/node_modules/dsh-usage-dock`
  （`plans/workbuddy.js` 整文件 + `index.js` 三处），**重启引擎后生效**。
