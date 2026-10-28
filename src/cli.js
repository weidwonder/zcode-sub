import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHome, assertValidName } from "./home.js";
import { atomicWriteJson, loadConfig, createInitialConfig, updateConfig } from "./config.js";
import * as api from "./api.js";
import * as tasks from "./tasks.js";
import { mailboxPath, readMailboxLines, readCursor, writeCursor } from "./mailbox.js";

// CLI 分发。退出码表：1 用法/未配置/本地无此任务 / 2 API 不可达、wait 超时 /
// 3 工作区未打开 / 4 发送失败、任务已删（API 侧）、resume 时任务忙 / 5 鉴权失败 /
// 7 任务名非法或重名 / 8 并发派发超上限。

// wait 单次调用的批级输出总量上限（按已写字符估算）：事件批/reply 批各自累计，
// 超过上限且还有剩余条目时停止逐条打印、改打一行略过提示；游标照常推进不丢数据
// （全文用 result / ZCode GUI / 信箱文件查看）。防一大批事件/主动消息冲爆派发方的输出预算。
const WAIT_OUTPUT_LIMIT = 20_000;

const USAGE = `zcode-sub 用法（把 ZCode 桌面版当子代理）：

  zcode-sub setup [--api-port <端口>]
      检查 ZCode 本机任务 API、生成/读取开关文件与 token、打印 MCP 配置步骤。
  zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>] [--mode <模式>]
      在 ZCode 该工作区新建对话执行任务（多任务可并行）；stdout 一行 JSON。默认 yolo（完全访问）。
      --mode 枚举：default/yolo/guarded/plan/edit/acceptEdits/auto/dontAsk/bypassPermissions/autoEdit/build。
      --model <模型id> 尚未支持（模型选择接口在途，传入会明确报错）。
  zcode-sub send <name> "<消息>" [--steer|--queue]
      补充消息：默认 auto（运行中的去向由会话设置决定，GUI 默认排队；要即时打断用 --steer）；
      --steer 强制引导打断（应答仅为受理，注入结果以事件流为准）、--queue 强制排队；
      任务空闲时即接续对话（sent）。
  zcode-sub wait <name> [--timeout 秒]
      阻塞等新事件或子代理主动消息（适合后台运行，退出即唤醒本轮）；超时输出 TIMEOUT（退出码 2）。
      事件类型：turn.started/assistant.message/turn.completed/turn.failed/permission.requested/
      input.queued/input.steered/steer.injected/steer.fellBack；--timeout 默认 600 秒。
  zcode-sub result <name>
      最终回复全文 + 状态；还在跑会明确说。
  zcode-sub resume <name> "<继续文本>"
      在原 ZCode 对话续聊（要求任务空闲；运行中补充用 send）。
  zcode-sub stop <name>
      停止任务生成。
  zcode-sub list [--json]
  zcode-sub mcp
      stdio MCP server（reply_to_parent 工具，配进 ZCode 的 mcp.servers）。
  zcode-sub --version
      打印版本号。

  环境变量：
  ZCODE_SUB_HOME          状态目录（任务分片与信箱）；HOME 被重定向的环境必须显式设置
  ZCODE_DATA_BASE_DIR     ZCode 数据目录基目录（从中找开关文件 <该目录>/.zcode/v2/local-task-api.json）
  ZCODE_SUB_MAX_RUNNING   同时未结束任务数上限（默认 4，尽力检查）
  ZCODE_SUB_DEBUG=1       打请求/响应摘要日志（debug.log，不含 token 与任务正文）`;

// 版本唯一出处是 package.json（与 CHANGELOG / Skill metadata.version 同步）。
// 与 src/mcp.js 各持一份小实现：从这里静态 import 会把 MCP server 代码
// 拖进每条 CLI 命令的启动路径（mcp 走 cmdMcp 的动态 import 懒加载）。
function packageVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    );
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function runCli(argv) {
  const [command, ...rest] = argv;
  if (command === "--version") {
    process.stdout.write(`zcode-sub ${packageVersion()}\n`);
    return;
  }
  const home = getHome();
  switch (command) {
    case "setup":
      return cmdSetup(home, parseFlagsChecked("setup", rest));
    case "run":
      return cmdRun(home, parseFlagsChecked("run", rest));
    case "send":
      return cmdSend(home, parseFlagsChecked("send", rest));
    case "wait":
      return cmdWait(home, parseFlagsChecked("wait", rest));
    case "result":
      return cmdResult(home, parseFlagsChecked("result", rest));
    case "resume":
      return cmdResume(home, parseFlagsChecked("resume", rest));
    case "stop":
      return cmdStop(home, parseFlagsChecked("stop", rest));
    case "list":
      return cmdList(home, parseFlagsChecked("list", rest));
    case "mcp":
      checkFlags("mcp", parseFlags(rest)); // mcp 不收任何 flag（白名单为空）：仅校验
      return cmdMcp();
    default:
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = command && command !== "help" && command !== "--help" ? 1 : 0;
      return;
  }
}

