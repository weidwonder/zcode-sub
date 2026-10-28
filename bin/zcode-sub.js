#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  // 多数错误的 message 已自带 "code: " 前缀，这里只在缺失时补，避免 zcode_xxx: zcode_xxx: … 双前缀。
  const message = String(error?.message ?? error);
  const prefix = error?.code && !message.startsWith(`${error.code}: `) ? `${error.code}: ` : "";
  process.stderr.write(`${prefix}${message}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
