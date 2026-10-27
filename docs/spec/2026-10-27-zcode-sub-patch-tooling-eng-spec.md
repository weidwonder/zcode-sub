---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-27'
authority_refs:
  - 'patch/*.sh 五个脚本的 CLI 接口（参数、--dry-run、退出码约定）'
  - 'patch/backup-zcode-data.sh 的备份范围与 manifest 格式（zcode-backups/<ts>/manifest.json）'
  - 'docs/report/zcode-patched-build-compat.md 的降级兼容性结论（安全，附证据）'
---

# zcode-sub_技术 Spec — ZCode 补丁版工具链（构建 / 安装替换 / 数据保全 / 跟随上游）

> 单仓库的详细技术规范。遵循 `spec写作纪律.md`：零上下文可动手、RFC2119、无占位符。
> 本文按 RFC 2119 解释 MUST / MUST NOT / SHOULD / MAY。
> 调查结论（构建身份、强更门、降级兼容、凭据保留）的完整证据在 `docs/report/zcode-patched-build-compat.md`，本文只引用结论不重复论证。

## 0. 阅读导引（MUST，前置）

- **一句话目的**：让用户能用开源 ZCode 源码（3.16.2）+ 本地补丁构建桌面版，安全地替换/并存于正式版（3.16.3），登录态与任务历史不丢，且上游每次发版都能低成本跟上。
- **端到端场景**：
  1. 用户首次替换：`patch/backup-zcode-data.sh`（保全数据）→ `patch/build-desktop.sh /Users/weidwonder/projects/ZCode`（构建补丁版）→ `patch/install-desktop.sh <产物>`（替换/并存）→ 打开 ZCode 验证登录态与历史任务。
  2. 上游发新版（如 3.16.4）：`patch/sync-upstream.sh /Users/weidwonder/projects/ZCode`（fetch → 重建补丁分支 → cherry-pick 补丁提交 → 冲突即停并打印文件清单 → typecheck/lint）→ 通过后重跑 build/install。
  3. 补丁版有问题要回退：`patch/rollback-desktop.sh`（从 `zcode-backups/apps/` 恢复上一份正式版 .app）；数据层回滚按 `patch/README.md` 的手动步骤用备份目录恢复。
  4. 构建期身份选错（连了测试后端）：`build-desktop.sh` 默认 `ZCODE_ENV=production`，不设该值时脚本 MUST 报错中止，不允许产出测试后端包冒充正式包。
- **核心流程图**：
  ```mermaid
  flowchart TD
    A[backup-zcode-data.sh] --> B[build-desktop.sh]
    B --> B1{--identity}
    B1|preview 默认| B2[ZCODE_PREVIEW_IDENTITY=1<br/>ZCode Preview.app 并存]
    B1|production| B3[原地替换 /Applications/ZCode.app]
    B2 --> C[install-desktop.sh]
    B3 --> C
    C --> D[运行验证]
    D -->|有问题| E[rollback-desktop.sh]
    E --> D2[恢复正式版]
    U[上游 sync 新版] --> F[sync-upstream.sh]
    F -->|冲突| F1[停止+打印冲突文件]
    F -->|通过| B
  ```
- **决策表**：
  | 输入 / 状态 | 条件 | 走向 / 处置 | 结果 |
  |---|---|---|---|
  | build `--identity preview`（默认） | `ZCODE_ENV=production` + `ZCODE_PREVIEW_IDENTITY=1` | 产物 `ZCode Preview.app`，与正式版并存 | 强更门/自动更新天然跳过；登录态共享 |
  | build `--identity production` | `ZCODE_ENV=production` | 产物 `ZCode.app`，原地替换 | 强更门暴露：服务端下发 minimalVersion>3.16.2 时启动被拦 |
  | install 时 ZCode 在运行 | `pgrep` 命中 | 打印进程并退出码 3，不杀进程 | 用户手动退出后重跑 |
  | sync 时 cherry-pick 冲突 | `git cherry-pick` 非零 | 停止，打印 `git diff --diff-filter=U` 文件清单 | 现场（分支+冲突标记）保留给人工处置 |
  | 本座位/无权限环境跑脚本 | 任意写操作 EACCES | 明确报错并提示 `dwc grant <目录>` | 不绕过权限 |

