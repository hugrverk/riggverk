#!/usr/bin/env bash
set -euo pipefail

caller_dir="$PWD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_SOURCE="$WORKSPACE_ROOT/templates/cursor/agents"
RULES_SOURCE="$WORKSPACE_ROOT/templates/cursor/rules"
USER_RULES_SOURCE="$WORKSPACE_ROOT/templates/cursor/user-rules.md"
MCP_SOURCE="$WORKSPACE_ROOT/templates/cursor/mcp/playwright.mcp.json"
SANDBOX_SOURCE="$WORKSPACE_ROOT/templates/cursor/sandbox"

apply=false
quiet=false
global_agents=false
project_agents=false
project_rules=false
show_user_rules=false
copy_user_rules=false
open_cursor_settings=false
show_playwright_mcp=false
copy_playwright_mcp=false
show_sandbox_profile=""
copy_sandbox_profile=""
target=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-cursor-workspace.sh [options]

Options:
  --apply                  Write target files (default is dry-run)
  --global-agents          Install Cursor subagents to ${CURSOR_AGENTS_PATH:-$HOME/.cursor/agents}
  --project-agents         Install Cursor subagents to <target>/.cursor/agents
  --project-rules          Install project Cursor rules to <target>/.cursor/rules
  --project                Alias for --project-agents --project-rules
  --all                    Select all Cursor targets
  --target <path>          Target project path for project installs (default: current directory)
  --user-rules             Operate on Cursor User Rules (versioned copy, not auto-installed)
  --show-user-rules        Print the versioned Cursor User Rules file
  --copy-user-rules        Copy Cursor User Rules to clipboard (macOS only, uses pbcopy)
  --show-playwright-mcp    Print the versioned Playwright MCP template
  --copy-playwright-mcp    Copy Playwright MCP template to clipboard (macOS only)
  --show-sandbox-profile <safe|playwright-safe|playwright-full>
                           Print a versioned Cursor sandbox/profile template
  --copy-sandbox-profile <safe|playwright-safe|playwright-full>
                           Copy a sandbox/profile template to clipboard (macOS only)
  --open-cursor-settings   Open Cursor Settings in the app (macOS only)
  --quiet                  Print compact app-friendly output
  --help                   Show this help

Cursor User Rules are set in Cursor Settings > Rules > User Rules. This script
can show or copy the versioned rules file to clipboard but does not write to
undocumented Cursor internal storage paths. Sandbox/profile and MCP templates
are show/copy/manual only.
USAGE
}

die() {
  printf 'install-cursor-workspace.sh: %s\n' "$*" >&2
  exit 1
}

has_project_marker() {
  local dir="$1" marker
  for marker in .git package.json Cargo.toml composer.json pyproject.toml AGENTS.md .opencode .codex .cursor wp-content wordpress/wp-content; do
    [ -e "$dir/$marker" ] && return 0
  done
  return 1
}

validate_project_target() {
  local raw="$1"
  [ -d "$raw" ] || die "project target does not exist or is not a directory: $raw"
  local resolved home tmp_root slash_tmp
  resolved="$(cd "$raw" && pwd -P)"
  home="${HOME:?}"
  tmp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P || printf '%s' "${TMPDIR:-/tmp}")"
  slash_tmp="$(cd /tmp 2>/dev/null && pwd -P || printf '%s' /tmp)"
  for broad in / /Users "$home" "$home/Projects" "$tmp_root" "$slash_tmp"; do
    [ "$resolved" = "$broad" ] && die "refusing broad project target: $resolved"
  done
  has_project_marker "$resolved" || die "project target does not look like a project checkout: $resolved"
  printf '%s' "$resolved"
}

sandbox_profile_path() {
  case "$1" in
    safe|playwright-safe|playwright-full) printf '%s/%s.json' "$SANDBOX_SOURCE" "$1" ;;
    *) die "unknown sandbox profile: $1" ;;
  esac
}

ensure_dest_root() {
  local root="$1"
  [ -n "$root" ] || die "empty destination root"
  case "$root" in
    /|/Users|"$HOME"|"$HOME/") die "refusing broad destination root: $root" ;;
  esac
}

