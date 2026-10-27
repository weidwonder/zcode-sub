import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { loadConfig, saveConfig, updateConfig } from "../src/config.js";
import { getTask, loadTasks } from "../src/tasks.js";
import { appendReplyLine } from "../src/mailbox.js";

const ROOT = join(import.meta.dirname, "..");
const BIN = join(ROOT, "bin", "zcode-sub.js");
const TOKEN = "tok-1";

let fake; // 主 fake：run/send/wait/result/stop 等全部命令共用
let setupFake; // setup 专用 fake（setup 会写独立 home，与主流程互不污染）
let home;
let setupHomeA;
let setupDataA;
let setupHomeB;
let setupDataB;

// fake Zcode 跑在本测试进程内，必须用异步 spawn——spawnSync 会冻结事件循环，
// 让 fake 无法响应 CLI 子进程的请求。
function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ZCODE_SUB_HOME: home, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: signal ? null : code, stdout, stderr });
    });
  });
}

async function dispatchTask(name, cwd = `/tmp/ws-${name}`) {
  const result = await runCli(["run", `任务正文-${name}`, "--cwd", cwd, "--name", name]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

before(async () => {
  fake = await startFakeZcode({ token: TOKEN });
  setupFake = await startFakeZcode({ token: "tok-setup" });
  home = mkdtempSync(join(tmpdir(), "zcode-sub-cli-"));
  saveConfig(home, { apiPort: fake.port, token: TOKEN });
  setupHomeA = mkdtempSync(join(tmpdir(), "zcode-sub-setup-a-"));
  setupDataA = mkdtempSync(join(tmpdir(), "zcode-sub-data-a-"));
  setupHomeB = mkdtempSync(join(tmpdir(), "zcode-sub-setup-b-"));
  setupDataB = mkdtempSync(join(tmpdir(), "zcode-sub-data-b-"));
  saveConfig(setupHomeB, { apiPort: 1, token: "old-token" });
});

after(async () => {
  for (const dir of [home, setupHomeA, setupHomeB, setupDataA, setupDataB]) {
    rmSync(dir, { recursive: true, force: true });
  }
  await fake.stop();
  await setupFake.stop();
});

test("无参数打印用法（exit 0）", async () => {
  const result = await runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /zcode-sub 用法/u);
  assert.match(result.stdout, /zcode-sub run "<任务>" --cwd <绝对路径>/u);
  assert.match(result.stdout, /zcode-sub mcp/u);
});

test("setup：开关文件不存在 → 生成（0600/enabled/port/64hex token）、health 通过、打印 MCP 片段", async () => {
  const result = await runCli(["setup", "--api-port", String(setupFake.port)], {
    ZCODE_SUB_HOME: setupHomeA,
    ZCODE_DATA_BASE_DIR: setupDataA,
  });
  assert.equal(result.status, 0, result.stderr);

  const switchFile = join(setupDataA, ".zcode", "v2", "local-task-api.json");
  const parsed = JSON.parse(readFileSync(switchFile, "utf8"));
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.port, setupFake.port);
  assert.match(parsed.token, /^[0-9a-f]{64}$/u);
  if (process.platform !== "win32") {
    assert.equal(statSync(switchFile).mode & 0o777, 0o600, "开关文件应为 0600");
  }

  const config = loadConfig(setupHomeA);
  assert.equal(config.apiPort, setupFake.port);
  assert.equal(config.token, parsed.token, "config 应读回生成的 token");

  assert.match(result.stdout, /✓ 已写入开关文件/u);
  assert.match(result.stdout, /✓ 本机任务 API 正常 zcodeVersion=test-1\.0\.0/u);
  assert.match(result.stdout, /状态目录可写/u);
  assert.ok(result.stdout.includes(setupHomeA), "MCP 片段应含 ZCODE_SUB_HOME=home 绝对路径");
  assert.ok(result.stdout.includes(join(ROOT, "bin", "zcode-sub.js")), "MCP 片段应含本包 bin 绝对路径");
  assert.match(result.stdout, /"zcode-sub"/u);
  assert.match(result.stdout, /mcp\.servers/u);
});

