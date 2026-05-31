import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { scanProjectInstructions } from "../lib/project.js";
import { listSessionFiles } from "../lib/session.js";
import { formatInteger, measure, printIndentedLine, printSectionTitle, printTable } from "../lib/format.js";

export async function runAgentsCheck(codexHome, options = {}) {
  const limit = Number(options.limit || 12);
  const sessionFiles = await listSessionFiles(codexHome, {
    includeArchived: false,
    includeMeta: true,
    cache: options.cache,
    progress: options.progress,
    progressRow: "agents",
    progressRowLabel: "AGENTS",
    scanProgressStep: "metadata",
    scanProgressStepLabel: "metadata",
  });
  const activeThreads = sessionFiles.filter((file) => file.referenced && !file.isSubagent && file.cwd);
  const projects = groupActiveProjects(activeThreads);
  const projectReports = [];
  const filesByPath = new Map();
  const projectList = [...projects.values()];

  for (let index = 0; index < projectList.length; index += 1) {
    const project = projectList[index];
    updateAgentsProgress(options, "projects", index + 1, projectList.length);
    const instructions = await scanProjectInstructions(project.projectPath);
    const history = instructions.files.length
      ? await collectHistoricalAgentsStats(project.sessions, options)
      : { reads: 0, totalTokens: 0, averageTokens: 0 };
    for (const file of instructions.files) {
      filesByPath.set(file.path, file);
    }

    const largestFile = [...instructions.files].sort((a, b) => b.tokens - a.tokens)[0] || null;
    projectReports.push({
      project: project.name,
      projectPath: project.projectPath,
      activeThreads: project.activeThreads,
      lastActiveAt: project.lastActiveAt,
      agentsFiles: instructions.files.length,
      currentTokens: instructions.totalTokens,
      currentBytes: instructions.totalBytes,
      currentActiveThreadTokens: instructions.totalTokens * project.activeThreads,
      totalReadTokens: history.totalTokens,
      averageReadTokens: history.averageTokens,
      readCount: history.reads,
      largestFileTokens: largestFile?.tokens || 0,
      files: instructions.files,
    });
  }
  updateAgentsProgress(options, "projects", projectList.length, projectList.length);
  options.progress?.finishRow("agents");

  const projectsWithCurrentAgents = projectReports.filter((project) => project.currentTokens > 0);
  const rows = projectsWithCurrentAgents
    .filter((project) => project.totalReadTokens > 0)
    .sort((a, b) =>
      b.totalReadTokens - a.totalReadTokens ||
      b.currentActiveThreadTokens - a.currentActiveThreadTokens ||
      b.currentTokens - a.currentTokens ||
      b.activeThreads - a.activeThreads,
    );
  const uniqueFiles = [...filesByPath.values()];
  const currentActiveThreadTokens = projectsWithCurrentAgents.reduce((sum, project) => sum + project.currentActiveThreadTokens, 0);
  const totalReadTokens = rows.reduce((sum, project) => sum + project.totalReadTokens, 0);
  const readCount = rows.reduce((sum, project) => sum + project.readCount, 0);

  return {
    id: "agents",
    title: "AGENTS Check",
    codexHome,
    scope: {
      activeThreads: activeThreads.length,
      activeProjects: projectReports.length,
      projectsWithAgents: projectsWithCurrentAgents.length,
      projectsWithReadFootprint: rows.length,
    },
    uniqueAgentsFiles: uniqueFiles.length,
    uniqueAgentsTokens: uniqueFiles.reduce((sum, file) => sum + file.tokens, 0),
    uniqueAgentsBytes: uniqueFiles.reduce((sum, file) => sum + file.bytes, 0),
    currentActiveThreadTokens,
    totalReadTokens,
    readCount,
    averageCurrentTokensPerActiveThread: activeThreads.length ? Math.round(currentActiveThreadTokens / activeThreads.length) : 0,
    averageReadTokensPerActiveThread: activeThreads.length ? Math.round(totalReadTokens / activeThreads.length) : 0,
    projects: rows.slice(0, limit),
    recommendations: buildRecommendations(rows),
  };
}

