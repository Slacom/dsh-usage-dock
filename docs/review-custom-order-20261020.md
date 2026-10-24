# 自定义渠道排序专项：单条无操作，分组限制与顺序互相覆盖

> 2026-10-20。仅诊断/复现，未改产品、既有测试、真实配置或已装副本，未部署/重启。
> 当前客户端SHA256 `e16250a85ba0a34e1750099e327d00a65f8c944b04e465420558e3dfc9a544e1`。
> **关键结论：最新源码能交换两条自定义项，但仍强制“内置在前、自定义在后”。此前截图只有一条OpenRouter时，当前按钮必然没有移动效果。**另有两处确定的跨组顺序破坏。

## 1. 为什么单条OpenRouter点上下完全没反应

[CustomBalancesSection.move](../client.js#L2935-L2946)操作的是customBalances数组，不是完整渠道列表。只有一条时，index=0：上移目标−1，下移目标1；均越界，直接return。

[两个箭头](../client.js#L3000-L3012)却只按locked禁用，没有按可移动边界禁用，所以**看起来可点击，实际不建草稿、不写顺序，保存按钮也不会亮**。

真实客户端SettingsPage合成复现 **SINGLE_CUSTOM_BOTH_ARROWS_NO_OP**：两个按钮启用，点击后卡片不变、保存仍禁用、mutate次数0。不是Host排序或余额请求的问题，链路还没有走到保存。

## 2. 即使写入全局顺序，自定义仍会被强制放到内置之后

四个位置持续维持分组：

- [设置页](../client.js#L3821-L3851)：先渲染全部内置rows，再追加整个自定义区。
- [自定义重排写入](../client.js#L3357-L3375)：写成builtIn.concat(nextOrder)。
- [胶囊/详情共用plans](../client.js#L1816-L1843)：内置与自定义各自排序后concat，自定义总在后。
- [Host结果](../index.js#L829-L843)：同样builtIn.concat(orderedCustom)。

**FAIL_BADGE_FORCES_CUSTOM_AFTER_BUILTINS / FAIL_DETAIL_FORCES_CUSTOM_AFTER_BUILTINS**：已保存顺序明确是`[自定义甲厂, workbuddy, deepseek]`，真实胶囊和打开后的详情仍显示`[WorkBuddy, DeepSeek, 甲厂]`。内置项自身顺序正确，说明配置确已读取，不是“没保存/没刷新”就能解释。

因此，如果用户想把OpenRouter移到Codex/WorkBuddy前面，现有实现**从设计上就做不到**；加多少次sortCustomByOrder都只改变自定义组内相对顺序。

注意：“原样concat(customs)”会保留Host给出的custom内部顺序，并不会自动反转它。此前文档把“追加”解释为“覆盖回原序”不准确；应区分组内排序与跨组位置，不能继续据此误诊。

## 3. 另外两处真实写入错误（不依赖是否允许混排）

### 3.1 移动自定义项，反而重置内置顺序

[reorderCustomEntries](../client.js#L3368-L3374)没有读取当前内置相对顺序，而是重新遍历PLANS，生成注册表默认顺序。

**FAIL_CUSTOM_REORDER_RESETS_BUILTIN_ORDER**：原本WorkBuddy在DeepSeek前，交换甲乙两条自定义后，自定义交换成功，但DeepSeek被重置到WorkBuddy前。与注释承诺的“内置原相对顺序不变”相反。

### 3.2 刚打开设置就移动内置项，会丢掉已保存的自定义顺序

[orderedIds](../client.js#L3448-L3478)仅从draft.customBalances加入已知自定义id；刚打开时draft=null，却没有退回current.customBalances，于是保存过的自定义id被过滤成未知。

**FAIL_INITIAL_BUILTIN_MOVE_DROPS_CUSTOM_ORDER**：初始planOrder含两条自定义id；移动一个内置项并保存后，planOrder中两条自定义id都没了，customBalances本身仍在。之后胶囊只能退回其它默认顺序来源。

这些都是独立的顺序损坏，不应靠再增加一个排序函数遮盖。

## 4. 为什么测试全绿仍修不中

- **PASS_TWO_CUSTOM_INTERNAL_SWAP**：本轮实测，两条自定义的设置卡片和保存顺序确能交换，不应说最新版任何排序都坏了。
- [正式排序测试](../tools/test-custom-order.mjs#L103-L160)只造两条自定义，且明确断言内置始终在前；初始内置顺序又接近默认，没覆盖“不得重置已有内置顺序”。
- [Host排序用例](../tools/test-custom-order.mjs#L212-L239)是测试里手写的等价算法，不是真实Host完整链路。
- [渲染R14](../tools/test-custom-render.mjs#L388-L426)payload只有两条自定义，没混入内置项；自然无法检出全局顺序被分组覆盖。
- 单条自定义上下无操作、初始draft为空、跨组排序，都没纳入原测试场景。

本轮原有排序/渲染脚本也均exit0：[排序日志](../.diagnostics/review-custom-order-20261020/existing-custom-order.log)、[渲染日志](../.diagnostics/review-custom-order-20261020/existing-custom-render.log)。[独立脚本](../.diagnostics/review-custom-order-20261020/probes.mjs)及[日志](../.diagnostics/review-custom-order-20261020/probes.log)使用真实客户端组件和按钮/保存操作，不读取真实Key、不发供应商请求。脚本exit0表示这些行为/缺陷断言成立，不表示排序通过。

## 5. 用户已确认：内置与自定义渠道统一混排（同批修复）

**用户已明确确认：OpenRouter等自定义渠道必须能移到Codex、WorkBuddy等内置渠道前面，所有渠道统一上下排序；设置页已有渠道卡片、侧栏胶囊和详情面板共用同一顺序。**这不是仅在多条自定义之间交换位置。

本条明确调整旧设计/注释中“已有自定义渠道固定排在内置之后”的限制。执行模型应依据本次确认修复，不能再以旧的固定分组要求保留builtIn.concat(custom)。**添加入口/说明控件仍可单独固定页尾**，但不能因此把已有自定义渠道卡片和显示行也锁在底部。

必须一次修完整链路：

1. 一份基于稳定额度条目id的全局planOrder，设置卡片/胶囊/详情共用；不要最后再拆组concat，不以厂商显示名或模型provider名代替条目id。
2. 按完整合法列表求相邻项：即使只有一条自定义，也能与内置邻居交换；内置项同样可跨越自定义项。真正不可移动的边界按钮应明确禁用。
3. 移动只调整目标位置，保留其它项相对顺序；修掉“移动自定义重置内置顺序”和“初始无草稿移动内置丢掉自定义顺序”两处已复现问题。初始读取current，不忽略已保存项。
4. 排序不要意外改凭据、余额配置或清空无关状态，不因纯显示调序额外发余额查询；保存成功后生效，放弃恢复，重开设置及刷新后顺序保持。
5. 必须用真实设置按钮→保存→真实胶囊/详情渲染验证混合列表，不能仅测手写等价算法或两条自定义。

最低验收用例：

- 仅一条自定义OpenRouter，从Codex下方上移至其上方，再越过WorkBuddy，卡片/胶囊/详情都同步；反向下移也成立。
- 内置渠道跨越自定义项后，其他项相对顺序不变；既有非默认内置顺序不能重置。
- 两条以上自定义既能彼此交换，也能分别跨越内置渠道；自定义不再被整体强推到列表尾部。
- 刚打开设置、尚无草稿时立即移动并保存，不能丢失任何已有自定义排序id。
- 保存重开、刷新、放弃草稿、首尾边界与停用/删除后的合法id清理均覆盖；混合payload故意给相反顺序，最终以同一planOrder渲染。

**该要求交给执行模型与已有审核问题一起修复。**用户确认的是排序需求调整，不是本审核方已实施或验收；本次仅更新文档，也不授权自动部署/重启/发布。仍须同时关闭[第三轮报告](recheck-custom-provider-v0.9.1-round3-20261020.md)里尚未关闭的来源生命周期问题。
