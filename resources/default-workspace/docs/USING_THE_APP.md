# Using the App

The app is keyboard-first. A top line shows the tabs, panes are numbered `[1]` to `[4]`, and the status bar shows the keys that work where the focus is. Press `?` at any time for the full list.

Keys fire only when no text field has focus; Escape leaves a field. `Mod` is Cmd on macOS and Ctrl elsewhere.

## Tabs

`1`-`7` open, in order: workspace, codex, opencode, cursor, claude, library, settings. Copilot, Pi, and Kilo are off by default; once enabled in Settings their tabs follow claude, so the tabs before them keep their numbers (with every harness on, Settings has no digit; `Mod+,` and `:settings` still open it). A harness you disable in Settings is hidden and the remaining tabs renumber. The same names work as commands (`:codex`, `:pi`, `:library docs`).

## Keyboard reference

| Where | Key | Action |
| --- | --- | --- |
| Everywhere | `1`-`7` | Go to a tab |
| | `h` `l` | Previous or next pane |
| | `:` or `Mod+k` | Command line |
| | `?` | Help: every key and command |
| | `Mod+,` | Settings |
| | Escape | Leave a text field, dismiss the error line, cancel an open review |
| Lists | `j` `k`, arrows | Move |
| | `g g` `G`, Home End | First or last |
| | PageUp PageDown | Page |
| | Enter | Open or activate |
| | Space | Toggle (multi-select lists such as targets) |
| | `/` | Filter; Escape clears it |
| Workspace and harness pages | `u` | Review and apply an install or update |
| | `p` | Preview only |
| | `r` | Refresh status |
| Workspace status pane | `o` | Open the workspace folder |
| | `B` | Open the backups folder |
| Output pane | `y` | Copy output |
| | `C` | Clear |
| | `z` | Roll back the last transaction |
| | `g g` `G` | Top or bottom |
| Install review | `y` | Apply the reviewed plan |
| | `n`, Escape | Cancel (or close a preview) |
| | `d` | Expand or fold the row's details |
| | `c` | Jump to the next conflict |
| | `r` | Preview again after a stale or expired plan |
| Harness page, targets | Space | Toggle a target (autosaves) |
| Harness page, rules row | `d` `v` `m` | Diff, Convert, Leave as is |
| OpenCode runtime pane | `e` `s` `x` `R` | Edit model override, save it, reset it to the bundled default, reload models |
| Library | `[` `]` or `<` `>` | Previous or next source |
| | `i`, Enter | Edit the open item (skills and other read-only items are not editable) |
| | `Mod+s` | Save (also `:w`) |
| | Escape | Leave the text and show the rendered item again |
| | `o` | Open in your editor |
| | `n` | New doc (Docs source) |
| Settings | `j` `k` | Next or previous setting |
| | `r` | Reset appearance to defaults |
| | `s` | Retry a failed save |
| | `R` | Reset the workspace folder to the default (asks first) |

## Commands

`:` opens the command line; Tab completes. Mutating commands never write directly: they open the same review.

| Command | Effect |
| --- | --- |
| `:workspace`, `:codex`, `:opencode`, `:cursor`, `:claude`, `:copilot`, `:pi`, `:kilo`, `:library [source]`, `:settings` | Open a tab (aliases `:ws`, `:lib`); the light harnesses only while enabled |
| `:update <target>`, `:update --all` | Open the install review. Targets: `workspace` and the enabled harnesses |
| `:preview <target>`, `:preview --all` | Same plan with no apply |
| `:rollback` | Dry run, then confirm, then restore the last transaction |
| `:uninstall` | Open the uninstall preview |
| `:rules ...` | Rules diff, convert, and leave-as-is (see `:help`) |
| `:refresh`, `:clear`, `:copy`, `:open folder`, `:open backups` | Status, output, folders |
| `:theme <dark, light, system, or toggle>` | Appearance |
| `:w`, `:q`, `:reset` | Library: save, close (asks before discarding), discard edits |
| `:help` | Help overlay |

## Workspace page

Four panes: **harnesses** (the workspace and each enabled harness with its state), **surfaces** (what the one under the cursor installs, plus an installed-state map), **status** (state, verification, uninstall), and **output**.

States: `current`, `update`, `not installed`, `conflict`, `unavailable`, and `off` for a surface whose target toggle is off. `u` is labelled by what it will do: `install`, `update`, `update safe files` (some rows are conflicts), or `review conflicts`. It is disabled with a reason while a task runs, while target changes save, or when everything is already current (`p` still previews).

The `workspace` row stands for the data folder, which holds only the app's state and your personal docs, not a copy of the bundle. It reads `current`, or `N old copies to remove` while copies that earlier releases left there remain; a fresh profile reads `current`. With the cursor on it, the surfaces pane shows an `old copies` row, and the status pane shows `path`, `personal docs N`, `ownership records present` or `none yet`, and `left in place N` (only when above 0).

