# Agent Workspace

Your workspace for agent skills, rules, configuration, and scripts.

This directory holds the docs, skills, templates, config, and scripts that the Agent Workspace app displays and installs into agent tool folders. It is user-owned and can be versioned with Git. Installs always come from the app's bundled copy; edits you make here do not change what the tools receive (see [docs/CONCEPTS.md](docs/CONCEPTS.md)).

Workspace files are plain text and not encrypted. Do not store secrets, tokens, passwords, private keys, cookies, auth headers, signed or private URLs, or `.env` values here, and do not commit them.

Requires Python 3 on `PATH` (config merges and generators). The CLI scripts also need Bash and run on macOS and Linux only.

## What lives here

- **docs/** - guides and reference. **docs/prompt-templates/** holds the Prompt, Goal Prompt, and Batch Prompt templates; they appear under Library -> Docs.
- **skills/** - canonical skill sources. 22 skills ship with the default workspace.
- **templates/skills/** - generated harness-specific skill adapters and overlay sources.
- **templates/** - source templates for agent rules (`global-agent-rules.md`, composed under `sync/`), OpenCode config, Codex config (`codex/`), and Cursor assets (`cursor/`).
- **agents/**, **agent-specs/** - OpenCode agents and the shared agent bodies.
- **metadata/** - generated manifests and the history of shipped rules bases.
- **scripts/** - CLI installers and helpers for use outside the app.
- **.agent-workspace/** - identity marker and ownership records (`workspace.json`, `managed-state.json`, `rules-preferences.json`). Do not delete. They describe this machine's installs, so leave `managed-state.json` and `rules-preferences.json` out of Git.

## Scripts

The app does not call the installer scripts; it installs natively and uses only its own bundled Python helpers. The scripts are a command-line alternative for operators.

All installer scripts default to dry-run. `--apply` writes, `--diff` shows differences, `--quiet` gives compact output, `--help` shows usage. Before overwriting an existing target they copy it to the backup root and stop when that copy fails. They refuse a rules file that holds the app's managed block, and broad backup or agents directories. Run them from the workspace root.

macOS and Linux only. On Windows use the app; Git Bash and MSYS are refused unless `AGENT_WORKSPACE_BACKUP_DIR` is set, and the scripts are not tested there.

- `generate-opencode-config.py` - builds `templates/opencode.json` from `opencode.base.json` and `opencode.policy.json`. `--check` verifies, `--write` regenerates.
- `install-agent-rules.sh` - copies composed rules to Codex, OpenCode, and Claude paths (`--codex`, `--opencode`, `--claude`, `--all`).
- `install-opencode-config.sh` - managed-key merge into the OpenCode config, `tui.json`, agents, and the Playwright MCP config. `--apply-cursor` also merges the Playwright server into `~/.cursor/mcp.json`. Pinned `@playwright/mcp@0.0.48`, Chromium, shared browser cache.
- `install-codex-config.sh` - managed-key merge into the Codex config. `--force-overwrite` replaces the whole file after backup (advanced).
- `install-codex-agents.sh`, `install-runtime-agents.sh` - Codex TOML agents, and OpenCode or Claude Markdown agents.
- `install-cursor-workspace.sh` - Cursor User Rules helper and project installs. It never writes `~/.cursor/agents`.
- `install-skills.sh` - installs generated skill adapters (`--agent`, `--global`, `--dry-run`, `--apply`).
- `bootstrap.sh` - runs rules, config, and skills together.

Backups: `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS, `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app/backups` on Linux, or `AGENT_WORKSPACE_BACKUP_DIR`. Layout in [docs/USING_THE_APP.md](docs/USING_THE_APP.md#backups).

## Separation

This folder is separate from the app source. The app operates on a workspace folder; the workspace does not contain the app.

## Start here

- [docs/START_HERE.md](docs/START_HERE.md) - first install, the essential keys, what the app does and does not do
- [docs/CONCEPTS.md](docs/CONCEPTS.md) - terms and the mental model
- [docs/USING_THE_APP.md](docs/USING_THE_APP.md) - pages, keyboard reference, install review, backups
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md) - recipes
- [docs/GIT_VERSIONING.md](docs/GIT_VERSIONING.md) - versioning the workspace
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - when something goes wrong
