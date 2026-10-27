---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: 2026-10-27
authority_refs:
  - 'src/ingress.js 的 postIngress/queryStatus/parseStatusState'
  - 'src/mailbox.js 的 appendMailbox/readMailbox/readCursor/writeCursor'
  - 'daemon HTTP 面（POST /zcode/outbound、POST /internal/reply、GET /internal/health）'
  - 'MCP 工具 reply_to_parent(task, message)'
---

# zcode-sub 桥接程序 Coding Plan

> 执行者零上下文可做；每步一个动作。spec：`docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`（FR/AC/决策 D-01~D-07 全在那）。
> Worktree: `/Users/weidwonder/projects/zcode-sub/.worktrees/bridge-mvp`｜Task Branch: `feat/bridge-mvp`｜主分支: `main`（不合并，派发者负责）

**Goal:** 建成 `zcode-sub` CLI + daemon + MCP server，Claude Code 可把 ZCode 桌面版当子代理派发/续聊/取结果。
**Architecture:** CLI 进程直发入站 HTTP 到 ZCode 端点；daemon 只收 ZCode 出站与 MCP reply、按 bot 当前任务落 jsonl 信箱；wait/result 靠信箱游标与 /status 复核。
**Tech Stack:** Node ≥22、ESM、零运行时依赖、node:test；MCP 用最小 JSON-RPC（D-06）。

## Interfaces（全任务共用）

```
src/home.js     getHome() -> string（env ZCODE_SUB_HOME ?? userInfo().homedir + "/.zcode-sub"）
                pathsOf(home) -> {configFile,tasksFile,mailboxesDir,daemonJson,daemonLog}
src/config.js   loadConfig(home) -> {botId,secret,userId,daemonPort,ingressPort} | null
                saveConfig(home, cfg)（0600 原子写）
src/ingress.js  postIngress(cfg, text, {ingressPort}) -> {status, ok, replies:[string]}
                parseStatusState(repliesText) -> "running"|"completed"|"failed"|"cancelled"|"stopped"|"draft"|"unknown"
                queryStatus(cfg) -> {state, raw}
src/mailbox.js  appendMailbox(home, name, {kind,text,raw}) -> seq
                readMailbox(home, name) -> [{seq,ts,kind,text,raw}]
                readCursor(home,name)/writeCursor(home,name,seq)
src/tasks.js    loadTasks(home) -> {tasks:{name:{cwd,startedAt,lastActivityAt,lastStatus,isCurrent}}}
                saveTasks(home, tasksStore)（原子写）
src/ensure.js   ensureDaemon(home, cfg) -> {pid, port, baseUrl}（探活→拉起 detached→等端口≤5s）
src/daemon.js   startDaemon(home, cfg) -> {server, port}（库入口；listen 127.0.0.1）
src/mcp.js      runMcpServer({daemonUrl, secret})（stdin/stdout JSON-RPC）
bin/zcode-sub.js  #!/usr/bin/env node；子命令 setup/run/send/wait/result/resume/stop/list/mcp/daemon
test/helpers/fake-zcode.js  startFakeZcode({script}) -> {port, ingressUrl, calls, stop}
                script: (call => 行为) 的回调表，默认按契约 v1 返回
```

## Tasks

### Task 1：骨架 + home/config/mailbox/tasks（本地状态层）
**Slice:** 状态目录读写全通（信箱追加/游标/任务登记可被后续一切命令复用）｜**依赖:** 无
**满足:** FR-002（信箱持久化部分）
**Files:** Create `package.json` `bin/zcode-sub.js`（暂空分发）`src/home.js` `src/config.js` `src/mailbox.js` `src/tasks.js`；Test `test/state.test.js`
- [ ] 失败测试：临时目录做 home → appendMailbox 3 条 → readMailbox 返回 seq 1..3；重启（新进程内存）再 append 续 4；name 含 `/` 抛 `zcode_name_invalid`；loadConfig 缺文件返回 null；saveConfig 后 mode 0600。
- [ ] 实现（要点）：name 校验 `/^[A-Za-z0-9._-]+$/`；信箱 append 用 `fs.appendFile` + 行内 JSON；seq=重启时扫文件尾最后一行 seq+1；tasks/config 原子写（tmp+rename）。
- [ ] `npm test` PASS → commit `feat: 状态目录与信箱层`

