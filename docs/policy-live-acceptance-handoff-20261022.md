# 自动额度策略：新会话与子模型实装验收提示词

以下可整段发给新会话。目的：延续已有验收，不重新开始自定义渠道修补；用真实子Agent完成有限实装测试，并明确模型路由、生产配置授权和证据层级。

---

你接手DSH Usage Dock的自动额度策略验收。请先读完整[AGENTS.md](../AGENTS.md)，再按以下限定执行；本任务授权验收，不授权顺手修产品、改用户模型/凭据配置、发布或自动重启。

## 已有事实，别重复推翻或夸大

- 工作区：`E:\WorkSpace\DSH\DSH Usage Dock`。插件92DC823A修复包已部署本机desktop profile，27文件一致；用户新会话实际调用usage_status，结果与胶囊相符。
- 自定义渠道A/B/C工程修复已收口，不重做这部分，不跑无关全量54脚本。
- 17项阶段/撤销集成测试已过，但仅为生产apply配合合成服务的context生产者测试，不是最终Host请求证据。
- 同一DSH归档内的真实Cordis、AgentLoop、SystemPrompt、LlmRuntime、ToolRuntime及llm-retry已经在隔离进程实例化，真实生产apply已注册context。新请求、工具续轮、同step自动重试、卸载撤销四场景已过；模型adapter/账户数据是合成的，不是日常GUI进程或真实供应商请求已过。
- 未认证只读POST /api/settings/describe返回401，因此本机策略开关/白名单/阈值/路由信任的实际公值仍未知。没有读取Cookie、原始profile或Key来绕过；不能把schema默认false当成本机实际值。
- 策略专用UI未实现；账号/计费池精确证明与周限口径仍受限，不作为新增自定义渠道需求。

## 一、先核实工具与子模型路由

1. 检查你本会话真正可用的工具，不凭提示词虚构工具。usage_status存在时只调用一次，读取启用渠道的可用性、额度与单位，不读配置文件或凭据。
2. 至多委派一个真实子Agent做主要测试，你负责协调和交叉核对，避免多模型重复烧额度。
3. 若工具明确支持provider/model选择，优先使用我指定或确认过的可用测试模型；用工具参数及实际路由证据确认它确实不是仅继承父模型。若接口不支持选择或无法证明路由，明确说“子代理已创建，但模型切换/额度分流未证明”，不要把子代理标签当模型切换，也不要悄悄修改模型配置。
4. 不把积分、金额和剩余百分比直接比较来判断谁“额度更多”。用户未指定候选且无法可靠选路时，先告知限制，让用户在UI选择父模型或确认子模型，而非猜测供应商。

## 二、把子任务写清楚

给子Agent的任务须包含：当前工作区；本文件；下面的证据路径；只做本轮有限策略验收；不读Key/完整提示词/原始profile；不改生产源码或日常策略；需要修改生产配置或重启时先汇报具体公开字段并等我确认。

子Agent须真实执行测试命令并报告退出码、证据路径、证据层级和自己的实际provider/model（无法核实则写unknown），不能只复述旧报告。

已有隔离脚本可复用，先读再跑：

```powershell
node .diagnostics/policy-runtime-acceptance-20261022/stage-matrix.mjs
node .diagnostics/policy-runtime-acceptance-20261022/actual-host-probe.mjs
```

但不要直接覆盖旧证据。应先复制到本轮新建、同为`.diagnostics/<本轮名>/`深度的隔离目录，保留必要的host-src公开依赖与相对路径，再将输出写到新目录。不要用symlink指向真实profile。DSH归档已变化时需重新核实公开模块/依赖，不继续假定旧核心库等同当前Host。

## 三、当前日常profile公值，必须通过合法只读途径确认

