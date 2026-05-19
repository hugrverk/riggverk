#!/usr/bin/env bash
set -euo pipefail

caller_dir="$PWD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_SOURCE="$WORKSPACE_ROOT/templates/cursor/agents"
RULE_SOURCE="$WORKSPACE_ROOT/templates/cursor/rules/agent-workspace.mdc"

apply=false
quiet=false
global_agents=false
project_agents=false
project_rules=false
target=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-cursor-workspace.sh [options]

Options:
  --apply                  Write target files (default is dry-run)
  --global-agents          Install Cursor subagents to ${CURSOR_AGENTS_PATH:-$HOME/.cursor/agents}
  --project-agents         Install Cursor subagents to <target>/.cursor/agents
  --project-rules          Install project Cursor rules to <target>/.cursor/rules/agent-workspace.mdc
  --project                Alias for --project-agents --project-rules
  --all                    Select all Cursor targets
  --target <path>          Target project path for project installs (default: current directory)
  --quiet                  Print compact app-friendly output
  --help                   Show this help

Cursor User Rules are defined in Cursor Settings > Rules and are not synced by this script.
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

install_project_rule() {
  local project="$1"
  local dest_root="$project/.cursor/rules"
  local dest="$dest_root/agent-workspace.mdc"
  ensure_dest_root "$dest_root"
  ensure_child "$dest_root" "$dest"
  [ -f "$RULE_SOURCE" ] || die "Cursor rule source not found: $RULE_SOURCE"
  if $apply; then
    mkdir -p "$dest_root"
    backup_file "$dest" cursor-rules
    cp "$RULE_SOURCE" "$dest"
  fi
  local verb
  if $apply; then verb=written; else verb=planned; fi
  if $quiet; then
    printf '%-15s %s %s\n' "project-rules" "$verb" "$dest"
  else
    if $apply; then verb=Installed; else verb=Planned; fi
    printf '%s Cursor project rule: %s -> %s\n' "$verb" "$RULE_SOURCE" "$dest"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
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

if ! $global_agents && ! $project_agents && ! $project_rules; then
  global_agents=true
fi

project_target=""
if $project_agents || $project_rules; then
  project_target="$(validate_project_target "${target:-$caller_dir}")"
fi

if $global_agents; then
  install_agents "${CURSOR_AGENTS_PATH:-$HOME/.cursor/agents}" "global-agents"
fi
if $project_agents; then
  install_agents "$project_target/.cursor/agents" "project-agents"
fi
if $project_rules; then
  install_project_rule "$project_target"
fi
