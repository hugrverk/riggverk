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

- App starts.
- Agents opens by default.
- Agents verify checks rule targets only.
- Agents diff/sync rules still work against a valid selected workspace.
- Agents global rules template view still opens.
- Configs diff writes output to the Configs terminal.
- Configs sync button respects `opencode_config` enablement.
- Health release-check still works.
- Health backup history lists recent backup runs without reading file contents.
- Health backup history shows "no backups found" when no backups exist.
- Health selecting a backup run loads details: target id, filename, size, and current status.
- Health backup details do not display file contents or textual diffs.
- Health backup details do not include a restore button.
- Health refresh preserves selection when selected backup still exists.
- Health refresh clears selection when selected backup no longer exists.
- Health refresh updates the backup list.
- Health open backups opens the backup folder in Finder when it exists.
- Health does not create the backup folder just to show/open it.
- Backup creation remains script-owned during apply overwrite.
- Skills dry-run works for global target with a valid selected workspace.
- Skills project target without markers is rejected.
- Skills project target with `.git` marker is accepted.
- Docs list/read/open works.
- Settings save/reset works.
- Settings target profile buttons are visible.
- Applying Core profile selects codex_rules + opencode_rules + auggie_rules + opencode_config.
- Applying OpenCode profile selects opencode_rules + opencode_config only.
- Applying Extended profile selects all six targets.
- Applying Rules only profile selects codex_rules + opencode_rules + auggie_rules.
- Manual checkbox change shows "custom" profile state.
- Save persists the selected profile targets.
- Reset restores default (Core-equivalent) target selection.
- Invalid workspace path refuses script-backed actions.
- Health workspace panel shows valid workspace with all markers present.
- Health workspace panel shows rule/config target counts.
- Health workspace panel shows backup root exists/missing.
- Health workspace refresh updates diagnostics.
- Invalid workspace path in Settings shows invalid workspace and missing/error state in Health workspace panel.

## Remaining Limits

- Release check does not replace manual GUI smoke for view wiring, folder picker behavior, installed bundles, or native file-open behavior.
- The workspace marker directory `.ux-workspace/` and related env vars (`UX_WORKSPACE_PATH`, `UX_WORKSPACE_BACKUP_DIR`) remain part of the established workspace contract.
