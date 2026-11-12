# MiMo独立试验页：本机挂载完成，等待本人扫码验收

## 授权与实际操作

用户此前在主对话回复“都允许”，授权desktop独立临时挂载与本人一次仅内存扫码/钱包核对；28日下午直接要求继续。本轮已按此范围执行，没有重新解析npm/pnpm依赖、覆盖UsageDock、自动重启或另开服务器。

- 冻结候选、11文件、包与manifest pin均未变，见[冻结说明](mimo-settings-candidate-20261027.md)。
- WB Max实施[挂载工具](../tools/poc/mimo-settings-mount.mjs)及[25项文件操作fixtures](../tools/test-mimo-settings-mount.mjs)、[8项真实YAML adapter fixtures](../tools/test-mimo-settings-mount-adapter.mjs)。父审纠正ASAR路径缺失` Harness`，严格拒绝全部YAML错误/重复CLI，并将回滚收口为只截掉已核验的自有尾块、不重写原文。父独立运行25+8项全部通过。
- 真实只读preflight成功，无同名/同id冲突，无旧备份或旧started；随后创建并消费新的单次**挂载**permit（不是25/26号已消费的供应商试验marker）。
- 真实apply成功：只给desktop配置追加自己的一个`insert`块，指向[冻结入口](../.diagnostics/mimo-settings-20261027/staged/dsh-mimo-login-poc/index.js)。**请勿在挂载期间删除或移动该冻结目录**；后续先清退配置入口再整理目录。

## 独立后验

- 原配置7,417字节完整保留；新增仅162字节；结果7,579字节。父另读取本机原备份和追加块，只在进程内逐字节验证`after = before + ownSuffix`，没有把原内容输出到聊天。
- before SHA256：`6b906521dba07f3e468678b4c1157ef7bfcdd211f9860e6f10f3368e5c60a8ea`。
- after SHA256：`c7a95f8ce19e0dd252867ca4066f8f5458ffdca1716d5644b1c947ebec1cc5fc`。
- 原文件备份保存在desktop profile的`.mimo-poc-backup-20261027`私有子目录，包含原字节副本；**可能含既有secret，禁止读入聊天、入库或作为附件交付**。
- WB工作区39文件及已安装可比程序27文件hash全部未变；原WB公开客户端资源仍HTTP 200。
- 当前GUI `http://127.0.0.1:14001` 的候选revision客户端资源HEAD已由404变200。匿名状态请求仍401，未读取响应正文。验证脚本只请求本机静态资源和匿名错误状态，未触发Start/Begin、未读取owner Cookie/票据/余额。

客户端资源存在不等于页面渲染与owner接口全链已验收；后者须在用户浏览器实际确认。未承诺Android、反向代理、恢复或续期。

## 本人验收步骤

1. 先刷新当前DSH页面，进入“设置 → 内置插件 → MiMo 登录试验”。已有客户端资源生效，**不用先重启**；如果入口不出现，先报告，不另起服务器。
2. 点击“开始本次试验（仅内存）”。如出现轮询目标批准，目标只在本机查看并按本次用途批准；官方扫码及手机确认由本人完成。
3. 对照**扫码那个账号**的官方钱包三项，点“一致”或“不一致”。不是Token Plan额度。本次不保存认证票，成功不等于恢复/续期已通过。
4. 失败后先停，不连续点开始。聊天只报告入口是否出现、扫码结果、金额是否一致或固定错误码；不要发二维码、认证URL、Cookie/passToken/Key或金额截图。

主没有启动真实扫码会话；安装逻辑不自动Start，实际本人是否已在页面启动/扫码及结果，等待用户反馈。四关未过，不进入正式0.9.1发布。

## 回滚与续接

如需撤回仅此挂载，主可按[工具](../tools/poc/mimo-settings-mount.mjs)的`--rollback`精确CAS验证再清退。只有当前配置hash仍等于本次after、原备份hash和尾块都对时才可回滚；若用户已保存其它设置，**不得用旧备份覆盖新改动**，须重新审查如何只删除自己条目。原备份不自动删除。

自动目标控件恢复调用被平台拒绝（需用户自行恢复），最后已知仍paused/revision7；本轮是按用户明确继续指令的普通执行，不创建重复目标或假称自动续跑已恢复。
