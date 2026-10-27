import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidName, ensureHome } from "./home.js";

// 信箱：每任务一个 jsonl 追加文件，daemon 崩溃重启不丢（append 落盘后才算收到）。
// seq 在 name 信箱内单调；进程内存自增，重启从文件尾恢复。

export function mailboxPath(home, name) {
  assertValidName(name);
  const paths = ensureHome(home);
  return join(paths.mailboxesDir, `${name}.jsonl`);
}

export function appendMailbox(home, name, { kind, text, raw }) {
  const file = mailboxPath(home, name);
  const seq = nextSeq(file);
  const entry = {
    seq,
    ts: Date.now(),
    kind,
    text: typeof text === "string" ? text : "",
    ...(raw !== undefined ? { raw } : {}),
  };
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return seq;
}

export function readMailbox(home, name) {
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

export function writeCursor(home, name, seq) {
  assertValidName(name);
  const paths = ensureHome(home);
  writeFileSync(join(paths.mailboxesDir, `${name}.cursor`), `${seq}\n`);
}

function nextSeq(file) {
  if (!existsSync(file)) return 1;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const last = JSON.parse(lines[index]);
      if (Number.isInteger(last.seq)) return last.seq + 1;
    } catch {
      // 尾部半行不可解析时继续往前找
    }
  }
  return 1;
}
