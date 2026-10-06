# dsh-plan-usage 插件修改记录（Termux 侧栏融入版 + DeepSeek 余额）

> 本文档记录在 **Termux（Android）** 上对 dsh-plan-usage 插件及相关 DSH 组件所做
> 的全部本地修改，供 **PC 端（Windows）DSH** 按相同方式修改或同步。
>
> - 生成时间：2026-08-17
> - 环境：DSH 0.1.0-rc.6 / dsh-plan-usage **0.2.1** / node v26.4.0 / pnpm 11.22.0
> - 配套文档：《插件安装指南.md》（安装）、《README-右侧文件栏补丁.md》（aionui-panel 右侧文件栏）
>
> ⚠️ **升级/重装插件后以下修改全部丢失，需重新应用。**

---

## 0. 修改总览

| # | 文件 | 类型 | 内容 |
|---|---|---|---|
| 1 | `dsh-plan-usage/plans/deepseek.js` | **新增** | DeepSeek 官网余额取数模块 |
| 2 | `dsh-plan-usage/plans/index.js` | 修改 | 注册 deepseek 套餐 |
| 3 | `dsh-plan-usage/client.js` | 修改 | 侧栏融入版渲染 + 余额显示 + 红灯阈值 |
| 4 | `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` | 修改 | 新增 `sidebar.plan-usage` 席位 |
| 5 | `@deepseek-ai/dsh-client-ui-layout/lib/client.js` | 修改 | 侧栏最小/默认宽度调整 |

**目标形态**：用量胶囊从"右下角悬浮"迁移为"左侧状态栏内嵌元素"（位于更新/远程
控制按键上方）；新增 DeepSeek 官网 API 余额显示（右侧只显余额，低于 ¥30 红灯）。

---

## 1. 新增 `plans/deepseek.js`（DeepSeek 官网余额模块）

**路径**：`$DSH_HOME/profiles/web/node_modules/dsh-plan-usage/plans/deepseek.js`
（即 `~/.dsh/profiles/web/node_modules/dsh-plan-usage/plans/deepseek.js`）

**完整内容**（逐字节复制）：

```js
/**
 * DeepSeek 官网 API 余额模块：`GET https://api.deepseek.com/user/balance`
 * （Bearer 鉴权）。返回账号剩余余额（人民币元），不涉及用量窗口。
 *
 * 与其他套餐模块相同的统一 plan 对象：
 *   { id, name, fields, schema, source, fetch }
 * - `fields`：配置扁平键里的字段名（enabled 开关 / apiKey 密钥）；
 * - `schema`：该套餐的配置 schema 字段（加入插件的 Config 对象）；
 * - `source`：余额端点、鉴权方式与凭据候选；
 * - `fetch(ctx, shell, cfg)`：取数 + 归一化，返回 wire 套餐对象。
 *
 * wire 对象携带 `balance`（number，剩余余额元）；余额低于 30 元时浏览器
 * 状态灯显示红灯（阈值在客户端 PLANS 表声明，见 client.js）。
 */
import z from '@deepseek-ai/schemastery'
import { curlJson, toNum, resolveApiKey, planBase, noKey, execError } from './util.js'

/** 该套餐的配置字段：`apiKey` 为插件级密钥（DeepSeek 开放平台 Key）。 */
const fields = { enabled: 'deepseekEnabled', apiKey: 'deepseekApiKey' }

const source = {
  endpoint: 'https://api.deepseek.com/user/balance',
  bearer: true,
  refs: ['DEEPSEEK_API_KEY'],
}

const plan = {
  id: 'deepseek',
  name: 'DeepSeek 官网',
  fields,
  schema: {
    deepseekEnabled: z.boolean().default(false),
    deepseekApiKey: z.string().role('secret'),
  },
  source,
}

/** 拉取 DeepSeek 官网 API 余额：取 CNY 的 total_balance（无则取第一个）。 */
export async function fetchPlan(ctx, shell, cfg) {
  const apiKey = await resolveApiKey(ctx, cfg, fields.apiKey, source.refs)
  if (apiKey === undefined) return noKey(plan)
  try {
    const { data, err } = await curlJson(shell, source.endpoint, {
      auth: apiKey,
      bearer: source.bearer,
    })
    if (err !== undefined) return Object.assign(planBase(plan), err)
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const cny = infos.find((b) => b && b.currency === 'CNY')
    const info = cny !== undefined ? cny : infos[0]
    const balance = info !== undefined ? toNum(info.total_balance) : null
    return Object.assign(planBase(plan), {
      balance: balance,
      isAvailable: data.is_available === true,
    })
  } catch (err) {
    return execError(plan)
  }
}

