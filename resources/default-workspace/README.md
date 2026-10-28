# Riggverk workspace

The docs, skills, templates, config, and scripts that the Riggverk app ships and installs into agent tool folders.

This is the bundle: it lives inside the app and is read-only. The Library, the health checks and every install read it from there, so everyone sees the current text; it changes only with an app update. The app keeps no copy of it in your data folder (`~/.config/agent-workspace` by default); the data folder holds only the app's state and your personal docs (see [docs/CONCEPTS.md](docs/CONCEPTS.md)).

Your personal docs are plain text and not encrypted. Do not store secrets, tokens, passwords, private keys, cookies, auth headers, signed or private URLs, or `.env` values in them, and do not commit them.

Requires Python 3 on `PATH` (config merges and generators).

## What lives in the bundle

- **docs/** - guides and reference.
- **skills/** - canonical skill sources. The skills listed in [docs/SKILLS.md](docs/SKILLS.md) ship with the app, and every harness installs each `SKILL.md` unchanged.
- **templates/** - source templates for agent rules (`global-agent-rules.md`, composed under `sync/`), OpenCode config, Codex config (`codex/`), and Cursor assets (`cursor/`).
- **agents/**, **agent-specs/** - OpenCode agents and the shared agent bodies.
- **metadata/** - generated manifests and the history of shipped rules bases.
- **scripts/** - Python helpers (OpenCode config generator, Codex config merges). The app runs its own bundled copies.

## What lives in your data folder

- **.agent-workspace/** - the app's state: ownership records (`managed-state.json`), `kept-files.json`, `rules-preferences.json`, `config-preferences.json`, and the `workspace.json` marker where an earlier release wrote it. Do not delete. They describe this machine's installs, so leave them out of Git.
- **docs/context/** - your personal docs, written in the Library. Version this folder if you want a history ([docs/GIT_VERSIONING.md](docs/GIT_VERSIONING.md)).

Earlier releases also copied the bundle into the data folder. The app no longer reads those copies; it removes the ones it can prove are its own only through the reviewed update of the `workspace` row (see [docs/USING_THE_APP.md](docs/USING_THE_APP.md#workspace-page)).

## Scripts

The app is the installer. It installs natively and runs only its own bundled copies of these Python helpers, never scripts from your data folder. They are here to read, and `generate-opencode-config.py` can be run by hand. Python 3 is all they need.

- `generate-opencode-config.py` - builds `templates/opencode.json` from `opencode.base.json` and `opencode.policy.json`. `--check` verifies, `--write` regenerates.
- `merge-codex-config.py`, `ensure-codex-routing-defaults.py` - merge the managed Codex keys and routing defaults into `config.toml` while keeping your own settings.

Backups: `~/Library/Application Support/se.hugrverk.riggverk/backups` on macOS, `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk/backups` on Linux, or `AGENT_WORKSPACE_BACKUP_DIR`. Layout in [docs/USING_THE_APP.md](docs/USING_THE_APP.md#backups).

## Separation

The bundle is read-only inside the app and is separate from your data folder. Nothing in the data folder changes what the app installs or shows.

## Start here

- [docs/START_HERE.md](docs/START_HERE.md) - first install, the essential keys, what the app does and does not do
- [docs/CONCEPTS.md](docs/CONCEPTS.md) - terms and the mental model
- [docs/USING_THE_APP.md](docs/USING_THE_APP.md) - pages, keyboard reference, install review, backups
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md) - recipes
- [docs/GIT_VERSIONING.md](docs/GIT_VERSIONING.md) - versioning your personal docs
- [docs/SECURITY_BASELINE.md](docs/SECURITY_BASELINE.md) - what limits an agent and what is up to you
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - when something goes wrong
