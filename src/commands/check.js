import readline from "node:readline/promises";
import { runAgentsCheck, printAgentsCheck } from "../checks/agents-check.js";
import { runJsonlSizeCheck, printJsonlSizeCheck } from "../checks/jsonl-size-check.js";
import { runSkillCheck, printSkillCheck } from "../checks/skill-check.js";
import { AnalysisCache } from "../lib/cache.js";
import { applyCleanupPlan } from "../lib/cleanup.js";
import { colorText, formatBytes, formatInteger, printJson, supportsColor } from "../lib/format.js";
import { codexPaths } from "../lib/paths.js";
import { createProgressReporter } from "../lib/progress.js";
import { applySkillDisablePlan, planSkillDisable } from "../lib/skill-config.js";

const ROLLOUT_GUIDANCE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;
const SKILL_GUIDANCE_MIN_NEVER_USED = 2;
const SKILL_GUIDANCE_WASTE_THRESHOLD = 100_000;
const ROLLOUT_INDENT = "  ";

export async function runCheck({ options, positionals = [] }) {
  const only = normalizeCheckTarget(options.only, positionals);
  const cache = new AnalysisCache(options.codexHome, options);
  await cache.load();
  const progress = createProgressReporter({
    json: options.json,
    enabled: shouldShowScanProgress(cache, options) && Boolean(process.stderr.isTTY),
  });
  const checkOptions = { ...options, cache, progress };

  const checks = [];
  try {
    if (!only || only === "agents") {
      checks.push(await runAgentsCheck(options.codexHome, checkOptions));
    }
    if (!only || only === "skills") {
      checks.push(await runSkillCheck(options.codexHome, checkOptions));
    }
    if (!only || only === "jsonl") {
      checks.push(await runJsonlSizeCheck(options.codexHome, checkOptions));
    }
  } finally {
    progress.finish();
  }

  await cache.save();

  const report = {
    codexHome: options.codexHome,
    checks,
    cache: {
      path: cache.path,
      ...cache.stats,
    },
  };

  if (options.json) {
    printJson(report);
    return;
  }

  if (only) {
    printCheckSections(checks);
    return;
  }

  await printPrioritizedCheckFlow(checks, options);
}

function shouldShowScanProgress(cache, options) {
  if (options.json) {
    return false;
  }
  if (!cache.enabled || cache.refresh || cache.stats.loadError) {
    return true;
  }
  return !cache.loaded || cache.entryCount === 0;
}

function printCheckSections(checks) {
  for (let index = 0; index < checks.length; index += 1) {
    printDivider(index > 0);
    printCheckSection(checks[index]);
  }
}

async function printPrioritizedCheckFlow(checks, options) {
  const jsonlCheck = checks.find((check) => check.id === "jsonl-size");
  const skillsCheck = checks.find((check) => check.id === "skills");
  const agentsCheck = checks.find((check) => check.id === "agents");
  const rolloutGuidance = buildRolloutGuidance(jsonlCheck, options.codexHome);
  const skillGuidance = await buildSkillGuidance(skillsCheck, options.codexHome, options);
  let sectionCount = 0;

  if (rolloutGuidance) {
    printDivider(sectionCount > 0);
    printRolloutGuidanceReport(jsonlCheck, rolloutGuidance);
    const confirmed = await handleRolloutGuidance(rolloutGuidance, process.stdin.isTTY);
    sectionCount += 1;
    const nextLabel = skillGuidance ? "skill check" : agentsCheck ? "AGENTS check" : null;
    if (confirmed && nextLabel) {
      await pauseBeforeNext(nextLabel);
    }
  }

  if (skillGuidance) {
    printDivider(sectionCount > 0);
    printSkillCheck(skillsCheck, {
      candidates: skillGuidance.candidates,
      tableTitle: false,
      footer: false,
    });
    const confirmed = await handleSkillGuidance(skillGuidance, process.stdin.isTTY);
    sectionCount += 1;
    if (confirmed && agentsCheck) {
      await pauseBeforeNext("AGENTS check");
    }
  }

  if (agentsCheck) {
    printDivider(sectionCount > 0);
    printAgentsCheck(agentsCheck);
  }
}

