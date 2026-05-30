import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnalysisCache } from "../src/lib/cache.js";
import { applyCleanupPlan, planCleanup, planQuarantinedCleanup, planQuarantineRestore } from "../src/lib/cleanup.js";
import { applySkillConfigRestorePlan, applySkillDisablePlan, planSkillConfigRestore, planSkillDisable } from "../src/lib/skill-config.js";
import { runSkillCheck } from "../src/checks/skill-check.js";
import { attachSkillUsageEvidence, scanSkillRegistry, summarizeSkillRegistry } from "../src/lib/skills.js";

test("scanSkillRegistry builds plugin-aware skill names and usage evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skills-"));
  const codexHome = path.join(root, ".codex");
  const standalone = path.join(codexHome, "skills", "foo");
  const plugin = path.join(codexHome, "plugins", "cache", "openai-curated", "web-tools", "abc123", "skills", "bar");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "26");
  await fs.mkdir(standalone, { recursive: true });
  await fs.mkdir(plugin, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(standalone, "SKILL.md"), "---\nname: foo\ndescription: Foo skill.\n---\n\n# Foo\n");
  await fs.writeFile(path.join(plugin, "SKILL.md"), "---\nname: bar\ndescription: Bar skill.\n---\n\n# Bar\n");
  const sessionId = "019d2bdc-1111-7000-9000-000000000001";
  await fs.writeFile(
    path.join(sessionDir, `rollout-2026-05-26T10-00-00-${sessionId}.jsonl`),
    `${JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: `Get-Content ${path.join(standalone, "SKILL.md")}` } })}\n`,
  );

  const skills = await scanSkillRegistry(codexHome, { includeAgentSkills: false });
  await attachSkillUsageEvidence(skills, codexHome, { sessionsLimit: 10 });
  const summary = summarizeSkillRegistry(skills);

  assert.equal(skills.length, 2);
  assert.ok(skills.some((skill) => skill.fullName === "foo"));
  assert.ok(skills.some((skill) => skill.fullName === "web-tools:bar"));
  assert.equal(skills.find((skill) => skill.fullName === "foo").usage.explicitReads, 1);
  assert.equal(summary.byPlugin.find((group) => group.name === "web-tools").skills, 1);

  const firstCache = new AnalysisCache(codexHome);
  await firstCache.load();
  const sessionFiles = [{ path: path.join(sessionDir, `rollout-2026-05-26T10-00-00-${sessionId}.jsonl`), mtime: new Date(), sessionId }];
  await attachSkillUsageEvidence(skills, codexHome, { sessionFiles, cache: firstCache, lookupSkills: skills });
  await firstCache.save();

  const secondCache = new AnalysisCache(codexHome);
  await secondCache.load();
  const activeSubset = skills.filter((skill) => skill.fullName === "foo");
  await attachSkillUsageEvidence(activeSubset, codexHome, { sessionFiles, cache: secondCache, lookupSkills: skills });
  assert.equal(secondCache.stats.hits, 1);
  assert.equal(activeSubset[0].usage.explicitReads, 1);
});