test("setup：开关文件已存在且启用 → 复用 token/port，不重写文件", async () => {
  const switchDir = join(setupDataB, ".zcode", "v2");
  mkdirSync(switchDir, { recursive: true });
  const switchFile = join(switchDir, "local-task-api.json");
  const before = `${JSON.stringify({ enabled: true, port: setupFake.port, token: TOKEN }, null, 2)}\n`;
  writeFileSync(switchFile, before, { mode: 0o600 });

  const result = await runCli(["setup"], {
    ZCODE_SUB_HOME: setupHomeB,
    ZCODE_DATA_BASE_DIR: setupDataB,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /开关文件已存在并启用/u);

  assert.equal(readFileSync(switchFile, "utf8"), before, "已启用的开关文件不应被重写");
  const config = loadConfig(setupHomeB);
  assert.equal(config.token, TOKEN, "token 应以开关文件为准");
  assert.equal(config.apiPort, setupFake.port, "port 应以开关文件为准");
  assert.match(result.stdout, /本机任务 API 正常/u);
});

test("run：stdout 一行 JSON；fake 收到 title/workspace/prompt；本地登记", async () => {
  const result = await runCli(["run", "修复登录页崩溃", "--cwd", "/tmp/demo", "--name", "fix-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1, "stdout 应只有一行 JSON");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.name, "fix-1");
  assert.equal(payload.status, "dispatched");
  assert.equal(payload.workspacePath, "/tmp/demo");
  assert.match(payload.taskId, /^[0-9a-f-]{36}$/u);

  assert.deepEqual(fake.createdTasks[payload.taskId], { workspacePath: "/tmp/demo", title: "fix-1", status: "idle" });

  const createCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "fix-1",
  );
  assert.ok(createCall, "应有 POST /api/tasks 调用");
  assert.equal(createCall.body.workspacePath, "/tmp/demo");
  const prompt = createCall.body.prompt;
  assert.ok(prompt.includes("任务名：fix-1"), `prompt 应含任务名：\n${prompt}`);
  assert.ok(prompt.includes("工作目录：/tmp/demo"));
  assert.ok(prompt.includes("reply_to_parent"));
  assert.ok(prompt.includes("----- 任务 -----"));
  assert.ok(prompt.includes("修复登录页崩溃"), "prompt 应含任务正文");

  assert.equal(getTask(home, "fix-1").taskId, payload.taskId);
  assert.equal(getTask(home, "fix-1").workspacePath, "/tmp/demo");
});

test("run：重名 → exit 7（ZCode 侧已创建、本地登记拒绝）", async () => {
  const dup = await runCli(["run", "再来一个", "--cwd", "/tmp/demo", "--name", "fix-1"]);
  assert.equal(dup.status, 7);
  assert.match(dup.stderr, /zcode_name_taken/u);
  assert.match(dup.stderr, /taskId=/u, "应提示 ZCode 侧已创建的 taskId");
});

test("run：--cwd 非绝对路径 → exit 1；省 --name 时自动生成 zsub- 名", async () => {
  const rel = await runCli(["run", "x", "--cwd", "tmp/relative", "--name", "rel-1"]);
  assert.equal(rel.status, 1);
  assert.match(rel.stderr, /--cwd/u);

  const auto = await runCli(["run", "自动命名任务", "--cwd", "/tmp/auto"]);
  assert.equal(auto.status, 0, auto.stderr);
  const payload = JSON.parse(auto.stdout);
  assert.match(payload.name, /^zsub-\d{8}-\d{6}$/u);
});

test("run：工作区未打开（409）→ exit 3 + zcode_workspace_not_open", async () => {
  const result = await runCli(["run", "被拒任务", "--cwd", "/workspace-closed", "--name", "closed-1"]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /zcode_workspace_not_open/u);
});

test("并行两任务：taskId 不同；wait A 立即拿到事件且 eventsSeq 推进；wait B 超时", async () => {
  const a = await dispatchTask("para-a");
  const b = await dispatchTask("para-b");
  assert.notEqual(a.taskId, b.taskId);

  fake.emitEvent(a.taskId, "assistant.message", { text: "A 进展" });

  const t0 = Date.now();
  const waitA = await runCli(["wait", "para-a", "--timeout", "2"]);
  assert.equal(waitA.status, 0, waitA.stderr);
  assert.ok(waitA.stdout.includes("[assistant.message] A 进展"));
  assert.ok(Date.now() - t0 < 5000, `wait A 应立即返回，实际 ${Date.now() - t0}ms`);
  assert.equal(loadTasks(home).tasks["para-a"].eventsSeq, 1, "eventsSeq 应推进到 1");

  const waitB = await runCli(["wait", "para-b", "--timeout", "2"]);
  assert.equal(waitB.status, 2);
  assert.equal(waitB.stdout, "TIMEOUT\n");
});

test("send：空闲 sent；运行中 auto→queued、--steer→steered、--queue→queued", async () => {
  const { taskId } = await dispatchTask("send-1");

  const idle = await runCli(["send", "send-1", "补充一句"]);
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /✓ 投递结果：sent/u);

  fake.createTaskAlreadyRunning(taskId);

  const queued = await runCli(["send", "send-1", "排队的话"]);
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /投递结果：queued/u);
  assert.match(queued.stdout, /commandId=cmd-\d+/u);

  const steered = await runCli(["send", "send-1", "插队的话", "--steer"]);
  assert.equal(steered.status, 0, steered.stderr);
  assert.match(steered.stdout, /投递结果：steered/u);

  const forced = await runCli(["send", "send-1", "强制排队", "--queue"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /投递结果：queued/u);
});

test("resume：空闲接续 sent；运行中拒绝（exit 4 busy_for_resume）", async () => {
  const { taskId } = await dispatchTask("res-1");

  const idle = await runCli(["resume", "res-1", "继续往下"]);
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /✓ 已接续对话（sent）/u);

  fake.createTaskAlreadyRunning(taskId);
  const busy = await runCli(["resume", "res-1", "又一句"]);
  assert.equal(busy.status, 4);
  assert.match(busy.stderr, /zcode_task_busy_for_resume/u);
});

