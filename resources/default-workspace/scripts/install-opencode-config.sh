#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_FILE="$WORKSPACE_ROOT/templates/opencode.json"
AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/agents"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-opencode-config.sh [options]

Sync OpenCode config and agents from the workspace to the OpenCode config path.

Config:  templates/opencode.json  ->  ~/.config/opencode/opencode.json
Agents:  agents/*.md              ->  ~/.config/opencode/agents/*.md

Options:
  --apply          Write target files
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
  else
    printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"

case "$BACKUP_ROOT" in
  /|"$HOME"|"") printf 'install-opencode-config.sh: refusing broad backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

TARGET="${OPENCODE_CONFIG_PATH:-$HOME/.config/opencode/opencode.json}"
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
  printf '\nOpenCode Config + Agents Sync\n'
  printf '  Config source: %s\n' "$SOURCE_FILE"
  printf '  Config target: %s\n' "$TARGET"
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

  # Config diff
  if [ -f "$TARGET" ]; then
    if ! cmp -s "$SOURCE_FILE" "$TARGET"; then
      printf '\n--- opencode config diffs (%s)\n' "$TARGET"
      diff -u "$TARGET" "$SOURCE_FILE" || true
      has_diffs=true
    fi
  else
    printf '\n--- opencode config missing (no target file at %s)\n' "$TARGET"
    has_diffs=true
  fi

  # Agent diffs
  while IFS= read -r agent_src || [ -n "$agent_src" ]; do
    agent_name="$(agent_basename "$agent_src")"
    agent_target="$TARGET_AGENTS_DIR/$agent_name"
    if [ -f "$agent_target" ]; then
      if ! cmp -s "$agent_src" "$agent_target"; then
        printf '\n--- agent diff (%s)\n' "$agent_name"
        diff -u "$agent_target" "$agent_src" || true
        has_diffs=true
      fi
    else
      printf '\n--- agent missing: %s (no target at %s)\n' "$agent_name" "$agent_target"
      has_diffs=true
    fi
  done < <(list_agent_files)

  if ! $has_diffs; then
    if ! $quiet; then printf '  opencode config + agents synced\n'; fi
  fi
  exit 0
fi

# ── Apply mode ──

if $apply; then
  # Validate config JSON
  validate_json "$SOURCE_FILE" || {
    printf 'install-opencode-config.sh: source JSON is invalid\n' >&2
    exit 1
  }

  # ── Apply config ──
  if [ -f "$TARGET" ]; then
    if cmp -s "$SOURCE_FILE" "$TARGET"; then
      if ! $quiet; then printf '  opencode config already synced\n'; fi
    else
      ts="$(date -u +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_ROOT/$ts/opencode-config"
      mkdir -p "$backup_dir"
      backup_file="$backup_dir/opencode.json"
      cp "$TARGET" "$backup_file"
      if ! $quiet; then printf '  opencode config backed up to %s\n' "$backup_file"; fi
      cp "$SOURCE_FILE" "$TARGET"
      if ! $quiet; then printf '  opencode config synced\n'; fi
    fi
  else
    mkdir -p "$(dirname "$TARGET")"
    if ! $quiet; then printf '  opencode config creating new\n'; fi
    cp "$SOURCE_FILE" "$TARGET"
    if ! $quiet; then printf '  opencode config synced\n'; fi
  fi

  # ── Apply agents ──
  mkdir -p "$TARGET_AGENTS_DIR"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  while IFS= read -r agent_src || [ -n "$agent_src" ]; do
    agent_name="$(agent_basename "$agent_src")"
    agent_target="$TARGET_AGENTS_DIR/$agent_name"
    if [ -f "$agent_target" ]; then
      if cmp -s "$agent_src" "$agent_target"; then
        if ! $quiet; then printf '  agent %s already synced\n' "$agent_name"; fi
      else
        backup_dir="$BACKUP_ROOT/$ts/opencode-agents"
        mkdir -p "$backup_dir"
        backup_file="$backup_dir/$agent_name"
        cp "$agent_target" "$backup_file"
        if ! $quiet; then printf '  agent %s backed up to %s\n' "$agent_name" "$backup_file"; fi
        cp "$agent_src" "$agent_target"
        if ! $quiet; then printf '  agent %s synced\n' "$agent_name"; fi
      fi
    else
      cp "$agent_src" "$agent_target"
      if ! $quiet; then printf '  agent %s created\n' "$agent_name"; fi
    fi
  done < <(list_agent_files)

  if ! $quiet; then printf '  opencode config + %s agents synced\n' "$(agent_count)"; fi
  exit 0
fi

# ── Dry-run mode ──

all_synced=true

# Config check
if [ -f "$TARGET" ]; then
  if cmp -s "$SOURCE_FILE" "$TARGET"; then
    if ! $quiet; then printf '  opencode config synced\n'; fi
  else
    if ! $quiet; then printf '  opencode config diverged (use --apply to sync)\n'; fi
    all_synced=false
  fi
else
  if ! $quiet; then printf '  opencode config missing (use --apply to create)\n'; fi
  all_synced=false
fi

# Agent checks
  while IFS= read -r agent_src || [ -n "$agent_src" ]; do
    agent_name="$(agent_basename "$agent_src")"
    agent_target="$TARGET_AGENTS_DIR/$agent_name"
    if [ -f "$agent_target" ]; then
      if ! cmp -s "$agent_src" "$agent_target"; then
        if ! $quiet; then printf '  agent %s diverged (use --apply to sync)\n' "$agent_name"; fi
        all_synced=false
      fi
    else
      if ! $quiet; then printf '  agent %s missing (use --apply to create)\n' "$agent_name"; fi
      all_synced=false
    fi
  done < <(list_agent_files)

if $all_synced && [ -f "$TARGET" ]; then
  if ! $quiet; then printf '  opencode config + %s agents synced\n' "$(agent_count)"; fi
fi
