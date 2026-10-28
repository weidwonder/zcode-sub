# zcode-sub 排障速查

## 退出码（完整闭集）

| 码 | 特征 | 含义与动作 |
|---|---|---|
| 1 | 用法/配置类：用法错误 / `zcode_not_configured` / `zcode_task_not_found` / `zcode_create_failed` / EACCES | 用法见 `zcode-sub --help`；未配置先 setup；本地任务名用 list 查 |
| 1 | 模型/工作区类：`zcode_model_invalid` / `zcode_workspace_path_invalid` | `zcode_model_invalid` 本地报错已列出可选模型/档位，按它改 --model/--thought；上游拒绝时 message 为 provider-not-found / model-not-found / reasoning-level-not-supported → 用 `zcode-sub models --cwd <该任务的工作区，即 run 时的 --cwd>` 查可选值；message 为 account-connection-unavailable = 该模型账号未在 ZCode 连接——告知用户去连接或换模型，账号恢复后可原样重试，不要在未恢复时空转重试；`zcode_workspace_path_invalid` = 检查 `--cwd` 是本机存在的目录绝对路径（不带 `~`、不用相对路径），改正后重跑 |
| 2 | stdout `TIMEOUT` | wait 本轮无新事件 → 再 wait 一次 |
| 2 | stderr `zcode_api_unreachable` | ZCode 没开或重启中 → 读 setup.md |
| 3 | `zcode_workspace_not_open` | 工作区未打开/为远端→请用户在 GUI 打开；「打开该工作区超时」→ 可直接重试（打开请求可能仍在进行），反复超时再请用户手动打开；「禁止打开工作区」→ ZCode 在强制升级等状态，请用户先处理 ZCode 窗口 |
| 4 | `zcode_send_failed` / `zcode_task_busy_for_resume` | 投递失败 / 任务已在 GUI 删除 / 运行中 resume 被拒（改用 send）；`--interrupt` 报「未回到空闲…消息未发送」→ 停止请求已发出、消息未发，result 看状态后重发（idle 时直接 send）；「模型列表查询失败」且 status=404 = ZCode 补丁版本不含模型接口，不能用 --model/--thought |
| 5 | `zcode_unauthorized` | token/Host 校验失败 → 重跑 setup |
| 7 | `zcode_name_invalid` / `zcode_name_taken` | 名字非法或重名（仅 `[A-Za-z0-9._-]+`）→ 换名重跑即可；仅当 stderr 带「⚠ 任务已在 ZCode 创建（taskId=…）」时 ZCode 侧才有孤儿对话，请用户在 GUI 清理 |
| 8 | `zcode_too_many_running` | 未结束任务达上限（默认 4）→ 先 wait/stop 收尾再派 |

## 常见情况

- `warning: "first_prompt_failed"`：任务已建但首条消息未送达 → `send <name> "<原任务全文>"` 补发（退出码 0，不是失败）。
- POST 失败不要盲目重试：run/send/resume/model 自带幂等键、网络失败同键安全重试一次；其余 POST 不重试——重复投递可能双发。
- 事件序列已重置（缓冲释放、溢出 500 条缓冲或 ZCode 重启后 seq 回退）：wait 自动把游标归 0 继续跟随，不是错误；历史用 result 查看。
- 输出截断：wait 单条事件正文超 2000 字符截断、单次输出总量上限 20000 字符；事件全文用 result；[reply] 全文见 wait 提示的信箱文件路径。
- 共享状态目录：共用同一 `ZCODE_SUB_HOME` 的多个父会话共享任务名字空间与并发额度。
- 并行写风险：多个任务派到同一 `--cwd` 都有完全访问权限、可互改同一工作树——会改代码的任务各配工作区。
- config defaultModel：`$ZCODE_SUB_HOME/config.json` 可设默认模型（形状同 {providerId, modelId, options?{reasoningLevel}}）——没传 --model 时生效；改它属于改用户配置，先征得用户同意。
- `zcode_model_invalid` 报「无思考档位 / 思考档位非法」且没传 --thought：是 config defaultModel 的档位在起作用（换模型不会继承它）——显式传 --thought 覆盖，或征得同意后改配置；报「上游拒绝了模型选择（…）」见码表 1 行。
- 版本：`zcode-sub --version`；CLI 主次版本应与本 Skill 的 metadata.version 一致——不一致时告知用户同步两者，先按 CLI 的 `--help` 为准使用。
