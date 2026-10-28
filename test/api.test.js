import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { createTask, getEvents, getTask, listModels, probeHealth, sendMessage, setModel, stopTask } from "../src/api.js";

let fake;
const config = {
  apiPort: 0,
  token: "test-token",
};

before(async () => {
  fake = await startFakeZcode({ token: "test-token" });
  config.apiPort = fake.port;
});

after(() => fake.stop());

// 绕过 src/api.js 直打 fake 的裸请求：用于校验 403/401/415/405/404 的状态码与错误体
// （fetch 覆盖不了 Host 头；extra 透传给 http.request，如 setHost:false）
function rawRequest(port, { method = "GET", path = "/", headers = {}, body, ...extra } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers, ...extra }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("probeHealth：api/version 校验通过，health 不记入 calls", async () => {
  const mark = fake.calls.length;
  const result = await probeHealth(config);
  assert.equal(result.ok, true);
  assert.equal(result.zcodeVersion, "test-1.0.0");
  assert.equal(fake.calls.length, mark);
});

test("createTask：201 返回 taskId，鉴权头与 Host 正确", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w1", prompt: "做点事", title: "任务一" });
  assert.match(taskId, /^[0-9a-f-]{36}$/u);
  const record = fake.calls.at(-1);
  assert.equal(record.method, "POST");
  assert.equal(record.url, "/api/tasks");
  assert.equal(record.headers.authorization, "Bearer test-token");
  assert.equal(record.headers.host, `127.0.0.1:${fake.port}`);
  assert.equal(record.body.workspacePath, "/w1");
  assert.equal(record.body.prompt, "做点事");
  assert.equal(record.body.title, "任务一");
  assert.equal("clientRequestId" in record.body, false, "未传幂等键时 body 不得含 clientRequestId");
  assert.deepEqual(fake.createdTasks[taskId], { workspacePath: "/w1", title: "任务一", status: "idle" });
});

test("createTask：clientRequestId 进 body，同键二次 POST 去重命中 200 同 taskId 不双建", async () => {
  const mark = fake.calls.length;

  // 首次创建：端点收到该字段
  const first = await createTask(config, { workspacePath: "/w-idem", prompt: "p", clientRequestId: "req-dup-1" });
  assert.match(first.taskId, /^[0-9a-f-]{36}$/u);
  let record = fake.calls.at(-1);
  assert.equal(record.method, "POST");
  assert.equal(record.url, "/api/tasks");
  assert.equal(record.body.clientRequestId, "req-dup-1");

  // 同键二次：返回同一 taskId，不双建
  const second = await createTask(config, { workspacePath: "/w-idem", prompt: "p", clientRequestId: "req-dup-1" });
  assert.equal(second.taskId, first.taskId, "同 clientRequestId 应复用同一任务");
  assert.equal(fake.calls.length - mark, 2, "同键二次只应多一次调用");
  const wsTasks = Object.entries(fake.createdTasks).filter(([, task]) => task.workspacePath === "/w-idem");
  assert.equal(wsTasks.length, 1, `同 clientRequestId 不得双建任务：${JSON.stringify(fake.createdTasks)}`);
  assert.equal(wsTasks[0][0], first.taskId);

  // 状态码契约直核（createTask 只回 taskId）：首次创建 201，去重命中 200
  const rawPost = () =>
    rawRequest(fake.port, {
      method: "POST",
      path: "/api/tasks",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ workspacePath: "/w-idem-raw", prompt: "p", clientRequestId: "req-dup-raw" }),
    });
  const rawFirst = await rawPost();
  assert.equal(rawFirst.status, 201);
  const rawSecond = await rawPost();
  assert.equal(rawSecond.status, 200, "去重命中应是 200 而非 201");
  assert.equal(rawSecond.body.taskId, rawFirst.body.taskId);
});

test("createTask：workspace 未打开/打开超时/打开被禁 → 统一 zcode_workspace_not_open（exit 3），远端工作区同码", async () => {
  await assert.rejects(
    () => createTask(config, { workspacePath: "/workspace-closed", prompt: "做点事" }),
    (error) =>
      error.code === "zcode_workspace_not_open" && error.exitCode === 3 && error.status === 409,
  );
  await assert.rejects(
    () => createTask(config, { workspacePath: "/workspace-remote", prompt: "做点事" }),
    (error) =>
      error.code === "zcode_workspace_not_open" && error.exitCode === 3 && error.status === 409,
  );
  // workspace_open_timeout：同 code 同 exit 3，文案含「可直接重试」（打开请求可能仍在进行）
  await assert.rejects(
    () => createTask(config, { workspacePath: "/workspace-open-timeout", prompt: "做点事" }),
    (error) =>
      error.code === "zcode_workspace_not_open" &&
      error.exitCode === 3 &&
      error.status === 409 &&
      error.message.includes("打开该工作区超时") &&
      error.message.includes("可直接重试"),
  );
  // workspace_open_blocked：全局禁止打开工作区（如强制升级中）同 code 同 exit 3
  await assert.rejects(
    () => createTask(config, { workspacePath: "/workspace-open-blocked", prompt: "做点事" }),
    (error) =>
      error.code === "zcode_workspace_not_open" &&
      error.exitCode === 3 &&
      error.status === 409 &&
      error.message.includes("禁止打开工作区"),
  );
});

