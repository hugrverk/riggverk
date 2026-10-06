#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="${1:?TypeScript entry file required}"
# The bundle must live inside the repo so node resolves its imports. BSD mktemp
# (macOS) does not randomise a template with a suffix, so create a unique
# directory and use a fixed file name inside it.
output_dir="$(mktemp -d "$root/scripts/.agent-workspace-ts-check.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
output="$output_dir/check.mjs"

"$root/node_modules/.bin/rolldown" "$root/$entry" \
  --platform=node \
  --format=esm \
  --log-level=warn \
  --file="$output"
node "$output"
