# MiMo 正式 console 主线（第 1 包）· 独立终审（2026-11-06）

> 角色：Max 独立终审。范围：本交付的 console 协议主线（A1 grants / A2 transport / A3 protocol /
> console-session / display 释放接线 / host+routes / client / e2e 断言）。
> **只读代码与断言，未改源码、未跑任何测试套、未联网/QR/账号/配置/部署。**
> 判定按真实逻辑与证据，不按字节 diff 或自测计数。

## 0. 结论

**Pass（仅限「本地合成主线闭环」这一范围）。** 未发现阻断项。
本 Pass **不**等于真实可用：真实扫码 / 上游响应结构 / 真实余额 / 刷新恢复 **完全未验证**，
`enableConsoleProtocol` 默认 false（生产 fail-closed），15 min 只是**临时本地界**。

## 1. 改动边界（与已存 stage 基线比对，只读 hash）

| 文件 | 基线 → 现 | 判定 |
| --- | --- | --- |
| `session.js` / `failure.js` / `dynamic-policy.js` | SAME | 禁区**未改** ✔ |
| `vendor/cookie-jar.js` / `vendor/memory-flow.js` | SAME | 禁区**未改** ✔ |
| `secure-transport.js` | C4D046C9… → 91F8DEA8… | 仅新增 console 分支（见 §2.2） |
| `session-display.js` | A4296568… → 74E417B7… | 仅可选 disposer + 产物槽（见 §2.4） |
| `host.js` / `routes.js` | 9FCCC79B…/246F3976… → 542435E9…/ECFA547B… | console 接线/动作 |
| 新增 | `console-grants.js`(17,534B) / `console-protocol.js`(34,304B) / `console-session.js`(19,779B) | A1/A3/会话 |

基线取自已存本地 stage（非 profile）；未另做全树 hash 封存，故**不主张**其它未列文件未变。

## 2. 逐项判定

### 2.1 用途不可伪造（7 类 purpose）
`console-grants.js:340-367` `issue()` 只接受**本进程 authority** 签发；grant 是
`Object.freeze(Object.create(null))` 空对象，信息全在模块私有 `WeakMap`（`:361-366`），
`JSON.stringify`/日志拿不到 URL。URL 必须等于**来源字段的确定性派生**（`:298-307`），
且 `:310-338` 对 `platformCallback=/sts`、`balance=/api/v1/balance`（search 必须为空）、
`context=/api/v1/genLoginUrl?currentPath=/console/plan-manage` 做目的域强约束。
`validate()` 复核 epoch/boot/generation/deadline/method/credentialClass/URL/cookie 策略（`:369-399`）。
⇒ **来源可信不等于可越权**：account 侧 location 不能当 platform callback 用。

### 2.2 transport 仅精确扩展
`secure-transport.js:228-236` 只列 7 个 console purpose；`:741-745` 仅当 purpose ∈ 该集合才走
`fetchConsole`，否则 legacy `longPoll` 路径（`:746-760`）逐字未变（仍 `validateTarget` 只认
`account.xiaomi.com`）。`fetchConsole:710-734` 要求构造期注入 `validateConsoleGrant`（缺 ⇒ 直接拒），
DNS 前先验 grant，header 白名单 `sanitizeHeaders`（`:374-394` 只允许 `accept`/`cookie`，
禁 `authorization/host/content-length/...`），仍走 pinned `lookup` + `rejectUnauthorized`。

### 2.3 单次预算 / 门禁 / 取消与迟到
`console-protocol.js:326-377` `call()`：`assertOp` + `MAX_CALLS`(20) + 同一 `requestDeadline`
贯通「签发-发送-assertAuthorized」；`:370-373` 校验 `redirected===false`/`res.url===url`/TLS authorized/servername。
`bodyJson:380-392` 在 await 前后、parse 后各验 op。`runOperation:251-296` 用**单一 op**覆盖整个
operation（含 onQr/approval/DNS/body），`finish()` 先摘监听再 abort（`:264-268`），
失败即 `authority.invalidate()` + 可选清凭据。

### 2.4 单一 owner 与 stop/expire/late 清理
- `console-session.js:397-418` `claim()`：同步一次移交，handle 为 opaque 空对象，protocol 只进私有
  WeakMap，pre-auth 记录 `r.protocol=null` 并 `disarm`（`:409-416`）⇒ **不留第二份强引用/timer**。
- `session-display.js:681-714` producer 产物槽：未被接手的产物**显式释放**；`haltFor`/`dispose`
  一并释放 `credential` 与 pending 槽（`:409-431`、`:870-886`）⇒ 迟到结果不复活且不泄漏。
- `disposeCredential`（`console-session.js:439-456`）：删 handle + 置 `disposed` + **按 sameAuthId/gen**
  把非密 record 置 `stopped`/`identity:null`，迟到释放不会覆盖后来建立的新记录 —— 这修掉了
  「释放后 record 恒 claimed ⇒ 无法再次登录」的死锁。

