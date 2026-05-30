import readline from "node:readline/promises";
import { runSkillCheck } from "../checks/skill-check.js";
import { AnalysisCache } from "../lib/cache.js";
import { colorText, formatInteger, printIndentedLine, printJson, printSectionTitle, supportsColor } from "../lib/format.js";
import { codexPaths } from "../lib/paths.js";
import {
  applySkillConfigRestorePlan,
  applySkillDisablePlan,
  openConfigFile,
  planSkillConfigRestore,
  planSkillDisable,
} from "../lib/skill-config.js";

export async function runSkillCleanup({ options }) {
  const cache = new AnalysisCache(options.codexHome, options);
  await cache.load();
  const payload = await runSkillCheck(options.codexHome, {
    ...options,
    cache,
    candidates: options.candidates || 10_000,
    limit: options.limit || 10_000,
  });
  await cache.save();

  const neverUsed = payload.candidates.filter((candidate) => candidate.totalUsed === 0);
  const rareMaxUses = Number(options.maxUses || 1);
  const rarelyUsed = payload.candidates.filter((candidate) => candidate.totalUsed > 0 && candidate.totalUsed <= rareMaxUses);
  const plans = {
    never: await planSkillDisable(options.codexHome, neverUsed),
    rare: await planSkillDisable(options.codexHome, rarelyUsed),
    restore: await planSkillConfigRestore(options.codexHome),
  };

  const selection = resolveSkillCleanupSelection(options) ||
    (process.stdin.isTTY ? await promptSkillCleanupSelection(plans, { rareMaxUses }) : "never");
  if (!selection) {
    return;
  }

  if (selection === "manual") {
    const configPath = codexPaths(options.codexHome).config;
    if (options.json) {
      printJson({
        mode: "manual-skills-config",
        codexHome: options.codexHome,
        configPath,
        actionCount: 1,
        actions: [{ action: "open-config", target: configPath }],
      });
      return;
    }
    printIndentedLine(`Opened ${openConfigFile(options.codexHome)}.`, { styles: ["green"] });
    return;
  }

  if (selection === "restore") {
    await runSkillRestore({ options, plan: plans.restore });
    return;
  }

  const plan = plans[selection];
  if (options.json) {
    printJson(plan);
    return;
  }

  if (!plan.actionCount) {
    printIndentedLine("No enabled skills matched that cleanup option.");
    return;
  }

  if (!options.apply && !process.stdin.isTTY) {
    printSkillDisablePreview(plan);
    console.log("");
    const selector = selection === "never" ? "--never-used" : "--rarely-used";
    printIndentedLine(`Nothing was changed. Re-run \`codex-assistant cleanup skills ${selector} --apply\` to update config.toml.`);
    return;
  }

  const shouldApply = options.apply || await confirmSkillDisable(plan);
  if (!shouldApply) {
    printIndentedLine("Nothing was changed.");
    return;
  }

  const result = await applySkillDisablePlan(plan);
  printIndentedLine(`Disabled ${result.actionCount} skills in ${result.configPath}.`, { styles: ["green"] });
  printIndentedLine(`Backup: ${result.backupPath}`);
  printIndentedLine("No skill files were deleted.");
  printIndentedLine("To restore, run `codex-assistant cleanup skills` and choose the restore option.");
}

export async function runSkillRestore({ options, plan = null }) {
  const restorePlan = plan || await planSkillConfigRestore(options.codexHome);
  if (options.json) {
    printJson(restorePlan);
    return;
  }
  if (!restorePlan.actionCount) {
    printIndentedLine("No codex-assistant config backup was found.");
    return;
  }
  if (!restorePlan.skillChangeCount) {
    printIndentedLine("No skill enable/disable changes were found in the latest backup.");
    return;
  }
  if (!options.apply && !process.stdin.isTTY) {
    printSectionTitle("Skill Restore");
    printIndentedLine(`Preview for ${restorePlan.configPath}`);
    printIndentedLine(`Backup: ${restorePlan.backupPath}`);
    printSkillRestoreSummary(restorePlan);
    printIndentedLine("Nothing was changed. Re-run with --apply to restore.");
    return;
  }

  const shouldApply = options.apply || await confirmSkillRestore(restorePlan);
  if (!shouldApply) {
    printIndentedLine("Nothing was changed.");
    return;
  }

  const result = await applySkillConfigRestorePlan(restorePlan);
  printIndentedLine(`Restored ${result.configPath}.`, { styles: ["green"] });
  printIndentedLine(`Backup: ${result.backupPath}`, { styles: ["green"] });
  printSkillRestoreSummary(result, { styles: ["green"] });
  printIndentedLine(`Previous config backed up to ${result.currentBackup}.`);
}

function resolveSkillCleanupSelection(options) {
  if (options.neverUsed) {
    return "never";
  }
  if (options.rarelyUsed) {
    return "rare";
  }
  if (options.restore) {
    return "restore";
  }
  if (options.manual) {
    return "manual";
  }
  return null;
}

