# Agent Workspace

Your workspace for agent skills, rules, configuration, and scripts.

This directory holds the docs, skills, templates, config, and scripts that the Agent Workspace app displays and installs into agent tool folders. It is user-owned and can be versioned with Git. Installs always come from the app's bundled copy; edits you make here do not change what the tools receive (see [docs/CONCEPTS.md](docs/CONCEPTS.md)).

Workspace files are plain text and not encrypted. Do not store secrets, tokens, passwords, private keys, cookies, auth headers, signed or private URLs, or `.env` values here, and do not commit them.

Requires Python 3 on `PATH` (config merges and generators).

## What lives here

- **docs/** - guides and reference.
- **skills/** - canonical skill sources. 25 skills ship with the default workspace.
- **templates/skills/** - generated harness-specific skill adapters and overlay sources.
- **templates/** - source templates for agent rules (`global-agent-rules.md`, composed under `sync/`), OpenCode config, Codex config (`codex/`), and Cursor assets (`cursor/`).
- **agents/**, **agent-specs/** - OpenCode agents and the shared agent bodies.
- **metadata/** - generated manifests and the history of shipped rules bases.
- **scripts/** - Python helpers (OpenCode config generator, Codex config merges). The app runs its own bundled copies.
- **.agent-workspace/** - identity marker and ownership records (`workspace.json`, `managed-state.json`, `rules-preferences.json`). Do not delete. They describe this machine's installs, so leave `managed-state.json` and `rules-preferences.json` out of Git.

## Scripts

The app is the installer. It installs natively and runs only its own bundled copies of these Python helpers, never the ones in this folder. They are here to read, and `generate-opencode-config.py` can be run by hand. Python 3 is all they need.

- `generate-opencode-config.py` - builds `templates/opencode.json` from `opencode.base.json` and `opencode.policy.json`. `--check` verifies, `--write` regenerates.
- `merge-codex-config.py`, `ensure-codex-routing-defaults.py` - merge the managed Codex keys and routing defaults into `config.toml` while keeping your own settings.

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
