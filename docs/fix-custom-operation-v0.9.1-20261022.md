# 自定义渠道A操作归属修复与本地交付（2026-10-22）

## 结论与范围

> 后续状态：用户已授权本机试装，备份与部署已完成，27文件校验一致；未自动重启，仍待用户启动加载验证。下文“本轮未部署”记录修复交付当时状态。[后续部署及测试清单](deploy-local-operation-fix-20261022.md)。

按[冻结清单](closure-audit-custom-and-quota-20261021.md)和[第十轮失败证据](recheck-v0.9.1-round10-20261022.md)直接完成修复。**原A误收尾、过时派发及GUI旧成功值回填在本地行为验收中均已关闭；B/C保持通过，可结束这条修补主线，进入用户试装。**这不是绝对零缺陷保证，也不是新包已在真实DSH激活的证明。

只改三个生产文件：[Host编排](../index.js)、[通用自定义取数](../plans/custom-balance.js)、[工具适配器](../plans/usage-tool-register.js)。客户端、WorkBuddy适配器与其余24个包内文件保持35E946版本字节不变。未新增GUI缓存TTL/降频/请求合并功能，未重做UI，不扩展供应商或策略功能。

**本轮未部署、未重启DSH、未改真实配置、未读真实Key/profile、未请求真实供应商、未提交/打标签/推送/发布。**此前真实GUI截图仍是旧运行版本的正常显示证据，不能证明这个新包已激活。

## 实际修复

1. **实际请求集合过滤**：用通过归属校验且已绑定票据的dispatchIds调用取数；空集合不启动任务。不是只跳过签票但仍把旧id传给onlyIds。
2. **工具接线补齐**：适配器原先只转发冻结credentials，遗漏了identify产出的opSeqs。现将opSeqs及同源epoch证明随内部snapshot一起下发；不进入模型工具公开结果。
3. **不再完成时补票**：发布必须持有Host签发的私有操作证明、正确激活epoch/身份/凭据指纹；重复回传只复用原票，不凭结果新签票。
4. **前置依赖/传输撤销**：通用取数在凭据解析前后、连接前、正文返回后检查操作守卫；采样回调可明确拒绝。过时凭据晚回返回无数值cancelled，而不是继续把旧Key发出去。
5. **公开GUI也撤旧**：拒绝内部提交还不够。旧响应改用当前已接受的整份公开wire，连同gen、币种、采样时间保持同源；没有当前值则明确无数值C。不会再出现context9000而旧GUI JSON是1/ok。复用既有观察的wire镜像，不新增上游取数，也不刷新旧采样时间。
6. **共享消费者保护**：入场发号与来源/观察确认分开；缺序号拒绝、不能落后于已确认来源，但两个尚在识别的同源调用不互杀。相同指纹只有epoch未变才可复用；A→B→A不能恢复旧epoch。取消一个消费者不杀另一个。

## 正式行为回归与红绿证据

新增[生命周期测试](../tools/test-custom-operation-lifecycle.mjs)和[独立公开服务夹具](../tools/fixtures/custom-operation.mjs)。不import诊断目录，不读私有pending表，不靠sleep编排，不访问真实账号；用Promise门闩、真实生产apply与GUI/工具/context公共入口。

- 将原35E946归档的27文件解包到独立目录，运行同一新测试的原10场景：**4通过/6失败**。归档SHA及三源码HASH已钉死：[baseline setup](../.diagnostics/fix-custom-operation-20261022/baseline-setup.log)、[before](../.diagnostics/fix-custom-operation-20261022/test-before.log)。不是把编辑中的源码当旧包。
- 修复后原10场景全过。另补同源同步双工具、A→B→新A反控制，**最终12场景全过**：[同包全量中的日志](../.diagnostics/fix-custom-operation-20261022/final-verification/custom-operation-lifecycle.log)。
- 12场景覆盖：串行换Key；旧HTTP在B缓存/新提交后迟到；旧GUI凭据在新工具/新GUI后迟到；旧工具identify在新GUI后迟到；同Key旧GUI；永久失败缓存门控；共享取消；onlyIds和无关低额条目；同步同Key单HTTP交付两个9；ABA旧epoch零迟到HTTP。
- 旧凭据返回后的额外HTTP为0；有新B真实提交时保持9000，GUI返回9000而非旧1；旧identify不再派发/补票/发布。缓存命中后可暂无数据，但不能旧1或误收尾。

