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

Releases are local: the flow does not use GitHub Actions. A release is a disk image, a zip of the same app and a `SHA256SUMS` file on GitHub Releases, built, ad hoc signed and uploaded from a maintainer's Mac by two commands. The app is universal: one bundle runs on Apple silicon and Intel Macs.

Versions are CalVer `YYYY.M.N`, which is valid semver: the year, the month without a leading zero, and a counter inside that month that starts at 1 (`2026.10.1`, `2026.10.2`, `2026.11.1`). Tags are `v<version>`. Other tags (`app-v0.1.0`, `v0.1.0-rc.1`) are ignored. The next version is computed from the tags and today's date, so the counter restarts when the month changes.

Needs: a Mac (`codesign`, `ditto`, `hdiutil`, `lipo`), `python3` 3.11 or newer first on `PATH` (`scripts/release.sh` stops with a message otherwise), `gh` logged in, Rust through `rustup` with both Mac targets, and `npm ci` done:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # once; publish stops when one is missing
```

The disk image's window layout is set through Finder, so the first `publish` (or any `tauri build` of the disk image) asks once to let the terminal control Finder; allow it, or turn it on in System Settings, Privacy & Security, Automation.

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

- `feat` goes under **New**, `fix` under **Fixes**, every other type and every title without a type under **Other**. The `type(scope):` prefix is removed, the first letter is capitalized, and `(#N)` is kept for the GitHub page. The release pull request itself is skipped.
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

`publish` checks that the version files agree, that it is newer than the latest release, that `release-notes/<version>.md` exists and the bundled notes match it, that neither the tag nor the GitHub release exists, that `node_modules` is what `package-lock.json` locks (`node_modules/.package-lock.json`; run `npm ci` otherwise), and that `main` ends with the release pull request and nothing landed on `main` after the release commit, whether merged meanwhile or brought into the release branch by updating it from `main` (`--allow-newer` skips the two `main` checks; use it only when you know the notes cover what was merged since). Then it builds with `npm run tauri build -- --target universal-apple-darwin --bundles app,dmg -- --locked` (stdin from `/dev/null`, and an `actool` shim first on `PATH` that gives the real `actool` `/dev/null` too: the Tauri CLI hands its children a pipe as stdin, on which `actool` fails with "Bad file descriptor"), checks the bundle reports the version and that its binary holds both `arm64` and `x86_64` (`lipo -archs`), and verifies the ad hoc signature the bundler made (`signingIdentity: "-"` in `src-tauri/tauri.macos.conf.json`; `codesign --verify --deep --strict`, `Signature=adhoc`). The app is signed before the disk image is made and never re-signed, so the zip and the disk image carry the same bytes. Then it:

- zips the app with `ditto -c -k --keepParent` as `release/Riggverk-v<version>-macOS.zip` and checks that the signature survives the zip;
- puts the Riggverk volume icon on the bundler's disk image (the bundler cannot take one) and writes it as `release/Riggverk-v<version>-macOS.dmg`, then runs `hdiutil verify`, mounts it read-only and checks the app's signature and architectures, the Applications link and the volume icon;
- writes `release/SHA256SUMS` (`shasum -a 256` of the disk image and the zip);
- creates the annotated tag `v<version>`, pushes it and runs `gh release create v<version> <dmg> <zip> SHA256SUMS --notes-file release-notes/<version>.md`.

It prints the release URL. It does not rerun `release-check.sh`; `prepare` did.

The disk image art (a 660x400 graphite window with its @2x, the rune and wordmark top left, one silver arrow from the app to Applications, and the volume icon: the rune on a square graphite plate) is rendered from `assets/icon-source.svg` by `scripts/render-macos-rune-icons.swift` through `scripts/prepare-macos-app-icon.sh`, the build's `beforeBundleCommand`, into the ignored `src-tauri/macos/dmg/`. `release-check.sh` renders it too and checks the layout in `tauri.macos.conf.json` against it.

The app is not notarized (there is no Apple Developer ID yet). Users open the disk image and drag Riggverk to Applications (or unzip the zip and move the app there). On first launch macOS says it cannot verify the app: open System Settings, Privacy & Security, and choose Open Anyway. The **Install** section of every release says so, and names `SHA256SUMS` for checking a download (`shasum -a 256 -c SHA256SUMS --ignore-missing` in the download folder).

### Rollback

If a publish went wrong, delete the release and its tag, then publish again (the version in `main` is already bumped, so nothing else changes):

```bash
gh release delete v<version> --cleanup-tag --yes   # the GitHub release and the remote tag
git tag -d v<version>                              # the local tag
./scripts/release.sh publish
```

A failure after the tag was created prints these commands. A typo in the notes of a published release needs no rollback: `gh release edit v<version> --notes-file release-notes/<version>.md`. If the build itself is wrong, fix it in a pull request and publish with `--allow-newer`, or prepare the next version.

## Turning on updates

The app can update itself (Tauri's updater with a static `latest.json` on GitHub Releases), but it ships switched off: there is no `plugins.updater` in `src-tauri/tauri.conf.json`, so the app has no updater, no menu item, no update card and makes no network request, and `publish` makes no updater files. The design: the user is asked once ("Check daily" or "Not now"; nothing is requested before the answer), a new version is named in the sidebar foot, its review shows the notes, and one click, Download and restart, installs exactly that version after settling unsaved work. Nothing installs in the background, and older versions are never installed.

Updates need public release files: the app fetches `https://github.com/hugrverk/riggverk/releases/latest/download/latest.json` without credentials, which a private repository answers with 404. Turn them on the day the repository goes public, in this order:

1. **Make the signing key** (once, on the release Mac; never in the repository, never in CI while CI is off):

   ```bash
   npm run tauri signer generate -- -w ~/.tauri/riggverk-updater.key   # asks for a password; use a long one
   ```

   It writes the private key `~/.tauri/riggverk-updater.key` and the public key `~/.tauri/riggverk-updater.key.pub`.
2. **Keep the key safe.** Store the private key file and its password in the Keychain or your password manager, and make an encrypted offline backup (for example an encrypted disk image on a USB stick kept elsewhere). A lost key means installed apps can never be updated again: every later release would have to be installed by hand. A leaked key lets someone sign an update, so it is never printed, committed or pasted anywhere.
3. **Set the public key and endpoint** in `src-tauri/tauri.conf.json`, as a top-level `plugins` block (one switch: the app and `release.sh` both read it):

   ```json
   "plugins": {
     "updater": {
       "pubkey": "<the one line in ~/.tauri/riggverk-updater.key.pub>",
       "endpoints": ["https://github.com/hugrverk/riggverk/releases/latest/download/latest.json"],
       "requireSignedVersion": true
     }
   }
   ```

   The app and `release_tools.py updater-config` treat anything weaker (no `requireSignedVersion`, `allowDowngrades`, a `dangerous*` option, plain HTTP, another endpoint shape) as off or as an error. Merge it through a normal pull request; it ships with the next release.
4. **Make the repository public**, and turn on immutable releases (Settings, General, Releases) so a published release's files cannot be swapped.
5. **Apply the wording** that docs/SECURITY_MODEL.md ("App updates") gives for when updates are on, in the same pull request as step 3.
6. **Publish with the key in the environment.** `publish` turns the updater on only when `TAURI_SIGNING_PRIVATE_KEY` is set; it refuses a key without the `plugins.updater` block, and the block without a key (a release without `latest.json` never reaches installed apps). Read both from the Keychain, never from a file in the repository:

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(security find-generic-password -s riggverk-updater-key -w)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s riggverk-updater-password -w)"
   ./scripts/release.sh publish --dry-run   # says "updates: on (signing key: ok; latest.json for hugrverk/riggverk)"
   ./scripts/release.sh publish
   ```

   (Store them once with `security add-generic-password -s riggverk-updater-key -a "$USER" -w` and `-s riggverk-updater-password`, which prompt for the value.) With the key, `publish` also builds the signed updater archive (`createUpdaterArtifacts`; the bundler signs it for the version, so `requireSignedVersion` holds), checks the app inside it, writes `release/latest.json` (`release_tools.py updater-manifest`: both `darwin-aarch64` and `darwin-x86_64` point at the universal `Riggverk-v<version>-macOS.app.tar.gz`, with the notes minus the Install section), adds the archive to `SHA256SUMS`, creates the release as a draft with every file, checks that every file is there, and only then publishes it as the latest release, so `latest.json` never points at a missing file.

The first release with the block is still installed by hand; the ones after it reach installed apps. A broken release is fixed with a newer version: the app never installs an older one, and there is no remote switch to stop a published update.

Until the app is notarized (Apple Developer ID), an update is still ad hoc signed: the update itself needs no Open Anyway (the app downloads it, so it carries no quarantine flag), but macOS may ask for folder or automation permissions again after it, because each ad hoc build counts as a new app. An app run from the disk image or straight from Downloads (App Translocation) cannot be replaced; the review says "Move Riggverk to Applications first".

To try the update UI without a release: `npm run dev`, then `http://localhost:1420/?mock=update`.

## Backend runtime smoke

```bash
./scripts/smoke-tauri-runtime.sh
```

Isolated temp `HOME` and workspace path; exercises the Rust command handlers the app calls (status, diagnostics, OpenCode and Cursor health). `release-check.sh` already runs it. It does not automate the webview.

## Browser-only checks

`npm run dev` then `http://localhost:1420/?mock=<scenario>` renders the UI against `src/dev/mockBackend.ts` (scenarios `default`, `conflict`, `fresh`, `error`, `empty`, and `update` for a build with app updates on and a new version on offer). Use it for layout and keyboard checks. It has no Tauri backend, so it cannot prove filesystem behavior.

## Manual GUI smoke

Before sharing a build, run [APP_RELEASE_SMOKE.md](./APP_RELEASE_SMOKE.md) in the real Tauri app with an isolated `HOME`, `RIGGVERK_WORKSPACE_PATH`, and `RIGGVERK_BACKUP_DIR`. It covers, in order of risk:

- Install review: `u`, plan table, `n` cancels with nothing written, `y` applies, target switches gate the plan.
- Decisions: Compare, Merge in updates, Keep mine, Use Riggverk's version and defaults.
- Undo (`z`), History and uninstall with recovery.
- Overview, agent pages, Library and Settings on both themes.
- Keyboard layer, fixed digits, Tab order and focus ring, help overlay, command line.

Sidebar order is Overview, the enabled agents, History, Library, Settings; the digits are `1`, `2`-`5`, `6`, `7`, `8`.

## Installing a local build

The app bundle is `Riggverk.app` (executable `riggverk`, identifier `se.hugrverk.riggverk`).

1. Build: `npm run tauri build -- --bundles app -- --locked` (this Mac's architecture only; add `--target universal-apple-darwin` for the universal app, which lands under `src-tauri/target/universal-apple-darwin/release/bundle/`). With `--bundles app,dmg` the bundler also makes a disk image with the Riggverk background but its default volume icon; only `release.sh publish` adds the Riggverk one.
2. Install: `ditto "src-tauri/target/release/bundle/macos/Riggverk.app" /Applications/Riggverk.app`.
3. Launch Riggverk.

The bundle is ad-hoc signed and not notarized, so Gatekeeper and any folder-access prompts apply as for any local build.

For installs that predate the rename, see [Upgrading from earlier versions](../README.md#upgrading-from-earlier-versions) in the README and [App data move](#app-data-move) below.

Releases are built and zipped by `scripts/release.sh publish` (see [Cutting a release](#cutting-a-release)); name any other manual zip `Riggverk-v<version>-<channel>-macOS.zip`.

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
