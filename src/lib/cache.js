import fsp from "node:fs/promises";
import path from "node:path";
import { statSafe } from "./fs.js";
import { codexPaths } from "./paths.js";

const CACHE_VERSION = 1;

export class AnalysisCache {
  constructor(codexHome, options = {}) {
    const paths = codexPaths(codexHome);
    this.path = options.cachePath || path.join(paths.codexHome, "cache", "codex-assistant", "cache-v1.json");
    this.enabled = !options.noCache;
    this.refresh = Boolean(options.refreshCache);
    this.autoSaveEvery = Number(options.cacheAutoSaveEvery || 100);
    this.lastSavedWrites = 0;
    this.data = { version: CACHE_VERSION, entries: {} };
    this.stats = { hits: 0, reusedGrowing: 0, misses: 0, writes: 0, disabled: !this.enabled, loadError: null, saveError: null };
  }

  async load() {
    if (!this.enabled || this.refresh) {
      return;
    }
    try {
      const text = await fsp.readFile(this.path, "utf8");
      const parsed = JSON.parse(text);
      if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
        this.data = parsed;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.stats.loadError = error.message || String(error);
      }
    }
  }

  async save() {
    if (!this.enabled) {
      return;
    }
    try {
      await fsp.mkdir(path.dirname(this.path), { recursive: true });
      await fsp.writeFile(this.path, `${JSON.stringify(this.data)}\n`, "utf8");
      this.lastSavedWrites = this.stats.writes;
    } catch (error) {
      this.stats.saveError = error.message || String(error);
    }
  }

  async getOrCompute(namespace, filePath, compute, options = {}) {
    if (!this.enabled) {
      this.stats.misses += 1;
      return compute();
    }

    const stat = await statSafe(filePath);
    if (!stat) {
      this.stats.misses += 1;
      return compute();
    }

    const key = cacheKey(namespace, filePath);
    const cached = this.data.entries[key];
    const mtimeMs = Math.trunc(stat.mtimeMs);
    if (!this.refresh && cached && cached.sizeBytes === stat.size && cached.mtimeMs === mtimeMs) {
      this.stats.hits += 1;
      return cached.value;
    }
    if (!this.refresh && options.reuseIfGrowing && cached && stat.size >= cached.sizeBytes) {
      this.stats.hits += 1;
      this.stats.reusedGrowing += 1;
      return cached.value;
    }

    this.stats.misses += 1;
    const value = await compute();
    this.data.entries[key] = {
      sizeBytes: stat.size,
      mtimeMs,
      cachedAt: new Date().toISOString(),
      value,
    };
    this.stats.writes += 1;
    await this.saveIfNeeded();
    return value;
  }

  async saveIfNeeded() {
    if (!this.enabled || !this.autoSaveEvery || this.stats.saveError) {
      return;
    }
    if (this.stats.writes - this.lastSavedWrites < this.autoSaveEvery) {
      return;
    }
    await this.save();
  }
}

function cacheKey(namespace, filePath) {
  return `${namespace}:${path.resolve(filePath).toLowerCase()}`;
}
