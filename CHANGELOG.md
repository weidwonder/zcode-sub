# Changelog

## 未发布

### 不兼容

- 传输层整体切换：`zcode-sub` 从 ZCode Webhook Bot 入站（契约 v1）改为 ZCode 本机任务 API（契约 v2）。旧调用方式：配置 botId/secret、GUI 建 Webhook bot、bind code 绑定、`setup --bot-id/--bind-code/--secret/--daemon-port/--ingress-port`；新调用方式：`zcode-sub setup`（写 `~/.zcode/v2/local-task-api.json`，token 自动生成），`run` 直接建 ZCode 普通对话（多任务并行），`send` 运行中可补充消息（auto/steer/queue）。迁移：删除旧 `~/.zcode-sub` 重跑 setup。原因：用户要求多对话并行与运行中补消息，v1 单 bot 单会话且无 steer（spec §14 决策 D-v2-01）。
- 桥接 daemon（`zcode-sub daemon` 子命令、出站回调接收、`/internal/reply` HTTP 面）删除——v2 为拉模式（events 长轮询），`reply_to_parent` 改为 MCP 进程直写信箱文件。
- 退出码 6（未绑定）删除；退出码表变为 2/3/4/5/7（3 的语义改为 workspace_not_open）。

### 新增

- `zcode-sub` v0.2.0：契约 v2 全套——CLI（setup/run/send/wait/result/resume/stop/list/mcp）、API 客户端（`src/api.js`：createTask/sendMessage/stopTask/getTask/getEvents 长轮询）、多任务 name→taskId 映射、MCP `reply_to_parent` 直写信箱、假 ZCode v2 全链路测试、真机冒烟脚本 v2、Claude Code Skill 与 README。

### 变更

- 并发派发上限：同时非终态任务数默认 4（`ZCODE_SUB_MAX_RUNNING` 调整），超限 `zcode_too_many_running`（退出码 8）。
- 任务登记由单文件 tasks.json 改为每任务分片 `tasks/<name>.json`（`wx` 独占创建防同名竞态；并发丢登记修复）。
- 所有按 taskId 的 API 请求携带 workspacePath（ZCode 重启丢归属表时据此路由）；wait 处理事件序号回退。
- wait 过程事件正文超 2000 字符截断（reply 行与 result 保持全文）。
- setup `--api-port` 与已存在开关文件冲突时报错（以开关文件为准，不覆盖），退出码 1。
- `zcode-sub mcp` 的 serverInfo.version 与 Skill metadata.version 统一读 package.json。

### 修复

- POST 请求不再自动重试：创建/写入失败即报 `zcode_api_unreachable` 并提示「任务可能已创建，先用 list / GUI 核对」（防双建任务）；GET 保留一次重试。
- `getEvents` 对 HTTP ≥400 统一抛 `zcode_send_failed`（此前 404 以 200 语义 payload 返回）。
- 新增 `ZCODE_SUB_DEBUG=1` 请求/响应摘要日志（debug.log，不含 token 与 prompt 正文）。

### 内部

- engineering-context：ZCode 依赖声明更新为 v2 接口清单；bots-webhook 事实卡保留 v1 会话语义结论（决策记录考古用）。
