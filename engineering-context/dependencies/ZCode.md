# 依赖声明：ZCode

- 上游与当前版本：ZCode 桌面版（main 工作树，本机路径 `/Users/weidwonder/projects/ZCode`；依赖其「本机任务 API」补丁，契约 v2，由并行子任务 A 实现）
- 确认时间：2026-10-28（A 侧 steer 真打断交付 d4c518ba 后复核）

## 用到的部分

| 接口名 | 调用点（文件:行） | 注意事项 |
|---|---|---|
| `GET /health` | src/api.js:106 | 校验 `api=="zcode-local-task-api"` 且 `version==2`，否则视为不是本 API |
| `POST /api/tasks` | src/api.js:123（cmdRun src/cli.js:342；mode 默认 yolo，D-v2-17） | body `{workspacePath, prompt, title, clientRequestId, mode}`（mode 默认 yolo；clientRequestId 幂等键，同键去重返回同一 taskId；网络失败同键重试一次）；title 传本地任务名；409 `{error:"workspace_not_open"}` → exit 3 |
| `POST /api/tasks/:id/messages` | src/api.js:160（cmdSend src/cli.js:445、cmdResume src/cli.js:463） | delivery auto/queue/steer；auto 不带 requestedDelivery——运行中去向由会话 follow-up mode 裁决（GUI 默认 queue，followupModeSettings.ts:8）、queue→`"queue"`、steer→`"guide"`（与 GUI 同一条 v4 sendText 链路：command.ts:101、zcodeTaskServiceAdapter.ts:457-477）；应答 `steered` 仅为**受理**，注入结果以事件流为准（见 events 行） |
| `POST /api/tasks/:id/stop` | src/api.js:176（cmdStop src/cli.js:489） | 202 即受理 |
| `GET /api/tasks/:id` | src/api.js:192（cmdResult src/cli.js:502、cmdResume 前置检查、cmdRun 并发计数刷新） | status 五值；lastAssistantText 为最后完整助手回复 |
| `GET /api/tasks/:id/events?after=&waitMs=` | src/api.js:205（cmdWait src/cli.js:533） | 长轮询 ≤30s；`{resync:true}` 溢出改查 GET；事件字段终值 `text`/`error`/`summary`/`turnId`/`commandId`（枚举清单在 spec §3）；steer 注入结果三事件为 CLI 投影——`input.steered{commandId}`←`turn_steer_queued`（zcode-task-types-core.ts:466-479）、`steer.injected`/`steer.fellBack{error}`←`turn_steer_status` drained/discarded/rejected（:480-490）；ZCode 重启后 seq 可能回退，客户端重置游标 |
| `local-task-api.json` 开关文件 | cmdSetup src/cli.js:146（读/写 `{enabled,port,token}`，0600） | ZCode 只读该文件；桥接 setup 是写入方之一（契约第 1 条） |
| `mcp.servers` stdio 配置（command/args/env） | mcpConfigSnippet src/cli.js:240（stableNodePath Cellar→opt） | 需 `features.mcp` 开启；env 只传 `ZCODE_SUB_HOME` |
| MCP `reply_to_parent(task, message)`（本仓提供，ZCode 拉起） | src/mcp.js（appendReplyLine src/mailbox.js:14、登记校验 getTask src/tasks.js:157） | ZCode 以真实用户身份拉起 stdio server，直写状态目录信箱 |

## 业务域地图

| 业务域 | 一句话 | 事实卡 |
|---|---|---|
| bots-webhook | ZCode 第三方 Bot 的 webhook 通道（v1 调查结论：会话语义、bind、/status 文案、messageId 幂等——现作决策记录考古用，v2 传输层不再使用） | `dependencies/ZCode/bots-webhook.md` |
