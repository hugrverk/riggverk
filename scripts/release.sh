#!/usr/bin/env bash
# Local release flow (no CI). See docs/RELEASE.md.
#
#   scripts/release.sh prepare [--dry-run] [--since REV]   next CalVer version, notes draft, bump, release check, PR
#   scripts/release.sh build-linux [--dry-run]             on Linux: AppImage, deb and rpm of main into release/linux
#   scripts/release.sh publish [--dry-run] [--allow-newer] [--no-linux]
#                                                          on macOS: universal build, dmg, zip, the Linux packages from
#                                                          release/linux, SHA256SUMS, tag and GitHub release
#
# App updates: with plugins.updater in src-tauri/tauri.conf.json, publish reads the signing key and its password from
# the macOS Keychain into the environment of the tauri build alone, signs the updater archive, writes latest.json and
# releases as a draft that is published once every asset is there; see docs/RELEASE.md, "Turning on updates". The
# Linux AppImage is signed there too, so the signing key never leaves the Mac.
#
# --dry-run runs the read-only checks (and git fetch) and prints what a real run would do; it changes nothing.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
# Python helpers are shipped inside the repo; never leave bytecode caches behind.
export PYTHONDONTWRITEBYTECODE=1

dry_run=0
problems=0
stage="none"
branch=""
version=""
notes_file=""
tmp_dir=""
dmg_mount=""
updater=0
updater_repo=""
# Keychain items (generic passwords) that hold the updater signing key and its password.
updater_key_item="riggverk-updater-key"
updater_password_item="riggverk-updater-password"
# Where build-linux leaves the Linux packages and where publish takes them from (copied over from the Linux machine).
linux_dir="release/linux"
linux=0

step() {
  printf '\n==> %s\n' "$1"
}

info() {
  printf '  %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
usage:
  scripts/release.sh prepare [--dry-run] [--since REV]
  scripts/release.sh build-linux [--dry-run]
  scripts/release.sh publish [--dry-run] [--allow-newer] [--no-linux]
USAGE
}

# A failed check stops a real run. A dry run reports it and carries on, so one pass lists every problem.
problem() {
  printf 'FAIL: %s\n' "$1" >&2
  if [ "$dry_run" -eq 1 ]; then
    problems=$((problems + 1))
  else
    exit 1
  fi
}

would() {
  printf '  [dry-run] would %s\n' "$1"
}

require_python() {
  local found
  if ! found="$(python3 --version 2>&1)"; then
    fail "python3 is required (3.11 or newer)"
  fi
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    fail "python3 3.11 or newer is required by scripts/release-check.sh (found: $found); put a newer python3 first on PATH"
  fi
  info "ok: $found"
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || problem "$tool is required but is not on PATH"
  done
}

require_gh_login() {
  gh auth status >/dev/null 2>&1 || problem "gh is not logged in (gh auth login)"
}

# main, clean, and equal to origin/main. Fetches tags so versions are computed from what is released.
require_clean_main() {
  local current
  current="$(git rev-parse --abbrev-ref HEAD)"
  [ "$current" = "main" ] || problem "run this from main (current branch: $current)"
  [ -z "$(git status --porcelain)" ] || problem "the working tree is not clean (git status --short)"
  git fetch --quiet origin --tags || fail "git fetch origin failed"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse --verify --quiet refs/remotes/origin/main || echo missing)" ]; then
    problem "main is not equal to origin/main (git pull --ff-only, or push your commits)"
  fi
  info "checked: branch main, clean tree, equal to origin/main"
}

release_tags() {
  git tag --list 'v*'
}

# 0: the tag is on origin, 1: it is not. Anything else (no network, no access) is an error, not "absent".
remote_tag_exists() {
  local code=0
  git ls-remote --exit-code --tags origin "refs/tags/$1" >/dev/null 2>&1 || code=$?
  case "$code" in
    0) return 0 ;;
    2) return 1 ;;
    *) fail "cannot read tags from origin (git ls-remote exit $code)" ;;
  esac
}

remote_branch_exists() {
  local code=0
  git ls-remote --exit-code --heads origin "refs/heads/$1" >/dev/null 2>&1 || code=$?
  case "$code" in
    0) return 0 ;;
    2) return 1 ;;
    *) fail "cannot read branches from origin (git ls-remote exit $code)" ;;
  esac
}

