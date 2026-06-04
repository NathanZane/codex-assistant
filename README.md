# codex-assistant

Local-first Codex hygiene/audit CLI for finding avoidable token bloat and stale
session logs. The current MVP is intentionally small and modular:

- **Skill Check:** finds skills with no explicit usage evidence in a time window
  and estimates startup tokens saved if they were disabled or moved local.
- **JSONL Size Check:** finds stale active, sub-agent, and archived rollout logs
  that can be trashed.
- **AGENTS Check:** finds current and historically read `AGENTS.md` token
  footprints across active top-level projects and highlights the largest review
  candidates.

## Install

Requires Node.js 20 or newer and a local Codex install with state under
`~/.codex` or another path passed with `--codex-home`.

Install the current beta from npm:

```bash
npm install -g @nathanzane/codex-assistant@beta
codex-assistant
```

Or try it once without a global install:

```bash
npx @nathanzane/codex-assistant@beta
```

## Commands

The simplest way to check for bloat is to run `codex-assistant`.
It runs the checks one at a time: rollout size first, then unused skills, then
large `AGENTS.md` footprints. When it finds something actionable, such as
stale or archived rollouts, it offers the relevant cleanup step in the terminal.

You can also run individual checks and cleanups directly:

```bash
codex-assistant
codex-assistant check
codex-assistant check rollouts
codex-assistant check skills
codex-assistant check agents
codex-assistant skills  # alias for check skills
codex-assistant rollouts  # alias for check rollouts
codex-assistant agents  # alias for check agents
codex-assistant startup
codex-assistant project <path>
codex-assistant cleanup
codex-assistant cleanup skills
codex-assistant cleanup rollouts
codex-assistant uninstall
```

Every command accepts `--codex-home <path>` and `--json`.
Running `codex-assistant` with no subcommand is the same as `codex-assistant check`.
In an interactive terminal, the generic check offers prioritized cleanup guidance
for stale rollouts and never-used skills.

Advanced options are:

```bash
codex-assistant check --days 30
codex-assistant check --only agents
codex-assistant check --only skills
codex-assistant check --only jsonl
codex-assistant check agents --limit 10
codex-assistant check rollouts --archived-stale-days 3
codex-assistant check rollouts --min-size-mb 100
codex-assistant check skills --days 30 --sessions-limit 100
codex-assistant check skills --all-time
codex-assistant cleanup skills
codex-assistant cleanup skills --never-used --apply
codex-assistant cleanup skills --restore --apply
codex-assistant startup --project .
codex-assistant cleanup rollouts
codex-assistant cleanup rollouts --archived --apply
codex-assistant cleanup rollouts --sub-agents --apply
codex-assistant cleanup rollouts --quarantined --apply
codex-assistant cleanup rollouts --restore --apply
codex-assistant cleanup rollouts --manual
codex-assistant uninstall --apply
codex-assistant uninstall --rollouts restore --delete-cache --delete-backups --apply
```

## What It Scans

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`
- `~/.codex/session_index.jsonl`
- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- `~/.codex/skills/**/SKILL.md`
- `~/.codex/plugins/cache/**/skills/**/SKILL.md`
- `.agents/skills/**/SKILL.md` when present
- `AGENTS.md` files from each Codex session working directory upward

## Safety Model

- Session JSONL files are streamed line-by-line.
- Reports avoid raw prompt, message, or tool output content.
- Findings use paths, counts, timestamps, token estimates, byte sizes, and
  short SHA-256 hashes.
- Rollout cleanup first previews exact planned actions. `--apply` quarantines
  selected rollout files into `~/.codex/quarantine/rollouts/` using the same
  folder structure as Codex, such as `quarantine/rollouts/sessions/...` and
  `quarantine/rollouts/archived_sessions/...`.
- By default, rollout cleanup targets archived rollouts older than 3 days,
  sub-agent rollouts older than 7 days, and active top-level rollouts older
  than 30 days. The sub-agent bucket includes Codex helper sub-agent sessions.
  There is no default size threshold; use `--min-size-mb` if you want one.
- Running `cleanup rollouts` again shows quarantined files as a trash option
  when present; applying that option sends them to system trash where the OS
  supports it.
- `cleanup rollouts --restore --apply` moves quarantined rollout files back to
  their mirrored Codex session folders when the original path is empty.
- `cleanup skills --apply` updates only `[[skills.config]]` entries in
  `config.toml` and creates a timestamped backup first. It does not delete skill
  files or plugin cache data.
- `cleanup skills` restore is targeted. It uses metadata saved with the backup
  to restore only the skills changed by `codex-assistant`, so unrelated
  `config.toml` edits made afterward are preserved.
- `check` uses a local file-analysis cache at
  `~/.codex/cache/codex-assistant/cache-v1.json`.
- Cache entries invalidate when a session file size or modified time changes.
  Startup-only metadata may be reused while a JSONL grows; full-file scans such
  as skill usage evidence and AGENTS reads are recomputed for growing files so
  recent activity is not missed. Use `--refresh-cache` to force recompute or
  `--no-cache` to disable the cache.
- `uninstall` previews a final cleanup. If quarantined rollouts exist, it asks
  whether to restore, trash, or leave them. It can delete
  `~/.codex/cache/codex-assistant` and `~/.codex/backups/codex-assistant`, then
  runs `npm uninstall -g @nathanzane/codex-assistant`. Shared npm cache and npm
  log folders are not deleted. It does not change current skill config; restore
  skill config before uninstalling if you want to undo a previous skill cleanup.

Token estimates use `ceil(chars / 4)`. Exact token usage is reported when Codex
session `token_count` events include it.

## Public-Use Notes

- Specific checks like `codex-assistant check rollouts`, `check skills`, and
  `check agents` are read-only. The generic `codex-assistant` / `check` flow may
  offer cleanup, but files or config change only after explicit confirmation.
- Cleanup commands are conservative by default. Interactive cleanup asks for
  confirmation; non-interactive cleanup requires `--apply`.
- `uninstall` follows the same safety model: it previews the restore/delete/npm
  actions first and requires confirmation or `--apply`.
- Rollout quarantine moves files to `~/.codex/quarantine/rollouts/` first.
  Trashing quarantined files is a separate cleanup choice.
- Skill cleanup edits only simple `[[skills.config]]` tables with string `name`
  and boolean `enabled` fields. Other `config.toml` content is preserved.
- Token counts are estimates unless Codex recorded exact token usage events.

## License

MIT. See [LICENSE](./LICENSE).
