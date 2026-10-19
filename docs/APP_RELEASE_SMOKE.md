# App Release Smoke

Manual smoke checklist for Riggverk builds. It complements `scripts/release-check.sh`, which covers syntax, bundled-default checks, source scans, the app build, Cargo checks, apply smokes in temporary `HOME` directories, and the backend runtime smoke. It does not drive the webview, an installed bundle, or the folder picker.

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

- [ ] First launch shows `not installed`, no generic error banner, no path chooser on the Workspace page
- [ ] Workspace page shows `~/.config/agent-workspace` (or the isolated override)
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

- [ ] Fresh state: Workspace page shows `not installed`; `u` on the workspace row opens the plan table with create rows and a backup/rollback footer
- [ ] `n` (and Escape) cancels; nothing was written (check the isolated workspace dir)
- [ ] `p` shows the plan with no apply path; `n` closes it
- [ ] `u` then `y` installs: `.agent-workspace/workspace.json`, `.agent-workspace/managed-state.json`, and the bundled files exist
- [ ] The output strip under the panes opens by itself with the result; a second `u` reports `nothing to change`, no mutation
- [ ] `d` expands a row's details; `c` jumps to the next conflict; `j`/`k` move rows
- [ ] A modified bundled file in the workspace appears as a conflict row (`preserved, skipped`), `y` applies only the safe rows, and the conflict file is unchanged
- [ ] Moving the conflicting file away and installing again updates it
- [ ] A stale plan (change the installed file between preview and `y`) fails with a re-preview prompt; `r` previews again
- [ ] `:update codex`, `:update --all`, `:preview opencode` open the same review; `:update` without a target explains itself
- [ ] Each page has exactly one install path (`u`); no per-surface mutation or duplicate skills install controls exist
- [ ] Workspace page: `o` opens the workspace folder; `B` opens the backups folder; `r` refreshes

## 4. Target toggles

- [ ] Codex page: Space toggles targets, the change autosaves (no Save button)
- [ ] Fresh settings: every target is on except `codex_config`
- [ ] With `codex_config` off, a Codex plan has no config rows and `~/.codex/config.toml` is untouched
- [ ] Turning a target off hides its surface from the plan and the status shows it as `off`
- [ ] Turning it on adds it back to the next preview
- [ ] Legacy settings file without `target_defaults_version`: migration keeps targets that were enabled or already managed
- [ ] The skills surface and the workspace bundle are never gated

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
- [ ] A retired skill (not bundled) that you edited and kept survives `u` with all its files; uninstall leaves kept files and `kept-files.json`
- [ ] Take bundled: edit `~/.claude/skills/tdd/SKILL.md` (and one more file of another skill, which you leave alone), press `b` on `tdd`. The review writes nothing and shows the files, the backup name (`artifacts/skill-claude-tdd~SKILL.md`), the diff and "your files are backed up first"; Enter does nothing; `n` cancels. After `y` the file equals the bundled one, the unit is gone from the list, the other conflict is untouched, other pending updates were not applied, and the choice to keep it (if it was kept) is gone
- [ ] The backup of that transaction (backup folder, `setup/<run>/artifacts/skill-claude-tdd~SKILL.md`) holds your exact bytes; `z` restores them and the unit is a conflict again (not kept); if you edit the file again after take bundled, `z` leaves your edit and says so
- [ ] Take bundled is disabled with its reason on a retired skill and while another task runs; after keeping or handing back with a review open, `y` is refused as stale and `r` previews again
- [ ] Copy the bundled file over a kept file by hand, then run any Install: the choice for that file is gone (its next edit is a conflict, not silently kept)
- [ ] The workspace page lists the harness with "you manage N" or "N in conflict" and points at the harness page; `:resolve diff tdd` does what `d` does and `:resolve bundled tdd` opens the same review as `b`

## 6. Rollback and uninstall

- [ ] After `y`, the output strip shows the transaction and takes focus; `z` there (or `:rollback`) runs a dry run and a confirm, then restores the backed-up files
- [ ] `:rollback` with nothing to roll back says so
- [ ] Backups exist under `setup/<transaction id>/` with `manifest.json`, `artifacts/`, `managed-state.previous.json` (dirs 0700, files 0600); Library saves of personal docs under `docs/custom_<slug>-<timestamp>/`
- [ ] The workspace detail pane lists the backup run count and the root path; `B` there opens the folder
- [ ] **preview uninstall** classifies removable, preserved, and merge-managed artifacts; modified and unknown fixture files stay on disk after uninstall
- [ ] Merge-managed rules files with user text outside the block are kept; a file with only an unedited block is removable
- [ ] **uninstall everything** removes proven app-owned files and the workspace becomes invalid
- [ ] **Recover previous uninstall** stays visible after the workspace becomes invalid or missing
- [ ] **preview recovery** is read-only and reports restore, already restored, and conflict counts
- [ ] **restore workspace** opens a confirmation; Escape closes it and focus returns to the button; cancel leaves the candidate unchanged; **confirm restore** brings workspace and harness state back and the card disappears
- [ ] A changed or occupied restore target reports a conflict and restore stays disabled
- [ ] No console errors during install, rollback, uninstall, and recovery

## 7. Codex 0.134+ migration

