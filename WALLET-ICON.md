# 钱包图标（桌面端设置页可用）

DSH Go 胶囊上的钱包图案是 **App 内置图标名** `wallet`（manifest 里只写名字，插件包不含该图形资源；
手机上无 APK，无法提取 App 原始矢量）。

为了桌面端设置主页/插件入口使用，本仓库提供：

- `icon.svg`：36×36，Material Symbols `wallet` 风格（**推荐用于桌面插件图标**）；
- `icon-outline.svg`：36×36 描边风格（更接近胶囊观感）；
- `docs/assets/wallet/`：备选素材、预览页 `preview.html`、许可说明 `NOTICE.md`；
- `package.json` 已加 `"icon": "./icon.svg"`（桌面 Cordis 插件同款约定）。

详见 `docs/capsule-wallet-icon.md`。
