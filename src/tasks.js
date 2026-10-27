import { existsSync, readFileSync } from "node:fs";
import { ensureHome } from "./home.js";
import { atomicWriteJson } from "./config.js";

// 任务登记表：name → 元数据。isCurrent 标记 bot 会话当前任务（单 bot 单会话，spec D-01）。

export function loadTasks(home) {
  const paths = ensureHome(home);
  if (!existsSync(paths.tasksFile)) return { tasks: {} };
  try {
    const parsed = JSON.parse(readFileSync(paths.tasksFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof parsed.tasks === "object") {
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

export function upsertTask(home, name, patch) {
  const store = loadTasks(home);
  const previous = store.tasks[name] ?? {};
  // 新任务成为 bot 会话当前任务，旧任务全部失格（/new 已重置会话）。
  if (patch.isCurrent) {
    for (const task of Object.values(store.tasks)) task.isCurrent = false;
  }
  store.tasks[name] = {
    cwd: patch.cwd ?? previous.cwd ?? "",
    startedAt: patch.startedAt ?? previous.startedAt ?? Date.now(),
    lastActivityAt: patch.lastActivityAt ?? Date.now(),
    lastStatus: patch.lastStatus ?? previous.lastStatus ?? "dispatched",
    isCurrent: patch.isCurrent ?? previous.isCurrent ?? false,
  };
  saveTasks(home, store);
  return store.tasks[name];
}

export function getCurrentTask(home) {
  const store = loadTasks(home);
  return Object.entries(store.tasks).find(([, task]) => task.isCurrent)?.[0] ?? null;
}

export function getTask(home, name) {
  return loadTasks(home).tasks[name] ?? null;
}