test("skill usage cache recomputes when a session JSONL grows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skills-growing-cache-"));
  const codexHome = path.join(root, ".codex");
  const skillDir = path.join(codexHome, "skills", "foo");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "26");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, "---\nname: foo\ndescription: Foo skill.\n---\n\n# Foo\n");
  const sessionId = "019d2bdc-1111-7000-9000-000000000099";
  const sessionPath = path.join(sessionDir, `rollout-2026-05-26T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionPath,
    `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "no skill yet" } })}\n`,
  );
  const sessionFiles = [{ path: sessionPath, mtime: new Date(), sessionId }];
  const skills = await scanSkillRegistry(codexHome, { includeAgentSkills: false });

  const firstCache = new AnalysisCache(codexHome);
  await firstCache.load();
  await attachSkillUsageEvidence(skills, codexHome, { sessionFiles, cache: firstCache, lookupSkills: skills });
  assert.equal(skills[0].usage.explicitReads, 0);
  await firstCache.save();

  await fs.appendFile(
    sessionPath,
    `${JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: `Get-Content ${skillPath}` } })}\n`,
  );

  const secondCache = new AnalysisCache(codexHome);
  await secondCache.load();
  await attachSkillUsageEvidence(skills, codexHome, { sessionFiles, cache: secondCache, lookupSkills: skills });
  assert.equal(secondCache.stats.reusedGrowing, 0);
  assert.equal(secondCache.stats.misses, 1);
  assert.equal(skills[0].usage.explicitReads, 1);
});

test("runSkillCheck excludes skills disabled in config.toml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skills-disabled-config-"));
  const codexHome = path.join(root, ".codex");
  const enabledDir = path.join(codexHome, "skills", "enabled-skill");
  const disabledDir = path.join(codexHome, "skills", "disabled-skill");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "26");
  await fs.mkdir(enabledDir, { recursive: true });
  await fs.mkdir(disabledDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  const enabledPath = path.join(enabledDir, "SKILL.md");
  const disabledPath = path.join(disabledDir, "SKILL.md");
  await fs.writeFile(enabledPath, "---\nname: enabled-skill\ndescription: Enabled skill.\n---\n\n# Enabled\n");
  await fs.writeFile(disabledPath, "---\nname: disabled-skill\ndescription: Disabled skill.\n---\n\n# Disabled\n");
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      "[[skills.config]]",
      'name = "disabled-skill"',
      "enabled = false",
      "",
    ].join("\n"),
  );

  const registry = [
    `- enabled-skill: Enabled skill. (file: ${enabledPath})`,
    `- disabled-skill: Disabled skill. (file: ${disabledPath})`,
  ].join("\n");
  await fs.writeFile(
    path.join(sessionDir, "rollout-2026-05-26T10-00-00-019d2bdc-1111-7000-9000-000000000002.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { base_instructions: { text: registry } } })}\n`,
  );

  const report = await runSkillCheck(codexHome);

  assert.ok(report.skillFilesOnDisk >= 2);
  assert.equal(report.installedSkills, 1);
  assert.equal(report.disabledSkills, 1);
  assert.equal(report.unusedSkills, 1);
  assert.deepEqual(report.neverUsedCandidates.map((candidate) => candidate.skill), ["enabled-skill"]);
  assert.equal(report.neverUsedCandidates.some((candidate) => candidate.skill === "disabled-skill"), false);
});

test("planCleanup only plans quarantine actions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-cleanup-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "01", "01");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "rollout-2026-01-01T00-00-00-019d2bdc-2222-7000-9000-000000000001.jsonl");
  await fs.writeFile(sessionPath, `${"x".repeat(2 * 1024 * 1024)}\n`);
  const oldDate = new Date(Date.now() - 60 * 86_400_000);
  await fs.utimes(sessionPath, oldDate, oldDate);

  const plan = await planCleanup(codexHome, { staleDays: 30, minSizeMb: 1 });
  assert.equal(plan.mode, "quarantine");
  assert.equal(plan.actionCount, 1);
  assert.equal(plan.actions[0].action, "quarantine");
  assert.match(plan.actions[0].target, /quarantine/);
  assert.match(plan.actions[0].target, /sessions/);
});

