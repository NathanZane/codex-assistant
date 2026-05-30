import { codexPaths } from "./paths.js";
import { readTextSafe, statSafe } from "./fs.js";
import { formatDate, measure } from "./format.js";
import { analyzeSessionFile, listSessionFiles, sortRecentSessions } from "./session.js";
import { scanProjectInstructions } from "./project.js";

export async function analyzeStartup(codexHome, options = {}) {
  const limit = options.limit || 10;
  const sessionFiles = sortRecentSessions(await listSessionFiles(codexHome, { includeArchived: false }), limit);
  const analyzed = [];
  for (const file of sessionFiles) {
    analyzed.push(await analyzeSessionFile(file.path, { topLimit: 80 }));
  }

  const commonBlocks = commonInjectedBlocks(analyzed);
  const latest = analyzed[0] || null;
  const configFiles = await scanStartupFiles(codexHome);
  const project = await scanProjectInstructions(options.project || process.cwd());

  return {
    codexHome,
    analyzedSessions: analyzed.length,
    latestSession: latest
      ? {
          path: latest.path,
          cwd: latest.sessionMeta.cwd || null,
          baseInstructionsTokens: latest.totalsByKind.injected_base_instructions?.tokens || 0,
          dynamicToolsTokens: latest.dynamicTools.tokens,
          dynamicToolCount: latest.dynamicTools.count,
          skillRegistryEntries: latest.skillRegistry.entries.length,
          pluginRegistryEntries: latest.pluginRegistry.length,
        }
      : null,
    toolNamespaces: latest ? Object.values(latest.dynamicTools.namespaces).sort((a, b) => b.tokens - a.tokens) : [],
    commonInjectedBlocks: commonBlocks,
    configFiles,
    projectInstructions: project,
  };
}

function commonInjectedBlocks(sessions) {
  const byHash = new Map();
  for (const session of sessions) {
    for (const block of session.topBlocks) {
      if (!block.kind.startsWith("injected_")) {
        continue;
      }
      const existing = byHash.get(block.sha256) || { ...block, sessions: 0 };
      existing.sessions += 1;
      existing.tokens = Math.max(existing.tokens, block.tokens);
      existing.chars = Math.max(existing.chars, block.chars);
      byHash.set(block.sha256, existing);
    }
  }
  return [...byHash.values()]
    .filter((block) => block.sessions > 1)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20);
}

async function scanStartupFiles(codexHome) {
  const paths = codexPaths(codexHome);
  const files = [];
  for (const candidate of [paths.config, paths.hooks]) {
    const stat = await statSafe(candidate);
    if (!stat?.isFile()) {
      continue;
    }
    const text = await readTextSafe(candidate, 1_000_000);
    if (text == null) {
      continue;
    }
    const measured = measure(text);
    files.push({
      path: candidate,
      bytes: stat.size,
      chars: measured.chars,
      tokens: measured.tokens,
      sha256: measured.sha256,
      modifiedAt: formatDate(stat.mtime),
    });
  }
  return files;
}