async function promptSkillCleanupSelection(plans, { rareMaxUses }) {
  const choices = [];
  if (plans.never.actionCount) {
    choices.push(["never", `Disable never-used skills (${plans.never.actionCount}, saves about ${formatInteger(plans.never.estimatedStartupTokens)} startup tokens/thread)`]);
  }
  if (plans.rare.actionCount) {
    choices.push(["rare", `Disable rarely-used skills, <=${rareMaxUses} uses (${plans.rare.actionCount}, saves about ${formatInteger(plans.rare.estimatedStartupTokens)} startup tokens/thread)`]);
  }
  choices.push(["manual", "Manual: open config.toml"]);
  if (plans.restore.skillChangeCount) {
    choices.push(["restore", "Restore previous skill config"]);
  }

  printSectionTitle("Skill Cleanup");
  if (!choices.length) {
    printIndentedLine("No skill cleanup options are currently available.");
    return null;
  }
  printIndentedLine("What do you want to clean up?");
  choices.forEach((choice, index) => {
    printIndentedLine(`[${index + 1}] ${choice[1]}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${colorText(`Select [1-${choices.length}]: `, ["bold", "yellow"], supportsColor())}`);
    const selected = resolveSkillMenuSelection(answer, choices);
    if (selected) {
      return selected;
    }
    printIndentedLine("Unknown choice. Nothing was changed.", { styles: ["yellow"] });
    return null;
  } finally {
    rl.close();
  }
}

function resolveSkillMenuSelection(answer, choices) {
  const normalized = String(answer || "").trim();
  const index = Number(normalized) - 1;
  if (Number.isInteger(index) && choices[index]) {
    return choices[index][0];
  }

  const alias = normalizeSkillSelectionAlias(normalized);
  if (alias && choices.some(([key]) => key === alias)) {
    return alias;
  }
  return null;
}

function normalizeSkillSelectionAlias(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["never", "never-used", "unused"].includes(normalized)) {
    return "never";
  }
  if (["rare", "rarely-used", "rarely used"].includes(normalized)) {
    return "rare";
  }
  if (["manual", "config", "config.toml"].includes(normalized)) {
    return "manual";
  }
  if (["restore", "revert", "undo"].includes(normalized)) {
    return "restore";
  }
  return null;
}

function printSkillDisablePreview(plan) {
  printSectionTitle("Skill Cleanup");
  printIndentedLine(`Preview for ${plan.configPath}`);
  printIndentedLine(`${plan.actionCount} skills would be disabled.`);
  printIndentedLine(`Estimated startup saving: ${formatInteger(plan.estimatedStartupTokens)} startup tokens per thread.`);
  printIndentedLine("No skill files would be deleted.");
}

async function confirmSkillDisable(plan) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `  ${colorText(`This will disable ${plan.actionCount} skills in ${plan.configPath}. Estimated saving: ${formatInteger(plan.estimatedStartupTokens)} startup tokens per thread. No skill files will be deleted. Confirm? [y/N]: `, ["bold", "yellow"], supportsColor())}`,
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function confirmSkillRestore(plan) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    printIndentedLine(`This will restore ${plan.configPath}.`, { styles: ["bold", "yellow"] });
    printIndentedLine(`Backup: ${plan.backupPath}`, { styles: ["yellow"] });
    printSkillRestoreSummary(plan, { styles: ["yellow"] });
    const answer = await rl.question(
      `  ${colorText("Confirm? [Y/n]: ", ["bold", "yellow"], supportsColor())}`,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

function printSkillRestoreSummary(plan, options = {}) {
  const styles = options.styles || [];
  if (plan.restoredSkills?.length) {
    printIndentedLine(
      `Skills re-enabled: ${formatInteger(plan.restoredSkills.length)} (${formatSkillNameSummary(plan.restoredSkills)}).`,
      { styles },
    );
  }
  if (plan.disabledSkills?.length) {
    printIndentedLine(
      `Skills disabled by restore: ${formatInteger(plan.disabledSkills.length)} (${formatSkillNameSummary(plan.disabledSkills)}).`,
      { styles },
    );
  }
  if (!plan.restoredSkills?.length && !plan.disabledSkills?.length) {
    printIndentedLine("Skill enable/disable changes: none detected.", { styles });
  }
}

function formatSkillNameSummary(names) {
  if (names.length <= 6) {
    return names.join(", ");
  }
  return groupSkillNames(names)
    .slice(0, 6)
    .map((group) => `${group.name}: ${formatInteger(group.count)}`)
    .join(", ");
}

function groupSkillNames(names) {
  const groups = new Map();
  for (const name of names) {
    const group = name.includes(":") ? name.split(":")[0] : "local";
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  return [...groups.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
