import { spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline/promises";
import { planCleanup, planQuarantinedCleanup, planQuarantineRestore, applyCleanupPlan } from "../lib/cleanup.js";
import { colorText, formatBytes, printIndentedLine, printJson, printSectionTitle, printTable, shortPath, supportsColor } from "../lib/format.js";
import { codexPaths } from "../lib/paths.js";
import { listSessionFiles } from "../lib/session.js";
import { runSkillCleanup } from "./skills.js";

const ROLLOUT_CLEANUP_COMMAND = "codex-assistant cleanup rollouts";

export async function runCleanup(parsed) {
  const [target, ...rest] = parsed.positionals || [];
  if (parsed.options.help || ["help", "--help", "-h"].includes(target)) {
    printCleanupHelp();
    return;
  }

  if (!target && hasTargetSpecificOptions(parsed.options)) {
    throw new Error("cleanup target is required when passing cleanup options. Use `codex-assistant cleanup rollouts ...` or `codex-assistant cleanup skills ...`.");
  }

  if (target) {
    const selection = normalizeCleanupTarget(target);
    if (!selection) {
      throw new Error(`unknown cleanup target ${JSON.stringify(target)}. Run codex-assistant cleanup --help.`);
    }
    if (selection === "rollouts") {
      assertNoExtraArgs(rest, "cleanup rollouts");
      await runRolloutCleanup({ ...parsed, positionals: rest });
      return;
    }
    if (selection === "skills") {
      assertNoExtraArgs(rest, "cleanup skills");
      await runSkillCleanup({ ...parsed, positionals: rest });
      return;
    }
  }

  const selection = await promptCleanupTargetIfInteractive();
  if (!selection) {
    if (parsed.options.json) {
      printJson({
        command: "cleanup",
        targets: [
          { name: "rollouts", description: "Quarantine, trash, restore, or manually inspect stale rollout JSONL files." },
          { name: "skills", description: "Disable unused/rarely used skills in config.toml, with a backup first." },
        ],
      });
      return;
    }
    printCleanupHelp();
    return;
  }

  if (selection === "rollouts") {
    assertNoExtraArgs(rest, "cleanup rollouts");
    await runRolloutCleanup({ ...parsed, positionals: rest });
    return;
  }

  if (selection === "skills") {
    assertNoExtraArgs(rest, "cleanup skills");
    await runSkillCleanup({ ...parsed, positionals: rest });
    return;
  }
}

export async function runRolloutCleanup({ options }) {
  const staleDays = Number(options.staleDays ?? 30);
  const subAgentStaleDays = Number(options.subAgentStaleDays ?? 7);
  const archivedStaleDays = Number(options.archivedStaleDays ?? 3);
  const minSizeMb = Number(options.minSizeMb ?? 0);
  const interactive = Boolean(process.stdin.isTTY);
  const sessionFiles = await listSessionFiles(options.codexHome, { includeArchived: true, includeMeta: true });
  const plans = {
    archived: await planCleanup(options.codexHome, { staleDays, subAgentStaleDays, archivedStaleDays, minSizeMb, kind: "archived", sessionFiles }),
    "sub-agents": await planCleanup(options.codexHome, { staleDays, subAgentStaleDays, archivedStaleDays, minSizeMb, kind: "sub-agents", sessionFiles }),
    "active-older": await planCleanup(options.codexHome, { staleDays, subAgentStaleDays, archivedStaleDays, minSizeMb, kind: "active-older", sessionFiles }),
    recommended: await planCleanup(options.codexHome, { staleDays, subAgentStaleDays, archivedStaleDays, minSizeMb, kind: "recommended", sessionFiles }),
    quarantined: await planQuarantinedCleanup(options.codexHome),
    restore: await planQuarantineRestore(options.codexHome),
    manual: planManualPaths(options.codexHome, sessionFiles, { staleDays, minSizeMb }),
  };
  const selection = resolveSelection(options) || (interactive ? await promptCleanupSelection(plans, { staleDays, subAgentStaleDays, archivedStaleDays }) : "recommended");
  if (!selection) {
    return;
  }
  const report = plans[selection];

  if (options.json) {
    printJson(report);
    return;
  }

  if (selection === "manual") {
    printManualPaths(report);
    if (!options.noOpen) {
      openManualFolders(report.actions.map((action) => action.folder));
    }
    return;
  }

  if (!report.actions.length) {
    printNoCleanupActions(report);
    return;
  }

  if (!options.apply && !interactive) {
    printCleanupPlan(report, { selection });
    console.log("");
    printIndentedLine(`Nothing was moved. Re-run \`${applyCommandForSelection(selection)}\` to apply this plan.`);
    return;
  }

  const shouldApply = options.apply || (interactive && await confirmApply(report));
  if (!shouldApply) {
    printIndentedLine("Nothing was moved.");
    return;
  }

  const result = await applyCleanupPlan(report);
  console.log("");
  if (result.mode === "trash") {
    printIndentedLine(`Moved ${result.actionCount} quarantined files (${formatBytes(result.bytesMoved)}) to system trash.`, { styles: ["green"] });
  } else if (result.mode === "restore") {
    printIndentedLine(`Restored ${result.actionCount} files (${formatBytes(result.bytesMoved)}) to their Codex session folders.`, { styles: ["green"] });
  } else {
    printIndentedLine(`Quarantined ${result.actionCount} files (${formatBytes(result.bytesMoved)}) to ${result.quarantineRoot}.`, { styles: ["green"] });
    printIndentedLine("Next steps:", { styles: ["bold"] });
    printIndentedLine(`- To trash quarantined files, run \`${ROLLOUT_CLEANUP_COMMAND}\` and choose the trash quarantined files option.`);
    printIndentedLine(`- To restore the quarantined files, run \`${ROLLOUT_CLEANUP_COMMAND}\` and choose the restore option.`);
  }
}

async function promptCleanupTargetIfInteractive() {
  if (!process.stdin.isTTY) {
    return null;
  }

  const choices = [
    ["rollouts", "Rollouts"],
    ["skills", "Skills"],
  ];

  printSectionTitle("Cleanup");
  printIndentedLine("Clean up what?");
  choices.forEach((choice, index) => {
    printIndentedLine(`[${index + 1}] ${choice[1]}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${colorText(`Select [1-${choices.length}]: `, ["bold", "yellow"], supportsColor())}`);
    const selected = normalizeCleanupPromptAnswer(answer);
    if (selected) {
      return selected;
    }
    const index = Number(answer.trim()) - 1;
    if (choices[index]) {
      return choices[index][0];
    }
    printIndentedLine("Unknown choice. Nothing was opened, moved, or changed.", { styles: ["yellow"] });
    return null;
  } finally {
    rl.close();
  }
}

function normalizeCleanupTarget(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "rollouts") {
    return "rollouts";
  }
  if (normalized === "skills") {
    return "skills";
  }
  return null;
}

function normalizeCleanupPromptAnswer(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "1") {
    return "rollouts";
  }
  if (normalized === "2") {
    return "skills";
  }
  return normalizeCleanupTarget(normalized);
}

