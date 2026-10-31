# Using the App

The app is a desktop window: a sidebar on the left (Overview, your agents, History, Library, Settings), a top bar with **Check** and **Update all**, and the page you are on. Use it with the mouse: the actions of a page are visible buttons, and the keys below are shortcuts for the same buttons. Press `?` at any time for the full list.

Keys fire only when no text field has focus; Escape leaves a field. `Mod` is Cmd on macOS and Ctrl elsewhere. Tab moves through the sidebar, then the top bar, then the page, with a visible focus ring.

## Sidebar and digits

`1` opens Overview, `2`-`5` open Codex, OpenCode, Cursor and Claude, `6` opens History, `7` Library and `8` Settings. The digits are fixed: they do not move when you turn an agent off (the digit of a hidden agent does nothing). Copilot, Pi and Kilo are off by default; once enabled in Settings they appear after Claude and have no digit: open them from the sidebar or with `:copilot`, `:pi`, `:kilo`. `Mod+,` and `:settings` also open Settings. The same names work as commands (`:codex`, `:history`, `:library docs`). A badge on an agent shows how many things in it wait for your decision.

## Keyboard reference

| Where | Key | Action |
| --- | --- | --- |
| Everywhere | `1`-`8` | Go to a sidebar page (see above) |
| | `:` or `Mod+k` | Command line |
| | `?` | Help: every key, command and state |
| | `Mod+,` | Settings |
| | `z` | Undo last update (while this session has one to undo) |
| | Escape | Leave a text field, dismiss the error line, close a review or a Compare |
| Lists (Library) | `j` `k`, arrows | Move |
| | `g g` `G`, Home End | First or last |
| | PageUp PageDown | Page |
| | Enter | Open or activate |
| | `/` | Filter; Escape clears it |
| Overview | `u` | Update all: review everything that can be updated |
| | `p` | Preview only |
| | `r` | Check again |
| | `o` | Open the workspace folder |
| | `B` | Open the backups folder |
| Agent pages | `u` | Review and apply an install or update of this agent |
| | `p` | Preview only |
| | `r` | Check again |
| Rules card | `d` `v` `m` | Compare, Merge in updates, Keep mine or Hand back |
| Files card | `c` `d` `b` `m` | Next file, Compare, Use Riggverk's version, Keep mine or Hand back |
| Codex config card | `m` `b` | Keep mine or Hand back, Use Riggverk defaults |
| A switch | Space, Enter | Turn "Let Riggverk manage this" on or off (autosaves) |
| OpenCode model | `e` `s` `x` `R` | Edit the model override, save it, reset it to the bundled default, reload models |
| Reviews | `y` | Apply the reviewed plan |
| | `n`, Escape | Cancel |
| | `d` | Expand or fold the row's details (install review) |
| | `c` | Jump to the next conflict (install review) |
| | `f` | Rules review: switch between the diff and the resulting file |
| | `r` | Preview again after a stale or expired plan, or after an error |
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

Enter never applies a plan, not even on the focused Apply button: `y`, a click or Space does.

## Commands

`:` opens the command line; Tab completes. Mutating commands never write directly: they open the same review.

| Command | Effect |
| --- | --- |
| `:workspace`, `:codex`, `:opencode`, `:cursor`, `:claude`, `:copilot`, `:pi`, `:kilo`, `:history`, `:library [source]`, `:settings` | Open a page (aliases `:overview`, `:ws`, `:lib`); the light agents only while enabled |
| `:update <target>`, `:update --all` | Open the install review. Targets: `workspace` and the enabled agents |
| `:preview <target>`, `:preview --all` | Same plan with no apply |
| `:rollback` | Dry run, then confirm, then restore the last transaction of this session |
| `:uninstall` | Open the uninstall preview |
| `:rules ...`, `:resolve ...` | Rules and skill or agent files: compare, merge, take bundled, keep mine (see `:help`) |
| `:refresh`, `:clear`, `:copy`, `:open folder`, `:open backups` | Check again, clear the last run result, copy its output (redacted), folders |
| `:theme <dark, light, system, or toggle>` | Appearance |
| `:w`, `:q`, `:reset` | Library: save, close (asks before discarding), discard edits |
| `:whatsnew`, `:help` | Release notes, help overlay |

## Overview