test("createTask：mode 白名单——越界 400 bad_mode→zcode_create_failed（exit 1）且先于 409；合法值放行进 body", async () => {
  // 偏离#11：mode 越界 → 端点 400 {error:"bad_mode"}，客户端映射 zcode_create_failed
  await assert.rejects(
    () => createTask(config, { workspacePath: "/w-mode", prompt: "p", title: "t", mode: "bogus" }),
    (error) => error.code === "zcode_create_failed" && error.exitCode === 1 && error.status === 400,
  );
  // 400 先于 409 工作区检查（对齐偏离#7「body 参数校验先于归属判定」）：未打开工作区 + 越界 mode → 400
  await assert.rejects(
    () => createTask(config, { workspacePath: "/workspace-closed", prompt: "p", mode: "bogus" }),
    (error) => error.code === "zcode_create_failed" && error.status === 400,
  );

  // 合法值（11 枚举之一）正常 201，且原样进请求 body
  const { taskId } = await createTask(config, { workspacePath: "/w-mode", prompt: "p", title: "t", mode: "plan" });
  assert.match(taskId, /^[0-9a-f-]{36}$/u);
  const record = fake.calls.at(-1);
  assert.equal(record.body.mode, "plan");

  // 未传 mode 时 body 不得含该键
  const { taskId: plainId } = await createTask(config, { workspacePath: "/w-mode", prompt: "p", title: "t2" });
  assert.equal("mode" in fake.calls.at(-1).body, false, "未传 mode 时 body 不得含 mode 键");
  assert.notEqual(plainId, taskId);
});

test("listModels：200 返回 providers/preferred；workspacePath 进 query，未传则无 query", async () => {
  const mark = fake.calls.length;
  const view = await listModels(config, "/w-models");
  assert.equal(view.preferred.providerId, "glm");
  assert.equal(view.preferred.modelId, "glm-4.7");
  assert.equal(view.providers.length, 2);
  assert.deepEqual(view.providers[0], {
    providerId: "glm",
    displayName: "glm",
    models: [
      { modelId: "glm-4.7", displayName: "glm-4.7", thoughtLevels: ["off", "medium", "high"], isDefault: true },
      { modelId: "glm-4.7-flash", displayName: "glm-4.7-flash", thoughtLevels: [], isDefault: false },
      { modelId: "glm-5.3", displayName: "glm-5.3", thoughtLevels: ["off", "medium", "high", "max"], defaultThoughtLevel: "max", isDefault: false },
    ],
  });

  const record = fake.calls.at(-1);
  assert.equal(record.method, "GET");
  assert.equal(
    new URLSearchParams(record.url.split("?")[1] ?? "").get("workspacePath"),
    "/w-models",
    "workspacePath 应进 query",
  );

  // 不带 workspacePath：URL 无 query
  await listModels(config);
  assert.equal(fake.calls.at(-1).url, "/api/models");
  assert.equal(fake.calls.length - mark, 2, "共两次调用");
});

test("listModels：错 token 401 → zcode_unauthorized（exit 5）", async () => {
  await assert.rejects(
    () => listModels({ ...config, token: "wrong-token" }),
    (error) => error.code === "zcode_unauthorized" && error.exitCode === 5 && error.status === 401,
  );
});

test("setModel：200 {ok:true}；modelSelection/workspacePath/clientRequestId 进 body；同幂等键两次均 200（独立 model 命名空间）", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w-setmodel", prompt: "p" });
  fake.createTaskAlreadyRunning(taskId); // 偏离#19：运行中允许换模型

  const selection = { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "high" } };
  const payload = await setModel(config, taskId, selection, "/w-setmodel", "req-model-dup-1");
  assert.deepEqual(payload, { ok: true });
  let record = fake.calls.at(-1);
  assert.equal(record.method, "POST");
  assert.equal(record.url.split("?")[0], `/api/tasks/${taskId}/model`);
  assert.deepEqual(record.body.modelSelection, selection);
  assert.equal(record.body.workspacePath, "/w-setmodel");
  assert.equal(record.body.clientRequestId, "req-model-dup-1");

  // 同 clientRequestId 重放：幂等命中也 200 {ok:true}
  const again = await setModel(config, taskId, selection, "/w-setmodel", "req-model-dup-1");
  assert.deepEqual(again, { ok: true });

  const modelCalls = fake.calls.filter((call) => call.url.split("?")[0] === `/api/tasks/${taskId}/model`);
  assert.equal(modelCalls.length, 2);
});

