import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHome, assertValidName } from "./home.js";
import { loadConfig, createInitialConfig, updateConfig } from "./config.js";
import * as api from "./api.js";
import * as tasks from "./tasks.js";
import { readMailboxLines, readCursor, writeCursor } from "./mailbox.js";

// CLI 分发。退出码表：1 用法/未配置/本地无此任务 / 2 API 不可达、wait 超时 /
// 3 工作区未打开 / 4 发送失败、任务已删（API 侧）、resume 时任务忙 / 5 鉴权失败 /
// 7 任务名非法或重名。

const USAGE = `zcode-sub 用法（把 ZCode 桌面版当子代理）：

  zcode-sub setup [--api-port <端口>]
      检查 ZCode 本机任务 API、生成/读取开关文件与 token、打印 MCP 配置步骤。
  zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>]
      在 ZCode 该工作区新建对话执行任务（多任务可并行）；stdout 一行 JSON。
  zcode-sub send <name> "<消息>" [--steer|--queue]
      补充消息：默认 auto（运行中=GUI 排队/引导语义）；--steer 强制引导、--queue 强制排队；
      任务空闲时即接续对话（sent）。
  zcode-sub wait <name> [--timeout 秒]
      阻塞等新事件或子代理主动消息（适合后台运行，退出即唤醒）；超时输出 TIMEOUT（退出码 2）。
  zcode-sub result <name>
      最终回复全文 + 状态；还在跑会明确说。
  zcode-sub resume <name> "<继续文本>"
      在原 ZCode 对话续聊（要求任务空闲；运行中补充用 send）。
  zcode-sub stop <name>
      停止任务生成。
  zcode-sub list [--json]
  zcode-sub mcp
      stdio MCP server（reply_to_parent 工具，配进 ZCode 的 mcp.servers）。`;

