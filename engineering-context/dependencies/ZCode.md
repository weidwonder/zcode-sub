# 上游依赖：ZCode（github.com/zai-org/ZCode）

- 本地克隆：`/Users/weidwonder/projects/ZCode`（主工作树只读参考）；补丁开发在其 worktree `.worktrees/local-bot-webhook`（分支 `feat/local-bot-webhook`，`chore(local-dw):` 前缀提交是本地专用、不参与补丁 cherry-pick）。
- 上游发布形态：整批快照同步（一次几百到几千文件），开源仓库版本常落后闭源正式版（当前：仓库 3.16.2 = origin/main 3c5b2276 @2026-10-20；用户已装正式版 3.16.3）。
- 对齐版本（升级上游前 MUST 核对）：Node 24.14.0、pnpm 10.33.2（`mise.toml`）；打包 `pnpm bundle:desktop`。
- 升级动作：`patch/sync-upstream.sh /Users/weidwonder/projects/ZCode`（fetch → local/patched-<SHA> → cherry-pick 补丁 → typecheck/lint）。升级后若上游新增了 SQLite 迁移，先重跑 `docs/report/zcode-patched-build-compat.md` §1.3 的 checksum 比对再替换安装。
- 兼容性结论与证据：`docs/report/zcode-patched-build-compat.md`（2026-10-27 基线）。
- 2026-10-27 上游状态记录：origin/main = 3c5b2276（3.16.2）；生产 configs 无 forceUpdate 门槛；`feat/local-bot-webhook` 仅有 1 个 chore(local-dw) 提交、功能补丁未落分支。
