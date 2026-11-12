# Codex 统一 Host 来源适配：**精确程序契约论证**（只读，2026-11-11）

**本文只做契约论证，不含实施**：没有创建 owner peer、没有调用任何 localhost/owner API、没有网络、
没有读 cfg/credential/record/browser/env/log/进程命令行、没有运行第三方 `apply`。
证据来源全部是**已在工作区提取的 SDK 副本**与**已装第三方包源码的只读阅读**。

- SDK 副本：`.diagnostics/codex-source-sdk-20261110/conn/dsh-client-connection_lib_index.js`（下文 `CONN`）
- 已装第三方：`C:\Users\Slacom\.dsh\profiles\desktop\node_modules\dsh-codex-subscription\lib\index.js` v3.2.6（下文 `SUB`）

---

## 1. 结论先行（三句话）

1. `createPeer()` 与 `createSharedFetchHandler()` 是**公开导出类上的公开方法**，注释明写"由读到该 service 的
   Context 拥有的**进程内** Peer"与"组合一个共享 channel 的 Fetch handler"，并且 handler 的
   `fetch(request, peer)` **只**检查 `peer.principal.kind === 'owner'`，**不经过** `admit()/isTrusted()`
   （Host/Origin 围栏 + 浏览器认证）。⇒ 用公开 API **可以**在正常 runtime 里构造出"进程内 owner 调用"。
2. 但 `principal` 由**调用方自己填**，SDK 不做任何校验或分级；"插件给自己签一个 owner"这件事**没有专门的
   授权契约**，它等价于领取"DSH 自己那条浏览器会话"的全部权威，且**不限于**我们要的那一个 endpoint。
   ⇒ 这是**可用但未被显式设计**的能力，是否允许必须由用户明确拍板（见 §6）。
3. 若用户不愿授权 owner 自我授予：第三方插件加一个**只读 service**（`ctx.provide`，cordis 公开 API）
   是最小、最干净的路（§4/B）；若两者都不批，则**如实停在"subscription 来源不可用"**（§5/C），
   不把 GUI 能做当成本插件已完成。

---

## 2. 公开契约证据（逐条可核）

### 2.1 `createPeer`：明确写成"进程内 Peer"

`CONN:751-754`

```js
/** Create one in-process Peer owned by the Context that read this service. */
createPeer(options) { return new Peer(this.ctx, options) }
```

`CONN:647-652`（Peer 的类型注释）

> "The Peer: one party admitted to this Host. **Its creator fixes the principal it speaks for and owns
> its lifetime**; Gateway hands it to each Remote call as `invocation.peer`."

`CONN:669-679`（构造器）

```js
constructor(owner, options) {
  this.principal = options.principal;          // ← 调用方**自选** principal，无校验
  this.interactions = options.interactions ?? "answer";
  this.scope = createScope(owner, this);        // ← scope 挂在 connection service 的 ctx 下
  this.ctx = this.scope.ctx;
  ... dispose() { return this.scope.dispose() }
}
```

读法：**"creator fixes the principal"** 是设计语言（Peer 不认识浏览器，也不认 HTTP），
但"creator 可以是任意第三方插件、且可以填 `owner`"**没有任何注释背书**。
`CONN:1072` 的 export 列表里 `Peer` / `HostConnectionService` 都是**公开导出**，不是内部私有符号。

### 2.2 `createSharedFetchHandler('/api')`：exact route 只看 peer.principal

`CONN:815-839`

```js
/** Compose one shared-channel Fetch handler from exact routes and its interceptor.
 *  @param channel - shared channel mounted by Connection.
 *  @returns Fetch handler that selects one owner or returns 404. */
createSharedFetchHandler(channel) {
  return {
    fetch: (request, peer) => {
      const pathname = new URL(request.url).pathname;
      const route = this.fetchRoutes.get(pathname);
      if (route?.methods.has(request.method) === true) {
        if (peer.principal.kind !== "owner") return Promise.resolve(new Response("forbidden", { status: 403 }));
        return route.fetch(request);                       // ← 无 admit / 无 isTrusted / 无 browserAuth
      }
      const endpoint = endpointFromPath(channel, pathname);
      const interceptor = this.interceptors.get(channel);
      if (endpoint === void 0 || ...) return Promise.resolve(new Response("not found", { status: 404 }));
      return interceptor.fetchHandler.fetch(request, peer);
    }
  };
}
```

