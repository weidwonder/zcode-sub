import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { pathsOf } from "./home.js";
import { loadConfig } from "./config.js";
import { getCurrentTask, getTask } from "./tasks.js";
import { appendMailbox } from "./mailbox.js";

// 常驻 daemon：只收两类入站请求——
//   POST /zcode/outbound  ZCode webhook bot 的出站回调，按 bot 当前任务落信箱
//   POST /internal/reply  MCP reply_to_parent，按 task 参数落信箱
// 只绑 127.0.0.1；所有入口先校验 x-zcode-bot-secret，不符 401 且零副作用。

const MAX_BODY_BYTES = 1024 * 1024;

export function startDaemon(home, configOverride) {
  const config = configOverride ?? loadConfig(home);
  const paths = pathsOf(home);
  const log = (level, event, fields = {}) => {
    const line = [
      new Date().toISOString(),
      level,
      event,
      ...Object.entries(fields).map(([key, value]) => `${key}=${String(value).slice(0, 500)}`),
    ].join(" ");
    try {
      appendFileSync(paths.daemonLog, `${line}\n`);
    } catch {
      process.stderr.write(`${line}\n`);
    }
  };

  const server = createServer((request, response) => {
    handleRequest({ home, config, log, request, response });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.daemonPort || 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.daemonPort;
      log("info", "daemon_started", { pid: process.pid, port });
      resolve({ server, port });
    });
  });
}

async function handleRequest({ home, config, log, request, response }) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (request.method !== "POST" && url.pathname !== "/internal/health") {
      respond(response, 404, { error: "not_found" });
      return;
    }
    if (url.pathname === "/internal/health" && request.method === "GET") {
      respond(response, 200, { ok: true, pid: process.pid, daemonPort: config.daemonPort });
      return;
    }
    // 全部 POST 入口统一鉴权：先于一切读写（安全不变量 2）。
    const secret = request.headers["x-zcode-bot-secret"];
    if (typeof secret !== "string" || secret !== config.secret) {
      log("warn", "secret_mismatch", { path: url.pathname });
      respond(response, 401, { error: "zcode_secret_mismatch" });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      respond(response, 413, { error: "payload_too_large" });
      return;
    }
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      respond(response, 400, { error: "payload_error" });
      return;
    }
    if (url.pathname === "/internal/reply") {
      handleInternalReply({ home, payload, response, log });
      return;
    }
    if (url.pathname === "/zcode/outbound") {
      await handleOutbound({ home, config, payload, response, log });
      return;
    }
    respond(response, 404, { error: "not_found" });
  } catch (error) {
    log("error", "handler_failed", { path: url.pathname, error: error?.message });
    if (!response.headersSent) respond(response, 500, { error: "internal" });
    else response.destroy();
  }
}

function handleInternalReply({ home, payload, response, log }) {
  const task = typeof payload.task === "string" ? payload.task : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  if (!task || !message) {
    respond(response, 400, { error: "payload_error" });
    return;
  }
  if (!getTask(home, task)) {
    log("warn", "reply_unknown_task", { task });
    respond(response, 404, { error: "task_not_found" });
    return;
  }
  const seq = appendMailbox(home, task, { kind: "reply", text: message });
  log("info", "reply_recorded", { task, seq });
  respond(response, 200, { ok: true, seq });
}

async function handleOutbound({ home, config, payload, response, log }) {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "zcode.bot.test") {
    log("info", "test_ping", {});
    respond(response, 204);
    return;
  }
  if (payload.botId !== config.botId || payload.userId !== config.userId) {
    // 非本桥接配置的 bot/user：不落信箱，防串台；204 让上游不重试。
    log("warn", "outbound_ignored", { botId: payload.botId, userId: payload.userId, type });
    respond(response, 204);
    return;
  }
  const task = getCurrentTask(home);
  if (!task) {
    log("warn", "outbound_no_current_task", { type });
    respond(response, 204);
    return;
  }
  const seq = appendMailbox(home, task, {
    kind: "outbound",
    text: typeof payload.text === "string" ? payload.text : "",
    raw: payload,
  });
  log("info", "outbound_recorded", { task, seq, type });
  respond(response, 204);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respond(response, status, body) {
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? {}));
}
