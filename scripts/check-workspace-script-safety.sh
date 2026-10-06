#!/usr/bin/env bash
# Behaviour checks for the shipped CLI installer scripts
# (resources/default-workspace/scripts): dry-run by default, backup-first,
# fail-fast, no partial or empty writes. Every case runs with a clean
# environment and a temp HOME; the real home is never touched.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$repo_root/resources/default-workspace"
scripts="$workspace/scripts"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-script-safety.XXXXXX")"
mkdir -p "$tmp_root/tmp"
cleanup() {
  chmod -R u+w "$tmp_root" 2>/dev/null || true
  rm -rf "$tmp_root"
}
trap cleanup EXIT

# macOS ships bash 3.2 as /bin/bash; use it for the compatibility cases.
system_bash="/bin/bash"
[ -x "$system_bash" ] || system_bash="$(command -v bash)"

rc=0
out_log="$tmp_root/out.log"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  if [ -s "$out_log" ]; then
    printf -- '--- last output ---\n' >&2
    head -c 3000 "$out_log" >&2
  fi
  exit 1
}

# run <home> [NAME=value ...] <command> [args...]
# Clean environment (no inherited *_PATH/*_DIR overrides); output in $out_log,
# exit status in $rc.
run() {
  local home="$1"
  shift
  rc=0
  env -i PATH="$PATH" HOME="$home" TMPDIR="$tmp_root/tmp" "$@" >"$out_log" 2>&1 || rc=$?
}

assert_ok() {
  [ "$rc" -eq 0 ] || fail "$1 (exit $rc)"
}

assert_nonzero() {
  [ "$rc" -ne 0 ] || fail "$1 (expected a non-zero exit)"
}

assert_log() {
  grep -qF -- "$1" "$out_log" || fail "output missing: $1"
}

assert_no_log() {
  if grep -qF -- "$1" "$out_log"; then
    fail "output must not contain: $1"
  fi
}

assert_content() {
  [ "$(cat "$1")" = "$2" ] || fail "unexpected content in $1"
}

assert_empty_dir() {
  [ -z "$(find "$1" -mindepth 1 2>/dev/null)" ] || fail "expected nothing under $1: $(find "$1" -mindepth 1 | head -3 | tr '\n' ' ')"
}

new_home() {
  local home="$tmp_root/$1"
  mkdir -p "$home"
  printf '%s' "$home"
}

# A backup root that cannot be created (parent is a regular file).
blocked_backup_dir() {
  : >"$tmp_root/blocked-file"
  printf '%s' "$tmp_root/blocked-file/backups"
}

copy_workspace() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cp -R "$workspace" "$dest"
}

