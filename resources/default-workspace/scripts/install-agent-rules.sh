#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_RULES_FILE="$WORKSPACE_ROOT/templates/global-agent-rules.md"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-agent-rules.sh [options]

Sync composed harness rule files (core + appendix) to tool-specific paths.

Options:
  --apply          Write target files
  --diff           Show diffs without writing
  --codex          Select Codex rule target
  --opencode       Select OpenCode rule target
  --claude         Select Claude rule target
  --all            Select all rule targets (default)
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -f "$CORE_RULES_FILE" ]; then
  printf 'install-agent-rules.sh: shared core rules not found: %s\n' "$CORE_RULES_FILE" >&2
  exit 1
fi

composed_rules_source() {
  local agent_id="$1"
  case "$agent_id" in
    codex)    printf '%s' "$WORKSPACE_ROOT/templates/sync/codex-rules.md" ;;
    opencode) printf '%s' "$WORKSPACE_ROOT/templates/sync/opencode-rules.md" ;;
    claude)   printf '%s' "$WORKSPACE_ROOT/templates/sync/claude-rules.md" ;;
    *)        printf 'install-agent-rules.sh: unknown agent: %s\n' "$agent_id" >&2; exit 1 ;;
  esac
}

apply=false
diff_mode=false
quiet=false
codex=false
opencode=false
claude=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --diff) diff_mode=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    --codex) codex=true ;;
    --opencode) opencode=true ;;
    --claude) claude=true ;;
    --all) codex=true; opencode=true; claude=true ;;
    *)
      printf 'install-agent-rules.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if ! $codex && ! $opencode && ! $claude; then
  codex=true; opencode=true; claude=true
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
    claude)   printf '%s' "${CLAUDE_RULES_PATH:-$HOME/.claude/CLAUDE.md}" ;;
  esac
}

target_label() {
  case "$1" in
    codex)    printf 'codex-rules' ;;
    opencode) printf 'opencode-rules' ;;
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
  local source_file
  source_file="$(composed_rules_source "$agent_id")"
  if [ ! -f "$source_file" ]; then
    printf 'install-agent-rules.sh: composed rules source not found: %s\n' "$source_file" >&2
    exit 1
  fi
  local target
  target="$(resolve_target "$agent_id")"
  local label
  label="$(target_label "$agent_id")"

  if ! $diff_mode && ! $apply; then
    if [ -f "$target" ]; then
      if cmp -s "$source_file" "$target"; then
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
      if cmp -s "$source_file" "$target"; then
        printf '%s synced\n' "$label"
      else
        printf '\n--- %s diffs (%s)\n' "$label" "$target"
        diff -u "$target" "$source_file" || true
      fi
    else
      printf '\n--- %s missing (no target file at %s)\n' "$label" "$target"
    fi
    return 0
  fi

  if $apply; then
    if [ -f "$target" ]; then
      if cmp -s "$source_file" "$target"; then
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
    cp "$source_file" "$target"
    if ! $quiet; then printf '  %s synced\n' "$label"; fi
  fi
}

if ! $quiet; then
  printf '\nAgent Rules Sync\n'
  printf '  Core: %s\n' "$CORE_RULES_FILE"
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

if $codex; then
  handle_target codex || exit_code=$?
fi
if $opencode; then
  handle_target opencode || exit_code=$?
fi
if $claude; then
  handle_target claude || exit_code=$?
fi

exit "$exit_code"
