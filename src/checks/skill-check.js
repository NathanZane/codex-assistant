import fs from "node:fs";
import readline from "node:readline";
import { attachSkillUsageEvidence, createSkillUsageEvidenceReader, scanSkillRegistry, summarizeSkillRegistry } from "../lib/skills.js";
import { listSessionFiles, sortRecentSessions } from "../lib/session.js";
import { formatInteger, measure, printIndentedLine, printSectionTitle, printTable } from "../lib/format.js";
import { readSkillConfigState } from "../lib/skill-config.js";

export async function runSkillCheck(codexHome, options = {}) {
  const days = options.allTime || options.days === "all" ? null : Number(options.days || 30);
  const threadFilter = options.thread ? String(options.thread).toLowerCase() : null;
  const allSessions = await listSessionFiles(codexHome, { includeArchived: true });
  let scopedSessions = allSessions.filter((file) => {
    if (days != null && (file.ageDays == null || file.ageDays > days)) {
      return false;
    }
    if (!threadFilter) {
      return true;
    }
    return (
      file.sessionId?.toLowerCase().includes(threadFilter) ||
      file.threadName?.toLowerCase().includes(threadFilter)
    );
  });

  const sessionLimit = options.sessionsLimit || options.sessionLimit;
  scopedSessions = sortRecentSessions(scopedSessions, sessionLimit || scopedSessions.length || 1);

  const allSkills = await scanSkillRegistry(codexHome);
  const skillConfig = await readSkillConfigState(codexHome);
  const activeRegistry = await readActiveSkillRegistry(allSessions, options.cache);
  const resolvedSkills = activeRegistry.entries.length ? resolveActiveSkills(allSkills, activeRegistry.entries) : dedupeSkills(allSkills);
  const disabledSkills = resolvedSkills.filter((skill) => skillConfig.disabled.has(skill.fullName));
  const skills = resolvedSkills.filter((skill) => !skillConfig.disabled.has(skill.fullName));
  await attachSkillUsageEvidence(skills, codexHome, {
    sessionFiles: scopedSessions,
    cache: options.cache,
    lookupSkills: allSkills,
  });
  const ingestionStats = await collectSkillIngestionStats(scopedSessions, options.cache, skills, allSkills);
  const summary = summarizeSkillRegistry(skills);
  const unused = skills.filter((skill) => skill.usage.evidence === 0).sort((a, b) => (b.registryTokens || 0) - (a.registryTokens || 0));
  const used = skills.filter((skill) => skill.usage.evidence > 0);
  const skillItems = [...skills]
    .map((skill) => {
      const stats = ingestionStats.get(skill.fullName) || { ingestions: 0, tokens: 0, wasteTokens: 0 };
      return {
        skill,
        ingestionCount: stats.ingestions,
        totalIngestedTokens: stats.tokens,
        totalWasteTokens: stats.wasteTokens,
      };
    });
  const reviewCandidates = skillItems
    .filter((item) => item.totalWasteTokens > 0)
    .sort(
      (a, b) =>
        b.totalWasteTokens - a.totalWasteTokens ||
        (b.skill.registryTokens || 0) - (a.skill.registryTokens || 0) ||
        a.skill.usage.evidence - b.skill.usage.evidence ||
        b.skill.tokens - a.skill.tokens,
    );
  const potentialStartupSavings = unused.reduce((sum, skill) => sum + (skill.registryTokens || 0), 0);
  const historicalSavings = [...ingestionStats.values()].reduce((sum, stats) => sum + stats.wasteTokens, 0);

  return {
    id: "skills",
    title: "Skill Check",
    codexHome,
    scope: {
      days,
      allTime: days == null,
      thread: options.thread || null,
      sessionsScanned: scopedSessions.length,
    },
    installedSkills: skills.length,
    skillFilesOnDisk: allSkills.length,
    disabledSkills: disabledSkills.length,
    activeRegistrySource: activeRegistry.source,
    usedSkills: used.length,
    unusedSkills: unused.length,
    totalRegistryTokens: summary.totalRegistryTokens,
    totalSkillBodyTokens: summary.totalTokens,
    potentialStartupSavings,
    historicalSavings,
    candidates: reviewCandidates.slice(0, Number(options.candidates || options.limit || 12)).map(toSkillCandidate),
    neverUsedCandidates: skillItems
      .filter((item) => item.skill.usage.evidence === 0)
      .sort((a, b) =>
        b.totalWasteTokens - a.totalWasteTokens ||
        (b.skill.registryTokens || 0) - (a.skill.registryTokens || 0) ||
        b.skill.tokens - a.skill.tokens,
      )
      .map(toSkillCandidate),
  };
}

