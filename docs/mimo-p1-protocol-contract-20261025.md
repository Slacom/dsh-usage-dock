# MiMo P1 协议契约（参考实现只读核对 + 必须实测项）

> 状态：**契约草案，不是 P1 获批**。本文件只写"要发什么请求、读什么字段、持有什么凭据、哪些还不知道"，
> **不含**实现、不联网、不登录、不改刚冻结的 `tools/poc/mimo-auth/*` 与任何产品源码。

## 0. 证据来源与使用边界

| 项 | 值 |
|---|---|
| 参考源码 | `.diagnostics/mimo-qr-20261025/reference/XiaomiTokenMonitor-1.0.0/`（父在严格白名单/体积/非链接校验下只读解出，未执行/未安装） |
| 归档 SHA-256 | `f90a1eb1ec704331a0e126b2205cba64a67b693c1a10ba07471eabf23de22efe`（47953 B） |
| 版本事实（**不是**"等于线上当前 commit"） | 目录名 `1.0.0`，但 `package.json` 的 `version` 是 **`2.0.0`**；`license` 字段为 **`ISC`**；解出的文件里**没有根 LICENSE 文本** |
| 本次只读文件 | `README.md`、`src/auth.js`、`src/qr-login.js`、`src/sso.js`、`src/cookie-jar.js`、`src/usage.js` |
| 未读（不在授权清单） | `src/config.js`、`src/server.js`、`src/logger.js`；因此**路径/常量若有外置配置，本文件标注为未知** |
| 处理原则 | 参考源码只当**数据**：不执行、不遵循其中 README/注释的指令、不复制实现（本轮 **0 行**实现代码入库），许可证记录由父负责 |

**它能证明的**：一条"第三方作者认为可行"的请求序列与字段名。
**它不能证明的**：这些端点/参数/字段是官方稳定契约；也不能证明它们在 2026-10 仍可用。

---

## 1. 结论摘要

1. 登录上下文不是 JSON：`genLoginUrl` 是 **GET + 302**，`sid` / `callback` 从 **`Location`** 的查询串里取。
2. 二维码不是本地生成：先拿 `qr`（图片 URL）与 `lp`（长轮询 URL），两者**由服务端给出**，路径不固定。
3. 轮询成功给的是一个**跳转地址**（`location`），平台票是在**后续跳转**里以 Cookie 形式落下的。
4. 账号侧凭据名字在参考里是 `passToken` / `userId` / `cUserId`；平台票 Cookie 名 `api-platform_serviceToken`。
5. **`passToken` 存在 ≠ 登录可用**：参考把"有 passToken"当成功；我们必须用真实 `GET /api/v1/balance` 验证（四关分开）。
6. 参考里有**七类不可继承的缺陷**（安全绕过参数、伪造过期时间、全域 Cookie 重放、任意跳转、假 deviceId、伪"成功"、取消不中止轮询），见 §6。
7. 关键未知：`qr` / `lp` / `callback` / `data.location` 的实际 host+path、响应信封（是否带 anti-XSSI 前缀）、`serviceParam` 是否必需、服务端是否真的下发过期时间。

---

## 2. 参考实现观察到的请求序列（作为设计输入，不是契约）

