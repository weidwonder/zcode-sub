# 安全策略 / Security Policy

[中文](#中文) · [English](#english)

## 中文

### 私下报告

请**不要**在公开 issue 里报告安全问题。到本仓库的 [Security 页](https://github.com/weidwonder/zcode-sub/security) 点「Report a vulnerability」，走 GitHub 的 private vulnerability reporting 私下提交。

报告里请写清：受影响的命令或脚本、复现步骤、影响（能读到/改到什么），以及 `zcode-sub --version` 与 ZCode 版本。附日志或 `zcode-sub setup` 输出前请先打码 token。

修复在 `main` 分支的最新版本上进行。

### 范围

- **token 处理**：开关文件 `~/.zcode/v2/local-task-api.json` 与 `~/.zcode-sub/config.json` 里的 token 的生成、存储与传输，以及日志、报错、终端输出是否泄露 token。
- **本机回环 API**：zcode-sub 对 127.0.0.1 上本机任务 API 的调用与鉴权（Bearer token、Host 校验），以及本仓补丁（[`patch/series`](patch/series) 列出的提交）中该 API 的监听与校验逻辑。
- **开关文件与状态文件权限**：setup 写入的文件是否保持 0600、是否原子写入，状态目录 `~/.zcode-sub` 里的任务分片与信箱文件。
- **默认 `mode=yolo`**：派发任务默认以完全访问模式运行，子代理不经权限确认即可在工作区与终端里动手（说明见 README「安全边界」）。绕过 `--mode` / `defaultMode` 设置、或让 yolo 的作用范围超出所派任务的问题在范围内。

### 不在范围

- ZCode 桌面版本身（本仓补丁之外的代码）的问题，请报告给上游 [zai-org/ZCode](https://github.com/zai-org/ZCode)。
- 在 yolo 模式下，子代理按任务指令在工作区内执行操作——这是该模式的设计行为。
- 需要先取得本机用户账号权限才能实施的攻击（如已能读写该用户的家目录）。

## English

### Reporting privately

Please do **not** report security issues in public issues. Go to this repository's [Security tab](https://github.com/weidwonder/zcode-sub/security), click "Report a vulnerability", and submit privately via GitHub private vulnerability reporting.

Include the affected command or script, reproduction steps, the impact (what can be read or changed), plus `zcode-sub --version` and your ZCode version. Redact tokens before attaching logs or `zcode-sub setup` output.

Fixes are made against the latest version on the `main` branch.

### In scope

- **Token handling**: generation, storage and transport of the token in the toggle file `~/.zcode/v2/local-task-api.json` and in `~/.zcode-sub/config.json`, and any token leakage through logs, errors or terminal output.
- **Loopback API**: zcode-sub's calls to and authentication against the local task API on 127.0.0.1 (Bearer token, Host check), and the listening and validation logic of that API in this repository's patch (the commits listed in [`patch/series`](patch/series)).
- **Toggle-file and state-file permissions**: whether files written by setup stay 0600 and are written atomically, and the task shards and mailbox files in the state directory `~/.zcode-sub`.
- **Default `mode=yolo`**: dispatched tasks run in full-access mode by default, so the subagent acts in the workspace and terminal without permission prompts (see "Security boundary" in the README). Issues that bypass the `--mode` / `defaultMode` settings, or that extend yolo beyond the dispatched task, are in scope.

### Out of scope

- Problems in the ZCode desktop app itself (code outside this repository's patch) — report them upstream at [zai-org/ZCode](https://github.com/zai-org/ZCode).
- A subagent in yolo mode carrying out its task instructions inside the workspace — that is the designed behavior of the mode.
- Attacks that require already holding the local user's account privileges (e.g. existing read/write access to that user's home directory).
