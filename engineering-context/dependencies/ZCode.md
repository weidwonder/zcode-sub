# 依赖声明：ZCode

> 每个被本项目调用的上游（SDK / 服务 / 共享库）一份，落 `engineering-context/dependencies/<上游名>.md`。
> 它写"本项目用了上游什么"，是卡片的反向。升级上游时与上游仓库根 `CHANGELOG.md` 的 `不兼容` 条目按**接口名**取交集即得影响面。判据与升级处置顺序见 dw-code-facts 的 `代码事实纪律.md` §10.2。

- 上游与当前版本：github.com/zai-org/ZCode @ 3.16.2（本地克隆 `/Users/weidwonder/projects/ZCode`，origin/main 3c5b2276）；桥接 CLI 依赖其「本机任务 API」补丁（契约 v2，权威文档为补丁里的 `docs/local-task-api.md`）
- 确认时间：2026-10-28（桥接侧按补丁最终形状 d444427e 对齐复核：workspace_open_blocked、invalid_model_selection、defaultThoughtLevel 已交付）

**上游快照状态（本仓各文档里具体 SHA / 版本号 / 服务端状态以本行为准）**：origin/main = 3c5b2276（3.16.2，2026-10-20 sync）；装机现状（2026-10-28 真机安装后）：/Applications 为补丁版 ZCode Preview 3.16.2（dev.zcode.app.preview），官方 3.16.3（dev.zcode.app，官方签名）已由用户移到 zcode-backups/apps/ZCode-3.16.3-official.app 保存；生产 `/api/v1/client/configs` 于 2026-10-27 实测未下发 `forceUpdate` 门槛（服务端随时可变）；补丁开发分支 `feat/local-bot-webhook`（含 v1 webhook ingress 引入 + revert 对冲对与 local-dw 过程文档提交）；从上游 main 整理出的三个干净净提交在 `feat/local-task-api` 分支（同为上游 PR 内容），已固化进 `patch/series`。

## 用到的部分

