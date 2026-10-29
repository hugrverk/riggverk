# Release

Run the repository release check from the repository root:

```bash
./scripts/release-check.sh
```

It writes only ignored build artifacts in the repository and temporary directories. Apply smokes run against a temporary `HOME`, workspace, and backup root, so the real home is never touched. Each step names the script that owns its checks; [MAINTAINING.md](./MAINTAINING.md) ("Where guards live") says what each one protects and how to run it alone. In outline it runs:

- `git status --short` and `git diff --check`, the toolchain, and `bash -n` on every tracked shell script
- generated files are current (`python3 scripts/generate.py check`): agent adapters, rule adapters, OpenCode config snapshot, bundled what's new, pre-manifest ownership, rules history, shipped digests
- every `scripts/test_*.py`, including the Codex merge secret-marker test, and the app version check
- README and docs drift, skill catalog and routing, the frozen workspace copy list and the curated Library docs registry
- bundle content (`check-bundle-content.py`), the Cursor profile, the bundled merge-script tests, the OpenCode permission contract, harness ids, the managed-installation contract and Rust shell spawns
- source scans (`check-source.py`): product identity, Tauri config, startup order, forbidden patterns (shell command strings, `eval`, remote skill installs) and UI rules
- frontend: `npm run typecheck`, `npm test` and `npm run build`
- Rust: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`
- the pre-manifest upgrade smoke and the Tauri runtime smoke (`smoke-tauri-runtime.sh`)

It does not drive the Tauri webview, install into a real profile, or read `.env` files.

This local check is the gate: run it before merging and before a release. GitHub Actions is disabled for this repository (`.github/workflows` is kept, switched off), so nothing runs on push or pull request, and nothing verifies Windows. Windows checks exist in `windows-checks.yml` and are disabled. The Bash release check is macOS and Linux only (WSL behaves as Linux); use the app on Windows.

## Cutting a release

Releases are local: the flow does not use GitHub Actions. A release is a zip on GitHub Releases, built, ad hoc signed and uploaded from the owner's Mac by two commands.

Versions are CalVer `YYYY.M.N`, which is valid semver: the year, the month without a leading zero, and a counter inside that month that starts at 1 (`2026.10.1`, `2026.10.2`, `2026.11.1`). Tags are `v<version>`. Other tags (`app-v0.1.0`, `v0.1.0-rc.1`) are ignored. The next version is computed from the tags and today's date, so the counter restarts when the month changes.

Needs: a Mac (`codesign`, `ditto`), `python3` 3.11 or newer first on `PATH` (`scripts/release.sh` stops with a message otherwise), `gh` logged in, Rust, and `npm ci` done.

### 1. Prepare

From a clean `main` that equals `origin/main`:

```bash
./scripts/release.sh prepare --dry-run   # prints the version, the notes draft and every step; changes nothing
./scripts/release.sh prepare
```

`prepare` computes the next version and drafts `release-notes/<version>.md`. It bumps the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, refreshes both lock files (`cargo check`, `npm install --package-lock-only`; it stops if they change anything but the app version), regenerates `src/generated/release-notes.json`, runs the full `scripts/release-check.sh`, commits `chore(release): <version>` on `release/v<version>`, pushes it and opens a pull request. If anything fails before the commit it undoes its local changes and returns to `main`. A dry run still runs `git fetch` and read-only `gh` and `git ls-remote` lookups.

The first release has no CalVer tag to start from, so the draft lists every merged pull request. Use `--since REV` (for example `--since app-v0.1.0`) to start later, and trim by hand.

### 2. Edit the notes

The draft is the pull request titles that were merged into `main` since the previous release tag. Merge commits (`Merge pull request #N ...`) and squash commits that end in `(#N)` are read; direct pushes and rebase merges are not, so add those by hand.

- `feat` goes under **New**, `fix` under **Fixes**, every other type and every title without a type under **Other**. The `type(scope):` prefix is removed, the first letter is capitalised, and `(#N)` is kept for the GitHub page. The release pull request itself is skipped.
- **Other** starts with a comment saying so: delete the section to keep chores, refactors and docs out of the notes.
- **Install** is the Gatekeeper hint for the GitHub release page only. The app leaves it out. Keep it in every release.
- Edit freely, then regenerate the data the app bundles and push:

  ```bash
  python3 scripts/generate.py write --only release-notes
  git add release-notes src/generated/release-notes.json && git commit -m "docs(release): edit the notes" && git push
  ```

  `release-check.sh` fails with `python3 scripts/generate.py write` in the message when the bundled file is stale.

