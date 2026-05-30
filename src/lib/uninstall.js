import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { applyCleanupPlan, planQuarantinedCleanup, planQuarantineRestore } from "./cleanup.js";
import { statSafe, walkFiles } from "./fs.js";
import { codexPaths } from "./paths.js";

export const DEFAULT_PACKAGE_NAME = "@nathanzane/codex-assistant";

export async function planUninstall(codexHome, options = {}) {
  const paths = codexPaths(codexHome);
  const packageName = options.packageName || DEFAULT_PACKAGE_NAME;
  const [rolloutRestore, rolloutTrash, cacheDelete, backupDelete] = await Promise.all([
    planQuarantineRestore(codexHome),
    planQuarantinedCleanup(codexHome),
    planDeletePath(paths.assistantCacheDir, {
      action: "delete-cache",
      description: "analysis cache",
      codexHome,
    }),
    planDeletePath(paths.assistantBackups, {
      action: "delete-backups",
      description: "codex-assistant config backups",
      codexHome,
    }),
  ]);

  return {
    mode: "uninstall",
    codexHome,
    rolloutRestore,
    rolloutTrash,
    deletes: [cacheDelete, backupDelete].filter(Boolean),
    agents: {
      actionCount: 0,
      description: "No codex-assistant AGENTS artifacts are created.",
    },
    packageUninstall: {
      action: "npm-uninstall-global",
      packageName,
      command: ["npm", "uninstall", "-g", packageName],
    },
  };
}

export async function applyUninstallPlan(plan, options = {}) {
  const decisions = {
    rollouts: options.rollouts || "leave",
    deleteCache: Boolean(options.deleteCache),
    deleteBackups: Boolean(options.deleteBackups),
    uninstallPackage: options.uninstallPackage !== false,
  };
  const results = {
    mode: "uninstall",
    codexHome: plan.codexHome,
    rollouts: null,
    deletes: [],
    packageUninstall: null,
  };

  if (decisions.rollouts === "restore" && plan.rolloutRestore?.actionCount > 0) {
    results.rollouts = await applyCleanupPlan(plan.rolloutRestore);
    await removeDirectoryIfNoFiles(codexPaths(plan.codexHome).rolloutQuarantine);
  } else if (decisions.rollouts === "trash" && plan.rolloutTrash?.actionCount > 0) {
    results.rollouts = await applyCleanupPlan(plan.rolloutTrash);
  }

  for (const deletePlan of plan.deletes || []) {
    if (deletePlan.action === "delete-cache" && !decisions.deleteCache) {
      continue;
    }
    if (deletePlan.action === "delete-backups" && !decisions.deleteBackups) {
      continue;
    }
    results.deletes.push(await applyDeletePathPlan(plan.codexHome, deletePlan));
  }

  if (decisions.uninstallPackage) {
    results.packageUninstall = await runPackageUninstall(plan.packageUninstall);
  }

  return results;
}

async function planDeletePath(target, options) {
  const stat = await statSafe(target);
  if (!stat) {
    return null;
  }
  const files = [];
  if (stat.isDirectory()) {
    for await (const filePath of walkFiles(target)) {
      const fileStat = await statSafe(filePath);
      if (fileStat) {
        files.push({ path: filePath, sizeBytes: fileStat.size });
      }
    }
  } else if (stat.isFile()) {
    files.push({ path: target, sizeBytes: stat.size });
  }

  return {
    mode: "delete-path",
    action: options.action,
    description: options.description,
    codexHome: options.codexHome,
    target,
    actionCount: 1,
    fileCount: files.length,
    bytesPlanned: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
}

async function applyDeletePathPlan(codexHome, plan) {
  assertInside(codexHome, plan.target, "delete target");
  await fsp.rm(plan.target, { recursive: true, force: true });
  return {
    ...plan,
    deleted: true,
  };
}

async function removeDirectoryIfNoFiles(target) {
  const stat = await statSafe(target);
  if (!stat?.isDirectory()) {
    return false;
  }
  for await (const _filePath of walkFiles(target)) {
    return false;
  }
  await fsp.rm(target, { recursive: true, force: true });
  return true;
}

async function runPackageUninstall(packageUninstall) {
  const invocation = packageUninstallInvocation(packageUninstall.packageName);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`npm uninstall exited with code ${code}`);
  }
  return {
    ...packageUninstall,
    command: invocation.displayCommand,
    invocation: [invocation.command, ...invocation.args],
    exitCode: code,
  };
}

export function packageUninstallInvocation(packageName, platform = process.platform, env = process.env) {
  const displayCommand = ["npm", "uninstall", "-g", packageName];
  if (platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", ...displayCommand],
      displayCommand,
    };
  }
  return {
    command: "npm",
    args: ["uninstall", "-g", packageName],
    displayCommand,
  };
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
