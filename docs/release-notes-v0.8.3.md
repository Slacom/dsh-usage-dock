# dsh-usage-dock v0.8.3 发布说明

发布日期：2026-10-16（外壳/符号部分）· 2026-10-17（追加「点空白不关闭」兜底与 DeepSeek
API Key 明细，同日**正式发布**：GitHub Release + npm `0.8.3`）

## 更新摘要（GitHub Release 正文）

## 本次更新
- WorkBuddy 积分改成「✦ 1,824」的写法（详情面板同步），与余额「¥39.85」风格统一。
- WorkBuddy 与 WorkBuddy AI 拆成两个独立渠道，可分别开关、分别排序。
- DeepSeek 余额在详情面板拆成「充值余额 / 赠金余额」两行；只填 API Key 的设备也能看到。
- 峰谷时段条在 API Key 模式下同样显示。
- 请求超时放宽到 30 秒、连续失败 5 次才提示「获取失败」，减少偶发误报。

## 本次修复
- 问题：详情卡片打开后，点击卡片外的空白处偶尔关不掉。
- 解决：补上鼠标、触摸、键盘三类点击来源，并避免在卡片里拖选文字时误关。

---

## 工程细节（维护者用）

## 符号与间距统一（胶囊 + 详情面板）

- **WorkBuddy 积分符号化**：胶囊右侧由「`1,824（积分）`」改为「`✦1,824`」——
  U+2726 BLACK FOUR POINTED STAR 前缀，与余额渠道「`¥39.85`」的
  「前缀符号 + 数字」语法完全同构（用户 2026-10-16 选定）。
- **详情面板同步**：WorkBuddy 大号数值行同样加 ✦ 前缀（`✦1,824`）；
  不限额场景胶囊与面板均为「`✦∞`」，替换原「`∞（积分）`」/「`∞（不限额）`」。
- **间距与轴线统一（两轮实测定稿）**：
  - ✦ 从 inline 文本改为**缩放行内块** `starFixStyle(size)` = `fontSize: size × 2/3`
    （胶囊 8px / 面板 12px），`lineHeight: 1`。理由：✦ 进宽 9.79px vs ¥ 6.47px
    （12px 语境），胶囊数值列右对齐对齐的是**进宽右缘**，两个符号墨迹中心相差
    1.79px——这就是用户看到的「¥ 与 ✦ 不在同一垂直轴线」。缩放后 ✦@8px 进宽
    6.53 ≈ ¥ 6.47，中心偏移实测 0.00px（面板语境 ✦@12px 进宽 9.79 ≈ ¥ 9.99）。
  - ✦ 与数字之间用**英文空格**（`STAR_GAP`），¥/$ 保持薄空格（`SYMBOL_GAP`）：
    ✦ 缩放后进宽变小，需配更宽的分隔才与 ¥ 打平。canvas 墨迹级可见间隙实测：
    胶囊 ✦ 1.81 vs ¥ 1.87（差 0.06px）、面板 ✦ 3.74 vs ¥ 3.60（差 0.14px）。
  - **垂直对齐（方案 B，第三轮修正）**：✦ 与数字此前是同一文本流内的基线对齐，
    基线本身是齐的（Android 实测底边同为 y=392），但 **Android Noto 把 ✦ 画得又小又靠下**
    （面板实测：✦ 墨迹 10px vs 数字 16px，光学中心低 3.0px；胶囊低 2.0px），而 Windows
    Segoe UI Symbol 下同一份 CSS 偏移 0.00px——**纯平台字体回退差异**，用 translateY
    只能治好一端。改为**数值区 flex 中心对齐**：`valueFlexStyle(size)` 给容器
    `display:inline-flex; alignItems:center`，✦ 与数字各成子项，间距由数字子项的
    `marginLeft: 0.34em` 提供（等价于原先的 STAR_GAP 视觉间距，但不再依赖字体基线）。
    实测偏移：胶囊 -1.17px → **-0.17px**；面板降至亚像素级。
  - 注意：flex 子项只在**数值区内层**（`valueFlexStyle` 包裹的「✦ + 数字」组），
    不拆到面板大号行的外层 flex（那会吃掉两次 `gap: 8`，是 0.8.3 中途的回归）。
  - 面板大号行 WorkBuddy 与 DeepSeek/MiMo 行高一致：✦ 缩放后不再把行撑高
    （未缩放时其墨迹 ascent 14 / descent 2 比 ¥ 的 13 / 0 更大）。
