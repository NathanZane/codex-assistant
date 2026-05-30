import { analyzeSessionFile, listSessionFiles, sortRecentSessions } from "../lib/session.js";
import { scanProjectInstructions } from "../lib/project.js";
import { formatBytes, formatInteger, printIndentedLine, printJson, printSectionTitle, printTable, shortPath } from "../lib/format.js";
import { normalizeInputPath } from "../lib/paths.js";

export async function runProject({ options, positionals }) {
  const projectPath = normalizeInputPath(positionals[0] || options.project || process.cwd());
  const instructions = await scanProjectInstructions(projectPath);
  const recent = sortRecentSessions(await listSessionFiles(options.codexHome, { includeArchived: false }), Number(options.limit || 50));
  const matchingSessions = [];

  for (const file of recent) {
    const analysis = await analyzeSessionFile(file.path, { topLimit: 10 });
    if (sameOrChildPath(analysis.sessionMeta.cwd, projectPath)) {
      matchingSessions.push({
        path: file.path,
        sessionId: file.sessionId,
        threadName: file.threadName,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.mtime,
        cwd: analysis.sessionMeta.cwd,
        tokenEvents: analysis.tokenUsage.events,
        latestInputTokens: analysis.tokenEvents.at(-1)?.inputTokens || null,
        dynamicToolsTokens: analysis.dynamicTools.tokens,
      });
    }
  }

  const report = {
    codexHome: options.codexHome,
    projectPath,
    instructions,
    matchingSessions,
    recommendations: buildProjectRecommendations(instructions, matchingSessions),
  };

  if (options.json) {
    printJson(report);
    return;
  }

  printSectionTitle("Project Check");
  printIndentedLine(`Project audit for ${projectPath}`);
  console.log("");
  printIndentedLine("Project instruction files", { styles: ["bold"] });
  printTable(instructions.files, [
    { key: "tokens", label: "Tokens", align: "right", format: formatInteger },
    { key: "bytes", label: "Size", align: "right", format: formatBytes },
    { key: "modifiedAt", label: "Modified", maxWidth: 20 },
    { key: "path", label: "Path", maxWidth: 72, format: (value) => shortPath(value) },
  ]);
  console.log("");
  printIndentedLine("Recent matching sessions", { styles: ["bold"] });
  printTable(matchingSessions, [
    { key: "sizeBytes", label: "Size", align: "right", format: formatBytes },
    { key: "latestInputTokens", label: "Latest input", align: "right", format: formatInteger },
    { key: "dynamicToolsTokens", label: "Tool schema", align: "right", format: formatInteger },
    { key: "tokenEvents", label: "Events", align: "right" },
    { key: "threadName", label: "Thread", maxWidth: 36 },
    { key: "path", label: "Path", maxWidth: 72, format: (value) => shortPath(value) },
  ]);
  console.log("");
  printIndentedLine("Recommendations", { styles: ["bold"] });
  for (const item of report.recommendations) {
    printIndentedLine(`- ${item}`);
  }
}

function sameOrChildPath(candidate, parent) {
  if (!candidate) {
    return false;
  }
  const normalizedCandidate = normalizeInputPath(candidate).toLowerCase();
  const normalizedParent = normalizeInputPath(parent).toLowerCase();
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent.toLowerCase()}${pathSeparator()}`);
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

function buildProjectRecommendations(instructions, matchingSessions) {
  const recommendations = [];
  if (!instructions.files.length) {
    recommendations.push("No AGENTS.md files found for this project path.");
  } else if (instructions.totalTokens > 2_000) {
    recommendations.push(`Project instructions are about ${formatInteger(instructions.totalTokens)} tokens per startup; split or trim repeated guidance if it is injected often.`);
  } else {
    recommendations.push(`Project instructions are modest at about ${formatInteger(instructions.totalTokens)} tokens.`);
  }

  if (!matchingSessions.length) {
    recommendations.push("No recent sessions in the scanned window matched this project cwd.");
  }
  return recommendations;
}