github_release_exists() {
  local output
  if output="$(gh release view "$1" 2>&1)"; then
    return 0
  fi
  case "$output" in
    *"release not found"*) return 1 ;;
    *) fail "cannot check GitHub releases for $1: $output" ;;
  esac
}

finish_dry_run() {
  if [ "$problems" -gt 0 ]; then
    printf '\ndry run: %s check(s) failed; a real run would stop at the first one\n' "$problems" >&2
    exit 1
  fi
  printf '\ndry run: all checks passed; nothing was changed\n'
}

# ── prepare ──

prepare_tracked_paths=(
  package.json
  package-lock.json
  src-tauri/tauri.conf.json
  src-tauri/Cargo.toml
  src-tauri/Cargo.lock
  src/generated/release-notes.json
)

cleanup_prepare() {
  local status=$?
  trap - EXIT
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  if [ "$status" -ne 0 ] && [ "$stage" = "edited" ]; then
    printf '\nprepare failed before the commit; undoing its local changes\n' >&2
    git restore --staged --worktree -- "${prepare_tracked_paths[@]}" || true
    git rm --quiet --cached --ignore-unmatch -- "$notes_file" || true
    rm -f "$notes_file"
    rmdir release-notes 2>/dev/null || true
    git switch --quiet main && git branch --quiet -D "$branch" || true
  elif [ "$status" -ne 0 ] && [ "$stage" = "committed" ]; then
    printf '\nprepare failed after the commit on %s. Nothing is lost: finish by hand with\n' "$branch" >&2
    printf '  git push -u origin %s\n  gh pr create --base main --head %s --title "chore(release): %s"\n' "$branch" "$branch" "$version" >&2
  fi
  exit "$status"
}

# cargo check rewrites src-tauri/Cargo.lock; only the app's own version line may differ.
refresh_cargo_lock() {
  cargo check --quiet --manifest-path src-tauri/Cargo.toml
  local changed
  changed="$(git diff -U0 -- src-tauri/Cargo.lock | grep -c '^[-+][^-+]' || true)"
  [ "$changed" -eq 2 ] || fail "cargo check changed more of src-tauri/Cargo.lock than the app version ($changed lines)"
}

# npm rewrites package-lock.json; only version lines may differ.
refresh_npm_lock() {
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
  local unexpected
  unexpected="$(git diff -U0 -- package-lock.json | grep '^[-+][^-+]' | grep -vc '"version": ' || true)"
  [ "$unexpected" -eq 0 ] || fail "npm changed more of package-lock.json than the app version ($unexpected lines)"
}

commit_release() {
  git add -- "${prepare_tracked_paths[@]}" "$notes_file"
  local unexpected
  unexpected="$(git status --porcelain --untracked-files=all | grep -v '^[AM]  ' || true)"
  [ -z "$unexpected" ] || fail "unexpected changes besides the release files:
$unexpected"
  git commit --quiet -m "chore(release): $version"
  stage="committed"
  info "committed chore(release): $version on $branch"
}

