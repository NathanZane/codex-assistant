import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { codexPaths } from "./paths.js";
import { pathExists, readJsonl, statSafe, walkFiles } from "./fs.js";
import { daysSince, formatDate, measure, stableText } from "./format.js";

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export async function readSessionIndex(codexHome) {
  const { sessionIndex } = codexPaths(codexHome);
  const byId = new Map();
  if (!(await pathExists(sessionIndex))) {
    return byId;
  }

  await readJsonl(sessionIndex, (record) => {
    if (!record || typeof record !== "object" || !record.id) {
      return;
    }
    byId.set(String(record.id), {
      id: String(record.id),
      threadName: record.thread_name || "",
      updatedAt: record.updated_at || null,
    });
  });
  return byId;
}

export async function listSessionFiles(codexHome, options = {}) {
  const paths = codexPaths(codexHome);
  const sessionIndex = await readSessionIndex(codexHome);
  const roots = [paths.sessions];
  if (options.includeArchived !== false) {
    roots.push(paths.archivedSessions);
  }

  const files = [];
  const filePaths = [];
  for (const root of roots) {
    for await (const filePath of walkFiles(root, { match: (_fullPath, name) => name.endsWith(".jsonl") })) {
      filePaths.push(filePath);
    }
  }

  for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex += 1) {
    const filePath = filePaths[fileIndex];
    const stat = await statSafe(filePath);
    if (stat) {
      const sessionId = extractSessionId(filePath);
      const indexEntry = sessionId ? sessionIndex.get(sessionId) : null;
      const meta = options.includeMeta ? await readSessionMetaCached(filePath, options.cache) : {};
      const lastActiveAt = indexEntry?.updatedAt || stat.mtime;
      files.push({
        path: filePath,
        relativePath: path.relative(codexHome, filePath),
        sessionId: sessionId || meta.id || null,
        sizeBytes: stat.size,
        mtime: stat.mtime,
        ageDays: daysSince(lastActiveAt),
        fileAgeDays: daysSince(stat.mtime),
        lastActiveAt,
        archived: filePath.startsWith(paths.archivedSessions),
        referenced: Boolean(indexEntry),
        threadName: indexEntry?.threadName || "",
        indexUpdatedAt: indexEntry?.updatedAt || null,
        cwd: meta.cwd || null,
        isSubagent: Boolean(meta.isSubagent),
        parentThreadId: meta.parentThreadId || null,
        subagentDepth: meta.subagentDepth ?? null,
        agentNickname: meta.agentNickname || null,
        agentRole: meta.agentRole || null,
      });
    }
    updateScanProgress(options, fileIndex + 1, filePaths.length);
  }
  if (!filePaths.length) {
    updateScanProgress(options, 0, 0);
  }

  return files;
}

function updateScanProgress(options, current, total) {
  if (!options.progressRow || !options.scanProgressStep) {
    return;
  }
  options.progress?.updateStep(options.progressRow, options.scanProgressStep, current, total, {
    rowLabel: options.progressRowLabel,
    stepLabel: options.scanProgressStepLabel,
  });
}

export function sortRecentSessions(files, limit = 25) {
  return [...files]
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, Number(limit) || 25);
}

export function sortLargestSessions(files, limit = 20) {
  return [...files].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, Number(limit) || 20);
}

export function extractSessionId(filePath) {
  const match = path.basename(filePath).match(SESSION_ID_PATTERN);
  return match ? match[1] : null;
}

export async function readSessionMeta(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "session_meta" || !record.payload || typeof record.payload !== "object") {
        continue;
      }
      const subagentSpawn = record.payload.source?.subagent?.thread_spawn;
      return {
        id: record.payload.id || null,
        forkedFromId: record.payload.forked_from_id || null,
        cwd: record.payload.cwd || null,
        model: record.payload.model || null,
        source: record.payload.source || null,
        isSubagent: Boolean(subagentSpawn),
        parentThreadId: subagentSpawn?.parent_thread_id || null,
        subagentDepth: Number.isFinite(subagentSpawn?.depth) ? subagentSpawn.depth : null,
        agentNickname: record.payload.agent_nickname || subagentSpawn?.agent_nickname || null,
        agentRole: record.payload.agent_role || subagentSpawn?.agent_role || null,
      };
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {};
}

