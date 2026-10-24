# 0.9.1第十轮复核：B/C关闭，A剩派发过滤与旧GUI结果撤销

> 对象：SHA256 `35E946D0394435D5C722E76A09498305FCF4A7AF6B9529B10C3D35D66A07912F`，231088字节/27文件。依据[整改§23](quota-policy-build-v0.9.0.md#L1539-L1616)及[冻结收口清单](closure-audit-custom-and-quota-20261021.md)。
> **本轮明显收敛：B/C受测范围可关闭；A原六时序5通过/1不符，仍有P1误收尾。**不新增功能、不改UI，不要求策略UI/计费池/窗口/Android先完成。
> 全程只审：真实生产apply与合成服务/Key/传输；未读真实Key/profile，未访问用户网关，未改产品/正式测试/旧证据/安装副本/配置，未部署/重启/提交/发布。用户截图WorkBuddy7233/OpenRouter0.66是正常显示证据，不用于代替边界验收；截图中执行方如实说明A未跑完整门闩，本轮已补跑。

## 1. 已可关闭：B正文取消、C公开异常脱敏

[独立复核摘要](../.diagnostics/review-custom-provider-round10-20261022/gateway-summary.md)及完整日志：

| 范围 | 结果 | 核验内容 |
| --- | --- | --- |
| [B取消](../.diagnostics/review-custom-provider-round10-20261022/cancellation-probes-final.log) | 6/6 | 原生status正文取消返回cancelled、生产分类C而非T；预取消零I/O；连接取消；凭据释放后C且无迟到HTTP；可选明细取消保留已成功42不计T；共享消费者相互隔离 |
| [C公开异常](../.diagnostics/review-custom-provider-round10-20261022/public-errors.log) | 9/9 | 原生Headers阳性控制仍能带出合成Key，证明刺激有效；transport/native Headers的主wire、账号列表、真实注册GUI与账号路由均只给固定transport分类，不含Key/原exception |
| [网关基线](../.diagnostics/review-custom-provider-round10-20261022/gateway-probes.log) | 20/20 | 零/负/紧预算、私有任务真实剩余、慢明细保底、包装Response、malformed JSON固定分类、404汇总与立即能力记忆均保持 |
| [原生HTTP](../.diagnostics/review-custom-provider-round10-20261022/gateway-real-http.log) | 通过 | 随机回环、原生fetch/分块正文、42积分/1明细、成功signal不abort；服务已关闭 |

35项边界/正控制全过，另原生HTTP正例通过。保留此前校准口径：不强求外部凭据库120ms内可中断；可选明细取消后保留已成功合计，不另作失败。没有再增加取消要求。

## 2. A有实质改善，但仍未关闭

### 2.1 原六条真实apply时序：5通过/1不符

[脚本](../.diagnostics/review-custom-provider-round10-20261022/host-probes.mjs)实际复制上轮正确期望矩阵，仅改本轮汇总名，未改变验收条件。[日志](../.diagnostics/review-custom-provider-round10-20261022/host-probes.log)：

1. 串行A→B第一新B9000立即进入context：通过。
2. B缓存预热→挂起旧A HTTP→工具B命中缓存→旧A返回：通过，无旧A收尾。
3. 新B真正提交后旧A HTTP返回：通过，保持9000。
4. 旧GUI A凭据挂起→工具B9000→释放旧凭据：context保持9000，已转通过。
5. 旧GUI A凭据挂起→GUI B9000→释放旧凭据：不再清掉B，已转通过。
6. **旧工具A identify凭据挂起→新GUI B提交9000→释放旧A：仍返回1并把context改成closing。**

唯一原不符见[日志8–9行](../.diagnostics/review-custom-provider-round10-20261022/host-probes.log#L8-L9)。仍是同一provider/origin/引用、Key A=1/B=9000的合成条件，由Promise门闩控制，无sleep碰运气。当前Key已B，不是当前真的只剩1。

### 2.2 P1根因已定位：过滤了票据，没有过滤实际派发集合

[collect构造allowedCustom](../index.js#L1648-L1678)先把所有请求且启用的custom id放入Set；staleSnapshot(id)为真时只在签票循环continue，但**没有从allowedCustom删除该id**。之后仍把完整allowedCustom交给fetchCustomPlans的onlyIds，因此旧A确实被派发。

旧id没签票/没customOpSeqs，回调得到undefined；[isCurrentOp](../index.js#L282-L287)却把undefined/null当作允许，旧指纹回调绕过来源守卫。[发布兜底](../index.js#L548-L557)又为无票wire在完成时新签票，旧A于是重新进入当前观察。

新增beginOp、前置守卫及staleSnapshot方向正确，但三处宽松回退把它们串断了。源码静态存在continue不能证明“没派发”，这正是本轮仍失败的既有时序。

### 2.3 同根A的GUI出口仍未撤旧：context9000，返回JSON却1/ok

对**原来两条旧GUI凭据门闩**的同一返回值再核对，不增加新的并发场景：[脚本](../.diagnostics/review-custom-provider-round10-20261022/wire-consistency.mjs)、[日志](../.diagnostics/review-custom-provider-round10-20261022/wire-consistency.log)。

两条均观察到：当前B的context保持9000，但旧GUI响应JSON仍是balance1、effectiveStatus=ok、无error；旧凭据释放后还发了1次旧A HTTP。注册GUI JSON与当前有效事实不一致。这里只证明公开数据层，不冒称已挂载客户端完成像素显示验证。

原因是旧GUI回调虽然不再改观察器，却没有阻止通用取数继续；完成后的旧成功wire仍进入响应。[attachEffectiveStatus](../index.js#L635-L675)主要覆盖“有错误”的wire或失败/缓存状态，没剥除被观察器拒绝的旧成功数值，反而给它附上当前B的ok状态。

这一出口补充了此前仅检context的不足，仍归同一个A，不拆成新功能或新的独立根因。自定义/共享状态的既有目标就是GUI、工具、context同源事实。

## 3. 剩余最小整改范围：只补齐A，不推翻B/C

1. **派发集合必须实际缩小。**用通过staleSnapshot且已绑定有效票据/操作序号的id构造最终dispatchIds；为空时不调用fetchCustomPlans。不能只continue签票循环，最后仍传原集合。
2. **缺失归属不得替过时操作开后门。**对已有opSeqs的生产协议，缺票/缺opSeq不得默认current；已认定stale的wire不得走“完成时补票”重新发布。兼容入口也不能绕过当前协议。
3. **GUI过时结果同时撤销公开数值。**只拒绝写观察器不够；过时操作应尽量在新I/O前停止，迟到响应不能保留可呈现的旧1并附当前ok。可返回明确废弃且无旧数值，或由当前有效观察构建同源DTO；若回填当前值，来源身份/gen/采样时间也必须一致，不能把B数值套进A身份。
4. **直接保留本轮完整门闩作回归。**尤其旧tool identify这条必须转通过；原两条GUI结果同时核对context与返回wire。无需重造测试、不再只看源码里有guard字样。

以上都是冻结A“过时操作不激活/不派发/不回填”与GUI/工具/context一致性的收尾，不增加新供应商、UI、策略功能或业务口径。

## 4. 全链矩阵与正式回归

[此前22项收口链矩阵本轮全部通过](../.diagnostics/review-custom-provider-round10-20261022/chain-matrix.log)：输入与来源拒绝、零/负/缺失数值、通用错误/大小/跳转、模型白名单、点名范围、同Key迟到、共享取消、删除撤值，以及之前4个网关异常不符本轮均转通过。没有为了最后1例否认这些已稳定能力。

53脚本串行：50普通组1630＋行尾72＋几何144＋契约7＝**1853项，全部exit0、0跳过**。[退出清单](../.diagnostics/review-custom-provider-round10-20261022/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round10-20261022/regression/counts.json)。这些与独立矩阵有覆盖重叠，不重复相加成更大的总成绩。

包27文件逐payload与工作区匹配，mismatch=0，SHA1 `466b9d69c33e9d2d8190e7240a31856b5387b850`。[包核验](../.diagnostics/review-custom-provider-round10-20261022/package-audit.json)。客户端与通用自定义模块字节未变，未重跑完整86独立UI，也未声称新包真实Host最终提示词已验收。

## 5. 结论

**B、C在受测范围关闭；现在仅剩A这个根因阻断收口，仍含P1旧工具误收尾，不能宣布全部通过。**A已从原六例3不符进到1不符，不能把本轮说成毫无进展；但过时派发与GUI旧成功wire还需一起收尾。

下一包保留当前已通过B/C和正常路径，只改A的实际派发过滤、归属缺失拒绝、旧GUI结果撤销。用现成六时序、同源wire检查和同包回归一次验收，不扩大功能。额度策略仍是核心已构建而整体未安全验收；等A关闭后再单独完成已列明的真实context验收，不把策略UI等继续绑在自定义主线上。
