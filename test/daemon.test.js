import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { upsertTask } from "../src/tasks.js";
import { readMailbox } from "../src/mailbox.js";
import { saveConfig, createInitialConfig } from "../src/config.js";

let home;
let daemon;
let baseUrl;
const config = { ...createInitialConfig(), botId: "bot-1", secret: "s1", daemonPort: 0 };

before(async () => {
  home = mkdtempSync(join(tmpdir(), "zcode-sub-daemon-"));
  saveConfig(home, config);
  daemon = await startDaemon(home, config);
  baseUrl = `http://127.0.0.1:${daemon.port}`;
});

after(() => {
  daemon?.server.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function post(path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("health 返回 pid 与端口", async () => {
  const response = await fetch(`${baseUrl}/internal/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.pid, "number");
});

test("出站：匹配 botId/userId 落当前任务信箱", async () => {
  upsertTask(home, "job-a", { cwd: "/tmp", isCurrent: true });
  const response = await post("/zcode/outbound", {
    type: "zcode.bot.message",
    botId: "bot-1",
    provider: "webhook",
    userId: "zcode-sub",
    text: "第一段结果",
    sentAt: 1,
  }, { "x-zcode-bot-secret": "s1" });
  assert.equal(response.status, 204);
  const entries = readMailbox(home, "job-a");
  assert.equal(entries.at(-1).kind, "outbound");
  assert.equal(entries.at(-1).text, "第一段结果");
});

test("出站：secret 不符 401 且不落信箱", async () => {
  const before = readMailbox(home, "job-a").length;
  const response = await post("/zcode/outbound", {
    type: "zcode.bot.message", botId: "bot-1", userId: "zcode-sub", text: "x",
  }, { "x-zcode-bot-secret": "wrong" });
  assert.equal(response.status, 401);
  assert.equal(readMailbox(home, "job-a").length, before);
});

test("出站：botId/userId 不符 204 且不落信箱（防串台）", async () => {
  const before = readMailbox(home, "job-a").length;
  const response = await post("/zcode/outbound", {
    type: "zcode.bot.message", botId: "other-bot", userId: "zcode-sub", text: "x",
  }, { "x-zcode-bot-secret": "s1" });
  assert.equal(response.status, 204);
  assert.equal(readMailbox(home, "job-a").length, before);
});

test("internal/reply：落指定任务信箱；未知 task 404", async () => {
  const response = await post("/internal/reply", { task: "job-a", message: "主动汇报" },
    { "x-zcode-bot-secret": "s1" });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(readMailbox(home, "job-a").at(-1).kind, "reply");
  assert.equal(readMailbox(home, "job-a").at(-1).text, "主动汇报");

  const missing = await post("/internal/reply", { task: "no-such", message: "x" },
    { "x-zcode-bot-secret": "s1" });
  assert.equal(missing.status, 404);
});

test("internal/reply：secret 不符 401", async () => {
  const response = await post("/internal/reply", { task: "job-a", message: "x" },
    { "x-zcode-bot-secret": "nope" });
  assert.equal(response.status, 401);
});

test("daemon 日志落盘且含 event 行", () => {
  const logText = readFileSync(join(home, "daemon.log"), "utf8");
  assert.match(logText, /daemon_started/);
  assert.match(logText, /outbound_recorded/);
  assert.match(logText, /reply_recorded/);
});
