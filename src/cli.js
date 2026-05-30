import { readFileSync } from "node:fs";
import { runCheck } from "./commands/check.js";
import { runCleanup } from "./commands/cleanup.js";
import { runProject } from "./commands/project.js";
import { runStartup } from "./commands/startup.js";
import { parseArgs } from "./lib/args.js";
import { defaultCodexHome, normalizeInputPath } from "./lib/paths.js";

const PACKAGE_VERSION = readPackageVersion();
const COMMANDS = new Map([
  ["check", runCheck],
  ["cleanup", runCleanup],
  ["project", runProject],
  ["startup", runStartup],
]);

const CHECK_ALIASES = new Set(["agents", "rollouts", "skills"]);
const GLOBAL_OPTIONS = new Set(["codexHome", "help", "json"]);
const CACHE_OPTIONS = new Set(["cacheAutoSaveEvery", "cachePath", "noCache", "refreshCache"]);
const SKILL_SCAN_OPTIONS = new Set(["allTime", "candidates", "days", "limit", "sessionLimit", "sessionsLimit", "thread"]);
const ROLLOUT_SCAN_OPTIONS = new Set(["limit", "minSizeMb", "staleDays", "subAgentStaleDays"]);
const OPTION_SETS = {
  check: new Set([...GLOBAL_OPTIONS, ...CACHE_OPTIONS, ...SKILL_SCAN_OPTIONS, ...ROLLOUT_SCAN_OPTIONS, "only"]),
  cleanup: new Set([
    ...GLOBAL_OPTIONS,
    ...CACHE_OPTIONS,
    ...SKILL_SCAN_OPTIONS,
    ...ROLLOUT_SCAN_OPTIONS,
    "activeOlder",
    "apply",
    "archived",
    "manual",
    "maxUses",
    "neverUsed",
    "noOpen",
    "quarantined",
    "rarelyUsed",
    "restore",
    "subAgents",
  ]),
  project: new Set([...GLOBAL_OPTIONS, "limit", "project"]),
  startup: new Set([...GLOBAL_OPTIONS, "limit", "project"]),
};

export async function runCli(argv) {
  let command = argv[0] || "check";
  let commandArgs = argv.slice(1);
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(`codex-assistant ${PACKAGE_VERSION}`);
    return;
  }

  if (command.startsWith("-")) {
    command = "check";
    commandArgs = argv;
  }
  if (CHECK_ALIASES.has(command)) {
    commandArgs = [command, ...commandArgs];
    command = "check";
  }

  const handler = COMMANDS.get(command);
  if (!handler) {
    throw new Error(`unknown command ${JSON.stringify(command)}. Run codex-assistant --help.`);
  }

  const parsed = parseArgs(commandArgs);
  validateOptions(command, parsed.options);
  parsed.options.codexHome = normalizeInputPath(parsed.options.codexHome || defaultCodexHome());
  await handler(parsed);
}

function validateOptions(command, options) {
  const allowed = OPTION_SETS[command] || GLOBAL_OPTIONS;
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown option --${toKebab(key)} for ${command}. Run codex-assistant --help.`);
    }
  }
}

function toKebab(value) {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function printHelp() {
  console.log(`codex-assistant

Usage:
  codex-assistant [check options]
  codex-assistant check [skills|rollouts|agents] [--days 30] [--only skills|jsonl|agents] [--json]
  codex-assistant skills [alias for check skills]
  codex-assistant rollouts [alias for check rollouts]
  codex-assistant agents [alias for check agents]
  codex-assistant startup [--project <path>] [--limit 10] [--json]
  codex-assistant project <path> [--json]
  codex-assistant cleanup [rollouts|skills]
  codex-assistant cleanup rollouts [--archived|--sub-agents|--active-older|--manual|--quarantined|--restore] [--apply]
  codex-assistant cleanup skills [--never-used|--rarely-used|--manual|--restore] [--apply]

Global options:
  --codex-home <path>  Override Codex home. Defaults to ~/.codex.
  --json               Emit machine-readable JSON.
  --days <n>           Skill usage lookback window. Defaults to 30.
  --all-time           Scan all known sessions for skill usage evidence.
  --thread <text>      Restrict skill evidence to matching thread id/name text.
  --no-cache           Disable the local analysis cache.
  --refresh-cache      Recompute cached per-file analyses.
  --apply              Apply the selected cleanup action. Without this, cleanup previews only.
  --no-open            With cleanup rollouts --manual, print folders without opening Explorer/Finder.

Notes:
  Running codex-assistant with no subcommand is the same as codex-assistant check.
  Reports omit raw prompt/session content by default. Skill savings are estimated
  from injected registry-entry tokens, not full SKILL.md body size.`);
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
}
