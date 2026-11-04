# App Release Smoke

Manual smoke checklist for Riggverk builds. It complements `scripts/release-check.sh`, which covers syntax, bundled-default checks, source scans, the app build, Cargo checks, apply smokes in temporary `HOME` directories, and the backend runtime smoke. It does not drive the webview or an installed bundle.

Run this in the real Tauri app (not Vite only: `invoke` does not exist there) with isolated paths:

```bash
export HOME="$(mktemp -d)"
export RIGGVERK_WORKSPACE_PATH="$HOME/workspace"
export RIGGVERK_BACKUP_DIR="$HOME/backups"
npm run tauri dev        # or open the built bundle from this shell
```

The digit keys below are fixed: `1` Overview, `2`-`5` Codex, OpenCode, Cursor, Claude, `6` History, `7` Library, `8` Settings. Copilot, Pi, Kilo, Antigravity and Grok are off by default; once enabled they appear in the sidebar after Claude and have no digit (they open from the sidebar or with `:copilot`, `:pi`, `:kilo`, `:antigravity`, `:grok`). The page names (Overview, agent pages, History, Library, Settings) are the sidebar's.

## 1. Preflight

- [ ] `git status --short` is clean; commit and branch noted for the report
- [ ] `./scripts/release-check.sh` passes
- [ ] `npm run tauri build` succeeds (skip if the environment cannot build bundles)
- [ ] No secrets, private keys, names, or credential-bearing data in `resources/default-workspace/`
- [ ] `./scripts/release-size-report.sh` sizes are in the expected range

## 2. Launch and shell

- [ ] First launch on a fresh profile: the Overview says `Nothing is set up yet.`, the Workspace folder cell reads Up to date (nothing to remove), no generic error line, no path chooser anywhere
- [ ] Expanding the Workspace folder cell shows `~/.config/riggverk` (or the isolated override)
- [ ] Fresh profile: launching creates no `~/.config/riggverk`; agents are not gated; `u` on an agent page installs it without the workspace and creates the folder owner-only (0700) holding only `.riggverk/`
- [ ] The sidebar lists Overview, the enabled agents, History, Library and Settings in that order; the Mac traffic lights sit clear of the brand row; the top bar and the sidebar drag the window; Check and Update all sit in the top bar
- [ ] `?` opens the help overlay listing keys and commands; Escape closes it
- [ ] `:` opens the command line; `:help`, `:codex`, `:theme toggle`, an unknown command (error, no crash)
- [ ] `:whatsnew` opens the release notes (Escape closes); the first launch after an update shows them once, a fresh install does not
- [ ] `Mod+k` opens the command line, `Mod+,` opens Settings, also from inside a text field
- [ ] `1`-`8` open their fixed pages (the digit of a turned-off agent does nothing); `h` and `l` do nothing; `/` focuses the Library search; Escape leaves a text field
- [ ] Digits and letters typed into a text field are not treated as shortcuts; Escape leaves the field
- [ ] Tab goes sidebar, top bar, page, and the focus ring is visible on every stop; the actions of each page are visible buttons that show their key; there is no status bar
- [ ] An error line is dismissed with Escape

## 2b. The screens

Run these on a profile with a few things to decide (edit `~/.claude/CLAUDE.md` inside its block, edit `~/.claude/skills/tdd/SKILL.md`, change `approvals_reviewer` in `~/.codex/config.toml` with `codex_config` on) and once on a fresh one.