test("setModel：非法 modelSelection（空 providerId/多余键）→ 400 zcode_send_failed（exit 4）", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w-model-bad", prompt: "p" });
  await assert.rejects(
    () => setModel(config, taskId, { providerId: "", modelId: "glm-4.7" }, "/w-model-bad"),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 400,
  );
  await assert.rejects(
    () => setModel(config, taskId, { providerId: "glm", modelId: "glm-4.7", extra: 1 }, "/w-model-bad"),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 400,
  );
});

test("setModel：任务不存在 → 404 zcode_send_failed（exit 4）", async () => {
  await assert.rejects(
    () =>
      setModel(
        config,
        "00000000-0000-4000-8000-000000000000",
        { providerId: "glm", modelId: "glm-4.7" },
      ),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 404,
  );
});

test("createTask：modelSelection 合法进 body；非法 400 zcode_create_failed；不传不含该键", async () => {
  const selection = { providerId: "glm", modelId: "glm-4.7", options: { reasoningLevel: "high" } };
  const { taskId } = await createTask(config, {
    workspacePath: "/w-create-model",
    prompt: "p",
    modelSelection: selection,
  });
  assert.match(taskId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(fake.calls.at(-1).body.modelSelection, selection);

  await assert.rejects(
    () =>
      createTask(config, {
        workspacePath: "/w-create-model",
        prompt: "p",
        modelSelection: { providerId: "glm", modelId: "" },
      }),
    (error) => error.code === "zcode_create_failed" && error.exitCode === 1 && error.status === 400,
  );

  await createTask(config, { workspacePath: "/w-create-model", prompt: "p" });
  assert.equal("modelSelection" in fake.calls.at(-1).body, false, "未传 modelSelection 时 body 不得含该键");
});

test("createTask/setModel：registry 不可解析（400 invalid_model_selection）→ zcode_model_invalid（exit 1）带原因与 models 指引", async () => {
  // CLI 本地预校验会先拦住绝大多数；此处直打 api 层模拟「预校验后 registry 才不可解析」
  // 的窄窗（或绕过 CLI 的调用方）：上游 400 {error:"invalid_model_selection", message} 映射
  await assert.rejects(
    () =>
      createTask(config, {
        workspacePath: "/w-model-ghost",
        prompt: "p",
        modelSelection: { providerId: "glm", modelId: "ghost-model" },
      }),
    (error) =>
      error.code === "zcode_model_invalid" &&
      error.exitCode === 1 &&
      error.status === 400 &&
      error.message.includes("model-not-found") &&
      error.message.includes("zcode-sub models"),
  );

  const { taskId } = await createTask(config, { workspacePath: "/w-model-ghost", prompt: "p" });
  await assert.rejects(
    () => setModel(config, taskId, { providerId: "glm", modelId: "ghost-model" }, "/w-model-ghost"),
    (error) =>
      error.code === "zcode_model_invalid" &&
      error.exitCode === 1 &&
      error.status === 400 &&
      error.message.includes("model-not-found") &&
      error.message.includes("zcode-sub models"),
  );
});

test("sendMessage：空闲任务 sent；运行中任务 auto→queued、steer→steered", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w2", prompt: "p" });

  const sent = await sendMessage(config, taskId, "补充一句");
  assert.deepEqual(sent, { delivery: "sent" });

  fake.createTaskAlreadyRunning(taskId);
  const queued = await sendMessage(config, taskId, "排队的话");
  assert.equal(queued.delivery, "queued");
  assert.match(queued.commandId, /^cmd-\d+$/u);

  const steered = await sendMessage(config, taskId, "插队的话", "steer");
  assert.equal(steered.delivery, "steered");
  assert.match(steered.commandId, /^cmd-\d+$/u);

  const page = await getEvents(config, taskId, 0, 0);
  assert.deepEqual(
    page.events.map((event) => event.type),
    ["turn.started", "input.queued"],
  );
  assert.equal(page.nextSeq, 2);

  // steer 应答仅为受理：input.steered 与注入结果由控制方法投影（A 侧 CLI 投影）后才进事件流
  fake.settleSteer(taskId, "injected");
  const injected = await getEvents(config, taskId, page.nextSeq, 0);
  assert.deepEqual(
    injected.events.map((event) => event.type),
    ["input.steered", "steer.injected"],
  );
  assert.equal(injected.events[0].commandId, steered.commandId, "input.steered 的 commandId 应等于受理应答的");
});