## 1. 范围

- 本仓库（zcode-sub）做什么：`patch/` 下五个 bash 脚本 + `patch/README.md` + 调查报告 `docs/report/zcode-patched-build-compat.md`。
- **不做什么**：
  - 不修改 ZCode 源码仓库的任何文件（含 `/Users/weidwonder/projects/ZCode` 主工作树与其 worktree）——补丁本身由另一子任务开发。
  - 不做数据自动回滚（覆盖用户 `~/.zcode` 是高风险动作，README 提供手动步骤，脚本不代做）。
  - 不做 Windows / Linux 构建（产物只面向 mac arm64；bundle.mjs 本身支持其它目标，本工具链不暴露）。
  - 不做签名与公证（开源构建链路 `identity: null`；install 脚本仅提供可选 ad-hoc 重签）。
  - 不改全局 Node/pnpm（Node 24.14.0 以解压目录方式放 `/Users/weidwonder/projects/.toolchains/`）。
- 依赖的上游 / 被依赖的下游：
  - 上游 ZCode 源码（github.com/zai-org/ZCode，本地 `/Users/weidwonder/projects/ZCode` 只读），版本要求 Node 24.14.0 + pnpm 10.33.2（`mise.toml:3-4`），打包入口 `pnpm bundle:desktop`（`package.json:55`），身份解析 `packages/desktop/scripts/desktop-product-identity.mjs:59-68`，mac 签名默认关（`packages/desktop/electron-builder.config.js:833` identity null）。依赖声明见 `engineering-context/dependencies/ZCode.md`。
  - 上游 `feat/local-bot-webhook` 分支（`/Users/weidwonder/projects/ZCode/.worktrees/local-bot-webhook`）：`sync-upstream.sh` 的补丁提交来源；`chore(local-dw):` 前缀提交是本地专用，MUST 排除。
  - 下游：本工具链产出的 `.app` 交给用户在真机安装；本座位不执行安装。
- **既有系统清单**：

| 既有模块 / 机制 | 从哪知道它的 | 本次可能怎么碰到 | 卡片补了吗 |
|---|---|---|---|
| ZCode 桌面构建身份（production/preview 双轴） | `packages/desktop/scripts/desktop-product-identity.mjs:59-68` | build-desktop.sh 设环境变量选身份 | 本次新补 `cards/zcode/构建身份与打包.md` |
| 强制升级门 maybeBlockStartupForForceUpdate | `packages/desktop/src/main/index.ts:2521-2532` | production 产物受其约束，报告评估 | 本次新补 `cards/zcode/更新与强制升级.md` |
| SQLite 迁移账本（schema_migration / tasks_schema_migration / project-storage schema_migration） | `packages/shared/src/sqlite-migrations/runner.ts:62-100` | 备份脚本在线备份这些库；报告结论 | 本次新补 `cards/zcode/数据目录与迁移.md` |
| 凭据加密 credentialCipherProvider（本地派生密钥，与签名无关） | `packages/services/src/credential/providers/credentialCipherProvider.ts:24-38` | 报告论证登录态保留 | 本次新补 `cards/zcode/凭据与登录态.md` |
| pnpm workspace 构建（install → prepare:runtime-assets → build → electron-builder） | `packages/desktop/scripts/bundle.mjs:700-745` | build-desktop.sh 编排调用 | 本次新补 `cards/zcode/构建身份与打包.md` |
| `~/.zcode` 用户数据布局 | `packages/services/src/paths.ts:45-58` | backup 脚本的范围依据 | 本次新补 `cards/zcode/数据目录与迁移.md` |

### 1.1 功能需求（MUST 编号）

