# zcode-sub — 让 Claude Code 把 ZCode 桌面版当子代理用

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json) [![Platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey.svg)](#前置条件) · [English](README.en.md)

一条命令把任务派进本机 ZCode 桌面版的一个普通对话，运行中可以补充消息或打断，子代理能主动回话，最终回复再用一条命令取回。

## 为什么用它

- **分担 Claude 的用量**——重活交给 ZCode 里绑定的模型（如 GLM Coding Plan）去跑，Claude Code 只负责派发、跟进和验收。
- **GUI 里实时可见、可接管**——派出去的任务就是 ZCode 窗口里的普通对话：随时看进度，随时自己接着聊。
- **多任务并行**——每次 `run` 新开一个对话，同时未结束的任务默认最多 4 个（可调）。
- **运行中改向**——任务跑着也能追加要求，或直接打断重来（见[运行中改向](#运行中改向)）。

<!-- 截图：ZCode 窗口里运行中的派发任务 + 旁边终端 wait 输出；文件放 docs/assets/screenshot.png -->

## 工作原理

```text
Claude Code ──run/send/resume/stop──▶ ZCode 本机任务 API（127.0.0.1）──▶ ZCode GUI 普通对话
Claude Code ◀──wait（事件长轮询 + 信箱文件）─────────────────────┘
ZCode 拉起 zcode-sub mcp ──reply_to_parent──▶ 信箱文件（wait 读取）
```

- **本机任务 API**：补丁版 ZCode 在 127.0.0.1 上开的 HTTP 接口，zcode-sub 通过它建对话、发消息、读事件。官方版 ZCode 没有这个接口。
- **reply_to_parent / 信箱文件**：ZCode 里的子代理通过 MCP（ZCode 调用外部工具的协议）调用 `reply_to_parent` 给父代理留言；留言写进本地的信箱文件，`wait` 读出来。
- 单个 CLI，零 npm 依赖（Node ≥ 22，ESM），全部通信只走本机回环。

## 前置条件

| 依赖 | 说明 |
|---|---|
| macOS arm64 | ZCode 桌面版与补丁构建工具链只在 mac arm64 验证过 |
| Node ≥ 22 | zcode-sub 的唯一运行时 |
| git、Xcode Command Line Tools | 构建补丁版 ZCode 用（native 依赖要编译） |
| 补丁版 ZCode 桌面版（同机） | 带「本机任务 API」，基于 ZCode 3.16.2；安装步骤见下 |
| Claude Code | 可选——不装也能当普通 CLI 用；装上 skill 才有「子代理」完整体验 |

## 安装

**补丁从哪来**：「本机任务 API」是本仓维护的 ZCode 补丁，三个提交维护在 fork 分支 [weidwonder/ZCode@feat/local-task-api](https://github.com/weidwonder/ZCode/tree/feat/local-task-api)（基于上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 3.16.2，提交清单固化在 [`patch/series`](patch/series)）。上游不接受外部 PR；如果上游将来合入同类功能，直接用官方版即可，不必自行构建。

### 1. 取代码，装 CLI

```bash
git clone -b feat/local-task-api https://github.com/weidwonder/ZCode ~/src/ZCode   # 补丁版 ZCode 源码
git clone https://github.com/weidwonder/zcode-sub ~/src/zcode-sub
cd ~/src/zcode-sub
npm link                 # 或把 bin/zcode-sub.js 加入 PATH；本仓库不发布 npm
zcode-sub --version      # 打印 zcode-sub <版本号>
```

### 2. 构建并安装补丁版 ZCode

在 zcode-sub 仓库目录里执行：

```bash
patch/backup-zcode-data.sh            # 备份 ~/.zcode；没装过 ZCode（没有 ~/.zcode）时跳过
patch/build-desktop.sh ~/src/ZCode    # mac arm64 构建，默认 Preview 身份
patch/install-desktop.sh ~/src/ZCode/packages/desktop/dist/mac-arm64/'ZCode Preview.app'
```

- 装出来的是 `/Applications/ZCode Preview.app`，与正式版 ZCode 并存、共享登录态与历史任务；正式版不动。
- 首次构建会把 Node 24.14.0 工具链（约 40 MB）下载到 `~/.cache/zcode-sub/toolchains/`，不改全局 Node；之后还要装 pnpm 与 ZCode 的依赖。
- 想跟随上游新版本自己打补丁、或改用 production 身份原地替换，见 [patch/README.md](patch/README.md)（流程二「上游更新」、变体「production 原地替换」）。

### 3. 接通 zcode-sub 与 ZCode

打开「ZCode Preview」，然后：

```bash
zcode-sub setup
```

- 首次运行会写开关文件 `~/.zcode/v2/local-task-api.json`（随机 token，权限 0600），提示「需重启 ZCode 生效」——重启 ZCode Preview 后再跑一次 `zcode-sub setup`，看到 `✓ 本机任务 API 正常 zcodeVersion=…` 即接通。
- setup 最后会打印一段 JSON，把它合入 `~/.zcode/cli/config.json` 的 `mcp.servers`（ZCode 实时加载）。不配则收不到子代理的主动留言，其余功能不受影响。

**装进 Claude Code**（可选；之后 Claude Code 会按 [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md) 自动使用本工具）：

```bash
mkdir -p ~/.claude/skills
ln -s ~/src/zcode-sub/skill/zcode-sub ~/.claude/skills/zcode-sub    # 或把整个目录复制过去
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

前提：ZCode Preview 已打开，`zcode-sub setup` 已显示「✓ 本机任务 API 正常」。

```bash
# 1) 派任务——在该工作区新建 ZCode 对话执行任务；stdout 输出一行 JSON
zcode-sub run "重构 src/api.js 的错误处理并补测试" --cwd ~/projects/demo --name refactor
# {"name":"refactor","taskId":"session_xxxx","status":"dispatched","workspacePath":"/Users/you/projects/demo","clientRequestId":"..."}

# 2) 等事件（建议后台运行；超时输出 TIMEOUT、退出码 2——再等一次即可）
zcode-sub wait refactor
# [turn.started] …
# [reply] 来自子代理的主动消息
# [turn.completed] 重构完成：……

# 3) 取最终回复
zcode-sub result refactor
# 状态：idle
# ----- 最后回复 -----
# <最终回复全文>
```

无需预先在 ZCode 打开工作区：`--cwd` 指向的本机目录未打开时，ZCode 自动在当前窗口加该目录标签页（无确认弹窗，最长 30 秒）；失败按退出码 3 报告。

## 命令

| 命令 | 作用 |
|---|---|
| `zcode-sub setup [--api-port …]` | 写/读开关文件、健康检查、打印 MCP 配置片段 |
| `zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>] [--mode <模式>] [--model <providerId/modelId>] [--thought <档位>]` | 在 ZCode 新建对话执行任务；默认 `mode=yolo`（GUI「完全访问」，子代理不卡权限确认，风险见[安全边界](#安全边界)）；stdout 一行 JSON（name/taskId） |
| `zcode-sub send <name> "<消息>" [--steer\|--queue\|--interrupt]` | 补充消息；三个旗标互斥，用法见[运行中改向](#运行中改向)；任务空闲时即接续对话 |
| `zcode-sub wait <name> [--timeout 秒]` | 阻塞等新事件/子代理主动消息（默认 600 秒；超时 TIMEOUT，退出码 2） |
| `zcode-sub result <name>` | 最后回复全文 + 状态；还在跑会明确说 |
| `zcode-sub resume <name> "<继续文本>"` | 空闲任务接续对话（运行中补充用 send） |
| `zcode-sub stop <name>` | 停止生成 |
| `zcode-sub list [--json]` | 本地任务表（name/taskId/状态） |
| `zcode-sub models --cwd <绝对路径> [--json]` | 列可用模型（providerId/modelId/思考档位/默认档位/默认标记） |
| `zcode-sub model <name> <providerId/modelId> [--thought <档位>]` | 给已派发任务换模型（下一轮生效） |
| `zcode-sub mcp` | stdio MCP server（`reply_to_parent`），由 ZCode 拉起 |
| `zcode-sub --version` | 打印版本号 |

- **按模型派发/换模型**：可用值先 `zcode-sub models` 查（带与 run 相同的 `--cwd`）；`run --model <providerId/modelId> [--thought <档位>]` 派发时指定（config 可设 `defaultModel` 兜底，不传用 ZCode 默认），`zcode-sub model <name> …` 给已派发任务换（下一轮生效，运行中允许）。非法值本地预校验报 `zcode_model_invalid`（exit 1）并列出可选值。**未指定 --thought 时自动用默认档位**（max 优先；其次模型 defaultThoughtLevel；再取列表末档），实际档位打印在 stderr。
- `--mode` 的 11 值枚举见 `zcode-sub --help`。
- 未知参数按命令白名单报用法错误（exit 1，不静默忽略）。

## 运行中改向

任务还在跑时有两种改向手段：

```bash
# 引导：当前步骤结束时把消息注入本轮，保留上文；注入时机靠后（长文本生成时可能要等较久）
zcode-sub send refactor "顺便把日志改成结构化输出" --steer
# ✓ 投递结果：steered（commandId=…）
# ℹ steered 仅为受理引导；注入结果以事件流为准（wait 可见 steer.injected / steer.fellBack）
```

之后 `wait` 会看到 `[input.steered] 你的引导已受理…`，再是 `[steer.injected] 引导已注入当前轮`；若被降级或拒绝则是 `[steer.fellBack] …`，按提示排队或重发。

```bash
# 打断：立即停止当前生成，等任务回到空闲，再把消息作为新一轮发送；未完成的内容丢弃
zcode-sub send refactor "停，先只改 api.js，别动测试" --interrupt
# ✓ 已请求停止；等待任务回到空闲…
# ✓ 已截断当前生成，未完成内容丢弃
# ✓ 投递结果：sent
```

`--interrupt` 等任务回空闲最多 `ZCODE_SUB_INTERRUPT_TIMEOUT_MS`（默认 15 秒），超限消息不发送、退出码 4；它与 `--steer`/`--queue` 互斥。不带旗标时运行中消息的去向由 ZCode 会话设置决定（GUI 默认排队），`--queue` 强制排队。

## 退出码

| 码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 成功 | — |
| `1` | 用法错误：未知参数、未配置、本地无此任务、EACCES、工作区路径非法、模型选择被拒绝 | 按报错里的原因改；模型可选值用 `zcode-sub models --cwd <绝对路径>` 查；未配置先跑 `zcode-sub setup` |
| `2` | 连不上本机任务 API，或 `wait` 超时（输出 TIMEOUT） | wait 超时再等一次即可；连不上就确认 ZCode 已打开、跑 `zcode-sub setup` 看健康检查 |
| `3` | 工作区问题：未打开、远端工作区、自动打开超时、ZCode 禁止打开 | 超时可直接重试；被禁止（如强制升级中）先处理 ZCode 窗口；其余请在 ZCode 手动打开该目录 |
| `4` | 按 taskId 的请求失败（含任务已在 GUI 删除）、运行中 `resume` 被拒、`--interrupt` 等待超时 | 用 `zcode-sub result <name>` 看状态；运行中补充改用 `send` |
| `5` | token/Host 校验失败 | 重跑 `zcode-sub setup`（开关文件已存在时以它的 token 为准写回 `~/.zcode-sub/config.json`）；改过开关文件要先重启 ZCode |
| `7` | 任务名非法或重名（名字仅 `[A-Za-z0-9._-]+`） | 换个名字 |
| `8` | 未结束任务数达上限（默认 4） | 等已有任务结束，或调 `ZCODE_SUB_MAX_RUNNING` |

完整错误码闭集与事件类型清单以 spec §3 为准（[docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md](docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md)）。

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

## 限制

- **只支持 macOS arm64**：没有 Windows/Linux 构建。
- **需要补丁版 ZCode**：官方版 ZCode 没有本机任务 API，zcode-sub 连不上（退出码 2）。
- **权限审批只能在 ZCode GUI 里做**：zcode-sub 不经 API 批权限；`wait` 收到 `permission.requested` 事件只提示去 GUI 处理。
- **不支持远端工作区**：`--cwd` 须是本机存在的目录；远端工作区按退出码 3 报告，也不会被自动打开。
- **开关文件改动要重启 ZCode 才生效**：包括首次 setup 写入与手工改端口。
- **默认 `mode=yolo`（完全访问）**：子代理不经确认就能在工作区与终端里动手，风险与改法见[安全边界](#安全边界)。
- 补丁版自身的风险（强更门、签名、降级数据损耗等）见 [patch/README.md](patch/README.md)「已知风险与限制」。

## 安全边界

- **只走本机回环**：全部 API 通信仅 127.0.0.1；ZCode 侧只在开关文件存在且 `enabled:true` 时监听。不监听外网、不做远程 ZCode。
- **token 鉴权**：开关文件里的随机 token（≥32 字符）以 Bearer 头校验，文件 0600 原子写入；token/Host 校验失败按退出码 5 拒绝。
- **默认 yolo 的含义与风险**：`run` 默认 `mode=yolo`（GUI「完全访问」）——派发的子代理**不再卡权限确认**，它能在工作区与终端里做什么，取决于 ZCode 登录账号的权限。介意时用 `--mode` 逐次指定或 config `defaultMode` 全局改保守档（11 值枚举见 `zcode-sub --help`）。本工具不经 API 批权限：`wait` 收到 `permission.requested` 事件只会提示去 ZCode GUI 处理。
- **副作用可核**：建任务与发消息均带 `clientRequestId` 幂等键（同键返回首次应答），网络失败同键安全重试一次；本工具不写 ZCode 的其他数据文件，开关文件仅 setup 显式写入（已存在时以它为准）。

## 问题与建议

- bug 与功能建议：[GitHub Issues](https://github.com/weidwonder/zcode-sub/issues)（bug 模板会请你附上 ZCode 版本、`zcode-sub --version` 与 `zcode-sub setup` 输出）。
- 安全问题请勿公开提 issue，按 [SECURITY.md](SECURITY.md) 私下报告。
- ZCode 本身的问题请反馈给上游 [zai-org/ZCode](https://github.com/zai-org/ZCode)。

## 需求

1. **ZCode 作 Claude Code 的子代理**（`bin/`、`src/`、`skill/`）：任务派发、运行中补充消息、子代理主动回复父代理、交付最终回复、接续任务、多任务并行，任务在 ZCode GUI 实时可见（见上文「命令」与 [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md)）。
2. 补丁版工具链（`patch/`）回答四个业务问题（结论与证据见 [docs/report/zcode-patched-build-compat.md](docs/report/zcode-patched-build-compat.md)）：
   1. **数据保全**：替换/降级 ZCode 前，用户的登录态、任务历史、技能与配置如何完整备份与恢复（`patch/backup-zcode-data.sh`）。
   2. **补丁构建**：开源源码 + 本地补丁如何构建出可安装的 mac 包，身份怎么选（Preview 并存 vs production 原地替换，默认 Preview）（`patch/build-desktop.sh`）。
   3. **安装与回退**：如何替换/并存/回退 `/Applications` 里的应用且旧包永不丢失（`patch/install-desktop.sh`、`patch/rollback-desktop.sh`——由用户本人在终端直接运行）。
   4. **上游跟随**：上游整批快照同步后，补丁如何低成本跟上并先过降级兼容门检（`patch/sync-upstream.sh`、`patch/verify-migration-checksums.mjs`）。

   操作流程照抄 [patch/README.md](patch/README.md)。

## 架构与边界

- 桥接 CLI（`bin/zcode-sub.js` + `src/`，Node ≥ 22、零依赖）：只通过 127.0.0.1 上的 ZCode 本机任务 API（契约 v2，见 spec）与 ZCode 通信；`reply_to_parent` 由 ZCode 拉起的 `zcode-sub mcp` 直写本地信箱；`skill/zcode-sub/` 是给 Claude Code 的使用说明。
- 补丁版工具链（`patch/`，bash + 少量 Node 脚本，无服务、无长期进程）：
  - `patch/backup-zcode-data.sh` — 用户数据目录（~/.zcode）备份（SQLite 在线备份 + manifest/sha256）
  - `patch/build-desktop.sh` — mac arm64 构建（Node/pnpm 工具链自举到 `<家目录>/.cache/zcode-sub/toolchains/`，`ZCODE_TOOLCHAIN_ROOT` 可改，见 [patch/README.md](patch/README.md)「环境变量」；不动全局）
  - `patch/install-desktop.sh` / `patch/rollback-desktop.sh` — 应用目录（/Applications）安装替换与回退（用户本人运行；旧包只 mv 不删）
  - `patch/sync-upstream.sh` — fetch 上游 → `local/patched-<短SHA>` 分支 → 按 `patch/series` 净提交 cherry-pick → typecheck/lint
  - `patch/verify-migration-checksums.mjs` — 迁移账本 checksum 门检（替换安装前必跑）
  - `patch/series` — 补丁净提交清单（SHA 行 / `#` 注释 / `!` 自定义校验行）
  - `docs/` — spec 与调查报告（[索引](docs/index.md)）；`engineering-context/` — 代码事实层与上游 ZCode 的依赖声明
- 工具链边界：不在本仓修改上游 ZCode 源码（补丁提交在 ZCode fork 的 feat/local-task-api 分支上维护，经 `patch/series` 固化）；不做数据自动回滚（备份与校验有，覆盖用户数据的动作不代做）；不做 Windows/Linux 构建；不做签名与公证。

## 开发

```bash
npm test                        # node:test，假 ZCode（契约 v2）全链路
scripts/smoke-real-zcode.sh    # 真机冒烟（需 ZCode 已装补丁并完成配置）
```

文档：spec `docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`（含 v1→v2 方案变更决策记录）、coding plan `docs/plan/`、覆盖度 `docs/report/测试场景覆盖度.md`。本仓日常开发用 dw-workflow 流程（见 `AGENTS.md` 标记块）——外部贡献者不需要它，见下。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)（报 issue、跑测试、提交规范）；参与即同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[Apache-2.0](LICENSE)。`patch/` 工具链构建的上游 ZCode 本身也是 Apache-2.0（[zai-org/ZCode](https://github.com/zai-org/ZCode)）；补丁以提交清单（`patch/series`）引用，不复制上游代码。