async function readSessionMetaCached(filePath, cache) {
  if (!cache) {
    return readSessionMeta(filePath);
  }
  const cached = await cache.getOrCompute("session-meta-v1", filePath, () => readSessionMeta(filePath), { reuseIfGrowing: true });
  return cached && typeof cached === "object" ? cached : {};
}

export async function analyzeSessionFile(filePath, options = {}) {
  const topLimit = options.topLimit || 25;
  const stat = await statSafe(filePath);
  const summary = {
    path: filePath,
    sessionId: extractSessionId(filePath),
    sizeBytes: stat?.size || 0,
    mtime: stat?.mtime ? formatDate(stat.mtime) : null,
    lineCount: 0,
    parseErrors: 0,
    counters: {},
    sessionMeta: {},
    totalsByKind: {},
    topBlocks: [],
    tokenEvents: [],
    tokenUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      events: 0,
    },
    dynamicTools: {
      count: 0,
      tokens: 0,
      namespaces: {},
      tools: [],
    },
    skillRegistry: {
      entries: [],
      groups: {},
    },
    pluginRegistry: [],
    compaction: {
      replacementHistoryCount: 0,
      replacementHistoryTokens: 0,
      summaryValueCount: 0,
      drops: [],
    },
  };

  let previousTokenEvent = null;

  const result = await readJsonl(filePath, (record, lineNo) => {
    const type = record?.type || "unknown";
    summary.counters[type] = (summary.counters[type] || 0) + 1;
    const payload = record?.payload;

    if (payload && typeof payload === "object") {
      collectCompactionSignals(summary, payload);
    }

    if (type === "session_meta" && payload && typeof payload === "object") {
      collectSessionMeta(summary, payload, lineNo, topLimit);
      return;
    }

    if (type === "turn_context" && payload && typeof payload === "object") {
      for (const [key, value] of Object.entries(payload)) {
        addBlock(summary, {
          kind: "turn_context",
          source: `turn_context.${key}`,
          line: lineNo,
          value,
        }, topLimit);
      }
      return;
    }

    if (type === "response_item" && payload && typeof payload === "object") {
      collectResponseItem(summary, payload, lineNo, topLimit);
      return;
    }

    if (type === "event_msg" && payload && typeof payload === "object") {
      collectEventMessage(summary, payload, record.timestamp, lineNo, previousTokenEvent);
      if (payload.type === "token_count") {
        previousTokenEvent = summary.tokenEvents.at(-1);
      }
    }
  });

  summary.lineCount = result.lineCount;
  summary.parseErrors = result.parseErrors;
  summary.topBlocks.sort((a, b) => b.tokens - a.tokens);
  summary.dynamicTools.tools.sort((a, b) => b.tokens - a.tokens);
  summary.skillRegistry.entries.sort((a, b) => b.tokens - a.tokens);
  return summary;
}

function collectSessionMeta(summary, payload, lineNo, topLimit) {
  summary.sessionMeta = {
    id: payload.id || summary.sessionMeta.id || null,
    cwd: payload.cwd || summary.sessionMeta.cwd || null,
    model: payload.model || summary.sessionMeta.model || null,
  };

  const base = payload.base_instructions;
  if (base && typeof base === "object" && typeof base.text === "string") {
    addBlock(summary, {
      kind: "injected_base_instructions",
      source: "session_meta.base_instructions.text",
      line: lineNo,
      value: base.text,
    }, topLimit);
    addDeveloperBreakdown(summary, "session_meta.base_instructions.text", lineNo, base.text, topLimit);
  }

  if (Array.isArray(payload.dynamic_tools)) {
    const all = measure(payload.dynamic_tools);
    summary.dynamicTools.count = payload.dynamic_tools.length;
    summary.dynamicTools.tokens += all.tokens;
    addBlock(summary, {
      kind: "injected_dynamic_tools",
      source: "session_meta.dynamic_tools.all",
      line: lineNo,
      value: payload.dynamic_tools,
    }, topLimit);

    for (const tool of payload.dynamic_tools) {
      if (!tool || typeof tool !== "object") {
        continue;
      }
      const namespace = String(tool.namespace || "?");
      const name = String(tool.name || "?");
      const measured = measure(tool);
      const namespaceTotals = summary.dynamicTools.namespaces[namespace] || { namespace, tools: 0, tokens: 0, chars: 0 };
      namespaceTotals.tools += 1;
      namespaceTotals.tokens += measured.tokens;
      namespaceTotals.chars += measured.chars;
      summary.dynamicTools.namespaces[namespace] = namespaceTotals;
      summary.dynamicTools.tools.push({ namespace, name, ...measured });
      addBlock(summary, {
        kind: "injected_tool_schema",
        source: `session_meta.dynamic_tools.${namespace}.${name}`,
        line: lineNo,
        value: tool,
      }, topLimit);
    }
  }
}

