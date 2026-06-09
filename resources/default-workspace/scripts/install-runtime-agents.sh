#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/agents"
CLAUDE_AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/templates/claude/agents"

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-runtime-agents.sh [options]

Sync harness-native runtime agents to OpenCode and Claude agent directories.

Targets:
  --opencode   ~/.config/opencode/agents/*.md
  --claude     ~/.claude/agents/*.md (adds name: frontmatter when missing)

Options:
  --apply      Write target files
  --diff       Show diff without writing
  --quiet      Print compact app-friendly output
  --help       Show this help

Environment overrides:
  OPENCODE_AGENTS_DIR
  CLAUDE_AGENTS_DIR
  AGENT_WORKSPACE_BACKUP_DIR

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -d "$OPENCODE_AGENTS_SOURCE_DIR" ]; then
  printf 'install-runtime-agents.sh: OpenCode agents source dir not found: %s\n' "$OPENCODE_AGENTS_SOURCE_DIR" >&2
  exit 1
fi
if [ ! -d "$CLAUDE_AGENTS_SOURCE_DIR" ]; then
  printf 'install-runtime-agents.sh: Claude agents source dir not found: %s\n' "$CLAUDE_AGENTS_SOURCE_DIR" >&2
  exit 1
fi

apply=false
diff_mode=false
quiet=false
opencode=false
claude=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --diff) diff_mode=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    --opencode) opencode=true ;;
    --claude) claude=true ;;
    --all) opencode=true; claude=true ;;
    *)
      printf 'install-runtime-agents.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if ! $opencode && ! $claude; then
  opencode=true
  claude=true
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
  /|"$HOME"|"") printf 'install-runtime-agents.sh: refusing broad backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

agents_source_dir() {
  case "$1" in
    opencode) printf '%s' "$OPENCODE_AGENTS_SOURCE_DIR" ;;
    claude) printf '%s' "$CLAUDE_AGENTS_SOURCE_DIR" ;;
  esac
}

list_agent_files() {
  local harness="$1"
  local source_dir
  source_dir="$(agents_source_dir "$harness")"
  if [ -d "$source_dir" ]; then
    find "$source_dir" -maxdepth 1 -name '*.md' -type f -print0 | sort -z | tr '\0' '\n'
  fi
}

agent_basename() {
  basename "$1"
}

agent_stem() {
  local name
  name="$(agent_basename "$1")"
  printf '%s' "${name%.md}"
}

# Refuse unsafe agent target directories (must be a dedicated agents folder, not home root).
refuse_unsafe_agents_dir() {
  local dir="$1" label="$2"
  if [ -z "$dir" ]; then
    printf 'install-runtime-agents.sh: refusing empty %s agents dir\n' "$label" >&2
    exit 1
  fi
  case "$dir" in
    /|"$HOME"|"$HOME/"|"$HOME/.config"|"$HOME/.claude")
      printf 'install-runtime-agents.sh: refusing unsafe %s agents dir: %s\n' "$label" "$dir" >&2
      exit 1
      ;;
  esac
}

resolve_opencode_dir() {
  printf '%s' "${OPENCODE_AGENTS_DIR:-$HOME/.config/opencode/agents}"
}

resolve_claude_dir() {
  printf '%s' "${CLAUDE_AGENTS_DIR:-$HOME/.claude/agents}"
}

target_label() {
  case "$1" in
    opencode) printf 'opencode-agents' ;;
    claude) printf 'claude-agents' ;;
  esac
}

# For Claude: ensure YAML frontmatter includes name: <stem> when absent.
stage_agent_payload() {
  local src="$1" dest="$2" harness="$3"
  if [ "$harness" = "opencode" ]; then
    cp "$src" "$dest"
    return 0
  fi
  python3 - "$src" "$dest" "$(agent_stem "$src")" <<'PY'
import re
import sys
from pathlib import Path

src, dest, stem = sys.argv[1], sys.argv[2], sys.argv[3]
text = Path(src).read_text()
if not text.startswith("---"):
    Path(dest).write_text(text)
    sys.exit(0)
end = text.find("\n---", 3)
if end == -1:
    Path(dest).write_text(text)
    sys.exit(0)
front = text[: end + 4]
body = text[end + 4 :]
if re.search(r"^name:\s*", front, re.MULTILINE):
    Path(dest).write_text(text)
else:
    close = front.rfind("\n---")
    if close == -1:
        Path(dest).write_text(text)
    else:
        injected = front[:close] + f"\nname: {stem}\n" + front[close:] + body
        Path(dest).write_text(injected)
PY
}

compare_agent() {
  local src="$1" target="$2" harness="$3"
  local staged
  staged="$(mktemp)"
  stage_agent_payload "$src" "$staged" "$harness"
  if [ -f "$target" ] && cmp -s "$staged" "$target"; then
    rm -f "$staged"
    return 0
  fi
  rm -f "$staged"
  return 1
}

handle_harness() {
  local harness="$1" target_dir="$2"
  local label
  label="$(target_label "$harness")"
  refuse_unsafe_agents_dir "$target_dir" "$harness"

  if ! $diff_mode && ! $apply; then
    local any_issue=false
    while IFS= read -r agent_src || [ -n "$agent_src" ]; do
      [ -n "$agent_src" ] || continue
      local agent_name agent_target
      agent_name="$(agent_basename "$agent_src")"
      agent_target="$target_dir/$agent_name"
      if [ -f "$agent_target" ] && compare_agent "$agent_src" "$agent_target" "$harness"; then
        if ! $quiet; then printf '  %s %s synced\n' "$label" "$agent_name"; fi
      elif [ -f "$agent_target" ]; then
        if ! $quiet; then printf '  %s %s diverged (use --apply to sync)\n' "$label" "$agent_name"; fi
        any_issue=true
      else
        if ! $quiet; then printf '  %s %s missing (use --apply to create)\n' "$label" "$agent_name"; fi
        any_issue=true
      fi
    done < <(list_agent_files "$harness")
    $any_issue && return 1 || return 0
  fi

  if $diff_mode; then
    local has_diffs=false
    while IFS= read -r agent_src || [ -n "$agent_src" ]; do
      [ -n "$agent_src" ] || continue
      local agent_name agent_target staged
      agent_name="$(agent_basename "$agent_src")"
      agent_target="$target_dir/$agent_name"
      staged="$(mktemp)"
      stage_agent_payload "$agent_src" "$staged" "$harness"
      if [ -f "$agent_target" ]; then
        if ! cmp -s "$staged" "$agent_target"; then
          printf '\n--- %s %s diffs (%s)\n' "$label" "$agent_name" "$agent_target"
          diff -u "$agent_target" "$staged" || true
          has_diffs=true
        elif ! $quiet; then
          printf '  %s %s synced\n' "$label" "$agent_name"
        fi
      else
        printf '\n--- %s %s missing (no target at %s)\n' "$label" "$agent_name" "$agent_target"
        has_diffs=true
      fi
      rm -f "$staged"
    done < <(list_agent_files "$harness")
    if ! $has_diffs && $quiet; then
      printf '%s synced\n' "$label"
    fi
    # Preview differences are expected output, not an execution failure.
    return 0
  fi

  if $apply; then
    mkdir -p "$target_dir"
    local ts
    ts="$(date -u +%Y%m%d-%H%M%S)"
    while IFS= read -r agent_src || [ -n "$agent_src" ]; do
      [ -n "$agent_src" ] || continue
      local agent_name agent_target staged
      agent_name="$(agent_basename "$agent_src")"
      agent_target="$target_dir/$agent_name"
      staged="$(mktemp)"
      stage_agent_payload "$agent_src" "$staged" "$harness"
      if [ -f "$agent_target" ]; then
        if cmp -s "$staged" "$agent_target"; then
          if ! $quiet; then printf '  %s %s already synced\n' "$label" "$agent_name"; fi
        else
          local backup_dir="$BACKUP_ROOT/$ts/$label"
          mkdir -p "$backup_dir"
          cp "$agent_target" "$backup_dir/$agent_name"
          cp "$staged" "$agent_target"
          if ! $quiet; then printf '  %s %s synced (backed up)\n' "$label" "$agent_name"; fi
        fi
      else
        cp "$staged" "$agent_target"
        if ! $quiet; then printf '  %s %s created\n' "$label" "$agent_name"; fi
      fi
      rm -f "$staged"
    done < <(list_agent_files "$harness")
    if ! $quiet; then printf '  %s runtime agents applied to %s\n' "$label" "$target_dir"; fi
  fi
}

exit_code=0
if $opencode; then
  handle_harness opencode "$(resolve_opencode_dir)" || exit_code=$?
fi
if $claude; then
  handle_harness claude "$(resolve_claude_dir)" || exit_code=$?
fi
exit "$exit_code"
