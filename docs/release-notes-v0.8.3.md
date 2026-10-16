# dsh-usage-dock v0.8.3 发布说明

发布日期：2026-10-16

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
  - ✦ 必须**内嵌在数值 span 内**，不能拆成 flex 子项——面板大号行 `gap: 8` 会被
    吃两次，使 ✦ 后面多出 8px 空隙（0.8.3 中途出现过的回归，已修正）。
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

## 其他

- 无其他功能或修复；0.8.2 的 DSHA WorkBuddy 修复、外点/Esc 关闭、展开动画、
  峰谷条方案 K 游标原样保留（见 [v0.8.2 发布说明](release-notes-v0.8.2.md)）。

## 测试

- 断言同步：degrade-refresh **41** 项（¥/✦ 断言改薄空格形态；T3 适配阈值 5；
  T7 改为「API Key 模式也显示峰谷条」）、collapsed-pill 4 项（`¥\u20097.38`）、
  android-compat **14** 项（新增 API Key 峰谷相位断言）、fetch-backends **11** 项；
  其余 panel-interactions 8 / footer-row 11 / settings 6 / workbuddy 22 /
  mimo-parse 21 / peak-phase 32 / workbuddy-contract 5 / peak-marker 144 几何断言
  全部通过。

## 已知未做（用户 2026-10-16 决定）

- **小米 MiMo Cookie 自动续期**：经证据核查不可行——平台未公开登录/续期端点；
  `api-platform_serviceToken`（364 字符）为**非 JWT 的不透明 Base64 串**，无法离线解析
  过期时间；Cookie 内含 `api-platform_slh` / `api-platform_ph` 风控指纹字段，说明官方在
  防自动化登录。把账号密码存本地只能降低「传输泄露」风险，无法解决「插件进程/本机任意
  程序可读取」与「脚本登录易触发风控」两个根本问题。**保持手动粘贴 Cookie**；
  过期预警与 401 自动暂停轮询列为后续可选改进。
- **上游 401 报错回显凭据的加固**（DeepSeek 官方会在 401 响应体里回显收到的 Key，
  插件原样透传）：已识别该信息泄露面，列为后续可选改进。

## 升级

```sh
dsh plugin --profile web add dsh-usage-dock@0.8.3
```

桌面端按实际 profile 使用 `--profile desktop`。安装后重启 DSH / 安卓引擎并刷新页面。