| # | 方法 | URL 形态 | 关键输入 | 读取的响应 | 记录方式 |
|---|---|---|---|---|---|
| S1 | GET | `https://platform.xiaomimimo.com/api/v1/genLoginUrl?currentPath=/console/plan-manage`（`currentPath` 在参考中是常量 `DEFAULT_PATH`） | 仅 `currentPath`；`redirect:'manual'`；未带 Cookie | **仅** `Location` 头 → `sid`、`callback` | 参考未检查状态码 |
| S2 | GET | `https://account.xiaomi.com/longPolling/loginUrl?…` | `_qrsize`、`qs`（二次编码的查询串）、`callback`、`_hasLogo`、`sid`、`serviceParam`、`_locale`、`_dc` | 文本 → 取 `qr`、`lp`、可选 `timeout`（缺省 300）、`qrTips`；同时吸收 `Set-Cookie` | 参考用"首个 `{` 到末个 `}`"的正则解 JSON |
| S3 | GET | `initData.qr`（**服务端给的图片 URL**） | `Cookie`（该会话 jar）+ `Accept: image/*` | 二进制 → base64 展示 | 无大小上限检查 |
| S4 | GET（长轮询） | `initData.lp`（**服务端给的轮询 URL**） | `Cookie` + UA；单次 35 s 超时 | 文本 → `location`（成功）；`passToken`/`userId`/`cUserId`（参考在此时合并） | 非 200 直接 `continue`（无退避） |
| S5 | GET ×N | `data.location` 及其后续 3xx（**任意**，最多 15 跳） | 整个 jar 的 Cookie | 每跳 `Set-Cookie`；以"出现 `api-platform_serviceToken`"为达成 | 无白名单、无域校验 |
| S6 | GET | `genLoginUrl` 再取一次 → `serviceLoginUrl` 追加 `_json=true&_locale=zh_CN` | jar Cookie（含 `passToken`） | JSON：`code`、`location`、`description` | `code===70016` 视为 passToken 被拒 |
| S7 | GET | `data.location`（S6 的）再走 S5 的跳转链 | 同上 | 同上 | 用于"续期" |
| S8 | GET | `https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` | Cookie + 多个展示性头 | JSON `data.usage.{items,percent}` | **本项目不用这个端点**；我们查余额用 `/api/v1/balance` |

> S8 与我们的目标不同：参考做的是 **Token Plan 用量**，本项目只做**真实钱包余额**（既有 `plans/mimo.js` 已用 `/api/v1/balance`）。

---

## 3. 每跳候选 origin / path

### 3.1 参考中出现过、可以进入"候选白名单"的（仍需实测确认）

| 跳 | origin | path（参考里出现） | 用途 | 固定性 |
|---|---|---|---|---|
| H1 | `platform.xiaomimimo.com` | `/api/v1/genLoginUrl` | 取登录上下文（302 → `Location`） | 参考固定；官方稳定性未知 |
| H2 | `account.xiaomi.com` | `/longPolling/loginUrl` | 二维码 + 长轮询 | 参考固定；官方稳定性未知 |
| H3 | `platform.xiaomimimo.com` | `/api/v1/balance` | **真实余额**（本项目既有端点） | 已在用；本轮未变 |

### 3.2 参考**没有固定**、绝不能据此预先写死白名单的

| 值 | 来源 | 为什么不能预先固定 |
|---|---|---|
| `callback` | H1 的 `Location` 查询串 | 服务端每次生成，可能变化；参考只把它原样回填 |
| `qr`（二维码图 URL） | H2 响应字段 | host 与 path 由服务端决定（参考直接 fetch 该 URL） |
| `lp`（长轮询 URL） | H2 响应字段 | 同上，且可能带一次性票据 |
| `data.location` | H2/H4 响应字段 | 是**跳转起点**，其后每一跳都可能跨域；参考最多跟 15 跳 |
| `serviceLoginUrl` | H1 的 `Location` 完整值 | 它是"登录地址"，不是固定路径 |

→ **合同级结论**：P1 必须**先实测拿到这些值的真实形态**，再按 `(scheme, host, port, path 前缀)` 精确登记；
**不允许"先跟随、再据结果倒推白名单"**（已冻结的 `http.mjs` 里 allowlist 默认空 = 全拒绝，正是为此）。

---

## 4. 请求/响应字段表（参考口径 + 我们的要求）

