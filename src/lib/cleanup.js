import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { codexPaths } from "./paths.js";
import { daysSince } from "./format.js";
import { statSafe, walkFiles } from "./fs.js";
import { listSessionFiles } from "./session.js";

const execFileAsync = promisify(execFile);

export async function planCleanup(codexHome, options = {}) {
  const staleDays = Number(options.staleDays ?? 30);
  const subAgentStaleDays = Number(options.subAgentStaleDays ?? 7);
  const archivedStaleDays = Number(options.archivedStaleDays ?? 3);
  const minSizeMb = Number(options.minSizeMb ?? 0);
  const minSizeBytes = minSizeMb * 1024 * 1024;
  const paths = codexPaths(codexHome);
  const kind = options.kind || "recommended";
  const sessionFiles = options.sessionFiles || (await listSessionFiles(codexHome, { includeArchived: true, includeMeta: true }));
  const actions = [];

  for (const file of sessionFiles) {
    const ageDays = daysSince(file.lastActiveAt || file.mtime);
    const eligibleBySize = file.sizeBytes >= minSizeBytes;
    const eligibleByStaleAge = ageDays != null && ageDays >= staleDays && eligibleBySize;
    const eligibleArchived = file.archived && ageDays != null && ageDays >= archivedStaleDays && eligibleBySize;
    const eligibleSubThread = ageDays != null && ageDays >= subAgentStaleDays && file.isSubagent && eligibleBySize;
    if (!matchesCleanupKind({
      file,
      kind,
      eligibleArchived,
      eligibleSubThread,
      eligibleByStaleAge,
    })) {
      continue;
    }
    actions.push({
      action: "quarantine",
      reason: cleanupReason(file, { staleDays, archivedStaleDays }),
      source: file.path,
      target: path.join(paths.rolloutQuarantine, file.relativePath),
      sizeBytes: file.sizeBytes,
      ageDays,
      lastActiveAt: file.lastActiveAt || file.mtime || null,
      referenced: file.referenced,
      archived: file.archived,
      isSubagent: Boolean(file.isSubagent),
      parentThreadId: file.parentThreadId || null,
    });
  }

  actions.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    mode: "quarantine",
    codexHome,
    staleDays,
    subAgentStaleDays,
    archivedStaleDays,
    minSizeMb,
    kind,
    actionCount: actions.length,
    bytesPlanned: actions.reduce((sum, action) => sum + action.sizeBytes, 0),
    quarantineRoot: paths.rolloutQuarantine,
    actions,
  };
}

export async function planQuarantinedCleanup(codexHome) {
  const paths = codexPaths(codexHome);
  const actions = [];

  for await (const filePath of walkFiles(paths.rolloutQuarantine)) {
    const stat = await statSafe(filePath);
    if (!stat) {
      continue;
    }
    actions.push({
      action: "trash",
      reason: "already quarantined",
      source: filePath,
      target: "system trash",
      relativePath: path.relative(paths.rolloutQuarantine, filePath),
      sizeBytes: stat.size,
      ageDays: daysSince(stat.mtime),
      lastActiveAt: stat.mtime,
    });
  }

  actions.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    mode: "trash",
    codexHome,
    actionCount: actions.length,
    bytesPlanned: actions.reduce((sum, action) => sum + action.sizeBytes, 0),
    quarantineRoot: paths.rolloutQuarantine,
    actions,
  };
}

export async function planQuarantineRestore(codexHome) {
  const paths = codexPaths(codexHome);
  const actions = [];

  for await (const filePath of walkFiles(paths.rolloutQuarantine)) {
    const stat = await statSafe(filePath);
    if (!stat) {
      continue;
    }
    const relativePath = path.relative(paths.rolloutQuarantine, filePath);
    if (!isRestorableQuarantinePath(relativePath)) {
      continue;
    }
    actions.push({
      action: "restore",
      reason: "quarantined rollout",
      source: filePath,
      target: path.join(paths.codexHome, relativePath),
      relativePath,
      sizeBytes: stat.size,
      ageDays: daysSince(stat.mtime),
      lastActiveAt: stat.mtime,
    });
  }

  actions.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    mode: "restore",
    codexHome,
    actionCount: actions.length,
    bytesPlanned: actions.reduce((sum, action) => sum + action.sizeBytes, 0),
    quarantineRoot: paths.rolloutQuarantine,
    actions,
  };
}