export function printAgentsCheck(report, options = {}) {
  if (options.title !== false) {
    printSectionTitle("AGENTS Check");
  }
  printIndentedLine(
    `${formatInteger(report.scope.activeThreads)} active threads, ${formatInteger(report.uniqueAgentsFiles)} AGENTS.md files, ` +
      `${formatInteger(report.totalReadTokens)} tokens read across ${formatInteger(report.readCount)} ${readWord(report.readCount)}.`,
  );
  console.log("");

  if (report.projects.length) {
    printTable(report.projects, [
      { key: "project", label: "Project", maxWidth: 28 },
      { key: "activeThreads", label: "Threads", align: "right", format: formatInteger },
      { key: "currentTokens", label: "Current", align: "right", format: formatInteger },
      { key: "readCount", label: "Reads", align: "right", format: formatInteger },
      { key: "averageReadTokens", label: "Avg/read", align: "right", format: formatInteger },
      { key: "totalReadTokens", label: "Total read", align: "right", format: formatInteger },
      { key: "agentsFiles", label: "Files", align: "right", format: formatInteger },
    ]);
  } else {
    printIndentedLine("No active project AGENTS.md files have observed reads.");
  }
}

function updateAgentsProgress(options, stepId, current, total) {
  options.progress?.updateStep("agents", stepId, current, total, {
    rowLabel: "AGENTS",
    stepLabel: stepId,
  });
}

function groupActiveProjects(sessionFiles) {
  const projects = new Map();
  for (const file of sessionFiles) {
    const projectPath = normalizeProjectPath(file.cwd);
    const current = projects.get(projectPath) || {
      name: projectNameFromPath(projectPath),
      projectPath,
      activeThreads: 0,
      lastActiveAt: null,
      sessions: [],
    };
    current.activeThreads += 1;
    current.sessions.push(file);
    if (!current.lastActiveAt || new Date(file.lastActiveAt) > new Date(current.lastActiveAt)) {
      current.lastActiveAt = file.lastActiveAt;
    }
    projects.set(projectPath, current);
  }
  return projects;
}

function buildRecommendations(projects) {
  if (!projects.length) {
    return [];
  }
  const [largest] = projects;
  const recommendations = [];
  if (largest.readCount > 0) {
    recommendations.push(`Review ${largest.project} first: ${formatInteger(largest.totalReadTokens)} tokens read.`);
  } else {
    recommendations.push(
      `Review ${largest.project} first: current AGENTS size is ${formatInteger(largest.currentTokens)} tokens per active thread, ` +
        `across ${formatInteger(largest.activeThreads)} active ${threadWord(largest.activeThreads)}.`,
    );
  }
  const largestCurrent = [...projects].sort((a, b) => b.currentTokens - a.currentTokens)[0];
  if (largestCurrent && largestCurrent !== largest) {
    recommendations.push(`Largest current AGENTS footprint is ${largestCurrent.project} at ${formatInteger(largestCurrent.currentTokens)} tokens per active thread.`);
  }
  const largeFile = projects.find((project) => project.largestFileTokens >= 2_000);
  if (largeFile && largeFile !== largestCurrent) {
    recommendations.push(`Largest single AGENTS.md is in ${largeFile.project} at ${formatInteger(largeFile.largestFileTokens)} tokens.`);
  }
  return recommendations;
}

async function collectHistoricalAgentsStats(sessionFiles, options) {
  const reads = [];
  for (let index = 0; index < sessionFiles.length; index += 1) {
    const file = sessionFiles[index];
    const fileReads = await readHistoricalAgentsReads(file.path, options.cache);
    for (const read of fileReads) {
      if (read?.tokens) {
        reads.push({ ...read, sessionId: file.sessionId, lastActiveAt: file.lastActiveAt || file.mtime || null });
      }
    }
  }

  const tokens = reads.map((read) => read.tokens);
  const totalTokens = tokens.reduce((sum, value) => sum + value, 0);
  return {
    reads: reads.length,
    totalTokens,
    averageTokens: tokens.length ? Math.round(totalTokens / tokens.length) : 0,
  };
}

async function readHistoricalAgentsReads(filePath, cache) {
  const compute = () => readHistoricalAgentsReadsUncached(filePath);
  if (cache) {
    const cached = await cache.getOrCompute("agents-user-instructions-v2", filePath, compute);
    return Array.isArray(cached) ? cached : [];
  }
  return compute();
}

async function readHistoricalAgentsReadsUncached(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const reads = [];
  let lineNo = 0;

  try {
    for await (const line of rl) {
      lineNo += 1;
      if (!line.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const text = record?.payload?.user_instructions;
      if (record?.type === "turn_context" && typeof text === "string" && text.trim()) {
        const measured = measure(text);
        reads.push({
          line: lineNo,
          chars: measured.chars,
          tokens: measured.tokens,
          sha256: measured.sha256,
        });
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return reads;
}

function normalizeProjectPath(value) {
  return path.resolve(String(value)).replace(/[\\/]+$/, "");
}

function projectNameFromPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function threadWord(count) {
  return count === 1 ? "thread" : "threads";
}

function readWord(count) {
  return count === 1 ? "read" : "reads";
}
