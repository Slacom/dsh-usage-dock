# 额度感知整改第二轮复核：仍不通过

> 2026-10-19。对应整改包SHA256：`1d46a28acdcb8751e932b3343e00d79f256ae169e3db665d71c522c6cf169758`。
> 依据：[上一轮13组问题](review-quota-awareness-build-20261019.md)、[用户确认的执行交接](handoff-quota-policy-build-v0.9.0.md)。
> 用户提示额度仅剩27%，本轮先保存[续接检查点](handoff-quota-review-round2-20261019.md)，随后完成定向复现、全量回归及包核验；未增加子代理开销。
> **结论：有实质修复，但A02/A03/A04/A06/A07/A08仍未闭环，不能认定13组全部整改完成。暂不部署。**

## 1. 实测结果与范围

- 全量39个脚本均exit0：**36个普通Node组1304项＋行尾58＋几何144＋契约7＝1513项**，0跳过。[执行清单](../.diagnostics/review-quota-round2-20261019/regression/summary.json)、[计数](../.diagnostics/review-quota-round2-20261019/regression/counts.json)。
- 新包178340字节、27文件，逐payload与源码比对mismatch=0；SHA1 `8259675e8d5bc22a659c2d471ff74264ee21de7f`。[包核验](../.diagnostics/review-quota-round2-20261019/package-audit.json)。所以问题仍在本次新包里。
- [定向脚本](../.diagnostics/review-quota-round2-20261019/recheck-host.mjs)使用真实apply、采集注册表、当前context回调，合成配置与provider；内置坏JSON另经过真实OpenCode Go provider/curlJson，传输用Response桩。
- 不再使用上轮补全局projectUsage的故障隔离；本轮全程使用未修改产品源码。测试内临时替换provider函数/全局fetch均在finally恢复。
- [定向日志](../.diagnostics/review-quota-round2-20261019/recheck-host.log)的FAIL条目是在确认缺陷仍存在，脚本exit0表示复现成立，不表示产品通过。
- 没有读取真实凭据、部署、重启、提交、推送、发布或修改既有测试/产品。除A06缺省授权用例外，定向场景显式设quotaTrustRouteOrder=true，以独立检验其余问题，而非依赖某个默认值。
- 另跑git diff --check返回2，指出[既有整改测试](../tools/test-degrade-refresh.mjs#L111-L119)第111/117/118/119行trailing whitespace；已查看相应内容，未擅自改动。这是单独的构建卫生问题，不与1513项测试exit0混同，也不作为本轮主要拒绝依据。

## 2. 已确认有效的整改

| 上轮项 | 本轮观察 |
| --- | --- |
| A01 成功发布 | 实际GUI成功采集123积分后，真实context能读到123及closing，不再“永远暂无” |
| A09 第5次固定失败 | 真实GUI连续5次T后，wire.effectiveStatus=failed、failCount=5，context为固定“获取额度失败” |
| A09 封存状态 | 明确过期后再T，仍保持“用量查询身份已过期”，没有降成暂无 |
| A05 scope守卫 | 当前代码已有主体比较；正式真实scope回归16项通过。本轮未重建上一轮全部底层拓扑探针 |
| A10 重复wire | 当前WeakSet对同对象去重、正式新增回归通过；不能由此反推生产票据签发时机已正确（见A03） |
| A11/A12 | 代码已三态拒绝歧义、内置provider精确匹配，新增回归通过 |
| A13 | 工具policy已停用旧建议并保留兼容字段，相关回归通过 |
| A07部分 | 显式source不匹配时能拒绝，Reserve无池证明时能抑制；但缓存错误路径可绕过source校验，见下文 |
| A08部分 | 新增authKind/credentialState及transient优先级是实质改进；但真实内置解析错误和明确P类仍错分 |

以上是分范围证据，不等于对每个旧探针都逐一重跑或已完成真机验收。

## 3. 仍需整改的六组问题

### R2-01 / A03：生产仍在“采集完成之后”签票，旧响应覆盖问题未修

位置：[票据创建仍在publish](../index.js#L236-L251)、[GUI先等fetch完成再publish](../index.js#L469-L476)、[工具emit同样不传开始票据](../index.js#L837-L868)。

begin/commit的helper现在能拒绝较旧ticket，单测也是先begin两张再提交。但生产没有在请求开始处调用begin，所有调用仍是publishObservation(wire)，最后在发布函数里临时签票。pendingTickets仅定义，没有接入采集。

**实际复现FAIL_A03：**旧GUI请求先挂起→新GUI请求返回9000积分、normal→旧请求返回1积分，反而拿到更大seq并变closing。与上一轮同样的用户风险仍在。

**必须修法：**在真实每条采集开始时绑定ticket和当时配置/源身份，传到完成回调；发布时验证当前身份/代次，不能用完成时最新配置给旧结果重新贴标。单测需跑真实apply并控制两个provider Promise的完成顺序，不仅测helper。

### R2-02 / A02：身份摘要只覆盖custom；内置凭据变化不失效，反而误清无关渠道

位置：[identityOfChannel](../index.js#L216-L224)、[其委托的digest](../plans/custom-balance.js#L904-L922)、[reconcile](../index.js#L321-L338)。

configDigestOf只折叠customBalances/customKeyRev，并不覆盖MiMo Cookie、内置Key、实际引用解析身份或账号。再拼id不能把它变成每条真实身份。

两条实际复现：

1. **FAIL_A02_BUILTIN：**MiMo合成Cookie A下取得1CNY/closing→保存Cookie B并触发真实config-reload→仍输出旧1CNY及收尾规则，未等待新身份数据。
2. **FAIL_A02_UNRELATED：**WorkBuddy未变化，只改另一个custom的公开修订，WorkBuddy已有123积分基线被清成“暂无数据”。说明所谓逐条reconcile使用的却是所有条目共享的摘要。

**必须修法：**逐渠道、逐来源的真实身份/公开修订与生效配置；只作废受影响条目，保持未改动渠道及失败计数。实际凭据/账号证明不可得时按限制处理，不用custom全局摘要代替。票据还须与采集时所用配置同源。

### R2-03 / A06：模块默认闭，但生产入口仍默认放行

位置：[生产函数](../index.js#L165-L187)、[schema仍default(true)](../plans/usage-policy.js#L68)。

createRouteObserver默认false已修，但生产传入quotaTrustsRouteOrder，缺省`quotaTrustRouteOrder !== false`即true。新增配置默认true不能算用户已经显式确认安装顺序；代码“默认闭合”注释与实际不同。

**FAIL_A06：**未配置该信任项，稍后outer writer把本次真实返回路由改成openai-codex，context仍按旧WorkBuddy低积分closing。这里是合法嵌套中间件复现；上一轮已经以真实Cordis方法验证过该顺序机制，本轮未声称任意晚插入都能提前自动发现。

**必须修法：**缺省关闭，并以明确授权/已验证链及生命周期打开；已知重载失效后不能继续放旧观察。如果希望把需求改为“默认信任本机标准链”，须用户明确接受该取舍，不能由执行者新增默认true字段完成替代。未通知的任意writer限制仍应如实说明。

### R2-04 / A07：一次T错误就抹掉来源证明，原本拒绝的余额反而被接受

位置：[每次meta.source取当前wire.via](../index.js#L283-L293)、[undefined时跳过来源校验](../plans/quota-view.js#L191-L195)。

**FAIL_A07_ERROR_ERASES_SOURCE：**

```text
当前模型路由 deepseek-official，要求API余额
第一次采集 via=account，余额1CNY → 正确拒绝，不投放
下一次暂时network错误，无via → 保留旧account数值，但meta.source被写成undefined
view因undefined跳过source检查 → 旧账号余额1CNY作为缓存进入API路由，并触发closing
```

所以“来源不匹配/未证明就不投放”的声明在真实缓存链上不成立。这不只是仍未实现账号级增强，而是已有来源证据在错误路径被丢弃后，限制被放宽。

**必须修法：**缓存数值与其成功来源/身份/池证明作为不可拆记录保留；T继承原成功证明，不用错误wire覆盖。对需要source约束的可用数值，缺证明应拒绝而非跳过。明确失效的固定状态也要关联正确查询源，不给错误账号/源编造过期信息。

### R2-05 / A04：共享了状态/次数，仍没有共享有效缓存值

位置：[Host只附status/count](../index.js#L302-L317)、[客户端cached仍读自己的lastList](../client.js#L1418-L1424)。

**FAIL_A04_CACHE_VALUE：**先通过主动工具成功采集321积分，Host有该成功记录；随后新的GUI第一次采集失败，响应是`error:exec / effectiveStatus:cached / failCount:1`，没有creditsTotal。模型仍正常收到321缓存。

对于没有本地lastList的新窗口，当前客户端分支直接push错误wire；对于有较旧本地值的窗口，则沿用它自己的较旧数值。无法与Host最新缓存保持同一结论。此处已收到最新响应，不属于“浏览器断线所以版本不同”的允许边界。

本轮证据为真实Host响应＋客户端确定代码分支，未伪称已经做了真机截图验证。

**必须修法：**GUI消费Host统一的有效数据和状态，不只接收cached标签；旧wire/成功基线与模型投影可分层，但必须属于同一观察。测试工具采集→新窗口首次失败，以及两个窗口/工具成功改变基线后再失败。仅阈值改5仍不足。

### R2-06 / A08：真实内置坏JSON仍立即P；若干明确P类又被降为T

位置：[分类器](../plans/quota-observer.js#L83-L108)、[内置parse结果](../plans/util.js#L220-L225)。

- **FAIL_A08_NATIVE_PARSE：**先用OpenCode Go成功额度作为基线，再让真实provider/curlJson收到合成HTTP200坏JSON，得到`error:parse`且无transient。第一次就failed并移除缓存，没有前4次宽限。自定义structure带transient的用例修好，不代表内置通用解析链修好。
- **FAIL_A08_KNOWN_PERMANENT：**endpoint、not-installed、incompatible当前都落入未知默认T。这些分别对应明确接口问题、未安装、不兼容，按已确认分类应立即P，不能先保旧值或等5次。

**必须修法：**将可信本地配置/能力问题与响应坏JSON区分：坏响应默认T，本地路径语法等才P；给已知endpoint/能力错误明确映射。保留未知一般故障T和明确身份过期A，不退回扫描自由文案。补真实各provider→发布→最终状态测试。

## 4. 下一轮应怎样验证

1. 不再只增加helper断言。上述六组应全部通过真实apply链的修复后断言；begin必须在测试能看到的provider调用前发生。
2. 本轮脚本断言的是残留缺陷，修复后应将对应断言改为正确行为并形成正式回归，不能把旧脚本退出1直接当回归失败或删掉负例。
3. 逐条身份与缓存来源校验一起修，避免修掉清空后又被迟到结果补回。保留未改动渠道基线。
4. 共用有效数据后再测GUI/模型的5次阈值、冷启动、新窗口与工具交叉采集。
5. 新包重打、新hash、全量回归、独立复核后，再另获部署/真机授权。窗口口径、账号证明、UI尚未完成项仍不能默认写成已验收。

## 5. 额度与续接情况

本次没有因额度提醒而省略已启动作业：全量后台job `pwsh-143e8e88e0cc456d` 已完成并收集，exit0；定向复现与包核验均完成，无未收集后台作业。没有启动新子代理。

后续可从[续接文档](handoff-quota-review-round2-20261019.md)定位证据与命令；本轮结论已定为不通过，不需后续模型重复整个研究。下一步应先让执行者补六组残留闭环，再审。
