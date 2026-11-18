# dsh-go 原生适配：额度详情卡片 → 原生面板（0.11.0 开发中）

> 2026-11-14。依据：`dsh-go-usage-dock-适配交接.md`（DSH Go 1.0.16 / 引擎 DSH 0.2.2-rc.1 /
> dsh-go-bridge 0.4.0 / dsh-usage-dock 0.10.5）。范围只覆盖 **dsh-go 手机 App 的原生界面**；
> Web / 桌面端行为不变。

## 1. 结论与映射

dsh-go 的左侧聊天记录抽屉不开放插件座位；详情卡片的原生落点是**插件面板**：

| Web 版原本 | dsh-go 原生位置 | 本版状态 |
|---|---|---|
| 侧栏底部胶囊（余额摘要） | `composer.strip` 状态条 | **未做**（下一轮） |
| 点开的额度详情卡片 | `panels`：`session.tab`（对话详情 › 插件页签）+ `features`（全部功能） | ✅ 本轮 |
| 设置页渠道开关/Key | 沿用 Web 设置页；原生面板只读展示 | ✅ 不新增 |
| `usage_status` 模型工具 | 不变 | ✅ 不受影响 |

`package.json` 里 `dsh`（Web 半）与 `dshGo`（原生半）并存，互不影响：

```json
"dshGo": {
  "v": 1,
  "title": { "zh": "额度", "en": "Usage" },
  "icon": "wallet",
  "contributes": {
    "panels": [{ "id": "quota", "title": { "zh": "额度", "en": "Usage" },
      "icon": "wallet", "placement": ["session.tab", "features"] }]
  }
}
```

## 2. 实现

| 文件 | 职责 |
|---|---|
| `plans/dsh-go-native.js` | 原生半的全部纯逻辑：视图骨架、数据投影、失败回退、复制摘要、`ctx.dshGo.panel()` 注册 |
| `index.js` | 在 `apply` 最前面注册原生面板；提供 `loadConfig`（复用 `liveConfig` + `unpackConfig`）与 `collect`（复用各 provider、MiMo 显示快照、自定义余额取数） |
| `tools/test-dsh-go-native.mjs` | 37 项离线契约测试（清单 / 视图 / 数据 / 动作 / 设置页 / MiMo 登录 / strip 注册 / 无桥接回归） |
| `tools/test-dsh-go-strip.mjs` | 17 项 strip 纯函数（会话路由 / provider 映射 / 文本 / 截断 / 隐藏） |

数据流（面板打开时才启动，关闭即取消）：

```
面板打开 → view(scope, caps)：读 liveConfig，按当前启用渠道生成静态骨架（中文/英文）
        → data(scope, emit)：先推占位「正在读取…」，随后
             liveConfig → collect()（provider / MiMo 显示快照 / 自定义余额，全部 Host 进程内）
             → projectUsage()（白名单投影、窗口百分比统一成「剩余」口径）
             → buildNativeData()（金额/窗口/重置时间/失败回退/自定义行）
             → emit 完整数据对象（桥接算差量）
         → 之后每 30 秒重复一次；refresh 动作立即触发一次
```

要点：

- **视图 = 静态骨架 + 绑定**：数值全部写 `{"$":"data.channels.<key>.<field>"}`，App 每次收到新数据
  会整棵重新求值（视图规格 §3），刷新不需要重建视图。绑定可以放在任意值上。
- **视图预算**：`bytes 2196 / 27 组件 / 4 层`（上限 32 KiB / 120 / 8），中英文各一套。
- **进度条同时显示具体剩余百分比**（2026-11-14 真机反馈后补）：caption 形如
  「剩余 98% · 19:56 重置」，不再只有轨道没有数值。
- **失败语义与 Web 半一致**：暂时失败（transient）灰化保留上一次成功值（`warn` 色 + 「暂时失败，
  显示 HH:MM 的数值」）；鉴权/配置等永久失败立即显示固定错误文案，不用旧值掩盖。
