# 0.9.1第七轮复核：原高风险用例转通过，仍有三项P2边界残留

> 对象：本地包SHA256 `dd84a00133b9dbb4f02e5936af51c86ce8f2c47c4b9e6db3ace94012e4b68cd2`，226595字节/27文件。对照[第六轮报告](recheck-v0.9.1-round6-20261021.md)与[整改记录§20](quota-policy-build-v0.9.0.md#L1288-L1384)。
> 用户已明确重启DSH，截图WorkBuddy ✦5749；基础加载与积分显示应记为**用户侧运行验证已有证据**，不再笼统写“真实DSH完全未验收”。长时稳定、真实源/账号切换、自动注入/重试仍分开验收。
> 本轮只审核，不修改产品、正式测试、已装副本或真实配置；未读取真实Key、未主动访问用户网关、未部署/重启/提交/发布。一个复用子代理负责预算/脱敏/包装Response，主线负责身份与票据。

## 1. 已确认的改善

- 自定义GUI**第一次**成功采样即可进入context，不再冷启动自废票据。
- 同Key的工具/GUI不会互相清状态；工具成功→GUI同Key401→工具再调，会**真实重试1次**而非旧ok缓存，成功后正常恢复。
- 纯工具A/B/A实际值9000/1/9000，前两次新成功都进入context；回A缓存不再残留B的收尾。
- WorkBuddy切换选中账号后，旧积分/收尾立即撤销；新9000采样正常进入context。更换模型主机/删除有效provider也撤销旧观察，不再沿用旧9000。

见[本轮真实apply探针](../.diagnostics/review-custom-provider-round7-20261021/host-probes.mjs)与[日志](../.diagnostics/review-custom-provider-round7-20261021/host-probes.log)。自动context测试显式启用策略、合法阈值/绑定/信任；默认策略关闭时不主动生成收尾规则，不把合成开启条件说成用户当前已触发。

客户端SHA256仍为 `40a669b0b30012f3d79316299821b911e2256aa2f5a97d0b680c82ff7106ef02`，与第六轮逐字节相同。前轮86项独立UI通过结论保留；本轮不重复宣称又跑了一遍全部86项。新的50组正式回归仍覆盖现有UI测试。

## 2. R7-01 / P2：已知Key A→B的GUI采样仍自废本次合法票据

R6-01的同Key指纹与首次采样问题已实质改善，但**首次不知道→知道**与**已经A→新B**是两条路径，后者仍丢结果。

真实apply同一实例：第一次GUI用A得到9000，context正常9000；随后同引用值换B，本次GUI已真实取得1，但context只剩暂无数据；再来一次相同B的GUI才进入1/收尾。[日志5–6行](../.diagnostics/review-custom-provider-round7-20261021/host-probes.log#L5-L6)。这是安全撤旧后的新样本空窗，不再归为旧积分误收尾的P1。

[采集前签票](../index.js#L889-L898)捕获旧epoch；采样发现已知凭据变化后，[回调](../index.js#L308-L340)推进epoch，本次返回的B也被自己的旧票拒绝。新增prev===undefined早退只解决冷启动。

修复时保留操作入场序号，冻结来源与本次激活/票据关联；既要接纳合法新B，又不能完成时随意重签票、复活迟到旧A。不要通过重复请求余额，或放宽epoch检查来掩盖。

## 3. 网关预算、脱敏与兼容复核

### 3.1 已转通过的主要路径

[独立协议日志](../.diagnostics/review-custom-provider-round7-20261021/gateway-probes.log)包含真实apply、工具与已注册账号路由，不只测纯辅助函数：

| 项目 | 本轮结果 |
| --- | --- |
| 原慢明细例 | packages挂住后约2524ms工具仍返回ok、balance42，状态仅取1次，明细请求超时后已abort |
| 预算入口接线 | provider确实收到remaining函数与signal，不再是只改了函数签名却未传参 |
| R6-05包装Response | 只有status200/text而无ok/json，状态合计42、积分包明细、账号列表三条路径均成功，可关闭该兼容残留 |
| R6-04主wire | fetchFromGateway只返回固定invalid-json分类，不再回正文/解析器原文；此公开出口已修好 |
| 原生HTTP与正文 | 随机回环夹具、原生fetch、分块正文取得42积分及1条明细，成功signal未abort；连接与server已关闭 |

上述不是说全部截止边界通过。协议脚本最终9项通过、6项不符，后6项归下列两组残留，不算6个独立问题。

### 3.2 R7-02 / P2：账号列表及设置路由仍回显解析器原文

[账号列表解析](../plans/workbuddy.js#L735-L741)仍把got.parseError.message拼入message；JSON.parse原始message会带正文片段。因此R6-04只改了主取数wire，漏掉另一个公开出口。

同一合成malformed响应以SYNTHETIC_KEY开头：主wire固定分类通过，但listWorkbuddyAccounts和真实apply注册的/api/plan-usage/workbuddy-accounts都返回：

```text
账号响应无法解析（Unexpected token 'S', "SYNTHETIC_"... is not valid JSON）
```

见[协议日志9–12行](../.diagnostics/review-custom-provider-round7-20261021/gateway-probes.log#L9-L12)。这是**上游片段仍可回显到GUI**的路径证据；哨兵前缀被解析器截断，不夸大成已发现完整真实Key泄露。本轮未读取用户Key，也未访问真实网关。

修复应覆盖主wire、账号列表及注册路由所有公开错误DTO，统一固定分类；原始parser.message和任意上游片段都不要出。不要仅删preview、也不要为调试再打开原文。

### 3.3 R7-03 / P2：预算改善常见慢明细，但耗尽后仍发HTTP且私有任务重新得到8秒

[capTimeout](../plans/workbuddy.js#L820-L840)把超时下限设为300ms，已经过期的remaining也会被放大；进入/status和packages前没有耗尽守卫。

确定的离线反例见[协议日志13–17行](../.diagnostics/review-custom-provider-round7-20261021/gateway-probes.log#L13-L17)：

- remaining从入口就是0，仍携带合成网关Authorization发/status及packages各1次。
- 30ms预算中/status延迟70ms成功，packages仍在剩余-40ms启动。
- 凭据解析耗93ms后，/status和packages仍在剩余-63ms发出；所以并不是把凭据await包一个race就覆盖了截止。
- 真实apply工具已有共同identify耗时约667ms，当前调用者只余7333ms，但provider拿到约7997ms。[taskFor重新创建整份任务预算](../plans/usage-tool-register.js#L277-L303)，私有WorkBuddy任务也走这条路径。它没有其它共享消费者，不应借“共享任务独立寿命”放大本次已耗预算。

此组是R6-03“全流程同一剩余预算”尚未完成，不否定2.5秒明细保底交付的改善。

修复出口：传递从execute入口算起的绝对deadline；凭据返回后、每次新HTTP前检查耗尽/外部取消。剩余不足时跳过可选明细并交付已知合计，而不是强行再给300ms。私有任务不重新获得完整8秒；共享任务的独立生命周期可以保留，但不能混成当前调用者的剩余授权期限。保持固定8秒工具契约，不以加长超时掩盖。

## 4. 包与正式回归

50脚本串行，47普通组1587＋行尾69＋几何144＋契约7＝**1807项，全部exit0、0跳过**。[逐组清单](../.diagnostics/review-custom-provider-round7-20261021/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round7-20261021/regression/counts.json)。

包27文件逐payload匹配工作区，mismatch=0，SHA1 `aa110b2e3113fbc0730d8adb9ae86ea1b6ad4bdb`。[包核验](../.diagnostics/review-custom-provider-round7-20261021/package-audit.json)。仅核包与工作区，不借执行方安装记录冒称我方读取了真实配置或独立确认运行bundle哈希。

## 5. 验证边界

账号空选择=全部、冷却账号计入合计、明细与状态口径可能有差额，沿用前轮已说明的设计；不擅自修改契约。不要求恢复已退场的workbuddy-ai。不把真实计费池、窗口口径、策略UI、真实提示词注入/重试、Android真机等独立待验项混成此次五项修复的新缺陷。

[协议独立摘要](../.diagnostics/review-custom-provider-round7-20261021/gateway-summary.md)与[原生HTTP关闭日志](../.diagnostics/review-custom-provider-round7-20261021/gateway-real-http.log)已收齐。主协议探针exit1是完整18行输出后的6个验收不符，非脚本异常；原生HTTP脚本exit0。主线身份探针exit0包含“已知换Key仍丢新样本”的缺陷存在断言，不能当成产品全部通过。子任务后来出现框架失败通知；本报告依据已经落盘且由主线读回的完整脚本/日志，不把任务状态通知当成产品结论。

中断后于2026-10-21 16:23续审，再次确认包SHA及客户端SHA、源码修改时间未变化；没有重新启动已完成的50脚本回归，也没有据此冒称再次跑了86项UI。

## 6. 最终结论与最小整改范围

**本轮未复现上一轮两个P1原例，主要风险已经收敛；仍有三项P2，尚不建议按“本轮全部修复通过”收口。**

| 剩余项 | 要修的最小范围 | 不应倒退的已通过部分 |
| --- | --- | --- |
| R7-01 | 已知Key切换时，让本次新采样与入场票据/激活代次正确关联 | 同Key统一指纹、冷启动首采样、旧值撤销及迟到结果拒绝 |
| R7-02 | 账号列表与账号设置路由错误统一固定分类，不拼parser原文 | 主wire已经脱敏，不重新开放正文调试回显 |
| R7-03 | 截止/取消前置守卫与入口绝对deadline，私有任务不重开完整8秒 | 明细2.5秒保底交付、合计优先和包装Response兼容 |

无需增加新功能或推翻已验证UI。用户重启后的基础显示正常可以确认；长时稳定和这些特定切换/故障边界须分别对待。产品、配置、安装副本、部署和发布均未由本审查改动。