function printCheckSection(check) {
  if (check.id === "skills") {
    printSkillCheck(check);
  } else if (check.id === "jsonl-size") {
    printJsonlSizeCheck(check);
  } else if (check.id === "agents") {
    printAgentsCheck(check);
  }
}

function printDivider(enabled) {
  if (!enabled) {
    return;
  }
  console.log("");
  console.log(colorText("=".repeat(80), ["dim"], supportsColor()));
  console.log("");
}

function printRolloutGuidanceReport(report, guidance) {
  const plan = guidance.plan;
  printJsonlSizeCheck(
    {
      ...report,
      cleanupCandidates: plan.actions,
      cleanupBytes: plan.bytesPlanned,
      largestFiles: guidance.rows,
    },
    {
      footer: false,
      candidateLabel:
        `archived older than ${formatInteger(plan.archivedStaleDays)}d, ` +
        `sub-agent older than ${formatInteger(plan.subAgentStaleDays)}d, or active older than ${formatInteger(plan.staleDays)}d rollout files`,
      compact: true,
      tableTitle: false,
      style: true,
      indent: ROLLOUT_INDENT,
    },
  );
}

function buildRolloutGuidance(report, codexHome) {
  if (!report?.cleanupCandidates?.length) {
    return null;
  }

  const actions = report.cleanupCandidates;
  const bytesPlanned = actions.reduce((sum, action) => sum + action.sizeBytes, 0);
  if (bytesPlanned < ROLLOUT_GUIDANCE_THRESHOLD_BYTES) {
    return null;
  }

  const paths = codexPaths(codexHome);
  const archivedCount = actions.filter((action) => action.archived).length;
  const subAgentCount = actions.filter((action) => !action.archived && action.isSubagent).length;
  const activeOldCount = actions.filter((action) => !action.archived && !action.isSubagent).length;
  const actionSources = new Set(actions.map((action) => action.source));
  const rows = (report.cleanupRows || report.largestFiles)
    .filter((row) => actionSources.has(row.path))
    .slice(0, 10);
  return {
    kind: "rollouts",
    archivedCount,
    subAgentCount,
    activeOldCount,
    rows,
    plan: {
      mode: "quarantine",
      codexHome,
      staleDays: report.staleDays,
      subAgentStaleDays: report.subAgentStaleDays,
      archivedStaleDays: report.archivedStaleDays,
      minSizeMb: report.minSizeMb,
      kind: "archived-active-older",
      actionCount: actions.length,
      bytesPlanned,
      quarantineRoot: paths.rolloutQuarantine,
      actions,
    },
  };
}

async function buildSkillGuidance(report, codexHome, options = {}) {
  if (!report?.neverUsedCandidates?.length) {
    return null;
  }

  const plan = await planSkillDisable(codexHome, report.neverUsedCandidates);
  if (!plan.actionCount) {
    return null;
  }

  const shouldSuggest = plan.actionCount >= SKILL_GUIDANCE_MIN_NEVER_USED ||
    plan.estimatedWasteTokens > SKILL_GUIDANCE_WASTE_THRESHOLD;
  if (!shouldSuggest) {
    return null;
  }

  return {
    kind: "skills",
    plan,
    candidates: plan.skills.slice(0, Number(options.limit || options.candidates || 12)),
  };
}

async function handleRolloutGuidance(item, interactive) {
  const plan = item.plan;
  const matchSummary = rolloutMatchSummary(item, plan);
  const message = `Quarantine ${formatInteger(plan.actionCount)} rollout files ` +
    `(${formatBytes(plan.bytesPlanned)}: ${matchSummary}).`;
  const color = supportsColor();
  const log = (line = "", styles = []) => console.log(line ? `${ROLLOUT_INDENT}${colorText(line, styles, color)}` : "");

  console.log("");
  if (!interactive) {
    log(`${message} Run \`codex-assistant check\` in an interactive terminal to quarantine them.`, ["yellow"]);
    return false;
  }

  log(message, ["yellow"]);
  log(`Quarantined files are moved to ${plan.quarantineRoot}.`);
  log("For more control over which files to quarantine, or to trash/restore quarantined files afterward, run `codex-assistant cleanup rollouts`.");
  if (!(await confirm(`${ROLLOUT_INDENT}${colorText("Continue? [y/N]: ", ["bold", "yellow"], color)}`))) {
    return false;
  }

  try {
    const result = await applyCleanupPlan(plan);
    log(`Quarantined ${formatInteger(result.actionCount)} files (${formatBytes(result.bytesMoved)}) to ${result.quarantineRoot}.`, ["green"]);
    log("- To trash quarantined files, run `codex-assistant cleanup rollouts` and choose the trash quarantined files option.");
    log("- To restore quarantined files, run `codex-assistant cleanup rollouts` and choose the restore option.");
  } catch (error) {
    log(`Could not quarantine rollouts: ${error instanceof Error ? error.message : String(error)}`, ["yellow"]);
  }
  return true;
}

