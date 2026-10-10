# dsh-usage-dock v0.7.0 — 底部席位独占一行 + 外观与侧栏按钮对齐

> 上一版：**v0.6.3**（侧栏缩略态交互修复）。本版只改浏览器半的布局与外观，取数逻辑与配置项未动；
> **点击展开的详情面板维持原样**，本次不涉及。

---

## 一句话

三件事：胶囊**独占一行**、排到**最上面一行**、外观**与侧栏其他按钮一致**（不再是那个边缘分明的胶囊）。
装多个底部插件时不再互相挤压，详情面板向上展开也不会盖住其他按钮。

## 问题现象

- 只装本插件时一切正常（胶囊横跨侧栏宽度）；
- 再装一个也用底部席位的插件（如 `ds-harness-remote`）后，两者**挤在同一行**：
  Remote 的按钮和本插件胶囊并排，胶囊被压窄，渠道名与数值显示不全；
- 侧栏缩略成 rail 后尤其明显；
- 胶囊自带深色底 + 边框 + 阴影，而侧栏其他条目（如「调试」「Remote」）都是**无边框、悬停才出灰底**，
  放在一起风格割裂；
- 胶囊排在底部最后一行时，点击展开的详情面板（向上展开）还会盖住其他插件的按钮。

## 根因

`sidebar.footer.action` 是 **list** 席位：DSH 把所有插件注册到底部的动作放进**同一条横向 flex 行**
（0.1.x 核心包里这条规则就是 `.footerActions{display:flex}`，默认 `nowrap`）。

本插件此前用 `flex: 1 1 auto` 参与这一行 —— 于是它必然与同行的其他插件按比例瓜分宽度：

| 插件 | 注册方式 |
| --- | --- |
| `ds-harness-remote` | `sidebar.footer.action`，`order: -20` |
| `dsh-usage-dock` | `sidebar.footer.action`，`order: 10` |

顺序没问题（各插件本来就按 `order` 排），问题在于**它们被排在同一行**。

## 本次改动

只动 `client.js`（**不含详情面板**）。

### 1. 独占一行（`useOwnRow()`）

1. 挂载后从胶囊根节点**向上探测最近的 flex 容器**；
2. 若该容器是 `flex-direction: row`（DSH 的实际布局）：
   - 给它补一条 `flex-wrap: wrap`（只加这一条，不碰宿主的其他样式）；
   - 把胶囊声明为 `flex: 1 1 100%` —— 在一行里 100% 宽度的元素无法与别人共处，于是必然独占一行；
3. 若容器是**纵向**（旧版 `footArea` 就是 `column`）：**什么都不做**，保持原来的 `flex: 1 1 auto`。
   纵向容器里 `flex-basis:100%` 会被解释成「高度」，会把同列的其他条目压扁 —— 这是必须避开的坑；
4. 探测不到宿主（没有 DOM / 老环境）时同样退回原行为，不报错。

### 2. 排到最上面一行（`order: -1000`）

详情面板是**向上**展开的（`bottom: calc(100% + 10px)`）。排在底部最后一行时，面板会盖住其他插件的按钮；
把席位 `order` 取一个很小的负数（`-1000`，远早于 Remote 的 `-20`），本插件就排到最上面一行，
面板向上展开时没有可遮挡的对象。

### 3. 外观向侧栏按钮看齐

| 项 | 旧 | 新 |
| --- | --- | --- |
| 背景 | `--dsw-alias-bg-layer-2` 深色底 | **透明**（与「调试」「Remote」一致） |
| 边框 | 1px 描边 | **无** |
| 阴影 | 有 | **无** |
| 圆角 | 999（单行）/ 12（多行） | **8px**（悬停底色的形状与其他按钮一致） |
| 悬停 | 无变化 | **浮出同款灰底** `--dsw-alias-interactive-bg-hover`（sidebar 的 `.iconButton:hover` 用的就是它） |
| 文字 | 统一主文字色 | 套餐名用**次要色**、数值用主文字色 |

状态点（7px 圆点）与套餐额度文字**完全保留** —— 去掉的只是那层「胶囊外壳」。
悬停/聚焦这类伪类无法内联，因此在 `apply` 里注入一枚**只作用于本插件类名**的极小样式表：

```css
.dsh-plan-usage-pill[data-interactive]:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-plan-usage-pill[data-interactive]:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:-2px}
```

