# MiMo 持久化：宿主安全存储/目录契约取证（2026-11-07）

只读取证，未登录、未取账号/余额/凭据、未读 cfg/浏览器/osvault 条目、未改宿主、未联网、未装依赖。
真实归档位于运行时上下文所指产品目录的 `resources\app.asar`（213,202,918 字节，`Get-Item` 元数据核验）；
该产品目录名由 `Deep` + `Seek` + 空格 + `Harness` 组成（共 16 字符）。该字面量经内容管线会被归一化显示，
且与运行时上下文的短写法**不是同一个目录**，所以
[extract-asar.mjs](../.diagnostics/mimo-persistence-20261107/extract-asar.mjs) 用**文件大小唯一指纹**定位
（必须恰好一个匹配，否则报错），不依赖显示名、不取“第一个匹配目录”；提取目标限制在 `runtime-source/` 内并做
resolved containment 校验。

## 1. 结论

- **本归档内已检查的公开 credential / storage 契约都不提供加密**：全档 `safeStorage`、
  `CryptProtectData`、`osvault`、`DPAPI` 字节命中均为 **-1**（0 次）；Electron 主进程无 safeStorage、
  无加解密 IPC。这不能外推成“所有宿主都没有任何 API”，只能说本机这套公开实现没有。
- 宿主唯一凭据落盘是 **明文 YAML**（`credentials-local`）：POSIX 0o600、**Windows 权限检查被跳过**、
  同 UID 可读，OS keychain provider 明确 “deferred”。
- 公开持久化契约：`ctx.credentials`（凭据 + record）与 `ctx.dshHomePath`（家目录解析），
  另有 Host 侧 `ctx.storage.domain` / JSON 后端（明文）。
- **“安全加密本地”本轮选定 Windows DPAPI(CurrentUser)，由 Host 以子进程调用**（Node 无内置 DPAPI；
  Host 是 `ELECTRON_RUN_AS_NODE` 子进程，拿不到 Electron API）。这不是“所有环境唯一实现”的结论：
  desktop-host 已带 `koffi` 3.1.1（原生 FFI），理论上也可走原生模块；本轮选子进程是为了**不新增依赖**。

## 2. Host / Electron 进程边界（已证实）

| 事实 | 出处 |
|---|---|
| 桌面壳是 Electron，入口 `lib/main.js`（version 0.2.2-rc.1） | `runtime-source/package.json` |
| Host 是主进程 spawn 的 **Node 子进程**：`ELECTRON_RUN_AS_NODE: "1"`，入口 `@deepseek-ai/dsh-desktop-host/lib/index.js` | `runtime-source/lib/main.js:9744-9752`、`9976-9996` |
| 主进程只有文件/剪贴板/拖拽/窗口/账号等 IPC，无任何加解密或 safeStorage IPC | `lib/main.js` 的 `ipcMain.handle` 清单（1599-21051） |

推论：插件 Host 半不可能调用 Electron `safeStorage`；平台加密只能由 Host 自己（子进程或原生模块）完成。

## 3. 可用 API（公开契约）

- **`ctx.get('credentials')`**：服务名 `credentials`，`dsh-credentials/lib/index.js:109-111`。
  读侧 `resolve/describe/set/unset`；record 侧 `readRecord/describeRecord/listRecords/modifyRecord/deleteRecord`
  由 `dsh-credentials-local/lib/index.js:527-596` 实现，key 形如 `<scope>/<id>`（小写连字符），
  `kind:'grant'` 的 `payload` 只要求“JSON 可往返、原样保存”（`:561`）。
- **凭据文件**：`$DSH_HOME/.credentials.yaml`（`dsh-credentials-local/lib/index.js:49,58`），
  目录 0o700 / 文件 0o600（`:552-567`），**明文 YAML**；权限校验仅 POSIX（README:115），
  同 UID 进程可读（README:199），OS keychain provider deferred（README:211）。
- **`ctx.get('dshHomePath')`**：`dsh-app-boot/lib/index.js:5278`；解析顺序 显式 > `$DSH_HOME` > `~/.dsh`
  （`dsh-home-paths/README.md:34-41`）。纯路径，不加密。
- **`ctx.get('profileContext')?.dir`（已找到 provider，不只是 consumer）**：
  `dsh-desktop-host/lib/index.js:6` 从 `@deepseek-ai/dsh/profile-boot` 引入 `runProfile`，
  `:441` 以 `{profile:'desktop', resolvedProfile:{profile, installAnchor}}` 调用；
  该子路径由 `dsh/lib/profile-boot.js` 转发到 `dsh/lib/profile-boot-e2mS45fC.js`，
  后者在 `:291-302` 构造 `profileContext`（含 `name/dir/patchPath/installAnchor/startedBundles/cwd/home/...`），
  并在 `:305` `hostCtx.provide("profileContext", profileContext)`。app-boot 只消费它
  （`dsh-app-boot/lib/index.js:3099`、`3105`）。因此 Host 插件在 desktop 启动路径上能拿到
  `profileContext.dir` 作为稳定 scope 来源；本轮**未读取任何实际 profile 值**，仅确认公开代码路径。
