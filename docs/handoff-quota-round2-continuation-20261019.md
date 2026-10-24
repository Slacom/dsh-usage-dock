# 额度感知 round-2 整改：断点交接

> 生成时间：2026-10-19 23:45。**额度可能随时耗尽**，本文件保证可续接。
> 依据：[第二轮复核](recheck-quota-awareness-round2-20261019.md) 的六组问题。

## 0. 当前状态快照

| 项 | 值 |
| --- | --- |
| 仓库 | `E:\WorkSpace\DSH\DSH Usage Dock`，HEAD `71e71b4`，**未提交** |
| 上一包 | `1D46A28ACDCB8751E932B3343E00D79F256AE169E3DB665D71C522C6CF169758`（178 340 B / 27 文件） |
| 全量回归 | 36 组 1304 项 + 行尾 58 + 几何 144 + 契约 7 = **1513 项**，0 失败 |
| 部署 | **未部署、未重启**（未经授权） |
| 待修 | 六组 R2-01 ~ R2-06，本轮尚未开始修改代码 |

## 1. 六组问题与修法（按优先级）

### R2-01（P1）生产仍在采集**完成之后**签票

**现象**：`begin()` 只在 `publishObservation()` 里调用；真实调用是
`publishObservation(wire)`，所以票据序号按**完成顺序**分配。旧 GUI 请求挂起 →
新请求先返回 9000 → 旧请求后返回 1，旧请求反而拿到更大 seq 并覆盖。
`pendingTickets` 定义了但没接入。

**修法**：
1. 在**每条真实采集开始处**（GUI 的 `builtInTask`/`customTask` 每个 plan 调用前、
   工具 `emit` 之前的 provider 调用前）调用 `quotaObserver.begin({id, identity})`。
2. 把 ticket 一路传到完成回调，发布时用该 ticket（不再在 publish 里现签）。
3. 发布时校验「ticket 的身份 == 当前应有身份」，不等则丢弃（不能用完成时的新配置给旧结果贴标）。
4. 测试：真实 apply + 两个可控 Promise 完成顺序，断言旧结果被拒。

### R2-02（P1）身份摘要只覆盖 custom；内置凭据变化不失效，还误清无关渠道

**现象**：
- `configDigestOf` 只折叠 `customBalances` / `customKeyRev`，**不含** MiMo Cookie、
  内置 Key、引用解析结果、账号。
- 而 `identityOfChannel` 却拿这个**全局摘要** + id 当"每条身份" →
  改任意一条 custom 的 Key 会让**所有**渠道（含 WorkBuddy）身份变化而被清空。

**修法**：
1. 逐渠道计算身份：该渠道自己的**公开配置字段**（Cookie/Key 的存在性与长度指纹、
   引用名、URL/路径、币种…）+ 该渠道 `customKeyRev`（仅 custom 条目）。
2. **不得使用共享全局摘要**；只影响真正变化的渠道。
3. 内置凭据字段变化（如 `mimoCookie`）必须改变该渠道身份；其它渠道不变。
4. 未改动渠道保留原基线与失败计数。

### R2-03（P1）生产入口仍默认放行闸门

**现象**：`quotaTrustsRouteOrder()` 里 `quotaTrustRouteOrder !== false` 即 true，
schema 也 `default(true)`。审核立场是「缺省必须关闭，须显式授权」。

**修法**：schema 改 `default(false)`；生产改为 `=== true`。
**注意**：这会让功能默认不工作，需在交付说明中明确"用户如何打开"，
并如实说明本机标准链已核验、可由用户自行开启。

### R2-04（P1）一次 T 错误就抹掉来源证明，原本拒绝的余额反被接受

**现象**：`meta.source` 每次从当前 wire 的 `via` 取；T 错误没有 via →
`meta.source = undefined` → 视图里 `meta.source !== undefined` 不成立 → **跳过**来源校验 →
旧 account 余额在 api 路由下被当作缓存接受并触发 closing。

**修法**：
1. 缓存记录（`channelProjection`/`channelMeta`）把**成功时的**来源/身份/池证明
   作为不可拆字段保留；T 继承原成功证明，**不用错误 wire 覆盖**。
2. 视图：需要 source 约束但记录缺证明 → **拒绝投放**（不是跳过校验）。
3. 固定失效状态也要关联正确的查询源。

### R2-05（P2）共享了状态/次数，仍没共享**有效缓存值**

**现象**：工具先成功采集 321 → Host 有该记录；随后新窗口首次 GUI 失败，
响应只有 `effectiveStatus: cached`，没有数值；客户端 `cached` 分支读**自己的**
`lastList`（新窗口为空）→ 直接 push 错误 wire。

**修法**：Host 在 `effectiveStatus === 'cached'` 时也要附上**缓存数值**
（从 `channelProjection` 取），客户端直接使用；仅当 Host 未提供才回退本地基线。

### R2-06（P2）真实内置坏 JSON 仍立即 P；若干明确 P 类被降为 T

**现象**：
- 内置 `util.js` 的 `parse` 错误没有 `transient` → 分类器判 P → 第一次就 failed。
  坏响应应默认 **T**（宽限 4 次）；只有本地路径/语法等**配置**问题才 P。
- `endpoint`、`not-installed`、`incompatible` 落入未知默认 T，应显式映射为 **P**。

**修法**：分类器把 `parse` 默认改为 T（坏响应），新增 `endpoint`/`not-installed`/
`incompatible` → P；保留未知 → T、明确过期 → A。

## 2. 修复顺序与验证要求

1. R2-01（数据链正确性，其他修复都依赖它）
2. R2-02 + R2-04（身份与来源，二者耦合）
3. R2-03（一行配置，但要改默认值并说明）
4. R2-06（分类器）
5. R2-05（GUI 共享缓存值）

**验证要求**（审核明确）：每组都要**真实 apply 链**上的修复后断言；
不能只加 helper 断言；旧的"复现缺陷"脚本应改为断言正确行为并纳入正式回归。

## 3. 复跑命令

```powershell
cd 'E:\WorkSpace\DSH\DSH Usage Dock'
# 全量（避免 PowerShell 管道，用文件重定向）
$tests = Get-ChildItem tools\test-*.mjs | Where-Object { $_.Name -notin @('test-line-endings.mjs','test-peak-marker.mjs','test-workbuddy-contract.mjs') } | ForEach-Object { $_.BaseName }
foreach ($t in $tests) { cmd /c "node tools/$t.mjs > $env:TEMP\$t.txt 2>&1"; if ($LASTEXITCODE -ne 0) { Write-Output "FAIL $t"; Get-Content $env:TEMP\$t.txt -Tail 5 } }
node tools/test-line-endings.mjs
node tools/test-peak-marker.mjs
node tools/test-workbuddy-contract.mjs legacy/workbuddy-android-contract/package/lib/index.js
```

## 4. 硬约束（不得违反）

- 不改 DSH 宿主、不覆盖已安装 profile、不自动重启、不 commit、不改/建标签、不 push、
  不 Release、不 npm publish。
- 不读取或打印真实凭据。
- 不把"本地回归通过"写成"真机已验证"。
- 不删旧负例来让测试变绿。

## 5. 仍未完成（不得写成已验收）

- **窗口口径**：现只评估最小时间单位窗口；周限是否也约束当前模型未确认。
- **账号级证明**：Codex 冻结 store、WorkBuddy 同次 credits 账号归属未实现。
- **设置页 UI**：策略控件未做。
- **真机验证**：未部署。
