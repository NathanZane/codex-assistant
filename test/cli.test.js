import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("bare command runs the default check", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-default-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  await withMutedConsole(() => assert.doesNotReject(() => runCli(["--codex-home", codexHome, "--only", "agents", "--json"])));
});

test("version output matches package metadata", async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const output = await withCapturedConsole(() => runCli(["--version"]));
  assert.equal(output.trim(), `codex-assistant ${packageJson.version}`);
});

test("cleanup rejects unknown targets instead of printing help", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-cleanup-"));
  const codexHome = path.join(root, ".codex");

  await assert.rejects(
    () => runCli(["cleanup", "unknown", "--codex-home", codexHome]),
    /unknown cleanup target "unknown"/,
  );
});

test("bare cleanup accepts global json and cache options", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-cleanup-json-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  const output = await withCapturedConsole(() => runCli(["cleanup", "--json", "--no-cache", "--codex-home", codexHome]));
  const parsed = JSON.parse(output);
  assert.equal(parsed.command, "cleanup");
  assert.deepEqual(parsed.targets.map((target) => target.name), ["rollouts", "skills"]);
});

test("check rejects unknown --only values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-check-"));
  const codexHome = path.join(root, ".codex");

  await assert.rejects(
    () => runCli(["check", "--only", "typo", "--codex-home", codexHome]),
    /unknown check --only value "typo"/,
  );
});

test("commands reject unknown options", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-options-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  await assert.rejects(
    () => runCli(["check", "rollouts", "--typo", "--codex-home", codexHome]),
    /unknown option --typo for check/,
  );
  await assert.rejects(
    () => runCli(["cleanup", "rollouts", "--archivedd", "--codex-home", codexHome]),
    /unknown option --archivedd for cleanup/,
  );
});

test("check accepts positional targets and rejects ambiguous targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-check-target-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  await withMutedConsole(() => assert.doesNotReject(() => runCli(["check", "rollouts", "--codex-home", codexHome, "--json"])));
  await assert.rejects(
    () => runCli(["check", "rollouts", "--only", "skills", "--codex-home", codexHome]),
    /use either `check <target>` or `check --only <target>`/,
  );
  await assert.rejects(
    () => runCli(["check", "unknown", "--codex-home", codexHome]),
    /unknown check --only value "unknown"/,
  );
});

test("skills, rollouts, and agents commands are check aliases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-check-alias-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  const skillsOutput = await withCapturedConsole(() => runCli(["skills", "--codex-home", codexHome, "--json", "--no-cache"]));
  const checkSkillsOutput = await withCapturedConsole(() => runCli(["check", "skills", "--codex-home", codexHome, "--json", "--no-cache"]));
  assert.deepEqual(JSON.parse(skillsOutput), JSON.parse(checkSkillsOutput));

  const agentsOutput = await withCapturedConsole(() => runCli(["agents", "--codex-home", codexHome, "--json", "--no-cache"]));
  const checkAgentsOutput = await withCapturedConsole(() => runCli(["check", "agents", "--codex-home", codexHome, "--json", "--no-cache"]));
  assert.deepEqual(JSON.parse(agentsOutput), JSON.parse(checkAgentsOutput));

  const rolloutsOutput = await withCapturedConsole(() => runCli(["rollouts", "--codex-home", codexHome, "--json", "--no-cache"]));
  const checkRolloutsOutput = await withCapturedConsole(() => runCli(["check", "rollouts", "--codex-home", codexHome, "--json", "--no-cache"]));
  assert.deepEqual(JSON.parse(rolloutsOutput), JSON.parse(checkRolloutsOutput));
});

test("cleanup skills manual json emits json without opening config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-skills-manual-json-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  const output = await withCapturedConsole(() => runCli(["cleanup", "skills", "--manual", "--json", "--codex-home", codexHome, "--no-cache"]));
  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, "manual-skills-config");
  assert.equal(parsed.configPath, path.join(codexHome, "config.toml"));
  assert.deepEqual(parsed.actions, [{ action: "open-config", target: path.join(codexHome, "config.toml") }]);
});

test("sessions command was removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cli-sessions-removed-"));
  const codexHome = path.join(root, ".codex");

  await assert.rejects(
    () => runCli(["sessions", "--codex-home", codexHome]),
    /unknown command "sessions"/,
  );
});

async function withMutedConsole(callback) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
  }
}

async function withCapturedConsole(callback) {
  const originalLog = console.log;
  const lines = [];
  console.log = (value = "") => {
    lines.push(String(value));
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}
