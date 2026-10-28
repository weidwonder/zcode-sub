# ZCode 补丁版工具链

用开源 ZCode 源码（3.16.2）+ 本地补丁构建桌面版，保留登录态与任务历史，替换或并存于正式版（3.16.3），并在上游发版后低成本跟上。

兼容性结论、身份方案对比与证据：`../docs/report/zcode-patched-build-compat.md`（下称「报告」）。本文只给操作步骤。

## 脚本一览

| 脚本 | 作用 |
|---|---|
| `backup-zcode-data.sh [备份目录] [--minimal] [--dry-run]` | 备份 `~/.zcode`（SQLite 在线备份 + 配置文件），默认到 `<家目录>/projects/zcode-backups/<时间戳>/` |
| `build-desktop.sh <ZCode源码目录> [--identity preview\|production] [--skip-install] [--no-dmg] [--dry-run]` | 构建补丁版（mac arm64），默认 Preview 身份 |
| `install-desktop.sh <产物 .app/.dmg> [--no-sign] [--yes] [--dry-run]` | 安装到 /Applications（身份自动判定目标；旧包移入备份区） |
| `rollback-desktop.sh [--from <快照>] [--list] [--yes] [--dry-run]` | 把 /Applications 里的包回滚到备份区快照 |
| `sync-upstream.sh <ZCode源码目录> [--dry-run]` | fetch 上游 → 建补丁分支 → cherry-pick → typecheck/lint |

全部脚本：`set -euo pipefail`；支持 `--dry-run`；可重复执行；`EACCES` 时提示 `dwc grant <目录>`；`git` 一律 `-c safe.directory='*'`。

## 环境变量

| 变量 | 含义 | 默认值 |
|---|---|---|
| `ZCODE_REAL_HOME` | 真实家目录。HOME 被重定向的环境（沙箱/多账号容器）设它指向真实家目录 | `$HOME` |
| `ZCODE_TOOLCHAIN_ROOT` | Node 工具链与构建缓存根目录（build-desktop.sh / sync-upstream.sh） | `<家目录>/.cache/zcode-sub/toolchains` |
| `ZCODE_ROOT` | ZCode 数据目录（backup-zcode-data.sh 的备份源） | `<家目录>/.zcode` |
| `ZCODE_BACKUP_ROOT` | 备份区根目录（数据备份与旧 .app 快照共用） | `<家目录>/projects/zcode-backups` |

`<家目录>` = `ZCODE_REAL_HOME`（未设则 `$HOME`）；下文示例里的 `<zcode-sub 仓库目录>`、`<ZCode 源码目录>` 按实际位置代入。

## 流程一：首次替换（推荐 Preview 并存）

先准备带补丁的 ZCode 源码（`build-desktop.sh` 只构建传入的目录，不会自己打补丁），二选一：

- **直接用 fork 分支**：`git clone -b feat/local-task-api https://github.com/weidwonder/ZCode <ZCode 源码目录>`——上游 3.16.2（`3c5b2276`）加 `patch/series` 的三个补丁提交。
- **在上游源码上打补丁**：`git clone https://github.com/zai-org/ZCode <ZCode 源码目录>`，再 `git -C <ZCode 源码目录> fetch https://github.com/weidwonder/ZCode feat/local-task-api` 取到补丁提交，然后跑流程二第 1 步的 `patch/sync-upstream.sh <ZCode 源码目录>`（它要求 `origin` 指向上游）。

```bash
cd <zcode-sub 仓库目录>
# 0. 备份数据（约 1 GB 会话库在线备份，几分钟）
patch/backup-zcode-data.sh
# 1. 构建（默认 --identity preview：ZCode Preview.app，与正式版并存，强更门/自动更新天然跳过）
patch/build-desktop.sh <ZCode 源码目录>
# 2. 安装（Preview 产物装到 /Applications/ZCode Preview.app，不动正式版）
patch/install-desktop.sh '<ZCode 源码目录>/packages/desktop/dist/mac-arm64/ZCode Preview.app'
# 3. 打开「ZCode Preview」验证：应免登录（凭据共享）、历史任务在；
#    再跑 zcode-sub setup（首次写开关文件后要重启 ZCode Preview 再跑一次），看到「✓ 本机任务 API 正常」
```

要彻底替代正式版（不只并存）时：把正式版也移到备份区——命令与上面 install 的备份同款
`mv /Applications/ZCode.app <家目录>/projects/zcode-backups/apps/ZCode-<版本>-<时间戳>.app`；
回滚时移回 `/Applications` 即可。两份应用并存期间不需要这一步。

回退：直接打开正式版 ZCode 即可（Preview 可留着或拖进废纸篓，不影响正式版）。

### 变体：production 原地替换（方案 B）