ensure_child() {
  local root="$1" child="$2"
  [ "$child" = "$root" ] && die "refusing destination root as child"
  case "$child" in "$root"/*) ;; *) die "destination outside root: $child" ;; esac
}

backup_root() {
  if [ -n "${AGENT_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
  else
    printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"
case "$BACKUP_ROOT" in /|"$HOME"|"") die "refusing broad backup root: $BACKUP_ROOT" ;; esac
backup_timestamp="$(date -u +%Y%m%d-%H%M%S)"

backup_file() {
  local path="$1" label="$2"
  [ -f "$path" ] || return 0
  local backup_dir="$BACKUP_ROOT/$backup_timestamp/$label"
  mkdir -p "$backup_dir"
  cp "$path" "$backup_dir/$(basename "$path")"
}

install_agents() {
  local dest_root="$1" label="$2"
  local count=0 source name dest
  ensure_dest_root "$dest_root"
  [ -d "$AGENTS_SOURCE" ] || die "Cursor agents source not found: $AGENTS_SOURCE"
  for source in "$AGENTS_SOURCE"/*.md; do
    [ -f "$source" ] || continue
    name="$(basename "$source")"
    dest="$dest_root/$name"
    ensure_child "$dest_root" "$dest"
    count=$((count + 1))
    if $apply; then
      mkdir -p "$dest_root"
      backup_file "$dest" cursor-agents
      cp "$source" "$dest"
    fi
  done
  local verb
  if $apply; then verb=written; else verb=planned; fi
  if $quiet; then
    printf '%-15s %s %s\n' "$label" "$verb" "$count"
  else
    if $apply; then verb=Installed; else verb=Planned; fi
    printf '%s Cursor agents: %s -> %s (%s files)\n' "$verb" "$AGENTS_SOURCE" "$dest_root" "$count"
  fi
}

install_project_rules() {
  local project="$1"
  local dest_root="$project/.cursor/rules"
  local count=0 source name dest
  ensure_dest_root "$dest_root"
  [ -d "$RULES_SOURCE" ] || die "Cursor rules source not found: $RULES_SOURCE"
  for source in "$RULES_SOURCE"/*.md "$RULES_SOURCE"/*.mdc; do
    [ -f "$source" ] || continue
    name="$(basename "$source")"
    dest="$dest_root/$name"
    ensure_child "$dest_root" "$dest"
    count=$((count + 1))
    if $apply; then
      mkdir -p "$dest_root"
      backup_file "$dest" cursor-rules
      cp "$source" "$dest"
    fi
  done
  local verb
  if $apply; then verb=written; else verb=planned; fi
  if $quiet; then
    printf '%-15s %s %s\n' "project-rules" "$verb" "$count"
  else
    if $apply; then verb=Installed; else verb=Planned; fi
    printf '%s Cursor project rules: %s -> %s (%s files)\n' "$verb" "$RULES_SOURCE" "$dest_root" "$count"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    --user-rules) show_user_rules=true ;;
    --show-user-rules) show_user_rules=true ;;
    --copy-user-rules) copy_user_rules=true ;;
    --show-playwright-mcp) show_playwright_mcp=true ;;
    --copy-playwright-mcp) copy_playwright_mcp=true ;;
    --show-sandbox-profile)
      shift
      [ $# -gt 0 ] || die "--show-sandbox-profile requires a profile name"
      show_sandbox_profile="$1"
      ;;
    --copy-sandbox-profile)
      shift
      [ $# -gt 0 ] || die "--copy-sandbox-profile requires a profile name"
      copy_sandbox_profile="$1"
      ;;
    --open-cursor-settings) open_cursor_settings=true ;;
    --global-agents) global_agents=true ;;
    --project-agents) project_agents=true ;;
    --project-rules) project_rules=true ;;
    --project) project_agents=true; project_rules=true ;;
    --all) global_agents=true; project_agents=true; project_rules=true ;;
    --target)
      shift
      [ $# -gt 0 ] || die "--target requires a path"
      target="$1"
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if ! $global_agents && ! $project_agents && ! $project_rules && ! $show_user_rules && ! $copy_user_rules && ! $show_playwright_mcp && ! $copy_playwright_mcp && [ -z "$show_sandbox_profile" ] && [ -z "$copy_sandbox_profile" ] && ! $open_cursor_settings; then
  global_agents=true
fi

project_target=""
if $project_agents || $project_rules; then
  project_target="$(validate_project_target "${target:-$caller_dir}")"
fi

if $show_user_rules; then
  if [ -f "$USER_RULES_SOURCE" ]; then
    cat "$USER_RULES_SOURCE"
  else
    die "user rules source not found: $USER_RULES_SOURCE"
  fi
  exit 0
fi

if $copy_user_rules; then
  if command -v pbcopy >/dev/null 2>&1; then
    if [ -f "$USER_RULES_SOURCE" ]; then
      pbcopy < "$USER_RULES_SOURCE"
      printf 'Cursor User Rules copied to clipboard.\n'
      printf 'Paste them into Cursor Settings > Rules > User Rules.\n'
    else
      die "user rules source not found: $USER_RULES_SOURCE"
    fi
  else
    die "pbcopy not available. Copy the file manually."
  fi
  exit 0
fi

if $show_playwright_mcp; then
  [ -f "$MCP_SOURCE" ] || die "Playwright MCP template not found: $MCP_SOURCE"
  cat "$MCP_SOURCE"
  exit 0
fi

if $copy_playwright_mcp; then
  if command -v pbcopy >/dev/null 2>&1; then
    [ -f "$MCP_SOURCE" ] || die "Playwright MCP template not found: $MCP_SOURCE"
    pbcopy < "$MCP_SOURCE"
    printf 'Cursor Playwright MCP template copied to clipboard.\n'
    printf 'Review before pasting into a Cursor-supported MCP config surface.\n'
  else
    die "pbcopy not available. Copy the file manually."
  fi
  exit 0
fi

if [ -n "$show_sandbox_profile" ]; then
  profile_path="$(sandbox_profile_path "$show_sandbox_profile")"
  [ -f "$profile_path" ] || die "sandbox profile not found: $profile_path"
  cat "$profile_path"
  exit 0
fi

if [ -n "$copy_sandbox_profile" ]; then
  if command -v pbcopy >/dev/null 2>&1; then
    profile_path="$(sandbox_profile_path "$copy_sandbox_profile")"
    [ -f "$profile_path" ] || die "sandbox profile not found: $profile_path"
    pbcopy < "$profile_path"
    printf 'Cursor sandbox profile copied to clipboard.\n'
    printf 'Review before pasting into Cursor-supported settings surfaces.\n'
  else
    die "pbcopy not available. Copy the file manually."
  fi
  exit 0
fi

if $open_cursor_settings; then
  if command -v open >/dev/null 2>&1; then
    open -a Cursor 2>/dev/null || open "cursor://settings/rules" 2>/dev/null || {
      printf 'Could not open Cursor Settings. Open Cursor manually and go to Settings > Rules.\n'
    }
  else
    die "open command not available"
  fi
  exit 0
fi

if $global_agents; then
  install_agents "${CURSOR_AGENTS_PATH:-$HOME/.cursor/agents}" "global-agents"
fi
if $project_agents; then
  install_agents "$project_target/.cursor/agents" "project-agents"
fi
if $project_rules; then
  install_project_rules "$project_target"
fi
