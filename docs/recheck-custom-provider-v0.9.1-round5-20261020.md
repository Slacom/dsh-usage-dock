# 自定义渠道第五轮复核：混排通过，但双卡编辑/删除串条目

> 对象：本地构建SHA256 `513fd981cc5d28f859d0442653ef857cef8c235cb7cfcfb51205b1c0f458d669`，213524字节。
> 用户已反馈自定义卡片排序可用；本轮仍独立复核[R4剩余项](recheck-custom-provider-v0.9.1-round4-20261020.md)，不以实测一个场景替代全部验收。账号诊断保持暂停，不部署、重启或发布。

## 1. 本轮用户新增界面要求（待实现，不倒算成旧缺陷）

1. **已有自定义卡片打开设置页时默认折叠/缩略**，呈现用户截图中的简短状态，而不是默认铺开全部编辑字段。首次进入及页面重建的初态均应如此。
2. **视觉尽量与内置渠道卡片一致**：名称/开关行、上下移按钮、字体、间距和对齐保持一致，避免两套明显割裂的卡片样式。可优先采用内置的简洁分隔与标题行规范，而非继续加重外框。
3. 折叠态保留名称、开关、排序/展开操作及必要简短摘要；点击展开后仍能完整编辑原有来源、余额路径、JSON键、币种等，不因样式统一删功能。
4. 用户在本次页面主动展开/收起后，普通重渲染、排序及刷新状态不应错误重置；按稳定条目id维护状态，不按当前数组位置串到其它卡片。点击“展开/收起”的提示和实际状态应一致。
5. 新增条目可为填写而主动展开该新条目，不应顺带展开所有已有条目。默认折叠不意味着停用条目，也不得改变凭据、余额配置或额外触发余额查询。

最低验收：首次打开已有卡片为折叠；展开/收起切换正常；折叠及展开两态均可跨内置排序；两条卡片的展开状态及编辑数据不串；保存/放弃/重新进入行为清楚，视觉与内置卡片在同一页面对照确认。

## 2. 独立复核结论（10月20日启动，21日收束）

**整体仍不通过：2项P1、1项P2，另有1项P3边界反馈。**第1节是用户本轮新增需求，尚待实现，不倒算成此前未修。

| 编号 | 级别 | 结论 |
| --- | --- | --- |
| R5-01 | P1，新回归 | 编辑/删除第二张自定义卡片，实际修改/删除第一条并成功保存 |
| R5-02 | P1，旧项未关闭 | 采样Key指纹变化只删元信息，旧数值投影还在；A/B/A仍旧1CNY收尾 |
| R5-03 | P2，旧项未关闭 | 永久失败钩子传进了工具聚合cache身份，而观察器使用另一套逐渠道身份；仍查不到失败记录 |
| R5-04 | P3，边界残留 | 内置首项上移的disabled被重复属性覆盖，按钮仍启用但无操作 |

已通过：三处全局混排、保存重开、单条跨内置移动、反向移动、其它项顺序保留、初次无草稿不丢id、放弃、自定义首尾及内置末项下移禁用。来源清空不复活、无覆盖正常继承、主机/引用变更作废、路径兼容和完整冻结继续通过。

用户实测排序正常与独立结果一致，不能再说卡片DOM仍固定分组。现在应保留这些修复，解决新回归，而非推翻混排方案。

## 3. R5-01 / P1：单条渲染使用了错误的完整列表下标

这是本轮最需要先修的数据破坏回归。只有一张自定义时不易察觉；两张及以上时，第二张及后面条目会误操作第一条。

