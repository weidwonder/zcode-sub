import { createInterface } from "node:readline";
import { getHome } from "./home.js";
import { appendReplyLine } from "./mailbox.js";
import { getTask } from "./tasks.js";

// 最小 MCP stdio server（JSON-RPC 2.0）：单工具 reply_to_parent。
// 不用官方 SDK 的理由见 spec D-06：单工具、两个 method，依赖树不值。
// 由 ZCode 桌面版以 stdio 拉起、以真实用户身份运行：reply_to_parent 直接把
// 消息追加进 ZCODE_SUB_HOME/mailboxes/<task>.jsonl 信箱文件（CLI 的 wait/result
// 读它），不再经过桥接 daemon。stdin/stdout 专用于协议；诊断写 stderr。

const PROTOCOL_VERSION = "2024-11-05";

export function runMcpServer({ stdin = process.stdin, stdout = process.stdout } = {}) {
  // 座位/服务环境的 HOME 常被重定向，home 定位只认 userInfo().homedir（见 home.js）
  const home = getHome();
  const writer = (payload) => stdout.write(`${JSON.stringify(payload)}\n`);

  const rl = createInterface({ input: stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      stderrLog(`non-json line ignored: ${trimmed.slice(0, 80)}`);
      return;
    }
    // notification（无 id）不回包
    if (message.id === undefined || message.id === null) return;
    handleRequest(message, writer, { home }).catch((error) => {
      writer({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error?.message ?? String(error) },
      });
    });
  });
  return new Promise((resolve) => rl.on("close", () => resolve()));
}

async function handleRequest(message, writer, { home }) {
  const { id, method } = message;
  if (method === "initialize") {
    writer({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "zcode-sub", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    writer({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "reply_to_parent",
            description:
              "给派发你的父代理（Claude Code）发消息：进度、阻塞、提问或最终总结。消息追加进该任务信箱，父代理的 zcode-sub wait 会收到。",
            inputSchema: {
              type: "object",
              properties: {
                task: { type: "string", description: "任务名（任务文本开头【zcode-sub 委托】里给你的名字）" },
                message: { type: "string", description: "要发给父代理的消息全文" },
              },
              required: ["task", "message"],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const tool = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (tool !== "reply_to_parent") {
      writer({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `unknown tool: ${tool}` }] },
      });
      return;
    }
    writer({ jsonrpc: "2.0", id, result: callReplyToParent(home, args) });
    return;
  }
  writer({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

// 直接追加进该任务信箱文件；写失败如实报错，server 不崩。
function callReplyToParent(home, args) {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const message = typeof args.message === "string" ? args.message : "";
  if (!task || !message) {
    return { isError: true, content: [{ type: "text", text: "task 与 message 都必填" }] };
  }
  if (!getTask(home, task)) {
    return {
      isError: true,
      content: [
        { type: "text", text: `任务 "${task}" 不在 zcode-sub 登记表里。检查任务文本开头给你的任务名后重试。` },
      ],
    };
  }
  try {
    appendReplyLine(home, task, message);
    return {
      content: [{ type: "text", text: `已投递给 ${task}。父代理会用 wait/result 读取。` }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `写入信箱失败：${error?.message ?? String(error)}` }],
    };
  }
}

function stderrLog(text) {
  process.stderr.write(`[zcode-sub-mcp] ${text}\n`);
}
