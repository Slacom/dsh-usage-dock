# MiMo 两次桌面启动报错：只读复核（2026-10-29）

> 本文取代[上轮事故记录](mimo-r2-mount-incident-20261029.md)中未经验证的因果判断。当前是**已恢复并重新启用Usage Dock、未挂载MiMo**；不是安装成功。客户端加载链仍在离线核查，不再次试装。

## 已确认的现场

用户说明重新开启的是Usage Dock，没有看到MiMo。16:19（+08:00）的[有限只读摘要](../.diagnostics/mimo-startup-review-20261029/parent/live-summary.json)显示：当前desktop配置7459字节，已知`plan-usage`条目存在，`mimo-login-poc`不存在。这里只证明文本条目存在性，不代替运行态检查。当前是用户重启、调整后的新状态，**绝不能再以旧7417字节快照自动覆盖**。

本轮没有修改真实配置、安装插件、重启DSH、发HTTP请求、扫码或读取凭据文件。只在工作区保存公开程序副本、合成测试和安全摘要；原始配置、私有备份、整份崩溃日志均未复制到工作区。

## 找回了实际错误，不再依赖记忆或猜测

从当前安装程序确认：Electron使用`app.setAppLogsPath()`，实际应用包名是`@deepseek-ai/dsh-desktop`。日志在其Electron数据目录下，不是此前查找的`.dsh/logs`。

只选取2026-10-29 07:56:47.465Z与2026-10-28 09:31:56.886Z、09:32:09.822Z三份指定崩溃报告，在本机按严格白名单提取。三次均为：

```text
Error: web boot: 1 entry did not activate
dsh-mimo-login-poc: loading
```

[错误模板与标签核验](../.diagnostics/mimo-startup-review-20261029/parent/crash-error-template-labels.json)逐行匹配第二行为**浏览器package名**，不是Host条目ID，也不是从stack中的file URL猜出的关联；异常正文不含file URL。[安全投影](../.diagnostics/mimo-startup-review-20261029/parent/crash-projection.json)记录三次`source=web-boot`、`phase=running`：报告时后端已报告ready，但这不证明后端所有功能均正常。

## 已定位到的失败边界

