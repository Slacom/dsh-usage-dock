# 胶囊钱包图标说明（桌面端设置页图标可复用）

## 结论：这个钱包图案不是我加的图片

DSH Go 胶囊左侧的钱包图案**不是插件包里的图片资源**，而是 DSH Go App **内置图标集**中的一个图标：
我们在插件清单里只写了一个名字：

```json
"composer.strip": [{ "id": "strip", "icon": "wallet", "panel": "quota" }]
```

App 收到 `"icon": "wallet"` 后，用自己内置的图标字体/矢量库渲染。额度面板、MiMo 登录面板的
`icon` 也是同样机制（`"wallet"` / `"settings"` / `"qr"`）。因此：

- 图标本身来自 App，不在本仓库、也不在 npm 包里；
- 插件只能引用名字，不能替换/导出 App 内置图标；
- 手机上目前没有 DSH Go 的 APK，因此**无法把 App 里的原始矢量提取出来**。

## 为桌面端准备的钱包素材

考虑到你之后要把桌面端设置页移到设置主页、需要一个对应图标，本仓库已经放了可直接用的素材：

| 文件 | 用途 | 说明 |
|---|---|---|
| `icon.svg` | **推荐**：桌面插件入口 / 设置主页图标 | 36×36，Material Symbols `wallet` 风格，`currentColor` 填充 |
| `icon-outline.svg` | 备选：描边风格 | 36×36，更接近胶囊上看到的线条观感 |
| `docs/assets/wallet/` | 备选素材与比较 | Material Symbols 原尺寸、Lucide 版本、预览页、许可说明 |

用法（桌面端 Cordis 插件约定，官方插件同款）：

1. 包根放 `icon.svg`；
2. `package.json` 顶层写 `"icon": "./icon.svg"`（本仓库已经加上）；
3. 桌面端设置页/插件入口会自动读取并渲染该图标。

打开 `docs/assets/wallet/preview.html` 可以并排比较浅色/深色下的图标效果。

## 许可与来源

- Material Symbols（Apache-2.0，Google）：`icon.svg`、`wallet-material-symbols-filled.svg`；
- Lucide（ISC）：`wallet-lucide-outline.svg`；
- 本仓库自绘描边版本（MIT）：`icon-outline.svg`、`wallet-outline-36.svg`。

详见 `docs/assets/wallet/NOTICE.md`。

## 注意

当前提供的图标是**视觉近似**，不是从 App 提取的原始资源；如果桌面端希望与手机胶囊
1:1 一致，需要拿到 App 内置图标字体（APK/资源）或在桌面设计系统里找同源图标。