// 各命令允许的 flags（--model 为模型选择接口预留：进入 cmdRun 后专门报「尚未支持」）
const COMMAND_FLAGS = {
  setup: new Set(["api-port"]),
  run: new Set(["cwd", "name", "mode", "model"]),
  send: new Set(["steer", "queue"]),
  wait: new Set(["timeout"]),
  result: new Set(),
  resume: new Set(),
  stop: new Set(),
  list: new Set(["json"]),
  mcp: new Set(),
};

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

// 白名单外的 flag 一律用法错误：Skill 预留的参数（如 --model）不能被旧 CLI 静默吞掉
function checkFlags(command, flags) {
  const allowed = COMMAND_FLAGS[command];
  for (const key of Object.keys(flags)) {
    if (key === "_" || allowed.has(key)) continue;
    throw usageError(`不认识的参数 --${key}（zcode-sub ${command} 的用法见 zcode-sub --help）`);
  }
}

function parseFlagsChecked(command, args) {
  const flags = parseFlags(args);
  checkFlags(command, flags);
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

// 状态目录不可写时的指引（座位环境 os.userInfo().homedir=/var/empty，默认推导会失效）：
// ZCODE_SUB_HOME 已设置（fromEnv）→ 只需对该目录授权；未设置 → 先显式给环境变量再重试。
export function unwritableHomeAdvice(home, fromEnv) {
  if (fromEnv) {
    return `✗ 状态目录不可写：${home}\n请执行：dwc grant ${home}`;
  }
  return [
    `✗ 状态目录不可写且未设置 ZCODE_SUB_HOME（当前推导值：${home}，常见于 HOME 被重定向的运行环境）。`,
    `两个变量的含义：`,
    `  ZCODE_SUB_HOME       本工具状态目录（任务登记与信箱）；`,
    `  ZCODE_DATA_BASE_DIR  ZCode 数据目录基目录（从这里找 <该目录>/.zcode/v2/local-task-api.json 开关文件）。`,
    `每条 zcode-sub 命令都要带这两个变量——建议做成 shim（替换 <你的用户名> 与仓库路径后放 PATH）：`,
    `  #!/bin/bash`,
    `  export ZCODE_SUB_HOME=/Users/<你的用户名>/.zcode-sub`,
    `  export ZCODE_DATA_BASE_DIR=/Users/<你的用户名>`,
    `  exec /Users/<你的用户名>/projects/zcode-sub/bin/zcode-sub.js "$@"`,
  ].join("\n");
}

async function cmdSetup(home, flags) {
  // 任何 loadConfig/updateConfig 之前先探状态目录可写：不可写时后续 ensureHome 的
  // mkdirSync 会裸崩，这里直接给指引退出（fromEnv = ZCODE_SUB_HOME 已设置）。
  if (!ensureWritableHome(home)) {
    process.stdout.write(`${unwritableHomeAdvice(home, Boolean(process.env.ZCODE_SUB_HOME?.trim()))}\n`);
    process.exitCode = 1;
    return;
  }
  const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || userInfo().homedir;
  const switchFile = join(dataBaseDir, ".zcode", "v2", "local-task-api.json");
  let config = loadConfig(home) ?? createInitialConfig();

  let requestedPort = null;
  if (typeof flags["api-port"] === "string") {
    const port = Number.parseInt(flags["api-port"], 10);
    if (Number.isInteger(port) && port > 0) {
      requestedPort = port;
      config = updateConfig(home, { apiPort: port });
    }
  }

  const existing = readSwitchFile(switchFile);
  if (existing) {
    if (requestedPort !== null && requestedPort !== existing.port) {
      process.stdout.write(
        `✗ 端口冲突：开关文件端口为 ${existing.port}，--api-port 指定 ${requestedPort}；以开关文件为准。要改端口请手工编辑 ${switchFile} 后重启 ZCode，或删除该文件重跑 setup。\n`,
      );
      process.exitCode = 1;
    }
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
      process.stdout.write(`  若需本工具自动写入：dwc grant ${dirname(switchFile)} 后重跑 setup。\n`);
      process.stdout.write(
        `  若数据目录推导失效（如 /var/empty），设置 ZCODE_DATA_BASE_DIR=<真实家目录> 后重跑 setup。\n`,
      );
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
    "把下面片段合入 ZCode 的 MCP 配置文件（桌面版与 CLI 共用 ~/.zcode/cli/config.json 的 mcp.servers，\nZCode 会实时加载；子代理首次调用工具时会弹权限确认）：\n",
  );
  process.stdout.write("```json\n");
  process.stdout.write(`${JSON.stringify(mcpConfigSnippet(home), null, 2)}\n`);
  process.stdout.write("```\n");
  if (stableNodePath() !== process.execPath) {
    process.stdout.write("ℹ node 路径已从 Homebrew Cellar 转为稳定的 opt 链接（升级 Node 不断链）。\n");
  }
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
  atomicWriteJson(file, value, { mode: 0o600 });
}

function mcpConfigSnippet(home) {
  return {
    features: { mcp: true },
    mcp: {
      servers: {
        "zcode-sub": {
          type: "stdio",
          command: stableNodePath(),
          args: [join(packageBinDir(), "zcode-sub.js"), "mcp"],
          env: { ZCODE_SUB_HOME: resolve(home) },
          enabled: true,
        },
      },
    },
  };
}

// Homebrew 的 Cellar 路径带版本号（升级即断链）；opt 路径是稳定符号链接。
function stableNodePath() {
  const execPath = process.execPath;
  const match = execPath.match(/\/Cellar\/(node(@[^/]+)?)\//u);
  if (match) {
    const candidate = `/opt/homebrew/opt/${match[1]}/bin/node`;
    return existsSync(candidate) ? candidate : execPath;
  }
  return execPath;
}

function packageBinDir() {
  // setup 打印的片段写当前包 bin 的绝对路径（安装方式见 README）
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
}

// setup 前置探测：目录不存在先建（失败即不可写），再用写-删探针确认可写。
function ensureWritableHome(home) {
  try {
    mkdirSync(home, { recursive: true }); // 目录已存在时是空操作
  } catch {
    return false; // EACCES/EROFS 等：目录都建不出来，必然不可写
  }
  return isWritableHome(home);
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

// 偏离#11：mode 枚举与假端点/ZCode 侧白名单一致。run 默认 yolo（用户拍板：派发任务
// 默认完全访问）；--mode 可覆盖，config.defaultMode 次之（合法才用）。
const TASK_MODES = new Set(["default","yolo","guarded","plan","edit","acceptEdits","auto","dontAsk","bypassPermissions","autoEdit","build"]);

// 终态只有 idle/error；dispatched/running/waiting_permission/waiting_input/未知值都算未结束。
const TERMINAL_STATUSES = new Set(["idle", "error"]);

// 并发派发上限：本地登记中未结束的任务先按 ZCode 侧逐个刷新再计数
// （刷新失败/异常按本地记录算，不阻断计数）；达到上限拒绝再派。
async function enforceRunningLimit(home, config) {
  const maxRunning = Number.parseInt(process.env.ZCODE_SUB_MAX_RUNNING ?? "4", 10) || 4;
  let count = 0;
  for (const [name, record] of Object.entries(tasks.loadTasks(home).tasks)) {
    if (TERMINAL_STATUSES.has(record.lastStatus)) continue;
    let status = record.lastStatus;
    try {
      const fresh = await api.getTask(config, record.taskId, record.workspacePath);
      if (typeof fresh?.status === "string" && fresh.status !== status) {
        status = fresh.status;
        tasks.updateTask(home, name, { lastStatus: status });
      }
    } catch (error) {
      if (error?.code === "zcode_send_failed" && error?.status === 404) {
        // ZCode 侧已没有该任务（GUI 里删除）：置终态并落盘，不再占并发额度
        status = "error";
        tasks.updateTask(home, name, { lastStatus: status });
      }
      // 其余刷新失败（不可达/鉴权等）按本地记录算
    }
    if (!TERMINAL_STATUSES.has(status)) count += 1;
  }
  if (count >= maxRunning) {
    const err = new Error(
      `zcode_too_many_running: 已有 ${count} 个任务未结束（上限 ${maxRunning}）。先 wait/stop 收尾，或用环境变量 ZCODE_SUB_MAX_RUNNING 调整上限。GUI 里删除的旧任务在下次 run 时会自动释放额度。`,
    );
    err.code = "zcode_too_many_running";
    err.exitCode = 8;
    throw err;
  }
}

async function cmdRun(home, flags) {
  const taskText = flags._[0];
  const cwd = flags.cwd;
  if (!taskText || typeof cwd !== "string" || !cwd.startsWith("/")) {
    throw usageError('用法：zcode-sub run "<任务>" --cwd <工作区绝对路径> [--name <名>] [--mode <模式>]');
  }
  // --mode 显式传入先校验合法性：用法错误不该依赖 setup 状态，在建任务之前拦下。
  // flags.mode 为布尔 true（--mode 后没跟值）时视同未传，走 config/默认。
  let modeFlag = null;
  if (typeof flags.mode === "string") {
    if (!TASK_MODES.has(flags.mode)) {
      throw usageError(
        `用法错误：--mode "${flags.mode}" 不在合法枚举内（default/yolo/guarded/plan/edit/acceptEdits/auto/dontAsk/bypassPermissions/autoEdit/build）`,
      );
    }
    modeFlag = flags.mode;
  }
  // --model 为预留接口：模型选择在途，明确报错而非静默吞掉（usage error，建任务之前拦下）。
  if (flags.model !== undefined) {
    throw usageError("--model 尚未支持：模型选择接口在途（等上游交付后启用）；当前按 ZCode 会话默认模型派发，去掉 --model 重试");
  }
  const name = typeof flags.name === "string" && flags.name ? flags.name : autoName();
  assertValidName(name);
  const config = requireConfig(home);
  // mode 解析：--mode 显式优先（已校验）；其次 config.defaultMode（合法才用）；否则
  // 默认 yolo（完全访问）。config.defaultMode 非法时忽略并提示，不阻断派发。
  let mode;
  if (modeFlag !== null) {
    mode = modeFlag;
  } else if (config.defaultMode && TASK_MODES.has(config.defaultMode)) {
    mode = config.defaultMode;
  } else {
    if (config.defaultMode) {
      process.stderr.write(`⚠ config.defaultMode="${config.defaultMode}" 非法，已忽略（按默认 yolo）\n`);
    }
    mode = "yolo";
  }
  // 忠实#2：本地重名预查——重名在触上游之前拦下，不先 createTask 才被 registerTask
  // 拒绝（那会在 ZCode 侧留下孤儿对话）。消息口径与 registerTask 的 nameTakenError 一致；
  // 预查到登记之间的并发竞态仍由 registerTask 的 EEXIST 兜底。
  if (tasks.getTask(home, name)) {
    const err = new Error(`zcode_name_taken: 任务名 "${name}" 已存在，换一个名字`);
    err.code = "zcode_name_taken";
    err.exitCode = 7;
    throw err;
  }
  await enforceRunningLimit(home, config);

  // 幂等键：网络失败自动重试时同键防双建；重名等场景可人工对账
  const clientRequestId = "zsub-" + randomUUID();
  // 先建 ZCode 对话，再登记本地；名字冲突时 ZCode 侧已存在，要如实告知。
  const { taskId, warning } = await api.createTask(config, {
    workspacePath: cwd,
    prompt: wrappedPrompt(name, cwd, taskText),
    title: name,
    mode,
    clientRequestId,
  });
  try {
    tasks.registerTask(home, name, { taskId, workspacePath: cwd, clientRequestId });
  } catch (error) {
    if (error?.code === "zcode_name_taken") {
      process.stderr.write(
        `⚠ 任务已在 ZCode 创建（taskId=${taskId}，clientRequestId=${clientRequestId}）但本地名字冲突，换名重跑；或手动记下 taskId。\n`,
      );
    }
    throw error;
  }

  // 偏离#13：任务已创建但首条 prompt 未送达——登记照常、退出码保持 0（任务已建，
  // 非零会让父代理误判整个 run 失败），stderr 给补发指引、stdout JSON 带 warning 字段。
  if (warning === "first_prompt_failed") {
    process.stderr.write(
      `⚠ 任务已创建（taskId=${taskId}）但首条消息未送达（first_prompt_failed）。用 zcode-sub send ${name} "<原始任务全文>" 补发。\n`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      name,
      taskId,
      status: "dispatched",
      workspacePath: cwd,
      clientRequestId,
      ...(warning ? { warning } : {}),
    })}\n`,
  );
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
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `zsub-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${ms}`;
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
  // 幂等键：与 run 同规则（"zsub-"+UUID，总长 41）；网络失败同键安全重试一次，不双投
  const clientRequestId = "zsub-" + randomUUID();
  const result = await api.sendMessage(config, task.taskId, message, delivery, task.workspacePath, clientRequestId);
  // steer 对账键先入本地分片（打印之前）：wait 打印 input.steered 时据此区分
  // 「你的引导已受理」与「来自 GUI 侧的引导」。空闲任务的 steer 应答 sent、无 commandId，不记。
  if (result?.delivery === "steered" && result?.commandId) {
    tasks.appendSteerCommandId(home, name, result.commandId);
  }
  const commandId = result?.commandId ? `（commandId=${result.commandId}）` : "";
  process.stdout.write(`✓ 投递结果：${result?.delivery ?? "?"}${commandId}\n`);
  if (result?.delivery === "steered") {
    // FR-004：steered 仅为受理，注入结果（steer.injected / steer.fellBack）以事件流为准
    process.stdout.write("ℹ steered 仅为受理引导；注入结果以事件流为准（wait 可见 steer.injected / steer.fellBack）\n");
  }
}

async function cmdResume(home, flags) {
  const name = flags._[0];
  const message = flags._[1];
  if (!name || message === undefined) {
    throw usageError('用法：zcode-sub resume <name> "<继续文本>"');
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  const payload = await api.getTask(config, task.taskId, task.workspacePath);
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
  // 幂等键：与 run/send 同规则；网络失败同键安全重试一次，不双投
  const clientRequestId = "zsub-" + randomUUID();
  await api.sendMessage(config, task.taskId, message, "auto", task.workspacePath, clientRequestId);
  process.stdout.write("✓ 已接续对话（sent）\n");
}

async function cmdStop(home, flags) {
  const name = flags._[0];
  if (!name) {
    throw usageError("用法：zcode-sub stop <name>");
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  await api.stopTask(config, task.taskId, task.workspacePath);
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
  const payload = await api.getTask(config, task.taskId, task.workspacePath);
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
  // steer 对账集合：本 CLI 每次 --steer 受理时记入分片的 commandId；打印 input.steered
  // 时对得上的是自己的引导，对不上的是 GUI 侧发起的引导（同任务两路来源）。
  const ownSteerIds = new Set(Array.isArray(task.steerCommandIds) ? task.steerCommandIds : []);
  const config = requireConfig(home);
  const timeoutSec = Number.parseInt(String(flags.timeout ?? "600"), 10) || 600;
  const deadline = Date.now() + timeoutSec * 1000;
  let after = task.eventsSeq ?? 0;

  for (;;) {
    // 信箱优先：子代理主动消息不进事件流，也不必等长轮询
    const lines = readMailboxLines(home, name);
    const cursor = readCursor(home, name);
    if (lines.length > cursor) {
      const pending = lines.slice(cursor);
      // 批级总量闸：累计超限即停止逐条打印（游标照常推进到全部行数，不丢数据）。
      // 单条超 WAIT_OUTPUT_LIMIT 的 reply 先降级（前 2000 字符 + 信箱路径提示）再计入
      // 累计——否则一条超长 reply 自己就能冲爆总闸（R3-1，与事件单条截断同构）。
      let written = 0;
      let printed = 0;
      for (const line of pending) {
        if (written >= WAIT_OUTPUT_LIMIT) break;
        const text = typeof line.text === "string" ? line.text : String(line.text);
        const output =
          text.length > WAIT_OUTPUT_LIMIT
            ? `[reply] ${text.slice(0, EVENT_TEXT_LIMIT)}\n…（共 ${text.length} 字符，全文见 ${mailboxPath(home, name)}）\n`
            : `[reply] ${text}\n`;
        process.stdout.write(output);
        written += output.length;
        printed += 1;
      }
      if (printed < pending.length) {
        process.stdout.write(
          `…（剩余 ${pending.length - printed} 条 reply 略过，全文见 ${mailboxPath(home, name)}）\n`,
        );
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

    const payload = await api.getEvents(config, task.taskId, after, Math.min(30_000, remainingMs), task.workspacePath);
    if (payload?.resync) {
      const fresh = await api.getTask(config, task.taskId, task.workspacePath);
      process.stdout.write(`⚠ 事件缓冲溢出，改用 zcode-sub result ${name} 轮询（完整过程见 ZCode GUI）\n`);
      tasks.updateTask(home, name, { lastStatus: fresh.status });
      return;
    }
    const events = Array.isArray(payload?.events) ? payload.events : [];
    if (events.length === 0 && Number.isFinite(payload?.nextSeq) && payload.nextSeq < after) {
      // ZCode 重启会清空事件缓冲、seq 归零：游标跟着回退，继续等新事件（不算新事件、不退出）
      tasks.updateTask(home, name, { eventsSeq: payload.nextSeq });
      process.stdout.write(`⚠ 事件序列已重置（ZCode 可能重启）：${after}→${payload.nextSeq}，继续等待新事件\n`);
      after = payload.nextSeq;
      continue;
    }
    if (events.length > 0) {
      // 先扫全部事件定 lastStatus：被批级上限略过的事件也要参与终态判断
      const patch = { eventsSeq: payload.nextSeq };
      for (const event of events) {
        if (event.type === "turn.completed") patch.lastStatus = "idle";
        if (event.type === "turn.failed") patch.lastStatus = "error";
      }
      // 批级总量闸：累计超限即停止逐条打印（游标照常推进到 payload.nextSeq，不丢数据）
      let written = 0;
      let skipped = 0;
      for (const event of events) {
        if (written >= WAIT_OUTPUT_LIMIT) {
          skipped += 1;
          continue;
        }
        written += writeEventLine(event, ownSteerIds);
        if (event.type === "permission.requested") {
          const hint = "⏳ 请在 ZCode GUI 处理该权限请求\n";
          process.stdout.write(hint);
          written += hint.length;
        }
      }
      if (skipped > 0) {
        process.stdout.write(`…（本批剩余 ${skipped} 条略过，全文用 result 或 ZCode GUI 查看）\n`);
      }
      tasks.updateTask(home, name, patch);
      return;
    }
    // 空页 → 回到信箱检查继续等
  }
}

// 事件正文超过 2000 字符只打印前 2000 字符（全文用 result / ZCode GUI 查看）；
// reply 信箱行保持全文，唯单条超 WAIT_OUTPUT_LIMIT（20000）时降级为前 2000 字符
// + 信箱文件路径提示（见 cmdWait 的 reply 打印路径）。
// 返回本次写入的字符数（含截断提示行），供调用方的批级总量闸（WAIT_OUTPUT_LIMIT）累计。
const EVENT_TEXT_LIMIT = 2000;

// steer 三事件的可读正文（commandId/error 是机器字段，原文打印为空）；其余事件保持 [type] 原文。
// input.steered 按本地 steer 受理记录（ownSteerIds）对账：对上是本 CLI 的引导、对不上是 GUI 侧发起。
const STEER_EVENT_TEXT = {
  "input.steered": (event, ownIds) =>
    ownIds.has(event.commandId)
      ? `你的引导已受理（commandId=${event.commandId ?? "?"}）；注入结果以事件流为准`
      : `来自 GUI 侧的引导（commandId=${event.commandId ?? "?"}）`,
  "steer.injected": (_event, _ownIds) => "引导已注入当前轮（打断生效）",
  "steer.fellBack": (event, _ownIds) => `引导被降级/拒绝，原因：${event.error ?? "?"}——消息将按排队处理或需重发`,
};

function writeEventLine(event, ownSteerIds = new Set()) {
  const steerText = STEER_EVENT_TEXT[event.type];
  const raw = steerText ? steerText(event, ownSteerIds) : (event.text ?? event.error ?? event.summary ?? "");
  const text = typeof raw === "string" ? raw : String(raw);
  const lines = [`[${event.type}] ${text.length <= EVENT_TEXT_LIMIT ? text : text.slice(0, EVENT_TEXT_LIMIT)}\n`];
  if (text.length > EVENT_TEXT_LIMIT) {
    lines.push(`…（共 ${text.length} 字符，全文用 result 或 ZCode GUI 查看）\n`);
  }
  let written = 0;
  for (const line of lines) {
    process.stdout.write(line);
    written += line.length;
  }
  return written;
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
  const rows = [["name", "taskId(后8位)", "lastStatus", "createdAt", "workspacePath"].join("\t")];
  for (const name of names) {
    const task = tasks.getTask(home, name);
    rows.push(
      [
        name,
        String(task.taskId ?? "").slice(-8),
        task.lastStatus ?? "?",
        task.createdAt ? new Date(task.createdAt).toISOString() : "",
        task.workspacePath ?? "",
      ].join("\t"),
    );
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}

async function cmdMcp() {
  const { runMcpServer } = await import("./mcp.js");
  await runMcpServer({});
}
