#!/usr/bin/env bash
# Runs inside the image of scripts/linux-build.Containerfile; started by scripts/linux-build.sh, not by hand.
# Reads `git archive HEAD` on stdin, builds the AppImage, deb and rpm, checks them and copies them to /out.
set -euo pipefail

glibc_floor="${GLIBC_FLOOR:?}"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir /src
tar -x -C /src
cd /src
npm ci --no-audit --no-fund
npm run tauri build -- --bundles appimage,deb,rpm -- --locked </dev/null

bundle="src-tauri/target/release/bundle"
appdir="$bundle/appimage/Riggverk.AppDir"
binaries="$(ls "$appdir/usr/bin")"
[ "$binaries" = "riggverk" ] || fail "the AppDir holds $binaries instead of riggverk alone"
diff -rq resources/default-workspace "$appdir/usr/lib/Riggverk/default-workspace" ||
  fail "the AppImage default-workspace differs from resources/default-workspace"

needed="$(objdump -T src-tauri/target/release/riggverk | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -n 1)"
[ "$(printf '%s\n%s\n' "$needed" "$glibc_floor" | sort -V | tail -n 1)" = "$glibc_floor" ] ||
  fail "the binary needs glibc $needed, newer than $glibc_floor"
printf '  binary needs glibc %s (floor %s)\n' "$needed" "$glibc_floor"

cp "$bundle"/appimage/*.AppImage "$bundle"/deb/*.deb "$bundle"/rpm/*.rpm /out/
