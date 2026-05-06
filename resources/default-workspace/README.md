# Agent Workspace

Your workspace for managing agent skills, rules, configuration, and scripts.

This directory stores docs, skills, templates, config, and scripts that the app can read, display, and sync to agent tool folders. It is user-owned and can be versioned with git.

Workspace files are plain text. The app does not encrypt them. Do not store secrets, tokens, passwords, private keys, cookies, auth headers, signed/private URLs, or `.env` values in this workspace, and do not commit those values to GitHub.

## What lives here

- **docs/** — documentation about workspace concepts, skills, rules, config, and troubleshooting
- **skills/** — agent skills (each skill in its own folder with a `SKILL.md`). 22 starter skills are bundled.
- **templates/** — source templates for agent rules (`global-agent-rules.md`) and OpenCode config (`opencode.json`)
- **scripts/** — real workspace sync and install scripts that the app calls. All scripts default to dry-run; use `--apply` to write files and `--diff` to preview changes.
- **.ux-workspace/** — workspace identity marker (do not delete)

## Scripts

All scripts default to safe dry-run mode. Pass `--apply` to write, `--diff` to see changes, `--quiet` for compact output, and `--help` for usage.

- **`install-agent-rules.sh`** — syncs `templates/global-agent-rules.md` to Codex, OpenCode, Claude, Gemini, and Auggie rule paths. Supports per-target flags (`--codex`, `--opencode`, etc.) and `--all`.
- **`install-opencode-config.sh`** — syncs `templates/opencode.json` to the OpenCode config path.
- **`install-skills.sh`** — installs skills to native agent skill folders. Supports `--list`, `--dry-run`, `--agent` (all five agents), `--global`/`--project`, `--skill`, and `--all`.
- **`bootstrap.sh`** — runs rules, config, and skills steps together. Supports `--skip-*`, `--*-only`, and narrow rule/skill agent flags.

All writes are explicit and allowlisted. Existing diverged target files are backed up before overwrite under `~/Library/Application Support/ai.agentworkspace.app/backups`. Project skill install requires a real project marker (`.git`, `package.json`, etc.) and rejects broad parent directories. Use dry-run or diff before every apply.

## Separation

This workspace folder is separate from the app source code. The app operates on a workspace folder; the workspace does not need to contain the app.

## Start here

- [docs/START_HERE.md](docs/START_HERE.md) — first 5 minutes, safe first actions, what the app can and cannot do
- [docs/CONCEPTS.md](docs/CONCEPTS.md) — core terms and mental model
- [docs/USING_THE_APP.md](docs/USING_THE_APP.md) — practical walkthrough of each tab
- [docs/GIT_VERSIONING.md](docs/GIT_VERSIONING.md) — how to version the workspace with Git and GitHub
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md) — common workflow recipes
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — help when things go wrong