| 编号 | 需求 |
|---|---|
| FR-001 | `patch/backup-zcode-data.sh <备份目录>`：对 `~/.zcode` 下所有 SQLite 库用 `sqlite3 <db> ".backup <dst>"` 在线备份（含 WAL 状态），复制其余配置/数据文件（范围见 §4.1），生成 `manifest.json`（路径、字节数、sha256）与 `sha256sums.txt`；不修改源数据；可重复执行（目标已存在则中止并提示）；支持 `--dry-run`。 |
| FR-002 | `patch/build-desktop.sh <ZCode源码目录>`：确保 Node 24.14.0（下载解压到 `/Users/weidwonder/projects/.toolchains/node-v24.14.0`，已存在直接用；不改全局）、pnpm 10.33.2 可用；`pnpm install`（幂等）；以 `ZCODE_ENV=production`、`ZCODE_AUTO_UPDATE=0`、按 `--identity preview|production`（默认 preview）设定身份变量；执行 `pnpm bundle:desktop`（mac arm64）；结束时打印产物路径（.app unpacked 目录与 .dmg/.zip）。支持 `--dry-run`（只打印将执行的命令不执行）与 `--skip-install`。 |
| FR-003 | `patch/install-desktop.sh <产物 .app 或 .dmg>`：从产物 Info.plist 读 CFBundleIdentifier/CFBundleName 决定安装目标（`dev.zcode.app` → `/Applications/ZCode.app`；`dev.zcode.app.preview` → `/Applications/ZCode Preview.app`）；检测目标 app 是否在运行（pgrep，检测手段不可用时警告并要求 `--yes` 确认）；把现有 app `mv` 到 `/Users/weidwonder/projects/zcode-backups/apps/<Name>-<版本>-<时间戳>.app`；`ditto` 拷入新包；`xattr -dr com.apple.quarantine`；默认 ad-hoc 重签（`--no-sign` 跳过）。支持 `--dry-run`。 |
| FR-004 | `patch/rollback-desktop.sh`：列出 `/Users/weidwonder/projects/zcode-backups/apps/` 的可回滚快照；无参数恢复最近一份（或 `--from <快照路径>` 指定）；同样检测运行、mv 当前包到备份区（带 `rolledback-from-` 前缀）、mv 快照回 `/Applications`。支持 `--dry-run`。 |
| FR-005 | `patch/sync-upstream.sh <ZCode源码目录>`：`git fetch origin`；从 `origin/main` 创建 `local/patched-<短SHA>` 分支（已存在则中止）；补丁来源：`patch/series`（一行一个提交 SHA，`#` 注释行忽略）非空用之，为空则取 `origin/main..feat/local-bot-webhook` 中非 `chore(local-dw):` 前缀的提交按序 cherry-pick；冲突即停（打印冲突文件清单，保留现场，退出码 4）；全部通过后跑 `pnpm typecheck` 与 `pnpm lint`（Node 24.14.0 PATH 前置）；结尾打印下一步（build-desktop.sh）。git 命令一律带 `-c safe.directory='*'`。支持 `--dry-run`（打印计划：新分支名、将 pick 的提交清单、将跑的校验命令，不执行写操作）。 |
| FR-006 | `patch/README.md`：首次替换、上游更新、回滚三条流程的完整命令序列；两份身份方案的取舍依据（指向调查报告）；已知风险（强更门、TCC 重授权、降级数据损耗、备份位置）。 |
| FR-007 | 调查报告 `docs/report/zcode-patched-build-compat.md`：覆盖任务书四大问（降级风险/登录凭据/强制升级门/推荐方案与回滚），结论全部附 `文件:行` 或实测输出作为证据；含「以 2026-10-27 库状态为准」的时效声明。 |

## 2. 数据模型 / 数据结构

备份产物结构（`patch/backup-zcode-data.sh` 的输出契约）：

