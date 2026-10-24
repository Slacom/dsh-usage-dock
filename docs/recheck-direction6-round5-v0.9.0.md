# 方向6第五轮独立复核：Q2/Q3通过，Q1仍有两处冻结协议缺口

> 日期：2026-10-19。对象：E56F9DE0…本地包，承接[第四轮报告](recheck-direction6-round4-v0.9.0.md)。
> **结论：尚不能整体验收；只继续修Q1剩余F1/F2，不重做已通过项。**共用API Key冻结四态、DeepSeek/OpenCode正常回退与停用零解析已通过；custom与MiMo没有完整遵守相同冻结协议。
> 本轮只读产品、运行合成凭据/虚拟传输探针并更新审查文档；未改产品或宿主、未部署/重启/提交/改标签/推送/发布。
>
> **（2026-10-19 第六轮独立复核）本地代码复核通过**：F1/F2原缓存污染条件未再复现，1317项回归及另7项契约首跑通过，411C577C…包23个payload一致。详见[第六轮报告](recheck-direction6-round6-v0.9.0.md)。仅绑定该本地包；真宿主/Android/用户试装未验收，不是部署、重启或发布授权。
>
> **（2026-10-19 整改者补记）F1/F2 已整改**：注册层合并 `frozen`+`custom` 为一张逐 id 冻结表；自定义 provider 把冻结协议前移到「选择已保存凭据之前」（explicit/ref 只用冻结值、none 直接缺凭据、未采样才走原路径，冻结值仍过 origin 校验）；MiMo 有冻结描述即严格遵守（none 零请求、explicit 只用其字段、其它状态安全拒绝）。
> 同时按本轮要求修正了两处测试质量问题：Q1a 改成显式 gate 握手并断言真的进入采样等待；V3c 的 1ms 墙钟断言改为确定性断言（不放宽产品预算、不删安全断言）。
> 证据：`tools/test-usage-recheck-f1f2.mjs`（32 项）+ `tools/verify-f-mutations.mjs`（五项变异全部被捕获）。
> 新包 `411C577C…`（`E56F9DE0…` 作废）。真宿主冒烟、策略 UI、Android 仍未验证，本轮**不**声称已通过。


## 1. 已通过与核验范围

### Q2、Q3原条件已通过

独立真实apply/provider，只有凭据与网络服务被桩替换：

