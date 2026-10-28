# Changelog

## 未发布

### 不兼容

- 传输层整体切换：`zcode-sub` 从 ZCode Webhook Bot 入站（契约 v1）改为 ZCode 本机任务 API（契约 v2）。旧调用方式：配置 botId/secret、GUI 建 Webhook bot、bind code 绑定、`setup --bot-id/--bind-code/--secret/--daemon-port/--ingress-port`；新调用方式：`zcode-sub setup`（写 `~/.zcode/v2/local-task-api.json`，token 自动生成），`run` 直接建 ZCode 普通对话（多任务并行），`send` 运行中可补充消息（auto/steer/queue）。迁移：删除旧 `~/.zcode-sub` 重跑 setup。原因：用户要求多对话并行与运行中补消息，v1 单 bot 单会话且无 steer（spec §14 决策 D-v2-01）。
- 桥接 daemon（`zcode-sub daemon` 子命令、出站回调接收、`/internal/reply` HTTP 面）删除——v2 为拉模式（events 长轮询），`reply_to_parent` 改为 MCP 进程直写信箱文件。
- 退出码 6（未绑定）删除；退出码表变为 2/3/4/5/7/8（3 的语义改为 workspace_not_open，8 为并发上限；完整闭集见 spec §3）。

### 新增

- `zcode-sub` v0.2.0：契约 v2 全套——CLI（setup/run/send/wait/result/resume/stop/list/mcp）、API 客户端（`src/api.js`：createTask/sendMessage/stopTask/getTask/getEvents 长轮询）、多任务 name→taskId 映射、MCP `reply_to_parent` 直写信箱、假 ZCode v2 全链路测试、真机冒烟脚本 v2、Claude Code Skill 与 README。

### 变更