# PATH with the basic tools the installers use, but no python3 (plus an optional
# python3 stub script body passed as $2).
make_tool_path() {
  local dir="$tmp_root/$1" stub="${2:-}" tool found
  mkdir -p "$dir"
  for tool in bash env mkdir cp cmp date mktemp basename dirname find sort tr cat rm diff uname head sed grep chmod ls wc mv sh; do
    found="$(command -v "$tool" 2>/dev/null || true)"
    case "$found" in
      /*) ln -sf "$found" "$dir/$tool" ;;
    esac
  done
  if [ -n "$stub" ]; then
    printf '%s\n' "$stub" >"$dir/python3"
    chmod +x "$dir/python3"
  fi
  printf '%s' "$dir"
}

# --- every install script is dry-run unless --apply is given ----------------

test_dry_run_default() {
  local home
  home="$(new_home h-dry)"
  local name args
  for name in \
    "install-agent-rules.sh" \
    "install-runtime-agents.sh" \
    "install-skills.sh --agent claude --global" \
    "install-codex-config.sh" \
    "install-codex-agents.sh" \
    "install-opencode-config.sh" \
    "bootstrap.sh"; do
    args="${name#* }"
    [ "$args" = "$name" ] && args=""
    name="${name%% *}"
    # shellcheck disable=SC2086
    run "$home" PLAYWRIGHT_BROWSERS_PATH="$home/ms-playwright" "$scripts/$name" $args
    assert_empty_dir "$home"
  done
  run "$home" "$scripts/install-cursor-workspace.sh"
  assert_nonzero "install-cursor-workspace.sh without an action must not run"
  assert_empty_dir "$home"
  run "$home" "$scripts/install-skills.sh" --agent claude --global
  assert_ok "install-skills.sh default run"
  assert_log "dry-run"
  run "$home" "$scripts/install-skills.sh" --apply --dry-run
  assert_nonzero "--apply with --dry-run must be rejected"
}

# --- A1: a failed backup never overwrites the target ------------------------

test_rules_backup_failure() {
  local home
  home="$(new_home h-rules)"
  mkdir -p "$home/.claude" "$home/.codex" "$home/.config/opencode"
  printf 'user claude rules\n' >"$home/.claude/CLAUDE.md"
  printf 'user codex rules\n' >"$home/.codex/AGENTS.md"
  printf 'user opencode rules\n' >"$home/.config/opencode/AGENTS.md"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$(blocked_backup_dir)" "$scripts/install-agent-rules.sh" --all --apply --quiet
  assert_nonzero "install-agent-rules.sh must fail when the backup cannot be written"
  assert_log "backup"
  assert_content "$home/.claude/CLAUDE.md" "user claude rules"
  assert_content "$home/.codex/AGENTS.md" "user codex rules"
  assert_content "$home/.config/opencode/AGENTS.md" "user opencode rules"

  local backups="$tmp_root/rules-backups" backup_file
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$backups" "$scripts/install-agent-rules.sh" --claude --apply --quiet
  assert_ok "install-agent-rules.sh --claude --apply with a writable backup dir"
  cmp -s "$workspace/templates/sync/claude-rules.md" "$home/.claude/CLAUDE.md" || fail "CLAUDE.md was not synced"
  backup_file="$(find "$backups" -path '*claude-rules*' -name CLAUDE.md -type f | head -1)"
  [ -n "$backup_file" ] || fail "no CLAUDE.md backup written under $backups"
  assert_content "$backup_file" "user claude rules"
}

test_runtime_agents_backup_failure() {
  local home
  home="$(new_home h-agents)"
  mkdir -p "$home/.claude/agents" "$home/.config/opencode/agents"
  printf 'user claude agent\n' >"$home/.claude/agents/inspector.md"
  printf 'user opencode agent\n' >"$home/.config/opencode/agents/architect.md"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$(blocked_backup_dir)" "$scripts/install-runtime-agents.sh" --all --apply --quiet
  assert_nonzero "install-runtime-agents.sh must fail when the backup cannot be written"
  assert_content "$home/.claude/agents/inspector.md" "user claude agent"
  assert_content "$home/.config/opencode/agents/architect.md" "user opencode agent"
}

# --- A2: missing/broken python3 must not produce empty agent files ----------

test_runtime_agents_without_python() {
  local home path_dir
  home="$(new_home h-nopy)"
  path_dir="$(make_tool_path nopy-bin)"
  run "$home" PATH="$path_dir" "$scripts/install-runtime-agents.sh" --claude --apply --quiet
  assert_nonzero "install-runtime-agents.sh must fail without python3"
  assert_log "python3 is required"
  assert_empty_dir "$home"

  # python3 that starts but produces nothing (e.g. a broken interpreter).
  home="$(new_home h-badpy)"
  path_dir="$(make_tool_path badpy-bin '#!/bin/sh
exit 0')"
  run "$home" PATH="$path_dir" "$scripts/install-runtime-agents.sh" --claude --apply --quiet
  assert_nonzero "install-runtime-agents.sh must fail when staging produces nothing"
  [ -z "$(find "$home" -type f -size 0 2>/dev/null)" ] || fail "0-byte agent file was written"

  # The macOS developer-tools stub exits non-zero.
  home="$(new_home h-stubpy)"
  path_dir="$(make_tool_path stubpy-bin '#!/bin/sh
exit 1')"
  run "$home" PATH="$path_dir" "$scripts/install-runtime-agents.sh" --claude --apply --quiet
  assert_nonzero "install-runtime-agents.sh must fail with a non-working python3"
  assert_empty_dir "$home"
}

# --- A3: legacy scout.md is removed only when it is a known shipped file ----

test_legacy_scout() {
  local home ws backup_dir digest
  home="$(new_home h-scout)"
  mkdir -p "$home/.config/opencode/agents"
  printf -- '---\nname: scout\n---\nmy own scout agent\n' >"$home/.config/opencode/agents/scout.md"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$tmp_root/scout-backups-a" "$scripts/install-runtime-agents.sh" --opencode --apply --quiet
  assert_ok "install-runtime-agents.sh --opencode --apply"
  assert_content "$home/.config/opencode/agents/scout.md" "$(printf -- '---\nname: scout\n---\nmy own scout agent')"
  run "$home" "$scripts/install-runtime-agents.sh" --opencode --diff
  assert_no_log "legacy scout.md removable"

  # A workspace copy that treats a fixture file as the known legacy content.
  ws="$tmp_root/ws-scout"
  copy_workspace "$ws"
  printf 'legacy scout fixture\n' >"$tmp_root/legacy-scout.md"
  digest="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$tmp_root/legacy-scout.md")"
  python3 - "$ws/scripts/install-runtime-agents.sh" "$digest" <<'PY'
import re
import sys
from pathlib import Path

path, digest = Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
patched, count = re.subn(r"^[0-9a-f]{64}$", digest, text, count=1, flags=re.MULTILINE)
assert count == 1, "digest list not found"
path.write_text(patched, encoding="utf-8")
PY
  home="$(new_home h-scout-legacy)"
  mkdir -p "$home/.config/opencode/agents"
  cp "$tmp_root/legacy-scout.md" "$home/.config/opencode/agents/scout.md"
  # Failed backup: the file stays.
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$(blocked_backup_dir)" "$ws/scripts/install-runtime-agents.sh" --opencode --apply --quiet
  assert_nonzero "legacy scout removal must fail when its backup fails"
  [ -f "$home/.config/opencode/agents/scout.md" ] || fail "legacy scout.md was removed without a backup"
  # Working backup: removed, backup is identical.
  backup_dir="$tmp_root/scout-backups-b"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$backup_dir" "$ws/scripts/install-runtime-agents.sh" --opencode --apply --quiet
  assert_ok "legacy scout removal with a working backup"
  [ ! -e "$home/.config/opencode/agents/scout.md" ] || fail "known legacy scout.md was not removed"
  cmp -s "$tmp_root/legacy-scout.md" "$(find "$backup_dir" -name scout.md -type f | head -1)" || fail "legacy scout.md backup is missing or differs"
}

test_legacy_scout_digests_match_ownership_metadata() {
  python3 - "$scripts/install-runtime-agents.sh" "$workspace/metadata/pre-manifest-ownership.json" <<'PY' || fail "LEGACY_SCOUT_DIGESTS in install-runtime-agents.sh differs from legacy-agent:scout in pre-manifest-ownership.json"
import json
import re
import sys
from pathlib import Path

script = Path(sys.argv[1]).read_text(encoding="utf-8")
block = re.search(r'LEGACY_SCOUT_DIGESTS="(.*?)"', script, re.DOTALL).group(1)
in_script = set(block.split())
data = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
entry = next(a for a in data["artifacts"] if a["identity"] == "legacy-agent:scout")
in_metadata = {d.removeprefix("sha256:") for d in entry["digests"]}
if in_script != in_metadata:
    print(f"only in script: {sorted(in_script - in_metadata)}", file=sys.stderr)
    print(f"only in metadata: {sorted(in_metadata - in_script)}", file=sys.stderr)
    sys.exit(1)
PY
}

# --- A6: install-skills backup, per-skill failure, discovery errors ---------

test_install_skills() {
  local home backups first first_dir second skill_count installed_count backup_file
  home="$(new_home h-skills)"
  backups="$tmp_root/skills-backups"
  skill_count="$(find "$workspace/skills" -name SKILL.md -type f | wc -l | tr -d ' ')"

  run "$home" "$scripts/install-skills.sh" --agent claude --global --all --quiet
  assert_ok "install-skills.sh default (dry-run)"
  [ ! -e "$home/.claude" ] || fail "install-skills.sh wrote files without --apply"

  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$backups" "$scripts/install-skills.sh" --agent claude --global --all --apply --quiet
  assert_ok "install-skills.sh --apply"
  installed_count="$(find "$home/.claude/skills" -name SKILL.md -type f | wc -l | tr -d ' ')"
  [ "$installed_count" = "$skill_count" ] || fail "installed $installed_count skills, canonical tree has $skill_count"
  [ ! -e "$backups" ] || fail "fresh install must not create backups"

  first="$(ls "$home/.claude/skills" | head -1)"
  second="$(ls "$home/.claude/skills" | sed -n 2p)"
  first_dir="$home/.claude/skills/$first"
  printf 'local edit\n' >>"$first_dir/SKILL.md"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$backups" "$scripts/install-skills.sh" --agent claude --global --all --apply --quiet
  assert_ok "install-skills.sh --apply over an edited SKILL.md"
  backup_file="$(find "$backups" -path "*claude-skills/$first/SKILL.md" -type f | head -1)"
  [ -n "$backup_file" ] || fail "edited SKILL.md was overwritten without a backup"
  grep -qF 'local edit' "$backup_file" || fail "backup does not hold the edited SKILL.md"
  ! grep -qF 'local edit' "$first_dir/SKILL.md" || fail "SKILL.md was not refreshed"

  # Backup failure: the edited file stays.
  printf 'local edit\n' >>"$first_dir/SKILL.md"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$(blocked_backup_dir)" "$scripts/install-skills.sh" --agent claude --global --all --apply --quiet
  assert_nonzero "install-skills.sh must fail when the backup cannot be written"
  grep -qF 'local edit' "$first_dir/SKILL.md" || fail "SKILL.md was overwritten although its backup failed"

  # One failing skill does not abort the others (skipped as root, where chmod does not block writes).
  if [ "$(id -u)" -ne 0 ]; then
    printf 'local edit\n' >>"$home/.claude/skills/$second/SKILL.md"
    chmod a-w "$first_dir/SKILL.md" "$home/.claude/skills/$second/SKILL.md"
    run "$home" AGENT_WORKSPACE_BACKUP_DIR="$backups" "$scripts/install-skills.sh" --agent claude --global --all --apply --quiet
    assert_nonzero "install-skills.sh must exit non-zero when a skill cannot be written"
    assert_log "FAIL $first"
    assert_log "FAIL $second"
    [ "$(grep -c 'OK ' "$out_log")" -eq $((skill_count - 2)) ] || fail "remaining skills were not installed after a failure"
    chmod u+w "$first_dir/SKILL.md" "$home/.claude/skills/$second/SKILL.md"
  fi
}

test_install_skills_discovery_errors() {
  local home ws first
  home="$(new_home h-skills-list)"
  ws="$tmp_root/ws-skills"
  copy_workspace "$ws"
  first="$(find "$ws/skills" -maxdepth 2 -name SKILL.md -type f | sort | head -1)"
  python3 - "$first" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
patched, count = re.subn(r"^name:.*$", "name: Bad Name", text, count=1, flags=re.MULTILINE)
assert count == 1, "name key not found"
path.write_text(patched, encoding="utf-8")
PY
  run "$home" "$ws/scripts/install-skills.sh" --list
  assert_nonzero "install-skills.sh --list must surface discovery errors"
  assert_log "invalid skill name"
  assert_no_log "No skills installed"

  # A symlinked skill directory is rejected.
  ws="$tmp_root/ws-skills-link"
  copy_workspace "$ws"
  mv "$ws/skills/tdd" "$tmp_root/tdd-real"
  ln -s "$tmp_root/tdd-real" "$ws/skills/tdd"
  run "$home" "$ws/scripts/install-skills.sh" --list
  assert_nonzero "install-skills.sh must reject symlinked skill directories"
  assert_log "symlinked skill"

  # An empty skills tree is a normal, successful --list.
  ws="$tmp_root/ws-skills-empty"
  copy_workspace "$ws"
  rm -rf "$ws/skills"
  mkdir -p "$ws/skills"
  run "$home" "$ws/scripts/install-skills.sh" --list
  assert_ok "install-skills.sh --list on an empty skills tree"
  assert_log "No skills installed"
}

# --- A4: bootstrap.sh under the system bash (3.2 on macOS) -------------------

test_bootstrap_modes() {
  local home mode
  home="$(new_home h-boot)"
  for mode in "" "--diff" "--skills-only" "--rules-only" "--opencode-only" "--codex-only" "--codex" "--quiet" "--agent claude --skills-only"; do
    # shellcheck disable=SC2086
    run "$home" PLAYWRIGHT_BROWSERS_PATH="$home/ms-playwright" "$system_bash" "$scripts/bootstrap.sh" $mode
    assert_ok "bootstrap.sh $mode"
    assert_no_log "unbound variable"
  done
  assert_empty_dir "$home"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$tmp_root/boot-backups" "$system_bash" "$scripts/bootstrap.sh" --apply --skills-only --agent claude --quiet
  assert_ok "bootstrap.sh --apply --skills-only"
  [ -f "$home/.claude/skills/tdd/SKILL.md" ] || fail "bootstrap.sh --apply did not install skills"
}

# --- A5: workspace paths with quotes reach python intact --------------------

test_codex_diff_paths() {
  local home ws
  home="$(new_home h-codex)"
  ws="$tmp_root/O'Neil/ws"
  copy_workspace "$ws"
  mkdir -p "$home/.codex"
  printf 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n' >"$home/.codex/config.toml"
  run "$home" "$ws/scripts/install-codex-config.sh" --diff
  assert_ok "install-codex-config.sh --diff from a path with an apostrophe"
  assert_log "would change"
  assert_no_log "SyntaxError"

  # A broken helper input is reported instead of being swallowed.
  rm "$ws/metadata/codex-managed-keys.json"
  run "$home" "$ws/scripts/install-codex-config.sh" --diff
  assert_nonzero "install-codex-config.sh --diff must not hide a failed diff"
}

test_opencode_diff_paths() {
  local home ws
  home="$(new_home h-opencode-diff)"
  ws="$tmp_root/O'Neil/ws-opencode"
  copy_workspace "$ws"
  mkdir -p "$home/.config/opencode"
  printf '{"model": "someone/else"}\n' >"$home/.config/opencode/opencode.json"
  run "$home" PLAYWRIGHT_BROWSERS_PATH="$home/ms-playwright" "$ws/scripts/install-opencode-config.sh" --diff --config-only
  assert_ok "install-opencode-config.sh --diff from a path with an apostrophe"
  assert_log "managed key"
  assert_no_log "SyntaxError"
  rm "$ws/metadata/opencode-managed-keys.json"
  run "$home" PLAYWRIGHT_BROWSERS_PATH="$home/ms-playwright" "$ws/scripts/install-opencode-config.sh" --diff --config-only
  assert_nonzero "install-opencode-config.sh --diff must not hide a failed diff"
}

# --- A8: agents-dir guards ---------------------------------------------------

test_agents_dir_guards() {
  local home dir
  home="$(new_home h-guard)"
  for dir in "$home" "$home/" "$home//" "$home/." "$home/.config" "/" ""; do
    run "$home" PLAYWRIGHT_BROWSERS_PATH="$home/ms-playwright" \
      OPENCODE_CONFIG_PATH="$home/oc/opencode.json" OPENCODE_TUI_CONFIG_PATH="$home/oc/tui.json" \
      PLAYWRIGHT_MCP_CONFIG_PATH="$home/pw/config.json" \
      OPENCODE_AGENTS_DIR="$dir" "$scripts/install-opencode-config.sh" --apply --quiet
    assert_nonzero "install-opencode-config.sh accepted OPENCODE_AGENTS_DIR='$dir'"
    assert_log "refusing"
    assert_empty_dir "$home"
  done
  for dir in "$home" "$home//" "$home/." "/"; do
    run "$home" CLAUDE_AGENTS_DIR="$dir" "$scripts/install-runtime-agents.sh" --claude --apply --quiet
    assert_nonzero "install-runtime-agents.sh accepted CLAUDE_AGENTS_DIR='$dir'"
    assert_log "refusing unsafe claude agents dir"
    assert_empty_dir "$home"
    run "$home" CODEX_AGENTS_DIR="$dir" "$scripts/install-codex-agents.sh" --apply --quiet
    assert_nonzero "install-codex-agents.sh accepted CODEX_AGENTS_DIR='$dir'"
    assert_log "refusing unsafe CODEX_AGENTS_DIR"
    assert_empty_dir "$home"
  done
}

# HOME (here a symlinked temp path) must be refused as a project target even
# when it carries a project marker.
test_broad_project_targets() {
  local home
  home="$(new_home h-broad)"
  mkdir -p "$home/.git"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$tmp_root/broad-backups" "$scripts/install-skills.sh" --project --target "$home" --apply --quiet
  assert_nonzero "install-skills.sh must refuse HOME as a project target"
  assert_log "refusing broad project target"
  run "$home" AGENT_WORKSPACE_BACKUP_DIR="$tmp_root/broad-backups" "$scripts/install-cursor-workspace.sh" --project --target "$home" --apply --quiet
  assert_nonzero "install-cursor-workspace.sh must refuse HOME as a project target"
  assert_log "refusing broad project target"
  [ ! -e "$home/.cursor" ] && [ ! -e "$home/.claude" ] && [ ! -e "$home/.opencode" ] || fail "a broad project target was written"
}

test_playwright_guard_home_paths() {
  local ws
  ws="$tmp_root/ws-playwright"
  copy_workspace "$ws"
  run "$tmp_root" "$ws/scripts/check-playwright-mcp.sh"
  assert_ok "check-playwright-mcp.sh on the shipped templates"
  printf '{"path": "/Users/someone-else/project"}\n' >"$ws/templates/leaked-home.json"
  run "$tmp_root" "$ws/scripts/check-playwright-mcp.sh"
  assert_nonzero "check-playwright-mcp.sh must flag a hardcoded home directory"
  assert_log "hardcoded"
}

all_tests="
test_dry_run_default
test_rules_backup_failure
test_runtime_agents_backup_failure
test_runtime_agents_without_python
test_legacy_scout
test_legacy_scout_digests_match_ownership_metadata
test_install_skills
test_install_skills_discovery_errors
test_bootstrap_modes
test_codex_diff_paths
test_opencode_diff_paths
test_agents_dir_guards
test_broad_project_targets
test_playwright_guard_home_paths
"

# Optional arguments select individual cases (useful for mutation checks).
selected="${*:-$all_tests}"
for test_name in $selected; do
  "$test_name"
done

printf 'workspace script safety checks passed\n'
