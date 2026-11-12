# MiMo设置页候选：父审未通过清单与权限状态

## 2026-10-27最新复核（以下历史缺陷不代表全部仍未修）

- 父已独立运行包内flow **42/42**、会话生命周期 **18/18**、自有snapshot完整性门，全部exit0；受验收WorkBuddy **39/39文件哈希一致**。
- 候选vendor已真实物化。WB Flash Max代理`f73d2154-f8e4-466b-b613-6bcda857914b`逐hunk审查并修正snapshot过时pin，新增反例；没有因更换模型丢弃有效代码。flow候选SHA256为`c2a0d41c66557abbe23356ef51585abedc2f389990462bcd85609f63cada4a5a`，jar逐字节等于受审原件。
- 主重新从当前ASAR读取三份固定公开代码，connection、client-modules、settings-plugins客户端均与26号受审源哈希一致，仍`0.2.1-rc.3`。没有加载profile、配置或凭据服务，没有联网。
- 新的Host/客户端实施代理`86b07bf4-8a79-4449-a0f2-4adc61783bfb`显式使用 **workbuddy / cn:deepseek-v4.1-flash / max**。初稿已补齐两阶段Start→Begin、8秒准备租约、严格owner/CSRF/流式请求上限及状态投影。父已在捆绑运行时独立跑Host **35/35**、旧整合集 **34/34**、独立会话负例 **4/4**，全部exit0。
- 父新增[真实包内模块离线串联](../.diagnostics/mimo-qr-20261026/parent-settings-e2e.mjs)：实际Host/routes/session/vendor/parser，**上游全部fake且无真实HTTP/DNS/账号**，15/15通过，覆盖待批前仅两次mock入口、owner图片资源、白名单账号字段与余额确认、取消清理、官方短deadline先到后审批不可用。只证明代码离线接通，不是真机扫码或钱包验收。
- 客户端初稿父审抓出pagehide未作废旧epoch/图像却恢复旧会话、旧Begin回调误取消新session、poll/QR共享boolean跨代次串写、qrKey被clearQr覆盖及断网无本地过期兜底；同一WB Max正在小批修复并补负例。UI原先将‘四关’错写为四个登录步骤，也须改回扫码/余额/跨重启恢复/续期的真实口径。客户端冻结后再父审，不跑编辑中间态，不打包安装。
- 旧整合A9的退出13根因已核：fake tick只改时钟、未驱动真实定时器或任何入口检查，然后await审批；并非已证明生产TTL失效。需用注入scheduler做确定性测试，不放大生产预算。旧dataURL流程测试将改真实包内import。
- 从获准官方域原样收到的合法`Domain=xiaomi.com` Cookie按RFC匹配发送，不等于人为抬升；仍禁止把host-only子域Set-Cookie改写给account根，JSON账号字段的协议映射则仅限本次已批准精确lp回执。
- 当前仍不可安装，真实扫码/余额/恢复/续期都未通过。完整包离线过审后才请求新的本机安装及扫码许可，不复用旧marker。

## 授权与不变范围

用户批准独立临时设置页插件的**工作区构建与离线审查**；不安装、不部署、不重启、不真实扫码、不写凭据或读取真实profile。完全权限仅消除执行限制，不扩大业务授权。主仓库仍`feat/mimo-qr-20261025@70a27b5`，旧个人进度文件不得读改。

诊断已消耗26号双请求许可，结论是longPoll落account子域且现策略拒绝，具体hostname未知；不得重跑、推断c3或放宽通配域。

## 初稿不能安装

原实施代理`bc59c7f9-bb02-473e-93d9-94e44f479f26`已停止，报告预算耗尽，以下父审修复**未完成**；32个离线测试只是初稿局部测试，不能当作真实apply/可装包验收。client.js未写，vendor目录在父解决执行权限前未生成；现目录已创建但模块未物化。

