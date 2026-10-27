import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig, saveConfig, createInitialConfig, updateConfig } from "../src/config.js";
import { loadTasks, saveTasks, registerTask, updateTask, getTask, listTaskNames } from "../src/tasks.js";
import { appendReplyLine, readMailboxLines, readCursor, writeCursor } from "../src/mailbox.js";
import { assertValidName } from "../src/home.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "zcode-sub-test-"));
}

function srcPath(name) {
  return fileURLToPath(new URL(`../src/${name}`, import.meta.url));
}

// 保证两次 Date.now() 落在不同毫秒，测试「ts 递增」不靠运气
function tickMs() {
  const start = Date.now();
  while (Date.now() === start) {}
}

test("配置：缺文件返回 null；保存后 0600 读回 {apiPort, token}", () => {
  const home = tempHome();
  try {
    assert.equal(loadConfig(home), null);
    saveConfig(home, { apiPort: 47900, token: "tok-1" });
    const loaded = loadConfig(home);
    assert.deepEqual(loaded, { apiPort: 47900, token: "tok-1" });
    assert.equal(createInitialConfig().apiPort, 47821);
    assert.equal(createInitialConfig().token, "");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配置：损坏按 null；updateConfig 以缺省值起步并合并", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), "{broken", "utf8");
    assert.equal(loadConfig(home), null);
    const next = updateConfig(home, { token: "tok-2" });
    assert.deepEqual(next, { apiPort: 47821, token: "tok-2" });
    assert.deepEqual(loadConfig(home), { apiPort: 47821, token: "tok-2" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("任务登记：字段齐全；同名再登记抛 zcode_name_taken（exitCode 7）", () => {
  const home = tempHome();
  try {
    const before = Date.now();
    const record = registerTask(home, "t1", { taskId: "task-abc", workspacePath: "/tmp/ws" });
    const after = Date.now();
    assert.equal(record.taskId, "task-abc");
    assert.equal(record.workspacePath, "/tmp/ws");
    assert.equal(record.lastStatus, "dispatched");
    assert.equal(record.eventsSeq, 0);
    assert.ok(record.createdAt >= before && record.createdAt <= after);
    assert.deepEqual(getTask(home, "t1"), record);

    assert.throws(
      () => registerTask(home, "t1", { taskId: "task-xyz", workspacePath: "/tmp/ws2" }),
      (err) => {
        assert.equal(err.code, "zcode_name_taken");
        assert.equal(err.exitCode, 7);
        assert.match(err.message, /任务名 "t1" 已存在/);
        return true;
      },
    );
    // 失败的登记不落盘
    assert.equal(getTask(home, "t1").taskId, "task-abc");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("任务更新：只动给定字段；不存在的 name 返回 null 不抛", () => {
  const home = tempHome();
  try {
    assert.equal(updateTask(home, "missing", { lastStatus: "running" }), null);
    const created = registerTask(home, "t1", { taskId: "task-abc", workspacePath: "/tmp/ws" });
    const updated = updateTask(home, "t1", { lastStatus: "running", eventsSeq: 3 });
    assert.equal(updated.lastStatus, "running");
    assert.equal(updated.eventsSeq, 3);
    assert.equal(updated.taskId, "task-abc");
    assert.equal(updated.workspacePath, "/tmp/ws");
    assert.equal(updated.createdAt, created.createdAt);
    // 单字段更新不动另一个
    updateTask(home, "t1", { eventsSeq: 5 });
    const task = getTask(home, "t1");
    assert.equal(task.lastStatus, "running");
    assert.equal(task.eventsSeq, 5);
    // 损坏任务表按空表起步
    writeFileSync(join(home, "tasks.json"), "{broken", "utf8");
    assert.deepEqual(loadTasks(home), { tasks: {} });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listTaskNames 按创建时间升序", () => {
  const home = tempHome();
  try {
    // 直接播种 createdAt，排序断言不依赖时钟
    saveTasks(home, {
      tasks: {
        late: { taskId: "a", workspacePath: "/w", createdAt: 300, lastStatus: "dispatched", eventsSeq: 0 },
        first: { taskId: "b", workspacePath: "/w", createdAt: 100, lastStatus: "dispatched", eventsSeq: 0 },
        mid: { taskId: "c", workspacePath: "/w", createdAt: 200, lastStatus: "dispatched", eventsSeq: 0 },
      },
    });
    assert.deepEqual(listTaskNames(home), ["first", "mid", "late"]);
    assert.deepEqual(Object.keys(loadTasks(home).tasks), ["late", "first", "mid"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("信箱：reply 追加两行、kind 均 reply、ts 递增；游标默认 0、写后读回；非法名拒绝", () => {
  const home = tempHome();
  try {
    assert.deepEqual(readMailboxLines(home, "t1"), []);
    assert.equal(readCursor(home, "t1"), 0);
    appendReplyLine(home, "t1", "第一句");
    tickMs();
    appendReplyLine(home, "t1", "第二句");
    const lines = readMailboxLines(home, "t1");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.kind), ["reply", "reply"]);
    assert.deepEqual(lines.map((line) => line.text), ["第一句", "第二句"]);
    assert.ok(lines.every((line) => Number.isInteger(line.ts) && line.ts > 0));
    assert.ok(lines[0].ts < lines[1].ts);
    // 崩溃期半行跳过，不挡后续读取
    writeFileSync(
      join(home, "mailboxes", "t1.jsonl"),
      `${JSON.stringify({ ts: 1, kind: "reply", text: "首行" })}\n{"ts":1,"kind":"rep`,
      "utf8",
    );
    const afterCrash = readMailboxLines(home, "t1");
    assert.equal(afterCrash.length, 1);
    assert.equal(afterCrash[0].text, "首行");

    writeCursor(home, "t1", 3);
    assert.equal(readCursor(home, "t1"), 3);

    assert.throws(() => appendReplyLine(home, "a/b", "x"), /zcode_name_invalid/);
    assert.throws(() => readMailboxLines(home, "a/b"), (err) => err.code === "zcode_name_invalid");
    assert.throws(() => writeCursor(home, "../escape", 1), (err) => err.code === "zcode_name_invalid");
    assert.throws(() => assertValidName("空 格"), /zcode_name_invalid/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("v1 残留模块已删除", () => {
  assert.equal(existsSync(srcPath("ingress.js")), false);
  assert.equal(existsSync(srcPath("daemon.js")), false);
  assert.equal(existsSync(srcPath("ensure.js")), false);
});
