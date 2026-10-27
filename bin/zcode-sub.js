#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