```
<备份目录>/                          # 默认 /Users/weidwonder/projects/zcode-backups/<YYYYMMDD-HHMMSS>/
  manifest.json                      # 元数据（见下）
  sha256sums.txt                     # 每行 "<sha256>  <相对路径>"，shasum -a 256 -c 可校验
  zcode/cli/db/db.sqlite             # sqlite3 .backup 产物（不含 -wal/-shm）
  zcode/v2/tasks-index.sqlite
  zcode/v2/<其余文件按原相对路径>      # 复制（见 §4.1 范围表）
  zcode/skills/... zcode/agents/...
```

`manifest.json` 字段：

```json
{
  "createdAt": "<ISO8601>",
  "sourceRoot": "/Users/weidwonder/.zcode",
  "zcodeAppVersion": "3.16.3",
  "files": [
    {"path": "cli/db/db.sqlite", "bytes": 984227840, "sha256": "…",
     "method": "sqlite-backup", "sourceMtime": "2026-10-27T20:24:00+08:00"}
  ],
  "skipped": [
    {"path": "v2/cache/", "reason": "runtime-cache"},
    {"path": "workspace/", "reason": "large-regenerable"}
  ]
}
```

- `zcodeAppVersion` 取 `/Applications/ZCode.app/Contents/Info.plist` 的 CFBundleShortVersionString（读不到写 `null`，不失败——备份不应因 app 元数据不可读而中止）。
- 每个文件 MUST 记录 `method`：`sqlite-backup` / `copy`，恢复时按 method 区分（sqlite-backup 产物是自包含快照）。

## 3. 接口契约（脚本 CLI）

| 接口 | 入参 | 出参 / 退出码 | 调用方 |
|---|---|---|---|
| backup-zcode-data.sh | `[<备份目录>]` `--dry-run` | 退出码 0=成功；1=环境错误；2=目标已存在。stdout 打印备份目录与文件数 | 用户 / 派发者 |
| build-desktop.sh | `<ZCode源码目录>` `--identity preview\|production` `--skip-install` `--dry-run` | 0=成功并打印产物路径；1=失败（依赖缺失、构建失败）；dry-run 只打印命令 | 用户 |
| install-desktop.sh | `<产物路径 .app/.dmg>` `--no-sign` `--yes` `--dry-run` | 0=安装完成；1=错误；3=目标 app 运行中（不杀，提示退出后重试） | 用户 |
| rollback-desktop.sh | `[--from <快照>]` `--yes` `--dry-run` `--list` | 0=回滚完成；1=错误；3=运行中；`--list` 只列快照 | 用户 |
| sync-upstream.sh | `<ZCode源码目录>` `--dry-run` | 0=同步+校验通过；1=环境错误；4=cherry-pick 冲突（现场保留）；5=typecheck/lint 失败 | 派发者 |

约定（全部脚本共同）：
- `set -euo pipefail`；shebang `#!/usr/bin/env bash`。
- 每个写操作前打印 `[patch] > <命令>`（与 ZCode bundle.mjs 的日志风格一致）。
- EACCES / Permission denied MUST 原样报错并提示 `dwc grant <目录>`，MUST NOT 尝试 sudo、改权限、建软链。
- `--dry-run` 下 MUST NOT 产生任何写副作用（下载、git 写、mv、cp、codesign 全部跳过）。
- 临时文件一律 `mktemp -d` 系统临时目录，退出时清理（`trap`）。

## 4. 核心逻辑 / 流程

### 4.1 backup-zcode-data.sh 备份范围

| 路径（相对 `~/.zcode`） | 方式 | 理由 |
|---|---|---|
| `cli/db/db.sqlite` | sqlite3 在线备份 | 会话库（984 MB，WAL 活跃，文件复制会拿到撕裂快照） |
| `v2/tasks-index.sqlite` | sqlite3 在线备份 | 任务索引库（WAL 活跃） |
| `v2/*.json`、`v2/certs/`、`v2/agent-config/`、`v2/runtime/`、`v2/gen-ui-state/`、`v2/onboarding-record.json` | 递归复制 | 凭据/设置/bot 配置等全部结构化数据 |
| `skills/`、`agents/` | 递归复制 | 用户安装的技能与 agent 定义（skills 65 项，体积小价值高） |
| `cli/plugins/`、`cli/memories/`、`cli/log/` | 递归复制（非 minimal） | 用户插件与记忆；log 体积大但取证需要 |
| `workspace/`、`cli/artifacts/`、`cli/exec/`、`cli/rollout/`、`v2/visualizations/`、`v2/cache/`、`v2/crash/`、`v2/logs/`、`feedback/` | 跳过 | 任务工作区与可再生产物，体积大（数 GB）；记入 manifest 的 skipped |
| `cli/db/db.sqlite-wal/-shm` | 跳过 | 在线备份产物自包含，复制 WAL 无意义 |

