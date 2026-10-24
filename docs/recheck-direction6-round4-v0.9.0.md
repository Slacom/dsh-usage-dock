# 方向6第四轮独立复核：Z2/Z3与混币UI通过，凭据链仍需Q1–Q3

> 日期：2026-10-19。对象：41A6B229…本地包。承接[第三轮报告](recheck-direction6-round3-v0.9.0.md)。
> **结论：尚不予方向6整体放行；剩余问题收敛到凭据处理。**Z2、Z3原失败条件已通过，Z4增量混币UI通过；Z1的引用冻结案例通过，但显式Key及凭据回退/停用边界尚有缺口。
> 本轮仅只读产品审查、隔离探针和审查文档更新；未改产品/宿主、未部署/重启/提交/改标签/推送/发布。所有凭据为合成值，传输为进程内桩，不访问真实余额账户。
>
> **（2026-10-19 第五轮独立复核）Q2/Q3通过，Q1仍有F1/F2**：共用API Key四态通过；custom快照丢失/显式分支忽略冻结、MiMo忽略none均复现身份缓存污染。1281项回归首跑有一个旧1ms断言失败，单独复跑该25项脚本通过；另7项契约通过。见[第五轮报告](recheck-direction6-round5-v0.9.0.md)及[修复提示词](fix-prompt-direction6-round5-v0.9.0.md)。
>
> **（2026-10-19 整改者补记）Q1–Q3 已整改**：冻结粒度改为逐渠道的实际生效来源（显式 Key/Cookie 与引用同机制）、区分「未冻结/确认无凭据」以保住正常回退、引用候选遇空继续下一个、停用渠道在读取任何凭据前先过滤。
> 证据：`tools/test-usage-recheck-q1q3.mjs`（30 项）+ `tools/verify-q-mutations.mjs`（四项变异均被用例捕获）。Z2/Z3/Z4 未改动。
> 新包 `E56F9DE0…`（`41A6B229…` 作废）。真宿主冒烟、策略 UI、Android 仍未验证，本轮**不**声称已通过。


## 1. 已通过、回归与包