function assertNoExtraArgs(positionals, commandName) {
  if (positionals.length > 0) {
    throw new Error(`unknown ${commandName} argument ${JSON.stringify(positionals[0])}. Run codex-assistant cleanup --help.`);
  }
}

function hasTargetSpecificOptions(options) {
  const globalOptions = new Set(["cacheAutoSaveEvery", "cachePath", "codexHome", "json", "noCache", "refreshCache"]);
  return Object.keys(options).some((key) => !globalOptions.has(key));
}

function printCleanupHelp() {
  console.log(`codex-assistant cleanup

Usage:
  codex-assistant cleanup
  codex-assistant cleanup rollouts [--archived|--sub-agents|--active-older|--manual|--quarantined|--restore] [--apply]
  codex-assistant cleanup skills [--never-used|--rarely-used|--manual|--restore] [--apply]

Targets:
  rollouts   Quarantine, trash, restore, or manually inspect stale rollout JSONL files.
  skills     Disable unused/rarely used skills in config.toml, with a backup first.`);
}

function resolveSelection(options) {
  if (options.archived) {
    return "archived";
  }
  if (options.subAgents) {
    return "sub-agents";
  }
  if (options.activeOlder) {
    return "active-older";
  }
  if (options.quarantined) {
    return "quarantined";
  }
  if (options.restore) {
    return "restore";
  }
  if (options.manual) {
    return "manual";
  }
  return null;
}