- ✦ 为单色文本符号，继承文字色（`--dsw-alias-label-primary`），随深浅色主题
  自动适配；真实 Chrome 渲染验证无豆腐块（候选符号、间距矩阵与几何测量过程留档
  `docs/demos/credit-symbol-demos.html`、`symbol-gap-align.html`、
  `symbol-column-align.html`、`symbol-final-v2.html` 与 `legacy/symbol-check/`）。
- DeepSeek / MiMo 的 `¥`/`$` 显示同步获得同一薄空格（`balanceSymbol` 统一出口），
  三家渠道「符号→数字」视觉节奏一致。

## DeepSeek 哨兵 API Key：跳过注定失败的回退请求

- **背景（用户真实用法）**：为不让「API Key 版 DeepSeek 模型」出现在可用模型列表里，
  用户在凭据库把 `DEEPSEEK_API_KEY` 设为占位值 `1`（模型只走账号登录）。该占位值会被
  本插件的凭据解析链读到——账号侧失败时回退到 API 分支，于是每 30 秒对官方 API 发一次
  注定 401 的请求，且报错文案把「Key 无效」放在最前，掩盖了真正的账号侧主因
  （面板显示 `Authentication Fails, Your api key: 1 is invalid（API Key 方式；账号侧：
  账号余额读取失败（Platform 返回 failed））`）。
- **修复（自动识别哨兵 Key）**：`plans/util.js` 新增 `isSentinelApiKey()`，`resolveApiKey()`
  在两级来源（插件配置、凭据库）上都剔除哨兵值，视为「没有可用 Key」：
  - 判定规则（刻意保守，只拦一眼不可能的值）：长度 ≤ 2，**或**不含任何 ASCII 字母；
  - 反例**不得**误判：`test-key`、`sk-tablet-test`、`sk-abc`、真实 `sk-<32位>` 形态
    （既有回归测试与部分用户的短 Key 依赖这些形态）；
  - 空串 / 非字符串不算哨兵（空串走原有「未配置」分支，语义不同）。
- **效果**：不再发起注定 401 的上游请求（每轮省一次出网），`plans/deepseek.js` 的错误
  回到 `no-key` 分支，文案以账号侧主因呈现：
  「账号余额不可用（账号余额读取失败（Platform 返回 failed）），且未配置 DeepSeek API Key」。
- **注**：这只影响**本插件**的余额查询；凭据库里那条 `1` 原样保留，其屏蔽 API 版模型的
  作用不受影响。
- 测试：`test-fetch-backends.mjs` 新增 T0（哨兵判定纯函数 + 解析链优先级）、
  T6b（哨兵 Key 不发上游请求、错误以账号侧为主因）、T6c（纯数字 Key 按哨兵处理），
  该测试 8 → 11 项。

## DeepSeek 余额明细：充值 / 赠金分行（账号 + API Key 两条路径）

- **需求（用户 2026-10-17）**：DeepSeek 的赠送余额「和 MiMo 一样在详情卡片里分开描述」。
- **账号路径**（桌面端已登录 DSH 账号，`deepseekAccount`）：
  `value` = 普通余额钱包 → `cashBalance`（面板写「充值余额」）；
  `bonusWallets` = 赠金钱包 → `bonusBalance`（面板写「赠金余额」）；
  `balance` 仍是两者之和，胶囊显示总计。
- **API Key 路径**（**此前遗漏，本次补上**）：开放平台 `GET /user/balance` 的
  `balance_infos[]` 本来就带 `topped_up_balance`（充值）与 `granted_balance`（赠金），
  但旧实现只映射了 `total_balance`。于是没有 `deepseekAccount` 的设备（DSHA / 平板 /
  未登录桌面端）只有总额一行、看不到明细——用户 2026-10-17 发现两条路径不一致。
  现在两条路径都返回 `cashBalance` / `bonusBalance`。
- **缺字段不伪造 0**：上游没给明细时 `toNum` 返回 `null`，客户端判 `typeof === 'number'`
  不成立 → 只显示总额，避免把「接口没给」画成「赠金 0 元」。
- **面板布局**：与 MiMo 同款「同一行左右两端」——DeepSeek 左「充值余额：」右「赠金余额：」；
  MiMo 左「现金余额：」右「赠送余额：」（控制台口径）。
