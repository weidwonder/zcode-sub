# zcode-sub

把 ZCode 桌面版当作 Claude Code 的子代理使用：任务派发、运行中补充消息（排队/引导）、接收子代理主动回复、取最终回复、接续对话、停止。任务是 ZCode 里的**普通对话**——GUI 实时可见、可并行多开、可在 GUI 里继续操作。

```
Claude Code ──run/send/resume/stop──▶ ZCode 本机任务 API(127.0.0.1, 契约 v2) ──▶ ZCode GUI 普通对话
Claude Code ◀──wait（events 长轮询 + 信箱）───────────────────────────────────┘
ZCode 拉起 zcode-sub mcp ──reply_to_parent──▶ 信箱文件（wait 读取）
```

- 运行环境：Node ≥ 22，零运行时依赖，ESM。
- 上游依赖：ZCode 桌面版装了「本机任务 API」补丁（契约 v2，开关文件 `~/.zcode/v2/local-task-api.json`）。上游事实卡：`engineering-context/dependencies/ZCode/bots-webhook.md`（v1 调查结论与决策记录）。

## 安装

```bash
git clone <本仓库> && cd zcode-sub
npm link            # 或把 bin/zcode-sub.js 加入 PATH；本仓库不发布 npm
```

验证：`zcode-sub --help`。

## 一次性配置

1. 运行 `zcode-sub setup`：
   - ZCode 侧开关文件 `~/.zcode/v2/local-task-api.json` 不存在时，setup 会生成 token 并以 0600 写入（`{"enabled":true,"port":47821,"token":...}`），**写完需重启 ZCode 生效**；已存在则读回 token/端口；
   - 检查本机任务 API 健康；
   - 打印把 `zcode-sub mcp` 配进 ZCode `mcp.servers` 的 JSON 片段（需 `features.mcp`）。
2. （可选）在 ZCode 里打开常驻工作区——`run --cwd` 的工作区必须在 ZCode 中打开，否则报 `zcode_workspace_not_open`（409）。

状态目录默认 `~/.zcode-sub`（真实用户家目录，`os.userInfo().homedir`），环境变量 `ZCODE_SUB_HOME` 覆盖；开关文件定位可用 `ZCODE_DATA_BASE_DIR` 覆盖。目录不可写时 setup 会提示 `dwc grant`。全部通信只走 127.0.0.1，鉴权为开关文件里的 token（Bearer）。

## 命令

| 命令 | 作用 |
|---|---|
| `zcode-sub setup [--api-port …]` | 写/读开关文件、健康检查、打印 MCP 配置 |
| `zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>]` | 在 ZCode 新建对话执行任务；stdout 一行 JSON（name/taskId） |
| `zcode-sub send <name> "<消息>" [--steer\|--queue]` | 补充消息：默认 auto（运行中=GUI 排队/引导语义）；空闲=接续对话 |
| `zcode-sub wait <name> [--timeout 秒]` | 阻塞等新事件/子代理主动消息（超时 TIMEOUT，退出码 2） |
| `zcode-sub result <name>` | 最后回复全文 + 状态；还在跑会明确说 |
| `zcode-sub resume <name> "<继续文本>"` | 空闲任务接续对话（运行中补充用 send） |
| `zcode-sub stop <name>` | 停止生成 |
| `zcode-sub list [--json]` | 本地任务表（name/taskId/状态） |
| `zcode-sub mcp` | stdio MCP server（`reply_to_parent`），由 ZCode 拉起 |

退出码：`2` 连不上本机任务 API 或 wait 超时；`3` 工作区未在 ZCode 打开（含远端工作区，409）；`4` 按 taskId 的请求失败（含任务被删）或运行中 resume 被拒；`5` token/Host 校验失败；`7` 任务名非法或重名；`8` 未结束任务数达上限（默认 4，`ZCODE_SUB_MAX_RUNNING` 调整）。任务名仅 `[A-Za-z0-9._-]+`。完整错误码闭集与事件类型清单以 spec §3 为准（`docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`）。

诊断：`ZCODE_SUB_DEBUG=1` 时 API 请求/响应摘要追加 `~/.zcode-sub/debug.log`（不含 token 与 prompt 正文）。

## 重要边界

- **多任务并行有上限**：每次 `run` 在 ZCode 新建一个对话，name→taskId 映射存本地；同时未结束（运行/等待/派发中）的任务数上限默认 4，`ZCODE_SUB_MAX_RUNNING` 可调，超限报 `zcode_too_many_running`。
- **运行中补充消息**：`send` 默认 `auto`（与 GUI 运行中发送的默认行为一致：排队或引导）；`--steer`/`--queue` 显式指定。返回的 `sent`/`queued`/`steered` 与 commandId 会打印。
- **权限请求不经本工具**：wait 收到 `permission.requested` 会提示去 ZCode GUI 处理（契约 v2 本版不通过 API 批权限）。
- **事件缓冲与重启**：上游每任务事件有界缓冲（500 条），溢出时 wait 收到 `resync` 提示改用 result 轮询；ZCode 重启后事件缓冲清空、序号可能回退，wait 会重置游标继续等待。
- **终态口径**：`result` 以 `GET /api/tasks/:id` 的 status 为准（idle/error 即终态，lastAssistantText 为最后回复；停止后完成事件文本可为空）。
- **副作用安全**：建任务请求带 `clientRequestId` 幂等键（同键返回同一 taskId），网络失败同键安全重试一次；其余写入 POST 失败不自动重试，报错时会提示先用 `list`/GUI 核对。并发上限为尽力检查——多进程同时派发的瞬间可能超出。
- 本工具不写 ZCode 的其他数据文件；开关文件仅 setup 显式写入（已存在时以它为准，`--api-port` 冲突报错不覆盖）。

## 开发

```bash
npm test                        # node:test，假 ZCode（契约 v2）全链路
scripts/smoke-real-zcode.sh    # 真机冒烟（需 ZCode 已装补丁并完成配置）
```

文档：spec `docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`（含 v1→v2 方案变更决策记录）、coding plan `docs/plan/`、覆盖度 `docs/report/测试场景覆盖度.md`。
