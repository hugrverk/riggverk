#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/platform-paths.sh
. "$WORKSPACE_ROOT/scripts/lib/platform-paths.sh"
OPENCODE_AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/agents"
CLAUDE_AGENTS_SOURCE_DIR="$WORKSPACE_ROOT/templates/claude/agents"

# sha256 digests of every shipped legacy opencode agents/scout.md. Mirrors the
# "legacy-agent:scout" entry in metadata/pre-manifest-ownership.json (kept in
# sync by scripts/check-workspace-script-safety.sh). A scout.md with any other
# content is user-owned and is never removed.
LEGACY_SCOUT_DIGESTS="
00cc1fa1ec47f238666191da79ace0ee87790b768b98bd2ba301ffe8103d24b3
2d571dac16d22d23473bdebfb420d8739e10b01067b22df1eeb663afa6291899
38407b682596b59dcbd4afbd9a32fa5e286ee4e0d03bc17ac255177fd9681389
7737474371281133f4e17ad5d5a5fdeb122e719b1d3cc578f6ad33d68fa2a643
8544815305fcb8b268b62819aeae651a0bab165f66b0e48c8b76a378009202db
884eda50e09a4443ce1c6126029f62858bf575329975c90453824a9eea66d37e
aa97cad13698de2f48a2a94aaee5579590d979473b3ae8e964968321cf1e30b1
c4499de0f476f3696d7a7d188ed4302c9b38ff17016c7da9ea007cea1d969bf2
ca3c89ef4523448377c991ab93723ffd5190461efd23e52e2cd30179ad6c73f6
d2fd23544891acfd8a610eb1b28b33197d8966db416d9ac443daf3af8c2d66ea
f29ab6de021112772273fd66c440bd3e17343725f91b533cec7269b69277fd54
f7b81c4e41b5fbb329f895f43e071dd71982975dc7f401a0a37aad4169a3fa34
"

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

BACKUP_ROOT="$(agent_workspace_backup_root)" || exit 1
agent_workspace_refuse_broad_backup_root "$BACKUP_ROOT" "install-runtime-agents.sh" || exit 1

# python3 stages the Claude payloads and digests the legacy scout file. A missing
# python3 (or the macOS stub that is not backed by developer tools) must stop the
# run before anything is written.
if ! python3 -c 'import sys' >/dev/null 2>&1; then
  printf 'install-runtime-agents.sh: python3 is required but was not found or does not run\n' >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

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

is_legacy_aw_scout() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  python3 - "$file" "$LEGACY_SCOUT_DIGESTS" <<'PY'
import hashlib
import sys
from pathlib import Path

digest = hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()
sys.exit(0 if digest in sys.argv[2].split() else 1)
PY
}

handle_legacy_opencode_scout() {
  local target_dir="$1"
  local legacy="$target_dir/scout.md"
  is_legacy_aw_scout "$legacy" || return 0

  if $apply; then
    local ts backup_dir
    ts="$(date -u +%Y%m%d-%H%M%S)" || return 1
    backup_dir="$BACKUP_ROOT/$ts/opencode-agents"
    if ! mkdir -p "$backup_dir" || ! cp "$legacy" "$backup_dir/scout.md" || ! cmp -s "$legacy" "$backup_dir/scout.md"; then
      printf 'install-runtime-agents.sh: backup of legacy scout.md failed; left in place: %s\n' "$legacy" >&2
      return 1
    fi
    rm -f "$legacy" || return 1
    if ! $quiet; then printf '  opencode-agents removed legacy scout.md (backed up)\n'; fi
    return 0
  fi

  if $diff_mode; then
    printf '\n--- opencode-agents legacy scout.md removable (%s)\n' "$legacy"
    return 0
  fi

  if ! $quiet; then printf '  opencode-agents legacy scout.md present (use --apply to remove)\n'; fi
  return 1
}

# Refuse unsafe agent target directories (must be a dedicated agents folder, not home root).
refuse_unsafe_agents_dir() {
  local dir="$1" label="$2"
  agent_workspace_refuse_unsafe_agents_dir "$dir" "$label agents dir" "install-runtime-agents.sh" || exit 1
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
  rm -f "$dest"
  if [ "$harness" = "opencode" ]; then
    cp "$src" "$dest" || return 1
  else
    python3 - "$src" "$dest" "$(agent_stem "$src")" <<'PY' || return 1
import re
import sys
from pathlib import Path

src, dest, stem = sys.argv[1], sys.argv[2], sys.argv[3]
text = Path(src).read_text(encoding="utf-8")
if not text.startswith("---"):
    Path(dest).write_text(text, encoding="utf-8")
    sys.exit(0)
end = text.find("\n---", 3)
if end == -1:
    Path(dest).write_text(text, encoding="utf-8")
    sys.exit(0)
front = text[: end + 4]
body = text[end + 4 :]
if re.search(r"^name:\s*", front, re.MULTILINE):
    Path(dest).write_text(text, encoding="utf-8")
else:
    close = front.rfind("\n---")
    if close == -1:
        Path(dest).write_text(text, encoding="utf-8")
    else:
        injected = front[:close] + f"\nname: {stem}\n" + front[close:] + body
        Path(dest).write_text(injected, encoding="utf-8")
PY
  fi
  if [ ! -s "$dest" ]; then
    printf 'install-runtime-agents.sh: staging produced an empty agent file for %s; nothing written\n' "$src" >&2
    return 1
  fi
}

