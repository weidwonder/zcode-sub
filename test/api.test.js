import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { createTask, getEvents, getTask, probeHealth, sendMessage, stopTask } from "../src/api.js";

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
  assert.deepEqual(fake.createdTasks[taskId], { workspacePath: "/w1", title: "任务一", status: "idle" });
});

test("createTask：workspace 未打开 → zcode_workspace_not_open（exit 3）", async () => {
  await assert.rejects(
    () => createTask(config, { workspacePath: "/workspace-closed", prompt: "做点事" }),
    (error) =>
      error.code === "zcode_workspace_not_open" && error.exitCode === 3 && error.status === 409,
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
    ["turn.started", "input.queued", "input.steered"],
  );
  assert.equal(page.nextSeq, 3);
});

test("sendMessage/stopTask/getTask：任务不存在 → zcode_send_failed（exit 4）", async () => {
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