export default Object.assign(plan, { fetch: fetchPlan })
```

**要点**：
- 官方余额接口 `GET https://api.deepseek.com/user/balance`（Bearer 鉴权）
- 响应：`{ is_available, balance_infos: [{ currency: "CNY", total_balance: "45.98", granted_balance, topped_up_balance }] }`
- `total_balance` 是字符串，用 util.js 的 `toNum` 转 number
- 凭据解析走 `resolveApiKey`：插件配置 `deepseekApiKey` → 凭据库 `DEEPSEEK_API_KEY`
- wire 返回 `balance`（number）+ `isAvailable`（boolean），**没有**用量窗口字段

---

## 2. 修改 `plans/index.js`（注册 deepseek）

**路径**：`$DSH_HOME/profiles/web/node_modules/dsh-plan-usage/plans/index.js`

在 import 区和 PLANS 数组中追加：

```js
// 原：
import opencodeGo from './opencode-go.js'
import glmZai from './glm-zai.js'
import glmZhipu from './glm-zhipu.js'
import kimiCode from './kimi-code.js'

/** 已接入的套餐（渠道）：id 同时用作配置键名与 wire 标识。 */
export const PLANS = [opencodeGo, glmZai, glmZhipu, kimiCode]

// 改为：
import opencodeGo from './opencode-go.js'
import glmZai from './glm-zai.js'
import glmZhipu from './glm-zhipu.js'
import kimiCode from './kimi-code.js'
import deepseek from './deepseek.js'

/** 已接入的套餐（渠道）：id 同时用作配置键名与 wire 标识。 */
export const PLANS = [opencodeGo, glmZai, glmZhipu, kimiCode, deepseek]
```

> 其余路由/配置读写全部由注册表驱动，**无需改 index.js 的其他部分**。

---

## 3. 修改 `client.js`（浏览器半，共 8 处）

**路径**：`$DSH_HOME/profiles/web/node_modules/dsh-plan-usage/client.js`

### 3.1 PLANS 表追加 deepseek 项（约第 60-68 行）

```js
var PLANS = [
  { id: 'opencode-go', name: 'OpenCode Go', credentialHint: 'opencode-go' },
  { id: 'glm-zai', name: 'GLM Z.AI', credentialHint: 'ZAI' },
  { id: 'glm-zhipu', name: 'GLM 智谱', credentialHint: 'ZHIPU / GLM' },
  { id: 'kimi-code', name: 'Kimi Code', credentialHint: 'KIMI_CODE', cookieHint: 'kimi-auth' },
  // [local patch] DeepSeek 官网 API 余额：右侧只显示剩余余额（元）；
  // balanceThreshold=30：余额低于 30 元时状态灯显示红灯。
  { id: 'deepseek', name: 'DeepSeek 官网', credentialHint: 'DEEPSEEK', balanceThreshold: 30 },
]
```

> `balanceThreshold` 是本补丁引入的**余额类套餐标记**：渲染层据此区分"用量窗口"与"余额"。

### 3.2 样式常量：侧栏融入版（约第 120-138 行）

**rootStyle** —— 从"右下角 fixed 悬浮"改为"侧栏内相对定位块级"：

```js
// 原：
var rootStyle = { position: 'fixed', right: 16, bottom: 16, zIndex: 1000, pointerEvents: 'auto', fontFamily: 'inherit' }

// 改为：
// [local patch] 侧栏融入版：不再右下角悬浮，改为左侧状态栏内的块级元素
// （sidebar.plan-usage 席位，位于更新/远程控制按键上方）。wide 展开时显示
// 完整用量胶囊；侧栏折叠（rail）时只显示一个用量圆点。
var rootStyle = { position: 'relative', width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '0 2px', zIndex: 1000, fontFamily: 'inherit' }
```

**pillStyle / pillRowStyle / pillSegStyle / dotStyle / capNameStyle / capValueStyle** —— 压缩边距 + 数值贴右缘：

