import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// 假 ZCode 本机任务 API：按契约 v2 模拟（/health、/api/tasks 全家、Host+Bearer+
// Content-Type+413 校验、每任务事件队列与长轮询、resync 溢出、归属表与游标回退），
// 供测试驱动 src/api.js。
// 校验顺序对齐 A 侧实装：路由级 404/405 → Host 403 → Bearer 401 → 415 → 413 → 400。
// 控制方法（用例驱动）：createTaskAlreadyRunning / emitEvent / setTaskStatus /
// setLastAssistantText / createdTasks / calls / simulateResync / forgetOwnership /
// resetEventSeq / stop。

const MAX_WAIT_MS = 30_000;
const MAX_BODY_CHARS = 16 * 1024 * 1024; // 413 阈值：16MiB

// 路由表：路径级 404/405 在鉴权之前判定
const ROUTES = [
  { method: "GET", re: /^\/health$/u },
  { method: "POST", re: /^\/api\/tasks$/u },
  { method: "POST", re: /^\/api\/tasks\/([^/]+)\/messages$/u },
  { method: "POST", re: /^\/api\/tasks\/([^/]+)\/stop$/u },
  { method: "GET", re: /^\/api\/tasks\/([^/]+)\/events$/u },
  { method: "GET", re: /^\/api\/tasks\/([^/]+)$/u },
];

