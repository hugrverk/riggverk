# Troubleshooting

## Workspace not installed or invalid

1. Open Workspace (`1`). The row says `setup needed`.
2. Press `u`, read the plan, press `y`.
3. Confirm `.agent-workspace/workspace.json` exists under the workspace folder (default `~/.config/agent-workspace`).
4. A custom folder from Settings or `AGENT_WORKSPACE_PATH` must pass the markers below. `AGENT_WORKSPACE_PATH` wins over Settings. If a saved custom path stops validating, the app falls back to the default path.

## Missing markers

A valid workspace contains all of:

| Marker | Kind |
|--------|------|
| `.agent-workspace/workspace.json` | file |
| `README.md` | file |
| `skills/` | directory |
| `templates/global-agent-rules.md` | file |
| `templates/opencode.json` | file |
| `templates/codex/config.toml` | file |
| `templates/cursor/agents/` | directory |
| `templates/cursor/rules/` (with at least one `*.mdc`) | directory |

Run `u` on the Workspace page. Missing files are created; files you changed are kept and listed as conflicts.

## Conflicts

A conflict is a file the app will not overwrite because it cannot prove it owns an unmodified copy. The plan shows `preserved, skipped`; `y` still applies the safe rows. Press `c` in the review to jump between conflicts, `d` for details.

- **Workspace or harness file you edited** (a bundled doc, template, skill, agent): the app treats any edit as yours. To take the bundled version, move or delete your copy and install again. To keep yours, do nothing; it stays frozen against updates.
- **Deleted `.agent-workspace/managed-state.json`**: this is the ownership record. Without it the app cannot prove it owns what it installed, so any file that is not an exact copy of a bundled version becomes a conflict. Restore it from a backup (`setup/<transaction id>/managed-state.previous.json`) or resolve each file as above. It describes this machine's installs; do not copy it to another machine.
- **Rules file (`CLAUDE.md`, `AGENTS.md`)**: see the next section.
- **Skill you installed by hand with the same name**: diverged copies are preserved. Rename yours or delete it to take the bundled one.
- **Supporting file of a skill you edited** (for example `~/.claude/skills/security-audit/HUNTING.md`): that one file is a conflict and stays as you left it; the other files of the skill still update, so the skill can mix your file with newer ones. To take the bundled version, move or delete your copy and install again. To keep yours, do nothing.
- **Something in the way inside a skill folder**: a symlink in the path (including a symlinked skills folder), a directory where a skill file belongs, or a file where a skill needs a directory is shown as a conflict for the files below it, and nothing there is written. Move it aside and install again. A file you added to a skill folder is never touched.

## Rules file conflicts

Rules files hold the app's base between `BEGIN AGENT-WORKSPACE BASE` and `END AGENT-WORKSPACE BASE` markers. Text outside them is yours and is never touched.

| Conflict | Meaning |
|----------|---------|
| `base_block_edited` | Someone edited inside the block. |
| `legacy_diverged` | The file has no markers and is not a known earlier copy of the base. |
| `malformed_markers` | Duplicate, unpaired, or reordered markers, not UTF-8, or larger than 4 MB. Nothing is written. Fix the markers by hand. |

For the first two, use the rules row on the harness page: `d` shows a diff, `v` (**Convert**) writes the current base as the block and moves the sections you changed below the END marker (the preview shows the whole file, a backup is taken, you confirm), and `m` (**Leave as is**) stops the app from touching the file until you convert it. `:rules` is the command-line form. Your own additions belong below the END marker, where updates keep them.

A file that equals a known earlier base, or holds only whitespace, is wrapped automatically after a backup; it is not a conflict.

Codex ignores `AGENTS.md` when a non-empty `AGENTS.override.md` exists in the Codex home. The Codex runtime pane warns about it.

## Review shows an error

- **Plan is stale / re-run preview**: an installed file changed after the preview. Press `r` to preview again.
- **Token expired or already used**: previews expire after ten minutes. Press `r`.
- **`setup operation already in progress`**: another install or rollback is running. Wait.
- **`no valid workspace installed`**: install the workspace first.
- **Update disabled, `already current`**: nothing to do. `p` previews anyway.

Nothing is written when a review fails before apply.

## Install failed or was interrupted

A failed apply rolls itself back. An apply that was interrupted (app closed, power loss) is reconciled before the next apply: finished artifacts are checked against their backup and post-apply state, and nothing you edited since is overwritten.

To undo a finished install from the current session, press `z` on the output pane (or `:rollback`). It does a dry run, shows what would be restored, and asks. If it reports a conflict, a file changed after the install; resolve it by hand and retry.

After a restart, `z` is unavailable: the app does not rediscover transactions. Backups remain. Copy a file out of `<backup root>/setup/<transaction id>/artifacts/<artifact id>` to its destination by hand. Layout and root: [USING_THE_APP.md](USING_THE_APP.md#backups).

## Uninstall recovery unavailable after restart

**Recover previous uninstall** is session-scoped. Use **preview recovery** and **restore workspace** before quitting. After a restart, reinstall with `u`, or restore files by hand from the backup folder.

## python3 not found

Config merges (Codex, OpenCode, Cursor) and generators call `python3`. Install Python 3 and make sure it is on `PATH` for the app. The app appends the Homebrew and user bin directories at startup, but a Python in another location needs to be on the `PATH` the app was started with. Errors name `python3`.

## A harness page says no valid workspace

Harness installs need the workspace first. Install it on the Workspace page, then return.

## Settings and targets

- A target that is off is not written. Check Space-toggles on the harness page; `codex_config` is off by default.
- Disabled harnesses disappear from the tabs and cannot be written; re-enable them in Settings.
- Target and harness changes autosave. If the targets pane says `not saved`, press `s` in Settings to retry.

## Environment overrides

The app honors these in normal use, so check them when paths surprise you: `AGENT_WORKSPACE_PATH`, `AGENT_WORKSPACE_BACKUP_DIR`, `CODEX_HOME` (Codex config, rules, agents, and, when customised, skills), `CODEX_SKILLS_PATH`, `CLAUDE_SKILLS_PATH` (inside your home folder), `OPENCODE_SKILLS_PATH` and `CURSOR_SKILLS_PATH` (only where older copies are cleaned up), `PLAYWRIGHT_MCP_CONFIG_PATH`, `XDG_CONFIG_HOME` (Linux app support).
