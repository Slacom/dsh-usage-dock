# 方向6第六轮独立复核：本地代码复核通过

> 日期：2026-10-19。对象：411C577C…本地构建，承接[第五轮F1/F2报告](recheck-direction6-round5-v0.9.0.md)。
> **结论：F1/F2原缺陷未再复现，本地代码复核通过；在本轮范围内未发现新增阻塞。**可进入另行授权的真实宿主冒烟/用户试装阶段。
> 本结论不等于真实宿主或Android已验收，不是公开发布授权。本轮只读产品审查、运行隔离探针并更新审查文档；未改产品或宿主、未部署/重启/提交/改标签/推送/发布。

## 1. F1：custom冻结快照与缓存身份通过

[注册层mergeFrozenSnapshot](../plans/usage-tool-register.js#L185-L203)合并内置与custom两部分，[custom provider](../plans/custom-balance.js#L1434-L1498)在选择当前保存凭据之前服从冻结状态；目标确认仍在发送前执行。

### 原缓存污染探针重放

真实apply→真实注册/collector→真实custom provider，仅虚拟DNS/HTTPS，合成Key。凭据服务每次查询依次提供A、B、A：

```text
CUSTOM_APPLY_A_B_A:
balances=[10,50,10]
resolves=3
actualTransmittedAccounts=[A,B]
```

第三次A命中A自己的余额10，没有复用B的50；第一次取数不再发生额外解析导致的身份漂移。

### 真实provider独立状态矩阵

当前保存Key始终为B，按不同冻结状态调用真实fetchCustomPlans：

| 状态 | 余额/结果 | 实际发送 |
| --- | --- | --- |
| explicit A | 10 | 仅A |
| ref A | 10 | 仅A |
| none | no-key | 零请求 |
| 未提供快照 | 50 | 当前B |
| explicit A，但目标未确认 | credential-unconfirmed | 零请求 |

没有用pendingKey绕过已保存Key的credentialHost/origin约束。已有DNS全公网、IP固定lookup、TLS、重定向与截断响应等安全回归维持通过。

## 2. F2：MiMo冻结none及原缓存污染场景通过

[MiMo冻结分支](../plans/mimo.js#L103-L127)只在未采样时读当前cfg；有冻结描述时严格服从状态。

真实provider矩阵，cfg包含后来出现的Cookie B：

- none → no-key，零请求。
- explicit Cookie A → 正常余额17.55，只发送A。
- explicit缺字段或无效Cookie → no-key，零请求，不回退B。
- 未采样 → 正常发送当前B。
- MiMo不支持的ref状态 → no-key，零请求。

### 真实apply原场景

MiMo初始无Cookie；同批custom慢引用等待2100ms时，普通configEditor override出现Cookie B，确保collect跨过两秒缓存重读。随后清空Cookie、一次reload后再查相同ids。

```text
首次: availability=error, errorCode=no-credential, balance=null, fetchedAt=null
再次: availability=error, errorCode=no-credential, balance=null, fetchedAt=null
MiMo requests=0, accounts=[], 辅助refResolutions=2
```

未再把B的成功余额缓存进“无凭据”身份。辅助目标由既有私网校验拒绝，没有真实外部取数。

## 3. 已通过修复保持与测试质量

- Q2真实apply：DeepSeek无账号/无插件Key/模型Key有效，余额7.25，正常解析DEEPSEEK_API_KEY；OpenCode首候选空/第二有效，剩余10%。
- Q3：全部内置停用、显式点名OpenCode，disabled且凭据解析列表为空。
- 原取消/逐条进度、策略reload、混币UI及C主线用例均在全量中通过。
- [Q1a测试](../tools/test-usage-recheck-q1q3.mjs#L91-L159)现在确实请求辅助慢条目，显式检查gate进入，跨配置窗口后放行，读取计数从0开始，不再用伪计数证明时序。
- [V3c测试修正](../tools/test-recheck-fixes.mjs#L121-L144)去除“1ms构造后必须尚未过期”的脆弱断言；保留未来/过去deadline判定和15ms到期后迟到DNS零发送等安全检查。没有放宽产品预算。

## 4. 独立完整回归

本轮通过原生cmd文件重定向采集，完整首跑即通过，无复跑、无跳过、未出现提交者记载的采集层退出断言：

- 32个普通Node组1124项。
- 行尾49项、几何144项。
- 合计1317项；另WorkBuddy契约7项，**总1324项通过**。

原始逐套件日志位于工作区`.diagnostics/d6-sixth-review-bedd3e52322a4a079782fb85e8f8b2bf/`。本轮没有运行会临时回退产品文件的变异脚本，结论来自当前代码、独立探针与完整回归。

**非阻塞统计更正**：实际方向6相关10个脚本合计469项（108+70+41+85+31+41+25+5+31+32），不是交接文案中的“十一组500项”；全量1317+7口径一致。后续文档同步应以实际输出为准，不影响本次代码结论。

## 5. 被测产物与绑定

[本地包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：158859字节、23文件、解包469948字节。所有23个payload与当前工作区逐字节一致，mismatch=0。相关入口/模块语法、git diff --check通过。

- SHA256 `411c577cef8a58e1e8ce83f3192035c8d6ceac720b558fa69bcfc0d3e8fd9d85`。
- SHA1 `047f7d57b0b95d67511b70406527665cd630ab36`。

本结论绑定这一份包及当前代码，不自动覆盖后续改包、部署环境或未来改动。

## 6. 尚未验收与下一步

1. **真实DSH tools/systemPrompt冒烟**：注册、真实模型调用、结构化输出/render、规则进入提示词、配置更新与卸载仍需真实宿主验证；本轮没有部署或重启。
2. **Android/DSHA**：tools、systemPrompt、node:https及真实网络能力尚未实机确认。
3. **策略UI**：仍未实施，当前仅配置字段与模型可见链路，不冒充已有设置控件。
4. **用户试装/公开发布**：仍受发布闸门约束。另获部署授权后才试装；用户确认前不提交/推送/打标签/Release/npm publish，不自动重启。

这几项是验收边界，不是本轮新发现的代码缺陷。无需再为F1/F2发修复任务；下一步是明确范围与恢复方式后进行获授权的真实宿主冒烟。