```js
// 原：
var pillStyle = { display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 12px', ... }
var pillRowStyle = { display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', lineHeight: 1.4 }
var pillSegStyle = { display: 'inline-flex', alignItems: 'center', gap: 6 }
var dotStyle = { width: 8, height: 8, borderRadius: '50%', flex: 'none' }
var capNameStyle = { flex: 'none', minWidth: 84, fontWeight: 600 }
var capValueStyle = { flex: 'none', width: 96, fontVariantNumeric: 'tabular-nums' }

// 改为：
var pillStyle = { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 6px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 2px 12px rgba(0,0,0,0.18)', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', fontSize: 12, userSelect: 'none' }
var pillRowStyle = { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', lineHeight: 1.4 }
var pillSegStyle = { display: 'inline-flex', alignItems: 'center', gap: 4 }
var dotStyle = { width: 7, height: 7, borderRadius: '50%', flex: 'none' }
// [local patch] 名称列按内容自然宽度；数值列 marginLeft:auto 贴右缘，
// 空隙自动落在名称与数值之间，胶囊随侧栏宽度变化。
var capNameStyle = { flex: 'none', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }
// 用量值列固定宽度：保证各行百分比右缘对齐（最宽场景如 "100% 100% 100%" 也放得下）。
var capValueStyle = { flex: 'none', width: 80, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }
```

**panelStyle** —— 从"右缘弹出 + 固定 minWidth 232"改为"宽度=胶囊宽度、随侧栏伸缩"：

```js
// 原：
var panelStyle = { position: 'absolute', right: 0, bottom: 'calc(100% + 10px)', minWidth: 232, padding: 12, ... }

// 改为：
// [local patch] 侧栏版面板：left:0/right:0 使其宽度 = 胶囊宽度，
// 左边界与胶囊左侧对齐（不再超出屏幕左缘），右边界与胶囊右侧一致，
// 随侧栏宽度自动伸缩；minWidth 去掉以免窄栏溢出。
var panelStyle = { position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 10px)', minWidth: 0, width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 12, background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 8px 28px rgba(0,0,0,0.22)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, overflowY: 'auto', maxHeight: '70vh' }
```

### 3.3 组件内：折叠侧栏自动收起面板（约第 180-184 行，`openHook` 之后新增）

```js
  // [local patch] 侧栏折叠（wide→false）时自动收起详情面板：rail 窄条下
  // absolute 面板会溢出错乱，折叠即关闭。
  React.useEffect(function () {
    if (props.wide === false) setOpen(false)
  }, [props.wide])
```

> 依赖 `[props.wide]`；sidebar 的 wide 在折叠动画结束（settled）后变 false，面板干净收起。

### 3.4 胶囊行构建：余额分支（约第 218-248 行）

在 `for (var i = 0; i < plans.length; i++)` 循环体内、`var worst = worstPercent(plan)` 之前插入余额分支：

```js
    // [local patch] 余额类套餐：右侧只显示剩余余额，低于阈值红灯。
    if (meta.balanceThreshold !== undefined && typeof plan.balance === 'number') {
      var low = plan.balance < meta.balanceThreshold
      // 注意：不能用 toneColor(90)——它按「用量百分比」语义返回红色；
      // 余额充足用 success 绿，低于阈值用 error 红。
      var dot = low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'
      var balText = '¥' + plan.balance.toFixed(2)
      capsuleRows.push({ dot: dot, label: meta.name, values: [balText] })
      continue
    }
```

> ⚠️ **踩坑记录**：第一版误用 `toneColor(90)` 表示"余额充足"，但 toneColor 的语义是
> **用量百分比**（≥90 返回红色），导致余额充足时亮红灯。必须直接用 success/error 令牌。

### 3.5 胶囊按钮渲染：wide 模式（约第 263-289 行）

pill 元素：加 `className: 'dsh-plan-usage-pill'`（供 sidebar CSS 定制融入外观）、`width: '100%'`、`justifyContent: wide ? undefined : 'center'`；行内名称/数值仅在 wide 时渲染：