export async function applyCleanupPlan(plan) {
  if (plan.mode === "trash") {
    return trashQuarantinedFiles(plan);
  }
  if (plan.mode === "restore") {
    return restoreQuarantinedFiles(plan);
  }
  return quarantineFiles(plan);
}

function matchesCleanupKind({ file, kind, eligibleArchived, eligibleSubThread, eligibleByStaleAge }) {
  if (kind === "archived") {
    return eligibleArchived;
  }
  if (kind === "sub-agents") {
    return !file.archived && eligibleSubThread;
  }
  if (kind === "active-older") {
    return !file.archived && !file.isSubagent && eligibleByStaleAge;
  }
  if (kind === "recommended") {
    return eligibleArchived || (!file.archived && eligibleSubThread) || (!file.archived && !file.isSubagent && eligibleByStaleAge);
  }
  return false;
}

function cleanupReason(file, { staleDays, archivedStaleDays }) {
  if (file.archived) {
    return `archived session older than ${archivedStaleDays} days`;
  }
  if (file.isSubagent) {
    return "stale sub-thread session log";
  }
  return `active session older than ${staleDays} days`;
}

async function quarantineFiles(plan) {
  const paths = codexPaths(plan.codexHome);
  let bytesMoved = 0;
  const moved = [];

  for (const action of plan.actions) {
    assertInside(paths.codexHome, action.source, "cleanup source");
    assertInside(paths.rolloutQuarantine, action.target, "quarantine target");
    await moveFile(action.source, action.target);
    bytesMoved += action.sizeBytes;
    moved.push(action);
  }

  return {
    mode: "quarantine",
    actionCount: moved.length,
    bytesMoved,
    quarantineRoot: paths.rolloutQuarantine,
    actions: moved,
  };
}

async function trashQuarantinedFiles(plan) {
  const paths = codexPaths(plan.codexHome);
  let bytesMoved = 0;
  const trashed = [];

  for (const action of plan.actions) {
    assertInside(paths.rolloutQuarantine, action.source, "trash source");
    await sendFileToTrash(action.source);
    bytesMoved += action.sizeBytes;
    trashed.push(action);
  }

  return {
    mode: "trash",
    actionCount: trashed.length,
    bytesMoved,
    quarantineRoot: paths.rolloutQuarantine,
    actions: trashed,
  };
}

async function restoreQuarantinedFiles(plan) {
  const paths = codexPaths(plan.codexHome);
  for (const action of plan.actions) {
    assertInside(paths.rolloutQuarantine, action.source, "restore source");
    assertInside(paths.codexHome, action.target, "restore target");
    if (!isRestorableQuarantinePath(action.relativePath || path.relative(paths.rolloutQuarantine, action.source))) {
      throw new Error(`restore source is not a mirrored rollout path: ${action.source}`);
    }
    if (await statSafe(action.target)) {
      throw new Error(`restore target already exists: ${action.target}`);
    }
  }

  let bytesMoved = 0;
  const restored = [];
  for (const action of plan.actions) {
    await moveFile(action.source, action.target);
    bytesMoved += action.sizeBytes;
    restored.push(action);
  }

  return {
    mode: "restore",
    actionCount: restored.length,
    bytesMoved,
    quarantineRoot: paths.rolloutQuarantine,
    actions: restored,
  };
}

async function moveFile(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    await fsp.copyFile(source, target);
    await fsp.unlink(source);
  }
}

async function sendFileToTrash(filePath) {
  if (os.platform() === "win32") {
    const script = [
      "Add-Type -AssemblyName Microsoft.VisualBasic;",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:CODEX_ASSISTANT_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ].join(" ");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, CODEX_ASSISTANT_TRASH_PATH: filePath },
    });
    return;
  }

  if (os.platform() === "darwin") {
    const script = 'tell application "Finder" to delete POSIX file (system attribute "CODEX_ASSISTANT_TRASH_PATH")';
    await execFileAsync("osascript", ["-e", script], {
      env: { ...process.env, CODEX_ASSISTANT_TRASH_PATH: filePath },
    });
    return;
  }

  for (const command of [["gio", ["trash", filePath]], ["trash-put", [filePath]]]) {
    try {
      await execFileAsync(command[0], command[1]);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error("could not find a system trash command; delete the quarantined files manually");
}

function assertInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} is outside expected directory: ${candidate}`);
}

function isRestorableQuarantinePath(relativePath) {
  const firstSegment = String(relativePath).split(/[\\/]/, 1)[0];
  return firstSegment === "sessions" || firstSegment === "archived_sessions";
}