| 接口名 | 调用点（文件:行） | 注意事项 |
|---|---|---|
| `GET /health` | src/api.js:141 | 校验 `api=="zcode-local-task-api"` 且 `version==2`，否则视为不是本 API |
| `POST /api/tasks` | src/api.js:158（cmdRun src/cli.js:522；mode 默认 yolo，D-v2-17） | body `{workspacePath, prompt, title, clientRequestId, mode, modelSelection?}`（mode 默认 yolo；clientRequestId 幂等键，同键去重返回同一 taskId；网络失败同键重试一次；modelSelection=`{providerId, modelId, options?{reasoningLevel}}` strict——多余键/空串 400，`GET /api/models` 的 `preferred` 可原样回传）；title 传本地任务名；工作区族错误（409 workspace_not_open/workspace_open_timeout/workspace_open_blocked、400 workspace_path_invalid）与 400 invalid_model_selection 由 api.js `workspaceApiError` 统一映射（exit 3 / exit 1 / zcode_model_invalid exit 1）——所有 op 端点一致 |
| `GET /api/models` | src/api.js:205（cmdModels、validateModelSelection——D-v2-21 默认档位补全在此） | `?workspacePath=`（必带，缺参 400 bad_request——cmdModels 因此要求 --cwd，缺失或非绝对路径本地报用法错误 exit 1，不发请求）；返回 `{providers:[{providerId, displayName, models:[{modelId, displayName, thoughtLevels(缺失→[]), isDefault, defaultThoughtLevel?}]}], preferred?}`preferred 形状即 modelSelection；defaultThoughtLevel 已交付（=最高档，无档位模型不给），B 按「max 优先→defaultThoughtLevel→末档」消费并在 models 文本表展示；B 以此做本地预校验（zcode_model_invalid exit 1 列可选值）；409 workspace_open_timeout → exit 3 |
| `POST /api/tasks/:id/model` | src/api.js:224（cmdModel） | body `{modelSelection(必填 strict 400), workspacePath?, clientRequestId?}` → `200 {ok:true}`；运行中允许换模型（GUI 仅 Highspeed 锁、Host 不可见——agent 拒绝时 503）；clientRequestId 幂等独立 model 命名空间（与 send/create 隔离） |
| `POST /api/tasks/:id/messages` | src/api.js:257（cmdSend src/cli.js:633 含 --interrupt、cmdResume src/cli.js:721） | delivery auto/queue/steer + 可选 `clientRequestId`（1..200、每任务命名空间 10 分钟去重、命中回首次应答含 commandId 原值、空串 400）；auto 不带 requestedDelivery——运行中去向由会话 follow-up mode 裁决（GUI 默认 queue，followupModeSettings.ts:8）、queue→`"queue"`、steer→`"guide"`（与 GUI 同一条 v4 sendText 链路：command.ts:101、zcodeTaskServiceAdapter.ts:457-477）；**空闲任务收到 steer 按实际去向应答 sent、无 steer 事件**；应答 `steered` 仅为**受理**，注入结果以事件流为准（见 events 行）；B 的 `--interrupt` 是本地组合原语（stop→轮询 GET 回 idle→新一轮发送），不经本端点特殊参数 |
| `POST /api/tasks/:id/stop` | src/api.js:281（cmdStop src/cli.js:732；cmdSend --interrupt 第一步 :647） | 202 即受理 |
| `GET /api/tasks/:id` | src/api.js:299（cmdResult src/cli.js:801、cmdResume 前置检查、cmdRun 并发计数刷新、cmdSend --interrupt 轮询 idle） | status 五值；lastAssistantText 为最后完整助手回复 |
| `GET /api/tasks/:id/events?after=&waitMs=` | src/api.js:314（cmdWait src/cli.js:832，事件批与信箱 reply 按时间先后合并输出） | 长轮询 ≤30s；`{resync:true}` 溢出改查 GET；事件字段终值 `text`/`error`/`summary`/`turnId`/`commandId`（枚举清单在 spec §3）；steer 注入结果三事件为 CLI 投影——`input.steered{commandId}`←`turn_steer_queued`（zcode-task-types-core.ts:466-479，commandId=202 应答 commandId=事件 inputId，对账键，也可能来自 GUI 侧引导；**旧版 ZCode（3.16.2）丢该事件，A 904f6866 已修 schema；B 不依赖它判成功**）、`steer.injected`/`steer.fellBack{error}`←`turn_steer_status` drained/discarded/rejected（:480-490）；ZCode 重启后 seq 可能回退，客户端重置游标 |
| `local-task-api.json` 开关文件 | cmdSetup src/cli.js:222（读/写 `{enabled,port,token}`，0600） | ZCode 只读该文件；桥接 setup 是写入方之一（契约第 1 条） |
| `mcp.servers` stdio 配置（command/args/env） | mcpConfigSnippet src/cli.js:323（stableNodePath Cellar→opt） | 需 `features.mcp` 开启；env 只传 `ZCODE_SUB_HOME` |
| MCP `reply_to_parent(task, message)`（本仓提供，ZCode 拉起） | src/mcp.js（appendReplyLine src/mailbox.js:14、登记校验 getTask src/tasks.js:184） | ZCode 以真实用户身份拉起 stdio server，直写状态目录信箱 |
| `pnpm bundle:desktop`（上游根 package.json script） | patch/build-desktop.sh:178 | 内部串行 prepare→build→electron-builder→产物机械校验，勿拆步调用 |
| `ZCODE_ENV` / `ZCODE_PREVIEW_IDENTITY` / `ZCODE_AUTO_UPDATE`（上游构建期环境变量协议） | patch/build-desktop.sh#BUILD_ENV（构建环境组装段）| `ZCODE_ENV` 缺省按 test 后端处理，连生产必须显式 `=production`；`ZCODE_AUTO_UPDATE=0` 只关自动更新、关不掉强更门 |
| 迁移账本表 `schema_migration`（会话库）/ `tasks_schema_migration` 与项目存储 `schema_migration`（tasks-index 库） | patch/verify-migration-checksums.mjs#readLedger（三处调用：会话库 / 任务索引 / 项目存储账本） | 只读查询；checksum 规则三组不同（sha256(sql.trim()) 与 sha256(JSON.stringify(checksumInput))），门检脚本已内置 |
| 数据布局 `getAppConfigDir()`（`~/.zcode/v2`）与 `cli/db/db.sqlite` | patch/backup-zcode-data.sh:55-63 | 凭据/设置/bot 配置在 `v2/`、会话库在 `cli/db/`；与 flavor 无关（Preview 与 production 共享） |
| `credentials.json`（凭据文件，AES-256-GCM、密钥本机派生） | patch/backup-zcode-data.sh:59（备份范围含 v2/*.json） | 备份只读复制+哈希，MUST NOT 在日志打印内容；解密与签名无关 |
| `feat/local-bot-webhook`（上游补丁开发分支） | patch/sync-upstream.sh:12,64（series 读取）；patch/series（净提交清单） | 分支含 v1 引入+revert 对冲对，MUST NOT 自动取全部非 chore 提交；净提交已固化进 series（来自 `feat/local-task-api`） |
| `local/patched-<上游短SHA>` 分支命名（本仓约定，作用于上游仓） | patch/sync-upstream.sh:15 | 已存在即中止，不自动删 |

## 业务域地图

| 业务域 | 一句话 | 事实卡 |
|---|---|---|
| bots-webhook | ZCode 第三方 Bot 的 webhook 通道（v1 调查结论：会话语义、bind、/status 文案、messageId 幂等——现作决策记录考古用，v2 传输层不再使用） | `dependencies/ZCode/bots-webhook.md` |
| 构建身份与打包 | 安装包身份（ZCode / ZCode Preview）、后端环境与 mac 构建链 | `dependencies/ZCode/构建身份与打包.md` |
| 更新与强制升级 | 自动更新与启动期强更门，决定旧客户端能否连生产后端 | `dependencies/ZCode/更新与强制升级.md` |
| 数据目录与迁移 | `~/.zcode` 布局、三组 SQLite 迁移账本与跨版本打开行为 | `dependencies/ZCode/数据目录与迁移.md` |
| 凭据与登录态 | 登录凭据存储与加密，替换/并存 app 的登录保留 | `dependencies/ZCode/凭据与登录态.md` |