function collectResponseItem(summary, payload, lineNo, topLimit) {
  const responseType = payload.type || "unknown";
  if (responseType === "function_call_output") {
    addBlock(summary, {
      kind: "tool_output",
      source: `response_item.function_call_output.${payload.call_id || "?"}`,
      line: lineNo,
      value: payload.output || "",
    }, topLimit);
    return;
  }

  if (responseType === "function_call") {
    addBlock(summary, {
      kind: "tool_call",
      source: `response_item.function_call.${payload.name || "?"}`,
      line: lineNo,
      value: payload.arguments || "",
    }, topLimit);
    return;
  }

  if (responseType === "message") {
    const role = payload.role || "unknown";
    const text = messageContentText(payload);
    if (!text) {
      return;
    }
    const kind = role === "developer" || role === "system" ? `injected_${role}_message` : `${role}_message`;
    addBlock(summary, {
      kind,
      source: `response_item.message.${role}`,
      line: lineNo,
      value: text,
    }, topLimit);
    if (role === "developer" || role === "system") {
      addDeveloperBreakdown(summary, `response_item.message.${role}`, lineNo, text, topLimit);
    }
  }
}

function collectEventMessage(summary, payload, timestamp, lineNo, previousTokenEvent) {
  if (payload.type !== "token_count") {
    return;
  }
  const info = payload.info || {};
  const last = info.last_token_usage || {};
  const total = info.total_token_usage || {};
  const input = numberOrNull(last.input_tokens);
  const contextWindow = numberOrNull(info.model_context_window);
  const event = {
    line: lineNo,
    timestamp: timestamp || null,
    inputTokens: input,
    cachedInputTokens: numberOrZero(last.cached_input_tokens),
    outputTokens: numberOrZero(last.output_tokens),
    reasoningOutputTokens: numberOrZero(last.reasoning_output_tokens),
    totalInputTokens: numberOrNull(total.input_tokens),
    contextWindow,
    contextPercent: input && contextWindow ? Math.round((input / contextWindow) * 1000) / 10 : null,
  };
  summary.tokenEvents.push(event);
  summary.tokenUsage.events += 1;
  summary.tokenUsage.inputTokens += event.inputTokens || 0;
  summary.tokenUsage.cachedInputTokens += event.cachedInputTokens || 0;
  summary.tokenUsage.outputTokens += event.outputTokens || 0;
  summary.tokenUsage.reasoningOutputTokens += event.reasoningOutputTokens || 0;

  if (previousTokenEvent?.inputTokens && event.inputTokens && event.inputTokens < previousTokenEvent.inputTokens * 0.7) {
    summary.compaction.drops.push({
      fromLine: previousTokenEvent.line,
      toLine: event.line,
      fromInputTokens: previousTokenEvent.inputTokens,
      toInputTokens: event.inputTokens,
      droppedTokens: previousTokenEvent.inputTokens - event.inputTokens,
    });
  }
}

function collectCompactionSignals(summary, payload) {
  const replacementValues = findKey(payload, "replacement_history");
  if (replacementValues.length) {
    summary.compaction.replacementHistoryCount += replacementValues.length;
    for (const value of replacementValues) {
      summary.compaction.replacementHistoryTokens += measure(value).tokens;
    }
  }

  const summaryValues = findKey(payload, "summary");
  summary.compaction.summaryValueCount += summaryValues.length;
}