test("planCleanup treats stale sub-thread rollouts as cleanup candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-subthread-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "01", "01");
  await fs.mkdir(sessionDir, { recursive: true });

  const sessionId = "019d2bdc-3333-7000-9000-000000000001";
  const parentThreadId = "019d2bdc-4444-7000-9000-000000000001";
  const sessionPath = path.join(sessionDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  const meta = {
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: path.join(root, "project"),
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            depth: 1,
            agent_nickname: "Bohr",
            agent_role: "worker",
          },
        },
      },
    },
  };
  await fs.writeFile(
    sessionPath,
    `${JSON.stringify(meta)}\n${"x".repeat(2 * 1024 * 1024)}\n`,
  );
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Run worker", updated_at: "2026-01-01T00:00:00Z" })}\n`,
  );
  const oldDate = new Date(Date.now() - 60 * 86_400_000);
  await fs.utimes(sessionPath, oldDate, oldDate);

  const plan = await planCleanup(codexHome, { staleDays: 30, minSizeMb: 1, kind: "sub-agents" });
  assert.equal(plan.actionCount, 1);
  assert.equal(plan.actions[0].reason, "large sub-thread session log");
  assert.equal(plan.actions[0].isSubagent, true);
  assert.equal(plan.actions[0].parentThreadId, parentThreadId);
});

test("recommended rollout cleanup uses archived, sub-agent, and active age rules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-rollout-rules-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "01", "01");
  const archiveDir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });

  const archived = path.join(archiveDir, "rollout-2026-01-01T00-00-00-019d2bdc-8000-7000-9000-000000000001.jsonl");
  const oldSubagent = path.join(sessionDir, "rollout-2026-01-01T00-00-00-019d2bdc-8001-7000-9000-000000000001.jsonl");
  const youngSubagent = path.join(sessionDir, "rollout-2026-01-01T00-00-00-019d2bdc-8002-7000-9000-000000000001.jsonl");
  const oldActive = path.join(sessionDir, "rollout-2026-01-01T00-00-00-019d2bdc-8003-7000-9000-000000000001.jsonl");
  const youngActive = path.join(sessionDir, "rollout-2026-01-01T00-00-00-019d2bdc-8004-7000-9000-000000000001.jsonl");

  await fs.writeFile(archived, `${"x".repeat(2 * 1024 * 1024)}\n`);
  await fs.writeFile(oldSubagent, `${JSON.stringify(subagentMeta("019d2bdc-8001-7000-9000-000000000001"))}\n${"x".repeat(2 * 1024 * 1024)}\n`);
  await fs.writeFile(youngSubagent, `${JSON.stringify(subagentMeta("019d2bdc-8002-7000-9000-000000000001"))}\n${"x".repeat(2 * 1024 * 1024)}\n`);
  await fs.writeFile(oldActive, `${"x".repeat(2 * 1024 * 1024)}\n`);
  await fs.writeFile(youngActive, `${"x".repeat(2 * 1024 * 1024)}\n`);

  const now = Date.now();
  await fs.utimes(archived, new Date(now - 1 * 86_400_000), new Date(now - 1 * 86_400_000));
  await fs.utimes(oldSubagent, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
  await fs.utimes(youngSubagent, new Date(now - 6 * 86_400_000), new Date(now - 6 * 86_400_000));
  await fs.utimes(oldActive, new Date(now - 31 * 86_400_000), new Date(now - 31 * 86_400_000));
  await fs.utimes(youngActive, new Date(now - 29 * 86_400_000), new Date(now - 29 * 86_400_000));

  const plan = await planCleanup(codexHome, { staleDays: 30, subAgentStaleDays: 7, minSizeMb: 1 });
  const sources = new Set(plan.actions.map((action) => action.source));

  assert.equal(plan.actionCount, 3);
  assert.equal(sources.has(archived), true);
  assert.equal(sources.has(oldSubagent), true);
  assert.equal(sources.has(oldActive), true);
  assert.equal(sources.has(youngSubagent), false);
  assert.equal(sources.has(youngActive), false);
});

function subagentMeta(id) {
  return {
    type: "session_meta",
    payload: {
      id,
      cwd: "C:\\project",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "019d2bdc-8999-7000-9000-000000000001",
            depth: 1,
          },
        },
      },
    },
  };
}

