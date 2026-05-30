import readline from "node:readline/promises";
import { colorText, formatBytes, formatInteger, printIndentedLine, printJson, printSectionTitle, supportsColor } from "../lib/format.js";
import { applyUninstallPlan, planUninstall } from "../lib/uninstall.js";

export async function runUninstall({ options }) {
  if (options.help) {
    printUninstallHelp();
    return;
  }

  validateDecisionOptions(options);
  const plan = await planUninstall(options.codexHome);
  if (options.json) {
    printJson(plan);
    return;
  }

  if (!options.apply && !process.stdin.isTTY) {
    printUninstallPreview(plan, defaultDecisions(options));
    console.log("");
    printIndentedLine("Nothing was changed. Run this command in an interactive terminal or pass explicit options with --apply.");
    return;
  }

  const decisions = await resolveDecisions(plan, options);
  printUninstallPreview(plan, decisions);
  const shouldApply = options.apply || await confirmUninstall();
  if (!shouldApply) {
    printIndentedLine("Nothing was changed.");
    return;
  }

  const result = await applyUninstallPlan(plan, decisions);
  console.log("");
  printIndentedLine("Codex Assistant uninstall cleanup completed.", { styles: ["green"] });
  printResultSummary(result);
}

function printUninstallHelp() {
  console.log(`codex-assistant uninstall

Usage:
  codex-assistant uninstall
  codex-assistant uninstall --rollouts restore|trash|leave [--delete-cache|--keep-cache] [--delete-backups|--keep-backups] [--apply]

Options:
  --rollouts <mode>   Choose what to do with quarantined rollouts: restore, trash, or leave.
  --delete-cache      Delete ~/.codex/cache/codex-assistant.
  --keep-cache        Keep ~/.codex/cache/codex-assistant.
  --delete-backups    Delete ~/.codex/backups/codex-assistant.
  --keep-backups      Keep ~/.codex/backups/codex-assistant.
  --apply             Apply selected actions and run npm uninstall -g @nathanzane/codex-assistant.

Interactive mode asks for rollout, cache, and backup choices before final confirmation.`);
}

async function resolveDecisions(plan, options) {
  const interactive = Boolean(process.stdin.isTTY) && !options.apply;
  return {
    rollouts: normalizeRolloutChoice(options.rollouts) || (interactive ? await promptRolloutChoice(plan) : "leave"),
    deleteCache: await resolveDeleteChoice(options.deleteCache, options.keepCache, interactive, () => promptDeleteChoice(cacheDeletePlan(plan), "Delete analysis cache?")),
    deleteBackups: await resolveDeleteChoice(options.deleteBackups, options.keepBackups, interactive, () => promptDeleteChoice(backupDeletePlan(plan), "Delete Codex Assistant skill/config backups?")),
    uninstallPackage: true,
  };
}

function validateDecisionOptions(options) {
  const rolloutChoice = normalizeRolloutChoice(options.rollouts);
  if (options.rollouts && !rolloutChoice) {
    throw new Error(`unknown uninstall --rollouts value ${JSON.stringify(options.rollouts)}. Use restore, trash, or leave.`);
  }
  if (options.deleteCache && options.keepCache) {
    throw new Error("use either --delete-cache or --keep-cache, not both.");
  }
  if (options.deleteBackups && options.keepBackups) {
    throw new Error("use either --delete-backups or --keep-backups, not both.");
  }
}

async function resolveDeleteChoice(deleteOption, keepOption, interactive, prompt) {
  if (deleteOption) {
    return true;
  }
  if (keepOption) {
    return false;
  }
  if (interactive) {
    return prompt();
  }
  return true;
}

function defaultDecisions(options = {}) {
  return {
    rollouts: normalizeRolloutChoice(options.rollouts) || "leave",
    deleteCache: !options.keepCache,
    deleteBackups: !options.keepBackups,
    uninstallPackage: true,
  };
}

function printUninstallPreview(plan, decisions) {
  printSectionTitle("Codex Assistant Uninstall");
  printIndentedLine(`Codex home: ${plan.codexHome}`);
  printIndentedLine("This will:");
  printIndentedLine(`- ${formatRolloutDecision(plan, decisions.rollouts)}`);
  printIndentedLine("- Leave AGENTS files unchanged; this project does not create AGENTS artifacts.");
  printIndentedLine("- Leave current skill config unchanged.");
  for (const deletePlan of plan.deletes) {
    const shouldDelete = deletePlan.action === "delete-cache" ? decisions.deleteCache : decisions.deleteBackups;
    const verb = shouldDelete ? "Delete" : "Keep";
    printIndentedLine(`- ${verb} ${deletePlan.description} at ${deletePlan.target} (${formatInteger(deletePlan.fileCount)} files, ${formatBytes(deletePlan.bytesPlanned)}).`);
  }
  if (!plan.deletes.length) {
    printIndentedLine("- Delete Codex Assistant cache/backups: none found.");
  }
  printIndentedLine(`- Run \`${plan.packageUninstall.command.join(" ")}\`.`);
  printIndentedLine("Shared npm cache and npm log folders are left alone.");
}

