#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="${1:?TypeScript entry file required}"
# The bundle must sit exactly one level below the repo root (like scripts/): the
# checks resolve the repo root from their own file location (`dirname/..`), and
# node resolves their imports from there. BSD mktemp (macOS) does not randomise a
# template with a suffix, so create a unique directory and use a fixed file name.
output_dir="$(mktemp -d "$root/.riggverk-ts-check.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
output="$output_dir/check.mjs"

"$root/node_modules/.bin/rolldown" "$root/$entry" \
  --platform=node \
  --format=esm \
  --log-level=warn \
  --file="$output"
node "$output"