- 测试：`test-fetch-backends.mjs` 11 → **13** 项，新增 T6d（API Key 模式返回充值/赠金明细：
  9.38 + 2.00 = 11.38）、T6e（明细字段缺失时回 `null`，面板只显示总额）。

## 峰谷条：API Key / 账号两种模式在所有设备都显示

- **背景（用户 2026-10-16 要求）**：峰谷条此前仅在 DeepSeek 账号登录（`via === 'account'`）
  时显示。该限制的理由（「API Key 没有账号充值/峰谷语义」）并不成立——峰谷计价是
  **DeepSeek 平台侧的计费规则**（北京时间 09:00–12:00 / 14:00–18:00 峰价，周末与法定假日
  谷价），与「用账号余额还是开放平台 API Key 查余额」无关：API Key 计费的模型同样按该规则计价。
- **改动**：`index.js` 的附加条件由 `plan.via === 'account' && plan.error === undefined`
  放宽为 `plan.error === undefined`——只要 DeepSeek 条目取数成功就附 `peakPhase` / `peakSegs`。
  客户端渲染条件本来就是 `plan.id === 'deepseek'`（不看 `via`），无需改动。
- **效果**：桌面端 / 移动端 / Web、账号登录与 API Key 两种鉴权方式**统一显示峰谷条**。
- 段窗口仍为 `now-12h-2min .. now+24h`（覆盖客户端 24h 可视窗：游标居中、左右各 12h）。
- 测试：`test-android-compat.mjs` 新增「API Key 模式也附峰谷相位与段序列」断言
  （相位结构完整、段序列覆盖 now±12h、段类型合法；13 → 14 项）；`test-degrade-refresh.mjs`
  的 T7 由「API Key 模式不显示峰谷条」改为「API Key 模式也显示峰谷条」，并保留
  「无 peakPhase 时不显示（旧 Host 兼容）」用例。

## 超时与失败阈值放宽（减少偶发「获取失败」）

- **背景（用户 2026-10-16 反馈）**：胶囊里 WorkBuddy 偶发显示「读取失败」而不是数值转灰。
  根因之一是该渠道 status 超时仅 15 秒，而它**每轮都打上游做真实计费查询**，慢响应即被判
  失败（transient，计入失败轮数）；失败阈值又只有 2 轮，30 秒轮询下约 1 分钟就翻成「获取失败」。
- **改动**（同步放宽到 30 秒）：

  | 位置 | 常量 | 旧 → 新 |
  | --- | --- | --- |
  | `client.js` | 客户端请求超时（`usage timeout`） | 20s → **30s** |
  | `client.js` | `FAIL_THRESHOLD`（连续失败轮数） | 2 → **5** |
  | `plans/util.js` | `REQUEST_TIMEOUT_MS`（单请求） | 20s → **30s** |
  | `plans/util.js` | shell 后端 `timeoutMs` / `curl -m` | 25s/20 → **35s/30** |
  | `plans/deepseek.js` | `ACCOUNT_TIMEOUT_MS`（账号余额） | 20s → **30s** |
  | `plans/workbuddy.js` | `STATUS_TIMEOUT_MS`（status 端点） | 15s → **30s** |

- **效果**：失败后旧值（灰字弱化）保留约 **2.5 分钟**（5 轮 × 30s）才转「获取失败」，
  给实时计费类上游的偶发慢响应留出恢复窗口。
- 测试：`test-degrade-refresh.mjs` 的 T3 改为「连续 5 轮失败才显示获取失败」，并新增
  T3.pre「第 2 轮失败仍保留旧值（阈值 5，未到）」；该测试 39 → 41 项。

## 详情卡片：点空白偶尔不关闭的兜底

**现象**（用户 2026-10-17 反馈）：详情卡片打开后，点击卡片外的空白处**偶尔**不会关闭，
再点一次胶囊才会收起。

**原因**：0.8.2 的外点关闭只挂了 `pointerdown`（window 捕获）。这条路径在三种情况下收不到事件：

| 盲区 | 说明 |
| --- | --- |
| 宿主不投递 PointerEvent | 旧 Android WebView、部分内嵌浏览器只实现 `mousedown`/`touchstart` |
| 键盘激活 | 用 Tab 聚焦面板外的按钮、回车激活时只有 `click`，没有按下事件 |
| 宿主吞掉按下 | 某些手势层/浮层在按下阶段就 `preventDefault()` 或改写了事件序列 |