```js
  var wide = props.wide !== false
  var pill = h('button', {
    className: 'dsh-plan-usage-pill',
    style: Object.assign({}, pillStyle, {
      width: '100%',
      boxSizing: 'border-box',
      justifyContent: wide ? undefined : 'center',
      borderRadius: capsuleRows.length > 1 ? 12 : 999,
    }),
    type: 'button',
    onClick: function () { setOpen(!open) },
    title: pillTitle,
    'aria-expanded': open,
  },
    capsuleRows.length > 0
      ? capsuleRows.map(function (r, idx) {
        return h('span', { style: pillRowStyle, key: idx },
          h('span', { style: Object.assign({}, dotStyle, { background: r.dot || dotColor }) }),
          wide && h('span', { style: capNameStyle }, r.label),
          wide && h('span', { style: capValueStyle }, r.values.join(' ')),
        )
      })
      : h('span', { style: pillSegStyle },
        h('span', { style: Object.assign({}, dotStyle, { background: dotColor }) }),
        wide && h('span', { style: valueStyle }, text),
      ),
  )
```

### 3.6 面板段：余额类套餐渲染（约第 291-332 行）

标题区分"余额/用量"；余额类套餐显示大号金额 + 状态提示：

```js
      var title = meta.name + (meta.balanceThreshold !== undefined ? ' 余额' : ' 用量') + (plan.level ? ' · ' + plan.level : '')
      var inner
      if (plan.error) {
        inner = h('div', { style: sectionNoteStyle }, plan.message || '无法获取用量')
      } else if (meta.balanceThreshold !== undefined) {
        // [local patch] 余额类套餐：显示剩余余额与可用状态；低于阈值红灯提示。
        if (typeof plan.balance !== 'number') {
          inner = h('div', { style: sectionNoteStyle }, '余额获取失败')
        } else {
          var low = plan.balance < meta.balanceThreshold
          var balRow = {
            display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0',
            fontSize: 18, fontWeight: 600,
            color: low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
          }
          var balDot = Object.assign({}, dotStyle, {
            width: 9, height: 9,
            background: low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
          })
          inner = h('div', {},
            h('div', { style: balRow },
              h('span', { style: balDot }),
              h('span', {}, '¥' + plan.balance.toFixed(2)),
            ),
            h('div', { style: sectionNoteStyle },
              low
                ? '余额低于 ' + meta.balanceThreshold + ' 元，请及时充值'
                : (plan.isAvailable === false ? '账户当前不可用' : '余额充足')),
          )
        }
      } else {
        // ... 原有用量窗口渲染（WINDOWS 进度条）保持不变 ...
      }
```

### 3.7 apply：挂载点从 shell.overlay 改为 sidebar.plan-usage（约第 782-793 行）

```js
  // [local patch] 侧栏融入版：从 shell.overlay（右下角悬浮）迁移到
  // sidebar.plan-usage 席位（左侧状态栏内、更新/远程控制按键上方）。
  ctx.slots.inject('sidebar.plan-usage', function () {
    return ctx.slots.register({
      name: 'sidebar.plan-usage',
      id: 'plan-usage',
      order: 0,
      priority: 0,
      // wide 由 sidebar 渲染时通过 ownerProps 注入（renderSlot('sidebar.plan-usage', { wide })）
      inject: function () { return { settings: controller } },
    }, PlanUsageBadge)
  })
```

> 原实现（`ctx.slots.inject('shell.overlay', ...)`）整个替换。`settings.plugin.item`
> 配置卡片注册**保持不动**。

### 3.8 清理：移除右下角跟随逻辑

原源机补丁 C 的 `insetHook`/`rightInset` 状态与 ResizeObserver/MutationObserver
effect（跟踪 `[data-aionui-explorer-col]` 面板宽度）在侧栏版中**已无意义**，全部删除；
最终 root 渲染从 `Object.assign({}, rootStyle, { right: rightInset })` 简化为 `style: rootStyle`。

---

## 4. 修改 `dsh-client-ui-sidebar/lib/client.js`（新增席位）

**路径**：`/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`
（PC 端 npm 全局安装路径：`C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar\lib\client.js`）

### 4.1 席位声明（约第 268-283 行，children 表中加 `sidebar.plan-usage`）

```js
			children: {
				"sidebar.workspaces": {
					kind: "single",
					scope: "root"
				},
				"sidebar.plan-usage": {
					kind: "single",
					scope: "root"
				},
				"sidebar.settings": {
					kind: "single",
					scope: "root"
				},
				"sidebar.footer.action": {
					kind: "list",
					scope: "root"
				}
			},
```

### 4.2 渲染位置（约第 207-216 行，footArea 内 footerActions **之前**插入）

