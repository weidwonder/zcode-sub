import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getHome, assertValidName } from "./home.js";
import { loadConfig, createInitialConfig, saveConfig, updateConfig } from "./config.js";
import { postIngress, queryStatus } from "./ingress.js";
import { appendMailbox, readMailbox, readCursor, writeCursor } from "./mailbox.js";
import { loadTasks, upsertTask, getTask } from "./tasks.js";
import { ensureDaemon } from "./ensure.js";

// CLI 分发。退出码表见 spec §3：2 unreachable / 3 busy / 4 send_rejected /
// 5 secret / 6 not_bound / 7 name_invalid / 其余 1。

const USAGE = `zcode-sub 用法（把 ZCode 桌面版当子代理）：

  zcode-sub setup [--bot-id <id>] [--bind-code <CODE>] [--ingress-port <端口>] [--daemon-port <端口>] [--write-switch]
      检查 ZCode 入站端点、生成/读取桥接配置、打印 GUI 一次性配置步骤；
      --bind-code 在 30 秒有效期内完成绑定（GUI 生成码后立刻执行）。
  zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>]
      派发任务：状态查询 → /new → 投递正文；stdout 一行 JSON。
  zcode-sub send <name> "<消息>"
      任务运行中作为补充消息投递（被 ZCode 拒收会如实转达）；任务已结束则等价续聊。
  zcode-sub wait <name> [--timeout 秒]
      阻塞等新消息并打印（适合后台运行，退出即唤醒）；超时输出 TIMEOUT（退出码 2）。
  zcode-sub result <name>
      最终回复全文 + 状态；还在跑会明确说。
  zcode-sub resume <name> "<继续文本>"
      在原 ZCode 会话里续聊。
  zcode-sub stop <name>
      取消任务（ZCode /stop）。
  zcode-sub list [--json]
  zcode-sub mcp
      stdio MCP server（reply_to_parent 工具，配进 ZCode 的 mcp.servers）。
  zcode-sub daemon
      常驻出站接收进程（其它命令需要时自动拉起，一般不用手动跑）。`;