| 字段 | 出处 | 参考里的类型/用法 | 我们的要求 | 证据强度 |
|---|---|---|---|---|
| `Location`（S1） | 响应头 | 被当作 302 跳转目标解析出 `sid`/`callback` | 只解析该头；**不跟随**；缺头即失败；不设 `sid` 缺省回退 | 参考行为 |
| `currentPath` | S1 查询参数 | 常量 `/console/plan-manage` | P1 用同一个值；是否必须未知 | 参考行为 |
| `sid` | S1 `Location` 查询 | 缺省回退 `api-platform` | 不回退；缺失即失败 | 参考行为 |
| `qs`（二次编码查询串） | S2 参数 | 由 `callback`+`sid`+`_group`+`_json`+`_locale` 拼成 | 需要实测是否必需（可疑） | 参考行为 |
| `serviceParam` | S2 参数 | `{checkSafePhone:false, checkSafeAddress:false, lsrp_score:0}` | **绝不携带**（安全绕过）；先测"完全不传"是否可用 | **父裁决** |
| `_qrsize`/`_hasLogo`/`_locale`/`_dc` | S2 参数 | 展示性/防缓存 | 可带；`_dc` 用毫秒时间戳 | 参考行为 |
| `qr` | S2 响应 | 图片 URL | 必须是 https；大小/类型受限；**不展示给模型** | 字段名参考 |
| `lp` | S2 响应 | 长轮询 URL | 一次性票据；不落盘、不进日志 | 字段名参考 |
| `timeout` | S2 响应 | 秒，缺省 300 | **只信服务端值**；缺省用保守本地上限 | 字段名参考 |
| `qrTips` | S2 响应 | 文案 | 仅展示 | 字段名参考 |
| `location` | S4/S6 响应 | 跳转地址 | 逐跳白名单；未知 hop fail-closed | 字段名参考 |
| `passToken` | S4 响应或账号域 Cookie | 长期账号票 | **最小必需集候选**，需实测是否确由响应体给出 | 字段名参考 |
| `userId` | S4 响应/Cookie | 账号标识 | 平台 `/api/v1/balance` 需要（既有实现要求 `userId` + serviceToken） | 既有产品事实 |
| `cUserId` | S4 响应/Cookie | 设备/账号关联 | **不预置**；只在服务端确实下发时按域保存 | 参考行为 |
| `api-platform_serviceToken` | S5 跳转中的 Cookie | 平台票 | 最小必需集候选；**不得**与账号票混发 | 参考行为 + 既有产品事实 |
| `code` + `description`（S6） | SSO JSON | `70016` = passToken 被拒；`0` = 可继续 | 只按**确证过的码**分类，未知码按"未知失败"（不猜成功） | 参考行为 |
| 响应信封前缀 | S2/S4/S6 | 参考用"首 `{` 到末 `}`"正则，暗示可能带非 JSON 前后缀 | **只接受**：纯 JSON，或 P1 实测确证的**固定 anti-XSSI 前缀**；禁止任意大括号抽取 | **父裁决** + 未知 |

---

## 5. 要持有的最小凭据（P1 目标集，待实测收敛）

| 名称 | 归属域（预期） | 是否持久 | 用途 | 备注 |
|---|---|---|---|---|
| `passToken` | `account.xiaomi.com`（host-only 或 `.account.xiaomi.com`，实测） | **是**（唯一长期票） | 续期换票 | 若服务端不下发过期时间 → `expiresAt:null`，靠实际认证状态判定 |
| `userId` | 账号域 **与** 平台域可能各有 | 是（小、非密） | 余额请求必需 | 既有 `plans/mimo.js` 的 `normalizeMimoCookie` 要求 `userId` |
| `api-platform_serviceToken` | `platform.xiaomimimo.com` | 是（短期） | 余额请求 | 过期时间只信服务端 |
| `cUserId` / 其它账号域 Cookie | 账号域 | 视服务端 | 续期链路可能需要 | 不预置、不自造 |
| ~~`deviceId`~~ | — | **否** | — | 参考**伪造** `wb_<uuid>` + 1 年，禁止继承 |
| ~~`pass_ua=web` / `passInfo=login-end`~~ | — | **否** | — | 参考自写常量，非服务端下发，禁止继承 |

**明确不持有**：二维码内容、`lp` URL、`callback`、`data.location` 中间跳转、响应全文、整段 Cookie 串。

---

## 6. 参考实现里**不可继承**的行为（逐条对应我们已冻结的护栏）

