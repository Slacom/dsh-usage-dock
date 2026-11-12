# SSO 目标形状固定分类（2026-11-09）

实机：raw 交接版安装后重启，reason 变为 `E_MIMO_CONSOLE_SSO_TARGET_UNSUPPORTED / restore`；仍未知是 http 同平台、
其它 path/host 或 authority 问题。**本包只细分错误，不改变 allow-set、不放行任何原拒绝目标、不据猜测升级/放行。**

## 改动（仅 `console-protocol.js`）

新增固定闭集 9 码（值前缀 `E_MIMO_CONSOLE_`，fallback 仍 `SSO_TARGET_UNSUPPORTED`）：

| 码 | 触发形状 |
|---|---|
| `SSO_TARGET_HTTP_PLATFORM_STS` | 精确 platform + http + `/sts`（仍拒，绝不发 http/不升 scheme） |
| `SSO_TARGET_HTTP_PLATFORM_OTHER` | 精确 platform + http + 其它 path |
| `SSO_TARGET_HTTPS_PLATFORM_API_STS` | 精确 platform + https + `/api/sts` |
| `SSO_TARGET_HTTPS_PLATFORM_STS_SLASH` | 精确 platform + https + `/sts/` |
| `SSO_TARGET_HTTPS_PLATFORM_OTHER` | 精确 platform + https + 其它 path |
| `SSO_TARGET_ACCOUNT_OTHER` | 精确 account 的其它（含 http、login/notification 以外的 path） |
| `SSO_TARGET_OTHER_HOST` | 其它 host |
| `SSO_TARGET_UNSAFE_AUTHORITY` | userinfo / hash / 非默认端口 |
| `SSO_TARGET_OTHER_SCHEME` | http/https 之外的 scheme |

- 私有纯分类器 `targetKindOf(url)` 只处理**已收到**的目标 URL，返回固定码或 `null`（原本可放行的 clean
  https 精确 platform `/sts`）。优先级：unsafe/scheme → account login(`/pass/serviceLogin`)=`AUTH_REJECTED`、
  notification(`/pass/notification[/…]`)=`SSO_CHALLENGE` → 其余形状码。
- raw 3xx 与 200 JSON 的 location 都走同一分类器；**authority/transport 校验全部保留**、可更早拒绝但绝不接受原先拒绝的目标。
- 无新 header/请求/DTO/日志/写盘；错误只含静态码，不含 URL/host/path/query/userinfo/nonce。

## 验证

- 新套 `tools/test-mimo-console-target-shapes.mjs`：**5 passed / 0 failed，exit 0**（13 种 raw 形状逐项固定码 +
  0 回调/0 余额；200 JSON 代表例；account 优先级未被覆盖；有效 https `/sts` 仍 3 hop+余额；错误/describe 无 secret/URL）。
- **基线（临时把分类器压平成 UNSUPPORTED）**：`2 passed / 3 failed`（诊断能力差异，**不是** vendor 复现）。
- 原 redirect 6 组：**6/0，exit 0**（坏 target 的原因断言更新为新码，0 回调/0 余额未放宽）。

## 未证

- 未读真实 wire/record，未发账户请求；真实 11/9 的 `SSO_TARGET_UNSUPPORTED` 具体是 http/path/host 哪一类**仍未知**，
  本包只是让下一次恢复能报出具体固定码。
- 未部署；记录保留，本人只需恢复一次不重扫。