- 并发派发上限：同时非终态任务数默认 4（`ZCODE_SUB_MAX_RUNNING` 调整，尽力检查——多进程同时派发瞬间可能超出），超限 `zcode_too_many_running`（退出码 8）；并发额度刷新遇 404（任务已在 GUI 删除）时本地置 `error` 终态自动释放额度。
- 任务登记由单文件 tasks.json 改为每任务分片 `tasks/<name>.json`（`wx` 独占创建防同名竞态；并发丢登记修复；损坏分片重登记时备份 `.corrupt-<ts>` 后覆盖）。
- 所有按 taskId 的 API 请求携带 workspacePath（ZCode 重启丢归属表时据此路由）；wait 处理事件序号回退。
- wait 输出体量双闸：单条事件正文超 2000 字符截断（评审一轮）、单次输出总量上限 20000 字符——超出后剩余事件/reply 降级为一行「剩余 N 条略过 + 获取方式」，游标照常推进不重放（评审二轮）；单条 reply 超 20000 字符同样降级为前 2000 字符 + 总长 + 信箱文件路径指针（评审三轮）。
- setup `--api-port` 与已存在开关文件冲突时报错（以开关文件为准，不覆盖），退出码 1；状态目录不可写时最先探测并提示 `dwc grant <目录>`（此前会因建目录裸崩）。
- `zcode-sub mcp` 的 serverInfo.version 与 Skill metadata.version 统一读 package.json。
- 对齐上游偏离 #11~#14：create 部分失败（`201 {taskId, warning:"first_prompt_failed"}`）照常登记并以 JSON `warning` 字段 + stderr 补发提示告知（退出码 0，任务已建）；op 异常 `503 {error:"unavailable_host"}` 视为暂态（GET/带幂等键 createTask 重试一次，最终失败报 `zcode_api_unreachable`）；假端点补 mode 11 值枚举（非法 400）与 clientRequestId 1..200/10 分钟窗口口径。
- `POST /api/tasks` 携带 `clientRequestId` 幂等键（run 生成 `zsub-<uuid>` 并记入本地分片与 stdout JSON；上游同键去重返回同一 taskId）：createTask 网络失败改为**同键安全重试一次**，撤回下条「POST 一律不重试」中对建任务的保守禁令；messages/stop 仍不重试。
- （评审三轮）run 本地重名预查（exit 7 不触上游，不再产生 GUI 孤儿对话）；删除 setup 尾部不可达的重复可写性探测。
- （真机反馈轮）run 默认 mode=yolo（GUI『完全访问』，用户拍板——子代理不卡权限确认），`--mode` 与 config `defaultMode` 可覆盖（11 值枚举本地预校验）；list 文本表 taskId 改显示后 8 位（前缀同为 session_ 无区分度）；`--steer` 语义按 A 侧真打断更新（应答 steered/queued 如实显示）；HOME 重定向环境（如 /var/empty）setup 报错直接给 `ZCODE_SUB_HOME`/`ZCODE_DATA_BASE_DIR` 设置示例（README 安装节附 shim 模板）；MCP 配置指明 `~/.zcode/cli/config.json` 共用文件、node 路径自动转 Homebrew 稳定 opt 链接。
- （A 侧 steer 对齐轮）`--steer` 应答 `steered` 仅为受理，注入结果以事件流为准：wait 打印 `input.steered`（已受理引导）/`steer.injected`（打断生效）/`steer.fellBack`（引导被降级/拒绝——原因与「消息将按排队处理或需重发」提示，不影响 lastStatus 推导）；send 默认 auto 运行中的去向由会话 follow-up mode 决定（GUI 默认排队），文档写明要即时打断用 `--steer`；假端点 steer 受理不再自产事件（新增 settleSteer 控制方法模拟 CLI 投影链路）。
- （r6 跟进 + Skill 评审轮）send/resume 消息请求带 `clientRequestId` 幂等键（网络失败同键安全重试一次，与 run 同口径）；空闲任务 `--steer` 按实际去向应答 `sent`；`input.steered` 的 commandId 与 202 应答相等（对账键）——wait 按本地分片 `steerCommandIds` 对账打印「你的引导已受理」/「来自 GUI 侧的引导」（GUI 侧对同一任务的引导会产生同型事件）；CLI 未知参数按命令白名单报用法错误（exit 1）、新增 `--version`、USAGE 扩充（mode 枚举/事件全量/环境变量表）、setup 的 HOME 重定向提示直接给 shim 与两变量含义；SKILL.md 按 skill-principle 评审重写为精简结构（排障路由/标准循环/判读表/安全/案例），细节下沉 references/setup.md 与新建 references/troubleshooting.md。
- （模型选择轮）接入上游模型接口：`run --model <providerId/modelId> [--thought <档位>]` 组装 create 的 `modelSelection`（`config.json` 可选 `defaultModel` 兜底，不传不带用 ZCode 默认）；新增 `zcode-sub models`（GET /api/models 文本表/JSON）与 `zcode-sub model <name> <p/m>`（POST /:id/model，运行中允许、幂等独立 model 命名空间）；非法值本地按 /api/models 预校验报 `zcode_model_invalid`（exit 1）并列可选值；修 bin 错误输出前缀重复。
- （Skill 二轮评审）wait 循环出口（事件缓冲溢出停 wait 改 result 轮询、连续 TIMEOUT 先查状态、result 还在跑回 wait）；GUI 动作统一改「告知用户…由用户操作」并新增禁令「不自行结束或重启 ZCode 进程」；setup 首次运行（写开关文件+需重启）与 MCP 合并均先征得用户同意（宽口径）；setup.md 新增「连不上 API」四步排查与 shim 落点说明；判读表/退出码表若干口径修正（fellBack 先看 input.queued、reply 全文在信箱、busy_for_resume 等）。
- （真机反馈轮 2）`--model` 未指定 `--thought` 时自动补默认档位（用户拍板：max 优先 → 模型 defaultThoughtLevel → 列表末档；stderr 打印实际档位——真机实锤有档位模型不带 reasoningLevel 被上游拒绝建会话）；wait 同轮合并输出信箱 reply 与事件批（按时间先后，真机 reply 早于 assistant.message 到达时会漏到下次 wait）；新增 `send --interrupt`（停止→有界等回空闲→新一轮发送，「未完成内容丢弃」，与 --steer/--queue 互斥，`ZCODE_SUB_INTERRUPT_TIMEOUT_MS` 可调）——`--steer` 保留为原生引导并如实写明「当前步骤结束时注入、长生成可能等较久」；引导结果判据定为 steer.injected/steer.fellBack（上游 3.16.2 丢 turn.steerQueued、input.steered 暂不会到达，不依赖）；预留 A 侧工作区自动打开后的错误映射（409 workspace_open_timeout→exit 3、400 workspace_path_invalid→exit 1）。
- （A 最终形状对齐轮）工作区族错误七端点统一分流（api.js workspaceApiError：create/messages/stop/get/events/models/:id/model 一致映射——新增 409 workspace_open_blocked→exit 3「请先处理 ZCode 窗口」，open_timeout 文案注明可直接重试）；上游 400 invalid_model_selection（provider-not-found 等）→ zcode_model_invalid exit 1 透传原因并提示 models 查可选值；models 文本表加「默认档位」列（defaultThoughtLevel）；input.steered 措辞改「旧版 ZCode 可能不出现」（A 已修 schema、修复版起恢复）；SKILL/README/spec 码表逐条对齐（含 workspace_open_blocked、invalid_model_selection）。
- （六轮评审）wait 的 resync 分支改为游标显式归 0 后继续跟随（A 最终语义：重启/缓冲释放后 after>0 返回 resync、after=0 重新跟随——只提示一次不再每次报溢出；updateTask 加 resetEventsSeq 标志支持显式重置、普通推进仍取 max）；--steer 旧口径清理（USAGE/README 边界节/spec 场景 3 与 D-v2-05 括注统一为「原生引导、步骤结束时注入；立即改向用 --interrupt」，steer.injected 文案去「打断生效」）；--timeout 坏值（0/非数值）报用法错误；禁区补「不对用户正在 GUI 操作的对话 --steer 或 --interrupt」；Skill 前提改工作区自动打开（含标签页副作用说明）、wait 分流改逐行处理（同批 reply+终态不二选一）、码表拆行并补 account-connection-unavailable 可在账号恢复后原样重试；ZCODE_SUB_INTERRUPT_TIMEOUT_MS 进 USAGE 环境变量表与 spec Cheat Sheet；台账补齐。

### 修复

- POST 请求不再自动重试（除上条带幂等键的 createTask）：写入失败即报 `zcode_api_unreachable` 并提示「任务可能已创建，先用 list / GUI 核对」（防双建任务）；GET 保留一次重试。
- `getEvents` 对 HTTP ≥400 统一抛 `zcode_send_failed`（此前 404 以 200 语义 payload 返回）。
- 新增 `ZCODE_SUB_DEBUG=1` 请求/响应摘要日志（debug.log，不含 token 与 prompt 正文）。
- 真机冒烟脚本 run 断言的 JSON 空格修正（紧凑输出下原 grep 恒不匹配）。

### 内部

- engineering-context：ZCode 依赖声明更新为 v2 接口清单；bots-webhook 事实卡保留 v1 会话语义结论（决策记录考古用）。
