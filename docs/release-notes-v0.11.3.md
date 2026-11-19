# dsh-usage-dock 0.11.3（正式版）

> 上一公开版：**0.11.1**。0.11.2 与 0.11.2-alpha.* 均为预发布（npm 侧只挂 `prerelease` dist-tag），
> 本版把它们的内容**转正**，作为正式版发布到 npm `latest` 与 GitHub Latest。

## 主要更新

### 小米 MiMo：改用 API Key 读余额（扫码登录下线）

- 余额来自「设置 → 模型」里已有的 MiMo API Key（`XIAOMI_API_KEY` 优先，兼容 `MIMO_API_KEY` 等），
  也可用插件配置项 `mimoApiKey`；找不到固定名字时会按 provider 名含 mimo / xiaomi 自动取该来源的 Key。
- 接口固定为 `GET https://api.xiaomimimo.com/v1/platform/balance`（请求头 `api-key`）；
  口径 = 现金 + 赠金（不含授信额度）。
- **扫码登录入口全部下线**：网页设置页不再渲染 MiMo 登录卡、详情面板不再显示扫码/会话行、
  原生 `mimo-login` 面板已从清单移除；缺 Key 时提示「未配置 Key」而不是「未登录」。
- 修复「Host 已取到余额、界面却显示未登录」：客户端不再用旧的显示会话快照覆盖真实余额。

### DSH Go 原生面板

- **渠道顺序**：额度面板按 DeepSeek → MiMo → WorkBuddy → Codex → OpenCode Go 显示。
  根因是配置里 `planOrder` 是 JSON 字符串，旧实现只认数组导致永远退回注册表顺序；现统一解析，
  用户保存过顺序时仍以保存顺序为准。
- **瞬时失败宽限**：取数瞬时失败的前 4 次沿用上次成功值并灰化显示（不报错），第 5 次才显示原因；
  鉴权/配置类错误立即报错且不复用旧值；恢复成功后计数归零。
- **进度条颜色**只由剩余额度决定（≤10 红 / ≤30 黄 / 其余绿 / 无数据灰），不再因失败染成黄褐色；
  余额行的数字在失败缓存期灰化。
- **打开面板先显示上次缓存**的数据，再后台刷新，不再出现空白等待。
- 设置页：渠道顺序同上；移除 DeepSeek / MiMo 的「余额提醒」输入（原生面板本就不显示提醒）；
  DeepSeek 不再提供币种选择（固定 CNY）；MiMo 不再有单独说明行。
- **Codex 一键适配**：可自动读取本机已装的 `dsh-codex-subscription` 版本；**没有专属清单时**
  用收录的最新清单锚点在**实际安装的文件**里逐条校验「恰好命中一次」，全部命中即可一键适配
  （适配前备份、写后校验、重复点击不重复写入）；任一锚点不满足仍拒绝，不猜。
- Codex 额度只显示 5 小时 + 周两个窗口（不再显示月额度），策略开关打开后可直接配置两档阈值。

### 网页设置页

- 额度策略表改为等宽 grid 四列（窗口 / 当前剩余 / 预警% / 收尾%），修复窄屏错列、
  数字与输入框重合的问题，字号沿用设置页原有样式。
- 策略标签统一为「预警 / 收尾」，不再带「元 / 积分」后缀。
- OpenCode Go 不再提供「月」窗口的预警 / 收尾配置。

### 其它

- 新增 Codex Subscription `3.2.23` 补丁清单。
- 版本号体系：仓库内以 `0.11.3` 作为正式版；此前 `0.11.2-alpha.*` 为移动端联调预发布。

## 安装

```bash
npm install dsh-usage-dock@0.11.3
```

融合层配置见 `cordis.patch.yml`（向 profile 插入 `plan-usage` 条目）。

## 已知问题

- 仓库内 7 组 MiMo 扫码登录相关的旧测试（`test-mimo-auth-client`、`test-mimo-display-*`、
  `test-mimo-footer-refresh`、`test-mimo-remembered-*`、`test-quota-round4`）仍断言已下线行为，
  待下一轮清理；其余核心套件（原生面板 50 项、边界 47 项、usage_status 108 项、
  额度策略 89 项、设置页布局 30 项等）全部通过。
- 3 组依赖真实宿主/本机状态的旧用例（`test-codex-auto-adapt` 依赖本机未适配样本、
  `test-recheck-round3`、`test-usage-recheck-f1f2`）在部分环境会失败，属既有测试债。