test("applyCleanupPlan quarantines files using mirrored Codex folder structure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-apply-"));
  const codexHome = path.join(root, ".codex");
  const archiveDir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(archiveDir, { recursive: true });
  const sessionId = "019d2bdc-5555-7000-9000-000000000001";
  const sessionPath = path.join(archiveDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(sessionPath, `${"x".repeat(2 * 1024 * 1024)}\n`);

  const plan = await planCleanup(codexHome, { kind: "archived", minSizeMb: 1 });
  const result = await applyCleanupPlan(plan);
  const target = path.join(codexHome, "quarantine", "rollouts", "archived_sessions", path.basename(sessionPath));

  assert.equal(result.actionCount, 1);
  assert.equal(result.quarantineRoot, path.join(codexHome, "quarantine", "rollouts"));
  assert.equal(await exists(sessionPath), false);
  assert.equal(await exists(target), true);
});

test("applyCleanupPlan restores quarantined files to mirrored Codex folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-restore-"));
  const codexHome = path.join(root, ".codex");
  const quarantineSessionDir = path.join(codexHome, "quarantine", "rollouts", "sessions", "2026", "01", "01");
  await fs.mkdir(quarantineSessionDir, { recursive: true });
  const fileName = "rollout-2026-01-01T00-00-00-019d2bdc-6666-7000-9000-000000000001.jsonl";
  const quarantinedPath = path.join(quarantineSessionDir, fileName);
  const restoredPath = path.join(codexHome, "sessions", "2026", "01", "01", fileName);
  await fs.writeFile(quarantinedPath, `${"x".repeat(2 * 1024 * 1024)}\n`);

  const plan = await planQuarantineRestore(codexHome);
  const result = await applyCleanupPlan(plan);

  assert.equal(plan.mode, "restore");
  assert.equal(plan.actionCount, 1);
  assert.equal(result.actionCount, 1);
  assert.equal(await exists(quarantinedPath), false);
  assert.equal(await exists(restoredPath), true);
});

test("planQuarantinedCleanup only includes rollout quarantine files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-rollout-trash-"));
  const codexHome = path.join(root, ".codex");
  const rolloutDir = path.join(codexHome, "quarantine", "rollouts", "sessions", "2026", "01", "01");
  const otherDir = path.join(codexHome, "quarantine", "agents");
  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.mkdir(otherDir, { recursive: true });
  const rolloutPath = path.join(rolloutDir, "rollout-2026-01-01T00-00-00-019d2bdc-7777-7000-9000-000000000001.jsonl");
  await fs.writeFile(rolloutPath, `${"x".repeat(2 * 1024 * 1024)}\n`);
  await fs.writeFile(path.join(otherDir, "AGENTS.md"), "project instructions\n");

  const plan = await planQuarantinedCleanup(codexHome);

  assert.equal(plan.actionCount, 1);
  assert.equal(plan.quarantineRoot, path.join(codexHome, "quarantine", "rollouts"));
  assert.equal(plan.actions[0].source, rolloutPath);
});

test("applySkillDisablePlan updates config.toml and restores from backup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-config-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "already-disabled"',
      "enabled = false",
      "",
      "[[skills.config]]",
      'name = "enable-me"',
      "enabled = true",
      "",
    ].join("\n"),
  );

  const plan = await planSkillDisable(codexHome, [
    { skill: "enable-me", registryTokens: 10, totalWasteTokens: 100 },
    { skill: "new-skill", registryTokens: 7, totalWasteTokens: 70 },
    { skill: "already-disabled", registryTokens: 20, totalWasteTokens: 200 },
  ]);
  assert.equal(plan.actionCount, 2);

  const result = await applySkillDisablePlan(plan);
  const updated = await fs.readFile(configPath, "utf8");
  assert.match(updated, /name = "enable-me"\nenabled = false/);
  assert.match(updated, /name = "new-skill"\nenabled = false/);
  assert.equal(await exists(result.backupPath), true);

  await fs.writeFile(
    configPath,
    [
      updated.replace('model = "gpt-5.5"', 'model = "gpt-6"'),
      "",
      '[projects."C:\\\\later-change"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.deepEqual(restorePlan.restoreSkillNames, ["enable-me", "new-skill"]);
  assert.equal(restorePlan.restoredSkillCount, 2);
  assert.deepEqual(restorePlan.restoredSkills, ["enable-me", "new-skill"]);
  assert.equal(restorePlan.disabledSkillCount, 0);
  const restoreResult = await applySkillConfigRestorePlan(restorePlan);
  const restored = await fs.readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-6"/);
  assert.match(restored, /\[projects\."C:\\\\later-change"\]\ntrust_level = "trusted"/);
  assert.match(restored, /name = "enable-me"\nenabled = true/);
  assert.doesNotMatch(restored, /name = "new-skill"/);
  assert.equal(await exists(restoreResult.currentBackup), true);
});