> `data-interactive` 只在**展开且可点击**时才输出：缩略（rail）状态胶囊是纯展示、点不动，
> 因此也不该出现悬停底色。

> **为什么用运行时探测而不是写死 CSS 类名**：DSH 的 CSS Module 类名带哈希（如 `hHd-Xa_footerActions`），
> 跨版本会变；`:has()` 选择器在旧版 Android WebView 上又不保证支持。探测 `getComputedStyle`
> 的 `display`/`flex-direction`（标准属性，不随构建变化）最稳。
>
> 只给容器补 `flex-wrap`、并在**确认是横向容器**之后才声明 `basis:100%`，是这次实现的两个安全边界：
> 万一将来 DSH 换了布局，最坏情况也只是退回旧行为，不会把侧栏布局弄坏。

## 验证

浏览器半回归测试 `tools/test-footer-row.mjs` 扩到 **8 项**（离线运行）：

```
[PASS] T1 横向 flex 行：容器开放换行 + 胶囊独占整行
[PASS] T2 纵向容器：保持原样（不加 wrap、不声明整行）
[PASS] T3 跨过非 flex 包裹层找到行容器
[PASS] T4 容器本就允许换行：不改宿主样式，胶囊仍独占整行
[PASS] T5 无法探测宿主时退化为原行为且不报错
[PASS] T6 席位 order=-1000：排在 Remote(-20) 之前，详情面板不再遮挡其他按钮
[PASS] T7 外观：透明、无边框无阴影（仅状态点 + 文字），悬停态另配
[PASS] T8 注入样式表：悬停/聚焦规则正确，且不碰宿主选择器
```

它用假的 DOM 节点模拟出「横向 flex 行 / 纵向容器 / 中间夹着非 flex 包裹层 / 没有 DOM」四种宿主，
断言容器与胶囊各自被（或不被）改写成预期样式，并覆盖席位 `order`、胶囊样式与注入的 CSS 内容。
测试用的上游数据仍是真机截图里的那一组（DeepSeek ¥7.38 / Codex 33% 72%）。

同时复跑既有套件，确认无回归：

- `tools/test-collapsed-pill.mjs`（4 项）：缩略态不可交互 —— 仍全绿；
- `tools/test-fetch-backends.mjs`（8 项）：取数后端与 DeepSeek 渠道 —— 仍全绿。

> 两个浏览器半测试的 mock 运行时（极简 React + client.js 加载器 + 假 DOM）本版抽成了
> `tools/mock-react.mjs`，避免两份实现漂移。

## 兼容性

- 只改浏览器半（`client.js`）；Host 半、取数后端、配置项一律未动，**无需迁移、无需重填 Key**；
- 桌面端、Web、移动端 Web UI 行为一致；侧栏缩略（rail）时仍然只有状态点且不可点击（0.6.3 的行为保持）；
- 依旧零 DSH 核心补丁 —— 只往宿主的**行内样式**补一条 `flex-wrap`、只调自己的席位 `order`，
  注入的 CSS 也仅针对本插件自己的类名，不改任何核心包文件。

## 升级方式

```powershell
# npm（推荐）
dsh plugin --profile <你的 profile> add dsh-usage-dock@0.7.0

# 或 GitHub 源
dsh plugin --profile <你的 profile> add github:Slacom/dsh-usage-dock
```

安装后**重启 DSH**，浏览器硬刷新（Ctrl+Shift+R）；移动端 Web UI 同理，更新插件后重开页面。

## 如果你还在更早的版本

- **0.6.3**：修掉侧栏缩略时点击状态点弹出竖排乱码面板的问题（缩略态不再可点击）；
- **0.6.2**：修掉移动端（Android APK）取数全断的问题（改为 Host 进程内原生 fetch，
  不再依赖设备上有 `python`/`curl`），并让失败信息能指明后端与原因；
- **0.6.1 及更早**：`0.4.x`/`0.5.x`/`0.6.0` 未单独发布到 npm，累积变更见
  [v0.6.2 发布说明](https://github.com/Slacom/dsh-usage-dock/releases/tag/v0.6.2) 文末的「累积变更」。

## 相关链接

- npm：https://www.npmjs.com/package/dsh-usage-dock
- 上游项目（本插件 fork 自）：https://github.com/chendefine/dsh-plugins-plan-usage
- 许可：MIT
