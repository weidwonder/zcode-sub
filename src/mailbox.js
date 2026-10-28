import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidName, ensureHome } from "./home.js";

// 信箱：每任务一个 jsonl 追加文件，只承载 MCP reply_to_parent 追加的 reply 行。
// CLI 只读，靠行号游标（<name>.cursor）记录已读到哪，append 落盘后才算收到。

export function mailboxPath(home, name) {
  assertValidName(name);
  const paths = ensureHome(home);
  return join(paths.mailboxesDir, `${name}.jsonl`);
}

export function appendReplyLine(home, name, text) {
  const file = mailboxPath(home, name);
  const entry = { ts: Date.now(), kind: "reply", text: typeof text === "string" ? text : "" };
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readMailboxLines(home, name) {
  const file = mailboxPath(home, name);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 崩溃期半行：跳过，不阻断后续读取
    }
  }
  return entries;
}

export function readCursor(home, name) {
  assertValidName(name);
  const paths = ensureHome(home);
  const cursorFile = join(paths.mailboxesDir, `${name}.cursor`);
  if (!existsSync(cursorFile)) return 0;
  const value = Number.parseInt(readFileSync(cursorFile, "utf8").trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

export function writeCursor(home, name, lineCount) {
  assertValidName(name);
  const paths = ensureHome(home);
  writeFileSync(join(paths.mailboxesDir, `${name}.cursor`), `${lineCount}\n`);
}