### 测试合同纠正，而非放宽验收

旧[quota round2](../tools/test-quota-round2.mjs)与[round3](../tools/test-quota-round3.mjs)各有一条明确要求“迟到GUI自身返回旧1”，只检查内部缓存没坏。这正是本次公开回填缺陷，现改为要求GUI也返回当前9000，后续失败宽限/缓存检查保留。没有删断言、跳过用例或降低财务安全要求。

开发中同步双工具控制确实抓到第一版过度拒绝（HTTP0、两个null），在构建前已修，不把中间态当交付。最终单HTTP、两者均9，同时ABA旧epoch仍不能派发。原10项before/after及中间日志均保留。

## 最终验证与边界

| 验证 | 结果/证据 |
| --- | --- |
| 全量串行 | **54脚本全部exit0、0跳过**；[退出清单](../.diagnostics/fix-custom-operation-20261022/final-verification/summary.json)、[计数](../.diagnostics/fix-custom-operation-20261022/final-verification/counts.json) |
| 计数口径 | 51普通组1642项（含12行为场景）＋行尾75＋几何144＋契约7＝1868；新场景不是逐个内部assert计数，不与独立矩阵重复相加 |
| B取消 | [最终6/6](../.diagnostics/fix-custom-operation-20261022/final-cancellation-probes-final.log)，主状态原生正文取消仍为C非T；明细取消保留已完成42仍允许 |
| C公开异常 | [最终9/9](../.diagnostics/fix-custom-operation-20261022/final-public-errors.log)，原生Headers阳性控制有效；8出口无合成Key/原exception且保留固定分类 |
| 网关基线 | [最终20/20](../.diagnostics/fix-custom-operation-20261022/final-gateway-probes.log)，预算、包装Response、404汇总/立即能力记忆等保持 |
| 通用收口链 | [最终22/22](../.diagnostics/fix-custom-operation-20261022/final-chain-matrix.log)，数值、来源、范围、共享、撤销、异常等保持 |
| 原生HTTP | [正常且服务已关闭](../.diagnostics/fix-custom-operation-20261022/final-gateway-real-http.log) |

一次全量运行中，安全组已输出37/37通过后，Node在Windows libuv async.c触发UV_HANDLE_CLOSING原生退出，非JS业务断言失败。未掩盖该退出：[原始日志](../.diagnostics/fix-custom-operation-20261022/final-regression/custom-security.log)。不改源码的[单独复跑](../.diagnostics/fix-custom-operation-20261022/custom-security-recheck.log)及随后整套54脚本均exit0；只以最后完整成功运行作为交付计数。未证明这类运行时退出永不再现。

独立只读复核亦未在冻结A/B/C及12场景范围发现新的明确阻断：[复核记录](../.diagnostics/fix-custom-operation-20261022/review.md)。该结论限定当前源码HASH与既定范围，不延伸为所有并发排列/真实Host的无条件保证。

## 本地包

[修复包](../legacy/local-build-0.9.0/operation-fix-20261022/dsh-usage-dock-0.9.0.tgz)

- SHA256：`92DC823AE5ADC8A7CBDC394A6894A02175EE9D7F949C277901C43F3484D00D68`
- SHA1：`c31d5572238d314654145f7e12dc2c1d7c18c66e`
- 232905字节，27文件；逐payload与当前工作区一致，mismatch=0；相对35E946仅上述三个生产文件变化：[包核验](../.diagnostics/fix-custom-operation-20261022/package-audit.json)。
- 保持本地版本号0.9.0，不发布。旧归档与诊断证据未覆盖，新包单独存放。

**下一步仅用户试装/真实Host验收，不再追加自定义新功能修补。**额度策略核心已有，真实context注入/同step重试、策略设置UI、真实计费池与窗口口径仍按此前独立边界处理，不能因本次A关闭就宣称这些全部完成。未授权前不为验证而重启、不读取整份提示词/Key，不消费账号制造低余额。
