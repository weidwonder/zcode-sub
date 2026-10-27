---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-27'
authority_refs:
  - 'ZCode 3.16.2（origin/main 3c5b2276）打开 3.16.3 数据的降级兼容性结论与证据'
  - '登录态/凭据在 app 替换与 Preview 并存两种形态下的保留结论'
  - '强制升级门的触发条件、当前服务端实测状态与合规规避路径'
---

# ZCode 补丁版构建兼容性调查报告

> 调查对象：开源 ZCode 源码（`/Users/weidwonder/projects/ZCode`，origin/main 3c5b2276 = 3.16.2，2026-10-20 sync）与用户当前安装（`/Applications/ZCode.app` = 3.16.3，官方签名 8A5X4JJ39T）。
> 方法边界：只读开源源码 + 用户数据目录元数据 + 只读 SQLite 查询；**未**解包/反编译官方安装包（asar/字节码未触碰）；对生产 API 只发起了客户端启动时的标准配置查询。
> **时效声明**：所有「用户库当前状态」类结论以 2026-10-27 的库快照为准；服务端 minimalVersion 状态随时可变；上游后续 sync 可能改变迁移清单，届时须重验。

## 结论速览

| 问题 | 结论 |
|---|---|
| 3.16.2 打开 3.16.3 写过的数据 | **安全**（当前库状态；三组迁移账本与 3.16.2 清单完全同代，逐条 checksum 验证通过） |
| 替换 app 后登录态 | **完整保留**（凭据在 `~/.zcode/v2/credentials.json`，加密密钥由本机用户名+home 派生，与代码签名无关；Preview 并存同样保留） |
| 强制升级门 | production 身份**当前不被拦**（服务端未下发 forceUpdate），但风险敞口存在；**Preview 身份官方代码显式跳过** |
| 推荐方案 | **A：Preview 身份并存**（默认）；B：production 原地替换（可选，接受强更门敞口 + TCC 重授权） |

## 1. 降级风险：3.16.2 打开 3.16.3 写过的数据

### 1.1 机制层：迁移器如何对待「更新版本写过的库」

迁移执行器 `packages/shared/src/sqlite-migrations/runner.ts:62-100`：每次启动对**清单内**每条迁移查账本（`schema_migration` 表），checksum 不匹配抛 `MigrationChecksumError`（runner.ts:70-71）；**对账本里有、清单里没有的迁移 id（即新版已应用、本版不认识的条目）完全没有检查逻辑**——既不报「未知迁移」，也不回滚。也就是说**降级打开新版本写过的库，迁移层天然不会因「存在未知迁移」而失败**。

三个库各自的迁移账本与代码位置：

