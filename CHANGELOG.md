# Changelog

## 未发布

### 不兼容

（无）

### 新增

- `zcode-sub` v0.1.0：CLI（setup/run/send/wait/result/resume/stop/list/mcp/daemon）+ 出站接收 daemon + stdio MCP server（`reply_to_parent`）+ Claude Code Skill（`skill/zcode-sub/SKILL.md`）+ 真机冒烟脚本（`scripts/smoke-real-zcode.sh`）。把 ZCode 桌面版 Webhook Bot 当作 Claude Code 子代理：任务派发、补充消息、接收子代理主动回复、终态取最终回复、原会话续聊、取消。

### 变更

（无）

### 修复

（无）

### 内部

- engineering-context：ZCode bots-webhook 依赖仓事实卡与 capability-registry 登记。
