#!/usr/bin/env bash
set -euo pipefail

caller_dir="$PWD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RULES_SOURCE="$WORKSPACE_ROOT/templates/cursor/rules"
AGENTS_SOURCE="$WORKSPACE_ROOT/templates/cursor/agents"
USER_RULES_SOURCE="$WORKSPACE_ROOT/templates/cursor/user-rules.md"

apply=false
quiet=false
project_agents=false
project_rules=false
show_user_rules=false
copy_user_rules=false
open_cursor_settings=false
target=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-cursor-workspace.sh [options]

Manual helpers and CLI-only project installs. Global Cursor setup (agents, skills, MCP)
is handled by the Agent Workspace app via native Rust operations. This script never writes
~/.cursor/agents.

Options:
  --apply                  Write target files (default is dry-run)
  --project-agents         CLI-only: project agents to <target>/.cursor/agents
  --project-rules          CLI-only: project rules to <target>/.cursor/rules
  --project                Alias for --project-agents --project-rules (CLI-only)
  --all                    CLI-only: project agents + project rules
  --target <path>          CLI-only project path (default: current directory)
  --show-user-rules        Print versioned Cursor User Rules
  --copy-user-rules        Copy User Rules to clipboard (macOS pbcopy)
  --open-cursor-settings   Open Cursor Settings (macOS)
  --quiet                  Compact output
  --help                   Show this help
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

install_project_agents() {
  local project="$1"
  local dest_root="$project/.cursor/agents"
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
    printf '%-15s %s %s\n' "project-agents" "$verb" "$count"
  else
    if $apply; then verb=Installed; else verb=Planned; fi
    printf '%s Cursor project agents: %s -> %s (%s files)\n' "$verb" "$AGENTS_SOURCE" "$dest_root" "$count"
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
    --show-user-rules) show_user_rules=true ;;
    --copy-user-rules) copy_user_rules=true ;;
    --open-cursor-settings) open_cursor_settings=true ;;
    --project-agents) project_agents=true ;;
    --project-rules) project_rules=true ;;
    --project) project_agents=true; project_rules=true ;;
    --all) project_agents=true; project_rules=true ;;
    --target)
      shift
      [ $# -gt 0 ] || die "--target requires a path"
      target="$1"
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if $show_user_rules; then
  [ -f "$USER_RULES_SOURCE" ] && cat "$USER_RULES_SOURCE" || die "user rules source not found: $USER_RULES_SOURCE"
  exit 0
fi

if $copy_user_rules; then
  command -v pbcopy >/dev/null 2>&1 || die "pbcopy not available. Copy the file manually."
  [ -f "$USER_RULES_SOURCE" ] || die "user rules source not found: $USER_RULES_SOURCE"
  pbcopy < "$USER_RULES_SOURCE"
  printf 'Cursor User Rules copied to clipboard.\nPaste into Cursor Settings > Rules > User Rules.\n'
  exit 0
fi

if $open_cursor_settings; then
  if command -v open >/dev/null 2>&1; then
    open -a Cursor 2>/dev/null || open "cursor://settings/rules" 2>/dev/null || {
      printf 'Could not open Cursor Settings. Open Cursor manually.\n'
    }
  else
    die "open command not available"
  fi
  exit 0
fi

if ! $project_agents && ! $project_rules; then
  usage >&2
  die "no action selected; global setup is handled by the Agent Workspace app"
fi

project_target="$(validate_project_target "${target:-$caller_dir}")"

if $project_agents; then
  install_project_agents "$project_target"
fi
if $project_rules; then
  install_project_rules "$project_target"
fi
