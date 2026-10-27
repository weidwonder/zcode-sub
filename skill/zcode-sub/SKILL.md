---
name: zcode-sub
description: 用 zcode-sub 命令把任务派给 ZCode 桌面版当子代理跑：多对话并行派发、运行中补充消息、收实时事件、取最终回复、接续对话。当用户要把工作交给 ZCode、在 ZCode 里/桌面上跑任务、提到 zcode-sub、或要在 ZCode GUI 里可见地并行执行任务时使用。不用于 ZCode 仓库本身的开发，也不用于跨座位子代理（那是 dwc-sub）。
---

# zcode-sub：把 ZCode 桌面版当子代理用

前提：`zcode-sub` 命令可用（PATH 里或绝对路径），且 `zcode-sub setup` 已完成（ZCode 侧开关文件与 token 就绪、ZCode 已重启）。不可用/未配置时按仓库 README 处理；工作区必须已在 ZCode 中打开，否则 run 报 `zcode_workspace_not_open`。

最小用法（各一行，详细语义跑 `zcode-sub --help`）：

- 派发：`zcode-sub run "<任务全文>" --cwd <工作区绝对路径> [--name <名>]` —— stdout 一行 JSON（name/taskId）。任务全文一次写清（含要做什么、完成后输出最终总结）。**可并行派发多个**（每次 run 新建一个 ZCode 对话）。
- 等消息：`zcode-sub wait <name> [--timeout 秒]` —— 阻塞到有新事件（assistant.message/turn.completed/turn.failed/input.queued/input.steered）或子代理主动消息就打印并退出（建议后台运行：退出即唤醒本轮）；超时输出 TIMEOUT（退出码 2），再等一次即可。
- 取结果：`zcode-sub result <name>` —— 最后回复全文 + 状态；还在跑会明确说（waiting_permission/waiting_input 提示去 ZCode GUI 处理——权限不经本工具批）。
- 补充消息：`zcode-sub send <name> "<消息>" [--steer|--queue]` —— 运行中默认 auto（GUI 排队/引导语义）；任务空闲时即接续对话。
- 续聊：`zcode-sub resume <name> "<继续文本>"` —— 空闲任务接续对话；运行中补充用 send。
- 停止：`zcode-sub stop <name>`；列表：`zcode-sub list [--json]`。

机制与边界（使用前必须知道）：

- **多任务并行**：name 是本地任务键（映射 ZCode 对话 taskId）；各任务事件互不干扰。任务在 ZCode GUI 实时可见，用户可能直接在 GUI 看或干预。
- **send 的返回**：打印 sent/queued/steered（queued/steered 带 commandId）——运行中补充默认排队或引导，不是立即生效。
- **wait 的事件粒度**：`[turn.completed] <最终文本>` 出现即该轮完成；`permission.requested` 只提示去 GUI；收到「事件缓冲溢出」说明上游缓冲满了，改看 result/GUI。
- 退出码：2 连不上 ZCode；3 工作区未打开；4 投递失败/任务被删；5 token 不符；7 名字非法或重名。名字只允许字母数字 `.` `_` `-`。
- 子代理在 ZCode 里可用 MCP 工具 `reply_to_parent(task, message)` 主动汇报——消息由 wait 收到（`[reply]` 行）。
