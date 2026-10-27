import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendMailbox, readMailbox, readCursor, writeCursor } from "../src/mailbox.js";
import { loadConfig, saveConfig, createInitialConfig } from "../src/config.js";
import { upsertTask, getCurrentTask, getTask, loadTasks } from "../src/tasks.js";
import { assertValidName } from "../src/home.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "zcode-sub-test-"));
}

test("信箱追加与读取：seq 单调、跨进程重启续号", () => {
  const home = tempHome();
  try {
    assert.equal(appendMailbox(home, "t1", { kind: "outbound", text: "a" }), 1);
    assert.equal(appendMailbox(home, "t1", { kind: "reply", text: "b" }), 2);
    // 模拟重启：模块无状态，直接再追加，seq 从文件尾恢复
    assert.equal(appendMailbox(home, "t1", { kind: "outbound", text: "c" }), 3);
    const entries = readMailbox(home, "t1");
    assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3]);
    assert.equal(entries[0].text, "a");
    assert.ok(entries[0].ts > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("非法任务名拒绝（防路径穿越）", () => {
  assert.throws(() => appendMailbox(tempHome(), "a/b", { kind: "outbound", text: "x" }), /zcode_name_invalid/);
  assert.throws(() => assertValidName("../escape"), /zcode_name_invalid/);
  assert.throws(() => assertValidName("空 格"), /zcode_name_invalid/);
});

test("游标读写往返", () => {
  const home = tempHome();
  try {
    assert.equal(readCursor(home, "t1"), 0);
    appendMailbox(home, "t1", { kind: "outbound", text: "a" });
    writeCursor(home, "t1", 1);
    assert.equal(readCursor(home, "t1"), 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配置：缺文件返回 null；保存后 0600 可读回", () => {
  const home = tempHome();
  try {
    assert.equal(loadConfig(home), null);
    const config = createInitialConfig();
    saveConfig(home, { ...config, botId: "b1", ingressPort: 47900 });
    const loaded = loadConfig(home);
    assert.equal(loaded.botId, "b1");
    assert.equal(loaded.ingressPort, 47900);
    assert.equal(loaded.userId, "zcode-sub");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("任务登记：新任务成为 current，旧任务失格", () => {
  const home = tempHome();
  try {
    upsertTask(home, "first", { cwd: "/tmp", isCurrent: true });
    assert.equal(getCurrentTask(home), "first");
    upsertTask(home, "second", { cwd: "/tmp", isCurrent: true });
    assert.equal(getCurrentTask(home), "second");
    assert.equal(getTask(home, "first").isCurrent, false);
    assert.equal(loadTasks(home).tasks.second.lastStatus, "dispatched");
    // 状态更新不动 isCurrent
    upsertTask(home, "second", { lastStatus: "running" });
    assert.equal(getTask(home, "second").isCurrent, true);
    assert.equal(getTask(home, "second").lastStatus, "running");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
