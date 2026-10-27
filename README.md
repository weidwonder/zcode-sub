# zcode-sub

把 ZCode 桌面版（Webhook Bot 通道）当作 Claude Code 的子代理使用：任务派发、实时补充消息、接收子代理主动回复、取最终回复、接续任务。任务实际跑在 ZCode GUI 里，全程可见。

```
Claude Code ──run/send/resume/stop──▶ ZCode 入站端点(127.0.0.1) ──▶ ZCode GUI 会话
Claude Code ◀──wait/result────────── 桥接 daemon ◀──出站回调─────── ZCode webhook bot
```

- 运行环境：Node ≥ 22，零运行时依赖，ESM。
- 上游依赖：ZCode 桌面版装了「本机 Webhook Bot 入站端点」补丁（契约 v1），且 Bots 设置里允许新建 Webhook 类型 bot。上游事实卡：`engineering-context/dependencies/ZCode/bots-webhook.md`。

## 安装

```bash
git clone <本仓库> && cd zcode-sub
npm link            # 或把 bin/zcode-sub.js 加入 PATH；本仓库不发布 npm
```

验证：`zcode-sub --help`。

## 一次性配置

1. 启动 ZCode 桌面版（已装补丁）。若开关文件不存在，`zcode-sub setup` 会打印需要创建的文件与内容（`~/.zcode/v2/bot-webhook-ingress.json`，`{"enabled": true, "port": 47821}`），创建后重启 ZCode；本机可执行 `dwc grant` 授权时也可加 `--write-switch` 自动写。
2. 运行 `zcode-sub setup`：它检查入站端点健康、起桥接 daemon、打印 GUI 步骤。
3. 按 setup 输出在 ZCode GUI 建 Webhook bot（webhookUrl 填 daemon 地址，secret 用 setup 打印的），把 bot id 填回 `zcode-sub setup --bot-id <id>`。
4. 在 GUI 该 bot 页点「生成绑定码」，30 秒内执行 `zcode-sub setup --bind-code <CODE>`。
5. （可选，启用子代理主动汇报）把 setup 打印的 `mcp.servers` JSON 片段合入 ZCode 的 MCP 配置（需 `features.mcp`）。

状态目录默认 `~/.zcode-sub`（真实用户家目录，`os.userInfo().homedir`），用环境变量 `ZCODE_SUB_HOME` 覆盖；若该目录不可写，setup 会提示执行 `dwc grant ~/.zcode-sub`。桥接 daemon 只监听 `127.0.0.1`，出站与内部接口都校验 `x-zcode-bot-secret`。

## 命令

| 命令 | 作用 |
|---|---|
| `zcode-sub setup [--bot-id …] [--bind-code …] [--ingress-port …] [--daemon-port …] [--secret …] [--write-switch]` | 检查/配置并打印 GUI 步骤 |
| `zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>]` | 派发任务；stdout 一行 JSON |
| `zcode-sub wait <name> [--timeout 秒]` | 阻塞等新消息（超时输出 TIMEOUT，退出码 2） |
| `zcode-sub result <name>` | 最终回复全文 + 状态；还在跑会明确说 |
| `zcode-sub send <name> "<消息>"` | 补充消息；任务已结束则等价续聊 |
| `zcode-sub resume <name> "<继续文本>"` | 原会话续聊 |
| `zcode-sub stop <name>` | 取消任务（ZCode `/stop`） |
| `zcode-sub list [--json]` | 任务列表 |
| `zcode-sub mcp` | stdio MCP server（`reply_to_parent` 工具），一般由 ZCode 拉起 |
| `zcode-sub daemon` | 出站接收常驻进程，其它命令需要时自动拉起 |

退出码：`2` 连不上 ZCode 入站端点；`3` 会话被运行中任务占用；`4` 消息被 ZCode 拒收（任务运行中）；`5` secret 不符；`6` 未绑定/绑定码问题；`7` 任务名非法（仅 `[A-Za-z0-9._-]+`）。

## 重要边界与风险

- **单 bot 单会话**：上游一个 webhook bot 同时只绑一个身份、只有一个会话（ZCode `botsService` 以 bot 为会话键）。同一时刻只能跑一个任务；`run` 派新任务后旧任务不能再 `resume`。需要并行任务时在 GUI 建多个 bot（当前版本未做多 bot 池，见 spec 决策 D-01）。
- **运行中发消息会被拒收**：ZCode 私聊通道没有运行中补充输入（steer/queue 是群聊机制）。`send` 会原样转达拒收文案，不排队。
- **终态判定**：ZCode 出站消息没有机器可读的任务结束信号；`result` 通过 `/status` 的「状态: 」行复核终态。上游文案变化会导致解析为 unknown（报原文，不猜）。「最终回复」按最近一次派发点之后的出站正文拼接——终态后上游补发的提醒类消息可能混入，最终结果以 ZCode GUI 为准。
- **messageId 幂等**：入站每条消息用新的唯一 messageId；网络重试复用同一 id（上游 2 分钟幂等窗口内安全）。
- 本工具不写 ZCode 的任何数据文件（配置只读；开关文件只在显式 `--write-switch` 且可写时创建）。

## 开发

```bash
npm test          # node:test，含假 ZCode 全链路
scripts/smoke-real-zcode.sh   # 真机冒烟（需 ZCode 已装补丁并完成配置）
```

文档：spec `docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`、coding plan `docs/plan/2026-10-27-zcode-sub-bridge-coding-plan.md`。
