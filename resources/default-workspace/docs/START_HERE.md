# Start Here

## What this is

A bundle of docs, skills, templates, and scripts inside the Riggverk app, which installs it. The app keeps no copy of the bundle in its data folder, `~/.config/agent-workspace`, which holds only its state and your personal docs. The app shows what is installed where, and installs rules, agents, skills, and config into Codex, OpenCode, Cursor, and Claude Code. GitHub Copilot, Pi, and Kilo Code are an opt-in light tier (Settings): the app installs the shared rules block and skills for them and shows their CLI version. Every write is reviewed first.

Requirements: Python 3 on `PATH` (config merges and generators).

## What the app does and does not do

It does:

- Install and update each harness from the bundle, after showing a plan.
- Keep your own text in rules files, and your own keys in config files.
- Back up what it overwrites, and roll back the last install.
- Show the bundled docs, rules, skills, agents, and configs in the Library (read-only), and let you write your own personal docs and the refinements below the managed block of your rules files there.

It does not:

- Write anything on launch or without a confirmation.
- Install what you edit in the data folder. Harnesses always receive the bundled version.
- Manage Git, GitHub auth, or Claude, Codex, or Cursor settings, logins, and trust.
- Encrypt workspace contents or run agents.

## First install

1. Start the app and press `1` (Workspace). On a fresh profile the `workspace` row says `current`: there is no copy of the bundle to install. The harness rows are what you install.
2. Press `2`, `3`, `4`, or `5` for Codex, OpenCode, Cursor, or Claude. Check the targets on the left (Space toggles one).
3. Press `u`. A plan table lists every file to create. Nothing is written yet.
4. Press `d` to expand a row, `j` and `k` to move. `n` or Escape cancels.
5. Press `y` to apply. A backup and a transaction are recorded first; the output pane shows the result.

`p` previews without any way to apply. `:update --all` reviews every enabled harness in one plan; `:preview --all` only looks.

If the `workspace` row says `N old copies to remove`, an earlier release copied the bundle into your data folder. `u` on that row reviews their removal: only copies the app can prove are its own, backed up, and `z` restores them. Edited files stay and are listed.

Fresh settings enable every target except `codex_config`, which rewrites your Codex approval and sandbox settings, and `claude_config`, which sets `attribution.commit` and `attribution.pr` to `""` in `~/.claude/settings.json` to hide Claude Code's `Co-Authored-By` commit line and "Generated with Claude Code" PR line. Turn them on from the Codex and Claude pages when you want them.

## Essential keys

| Key | Action |
| --- | --- |
| `1`-`7` | Go to a tab (workspace, codex, opencode, cursor, claude, library, settings; copilot, pi and kilo follow claude once enabled) |
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

- Data folder: `~/.config/agent-workspace` (the app's state in `.agent-workspace/`, your personal docs in `docs/context/`; `AGENT_WORKSPACE_PATH` overrides it).
- Backups: `~/Library/Application Support/se.hugrverk.riggverk/backups` on macOS, `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk/backups` on Linux, `%APPDATA%\se.hugrverk.riggverk\backups` on Windows. `B` on the Workspace page opens the folder.
- Settings file: `settings.json` in the app support folder, the parent of the default backups folder.

## Next

- [CONCEPTS.md](CONCEPTS.md) - the mental model
- [USING_THE_APP.md](USING_THE_APP.md) - every page and key
- [WORKFLOWS.md](WORKFLOWS.md) - recipes
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
