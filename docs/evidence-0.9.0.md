# 0.9.0 / T0 补证记录

> 2026-10-18。本文是 T0（补证与契约冻结）的产出，**只记录证据与缺口，不含实现**。
> 配套：[实施交接](handoff-v0.9.0.md)、[构建计划](build-plan-v0.9.0.md)。

## 1. 起点状态

| 项 | 值 |
| --- | --- |
| 起点提交 | `ebe5115`（0.8.5 定档，本地标签 `v0.8.5`，未推送） |
| 公开版本 | 0.8.4（npm `latest` / GitHub Release） |
| Node / npm | v24.14.0 / 11.9.0 |
| 工作区 | 干净（0.9.0 文档已单独提交） |

**基线测试（0.8.5 定档时实测）**：line-endings 21、fetch-backends 13、degrade-refresh 43、
workbuddy 27、android-compat 14、settings 6、peak-phase 32、mimo-parse 21、footer-row 12、
collapsed-pill 4、peak-marker 144 几何断言、panel-interactions 12、workbuddy-contract 7。

## 2. Kimi fixture（**已核实**）

新增脱敏 fixture 目录 `tools/fixtures/kimi-usages/`，来源为公开 issue 正文（字段形状已核对，
无账号/令牌/套餐名）：

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `legacy-only.json` | 只有旧版 `usage` + `limits[]` | 通用形状 |
| `mixed-conflict.json` | 旧版读数非零 + ratio-pool 全 0（**并存矛盾**） | [CodexBar #3754](https://github.com/steipete/CodexBar/issues/3754) |
| `ratio-pool-only.json` | 无顶层 `usage`；`usages` 含 `limit_5h` / `limit_month_total` / `limit_month_code` | [CodexBar #4306](https://github.com/steipete/CodexBar/issues/4306) |
| `broken.json` | 9 个边界变体（空、null、limit=0、非数字、ratio 0/1/越界、缺 used、只有 remaining） | 构造 |

探针：`node tools/probe-kimi-0.9.0.mjs`（只读，不改产品代码，用 stub fetch 跑真实 `fetchPlan`）。

## 3. 当前 parser 的实测行为（**已核实**）

```
legacy-only            rolling 1%  used   weekly 19% used   monthly null
mixed-conflict         rolling 1%  used   weekly 19% used   monthly null   ← ratio-pool 完全没读
ratio-pool-only        rolling 100% used  weekly null       monthly null   ← 月池被丢掉
broken/empty           rolling null      weekly null       monthly null
broken/nulls           null / null / null
broken/zeroLimit       null / null / null
broken/nonNumeric      null / null / null
broken/ratioBoundLow   null / null / null      ← ratio-pool 未实现，故 null
broken/ratioBoundHigh  null / null / null
broken/ratioOutOfRange null / null / null
broken/limitWithoutUsed        null / null / null
broken/limitWithRemainingOnly  null / weekly 0% used / null
```

### 3.1 确认的三个缺口

**G1｜ratio-pool 月度池完全未读。** `ratio-pool-only.json` 里 `limit_month_total.used_ratio = 0.5531`
（即月限已用 55%），但 wire 的 `monthlyUsage` 是 `null`。后果：

- 只返回 ratio-pool 的账号**永远看不到月限**；
- 客户端脚注 `'配置 kimi-auth Cookie 可显示月度会员额度'` 在这类账号上是**错误引导**——
  数据本来就在响应里，只是没解析。

**G2｜ratio-pool 的 5h 池也未读，并存矛盾时无法表达。** `mixed-conflict` 中旧版说 5h 已用 1%、
ratio-pool 说 `used_ratio = 0`；`ratio-pool-only` 中旧版 `limits[]` 说已用 100%、ratio-pool 说 0。
当前实现只信 `limits[]`，**没有任何机制暴露「两个来源矛盾」**。这正是交接文档 D3 要求补证的点。

**G3｜成功但无窗口 → 胶囊显示「获取失败」。** `broken/empty` 这类响应取数成功（无 error）、
但没有可解析窗口，客户端 `worstPercent < 0` 且无 error → 落到 else 分支渲染「获取失败」。
**这是假错误**：数据是「不知道」，不是「取数失败」。0.9.0 的 P1 工具契约要求区分
`unknown` 与 `error`，UI 侧同理。

### 3.2 已确认「没问题」的行为

- `limit=0`、非数字、缺 `used` → 一律 `null`，**不会**被折算成 0% 已用或 100% 剩余（符合要求）；
- `limit=100 / remaining=100` → 0% 已用（正确：`used = limit - remaining`）；
- 空对象 / null 字段不抛异常，返回全 null。

## 4. 单位与类型证据（**部分核实**）

| 字段 | 观察 | 结论 |
| --- | --- | --- |
| `detail.limit` / `used` / `remaining` | 字符串 `"100"` / `"19"`，语义为**计数**，不是百分比 | 已核实；`toNum` 转数字后按 `used/limit` 算百分比 |
| `usages.*.used_ratio` | 浮点 `0`、`0.5531`、`1` | **范围是 0..1**（小数比率），不是 0..100；`1.7` 这类越界值应拒绝而非截断 |
| `resetTime`（旧版） | ISO 8601 带微秒 `2026-09-19T16:45:59.449979Z` | 已核实 |
| `reset_time`（新版） | ISO 8601 无微秒 `2026-10-06T13:23:46Z` | 已核实；两者都要能解析 |
| `limit_month_total` vs `limit_month_code` | #4306 中 0.5531 vs 0 | **两个不同计费范围的月池**，不能互相覆盖 |

> ⚠️ 未核实：`used_ratio` 是否**恒为** 0..1（只见过这些样本）；`reset_time` 是否可能给秒/毫秒
> 时间戳（样本里都是 ISO）。实现时应**两者都兼容、越界即拒绝**，而不是猜。

## 5. 宿主工具契约（**沿用记录，未本轮核验**）

上一轮已核对 DSH 0.2.1-rc.1 的 `dsh-tools`：

- `ctx.tools` 由 `@deepseek-ai/dsh-tools` 提供，`dsh-base` 默认挂载（id `tools`）；
- `register(definition)` 只校验 `name` / `output.schema` / `output.render`，可不 import `defineTool`；
- 注册后 schema 自动进提示词组装；
- **`@deepseek-ai/dsh-tools` 在本机插件目录无法解析**（`ERR_MODULE_NOT_FOUND`，连
  `dsh-codex-connect` 也解析不到）→ 只能 `ctx.get('tools')`；
- cordis 的 `inject` 是**硬依赖**，不能加 `'tools'`（否则移动端整插件不加载）。

**D6 门槛未过**：`execute` 的实参形状、`output.render` 的返回约定、disposer 行为本轮**未**在
真实宿主里跑通过。T2/T3 开工前必须先做一个最小契约冒烟（见第 7 节）。

## 6. 方向 5 缺件核对（**已核实**）

交接文档称「路线图所说的协议文档与校验脚本在检出中不存在」。本轮复核：

| 项 | 现状 |
| --- | --- |
| `docs/agent-update.md` | **不存在** |
| `tools/verify-install.mjs` | **不存在** |
| roadmap 方向 5 的描述 | 仍写着「已落库」（**与事实不符，需修正**） |

结论：方向 5 目前**只有设计意图，没有任何可执行物**。若纳入 0.9.0，必须从零补齐
只读检查端点 + semver 比较 + 校验协议；不能假定已有。

## 7. T0 完成后的待决事项

技术侧还差一项：**D6 最小契约冒烟**——在真实宿主里验证一次
`ctx.get('tools').register({...})` + 调用 + 卸载。这需要在 DSH 运行中的 profile 里做，
且会改动已安装副本，因此等用户确认后再做（不放进 T0）。

产品侧 D1/D2/D4/D5 必须由用户决定，见下次对话的提问。

## 8. 本轮未做

- 未改任何运行时文件（`client.js` / `index.js` / `plans/*` 零改动）；
- 未改版本号（仍 0.8.5）；
- 未部署、未重启、未推送、未打标签、未发布；
- 未读取真实 Kimi 凭据；所有 fixture 来自公开 issue 与构造。
