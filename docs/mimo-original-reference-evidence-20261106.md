# MiMo 原始参考证据记录（2026-11-06）

> **性质**：只记录主代理本轮**实际读到的第三方公开材料**与**主的技术决策**。
> 未复制第三方代码全文（仅行号＋短事实）；未下载执行任何包；未新增网络 fetch、未装 SDK、未用账号/cfg/GUI/QR；**未跑任何测试**。
> **这些材料均非厂商官方协议**，也**不构成"扫码/账号成功"或"余额可用"的证据**。

## 1. XiaomiTokenMonitor（第三方，已锁 commit）

- 锁定：`6f0edbba81c6ebc1050de4b3f6a620f5571b8128`（`https://github.com/keiraee/XiaomiTokenMonitor/commit/6f0edbb.patch` 的 `From` 首行可证）。
- 元数据：`package.json` `version 2.0.0`、`license` 声明 **ISC**；**独立 LICENSE 文件获取失败** ⇒ **不**做"已确认复制许可"结论。
- 口径提醒：提交标题/README 里的 `v1.0.0` 镜像版本 **不等于** `package.json` 版本，**不得**写成同一版本。
- 实际读过的文件（全文）：`src/qr-login.js`(176 行)、`src/sso.js`(133)、`src/auth.js`(190)、`src/cookie-jar.js`(237)。
- **机制事实（可作为协议线索）**：
  - `qr-login` **L51–58** `init` 返回 `lp`/`qr`；**L100–117** `poll` → `applyPollResult(data)` → 再 `followRedirectChain(data.location)`。
  - **L119–128** 必要时 `refresh`；**需存在 `passToken` 才 success**，然后 `save`。
  - `sso` **L49–67** 显式从 `data.passToken` / `userId` / `cUserId` 读取，并**人为 30 天**有效期（非厂商语义）。
  - `sso` **L97–118** `GET` fresh signed context → `serviceLoginURL` + `_json true` → `code 0` / `location` 跟进，**70016 拒**。
  - `auth` **L55–60** singleflight；**L83–108** ensure / refresh。
- **明确不可移植/不可照搬**：
  - `cookie-jar` **L182–194 全域 `toHeader`**（本项目不采用全域 Cookie 注入）；
  - 缺 `exp` 时**编 7 天**（**L64–66**）；
  - `normalize` 默认 `platform`（**L74**）；
  - `save` **L113–117** 普通 JSON 落盘（与"不落盘/内存持有"冲突）；
  - `qr` **L47** `serviceParam` 带 `checkSafePhone`/`address=false`（不可移植）；取消仅 `deleteMap`、**不真 abort**（不可移植）；
  - `auth.testRefresh` 返回 **token 前缀**（不可移植）。
- 用途差异：其 `tokenPlan`/`usage` 是**套餐/用量**，**不是钱包余额**；本项目币种/钱包语义以既有 `balance` 定义为准，**不混用**。

## 2. PyPI `xiaomi-mimo`（仅元数据，未下载未执行）

- `https://pypi.org/pypi/xiaomi-mimo/json` **HTTP 200**；`version 0.2.0`；元数据声明 **MIT**。
- sdist SHA256：`e579654c4f6503489e285dbb6addeac9eb0c879f2f93aecf60826562dc3003d7`（**仅锁发布元数据，未下载/未执行 ⇒ 不称"已读其源码"**）。
- **发布说明**（非实测）列出：platform 侧四个 cookie（`serviceToken`/`slh`/`ph`/`userId`）属**短期非 refresh 票**；
  账号 `userId` + `passToken` 种子 → `genLoginUrl` → `serviceLogin_json` → 可能 `clientSign` → `platform`/`sts` → `userProfile` → 原请求**至多 1 次重试**；
  并列出 `balance()` = `GET /balance`，`base`/`api/v1`。
- 端点信息的证据级别：由原先"仅 snippet"提升到**版本化发布说明**，**仍不是官方协议**，**也不是可用性证据**。
- 账号侧：`passToken` 仍可被撤销、MFA 需本人重登；POSIX 0600 **不等于加密**；手抄 seed **不是本项目产品目标**。
- **`schema` / `clientSign` 算法仍未读 ⇒ 不编造**。