- **自定义余额渠道**数量不定，用 `list` + 绑定 `data.customRows` 承载（不写死视图节点）。
- **不泄露**：视图/数据/复制文本只用 `projectUsage` 的白名单字段，不含 Key、URL、Cookie 或上游原文。
- **无 webServer 的环境**（dsh-go 插件检查器的隔离宿主）：`apply` 注册完原生面板即返回，
  让官方 `check --load` 能加载并校验视图；真实 DSH 主机都有 `webServer`，不受影响。

## 3. 验证记录（2026-11-14，本机 Android）

```
node /root/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load
# 原生界面能显示（面板 1）
# 视图 quota · session.tab · zh-CN / en-US：能显示（2196 / 2201 字节，27 组件，0 issue）
# 视图 quota · features   · zh-CN / en-US：能显示
```

> 检查器现在只剩一条**包级提示**：`/engines/dsh` 没写版本约束（既有约定，本轮未改）。
> 面板注册在检查器里显示为 `ready:true / live:true`。

- 新测试：`node tools/test-dsh-go-native.mjs` → **37 项通过**；`node tools/test-dsh-go-strip.mjs` → **17 项通过**。
- 关键回归（改动涉及 `index.js` 顶层）：`test-android-compat` 14、`test-usage-tool` 108、
  `test-usage-tool-register` 70、`test-usage-tool-host` 41、`test-usage-policy` 89、
  `test-usage-integration` 31、`test-host-custom` 31、`test-config-unwrap` 22、
  `test-footer-row` 12、`test-collapsed-pill` 4、`test-degrade-refresh` 44、`test-line-endings` 71
  全部通过。
- **不是真机渲染验证**：视图结构只由官方检查器的 App 解析器副本验证，尚未在 App 里实际打开看过。

## 4.5 原生设置页（0.11.0，2026-11-14 起）

额度面板底部是「刷新 / 设置」：点「设置」发 `{ open: "panel:settings" }` 打开本插件的原生设置面板。

**按渠道分组 + 策略输入条件显示（2026-11-14 第二轮返工）**

设置页用 6 个分组，每个渠道标题下紧跟它自己的开关 / 来源选择 / 登录入口 / 额度策略：

| 分组 | 内容 |
|---|---|
| 通用 | 插件总开关、启用额度策略；**策略总开关打开后**才显示「允许路由观察」与说明 |
| OpenCode Go | 渠道开关、关注额度策略；**关注打开后才显示** 5 小时/周/月 策略，每个窗口**一行两个框**（预警% / 收尾%），共 3 行（用 `grid columns: 2` 固定两列；`row` 在 form 里会按 160dp 最小宽压成一列，v2 `style.columns` 在部分 App 版本不生效）。标签压成单行（`5 小时 预警%`，不再换行显示 `（%）`）以降低卡片高度；`2/256` 计数器是 App 对 number/textField 的内置行为（`counterText` 固定渲染），插件侧无法关闭 |
| DeepSeek | 渠道开关、余额提醒（元）、关注额度策略；打开后显示 预警/收尾 金额 + 币种 |
| Codex | 渠道开关、额度来源（Connect / Subscription）、关注额度策略；打开后显示 5 小时/周/月 各一行两框 |
| MiMo | 渠道开关、余额提醒（元）、关注额度策略；打开后显示 预警/收尾 金额 + 币种；另含扫码登录 |
| WorkBuddy | 渠道开关、关注额度策略；打开后显示 预警/收尾 积分 |

- 「启用额度策略」「关注额度策略」是 **onChange 即时保存 + refresh 重建视图**：打开就出现输入框、
  关闭就收起（视图由 Host 按已保存配置生成）。注意这会在切换开关时重建表单，未保存的其它编辑会被刷新。
- 表单保存时只提交**当前视图中实际渲染**的字段：隐藏的策略输入不写入，保留原配置。
- 写回时 `quotaFocusChannels` 按 5 个关注开关重建（保留未知 id）；`quotaChannelThresholds`
  按渠道合并（windows / balance+currency / credits），保留其它渠道条目；收尾必须小于预警。

**MiMo 扫码登录（后端复用 0.10.5 的 Host 流程）**

