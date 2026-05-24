# Workflows

## Set up OpenCode only

1. **Workspace** — **install** if not already installed.
2. Open **OpenCode** — enable rule and config targets in the Targets panel (changes autosave).
3. **Diff Rules**, then **Sync Rules**; **Diff Configs**, then **Sync Configs**.

## Add a new skill

1. Create `skills/<slug>/SKILL.md` in the installed workspace.
2. Refresh — Library lists the new skill.
3. Open the relevant harness page — select the skill, dry-run install, then apply.

## Edit global agent rules safely

1. **Library → Rules** — edit and save.
2. Harness page — **Diff Rules**, review, **Sync Rules**.

## Review Codex config safely

1. Open **Codex** — enable the Codex config target only when you need a manual diff.
2. Run **Diff Config**.
3. Review `templates/codex/config.toml` against `~/.codex/config.toml` and update Codex manually if needed.

The app does not overwrite Codex config.

## Install skills to one tool

1. **Workspace** must be valid.
2. Open harness page (Codex, OpenCode, etc.).
3. Select skills and agents, dry-run, then install.

## Version the workspace with Git

See [GIT_VERSIONING.md](GIT_VERSIONING.md). The app does not init repos or push; use Git in `~/.config/agent-workspace` if you want history.
