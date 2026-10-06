#!/usr/bin/env bash
# Preview/apply smoke for the CLI rule and runtime-agent scripts. The app no
# longer runs these as actions (release_check is the only app action); the
# scripts stay as an optional CLI, so their diff/apply behaviour is still checked
# here. Backup-first and fail-fast behaviour: scripts/check-workspace-script-safety.sh.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$repo_root/resources/default-workspace"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-script-actions.XXXXXX")"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

export HOME="$tmp_root/home"
export AGENT_WORKSPACE_BACKUP_DIR="$tmp_root/backups"
export CODEX_AGENTS_PATH="$HOME/.codex/AGENTS.md"
export OPENCODE_AGENTS_PATH="$HOME/.config/opencode/AGENTS.md"
export CLAUDE_RULES_PATH="$HOME/.claude/CLAUDE.md"
export OPENCODE_AGENTS_DIR="$HOME/.config/opencode/agents"
export CLAUDE_AGENTS_DIR="$HOME/.claude/agents"
mkdir -p "$HOME"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

rules="$workspace/scripts/install-agent-rules.sh"
runtime="$workspace/scripts/install-runtime-agents.sh"

bash -n "$rules"
bash -n "$runtime"

# Single-target rule apply/diff must not inherit failure from unselected targets.
bash "$rules" --codex --apply --quiet
bash "$rules" --codex --diff --quiet >"$tmp_root/codex-synced.log"
grep -qF 'codex-rules synced' "$tmp_root/codex-synced.log" \
  || fail "Codex single-target diff did not report synced"

bash "$rules" --opencode --apply --quiet
bash "$rules" --opencode --diff --quiet >"$tmp_root/opencode-synced.log"
grep -qF 'opencode-rules synced' "$tmp_root/opencode-synced.log" \
  || fail "OpenCode single-target diff did not report synced"

# A valid preview with differences must still exit zero and print useful output.
printf '\nlocal divergence\n' >>"$CODEX_AGENTS_PATH"
if ! bash "$rules" --codex --diff --quiet >"$tmp_root/codex-diff.log"; then
  fail "Codex rule preview returned nonzero for ordinary differences"
fi
grep -qF -- '--- codex-rules diffs' "$tmp_root/codex-diff.log" \
  || fail "Codex rule preview did not print a diff header"

# Missing/diverged runtime agents are preview data, not script execution failures.
if ! bash "$runtime" --opencode --diff --quiet >"$tmp_root/runtime-missing.log"; then
  fail "OpenCode runtime-agent preview returned nonzero for missing targets"
fi
grep -qF 'missing (no target at' "$tmp_root/runtime-missing.log" \
  || fail "OpenCode runtime-agent preview did not report missing targets"

bash "$runtime" --opencode --apply --quiet
bash "$runtime" --opencode --diff --quiet >"$tmp_root/runtime-synced.log"
grep -qF 'opencode-agents synced' "$tmp_root/runtime-synced.log" \
  || fail "OpenCode runtime-agent preview did not report synced"

printf 'workspace script action checks passed\n'