## 3. `dsh-mimo-connect`（branch 取文，**commit 未锁定**）

- 读过：`main` 分支 `package.json`（`0.3.5`、MIT 声明；独立 LICENSE 页失败）、`src/index.js`（319 行）、`src/session.js`（307 行）。
- `session.js` **L25 `import` cookie-jar**，但该**实际文件 fetch 失败** ⇒ **不称"已审过其 cookie-jar"**。
- `session.js` **L28** 目标 `mimo-server-cn.xiaomimimo.com`，`GET /api/user/xiaomi/me` → `account`/`pass`/`serviceLogin` → `/api/sts` —— 与 `platform` / `api-platform` **不是同一域体系**，**不得混同**。
- 可参考（机制，不抄代码）：每响应 `absorb`、按域 Cookie、mint singleflight、整体 deadline。
- **禁止**：读取其实际 `.mimo-connect-auth/`、桌面 db、混票；**不得**采用其 HTTP 宽 `scheme`（**L67**）。
- commit API / patch 读取失败 ⇒ **未锁 commit**，只按 branch 取文，不捏造 commit id。

## 4. `dsh-token-stats`（已锁 commit，但**非全文**）

- 锁定：`5615ece0b53347f0ebe7d59d797635670e5d40b5`（`/commit/main.patch`）。
- `main/index` 仅取到**前部 324 行**即被工具截断 ⇒ **不能**声称完整审过 `SetCookie` 实现。
- README 口径：`SetCookie` 续发可吸收，但**过期回退本地统计、非 SSO**；**非钱包**；**不得**照抄其自动回退 / 从环境取 Cookie。
- root `main` README 可能是**缓存旧 1.4**，不能当当前版本；主在 patch 中看到 **1.10.0** ⇒ **不对无全文内容作实现断言**。
- source URL：`https://raw.githubusercontent.com/MoonlitDropOfBlood/dsh-token-stats/main/index.js`（仅前 324 行）。

## 5. 主的技术决定（下一正式包方向，**尚未实现/未启用**）

- 正式链分**账号态**与**平台态**，**两态均只在内存**（不重开磁盘持久化）。
- 链路：signed context → SSO 平台票 → **绑定"事前预期 xiaomi 账户"与实际身份** → **本人确认 readBalance** → **另授权** display 受控 refresh。
- 换票：singleflight；**跨代 cancel**；鉴权失败**最多一轮换票 + 余额一次重试**；`status` **零网络**。
- 未知 / MFA / captcha / 撤销 ⇒ **fail-closed 重新扫码**。
- 旧 **动态 LP 只读**：不读 `purpose` 之外语义、不放宽 `bodyguard`；**新增"认证结果"用途必须独立显式授权**，**不能**由 LP 批准继承。
- 复用既有 Jar / owner-only 路由 / transport；**不造新 network-security 框架**、**不抄第三方代码**。
- `secure-transport` 当前**只允许 longPoll 且 `never other purpose`**；正式链要增 `authReceipt`/`accountSSO`/`platformCallback`/`balance` 等精确用途，**需用户解除该文件本轮只读**（**一次确认，本文件不得先改**）。
- `dynamic-policy` 继续只读；若真需改须另说明。
- **当前不实现、不启用真实 producer**。

## 6. 仍未证 / 明确 TBD（不得声称已完成）

- `clientSign` / `schema` 未读；真实 `receipt carrier`、`namespace`、`audience`、`endpoint` 全链路证据仍缺。
- 具体 `path` 与来源校验只能按本轮**可证线索**推进；未知字段一律 `TBD`。
- 完整客户端与 DTO **不得透票**；`scope`/`permission` 未授予 ⇒ **不能** claim 构建已完成或可用。

## 7. 链接

- `https://github.com/keiraee/XiaomiTokenMonitor/commit/6f0edbb.patch`
- `https://pypi.org/pypi/xiaomi-mimo/json`
- `https://raw.githubusercontent.com/MoonlitDropOfBlood/dsh-token-stats/main/index.js`
- `https://github.com/MoonlitDropOfBlood/dsh-token-stats/commit/5615ece0b53347f0ebe7d59d797635670e5d40b5`
