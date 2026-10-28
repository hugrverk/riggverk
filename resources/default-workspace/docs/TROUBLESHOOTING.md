# Troubleshooting

## Workspace folder unusable

The workspace folder (default `~/.config/agent-workspace`) holds the app's state in `.agent-workspace/` and your personal docs in `docs/context/`. A fresh profile has none yet, and that is fine: the first write that needs it (a state file, a personal doc) creates it, and harnesses install without it.

1. Open Workspace (`1`). The row says `folder unusable`, and the `why` row says what is wrong.
2. `the folder is a symlink` or `not a folder`: the app does not write through a link or over a file. Move the link or file away; the app creates a real folder on the next install.
3. `folder not found` with `AGENT_WORKSPACE_PATH` set: the variable names a folder that does not exist. Create it or unset the variable. It wins over Settings.
4. A custom folder from Settings is used only while it holds `.agent-workspace/workspace.json` or `.agent-workspace/managed-state.json`. Otherwise the app falls back to the default folder. Old copies in the folder, or removing them, do not change this.

## Bundled files in the workspace folder

The folder holds no copy of the bundle, so bundled files missing from it are normal and never a problem. The app reads the bundle inside the app.

Copies that earlier releases left there are ignored. The `workspace` row says `N old copies to remove` while they remain; `u` on it reviews their removal (one transaction, backed up, `z` restores them). A file you edited, or one the app cannot prove is its own, is listed as `edited or not the app's: left in place` and is never touched: keep it or delete it yourself. The status pane counts them as `left in place N`. To keep a copy, cancel the review (`n` or Escape), or press `z` afterwards. This is not a conflict and nothing needs resolving.

## Conflicts

A conflict is a file the app will not overwrite because it cannot prove it owns an unmodified copy. The plan shows `preserved, skipped`; `y` still applies the safe rows. Press `c` in the review to jump between conflicts, `d` for details.

- **Harness file you edited** (a skill or agent file, edited outside the app): the app treats any edit as yours. To take the bundled version, move or delete your copy and install again. To keep yours, do nothing; it stays frozen against updates. An edited old copy in the workspace folder is not a conflict (see above).
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
- **`workspace folder unusable`**: see "Workspace folder unusable" above.
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

## A harness page says the workspace folder is unusable

Harness installs need a usable workspace folder (absent, or a real folder). The Workspace page says what is wrong with the folder (see "Workspace folder unusable" above).

## Settings and targets

- A target that is off is not written. Check Space-toggles on the harness page; `codex_config` and `claude_config` are off by default.
- Disabled harnesses disappear from the tabs and cannot be written; re-enable them in Settings. Copilot, Pi, and Kilo are off by default.
- A Copilot, Pi, or Kilo page shows `cli  not on PATH`: the app does not read your shell profile. A CLI installed through nvm is found in `~/.nvm/versions/node`; any other location needs the app started from a shell where the CLI runs. The skills row does not depend on the CLI.
- The OpenCode page shows `config  synced · has comments`, or the review says `opencode.json has comments`: OpenCode reads JSONC, but the app writes strict JSON only, so it leaves the file as is. Move your own settings and their comments to `opencode.jsonc` and keep `opencode.json` strict JSON. An `overrides` row names a `config.json` or `opencode.jsonc` that sets managed keys (remove them there), OpenCode config variables in the app's environment, or a system managed config. See "Other config OpenCode reads" in `OPENCODE_CONFIG.md`.
- A Copilot, Pi, or Kilo page shows `mcp playwright  invalid`: the MCP file has comments, a trailing comma, a byte order mark, or a shape the app does not edit (the reason is on the row). The app edits strict JSON only and writes nothing until you remove the comment or comma. `diverged` means an entry named `playwright` that is yours is in the file; rename or remove it to let the app manage the entry. On a Kilo page, a `~/.kilo/kilo.json[c]` or an `opencode.json[c]` in Kilo's config folder wins over the entry, so the page warns about it. Kilo's MCP target is off by default.
- A Pi page warns that Pi does not declare the Playwright tools to the model: set `"exposure": "direct"` on the entry in `~/.pi/agent/mcp.json` yourself. The entry then differs from the managed one and stays yours; switch `pi_mcp` off in the targets pane to stop the conflict showing.
- A Copilot or Pi page shows `unserved`: Codex is enabled with a customised `CODEX_HOME`, and Codex's isolation keeps `~/.agents/skills` (the only shared folder those two read) out of the install. Disable Codex or unset `CODEX_HOME`.
- Target and harness changes autosave. If the targets pane says `not saved`, press `s` in Settings to retry.

## Environment overrides

The app honors these in normal use, so check them when paths surprise you: `AGENT_WORKSPACE_PATH`, `AGENT_WORKSPACE_BACKUP_DIR`, `CODEX_HOME` (Codex config, rules, agents, and, when customised, skills), `CODEX_SKILLS_PATH`, `CLAUDE_SKILLS_PATH` (inside your home folder), `OPENCODE_SKILLS_PATH` and `CURSOR_SKILLS_PATH` (only where older copies are cleaned up), `PLAYWRIGHT_MCP_CONFIG_PATH`, `XDG_CONFIG_HOME` (Linux app support). `COPILOT_HOME` and `PI_CODING_AGENT_DIR` move those harnesses' own folders (rules file included); the app does not follow them and says so on the page when one is set. `XDG_CONFIG_HOME` also moves Kilo's rules file, and the app follows it.
