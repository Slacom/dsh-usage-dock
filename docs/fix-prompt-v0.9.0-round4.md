# 执行提示词：修复配置摘要协议X1/X2

```text
继续整改dsh-usage-dock的0.9.0，仅修第四轮独立复核的X1/X2。不推进方向6，不重写已通过的W1–W3/V1/V3/V4/V5，不新增无关功能。

工作区：E:\WorkSpace\DSH\DSH Usage Dock

先读AGENTS.md、docs/recheck-v0.9.0-round4.md、docs/remediation-v0.9.0.md及相关原设计。保护未提交成果，不reset/clean，v0.8.5标签不动。

第四轮结论：原W1–W3已通过。Host实际读取配置出证、同Key修订确认、按渠道保留回退基线的方向正确。独立运行全量23组798项+契约7项通过，但另有两个真实补测失败，当前E4861F38…包仍不应放行。

先把下面两项写成会失败的回归，再修实现：

X1：双端配置摘要规范化不一致。
Host entryPublicIdentity会trim URL/键路径/引用、规范化币种、小写credentialHost；客户端configDigestOfClient却拼原始字段。URL=' https://a.example/b '或balancePath=' balance '是设置校验和Host解析均接受的合法值，但Host成功响应的proof永远与客户端不等，Badge只显示“—”。
要求：规定唯一字段规范化并让两端完全一致；不仅修新保存值，既有配置/CLI/YAML及真实Config路径也应支持。覆盖URL和路径空格、币种大小写/空格、credentialHost大小写、缺字段/默认值、重复非法id、长度边界。用真实Host proof→真实Badge证明合法值可显示，同时保留真正不同配置的拒绝测试。

X2：仅customKeyRev更新时轮询仍捕获旧摘要，且旧值未即时作废。
form快照从rev0更新到rev1，但没有当前页面本地bumpConfigEpoch时，effect依赖不含expectedDigest/customKeyRev，局部expectedDigest仍为旧值。Host已返回正确rev1证明和新余额，连续强刷也被拒绝；修订刚变化时旧余额还可见。另一窗口保存Key即可出现此类公开配置更新，不能靠本页保存事件兜底。
要求：公开修订变化也进入请求身份/生命周期；及时取消旧请求并更新期望摘要。applied逐条身份、渲染过滤和基线清理也应纳入该条公开Key修订，不仅比较元数据签名或本地dirty事件。不影响其他id的成功基线和失败计数。
测试必须使用form.publish只更新customKeyRev、不调用invalidateCustomChannel：旧值在新请求挂起时立即隐藏；旧proof拒绝；匹配新proof后恢复；相同Key幂等保存、真正换Key、A变更/B暂时失败均正确。不能要求重挂/重启/再改URL才能恢复。

不要用删摘要校验、删dirty保护、每次清空全表、固定等待2秒、放宽旧测试断言来解决。保留目标绑定、SSRF连接约束、超时、WorkBuddy分类、阈值8与三渠道退场。

修复后：
- 跑全部现有23组回归+WorkBuddy契约和新负例；准确统计检查/断言，不沿用遗漏MiMo组的旧数字。
- 更新整改与审查补记，不提前声称独立验收通过。
- 重新打本地包，核对20个payload、语法/注册表和新checksum。报告每项失败→通过证据、修改位置、测试结果、未验证项及产物。
- 真实宿主事务/secret投影、Android HTTPS能力未测试就明确注明，不能把mock当真机。

硬性限制：不部署当前profile、不改DSH宿主、不自动重启、不git commit、不创建或修改标签、不push、不Release、不npm publish；不推进方向6。
```
