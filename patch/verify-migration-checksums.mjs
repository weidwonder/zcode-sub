#!/usr/bin/env node
// 复算 ZCode 源码迁移清单的 checksum 并与用户库账本比对（降级兼容性门检）。
// 用法：node verify-migration-checksums.mjs <ZCode源码目录> [--zcode-root ~/.zcode]
// 退出码：0 全匹配（含列出动态未验项）；1 有 DIFF 或账本含清单外条目（降级有风险）。
// 规则依据（3.16.2 源码）：
//   会话库   sha256(sql.trim())                       packages/shared/src/sqlite-migrations/runner.ts:114-116
//   任务索引 sha256(JSON.stringify(checksumInput))    packages/services/src/session/tasksDatabase/migrations.ts:146-148
//   项目存储 sha256(sql.trim())（拼装后完整串）        packages/services/src/project-storage/index.ts:29-57
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
if (!src) {
  console.error("用法：node verify-migration-checksums.mjs <ZCode源码目录> [--zcode-root ~/.zcode]");
  process.exit(1);
}
const rootFlag = args.find((a) => a.startsWith("--zcode-root"));
const zcodeRoot = rootFlag ? rootFlag.split("=")[1] ?? args[args.indexOf(rootFlag) + 1] : join(userInfo().homedir, ".zcode");
// 座位/脚本环境 $HOME 可能被重定向；userInfo().homedir 取系统用户的真实家目录、不读 $HOME（homedir() 实测会落到座位目录，不可用）
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const jsha = (arr) => sha256(JSON.stringify(arr));

function tpl(path, constName) {
  const text = readFileSync(path, "utf8");
  const decl = text.indexOf(`const ${constName} = \``);
  if (decl === -1) throw new Error(`找不到 ${constName} in ${path}`);
  const tick = text.indexOf("`", decl);
  return text.slice(tick + 1, text.indexOf("`", tick + 1));
}

// 普通双引号字符串常量（如 INITIAL_WORKSPACE_ORDER_SQL），同样从源码文本提取
function stringConst(path, constName) {
  const text = readFileSync(path, "utf8");
  const decl = text.indexOf(`const ${constName} =`);
  if (decl === -1) throw new Error(`找不到 ${constName} in ${path}`);
  const open = text.indexOf('"', decl);
  const close = open === -1 ? -1 : text.indexOf('"', open + 1);
  if (close === -1) throw new Error(`提取 ${constName} 失败 in ${path}`);
  return text.slice(open + 1, close);
}

// 数组常量（收口为 `] as const;`，如 executionColumns）：取方括号内文本补回外层括号 JSON.parse（TS 尾逗号合法、JSON 不合法，去掉再解析）
function arrayConst(path, constName) {
  const text = readFileSync(path, "utf8");
  const head = `const ${constName} = [`;
  const decl = text.indexOf(head);
  if (decl === -1) throw new Error(`找不到 ${constName} in ${path}`);
  const close = text.indexOf("] as const;", decl);
  if (close === -1) throw new Error(`提取 ${constName} 失败 in ${path}`);
  const body = text.slice(decl + head.length, close).trim().replace(/,$/, "");
  return JSON.parse(`[${body}]`);
}

// 定位 `id: "<id>"` 所在段内 from 标记之后到 to 首次出现之间的原始文本；找不到即抛错（门检失败，不静默用旧值）
// includeTo=true 时把 to 本身含进结果（如 checksumInput 的收口 `]`）
function segmentText(text, path, id, from, to, includeTo = false) {
  const anchor = text.indexOf(`id: "${id}"`);
  if (anchor === -1) throw new Error(`在 ${path} 找不到迁移 ${id}`);
  const start = text.indexOf(from, anchor);
  const end = start === -1 ? -1 : text.indexOf(to, start + from.length);
  if (end === -1) throw new Error(`在 ${path} 提取 ${id} 失败（锚点 ${from}…${to}）`);
  return text.slice(start + from.length, includeTo ? end + to.length : end);
}

// 迁移 sql 模板串还原：${CONST} 换常量值、字面 \n 换真换行、trim，与运行时拼装结果一致
function resolveSqlTemplate(raw, consts) {
  return raw
    .replace(/\$\{(\w+)\}/g, (whole, name) => {
      if (!(name in consts)) throw new Error(`resolveSqlTemplate：缺常量 ${name}（${whole}）`);
      return consts[name];
    })
    .replace(/\\n/g, "\n")
    .trim();
}

