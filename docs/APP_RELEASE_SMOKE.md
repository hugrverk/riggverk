# App Release Smoke

Manual smoke checklist for Riggverk builds. It complements `scripts/release-check.sh`, which covers syntax, bundled-default checks, source scans, the app build, Cargo checks, apply smokes in temporary `HOME` directories, and the backend runtime smoke. It does not drive the webview or an installed bundle.

Run this in the real Tauri app (not Vite only: `invoke` does not exist there) with isolated paths:

```bash
export HOME="$(mktemp -d)"
export AGENT_WORKSPACE_PATH="$HOME/workspace"
export AGENT_WORKSPACE_BACKUP_DIR="$HOME/backups"
npm run tauri dev        # or open the built bundle from this shell
```

Tab keys below assume the default order: workspace, codex, opencode, cursor, claude, library, settings (`1`-`7`). Copilot, Pi and Kilo are off by default; once enabled their tabs follow Claude (copilot, pi, kilo) and Library and Settings move up (`1`-`9`, Settings has no digit with all seven on).

## 1. Preflight

- [ ] `git status --short` is clean; commit and branch noted for the report
- [ ] `./scripts/release-check.sh` passes
- [ ] `npm run tauri build` succeeds (skip if the environment cannot build bundles)
- [ ] No secrets, private keys, names, or credential-bearing data in `resources/default-workspace/`
- [ ] `./scripts/release-size-report.sh` sizes are in the expected range

## 2. Launch and shell

- [ ] First launch on a fresh profile shows the `workspace` row as `current` (nothing to remove), no generic error banner, no path chooser on the Workspace page
- [ ] Workspace page shows `~/.config/agent-workspace` (or the isolated override)
- [ ] Fresh profile: launching creates no `~/.config/agent-workspace`; harness rows are not gated; `u` on a harness installs it without the workspace and creates the folder owner-only (0700) holding only `.agent-workspace/`
- [ ] Top line tabs match the order above; Mac traffic lights sit on the same 28px line
- [ ] `?` opens the help overlay listing keys and commands; Escape closes it
- [ ] `:` opens the command line; `:help`, `:codex`, `:theme toggle`, an unknown command (error, no crash)
- [ ] `:whatsnew` opens the release notes (Escape closes); the first launch after an update shows them once, a fresh install does not
- [ ] `Mod+k` opens the command line, `Mod+,` opens Settings, also from inside a text field
- [ ] `1`-`7` switch tabs; `h` and `l` move between panes; `j`/`k`, `g g`/`G` move in lists; `/` filters a filterable list; Escape clears the filter
- [ ] Digits and letters typed into a text field are not treated as shortcuts; Escape leaves the field
- [ ] Focus rings visible when tabbing; status bar hints match the focused pane
- [ ] An error line is dismissed with Escape

## 3. Install review

- [ ] Fresh state: the `workspace` row is `current` and `u` on it is disabled (`already current`); `u` on a harness row opens the plan table with create rows and a backup/rollback footer
- [ ] `n` (and Escape) cancels; nothing was written (check the isolated workspace dir)
- [ ] `p` shows the plan with no apply path; `n` closes it
- [ ] `u` then `y` on a harness installs it: `.agent-workspace/managed-state.json` exists; no `.agent-workspace/workspace.json` is created and no bundle file (`docs/`, `skills/`, `templates/`, ...) appears in the data folder
- [ ] The output strip under the panes opens by itself with the result; a second `u` reports `nothing to change`, no mutation
- [ ] `d` expands a row's details; `c` jumps to the next conflict; `j`/`k` move rows
- [ ] A modified installed harness file (for example `~/.claude/skills/tdd/SKILL.md`) appears as a conflict row (`preserved, skipped`), `y` applies only the safe rows, and the conflict file is unchanged
- [ ] Moving the conflicting file away and installing again updates it
- [ ] A stale plan (change the installed file between preview and `y`) fails with a re-preview prompt; `r` previews again
- [ ] `:update codex`, `:update --all`, `:preview opencode` open the same review; `:update` without a target explains itself
- [ ] Each page has exactly one install path (`u`); no per-surface mutation or duplicate skills install controls exist
- [ ] Workspace page: `o` opens the workspace folder; `B` opens the backups folder; `r` refreshes

