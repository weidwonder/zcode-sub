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
  zcode-sub run "<任务>" --cwd <绝对路径> [--name <名>] [--mode <模式>] [--model <providerId/modelId>] [--thought <档位>]
      在 ZCode 该工作区新建对话执行任务（多任务可并行）；stdout 一行 JSON。默认 yolo（完全访问）。
      --mode 枚举：default/yolo/guarded/plan/edit/acceptEdits/auto/dontAsk/bypassPermissions/autoEdit/build。
      --model/--thought 按模型选择派发（可用值先 zcode-sub models 查；不传用 ZCode 默认或 config 的 defaultModel）。
  zcode-sub send <name> "<消息>" [--steer|--queue|--interrupt]
      补充消息：默认 auto（运行中的去向由会话设置决定，GUI 默认排队）；
      --steer 请求原生引导（当前步骤结束时注入，长文本生成时可能等较久；应答仅为受理，
      注入结果以事件流为准）、--queue 强制排队；--interrupt 截断当前生成（停止→等回空闲→
      作为新一轮发送，未完成内容丢弃）；三者互斥。任务空闲时即接续对话（sent）。
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
  zcode-sub models [--cwd <绝对路径>] [--json]
      列可用模型（providerId/modelId/思考档位/默认档位/默认标记）；--model 与 --thought 的合法值以此为准。
  zcode-sub model <name> <providerId/modelId> [--thought <档位>]
      给已派发任务换模型（下一轮生效；可用值先 models 查）。
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
    case "models":
      return cmdModels(home, parseFlagsChecked("models", rest));
    case "model":
      return cmdModel(home, parseFlagsChecked("model", rest));
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

