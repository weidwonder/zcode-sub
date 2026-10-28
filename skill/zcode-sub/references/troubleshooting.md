# zcode-sub 排障速查

## 退出码（完整闭集）

| 码 | 特征 | 含义与动作 |
|---|---|---|
| 1 | 用法错误 / `zcode_not_configured` / `zcode_task_not_found` / `zcode_create_failed` / EACCES | 用法见 `zcode-sub --help`；未配置先 setup；本地任务名用 list 查 |
| 2 | stdout `TIMEOUT` | wait 本轮无新事件 → 再 wait 一次 |
| 2 | stderr `zcode_api_unreachable` | ZCode 没开或重启中 → 读 setup.md |
| 3 | `zcode_workspace_not_open` | 工作区未在 ZCode 打开（或为远端）→ GUI 打开再试 |
| 4 | `zcode_send_failed` | 投递失败 / 任务已在 GUI 删除 / 运行中 resume 被拒（改用 send） |
| 5 | `zcode_unauthorized` | token/Host 校验失败 → 重跑 setup |
| 7 | `zcode_name_invalid` / `zcode_name_taken` | 名字非法或重名（仅 `[A-Za-z0-9._-]+`）；重名时 ZCode 侧可能已留下孤儿对话，请用户在 GUI 清理 |
| 8 | `zcode_too_many_running` | 未结束任务达上限（默认 4）→ 先 wait/stop 收尾再派 |

## 常见情况

- `warning: "first_prompt_failed"`：任务已建但首条消息未送达 → `send <name> "<原任务全文>"` 补发（退出码 0，不是失败）。
- POST 失败不要盲目重试：run/send/resume 自带幂等键、网络失败同键安全重试一次；其余 POST 不重试——重复投递可能双发。
- 「事件缓冲溢出」提示：上游每任务事件缓冲 500 条，溢出时 wait 会提示改用 result 轮询。
- ZCode 重启后事件序列回退：wait 自动重置游标继续等待，不是错误。
- 输出截断：wait 单条事件正文超 2000 字符截断、单次输出总量上限 20000 字符（略过行会说明总量与获取方式）；全文用 result。
- 共享状态目录：共用同一 `ZCODE_SUB_HOME` 的多个父会话共享任务名字空间与并发额度。
- 并行写风险：多个任务派到同一 `--cwd` 都有完全访问权限、可互改同一工作树——会改代码的任务各配工作区。
- `--model <id>`：模型选择预留、尚未支持（传入会明确报错）；模型查询命令等上游接口交付后启用。
- 版本：`zcode-sub --version`；本 Skill 按 CLI 0.2.x 行为编写。
