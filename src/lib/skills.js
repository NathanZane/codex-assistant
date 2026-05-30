import os from "node:os";
import path from "node:path";
import { codexPaths } from "./paths.js";
import { pathExists, readJsonl, readTextSafe, statSafe, walkFiles } from "./fs.js";
import { daysSince, estimateTokens, formatDate, hashText, measure } from "./format.js";
import { listSessionFiles, sortRecentSessions } from "./session.js";

export async function scanSkillRegistry(codexHome, options = {}) {
  const paths = codexPaths(codexHome);
  const roots = [
    { root: paths.skills, source: "codex-skill" },
    { root: paths.pluginCache, source: "plugin-cache" },
  ];

  if (options.includeAgentSkills !== false) {
    roots.push({ root: path.join(os.homedir(), ".agents", "skills"), source: "agent-skill" });
  }

  const skills = [];
  for (const rootInfo of roots) {
    for await (const filePath of walkFiles(rootInfo.root, { match: (_fullPath, name) => name === "SKILL.md" })) {
      const stat = await statSafe(filePath);
      const text = await readTextSafe(filePath, options.maxSkillBytes || 2_000_000);
      if (!stat || text == null) {
        continue;
      }
      const frontMatter = parseFrontMatter(text);
      const plugin = inferPluginName(filePath, codexHome);
      const name = frontMatter.name || path.basename(path.dirname(filePath));
      const fullName = plugin ? `${plugin}:${name}` : name;
      const measured = measure(text);
      const registryEntry = `- ${fullName}: ${frontMatter.description || ""} (file: ${filePath})`;
      skills.push({
        name,
        fullName,
        plugin,
        source: inferSource(filePath, rootInfo.source),
        path: filePath,
        description: frontMatter.description || "",
        registryTokens: estimateTokens(registryEntry),
        bytes: stat.size,
        chars: measured.chars,
        tokens: measured.tokens,
        sha256: measured.sha256,
        modifiedAt: formatDate(stat.mtime),
        createdAt: formatDate(stat.birthtime),
        ageDays: daysSince(stat.mtime),
        createdAgeDays: daysSince(stat.birthtime),
        usage: {
          sessions: 0,
          evidence: 0,
          explicitReads: 0,
          mentions: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          lastSession: null,
        },
      });
    }
  }

  skills.sort((a, b) => b.tokens - a.tokens);
  return skills;
}

export async function attachSkillUsageEvidence(skills, codexHome, options = {}) {
  if (!skills.length) {
    return skills;
  }
  for (const skill of skills) {
    skill.usage = {
      sessions: 0,
      evidence: 0,
      explicitReads: 0,
      mentions: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastSession: null,
    };
  }

  const sessionFiles = options.sessionFiles
    ? options.sessionFiles
    : sortRecentSessions(await listSessionFiles(codexHome, { includeArchived: false }), options.sessionsLimit || 50);
  const byName = new Map(skills.map((skill) => [skill.fullName, skill]));
  const readSessionEvidence = createSkillUsageEvidenceReader(options.lookupSkills || skills, options.cache);

  for (const file of sessionFiles) {
    const sessionEvidence = await readSessionEvidence(file.path);

    for (const evidence of sessionEvidence) {
      const skill = byName.get(evidence.fullName);
      if (!skill) {
        continue;
      }
      skill.usage.evidence += evidence.evidence;
      skill.usage.explicitReads += evidence.explicitReads;
      skill.usage.mentions += evidence.mentions;
      skill.usage.sessions += 1;
      if (!skill.usage.firstSeenAt || file.mtime < new Date(skill.usage.firstSeenAt)) {
        skill.usage.firstSeenAt = formatDate(file.mtime);
      }
      if (!skill.usage.lastSeenAt || file.mtime > new Date(skill.usage.lastSeenAt)) {
        skill.usage.lastSeenAt = formatDate(file.mtime);
        skill.usage.lastSession = file.sessionId;
      }
    }
  }

  return skills;
}

export function createSkillUsageEvidenceReader(skills, cache) {
  const lookup = buildSkillUsageLookup(skills);
  const namespace = `skill-usage-v2:${hashText(lookup.map((item) => `${item.skill.fullName}:${item.skill.path}`).join("|"))}`;
  return async (filePath) => {
    if (cache) {
      return cache.getOrCompute(namespace, filePath, () => scanSkillUsageInSession(filePath, lookup));
    }
    return scanSkillUsageInSession(filePath, lookup);
  };
}

function buildSkillUsageLookup(skills) {
  return skills.map((skill) => ({
    skill,
    fullLower: skill.fullName.toLowerCase(),
    nameLower: skill.name.toLowerCase(),
    pluginLower: skill.plugin ? skill.plugin.toLowerCase() : null,
    pathLower: normalizeSearchText(skill.path),
    basenameLower: path.basename(path.dirname(skill.path)).toLowerCase(),
  }));
}

