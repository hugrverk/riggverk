#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/platform-paths.sh
. "$WORKSPACE_ROOT/scripts/lib/platform-paths.sh"
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

A rules file that already holds the Agent Workspace base block
(<!-- BEGIN AGENT-WORKSPACE BASE ... END AGENT-WORKSPACE BASE -->) is managed by
the app. This script never writes such a file: --apply refuses, and the other
modes only report it. Update it, or convert a hand-edited one, in the app
(Convert on the harness page); that keeps your text outside the block.
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

BACKUP_ROOT="$(agent_workspace_backup_root)" || exit 1
agent_workspace_refuse_broad_backup_root "$BACKUP_ROOT" "install-agent-rules.sh" || exit 1

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

# The block markers the app writes. Matched anywhere on a line, so a stray BOM, indent or fence still counts:
# refusing a file that only quotes a marker is safe, writing over a managed block is not.
has_managed_block() {
  [ -f "$1" ] && LC_ALL=C grep -aEq '<!-- (BEGIN|END) AGENT-WORKSPACE BASE' "$1"
}

refuse_managed_block() {
  printf 'install-agent-rules.sh: %s holds the Agent Workspace base block and is managed by the app; this script would drop the block and your refinements, so nothing was written. Update it in the app, or use Convert on the harness page for a hand-edited file.\n' "$1" >&2
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

  if ! $apply && has_managed_block "$target"; then
    printf '  %s managed by the app (base block); not compared here, update it in the app\n' "$label"
    return 0
  fi

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

  # handle_target runs on the left of `||`, where bash ignores `set -e`: every
  # mutating step below checks its own status, and the target is never written
  # unless its backup was copied and verified.
  if $apply; then
    if has_managed_block "$target"; then
      refuse_managed_block "$target"
      return 1
    fi
    if [ -f "$target" ]; then
      if cmp -s "$source_file" "$target"; then
        if ! $quiet; then printf '  %s already synced\n' "$label"; fi
        return 0
      fi
      local ts
      ts="$(date -u +%Y%m%d-%H%M%S)" || return 1
      local backup_dir="$BACKUP_ROOT/$ts/$label"
      local backup_file="$backup_dir/$(basename "$target")"
      if ! mkdir -p "$backup_dir" || ! cp "$target" "$backup_file" || ! cmp -s "$target" "$backup_file"; then
        printf 'install-agent-rules.sh: %s backup to %s failed; target left unchanged: %s\n' "$label" "$backup_file" "$target" >&2
        return 1
      fi
      if ! $quiet; then printf '  %s backed up to %s\n' "$label" "$backup_file"; fi
    else
      mkdir -p "$(dirname "$target")" || return 1
      if ! $quiet; then printf '  %s creating new\n' "$label"; fi
    fi
    cp "$source_file" "$target" || {
      printf 'install-agent-rules.sh: %s write failed: %s\n' "$label" "$target" >&2
      return 1
    }
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

# Refuse before any write: a run that updates one target and refuses another would leave the rules half synced.
if $apply; then
  managed_found=false
  for agent_id in codex opencode claude; do
    case "$agent_id" in
      codex)    selected=$codex ;;
      opencode) selected=$opencode ;;
      claude)   selected=$claude ;;
    esac
    if $selected && has_managed_block "$(resolve_target "$agent_id")"; then
      refuse_managed_block "$(resolve_target "$agent_id")"
      managed_found=true
    fi
  done
  if $managed_found; then
    exit 1
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
