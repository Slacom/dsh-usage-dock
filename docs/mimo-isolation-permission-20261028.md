# MiMo修复候选：隔离验收许可与启动前闸门

## 人工许可

用户在2026-10-28业务确认框明确选择“允许隔离验收（推荐）”。原问题完整范围：先核查隔离方案，确认安全后，用临时独立Home/profile启动**一次仅本机测试服务**，验证应用冷启动及只读本机接口；不改desktop、不重启当前DSH、不加载原有账号/供应商凭据、不发官方请求，无法确认隔离就不启动。该许可**不是**正式desktop试装、重放旧挂载或再扫码许可。

对象仅[新修复包](mimo-repaired-build-20261028.md)及其新staged11文件；包sha为`5d15d89807bd832ed7bb9c1a115f97069ec74344a0b005af9808cafeb60b4678`。不再修改此冻结包；旧包仍撤回。

## 启动前先证实

- 实际Web launcher的最小必要公开服务闭包；不盲启含账号/模型/Connect/更新的完整默认bundle。真实Web应用启动不是完整Electron/Desktop重启，两者不得混称。
- 私有临时空Home/profile/cwd及干净env白名单；包括DSH_HOME、HOME/USERPROFILE、APPDATA/LOCALAPPDATA、XDG与dotenv层。原有真实profile、浏览器、其它插件认证状态/系统凭据不读。
- 公开安装锚点只用于已有程序/依赖，不运行npm/pnpm/download/升级。临时SDK通信凭据只能在新空环境生成并由测试进程私下消费，不借当前DSH owner Cookie/launch key。
- 读仅临时目录、固定公开程序、冻结stage；写仅临时目录。native SQLite等绕过JS fs hook的路径必须沿源码核实；JS hook不能被称为OS安全沙箱。
- 仅自有实例的127.0.0.1临时端口，不连接当前GUI `http://127.0.0.1:12263`；外网/DNS/遥测尝试要计数并判失败。无法保证则不启动。
- 程序可能打印认证URL，全部原始stdout/stderr必须有界内存捕获、禁止回显/写raw日志；仅输出固定码/计数/布尔值。未知异常不输出message/stack/body。
- 默认preflight不启动；执行前父创建新单次permit，wx消费started，旧许可不删除重放。启动及总时长均有硬上限，退出清理只针对本次spawn对象的PID树，不按名称杀当前DSH。
- 测试主要是GET全零会话id的本机只读probe；不调用有效Begin/approve或触发官方初始化/QR/钱包请求。新临时通信key、cookie、认证URL不进入聊天、附件或Git。

## 分工及当前状态

- WB Flash Max：最小真实启动方案、公开源码路径证明、新runner与离线边界测试，仅写`.diagnostics/mimo-isolation-20261028/impl/`。
- WB Flash High：独立否定者审查目录/env/storage/network/log/PID清理边界，仅写`.diagnostics/mimo-isolation-20261028/audit/`。
- 两者均无权实际启动服务或导入启动库运行；先报告可靠性和边界，主独立核验后才决定是否消费这次许可。
- **此单次许可已于2026-10-29 13:50 +08:00消费：隔离Web Core实跑通过，临时子进程/端口/私有temp已回收。不得重放或另建permit重试。** 见[真实运行结果](mimo-isolated-webcore-result-20261029.md)。未修改真实配置、未读取真实认证数据、未请求官方服务；正式desktop试装不在此许可内。