| 库 | 路径 | 账本表 | 迁移清单 |
|---|---|---|---|
| 会话库 | `~/.zcode/cli/db/db.sqlite` | `schema_migration` | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`（24 条，0001~0024） |
| 任务索引 | `~/.zcode/v2/tasks-index.sqlite` | `tasks_schema_migration`（base scope） | `packages/services/src/session/tasksDatabase/migrations.ts:66-122`（base 5 条：0001/0002/0003/0004/0006） |
| 项目存储（同在任务索引库文件内） | 同上 | `schema_migration` | `packages/services/src/project-storage/index.ts:29-57`（3 条：0005/0006/0007） |

### 1.2 实测：用户库当前迁移状态（sqlite3 -readonly，2026-10-27）

- 会话库：已应用到 **0024_session_database_identity**（appVersion 0.16.9，2026-10-20 12:13 应用）。
- 任务索引 base：0001~0004 + **0006_task_group_admissions**（2026-10-20 应用；无 0005 属正常——0005 是 source-server scope，仅在配置 source-server 工作区时走 `migrations.ts:113-135` 的独立 scope 分支）。
- 项目存储：0005_projects / 0006_default_workspace_tasks / **0007_initial_workspace_order**（最后一条 appVersion 字段值就是 `3.16.2`，`project-storage/index.ts:50`）。

**三组账本都没有任何超出 3.16.2 源码清单的条目。** 用户从 10-20 升级到 3.16.3 后重度使用 7 天（10-27 仍在写库），若 3.16.3 携带新迁移必然已应用——没有，说明 3.16.3 的迁移集与 3.16.2 一致。

### 1.3 逐条 checksum 比对（防「3.16.3 改过已应用迁移的 SQL」）

方法：从 3.16.2 源码提取每条迁移的 SQL 文本，按 runner 的规则算 sha256（会话库 = `sha256(sql.trim())`，runner.ts:114-116；任务索引 = `sha256(JSON.stringify(checksumInput))`，`tasksDatabase/migrations.ts:146-148`；项目存储同会话库规则），与账本记录逐条比对。

| 账本 | 精确匹配 | 动态构造无法文本验证 | 不匹配 |
|---|---|---|---|
| 会话库 schema_migration | **21/24**（含最新应用的 0023、0024） | 3 条（0020/0021/0022，SQL 由函数插值生成） | **0** |
| 任务索引 tasks_schema_migration | **4/5**（0002/0003/0004/0006） | 1 条（0001，多常量拼装）→ 已用表结构对比替代验证 | **0** |
| 项目存储 schema_migration | **2/3**（0006/0007） | 1 条（0005）→ 表结构对比替代验证 | **0** |

表结构对比：库内 `tasks`（32 列）、`automations`、`remote_project_entries` 的全部列都能在 3.16.2 源码的冻结声明（`schema-v1.ts` 的 TASK_INDEX_SCHEMA、`tasksDatabase/migrations.ts:23-54` 的冻结 columns、`project-storage/schema.ts:29-35` 的 cli_* 列）中找到出处，无「3.16.2 不认识的列」。

对 5 条未做精确验证的迁移（0020/0021/0022/0001/0005）的间接论证：它们全部在 2026-10-14 及之前应用；此后用户先后运行过多个版本（含 3.16.3）均通过 checksum 校验（校验每次启动都跑）；若 3.16.2 源码的这些迁移 SQL 与账本不一致，意味着上游在开源快照与闭源版本间分叉了**冻结迁移**——上游自己在 `migrations.ts:986`、`legacy.ts:59-60`、`migration-v6.ts:1` 反复声明这些 SQL 冻结不可改（改了会炸所有老用户）。可能性可判定为极低。

### 1.4 数据形态层：新版本写入的新字段

- 会话/消息 `data` 列（JSON）解码是宽松的：`JSON.parse` + 解构透传，无 strict zod（`apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts:86-119`），源码注释明确考虑过「迁移/回滚后缺字段不能阻断协议读取」。3.16.3 写入的新字段被 3.16.2 读到时：透传忽略；**风险是降级使用期间若旧版写回该行，不认识的字段会丢**（渐进损耗，不炸）。
- `setting.json`：schema 校验失败时**回退默认设置继续启动**（`packages/services/src/setting/settingService.ts:139-147`），不会阻断；但降级期间修改设置再保存，3.16.3 新增的设置键会被抹掉。
- `bot-config.v3.json` 等 v3 版本化文件：3.16.2 源码同期（v3 文件 10-10 已在，源码 10-20 sync），无代差。
- 桌面与 CLI 共享同一 `~/.zcode`（`packages/services/src/node.ts:1385` 注释明确桌面服务查 `cli/db/db.sqlite`），无双份状态问题。

### 1.5 结论与残余风险

**结论：以 2026-10-27 库状态，3.16.2 打开 3.16.3 写过的数据是安全的**——迁移层零执行（清单全应用）、checksum 全匹配、schema 无超集列、数据解码宽松。

残余风险（低概率，须知晓）：
1. 若未来上游（3.16.4+）新增迁移且用户先升级再降回本补丁版：迁移残留仍不会报错（机制容忍），但若上游同时**修改**已冻结迁移的 SQL，则 `MigrationChecksumError` 会阻断启动——届时重跑本报告 §1.3 的比对即可判定，备份可整体恢复。
2. 降级使用期间：新版新设置项会被旧版保存动作抹掉；消息行被旧版写回会丢新版新增字段。规避：补丁版试用期内尽量不做设置变更；正式版仍保留（方案 A）时无此顾虑。

## 2. 登录与凭据

### 2.1 登录态存在哪

| 数据 | 位置 | 随 app 替换保留？ |
|---|---|---|
| OAuth/API 凭据（access_token 等） | `~/.zcode/v2/credentials.json`（`packages/services/src/credential/credentialService.ts:31-33`，key 形如 `oauth:zai:access_token`，`packages/services/src/oauth/oauthService.ts:1037`） | **是**——在 `getAppConfigDir()`（`packages/services/src/paths.ts:55-58`），与 app 无关 |
| 凭据加密 | AES-256-GCM，密钥 = `sha256(ZCODE_CREDENTIAL_SECRET 环境变量 ‖ "zcode-credential-fallback:{platform}:{homedir}:{username}")`（`packages/services/src/credential/providers/credentialCipherProvider.ts:20-38`） | **是**——密钥纯本机派生，**不用钥匙串、不用代码签名**；同机同用户恒定 |
| Electron userData（窗口状态、remote-assets-cache、站点权限等） | `~/Library/Application Support/ZCode`（production）／`ZCode Preview`（preview），`packages/desktop/src/main/desktopRuntimeEnv.ts:65-82` | production 原地替换：**保留**（productName 不变）；Preview 并存：独立目录，首启重建（仅窗口布局等，不影响登录） |
| macOS 钥匙串 | **未使用**（全仓 grep safeStorage/keychain 仅命中一条「后续可切换」注释，credentialService.ts:23） | 不适用 |

**Preview 并存也保留登录态**：上游自己的注释写明「Preview 与生产版共享任务、配置和凭据，但不同版本的 Helper 不能互相覆盖……不改写 ZCODE_HOME / ZCODE_DATA_BASE_DIR 业务数据根」（`packages/desktop/src/main/desktopRuntimeEnv.ts:576-578`）——这是官方支持的形态，不是我们蹭出来的巧合。

### 2.2 未签名 / ad-hoc 签名的系统影响

- **钥匙串授权弹窗：无**。凭据不进钥匙串（§2.1）。
- **Gatekeeper**：本地构建产物无 quarantine 属性，拷入 /Applications 不触发 Gatekeeper 拦截（install 脚本仍会 `xattr -dr com.apple.quarantine` 兜底）。
- **TCC 权限（辅助功能 / 录屏，CUA 功能用）**：绑定应用签名身份。官方签名（8A5X4JJ39T）→ 未签名/ad-hoc 替换后，已授予的辅助功能/录屏授权失效（`packages/desktop/src/main/cuaAccessibilitySettings.ts:70` 的 accessibility/screen_recording 授权链路），用户下次使用 CUA 时需在系统设置重新授权。**不用 CUA 则完全无感**。
- **ad-hoc vs 不签**：install 脚本默认 ad-hoc 重签（`codesign --force --deep --sign -`）。ad-hoc 给 app 一个稳定的本机身份，TCC/「隐私与安全性」记录有锚点；每次重新安装 ad-hoc 签名会变，TCC 需重授权（与不签的差别不大，主要收益是系统各处行为更一致）。
- **computer-use Helper**：CUA helper 只在「真实 producer」安装时随包（`packages/desktop/electron-builder.config.js:68-70` 的 `isRealComputerUseProducerInstalled`），开源构建若未配置该私有 producer，包内无 helper——**若用户依赖 CUA，开源构建可能缺 CUA 运行时**，需要实机验证（已在 §7 挂账）。

## 3. 强制升级门

### 3.1 触发逻辑（源码）

`packages/desktop/src/main/index.ts:2521-2532`：`ZCODE_PRODUCT_FLAVOR === "production" && app.isPackaged` 时，启动即调 `maybeBlockStartupForForceUpdate`：

- 拉 `https://zcode.z.ai/api/v1/client/configs?app_version=<版本>&platform=<平台>`（`packages/desktop/src/main/forceUpdateGuard.ts:45-54`，10 秒超时）。
- **拉取失败（断网/超时/非 2xx）→ 跳过校验放行**（forceUpdateGuard.ts:175-179，注释「完全离线时先不拉闸」）。
- configs 里 `forceUpdate.minimalVersion`（键名见 `packages/shared/src/remoteAppConfig.ts:80-94`）> 当前版本（semver 严格比较，`packages/shared/src/forceUpdate.ts:119-137`）→ 弹窗「需要升级 ZCode」→ 用户只能升级或退出，**不进主界面**（forceUpdateGuard.ts:241-253）。
- Preview 身份：**官方代码显式跳过**（index.ts:2533-2534「Preview 跳过远端强制升级检查」）。

