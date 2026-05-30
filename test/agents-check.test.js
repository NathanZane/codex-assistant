import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentsCheck } from "../src/checks/agents-check.js";
import { AnalysisCache } from "../src/lib/cache.js";

test("runAgentsCheck reports current AGENTS footprint for active top-level projects only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-agents-"));
  const codexHome = path.join(root, ".codex");
  const project = path.join(root, "project");
  const noAgentsProject = path.join(root, "no-agents-project");
  const unreadProject = path.join(root, "unread-project");
  const otherProject = path.join(root, "other-project");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
  const archiveDir = path.join(codexHome, "archived_sessions", "2026", "05", "27");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(noAgentsProject, { recursive: true });
  await fs.mkdir(unreadProject, { recursive: true });
  await fs.mkdir(otherProject, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(path.join(project, "AGENTS.md"), "Keep instructions focused.\n".repeat(40));
  await fs.writeFile(path.join(unreadProject, "AGENTS.md"), "Current but not observed yet.\n".repeat(20));
  await fs.writeFile(path.join(otherProject, "AGENTS.md"), "Archived project instructions.\n".repeat(200));

  const activeA = "019e7777-1111-7000-9000-000000000001";
  const activeB = "019e7777-2222-7000-9000-000000000001";
  const activeNoAgents = "019e7777-5555-7000-9000-000000000001";
  const activeUnread = "019e7777-6666-7000-9000-000000000001";
  const subagent = "019e7777-3333-7000-9000-000000000001";
  const archived = "019e7777-4444-7000-9000-000000000001";
  await writeSession(path.join(sessionDir, `rollout-2026-05-28T10-00-00-${activeA}.jsonl`), activeA, project, {
    userInstructions: ["Old shorter project guidance.\n".repeat(10), "Second project guidance read.\n".repeat(20)],
  });
  await writeSession(path.join(sessionDir, `rollout-2026-05-28T11-00-00-${activeB}.jsonl`), activeB, project, {
    userInstructions: "New much larger project guidance.\n".repeat(80),
  });
  await writeSession(path.join(sessionDir, `rollout-2026-05-28T11-30-00-${activeNoAgents}.jsonl`), activeNoAgents, noAgentsProject, {
    userInstructions: "Historical instructions for a project without a current AGENTS file.\n".repeat(40),
  });
  await writeSession(path.join(sessionDir, `rollout-2026-05-28T11-45-00-${activeUnread}.jsonl`), activeUnread, unreadProject);
  await writeSession(path.join(sessionDir, `rollout-2026-05-28T12-00-00-${subagent}.jsonl`), subagent, project, {
    source: { subagent: { thread_spawn: { parent_thread_id: activeA, depth: 1 } } },
  });
  await writeSession(path.join(archiveDir, `rollout-2026-05-27T10-00-00-${archived}.jsonl`), archived, otherProject);
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [activeA, activeB, activeNoAgents, activeUnread, subagent, archived]
      .map((id) => JSON.stringify({ id, thread_name: `Thread ${id}`, updated_at: "2026-05-28T12:00:00Z" }))
      .join("\n") + "\n",
  );

  const report = await runAgentsCheck(codexHome);

  assert.equal(report.scope.activeThreads, 4);
  assert.equal(report.scope.activeProjects, 3);
  assert.equal(report.scope.projectsWithAgents, 2);
  assert.equal(report.scope.projectsWithReadFootprint, 1);
  assert.equal(report.projects.length, 1);
  assert.equal(report.projects[0].project, "project");
  assert.equal(report.projects[0].activeThreads, 2);
  assert.ok(report.currentActiveThreadTokens > report.projects[0].currentActiveThreadTokens);
  assert.ok(report.totalReadTokens > report.currentActiveThreadTokens);
  assert.equal(report.readCount, 3);
  assert.equal(report.projects[0].readCount, 3);
  assert.equal("historicalMaxTokens" in report.projects[0], false);
  assert.equal("observedActiveThreadTokens" in report.projects[0], false);
});

test("runAgentsCheck recomputes historical AGENTS reads when a session JSONL grows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-agents-growing-cache-"));
  const codexHome = path.join(root, ".codex");
  const project = path.join(root, "project");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(project, "AGENTS.md"), "Keep instructions focused.\n".repeat(10));

  const sessionId = "019e7777-7777-7000-9000-000000000001";
  const sessionPath = path.join(sessionDir, `rollout-2026-05-28T10-00-00-${sessionId}.jsonl`);
  await writeSession(sessionPath, sessionId, project, {
    userInstructions: "First guidance read.\n".repeat(5),
  });
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Thread", updated_at: "2026-05-28T12:00:00Z" })}\n`,
  );

  const firstCache = new AnalysisCache(codexHome);
  await firstCache.load();
  const first = await runAgentsCheck(codexHome, { cache: firstCache });
  assert.equal(first.readCount, 1);
  await firstCache.save();

  await fs.appendFile(
    sessionPath,
    `${JSON.stringify({ type: "turn_context", payload: { cwd: project, user_instructions: "Second guidance read.\n".repeat(5) } })}\n`,
  );

  const secondCache = new AnalysisCache(codexHome);
  await secondCache.load();
  const second = await runAgentsCheck(codexHome, { cache: secondCache });
  assert.ok(secondCache.stats.misses >= 1);
  assert.equal(second.readCount, 2);
});

async function writeSession(filePath, id, cwd, options = {}) {
  const { userInstructions = "", ...extraPayload } = options;
  const instructionReads = Array.isArray(userInstructions) ? userInstructions : [userInstructions];
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          cwd,
          ...extraPayload,
        },
      }),
      ...instructionReads.map((userInstructions) =>
        JSON.stringify({
          type: "turn_context",
          payload: {
            cwd,
            user_instructions: userInstructions,
          },
        }),
      ),
    ].join("\n") + "\n",
  );
}
