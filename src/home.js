import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// 座位/服务环境的 HOME 常被重定向；用户真实家目录只认 userInfo().homedir（对齐 ZCode paths.ts 的取值口径）。
export function getHome() {
  const fromEnv = process.env.ZCODE_SUB_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(userInfo().homedir, ".zcode-sub");
}

export function pathsOf(home) {
  return {
    home,
    configFile: join(home, "config.json"),
    tasksFile: join(home, "tasks.json"),
    mailboxesDir: join(home, "mailboxes"),
  };
}

export function ensureHome(home) {
  const paths = pathsOf(home);
  if (!existsSync(paths.mailboxesDir)) {
    mkdirSync(paths.mailboxesDir, { recursive: true });
  }
  return paths;
}

// 任务名是信箱文件名与全系统键，只放行无路径语义的字符。
export function isValidName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export function assertValidName(name) {
  if (!isValidName(name)) {
    const err = new Error(`zcode_name_invalid: 任务名只能含字母数字 . _ -，收到 "${name}"`);
    err.code = "zcode_name_invalid";
    err.exitCode = 7;
    throw err;
  }
}
