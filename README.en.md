# zcode-sub

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json) [![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](README.en.md#prerequisites) · [中文](README.md)

Use the **ZCode desktop app as a Claude Code subagent**: dispatch a task into a regular ZCode conversation with one command, send follow-ups or interrupts while it runs, let the subagent message you back proactively, and fetch the final reply with one command. Each task is an **ordinary conversation** in the ZCode GUI — visible in real time, parallelizable, and humans can take over at any point.

```
Claude Code ──run/send/resume/stop──▶ ZCode local task API (127.0.0.1, contract v2) ──▶ ZCode GUI conversation
Claude Code ◀──wait (event long-polling + mailbox)──────────────────────────────────┘
ZCode spawns zcode-sub mcp ──reply_to_parent──▶ mailbox file (read by wait)
```

- **GUI-visible** — a dispatched task is not a black box: watch progress in the ZCode window and take over by simply typing in the same conversation.
- **Parallel tasks** — each `run` opens a new conversation; up to 4 unfinished tasks by default (tunable).
- **Steering mid-run** — `send --steer` (native steering, injected at the end of the current step), `send --interrupt` (truncate and resend), `resume` for idle tasks.
- **Proactive replies** — the subagent messages the parent via the `reply_to_parent` MCP tool; `wait` picks those up alongside events.
- A single CLI with zero runtime dependencies (Node ≥ 22, ESM); all traffic stays on loopback.

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS | ZCode desktop and the patch toolchain are verified on mac (arm64) |
| Node ≥ 22 | the only runtime of the bridge CLI (zero npm dependencies) |
| ZCode desktop (same machine) | must include the "local task API" (contract v2) — see below |
| Claude Code | optional — usable as a plain CLI; installing the skill gives the full subagent experience |

The **"local task API" on the ZCode side** is a patch this repository maintains (three clean commits, pinned in [`patch/series`](patch/series)) intended for upstream [zai-org/ZCode](https://github.com/zai-org/ZCode). Two paths:

- **After upstream merges it**: official ZCode desktop builds work as-is — no self-build needed.
- **Today (not merged yet)**: build a patched ZCode from source with the [`patch/`](patch/README.md) toolchain — data backup, build, side-by-side install, and upstream tracking are all scripted:

```bash
patch/backup-zcode-data.sh                 # back up ~/.zcode (mandatory before replacing an install)
patch/build-desktop.sh <ZCode source dir>  # mac arm64 build; Preview identity by default, coexists with the official app
patch/install-desktop.sh <built .app>      # install (old bundles are moved aside, never deleted)
```

## Install

```bash
git clone https://github.com/weidwonder/zcode-sub
cd zcode-sub
npm link                 # or put bin/zcode-sub.js on PATH; not published to npm
zcode-sub --version      # sanity check
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

Precondition: the ZCode desktop app is running.

```bash
# 1) One-time setup — create/read the toggle file ~/.zcode/v2/local-task-api.json
#    (token written 0600; ZCode must be restarted for it to take effect), health-check
#    the API, and print the JSON snippet for wiring zcode-sub mcp into ZCode
#    (put it into mcp.servers of ~/.zcode/cli/config.json; without it you lose
#    proactive subagent replies, everything else still works)
zcode-sub setup

# 2) Dispatch a task — opens a new ZCode conversation in that workspace; one JSON line on stdout
zcode-sub run "Refactor error handling in src/api.js and add tests" --cwd ~/projects/demo --name refactor
# {"name":"refactor","taskId":"session_xxxx","status":"dispatched","workspacePath":"/Users/you/projects/demo","clientRequestId":"..."}

# 3) Wait for events (run in the background; on timeout it prints TIMEOUT, exit code 2 — just wait again)
zcode-sub wait refactor
# [turn.started] …
# [reply] proactive message from the subagent
# [turn.completed] Refactor done: …

# 4) Fetch the final reply
zcode-sub result refactor
# Status: idle
# ----- Final reply -----
# <full final reply>
```

No need to open the workspace in ZCode beforehand: if the `--cwd` directory is not open, ZCode adds a tab for it in the current window automatically (no confirmation dialog, up to 30 seconds); failures surface as exit code 3.

**Install into Claude Code** (optional; afterwards Claude Code uses this tool automatically per [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md)):

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skill/zcode-sub" ~/.claude/skills/zcode-sub    # or copy the whole directory there
```

## Commands

| Command | What it does |
|---|---|
| `zcode-sub setup [--api-port …]` | Write/read the toggle file, health-check, print the MCP config snippet |
| `zcode-sub run "<task>" --cwd <abs path> [--name <name>] [--mode <mode>] [--model <providerId/modelId>] [--thought <level>]` | Open a new ZCode conversation for the task; default mode=yolo (full access, no permission prompts for the subagent); one JSON line on stdout (name/taskId) |
| `zcode-sub send <name> "<message>" [--steer\|--queue\|--interrupt]` | Follow-up message: default auto (running = GUI default queue/steer); `--steer` = native ZCode steering (injected at the end of the current step; may wait long during text generation; the ack is only acceptance — the outcome arrives as `steer.injected` / `steer.fellBack` events); `--interrupt` = truncate the current generation (stop → wait for idle → resend as a new turn, unfinished output discarded); idle task = plain continuation |
| `zcode-sub wait <name> [--timeout seconds]` | Block for new events / proactive subagent messages (default 600 s; on timeout prints TIMEOUT, exit code 2) |
| `zcode-sub result <name>` | Full last reply + status; says so clearly if still running |
| `zcode-sub resume <name> "<more text>"` | Continue an idle task's conversation (use send while running) |
| `zcode-sub stop <name>` | Stop generation |
| `zcode-sub list [--json]` | Local task table (name/taskId/status) |
| `zcode-sub models --cwd <abs path> [--json]` | List available models (providerId/modelId/thought levels/default level/default flag) |
| `zcode-sub model <name> <providerId/modelId> [--thought <level>]` | Switch model for a dispatched task (takes effect next turn) |
| `zcode-sub mcp` | stdio MCP server (`reply_to_parent`), spawned by ZCode |

- **Per-model dispatch/switching**: check values first with `zcode-sub models` (same `--cwd` as run); `run --model <providerId/modelId> [--thought <level>]` picks at dispatch (config `defaultModel` as fallback; omit to use the ZCode default), `zcode-sub model <name> …` switches a dispatched task (next turn; allowed while running). Invalid values fail local pre-validation with `zcode_model_invalid` (exit 1) listing valid options. **Without --thought the default level is chosen automatically** (max first; else the model's defaultThoughtLevel; else the last listed), and the effective level is printed to stderr.
- **Two steering tools**: `--steer` injects later but preserves context; `--interrupt` truncates immediately (unfinished output discarded), mutually exclusive with `--steer`/`--queue`, bounded by `ZCODE_SUB_INTERRUPT_TIMEOUT_MS` (default 15 s; past it the message is not sent, exit 4).

**Exit codes**: `1` usage error (unknown args, not configured, no such local task, EACCES, invalid workspace path, rejected model selection — the error carries the reason; check options with `zcode-sub models --cwd <abs path>`); `2` cannot reach the local task API or wait timeout; `3` workspace problem (not open / remote; auto-open timeout can be retried directly; when ZCode refuses to open, deal with the ZCode window first); `4` task-by-id request failed (including task deleted) or resume-while-running rejected; `5` token/Host validation failed; `7` invalid or duplicate task name (names match `[A-Za-z0-9._-]+` only); `8` unfinished-task limit reached (default 4). The full closed set of error codes and event types lives in spec §3 (`docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md`, in Chinese).

Also: unknown arguments are reported as usage errors per-command (exit 1, never silently ignored).

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

## Security boundary

- **Loopback only**: all API traffic goes to 127.0.0.1; the ZCode side listens only when the toggle file exists with `enabled:true`. No external listening, no remote ZCode.
- **Token auth**: the random token (≥32 chars) from the toggle file is checked as a Bearer header; the file is written atomically with mode 0600; token/Host validation failures are rejected with exit code 5.
- **What default yolo means and its risk**: `run` defaults to `mode=yolo` (GUI "full access") — the dispatched subagent **gets no permission prompts**, and what it can do in the workspace and terminal depends on the permissions of the ZCode logged-in account. If that is not acceptable, pass `--mode` per run or set config `defaultMode` to a conservative level (11-value enum in `zcode-sub --help`). This tool never approves permissions via the API: a `permission.requested` event just tells you to handle it in the ZCode GUI.
- **Auditable side effects**: task creation and messages carry a `clientRequestId` idempotency key (same key returns the first response); on network failure the same key is safely retried once. The tool writes no other ZCode data files; the toggle file is written only by an explicit setup (an existing file always wins).

## Requirements

1. **ZCode as a Claude Code subagent** (`bin/`, `src/`, `skill/`): task dispatch, mid-run follow-ups, proactive subagent-to-parent replies, final-reply delivery, task continuation, parallel tasks, tasks visible in the ZCode GUI (see [Commands](#commands) and [skill/zcode-sub/SKILL.md](skill/zcode-sub/SKILL.md)).
2. The patch toolchain (`patch/`) answers four operational questions (findings and evidence in [docs/report/zcode-patched-build-compat.md](docs/report/zcode-patched-build-compat.md), in Chinese):
   1. **Data preservation**: how to fully back up and restore the user's login state, task history, skills and config before replacing/downgrading ZCode (`patch/backup-zcode-data.sh`).
   2. **Patched builds**: how to build an installable mac package from open source + local patches, and which identity to pick (Preview coexistence vs production in-place, default Preview) (`patch/build-desktop.sh`).
   3. **Install & rollback**: how to replace/coexist/roll back the app in `/Applications` without ever losing the old bundle (`patch/install-desktop.sh`, `patch/rollback-desktop.sh` — run directly by the user in a terminal).
   4. **Upstream tracking**: how to follow upstream snapshot syncs cheaply and pass the downgrade-compatibility gate first (`patch/sync-upstream.sh`, `patch/verify-migration-checksums.mjs`).

   Follow [patch/README.md](patch/README.md) (in Chinese) for the walkthrough.

## Architecture & boundaries

- Bridge CLI (`bin/zcode-sub.js` + `src/`, Node ≥ 22, zero dependencies): talks to ZCode exclusively through the local task API on 127.0.0.1; `reply_to_parent` is written by the ZCode-spawned `zcode-sub mcp` directly into a local mailbox; `skill/zcode-sub/` is the Claude Code-facing usage guide.
- Patch toolchain (`patch/`, bash + a few Node scripts, no services, no long-running processes):
  - `patch/backup-zcode-data.sh` — backs up the user data dir (~/.zcode) (online SQLite backup + manifest/sha256)
  - `patch/build-desktop.sh` — mac arm64 build (Node/pnpm toolchain bootstrapped into `.toolchains/`, global untouched)
  - `patch/install-desktop.sh` / `patch/rollback-desktop.sh` — install/replace and roll back the app bundle in /Applications (run by the user; old bundles are moved, never deleted)
  - `patch/sync-upstream.sh` — fetch upstream → `local/patched-<shortSHA>` branch → cherry-pick the clean commits from `patch/series` → typecheck/lint
  - `patch/verify-migration-checksums.mjs` — migration-ledger checksum gate (run before every replace-install)
  - `patch/series` — the clean patch commit list (SHA lines / `#` comments / `!` custom validation lines)
  - `docs/` — specs and investigation reports ([index](docs/index.md), in Chinese); `engineering-context/` — code-facts layer and upstream ZCode dependency notes
- Toolchain boundaries: upstream ZCode source is never modified in this repo (patch commits live on branches of the ZCode repo, pinned via `patch/series`); no automatic data rollback (backups and verification exist; actions that overwrite user data are never taken on your behalf); no Windows/Linux builds; no signing or notarization.

## Development

```bash
npm test                        # node:test, full chain against a fake ZCode (contract v2)
scripts/smoke-real-zcode.sh    # real-machine smoke test (needs a patched, configured ZCode)
```

Docs: spec `docs/spec/2026-10-27-zcode-sub-bridge-eng-spec.md` (includes the v1→v2 decision record, in Chinese), coding plans under `docs/plan/`, coverage report `docs/report/测试场景覆盖度.md`. Day-to-day development in this repo uses the dw-workflow process (see the marker block in `AGENTS.md`) — external contributors do not need it; see below.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (filing issues, running tests, commit conventions).

## License

[Apache-2.0](LICENSE). The upstream ZCode built by the `patch/` toolchain is itself Apache-2.0 ([zai-org/ZCode](https://github.com/zai-org/ZCode)); patches are referenced as a commit list (`patch/series`), not as copied code.
