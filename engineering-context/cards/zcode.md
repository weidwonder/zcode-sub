# zcode 地图卡（上游 ZCode 桌面版，github.com/zai-org/ZCode）

> 上游开源仓库快照（origin/main 3c5b2276 = 3.16.2）。本仓（zcode-sub）为它维护本地补丁与工具链。
> 域卡：[构建身份与打包](zcode/构建身份与打包.md) · [更新与强制升级](zcode/更新与强制升级.md) · [数据目录与迁移](zcode/数据目录与迁移.md) · [凭据与登录态](zcode/凭据与登录态.md)

## 职责

ZCode 桌面版（Electron）+ CLI + 服务层的开源快照。本仓关心四件事：怎么构建出可安装的 mac 包、构建身份怎么定、用户数据长什么样怎么安全降级、登录态存在哪。

## 权威实现与对外接口

| 主题 | 权威位置 |
|---|---|
| 打包入口与产物 | `packages/desktop/scripts/bundle.mjs`（详见域卡） |
| 身份解析 | `packages/desktop/scripts/desktop-product-identity.mjs` |
| 迁移执行器 | `packages/shared/src/sqlite-migrations/runner.ts` |
| 数据路径 | `packages/services/src/paths.ts` |
| 凭据加密 | `packages/services/src/credential/providers/credentialCipherProvider.ts` |

## 陷阱项

- 上游是整批快照同步（一次几百到几千文件），开源仓库版本（3.16.2）落后已装正式版（3.16.3）——用开源源码构建 = 降级，兼容性结论见 `docs/report/zcode-patched-build-compat.md`。
- `ZCODE_ENV` 缺省按 test 处理（Preview 身份 + 测试后端），连生产后端必须显式 `ZCODE_ENV=production`。
- macOS 签名默认关（`identity: null`），开源构建即未签名包。

## 确认

2026-10-27，基于 origin/main 3c5b2276 源码通读 + 用户库只读查询 + 生产 configs 实测。
