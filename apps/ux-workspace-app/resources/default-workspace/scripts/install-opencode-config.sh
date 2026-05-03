#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_FILE="$WORKSPACE_ROOT/templates/opencode.json"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-opencode-config.sh [options]

Sync OpenCode config from templates/opencode.json to the OpenCode config path.

Options:
  --apply          Write target file
  --diff           Show diff without writing
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -f "$SOURCE_FILE" ]; then
  printf 'install-opencode-config.sh: source file not found: %s\n' "$SOURCE_FILE" >&2
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
      printf 'install-opencode-config.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

backup_root() {
  if [ -n "${AGENT_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
  elif [ -n "${UX_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$UX_WORKSPACE_BACKUP_DIR"
  else
    printf '%s/Library/Application Support/ai.openworkspace.ux-workspace/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"

case "$BACKUP_ROOT" in
  /|"$HOME"|"") printf 'install-opencode-config.sh: refusing broad backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

TARGET="${OPENCODE_CONFIG_PATH:-$HOME/.config/opencode/opencode.json}"

validate_json() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$1" >/dev/null 2>&1
  fi
}

if ! $quiet; then
  printf '\nOpenCode Config Sync\n'
  printf '  Source: %s\n' "$SOURCE_FILE"
  printf '  Target: %s\n' "$TARGET"
  if $diff_mode; then
    printf '  Mode: diff\n'
  elif $apply; then
    printf '  Mode: apply\n'
    printf '  Backups: %s\n' "$BACKUP_ROOT"
  else
    printf '  Mode: dry-run\n'
  fi
fi

if $diff_mode; then
  if [ -f "$TARGET" ]; then
    if cmp -s "$SOURCE_FILE" "$TARGET"; then
      if ! $quiet; then printf '  opencode config synced\n'; fi
    else
      printf '\n--- opencode config diffs (%s)\n' "$TARGET"
      diff -u "$TARGET" "$SOURCE_FILE" || true
    fi
  else
    printf '\n--- opencode config missing (no target file at %s)\n' "$TARGET"
  fi
  exit 0
fi

if $apply; then
  validate_json "$SOURCE_FILE" || {
    printf 'install-opencode-config.sh: source JSON is invalid\n' >&2
    exit 1
  }
  if [ -f "$TARGET" ]; then
    if cmp -s "$SOURCE_FILE" "$TARGET"; then
      if ! $quiet; then printf '  opencode config already synced\n'; fi
      exit 0
    fi
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    backup_dir="$BACKUP_ROOT/$ts/opencode_config"
    mkdir -p "$backup_dir"
    backup_file="$backup_dir/opencode.json"
    cp "$TARGET" "$backup_file"
    if ! $quiet; then printf '  opencode config backed up to %s\n' "$backup_file"; fi
  else
    mkdir -p "$(dirname "$TARGET")"
    if ! $quiet; then printf '  opencode config creating new\n'; fi
  fi
  cp "$SOURCE_FILE" "$TARGET"
  if ! $quiet; then printf '  opencode config synced\n'; fi
  exit 0
fi

if [ -f "$TARGET" ]; then
  if cmp -s "$SOURCE_FILE" "$TARGET"; then
    if ! $quiet; then printf '  opencode config synced\n'; fi
  else
    if ! $quiet; then printf '  opencode config diverged (use --apply to sync)\n'; fi
  fi
else
  if ! $quiet; then printf '  opencode config missing (use --apply to create)\n'; fi
fi
