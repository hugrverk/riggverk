# Workflows

Key reference: [USING_THE_APP.md](USING_THE_APP.md#keyboard-reference). Every install below follows the same shape: **Update** (`u`, or `:update <target>`), read the plan, **Apply** (`y`) to apply, **Cancel** (`n`) to cancel.

## Install everything

1. **Update all** in the top bar, then **Apply**. Or each agent page, `u`, `y`. `:update --all` does the same as the button (it also reviews the removal of old workspace copies when there are any).
2. Check the Runtime cell on each agent page.

## Set up one harness only

Open its page from the sidebar and press `u`. To hide the others, turn them off in Settings (Agents). Hidden agents are not written.

## Look before you write

`p` or `:preview <target>` shows the plan with no way to apply. Use it on a machine where you have hand-edited tool config. Conflict rows are files the app will skip.

## Choose what Install writes

On an agent page, the switch "Let Riggverk manage this" turns a target on or off (rules, agents, config; Cursor is one `cursor_setup` target). Changes autosave. A target that is off is excluded from preview, apply, and status. Skills and the workspace folder are never gated by targets.

`codex_config` starts off. Turn it on only if you want the app to keep `approval_policy`, `sandbox_mode`, `approvals_reviewer`, and the app default approval keys aligned with the template.

## Add your own rules without losing updates

1. Install once so the rules file has the managed block.
2. Open the file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.config/opencode/AGENTS.md`) and add your text below `<!-- END RIGGVERK BASE -->`.
3. Later updates replace only the block; your text stays and overrides the base where it conflicts.

Do not edit inside the block. See [AGENT_RULES.md](AGENT_RULES.md).

## Resolve a rules conflict

A rules file is a decision when its block was edited or it existed before the app without markers. On the agent page, the rules card offers:

1. **Compare** (`d`) folds out a read-only diff under the card: your file against the closest shipped version. Nothing is written.
2. **Merge in updates…** (`v`) writes the current base as the block and moves the sections you changed below the END marker. The review shows the whole resulting file; **Apply** (`y`) writes it. A full backup is taken first.
3. **Keep mine** (`m`) asks first, then keeps the file untouched and records the choice. The card then says you manage the file, and it is never written until you hand it back (**Hand back**) or merge.

`:rules` does the same from the command line. Malformed markers (duplicate, unpaired, reordered) are never rewritten; fix them by hand.

## Take an update to a file you edited

The app never overwrites a file it does not provably own. For a skill or agent file you changed, the agent page shows a card with **Compare**, **Use Riggverk's version…** (a review, your file is backed up first) and **Keep mine**. For any other file, move or delete your copy and install again. To keep your version, leave it; it shows as a conflict and is skipped.

## Remove old workspace copies

Earlier releases copied the bundle into the data folder. The app no longer reads those files.

1. Overview (`1`). The Workspace folder cell says `N old copies to remove` (a fresh profile says **Up to date**).
2. **Update all** (`u`, or `:update workspace`). The review lists the removals per folder and each file left in place (edited, or not provably the app's).
3. `y` removes the copies in one transaction with backups. `n` or Escape keeps everything; `z` afterwards restores every file.

Your own files, `.riggverk/` and `docs/context/` are never touched.

## Undo the last install

Press `z` or click **Undo last update…** in the line under the page (or `:rollback`). The app does a dry run, shows what would be restored, and asks to confirm. This covers the last install or uninstall of the current session. After a restart, History offers **Undo this update…** on the newest completed update. Older changes: copy the file out of `<backup root>/setup/<transaction id>/artifacts/` ([USING_THE_APP.md](USING_THE_APP.md#backups)).

## Codex config

1. Codex page, turn `codex_config` on with its switch.
2. `p` to see which keys differ, then `u`, `y`. A key you changed by hand shows as a decision: **Keep mine**, or **Use Riggverk defaults** (a review of the exact key changes first).
3. The app keeps `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` aligned with the template. `model` and `model_reasoning_effort` are written once, only when your config has none (default `gpt-6.1-sol`, `xhigh`), then stay yours. Personality, MCP entries, other tables, and comments are preserved; ambiguous TOML is refused with nothing written.
4. If Codex ignores your rules, check for a non-empty `AGENTS.override.md` in the Codex home; Codex reads it instead of `AGENTS.md`. The Codex page warns about it.

## Add a skill of your own

Skills you add to the workspace folder are not installed; harness installs come from the app's bundled catalog. Put a personal skill straight into a skills folder your harness reads (`~/.claude/skills/<name>/SKILL.md` or `~/.agents/skills/<name>/SKILL.md`). Unknown skills there are preserved. To change the bundled catalog, edit the app source repository.

## The workspace folder

The app keeps its state and your personal docs in `~/.config/riggverk`; Settings no longer picks another folder. A custom folder saved by an earlier version stays in use while it holds the app's `.riggverk/` state. Settings -> workspace: `R` asks first, then returns to the default folder (the old folder and its ownership records are left as they are, and the app cannot switch back to it). `RIGGVERK_WORKSPACE_PATH` overrides the setting.

## Version the workspace with Git

Version only your personal docs (`docs/context/`); see [GIT_VERSIONING.md](GIT_VERSIONING.md). The app does not run Git against the workspace.
