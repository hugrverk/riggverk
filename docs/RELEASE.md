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

## Backend runtime smoke (optional)

```bash
./scripts/smoke-tauri-runtime.sh
```

Isolated temp `HOME` and workspace path; exercises the same Rust command handlers the app uses (`get_status`, diagnostics, OpenCode/Cursor health, Brain Setup). Not part of `release-check.sh` (extra install steps). Does not automate the Tauri webview.

## Manual GUI Smoke

For installed-app release smoke (managed installation, bundled defaults, build/install), see [APP_RELEASE_SMOKE.md](./APP_RELEASE_SMOKE.md).

After code changes that affect the app, manually check:

- App starts and opens the Workspace view.
- Workspace diagnostics show install state for `~/.config/agent-workspace`.
- Each normal screen shows one managed installation card; no path chooser or parallel repair UI exists.
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
- Settings save/reset works for appearance and theme colors; target changes from harness pages autosave (debounced).
- Harness Targets panels show target toggles per tool with enable/disable checkboxes.
- Toggling a target includes or excludes that managed projection from the unified installation plan.
- Agent targets are enabled independently per tool.
- Manual checkbox changes show custom target selection.
- Save persists selected targets; Reset restores defaults.
- Invalid workspace paths refuse script-backed actions.

## Remaining Limits

- Release check does not replace real Tauri webview smoke for view wiring, managed installation behavior, installed bundles, or native file-open behavior.
- `smoke-tauri-runtime.sh` does not drive the Tauri webview; native UI automation is not wired (Vite-only browser tools lack `invoke`).
- The workspace marker directory `.agent-workspace/` and related env vars (`AGENT_WORKSPACE_PATH`, `AGENT_WORKSPACE_BACKUP_DIR`) remain part of the established workspace contract.