export async function runCli(argv) {
  const [command, ...rest] = argv;
  const home = getHome();
  switch (command) {
    case "setup":
      return cmdSetup(home, parseFlags(rest));
    case "run":
      return cmdRun(home, parseFlags(rest));
    case "list":
      return cmdList(home, parseFlags(rest));
    case "send":
      return cmdSend(home, parseFlags(rest));
    case "wait":
      return cmdWait(home, parseFlags(rest));
    case "result":
      return cmdResult(home, parseFlags(rest));
    case "resume":
      return cmdResume(home, parseFlags(rest));
    case "stop":
      return cmdStop(home, parseFlags(rest));
    case "daemon":
      return cmdDaemon(home);
    case "mcp":
      return cmdMcp();
    default:
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = command && command !== "help" && command !== "--help" ? 1 : 0;
      return;
  }
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function requireConfig(home) {
  const config = loadConfig(home);
  if (!config || !config.botId || !config.secret) {
    const err = new Error(
      "zcode_not_configured: 桥接配置不完整。先运行 zcode-sub setup（见其打印的一次性配置步骤）。",
    );
    err.code = "zcode_not_configured";
    err.exitCode = 1;
    throw err;
  }
  return config;
}

// ---------- setup ----------

async function cmdSetup(home, flags) {
  let config = loadConfig(home) ?? createInitialConfig();
  const changes = {};
  if (typeof flags["bot-id"] === "string") changes.botId = flags["bot-id"].trim();
  if (typeof flags["ingress-port"] === "string") {
    const port = Number.parseInt(flags["ingress-port"], 10);
    if (Number.isInteger(port) && port > 0) changes.ingressPort = port;
  }
  if (typeof flags["daemon-port"] === "string") {
    const port = Number.parseInt(flags["daemon-port"], 10);
    if (Number.isInteger(port) && port > 0) changes.daemonPort = port;
  }
  if (typeof flags.secret === "string" && flags.secret.trim()) {
    changes.secret = flags.secret.trim();
  }
  config = Object.keys(changes).length ? updateConfig(home, changes) : config;

  if (flags["bind-code"] !== undefined) {
    const code = String(flags["bind-code"]).trim();
    if (!code || code === "true") {
      const err = new Error("用法：zcode-sub setup --bind-code <CODE>（GUI 生成的绑定码）");
      err.exitCode = 1;
      throw err;
    }
    return setupBindCode(home, config, code);
  }

  // 开关文件：只读探测；不可写/不存在时打印用户命令（不绕过权限边界）。
  const switchFile = readIngressSwitchFile();
  if (switchFile?.port) {
    config = updateConfig(home, { ingressPort: switchFile.port });
  }
  if (flags["write-switch"] && !switchFile) {
    config = tryWriteSwitchFile(home, config);
  }

  const lines = [];
  lines.push(`zcode-sub 配置目录：${home}`);
  if (!isWritableHome(home)) {
    lines.push(`⚠ 该目录当前不可写。请先在本机执行：dwc grant ${home}`);
  }
  lines.push("");
  lines.push(`[1/4] ZCode 入站端点（127.0.0.1:${config.ingressPort}）`);
  const health = await probeHealth(config.ingressPort);
  lines.push(health.ok ? `  ✓ 正常，zcodeVersion=${health.zcodeVersion}` : `  ✗ 连不上：${health.message}`);
  if (!health.ok) {
    lines.push("    排查：ZCode 是否装了 webhook 入站补丁；开关文件是否 enabled；端口是否一致。");
    lines.push(`    手动创建开关文件 ${switchFilePath()} 内容：{"enabled": true, "port": ${config.ingressPort}}（改后需重启 ZCode）`);
  }
  // daemon 起来后 GUI 里填的 webhookUrl 立即可测通
  const daemon = await ensureDaemon(home).catch((error) => ({ error }));
  const daemonPort = loadConfig(home)?.daemonPort ?? config.daemonPort;
  lines.push(
    daemon?.error
      ? `  ✗ 桥接 daemon 未就绪：${daemon.error.message}`
      : `  ✓ 桥接 daemon 已监听 127.0.0.1:${daemonPort}`,
  );
  lines.push("");
  lines.push("[2/4] ZCode GUI 里新建 Webhook bot（设置 → Bots → 新建，选 Webhook）：");
  lines.push(`  - webhookUrl: http://127.0.0.1:${daemonPort}/zcode/outbound`);
  lines.push(`  - secret: ${config.secret.slice(0, 4)}****（完整值在 ${join(home, "config.json")}）`);
  lines.push("  - 允许 workspace：留空 = 全部允许");
  lines.push(`  建好后把 bot id 填回来：zcode-sub setup --bot-id <botId>`);
  lines.push("");
  lines.push("[3/4] 绑定（30 秒时效）：在 GUI 该 bot 页点「生成绑定码」，立刻执行：");
  lines.push("  zcode-sub setup --bind-code <CODE>");
  lines.push("");
  lines.push("[4/4] 把 MCP 工具配进 ZCode（mcp.servers，需 features.mcp 开启）：");
  lines.push("```json");
  lines.push(JSON.stringify(mcpConfigSnippet(config), null, 2));
  lines.push("```");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function setupBindCode(home, config, code) {
  const result = await postIngress(config, `/bind ${code}`);
  const text = result.replies.join("\n");
  if (text.includes("绑定成功") || text.includes("Bound successfully")) {
    process.stdout.write(`✓ 绑定成功。userId=${config.userId}\n接下来可用：zcode-sub run "<任务>" --cwd <绝对路径>\n`);
    return;
  }
  if (text.includes("未绑定") || text.includes("not bound")) {
    const err = new Error(`zcode_not_bound: ${text}`);
    err.code = "zcode_not_bound";
    err.exitCode = 6;
    throw err;
  }
  if (text.includes("绑定码无效") || text.includes("invalid or expired")) {
    const err = new Error(
      `zcode_bind_code_invalid: 绑定码无效或已过期（30 秒时效）。请在 GUI 重新生成后立刻重试。回执：${text}`,
    );
    err.code = "zcode_bind_code_invalid";
    err.exitCode = 6;
    throw err;
  }
  process.stdout.write(`${text || "（无回执）"}\n`);
}

function mcpConfigSnippet(config) {
  const port = config.daemonPort;
  return {
    features: { mcp: true },
    mcp: {
      servers: {
        "zcode-sub": {
          type: "stdio",
          command: process.execPath,
          args: [join(packageBinDir(), "zcode-sub.js"), "mcp"],
          env: {
            ZCODE_SUB_DAEMON_URL: `http://127.0.0.1:${port}`,
            ZCODE_SUB_SECRET: config.secret,
          },
          enabled: true,
        },
      },
    },
  };
}

function packageBinDir() {
  // setup 打印的片段写当前包 bin 的绝对路径（安装方式见 README）
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
}

function isWritableHome(home) {
  const probe = join(home, ".write-probe");
  try {
    writeFileSync(probe, "1");
    existsSync(probe);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // 探针不存在即无事
    }
  }
}

function switchFilePath() {
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || userInfo().homedir;
  return join(base, ".zcode", "v2", "bot-webhook-ingress.json");
}

function readIngressSwitchFile() {
  try {
    const parsed = JSON.parse(readFileSync(switchFilePath(), "utf8"));
    if (parsed && parsed.enabled === true && Number.isInteger(parsed.port)) {
      return { port: parsed.port };
    }
    return null;
  } catch {
    return null;
  }
}

function tryWriteSwitchFile(home, config) {
  const file = switchFilePath();
  try {
    writeFileSync(file, `${JSON.stringify({ enabled: true, port: config.ingressPort }, null, 2)}\n`);
    process.stdout.write(`✓ 已写入开关文件 ${file}（需重启 ZCode 生效）\n`);
    return config;
  } catch {
    process.stdout.write(
      `✗ 开关文件不可写（${file}）。请手动创建，内容：{"enabled": true, "port": ${config.ingressPort}}，然后重启 ZCode。\n`,
    );
    return config;
  }
}

async function probeHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    const payload = await response.json();
    if (payload?.ok === true && payload?.ingress === "zcode-bot-webhook") {
      return { ok: true, zcodeVersion: payload.zcodeVersion ?? "?" };
    }
    return { ok: false, message: `端点响应异常（${response.status}）` };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

// ---------- run ----------

async function cmdRun(home, flags) {
  const config = requireConfig(home);
  const taskText = flags._[0];
  const cwd = typeof flags.cwd === "string" ? flags.cwd : undefined;
  if (!taskText || !cwd || !cwd.startsWith("/")) {
    const err = new Error('用法：zcode-sub run "<任务>" --cwd <工作区绝对路径> [--name <名>]');
    err.exitCode = 1;
    throw err;
  }
  const name = typeof flags.name === "string" ? flags.name : autoName();
  assertValidName(name);

  await ensureDaemon(home);

  const status = await queryStatus(config);
  if (status.state === "running") {
    const err = new Error(
      `zcode_task_busy: bot 会话当前任务正在运行（${describeStatus(status)}）。可 zcode-sub wait 等结果或 zcode-sub stop 停止后再派发。`,
    );
    err.code = "zcode_task_busy";
    err.exitCode = 3;
    throw err;
  }
  if (status.state === "unknown") {
    const err = new Error(
      `zcode_status_unknown: /status 无法解析状态，原文：\n${status.raw}`,
    );
    err.code = "zcode_status_unknown";
    err.exitCode = 1;
    throw err;
  }

  await postIngress(config, "/new");
  const wrapped = [
    `【zcode-sub 委托】你的任务名：${name}。工作目录：${cwd}。`,
    "完成后请输出最终总结。若要主动向派发你的父代理发消息，用 MCP 工具 reply_to_parent(task=\"" + name + "\", message=\"<内容>\")。",
    "----- 任务 -----",
    taskText,
  ].join("\n");
  await postIngress(config, wrapped);

  upsertTask(home, name, { cwd, isCurrent: true, lastStatus: "dispatched" });
  appendMailbox(home, name, {
    kind: "dispatch",
    text: `任务已派发（${new Date().toISOString()}）`,
  });

  const paths = { mailbox: join(home, "mailboxes", `${name}.jsonl`) };
  process.stdout.write(`${JSON.stringify({ name, status: "dispatched", cwd, mailbox: paths.mailbox })}\n`);
}

function autoName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `zsub-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function describeStatus(status) {
  const line = status.raw
    .split("\n")
    .find((lineText) => lineText.includes("状态:") || lineText.includes("State:"));
  return line?.trim() ?? status.state;
}

// ---------- list ----------

function cmdList(home, flags) {
  const store = loadTasks(home);
  const entries = Object.entries(store.tasks);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ tasks: entries.map(([name, task]) => ({ name, ...task })) }, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("（还没有任务；用 zcode-sub run 派发）\n");
    return;
  }
  const rows = [["name", "status", "current", "cwd", "lastActivity"].join("\t")];
  for (const [name, task] of entries) {
    rows.push(
      [name, task.lastStatus ?? "?", task.isCurrent ? "*" : "", task.cwd ?? "", new Date(task.lastActivityAt ?? 0).toISOString()].join("\t"),
    );
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}

// ---------- send / wait / result / resume / stop ----------

// 任务运行中上游会拒绝普通正文（私聊无 steer/queue），拒收文案如实转达。
const TASK_RUNNING_PATTERN = /当前任务正在运行|still running/iu;

function requireTask(home, name) {
  assertValidName(name);
  const task = getTask(home, name);
  if (!task) {
    const err = new Error(`zcode_task_not_found: 没有任务 "${name}"。zcode-sub list 查看。`);
    err.code = "zcode_task_not_found";
    err.exitCode = 1;
    throw err;
  }
  return task;
}

async function deliverText(home, config, name, text) {
  const result = await postIngress(config, text);
  const joined = result.replies.join("\n");
  if (TASK_RUNNING_PATTERN.test(joined)) {
    const err = new Error(
      `zcode_send_rejected: ZCode 拒收了这条消息（任务运行中，私聊无补充输入通道）。ZCode 原话：\n${joined}`,
    );
    err.code = "zcode_send_rejected";
    err.exitCode = 4;
    throw err;
  }
  appendMailbox(home, name, {
    kind: "dispatch",
    text: `已投递补充输入：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
  });
  upsertTask(home, name, { lastActivityAt: Date.now() });
  return result;
}