- [ ] **Overview**: the headline matches the counts under it (`Your setup works.`, `Nothing is set up yet.`, `Everything is set up.`); the summary row names the six states in words and omits a state with none; a flow map with the sources (Riggverk base, your refinements, one node per pack) on the left and one node per agent on the right (a ring in its state's hue, the filled square for a decision, dimmed when off); selecting an agent, a source or a curve fills the inspector beside it (rows, receipt, actions; Open an agent opens its page) and Esc clears it; the inspector's home view holds any decision, Install everything on a fresh profile and the last update with Undo and History; a run is followed in the inspector and on the map; **Worth a look** lists risky findings and says they are advice only; the line for agents that are off leads to Settings; the Workspace folder cell opens and closes with the keyboard
- [ ] **Check** reads again and says when (`checked HH:MM` in the sidebar foot) without writing; **Update all** opens the review of everything and is disabled with its reason when everything is current; `p` previews with no apply path
- [ ] **Agent page, decisions**: the rules card, the files card and (Codex) the config card come first and span the width; each says what happened in words and has its buttons with their keys; a part that is off reads **Not managed**; the switch "Let Riggverk manage this" autosaves
- [ ] **Compare**: the button toggles `aria-expanded`; the diff folds out under the card (side by side), writes nothing and asks for no token; Escape or `d` folds it away; under motion `subtle` and `off` it appears at once
- [ ] **Merge in updates…**, **Use Riggverk's version…** and **Use Riggverk defaults** each open a review first (the exact file, the files and backup name, or the exact keys); Enter does nothing, `y` or the Apply button applies, `n` cancels; the card becomes **Up to date** afterwards. **Keep mine** and **Hand back** ask first
- [ ] **Use Riggverk defaults** (Codex, `approvals_reviewer` differing): the review lists the key with Riggverk's value and yours, nothing else; after `y` only that key in `config.toml` changed, the file has a backup, comments and other keys are untouched, and `z` restores the previous bytes; a preview made before an edit of `config.toml` is refused as stale
- [ ] **History**: every update newest first with a pill (**Done**, **Undone**, **Failed**) in words; a row opens to its receipt (Changed, Checked, Left for you, Backup) and the newest is open; the list is the same after a restart; **Undo this update…** is offered on the newest completed update only, asks first (dry run, confirm), and the row then reads **Undone**; an empty profile says nothing has been updated yet
- [ ] **Library packs**: a pack in `packs/<pack>/skills/` appears under Skills (Yours) as `pack:<name>` and under Packs, read-only, with its state ring; **Forget pack** asks first; a skill shadowed by a bundled one says "shadowed · bundle wins"; an empty Packs topic says **No packs** with the packs folder
- [ ] **Pack routing**: a pack with a valid `routing.md` shows a `routing.md` row with its lines under Packs, and the next Update lists every rules file as an update whose diff adds them under `## Pack skill routing`; Undo puts the previous block back; a line naming a bundled skill shows `routing.md is not used: line N ...` under the pack problems and nothing is added
- [ ] **Imported routing**: import a skill with a routing suggestion, then edit it with **Routing…**; confirm the line appears in the imported pack and the next Update preview
- [ ] **Settings**: Theme, Text size and Motion are segmented controls that autosave; colors take a hex with a contrast warning; each agent has a named switch; the landing page is Overview or Library; `R` asks before it resets the workspace folder
- [ ] Both themes and the window at its minimum size: nothing overflows sideways at the largest text size, text stays readable, state words are never color alone

## 3. Install review

- [ ] Fresh state: the Overview says `Nothing is set up yet.`; **Update all** opens a plan with create rows for every enabled agent and a backup/rollback footer; `u` on an agent page does the same for that agent
- [ ] `n` (and Escape) cancels; nothing was written (check the isolated workspace dir)
- [ ] `p` shows the plan with no apply path; `n` closes it
- [ ] `u` then `y` on a harness installs it: `.riggverk/managed-state.json` exists; no `.riggverk/workspace.json` is created and no bundle file (`docs/`, `skills/`, `templates/`, ...) appears in the data folder
- [ ] The run line under the page (on every page, Library, History and Settings included) shows the progress while it runs, then **Done** with the time, **Undo last update…**, **Details** (the redacted log, with a Copy output button) and **Dismiss**; a second `u` reports `nothing to change`, no mutation
- [ ] `d` expands a row's details; `c` jumps to the next conflict; `j`/`k` move rows
- [ ] A modified installed harness file (for example `~/.claude/skills/tdd/SKILL.md`) appears as a conflict row (`preserved, skipped`), `y` applies only the safe rows, and the conflict file is unchanged
- [ ] Moving the conflicting file away and installing again updates it
- [ ] A stale plan (change the installed file between preview and `y`) fails with a re-preview prompt; `r` previews again
- [ ] `:update codex`, `:update --all`, `:preview opencode` open the same review; `:update` without a target explains itself
- [ ] Each page has exactly one install path (`u`); no per-surface mutation or duplicate skills install controls exist
- [ ] Overview: `o` and **Open folder** open the workspace folder; `B` and **Backups folder** open the backups folder; `r` and **Check** refresh

## 4. Target toggles

- [ ] Codex page: the switches turn targets on and off (Space or Enter on a focused switch), the change autosaves (no Save button)
- [ ] Fresh settings: every target is on except `codex_config`, `claude_config`, `kilo_mcp`, `antigravity_mcp` and `grok_mcp`
- [ ] With `codex_config` off, a Codex plan has no config rows and `~/.codex/config.toml` is untouched
- [ ] With `claude_config` off, the Claude page shows `config` as off ("Claude Code keeps its default commit and PR attribution") and `~/.claude/settings.json` is not opened or changed
- [ ] Turning a target off hides its surface from the plan and the status shows it as `off`
- [ ] Turning it on adds it back to the next preview
- [ ] Legacy settings file without `target_defaults_version`: migration keeps targets that were enabled or already managed
- [ ] The skills surface and the workspace folder are never gated

## 5. Rules block, Merge in updates, Keep mine

Use fixture files in the isolated `HOME` (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`).

- [ ] Absent rules file: install creates a file holding the `BEGIN`/`END RIGGVERK BASE` block
- [ ] Text added below the END marker survives an update; a base update reports `update_available` and how many refinement lines it keeps
- [ ] Edited block: conflict `base_block_edited`, file unchanged by `y`
- [ ] Pre-existing file without markers: conflict `legacy_diverged`; file identical to a shipped base is wrapped after a full backup
- [ ] Agent page rules card: **Compare** (`d`) folds out the diff, **Merge in updates…** (`v`) shows the conversion preview (exact resulting file) and applies only on `y`, **Keep mine** (`m`) asks first and leaves the file as is; `:rules` mirrors them
- [ ] Convert keeps changed `##` sections below the END marker and writes a backup under `setup/`
- [ ] Keep mine changes the state to Yours ("base updates available, you manage this file") and writes `.riggverk/rules-preferences.json`; install no longer touches the file
- [ ] Malformed markers (duplicate, unpaired, reordered) refuse with zero mutation
- [ ] Non-empty `AGENTS.override.md` next to Codex rules produces a Codex health warning

## 5b. Skill and agent conflicts (Compare, Keep mine, Hand back, Use Riggverk's version)

Use the isolated `HOME`; install the skills and agents first, then edit `~/.claude/skills/tdd/SKILL.md` and `~/.claude/agents/verifier.md`.

- [ ] The edited files are decisions ("edited since Riggverk wrote it"); the Claude page shows `tdd` and `verifier` on the skills and agents cards with their folder and the agents that read it, and the cards say how many files you edited
- [ ] **Compare** on `tdd` folds out the diff (yours against bundled, read-only, nothing written); **Next file** (`c`) moves between files; Escape folds it away
- [ ] A file that differs only in line endings says so; a binary file and a file with a private-key block show no text
- [ ] **Keep mine** (`m`) asks first; after confirming, the file reads "you manage", the card no longer counts it as a decision, `u` leaves the file untouched and `.riggverk/kept-files.json` names it; no backup is made
- [ ] After the bundled file changes (a new release), the unit says "bundled update available"; the file is still not written
- [ ] **Hand back** on a kept file hands it back at once and the file is a decision again
- [ ] A skill directory that is a symlink, or a directory where a file belongs, is a conflict with no Compare or Keep mine
- [ ] Codex config on, one enforced key changed by hand (`approvals_reviewer = "auto_review"`): the card shows the key with Riggverk's value and yours; **Keep mine** (`m`) asks first, then the cell reads "you keep 1", `config.toml` is untouched, `.riggverk/config-preferences.json` names the key, and **Hand back** returns it
- [ ] A retired skill (not bundled) that you edited and kept survives `u` with all its files; uninstall leaves kept files and `kept-files.json`
- [ ] Take bundled: edit `~/.claude/skills/tdd/SKILL.md` (and one more file of another skill, which you leave alone), choose **Use Riggverk's version…** (`b`) on `tdd`. The review writes nothing and shows the files, the backup name (`artifacts/skill-claude-tdd~SKILL.md`), the diff and "your files are backed up first"; Enter does nothing; `n` cancels. After `y` the file equals the bundled one, the unit is gone from the list, the other conflict is untouched, other pending updates were not applied, and the choice to keep it (if it was kept) is gone
- [ ] The backup of that transaction (backup folder, `setup/<run>/artifacts/skill-claude-tdd~SKILL.md`) holds your exact bytes; `z` restores them and the unit is a conflict again (not kept); if you edit the file again after take bundled, `z` leaves your edit and says so
- [ ] Use Riggverk's version is disabled with its reason on a retired skill and while another task runs; after keeping or handing back with a review open, `y` is refused as stale and `r` previews again
- [ ] Copy the bundled file over a kept file by hand, then run any Install: the choice for that file is gone (its next edit is a conflict, not silently kept)
- [ ] The Overview inspector lists the agent's decision and opens its page; `:resolve diff tdd` does what Compare does and `:resolve bundled tdd` opens the same review as **Use Riggverk's version…**

## 6. Rollback and uninstall

- [ ] After `y`, the run line shows **Undo last update…** and takes focus; `z` or the button (or `:rollback`) runs a dry run and a confirm, then restores the backed-up files; the History row then reads **Undone**
- [ ] `:rollback` with nothing to roll back says so
- [ ] Backups exist under `setup/<transaction id>/` with `manifest.json`, `artifacts/`, `managed-state.previous.json` (dirs 0700, files 0600); Library saves of personal docs under `docs/custom_<slug>-<timestamp>/`, of rules refinements under `docs/rules-<surface>-<timestamp>/`
- [ ] The Workspace folder cell lists the backup run count and the root path; **Backups folder** (`B`) opens the folder
- [ ] **preview uninstall** classifies removable, preserved, and merge-managed artifacts; modified and unknown fixture files stay on disk after uninstall
- [ ] Merge-managed rules files with user text outside the block are kept; a file with only an unedited block is removable
- [ ] **uninstall everything** removes proven app-owned files (old workspace copies the app still owns included); the data folder, its `.riggverk/` state, `docs/context/` and your own files stay
- [ ] **Recover previous uninstall** stays visible after the uninstall
- [ ] **preview recovery** is read-only and reports restore, already restored, and conflict counts
- [ ] **restore workspace** opens a confirmation; Escape closes it and focus returns to the button; cancel leaves the candidate unchanged; **confirm restore** brings workspace and harness state back and the card disappears
- [ ] A changed or occupied restore target reports a conflict and restore stays disabled
- [ ] No console errors during install, rollback, uninstall, and recovery

## 6b. Cleanup of old workspace copies

Run with a temporary `HOME` (never the real one), with `RIGGVERK_WORKSPACE_PATH` unset so the default folder is used (this seed puts the earlier release's folder in place; the first apply moves it to `$HOME/.config/riggverk`). The tag `v0.1.0-rc.1` must exist locally. Seed the data folder with what an earlier release installed, from the repository root:

```bash
export HOME="$(mktemp -d)"
unset RIGGVERK_WORKSPACE_PATH
export RIGGVERK_BACKUP_DIR="$HOME/backups"
mkdir -p "$HOME/seed" "$HOME/.config"
git archive v0.1.0-rc.1 resources/default-workspace | tar -x -C "$HOME/seed"
mv "$HOME/seed/resources/default-workspace" "$HOME/.config/agent-workspace"  # residue-allow: seeds the earlier release folder
cd "$HOME/.config/agent-workspace"  # residue-allow: seeds the earlier release folder
echo "my notes" > notes.txt                          # your own file
mkdir -p docs/context && echo "mine" > docs/context/mine.md   # a personal doc
echo "edited" >> README.md                           # an edited copy
find . -type f -print0 | sort -z | xargs -0 shasum > "$HOME/before.sha"
cd - >/dev/null
npm run tauri dev
```

- [ ] Launch changes nothing: the Workspace folder cell reads `N old copies to remove`, and the files in the data folder are unchanged (rerun the `find` above, with `-not -path './.riggverk/*'`, into `$HOME/launch.sha` and `diff` it against `before.sha`)
- [ ] **Update all** (or `:update workspace`) opens a review that lists the removals per top-level folder (for example `- skills/ (N old copies; backed up, z restores them)`) and `README.md` as left in place ("edited or not the app's: left in place"), with no conflict rows; `n` cancels and nothing changes
- [ ] `u` then `y`: the data folder holds only `.riggverk/`, `docs/context/mine.md`, `notes.txt` and the edited `README.md`; emptied folders are gone; `.riggverk/` and `docs/context/` are untouched; the Workspace folder cell shows `personal docs 1`, `ownership records present` and `left in place 1`
- [ ] `z` (dry run, then confirm): every file is back byte for byte (rerun the `find` with `-not -path './.riggverk/*'` into `$HOME/after.sha`; it equals `before.sha`) and the previous ownership records are restored; the cell reads `N old copies to remove` again
- [ ] `u` then `y` again: the cell reads Up to date and `u` is off (`already current`); `p` previews nothing to apply, and the edited `README.md` is still listed as left in place
- [ ] A symlink in place of a copy, and a copy below a symlinked folder, are listed as left in place and untouched; a folder where a copy was is left in place too
- [ ] **uninstall everything** on a freshly seeded profile removes the old copies the app still owns and keeps the data folder, `.riggverk/`, `docs/context/`, `notes.txt`; **Recover previous uninstall** is reachable
- [ ] A seeded folder saved as the custom folder (Settings state from an earlier version) stays configured after the cleanup

## 7. Codex 0.134+ migration

- [ ] `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` apply correctly with `codex_config` on
- [ ] `model` and `model_reasoning_effort` are never seeded; an existing value is never changed or reported as drift
- [ ] App-shaped legacy `profile = "safe"` / `"workspace-write"` selectors and `[profiles.*]` tables are removed while still app-shipped
- [ ] Custom profiles, unrelated keys, MCP entries, personality, comments, and same-line inline comments remain
- [ ] Ambiguous managed lines refuse safely with zero mutation
- [ ] With `CODEX_HOME` set, rules, agents, config, and skills land under it (nothing for Codex in `~/.agents/skills`)
- [ ] With the default `CODEX_HOME`, skills land in `~/.agents/skills`; the app's older copies in `~/.codex/skills` are removed by one reviewed update (`.system` stays), and an edited copy stays and is reported
- [ ] Disabling a harness in Settings changes the next preview only; the update removes the app's copies from a folder no enabled harness reads

## 7b. Claude attribution (`claude_config`)

Use a scratch profile or back up `~/.claude/settings.json` first.

- [ ] Claude page, the `config` cell is off (**Not managed**); its switch turns it on, and the review of a missing file says `+ ~/.claude/settings.json (new file; hides commit and PR attribution)`
- [ ] Install writes `attribution.commit` and `attribution.pr` as `""`; a commit made by Claude Code in a scratch repo has no `Co-Authored-By` trailer, and a PR it opens has no "Generated with Claude Code" line
- [ ] A file with `env`, `hooks` and `permissions` keeps all of them, in order, after Install; the row then reads current ("attribution hidden by Riggverk ...")
- [ ] `z` after the Install restores the file as it was (or removes it, if the Install created it)
- [ ] Custom `attribution.commit` text, `"attribution": false`, `includeCoAuthoredBy`, or both keys `""` that Riggverk did not write: the row says "you set attribution yourself" and the file is not changed
- [ ] A comment, a trailing comma or an unexpected `attribution` type is a conflict with a fixed reason and no file text; nothing is written
- [ ] With `CLAUDE_CONFIG_DIR` set when the app starts, the row is a conflict ("CLAUDE_CONFIG_DIR is set; Riggverk only edits ~/.claude/settings.json") and nothing is written
- [ ] Uninstall lists `~/.claude/settings.json` as left in place and does not delete it; Claude health shows nothing from the file

## 8. Settings, workspace folder, harness enablement

- [ ] Fresh and legacy settings enable Codex, OpenCode, Claude, and Cursor; GitHub Copilot, Pi, Kilo, Antigravity, and Grok are listed after them and disabled
- [ ] Enable Copilot, Pi, and Kilo: the Copilot, Pi and Kilo items appear in the sidebar after Claude (no digit); each page lists a `rules` row (target toggle on), the `skills` surface and an `mcp` row (toggle on for Copilot and Pi, **off** for Kilo), shows the CLI version (or "not on PATH" with its reason; an nvm-only install shows `· nvm`), the rules row, the `mcp playwright` row and the skills row; Kilo's review notes that `~/.claude/CLAUDE.md` stops being read; Install or Update then writes `~/.agents/skills`, the three rules files (`~/.copilot/copilot-instructions.md`, `~/.pi/agent/AGENTS.md` with owner-only folders, `~/.config/kilo/AGENTS.md`) and the Copilot and Pi MCP entries (`~/.copilot/mcp-config.json`, `~/.pi/agent/mcp.json`, both 0600 when new) and nothing else under `~/.copilot`, `~/.pi`, `~/.config/kilo`; with a Pi `AGENTS.override.md` or an `AGENTS.md`-less `CLAUDE.md` in `~/.pi/agent` the Pi rules row is a conflict and nothing is written; `:p` still previews and `:pi` opens the Pi page
- [ ] MCP entries of the light tier (isolated `HOME`; the CLIs are the maintainer's, the app runs none of these commands). Create: no file, Install writes a file holding only `playwright`. Merge: a file with another server (a fake token in its `env`), an unrelated top-level key and a different key order keeps all of it, with the entry appended; Rollback restores the file byte for byte, or after an edit elsewhere removes only the entry. Conflict: a file with a comment, a trailing comma or a byte order mark, an `mcpServers` that is an array, and a `playwright` entry of your own are each reported with a plain reason, nothing is written and no backup is made; the message shows no text of the file
- [ ] Kilo MCP (`kilo_mcp` off by default): switch the target on; with no config file Install creates `kilo.jsonc`; with a `kilo.jsonc` holding only `$schema` (what Kilo writes on first run) the entry is added and `$schema` stays first; with only a `kilo.json` that one is written and no `kilo.jsonc` appears; with both, `kilo.jsonc` is written. A `~/.kilo/kilo.jsonc` or an `opencode.json` in the config folder makes the Kilo page warn that it wins over the entry. With `XDG_CONFIG_HOME` set to an absolute folder outside `HOME` the files are there and `~/.config/kilo` is untouched
- [ ] Grok (enable it in Settings): the Grok item appears last in the sidebar (no digit); its page lists the `skills` surface and an `mcp` row with its toggle **off**, and no rules cell; the rules runtime row reads `shared` with `~/.claude/CLAUDE.md` while Claude Code and its rules are on, else `none`. Switch `grok_mcp` on: with no `~/.grok/config.toml` Install creates it (0600) holding only `[mcp_servers.playwright]`; with a config holding `api_key`, comments and another server only that table is added, and `diff` against a copy shows no other changed line; Rollback restores the file byte for byte. A config with CRLF line endings or an inline `mcp_servers = { ... }` is a conflict and stays untouched. With `GROK_HOME` set the page warns that `~/.grok/config.toml` is written anyway. Live check, maintainer-run: Grok lists the `playwright` MCP server
- [ ] Live check with the real CLIs, maintainer-run (not part of `release-check`): `copilot mcp get playwright` shows the entry with source User and the environment values masked; in VS Code the Copilot sessions list the server once. `pi mcp list` shows `playwright` connected with 22 tools and `exposure` `codemode`; add `"exposure": "direct"` to the entry by hand and the model sees the tools (the Pi page notes this). `kilo mcp list` shows `playwright`. In each, ask a session with a model to open a local page with the Playwright tool and confirm the system Chrome opens in a fresh profile, and that no `webmcp_*` tool is listed for a page that registers one (the Cursor and OpenCode entries pass the same `--browser chrome --isolated --no-webmcp` after `--config`; one launch from each settles that)
- [ ] With Codex enabled and `CODEX_HOME` customized, Copilot and Pi read `unserved` with the warning, nothing is installed for them, and Kilo is served through `~/.claude/skills`
- [ ] Appearance (dark, light, system), all four text sizes (`small`, `medium`, `large`, `extra-large`), and theme colors autosave; `r` in the appearance section resets after a confirm
- [ ] Motion `full` fades pages in, folds Compare out and shows apply progress (bar, file, elapsed); `subtle` keeps only short fades (nothing moves, no height animation); `off` (or the OS reduced-motion preference) stops every animation; there is no launch sequence and `:boot` does not exist
- [ ] Landing page selection (Overview, Library) persists and opens after app restart
- [ ] Settings has no folder chooser: no `choose…` action, no `c` hint, `c` does nothing, and `:workspace choose` is refused
- [ ] With a custom folder saved by an earlier version (seeded in an isolated profile; it holds `.riggverk/`), Settings shows it as `custom folder` and the app keeps using it across a restart, also after the old copies in it are removed (see 6b)
- [ ] `R` (and `:workspace reset`) on that folder opens a confirm that names the old folder and says its ownership records stay there; `n` or Escape changes nothing; `y` returns to the default path and status reloads; on the default folder `R` is disabled (`already the default workspace`)
- [ ] `RIGGVERK_WORKSPACE_PATH` overrides the saved path, and `R` is then refused with a reason
- [ ] Generator scripts run from the bundled copy: a modified `scripts/generate-opencode-config.py` in a saved custom workspace is not executed
- [ ] Turn a single agent off: its sidebar item, page, health calls, and agent-specific Library entries disappear, its Overview node stays but is dimmed (`off in Settings`, a dotted curve from the base only), and the other digits stay where they are
- [ ] Isolated harness files stay byte-identical after disable; restart preserves the disabled state and target selections
- [ ] Re-enable restores UI and health without installing
- [ ] Disable every harness: workspace, library, and settings stay usable
- [ ] A stale setup request for a disabled harness fails without mutation
- [ ] Full uninstall preview still includes proven artifacts of disabled harnesses
- [ ] All four text sizes usable at the minimum window size

## 9. Library

- [ ] Library shows a search field (top right), the topic tabs Rules, Skills, Agents, Docs, Configs (when on) and Packs, and the topic's items as grouped boxes of rows; `[` `]` (and `<` `>`) switch topic, `/` and `Mod+F` focus the search, the arrow keys move between rows, Enter opens one
- [ ] Opening a row drops a sheet over the Library (a dialog: focus moves in and stays, Tab does not leave it, Close, Escape and a click on the backdrop close it and focus returns to the row). A personal doc (`docs/context/`, tagged yours) opens as a textarea with **Unsaved changes** or **Saved**, Discard and Save `Mod+s`; **New doc** (the group button or `Mod+N`) asks for a title, shows `docs/context/<slug>.md` live and opens the new doc for editing
- [ ] Bundled items (bundled docs, Managed base, skills, agents, every config source) and pack skills open read-only: the reason line ("bundled with the app: read-only here") and the rendered text; no textarea opens; "Edit as my copy" appears only where the app can make a copy
- [ ] Docs: open, personal doc edit, unsaved state, save, discard, New doc, Markdown table, fenced code, code copy; bundled docs show their path inside the bundle (`docs/START_HERE.md`), and no "Bundled docs need update" banner exists
- [ ] Saving a personal doc over its existing file creates `docs/custom_<slug>-<timestamp>/` in the backup root; a symlinked doc or a linked `docs/context` folder is refused
- [ ] Quit guard: edit a personal doc in the Library sheet without saving, then press `Cmd+Q` (and, separately, click the red close button): the three-way dialog Unsaved changes appears (Save and quit, Discard, Keep editing); Keep editing leaves the app open, Discard and Save and quit end it; with nothing unsaved `Cmd+Q` quits at once. A settings change made within the last half second is saved before the app quits
- [ ] Library edits do not change what a harness install writes (installs come from the bundle)
- [ ] With a throwaway `HOME`, put an edited old copy in the data folder (for example `docs/START_HERE.md`): the Library still shows the bundled text
- [ ] Rules lists, under "Your rules files", one row per enabled harness (**Edit refinements**, or **Add refinements** with none) and, under "Base template", the Managed base; a disabled harness or rules target has no row; the Rules tab carries the filled square while a file needs a decision, and a conflict row says **Needs your decision** with **Open <harness> page ›**
- [ ] With a throwaway `HOME`: on a rules file with a block, the sheet has Refinements (the managed base dimmed and read-only above the textarea, a hint when a `## Heading` repeats one of the base), Effective (the whole file as it will read after saving) and Diff against disk ("No difference against disk." when equal); only the refinements are edited, and `Mod+s` saves; a hash of the file up to and including the END line is unchanged, `docs/rules-<surface>-<timestamp>/` holds the previous file (the sheet footer says **Backed up before saving**; a rules save writes at once, is not a setup transaction and has no Undo or History entry), and Install then reports the file current (or a base update) with the refinement count unchanged
- [ ] A rules file that is absent, has no block, has malformed markers, or is a symlink (or sits in a linked folder) is listed with its reason, read-only; a file whose managed block was edited by hand opens as a **Needs your decision** card (read-only, the file as on disk, a button to the harness page); **Open in editor** opens an existing one, also through a link
- [ ] Editing a rules file elsewhere after opening it: the save is refused as changed on disk, the file reloads with the draft kept, and a second save writes it
- [ ] With edits unsaved, switching topic, opening another item, closing the sheet and leaving through the sidebar each ask **Unsaved changes**: Discard, Keep editing, Save and continue (the save is the same backed-up save)
- [ ] No Tools icon or tool switcher exists

## 10. Known limitations

- The `.riggverk/workspace.json` marker is not created for new users and is never removed where an earlier release wrote it; the default workspace path is `~/.config/riggverk`
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
- [ ] Sidebar, top bar, fixed digits, Tab order and focus ring, help, command line, list keys passed
- Notes: ________

### Install review and target toggles
- [ ] Review, cancel, apply, conflicts, stale plan, toggles passed
- Notes: ________

### Rules (Compare, Merge in updates, Keep mine)
- [ ] Block create/update, conflict, compare, merge, keep-mine passed
- Notes: ________

### Skill and agent conflicts (Compare, Keep mine, Hand back, Use Riggverk's version)
- [ ] Conflict listing, compare, keep, hand back, take bundled and its rollback, blocked files passed
- Notes: ________

### Rollback and uninstall
- [ ] Rollback, backup layout, uninstall preview, recovery passed
- Notes: ________

### New screens
- [ ] Overview, agent pages with decisions and Compare, Use Riggverk defaults, History and Undo, Library packs, Settings passed
- Notes: ________

### Cleanup of old workspace copies
- [ ] Seeded rc.1 folder: review per folder, left-in-place file, apply, `z` restore, second preview empty passed
- Notes: ________

### Codex migration
- [ ] Managed fields, user-owned model, legacy profile cleanup passed
- Notes: ________

### Settings and workspace folder
- [ ] Appearance, motion levels, landing page, workspace folder reset, harness enablement passed
- Notes: ________

### Library
- [ ] Lists and document, personal doc save and backup, rules refinements save and backup, bundled items read-only passed
- Notes: ________

### Skipped checks and residual risk
- Skipped: ________
- Residual risk: ________

### Release Decision
- [ ] Ready to share
- [ ] Not ready
```
