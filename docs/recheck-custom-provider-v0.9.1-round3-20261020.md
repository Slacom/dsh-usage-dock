# 自定义渠道第三轮复核：主要修复通过，仍有来源生命周期缺口

> 2026-10-20。审查包SHA256 `ec757f5cf0b3fb294fe25762edfbc47b04a60fe5d17e377150903d4bcc14fd2e`。
> 对照[第二轮报告](recheck-custom-provider-v0.9.1-round2-20261020.md)、[本轮整改记录§12](quota-policy-build-v0.9.0.md#L473-L592)。
> **整体仍不通过：2组P1来源边界＋1项P2跨入口状态一致性缺口。**OpenRouter默认地址、完整冻结、非owner拒绝、provider/端点直接修改作废、baseURL真实设置页展示均已通过定向重放。不是原问题全部仍未修。
> 仅审核：未改产品、既有测试、真实配置或已装副本，未部署/重启/发布；本轮无子代理。

## 1. 已通过的修复（限定本轮场景）

| 项 | 独立重放结果 |
| --- | --- |
| OpenRouter预设默认地址 | 配置不写baseURL，仅由独立公开目录提供默认值；真实GUI取数请求到/api/v1/credits，8−0.5＝7.5，状态ready |
| CP-08 baseURL展示 | 使用真实custom-status响应挂载真实客户端SettingsPage，显示完整https://openrouter.ai/api/v1及“预设默认”，不只显示origin |
| 完整冻结与工具缓存身份 | 凭据服务依次返回A/B/A：三次工具查询结果9000/1/9000，凭据读取3次，HTTP仅2次；首次不再采样A却发送B，第三次正确命中A缓存 |
| provider/端点直接变更 | 同一apply实例先有1CNY，改provider并reload后旧数消失；再改余额端点也消失，context变“暂无额度数据”而非旧收尾 |
| 非模型owner | 无关namespace的ghost不在目录中：列表不接纳，GUI结构化拒绝且零HTTP |
| 其它原已通过分支 | 串行正式回归保持通过；本文不撤销此前端点、预算、默认旧条目停采的限定结论 |

**重要边界：**工具缓存按凭据身份正确，不等于Host观察已随同一provider的实际来源变化更新，见第3节。OpenRouter本地合成路径已通过，也不等于截图中的运行副本已重载或真实Key权限已验证。

## 2. P1-1 / CP-02未完成项：宿主已移除来源，插件从inherited复活并继续查询

位置：[readPathConfig逐路径退回继承层](../plans/custom-balance.js#L801-L820)、[列表使用它判断已添加](../plans/custom-balance.js#L554-L555)、[取数使用它](../plans/custom-balance.js#L881-L889)。

整改记录诚实保留了这项未完成，但现在可以提供**官方原组合器的执行证据**，不必继续把语义视为未知。

### 官方语义不是猜测

[宿主applyEntryPatches原实现](../.diagnostics/host-src2/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L47-L110)对patch字段执行`target[key] = value`，其中config整份替换。[composeEntries](../.diagnostics/host-src2/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L1077-L1088)调用同一个函数；[schema说明](../.diagnostics/host-src2/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L3044)也明确不是deep-merge。

本轮从已核验提取中截取这份纯函数的原始源码执行，**没有手写一个假组合器来证明自己的预期**。原函数字节SHA256 `e8db69365e2e529fcde854019c09efafaf72f9bab749a810b7b28c57cd43a0c1`。宿主asar仍为之前核验的`47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`。

### 合法配置反例

基础层含OpenRouter配置（旧模型主机＋引用）；当前层分别提交：

1. `config: {}`；
2. `config: { providers: {} }`，即明确没有任何已添加provider。

官方组合器两次都证明：**有效配置没有OpenRouter**。目录仍可以有OpenRouter模板，这是公开目录的正常语义。

将这个真实组合结果放进Loader条目的options.config，同时按真实configEditor接口形状提供inherited/override；插件却在override路径未命中时退回旧inherited，仍把OpenRouter列为已添加，并向合成旧主机请求一次，context还按旧1CNY收尾。

日志：**FAIL_REAL_HOST_CONFIG_REPLACEMENT_REVIVES_REMOVED_SOURCE**（两个replacement各一例）。

正控制 **PASS_REAL_INHERITANCE_WITHOUT_OVERRIDE**：没有提交覆盖时，原继承来源仍应保留，当前能够列出。因此修复**不能反过来把所有空override都解释成清空**：configEditor在“没有覆盖”和“显式空config覆盖”时都可能给出override={}，区别应从已组合的有效配置/覆盖事实取得。

**修复出口：**基于宿主已经组合好的owner配置读取settingsPath，而不是把任意层路径命中都当有效值。可核验公开Loader条目的有效options.config等投影及其生命周期；不要依赖override对象是否非空来猜覆盖是否存在。既要保证真正继承仍有效，也要保证删除/重置后的来源不再列出、不读旧凭据、不发旧请求、不用旧额度驱动规则。无需改宿主或删除共享凭据。

## 3. P1-2 / CP-04残留：同一provider的真实来源变化，Host仍使用上一源的观察

[Host identityOfChannel](../index.js#L251-L300)补上了provider和balanceEndpoint，直接改这两项的原例确已修好。但其余仍来自插件自己的旧URL/引用/customKeys，并不代表所选模型来源当前生效的baseURL、引用及实际凭据身份。

### 反例A：工具已确认回到A，context仍停在B

**FAIL_SAME_PROVIDER_KEY_CHANGE_LEAVES_HOST_ON_B**：上面A/B/A的工具链中，第三次工具已经读取到当前凭据A，并正确返回A缓存的9000；但context仍输出B的1CNY和closing规则。

这里没有指责新的冻结又坏了——工具取数/缓存身份本轮已正确。问题是**采样已经确认的新来源事实，没有同步到Host观察的当前有效身份**，缓存命中也没有撤掉B的阶段信息。不能以“没收到外部变更通知”解释，因为本次工具采样本身已知道当前是A。

### 反例B：真实reload后，设置页显示新主机，context仍是旧主机额度

**FAIL_EFFECTIVE_MODEL_SOURCE_CHANGE_RETAINS_OLD_QUOTA**：先从alpha来源取得1CNY；保持自定义条目的provider和端点不变，只把模型配置中alpha的baseURL改为beta合成主机、引用改为B_REF，并触发真实app-boot/config-reload回调。设置页状态接口已读到新baseURL，context却仍拿旧1CNY收尾，尚无新来源的成功采集。

这是上一轮已要求的“同provider主机/引用/凭据修订变化”边界，不是新增真实账号/额度池证明需求：这些来源配置事实本地已经可知。

**修复出口：**统一派发冻结身份与Host预期观察身份；任何入口确认来源变化后，先作废旧源观察/计数/在途，不能仅检查自定义条目里的provider字符串。缓存命中也要尊重当前源身份，但不能冒充新HTTP成功刷新采样时间/清零计数。未知时先normal/暂无数据，不继续套用旧源收尾。同步context继续只读已维护状态，不在模型每步现场查询供应商或解密全部凭据。

## 4. P2交叉缺口：GUI已知永久失败，工具仍回旧ok成功缓存

这是对已有“共享有效观测、永久失败不沿用旧成功”合同的补充交叉验证，不是P1密钥泄漏的延续。

**FAIL_GUI_PERMANENT_FAILURE_LEAVES_TOOL_SUCCESS_CACHE**：

1. 同源同Key，工具成功取到1，建立30秒成功缓存。
2. GUI下一次真实取数层收到合成401；Host正确显示“获取额度失败”，撤掉阶段规则。
3. 立即调用工具，仍返回availability=ok、balance=1，零新HTTP请求；Host则仍显示获取失败。

[工具readCache](../plans/usage-tool-register.js#L250-L275)只检查自身键和TTL，未联动该源已知的有效失败状态。该数字是旧成功，不应在已知P类失败后继续以ok掩盖当前状态；保留过去的fetchedAt也不能替代有效状态分类。

**修复出口：**源的永久失败/明确过期失效应同步约束工具成功缓存。可清理对应缓存或在读取时检查同一有效源状态；后续主动重试取得真正新成功再恢复。不要把缓存读取当新成功冲掉P/A封存。暂时失败的宽限缓存和采样时间规则仍保持，不应粗暴清空无关渠道。

## 5. 证据与回归口径

- 新包203516字节、27文件，逐payload匹配当前源码，mismatch=0；SHA1 `f49c48d4e3632fd416e8d757e8c00d8d111f7915`。[核验](../.diagnostics/review-custom-provider-round3-20261020/package-audit.json)。
- 按要求逐文件**串行**执行45脚本：42个普通Node组1447项＋行尾64＋几何144＋契约7＝**1662项**，全部exit0、0跳过。[清单](../.diagnostics/review-custom-provider-round3-20261020/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round3-20261020/regression/counts.json)。
- [独立定向脚本](../.diagnostics/review-custom-provider-round3-20261020/probes.mjs)、[日志](../.diagnostics/review-custom-provider-round3-20261020/probes.log)：真实apply/工具/取数层及真实客户端设置组件，依赖与传输全合成。未读取真实profile/Key，未向供应商发送真实Key。
- 定向脚本exit0表示PASS正例成立、FAIL缺陷存在断言也成立；不是新包通过。下一轮应按修复后的正确行为改期望并保留本轮证据。

## 6. 下一轮最小闭环，不再只补几个字符串字段

1. 以官方有效owner配置为唯一配置基础，补“无覆盖正常继承、config:{}、providers:{}、覆盖保留其它provider但删除当前项”矩阵。
2. 在统一Source状态上处理模型来源变化及P/A失效；GUI、工具派发/cache、自动context共用有效身份/状态，仍允许各自合理调度，但不能各说各话。
3. 保留本轮通过的默认目录、owner、完整冻结、端点拼接与baseURL展示；为同provider外部主机/引用变化、凭据A/B/A、GUI永久失败后读工具缓存加入真实apply级守卫。

截图仍显示OpenRouter“配置有误”，本轮不据源码合成正例宣称运行副本已恢复。修复上述问题后还需在用户授权范围核对实际运行版本/重载状态、最新错误与真实接口权限；不应再凭测试总数或“已复制到profile”替代真机验收。

本轮两个后台job `pwsh-5bc88f3e870a4de8`、`pwsh-e9ce2cd828a345ab`均已收集exit0，无在途任务。真实账号/额度池、窗口口径、策略UI及真实注入/重试仍是原计划的独立验收，不将本报告当作那些功能的通过证明。

## 7. 后续追加：用户已确认所有渠道统一混排（与上面问题同批修复）

用户明确确认：**自定义OpenRouter必须能上移到Codex、WorkBuddy等内置渠道之前；内置与自定义一起排序，设置页卡片、胶囊及详情共用同一顺序。**本条覆盖旧的“已有自定义项固定在底部”限制，不再只要求自定义组内换序。添加入口仍可单独放在页尾。

[排序专项报告§5](review-custom-order-20261020.md#L56)已记录确认、根因及完整验收。执行模型须同时修复单条自定义箭头无操作、移动自定义重置内置顺序、初次移动内置丢失自定义排序等问题；不得仅再加一个组内排序函数或继续固定builtIn.concat(custom)。

新增排序需求及其验收不计入本报告此前1662项回归；本次仅追加文档，尚未实施或独立验收，不改变前述2组P1＋1项P2仍待关闭的结论。
