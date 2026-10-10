# dsh-usage-dock v0.7.0 — 底部席位不再与其他插件抢同一行

> 上一版：**v0.6.3**（侧栏缩略态交互修复）。本版只改浏览器半的布局，取数逻辑与配置项未动。

---

## 一句话

侧栏底部装了**多个**占用同一席位的插件时（例如 Remote），本插件曾被压在同一行里、内容显示不全；
现在胶囊**整行独占**，与其他插件**上下排列**、随占用情况自然让位。

## 问题现象

- 只装本插件时一切正常（胶囊横跨侧栏宽度）；
- 再装一个也用底部席位的插件（如 `ds-harness-remote`）后，两者**挤在同一行**：
  Remote 的按钮和本插件胶囊并排，胶囊被压窄，渠道名与数值显示不全；
- 侧栏缩略成 rail 后尤其明显。

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

只动 `client.js`，新增 `useOwnRow()`：

1. 挂载后从胶囊根节点**向上探测最近的 flex 容器**；
2. 若该容器是 `flex-direction: row`（DSH 的实际布局）：
   - 给它补一条 `flex-wrap: wrap`（只加这一条，不碰宿主的其他样式）；
   - 把胶囊声明为 `flex: 1 1 100%` —— 在一行里 100% 宽度的元素无法与别人共处，于是必然独占一行；
3. 若容器是**纵向**（旧版 `footArea` 就是 `column`）：**什么都不做**，保持原来的 `flex: 1 1 auto`。
   纵向容器里 `flex-basis:100%` 会被解释成「高度」，会把同列的其他条目压扁 —— 这是必须避开的坑；
4. 探测不到宿主（没有 DOM / 老环境）时同样退回原行为，不报错。

结果：胶囊独占一行，其他插件各自成行，**上下顺序仍由各插件的 slot `order` 决定**
（Remote `-20` 在上、本插件 `10` 在下，或反之——取决于对方插件自己的选择），本插件不再参与抢位。

> **为什么用运行时探测而不是写死 CSS 类名**：DSH 的 CSS Module 类名带哈希（如 `hHd-Xa_footerActions`），
> 跨版本会变；`:has()` 选择器在旧版 Android WebView 上又不保证支持。探测 `getComputedStyle`
> 的 `display`/`flex-direction`（标准属性，不随构建变化）最稳。
>
> 只给容器补 `flex-wrap`、并在**确认是横向容器**之后才声明 `basis:100%`，是这次实现的两个安全边界：
> 万一将来 DSH 换了布局，最坏情况也只是退回旧行为，不会把侧栏布局弄坏。

## 验证

新增浏览器半回归测试 `tools/test-footer-row.mjs`（5 项，离线运行）：

```
[PASS] T1 横向 flex 行：容器开放换行 + 胶囊独占整行
[PASS] T2 纵向容器：保持原样（不加 wrap、不声明整行）
[PASS] T3 跨过非 flex 包裹层找到行容器
[PASS] T4 容器本就允许换行：不改宿主样式，胶囊仍独占整行
[PASS] T5 无法探测宿主时退化为原行为且不报错
```

它用假的 DOM 节点模拟出「横向 flex 行 / 纵向容器 / 中间夹着非 flex 包裹层 / 没有 DOM」四种宿主，
断言容器与胶囊各自被（或不被）改写成预期样式。测试用的上游数据仍是真机截图里的那一组
（DeepSeek ¥7.38 / Codex 33% 72%）。

同时复跑既有套件，确认无回归：

- `tools/test-collapsed-pill.mjs`（4 项）：缩略态不可交互 —— 仍全绿；
- `tools/test-fetch-backends.mjs`（8 项）：取数后端与 DeepSeek 渠道 —— 仍全绿。

> 两个浏览器半测试的 mock 运行时（极简 React + client.js 加载器 + 假 DOM）本版抽成了
> `tools/mock-react.mjs`，避免两份实现漂移。

## 兼容性

- 只改浏览器半（`client.js`）；Host 半、取数后端、配置项一律未动，**无需迁移、无需重填 Key**；
- 桌面端、Web、移动端 Web UI 行为一致；侧栏缩略（rail）时仍然只有状态点且不可点击（0.6.3 的行为保持）；
- 依旧零 DSH 核心补丁 —— 只往宿主的**行内样式**补一条 `flex-wrap`，不改任何核心包文件。

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