test("applySkillDisablePlan creates config.toml when it is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-config-missing-"));
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");

  const plan = await planSkillDisable(codexHome, [
    { skill: "new-skill", registryTokens: 7, totalWasteTokens: 70 },
  ]);
  const result = await applySkillDisablePlan(plan);
  const updated = await fs.readFile(configPath, "utf8");
  const backup = await fs.readFile(result.backupPath, "utf8");

  assert.equal(plan.actionCount, 1);
  assert.equal(backup, "");
  assert.match(updated, /name = "new-skill"\nenabled = false/);

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.deepEqual(restorePlan.restoredSkills, ["new-skill"]);
  await applySkillConfigRestorePlan(restorePlan);
  const restored = await fs.readFile(configPath, "utf8");
  assert.doesNotMatch(restored, /new-skill/);
});

test("applySkillConfigRestorePlan only reverts skills changed by cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-restore-targeted-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "cleanup-target"',
      "enabled = true",
      "",
      "[[skills.config]]",
      'name = "manual-existing"',
      "enabled = true",
      "",
    ].join("\n"),
  );

  const plan = await planSkillDisable(codexHome, [
    { skill: "cleanup-target", registryTokens: 10, totalWasteTokens: 100 },
    { skill: "generated-target", registryTokens: 7, totalWasteTokens: 70 },
  ]);
  await applySkillDisablePlan(plan);
  const afterCleanup = await fs.readFile(configPath, "utf8");
  await fs.writeFile(
    configPath,
    [
      afterCleanup
        .replace('model = "gpt-5.5"', 'model = "gpt-6"')
        .replace('name = "manual-existing"\nenabled = true', 'name = "manual-existing"\nenabled = false'),
      "",
      "[[skills.config]]",
      'name = "manual-new"',
      "enabled = false",
      "",
    ].join("\n"),
  );

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.deepEqual(restorePlan.restoreSkillNames, ["cleanup-target", "generated-target"]);
  assert.deepEqual(restorePlan.restoredSkills, ["cleanup-target", "generated-target"]);
  assert.deepEqual(restorePlan.disabledSkills, []);

  await applySkillConfigRestorePlan(restorePlan);
  const restored = await fs.readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-6"/);
  assert.match(restored, /name = "cleanup-target"\nenabled = true/);
  assert.doesNotMatch(restored, /name = "generated-target"/);
  assert.match(restored, /name = "manual-existing"\nenabled = false/);
  assert.match(restored, /name = "manual-new"\nenabled = false/);
});

