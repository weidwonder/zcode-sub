import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { upsertTask } from "../src/tasks.js";
import { readMailbox } from "../src/mailbox.js";
import { startDaemon } from "../src/daemon.js";

const BIN = join(import.meta.dirname, "..", "bin", "zcode-sub.js");
const SECRET = "s1";

let home;
let daemon;
let daemonUrl;
let child;
let nextId = 1;
const pending = new Map();

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const request = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "zcode-sub-mcp-"));
  upsertTask(home, "mcp-1", { cwd: "/tmp", isCurrent: true });
  const daemonPort = await reservePort();
  daemon = await startDaemon(home, {
    botId: "bot-1",
    secret: SECRET,
    userId: "zcode-sub",
    daemonPort,
    ingressPort: 47821,
  });
  daemonUrl = `http://127.0.0.1:${daemonPort}`;
  child = spawn(process.execPath, [BIN, "mcp"], {
    env: { ...process.env, ZCODE_SUB_HOME: home, ZCODE_SUB_DAEMON_URL: daemonUrl, ZCODE_SUB_SECRET: SECRET },
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
  daemon?.server.close();
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

test("tools/call reply_to_parent 落信箱", async () => {
  const call = await send("tools/call", {
    name: "reply_to_parent",
    arguments: { task: "mcp-1", message: "MCP 主动汇报" },
  });
  assert.equal(call.result.isError, undefined);
  assert.match(call.result.content[0].text, /已投递给 mcp-1/u);
  const last = readMailbox(home, "mcp-1").at(-1);
  assert.equal(last.kind, "reply");
  assert.equal(last.text, "MCP 主动汇报");
});

test("未知 task 报 isError 但 server 不退出", async () => {
  const call = await send("tools/call", {
    name: "reply_to_parent",
    arguments: { task: "no-such", message: "x" },
  });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /不存在/u);
  // server 仍存活：再发一次 initialize 应有响应
  const again = await send("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(again.result.serverInfo.name, "zcode-sub");
});

test("未知工具报 isError", async () => {
  const call = await send("tools/call", { name: "nope", arguments: {} });
  assert.equal(call.result.isError, true);
});
