import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// 假 ZCode 本机任务 API：按契约 v2 模拟（/health、/api/tasks 全家、/api/models、
// /api/tasks/:id/model、Host+Bearer+Content-Type+413 校验、每任务事件队列与长轮询、
// resync 溢出、归属表与游标回退），供测试驱动 src/api.js。
// messages 幂等：body.clientRequestId 非空合法（1..200 字符）时按任务缓存首次成功应答
// （同 202、同 delivery、同 commandId），同键重放直接回缓存；空串/超长 400 bad_client_request_id。
// 换模型（偏离#19/#20）：POST /api/tasks/:id/model 运行中允许、不发事件，应答 200 {ok:true}；
// clientRequestId 幂等为独立 model 命名空间（task.modelReqIds），与 messages/create 隔离。
// 校验顺序对齐 A 侧实装：路由级 404/405 → Host 403 → Bearer 401 → 415 → 413 → 400
// （POST /api/tasks 另有 mode 白名单 400 与 modelSelection strict 400，先于 409 工作区
// 检查——对齐偏离#7）。
// 控制方法（用例驱动）：createTaskAlreadyRunning / emitEvent / setTaskStatus /
// setLastAssistantText / settleSteer / createdTasks / calls / simulateResync /
// forgetOwnership / resetEventSeq / failNextCreatePrompt / setOpUnavailable / setModels / stop。

const MAX_WAIT_MS = 30_000;
const MAX_BODY_CHARS = 16 * 1024 * 1024; // 413 阈值：16MiB

// 偏离#11：create 接受的 mode 枚举（body.mode 为 undefined/合法值放行，越界 400 bad_mode）
const MODE_WHITELIST = new Set([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);

// 偏离#17：modelSelection strict 形体——{providerId, modelId, options?{reasoningLevel}}；
// providerId/modelId 均非空串，options 存在则仅含非空串 reasoningLevel；多余键/空串/错型 → false（400）
const isStrictModelSelection = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.providerId !== "string" || value.providerId === "") return false;
  if (typeof value.modelId !== "string" || value.modelId === "") return false;
  if (Object.keys(value).some((key) => key !== "providerId" && key !== "modelId" && key !== "options")) return false;
  if ("options" in value) {
    const options = value.options;
    if (options === null || typeof options !== "object" || Array.isArray(options)) return false;
    if (Object.keys(options).some((key) => key !== "reasoningLevel")) return false;
    if (typeof options.reasoningLevel !== "string" || options.reasoningLevel === "") return false;
  }
  return true;
};

// 路由表：路径级 404/405 在鉴权之前判定
const ROUTES = [
  { method: "GET", re: /^\/health$/u },
  { method: "POST", re: /^\/api\/tasks$/u },
  { method: "GET", re: /^\/api\/models$/u },
  { method: "POST", re: /^\/api\/tasks\/([^/]+)\/messages$/u },
  { method: "POST", re: /^\/api\/tasks\/([^/]+)\/stop$/u },
  { method: "POST", re: /^\/api\/tasks\/([^/]+)\/model$/u },
  { method: "GET", re: /^\/api\/tasks\/([^/]+)\/events$/u },
  { method: "GET", re: /^\/api\/tasks\/([^/]+)$/u },
];

