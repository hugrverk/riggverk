#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_config="$repo_root/templates/codex/config.toml"
apply=0
show_diff=0
quiet=0
force_overwrite=0

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-codex-config.sh [options]

Options:
  --apply       Write Codex config template
  --diff        Show diff for existing Codex config
  --force-overwrite
                Required with --apply; overwrites ~/.codex/config.toml after backup
  --quiet       Print compact app-friendly output
  --help        Show this help

Environment overrides:
  CODEX_CONFIG_PATH
  CODEX_HOME
  AGENT_WORKSPACE_BACKUP_DIR
USAGE
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --diff) show_diff=1; shift ;;
    --force-overwrite) force_overwrite=1; shift ;;
    --quiet) quiet=1; shift ;;
    --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -f "$source_config" ] || die "missing source config: $source_config"

codex_home="${CODEX_HOME:-$HOME/.codex}"
target_config="${CODEX_CONFIG_PATH:-$codex_home/config.toml}"

backup_root() {
  local root="${AGENT_WORKSPACE_BACKUP_DIR:-$HOME/Library/Application Support/ai.agentworkspace.app/backups}"
  [ -n "${root//[[:space:]]/}" ] || die "backup directory is empty"
  case "$root" in / | "$HOME" | "$HOME/") die "refusing broad backup directory: $root" ;; esac
  printf '%s\n' "$root"
}

status=missing
if [ -f "$target_config" ]; then
  if cmp -s "$source_config" "$target_config"; then
    status=synced
  else
    status=diverged
  fi
fi

if [ "$quiet" -eq 1 ] && [ "$apply" -eq 0 ] && [ "$show_diff" -eq 0 ]; then
  printf '%-15s %s\n' "codex-config" "$status"
  exit 0
fi

if [ "$show_diff" -eq 1 ]; then
  if [ -f "$target_config" ]; then
    if cmp -s "$source_config" "$target_config"; then
      printf 'codex-config synced\n'
    else
      diff -u "$target_config" "$source_config" || true
    fi
  else
    printf 'Codex config missing: %s\n' "$target_config"
  fi
fi

if [ "$apply" -eq 1 ]; then
  if [ "$force_overwrite" -ne 1 ]; then
    die "Codex config apply is manual-review only. Run --diff and pass --force-overwrite only after reviewing ~/.codex/config.toml."
  fi
  if [ -f "$target_config" ] && ! cmp -s "$source_config" "$target_config"; then
    ts="$(date +%Y%m%d-%H%M%S)"
    backup_dir="$(backup_root)/$ts/codex-config"
    mkdir -p "$backup_dir"
    cp "$target_config" "$backup_dir/config.toml"
  fi
  mkdir -p "$(dirname "$target_config")"
  cp "$source_config" "$target_config"
  [ "$quiet" -eq 1 ] && printf '%-15s written\n' "codex-config" || printf 'Written: %s\n' "$target_config"
fi
