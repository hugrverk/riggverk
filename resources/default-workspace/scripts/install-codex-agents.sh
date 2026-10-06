#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/platform-paths.sh
. "$WORKSPACE_ROOT/scripts/lib/platform-paths.sh"
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

BACKUP_ROOT="$(agent_workspace_backup_root)" || exit 1
agent_workspace_refuse_broad_backup_root "$BACKUP_ROOT" "install-codex-agents.sh" || exit 1

codex_home="${CODEX_HOME:-$HOME/.codex}"
TARGET_AGENTS_DIR="${CODEX_AGENTS_DIR:-$codex_home/agents}"

agent_workspace_refuse_unsafe_agents_dir "$TARGET_AGENTS_DIR" "CODEX_AGENTS_DIR" "install-codex-agents.sh" || exit 1

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
import ast
import os
import sys
from pathlib import Path


def strip_inline_comment(text):
    in_double = False
    escape = False
    for i, ch in enumerate(text):
        if in_double:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_double = False
            continue
        if ch == '"':
            in_double = True
        elif ch == "#":
            return text[:i].rstrip()
    return text.rstrip()


def parse_basic_value(value):
    value = strip_inline_comment(value).strip()
    if not value:
        raise ValueError("empty TOML value")
    if value == "true":
        return True
    if value == "false":
        return False
    if value.startswith('"'):
        return ast.literal_eval(value)
    if value.startswith("[") and value.endswith("]"):
        return []
    if value.startswith("{") and value.endswith("}"):
        return {}
    try:
        return int(value, 10)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def parse_multiline_value(lines, start_index, first_value):
    value = first_value.strip()
    for quote in ('"""', "'''"):
        if value.startswith(quote):
            rest = value[3:]
            end = rest.find(quote)
            if end >= 0:
                return rest[:end], start_index
            collected = [rest]
            i = start_index + 1
            while i < len(lines):
                line = lines[i]
                end = line.find(quote)
                if end >= 0:
                    collected.append(line[:end])
                    return "\n".join(collected), i
                collected.append(line)
                i += 1
            raise ValueError("unterminated multiline TOML string")
    return parse_basic_value(value), start_index


def split_dotted_key(key):
    parts = [part.strip().strip('"') for part in key.split(".")]
    if not parts or any(not part for part in parts):
        raise ValueError(f"invalid dotted key: {key!r}")
    return parts


def table_at(root, parts):
    current = root
    for part in parts:
        if not isinstance(current, dict):
            raise ValueError(f"table prefix is not a table: {'.'.join(parts)}")
        current = current.setdefault(part, {})
    if not isinstance(current, dict):
        raise ValueError(f"table is not a table: {'.'.join(parts)}")
    return current


def assign_value(current, root, dotted_key, value):
    parts = split_dotted_key(dotted_key)
    table = table_at(root, parts[:-1]) if len(parts) > 1 else current
    table[parts[-1]] = value


def parse_minimal_toml(text):
    root = {}
    current = root
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            if stripped.startswith("[[") and stripped.endswith("]]" ):
                # Agent TOML currently does not need array-table semantics for validation.
                table_name = stripped[2:-2].strip()
            else:
                table_name = stripped[1:-1].strip()
            current = table_at(root, split_dotted_key(table_name))
            i += 1
            continue
        if "=" not in stripped:
            raise ValueError(f"invalid TOML line: {stripped!r}")
        key, raw_value = stripped.split("=", 1)
        value, i = parse_multiline_value(lines, i, raw_value)
        assign_value(current, root, key.strip(), value)
        i += 1
    return root


if not os.environ.get("AGENT_WORKSPACE_FORCE_TOML_FALLBACK"):
    try:
        import tomllib
    except ModuleNotFoundError:
        tomllib = None
else:
    tomllib = None

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
if tomllib is not None:
    tomllib.loads(text)
else:
    parse_minimal_toml(text)
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