- 只读取策略开关、白名单、阈值与单位、路由绑定及信任闸门等公开字段；不读原始cordis.patch.yml，不请求credentials.resolve，不输出完整settings.describe响应。
- 可以参考现有只读RPC与浏览器公值投影脚本；接口401就停止，不取Cookie/token，不伪造认证，不绕过权限。必要时请用户在已登录GUI执行这份只读公值投影并只回传输出。
- 在本机公值和实际请求路由未证明前，不宣称日常自动策略已开启或验收通过。
- 不为方便验证直接开启quotaTrustRouteOrder。来源、监听顺序或计费池不能证明时必须不投放；若需临时开启策略、改变白名单/阈值，先说明公开变更、影响范围、回滚与是否需要重启，由用户确认。优先隔离测试profile，避免影响其它运行会话。

## 四、有限实装验收清单

1. normal：当前渠道额度事实正确，无阶段规则；warning/closing：只追加对应建议，非程序强制停机。
2. 恢复额度、关闭策略、停用/切源、鉴权失效或失败达到阈值：本次请求撤销旧规则，不能旧低余额误收尾。暂时失败1–4次仍可沿用原采样，不能假刷新时间。
3. 新用户请求、一次工具后的续轮、同step自动重试分别验证。点击重新生成不算同step自动重试；看turn/step及实际retry事件。
4. 主/子Agent用各自实际provider/model选择额度，不能互相污染；故意让无关渠道额度低，不能导致本渠道收尾。父子若实际同模型，也必须如实报告，不能冒充跨模型隔离已验。
5. 最终证据取自真实请求路径中、模型可见内容里的named `dsh-usage-dock.quota`贡献，只保存该最小片段与provider/model、turn/step、阶段、采样时间、测试编号。另在内存中核对当前quota确实进入模型可见正文，不存完整正文；旧探针已验证named source及真实调用链，但未额外运行这条正文包含断言，不能冒称已做。不得保存整份系统提示词、真实对话、header、Cookie、Key或HAR。
   撤销指最新有效runtime snapshot不再携带旧规则；旧closing仍可能以历史snapshot存在。不要以“历史消息里还找得到closing”直接判失败，也不要声称已物理删除全部历史；应区分最新快照与历史，并单独观察真实模型是否遵从最新状态。
6. 非合成的日常GUI请求若缺安全公开观察点，就明确“尚未取得实装最终context证据”，向用户提出最小下一步，不能用模型口述“我知道额度”冒充字节级注入验证。需要临时诊断插件时，只在已获授权的隔离范围安装，完成后清理；不得擅改DSH核心。

真实低余额、换真实Key、消费额度制造场景都不必要。用隔离合成余额/阈值提供阶段控制，禁止为了测故障主动耗尽账号。不要把策略UI/新供应商支持顺手并进来。

## 五、证据路径与交付格式

参考：
- [自定义修复交付](fix-custom-operation-v0.9.1-20261022.md)
- [本机部署记录](deploy-local-operation-fix-20261022.md)
- [阶段矩阵脚本](../.diagnostics/policy-runtime-acceptance-20261022/stage-matrix.mjs) / [日志](../.diagnostics/policy-runtime-acceptance-20261022/stage-matrix.log)
- [真实Host探针](../.diagnostics/policy-runtime-acceptance-20261022/actual-host-probe.mjs) / [capture](../.diagnostics/policy-runtime-acceptance-20261022/actual-host-capture.json)
- [真实入口笔记](../.diagnostics/policy-runtime-acceptance-20261022/host-entry-notes.md)（真实核心装配、API、源码HASH、清理与证明边界；优先阅读，别重搭一套假Host）
- [线上公值读取状态](../.diagnostics/policy-runtime-acceptance-20261022/public-policy.json)
- [已认证GUI只读投影](../.diagnostics/policy-runtime-acceptance-20261022/read-public-policy.browser.js)

最终用表格报告：测试项、PASS/FAIL/待用户操作、证据层级、最小证据文件、实际主/子模型。分开列出：①生产代码合成服务集成；②真实Host库实例+合成adapter；③当前GUI实装+真实子模型。后者未证明就不得写成全部成功。

发现失败先给最小复现与影响，不立即进入无限修补。停止测试后清理测试Agent/服务/临时观察器，恢复经授权修改的配置。若没有改生产，明确写“无需恢复生产配置”。未获明确确认不得重启、部署新修复、commit、push、发布或把完整日志上传外网。
