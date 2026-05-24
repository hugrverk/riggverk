#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_FILE="$WORKSPACE_ROOT/templates/global-agent-rules.md"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-agent-rules.sh [options]

Sync agent rules from templates/global-agent-rules.md to tool-specific paths.

Options:
  --apply          Write target files
  --diff           Show diffs without writing
  --codex          Select Codex rule target
  --opencode       Select OpenCode rule target
  --auggie         Select Auggie rule target
  --claude         Select Claude rule target
  --all            Select all rule targets (default)
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -f "$SOURCE_FILE" ]; then
  printf 'install-agent-rules.sh: source file not found: %s\n' "$SOURCE_FILE" >&2
  exit 1
fi

apply=false
diff_mode=false
quiet=false
codex=false
opencode=false
auggie=false
claude=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --diff) diff_mode=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    --codex) codex=true ;;
    --opencode) opencode=true ;;
    --auggie) auggie=true ;;
    --claude) claude=true ;;
    --all) codex=true; opencode=true; auggie=true; claude=true ;;
    *)
      printf 'install-agent-rules.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if ! $codex && ! $opencode && ! $auggie && ! $claude; then
  codex=true; opencode=true; auggie=true; claude=true
fi

backup_root() {
  if [ -n "${AGENT_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
  else
    printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"

case "$BACKUP_ROOT" in
  /|"$HOME"|"") printf 'install-agent-rules.sh: refusing broad backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

resolve_target() {
  local agent_id="$1"
  case "$agent_id" in
    codex)    printf '%s' "${CODEX_AGENTS_PATH:-$HOME/.codex/AGENTS.md}" ;;
    opencode) printf '%s' "${OPENCODE_AGENTS_PATH:-$HOME/.config/opencode/AGENTS.md}" ;;
    auggie)   printf '%s' "${AUGGIE_GLOBAL_PATH:-$HOME/.augment/rules/global.md}" ;;
    claude)   printf '%s' "${CLAUDE_RULES_PATH:-$HOME/.claude/CLAUDE.md}" ;;
  esac
}

target_label() {
  case "$1" in
    codex)    printf 'codex-rules' ;;
    opencode) printf 'opencode-rules' ;;
    auggie)   printf 'auggie-rules' ;;
    claude)  printf 'claude-rules' ;;
  esac
}

status_char() {
  case "$1" in
    synced)   printf '=' ;;
    diverged) printf '~' ;;
    missing)  printf '+' ;;
    *)        printf '?' ;;
  esac
}

handle_target() {
  local agent_id="$1"
  local target
  target="$(resolve_target "$agent_id")"
  local label
  label="$(target_label "$agent_id")"

  if ! $diff_mode && ! $apply; then
    if [ -f "$target" ]; then
      if cmp -s "$SOURCE_FILE" "$target"; then
        if ! $quiet; then printf '  %s synced\n' "$label"; fi
      else
        if ! $quiet; then printf '  %s diverged (use --apply to sync)\n' "$label"; fi
      fi
    else
      if ! $quiet; then printf '  %s missing (use --apply to create)\n' "$label"; fi
    fi
    return 0
  fi

  if $diff_mode; then
    if [ -f "$target" ]; then
      if cmp -s "$SOURCE_FILE" "$target"; then
        printf '%s synced\n' "$label"
      else
        printf '\n--- %s diffs (%s)\n' "$label" "$target"
        diff -u "$target" "$SOURCE_FILE" || true
      fi
    else
      printf '\n--- %s missing (no target file at %s)\n' "$label" "$target"
    fi
    return 0
  fi

  if $apply; then
    if [ -f "$target" ]; then
      if cmp -s "$SOURCE_FILE" "$target"; then
        if ! $quiet; then printf '  %s already synced\n' "$label"; fi
        return 0
      fi
      local ts
      ts="$(date -u +%Y%m%d-%H%M%S)"
      local backup_dir="$BACKUP_ROOT/$ts/$(target_label "$1")"
      mkdir -p "$backup_dir"
      local backup_file="$backup_dir/$(basename "$target")"
      cp "$target" "$backup_file"
      if ! $quiet; then printf '  %s backed up to %s\n' "$label" "$backup_file"; fi
    else
      mkdir -p "$(dirname "$target")"
      if ! $quiet; then printf '  %s creating new\n' "$label"; fi
    fi
    cp "$SOURCE_FILE" "$target"
    if ! $quiet; then printf '  %s synced\n' "$label"; fi
  fi
}

if ! $quiet; then
  printf '\nAgent Rules Sync\n'
  printf '  Source: %s\n' "$SOURCE_FILE"
  if $diff_mode; then
    printf '  Mode: diff\n'
  elif $apply; then
    printf '  Mode: apply\n'
    printf '  Backups: %s\n' "$BACKUP_ROOT"
  else
    printf '  Mode: dry-run\n'
  fi
fi

exit_code=0

$codex    && handle_target codex    || exit_code=$?
$opencode && handle_target opencode || exit_code=$?
$auggie   && handle_target auggie   || exit_code=$?
$claude   && handle_target claude   || exit_code=$?

exit "$exit_code"