### 3.2 当前服务端实测（2026-10-27）

`curl https://zcode.z.ai/api/v1/client/configs?app_version=3.16.2&platform=darwin-arm64`：`data.configs` 全量下发内容中**没有 `forceUpdate` 键**（captcha/offPeak/pluginStoreOrder 等键齐全，无版本门槛）。`getForceUpdateMinimalVersionFromConfig` 对无键返回 undefined → 不拦。**3.16.2 当前可以正常连生产后端启动。**

风险敞口：这是服务端开关，随时可下发 `minimalVersion: "3.16.3"`（或更高）——那一刻起 production 身份的补丁版启动即被拦（除非断网）。**`ZCODE_AUTO_UPDATE=0` 关不掉这道门**：它只管自动更新器（`index.ts:2209` `enabled: flavor==="production" && ZCODE_AUTO_UPDATE_ENABLED`），强更门是独立逻辑，只看 flavor + isPackaged。

### 3.3 构建期合规规避路径（不改业务代码）

| 路径 | 做法 | 评价 |
|---|---|---|
| **Preview 身份**（推荐） | `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1`（`desktop-product-identity.mjs:40-68`） | 官方支持的构建形态（连生产后端的 Preview 包）；强更门、自动更新双双显式跳过；登录/数据共享（§2.1）。代价：应用名「ZCode Preview」、独立 userData/图标位置、cuaHelper 装隔离目录 |
| 断网/hosts 屏蔽 zcode.z.ai | 网络层干扰 | **不推荐**：配置拉取失败虽会放行，但登录、模型调用全依赖该域，屏蔽等于废掉应用 |
| `ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA=1` 等 e2e 变量 | 运行期环境变量 | 不影响强更门（只管 userData 路径），无效 |

