import os from "node:os";
import path from "node:path";

export function defaultCodexHome() {
  return path.join(os.homedir(), ".codex");
}

export function normalizeInputPath(input) {
  if (!input) {
    return input;
  }
  let value = String(input);
  if (/^[/\\][A-Za-z]:[/\\]/.test(value)) {
    value = value.slice(1);
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function codexPaths(codexHome) {
  return {
    codexHome,
    sessions: path.join(codexHome, "sessions"),
    archivedSessions: path.join(codexHome, "archived_sessions"),
    sessionIndex: path.join(codexHome, "session_index.jsonl"),
    config: path.join(codexHome, "config.toml"),
    hooks: path.join(codexHome, "hooks.json"),
    skills: path.join(codexHome, "skills"),
    pluginCache: path.join(codexHome, "plugins", "cache"),
    assistantCacheDir: path.join(codexHome, "cache", "codex-assistant"),
    assistantCache: path.join(codexHome, "cache", "codex-assistant", "cache-v1.json"),
    assistantBackups: path.join(codexHome, "backups", "codex-assistant"),
    quarantine: path.join(codexHome, "quarantine"),
    rolloutQuarantine: path.join(codexHome, "quarantine", "rollouts"),
  };
}