- `ctx.storage.domain.open(spec)`（`dsh-storage-domain/README.md:52`）与 `dsh-storage-json` 的 `root`
  （README:36/50，0o700）是 Host 侧明文 JSON 存储。

## 4. 未证实（不得当作已通过）

- desktop profile 组合是否真的加载了 `credentials-local` / `storage-json`（本轮不读 cfg）。
- `profileContext.dir` 的运行时实际取值未读（未读 cfg）；只确认 provider 代码路径存在。
- 插件运行期能否写 record（本插件目前只用了 `credentials.resolve`，见 `index.js:1391`）。
- 其他移植端/未来版本是否提供加密 provider（只证本机此归档没有）。

## 5. 采用的方案：DPAPI 信封 + credentials record + 显式能力门

已实现（仅此两文件；未接真实凭据、未注册 Host）：

- [windows-dpapi.js](../plans/mimo-auth/windows-dpapi.js)：`createWindowsDpapi({scope, spawnImpl?, timeoutMs?, maxBytes?})`，
  返回 `capability/protect/unprotect/dispose`。仅 win32；绝对 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`；
  `-NoProfile -NonInteractive -EncodedCommand`；秘密只走 stdin/stdout；stderr 丢弃；5s、256KiB、可取消；
  同一实例串行执行，每个在途子进程独立登记取消器，`dispose` 取消**全部** active；失败只给固定码；
  entropy 由固定用途串 + 完整 scope 派生（跨 profile 搬密文解不开）。
  能力自检每次 boot 一次：随机 16B Protect/Unprotect + 错 entropy 必须被拒。
- [remember-store.js](../plans/mimo-auth/remember-store.js)：`createRememberedVault({credentials, scope, crypto})`，
  返回 `capability/load/save/forget/dispose`（`crypto` 缺省即 `createWindowsDpapi({scope})`；
  `scope` 由集成层取 `ctx.get('profileContext').dir` 的解析绝对路径，缺失 fail closed）。
  `epoch` 在调用入口捕获（capability await 之后、`modifyRecord` 之前都复核），迟到者不成新一代写；
  对外错误码只允许 STORE_CODES / DPAPI_CODES 白名单，未知码折成固定码。record 严格白名单（含 `preferences.paused`）；信封固定
  `{version:1,algorithm:'windows-dpapi-current-user',ciphertext}`；tombstone 为 `{...,revoked:true,revision}` 无账号信息；
  save 必须 `expectedRevision`（null 只匹配无记录），在 `modifyRecord` 独占时刻比对；epoch + dispose 防迟到写。
- 测试：[test-mimo-remember-store.mjs](../tools/test-mimo-remember-store.mjs)（fake provider + fake crypto）、
  [test-mimo-dpapi.mjs](../tools/test-mimo-dpapi.mjs)（win32 合成往返）。均不接触真实凭据服务。

安全边界：DPAPI(CurrentUser) 只防**离线文件拷贝 / 其他 Windows 用户 / 备份泄露**，
**不防同 UID 进程**（Host 与 agent 同用户）；Android DSHA 无 shell，能力显式 unsupported。

## 6. 与方案相关的契约提醒

自动恢复**不得**通过代码伪调 `confirmedByUser:'match'` 冒充“本人已比对余额”；需要独立的
“首次本人确认账号 + 记住并允许未来自动读/刷新”授权类型（即落盘的 `consent` 三项 true），
旧手动 match 链语义不变；昵称只出现在待确认 owner UI，不进普通 status/caps/sidebar/usage 工具；
每 boot 重建 opaque grants，不序列化旧 owner/WeakMap/boot token。
用户最新授权与待决点见 [MEMORY.md](../MEMORY.md)（2026-11-07 条）。

## 7. 引用

- `runtime-source/dsh/node_modules/@deepseek-ai/dsh-credentials/lib/index.js`
- `runtime-source/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js`、`README.md`
- `runtime-source/dsh/node_modules/@deepseek-ai/dsh-home-paths/README.md`
- `runtime-source/dsh/node_modules/@deepseek-ai/dsh-storage-domain/README.md`
- `runtime-source/dsh/node_modules/@deepseek-ai/dsh-storage-json/README.md`
- `runtime-source/lib/main.js`、`runtime-source/package.json`
- 既有探针：`.diagnostics/mimo-qr-20261025/probe-dpapi.synthetic.{ps1,result.json}`
