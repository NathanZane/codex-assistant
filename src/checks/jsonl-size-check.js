import { planCleanup } from "../lib/cleanup.js";
import { DEFAULT_INDENT, colorText, formatBytes, formatTable, supportsColor } from "../lib/format.js";
import { listSessionFiles } from "../lib/session.js";

export async function runJsonlSizeCheck(codexHome, options = {}) {
  const staleDays = Number(options.staleDays ?? 30);
  const subAgentStaleDays = Number(options.subAgentStaleDays ?? 7);
  const archivedStaleDays = Number(options.archivedStaleDays ?? 3);
  const minSizeMb = Number(options.minSizeMb ?? 0);
  const displayLimit = Number(options.limit || 12);
  const files = await listSessionFiles(codexHome, {
    includeArchived: true,
    includeMeta: true,
    cache: options.cache,
    progress: options.progress,
    progressRow: "rollouts",
    progressRowLabel: "Rollouts",
    scanProgressStep: "metadata",
    scanProgressStepLabel: "metadata",
  });
  options.progress?.finishRow("rollouts");
  const cleanup = await planCleanup(codexHome, { staleDays, subAgentStaleDays, archivedStaleDays, minSizeMb, sessionFiles: files });
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const archivedBytes = files.filter((file) => file.archived).reduce((sum, file) => sum + file.sizeBytes, 0);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const cleanupRows = cleanup.actions.map((action) => toRolloutRow(filesByPath.get(action.source) || action, true));
  cleanupRows.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const largeFiles = cleanupRows.slice(0, displayLimit);

  return {
    id: "jsonl-size",
    title: "JSONL Size Check",
    codexHome,
    staleDays,
    subAgentStaleDays,
    archivedStaleDays,
    minSizeMb,
    displayLimit,
    totalFiles: files.length,
    totalBytes,
    archivedBytes,
    cleanupCandidates: cleanup.actions,
    cleanupBytes: cleanup.bytesPlanned,
    largestFiles: largeFiles,
    cleanupRows,
  };
}

export function printJsonlSizeCheck(report, options = {}) {
  const rows = options.rows || report.largestFiles;
  const candidateLabel = options.candidateLabel ||
    `archived older than ${report.archivedStaleDays}d, sub-agent older than ${report.subAgentStaleDays}d, or active older than ${report.staleDays}d rollouts`;
  const color = options.style === false ? false : supportsColor();
  const indent = options.indent === false ? "" : options.indent ?? DEFAULT_INDENT;
  const log = (line = "", styles = []) => console.log(line ? `${indent}${colorText(line, styles, color)}` : "");
  if (options.title !== false) {
    console.log(colorText("JSONL Size Check", ["bold", "cyan"], color));
  }
  log(
    `Found ${report.totalFiles} rollout JSONL files using ${formatBytes(report.totalBytes)} total ` +
      `(${formatBytes(report.archivedBytes)} already archived).`,
  );
  if (!options.compact) {
    log(
      `${report.cleanupCandidates.length} ${candidateLabel} can be quarantined (${formatBytes(report.cleanupBytes)}).`,
    );
  }
  console.log("");

  if (rows.length) {
    if (options.tableTitle !== false) {
      log(options.tableTitle || "Large rollout files", ["bold"]);
    }
    const tableLines = formatTable(rows, [
      { key: "projectName", label: "Project", maxWidth: 28 },
      { key: "threadName", label: "Thread", maxWidth: 44 },
      { key: "sizeBytes", label: "Size", align: "right", format: formatBytes },
      { key: "ageDays", label: "Age", align: "right", format: (value) => (value == null ? "" : `${value}d`) },
      { key: "lastActiveAt", label: "Last active", maxWidth: 11, format: formatDay },
      { key: "type", label: "Type" },
      { key: "action", label: "Suggested action", maxWidth: 22 },
    ]);
    tableLines.forEach((line, index) => log(line, index <= 1 ? ["dim"] : []));
    if (options.footer !== false) {
      console.log("");
      log("To choose which rollout files to quarantine, run `codex-assistant cleanup rollouts`.");
    }
  } else {
    log("No stale or archived rollout logs matched the current cleanup thresholds.");
  }
}

function toRolloutRow(file, isCleanupCandidate) {
  const archived = Boolean(file.archived);
  const type = archived ? "archived" : file.isSubagent ? "sub-agent" : "active";
  return {
    sizeBytes: file.sizeBytes,
    ageDays: file.ageDays,
    lastActiveAt: file.lastActiveAt || file.mtime || null,
    type,
    action: isCleanupCandidate ? "quarantine" : type === "sub-agent" ? "review with parent" : "review first",
    path: file.path || file.source,
    projectName: projectNameFromCwd(file.cwd) || "(unknown)",
    threadName: file.threadName || "(unknown)",
  };
}

function projectNameFromCwd(cwd) {
  if (!cwd) {
    return "(unknown)";
  }
  const normalized = String(cwd).replaceAll("\\", "/").replace(/\/+$/, "");
  const name = normalized.split("/").filter(Boolean).at(-1);
  return name || "(unknown)";
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