test("sendMessage clientRequestId：同键重试返回首次应答、不双发", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w-msg-idem", prompt: "p" });
  fake.createTaskAlreadyRunning(taskId); // queue 场景（running + auto→queued）

  const first = await sendMessage(config, taskId, "排队的话", "auto", undefined, "req-msg-dup-1");
  assert.equal(first.delivery, "queued");
  assert.match(first.commandId, /^cmd-\d+$/u);
  const second = await sendMessage(config, taskId, "排队的话", "auto", undefined, "req-msg-dup-1");
  assert.deepEqual(second, first, "同 clientRequestId 二次发送应回首次应答（同 delivery、同 commandId 原值）");

  const page = await getEvents(config, taskId, 0, 0);
  assert.equal(
    page.events.filter((event) => event.type === "input.queued").length,
    1,
    `同键两次发送不得双投：${JSON.stringify(page.events.map((event) => event.type))}`,
  );
});

test("sendMessage clientRequestId 非法：超 200 字符与空串 → 400 zcode_send_failed（exit 4）", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w-msg-badid", prompt: "p" });
  // 超长（201 字符，出 1..200 窗口）
  await assert.rejects(
    () => sendMessage(config, taskId, "x", "auto", undefined, "r".repeat(201)),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 400,
  );
  // 空串：api.js 层原样带进 body（!== undefined 判定），由端点按同口径判 400
  await assert.rejects(
    () => sendMessage(config, taskId, "x", "auto", undefined, ""),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 400,
  );
});

test("空闲任务 steer → sent、无 steer 事件", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w-idle-steer", prompt: "p" });
  const result = await sendMessage(config, taskId, "x", "steer");
  assert.deepEqual(result, { delivery: "sent" }, "空闲收到 steer 按实际去向应答 sent（无 commandId）");

  const page = await getEvents(config, taskId, 0, 0);
  assert.deepEqual(
    page.events.map((event) => event.type),
    ["turn.started"],
    "空闲 steer 不产生任何 steer 事件",
  );
});

test("sendMessage/stopTask/getTask/getEvents：任务不存在 → zcode_send_failed（exit 4）", async () => {
  const missing = "00000000-0000-4000-8000-000000000000";
  await assert.rejects(
    () => sendMessage(config, missing, "你好"),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 404,
  );
  await assert.rejects(
    () => stopTask(config, missing),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 404,
  );
  await assert.rejects(
    () => getTask(config, missing),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 404,
  );
  // getEvents 新语义：HTTP 404 统一抛错（旧版把 payload 原样返回）
  await assert.rejects(
    () => getEvents(config, missing, 0, 0),
    (error) =>
      error.code === "zcode_send_failed" &&
      error.exitCode === 4 &&
      error.status === 404 &&
      error.message.includes("任务可能已在 GUI 删除"),
  );
});

test("错 token → zcode_unauthorized（exit 5）", async () => {
  await assert.rejects(
    () => createTask({ ...config, token: "wrong-token" }, { workspacePath: "/w3", prompt: "p" }),
    (error) => error.code === "zcode_unauthorized" && error.exitCode === 5 && error.status === 401,
  );
});

test("apiPort 指向不存在的端口 → zcode_api_unreachable（exit 2）", async () => {
  await assert.rejects(
    () => createTask({ ...config, apiPort: 1 }, { workspacePath: "/w4", prompt: "p" }),
    (error) => error.code === "zcode_api_unreachable" && error.exitCode === 2,
  );
});

test("getEvents：立即取、超时空返、挂起唤醒、resync", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w5", prompt: "p" });

  // 事件已存在 → 立即返回
  fake.emitEvent(taskId, "assistant.message", { text: "你好" });
  const t0 = Date.now();
  let page = await getEvents(config, taskId, 0, 0);
  assert.ok(Date.now() - t0 < 500, `事件已存在时应立即返回，实际耗时 ${Date.now() - t0}ms`);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].seq, 1);
  assert.equal(page.events[0].type, "assistant.message");
  assert.equal(page.events[0].text, "你好");
  assert.ok(typeof page.events[0].at === "number");
  assert.equal(page.nextSeq, 1);

  // 无新事件 waitMs=200 → 约 200ms 后空返
  const t1 = Date.now();
  page = await getEvents(config, taskId, page.nextSeq, 200);
  const emptyElapsed = Date.now() - t1;
  assert.ok(emptyElapsed >= 190, `应等满 200ms 再空返，实际 ${emptyElapsed}ms`);
  assert.ok(emptyElapsed < 2000);
  assert.deepEqual(page, { events: [], nextSeq: 1 });

  // 挂起中（waitMs=5000）有新事件 → 立即唤醒返回
  const t2 = Date.now();
  const pending = getEvents(config, taskId, 1, 5000);
  setTimeout(() => fake.emitEvent(taskId, "turn.completed", { text: "完成" }), 50);
  page = await pending;
  const wakeElapsed = Date.now() - t2;
  assert.ok(wakeElapsed < 2000, `挂起中应被新事件立即唤醒，实际 ${wakeElapsed}ms`);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].seq, 2);
  assert.equal(page.events[0].type, "turn.completed");
  assert.equal(page.events[0].text, "完成");
  assert.equal(page.nextSeq, 2);

  // simulateResync → 下一次 events 请求返回 {resync:true}
  fake.simulateResync(taskId);
  page = await getEvents(config, taskId, 2, 0);
  assert.deepEqual(page, { resync: true });
});