The cursor row decides what `u` does: on `workspace` it reviews the removal of old copies (there is nothing to do on a fresh profile); on a harness row it installs that harness. Harness artifacts are not part of the workspace row.

Old copies: earlier releases copied the bundle into the data folder, and the app no longer reads or updates those files. `u` on the `workspace` row (or `:update workspace`, `:update --all`) opens a review that lists the removals per top-level folder, for example `- skills/ (46 old copies; backed up, z restores them)`, and each file left in place. `y` removes them in one transaction with backups; `z` restores every file and the previous ownership records; `n` or Escape cancels, and nothing runs at launch. A copy is removed only when its bytes equal what the app recorded, the current bundled file, or a version an earlier release shipped. Anything else (an edited copy, a file not provably the app's, a symlink on the file or on a folder above it, a folder where the file was) is left in place, listed as `edited or not the app's: left in place`, and is not a conflict. Your own files, `.agent-workspace/` and `docs/context/` are never touched, and folders emptied by the removals are pruned.

Status pane: **backups** (run count and folder), **last tx** (the transaction `z` can roll back). Enter on a harness row opens its page.

## Harness pages

Codex, OpenCode, Cursor, and Claude each have **targets** (what that harness may receive), **surfaces** (installation state per surface), **runtime** (health facts from the installed files; OpenCode also asks its CLI for the version, the default agent and the configured models), and **output**. `u` and `p` review that harness only. The Copilot, Pi, and Kilo pages are the same page with three surfaces: `rules` (the one rules file of that harness, with a target toggle), `skills` (no toggle) and `mcp` (the Playwright entry in the harness's MCP file, with a target toggle; Kilo's is off until you switch it on). Their runtime shows the CLI version (the only thing the app asks the CLI, with `--version`), whether the rules block is in its file, whether the `playwright` entry is in its MCP file (`mcp playwright`, with the pinned version), and whether the bundled skills are installed in the folders that harness reads. A Pi rules row in conflict means another file in `~/.pi/agent` (`AGENTS.override.md`, or a `CLAUDE.md` with no `AGENTS.md`) decides what Pi reads; the app writes nothing until you sort that out. A CLI the app cannot find says `not on PATH`: the app does not load your shell profile, so a CLI installed through nvm is found in `~/.nvm`, and one installed anywhere else needs the app to be started from a shell where it runs. `unserved` means no skills folder is installed for the harness: Copilot and Pi read only `~/.agents/skills`, which a customised `CODEX_HOME` keeps out of the install.

Targets are a multi-select list: Space toggles, the change autosaves, and a target that is off is left out of the plan and shown as `off`. Skills are not a target: one `skills` surface installs into the folders the enabled harnesses read, so an update on any harness page can also touch a folder another harness reads. Codex rules, agents, and config are separate targets; `codex_config` starts off, and so does `claude_config` (Claude's attribution setting in `~/.claude/settings.json`: your other keys stay, and attribution you set yourself is left as it is).

The runtime facts also say which skill copies the harness will load, read from the skills folders it reads and never written: a `skill loads` row (`N skills, 1 copy each`, or `3 names with 2 copies` as a warning, with up to five of those names and `+N more`), and the `skills` surface row adds `· 3 duplicates` when there are any. With the cursor on `skills`, a `reads` row lists the folders the harness reads. Duplicates that include a skill of your own read `yours, Riggverk cannot fix`. See [SKILLS.md](SKILLS.md#where-skills-load) for what each harness does with a name it finds twice.

Each harness page ends its detail pane with a `security` group: which permission and sandbox keys the harness's global config sets, as risky, enforced, advice only or not covered rows. It reads config only, in memory, and never writes; project config, profiles and command-line flags are not checked. See [SECURITY_BASELINE.md](SECURITY_BASELINE.md).

OpenCode also shows the model override for `model`, `small model` and an optional `subagent model` (the models of the read-only subagents; unset, they use the main model): `e` edits it, `s` saves it to the app-level override file, and the next OpenCode install writes it into the installed config. Each row says `source: override | bundled default` and `state: applied | pending apply (u to update)`. `x` deletes the override and returns every row to the bundled default; the next install applies that and removes the subagent entries (see [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md)).

## Install review

`u` (or `:update`) computes a plan without writing and replaces the page's panes with a table: **op**, **file**, **why**, grouped by surface.

- `+ create`, `~ update`, `- remove`, `! conflict`. Conflict rows read `preserved, skipped`. A group header says `unchanged` for a current surface.
- The footer states the outcome: `apply 7 safe changes, skip 1 conflict?`, the backup folder, and that a transaction is recorded and rollback is available.
- `y` applies only the safe rows. Conflicts are never written. `n` or Escape cancels with nothing written. `p` and `:preview` show the same table with no apply.
- A plan is bound to the installed state it saw. If a file changed in between, or ten minutes passed, apply refuses and the review offers `r` to preview again.
- Backups of existing files and the transaction manifest are written before the first change. If an apply fails midway, it rolls back by itself.

## Rollback

`z` on the output pane, or `:rollback`, restores the files of the last install or uninstall of this session. The app first does a dry run, then asks you to confirm with what would be restored. A rollback that finds nothing to restore, or conflicts, stops there. After a restart the app forgets the transaction; the backups remain (below).

## Backups

Anything Install, uninstall, or a Library save would overwrite or remove is copied first, owner-only. Backup root: `~/Library/Application Support/se.hugrverk.riggverk/backups` (macOS), `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk/backups` (Linux), `%APPDATA%\se.hugrverk.riggverk\backups` (Windows), or `AGENT_WORKSPACE_BACKUP_DIR`.

```text
<backup root>/setup/<transaction id>/manifest.json
                                    /artifacts/<artifact id>
                                    /managed-state.previous.json
<backup root>/docs/custom_<slug>-<timestamp>/<file>   Library saves (personal docs)
<backup root>/docs/rules-<surface>-<timestamp>/<file> Library saves (rules refinements)
<backup root>/<YYYYMMDD-HHMMSS>/<label>/<file>        Cursor operations (and the retired CLI scripts)
```

New files have no backup. Restore by rollback while the transaction is in this session, otherwise by copying a file out of `artifacts/` by hand (the artifact id names the destination).

## Uninstall

**preview uninstall** (or `:uninstall`) lists what would be removed (files proven to be app-owned), preserved (files you modified or that are not the app's), and left merge-managed (config files and rules files that hold your text). **uninstall everything** applies it after a confirmation and records a transaction. It also removes any old workspace copies the app still owns (same proof as the cleanup); the data folder, its `.agent-workspace/` state, your personal docs and your files stay. Afterwards **Recover previous uninstall** appears for the current session only: **preview recovery** (read-only), then **restore workspace**, then **confirm restore**.

## Library

Panes: **items** and the open **document**, which shows the item rendered (Markdown, or formatted JSON for configs) and turns into its source text while you edit. Sources: Docs, Rules, Skills, Runtime agents, Configs (`[` `]` to switch). Docs are grouped Start, Guides, Reference, Cursor, Configs, and Context.

You edit only your own text: personal docs, in the Context group (`docs/context/<slug>.md` in the data folder). `n` creates one; on it, `i` or Enter edits, Escape returns to the rendered view, `Mod+s` or `:w` saves, `:q` closes and asks before discarding edits, and `o` opens it in your editor. Saves back up the file first and refuse symlinks. Install and updates never touch personal docs.

Rules lists the bundled base (Global Rules, read-only) and, under "your rules files", the rules file of every enabled harness (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, ...). In a rules file you edit only your refinements, the text below the managed block: the block itself is shown dimmed and read-only above them, and the editor holds just the refinements. The same keys apply, and `o` opens the whole file in your editor for anything else, such as text above the block. A file with no block yet, malformed markers, or a link in its path is listed with the reason and stays read-only here (the app never writes through a link; `o` still opens it). A save keeps the block and everything above it byte for byte, backs the file up first, and refuses when the file changed on disk since you opened it: the file is reloaded with your draft kept, and saving again writes it. Install keeps your refinements on every base update.

Everything else is bundled with the app and read-only here: the pane title says "read-only", and edit, save and `o` say "bundled with the app: read-only here". Bundled items change with an app update. The Library reads them from the app's bundle; the data folder holds no copy, and an old copy left there by an earlier release never changes what it shows ([TROUBLESHOOTING.md](TROUBLESHOOTING.md#bundled-files-in-the-workspace-folder)). Their paths are relative to the bundle.

## Settings

Harnesses (which tools appear and may be written), appearance (dark, light, system), text size, motion, landing page (workspace, library), colors, and the workspace folder. Settings autosave; `r` resets appearance after a confirmation.

Workspace: Settings no longer picks a folder. A custom folder saved by an earlier version stays in use while it holds the app's `.agent-workspace/` state; `R` (or `:workspace reset`) asks first, then returns to `~/.config/agent-workspace`. The old folder is left as it is, its ownership records stay there, and the app cannot switch back to it. `AGENT_WORKSPACE_PATH` overrides the setting. Generator scripts the app runs always come from its bundled copy, not from the saved folder.

Disabling a harness hides it and blocks new writes to it. It does not delete files or forget target choices, and re-enabling does not install.

See [WORKFLOWS.md](WORKFLOWS.md) for recipes.
