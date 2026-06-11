#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="${1:?TypeScript entry file required}"
output="$(mktemp "$root/scripts/.agent-workspace-ts-check.XXXXXX.mjs")"
trap 'rm -f "$output"' EXIT

"$root/node_modules/.bin/esbuild" "$root/$entry" \
  --bundle \
  --platform=node \
  --format=esm \
  --log-level=warning \
  --outfile="$output"
node "$output"
