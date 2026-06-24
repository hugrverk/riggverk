#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/templates/codex/agents"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-codex-agents.sh [options]

Sync bundled native Codex agents from templates/codex/agents to ~/.codex/agents.

Options:
  --apply      Write target files
  --diff       Show diff without writing
  --quiet      Print compact app-friendly output
  --help       Show this help

Environment overrides:
  CODEX_HOME
  CODEX_AGENTS_DIR
  AGENT_WORKSPACE_BACKUP_DIR

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -d "$AGENTS_SOURCE_DIR" ]; then
  printf 'install-codex-agents.sh: agents source dir not found: %s\n' "$AGENTS_SOURCE_DIR" >&2
  exit 1
fi

apply=false
diff_mode=false
quiet=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --diff) diff_mode=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    *)
      printf 'install-codex-agents.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

backup_root() {
  if [ -n "${AGENT_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
  else
    printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"
case "$BACKUP_ROOT" in
  /|"$HOME"|"") printf 'install-codex-agents.sh: refusing broad backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

codex_home="${CODEX_HOME:-$HOME/.codex}"
TARGET_AGENTS_DIR="${CODEX_AGENTS_DIR:-$codex_home/agents}"

case "$TARGET_AGENTS_DIR" in
  /|"$HOME"|"$HOME/"|"$HOME/.codex")
    printf 'install-codex-agents.sh: refusing unsafe CODEX_AGENTS_DIR: %s\n' "$TARGET_AGENTS_DIR" >&2
    exit 1
    ;;
esac

list_agent_files() {
  if [ -d "$AGENTS_SOURCE_DIR" ]; then
    find "$AGENTS_SOURCE_DIR" -maxdepth 1 -name '*.toml' -type f -print0 | sort -z | tr '\0' '\n'
  fi
}

agent_basename() {
  basename "$1"
}

validate_toml() {
  python3 - "$1" <<'PY'
import sys
from pathlib import Path
try:
    import tomllib
except ModuleNotFoundError:
    import ast as _ast
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
                    parts = [p.strip().strip('"') for p in s[1:-1].split('.')]
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
                    if ch == '\\': esc = True; continue
                    if ch == '"': in_q = not in_q; continue
                    if ch == '#' and not in_q: v = v[:i].rstrip(); break
                if v == 'true': val = True
                elif v == 'false': val = False
                elif v.startswith('"'): val = _ast.literal_eval(v)
                else:
                    try: val = int(v)
                    except ValueError:
                        try: val = float(v)
                        except ValueError: val = v
                kk = k.strip()
                if '.' in kk:
                    ks = [p.strip().strip('"') for p in kk.split('.')]
                    c = root
                    for p in ks[:-1]:
                        c = c.setdefault(p, {})
                    c[ks[-1]] = val
                else:
                    current[kk] = val
            return root

path = Path(sys.argv[1])
tomllib.loads(path.read_text(encoding="utf-8"))
PY
}

if ! $quiet; then
  printf '\nCodex Native Agents Sync\n'
  printf '  Source: %s\n' "$AGENTS_SOURCE_DIR"
  printf '  Target: %s\n' "$TARGET_AGENTS_DIR"
  printf '  Bundled agents: %s\n' "$(list_agent_files | wc -l | tr -d ' ')"
fi

if $diff_mode; then
  has_diffs=false
  while IFS= read -r agent_src || [ -n "$agent_src" ]; do
    [ -n "$agent_src" ] || continue
    agent_name="$(agent_basename "$agent_src")"
    agent_target="$TARGET_AGENTS_DIR/$agent_name"
    if [ -f "$agent_target" ]; then
      if ! cmp -s "$agent_src" "$agent_target"; then
        printf '\n--- codex-agents %s diffs (%s)\n' "$agent_name" "$agent_target"
        diff -u "$agent_target" "$agent_src" || true
        has_diffs=true
      elif ! $quiet; then
        printf '  codex-agents %s synced\n' "$agent_name"
      fi
    else
      printf '\n--- codex-agents %s missing (no target at %s)\n' "$agent_name" "$agent_target"
      has_diffs=true
    fi
  done < <(list_agent_files)
  exit 0
fi

if $apply; then
  mkdir -p "$TARGET_AGENTS_DIR"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  while IFS= read -r agent_src || [ -n "$agent_src" ]; do
    [ -n "$agent_src" ] || continue
    validate_toml "$agent_src" || {
      printf 'install-codex-agents.sh: invalid TOML: %s\n' "$agent_src" >&2
      exit 1
    }
    agent_name="$(agent_basename "$agent_src")"
    agent_target="$TARGET_AGENTS_DIR/$agent_name"
    if [ -f "$agent_target" ]; then
      if cmp -s "$agent_src" "$agent_target"; then
        if ! $quiet; then printf '  codex-agents %s already synced\n' "$agent_name"; fi
      else
        backup_dir="$BACKUP_ROOT/$ts/codex-agents"
        mkdir -p "$backup_dir"
        cp "$agent_target" "$backup_dir/$agent_name"
        cp "$agent_src" "$agent_target"
        if ! $quiet; then printf '  codex-agents %s synced (backed up)\n' "$agent_name"; fi
      fi
    else
      cp "$agent_src" "$agent_target"
      if ! $quiet; then printf '  codex-agents %s created\n' "$agent_name"; fi
    fi
  done < <(list_agent_files)
  if ! $quiet; then printf '  codex-agents applied to %s\n' "$TARGET_AGENTS_DIR"; fi
  exit 0
fi

any_issue=false
while IFS= read -r agent_src || [ -n "$agent_src" ]; do
  [ -n "$agent_src" ] || continue
  agent_name="$(agent_basename "$agent_src")"
  agent_target="$TARGET_AGENTS_DIR/$agent_name"
  if [ -f "$agent_target" ] && cmp -s "$agent_src" "$agent_target"; then
    if ! $quiet; then printf '  codex-agents %s synced\n' "$agent_name"; fi
  elif [ -f "$agent_target" ]; then
    if ! $quiet; then printf '  codex-agents %s diverged (use --apply to sync)\n' "$agent_name"; fi
    any_issue=true
  else
    if ! $quiet; then printf '  codex-agents %s missing (use --apply to create)\n' "$agent_name"; fi
    any_issue=true
  fi
done < <(list_agent_files)
$any_issue && exit 1 || exit 0
