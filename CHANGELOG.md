# Changelog

本仓的对外可见变化记录。分类是闭集：`不兼容` / `新增` / `变更` / `修复` / `内部`。

## 未发布

### 新增

- 开源发布文件：Apache-2.0 `LICENSE`（标准全文）；`package.json` 补 `license` 与 `repository` 字段；README 重写为开源版（首屏定位、前置条件与补丁版构建路径、快速上手 setup→run→wait→result、命令/退出码/环境变量配置表、安全边界；保留 `## 需求`、`## 架构与边界` 两个锚点标题）并新增英文版 `README.en.md`，两份互链；新增 `CONTRIBUTING.md`（issue、npm test、提交规范）。

### 修复

- `zcode-sub models` 不带 `--cwd` 时不再发出注定失败的请求：契约要求 `GET /api/models` 必带 workspacePath（真 ZCode 缺参回 400），此前 CLI 传 undefined 导致报错误导（`zcode_send_failed: …模型列表查询失败`）。现在 `--cwd` 缺失或非绝对路径在本地报用法错误（exit 1，`用法：zcode-sub models --cwd <工作区绝对路径> [--json]`）；usage 行与两份 README 命令表同步改为必填写法，`--model` 格式错误、api 层 `zcode_model_invalid` 的「查可选值」脱困指引与 skill 排障表同步为带 `--cwd` 的可执行用法，假测试服务器按契约对缺参回 `400 bad_request`。

### 不兼容

- `patch/*.sh` 默认路径（`REAL_HOME` / `TOOLCHAIN_ROOT`）——旧：三个脚本（backup/install/rollback）的 `REAL_HOME` 写死 `/Users/weidwonder`，两个脚本（build/sync）的 `TOOLCHAIN_ROOT` 写死 `/Users/weidwonder/projects/.toolchains`；新：`REAL_HOME` 改为 `${ZCODE_REAL_HOME:-$HOME}`，`TOOLCHAIN_ROOT` 改为 `${ZCODE_TOOLCHAIN_ROOT:-<家目录>/.cache/zcode-sub/toolchains}`（`<家目录>` = `ZCODE_REAL_HOME`，未设时为 `$HOME`）；迁移：HOME 被重定向的环境（沙箱/多账号容器）设 `ZCODE_REAL_HOME=<真实家目录>`（或按脚本直接设 `ZCODE_ROOT` / `ZCODE_TOOLCHAIN_ROOT` / `ZCODE_BACKUP_ROOT`）；想复用旧工具链设 `ZCODE_TOOLCHAIN_ROOT=<家目录>/projects/.toolchains`，否则可删除旧目录（下次构建会重新下载约 40 MB）。`backup-zcode-data.sh` 找不到数据目录时报错并给出该设置提示（--dry-run 同样拦截）；`patch/README.md` 新增「环境变量」一节，示例路径全部占位符化；兼容取舍详见 patch spec §8.1。
- 传输层整体切换：`zcode-sub` 从 ZCode Webhook Bot 入站（契约 v1）改为 ZCode 本机任务 API（契约 v2）。旧调用方式：配置 botId/secret、GUI 建 Webhook bot、bind code 绑定、`setup --bot-id/--bind-code/--secret/--daemon-port/--ingress-port`；新调用方式：`zcode-sub setup`（写 `~/.zcode/v2/local-task-api.json`，token 自动生成），`run` 直接建 ZCode 普通对话（多任务并行），`send` 运行中可补充消息（auto/steer/queue）。迁移：删除旧 `~/.zcode-sub` 重跑 setup。原因：用户要求多对话并行与运行中补消息，v1 单 bot 单会话且无 steer（spec §14 决策 D-v2-01）。
- 桥接 daemon（`zcode-sub daemon` 子命令、出站回调接收、`/internal/reply` HTTP 面）删除——v2 为拉模式（events 长轮询），`reply_to_parent` 改为 MCP 进程直写信箱文件。
- 退出码 6（未绑定）删除；退出码表变为 2/3/4/5/7/8（3 的语义改为 workspace_not_open，8 为并发上限；完整闭集见 spec §3）。

### 新增

