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

fixture="$smoke_root/source-commit-default-workspace"
git archive 2d85d94b6f2f1dc06f45f6ec52a22ae97e499588 resources/default-workspace |
  tar -x -C "$smoke_root"
mv "$smoke_root/resources/default-workspace" "$fixture"
rmdir "$smoke_root/resources"

current_workflows="$(shasum -a 256 resources/default-workspace/docs/WORKFLOWS.md | awk '{print $1}')"
historical_workflows="$(shasum -a 256 "$fixture/docs/WORKFLOWS.md" | awk '{print $1}')"
if [ "$current_workflows" = "$historical_workflows" ]; then
  echo "FAIL: historical fixture matches current bundled WORKFLOWS.md" >&2
  exit 1
fi
if [ ! -f "$fixture/metadata/deprecated-skills.json" ]; then
  echo "FAIL: historical fixture is missing deprecated metadata" >&2
  exit 1
fi

export AGENT_WORKSPACE_HISTORICAL_FIXTURE_PATH="$fixture"
echo "==> real source-commit pre-manifest upgrade (isolated profile)"
cargo test --manifest-path src-tauri/Cargo.toml \
  real_source_commit_pre_manifest_upgrade_smoke --quiet -- --ignored --test-threads=1 --nocapture

echo "==> pre-manifest upgrade smoke passed"
