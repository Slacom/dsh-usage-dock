# 自动额度策略有限验收与新会话交接（2026-10-22）

## 当前结论

**17项阶段/撤销集成测试通过，真实Host库隔离实例的4场景通过；当前日常GUI策略公值与真实主/子模型实装闭环尚未确认。**用户随后选择交给新会话及其子模型继续实装验收，本轮已停止新增场景并收束。

[可复制的新会话完整提示词](policy-live-acceptance-handoff-20261022.md)。验收不是再修自定义渠道，也不以模型口述余额替代context证据。

## 证据层级

| 层级 | 本轮状态 | 可证明 / 限制 |
| --- | --- | --- |
| 生产apply＋合成服务 | [17/17通过](../.diagnostics/policy-runtime-acceptance-20261022/stage-matrix.log) | normal/warning/closing、恢复撤销、T1–4保原时间及T5失效、鉴权失效、单位/白名单/信任闸门、取消不新增IO、切源、关闭；不是最终Host请求 |
| 同一DSH归档真实核心库实例＋合成adapter | [4场景通过](../.diagnostics/policy-runtime-acceptance-20261022/actual-host-capture.json) | 新用户warning；同turn工具续轮warning→closing；真实llm-retry同turn同step closing→normal；卸载插件撤销当前named quota |
| 当前GUI公开策略字段 | [接口401](../.diagnostics/policy-runtime-acceptance-20261022/public-policy.json) | 仅无认证只读请求；停止，不读取Cookie/token或原始profile、不绕过认证；当前策略开关与阈值未知 |
| 当前GUI＋真实主/子模型 | 待新会话 | 必须核实实际provider/model与子模型切换能力，区分创建子代理、换模型及当前计费来源三件事 |

## 真实核心证明

[探针](../.diagnostics/policy-runtime-acceptance-20261022/actual-host-probe.mjs)实例化真实Cordis、AgentRegistry、SessionStore、SessionProjectionRegistry、SystemPrompt、LlmRuntime、ToolRuntime、AgentLoop及llm-retry。35个公开包来自同一DSH归档，没有手写核心方法替代。

6个请求在llm/stream前边界均断言真实AgentLoop请求，assemble共5次；retry/retry-started各一次、同turn3/step1，errors=[]。只落盘named quota贡献及位置，不存完整messages。详见[真实入口与装配笔记](../.diagnostics/policy-runtime-acceptance-20261022/host-entry-notes.md)。

- 归档SHA256：`47874618BF5B3011FCAAC10CD4C85F69DA333E70D4F99B921207C78D0999512A`。
- 已运行探针SHA256：`EDA7F1E95A9DBEBED502414356AD60B47024FA4DBF491545469A61162F920579`。
- 已部署源码入口SHA256：`6B094A0B97B6638F4321A1005BF47B4F6EE515A6541372D866D4781C9D870838`。
- 隔离最新snapshot撤销成立，不宣称物理删除历史snapshot、真实模型必然遵从或供应商wire已经验证。
- 探针捕获named source及真实调用链；额外正文包含断言曾临时添加但未运行，已撤回，不计为通过。下一会话可在新副本仅内存比对，不保存全提示词。

## 下一会话最小任务

1. 加载新工具清单；使用子Agent前核实工具是否支持provider/model选择，不凭子代理标签声称换模型或额度分流。
2. 合法确认日常公开策略字段；需要时由用户在已登录GUI运行[只读公值投影](../.diagnostics/policy-runtime-acceptance-20261022/read-public-policy.browser.js)，只发投影结果。401不绕过，默认值不冒充实际值。
3. 复用现有真实Host探针，不覆盖旧证据，不重搭mock；在授权测试范围内补实际主/子模型隔离及当前最小quota正文证据。
4. 临时开启生产策略、改阈值/信任链、安装诊断插件、重启或替换模型来源之前，明确公开变更与回滚并等待用户确认。尽量隔离profile，避免其它日常会话受影响。

## 清理与未动事项

阶段夹具已close并恢复global fetch；真实Host实例已await ctx.fiber.dispose并退出。无server、后台job、端口、真实供应商请求或生产配置改动，保留公开代码与合成证据供复现。无生产修改，因此无需恢复生产配置；没有重启、部署新包、提交、推送或发布。