```js
				(0, react_jsx_runtime.jsxs)("div", {
					className: SidebarRoot_module_css_default.footArea,
					children: [(0, react_jsx_runtime.jsx)("div", {
						className: SidebarRoot_module_css_default.planUsageArea,
						children: renderSlot("sidebar.plan-usage", { wide })
					}), (0, react_jsx_runtime.jsx)("div", {
						className: SidebarRoot_module_css_default.footerActions,
						children: renderSlot("sidebar.footer.action", { wide })
					}), (0, react_jsx_runtime.jsx)("div", {
						className: SidebarRoot_module_css_default.settingsArea,
						children: renderSlot("sidebar.settings", { wide })
					})]
				})
```

### 4.3 CSS 常量（第 26 行 css 字符串，两处修改）

原段：
```
.hHd-Xa_settingsArea,.hHd-Xa_footerActions{flex:none;width:100%;min-width:0}.hHd-Xa_footerActions{display:flex}.hHd-Xa_collapsed .hHd-Xa_footArea{align-items:center}.hHd-Xa_collapsed .hHd-Xa_settingsArea,.hHd-Xa_collapsed .hHd-Xa_footerActions{justify-content:center;width:auto;display:flex}
```
改为：
```
.hHd-Xa_settingsArea,.hHd-Xa_footerActions,.hHd-Xa_planUsageArea{flex:none;width:100%;min-width:0}.hHd-Xa_footerActions{display:flex}.hHd-Xa_planUsageArea{margin-bottom:2px}.hHd-Xa_planUsageArea .dsh-plan-usage-pill{background:transparent;border:0;padding:6px 2px;box-shadow:none}.hHd-Xa_collapsed .hHd-Xa_footArea{align-items:center}.hHd-Xa_collapsed .hHd-Xa_settingsArea,.hHd-Xa_collapsed .hHd-Xa_footerActions,.hHd-Xa_collapsed .hHd-Xa_planUsageArea{justify-content:center;width:auto;display:flex}
```

### 4.4 CSS 模块映射（约第 51-52 行，加一行）

```js
		"footerActions": "hHd-Xa_footerActions",
		"planUsageArea": "hHd-Xa_planUsageArea",
```

---

## 5. 修改 `dsh-client-ui-layout/lib/client.js`（侧栏宽度）

**路径**：`.../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`

> ⚠️ **关键踩坑**：只改 `computeColumns` 的 clamp 下限**无效**——侧栏宽度由 store
> actions（`setSidebar` 拖拽 clamp）真正控制。两处必须一起改，否则拖拽时被旧下限顶回。

### 5.1 computeColumns 初始布局下限（第 35 行）

```js
// 原：
const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
// 改为（最终值，经历 264→243→219→197→219 收敛）：
const s = sidebar === 0 ? 56 : clampWidth(sidebar, 219, 420);
```

### 5.2 store init 默认宽度（第 280 行）

```js
// 原：
init: () => ({
	sidebar: 280,
// 保持 280 不变（曾试 252 后撤回）
```

### 5.3 setSidebar 拖拽 clamp（第 287 行）——**关键**

```js
// 原：
d.sidebar = clampWidth(px, 264, 420);
// 改为：
d.sidebar = clampWidth(px, 219, 420);
```

### 5.4 toggleSidebar 展开默认值（第 294 行）

```js
// 原：
else d.sidebar = d.sidebar === 0 ? 280 : 0;
// 保持 280 不变
```

### 5.5 computeColumns 调用处 fallback（第 195 行）

```js
// 原（280 保持）：
const cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, ...);
```

> **宽度结论**：最小 219px（拖拽下限与初始布局一致），默认/展开 280px，上限 420px。
> 胶囊内部已压缩（padding 6、名称自然宽+ellipsis、数值 80 贴右缘），219px 下可容纳。

---

## 6. 部署与验证

### 6.1 部署步骤

1. 按上述 1-5 修改全部文件（或直接从 Termux 复制已改文件覆盖）；
2. **完整重启 dsh web 进程**（页面刷新不够）；
3. 浏览器**硬刷新**（Ctrl+Shift+R / 无痕窗口 / 清除站点数据）。

### 6.2 验证清单