对照 HTTP 入口——**只有**它才走围栏与浏览器认证：`CONN:742-750`（`admit()` = `isTrusted` 403 /
`browserAuth.isAuthenticated|authenticateApi` 401）与 `CONN:1044-1058`（SDK 自己的 `/api` 挂载：
`createSharedFetchHandler(API_PATH)` → `connection.admit(req)` → `bridge(..., admission.peer)`）。

⇒ 同一个 handler 对象**被设计成可复用**（否则不会自带 `fetch(request, peer)` 与那句 403 判断），
SDK 自己的唯一调用点是 HTTP bridge，但 handler 本身**与 HTTP 无关**。

### 2.3 目标插件的 usage 是 exact route（且已用 `ctx.inject(['connection'])` 注册）

`SUB:3447-3496` `registerSubscriptionTransport(connection, handler)`：为 `RPC_ENDPOINTS` 每一项注册
`connection.fetch.register({ path: '/api/codex-subscription/<endpoint>', methods: ['POST'],
requestBody: 'buffered', fetch(request){ … } })`，其中：

- content-type 必须 `application/json`（415）、body 必须能 `clientRequestSchema` 解析（400）、
  `envelope.data.method` 必须等于该 endpoint（400）；
- 然后 `result = await handler(endpoint, envelope.data.payload, request.signal)`；
- 返回 `Response.json({ type:'server-response', rpcId, result })`。

`SUB:18039` —— 它**自己**就是这么拿到 service 的：

```js
ctx.inject(["connection"], (connectionContext) =>
  connectionContext.effect(() => registerSubscriptionTransport(connectionContext.connection, handler),
    "codex-subscription: DSH-trusted account RPC"));
```

`SUB:3376-…` `RPC_ENDPOINTS` 含 `"usage"`；`SUB:15962-15980` `endpoint === "usage"` 分支：

```js
return { ok: true, value: await usageReader.read({ force: payload?.force === true, signal }) };
```

失败时只回**固定文案集合**（"… not signed in" / "needs to be renewed" / blocked / "Could not read ChatGPT usage"），
不透上游正文。`SUB:14076-14119`：`createCodexUsageReader()` 的 `read()` 有 TTL 缓存、`force` 才强制上游、
凭据来自插件自己的 `getAuth/readCredential`（**我们绝不复制这条凭据链**）。

⇒ 结论（可核）：`POST /api/codex-subscription/usage` 的 body 形如
`{type:'client-request', rpcId, method:'codex-subscription/usage', payload:{}}`，
响应 `{type:'server-response', rpcId, result:{ok:true, value:{…usage…, fetchedAt}}}`。
它在"进程内 owner peer"下**无需任何 cookie/token**即可被驱动。

### 2.4 服务注册/发现的公开面

- `CONN:692`（`HostConnectionService extends Service`）+ `CONN:1034`（连接插件 apply 里**构造一次**并作为
  `connection` service 提供）⇒ 进程内**单一实例**，`fetchRoutes` 是同一张表：我们从 `connection` 读到的是
  **同一个** registry，能看到目标插件注册的 exact route。
- cordis：`ctx.provide(name, value, check)` 是公开 API（`cordis_lib_index.js:1374-1415`，fiber 拥有 + 返回 disposer
  + 通知 dependents）；`fiber.state === 2` = **ACTIVE 活跃**（`cordis:399`、`cordis:1403` 两处自证）。
  ⇒ "插件是否可用/是否启用"可以用「loader 条目的 `disabled` + `fiber.state`」这类**公有字段**判断，
  不需要 `_initTask` / `inertia` / `options.config` 之类私有面。
