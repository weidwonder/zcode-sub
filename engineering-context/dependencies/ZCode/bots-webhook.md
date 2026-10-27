# 业务域卡 — ZCode › bots-webhook

> 落在 `dependencies/ZCode/bots-webhook.md`：ZCode 桌面版 Bots 子系统的 webhook 通道（本机入站端点 + 出站回调 + 会话语义）。
> 源码不在本项目里，`ctx lint-cards` 整卡跳过 cite 校验——每条 cite 已对照 ZCode 主工作树（main）逐条核过；路径相对 ZCode 仓库根。

## 职责
ZCode 桌面版的第三方 Bot 通道之一：外部程序按 webhook 契约把消息投进 ZCode（创建/续聊任务），ZCode 把任务过程与结果以出站回调推回 webhookUrl；会话状态按 bot 单会话维护。

## 权威实现与对外接口

| 能力 / 入口 | 权威实现（cite） | 类型 | 版本 / 状态 | 调用方 / 触发源 | 约束 |
|---|---|---|---|---|---|
| 入站 HTTP 回调（server 包） | `packages/server/src/http.ts#handleBotCallback`（447-448 行注册 `/api/bots/:provider` 与 `/api/bots/:provider/:botId`） | HTTP | 现行 | 桌面版本机入站端点透传（契约 v1 第 4 条） | provider 仅 webhook；secret 走 `x-zcode-bot-secret` 头；响应 `responseBody ?? {ok, replies}`，状态 200/400/401/503 透传 |
| 入站 payload 解析 | `packages/services/src/bots/providers/webhookProvider.ts#parseCallback`（248-288） | 内部 | 现行 | handleProviderCallbackResponse | botId/userId/text 必填（text 可空仅当有附件或 elicitation 响应）；messageId（fallback id）作 providerMessageId 进幂等层 |
| 业务处理 | `packages/services/src/bots/botsService.ts#processProviderCallback`（3696 起）→ `#handleInboundMessage` | 内部 | 现行 | 上行 | 每条入站先按 `buildInboundDeliveryKey`（botId::provider::chatId或userId::messageId）内存去重，TTL 2 分钟（`BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS` 738 行）；重复静默跳过 |
| 命令解析 | `packages/services/src/bots/commandParser.ts#parseBotCommand` | 内部 | 现行 | 上行 | `/new` `/clear` `/新建`→new；`/cancel`/文本`0`→selection.cancel；`/stop` `/停止`→stop；`/status` `/状态`→status；`/workspace`→workspace.list、带参→workspace.set；`/bind <code>`→bind；非 `/` 开头→message |
| 私聊授权链 | `packages/services/src/bots/botConfigHelpers.ts#findAuthorizedBot`（39-62）与 `#findBoundUser`（64-66） | 内部 | 现行 | 每条消息 | webhook bot 要求 `bot.enabled && bot.providerUserId === actor.providerUserId`；未绑定回「当前 bot 未绑定」文案 |
| 绑定 | `packages/services/src/bots/botsService.ts#handleBind`（6456-6495）；bind code 由 GUI `createBindCode` 生成（`packages/ui/src/BotsDialog.tsx` 319-334） | 内部+GUI | 现行 | GUI 生成 code → `/bind <code>` | code TTL 30 秒（`packages/shared/src/bots.ts#BOT_BIND_CODE_TTL_MS`）；绑定即覆盖 bot.providerUserId——**一个 bot 同一时间只有一个沟通对象**；allowedWorkspaces 随 code 记录写入 |
| 新任务 | `botsService.ts` case "new"（8819-8840）；draft→task 在 `#handleMessage`（7708-7841） | 内部 | 现行 | `/new` 后发首条正文 | `/new` 进 draft；正文在 draft 态创建任务并后台执行（`sendPromptInBackground`），**同步响应 replies 为空数组** |
| 原会话续聊 | `botsService.ts#handleMessage`（7853-7897） | 内部 | 现行 | 任务终态后发正文 | resumeTask 后 sendPromptInBackground；任务运行中发正文被拒（见陷阱项） |
| 停止任务 | `botsService.ts` case "stop"（9552-9585） | 内部 | 现行 | `/stop` | 私聊返回完整 /status 文本 |
| 状态查询 | `botsService.ts#handleStatus`→`#buildStatusText`（6497-6658） | 内部 | 现行 | `/status` | 文本含「状态: 」行：`⏳ 运行中`/`✅ 已完成`/`失败`/`已取消`/`已停止`/`草稿`（文案在 `packages/services/src/bots/messages.ts` 94-106） |
| 出站回调 | `webhookProvider.ts#send`（211-246） | HTTP | 现行 | 任务流事件 | POST `{type:"zcode.bot.message", botId, provider:"webhook", userId, text, selection?, elicitation?, sentAt}`，elicitation 时 type 为 `zcode.bot.elicitation_request`；secret 头名 = bot.webhookAuthHeaderName 或 `x-zcode-bot-secret`；5xx/网络错按 0/500/1500ms 重试，4xx 不重试；`userId` 恒为绑定的 providerUserId |
| 任务终态出站文本 | `botsService.ts` task_complete/task_error 分支（5738-5905）+ `replyFormatter.ts#formatBotAssistantReplyBlocks` | 内部 | 现行 | 任务结束 | webhook 不支持流式卡（`supportsStreamingCardReply` 5141-5149 要求 feishu/lark）；默认 replyMode=`assistant_changes`（`packages/shared/src/bots.ts#DEFAULT_BOT_REPLY_GRANULARITY`）→ 正文按 ≤3500 字拆多条 + 可能跟「变更摘要：…」；空输出兜底「任务已完成。」；错误发「任务失败：{message}」 |
| 应用配置目录 | `packages/services/src/paths.ts#getAppConfigDir`（56-58） | 内部 | 现行 | 桥接读开关文件 | `{getDataBaseDir()}/.zcode/v2`；getDataBaseDir 优先级 setDataBaseDir > env ZCODE_DATA_BASE_DIR > HOME（模块加载时取值） |
| MCP stdio 配置 | `apps/zcode-cli/docs/usage/07-mcp.md`；schema `packages/shared/src/mcp.ts`（31-35） | 配置 | 现行 | `mcp.servers` | stdio 支持 command/args/**env**；需 `features.mcp` 开启 |

## 陷阱项
- 任务运行中发普通正文 — 私聊 webhook **无 steer/queue 语义**（那是群聊话题机制）：`handleMessage` 7668-7675 检测到 activeTask 运行即回「当前任务正在运行」并丢弃该消息，改用 /stop 停止或等终态后重发
- 出站 payload 判终态 — 出站消息**没有机器可读的任务结束信号**（无状态字段、无 end 标记），改用 /status 的「状态: 」行复核；长任务中间静默时不要只凭「一段时间没消息」判完成
- 同步 replies 判任务启动 — 正文投递成功时同步响应是 `{ok:true, replies:[]}`（任务后台执行），replies 有内容通常是命令回执或**拒绝**（如 taskRunning、未绑定、secret 校验失败文案）；secret 不符不改变 HTTP 状态，错误文本混在 replies 里（`processProviderCallback` 3834-3841）
- messageId 复用 — 2 分钟内同 messageId 被静默去重（不回执）；每条入站 MUST 用新的唯一 messageId，重试才可复用同 id
- `/cancel` — 它是**取消选择卡**（selection.cancel），不是取消任务；取消任务用 `/stop`
- 一个 bot 多任务并行 — bot 会话状态按 bot.id 单份（`getContextKey`），且同时只能绑一个 providerUserId；并行任务需要多个 webhook bot，不能靠「每个任务一个 userId」区分（出站 userId 恒等于绑定者）

## 确认
2026-10-27｜来源：ZCode 主工作树（main）逐文件读——botsService.ts（processProviderCallback/handleMessage/watchTaskStream/startTaskStream 终态分支/withAuthorizedContext/handleBind/buildStatusText/stop 分支/admitAutoReplyTurn/markInboundDelivery）、webhookProvider.ts、commandParser.ts、workspaceHelpers.ts、botConfigHelpers.ts、config.ts、bots.ts(shared)、messages.ts、replyFormatter.ts、http.ts、paths.ts、mcp.ts(shared)、BotsDialog.tsx（bind code 与新建入口段）
