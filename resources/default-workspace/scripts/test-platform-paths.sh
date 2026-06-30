#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/platform-paths.sh
. "$SCRIPT_DIR/lib/platform-paths.sh"

fail() {
  printf 'test-platform-paths.sh: %s\n' "$*" >&2
  exit 1
}

with_uname() {
  local platform="$1"
  local temp_dir
  shift
  temp_dir="$(mktemp -d)"
  cat >"$temp_dir/uname" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-s" ]; then
  printf '%s\\n' "$platform"
else
  printf '%s\\n' "$platform"
fi
EOF
  chmod +x "$temp_dir/uname"
  set +e
  PATH="$temp_dir:$PATH" "$@"
  local status=$?
  set -e
  rm -rf "$temp_dir"
  return "$status"
}

assert_eq() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  [ "$actual" = "$expected" ] || fail "$label: expected '$expected', got '$actual'"
}

mac_default() {
  local actual
  actual="$(
    unset AGENT_WORKSPACE_BACKUP_DIR XDG_CONFIG_HOME
    HOME=/Users/example
    agent_workspace_backup_root
  )"
  assert_eq "macOS default" "$actual" "/Users/example/Library/Application Support/ai.agentworkspace.app/backups"
}

linux_xdg_default() {
  local actual
  actual="$(
    unset AGENT_WORKSPACE_BACKUP_DIR
    HOME=/home/example
    XDG_CONFIG_HOME=/custom/config
    agent_workspace_backup_root
  )"
  assert_eq "Linux XDG default" "$actual" "/custom/config/ai.agentworkspace.app/backups"
}

linux_home_fallback() {
  local actual
  actual="$(
    unset AGENT_WORKSPACE_BACKUP_DIR XDG_CONFIG_HOME
    HOME=/home/example
    agent_workspace_backup_root
  )"
  assert_eq "Linux HOME fallback" "$actual" "/home/example/.config/ai.agentworkspace.app/backups"
}

env_override() {
  local actual
  actual="$(
    AGENT_WORKSPACE_BACKUP_DIR=/tmp/aw-backups
    HOME=/home/example
    agent_workspace_backup_root
  )"
  assert_eq "env override" "$actual" "/tmp/aw-backups"
}

empty_override_rejected() {
  if (
    AGENT_WORKSPACE_BACKUP_DIR=
    HOME=/home/example
    agent_workspace_backup_root >/dev/null 2>&1
  ); then
    fail "empty AGENT_WORKSPACE_BACKUP_DIR was accepted"
  fi
}

broad_root_rejected() {
  if HOME=/home/example agent_workspace_refuse_broad_backup_root "/" test-platform-paths.sh >/dev/null 2>&1; then
    fail "broad backup root / was accepted"
  fi
  if HOME=/home/example agent_workspace_refuse_broad_backup_root "/home/example" test-platform-paths.sh >/dev/null 2>&1; then
    fail "broad backup root HOME was accepted"
  fi
}

with_uname Darwin mac_default
with_uname Linux linux_xdg_default
with_uname Linux linux_home_fallback
with_uname Linux env_override
with_uname Linux empty_override_rejected
broad_root_rejected

printf 'test-platform-paths.sh: ok\n'
