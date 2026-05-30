import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexPaths } from "./paths.js";
import { statSafe, walkFiles } from "./fs.js";

export async function planSkillDisable(codexHome, candidates, options = {}) {
  const existing = await readSkillConfig(codexHome);
  const skills = candidates
    .filter((candidate) => candidate && candidate.skill)
    .filter((candidate) => !existing.disabled.has(candidate.skill))
    .map((candidate) => ({
      skill: candidate.skill,
      totalWasteTokens: candidate.totalWasteTokens || 0,
      registryTokens: candidate.registryTokens || 0,
      includedCount: candidate.includedCount || 0,
      totalUsed: candidate.totalUsed || 0,
      firstSeenAt: candidate.firstSeenAt || null,
      lastSeenAt: candidate.lastSeenAt || null,
    }));

  return {
    mode: "disable-skills",
    codexHome,
    configPath: codexPaths(codexHome).config,
    actionCount: skills.length,
    estimatedStartupTokens: skills.reduce((sum, skill) => sum + skill.registryTokens, 0),
    estimatedWasteTokens: skills.reduce((sum, skill) => sum + skill.totalWasteTokens, 0),
    skills,
  };
}

export async function applySkillDisablePlan(plan) {
  if (!plan.skills.length) {
    return { ...plan, backupPath: null };
  }
  const skillNames = plan.skills.map((skill) => skill.skill);
  const backupPath = await backupConfig(plan.codexHome, "skills", {
    kind: "skill-disable",
    skills: skillNames,
  });
  const original = await readTextOrEmpty(plan.configPath);
  const updated = updateSkillConfigToml(original, skillNames);
  await fsp.writeFile(plan.configPath, updated);
  return {
    ...plan,
    backupPath,
  };
}

export async function planSkillConfigRestore(codexHome) {
  const backup = await latestConfigBackup(codexHome);
  const configPath = codexPaths(codexHome).config;
  const restoreSkillNames = backup?.metadata?.skills || null;
  const summary = backup
    ? await summarizeSkillConfigRestore(configPath, backup.path, restoreSkillNames)
    : emptyRestoreSummary();
  return {
    mode: "restore-skills-config",
    codexHome,
    configPath,
    backupPath: backup?.path || null,
    actionCount: backup ? 1 : 0,
    skillChangeCount: summary.skillChangeCount,
    restoredSkillCount: summary.restoredSkills.length,
    disabledSkillCount: summary.disabledSkills.length,
    restoredSkills: summary.restoredSkills,
    disabledSkills: summary.disabledSkills,
    restoreSkillNames,
  };
}

export async function applySkillConfigRestorePlan(plan) {
  if (!plan.backupPath) {
    return { ...plan, restored: false };
  }
  const changedSkillNames = [
    ...(plan.restoredSkills || []),
    ...(plan.disabledSkills || []),
  ];
  const currentBackup = await backupConfig(plan.codexHome, "before-restore", {
    kind: "skill-restore",
    skills: changedSkillNames,
  });
  const [currentText, backupText] = await Promise.all([
    readTextOrEmpty(plan.configPath),
    readTextOrEmpty(plan.backupPath),
  ]);
  const updated = restoreSkillConfigChanges(currentText, backupText, changedSkillNames);
  await fsp.writeFile(plan.configPath, updated);
  return {
    ...plan,
    restored: true,
    currentBackup,
  };
}

export function openConfigFile(codexHome) {
  const configPath = codexPaths(codexHome).config;
  if (os.platform() === "win32") {
    spawn("explorer.exe", [`/select,${configPath}`], { detached: true, stdio: "ignore" }).unref();
    return configPath;
  }
  if (os.platform() === "darwin") {
    spawn("open", ["-R", configPath], { detached: true, stdio: "ignore" }).unref();
    return configPath;
  }
  spawn("xdg-open", [path.dirname(configPath)], { detached: true, stdio: "ignore" }).unref();
  return configPath;
}

async function readSkillConfig(codexHome) {
  const configPath = codexPaths(codexHome).config;
  let text = "";
  try {
    text = await fsp.readFile(configPath, "utf8");
  } catch {
    return { disabled: new Set(), enabled: new Set(), entries: [] };
  }

  const entries = parseSkillConfigEntries(text);
  return {
    entries,
    disabled: new Set(entries.filter((entry) => entry.enabled === false).map((entry) => entry.name)),
    enabled: new Set(entries.filter((entry) => entry.enabled === true).map((entry) => entry.name)),
  };
}

