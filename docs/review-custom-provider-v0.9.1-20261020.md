# 自定义渠道新方案审核：方向可保留，当前实现不通过

> 2026-10-20。审查对象为[构建记录§10](quota-policy-build-v0.9.0.md#L321-L399)所述“0.9.1自定义渠道改造”，包SHA256 `6284d9f114ab6336997f31e68126230335171afeefa56ca079cd150f2a0c054c`。
> **结论：不能按现文档宣称改造完成。**选择模型渠道、自动复用凭据、折叠/紧凑布局可以保留；但新来源模式没有接通原有工具冻结、身份缓存与迁移协议，另有余额端点和来源解析设计错误。
> **最重要风险：合成测试确认可将旧条目的Key发送到新选服务商的地址。不是已发现你的真实Key泄漏。**本轮没有读取或发送真实Key，也没有修改配置、产品、已装副本、部署/重启/发布。

## 1. 审核范围与实测

- 阅读最新构建记录及设计/交接/README，对照当前实现与测试，不拿旧“必须手填Key/URL”的交互要求直接否定新下拉方案。
- 新包191800字节、27文件，与源码逐payload比较mismatch=0，SHA1 `4859dd7c67767fb0ed986981cbb65cda2f610ac1`。[包核验](../.diagnostics/review-custom-provider-20261020/package-audit.json)。
- 实跑44脚本：41个普通Node组1412项＋行尾63＋几何144＋契约7＝**1626项**，全部exit0、0跳过。[执行清单](../.diagnostics/review-custom-provider-20261020/regression/summary.json)、[计数](../.diagnostics/review-custom-provider-20261020/regression/counts.json)。
- [独立端到端探针](../.diagnostics/review-custom-provider-20261020/probes.mjs)使用真实apply/工具/provider/取数层，配置和网络全部为合成桩；[日志](../.diagnostics/review-custom-provider-20261020/probes.log)不打印Key值，只记录是否误用及合成目标。
- 只复用一位此前子代理核验宿主公开接口/安全边界，没有新开多个子代理。当前宿主asar SHA256仍为`47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a`，相关提取由该代理逐字节复核；主审复读了关键接口并独立跑合成反例。
- 主探针exit0表示各正例及“缺陷存在”断言成立，不表示功能通过。下一轮需将FAIL用例改为修复后正确行为断言。

## 2. 确定问题：4组P1、3组P2

> CP-07为用户在2026-10-20 17:23补充截图并明确范围后追加；不计入此前1626项回归，也不声称新增要求已验证通过。

### CP-01 / P1：新旧凭据冻结协议混用，工具缺凭据或错发旧Key

位置：[identify仍按旧字段冻结](../index.js#L1052-L1087)、[先解析provider覆盖目标](../plans/custom-balance.js#L1565-L1585)、[再应用旧冻结值](../plans/custom-balance.js#L1662-L1688)。

两个真实工具链反例：

1. **FAIL_TOOL_REJECTS_VALID_PROVIDER_CREDENTIAL**：新条目只有provider，没有customKeys/credentialRef。GUI成功取得1CNY；同一实例调用usage_status时，identify把它冻结成none，fetch虽然已经读到所选provider的Key，仍按none拒绝。工具返回no-credential、零余额HTTP请求，还把已有GUI成功观察改成“获取额度失败”。
2. **FAIL_OLD_KEY_SENT_TO_NEW_PROVIDER**：同一id仍有遗留customKeys旧Alpha Key，条目现选择Beta。identify冻结旧Alpha Key；provider解析把URL和credentialHost改成Beta；旧explicit冻结分支因目标已被改成Beta而通过校验。最终请求发送到合成Beta地址，携带的是旧Alpha Key，**不是所选Beta Key**。

即使真实Beta最终返回403，Key也已经出现在发给Beta的请求里；服务器是否接受该Key不改变错发事实。测试只截获合成传输，不代表用户当前已发生泄漏。

**修复出口：**统一GUI/工具的来源采样，冻结“provider唯一来源＋有效余额URL/origin＋引用及本次值＋源修订”整体，派发只能使用这份一致快照。不能仅跳过frozen none检查来让工具成功，也不能仅清理旧Key来掩盖协议未升级。测试必须覆盖新条目工具成功、遗留Key不抢新来源、配置轮换期间不混用旧值与新目标。

### CP-02 / P1：任意配置行的providers不等于所选有效模型来源

位置：[列表读取器](../plans/custom-balance.js#L482-L515)、[按第一个id命中取凭据](../plans/custom-balance.js#L533-L574)。

当前代码不检查行的owner namespace、disabled、LLM注册/声明归属，也不拒绝同id多候选；任意配置行有providers形状就会进入列表，首个同id胜出。

**FAIL_DISABLED_NON_OWNER_ROW_WINS**：合成配置中，前面有禁用/非owner行声明alpha→wrong域、引用Alpha Key；后面有真正模型owner的alpha→alpha域。公开LLM元数据也明确owner为后者。当前fetch却把模型Key发到wrong域。只是解析正常配置行，不需要篡改TLS。

宿主证据：

- [configEditor.configuration](../.diagnostics/asar/dsh/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js#L27-L62)返回配置层及Loader条目，不是“已生效LLM provider目录”。
- [loader.entries](../.diagnostics/asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js#L141-L147)枚举全部store；[disabled](../.diagnostics/asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js#L335-L343)是另一个状态，当前列表未核对。
- [宿主配置组合规则](../.diagnostics/host-src2/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L3044)是config整份替换，不是任意Object.assign合并；显式空override不应复活inherited中的旧providers。
- [LLM已登记路由](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L1905-L1909)与[可配置目录](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L1960-L1965)是不同事实。后者包含dormant，仅能协助定位owner，不能直接当实际端点/账号证明。

**修复出口：**明确支持哪类来源，通过公开路由/目录定位唯一owner及配置路径，再读取有效配置；同id歧义拒绝，不任意first-wins。如果产品要允许禁用来源查余额，也要明确标示并唯一绑定该来源，不可与生效模型同id混同。按用户新增的CP-07，显式baseURL＋apiKeyEnv子集已不能代表完整来源列表：预设与自定义来源都应展示，余额查询能力另行标明；不应把OAuth/native模式不支持查询一概叫“未配置Key”。

### CP-03 / P1：模型baseURL被直接当余额API完整地址

位置：[直接返回hit.baseURL](../plans/custom-balance.js#L591)、[覆盖余额请求URL](../plans/custom-balance.js#L1578-L1585)。

选择模型渠道只能知道模型API根和凭据，**不能通用推导余额端点**。JSON取值键只负责从返回JSON取数字，不能补上HTTP路径。

**FAIL_MODEL_BASE_URL_IS_BALANCE_URL**：合法合成服务商把模型根配置为/v1，余额端点为/v1/credits；程序只GET /v1，得到endpoint错误。这里的路径是合成协议，不是断言所有厂商都用credits，更未联网核验OpenRouter最新余额接口/权限。

新UI已删除URL且没有余额路径字段，也没有宿主余额能力元数据或厂商适配表。因此用户没有办法告诉它真正应查询哪一扇“余额门”。不应让用户为了余额去改模型baseURL，那可能破坏正常模型请求。

**需要先冻结设计：**要么下拉负责凭据/允许origin，另提供明确余额路径；要么有已证明的余额端点能力元数据；要么另获授权做有限厂商适配。不能同时要求“通用接口、不输入任何余额地址、不做厂商适配”，却直接假定模型根就是余额地址。

### CP-04 / P1：新增provider没有进入身份与配置证明，换源仍用旧额度收尾

位置：[Host公开身份](../plans/custom-balance.js#L995-L1010)、[Host观察身份](../index.js#L256-L270)、[客户端身份](../client.js#L349-L360)、[客户端配置签名](../client.js#L488-L504)。它们仍围绕旧URL/引用/目标字段，遗漏新provider。

**FAIL_PROVIDER_SWITCH_RETAINS_OLD_QUOTA**：Alpha查询取得1CNY/closing→同一条目切Beta并真实reload，尚未有Beta成功采集→context仍输出旧1CNY及收尾规则。Alpha/Beta两份配置的configDigestOf完全相同。

这是新来源字段遗漏，不是上一轮epoch框架又原样坏了：框架看不到身份变更，自然不推进epoch。客户端也无法用旧摘要证明“Host用的是当前选择”。

**修复出口：**将provider/owner及有效余额目标、引用/非密修订、实际凭据身份纳入一致的源协议；Host、工具cache/single-flight、观察epoch、客户端证明都同步升级。仅加provider字符串仍不足以覆盖“同一provider在模型页改baseURL或引用”的来源变化。实际复现覆盖Alpha→Beta；其它源字段变化应作为同修矩阵，而非另算新缺陷。

### CP-05 / P2：新凭据解析绕过单条绝对预算

位置：[直接await credentials.resolve](../plans/custom-balance.js#L568-L575)、[调用方也直接await](../plans/custom-balance.js#L1565-L1567)。旧引用分支有budget.race，新分支没有。

**FAIL_PROVIDER_CREDENTIAL_WAIT_EXCEEDS_ITEM_BUDGET**：缩放单条预算到25ms，合成credentials.resolve保持pending；100ms watchdog先到，函数仍未返回。释放依赖后才因预算已过返回network，未发迟到HTTP。

整批20s兜底仍存在，本项**不是宣称GUI必定无限挂起**；问题是单条10s不能释放worker、后续条目会被阻塞，后台依赖等待也未被预算收束。

**修复出口：**来源配置读取、凭据解析、排队/连接/body全部走同一绝对预算/取消边界，先做无需秘密的本地校验；超时/取消后不继续派发或回填。补新provider模式而非仅旧credentialRef模式的预算用例。

### CP-06 / P2：文档说升级会清空，生产仍主动读取旧条目

位置：[collectCustomEntries明确兼容无provider条目](../plans/custom-balance.js#L1119-L1152)、[客户端也保留旧行](../client.js#L618-L658)。没有provider仍可用旧URL/Key正常查询，并不因“UI不再生成”变成仅测试路径。

**FAIL_LEGACY_NOT_CLEARED_OR_IGNORED**：输入合法旧配置，无provider，用合成DNS/HTTPS计数；真实GUI入口仍请求一次并返回旧余额13。未经过重新选来源。

因此[升级会清空的说明](quota-policy-build-v0.9.0.md#L388-L392)不代表通用安装行为。本轮未读取用户profile，**不否认执行者可能已手动清空本机**；但代码不会为其它合法旧配置自动清空/停止查询。旧行还可能因新校验要求provider而阻挡整页保存。

**修复出口：**实现已约定的迁移/旧条目禁用，或准确写成“本机部署时手动清理，其他安装需按步骤迁移”。不要为了保留旧测试绿，在生产保留与迁移声明矛盾的隐形兼容通道。安全底层的旧URL测试可以独立保留；不必让旧条目继续后台取数。不得删除共享模型凭据。

### CP-07 / P2：预设添加的模型来源漏列，须覆盖预设与自定义两种添加方式

**用户于2026-10-20 17:23确认的验收要求：除DeepSeek和MiMo之外，通过“第三方模型提供商”预设或“自定义模型API”实际添加的渠道，都应出现在Usage Dock设置页的自定义来源下拉中。**不再仅列手填接口地址的自定义提供商。

现场证据：用户截图中模型设置已有OpenRouter与PackyAPI，但插件来源下拉只有PackyAPI；另一张截图展示通过预设选择OpenCode Go的添加流程。该未保存表单本身不证明OpenCode Go已添加，保存后应纳入同一枚举规则。

源码依据：[当前列表要求显式baseURL和apiKeyEnv同时非空](../plans/custom-balance.js#L494-L503)，任一缺失就直接跳过；而[宿主profile schema](../.diagnostics/routing-audit-20261019/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L1049-L1083)允许这些字段省略，预设来源可依赖目录默认地址或宿主认证来源。不能把“没有显式覆盖地址”当作“未添加来源”。截图的默认地址提示/空密码框也不等于实际没有地址或已保存凭据；本轮没有读取真实配置来判定该机器具体省略了哪个字段。

**一起修复时的边界与验收：**

- 枚举用户**已保存、实际添加**的模型来源：预设＋自定义都覆盖；不要把整个可添加厂商目录或尚未保存的草稿当已添加来源，也不能继续只扫描有两个显式字符串的配置行。
- DeepSeek/MiMo只在此自定义来源列表中排除；保留它们已有的内置余额胶囊/设置，不删除模型配置或凭据。按确定的提供商身份排除，不按模型名称或显示名模糊匹配：**OpenRouter/PackyAPI即使运行DeepSeek模型，也仍应出现。**这不意味着恢复已退场的内置专用取数通道。
- 使用宿主公开目录定位唯一owner，结合有效已保存配置与默认配置解析；已添加但当前不可用/停用的来源应明确标状态，不能被另一条同id配置抢占。CP-02的owner/歧义校验仍须保留。
- **来源可见与余额可查分开。**缺少余额端点、暂不支持某认证方式等，应显示具体限制/待配置状态，不能静默从列表消失，也不能因用户要求可见就擅自把OAuth凭据当Bearer Key发送。CP-03的余额端点问题仍需解决。
- 不要求用户重新粘贴已有Key、重复填写默认API地址来绕过漏列；不读私有token文件，不为枚举逐个发供应商请求或解析所有渠道的秘密。
- 最小验收：①预设OpenRouter未显式覆盖默认地址仍出现；②保存后的预设OpenCode Go出现；③自定义PackyAPI出现；④DeepSeek/MiMo不出现在该下拉但原内置功能保留；⑤第三方渠道下的DeepSeek模型不被误过滤；⑥未保存草稿/未添加目录模板不出现；⑦不支持余额查询的已添加来源有明确状态；⑧刷新、增删和配置变更后列表正确，选择身份与CP-01/02/04一致。

此项与前六组问题同批交给执行模型修复；本次仅追加审核需求和证据，不修改产品或部署。

## 3. 文档安全论证需要改写，不是一概要求回滚新交互

[§10.1/10.3](quota-policy-build-v0.9.0.md#L325-L359)称“这层风险消失”“连错服务器会因 TLS 握手失败而拒绝”，并据此推导不会把Key发给伪装者。这些推论不足以构成目标授权保证。

- 模型配置也由用户/配置工具写入，选择下拉改变了输入位置，不会自动证明owner、端点或Key对应正确。
- TLS验证所选hostname的证书，不判断“这把Key是否应该发给该服务商”。CP-01/02在目标持合法证书时照样可能错发，不需破坏TLS。
- fake-ip兼容与放开所有环回/私网/单标签地址不是同一个范围。即使已接受这项取舍，也须写清网络可达性/SSRF保证减少，不能叫风险消失。
- 普通fetch也不等于自动配置代理；能否经过fake-ip网关仍依赖实际运行环境。

审核不擅自撤销用户已接受的取舍；但需要在规范中明确授权边界，且无论是否允许内网，**凭据-目标一致性仍必须成立**。建议改成有限陈述：仅对已正确确认并唯一绑定的目标保持TLS校验/禁重定向，目标授权及来源归属另有独立验证。

当前[README](../README.md#L27-L49)、[AGENTS](../AGENTS.md#L372-L410)、[旧设计](custom-balance-v0.9.0.md)仍描述手填URL/Key和严格公网绑定。应标历史与现行规范，避免接手者按相反规则执行。[包版本](../package.json#L3)仍为0.9.0，而新章节叫0.9.1：若是候选修订标签请说明，不能只凭相同版本号判断运行构建。

## 4. 已有进展与测试缺口

- 新GUI在“baseURL恰好就是能返回余额的地址”这一合成前提下，可使用所选provider Key取数；此正例不证明模型根普遍可查余额。
- 上轮首次pending时A→B→A、begin→clear→commit的原epoch反例已转为通过。新source漏字段不能混称旧epoch修复完全无效。
- 下拉、两键并排、折叠控件代码可见，正式设置回归通过；本轮未做真实浏览器视觉验收。显示仍按内置块＋custom块；若排序要求包括跨块混排，须另明确，不能由orderedIds改动推断已支持。
- 新16项测试主要覆盖筛选、字符串URL允许、列表返回、缺provider错误；没有覆盖成功工具路径、实际发送的Key与目标组合、换provider的缓存失效、挂起凭据或旧配置生产迁移。
- 旧核心安全测试多数仍走legacy路径；它们通过不代表新provider分支被同样保护。**保留测试有价值，但不能把未执行新路径的测试当作新路径安全证明。**

## 5. 建议下一步先统一来源合同，再修局部

1. 按CP-07补齐已添加的预设＋自定义来源枚举（排除DeepSeek/MiMo）；同时决定余额端点如何取得。保留下拉选择源的方向，不用恢复手填Key，也不以缺少显式覆盖地址为由漏掉预设来源。
2. 定义一个可唯一定位的SourceSelection与一次FrozenTarget：owner/provider、余额URL/origin、引用及本次凭据、公开源修订/身份、预算。GUI与工具共用，不能分别选值。
3. 同步配置证明、源身份/epoch、工具cache和single-flight、客户端作废规则；变更provider及同provider目标/凭据都覆盖。
4. 明确迁移与支持范围：新条目、保留旧Key的旧id、无配置编辑服务、native/OAuth/无显式ref模式。未知来源不猜、不读私有token文件补能力。
5. 再做最小端到端矩阵：GUI/工具各自成功；旧Key不抢新Key；来源同id冲突拒绝；换源/改目标旧值与在途失效；凭据挂起按时返回；旧配置按迁移承诺处理；JSON提取/扣减/限流/失败宽限仍正确。

当前不建议继续试用新provider自定义条目；可先停用这些条目，内置渠道不必一并停。**没有读取真实配置，不能判断错发是否曾在你的机器发生，也不据此要求撤销全部Key。**

## 6. 复跑和交接

```powershell
# 当前FAIL断言缺陷存在；修好后改成正确行为断言，使用新证据目录
node .diagnostics/review-custom-provider-20261020/probes.mjs
node .diagnostics/review-custom-provider-20261020/audit-package.mjs
```

后台回归job `pwsh-6f316321dfe04a00`已收集exit0；复用代理已完成，无在途任务。当前报告仅对6284d9…源码包有效，不等同已独立验证当前运行副本。真实账号/额度池、窗口口径、策略UI及真实请求/重试注入仍按原计划验收，不以本轮发现替代那些工作。
