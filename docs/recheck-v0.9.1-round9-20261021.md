# 0.9.1第九轮复核：按冻结的A/B/C根因清单验收

> 对象：SHA256 `B5A79B2B5FBED8302D4EC6FC2FAB244DB7B5B2FDBBD6D4D7D0E1AA06ED96E62E`，229455字节/27文件。对照[整改§22](quota-policy-build-v0.9.0.md#L1467-L1537)与[冻结收口报告](closure-audit-custom-and-quota-20261021.md)。
> 不增加新功能、不重做UI、不扩大到策略UI/真实池/窗口/Android。只验证操作归属、父取消、公开异常DTO及已有正常路径。使用真实生产apply代码和合成配置/凭据/传输，不读真实Key/profile，不主动调用用户网关，不改产品/正式测试/安装副本，不部署/重启/提交/发布。

## 1. 上轮原反例已转通过的部分

[本轮Host矩阵](../.diagnostics/review-custom-provider-round9-20261021/host-probes.mjs)按**正确期望**执行，不再assert缺陷存在来制造exit0：

| 场景 | 结果 |
| --- | --- |
| GUI已知A→B，首个新B=9000立即进context | 通过，保持normal |
| B工具缓存预热→旧GUI A的HTTP挂起→当前工具B命中缓存→释放旧A | 通过，旧A没有进入context，安全撤旧；可暂无数据而非错误收尾 |
| 不预热缓存，新B真正HTTP/提交后旧A返回 | 通过，保持9000/normal |

见[日志1–3行](../.diagnostics/review-custom-provider-round9-20261021/host-probes.log#L1-L3)。因此不能说本轮R8-01完全没修，最窄的旧HTTP反例已经正确改善。

## 2. 根因A仍未关闭 / P1：迟到凭据可重新激活旧源

这不是新增要求。[冻结清单第1条及根因A](closure-audit-custom-and-quota-20261021.md)已明确“旧凭据解析迟到也不得重新激活旧源”“操作入场覆盖前置I/O”。本轮仍只处理了票据对象提升，没有完整处理采样事实本身的新旧归属。

### 2.1 两个可控误收尾反例，同一个根因

| 已开始但挂起的旧操作 | 更晚完成的当前B操作 | 释放旧A凭据后的结果 |
| --- | --- | --- |
| GUI A的credentials.resolve，尚未发HTTP | 工具B真的发HTTP并提交9000/normal | 旧A随后仍发HTTP，context变1/closing |
| 工具A的identify凭据解析 | GUI B提交9000/normal | 旧工具A随后返回1，context变1/closing |

第一例见[日志4–5行](../.diagnostics/review-custom-provider-round9-20261021/host-probes.log#L4-L5)，第二例见[日志8–9行](../.diagnostics/review-custom-provider-round9-20261021/host-probes.log#L8-L9)。均在同一provider/origin/引用下用合成Key A=1、B=9000，并由Promise门闩确定先后。当前凭据已是B，不依赖sleep、真实余额或外部网关假设。

另一个对照：旧GUI凭据迟到、更晚也是GUI B时，不会写旧1，但会把已成功的9000清成暂无数据。[日志6–7行](../.diagnostics/review-custom-provider-round9-20261021/host-probes.log#L6-L7)。这是同一缺失归属检查的较轻表现，不另拆新缺陷。

主线6例最终**3通过/3不符**，exit1来自完整验收汇总，没有脚本异常。不是3个独立bug。

### 2.2 为什么传了ownTicket还会错

1. [采样回调](../index.js#L319-L360)无条件先set sampledCredentials，接着推进epoch、清除当前投影；只在“提升票”时检查对象归属。因此旧凭据回调即使不能提升票，仍可清掉新的B事实。
2. [GUI签票](../index.js#L908-L920)登记pendingTickets；[工具collect签票](../index.js#L1597-L1609)只登记本地customTickets，未更新这张全局pending表。于是较新的B工具已提交后，pending表仍可能指向旧GUI A；迟到A携带自己的票，错误满足promoteOwnTicket的“当前票”检查。
3. 工具identify本身的异步凭据解析没有同样的入场操作归属；旧identify回来才[更新来源](../index.js#L1396-L1404)、再签取数票，较旧操作反而得到较晚序号。冻结“本次发送的A”只保证身份与发送一致，不证明它仍是当前有效来源。

[提升纯函数](../plans/quota-observer.js#L433-L438)的对象相等检查本身能通过独立测试，但不能证明调用方的pending表准确，也不能证明已经更改的全局来源状态合法。现有新增测试主要验证纯观察器/提升函数，仍缺真实apply贯穿identify/GUI/collect的交错。

### 2.3 最小修复边界：不要只补一次Map.set

所有入口在前置异步I/O前带操作归属/起始顺序；在**任何源状态更改之前**验证它是否仍可确认当前来源。过时resolve不能写指纹、推进epoch、删除B、授权票或继续为旧源派发。

GUI、工具identify、工具collect必须使用同一来源激活协议。identify没有取数票不等于它没有操作归属。仅给工具补pendingTickets.set，最多挡住旧GUI票提升，挡不住旧回调先清B和旧工具identify晚签票。

保持本轮已过的串行新B首样本、原旧HTTP反例、成功缓存和新结果序号拒旧；不允许通过关闭缓存、再查余额、完成时重签新序号或放宽epoch来过关。

## 3. 根因B/C与网关正常路径

### 3.1 B的明确改善

[网关基线20项全过](../.diagnostics/review-custom-provider-round9-20261021/gateway-probes.log)：预取消零凭据/零HTTP，0/负/紧预算、凭据迟到零新HTTP、私有任务实际剩余预算均通过；慢明细约2530ms交付42，包装Response、malformed JSON三出口固定分类和404合计/汇总/立即能力记忆也保持。

[取消专项](../.diagnostics/review-custom-provider-round9-20261021/cancellation-probes.log)另确认：预取消返回cancelled/C、连接中取消转发子signal并返回C、一个共享消费者取消不杀另一个活消费者，均通过。父信号不再完全被忽略，本轮确有实质改善。

### 3.2 根因B仍有P2：主状态正文取消被当成T

已有冻结清单第5条要求正文中取消也正确处理，不计T失败。

专项在/status已经收到响应头、正在消费原生Response正文时取消父signal：子signal确已abort、原生bodyUsed=true，**最终wire.error却为exec，生产classifyFailure返回T，而非C**。见[日志4行](../.diagnostics/review-custom-provider-round9-20261021/cancellation-probes.log#L4)。不是只用不遵守signal的transport假造。

[正文读取catch](../plans/workbuddy.js#L711-L731)把response.text()的AbortError塞入parseError后正常返回，因而绕过fetchFromGateway的catch取消分支，随后进入invalid-json分类。父信号转发了，不代表最终业务分类已贯穿。

修复应让主正文取消保留C语义：读取正文异常若是父取消就抛/返回结构化取消，或在await got后先检查父取消，再决定解析错误。不要把取消当一次坏JSON计数。此处证明的是provider错误分类，不夸大成所有真实工具取消都会污染观察器；上层deadline丢弃可能挡住部分发布，但不能替代provider合同。

专项其它两个观察不单独增加阻断：凭据等待取消后120ms没有立即settle，但释放后返回C、零HTTP，不能据此称无限卡死或要求外部凭据库必须可中断；可用取消race及时结算。可选packages正文取消后保留已完成的/status合计42、不计T，可作为保留主数据的明确设计，不强制丢掉合计才能过审。

原统一C的两条严格期望已由审查方校准，不改产品，保留strict脚本/日志；[最终验收5通过/1不符](../.diagnostics/review-custom-provider-round9-20261021/cancellation-probes-final.log)，唯一硬残留是主状态正文取消被判T。严格版到最终版的变化是**测试口径校准，不是产品又修了一轮**。

### 3.3 根因C仍P2：公开exception出口本轮未收紧

这不是本轮新增发现。[上一份收口报告根因C](closure-audit-custom-and-quota-20261021.md)已给出transport异常与原生Headers校验的Key回显；整改§22主要只描述R8两个编号，交付前grep parseError/preview不能代替处理完整C清单。

[异常专项](../.diagnostics/review-custom-provider-round9-20261021/public-errors.log)包含原生Headers控制与两类故障，每类都经过provider wire、listAccounts、真实apply注册GUI和账号路由：**1控制通过、8不符**，8项归同一根因，不是8个新问题。

[账号catch](../plans/workbuddy.js#L773-L774)与[主wire catch](../plans/workbuddy.js#L918-L924)仍把err.message拼入公开message。合成已存Key带换行时，Node原生Headers错误会自然包含输入，再经公开JSON回显。data:校验无真实供应商网络，未读取真实用户Key。正常Key一般不触发，也不能因此允许secret在非法配置时回显。

继续沿用已给出的最小出口：所有公开异常DTO固定分类/安全诊断码，不透传exception原文；可另做非法头字符校验，但不能只删换行或只清JSON parser来替代完整脱敏。

### 3.4 原生HTTP正控制

[真实随机回环HTTP](../.diagnostics/review-custom-provider-round9-20261021/gateway-real-http.log)仍得到42积分、1条明细，原生fetch/分块正文/成功signal不abort均通过；finally已关闭服务。新网关不提供packages的404仍是上游能力缺失，不要求补明细接口或恢复国际渠道。

## 4. 包与正式回归

52脚本串行：49普通组1614＋行尾71＋几何144＋契约7＝**1836项，全部exit0、0跳过**。[逐组退出](../.diagnostics/review-custom-provider-round9-20261021/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round9-20261021/regression/counts.json)。

包27文件逐payload与工作区匹配，mismatch=0，SHA1 `0e8295fc0b7f038efda21e90c25ff99f4f290219`。[包核验](../.diagnostics/review-custom-provider-round9-20261021/package-audit.json)。客户端SHA仍为 `40a669b0b30012f3d79316299821b911e2256aa2f5a97d0b680c82ff7106ef02`，通用自定义取数模块也与上一包相同；没有重复宣称本轮又跑了全部86独立UI。

正式回归全绿与真实apply验收反例不矛盾：纯函数局部合同可通过，但调用链归属仍错。当前额度策略完成度沿用上次“核心已实现、整体未安全验收”，本轮不增加策略功能；根因A仍可驱动错误收尾，不能宣布自动策略安全完成。

## 5. 最终收口结论：仍是原A/B/C，没有新增功能要求

**本轮尚不通过。** 原最窄的R8-01和预取消反例已通过，但冻结清单尚未完整兑现：

| 原根因 | 已改善 | 本轮仍阻断 |
| --- | --- | --- |
| A / P1 操作归属 | 自己的票据不再被无票identify随意提升；串行与旧HTTP原例通过 | 旧凭据回调可先改全局源；pending表不覆盖工具；旧identify晚签票，仍可能误收尾 |
| B / P2 父取消 | 入口零I/O、连接中signal传播及共享消费者隔离通过 | 主状态正文取消被吞成invalid-json并分类T，不符合C不计失败 |
| C / P2 公开异常 | malformed JSON三出口继续固定分类 | transport/native Headers的err.message仍经真实公开路由回显合成Key，此块未处理 |

下一份包应按[冻结报告的完整十条](closure-audit-custom-and-quota-20261021.md#L112-L125)验收，而不是只补旧报告R8-01/R8-02两个编号。本轮已经提供所有对应正确期望反例：Host六种顺序、取消阶段、公开exception四出口、正常/预算/404正控制。

保留改进，不重写UI、不关闭成功缓存、不重复余额请求、不加长8秒、不开放原文调试；改完在同一最终哈希下一次跑完整矩阵。未排期的策略UI、窗口/计费池证明与Android仍不新增为本次阻断。所有改动范围继续限于A/B/C共享基础设施。