- [ ] `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` apply correctly with `codex_config` on
- [ ] `model` and `model_reasoning_effort` are written only when the file has none; an existing value is never changed or reported as drift
- [ ] App-shaped legacy `profile = "safe"` / `"workspace-write"` selectors and `[profiles.*]` tables are removed while still app-shipped
- [ ] Custom profiles, unrelated keys, MCP entries, personality, comments, and same-line inline comments remain
- [ ] Ambiguous managed lines refuse safely with zero mutation
- [ ] With `CODEX_HOME` set, rules, agents, config, and skills land under it (nothing for Codex in `~/.agents/skills`)
- [ ] With the default `CODEX_HOME`, skills land in `~/.agents/skills`; the app's older copies in `~/.codex/skills` are removed by one reviewed update (`.system` stays), and an edited copy stays and is reported
- [ ] Disabling a harness in Settings changes the next preview only; the update removes the app's copies from a folder no enabled harness reads

## 8. Settings, workspace picker, harness enablement

- [ ] Fresh and legacy settings enable Codex, OpenCode, Claude, and Cursor; GitHub Copilot, Pi, and Kilo are listed after them and disabled
- [ ] Enable Copilot, Pi, and Kilo: the Copilot, Pi and Kilo tabs appear after Claude; each page lists a `rules` row (target toggle on), the `skills` surface and an `mcp` row (toggle on for Copilot and Pi, **off** for Kilo), shows the CLI version (or "not on PATH" with its reason; an nvm-only install shows `· nvm`), the rules row, the `mcp playwright` row and the skills row; Kilo's review notes that `~/.claude/CLAUDE.md` stops being read; Install or Update then writes `~/.agents/skills`, the three rules files (`~/.copilot/copilot-instructions.md`, `~/.pi/agent/AGENTS.md` with owner-only folders, `~/.config/kilo/AGENTS.md`) and the Copilot and Pi MCP entries (`~/.copilot/mcp-config.json`, `~/.pi/agent/mcp.json`, both 0600 when new) and nothing else under `~/.copilot`, `~/.pi`, `~/.config/kilo`; with a Pi `AGENTS.override.md` or an `AGENTS.md`-less `CLAUDE.md` in `~/.pi/agent` the Pi rules row is a conflict and nothing is written; `:p` still previews and `:pi` opens the Pi page
- [ ] MCP entries of the light tier (isolated `HOME`; the CLIs are the owner's, the app runs none of these commands). Create: no file, Install writes a file holding only `playwright`. Merge: a file with another server (a fake token in its `env`), an unrelated top-level key and a different key order keeps all of it, with the entry appended; Rollback restores the file byte for byte, or after an edit elsewhere removes only the entry. Conflict: a file with a comment, a trailing comma or a byte order mark, an `mcpServers` that is an array, and a `playwright` entry of your own are each reported with a plain reason, nothing is written and no backup is made; the message shows no text of the file
- [ ] Kilo MCP (`kilo_mcp` off by default): switch the target on; with no config file Install creates `kilo.jsonc`; with a `kilo.jsonc` holding only `$schema` (what Kilo writes on first run) the entry is added and `$schema` stays first; with only a `kilo.json` that one is written and no `kilo.jsonc` appears; with both, `kilo.jsonc` is written. A `~/.kilo/kilo.jsonc` or an `opencode.json` in the config folder makes the Kilo page warn that it wins over the entry. With `XDG_CONFIG_HOME` set to an absolute folder outside `HOME` the files are there and `~/.config/kilo` is untouched
- [ ] Live check with the real CLIs, owner-run (not part of `release-check`): `copilot mcp get playwright` shows the entry with source User and the environment values masked; in VS Code the Copilot sessions list the server once. `pi mcp list` shows `playwright` connected with 22 tools and `exposure` `codemode`; add `"exposure": "direct"` to the entry by hand and the model sees the tools (the Pi page notes this). `kilo mcp list` shows `playwright`. In each, ask a session with a model to open a local page with the Playwright tool and confirm the system Chrome opens in a fresh profile (this one launch also settles which browser the sidecar entries of Cursor and OpenCode open)
- [ ] With Codex enabled and `CODEX_HOME` customised, Copilot and Pi read `unserved` with the warning, nothing is installed for them, and Kilo is served through `~/.claude/skills`
- [ ] Appearance (dark, light, system), all four text sizes (`small`, `medium`, `large`, `extra-large`), and theme colors autosave; `r` in the appearance pane resets after a confirm
- [ ] Motion `full` shows the launch sequence, apply progress (bar, file, spinner, elapsed), the success tick and scanline; `subtle` keeps only the progress indicators; `off` (or the OS reduced-motion preference) stops every animation
- [ ] Landing page selection (`start`, `library`) persists and opens after app restart
- [ ] Settings: `c` chooses a workspace folder; an invalid folder is refused with a reason; a valid one becomes the active workspace and status reloads; `R` resets to the default path
- [ ] `AGENT_WORKSPACE_PATH` overrides the chosen path
- [ ] Generator scripts run from the bundled copy: a modified `scripts/generate-opencode-config.py` in the chosen workspace is not executed
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
- [ ] Docs: select, preview, personal doc edit, dirty state, save, reset, create form, missing bundled-doc banner, Markdown table, fenced code, code copy
- [ ] Saving a personal doc over its existing file creates `docs/custom_<slug>-<timestamp>/` in the backup root; a symlinked doc or a linked `docs/context` folder is refused
- [ ] Library edits do not change what a harness install writes (installs come from the bundle)
- [ ] No Tools icon or tool switcher exists

## 10. Known limitations

- Workspace marker is `.agent-workspace/workspace.json`; the default workspace path is `~/.config/agent-workspace`
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

### Codex migration
- [ ] Managed fields, create-only model, legacy profile cleanup passed
- Notes: ________

### Settings and workspace picker
- [ ] Appearance, motion levels, landing page, picker, harness enablement passed
- Notes: ________

### Library
- [ ] Panes, personal doc save and backup, bundled items read-only passed
- Notes: ________

### Skipped checks and residual risk
- Skipped: ________
- Residual risk: ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready
```
