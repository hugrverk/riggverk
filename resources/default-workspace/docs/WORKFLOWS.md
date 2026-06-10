# Workflows

## Set up OpenCode only

1. **Workspace** — **install** if not already installed.
2. Open **OpenCode** — enable rule and config targets in the Targets panel (changes autosave).
3. **Diff Rules**, then **Sync Rules**; **Diff Configs**, then **Sync Configs**.

## Add a new skill

1. Create `skills/<slug>/SKILL.md` in the installed workspace.
2. Refresh — Library lists the new skill.
3. Open the relevant harness page — preview skill sync, dry-run install, then apply.

## Edit global agent rules safely

1. **Library → Rules** — edit and save.
2. Harness page — **Diff Rules**, review, **Sync Rules**.

## Sync Codex managed config safely

1. Open **Workspace** setup lifecycle or **Codex** health.
2. Preview shows managed-field drift only; unrelated user TOML is preserved.
3. Apply merges managed profiles and top-level keys from `templates/codex/config.toml`.

## Install skills to harness targets

1. **Workspace** must be valid.
2. Open harness page (Codex, OpenCode, etc.) or use unified setup apply/repair.
3. Skills sync installs the full bundled catalog for each harness (grouped source, flat install layout).

## Version the workspace with Git

See [GIT_VERSIONING.md](GIT_VERSIONING.md). The app does not init repos or push; use Git in `~/.config/agent-workspace` if you want history.
