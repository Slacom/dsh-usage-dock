# dsh-usage-dock v0.8.2 发布说明

发布日期：2026-10-15

## 主方向：DSHA（Android 移植）WorkBuddy 读取失败修复

### 背景

DSHA（Android APK / dsh web 0.2.0-rc.2）上 WorkBuddy 渠道一直显示「获取失败」，
报 `WorkBuddy 状态读取失败（fetch failed）`。经完整诊断（见 `DHSA移植反馈/交接文档-0.8.2修复.md`），
**usage-dock 本身无缺陷**，根因在宿主侧：

- DSHA 内置插件 `dsh-web-mobile@3.0.5` 的 `compress.js` 改写 `ServerResponse.prototype`
  做响应压缩，会把「可延迟」的响应头攒起来晚一拍提交；
- `@deepseek-ai/dsh-host-webserver` 的 gzip 中间件（阈值 1024 B）在 `res.end` 代理里
  看到 `headersSent` 仍为 false，会自己再调一次 `res.writeHead(statusCode)`；
- 该重入落回 `compress.js` 的 `patchedWriteHead`，它先 `flush()`（`headersSent` 变 true），
  后面的 guard 又因这个 true 调原生 `writeHead` → 抛 `ERR_HTTP_HEADERS_SENT` →
  webServer 兜底 catch 直接 `res.destroy()` → 客户端只见 `fetch failed`。
- 触发条件：**响应体 < 1 KiB 且带显式 `Content-Length`** + 客户端声明 gzip。
  WorkBuddy AI 版的 52 B `signed-out` 桩响应正好中招，而国内版（3.5 KB）正常；
  旧策略「任一版本失败即整体报错」于是把整条渠道拖垮。
- 该内置插件目录受 App 完整性保护（改了会被还原），只能从消费侧绕过。

### 修复 1：status 请求声明不压缩（`plans/workbuddy.js`）

`fetchStatus()` 的 fetch 请求头显式加 `accept-encoding: identity`——无编码可协商，
gzip 中间件不进入问题重入分支。已在 DSHA 真实宿主上实测：错误消失，
`creditsTotal` 恢复 1846、11 条明细。

### 修复 2：失败降级为「部分数据」（`plans/workbuddy.js` + `client.js`）

- Host：先看有没有任何版本真的拿到 credits——
  - 有 → 照常展示该版本合计，并带 `partial`/`partialNote` 标记；
  - 没有 → 保持原有 `api` / `exec` / `signed-out` 分类与文案。
  `signed-out` / 404 依旧不算失败（不是「另一方坏了」，只是没登录/没装）。
- Client：WorkBuddy 面板合计行下以灰色脚注（`sectionNoteStyle`）渲染
  `partialNote`（「以下版本未取到数据：…」），不把部分合计伪装成完整合计。
- 实测三场景（真实宿主 + 模拟）：一方失败一方正常 → 正常展示 + 脚注；
  两方都失败 → 仍报 `exec`；两方都未登录 → 仍报 `signed-out`。

> 注意：WorkBuddy 插件自身的设置卡片与「检查更新」（`/update`、`/probe` 端点）
> 仍受同一宿主 bug 影响，需宿主侧修复（方案已提交 dsh-web-mobile 维护者，
> 或用户级 `cordis.patch.yml` 关 gzip），不在本插件范围内。

## 新功能

### 详情卡片：点击卡片外自动关闭

详情卡片打开后，点击卡片外的任意位置自动关闭（pointerdown 捕获阶段判定，
按在胶囊/面板内不关；兼容 Shadow DOM `composedPath`）；Esc 同样关闭。
不必再通过再次点击胶囊来收起。

### 详情卡片：从胶囊向上展开的渐变动画

参考 DSH 桌面端左侧工作区「点击项目展开会话记录」的动效语言：面板出现那一帧
播放一次「从胶囊向上展开 + 渐显」动画（translateY 6px → 0 + opacity 0 → 1，
170ms，WAAPI 合成器路径，与峰谷条动画同款方案）；无 WAAPI 的环境（旧 WebView）
静态呈现，行为与上一版一致。打开期间的数据刷新不重播动画。

### 峰谷条游标：方案 K「上下对尖」

替换原 2px 白柱：上游 8×5 倒三角 + 轨道下 6×4 小正三角**夹住「现在」**，
色条内部没有任何覆盖物，也没有类似边界的竖线（方案出自
`docs/demos/cursor-directions-v2.html` 方向 K，用户定稿）。
上三角底缘与轨道上缘留 1px 空隙、下三角顶缘与轨道下缘留 2px 空隙，
全部挂在共享 50% 锚点上，不进轨道圆角裁切。

## 测试

- 回归总量 156 + 5 项全绿：
  - `test-workbuddy.mjs` 13 → 22 项：W8 改为降级策略断言（部分成功 → partial 标记 +
    不报错；两方都失败 → 仍 exec），新增 W11（两条 status 请求都带
    `accept-encoding: identity`）；
  - 新增 `tools/test-panel-interactions.mjs`（8 项）：外点/Esc 监听生命周期、
    点击卡片外自动关闭、卡片内按下不关、Shadow DOM 判定、Esc、展开动画
    单次播放与关键帧、partial 脚注渲染与无标记零影响；
  - `tools/test-peak-marker.mjs`（真实 Chromium 几何）改为方案 K 断言：
    上下三角与轨道中点同轴、1px/2px 空隙、无轨道内游标元素，24 组宽度/zoom
    组合共 144 项断言通过；
  - `tools/mock-react.mjs` 对齐真实 React 的两处语义（effect cleanup 保存与执行、
    渲染后补全 mock DOM 父子链），供外点判定测试使用；可选 `waapi` 运行时记录
    `element.animate` 调用。
- `test-android-compat.mjs` 13 项、`test-workbuddy-contract.mjs` 5 项（真实 0.7.4
  移植包源码契约）通过，模拟无 shell / 无账号 / 无 configEditor 宿主依旧成立。

## 升级

```sh
dsh plugin --profile web add dsh-usage-dock@0.8.2
```

桌面端按实际 profile 使用 `--profile desktop`。安装后重启 DSH / 安卓引擎并刷新页面。
