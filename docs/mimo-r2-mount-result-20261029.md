# MiMo R2 最小试装结果 · 2026-10-29

## 当前状态

> **已回档；16:19更新：用户已重启并重新启用Usage Dock，MiMo未挂载。** 挂载后曾出现启动报错，随后观察到827字节配置；不能仅凭此认定写入者或自动净化机制。主在用户回档请求后恢复过7417字节基线，但用户当前调整后已是7459字节，不得再自动覆盖。已找回真实错误：`web boot: 1 entry did not activate / dsh-mimo-login-poc: loading`，见[本轮权威复核](mimo-startup-recheck-20261029.md)。本次许可已消费，不重复试装。

**下文为回档前的历史执行记录，不是当前安装成功状态。** 主在用户[本次明确许可](mimo-r2-mount-permission-20261029.md)内，仅给当前desktop配置追加一个独立条目，未自动重启DSH，未访问当前GUI、未扫码、未请求官方服务。没有恢复旧配置或执行回退。

## 执行与核验

- 工具最终版本：`a22e6b46898590347a7afa280a8cfdf2ba1fd7f5666136414929f9da2f4e1951`；4个冻结文件核对drift 0；[独立审查](../.diagnostics/mimo-mount-r2-20261029/audit/VERDICT.md)条件满足。
- 主用packaged Electron跑合成真实YAML适配测试：**7/7**，无真实配置读取；随后本机只读真实preflight返回`E_MOUNT_OK`。
- 仅一次真实apply返回`E_MOUNT_OK`：追加1个insert、3行、165字节；当前配置从7417变为7582字节。
- 新包archive `5d15d89807bd832ed7bb9c1a115f97069ec74344a0b005af9808cafeb60b4678`、manifest原始字节 `ef07820f88761cb30be862c62d4255d29672290559457a19e1fd770e2be28396`及11个staged文件均校验通过，包本体未修改。
- 原始配置字节在本机profile新私有目录`.mimo-poc-backup-r2-20261029`备份；未复制至工作区或Git、未回显原文，不读取/使用旧20261027备份。不要上传该目录，里面可能含原有秘密。
- [主独立写后核验](../.diagnostics/mimo-mount-r2-20261029/parent/post-verify.json)：`prefixExact=true`、`wholeFileExact=true`；实际新文件精确等于**当前原始配置全部字节+本次追加块**，before/after均与预检/apply一致。
- before SHA256：`6b906521dba07f3e468678b4c1157ef7bfcdd211f9860e6f10f3368e5c60a8ea`
- after SHA256：`8e1238e44bb493ada8486e22f6782d13b2989eba1afb5f2e8396db692ab1aaaa`

上述是执行及写后检查当时的证据，不保证用户后续编辑后的文件仍为同一hash。CAS复读+rename不是OS原子比较交换，不承诺并发保存安全；目标文件取目录继承ACL，不声称保留原文件自身ACL。

## 交给用户的下一步

1. 自行保存工作、手动重启DSH；主不会代为重启。不以写盘成功声称插件已激活。
2. 打开“设置 → 内置插件 → MiMo 登录试验”。实际页面标题为“MiMo 登录试验（仅内存）”。
3. **先只点击“检测本机连接（不访问官方）”**，把显示的固定提示/错误码告诉主。不点击开始/扫码；不发送二维码、Cookie、Key或余额数值。
4. 如启动异常、找不到页面或检测失败，停止后续操作，报告现象/固定码；不重复试装，不恢复旧备份，不自行放宽安全检查。若需撤销，另行确认后仅针对本次新增段与本次备份做定点处理。

扫码、余额、跨重启恢复、续期仍未通过；本人主动真实扫码试跑另行确认。未安装依赖、未替换UsageDock/WorkBuddy程序、未发布或推送。挂载permission/started已消费，不得删除重放；旧隔离服务许可同样已消费。
