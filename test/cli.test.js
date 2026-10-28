import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { unwritableHomeAdvice } from "../src/cli.js";
import { loadConfig, saveConfig, updateConfig } from "../src/config.js";
import { getTask, loadTasks, updateTask } from "../src/tasks.js";
import { appendReplyLine, readCursor } from "../src/mailbox.js";

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
let setupHomeC; // setup 端口冲突用
let setupDataC;
let capHomeA; // 并发上限：默认上限 4 的场景
let capHomeB; // 并发上限：ZCODE_SUB_MAX_RUNNING=2 的场景
let ghostHome; // GUI 删除任务（刷新 404）释放并发额度的场景
let modeHome; // config.defaultMode（合法/非法）与 --mode 覆盖的场景（独立 config，不污染共享 home）
let modelsHome; // config.defaultModel（默认模型选择）与 --model 覆盖的场景（独立 config）

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

async function dispatchTask(name, cwd = `/tmp/ws-${name}`, extraEnv = {}) {
  const result = await runCli(["run", `任务正文-${name}`, "--cwd", cwd, "--name", name], extraEnv);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// 本地登记置终态：run 的并发上限按本地未结束任务计数，测试收尾归位避免互相串扰。
function settle(name, status = "idle") {
  updateTask(home, name, { lastStatus: status });
}

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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
  setupHomeC = mkdtempSync(join(tmpdir(), "zcode-sub-setup-c-"));
  setupDataC = mkdtempSync(join(tmpdir(), "zcode-sub-data-c-"));
  capHomeA = mkdtempSync(join(tmpdir(), "zcode-sub-cap-a-"));
  capHomeB = mkdtempSync(join(tmpdir(), "zcode-sub-cap-b-"));
  saveConfig(capHomeA, { apiPort: fake.port, token: TOKEN });
  saveConfig(capHomeB, { apiPort: fake.port, token: TOKEN });
  ghostHome = mkdtempSync(join(tmpdir(), "zcode-sub-ghost-"));
  saveConfig(ghostHome, { apiPort: fake.port, token: TOKEN });
  modeHome = mkdtempSync(join(tmpdir(), "zcode-sub-mode-"));
  saveConfig(modeHome, { apiPort: fake.port, token: TOKEN });
  modelsHome = mkdtempSync(join(tmpdir(), "zcode-sub-models-"));
  saveConfig(modelsHome, { apiPort: fake.port, token: TOKEN });
});