test("applySkillConfigRestorePlan leaves manually re-enabled cleanup skills alone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-restore-manual-reenable-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "skill-a"',
      "enabled = true",
      'note = "keep a"',
      "",
      "[[skills.config]]",
      'name = "skill-b"',
      "enabled = true",
      'note = "keep b"',
      "",
    ].join("\n"),
  );

  const plan = await planSkillDisable(codexHome, [
    { skill: "skill-a", registryTokens: 10, totalWasteTokens: 100 },
    { skill: "skill-b", registryTokens: 7, totalWasteTokens: 70 },
  ]);
  await applySkillDisablePlan(plan);
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "skill-a"',
      "enabled = true",
      'note = "keep a"',
      'manual_change = "after cleanup"',
      "",
      "[[skills.config]]",
      'name = "skill-b"',
      "enabled = false",
      'note = "keep b"',
      "",
    ].join("\n"),
  );
  const manuallyEdited = await fs.readFile(configPath, "utf8");
  assert.match(manuallyEdited, /name = "skill-a"\nenabled = true/);
  assert.match(manuallyEdited, /name = "skill-b"\nenabled = false/);

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.deepEqual(restorePlan.restoreSkillNames, ["skill-a", "skill-b"]);
  assert.deepEqual(restorePlan.restoredSkills, ["skill-b"]);

  await applySkillConfigRestorePlan(restorePlan);
  const restored = await fs.readFile(configPath, "utf8");
  assert.match(restored, /name = "skill-a"\nenabled = true\nnote = "keep a"\nmanual_change = "after cleanup"/);
  assert.match(restored, /name = "skill-b"\nenabled = true\nnote = "keep b"/);
});

test("applySkillConfigRestorePlan can restore a tracked skill back to disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-restore-disabled-"));
  const codexHome = path.join(root, ".codex");
  const backupDir = path.join(codexHome, "backups", "codex-assistant");
  await fs.mkdir(backupDir, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const backupPath = path.join(backupDir, "config-skills-2026-05-29T00-00-00-000Z.toml");
  await fs.writeFile(
    backupPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "tracked-disabled"',
      "enabled = false",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    `${backupPath}.json`,
    JSON.stringify({ kind: "skill-disable", skills: ["tracked-disabled"] }, null, 2),
  );
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-6"',
      "",
      "[[skills.config]]",
      'name = "tracked-disabled"',
      "enabled = true",
      "",
    ].join("\n"),
  );

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.deepEqual(restorePlan.restoredSkills, []);
  assert.deepEqual(restorePlan.disabledSkills, ["tracked-disabled"]);

  await applySkillConfigRestorePlan(restorePlan);
  const restored = await fs.readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-6"/);
  assert.match(restored, /name = "tracked-disabled"\nenabled = false/);
});

test("planSkillConfigRestore ignores before-restore backups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-restore-backup-kind-"));
  const codexHome = path.join(root, ".codex");
  const backupDir = path.join(codexHome, "backups", "codex-assistant");
  await fs.mkdir(backupDir, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const skillBackupPath = path.join(backupDir, "config-skills-2026-05-29T00-00-00-000Z.toml");
  const restoreBackupPath = path.join(backupDir, "config-before-restore-2026-05-29T00-01-00-000Z.toml");

  await fs.writeFile(
    skillBackupPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "from-skill-cleanup"',
      "enabled = true",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    `${skillBackupPath}.json`,
    JSON.stringify({ kind: "skill-disable", skills: ["from-skill-cleanup"] }, null, 2),
  );
  await fs.writeFile(
    restoreBackupPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "from-before-restore"',
      "enabled = false",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    `${restoreBackupPath}.json`,
    JSON.stringify({ kind: "skill-restore", skills: ["from-before-restore"] }, null, 2),
  );
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-6"',
      "",
      "[[skills.config]]",
      'name = "from-skill-cleanup"',
      "enabled = false",
      "",
      "[[skills.config]]",
      'name = "from-before-restore"',
      "enabled = true",
      "",
    ].join("\n"),
  );
  const newer = new Date(Date.now() + 1000);
  await fs.utimes(restoreBackupPath, newer, newer);

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.equal(restorePlan.backupPath, skillBackupPath);
  assert.deepEqual(restorePlan.restoredSkills, ["from-skill-cleanup"]);
  assert.deepEqual(restorePlan.disabledSkills, []);
});

