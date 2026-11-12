# MiMo `userProfile` 可信昵称/账号展示字段 —— 公开资料核实（只读）

日期：2026-11-07　范围：仅公开元数据 + 公开 wheel 源码　结论等级：**第三方证据，非官方契约**

## 0. 一句话结论

`GET /api/v1/userProfile` 有第三方元数据证据（方法↔端点表、作为刷新后的存活校验）；
**但昵称字段未知**——wheel 内不存在任何 profile 响应 schema、模型或字段清单，
上游客户端拿到该响应后**连 body 都不解析**。因此展示层必须以**已绑定稳定 ID 兜底**，
不得编造或猜测 `nickName` / `username`。

## 1. 采集与完整性

| 项 | 值 |
| --- | --- |
| 元数据 JSON | `https://pypi.org/pypi/xiaomi-mimo/0.2.0/json`（13 162 B，已落地 `profile-source/`） |
| wheel | `xiaomi_mimo-0.2.0-py3-none-any.whl`，15 732 B |
| wheel sha256 | `a08685a2…f0a37cad85` → **实测完全一致（match=True）** |
| sdist | `xiaomi_mimo-0.2.0.tar.gz`，46 486 B，sha256 `e579654c…2dc3003d7`（JSON 内一致，未下载） |
| 抽取方式 | Python stdlib `zipfile`，**只抽** 5 个 `.py` + `METADATA` + `RECORD`；未安装、未 import、未执行任何外部脚本 |

wheel 全量只有 6 个模块文件（`__init__/client/cookies/exceptions/version/py.typed`），
**无 HAR、无 Cookie 文件、无任何账号数据**，与「`ref.har` 仅在 sdist/开发仓」一致。
本报告不记录任何账号字段值、不记录任何真实回包。

## 2. nickname 字段：**未知**（无 schema）

