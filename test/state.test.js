import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadConfig, saveConfig, createInitialConfig, updateConfig } from "../src/config.js";
import { loadTasks, registerTask, updateTask, getTask, listTaskNames, appendSteerCommandId } from "../src/tasks.js";
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

// 子进程登记脚本：home/name/taskId 走环境变量传，避开 -e 的 argv 位次差异。
// 退出码：成功 0；失败透传 err.exitCode（zcode_name_taken → 7），错误码写 stderr。
const registerChildScript = `
import { pathToFileURL } from "node:url";
const { registerTask } = await import(pathToFileURL(process.env.TASKS_SRC).href);
try {
  registerTask(process.env.HOME_DIR, process.env.TASK_NAME, {
    taskId: process.env.TASK_ID,
    workspacePath: "/tmp/ws",
  });
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err.code ?? err.message) + "\\n");
  process.exit(err.exitCode ?? 1);
}
`;

function spawnRegisterChild(home, name, taskId) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", registerChildScript],
    {
      env: {
        ...process.env,
        TASKS_SRC: srcPath("tasks.js"),
        HOME_DIR: home,
        TASK_NAME: name,
        TASK_ID: taskId,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const exit = new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stderr: stderrChunks.join("") }));
  });
  return { exit };
}

function shardPath(home, name) {
  return join(home, "tasks", `${name}.json`);
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

test("配置：defaultModel 纯对象才带该键；非对象/null/数组/缺省均不含（旧形状 deepEqual 不破坏）", () => {
  const home = tempHome();
  try {
    const selection = { providerId: "glm", modelId: "glm-4.7", options: { reasoningLevel: "medium" } };
    saveConfig(home, { apiPort: 47900, token: "tok-1", defaultModel: selection });
    assert.deepEqual(loadConfig(home), { apiPort: 47900, token: "tok-1", defaultModel: selection });

    for (const bad of [null, "glm/glm-4.7", 42, [], true]) {
      saveConfig(home, { apiPort: 47900, token: "tok-1", defaultModel: bad });
      assert.deepEqual(
        loadConfig(home),
        { apiPort: 47900, token: "tok-1" },
        `defaultModel=${JSON.stringify(bad)} 时不应带该键`,
      );
    }

    saveConfig(home, { apiPort: 47900, token: "tok-1" });
    assert.equal("defaultModel" in loadConfig(home), false);
    // 旧形状读回不变
    assert.deepEqual(loadConfig(home), { apiPort: 47900, token: "tok-1" });
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
    // 损坏分片聚合时跳过，按空表起步
    writeFileSync(shardPath(home, "t1"), "{broken", "utf8");
    assert.deepEqual(loadTasks(home), { tasks: {} });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("updateTask 显式重置游标：resetEventsSeq 直接写值（可变小）；普通 patch 仍取 max；标志不落盘", () => {
  const home = tempHome();
  try {
    registerTask(home, "t1", { taskId: "task-reset", workspacePath: "/tmp/ws" });
    updateTask(home, "t1", { eventsSeq: 5 });
    assert.equal(getTask(home, "t1").eventsSeq, 5);
    // 不带标志的普通 patch 仍取 max（防并发乱序）：较小值不得回退较大的存量游标
    updateTask(home, "t1", { eventsSeq: 3 });
    assert.equal(getTask(home, "t1").eventsSeq, 5);
    // 显式重置：ZCode 重启/缓冲释放后游标归零——直接写入 patch 值，不被 max 抵消
    updateTask(home, "t1", { eventsSeq: 0, resetEventsSeq: true });
    assert.equal(getTask(home, "t1").eventsSeq, 0);
    // 重置后普通推进照常（游标没被冻死）：从 0 起正常 max 前进
    updateTask(home, "t1", { eventsSeq: 3 });
    assert.equal(getTask(home, "t1").eventsSeq, 3);
    // resetEventsSeq 是调用方标志，不得落进分片 JSON
    assert.equal("resetEventsSeq" in JSON.parse(readFileSync(shardPath(home, "t1"), "utf8")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listTaskNames 按创建时间升序", () => {
  const home = tempHome();
  try {
    // 直写分片播种（saveTasks 已删），createdAt 手工定死，排序断言不依赖时钟
    mkdirSync(join(home, "tasks"), { recursive: true });
    const seed = (name, createdAt) =>
      writeFileSync(
        shardPath(home, name),
        `${JSON.stringify({ taskId: name, workspacePath: "/w", createdAt, lastStatus: "dispatched", eventsSeq: 0 }, null, 2)}\n`,
        "utf8",
      );
    seed("late", 300);
    seed("first", 100);
    seed("mid", 200);
    assert.deepEqual(listTaskNames(home), ["first", "mid", "late"]);
    // 分片聚合顺序不保证（目录序），只断言集合
    assert.deepEqual(Object.keys(loadTasks(home).tasks).sort(), ["first", "late", "mid"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("任务登记：clientRequestId 有则入分片并读回，无则不含该字段", () => {
  const home = tempHome();
  try {
    const withKey = registerTask(home, "t1", {
      taskId: "task-1",
      workspacePath: "/tmp/ws",
      clientRequestId: "req-1",
    });
    assert.equal(withKey.clientRequestId, "req-1");
    assert.deepEqual(getTask(home, "t1"), withKey);
    const raw = JSON.parse(readFileSync(shardPath(home, "t1"), "utf8"));
    assert.equal(raw.clientRequestId, "req-1");
    // 可选尾字段排在固定字段之后
    assert.deepEqual(Object.keys(raw), [
      "taskId",
      "workspacePath",
      "createdAt",
      "lastStatus",
      "eventsSeq",
      "clientRequestId",
    ]);

    const without = registerTask(home, "t2", { taskId: "task-2", workspacePath: "/tmp/ws" });
    assert.equal("clientRequestId" in without, false);
    assert.equal("clientRequestId" in getTask(home, "t2"), false);
    assert.equal("clientRequestId" in JSON.parse(readFileSync(shardPath(home, "t2"), "utf8")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("坏分片 registerTask：备份 .corrupt-* 后覆盖重登记；完好分片同名仍 zcode_name_taken", () => {
  const home = tempHome();
  try {
    const dir = join(home, "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(shardPath(home, "t1"), "{broken", "utf8");

    const record = registerTask(home, "t1", { taskId: "task-new", workspacePath: "/tmp/ws" });
    assert.equal(record.taskId, "task-new", "损坏分片不应挡登记（覆盖重登记）");
    assert.equal(getTask(home, "t1").taskId, "task-new");
    const backups = readdirSync(dir).filter((f) => f.startsWith("t1.json.corrupt-"));
    assert.equal(backups.length, 1, `应出现恰一份 .corrupt-* 备份：${readdirSync(dir)}`);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), "{broken", "备份应保住原内容");
    assert.equal(
      readdirSync(dir).filter((f) => f === "t1.json").length,
      1,
      "重登记后同名分片应恰好一份且内容完好",
    );

    // 完好分片同名再登记照旧拒绝，原登记不受影响
    assert.throws(
      () => registerTask(home, "t1", { taskId: "task-x", workspacePath: "/tmp/ws2" }),
      (err) => err.code === "zcode_name_taken" && err.exitCode === 7,
    );
    assert.equal(getTask(home, "t1").taskId, "task-new");
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

test("子进程真并行登记 8 个不同名：全部落盘、taskId 各归各", async () => {
  const home = tempHome();
  try {
    const children = [];
    for (let i = 0; i < 8; i++) {
      children.push(spawnRegisterChild(home, `t-${i}`, `task-${i}`));
    }
    const results = await Promise.all(children.map((child) => child.exit));
    const stderrTexts = JSON.stringify(results.map((result) => result.stderr));
    assert.deepEqual(
      results.map((result) => result.code),
      Array(8).fill(0),
      `子进程应全部登记成功：${stderrTexts}`,
    );
    const store = loadTasks(home);
    assert.equal(Object.keys(store.tasks).length, 8);
    for (let i = 0; i < 8; i++) {
      assert.equal(store.tasks[`t-${i}`].taskId, `task-${i}`);
      assert.equal(store.tasks[`t-${i}`].workspacePath, "/tmp/ws");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("子进程同名竞态：恰好一个成功一个 zcode_name_taken，落盘是二者之一", async () => {
  const home = tempHome();
  try {
    const children = [spawnRegisterChild(home, "race", "task-A"), spawnRegisterChild(home, "race", "task-B")];
    const results = await Promise.all(children.map((child) => child.exit));
    assert.deepEqual(
      results.map((result) => result.code).sort((a, b) => a - b),
      [0, 7],
      `应恰好一胜一负：${JSON.stringify(results)}`,
    );
    const loser = results.find((result) => result.code === 7);
    assert.match(loser.stderr, /zcode_name_taken/);
    // 胜者落盘且内容稳定：taskId 是二者之一，分片与读回一致
    const record = getTask(home, "race");
    assert.ok(record, "胜者应已落盘");
    assert.ok(["task-A", "task-B"].includes(record.taskId), `taskId 应是二者之一：${record.taskId}`);
    const raw = JSON.parse(readFileSync(shardPath(home, "race"), "utf8"));
    assert.equal(raw.taskId, record.taskId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("同名合法分片（内容为别的任务）：registerTask 零退避立即 zcode_name_taken", () => {
  const home = tempHome();
  try {
    const dir = join(home, "tasks");
    mkdirSync(dir, { recursive: true });
    // 完好分片但内容是别的任务：首读即解析成功，必须零退避立即拒绝
    writeFileSync(
      shardPath(home, "t1"),
      `${JSON.stringify(
        { taskId: "task-other", workspacePath: "/other", createdAt: 1, lastStatus: "running", eventsSeq: 9 },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const start = Date.now();
    assert.throws(
      () => registerTask(home, "t1", { taskId: "task-mine", workspacePath: "/tmp/ws" }),
      (err) => err.code === "zcode_name_taken" && err.exitCode === 7,
    );
    // 零退避路径：任何退避路径至少 +50ms、全预算 ~150ms；上限放宽到 100ms
    // 只为排除机器病态卡顿，仍足以证明没走退避
    assert.ok(Date.now() - start < 100, `合法分片应零退避立即拒绝，实耗 ${Date.now() - start}ms`);
    // 原分片分毫不动，也不产生 .corrupt-* 备份
    assert.equal(getTask(home, "t1").taskId, "task-other");
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("t1.json.corrupt-")), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appendSteerCommandId：追加、幂等、无分片/坏分片返回 null 不写", () => {
  const home = tempHome();
  try {
    // 无分片 → null 且不建 tasks 目录（不做任何写副作用）
    assert.equal(appendSteerCommandId(home, "t1", "cmd-1"), null);
    assert.equal(existsSync(join(home, "tasks")), false);

    // 正常登记后追加两次 → 读回有序列表；重复追加幂等
    registerTask(home, "t1", { taskId: "task-1", workspacePath: "/tmp/ws" });
    assert.ok(appendSteerCommandId(home, "t1", "cmd-1"), "正常分片应返回 record");
    appendSteerCommandId(home, "t1", "cmd-2");
    assert.deepEqual(getTask(home, "t1").steerCommandIds, ["cmd-1", "cmd-2"]);
    appendSteerCommandId(home, "t1", "cmd-1");
    assert.deepEqual(getTask(home, "t1").steerCommandIds, ["cmd-1", "cmd-2"], "同一 commandId 不得重复追加");

    // 坏分片 → null，且不产生 .corrupt-* 备份、坏文件内容不动（无写副作用）
    const dir = join(home, "tasks");
    writeFileSync(shardPath(home, "t1"), "{broken", "utf8");
    assert.equal(appendSteerCommandId(home, "t1", "cmd-3"), null);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("t1.json.corrupt-")), []);
    assert.equal(readFileSync(shardPath(home, "t1"), "utf8"), "{broken");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 并发合并写（顺序用例钉契约）：后台 wait 写 eventsSeq 与前台 send 写 steerCommandIds
// 走的是同一分片的两条读-改-写路径，写回前重读合并——任一方的字段都不得被另一方冲掉。
test("并发合并写：updateTask(eventsSeq) 后 appendSteerCommandId，eventsSeq 不丢", () => {
  const home = tempHome();
  try {
    registerTask(home, "m1", { taskId: "task-1", workspacePath: "/tmp/ws" });
    updateTask(home, "m1", { eventsSeq: 9 });
    appendSteerCommandId(home, "m1", "cmd-1");
    const shard = JSON.parse(readFileSync(shardPath(home, "m1"), "utf8"));
    assert.equal(shard.eventsSeq, 9, "追加 steer 键不得冲掉 wait 写的 eventsSeq（否则下次 wait 事件重放）");
    assert.deepEqual(shard.steerCommandIds, ["cmd-1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("并发合并写：appendSteerCommandId 后 updateTask(lastStatus)，steerCommandIds 保留", () => {
  const home = tempHome();
  try {
    registerTask(home, "m2", { taskId: "task-2", workspacePath: "/tmp/ws" });
    appendSteerCommandId(home, "m2", "cmd-1");
    updateTask(home, "m2", { lastStatus: "running" });
    const shard = JSON.parse(readFileSync(shardPath(home, "m2"), "utf8"));
    assert.deepEqual(shard.steerCommandIds, ["cmd-1"], "updateTask 不得冲掉 send 写的 steerCommandIds（否则对账误判）");
    assert.equal(shard.lastStatus, "running");
    assert.equal(shard.eventsSeq, 0, "未给 eventsSeq 的 patch 不动游标");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("坏分片：updateTask 备份后按不存在；只读路径不备份；registerTask 可重新登记", () => {
  const home = tempHome();
  try {
    const dir = join(home, "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(shardPath(home, "bad"), "{broken", "utf8");

    assert.deepEqual(loadTasks(home), { tasks: {} });
    assert.equal(getTask(home, "bad"), null);
    // 只读路径（loadTasks/getTask）不产生备份
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("bad.json.corrupt-")), []);

    assert.equal(updateTask(home, "bad", { lastStatus: "running" }), null);
    const backups = readdirSync(dir).filter((f) => f.startsWith("bad.json.corrupt-"));
    assert.equal(backups.length, 1, `应出现恰一份备份：${readdirSync(dir)}`);
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), "{broken", "备份应保住原内容");

    // 坏文件按不存在：同名可重新登记
    registerTask(home, "bad", { taskId: "task-new", workspacePath: "/tmp/ws" });
    assert.equal(getTask(home, "bad").taskId, "task-new");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("分片不存在：读路径全为空表现且不建 tasks 目录", () => {
  const home = tempHome();
  try {
    assert.deepEqual(loadTasks(home), { tasks: {} });
    assert.deepEqual(listTaskNames(home), []);
    assert.equal(getTask(home, "t1"), null);
    assert.equal(updateTask(home, "t1", { lastStatus: "running" }), null);
    assert.equal(existsSync(join(home, "tasks")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("v1 残留模块已删除", () => {
  assert.equal(existsSync(srcPath("ingress.js")), false);
  assert.equal(existsSync(srcPath("daemon.js")), false);
  assert.equal(existsSync(srcPath("ensure.js")), false);
});