- 扫码后宿主读完余额会等待「确认账号匹配」约 100 秒；原生面板没有确认控件，
  现在检测到 `awaitingBalanceMatch` 时自动回 `later`，登录几秒内完成；
- legacy 扫码登录的余额只存在会话 manager，不会自动生成 display 快照；现把它投影成
  display 形状，额度面板 / 网页胶囊 / 用量策略都能读到 MiMo 余额；
- 二维码剩余不足 45 秒会提示尽快扫描；过期后明确显示「二维码已过期」而不是静默卡住。
- **登录持久化（可选，默认开）**：`mimoRememberLogin` 开启时，扫码登录成功后把**平台侧
  cookie**（`api-platform_serviceToken` 等 4 个）交给 DSH 凭据记录保管
  （`ctx.credentials`，落盘 `$DSH_HOME/.credentials.yaml`，0600、原子写）；引擎重启后
  用保存的 cookie 重放 `GET https://platform.xiaomimimo.com/api/v1/balance`，
  200/code=0 即恢复余额，401/403/结构异常则删除记录并回落到重新扫码。
  记录不含账号密码、账号 cookie 或上游原文；设置页 MiMo 分组可关闭（关闭即删除记录）。
  残余风险：serviceToken 有效期与设备/IP 绑定情况未知，过期需重新扫码。

  **真机验证（2026-11-16）**：扫码登录成功写入记录（4 个平台 cookie，余额 14.58 CNY）；
  重启引擎后未再扫码，`restore-attempt` 重放余额接口成功，额度面板直接显示余额。
  注意：登录流程结束时会 `jar.clear()`，cookie 必须在读余额时（`askBalanceMatch`）
  抓取；`serviceToken` 的 Path 可能是 `/api`，要用余额接口完整 URL 取 cookie。


- 原生面板不重写流程：引擎进程内直接调用 Host 已注册在 connection.fetch 的 auth/QR handler
  （`host.native.auth/qr`），动作序列与网页原版一致：`capability → start → begin → status 轮询 → QR`；
- 2026-11-14 真机联调发现两处**官方接口变化**，按既有先例做最小兼容（不是改流程）：
  1. long-poll 地址变成 `*.account.xiaomi.com` 子域，vendor 域名校验只认精确 host →
     放宽为「官方域或其子域」（用途绑定不变）；
  2. 扫码后返回带引号的 cookie 值 / 账号域 cookie，legacy QR 流程的 CookieJar 未开
     `allowQuotedValues`、根域白名单缺 `account.xiaomi.com` → 按 console 流程 0.10.6 的
     同一授权先例补齐；只放宽引号包裹的合法值，其它字节/域/路径/过期规则不变。
  3. 真机网络会混入 6 条格式非法的 `Set-Cookie`（实测全是 `E_COOKIE_BAD_NAME`：没有 `=` 或
     名字不是合法 token）。浏览器语义是**直接忽略解析失败的行**，旧流程却整次判
     `E_SET_COOKIE_REJECTED`。现改为只记录固定枚举后继续；必需的凭据 cookie 仍由后续
     token gate 把关，非法行本来就不会被存下或发送。
  4. 扫码回执里的凭据字段（passToken/userId/cUserId/deviceId）现在可能带引号
     （quoted `"..."`，与 console 0.10.6 同一先例）。旧流程按裸 cookie-octet 校验会判
     `E_CREDENTIAL_FIELD_INVALID`；现按 jar 同一口径放行严格引号包裹的合法值（原样出站，
     不 decode/unescape），失败时诊断会带固定枚举 `field + reason`。
  5. 官方回执的 `userId` 现在是 JSON **number**（console 夹具同样用 `Number(ACCOUNT_ID)`）。
     仅接受安全非负整数并转成十进制字符串；其它类型仍拒绝。
  7. 凭据来源校验仍只认精确 `account.xiaomi.com`，而长轮询来源是官方子域
     （`ak.lp.account.xiaomi.com`）→ 扫码后 `E_URL_PURPOSE_MISMATCH`。改为「官方账号域或
     其子域」，cookie 仍按固定 `https://account.xiaomi.com/` 归属吸收。
  6. 移动网络偶发瞬时断连会表现为 `E_NETWORK`：legacy 流程的 GET 现在**单次重试**（300ms）；
     所有网络失败点（含响应体读取）都带固定枚举诊断 `step + networkCode`
     （如 `redirect · ECONNRESET`、`longPoll · UND_ERR_SOCKET`），不再有「无信息 E_NETWORK」。
  这三处修正同时惠及网页版的登录流程。