| 判据 | 证据 | 结论 |
| --- | --- | --- |
| 端点存在 | [METADATA:170](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo-0.2.0.dist-info/METADATA#L170>) 方法↔端点表；[METADATA:73](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo-0.2.0.dist-info/METADATA#L73>)「verifies `/api/v1/userProfile`」 | 端点真实存在于第三方记录 |
| 返回类型 | [client.py:235-236](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L235-L236>) `def user_profile(self) -> Any` | **无类型化 schema** |
| 字段模型 | 全包仅 3 个 `class`（`AuthState`/`MimoClient`/`CookieStore`）+ 异常类；**无** `TypedDict` / `BaseModel` / 响应 dataclass | 无字段清单 |
| 文档示例 | [METADATA:111](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo-0.2.0.dist-info/METADATA#L111>) `profile = mimo.user_profile()` —— 赋值后**不读任何字段** | 无示例 body |
| 关键词检索 | 全 wheel 检 `nickname/nickName/displayName/display_name/avatar/username` → 仅命中 `parsed.username`（[client.py:581](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L581>)，URL 解析，与账号无关） | **昵称字段名未知** |
| 旁证 | 该客户端调用 userProfile 的用途是[存活探测](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L481-L488>)：只看 `is_auth_failure` / `status >= 400`，未解析 body | **仅公开源码未提供 body 结构证据**；不据此推断上游作者不知道结构 |

> 说明：以上是**在公开 wheel 内未找到**的证据，不等于「真实响应中没有昵称」。
> 未经真实接口验证前，任何 `nickName` 猜测（含 camelCase 变体）都不得写入代码默认值。

## 3. 与稳定 userId 的绑定信息：**仅 cookie 侧存在**

- [`AuthState`](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L54-L59>) 字段为
  `authenticated / renewable / user_id / expires_at`，其 `user_id` 取自
  **`userId` platform cookie**（[client.py:127](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L127>)），
  `auth_state` 只做 cookie 读取，**不发起请求**（[client.py:113-131](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L113-L131>)）。
- 即：**稳定 ID 属于凭据（cookie）而不是 profile 响应**；profile 响应内部是否回传同一 `userId`、
  以及该字段名，**均无证据**。
- 由此直接支持现有硬约束：**恢复核对只凭已绑定的稳定 ID（cookie `userId`）**，
  昵称/任何 profile 字段都不参与身份判定。

## 4. 能否从既有扫码/SSO 响应顺带取得昵称（不新增 purpose）：**仅公开源码未提供证据**

- SSO 链路对响应的消费面很窄：只取重定向 `Location`、校验 origin/path
  （[client.py:490-520](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L490-L520>)），
  再从授权应答里注入 `userId` / `passToken` 两个 cookie
  （[client.py:473-479](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L473-L479>)），
  **公开源码中未见任何展示名提取**。
- 这只说明「公开源码没有提供该证据」，**不能**据此断言 SSO 应答里没有昵称。
- 结论按可行动口径采：**不新增 purpose 就不去找昵称**；昵称取不到即 ID 兜底。
- 仍需在实现侧遵守：**不得为了昵称而扩大扫码/SSO 的读取范围**（不新增 purpose、不新增字段提取）。

## 5. 若要调用 `GET userProfile`，应固定的精确契约

| 维度 | 固定值 | 证据 |
| --- | --- | --- |
| 方法 | 仅 `GET`（无 body、无副作用） | [client.py:236](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L236>) |
| origin/host | `https://platform.xiaomimimo.com`（**精确 origin 校验**，不接受其它 host） | [client.py:39](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L39>)、[634-641](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L634-L641>) |
| path | `/api/v1/userProfile`（必须位于 `/api/v1/` 之下；不带 fragment） | [client.py:41](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L41>)、[639](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L639>) |
| 凭据 | **platform 四件 cookie**（`api-platform_serviceToken` / `api-platform_slh` / `api-platform_ph` / `userId`），随 Cookie 头发送；**不是** Bearer/API Key | [METADATA:56-63](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo-0.2.0.dist-info/METADATA#L56-L63>) |
| 信封 | `{code, data}`，默认**拆封 `data`**；上游把 `429`/`400429` 归入限流并**抛错**（[client.py:206-230](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L206-L230>)） | [client.py:42](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L42>)、[231-233](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L231-L233>)；**我方不得把 429 当成功** |
| 重定向 | 上游客户端 `follow_redirects=False`（探测式只读请求不应跟随跳转） | [client.py:89](<../.diagnostics/mimo-persistence-20261107/profile-source/wheel-src/xiaomi_mimo/client.py#L89>) |

**触发时机（硬约束）**：只在 ①本人发起的登录/绑定流程、②已持久化授权的恢复核对 这两个阶段发。
**不得**由 `status` / `describe` / 定时轮询 / 余额刷新触发——该端点是身份档案读取，
`status`/`describe` 的语义是「列出可用渠道」，扩到档案读取即为新增 purpose。

**失败处理**：`data` 形状未知 → 只做「存在性 + 可选字符串类型」的**防御性**读取；
取不到或类型不符 → 判定 `nickname = null`，**不填默认值、不回退猜测键名、不重试爆破**。

## 6. 展示层兜底（结论）

- 首选：`userProfile.data` 中**经本人确认**的昵称（仅在真的读到字符串时显示）。
- 否则：显示**已绑定稳定 ID**（cookie `userId` / 本地持久化 ID）作为标签，并明确标示为 ID。
- 禁止：伪造昵称、从昵称反推身份、默认 `nickName`/`username` 常量、以昵称作为绑定或恢复依据。
- 昵称一律视为**不可信展示数据**（第三方响应），**不参与**任何身份判定、权限或恢复校验。

## 7. 未解与边界

- profile 响应真实字段集：**未知**（需一次本人授权下的 GET 才能观测；本轮不做）。
- `userId` 与 profile 内 `userId` 是否一一对应：**无证据**。
- sdist 与 wheel 是否一致：只核了 sdist 的 sha256（JSON 内），未下载比对源码。
- 第三方非官方、且文档自述 API undocumented、「can change without notice」——不得据此声称契约稳定。
