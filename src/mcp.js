import { createInterface } from "node:readline";

// 最小 MCP stdio server（JSON-RPC 2.0）：单工具 reply_to_parent。
// 不用官方 SDK 的理由见 spec D-06：单工具、两个 method，依赖树不值。
// stdin/stdout 专用于协议；诊断写 stderr。

const PROTOCOL_VERSION = "2024-11-05";

export function runMcpServer({ daemonUrl, secret, stdin = process.stdin, stdout = process.stdout }) {
  const baseUrl = daemonUrl || process.env.ZCODE_SUB_DAEMON_URL || "http://127.0.0.1:47899";
  const token = secret || process.env.ZCODE_SUB_SECRET || "";
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
    handleRequest(message, writer, { baseUrl, token }).catch((error) => {
      writer({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error?.message ?? String(error) },
      });
    });
  });
  return new Promise((resolve) => rl.on("close", () => resolve()));
}

async function handleRequest(message, writer, { baseUrl, token }) {
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
              "给派发你的父代理（Claude Code）发消息：进度、阻塞、提问或最终总结。消息进入该任务的信箱，父代理的 zcode-sub wait 会收到。",
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
    const result = await callReplyToParent(args, { baseUrl, token });
    writer({ jsonrpc: "2.0", id, result });
    return;
  }
  writer({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

async function callReplyToParent(args, { baseUrl, token }) {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const message = typeof args.message === "string" ? args.message : "";
  if (!task || !message) {
    return { isError: true, content: [{ type: "text", text: "task 与 message 都必填" }] };
  }
  try {
    const response = await fetch(`${baseUrl}/internal/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zcode-bot-secret": token },
      body: JSON.stringify({ task, message }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      return {
        isError: true,
        content: [{ type: "text", text: `任务 "${task}" 不存在。检查任务文本开头给你的任务名后重试。` }],
      };
    }
    if (!response.ok) {
      return { isError: true, content: [{ type: "text", text: `daemon 返回 HTTP ${response.status}` }] };
    }
    const payload = await response.json();
    return {
      content: [{ type: "text", text: `已投递给 ${task}（seq=${payload.seq}）。父代理会用 wait/result 读取。` }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `连不上桥接 daemon（${baseUrl}）：${error?.message ?? error}` }],
    };
  }
}

function stderrLog(text) {
  process.stderr.write(`[zcode-sub-mcp] ${text}\n`);
}
