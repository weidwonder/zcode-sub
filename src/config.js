import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureHome } from "./home.js";

// 桥接配置：setup 生成，daemon 与各命令共读。secret 与 GUI webhook bot 填的一致。
export function loadConfig(home) {
  const paths = ensureHome(home);
  if (!existsSync(paths.configFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.configFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      botId: typeof parsed.botId === "string" ? parsed.botId : "",
      secret: typeof parsed.secret === "string" ? parsed.secret : "",
      userId: typeof parsed.userId === "string" && parsed.userId ? parsed.userId : "zcode-sub",
      daemonPort: Number.isInteger(parsed.daemonPort) ? parsed.daemonPort : 0,
      ingressPort: Number.isInteger(parsed.ingressPort) ? parsed.ingressPort : 47821,
    };
  } catch {
    return null;
  }
}

export function createInitialConfig() {
  return {
    botId: "",
    secret: randomUUID().replace(/-/gu, ""),
    userId: "zcode-sub",
    daemonPort: 0,
    ingressPort: 47821,
  };
}

// 0600 原子写：信箱与配置里的任务文本不扩大可读面。
export function saveConfig(home, config) {
  const paths = ensureHome(home);
  atomicWriteJson(paths.configFile, config, { mode: 0o600 });
  return config;
}

export function updateConfig(home, mutate) {
  const current = loadConfig(home) ?? createInitialConfig();
  const next = { ...current, ...mutate };
  saveConfig(home, next);
  return next;
}

export function atomicWriteJson(file, value, { mode } = {}) {
  const tmp = join(dirname(file), `.${basenameOf(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: mode ?? 0o644 });
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      // 平台不支持时保留默认权限
    }
  }
  renameSync(tmp, file);
}

function basenameOf(file) {
  return file.split(/[\\/]/u).at(-1) ?? file;
}