export function printSkillCheck(report, options = {}) {
  const scope = report.scope.allTime ? "all known session history" : `the last ${report.scope.days} days`;
  const thread = report.scope.thread ? ` matching "${report.scope.thread}"` : "";
  const candidates = options.candidates || report.candidates;
  if (options.title !== false) {
    printSectionTitle("Skill Check");
  }
  printIndentedLine(`Scanned ${formatInteger(report.scope.sessionsScanned)}${thread} sessions from ${scope}.`);
  const notes = [];
  if (report.skillFilesOnDisk !== report.installedSkills) {
    notes.push(`${report.skillFilesOnDisk} SKILL.md files on disk`);
  }
  if (report.disabledSkills) {
    notes.push(`${formatInteger(report.disabledSkills)} disabled in config`);
  }
  const contextNote = notes.length ? ` (${notes.join(", ")})` : "";
  printIndentedLine(
    `${report.unusedSkills} of ${report.installedSkills} enabled injected skills${contextNote} had no explicit usage evidence ` +
      `(no SKILL.md tool-call read and no $skill mention).`,
  );
  printIndentedLine(
    `Estimated saving if those unused skills were disabled from startup injection: ` +
      `${formatInteger(report.potentialStartupSavings)} startup tokens per thread.`,
  );
  console.log("");

  if (candidates.length) {
    if (options.tableTitle !== false) {
      printIndentedLine(options.tableTitle || "Top skills to consider disabling or moving to project-local scope", { styles: ["bold"] });
    }
    printTable(candidates, [
      { key: "skill", label: "Skill", maxWidth: 36 },
      { key: "registryTokens", label: "Tokens each", align: "right", format: formatInteger },
      { key: "includedCount", label: "Includes", align: "right", format: formatInteger },
      { key: "totalWasteTokens", label: "Total waste", align: "right", format: formatInteger },
      { key: "firstSeenAt", label: "First used", maxWidth: 10, format: formatDayOrNever },
      { key: "lastSeenAt", label: "Last used", maxWidth: 10, format: formatDayOrNever },
      { key: "totalUsed", label: "Total used", align: "right", format: formatInteger },
    ]);
    if (options.footer !== false) {
      console.log("");
      printIndentedLine("To disable unused skills, run `codex-assistant cleanup skills`.");
    }
  } else if (report.installedSkills) {
    printIndentedLine("No enabled skills with cleanup candidates found in this scope.");
  } else {
    printIndentedLine("No enabled injected skills found in this scope.");
  }
}

async function readActiveSkillRegistry(sessionFiles, cache) {
  const latest = sortRecentSessions(sessionFiles.filter((file) => !file.archived), 1)[0];
  if (!latest) {
    return { source: null, entries: [] };
  }
  const compute = async () => {
    return {
      source: latest.path,
      entries: await readSkillRegistryEntries(latest.path),
    };
  };
  return cache ? cache.getOrCompute("active-skill-registry", latest.path, compute, { reuseIfGrowing: true }) : compute();
}

async function collectSkillIngestionStats(sessionFiles, cache, skills, lookupSkills = skills) {
  const stats = new Map();
  const includedSkills = new Set(skills.map((skill) => skill.fullName));
  const readUsageEvidence = createSkillUsageEvidenceReader(lookupSkills, cache);
  for (const file of sessionFiles) {
    const registry = await readSessionSkillRegistry(file.path, cache);
    const usageEvidence = await readUsageEvidence(file.path);
    const usedInSession = new Set(usageEvidence.map((evidence) => evidence.fullName));
    for (const entry of registry.entries) {
      if (!includedSkills.has(entry.skill)) {
        continue;
      }
      const current = stats.get(entry.skill) || { ingestions: 0, tokens: 0, usedIngestions: 0, wasteTokens: 0 };
      current.ingestions += 1;
      current.tokens += entry.tokens || 0;
      if (usedInSession.has(entry.skill)) {
        current.usedIngestions += 1;
      } else {
        current.wasteTokens += entry.tokens || 0;
      }
      stats.set(entry.skill, current);
    }
  }
  return stats;
}

