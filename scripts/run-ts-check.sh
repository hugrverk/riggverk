#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="${1:?TypeScript entry file required}"
output="$(mktemp "$root/scripts/.agent-workspace-ts-check.XXXXXX.mjs")"
trap 'rm -f "$output"' EXIT

"$root/node_modules/.bin/rolldown" "$root/$entry" \
  --platform=node \
  --format=esm \
  --log-level=warn \
  --file="$output"
node "$output"
