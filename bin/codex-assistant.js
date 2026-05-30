#!/usr/bin/env node

import { runCli } from "../src/cli.js";

const argv = process.argv.slice(2);
const paddedOutput = !argv.includes("--json");

if (paddedOutput) {
  console.log("");
}

runCli(argv)
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`codex-assistant: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (paddedOutput) {
      console.log("");
    }
  });
