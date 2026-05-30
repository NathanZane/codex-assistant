import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyUninstallPlan, packageUninstallInvocation, planUninstall } from "../src/lib/uninstall.js";

test("planUninstall previews restore, delete, and package uninstall actions", async () => {
  const { codexHome } = await createUninstallFixture();

  const plan = await planUninstall(codexHome, { packageName: "@example/tool" });

  assert.equal(plan.mode, "uninstall");
  assert.equal(plan.rolloutRestore.actionCount, 1);
  assert.equal(plan.rolloutTrash.actionCount, 1);
  assert.equal(plan.agents.actionCount, 0);
  assert.deepEqual(
    plan.deletes.map((item) => item.action).sort(),
    ["delete-backups", "delete-cache"],
  );
  assert.deepEqual(plan.packageUninstall.command, ["npm", "uninstall", "-g", "@example/tool"]);
});

test("applyUninstallPlan restores project state and removes owned artifacts", async () => {
  const { codexHome, configPath, cacheDir, backupDir, quarantinedPath, restoredPath } = await createUninstallFixture();

  const plan = await planUninstall(codexHome);
  const result = await applyUninstallPlan(plan, {
    rollouts: "restore",
    deleteCache: true,
    deleteBackups: true,
    uninstallPackage: false,
  });

  assert.equal(result.rollouts.actionCount, 1);
  assert.equal(await exists(quarantinedPath), false);
  assert.equal(await exists(restoredPath), true);
  assert.equal(await exists(cacheDir), false);
  assert.equal(await exists(backupDir), false);

  const currentConfig = await fs.readFile(configPath, "utf8");
  assert.match(currentConfig, /name = "cleanup-target"\nenabled = false/);
});

test("packageUninstallInvocation uses cmd.exe on Windows for npm", () => {
  const invocation = packageUninstallInvocation("@example/tool", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "npm", "uninstall", "-g", "@example/tool"]);
  assert.deepEqual(invocation.displayCommand, ["npm", "uninstall", "-g", "@example/tool"]);
});

test("packageUninstallInvocation spawns npm directly off Windows", () => {
  const invocation = packageUninstallInvocation("@example/tool", "linux", {});

  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["uninstall", "-g", "@example/tool"]);
});

async function createUninstallFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-uninstall-"));
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const backupDir = path.join(codexHome, "backups", "codex-assistant");
  const cacheDir = path.join(codexHome, "cache", "codex-assistant");
  const quarantineDir = path.join(codexHome, "quarantine", "rollouts", "sessions", "2026", "01", "01");
  const fileName = "rollout-2026-01-01T00-00-00-019d2bdc-9999-7000-9000-000000000001.jsonl";
  const quarantinedPath = path.join(quarantineDir, fileName);
  const restoredPath = path.join(codexHome, "sessions", "2026", "01", "01", fileName);
  const backupPath = path.join(backupDir, "config-skills-2026-05-29T00-00-00-000Z.toml");

  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(quarantineDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, "cache-v1.json"), "{}\n");
  await fs.writeFile(quarantinedPath, "session\n");
  await fs.writeFile(
    backupPath,
    [
      "[[skills.config]]",
      'name = "cleanup-target"',
      "enabled = true",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    `${backupPath}.json`,
    JSON.stringify({ kind: "skill-disable", skills: ["cleanup-target"] }, null, 2),
  );
  await fs.writeFile(
    configPath,
    [
      "[[skills.config]]",
      'name = "cleanup-target"',
      "enabled = false",
      "",
    ].join("\n"),
  );

  return {
    codexHome,
    configPath,
    cacheDir,
    backupDir,
    quarantinedPath,
    restoredPath,
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
