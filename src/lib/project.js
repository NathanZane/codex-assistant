import path from "node:path";
import { readTextSafe, statSafe } from "./fs.js";
import { estimateTokens, formatDate, measure } from "./format.js";
import { normalizeInputPath } from "./paths.js";

export async function scanProjectInstructions(projectPath) {
  const resolved = normalizeInputPath(projectPath || process.cwd());
  const files = [];
  let current = resolved;
  const root = path.parse(current).root;

  while (current && current !== root) {
    const candidate = path.join(current, "AGENTS.md");
    const stat = await statSafe(candidate);
    if (stat?.isFile()) {
      const text = await readTextSafe(candidate, 2_000_000);
      if (text != null) {
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
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return {
    projectPath: resolved,
    files,
    totalTokens: files.reduce((sum, file) => sum + file.tokens, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    repeatedInjectionCost: files.reduce((sum, file) => sum + estimateTokens(file.chars ? `${file.path}\n${file.sha256}` : ""), 0),
  };
}
