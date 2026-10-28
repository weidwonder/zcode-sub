import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidName, isValidName } from "./home.js";
import { atomicWriteJson } from "./config.js";

// 任务登记表：每任务一分片 <home>/tasks/<name>.json，
// 内容 { taskId, workspacePath, createdAt, lastStatus, eventsSeq, clientRequestId?, steerCommandIds? }。
// 分片替代旧单文件 tasks.json 的读改写——旧实现在多进程并发登记时会互相
// 覆盖丢登记，现在登记走独占创建（wx），同名竞态恰好只有一方成功。
// taskId 指向 ZCode 本机任务 API 的任务；eventsSeq 只反映本机已见的事件数；
// clientRequestId 是派发时的幂等键（有才存），供端点侧短期去重对账；
// steerCommandIds?（可选，本 CLI 的 steer 受理对账键列表）。

function tasksDirOf(home) {
  return join(home, "tasks");
}

function shardFileOf(home, name) {
  return join(tasksDirOf(home), `${name}.json`);
}

function ensureTasksDir(home) {
  const dir = tasksDirOf(home);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nameTakenError(name) {
  const err = new Error(`zcode_name_taken: 任务名 "${name}" 已存在，换一个名字`);
  err.code = "zcode_name_taken";
  err.exitCode = 7;
  return err;
}

// 读单个分片。missing → { missing: true }；不是合法 JSON 对象 → { corrupt: true }；
// 正常 → { record }。损坏不在读取时备份：备份是写副作用，只留给写路径
// （updateTask 备份后按不存在；registerTask 备份后覆盖重登记）。
function readShard(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { corrupt: true };
    }
    return { record: parsed };
  } catch {
    return { corrupt: true };
  }
}

// 同步睡：Atomics.wait 在 Node 主线程可用，阻塞等待但不占 CPU。用它而非
// setTimeout，registerTask 就能保持同步签名（cli.js/mcp.js 的调用方都不必加 await）。
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// EEXIST 分支专用重读：首读解析失败不一定是损坏——同名竞态里胜者刚以 wx
// 建完文件、内容还在写入时，败者读到的是半截（半截 ≠ 损坏，D-v2-16 的
// TOCTOU 窗口）。退避 50ms 重读一次、仍失败再 100ms 读第三次；任一次解析
// 成功即按正常占用处理；三次全失败才判真损坏。完好分片首读即成功、真损坏
// 分片只多付一次 ~150ms 的登记耗时，都只发生在 EEXIST 分支。
function readShardWithRetry(file) {
  let shard = readShard(file);
  for (const backoffMs of [50, 100]) {
    if (!shard.corrupt) return shard;
    syncSleep(backoffMs);
    shard = readShard(file);
  }
  return shard;
}

// 损坏分片挪到 <name>.json.corrupt-<时间戳>；挪不动（如权限）就留在原地，静默跳过。
function backupCorruptShard(file) {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // 备份失败不影响"按不存在处理"的结果
  }
}

export function loadTasks(home) {
  let entries;
  try {
    entries = readdirSync(tasksDirOf(home));
  } catch {
    // 目录不存在 → 空表
    return { tasks: {} };
  }
  const tasks = {};
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!isValidName(name)) continue;
    const shard = readShard(join(tasksDirOf(home), entry));
    if (shard.record !== undefined) tasks[name] = shard.record;
    // 损坏分片聚合时只跳过，不备份：loadTasks 是只读路径，不产生写副作用
  }
  return { tasks };
}

export function registerTask(home, name, { taskId, workspacePath, clientRequestId }) {
  assertValidName(name);
  const file = join(ensureTasksDir(home), `${name}.json`);
  const record = {
    taskId,
    workspacePath,
    createdAt: Date.now(),
    lastStatus: "dispatched",
    eventsSeq: 0,
    ...(clientRequestId ? { clientRequestId } : {}),
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  // 独占创建：两进程同时登记同名，只有抢先建文件的一方落盘
  try {
    writeFileSync(file, text, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // 同名分片是损坏文件（解析失败/非纯对象）时，登记会陷入"换名也没用"的死局：
    // 先备份坏分片，再覆盖重登记（评审 N3 方案①）。分片完好则照旧拒绝。
    // 解析失败先退避重读区分「胜者写入中的半截」与「真损坏」，见 readShardWithRetry。
    const shard = readShardWithRetry(file);
    if (!shard.corrupt) throw nameTakenError(name);
    backupCorruptShard(file);
    try {
      writeFileSync(file, text, { flag: "wx" });
    } catch (retryErr) {
      // 备份失败（如权限）坏文件仍在原地，按同名占用处理
      if (retryErr.code === "EEXIST") throw nameTakenError(name);
      throw retryErr;
    }
  }
  return record;
}

export function updateTask(home, name, patch) {
  assertValidName(name);
  const file = shardFileOf(home, name);
  const shard = readShard(file);
  if (shard.missing) return null;
  if (shard.corrupt) {
    // 先备份坏分片再按不存在处理；写路径允许副作用
    backupCorruptShard(file);
    return null;
  }
  // 写前重读合并：并发写方（wait 的 eventsSeq / send 的 steerCommandIds）互不覆盖——
  // 以刚重读到的最新分片为底应用增量（lastStatus 直接覆盖、eventsSeq 取 max），
  // 后写者不再把先写者刚落的字段冲掉；重读缺失/损坏时维持原读到的分片直接覆盖。
  const fresh = readShard(file);
  const record = fresh.record ?? shard.record;
  if (patch.lastStatus !== undefined) record.lastStatus = patch.lastStatus;
  if (patch.eventsSeq !== undefined) {
    record.eventsSeq = fresh.record ? Math.max(record.eventsSeq ?? 0, patch.eventsSeq) : patch.eventsSeq;
  }
  atomicWriteJson(file, record);
  return record;
}

// steer 对账键：本 CLI 每次 --steer 受理的 commandId 记入分片（wait 打印 input.steered 时
// 据此区分「你的引导」与 GUI 侧引导）。分片缺失/损坏时返回 null 不写（与 updateTask 不同：
// 这里不做备份副作用）。同一 commandId 幂等不重复追加。
export function appendSteerCommandId(home, name, commandId) {
  assertValidName(name);
  const file = shardFileOf(home, name);
  const shard = readShard(file);
  if (!shard.record) return null;
  // 写前重读合并：并发写方（wait 的 eventsSeq / send 的 steerCommandIds）互不覆盖——
  // 以刚重读到的最新分片为底追加（fresh 的 lastStatus/eventsSeq 原样保留），重读
  // 缺失/损坏时维持原读到的分片。
  const fresh = readShard(file);
  const record = fresh.record ?? shard.record;
  const ids = Array.isArray(record.steerCommandIds) ? record.steerCommandIds : [];
  if (ids.includes(commandId)) return record;
  record.steerCommandIds = [...ids, commandId];
  atomicWriteJson(file, record);
  return record;
}

export function getTask(home, name) {
  return loadTasks(home).tasks[name] ?? null;
}

export function listTaskNames(home) {
  return Object.entries(loadTasks(home).tasks)
    .sort(([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map(([name]) => name);
}