export async function runCli(argv) {
  const [command, ...rest] = argv;
  const home = getHome();
  switch (command) {
    case "setup":
      return cmdSetup(home, parseFlags(rest));
    case "run":
      return cmdRun(home, parseFlags(rest));
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
    case "list":
      return cmdList(home, parseFlags(rest));
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

function usageError(text) {
  const err = new Error(text);
  err.exitCode = 1;
  return err;
}

function requireConfig(home) {
  const config = loadConfig(home);
  if (!config || !config.token) {
    const err = new Error("zcode_not_configured: 先运行 zcode-sub setup 完成配置。");
    err.code = "zcode_not_configured";
    err.exitCode = 1;
    throw err;
  }
  return config;
}

function requireTask(home, name) {
  assertValidName(name);
  const task = tasks.getTask(home, name);
  if (!task) {
    const err = new Error(`zcode_task_not_found: 没有任务 "${name}"。zcode-sub list 查看。`);
    err.code = "zcode_task_not_found";
    err.exitCode = 1;
    throw err;
  }
  return task;
}

// ---------- setup ----------

async function cmdSetup(home, flags) {
  const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || userInfo().homedir;
  const switchFile = join(dataBaseDir, ".zcode", "v2", "local-task-api.json");
  let config = loadConfig(home) ?? createInitialConfig();

  if (typeof flags["api-port"] === "string") {
    const port = Number.parseInt(flags["api-port"], 10);
    if (Number.isInteger(port) && port > 0) {
      config = updateConfig(home, { apiPort: port });
    }
  }

  const existing = readSwitchFile(switchFile);
  if (existing) {
    // 开关文件是 ZCode 侧的事实源：token/port 以它为准，不重写。
    config = updateConfig(home, { apiPort: existing.port, token: existing.token });
    process.stdout.write(`✓ 开关文件已存在并启用：${switchFile}（token 复用，port=${existing.port}）\n`);
  } else {
    const token = config.token || randomBytes(32).toString("hex");
    try {
      writeSwitchFile(switchFile, { enabled: true, port: config.apiPort, token });
      config = updateConfig(home, { token });
      process.stdout.write(`✓ 已写入开关文件 ${switchFile}（需重启 ZCode 生效）\n`);
    } catch {
      config = updateConfig(home, { token });
      process.stdout.write(
        `✗ 开关文件不可写（${switchFile}）。请手动创建，内容：{"enabled": true, "port": ${config.apiPort}, "token": "${token.slice(0, 4)}****"}，然后重启 ZCode。\n`,
      );
      process.stdout.write(`  完整 token 已存入 ${join(home, "config.json")}，可打开查看。\n`);
    }
  }

  const health = await api.probeHealth(config);
  if (health.ok) {
    process.stdout.write(`✓ 本机任务 API 正常 zcodeVersion=${health.zcodeVersion}\n`);
  } else {
    process.stdout.write(`✗ ${health.message}\n`);
    process.stdout.write(
      "  排查：ZCode 是否装了本机任务 API 补丁、写入开关文件后是否重启过 ZCode、开关文件是否 enabled、端口是否一致。\n",
    );
  }

  if (isWritableHome(home)) {
    process.stdout.write(`状态目录可写：${home}\n`);
  } else {
    process.stdout.write(`⚠ 请先执行 dwc grant ${home}\n`);
  }

  process.stdout.write(
    "把下面片段合入 ZCode 的 MCP 配置（settings 里的 mcp.servers），ZCode 里即可用 reply_to_parent 工具：\n",
  );
  process.stdout.write("```json\n");
  process.stdout.write(`${JSON.stringify(mcpConfigSnippet(home), null, 2)}\n`);
  process.stdout.write("```\n");
}

function readSwitchFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      parsed &&
      parsed.enabled === true &&
      typeof parsed.token === "string" &&
      parsed.token &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0
    ) {
      return { port: parsed.port, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

// 0600 原子写：token 不扩大可读面。
function writeSwitchFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basenameOf(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // 平台不支持时保留 writeFileSync 的 mode
  }
  renameSync(tmp, file);
}

function basenameOf(file) {
  return file.split(/[\\/]/u).at(-1) ?? file;
}

function mcpConfigSnippet(home) {
  return {
    features: { mcp: true },
    mcp: {
      servers: {
        "zcode-sub": {
          type: "stdio",
          command: process.execPath,
          args: [join(packageBinDir(), "zcode-sub.js"), "mcp"],
          env: { ZCODE_SUB_HOME: resolve(home) },
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

// ---------- run ----------

async function cmdRun(home, flags) {
  const taskText = flags._[0];
  const cwd = flags.cwd;
  if (!taskText || typeof cwd !== "string" || !cwd.startsWith("/")) {
    throw usageError('用法：zcode-sub run "<任务>" --cwd <工作区绝对路径> [--name <名>]');
  }
  const name = typeof flags.name === "string" && flags.name ? flags.name : autoName();
  assertValidName(name);
  const config = requireConfig(home);

  // 先建 ZCode 对话，再登记本地；名字冲突时 ZCode 侧已存在，要如实告知。
  const { taskId } = await api.createTask(config, {
    workspacePath: cwd,
    prompt: wrappedPrompt(name, cwd, taskText),
    title: name,
  });
  try {
    tasks.registerTask(home, name, { taskId, workspacePath: cwd });
  } catch (error) {
    if (error?.code === "zcode_name_taken") {
      process.stderr.write(
        `⚠ 任务已在 ZCode 创建（taskId=${taskId}）但本地名字冲突，换名重跑；或手动记下 taskId。\n`,
      );
    }
    throw error;
  }

  process.stdout.write(`${JSON.stringify({ name, taskId, status: "dispatched", workspacePath: cwd })}\n`);
}

function wrappedPrompt(name, cwd, taskText) {
  return [
    `【zcode-sub 委托】你的任务名：${name}。工作目录：${cwd}。`,
    '完成后请输出最终总结。若要主动向派发你的父代理发消息，用 MCP 工具 reply_to_parent(task="' + name + '", message="<内容>")。',
    "----- 任务 -----",
    taskText,
  ].join("\n");
}

function autoName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `zsub-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// ---------- send / resume / stop ----------

async function cmdSend(home, flags) {
  const name = flags._[0];
  const message = flags._[1];
  if (!name || message === undefined) {
    throw usageError('用法：zcode-sub send <name> "<消息>" [--steer|--queue]');
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  const delivery = flags.steer ? "steer" : flags.queue ? "queue" : "auto";
  const result = await api.sendMessage(config, task.taskId, message, delivery);
  const commandId = result?.commandId ? `（commandId=${result.commandId}）` : "";
  process.stdout.write(`✓ 投递结果：${result?.delivery ?? "?"}${commandId}\n`);
}

async function cmdResume(home, flags) {
  const name = flags._[0];
  const message = flags._[1];
  if (!name || message === undefined) {
    throw usageError('用法：zcode-sub resume <name> "<继续文本>"');
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  const payload = await api.getTask(config, task.taskId);
  const status = payload.status;
  if (status === "running" || status === "waiting_permission" || status === "waiting_input") {
    const err = new Error(
      `zcode_task_busy_for_resume: 任务正在运行/等待（status=${status}）。运行中补充消息用 zcode-sub send。`,
    );
    err.code = "zcode_task_busy_for_resume";
    err.exitCode = 4;
    throw err;
  }
  if (status !== "idle") {
    // error 等其他状态：原样接续，让用户在对话里处理
    process.stdout.write(`任务 status=${status}，按接续处理\n`);
  }
  await api.sendMessage(config, task.taskId, message, "auto");
  process.stdout.write("✓ 已接续对话（sent）\n");
}

async function cmdStop(home, flags) {
  const name = flags._[0];
  if (!name) {
    throw usageError("用法：zcode-sub stop <name>");
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  await api.stopTask(config, task.taskId);
  process.stdout.write("✓ 已请求停止\n");
}

// ---------- result ----------

async function cmdResult(home, flags) {
  const name = flags._[0];
  if (!name) {
    throw usageError("用法：zcode-sub result <name>");
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  const payload = await api.getTask(config, task.taskId);
  const status = payload.status;
  tasks.updateTask(home, name, { lastStatus: status });

  if (status === "running" || status === "waiting_permission" || status === "waiting_input") {
    process.stdout.write(`还在跑（status=${status}）\n`);
    if (status !== "running") {
      process.stdout.write("⏳ 请在 ZCode GUI 处理（权限/输入请求不经本工具）\n");
    }
    process.stdout.write(`可用 zcode-sub wait ${name} 收实时事件\n`);
    return;
  }
  if (status === "idle" || status === "error") {
    process.stdout.write(`状态：${status}\n`);
    process.stdout.write("----- 最后回复 -----\n");
    const text = typeof payload.lastAssistantText === "string" ? payload.lastAssistantText : "";
    process.stdout.write(`${text || "（无助手回复文本——用 wait 看事件或在 GUI 查看）"}\n`);
    return;
  }
  process.stdout.write(`状态未知（原文 ${status}），按非终态处理\n`);
}

// ---------- wait ----------

async function cmdWait(home, flags) {
  const name = flags._[0];
  if (!name) {
    throw usageError("用法：zcode-sub wait <name> [--timeout 秒]");
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  const timeoutSec = Number.parseInt(String(flags.timeout ?? "600"), 10) || 600;
  const deadline = Date.now() + timeoutSec * 1000;

  for (;;) {
    // 信箱优先：子代理主动消息不进事件流，也不必等长轮询
    const lines = readMailboxLines(home, name);
    const cursor = readCursor(home, name);
    if (lines.length > cursor) {
      for (const line of lines.slice(cursor)) {
        process.stdout.write(`[reply] ${line.text}\n`);
      }
      writeCursor(home, name, lines.length);
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      process.stdout.write("TIMEOUT\n");
      process.exitCode = 2;
      return;
    }

    const payload = await api.getEvents(config, task.taskId, task.eventsSeq, Math.min(30_000, remainingMs));
    if (payload?.error === "task_not_found") {
      const err = new Error(`zcode_task_not_found: 任务 ${task.taskId} 不存在（可能已在 GUI 删除）。`);
      err.code = "zcode_task_not_found";
      err.exitCode = 4;
      throw err;
    }
    if (payload?.resync) {
      const fresh = await api.getTask(config, task.taskId);
      process.stdout.write(`⚠ 事件缓冲溢出，改查任务状态：${fresh.status}；完整过程见 ZCode GUI\n`);
      tasks.updateTask(home, name, { lastStatus: fresh.status });
      return;
    }
    const events = Array.isArray(payload?.events) ? payload.events : [];
    if (events.length > 0) {
      const patch = { eventsSeq: payload.nextSeq };
      for (const event of events) {
        process.stdout.write(`[${event.type}] ${event.text ?? event.error ?? event.summary ?? ""}\n`);
        if (event.type === "permission.requested") {
          process.stdout.write("⏳ 请在 ZCode GUI 处理该权限请求\n");
        }
        if (event.type === "turn.completed") patch.lastStatus = "idle";
        if (event.type === "turn.failed") patch.lastStatus = "error";
      }
      tasks.updateTask(home, name, patch);
      return;
    }
    // 空页 → 回到信箱检查继续等
  }
}

// ---------- list / mcp ----------

function cmdList(home, flags) {
  const names = tasks.listTaskNames(home);
  if (flags.json) {
    const list = names.map((name) => ({ name, ...tasks.getTask(home, name) }));
    process.stdout.write(`${JSON.stringify({ tasks: list }, null, 2)}\n`);
    return;
  }
  if (names.length === 0) {
    process.stdout.write("（还没有任务；用 zcode-sub run 派发）\n");
    return;
  }
  const rows = [];
  for (const name of names) {
    const task = tasks.getTask(home, name);
    rows.push([name, String(task.taskId ?? "").slice(0, 8), task.lastStatus ?? "?", task.workspacePath ?? ""].join("\t"));
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}

async function cmdMcp() {
  const { runMcpServer } = await import("./mcp.js");
  await runMcpServer({});
}
