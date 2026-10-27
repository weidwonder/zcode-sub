import { existsSync, readFileSync } from "node:fs";
import { ensureHome } from "./home.js";
import { atomicWriteJson } from "./config.js";

// 任务登记表：name → { taskId, workspacePath, createdAt, lastStatus, eventsSeq }。
// taskId 指向 ZCode 本机任务 API 的任务；eventsSeq 只反映本机已见的事件数。

export function loadTasks(home) {
  const paths = ensureHome(home);
  if (!existsSync(paths.tasksFile)) return { tasks: {} };
  try {
    const parsed = JSON.parse(readFileSync(paths.tasksFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof parsed.tasks === "object" && parsed.tasks !== null) {
      return { tasks: parsed.tasks };
    }
  } catch {
    // 损坏按空表起步，避免一条坏记录挡住所有命令
  }
  return { tasks: {} };
}

export function saveTasks(home, store) {
  const paths = ensureHome(home);
  atomicWriteJson(paths.tasksFile, store);
  return store;
}

export function registerTask(home, name, { taskId, workspacePath }) {
  const store = loadTasks(home);
  if (store.tasks[name]) {
    const err = new Error(`zcode_name_taken: 任务名 "${name}" 已存在，换一个名字`);
    err.code = "zcode_name_taken";
    err.exitCode = 7;
    throw err;
  }
  store.tasks[name] = {
    taskId,
    workspacePath,
    createdAt: Date.now(),
    lastStatus: "dispatched",
    eventsSeq: 0,
  };
  saveTasks(home, store);
  return store.tasks[name];
}

export function updateTask(home, name, patch) {
  const store = loadTasks(home);
  const task = store.tasks[name];
  if (!task) return null;
  if (patch.lastStatus !== undefined) task.lastStatus = patch.lastStatus;
  if (patch.eventsSeq !== undefined) task.eventsSeq = patch.eventsSeq;
  saveTasks(home, store);
  return task;
}

export function getTask(home, name) {
  return loadTasks(home).tasks[name] ?? null;
}

export function listTaskNames(home) {
  return Object.entries(loadTasks(home).tasks)
    .sort(([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map(([name]) => name);
}