The same file is the GitHub release body and the app's "what's new". The app shows the notes since the version a user last saw once, on the first launch after an update (the overlay of `?`: Escape closes it, `j`/`k` scroll), and `:whatsnew` opens all of them at any time. A fresh install records its version and shows nothing. An install that predates `last_seen_version` also counts as fresh once, so the first update that carries the field shows nothing; every one after it does.

### 3. Publish

Merge the pull request, then on `main` (pulled, nothing else merged in between):

```bash
./scripts/release.sh publish --dry-run
./scripts/release.sh publish
```

`publish` checks that the version files agree, that it is newer than the latest release, that `release-notes/<version>.md` exists and the bundled notes match it, that neither the tag nor the GitHub release exists, and that `main` ends with the release pull request (`--allow-newer` skips that last check; use it only when you know the notes cover what was merged since). Then it builds with `npm run tauri build -- --bundles app`, checks the bundle reports the version, ad hoc signs it (`codesign --force --deep --sign -`) and verifies the signature, zips it with `ditto -c -k --keepParent` as `release/Riggverk-v<version>-macOS.zip` (checking that the signature survives the zip), creates the annotated tag `v<version>`, pushes it and runs `gh release create v<version> <zip> --notes-file release-notes/<version>.md`. The zip is the only upload. It prints the release URL. It does not rerun `release-check.sh`; `prepare` did.

The app is not notarized (there is no Apple Developer ID yet). On first launch macOS says it cannot verify the app: open System Settings, Privacy & Security, and choose Open Anyway. The **Install** section of every release says so.

### Rollback

If a publish went wrong, delete the release and its tag, then publish again (the version in `main` is already bumped, so nothing else changes):

```bash
gh release delete v<version> --cleanup-tag --yes   # the GitHub release and the remote tag
git tag -d v<version>                              # the local tag
./scripts/release.sh publish
```

A failure after the tag was created prints these commands. A typo in the notes of a published release needs no rollback: `gh release edit v<version> --notes-file release-notes/<version>.md`. If the build itself is wrong, fix it in a pull request and publish with `--allow-newer`, or prepare the next version.

## Backend runtime smoke

```bash
./scripts/smoke-tauri-runtime.sh
```

Isolated temp `HOME` and workspace path; exercises the Rust command handlers the app calls (status, diagnostics, OpenCode and Cursor health). `release-check.sh` already runs it. It does not automate the webview.

## Browser-only checks

`npm run dev` then `http://localhost:1420/?mock=<scenario>` renders the UI against `src/dev/mockBackend.ts` (scenarios `default`, `conflict`, `fresh`, `error`, `empty`). Use it for layout and keyboard checks. It has no Tauri backend, so it cannot prove filesystem behavior.

## Manual GUI smoke

Before sharing a build, run [APP_RELEASE_SMOKE.md](./APP_RELEASE_SMOKE.md) in the real Tauri app with an isolated `HOME`, `RIGGVERK_WORKSPACE_PATH`, and `RIGGVERK_BACKUP_DIR`. It covers, in order of risk:

- Install review: `u`, plan table, `n` cancels with nothing written, `y` applies, target switches gate the plan.
- Decisions: Compare, Merge in updates, Keep mine, Use Riggverk's version and defaults.
- Undo (`z`), History and uninstall with recovery.
- Overview, agent pages, Library and Settings on both themes.
- Keyboard layer, fixed digits, Tab order and focus ring, help overlay, command line.

Sidebar order is Overview, the enabled agents, History, Library, Settings; the digits are `1`, `2`-`5`, `6`, `7`, `8`.

## Installing a local build

