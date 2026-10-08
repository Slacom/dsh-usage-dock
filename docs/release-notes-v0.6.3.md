# dsh-usage-dock v0.6.3 — 侧栏缩略态交互修复

> 上一版：**v0.6.2**（移动端取数修复）。本版只动浏览器半的交互，不涉及取数逻辑与配置。

---

## 一句话

侧栏收起成 rail 后，那两颗用量状态点**不再可点**：详情面板只在侧栏展开时点击打开。
此前在缩略状态点击会把面板挤成一条**竖排乱码**（移动端 Web UI 实测）。

## 问题现象

| 状态 | 表现 |
| --- | --- |
| 侧栏展开 | 胶囊正常，点击弹出详情面板 —— 桌面端一直良好 |
| 侧栏缩略（rail） | 只剩状态圆点，**但仍可点击**；点击后面板照常渲染，被约 56px 宽的 rail 压成一条竖排文字，显示不全 |

## 根因

两条都出在浏览器半（`client.js`）对折叠信号 `wide` 的使用上：

1. **胶囊的 `onClick` 与 `wide` 无关**：缩略状态只是不再渲染文字列（`wide && …`），
   但 `onClick={() => setOpen(!open)}` 一直挂着，于是照样能打开面板。
2. **面板的渲染条件只有 `open`**：面板是 `position:absolute; left:0; right:0; width:100%`，
   宽度跟随胶囊 —— 在 rail 里就等于被压到约 56px，中文逐字换行成竖排。
   原有的 `useEffect` 只在 `wide` **发生变化**时关闭面板；缩略状态下点击并不会改变 `wide`，
   所以那个兜底根本不会触发。

（`wide` 由 sidebar 经 ownerProps 传入：`renderSlot('sidebar.footer.action', { wide })`，
其值为 `!collapsed || !settled`。）

## 本次改动

| 位置 | 改动 |
| --- | --- |
| 胶囊元素 | 缩略状态**根本不挂 `onClick`**，标签由 `button` 换成 `div`（键盘回车也触发不了），
不再输出 `aria-expanded` / `aria-haspopup` |
| 光标 | 缩略状态由 `pointer` 改为 `default`，不再暗示"可以点" |
| 详情面板 | 渲染条件由 `open` 改为 **`open && wide`**：即使"先展开点击、再折叠"，
折叠当帧也不会在 rail 里闪出面板 |
| 展开状态 | 行为完全不变：仍是可点击的 `button`，点击切换面板，文字与数值照常显示 |
| 折叠兼容 | `wide` 缺失时（旧版 sidebar / 其他宿主）按展开处理，保持既有行为 |

**保留悬停提示**：缩略状态仍保留 `title`（鼠标悬停显示 `DeepSeek ¥7.38 / OpenAI Codex 33% 72%`）。
它是非点击交互，能在不展开侧栏时快速看到数值。若不需要，可以再关掉。

## 验证

新增浏览器半回归测试 `tools/test-collapsed-pill.mjs`（4 项，离线运行）：

```
[PASS] T1 展开状态：可点击、点击后显示完整详情面板
[PASS] T2 缩略状态：无 onClick / 非 button / 无面板 / 无文字
[PASS] T3 展开→折叠：面板即时收起且无闪烁
[PASS] T4 缺失 wide 时保持展开语义（向后兼容）
```

仓库里没有 jsdom/React 依赖，因此这个测试用**极简 hooks 运行时**（`createElement` /
`useState` / `useEffect` / `useMemo` / `useSyncExternalStore`）加载**真实的 `client.js`**，
再按数据结构断言渲染结果；测试用的上游数据就取自真机截图里的同一组数值
（DeepSeek ¥7.38 / Codex 33% 72%）。

> 这个测试在编写当天就抓到一个真实错误：改动胶囊时漏掉了 `var wide` 声明，
> 4 项用例全部以 `wide is not defined` 失败 —— 只有 `node --check` 是看不出这类问题的。

Host 半的既有回归测试 `tools/test-fetch-backends.mjs`（8 项）同时复跑通过，确认无回归。

## 兼容性

- 只改浏览器半（`client.js`）；Host 半、取数后端、配置项一律未动，**无需迁移、无需重填 Key**。
- 桌面端表现不变（侧栏足够宽，本来就没有这个问题）。
- 依旧零 DSH 核心补丁。

## 升级方式

```powershell
# npm（推荐）
dsh plugin --profile <你的 profile> add dsh-usage-dock@0.6.3

# 或 GitHub 源
dsh plugin --profile <你的 profile> add github:Slacom/dsh-usage-dock
```

安装后**重启 DSH**，浏览器硬刷新（Ctrl+Shift+R）；移动端 Web UI 同理，更新插件后重开页面。

> 客户端 bundle 在插件激活时缓存，不重启不会生效 —— 这是 DSH 的既有行为。

## 如果你还在更早的版本

- **0.6.2**：修掉移动端（Android APK）取数全断的问题 —— 取数改为 Host 进程内原生 `fetch`，
  不再依赖设备上有 `python` / `curl`，并让失败信息能指明后端与原因；
- **0.6.1 及更早**：`0.4.x` / `0.5.x` / `0.6.0` 未单独发布到 npm，
  累积变更见 [v0.6.2 发布说明](https://github.com/Slacom/dsh-usage-dock/releases/tag/v0.6.2) 文末的「累积变更」。

## 相关链接

- npm：https://www.npmjs.com/package/dsh-usage-dock
- 上游项目（本插件 fork 自）：https://github.com/chendefine/dsh-plugins-plan-usage
- 许可：MIT