此外还有两处**页面 JS 无法观测**的盲区，属于 DSH 桌面端本身的行为，与插件无关：

- **窗口拖拽区**：`[data-windows-titlebar]` 下有一条覆盖窗口顶部、`-webkit-app-region: drag`
  的横条（`frame:before`）。命中拖拽区时 Chromium/Electron 整条事件序列都不派发给页面；
- **原生滚动条**：点击滚动条同样不产生 DOM 事件。

**修复**：按下类事件改为 `pointerdown` + `mousedown` + `touchstart` 三路同时挂（捕获阶段），
并额外挂 `click` 兜底。去重用一个「本次交互是否从卡片内按下」的标记：

```js
var downInside = null                     // null = 本轮还没有按下事件
function onOutside(e)     { downInside = inCard(e.target); if (!downInside) setOpen(false) }
function onClickOutside(e){ if (downInside !== true && !inCard(e.target)) setOpen(false); downInside = null }
```

- 普通外点：按下瞬间关闭（与 0.8.2 观感一致）；
- 键盘激活面板外控件：`click` 兜底关闭；
- 在面板里拖选文字、松手落到面板外（`click` 的 target 退化成共同祖先）：**不**误关；
- `setOpen(false)` 幂等，多个事件重复命中无副作用。

## 其他

- 除上述修复外，0.8.2 的 DSHA WorkBuddy 修复、外点/Esc 关闭、展开动画、
  峰谷条方案 K 游标原样保留（见 [v0.8.2 发布说明](release-notes-v0.8.2.md)）。

## 测试

- 断言同步：degrade-refresh **42** 项（¥/✦ 断言改薄空格形态；T3 适配阈值 5；
  T7 改为「API Key 模式也显示峰谷条」）、panel-interactions **12** 项（T12 扩展 + 新增
  T20 mousedown 兜底、T21 click 兜底、T22 拖选不误关、T23 DeepSeek 明细分行）、
  collapsed-pill 4 项（`¥\u20097.38`）、android-compat **14** 项（新增 API Key 峰谷相位断言）、
  fetch-backends **13** 项（新增 T0 哨兵、T6b、T6c、T6d、T6e）、line-endings **21** 项（新增守卫）；
  其余 footer-row 11 / settings 6 / workbuddy 26 / mimo-parse 21 / peak-phase 32 /
  workbuddy-contract 5 / peak-marker 144 几何断言全部通过。

## 已知未做（用户 2026-10-16 决定）

- **小米 MiMo Cookie 自动续期**：经证据核查不可行——平台未公开登录/续期端点；
  `api-platform_serviceToken`（364 字符）为**非 JWT 的不透明 Base64 串**，无法离线解析
  过期时间；Cookie 内含 `api-platform_slh` / `api-platform_ph` 风控指纹字段，说明官方在
  防自动化登录。把账号密码存本地只能降低「传输泄露」风险，无法解决「插件进程/本机任意
  程序可读取」与「脚本登录易触发风控」两个根本问题。**保持手动粘贴 Cookie**；
  过期预警与 401 自动暂停轮询列为后续可选改进。
- **上游 401 报错回显凭据的加固**（DeepSeek 官方会在 401 响应体里回显收到的 Key，
  插件原样透传）：已识别该信息泄露面，列为后续可选改进。

## 安装

0.8.3 已发布到 **npm**（`latest`）与 **GitHub Release**。三种拿包方式：

1. **npm（推荐）**：`dsh plugin --profile <profile> add dsh-usage-dock@0.8.3`，
   或在「设置 → 插件 → 添加插件」里填 `dsh-usage-dock`；
2. **GitHub Release 附件**：下载本 Release 的 `dsh-usage-dock-0.8.3.tgz`，在「添加插件」里
   粘贴附件直链（`https://github.com/Slacom/dsh-usage-dock/releases/download/v0.8.3/dsh-usage-dock-0.8.3.tgz`），
   插件管理器支持 `.tgz` 直链安装；
3. **Git 仓库**：添加插件时填 `https://github.com/Slacom/dsh-usage-dock`（装主干最新提交）。

桌面端本机调试也可直接文件覆盖（见 `AGENTS.md` 第 4 节）。安装后重启 DSH / 安卓引擎并刷新页面。

> 升级说明：DSH 0.2.x 的插件管理器对第三方插件不支持原地升级（详情页没有「更新」按钮），
> 需要先卸载再安装；卸载不会删除 profile 里的渠道配置。

