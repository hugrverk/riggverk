# Release

Run the app repository release check from the repository root:

```bash
./scripts/release-check.sh
```

The script is read-only except for normal ignored build artifacts created by frontend and Cargo checks. It runs:

- `git status --short`
- `git diff --check`
- shell syntax checks for the bundled default workspace scripts
- bundled default workspace marker, template JSON, Tauri resource, skill structure, baseline skill, and public-boundary checks
- forbidden operational source scans for shell execution and deprecated skill paths/package flows in scripts and app source
- app `npm run build`
- app `cargo fmt --check`, `cargo check`, `cargo clippy -- -D warnings`, and `cargo test`

It does not run apply commands, install skills, create backups, write user config folders, inspect `.env` files, or manage `.agents/skills`.

## Manual GUI Smoke

For installed-app release smoke (create workspace, folder picker, bundled defaults, build/install), see [APP_RELEASE_SMOKE.md](./APP_RELEASE_SMOKE.md).

After code changes that affect the app, manually check:

- App starts and opens the Workspace view.
- Workspace diagnostics show valid and invalid workspace paths correctly.
- Workspace create flow requires dry-run first, copies starter files only, and rejects unsafe targets.
- Pull runs `git pull --ff-only` only inside a Git workspace.
- Diff/sync rules respect saved enabled rule targets.
- Diff/sync configs respect saved enabled config targets.
- Skills dry-run works for global targets with a valid selected workspace.
- Skills project target without markers is rejected.
- Skills project target with `.git` marker is accepted.
- Backups list recent backup runs without reading file contents.
- Backup details show target id, filename, size, and current status only.
- Backup details do not display file contents, textual diffs, or a restore button.
- Refresh preserves selection when the selected backup still exists and clears it when it does not.
- Open backups creates the app-level backup root when needed and opens it in Finder, independent of workspace validity.
- Backup creation remains script-owned during apply overwrite.
- Library docs list/read/open/edit works.
- Library rules, agents, and configs edit/save only workspace source files.
- Brain Setup displays the copy-paste setup block and does not change enabled sync targets.
- Copy brain setup writes the full setup block to the clipboard.
- Settings save/reset works.
- Settings target profile buttons are visible.
- Applying OpenCode selects `opencode_rules` + `opencode_config`.
- Applying All rules selects `codex_rules`, `opencode_rules`, `auggie_rules`, `claude_rules`, and `gemini_rules`.
- Applying All supported selects all rule targets plus `opencode_config`.
- Manual checkbox changes show custom target selection.
- Save persists selected targets; Reset restores defaults.
- Invalid workspace paths refuse script-backed actions.

## Remaining Limits

- Release check does not replace manual GUI smoke for view wiring, folder picker behavior, installed bundles, or native file-open behavior.
- The workspace marker directory `.agent-workspace/` and related env vars (`AGENT_WORKSPACE_PATH`, `AGENT_WORKSPACE_BACKUP_DIR`) remain part of the established workspace contract.
