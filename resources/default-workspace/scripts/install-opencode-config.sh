#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/playwright-mcp-lib.sh
. "$WORKSPACE_ROOT/scripts/playwright-mcp-lib.sh"

SOURCE_FILE="$WORKSPACE_ROOT/templates/opencode.json"
TUI_SOURCE_FILE="$WORKSPACE_ROOT/templates/tui.json"
AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/agents"
PLAYWRIGHT_MCP_SOURCE="$WORKSPACE_ROOT/templates/playwright-mcp.config.json"
PLAYWRIGHT_MCP_TARGET=""
CURSOR_MCP_TARGET="${CURSOR_MCP_CONFIG_PATH:-$HOME/.cursor/mcp.json}"
CURSOR_MCP_TEMPLATE="$WORKSPACE_ROOT/templates/cursor/mcp/playwright.mcp.json"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-opencode-config.sh [options]

Sync OpenCode config, TUI config, and agents from the workspace to the OpenCode config path.

Config:  templates/opencode.json  ->  ~/.config/opencode/opencode.json
TUI:     templates/tui.json       ->  ~/.config/opencode/tui.json
Agents:  agents/*.md              ->  ~/.config/opencode/agents/*.md

Options:
  --apply          Write target files
  --apply-cursor   With --apply, merge Playwright MCP into ~/.cursor/mcp.json
  --cursor         Alias for --apply-cursor
  --diff           Show diff without writing
  --agents-only    Diff or sync bundled agents only (skip config and TUI)
  --config-only    Diff or sync config and TUI only (skip agents)
  --quiet          Print compact app-friendly output
  --help           Show this help

Environment override:
  OPENCODE_CONFIG_PATH
  OPENCODE_TUI_CONFIG_PATH
  OPENCODE_AGENTS_DIR
  PLAYWRIGHT_MCP_VERSION
  PLAYWRIGHT_MCP_CONFIG_PATH
  PLAYWRIGHT_BROWSERS_PATH
  CURSOR_MCP_CONFIG_PATH
  AGENT_WORKSPACE_BACKUP_DIR

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -f "$SOURCE_FILE" ]; then
  printf 'install-opencode-config.sh: source file not found: %s\n' "$SOURCE_FILE" >&2
  exit 1
fi

if [ ! -f "$TUI_SOURCE_FILE" ]; then
  printf 'install-opencode-config.sh: TUI source file not found: %s\n' "$TUI_SOURCE_FILE" >&2
  exit 1
fi

if [ ! -f "$PLAYWRIGHT_MCP_SOURCE" ]; then
  printf 'install-opencode-config.sh: Playwright MCP template not found: %s\n' "$PLAYWRIGHT_MCP_SOURCE" >&2
  exit 1
fi

if [ ! -f "$CURSOR_MCP_TEMPLATE" ]; then
  printf 'install-opencode-config.sh: Cursor Playwright MCP template not found: %s\n' "$CURSOR_MCP_TEMPLATE" >&2
  exit 1
fi

if ! resolve_playwright_paths; then
  printf 'install-opencode-config.sh: unable to derive PLAYWRIGHT_BROWSERS_PATH on this platform; set PLAYWRIGHT_BROWSERS_PATH (see docs/OPENCODE_CONFIG.md)\n' >&2
  exit 1
fi
PLAYWRIGHT_MCP_TARGET="$PLAYWRIGHT_MCP_CONFIG_PATH_RESOLVED"

rendered_opencode="$(mktemp)"
trap 'rm -f "$rendered_opencode"' EXIT
render_json_with_playwright_paths \
  "$SOURCE_FILE" \
  "$rendered_opencode" \
  "$PLAYWRIGHT_MCP_CONFIG_PATH_RESOLVED" \
  "$PLAYWRIGHT_BROWSERS_PATH_RESOLVED" \
  "$PLAYWRIGHT_MCP_VERSION"

apply=false
apply_cursor=false
diff_mode=false
quiet=false
agents_only=false
config_only=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --apply-cursor|--cursor) apply_cursor=true ;;
    --diff) diff_mode=true ;;
    --agents-only) agents_only=true ;;
    --config-only) config_only=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    *)
      printf 'install-opencode-config.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if $agents_only && $config_only; then
  printf 'install-opencode-config.sh: --agents-only and --config-only are mutually exclusive\n' >&2
  exit 1
fi

should_sync_config() {
  ! $agents_only
}

should_sync_agents() {
  ! $config_only
}

backup_root() {
  if [ -n "${AGENT_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
  else
    printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"

case "$BACKUP_ROOT" in
  /|"$HOME"|"") printf 'install-opencode-config.sh: refusing broad backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

TARGET="${OPENCODE_CONFIG_PATH:-$HOME/.config/opencode/opencode.json}"
TUI_TARGET="${OPENCODE_TUI_CONFIG_PATH:-$HOME/.config/opencode/tui.json}"
TARGET_AGENTS_DIR="${OPENCODE_AGENTS_DIR:-$HOME/.config/opencode/agents}"

# Refuse unsafe target agents directories
case "$TARGET_AGENTS_DIR" in
  /|"$HOME"|"$HOME/"*)
    if [ "$TARGET_AGENTS_DIR" = "/" ] || [ "$TARGET_AGENTS_DIR" = "$HOME" ] || [ "$TARGET_AGENTS_DIR" = "$HOME/" ]; then
      printf 'install-opencode-config.sh: refusing unsafe OPENCODE_AGENTS_DIR: %s\n' "$TARGET_AGENTS_DIR" >&2
      exit 1
    fi
    ;;
esac

# Refuse empty TARGET_AGENTS_DIR
if [ -z "$TARGET_AGENTS_DIR" ]; then
  printf 'install-opencode-config.sh: refusing empty OPENCODE_AGENTS_DIR\n' >&2
  exit 1
fi

validate_json() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$1" >/dev/null 2>&1
  fi
}

# ── Agent file helpers ──

# Lists agent source files, one per line.
# Handles spaces in filenames correctly via NUL-delimited find + tr.
# Does NOT handle newlines in filenames (line-based consumers would break).
list_agent_files() {
  if [ -d "$AGENTS_SOURCE_DIR" ]; then
    find "$AGENTS_SOURCE_DIR" -maxdepth 1 -name '*.md' -type f -print0 | sort -z | tr '\0' '\n'
  fi
}

agent_count() {
  list_agent_files | wc -l | tr -d ' '
}

agent_basename() {
  basename "$1"
}

# ── Header ──

if ! $quiet; then
  printf '\nOpenCode Config + TUI + Agents Sync\n'
  printf '  Config source: %s\n' "$SOURCE_FILE"
  printf '  Config target: %s\n' "$TARGET"
  printf '  TUI source: %s\n' "$TUI_SOURCE_FILE"
  printf '  TUI target: %s\n' "$TUI_TARGET"
  printf '  Agents source: %s\n' "$AGENTS_SOURCE_DIR"
  printf '  Agents target: %s\n' "$TARGET_AGENTS_DIR"
  printf '  Bundled agents: %s\n' "$(agent_count)"
  if $diff_mode; then
    printf '  Mode: diff\n'
  elif $apply; then
    printf '  Mode: apply\n'
    printf '  Backups: %s\n' "$BACKUP_ROOT"
  else
    printf '  Mode: dry-run\n'
  fi
fi

# ── Diff mode ──

if $diff_mode; then
  has_diffs=false

  # Config diffs
  if should_sync_config && [ -f "$TARGET" ]; then
    if ! cmp -s "$rendered_opencode" "$TARGET"; then
      printf '\n--- opencode config diffs (%s)\n' "$TARGET"
      diff -u "$TARGET" "$rendered_opencode" || true
      has_diffs=true
    fi
  elif should_sync_config; then
    printf '\n--- opencode config missing (no target file at %s)\n' "$TARGET"
    has_diffs=true
  fi

  if should_sync_config && [ -f "$PLAYWRIGHT_MCP_TARGET" ]; then
    if ! cmp -s "$PLAYWRIGHT_MCP_SOURCE" "$PLAYWRIGHT_MCP_TARGET"; then
      printf '\n--- playwright mcp config diffs (%s)\n' "$PLAYWRIGHT_MCP_TARGET"
      diff -u "$PLAYWRIGHT_MCP_TARGET" "$PLAYWRIGHT_MCP_SOURCE" || true
      has_diffs=true
    fi
  elif should_sync_config; then
    printf '\n--- playwright mcp config missing (no target file at %s)\n' "$PLAYWRIGHT_MCP_TARGET"
    has_diffs=true
  fi

  if should_sync_config && [ -f "$TUI_TARGET" ]; then
    if ! cmp -s "$TUI_SOURCE_FILE" "$TUI_TARGET"; then
      printf '\n--- tui config diffs (%s)\n' "$TUI_TARGET"
      diff -u "$TUI_TARGET" "$TUI_SOURCE_FILE" || true
      has_diffs=true
    fi
  elif should_sync_config; then
    printf '\n--- tui config missing (no target file at %s)\n' "$TUI_TARGET"
    has_diffs=true
  fi

  # Agent diffs (shared runtime installer)
  if should_sync_agents; then
    agent_args=(--opencode --diff)
    if $quiet; then agent_args+=(--quiet); fi
    if ! OPENCODE_AGENTS_DIR="$TARGET_AGENTS_DIR" AGENT_WORKSPACE_BACKUP_DIR="$BACKUP_ROOT" \
      bash "$WORKSPACE_ROOT/scripts/install-runtime-agents.sh" "${agent_args[@]}"; then
      has_diffs=true
    fi
  fi

  if ! $has_diffs; then
    if ! $quiet; then
      if $agents_only; then
        printf '  opencode agents synced\n'
      elif $config_only; then
        printf '  opencode config + tui synced\n'
      else
        printf '  opencode config + tui + agents synced\n'
      fi
    fi
  fi
  exit 0
fi

# ── Apply mode ──

if $apply; then
  # Validate config JSONs
  if should_sync_config; then
  validate_json "$rendered_opencode" || {
    printf 'install-opencode-config.sh: rendered opencode JSON is invalid\n' >&2
    exit 1
  }
  validate_json "$TUI_SOURCE_FILE" || {
    printf 'install-opencode-config.sh: TUI source JSON is invalid\n' >&2
    exit 1
  }
  validate_json "$PLAYWRIGHT_MCP_SOURCE" || {
    printf 'install-opencode-config.sh: Playwright MCP template JSON is invalid\n' >&2
    exit 1
  }
  fi

  if should_sync_config && [ -f "$PLAYWRIGHT_MCP_TARGET" ]; then
    if cmp -s "$PLAYWRIGHT_MCP_SOURCE" "$PLAYWRIGHT_MCP_TARGET"; then
      if ! $quiet; then printf '  playwright mcp config already synced\n'; fi
    else
      ts="$(date -u +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_ROOT/$ts/playwright-mcp"
      mkdir -p "$backup_dir"
      cp "$PLAYWRIGHT_MCP_TARGET" "$backup_dir/config.json"
      if ! $quiet; then printf '  playwright mcp config backed up to %s/config.json\n' "$backup_dir"; fi
      mkdir -p "$(dirname "$PLAYWRIGHT_MCP_TARGET")"
      cp "$PLAYWRIGHT_MCP_SOURCE" "$PLAYWRIGHT_MCP_TARGET"
      if ! $quiet; then printf '  playwright mcp config synced\n'; fi
    fi
  elif should_sync_config; then
    mkdir -p "$(dirname "$PLAYWRIGHT_MCP_TARGET")"
    if ! $quiet; then printf '  playwright mcp config creating new\n'; fi
    cp "$PLAYWRIGHT_MCP_SOURCE" "$PLAYWRIGHT_MCP_TARGET"
    if ! $quiet; then printf '  playwright mcp config synced\n'; fi
  fi

  if should_sync_config && $apply_cursor; then
    if [ -f "$CURSOR_MCP_TARGET" ]; then
      ts="$(date -u +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_ROOT/$ts/cursor-mcp"
      mkdir -p "$backup_dir"
      cp "$CURSOR_MCP_TARGET" "$backup_dir/mcp.json"
      if ! $quiet; then printf '  cursor mcp backed up to %s/mcp.json\n' "$backup_dir"; fi
    fi
    mkdir -p "$(dirname "$CURSOR_MCP_TARGET")"
    merge_cursor_playwright_mcp \
      "$CURSOR_MCP_TEMPLATE" \
      "$CURSOR_MCP_TARGET" \
      "$PLAYWRIGHT_MCP_CONFIG_PATH_RESOLVED" \
      "$PLAYWRIGHT_BROWSERS_PATH_RESOLVED" \
      "$PLAYWRIGHT_MCP_VERSION"
    validate_json "$CURSOR_MCP_TARGET" || {
      printf 'install-opencode-config.sh: Cursor MCP JSON is invalid after merge\n' >&2
      exit 1
    }
    if ! $quiet; then printf '  cursor mcp updated (playwright server only)\n'; fi
  fi

  # ── Apply config ──
  if should_sync_config && [ -f "$TARGET" ]; then
    if cmp -s "$rendered_opencode" "$TARGET"; then
      if ! $quiet; then printf '  opencode config already synced\n'; fi
    else
      ts="$(date -u +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_ROOT/$ts/opencode-config"
      mkdir -p "$backup_dir"
      backup_file="$backup_dir/opencode.json"
      cp "$TARGET" "$backup_file"
      if ! $quiet; then printf '  opencode config backed up to %s\n' "$backup_file"; fi
      cp "$rendered_opencode" "$TARGET"
      if ! $quiet; then printf '  opencode config synced\n'; fi
    fi
  elif should_sync_config; then
    mkdir -p "$(dirname "$TARGET")"
    if ! $quiet; then printf '  opencode config creating new\n'; fi
    cp "$rendered_opencode" "$TARGET"
    if ! $quiet; then printf '  opencode config synced\n'; fi
  fi

  # ── Apply TUI config ──
  if should_sync_config && [ -f "$TUI_TARGET" ]; then
    if cmp -s "$TUI_SOURCE_FILE" "$TUI_TARGET"; then
      if ! $quiet; then printf '  tui config already synced\n'; fi
    else
      ts="$(date -u +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_ROOT/$ts/opencode-config"
      mkdir -p "$backup_dir"
      tui_backup_file="$backup_dir/tui.json"
      cp "$TUI_TARGET" "$tui_backup_file"
      if ! $quiet; then printf '  tui config backed up to %s\n' "$tui_backup_file"; fi
      cp "$TUI_SOURCE_FILE" "$TUI_TARGET"
      if ! $quiet; then printf '  tui config synced\n'; fi
    fi
  elif should_sync_config; then
    mkdir -p "$(dirname "$TUI_TARGET")"
    if ! $quiet; then printf '  tui config creating new\n'; fi
    cp "$TUI_SOURCE_FILE" "$TUI_TARGET"
    if ! $quiet; then printf '  tui config synced\n'; fi
  fi

  # ── Apply agents (shared runtime installer) ──
  if should_sync_agents; then
    agent_args=(--opencode --apply)
    if $quiet; then agent_args+=(--quiet); fi
    OPENCODE_AGENTS_DIR="$TARGET_AGENTS_DIR" AGENT_WORKSPACE_BACKUP_DIR="$BACKUP_ROOT" \
      bash "$WORKSPACE_ROOT/scripts/install-runtime-agents.sh" "${agent_args[@]}"
  fi

  if ! $quiet; then
    if $agents_only; then
      printf '  opencode %s agents synced\n' "$(agent_count)"
    elif $config_only; then
      printf '  opencode config + tui synced\n'
    else
      printf '  opencode config + tui + %s agents synced\n' "$(agent_count)"
    fi
  fi
  exit 0
fi

# ── Dry-run mode ──

all_synced=true

# Config check
if should_sync_config && [ -f "$TARGET" ]; then
  if cmp -s "$rendered_opencode" "$TARGET"; then
    if ! $quiet; then printf '  opencode config synced\n'; fi
  else
    if ! $quiet; then printf '  opencode config diverged (use --apply to sync)\n'; fi
    all_synced=false
  fi
elif should_sync_config; then
  if ! $quiet; then printf '  opencode config missing (use --apply to create)\n'; fi
  all_synced=false
fi

if should_sync_config && [ -f "$PLAYWRIGHT_MCP_TARGET" ]; then
  if cmp -s "$PLAYWRIGHT_MCP_SOURCE" "$PLAYWRIGHT_MCP_TARGET"; then
    if ! $quiet; then printf '  playwright mcp config synced\n'; fi
  else
    if ! $quiet; then printf '  playwright mcp config diverged (use --apply to sync)\n'; fi
    all_synced=false
  fi
elif should_sync_config; then
  if ! $quiet; then printf '  playwright mcp config missing (use --apply to create)\n'; fi
  all_synced=false
fi

# TUI config check
if should_sync_config && [ -f "$TUI_TARGET" ]; then
  if cmp -s "$TUI_SOURCE_FILE" "$TUI_TARGET"; then
    if ! $quiet; then printf '  tui config synced\n'; fi
  else
    if ! $quiet; then printf '  tui config diverged (use --apply to sync)\n'; fi
    all_synced=false
  fi
elif should_sync_config; then
  if ! $quiet; then printf '  tui config missing (use --apply to create)\n'; fi
  all_synced=false
fi

# Agent checks (shared runtime installer dry-run)
if should_sync_agents; then
  agent_args=(--opencode)
  if $quiet; then agent_args+=(--quiet); fi
  if ! OPENCODE_AGENTS_DIR="$TARGET_AGENTS_DIR" AGENT_WORKSPACE_BACKUP_DIR="$BACKUP_ROOT" \
    bash "$WORKSPACE_ROOT/scripts/install-runtime-agents.sh" "${agent_args[@]}"; then
    all_synced=false
  fi
fi

if $all_synced; then
  if $agents_only; then
    if should_sync_agents && [ -d "$TARGET_AGENTS_DIR" ]; then
      if ! $quiet; then printf '  opencode %s agents synced\n' "$(agent_count)"; fi
    fi
  elif $config_only; then
    if should_sync_config && [ -f "$TARGET" ]; then
      if ! $quiet; then printf '  opencode config + tui synced\n'; fi
    fi
  elif [ -f "$TARGET" ]; then
    if ! $quiet; then printf '  opencode config + tui + %s agents synced\n' "$(agent_count)"; fi
  fi
fi
