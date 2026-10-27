---
name: zcode-sub
description: 用 zcode-sub 命令把任务派给 ZCode 桌面版当子代理跑：派发任务、收实时消息、取最终回复、续聊、停止。当用户要把工作交给 ZCode、在 ZCode 里/桌面上跑任务、提到 zcode-sub、或要在 ZCode GUI 里可见地执行任务时使用。不用于 ZCode 仓库本身的开发，也不用于跨座位子代理（那是 dwc-sub）。
---

# zcode-sub：把 ZCode 桌面版当子代理用

前提：`zcode-sub` 命令可用（PATH 里或绝对路径）。不可用时先按仓库 README 安装并跑一次 `zcode-sub setup`；setup 输出会给出 ZCode GUI 侧的一次性配置步骤——照转给用户，配置完才可派发。

最小用法（各一行，详细语义跑 `zcode-sub --help`）：

- 派发：`zcode-sub run "<任务全文>" --cwd <工作区绝对路径> [--name <名>]` —— stdout 一行 JSON（name/status/mailbox）。任务全文一次写清（含工作目录、要做什么、完成后输出最终总结）。
- 等消息：`zcode-sub wait <name> [--timeout 秒]` —— 阻塞到有新消息就打印并退出（建议后台运行：退出即唤醒本轮）；超时输出 TIMEOUT（退出码 2），再等一次即可。
- 取结果：`zcode-sub result <name>` —— 最终回复全文 + 状态；还在跑会明确说。
- 补充消息：`zcode-sub send <name> "<消息>"` —— 任务结束后等价续聊。
- 续聊：`zcode-sub resume <name> "<继续文本>"` —— 在原 ZCode 会话续聊（仅当该任务仍是当前任务）。
- 停止：`zcode-sub stop <name>`；列表：`zcode-sub list [--json]`。

机制与边界（使用前必须知道）：

- **同一时刻只能跑一个任务**：单 bot 单会话。`run` 遇「任务运行中」会拒绝（退出码 3）——先 `wait`/`result` 收上一个，或 `stop` 后再派。派新任务后旧任务不能再 `resume`。
- **运行中发消息会被 ZCode 拒收**（私聊无补充输入通道）：`send` 退出码 4 并转达 ZCode 原话。要么等终态再发，要么 `stop`。
- **终态判定**：`result` 会向 ZCode 查询状态确认终态后才给全文；`wait` 只到新消息，长任务静默期 wait 超时 ≠ 任务结束。
- 退出码：2 连不上 ZCode；3 占线；4 消息被拒；5 secret 不符；6 未绑定；7 任务名非法。名字只允许字母数字 `.` `_` `-`。
- 子代理在 ZCode 里可用 MCP 工具 `reply_to_parent(task, message)` 主动汇报——消息同样由 `wait` 收到。
- 任务跑在 ZCode GUI 里实时可见；用户可能直接在 GUI 里看或干预。
