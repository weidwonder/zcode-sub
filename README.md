# zcode-sub — ZCode 补丁版工具链仓

维护 ZCode 桌面版本地补丁的构建、安装替换、数据保全与上游跟随工具。上游为 [github.com/zai-org/ZCode](https://github.com/zai-org/ZCode)（本地只读克隆 `/Users/weidwonder/projects/ZCode`）；本仓不修改上游源码，补丁提交在上游 worktree 分支上开发、经 `patch/series` 固化后由本仓工具链跟随。

## 需求

本仓回答四个业务问题（结论与证据见 [docs/report/zcode-patched-build-compat.md](docs/report/zcode-patched-build-compat.md)）：

1. **数据保全**：替换/降级 ZCode 前，用户的登录态、任务历史、技能与配置如何完整备份与恢复（`patch/backup-zcode-data.sh`）。
2. **补丁构建**：开源源码 + 本地补丁如何构建出可安装的 mac 包，身份怎么选（Preview 并存 vs production 原地替换，默认 Preview）（`patch/build-desktop.sh`）。
3. **安装与回退**：如何替换/并存/回退 `/Applications` 里的应用且旧包永不丢失（`patch/install-desktop.sh`、`patch/rollback-desktop.sh`——由用户本人在终端直接运行）。
4. **上游跟随**：上游整批快照同步后，补丁如何低成本跟上并先过降级兼容门检（`patch/sync-upstream.sh`、`patch/verify-migration-checksums.mjs`）。

操作流程照抄 [patch/README.md](patch/README.md)。

## 架构与边界

单仓纯工具链（bash + 少量 Node 脚本），无服务、无长期进程：

- `patch/backup-zcode-data.sh` — 用户数据目录（~/.zcode）备份（SQLite 在线备份 + manifest/sha256）
- `patch/build-desktop.sh` — mac arm64 构建（Node/pnpm 工具链自举到 `.toolchains/`，不动全局）
- `patch/install-desktop.sh` / `patch/rollback-desktop.sh` — 应用目录（/Applications）安装替换与回退（用户本人运行；旧包只 mv 不删）
- `patch/sync-upstream.sh` — fetch 上游 → `local/patched-<短SHA>` 分支 → 按 `patch/series` 净提交 cherry-pick → typecheck/lint
- `patch/verify-migration-checksums.mjs` — 迁移账本 checksum 门检（替换安装前必跑）
- `patch/series` — 补丁净提交清单（SHA 行 / `#` 注释 / `!` 自定义校验行）
- `docs/` — spec 与调查报告（[索引](docs/index.md)）；`engineering-context/` — 代码事实层与上游 ZCode 的依赖声明

边界：不修改上游 ZCode 源码；不做数据自动回滚（备份与校验有，覆盖用户数据的动作不代做）；不做 Windows/Linux 构建；不做签名与公证。

## 开发流程

本项目采用 dw-workflow（见 `AGENTS.md` 标记块）：改动在 `.worktrees/` 下独立 worktree 进行，合并回 main。
