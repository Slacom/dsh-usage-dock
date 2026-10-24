# 自定义渠道第四轮复核：删除源已修，仍有三组未闭环

> 审查日期：2026-10-20；对象为本地包SHA256 `e0d7ac4e04c1b56a9a0324dbd71c1b1e8ff3c28154b38b986e24d65c5c6fc95f`。
> 对照[整改记录§14](quota-policy-build-v0.9.0.md#L702-L798)、[第三轮报告](recheck-custom-provider-v0.9.1-round3-20261020.md)、[用户确认的统一混排要求](review-custom-order-20261020.md#L56)。
> **整体仍不通过：1组P1、2组P2；排序组有两处界面残留。**来源删除与主机/引用变更已转通过，不能说旧问题全部未修。正式1701项全绿不等于独立验收通过。
> 按用户最新指示停止账号诊断：没有准备、安装或加载账号诊断组件；账号资料问题不纳入本报告。只审插件，不改产品/既有测试/真实配置/已装副本，不部署、重启、提交或发布。本轮仅复用一个子代理审排序。

## 1. 已通过的整改与控制

| 项目 | 本轮独立结果 |
| --- | --- |
| 宿主清空/删除来源 | 用官方原组合器产生config:{}、providers:{}、仅保留其它provider三种有效配置；真实GUI均不列旧来源、零旧请求、零凭据解析，不再沿用旧收尾 |
| 无覆盖正常继承 | 已组合配置保留来源时仍能列出，未把所有空override错误解释成清空 |
| 同provider更换主机/引用 | 同一apply实例先取得1CNY，再改模型配置中的主机/引用并reload，context正确变暂无数据，不再拿旧源收尾 |
| 完整冻结/工具缓存身份 | 凭据依次A/B/A，工具结果9000/1/9000，实际HTTP仅2次且派发用对应冻结值；工具自身这一部分仍正确 |
| OpenRouter路径 | /credits与旧/api/v1/credits两种输入均落到/api/v1/credits，不重复拼接，合成扣减得到7.5 |
| Host真实混合排序 | 通过真实apply的GUI混合分支，内置provider用合成桩，返回自定义→WorkBuddy→DeepSeek，符合planOrder |
| 单条自定义跨内置移动 | 真实设置按钮能写出OpenRouter跨Codex/WorkBuddy的正确顺序，反向下移也正确，不再单条一律无操作 |
| 原排序写入错误 | 移动自定义不再重置非默认内置顺序；初次无草稿移动内置保留自定义id；保存、放弃均有通过控制 |
| 胶囊与详情混排 | 真实Badge及打开的详情，在故意反序混合payload下均按全局顺序显示；已测纯planOrder变更不新增取数 |
| 暂时失败宽限 | 一次GUI暂时失败后，同源旧成功缓存及原采样时间仍保留；没有把宽限错误当永久失败 |

以上是限定场景通过，不撤销仍未完成的真实账号/额度池、窗口口径、策略UI及真实注入/重试验收。

## 2. R4-01 / P1：同一引用下Key值轮换，Host仍按B收尾

**原第三轮P1-2只修了一半。**新增[providerSourceFingerprint](../plans/custom-balance.js#L773-L823)识别了主机/引用/端点变化，却明确不包含实际凭据值或其有效修订。[Host身份](../index.js#L329-L357)仍没有消费工具已采样到的当前凭据身份。

**FAIL_SAME_REF_KEY_ROTATION_CONTEXT_STILL_B**（真实工具链，同一apply）：

1. provider、主机、引用名和端点都不变；合成凭据服务依次返回A、B、A。
2. 工具正确返回A的9000、B的1、A缓存的9000；两次HTTP，冻结/缓存隔离本身通过。
3. 第三次工具已明确确认当前是A，但自动context仍写“额度1CNY / closing / 收尾”，即仍属于B。

不是要求同步context每步解密Key或发供应商请求；**本次identify已经读到并计算了A指纹，不能把这一已知来源事实只用于工具cache，却不更新Host观察身份。**不能以“真实计费账号尚未证明”解释这项本地已知的凭据隔离问题。

**修复出口：**将已解析/冻结的实际来源身份（包括凭据指纹或可靠版本）同步到Host有效源状态；缓存命中也先尊重当前源激活/作废边界。当前A应只允许A的有效观察，或在重新取得有效值前显示暂无数据/normal，绝不能继续B的收尾。若恢复A缓存，保留原采样时间和缓存语义，不把缓存读取伪装成新HTTP成功。

## 3. R4-02 / P2：永久失败缓存钩子调用错了观察器接口

新增缓存门控方向正确，但[isSourceFailed](../index.js#L1310-L1317)调用的是`quotaObserver.read(id)`。

实际[read签名](../plans/quota-observer.js#L338-L350)是`read(id, identity)`；只有id时，会查不到正常的哈希身份记录。钩子因此提前返回false，根本没读到当前failed/expired。不是工具层没调用钩子——[缓存层确实调用了它](../plans/usage-tool-register.js#L355-L376)。

**FAIL_PERMANENT_GUI_FAILURE_TOOL_CACHE_STILL_OK**：工具先成功1→GUI合成401，context已获取失败→工具立即调用仍返回availability=ok、balance=1，零新HTTP；原第三轮反例原样存在。

**CONTROL_READ_REQUIRES_IDENTITY**：对真实观察器建立指定身份的auth失败记录，read(id)为null，read(id,正确身份).status为failed，隔离证实接口误用，无产品补丁/全局shim。

**修复出口：**按当前有效身份查询观察，接通已知P/A失效到对应工具缓存。不要仅凭其它来源的readAny结果绕过身份隔离；修完应实测401后不再旧ok，真正成功重试后恢复，同时暂时失败宽限、其它渠道缓存和原采样时间不受影响。

## 4. R4-03 / P2：全局顺序已写对，但设置卡片DOM仍固定分组

### 4.1 用户明确要求的三处一致，仍缺设置页

[orderedPlanMetas](../client.js#L3512-L3520)只从PLANS建立byId，排除了自定义id；[内置卡片循环](../client.js#L3729-L3839)画完后，[设置页仍固定追加CustomBalancesSection](../client.js#L3842-L3874)。旧注释“用户要求固定在内置后”在用户明确推翻旧限制后依然保留。

独立排序验收5个DOM断言失败：

- 初始已经保存混合顺序，卡片仍内置全部在前。
- 单OpenRouter上移跨Codex，草稿/保存顺序正确，卡片位置却没跨。
- 连续上移至WorkBuddy之前并保存，卡片仍在所有内置后；重开设置仍然如此。
- 内置项跨自定义后，已保存全局顺序正确，已有自定义卡片甚至仍按customBalances原数组顺序显示。

这解释了用户仍可能看到“卡片点了不动”；**但胶囊、详情、保存值确已混排通过，不能再推翻这些已修链路。**只改箭头的globalOrder或再对子数组sort，不能修复实际DOM。

### 4.2 内置首尾箭头仍启用但无操作

[内置箭头](../client.js#L3747-L3764)的disabled仍只看可写/保存状态；[movePlan](../client.js#L3501-L3509)到边界后默默return。独立首项上移、末项下移两项disabled断言失败；自定义首尾禁用已经通过。

此处是同一排序验收组的边界反馈残留，不把2条断言另算成2个高危问题。

**修复出口：**已有内置和自定义卡片应先组成完整可渲染列表，再按统一planOrder逐项渲染；仅“添加入口/说明”可单独留页尾。不要先过滤成内置列表、最后追加整个自定义区。内置/自定义箭头都用真实全局位置判首尾；保留非目标项顺序，不改凭据/余额字段，不因纯显示调序额外查询。

## 5. 测试与包核验：两种口径分开

- 当前包209785字节、27文件，逐payload与当前源码一致，mismatch=0；SHA1 `70273bdc262c7fdec20066848f385539a28910fd`。[包核验](../.diagnostics/review-custom-provider-round4-20261020/package-audit.json)。
- 正式脚本逐文件串行执行47个：44普通组1484项＋行尾66＋几何144＋契约7＝**1701项，全部exit0、0跳过**。[清单](../.diagnostics/review-custom-provider-round4-20261020/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round4-20261020/regression/counts.json)。
- [Host独立探针](../.diagnostics/review-custom-provider-round4-20261020/host-probes.mjs)、[日志](../.diagnostics/review-custom-provider-round4-20261020/host-probes.log) exit0：正例通过，且两项缺陷存在断言成立。没有拿旧失败期望原封不动跑完就宣称通过。
- [排序独立探针](../.diagnostics/review-custom-provider-round4-20261020/order-probes.mjs)两次结果一致：**27项，20通过、7不满足预期，exit1无脚本异常**；7失败归为卡片DOM分组和内置边界两处残留，不是7个独立bug。[最终日志](../.diagnostics/review-custom-provider-round4-20261020/order-probes-final.log)。
- 独立探针全为合成配置/Key/传输，真实apply、工具、SettingsPage、Badge及详情；未发真实账号请求、未读真实凭据。正式回归中的原有外网冒烟不等同于账号真机验收。

新增正式组[测试声明](../tools/test-custom-round3.mjs#L12-L17)写了跨入口永久失败覆盖，但实际[S4/S5](../tools/test-custom-round3.mjs#L250-L333)只测配置/指纹，文件就结束，没有真实GUI失败后再调用工具的用例。S5只更换引用名，未覆盖同一引用的值轮换；排序只看顺序写入，也遗漏真实卡片DOM。这是本轮全绿仍未闭环的直接原因。

## 6. 下一轮最小验收清单

1. 保留本轮通过的组合配置删除、正常继承、目录默认地址、相对路径兼容、完整冻结、Host/胶囊/详情混排及顺序写入修复。
2. 同引用A/B/A真实工具链：第三次返回A数据时，context不得残留B数值/规则；有无缓存命中都覆盖。
3. 同源工具成功→GUI401/明确过期→再调用工具：不能旧ok；新真实成功后恢复；T类宽限不回归。
4. 设置页真实卡片容器DOM顺序必须等于保存/草稿的全局顺序；单条及多条自定义跨内置、保存重开、放弃均覆盖，不只测planOrder字符串。
5. 内置与自定义首尾按钮一致禁用；纯排序不写secret、保留其它项顺序；同步检查单条与多条混合列表。

当前只关闭已被真实链路证实修好的范围。未核正在运行的插件副本，不凭执行方“已重装profile”代替运行验收。账号资料恢复问题已按用户要求暂缓，与本次插件结论分开。