function readLedger(db, table) {
  return new Map(
    execFileSync("sqlite3", ["-readonly", db, `SELECT id, checksum FROM ${table};`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).map((l) => l.split("|")),
  );
}

let bad = 0;
function check(label, id, sum, ledger) {
  const inDb = ledger.get(id);
  if (inDb === undefined) { console.log(`ABSENT ${label} ${id}（账本无记录，将随启动应用）`); return; }
  if (inDb === sum) { console.log(`OK     ${label} ${id}`); return; }
  console.log(`DIFF   ${label} ${id}\n  账本: ${inDb}\n  源码: ${sum}`);
  bad++;
}

// 任一环节抛错（源码锚点找不到、文件缺失、库打不开）都按门检失败优雅退出，不抛未捕获栈
try {
// ---- 1) 会话库（schema_migration；模板条目精确算，动态构造条目列出待人工）----
{
  const text = readFileSync(`${src}/apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`, "utf8");
  const ledger = readLedger(`${zcodeRoot}/cli/db/db.sqlite`, "schema_migration");
  const idRe = /id:\s*"(\d{4}_[a-z0-9_]+)"/g;
  const ids = [...text.matchAll(idRe)].map((m) => m[1]);
  for (const id of ids) {
    const start = text.indexOf(`"${id}"`);
    const next = ids[ids.indexOf(id) + 1];
    const seg = text.slice(start, next ? text.indexOf(`"${next}"`) : text.length);
    const t = seg.indexOf("sql: `");
    if (t !== -1) {
      const tick = seg.indexOf("`", t + 4);
      check("session", id, sha256(seg.slice(tick + 1, seg.indexOf("`", tick + 1)).trim()), ledger);
    } else {
      console.log(`SKIP-DYN session ${id}（SQL 动态构造，源码侧改动的可能性极低，见报告 §1.3 论证）`);
    }
  }
  // 0024 定义在 shared/legacy.ts（纯模板）
  const legacy = readFileSync(`${src}/packages/shared/src/sqlite-migrations/legacy.ts`, "utf8");
  const decl = legacy.indexOf("SESSION_DATABASE_IDENTITY_MIGRATION: SqliteSchemaMigration");
  const tick = legacy.indexOf("`", legacy.indexOf("sql: `", decl));
  check("session", "0024_session_database_identity", sha256(legacy.slice(tick + 1, legacy.indexOf("`", tick + 1)).trim()), ledger);
  for (const id of ledger.keys()) {
    if (!ids.includes(id) && id !== "0024_session_database_identity") {
      console.log(`EXTRA  session ${id}（账本有、源码清单无——降级后此项不被校验，须人工确认其建的结构无破坏）`);
      bad++;
    }
  }
}

// ---- 2) 任务索引（tasks_schema_migration，可精确复算的四条）----
{
  const ledger = readLedger(`${zcodeRoot}/v2/tasks-index.sqlite`, "tasks_schema_migration");
  const glmSql = tpl(`${src}/packages/services/src/session/tasksDatabase/official-glm-selection-v3.ts`, "OFFICIAL_GLM_SELECTION_MIGRATION_SQL");
  const admissionsSql = tpl(`${src}/packages/services/src/task-groups/migration-v6.ts`, "TASK_GROUP_ADMISSIONS_SQL");
  const tasksMigPath = `${src}/packages/services/src/session/tasksDatabase/migrations.ts`;
  const executionColumns = arrayConst(tasksMigPath, "executionColumns");
  const tasks0002Input = JSON.parse(segmentText(readFileSync(tasksMigPath, "utf8"), tasksMigPath, "0002_provider_selection", "checksumInput: ", "]", true));
  check("tasks", "0002_provider_selection", jsha(tasks0002Input), ledger);
  check("tasks", "0003_official_glm_selection", jsha([glmSql]), ledger);
  check("tasks", "0004_project_execution_scopes", jsha([executionColumns, "nullable-text-v1"]), ledger);
  check("tasks", "0006_task_group_admissions", jsha([admissionsSql]), ledger);
  console.log("SKIP-DYN tasks 0001_adopt_task_schema（多常量拼装；用表结构对比代替，见报告 §1.3）");
  // 豁免名单出处：migrations.ts 的 prepareMigrations controller-remote/source-server 分支（非 base scope）
  const otherScopeIds = ["0004_controller_remote_identity", "0005_source_server_workspace_schema"];
  for (const id of ledger.keys()) {
    if (["0002_provider_selection", "0003_official_glm_selection", "0004_project_execution_scopes", "0006_task_group_admissions", "0001_adopt_task_schema"].includes(id)) continue;
    if (otherScopeIds.includes(id)) {
      console.log(`SKIP-SCOPE tasks ${id}（非 base scope，正常）`);
      continue;
    }
    console.log(`EXTRA  tasks ${id}（账本有、源码 base 清单无——降级后此项不被校验，须人工确认）`);
    bad++;
  }
}

// ---- 3) 项目存储（schema_migration，两条精确）----
{
  const ledger = readLedger(`${zcodeRoot}/v2/tasks-index.sqlite`, "schema_migration");
  const ws = tpl(`${src}/packages/services/src/project-storage/default-workspace/migration.ts`, "DEFAULT_WORKSPACE_CANDIDATES_SQL");
  const order = stringConst(`${src}/packages/services/src/project-storage/migration-order/migration.ts`, "INITIAL_WORKSPACE_ORDER_SQL");
  const pIndexPath = `${src}/packages/services/src/project-storage/index.ts`;
  const pText = readFileSync(pIndexPath, "utf8");
  const sql06 = resolveSqlTemplate(segmentText(pText, pIndexPath, "0006_default_workspace_tasks", "sql: `", "`"), { DEFAULT_WORKSPACE_CANDIDATES_SQL: ws });
  const sql07 = resolveSqlTemplate(segmentText(pText, pIndexPath, "0007_initial_workspace_order", "sql: `", "`"), { INITIAL_WORKSPACE_ORDER_SQL: order });
  check("project", "0006_default_workspace_tasks", sha256(sql06), ledger);
  check("project", "0007_initial_workspace_order", sha256(sql07), ledger);
  console.log("SKIP-DYN project 0005_projects（拼装注释含 TASK_PROJECT_COLUMNS；用表结构对比代替）");
  for (const id of ledger.keys()) {
    if (["0005_projects", "0006_default_workspace_tasks", "0007_initial_workspace_order"].includes(id)) continue;
    console.log(`EXTRA  project ${id}（账本有、源码清单无——降级后此项不被校验，须人工确认）`);
    bad++;
  }
}

} catch (err) {
  console.error(`错误：${err.message}`);
  process.exit(1);
}
console.log(bad === 0 ? "\n结论：可精确验证项全部匹配（SKIP-DYN 条目见报告论证）。" : `\n结论：${bad} 处不匹配/账本超集——降级有风险，先看报告 §1.5 处置。`);
process.exit(bad === 0 ? 0 : 1);