The Overview says how things stand in one sentence (`Your setup works.`, `Nothing is set up yet.`, `Everything is set up.`, or that Riggverk can't use its folder), and under it counts the six states below. Then one card per enabled agent with its rules, agents, skills and settings or MCP rows, a **Worth a look** cell (security findings that are risky; advice only, nothing is changed), the **Last update** receipt, a line for the agents that are off (**Add agents…** opens Settings) and a collapsed **Workspace folder** cell. A card opens the agent's page. Nothing on this page writes: **Check** reads the installed state again, **Update all** (`u`) opens a review of everything that can be updated, and **Preview** (`p`) shows the same plan with no way to apply.

The six states, in words (a ring or a square next to them never stands alone):

| State | Meaning |
| --- | --- |
| Up to date | Matches what Riggverk would write. |
| Update ready | Safe to update. Nothing is written until you review it. |
| Needs your decision | You edited it. Compare, then keep yours or take Riggverk's. |
| Yours | You chose to manage it. Riggverk leaves it alone. |
| Fix by hand | Riggverk cannot write it safely. The page says why. |
| Not managed | Turned off, or not available on this system. |

A drift in what the installed tool does (a stale runtime, a missing CLI) is never a state of its own: the card says `Runtime check: stale` on a line under the rows, only while nothing else explains it.

The **Workspace folder** cell stands for the data folder, which holds only the app's state and your personal docs, not a copy of the bundle. It reads **Up to date**, or `N old copies to remove` while copies that earlier releases left there remain; a fresh profile reads **Up to date**. Expanded it shows the path, `personal docs N`, `ownership records present` or `none yet`, `left in place N` (only when above 0), the backups (run count and folder) and the last transaction, with **Open folder** (`o`), **Backups folder** (`B`) and the uninstall and recovery cards.

Old copies: earlier releases copied the bundle into the data folder, and the app no longer reads or updates those files. **Update all** (or `:update workspace`) opens a review that lists the removals per top-level folder, for example `- skills/ (46 old copies; backed up, z restores them)`, and each file left in place. `y` removes them in one transaction with backups; `z` restores every file and the previous ownership records; `n` or Escape cancels, and nothing runs at launch. A copy is removed only when its bytes equal what the app recorded, the current bundled file, or a version an earlier release shipped. Anything else (an edited copy, a file not provably the app's, a symlink on the file or on a folder above it, a folder where the file was) is left in place, listed as `edited or not the app's: left in place`, and is not a conflict. Your own files, `.riggverk/` and `docs/context/` are never touched, and folders emptied by the removals are pruned.

## Agent pages

Codex, OpenCode, Cursor and Claude each have a page: the name, one line under it (where the agent lives, how many skills and agents it loads, the CLI), **Preview** (`p`) and an update button labelled by what it will do (`u`: `install`, `update`, `update safe files` while some files are conflicts, or `review conflicts`). The update button is disabled with a reason while a task runs, while target changes save, or when everything is already current (`p` still previews).

The page is a grid of cells, one per surface (rules, agents, skills, settings or MCP), each with a state pill and, where the surface is a target, the switch **Let Riggverk manage this** (it autosaves; a target that is off is left out of the plan and reads **Not managed**). Cells that need your decision come first and span the full width. Skills are not a target: one `skills` surface installs into the folders the enabled agents read, so an update on any agent page can also touch a folder another agent reads. Codex rules, agents and config are separate targets; `codex_config` starts off, and so does `claude_config` (Claude's attribution setting in `~/.claude/settings.json`: your other keys stay, and attribution you set yourself is left as it is).

A decision cell says what happened in a sentence and offers the ways out as buttons, each with its key:

- **Rules file** (a managed block that was edited, or a file that differs from every shipped version): **Compare** (`d`) folds a read-only side-by-side diff out under the card (your file against the closest shipped version; **Show the update instead** (`t`) switches it); it writes nothing and needs no token. **Merge in updates…** (`v`) opens a review with the exact file that would be written, then `y`. **Keep mine** (`m`) asks first, then Riggverk leaves the file alone until you hand it back (**Hand back**).
- **Skill and agent files you edited**: a row per file with its folder and why it differs, each with **Compare** (the same fold-out), **Use Riggverk's version…** (`b`, a review with the files, the backup name and the diff; `y` applies, your files are backed up first) and **Keep mine** or **Hand back** (`m`, asks first). **Next file** (`c`) moves to the next one.
- **Codex config**: a table of the managed keys (Riggverk's value and yours), **Keep mine** (`m`, asks first) and **Use Riggverk defaults** (`b`): a review with the exact key changes, then `y` writes only the keys that differ, with a backup. `model` and `model_reasoning_effort` are yours and are never compared. Riggverk sets no model; your agent's own default applies.

A plan is bound to the installed state it saw; every write goes through a review with its own fingerprint and one-time token, and only `y` (or the Apply button) applies.

The **Runtime** cell shows health facts from the installed files (OpenCode also asks its CLI for the version, the default agent and the configured models). The Copilot, Pi and Kilo pages are the same page with three surfaces: `rules` (the one rules file of that agent, with a switch), `skills` (no switch) and `mcp` (the Playwright entry in the agent's MCP file, with a switch; Kilo's is off until you switch it on). Their runtime shows the CLI version (the only thing the app asks the CLI, with `--version`), whether the rules block is in its file, whether the `playwright` entry is in its MCP file (`mcp playwright`, with the pinned version), and whether the bundled skills are installed in the folders that agent reads. A Pi rules cell in conflict means another file in `~/.pi/agent` (`AGENTS.override.md`, or a `CLAUDE.md` with no `AGENTS.md`) decides what Pi reads; the app writes nothing until you sort that out. A CLI the app cannot find says `not on PATH`: the app does not load your shell profile, so a CLI installed through nvm is found in `~/.nvm`, and one installed anywhere else needs the app to be started from a shell where it runs. `unserved` means no skills folder is installed for the agent: Copilot and Pi read only `~/.agents/skills`, which a customised `CODEX_HOME` keeps out of the install. Codex reads `AGENTS.override.md` instead of `AGENTS.md` when it is non-empty; the Codex page warns about it.

The runtime facts also say which skill copies the agent will load, read from the skills folders it reads and never written: a `skill loads` row (`N skills, 1 copy each`, or `3 names with 2 copies` as a warning, with up to five of those names and `+N more`), and the skills cell adds `· 3 duplicates` when there are any, with a `reads` line naming the folders. Duplicates that include a skill of your own read `yours, Riggverk cannot fix`. See [SKILLS.md](SKILLS.md#where-skills-load) for what each agent does with a name it finds twice.

**Safety notes** ends the page with an **Advice only** tag: which permission and sandbox keys the agent's global config sets, as `Worth a look`, `Set`, `Tip` or `Not checked` rows. It reads config only, in memory, and never writes; project config, profiles and command-line flags are not checked. See [SECURITY_BASELINE.md](SECURITY_BASELINE.md).

OpenCode also has a **Model** cell: the override for `model`, `small model` and an optional `subagent model` (the models of the read-only subagents; unset, they use the main model). `e` edits it, `s` saves it to the app-level override file, and the next OpenCode install writes it into the installed config. Each row says `source: override | bundled default` and `state: applied | pending apply (u to update)`. `x` deletes the override and returns every row to the bundled default; the next install applies that and removes the subagent entries (see [OPENCODE_CONFIG.md](OPENCODE_CONFIG.md)).

## Install review

`u` (or `:update`, or **Update all**) computes a plan without writing and replaces the page with a table: **op**, **file**, **why**, grouped by surface.

- `+ create`, `~ update`, `- remove`, `! conflict`. Conflict rows read `preserved, skipped`. A group header says `unchanged` for a current surface.
- The footer states the outcome: `apply 7 safe changes, skip 1 conflict?`, the backup folder, and that a transaction is recorded and rollback is available. **Apply** (`y`) and **Cancel** (`n`) sit there as buttons.
- `y` applies only the safe rows. Conflicts are never written. `n` or Escape cancels with nothing written. `p` and `:preview` show the same table with no apply.
- A plan is bound to the installed state it saw. If a file changed in between, or ten minutes passed, apply refuses and the review offers `r` to preview again.
- Backups of existing files and the transaction manifest are written before the first change. If an apply fails midway, it rolls back by itself.

## Run panel and Undo

While a task runs, a line under the page shows its label, a hairline progress bar, the count and the file in progress. When it ends the line says **Done** or **Failed**, the command and the time, with **Undo last update…** (`z`, only when the run left a transaction), **Details** (the redacted log, with a Copy output button; a failed run opens it by itself) and **Dismiss**.

`z` anywhere (or the button, or `:rollback`) undoes the last install or uninstall of this session. The app first does a dry run, then asks you to confirm with what would be restored. A rollback that finds nothing to restore, or conflicts, stops there. After a restart this button is gone, but **History** keeps the newest completed update undoable (below). The backups remain (see Backups).

## History

**History** lists every update of this workspace, newest first, read from the transaction records on disk, so it is complete after a restart. Each run is a row with a pill (**Done**, **Undone**, **Failed**) that opens to its receipt: **Changed** (the files it wrote or restored), **Checked** (what the plan found current), **Left for you** (what it did not touch: files you edited, kept or manage), and **Backup**. A run from before receipts were recorded shows what its records say and nothing more. **Undo this update…** is offered on the newest completed update only: a dry run, then a confirm, then the rollback, exactly like `z`. Older runs show their receipt only. History writes nothing itself.

## Backups

Anything Install, uninstall, or a Library save would overwrite or remove is copied first, owner-only. Backup root: `~/Library/Application Support/se.hugrverk.riggverk/backups` (macOS), `${XDG_CONFIG_HOME:-~/.config}/se.hugrverk.riggverk/backups` (Linux), `%APPDATA%\se.hugrverk.riggverk\backups` (Windows), or `RIGGVERK_BACKUP_DIR`.

```text
<backup root>/setup/<transaction id>/manifest.json
                                    /artifacts/<artifact id>
                                    /managed-state.previous.json
<backup root>/docs/custom_<slug>-<timestamp>/<file>   Library saves (personal docs)
<backup root>/docs/rules-<surface>-<timestamp>/<file> Library saves (rules refinements)
<backup root>/<YYYYMMDD-HHMMSS>/<label>/<file>        Cursor operations (and the retired CLI scripts)
```

New files have no backup. Restore with Undo (the last update of this session, or the newest completed one in History), otherwise by copying a file out of `artifacts/` by hand (the artifact id names the destination).

## Uninstall

In the **Workspace folder** cell of the Overview, **preview uninstall** (or `:uninstall`) lists what would be removed (files proven to be app-owned), preserved (files you modified or that are not the app's), and left merge-managed (config files and rules files that hold your text). **uninstall everything** applies it after a confirmation and records a transaction. It also removes any old workspace copies the app still owns (same proof as the cleanup); the data folder, its `.riggverk/` state, your personal docs and your files stay. Afterwards **Recover previous uninstall** appears for the current session only: **preview recovery** (read-only), then **restore workspace**, then **confirm restore**.

## Library

Two columns: the **items** list and the open **document**, which shows the item rendered (Markdown, or formatted JSON for configs) and turns into its source text while you edit. Sources: Docs, Rules, Skills, Runtime agents, Configs (`[` `]` to switch). Docs are grouped Start, Guides, Reference, Cursor, Configs, and Context.

You edit only your own text: personal docs, in the Context group (`docs/context/<slug>.md` in the data folder). `n` creates one; on it, `i` or Enter edits, Escape returns to the rendered view, `Mod+s` or `:w` saves, `:q` closes and asks before discarding edits, and `o` opens it in your editor. Saves back up the file first and refuse symlinks. Install and updates never touch personal docs.

Rules lists the bundled base (Global Rules, read-only) and, under "your rules files", the rules file of every enabled harness (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, ...). In a rules file you edit only your refinements, the text below the managed block: the block itself is shown dimmed and read-only above them, and the editor holds just the refinements. The same keys apply, and `o` opens the whole file in your editor for anything else, such as text above the block. A file with no block yet, malformed markers, or a link in its path is listed with the reason and stays read-only here (the app never writes through a link; `o` still opens it). A save keeps the block and everything above it byte for byte, backs the file up first, and refuses when the file changed on disk since you opened it: the file is reloaded with your draft kept, and saving again writes it. Install keeps your refinements on every base update.

Skills lists the bundled ones and, under `pack:<name>`, the skills of your skill packs (`packs/<pack>/skills/...` in the data folder, see [SKILLS.md](SKILLS.md#skill-packs)), read-only, with a state when a skill is shadowed by a bundled one, in error, or installed while its pack is missing. For a pack whose folder is gone, **Forget pack** (after a confirmation) lets the next Install remove the copies the app installed from it, with a backup.

Everything else is bundled with the app and read-only here: the pane title says "read-only", and edit, save and `o` say "bundled with the app: read-only here". Bundled items change with an app update. The Library reads them from the app's bundle; the data folder holds no copy, and an old copy left there by an earlier release never changes what it shows ([TROUBLESHOOTING.md](TROUBLESHOOTING.md#bundled-files-in-the-workspace-folder)). Their paths are relative to the bundle.

## Settings

Appearance (theme dark, light or system; text size; motion full, subtle or off; accent, background and text colours, with a contrast warning), Agents (one switch per agent: which agents appear and may be written), Workspace (the folder, `R` to reset), and Startup (landing page: Overview or Library). Settings autosave; `r` resets appearance after a confirmation. Motion `subtle` keeps short fades and drops movement; `off` (or the OS reduced-motion preference) stops every animation.

Workspace: Settings no longer picks a folder. A custom folder saved by an earlier version stays in use while it holds the app's `.riggverk/` state; `R` (or `:workspace reset`) asks first, then returns to `~/.config/riggverk`. The old folder is left as it is, its ownership records stay there, and the app cannot switch back to it. `RIGGVERK_WORKSPACE_PATH` overrides the setting. Generator scripts the app runs always come from its bundled copy, not from the saved folder.

Turning an agent off hides its page and blocks new writes to it. It does not delete files or forget target choices, and re-enabling does not install.

See [WORKFLOWS.md](WORKFLOWS.md) for recipes.