- 失败时透传 `failure.code`（例如 `E_SET_COOKIE_REJECTED`），动态审批仍提示去网页版。

## 4.4 composer.strip 胶囊（2026-11-15）

输入框上方 dock 卡片堆里的「一行额度」：只显示**当前会话模型供应商**对应的一个额度渠道，
点按打开 `quota` 面板（`presentation: "sheet"` 底部弹层，全部已启用渠道）。

**清单**：`dshGo.contributes["composer.strip"] = [{ id: "strip", icon: "wallet", panel: "quota" }]`；
strip id 与面板 id 不重复（面板仍叫 `quota`）。每插件只有 1 条 strip、文本 ≤24 字。

**路由判定**（宿主半侧，`plans/strip.js` 纯函数 + `index.js` 状态）：

- 订阅 `session/event`，三类事件 latest wins：`model/selection` → `request/header`
  （`data.header.config.provider`）→ `assistant/message`（`data.message.source`）；
- strip 首次订阅/换会话时用 `sessions.get(id).snapshotEvents()` 回填最近 400 条事件；
- 只按 `sessionId` 隔离，多会话不串；拿不到路由就 `emit(null)` 隐藏，不猜渠道。

**provider → 渠道**：内置走 `resolveRoute()`（与网页同一张 ROUTE_TABLE，精确匹配），
自定义余额渠道按条目的 `provider` 精确匹配；未映射 → 隐藏。MiMo 的 provider id 待真机确认后
再补 ROUTE_TABLE（当前手机 profile 没有 MiMo 模型路由）。

**文本模板**（≤24 字，`plans/strip.js#formatStripText`）：

| 渠道 | 示例 | 规则 |
|---|---|---|
| OpenCode Go | `OpenCode Go 96% 79% 90%` | **渠道全名** + 数值按 5 小时→周→月依次（不是取最紧窗口） |
| Codex | `Codex 58%` | wire 是 remaining，不写成已用 |
| DeepSeek | `DeepSeek ¥12.34` | 余额 + 币种符号 |
| MiMo | `MiMo ¥8.50` | 账户余额（含 legacy 扫码登录后的余额） |
| WorkBuddy | `WorkBuddy 3,200 分` | 积分，不与金额混比 |
| 自定义 | `<名称> ¥xx` | 名称截断，保证数字可见 |

- 单行文本无法真正右对齐（宿主会折叠空白），数值只能跟在名字后面；这是 strip slot 的限制。
- `tone`：百分比 ≤10 `bad`、≤30 `warn`；余额 ≤0 `bad`；
- 失败/未知/无窗口/无余额 → 返回 null（隐藏），有上次可用值则继续显示旧值并后台刷新；
- 数据优先复用额度策略观察里的投影（同一份数据，不重复请求上游），缺失时才单渠道补拉
  （30 秒缓存、single-flight），并同时发布额度观察。

**详情 sheet**：`quota` 面板增加 `presentation: "sheet"`；从 strip 打开时 scope 带 `sessionId`，
数据里额外给 `sessionChannel`（「当前会话：OpenCode Go」）显示在顶部；从「全部功能」打开时为空串。

**测试**：`tools/test-dsh-go-strip.mjs`（17 项纯函数：路由事件/映射/文本/截断/隐藏）；
`tools/test-dsh-go-native.mjs` 增至 37 项（含 strip 清单与注册）。

## 4. 真机安装与验收（待做）

1. 本地路径安装（会把 profile 里的 npm 包替换为指向本仓库的链接，装前先确认）：
   ```sh
   dsh plugin --profile web add "/sdcard/WorkSpace/DSH/Usage Dock"
   ```