export async function startFakeZcode({ token = "test-token", port: listenPort = 0, zcodeVersion = "test-1.0.0" } = {}) {
  const calls = []; // 非 health 请求的 {method,url,headers,body}
  const tasks = new Map(); // taskId -> 任务对象（含事件队列与 seq 计数器）
  const ownership = new Map(); // taskId -> workspacePath（A 侧归属表；forgetOwnership 模拟重启丢表）
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
    // 空页 nextSeq 取任务当前 seq：正常情况与 after 相等；resetEventSeq 游标回退后为 0，
    // B 侧游标随之回退而不是停在重启前的旧值。
    return { events, nextSeq: events.length ? events.at(-1).seq : Math.min(task.seq, after) };
  };

  const json = (response, status, payload) => {
    if (shuttingDown || response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  const taskNotFound = (response) => json(response, 404, { error: "task_not_found" });

  // 归属门（:taskId 四端点处理前先过）：ownership 命中 → 请求带 workspacePath 时须一致，
  // 未带放行；未命中（模拟 A 侧 ZCode 重启丢归属表）→ 请求带与任务自身归属一致的
  // workspacePath 才重绑放行（这正是 B 侧带 workspacePath 的意义），带错的 404
  // task_mismatch，没带则 404 task_not_found（A 侧无从路由）。
  const ownershipGuard = (response, taskId, requested) => {
    const owner = ownership.get(taskId);
    if (owner === undefined) {
      const task = tasks.get(taskId);
      if (task !== undefined && requested !== undefined) {
        if (requested === task.workspacePath) {
          ownership.set(taskId, requested);
          return true;
        }
        json(response, 404, { error: "task_mismatch" });
        return false;
      }
      taskNotFound(response);
      return false;
    }
    if (requested !== undefined && requested !== owner) {
      json(response, 404, { error: "task_mismatch" });
      return false;
    }
    return true;
  };

  const handle = async (request, response, bodyText) => {
    try {
      const [pathname, search = ""] = request.url.split("?");
      const query = new URLSearchParams(search);
      const method = request.method ?? "GET";

      // 1) 路径级 404/405 在鉴权之前：完全不认识的路径 404；认识但方法不对 405
      const pathMatches = ROUTES.filter((route) => route.re.test(pathname));
      if (pathMatches.length === 0) {
        json(response, 404, { error: "not_found" });
        return;
      }
      const route = pathMatches.find((candidate) => candidate.method === method);
      if (!route) {
        json(response, 405, { error: "method_not_allowed" });
        return;
      }
      const [, ...routeParams] = pathname.match(route.re);

      // /health 不鉴权也不记入 calls
      if (pathname === "/health") {
        json(response, 200, { ok: true, api: "zcode-local-task-api", version: 2, zcodeVersion });
        return;
      }

      // 非 health 请求都记入 calls（含被 401/403/415/413/400 拒掉的）；body 解析成功后回填
      const record = { method, url: request.url, headers: request.headers, body: {} };
      calls.push(record);

      // 2) Host 403：A 侧只收 127.0.0.1/localhost 的 Host
      const host = String(request.headers.host ?? "");
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        json(response, 403, { error: "bad_host" });
        return;
      }

      // 3) Bearer 401
      if (request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, { error: "unauthorized" });
        return;
      }

      // 4) Content-Type 415 → 5) 超 16MiB 413 → 6) JSON 解析失败 400
      let body = {};
      if (method !== "GET") {
        const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim();
        if (contentType !== "application/json") {
          json(response, 415, { error: "unsupported_media_type" });
          return;
        }
        if (bodyText && bodyText.length > MAX_BODY_CHARS) {
          json(response, 413, { error: "payload_too_large" });
          return;
        }
        if (bodyText) {
          try {
            body = JSON.parse(bodyText);
            record.body = body;
          } catch {
            json(response, 400, { error: "bad_json" });
            return;
          }
        }
      }

      // GET 端点从 query 取 workspacePath；POST 端点从 body 取
      const requestedWs = query.get("workspacePath") ?? undefined;

      if (method === "POST" && pathname === "/api/tasks") {
        // 未打开的工作区（远端工作区同码）→ 409
        if (body.workspacePath === "/workspace-closed" || body.workspacePath === "/workspace-remote") {
          json(response, 409, { error: "workspace_not_open" });
          return;
        }
        const task = newTask(body.workspacePath, body.title);
        tasks.set(task.taskId, task);
        ownership.set(task.taskId, task.workspacePath); // createTask 登记归属
        json(response, 201, { taskId: task.taskId });
        return;
      }

      const taskId = routeParams[0];

      if (pathname.endsWith("/messages")) {
        if (!ownershipGuard(response, taskId, body.workspacePath)) return;
        const task = tasks.get(taskId);
        if (!task) {
          taskNotFound(response);
          return;
        }
        task.updatedAt = Date.now();
        const delivery = body.delivery ?? "auto";
        if (task.status === "running") {
          commandCounter += 1;
          const commandId = `cmd-${commandCounter}`;
          appendEvent(task, delivery === "steer" ? "input.steered" : "input.queued", { commandId });
          json(response, 202, { delivery: delivery === "steer" ? "steered" : "queued", commandId });
          return;
        }
        task.turnCount += 1;
        appendEvent(task, "turn.started", { turnId: `turn-${task.turnCount}` });
        json(response, 202, { delivery: "sent" });
        return;
      }

      if (pathname.endsWith("/stop")) {
        if (!ownershipGuard(response, taskId, body.workspacePath)) return;
        const task = tasks.get(taskId);
        if (!task) {
          taskNotFound(response);
          return;
        }
        task.updatedAt = Date.now();
        json(response, 202, { ok: true });
        return;
      }

      if (pathname.endsWith("/events")) {
        if (!ownershipGuard(response, taskId, requestedWs)) return;
        const task = tasks.get(taskId);
        if (!task) {
          taskNotFound(response);
          return;
        }
        if (resyncPending.delete(taskId)) {
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

      // 剩下的路由是 GET /api/tasks/:id
      if (!ownershipGuard(response, taskId, requestedWs)) return;
      const task = tasks.get(taskId);
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
    // 清空归属表，模拟 A 侧 ZCode 重启丢归属表；新 createTask 仍会登记归属
    forgetOwnership() {
      ownership.clear();
    },
    // 模拟重启后事件缓冲清空：events 清空、seq 置 0，挂起中的长轮询全部唤醒
    resetEventSeq(taskId) {
      const task = tasks.get(taskId);
      if (!task) return;
      task.seq = 0;
      task.events = [];
      task.updatedAt = Date.now();
      for (const wake of [...task.waiters]) wake();
      task.waiters.clear();
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