- 社区健康文件：`SECURITY.md`（经 GitHub private vulnerability reporting 私下报告；范围含 token 处理、本机回环 API、开关文件权限、默认 yolo，ZCode 本身问题指向上游）、`CODE_OF_CONDUCT.md`（Contributor Covenant 2.1 原文，执行联系人 weidwonder@gmail.com）、`.github/ISSUE_TEMPLATE/bug_report.yml`（必填 ZCode 版本、`zcode-sub --version`、打码后的 `zcode-sub setup` 输出、macOS 版本、复现步骤、期望/实际）与 `config.yml`（安全问题指向私下报告）；`CONTRIBUTING.md` 补行为准则与安全报告指引。
- `zcode-sub` v0.2.0：契约 v2 全套——CLI（setup/run/send/wait/result/resume/stop/list/mcp）、API 客户端（`src/api.js`：createTask/sendMessage/stopTask/getTask/getEvents 长轮询）、多任务 name→taskId 映射、MCP `reply_to_parent` 直写信箱、假 ZCode v2 全链路测试、真机冒烟脚本 v2、Claude Code Skill 与 README。
- 迁移 checksum 门检工具 `patch/verify-migration-checksums.mjs`（上游更新后替换安装前重跑，账本超集或 checksum 漂移即非零退出）。
- ZCode 补丁版工具链五脚本（`patch/backup-zcode-data.sh`、`build-desktop.sh`、`install-desktop.sh`、`rollback-desktop.sh`、`sync-upstream.sh`）与流程文档 `patch/README.md`——数据保全、mac arm64 构建（Preview/production 双身份）、安装替换与回滚、上游跟随。
- 兼容性调查报告 `docs/report/zcode-patched-build-compat.md`——3.16.2 打开 3.16.3 数据安全（逐条 checksum 证据）、登录态与签名无关、强更门实测状态、Preview 并存推荐方案。

### 变更

- README（中英两份）重写：首屏改为副标题 +「为什么用它」（首条为把重活交给 ZCode 绑定的模型、分担 Claude 用量）+ 白话版工作原理，内部术语首次出现给解释；安装改为完整路径（clone fork 分支 `weidwonder/ZCode@feat/local-task-api` → 备份 → 构建 → 安装 ZCode Preview → `zcode-sub setup` 看到「✓ 本机任务 API 正常」），删去「计划提交上游」，改为如实说明补丁维护在 fork 分支；新增「运行中改向」（`--steer` / `--interrupt` 最小示例与对应事件）、退出码表（码/含义/怎么办）、「限制」、「问题与建议」小节；`## 需求`、`## 架构与边界` 两个锚点标题保留。
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
- （真机复测轮）修 `send --interrupt` 截断轮事件重放：确认回空闲后、发消息前读增量事件页（waitMs=0）把持久游标 eventsSeq 推进到 nextSeq——截断轮终态事件不再出现在后续新起的 wait（读取失败不阻断发送，stderr 提示；正在挂起的旧 wait 仍可能先见到，Skill 已注明继续 wait 不要误收尾）。
- `patch/series` 固化 ZCode 补丁的三个净提交（即 fork 分支 `weidwonder/ZCode@feat/local-task-api` 上的三个提交）并加契约测试校验行，`sync-upstream.sh` 从此会实际 cherry-pick 补丁。

### 修复

- `zcode-sub --help` 环境变量列表补上 `ZCODE_SUB_INTERRUPT_TIMEOUT_MS`（`send --interrupt` 等任务回空闲的上限，默认 15000 毫秒），与 README 配置表一致。
- `patch/README.md` 流程一的验证步骤改为用 `zcode-sub setup` 看到「✓ 本机任务 API 正常」（原写「Webhook Bot 功能可用」，对应已删除的 v1 传输层）；流程一开头补「源码来源」：clone fork 分支 `weidwonder/ZCode@feat/local-task-api`；流程二补前提——从 fork clone 的源码目录先把 `origin` 指回上游再跑 `sync-upstream.sh`。`patch/series` 注释与 ZCode 依赖声明里的「上游 PR」说法同步改为补丁维护在 fork 分支。
- POST 请求不再自动重试（除上条带幂等键的 createTask）：写入失败即报 `zcode_api_unreachable` 并提示「任务可能已创建，先用 list / GUI 核对」（防双建任务）；GET 保留一次重试。
- `getEvents` 对 HTTP ≥400 统一抛 `zcode_send_failed`（此前 404 以 200 语义 payload 返回）。
- 新增 `ZCODE_SUB_DEBUG=1` 请求/响应摘要日志（debug.log，不含 token 与 prompt 正文）。
- 真机冒烟脚本 run 断言的 JSON 空格修正（紧凑输出下原 grep 恒不匹配）。

### 内部

- `test/cli.test.js` 两个「目录不可写」用例在 tmpdir 带继承 ACL 的环境（macOS `ls -le` 有 ACE）下 chmod 造不出不可写、因而误红：改为 chmod 后探测目录是否真不可写，仍可写时 `t.skip("…ACL 环境下无法模拟不可写")` 并清理临时目录（`TMPDIR=/private/tmp` 下行为不变）。
- `patch/series` 的三个补丁提交号更新为 `76dc288b` / `3179cb1f` / `708c29dc`：ZCode 侧这三个提交改写了作者邮箱（内容不变），旧提交号已不存在。
- engineering-context：ZCode 依赖声明更新为 v2 接口清单；bots-webhook 事实卡保留 v1 会话语义结论（决策记录考古用）。
- spec（`docs/spec/2026-10-27-zcode-sub-patch-tooling-eng-spec.md`）、ZCode 上游事实卡（`engineering-context/dependencies/ZCode/`）与依赖声明（`engineering-context/dependencies/ZCode.md`）。
