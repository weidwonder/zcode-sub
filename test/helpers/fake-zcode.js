import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// 假 ZCode 本机任务 API：按契约 v2 模拟（/health、/api/tasks 全家、Bearer+Host
// 校验、每任务事件队列与长轮询、resync 溢出），供测试驱动 src/api.js。
// 控制方法（用例驱动）：createTaskAlreadyRunning / emitEvent / setTaskStatus /
// setLastAssistantText / createdTasks / calls / simulateResync / stop。

const MAX_WAIT_MS = 30_000;

export async function startFakeZcode({ token = "test-token", port: listenPort = 0, zcodeVersion = "test-1.0.0" } = {}) {
  const calls = []; // 非 health 请求的 {method,url,headers,body}
  const tasks = new Map(); // taskId -> 任务对象（含事件队列与 seq 计数器）
  const resyncPending = new Set(); // 下一次 events 请求要返回 {resync:true} 的 taskId
  const sockets = new Set();
  let commandCounter = 0;
  let port = listenPort;
  let shuttingDown = false;

  const newTask = (workspacePath, title) => ({
    taskId: randomUUID(),
    workspacePath,
    title: typeof title === "string" ? title : "",
    status: "idle", // createTaskAlreadyRunning 之前 messages 一律走 sent
    turnCount: 0,
    lastAssistantText: "",
    updatedAt: Date.now(),
    seq: 0,
    events: [],
    waiters: new Set(), // 挂起中的长轮询唤醒器
  });

  const appendEvent = (task, type, payload = {}) => {
    task.seq += 1;
    const event = { seq: task.seq, type, at: Date.now(), ...payload };
    task.events.push(event);
    task.updatedAt = event.at;
    const waiters = [...task.waiters];
    task.waiters.clear();
    for (const wake of waiters) wake();
    return event;
  };

  const collectEvents = (task, after) => {
    const events = task.events.filter((event) => event.seq > after);
    return { events, nextSeq: events.length ? events.at(-1).seq : after };
  };

  const json = (response, status, payload) => {
    if (shuttingDown || response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  const taskNotFound = (response) => json(response, 404, { error: "task_not_found" });

  const handle = async (request, response, bodyText) => {
    try {
      const [pathname, search = ""] = request.url.split("?");
      const query = new URLSearchParams(search);
      const method = request.method ?? "GET";

      // Content-Type 非 application/json 的 POST → 400；非 JSON body → 400
      let body = {};
      if (method !== "GET") {
        const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim();
        if (contentType !== "application/json") {
          json(response, 400, { error: "bad_content_type" });
          return;
        }
        if (bodyText) {
          try {
            body = JSON.parse(bodyText);
          } catch {
            json(response, 400, { error: "bad_json" });
            return;
          }
        }
      }

      // /health 不鉴权也不记入 calls
      if (method === "GET" && pathname === "/health") {
        json(response, 200, { ok: true, api: "zcode-local-task-api", version: 2, zcodeVersion });
        return;
      }

      calls.push({ method, url: request.url, headers: request.headers, body });

      if (request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const host = String(request.headers.host ?? "");
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        json(response, 403, { error: "bad_host" });
        return;
      }

      if (method === "POST" && pathname === "/api/tasks") {
        if (body.workspacePath === "/workspace-closed") {
          json(response, 409, { error: "workspace_not_open" });
          return;
        }
        const task = newTask(body.workspacePath, body.title);
        tasks.set(task.taskId, task);
        json(response, 201, { taskId: task.taskId });
        return;
      }

      const messagesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/u);
      if (method === "POST" && messagesMatch) {
        const task = tasks.get(messagesMatch[1]);
        if (!task) {
          taskNotFound(response);
          return;
        }
        task.updatedAt = Date.now();
        const delivery = body.delivery ?? "auto";
        if (task.status === "running") {
          commandCounter += 1;
          appendEvent(task, delivery === "steer" ? "input.steered" : "input.queued");
          json(response, 202, { delivery: delivery === "steer" ? "steered" : "queued", commandId: `cmd-${commandCounter}` });
          return;
        }
        task.turnCount += 1;
        appendEvent(task, "turn.started");
        json(response, 202, { delivery: "sent" });
        return;
      }

      const stopMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/u);
      if (method === "POST" && stopMatch) {
        const task = tasks.get(stopMatch[1]);
        if (!task) {
          taskNotFound(response);
          return;
        }
        task.updatedAt = Date.now();
        json(response, 202, { ok: true });
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/u);
      if (method === "GET" && eventsMatch) {
        const task = tasks.get(eventsMatch[1]);
        if (!task) {
          taskNotFound(response);
          return;
        }
        if (resyncPending.delete(eventsMatch[1])) {
          json(response, 200, { resync: true });
          return;
        }
        const after = Number.parseInt(query.get("after") ?? "0", 10) || 0;
        const waitMs = Math.min(Math.max(Number.parseInt(query.get("waitMs") ?? "0", 10) || 0, 0), MAX_WAIT_MS);
        let page = collectEvents(task, after);
        if (page.events.length === 0 && waitMs > 0) {
          // 长轮询：挂 waitMs 毫秒，期间有新事件（含本请求挂起中到达的）立即唤醒
          await new Promise((resolve) => {
            const wake = () => {
              clearTimeout(timer);
              task.waiters.delete(wake);
              resolve();
            };
            const timer = setTimeout(wake, waitMs);
            task.waiters.add(wake);
          });
          page = collectEvents(task, after);
        }
        json(response, 200, { events: page.events, nextSeq: page.nextSeq });
        return;
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/u);
      if (method === "GET" && taskMatch) {
        const task = tasks.get(taskMatch[1]);
        if (!task) {
          taskNotFound(response);
          return;
        }
        json(response, 200, {
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          title: task.title,
          status: task.status,
          turnCount: task.turnCount,
          lastAssistantText: task.lastAssistantText,
          updatedAt: task.updatedAt,
        });
        return;
      }

      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 500, { error: "internal", message: String(error) });
    }
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      void handle(request, response, Buffer.concat(chunks).toString("utf8"));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });

  return {
    get port() {
      return port;
    },
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    createTaskAlreadyRunning(taskId) {
      const task = tasks.get(taskId);
      if (task) {
        task.status = "running";
        task.updatedAt = Date.now();
      }
    },
    emitEvent(taskId, type, payload = {}) {
      const task = tasks.get(taskId);
      return task ? appendEvent(task, type, payload) : null;
    },
    setTaskStatus(taskId, status) {
      const task = tasks.get(taskId);
      if (task) {
        task.status = status;
        task.updatedAt = Date.now();
      }
    },
    setLastAssistantText(taskId, text) {
      const task = tasks.get(taskId);
      if (task) {
        task.lastAssistantText = text;
        task.updatedAt = Date.now();
      }
    },
    get createdTasks() {
      return Object.fromEntries(
        [...tasks.values()].map((task) => [
          task.taskId,
          { workspacePath: task.workspacePath, title: task.title, status: task.status },
        ]),
      );
    },
    simulateResync(taskId) {
      resyncPending.add(taskId);
    },
    stop() {
      shuttingDown = true;
      for (const task of tasks.values()) {
        for (const wake of [...task.waiters]) wake();
      }
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(() => done()));
    },
  };
}