async function summarizeSkillConfigRestore(configPath, backupPath, skillNames = null) {
  const [currentText, backupText] = await Promise.all([
    readTextOrEmpty(configPath),
    readTextOrEmpty(backupPath),
  ]);
  const current = parseSkillConfigEntries(currentText);
  const backup = parseSkillConfigEntries(backupText);
  const currentDisabled = new Set(current.filter((entry) => entry.enabled === false).map((entry) => entry.name));
  const backupDisabled = new Set(backup.filter((entry) => entry.enabled === false).map((entry) => entry.name));
  const names = skillNames
    ? [...new Set(skillNames)]
    : [...new Set([...currentDisabled, ...backupDisabled])];
  const restoredSkills = names
    .filter((name) => currentDisabled.has(name) && !backupDisabled.has(name))
    .sort((a, b) => a.localeCompare(b));
  const disabledSkills = names
    .filter((name) => backupDisabled.has(name) && !currentDisabled.has(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    skillChangeCount: restoredSkills.length + disabledSkills.length,
    restoredSkills,
    disabledSkills,
  };
}

function emptyRestoreSummary() {
  return {
    skillChangeCount: 0,
    restoredSkills: [],
    disabledSkills: [],
  };
}

async function readTextOrEmpty(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseSkillConfigEntries(text) {
  return parseSkillConfigBlocks(text).map(({ name, enabled }) => ({ name, enabled }));
}

function parseSkillConfigBlocks(text) {
  const entries = [];
  const lines = splitLinesWithOffsets(text);
  const headers = lines
    .map((line, index) => ({
      index,
      start: line.start,
      header: parseTomlHeader(line.text),
    }))
    .filter((line) => line.header);
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (header.header !== "[[skills.config]]") {
      continue;
    }
    const start = header.start;
    const end = headers[index + 1]?.start ?? text.length;
    const block = text.slice(start, end);
    const blockLines = lines.slice(header.index, headers[index + 1]?.index ?? lines.length);
    const fields = parseSkillConfigFields(blockLines);
    if (!fields.name) {
      continue;
    }
    entries.push({
      name: fields.name,
      enabled: fields.enabled,
      start,
      end,
      block,
    });
  }
  return entries;
}

function splitLinesWithOffsets(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    const end = index + 1;
    lines.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), start, end: text.length });
  }
  return lines;
}

function parseTomlHeader(line) {
  const body = stripTomlComment(stripLineEnding(line)).trim();
  if (!body.startsWith("[") || !body.endsWith("]")) {
    return null;
  }
  return body.replace(/\s+/g, "");
}

function parseSkillConfigFields(lines) {
  const fields = { name: null, enabled: null };
  for (const line of lines) {
    const assignment = parseTomlAssignment(line.text);
    if (!assignment) {
      continue;
    }
    if (assignment.key === "name") {
      fields.name = parseTomlStringValue(assignment.value);
    } else if (assignment.key === "enabled") {
      fields.enabled = parseTomlBooleanValue(assignment.value);
    }
  }
  return fields;
}

function parseTomlAssignment(line) {
  const body = stripTomlComment(stripLineEnding(line));
  const eq = findUnquotedEquals(body);
  if (eq === -1) {
    return null;
  }
  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return null;
  }
  return {
    key,
    value: body.slice(eq + 1).trim(),
  };
}

function findUnquotedEquals(text) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "=") {
      return index;
    }
  }
  return -1;
}

function stripTomlComment(text) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "#") {
      return text.slice(0, index);
    }
  }
  return text;
}

function stripLineEnding(line) {
  return String(line).replace(/\r?\n$/, "");
}

function parseTomlStringValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return unescapeTomlString(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return null;
}

function parseTomlBooleanValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return null;
}

function restoreSkillConfigChanges(currentText, backupText, skillNames = null) {
  const currentBlocks = parseSkillConfigBlocks(currentText);
  const backupBlocks = parseSkillConfigBlocks(backupText);
  const currentByName = mapSkillBlocksByName(currentBlocks);
  const backupByName = mapSkillBlocksByName(backupBlocks);
  const currentDisabled = disabledSkillSet(currentBlocks);
  const backupDisabled = disabledSkillSet(backupBlocks);
  const namesToRestore = new Set(skillNames || [
    ...[...currentDisabled].filter((name) => !backupDisabled.has(name)),
    ...[...backupDisabled].filter((name) => !currentDisabled.has(name)),
  ]);

  const edits = [];
  const appends = [];
  for (const name of namesToRestore) {
    const current = currentByName.get(name);
    const backup = backupByName.get(name);
    if (!current && backup?.enabled === false) {
      appends.push(`[[skills.config]]\nname = "${escapeTomlString(name)}"\nenabled = false\n`);
      continue;
    }
    if (!current) {
      continue;
    }

    if (!backup) {
      edits.push({
        start: current.start,
        end: current.end,
        replacement: isSimpleDisabledSkillBlock(current.block) ? "" : setSkillBlockEnabled(current.block, true),
      });
      continue;
    }

    edits.push({
      start: current.start,
      end: current.end,
      replacement: setSkillBlockEnabled(current.block, backup.enabled),
    });
  }

  let updated = currentText;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  }
  if (appends.length) {
    if (updated && !updated.endsWith("\n")) {
      updated += "\n";
    }
    updated += `\n${appends.join("\n")}`;
  }
  return updated;
}