- 目标插件 `inject` 列表（`SUB:17144`）= `llm, credentials, settings, web, loader, tools, attachments`
  —— 它没有对外 `provide` 任何 usage 相关 service（见 §4/B：这正是需要新增的那一层）。

---

## 3. 已被证伪/需要纠正的口径

- ❌ "Host 侧没有公开的进程内 dispatch" → **不成立**：`createPeer` + `createSharedFetchHandler` 就是。
- ❌ "GUI 能拿到 usage ⇒ 插件就已完成" → **不成立**：GUI 走的是浏览器侧 `/api` + 浏览器认证；
  我们的 Host 侧适配必须以**统一 source adapter**（GUI/`usage_status`/策略共用同一函数）交付。
- ⚠️ "用了公开 API ⇒ 就合法" → **不成立**：能否**给自己签 owner** 是**策略授权**问题，不是 API 可见性问题（§6）。

---

## 4. 方案

### A. 公开 in-process Peer 桥（**不改第三方**）

**形态**：Host 半 `ctx.inject(['connection'], …)` 拿到 service；每次读取：

```js
const peer = connection.createPeer({ principal: { kind: 'owner' } })      // 唯一授权点
try {
  const handler = connection.createSharedFetchHandler('/api')
  const req = new Request('http://127.0.0.1/api/codex-subscription/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: <uuid>, method: 'codex-subscription/usage', payload: {} }),
    signal: <自身 AbortSignal，例如 8 s>,
  })
  const res = await handler.fetch(req, peer)      // 无 socket、无 cookie、无 Host/Origin 围栏
  if (!res.ok) throw …
  const msg = await res.json()                    // {type:'server-response', rpcId, result}
  // 只投影 result.ok / result.error.code / 白名单字段
} finally { await peer.dispose() }
```

- **需要用户明确授权的点**：`principal: { kind:'owner' }` 的**自我授予**。SDK 不校验、不分级；
  它等价于"以 DSH 应用身份"发一条 `/api` 请求，**且在能力上覆盖所有 exact route 与 `/api` interceptor**
  （不只是 usage）。我们只能靠**自身代码纪律**收敛到单一路径（固定 method/body、不接收浏览器投递的
  任何内容、不列 route 表、不枚举其它 endpoint）。
- **生命周期**：`createPeer` 的 scope 挂在 **connection service** 的 ctx（`CONN:672`），
  **不会**随我们的 fiber 结束自动释放 ⇒ 必须 `try/finally` 显式 `peer.dispose()`；建议**每次读取一个 peer**，
  不做进程级长生命周期 peer。
- **固定面**：只 `POST /api/codex-subscription/usage`、`payload: {}`（**不带 `force`**，尊重它自己的 TTL 缓存）、
  不接受任何来自浏览器/模型的 URI/headers/body 拼接；`rpcId` 本地生成；自带 `timeout + abort`。
- **未装/未开**：目标插件不 active 时不注册 exact route ⇒ handler 返回 404（`CONN:835`）⇒
  统一显示"未启用"，**0 请求、0 副作用**。
- **局限（必须写进验收）**：① 语义上是"领取 owner 权威"，非 SDK 明示授权的用法；
  ② 无 per-endpoint ACL，收敛靠自律；③ 版本耦合到 `codex-subscription/usage` 这个固定字符串与
  `clientRequestSchema` 4 字段；④ 绕过 HTTP 层审计/限流；⑤ 若同进程出现第二个恶意插件，
  同样能力它也能拿到（这本来就不是我们能封的）。
- **可测性**：可在**不接触真实账号**的前提下用 fake `connection`（`createPeer`/`createSharedFetchHandler`/
  `fetch` 三个桩）+ 假 exact route 做契约回归；**不能**据此声称平台安全性。

### B. 第三方加一个**只读 service**（最小改文件 API）

**形态**（`SUB` 侧约 5–8 行，`apply` 内、已有 handler 闭合处）：