open_release_pr() {
  local body
  body="$tmp_dir/pr-body.md"
  cat >"$body" <<BODY
Release $version.

- Review \`release-notes/$version.md\`. After editing it, run \`python3 scripts/generate-release-notes.py --write\`, then commit and push.
- \`scripts/release-check.sh\` passed before this commit; it does not rerun after you edit the notes.
- Merge, then run \`./scripts/release.sh publish\` on main. Nothing else may be merged in between.
BODY
  git push --quiet -u origin "$branch"
  gh pr create --base main --head "$branch" --title "chore(release): $version" --body-file "$body"
}

cmd_prepare() {
  local since="" previous="" base_args=() draft_args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --since)
        [ $# -ge 2 ] || fail "--since needs a revision"
        since="$2"
        shift
        ;;
      *) usage >&2; fail "unknown option for prepare: $1" ;;
    esac
    shift
  done

  step "preflight"
  require_python
  require_tools git gh npm cargo
  require_gh_login
  require_clean_main
  if [ -n "$since" ] && ! git rev-parse --verify --quiet "$since^{commit}" >/dev/null; then
    fail "--since $since is not a commit"
  fi

  step "version"
  previous="$(release_tags | python3 scripts/release_tools.py latest-tag)"
  version="$(release_tags | python3 scripts/release_tools.py next-version)"
  branch="release/v$version"
  notes_file="release-notes/$version.md"
  info "previous release: ${previous:-none}"
  info "next version:     $version"
  [ ! -e "$notes_file" ] || problem "$notes_file already exists: $version is prepared but not published"
  if git show-ref --verify --quiet "refs/heads/$branch" || remote_branch_exists "$branch"; then
    problem "branch $branch already exists"
  fi

  step "draft the release notes"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-release.XXXXXX")"
  trap cleanup_prepare EXIT
  trap 'exit 130' INT TERM
  if [ -n "${since:-$previous}" ]; then
    base_args=(--base "${since:-$previous}")
    info "merged pull requests since ${since:-$previous}"
  else
    info "no previous release: listing every merged pull request (use --since REV to start later)"
  fi
  draft_args=(draft-notes --version "$version")
  if python3 scripts/release_tools.py "${draft_args[@]}" ${base_args[@]+"${base_args[@]}"} >"$tmp_dir/notes.md"; then
    if [ "$dry_run" -eq 1 ]; then
      info "$notes_file would start as:"
      sed 's/^/    | /' "$tmp_dir/notes.md"
    fi
  else
    problem "could not draft the release notes"
  fi

  if [ "$dry_run" -eq 1 ]; then
    step "changes"
    local line would_do=(
      "create branch $branch from main"
      "set the version $version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml"
      "refresh src-tauri/Cargo.lock with cargo check and package-lock.json with npm install --package-lock-only"
      "write $notes_file and regenerate src/generated/release-notes.json"
      "run ./scripts/release-check.sh"
      "commit 'chore(release): $version', push $branch and open a pull request against main"
    )
    for line in "${would_do[@]}"; do
      would "$line"
    done
    finish_dry_run
    return
  fi

  step "create $branch"
  git switch --quiet -c "$branch"
  stage="edited"

  step "bump the version to $version"
  python3 scripts/release_tools.py set-version "$version"
  info "cargo check (rewrites src-tauri/Cargo.lock; compiles when the build directory is cold)"
  refresh_cargo_lock
  info "npm install --package-lock-only"
  refresh_npm_lock

  step "release notes"
  mkdir -p release-notes
  cp "$tmp_dir/notes.md" "$notes_file"
  python3 scripts/generate-release-notes.py --write
  python3 scripts/release_tools.py check-versions --expect "$version"

  step "release check"
  ./scripts/release-check.sh

  step "commit, push and open the pull request"
  commit_release
  open_release_pr

  printf '\nNext: review and edit %s on %s (then python3 scripts/generate-release-notes.py --write,\n' "$notes_file" "$branch"
  printf 'commit and push), merge the pull request, then run ./scripts/release.sh publish on main.\n'
}

# ── publish ──

cleanup_publish() {
  local status=$?
  trap - EXIT
  if [ -n "$dmg_mount" ]; then
    hdiutil detach -quiet -force "$dmg_mount" || true
  fi
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  if [ "$status" -ne 0 ] && [ "$stage" = "drafted" ]; then
    printf '\npublish failed after the draft release v%s was created; nothing is public yet. To retry:\n' "$version" >&2
    printf '  gh release delete v%s --cleanup-tag --yes; git tag -d v%s\n' "$version" "$version" >&2
  elif [ "$status" -ne 0 ] && [ "$stage" = "tagged" ]; then
    printf '\npublish failed after the tag v%s was created. To retry from a clean slate:\n' "$version" >&2
    printf '  git push origin --delete v%s; git tag -d v%s\n' "$version" "$version" >&2
    printf 'If the release exists on GitHub: gh release delete v%s --cleanup-tag --yes\n' "$version" >&2
  fi
  exit "$status"
}

# One universal (arm64 + x86_64) build; rustup must have both targets (see docs/RELEASE.md).
build_target="universal-apple-darwin"
bundle_dir="${CARGO_TARGET_DIR:-$repo_root/src-tauri/target}/$build_target/release/bundle"
app_bundle="$bundle_dir/macos/Riggverk.app"
volume_icon="src-tauri/macos/dmg/VolumeIcon.icns"
built_dmg=""

require_universal_targets() {
  local installed target
  installed="$(rustup target list --installed 2>/dev/null)" || {
    problem "rustup is required for the universal build"
    return 0
  }
  for target in aarch64-apple-darwin x86_64-apple-darwin; do
    printf '%s\n' "$installed" | grep -qx "$target" || problem "the Rust target $target is missing (rustup target add $target)"
  done
}

# The binary must hold both architectures.
check_universal() {
  local archs
  archs=" $(lipo -archs "$1/Contents/MacOS/riggverk") "
  case "$archs" in *" arm64 "*) ;; *) fail "$1 has no arm64 slice (lipo:$archs)" ;; esac
  case "$archs" in *" x86_64 "*) ;; *) fail "$1 has no x86_64 slice (lipo:$archs)" ;; esac
}

# The bundler signs ad hoc (signingIdentity "-" in tauri.macos.conf.json) before it makes the disk image, so the
# app, the zip and the disk image carry the same signature; re-signing here would change the bytes after the fact.
check_signature() {
  local details
  codesign --verify --deep --strict "$1"
  details="$(codesign --display --verbose=2 "$1" 2>&1)"
  case "$details" in
    *"Signature=adhoc"*) ;;
    *) fail "$1 is not ad hoc signed" ;;
  esac
}

# Updates are on when tauri.conf.json has plugins.updater; then the signing key and its password must be readable in the
# Keychain, or this release would ship without latest.json and never reach installed apps. Only build_app reads them,
# for the tauri build alone; a key exported in the shell would reach every step and is refused. Nothing here prints them.
check_updater() {
  local status item
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY+set}${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]; then
    problem "TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PASSWORD is set in this shell; publish reads both from the Keychain for the build alone (unset them, and close the shell that exported them)"
  fi
  if ! status="$(python3 scripts/release_tools.py updater-config)"; then
    problem "plugins.updater in src-tauri/tauri.conf.json is incomplete or weakened (see above)"
    return 0
  fi
  case "$status" in
    on\ *)
      for item in "$updater_key_item" "$updater_password_item"; do
        if ! security find-generic-password -s "$item" -w >/dev/null 2>&1; then
          problem "src-tauri/tauri.conf.json turns updates on, but the Keychain item $item is missing or unreadable: without latest.json installed apps never see this release (docs/RELEASE.md, Turning on updates)"
          return 0
        fi
      done
      updater=1
      updater_repo="${status#on }"
      info "updates: on (signing key: in the Keychain; latest.json for $updater_repo)"
      ;;
    *) info "updates: off (no plugins.updater)" ;;
  esac
}

build_app() {
  local built dmgs shim_dir="$tmp_dir/bin"
  rm -rf "$bundle_dir/macos" "$bundle_dir/dmg"
  # actool (the Icon Composer icon) fails with "Bad file descriptor" when stdin is closed, as in a background job or CI,
  # and also when its stdin is the pipe the Tauri CLI (node) hands its children even with </dev/null below. The bundler
  # runs `actool` from PATH, so a shim first on PATH gives the real one /dev/null.
  mkdir -p "$shim_dir"
  printf '#!/bin/sh\nexec xcrun actool "$@" </dev/null\n' >"$shim_dir/actool"
  chmod +x "$shim_dir/actool"
  # The disk image layout is set through Finder: the terminal needs Automation permission for Finder once.
  local config_args=()
  # The updater archive (Riggverk.app.tar.gz, signed for this version) is made from the app the bundler signed.
  [ "$updater" -eq 0 ] || config_args=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
  # The signing key and its password are read in this subshell and exported to the build alone; the rest of the script
  # never holds them. xtrace stays off here, so even bash -x cannot print them.
  (
    { set +x; } 2>/dev/null
    if [ "$updater" -eq 1 ]; then
      TAURI_SIGNING_PRIVATE_KEY="$(security find-generic-password -s "$updater_key_item" -w)" &&
        [ -n "$TAURI_SIGNING_PRIVATE_KEY" ] || fail "could not read the signing key from the Keychain item $updater_key_item"
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s "$updater_password_item" -w)" ||
        fail "could not read the key password from the Keychain item $updater_password_item"
      export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    fi
    PATH="$shim_dir:$PATH" exec npm run tauri build -- --target "$build_target" --bundles app,dmg \
      ${config_args[@]+"${config_args[@]}"} -- --locked </dev/null
  )
  [ -d "$app_bundle" ] || fail "the build did not produce $app_bundle"
  built="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_bundle/Contents/Info.plist")"
  [ "$built" = "$version" ] || fail "the bundle reports version $built, expected $version"
  dmgs=("$bundle_dir"/dmg/*.dmg)
  [ "${#dmgs[@]}" -eq 1 ] && [ -f "${dmgs[0]}" ] || fail "the build did not produce one disk image in $bundle_dir/dmg"
  built_dmg="${dmgs[0]}"
  check_universal "$app_bundle"
  info "built universal Riggverk.app $built and $(basename "$built_dmg")"
}

sign_app() {
  check_signature "$app_bundle"
  info "ad hoc signed by the bundler and verified"
}

zip_app() {
  local check_dir
  mkdir -p release
  rm -f "$zip_file"
  ditto -c -k --keepParent "$app_bundle" "$zip_file"
  # The signature must survive the zip round trip.
  check_dir="$tmp_dir/unzipped"
  mkdir -p "$check_dir"
  ditto -x -k "$zip_file" "$check_dir"
  codesign --verify --deep --strict "$check_dir/Riggverk.app"
  info "$zip_file ($(du -h "$zip_file" | cut -f1))"
}

# mount_dmg -readonly|-readwrite IMAGE
mount_dmg() {
  dmg_mount="$tmp_dir/mount"
  mkdir -p "$dmg_mount"
  hdiutil attach -quiet -nobrowse -noautoopen "$1" -mountpoint "$dmg_mount" "$2"
}

unmount_dmg() {
  hdiutil detach -quiet "$dmg_mount"
  dmg_mount=""
}

# The bundler's disk image (background, icon positions, Applications link) gets the Riggverk volume icon, which the
# bundler cannot take, and is compressed again.
dmg_app() {
  local writable="$tmp_dir/writable.dmg"
  [ -s "$volume_icon" ] || fail "$volume_icon is missing (the build's beforeBundleCommand renders it)"
  hdiutil convert -quiet "$built_dmg" -format UDRW -o "$writable"
  mount_dmg -readwrite "$writable"
  cp "$volume_icon" "$dmg_mount/.VolumeIcon.icns"
  unmount_dmg
  rm -f "$dmg_file"
  hdiutil convert -quiet "$writable" -format UDZO -imagekey zlib-level=9 -o "$dmg_file"

  hdiutil verify -quiet "$dmg_file"
  mount_dmg -readonly "$dmg_file"
  check_signature "$dmg_mount/Riggverk.app"
  check_universal "$dmg_mount/Riggverk.app"
  [ -L "$dmg_mount/Applications" ] || fail "$dmg_file has no Applications link"
  cmp -s "$volume_icon" "$dmg_mount/.VolumeIcon.icns" || fail "$dmg_file does not carry the Riggverk volume icon"
  unmount_dmg
  info "$dmg_file ($(du -h "$dmg_file" | cut -f1)), verified, mounted and checked"
}

# The signed updater archive and latest.json. The archive must hold the same signed app as the zip and the disk image.
updater_artifacts() {
  local archive="$bundle_dir/macos/Riggverk.app.tar.gz" check_dir="$tmp_dir/updater"
  [ -s "$archive" ] && [ -s "$archive.sig" ] || fail "the build did not produce $archive and its .sig"
  cp "$archive" "$updater_file"
  cp "$archive.sig" "$updater_file.sig"
  mkdir -p "$check_dir"
  tar -xzf "$updater_file" -C "$check_dir"
  check_signature "$check_dir/Riggverk.app"
  check_universal "$check_dir/Riggverk.app"
  local linux_args=()
  [ "$linux" -eq 0 ] || linux_args=(--linux-asset "$(basename "$linux_appimage")" --linux-signature-file "$linux_appimage.sig")
  python3 scripts/release_tools.py updater-manifest --version "$version" --repo "$updater_repo" \
    --asset "$(basename "$updater_file")" --signature-file "$updater_file.sig" --notes-file "$notes_file" \
    ${linux_args[@]+"${linux_args[@]}"} >"$manifest_file"
  info "$updater_file, its .sig and $manifest_file"
}

# Signs the Linux AppImage for the updater, bound to this version like the bundler's own signatures; the key is read
# here, for the signer alone, as in build_app, and never leaves the Mac.
sign_linux_appimage() {
  rm -f "$linux_appimage.sig"
  (
    { set +x; } 2>/dev/null
    TAURI_SIGNING_PRIVATE_KEY="$(security find-generic-password -s "$updater_key_item" -w)" &&
      [ -n "$TAURI_SIGNING_PRIVATE_KEY" ] || fail "could not read the signing key from the Keychain item $updater_key_item"
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s "$updater_password_item" -w)" ||
      fail "could not read the key password from the Keychain item $updater_password_item"
    export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    exec npm run --silent tauri -- signer sign --app-version "$version" "$linux_appimage" </dev/null
  ) >/dev/null
  [ -s "$linux_appimage.sig" ] || fail "signing did not produce $linux_appimage.sig"
  info "$linux_appimage.sig"
}

write_checksums() {
  local files=("$(basename "$dmg_file")" "$(basename "$zip_file")") file
  [ "$updater" -eq 0 ] || files+=("$(basename "$updater_file")")
  (cd "$(dirname "$sums_file")" && shasum -a 256 "${files[@]}") >"$sums_file"
  if [ "$linux" -eq 1 ]; then
    files=()
    for file in "${linux_files[@]}"; do
      files+=("$(basename "$file")")
    done
    (cd "$linux_dir" && shasum -a 256 "${files[@]}") >>"$sums_file"
  fi
  sed 's/^/  /' "$sums_file"
}

create_release() {
  local url
  git tag -a "v$version" -m "Riggverk $version"
  stage="tagged"
  git push --quiet origin "refs/tags/v$version"
  if [ "$updater" -eq 0 ]; then
    url="$(gh release create "v$version" "${release_assets[@]}" --title "Riggverk $version" \
      --notes-file "$notes_file" --verify-tag)"
  else
    # A draft first: latest.json goes public only together with every file it and the page point to.
    gh release create "v$version" "${release_assets[@]}" --title "Riggverk $version" --notes-file "$notes_file" \
      --verify-tag --draft >/dev/null
    stage="drafted"
    check_release_assets "${release_assets[@]}"
    url="$(gh release edit "v$version" --draft=false --latest)"
  fi
  stage="released"
  printf '\nReleased: %s\n' "$url"
}

check_release_assets() {
  local uploaded file
  uploaded="$(gh release view "v$version" --json assets --jq '.assets[].name')"
  for file in "$@"; do
    printf '%s\n' "$uploaded" | grep -qxF "$(basename "$file")" || fail "the draft release v$version lacks $(basename "$file")"
  done
  info "checked: the draft has every asset"
}

# The notes were drafted at the release commit. Whatever landed on main after it (a PR merged meanwhile, or brought
# into the release branch by updating it from main) is built but not covered, so main before the merge of the
# release PR must be an ancestor of the release commit. A squash merge has no second parent to check.
check_nothing_merged_since_the_release_commit() {
  local allow_newer="$1" release_commit newer
  git rev-parse --verify --quiet 'HEAD^2' >/dev/null || return 0
  release_commit="$(git log -1 --format=%H --fixed-strings --grep="chore(release): $version" 'HEAD^2')"
  if [ -z "$release_commit" ]; then
    problem "the merged release PR has no chore(release): $version commit"
    return 0
  fi
  git merge-base --is-ancestor 'HEAD^1' "$release_commit" && return 0
  newer="$(git log --oneline --first-parent -n 5 "$release_commit..HEAD^1")"
  if [ "$allow_newer" -eq 1 ]; then
    info "main has changes the release commit does not cover (--allow-newer)"
  else
    problem "main has changes merged after the release commit for $version, so the notes may not cover what is built (--allow-newer to build anyway):
$newer"
  fi
}

# The version main releases: consistent everywhere, newer than every release, with its notes, not yet tagged or
# released, and main ends with its release PR. Sets version and notes_file (version stays empty when inconsistent).
check_version_and_notes() {
  local allow_newer="$1" head_message
  if version="$(python3 scripts/release_tools.py check-versions)"; then
    info "app version: $version"
  else
    version=""
    problem "the app version is inconsistent (see above)"
  fi
  if [ -n "$version" ]; then
    notes_file="release-notes/$version.md"
    release_tags | python3 scripts/release_tools.py check-newer "$version" || problem "$version cannot be published"
    [ -s "$notes_file" ] || problem "$notes_file is missing or empty (was the release PR merged?)"
    if python3 scripts/generate-release-notes.py --check >/dev/null; then
      info "checked: the bundled what's new matches release-notes/"
    else
      problem "the bundled what's new does not match release-notes/"
    fi
    if git rev-parse --verify --quiet "refs/tags/v$version" >/dev/null || remote_tag_exists "v$version"; then
      problem "tag v$version already exists"
    fi
    if github_release_exists "v$version"; then
      problem "GitHub release v$version already exists"
    fi
    head_message="$(git log -1 --first-parent --format='%s%n%b' HEAD)"
    case "$head_message" in
      *"release/v$version"* | *"chore(release): $version"*)
        info "checked: main ends with the merge of the release PR"
        check_nothing_merged_since_the_release_commit "$allow_newer"
        ;;
      *)
        if [ "$allow_newer" -eq 1 ]; then
          info "main has moved past the release PR (--allow-newer)"
        else
          problem "main does not end with the release PR for $version, so the notes may not cover what is built (--allow-newer to build anyway)"
        fi
        ;;
    esac
  fi
}

# The Linux packages build-linux left in release/linux: of this version, built from HEAD, unchanged. --no-linux
# releases macOS alone; installed Linux apps then see no update until the next release with Linux packages.
check_linux() {
  local no_linux="$1"
  if [ "$no_linux" -eq 1 ]; then
    info "Linux: skipped (--no-linux)"
    return 0
  fi
  if python3 scripts/release_tools.py linux-stamp check --dir "$linux_dir" --version "$version" --commit "$(git rev-parse HEAD)"; then
    linux=1
    info "checked: $linux_dir holds the AppImage, deb and rpm of $version, built from HEAD"
  else
    problem "no Linux packages of this commit in $linux_dir (run ./scripts/release.sh build-linux on Linux and copy $linux_dir here, or --no-linux)"
  fi
}

cmd_publish() {
  local allow_newer=0 no_linux=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --allow-newer) allow_newer=1 ;;
      --no-linux) no_linux=1 ;;
      *) usage >&2; fail "unknown option for publish: $1" ;;
    esac
    shift
  done

  step "preflight"
  require_python
  require_tools git gh npm codesign ditto hdiutil lipo shasum
  require_universal_targets
  check_updater
  require_gh_login
  # The build uses whatever is installed; it must be what the tag's lock says.
  if python3 scripts/release_tools.py check-node-modules; then
    info "checked: node_modules matches package-lock.json"
  else
    problem "node_modules is not what package-lock.json locks (npm ci)"
  fi
  require_clean_main

  step "version and notes"
  check_version_and_notes "$allow_newer"
  if [ -n "$version" ]; then
    check_linux "$no_linux"
  fi

  zip_file="release/Riggverk-v${version:-VERSION}-macOS.zip"
  dmg_file="release/Riggverk-v${version:-VERSION}-macOS.dmg"
  sums_file="release/SHA256SUMS"
  updater_file="release/Riggverk-v${version:-VERSION}-macOS.app.tar.gz"
  manifest_file="release/latest.json"
  linux_appimage="$linux_dir/Riggverk-v${version:-VERSION}-linux-x86_64.AppImage"
  linux_files=("$linux_appimage" "$linux_dir/Riggverk-v${version:-VERSION}-linux-amd64.deb"
    "$linux_dir/Riggverk-v${version:-VERSION}-linux-x86_64.rpm")
  release_assets=("$dmg_file" "$zip_file")
  [ "$updater" -eq 0 ] || release_assets+=("$updater_file" "$updater_file.sig" "$manifest_file")
  [ "$linux" -eq 0 ] || release_assets+=("${linux_files[@]}")
  [ "$updater" -eq 0 ] || [ "$linux" -eq 0 ] || release_assets+=("$linux_appimage.sig")
  release_assets+=("$sums_file")
  if [ "$dry_run" -eq 1 ]; then
    step "release"
    would "build: npm run tauri build -- --target $build_target --bundles app,dmg -- --locked (expects $app_bundle, universal)"
    would "verify the bundler's ad hoc signature: codesign --verify --deep --strict $app_bundle"
    would "zip: ditto -c -k --keepParent $app_bundle $zip_file, then verify the signature inside the zip"
    would "disk image: add the volume icon to the bundler's disk image as $dmg_file, then hdiutil verify, mount and check the app"
    if [ "$updater" -eq 1 ] && [ "$linux" -eq 1 ]; then
      would "sign the Linux AppImage: npm run tauri -- signer sign --app-version ${version:-VERSION} $linux_appimage, with the same Keychain key in the signer's environment only"
    fi
    if [ "$updater" -eq 1 ]; then
      local linux_entry=""
      [ "$linux" -eq 0 ] || linux_entry=" and the AppImage for linux-x86_64"
      would "updates: build with createUpdaterArtifacts and the signing key from the Keychain ($updater_key_item, $updater_password_item) in that build's environment only, copy the signed archive to $updater_file (+ .sig), check the app inside, write $manifest_file for $updater_repo$linux_entry"
    fi
    if [ "$linux" -eq 1 ]; then
      would "checksums: shasum -a 256 of the macOS files and the Linux packages in $linux_dir into $sums_file"
    else
      would "checksums: shasum -a 256 of the macOS files into $sums_file"
    fi
    would "tag: git tag -a v${version:-VERSION} -m 'Riggverk ${version:-VERSION}', then git push origin refs/tags/v${version:-VERSION}"
    if [ "$updater" -eq 1 ]; then
      would "release: gh release create v${version:-VERSION} ${release_assets[*]} --title 'Riggverk ${version:-VERSION}' --notes-file ${notes_file:-release-notes/VERSION.md} --verify-tag --draft, check the assets, then gh release edit v${version:-VERSION} --draft=false --latest"
    else
      would "release: gh release create v${version:-VERSION} ${release_assets[*]} --title 'Riggverk ${version:-VERSION}' --notes-file ${notes_file:-release-notes/VERSION.md} --verify-tag"
    fi
    finish_dry_run
    return
  fi

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-release.XXXXXX")"
  trap cleanup_publish EXIT
  trap 'exit 130' INT TERM

  step "build"
  build_app
  step "sign"
  sign_app
  step "zip"
  zip_app
  step "disk image"
  dmg_app
  if [ "$updater" -eq 1 ] && [ "$linux" -eq 1 ]; then
    step "sign the Linux AppImage"
    sign_linux_appimage
  fi
  if [ "$updater" -eq 1 ]; then
    step "updater archive and latest.json"
    updater_artifacts
  fi
  step "checksums"
  write_checksums
  step "tag and GitHub release"
  create_release
}

# ── build-linux ──

cleanup_build_linux() {
  local status=$?
  trap - EXIT
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  exit "$status"
}

# Runs on the Linux machine at the commit publish will release: the same checks as publish, then the container build
# (scripts/linux-build.sh) and the release names and stamp in release/linux. Nothing is tagged or uploaded here.
cmd_build_linux() {
  local allow_newer=0 commit build_dir
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --allow-newer) allow_newer=1 ;;
      *) usage >&2; fail "unknown option for build-linux: $1" ;;
    esac
    shift
  done

  step "preflight"
  [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] || problem "build-linux runs on a Linux x86_64 host"
  require_python
  require_tools git gh podman
  require_gh_login
  require_clean_main

  step "version and notes"
  check_version_and_notes "$allow_newer"
  commit="$(git rev-parse HEAD)"

  if [ "$dry_run" -eq 1 ]; then
    step "build"
    would "build: scripts/linux-build.sh (AppImage, deb and rpm of $commit in the Ubuntu 22.04 image)"
    would "copy them to $linux_dir as Riggverk-v${version:-VERSION}-linux-x86_64.AppImage, Riggverk-v${version:-VERSION}-linux-amd64.deb and Riggverk-v${version:-VERSION}-linux-x86_64.rpm, and write $linux_dir/linux-build.json (version, commit, SHA-256)"
    finish_dry_run
    return
  fi

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-release.XXXXXX")"
  trap cleanup_build_linux EXIT
  trap 'exit 130' INT TERM
  build_dir="$tmp_dir/build"

  step "build"
  scripts/linux-build.sh --out "$build_dir"

  step "release files"
  rm -rf "$linux_dir"
  mkdir -p "$linux_dir"
  cp "$build_dir/Riggverk_${version}_amd64.AppImage" "$linux_dir/Riggverk-v$version-linux-x86_64.AppImage"
  cp "$build_dir/Riggverk_${version}_amd64.deb" "$linux_dir/Riggverk-v$version-linux-amd64.deb"
  cp "$build_dir/Riggverk-${version}-1.x86_64.rpm" "$linux_dir/Riggverk-v$version-linux-x86_64.rpm"
  python3 scripts/release_tools.py linux-stamp write --dir "$linux_dir" --version "$version" --commit "$commit"
  ls -l "$linux_dir" | sed '1d; s/^/  /'

  printf '\nNext: copy %s to %s in the checkout on the Mac (at the same commit), then run ./scripts/release.sh publish there.\n' \
    "$linux_dir" "$linux_dir"
}

case "${1:-}" in
  prepare)
    shift
    cmd_prepare "$@"
    ;;
  build-linux)
    shift
    cmd_build_linux "$@"
    ;;
  publish)
    shift
    cmd_publish "$@"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
