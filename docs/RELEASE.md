# Release

Run the repository release check from the repository root:

```bash
./scripts/release-check.sh
```

It writes only ignored build artifacts in the repository and temporary directories. Apply smokes run against a temporary `HOME`, workspace, and backup root, so the real home is never touched. Order and contents change often; read the `step` lines in the script. In outline it runs:

- `git status --short` and `git diff --check`
- shell syntax checks
- README and docs drift (`check-readme-docs-drift.py`), the curated Library docs registry, and the default-workspace copy list
- generator currency: agent adapters, rule adapters, OpenCode config snapshot, pre-manifest ownership, rules history, shipped digests
- skill catalog and routing checks (`check-skill-routing.py`) and OpenCode permission composition and contract
- merge-script unit tests, the Codex merge secret-marker guard, and the pre-manifest upgrade smoke
- forbidden source scans (shell command strings, `eval`, removed skill flows) and managed-installation contract guards, including the single reviewed install owner
- frontend gate: `npm test` and `npm run build`
- Rust gate: `cargo fmt --check`, `cargo check`, `cargo clippy -D warnings`, `cargo test`
- the Tauri runtime smoke (`smoke-tauri-runtime.sh`)

It does not drive the Tauri webview, install into a real profile, or read `.env` files.

CI runs this POSIX check on Ubuntu and macOS. Windows CI runs frontend, build, and Rust format, check, Clippy, and tests, which cover native app path logic. The Bash release check is macOS and Linux only (WSL behaves as Linux); use the app on Windows.

## Backend runtime smoke

```bash
./scripts/smoke-tauri-runtime.sh
```

Isolated temp `HOME` and workspace path; exercises the Rust command handlers the app calls (status, diagnostics, OpenCode and Cursor health). `release-check.sh` already runs it. It does not automate the webview.

## Browser-only checks

`npm run dev` then `http://localhost:1420/?mock=<scenario>` renders the UI against `src/dev/mockBackend.ts` (scenarios `default`, `conflict`, `fresh`, `error`, `empty`). Use it for layout and keyboard checks. It has no Tauri backend, so it cannot prove filesystem behavior.

## Manual GUI smoke

Before sharing a build, run [APP_RELEASE_SMOKE.md](./APP_RELEASE_SMOKE.md) in the real Tauri app with an isolated `HOME`, `AGENT_WORKSPACE_PATH`, and `AGENT_WORKSPACE_BACKUP_DIR`. It covers, in order of risk:

- Install review: `u`, plan table, `n` cancels with nothing written, `y` applies, target toggles gate the plan.
- Conflicts and rules: Convert, Leave as is, diff.
- Rollback (`z`) and uninstall with recovery.
- Workspace picker in Settings.
- Keyboard layer, tab order, help overlay, command line.
- Library panes.

Tab order is workspace, codex, opencode, cursor, claude, library, settings.

## Installing a local build

The app bundle is `Riggverk.app` (executable `riggverk`, identifier `se.hugrverk.riggverk`). Earlier builds were named `Agent Workspace.app` with a different identifier, so installing Riggverk is not an in-place overwrite: macOS treats it as a separate app. Both read and write the same settings, backups, and workspace, and nothing stops them from running at the same time, so never leave both installed.

1. Quit the old app (`Agent Workspace`) if it is running.
2. Build: `npm run tauri build` (`npm run tauri build -- --bundles app` skips the disk image).
3. Install: `ditto "src-tauri/target/release/bundle/macos/Riggverk.app" /Applications/Riggverk.app`.
4. Launch Riggverk. Check that the Workspace page and Settings still show your workspace and settings.
5. Move `/Applications/Agent Workspace.app` to the Trash, then re-pin the Dock item.

The old `Agent Workspace.app` that an earlier build left in `src-tauri/target/release/bundle/macos` is harmless, but `scripts/release-size-report.sh` lists it. Delete it or run `cargo clean`.

Nothing moves with the rename. The app support directory (`ai.agentworkspace.app`, holding `settings.json`, the OpenCode model override, and `backups/`) keeps its name on purpose and is not derived from the bundle identifier; see the paths in [SECURITY_MODEL.md](./SECURITY_MODEL.md). The workspace stays at `~/.config/agent-workspace`. The bundle is ad-hoc signed and not notarized, so Gatekeeper and any folder-access prompts apply as for any local build.

Name manual zips `Riggverk-v<version>-<channel>-macOS.zip`. Release notes for testers who still have the old app must say: quit `Agent Workspace`, move it to the Trash, then install `Riggverk.app`.

## Remaining limits

- The release check does not replace webview smoke for view wiring, install behavior in an installed bundle, or native open and folder-picker behavior.
- Native UI automation is not wired; Vite-only browser tools lack `invoke`.
- `AGENT_WORKSPACE_PATH` and `AGENT_WORKSPACE_BACKUP_DIR` stay part of the established workspace contract and are honored in release builds.