### 3.4 若必须改代码（最小改法，供派发者决策，本任务未改）

最小 diff 是在 `packages/desktop/src/main/index.ts:2522-2523` 的进入条件上增加一个**构建期**开关（与 `ZCODE_AUTO_UPDATE` 同模式：`scripts/build-time-config.mjs` 加 `ZCODE_SKIP_FORCE_UPDATE` → vite/tsup define 注入 `__ZCODE_SKIP_FORCE_UPDATE__` → index.ts 条件 `&& !__ZCODE_SKIP_FORCE_UPDATE__`）。三处小改，语义与上游现有构建期开关一致，补丁冲突面小。**不建议**做成运行期环境变量——production 包读 shell 环境会引入被误开启的面（上游对 `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL` 的处理就是这个先例，`desktopRuntimeEnv.ts:550-555` 打包态显式删除）。

### 3.5 「版本号标成 3.16.3」的做法：不推荐

把补丁版 `package.json` 版本号改成 3.16.3 来「骗过」强更门，问题不在能不能骗过（能），在代价：

1. **服务端按 `app_version` 下发配置与灰度**（§3.1 的请求就带该参数）：一个 3.16.2 代码的客户端持续领取 3.16.3 的服务端行为配置（新开关、新灰度、新字段），上游正是为了防这种客户端/服务端错配才设强更门——错配面（新配置触发旧代码路径）不可枚举。
2. **遥测/报障/日志全标 3.16.3**：与真实 3.16.3 无法区分，出问题排查与上游反馈都失真。
3. **每次上游 sync 必然冲突**：上游 bump 到 3.16.4 时，`sync-upstream.sh` 的 cherry-pick/合并每次都要手工处理版本号。
4. 与 Preview 方案相比没有任何独占收益——Preview 已经做到「连生产后端 + 跳过强更门 + 保留登录」且是官方形态。

若派发者评估后仍选 production 原地替换，正确姿势是**保持 3.16.2 真实版本号**接受强更门敞口（当前未下发），把 §3.4 的最小改法作为补丁的一部分交由补丁子任务实现。

## 4. 构建链路事实（脚本设计依据）

- 打包入口：`pnpm bundle:desktop`（根 `package.json:55`）→ `packages/desktop/scripts/bundle.mjs`：`pnpm prepare:runtime-assets` → `pnpm build` → `electron-builder --config electron-builder.config.js --mac --arm64` → asar 依赖闭包/越界 native 机械校验 → 体积审计（bundle.mjs:700-745）。默认 mac/arm64，无需传参。
- **unpacked .app 直接可用**：`packages/desktop/dist/mac-arm64/ZCode.app`（`bundle.mjs:607-620` 的路径规则），install 脚本可直接吃 .app，不必挂 dmg。
- 身份由构建进程环境变量决定（bundle.mjs:45 `resolveDesktopProductIdentity(process.env)`），**必须显式 `ZCODE_ENV=production`**（缺省按 test 处理 → Preview 身份 + 测试后端内置 provider 配置，`scripts/builtin-provider-config.mjs:14-45`、`desktop-product-identity.mjs:59-63`）。
- `ZCODE_AUTO_UPDATE` 在 `pnpm build` 阶段经 vite/tsup define 注入（`packages/desktop/vite.config.ts:15-19`、`tsup.config.ts:14-19`）；开源仓库无私有默认值文件，不设即关闭（`scripts/build-time-config.mjs:16-27` ENOENT 返回空对象）——显式置 0 出于确定性。
- macOS 签名默认关闭：`ZCODE_ENABLE_MAC_SIGN=1` 且有身份才签（`electron-builder.config.js:59-62`），`identity: null`（`:833`）、`notarize: false`（`:837`）——开源本地构建即未签名包。
- Node 24.14.0 + pnpm 10.33.2（`mise.toml:3-4`）；`pnpm install` 后直接 `bundle:desktop` 即可（bundle 内部自带 prepare+build，无需 `pnpm bootstrap`——bootstrap 面向 dev 场景，`README.md:31`）。
- Electron 二进制下载默认走 npmmirror 镜像（`bundle.mjs:125` DEFAULT_ELECTRON_MIRROR），国内网络友好。

