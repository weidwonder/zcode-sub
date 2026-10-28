# 依赖声明：ZCode

- 上游与当前版本：ZCode 桌面版（main 工作树，本机路径 `/Users/weidwonder/projects/ZCode`；依赖其「本机任务 API」补丁，契约 v2，由并行子任务 A 实现）
- 确认时间：2026-10-28（A 最终形状 904f6866 对齐后复核：workspace_open_blocked、invalid_model_selection、defaultThoughtLevel 已交付；权威文档 docs/local-task-api.md）

## 用到的部分

| 接口名 | 调用点（文件:行） | 注意事项 |
|---|---|---|
| `GET /health` | src/api.js:141 | 校验 `api=="zcode-local-task-api"` 且 `version==2`，否则视为不是本 API |
| `POST /api/tasks` | src/api.js:158（cmdRun src/cli.js:522；mode 默认 yolo，D-v2-17） | body `{workspacePath, prompt, title, clientRequestId, mode, modelSelection?}`（mode 默认 yolo；clientRequestId 幂等键，同键去重返回同一 taskId；网络失败同键重试一次；modelSelection=`{providerId, modelId, options?{reasoningLevel}}` strict——多余键/空串 400，`GET /api/models` 的 `preferred` 可原样回传）；title 传本地任务名；工作区族错误（409 workspace_not_open/workspace_open_timeout/workspace_open_blocked、400 workspace_path_invalid）与 400 invalid_model_selection 由 api.js `workspaceApiError` 统一映射（exit 3 / exit 1 / zcode_model_invalid exit 1）——所有 op 端点一致 |
| `GET /api/models` | src/api.js:205（cmdModels、validateModelSelection——D-v2-21 默认档位补全在此） | `?workspacePath=`；返回 `{providers:[{providerId, displayName, models:[{modelId, displayName, thoughtLevels(缺失→[]), isDefault, defaultThoughtLevel?}]}], preferred?}`preferred 形状即 modelSelection；defaultThoughtLevel 已交付（=最高档，无档位模型不给），B 按「max 优先→defaultThoughtLevel→末档」消费并在 models 文本表展示；B 以此做本地预校验（zcode_model_invalid exit 1 列可选值）；409 workspace_open_timeout → exit 3 |
| `POST /api/tasks/:id/model` | src/api.js:224（cmdModel） | body `{modelSelection(必填 strict 400), workspacePath?, clientRequestId?}` → `200 {ok:true}`；运行中允许换模型（GUI 仅 Highspeed 锁、Host 不可见——agent 拒绝时 503）；clientRequestId 幂等独立 model 命名空间（与 send/create 隔离） |
| `POST /api/tasks/:id/messages` | src/api.js:257（cmdSend src/cli.js:633 含 --interrupt、cmdResume src/cli.js:687） | delivery auto/queue/steer + 可选 `clientRequestId`（1..200、每任务命名空间 10 分钟去重、命中回首次应答含 commandId 原值、空串 400）；auto 不带 requestedDelivery——运行中去向由会话 follow-up mode 裁决（GUI 默认 queue，followupModeSettings.ts:8）、queue→`"queue"`、steer→`"guide"`（与 GUI 同一条 v4 sendText 链路：command.ts:101、zcodeTaskServiceAdapter.ts:457-477）；**空闲任务收到 steer 按实际去向应答 sent、无 steer 事件**；应答 `steered` 仅为**受理**，注入结果以事件流为准（见 events 行）；B 的 `--interrupt` 是本地组合原语（stop→轮询 GET 回 idle→新一轮发送），不经本端点特殊参数 |
| `POST /api/tasks/:id/stop` | src/api.js:281（cmdStop src/cli.js:715；cmdSend --interrupt 第一步） | 202 即受理 |
| `GET /api/tasks/:id` | src/api.js:299（cmdResult src/cli.js:785、cmdResume 前置检查、cmdRun 并发计数刷新、cmdSend --interrupt 轮询 idle） | status 五值；lastAssistantText 为最后完整助手回复 |
| `GET /api/tasks/:id/events?after=&waitMs=` | src/api.js:314（cmdWait src/cli.js:816，事件批与信箱 reply 按时间先后合并输出） | 长轮询 ≤30s；`{resync:true}` 溢出改查 GET；事件字段终值 `text`/`error`/`summary`/`turnId`/`commandId`（枚举清单在 spec §3）；steer 注入结果三事件为 CLI 投影——`input.steered{commandId}`←`turn_steer_queued`（zcode-task-types-core.ts:466-479，commandId=202 应答 commandId=事件 inputId，对账键，也可能来自 GUI 侧引导；**旧版 ZCode（3.16.2）丢该事件，A 904f6866 已修 schema；B 不依赖它判成功**）、`steer.injected`/`steer.fellBack{error}`←`turn_steer_status` drained/discarded/rejected（:480-490）；ZCode 重启后 seq 可能回退，客户端重置游标 |
| `local-task-api.json` 开关文件 | cmdSetup src/cli.js:222（读/写 `{enabled,port,token}`，0600） | ZCode 只读该文件；桥接 setup 是写入方之一（契约第 1 条） |
| `mcp.servers` stdio 配置（command/args/env） | mcpConfigSnippet src/cli.js:323（stableNodePath Cellar→opt） | 需 `features.mcp` 开启；env 只传 `ZCODE_SUB_HOME` |
| MCP `reply_to_parent(task, message)`（本仓提供，ZCode 拉起） | src/mcp.js（appendReplyLine src/mailbox.js:14、登记校验 getTask src/tasks.js:184） | ZCode 以真实用户身份拉起 stdio server，直写状态目录信箱 |

## 业务域地图

| 业务域 | 一句话 | 事实卡 |
|---|---|---|
| bots-webhook | ZCode 第三方 Bot 的 webhook 通道（v1 调查结论：会话语义、bind、/status 文案、messageId 幂等——现作决策记录考古用，v2 传输层不再使用） | `dependencies/ZCode/bots-webhook.md` |
