# zcode-sub — let Claude Code use the ZCode desktop app as a subagent

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json) [![Platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey.svg)](#prerequisites) · [中文](README.md)

Dispatch a task into an ordinary conversation in the local ZCode desktop app with one command, send follow-ups or interrupt it while it runs, let the subagent message you back, and fetch the final reply with one more command.

## Why use it

- **Spread the load off your Claude usage** — hand the heavy lifting to the model bound in ZCode (e.g. a GLM Coding Plan); Claude Code only dispatches, follows up, and reviews.
- **Visible in the GUI, and you can take over** — a dispatched task is an ordinary conversation in the ZCode window: watch progress live and keep chatting in it yourself at any point.
- **Parallel tasks** — each `run` opens a new conversation; up to 4 unfinished tasks by default (tunable).
- **Redirect mid-run** — add requirements while a task runs, or interrupt and restart it (see [Redirecting a running task](#redirecting-a-running-task)).

<!-- Screenshot: a dispatched task running in the ZCode window + a terminal showing wait output next to it; file goes to docs/assets/screenshot.png -->

## How it works

```text
Claude Code ──run/send/resume/stop──▶ ZCode local task API (127.0.0.1) ──▶ ZCode GUI conversation
Claude Code ◀──wait (event long-polling + mailbox file)────────────┘
ZCode spawns zcode-sub mcp ──reply_to_parent──▶ mailbox file (read by wait)
```

- **Local task API**: an HTTP interface the patched ZCode opens on 127.0.0.1; zcode-sub uses it to create conversations, send messages, and read events. The official ZCode build does not have it.
- **reply_to_parent / mailbox file**: the subagent inside ZCode calls the `reply_to_parent` tool over MCP (the protocol ZCode uses to call external tools) to leave a message for the parent; the message lands in a local mailbox file, which `wait` reads.
- A single CLI with zero npm dependencies (Node ≥ 22, ESM); all traffic stays on loopback.

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS arm64 | ZCode desktop and the patch toolchain are verified on mac arm64 only |
| Node ≥ 22 | the only runtime of zcode-sub |
| git, Xcode Command Line Tools | for building the patched ZCode (native dependencies get compiled) |
| Patched ZCode desktop (same machine) | includes the "local task API", based on ZCode 3.16.2; install steps below |
| Claude Code | optional — usable as a plain CLI; installing the skill gives the full subagent experience |

## Install

**Where the patch lives**: the "local task API" is a ZCode patch maintained by this repository. Its three commits live on the fork branch [weidwonder/ZCode@feat/local-task-api](https://github.com/weidwonder/ZCode/tree/feat/local-task-api) (based on upstream [zai-org/ZCode](https://github.com/zai-org/ZCode) 3.16.2; the commit list is pinned in [`patch/series`](patch/series)). Upstream does not accept external PRs; if upstream ever ships an equivalent feature, use the official build and skip self-building.

### 1. Get the code, install the CLI

```bash
git clone -b feat/local-task-api https://github.com/weidwonder/ZCode ~/src/ZCode   # patched ZCode source
git clone https://github.com/weidwonder/zcode-sub ~/src/zcode-sub
cd ~/src/zcode-sub
npm link                 # or put bin/zcode-sub.js on PATH; not published to npm
zcode-sub --version      # prints zcode-sub <version>
```

### 2. Build and install the patched ZCode

From the zcode-sub repository directory:

```bash
patch/backup-zcode-data.sh            # back up ~/.zcode; skip if you never installed ZCode (no ~/.zcode)
patch/build-desktop.sh ~/src/ZCode    # mac arm64 build, Preview identity by default
patch/install-desktop.sh ~/src/ZCode/packages/desktop/dist/mac-arm64/'ZCode Preview.app'
```

- This installs `/Applications/ZCode Preview.app`, which coexists with the official ZCode and shares its login state and task history; the official app is left untouched.
- The first build downloads the Node 24.14.0 toolchain (about 40 MB) into `~/.cache/zcode-sub/toolchains/` without touching your global Node, then installs pnpm and ZCode's dependencies.
- To follow newer upstream versions by patching them yourself, or to replace the official app in place with the production identity, see [patch/README.md](patch/README.md) (in Chinese; "流程二：上游更新" and the "production 原地替换" variant).

### 3. Connect zcode-sub to ZCode

Open "ZCode Preview", then:

```bash
zcode-sub setup
```

- The first run writes the toggle file `~/.zcode/v2/local-task-api.json` (random token, mode 0600) and says ZCode must be restarted — restart ZCode Preview, run `zcode-sub setup` again, and you are connected once it prints `✓ 本机任务 API 正常 zcodeVersion=…` ("local task API OK"; CLI output is in Chinese).
- setup ends by printing a JSON snippet; merge it into `mcp.servers` of `~/.zcode/cli/config.json` (ZCode loads it live). Without it you lose proactive subagent messages; everything else still works.

**Install into Claude Code** (optional; afterwards Claude Code uses this tool automatically per [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md)):

```bash
mkdir -p ~/.claude/skills
ln -s ~/src/zcode-sub/skill/zcode-sub ~/.claude/skills/zcode-sub    # or copy the whole directory there
```

**Environments with a redirected HOME** (e.g. an AI harness running as another OS user, `os.userInfo().homedir` being `/var/empty`): default path resolution breaks; set two environment variables explicitly — a wrapper shim is recommended:

```bash
#!/bin/bash
# zcode-sub-shim: put on PATH in place of the bare command
export ZCODE_SUB_HOME="${ZCODE_SUB_HOME:-/Users/<your-user>/.zcode-sub}"
export ZCODE_DATA_BASE_DIR="${ZCODE_DATA_BASE_DIR:-/Users/<your-user>}"
exec /path/to/zcode-sub/bin/zcode-sub.js "$@"
```

## Quick start

Precondition: ZCode Preview is open and `zcode-sub setup` reports the local task API as OK.

```bash
# 1) Dispatch a task — opens a new ZCode conversation in that workspace; one JSON line on stdout
zcode-sub run "Refactor error handling in src/api.js and add tests" --cwd ~/projects/demo --name refactor
# {"name":"refactor","taskId":"session_xxxx","status":"dispatched","workspacePath":"/Users/you/projects/demo","clientRequestId":"..."}

# 2) Wait for events (run in the background; on timeout it prints TIMEOUT, exit code 2 — just wait again)
zcode-sub wait refactor
# [turn.started] …
# [reply] proactive message from the subagent
# [turn.completed] Refactor done: …

# 3) Fetch the final reply
zcode-sub result refactor
# 状态：idle            (Status: idle)
# ----- 最后回复 -----   (----- Final reply -----)
# <full final reply>
```

No need to open the workspace in ZCode beforehand: if the `--cwd` directory is not open, ZCode adds a tab for it in the current window automatically (no confirmation dialog, up to 30 seconds); failures surface as exit code 3.

## Commands

| Command | What it does |
|---|---|
| `zcode-sub setup [--api-port …]` | Write/read the toggle file, health-check, print the MCP config snippet |
| `zcode-sub run "<task>" --cwd <abs path> [--name <name>] [--mode <mode>] [--model <providerId/modelId>] [--thought <level>]` | Open a new ZCode conversation for the task; default `mode=yolo` (GUI "full access", no permission prompts for the subagent — risks in [Security boundary](#security-boundary)); one JSON line on stdout (name/taskId) |
| `zcode-sub send <name> "<message>" [--steer\|--queue\|--interrupt]` | Follow-up message; the three flags are mutually exclusive, see [Redirecting a running task](#redirecting-a-running-task); on an idle task it simply continues the conversation |
| `zcode-sub wait <name> [--timeout seconds]` | Block for new events / proactive subagent messages (default 600 s; on timeout prints TIMEOUT, exit code 2) |
| `zcode-sub result <name>` | Full last reply + status; says so clearly if still running |
| `zcode-sub resume <name> "<more text>"` | Continue an idle task's conversation (use send while running) |
| `zcode-sub stop <name>` | Stop generation |
| `zcode-sub list [--json]` | Local task table (name/taskId/status) |
| `zcode-sub models --cwd <abs path> [--json]` | List available models (providerId/modelId/thought levels/default level/default flag) |
| `zcode-sub model <name> <providerId/modelId> [--thought <level>]` | Switch model for a dispatched task (takes effect next turn) |
| `zcode-sub mcp` | stdio MCP server (`reply_to_parent`), spawned by ZCode |
| `zcode-sub --version` | Print the version |

- **Per-model dispatch/switching**: check values first with `zcode-sub models` (same `--cwd` as run); `run --model <providerId/modelId> [--thought <level>]` picks at dispatch (config `defaultModel` as fallback; omit to use the ZCode default), `zcode-sub model <name> …` switches a dispatched task (next turn; allowed while running). Invalid values fail local pre-validation with `zcode_model_invalid` (exit 1) listing valid options. **Without --thought the default level is chosen automatically** (max first; else the model's defaultThoughtLevel; else the last listed), and the effective level is printed to stderr.
- The 11-value `--mode` enum is listed in `zcode-sub --help`.
- Unknown arguments are reported as usage errors per command (exit 1, never silently ignored).

## Redirecting a running task

There are two ways to change course while a task is running:

```bash
# Steer: inject the message into the current turn at the end of the current step, keeping context;
# it lands late (may take a while during long text generation)
zcode-sub send refactor "Also switch logging to structured output" --steer
# ✓ 投递结果：steered（commandId=…）            (delivery: steered)
# ℹ steered 仅为受理引导；注入结果以事件流为准…   (steered only means accepted; watch the event stream)
```

`wait` then shows `[input.steered]` (your steer was accepted), followed by `[steer.injected]` (injected into the current turn); if it was downgraded or rejected you get `[steer.fellBack] …` — queue or resend as the message says.

```bash
# Interrupt: stop the current generation now, wait for the task to go idle, then send the message
# as a new turn; unfinished output is discarded
zcode-sub send refactor "Stop — only touch api.js, leave the tests alone" --interrupt
# ✓ 已请求停止；等待任务回到空闲…   (stop requested; waiting for idle…)
# ✓ 已截断当前生成，未完成内容丢弃   (generation truncated, unfinished output discarded)
# ✓ 投递结果：sent                  (delivery: sent)
```

`--interrupt` waits for idle for at most `ZCODE_SUB_INTERRUPT_TIMEOUT_MS` (default 15 s); past it the message is not sent and the exit code is 4. It is mutually exclusive with `--steer`/`--queue`. Without a flag, where a mid-run message goes is decided by the ZCode conversation settings (the GUI default is to queue); `--queue` forces queueing.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | success | — |
| `1` | usage error: unknown args, not configured, no such local task, EACCES, invalid workspace path, rejected model selection | fix per the reason in the error; list valid models with `zcode-sub models --cwd <abs path>`; if not configured, run `zcode-sub setup` first |
| `2` | cannot reach the local task API, or `wait` timed out (prints TIMEOUT) | after a wait timeout just wait again; if unreachable, make sure ZCode is open and check `zcode-sub setup`'s health check |
| `3` | workspace problem: not open, remote workspace, auto-open timed out, ZCode refuses to open | retry directly after a timeout; when refused (e.g. a forced update is pending) deal with the ZCode window first; otherwise open the directory in ZCode manually |
| `4` | a task-by-id request failed (including the task being deleted in the GUI), `resume` rejected while running, or the `--interrupt` wait timed out | check the status with `zcode-sub result <name>`; use `send` for mid-run follow-ups |
| `5` | token/Host validation failed | rerun `zcode-sub setup` (when the toggle file exists its token wins and is written back to `~/.zcode-sub/config.json`); restart ZCode first if you edited the toggle file |
| `7` | invalid or duplicate task name (names match `[A-Za-z0-9._-]+` only) | pick another name |
| `8` | unfinished-task limit reached (default 4) | wait for running tasks to finish, or raise `ZCODE_SUB_MAX_RUNNING` |

The full closed set of error codes and event types lives in spec §3 ([docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md](docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md), in Chinese).

## Configuration

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `ZCODE_SUB_HOME` | `~/.zcode-sub` | State directory (task shards + mailbox); must be set explicitly when HOME is redirected |
| `ZCODE_DATA_BASE_DIR` | real user home | Base dir of ZCode data (toggle file at `<dir>/.zcode/v2/local-task-api.json`) |
| `ZCODE_SUB_MAX_RUNNING` | `4` | Max unfinished tasks (best effort — a burst of concurrent runs may briefly exceed it) |
| `ZCODE_SUB_INTERRUPT_TIMEOUT_MS` | `15000` | How long `send --interrupt` waits for the task to go idle; past it the message is not sent (exit 4) |
| `ZCODE_SUB_DEBUG` | off | `=1` appends API request/response summaries to `~/.zcode-sub/debug.log` (no tokens, no task text) |

`~/.zcode-sub/config.json` (created by setup, 0600): `apiPort` (default 47821), `token` (auth), `defaultMode` (optional, default dispatch mode for run, same 11-value enum as `--mode`), `defaultModel` (optional, same shape as `--model/--thought`, e.g. `{"providerId":"…","modelId":"…","options":{"reasoningLevel":"…"}}`).

## Limitations

- **macOS arm64 only**: no Windows/Linux builds.
- **Requires the patched ZCode**: the official ZCode has no local task API, so zcode-sub cannot connect (exit code 2).
- **Permission approval happens only in the ZCode GUI**: zcode-sub never approves permissions via the API; a `permission.requested` event from `wait` just tells you to handle it in the GUI.
- **No remote workspaces**: `--cwd` must be an existing local directory; remote workspaces are reported with exit code 3 and are not opened automatically.
- **Toggle-file changes need a ZCode restart**: including the first setup write and manual port changes.
- **Default `mode=yolo` (full access)**: the subagent acts in the workspace and terminal without confirmation; risks and how to change it are in [Security boundary](#security-boundary).
- Risks of the patched build itself (forced-update gate, signing, data loss on downgrade, …) are listed under "已知风险与限制" in [patch/README.md](patch/README.md) (in Chinese).

## Security boundary

- **Loopback only**: all API traffic goes to 127.0.0.1; the ZCode side listens only when the toggle file exists with `enabled:true`. No external listening, no remote ZCode.
- **Token auth**: the random token (≥32 chars) from the toggle file is checked as a Bearer header; the file is written atomically with mode 0600; token/Host validation failures are rejected with exit code 5.
- **What default yolo means and its risk**: `run` defaults to `mode=yolo` (GUI "full access") — the dispatched subagent **gets no permission prompts**, and what it can do in the workspace and terminal depends on the permissions of the ZCode logged-in account. If that is not acceptable, pass `--mode` per run or set config `defaultMode` to a conservative level (11-value enum in `zcode-sub --help`). This tool never approves permissions via the API: a `permission.requested` event just tells you to handle it in the ZCode GUI.
- **Auditable side effects**: task creation and messages carry a `clientRequestId` idempotency key (same key returns the first response); on network failure the same key is safely retried once. The tool writes no other ZCode data files; the toggle file is written only by an explicit setup (an existing file always wins).

## Issues and feedback

- Bugs and feature requests: [GitHub Issues](https://github.com/weidwonder/zcode-sub/issues) (the bug template asks for your ZCode version, `zcode-sub --version`, and `zcode-sub setup` output).
- Do not file security issues publicly; report them privately per [SECURITY.md](SECURITY.md).
- Problems with ZCode itself belong upstream at [zai-org/ZCode](https://github.com/zai-org/ZCode).

## Requirements

1. **ZCode as a Claude Code subagent** (`bin/`, `src/`, `skill/`): task dispatch, mid-run follow-ups, proactive subagent-to-parent replies, final-reply delivery, task continuation, parallel tasks, tasks visible in the ZCode GUI (see [Commands](#commands) and [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md)).
2. The patch toolchain (`patch/`) answers four operational questions (findings and evidence in [docs/report/zcode-patched-build-compat.md](docs/report/zcode-patched-build-compat.md), in Chinese):
   1. **Data preservation**: how to fully back up and restore the user's login state, task history, skills and config before replacing/downgrading ZCode (`patch/backup-zcode-data.sh`).
   2. **Patched builds**: how to build an installable mac package from open source + local patches, and which identity to pick (Preview coexistence vs production in-place, default Preview) (`patch/build-desktop.sh`).
   3. **Install & rollback**: how to replace/coexist/roll back the app in `/Applications` without ever losing the old bundle (`patch/install-desktop.sh`, `patch/rollback-desktop.sh` — run directly by the user in a terminal).
   4. **Upstream tracking**: how to follow upstream snapshot syncs cheaply and pass the downgrade-compatibility gate first (`patch/sync-upstream.sh`, `patch/verify-migration-checksums.mjs`).

   Follow [patch/README.md](patch/README.md) (in Chinese) for the walkthrough.

## Architecture & boundaries

- Bridge CLI (`bin/zcode-sub.js` + `src/`, Node ≥ 22, zero dependencies): talks to ZCode exclusively through the local task API on 127.0.0.1 (contract v2, see the spec); `reply_to_parent` is written by the ZCode-spawned `zcode-sub mcp` directly into a local mailbox; `skill/zcode-sub/` is the Claude Code-facing usage guide.
- Patch toolchain (`patch/`, bash + a few Node scripts, no services, no long-running processes):
  - `patch/backup-zcode-data.sh` — backs up the user data dir (~/.zcode) (online SQLite backup + manifest/sha256)
  - `patch/build-desktop.sh` — mac arm64 build (Node/pnpm toolchain bootstrapped into `<home>/.cache/zcode-sub/toolchains/`, override with `ZCODE_TOOLCHAIN_ROOT`, see the environment-variables section of [patch/README.md](patch/README.md) (in Chinese); global untouched)
  - `patch/install-desktop.sh` / `patch/rollback-desktop.sh` — install/replace and roll back the app bundle in /Applications (run by the user; old bundles are moved, never deleted)
  - `patch/sync-upstream.sh` — fetch upstream → `local/patched-<shortSHA>` branch → cherry-pick the clean commits from `patch/series` → typecheck/lint
  - `patch/verify-migration-checksums.mjs` — migration-ledger checksum gate (run before every replace-install)
  - `patch/series` — the clean patch commit list (SHA lines / `#` comments / `!` custom validation lines)
  - `docs/` — specs and investigation reports ([index](docs/index.md), in Chinese); `engineering-context/` — code-facts layer and upstream ZCode dependency notes
- Toolchain boundaries: upstream ZCode source is never modified in this repo (the patch commits are maintained on the feat/local-task-api branch of the ZCode fork, pinned via `patch/series`); no automatic data rollback (backups and verification exist; actions that overwrite user data are never taken on your behalf); no Windows/Linux builds; no signing or notarization.

## Development

```bash
npm test                        # node:test, full chain against a fake ZCode (contract v2)
scripts/smoke-real-zcode.sh    # real-machine smoke test (needs a patched, configured ZCode)
```

Docs: spec `docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md` (includes the v1→v2 decision record, in Chinese), coding plans under `docs/plan/`, coverage report `docs/report/测试场景覆盖度.md`. Day-to-day development in this repo uses the dw-workflow process (see the marker block in `AGENTS.md`) — external contributors do not need it; see below.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (filing issues, running tests, commit conventions); by participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). The upstream ZCode built by the `patch/` toolchain is itself Apache-2.0 ([zai-org/ZCode](https://github.com/zai-org/ZCode)); patches are referenced as a commit list (`patch/series`), not as copied code.
