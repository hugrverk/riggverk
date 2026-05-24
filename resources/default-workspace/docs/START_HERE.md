# Start Here

## What this is

An agent workspace — a directory of docs, skills, templates, and scripts. The Agent Workspace app installs a runtime copy at `~/.config/agent-workspace`, displays its contents, and syncs templates to agent tool folders.

## What the app is and is not

The app helps you:

- Browse and edit workspace docs, skills, templates, and rules
- Preview sync operations (dry-run/diff) before writing files
- Sync agent rules and safe config targets to tool folders from harness pages
- Install skills per tool from harness pages
- Run release verification when the workspace includes release-check

The app does not:

- Write files automatically on launch — use **install** or **repair** on Workspace
- Ask you to choose an arbitrary folder in normal UI
- Manage GitHub auth or create remotes
- Encrypt workspace contents
- Run agents or change tool config from Brain Setup alone

## Mental model

- **The app** manages install, display, and sync operations.
- **The workspace** is plain-text data at `~/.config/agent-workspace` (or `AGENT_WORKSPACE_PATH` for dev/test).
- Nothing is overwritten without an explicit action.

## Safe first steps

1. Open **Workspace** — if missing, click **install**.
2. Open **Library** — read this doc, Concepts, and guides.
3. Read [CONCEPTS.md](CONCEPTS.md).
4. Open a harness page (e.g. Codex) — run **Diff Rules** before **Sync Rules**.
5. Review `templates/global-agent-rules.md` and `templates/opencode.json`.

## What to click

- **Workspace**: install, repair, verify, terminal output
- **Harness pages**: per-tool diff/sync and skills install
- **Library**: edit docs, rules, skills, agents, configs; Brain Setup copy block
- **Settings**: appearance, global text size, and colors

## Dry-run before apply

Always preview before apply. Scripts use `--dry-run`, `--diff`, then `--apply`.

## Workspace ownership

Edit freely; version with Git if you want. Do not store secrets, tokens, or `.env` values in workspace files.

## Next steps

- [CONCEPTS.md](CONCEPTS.md)
- [USING_THE_APP.md](USING_THE_APP.md)
- [GIT_VERSIONING.md](GIT_VERSIONING.md)
- Dry-run sync from a harness page before any apply
