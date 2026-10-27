import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { pathsOf } from "./home.js";

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcode-sub.js");
const BOOT_TIMEOUT_MS = 5_000;

// 探活 → 不通则后台拉起 daemon（detached，环境只传 ZCODE_SUB_HOME）→ 等就绪。
// 端口固定在 config.daemonPort（GUI webhookUrl 依赖它，不能漂移）。
export async function ensureDaemon(home) {
  const config = loadConfig(home);
  if (!config || !config.daemonPort) {
    const err = new Error("zcode_not_configured: 桥接配置不完整，先运行 zcode-sub setup。");
    err.code = "zcode_not_configured";
    err.exitCode = 1;
    throw err;
  }
  const baseUrl = `http://127.0.0.1:${config.daemonPort}`;
  if (await probeDaemon(baseUrl)) return { baseUrl };

  const child = spawn(process.execPath, [BIN_PATH, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ZCODE_SUB_HOME: home },
  });
  child.unref();

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeDaemon(baseUrl)) return { baseUrl };
    await sleep(100);
  }
  const paths = pathsOf(home);
  const err = new Error(`zcode_daemon_failed: daemon 5 秒内未就绪。日志：${paths.daemonLog}`);
  err.code = "zcode_daemon_failed";
  err.exitCode = 1;
  throw err;
}

async function probeDaemon(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/internal/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.ok === true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
