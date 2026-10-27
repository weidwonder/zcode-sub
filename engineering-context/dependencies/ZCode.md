# 依赖声明：ZCode

> 每个被本项目调用的上游（SDK / 服务 / 共享库）一份，落 `engineering-context/dependencies/<上游名>.md`。
> 它写"本项目用了上游什么"，是卡片的反向。升级上游时与上游仓库根 `CHANGELOG.md` 的 `不兼容` 条目按**接口名**取交集即得影响面。判据与升级处置顺序见 dw-code-facts 的 `代码事实纪律.md` §10.2。

- 上游与当前版本：github.com/zai-org/ZCode @ 3.16.2（本地只读克隆 `/Users/weidwonder/projects/ZCode`，origin/main 3c5b2276）
- 确认时间：2026-10-28

**上游快照状态（本仓各文档里具体 SHA / 版本号 / 服务端状态以本行为准）**：origin/main = 3c5b2276（3.16.2，2026-10-20 sync）；用户已装正式版 3.16.3（dev.zcode.app，官方签名）；生产 `/api/v1/client/configs` 于 2026-10-27 实测未下发 `forceUpdate` 门槛（服务端随时可变）；补丁开发分支 `feat/local-bot-webhook`（上游 worktree）当前含 v1 webhook ingress 的 6 个 feat + 1 个 revert 对冲与 local task api 线 4 个净提交——净提交以 `patch/series` 固化为准。

## 用到的部分

| 接口名 | 调用点（文件:行） | 注意事项 |
|---|---|---|
| `pnpm bundle:desktop`（上游根 package.json script） | patch/build-desktop.sh:178 | 内部串行 prepare→build→electron-builder→产物机械校验，勿拆步调用 |
| `ZCODE_ENV` / `ZCODE_PREVIEW_IDENTITY` / `ZCODE_AUTO_UPDATE`（上游构建期环境变量协议） | patch/build-desktop.sh#BUILD_ENV（构建环境组装段）| `ZCODE_ENV` 缺省按 test 后端处理，连生产必须显式 `=production`；`ZCODE_AUTO_UPDATE=0` 只关自动更新、关不掉强更门 |
| 迁移账本表 `schema_migration`（会话库）/ `tasks_schema_migration` 与项目存储 `schema_migration`（tasks-index 库） | patch/verify-migration-checksums.mjs#readLedger（三处调用：会话库 / 任务索引 / 项目存储账本） | 只读查询；checksum 规则三组不同（sha256(sql.trim()) 与 sha256(JSON.stringify(checksumInput))），门检脚本已内置 |
| 数据布局 `getAppConfigDir()`（`~/.zcode/v2`）与 `cli/db/db.sqlite` | patch/backup-zcode-data.sh:55-63 | 凭据/设置/bot 配置在 `v2/`、会话库在 `cli/db/`；与 flavor 无关（Preview 与 production 共享） |
| `credentials.json`（凭据文件，AES-256-GCM、密钥本机派生） | patch/backup-zcode-data.sh:59（备份范围含 v2/*.json） | 备份只读复制+哈希，MUST NOT 在日志打印内容；解密与签名无关 |
| `feat/local-bot-webhook`（上游补丁开发分支） | patch/sync-upstream.sh:12,64（series 读取）；patch/series（净提交清单） | 分支含 v1 引入+revert 对冲对，MUST NOT 自动取全部非 chore 提交；净提交由派发者固化进 series |
| `local/patched-<上游短SHA>` 分支命名（本仓约定，作用于上游仓） | patch/sync-upstream.sh:15 | 已存在即中止，不自动删 |

## 业务域地图

| 业务域 | 一句话 | 事实卡 |
|---|---|---|
| 构建身份与打包 | 安装包身份（ZCode / ZCode Preview）、后端环境与 mac 构建链 | `dependencies/ZCode/构建身份与打包.md` |
| 更新与强制升级 | 自动更新与启动期强更门，决定旧客户端能否连生产后端 | `dependencies/ZCode/更新与强制升级.md` |
| 数据目录与迁移 | `~/.zcode` 布局、三组 SQLite 迁移账本与跨版本打开行为 | `dependencies/ZCode/数据目录与迁移.md` |
| 凭据与登录态 | 登录凭据存储与加密，替换/并存 app 的登录保留 | `dependencies/ZCode/凭据与登录态.md` |
