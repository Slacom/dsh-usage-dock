# 2026-10-15 · 峰谷条标记修复与新方向

## 接手状态

仓库存在较多未提交的 0.8.0 / 本地 0.8.1 改动，本次未回退它们、未改版本号、未提交或发布。
当前客户端已经包含 24h 平滑移动图案、分钟校准、WorkBuddy 明细与充值入口回退；旧 roadmap / AGENTS 对这些本地改动的描述并不完整。

## 本次修复

- 原实现将轨道和倒三角行独立布局，且三角行在轨道之后，倒三角实际位于轨道下方。
- 删除分离的三角行。现在使用一个定位 stage、一个 `left:50%` 的零宽锚点，同时承载柱与 8×5px clip-path 三角。三角的尖端接触轨道上缘。
- stage 与轨道使用同宽的无边框坐标面，图案显式 `left:0`。去除旧边框对测量宽度与图案内容宽度的影响，不再拿不同盒子的 50% 或 margin 修补对齐。
- ResizeObserver 监听轨道尺寸，补足仅监听 window.resize 无法覆盖的侧栏宽度变化。
- 此次保留原 2px 柱，只修复定位。白柱替代样式尚待用户选择。

## 候选样式

新纯静态页面：[6 个新方向](<demos/cursor-directions-v2.html>)。G 柔焦光束、H 三角引线、I 悬针留白、J 一体锥针、K 上下对尖、L 断续准线。每项有橙段、蓝段、边界右侧 1px 三场景；可在浏览器切换深色卡片。已用 Chrome 截图检查整页布局。

## 测试与部署

- `node --check client.js` 通过；`git diff --check` 通过。
- collapsed-pill 4、footer-row 11、degrade-refresh 32、peak-phase 32：共 79 条通过。
- 新增 [真实 Chrome 几何测试](<../tools/test-peak-marker.mjs>)：提取真实 client.js 的 PeakBar 与样式，24 组宽度 / CSS zoom 组合，共 120 条断言通过。覆盖三角/柱同轴、轨道中点、尖端在上沿、柱高与单锚点结构。不是完整 React/DSH 截图测试，也不替代用户真机确认。
- 仅将 client.js 复制到 desktop profile 的插件目录，源文件与安装副本 SHA256 相同。未触碰 Host、未重启用户应用。
- 客户端 bundle 在插件激活时缓存：用户重启 DSH 后 Ctrl+Shift+R，再检查本轮修复；尚未确认现有 GUI 已显示新代码。未启动其他服务器。

## 测试目录权限记录

真实浏览器测试首次无法创建 legacy 下的临时目录。经授权在沙箱外运行内置诊断脚本，检查 legacy 及其全部上级，仅给 legacy 补齐当前用户的完全控制权限，复读验证通过；没有修改文件内容或所有者，没有移除其他包权限。沙箱内测试仍被拒绝，因此经再次授权在沙箱外执行浏览器测试并通过；没有声称沙箱写入已恢复。

完整报告：[权限诊断报告](<E:/WorkSpace/DSH/acl-recovery-peak-marker/acl-report-d6d459442fcb463994732823b99acc60.jsonl>)。

如需撤销这次权限补齐（并非继续测试所需）：

```powershell
pwsh -NoProfile -File 'E:\WorkSpace\DSH\acl-recovery-peak-marker\acl-backup-420b8211296d4915a92de07f665160ae.json.ps1' -Path 'E:\WorkSpace\DSH\DSH Usage Dock\legacy' -AllowRoot 'E:\WorkSpace\DSH\DSH Usage Dock' -Restore 'E:\WorkSpace\DSH\acl-recovery-peak-marker\acl-backup-420b8211296d4915a92de07f665160ae.json'
```
