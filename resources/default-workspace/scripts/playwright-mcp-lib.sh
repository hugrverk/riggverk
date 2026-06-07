#!/usr/bin/env bash
# Shared Playwright MCP path and render helpers. Source from install-opencode-config.sh.

PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.48}"

default_playwright_browsers_path() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      printf '%s/Library/Caches/ms-playwright' "${HOME:?}"
      ;;
    Linux)
      printf '%s/ms-playwright' "${XDG_CACHE_HOME:-${HOME:?}/.cache}"
      ;;
    *)
      return 1
      ;;
  esac
}

default_playwright_mcp_config_path() {
  if [ -n "${PLAYWRIGHT_MCP_CONFIG_PATH:-}" ]; then
    printf '%s' "$PLAYWRIGHT_MCP_CONFIG_PATH"
    return 0
  fi
  printf '%s/.config/playwright-mcp/config.json' "${HOME:?}"
}

playwright_mcp_package() {
  printf '@playwright/mcp@%s' "$PLAYWRIGHT_MCP_VERSION"
}

resolve_playwright_paths() {
  if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    PLAYWRIGHT_BROWSERS_PATH_RESOLVED="$PLAYWRIGHT_BROWSERS_PATH"
  elif browsers_path="$(default_playwright_browsers_path 2>/dev/null)"; then
    PLAYWRIGHT_BROWSERS_PATH_RESOLVED="$browsers_path"
  else
    return 1
  fi
  PLAYWRIGHT_MCP_CONFIG_PATH_RESOLVED="$(default_playwright_mcp_config_path)"
  return 0
}

render_json_with_playwright_paths() {
  local src="$1"
  local dst="$2"
  local config_path="$3"
  local browsers_path="$4"
  local version="$5"
  "$AW_PYTHON" - "$src" "$dst" "$config_path" "$browsers_path" "$version" <<'PY'
import json
import sys

src, dst, config_path, browsers_path, version = sys.argv[1:6]
package = f"@playwright/mcp@{version}"

def transform(value):
    if isinstance(value, dict):
        return {key: transform(item) for key, item in value.items()}
    if isinstance(value, list):
        return [transform(item) for item in value]
    if isinstance(value, str):
        if value == "__PLAYWRIGHT_MCP_CONFIG_PATH__":
            return config_path
        if value == "__PLAYWRIGHT_BROWSERS_PATH__":
            return browsers_path
        if value.startswith("@playwright/mcp@"):
            return package
        return value
    return value

with open(src, encoding="utf-8") as handle:
    data = transform(json.load(handle))

with open(dst, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
}

merge_cursor_playwright_mcp() {
  local template="$1"
  local target="$2"
  local config_path="$3"
  local browsers_path="$4"
  local version="$5"
  "$AW_PYTHON" - "$template" "$target" "$config_path" "$browsers_path" "$version" <<'PY'
import json
import sys
from pathlib import Path

template_path, target_path, config_path, browsers_path, version = sys.argv[1:6]
package = f"@playwright/mcp@{version}"

with open(template_path, encoding="utf-8") as handle:
    template = json.load(handle)

playwright_entry = template.get("mcpServers", {}).get("playwright", {})
playwright_entry = json.loads(json.dumps(playwright_entry))

def transform(value):
    if isinstance(value, dict):
        return {key: transform(item) for key, item in value.items()}
    if isinstance(value, list):
        return [transform(item) for item in value]
    if isinstance(value, str):
        if value == "__PLAYWRIGHT_MCP_CONFIG_PATH__":
            return config_path
        if value == "__PLAYWRIGHT_BROWSERS_PATH__":
            return browsers_path
        if value.startswith("@playwright/mcp@"):
            return package
        return value
    return value

playwright_entry = transform(playwright_entry)

target = Path(target_path)
if target.is_file():
    with target.open(encoding="utf-8") as handle:
        data = json.load(handle)
else:
    data = {}

servers = data.setdefault("mcpServers", {})
servers["playwright"] = playwright_entry

with target.open("w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
}
