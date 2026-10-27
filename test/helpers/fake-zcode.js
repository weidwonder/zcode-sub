import { createServer } from "node:http";

// 假 ZCode 入站端点：按契约 v1 行为（/health、POST /api/bots/webhook/:botId、
// Host 校验、secret 校验、{ok,replies} 响应）模拟子任务 A 的端点，供测试与
// 集成测试驱动。calls 记录每次入站请求（含 body），replyScript 由用例注入。

export function startFakeZcode({ secret = "s1", botId = "bot-1", zcodeVersion = "test-1.0.0" } = {}) {
  const calls = [];
  // replyScript(text) -> {status?, ok?, replies?: string[]} | undefined（undefined 走默认）
  let replyScript = () => undefined;
  let statusState = "draft"; // 模拟 ZCode 侧任务状态，/status 时生成对应文本

  const statusText = () => {
    const stateLine = {
      running: "⏳ 运行中",
      completed: "✅ 已完成",
      failed: "失败",
      cancelled: "已取消",
      stopped: "已停止",
      draft: "草稿",
    }[statusState] ?? "草稿";
    return [
      `工作区: fake`,
      `模型: fake-model`,
      `------`,
      `任务: fake task`,
      `状态: ${stateLine}`,
    ].join("\n");
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad_json" }));
        return;
      }
      const record = { method: request.method, url: request.url, headers: request.headers, body };
      calls.push(record);

      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, ingress: "zcode-bot-webhook", version: 1, zcodeVersion }));
        return;
      }
      const webhookMatch = request.url?.match(/^\/api\/bots\/webhook\/([^/]+)$/u);
      if (request.method === "POST" && webhookMatch) {
        if (request.headers["x-zcode-bot-secret"] !== secret) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (webhookMatch[1] !== botId) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Unsupported provider: test" }));
          return;
        }
        if (typeof body.text !== "string" || typeof body.userId !== "string") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "payload_error" }));
          return;
        }
        let result = replyScript(body.text);
        if (result === undefined) {
          if (body.text === "/status") {
            result = { ok: true, replies: [statusText()] };
          } else {
            result = { ok: true, replies: [] };
          }
        }
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: result.ok ?? true, replies: result.replies ?? [] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        ingressUrl: `http://127.0.0.1:${port}`,
        calls,
        setReplyScript: (fn) => {
          replyScript = fn;
        },
        setStatusState: (state) => {
          statusState = state;
        },
        statusText,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
