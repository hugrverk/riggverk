# Workflows

## Set up OpenCode only

1. Open **Workspace** and run **Install or Update**.
2. Review conflicts, then apply safe OpenCode artifacts.
3. Open **OpenCode** to verify runtime health.

## Add a new skill

1. Create `skills/<slug>/SKILL.md` in the installed workspace.
2. Refresh — Library lists the new skill.
3. Open the relevant harness page and run **Install or Update**.

## Edit global agent rules safely

1. **Library → Rules** — edit and save.
2. Harness page — preview **Install or Update**, then apply.

## Sync Codex managed config safely

1. Open **Workspace** or **Codex** installation status.
2. Preview shows managed-field drift only; unrelated user TOML is preserved.
3. Apply merges only allowlisted top-level `approval_policy` and `sandbox_mode` from `templates/codex/config.toml`; legacy app-shaped profile selectors and tables are removed during migration when still app-shipped.

## Install skills to harness targets

1. **Workspace** must be valid.
2. Open a harness page or Workspace and run **Install or Update**.
3. The managed installation installs the full bundled catalog for each selected harness (grouped source, flat install layout).

## Version the workspace with Git

See [GIT_VERSIONING.md](GIT_VERSIONING.md). The app does not init repos or push; use Git in `~/.config/agent-workspace` if you want history.
