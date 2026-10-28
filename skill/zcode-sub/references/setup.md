# zcode-sub 安装与一次性配置

> 读取条件见 SKILL.md「排障路由」——本篇只在那些情况下读。本工具是外部 CLI，与 ZCode 桌面版同机安装；支持 macOS（其他平台未验证）；面向 Claude Code 使用。

## 1. 安装 CLI

要求 Node ≥ 22。优先「绝对路径 + shim」（`npm link` 会写全局 bin 目录，次选）。四步：

1. 向用户确认 zcode-sub 仓库路径（本工具不发布 npm，本地路径或 URL）；
2. `node --version` 确认 ≥ 22；
3. 按 §5 模板建 shim——统一用 setup 报错输出的模板或 §5 模板，不要自己另写一份（家目录未被重定向时可省略两行 export）；
4. `command -v zcode-sub && zcode-sub --version` 验证。

ZCode 桌面版需已装「本机任务 API」补丁：setup 健康检查报 `zcode_health_mismatch` 且用户已重启过 ZCode 仍不过 → **停下，告知用户这台 ZCode 没装补丁、本工具无法使用**，不要继续尝试。

## 2. 一次性配置：zcode-sub setup

跑 setup 前先征得用户同意——开关文件不存在或未启用时它会写 <真实家目录>/.zcode/v2/local-task-api.json（属于改 ZCode 配置），且写完需要重启 ZCode；不能确认该文件已存在且 enabled:true 时一律先问。setup 打印「将要写的路径与内容摘要（token 只露前 4 位）」后**立即写入**，没有预览模式。确认开关文件状态可只读 enabled 字段（如 `node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).enabled)' <路径>`），不要整份读出 token。

- 检查/写开关文件 `<真实家目录>/.zcode/v2/local-task-api.json`（**不是 `$HOME`**——HOME 被重定向的环境先看 §5；不确定 `<真实家目录>` 时向用户询问登录用户名或家目录，不要猜）；写完需重启 ZCode 生效（重启由用户执行——Agent 不自行结束或重启 ZCode 进程，告知用户后等用户操作）；
- 健康检查应见「✓ 本机任务 API 正常」；
- 打印 MCP 配置片段（§4）。

目录不可写：让用户为该目录授权——环境提供 `dwc grant` 命令时用它（CLI 提示的 `dwc grant` 只在该命令存在的环境有效），否则请用户自行修正目录权限——之后重跑 setup（同上）。

## 3. 连不上 API（zcode_api_unreachable）

按顺序排查：
1. 问用户 ZCode 桌面版是否开着（没开 → 请用户启动）；
2. 刚写过开关文件 → 请用户重启 ZCode 后重试；
3. 报 503 unavailable_host（窗口已关闭或 ZCode 正在重启）→ 稍等片刻重试；
4. 仍不通 → 跑 zcode-sub setup（先按 §2 的口径确认或征得同意）看健康检查输出，按 §1 的补丁判断处理。

## 4. 把 reply_to_parent 配进 ZCode（否则子代理无法主动汇报，症状是永远收不到 [reply] 行）

- 将 setup 打印的片段合入 `<真实家目录>/.zcode/cli/config.json` 的 `mcp.servers`（桌面版与 CLI 共用该文件，ZCode 实时加载，无需重启；子代理首次调用工具会弹权限确认；需 `features.mcp` 开启）。**改用户配置文件前先征得用户同意。**
- 片段中 `command` 用 setup 打印的**绝对路径**（GUI 拉起的进程不一定能在 PATH 找到 node），原样复制，不要手打成 `"node"`。
- 片段 `env.ZCODE_SUB_HOME` 必须与你跑 zcode-sub 命令时的值一致——不一致时子代理调 reply_to_parent 报「任务不在登记表」，父侧只看到永远收不到 `[reply]`。

## 5. HOME 被重定向的环境（座位/容器常见）

症状任一：`EACCES … /var/empty/...`；`list` 为空但 ZCode GUI 里明明有任务；setup 报「✗ 状态目录不可写且未设置 ZCODE_SUB_HOME」。

解法：设两个环境变量，**每条 zcode-sub 命令都要带**——

- `ZCODE_SUB_HOME`：本工具状态目录（任务登记与信箱）；
- `ZCODE_DATA_BASE_DIR`：ZCode 数据目录基目录（从这里找开关文件）。

建议按 setup 报错输出的 shim 模板做成包装脚本放 PATH——与 setup 输出的模板同源，二选一即可，落点如下：

存为 `~/.local/bin/zcode-sub`（该目录需在 PATH 中），chmod +x 后 `command -v zcode-sub` 验证：

```bash
#!/bin/bash
export ZCODE_SUB_HOME=/Users/<你的用户名>/.zcode-sub
export ZCODE_DATA_BASE_DIR=/Users/<你的用户名>
exec <仓库路径>/bin/zcode-sub.js "$@"
```

工作区要求：`--cwd` 须为本机存在的目录绝对路径——未打开时 ZCode 会自动在当前窗口加该目录的标签页（无确认弹窗，最长等 30 秒）；远端路径或自动打开失败 → exit 3（详见 troubleshooting 码表）。
