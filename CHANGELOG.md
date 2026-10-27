# Changelog

## 未发布

### 不兼容

- 传输层整体切换：`zcode-sub` 从 ZCode Webhook Bot 入站（契约 v1）改为 ZCode 本机任务 API（契约 v2）。旧调用方式：配置 botId/secret、GUI 建 Webhook bot、bind code 绑定、`setup --bot-id/--bind-code/--secret/--daemon-port/--ingress-port`；新调用方式：`zcode-sub setup`（写 `~/.zcode/v2/local-task-api.json`，token 自动生成），`run` 直接建 ZCode 普通对话（多任务并行），`send` 运行中可补充消息（auto/steer/queue）。迁移：删除旧 `~/.zcode-sub` 重跑 setup。原因：用户要求多对话并行与运行中补消息，v1 单 bot 单会话且无 steer（spec §14 决策 D-v2-01）。
- 桥接 daemon（`zcode-sub daemon` 子命令、出站回调接收、`/internal/reply` HTTP 面）删除——v2 为拉模式（events 长轮询），`reply_to_parent` 改为 MCP 进程直写信箱文件。
- 退出码 6（未绑定）删除；退出码表变为 2/3/4/5/7（3 的语义改为 workspace_not_open）。

### 新增

- `zcode-sub` v0.2.0：契约 v2 全套——CLI（setup/run/send/wait/result/resume/stop/list/mcp）、API 客户端（`src/api.js`：createTask/sendMessage/stopTask/getTask/getEvents 长轮询）、多任务 name→taskId 映射、MCP `reply_to_parent` 直写信箱、假 ZCode v2 全链路测试、真机冒烟脚本 v2、Claude Code Skill 与 README。

### 变更

（无）

### 修复

（无）

### 内部

- engineering-context：ZCode 依赖声明更新为 v2 接口清单；bots-webhook 事实卡保留 v1 会话语义结论（决策记录考古用）。