function rolloutWord(count) {
  return count === 1 ? "rollout" : "rollouts";
}

function rolloutMatchSummary(item, plan) {
  const parts = [];
  if (item.archivedCount) {
    parts.push(`${formatInteger(item.archivedCount)} archived ${rolloutWord(item.archivedCount)} older than ${formatInteger(plan.archivedStaleDays)}d`);
  }
  if (item.subAgentCount) {
    parts.push(`${formatInteger(item.subAgentCount)} sub-agent ${rolloutWord(item.subAgentCount)} older than ${formatInteger(plan.subAgentStaleDays)}d`);
  }
  if (item.activeOldCount) {
    parts.push(`${formatInteger(item.activeOldCount)} active ${rolloutWord(item.activeOldCount)} older than ${formatInteger(plan.staleDays)}d`);
  }
  return parts.join(", ");
}

async function handleSkillGuidance(item, interactive) {
  const plan = item.plan;
  const message = `${formatInteger(plan.actionCount)} never-used skills can be disabled ` +
    `(${formatInteger(plan.estimatedStartupTokens)} startup tokens/thread, ` +
    `${formatInteger(plan.estimatedWasteTokens)} wasted tokens observed).`;

  if (!interactive) {
    console.log(`  ${colorText(`${message} Run \`codex-assistant check\` in an interactive terminal to update config.toml.`, ["yellow"], supportsColor())}`);
    return false;
  }

  console.log("");
  console.log(`  ${colorText(message, ["yellow"], supportsColor())}`);
  if (!(await confirm(`  ${colorText("Disable in config.toml? [y/N]: ", ["bold", "yellow"], supportsColor())}`))) {
    return false;
  }

  try {
    const result = await applySkillDisablePlan(plan);
    console.log(`  ${colorText(`Disabled ${formatInteger(result.actionCount)} skills in ${result.configPath}.`, ["green"], supportsColor())}`);
    console.log(`  Backup: ${result.backupPath}`);
    console.log("  To restore, run `codex-assistant cleanup skills` and choose the restore option.");
  } catch (error) {
    console.log(`  ${colorText(`Could not disable skills: ${error instanceof Error ? error.message : String(error)}`, ["yellow"], supportsColor())}`);
  }
  return true;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function pauseBeforeNext(label) {
  console.log("");
  await promptForEnter(`  ${colorText(`Press Enter to continue to ${label}.`, ["bold"], supportsColor())}`);
}

async function promptForEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

function normalizeCheckTarget(onlyValue, positionals = []) {
  if (positionals.length > 1) {
    throw new Error(`too many check targets: ${positionals.map((value) => JSON.stringify(value)).join(" ")}.`);
  }
  if (onlyValue && positionals.length) {
    throw new Error("use either `check <target>` or `check --only <target>`, not both.");
  }
  return normalizeOnlyOption(onlyValue || positionals[0]);
}

function normalizeOnlyOption(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === "skills" || normalized === "skill") {
    return "skills";
  }
  if (normalized === "jsonl" || normalized === "sessions" || normalized === "size" || normalized === "rollouts" || normalized === "rollout") {
    return "jsonl";
  }
  if (normalized === "agents" || normalized === "agents.md" || normalized === "instructions") {
    return "agents";
  }
  throw new Error(`unknown check --only value ${JSON.stringify(value)}. Expected "skills", "jsonl", or "agents".`);
}