- DeepSeek无账号、无插件Key、有模型Key：availability=ok、余额7.25，解析DEEPSEEK_API_KEY，不再报no-credential。
- OpenCode首候选空、第二候选有效：availability=ok、剩余10%，保留候选顺序。
- 全部内置停用、显式点名OpenCode：disabled，凭据解析列表为空。
- [共用resolveApiKey](../plans/util.js#L399-L421)四态：cfg显式B＋冻结explicit A→A；冻结ref A→A；冻结none→undefined；未采样→cfg B，均没有多余resolve。不要将MiMo特有缺口概括成共用API解析器未修。
- Z2/Z3/Z4等现有回归继续通过，本轮不扩大为新的功能验收目标。

### 产物

[当前包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：157937字节、23文件、解包467338字节；全部payload逐字节匹配工作区。

- SHA256 `e56f9de0c059c5a86661c742712895ec0f594dfd78e399cda4e0750e42cbea8b`。
- SHA1 `7d30f555a95cd8978d4eec03313f172dd782686d`。
- 入口/修改模块语法及git diff --check通过。

## 2. F1 / P1：custom冻结快照在中间层丢失，显式分支也忽略冻结值

### 2.1 引用快照没有到达真实取数

[index识别层](../index.js#L443-L539)分别构造`frozen`（内置）与`customSnapshot`，返回`snapshot:{frozen,custom}`；但[注册层](../plans/usage-tool-register.js#L458-L464)只保留`.frozen`，丢弃`.custom`。后续collect把这个只含内置的map作为custom的credentialSnapshot。

结果是custom仍二次解析引用，无法保证身份与发送同源。

**真实apply→真实custom provider，虚拟DNS/HTTPS，未访问外网**：第一次identify解析为A；取数再次解析时变B；随后恢复A再查。

```text
CUSTOM_FROZEN_HANDOFF:
first=50, second=50
resolves=3, requests=1, actualTransmittedAccounts=[B]
```

A的正确余额应为10，B为50；唯一请求发送B，却把50写入采样身份A。第二次当前A仍命中B的50。不是仅凭代码推测未接线，而是实际缓存污染。

### 2.2 即使手工传到，冻结显式Key仍不生效

[custom provider](../plans/custom-balance.js#L1438-L1480)先使用当前entry.key，只有`key.length===0 && credentialRef非空`才进入快照分支。冻结explicit因此不能覆盖当前已保存Key，尤其没有引用的纯显式条目根本不会读取它。

独立调用真实fetchCustomPlans，当前customKeys=B、正确手工传入该id的冻结explicit A：

```text
CUSTOM_EXPLICIT_FROZEN:
balance=50, actualTransmittedAccounts=[B]
```

预期发送A并返回10。**只修中间层转发，仍不足以修复这个问题。**

### 要求/验收

- 统一内置和custom的逐id私有冻结map，或显式保留两部分并在正确边界取出；验证实际传到provider的结构，不只验证identify返回值。
- custom在选择已保存凭据前执行冻结协议：explicit/ref使用冻结值，none直接缺凭据，只有未采样才采用当前配置/原解析路径。
- 保留URL/DNS/IP绑定和credentialHost校验；不得用pendingKey冒充冻结已保存Key绕过目标确认。
- 补真实apply的custom引用A→B→A、直接provider的显式A与当前B、none与当前Key非空、显式不带ref等矩阵。验证请求实际来源、结果、第三次缓存与零多余解析。

## 3. F2 / P1：MiMo把冻结none当未采样，污染“无凭据”身份缓存

[MiMo取数](../plans/mimo.js#L103-L113)只识别冻结explicit，其余情况全部回退cfg.mimoCookie。共用resolveApiKey已经正确处理none，并不会自动修好这个独立Cookie分支。

### 独立真实provider

```text
cfg=后来Cookie B, frozenCredential={kind:none}:
requests=1, sent=B, error=null, balance=17.55
```

冻结none应直接缺凭据且零请求。explicit A与未采样的正常行为分别正确，不需要重写它们。

### 真实apply缓存污染

MiMo最初没有Cookie，identify冻结none，并由[index](../index.js#L492-L498)纳入cacheable。同批custom慢引用等待2100ms期间，普通configEditor override变为Cookie B；collect重读后MiMo无视none，用B取到17.55。随后清空Cookie、单次reload失效配置缓存，再查相同ids：

```text
first balance=17.55
second balance=17.55, fetchedAt与首次完全相同
唯一MiMo请求账户=B, requests=1, refResolutions=2
```

当前没有凭据，工具却持续返回缓存成功余额；证明不只是直接provider的特殊参数边界。custom辅助目标被现有私网校验拒绝，没有真实外部网络。

### 要求/验收

- MiMo有冻结描述时严格遵守其状态：none直接no-key；explicit仅用其自有字段，缺失/无效不能回退实时cfg；未采样才读取cfg。
- MiMo没有ref来源；不支持的冻结状态应安全拒绝，不必把人为传入ref另算生产缺陷。
- 补真实provider状态矩阵及真实apply的none→后来Cookie B→清空→缓存查询；确认没有请求/成功缓存出现在none身份。正常explicit Cookie、未采样和Web行为保持不变。

## 4. 回归实测：首跑并非一次全绿，需如实记录

独立批量运行33个回归脚本共1281项，另WorkBuddy契约7项，共1288项，无跳过：

- 首跑旧[test-recheck-fixes](../tools/test-recheck-fixes.mjs#L114-L121)为24/25，唯一失败V3c；其余回归与契约均通过。因此首批为1287通过、1失败，不能写成一次全量全绿。
- 原始记录见[该次日志](../.diagnostics/d6-fifth-review-bbdeb20902df44deb70d4a51b24ac141/test-recheck-fixes.log)。
- 随即单独复跑同一脚本，25/25通过，退出码0。
- V3c是`createBudget(1,...).expired===false`，要求1ms预算在构造后立即读取时尚未过期，依赖墙钟跳变与调度速度，存在测试时序脆弱性；没有据此判定产品预算回退。15ms到期/迟到DNS零发送等安全断言通过。

建议将这个时钟断言改为可控时钟或不依赖1ms执行速度的确定性测试，不放宽产品预算、不删除安全断言。它作为测试稳定性记录，不替代F1/F2，也不另开产品缺陷。

## 5. 测试覆盖提醒

现有[Q1a用例](../tools/test-usage-recheck-q1q3.mjs#L78-L139)配置了SLOW_REF条目，但执行只请求opencode-go，因此该slow ref不会被解析；reads从1初始化，也不足以证明采样真的跨过2秒后collect读到B。Q1d对provider的冻结值断言有效，但不能把它与Q1a的“真实跨时序”混为一谈。

补测试时应明确等待gate真的进入、cfg确实由A变B、再放行取数，并断言跨边界前后的实际值；不要求为此重做已经独立通过的API解析器四态。

## 6. 后续范围

只继续修Q1剩余F1/F2，保留已通过Q2/Q3、取消/逐条结果、策略reload及混币UI。重点完成整个冻结描述在“identify→注册层→collector→各provider”的逐层传递和状态服从，不再只测试公共helper或OpenCode。

真实DSH tools/systemPrompt冒烟、Android能力、策略UI仍未验收；本轮未部署/重启，不冒充真机验证，也不因缺实机授权新增代码缺陷。

执行提示词见[第五轮整改提示词](fix-prompt-direction6-round5-v0.9.0.md)。
