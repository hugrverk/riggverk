# Workflows

Key reference: [USING_THE_APP.md](USING_THE_APP.md#keyboard-reference). Every install below follows the same shape: `u` (or `:update <target>`), read the plan, `y` to apply, `n` to cancel.

## Install everything

1. Workspace tab (`1`), cursor on `workspace`, `u`, `y`.
2. Each harness tab, `u`, `y`. Or `:update --all` once for the workspace and every enabled harness in one plan.
3. Check the runtime pane on each harness page.

## Set up one harness only

Open its tab and press `u`. To hide the others, turn them off in Settings (Harnesses). Hidden harnesses are not written.

## Look before you write

`p` or `:preview <target>` shows the plan with no way to apply. Use it on a machine where you have hand-edited tool config. Conflict rows are files the app will skip.

## Choose what Install writes

On a harness page, Space toggles targets (rules, agents, config; Cursor is one `cursor_setup` target). Changes autosave. A target that is off is excluded from preview, apply, and status. Skills and the workspace bundle always install.

`codex_config` starts off. Turn it on only if you want the app to keep `approval_policy`, `sandbox_mode`, `approvals_reviewer`, and the app default approval keys aligned with the template.

## Add your own rules without losing updates

1. Install once so the rules file has the managed block.
2. Open the file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.config/opencode/AGENTS.md`) and add your text below `<!-- END AGENT-WORKSPACE BASE -->`.
3. Later updates replace only the block; your text stays and overrides the base where it conflicts.

Do not edit inside the block. See [AGENT_RULES.md](AGENT_RULES.md).

## Resolve a rules conflict

A rules file is a conflict when its block was edited or it existed before the app without markers. On the harness page, use the rules row:

1. `d` shows what would change.
2. `v` (Convert) writes the current base as the block and moves the sections you changed below the END marker. The preview shows the whole resulting file; confirm to apply. A full backup is taken first.
3. `m` (Leave as is) keeps the file untouched and records the choice. The file then reports "base updates available, you manage this file" and is never written until you convert it.

`:rules` does the same from the command line. Malformed markers (duplicate, unpaired, reordered) are never rewritten; fix them by hand.

## Take an update to a file you edited

The app never overwrites a file it does not provably own. To accept the bundled version of a workspace file you changed, move or delete your copy and install again. To keep your version, leave it; it shows as a conflict and is skipped.

## Undo the last install

On the output pane press `z` (or `:rollback`). The app does a dry run, shows what would be restored, and asks to confirm. This covers the last install or uninstall of the current session. Older changes: copy the file out of `<backup root>/setup/<transaction id>/artifacts/` ([USING_THE_APP.md](USING_THE_APP.md#backups)).

## Codex config

1. Codex tab, turn `codex_config` on (Space).
2. `p` to see which keys differ, then `u`, `y`.
3. The app keeps `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `apps._default.*` aligned with the template. `model` and `model_reasoning_effort` are written once, only when your config has none (default `gpt-6.1-sol`, `xhigh`), then stay yours. Personality, MCP entries, other tables, and comments are preserved; ambiguous TOML is refused with nothing written.
4. If Codex ignores your rules, check for a non-empty `AGENTS.override.md` in the Codex home; Codex reads it instead of `AGENTS.md`. The Codex runtime pane warns about it.

## Add a skill of your own

Skills you add to the runtime workspace are not installed; harness installs come from the app's bundled catalog. Put a personal skill straight into a skills folder your harness reads (`~/.claude/skills/<name>/SKILL.md` or `~/.agents/skills/<name>/SKILL.md`). Unknown skills there are preserved. To change the bundled catalog, edit the app source repository.

## Move the workspace

Settings -> workspace: `c` chooses another folder (it must pass the workspace markers), `R` resets to `~/.config/agent-workspace`. Install into the new location with `u` on the Workspace page. `AGENT_WORKSPACE_PATH` overrides the setting.

## Version the workspace with Git

See [GIT_VERSIONING.md](GIT_VERSIONING.md). The app does not run Git against the workspace.