The app bundle is `Riggverk.app` (executable `riggverk`, identifier `se.hugrverk.riggverk`). Earlier builds were named `Agent Workspace.app` with a different identifier, so installing Riggverk is not an in-place overwrite: macOS treats it as a separate app. Nothing stops both from running at the same time, so never leave both installed, and quit the old one before the first launch of Riggverk (it moves the app data, see [App data move](#app-data-move)).

1. Quit the old app (`Agent Workspace`) if it is running.
2. Build: `npm run tauri build` (`npm run tauri build -- --bundles app` skips the disk image).
3. Install: `ditto "src-tauri/target/release/bundle/macos/Riggverk.app" /Applications/Riggverk.app`.
4. Launch Riggverk. Check that the Workspace page and Settings still show your workspace and settings.
5. Move `/Applications/Agent Workspace.app` to the Trash, then re-pin the Dock item.

The old `Agent Workspace.app` that an earlier build left in `src-tauri/target/release/bundle/macos` is harmless, but `scripts/release-size-report.sh` lists it. Delete it or run `cargo clean`.

The data folder `~/.config/agent-workspace` is read in place and renamed to `~/.config/riggverk` by the first write (see "Upgrading from earlier versions" in the README); to undo that by hand, quit the app and rename it back, and the `.riggverk/` state folder inside it to `.agent-workspace/`. Going back to an older build after the move is not supported: it would find no folder under the old name and start as a fresh profile, and it does not recognise rules blocks rewritten with `RIGGVERK BASE` markers (restore those files from `backups/setup/<transaction id>/`). Quit any older Riggverk before the first launch of the new build, and update tools, editors and scripts that mention `~/.config/agent-workspace`. The bundle is ad-hoc signed and not notarized, so Gatekeeper and any folder-access prompts apply as for any local build.

Releases are built and zipped by `scripts/release.sh publish` (see [Cutting a release](#cutting-a-release)); name any other manual zip `Riggverk-v<version>-<channel>-macOS.zip`. Release notes for testers who still have the old app must say: quit `Agent Workspace` first, then install and launch `Riggverk.app` (it moves your settings and backups on first launch), then move the old app to the Trash.

## App data move

The first launch of a build with the move renames the app data directory (`settings.json`, the OpenCode model override, `backups/`) from `ai.agentworkspace.app` to `se.hugrverk.riggverk`, next to it: `~/Library/Application Support` on macOS, `${XDG_CONFIG_HOME:-~/.config}` on Linux, `%APPDATA%` on Windows. It is one atomic rename of the whole directory, so contents, modes, and modification times (which order the backup list) are unchanged, and no second copy of an in-flight setup transaction exists. The app adds `.migrated-from.json` (old and new path, app version, time) to it. Nothing is deleted.

- It runs on every launch that runs the app's setup, including `npm run tauri dev`. Do not start a development build with your real home until you are ready for the real data to move.
- Quit the old `Agent Workspace` first. An old app that writes during the move can leave a partial old directory, and afterwards it starts from defaults in a new old-named directory that Riggverk ignores.
- If `se.hugrverk.riggverk` already exists it wins and the old directory is left untouched; the two are never merged. An empty one is replaced.
- An old path that is a symlink or not a directory is not moved or followed. Settings shows a warning once.
- If the move fails, the app stops at startup with an error naming both paths and the old directory stays in place. Fix the cause (another running copy, permissions) and start the app again.

To keep a copy before the first launch (macOS): `ditto "$HOME/Library/Application Support/ai.agentworkspace.app" "$HOME/riggverk-appdata-copy"`.

To undo the move, quit Riggverk and rename the directory back, then use the old app:

```sh
# macOS
mv "$HOME/Library/Application Support/se.hugrverk.riggverk" "$HOME/Library/Application Support/ai.agentworkspace.app"
# Linux
mv "${XDG_CONFIG_HOME:-$HOME/.config}/se.hugrverk.riggverk" "${XDG_CONFIG_HOME:-$HOME/.config}/ai.agentworkspace.app"
# Windows (PowerShell)
Move-Item "$env:APPDATA\se.hugrverk.riggverk" "$env:APPDATA\ai.agentworkspace.app"
```

Launching Riggverk again moves it forward again, replacing the leftover `.migrated-from.json`.

## Remaining limits

- The release check does not replace webview smoke for view wiring, install behavior in an installed bundle, or native open and folder-picker behavior.
- Native UI automation is not wired; Vite-only browser tools lack `invoke`.
- `RIGGVERK_WORKSPACE_PATH` and `RIGGVERK_BACKUP_DIR` are part of the established workspace contract and are honored in release builds; the earlier names `AGENT_WORKSPACE_PATH` and `AGENT_WORKSPACE_BACKUP_DIR` still work as aliases.
