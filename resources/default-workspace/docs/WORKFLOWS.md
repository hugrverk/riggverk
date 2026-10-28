# Workflows

Key reference: [USING_THE_APP.md](USING_THE_APP.md#keyboard-reference). Every install below follows the same shape: `u` (or `:update <target>`), read the plan, `y` to apply, `n` to cancel.

## Install everything

1. Each harness tab, `u`, `y`. Or `:update --all` once for every enabled harness in one plan (it also reviews the removal of old workspace copies when there are any).
2. Check the runtime pane on each harness page.

## Set up one harness only

Open its tab and press `u`. To hide the others, turn them off in Settings (Harnesses). Hidden harnesses are not written.

## Look before you write

`p` or `:preview <target>` shows the plan with no way to apply. Use it on a machine where you have hand-edited tool config. Conflict rows are files the app will skip.

## Choose what Install writes

On a harness page, Space toggles targets (rules, agents, config; Cursor is one `cursor_setup` target). Changes autosave. A target that is off is excluded from preview, apply, and status. Skills and the `workspace` row are never gated by targets.

`codex_config` starts off. Turn it on only if you want the app to keep `approval_policy`, `sandbox_mode`, `approvals_reviewer`, and the app default approval keys aligned with the template.

## Add your own rules without losing updates

1. Install once so the rules file has the managed block.
2. Open the file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.config/opencode/AGENTS.md`) and add your text below `<!-- END RIGGVERK BASE -->`.
3. Later updates replace only the block; your text stays and overrides the base where it conflicts.

Do not edit inside the block. See [AGENT_RULES.md](AGENT_RULES.md).

## Resolve a rules conflict

A rules file is a conflict when its block was edited or it existed before the app without markers. On the harness page, use the rules row:

1. `d` shows what would change.
2. `v` (Convert) writes the current base as the block and moves the sections you changed below the END marker. The preview shows the whole resulting file; confirm to apply. A full backup is taken first.
3. `m` (Leave as is) keeps the file untouched and records the choice. The file then reports "base updates available, you manage this file" and is never written until you convert it.

`:rules` does the same from the command line. Malformed markers (duplicate, unpaired, reordered) are never rewritten; fix them by hand.

## Take an update to a file you edited

The app never overwrites a file it does not provably own. To accept the bundled version of a harness file you changed, move or delete your copy and install again. To keep your version, leave it; it shows as a conflict and is skipped.

## Remove old workspace copies

Earlier releases copied the bundle into the data folder. The app no longer reads those files.

1. Workspace tab (`1`). The `workspace` row says `N old copies to remove` (a fresh profile says `current`).
2. `u` on the row. The review lists the removals per folder and each file left in place (edited, or not provably the app's).
3. `y` removes the copies in one transaction with backups. `n` or Escape keeps everything; `z` afterwards restores every file.

Your own files, `.riggverk/` and `docs/context/` are never touched.

## Undo the last install

On the output pane press `z` (or `:rollback`). The app does a dry run, shows what would be restored, and asks to confirm. This covers the last install or uninstall of the current session. Older changes: copy the file out of `<backup root>/setup/<transaction id>/artifacts/` ([USING_THE_APP.md](USING_THE_APP.md#backups)).

## Codex config

1. Codex tab, turn `codex_config` on (Space).
2. `p` to see which keys differ, then `u`, `y`.
3. The app keeps `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` aligned with the template. `model` and `model_reasoning_effort` are written once, only when your config has none (default `gpt-6.1-sol`, `xhigh`), then stay yours. Personality, MCP entries, other tables, and comments are preserved; ambiguous TOML is refused with nothing written.
4. If Codex ignores your rules, check for a non-empty `AGENTS.override.md` in the Codex home; Codex reads it instead of `AGENTS.md`. The Codex runtime pane warns about it.

## Add a skill of your own

Skills you add to the workspace folder are not installed; harness installs come from the app's bundled catalog. Put a personal skill straight into a skills folder your harness reads (`~/.claude/skills/<name>/SKILL.md` or `~/.agents/skills/<name>/SKILL.md`). Unknown skills there are preserved. To change the bundled catalog, edit the app source repository.

## The workspace folder

The app keeps its state and your personal docs in `~/.config/riggverk`; Settings no longer picks another folder. A custom folder saved by an earlier version stays in use while it holds the app's `.riggverk/` state. Settings -> workspace: `R` asks first, then returns to the default folder (the old folder and its ownership records are left as they are, and the app cannot switch back to it). `RIGGVERK_WORKSPACE_PATH` overrides the setting.

## Version the workspace with Git

Version only your personal docs (`docs/context/`); see [GIT_VERSIONING.md](GIT_VERSIONING.md). The app does not run Git against the workspace.
