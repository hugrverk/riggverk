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

if rg -n "${exclude[@]}" '@playwright/mcp@latest' "$repo_root/templates" "$repo_root/scripts" >/dev/null 2>&1; then
  fail '@playwright/mcp@latest found in templates/scripts'
else
  pass 'no @playwright/mcp@latest in templates/scripts'
fi

if rg -n "${exclude[@]}" -- '--browser=chrome' "$repo_root/templates" "$repo_root/scripts" >/dev/null 2>&1; then
  fail '--browser=chrome found in templates/scripts'
else
  pass 'no --browser=chrome in templates/scripts'
fi

if rg -n "${exclude[@]}" 'PLAYWRIGHT_BROWSERS_PATH=0' "$repo_root/templates" "$repo_root/scripts" >/dev/null 2>&1; then
  fail 'PLAYWRIGHT_BROWSERS_PATH=0 found in templates/scripts'
else
  pass 'no PLAYWRIGHT_BROWSERS_PATH=0 in templates/scripts'
fi

if rg -n "${exclude[@]}" '/Users/ulviux' "$repo_root/templates" "$repo_root/scripts" >/dev/null 2>&1; then
  fail 'hardcoded /Users/ulviux path found in templates/scripts'
else
  pass 'no hardcoded /Users/ulviux paths in templates/scripts'
fi

if ! python3 -m json.tool "$repo_root/templates/playwright-mcp.config.json" >/dev/null; then
  fail 'templates/playwright-mcp.config.json invalid json'
else
  pass 'templates/playwright-mcp.config.json valid json'
fi

if ! rg -q '"browserName"[[:space:]]*:[[:space:]]*"chromium"' "$repo_root/templates/playwright-mcp.config.json"; then
  fail 'playwright MCP config must default browserName to chromium'
else
  pass 'playwright MCP config uses chromium'
fi

exit "$failed"