handle_harness() {
  local harness="$1" target_dir="$2"
  local label
  label="$(target_label "$harness")"
  refuse_unsafe_agents_dir "$target_dir" "$harness"

  if ! $diff_mode && ! $apply; then
    local any_issue=false
    if [ "$harness" = "opencode" ]; then
      handle_legacy_opencode_scout "$target_dir" || any_issue=true
    fi
    while IFS= read -r agent_src || [ -n "$agent_src" ]; do
      [ -n "$agent_src" ] || continue
      local agent_name agent_target staged
      agent_name="$(agent_basename "$agent_src")"
      agent_target="$target_dir/$agent_name"
      staged="$STAGE_DIR/$agent_name"
      stage_agent_payload "$agent_src" "$staged" "$harness" || return 1
      if [ -f "$agent_target" ] && cmp -s "$staged" "$agent_target"; then
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
    if [ "$harness" = "opencode" ]; then
      if is_legacy_aw_scout "$target_dir/scout.md"; then
        printf '\n--- opencode-agents legacy scout.md removable (%s)\n' "$target_dir/scout.md"
        has_diffs=true
      fi
    fi
    while IFS= read -r agent_src || [ -n "$agent_src" ]; do
      [ -n "$agent_src" ] || continue
      local agent_name agent_target staged
      agent_name="$(agent_basename "$agent_src")"
      agent_target="$target_dir/$agent_name"
      staged="$STAGE_DIR/$agent_name"
      stage_agent_payload "$agent_src" "$staged" "$harness" || return 1
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
    done < <(list_agent_files "$harness")
    if ! $has_diffs && $quiet; then
      printf '%s synced\n' "$label"
    fi
    # Preview differences are expected output, not an execution failure.
    return 0
  fi

  # handle_harness runs on the left of `||`, where bash ignores `set -e`: every
  # mutating step below checks its own status, and an agent file is only
  # overwritten after its backup was copied and verified.
  if $apply; then
    mkdir -p "$target_dir" || return 1
    local ts
    ts="$(date -u +%Y%m%d-%H%M%S)" || return 1
    if [ "$harness" = "opencode" ]; then
      handle_legacy_opencode_scout "$target_dir" || return 1
    fi
    while IFS= read -r agent_src || [ -n "$agent_src" ]; do
      [ -n "$agent_src" ] || continue
      local agent_name agent_target staged
      agent_name="$(agent_basename "$agent_src")"
      agent_target="$target_dir/$agent_name"
      staged="$STAGE_DIR/$agent_name"
      stage_agent_payload "$agent_src" "$staged" "$harness" || return 1
      if [ -f "$agent_target" ]; then
        if cmp -s "$staged" "$agent_target"; then
          if ! $quiet; then printf '  %s %s already synced\n' "$label" "$agent_name"; fi
        else
          local backup_dir="$BACKUP_ROOT/$ts/$label"
          if ! mkdir -p "$backup_dir" || ! cp "$agent_target" "$backup_dir/$agent_name" || ! cmp -s "$agent_target" "$backup_dir/$agent_name"; then
            printf 'install-runtime-agents.sh: %s %s backup to %s failed; target left unchanged: %s\n' "$label" "$agent_name" "$backup_dir" "$agent_target" >&2
            return 1
          fi
          cp "$staged" "$agent_target" || return 1
          if ! $quiet; then printf '  %s %s synced (backed up)\n' "$label" "$agent_name"; fi
        fi
      else
        cp "$staged" "$agent_target" || return 1
        if ! $quiet; then printf '  %s %s created\n' "$label" "$agent_name"; fi
      fi
    done < <(list_agent_files "$harness")
    if ! $quiet; then printf '  %s runtime agents applied to %s\n' "$label" "$target_dir"; fi
  fi
}

# Refuse before any write: a run that updates one harness and then refuses the other's
# agents dir would leave the runtime agents half synced.
if $opencode; then
  refuse_unsafe_agents_dir "$(resolve_opencode_dir)" opencode
fi
if $claude; then
  refuse_unsafe_agents_dir "$(resolve_claude_dir)" claude
fi

exit_code=0
if $opencode; then
  handle_harness opencode "$(resolve_opencode_dir)" || exit_code=$?
fi
if $claude; then
  handle_harness claude "$(resolve_claude_dir)" || exit_code=$?
fi
exit "$exit_code"