```bash
patch/build-desktop.sh <ZCode 源码目录> --identity production
patch/install-desktop.sh <ZCode 源码目录>/packages/desktop/dist/mac-arm64/ZCode.app
```

替换后正式版旧包在 `zcode-backups/apps/ZCode-3.16.3-<时间戳>.app`，回退用 `patch/rollback-desktop.sh --list` 挑一份恢复。**选这个方案前读报告 §3/§6**：强更门敞口（服务端一旦下发 minimalVersion>3.16.2 补丁版启动即被拦）、签名丢失（CUA 的辅助功能/录屏要重新授权）。

## 流程二：上游更新（上游 sync 了新版本）

```bash
# 1. 同步：fetch → local/patched-<上游SHA> 分支 → cherry-pick 补丁 → typecheck/lint
patch/sync-upstream.sh <ZCode 源码目录>
#    冲突时脚本停下并打印冲突文件清单；解决后在该仓库里 git cherry-pick --continue
#    （补丁提交清单固定在 patch/series；未固化时仅建立跟随上游的分支并打警告、不 cherry-pick；
#     净提交 SHA 由派发者在补丁评审通过后固化）
# 2. 在 local/patched-* 分支上重新构建安装（同流程一；build 脚本对任意 checkout 的目录都可用）
# 3. 门检+备份再替换：
   node patch/verify-migration-checksums.mjs <ZCode 源码目录>   # checksum 门检，exit 0 才继续
   patch/backup-zcode-data.sh
```

若上游新版本引入了新迁移（升级后账本出现本分支清单外的条目），替换前把报告 §1.3 的 checksum 比对重跑一遍（报告附录有方法）。

## 流程三：回滚

```bash
patch/rollback-desktop.sh --list                 # 看可回滚快照
patch/rollback-desktop.sh                        # 恢复最近一份
patch/rollback-desktop.sh --from zcode-backups/apps/ZCode-3.16.3-20261027-220000.app
```

回滚只动 .app，不动 `~/.zcode` 数据——3.16.3 读 3.16.2 写过的数据是向前方向，安全（报告 §5）。

### 数据恢复（仅在数据异常时）

```bash
# 备份完整性校验
cd <家目录>/projects/zcode-backups/<时间戳> && shasum -a 256 -c sha256sums.txt
# 退出 ZCode 后，用 zcode/ 下同名文件覆盖 ~/.zcode 对应文件（sqlite-backup 产物是自包含快照）
# 例：cp zcode/v2/tasks-index.sqlite ~/.zcode/v2/tasks-index.sqlite
```

数据恢复是覆盖用户数据的动作，工具链只提供备份与校验，**不自动执行**。

## 已知风险与限制

1. **强更门（仅 production 身份）**：服务端 `/api/v1/client/configs` 下发 `forceUpdate.minimalVersion` 高于 3.16.2 时，补丁版启动即被拦（弹窗只能升级或退出；断网可绕过但应用不可用）。Preview 身份不受影响（官方代码显式跳过）。（报告 §3）
2. **签名**：开源构建产物未签名（macOS 签名默认关），install 默认 ad-hoc 重签。CUA（computer use）的辅助功能/录屏授权绑定签名，替换后首次使用需重新授权；不用 CUA 则无感。（报告 §2.2）
3. **CUA helper 可能缺**：开源构建在无私有 producer 时不随包携带 computer-use helper（报告 §2.2）——依赖 CUA 的场景先实机验证。
4. **降级数据损耗**：3.16.2 打开 3.16.3 写过的数据已验证安全（报告 §1），但补丁版使用期间修改设置会抹掉 3.16.3 新增的设置键；尽量少动设置。
5. **`.dmg` 安装**：支持（只读挂载提取 .app），优先用 build 输出的 unpacked .app 目录，更快。
6. **本座位不能装**：`/Applications` 写权限受限的环境（dwc 座位）跑 install 会报 EACCES——按提示 `dwc grant /Applications` 后由用户环境执行。
7. **Node 工具链**：首次构建会下载 Node 24.14.0 到 `<家目录>/.cache/zcode-sub/toolchains/`（约 40 MB，npmmirror 镜像），不改全局 Node；位置可用 `ZCODE_TOOLCHAIN_ROOT` 改（见上「环境变量」）。
8. **DMG 产物在受限沙箱环境不可得**：dwc 座位等 sandbox-exec 环境里 `hdiutil` 被拦截（ENXIO），electron-builder 的 DMG 阶段必败——属环境限制非脚本缺陷；zip 与 unpacked .app 不受影响。构建脚本提供 `--no-dmg` 显式走 zip 通路（跳过 DMG 与 bundle.mjs 收尾机械校验）；普通模式下 DMG 失败但 zip/.app 已产出时脚本打警告并算成功。`install-desktop.sh` 直接用 .app 产物，不依赖 DMG。
