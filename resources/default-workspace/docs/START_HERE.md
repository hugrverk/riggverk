# Start Here

## What this is

A directory of docs, skills, templates, and scripts, plus the Riggverk app that installs it. The app puts a runtime copy at `~/.config/agent-workspace`, shows what is installed where, and installs rules, agents, skills, and config into Codex, OpenCode, Cursor, and Claude Code. Every write is reviewed first.

Requirements: Python 3 on `PATH` (config merges and generators).

## What the app does and does not do

It does:

- Install and update the workspace and each harness from its bundled copy, after showing a plan.
- Keep your own text in rules files, and your own keys in config files.
- Back up what it overwrites, and roll back the last install.
- Let you edit workspace docs, rules, agents, and configs in the Library.

It does not:

- Write anything on launch or without a confirmation.
- Install what you edit in the workspace. Harnesses always receive the bundled version.
- Manage Git, GitHub auth, or Claude, Codex, or Cursor settings, logins, and trust.
- Encrypt workspace contents or run agents.

## First install

1. Start the app and press `1` (Workspace). If it says `setup needed`, the cursor is on `workspace`.
2. Press `u`. A plan table lists every file to create. Nothing is written yet.
3. Press `d` to expand a row, `j` and `k` to move. `n` or Escape cancels.
4. Press `y` to apply. A backup and a transaction are recorded first; the output pane shows the result.
5. Press `2`, `3`, `4`, or `5` for Codex, OpenCode, Cursor, or Claude. Check the targets on the left (Space toggles one), then press `u` and `y` to install that harness.

`p` previews without any way to apply. `:update --all` reviews the workspace and every enabled harness in one plan; `:preview --all` only looks.

Fresh settings enable every target except `codex_config`, which rewrites your Codex approval and sandbox settings. Turn it on from the Codex page when you want it.

## Essential keys

| Key | Action |
| --- | --- |
| `1`-`7` | Go to a tab (workspace, codex, opencode, cursor, claude, library, settings) |
| `h` `l` | Previous or next pane |
| `j` `k` | Move in a list |
| `u` | Review and apply an install or update |
| `p` | Preview only |
| `y` `n` | Apply or cancel in the review |
| `z` | Roll back the last transaction (output pane) |
| `:` | Command line (`:help`, `:update codex`, `:rollback`) |
| `?` | Every key and command |

The full list is in [USING_THE_APP.md](USING_THE_APP.md#keyboard-reference).

## When a file is a conflict

A file that is yours, not the app's, is never overwritten. The plan shows it as `preserved, skipped`, and `y` applies only the safe rows. For a rules file (`CLAUDE.md`, `AGENTS.md`) you choose between **Convert**, **Leave as is**, and a diff. For anything else, move or delete your copy and install again. Details in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#conflicts).

## Your own rules

Rules files hold the app's base between `BEGIN AGENT-WORKSPACE BASE` and `END AGENT-WORKSPACE BASE` markers. Write your own instructions below the END marker. They are kept on every update and override the base where they conflict. Do not edit inside the block. See [AGENT_RULES.md](AGENT_RULES.md).

## Where things are

- Workspace: `~/.config/agent-workspace` (change it in Settings, or `AGENT_WORKSPACE_PATH`).
- Backups: `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS, `${XDG_CONFIG_HOME:-~/.config}/ai.agentworkspace.app/backups` on Linux, `%APPDATA%\ai.agentworkspace.app\backups` on Windows. `B` on the Workspace page opens the folder.
- Settings file: `settings.json` in the app support folder, the parent of the default backups folder.

## Next

- [CONCEPTS.md](CONCEPTS.md) - the mental model
- [USING_THE_APP.md](USING_THE_APP.md) - every page and key
- [WORKFLOWS.md](WORKFLOWS.md) - recipes
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