function mapSkillBlocksByName(blocks) {
  const byName = new Map();
  for (const block of blocks) {
    byName.set(block.name, block);
  }
  return byName;
}

function disabledSkillSet(blocks) {
  return new Set(blocks.filter((entry) => entry.enabled === false).map((entry) => entry.name));
}

function isSimpleDisabledSkillBlock(block) {
  const significantLines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return significantLines.length === 3 &&
    significantLines[0] === "[[skills.config]]" &&
    /^name\s*=/.test(significantLines[1]) &&
    /^enabled\s*=\s*false$/.test(significantLines[2]);
}

function setSkillBlockEnabled(block, enabled) {
  const lines = splitLinesWithOffsets(block);
  const currentEnabledLine = lines.find((line) => parseTomlAssignment(line.text)?.key === "enabled");
  const nextEnabledLine = `enabled = ${enabled ? "true" : "false"}`;

  if (enabled == null) {
    if (!currentEnabledLine) {
      return block;
    }
    return block.slice(0, currentEnabledLine.start) + block.slice(currentEnabledLine.end);
  }

  if (currentEnabledLine) {
    const lineEnding = lineEndingFor(currentEnabledLine.text);
    const indent = currentEnabledLine.text.match(/^\s*/)?.[0] || "";
    return block.slice(0, currentEnabledLine.start) +
      `${indent}${nextEnabledLine}${lineEnding}` +
      block.slice(currentEnabledLine.end);
  }
  return block.endsWith("\n") ? `${block}${nextEnabledLine}\n` : `${block}\n${nextEnabledLine}`;
}

function updateSkillConfigToml(text, skillNames) {
  const namesToDisable = new Set(skillNames);
  const seen = new Set();
  const edits = [];
  for (const block of parseSkillConfigBlocks(text)) {
    if (!namesToDisable.has(block.name)) {
      continue;
    }
    seen.add(block.name);
    edits.push({
      start: block.start,
      end: block.end,
      replacement: setSkillBlockEnabled(block.block, false),
    });
  }

  let updated = applyTextEdits(text, edits);

  const missing = [...namesToDisable].filter((name) => !seen.has(name));
  if (missing.length) {
    if (updated && !updated.endsWith("\n")) {
      updated += "\n";
    }
    for (const name of missing) {
      updated += `\n[[skills.config]]\nname = "${escapeTomlString(name)}"\nenabled = false\n`;
    }
  }

  return updated;
}

function applyTextEdits(text, edits) {
  let updated = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  }
  return updated;
}

function lineEndingFor(line) {
  if (line.endsWith("\r\n")) {
    return "\r\n";
  }
  if (line.endsWith("\n")) {
    return "\n";
  }
  return "";
}

async function backupConfig(codexHome, label = "skills", metadata = null) {
  const paths = codexPaths(codexHome);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(paths.codexHome, "backups", "codex-assistant");
  const backupPath = path.join(backupDir, `config-${label}-${stamp}.toml`);
  await fsp.mkdir(backupDir, { recursive: true });
  try {
    await fsp.copyFile(paths.config, backupPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await fsp.writeFile(backupPath, "", "utf8");
  }
  if (metadata) {
    await fsp.writeFile(
      `${backupPath}.json`,
      JSON.stringify({ ...metadata, backupPath, createdAt: new Date().toISOString() }, null, 2),
    );
  }
  return backupPath;
}

async function latestConfigBackup(codexHome) {
  const backupDir = path.join(codexPaths(codexHome).codexHome, "backups", "codex-assistant");
  let latest = null;
  for await (const filePath of walkFiles(backupDir, { match: (_fullPath, name) => /^config-.*\.toml$/.test(name) })) {
    const stat = await statSafe(filePath);
    if (!stat) {
      continue;
    }
    const metadata = await readBackupMetadata(filePath);
    if (!isSkillDisableBackup(filePath, metadata)) {
      continue;
    }
    if (!latest || stat.mtime > latest.mtime) {
      latest = { path: filePath, mtime: stat.mtime, metadata };
    }
  }
  return latest;
}

function isSkillDisableBackup(filePath, metadata) {
  if (metadata) {
    return metadata.kind === "skill-disable";
  }
  return path.basename(filePath).startsWith("config-skills-");
}

async function readBackupMetadata(backupPath) {
  try {
    const metadata = JSON.parse(await fsp.readFile(`${backupPath}.json`, "utf8"));
    if (!Array.isArray(metadata.skills)) {
      return null;
    }
    return {
      ...metadata,
      skills: metadata.skills.filter((skill) => typeof skill === "string"),
    };
  } catch {
    return null;
  }
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeTomlString(value) {
  return String(value).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
