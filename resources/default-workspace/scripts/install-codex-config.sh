#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_config="$repo_root/templates/codex/config.toml"
MERGE_SCRIPT="$repo_root/scripts/merge-codex-config.py"
apply=0
show_diff=0
quiet=0
force_overwrite=0

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-codex-config.sh [options]

Options:
  --apply            Merge bundled managed sections into ~/.codex/config.toml
  --diff             Show managed-section diff for existing Codex config
  --force-overwrite  With --apply, overwrite the full config after backup (advanced)
  --quiet            Print compact app-friendly output
  --help             Show this help

Managed sections preserve user model, personality, MCP, and unknown tables.
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
[ -f "$MERGE_SCRIPT" ] || die "missing merge script: $MERGE_SCRIPT"

codex_home="${CODEX_HOME:-$HOME/.codex}"
target_config="${CODEX_CONFIG_PATH:-$codex_home/config.toml}"

backup_root() {
  local root="${AGENT_WORKSPACE_BACKUP_DIR:-$HOME/Library/Application Support/ai.agentworkspace.app/backups}"
  [ -n "${root//[[:space:]]/}" ] || die "backup directory is empty"
  case "$root" in / | "$HOME" | "$HOME/") die "refusing broad backup directory: $root" ;; esac
  printf '%s\n' "$root"
}

codex_config_managed_match() {
  [ -f "$target_config" ] || return 1
  python3 "$MERGE_SCRIPT" --managed-match "$target_config" "$source_config"
}

codex_config_merge_preview() {
  local dest="$1"
  if [ -f "$target_config" ]; then
    python3 "$MERGE_SCRIPT" --merge "$target_config" "$source_config" --output "$dest"
  else
    cp "$source_config" "$dest"
  fi
}

status=missing
if [ -f "$target_config" ]; then
  if codex_config_managed_match; then
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
    if codex_config_managed_match; then
      printf 'codex-config managed sections synced\n'
    else
      python3 -c "
import json, sys, tomllib
from pathlib import Path
ws = Path('$repo_root')
managed = json.loads((ws / 'metadata/codex-managed-keys.json').read_text())
top = set(managed.get('top_level_keys', []))
profiles = set(managed.get('managed_profiles', []))
fields = set(managed.get('managed_profile_fields', []))
installed = tomllib.loads(Path('$target_config').read_text())
source = tomllib.loads(Path('$source_config').read_text())
diff_items = []
for k in top:
    iv = installed.get(k)
    sv = source.get(k)
    if iv != sv:
        diff_items.append(f'managed key \"{k}\" would change')
for p in profiles:
    ip = installed.get('profiles', {}).get(p, {})
    sp = source.get('profiles', {}).get(p, {})
    for f in fields:
        if ip.get(f) != sp.get(f):
            diff_items.append(f'managed profile \"{p}.{f}\" would change')
if diff_items:
    print('--- codex-config managed-section diffs')
    for d in diff_items:
        print(f'  {d}')
else:
    print('  codex-config managed sections differ (structural change)')
" || true
    fi
  else
    printf 'Codex config missing: %s\n' "$target_config"
  fi
  exit 0
fi

if [ "$apply" -eq 1 ]; then
  if [ "$force_overwrite" -eq 1 ]; then
    if [ -f "$target_config" ] && ! cmp -s "$source_config" "$target_config"; then
      ts="$(date -u +%Y%m%d-%H%M%S)"
      backup_dir="$(backup_root)/$ts/codex-config"
      mkdir -p "$backup_dir"
      cp "$target_config" "$backup_dir/config.toml"
    fi
    mkdir -p "$(dirname "$target_config")"
    cp "$source_config" "$target_config"
    [ "$quiet" -eq 1 ] && printf '%-15s written\n' "codex-config" || printf 'Written full config: %s\n' "$target_config"
    exit 0
  fi

  if [ -f "$target_config" ]; then
    if codex_config_managed_match; then
      [ "$quiet" -eq 1 ] && printf '%-15s synced\n' "codex-config" || printf 'codex-config managed sections already synced\n'
      exit 0
    fi
    ts="$(date -u +%Y%m%d-%H%M%S)"
    backup_dir="$(backup_root)/$ts/codex-config"
    mkdir -p "$backup_dir"
    python3 "$MERGE_SCRIPT" --apply "$target_config" "$source_config" --backup-dir "$backup_dir"
    [ "$quiet" -eq 1 ] && printf '%-15s merged\n' "codex-config" || printf 'Merged managed sections into: %s\n' "$target_config"
  else
    mkdir -p "$(dirname "$target_config")"
    cp "$source_config" "$target_config"
    [ "$quiet" -eq 1 ] && printf '%-15s created\n' "codex-config" || printf 'Created: %s\n' "$target_config"
  fi
fi
