# 贡献指南

感谢关注 zcode-sub。仓库很小，参与门槛也低。参与本项目即同意遵守[行为准则](CODE_OF_CONDUCT.md)；安全问题按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 报问题

开 [GitHub Issue](https://github.com/weidwonder/zcode-sub/issues)，带上下文：

- **bug**：复现步骤、涉及命令与退出码；可设 `ZCODE_SUB_DEBUG=1` 重跑一次，附 `~/.zcode-sub/debug.log` 相关段落（日志不含 token 与任务正文，附前请再自查一遍）。
- **功能建议**：先说清使用场景（想让子代理做什么、现在卡在哪一步）。

## 本地开发

```bash
git clone https://github.com/weidwonder/zcode-sub
cd zcode-sub
npm test        # Node ≥ 22；node:test + 假 ZCode（契约 v2）全链路，无需装 ZCode
```

`scripts/smoke-real-zcode.sh` 是真机冒烟（需要本机装好补丁版 ZCode 并完成 setup），改动桥接行为时建议跑。

仓库日常开发用 dw-workflow 流程（见 `AGENTS.md` 标记块）；外部贡献者**不需要**装任何相关工具，直接 fork + 分支 + PR 即可。

## 提交规范

- Conventional Commits 风格：`type(scope): subject`（如 `fix(cli): …`、`docs: …`、`feat(patch): …`），中英文均可。
- 一个 PR 一件事；改行为的 PR 请同步更新 README 命令表/退出码与 `CHANGELOG.md` 的 `## 未发布` 段。
- PR 前保证 `npm test` 全绿。

## 许可证

提交即表示贡献内容按 [Apache-2.0](LICENSE) 授权。
