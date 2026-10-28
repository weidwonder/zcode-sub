# Changelog

本仓的对外可见变化记录。分类是闭集：`不兼容` / `新增` / `变更` / `修复` / `内部`。

## 未发布

### 不兼容

（无）

### 新增

- 迁移 checksum 门检工具 `patch/verify-migration-checksums.mjs`（上游更新后替换安装前重跑，账本超集或 checksum 漂移即非零退出）。
- ZCode 补丁版工具链五脚本（`patch/backup-zcode-data.sh`、`build-desktop.sh`、`install-desktop.sh`、`rollback-desktop.sh`、`sync-upstream.sh`）与流程文档 `patch/README.md`——数据保全、mac arm64 构建（Preview/production 双身份）、安装替换与回滚、上游跟随。
- 兼容性调查报告 `docs/report/zcode-patched-build-compat.md`——3.16.2 打开 3.16.3 数据安全（逐条 checksum 证据）、登录态与签名无关、强更门实测状态、Preview 并存推荐方案。

### 变更

- `patch/series` 固化 ZCode 补丁的三个净提交（与上游 PR 同一组）并加契约测试校验行，`sync-upstream.sh` 从此会实际 cherry-pick 补丁。

### 修复

（无）

### 内部

- spec（`docs/spec/2026-10-27-zcode-sub-patch-tooling-eng-spec.md`）、ZCode 上游事实卡（`engineering-context/dependencies/ZCode/`）与依赖声明（`engineering-context/dependencies/ZCode.md`）。
