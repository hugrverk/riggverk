#!/usr/bin/env bash
# Backend/runtime smoke for Agent Workspace Tauri command handlers.
# Uses an isolated temp HOME and AGENT_WORKSPACE_PATH — never writes real harness dirs.
#
# Tauri webview UI automation is not run here (Playwright against Vite lacks invoke IPC).
# See docs/APP_RELEASE_SMOKE.md for manual GUI smoke.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-smoke.XXXXXX")"
cleanup() {
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT

# Resolve the real user home without trusting a possibly overridden HOME.
REAL_HOME="$(python3 -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')"
export SMOKE_HOME="$SMOKE_ROOT/home"
export HOME="$SMOKE_HOME"
mkdir -p "$HOME/Library/Application Support/ai.agentworkspace.app"
# Keep rustup/cargo on the real toolchain while harness paths use SMOKE_HOME.
TOOLCHAIN_HOME="$REAL_HOME"
export RUSTUP_HOME="$TOOLCHAIN_HOME/.rustup"
export CARGO_HOME="$TOOLCHAIN_HOME/.cargo"
export PATH="$CARGO_HOME/bin:$PATH"

WORKSPACE="$SMOKE_ROOT/workspace"
step "prepare temp workspace"
cp -R resources/default-workspace "$WORKSPACE"
cp scripts/release-check.sh "$WORKSPACE/scripts/release-check.sh"
export AGENT_WORKSPACE_PATH="$WORKSPACE"

# Guard: refuse if harness env vars point outside smoke HOME
for var in \
  OPENCODE_CONFIG_PATH \
  OPENCODE_TUI_CONFIG_PATH \
  OPENCODE_AGENTS_DIR \
  CLAUDE_AGENTS_DIR \
  CURSOR_AGENTS_PATH \
  AGENT_WORKSPACE_BACKUP_DIR; do
  if [ -n "${!var:-}" ]; then
    case "${!var}" in
      "$HOME"/*|"${HOME}"/*) ;;
      *) fail "$var is set outside smoke HOME; unset it before running smoke" ;;
    esac
  fi
done

PLAYWRIGHT_CONFIG="$SMOKE_ROOT/playwright-mcp/config.json"
PLAYWRIGHT_BROWSERS="$SMOKE_ROOT/ms-playwright"
mkdir -p "$(dirname "$PLAYWRIGHT_CONFIG")"

step "apply OpenCode config to temp harness"
OPENCODE_CONFIG_PATH="$HOME/.config/opencode/opencode.json" \
OPENCODE_TUI_CONFIG_PATH="$HOME/.config/opencode/tui.json" \
OPENCODE_AGENTS_DIR="$HOME/.config/opencode/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$SMOKE_ROOT/backups" \
PLAYWRIGHT_MCP_CONFIG_PATH="$PLAYWRIGHT_CONFIG" \
PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS" \
  bash "$WORKSPACE/scripts/install-opencode-config.sh" --apply --quiet

step "apply shared runtime agents (opencode, claude)"
OPENCODE_AGENTS_DIR="$HOME/.config/opencode/agents" \
CLAUDE_AGENTS_DIR="$HOME/.claude/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$SMOKE_ROOT/backups" \
  bash "$WORKSPACE/scripts/install-runtime-agents.sh" \
  --opencode --claude --apply --quiet

step "rust command-handler smoke (same paths as Tauri IPC)"
export AGENT_WORKSPACE_SMOKE=1
export PLAYWRIGHT_MCP_CONFIG_PATH="$PLAYWRIGHT_CONFIG"
export PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS"
CARGO_BIN="$CARGO_HOME/bin/cargo"
if [ ! -x "$CARGO_BIN" ]; then
  fail "cargo not found at $CARGO_BIN (set CARGO_HOME or install rust)"
fi
(
  cd src-tauri
  export RUSTUP_HOME
  export CARGO_HOME
  export PATH="$CARGO_HOME/bin:$PATH"
  "$CARGO_BIN" test smoke_runtime::tests::runtime_smoke_end_to_end -- --exact --nocapture
  "$CARGO_BIN" test script_action_smoke::tests::harness_diff_actions_return_successful_previews -- --exact --nocapture
  "$CARGO_BIN" test setup_lifecycle_smoke::tests -- --nocapture
)

printf '\nsmoke-tauri-runtime passed\n'
printf '  workspace: %s\n' "$WORKSPACE"
printf '  smoke HOME: %s\n' "$SMOKE_HOME"
printf '  note: Tauri webview UI automation not covered (use APP_RELEASE_SMOKE.md)\n'