### Task 2：daemon（出站接收 + internal 面）
**Slice:** 假 ZCode 打 daemon 出站端点 → 消息进当前任务信箱；MCP reply 落指定任务｜**依赖:** Task 1
**满足:** FR-002、FR-010（/internal/reply 落信箱部分）
**Files:** Create `src/daemon.js`；Test `test/daemon.test.js`
- [ ] 失败测试：起 daemon（port 0）→ POST /zcode/outbound 带 secret + botId/userId 匹配 + tasks.json 有 current → 204 + 信箱出现 kind=outbound；secret 不符 401 且信箱空；botId 不符 204 且不落；POST /internal/reply {task,message} → 信箱 kind=reply；task 未知 404；GET /internal/health 返回 pid/port；日志文件出现 event 行。
- [ ] 实现：`node:http` 原生 server；handler 顺序 = secret 校验 → 路由；body ≤1MiB 截 413；listen("127.0.0.1")。
- [ ] PASS → commit `feat: daemon 出站接收与 internal reply`

### Task 3：入站客户端 + 状态解析
**Slice:** postIngress 对假 ZCode 收发；/status 文本六态解析｜**依赖:** 无（config 类型来自 Task 1）
**满足:** FR-003（状态查询基础）
**Files:** Create `src/ingress.js`；Test `test/ingress.test.js`
- [ ] 失败测试：假 ZCode（契约 v1 行为：/health、POST /api/bots/webhook/:botId 校验 secret、回 `{ok,replies}`）→ postIngress 收到 body botId/userId/messageId 前缀 zsub-；401 → 抛 `zcode_secret_mismatch`；连不上 → `zcode_ingress_unreachable`；parseStatusState 对 zh/en 六态样例 + 不可解析 → unknown。
- [ ] 实现：fetch + AbortSignal.timeout(10_000)；网络错重试 1 次复用同 messageId；状态解析表按 spec §4.3。
- [ ] PASS → commit `feat: 入站客户端与状态解析`

### Task 4：CLI 骨架 + ensureDaemon + setup + run + list
**Slice:** `zcode-sub run` 三连发（status→/new→正文）对假 ZCode 全通并登记任务｜**依赖:** Task 1-3
**满足:** FR-001、FR-003、FR-009
**Files:** Create `src/ensure.js` `src/cli.js`；Modify `bin/zcode-sub.js`；Test `test/cli-run.test.js`
- [ ] 失败测试（子进程跑 bin，env 指临时 home + 假 ZCode ingress）：
  - `setup --print-steps` 输出含 health 结果与 GUI 步骤文本、mcp 配置片段；
  - `setup --bot-id b1 --ingress-port <port>` 写回 config；
  - `setup --bind-code C1`（假 ZCode 回「绑定成功」）→ config 固化 + stdout 提示；回「绑定码无效」→ exit 6 zcode_not_bound 等价路径（此处按 secret 校验路径测 `zcode_secret_mismatch` exit 5）；
  - `run "<任务>" --cwd /tmp` → 假 ZCode 收到 `/new` 与正文（正文含 name 与 reply_to_parent 说明）→ stdout 一行 JSON（可 JSON.parse，name 合法）；
  - 假 ZCode /status 回「⏳ 运行中」→ run exit 3 + stderr zcode_task_busy；
  - `list --json` 出刚建的任务。
- [ ] 实现：cli.js 按 spec §4.1/§4.4；ensureDaemon=health 探测→`spawn(process.execPath,[bin,"daemon"],{detached,stdio:"ignore",env:{ZCODE_SUB_HOME}}).unref()`→轮询 health ≤5s。
- [ ] PASS → commit `feat: setup/run/list 命令`