async function cmdSend(home, flags) {
  const config = requireConfig(home);
  const name = flags._[0];
  const message = flags._[1];
  if (!name || message === undefined) {
    const err = new Error('用法：zcode-sub send <name> "<消息>"');
    err.exitCode = 1;
    throw err;
  }
  requireTask(home, name);
  await ensureDaemon(home);
  await deliverText(home, config, name, message);
  process.stdout.write("✓ 已投递（任务已结束则在原会话续聊）\n");
}

async function cmdResume(home, flags) {
  const config = requireConfig(home);
  const name = flags._[0];
  const message = flags._[1];
  if (!name || message === undefined) {
    const err = new Error('用法：zcode-sub resume <name> "<继续文本>"');
    err.exitCode = 1;
    throw err;
  }
  const task = requireTask(home, name);
  if (!task.isCurrent) {
    const err = new Error(
      `zcode_not_current: "${name}" 不再是 bot 会话当前任务（后续 run 已重置会话），无法在原会话续聊。`,
    );
    err.code = "zcode_not_current";
    err.exitCode = 1;
    throw err;
  }
  await ensureDaemon(home);
  await deliverText(home, config, name, message);
  process.stdout.write("✓ 已在原会话续聊\n");
}

async function cmdStop(home, flags) {
  const config = requireConfig(home);
  const name = flags._[0];
  if (!name) {
    const err = new Error("用法：zcode-sub stop <name>");
    err.exitCode = 1;
    throw err;
  }
  requireTask(home, name);
  await ensureDaemon(home);
  const result = await postIngress(config, "/stop");
  const text = result.replies.join("\n");
  appendMailbox(home, name, { kind: "status", text });
  upsertTask(home, name, { lastStatus: "stopped", lastActivityAt: Date.now() });
  process.stdout.write(`${text || "（无回执）"}\n`);
}