`--minimal` 选项：只备两个 sqlite + `v2/*.json` + `v2/certs` + `v2/agent-config`（首次快速保全核心，适合装补丁前临时保底）。

### 4.2 build-desktop.sh 流程

1. 校验源码目录存在 `package.json` 且 `pnpm-workspace.yaml` 存在，否则退出 1。
2. Node 工具链：`/Users/weidwonder/projects/.toolchains/node-v24.14.0/bin/node` 不存在 → 从 `https://registry.npmmirror.com/-/binary/node/v24.14.0/node-v24.14.0-darwin-arm64.tar.gz` 下载（官方 `https://nodejs.org/dist/…` 兜底，重试一次）解压；`PATH` 前置该 bin 目录。
3. pnpm：`command -v pnpm` 且 `pnpm --version` 为 10.33.2（pnpm 脚本 shebang `#!/usr/bin/env node` 会随 PATH 取 Node 24）；缺失则报错（不自动安装全局包）。
4. `pnpm install`（除非 `--skip-install`）。
5. 身份变量（来源：`desktop-product-identity.mjs:59-68` 的解析规则）：
   - `--identity preview`（默认）：`ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1`
   - `--identity production`：`ZCODE_ENV=production`（MUST NOT 设 ZCODE_PREVIEW_IDENTITY）
6. 常量：`ZCODE_AUTO_UPDATE=0`（`scripts/build-time-config.mjs:44-47`：不设即关，显式置 0 防私有默认值干扰）、`ELECTRON_MIRROR` 未设时置 npmmirror（bundle.mjs 默认即此，显式置出于确定性）。
7. `pnpm bundle:desktop -- --os mac --arch arm64`（bundle.mjs 内部完成 prepare:runtime-assets → build → electron-builder → 产物校验 → 体积审计）。
8. 成功后定位并打印：`packages/desktop/dist/mac-arm64/ZCode[ Preview].app`（unpacked，可直接交给 install-desktop.sh）与 dist 下最新 `.dmg`。

### 4.3 install-desktop.sh / rollback-desktop.sh

- 产物形态判定：参数是 `.app` 目录（有 `Contents/Info.plist`）直接用；是 `.dmg` 则 `hdiutil attach -nobrowse -readonly` 挂载后取其中唯一 `.app`，`hdiutil detach`（拷贝用 ditto，跨卷保权限/元数据）。
- 身份→目标：读 `CFBundleIdentifier`：`dev.zcode.app` → `/Applications/ZCode.app`；`dev.zcode.app.preview` → `/Applications/ZCode Preview.app`；其它 → 报错退出 1（不装不明身份的包）。
- 运行检测：`pgrep -f "<目标路径>"`（pgrep 本身不可用时——如座位沙箱——打印警告，要求 `--yes` 显式确认已退出）。
- 替换：`mv "<目标>" "<备份区>/<Name>-<旧版本>-<YYYYMMDD-HHMMSS>.app"`（同卷 mv 原子）→ `ditto "<新>" "<目标>"` → `xattr -dr com.apple.quarantine "<目标>"` → 默认 `codesign --force --deep --sign - "<目标>"`（`--no-sign` 跳过）。ad-hoc 签名的取舍依据见报告 §5。
- rollback：`--list` 列备份区；恢复时同样检测运行、先把当前包 mv 到备份区（文件名前缀 `rolledback-from-`，保留现场供再回退），再把指定快照 mv 回 `/Applications`。