```js
ctx.provide('codexSubscriptionUsage', Object.freeze({
  // 只读：不暴露 account/credential/偏好写操作，不透上游原文
  readUsage: ({ force = false, signal } = {}) => handler('usage', { force }, signal),
}), () => true)
```

我们这边：`ctx.inject(['codexSubscriptionUsage'], (c) => …)` 直接调 `readUsage({ signal })`。

- **优点**：不需要 owner principal（不越权）；认证/凭据仍由**它自己的 reader** 管理（我们不碰 token、
  不建自己的 credential store、不镜像 vault record）；失败分类沿用它的固定文案；版本演进只需它 bump service。
- **代价**：需要**改第三方包**（用户/作者同意）、需要它先发布（或用户接受本地补丁）、
  需要与其维护者对齐 service 名与语义（`cordis:1374` 的 `provide` 是正规机制，不是黑科技）。
- **最小化**：服务只读、无状态、无参数写路径；`check` 恒真；名称带前缀避免撞名。

### C. 无法证明就停（**不是**"GUI 够用"）

如果用户既不批 owner 自我授予、也不批改第三方：
本插件 Codex 只保留 **connect 来源**；`subscription` 来源**不实现**，UI 如实显示"未启用（缺少受支持的只读接口）"，
`usage_status`/策略同样标注 `missing`/`unavailable`，并发起 **0 请求**。
这不是"已完成"，是**如实未覆盖**；后续要么用户松口 A/B，要么等上游提供 OAuth 化的公开只读接口。

---

## 5. 统一 source adapter 的形状（A/B 共用，避免"只改 GUI"）

```
source = { id:'codex', kind:'connect'|'subscription', available:boolean, read({signal}) -> {ok, value|error} }
```

- 一个 `readCodexPlan()` 同时喂：胶囊/详情（client 侧 DTO）、`usage_status` 投影、额度策略。
- 选择语义（用户已批准）：**默认 `connect`**（保持旧行为）；`subscription` 需**用户显式手选**；
  自动发现"未安装/未启用"一律 `available:false`（显示"未启用"，不 fallback）；
  **手选 subscription 时绝不再回退 connect**（避免静默换来源）。
- 来源身份进 `gen`/指纹：切换来源 ⇒ 旧值作废（与既有 custom/keys 代次同一套纪律）。

---

## 6. 需要用户/主明确确认的点（我不擅自定）

1. **是否授权"进程内 owner principal 自我授予"**（A 的唯一实质授权点）。若只批"只读"而不批 owner 语义，
   请明确否掉 A，改走 B。
2. 若走 B：**是否授权修改 `dsh-codex-subscription`**（本地补丁 / 等上游发版），以及 service 名与语义
   （建议 `codexSubscriptionUsage.readUsage({force?,signal})`）。
3. **A 的收敛纪律是否作为验收硬条件**：固定单 endpoint + `payload:{}` + 无 `force` + 自带 abort/timeout +
   每次调用 `dispose` + 不读任何浏览器投递内容。
4. A 的**审计需求**：是否需要在 `RECEIPT`/日志里留"谁在何时触发了一次 owner 桥调用"（只记固定码，不记值）。
5. 若两者都不批 ⇒ 接受 C：Codex 只有 connect 来源，`subscription` 显示"未启用"，明确记为**未覆盖项**。

---

## 7. 本次未做 / 不可据此声称的事

- 没有运行 `apply`、没有创建 `Peer`、没有调用任何 `/api/*`、没有 localhost 请求、没有网络。
- 没有读真实 cfg / credential / record / browser / env / log / 进程命令行；没有提取或重扫 ASAR。
- 未验证"我们的插件在真实 runtime 里 `ctx.inject(['connection'])` 一定拿得到同一实例"——这是**读源码得出的
  强推断**（同一 service 名 + 单次构造），仍需一次受控验收（不由本包执行）。
- 未验证 `cordis` 服务隔离配置是否会改变可见性；未验证 Loader 条目字段在全部分发形态下一致。
