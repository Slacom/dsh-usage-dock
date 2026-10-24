# Usage Dock 额度感知与分阶段收尾：构建执行交接

> 日期：2026-10-19。工作区：`E:\WorkSpace\DSH\DSH Usage Dock`。
> **用途：交给执行模型构建；本轮只形成规划与交接，没有实现本文的新功能。**
> 本文汇总用户最新确认的要求；与旧规划冲突时，仅在本次明确修改的额度策略、缓存回退与失败阈值范围内，以本文为准。安全、凭据隔离、宿主契约和发布闸门不变。

## 0. 给执行模型的开工指令

```text
请在当前dsh-usage-dock 0.9.0未提交基线上，按本文实现“复用现有取数的Host快照＋自动额度感知＋正常/预警/收尾三阶段＋统一失败分类”。
先读AGENTS.md及本文，核验当前源码和真实宿主契约，再分批实现与测试。
按§6实现每Agent本次request路由观察和渠道自动选择，不能仅看UI/模型名/旧header；覆盖已安装Codex task/Reserve的后置改写及账号/额度池来源边界。
协作时最多同时运行一个子代理，优先复用本会话已有可继续的代理，不反复新建或并发扇出。
不要另开一套供应商轮询；不要把提示词回调变成网络请求；不要让模型每步调用usage_status。
胶囊与自动提示必须共用按渠道/身份隔离的状态与计数：暂时失败1～4次用缓存，第5次报固定获取失败；明确配置/权限/能力问题立即获取失败，明确身份过期立即报查询身份过期；这些失败状态均属正常阶段、无行为规则。
正常时只给额度或允许的状态信息，只有预警/收尾阶段才注入相应规则。旧规则必须能撤销。
具体配置、固定模板、section/context注册对照与最终文本示例见§7.4～§7.8；本交接默认固定模板随动态context原子投放，不能把“固定规则”误做成正常时也常驻的section。
实际阈值、绑定和其它待确认项见第10节：不要擅自填20%、50%等默认值；先完成框架，未配置不启用。
完成真实失败→通过测试、全量回归、本地构建和交付说明，再交独立复核。
禁止改DSH宿主、覆盖已安装profile、自动重启、commit、改标签、push、Release、npm publish。
```

## 1. 用户目标与非目标

### 1.1 目标

模型执行**当前任务**时，无需用户重复提醒、无需依赖模型主动调用工具，就能在后续模型请求中获得对应渠道额度；低于显式配置的阈值时进入预警或安全收尾。

用户确认：

1. 复用插件现有额度采集，减少重复访问供应商。
2. 自动添加到提示词的内容限定为：**额度信息、模型供应商/身份切换信息、明确的查询身份过期信息**。额度查询失败只允许后文规定的固定简短状态，不发具体失败原因。
3. 偶发失败不打扰模型：同身份缓存可在暂时失败第1～4次继续使用，必须标明缓存和原采样时间，并按该缓存额度判断阶段。
4. 暂时失败第5次及以后，不再携带旧额度，只给固定“获取额度失败”。
5. 明确配置/权限/能力问题不等5次，直接获取失败；明确身份过期直接报告身份过期。
6. 获取失败、身份过期等**查询不可用状态一律归正常阶段**，不限制模型正常运行，不注入预警/收尾规则。
7. **正常阶段本身不添加任何行为规则**；只有预警或收尾阶段才分别添加对应规则。
8. 胶囊与提示词采用同一机制、同一有效状态、同一失败计数；暂时失败阈值统一由现有8次改为**5次**。

### 1.2 不做

- 不做强制停机、杀任务、自动换模型、自动重启。
- 不声称提示词能保证绝不超额或额度耗尽后仍能生成交接。
- 不开启方向5安装/更新功能，不恢复退场渠道，不修改供应商特例业务。
- 不借本次改成全量Web响应缓存/全渠道后台轮询，原来暂缓的方向4不能顺手开启。
- 不扩大自动提示为技术报错、诊断日志、上游文案、账号资料或工具调用指导大全。

## 2. 当前基线：已有什么、还缺什么

### 2.1 已有事实

