import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { upsertTask } from "../src/tasks.js";
import { appendMailbox } from "../src/mailbox.js";

const BIN = join(import.meta.dirname, "..", "bin", "zcode-sub.js");
const SECRET = "s1";
const BOT_ID = "bot-1";

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

let fake;
let home;
const daemonPort = await reservePort();
let daemonBaseUrl;

// 模拟 ZCode 出站：向 daemon /zcode/outbound 投一条消息
async function emitOutbound(text) {
  const response = await fetch(`${daemonBaseUrl}/zcode/outbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcode-bot-secret": SECRET },
    body: JSON.stringify({
      type: "zcode.bot.message",
      botId: BOT_ID,
      provider: "webhook",
      userId: "zcode-sub",
      text,
      sentAt: Date.now(),
    }),
  });
  assert.equal(response.status, 204);
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ZCODE_SUB_HOME: home },
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
  home = mkdtempSync(join(tmpdir(), "zcode-sub-life-"));
  const setup = await runCli([
    "setup", "--bot-id", BOT_ID, "--ingress-port", String(fake.port),
    "--daemon-port", String(daemonPort), "--secret", SECRET,
  ]);
  assert.equal(setup.status, 0, setup.stderr);
  daemonBaseUrl = `http://127.0.0.1:${daemonPort}`;
});

after(() => {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    process.kill(pid, "SIGTERM");
  } catch {
    // daemon 已退出
  }
  rmSync(home, { recursive: true, force: true });
  return fake.stop();
});

test("生命周期：run → wait 收消息 → result 终态取全文", async () => {
  fake.setStatusState("draft");
  const run = await runCli(["run", "写一份 README", "--cwd", "/tmp", "--name", "life-1"]);
  assert.equal(run.status, 0, run.stderr);

  // 模拟 ZCode 出站两条正文
  await emitOutbound("正文第一段");
  await emitOutbound("正文第二段");

  const wait1 = await runCli(["wait", "life-1", "--timeout", "5"]);
  assert.equal(wait1.status, 0, wait1.stderr);
  assert.match(wait1.stdout, /\[outbound\] 正文第一段/u);
  assert.match(wait1.stdout, /\[outbound\] 正文第二段/u);

  // 游标已推进：立即再 wait 应超时
  const wait2 = await runCli(["wait", "life-1", "--timeout", "1"]);
  assert.equal(wait2.status, 2);
  assert.match(wait2.stdout, /TIMEOUT/u);

  fake.setStatusState("completed");
  const result = await runCli(["result", "life-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /状态: ✅ 已完成/u);
  assert.match(result.stdout, /正文第一段[\s\S]*正文第二段/u);
});

test("result：运行中明确说在跑", async () => {
  fake.setStatusState("running");
  const result = await runCli(["result", "life-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /还在跑/u);
});

test("result：/status 解析失败时原样报原文，不猜", async () => {
  fake.setReplyScript((text) => {
    if (text === "/status") {
      return { ok: true, replies: ["（上游改版后的未知格式）"] };
    }
    return undefined;
  });
  const result = await runCli(["result", "life-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /无法判定状态/u);
  assert.match(result.stdout, /未知格式/u);
  fake.setReplyScript(() => undefined);
});

test("send：运行中被拒收（exit 4）并原样转达", async () => {
  fake.setStatusState("running");
  fake.setReplyScript((text) => {
    if (!text.startsWith("/")) {
      return { ok: true, replies: ["当前任务正在运行，稍后再试，或使用 **/停止** 停止当前任务。"] };
    }
    return undefined;
  });
  const result = await runCli(["send", "life-1", "补充：请同时写安装说明"]);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /zcode_send_rejected/u);
  assert.match(result.stderr, /当前任务正在运行/u);
  fake.setReplyScript(() => undefined);
});

test("send：任务终态后投递即续聊", async () => {
  fake.setStatusState("completed");
  const result = await runCli(["send", "life-1", "补充：请同时写安装说明"]);
  assert.equal(result.status, 0, result.stderr);
  const texts = fake.calls.map((call) => call.body.text);
  assert.ok(texts.includes("补充：请同时写安装说明"));
});

test("resume：当前任务续聊成功；非当前任务拒绝", async () => {
  fake.setStatusState("completed");
  const ok = await runCli(["resume", "life-1", "继续：总结成三行"]);
  assert.equal(ok.status, 0, ok.stderr);
  const texts = fake.calls.map((call) => call.body.text);
  assert.ok(texts.includes("继续：总结成三行"));

  upsertTask(home, "other", { cwd: "/tmp", isCurrent: true });
  const rejected = await runCli(["resume", "life-1", "再继续"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /zcode_not_current/u);
});

test("stop：投递 /stop 并打印回执", async () => {
  fake.setStatusState("running");
  fake.setReplyScript((text) => {
    if (text === "/stop") {
      return {
        ok: true,
        replies: ["工作区: x\n模型: y\n------\n任务: t\n状态: 已停止"],
      };
    }
    return undefined;
  });
  const result = await runCli(["stop", "life-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /状态: 已停止/u);
  fake.setReplyScript(() => undefined);
});

test("reply_to_parent 的消息可通过 wait 取到（daemon 归档路径）", async () => {
  upsertTask(home, "life-1", { isCurrent: true });
  const response = await fetch(`${daemonBaseUrl}/internal/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zcode-bot-secret": SECRET },
    body: JSON.stringify({ task: "life-1", message: "子代理主动汇报：发现阻塞" }),
  });
  assert.equal(response.status, 200);
  const wait = await runCli(["wait", "life-1", "--timeout", "5"]);
  assert.equal(wait.status, 0, wait.stderr);
  assert.match(wait.stdout, /\[reply\] 子代理主动汇报：发现阻塞/u);
});