async function scanSkillUsageInSession(filePath, lookup) {
  const evidenceBySkill = new Map();
  await readJsonl(filePath, (record) => {
      const usageText = extractUsageSearchText(record);
      if (!usageText.text) {
        return;
      }
      const line = normalizeSearchText(usageText.text);
      for (const item of lookup) {
        const hasPath = usageText.allowPath && line.includes(item.pathLower);
        const hasDollarMention = usageText.allowMention && (line.includes(`$${item.fullLower}`) || line.includes(`$${item.nameLower}`));
        const hasNamedMention = usageText.allowMention && (line.includes(`skill ${item.fullLower}`) || line.includes(`skill ${item.nameLower}`));
        const hasPluginToolCall = usageText.allowToolCall && isPluginToolCallEvidence(line, item);
        const hasSkillOpen = hasPath && line.includes("skill.md");
        if (!hasPath && !hasDollarMention && !hasNamedMention && !hasPluginToolCall) {
          continue;
        }

        const evidence = evidenceBySkill.get(item.skill.fullName) || {
          fullName: item.skill.fullName,
          evidence: 0,
          explicitReads: 0,
          mentions: 0,
        };
        evidence.evidence += 1;
        if (hasSkillOpen) {
          evidence.explicitReads += 1;
        }
        if (hasDollarMention || hasNamedMention) {
          evidence.mentions += 1;
        }
        evidenceBySkill.set(item.skill.fullName, evidence);
      }
    });
  return [...evidenceBySkill.values()];
}

function normalizeSearchText(value) {
  return String(value).toLowerCase().replace(/[\\/]+/g, "/");
}

function extractUsageSearchText(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") {
    return { text: "", allowPath: false, allowMention: false };
  }

  if (payload.type === "function_call") {
    return {
      text: `${payload.name || ""}\n${payload.arguments || ""}`,
      allowPath: true,
      allowMention: false,
      allowToolCall: true,
    };
  }

  if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    return {
      text: messageText(payload),
      allowPath: false,
      allowMention: true,
      allowToolCall: false,
    };
  }

  if ((payload.type === "user_message" || payload.type === "agent_message") && typeof payload.message === "string") {
    return {
      text: payload.message,
      allowPath: false,
      allowMention: true,
      allowToolCall: false,
    };
  }

  return { text: "", allowPath: false, allowMention: false, allowToolCall: false };
}

function isPluginToolCallEvidence(line, item) {
  if (!item.pluginLower) {
    return false;
  }
  const generalPluginSkill = item.skill.name.toLowerCase() === item.pluginLower || item.fullLower === `${item.pluginLower}:${item.pluginLower}`;
  if (!generalPluginSkill) {
    return false;
  }
  return line.includes(`mcp__codex_apps__${item.pluginLower}`) ||
    line.includes(`codex_apps__${item.pluginLower}`) ||
    line.includes(`${item.pluginLower}__`) ||
    line.includes(`${item.pluginLower}.`) ||
    line.includes(`_${item.pluginLower}_`);
}

function messageText(payload) {
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
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

export function summarizeSkillRegistry(skills) {
  const bySource = new Map();
  const byPlugin = new Map();
  let totalTokens = 0;
  let totalRegistryTokens = 0;
  let totalBytes = 0;

  for (const skill of skills) {
    totalTokens += skill.tokens;
    totalRegistryTokens += skill.registryTokens || 0;
    totalBytes += skill.bytes;
    incrementGroup(bySource, skill.source || "unknown", skill);
    incrementGroup(byPlugin, skill.plugin || "standalone", skill);
  }

  return {
    skills: skills.length,
    totalTokens,
    totalRegistryTokens,
    totalBytes,
    bySource: [...bySource.values()].sort((a, b) => b.tokens - a.tokens),
    byPlugin: [...byPlugin.values()].sort((a, b) => b.tokens - a.tokens),
    largest: [...skills].sort((a, b) => b.tokens - a.tokens).slice(0, 20),
    unused: skills
      .filter((skill) => skill.usage.evidence === 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 20),
    rare: skills
      .filter((skill) => skill.usage.evidence > 0 && skill.usage.sessions <= 1)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 20),
  };
}

function incrementGroup(map, key, skill) {
  const group = map.get(key) || { name: key, skills: 0, bytes: 0, tokens: 0, registryTokens: 0, evidence: 0 };
  group.skills += 1;
  group.bytes += skill.bytes;
  group.tokens += skill.tokens;
  group.registryTokens += skill.registryTokens || 0;
  group.evidence += skill.usage?.evidence || 0;
  map.set(key, group);
}

function parseFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) {
      continue;
    }
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[field[1]] = value;
  }
  return data;
}

function inferPluginName(filePath, codexHome) {
  const normalized = filePath.replaceAll("\\", "/");
  const marker = `${codexHome.replaceAll("\\", "/")}/plugins/cache/`;
  if (!normalized.toLowerCase().startsWith(marker.toLowerCase())) {
    return null;
  }
  const rest = normalized.slice(marker.length).split("/");
  return rest.length >= 2 ? rest[1] : null;
}

function inferSource(filePath, fallback) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/plugins/cache/")) {
    return "plugin-cache";
  }
  if (normalized.includes("/.codex/skills/.system/")) {
    return "system-skill";
  }
  if (normalized.includes("/.codex/skills/")) {
    return "codex-skill";
  }
  if (normalized.includes("/.agents/skills/")) {
    return "agent-skill";
  }
  return fallback;
}

export async function skillRegistryExists(codexHome) {
  const paths = codexPaths(codexHome);
  return (await pathExists(paths.skills)) || (await pathExists(paths.pluginCache));
}

export function estimateInjectedSkillRegistryCost(skills) {
  return estimateTokens(
    skills
      .map((skill) => `- ${skill.fullName}: ${skill.description} (file: ${skill.path})`)
      .join("\n"),
  );
}
