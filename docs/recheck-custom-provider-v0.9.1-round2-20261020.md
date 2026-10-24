# 自定义渠道第二轮复核：OpenRouter默认地址读取错误，整改部分通过

> 2026-10-20，审查包SHA256 `6b587ce935e0beea32b94d147254bb34ea72bf159448593e47bdb2c8c01b6fd1`。
> 对照：[首轮报告（含CP-07）](review-custom-provider-v0.9.1-20261020.md)、[本轮整改记录](quota-policy-build-v0.9.0.md#L401-L471)。
> **整体仍不通过。**原“旧Key发给新服务商”和“新条目工具直接缺凭据”案例已修；显式主机＋余额路径、凭据预算、默认停采旧条目通过。CP-01/02/04/07仍有残留。另记录本次用户新增的CP-08界面要求，不倒算成旧交付未修。
> 只审核，不改产品、真实配置、已装副本或既有测试，未部署/重启/发布；本轮没有启动子代理。

## 1. 先回答实机OpenRouter报错：不是余额路径格式不对

截图中配置的余额路径`/api/v1/credits`格式符合当前方案。报错“该渠道没有可用的接口地址（既未显式配置，宿主目录也没有默认值）”来自[readProviderSource](../plans/custom-balance.js#L700-L710)，**在拼余额路径、解析Key、发HTTP请求之前**。

### 根因：读了错误的对象，却把“没有读取”说成“宿主没有默认值”

- [defaultBaseUrlOf](../plans/custom-balance.js#L790-L815)只在configuration行、entry及其自造候选字段上找defaultBaseURL/baseURL。
- 真正[configEditor.configuration返回值](../.diagnostics/asar/dsh/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js#L39-L52)只有entry/inherited/override这些配置层，不是提供商目录，标准接口没有给这些行附加默认模型地址。
- 当前宿主的[目录生成器](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2830-L2857)才把defaultBaseURL、settingsNs/settingsPath、nativeAuth放进提供商目录；[公开读取入口](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L1960-L1965)是llm.listConfigurableProviders。
- [OpenRouter目录默认值确实存在](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2734-L2738)。本轮重新计算宿主asar SHA256，仍为`47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`，与之前核验的提取版本一致。

**FAIL_ROUTER_CATALOG_DEFAULT_NEVER_READ**：按真实接口形状分别提供配置行和独立目录；目录有OpenRouter默认地址，配置省略显式baseURL，余额路径正确。真实GUI入口仍返回与截图同一句config错误；目录调用0次、凭据读取0次、余额HTTP请求0次。

正控制 **PASS_EXPLICIT_SOURCE_ENDPOINT**：仅在合成配置补显式模型baseURL，同样余额路径就正确请求`/api/v1/credits`，并把8−0.5解析为7.5。这里只是定位前置解析故障，**不是要求用户用重复填写默认地址来绕过代码缺陷**，也不是对真实余额API/Key权限的联网验证。

所以：不应先要求用户改JSON取值键、重贴Key、重新登录、关闭代理；当前分支还没走到这些步骤。截图文案与此代码吻合并已离线重现，但本轮未独立哈希正在运行进程的插件模块。

## 2. 原整改项的限定结果

| 项 | 结果 | 本轮证据 |
| --- | --- | --- |
| CP-01 原两个反例 | 原例通过，冻结协议仍部分未修 | 旧Alpha Key不再抢Beta；工具成功。但身份采样与实际发送仍用两份凭据读取，见§3 |
| CP-02 唯一owner | 部分通过 | 禁用/多行歧义有拦截；单个非模型namespace仍被接受，合并语义仍旧 |
| CP-03 余额端点方案一 | 显式主机情况下通过 | origin＋用户端点正确拼接/扣减，不再直接GET模型根 |
| CP-04 来源身份 | 部分通过 | 公共digest加入新字段，但Host观察身份仍漏provider与balanceEndpoint |
| CP-05 单条凭据预算 | 通过原分支 | 25ms预算在120ms watchdog前返回network，迟到依赖没有发请求 |
| CP-06 旧条目 | 默认停采通过 | 默认收集忽略旧条目、GUI零旧请求。此结论不等于旧配置/秘密已物理删除 |
| CP-07 预设可见/可查询 | 部分通过 | OpenRouter可见，但默认来源地址仍没从真实目录读；状态在HTTP投影中又被剥掉 |

仍待改的是原CP-01/02/04/07四组（3组P1、1组P2），不是原七组全部没修，也不把本次新UI要求算成此前失败。

## 3. CP-01残留 / P1：只冻结provider名字，不等于冻结本次来源

位置：[identify采样值后丢弃值](../index.js#L1075-L1095)、[collect再次解析来源/Key](../plans/custom-balance.js#L1893-L1913)、[忽略冻结描述](../plans/custom-balance.js#L1986-L2008)。

当前identify先解析Key A并把A指纹计入缓存身份，但snapshot仅留`{kind:'provider', provider}`。派发又解析当前Key B，没有使用A。两个读取不同就会出现“身份A、数据B”。

**FAIL_IDENTITY_A_CACHES_DISPATCH_B**真实工具链：

1. 首次身份采样返回A，实际取数第二次读取返回B；实际发出的请求用B，取得B的1CNY。
2. 下一次身份读取又返回A；只发生了原来那1次HTTP请求，工具直接缓存命中，却把B的1CNY当作A的结果返回。合成A的正确余额设为9000。
3. 自动context也保留1CNY/closing规则。

这是原冻结/缓存合同的残留，不声称原“遗留Key跨域”案例仍然失败：那个原案例本轮已经通过。**数据来源身份与实际派发不一致，本身仍足以造成错误额度及阶段判断。**

修复：冻结完整且唯一的本次来源（owner、有效余额URL/origin、引用、本次值/内部指纹、源修订），派发与cache/single-flight都用这一份；源已经变化则明确作废重建。不能再用“完全绕开旧冻结协议”替代实现新的冻结协议。

## 4. CP-02残留 / P1：唯一候选仍不等于正确模型owner

[findProviderOwner](../plans/custom-balance.js#L591-L622)增加了跳禁用、多候选拒绝，但仍从任意行的providers形状取值，并未用公开目录核验owner。一个非模型插件如果恰好有这样的字段，仍被认作模型来源。

**FAIL_UNIQUE_NON_MODEL_OWNER_ACCEPTED**：只有一个活跃无关namespace声明ghost，公开模型目录没有它；真实GUI仍向其合成wrong域发请求，并使用该无关字段指向的模型Key。没有读取真实配置，不声称本机当前存在这个组合。

此外该函数仍Object.assign(inherited,override)，[此前明确的整份配置替换语义](../.diagnostics/host-src2/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L3044)尚未处理。只统计owner字符串数量不能证明配置所属，也不能修复合并规则。

修复：由公开目录的settingsNs/settingsPath定位对应owner及有效配置。目录中包含未添加的模板，不能把它们全当用户已添加；也不能把目录默认值当作用户覆盖值。显式有效覆盖优先，真正省略才按该来源的目录规则取默认。

## 5. CP-04残留 / P1：公共摘要更新了，Host观察身份没有同步

[公共entryPublicIdentity](../plans/custom-balance.js#L1305-L1325)及客户端已加入provider/余额路径，但[同步Host identityOfChannel](../index.js#L258-L272)仍旧手拼URL/JSON键/币种/旧引用等字段，漏掉provider与balanceEndpoint，实际provider凭据也不来自旧customKeys。

**FAIL_HOST_IDENTITY_STILL_OMITS_PROVIDER**：Alpha取得1CNY→同实例改Beta并完成reload；公共digest确已变化，但context仍显示旧1CNY和收尾。

**FAIL_HOST_IDENTITY_STILL_OMITS_ENDPOINT**：再改余额端点，仍沿用旧数值/规则。

修复：Host观察、工具身份、公共配置证明、客户端作废应来自统一源描述，而不是几处分别手拼。至少新provider/端点必须覆盖；同provider的模型主机、引用、凭据修订变化也应按同一源合同处理。不要只修前端签名，就宣称自动context也会失效。

## 6. CP-07残留 / P2：可见性改善，但来源状态没有传到设置页

除了§1的默认地址读取错误，[custom-status路由](../index.js#L826-L839)对结果再map时只留provider/displayName/origin，把新status/reason剥掉。探针确认helper返回no-endpoint，实际HTTP行却没有status。

因此“新增状态可见性”没有贯穿真实路由/客户端，用户难以在选择处获知为什么不能查询。修复时应返回和消费安全的状态/原因，而不是只给helper加字段。

没有显式apiKeyEnv也不能直接证明它在使用OAuth；可能是目录的native环境认证。应按宿主公开认证能力如实分类，不私读token文件，不把不能复用误说成用户没配置Key。来源枚举与余额查询继续分开：已添加来源应可见，当前不能查询则给出准确限制。

## 7. CP-08：用户本次新增“显示所选渠道baseURL”（下一交付验收）

**用户明确要求：在插件设置页显示所选渠道实际生效的模型baseURL，保留路径部分，尤其能看清结尾有没有/v1。不能只显示origin。**

- 显示真实解析结果，不能仅取输入框placeholder或强行显示目录默认值；有用户覆盖时以有效覆盖为准，未能解析则明确说明。
- 路径/尾斜杠应能辨认；userinfo、可能含Key的查询值、fragment等敏感内容应脱敏。仅GUI展示，**不加入usage_status或自动context**，不为显示地址发上游请求。
- **审核建议**：标明“用户覆盖/预设默认”来源，并额外预览最终余额URL，帮助区别“模型baseURL”“拼接基准origin”“用户余额端点”。这些辅助展示是建议，不倒算为此前未修项。
- 方案一仍是`origin + balanceEndpoint`。模型baseURL含/api/v1、余额端点填/api/v1/credits时，不能重复拼成/api/v1/api/v1/credits，也不应自行删掉用户路径里的/v1。
- 切换来源、保存、更改模型页覆盖地址后，展示与真正取数使用同一来源解析结果；不能显示A地址却请求B。

## 8. 证据、回归与建议修复顺序

- 包198801字节/27文件，逐payload与源码一致，mismatch=0；SHA1 `1b83b663bf7d83af704ffd694f33892e889e918c`。[核验](../.diagnostics/review-custom-provider-round2-20261020/package-audit.json)。
- 实跑44脚本：41个普通Node组1420项＋行尾63＋几何144＋契约7＝**1634项**，exit0、0跳过。[清单](../.diagnostics/review-custom-provider-round2-20261020/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-round2-20261020/regression/counts.json)。
- [定向脚本](../.diagnostics/review-custom-provider-round2-20261020/probes.mjs)、[日志](../.diagnostics/review-custom-provider-round2-20261020/probes.log)全部合成配置/Key/传输，真实apply/工具/取数层；未向供应商发送真实凭据。
- 首跑最后一个旧条目检查误假设响应一定有data；无活动渠道实际返回disabled，已改为断言无旧条目/零请求后重跑exit0。[首跑记录](../.diagnostics/review-custom-provider-round2-20261020/probes-first-run.log)保留；未将该测试假设错误算成产品缺陷。

建议一次闭环：

1. 先按真实接口读取模型目录＋有效配置，解决OpenRouter默认主机与owner问题，不猜配置行字段、不为单厂商硬编码域名。
2. 用这份解析结果生成统一SourceSelection/FrozenTarget，再同步工具派发/cache及Host观察身份；不再用provider字符串冒充冻结快照。
3. 以同一来源的公开部分驱动设置页状态和baseURL展示，保持凭据值只在Host。
4. 补“真实配置行＋独立目录服务”测试、A采样/B派发缓存隔离、换provider/端点的context作废、单个非owner拒绝；保留本轮已通过的端点、预算、旧条目停采。

不要在测试里给configuration行塞入真实接口不返回的defaultBaseURL，再据此宣称预设默认地址已接通。目录读取、下拉及baseURL展示不应触发模型请求、全量Key解析或额外供应商查询。

后台job `pwsh-9ffb89764abd4722`已收集exit0，无在途作业。尚未完成的真实账号/额度池、窗口口径、策略UI、真实请求/重试注入仍按原计划分别验收；本报告不宣称新包已实机通过。