async function promptCleanupSelection(plans, { staleDays, subAgentStaleDays, archivedStaleDays }) {
  const choices = [];
  if (plans.archived.actionCount) {
    choices.push(["archived", `Archived rollouts older than ${archivedStaleDays}d (${plans.archived.actionCount}, ${formatBytes(plans.archived.bytesPlanned)})`]);
  }
  if (plans["sub-agents"].actionCount) {
    choices.push(["sub-agents", `Sub-agent rollouts older than ${subAgentStaleDays}d (${plans["sub-agents"].actionCount}, ${formatBytes(plans["sub-agents"].bytesPlanned)})`]);
  }
  if (plans["active-older"].actionCount) {
    choices.push(["active-older", `Active rollouts older than ${staleDays}d (${plans["active-older"].actionCount}, ${formatBytes(plans["active-older"].bytesPlanned)})`]);
  }
  if (plans.manual.actions.length) {
    choices.push(["manual", "Manual: open rollout folders"]);
  }
  if (plans.quarantined.actionCount) {
    choices.push(["quarantined", `Trash quarantined files (${plans.quarantined.actionCount}, ${formatBytes(plans.quarantined.bytesPlanned)})`]);
  }
  if (plans.restore.actionCount) {
    choices.push(["restore", `Restore quarantined files (${plans.restore.actionCount}, ${formatBytes(plans.restore.bytesPlanned)})`]);
  }

  printSectionTitle("Rollout Cleanup");
  if (!choices.length) {
    printIndentedLine("No rollout cleanup options are currently available.");
    return null;
  }
  printIndentedLine("Which rollouts do you want to clean up?");
  choices.forEach((choice, index) => {
    printIndentedLine(`[${index + 1}] ${choice[1]}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${colorText(`Select [1-${choices.length}]: `, ["bold", "yellow"], supportsColor())}`);
    const selected = resolveMenuSelection(answer, choices, normalizeSelection);
    if (selected) {
      return selected;
    }
    printIndentedLine("Unknown choice. Nothing was opened or moved.", { styles: ["yellow"] });
    return null;
  } finally {
    rl.close();
  }
}

async function confirmApply(report) {
  const destination = cleanupDestination(report);
  const defaultYes = report.mode === "restore";
  const prompt = defaultYes
    ? `This will restore ${report.actionCount} files (${formatBytes(report.bytesPlanned)}) to ${destination}. Confirm? [Y/n]: `
    : `This will move ${report.actionCount} files (${formatBytes(report.bytesPlanned)}) to ${destination}. Confirm? [y/N]: `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `  ${colorText(prompt, ["bold", "yellow"], supportsColor())}`,
    );
    const normalized = answer.trim().toLowerCase();
    if (defaultYes) {
      return normalized === "" || normalized === "y" || normalized === "yes";
    }
    return normalized === "y";
  } finally {
    rl.close();
  }
}

function normalizeSelection(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["archived", "archive"].includes(normalized)) {
    return "archived";
  }
  if (["sub-agent", "sub-agents", "subagent", "subagents"].includes(normalized)) {
    return "sub-agents";
  }
  if (["active", "active-older", "active older", "older"].includes(normalized)) {
    return "active-older";
  }
  if (["manual", "paths"].includes(normalized)) {
    return "manual";
  }
  if (["quarantined", "quarantine", "trash"].includes(normalized)) {
    return "quarantined";
  }
  if (["restore", "revert", "undo"].includes(normalized)) {
    return "restore";
  }
  return null;
}

