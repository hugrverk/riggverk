#!/usr/bin/env bash
# Shared helpers for global Cursor profile diff/apply/validate.
# Source from install-cursor-workspace.sh after WORKSPACE_ROOT is set.

# shellcheck source=scripts/playwright-mcp-lib.sh
. "$WORKSPACE_ROOT/scripts/playwright-mcp-lib.sh"

CURSOR_GLOBAL_PROFILE_SOURCE="$WORKSPACE_ROOT/templates/cursor/global-profile.json"
CURSOR_PERMISSIONS_TEMPLATE="$WORKSPACE_ROOT/templates/cursor/permissions/global-playwright.json"
CURSOR_MCP_TEMPLATE="$WORKSPACE_ROOT/templates/cursor/mcp/playwright.mcp.json"
CURSOR_MANIFEST="$WORKSPACE_ROOT/templates/cursor/manifest.json"
CURSOR_AGENTS_SOURCE="$WORKSPACE_ROOT/templates/cursor/agents"
CURSOR_SKILLS_SOURCE="$WORKSPACE_ROOT/skills"
SKILLS_SCRIPT="$WORKSPACE_ROOT/scripts/install-skills.sh"

CURSOR_AGENTS_TARGET="${CURSOR_AGENTS_PATH:-$HOME/.cursor/agents}"
CURSOR_SKILLS_TARGET="${CURSOR_SKILLS_PATH:-$HOME/.cursor/skills}"
CURSOR_MCP_TARGET="${CURSOR_MCP_CONFIG_PATH:-$HOME/.cursor/mcp.json}"
CURSOR_PERMISSIONS_TARGET="${CURSOR_PERMISSIONS_PATH:-$HOME/.cursor/permissions.json}"

TERMINAL_ALLOWLIST_DENY_RE='^(npx|npm|node|playwright|chrome|chromium|google-chrome)(\s|$)'
MCP_ALLOWLIST_RUN_EVERYTHING='^\*:\*$'

validate_json_file() {
  python3 -m json.tool "$1" >/dev/null 2>&1
}

ensure_global_write_target() {
  local path="$1"
  local label="$2"
  [ -n "$path" ] || die "empty $label path"
  case "$path" in
    /|/Users|"$HOME"|"$HOME/") die "refusing broad $label path: $path" ;;
  esac
  case "$label" in
    mcp|permissions)
      case "$path" in
        "$HOME/.cursor/mcp.json"|"$HOME/.cursor/permissions.json") ;;
        *) die "refusing non-allowlisted $label path: $path" ;;
      esac
      ;;
    agents)
      case "$path" in
        "$HOME/.cursor/agents") ;;
        *) die "refusing non-allowlisted agents path: $path" ;;
      esac
      ;;
    skills)
      case "$path" in
        "$HOME/.cursor/skills") ;;
        *) die "refusing non-allowlisted skills path: $path" ;;
      esac
      ;;
    *) die "unknown global write label: $label" ;;
  esac
}

merge_cursor_permissions() {
  local template="$1"
  local target="$2"
  python3 - "$template" "$target" <<'PY'
import json
import sys
from pathlib import Path

template_path, target_path = sys.argv[1:3]
DOC_KEYS = {"notes", "description", "warnings", "validation_todo"}

with open(template_path, encoding="utf-8") as handle:
    template = json.load(handle)

managed_entries = [
    str(item)
    for item in template.get("mcpAllowlist", [])
    if isinstance(item, str)
]
if not managed_entries:
    raise SystemExit("permissions template missing mcpAllowlist entries")

target = Path(target_path)
if target.is_file():
    with target.open(encoding="utf-8") as handle:
        data = json.load(handle)
else:
    data = {}

existing = data.get("mcpAllowlist")
if existing is None:
    merged = list(dict.fromkeys(managed_entries))
elif isinstance(existing, list):
    merged = list(dict.fromkeys([*(str(x) for x in existing), *managed_entries]))
else:
    raise SystemExit("existing permissions mcpAllowlist must be an array")

data["mcpAllowlist"] = merged
# Never set terminalAllowlist from template — shell stays restricted / IDE-managed.

with target.open("w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
}

permissions_json_unsafe() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import re
import sys

path = sys.argv[1]
DOC_KEYS = {"notes", "description", "warnings", "validation_todo"}
AUTH_KEYS = re.compile(r"(api[_-]?key|apikey|token|secret|password|authorization|cookie)", re.I)
SUSPICIOUS = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+\S+|Basic\s+\S+)",
    re.I,
)
ENV_PLACEHOLDER = re.compile(r"^\$\{env:[A-Z0-9_]+\}$")
TERMINAL_DENY = {
    "npx",
    "npm",
    "node",
    "playwright",
    "chrome",
    "chromium",
    "google-chrome",
}


def walk(value, key=None):
    if isinstance(value, dict):
        for child_key, child in value.items():
            if child_key in DOC_KEYS:
                continue
            yield from walk(child, child_key)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item, key)
    else:
        yield key, value


with open(path, encoding="utf-8") as handle:
    data = json.load(handle)

for key, value in walk(data):
    if isinstance(value, str):
        if SUSPICIOUS.search(value):
            print("credential-like literal", file=sys.stderr)
            sys.exit(1)
        if key and AUTH_KEYS.search(str(key)) and not ENV_PLACEHOLDER.fullmatch(value):
            print("auth-like literal", file=sys.stderr)
            sys.exit(1)

mcp_allow = data.get("mcpAllowlist", [])
if isinstance(mcp_allow, list):
    for entry in mcp_allow:
        text = str(entry).strip().lower()
        if text in {"*:*", "*"}:
            print("run-everything mcp allowlist", file=sys.stderr)
            sys.exit(1)

terminal = data.get("terminalAllowlist")
if isinstance(terminal, list):
    for entry in terminal:
        text = str(entry).strip()
        lower = text.lower()
        first = lower.split(None, 1)[0] if lower else ""
        if first in TERMINAL_DENY or lower.startswith("*npx") or lower.startswith("*npm"):
            print("unsafe terminal allowlist entry", file=sys.stderr)
            sys.exit(1)
        if lower in {"*:*", "*"}:
            print("run-everything terminal allowlist", file=sys.stderr)
            sys.exit(1)

sys.exit(0)
PY
}

diff_permissions_status() {
  local template="$1"
  local target="$2"
  python3 - "$template" "$target" <<'PY'
import json
import sys
from pathlib import Path

template_path, target_path = sys.argv[1:3]
with open(template_path, encoding="utf-8") as handle:
    template = json.load(handle)
required = [str(x) for x in template.get("mcpAllowlist", []) if isinstance(x, str)]
target = Path(target_path)
if not target.is_file():
    print("missing")
    sys.exit(0)
with target.open(encoding="utf-8") as handle:
    data = json.load(handle)
existing = data.get("mcpAllowlist", [])
if not isinstance(existing, list):
    print("diverged")
    sys.exit(0)
existing_set = {str(x) for x in existing}
if all(item in existing_set for item in required):
    if set(required).issubset(existing_set):
        print("synced")
    else:
        print("partial")
else:
    print("diverged")
PY
}