1. Host遍历ROUTE_PATHS得到大写key，但METHODS及handler都用小写，实际注册和分派不可用。须用真实apply→注册→Fetch handler端到端测试。
2. owner状态缺approvalId；QR只校验gen不校验sessionId。须双绑定。
3. cancelled/failed/done/expired/disposed终态必须拒迟到写；TTL主动abort、过期入口清理、审批Promise结算、旧timer回收，dispose后禁止start。
4. fetch须接chargeCall与会话deadline；后台task跟踪；setQr失败不得宣称shown；余额本机展示须保留parseBalance的白名单数值，而非只存report门槛布尔。
5. body需字节上限和有界读取；POST严格schema拒未知URL字段；Origin匹配scheme+host；明确缺Origin规则与CSRF测试。
6. register保持方法this；缺connection不得因logger错误抛出。全部敏感资源仅owner/no-store，不降级裸HTTP。
7. 候选flow补丁正常account-exact路径漏register；approval裸await必须受同会话预算/取消/代次检查。
8. 账号JSON票字段从子域转给account不能使用泛suffix授权；仅当前会话官方初始化、本人批准的**同一精确lp URL**回执可在受审流程中映射白名单字段；Set-Cookie仍按实际来源域，不抬升。
9. 每次fetch须有子AbortController及贯穿body的单次剩余预算，cap到点先abort旧请求再下一poll，不让不合作长轮询并存；不加调度余量。
10. 完成设置页client：owner相对路径、纯文本origin确认、随机session/approval ID、QR blob撤销、卸载/取消/过期清理，不能靠本地按钮冒充服务端登录成功。

## 当前只做的小批次

上下文已满的原代理不再分配新工作。新窄任务代理`0ed99a0a-5f8f-4464-98bb-a7af61693383`只修改[会话模块](../tools/poc/mimo-settings-plugin/lib/session.mjs)，并新增生命周期测试；不改routes/index/flow/client。完成后父独立验证，接口takeQr将要求(sessionId,generation)，后续routes须同步。

父独立探针：[session负例](../.diagnostics/mimo-qr-20261026/parent-settings-session-probe.mjs)。它覆盖取消后QR/finish拒绝、错sessionId取图拒绝、过期审批拒绝。routes未修之前，路由集成项预期仍失败，不能为过测删除断言。

## 文件权限调查：不能称沙箱已修

原命令在workspace-write反复被拒：创建`tools/poc/mimo-settings-plugin/lib/vendor`。

获准运行官方诊断：观察到lib、mimo-settings-plugin、poc、tools四级目录缺少有效WRITE_OWNER，补当前用户完全控制后逐项验证成功，未改文件内容或所有者。未发现需删除的外来包权限，未执行回滚。

随后**原命令在沙箱内仍被拒**，因此停止继续权限修复/绕过。用户将会话切到danger-full-access且approval=never后，同一个New-Item命令成功；这只是完全权限模式下成功，不能宣传原沙箱失败已解决。

[完整权限报告与恢复命令](<E:/WorkSpace/DSH/acl-recovery-mimo-settings-20261026/acl-report-a7746654938f4c758a65ec26842251f2.jsonl>)中summary.rollbackCommands给出逆序恢复命令：tools→poc→mimo-settings-plugin→lib。每项备份与脚本均在同一恢复目录；本轮没有执行恢复，也不因后续沙箱仍拒绝自动撤销已验证的权限修改。建议用户把会话及报告反馈DSH。

## 下一阶段闸门

先完成小批次及父审，再处理其它明确缺陷并验证可装包；尚未获准安装或真实扫码。不得因为自动goal轮次或文件完全权限就跳过这些闸门。没有新的真实API请求或后台扫码进程。

## 2026-10-27：子代理模型约束更正

用户再次明确：**子代理只能使用WB-DeepSeek-V4.1-Flash**，按任务选择High或Max。以后每次委派必须显式指定`provider=workbuddy`、`model=cn:deepseek-v4.1-flash`及`reasoning_effort=high|max`，不得省略以免继承主模型；也不得继续旧GPT子代理。

误用GPT的`0ed99a0a-5f8f-4464-98bb-a7af61693383`与`0de42b42-704d-46ed-bbb9-50746aeb4c63`已请求停止，后者在交稿前中断。现有改动保留，不能因换模型直接删掉，也不以原代理口头进度作为验收。新的`f73d2154-f8e4-466b-b613-6bcda857914b`已明确使用WB Flash Max，接手vendor流程/sync及其离线测试，范围不包括安装或联网。

父正在整合两阶段Start→Begin、owner路由与客户端；当前仍是未完成候选，不可安装。当前GUI为`http://127.0.0.1:14656`。文件完全权限不扩大真实账号试验授权。

