import { randomUUID } from "node:crypto";

// ZCode 入站端点客户端：所有命令的入站投递走这里。
// 事实依据（上游 bots 源码，2026-10-27 读）：
//   - POST /api/bots/webhook/:botId，头 x-zcode-bot-secret，body {botId,userId,text,messageId}
//   - 正文受理后同步 replies 为空数组（后台执行）；命令类/拒绝类回执在 replies 里
//   - messageId 进 2 分钟幂等层；网络重试复用同一 id

const REQUEST_TIMEOUT_MS = 10_000;

export class IngressError extends Error {
  constructor(code, message, { exitCode } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode ?? 1;
  }
}

export async function postIngress(config, text, { messageId = `zsub-${randomUUID()}` } = {}) {
  const port = config.ingressPort;
  const url = `http://127.0.0.1:${port}/api/bots/webhook/${encodeURIComponent(config.botId)}`;
  const body = JSON.stringify({ botId: config.botId, userId: config.userId, text, messageId });
  const headers = {
    "content-type": "application/json",
    "x-zcode-bot-secret": config.secret,
  };

  let lastError = null;
  // 网络类失败重试一次（复用同 messageId，上游幂等）；HTTP 4xx/5xx 不重试。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        throw new IngressError(
          "zcode_secret_mismatch",
          "zcode_secret_mismatch: ZCode 拒绝了 secret（401）。请重跑 zcode-sub setup 对齐 GUI 里的 webhook secret。",
          { exitCode: 5 },
        );
      }
      const replies = Array.isArray(payload.replies)
        ? payload.replies.map((reply) => (typeof reply?.text === "string" ? reply.text : String(reply)))
        : [];
      if (replies.some((replyText) => replyText.includes("Webhook secret 校验失败"))) {
        throw new IngressError(
          "zcode_secret_mismatch",
          "zcode_secret_mismatch: ZCode 回执「Webhook secret 校验失败」。请重跑 zcode-sub setup 对齐 secret。",
          { exitCode: 5 },
        );
      }
      return { status: response.status, ok: payload.ok ?? response.ok, replies };
    } catch (error) {
      if (error instanceof IngressError) throw error;
      lastError = error;
    }
  }
  throw new IngressError(
    "zcode_ingress_unreachable",
    `zcode_ingress_unreachable: 连不上 ZCode 入站端点 127.0.0.1:${port}（${lastError?.message ?? "unknown"}）。检查 ZCode 是否在运行、开关文件 bot-webhook-ingress.json 是否 enabled、端口是否一致。`,
    { exitCode: 2 },
  );
}

// 状态解析表：zh/en 双语（上游 messages.ts 现值 + buildStatusText 拼接格式）。
const STATE_PATTERNS = [
  [/状态:\s*⏳ 运行中|State:\s*Running/u, "running"],
  [/状态:\s*✅ 已完成|State:\s*Completed/u, "completed"],
  [/状态:\s*失败|State:\s*Failed/u, "failed"],
  [/状态:\s*已取消|State:\s*cancelled/u, "cancelled"],
  [/状态:\s*已停止|State:\s*stopped/u, "stopped"],
  [/状态:\s*草稿|State:\s*draft/u, "draft"],
];

export function parseStatusState(statusText) {
  for (const [pattern, state] of STATE_PATTERNS) {
    if (pattern.test(statusText)) return state;
  }
  return "unknown";
}

export async function queryStatus(config) {
  const { replies } = await postIngress(config, "/status");
  const raw = replies.join("\n");
  return { state: parseStatusState(raw), raw };
}
