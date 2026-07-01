# Agent Workspace

Your workspace for managing agent skills, rules, configuration, and scripts.

This directory stores docs, skills, templates, config, and scripts that the app can read, display, and sync to agent tool folders. It is user-owned and can be versioned with git.

Workspace files are plain text. The app does not encrypt them. Do not store secrets, tokens, passwords, private keys, cookies, auth headers, signed/private URLs, or `.env` values in this workspace, and do not commit those values to GitHub.

## What lives here

- **docs/** — documentation about workspace concepts, skills, rules, config, and troubleshooting. **docs/prompt-templates/** holds Standard, Masterprompt, and Batchprompt templates; they appear in the app under Library → Docs after installation.
- **skills/** — canonical semantic skill sources. 21 bundled skills ship with the default workspace.
- **templates/skills/** — generated harness-specific skill adapters and overlay sources.
- **templates/** — source templates for agent rules (`global-agent-rules.md`), OpenCode config (`opencode.json`), Codex config (`templates/codex/`), and Cursor setup assets (`templates/cursor/`). Cursor global setup is applied from the app via native Rust operations; `install-cursor-workspace.sh` remains a small CLI helper for User Rules and optional project-target installs.
- **scripts/** — real workspace sync and install scripts that the app calls. All scripts default to dry-run; use `--apply` to write files and `--diff` to preview changes.
- **.agent-workspace/** — workspace identity marker (do not delete)

## Scripts

All scripts default to safe dry-run mode. Pass `--apply` to write, `--diff` to see changes, `--quiet` for compact output, and `--help` for usage.

The bundled installer scripts are macOS/Linux POSIX-style shell scripts run with Bash. Windows app-path logic exists in the native Rust app backend, but native Windows script support is not currently covered.

- **`generate-opencode-config.py`** — generates `templates/opencode.json` from `templates/opencode.base.json` and `templates/opencode.policy.json`. Supports `--check` (verify snapshot currency) and `--write` (regenerate snapshot). Paths are workspace-relative.
- **`install-agent-rules.sh`** — syncs `templates/global-agent-rules.md` to Codex, OpenCode, and Claude rule paths. Supports per-target flags (`--codex`, `--opencode`, etc.) and `--all`.
- **`install-opencode-config.sh`** — syncs `templates/opencode.json` to the OpenCode config path, installs `~/.config/playwright-mcp/config.json`, and optionally merges Playwright MCP into `~/.cursor/mcp.json` (`--apply-cursor`). Uses pinned `@playwright/mcp@0.0.48`, Chromium (not Chrome channel), and a shared user-global browser cache — not `@latest` or `PLAYWRIGHT_BROWSERS_PATH=0`.
- **`install-codex-config.sh`** — syncs Codex config with managed-section merge that enforces the bundled model/routing/approval defaults while preserving user personality, MCP settings, and unrelated tables. `--apply` performs safe merge; `--force-overwrite` replaces the full file after backup (advanced).
- **`install-cursor-workspace.sh`** — manual Cursor helpers and CLI-only project installs. Global setup (agents, managed skills, Playwright MCP) is handled by the Agent Workspace app via native Rust operations. The script never writes `~/.cursor/agents`.
- **`install-skills.sh`** — installs generated skill adapters to native agent skill folders. App uses `--global` only.
- **`bootstrap.sh`** — runs rules, config, and skills steps together. Supports `--skip-*`, `--*-only`, and narrow rule/skill agent flags.

All writes are explicit, previewed, and allowlisted. Existing managed targets are backed up before replacement under the platform backup root: `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS, `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app/backups` on Linux. The Agent Workspace app manages global/home config only. Cursor installation never writes project `.cursor/*`, `.cursorignore`, or `AGENTS.md`.

## Separation

This workspace folder is separate from the app source code. The app operates on a workspace folder; the workspace does not need to contain the app.

## Start here

- [docs/START_HERE.md](docs/START_HERE.md) — first 5 minutes, safe first actions, what the app can and cannot do
- [docs/CONCEPTS.md](docs/CONCEPTS.md) — core terms and mental model
- [docs/USING_THE_APP.md](docs/USING_THE_APP.md) — practical walkthrough of each tab
- [docs/GIT_VERSIONING.md](docs/GIT_VERSIONING.md) — how to version the workspace with Git and GitHub
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md) — common workflow recipes
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — help when things go wrong
