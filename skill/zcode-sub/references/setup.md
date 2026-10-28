# zcode-sub 安装与一次性配置

> 读取条件见 SKILL.md「排障路由」——本篇只在那些情况下读。本工具是外部 CLI，与 ZCode 桌面版同机安装；支持 macOS（其他平台未验证）；面向 Claude Code 使用。

## 1. 安装 CLI

要求 Node ≥ 22。优先「绝对路径 + shim」（`npm link` 会写全局 bin 目录，次选）：

```bash
zcode-sub --version   # 已可用（输出 zcode-sub x.y.z）则跳过安装
command -v zcode-sub  # 确认当前 Bash 环境找得到
```

shim 统一用 setup 报错输出的模板，或第 5 节的模板（见下）——不要自己另写一份。

仓库来源不确定时向用户确认（本地路径或 URL）——本工具不发布 npm。ZCode 桌面版需已装「本机任务 API」补丁：setup 健康检查报 `zcode_health_mismatch` 且用户已重启过 ZCode 仍不过 → **停下，告知用户这台 ZCode 没装补丁、本工具无法使用**，不要继续尝试。

## 2. 一次性配置：zcode-sub setup

首次运行 setup 前先征得用户同意——它会写 ZCode 侧开关文件（属于改 ZCode 配置），且写完需要重启 ZCode。

- 检查/写开关文件 `<真实家目录>/.zcode/v2/local-task-api.json`（**不是 `$HOME`**——HOME 被重定向的环境先看第 5 节；不确定 `<真实家目录>` 时向用户询问登录用户名或家目录，不要猜）；写完需重启 ZCode 生效（重启由用户执行——Agent 不自行结束或重启 ZCode 进程，告知用户后等用户操作）；
- 健康检查应见「✓ 本机任务 API 正常」；
- 打印 MCP 配置片段（第 4 节）。

目录不可写：让用户为该目录授权（本座位环境即 `dwc grant <目录>`）后重跑。

## 3. 连不上 API（zcode_api_unreachable）

按顺序排查：
1. 问用户 ZCode 桌面版是否开着（没开 → 请用户启动）；
2. 刚写过开关文件 → 请用户重启 ZCode 后重试；
3. 报 503 unavailable_host（窗口已关闭或 ZCode 正在重启）→ 稍等片刻重试；
4. 仍不通 → 跑 zcode-sub setup 看健康检查输出，按 §1 的补丁判断处理。

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

```bash
# 存为 ~/.local/bin/zcode-sub（该目录需在 PATH 中），chmod +x 后 command -v zcode-sub 验证：
#!/bin/bash
export ZCODE_SUB_HOME=/Users/<你的用户名>/.zcode-sub
export ZCODE_DATA_BASE_DIR=/Users/<你的用户名>
exec /Users/<你的用户名>/projects/zcode-sub/bin/zcode-sub.js "$@"
```

工作区要求：`run --cwd` 的工作区必须已在 ZCode 打开（本地窗口）；未打开或为远端 → 409，请用户在 ZCode GUI 打开后再派发。