export async function startFakeZcode({ token = "test-token", port: listenPort = 0, zcodeVersion = "test-1.0.0" } = {}) {
  const calls = []; // 非 health 请求的 {method,url,headers,body}
  const tasks = new Map(); // taskId -> 任务对象（含事件队列与 seq 计数器）
  const createReqIds = new Map(); // clientRequestId -> taskId（POST /api/tasks 短期去重）
  const ownership = new Map(); // taskId -> workspacePath（A 侧归属表；forgetOwnership 模拟重启丢表）
  const resyncPending = new Set(); // 下一次 events 请求要返回 {resync:true} 的 taskId
  const sockets = new Set();
  let commandCounter = 0;
  let port = listenPort;
  let shuttingDown = false;
  let failNextCreatePromptFlag = false; // 一次性：下一次建任务回 201 + warning first_prompt_failed
  let opUnavailableFlag = false; // Host 退出模拟：开启后全部 op 请求结清 503 unavailable_host
  // 偏离#18 模型目录（可被 setModels 覆盖）；preferred 形体即 modelSelection、可原样回传。
  // glm-5.3 带 max 档位、gpt-5 带 defaultThoughtLevel：供「未指定 --thought 用默认档位」
  // 的三条兜底路径（max 优先 / defaultThoughtLevel 回落 / 末档兜底）分别取材。
  let modelsPayload = {
    providers: [
      { providerId: "glm", displayName: "glm", models: [
        { modelId: "glm-4.7", displayName: "glm-4.7", thoughtLevels: ["off", "medium", "high"], isDefault: true },
        { modelId: "glm-4.7-flash", displayName: "glm-4.7-flash", thoughtLevels: [], isDefault: false },
        { modelId: "glm-5.3", displayName: "glm-5.3", thoughtLevels: ["off", "medium", "high", "max"], isDefault: false },
      ] },
      { providerId: "openai", displayName: "openai", models: [
        { modelId: "gpt-5", displayName: "gpt-5", thoughtLevels: ["low", "medium", "high"], defaultThoughtLevel: "low", isDefault: false },
      ] },
    ],
    preferred: { providerId: "glm", modelId: "glm-4.7" },
  };

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
    pendingSteerCommandId: null, // steer 受理待决：settleSteer 前由 messages 端点登记
    reqIds: new Map(), // messages 的 clientRequestId → 首次成功应答缓存（幂等去重）
    modelReqIds: new Map(), // 换模型的 clientRequestId 幂等（独立 model 命名空间，偏离#20）
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

      // 偏离#14 控制开关：Host 退出/重启窗口——已识别路由的全部 op 请求（非 /health）
      // 一律立即结清为 503 unavailable_host（后续校验都不再走，模拟在飞请求被清掉）
      if (opUnavailableFlag) {
        json(response, 503, { error: "unavailable_host" });
        return;
      }

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
        // 幂等键短期去重：非空 clientRequestId 命中已建任务 → 直接 200 复用（不双建；
        // 注意首次创建是 201，去重命中是 200），其余校验照旧
        const reqId = typeof body.clientRequestId === "string" && body.clientRequestId !== "" ? body.clientRequestId : null;
        if (reqId !== null && createReqIds.has(reqId)) {
          json(response, 200, { taskId: createReqIds.get(reqId) });
          return;
        }
        // 偏离#11：mode 白名单 400 先于 409 工作区检查（body 参数校验先于归属判定）
        if (body.mode !== undefined && !MODE_WHITELIST.has(body.mode)) {
          json(response, 400, { error: "bad_mode" });
          return;
        }
        // 偏离#17：modelSelection 非 undefined 时按 strict 形体校验（同 /model 端点）
        if (body.modelSelection !== undefined && !isStrictModelSelection(body.modelSelection)) {
          json(response, 400, { error: "bad_model_selection" });
          return;
        }
        // 未打开的工作区（远端工作区同码）→ 409；打开超时 → 409 workspace_open_timeout；
        // 路径非法 → 400 workspace_path_invalid（A 侧预留错误，B 侧先映射）
        if (body.workspacePath === "/workspace-closed" || body.workspacePath === "/workspace-remote") {
          json(response, 409, { error: "workspace_not_open" });
          return;
        }
        if (body.workspacePath === "/workspace-open-timeout") {
          json(response, 409, { error: "workspace_open_timeout" });
          return;
        }
        if (body.workspacePath === "/workspace-bad-path") {
          json(response, 400, { error: "workspace_path_invalid" });
          return;
        }
        // 偏离#13 一次性开关：任务照常创建，但回 201 + warning（首条 prompt 投递失败）
        const firstPromptFailed = failNextCreatePromptFlag;
        failNextCreatePromptFlag = false;
        const task = newTask(body.workspacePath, body.title);
        tasks.set(task.taskId, task);
        ownership.set(task.taskId, task.workspacePath); // createTask 登记归属
        if (reqId !== null) createReqIds.set(reqId, task.taskId);
        json(response, 201, { taskId: task.taskId, ...(firstPromptFailed ? { warning: "first_prompt_failed" } : {}) });
        return;
      }

      // 偏离#18：模型目录；鉴权已过（记入 calls）。仍按 workspace 语义路由：未打开的
      // 工作区 409 workspace_not_open（与其它端点 409 语义一致）
      if (method === "GET" && pathname === "/api/models") {
        if (requestedWs === "/workspace-closed") {
          json(response, 409, { error: "workspace_not_open" });
          return;
        }
        json(response, 200, modelsPayload);
        return;
      }

      const taskId = routeParams[0];

      if (pathname.endsWith("/messages")) {
        // clientRequestId 校验（与 create 同口径）：空串/超 200 字符 → 400（body 参数校验先于归属判定）
        if (
          body.clientRequestId === "" ||
          (typeof body.clientRequestId === "string" && body.clientRequestId.length > 200)
        ) {
          json(response, 400, { error: "bad_client_request_id" });
          return;
        }
        const reqId = typeof body.clientRequestId === "string" && body.clientRequestId !== "" ? body.clientRequestId : null;
        if (!ownershipGuard(response, taskId, body.workspacePath)) return;
        const task = tasks.get(taskId);
        if (!task) {
          taskNotFound(response);
          return;
        }
        // 幂等去重：合法同键重放直接回首次成功应答（同 202、同 delivery、同 commandId 原值）
        if (reqId !== null && task.reqIds.has(reqId)) {
          json(response, 202, task.reqIds.get(reqId));
          return;
        }
        task.updatedAt = Date.now();
        const delivery = body.delivery ?? "auto";
        if (task.status === "running") {
          commandCounter += 1;
          const commandId = `cmd-${commandCounter}`;
          if (delivery === "steer") {
            // steer 仅为受理：不自产事件，注入结果由 settleSteer（A 侧 CLI 投影）追加
            task.pendingSteerCommandId = commandId;
          } else {
            // auto 不带 requestedDelivery，CLI 按会话 follow-up mode 裁决——此处模拟 GUI 默认 queue
            appendEvent(task, "input.queued", { commandId });
          }
          const reply = { delivery: delivery === "steer" ? "steered" : "queued", commandId };
          if (reqId !== null) task.reqIds.set(reqId, reply);
          json(response, 202, reply);
          return;
        }
        // 空闲收到 steer：A 侧按实际去向应答 sent（sendPrompt 不带 guide、无 steer 事件）——空闲不区分 delivery
        task.turnCount += 1;
        appendEvent(task, "turn.started", { turnId: `turn-${task.turnCount}` });
        const reply = { delivery: "sent" };
        if (reqId !== null) task.reqIds.set(reqId, reply);
        json(response, 202, reply);
        return;
      }

      if (pathname.endsWith("/model")) {
        // 偏离#19：运行中允许换模型；校验顺序 = 归属 → 任务存在 → modelSelection strict
        if (!ownershipGuard(response, taskId, body.workspacePath)) return;
        const task = tasks.get(taskId);
        if (!task) {
          taskNotFound(response);
          return;
        }
        if (!isStrictModelSelection(body.modelSelection)) {
          json(response, 400, { error: "bad_model_selection" });
          return;
        }
        // 偏离#20：clientRequestId 幂等为独立 model 命名空间（与 messages/create 隔离）；
        // 命中直接 200 {ok:true}，否则处理后缓存。不发任何事件。
        const reqId =
          typeof body.clientRequestId === "string" && body.clientRequestId !== "" ? body.clientRequestId : null;
        if (reqId !== null && task.modelReqIds.has(reqId)) {
          json(response, 200, { ok: true });
          return;
        }
        task.updatedAt = Date.now();
        if (reqId !== null) task.modelReqIds.set(reqId, true);
        json(response, 200, { ok: true });
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
    // steer 受理后的注入结果：input.steered{commandId}（turn_steer_queued 投影）+
    // steer.injected（drained）或 steer.fellBack{error}（discarded/rejected）
    settleSteer(taskId, outcome, errorText) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`settleSteer: no task ${taskId}`);
      if (task.pendingSteerCommandId === null) throw new Error("settleSteer: 该任务没有待决的 steer 受理");
      appendEvent(task, "input.steered", { commandId: task.pendingSteerCommandId });
      task.pendingSteerCommandId = null;
      if (outcome === "injected") {
        appendEvent(task, "steer.injected");
      } else if (outcome === "fellBack") {
        appendEvent(task, "steer.fellBack", { error: errorText ?? "steer_unavailable" });
      } else {
        throw new Error(`settleSteer: 未知 outcome ${outcome}`);
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
    // 偏离#13 一次性：下一次 POST /api/tasks 照常建任务，但回 201 {taskId, warning:
    // "first_prompt_failed"}（首条 prompt 投递失败）；再下一次 create 恢复正常 201
    failNextCreatePrompt() {
      failNextCreatePromptFlag = true;
    },
    // 偏离#14：模拟 Host 退出——开启后全部 op 请求（非 /health）立即结清为
    // 503 {error:"unavailable_host"}；关闭后恢复正常
    setOpUnavailable(enabled) {
      opUnavailableFlag = enabled === true;
    },
    // 覆盖 GET /api/models 的返回（偏离#18），供用例替换默认模型目录数据
    setModels(payload) {
      modelsPayload = payload;
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
