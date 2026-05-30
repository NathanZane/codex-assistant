import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnalysisCache } from "../src/lib/cache.js";
import { analyzeSessionFile, listSessionFiles } from "../src/lib/session.js";

test("analyzeSessionFile extracts token-safe bloat signals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-session-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "26");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "019d2bdc-0000-7000-9000-000000000001";
  const sessionPath = path.join(sessionDir, `rollout-2026-05-26T10-00-00-${sessionId}.jsonl`);
  const dynamicTool = {
    namespace: "shell",
    name: "exec",
    parameters: { properties: { cmd: { description: "x".repeat(2000) } } },
  };
  const lines = [
    {
      type: "session_meta",
      timestamp: "2026-05-26T10:00:00Z",
      payload: {
        id: sessionId,
        cwd: root,
        base_instructions: {
          text: "<skills_instructions>\n- demo: Trigger text. (file: C:/Users/Natale/.codex/skills/demo/SKILL.md)\n</skills_instructions>",
        },
        dynamic_tools: [dynamicTool],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: "A".repeat(8000),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ text: "summary" }],
        replacement_history: [{ old: "B".repeat(4000) }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-26T10:01:00Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 },
          total_token_usage: { input_tokens: 1000 },
          model_context_window: 2000,
        },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-26T10:02:00Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 0 },
          total_token_usage: { input_tokens: 1200 },
          model_context_window: 2000,
        },
      },
    },
  ];
  await fs.writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const listed = await listSessionFiles(codexHome);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, sessionId);

  const analysis = await analyzeSessionFile(sessionPath);
  assert.equal(analysis.sessionMeta.cwd, root);
  assert.equal(analysis.dynamicTools.count, 1);
  assert.equal(analysis.skillRegistry.entries[0].skill, "demo");
  assert.equal(analysis.tokenUsage.events, 2);
  assert.equal(analysis.compaction.drops.length, 1);
  assert.ok(analysis.compaction.replacementHistoryTokens > 0);
  assert.ok(analysis.topBlocks.some((block) => block.kind === "tool_output"));
  assert.equal(Object.hasOwn(analysis.topBlocks[0], "text"), false);
});

test("listSessionFiles caches session metadata per JSONL file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-assistant-session-cache-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "26");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionId = "019d2bdc-0000-7000-9000-000000000002";
  const sessionPath = path.join(sessionDir, `rollout-2026-05-26T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-05-26T10:00:00Z",
      payload: { id: sessionId, cwd: root },
    })}\n`,
  );

  const firstCache = new AnalysisCache(codexHome);
  const first = await listSessionFiles(codexHome, { includeMeta: true, cache: firstCache });
  assert.equal(first[0].cwd, root);
  assert.equal(firstCache.stats.misses, 1);
  assert.equal(firstCache.stats.writes, 1);
  await firstCache.save();
  await fs.appendFile(sessionPath, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "later" } })}\n`);

  const secondCache = new AnalysisCache(codexHome);
  await secondCache.load();
  const second = await listSessionFiles(codexHome, { includeMeta: true, cache: secondCache });
  assert.equal(second[0].cwd, root);
  assert.equal(secondCache.stats.hits, 1);
  assert.equal(secondCache.stats.reusedGrowing, 1);
  assert.equal(secondCache.stats.misses, 0);
});
