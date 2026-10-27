import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { loadConfig } from "../src/config.js";
import { loadTasks } from "../src/tasks.js";
import { readMailbox } from "../src/mailbox.js";

const BIN = join(import.meta.dirname, "..", "bin", "zcode-sub.js");
const SECRET = "s1";
const BOT_ID = "bot-1";

let fake;
let home;

// 每个测试文件独立 daemon 端口（node --test 并行跑文件，固定端口会互相冲突）
function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
const daemonPort = await reservePort();

// fake Zcode 跑在本测试进程内，必须用异步 spawn——spawnSync 会冻结事件循环，
// 让 fake 无法响应 CLI 子进程的请求。
function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        ZCODE_SUB_HOME: home,
        ZCODE_SUB_SECRET: SECRET,
        ...extraEnv,
      },
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

before(async () => {
  fake = await startFakeZcode({ secret: SECRET, botId: BOT_ID });
  home = mkdtempSync(join(tmpdir(), "zcode-sub-cli-"));
});

after(() => {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    process.kill(pid, "SIGTERM");
  } catch {
    // daemon 未起或已退出
  }
  rmSync(home, { recursive: true, force: true });
  return fake.stop();
});

test("setup --bot-id/--ingress-port 写回配置并打印 GUI 步骤与 MCP 片段", async () => {
  const result = await runCli(["setup", "--bot-id", BOT_ID, "--ingress-port", String(fake.port), "--daemon-port", String(daemonPort), "--secret", SECRET]);
  assert.equal(result.status, 0, result.stderr);
  const config = loadConfig(home);
  assert.equal(config.botId, BOT_ID);
  assert.equal(config.ingressPort, fake.port);
  const out = result.stdout;
  assert.match(out, /webhookUrl: http:\/\/127\.0\.0\.1:\d+\/zcode\/outbound/u);
  assert.match(out, /生成绑定码/u);
  assert.match(out, /"zcode-sub"/u);
  assert.match(out, /ZCODE_SUB_DAEMON_URL/u);
  assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${daemonPort}`));
});

test("setup --bind-code 绑定成功路径", async () => {
  fake.setReplyScript((text) => {
    if (text.startsWith("/bind ")) {
      return { ok: true, replies: ["绑定成功。发送 **/帮助** 查看可用命令。"] };
    }
    return undefined;
  });
  const result = await runCli(["setup", "--bind-code", "AB12CD"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /绑定成功/u);
  fake.setReplyScript(() => undefined);
});

test("setup --bind-code 过期码报错（exit 6）", async () => {
  fake.setReplyScript((text) => {
    if (text.startsWith("/bind ")) {
      return { ok: true, replies: ["绑定码无效或已过期，请在 zcode UI 重新生成。"] };
    }
    return undefined;
  });
  const result = await runCli(["setup", "--bind-code", "XX"]);
  assert.equal(result.status, 6);
  assert.match(result.stderr, /zcode_bind_code_invalid/u);
  fake.setReplyScript(() => undefined);
});

test("run：/new + 正文投递、任务文本含 name 与 reply_to_parent 说明、stdout 一行 JSON", async () => {
  const result = await runCli(["run", "修复登录页崩溃", "--cwd", "/tmp/demo", "--name", "fix-1"]);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split("\n").at(-1);
  const payload = JSON.parse(line);
  assert.equal(payload.name, "fix-1");
  assert.equal(payload.status, "dispatched");
  assert.equal(payload.cwd, "/tmp/demo");

  const texts = fake.calls.map((call) => call.body.text);
  assert.ok(texts.includes("/new"), "应先发 /new");
  const wrapped = texts.find((text) => text?.includes("修复登录页崩溃"));
  assert.ok(wrapped.includes("任务名：fix-1"));
  assert.ok(wrapped.includes("reply_to_parent"));
  assert.ok(wrapped.includes("/tmp/demo"));

  const task = loadTasks(home).tasks["fix-1"];
  assert.equal(task.isCurrent, true);
  assert.ok(readMailbox(home, "fix-1").length >= 1, "信箱应有派发 notice");
});

test("run：任务运行中拒绝（exit 3）", async () => {
  fake.setStatusState("running");
  const result = await runCli(["run", "第二个任务", "--cwd", "/tmp", "--name", "fix-2"]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /zcode_task_busy/u);
  const texts = fake.calls.map((call) => call.body.text);
  assert.ok(!texts.some((text) => typeof text === "string" && text.includes("第二个任务")), "正文不应被投递");
  fake.setStatusState("draft");
});

test("run：非法 name 拒绝（exit 7）", async () => {
  const result = await runCli(["run", "x", "--cwd", "/tmp", "--name", "a/b"]);
  assert.equal(result.status, 7);
  assert.match(result.stderr, /zcode_name_invalid/u);
});

test("list --json 列出任务", async () => {
  const result = await runCli(["list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.tasks.some((task) => task.name === "fix-1"));
});

test("daemon 自动拉起并保持出站接收可用（run 后 daemon.json 存在）", async () => {
  assert.ok(readFileSync(join(home, "daemon.json"), "utf8").includes("pid"));
});
