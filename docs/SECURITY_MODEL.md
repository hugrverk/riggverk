# Security Model

## Core principles

- **Agent Workspace manages only explicit allowlisted files.** It never reads or writes private configuration, credentials, tokens, environment values, or authentication state.
- **All writes are opt-in.** Every sync action requires explicit user action (button click or command). Workspace repair copies only missing bundled files and never overwrites user edits.
- **No secrets in transit or at rest.** The app does not store, encrypt, or transmit credentials. It does not maintain a session or authenticate to external services.
- **No remote execution.** Scripts run on local files only. The app does not accept remote commands, webhooks, or IPC from external processes.
- **No credential-bearing surfaces.** The app never inspects `.env*`, private keys, cookies, sessions, auth headers, IDE settings files, MCP credentials, or private URLs.

## Managed surfaces

The app writes only to these known paths under user home:

| Surface | Path |
|---------|------|
| OpenCode config | `~/.config/opencode/opencode.json` (managed-key merge) |
| OpenCode agents | `~/.config/opencode/agents/` |
| OpenCode rules | `~/.config/opencode/AGENTS.md` |
| OpenCode skills | `~/.config/opencode/skills/` |
| Codex config | `~/.codex/config.toml` (managed-section merge) |
| Codex agents | `~/.codex/agents/` |
| Codex rules | `~/.codex/AGENTS.md` |
| Codex skills | `~/.agents/skills/` |
| Claude rules | `~/.claude/CLAUDE.md` |
| Claude agents | `~/.claude/agents/` |
| Claude skills | `~/.claude/skills/` |
| Cursor agents | `~/.cursor/agents/` |
| Cursor skills | `~/.cursor/skills/` |
| Cursor MCP | `~/.cursor/mcp.json` (Playwright entry only) |

All writes are preceded by backup. Rollback restores exact prior state using a single shared persisted rollback core: per-artifact `in_flight` status is recorded before mutation, interrupted rollbacks reconcile against post-apply and backup digests without overwriting unrelated user edits, and conflicts fail closed.

Setup lifecycle mutations are serialized in the trusted Rust backend. Deprecated skill cleanup rejects dangling symlinks, symlinked backup paths, and traversal outside allowlisted roots using the shared path-safety owner. Preview confirmation tokens are opaque, one-time, in-memory, and must not appear in logs or diagnostics.

OpenCode agent permissions are composed from `templates/opencode.policy.json` plus small `templates/opencode/agents/*.role.json` overrides; generated `agents/*.md` adapters are deterministic outputs—edit sources, not generated headers.

## What the app does NOT access

- IDE authentication state, tokens, sessions, or trust databases
- Environment variables or `.env` files
- Private keys, cookies, or credential stores
- MCP credentials or MCP server payloads
- Browser profiles, bookmarks, or saved passwords
- System keychains, SSH agents, or GPG state
- Project `.git/` directories (except repo dashboard read-only git commands)
- Settings files for Claude, Cursor, OpenCode, or Codex (rules/agents/skills only)

## Scripts

All bundled scripts run locally with fixed allowlisted arguments. No script accepts arbitrary user-supplied commands or file paths. Default mode is dry-run; `--apply` is required for writes.

## Backups

Backups are stored under `~/Library/Application Support/ai.agentworkspace.app/backups`. Each backup is timestamped and maps to one allowlisted target surface. Backups contain copies of files before modification. The app never reads backup file contents.

## Release verification

The release check (`scripts/release-check.sh`) runs read-only validation: source format, template validity, skill count, agent adapter currency, and contract checks. It never writes user config or runs apply commands.

## Dependencies

- [Tauri](https://tauri.app) — application shell with scoped IPC, no remote code loading
- [serde](https://serde.rs) (MIT) — serialization
- [React](https://react.dev) / [TypeScript](https://www.typescriptlang.org) (MIT) — UI
- [Vite](https://vite.dev) (MIT) — build tool

No AI model, no cloud service, no telemetry, no analytics.
