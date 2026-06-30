#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/platform-paths.sh
. "$repo_root/scripts/lib/platform-paths.sh"
source_config="$repo_root/templates/codex/config.toml"
MERGE_SCRIPT="$repo_root/scripts/merge-codex-config.py"
ROUTING_DEFAULTS_SCRIPT="$repo_root/scripts/ensure-codex-routing-defaults.py"
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

Managed sections preserve user personality, MCP, and unknown tables while enforcing the bundled Codex model/routing/approval defaults.
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
[ -f "$ROUTING_DEFAULTS_SCRIPT" ] || die "missing routing defaults script: $ROUTING_DEFAULTS_SCRIPT"

codex_home="${CODEX_HOME:-$HOME/.codex}"
target_config="${CODEX_CONFIG_PATH:-$codex_home/config.toml}"

BACKUP_ROOT="$(agent_workspace_backup_root)" || exit 1
[ -n "${BACKUP_ROOT//[[:space:]]/}" ] || die "backup directory is empty"
agent_workspace_refuse_broad_backup_root "$BACKUP_ROOT" "install-codex-config.sh" || exit 1

backup_root() {
  printf '%s\n' "$BACKUP_ROOT"
}

codex_config_legacy_managed_match() {
  [ -f "$target_config" ] || return 1
  python3 "$MERGE_SCRIPT" --managed-match "$target_config" "$source_config"
}

codex_routing_defaults_match() {
  [ -f "$target_config" ] || return 1
  python3 "$ROUTING_DEFAULTS_SCRIPT" --managed-match "$target_config" "$source_config"
}

codex_config_managed_match() {
  codex_config_legacy_managed_match && codex_routing_defaults_match
}

codex_config_merge_preview() {
  local dest="$1"
  if [ -f "$target_config" ]; then
    python3 "$MERGE_SCRIPT" --merge "$target_config" "$source_config" --output "$dest"
    local preview_backup
    preview_backup="$(mktemp -d)"
    python3 "$ROUTING_DEFAULTS_SCRIPT" --apply "$dest" "$source_config" --backup-dir "$preview_backup"
    rm -rf "$preview_backup"
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
      if codex_config_legacy_managed_match; then
        printf '%s\n' '--- codex-config legacy managed-section diffs'
        printf '  legacy approval/sandbox fields synced\n'
      else
        python3 -c "
import json, sys
from pathlib import Path
try:
    import tomllib
except ModuleNotFoundError:
    import re, ast as _ast
    class tomllib:
        TOMLDecodeError = ValueError
        @staticmethod
        def loads(text):
            root = {}
            current = root
            for line in text.splitlines():
                s = line.strip()
                if not s or s.startswith('#'):
                    continue
                if s.startswith('[') and s.endswith(']'):
                    parts = [p.strip().strip('\"') for p in s[1:-1].split('.')]
                    if not parts or any(not p for p in parts):
                        continue
                    c = root
                    for p in parts:
                        c = c.setdefault(p, {})
                    current = c
                    continue
                if '=' not in s:
                    continue
                k, v = s.split('=', 1)
                v = v.strip()
                ci = v.find('#')
                in_q = False
                esc = False
                for i, ch in enumerate(v):
                    if esc: esc = False; continue
                    if ch == '\\\\': esc = True; continue
                    if ch == '\"': in_q = not in_q; continue
                    if ch == '#' and not in_q: v = v[:i].rstrip(); break
                if v == 'true': val = True
                elif v == 'false': val = False
                elif v.startswith('\"'): val = _ast.literal_eval(v)
                else:
                    try: val = int(v)
                    except ValueError:
                        try: val = float(v)
                        except ValueError: val = v
                kk = k.strip()
                if '.' in kk:
                    ks = [p.strip().strip('\"') for p in kk.split('.')]
                    c = root
                    for p in ks[:-1]:
                        c = c.setdefault(p, {})
                    c[ks[-1]] = val
                else:
                    current[kk] = val
            return root
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
    print('--- codex-config legacy managed-section diffs')
    for d in diff_items:
        print(f'  {d}')
else:
    print('  codex-config legacy managed sections differ (structural change)')
" || true
      fi
      python3 "$ROUTING_DEFAULTS_SCRIPT" --diff "$target_config" "$source_config" || true
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
    legacy_synced=0
    routing_synced=0
    if codex_config_legacy_managed_match; then legacy_synced=1; fi
    if codex_routing_defaults_match; then routing_synced=1; fi

    if [ "$legacy_synced" -eq 1 ] && [ "$routing_synced" -eq 1 ]; then
      [ "$quiet" -eq 1 ] && printf '%-15s synced\n' "codex-config" || printf 'codex-config managed sections already synced\n'
      exit 0
    fi

    ts="$(date -u +%Y%m%d-%H%M%S)"
    backup_dir="$(backup_root)/$ts/codex-config"
    mkdir -p "$backup_dir"
    if [ "$legacy_synced" -eq 0 ]; then
      python3 "$MERGE_SCRIPT" --apply "$target_config" "$source_config" --backup-dir "$backup_dir"
    fi
    if [ "$routing_synced" -eq 0 ]; then
      python3 "$ROUTING_DEFAULTS_SCRIPT" --apply "$target_config" "$source_config" --backup-dir "$backup_dir"
    fi
    [ "$quiet" -eq 1 ] && printf '%-15s merged\n' "codex-config" || printf 'Merged managed sections into: %s\n' "$target_config"
  else
    mkdir -p "$(dirname "$target_config")"
    cp "$source_config" "$target_config"
    [ "$quiet" -eq 1 ] && printf '%-15s created\n' "codex-config" || printf 'Created: %s\n' "$target_config"
  fi
fi
