# Changelog

本仓的对外可见变化记录。分类：`不兼容` / `新增` / `变更` / `修复` / `内部`。

## 未发布

- 新增：迁移 checksum 门检工具 `patch/verify-migration-checksums.mjs`（上游更新后替换安装前重跑，账本超集或 checksum 漂移即非零退出）。
- 新增：ZCode 补丁版工具链五脚本（`patch/backup-zcode-data.sh`、`build-desktop.sh`、`install-desktop.sh`、`rollback-desktop.sh`、`sync-upstream.sh`）与流程文档 `patch/README.md`——数据保全、mac arm64 构建（Preview/production 双身份）、安装替换与回滚、上游跟随。
- 新增：兼容性调查报告 `docs/report/zcode-patched-build-compat.md`——3.16.2 打开 3.16.3 数据安全（逐条 checksum 证据）、登录态与签名无关、强更门实测状态、Preview 并存推荐方案。
- 内部：spec（`docs/spec/2026-10-27-zcode-sub-patch-tooling-eng-spec.md`）、engineering-context 卡片（zcode 地图卡 + 4 域卡）与上游依赖声明（`engineering-context/dependencies/ZCode.md`）。
