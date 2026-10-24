# 0.9.0 第四轮复核：原W1–W3通过，配置协议仍有两处边界缺口

> 2026-10-18。依据[第三轮报告](recheck-v0.9.0-round3.md)和[整改记录](remediation-v0.9.0.md)，读取当前实现，独立复跑全部可用套件及新边界探针。
> **结论：原W1–W3复现条件已通过；本轮仍需修X1/X2后再放行整改。**不要求重写已通过的身份协议或V1/V3/V4/V5，不推进方向6。
> 本轮未修改运行时代码、未部署、未重启、未提交、未打标签、未推送、未发布。补测全部使用模拟数据和合成凭据。
>
> **（2026-10-18 第五轮独立复核）本地代码整改通过**：X1/X2原探针已独立重放通过，全量831项及另7项契约通过，E41967…包与工作区一致；真实DSH/安卓验收和方向6仍未完成。完整边界见[第五轮复核报告](recheck-v0.9.0-round5.md)。
>
> **（2026-10-18 整改者补记）X1/X2 已修复**：双端摘要改用同一套字段规范化（trim/截断/币种大写/
> 主机小写），`expectedDigest` 改读 ref 并进入 effect 依赖，逐条身份纳入公开 Key 修订号。
> 逐项证据见 [整改记录 §0d](remediation-v0.9.0.md#0d-第四轮复核x1x2复现与修复)，
> 复现用例在 `tools/test-recheck-round4.mjs`（33 项）。修复后全量 **23 组 831 项通过**，
> 重新打包为 `E41967…`（本文提到的 `E4861F38…` 包作废）。真实宿主验证仍未进行。

## 1. 已确认的进展

- Host从实际读取的配置生成`data.cfg.digest`，不再依靠浏览器见没见过gen；`customKeyRev`与secret路径同批提交，同Key幂等保存可恢复。
- 基线、失败计数、代次保存在组件ref，原A修改/B失败的回退问题测试通过。
- `test-recheck-round3`的29项（包括Host侧契约、摘要稳定性）通过；其余已修V/R项回归通过。
- 实际运行**23组798项**检查/断言，另WorkBuddy契约7项，总24组805项，全部通过、无跳过（包含144条Chromium几何断言）。提交说明“22组776项”没有覆盖本次实际全量统计：当前还运行了MiMo纯函数21项，行尾守卫已为33项，后续文档应统一口径。
- 三个入口语法检查通过，git diff --check通过。
- [当前包](../legacy/local-build-0.9.0/dsh-usage-dock-0.9.0.tgz)：127457字节、20文件、解包371123字节。20个payload均与工作区对应文件一致。
- SHA256 `e4861f3863aed8add09630b87ca4d5fb6d5486566f635467d221aa942d7dea99`；SHA1 `887482f0ec207e3f1c134a2e0ada606fc4f4f992`，与提交说明一致。当前包仍包含以下边界问题。

## 2. X1 / P2：Host与客户端摘要规范化不一致，合法空格输入导致永久不显示

### 位置

- Host：[entryPublicIdentity](../plans/custom-balance.js#L832-L847)对URL/键路径/引用做trim和截断，对币种规范化，对credentialHost小写化。
- 客户端：[configDigestOfClient](../client.js#L410-L440)直接拼接parseCustomBalances保留的原始字段，没有同样的规范化。
- [摘要比较](../client.js#L1284-L1288)严格相等；不等走pendingConfig，无法自行恢复。

### 实际复现

用同一个配置对象产生真实Host的configProofOf，作为真实Badge的payload；表单是该配置的已保存快照，只更改一个合法字段：

```text
NORMALIZATION normal      "A$ 91.23"
NORMALIZATION url-space   "—"       // url = ' https://a.example/b '
NORMALIZATION path-space  "—"       // balancePath = ' balance '
```

Host与设置校验本来都接受这些首尾空格（实际解析时trim），用户粘贴内容也能保存，但Host返回成功数据仍永远被浏览器当旧配置拒绝。这不是网络/账号错误。

同根因还涉及币种大小写/空格、credentialHost大小写及截断边界。正常样本上的摘要稳定性测试不能证明所有受支持配置的双端算法一致。

### 修复与验收

- 为所有摘要字段规定唯一规范化，Host/Client同构；可以精确比较raw配置，也可以双方完全相同地canonicalize，但不能各用不同规则。
- 不要仅在新保存时trim：既有配置、CLI/YAML设置与真实Config解析路径也必须一致。
- 补URL/路径首尾空格、币种大小写与空格、credentialHost大小写、默认值/缺字段、重复/非法id及长度边界的双端等价性测试。
- 至少一条完整form已保存值→真实Host proof→真实Badge正向测试，证明数据最终显示；同时保留配置确实不同的拒绝负例。

## 3. X2 / P2：只更新customKeyRev时effect仍捕获旧摘要，且旧余额未即时作废

### 位置

- [expectedDigestRef写入新摘要](../client.js#L1214-L1223)，effect启动时只读取一次到局部`expectedDigest`。
- [responseMatchesCurrentConfig](../client.js#L1284-L1288)始终比较闭包里的旧值。
- [effect依赖](../client.js#L1566)只有enabled/customSignature/configEpoch，不含expectedDigest或customKeyRev。
- [逐条身份](../client.js#L258-L268)、[渲染有效性](../client.js#L355-L364)也未把公开Key修订号纳入；configDirtyIds仅为当前页面实例内的保存信号，不能替代已保存配置。

### 实际复现

1. 当前form有相同的customBalances，customKeyRev[id]=0；成功显示A的91.23。
2. form收到已保存配置更新，只有customKeyRev[id]变成1（例如另一窗口保存Key）；本页未触发本地bumpConfigEpoch。
3. Host返回与**当前rev=1完全匹配**的configProofOf，以及新代次A2、余额12.34。
4. 实际输出：

```text
REMOTE_REV_SEED                         A$ 91.23
REMOTE_REV_BEFORE_REFRESH               A$ 91.23
REMOTE_REV_AFTER_3_MATCHING_REFRESHES    —
```

配置修订已知变化时旧值没有立即隐藏；刷新后，新结果因轮询闭包仍期待rev=0的摘要而被拒绝，强刷3次仍不恢复。configDigestOfClient虽然每次render算了新摘要，ref也更新了，但没有让现有轮询闭包更新。

该探针通过真实Badge和form快照更新运行，不需要真实Key。这是公开配置修订变化应正确处理的场景，不需要假定任何浏览器能读取secret。

### 修复与验收

- 将完整的可信配置身份变更纳入请求生命周期：仅customKeyRev变化也要作废旧请求/更新当前期望摘要。
- 逐条applied身份、渲染过滤、基线清理均应包含该条公开Key修订，不能只依赖本页bump或元数据签名。
- 不要清空其他id的基线/失败计数；不允许旧proof因为修复闭包而重新回填。
- 测试“只有form.publish的公开修订变化、没有本地epoch事件”：新请求挂起时旧值立即隐藏，旧修订响应拒绝，匹配新修订后恢复；重复同Key、不同Key以及A修订变化/B暂时失败都应正确。
- 不以重挂组件、手动重启或再改一次URL作为恢复要求。

## 4. 范围与交接

只修X1/X2并补对应负例；保留原W1–W3与V/R修复。重新运行完整23组回归+契约，准确记录新增检查/跳过，再打包核对payload与新hash。当前E4861F38…包不能作为这两项修复后的产物。

真实DSH的secret投影、同批mutate的事务/修订语义、Android node:https可用性仍需用户试装，不以本轮离线通过代替真机验收。方向6仍未实施，不计入本轮审查缺陷。

给执行模型的独立提示词见[仅修X1/X2的提示词](fix-prompt-v0.9.0-round4.md)。