- 独立复跑32个回归脚本共1249项；另WorkBuddy契约7项，共1256项通过，无跳过。现有Z1–Z3的25项、混币UI的5项及旧Y1–Y4等均通过。
- [当前包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：156567字节、23文件、解包462711字节；23个payload与工作区逐字节匹配。
- SHA256 `41a6b22989ef38a2966fcfeec1c2eb8cf71757cf50553ae7e81ef00d6106861c`。
- SHA1 `3737632ca0cf5278152ddea239cacbbce95ded3b`。
- 入口及相关修改模块语法、git diff --check通过。

### Z2：自定义取消与逐条进度通过

真实apply→真实custom provider，虚拟DNS延迟100ms，第20ms取消：等待迟到DNS完成后仍零HTTPS发送。原快/慢混合场景：

```text
CANCEL_DURING_DNS: sent=[]
FAST_SLOW_CUSTOM: elapsedMs=8016
 A: balance=12, currency=USD, availability=ok, fetchedAt有值
 B: availability=unknown, errorCode=missing
```

不再返回空channels抹掉A。所有修改仅在隔离Node进程内注入并恢复。

### Z3：普通override的单事件同步与卸载通过

真实apply＋configEditor.configuration()普通override，启动两秒内每次只发一次reload、没有调用工具：

```text
startup 42ms: reads1, sections0
enable 73ms: reads2, sections1, 文本20%
threshold→45 103ms: reads3, sections1, 文本45%
focus→codex 135ms: reads4, 文本仅codex
disable 166ms: reads5, sections0
卸载后旧handler 197ms: reads仍5, sections0
```

立即apply后dispose、启动微任务尚未跑时，也未复活段落。

### Z4：混币UI与模型安全通过

真实DeepSeek provider→模型投影/策略→实际Badge组件（mock React）的独立重放：

- CNY10+USD2：模型unknown/null，不参与金额策略；胶囊“多币种”，详情“无法合计”并显示CNY10.00、USD2.00。
- CNY10+未知赠金2：未知项显示“2.00（币种未知）”，不冒充CNY或¥2，不称获取失败。
- CNY10+同币赠金2：模型12 CNY/ok，UI¥12.00及充值¥10.00/赠金¥2.00。
- 同币0+0：模型/UI保留0，不伪造成unknown。

该增量没有回退跨币不求和、不参与金额策略的安全行为。本结论为组件级离线验证，不冒充已部署真机。

## 2. Q1 / P1：只冻结引用，没有冻结显式Key，仍可污染身份缓存

### 原因

[index采样](../index.js#L436-L490)将显式Key哈希进identity，却只将引用值写入credentialSnapshot；collect又从liveConfig取cfgNow。[resolveApiKey](../plans/util.js#L397-L405)首先返回当前cfg显式Key，优先于引用快照。

所以“采样的引用就是发送的引用”已修，并不意味着“采样的显式Key就是发送的显式Key”。

### 实际探针

真实apply＋普通configEditor override＋真实OpenCode provider：开始显式Key A；身份采样期间凭据服务等待2100ms，override改成B；collect重读得到B。随后恢复A，等两秒配置缓存到期，再查询。

```text
EXPLICIT_KEY_SNAPSHOT:
first remaining=50, second remaining=50
resolutions=4, requests=1, actualTransmittedAccounts=[B]
```

B的已用50/剩余50被存入采样身份A；第二次当前为A，本应剩余10，却命中B的50。没有手改generation、没有修改产品源码或伪造缓存对象。

### 要求

- 固定每个可缓存渠道**实际生效的凭据来源和值**，含显式Key/Cookie和引用，不只冻结ref字典。真正发送必须与计算identity的同一份私有快照一致，或取数后用实际身份验证/拒绝回写。
- 显式Key有效时不应再依赖未使用的回退引用来证明身份；但仅跳过多余解析也不能替代快照绑定，因为其他请求条目的等待仍可能跨过配置变化。
- 保持来源优先级，不向模型输出秘密/指纹。补显式A→采样期间B→恢复A、多个渠道等待、引用轮换与缓存命中矩阵。

## 3. Q2 / P2：新增快照逻辑破坏正常凭据回退

### 3.1 DeepSeek账号不可用时，模型凭据被空快照屏蔽

[index](../index.js#L440-L442)跳过账号型DeepSeek的身份采样，这是“不缓存”的合理选择；但[统一fetchOptions](../index.js#L552-L558)仍给它传空builtin快照。resolveApiKey将空对象当成“已有权威快照”，于是拒绝正常DEEPSEEK_API_KEY回退。

实际同一配置/凭据服务、同一真实provider，账号服务不存在、插件未填Key、模型凭据可用：

```text
direct provider: error=null, balance=7.25
usage_status: errorCode=no-credential, balance=null
工具路径 resolvedRefs=[]
```

Web/provider可以成功，而模型工具凭空报告未配置。

### 3.2 OpenCode第一个引用为空、第二个有效时，也失败

[快照分支](../plans/util.js#L405-L412)在首个存在但空值的ref上立即return undefined，没有继续下一个候选。

真实provider对照：OPENCODE_GO_API_KEY为空，OPENCODE_API_KEY为合法合成值：

```text
direct provider: error=null, rollingUsage.percent=90
usage_status: errorCode=no-credential, windows=[]
工具路径解析了两个ref，但没有发送余额请求
```

原resolveCredentialApiKey会跳过空候选找到后面的有效值；冻结快照不应改变这项契约。

### 要求

- 区分“该渠道没有提供快照”和“该渠道完整采样后确认无凭据”，不能把不缓存/账号型渠道的空全局字典当成无Key证明。
- 采用逐渠道、逐生效来源的快照协议；未采样且不缓存的来源仍在工具预算内走原正常解析，或为其建立完整可信快照。
- 完整保留候选顺序及原空值/哨兵规则；空/缺失的前候选不能屏蔽后面的合法候选。
- 补DeepSeek无账号/无插件Key/有模型Key，以及OpenCode第一候选空或不存在、第二候选有效的真实apply/provider对照。

## 4. Q3 / P2：停用内置渠道显式查询，仍解析凭据

[identifyChannels](../index.js#L440-L468)对内置项只检查wanted和账号型，不检查该渠道enabled。参数保留显式请求以便返回disabled状态，identify却仍触碰其凭据。

真实apply，全部内置开关false，显式查询opencode-go：

```text
DISABLED_REFERENCE_ACCESS:
resolvedRefs=[OPENCODE_GO_API_KEY, OPENCODE_API_KEY]
status=disabled
```

确认的是不必要的凭据解析，没有声称已向余额上游发送Key。但它违背既定的“允许集合前置，停用零解析/取数”边界，返回disabled不能撤销已经发生的resolve。

**要求**：在字段/凭据解析前先以当前允许集合筛选内置与custom；为输出disabled保留原请求id，但不要用它去解析秘密。补停用内置显式点名、全局关闭、空集合、退场/已删除custom的resolve/DNS/请求计数均为零，现有custom范围修复不得回退。

## 5. 收尾范围

- Z2、Z3与Z4本轮通过，不再要求重做。
- Z1引用冻结原用例通过，但显式来源仍有Q1；Q2是快照接线引入的兼容回退，Q3是前置范围缺口。
- 只修Q1–Q3，建议先明确“允许渠道→选择实际来源→一次解析/冻结→身份/发送同源→正确缓存”的统一契约，避免继续逐个特例补丁。
- 真宿主tools/systemPrompt冒烟、策略UI、Android仍未验收；本轮仍没有部署/重启授权，不以此新增代码缺陷或声称实机完成。

执行提示词见[第四轮整改提示词](fix-prompt-direction6-round4-v0.9.0.md)。