async function readSessionSkillRegistry(sessionPath, cache) {
  const compute = async () => {
    const entries = await readSkillRegistryEntries(sessionPath);
    return {
      entries: entries.map((entry) => ({
        skill: entry.skill,
        tokens: entry.tokens,
      })),
    };
  };
  return cache ? cache.getOrCompute("session-skill-registry-v1", sessionPath, compute, { reuseIfGrowing: true }) : compute();
}

async function readSkillRegistryEntries(filePath, options = {}) {
  const maxLines = Number(options.maxLines || 250);
  const maxChars = Number(options.maxChars || 2_000_000);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const entries = [];
  let lineNo = 0;
  let charsRead = 0;

  try {
    for await (const line of rl) {
      lineNo += 1;
      charsRead += line.length;
      if (line.trim()) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          record = null;
        }
        if (record) {
          entries.push(...extractSkillRegistryEntries(record, lineNo));
          if (entries.length) {
            break;
          }
        }
      }
      if (lineNo >= maxLines || charsRead >= maxChars) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return entries;
}

function extractSkillRegistryEntries(record, lineNo) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (record.type === "session_meta") {
    const text = payload.base_instructions?.text;
    return typeof text === "string" ? parseSkillRegistryEntries(text, lineNo) : [];
  }

  if (record.type === "response_item" && payload.type === "message" && (payload.role === "developer" || payload.role === "system")) {
    return parseSkillRegistryEntries(messageText(payload), lineNo);
  }

  return [];
}

function parseSkillRegistryEntries(text, lineNo) {
  const entries = [];
  const entryPattern = /^- ([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?): .+\(file: ([^)]+)\)$/gm;
  let match;
  while ((match = entryPattern.exec(text))) {
    const line = match[0];
    entries.push({
      skill: match[1],
      file: match[2],
      line: lineNo,
      tokens: measure(line).tokens,
    });
  }
  return entries;
}

function messageText(payload) {
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function resolveActiveSkills(allSkills, activeEntries) {
  const byName = new Map();
  const byPath = new Map();
  for (const skill of allSkills) {
    const current = byName.get(skill.fullName);
    if (!current || new Date(skill.modifiedAt) > new Date(current.modifiedAt)) {
      byName.set(skill.fullName, skill);
    }
    byPath.set(normalizePath(skill.path), skill);
  }

  const resolved = [];
  const seen = new Set();
  for (const entry of activeEntries) {
    const match = byPath.get(normalizePath(entry.file)) || byName.get(entry.skill);
    if (!match || seen.has(entry.skill)) {
      continue;
    }
    seen.add(entry.skill);
    resolved.push({
      ...match,
      fullName: entry.skill,
      registryTokens: entry.tokens,
    });
  }
  return resolved.sort((a, b) => b.tokens - a.tokens);
}

function dedupeSkills(skills) {
  const byName = new Map();
  for (const skill of skills) {
    const current = byName.get(skill.fullName);
    if (!current || new Date(skill.modifiedAt) > new Date(current.modifiedAt)) {
      byName.set(skill.fullName, skill);
    }
  }
  return [...byName.values()].sort((a, b) => b.tokens - a.tokens);
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function formatDayOrNever(value) {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value).slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function toSkillCandidate(item) {
  return {
    skill: item.skill.fullName,
    registryTokens: item.skill.registryTokens || 0,
    totalWasteTokens: item.totalWasteTokens,
    includedCount: item.ingestionCount,
    firstSeenAt: item.skill.usage.firstSeenAt,
    lastSeenAt: item.skill.usage.lastSeenAt,
    totalUsed: item.skill.usage.evidence,
    createdAt: item.skill.createdAt,
    createdAgeDays: item.skill.createdAgeDays,
    modifiedAt: item.skill.modifiedAt,
    ageDays: item.skill.ageDays,
  };
}
