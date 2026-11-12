# 隔离Web Core：主初审仍不放行

## 状态

[本次许可](mimo-isolation-permission-20261028.md)尚未消费：未创建启动permit/started，未启动实际SDK应用或临时HTTP服务，未读真实profile/认证数据，未改当前DSH或正式desktop。仅做公开程序源码复核及普通离线/无服务能力探针。

范围仅隔离Web Core后端启动与临时owner API，不能称完整Desktop、前端渲染或真实扫码验收。[修复包](mimo-repaired-build-20261028.md)继续冻结不变。

## 主独立初审发现

审查了[runner](../.diagnostics/mimo-isolation-20261028/impl/runner.mjs)、[plan](../.diagnostics/mimo-isolation-20261028/impl/lib/plan.mjs)、[guard](../.diagnostics/mimo-isolation-20261028/impl/lib/guard.cjs)及FS-AUDIT的当时草稿；这些仍在修改，以下是修复要求，不是对新版本的放行结论。

- 候选只能按固定新包逐文件bytes/hash验证，不能用版本/文件存在/源码includes代替；archive hash必须实际进入闸门。
- listener/PID/loopback校验必须在**首次HTTP握手之前**阻止外实例，不是请求之后再统计失败。
- 先停本次spawn子对象并确认退出，才清私有temp；不能把删目录成功等同killed/survivors事实，不能在进程退出后按可能复用PID裸杀。
- HTTP读取需绝对总预算、超限即时中止、aborted/error/close都结算；整体parent watchdog主动停止子实例，不只是事后检查耗时。
- owner接口唯一正例为404、body ok:false及固定missing-session码，不能仅state idle。
- listener调用前限制127.0.0.1+port0且一次，不能先bind任意地址再记录。所有DNS解析API拒绝；literal lookup可纯本地返回，不调用系统resolver。
- realpath检查失败的未知路径不得反而递归删除；permit/started固定作用域、CLI严格参数，不重放旧许可。
- 未测的path/env/survivors数据不能硬编码为0或由其它成功事实推算。

这些已交WB Max最小修复，WB High按明确freeze/hash复核。不能用审计自己的参考守卫65项通过当作真实impl通过，也不能自动重录hash基线就把旧意见套到新代码。

## 主补充的可用证据

- [公开CLI包装器副本](../.diagnostics/mimo-isolation-20261028/parent/desktop-cli.js)来自现装程序，只复制而未运行。实际公开cmd第4行使用Electron `--expose-internals` 调用该包装器；此标志有官方兼容依据，并非单独的隔离漏洞。包装器额外Office/koffi逻辑无需引入本测试。
- 主在packaged Electron Node模式仅动态import了已检查无顶层副作用的公开home-paths辅助模块，不调用其函数。结果：ASAR ESM import成功、eval import.meta.main可用、serviceStarted:false、profileRead:false、networkRequests:0。这不证明真实CLI能成功启动，但不能再将ASAR ESM基本能力当作未知。
- 本合同只允许IPv4 127.0.0.1的单listener；额外IPv6/通配监听应失败，不能为通用兼容性扩大验收范围。

## 不把未知变成循环或伪证

真实CLI是否起得来、scoped系统查询是否成功，是受控试验要测的功能结果；隔离数据路径、输入字节pin、HTTP前身份闸门、日志防泄漏与退出保护才是执行前条件。不能为了可执行把未测项伪造成已知，也不能以“未运行”无限循环禁止一切可控测试。

没有OS恶意代码沙箱；信任固定已装公开SDK，不信任任意代码。最小闭包的数据路径必须启动前沿源码证实，native缓存重定向明确；不能仅靠事后diff发现真实Key已被读走。原生理论旁路应如实保留为边界，不将JS守卫冒充内核隔离。确认真实前置条件前不启动，任何无法解释的路径/外网行为即停止报告。
