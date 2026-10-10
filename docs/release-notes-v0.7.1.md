# dsh-usage-dock v0.7.1 — 悬停灰底与侧栏其他按钮完全对齐

> 上一版：**v0.7.0**。本版只修一处细节：胶囊悬停底色的左右边界。取数逻辑、配置项、
> 详情面板一律未动。

---

## 问题

v0.7.0 把胶囊改成了「透明 + 悬停灰底」，但灰底**比 Remote 等按钮两侧各短约 5px**，
放在一起能看出不对齐。

## 实测（用真机截图量的像素，不是目测）

| 元素 | 灰底左右边界 | 宽度 | 左右内距 |
| --- | --- | --- | --- |
| Remote 按钮 | x **10**..**339** | **330px** | 10px |
| 胶囊（v0.7.0） | x **15**..**334** | **320px** | 15px |

## 根因

`sidebar.footer.action` 这一行会给条目**留内距**：整行可用宽度是 x 10..339，
但条目的内容区只有 x 15..334。胶囊此前只声明了 `width:100%`，拿到的就是被缩进后的
320px。

`ds-harness-remote` 的侧栏条目对此有显式处理 —— **向外贴边**：

```css
.dshRemoteSidebarEntry.isWide{width:calc(100% + 8px);height:34px;margin:4px -4px}
```

## 本次改动

照抄同款写法（`ROW_BLEED = 4`）：

```js
// 展开态、且确认独占一行时
{ flex: '0 0 auto', width: 'calc(100% + 8px)', marginLeft: -4, marginRight: -4 }
```

- 左右各向外撑 4px，抵消整行内距，灰底边界与 Remote 对齐；
- **缩略（rail）态不贴边**：rail 只有约 36px 宽，外扩会溢出侧栏（测试 T9 专门守住这条）；
- 探测不到宿主 / 纵向容器时依旧完全不动（沿用 0.7.0 的降级路径）。

## 验证

浏览器半回归测试扩到 **9 项**，新增/更新的是：

```
[PASS] T1 横向 flex 行：容器开放换行 + 胶囊独占整行并向外贴边
[PASS] T9 缩略态不贴边（避免在 36px 宽的 rail 里溢出）
```

T1 现在断言 `width === 'calc(100% + 8px)'` 且左右 `margin === -4`，把这次的修复锁住；
T9 断言缩略态**不得**出现这两个外扩值。既有套件复跑无回归（取数 8 项、缩略交互 4 项）。

## 升级方式

```powershell
dsh plugin --profile <你的 profile> add dsh-usage-dock@0.7.1
```

安装后**重启 DSH**，浏览器硬刷新（Ctrl+Shift+R）。

## 相关链接

- npm：https://www.npmjs.com/package/dsh-usage-dock
- 上一版说明：[v0.7.0](https://github.com/Slacom/dsh-usage-dock/releases/tag/v0.7.0)
- 许可：MIT