## 4. Target toggles

- [ ] Codex page: Space toggles targets, the change autosaves (no Save button)
- [ ] Fresh settings: every target is on except `codex_config`, `claude_config` and `kilo_mcp`
- [ ] With `codex_config` off, a Codex plan has no config rows and `~/.codex/config.toml` is untouched
- [ ] With `claude_config` off, the Claude page shows `config` as off ("Claude Code keeps its default commit and PR attribution") and `~/.claude/settings.json` is not opened or changed
- [ ] Turning a target off hides its surface from the plan and the status shows it as `off`
- [ ] Turning it on adds it back to the next preview
- [ ] Legacy settings file without `target_defaults_version`: migration keeps targets that were enabled or already managed
- [ ] The skills surface and the `workspace` row are never gated

## 5. Rules block, Convert, Leave as is

Use fixture files in the isolated `HOME` (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`).

- [ ] Absent rules file: install creates a file holding the `BEGIN`/`END AGENT-WORKSPACE BASE` block
- [ ] Text added below the END marker survives an update; a base update reports `update_available` and how many refinement lines it keeps
- [ ] Edited block: conflict `base_block_edited`, file unchanged by `y`
- [ ] Pre-existing file without markers: conflict `legacy_diverged`; file identical to a shipped base is wrapped after a full backup
- [ ] Harness page rules row: `d` shows the diff, `v` shows the conversion preview (exact resulting file) and asks to confirm, `m` leaves the file as is; `:rules` mirrors them
- [ ] Convert keeps changed `##` sections below the END marker and writes a backup under `setup/`
- [ ] Leave as is changes the status to "base updates available, you manage this file" and writes `.agent-workspace/rules-preferences.json`; install no longer touches the file
- [ ] Malformed markers (duplicate, unpaired, reordered) refuse with zero mutation
- [ ] Non-empty `AGENTS.override.md` next to Codex rules produces a Codex health warning

## 5b. Skill and agent conflicts (diff, keep mine, hand back, take bundled)

Use the isolated `HOME`; install the skills and agents first, then edit `~/.claude/skills/tdd/SKILL.md` and `~/.claude/agents/verifier.md`.

- [ ] The edited files are conflicts ("edited since Riggverk wrote it"); the Claude page lists `tdd` and `verifier` under "your files in conflict" with their folder and the harnesses that read it; the skills and agents rows say "N conflicts"
- [ ] `d` on the skills row opens the diff of `tdd` (yours against bundled, `+`/`-` glyphs, read-only, nothing written); `]` and `[` move between units; `n` closes
- [ ] A file that differs only in line endings says so; a binary file and a file with a private-key block show no text
- [ ] `m` asks first; after confirming, the unit is "you manage", the surface no longer counts it as a conflict, `u` leaves the file untouched and `.agent-workspace/kept-files.json` names it; no backup is made
- [ ] After the bundled file changes (a new release), the unit says "bundled update available"; the file is still not written
- [ ] `m` on a kept unit hands it back at once and the file is a conflict again
- [ ] A skill directory that is a symlink, or a directory where a file belongs, is a conflict with no `d` or `m`
- [ ] Codex config on, one enforced key changed by hand (`approvals_reviewer = "auto_review"`): the row shows a conflict naming the key; `m` asks first, then the row reads "current · you keep 1", `config.toml` is untouched, `.agent-workspace/config-preferences.json` names the key, and `m` again hands it back
- [ ] A retired skill (not bundled) that you edited and kept survives `u` with all its files; uninstall leaves kept files and `kept-files.json`
- [ ] Take bundled: edit `~/.claude/skills/tdd/SKILL.md` (and one more file of another skill, which you leave alone), press `b` on `tdd`. The review writes nothing and shows the files, the backup name (`artifacts/skill-claude-tdd~SKILL.md`), the diff and "your files are backed up first"; Enter does nothing; `n` cancels. After `y` the file equals the bundled one, the unit is gone from the list, the other conflict is untouched, other pending updates were not applied, and the choice to keep it (if it was kept) is gone
- [ ] The backup of that transaction (backup folder, `setup/<run>/artifacts/skill-claude-tdd~SKILL.md`) holds your exact bytes; `z` restores them and the unit is a conflict again (not kept); if you edit the file again after take bundled, `z` leaves your edit and says so
- [ ] Take bundled is disabled with its reason on a retired skill and while another task runs; after keeping or handing back with a review open, `y` is refused as stale and `r` previews again
- [ ] Copy the bundled file over a kept file by hand, then run any Install: the choice for that file is gone (its next edit is a conflict, not silently kept)
- [ ] The workspace page lists the harness with "you manage N" or "N in conflict" and points at the harness page; `:resolve diff tdd` does what `d` does and `:resolve bundled tdd` opens the same review as `b`

## 6. Rollback and uninstall

- [ ] After `y`, the output strip shows the transaction and takes focus; `z` there (or `:rollback`) runs a dry run and a confirm, then restores the backed-up files
- [ ] `:rollback` with nothing to roll back says so
- [ ] Backups exist under `setup/<transaction id>/` with `manifest.json`, `artifacts/`, `managed-state.previous.json` (dirs 0700, files 0600); Library saves of personal docs under `docs/custom_<slug>-<timestamp>/`, of rules refinements under `docs/rules-<surface>-<timestamp>/`
- [ ] The workspace detail pane lists the backup run count and the root path; `B` there opens the folder
- [ ] **preview uninstall** classifies removable, preserved, and merge-managed artifacts; modified and unknown fixture files stay on disk after uninstall
- [ ] Merge-managed rules files with user text outside the block are kept; a file with only an unedited block is removable
- [ ] **uninstall everything** removes proven app-owned files (old workspace copies the app still owns included); the data folder, its `.agent-workspace/` state, `docs/context/` and your own files stay
- [ ] **Recover previous uninstall** stays visible after the uninstall
- [ ] **preview recovery** is read-only and reports restore, already restored, and conflict counts
- [ ] **restore workspace** opens a confirmation; Escape closes it and focus returns to the button; cancel leaves the candidate unchanged; **confirm restore** brings workspace and harness state back and the card disappears
- [ ] A changed or occupied restore target reports a conflict and restore stays disabled
- [ ] No console errors during install, rollback, uninstall, and recovery

## 6b. Cleanup of old workspace copies

Run with a temporary `HOME` (never the real one), with `AGENT_WORKSPACE_PATH` unset so the default `$HOME/.config/agent-workspace` is used. The tag `v0.1.0-rc.1` must exist locally. Seed the data folder with what an earlier release installed, from the repository root:

```bash
export HOME="$(mktemp -d)"
unset AGENT_WORKSPACE_PATH
export AGENT_WORKSPACE_BACKUP_DIR="$HOME/backups"
mkdir -p "$HOME/seed" "$HOME/.config"
git archive v0.1.0-rc.1 resources/default-workspace | tar -x -C "$HOME/seed"
mv "$HOME/seed/resources/default-workspace" "$HOME/.config/agent-workspace"
cd "$HOME/.config/agent-workspace"
echo "my notes" > notes.txt                          # your own file
mkdir -p docs/context && echo "mine" > docs/context/mine.md   # a personal doc
echo "edited" >> README.md                           # an edited copy
find . -type f -print0 | sort -z | xargs -0 shasum > "$HOME/before.sha"
cd - >/dev/null
npm run tauri dev
```

- [ ] Launch changes nothing: the `workspace` row reads `N old copies to remove`, and the files in the data folder are unchanged (rerun the `find` above, with `-not -path './.agent-workspace/*'`, into `$HOME/launch.sha` and `diff` it against `before.sha`)
- [ ] `u` on the workspace row opens a review that lists the removals per top-level folder (for example `- skills/ (N old copies; backed up, z restores them)`) and `README.md` as left in place ("edited or not the app's: left in place"), with no conflict rows; `n` cancels and nothing changes
- [ ] `u` then `y`: the data folder holds only `.agent-workspace/`, `docs/context/mine.md`, `notes.txt` and the edited `README.md`; emptied folders are gone; `.agent-workspace/` and `docs/context/` are untouched; the status pane shows `personal docs 1`, `ownership records present` and `left in place 1`
- [ ] `z` (dry run, then confirm): every file is back byte for byte (rerun the `find` with `-not -path './.agent-workspace/*'` into `$HOME/after.sha`; it equals `before.sha`) and the previous ownership records are restored; the row reads `N old copies to remove` again
- [ ] `u` then `y` again: the row reads `current` and `u` is off (`already current`); `p` previews nothing to apply, and the edited `README.md` is still listed as left in place
- [ ] A symlink in place of a copy, and a copy below a symlinked folder, are listed as left in place and untouched; a folder where a copy was is left in place too
- [ ] **uninstall everything** on a freshly seeded profile removes the old copies the app still owns and keeps the data folder, `.agent-workspace/`, `docs/context/`, `notes.txt`; **Recover previous uninstall** is reachable
- [ ] A seeded folder saved as the custom folder (Settings state from an earlier version) stays configured after the cleanup

## 7. Codex 0.134+ migration

- [ ] `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` apply correctly with `codex_config` on
- [ ] `model` and `model_reasoning_effort` are written only when the file has none; an existing value is never changed or reported as drift
- [ ] App-shaped legacy `profile = "safe"` / `"workspace-write"` selectors and `[profiles.*]` tables are removed while still app-shipped
- [ ] Custom profiles, unrelated keys, MCP entries, personality, comments, and same-line inline comments remain
- [ ] Ambiguous managed lines refuse safely with zero mutation
- [ ] With `CODEX_HOME` set, rules, agents, config, and skills land under it (nothing for Codex in `~/.agents/skills`)
- [ ] With the default `CODEX_HOME`, skills land in `~/.agents/skills`; the app's older copies in `~/.codex/skills` are removed by one reviewed update (`.system` stays), and an edited copy stays and is reported
- [ ] Disabling a harness in Settings changes the next preview only; the update removes the app's copies from a folder no enabled harness reads

## 7b. Claude attribution (`claude_config`)

Use a scratch profile or back up `~/.claude/settings.json` first.

- [ ] Claude page, `config` row is off; Space turns it on, and the review of a missing file says `+ ~/.claude/settings.json (new file; hides commit and PR attribution)`
- [ ] Install writes `attribution.commit` and `attribution.pr` as `""`; a commit made by Claude Code in a scratch repo has no `Co-Authored-By` trailer, and a PR it opens has no "Generated with Claude Code" line
- [ ] A file with `env`, `hooks` and `permissions` keeps all of them, in order, after Install; the row then reads current ("attribution hidden by Riggverk ...")
- [ ] `z` after the Install restores the file as it was (or removes it, if the Install created it)
- [ ] Custom `attribution.commit` text, `"attribution": false`, `includeCoAuthoredBy`, or both keys `""` that Riggverk did not write: the row says "you set attribution yourself" and the file is not changed
- [ ] A comment, a trailing comma or an unexpected `attribution` type is a conflict with a fixed reason and no file text; nothing is written
- [ ] With `CLAUDE_CONFIG_DIR` set when the app starts, the row is a conflict ("CLAUDE_CONFIG_DIR is set; Riggverk only edits ~/.claude/settings.json") and nothing is written
- [ ] Uninstall lists `~/.claude/settings.json` as left in place and does not delete it; Claude health shows nothing from the file

## 8. Settings, workspace folder, harness enablement

- [ ] Fresh and legacy settings enable Codex, OpenCode, Claude, and Cursor; GitHub Copilot, Pi, and Kilo are listed after them and disabled
- [ ] Enable Copilot, Pi, and Kilo: the Copilot, Pi and Kilo tabs appear after Claude; each page lists a `rules` row (target toggle on), the `skills` surface and an `mcp` row (toggle on for Copilot and Pi, **off** for Kilo), shows the CLI version (or "not on PATH" with its reason; an nvm-only install shows `· nvm`), the rules row, the `mcp playwright` row and the skills row; Kilo's review notes that `~/.claude/CLAUDE.md` stops being read; Install or Update then writes `~/.agents/skills`, the three rules files (`~/.copilot/copilot-instructions.md`, `~/.pi/agent/AGENTS.md` with owner-only folders, `~/.config/kilo/AGENTS.md`) and the Copilot and Pi MCP entries (`~/.copilot/mcp-config.json`, `~/.pi/agent/mcp.json`, both 0600 when new) and nothing else under `~/.copilot`, `~/.pi`, `~/.config/kilo`; with a Pi `AGENTS.override.md` or an `AGENTS.md`-less `CLAUDE.md` in `~/.pi/agent` the Pi rules row is a conflict and nothing is written; `:p` still previews and `:pi` opens the Pi page
- [ ] MCP entries of the light tier (isolated `HOME`; the CLIs are the owner's, the app runs none of these commands). Create: no file, Install writes a file holding only `playwright`. Merge: a file with another server (a fake token in its `env`), an unrelated top-level key and a different key order keeps all of it, with the entry appended; Rollback restores the file byte for byte, or after an edit elsewhere removes only the entry. Conflict: a file with a comment, a trailing comma or a byte order mark, an `mcpServers` that is an array, and a `playwright` entry of your own are each reported with a plain reason, nothing is written and no backup is made; the message shows no text of the file
- [ ] Kilo MCP (`kilo_mcp` off by default): switch the target on; with no config file Install creates `kilo.jsonc`; with a `kilo.jsonc` holding only `$schema` (what Kilo writes on first run) the entry is added and `$schema` stays first; with only a `kilo.json` that one is written and no `kilo.jsonc` appears; with both, `kilo.jsonc` is written. A `~/.kilo/kilo.jsonc` or an `opencode.json` in the config folder makes the Kilo page warn that it wins over the entry. With `XDG_CONFIG_HOME` set to an absolute folder outside `HOME` the files are there and `~/.config/kilo` is untouched
- [ ] Live check with the real CLIs, owner-run (not part of `release-check`): `copilot mcp get playwright` shows the entry with source User and the environment values masked; in VS Code the Copilot sessions list the server once. `pi mcp list` shows `playwright` connected with 22 tools and `exposure` `codemode`; add `"exposure": "direct"` to the entry by hand and the model sees the tools (the Pi page notes this). `kilo mcp list` shows `playwright`. In each, ask a session with a model to open a local page with the Playwright tool and confirm the system Chrome opens in a fresh profile, and that no `webmcp_*` tool is listed for a page that registers one (the Cursor and OpenCode entries pass the same `--browser chrome --isolated --no-webmcp` after `--config`; one launch from each settles that)
- [ ] With Codex enabled and `CODEX_HOME` customised, Copilot and Pi read `unserved` with the warning, nothing is installed for them, and Kilo is served through `~/.claude/skills`
- [ ] Appearance (dark, light, system), all four text sizes (`small`, `medium`, `large`, `extra-large`), and theme colors autosave; `r` in the appearance pane resets after a confirm
- [ ] Motion `full` shows the launch sequence, apply progress (bar, file, spinner, elapsed), the success tick and scanline; `subtle` keeps only the progress indicators; `off` (or the OS reduced-motion preference) stops every animation
- [ ] Landing page selection (`start`, `library`) persists and opens after app restart
- [ ] Settings has no folder chooser: no `choose…` action, no `c` hint, `c` does nothing, and `:workspace choose` is refused
- [ ] With a custom folder saved by an earlier version (seeded in an isolated profile; it holds `.agent-workspace/`), Settings shows it as `custom folder` and the app keeps using it across a restart, also after the old copies in it are removed (see 6b)
- [ ] `R` (and `:workspace reset`) on that folder opens a confirm that names the old folder and says its ownership records stay there; `n` or Escape changes nothing; `y` returns to the default path and status reloads; on the default folder `R` is disabled (`already the default workspace`)
- [ ] `AGENT_WORKSPACE_PATH` overrides the saved path, and `R` is then refused with a reason
- [ ] Generator scripts run from the bundled copy: a modified `scripts/generate-opencode-config.py` in a saved custom workspace is not executed
- [ ] Disable one harness: its tab, page, Workspace row, health calls, and harness-specific Library entries disappear and the tabs renumber
- [ ] Isolated harness files stay byte-identical after disable; restart preserves the disabled state and target selections
- [ ] Re-enable restores UI and health without installing
- [ ] Disable every harness: workspace, library, and settings stay usable
- [ ] A stale setup request for a disabled harness fails without mutation
- [ ] Full uninstall preview still includes proven artifacts of disabled harnesses
- [ ] All four text sizes usable at the minimum window size

## 9. Library

- [ ] Library shows the items list and one document pane (rendered by default); `[` `]` (and `<` `>`) switch among docs, rules, skills, agents, configs
- [ ] On a personal doc (`docs/context/`, tagged "context"), `i` or Enter swaps the rendered document for its source; `Mod+s` and `:w` save; Escape returns to the rendered view; `h` returns to the list; `:q` asks before discarding edits; `:reset` discards them; `n` creates a doc; `o` opens it externally
- [ ] Bundled items (bundled docs, the Global Rules row, skills, agents, every config source) show "read-only" in the pane title and "bundled with the app: read-only here" in the footer; the `i`/Enter, `Mod+s` and `o` hints are disabled with that reason; `:w` refuses with it; no textarea ever opens
- [ ] Docs: select, preview, personal doc edit, dirty state, save, reset, create form, Markdown table, fenced code, code copy; bundled docs show their path inside the bundle (`docs/START_HERE.md`), and no "Bundled docs need update" banner exists
- [ ] Saving a personal doc over its existing file creates `docs/custom_<slug>-<timestamp>/` in the backup root; a symlinked doc or a linked `docs/context` folder is refused
- [ ] Library edits do not change what a harness install writes (installs come from the bundle)
- [ ] With a throwaway `HOME`, put an edited old copy in the data folder (for example `docs/START_HERE.md`): the Library still shows the bundled text, and the item's footer has no "may differ" note
- [ ] Rules lists Global Rules under "bundled base" and, under "your rules files", one row per enabled harness; a disabled harness or rules target has no row
- [ ] With a throwaway `HOME`: on a rules file with a block, the managed base shows dimmed and read-only above the refinements, `i` edits only the refinements, and `Mod+s` saves; a hash of the file up to and including the END line is unchanged, `docs/rules-<surface>-<timestamp>/` holds the previous file, and Install then reports the file current (or a base update) with the refinement count unchanged
- [ ] A rules file that is absent, has no block, has malformed markers, or is a symlink (or sits in a linked folder) is listed with its reason, read-only; `o` opens an existing one, also through a link
- [ ] Editing a rules file elsewhere after opening it: the save is refused as changed on disk, the file reloads with the draft kept, and a second save writes it
- [ ] No Tools icon or tool switcher exists

## 10. Known limitations

- The `.agent-workspace/workspace.json` marker is not created for new users and is never removed where an earlier release wrote it; the default workspace path is `~/.config/agent-workspace`
- Uninstall recovery and the in-app rollback of the last install are session-scoped; they are not rediscovered after a restart even when transaction evidence remains on disk
- Opening folders uses the macOS `open` command only
- Python 3 must be on `PATH` for config merges and generators

## 11. Pass / fail report template

```
## Riggverk App Smoke Report

- Commit: ________
- Build command: ________
- Machine: ________
- App version: ________
- App bundle path: ________ (or "dev mode")

### Automated release-check
- [ ] `./scripts/release-check.sh` passed
- Notes: ________

### Shell and keyboard layer
- [ ] Tabs, help, command line, pane and list keys passed
- Notes: ________

### Install review and target toggles
- [ ] Review, cancel, apply, conflicts, stale plan, toggles passed
- Notes: ________

### Rules (Convert, Leave as is, diff)
- [ ] Block create/update, conflict, convert, leave-as-is passed
- Notes: ________

### Skill and agent conflicts (diff, keep mine, hand back, take bundled)
- [ ] Conflict listing, diff, keep, hand back, take bundled and its rollback, blocked files passed
- Notes: ________

### Rollback and uninstall
- [ ] Rollback, backup layout, uninstall preview, recovery passed
- Notes: ________

### Cleanup of old workspace copies
- [ ] Seeded rc.1 folder: review per folder, left-in-place file, apply, `z` restore, second preview empty passed
- Notes: ________

### Codex migration
- [ ] Managed fields, create-only model, legacy profile cleanup passed
- Notes: ________

### Settings and workspace folder
- [ ] Appearance, motion levels, landing page, workspace folder reset, harness enablement passed
- Notes: ________

### Library
- [ ] Panes, personal doc save and backup, rules refinements save and backup, bundled items read-only passed
- Notes: ________

### Skipped checks and residual risk
- Skipped: ________
- Residual risk: ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready
```
