# 依赖声明：ZCode

- 上游与当前版本：ZCode 桌面版（main 工作树，本机路径 `/Users/weidwonder/projects/ZCode`；「本机 Webhook Bot 入站端点」为并行开发的补丁，契约 v1）
- 确认时间：2026-10-27

## 用到的部分

| 接口名 | 调用点（文件:行） | 注意事项 |
|---|---|---|
| `GET /health` | src/cli.js:276 | 契约 v1 端点；不带鉴权 |
| `POST /api/bots/webhook/:botId` | src/ingress.js:19 | 头 `x-zcode-bot-secret`；body `{botId,userId,text,messageId}`；正文受理时同步 replies 为空数组（后台执行），replies 非空多为命令回执或拒绝文案 |
| `/bind <code>` 命令 | src/cli.js:178 | code 30 秒时效；绑定覆盖 bot.providerUserId（一 bot 一绑定） |
| `/new` 命令 | src/cli.js:293 | 进 draft；终态/草稿下幂等安全 |
| `/status` 命令 | src/ingress.js:86 | 状态行文案 zh/en 双解析；解析不出按 unknown 降级不猜 |
| `/stop` 命令 | src/cli.js:453 | 私聊回完整 /status 文本 |
| 出站 `zcode.bot.message` / `zcode.bot.elicitation_request`（webhookUrl 回调） | src/daemon.js:120 | 只认配置内 botId/userId；无机器可读终态信号 |
| `mcp.servers` stdio 配置（command/args/env） | src/cli.js:202 | 需 `features.mcp` 开启 |

## 业务域地图

| 业务域 | 一句话 | 事实卡 |
|---|---|---|
| bots-webhook | ZCode 第三方 Bot 的 webhook 通道：入站消息→会话/任务，任务流→出站回调 | `dependencies/ZCode/bots-webhook.md` |
