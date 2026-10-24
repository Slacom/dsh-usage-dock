# 额度感知第五轮复核：两项修复通过，剩一组epoch生命周期缺口

> 2026-10-20。审查包SHA256：`ede80340e9e6f5db8ee579cae8180aaee70a630b2cc25bf220c8d38dd6029cb2`。
> 对照：[第四轮报告](recheck-quota-awareness-round4-20261020.md)。**R4-02、R4-03和取消防御项通过；R4-01在有已提交观察的原案例通过，但仅pending/监控总开关仍未覆盖，保留一组P1。**
> 用户已确认胶囊和设置页恢复，本轮据此记录UI故障已解决，不重新安装或排查该故障。没有证据表明下述epoch问题就是之前UI消失的原因。
> 本轮只读取代码、运行合成验证、保存报告；未改产品/既有测试/宿主/profile，未部署、重启、提交或发布，未调用子代理。

## 1. 核验摘要

- 新包186101字节、27个文件，逐payload与源码比较**mismatch=0**；SHA1 `d760618ce31caaae99cfac840fad552479a42705`。[包核验](../.diagnostics/review-quota-round5-20261020/package-audit.json)。
- 实跑42脚本：**39个普通Node组1388项＋行尾61＋几何144＋契约7＝1600项**，全部exit0、0跳过。[清单](../.diagnostics/review-quota-round5-20261020/regression/summary.json)、[计数](../.diagnostics/review-quota-round5-20261020/regression/counts.json)。
- [定向探针](../.diagnostics/review-quota-round5-20261020/host-probes.mjs)通过真实apply、工具注册、配置reload、context及真实客户端源码验证，全部依赖合成，无真实凭据或供应商查询；[结果日志](../.diagnostics/review-quota-round5-20261020/host-probes.log)。
- 定向日志FAIL表示断言缺陷仍存在，exit0表示复现成立，不表示功能验收通过。没有全局hash补丁或生产代码替换。

## 2. 本轮已通过的整改

| 场景 | 结果 |
| --- | --- |
| 已有95CNY观察，挂起旧请求，再Cookie A→B→A | 旧1CNY被拒，context保持无当前数据，不触发旧收尾 |
| 已有观察，单渠道停用→启用 | 旧票据被拒 |
| OpenCode原生已用80→缓存剩余20 | 真实客户端显示已用80%，模型显示剩余20%，口径正确 |
| 无成功基线，连续T1～T4 | pending，自动context暂无额度数据，不提前报告获取失败 |
| 同一新实例T5 | failed，仅固定获取失败，无阶段规则 |
| 合成C取消wire | 原API来源、额度和context完整保留，未再把旧成功当新成功发布 |

取消项仅指既定C wire的消费契约，不声称所有真实网络abort都会产生该码。UI恢复依据用户确认；本轮没有独立做真实模型请求/重试的提示词抓取。

## 3. 唯一保留的P1：epoch不是完整的激活状态，仍依赖已提交元信息

### 3.1 首次查询还没有任何结局时，回切/停启仍能复活旧结果

**区别于已通过案例：不是“没有成功基线但已有T记录”，而是第一笔请求尚未结束，只有在途票据、根本没有channelMeta。**

