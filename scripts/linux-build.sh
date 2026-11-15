#!/usr/bin/env bash
# Builds the Linux release packages (AppImage, deb, rpm) of the committed HEAD in an Ubuntu 22.04 container.
#
#   scripts/linux-build.sh [--out DIR]   default DIR: release/linux-build
#
# DIR must be new, empty or hold only earlier *.AppImage, *.deb and *.rpm files, which are replaced: podman relabels
# it for SELinux (:Z), and nothing else may be deleted or relabeled.
#
# Needs rootless podman on a Linux x86_64 host. The container gets `git archive HEAD`, never the working tree, so
# uncommitted changes and old build output cannot reach the packages; a clean tree is required so the packages are
# exactly the commit printed at the end. Cargo, npm and the Tauri bundler tools are cached in podman volumes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

out_dir="release/linux-build"
image="riggverk-linux-build"
# glibc of the base image: the binary must need nothing newer.
glibc_floor="2.35"

step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      [ "$#" -ge 2 ] || fail "--out needs a directory"
      out_dir="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1 (usage: scripts/linux-build.sh [--out DIR])"
      ;;
  esac
done

[ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] || fail "run this on a Linux x86_64 host"
command -v podman >/dev/null 2>&1 || fail "podman is needed"
[ "$(podman info --format '{{.Host.Security.Rootless}}')" = "true" ] || fail "rootless podman is needed (run without sudo)"
# Separate from the test so a failing git status stops the script instead of reading as a clean tree.
status="$(git status --porcelain)"
[ -z "$status" ] || fail "the working tree has uncommitted changes; the packages are built from HEAD"

commit="$(git rev-parse HEAD)"
version="$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"

step "build image $image"
podman build --quiet --tag "$image" --file scripts/linux-build.Containerfile scripts >/dev/null

step "build Riggverk $version ($commit) in the container"
mkdir -p "$out_dir"
other="$(find "$out_dir" -mindepth 1 -maxdepth 1 ! \( -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \) -print -quit)"
[ -z "$other" ] || fail "$out_dir holds $other; pass a new or empty directory to --out"
rm -f "$out_dir"/*.AppImage "$out_dir"/*.deb "$out_dir"/*.rpm
# scripts/linux-build-inside.sh (in the image) unpacks the commit, builds the three bundles, checks them and copies them to /out.
git archive --format=tar "$commit" | podman run --rm --interactive \
  --env GLIBC_FLOOR="$glibc_floor" \
  --volume "$(cd "$out_dir" && pwd)":/out:Z \
  --volume riggverk-linux-cargo-registry:/usr/local/cargo/registry \
  --volume riggverk-linux-npm-cache:/root/.npm \
  --volume riggverk-linux-tauri-cache:/root/.cache/tauri \
  "$image" riggverk-linux-build

step "packages"
shopt -s nullglob
packages=("$out_dir"/*.AppImage "$out_dir"/*.deb "$out_dir"/*.rpm)
[ "${#packages[@]}" -eq 3 ] || fail "expected one AppImage, one deb and one rpm in $out_dir"
for package in "${packages[@]}"; do
  case "$(basename "$package")" in
    *"$version"*) printf '  %s\n' "$package" ;;
    *) fail "$package does not carry version $version" ;;
  esac
done
printf '  built from %s\n' "$commit"
