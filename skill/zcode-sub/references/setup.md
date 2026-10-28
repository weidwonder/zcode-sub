# zcode-sub 安装与一次性配置

> 读取条件：仅当 `zcode-sub` 命令不可用、或运行命令报 `zcode_not_configured` / 连不上 ZCode API 时才读本篇；正常使用不需要。

## 1. 安装 CLI

```bash
# 已部署本机时：进入 zcode-sub 仓库目录（可由 `which zcode-sub` 反查软链得到，或直接问用户）
cd <zcode-sub 仓库路径>
# 仓库来源不确定时：向用户确认仓库地址（本地路径或 URL）后再获取——本工具不发布 npm
npm link        # 或把仓库 bin/zcode-sub.js 加入 PATH，或直接用绝对路径调用 bin/zcode-sub.js
zcode-sub --help   # 验证
```

要求 Node ≥ 22；ZCode 桌面版已装「本机任务 API」补丁（契约 v2）。

## 2. 一次性配置（zcode-sub setup）

```bash
zcode-sub setup
```

它会：
1. 检查/写入 ZCode 侧开关文件 `~/.zcode/v2/local-task-api.json`（不存在时生成 token、以 0600 权限写入 `{"enabled":true,"port":47821,"token":…}`）——**写完必须重启 ZCode 生效**；已存在则读回 token/端口；
2. 健康检查本机任务 API（应见「✓ 本机任务 API 正常」）；
3. 打印把 MCP server 配进 ZCode 的 JSON 片段（写入位置见第 3 节：`~/.zcode/cli/config.json`）。

目录不可写时按 setup 输出的 `dwc grant <目录>` 提示授权后重跑。

## 3. 把 reply_to_parent 配进 ZCode（否则子代理无法主动汇报，症状是永远收不到 [reply] 行）

将 setup 打印的片段合入 ZCode 的 MCP 配置文件 **`~/.zcode/cli/config.json` 的 `mcp.servers`**（桌面版与 CLI 共用该文件，ZCode 实时加载，无需重启；子代理首次调用工具会弹权限确认；需 `features.mcp` 开启），形如：

```json
{
  "features": { "mcp": true },
  "mcp": { "servers": { "zcode-sub": {
    "type": "stdio",
    "command": "node",
    "args": ["/绝对路径/zcode-sub/bin/zcode-sub.js", "mcp"],
    "env": { "ZCODE_SUB_HOME": "/用户家目录/.zcode-sub" },
    "enabled": true
  } } }
}
```

（以 setup 实际打印为准——里面是当前机器的绝对路径。）配置后重启 ZCode；子代理在任务文本开头拿到的任务名即 `reply_to_parent` 的 task 参数。

## 4. 工作区要求

`run --cwd` 的工作区必须已在 ZCode 中打开（本地窗口）；未打开或为远端工作区 → 409 `zcode_workspace_not_open`，先在 GUI 打开再派发。