// 各命令允许的 flags（白名单外一律用法错误）
const COMMAND_FLAGS = {
  setup: new Set(["api-port"]),
  run: new Set(["cwd", "name", "mode", "model", "thought"]),
  send: new Set(["steer", "queue", "interrupt"]),
  wait: new Set(["timeout"]),
  result: new Set(),
  resume: new Set(),
  stop: new Set(),
  models: new Set(["cwd", "json"]),
  model: new Set(["thought"]),
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
  if (flags["api-port"] !== undefined) {
    // 坏值（非字符串的布尔形态/空串/非整数/非正数）按用法错误拦下，不静默走默认端口
    const port = typeof flags["api-port"] === "string" ? Number.parseInt(flags["api-port"], 10) : Number.NaN;
    if (!Number.isInteger(port) || port <= 0) {
      throw usageError("--api-port 需要整数端口号");
    }
    requestedPort = port;
    config = updateConfig(home, { apiPort: port });
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
    // 写入前预告路径与内容摘要（token 只露前 4 位）：这一步会落一个让 ZCode 开启
    // 本机任务 API 的开关文件，写入前应已征得用户同意。已存在并启用的读回路径不打印。
    process.stdout.write(
      `ℹ 将写入 ZCode 开关文件 ${switchFile}：{"enabled":true,"port":${config.apiPort},"token":"${token.slice(0, 4)}****"}（需重启 ZCode 生效；写入前应已征得用户同意）\n`,
    );
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

// ---------- 模型选择（run / model 共用） ----------

// 模型选择解析：--model <providerId/modelId> 与 --thought <reasoningLevel> 合成 create 的
// modelSelection；优先级 --model/--thought > config.defaultModel；最终无 providerId/modelId
// 则返回 null（不带，用 ZCode 默认）。格式非法/半截组合直接用法错误。
function resolveModelSelection(flags, config) {
  let modelFlag = null; // --model 解析出的 {providerId, modelId}
  if (flags.model !== undefined) {
    const parts = typeof flags.model === "string" ? flags.model.split("/") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw usageError("--model 格式应为 <providerId>/<modelId>，例如 glm/glm-4.7；可用列表 zcode-sub models");
    }
    modelFlag = { providerId: parts[0], modelId: parts[1] };
  }
  // --thought 坏值（忘写值的布尔形态/空串）按用法错误拦下，不静默落到 config 档位
  if (flags.thought !== undefined && (typeof flags.thought !== "string" || flags.thought === "")) {
    throw usageError("--thought 需要一个档位值，如 --thought high");
  }
  const base =
    config.defaultModel !== null && typeof config.defaultModel === "object" && !Array.isArray(config.defaultModel)
      ? config.defaultModel
      : {};
  const providerId = modelFlag?.providerId ?? base.providerId;
  const modelId = modelFlag?.modelId ?? base.modelId;
  // 档位继承收窄：--thought 显式优先；未给 --thought 时仅当「没传 --model」或「--model 与
  // config.defaultModel 是同一模型」（providerId/modelId 都相同）才继承 defaultModel 的档位——
  // --model 换了别的模型时，配置里的档位不跟着搬到新模型上。
  const sameModelAsDefault =
    modelFlag === null || (modelFlag.providerId === base.providerId && modelFlag.modelId === base.modelId);
  const reasoningLevel =
    typeof flags.thought === "string" && flags.thought
      ? flags.thought
      : sameModelAsDefault
        ? base?.options?.reasoningLevel
        : undefined;
  if (flags.thought !== undefined && (!providerId || !modelId)) {
    throw usageError("--thought 需要 --model 或 config defaultModel 提供模型");
  }
  if (!providerId || !modelId) return null;
  return { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
}

// 派发/换模型前按 GET /api/models 预校验：模型不存在或档位非法时给出可选列表（exit 1）。
// 校验通过后返回（可能补全默认档位的）selection：未指定档位且模型有档位列表时按
// max 优先 → defaultThoughtLevel → 末档兜底补默认（真机：ZCode 对有档位的模型拒绝
// 无 reasoningLevel 的建会话）；显式给了档位或模型无档位则原样返回。
async function validateModelSelection(config, workspacePath, selection) {
  const view = await api.listModels(config, workspacePath);
  const providers = Array.isArray(view?.providers) ? view.providers : [];
  const provider = providers.find((entry) => entry?.providerId === selection.providerId);
  const model = provider?.models?.find((entry) => entry?.modelId === selection.modelId);
  if (!provider || !model) {
    const available = providers
      .flatMap((entry) =>
        (Array.isArray(entry?.models) ? entry.models : []).map((item) => `${entry.providerId}/${item.modelId}`),
      )
      .join(", ");
    const err = new Error(
      `zcode_model_invalid: 模型 ${selection.providerId}/${selection.modelId} 不在可用列表。可选：${available}`,
    );
    err.code = "zcode_model_invalid";
    err.exitCode = 1;
    throw err;
  }
  const levels = Array.isArray(model.thoughtLevels) ? model.thoughtLevels : [];
  const wanted = selection.options?.reasoningLevel;
  if (wanted !== undefined) {
    if (levels.length === 0) {
      const err = new Error(
        `zcode_model_invalid: 模型 ${selection.providerId}/${selection.modelId} 无思考档位，去掉 --thought；档位可显式传 --thought 覆盖（若来自 config defaultModel 可修改配置）`,
      );
      err.code = "zcode_model_invalid";
      err.exitCode = 1;
      throw err;
    }
    if (!levels.includes(wanted)) {
      const err = new Error(
        `zcode_model_invalid: 思考档位非法：${wanted}，可选 ${levels.join(",")}；档位可显式传 --thought 覆盖（若来自 config defaultModel 可修改配置）`,
      );
      err.code = "zcode_model_invalid";
      err.exitCode = 1;
      throw err;
    }
    return selection;
  }
  if (levels.length > 0) {
    const level = levels.includes("max")
      ? "max"
      : typeof model.defaultThoughtLevel === "string" && levels.includes(model.defaultThoughtLevel)
        ? model.defaultThoughtLevel
        : levels[levels.length - 1];
    process.stderr.write(`ℹ 未指定思考档位，已用 ${selection.providerId}/${selection.modelId} 的默认档位 ${level}\n`);
    return { ...selection, options: { reasoningLevel: level } };
  }
  return selection;
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
  // --model 已支持（偏离#17）：resolveModelSelection 见下，格式错误同样是建任务之前拦下。
  const name = typeof flags.name === "string" && flags.name ? flags.name : autoName();
  assertValidName(name);
  const config = requireConfig(home);
  // 偏离#17：--model/--thought（优先级高于 config.defaultModel）合成 modelSelection；
  // 非 null 时先按 /api/models 预校验，模型/档位非法在此拦下，不触 createTask。
  // 预校验会补全默认档位（未指定 --thought 且模型有档位时），用返回值进 createTask body。
  const resolvedSelection = resolveModelSelection(flags, config);
  const modelSelection =
    resolvedSelection !== null ? await validateModelSelection(config, cwd, resolvedSelection) : null;
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
    modelSelection,
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
    throw usageError('用法：zcode-sub send <name> "<消息>" [--steer|--queue|--interrupt]');
  }
  // 三者互斥（--interrupt 截断重发、--steer 引导、--queue 排队，语义互不相容）；
  // 用法错误先于任务查找拦下（与其它 flag 校验同口径）。
  if (flags.interrupt && (flags.steer || flags.queue)) {
    throw usageError("--interrupt 与 --steer/--queue 互斥");
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  // --interrupt：先停当前生成，等回空闲，再作为新一轮发送（未完成内容丢弃）。
  if (flags.interrupt) {
    await api.stopTask(config, task.taskId, task.workspacePath);
    process.stdout.write("✓ 已请求停止；等待任务回到空闲…\n");
    // 有界轮询：500ms 一次直到 idle/error；超限按发送失败处理（消息未发出，不静默重投）
    const limitMs = Number.parseInt(process.env.ZCODE_SUB_INTERRUPT_TIMEOUT_MS ?? "15000", 10) || 15000;
    const deadline = Date.now() + limitMs;
    let status;
    for (;;) {
      const payload = await api.getTask(config, task.taskId, task.workspacePath);
      status = payload?.status;
      if (status === "idle" || status === "error") break;
      if (Date.now() >= deadline) {
        const err = new Error(
          `zcode_send_failed: 任务在 ${limitMs}ms 内未回到空闲（status=${status}），消息未发送——用 zcode-sub result ${name} 查看状态后重试`,
        );
        err.code = "zcode_send_failed";
        err.exitCode = 4;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    process.stdout.write("✓ 已截断当前生成，未完成内容丢弃\n");
    // 截断轮的事件仍在缓冲里，后续 wait 会当新事件重放（终态事件会误导父代理提前收尾）——
    // 读当前 nextSeq（增量页，waitMs=0）把持久游标推进到这里。正在挂起的旧 wait 不受影响
    // （其内存游标不变，Skill 已注明）；读取失败不阻断发送。
    try {
      const page = await api.getEvents(config, task.taskId, task.eventsSeq ?? 0, 0, task.workspacePath);
      if (page && !page.resync && Number.isFinite(page.nextSeq) && page.nextSeq > (task.eventsSeq ?? 0)) {
        tasks.updateTask(home, name, { eventsSeq: page.nextSeq });
      }
    } catch {
      process.stderr.write("⚠ 未读到事件游标：后续 wait 可能先看到被截断那一轮的终态事件\n");
    }
  }
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

// ---------- models / model ----------

// 模型目录（偏离#18）：--json 出原始 payload；文本表每个模型一行，默认档位列显示
// defaultThoughtLevel（无则 -），默认列按 preferred 命中标 *。
async function cmdModels(home, flags) {
  const config = requireConfig(home);
  const payload = await api.listModels(config, typeof flags.cwd === "string" ? flags.cwd : undefined);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const preferred =
    payload?.preferred?.providerId && payload?.preferred?.modelId
      ? `${payload.preferred.providerId}/${payload.preferred.modelId}`
      : null;
  const rows = [["providerId", "modelId", "thoughtLevels", "默认档位", "默认"].join("\t")];
  for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      const levels = Array.isArray(model.thoughtLevels) && model.thoughtLevels.length > 0 ? model.thoughtLevels.join(",") : "-";
      rows.push(
        [
          provider.providerId,
          model.modelId,
          levels,
          typeof model.defaultThoughtLevel === "string" ? model.defaultThoughtLevel : "-",
          preferred === `${provider.providerId}/${model.modelId}` ? "*" : "",
        ].join("\t"),
      );
    }
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}

// 给已派发任务换模型（偏离#19：运行中允许，下一轮生效）。同一个 resolveModelSelection/
// validateModelSelection：--model 位置参数替代，--thought 与 config.defaultModel 语义不变。
async function cmdModel(home, flags) {
  const name = flags._[0];
  const modelRef = flags._[1];
  if (!name || !modelRef) {
    throw usageError("用法：zcode-sub model <name> <providerId/modelId> [--thought <档位>]");
  }
  const task = requireTask(home, name);
  const config = requireConfig(home);
  const base = resolveModelSelection({ model: modelRef, thought: flags.thought }, config);
  // flags._[1] 无斜杠会在 resolveModelSelection 报格式错，base 实际必非 null；兜底防御。
  if (base === null) {
    throw usageError("--model 格式应为 <providerId>/<modelId>，例如 glm/glm-4.7；可用列表 zcode-sub models");
  }
  // 预校验返回补全默认档位后的 selection（未指定 --thought 且模型有档位时），进 setModel body
  const selection = await validateModelSelection(config, task.workspacePath, base);
  // 幂等键与 run/send 同规则；端点侧为独立 model 命名空间（偏离#20）
  await api.setModel(config, task.taskId, selection, task.workspacePath, "zsub-" + randomUUID());
  process.stdout.write(
    `✓ 已切换模型 ${selection.providerId}/${selection.modelId}${selection.options ? `（思考档位 ${selection.options.reasoningLevel}）` : ""}（下一轮生效）\n`,
  );
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
  // --timeout 给定但不是正整数 → 用法错误（0 与非数值不再静默落默认 600，与
  // --api-port/--thought 等坏值同口径）；未给默认 600。
  const timeoutSec = flags.timeout === undefined ? 600 : Number.parseInt(String(flags.timeout), 10);
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    throw usageError("--timeout 需要正整数秒数");
  }
  const task = requireTask(home, name);
  // steer 对账集合：本 CLI 每次 --steer 受理时记入分片的 commandId；打印 input.steered
  // 时对得上的是自己的引导，对不上的是 GUI 侧发起的引导（同任务两路来源）。
  // 入口只是初值——标准工作流是「后台 wait + 运行中 send --steer」，send 写入发生在
  // wait 启动之后，拿到事件批时重读分片刷新（下方 events.length > 0 分支）。
  let ownSteerIds = new Set(Array.isArray(task.steerCommandIds) ? task.steerCommandIds : []);
  const config = requireConfig(home);
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
      // A 最终语义（local-task-api.md）：缓冲释放/重启后 after>0 返回 {resync:true}，after=0 可重新跟随。
      // 持久游标重置为 0 后继续跟随——只提示一次，不退出、不每次报溢出。
      const fresh = await api.getTask(config, task.taskId, task.workspacePath);
      process.stdout.write(
        `⚠ 事件序列已重置（ZCode 可能重启或缓冲已释放）：游标归 0，继续跟随新事件（历史进展用 result 或 ZCode GUI 查看）\n`,
      );
      tasks.updateTask(home, name, { lastStatus: fresh.status, eventsSeq: 0, resetEventsSeq: true });
      after = 0;
      continue;
    }
    const events = Array.isArray(payload?.events) ? payload.events : [];
    if (events.length === 0 && Number.isFinite(payload?.nextSeq) && payload.nextSeq < after) {
      // ZCode 重启会清空事件缓冲、seq 归零：游标跟着回退，继续等新事件（不算新事件、不退出）。
      // 较小值要真能写回，必须带 resetEventsSeq（否则被合并写的 max 抵消）。
      tasks.updateTask(home, name, { eventsSeq: payload.nextSeq, resetEventsSeq: true });
      process.stdout.write(`⚠ 事件序列已重置（ZCode 可能重启）：${after}→${payload.nextSeq}，继续等待新事件\n`);
      after = payload.nextSeq;
      continue;
    }
    if (events.length > 0) {
      // 对账集合实时刷新：以分片现值为准，后台 wait 启动后前台 send --steer 写入的
      // commandId 才能对上（入口快照会把用户自己的引导稳定误判成 GUI 侧）。
      const fresh = tasks.getTask(home, name);
      ownSteerIds = new Set(Array.isArray(fresh?.steerCommandIds) ? fresh.steerCommandIds : []);
      // 先扫全部事件定 lastStatus：被批级上限略过的事件也要参与终态判断
      const patch = { eventsSeq: payload.nextSeq };
      for (const event of events) {
        if (event.type === "turn.completed") patch.lastStatus = "idle";
        if (event.type === "turn.failed") patch.lastStatus = "error";
      }
      // 同轮合并输出：拿到事件批后再读一次信箱，把游标后的 reply 行与事件按时间先后
      // 合并打印（真机：reply 早于 assistant.message 写入，只打事件批会把 reply 漏到
      // 下一轮甚至丢给超时）。合并流：事件（at）与 reply（ts）按时间升序，同值时事件
      // 在前（Array.sort 稳定，先放事件）。
      const lines = readMailboxLines(home, name);
      const cursor = readCursor(home, name);
      const pendingReplies = lines.slice(cursor);
      const merged = [
        ...events.map((event) => ({ at: event.at, kind: "event", event })),
        ...pendingReplies.map((line) => ({ at: line.ts, kind: "reply", line })),
      ].sort((a, b) => a.at - b.at);
      // 批级总量闸：累计超限即停止逐条打印（事件游标推进到 payload.nextSeq、信箱游标推进
      // 到全部行数，不丢数据）；事件与 reply 一并计入 skipped。
      let written = 0;
      let skipped = 0;
      for (const item of merged) {
        if (written >= WAIT_OUTPUT_LIMIT) {
          skipped += 1;
          continue;
        }
        if (item.kind === "event") {
          written += writeEventLine(item.event, ownSteerIds);
          if (item.event.type === "permission.requested") {
            const hint = "⏳ 请在 ZCode GUI 处理该权限请求\n";
            process.stdout.write(hint);
            written += hint.length;
          }
        } else {
          const text = typeof item.line.text === "string" ? item.line.text : String(item.line.text);
          const output =
            text.length > WAIT_OUTPUT_LIMIT
              ? `[reply] ${text.slice(0, EVENT_TEXT_LIMIT)}\n…（共 ${text.length} 字符，全文见 ${mailboxPath(home, name)}）\n`
              : `[reply] ${text}\n`;
          process.stdout.write(output);
          written += output.length;
        }
      }
      if (skipped > 0) {
        process.stdout.write(`…（本批剩余 ${skipped} 条略过，全文用 result / 信箱文件或 ZCode GUI 查看）\n`);
      }
      writeCursor(home, name, lines.length);
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
  "steer.injected": (_event, _ownIds) => "引导已注入当前轮",
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
