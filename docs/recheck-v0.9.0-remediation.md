# 0.9.0 整改复核：仍需修复5项

> 日期：2026-10-18。依据[整改记录](remediation-v0.9.0.md)及[初次审查补记](review-v0.9.0-local.md)，重新读取实现、复跑现有测试并执行额外探针。
> **结论：整改有明显进展，但本轮仍不通过。**本轮只核查C主线与整改，不因方向6尚未实施判为缺陷，也不推进方向6。
> 未修改产品代码、未部署、未重启、未提交、未打标签、未推送、未发布；测试使用合成凭据与本地/注入服务。
>
> **（2026-10-18 第三轮独立复核）V1/V3/V4/V5通过原复现条件，V2仍不通过**：补充时序探针发现W1–W3，见[第三轮复核与修复要求](recheck-v0.9.0-round3.md)。下方“全部修复”为整改者提交说明，不代表独立验收。
>
> **（2026-10-18 整改者补记）V1–V5 已全部修复**：逐项证据见
> [整改记录 §0b](remediation-v0.9.0.md#0b-第二轮复核v1v5复现与修复)，复现用例在
> `tools/test-recheck-fixes.mjs`（25 项）。修复后全量 **22 组 768 项通过**，并重新打包
> （`AAE306…`；本文提到的 `e4fc46…` 包作废）。真实宿主验证（secret 剥除、mutate 修订、
> Android `node:https`）仍未进行。

## 1. 已通过与包核验

- 现有 **21组732项**检查/断言通过，另外WorkBuddy真实源码契约 **7项**通过，总计22组739项；无用例跳过。这个统计包含144条Chromium几何断言，不等于739个独立场景。
- 新增整改三组：review-fixes 40、custom-race 32、config-unwrap 22，均通过。
- 行尾/git子进程与Chromium夹具首跑遭沙箱限制；扩大权限重跑同一命令后通过。这是环境限制，不计产品失败。
- [当前包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：117495字节，20个文件，解包总341981字节。
- SHA256：`e4fc46db7527bdfc92dcbe15cd23108354fc880c29d4bf07d455296187316495`。
- SHA1：`2c9099a0e64dbf527b792e13e321dbd7147fc6f5`。
- 逐个归档payload与工作区对应文件比较，20个均相同；与整改记录的包信息一致。包包含下列缺陷，不能据此视为可放行。

## 2. 本轮发现（均已执行探针复现）

### V1 / P1 / R5尚未关闭：非默认端口origin计算错误，正确确认被拒，旧origin却可放行

位置：[originOf/normalizeOriginField](../plans/custom-balance.js#L339-L374)、[validateBalanceUrl返回值](../plans/custom-balance.js#L421-L440)、[目标校验调用](../plans/custom-balance.js#L1172-L1185)。

两个原因叠加：

1. `validateBalanceUrl`只返回`host=parsed.hostname`，没有返回protocol/port；`originOf(target)`因此把`https://a.example:8443/b`算成`https://a.example`。
2. `normalizeOriginField('https://a.example:8443')`调用`originOf(new URL(...))`，而originOf先取URL.host（已经带port）再追加URL.port，并把包含冒号的普通域名误当IPv6。

实际探针结果：

| URL | 已确认值 | 规范化后的确认 | Host目标origin | 发送次数 |
| --- | --- | --- | --- | --- |
| https://a.example:8443/b | https://a.example:8443 | https://[a.example:8443]:8443 | https://a.example | 0，错误credential-unconfirmed |
| https://a.example:8443/b | https://a.example | https://a.example | https://a.example | **1，返回余额1** |

这是凭据目标绑定错误，不只是格式显示问题：443的确认被用于向8443服务发送已有Key。

**修复要求**：基于同一套URL语义计算scheme+hostname+effective port，不把host和hostname混用；前后端默认端口、显式非默认端口、IPv6、大小写、尾点和端口前导零规范化须一致。跨origin（包括只改端口）必须零请求，正确确认必须能发送。测试应走validateBalanceUrl→实际fetchCustomBalance，而非只测手工target对象。

### V2 / P1 / R3尚未关闭：清了effect闭包，没有清掉已渲染state

位置：[轮询局部状态](../client.js#L1034-L1042)、[effect重建](../client.js#L1246-L1268)、[显示过滤只看id/启用](../client.js#L1308-L1325)。

customSignature变化能abort旧请求，删除/停用也能即时隐藏；但组件React state仍保留上一次成功余额。新effect只清空`lastList/failStreaks/customGens`，不会立即作废state里已有的数据；相同id改URL/币种后仍画旧余额，直到新请求返回。

真实Badge+form探针：

```text
BEFORE                                      A$ 91.23
保存：a.example→b.example、USD→CNY
AFTER_CONFIG_CHANGE_WITH_PENDING_NEW_REQUEST A$ 91.23
AFTER_NEW_RESPONSE                          B¥ 1.25
```

新请求被延迟期间旧值依旧可见。整改测试覆盖“初始请求还没成功时变配置”，未覆盖“已有成功余额→改身份→新请求挂起”。Key-only epoch变化也有同样state问题。

**修复要求**：按当前配置身份给已显示数据加有效性约束，在新请求等待期间即剥离该条旧余额、卡片与状态；不要只清闭包。不要顺带丢掉无关内置/自定义渠道的成功基线。还需覆盖Host配置2秒读取缓存：不能在保存后立刻拉回旧配置结果并当作当前新数据保持30秒。补已成功→URL/币种/Key-only变更→新请求挂起/失败/旧快照返回的测试。

### V3 / P2 / R1部分修复：整批有deadline，但单条前置阶段仍可超过自己的预算

位置：[createBudget](../plans/custom-balance.js#L630-L639)、[worker创建子预算](../plans/custom-balance.js#L1367-L1387)。

worker传`createBudget(min(perItem, batch.remaining()), batch.deadlineAt)`，但createBudget只要拿到deadlineAt就直接使用它，忽略totalMs；子任务因此继承完整整批deadline，而非两者最小值。DNS/凭据阶段可超过单条10秒，直至整批20秒才到期。

探针：`timeoutMs=15`、`budgetMs=120`，DNS延迟65ms，transport立即成功。结果约94ms后仍发送1次请求并返回余额12，单条15ms没有约束前置阶段。

**修复要求**：子deadline是`min(now + perItem, batch.deadlineAt)`，包括凭据/DNS/body；单条到期后迟到依赖零发送、无回填，整批其他记录仍正常调度。现有“总预算15ms、DNS80ms”的用例只证明整批截止，不能证明单条截止。

### V4 / P2 / 新HTTPS路径：首次并发初始化返回undefined，产生未预期TypeError

位置：[loadHttps](../plans/custom-balance.js#L960-L968)、[pinnedHttpsTransport](../plans/custom-balance.js#L983-L985)、[requestJson进入时](../plans/custom-balance.js#L869-L876)。

`httpsProbed=true`在动态import完成前就设置；第二个并发调用立即返回尚未赋值的httpsModule（undefined），随后读取https.request抛错。该阶段在requestJson的try/catch之前。正常调度并发数为3，冷启动多个自定义渠道会偶发首轮错误；worker虽然兜底，但用户仍看到不应有的获取失败。

干净Node进程同时调用3次requestJson（注入固定回环地址、连接本地关闭端口，无真实秘密）：

```text
1 fulfilled: network/transport
2 rejected: TypeError: Cannot read properties of undefined (reading 'request')
3 rejected: TypeError: Cannot read properties of undefined (reading 'request')
```

**修复要求**：缓存共享初始化Promise，所有调用等待同一次import完成；不可用统一返回受控unbound，不在初始化中途暴露undefined。用干净子进程/独立模块实例测首次并发，补可用与不可用两种初始化，不能依赖先前TLS测试已经预热模块。

### V5 / P2 / 新HTTPS路径：连接中断被吞成EOF，截断HTTP正文可被当成功余额

位置：[makeStreamResponse.read](../plans/custom-balance.js#L1035-L1047)、[读取与返回](../plans/custom-balance.js#L908-L915)。

IncomingMessage迭代错误被catch后返回`done:true`，上层无法分辨正常结束还是`aborted/premature close`。若已收到的前缀恰是合法JSON，则不完整HTTP响应也会被当成功。

真实本地TLS探针（合成自签证书作为额外CA，TLS校验保持开启、固定lookup）：服务端声明`Content-Length: 100`，只发送`{"balance":123}`后关闭连接。实际结果：

```json
{"kind":"response","status":200,"body":{"ok":true,"text":"{\"balance\":123}"}}
```

**修复要求**：透传stream错误，不将异常当EOF；校验正常响应完成状态（例如IncomingMessage.complete/合法EOF），区分协议无body状态与中断。合法JSON前缀也不能盖住HTTP不完整错误。补真实TLS的Content-Length不足、chunked未终止、body中途错误，以及正常完整响应回归。

## 3. 原审查项分项状态

| 项 | 本轮判断 |
| --- | --- |
| R1 | **部分修复**：整批与挂起依赖已有保护，但单条deadline仍错误，见V3。 |
| R2 | 原复现条件已修复：实际解析Key参与gen，轮换/清空/解析失败测试通过。 |
| R3 | **部分修复**：旧在途响应的cleanup与删除过滤有效，但已成功state未即时清理，见V2。 |
| R4 | 原复现条件已修复：全局8次失败后仍可识别自定义条目，删除/停用清理用例通过。 |
| R5 | **部分修复**：默认443显式Key保护生效，非默认端口绑定仍错误，见V1。 |
| R6 | 原“取消但先写”条件已修复：能力前置检查、同批mutate和拒绝保留草稿用例通过；真实宿主事务语义仍未验证。 |
| R7 | 原无configEditor条件已修复：真实Config→apply→provider 22项通过。 |
| DNS连接绑定 | 方向正确：默认传输固定lookup、TLS校验保留；新路径还需修V4/V5。注入测试transport不受默认原生路径保证。 |

## 4. 后续范围与验收

- 下一轮只修V1–V5及相应负例，保留本轮已通过的整改，不重做方向6，不擅自扩大产品范围。
- 修改后重跑现有21组+契约及新增负例，重新打包并更新hash；当前e4fc46…包仍包含本轮问题。
- 真正DSH宿主的secret剥除、mutate路径/修订、多个Key互不覆盖，以及Android node:https可用性仍未实机验证。未经用户授权不部署当前profile或重启。
- [初次报告](review-v0.9.0-local.md)与[整改记录](remediation-v0.9.0.md)里的“全部修复”应理解为整改者提交说明，不能代替本轮独立复核结论。保留历史证据，新增本轮状态引用。
