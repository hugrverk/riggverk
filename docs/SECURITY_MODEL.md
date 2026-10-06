# Security Model

## Core principles

- **Agent Workspace manages only explicit allowlisted files.** It may read the complete contents of an allowlisted Codex, OpenCode, Cursor MCP, or backup target locally when required to parse, compare, preserve, validate, merge, or restore it. Only documented keys or named entries are modified; unrelated user-owned values are preserved or cause a safe refusal. Credential-like values present inside such files are not intentionally extracted for use, authenticated with, logged, transmitted, or exposed in command output.
- **All writes are opt-in.** Install or Update requires explicit user action after an artifact-level preview.
- **No credential use or transmission.** Agent Workspace does not authenticate with, intentionally extract, transmit, log, or expose credential-like values. Allowlisted config targets and their backups may contain unrelated user values, including credential-like values, because complete bytes may need to be preserved and restored. That data remains local and is read only for bounded parsing, preservation, validation, comparison, merge, and rollback.
- **No remote execution.** Scripts run on local files only. The app does not accept remote commands, webhooks, or IPC from external processes.
- **No unrelated credential surfaces.** The app does not inspect unrelated credential stores, `.env` files, private keys, browser profiles, sessions, trust databases, keychains, or arbitrary personal files outside the allowlisted managed surfaces below.

## Managed surfaces

The app writes only to these known user-config and app-support paths:

| Surface | Path |
|---------|------|
| OpenCode config | `~/.config/opencode/opencode.json` (managed-key merge) |
| OpenCode model override | app support dir plus `opencode-model-selection.json` (non-secret model preference) |
| OpenCode agents | `~/.config/opencode/agents/` |
| OpenCode rules | `~/.config/opencode/AGENTS.md` (managed block merge) |
| OpenCode skills | `~/.config/opencode/skills/` |
| Codex config | `~/.codex/config.toml` (allowlisted Codex model/routing/approval defaults merge only) |
| Codex agents | `~/.codex/agents/` |
| Codex rules | `$CODEX_HOME/AGENTS.md` (typically `~/.codex/AGENTS.md`; managed block merge) |
| Codex skills | `$CODEX_HOME/skills/` (typically `~/.codex/skills/`) |
| Claude rules | `~/.claude/CLAUDE.md` (managed block merge) |
| Claude agents | `~/.claude/agents/` |
| Claude skills | `~/.claude/skills/` |
| Cursor agents | `~/.cursor/agents/` |
| Cursor skills | `~/.cursor/skills/` |
| Cursor MCP | `~/.cursor/mcp.json` (Playwright entry only) |

Rules files are read in full (up to 4 MB) to locate the managed block. Only the bytes between the BEGIN and END markers are written; text outside them is preserved byte-for-byte, and a file with malformed markers, a diverged pre-block file, or an edited block is refused with zero mutation. The only explicit exception is the user-confirmed rules conversion, which previews the exact resulting file and runs as a backed-up transaction. Backups copy the whole file, so user text in a rules file is stored in the backup root like any other backed-up target. The "leave as is" choice is stored as non-secret identities in `<workspace>/.agent-workspace/rules-preferences.json`.

App support and backup roots are platform-resolved:

| Platform | App support dir | Backup root |
|----------|-----------------|-------------|
| macOS | `~/Library/Application Support/ai.agentworkspace.app` | `~/Library/Application Support/ai.agentworkspace.app/backups` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app` | `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app/backups` |

All writes are preceded by backup. Rollback restores exact prior state using a single shared persisted rollback core: per-artifact `in_flight` status is recorded before mutation, interrupted rollbacks reconcile against post-apply and backup digests without overwriting unrelated user edits, and conflicts fail closed.

Installation mutations are serialized in the trusted Rust backend. Packaged resources and runtime destinations are resolved separately and must never be the same root. Bounded copy and removal helpers require an explicit allowlisted root, reject dangling destination symlinks, and validate parent chains before creating or removing trees. Managed reconciliation uses the shared path-safety and safe-filesystem owners. Preview confirmation tokens are opaque, one-time, in-memory, and must not appear in logs or diagnostics.

OpenCode agent permissions are composed from `templates/opencode.policy.json` plus small `templates/opencode/agents/*.role.json` overrides. Restrictive roles use explicit `composition.replace_sections` so bash/edit profiles replace inherited capability sections instead of shallow-merging them. Shared secret denials remain canonical in the base policy. Generated `agents/*.md` adapters are deterministic outputs—edit sources, not generated headers. `scripts/validate_opencode_permissions.py` enforces the semantic permission contract in release-check.

## What the app does NOT access

- `.env` files or arbitrary secret environment values. The app reads documented operational environment variables needed for platform paths, development isolation, test isolation, and tool-home resolution; environment values must not be printed or persisted as user content.
- Private keys, cookies, or credential stores
- Browser profiles, bookmarks, or saved passwords
- System keychains, SSH agents, or GPG state
- IDE authentication state, tokens, sessions, or trust databases
- Unrelated IDE settings files or MCP server payloads outside the allowlisted Cursor MCP entry
- Project `.git/` directories (except repo dashboard read-only git commands)

## Scripts

All bundled scripts run locally with fixed allowlisted arguments. No script accepts arbitrary user-supplied commands or file paths. Default mode is dry-run; `--apply` is required for writes.

## Backups

Backups are stored under the platform-resolved backup root shown above, unless `AGENT_WORKSPACE_BACKUP_DIR` overrides it. Each backup is timestamped and maps to one allowlisted target surface. Backups contain copies of files before modification.

Backup contents are read locally only for validation, comparison, and rollback restoration. The app does not transmit backup data. Backup reads are limited to allowlisted restore targets involved in a named rollback command; credential-like values encountered there are not intentionally extracted, authenticated with, logged, transmitted, or exposed in command output.

## Release verification

The release check (`scripts/release-check.sh`) runs read-only validation: source format, template validity, skill count, agent adapter currency, and contract checks. It never writes user config or runs apply commands.

## Dependencies

- [Tauri](https://tauri.app) — application shell with scoped IPC, no remote code loading
- [serde](https://serde.rs) (MIT) — serialization
- [React](https://react.dev) / [TypeScript](https://www.typescriptlang.org) (MIT) — UI
- [Vite](https://vite.dev) (MIT) — build tool

No AI model, no cloud service, no telemetry, no analytics.