async function cmdWait(home, flags) {
  const name = flags._[0];
  if (!name) {
    const err = new Error("用法：zcode-sub wait <name> [--timeout 秒]");
    err.exitCode = 1;
    throw err;
  }
  requireTask(home, name);
  const timeoutMs = (Number.parseInt(String(flags.timeout ?? "600"), 10) || 600) * 1000;
  const cursor = readCursor(home, name);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const fresh = readMailbox(home, name).filter((entry) => entry.seq > cursor);
    if (fresh.length > 0) {
      writeCursor(home, name, Math.max(...fresh.map((entry) => entry.seq)));
      for (const entry of fresh) {
        process.stdout.write(`[${entry.kind}] ${entry.text}\n`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  process.stdout.write("TIMEOUT\n");
  process.exitCode = 2;
}

async function cmdResult(home, flags) {
  const config = requireConfig(home);
  const name = flags._[0];
  if (!name) {
    const err = new Error("用法：zcode-sub result <name>");
    err.exitCode = 1;
    throw err;
  }
  requireTask(home, name);
  await ensureDaemon(home);

  const status = await queryStatus(config);
  appendMailbox(home, name, { kind: "status", text: status.raw });
  upsertTask(home, name, { lastStatus: status.state, lastActivityAt: Date.now() });

  if (status.state === "running" || status.state === "unknown") {
    const recent = readMailbox(home, name).slice(-3);
    process.stdout.write(
      status.state === "running"
        ? `还在跑（最近活动：\n${recent.map((entry) => `[${entry.kind}] ${entry.text.slice(0, 120)}`).join("\n")}\n）\n`
        : `无法判定状态。/status 原文：\n${status.raw}\n`,
    );
    return;
  }

  // 最终回复 = 最近一次 dispatch 之后的 outbound/reply 正文
  const entries = readMailbox(home, name);
  let lastDispatchIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].kind === "dispatch") {
      lastDispatchIndex = index;
      break;
    }
  }
  const finalEntries = entries
    .slice(lastDispatchIndex + 1)
    .filter((entry) => entry.kind === "outbound" || entry.kind === "reply");
  const stateLine = status.raw.split("\n").find((line) => line.includes("状态:") || line.includes("State:"));

  process.stdout.write(`状态：${stateLine?.trim() ?? status.state}\n`);
  if (finalEntries.length === 0) {
    process.stdout.write("（终态但没有捕获到回复正文——用 zcode-sub wait <name> 看历史消息，或直接在 ZCode GUI 查看）\n");
    return;
  }
  process.stdout.write("----- 最终回复 -----\n");
  for (const entry of finalEntries) {
    process.stdout.write(`${entry.text}\n`);
    if (entry.kind === "reply") process.stdout.write("\n");
  }
}

// ---------- mcp ----------

async function cmdMcp() {
  const { runMcpServer } = await import("./mcp.js");
  await runMcpServer({});
}

// ---------- daemon ----------

async function cmdDaemon(home) {
  const { startDaemon } = await import("./daemon.js");
  const config = loadConfig(home) ?? createInitialConfig();
  const { server, port } = await startDaemon(home, config);
  writeFileSync(
    join(home, "daemon.json"),
    `${JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }, null, 2)}\n`,
  );
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // 常驻：不 resolve
  await new Promise(() => {});
}