### 2.5 双登录 / 重新登录
`host.js:205-214` `consoleBusy()`：legacy 非终态 或 display 处于 `holding|verified` ⇒ `consoleStart`
**0 请求**拒绝（`routes.js:216-219`）。`consoleStart` 自身也由 `console-session.start():224-227`
对 live/claimed 返回 BUSY。停止后 record 变 `stopped` ⇒ 允许新代登录（e2e:412 覆盖）。

### 2.6 code-only 默认关闭
`host.js:91-101`：`consoleEnabled = dependencies.enableConsoleProtocol === true`；
插件的 `registerMimoAuth`（`:43-63`）**不传** dependencies ⇒ 生产恒 off。
`routes.js:200-206`：未启用时 `consoleStatus` 仍给**可信 absent**、`consoleStop` 幂等 200、其余 503。
无 UI/JSON 开关（`client.js` 只读 `consoleSupported` 渲染文案）。

### 2.7 观察 0 upstream
`routes.js:129-177` consoleSnapshot 为**逐字段白名单**重建（无 rawURL/query/expected/actual/token）；
`console-session.status():328-332` 只做惰性到期；`host.js:440-455` capability 也只带快照。
e2e:255/351/474 断「观察期/默认关闭期 0 vendor 请求」。

### 2.8 expected 不由 actual 反造
`console-protocol.js:160-165` 事前预期被复制冻结（`namespace` 固定 `xiaomi-account-user-id`）；
`:423`、`:449`、`:612-613` 三处都是 **actual 与 expected 比较**，事前输入的 expected 不用于构造厂商上游 URL/header/请求体，不拿它补造 actual。
这里不包括本机 owner-only `consoleStart` 必要的 JSON 请求体：预期账号由该本地请求交给 Host 内存；真正认证后发往上游的账号 Cookie 来自 actual，而非事前输入。claim 时 `console-session` 把**用户输入的 expected** 交给 display，
display 再与 verifier 输出的 actual 比较。

### 2.9 UI 无密 / 陈旧状态
`client.js`：预期账号用**非受控** `type=password` + ref（`:6530-6540`），点击即 `el.value=''` 再发送
（`:6394-6401`）；`start→begin` 同一次点击内完成（`:6393-6426`），不因打开面板/capability 自动 begin；
二维码走 `createObjectURL` 并在换号/终态/unmount 撤销（`:5758-5790`、`:6380-6391`）；
console 请求体按动作**逐字段白名单**（`:5620-5663`）。e2e:441-443 断响应中无 passToken/原始账号/来源 URL。

### 2.10 401 语义与断言强度
`console-protocol.js:640-670` 401/403 → 吸收 Set-Cookie → 仍有效才走 `runSso` → **一次**重试；
`:684` 单飞；`:372` 本地码不外泄（`settleCode` 把内部 `POLL_WAIT` 映射为 EXPIRED）。
e2e 用**精确等值**而非 `≤N`：起手 5 跳逐路径各 1（`:285-292`）、read `+1`（`:329`）、
confirm 0（`:342`）、401 路径精确 5 跳且 balance 恰 2（`:359-365`）、变号后 balance 恰 1 且停（`:382-385`）。
⇒ 不存在「零请求空过也算绿」。

## 3. 非阻断观察（不需要为它们回炉）

1. `console-protocol.js:130-136` `mask()` 保留**前 2 + 后 2** 字符，与 display 侧 `u***`+尾部 4 不一致；
   仅展示、非依据，建议下次统一为「只留尾部」以最小化展示面。
2. `console-grants.js:128` 的 `(labels.join('.') + '.' + PARENT_DOMAIN) !== PARENT_DOMAIN` 恒真，属死条件，可删。
3. `console-session.dispose()` 在 `claimed` 时刻意不碰 protocol（由 display 拥有）；若 `display.dispose()`
   抛错则可能留一个 protocol 引用。概率低（host 已先 display 后 console），可加兜底清扫。
4. `runOperation` 的到期 timer 未 `unref()`（transport 内的都 unref 了）；仅影响测试/CLI 退出延迟。
5. `consoleBusy()` 只挡 `consoleStart`；`attachSlot` 是单槽可变，但 claim 与 attach 在同一同步段完成，
   未发现可交错窗口（已核 `bounded` 内 factory 同步调用）。
6. 展示口径：`mask()`/文案里的「15 分钟」「14 次」为**临时本地界**，不得对外表述为厂商有效期。

## 4. 明确未验证（不得据此声称）