## 5. 推荐方案与回滚

### 方案 A（默认推荐）：Preview 身份并存

构建：`ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 ZCODE_AUTO_UPDATE=0`。

- 正式版 3.16.3 原封不动留在 `/Applications/ZCode.app`——**回退 = 打开正式版**，零操作。且 3.16.3 读 3.16.2 写过的库是向前方向（清单相同、checksum 相同，已验证），并存期间两边交替写共享库无降级方向的风险。
- 强更门/自动更新官方代码显式跳过，无需改一行代码，服务端任何下发都拦不住。
- 登录态/任务/凭据共享（官方设计），首次打开 Preview 即已登录、历史任务全在。
- 代价：多一个「ZCode Preview」应用；窗口布局等桌面态首启重建；CUA helper 装 preview 隔离目录（首次用 CUA 需重授权——反正签名已变，本来也要）。

### 方案 B（可选）：production 原地替换

构建：`ZCODE_ENV=production ZCODE_AUTO_UPDATE=0`，install 替换 `/Applications/ZCode.app`（旧包 mv 到备份区）。

- 体验与正式版完全一致（原名原位原图标）。
- 接受三个敞口：强更门（服务端下发即拦，唯一缓解=断网或 §3.4 补丁）；官方签名丢失（TCC 重授权）；开源包若缺 CUA producer 则 CUA 不可用。
- 回滚：`patch/rollback-desktop.sh` 从备份区恢复旧 .app（数据不动——正式版读 3.16.2 写的数据为向前方向，安全）。

### 回滚（两案通用）

1. **应用回滚**：`patch/rollback-desktop.sh`（方案 B）；方案 A 直接打开正式版即可。
2. **数据回滚**（仅在数据异常时）：停 ZCode → 用 `zcode-backups/<时间戳>/` 里的 `sqlite3 .backup` 快照覆盖 `~/.zcode` 对应文件（`manifest.json` 有每个文件的 method 与 sha256，`shasum -c sha256sums.txt` 先校验备份完整性）。数据回滚是**覆盖用户数据**的高风险动作，工具链只提供备份与校验，不自动执行。

## 6. 身份方案决策表（给派发者）

| 维度 | A：Preview 并存（脚本默认） | B：production 原地替换 |
|---|---|---|
| 强更门 | 显式跳过（官方代码） | 暴露（当前未下发，未来不可控） |
| 自动更新 | 跳过（不会自升级覆盖补丁版） | 需 ZCODE_AUTO_UPDATE=0 关闭 |
| 登录态 | 共享保留 | 保留 |
| 回退成本 | 打开正式版即回退 | rollback-desktop.sh 一步 |
| 用户观感 | 两个应用并存 | 与正式版无异 |
| 需要改 ZCode 代码 | 否 | 建议加 §3.4 开关否则赌服务端 |
| 签名/TCC | 均失效（与 B 同） | 同左 |

## 7. 挂账（实机验证项，本座位无法执行）

- 开源构建产物在真机的实际启动（本座位无法运行图形应用）：首启是否要求任何授权、Preview 包首次打开行为。
- CUA helper 是否随开源构建打包（`isRealComputerUseProducerInstalled` 在无私有 producer 时的结果）——若用户用 CUA，装前验证。
- 强更门在补丁版上的实测（Preview 应见日志「[force-update] Preview 跳过远端强制升级检查」，`index.ts:2534`）。
- 3.16.2 客户端对 3.16.3 期间新增服务端配置键的容忍度（当前 configs 无版本门槛，风险低）。

## 附：调查方法与可复现命令

- 迁移账本读取：`sqlite3 -readonly ~/.zcode/cli/db/db.sqlite "SELECT id,checksum,app_version FROM schema_migration ORDER BY id;"`（tasks-index 同法，两个账本表）。
- checksum 复算：`node patch/verify-migration-checksums.mjs /Users/weidwonder/projects/ZCode`（本仓工具；上游更新后替换安装前 MUST 重跑，exit 0 才继续）。
- 服务端配置：`curl -sS "https://zcode.z.ai/api/v1/client/configs?app_version=3.16.2&platform=darwin-arm64"`。
- 已装版本元数据：`plutil -extract CFBundleShortVersionString raw /Applications/ZCode.app/Contents/Info.plist` → 3.16.3（CFBundleVersion 3.16.3.8992，dev.zcode.app）。
