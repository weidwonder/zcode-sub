import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { registerTask } from "../src/tasks.js";
import { readMailboxLines } from "../src/mailbox.js";

// MCP server 不再有 daemon：spawn 真实入口（bin/zcode-sub.js mcp），
// 只用 ZCODE_SUB_HOME 指到临时 home，reply_to_parent 直接落信箱文件。

const BIN = join(import.meta.dirname, "..", "bin", "zcode-sub.js");

let home;
let child;
let nextId = 1;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const request = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "zcode-sub-mcp-"));
  registerTask(home, "mcp-1", { taskId: "t-1", workspacePath: "/tmp/ws" });
  child = spawn(process.execPath, [BIN, "mcp"], {
    env: { ...process.env, ZCODE_SUB_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
});

after(() => {
  child?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

test("initialize 与 tools/list", async () => {
  const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.equal(init.result.serverInfo.name, "zcode-sub");

  const tools = await send("tools/list");
  const tool = tools.result.tools.find((entry) => entry.name === "reply_to_parent");
  assert.ok(tool, "应有 reply_to_parent 工具");
  assert.deepEqual(tool.inputSchema.required, ["task", "message"]);
});

test("tools/call reply_to_parent 直接落信箱文件", async () => {
  const call = await send("tools/call", {
    name: "reply_to_parent",
    arguments: { task: "mcp-1", message: "主动汇报" },
  });
  assert.equal(call.result.isError, undefined);
  assert.match(call.result.content[0].text, /已投递给 mcp-1/u);
  const last = readMailboxLines(home, "mcp-1").at(-1);
  assert.equal(last.kind, "reply");
  assert.equal(last.text, "主动汇报");
});

test("未知 task 报 isError（登记表口径）且 server 不退出", async () => {
  const call = await send("tools/call", {
    name: "reply_to_parent",
    arguments: { task: "no-such", message: "x" },
  });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /不在 zcode-sub 登记表/u);
  // server 仍存活：再发一次 initialize 应有响应
  const again = await send("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(again.result.serverInfo.name, "zcode-sub");
});

test("缺 message 报 isError", async () => {
  const call = await send("tools/call", {
    name: "reply_to_parent",
    arguments: { task: "mcp-1" },
  });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /task 与 message 都必填/u);
});

test("未知工具名报 isError", async () => {
  const call = await send("tools/call", { name: "nope", arguments: {} });
  assert.equal(call.result.isError, true);
});