after(async () => {
  for (const dir of [
    home,
    setupHomeA,
    setupHomeB,
    setupDataA,
    setupDataB,
    setupHomeC,
    setupDataC,
    capHomeA,
    capHomeB,
    ghostHome,
    modeHome,
    modelsHome,
  ]) {
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

test("未知参数报错（exit 1）：list 不收 --bogus；send 不收 --json；flag 校验先于任务查找", async () => {
  const list = await runCli(["list", "--bogus"]);
  assert.equal(list.status, 1);
  assert.match(list.stderr, /不认识的参数 --bogus/u);

  const send = await runCli(["send", "x", "y", "--json"]);
  assert.equal(send.status, 1);
  assert.match(send.stderr, /不认识的参数 --json/u);
  assert.ok(!send.stderr.includes("zcode_task_not_found"), "flag 校验应在任务查找之前拦下");
});

test("--version：打印 zcode-sub <版本号>（exit 0）；-v 不响应", async () => {
  const result = await runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^zcode-sub \d+\.\d+\.\d+\n$/u);

  const vShort = await runCli(["-v"]);
  assert.equal(vShort.status, 1);
  assert.match(vShort.stdout, /zcode-sub 用法/u, "-v 应按未知命令走用法打印");
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
  assert.ok(result.stdout.includes("~/.zcode/cli/config.json"), "MCP 片段说明应含配置文件位置");
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

test("setup：--api-port 与开关文件端口冲突 → 提示并以开关文件为准，其余步骤照常", async () => {
  const switchDir = join(setupDataC, ".zcode", "v2");
  mkdirSync(switchDir, { recursive: true });
  const switchFile = join(switchDir, "local-task-api.json");
  const beforeText = `${JSON.stringify({ enabled: true, port: setupFake.port, token: "tok-switch-c" }, null, 2)}\n`;
  writeFileSync(switchFile, beforeText, { mode: 0o600 });

  const result = await runCli(["setup", "--api-port", String(setupFake.port + 1)], {
    ZCODE_SUB_HOME: setupHomeC,
    ZCODE_DATA_BASE_DIR: setupDataC,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ 端口冲突：开关文件端口为/u);
  assert.ok(result.stdout.includes(`--api-port 指定 ${setupFake.port + 1}；以开关文件为准`), result.stdout);
  assert.ok(result.stdout.includes(switchFile), "冲突提示应含开关文件路径");
  assert.match(result.stdout, /开关文件已存在并启用/u);
  assert.match(result.stdout, /✓ 本机任务 API 正常/u, "冲突不阻断健康检查（用开关文件端口）");
  assert.match(result.stdout, /mcp\.servers/u, "MCP 片段照常打印");

  assert.equal(readFileSync(switchFile, "utf8"), beforeText, "开关文件不应被重写");
  const config = loadConfig(setupHomeC);
  assert.equal(config.apiPort, setupFake.port, "后续步骤用开关文件端口");
  assert.equal(config.token, "tok-switch-c");
});

test("setup：开关文件目录不可写 → 手动创建指引 + dwc grant 提示，流程继续", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // root 模拟不了不可写
  }
  const roHome = mkdtempSync(join(tmpdir(), "zcode-sub-setup-ro-home-"));
  const roData = mkdtempSync(join(tmpdir(), "zcode-sub-setup-ro-data-"));
  chmodSync(roData, 0o555);
  try {
    const result = await runCli(["setup", "--api-port", String(setupFake.port)], {
      ZCODE_SUB_HOME: roHome,
      ZCODE_DATA_BASE_DIR: roData,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✗ 开关文件不可写/u);
    assert.match(result.stdout, /完整 token 已存入/u);
    assert.match(
      result.stdout,
      new RegExp(`dwc grant ${escapeForRegExp(join(roData, ".zcode", "v2"))} 后重跑 setup`),
      "应提示对开关文件所在目录 dwc grant",
    );
    assert.match(result.stdout, /✓ 本机任务 API 正常/u, "开关文件不可写不阻断健康检查");
    assert.match(result.stdout, /状态目录可写/u);
  } finally {
    chmodSync(roData, 0o700);
    rmSync(roHome, { recursive: true, force: true });
    rmSync(roData, { recursive: true, force: true });
  }
});

test("setup：状态目录不可写 → exit 1 + dwc grant 指引，不裸崩", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // root 模拟不了不可写
  }
  const roHome = mkdtempSync(join(tmpdir(), "zcode-sub-setup-rohome-"));
  const roData = mkdtempSync(join(tmpdir(), "zcode-sub-setup-rodata2-"));
  chmodSync(roHome, 0o551);
  try {
    const result = await runCli(["setup"], { ZCODE_SUB_HOME: roHome, ZCODE_DATA_BASE_DIR: roData });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`✗ 状态目录不可写：${roHome}`), result.stdout);
    assert.match(result.stdout, new RegExp(`请执行：dwc grant ${escapeForRegExp(roHome)}`));
    assert.ok(!result.stderr.includes("mkdirSync"), `不应出现 Node 崩栈：\n${result.stderr}`);
    assert.equal(result.stderr, "", "提前退出不应产生任何 stderr 输出");
    assert.ok(!result.stdout.includes("本机任务 API"), "不可写时不应继续后续步骤");
  } finally {
    chmodSync(roHome, 0o700);
    rmSync(roHome, { recursive: true, force: true });
    rmSync(roData, { recursive: true, force: true });
  }
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

test("run：重名 → exit 7（本地预查拦下，不触上游、不建孤儿对话）", async () => {
  const callsBefore = fake.calls.length;
  const dup = await runCli(["run", "再来一个", "--cwd", "/tmp/demo", "--name", "fix-1"]);
  assert.equal(dup.status, 7);
  assert.match(dup.stderr, /zcode_name_taken/u);
  assert.match(dup.stderr, /任务名 "fix-1" 已存在，换一个名字/u);

  // 重名在触上游之前拦下：无任何新 API 调用，更没有新的 POST /api/tasks（不在
  // ZCode 侧留下孤儿对话）；并发竞态仍由 registerTask 的 EEXIST 兜底。
  const newCalls = fake.calls.slice(callsBefore);
  assert.equal(newCalls.length, 0, `重名 run 不应产生任何新的 API 调用：${JSON.stringify(newCalls)}`);
  assert.ok(
    !newCalls.some((call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks"),
    "重名 run 不应有新的 POST /api/tasks 请求",
  );
  settle("fix-1");
});

test("run：clientRequestId 贯穿 stdout JSON / createTask body / 本地分片；长度规则 41 在 1..200 窗口内", async () => {
  const result = await runCli(["run", "幂等键任务", "--cwd", "/tmp/crid", "--name", "crid-1"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.clientRequestId, /^zsub-[0-9a-f-]{36}$/u, "stdout JSON 应含 zsub- 前缀的 clientRequestId");

  // 偏离#12：生成规则钉住——"zsub-" 前缀 + 36 字符 UUID，总长 41，落在端点 1..200 长度窗口内。
  // 窗口时效无需专门用例：网络失败同键重试在同一请求循环内毫秒级完成
  // （见 api.test.js「网络失败重试 1 次同键成功」），远小于端点短期去重的 10 分钟窗口。
  assert.equal("zsub-".length + 36, 41, "生成规则：zsub-（5 字符）+ UUID（36 字符）= 41");
  assert.equal(payload.clientRequestId.length, 41);
  assert.ok(payload.clientRequestId.length >= 1 && payload.clientRequestId.length <= 200, "应在 1..200 长度窗口内");

  const createCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "crid-1",
  );
  assert.ok(createCall, "应有 POST /api/tasks 调用");
  assert.equal(createCall.body.clientRequestId, payload.clientRequestId, "createTask body 应带同一幂等键");

  const shard = JSON.parse(readFileSync(join(home, "tasks", "crid-1.json"), "utf8"));
  assert.equal(shard.clientRequestId, payload.clientRequestId, "本地分片应记录同一幂等键");
  settle("crid-1");
});

test("run：create 带回 first_prompt_failed → 照常登记、exit 0，stdout 带 warning，stderr 给补发指引", async () => {
  fake.failNextCreatePrompt();
  const result = await runCli(["run", "首条没送达的任务正文", "--cwd", "/tmp/fpf", "--name", "fpf-1"]);
  // 退出码保持 0：任务已建、登记成功，非零会让父代理误判整个 run 失败
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.name, "fpf-1");
  assert.equal(payload.status, "dispatched");
  assert.match(payload.taskId, /^[0-9a-f-]{36}$/u);
  assert.equal(payload.warning, "first_prompt_failed", "stdout JSON 应带 warning 字段");
  assert.equal(result.stdout.trim().split("\n").length, 1, "stdout 应仍只有一行 JSON");

  // stderr：首条未送达说明 + 补发指引（含任务名）
  assert.ok(result.stderr.includes("首条消息未送达"), `stderr 应含未送达说明：${result.stderr}`);
  assert.ok(result.stderr.includes("first_prompt_failed"), result.stderr);
  assert.ok(
    result.stderr.includes(`zcode-sub send fpf-1 "<原始任务全文>" 补发`),
    `stderr 应含带任务名的补发指引：${result.stderr}`,
  );

  // 任务照常登记：list --json 可见、分片存在
  const list = await runCli(["list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.ok(
    JSON.parse(list.stdout).tasks.some((task) => task.name === "fpf-1"),
    "list --json 应能看到 fpf-1",
  );
  assert.ok(existsSync(join(home, "tasks", "fpf-1.json")), "本地分片应存在");
  assert.equal(getTask(home, "fpf-1").taskId, payload.taskId);

  // fake 侧确实创建了任务（201 且 warning 没有吞掉建任务动作）
  assert.deepEqual(
    fake.createdTasks[payload.taskId],
    { workspacePath: "/tmp/fpf", title: "fpf-1", status: "idle" },
  );
  assert.ok(
    fake.calls.some(
      (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "fpf-1",
    ),
    "fake.calls 里应有 fpf-1 的建任务请求",
  );
  settle("fpf-1");
});

test("run：ZCode 侧已删的任务刷新 404 → 置 error 终态，不占并发额度", async () => {
  const ghostEnv = { ZCODE_SUB_HOME: ghostHome, ZCODE_SUB_MAX_RUNNING: "1" };
  const a = await dispatchTask("ghost-a", "/tmp/ws-ghost-a", ghostEnv);
  fake.createTaskAlreadyRunning(a.taskId);
  updateTask(ghostHome, "ghost-a", { lastStatus: "running" });

  // 模拟 GUI 删除后本地还留着旧登记：把分片 taskId 改成假值，fake 对未知 taskId 必然 404
  const shardFile = join(ghostHome, "tasks", "ghost-a.json");
  const shard = JSON.parse(readFileSync(shardFile, "utf8"));
  assert.equal(shard.lastStatus, "running");
  shard.taskId = "ghost-id";
  writeFileSync(shardFile, `${JSON.stringify(shard, null, 2)}\n`);

  // 若 ghost 仍占额度（未修复），这里会 exit 8
  const second = await runCli(["run", "额度已释放", "--cwd", "/tmp/ws-ghost-b", "--name", "ghost-b"], ghostEnv);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(
    fake.calls.some(
      (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "ghost-b",
    ),
    "额度释放后应能建新任务",
  );

  const after = JSON.parse(readFileSync(shardFile, "utf8"));
  assert.equal(after.lastStatus, "error", "ghost 任务应被 404 置为 error 终态落盘");
  updateTask(ghostHome, "ghost-b", { lastStatus: "idle" });
});

test("run：--cwd 非绝对路径 → exit 1；省 --name 时自动生成 zsub- 名", async () => {
  const rel = await runCli(["run", "x", "--cwd", "tmp/relative", "--name", "rel-1"]);
  assert.equal(rel.status, 1);
  assert.match(rel.stderr, /--cwd/u);

  const auto = await runCli(["run", "自动命名任务", "--cwd", "/tmp/auto"]);
  assert.equal(auto.status, 0, auto.stderr);
  const payload = JSON.parse(auto.stdout);
  assert.match(payload.name, /^zsub-\d{8}-\d{6}-\d{3}$/u);
  settle(payload.name);
});

test("run：mode 解析——默认 yolo；--mode plan 覆盖；--mode 非法 exit 1 不建任务", async () => {
  // 用户拍板：派发任务默认完全访问（yolo）
  const def = await dispatchTask("mode-def");
  const defCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "mode-def",
  );
  assert.ok(defCall, "应有 mode-def 的建任务请求");
  assert.equal(defCall.body.mode, "yolo", "未指定 --mode 时应默认派发 mode=yolo");
  settle("mode-def");

  const plan = await runCli(["run", "计划模式任务", "--cwd", "/tmp/mode-plan", "--name", "mode-plan", "--mode", "plan"]);
  assert.equal(plan.status, 0, plan.stderr);
  const planCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "mode-plan",
  );
  assert.ok(planCall, "应有 mode-plan 的建任务请求");
  assert.equal(planCall.body.mode, "plan", "--mode 应覆盖默认 yolo");
  settle("mode-plan");

  const bogus = await runCli(["run", "坏模式任务", "--cwd", "/tmp/mode-bogus", "--name", "mode-bogus", "--mode", "bogus"]);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /合法枚举/u);
  assert.ok(
    !fake.calls.some(
      (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "mode-bogus",
    ),
    "非法 --mode 应在建任务之前拒绝",
  );
});

test("run：--model/--thought 合成 modelSelection 进 create body（偏离#17）", async () => {
  const result = await runCli([
    "run",
    "带模型参数的任务",
    "--cwd",
    "/tmp/model-ok",
    "--name",
    "model-ok",
    "--model",
    "glm/glm-4.7",
    "--thought",
    "high",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const call = fake.calls.find(
    (entry) => entry.method === "POST" && entry.url.split("?")[0] === "/api/tasks" && entry.body?.title === "model-ok",
  );
  assert.ok(call, "应有 model-ok 的建任务请求");
  assert.deepEqual(call.body.modelSelection, {
    providerId: "glm",
    modelId: "glm-4.7",
    options: { reasoningLevel: "high" },
  });
  settle("model-ok");
});

test("run：--model 无斜杠 → exit 1 用法错误（--model 格式），不触上游", async () => {
  const callsBefore = fake.calls.length;
  const result = await runCli(["run", "坏格式任务", "--cwd", "/tmp/model-badfmt", "--name", "model-badfmt", "--model", "glm-glm-4.7"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model 格式/u);
  assert.equal(fake.calls.length, callsBefore, "格式错误在建任务之前拦下，不产生任何 API 调用");
});

test("run：--model 不在可用列表 → exit 1 zcode_model_invalid，stderr 给可选列表", async () => {
  const result = await runCli(["run", "不存在模型任务", "--cwd", "/tmp/model-miss", "--name", "model-miss", "--model", "openai/gpt-x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zcode_model_invalid/u);
  assert.match(result.stderr, /不在可用列表/u);
  assert.ok(result.stderr.includes("glm/glm-4.7"), `stderr 应含可选模型：${result.stderr}`);
  assert.ok(
    !fake.calls.some(
      (entry) => entry.method === "POST" && entry.url.split("?")[0] === "/api/tasks" && entry.body?.title === "model-miss",
    ),
    "预校验失败不建任务",
  );
});

test("run：只给 --thought 无 --model 且 config 无 defaultModel → exit 1（--thought 需要 --model 或 defaultModel）", async () => {
  const result = await runCli(["run", "光档位任务", "--cwd", "/tmp/model-thought", "--name", "model-thought", "--thought", "high"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--thought 需要/u);
});

test("run：--thought 档位不在该模型 thoughtLevels → exit 1 思考档位非法并列出可选", async () => {
  const result = await runCli([
    "run",
    "坏档位任务",
    "--cwd",
    "/tmp/model-turbo",
    "--name",
    "model-turbo",
    "--model",
    "glm/glm-4.7",
    "--thought",
    "turbo",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /思考档位非法/u);
  assert.ok(result.stderr.includes("off,medium,high"), `stderr 应含可选档位（逗号连接）：${result.stderr}`);
});

test("run：模型无思考档位（thoughtLevels 空数组）却给 --thought → exit 1 无思考档位", async () => {
  const result = await runCli([
    "run",
    "无档位模型任务",
    "--cwd",
    "/tmp/model-flash",
    "--name",
    "model-flash",
    "--model",
    "glm/glm-4.7-flash",
    "--thought",
    "high",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无思考档位/u);
  assert.match(result.stderr, /去掉 --thought/u);
});

test("run：config.defaultModel 兜底；--model 覆盖 provider/model 但 thought 沿用配置", async () => {
  const modelsEnv = { ZCODE_SUB_HOME: modelsHome };
  const selection = { providerId: "glm", modelId: "glm-4.7", options: { reasoningLevel: "medium" } };
  saveConfig(modelsHome, { apiPort: fake.port, token: TOKEN, defaultModel: selection });

  // 不带 --model：defaultModel 原样合成 modelSelection
  const plain = await runCli(["run", "配置默认模型", "--cwd", "/tmp/cfg-model-a", "--name", "cfg-model-a"], modelsEnv);
  assert.equal(plain.status, 0, plain.stderr);
  const plainCall = fake.calls.find(
    (entry) => entry.method === "POST" && entry.url.split("?")[0] === "/api/tasks" && entry.body?.title === "cfg-model-a",
  );
  assert.ok(plainCall, "应有 cfg-model-a 的建任务请求");
  assert.deepEqual(plainCall.body.modelSelection, selection);
  settle("cfg-model-a");

  // --model 只覆盖 provider/model，--thought 未给时 reasoningLevel 沿用配置
  const override = await runCli(
    ["run", "覆盖模型沿用档位", "--cwd", "/tmp/cfg-model-b", "--name", "cfg-model-b", "--model", "openai/gpt-5"],
    modelsEnv,
  );
  assert.equal(override.status, 0, override.stderr);
  const overrideCall = fake.calls.find(
    (entry) => entry.method === "POST" && entry.url.split("?")[0] === "/api/tasks" && entry.body?.title === "cfg-model-b",
  );
  assert.ok(overrideCall, "应有 cfg-model-b 的建任务请求");
  assert.deepEqual(overrideCall.body.modelSelection, {
    providerId: "openai",
    modelId: "gpt-5",
    options: { reasoningLevel: "medium" },
  });
  settle("cfg-model-b");
});

test("models：文本表含表头/模型/默认标记；--json 输出可解析", async () => {
  const table = await runCli(["models"]);
  assert.equal(table.status, 0, table.stderr);
  assert.ok(table.stdout.split("\n")[0].startsWith("providerId\tmodelId\t"), `表头应为 providerId/modelId：${table.stdout.split("\n")[0]}`);
  assert.ok(table.stdout.includes("glm-4.7"), `应含 glm-4.7：${table.stdout}`);
  assert.ok(table.stdout.includes("*"), `默认行应标 *：${table.stdout}`);

  const json = await runCli(["models", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.providers[0].providerId, "glm");
  assert.equal(payload.preferred.providerId, "glm");
});

test("model：换模型——预校验拦下不存在的模型；合法值切换成功并带 zsub- 幂等键", async () => {
  await dispatchTask("mdl-1");

  const invalid = await runCli(["model", "mdl-1", "glm/gpt-x"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /不在可用列表/u);

  const ok = await runCli(["model", "mdl-1", "openai/gpt-5", "--thought", "low"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes("已切换模型 openai/gpt-5"), `stdout 应含切换成功：${ok.stdout}`);
  assert.ok(ok.stdout.includes("（思考档位 low）"), `stdout 应含档位：${ok.stdout}`);
  assert.ok(ok.stdout.includes("（下一轮生效）"), `stdout 应含生效说明：${ok.stdout}`);

  const post = fake.calls.at(-1);
  assert.equal(post.method, "POST");
  assert.equal(post.url.split("?")[0].endsWith("/model"), true);
  assert.deepEqual(post.body.modelSelection, { providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "low" } });
  assert.match(post.body.clientRequestId, /^zsub-/u);
  settle("mdl-1");
});

test("model：缺参数 → exit 1 用法错误", async () => {
  const result = await runCli(["model"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /用法：zcode-sub model <name> <providerId\/modelId>/u);
});

test("bin 错误前缀去重：message 已含 code 前缀时不再重复", async () => {
  const result = await runCli(["result", "no-such-task"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zcode_task_not_found/u);
  assert.ok(
    !result.stderr.includes("zcode_task_not_found: zcode_task_not_found"),
    `不应出现双前缀：${result.stderr}`,
  );
  assert.equal(
    result.stderr.split("zcode_task_not_found").length - 1,
    1,
    `zcode_task_not_found 恰好出现一次：${result.stderr}`,
  );
});

test("run：config.defaultMode=plan 生效；--mode 优先于 config；非法 defaultMode 忽略按 yolo 并提示", async () => {
  const modeEnv = { ZCODE_SUB_HOME: modeHome };

  saveConfig(modeHome, { apiPort: fake.port, token: TOKEN, defaultMode: "plan" });
  const plan = await runCli(["run", "配置默认 plan", "--cwd", "/tmp/cfg-mode-a", "--name", "cfg-plan"], modeEnv);
  assert.equal(plan.status, 0, plan.stderr);
  const planCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "cfg-plan",
  );
  assert.ok(planCall, "应有 cfg-plan 的建任务请求");
  assert.equal(planCall.body.mode, "plan", "config.defaultMode=plan 应生效");

  // --mode 显式传入优先于 config.defaultMode
  const override = await runCli(
    ["run", "显式覆盖配置", "--cwd", "/tmp/cfg-mode-b", "--name", "cfg-override", "--mode", "default"],
    modeEnv,
  );
  assert.equal(override.status, 0, override.stderr);
  const overrideCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "cfg-override",
  );
  assert.ok(overrideCall, "应有 cfg-override 的建任务请求");
  assert.equal(overrideCall.body.mode, "default", "--mode 应优先于 config.defaultMode");

  saveConfig(modeHome, { apiPort: fake.port, token: TOKEN, defaultMode: "bogus" });
  const bogus = await runCli(["run", "配置默认非法", "--cwd", "/tmp/cfg-mode-c", "--name", "cfg-bogus"], modeEnv);
  assert.equal(bogus.status, 0, bogus.stderr);
  const bogusCall = fake.calls.find(
    (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "cfg-bogus",
  );
  assert.ok(bogusCall, "应有 cfg-bogus 的建任务请求");
  assert.equal(bogusCall.body.mode, "yolo", "非法 defaultMode 应忽略并按默认 yolo");
  assert.match(bogus.stderr, /已忽略/u);
  assert.ok(!bogus.stdout.includes("已忽略"), "提示只进 stderr，stdout 保持一行 JSON");
  settle("cfg-plan");
  settle("cfg-override");
  settle("cfg-bogus");
});

test("run：自动命名带毫秒尾巴——同秒先后两次也不同名", async () => {
  const r1 = await runCli(["run", "自动命名 A", "--cwd", "/tmp/auto-ms"]);
  assert.equal(r1.status, 0, r1.stderr);
  const n1 = JSON.parse(r1.stdout).name;
  settle(n1);

  const r2 = await runCli(["run", "自动命名 B", "--cwd", "/tmp/auto-ms"]);
  assert.equal(r2.status, 0, r2.stderr);
  const n2 = JSON.parse(r2.stdout).name;
  settle(n2);

  assert.match(n1, /^zsub-\d{8}-\d{6}-\d{3}$/u);
  assert.match(n2, /^zsub-\d{8}-\d{6}-\d{3}$/u);
  assert.notEqual(n1, n2);
});

test("run：并发派发上限——4 个未结束第 5 个 exit 8；MAX_RUNNING=2 时第 3 个 exit 8", async () => {
  const capEnvA = { ZCODE_SUB_HOME: capHomeA };
  // 每派一个立即在 fake 标 running：后续派发的计数刷新会把本地 lastStatus 刷成 running 并计入
  for (const name of ["cap-1", "cap-2", "cap-3", "cap-4"]) {
    const { taskId } = await dispatchTask(name, `/tmp/cap-${name}`, capEnvA);
    fake.createTaskAlreadyRunning(taskId);
  }

  const fifth = await runCli(["run", "超限任务", "--cwd", "/tmp/cap-x", "--name", "cap-5"], capEnvA);
  assert.equal(fifth.status, 8, fifth.stderr);
  assert.match(fifth.stderr, /zcode_too_many_running/u);
  assert.match(fifth.stderr, /已有 4 个任务未结束（上限 4）/u);
  assert.match(fifth.stderr, /自动释放额度/u, "exit 8 提示应含 GUI 删除释放额度的补句");
  assert.ok(
    !fake.calls.some(
      (call) => call.method === "POST" && call.url.split("?")[0] === "/api/tasks" && call.body?.title === "cap-5",
    ),
    "超限应在 createTask 之前拒绝，不建新对话",
  );

  const capEnvB = { ZCODE_SUB_HOME: capHomeB, ZCODE_SUB_MAX_RUNNING: "2" };
  const a = await dispatchTask("cap-a", "/tmp/cap-a", capEnvB);
  fake.createTaskAlreadyRunning(a.taskId);
  const b = await dispatchTask("cap-b", "/tmp/cap-b", capEnvB);
  fake.createTaskAlreadyRunning(b.taskId);

  const third = await runCli(["run", "超限任务", "--cwd", "/tmp/cap-x", "--name", "cap-c"], capEnvB);
  assert.equal(third.status, 8, third.stderr);
  assert.match(third.stderr, /zcode_too_many_running/u);
  assert.match(third.stderr, /已有 2 个任务未结束（上限 2）/u);
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
  settle("para-b");
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
  assert.match(steered.stdout, /ℹ steered 仅为受理引导/u);
  assert.match(steered.stdout, /以事件流为准/u);
  // steer 应答=受理；注入结果的事件流断言见下方 steer 用例

  const forced = await runCli(["send", "send-1", "强制排队", "--queue"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /投递结果：queued/u);
  settle("send-1");
});

test("wait 打印 steer 注入结果（injected 与 fellBack）；steer 事件不改 lastStatus", async () => {
  const { taskId } = await dispatchTask("steer-1");
  fake.createTaskAlreadyRunning(taskId);

  // 1) send --steer：应答=受理，附受理提示行
  const steered = await runCli(["send", "steer-1", "插队的话", "--steer"]);
  assert.equal(steered.status, 0, steered.stderr);
  assert.match(steered.stdout, /投递结果：steered/u);
  assert.match(steered.stdout, /ℹ steered 仅为受理引导；注入结果以事件流为准（wait 可见 steer.injected \/ steer.fellBack）/u);

  // 2) 注入成功：wait 打印投影出的 input.steered（commandId 对上本地受理记录 →「你的引导已受理」）与 steer.injected
  fake.settleSteer(taskId, "injected");
  const injected = await runCli(["wait", "steer-1", "--timeout", "5"]);
  assert.equal(injected.status, 0, injected.stderr);
  assert.match(injected.stdout, /\[input\.steered\] 你的引导已受理（commandId=cmd-\d+）；注入结果以事件流为准/u);
  assert.match(injected.stdout, /\[steer\.injected\] 引导已注入当前轮（打断生效）/u);

  // 3) 降级/拒绝：wait 打印 steer.fellBack 并带原因
  const again = await runCli(["send", "steer-1", "再插一句", "--steer"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /投递结果：steered/u);
  fake.settleSteer(taskId, "fellBack", "turn_ended");
  const fellBack = await runCli(["wait", "steer-1", "--timeout", "5"]);
  assert.equal(fellBack.status, 0, fellBack.stderr);
  assert.match(fellBack.stdout, /\[steer\.fellBack\] 引导被降级\/拒绝，原因：turn_ended——消息将按排队处理或需重发/u);

  // 4) GUI 侧发起的引导：commandId 不在本 CLI 的受理记录里 → 标「来自 GUI 侧的引导」
  fake.emitEvent(taskId, "input.steered", { commandId: "cmd-gui-9" });
  const gui = await runCli(["wait", "steer-1", "--timeout", "5"]);
  assert.equal(gui.status, 0, gui.stderr);
  assert.match(gui.stdout, /\[input\.steered\] 来自 GUI 侧的引导（commandId=cmd-gui-9）/u);

  // 5) 三种 steer 事件只打印，不参与 lastStatus 推导（终态仍只认 turn.completed/turn.failed）
  assert.equal(loadTasks(home).tasks["steer-1"].lastStatus, "dispatched");
  settle("steer-1");
});

test("send：body 带幂等键；空闲 --steer 应答 sent", async () => {
  await dispatchTask("n1");

  // 空闲任务收到 --steer：A 侧按实际去向应答 sent（不打印「仅为受理」提示）
  const result = await runCli(["send", "n1", "话", "--steer"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /投递结果：sent/u);
  assert.ok(!result.stdout.includes("仅为受理"), `空闲 steer 应答 sent，不应有受理提示：${result.stdout}`);

  // send 生成幂等键（"zsub-"+UUID，总长 41）并随 messages body 上送
  const messagesCalls = fake.calls.filter((call) => call.url.split("?")[0].endsWith("/messages"));
  const lastMessages = messagesCalls.at(-1);
  assert.ok(lastMessages, "应有 messages 请求");
  assert.match(lastMessages.body.clientRequestId, /^zsub-/u);
  assert.equal(lastMessages.body.clientRequestId.length, 41, "幂等键应为 zsub-（5）+ UUID（36）= 41 字符");
  settle("n1");
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
  settle("res-1");
});

test("stop：打印已请求停止", async () => {
  await dispatchTask("stop-1");
  const result = await runCli(["stop", "stop-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ 已请求停止/u);
  settle("stop-1");
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
  settle("result-1");
});

test("result：未知 status → 打印原文并按非终态处理", async () => {
  const { taskId } = await dispatchTask("unk-1");
  fake.setTaskStatus(taskId, "weird_state");
  const result = await runCli(["result", "unk-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /状态未知（原文 weird_state）/u);
  assert.equal(loadTasks(home).tasks["unk-1"].lastStatus, "weird_state");
  settle("unk-1");
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

  // 4) 事件缓冲溢出 → resync 提示改用 result 轮询，并同步末次状态
  fake.simulateResync(taskId);
  const resync = await runCli(["wait", "wait-1", "--timeout", "5"]);
  assert.equal(resync.status, 0, resync.stderr);
  assert.match(resync.stdout, /⚠ 事件缓冲溢出，改用 zcode-sub result wait-1 轮询（完整过程见 ZCode GUI）/u);
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
  settle("wait-live");
});

test("wait：事件正文超 2000 字符截断（reply 信箱行保持全文）", async () => {
  const { taskId } = await dispatchTask("tr-1");

  fake.emitEvent(taskId, "assistant.message", { text: "x".repeat(3000) });
  const got = await runCli(["wait", "tr-1", "--timeout", "5"]);
  assert.equal(got.status, 0, got.stderr);
  assert.ok(got.stdout.includes("x".repeat(2000)), "应打印前 2000 字符");
  assert.ok(!got.stdout.includes("x".repeat(2001)), "第 2001 字符起不应打印");
  assert.ok(got.stdout.includes("…（共 3000 字符，全文用 result 或 ZCode GUI 查看）"));

  appendReplyLine(home, "tr-1", "y".repeat(3000));
  const reply = await runCli(["wait", "tr-1", "--timeout", "5"]);
  assert.equal(reply.status, 0, reply.stderr);
  assert.ok(reply.stdout.includes(`[reply] ${"y".repeat(3000)}`), "reply 信箱行不截断");
  settle("tr-1");
});

test("wait：事件批超 20000 字符 → 略过提示 + lastStatus/游标照常推进", async () => {
  const { taskId } = await dispatchTask("bulk-ev");
  for (let i = 0; i < 29; i += 1) {
    fake.emitEvent(taskId, "assistant.message", { text: `e${i}-${"x".repeat(1500)}` });
  }
  // 终态事件藏在被略过的尾部：lastStatus 的判断必须先扫全部事件再决定打印多少
  fake.emitEvent(taskId, "turn.completed", { text: "全部完成" });

  const got = await runCli(["wait", "bulk-ev", "--timeout", "3"]);
  assert.equal(got.status, 0, got.stderr);
  assert.match(got.stdout, /…（本批剩余 \d+ 条略过，全文用 result 或 ZCode GUI 查看）/u);
  assert.ok(got.stdout.length < 25_000, `stdout 应小于 25000 字符，实际 ${got.stdout.length}`);
  assert.ok(got.stdout.includes("e0-"), "上限内的事件应照常打印");
  assert.ok(!got.stdout.includes("e28-"), "超限后的事件不应逐条打印");
  assert.ok(!got.stdout.includes("全部完成"), "被略过的终态事件正文也不打印");

  // 游标照常推进到 nextSeq；被略过的 turn.completed 也要把 lastStatus 推到 idle
  assert.equal(loadTasks(home).tasks["bulk-ev"].eventsSeq, 30);
  assert.equal(loadTasks(home).tasks["bulk-ev"].lastStatus, "idle");

  fake.emitEvent(taskId, "turn.failed", { error: "批次后失败" });
  const failed = await runCli(["wait", "bulk-ev", "--timeout", "3"]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(loadTasks(home).tasks["bulk-ev"].lastStatus, "error");

  // 再 wait 无新事件 → 长轮询挂起到超时 TIMEOUT（不重放已消费事件）
  const t0 = Date.now();
  const again = await runCli(["wait", "bulk-ev", "--timeout", "3"]);
  assert.equal(again.status, 2);
  assert.equal(again.stdout, "TIMEOUT\n");
  assert.ok(Date.now() - t0 < 8000, `TIMEOUT 应在超时预算内返回，实际 ${Date.now() - t0}ms`);
  settle("bulk-ev", "error");
});

test("wait：reply 批超 20000 字符 → 略过提示 + 游标推进到尾", async () => {
  await dispatchTask("bulk-rp");
  for (let i = 0; i < 15; i += 1) {
    appendReplyLine(home, "bulk-rp", `r${i}-${"y".repeat(2000)}`);
  }

  const got = await runCli(["wait", "bulk-rp", "--timeout", "3"]);
  assert.equal(got.status, 0, got.stderr);
  assert.match(got.stdout, /…（剩余 \d+ 条 reply 略过，全文见 .*bulk-rp\.jsonl）/u);
  assert.ok(got.stdout.includes(join(home, "mailboxes", "bulk-rp.jsonl")), "略过提示应含信箱文件绝对路径");
  assert.ok(got.stdout.includes("r0-"), "上限内的 reply 应照常打印");
  assert.ok(!got.stdout.includes("r14-"), "超限后的 reply 不应逐条打印");
  assert.equal(readCursor(home, "bulk-rp"), 15, "游标应推进到全部行数");

  // 游标已到尾：再 wait 无新 reply，不重放
  const again = await runCli(["wait", "bulk-rp", "--timeout", "2"]);
  assert.equal(again.status, 2);
  assert.equal(again.stdout, "TIMEOUT\n");
  settle("bulk-rp");
});

test("wait：单条 reply 超 20000 字符 → 降级输出前 2000 + 信箱路径，游标照常推进", async () => {
  await dispatchTask("big-rp");
  appendReplyLine(home, "big-rp", "B".repeat(30000));

  const got = await runCli(["wait", "big-rp", "--timeout", "3"]);
  assert.equal(got.status, 0, got.stderr);
  assert.ok(got.stdout.includes(`[reply] ${"B".repeat(2000)}`), "应打印前 2000 字符");
  assert.ok(!got.stdout.includes("B".repeat(2001)), "第 2001 字符起不应打印");
  assert.ok(got.stdout.includes("…（共 30000 字符，全文见"), "降级提示应含总字符数");
  assert.ok(got.stdout.includes(join(home, "mailboxes", "big-rp.jsonl")), "降级提示应含信箱文件绝对路径");
  assert.ok(got.stdout.length < 25_000, `stdout 应小于 25000 字符，实际 ${got.stdout.length}`);
  assert.equal(readCursor(home, "big-rp"), 1, "游标应照常推进");

  // 游标已推进：再 wait 无新 reply → TIMEOUT（exit 2）
  const again = await runCli(["wait", "big-rp", "--timeout", "2"]);
  assert.equal(again.status, 2);
  assert.equal(again.stdout, "TIMEOUT\n");

  // 未超单条限（10000 < 20000）的 reply 仍全文输出
  appendReplyLine(home, "big-rp", "C".repeat(10000));
  const full = await runCli(["wait", "big-rp", "--timeout", "3"]);
  assert.equal(full.status, 0, full.stderr);
  assert.ok(full.stdout.includes(`[reply] ${"C".repeat(10000)}`), "未超单条限的 reply 应全文输出");
  settle("big-rp");
});

test("wait：ZCode 重启事件缓冲清空 → 游标回退继续等新事件", async () => {
  const { taskId } = await dispatchTask("rb-1");

  fake.emitEvent(taskId, "assistant.message", { text: "重启前事件" });
  const first = await runCli(["wait", "rb-1", "--timeout", "5"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(loadTasks(home).tasks["rb-1"].eventsSeq, 1);

  // 先等 wait 的长轮询挂进 fake（calls 里出现本次 events 请求）再触发重置：
  // resetEventSeq 会唤醒挂起中的长轮询，CLI 收到空页且 nextSeq=0 < after=1 → 回退游标
  const callsBefore = fake.calls.length;
  const pending = runCli(["wait", "rb-1", "--timeout", "8"]);
  const t0 = Date.now();
  while (fake.calls.length === callsBefore && Date.now() - t0 < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fake.calls.length > callsBefore, "wait 的 events 请求应已到达 fake");
  fake.resetEventSeq(taskId);
  setTimeout(() => fake.emitEvent(taskId, "assistant.message", { text: "重启后事件" }), 300);

  const second = await pending;
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /⚠ 事件序列已重置（ZCode 可能重启）：1→0，继续等待新事件/u);
  assert.ok(second.stdout.includes("[assistant.message] 重启后事件"), "回退后应继续收到新事件");
  assert.equal(loadTasks(home).tasks["rb-1"].eventsSeq, 1, "回退到 0 后应随新事件推进回 1");
  settle("rb-1");
});

test("workspacePath 传递：send/resume/stop/result 的请求都带登记的 workspacePath", async () => {
  const ws = "/tmp/ws-wp-pass";
  const { taskId } = await dispatchTask("wp-1", ws);

  await runCli(["send", "wp-1", "补一句"]);
  await runCli(["resume", "wp-1", "续一句"]);
  await runCli(["stop", "wp-1"]);
  await runCli(["result", "wp-1"]);

  const enc = encodeURIComponent(ws);
  const hasWs = (call) => call.body?.workspacePath === ws || call.url.includes(`workspacePath=${enc}`);
  const posts = (suffix) => fake.calls.filter((call) => call.url.split("?")[0] === `/api/tasks/${taskId}${suffix}`);
  const gets = fake.calls.filter((call) => call.method === "GET" && call.url.split("?")[0] === `/api/tasks/${taskId}`);

  assert.ok(posts("/messages").length >= 2, "send 与 resume 各一次 messages 调用");
  assert.ok(posts("/messages").every(hasWs), "messages 请求应带登记的 workspacePath");
  assert.equal(posts("/stop").length, 1);
  assert.ok(posts("/stop").every(hasWs), "stop 请求应带登记的 workspacePath");
  assert.ok(gets.length >= 2, "resume 与 result 各一次 getTask 查询");
  assert.ok(gets.every(hasWs), "getTask 查询应带登记的 workspacePath");
  settle("wp-1");
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

  const table = await runCli(["list"]);
  assert.equal(table.status, 0, table.stderr);
  assert.equal(table.stdout.split("\n")[0], "name\ttaskId(后8位)\tlastStatus\tcreatedAt\tworkspacePath");
  const fix1Line = table.stdout.split("\n").find((line) => line.startsWith("fix-1\t"));
  assert.ok(fix1Line, "文本表应有 fix-1 行");
  const cols = fix1Line.split("\t");
  assert.equal(cols.length, 5);
  assert.equal(cols[1], fix1.taskId.slice(-8), "文本表 taskId 应显示后 8 位");
  assert.equal(cols[2], "idle");
  assert.ok(!Number.isNaN(Date.parse(cols[3])), `createdAt 应为 ISO 时间：${cols[3]}`);
  assert.equal(cols[4], "/tmp/demo");
});

test("list 文本表：taskId 列显示后 8 位（session_ 前缀无区分度）", async () => {
  const { taskId } = await dispatchTask("tail-1");
  const table = await runCli(["list"]);
  assert.equal(table.status, 0, table.stderr);
  assert.ok(table.stdout.split("\n")[0].includes("taskId(后8位)"), "表头应为 taskId(后8位)");
  const line = table.stdout.split("\n").find((row) => row.startsWith("tail-1\t"));
  assert.ok(line, "文本表应有 tail-1 行");
  assert.ok(line.includes(taskId.slice(-8)), `应含完整 taskId 的后 8 位（${taskId.slice(-8)}）：${line}`);
  settle("tail-1");
});

test("forgetOwnership：带 workspacePath 可按工作区重绑成功；本地 workspacePath 改错 → exit 4", async () => {
  await dispatchTask("own-1", "/tmp/ws-own");

  fake.forgetOwnership();
  const rebound = await runCli(["result", "own-1"]);
  assert.equal(rebound.status, 0, rebound.stderr);
  assert.match(rebound.stdout, /状态：idle/u);

  // 直接改本地分片 <home>/tasks/<name>.json 的 workspacePath → 请求带错 → 归属不符
  const shardFile = join(home, "tasks", "own-1.json");
  const shard = JSON.parse(readFileSync(shardFile, "utf8"));
  assert.equal(shard.workspacePath, "/tmp/ws-own");
  shard.workspacePath = "/tmp/ws-mutated";
  writeFileSync(shardFile, `${JSON.stringify(shard, null, 2)}\n`);

  const mismatch = await runCli(["result", "own-1"]);
  assert.equal(mismatch.status, 4);
  assert.match(mismatch.stderr, /zcode_send_failed/u);
});

test("unwritableHomeAdvice：ZCODE_SUB_HOME 已设置 → dwc grant；未设置 → 变量含义、shim 模板与重定向说明", () => {
  const fromEnv = unwritableHomeAdvice("/var/empty/zcode-sub", true);
  assert.ok(fromEnv.includes("✗ 状态目录不可写：/var/empty/zcode-sub"), fromEnv);
  assert.ok(fromEnv.includes("dwc grant /var/empty/zcode-sub"), fromEnv);

  const noEnv = unwritableHomeAdvice("/var/empty", false);
  assert.ok(noEnv.includes("HOME 被重定向"), noEnv);
  assert.ok(noEnv.includes("ZCODE_DATA_BASE_DIR  ZCode 数据目录基目录"), noEnv, "应解释两个变量各自的含义");
  assert.ok(noEnv.includes("shim"), noEnv);
  assert.ok(noEnv.includes('exec /Users/<你的用户名>/projects/zcode-sub/bin/zcode-sub.js "$@"'), noEnv);
  assert.ok(noEnv.includes("export ZCODE_SUB_HOME=/Users/<你的用户名>/.zcode-sub"), noEnv);
  assert.ok(noEnv.includes("export ZCODE_DATA_BASE_DIR=/Users/<你的用户名>"), noEnv);
});