2. App 的「引擎」页重启引擎（`lib` 代码不会热生效；`package.json` 清单会自动重读）。
3. 打开任意对话 → 右侧「对话详情」→「插件」页签：应出现「额度」面板；「全部功能」里也能进入。
4. 检查：各渠道余额/窗口百分比/更新时间、失败时保留旧值提示、刷新/复制按钮。
5. 回归 Web 模式：侧栏胶囊、设置页「Usage Dock」页签保持原样。
6. 回滚：`dsh plugin --profile web add dsh-usage-dock`（回到 npm 0.10.5）。

## 5. 已知限制与下一步

- `composer.strip` 状态条未做；原生位置选择遵循交接文档，但用户尚未在真机确认观感。
- 面板打开期间与 Web GUI 可能各自请求一次（30 秒节奏）；暂不共用缓存。
- 视图骨架在面板打开时生成：运行中改配置/排序后，**重新打开面板**才会更新分块。
- DeepSeek 峰谷条、充值入口、赠金明细、Codex Subscription 适配入口等 Web 卡片细节未搬到原生
  面板（本轮只做额度总览）。
- MiMo「登录不可用（需要新版宿主）」与 Codex Subscription 版本/补丁问题仍按
  `docs/backlog.md` §2 单独处理，与本面板无耦合。
- 版本号未动；按 AGENTS.md 的推送闸门，**用户真机确认前不 push / 不发版**。

## WorkBuddy 在手机端显示「渠道配置有误」（2026-11-17 修复）

**现象**：桌面端 WorkBuddy 积分正常，手机原生面板 WorkBuddy 一行显示「—」+「渠道配置有误」。

**根因**：`plans/workbuddy.js` 取数要按「模型提供商 id」在宿主目录里找网关，旧代码写死
`workbuddy`。而 provider id 是 `设置 → 模型` 里 `providers` 下的**键**，与设备配置有关：
桌面端就是 `workbuddy`，手机端是自定义来源 `custom-workbuddy`（只有 `displayName` 叫
`workbuddy`）。目录里查不到 → `config` → 界面「渠道配置有误」，且**零请求**。

**修复**（`pickGatewayProvider`，纯函数）：
1. 设置里的 `workbuddyProvider`（新配置项，留空=自动）填了就只认它，填错如实报错；
2. provider id 归一化后等于 `workbuddy`；
3. `displayName` 归一化后等于 `workbuddy`（手机端命中这条）；
4. provider id 归一化后以 `workbuddy` 结尾（`custom-workbuddy`）。
3/4 命中多条视为歧义，要求显式指定，绝不猜。

**验证**：手机端用凭据库里的 Key 直连网关 `GET /v1/credits` 返回 200，
`creditsFromClientCredits` 解析出 `total: 1110`（1 个账号）；回归测试 G13–G19。

## provider → 渠道归一化（2026-11-17）

**症状**：手机端用 WorkBuddy（provider id `custom-workbuddy`）聊天时，输入框上方没有胶囊，
额度策略也不注入 `[当前额度快照]`——但额度面板里 WorkBuddy 数值正常。

**根因**：胶囊与策略共用 `resolveRoute()` 做「当前模型 → 渠道」映射，旧实现只做**精确 id**
匹配；`custom-workbuddy` 不在表里 → unmapped → 胶囊 `emit(null)` 隐藏、策略静默不投放。

**修复**（`plans/quota-prompt.js`）：
1. 精确 id（`workbuddy`、`workbuddy-ai`、`opencode-go`、`openai-codex`、`deepseek-account` / `deepseek-official`）；
2. 词元连续包含 + **最长匹配**：`custom-workbuddy` → `workbuddy`，`custom-workbuddy-ai` → `workbuddy-ai`；
3. 等长多命中 ⇒ 歧义，返回 null（不猜）；
4. **不转小写、不去空白**：`WORKBUDDY` / `" workbuddy"` 仍不命中（沿用 A12 的严格约定）。

胶囊侧不需要改：`providerToChannel()` 本来就先调 `resolveRoute()`，所以一处修好两处生效。