[组件保留完整entries，再按onlyId生成renderEntries](../client.js#L2869-L2881)；[循环](../client.js#L2997-L2999)在单条模式下i恒为0，但[update](../client.js#L2898-L2912)仍用entries[index]更新完整数组。[remove](../client.js#L2981-L2985)也是同样问题，删除按钮在[3176行](../client.js#L3173-L3177)传入局部i。

真实SettingsPage→操作第二张B→保存，6种编辑均把第一条A改掉，B保持不变：名称、enabled、provider、balanceEndpoint、balancePath、currency。另点B卡片里的删除并保存，应剩A，实际剩B，A被误删。每例都有1次真实form.mutate记录；不是只看草稿或静态代码。扣减键也走同一update路径，但本轮未单独实测，不混进已证6字段。

证据：[ui-edit日志2–8行](../.diagnostics/review-custom-provider-round5-20261020/ui-edit-probes.log#L2-L8)。这7条失败来自同一个目标定位错误，不算7个独立问题，也不表示用户真实配置已发生误删。

**修复出口：所有修改/启停/删除均按稳定条目id定位最新完整草稿，不能把renderEntries下标当allEntries下标。**move已经修过这种错位，但update/remove没同步修。覆盖第二/第三条、重新排序后、折叠展开后、保存/放弃，保证其它条目不变且不丢失。修复前不建议在此版本编辑或删除第二条及之后的自定义项。

## 4. R5-02 / P1：登记了采样指纹，却没有撤掉旧数值投影

[recordSampledCredential](../index.js#L306-L321)确实把实际指纹登记并推进epoch，但只删除channelMeta，没有删除channelProjection/channelIdentity；同步context仍从[两个映射独立读取](../index.js#L728-L735)。结果：**元信息没了，旧的B数值还在**，视图仍可据此收尾，甚至不再显示原采样时间。

**FAIL_ALL_TOOL_KEY_ROTATION_STALE_PROJECTION**：同一引用值A/B/A，工具仍正确返回9000/1/9000、仅2次HTTP；第三次context仍是1CNY/closing。这就是上一轮原例，尚未关闭，不是新要求。首跑按修复后“不得包含旧1/收尾”的正确期望直接失败，见[原始失败日志](../.diagnostics/review-custom-provider-round5-20261020/host-probes-first-run.log)。

另有同一合同的跨入口验证 **FAIL_GUI_KEY_SAMPLE_NOT_REGISTERED_WITH_HOST**：工具A取得9000→GUI实际用B取得1→工具A命中9000缓存，context仍按GUI的B值1收尾。登记函数目前仅在[工具identify](../index.js#L1283-L1302)调用，GUI采样没有同步覆盖，因此不能认为“工具采样表”已经等于共享来源状态。

**修复出口：**完整撤销该源的数值、元信息、身份和在途状态，不能只删meta。已有[syncActivation完整清理路径](../index.js#L654-L684)可作为对照；统一工具与GUI的已知采样事实。保留采集前票据/epoch约束，不能为接通指纹临时给迟到结果重签新票。未知来源或元信息缺失时应暂无数据/normal，不允许旧projection绕过身份判断。同步context仍只读状态，不要求每步再解密凭据或请求供应商。

## 5. R5-03 / P2：参数数量改对了，身份语义仍不对

[工具缓存层](../plans/usage-tool-register.js#L365-L377)现在传deps.isSourceFailed(id, identity)，但这里identity来自[identifyChannels的parts聚合](../index.js#L1274-L1282)，最后[用分隔符join返回](../index.js#L1337-L1342)，是工具请求/缓存身份，可能包含多个渠道。

[Host观察身份](../index.js#L327-L405)则是另一个逐渠道16位摘要。新[钩子](../index.js#L1366-L1387)优先相信传入的非空字符串，直接拿工具cache身份去quotaObserver.read(id,key)，查不到Host摘要槽位；正确的identityOfChannel回退反而不会运行。

**FAIL_PERMANENT_GUI_FAILURE_TOOL_CACHE_STILL_OK**：工具先成功1→GUI401后context获取失败→立即调用工具仍旧ok/1、零新HTTP。原反例仍然存在。补传一个名叫identity的字符串，并不意味着它属于同一个身份域。

**修复出口：**明确区分toolBatchCacheIdentity与channelObservationIdentity。钩子必须读取当前源对应的Host观察身份，或通过受控桥接取得同一身份；不要直接透传不同编码/粒度的字符串，也不要用readAny跨源绕过。加真实GUI失败后调用工具的用例，不能仅测read(id,任意相同字符串)的辅助函数。

## 6. R5-04 / P3：内置首项上移被重复属性覆盖

[3852–3853行](../client.js#L3848-L3854)连续写了两次disabled；后面的!writable||saving覆盖前面包含!builtInCanUp的正确条件。因此内置首项仍启用、点击无操作。末项下移已通过。删除重复属性并保留真实全局边界条件即可，避免为这一小项重写排序算法。

## 7. 新界面要求的现状与验收边界

第1节已完整记录“风格与内置一致、默认折叠”。当前[useState({})](../client.js#L3365-L3382)配合collapsed[id]===true，首次进入及重新挂载仍默认展开；已有手动折叠、展开、排序后按id保持、保存后保持均通过。应在这个按id机制上改默认值并同步切换逻辑，不改回按数组位置保存。

[样式对照记录](../.diagnostics/review-custom-provider-round5-20261020/ui-edit-probes.log#L9-L15)显示自定义仍有整圈边框/圆角/背景，而内置为简洁上分隔线。此处只提供结构/样式现状，不以mock组件下像素或审美判断代替用户真机确认。不能为折叠默认把编辑字段或删除能力弄丢，也不能把默认折叠等同于停用渠道。

## 8. 回归、包与证据口径

- 包213524字节、27文件，逐payload匹配当前源码，mismatch=0；SHA1 `e129f43c1bbf18deed610ec0bfa886c6f794fb10`。[包核验](../.diagnostics/review-custom-provider-round5-20261020/package-audit.json)。跨夜后再次核对包哈希与源码修改时间，受审构建未变。
- 正式47脚本串行：44普通组**1489**＋行尾66＋几何144＋契约7＝**1706项，exit记录均0、0跳过**。[清单](../.diagnostics/review-custom-provider-round5-20261020/regression/summary.json)、[逐组计数](../.diagnostics/review-custom-provider-round5-20261020/regression/counts.json)。整改记录仍写1701，漏加本轮S6/S7新增5项，需更正统计。
- 原混排独立27项：**26通过、1失败**；仅内置首项禁用仍不符，其余原混排链路转通过。[排序脚本](../.diagnostics/review-custom-provider-round5-20261020/order-probes.mjs)、[日志](../.diagnostics/review-custom-provider-round5-20261020/order-probes.log)。
- 编辑独立检查：4项通过、7项目标不符，另2个“默认折叠”场景明确标为本轮新增需求未实现，不计旧缺陷。[编辑脚本](../.diagnostics/review-custom-provider-round5-20261020/ui-edit-probes.mjs)、[日志](../.diagnostics/review-custom-provider-round5-20261020/ui-edit-probes.log)。两份UI脚本exit1均为完整检查后的不符合预期，不是异常崩溃。
- [Host探针](../.diagnostics/review-custom-provider-round5-20261020/host-probes.mjs)、[日志](../.diagnostics/review-custom-provider-round5-20261020/host-probes.log)在保留首次正向断言失败证据后，用“缺陷仍存在”断言继续收集后续路径，最终exit0只代表诊断完整，不代表产品通过。

跨夜恢复后旧回归job句柄已不可读；已核验落盘的47条退出记录及各组日志，不伪称重新取得了原stdout。没有重复启动已完成的全量工作。独立探针均用合成配置/Key/传输与真实组件/真实apply，无真实账号请求或凭据读取；只新增本轮诊断/报告，未修改产品、既有测试、已装副本、部署或重启。

## 9. 下一轮最小修复顺序

1. **先修跨条目误写/误删**：所有输入、开关、删除按稳定id处理；两张/三张卡片分别改和删，保存后只影响目标。
2. 完整清理Key变化后的投影，并同步GUI/工具来源事实；A/B/A纯工具及交叉入口都不得旧B收尾。
3. 修正失败缓存的身份域桥接，真实GUI401/过期后不得旧ok，T类宽限及新成功恢复保持。
4. 修内置首项重复disabled；保留已通过的统一混排、保存重开和顺序不丢失。
5. 同批实施第1节的新外观/默认折叠要求，再由用户在实际页面确认视觉一致性。

真实账号/额度池、窗口口径、策略UI及真实注入/重试仍为此前独立待验项。本报告不宣称整项功能或运行副本已实机通过。

## 10. 用户后续变更：内置WorkBuddy自动读取模型网关（2026-10-21，覆盖前方案）

**用户已撤销“专门给此网关新增自定义卡片/积分格式选项”的方案。**改造的是Usage Dock内置国内WorkBuddy的数据源，不是修改外部Connect插件：保留workbuddy渠道id、原开关/排序及现有✦积分显示，不新增custom条目，不重复配置Key，不处理国际网关适配。

用户新截图已确认provider id为workbuddy、模型baseURL为`http://localhost:7863/v1`。内置取数应从宿主当前有效模型配置解析并冻结该来源，复用其网关Bearer Key，访问**GET http://localhost:7863/status**（根路径，不是/v1/status），不再读取旧Connect路由或OAuth登录态。地址随模型配置变化，不硬编码端口；本机HTTP例外仅限该明确选择的回环来源，不能借此全面降低通用自定义出网限制。

详细替换要求见[内置国内WorkBuddy迁移说明](workbuddy2api-panel-credits-integration-20261021.md)。README未给出/status精确JSON结构，当前只缺脱敏状态样本或该版本公开响应定义来确认剩余积分字段/合计口径；不再要求用户重复提供截图已给出的baseURL。

此变更不撤销第1节对通用自定义卡片的默认折叠/样式一致要求，也不撤销R5-01双卡误写/误删等独立缺陷。当前仅更新接入决策与需求文档，尚未实现/部署内置迁移。