function formatRolloutDecision(plan, choice) {
  if (!plan.rolloutTrash.actionCount) {
    return "Quarantined rollouts: none found.";
  }
  if (choice === "restore") {
    return `Restore ${formatInteger(plan.rolloutRestore.actionCount)} quarantined rollout files (${formatBytes(plan.rolloutRestore.bytesPlanned)}) to their Codex session folders.`;
  }
  if (choice === "trash") {
    return `Trash ${formatInteger(plan.rolloutTrash.actionCount)} quarantined rollout files (${formatBytes(plan.rolloutTrash.bytesPlanned)}).`;
  }
  return `Leave ${formatInteger(plan.rolloutTrash.actionCount)} quarantined rollout files (${formatBytes(plan.rolloutTrash.bytesPlanned)}) as they are.`;
}

async function promptRolloutChoice(plan) {
  if (!plan.rolloutTrash.actionCount) {
    return "leave";
  }

  printSectionTitle("Quarantined Rollouts");
  printIndentedLine(`${formatInteger(plan.rolloutTrash.actionCount)} quarantined rollout files found (${formatBytes(plan.rolloutTrash.bytesPlanned)}).`);
  const choices = [];
  if (plan.rolloutRestore.actionCount) {
    choices.push(["restore", `Restore restorable files (${plan.rolloutRestore.actionCount})`]);
  }
  choices.push(["trash", `Trash quarantined files (${plan.rolloutTrash.actionCount})`]);
  choices.push(["leave", "Leave as is"]);
  choices.forEach((choice, index) => {
    printIndentedLine(`[${index + 1}] ${choice[1]}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${colorText(`Select [1-${choices.length}]: `, ["bold", "yellow"], supportsColor())}`);
    const selected = resolveMenuChoice(answer, choices, normalizeRolloutChoice);
    if (selected) {
      return selected;
    }
    printIndentedLine("Unknown choice. Rollouts will be left as they are.", { styles: ["yellow"] });
    return "leave";
  } finally {
    rl.close();
  }
}

async function promptDeleteChoice(plan, prompt) {
  if (!plan) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `  ${colorText(`${prompt} (${formatInteger(plan.fileCount)} files, ${formatBytes(plan.bytesPlanned)}) [y/N]: `, ["bold", "yellow"], supportsColor())}`,
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function confirmUninstall() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `  ${colorText("Continue? [y/N]: ", ["bold", "yellow"], supportsColor())}`,
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function printResultSummary(result) {
  if (result.rollouts?.mode === "restore") {
    printIndentedLine(`Restored ${formatInteger(result.rollouts.actionCount)} rollout files (${formatBytes(result.rollouts.bytesMoved)}).`, { styles: ["green"] });
  } else if (result.rollouts?.mode === "trash") {
    printIndentedLine(`Moved ${formatInteger(result.rollouts.actionCount)} rollout files (${formatBytes(result.rollouts.bytesMoved)}) to system trash.`, { styles: ["green"] });
  }
  for (const deleteResult of result.deletes) {
    printIndentedLine(`Deleted ${deleteResult.description}: ${deleteResult.target}.`, { styles: ["green"] });
  }
  if (result.packageUninstall) {
    printIndentedLine(`Ran ${result.packageUninstall.command.join(" ")}.`, { styles: ["green"] });
  }
}

function cacheDeletePlan(plan) {
  return plan.deletes.find((item) => item.action === "delete-cache") || null;
}

function backupDeletePlan(plan) {
  return plan.deletes.find((item) => item.action === "delete-backups") || null;
}

function normalizeRolloutChoice(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["restore", "restored", "revert"].includes(normalized)) {
    return "restore";
  }
  if (["trash", "delete", "remove"].includes(normalized)) {
    return "trash";
  }
  if (["leave", "keep", "none", "skip"].includes(normalized)) {
    return "leave";
  }
  return null;
}

function resolveMenuChoice(answer, choices, normalizeAlias) {
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