### 4.4 sync-upstream.sh 流程

1. 在源码目录 `git -c safe.directory='*' fetch origin`。
2. `local/patched-$(git rev-parse --short origin/main)` 已存在 → 报错退出 1（提示手工清理，不自动删分支）。
3. 补丁提交序列：`patch/series` 非空（忽略空行与 `#` 注释）→ 按文件顺序；空 → `git log --reverse origin/main..feat/local-bot-webhook --format=%H` 过滤 `chore(local-dw):` 前缀（`git log --format='%H %s'` 后按前缀筛）。序列为空 → 打印提示（当前上游补丁分支尚无功能提交）并继续建分支（同步上游本身仍有意义）。
4. `git switch -c <分支> origin/main` → 逐个 `git cherry-pick <sha>`；任一失败 → `git status --short` + `git diff --name-only --diff-filter=U` 打印冲突清单，退出 4，**不做任何 reset/revert/清理**。
5. 校验：`pnpm typecheck`、`pnpm lint`（PATH 前置 Node 24.14.0，与 build-desktop.sh 同一工具链逻辑）；失败退出 5。
6. 打印下一步指引（build-desktop.sh）。
7. 「补丁契约测试」：`patch/series` 机制支持在 series 文件中用 `! <命令>` 行声明 pick 后要跑的自定义校验命令（当前无契约测试，机制先留通给另一子任务接——series 文件里没有 `!` 行时跳过此步）。【设计自检：`!` 行是 YAGNI 吗？不是——任务书明确要求 sync 脚本跑「补丁契约测试」，而契约测试文件属另一子任务产出，本脚本只能以命令声明方式解耦。】

## 5. 错误处理 / 降级 / 失败模型

| 失败分类 | 恢复行为 | 操作员干预点 |
|---|---|---|
| 下载 Node 失败（npmmirror 与官方都失败） | 报错退出 1，打印两个 URL 供手动下载放置 | 手动下载解压到 .toolchains 后重跑 |
| `pnpm install`/构建失败 | 原样透传 bundle.mjs 的错误输出退出 1 | 用户在源码目录自查；脚本不重试（bundle.mjs 自带 electron-builder 3 次重试） |
| install 时目标运行中 | 退出 3，不杀进程 | 用户退出 ZCode 后重跑 |
| install 中途失败（mv 后 ditto 前） | 报错并提示：旧包已在备份区，重跑 rollback-desktop.sh 恢复 | rollback |
| sqlite3 不可用 | backup 退出 1 并提示安装 sqlite3（macOS 自带，异常环境才缺） | — |
| cherry-pick 冲突 | 退出 4，保留现场 | 人工解冲突后 `git cherry-pick --continue` |
| 备份目标目录已存在 | 退出 2（防覆盖旧备份） | 换目录或删旧目录 |

## 6. 安全 / 鉴权 / 配置 / 不变量

- **不碰凭据**：备份脚本复制 `credentials.json` 时只读复制+哈希，MUST NOT 在任何日志/输出中打印文件内容。
- **不改权限**：EACCES 一律上抛（见 §3 约定）。
- **安全不变量**：
  - Invariant 1: backup 脚本对源数据只读（sqlite3 `-readonly` + `.backup`；`cp -p`），任何写 `~/.zcode` 的路径都是 bug。
    - 强制机制：只允许白名单命令形态（见 §4.1 表）；不接受把源目录当目标的参数。
    - 违反时：视为脚本 bug，评审门拦截。
  - Invariant 2: install/rollback MUST NOT 删除任何 `.app`（只 mv 到备份区）。
    - 强制机制：脚本内无 `rm` 对 .app 的调用；备份区写满时报错而非删除旧备份。
  - Invariant 3: `--dry-run` 下零写副作用。
    - 强制机制：dry-run 分支提前 return，写操作全部在其后。
- **配置 Cheat Sheet**：