function resolveMenuSelection(answer, choices, normalizeAlias) {
  const normalized = String(answer || "").trim();
  const index = Number(normalized) - 1;
  if (Number.isInteger(index) && choices[index]) {
    return choices[index][0];
  }
  const alias = normalizeAlias(normalized);
  if (alias && choices.some(([key]) => key === alias)) {
    return alias;
  }
  return null;
}

function printCleanupPlan(report, { selection }) {
  const actionPast = report.mode === "trash" ? "trashed" : report.mode === "restore" ? "restored" : "quarantined";
  printSectionTitle("Rollout Cleanup");
  printIndentedLine(`Preview for ${report.codexHome}`);
  printIndentedLine(`${report.actionCount} files would be ${actionPast}, ${formatBytes(report.bytesPlanned)} total.`);
  printIndentedLine(`Destination: ${cleanupDestination(report)}`);
  printIndentedLine("Nothing has been moved yet.");
  if (selection === "quarantined" || selection === "restore") {
    printIndentedLine(`Source: ${report.quarantineRoot}`);
  }
}

function printNoCleanupActions(report) {
  const actionPast = report.mode === "trash" ? "trashed" : report.mode === "restore" ? "restored" : "quarantined";
  printIndentedLine(`No rollout files would be ${actionPast}.`);
}

function cleanupDestination(report) {
  if (report.mode === "trash") {
    return "system trash";
  }
  if (report.mode === "restore") {
    return report.codexHome;
  }
  return report.quarantineRoot;
}

function printManualPaths(report) {
  printSectionTitle("Manual Rollout Cleanup");
  printIndentedLine(`Folders for ${report.codexHome}`);
  console.log("");
  printTable(report.actions, [
    { key: "folder", label: "Folder", maxWidth: 120, format: (value) => shortPath(value) },
    { key: "files", label: "Files", align: "right" },
    { key: "sizeBytes", label: "Size", align: "right", format: formatBytes },
  ]);
}

function openManualFolders(folders) {
  const uniqueFolders = [...new Set(folders.filter(Boolean))];
  for (const folder of uniqueFolders) {
    openFolder(folder);
  }
  console.log("");
  printIndentedLine(`Opened ${uniqueFolders.length} folder${uniqueFolders.length === 1 ? "" : "s"} in ${folderOpenerName()}.`, { styles: ["green"] });
}

function planManualPaths(codexHome, sessionFiles, options) {
  const minSizeBytes = Number(options.minSizeMb ?? 0) * 1024 * 1024;
  const paths = codexPaths(codexHome);
  const matched = sessionFiles.filter((file) => file.sizeBytes >= minSizeBytes);
  const byRoot = new Map([
    [paths.sessions, { action: "manual", folder: paths.sessions, files: 0, sizeBytes: 0 }],
    [paths.archivedSessions, { action: "manual", folder: paths.archivedSessions, files: 0, sizeBytes: 0 }],
  ]);
  for (const file of matched) {
    const root = file.archived ? paths.archivedSessions : paths.sessions;
    const item = byRoot.get(root);
    item.files += 1;
    item.sizeBytes += file.sizeBytes;
  }
  const actions = [...byRoot.values()]
    .filter((item) => item.files > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    mode: "manual",
    codexHome,
    actionCount: matched.length,
    bytesPlanned: matched.reduce((sum, action) => sum + action.sizeBytes, 0),
    actions,
  };
}

function formatDay(value) {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value).slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function openFolder(folder) {
  if (os.platform() === "win32") {
    spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (os.platform() === "darwin") {
    spawn("open", [folder], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [folder], { detached: true, stdio: "ignore" }).unref();
}

function folderOpenerName() {
  if (os.platform() === "win32") {
    return "Explorer";
  }
  if (os.platform() === "darwin") {
    return "Finder";
  }
  return "the file manager";
}

function applyCommandForSelection(selection) {
  if (selection === "recommended") {
    return `${ROLLOUT_CLEANUP_COMMAND} --apply`;
  }
  return `${ROLLOUT_CLEANUP_COMMAND} --${selection} --apply`;
}