### Task 5：send/wait/result/resume/stop
**Slice:** 全命令生命周期对假 ZCode 闭环（run→wait 收消息→result 终态取全文→resume→stop）｜**依赖:** Task 4
**满足:** FR-004、FR-005、FR-006、FR-007、FR-008
**Files:** Modify `src/cli.js`；Test `test/cli-lifecycle.test.js`
- [ ] 失败测试：
  - send 在 running（假 ZCode 回 taskRunning 文案）→ exit 4 + stderr zcode_send_rejected + 原文案；终态 → 投递成功即 resume 语义（fakeZCode 断言收到正文）；
  - wait：先向 daemon 投 2 条出站 → wait 打印 2 条推进游标 → 再 wait 立即 TIMEOUT（exit 2）；--timeout 1 生效；
  - result：/status 回「✅ 已完成」→ 打印信箱正文全集 + 状态行；回「⏳ 运行中」→ 打印「还在跑」；
  - resume：isCurrent 任务投递正文；非 current name → 报错 exit 7（zcode_name_invalid 之外加 `zcode_not_current`？——统一用非零 + 人话，见 Step 3 注）；
  - stop：/stop 投递 → 打印假 ZCode 回的 status 文本。
- [ ] 实现：按 spec §4.5；exit 码表 §3。
- [ ] PASS → commit `feat: send/wait/result/resume/stop`

### Task 6：MCP server
**Slice:** 子进程管道驱动 `zcode-sub mcp` 完成 initialize→tools/list→tools/call→信箱 kind=reply｜**依赖:** Task 2
**满足:** FR-010
**Files:** Create `src/mcp.js`；Modify `bin/zcode-sub.js`；Test `test/mcp.test.js`
- [ ] 失败测试：spawn bin mcp，env 指假 daemon；写 initialize → 读响应 protocolVersion/serverInfo；tools/list 有 reply_to_parent；tools/call {task,message} → 信箱出现 kind=reply；task 未知 → isError:true 且 server 不退出。
- [ ] 实现：逐行读 stdin JSON-RPC；method 分发 initialize/tools/list/tools/call；notifications 不回。
- [ ] PASS → commit `feat: MCP stdio server`

### Task 7：冒烟脚本 + Skill + README + CHANGELOG + 依赖声明
**Slice:** 面向派发者的全部交付物｜**依赖:** Task 1-6
**满足:** FR-012、FR-013、FR-014
**Files:** Create `scripts/smoke-real-zcode.sh` `skill/zcode-sub/SKILL.md` `README.md` `CHANGELOG.md` `engineering-context/dependencies/ZCode.md`
- [ ] smoke 脚本：setup 检查 → run（要求用户传任务文本）→ wait 轮询 → result 断言非空；每步 echo 断言说明；`set -euo pipefail`。
- [ ] SKILL.md：frontmatter name/description（触发：要用 zcode-sub 派发/续聊/取结果时）；正文最小用法（对齐 dwc-sub 那几行风格）。
- [ ] README：安装（npm link 本地/PATH）、一次性配置（GUI 建 bot + bind + MCP 配置片段）、命令、安全边界（127.0.0.1/secret/信箱 0600/不写 ZCode 文件）、多任务限制（D-01）与启发式风险（spec §5）。
- [ ] CHANGELOG `## 未发布` → `新增：zcode-sub v0.1.0（setup/run/send/wait/result/resume/stop/list/mcp/daemon）`。
- [ ] 依赖声明 ZCode.md：接口名（POST /api/bots/webhook/:botId、GET /health、出站 zcode.bot.message/elicitation_request、/bind、/new、/status、/stop）+ 调用点（文件:行）+ 业务域地图登记 bots-webhook 卡。
- [ ] `npm test` 全绿 → commit `docs+chore: 交付物与依赖声明`

## Checkpoints
- Task 3 后：本地状态层+daemon+入站全通，`npm test` 绿。
- Task 5 后：CLI 生命周期全绿（AC-002~005 基础）。
- Task 7 后：全量绿 + `node --check` 全部 src（语法门）。

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| 上游 /status 文案变化 | M | 解析表收 unknown 降级 + 测试锁 zh/en 现值 |
| daemon 端口被占 | M | 默认 0 随机分配写回；占用时报错带日志路径 |
| run 三连发与出站竞态（/new 后旧任务迟到的出站落进新任务信箱） | L | 分拣只认 isCurrent；README 记录该边界 |

## 替换清单核销
无被取代物（新仓首版）。
