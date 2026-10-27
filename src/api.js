// ZCode 本机任务 API 客户端（契约 v2）：所有命令的出站调用走这里。
// 端点全部监听 127.0.0.1；除 /health 外都要 Bearer token，Host 须为 127.0.0.1/localhost。
// 错误码与退出码统一：zcode_api_unreachable(2) / zcode_workspace_not_open(3) /
// zcode_send_failed(4) / zcode_unauthorized(5)。

export class ApiError extends Error {
  constructor(code, message, { exitCode, status } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode ?? 1;
    this.status = status;
  }
}

export async function apiFetch(config, path, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  const url = `http://127.0.0.1:${config.apiPort}${path}`;
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  let lastError = null;
  // 网络类失败重试一次（同样的 path/body）；HTTP 4xx/5xx 不重试。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(
          "zcode_unauthorized",
          "zcode_unauthorized: token/Host 校验失败。重跑 zcode-sub setup 对齐开关文件里的 token。",
          { exitCode: 5, status: response.status },
        );
      }
      return { status: response.status, payload };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastError = error;
    }
  }
  throw new ApiError(
    "zcode_api_unreachable",
    `zcode_api_unreachable: 连不上 ZCode 本机任务 API 127.0.0.1:${config.apiPort}（${lastError?.message ?? "unknown"}）。检查 ZCode 是否运行、local-task-api.json 是否 enabled、端口。`,
    { exitCode: 2 },
  );
}

export async function probeHealth(config) {
  let status;
  let payload;
  try {
    ({ status, payload } = await apiFetch(config, "/health"));
  } catch (error) {
    return { ok: false, message: error.message };
  }
  if (status === 200 && payload?.api === "zcode-local-task-api" && payload?.version === 2) {
    return { ok: true, zcodeVersion: payload.zcodeVersion };
  }
  return {
    ok: false,
    message: `zcode_health_mismatch: /health 返回 status=${status} api=${JSON.stringify(payload?.api ?? null)} version=${JSON.stringify(payload?.version ?? null)}，不是 ZCode 本机任务 API v2。`,
  };
}

export async function createTask(config, { workspacePath, prompt, title }) {
  const { status, payload } = await apiFetch(config, "/api/tasks", {
    method: "POST",
    body: { workspacePath, prompt, title },
  });
  if (status === 201) return { taskId: payload.taskId };
  if (status === 409 && payload?.error === "workspace_not_open") {
    throw new ApiError(
      "zcode_workspace_not_open",
      "zcode_workspace_not_open: 该工作区未在 ZCode 中打开。先在 ZCode 里打开该工作区再派发。",
      { exitCode: 3, status: 409 },
    );
  }
  throw new ApiError(
    "zcode_create_failed",
    `zcode_create_failed: ZCode 返回 status=${status}（${JSON.stringify(payload)}），创建任务失败。`,
    { exitCode: 1, status },
  );
}

export async function sendMessage(config, taskId, text, delivery = "auto") {
  const { status, payload } = await apiFetch(config, `/api/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    body: { text, delivery },
  });
  if (status >= 200 && status < 300) return payload;
  throw new ApiError(
    "zcode_send_failed",
    status === 404
      ? `zcode_send_failed: 任务 ${taskId} 不存在（可能已在 GUI 删除）。`
      : `zcode_send_failed: ZCode 返回 status=${status}，任务 ${taskId} 投递失败。`,
    { exitCode: 4, status },
  );
}

export async function stopTask(config, taskId) {
  const { status, payload } = await apiFetch(config, `/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: "POST",
  });
  if (status >= 200 && status < 300) return payload;
  throw new ApiError(
    "zcode_send_failed",
    status === 404
      ? `zcode_send_failed: 任务 ${taskId} 不存在，可能已被删除。`
      : `zcode_send_failed: ZCode 返回 status=${status}，任务 ${taskId} 停止失败。`,
    { exitCode: 4, status },
  );
}

export async function getTask(config, taskId) {
  const { status, payload } = await apiFetch(config, `/api/tasks/${encodeURIComponent(taskId)}`);
  if (status >= 200 && status < 300) return payload;
  throw new ApiError(
    "zcode_send_failed",
    status === 404
      ? `zcode_send_failed: 任务 ${taskId} 不存在（可能已在 GUI 删除）。`
      : `zcode_send_failed: ZCode 返回 status=${status}，任务 ${taskId} 查询失败。`,
    { exitCode: 4, status },
  );
}

export async function getEvents(config, taskId, after, waitMs) {
  const query = `after=${encodeURIComponent(String(after))}&waitMs=${encodeURIComponent(String(waitMs))}`;
  const { payload } = await apiFetch(
    config,
    `/api/tasks/${encodeURIComponent(taskId)}/events?${query}`,
    // 长轮询挂 waitMs 毫秒，超时预算留出余量
    { timeoutMs: waitMs + 5000 },
  );
  // 不做语义判断：{events,nextSeq} 或 {resync:true} 原样交给调用方
  return payload;
}
