# MiMo「记住登录」——本轮运行时验收（2026-11-10 17:00）

**状态**：`passed-this-runtime-restoration`

## 事实（用户实机，本人确认）
- 2026-11-10 17:00 用户明确回报：**「这次可以正常显示了」**；managed 面板**余额正常显示**、**每 5 分钟刷新**。
- 面板计数：恢复 **1/1**、自动读取 **55/55**、换票 **0/0**。
- 性质：这是**现有记录跨重启的自动恢复 + 连续读取**在实机通过，**不是**又一次扫码后的首次成功。
- 本文不记录任何实际金额 / 账号 UID / 截图 token / URL。

## 当时安装状态（未变）
- SSO 传输层 = 单文件 `plans/mimo-auth/secure-transport.js` = `811A4F26…A961F9`；其余 **16 项未改**；
  `version` 仍 **0.9.0**；权威清单 `.diagnostics/mimo-sso-header-profile-20261109/INSTALLED-MANIFEST.json`（17）。
- 安装时点的 RECEIPT `runtimeVerified:false` **保持原样**（那是安装当时的事实，不回填）。

## 证据强度（不夸大）
- 本轮只证明：**当前这套组合候选（固定 UA / Accept / Accept-Language + 既有记录恢复路径）在本机这一次运行时通过**。
- **不**宣称 UA / Accept / Accept-Language 中**哪一项必要或唯一因果**；组合为一整体。
- **不**保证未来长期有效，也**不**保证厂商今后永不再要求登录。
- 观测到**换票 0/0** ⇒ **不**宣称「平台票过期后的自动 renewal 已实机验收」。

## 剩余边界
- 服务端侧的 SSO 目标 shape、票据生命周期等仍**未被服务端契约保证**；本次只是观察到本次可用。
- 未来若账号要求重新登录，那将是**另一次实测事件**，本文件不预支任何结论。
- 无自动任务、无 goal、无发布动作；本次仅文档收口。

## 关联
- 前序技术结论：[mimo-target-activation-check-20261109.md](../.diagnostics/mimo-target-activation-check-20261109.md)、
  本轮安装与范围：[SHORT.md](../.diagnostics/mimo-sso-header-profile-20261109/SHORT.md)。