1. 左侧状态栏底部（更新/远程控制按键上方）出现用量胶囊；
2. 胶囊内 DeepSeek 官网行：右侧只显示 `¥xx.xx`，余额 ≥30 绿点、<30 红点；
3. 点击胶囊：详情面板向上弹出，**左边界与胶囊左侧对齐**、宽度随侧栏；
4. 侧栏拖到最窄（~219px）：胶囊数值仍贴右缘、名称省略号截断、无空白错位；
5. 侧栏折叠成 rail：胶囊只剩圆点，若面板开着**自动收起**；
6. 展开面板后侧栏再次折叠，无溢出/错乱；
7. 设置 → 插件 → 插件配置 → DeepSeek 官网：开关 + API Key 输入正常；
8. 未配置 Key 时胶囊显示"请设置 Key"。

### 6.3 语法校验

```bash
node --check <dsh-plan-usage>/client.js
node --check <dsh-plan-usage>/plans/deepseek.js
node --check <dsh-plan-usage>/plans/index.js
node --check <dsh>/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js
node --check <dsh>/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js
```

### 6.4 API 冒烟测试（余额）

```bash
curl -sS -m 15 -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Accept: application/json" https://api.deepseek.com/user/balance
# 期望：{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"45.98",...}]}
```

## 6.5 OpenAI Codex 订阅额度（2026-08-21）

依赖：已安装并登录 [`dsh-codex-connect`](https://github.com/franksong2702/dsh-codex-connect)。
plan-usage 不读取 OAuth 文件、不复制 token，而是动态导入该插件公开导出的
`OpenAICodexCredentialStore` 与 `readOpenAICodexRateLimits`；Codex Connect 负责
OAuth 自动刷新，plan-usage 只接收脱敏后的 `rateLimits / credits / individualLimit`。

修改文件：

1. `plans/codex.js`（新增）：读取主 `codex` 额度桶，保留 `remainingPercent` 的“剩余额度”语义，
   18000 秒映射为 5 小时，604800 秒映射为周限；客户端采用“越少越红”的反向颜色规则；
2. `plans/index.js`：注册 `codex` 套餐；
3. `index.js`：允许不带 `apiKey` 字段的 OAuth 套餐；
4. `client.js`：增加 OpenAI Codex 行、无 Key 配置提示、credits/工作区额度脚注；
   胶囊只渲染实际上游返回的窗口，避免缺失窗口被误显示成 0%。

安全与兼容行为：

- 未安装 Codex Connect：显示“未安装 dsh-codex-connect”；
- 未登录：提示前往 Codex Connect 配置登录 ChatGPT；
- OAuth 过期：提示重新登录；
- Codex Connect 接口发生变化：仅 Codex 行显示失败，不影响其他套餐。

实测输出（脱敏）：当前账户成功返回主 `codex` 周限窗口；模块归一化后生成
`weeklyUsage.percent` 与 ISO `resetsAt`，未返回的 5 小时/月限窗口保持 `null`。

---

## 7. 已知限制与注意事项

- **升级易失**：`dsh plugin` 升级/重装 dsh-plan-usage、dsh-web-ui-all 会覆盖所有修改；
  升级后按本记录重新应用（方案：直接从 Termux 复制已改文件覆盖）。
- **sidebar/layout 是 DSH 核心包**：修改的是全局 `@deepseek-ai/dsh` 的 node_modules，
  `npm update`/重装 DSH 会踩掉全部修改，建议固定 DSH 版本 0.1.0-rc.6。
- **余额接口限制**：DeepSeek 官方仅提供 `/user/balance`（余额），**无消费/账单查询接口**。
  如需"今日花费"，只能本地估算（会话日志 token × 官方价表，含 2026-08-17 峰谷价），
  社区参考：dsh-deepseek-quota / dsh-balance-meter。当前**未实现**。
- **指示灯语义**：余额充足用 `--dsw-alias-state-success-primary`，勿用 `toneColor(90)`
  （toneColor 按用量百分比语义，≥90 是红色）。
- **面板宽度**：面板 = 胶囊宽度（left:0/right:0），窄侧栏下内容可能拥挤，已有
  `overflowY:auto` 兜底；minWidth 必须为 0，否则窄栏溢出屏幕左侧。
- **rail 折叠**：collapsed 时 `justifyContent: center` 只显示圆点；pill 的
  `.dsh-plan-usage-pill` 类由 sidebar CSS 透明化（background:transparent;border:0）。

---

*本记录基于 Termux 实测环境生成，PC 端（Windows）路径请按「插件安装指南.md」的
平台差异对照表换算。*