- [插件版本](../package.json)为0.9.0，本地构建；上一公开版为0.8.4。
- 用户已确认新会话里的模型能实际调用usage_status读取额度。[真实冒烟记录](direction6-0.9.0.md#L160-L210)可参考。
- [GUI轮询](../client.js#L1577-L1616)在浏览器侧每约30秒调用取数路由；[Host路由](../index.js#L166-L240)按请求实时采集。
- GUI保留旧值/灰化在浏览器；[当前阈值](../client.js#L709)仍是8次。
- usage_status另有成功缓存、single-flight和凭据身份隔离。**这不是现成的GUI/提示词共享快照**；账号型渠道不能因为增加快照就取消既有“不证明身份就不复用”的保护。
- [当前策略](../plans/usage-policy.js#L208-L228)是常驻静态规则＋工具返回policy，尚不是本文要求的被动自动感知/两档阈值/正常无规则。
- 工具schema曾因`type`数组不被真实宿主支持而静默注册失败；已经修成oneOf可空类型，必须保留真实校验器回归。
- 最近提交者记录的包为5A9DE120…、全量1328项另契约7项；数字和hash均须开工时重新核验，不照抄、不据此冒充本次已验收。[第六轮独立复核](recheck-direction6-round6-v0.9.0.md)仅绑定更早411C577C…包。

### 2.2 本次交付主体

新增**Host内存中的额度观察快照和统一显示/策略状态**，串通既有GUI取数、工具取数与动态提示词。Host指运行插件的DSH进程：本机桌面部署就在本机内存，远程DSH则在远程进程内存。快照不是供应商数据库，也不是浏览器DOM；首版不要求写磁盘，重启后可为空。

## 3. 取数复用与共享状态契约

### 3.1 最小架构

```text
既有GUI路由采集 / 用户主动usage_status采集
                 ↓
     逐渠道结构化归类、身份校验、采样去重
                 ↓
        Host观察快照＋统一状态机
            ├─ GUI胶囊/详情
            └─ 动态context＋必要的阶段规则
```

- 自动提示只读内存，**零额外上游请求**；不调用usage_status来实现自动感知。
- 既有采集完成后顺带发布成功或失败观察；不从屏幕文字、DOM、取整数值或React旧值反向读取。
- 可分层保存原始内部观察与脱敏投影，但模型只读取白名单投影；不能把wire直接送进提示词。
- GUI与模型不能各数一套失败次数。现有客户端fallback须迁移或调整为消费统一状态，不得二次计数、双重延迟。一致指同一快照版本/身份的处理一致，不保证浏览器断线时两端可见版本仍同步；浏览器到Host的连接失败不能冒充供应商采集失败，Host侧已有的成功观察也不能因此被客户端覆盖成失败。
- 不要求把所有GUI/工具请求改为共享HTTP响应；明确工具主动查询与缓存契约，不能用这次“发布观察结果”偷换成不安全的跨账号缓存。
- GUI focus/visibilitychange/展开强刷与35s Host/40s客户端兼容保持；不降低原轮询频率。

### 3.2 快照最低信息

内部至少能表达：渠道稳定id、所属配置/凭据或会话代次、观察顺序/采集标识、最近成功原始数值及单位、原成功采样时间、最近采集结局、连续暂时失败次数、当前可展示状态、当前阶段。

要求：

- 数值保留精度，0和负数有效；缺失不是0；比例明确为剩余；金额带币种、积分带单位；混币不相加。
- 使用缓存不得刷新原fetchedAt，不得显示为“刚查到”。
- 同一采集结果被多个消费者读取、重复emit或最终整批回传时只应用一次；缓存命中不是新采集。
- 并发结果不得由旧观察覆盖新观察。成功清零须以更新且同身份的真实采集为准，迟到成功不能撤销新发生的失效或失败。
- 换Key、切账号、换来源/URL、删除或停用渠道时，旧缓存、计数与迟到结果均失效。
- 无法证明当前账号身份时，不得把上一个账号的近期快照当成本账号；以可验证会话代次/失效机制解决，不能只依赖短TTL。
- 私有身份指纹只留Host内部；不输出Key/Cookie/token、账号邮箱、凭据引用、路径、URL或上游原文。

### 3.3 无GUI/停更边界

首版优先复用既有取数，**不新增第二套定时采集器**。界面关闭或轮询停止时，没有新采集就没有新额度，也不能假造失败次数。

此时必须保留真实采样时间/缓存标记，不宣称实时或保证无GUI任务仍受及时保护。是否迁移为Host统一调度、是否增加按时间限制缓存参与决策，属于第10节待确认项；不得暗加默认过期阈值或自动轮询。不要将“时间经过了”伪造成“已经采集失败5次”。

## 4. 失败分类：内部细分、模型压缩

不能只沿用现有`api/network/exec`大类：同一大类可能混合登录失效、付费拒绝、网络故障或运行时缺能力。应保留结构化reason/httpStatus/credentialState等足够事实再分类；不要扫描自由报错文案里出现的“401/token”就认定过期。

| 类别 | 典型情况 | 处理 | 自动提示词 |
| --- | --- | --- | --- |
| T 暂时失败 | 超时、暂时断网/DNS/连接中断、408/425/429、5xx、偶发空响应/坏JSON/缺字段/无法解析数值 | 计入同渠道同身份的连续暂时失败；第1～4次可用同身份成功缓存，第5次移除旧值 | 前4次只给缓存额度及采样时间；第5次起仅“获取额度失败” |
| P 明确配置/权限/能力/安全问题 | Key未配置、引用明确不存在、Key明确无效/撤销、明确无查询权限；本地URL/JSON路径语法无效；依赖未安装/不兼容；目标未确认、私网/IP绑定等安全拒绝 | 立即禁止沿用旧值，不等待5次 | 仅“获取额度失败” |
| A 明确查询身份过期 | 结构化会话失效、明确要求重新登录或重新授权 | 立即失效旧值 | 仅“用量查询身份已过期” |
| I 身份/配置切换 | 供应商、账号、Key、凭据来源或查询目标变化 | 立即作废旧值与计数，等新身份数据 | 只给必要的简短切换信息；不附旧额度 |
| C 主动取消/作废 | 被新刷新替代、卸载/停用、切换身份后的旧响应 | 丢弃；不加失败次数，也不充当成功清零 | 不新增失败提示 |
| S 成功或合法额度状态 | 可用余额/窗口、0、负数、unlimited、明确的混币无法合计 | 更新成功状态；只对有效且单位匹配的数值判阈值 | 安全的额度信息，不伪装成查询故障 |

### 4.1 必须区分的边界

- 401/403本身**不等于身份过期**。明确鉴权拒绝但未证明过期归P；若来源/含义不能确认则不冒称过期，先作T，且仅可沿用同身份缓存。
- 无法确定原因的一般查询失败先作T；已证明本地配置错误/能力不存在/安全拦截的不能因文案模糊退回T。
- 偶发缺额度字段可以T；本地JSON路径语法错误是P。明确不提供查询能力是P，不是无限重试的T。
- 明确从未登录/未配置不能编造成“过期”；明确要求重新登录的已失效会话归A。
- 查询到0/负余额不是失败，仍按阈值判阶段。一个HTTP402或“付费被拒”的模糊报错不能编造余额0，也不能自动认定模型主账户耗尽；应按已核实的查询权限/服务语义分类。
- 供应商限制请求频率不等于套餐额度用尽。
- 混币/unlimited等合法状态不应为了复用旧单币数值而归成暂时故障；不得伪造合计或耗尽。
- TLS/证书失败不能导致关闭TLS校验；网络类故障可T，已确定运行时缺安全绑定能力/安全策略拒绝归P。模型不接收这些细节。
- 如果一个账号渠道先失败但既有安全回退来源最终成功，按最终成功观察处理，不先把中间失败广播给模型。

### 4.2 计数规则

- 按渠道＋身份分别计；超时→429→格式异常仍连续累计，不因原因变化重置。
- 指实际完成的采集失败5次，不是读缓存5次、模型请求5次、每个工具结果各算一次。
- 一次同身份更新的真实成功清零；单纯缓存命中不清零、不刷新成功时间。
- 第1～4次没有可用缓存：不输出伪造额度，也不提前报告获取失败；阶段正常。
- 第5次及以后：当前模型可见额度数值移除，仅固定获取失败；阶段正常。恢复成功后恢复数值并重新判阶段。
- P/A立即覆盖缓存显示，并将旧成功标为不可再用于fallback；后续即使换成T类错误，也不能复活旧缓存或退回“前四次暂不提示”来掩盖已确定的失效。没有可信恢复证据时保持固定失败/过期状态，直到当前身份新的真实成功，或确认发生配置/身份变更后按新代重新建立状态。不要让之前排队的旧成功把它们抹掉。

## 5. 三阶段与规则注入

### 5.1 判定输入与阈值

阶段：`normal`（正常）、`warning`（预警）、`closing`（收尾）。由插件确定性判定，不要求模型自行计算阈值或猜错误原因。

- 只使用当前明确绑定/关注、启用且身份有效的渠道。
- 正常采样与T类第1～4次的合法缓存都可参与判定；缓存必须附标记。
- P/A、T第5次起、无数据或无法匹配单位：normal。**normal在此表示不施加额度规则，不表示额度充足。**
- 每种指标支持分别配置预警和收尾阈值；更低的剩余值更严重，合法配置应满足收尾阈值低于预警阈值。
- 延续“低于”的`<`含义，等于边界不触发；如需`<=`，先请用户确认，不静默改变。收尾优先于预警，只发当前档规则。
- 百分比、金额、积分不能混比；金额须币种一致。积分阈值尚无确定授权数值，不擅自套用金额字段。
- 仅配置一档时，只启用那一档；两档都未配置就不注入阶段规则。默认不启用，不自动补示例阈值。
- 多窗口只评估已确认用于模型调用的相关窗口；不能将MCP等其它用途的窗口混进来。
- 多渠道只在显式绑定和策略范围内聚合阶段；不能默认取所有已启用渠道的最严重状态，导致无关渠道影响当前任务。

### 5.2 各阶段输出

| 阶段 | 数据 | 行为规则 |
| --- | --- | --- |
| normal | 有效额度/缓存标记/采样时间，或被允许的固定状态/必要切换信息 | **没有任何行为规则**，连“请正常继续运行”也不要附加 |
| warning | 同上 | 提醒额度较低，缩小后续工作范围，避免新增大规模、长时间或大量并发工作；保留收尾余量 |
| closing | 同上 | 不再扩张任务；完成必要的一致性操作，保存进度，做必要验证，输出已完成/未完成/风险和可恢复步骤，进行交接 |

必须：

- 删除/替换现有“正常时也常驻”的完整额度策略说明；不能只是叠加一份新提示词。
- 从warning/closing恢复normal时，当前生效规则必须撤掉；不能仅不发送新规则、让旧规则继续有效。
- 快照须能明确替代此前额度/阶段快照；错误变normal时不额外写“解除限制、继续干”等行为指令。
- 不自动commit/push、不杀已运行工具、不半途破坏原子写入；不自动切换模型。
- 当前任务内的单向锁存、迟滞、充值后强制人工解锁等均**未确认**，不要擅自增加。按最新有效状态重算并正确覆盖旧规则。

## 6. 当前会话渠道自动识别：具体实施主线

> 研究依据：[当前会话渠道自动识别研究](research-quota-route-binding-20261019.md)。已核验实际宿主与安装连接插件源码，并做隔离无网络中间件正负例；不是“所有计费账号已能自动证明”的声明。

### 6.1 目标分层与不可混淆的概念

**本次必须实现自动识别主流程，不是让用户每次切模型后手工选当前额度渠道。**但识别分三层：

1. 本次请求route/model：由真实agent/request链观察，不能读UI名称猜。
2. route→Usage Dock渠道：按已核验内置表或显式配置精确匹配。
3. 账号、余额来源和额度池：验证所选快照确实适用；route匹配不自动证明此层。

人工绑定是特殊/自定义路由与身份来源的兜底，不替代前两层的自动选择。`quotaFocusChannels`是允许使用哪些渠道的白名单，不是“当前正在用哪个渠道”的手工选择器；在已允许范围内由本次route自动选目标，不取所有关注渠道的最严重状态。空列表仍不默认为全部渠道，保持已有授权边界。

### 6.2 真实读取接口与顺序

- assemblyContext只有`agent/scope/signal?`，没有顶层provider/model/account。使用`assemblyContext.agent`关联本Agent的观察记录。
- Agent.options只是seed，UI选择在step组装时采样；上一次requestHeader到本次buildRequest才更新，不能用它们代替本次请求配置。
- 最佳公开观察点是`agent/request`的外层`await next()`之后。记录payload.agent、turn、step及返回的provider/model，不改配置，不复制整份config。
- 核心流程是`assemble → agent/request → llm.prepareCall → refreshContext → buildRequest → stream`。本次context在prepareRequest之后重新求值，因此可在**同一次模型请求**使用新观察；同step重试也必须重新记录。
- 当前LLM核心prepareCall保留provider/model身份，不再换路由；认证仍可在stream时晚解析，不能把路由记录称为最终token/账号证明。
- 不额外调用resolveCallConfig、解析模型目录、发status或查供应商来“识别当前路由”；不在context中做任何IO。

这也解释了§7默认选择动态context原子投放：最初assemble时当前请求路由可能还未确定，不能在独立固定section提前套旧渠道规则，期待后续context能把它自动撤销。

### 6.3 观察器的具体安装、隔离与生命周期

**不能只在apply早期注册一个全局prepend监听就宣称总能拿最终路由。**当前Codex Connect的task/Reserve真实存在post-next改写：task可改provider/model，Reserve可普通↔gpt-reserve并在错误重试中改档。

推荐在已知连接插件apply的路由写入器安装完成后，为每个Agent晚装scoped observer：

1. 在Usage Dock受控生命周期内先订阅公开`agent/created`，回调只执行attach，不return disposer；该事件是serial，不能让truthy返回值意外截断其它监听。
2. 获取可选`agents`服务，遍历公开`agents.list()`给已有Agent补装；用Map幂等，覆盖订阅与枚举之间的创建竞态。
3. attach通过公开`agent.ctx.on('agent/request', ..., {prepend:true})`注册，使其包住此前已安装的标准路由写入器。
4. **必须检查`payload.agent === subject`**：scope准入允许祖先监听接收后代事件，不能只靠scope过滤。按Agent对象WeakMap保存观察，不使用全局currentModel。
5. 同step每个请求/重试重新生成attempt序号；只存provider/model与私有时序信息，读context不推进序号、不改变采集计数。
6. `await next()`失败应抛回原错误；本插件观察/格式化失败则清掉本Agent观察、让额度阶段保持normal，不破坏原请求或冒充供应商采集失败。
7. 保存所有agent.ctx监听disposer，`agent/disposed`清理；Usage Dock卸载也必须主动清理它们，因为这些监听默认跟随Agent生命周期，不会自动跟随本插件卸载。
8. Agent补装时若本次waterfall已经开始，不能追溯插入其已快照的监听链；收到下一次有效观察前不套旧规则。

**安装条件与边界必须交付：**已审查连接链的writer已安装，observer之后没有新增更外层prepend writer。当前标准Codex链必须覆盖，而非只测最简单installModelSelection。连接插件热重载/晚装writer后，旧顺序保证失效，应使观察无效并在已验证的重新激活顺序下补装；未支持此生命周期时保持normal、本地说明，不自动重启。不能靠读取私有_hooks、setTimeout抢顺序或假定scope优先级解决。未知后来注册的outer writer没有通用提前识别保证，不能宣称任意插件全兼容。已知可观察的重载/适配器变化应使能力闸门失效；无任何公开通知的任意晚插入writer无法自动保证当次被发现，属于明确未支持场景，不得伪造“自动检测后安全降级”的验收结论。

下列为**待实现伪代码**，展示生命周期与字段接口，不是现成模块或完整产品代码。`reviewedChainReady`是必须通过启动链/注册顺序测试建立的能力闸门，不得无条件写死true。

```js
let routeObservations = new WeakMap()
const attached = new Map()
let alive = true

function attach(subject) {
  if (attached.has(subject) || !subject.ctx) return
  let attempt = 0
  const dispose = subject.ctx.on('agent/request', async (payload, next) => {
    if (payload.agent !== subject) return next()
    const ticket = ++attempt
    routeObservations.delete(subject)
    let config
    try { config = await next() }
    catch (error) { routeObservations.delete(subject); throw error }
    try {
      if (alive && !payload.signal?.aborted && ticket === attempt && reviewedChainReady(subject)) {
        routeObservations.set(subject, Object.freeze({
          turn: payload.turn, step: payload.step, attempt: ticket,
          provider: config.provider, model: config.model,
        }))
      }
    } catch { routeObservations.delete(subject) }
    return config // 不改路由，不吞下游错误，不输出整份config
  }, { prepend: true })
  attached.set(subject, dispose)
}
const detachCreated = ctx.on('agent/created', ({ agent }) => { attach(agent) })
for (const agent of agents.list()) attach(agent)
const detachDisposed = ctx.on('agent/disposed', ({ agent }) => {
  attached.get(agent)?.()
  attached.delete(agent)
  routeObservations.delete(agent)
})
// ctx.effect卸载时：alive=false；调用上述根监听与全部attached disposer；
// 清空attached并替换WeakMap。须处理可选服务缺失与注册部分失败的清理。
```

已完成的隔离探针验证：标准选择器正例、后来outer改写负例，以及已知global writer先注册→created/list晚装scoped observer正例；后者可看见openai-codex/gpt-reserve。父子scope额外验证精确subject守卫，另保留未来outer writer仍会漏观察的负例。此探针不等于完整宿主端到端通过，执行仍须补真实链测试。

### 6.4 内置候选映射：用真实route id，不用模型名

| 实际注册provider | 自动候选渠道 | 进一步适用条件 |
| --- | --- | --- |
| openai-codex | codex | 同连接账号且model适用同额度池；Reserve/额外metered桶单独核验 |
| workbuddy | workbuddy | 国内版池，账号来源有证据或明确同池绑定 |
| workbuddy-ai | workbuddy-ai | 国际版池，不与国内积分合并 |
| deepseek-account | deepseek＋source=account | 与DSH账号余额源一致；API回退值不直接替代 |
| deepseek-official | deepseek＋source=api | 与本次API Key账户池匹配；不误用GUI优先返回的account值 |
| 其它pi-ai/自定义provider | 明确绑定的现有渠道或custom稳定id | 用户按精确provider和必要model条件配置；禁止按模型名、协议名、目录默认URL猜 |

- 内置表只针对研究中核验的连接契约/实际启用标准路由；仅发现一个同名包已安装不等于adapter激活。
- 同一DeepSeek模型从WorkBuddy调用，应匹配WorkBuddy积分，不是DeepSeek官网余额。
- WorkBuddy loopback shim的临时端口不是稳定映射键。
- MiMo的Cookie余额账号与模型API Key账号、OpenCode Zen与Go套餐、自建通道同名厂商均不可自动视为同一池。
- 如有显式覆盖，先匹配provider＋精确model的规则，再provider级规则，再已核验的内置候选；同优先级冲突必须拒绝/标歧义，不依赖数组顺序或挑最低余额。不默认支持任意正则匹配。

### 6.5 账号/源证明如何接入已有采集

**Codex可落地的改进：**当前0.2.0-alpha.6公开captureActiveAccount。原本就要采集时先捕获store，再从该store.accounts取active安全摘要，使用同一捕获store调用readOpenAICodexRateLimits；只把accountKey的Host私有摘要随观察保存，不传邮箱/名称/token。不要先后读accounts相等来替代冻结，防A→B→A串源。老版本没有该能力时要检测并降级，不假装同等可靠。

这证明额度采集账号，不自动固定模型adapter稍后选的认证。必要的当前安全账号元数据可在有预算/取消控制的异步request预处理读取；不能在context里读磁盘，也不能调用store.read拿token。与最终认证绝对同源仍需连接端支持，交付明确观察时刻/晚绑定的自然边界。

**WorkBuddy不能误判：**完整status可能有visibility.account，但它在credits请求前从runtime读取，随后store.current才取本次credits凭据，并非同一冻结快照。不能仅哈希该字段就当本次积分来源证明；昵称/domain/过期时间也不行。原status本身会查计费上游，不能为识别再额外查询。首版自动路由分国内/国际可做，强账号证明须可靠元数据或明确绑定；缺失时不跨账号用历史积分。连接端补安全同源元数据属于另行授权协作，不能直接修改已安装依赖。

**DeepSeek必须分源：**快照保留via和源身份。GUI仍可原样安全回退，但自动策略只复用与当前route绑定源相匹配的那份采集；不为满足映射再查另一份余额，也不把account失败→api成功算成同源恢复。

所有渠道都要区分“程序验证”“用户明确声明同池”和“未验证”。人工声明不能标成程序证明；一旦绑定任一端配置/身份代次变化就作废。无法核验的约束不能偷偷用近期TTL代替。

### 6.6 显式绑定的配置及识别状态

拟新增独立`quotaRouteBindings`配置入口（字段形态由执行schema落实，可沿用JSON数组字符串约定）。至少表达：稳定binding id、enabled、精确provider、可选精确model、targetChannelId、sourceKind/account或api约束、quotaPool、确认依据及绑定修订。无原始Key、Cookie、URL、账号邮箱或凭据文件路径。Host私有身份摘要/epoch不回传模型，也不要求用户手填哈希。

普通用户只为自动表无法证明的路由配置一次归属；后续每请求自动按当前route匹配，而非每次切换重新选择。保存先校验：target存在且启用、非退场id、无歧义、来源/单位/池兼容；停用/删除/修改绑定即时作废对应Agent选择、旧阶段和在途结果。

私有解析状态至少区分：未观察、本次route已观察但链未验证、无映射、映射冲突、候选已匹配、源/账号/池可用。前几种属于路由/绑定状态，**不是额度采集失败**：不累计5次、不发技术细节、不冒称身份过期；当前阶段normal，不从其它渠道补余额。只有通过已授权绑定及当前源适用校验，才读该渠道Host快照并按§4/§5处理真实采集结果。

### 6.7 切换、重试、子代理与模型提示去重

- 初次有效识别只是初始化，不发“刚刚切换”。跨provider/账号/额度池的确认变化立即停止使用旧目标快照和计数；新目标无数据时normal，不移植旧余额。
- 只改变模型名但仍同一已证明池，不应误报供应商切换；同provider切Reserve等不同池时仍须重新绑定选择，不能复用普通池收尾规则。
- 宿主installModelSelection已有模型切换通知，优先复用，不再重复一条同义消息。只有额度来源变化确需补充且宿主未覆盖时，才发安全简短事实，不给内部路由/账号明细。
- 主会话与子代理用各自Agent对象观察；孩子可继承或覆盖父路由，不能由父路由推断。祖先scoped监听必须subject守卫。外部执行/不经过本进程agent loop的模型不能承诺自动感知。
- 同step错误重试也可能入Reserve/退出Reserve/换中间件配置，必须再观察再渲染；不能仅按turn缓存一次。插件不自行更换模型或控制供应商fallback。
- 可用公开LLM stream/header作后验一致性检查，但只能用于之后的失效/本地诊断，不能假称已修正本次提示词；避免把标题/摘要等非Agent辅助请求当当前会话切换。

### 6.8 执行顺序与必须新增的识别验收

新增独立路由观察/纯映射模块，再接§7.readPublicQuotaView；不要塞进网络provider或让模型自行判断。

1. 验证当前宿主版本/公开服务、真实全局writer、agent创建顺序；落实晚装scoped observer、已有Agent补装、精确subject守卫和清理。
2. 实现RouteObservation和精确候选/显式绑定解析；数据、来源证明、阶段均按Agent和代次隔离，沿用授权白名单。
3. 接入原采集的源证明（优先Codex冻结store能力）；不能证明的渠道/池如实限制并提供明确绑定入口。
4. 接动态context同次refresh，检查第一次请求、工具续轮、同step重试、配置/身份切换与normal旧规则撤销。
5. 交付逐渠道自动覆盖矩阵：已自动识别route、已证明适用池、需用户绑定、无法验证/未支持分别标明。不能把整个任务仍留成“识别待研究”，也不能声称全部真实计费账号自动可知。

识别验收最少覆盖：

- R1 标准UI选择→本次request实际route，UI已切但本step仍锁旧选择时不提前跟UI走。
- R2 旧requestHeader与本次provider不同，不晚一拍；首次尚无header也可识别。
- R3 当前Codex task跨provider改写、ordinary→Reserve重试→ordinary恢复，observer拿最终已审查链返回；不盲套codex主桶。
- R4 已知writer先注册、created/list晚装正例；后来outer writer负例必须复现且明确能力边界，不声称prepend绝对保证。
- R5 已有Agent补装/创建竞态/正在进行的request不能追溯观察；卸载、已知可观察的热重载/后加writer使旧保证失效时不沿用旧规则；无通知任意插入的限制按R4负例如实记录，不伪称已能自动发现。
- R6 主/子Agent相同模型不同provider，及祖先scope监听准入，计数/目标不串；外部Agent说明不支持。
- R7 DeepSeek account/api不混、WorkBuddy国内/国际不混；MiMo Cookie与API Key未明确对应不猜。
- R8 Codex捕获账号A后切B/切回A，额度采集仍归A；当前身份不匹配就不复用；无capture能力版本明确降级。
- R9 WB visibility与credits可能来自不同时间身份，不能误认证；不能以额外status查询解决身份。
- R10 自定义/别名路由、精确model覆盖、同级歧义、删除/停用/Key和绑定修订变化、退场目标均正确。
- R11 识别不确定只normal，不造获取失败/过期、不计采集失败、不发送技术诊断；进入warning/closing前必须有当前目标的适用数据。
- R12 供应商/池切换notice与宿主去重，初始化不误报，所有内部id、账号摘要和实际凭据不进模型文本；观察与context多次读取无新增供应商请求。

## 7. 提示词通道与真实宿主契约

### 7.1 已核验事实

当前真实宿主的[循环源码](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L902-L1008)中，新用户turn和工具批次结束后的新step都会重新assemble；函数式section.text同步求值。[请求内部](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1043-L1167)同step重试不重跑section，但会refreshContext。

[刷新契约](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js#L314-L345)保留已接受的sections/tools/variables，重新求值动态context.text。text是同步回调，不支持在里面await取数。这些诊断提取文件可能未入库；执行环境缺失或宿主已更新时，须从实际宿主归档重新核验，独立Node/PowerShell不能直接读取归档内的嵌套路径，不能拿旧提取替代当前契约。

### 7.2 推荐实现

- 动态额度/阶段使用公开systemPrompt.context的同步text回调读取Host快照，覆盖请求准入与重试。
- **本交接默认采用“固定规则模板＋动态context原子投放”**：规则正文固定在插件代码里，只有warning/closing才随当前额度快照投放；normal不投放规则。具体配置、section/context注册对照及样例见§7.4～§7.8。
- 之前讨论的“固定规则section＋动态额度context”是逻辑分工，不等于正常时也把规则常驻在系统提示词。严格normal零规则与同step重试都要满足时，当前宿主不能靠一个已组装的section完成实时撤销，因此不默认采用条件section分发；不改宿主、不用隐藏技巧规避。
- 只有用户明确接受§7.6的重试边界，或未来宿主提供经验证的每请求section重组能力时，才可改成按阶段启用的section＋context。不得在执行时悄悄放宽正常阶段零规则要求。移除现有常驻完整策略section，避免旧新规则并存。
- 回调不发网络请求、不调用工具、不推进失败计数、不修改采样时间、不做磁盘IO。
- context未变化时文本保持稳定。不要逐秒刷新“距今几秒”或生成当前时间造成无意义快照；使用原采样时间和真实数据/状态变化。
- 对动态文本按宿主契约考虑`interpolate:false`，避免将外部文本误作模板变量；内容仍必须白名单重建。
- context可能被includeRuntimeContext/suppressRuntimeContext抑制。先验证所用Agent配置；是否在启用策略后注册required上下文需明确说明并尊重用户选择，不能暗绕用户关闭设置。
- 不通过steer/唤醒制造额外推理，不随每次轮询发普通用户消息，不按token中途打断生成。下一次请求才能读到新数据。
- 缺systemPrompt服务不影响原胶囊/路由/usage_status；能力缺失在本地说明，不能冒充自动策略已经生效。

### 7.3 模型可见内容边界

允许：渠道安全名称、额度数值及单位/窗口、缓存标记和原采样时间、当前阶段、必要的切换说明、固定查询失败/身份过期状态，以及warning/closing当前档规则。

禁止：HTTP码、DNS/TLS/代理原因、JSON路径、响应体、上游文案、异常栈、接口URL、账号邮箱、Key/Cookie/token、内部身份指纹、失败计数过程日志。

“获取额度失败”“用量查询身份已过期”均不得附排障建议或解释性技术尾巴。详细分类只在本地界面/脱敏诊断保留，且本地也不得打印秘密。

自动提示与用户主动usage_status分清：保留工具的可用性/兼容契约，新增状态应遵守真实output schema/render。若为统一显示而调整工具状态，不可静默改变其“主动查询”含义，须在交付中明确并测试；不再把旧工具policy与新动态阶段规则各计算一套冲突结论。

### 7.4 “固定规则section＋动态额度context”到底怎样分工

之前讨论的两种内容应分开管理：

| 内容 | 插件如何维护 | 何时变化 |
| --- | --- | --- |
| 固定规则模板 | 插件代码中的warning/closing两段固定正文，不从上游响应生成，不让模型自己编规则 | 只有用户调整规则设计时修改；采集额度不会改写模板 |
| 动态额度事实 | Host快照的脱敏视图：当前渠道、额度、来源、采样时间、阶段或允许的固定状态 | 新采集、身份切换、失败状态、策略配置变化时更新 |
| 投放方式 | 优先在同一个动态context中原子组合“本次事实＋当前档固定模板”；section方案的限制见§7.6 | 每次模型请求准入读取，不额外访问供应商 |

**“固定”指规则文字固定，不指每个请求都必须携带规则。**最初的“常驻固定规则section＋动态context”若照字面实施，会使normal也带规则，已经与用户后来确认的要求冲突。不能让执行模型沿用最初建议而忽略后来的约束。

本交接具体采用：

```text
Host统一状态 → 当前Agent的安全视图 → normal：额度事实
                                  → warning：额度事实＋固定预警模板
                                  → closing：额度事实＋固定收尾模板
```

默认不新注册一个常驻额度规则section；旧的`dsh-usage-dock.policy`常驻section需要替换。固定模板仍独立维护，动态context只负责选择和投放，并不意味着每步重新生成一套规则。

### 7.5 用户配置入口与建议字段

**用户不需要把规则手动粘贴到DSH模型系统提示词里，也不需要编辑宿主文件。**执行模型在本插件配置中提供开关、关注/绑定渠道与阈值；插件自己注册section/context。手动粘贴一份规则会绕过开关和撤销机制，不作为本次配置方法。

下表是给执行模型落地schema的建议接口，**不是声明当前版本已经支持所有字段**。现有字段复用及旧单阈值迁移须按§8、§10说明，不自动写用户profile。

| 配置 | 建议字段/入口 | 初始值与语义 |
| --- | --- | --- |
| 自动感知总开关 | 复用或明确迁移`quotaPolicyEnabled` | false；关闭时自动额度context为空，GUI/主动工具不受影响 |
| 关注渠道 | 现有`quotaFocusChannels` | `'[]'`；JSON数组字符串，不默认关注所有渠道 |
| 实际路由绑定 | 公开路由事实＋明确的绑定配置入口 | 必须说明当前provider如何映射到渠道；关注列表本身不等于已证明计费映射 |
| 剩余比例预警阈值 | 拟新增`quotaWarningPercentThreshold` | 0=未配置，不是0%就预警；有效比例范围与现有规范一致 |
| 剩余比例收尾阈值 | 拟新增`quotaClosingPercentThreshold` | 0=未配置；配置两档时收尾值低于预警值 |
| 余额预警阈值 | 拟新增`quotaWarningBalanceThreshold` | 0=未配置；不套用胶囊告警金额 |
| 余额收尾阈值 | 拟新增`quotaClosingBalanceThreshold` | 0=未配置；配置两档时收尾值低于预警值 |
| 余额币种 | 现有`quotaBalanceCurrency` | 空=不启用金额判据；与额度币种匹配 |
| 积分阈值 | 另行明确单位与配置设计 | 不能借用金额字段；未确定前不开启积分阈值判据 |

示意配置：**下面不含任何已获确认的实际阈值；新字段须先实现才能保存使用。**

```json
{
  "quotaPolicyEnabled": false,
  "quotaFocusChannels": "[]",
  "quotaWarningPercentThreshold": 0,
  "quotaClosingPercentThreshold": 0,
  "quotaWarningBalanceThreshold": 0,
  "quotaClosingBalanceThreshold": 0,
  "quotaBalanceCurrency": ""
}
```

启用步骤必须在交付说明中写清：选择/确认实际渠道绑定→填写需要启用的阈值及单位→保存→开启自动感知→检查模型实际请求中的快照。开关开启而两档均未配置时，仅提供normal额度/固定状态，不投放规则。旧`quotaPercentThreshold`/`quotaBalanceThreshold`不能被暗中当成新两档字段。阈值配置无效是策略配置问题，不是供应商额度采集失败；不得因此将仍有效的额度改成“获取额度失败”或增加采集失败次数。

规则正文首版由代码中的固定模板维护；本次不默认增加任意提示词编辑器。schema字段须按项目要求volatile并遵守现有保存事务。若本轮不做专用UI，执行模型仍须给出实际可用的受托管配置方式，而不是让用户粘贴这段尚未落地的示意JSON。

### 7.6 section＋context的真实注册示意与限制

以下是**讲清原方案接口的伪代码，不是本轮默认生产实现，也不是已有helper API**。`readPublicQuotaView`须由执行模型实现为纯同步读取，完成开关、路由绑定、身份校验、状态机与白名单投影；`renderQuotaFacts`只渲染数据，不能把上游message拼进去。

```js
// 接口分工示意：仅在明确接受下方重试限制后才采用此分发方案。
const disposeRules = systemPrompt.section({
  name: 'dsh-usage-dock.quota.rules',
  order: 4900, // 拟议排序位置；不是阈值。核验其它贡献后可调整。
  interpolate: false,
  text: (assemblyContext) => {
    const view = readPublicQuotaView(assemblyContext)
    if (!view.enabled || view.stage === 'normal') return ''
    return FIXED_RULES[view.stage] || ''
  },
})
const disposeFacts = systemPrompt.context({
  name: 'dsh-usage-dock.quota.facts',
  order: 300, // 拟议排序位置，必须是有限数。
  interpolate: false,
  text: (assemblyContext) => {
    const view = readPublicQuotaView(assemblyContext)
    return view.enabled ? renderQuotaFacts(view) : ''
  },
})
// 由ctx.effect拥有注册，卸载调用精确disposer；不按每次采集重复注册。
```

这能覆盖用户新turn和工具续轮的新step，但**不能保证同step重试时section同步换档/撤销**：宿主已经在该step入口固定了renderedPrompt，重试只刷新context。比如当前规则section为closing，重试前采集变为“获取额度失败/normal”，只有context会更新，旧section还在；反方向normal→closing也可能只有新数据而没有新规则。

以下都不是合格修复：不断dispose/re-register section；给section.text加async；把text换成可变对象；依赖system-prompt/change事件必然让已接受step重组；通过唤醒/新发用户消息伪造下一步。它们没有满足已核验的请求契约，或制造额外推理。

**若用户坚持“规则必须在独立section里”且仍要求每次重试严格normal零规则，需要先确认新的宿主能力或重新讨论取舍；不要擅改宿主，也不能把部分满足写成全部完成。**本交接默认使用下一节方案满足目前已确认要求。

### 7.7 默认实现：固定模板＋动态context原子组合

以下同样是**待实现的架构伪代码**，展示公开注册方式与生命周期，不直接覆盖任何产品代码。模板内容可按§5.2细化；不包含默认阈值，也不包含正常阶段规则。

```js
const FIXED_RULES = Object.freeze({
  warning: '当前额度处于预警阶段。缩小后续工作范围，避免新增大规模、长时间或大量并发工作，保留收尾余量。',
  closing: '当前额度处于收尾阶段。不再扩张任务；完成必要的一致性操作，保存进度，进行必要验证，给出已完成、未完成、风险和可恢复步骤后交接。',
})

// readPublicQuotaView是拟议helper：同步读同一版Host状态并返回脱敏视图。
// 按§6从assemblyContext.agent关联本次RouteObservation，匹配绑定与适用源后选快照；
// 不能假设assemblyContext顶层有provider，也不以options/旧header或UI选择替代。
// enabled、stage、数值/固定状态必须在这一份view内一致；不在回调中取数或计失败。
function renderQuotaPrompt(assemblyContext) {
  const view = readPublicQuotaView(assemblyContext)
  if (!view.enabled) return ''
  const facts = renderQuotaFacts(view) // 固定格式＋白名单字段，无上游自由文本
  const rule = view.stage === 'warning' || view.stage === 'closing'
    ? FIXED_RULES[view.stage]
    : ''
  return rule ? facts + '\n\n[当前阶段规则]\n' + rule : facts
}

ctx.effect(() => {
  let systemPrompt
  try { systemPrompt = ctx.get('systemPrompt') } catch { return () => {} }
  if (!systemPrompt || typeof systemPrompt.context !== 'function') return () => {}
  // 注册一次；即使当前功能关闭，也保持提供者，text按开关返回空。
  // 不默认设置required:true；是否需要绕过可选context抑制须按§10确认。
  const dispose = systemPrompt.context({
    name: 'dsh-usage-dock.quota',
    order: 300,
    interpolate: false,
    text: renderQuotaPrompt,
  })
  return () => { dispose() }
})
```

实现注意：

- 移除旧常驻规则注册，不能同时运行§7.6和§7.7两个方案，也不能由旧工具policy另外追加一份冲突指令。
- **固定模板不等于固定section。**正常时FIXED_RULES没有被选中，因此本插件没有添加额度行为规则；DSH自身安全规则和其它插件提示词保持原样。
- 始终从同一份不可变视图生成本次额度、状态、stage和规则，不能context数据使用新版而规则使用旧版。失败或过期被状态机归normal后，模板自然不输出。
- 开关变化应让仍注册的context提供者返回新文本/空串；不要只注销提供者来处理关闭，否则同step刷新可能保留已接受的旧context。
- 当前宿主[快照投影](../.diagnostics/prompt-loop-current-20261019/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L328-L348)对快照变化做去重，也会在既有快照变空时生成清除投影；执行者须验证实际请求中的撤销行为，不能只断言函数返回了空串。
- 这些回调没有网络、磁盘、工具调用或定时器。更新缓存由既有采集路径完成；不要在这里刷新供应商额度。
- 实际绑定/字段读取、snapshot版本、正常无数据的短格式与required选择由执行模型按前文契约实现，示例helper并非宿主内置API。

### 7.8 模型最终看到的内容示例与验收

以下尖括号都是占位符，**不是新设阈值、真实账号数据或可原样发送的字符串**。`renderQuotaFacts`应只输出实际存在的安全字段。来源为缓存时使用原采样时间；无真实额度时不输出数值行。

**正常：只有额度事实。**

```text
[当前额度快照]
渠道：<当前已绑定渠道>
阶段：normal
额度：<数值与单位/相关窗口>
来源：<本次成功采集或缓存>
采样时间：<原成功采样时间>
```

**预警：相同额度事实＋固定预警模板；收尾：相同额度事实＋固定收尾模板。**只带当前一档，不附另一档或正常规则，模板不要求模型再次调用usage_status。

**第5次暂时失败/明确P类失败：**

```text
[当前额度快照]
渠道：<当前已绑定渠道>
阶段：normal
状态：获取额度失败
```

**明确A类身份过期：**

```text
[当前额度快照]
渠道：<当前已绑定渠道>
阶段：normal
状态：用量查询身份已过期
```

这两种都没有旧额度、技术原因或“建议继续运行/停止”等行为句。供应商切换只附确认过的简短切换事实，不透露账号/Key细节；未获得新额度时不携带前身份数值。总开关关闭时上述内容都不自动投放，必要的旧快照清除由宿主投影处理。

除§9既有用例外，执行模型必须新增：

1. 开启、关闭、两档未配置、normal、warning、closing、缓存前4次、第5次失败、身份过期的最终渲染快照测试，不能仅测stage字段。
2. 在一个step的首次请求与重试之间，将closing改为normal/过期，再检查**实际将发送的提示词**不残留本插件收尾规则；反方向normal→closing同样检查规则确实出现。
3. 证明本轮动态context无需section重跑就可完成上述变档；如选§7.6备选，必须先记录用户接受的边界，不能跳过失败用例假称全部满足。
4. 确认启用策略时当前Agent未抑制该context；关闭时旧快照被替换/清除；无变化时不重复新增消息；多次渲染的供应商请求计数为零。
5. 给出用户在哪里配置、哪些字段是本次新增、保存后怎样生效、怎样查看真实注入结果。用户不需要自行编写section/context注册代码。

## 8. 配置与兼容范围

- 必须有明确开关、绑定/关注渠道与各档阈值的配置途径。作为本交接建议的安全默认：**本功能总开关关闭时，不自动注入任何本功能额度/状态快照或规则**，GUI和用户主动usage_status不受影响；开关开启但阈值未配置时，可提供normal的数据/固定状态，零行为规则。功能关闭不是第四个额度阶段。开工时说明旧quotaPolicyEnabled是否复用为该总开关；若要支持“自动数据始终开启、只关闭规则”的双开关模式，应另请用户确认，不暗自实现。
- 旧的单阈值字段不能被无说明地解释成另一档；保留旧配置，给出兼容/迁移说明，不直接写用户profile。
- 本轮核心为状态机/数据复用/模型感知。完整策略设置UI此前未实现；是否补控件需执行开工说明明确，不能默认额外做大UI，也不能交付时声称已有设置控件。沿用配置字段时提供用户可执行的设置说明。
- “模型阶段阈值”不自动等同胶囊状态灯的低余额告警阈值。暂时失败次数5必须共用，但不擅自改DeepSeek/MiMo既有告警金额。
- 保留角色secret字典路径、原子保存、customKeyRev与Host配置证明、实际发送凭据冻结、代次隔离、IP固定lookup/TLS、单条/整批绝对预算、失败恢复和35/40秒兼容。
- 退场kimi-code/glm-zhipu/glm-zai不显示不取数，不删除旧模型凭据。

## 9. 验收用例：须真实贯穿，不只测helper

先补“旧实现失败、新实现通过”用例，桩替换供应商网络和凭据即可，不能读取真实Key。

### A. 取数与去重

- A1 既有GUI采集成功后，连续多次context求值均读同一观察；供应商请求次数不增加。
- A2 工具完成一次真实采集可发布观察；工具缓存命中/多消费者读取/重复emit不增加采集次数或失败数。
- A3 GUI与context同一渠道/身份对应同一有效数值/失败计数，不发生两端各累加一次。
- A4 不从DOM或格式化字符串解析额度；精度、0、负数、币种、积分和多窗口正确。

### B. 暂时失败5次状态机

- B1 成功→T1/T2/T3/T4：同身份旧值保留、原fetchedAt不变、模型只见缓存标记，阶段仍按缓存值判。
- B2 超时→429→坏JSON→5xx累计不中断，第5次只给获取失败、无旧数值、normal无规则，GUI同步切换。
- B3 第1～4次没有旧值不编造0、不先报失败，normal；第5次固定失败。
- B4 失败后成功清零，恢复数值并重新判阶段；缓存读取不清零。
- B5 两渠道独立计数；按实际采集而非prompt/模型请求/工具调用次数计。

### C. 明确失败与真实额度

- C1 P配置/能力/权限/安全拒绝即时获取失败，不沿用旧值、不等待5次，normal无规则；P/A之后再遇T也不能复活旧缓存，须当前身份新成功或明确变更后才解除已确定的失效。
- C2 明确A过期即时仅查询身份过期；401/403、不明api错误、从未登录不得全部误报过期。
- C3 主动取消/替代/旧响应不计失败；预算真正超时仍可按T计，不混淆取消原因。
- C4 真实0/负余额按额度阈值判，不转为错误normal；402不编造0。
- C5 unlimited、混币无合计、单位不匹配不乱算；安全拦截不绕过TLS/公网校验。
- C6 内部详细错误存在时，模型文本仍只有允许的固定短语；植入URL、token/账号哨兵和指令样本验证无透传。

### D. 身份、并发与原缓存污染回归

- D1 切供应商/账号/Key/URL后旧快照与计数立即失效，旧请求迟到不回填；不泄漏账号细节。
- D2 A→B→A验证缓存/观察归属与实际发送一致；显式/ref/none/未采样在所有相关provider均正确。
- D3 MiMo none→后来Cookie B→清空/reload，全程不得采集B或把其成功写到无凭据身份。
- D4 并发旧失败/旧成功与新采集交换完成次序，不能回退最新状态、重复计数或越身份清零。
- D5 主会话与子代理不同路由不串阶段；同池共享不误广播切换。

### E. 阶段与动态注入

- E1 功能关闭：没有任何本功能自动快照/规则，GUI和主动工具原样；功能开启但阈值未配置：normal可含数据/固定状态、无规则；正常阈值未触发时同样无任何常驻额度行为规则。
- E2 warning、closing只发各自规则；边界、非法配置、单位与相关窗口匹配均覆盖。
- E3 normal→warning→closing→normal，以及closing→获取失败/身份过期→normal，旧规则确实失效。
- E4 用户新turn、工具批次后的新step、同step重试均读取正确快照，数据和阶段规则不冲突。
- E5 回调同步、零IO、无唤醒模型；文本无变更不制造重复快照，缓存时间不随读取变化。
- E6 验证context抑制、缺可选服务、配置更新、卸载清理；关闭策略后不再残留指令。
- E7 UI停止采集时不伪造5次失败、不宣称实时；说明无GUI能力边界。

### F. 全量与真机

- 保留全部既有回归，尤其真实宿主schema校验器测试；output schema禁止type数组，nullable采用oneOf。
- 用文件重定向收集测试输出，调查非0退出，不掩盖首跑失败，准确记录复跑/跳过与实际断言数。
- 如用变异证明测试覆盖，必须在隔离副本操作并恢复；不污染被测源/最终包。
- 当前阶段只做离线/本地构建。获得新部署授权后再验证：真实提示词文本、工具续轮刷新、normal无规则、缓存到第5次行为和恢复、模型实际收尾行为。
- 不凭“模型说它知道额度”代替确认动态快照实际进入请求；不把本地桩测试写成Android实测。

## 10. 尚未确定的参数：不擅自补值

执行模型应先列出确认项，能做的数据链/状态机/配置框架可以先做；正式启用自动阶段前必须有足够配置。

1. 各指标具体预警/收尾阈值，适用币种/单位与窗口。用户只确认分档机制，没有确认任何具体数字。
2. 用户要授权/关注哪些渠道，以及自定义路由、无法自动证明的账号/额度池怎样明确绑定；技术读取时机、已核验route表和自动选择步骤已在§6给出，不再将整个自动识别任务留待研究。
3. 是否补最小策略UI及具体范围，还是先沿用受托管配置入口。
4. 是否要求无GUI后台也持续感知；若要求，另定统一Host调度替代方案，不能在现有轮询上叠加。
5. 是否增加“缓存最大可参与决策年龄”等时间规则；用户已确认的是实际采集失败5次，不是任意TTL到期就报失败。
6. context被用户/Agent设置抑制时的策略与required注册取舍；不暗绕设置。
7. 确认本功能总开关与旧quotaPolicyEnabled的复用/迁移语义；本文建议关闭时停止全部自动注入。若需要独立的数据提示开关与规则开关，另行确认，不把建议冒充用户已选择的双开关需求。

不要用这些待定项扩大已确认规则，也不要为所有项都没定而停掉能完成的明确工程工作；未配置的策略保持关闭/不触发，并如实交付限制。

## 11. 推荐执行顺序与交付

1. 核验本地代码/依赖/宿主契约，列出旧实现与本文的差异、配置方案和待确认项；不重置未提交改动。
2. 冻结结构化错误分类、观察身份/去重/并发契约及共享状态机，先补边界失败用例。
3. 串通既有采集→Host观察→GUI，统一5次与立即错误处理，保护现有刷新与安全边界。
4. 实现阶段判定与动态context，移除旧常驻规则，保证恢复normal时撤规则。
5. 补完整链路/实际宿主schema兼容测试，跑全量；在交付中区分框架完成、已配置启用与真机未验收。
6. 更新实施/交接说明，生成本地包；核对每个payload、语法/注册表、字节数、SHA256/SHA1。新增模块必须进入包。
7. 最终回报：需求逐项映射、修改位置、实际失败→通过证据、首次完整测试与复跑记录、未确定项/能力边界、新包及hash、用户如何配置，然后交独立复核。

### 发布与运行闸门

已有一次安装测试授权不等于允许本次覆盖安装或重启。未经新授权：**不改DSH宿主、不覆盖当前profile、不自动重启、不commit、不创建/修改标签、不push、不发Release、不npm publish**。不打印或复制真实凭据，不改profile依赖版本去引用未发布npm版本。

## 12. 必读来源

- [AGENTS](../AGENTS.md)：项目契约、安全与发布约束；其中旧8次阈值及旧stale不参与策略，仅在本文明确范围内被新决定替代。
- [当前会话渠道自动识别研究](research-quota-route-binding-20261019.md)：实际路由读取时机、scoped observer安装正负例、各连接渠道表、Codex捕获账号能力及WB/DeepSeek源匹配边界。
- [方向6实施/真机记录](direction6-0.9.0.md)：工具注册、schema事故与当前能力。
- [第六轮本地复核](recheck-direction6-round6-v0.9.0.md)：F1/F2与凭据冻结验收边界。
- [原构建规划](build-plan-v0.9.0.md)：历史基线，不得用旧的“未知/stale绝不参与”或8次覆盖本文确认的新缓存回退规则。
- [整改记录](remediation-v0.9.0.md)：凭据、配置证明、预算、保存事务与连接安全。
- [当前策略实现](../plans/usage-policy.js)、[注册与缓存编排](../plans/usage-tool-register.js)、[Host入口](../index.js)、[浏览器显示](../client.js)：开工时完整读相关段落，不根据本文猜代码已实现。
