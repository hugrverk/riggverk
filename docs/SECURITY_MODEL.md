# Security Model

## Core principles

- **Writes go only to the allowlisted paths below.** The app may read the complete contents of an allowlisted Codex, OpenCode, Cursor MCP, rules, or backup file locally when it must parse, compare, preserve, validate, merge, or restore it. Only documented keys, named entries, or the managed rules block are modified; unrelated user-owned values are preserved or cause a safe refusal with zero mutation.
- **Writes are explicit.** Install or Update shows an artifact-level plan (create, update, remove, conflict rows) and writes only after the user presses `y`. Uninstall and rollback show a preview or dry run and ask for confirmation. Library saves write only the selected workspace file. Settings are an app preference and autosave. Nothing is written on launch.
- **Target toggles gate Install.** A surface whose target toggle or harness is off is excluded from preview, apply, and status; the backend rejects it even if a stale request names it.
- **No credential use by the app.** The app does not authenticate with, intentionally extract, log, transmit, or expose credential-like values. Allowlisted config files and their backups can contain such values because complete bytes may need to be preserved and restored; that data stays local and is read only for bounded parsing, comparison, merge, and rollback.
- **No remote control.** The app accepts no remote commands, webhooks, or external IPC. The only network access is the Repo Dashboard, described below. No telemetry, no analytics, no cloud service, no AI model.
- **No unrelated credential surfaces.** The app does not inspect `.env` files, private keys, browser profiles, sessions, trust databases, keychains, or personal files outside the surfaces below.

## What the app writes

| Surface | Path | Notes |
|---------|------|-------|
| Workspace root | `~/.config/agent-workspace` (Settings workspace path or `AGENT_WORKSPACE_PATH` override) | Bundled files via Install; Library saves and created docs (`docs/context/*.md`) via atomic, symlink-refusing writes. Scripts in it are never run by the app. |
| Managed state | `<workspace>/.agent-workspace/managed-state.json` | Schema 2, SHA-256 ownership proof. Prior bytes saved as `managed-state.previous.json` in the transaction backup. |
| Rules preferences | `<workspace>/.agent-workspace/rules-preferences.json` | "Leave as is" choices, as non-secret identities. |
| App settings | `settings.json` in the app support dir | Autosaved. A corrupt file is renamed aside and defaults load. Not backed up. |
| OpenCode model override | `opencode-model-selection.json` in the app support dir | Non-secret model preference. Not backed up. |
| Backups | `backups/` in the app support dir (or `AGENT_WORKSPACE_BACKUP_DIR`) | Layout below. |
| OpenCode config | `~/.config/opencode/opencode.json` | Managed-key merge. |
| OpenCode TUI config | `~/.config/opencode/tui.json` | Whole-file managed copy. |
| Playwright MCP config | `~/.config/playwright-mcp/config.json` (or `PLAYWRIGHT_MCP_CONFIG_PATH`) | Rendered from `templates/playwright-mcp.config.json`. |
| OpenCode agents / skills | `~/.config/opencode/agents/`, `~/.config/opencode/skills/` | |
| OpenCode rules | `~/.config/opencode/AGENTS.md` | Managed block merge. |
| Codex config | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) | Allowlisted keys only; `model` and `model_reasoning_effort` create-only. Target `codex_config`, off by default. |
| Codex agents / skills | `$CODEX_HOME/agents/`, `$CODEX_HOME/skills/` | |
| Codex rules | `$CODEX_HOME/AGENTS.md` | Managed block merge. |
| Claude rules | `~/.claude/CLAUDE.md` | Managed block merge. |
| Claude agents / skills | `~/.claude/agents/`, `~/.claude/skills/` | |
| Cursor agents / skills | `~/.cursor/agents/`, `~/.cursor/skills/` | |
| Cursor MCP | `~/.cursor/mcp.json` | Playwright entry only. |

Rules files are read in full (up to 4 MB) to locate the managed block. Only the bytes between the BEGIN and END markers are written; text outside them is preserved byte-for-byte, and a file with malformed markers, a diverged pre-block file, or an edited block is refused with zero mutation. The only explicit exception is the user-confirmed rules conversion, which previews the exact resulting file and runs as a backed-up transaction. Backups copy the whole file, so user text in a rules file is stored in the backup root like any other backed-up target. The "leave as is" choice is stored as non-secret identities in `<workspace>/.agent-workspace/rules-preferences.json`.

App support and backup roots are platform-resolved:

| Platform | App support dir | Backup root |
|----------|-----------------|-------------|
| macOS | `~/Library/Application Support/ai.agentworkspace.app` | `<app support>/backups` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app` | `<app support>/backups` |
| Windows | `%APPDATA%\ai.agentworkspace.app` | `<app support>\backups` |

Backup roots reject `/`, the home directory, and drive roots.

## Backups

Existing files that Install, uninstall, or a Library save would overwrite or remove are backed up first. Files that do not exist yet, `settings.json`, and the model override have no backup.

| Writer | Location under the backup root |
|--------|--------------------------------|
| Install, uninstall, rollback | `setup/<transaction id>/` with `manifest.json`, `artifacts/<artifact id>`, and `managed-state.previous.json` |
| Library save | `docs/<doc id>-<timestamp>/<file>` |
| Cursor operations and CLI scripts | `<YYYYMMDD-HHMMSS>/<label>/<file>` |

The app creates backup directories 0700 and files 0600 on Unix. CLI scripts use the same layout and your umask. Backups are read locally for validation, comparison, and rollback only and are never transmitted. Rollback restores exact prior state from a persisted transaction: per-artifact `in_flight` is recorded before mutation, interrupted rollbacks reconcile against post-apply and backup digests without overwriting unrelated user edits, and conflicts fail closed. The in-app rollback entry (`z`, `:rollback`) covers the last transaction of the current session.

Installation mutations are serialized in the trusted Rust backend. Packaged resources and runtime destinations are resolved separately and must never be the same root. Bounded copy and removal helpers require an explicit allowlisted root, reject dangling destination symlinks, and validate parent chains before creating or removing trees. Preview confirmation tokens are opaque, one-time, in-memory, expire after 600 seconds, and must not appear in logs or diagnostics.

OpenCode agent permissions are composed from `templates/opencode.policy.json` plus small `templates/opencode/agents/*.role.json` overrides. Restrictive roles use explicit `composition.replace_sections` so bash/edit profiles replace inherited capability sections instead of shallow-merging them. Shared secret denials remain canonical in the base policy. Generated `agents/*.md` adapters are deterministic outputs; edit sources, not generated headers. `scripts/validate_opencode_permissions.py` enforces the semantic permission contract in release-check.

## Symlinks

Managed writes (Install, uninstall, rollback, backups) reject symlinked targets, symlinked parent chains, and dangling symlinks. Skill discovery rejects symlinked skill roots, groups, and directories. Library document, rules, and config reads and writes enforce workspace containment and refuse symlinks; the custom doc listing skips them.

## Repo Dashboard

The Repo Dashboard is the one feature that is not read-only and touches the network. For a repository you select it runs:

- `git fetch --quiet --prune -- origin <branch>` (writes remote-tracking refs and `FETCH_HEAD` in that repository's `.git`),
- `git rev-parse`, `status`, and `log` (local),
- `gh auth status`, `gh pr list`, and `gh issue list` (optional enrichment, bounded by `--limit`).

Fetch and `gh` use your own git credential helpers, SSH agent, and `gh` login; the app never reads those credentials. Hardening: every git call runs with `core.fsmonitor=false` and an empty `core.hooksPath`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, branch names validated and passed after `--`, the repository top level required, a timeout, a process-group kill, and capped output. Other repository config, such as remotes, `core.sshCommand`, and credential helpers, is still honored, so open only trusted repositories.

## Scripts

The app runs its `python3` merge and generator helpers from the bundled, read-only copy, never from the editable runtime workspace, with fixed arguments. It never uses `sh -c` or a shell plugin (`check-shell-spawn.py` enforces this in release-check). The one exception is the user-triggered release check (`R` on the Workspace page, `:release-check`): it runs `scripts/release-check.sh` from the workspace when that file exists. The bundled workspace does not contain it, so the action is unavailable unless you put the script there yourself; treat a workspace you did not create as untrusted before running it.

The CLI scripts in `scripts/` are for operators and are not called by the app (except the bundled Python helpers). They default to dry-run, require `--apply` to write, back up an existing target and verify the copy before overwriting it, refuse a rules file that holds a managed block, refuse broad backup and agents directories, and take target overrides from `--target` or environment variables. They are macOS and Linux only; Git Bash and MSYS are refused unless `AGENT_WORKSPACE_BACKUP_DIR` is set.

## What the app does NOT access

- `.env` files or arbitrary secret environment values. The app reads documented operational variables (workspace, backup, Codex home, skill roots, Playwright, XDG, `HOME`, `PATH`); their values must not be printed or persisted as user content.
- Private keys, cookies, or credential stores.
- Browser profiles, bookmarks, or saved passwords.
- System keychains, SSH agent state, or GPG state (git and `gh` may use them on their own during Repo Dashboard calls).
- IDE authentication state, tokens, sessions, or trust databases.
- Unrelated IDE settings or MCP server payloads outside the allowlisted Cursor MCP entry.
- Project `.git/` directories, except the Repo Dashboard commands above.

## Process output

Command output is redacted for display and capped at 16 MB per stream. Helper subprocesses run with a 120 s default timeout and Repo Dashboard calls with their own; a timeout kills the whole process group. The release check gets a longer limit.

## Release verification

`scripts/release-check.sh` validates source format, templates, skill count, adapter currency, and contracts. It runs apply smokes against temporary `HOME` directories and never writes the real user config. See [RELEASE.md](./RELEASE.md).

## Dependencies

- [Tauri](https://tauri.app) - application shell. The webview CSP allows only `'self'` and IPC; capabilities are window dragging and the folder dialog.
- [serde](https://serde.rs), [React](https://react.dev), [TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev) (MIT).
