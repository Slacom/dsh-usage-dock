# 内置WorkBuddy渠道迁移至WorkBuddy2API Panel（国内版）

> **2026-10-21用户新决定，覆盖此前的自定义卡片方案。**不为此网关新增自定义条目、积分格式选项或专用配置页；直接替换Usage Dock内置国内WorkBuddy的数据源，自动复用模型里的WorkBuddy API配置。不是修改外部WorkBuddy Connect插件。
> 本文是已确认的变更要求与接口核验，**产品代码尚未修改**；未读取真实Key、网关配置或auths，未调用实际服务、启动exe、部署或重启。

## 1. 用户截图已确认的配置

| 项目 | 已知事实 |
| --- | --- |
| DSH模型provider id | `workbuddy`（精确id，不按可改的显示名猜） |
| 显示名称 | WorkBuddy |
| 模型baseURL | `http://localhost:7863/v1` |
| API协议 | OpenAI Chat Completions |
| 配置中的模型示例 | cn:deepseek-v4.1-flash、cn:glm-5.3-flash、cn:step-5-preview |
| 国内积分观测目标 | **GET http://localhost:7863/status** |

这是Host视角的地址；不写死7863，也不扫描端口。将来用户在模型设置里改origin/端口，内置取数跟随当前有效来源，并作废旧值。

截图“留空使用已保存凭据”只是输入框提示，不证明Key实际存在或有效。运行时经宿主公开凭据服务解析已选模型来源，缺失时给可操作提示；不要求用户把Key再交给插件或模型。

## 2. 保留内置渠道的现成能力

- 保留内置channel id **workbuddy**、workbuddyEnabled开关、既有planOrder位置及关注渠道引用，不新增custom id。
- 保留现有`✦`积分符号、分组数字、小数规则、详情、灰化/失败/恢复与credits单位；[当前内置输出](../plans/workbuddy.js#L293-L309)已有creditsTotal/creditsUnlimited等结构，**无需为此次接入扩展通用自定义金额/积分格式**。
- 删除国内卡片“先安装/登录WorkBuddy Connect”的过时说明，改为“读取设置→模型中的workbuddy网关配置”。
- 不实现国际网关适配，不混合国内/国际积分；不擅自删除国际配置、模型凭据或卸载外部插件。
- 自定义卡片的默认折叠/样式统一、全局混排及R5缺陷仍独立有效；不能因为WorkBuddy改走内置就跳过已有自定义卡片的数据破坏问题。

## 3. 取数与鉴权

依据用户提供的[本地v1.13.0 README](<D:/Download/NDM/wb2api-panel-v1.13.0-windows-amd64/README.md#L651-L660>)：

1. 用**GET /status**读取网关当前已知积分，不访问旧`/plugins/dsh-workbuddy-connect/status`，也不依赖DSH自身web端口。
2. 状态路径从模型地址的**origin根路径**构造，即`new URL('/status', baseURL)`的语义，不拼成/v1/status；模型baseURL本身不修改。
3. `Authorization: Bearer <网关api_key>`复用该模型来源的凭据；不是CodeBuddy accessToken/refreshToken，不读auths，不从浏览器localStorage抓Key，不试探其它provider。
4. 必须按宿主目录定位所属namespace及当前有效组合配置，沿用已通过的来源删除/继承/禁用/歧义检查，不能重新扫描任意providers或把inherited与override深合并。
5. 支持本次明确选择的本机回环HTTP网关，限制到保存的origin/端口；不因此降低通用自定义渠道的HTTPS规则或放开任意私网/HTTP。localhost须确认为回环目标，拒绝凭据随重定向离开所选origin，不关闭HTTPS证书验证。
6. 元数据与实际凭据在预算内解析并冻结，GUI和usage_status消费同一份有效来源事实。更换来源/Key后撤销旧projection/meta/身份和票据，不能重复R5只删元信息而残留旧积分的问题。

[README余额刷新说明](<D:/Download/NDM/wb2api-panel-v1.13.0-windows-amd64/README.md#L583-L608>)表明网关默认每5分钟刷新上游；插件只读状态，不在轮询中调用POST balance_all/签到/任务/聊天。不要因本次接入修改用户已确定的插件轮询频率。

## 4. 唯一尚缺的协议事实：/status响应结构

README确认状态接口含积分，但**没给响应JSON结构或剩余合计键**。[现有解析器](../plans/workbuddy.js#L203-L225)认的是旧Connect的credits.total及套餐明细，不能假定网关相同。

还需要一份脱敏/status JSON，或该版本公开源码中的状态响应定义。数值可改为示例，仅保留积分字段和外层对象/数组结构，删除uid/昵称/邮箱/IP/token等；不要提供请求头、完整HAR、auths或整个运行目录。**无需再次提供baseURL，截图已给出。**

必须核实：剩余而非累计发放/已用；单账号与多国内账号池的合计口径；冷却/禁用账号是否计入；缺值与真实0的区别。不取accounts[0]冒充全池，不把/status账号数组误当旧Connect的积分套餐数组，也不把/healthz中的账号计数当积分。

新网关401/403表示网关访问鉴权失败，不自动翻译成“需重新登录WorkBuddy平台”；404是状态端点/版本不匹配，不再提示“未安装Connect”。429/5xx/网络/结构错误保留既有有界降级，不猜自由文案来销毁凭据。

## 5. 最小实施与验收

- 国内内置fetch改为接收ctx/配置/预算，并从已配置的workbuddy来源取数，替代现有setWebBase指向DSH Connect端口的路径；国际分支不借机改造。
- 用已确认状态fixture转换为原有积分wire，保留白名单；不要把账号uid、原始JSON或上游错误原文放到模型工具/context。
- 覆盖正确根路径、同origin网关Key复用、无source/无Key/停用/歧义、0/小数/缺值、单号/多号已选口径、401/404/T类失败、预算超时、来源/Key切换与迟到响应。
- 真实apply的GUI、usage_status、自动context与胶囊/详情读同一份国内积分；不额外要求自定义卡片或手填积分键，不自动开启额度策略或声称已证明每次派发的具体计费账号。
- 仍须修[第五轮报告](recheck-custom-provider-v0.9.1-round5-20261020.md)所列独立缺陷。本次文档不冒称内置迁移已实现或运行副本已验证。
