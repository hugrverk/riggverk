#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failed=0

fail() {
  printf 'FAIL %s\n' "$1" >&2
  failed=1
}

pass() {
  printf 'PASS %s\n' "$1"
}

exclude=(--glob '!**/check-playwright-mcp.sh')

search_has_match() {
  local pattern="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  if command -v rg >/dev/null 2>&1; then
    rg -n "${exclude[@]}" -e "$pattern" "$@" >"$tmp" || true
  else
    find "$@" -type f ! -name check-playwright-mcp.sh \
      -exec grep -n -E -e "$pattern" /dev/null {} \; \
      >"$tmp" || true
  fi
  if [ -s "$tmp" ]; then
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

if search_has_match '@playwright/mcp@latest' "$repo_root/templates" "$repo_root/scripts"; then
  fail '@playwright/mcp@latest found in templates/scripts'
else
  pass 'no @playwright/mcp@latest in templates/scripts'
fi

if search_has_match '--browser=chrome' "$repo_root/templates" "$repo_root/scripts"; then
  fail '--browser=chrome found in templates/scripts'
else
  pass 'no --browser=chrome in templates/scripts'
fi

if search_has_match 'PLAYWRIGHT_BROWSERS_PATH=0' "$repo_root/templates" "$repo_root/scripts"; then
  fail 'PLAYWRIGHT_BROWSERS_PATH=0 found in templates/scripts'
else
  pass 'no PLAYWRIGHT_BROWSERS_PATH=0 in templates/scripts'
fi

if search_has_match '/Users/ulviux' "$repo_root/templates" "$repo_root/scripts"; then
  fail 'hardcoded /Users/ulviux path found in templates/scripts'
else
  pass 'no hardcoded /Users/ulviux paths in templates/scripts'
fi

if ! python3 -m json.tool "$repo_root/templates/playwright-mcp.config.json" >/dev/null; then
  fail 'templates/playwright-mcp.config.json invalid json'
else
  pass 'templates/playwright-mcp.config.json valid json'
fi

if ! grep -q -E -e '"browserName"[[:space:]]*:[[:space:]]*"chromium"' "$repo_root/templates/playwright-mcp.config.json"; then
  fail 'playwright MCP config must default browserName to chromium'
else
  pass 'playwright MCP config uses chromium'
fi

exit "$failed"
