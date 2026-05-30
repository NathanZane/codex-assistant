import { analyzeStartup } from "../lib/startup.js";
import { formatBytes, formatInteger, printIndentedLine, printJson, printSectionTitle, printTable, shortPath } from "../lib/format.js";

export async function runStartup({ options }) {
  const report = await analyzeStartup(options.codexHome, {
    project: options.project || process.cwd(),
    limit: Number(options.limit || 10),
  });

  if (options.json) {
    printJson(report);
    return;
  }

  printSectionTitle("Startup Check");
  printIndentedLine(`Startup/context floor from ${report.analyzedSessions} recent sessions`);
  if (report.latestSession) {
    printIndentedLine(
      `Latest: base ${formatInteger(report.latestSession.baseInstructionsTokens)} tokens, ` +
        `${report.latestSession.dynamicToolCount} tools / ${formatInteger(report.latestSession.dynamicToolsTokens)} tool-schema tokens`,
    );
  }
  console.log("");
  printIndentedLine("Loaded tool schemas by namespace", { styles: ["bold"] });
  printTable(report.toolNamespaces, [
    { key: "namespace", label: "Namespace", maxWidth: 36 },
    { key: "tools", label: "Tools", align: "right" },
    { key: "tokens", label: "Tokens", align: "right", format: formatInteger },
    { key: "chars", label: "Chars", align: "right", format: formatInteger },
  ]);
  console.log("");
  printIndentedLine("Common injected blocks", { styles: ["bold"] });
  printTable(report.commonInjectedBlocks, [
    { key: "tokens", label: "Tokens", align: "right", format: formatInteger },
    { key: "sessions", label: "Sessions", align: "right" },
    { key: "kind", label: "Kind", maxWidth: 32 },
    { key: "sha256", label: "Hash" },
    { key: "source", label: "Source", maxWidth: 72 },
  ]);
  console.log("");
  printIndentedLine("Codex startup files", { styles: ["bold"] });
  printTable(report.configFiles, [
    { key: "tokens", label: "Tokens", align: "right", format: formatInteger },
    { key: "bytes", label: "Size", align: "right", format: formatBytes },
    { key: "modifiedAt", label: "Modified", maxWidth: 20 },
    { key: "path", label: "Path", maxWidth: 72, format: (value) => shortPath(value) },
  ]);
  console.log("");
  printIndentedLine("Project instructions", { styles: ["bold"] });
  printTable(report.projectInstructions.files, [
    { key: "tokens", label: "Tokens", align: "right", format: formatInteger },
    { key: "bytes", label: "Size", align: "right", format: formatBytes },
    { key: "modifiedAt", label: "Modified", maxWidth: 20 },
    { key: "path", label: "Path", maxWidth: 72, format: (value) => shortPath(value) },
  ]);
}
