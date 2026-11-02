#!/usr/bin/env bash
# Backend/runtime smoke for Riggverk Tauri command handlers.
# Uses an isolated temp HOME and RIGGVERK_WORKSPACE_PATH — never writes real harness dirs.
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

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-smoke.XXXXXX")"
cleanup() {
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT

# Resolve the real user home without trusting a possibly overridden HOME.
if command -v cygpath >/dev/null 2>&1; then
  REAL_HOME="$(cygpath -u "$USERPROFILE")"
else
  REAL_HOME="$(python3 -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')"
fi
export SMOKE_HOME="$SMOKE_ROOT/home"
export HOME="$SMOKE_HOME"
# OpenCode's (and Kilo's) config folder follows XDG_CONFIG_HOME: keep it below the smoke HOME.
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$HOME/AppData/Roaming" "$HOME/AppData/Local"
if command -v cygpath >/dev/null 2>&1; then
  export USERPROFILE="$(cygpath -w "$HOME")"
  export APPDATA="$(cygpath -w "$HOME/AppData/Roaming")"
  export LOCALAPPDATA="$(cygpath -w "$HOME/AppData/Local")"
  export XDG_CONFIG_HOME="$(cygpath -w "$XDG_CONFIG_HOME")"
  export XDG_DATA_HOME="$(cygpath -w "$XDG_DATA_HOME")"
else
  export USERPROFILE="$HOME" APPDATA="$HOME/AppData/Roaming" LOCALAPPDATA="$HOME/AppData/Local"
fi
# Keep rustup/cargo on the real toolchain while harness paths use SMOKE_HOME.
TOOLCHAIN_HOME="$REAL_HOME"
export RUSTUP_HOME="$TOOLCHAIN_HOME/.rustup"
export CARGO_HOME="$TOOLCHAIN_HOME/.cargo"
export PATH="$CARGO_HOME/bin:$PATH"

WORKSPACE="$SMOKE_ROOT/workspace"
step "prepare temp workspace"
# An empty data folder: the app keeps no copy of the bundle there; installs read the bundle.
mkdir -p "$WORKSPACE"
export RIGGVERK_WORKSPACE_PATH="$WORKSPACE"

# Guard: refuse if harness env vars point outside smoke HOME
# residue-allow-begin: the earlier alias of the backup variable is still honored by the app
for var in \
  OPENCODE_CONFIG_PATH \
  OPENCODE_TUI_CONFIG_PATH \
  OPENCODE_AGENTS_DIR \
  CLAUDE_AGENTS_DIR \
  CURSOR_AGENTS_PATH \
  RIGGVERK_BACKUP_DIR \
  AGENT_WORKSPACE_BACKUP_DIR; do
  if [ -n "${!var:-}" ]; then
    case "${!var}" in
      "$HOME"/*|"${HOME}"/*) ;;
      *) fail "$var is set outside smoke HOME; unset it before running smoke" ;;
    esac
  fi
done
# residue-allow-end

# The app only writes below the (temp) HOME.
PLAYWRIGHT_CONFIG="$HOME/.config/playwright-mcp/config.json"
PLAYWRIGHT_BROWSERS="$HOME/.cache/ms-playwright"

step "rust command-handler smoke (same paths as Tauri IPC)"
export RIGGVERK_SMOKE=1
export PLAYWRIGHT_MCP_CONFIG_PATH="$PLAYWRIGHT_CONFIG"
export PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS"
CARGO_BIN="$CARGO_HOME/bin/cargo"
if [ ! -x "$CARGO_BIN" ]; then
  fail "cargo not found at $CARGO_BIN (set CARGO_HOME or install rust)"
fi

# cargo exits 0 when a test filter matches nothing, so a renamed or removed test
# would pass silently. Run one filter and fail unless at least one test passed.
run_cargo_smoke() {
  local log="$SMOKE_ROOT/cargo-test.log" passed
  if ! "$CARGO_BIN" test --locked "$@" >"$log" 2>&1; then
    cat "$log" >&2
    fail "cargo test $* failed"
  fi
  cat "$log"
  passed="$(sed -n 's/^test result: ok\. \([0-9][0-9]*\) passed.*/\1/p' "$log" | awk '{ total += $1 } END { print total + 0 }')"
  if [ "$passed" -lt 1 ]; then
    fail "cargo test $* ran no tests (stale test filter?)"
  fi
  printf '  %s test(s) passed for: %s\n' "$passed" "$*"
}

(
  cd src-tauri
  export RUSTUP_HOME
  export CARGO_HOME
  export PATH="$CARGO_HOME/bin:$PATH"
  if command -v cygpath >/dev/null 2>&1; then
    export HOME="$(cygpath -w "$HOME")"
    export SMOKE_HOME="$(cygpath -w "$SMOKE_HOME")"
    export RIGGVERK_WORKSPACE_PATH="$(cygpath -w "$RIGGVERK_WORKSPACE_PATH")"
    export PLAYWRIGHT_MCP_CONFIG_PATH="$(cygpath -w "$PLAYWRIGHT_MCP_CONFIG_PATH")"
    export PLAYWRIGHT_BROWSERS_PATH="$(cygpath -w "$PLAYWRIGHT_BROWSERS_PATH")"
    export RUSTUP_HOME="$(cygpath -w "$RUSTUP_HOME")"
    export CARGO_HOME="$(cygpath -w "$CARGO_HOME")"
  fi
  # The smoke test is #[ignore]d so plain `cargo test` cannot pass it vacuously;
  # it is run explicitly here, against the temp HOME and workspace above.
  run_cargo_smoke smoke_runtime::tests::runtime_smoke_end_to_end -- --ignored --exact --nocapture
)

printf '\nsmoke-tauri-runtime passed\n'
printf '  workspace: %s\n' "$WORKSPACE"
printf '  smoke HOME: %s\n' "$SMOKE_HOME"
printf '  note: Tauri webview UI automation not covered (use APP_RELEASE_SMOKE.md)\n'
