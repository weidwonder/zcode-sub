# zcode-sub

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json) [![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](README.md#前置条件) · [English](README.en.md)

把 **ZCode 桌面版**当作 **Claude Code 的子代理**：一条命令把任务派进 ZCode 的普通对话，运行中可补充消息或打断，子代理能主动回话，最终回复一条命令取回。任务是 ZCode GUI 里的**普通对话**——实时可见、可并行多开、人可随时接管。

```
Claude Code ──run/send/resume/stop──▶ ZCode 本机任务 API（127.0.0.1，契约 v2）──▶ ZCode GUI 普通对话
Claude Code ◀──wait（事件长轮询 + 信箱）──────────────────────────────────────┘
ZCode 拉起 zcode-sub mcp ──reply_to_parent──▶ 信箱文件（wait 读取）
```

- **GUI 可见**——派出去的任务不是黑盒：ZCode 窗口里实时看进度，随时人工接管继续聊。
- **多任务并行**——每次 `run` 新开一个对话，同时未结束任务默认 4 个（可调）。
- **运行中改向**——`send --steer` 原生引导（当前步骤结束时注入）、`send --interrupt` 截断重发、空闲任务 `resume` 接续。
- **子代理主动回复**——ZCode 侧经 `reply_to_parent` MCP 工具主动给父代理留言，`wait` 一并收到。
- 零运行时依赖的单 CLI（Node ≥ 22，ESM）；全部通信只走本机回环。

## 前置条件

| 依赖 | 说明 |
|---|---|
| macOS | ZCode 桌面版与补丁构建工具链在 mac（arm64）验证 |
| Node ≥ 22 | 桥接 CLI 的唯一运行时（零 npm 依赖） |
| ZCode 桌面版（同机） | 需内置「本机任务 API」（契约 v2），见下文 |
| Claude Code | 可选——不装也能当普通 CLI 用；装上 skill 才有「子代理」完整体验 |

**ZCode 侧的「本机任务 API」**是本仓维护的 ZCode 补丁（三个干净提交，清单固化在 [`patch/series`](patch/series)），计划提交上游 [zai-org/ZCode](https://github.com/zai-org/ZCode)。两条路：

- **上游合入并发布后**：官方 ZCode 桌面版直接可用，无需自行构建。
- **当前（未合入）**：用本仓 [`patch/`](patch/README.md) 工具链从源码构建补丁版——数据备份、构建、安装并存、上游跟随全流程脚本化：

```bash
patch/backup-zcode-data.sh                 # 备份 ~/.zcode（替换安装前必做）
patch/build-desktop.sh <ZCode源码目录>      # mac arm64 构建；默认 Preview 身份，与正式版并存
patch/install-desktop.sh <构建出的 .app>    # 安装替换（旧包只移走、永不删除）
```

## 安装

```bash
git clone https://github.com/weidwonder/zcode-sub
cd zcode-sub
npm link                 # 或把 bin/zcode-sub.js 加入 PATH；本仓库不发布 npm
zcode-sub --version      # 验证
```

**HOME 被重定向的运行环境**（如 AI harness 以另一 OS 用户运行、`os.userInfo().homedir` 为 `/var/empty` 之类）：默认路径推导会失效，须显式设置两个环境变量——建议用启动脚本包装（shim 示例）：

```bash
#!/bin/bash
# zcode-sub-shim：放到 PATH 里替代裸命令
export ZCODE_SUB_HOME="${ZCODE_SUB_HOME:-/Users/<你的用户名>/.zcode-sub}"
export ZCODE_DATA_BASE_DIR="${ZCODE_DATA_BASE_DIR:-/Users/<你的用户名>}"
exec /path/to/zcode-sub/bin/zcode-sub.js "$@"
```

## 快速上手

前提：ZCode 桌面版已启动。

```bash
# 1) 一次性配置——生成/读取开关文件 ~/.zcode/v2/local-task-api.json（token 以 0600
#    写入，写完需重启 ZCode 生效），健康检查，并打印把 zcode-sub mcp 配进 ZCode 的
#    JSON 片段（放进 ~/.zcode/cli/config.json 的 mcp.servers；不配则收不到子代理
#    主动回复，其余功能不受影响）
zcode-sub setup

# 2) 派任务——在该工作区新建 ZCode 对话执行任务；stdout 输出一行 JSON
zcode-sub run "重构 src/api.js 的错误处理并补测试" --cwd ~/projects/demo --name refactor
# {"name":"refactor","taskId":"session_xxxx","status":"dispatched","workspacePath":"/Users/you/projects/demo","clientRequestId":"..."}

# 3) 等事件（建议后台运行；超时输出 TIMEOUT、退出码 2——再等一次即可）
zcode-sub wait refactor
# [turn.started] …
# [reply] 来自子代理的主动消息
# [turn.completed] 重构完成：……

# 4) 取最终回复
zcode-sub result refactor
# 状态：idle
# ----- 最后回复 -----
# <最终回复全文>
```

无需预先在 ZCode 打开工作区：`--cwd` 指向的本机目录未打开时，ZCode 自动在当前窗口加该目录标签页（无确认弹窗，最长 30 秒）；失败按退出码 3 报告。

**装进 Claude Code**（可选；之后 Claude Code 会按 [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md) 自动使用本工具）：

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skill/zcode-sub" ~/.claude/skills/zcode-sub    # 或把整个目录复制过去
```

## 命令

| 命令 | 作用 |
|---|---|
| `zcode-sub setup [--api-port …]` | 写/读开关文件、健康检查、打印 MCP 配置片段 |
| `zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>] [--mode <模式>] [--model <providerId/modelId>] [--thought <档位>]` | 在 ZCode 新建对话执行任务；默认 mode=yolo（完全访问，子代理不卡权限确认）；stdout 一行 JSON（name/taskId） |
| `zcode-sub send <name> "<消息>" [--steer\|--queue\|--interrupt]` | 补充消息：默认 auto（运行中=GUI 默认排队/引导）；`--steer` = ZCode 原生引导（当前步骤结束时注入，长文本生成时可能要等较久；应答仅为受理，结果以事件流 `steer.injected` / `steer.fellBack` 为准）；`--interrupt` = 截断当前生成（停止→等回空闲→作为新一轮发送，未完成内容丢弃）；空闲=接续对话 |
| `zcode-sub wait <name> [--timeout 秒]` | 阻塞等新事件/子代理主动消息（默认 600 秒；超时 TIMEOUT，退出码 2） |
| `zcode-sub result <name>` | 最后回复全文 + 状态；还在跑会明确说 |
| `zcode-sub resume <name> "<继续文本>"` | 空闲任务接续对话（运行中补充用 send） |
| `zcode-sub stop <name>` | 停止生成 |
| `zcode-sub list [--json]` | 本地任务表（name/taskId/状态） |
| `zcode-sub models [--cwd <绝对路径>] [--json]` | 列可用模型（providerId/modelId/思考档位/默认档位/默认标记） |
| `zcode-sub model <name> <providerId/modelId> [--thought <档位>]` | 给已派发任务换模型（下一轮生效） |
| `zcode-sub mcp` | stdio MCP server（`reply_to_parent`），由 ZCode 拉起 |

- **按模型派发/换模型**：可用值先 `zcode-sub models` 查（带与 run 相同的 `--cwd`）；`run --model <providerId/modelId> [--thought <档位>]` 派发时指定（config 可设 `defaultModel` 兜底，不传用 ZCode 默认），`zcode-sub model <name> …` 给已派发任务换（下一轮生效，运行中允许）。非法值本地预校验报 `zcode_model_invalid`（exit 1）并列出可选值。**未指定 --thought 时自动用默认档位**（max 优先；其次模型 defaultThoughtLevel；再取列表末档），实际档位打印在 stderr。
- **改向的两种手段**：`--steer` 注入时机靠后但保留上文；`--interrupt` 立即截断（未完成内容丢弃），与 `--steer`/`--queue` 互斥，等待上限 `ZCODE_SUB_INTERRUPT_TIMEOUT_MS`（默认 15s，超限消息不发送、exit 4）。

**退出码**：`1` 用法错误（含未知参数、未配置、本地无此任务、EACCES、工作区路径非法、模型选择被拒绝——报错里带原因，用 `zcode-sub models` 查可选值）；`2` 连不上本机任务 API 或 wait 超时；`3` 工作区问题（未打开/远端；自动打开超时可直接重试；ZCode 禁止打开时先处理 ZCode 窗口）；`4` 按 taskId 的请求失败（含任务被删）或运行中 resume 被拒；`5` token/Host 校验失败；`7` 任务名非法或重名（名字仅 `[A-Za-z0-9._-]+`）；`8` 未结束任务数达上限（默认 4）。完整错误码闭集与事件类型清单以 spec §3 为准（`docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`）。

其他：未知参数按命令白名单报用法错误（exit 1，不静默忽略）。

## 配置

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZCODE_SUB_HOME` | `~/.zcode-sub` | 状态目录（任务分片与信箱）；HOME 被重定向的环境必须显式设置 |
| `ZCODE_DATA_BASE_DIR` | 真实用户家目录 | ZCode 数据目录基目录（开关文件在 `<该目录>/.zcode/v2/local-task-api.json`） |
| `ZCODE_SUB_MAX_RUNNING` | `4` | 同时未结束任务数上限（尽力检查——多进程同时派发的瞬间可能超出） |
| `ZCODE_SUB_INTERRUPT_TIMEOUT_MS` | `15000` | `send --interrupt` 等任务回空闲的上限，超限消息不发送（exit 4） |
| `ZCODE_SUB_DEBUG` | 关 | `=1` 时 API 请求/响应摘要追加 `~/.zcode-sub/debug.log`（不含 token 与任务正文） |

`~/.zcode-sub/config.json`（setup 生成，0600）：`apiPort`（默认 47821）、`token`（鉴权）、`defaultMode`（可选，run 的默认派发模式，11 值枚举同 `--mode`）、`defaultModel`（可选，形体同 `--model/--thought`，如 `{"providerId":"…","modelId":"…","options":{"reasoningLevel":"…"}}`）。

## 安全边界

- **只走本机回环**：全部 API 通信仅 127.0.0.1；ZCode 侧只在开关文件存在且 `enabled:true` 时监听。不监听外网、不做远程 ZCode。
- **token 鉴权**：开关文件里的随机 token（≥32 字符）以 Bearer 头校验，文件 0600 原子写入；token/Host 校验失败按退出码 5 拒绝。
- **默认 yolo 的含义与风险**：`run` 默认 `mode=yolo`（GUI「完全访问」）——派发的子代理**不再卡权限确认**，它能在工作区与终端里做什么，取决于 ZCode 登录账号的权限。介意时用 `--mode` 逐次指定或 config `defaultMode` 全局改保守档（11 值枚举见 `zcode-sub --help`）。本工具不经 API 批权限：`wait` 收到 `permission.requested` 事件只会提示去 ZCode GUI 处理。
- **副作用可核**：建任务与发消息均带 `clientRequestId` 幂等键（同键返回首次应答），网络失败同键安全重试一次；本工具不写 ZCode 的其他数据文件，开关文件仅 setup 显式写入（已存在时以它为准）。

## 需求

1. **ZCode 作 Claude Code 的子代理**（`bin/`、`src/`、`skill/`）：任务派发、运行中补充消息、子代理主动回复父代理、交付最终回复、接续任务、多任务并行，任务在 ZCode GUI 实时可见（见上文「命令」与 [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md)）。
2. 补丁版工具链（`patch/`）回答四个业务问题（结论与证据见 [docs/report/zcode-patched-build-compat.md](docs/report/zcode-patched-build-compat.md)）：
   1. **数据保全**：替换/降级 ZCode 前，用户的登录态、任务历史、技能与配置如何完整备份与恢复（`patch/backup-zcode-data.sh`）。
   2. **补丁构建**：开源源码 + 本地补丁如何构建出可安装的 mac 包，身份怎么选（Preview 并存 vs production 原地替换，默认 Preview）（`patch/build-desktop.sh`）。
   3. **安装与回退**：如何替换/并存/回退 `/Applications` 里的应用且旧包永不丢失（`patch/install-desktop.sh`、`patch/rollback-desktop.sh`——由用户本人在终端直接运行）。
   4. **上游跟随**：上游整批快照同步后，补丁如何低成本跟上并先过降级兼容门检（`patch/sync-upstream.sh`、`patch/verify-migration-checksums.mjs`）。

   操作流程照抄 [patch/README.md](patch/README.md)。

## 架构与边界

- 桥接 CLI（`bin/zcode-sub.js` + `src/`，Node ≥ 22、零依赖）：只通过 127.0.0.1 上的 ZCode 本机任务 API 与 ZCode 通信；`reply_to_parent` 由 ZCode 拉起的 `zcode-sub mcp` 直写本地信箱；`skill/zcode-sub/` 是给 Claude Code 的使用说明。
- 补丁版工具链（`patch/`，bash + 少量 Node 脚本，无服务、无长期进程）：
  - `patch/backup-zcode-data.sh` — 用户数据目录（~/.zcode）备份（SQLite 在线备份 + manifest/sha256）
  - `patch/build-desktop.sh` — mac arm64 构建（Node/pnpm 工具链自举到 `.toolchains/`，不动全局）
  - `patch/install-desktop.sh` / `patch/rollback-desktop.sh` — 应用目录（/Applications）安装替换与回退（用户本人运行；旧包只 mv 不删）
  - `patch/sync-upstream.sh` — fetch 上游 → `local/patched-<短SHA>` 分支 → 按 `patch/series` 净提交 cherry-pick → typecheck/lint
  - `patch/verify-migration-checksums.mjs` — 迁移账本 checksum 门检（替换安装前必跑）
  - `patch/series` — 补丁净提交清单（SHA 行 / `#` 注释 / `!` 自定义校验行）
  - `docs/` — spec 与调查报告（[索引](docs/index.md)）；`engineering-context/` — 代码事实层与上游 ZCode 的依赖声明
- 工具链边界：不在本仓修改上游 ZCode 源码（补丁提交在 ZCode 仓分支上开发，经 `patch/series` 固化）；不做数据自动回滚（备份与校验有，覆盖用户数据的动作不代做）；不做 Windows/Linux 构建；不做签名与公证。

## 开发

```bash
npm test                        # node:test，假 ZCode（契约 v2）全链路
scripts/smoke-real-zcode.sh    # 真机冒烟（需 ZCode 已装补丁并完成配置）
```

文档：spec `docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`（含 v1→v2 方案变更决策记录）、coding plan `docs/plan/`、覆盖度 `docs/report/测试场景覆盖度.md`。本仓日常开发用 dw-workflow 流程（见 `AGENTS.md` 标记块）——外部贡献者不需要它，见下。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)（报 issue、跑测试、提交规范）。

## 许可证

[Apache-2.0](LICENSE)。`patch/` 工具链构建的上游 ZCode 本身也是 Apache-2.0（[zai-org/ZCode](https://github.com/zai-org/ZCode)）；补丁以提交清单（`patch/series`）引用，不复制上游代码。