test("stop：打印已请求停止", async () => {
  await dispatchTask("stop-1");
  const result = await runCli(["stop", "stop-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ 已请求停止/u);
});

test("result：idle 出最后回复全文；running 还在跑；waiting_permission 带 GUI 提示", async () => {
  const { taskId } = await dispatchTask("result-1");

  fake.setLastAssistantText(taskId, "这是最终总结全文");
  const idle = await runCli(["result", "result-1"]);
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /状态：idle/u);
  assert.match(idle.stdout, /----- 最后回复 -----/u);
  assert.ok(idle.stdout.includes("这是最终总结全文"));
  assert.equal(loadTasks(home).tasks["result-1"].lastStatus, "idle");

  fake.createTaskAlreadyRunning(taskId);
  const running = await runCli(["result", "result-1"]);
  assert.match(running.stdout, /还在跑（status=running）/u);
  assert.equal(loadTasks(home).tasks["result-1"].lastStatus, "running");

  fake.setTaskStatus(taskId, "waiting_permission");
  const waiting = await runCli(["result", "result-1"]);
  assert.match(waiting.stdout, /还在跑（status=waiting_permission）/u);
  assert.match(waiting.stdout, /⏳ 请在 ZCode GUI 处理/u);
  assert.match(waiting.stdout, /可用 zcode-sub wait result-1 收实时事件/u);
});

test("result：终态但无回复文本 → 打印占位提示", async () => {
  await dispatchTask("result-2");
  const result = await runCli(["result", "result-2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /状态：idle/u);
  assert.match(result.stdout, /----- 最后回复 -----/u);
  assert.match(result.stdout, /（无助手回复文本/u);
});

test("wait：事件打印与状态推进、信箱优先、permission 提示、resync 兜底", async () => {
  const { taskId } = await dispatchTask("wait-1");

  // 1) turn.completed 事件 → 打印并置 idle
  fake.emitEvent(taskId, "turn.completed", { text: "最终文本" });
  const gotEvent = await runCli(["wait", "wait-1", "--timeout", "5"]);
  assert.equal(gotEvent.status, 0, gotEvent.stderr);
  assert.ok(gotEvent.stdout.includes("[turn.completed] 最终文本"));
  assert.equal(loadTasks(home).tasks["wait-1"].eventsSeq, 1);
  assert.equal(loadTasks(home).tasks["wait-1"].lastStatus, "idle");

  // 2) 信箱新行 → [reply] 打印，且不重放已消费事件
  appendReplyLine(home, "wait-1", "来自 MCP 的主动消息");
  const gotReply = await runCli(["wait", "wait-1", "--timeout", "5"]);
  assert.equal(gotReply.status, 0, gotReply.stderr);
  assert.ok(gotReply.stdout.includes("[reply] 来自 MCP 的主动消息"));
  assert.ok(!gotReply.stdout.includes("[turn.completed]"), "已消费的事件不应重放");

  // 3) permission.requested → 额外 GUI 处理提示
  fake.emitEvent(taskId, "permission.requested", { summary: "要执行终端命令" });
  const permission = await runCli(["wait", "wait-1", "--timeout", "5"]);
  assert.equal(permission.status, 0, permission.stderr);
  assert.ok(permission.stdout.includes("[permission.requested] 要执行终端命令"));
  assert.match(permission.stdout, /⏳ 请在 ZCode GUI 处理该权限请求/u);

  // 4) 事件缓冲溢出 → resync 改查状态
  fake.simulateResync(taskId);
  const resync = await runCli(["wait", "wait-1", "--timeout", "5"]);
  assert.equal(resync.status, 0, resync.stderr);
  assert.match(resync.stdout, /⚠ 事件缓冲溢出，改查任务状态：idle/u);
  assert.match(resync.stdout, /完整过程见 ZCode GUI/u);
  assert.equal(loadTasks(home).tasks["wait-1"].lastStatus, "idle");
});

test("wait：长轮询挂起中事件到达 → 立即唤醒而非等满超时", async () => {
  const { taskId } = await dispatchTask("wait-live");
  setTimeout(() => fake.emitEvent(taskId, "assistant.message", { text: "挂起中到达" }), 300);
  const t0 = Date.now();
  const result = await runCli(["wait", "wait-live", "--timeout", "10"]);
  const elapsed = Date.now() - t0;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("[assistant.message] 挂起中到达"));
  assert.ok(elapsed < 5000, `应被长轮询立即唤醒，实际 ${elapsed}ms`);
});

test("错误：token 错 → exit 5；端口无人监听 → exit 2", async () => {
  updateConfig(home, { token: "wrong-token" });
  const unauthorized = await runCli(["run", "x", "--cwd", "/tmp/w", "--name", "err-1"]);
  assert.equal(unauthorized.status, 5);
  assert.match(unauthorized.stderr, /zcode_unauthorized/u);

  updateConfig(home, { apiPort: 1, token: TOKEN });
  const unreachable = await runCli(["run", "y", "--cwd", "/tmp/w", "--name", "err-2"]);
  assert.equal(unreachable.status, 2);
  assert.match(unreachable.stderr, /zcode_api_unreachable/u);

  updateConfig(home, { apiPort: fake.port, token: TOKEN });
  assert.deepEqual(loadConfig(home), { apiPort: fake.port, token: TOKEN });
});

test("list --json：包含 run 过的任务；空表文本提示", async () => {
  const result = await runCli(["list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const names = payload.tasks.map((task) => task.name);
  assert.ok(names.includes("fix-1"));
  assert.ok(names.includes("para-a"));
  const fix1 = payload.tasks.find((task) => task.name === "fix-1");
  assert.match(fix1.taskId, /^[0-9a-f-]{36}$/u);
  assert.equal(fix1.workspacePath, "/tmp/demo");

  const empty = await runCli(["list"], { ZCODE_SUB_HOME: setupHomeA });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /（还没有任务；用 zcode-sub run 派发）/u);
});
