#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME RUSTUP_HOME
cd "$ROOT"

if ! git cat-file -e 2d85d94b6f2f1dc06f45f6ec52a22ae97e499588^{commit}; then
  echo "FAIL: required pre-manifest source commit is unavailable" >&2
  exit 1
fi

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-pre-manifest.XXXXXX")"
trap 'rm -rf "$smoke_root"' EXIT
export HOME="$smoke_root/home"
export XDG_CONFIG_HOME="$smoke_root/xdg-config"
export XDG_DATA_HOME="$smoke_root/xdg-data"
export XDG_CACHE_HOME="$smoke_root/xdg-cache"
export AGENT_WORKSPACE_PATH="$smoke_root/runtime"
export AGENT_WORKSPACE_BACKUP_DIR="$smoke_root/backups"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

echo "==> pre-manifest upgrade contract (isolated profile)"
for test_name in \
  pre_manifest_fixture_detects_stale_removals_before_apply \
  pre_manifest_upgrade_reconciles_to_canonical_inventory \
  pre_manifest_upgrade_is_idempotent_on_second_apply \
  pre_manifest_upgrade_rollback_restores_removed_stale_workspace_file; do
  cargo test --manifest-path src-tauri/Cargo.toml "$test_name" --quiet -- --test-threads=1
done

echo "==> pre-manifest upgrade smoke passed"