- 真实 `genLoginUrl` 的 Location 是否含 `sid`/`callback`（`deriveConsoleQrInitUrl` 依赖它们，缺失即
  fail-closed 为 TARGET_INVALID）；`qs` 具体构造、`/sts` 的 Set-Cookie 确切名、cookie 作用域/TTL/
  audience 全部来自第三方线索，仅在 fake wire 上验证。
- 真实 401 后的 SSO 换票是否被上游接受；真实余额四字段口径。
- 刷新恢复、GUI、多设备、上游撤销（本地清除 ≠ 上游注销）。
- `usage_status` / 普通 provider 缓存仍走原 lane，未与本会话统一。

## 5. 与真实可用的距离（复述，不改口径）

`enableConsoleProtocol` 默认 false ⇒ 生产 fail-closed；本轮为**本地合成主线闭环**。
下一阶段的真实试用必须另获许可，并按既有操作单逐 hop 授权，不得把本 Pass 当真实成功。

---

## 6. 追补：真实试用报错的最小修正差异复核（2026-11-06 晚）

> 现象：已安装初版（14 文件 closure、真实 gate 已开）本人手机扫码确认后 UI 报
> `E_MIMO_CONSOLE_AUTH_REQUIRED`。**未读取/保存任何上游响应** ⇒ 根因**未证**，下列判断只是
> 「与已知证据一致的最小兼容修正」的代码级复核，不是根因结论。

**差异范围（申报 3 文件，已逐一读代码）**
- `console-protocol.js`：① 根级 `userId` 若为 number，要求**词法纯正整数**（`/^[1-9][0-9]*$/`）且
  `Number.isSafeInteger`，否则 `AUTH_RESULT_ID_INVALID`（`:97-104`）；② 新增
  `normalizeAuthenticatedAccountId`（`:143-147`）：只接受「合法 string」或「正安全整数 → 十进制字符串」，
  其余（null/bool/0/负/小数/超安全整数/对象/数组）一律 null；③ seed 与 header 冲突比较改用**规范化后的种子**
  （`:589-606`），且临时 jar 的读取改在**真实 LP URL** `qrJson.lp` 上（`:601`，可捕获 regional host-only cookie）；
  ④ 新增 4 个固定码（`AUTH_RESULT_SEED_MISSING` / `AUTH_RESULT_ID_INVALID` / `ACCOUNT_CREDENTIAL_MISSING` /
  `PLATFORM_CREDENTIAL_MISSING`，`:34-37`）用于区分「缺种子/ID 非法/账号态/平台态」；⑤ 补 `bodyJson(qrRes, op)`（`:530`）。
- `client.js`：仅把 4 个固定码加入 `MIMO_CONSOLE_CODES` 白名单（`:5464-5467`），**无新 DTO 字段**。
- `host.js`：只把「账户/平台缺凭据」两码并入既有 `AUTH_REJECTED` 类别（`:24-27`），其它映射未变。

**安全归一化**：仅 `userId` 允许 number，且**不走 `Number()` 后的值**做身份——词法先被约束（禁 `+`/`-`/前导 0/
小数/指数），再要求安全整数；因此 `777.000000000000000001`、`7.77e2`、`9007199254740992`、`9007199254740993`
全部拒（用例 `test-mimo-console-protocol.mjs:291-309`）。**不存在「按浮点舍入后的值当账号」的路径**。
`passToken` / `cUserId` **未**做任意 `String()`：前者仍必须 string，后者存在时仍必须 string（否则固定 `FLOW`）。

**身份仍绑定**：`accountId`（规范化后的字符串）与 `platformId` / 独立 `expected.identifier` 仍是三方严格相等
（`:611`、`:631-632`、`:467`），且 `expected` 仍只在本地比较、绝不进入任何请求。

**固定码不泄密**：4 个码为常量，`fail()` 只带 `code`（无 detail），路由 `CONSOLE_CODE_RE` 只放行
`^[A-Z][A-Z0-9_]{0,63}$`，客户端白名单再折一层 ⇒ 无字段名/值/URL/上游正文外泄。

**无新请求目标**：未新增 URL、未改 7 类 purpose、未改 grants/transport 目标或 hop 上限；
唯一 URL 相关变化是把「读临时 jar 的 cookie」从 `https://account.xiaomi.com/` 改为**实际 LP URL**（不是新请求）。

**判定：Pass（仅此差异，diff 范围）**。两条**非阻断**风险留给后续（不必现在改）：
1. 若真实 LP JSON 携带**数字型 `cUserId`**，本补丁仍会以固定 `FLOW` 终止（可选字段却致整链失败）；
   建议同一词法规则归一化，或把「存在但类型异常」的可选字段降级为忽略。
2. `decodeJson` 的根级 `userId` 词法检查对所有 JSON 生效（qrInit/SSO/balance 同用该解析器），
   若别的响应根上出现数字 `userId` 会报成 `AUTH_RESULT_ID_INVALID`（码义偏移，不影响安全）。
