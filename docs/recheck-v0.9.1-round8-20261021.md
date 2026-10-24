# 0.9.1第八轮复核：串行换Key空窗改善，但最新票据提升复活旧请求

> 受审包SHA256 `b87f36f61973d29f20b98648f7900d2a99effeca2ec645daa00e08864a813e3c`，228320字节/27文件。对照[第七轮报告](recheck-v0.9.1-round7-20261021.md)和[本次整改§21](quota-policy-build-v0.9.0.md#L1386-L1465)。
> **已确证一项P1回归：当前工具已确认B并返回9000，迟到旧GUI A仍把context改成1/closing。**不是新的功能需求，而是R7-01“既接受本次新采样、又拒绝迟到旧结果”的另一半失守。
> 本轮只审核，使用合成配置/Key/传输，不访问用户新网关、真实Key/profile，不改产品/正式测试/安装副本，不部署/重启/提交/发布。

## 1. 原问题串行正例已改善

[真实apply主探针](../.diagnostics/review-custom-provider-round8-20261021/host-probes.mjs)验证：已知GUI A=1后换B，第一次B采样9000即可进入context/normal，无需再等一轮。见[日志1行](../.diagnostics/review-custom-provider-round8-20261021/host-probes.log#L1)。同Key工具成功→GUI401→工具恢复仍会真实重试1次，见[日志5行](../.diagnostics/review-custom-provider-round8-20261021/host-probes.log#L5)。这些改善保留，不要求回退。

自动context反例显式开启策略并配置合法阈值/绑定/信任，默认关闭时不主动生成收尾规则。本报告不声称用户当前真实配置已发生误收尾。

## 2. R8-01 / P1：工具identify/缓存命中升级了旧GUI票据

### 2.1 可控、无时间猜测的复现顺序

同一真实apply实例、同一provider/origin/凭据引用，Key值决定合成余额A=1、B=9000：

| 步骤 | 行为 | 已取得事实 |
| --- | --- | --- |
| 1 | 工具用B成功一次 | B=9000写入30秒成功缓存，context正常9000 |
| 2 | GUI读A并发起HTTP，暂时挂起响应 | A的GUI票据成为latestTicketOf，网络请求确属旧A |
| 3 | 当前凭据回B，工具identify确认B | 工具命中已有B缓存，返回9000，**零新HTTP/没有新的取数票据** |
| 4 | 释放之前挂起的旧A响应1 | context竟提交A=1，并出现closing/收尾规则 |

[日志2–3行](../.diagnostics/review-custom-provider-round8-20261021/host-probes.log#L2-L3)记录了当前B工具9000与随后旧A使模型收尾的对照。传输以Promise门闩控制先后，无sleep碰运气，没有真实账号或网络假设。

**正控制：**新实例不预热B工具缓存，同样挂起A，再让B真正发HTTP并提交9000；旧A返回后仍9000且无收尾。[日志4行](../.diagnostics/review-custom-provider-round8-20261021/host-probes.log#L4)。说明已有提交序号保护仍能工作，失败点集中在缓存命中没有新票时的错误epoch授权。

### 2.2 根因

[recordSampledCredential](../index.js#L345-L360)推进激活epoch后，无条件读取latestTicketOf.get(id)，直接改其epoch；但它不知道这张票属于哪个采样操作。

[工具identify](../index.js#L1399-L1408)在判定缓存前也调用该回调，**这次B采样不属于那张旧GUI A票**。所谓“最新一张”只是全局最近签发，不等于本次采样的票。缓存命中又不会创建更新的B取数票，于是A被人为升级到B代次，原epoch拒绝逻辑被绕过。公共来源身份不包含同引用下实际Key，旧A改epoch后能通过身份检查。

[观察器epoch校验](../plans/quota-observer.js#L221-L234)本身没有消失；是外部改写票据让它满足了校验。因此“没有在提交时重签、仅提升一张”并不构成安全证明。

### 2.3 最小修复出口与回归

- 采样回调携带**本次操作token/票据归属**，绑定本次冻结来源和激活代次，保留操作入场序号；不得按渠道id查任意全局最新票授权。
- 工具identify/缓存命中没有对应取数票时，只能登记当前来源并撤旧，不能提升其它请求的旧票。
- 迟到的凭据解析也不能回滚当前激活来源；不能让旧操作靠完成顺序取得新的序号或权限。
- 保留串行A→B第一样本可提交、同Key失败门控、真正更新的B提交后拒旧A等已通过行为。
- 必须加入本例“B缓存预热→挂起A→identify B缓存命中→释放旧A”的真实apply回归；不能用禁用所有成功缓存、再查一次余额或放宽epoch校验绕过。

[正式R7-01源码断言](../tools/test-workbuddy-round7.mjs#L166-L177)只检查latestTicketOf/epoch赋值存在及“不循环提升全部”。它证明不了那张票归属本次采样，反而把危险实现写成绿灯契约。应以行为回归替换这部分静态形状断言，正确实现不必保留pending.epoch = nextEpoch字样。

## 3. 账号错误脱敏、截止预算与新网关404

### 3.1 转通过的路径

[独立协议日志](../.diagnostics/review-custom-provider-round8-20261021/gateway-probes.log)共19项通过、1项不符，真实apply/工具/已注册账号路由均纳入，不只比较字符串：

| 原问题/正控制 | 本轮结果 |
| --- | --- |
| R7-02错误回显 | 主wire、listWorkbuddyAccounts、真实账号设置路由均仅HTTP200＋固定invalid-json分类；哨兵前缀及parser原文不再出，受测出口可关闭 |
| 0/负剩余 | 零凭据解析、零HTTP，均通过 |
| 短状态预算 | 30ms慢status之后不再启动packages；本例未得到合计，不把它算作已成功合计 |
| 凭据迟到 | 延迟后观察110ms仍零HTTP，通过，不声明等待无限长 |
| 紧预算合计 | 160ms预算约124ms交付42，通过 |
| 私有任务重获8秒 | 真实apply identify耗约668ms后provider得到7333ms，匹配调用者真实7332ms，不再重新获得整份8秒 |
| 慢明细保底 | 约2523ms返回合计42，状态只取一次，明细超时已abort |
| 包装Response | 只有status200/text，没有ok/json，状态、积分包及账号列表均保持成功 |
| 原生HTTP | 隔离随机回环端口、原生fetch、分块正文正常42＋1条明细；成功signal不abort，服务已关闭 |

见[原生HTTP及关闭日志](../.diagnostics/review-custom-provider-round8-20261021/gateway-real-http.log)。以上多数既有边界已真正改善，不能因仍有取消残留一概说预算修复没做。

### 3.2 R8-02 / P2：外部已取消但remaining仍为正时仍然发HTTP

[协议日志13行](../.diagnostics/review-custom-provider-round8-20261021/gateway-probes.log#L13)：直接调用生产provider，传入**已经aborted的调用者signal**，remaining仍5000；仍向/status和packages各发一次携带合成Bearer的HTTP。这是既有R7-03的取消守卫残留，不是新增需求。

[fetchFromGateway](../plans/workbuddy.js#L833-L869)只看remaining，未消费options.signal；[fetchJsonWithTimeout](../plans/workbuddy.js#L641-L668)自建controller而不组合父signal。剩余时间正常不意味着请求仍获调用者授权。

本例定位到provider接线：真实apply已经证明signal确实传入，不声称工具execute的入口取消守卫完全不存在，也不把向既定网关的取消后请求夸大成向未知目标泄漏。

修复应在入口、凭据返回和新HTTP启动前检查父signal，并把父取消传入在途连接/正文；取消归C、不计T失败、不错误影响其它仍在等待的共享消费者。不能只丢弃结果而让已取消操作继续发请求。保留已通过的截止归零、2.5秒明细保底、完整预算与原生HTTP成功路径。

### 3.3 用户新网关的404不是插件缺陷

[协议日志21–22行](../.diagnostics/review-custom-provider-round8-20261021/gateway-probes.log#L21-L22)确认：packages404仍交付合计42、退回按账号汇总一行；同origin立即再查时仅请求/status，工具仍ok42。能力记忆不缓存积分数字，不把这一适配扩写成降低全渠道余额轮询频率。

本轮没有模拟等待10分钟或验证之后重新探测的时钟分支，不把源码常量等同到期恢复已经实测。不要求反代必须提供真实积分包，也不要求恢复已退场的国际渠道。

## 4. 包与回归

51脚本串行：48普通组1603＋行尾70＋几何144＋契约7＝**1824项，全部exit0、0跳过**。[逐组退出](../.diagnostics/review-custom-provider-round8-20261021/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round8-20261021/regression/counts.json)。

包27文件逐payload与工作区匹配，mismatch=0，SHA1 `145e740fab6d5d1203eade2e09dbf25c84d400f4`。[包核验](../.diagnostics/review-custom-provider-round8-20261021/package-audit.json)。本轮客户端SHA仍与R6/R7相同 `40a669b0b30012f3d79316299821b911e2256aa2f5a97d0b680c82ff7106ef02`，未重跑完整86项独立UI，保留此前限定通过结论。

主线Host脚本exit0是“正常串行修复＋P1反例存在＋有/无缓存正控制”都符合探针断言，不代表产品通过。本轮未重新核验已装副本或运行bundle的字节身份，也不因用户此前正常截图否认其基础运行证据。

协议[独立摘要](../.diagnostics/review-custom-provider-round8-20261021/gateway-summary.md)及原生HTTP证据已收齐：主协议19通过/1不符，exit1只因取消断言未满足，无脚本异常；native HTTP exit0并确认server关闭。只复用一个子代理，全部后台作业已收集，无遗留测试服务。

## 5. 最终结论与下一轮最小范围

**尚不通过：一项P1并发回归＋一项P2取消残留。**不是要求新增功能，也不是否定本轮大量正例转绿。

1. **优先修R8-01票据归属。**本次串行空窗修复不能以复活旧请求为代价；将缓存命中交错的确定性反例加入真实apply测试，和串行换Key、无缓存新B提交拒旧A共同守门。不要为了静态正则测试通过而继续保留无归属的全局票据升级。
2. **修R8-02父signal贯穿。**取消前置零I/O与在途传输取消都应明确；保持普通截止预算、私有任务夹取、共享消费者隔离及成功正文不abort。
3. **保留本轮通过项。**账号路由固定错误分类、零/负deadline、紧预算合计、慢明细保底、Response兼容、404汇总与能力记忆不需推翻；客户端未变的UI也不需重做。

真实计费池/窗口口径、策略UI、真实提示词注入与重试、Android真机仍是独立待验范围，不借本轮增加新阻断。此前用户正常使用和重启截图是基础运行证据，不能作为这些特定并发/取消条件已经验收的证明。