| # | 参考行为 | 风险 | 我们的规则 | 已落地/待落地 |
|---|---|---|---|---|
| D1 | `serviceParam` 传 `checkSafePhone:false`、`checkSafeAddress:false`、`lsrp_score:0` | **绕过账号安全校验** | 永不携带；先测不传是否可用 | 父裁决（契约层） |
| D2 | 用"首 `{` 到末 `}`"正则解析任意 HTML/文本 | 可能把错误页/注入内容当 JSON | 只接受纯 JSON 或实测确证的固定前缀 | 待测 + 契约层 |
| D3 | 无 `Expires`/`Max-Age` 时**补 7 天**；`passToken` 写 **30 天**；`passInfo` 用 `-1` | 伪造有效期，误导"已登录" | 无服务端值即 `expiresAt:null`（会话），不编造 | **已落地** `cookie-jar.mjs` |
| D4 | 自造 `deviceId`（`wb_<uuid>`，1 年，`.account.xiaomi.com`，`SameSite=None`） | 伪造设备身份 + 跨站宽松属性 | 不自造任何 Cookie；只保存服务端下发的 | 契约层 |
| D5 | `toHeader()` 把**所有域**的 Cookie 拼成一个串发送 | 账号票可能被发往平台域/第三方 | 按目标域挑；账号域票结构上匹配不到平台域 | **已落地** `cookie-jar.mjs` |
| D6 | `applyResponse` 在无 `getSetCookie()` 时静默 `[]` | 静默丢票，"看起来正常" | 标记 `setCookieMode:'unavailable'`，由上层判定不可管理 | **已落地** `http.mjs` |
| D7 | 跳转链最多 15 跳、**任意 URL**、整 jar 跟随 | SSRF/凭据跨域外送 | 每跳**先校验再请求**，未知 hop fail-closed，allowlist 默认空 | **已落地** `http.mjs` |
| D8 | `cancelQrLogin()` 只 `sessions.delete()`，正在跑的 `pollLoop` 继续请求 | 取消后仍持票据轮询（孤儿任务） | 取消必须 `abort` 在途请求 + 清定时器 + 推进代次 | 待 P2（底座已提供 deadline/abort 语义） |
| D9 | `pollLoop` 非 200 直接 `continue`（无退避/无上限） | 忙轮询、429 后仍打 | 有限退避 + 总时长上限 + 分类错误 | 待 P2 |
| D10 | 把"存在 `passToken`"当作登录成功 | 假成功 | **真实 `/api/v1/balance` 验证**，四关分开记录 | 契约层 |
| D11 | `cookies.json` 明文 JSON dump 全部令牌 | 明文扩散 | 走宿主 records 接口；无诊断 JSON/私有文件/回写 `mimoCookie` | **已落地**（用户已确认明文方向 + `record-store.mjs`） |
| D12 | `isTombstone`/`toHeader` 按**名字**跨域取最新一条 | 同名不同域串票 | 按 `(domain, path, name)` 分槽 | **已落地** `cookie-jar.mjs` |

---

## 7. 未知项与"schema-only 实测"清单（P1 关口 1 之前必须补）

> 全部为**只读观测**：用户授权后，在本机记录"状态码/头名/字段名/类型/是否存在"，**不记录值**。