位置：[reconcile的无meta分支](../index.js#L494-L519)。虽然已遍历全部已知id，但：

```js
const meta = channelMeta.get(id)
if (meta === undefined) {
  if (expected === null) quotaObserver.bumpEpoch(id)
  continue
}
```

有正常身份哈希、没有观察元信息时直接跳过，也没保存此前已见过的身份。枚举到了id，并不等于记住了该id的激活状态。

两条实际apply复现：

- **FAIL_FIRST_REQUEST_COOKIE_ABA**：冷启动第一条A查询挂起→逐次reload到B、再回A→放行旧A的1CNY。它仍被接受并输出closing/收尾规则。
- **FAIL_FIRST_REQUEST_CHANNEL_TOGGLE**：冷启动第一条查询挂起→mimoEnabled=false→true→旧1CNY同样进入closing。

两个配置reload均已触发并等待回调处理，不是事件尚未跑完；入口的同步reconcile也已经存在。根因是无meta时没有独立记录激活身份，epoch始终没被推进。

这正是[上一轮修复要求](recheck-quota-awareness-round4-20261020.md)中“没有成功记录、只有pending时也须有效”的未闭环分支，不是新增产品范围。定向配置显式开启策略/顺序授权并设置CNY阈值，未用默认关闭状态掩盖问题。

### 3.2 监控总开关未参与激活边界，即使已有观察也会遗漏

**FAIL_GLOBAL_MONITOR_TOGGLE**：已有95，挂起下一条旧查询→`enabled=false`→`enabled=true`→释放旧1，context进入closing。

[总监控关时停止取数](../index.js#L624-L629)，但身份只计单渠道enabled，[reconcile](../index.js#L494-L519)也不处理全局监控启停；所以这条旧票据的epoch未变。这里是数据监控的`enabled`，不是仅控制自动提示的`quotaPolicyEnabled`。

监控停用已是原有“停用作废”语义；不能仅隐藏context，重开后又让已作废在途请求当新成功。若另有允许跨暂停复用历史缓存的产品选择，应单独明确，不能据此默认接受旧在途结局。

### 3.3 observer.clear还漏掉从未登记过epoch的票据

位置：[begin只读取默认epoch](../plans/quota-observer.js#L150-L178)、[clear只遍历epochs.keys](../plans/quota-observer.js#L353-L358)。

**FAIL_CLEAR_FIRST_EPOCH_TICKET**：新observer→begin得到epoch0→clear→原ticket提交仍成功，当前epoch仍0。因为begin未将初始id登记进epochs，clear遍历不到它。

这是同一组生命周期登记问题的helper级证据。**不据此声称真实插件卸载后仍会输出规则**，因为真实卸载还有route/context disposer保护；实际错误收尾已由前两节的活跃实例复现证明。

## 4. 一次闭环的修复出口

1. **激活状态与数据观察分离。**逐渠道维护最近已观察的身份/监控启用状态和epoch；即使没有任何成功或失败记录也要存在。不能继续仅靠channelMeta.identity推断生命周期。
2. 首次登记、真实状态变化、数据清空分别处理。状态变化推进epoch，并更新“已见状态”；删除观察不能把已见状态/失效标记也丢掉。
3. 监控总开关、渠道停用/删除等都进入同一激活生命周期。**策略注入开关不等同于监控停用**，不要把quotaPolicyEnabled或阈值变化粗暴变成清空全部数据。
4. begin登记初始epoch/id，或用等效的全局失效代次保证clear能使所有已签票据失效，包括从未提交过的。
5. 不要修成“无meta就每次bump”，也不要每次begin都增epoch：同身份并发、仅增加请求而没发生源变化时，不应相互取消，避免冷启动长请求永远无法建立第一份基线。
6. 未改动渠道保留原基线与失败计数，保持本轮已通过的百分比、pending、C语义。

### 最小回归补齐表

| 已有观察 | 切换 | 旧票据预期 |
| --- | --- | --- |
| 有 | A→B→A | 拒绝（本轮已通过，保留） |
| 无，只有首次pending | A→B→A | 拒绝（本轮失败） |
| 有/无 | 单渠道停用→启用 | 均拒绝；无观察分支本轮失败 |
| 有/无 | 监控enabled关→开 | 均拒绝；本轮已有观察也失败 |
| 无 | 同身份两个请求，无配置变化，第一条先完成 | 第一条可以建立有效观察，不能被空meta反复bump饿死 |
| 从未登记过epoch | begin→clear→旧commit | 拒绝（本轮失败） |
| 任意 | 只改另一条渠道 | 本条票据/基线/计数不变 |

测试要断言真实context是否还出现旧额度/规则，不能只看晚到响应自身返回1或只检查HTTP ok。原始响应存在，不代表它被采纳到当前有效观察。

## 5. 复跑与当前边界

```powershell
# 当前代码下FAIL断言缺陷存在；修复后需转为正确行为断言
node .diagnostics/review-quota-round5-20261020/host-probes.mjs
node .diagnostics/review-quota-round5-20261020/audit-package.mjs
```

本报告绑定ede803…包，后续使用新hash/证据目录，不覆盖本轮日志。后台回归job `pwsh-ab84d49700454198`已收集、exit0，无在途作业；本轮没有启动子代理。

胶囊/设置页已恢复，但动态提示词的真实请求/重试、账号/额度池证明、窗口业务口径、策略设置UI仍按既定范围分别验收。本轮**不否定已恢复界面，也不把其恢复视为epoch通过**。当前剩余的是上述一组P1；补齐后再给本地数据链限定范围结论。
