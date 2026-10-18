#!/usr/bin/env bash
# Local macOS release flow (no CI). See docs/RELEASE.md.
#
#   scripts/release.sh prepare [--dry-run] [--since REV]   next CalVer version, notes draft, bump, release check, PR
#   scripts/release.sh publish [--dry-run] [--allow-newer] build, ad hoc sign, zip, tag and GitHub release
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
  scripts/release.sh publish [--dry-run] [--allow-newer]
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
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  if [ "$status" -ne 0 ] && [ "$stage" = "tagged" ]; then
    printf '\npublish failed after the tag v%s was created. To retry from a clean slate:\n' "$version" >&2
    printf '  git push origin --delete v%s; git tag -d v%s\n' "$version" "$version" >&2
    printf 'If the release exists on GitHub: gh release delete v%s --cleanup-tag --yes\n' "$version" >&2
  fi
  exit "$status"
}

app_bundle="${CARGO_TARGET_DIR:-$repo_root/src-tauri/target}/release/bundle/macos/Riggverk.app"

build_app() {
  rm -rf "$app_bundle"
  npm run tauri build -- --bundles app
  [ -d "$app_bundle" ] || fail "the build did not produce $app_bundle"
  local built
  built="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_bundle/Contents/Info.plist")"
  [ "$built" = "$version" ] || fail "the bundle reports version $built, expected $version"
  info "built Riggverk.app $built"
}

sign_app() {
  local details
  codesign --force --deep --sign - "$app_bundle"
  codesign --verify --deep --strict "$app_bundle"
  details="$(codesign --display --verbose=2 "$app_bundle" 2>&1)"
  case "$details" in
    *"Signature=adhoc"*) ;;
    *) fail "the bundle is not ad hoc signed" ;;
  esac
  info "ad hoc signed and verified"
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
  info "$zip_file ($(du -h "$zip_file" | cut -f1)), sha256 $(shasum -a 256 "$zip_file" | cut -d' ' -f1)"
}

create_release() {
  local url
  git tag -a "v$version" -m "Riggverk $version"
  stage="tagged"
  git push --quiet origin "refs/tags/v$version"
  url="$(gh release create "v$version" "$zip_file" --title "Riggverk $version" --notes-file "$notes_file" --verify-tag)"
  stage="released"
  printf '\nReleased: %s\n' "$url"
}

cmd_publish() {
  local allow_newer=0 head_message
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --allow-newer) allow_newer=1 ;;
      *) usage >&2; fail "unknown option for publish: $1" ;;
    esac
    shift
  done

  step "preflight"
  require_python
  require_tools git gh npm codesign ditto
  require_gh_login
  [ -e node_modules ] || problem "node_modules is missing (npm ci)"
  require_clean_main

  step "version and notes"
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
      *"release/v$version"* | *"chore(release): $version"*) info "checked: main ends with the merge of the release PR" ;;
      *)
        if [ "$allow_newer" -eq 1 ]; then
          info "main has moved past the release PR (--allow-newer)"
        else
          problem "main does not end with the release PR for $version, so the notes may not cover what is built (--allow-newer to build anyway)"
        fi
        ;;
    esac
  fi

  zip_file="release/Riggverk-v${version:-VERSION}-macOS.zip"
  if [ "$dry_run" -eq 1 ]; then
    step "release"
    would "build: npm run tauri build -- --bundles app (expects $app_bundle)"
    would "ad hoc sign and verify: codesign --force --deep --sign - $app_bundle"
    would "zip: ditto -c -k --keepParent $app_bundle $zip_file, then verify the signature inside the zip"
    would "tag: git tag -a v${version:-VERSION} -m 'Riggverk ${version:-VERSION}', then git push origin refs/tags/v${version:-VERSION}"
    would "release: gh release create v${version:-VERSION} $zip_file --title 'Riggverk ${version:-VERSION}' --notes-file ${notes_file:-release-notes/VERSION.md} --verify-tag"
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
  step "tag and GitHub release"
  create_release
}

case "${1:-}" in
  prepare)
    shift
    cmd_prepare "$@"
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
