// ZCode 本机任务 API 客户端（契约 v2）：所有命令的出站调用走这里。
// 端点全部监听 127.0.0.1；除 /health 外都要 Bearer token，Host 须为 127.0.0.1/localhost。
// 错误码与退出码统一：zcode_api_unreachable(2) / zcode_workspace_not_open(3) /
// zcode_send_failed(4) / zcode_unauthorized(5)。

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getHome } from "./home.js";

export class ApiError extends Error {
  constructor(code, message, { exitCode, status } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode ?? 1;
    this.status = status;
  }
}

// ZCODE_SUB_DEBUG=1 时逐请求记一行摘要到 <getHome()>/debug.log。
// 只记方法/路径/状态/响应长度，不写请求 body（prompt 内容）与 token；
// 追加失败静默——调试日志绝不影响主流程。
const debugLog = (line) => {
  try {
    appendFileSync(join(getHome(), "debug.log"), `${line}\n`);
  } catch {
    // 调试日志写不进去（目录不存在/只读等）就放弃，不影响主流程。
  }
};

export async function apiFetch(config, path, { method = "GET", body, timeoutMs = 10_000, retryOnNetworkError = false } = {}) {
  const url = `http://127.0.0.1:${config.apiPort}${path}`;
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const debug = process.env.ZCODE_SUB_DEBUG === "1";
  // 网络类失败：GET 重试 1 次（同样的 path/body）；POST 不重试——创建/写入类请求
  // 失败时目标可能已执行（如任务可能已创建），自动重试会双建任务，直接进失败分支。
  // 例外：调用方给了幂等键（retryOnNetworkError，如 createTask 带 clientRequestId，
  // 端点侧短期去重保证同键返回同一任务），重试安全，与 GET 同路径重试 1 次。
  // HTTP 4xx/5xx 两类方法都不重试。
  const maxAttempts = method === "POST" && !retryOnNetworkError ? 1 : 2;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
      const responseText = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = {}; // 非 JSON 响应按空对象交给调用方按 status 判断
      }
      if (debug) {
        debugLog(`${new Date().toISOString()} ${method} ${path} → ${response.status} ${responseText.length}字符`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(
          "zcode_unauthorized",
          "zcode_unauthorized: token/Host 校验失败。重跑 zcode-sub setup 对齐开关文件里的 token。",
          { exitCode: 5, status: response.status },
        );
      }
      if (response.status === 503 && payload?.error === "unavailable_host") {
        // 偏离#14：Host 退出/重启窗口，ZCode 把在飞请求立即结清为 503 unavailable_host。
        // 视为网络类暂态失败——抛普通错误（不是 ApiError，那会绕过重试）进上面的重试循环
        // （GET / 带幂等键的 POST 再试 1 次）；重试仍失败在循环外给专属文案。
        throw new Error("unavailable_host");
      }
      return { status: response.status, payload };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastError = error;
      if (debug) {
        debugLog(`${new Date().toISOString()} ${method} ${path} → ERR ${error.message}`);
      }
    }
  }
  // unavailable_host 专属文案：Host 重启/窗口关闭是暂态，给"稍后重试"而不是
  // "连不上"的排查指引；结清意味着请求未执行，不带防双建提示。
  if (lastError?.message === "unavailable_host") {
    throw new ApiError(
      "zcode_api_unreachable",
      "zcode_api_unreachable: ZCode 侧 Host 不可用（unavailable_host，可能正在重启/窗口已关闭），稍后重试。",
      { exitCode: 2, status: 503 },
    );
  }
  // 防双建警告只对无幂等键的 POST 保留（sendMessage/stopTask）；带幂等键的 createTask
  // 已自动重试过，失败消息不再催用户核对。
  const postHint =
    method === "POST" && !retryOnNetworkError
      ? "\n⚠ 本次为创建/写入类请求，失败时目标可能已执行（如任务可能已创建）——先用 zcode-sub list / ZCode GUI 核对，不要盲目重试。"
      : "";
  throw new ApiError(
    "zcode_api_unreachable",
    `zcode_api_unreachable: 连不上 ZCode 本机任务 API 127.0.0.1:${config.apiPort}（${lastError?.message ?? "unknown"}）。检查 ZCode 是否运行、local-task-api.json 是否 enabled、端口。${postHint}`,
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

export async function createTask(config, { workspacePath, prompt, title, mode, clientRequestId }) {
  const { status, payload } = await apiFetch(config, "/api/tasks", {
    method: "POST",
    body: {
      workspacePath,
      prompt,
      title,
      // mode 可选（偏离#11 枚举见端点白名单）；CLI 暂无 --mode，仅为接口完备
      ...(mode ? { mode } : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
    },
    // 有幂等键（端点侧按 clientRequestId 短期去重）才允许网络类失败重试，防双建
    ...(clientRequestId ? { retryOnNetworkError: true } : {}),
  });
  // 201 = 新建；200 = clientRequestId 去重命中（端点复用已建任务，返回同一 taskId）。
  // 两种状态上游都可能带 warning（偏离#13：任务已建但首条 prompt 投递失败
  // → warning="first_prompt_failed"），非空字符串原样透传给调用方。
  if ((status === 200 || status === 201) && typeof payload?.taskId === "string" && payload.taskId !== "") {
    return {
      taskId: payload.taskId,
      ...(typeof payload.warning === "string" && payload.warning ? { warning: payload.warning } : {}),
    };
  }
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

// 发送消息。clientRequestId 可选（与 createTask 幂等键同口径）：有值时入 body，且网络
// 失败同键安全重试一次——端点侧短期去重保证同键返回首次应答，不会双投。未传（undefined）
// 时 body 不得含该键、POST 照旧不重试；传了非法值（如空串）也原样入 body，交端点侧按
// 1..200 口径校验拒绝。
export async function sendMessage(config, taskId, text, delivery = "auto", workspacePath, clientRequestId) {
  const { status, payload } = await apiFetch(config, `/api/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    // workspacePath 可选：带上后 A 侧 ZCode 重启丢归属表也能按工作区路由
    body: {
      text,
      delivery,
      ...(workspacePath ? { workspacePath } : {}),
      ...(clientRequestId !== undefined ? { clientRequestId } : {}),
    },
    ...(clientRequestId ? { retryOnNetworkError: true } : {}),
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

export async function stopTask(config, taskId, workspacePath) {
  const { status, payload } = await apiFetch(config, `/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: "POST",
    // 有 workspacePath 才带 body；无则不带（向后兼容旧 A 侧）
    ...(workspacePath ? { body: { workspacePath } } : {}),
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

export async function getTask(config, taskId, workspacePath) {
  const wsQuery = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
  const { status, payload } = await apiFetch(config, `/api/tasks/${encodeURIComponent(taskId)}${wsQuery}`);
  if (status >= 200 && status < 300) return payload;
  throw new ApiError(
    "zcode_send_failed",
    status === 404
      ? `zcode_send_failed: 任务 ${taskId} 不存在（可能已在 GUI 删除）。`
      : `zcode_send_failed: ZCode 返回 status=${status}，任务 ${taskId} 查询失败。`,
    { exitCode: 4, status },
  );
}

export async function getEvents(config, taskId, after, waitMs, workspacePath) {
  const query = `after=${encodeURIComponent(String(after))}&waitMs=${encodeURIComponent(String(waitMs))}`;
  const wsQuery = workspacePath ? `&workspacePath=${encodeURIComponent(workspacePath)}` : "";
  const { status, payload } = await apiFetch(
    config,
    `/api/tasks/${encodeURIComponent(taskId)}/events?${query}${wsQuery}`,
    // 长轮询挂 waitMs 毫秒，超时预算留出余量
    { timeoutMs: waitMs + 5000 },
  );
  // 任务不存在表现为 HTTP 404，此处统一抛错；wait 不再自己判 payload.error
  if (status >= 400) {
    throw new ApiError(
      "zcode_send_failed",
      `zcode_send_failed: 事件查询失败（status=${status}${payload?.error ? " " + payload.error : ""}）。任务可能已在 GUI 删除。`,
      { exitCode: 4, status },
    );
  }
  // 不做语义判断：{events,nextSeq} 或 {resync:true} 原样交给调用方
  return payload;
}