test("POST 网络失败不重试（计数=1）且带防双建提示；GET 重试 1 次共两次", async () => {
  const hits = { post: 0, get: 0 };
  // 回环 server：对目标请求一律 res.destroy() 模拟网络中断，按路径计数
  const server = createServer((request, response) => {
    const pathname = request.url.split("?")[0];
    if (request.method === "POST" && pathname === "/api/tasks") {
      hits.post += 1;
      response.destroy();
      return;
    }
    if (request.method === "GET" && /^\/api\/tasks\/[^/]+$/u.test(pathname)) {
      hits.get += 1;
      response.destroy();
      return;
    }
    response.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = { apiPort: server.address().port, token: "t" };
  try {
    await assert.rejects(
      () => createTask(cfg, { workspacePath: "/w", prompt: "p" }),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.equal(error.exitCode, 2);
        assert.ok(error.message.includes("不要盲目重试"), `POST 失败消息应带防双建提示：${error.message}`);
        return true;
      },
    );
    assert.equal(hits.post, 1, "POST 失败后不得重试（防双建任务）");

    await assert.rejects(
      () => getTask(cfg, "task-x"),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.ok(!error.message.includes("不要盲目重试"), "GET 失败消息不带防双建提示");
        return true;
      },
    );
    assert.equal(hits.get, 2, "GET 失败后应重试一次，共两次");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("带 clientRequestId 的 createTask：网络失败重试 1 次同键成功；unreachable 不带防双建提示；sendMessage 只发 1 次仍带", async () => {
  const postHits = []; // 每次收到的 {pathname, clientRequestId}
  let mode = "break-first"; // break-first：首个 /api/tasks 断连后转正常；always-break：一律断连
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.destroy();
      return;
    }
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const pathname = request.url.split("?")[0];
      let reqId;
      try {
        reqId = JSON.parse(text).clientRequestId;
      } catch {
        reqId = undefined;
      }
      postHits.push({ pathname, clientRequestId: reqId });
      if (pathname !== "/api/tasks" || mode !== "serve") {
        if (pathname === "/api/tasks" && mode === "break-first") mode = "serve";
        response.destroy();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ taskId: "22222222-2222-4222-8222-222222222222" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = { apiPort: server.address().port, token: "t" };
  const taskPosts = () => postHits.filter((hit) => hit.pathname === "/api/tasks");
  try {
    // 首次断连 → 带幂等键自动重试一次成功，两次 body 的 clientRequestId 相同
    const { taskId } = await createTask(cfg, { workspacePath: "/w", prompt: "p", clientRequestId: "req-retry-1" });
    assert.equal(taskId, "22222222-2222-4222-8222-222222222222");
    assert.deepEqual(
      taskPosts().map((hit) => hit.clientRequestId),
      ["req-retry-1", "req-retry-1"],
      "应重试一次且两次 clientRequestId 相同",
    );

    // 始终断连：重试耗尽后 unreachable，且失败消息不带防双建提示（已自动重试过）
    mode = "always-break";
    const before = taskPosts().length;
    await assert.rejects(
      () => createTask(cfg, { workspacePath: "/w", prompt: "p", clientRequestId: "req-retry-2" }),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.equal(error.exitCode, 2);
        assert.ok(
          !error.message.includes("不要盲目重试"),
          `带幂等键的 POST 失败消息不应带防双建提示：${error.message}`,
        );
        return true;
      },
    );
    assert.equal(taskPosts().length - before, 2, "带幂等键的网络失败应重试一次共两次");

    // 对照：sendMessage（无幂等键 POST）同场景只发 1 次，失败消息仍带防双建提示
    const msgBefore = postHits.length;
    await assert.rejects(
      () => sendMessage(cfg, "task-x", "你好"),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.ok(error.message.includes("不要盲目重试"), `无幂等键 POST 失败消息应带防双建提示：${error.message}`);
        return true;
      },
    );
    const msgHits = postHits.slice(msgBefore);
    assert.deepEqual(
      msgHits.map((hit) => hit.pathname),
      ["/api/tasks/task-x/messages"],
      "无幂等键 POST 不得重试（只发 1 次）",
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("带 clientRequestId 的 sendMessage：断连重试 1 次同键成功；始终断连共两次且不带防双建提示", async () => {
  const msgHits = []; // 每次收到的 {pathname, clientRequestId}
  let mode = "break-first"; // break-first：首个 /messages 断连后转正常；always-break：一律断连
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.destroy();
      return;
    }
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const pathname = request.url.split("?")[0];
      let reqId;
      try {
        reqId = JSON.parse(text).clientRequestId;
      } catch {
        reqId = undefined;
      }
      msgHits.push({ pathname, clientRequestId: reqId });
      if (!pathname.endsWith("/messages") || mode !== "serve") {
        if (pathname.endsWith("/messages") && mode === "break-first") mode = "serve";
        response.destroy();
        return;
      }
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ delivery: "queued", commandId: "cmd-msg-retry-1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = { apiPort: server.address().port, token: "t" };
  const messagesPosts = (reqId) => msgHits.filter((hit) => hit.pathname.endsWith("/messages") && hit.clientRequestId === reqId);
  try {
    // 首次断连 → 带幂等键自动重试一次成功，两次 body 的 clientRequestId 相同
    const first = await sendMessage(cfg, "task-y", "排队的话", "auto", undefined, "req-msg-retry-1");
    assert.deepEqual(first, { delivery: "queued", commandId: "cmd-msg-retry-1" });
    assert.deepEqual(
      msgHits.filter((hit) => hit.pathname.endsWith("/messages")).map((hit) => hit.clientRequestId),
      ["req-msg-retry-1", "req-msg-retry-1"],
      "应重试一次且两次 clientRequestId 相同",
    );

    // 始终断连：重试耗尽后 unreachable 共两次请求；带键失败消息不带防双建提示（已自动重试过）
    mode = "always-break";
    await assert.rejects(
      () => sendMessage(cfg, "task-y", "又一句", "auto", undefined, "req-msg-retry-2"),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.equal(error.exitCode, 2);
        assert.ok(
          !error.message.includes("不要盲目重试"),
          `带幂等键的 sendMessage 失败消息不应带防双建提示：${error.message}`,
        );
        return true;
      },
    );
    assert.equal(messagesPosts("req-msg-retry-2").length, 2, "带幂等键的网络失败应重试一次共两次");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("unavailable_host（503）：视为暂态——GET 重试 1 次、无幂等 POST 只 1 次、带幂等 POST 重试后仍失败", async () => {
  fake.setOpUnavailable(true);
  try {
    // GET：重试 1 次共 2 次，最终 zcode_api_unreachable（exit 2，status 503）
    const getMark = fake.calls.length;
    await assert.rejects(
      () => getTask(config, "uh-1"),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.equal(error.exitCode, 2);
        assert.equal(error.status, 503);
        assert.ok(error.message.includes("unavailable_host"), `消息应含 unavailable_host：${error.message}`);
        return true;
      },
    );
    assert.equal(fake.calls.length - getMark, 2, "GET 应重试 1 次共 2 次请求");

    // 无幂等键 POST（sendMessage）：不重试只 1 次
    const msgMark = fake.calls.length;
    await assert.rejects(
      () => sendMessage(config, "uh-1", "你好"),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.equal(error.exitCode, 2);
        assert.ok(error.message.includes("unavailable_host"), `消息应含 unavailable_host：${error.message}`);
        return true;
      },
    );
    assert.equal(fake.calls.length - msgMark, 1, "无幂等键 POST 不得重试，只 1 次请求");

    // 带幂等键 POST（createTask）：重试 1 次后仍 503 → exit 2 共 2 次请求
    const postMark = fake.calls.length;
    await assert.rejects(
      () => createTask(config, { workspacePath: "/w-uh", prompt: "p", clientRequestId: "req-uh-1" }),
      (error) => {
        assert.equal(error.code, "zcode_api_unreachable");
        assert.equal(error.exitCode, 2);
        assert.ok(error.message.includes("unavailable_host"), `消息应含 unavailable_host：${error.message}`);
        return true;
      },
    );
    assert.equal(fake.calls.length - postMark, 2, "带幂等键 POST 应重试 1 次共 2 次请求");
  } finally {
    fake.setOpUnavailable(false);
  }
});

test("unavailable_host：第一次请求后立刻恢复（setOpUnavailable(false)）→ 同幂等键重试成功", async () => {
  fake.setOpUnavailable(true);
  const mark = fake.calls.length;
  const pending = createTask(config, { workspacePath: "/w-uh2", prompt: "p", clientRequestId: "req-uh-2" });
  // 竞态写法：轮询 calls 长度，第一次请求一到 fake（吃 503）就立刻关掉开关再等重试。
  // setImmediate 轮询在 check 相位运行，必先于任何后续 poll 相位（重试请求的到达），
  // 所以开关一定在重试被处理之前关掉，不会撞上第二次 503。
  const t0 = Date.now();
  while (fake.calls.length <= mark && Date.now() - t0 < 5000) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  fake.setOpUnavailable(false);

  const { taskId } = await pending;
  assert.match(taskId, /^[0-9a-f-]{36}$/u);
  assert.equal(fake.calls.length - mark, 2, "应恰好一次 503 + 一次成功重试");
  assert.ok(fake.createdTasks[taskId], "重试应真正建出任务");
});

test("unavailable_host：setOpUnavailable(false) 后恢复正常（sanity）", async () => {
  fake.setOpUnavailable(false);
  const { taskId } = await createTask(config, { workspacePath: "/w-uh3", prompt: "p" });
  assert.match(taskId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(fake.createdTasks[taskId], { workspacePath: "/w-uh3", title: "", status: "idle" });
});

test("Host 头不对 → 403 bad_host（鉴权与 Content-Type 之前）", async () => {
  const res = await rawRequest(fake.port, {
    method: "POST",
    path: "/api/tasks",
    headers: {
      host: "evil.example",
      authorization: "Bearer test-token",
      "content-type": "text/plain",
    },
    setHost: false,
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "bad_host");
});

test("无 token → 401（Host 之后、Content-Type 之前）", async () => {
  const res = await rawRequest(fake.port, {
    method: "POST",
    path: "/api/tasks",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("POST content-type 非 application/json → 415", async () => {
  const res = await rawRequest(fake.port, {
    method: "POST",
    path: "/api/tasks",
    headers: { authorization: "Bearer test-token", "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal(res.status, 415);
  assert.equal(res.body.error, "unsupported_media_type");
});

test("认识路径但方法不对（GET /api/tasks，无 token）→ 405 在鉴权前", async () => {
  const res = await rawRequest(fake.port, { method: "GET", path: "/api/tasks" });
  assert.equal(res.status, 405);
  assert.equal(res.body.error, "method_not_allowed");
});

test("完全不认识的路径（GET /nowhere，无 token）→ 404 在鉴权前", async () => {
  const res = await rawRequest(fake.port, { method: "GET", path: "/nowhere" });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "not_found");
});

test("body 超 16MiB → 413；客户端侧映射 zcode_create_failed", async () => {
  const padding = "x".repeat(16 * 1024 * 1024);
  const bodyText = JSON.stringify({ workspacePath: "/w-big", prompt: padding });
  assert.ok(bodyText.length > 16 * 1024 * 1024, "body 应为 16MiB+1 字节以上");

  const res = await rawRequest(fake.port, {
    method: "POST",
    path: "/api/tasks",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(bodyText),
    },
    body: bodyText,
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, "payload_too_large");

  await assert.rejects(
    () => createTask(config, { workspacePath: "/w-big", prompt: padding }),
    (error) => error.code === "zcode_create_failed" && error.status === 413,
  );
});

test("workspacePath 透传：sendMessage/getTask/getEvents/stopTask 各自带上，未带则不含", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w6", prompt: "p" });
  const queryOf = (record) => new URLSearchParams(record.url.split("?")[1] ?? "");

  await sendMessage(config, taskId, "带ws的话", "auto", "/w6");
  let record = fake.calls.at(-1);
  assert.equal(record.body.workspacePath, "/w6");

  await sendMessage(config, taskId, "不带ws的话");
  record = fake.calls.at(-1);
  assert.equal("workspacePath" in record.body, false, "未传 workspacePath 时 body 不得含该键");

  await getTask(config, taskId, "/w6");
  record = fake.calls.at(-1);
  assert.equal(queryOf(record).get("workspacePath"), "/w6");

  await getEvents(config, taskId, 0, 0, "/w6");
  record = fake.calls.at(-1);
  assert.equal(queryOf(record).get("workspacePath"), "/w6");

  await stopTask(config, taskId, "/w6");
  record = fake.calls.at(-1);
  assert.equal(record.body.workspacePath, "/w6");
});

test("forgetOwnership：丢表后不带 ws 无法路由，带对的 ws 重绑成功，带错的 task_mismatch", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w7", prompt: "p" });
  fake.forgetOwnership();

  // 不带 workspacePath → A 侧无从路由 → 404 task_not_found → zcode_send_failed
  await assert.rejects(
    () => getTask(config, taskId),
    (error) => error.code === "zcode_send_failed" && error.exitCode === 4 && error.status === 404,
  );

  // 带正确 workspacePath → 按任务自身归属重绑 → 正常返回
  const detail = await getTask(config, taskId, "/w7");
  assert.equal(detail.taskId, taskId);
  assert.equal(detail.workspacePath, "/w7");

  // 带错误 workspacePath → 404 task_mismatch
  await assert.rejects(
    () => getTask(config, taskId, "/other-workspace"),
    (error) => error.code === "zcode_send_failed" && error.status === 404,
  );
  const raw = await rawRequest(fake.port, {
    path: `/api/tasks/${taskId}?workspacePath=${encodeURIComponent("/other-workspace")}`,
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(raw.status, 404);
  assert.equal(raw.body.error, "task_mismatch");
});

test("事件字段：turn.started 带 turnId（每任务自增），input.queued/input.steered 带 commandId", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w8", prompt: "p" });

  await sendMessage(config, taskId, "第一句"); // 空闲 → turn.started
  fake.createTaskAlreadyRunning(taskId);
  const queued = await sendMessage(config, taskId, "排队的话", "auto"); // → input.queued（受理即自产）
  const steered = await sendMessage(config, taskId, "插队的话", "steer"); // → 202 steered 仅受理，不自产事件

  const page = await getEvents(config, taskId, 0, 0);
  const started = page.events[0];
  assert.equal(started.type, "turn.started");
  assert.match(started.turnId, /^turn-\d+$/u);
  assert.equal(started.turnId, "turn-1");
  const queuedEvent = page.events.find((event) => event.type === "input.queued");
  assert.ok(queuedEvent, "auto 受理应自产 input.queued");
  assert.match(queuedEvent.commandId, /^cmd-\d+$/u);
  assert.ok(
    !page.events.some((event) => event.type === "input.steered"),
    "steer 受理不得自产 input.steered（注入结果由控制方法投影）",
  );

  fake.settleSteer(taskId, "fellBack", "discarded_by_cli");
  const settled = await getEvents(config, taskId, page.nextSeq, 0);
  const steeredEvent = settled.events.find((event) => event.type === "input.steered");
  const fellBack = settled.events.find((event) => event.type === "steer.fellBack");
  assert.ok(steeredEvent && fellBack, "settleSteer 后应出现 input.steered 与 steer.fellBack");
  assert.equal(steeredEvent.commandId, steered.commandId);
  assert.equal(fellBack.error, "discarded_by_cli");

  // commandCounter 全 fake 共享，只断自增关系（cmd-N 严格递增；基于两次应答的 commandId）
  assert.equal(
    Number(steered.commandId.slice(4)),
    Number(queued.commandId.slice(4)) + 1,
    "commandId 应逐条自增",
  );
});

test("resetEventSeq：游标回退——旧 after 查询返回空且 nextSeq=0，挂起长轮询被唤醒", async () => {
  const { taskId } = await createTask(config, { workspacePath: "/w9", prompt: "p" });
  await sendMessage(config, taskId, "第一句"); // seq=1
  const page0 = await getEvents(config, taskId, 0, 0);
  assert.equal(page0.nextSeq, 1);

  // 挂起中的长轮询（after=99）被 resetEventSeq 唤醒，返回空页且游标回退到 0
  const pending = getEvents(config, taskId, 99, 5000);
  await new Promise((resolve) => setTimeout(resolve, 50)); // 让长轮询先挂上
  fake.resetEventSeq(taskId);
  const t0 = Date.now();
  const page1 = await pending;
  assert.ok(Date.now() - t0 < 2000, `resetEventSeq 应唤醒挂起的长轮询，实际等了 ${Date.now() - t0}ms`);
  assert.deepEqual(page1, { events: [], nextSeq: 0 });

  // 旧游标直接查：空页、nextSeq=0（不是停在旧值 1）
  const page2 = await getEvents(config, taskId, 1, 0);
  assert.deepEqual(page2, { events: [], nextSeq: 0 });
});

test("ZCODE_SUB_DEBUG=1：debug.log 记请求行（不含 body 与 token），网络失败记 ERR", async () => {
  const debugHome = mkdtempSync(join(tmpdir(), "zcode-sub-debug-"));
  const promptMark = "debug-secret-prompt-不应入日志";
  const tokenMark = "tok-debug-不应入日志";
  const prevDebug = process.env.ZCODE_SUB_DEBUG;
  const prevHome = process.env.ZCODE_SUB_HOME;
  process.env.ZCODE_SUB_DEBUG = "1";
  process.env.ZCODE_SUB_HOME = debugHome; // getHome() 优先读该 env
  try {
    await probeHealth(config);
    await assert.rejects(() =>
      createTask({ ...config, apiPort: 1, token: tokenMark }, { workspacePath: "/w", prompt: promptMark }),
    );

    const logText = readFileSync(join(debugHome, "debug.log"), "utf8");
    const lines = logText.trimEnd().split("\n");

    const healthLine = lines.find((line) => line.includes("GET /health"));
    assert.ok(healthLine, `应有 /health 请求行：\n${logText}`);
    assert.match(healthLine, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z GET \/health → 200 \d+字符$/u);

    assert.ok(
      lines.some((line) => line.includes(" POST /api/tasks → ERR ")),
      `网络失败应记 ERR 行：\n${logText}`,
    );

    assert.ok(!logText.includes(promptMark), "debug.log 不得含请求 body（prompt 内容）");
    assert.ok(!logText.includes(tokenMark), "debug.log 不得含 token");
  } finally {
    if (prevDebug === undefined) delete process.env.ZCODE_SUB_DEBUG;
    else process.env.ZCODE_SUB_DEBUG = prevDebug;
    if (prevHome === undefined) delete process.env.ZCODE_SUB_HOME;
    else process.env.ZCODE_SUB_HOME = prevHome;
    rmSync(debugHome, { recursive: true, force: true });
  }
});
