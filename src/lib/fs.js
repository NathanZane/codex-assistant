import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

export async function readTextSafe(filePath, limitBytes = 1_000_000) {
  const stat = await statSafe(filePath);
  if (!stat || !stat.isFile() || stat.size > limitBytes) {
    return null;
  }
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function* walkFiles(root, options = {}) {
  const stat = await statSafe(root);
  if (!stat || !stat.isDirectory()) {
    return;
  }

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let dir;
    try {
      dir = await fsp.opendir(current);
    } catch {
      continue;
    }

    for await (const entry of dir) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!options.skipDir || !options.skipDir(fullPath, entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        if (!options.match || options.match(fullPath, entry.name)) {
          yield fullPath;
        }
      }
    }
  }
}

export async function readJsonl(filePath, onRecord) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let parseErrors = 0;

  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) {
      continue;
    }
    try {
      await onRecord(JSON.parse(line), lineNo, line);
    } catch (error) {
      if (error instanceof SyntaxError) {
        parseErrors += 1;
      } else {
        throw error;
      }
    }
  }

  return { lineCount: lineNo, parseErrors };
}