test("planSkillConfigRestore accepts legacy config-skills backups without metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-restore-legacy-backup-"));
  const codexHome = path.join(root, ".codex");
  const backupDir = path.join(codexHome, "backups", "codex-assistant");
  await fs.mkdir(backupDir, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const skillBackupPath = path.join(backupDir, "config-skills-2026-05-29T00-00-00-000Z.toml");
  await fs.writeFile(
    skillBackupPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      'name = "legacy-skill"',
      "enabled = true",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-6"',
      "",
      "[[skills.config]]",
      'name = "legacy-skill"',
      "enabled = false",
      "",
    ].join("\n"),
  );

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.equal(restorePlan.backupPath, skillBackupPath);
  assert.equal(restorePlan.restoreSkillNames, null);
  assert.deepEqual(restorePlan.restoredSkills, ["legacy-skill"]);
});

test("applySkillConfigRestorePlan restores implicit skill config entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-restore-implicit-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      "# keep this comment",
      'name = "implicit-skill"',
      'note = "preserve me"',
      "",
    ].join("\n"),
  );

  const plan = await planSkillDisable(codexHome, [
    { skill: "implicit-skill", registryTokens: 10, totalWasteTokens: 100 },
  ]);
  await applySkillDisablePlan(plan);
  const disabled = await fs.readFile(configPath, "utf8");
  assert.match(disabled, /name = "implicit-skill"[\s\S]*enabled = false/);

  const restorePlan = await planSkillConfigRestore(codexHome);
  assert.deepEqual(restorePlan.restoredSkills, ["implicit-skill"]);
  await applySkillConfigRestorePlan(restorePlan);
  const restored = await fs.readFile(configPath, "utf8");
  const implicitBlock = restored.match(/\[\[skills\.config\]\][\s\S]*?name = "implicit-skill"[\s\S]*?(?=\n\[\[|\n\[|$)/)?.[0] || "";
  assert.match(implicitBlock, /# keep this comment/);
  assert.match(implicitBlock, /note = "preserve me"/);
  assert.doesNotMatch(implicitBlock, /enabled =/);
});

test("applySkillDisablePlan preserves unrelated TOML while updating skill entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-toml-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]]",
      "# keep this comment",
      'name = "quoted-\\"skill"',
      "enabled = true",
      'note = "keep me"',
      "",
      '[projects."C:\\\\repo"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );

  const plan = await planSkillDisable(codexHome, [
    { skill: 'quoted-"skill', registryTokens: 10, totalWasteTokens: 100 },
    { skill: "new\\skill", registryTokens: 7, totalWasteTokens: 70 },
  ]);
  const result = await applySkillDisablePlan(plan);
  const updated = await fs.readFile(configPath, "utf8");

  assert.equal(result.actionCount, 2);
  assert.match(updated, /# keep this comment/);
  assert.match(updated, /note = "keep me"/);
  assert.match(updated, /\[projects\."C:\\\\repo"\]\ntrust_level = "trusted"/);
  assert.match(updated, /name = "quoted-\\"skill"[\s\S]*enabled = false/);
  assert.match(updated, /name = "new\\\\skill"\nenabled = false/);
});

test("applySkillDisablePlan handles inline comments around skill config fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-skill-inline-comments-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.5"',
      "",
      "[[skills.config]] # user comment",
      'name = "inline-skill" # keep matching despite comment',
      "enabled = true # previous state",
      'note = "value # not a comment"',
      "",
      "[mcp_servers.example]",
      'command = "node"',
      "",
    ].join("\n"),
  );

  const plan = await planSkillDisable(codexHome, [
    { skill: "inline-skill", registryTokens: 10, totalWasteTokens: 100 },
  ]);
  assert.equal(plan.actionCount, 1);
  await applySkillDisablePlan(plan);
  const updated = await fs.readFile(configPath, "utf8");
  assert.match(updated, /\[\[skills\.config\]\] # user comment/);
  assert.match(updated, /name = "inline-skill" # keep matching despite comment/);
  assert.match(updated, /enabled = false/);
  assert.match(updated, /note = "value # not a comment"/);
  assert.match(updated, /\[mcp_servers\.example\]\ncommand = "node"/);
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