function addDeveloperBreakdown(summary, source, lineNo, text, topLimit) {
  const tagPattern = /<([A-Za-z0-9_ -]+)>/g;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(text))) {
    if (match.index > cursor) {
      const freeText = text.slice(cursor, match.index).trim();
      if (freeText) {
        addBlock(summary, {
          kind: "injected_developer_section",
          source: `${source}.free_text`,
          line: lineNo,
          value: freeText,
        }, topLimit);
      }
    }

    const tag = match[1];
    const close = `</${tag}>`;
    const end = text.indexOf(close, tagPattern.lastIndex);
    if (end === -1) {
      cursor = tagPattern.lastIndex;
      continue;
    }

    const section = text.slice(match.index, end + close.length);
    const normalizedTag = tag.replaceAll(" ", "_");
    addBlock(summary, {
      kind: "injected_developer_section",
      source: `${source}.${normalizedTag}`,
      line: lineNo,
      value: section,
    }, topLimit);

    if (tag === "skills_instructions") {
      collectSkillEntries(summary, source, normalizedTag, lineNo, section, topLimit);
    } else if (tag === "plugins_instructions") {
      collectPluginEntries(summary, source, normalizedTag, lineNo, section, topLimit);
    }

    cursor = end + close.length;
    tagPattern.lastIndex = cursor;
  }

  const trailing = text.slice(cursor).trim();
  if (trailing) {
    addBlock(summary, {
      kind: "injected_developer_section",
      source: `${source}.free_text`,
      line: lineNo,
      value: trailing,
    }, topLimit);
  }
}

function collectSkillEntries(summary, source, normalizedTag, lineNo, section, topLimit) {
  const entryPattern = /^- ([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?): .+\(file: .+\)$/gm;
  let match;
  while ((match = entryPattern.exec(section))) {
    const skill = match[1];
    const line = match[0];
    const measured = measure(line);
    const { group, origin, file } = inferSkillOrigin(skill, line);
    const entry = { skill, group, origin, file, line: lineNo, ...measured };
    summary.skillRegistry.entries.push(entry);
    const groupTotals = summary.skillRegistry.groups[group] || { group, skills: 0, tokens: 0, chars: 0, origins: {} };
    groupTotals.skills += 1;
    groupTotals.tokens += measured.tokens;
    groupTotals.chars += measured.chars;
    groupTotals.origins[origin] = (groupTotals.origins[origin] || 0) + 1;
    summary.skillRegistry.groups[group] = groupTotals;
    addBlock(summary, {
      kind: "injected_skill_entry",
      source: `${source}.${normalizedTag}.skill.${skill}`,
      line: lineNo,
      value: line,
    }, topLimit);
  }
}

function collectPluginEntries(summary, source, normalizedTag, lineNo, section, topLimit) {
  const entryPattern = /^- `([^`]+)`: .+$/gm;
  let match;
  while ((match = entryPattern.exec(section))) {
    const plugin = match[1];
    const line = match[0];
    const measured = measure(line);
    summary.pluginRegistry.push({ plugin, line: lineNo, ...measured });
    addBlock(summary, {
      kind: "injected_plugin_entry",
      source: `${source}.${normalizedTag}.plugin.${plugin}`,
      line: lineNo,
      value: line,
    }, topLimit);
  }
}

function addBlock(summary, block, topLimit) {
  const measured = measure(block.value);
  if (!measured.chars) {
    return;
  }
  const item = {
    source: block.source,
    kind: block.kind,
    line: block.line,
    chars: measured.chars,
    tokens: measured.tokens,
    sha256: measured.sha256,
  };

  const totals = summary.totalsByKind[item.kind] || { kind: item.kind, blocks: 0, chars: 0, tokens: 0 };
  totals.blocks += 1;
  totals.chars += item.chars;
  totals.tokens += item.tokens;
  summary.totalsByKind[item.kind] = totals;

  summary.topBlocks.push(item);
  summary.topBlocks.sort((a, b) => b.tokens - a.tokens);
  if (summary.topBlocks.length > topLimit) {
    summary.topBlocks.length = topLimit;
  }
}

function inferSkillOrigin(skillName, text) {
  const group = skillName.includes(":") ? skillName.split(":", 1)[0] : "standalone";
  const pathMatch = text.match(/\(file: ([^)]+)\)/);
  const file = pathMatch ? pathMatch[1] : "";
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  let origin = "unknown";
  if (normalized.includes("/plugins/cache/")) {
    origin = "plugin-cache";
  } else if (normalized.includes("/.codex/skills/.system/")) {
    origin = "system-skill";
  } else if (normalized.includes("/.codex/skills/")) {
    origin = "codex-skill";
  } else if (normalized.includes("/.agents/skills/")) {
    origin = "agent-skill";
  } else if (file) {
    origin = "other-file";
  }
  return { group, origin, file };
}

function messageContentText(payload) {
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stableText(payload);
  }
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (item && typeof item === "object" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function findKey(value, target) {
  const found = [];
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const child of current) {
        if (child && typeof child === "object") {
          stack.push(child);
        }
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === target) {
        found.push(child);
      }
      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return found;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