当前SDK前端的`jZ`执行客户端加载，`IZ`遍历浏览器Loader条目；某条目不为active，就按`options.name`和实际fiber状态生成错误。MiMo这里是**LOADING，不是PENDING**。参见[公开前端读取视图](../.diagnostics/mimo-startup-review-20261029/parent/frontend-current/index.readview.txt#L16270-L16304)；该视图只为阅读插入换行，不可执行，原件和hash见[前端来源清单](../.diagnostics/mimo-startup-review-20261029/parent/frontend-current/MANIFEST.json)。

随后[Desktop IPC](../.diagnostics/mimo-startup-review-20261029/parent/public-current/desktop-main.js#L12433-L12437)将页面bootFailed上报为`web-boot`，打开原生故障恢复框。

因此已确认：**本次致命错误由MiMo客户端未完成激活引发网页启动审计失败**。尚待解释的是其客户端为何在该检查点仍为LOADING；不能把状态名称直接当成最终根因。

## 排除与更正

- **不能再称“Desktop没有connection”或“硬inject会提前apply”**。Desktop本身走base+web-app，前次真实Cordis试验也证明硬依赖会等待服务；且本次报告明确点名浏览器package，不是Host服务缺失报告。
- **不能称“在profile覆盖行后追加insert本身非法”**。主对[当前安装的app-boot源码](../.diagnostics/mimo-startup-review-20261029/parent/public-current/app-boot.js)先核SHA `5135179ac810e4f626f32ec3bdc3293dc7d2028e8aa92e5e0c006f1a33b78e76`，精确抽取其`applyEntryPatches`与`composeEntries`做VM纯计算：合成bundle先insert、profile再override既有Usage Dock并insert MiMo，覆盖正确、无关条目保留、新增条目恰好一个、0 warning。[主独立断言结果](../.diagnostics/mimo-startup-review-20261029/parent/composition-result.json)。这不保证任意恶形输入、YAML表达式或后续Loader都安全。
- **file URL不等于客户端必然解析失败**。[客户端模块发现](../.diagnostics/mimo-startup-review-20261029/parent/public-current/client-modules.js#L762-L807)明确支持file路径并找最近的package.json，以manifest包名建表；浏览器条目按包名登记。当前异常正文也没有file URL。不能仅因未安装进node_modules就认定根因。
- **“DSH自动净化删15条”不是已证事实**。[恢复框代码](../.diagnostics/mimo-startup-review-20261029/parent/public-current/desktop-main.js#L8376-L8379)只在选择“禁用第三方插件”的条件下调用恢复；[sanitizeProfile](../.diagnostics/mimo-startup-review-20261029/parent/public-current/desktop-main.js#L3531-L3545)只rename原patch为时间戳备份并改bundles，不直接生成827字节内容。该路径与现场备份相容，但不据此断言用户具体点击或827字节的写入者。rename保留mtime，原先据mtime认写入时间/写入者的推断撤回。

[WB High补丁侧复核](../.diagnostics/mimo-startup-review-20261029/patch/FINDINGS.md)也确认：旧23项参考实现、8项fake parser和7项YAML适配器测试，均不覆盖完整桌面客户端启动。原最小Web Core真跑只证明后端owner路由与退出，不能当桌面UI启动已过。

## 本轮最终核验：负向重放未复现，不能宣称根因已修

[WB Max源码与局部重放报告](../.diagnostics/mimo-startup-review-20261029/runtime/REPORT.md)说明冻结客户端的`apply`是普通同步函数；Settings的`describe`会跳过未激活或无Config的条目，不是本次`web boot ... loading`消息的生成处。其Node Cordis＋fake React/slots探针观察到ACTIVE，但两个never-register变体在dispose时因顶层await未结算而exit13，**不能计为完整通过项**；这也不是完整真实浏览器启动验证。主随后独立采用可结算的deferred fixture补做了激活与清理断言，见下文。

主独立做了[三项有超时与清理断言的负向对照](../.diagnostics/mimo-startup-review-20261029/parent/verify-client-controls.mjs)，先校验冻结客户端SHA，并确认使用的Node Cordis源码与当前安装ASAR逐字节一致：[结果](../.diagnostics/mimo-startup-review-20261029/parent/client-controls-result.json)。

| 合成情形 | 观察与断言 |
| --- | --- |
| slots.register同步返回disposer | 客户端进入ACTIVE，注册恰好一次，清理完成 |
| slots.register返回暂不结算的Promise | 客户端仍进入ACTIVE；随后显式结算fixture Promise并验证清理完成 |
| slots提供者晚于客户端 | 先PENDING(0)，提供者出现后ACTIVE(2)，清理完成 |

三项整体exit0、渲染调用0、网络尝试0、真实profile读取0。它们只反驳局部“声明inject/普通apply必然挂住”的推断，**没有复现历史故障，没有运行真实浏览器的完整ClientEntries＋slots＋其它插件管线，更不是R2通过验收**。

准确结论分两层：

1. **直接失败点已证**：浏览器`dsh-mimo-login-poc`在web boot审计点仍为LOADING，引发原生失败框。
2. **具体触发根因未证**：现有源码与受控负向对照不足以解释历史时序。不能据此修改connection/Config依赖、安装位置或增加等待，更不能声称已修复。

后续若安排独立隔离的浏览器生命周期探针，应记录限定条目的state、uid、epoch、inertia是否存在及其结算/拒绝结果，并区分Node局部重放与完整浏览器管线。**inertia存在不等于Promise仍pending**（可能已结算或拒绝而被保留）；必须结合具体时序与异常路径判断，不输出配置、票据或任意异常原文。

## 操作边界与下一步

本轮核查到此，不修改冻结R2、不重新挂载、不再让用户重启试错。Usage Dock及当前用户配置保留。若下一步需要启动独立桌面/临时服务来捕获真实生命周期，必须先明确隔离范围并取得新许可；原挂载和最小Web Core许可都已消费。

若定位修复点，先补能复现本次客户端启动失败的离线集成用例，再讨论修复/新包；**没有客户端启动证据，不再让用户承担重启试错**。扫码、官方请求与发布仍未授权。