| 字段 | 类型 | REQUIRED | 默认 | 说明 |
|---|---|---|---|---|
| `--identity`（build） | preview\|production | 否 | preview | 产物身份；取舍见报告 §6 |
| `--minimal`（backup） | flag | 否 | 关 | 只备 sqlite+顶层 json |
| `--no-sign`（install） | flag | 否 | 关（默认签） | 跳过 ad-hoc 重签 |
| `--yes`（install/rollback） | flag | 否 | 关 | 跳过运行检测失败时的交互确认 |
| `--from`（rollback） | 路径 | 否 | 最新快照 | 指定恢复源 |
| `--skip-install`（build） | flag | 否 | 关 | 跳过 pnpm install |
| 备份根目录 | 环境变量 `ZCODE_BACKUP_ROOT` | 否 | `/Users/weidwonder/projects/zcode-backups` | 所有备份/旧 app 快照的根 |

## 7. 可观测性

- 每步操作打印 `[patch] > <命令>`；关键产物打印绝对路径。
- backup 结束打印汇总：文件数、总字节、跳过清单条数、耗时。
- 无后台任务、无指标埋点需求（一次性运维脚本）。

## 8. 兼容性 / 迁移

### 8.1 兼容取舍决策（用户拍板，MUST）

本次改动**不改变任何 ZCode 既有可观察行为，无兼容取舍**——全部产出是 zcode-sub 仓新增文件（脚本+文档），ZCode 源码零改动。工具链**使用**层面改变用户机器状态的动作（替换 /Applications、写备份目录）均由用户手动逐条执行，且可经 rollback 恢复。

### 8.2 替换清单（Replacement Ledger，MUST）

无被取代物（全新增，无旧函数/文件/配置被替代）。

### 8.3 数据迁移 / 灰度

不适用（无数据迁移；数据保全由 FR-001 备份承担）。

## 11. 完成定义（Definition of Done）

| 编号 | 验收项 | 满足 |
|---|---|---|
| AC-001 | §0 阅读导引齐全 | — |
| AC-002 | 五个脚本 `bash -n` 全部通过；本座位可用工具下 shellcheck（若可用）无 error 级发现 | FR-001~005 |
| AC-003 | 每个脚本 `--dry-run` 实跑：只打印计划、无写副作用（可用前后目录 mtime/清单对比验证） | FR-001~005 |
| AC-004 | backup 对临时构造的模拟 `~/.zcode`（含 sqlite 带 WAL、多类文件）实跑成功：manifest/sha256 齐全、`shasum -c` 通过、源目录 mtime 不变、可重复执行时正确拒绝 | FR-001 |
| AC-005 | build/sync 的 dry-run 输出包含正确的环境变量组合（preview 与 production 两态各自打印正确的变量集） | FR-002, FR-005 |
| AC-006 | install/rollback 的 dry-run 对模拟 .app（含 Info.plist）打印正确的目标路径与 mv/ditto/codesign 计划 | FR-003, FR-004 |
| AC-007 | 调查报告覆盖任务书四大问且结论有出处；推荐方案与脚本默认值一致 | FR-007 |
| AC-008 | `patch/README.md` 三条流程可直接照抄执行 | FR-006 |
| AC-009 | 权限受限环境（本座位）实测：EACCES 路径的报错包含 `dwc grant` 提示 | FR-001~005 |

**覆盖自查**：FR-001→AC-002/003/004；FR-002→AC-002/003/005；FR-003→AC-002/003/006；FR-004→AC-002/003/006；FR-005→AC-002/003/005；FR-006→AC-008；FR-007→AC-007；（流程性）AC-001/009→—。

## 12. 待澄清点

无（任务书已把脚本行为、目录、边界全部定死；身份方案的选择属派发者拍板项，已通过报告给出两案对比与默认值依据，不需要新的业务澄清）。

## 13. 过稿记录（MUST）

- 2026-10-27｜拍板人显式跳过本次｜任务书原文：「用户本人已明确声明本次跳过 spec 过稿门，spec 写完直接实现」。