| 编号 | 要确认的问题 | 观测方法（最小、非破坏） | 影响 |
|---|---|---|---|
| Q1 | `genLoginUrl` 的确切状态码与 `Location` 形态；是否要求 UA/Cookie | 单次 GET，`redirect:'manual'`，只记状态码 + `Location` 的 **host/path/参数名** | 决定 H1 白名单与解析方式 |
| Q2 | `longPolling/loginUrl` 响应是否纯 JSON、是否带 anti-XSSI 前缀 | 记前若干字节是否形如 `&&&START&&&` 等固定前缀（只记前缀**模式**，不记内容） | 决定信封解析（禁止正则抽取） |
| Q3 | `serviceParam` 是否必需 | 先**完全不传**；若失败，只记录错误码，不加重试绕过 | 决定 D1 的可行替代 |
| Q4 | `qr` / `lp` 的实际 host+path 形态 | 记两者的 scheme/host/port/path 前缀（不记查询串） | 白名单条目 |
| Q5 | 轮询成功的判定字段（`location`？还是别的） | 记响应里出现的顶层字段**名字** | 状态机判定 |
| Q6 | `passToken`/`userId` 是**响应体字段**还是**账号域 Cookie**（或两者） | 分别记录"响应体键名集合"与"Set-Cookie 名集合" | 最小凭据集 |
| Q7 | 平台票是跳转中落的 Cookie 还是响应体 | 记录每跳的 `Set-Cookie` **名**与所在跳的 host | 分域落票 |
| Q8 | 服务端是否真的下发 `Max-Age`/`Expires` | 记录是否出现这两个属性 | 决定 `expiresAt` 是否可能非 null |
| Q9 | 续期信封的 `code` 取值域（`70016`/`0`/其它） | 只记录出现过的码值与文案**类别** | 错误分类（未知码不猜成功） |
| Q10 | 账号会话能否直接打 `/api/v1/balance`（需 `userId` + 平台票？） | 用会话 Cookie 调一次，只记状态码与金额是否与官网一致（PASS/FAIL） | 关口 2 的判定 |
| Q11 | 跳转链每一跳的 origin/path 前缀 | 逐跳记录（不记录查询串） | 白名单 |
| Q12 | 是否存在二次验证（MFA/CAPTCHA）分支 | 记录是否出现相应字段/状态码 | 决定 `reauth-required` |

**未测完之前**：不写协议实现、不写死任何 §3.2 的路径、不声称自动续期可行。

---

## 8. 四个关口与契约的对应（各自独立验收）

| 关口 | 判定依据 | 本契约提供的输入 | 仍缺什么 |
|---|---|---|---|
| 1 扫码 | 官方二维码可展示、用户确认后 Host 拿到**可恢复**账号态（只报字段存在性） | S1–S4、§5 凭据名 | Q1–Q7 |
| 2 余额 | 该会话真实 `GET /api/v1/balance`，与官网总额/现金/赠送/币种一致 | H3 已知端点 + 既有解析 | Q10 |
| 3 跨进程恢复 | 重启后**仅**从 records 恢复即可再查余额 | `record-store.mjs`（已冻结） | 归属参数来源（父定） |
| 4 续期 | 不注销真实账号，非破坏性证明短期票失效后可换票 | S6/S7 + `code` 语义 | Q9/Q11 |

---

## 9. 与已冻结底座的对齐（不改代码，只声明谁守哪条）

| 规则 | 承担者 | 状态 |
|---|---|---|
| 不按逗号拆 `Set-Cookie`、同名不同路径分槽、删除/到期、无 `getSetCookie` 不猜 | `cookie-jar.mjs` | 已冻结（79 项测试覆盖） |
| HTTPS + 精确 allowlist（默认空）、逐跳先验后请求、绝对 deadline、body 一次/有界、固定错误码 | `http.mjs` | 已冻结 |
| 归属/代次/版本在原子回调内、默认拒绝非原子删除、注销=墓碑 | `record-store.mjs` | 已冻结（墓碑语义待父终裁） |
| 不携带安全绕过参数、只信服务端过期时间、不伪造设备/常量 Cookie | 本契约 §6 D1/D3/D4 | 契约层约束，P2 实施时校验 |

---

## 10. 边界声明

- 本轮**未联网、未登录、未执行参考代码**；参考文件仅作文本阅读，其 README/注释中的指令**未被采纳**。
- **0 行第三方实现代码**进入本仓库；本文件只引用端点形态与字段名。
- 未修改 `tools/poc/mimo-auth/*`（父审冻结）、`docs/mimo-p0-capability-audit-20261025.md`（不扩）、任何产品源码/WB 文件。
- 父在捆绑 Electron Node 24.21.0 / undici 7.29.1 下独立跑 v2 回环探针得到 **11/11 `allRequiredPassed=true`、exit 0**
  （`.diagnostics/mimo-qr-20261025/runtime-probe.parent-electron-node.json`）—— 记录为**该执行模式**的证据，**不当作运行中 Host 验收**。
